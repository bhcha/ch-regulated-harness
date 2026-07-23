/**
 * supervisor.test.ts — 무인 세션 마감 강제 기계(supervisor) + 소유권 원장 배선(ownership.ts 소비측)의 회귀 가드.
 *
 * 전부 **완전 결정적**이다: 가짜 시계(FakeClock — 실타이머·실슬립 0)·가짜 스폰(spawnSession seam)·가짜 원장
 *   (createLedger + in-memory io)으로 돈다.
 *   ⚠ 실 `claude` 세션·실 신호·실 `ps`/`pgrep` 는 여기서 **뜨지 않는다**(W3 오프라인 DoD). 규칙 문자열이 실제로
 *     무엇을 막는지·프로세스그룹 kill 이 손자까지 닿는지·nonce 가 실제로 exec-env 에 실려 되읽히는지는 W5 라이브
 *     카나리다. 여기선 '무엇을 겨냥해 무엇을 원장에 썼는가'만 못 박는다.
 *   ⚠ **행 금지**: 회귀는 ms 안에 실패해야 한다. superviseSession 은 회수 알람이 kill_at 에 반드시 settle 하므로
 *     세션이 영영 안 끝나는 가짜에서도 promise 가 매달리지 않는다.
 */
import { describe, expect, test } from "vitest";

import type { SessionPlan } from "../../src/worker/cli-session.js";
import {
  SESSION_NONCE_ENV,
  type LedgerHandle,
  type LedgerIo,
  type SessionRole,
  type SupervisorMeta,
  createLedger,
  parse,
} from "../../src/worker/ownership.js";
import {
  ALARM_MAX_HOP_MS,
  KILL_MARGIN_MS,
  type KillSchedule,
  SUPERVISOR_MAX_OUTPUT_BYTES,
  SUPERVISOR_SPAWN_DETACHED,
  SUPERVISOR_SPAWN_STDIO,
  type SuperviseResult,
  TERM_MARGIN_MS,
  buildSupervisorSpawnOptions,
  computeKillSchedule,
  createSessionGroupRegistry,
  hasSpawnRoom,
  installSupervisorTerminationHandlers,
  realGroupAlive,
  realSignalGroup,
  remainingBeforeKill,
  superviseSession,
} from "../../src/worker/supervisor.js";

// ── 고정 상수(머신 무관 · 조립 결정론) ──────────────────────────────────────────
const RID = "run-abc-0718";
const CLAIMED = 1_000_000;
const GEN_TIMEOUT = 480_000;
const DEADLINE = CLAIMED + GEN_TIMEOUT + 100_000; // 마감이 예산보다 멀다 → kill_at = 예산 마감(claimed+gen)
const KILL_AT = CLAIMED + GEN_TIMEOUT; // 1_480_000
const TERM_AT = KILL_AT - TERM_MARGIN_MS; // 1_450_000
const KILLSIG_AT = KILL_AT - KILL_MARGIN_MS; // 1_470_000

const LEDGER_PATH = "/abs/worker/ledger.json";
const SUP_META: SupervisorMeta = { pid: 4242, startedAtMs: 1_000_000, rid: RID, stage: "brief" };

// ── 가짜 원장 io(in-memory · throwAtWrite 로 N번째 write 를 실패시켜 원장 쓰기 오류 재현) ──────────────
function makeLedgerIo(opts: { throwAtWrite?: number } = {}) {
  const files: Record<string, string> = {};
  const ops: string[] = [];
  let writes = 0;
  const io: LedgerIo = {
    writeFileSync: (p, d) => {
      writes++;
      if (opts.throwAtWrite !== undefined && writes === opts.throwAtWrite) {
        throw new Error(`EIO: 원장 write 실패(테스트 · #${writes})`);
      }
      files[p] = d;
      ops.push(`write:${p}`);
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
      ops.push(`rename:${from}->${to}`);
    },
  };
  return {
    io,
    ops,
    /** path 로 내구화된 원장(파싱). 없으면 undefined. */
    read: (p = LEDGER_PATH) => (files[p] !== undefined ? parse(files[p]) : undefined),
  };
}

/**
 * 실 createLedger(ownership.ts) + in-memory io 로 감싼 원장 — **호출 순서(events)를 기록**하고 처분(snapshot)을
 *   관측할 수 있게 한다. intent/register/settle 이 events 에 남으므로 spawnSession seam 과 같은 배열을 공유해
 *   '의도 먼저(intent-before-spawn)' happens-before 를 못 박는다. throwAtWrite 로 특정 원장 write 를 실패시킨다.
 */
function makeLedger(opts: { throwAtWrite?: number } = {}) {
  const events: string[] = [];
  const base = makeLedgerIo({ throwAtWrite: opts.throwAtWrite });
  let n = 0;
  const raw = createLedger(LEDGER_PATH, SUP_META, base.io, {
    now: () => 1_000_000,
    nonceGen: () => `nonce-${++n}`, // 원장별 결정적 nonce 시퀀스.
  });
  const handle: LedgerHandle = {
    intent: (role, killAt) => {
      events.push("intent");
      return raw.intent(role, killAt);
    },
    register: (nonce, pgid) => {
      events.push("register");
      raw.register(nonce, pgid);
    },
    settle: (nonce, disposition) => {
      events.push(`settle:${disposition}`);
      raw.settle(nonce, disposition);
    },
    snapshot: () => raw.snapshot(),
  };
  return { handle, events, read: base.read };
}

// ── 테스트 1: kill_at/TERM/KILL 절대시각 계산 ────────────────────────────────────
describe("computeKillSchedule — kill_at = min(예산 마감, 잡 마감)", () => {
  test("예산이 먼저 오면 kill_at = claimedAt + genTimeout", () => {
    const s = computeKillSchedule({ claimedAtMs: CLAIMED, genTimeoutMs: GEN_TIMEOUT, deadlineMs: DEADLINE });
    expect(s.killAtMs).toBe(CLAIMED + GEN_TIMEOUT);
    expect(s.termAtMs).toBe(s.killAtMs - TERM_MARGIN_MS);
    expect(s.killSigAtMs).toBe(s.killAtMs - KILL_MARGIN_MS);
    // 순서 불변: term < killSig < killAt (전부 마감 이전).
    expect(s.termAtMs).toBeLessThan(s.killSigAtMs);
    expect(s.killSigAtMs).toBeLessThan(s.killAtMs);
  });

  test("잡 마감(expires_at)이 먼저 오면 kill_at = deadline(= 마감이 min)", () => {
    const nearDeadline = CLAIMED + 100_000; // 예산(480k)보다 훨씬 앞
    const s = computeKillSchedule({ claimedAtMs: CLAIMED, genTimeoutMs: GEN_TIMEOUT, deadlineMs: nearDeadline });
    expect(s.killAtMs).toBe(nearDeadline); // expires_at 결박
    expect(s.termAtMs).toBe(nearDeadline - TERM_MARGIN_MS);
    expect(s.killSigAtMs).toBe(nearDeadline - KILL_MARGIN_MS);
  });

  test("유예 상수: TERM_MARGIN(30초) > KILL_MARGIN(10초) — 늘 마감 이전에 완결된다", () => {
    expect(TERM_MARGIN_MS).toBe(30_000);
    expect(KILL_MARGIN_MS).toBe(10_000);
    expect(TERM_MARGIN_MS).toBeGreaterThan(KILL_MARGIN_MS);
  });

  test("비유한 입력은 던진다(fail-fast)", () => {
    expect(() =>
      computeKillSchedule({ claimedAtMs: Number.NaN, genTimeoutMs: GEN_TIMEOUT, deadlineMs: DEADLINE }),
    ).toThrow(/유한한 ms/);
  });
});

// ── 테스트 6: supervisor 스폰 옵션이 cli-parser 검증 패턴과 일치 ─────────────────
describe("supervisor 스폰 옵션 — cli-parser 검증 패턴(detached · stdin ignore · 출력 상한)", () => {
  test("상수: detached=true · stdio=['ignore','pipe','pipe'](stdin 무시) · 출력 상한 32MiB", () => {
    expect(SUPERVISOR_SPAWN_DETACHED).toBe(true);
    expect([...SUPERVISOR_SPAWN_STDIO]).toEqual(["ignore", "pipe", "pipe"]);
    expect(SUPERVISOR_SPAWN_STDIO[0]).toBe("ignore"); // stdin=ignore(입력 대기 행 차단)
    expect(SUPERVISOR_MAX_OUTPUT_BYTES).toBe(32 * 1024 * 1024);
  });

  test("buildSupervisorSpawnOptions 는 cwd·env 를 그대로 싣고 옵션을 상수에서 조립한다", () => {
    const opts = buildSupervisorSpawnOptions("/x/run", { PATH: "/usr/bin" });
    expect(opts.cwd).toBe("/x/run");
    expect(opts.env).toEqual({ PATH: "/usr/bin" });
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(opts.detached).toBe(true);
  });
});

// ── FakeClock (실타이머 0 · 결정적 발화) ─────────────────────────────────────────
class FakeClock {
  private t: number;
  private alarms: Array<{ atMs: number; fn: () => void; cancelled: boolean }> = [];
  constructor(start: number) {
    this.t = start;
  }
  now = (): number => this.t;
  setAlarm = (atMs: number, fn: () => void): (() => void) => {
    const a = { atMs, fn, cancelled: false };
    this.alarms.push(a);
    return () => {
      a.cancelled = true;
    };
  };
  /** now 를 t 로 옮기고, atMs ≤ t 인 미취소 알람을 atMs 오름차순으로 발화(발화 중 취소되면 건너뛴다). */
  advanceTo(t: number): void {
    this.t = t;
    const due = this.alarms.filter((a) => !a.cancelled && a.atMs <= t).sort((x, y) => x.atMs - y.atMs);
    for (const a of due) {
      if (a.cancelled) continue;
      a.cancelled = true;
      a.fn();
    }
  }
  /** now 를 nowMs 로 옮기고, **atMs 조건 없이** 미취소 알람을 전부 강제 발화(역행 시계·클램프 조기발화 시뮬레이션). */
  fireAllPendingAt(nowMs: number): void {
    this.t = nowMs;
    const pending = this.alarms.filter((a) => !a.cancelled);
    for (const a of pending) {
      if (a.cancelled) continue;
      a.cancelled = true;
      a.fn();
    }
  }
}

/** superviseSession 은 플랜을 spawnSession seam 으로만 넘기므로(가짜가 무시) 더미로 충분. */
const DUMMY_PLAN = { argv: [], cwd: "", env: {}, addDirs: [] } as unknown as SessionPlan;

function fixedSchedule(): KillSchedule {
  return computeKillSchedule({ claimedAtMs: CLAIMED, genTimeoutMs: GEN_TIMEOUT, deadlineMs: DEADLINE });
}

/** 영영 안 끝나는 세션 종료(가짜) — 회수 알람이 kill_at 에 settle 하므로 행이 없다. */
function neverExits(): Promise<{ code: number | null; outputCapExceeded?: boolean }> {
  return new Promise<{ code: number | null; outputCapExceeded?: boolean }>(() => {});
}

// ── 테스트 5: KILL 후 kill_at 에도 그룹 생존 → reap 실패('결국 종료'가 아니다) ──
describe("superviseSession — 마감 강제 · kill_at 시점 소멸 확인", () => {
  test("KILL 후에도 kill_at 에 그룹이 살아 있으면 reap_failed(결국 종료로 낙관하지 않는다) · 원장 leaked · in-memory 유지", async () => {
    const clock = new FakeClock(CLAIMED);
    const signals: Array<[number, string]> = [];
    const released: number[] = [];
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 4242, exited: neverExits() }),
      signalGroup: (pgid, sig) => signals.push([pgid, sig]),
      groupAlive: () => true, // kill_at 에도 그룹 생존
      ledger: L.handle,
      releaseSessionGroup: (pgid) => released.push(pgid),
    });
    clock.advanceTo(KILL_AT);
    const res = await p;
    expect(res.outcome).toBe("reap_failed");
    // TERM·KILL 둘 다 세션 그룹으로 나갔다(그런데도 안 죽었으니 실패).
    expect(signals).toContainEqual([4242, "SIGTERM"]);
    expect(signals).toContainEqual([4242, "SIGKILL"]);
    // ★ 처분: 원장 엔트리는 leaked(디스크에 남아 데몬이 계속 겨냥) + in-memory 그룹은 **해제 안 함**(종료 전파가 계속 겨냥).
    const snap = L.handle.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].state).toBe("leaked");
    expect(snap.sessions[0].pgid).toBe(4242); // leaked 은 pgid 유지
    expect(released).toEqual([]); // reap_failed → releaseSessionGroup 미호출(살아있는 그룹은 놓지 않는다)
  });

  test("KILL 후 kill_at 에 그룹이 소멸했으면 killed(마감 강제 성공) · 원장 reaped", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 7, exited: neverExits() }),
      signalGroup: () => {},
      groupAlive: () => false, // 회수 확인 시 소멸됨
      ledger: L.handle,
    });
    clock.advanceTo(KILL_AT);
    expect((await p).outcome).toBe("killed");
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped");
  });

  test("세션이 신호 전에 스스로 종료하면 exited(정상 완주 후보) · 원장 reaped", async () => {
    const clock = new FakeClock(CLAIMED);
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    let signalled = false;
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 9, exited }),
      signalGroup: () => {
        signalled = true;
      },
      groupAlive: () => false,
      ledger: L.handle,
    });
    resolveExit({ code: 0 }); // 마감 훨씬 전에 자가 종료(알람 미발화)
    const res = await p;
    expect(res.outcome).toBe("exited");
    expect(res.exitCode).toBe(0);
    expect(signalled).toBe(false); // 신호를 보낸 적 없다
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped");
  });

  test("밀린 타이머(kill_at 이후 한 번에 깨어남)도 즉시 KILL+회수확인으로 따라잡는다", async () => {
    // 랩톱 슬립 재현: 세 알람이 kill_at 을 훌쩍 넘긴 시점에 한꺼번에 깨어난다.
    const clock = new FakeClock(CLAIMED);
    const signals: Array<string> = [];
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 5, exited: neverExits() }),
      signalGroup: (_pgid, sig) => signals.push(sig),
      groupAlive: () => false,
      ledger: makeLedger().handle,
    });
    clock.advanceTo(KILL_AT + 5_000_000); // 한참 지나서 깨어남
    expect((await p).outcome).toBe("killed");
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });

  // ── Finding 2: 리더 종료 ≠ 그룹 사멸 ──────────────────────────────────────────
  test("리더가 종료해도 그룹이 살아있으면(손자 잔존) 성공 settle 하지 않고 reap 경로가 마무리한다", async () => {
    const clock = new FakeClock(CLAIMED);
    const signals: Array<string> = [];
    let groupDead = false; // 리더 종료 시점엔 손자가 살아있다 → KILL 후에야 소멸.
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 321, exited }),
      signalGroup: (_pgid, sig) => {
        signals.push(sig);
        if (sig === "SIGKILL") groupDead = true;
      },
      groupAlive: () => !groupDead,
      ledger: makeLedger().handle,
    });
    resolveExit({ code: 0 }); // 리더가 신호 훨씬 전에 종료 — 그러나 그룹은 아직 살아있다(nohup 손자).
    await Promise.resolve(); // onSelfExit 이 돌 기회를 준다(microtask flush). 여기서 조기 settle 하면 버그.
    clock.advanceTo(KILL_AT);
    const res = await p;
    expect(res.outcome).toBe("killed"); // exited 아님 — 손자를 KILL 하고 kill_at 에 소멸 확인
    expect(signals).toContain("SIGKILL");
  });

  // ── Finding 3: 조기 발화 재무장 + 클램프 바운드 홉 ────────────────────────────
  test("조기 발화(역행 시계)면 스펜트 원샷으로 끝내지 않고 다음 임계로 재무장한다", async () => {
    const clock = new FakeClock(CLAIMED);
    const schedule = fixedSchedule();
    const armedAt: number[] = [];
    const setAlarm = (atMs: number, fn: () => void): (() => void) => {
      armedAt.push(atMs);
      return clock.setAlarm(atMs, fn);
    };
    const p = superviseSession(DUMMY_PLAN, schedule, {
      now: clock.now,
      setAlarm,
      spawnSession: () => ({ pgid: 88, exited: neverExits() }),
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: makeLedger().handle,
    });
    const armedInitially = armedAt.length; // 첫 무장(다음 임계 termAt) = 1
    expect(armedInitially).toBe(1);
    clock.fireAllPendingAt(CLAIMED + 100); // termAt 이전에 강제로 깨어난다(조기 발화)
    // 재무장이 있어야 한다(스펜트 금지). 버그면 새 무장이 없어 여기서 즉시 실패(행 아님).
    expect(armedAt.length).toBeGreaterThan(armedInitially);
    expect(armedAt[armedAt.length - 1]).toBeGreaterThanOrEqual(schedule.termAtMs); // 진짜 다음 임계로(즉시 재발화 루프 아님)
    clock.advanceTo(KILL_AT); // 마무리(행 방지)
    expect((await p).outcome).toBe("killed");
  });

  test("절대 지연이 setTimeout 상한을 넘으면 즉시 발화가 아니라 바운드 홉(now+MAX_HOP)으로 무장한다", async () => {
    const HUGE = 40 * 24 * 60 * 60 * 1000; // 40일 > 상한(≈24.8일) → 첫 홉은 상한에서 멈춘다
    const clock = new FakeClock(0);
    const schedule = computeKillSchedule({ claimedAtMs: 0, genTimeoutMs: HUGE, deadlineMs: HUGE + 1_000_000 });
    const armedAt: number[] = [];
    const setAlarm = (atMs: number, fn: () => void): (() => void) => {
      armedAt.push(atMs);
      return clock.setAlarm(atMs, fn);
    };
    const p = superviseSession(DUMMY_PLAN, schedule, {
      now: clock.now,
      setAlarm,
      spawnSession: () => ({ pgid: 99, exited: neverExits() }),
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: makeLedger().handle,
    });
    // 첫 무장은 진짜 목표(termAt, ~40일)가 아니라 상한(now+MAX_HOP)에서 멈춘다(클램프 즉시발화 회피).
    expect(armedAt[0]).toBe(ALARM_MAX_HOP_MS);
    expect(armedAt[0]).toBeLessThan(schedule.termAtMs);
    clock.advanceTo(ALARM_MAX_HOP_MS); // 첫 홉이 깬다 → 남은 만큼 이어 건다
    expect(armedAt[armedAt.length - 1]).toBe(schedule.termAtMs); // 이번엔 진짜 목표(남은 지연 < 상한)
    clock.advanceTo(schedule.killAtMs); // 마무리
    expect((await p).outcome).toBe("killed");
  });

  // ── Finding 1 + 처분-인지 settle: 소멸 확인(reaped)이면 in-memory 해제 + 원장 reaped ─────────────
  test("스폰 시 pgid 를 등록하고 소멸 확인 settle 시 해제 + 원장 reaped(종료 전파·데몬이 이 처분을 본다)", async () => {
    const clock = new FakeClock(CLAIMED);
    const registered: number[] = [];
    const released: number[] = [];
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 555, exited }),
      signalGroup: () => {},
      groupAlive: () => false,
      registerSessionGroup: (pgid) => registered.push(pgid),
      releaseSessionGroup: (pgid) => released.push(pgid),
      ledger: L.handle,
    });
    expect(registered).toEqual([555]); // 스폰 직후 등록
    expect(released).toEqual([]); // 아직 해제 전
    resolveExit({ code: 0 });
    await p;
    expect(released).toEqual([555]); // 소멸 확인 settle 시 해제
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped"); // 원장도 reaped
  });

  test("스폰 여유 부족(남은 시간 < TERM_MARGIN)이면 세션을 띄우지도 않는다(refused · 원장 미접촉)", async () => {
    const schedule = fixedSchedule();
    let spawned = false;
    const L = makeLedger();
    const res = await superviseSession(DUMMY_PLAN, schedule, {
      now: () => TERM_AT + 1, // 남은 시간 = TERM_MARGIN - 1
      setAlarm: () => () => {},
      spawnSession: () => {
        spawned = true;
        return { pgid: 1, exited: Promise.resolve({ code: 0 }) };
      },
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: L.handle,
    });
    expect(res.outcome).toBe("refused");
    expect(spawned).toBe(false);
    // refused 는 intent 이전에 끊긴다 — 존재하지 않을 세션의 의도를 원장에 남기지 않는다.
    expect(L.handle.snapshot().sessions).toEqual([]);
    expect(L.events).toEqual([]);
  });

  test("hasSpawnRoom 경계: 남은 시간 == TERM_MARGIN 는 여유 있음, 미만은 없음", () => {
    const s = fixedSchedule();
    expect(hasSpawnRoom(s, s.killAtMs - TERM_MARGIN_MS)).toBe(true); // 정확히 TERM_MARGIN
    expect(hasSpawnRoom(s, s.killAtMs - TERM_MARGIN_MS + 1)).toBe(false); // TERM_MARGIN 미만
    expect(remainingBeforeKill(s, s.killAtMs)).toBe(0);
  });

  // ── HIGH#1: 스폰 실패(pgid ≤ 1)는 spawn_failed 로 short-circuit — init/launchd 오신호 차단 ──────────
  test("스폰이 pid 를 못 내면(pgid=-1) 신호·알람·등록 0으로 spawn_failed 즉시 settle(PID 1 신호 방지) · 원장 정리", async () => {
    const clock = new FakeClock(CLAIMED);
    const signals: Array<[number, string]> = [];
    const armed: number[] = [];
    const registered: number[] = [];
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: (atMs, fn) => {
        armed.push(atMs);
        return clock.setAlarm(atMs, fn);
      },
      spawnSession: () => ({ pgid: -1, exited: neverExits() }),
      signalGroup: (pgid, sig) => signals.push([pgid, sig]),
      groupAlive: () => true, // 버그판이라면 groupAlive(-1)=true 로 착각해 reap_failed 로 가려 한다.
      registerSessionGroup: (pgid) => registered.push(pgid),
      releaseSessionGroup: () => {},
      ledger: L.handle,
    });
    // 시계를 kill_at 너머로 밀어도(버그판이 알람으로 settle 하도록) 픽스판은 이미 동기 resolve 됐다.
    //   버그판이면 이 advance 로 enforce 가 돌아 [-1,SIGTERM]/[-1,SIGKILL] 을 보내고 reap_failed 로 settle → assertion 이 즉시 실패(행 아님).
    clock.advanceTo(KILL_AT + 1);
    const res = await p;
    expect(res.outcome).toBe("spawn_failed");
    expect(signals).toEqual([]); // 신호 0 — 나쁜 pgid 로 process.kill 을 부르지 않는다.
    expect(armed).toEqual([]); // 알람 0 — TERM/KILL/reap 무장 없음.
    expect(registered).toEqual([]); // 등록 0 — 종료 전파·데몬 대상 아님(short-circuit 이 registerSessionGroup 전에 끊는다).
    // intent 로 남긴 spawning 의도는 best-effort 로 reaped 정리(아무 그룹도 안 떴다).
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped");
  });

  // ── MEDIUM#4: 출력 상한 초과 cap-kill 은 exited 가 아니라 output_cap(실패) ─────────────────────────
  test("cap-kill 된 세션(outputCapExceeded)은 exited 가 아니라 output_cap 으로 settle · 원장 reaped", async () => {
    const clock = new FakeClock(CLAIMED);
    let signalled = false;
    const L = makeLedger();
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      // spawn seam 이 상한 초과로 그룹을 cap-kill 하고(code=null 신호사), 플래그를 실어 종료를 알린다.
      spawnSession: () => ({ pgid: 4343, exited: Promise.resolve({ code: null, outputCapExceeded: true }) }),
      signalGroup: () => {
        signalled = true;
      },
      groupAlive: () => false, // cap-kill 로 그룹 소멸.
      ledger: L.handle,
    });
    const res = await p;
    expect(res.outcome).toBe("output_cap"); // exited 아님 — 폭주 출력 강제 회수 = 실패.
    expect(signalled).toBe(false); // 감독이 따로 신호한 적 없다(cap-kill 은 spawn seam 이 했다).
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped"); // 그룹 소멸 확인이므로 reaped
  });

  // ── MEDIUM#1: cap-kill 사실이 groupAlive 조기-return 을 넘어 살아남아 최종 output_cap(killed 오판 방지) ──────
  test("cap-kill + 리더 close 시 그룹 잠깐 생존 → kill_at reap 이 killed 아니라 output_cap 으로 settle", async () => {
    // 리더 close 가 outputCapExceeded 로 뜨지만 손자가 그룹을 잠깐 살려 onSelfExit 이 early-return 한다. 그 뒤 손자가
    //   죽고 kill_at 이 그룹을 reap 하는데, 예전엔 cap 플래그가 유실돼 killed(=러너가 전이만 보이면 성공)로 settle 됐다.
    const clock = new FakeClock(CLAIMED);
    const signals: Array<string> = [];
    let groupDead = false; // 리더 close 시점엔 손자 생존 → KILL 후에야 소멸.
    let resolveExit!: (v: { code: number | null; outputCapExceeded?: boolean }) => void;
    const exited = new Promise<{ code: number | null; outputCapExceeded?: boolean }>((r) => {
      resolveExit = r;
    });
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 6161, exited }),
      signalGroup: (_pgid, sig) => {
        signals.push(sig);
        if (sig === "SIGKILL") groupDead = true;
      },
      groupAlive: () => !groupDead,
      ledger: makeLedger().handle,
    });
    resolveExit({ code: null, outputCapExceeded: true }); // cap-kill 종료 — 그러나 손자가 그룹을 살려둔다.
    await Promise.resolve(); // onSelfExit 이 돌아 cap 사실을 박제(groupAlive=true 라 여기선 settle 안 함).
    clock.advanceTo(KILL_AT); // 손자 KILL → groupAlive=false → reap.
    const res = await p;
    expect(res.outcome).toBe("output_cap"); // killed 아님 — cap 사실이 early-return 을 넘어 살아남았다(실패→성공 오판 차단).
    expect(signals).toContain("SIGKILL");
  });

  // ── MEDIUM#1(진짜 갭): cap-kill 이 close 콜백보다 먼저(kill_at 직전) → enforce 가 동기 ref 로 보고 output_cap ──────
  test("cap-kill 이 close 콜백보다 먼저(kill_at 직전) 발생 → enforce 가 동기 ref 로 보고 output_cap(killed 아님)", async () => {
    // 핵심 갭: close 콜백이 지연돼 onSelfExit 이 아직 안 돌았는데 kill_at enforce 가 먼저 reap 한다. capKillObserved
    //   (close 경로)는 아직 false → 버그판은 killed(=러너가 전이만 보이면 성공)로 오판했다. spawn seam 의 동기 ref
    //   (capKilled)가 cap 사실을 즉시 노출하므로 enforce 가 output_cap 으로 가른다. close 는 영영 안 온다(exited pending).
    const clock = new FakeClock(CLAIMED);
    let capped = false; // spawn seam 이 cap-kill 하는 순간 참이 되는 동기 ref 시뮬레이션.
    const signals: Array<string> = [];
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      // close 콜백은 영영 안 온다(exited pending) — cap 사실은 오직 동기 ref 로만 노출된다.
      spawnSession: () => ({ pgid: 7777, capKilled: () => capped, exited: neverExits() }),
      signalGroup: (_pgid, sig) => signals.push(sig),
      groupAlive: () => false, // cap-kill 로 그룹은 이미 소멸(손자 없음).
      ledger: makeLedger().handle,
    });
    capped = true; // kill_at 직전에 cap-kill 발생(동기 ref 로 즉시 반영).
    clock.advanceTo(KILL_AT); // enforce reap — close 없이도 ref 로 cap 을 본다.
    const res = await p;
    expect(res.outcome).toBe("output_cap"); // killed 아님 — 동기 ref 가 close 지연을 넘어 cap 을 보고했다.
  });
});

// ── 소유권 원장 배선(ownership.ts 소비측) — 의도-먼저·nonce 주입·쓰기 실패 fail-closed·처분-인지 settle ──────
describe("superviseSession — 소유권 원장(ownership.ts) 배선", () => {
  // ★★ register-lag 픽스의 핵심 회귀: 의도(intent)가 자식 spawn **전에** 내구화된다(happens-before). ★★
  test("의도 먼저(intent-before-spawn): intent 가 spawn 보다 먼저 온다(register-lag 닫힘)", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger();
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => {
        L.events.push("spawn"); // 원장 events 와 같은 배열에 spawn 을 기록해 happens-before 를 못 박는다.
        return { pgid: 808, exited };
      },
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: L.handle,
    });
    resolveExit({ code: 0 });
    await p;
    // intent 가 반드시 spawn 보다 앞서야 한다. spawn-before-intent 회귀면 events[0]==="spawn" 으로 즉시 실패(ms).
    expect(L.events[0]).toBe("intent");
    expect(L.events[1]).toBe("spawn");
    expect(L.events.indexOf("intent")).toBeLessThan(L.events.indexOf("spawn"));
    // register 는 spawn 뒤(pgid 확정 후). 최종 처분은 reaped(자가 종료).
    expect(L.events).toEqual(["intent", "spawn", "register", "settle:reaped"]);
  });

  test("nonce 주입: spawn seam 이 받는 nonce = 원장이 발급한 소유 토큰(exec-env 로 심어진다)", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger();
    let seenNonce: string | undefined;
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: (_plan, nonce) => {
        seenNonce = nonce; // superviseSession 이 원장 nonce 를 spawn 으로 넘기는가.
        return { pgid: 909, exited };
      },
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: L.handle,
    });
    resolveExit({ code: 0 });
    await p;
    expect(seenNonce).toBe("nonce-1"); // 원장의 결정적 첫 nonce
    // 그리고 그 nonce 가 원장 엔트리의 소유 토큰과 같다(데몬이 exec-env 대조에 쓸 값).
    expect(L.handle.snapshot().sessions[0].nonce).toBe(seenNonce);
    // ⚠ W5 카나리: 이 nonce 가 실제 자식의 exec-env(CHAT_SESSION_NONCE)에 물리적으로 실리는지는 실세션에서만 확증.
    expect(SESSION_NONCE_ENV).toBe("CHAT_SESSION_NONCE");
  });

  test("intent 쓰기 실패 → ledger_unwritable · spawn 미호출 · 회수할 것 없음(자식 전이라 부작용 0)", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger({ throwAtWrite: 1 }); // 첫 원장 write(=intent persist)부터 실패.
    let spawnCalled = false;
    const signals: Array<[number, string]> = [];
    const registered: number[] = [];
    const armed: number[] = [];
    const res = await superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: (atMs, fn) => {
        armed.push(atMs);
        return clock.setAlarm(atMs, fn);
      },
      spawnSession: () => {
        spawnCalled = true;
        return { pgid: 111, exited: neverExits() };
      },
      signalGroup: (pgid, sig) => signals.push([pgid, sig]),
      groupAlive: () => false,
      registerSessionGroup: (pgid) => registered.push(pgid),
      ledger: L.handle,
    });
    expect(res.outcome).toBe("ledger_unwritable");
    expect(spawnCalled).toBe(false); // 의도 기록 실패 = 자식 spawn 전 → 아무것도 안 떴다.
    expect(signals).toEqual([]); // 회수할 그룹 없음(신호 0).
    expect(registered).toEqual([]); // 등록 0.
    expect(armed).toEqual([]); // 알람 0.
    expect(L.events).toEqual(["intent"]); // intent 만 시도(spawn/register 미도달).
    expect(L.handle.snapshot().sessions).toEqual([]); // 커밋 전 실패라 원장에 엔트리 없음.
  });

  test("register 쓰기 실패 + SIGKILL 로 그룹 소멸 확인 → reaped + in-memory 해제(ledger_unwritable)", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger({ throwAtWrite: 2 }); // intent(#1) 통과, register(#2) persist 부터 실패.
    const signals: Array<[number, string]> = [];
    const armed: number[] = [];
    const registered: number[] = [];
    const released: number[] = [];
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: (atMs, fn) => {
        armed.push(atMs);
        return clock.setAlarm(atMs, fn);
      },
      spawnSession: () => ({ pgid: 4242, exited: neverExits() }),
      signalGroup: (pgid, sig) => signals.push([pgid, sig]),
      groupAlive: () => false, // SIGKILL 이 먹혀 그룹이 소멸했다 = 회수 확인됨.
      registerSessionGroup: (pgid) => registered.push(pgid),
      releaseSessionGroup: (pgid) => released.push(pgid),
      ledger: L.handle,
    });
    // 시계를 kill_at 너머로 밀어도(버그판이 알람으로 뭔가 하려 해도) 픽스판은 이미 동기 settle 됐다 → 행 아님.
    clock.advanceTo(KILL_AT + 1);
    const res = await p;
    expect(res.outcome).toBe("ledger_unwritable");
    expect(signals).toEqual([[4242, "SIGKILL"]]); // 이미 뜬 그룹을 회수(그리고 오직 그것만).
    expect(armed).toEqual([]); // 알람 0 — 백스톱 없이 세션을 진행시키지 않는다.
    expect(registered).toEqual([4242]); // in-memory 등록은 spawn 직후 이미 됐고(SIGTERM 창 백스톱),
    expect(released).toEqual([4242]); // 소멸을 **확인**했으므로 in-memory 정리(멱등).
    // register persist(#2)는 던졌으니 엔트리는 spawning 이었고, best-effort settle(reaped · #3)로 정리된다.
    expect(L.handle.snapshot().sessions[0].state).toBe("reaped");
  });

  test("★ HIGH#1 — register 실패 + SIGKILL 에도 그룹 **생존** → reaped 금지(leaked 처분 · in-memory 유지)", async () => {
    // 회귀 내용: 옛 코드는 SIGKILL 을 '쐈다'는 사실만으로 곧장 `settle(reaped)` + releaseSessionGroup 했다. 그런데
    //   reaped 는 스키마상 **pgid 를 버리고** 데몬이 그 엔트리를 gc 한다 — SIGKILL 이 실패해 그룹이 살아남았다면 그
    //   **살아있는 그룹**이 in-memory(종료 전파 대상)에서도 디스크(데몬 회수 대상)에서도 동시에 사라져 마감을 넘겨
    //   살아남는다. 픽스는 kill_at 경로와 **같은 회수 검증**(groupAlive)으로 소멸을 확인한 뒤에만 reaped 로 처분한다.
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger({ throwAtWrite: 2 }); // intent(#1) 통과, register(#2) 부터 실패.
    const signals: Array<[number, string]> = [];
    const armed: number[] = [];
    const registered: number[] = [];
    const released: number[] = [];
    const aliveProbes: number[] = [];
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: (atMs, fn) => {
        armed.push(atMs);
        return clock.setAlarm(atMs, fn);
      },
      spawnSession: () => ({ pgid: 4242, exited: neverExits() }),
      signalGroup: (pgid, sig) => signals.push([pgid, sig]),
      groupAlive: (pgid) => {
        aliveProbes.push(pgid); // 픽스판은 처분 전에 반드시 회수 검증을 한다(같은 seam).
        return true; // SIGKILL 이 먹지 않았다 = 그룹 생존.
      },
      // ⚠ MEDIUM(S34-R2) — register seam **양쪽을 다** 배선해야 '유지' 핀이 공허하지 않다. 옛 테스트는 release seam
      //   만 넣어 `released===[]` 가 "등록됐는데 안 놓았다"가 아니라 "애초에 등록조차 안 됐다"여도 통과했다(공허).
      //   등록(spawn 직후 supervisor.ts:347)이 실제로 일어났음을 `registered===[4242]` 로 함께 고정해야, 생존 분기의
      //   `released===[]` 가 비로소 "등록된 살아있는 그룹을 in-memory 에서 놓지 않는다"를 증명한다(neuter: 등록을
      //   register 성공 뒤로 옮기면 registered===[] 로 즉시 깨진다).
      registerSessionGroup: (pgid) => registered.push(pgid),
      releaseSessionGroup: (pgid) => released.push(pgid),
      ledger: L.handle,
    });
    clock.advanceTo(KILL_AT + 1); // 알람이 안 걸렸어도 이미 동기 settle 됐다 → 행 아님(ms 안에 끝난다).
    const res = await p;
    expect(res.outcome).toBe("ledger_unwritable");
    expect(signals).toEqual([[4242, "SIGKILL"]]); // 회수는 **시도**했다.
    expect(aliveProbes).toEqual([4242]); // ★ 별도 확인이 아니라 kill_at 과 같은 groupAlive seam 으로 검증했다.
    // ★ 핵심 1 — 살아있는 그룹을 in-memory 에서 놓지 않는다(종료 전파가 계속 겨냥해야 한다).
    //   spawn 직후 등록됐고(registered===[4242]) 생존 분기에서 해제 안 함(released===[]) = in-memory 에 유지된다.
    expect(registered).toEqual([4242]); // ★ 등록은 실제로 일어났다(공허한 released===[] 방지 — S34-R2 medium).
    expect(released).toEqual([]);
    // ★ 핵심 2 — 살아있는 그룹을 `reaped`(pgid 버림 + 데몬 gc 대상)로 처분하지 않는다. 원장 쓰기가 이미 깨졌고
    //   엔트리도 아직 spawning 이라 leaked 전이는 거부되지만(ownership 계약), 그 결과는 **nonce 를 지닌 spawning**
    //   존치 = 데몬이 nonce 스캔으로 계속 찾아낸다. 어느 쪽이든 'reaped 로 사라짐'만은 절대 아니다.
    expect(L.handle.snapshot().sessions[0].state).not.toBe("reaped");
    expect(L.events).not.toContain("settle:reaped");
    // 시도된 처분은 leaked 하나뿐이다(events 는 raw 호출 **전에** 기록하므로 거부된 전이도 남는다).
    expect(L.events).toEqual(["intent", "register", "settle:leaked"]);
    expect(armed).toEqual([]); // 알람 0 — 백스톱 없이 세션을 진행시키지 않는다(불변).
    expect(res.detail).toMatch(/생존|leaked/);
  });

  test("원장 미주입(배선 불변식 위반) → fail-closed throw(2급 백스톱은 선택이 아니다)", () => {
    const clock = new FakeClock(CLAIMED);
    expect(() =>
      superviseSession(DUMMY_PLAN, fixedSchedule(), {
        now: clock.now,
        setAlarm: clock.setAlarm,
        spawnSession: () => ({ pgid: 5, exited: neverExits() }),
        signalGroup: () => {},
        groupAlive: () => false,
        // ledger 미주입
      }),
    ).toThrow(/ledger seam 미주입/);
  });

  test("role 은 원장 intent 에 감사 라벨로 실린다(recovery)", async () => {
    const clock = new FakeClock(CLAIMED);
    const L = makeLedger();
    let resolveExit!: (v: { code: number | null }) => void;
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExit = r;
    });
    const role: SessionRole = "recovery";
    const p = superviseSession(DUMMY_PLAN, fixedSchedule(), {
      now: clock.now,
      setAlarm: clock.setAlarm,
      spawnSession: () => ({ pgid: 616, exited }),
      signalGroup: () => {},
      groupAlive: () => false,
      ledger: L.handle,
      role,
    });
    resolveExit({ code: 0 });
    await p;
    expect(L.handle.snapshot().sessions[0].role).toBe("recovery");
  });
});

// ── HIGH#1(방어심층): realSignalGroup·realGroupAlive 는 pgid ≤ 1 을 process.kill 없이 거부 ────────────
describe("realSignalGroup·realGroupAlive — pgid ≤ 1 거부(init·전체 신호 차단, 2차 방어)", () => {
  test("pgid ∈ {1,0,-1} 은 process.kill 을 호출조차 하지 않고 no-op/false", () => {
    const orig = process.kill;
    const calls: Array<[number, string | number]> = [];
    // 실 process.kill 을 스텁으로 가로채, '호출 여부'를 관측한다(호출되면 즉시 실패 = 광역/init 신호 위험 노출).
    // @ts-expect-error 테스트 전용 스텁(시그니처 축약).
    process.kill = (pid: number, sig?: string | number): boolean => {
      calls.push([pid, sig as string | number]);
      return true;
    };
    try {
      realSignalGroup(1, "SIGKILL"); // kill(-1) = 광역
      realSignalGroup(0, "SIGKILL"); // kill(0) = 호출자 그룹 전체
      realSignalGroup(-1, "SIGTERM"); // kill(1) = init/launchd
      expect(realGroupAlive(1)).toBe(false);
      expect(realGroupAlive(0)).toBe(false);
      expect(realGroupAlive(-1)).toBe(false);
      expect(calls).toEqual([]); // 어떤 경우에도 process.kill 미호출.
    } finally {
      process.kill = orig;
    }
  });

  test("유효 pgid(>1)는 정상 경로로 process.kill 을 탄다(가드가 정상 신호를 막지 않는다)", () => {
    const orig = process.kill;
    const calls: Array<[number, string | number]> = [];
    // @ts-expect-error 테스트 전용 스텁.
    process.kill = (pid: number, sig?: string | number): boolean => {
      calls.push([pid, sig as string | number]);
      return true;
    };
    try {
      realSignalGroup(4242, "SIGKILL");
      expect(realGroupAlive(4242)).toBe(true); // 스텁이 던지지 않으므로 생존.
      expect(calls).toEqual([
        [-4242, "SIGKILL"], // 음수 pid = 그룹 전체.
        [-4242, 0], // 생존 확인 = signal 0.
      ]);
    } finally {
      process.kill = orig;
    }
  });
});

// ── 세션 그룹 레지스트리(순수 in-memory) + 종료 전파(Finding 1 — 마감 구멍 봉합) ─────────────────
/** on/removeListener/exit 를 기록하는 가짜 종료 호스트(실 process·실 신호 없이 판정). */
function makeFakeTerminationHost() {
  const listeners: Record<"SIGTERM" | "SIGINT" | "exit", Array<() => void>> = {
    SIGTERM: [],
    SIGINT: [],
    exit: [],
  };
  const exitCodes: Array<number | undefined> = [];
  return {
    host: {
      on: (e: "SIGTERM" | "SIGINT" | "exit", l: () => void): void => {
        listeners[e].push(l);
      },
      removeListener: (e: "SIGTERM" | "SIGINT" | "exit", l: () => void): void => {
        listeners[e] = listeners[e].filter((x) => x !== l);
      },
      exit: (code?: number): void => {
        exitCodes.push(code);
      },
    },
    fire: (e: "SIGTERM" | "SIGINT" | "exit"): void => {
      for (const l of [...listeners[e]]) l();
    },
    exitCodes,
  };
}

describe("createSessionGroupRegistry — 순수 in-memory live pgid(하트비트 publish 폐기)", () => {
  test("register/release 가 live() 스냅샷을 오름차순으로 유지한다(디스크 발행 없음)", () => {
    const reg = createSessionGroupRegistry();
    reg.register(202);
    reg.register(101);
    expect(reg.live()).toEqual([101, 202]); // 오름차순(결정론)
    reg.release(202);
    expect(reg.live()).toEqual([101]);
  });

  test("무효 pgid(≤1)는 등록하지 않는다 — kill(-1,…) 광역 신호 방지(안전 가드)", () => {
    const reg = createSessionGroupRegistry();
    reg.register(1); // 그룹 1
    reg.register(-1); // 스폰 실패 표식
    reg.register(0);
    expect(reg.live()).toEqual([]);
  });
});

describe("installSupervisorTerminationHandlers — supervisor 종료를 세션 그룹에 전파", () => {
  test("SIGTERM 시 살아있는 세션 그룹을 전부 SIGKILL 하고 명시 종료(143)한다", () => {
    const reg = createSessionGroupRegistry();
    reg.register(101);
    reg.register(202);
    const killed: Array<[number, string]> = [];
    const h = makeFakeTerminationHost();
    installSupervisorTerminationHandlers(reg, {
      signalGroup: (pgid, sig) => killed.push([pgid, sig]),
      host: h.host,
    });
    h.fire("SIGTERM");
    expect(killed).toEqual([
      [101, "SIGKILL"],
      [202, "SIGKILL"],
    ]);
    expect(reg.live()).toEqual([]); // 전파 후 전부 해제
    expect(h.exitCodes).toEqual([143]); // 128 + SIGTERM(15) — 기본 종료가 무효화되므로 명시 종료
  });

  test("정상 exit 이벤트도 살아남은 세션 그룹을 회수한다(백스톱)", () => {
    const reg = createSessionGroupRegistry();
    reg.register(777);
    const killed: Array<[number, string]> = [];
    const h = makeFakeTerminationHost();
    installSupervisorTerminationHandlers(reg, {
      signalGroup: (pgid, sig) => killed.push([pgid, sig]),
      host: h.host,
    });
    h.fire("exit");
    expect(killed).toEqual([[777, "SIGKILL"]]);
  });

  test("레지스트리가 비었으면 no-op — 신호 없이 종료만(모든 세션 settle 후)", () => {
    const reg = createSessionGroupRegistry();
    const killed: unknown[] = [];
    const h = makeFakeTerminationHost();
    installSupervisorTerminationHandlers(reg, {
      signalGroup: (pgid, sig) => killed.push([pgid, sig]),
      host: h.host,
    });
    h.fire("SIGINT");
    expect(killed).toEqual([]);
    expect(h.exitCodes).toEqual([130]); // 128 + SIGINT(2)
  });

  test("설치 해제 함수는 핸들러를 제거한다(재발화해도 회수 없음)", () => {
    const reg = createSessionGroupRegistry();
    reg.register(303);
    const killed: unknown[] = [];
    const h = makeFakeTerminationHost();
    const uninstall = installSupervisorTerminationHandlers(reg, {
      signalGroup: (pgid, sig) => killed.push([pgid, sig]),
      host: h.host,
    });
    uninstall();
    h.fire("SIGTERM");
    expect(killed).toEqual([]);
  });
});
