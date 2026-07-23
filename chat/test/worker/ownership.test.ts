/**
 * ownership.test.ts — 소유권 원장(스키마·기록기·순수 회수판정)의 회귀 가드.
 *
 * 전부 **완전 결정적**이다: 가짜 io(in-memory + ops 로그)·가짜 nonce(고정 시퀀스)·가짜 시계·가짜 procView 로 돈다.
 *   ⚠ 실 `ps -E`/`pgrep`·실 신호는 여기서 **뜨지 않는다**(W3 오프라인). exec-env 에 nonce 가 실제로 실리는지·그룹
 *     kill 이 실 손자까지 닿는지는 W5 라이브 카나리다 — 여기선 '무엇을 근거로 무엇을 결정하는가'만 못 박는다.
 *   ⚠ 특히 **nonce 불일치 → refuse**(PID 재사용 안전 케이스)는 이 스위트의 핵심 회귀다: 그 분기를 kill 로 바꾸면
 *     반드시 빨간불이어야 한다(중립화 실험으로 확증).
 */
import { describe, expect, test } from "vitest";

import {
  type Ledger,
  LEDGER_VERSION,
  LedgerParseError,
  LedgerTransitionError,
  LedgerWriteError,
  type LedgerIo,
  type NonceGen,
  type ProcView,
  REGISTER_LAG_MARGIN_MS,
  SESSION_NONCE_ENV,
  START_TIME_TOLERANCE_MS,
  type SessionEntry,
  type SupervisorMeta,
  type SupervisorState,
  createLedger,
  evaluateReap,
  parse,
  serialize,
} from "../../src/worker/ownership.js";

// ── 고정 상수(머신 무관 · 결정론) ────────────────────────────────────────────────
const HB = "/abs/worker/ledger.json";
const SUP: SupervisorMeta = { pid: 4242, startedAtMs: 1_000_000, rid: "run-abc-0718", stage: "brief" };
const KILL_AT = 1_480_000;

// ── 가짜 io(in-memory · ops 로그로 tmp→rename 순서 관측) ──────────────────────────
function makeFakeIo() {
  const files: Record<string, string> = {};
  const ops: string[] = [];
  const io: LedgerIo = {
    writeFileSync: (p, d) => {
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
    read: (p = HB): Ledger | undefined => (files[p] !== undefined ? parse(files[p]) : undefined),
    /** path 로 **직접** 쓴 적(원자 스왑 우회 = 찢김 가능)의 목록 — 원자성 위반 관측용. */
    directWrites: (p = HB): string[] => ops.filter((o) => o === `write:${p}`),
  };
}

/** 고정 nonce 시퀀스를 내는 생성기(테스트 결정성). 소진되면 던진다(예상보다 많은 intent 감지). */
function makeNonceGen(seq: string[]): NonceGen {
  let i = 0;
  return () => {
    const n = seq[i++];
    if (n === undefined) throw new Error(`makeNonceGen: nonce 시퀀스 소진(요청 ${i})`);
    return n;
  };
}

/** 고정 시계(intentAtMs·spawnedAtMs 를 결정론적으로). */
function makeClock(t = 500_000) {
  let cur = t;
  return { now: (): number => cur, set: (v: number): void => void (cur = v) };
}

// ── 세션 상태 기계: intent → register → settle ────────────────────────────────────
describe("createLedger — 상태 기계(intent→register→settle)", () => {
  test("happy path: intent(spawning) → register(live) → settle(reaped) 가 디스크에 순차 내구화", () => {
    const fake = makeFakeIo();
    const clock = makeClock(500_000);
    const led = createLedger(HB, SUP, fake.io, { now: clock.now, nonceGen: makeNonceGen(["N1"]) });

    // intent — spawning(pgid 없음), nonce 반환.
    const nonce = led.intent("main", KILL_AT);
    expect(nonce).toBe("N1");
    expect(fake.read()).toEqual({
      v: LEDGER_VERSION,
      supervisor: SUP,
      sessions: [{ nonce: "N1", role: "main", state: "spawning", intentAtMs: 500_000, killAtMs: KILL_AT }],
    });

    // register — live(pgid 부여 · spawnedAtMs 기록).
    clock.set(500_100);
    led.register("N1", 5555);
    expect(fake.read()?.sessions[0]).toEqual({
      nonce: "N1",
      role: "main",
      state: "live",
      pgid: 5555,
      intentAtMs: 500_000,
      spawnedAtMs: 500_100,
      killAtMs: KILL_AT,
    });

    // settle reaped — 소멸 확인 · pgid **버림**(스키마: reaped 엔 pgid 부재).
    led.settle("N1", "reaped");
    const e = fake.read()?.sessions[0];
    expect(e?.state).toBe("reaped");
    expect(e && "pgid" in e).toBe(false); // pgid 키가 실제로 제거됨.
  });

  test("모든 변이는 tmp 에 쓴 뒤 rename(원자 스왑) — 목적지 직접 쓰기 0(찢김 불가)", () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["N1"]) });
    led.intent("main", KILL_AT);
    // 정확히: write(/…​.tmp) → rename(/…​.tmp → /…). 목적지로의 직접 write 는 없다.
    expect(fake.ops).toEqual([`write:${HB}.tmp`, `rename:${HB}.tmp->${HB}`]);
    led.register("N1", 5555);
    led.settle("N1", "reaped");
    // 세 번의 변이 각각이 tmp→rename 한 쌍 = 총 3 write(tmp) + 3 rename, 목적지 직접 쓰기 0.
    expect(fake.directWrites()).toEqual([]);
    expect(fake.ops.filter((o) => o.startsWith(`rename:`)).length).toBe(3);
    expect(fake.ops).toEqual([
      `write:${HB}.tmp`,
      `rename:${HB}.tmp->${HB}`,
      `write:${HB}.tmp`,
      `rename:${HB}.tmp->${HB}`,
      `write:${HB}.tmp`,
      `rename:${HB}.tmp->${HB}`,
    ]);
  });

  test("leaked 엔트리는 **삭제되지 않고 존치**하며 pgid 를 **유지**한다(데몬이 계속 겨냥)", () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["N1"]) });
    led.intent("main", KILL_AT);
    led.register("N1", 7777);
    led.settle("N1", "leaked");
    const sessions = fake.read()?.sessions;
    expect(sessions).toHaveLength(1); // 존치(삭제 아님).
    expect(sessions?.[0]).toMatchObject({ nonce: "N1", state: "leaked", pgid: 7777 }); // pgid 유지.
  });

  test("두 세션(main + recovery)이 같은 원장에 공존한다", () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["N1", "N2"]) });
    led.intent("main", KILL_AT);
    led.register("N1", 100);
    led.settle("N1", "reaped");
    led.intent("recovery", KILL_AT);
    led.register("N2", 200);
    const sessions = fake.read()?.sessions ?? [];
    expect(sessions.map((e) => [e.nonce, e.role, e.state])).toEqual([
      ["N1", "main", "reaped"],
      ["N2", "recovery", "live"],
    ]);
  });

  test("snapshot 은 내구 상태의 읽기전용 복사(원장 내부를 노출하지 않는다)", () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["N1"]) });
    led.intent("main", KILL_AT);
    const snap = led.snapshot();
    snap.sessions.push({ nonce: "X", role: "main", state: "spawning", intentAtMs: 0, killAtMs: 0 });
    snap.supervisor.pid = -9;
    // 외부에서 스냅샷을 오염시켜도 다음 스냅샷·디스크는 영향 없음.
    expect(led.snapshot().sessions).toHaveLength(1);
    expect(led.snapshot().supervisor.pid).toBe(4242);
  });
});

// ── 불법 전이 거부 ────────────────────────────────────────────────────────────────
describe("createLedger — 불법 전이는 명확히 거부(LedgerTransitionError)", () => {
  const setup = () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["N1", "N2"]) });
    return { fake, led };
  };

  test("intent 되지 않은 nonce 를 register 하면 거부", () => {
    const { led } = setup();
    expect(() => led.register("ghost", 5555)).toThrow(LedgerTransitionError);
    expect(() => led.register("ghost", 5555)).toThrow(/intent 되지 않은/);
  });

  test("이미 live 인 엔트리를 재register 하면 거부(spawning 아님)", () => {
    const { led } = setup();
    led.intent("main", KILL_AT);
    led.register("N1", 5555);
    expect(() => led.register("N1", 6666)).toThrow(/spawning 이 아닙니다/);
  });

  test("register pgid ≤ 1 은 거부(init/launchd·광역 오신호 방지)", () => {
    const { led } = setup();
    led.intent("main", KILL_AT);
    expect(() => led.register("N1", 1)).toThrow(/유효하지 않은 pgid/);
    expect(() => led.register("N1", -1)).toThrow(/유효하지 않은 pgid/);
    expect(() => led.register("N1", 0)).toThrow(/유효하지 않은 pgid/);
  });

  test("알 수 없는 nonce 를 settle 하면 거부", () => {
    const { led } = setup();
    expect(() => led.settle("ghost", "reaped")).toThrow(/알 수 없는 nonce/);
  });

  test("double-settle 은 거부(reaped·leaked 둘 다)", () => {
    const { led } = setup();
    led.intent("main", KILL_AT);
    led.register("N1", 5555);
    led.settle("N1", "reaped");
    expect(() => led.settle("N1", "reaped")).toThrow(/double-settle/);
    expect(() => led.settle("N1", "leaked")).toThrow(/double-settle/);
  });

  test("settle leaked 는 live 만 허용(spawning 은 유지할 pgid 없음 → 거부)", () => {
    const { led } = setup();
    led.intent("main", KILL_AT); // spawning(pgid 없음)
    expect(() => led.settle("N1", "leaked")).toThrow(/유지할 pgid 가 없습니다/);
  });

  test("intent role/killAt 정합성: 잘못된 role·비유한 killAt 거부", () => {
    const { led } = setup();
    // @ts-expect-error — 런타임 방어 확인용 잘못된 role.
    expect(() => led.intent("worker", KILL_AT)).toThrow(/알 수 없는 role/);
    expect(() => led.intent("main", Number.NaN)).toThrow(/유한하지 않습니다/);
  });

  test("nonce 충돌(주입 seam 이 같은 값 두 번)은 거부(소유 토큰 유일성)", () => {
    const fake = makeFakeIo();
    const led = createLedger(HB, SUP, fake.io, { now: makeClock().now, nonceGen: makeNonceGen(["DUP", "DUP"]) });
    led.intent("main", KILL_AT);
    expect(() => led.intent("recovery", KILL_AT)).toThrow(/nonce 충돌/);
  });
});

// ── 내구 기록 실패는 삼키지 않고 surface(throw) ───────────────────────────────────
describe("createLedger — 내구 기록 실패는 삼키지 않는다(LedgerWriteError)", () => {
  test("intent 의 write 실패는 던지고 in-memory 도 오염되지 않는다(디스크와 어긋나지 않음)", () => {
    let allow = false;
    const io: LedgerIo = {
      writeFileSync: () => {
        if (!allow) throw new Error("EACCES: permission denied");
      },
      renameSync: () => {},
    };
    const led = createLedger(HB, SUP, io, { now: makeClock().now, nonceGen: makeNonceGen(["N1", "N2"]) });
    expect(() => led.intent("main", KILL_AT)).toThrow(LedgerWriteError);
    expect(() => led.intent("main", KILL_AT)).toThrow(/원장 내구 기록 실패/);
    // 커밋 전에 던졌으므로 실패한 엔트리는 핸들에 남지 않는다(다음 스냅샷은 비어 있다 · 롤백 자동).
    expect(led.snapshot().sessions).toEqual([]);
  });

  test("rename 실패도 던진다(원자 교체 불가 = 내구화 실패)", () => {
    const io: LedgerIo = {
      writeFileSync: () => {},
      renameSync: () => {
        throw new Error("EACCES: rename denied");
      },
    };
    const led = createLedger(HB, SUP, io, { now: makeClock().now, nonceGen: makeNonceGen(["N1"]) });
    expect(() => led.intent("main", KILL_AT)).toThrow(LedgerWriteError);
  });

  test("register 의 write 실패는 던지고 엔트리는 spawning 에 머문다(live 로 새지 않음)", () => {
    let writes = 0;
    const files: Record<string, string> = {};
    const io: LedgerIo = {
      writeFileSync: (p, d) => {
        if (++writes >= 2) throw new Error("EIO: transient"); // 첫 intent 만 성공, register 부터 실패.
        files[p] = d;
      },
      renameSync: (from, to) => {
        files[to] = files[from];
        delete files[from];
      },
    };
    const led = createLedger(HB, SUP, io, { now: makeClock().now, nonceGen: makeNonceGen(["N1"]) });
    led.intent("main", KILL_AT);
    expect(() => led.register("N1", 5555)).toThrow(LedgerWriteError);
    expect(led.snapshot().sessions[0].state).toBe("spawning"); // live 커밋 안 됨.
    expect("pgid" in led.snapshot().sessions[0]).toBe(false);
  });
});

// ── serialize / parse ─────────────────────────────────────────────────────────────
describe("serialize/parse — round-trip · 미지 v 거부 · torn 거부", () => {
  const ledger: Ledger = {
    v: LEDGER_VERSION,
    supervisor: SUP,
    sessions: [
      { nonce: "N1", role: "main", state: "live", pgid: 100, intentAtMs: 1, spawnedAtMs: 2, killAtMs: 9 },
      { nonce: "N2", role: "recovery", state: "spawning", intentAtMs: 3, killAtMs: 9 },
      { nonce: "N3", role: "main", state: "leaked", pgid: 200, intentAtMs: 4, spawnedAtMs: 5, killAtMs: 9 },
      { nonce: "N4", role: "main", state: "reaped", intentAtMs: 6, killAtMs: 9 },
    ],
  };

  test("round-trip: parse(serialize(x)) === x", () => {
    expect(parse(serialize(ledger))).toEqual(ledger);
  });

  test("serialize 는 트레일링 개행을 붙이고 parse 는 그걸 허용한다", () => {
    const s = serialize(ledger);
    expect(s.endsWith("\n")).toBe(true);
    expect(() => parse(s)).not.toThrow();
  });

  test("알 수 없는 v 는 거부(전방 비호환 fail-closed)", () => {
    const future = serialize(ledger).replace('"v":1', '"v":2');
    expect(() => parse(future)).toThrow(LedgerParseError);
    expect(() => parse(future)).toThrow(/알 수 없는 원장 버전/);
    // v 누락도 거부.
    expect(() => parse('{"supervisor":{},"sessions":[]}')).toThrow(/알 수 없는 원장 버전/);
  });

  test("torn/invalid JSON 은 거부", () => {
    const good = serialize(ledger);
    const torn = good.slice(0, good.length - 5); // 끝을 잘라 파싱 불가하게.
    expect(() => parse(torn)).toThrow(LedgerParseError);
    expect(() => parse(torn)).toThrow(/torn\/invalid/);
    expect(() => parse("not json at all")).toThrow(LedgerParseError);
  });

  test("구조 위반 거부: pgid 불변식(live 에 pgid 없음 · spawning 에 pgid 있음)", () => {
    const liveNoPgid = '{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":[{"nonce":"N","role":"main","state":"live","intentAtMs":1,"killAtMs":2}]}';
    expect(() => parse(liveNoPgid)).toThrow(/pgid 가 없습니다/);
    const spawningWithPgid = '{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":[{"nonce":"N","role":"main","state":"spawning","pgid":5,"intentAtMs":1,"killAtMs":2}]}';
    expect(() => parse(spawningWithPgid)).toThrow(/pgid 가 있습니다/);
  });

  test("구조 위반 거부: live 엔트리의 pgid 는 register 와 같은 '1 초과 정수'여야(pgid:1·-1·1.5 → throw)", () => {
    // MEDIUM 회귀: parse 가 pgid 를 '유한 숫자'로만 봐 넘기면 pgid:1/-1/1.5 가 '구조적으로 유효한 v1 원장'으로 통과해
    //   스키마 계약이 깨진다(register 는 1 초과 정수를 강제). 두 쓰기 경로가 같은 불변식을 지켜야 한다.
    const withPgid = (pgid: string): string =>
      `{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":[{"nonce":"N","role":"main","state":"live","pgid":${pgid},"intentAtMs":1,"killAtMs":2}]}`;
    expect(() => parse(withPgid("1"))).toThrow(LedgerParseError); // init/launchd
    expect(() => parse(withPgid("1"))).toThrow(/유효한 pgid 가 아닙니다/);
    expect(() => parse(withPgid("-1"))).toThrow(/유효한 pgid 가 아닙니다/); // 광역
    expect(() => parse(withPgid("0"))).toThrow(/유효한 pgid 가 아닙니다/); // 호출자 그룹
    expect(() => parse(withPgid("1.5"))).toThrow(/유효한 pgid 가 아닙니다/); // 비정수
    // 정상값(2 이상 정수)은 통과.
    expect(() => parse(withPgid("2"))).not.toThrow();
  });

  test("구조 위반 거부: 알 수 없는 role·state, 배열 아닌 sessions", () => {
    const badRole = '{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":[{"nonce":"N","role":"x","state":"spawning","intentAtMs":1,"killAtMs":2}]}';
    expect(() => parse(badRole)).toThrow(/알 수 없는 role/);
    const badState = '{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":[{"nonce":"N","role":"main","state":"zombie","intentAtMs":1,"killAtMs":2}]}';
    expect(() => parse(badState)).toThrow(/알 수 없는 state/);
    const badSessions = '{"v":1,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief"},"sessions":{}}';
    expect(() => parse(badSessions)).toThrow(/sessions 가 배열이 아닙니다/);
  });

  test("잉여 필드는 정규화로 버려진다(round-trip 결정론)", () => {
    const withExtra = '{"v":1,"junk":true,"supervisor":{"pid":1,"startedAtMs":1,"rid":"r","stage":"brief","extra":9},"sessions":[{"nonce":"N","role":"main","state":"spawning","intentAtMs":1,"killAtMs":2,"bogus":"x"}]}';
    const p = parse(withExtra);
    expect(p).toEqual({
      v: 1,
      supervisor: { pid: 1, startedAtMs: 1, rid: "r", stage: "brief" },
      sessions: [{ nonce: "N", role: "main", state: "spawning", intentAtMs: 1, killAtMs: 2 }],
    });
  });
});

// ── evaluateReap — 순수 회수판정 결정표(모든 행) ──────────────────────────────────
describe("evaluateReap — 회수판정 결정표(모든 행)", () => {
  const NONCE = "OWN-NONCE";
  // owner 가 죽은(=고아) 기본 상태 — 대부분의 회수 판정은 owner 사망 전제에서 돈다.
  const OWNER_DEAD: SupervisorState = {
    ledger: { pid: 4242, startedAtMs: 1_000_000 },
    observed: { alive: false, startedAtMs: null },
    nowMs: 2_000_000,
  };
  // owner 가 살아있고 신원 일치(기동시각 동일) — 데몬은 비켜서야 한다.
  const OWNER_ALIVE_OURS: SupervisorState = {
    ledger: { pid: 4242, startedAtMs: 1_000_000 },
    observed: { alive: true, startedAtMs: 1_000_000 },
    nowMs: 2_000_000,
  };
  // owner pid 는 살아있으나 기동시각 불일치 = PID 재사용(무관 프로세스) — not-our-supervisor.
  const OWNER_PID_REUSED: SupervisorState = {
    ledger: { pid: 4242, startedAtMs: 1_000_000 },
    observed: { alive: true, startedAtMs: 9_999_999 },
    nowMs: 2_000_000,
  };

  const liveEntry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
    nonce: NONCE,
    role: "main",
    state: "live",
    pgid: 5555,
    intentAtMs: 1_000_100,
    spawnedAtMs: 1_000_200,
    killAtMs: KILL_AT,
    ...over,
  });
  const spawningEntry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
    nonce: NONCE,
    role: "main",
    state: "spawning",
    intentAtMs: 1_000_100,
    killAtMs: KILL_AT,
    ...over,
  });

  /** procView 팩토리 — 필요한 seam 만 덮고 나머지는 '빈 세계'(그룹 없음·nonce 없음). */
  function makeProc(over: Partial<ProcView> = {}): ProcView {
    return {
      groupMembers: () => [],
      execEnvHas: () => false,
      scanByEnv: () => [],
      ...over,
    };
  }

  // ── live/leaked 행 ──
  test("live + nonce 일치(execEnvHas 경유) → kill", () => {
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001, 6002] : []),
      execEnvHas: (pid, name, value) => pid === 6002 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry(), OWNER_DEAD, proc);
    expect(d).toEqual({ action: "kill", pgid: 5555, nonce: NONCE, reason: expect.stringContaining("nonce 일치") });
  });

  test("live + nonce 일치(scanByEnv 가 그 pgid 반환) → kill", () => {
    const proc = makeProc({
      groupMembers: () => [6001], // 구성원 env 로는 못 잡아도
      execEnvHas: () => false,
      scanByEnv: (name, value) => (name === SESSION_NONCE_ENV && value === NONCE ? [5555] : []), // 스캔이 이 pgid 를 되돌림.
    });
    const d = evaluateReap(liveEntry(), OWNER_DEAD, proc);
    expect(d).toEqual({ action: "kill", pgid: 5555, nonce: NONCE, reason: expect.any(String) });
  });

  test("★ live + nonce 불일치 → refuse(PID 재사용 안전 케이스 · 무관 그룹 오kill 방지)", () => {
    // pgid 5555 는 살아있으나(구성원 존재) 그 exec-env 에 우리 nonce 가 **없다** = 커널이 재사용한 무관 그룹.
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [7001, 7002] : []),
      execEnvHas: () => false, // 어떤 구성원도 우리 nonce 를 지니지 않음.
      scanByEnv: () => [], // 스캔으로도 이 pgid 는 우리 것이 아님.
    });
    const d = evaluateReap(liveEntry(), OWNER_DEAD, proc);
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/nonce 불일치/);
    expect(d.reason).toMatch(/재사용|오kill/);
  });

  test("leaked + nonce 일치 → kill(leaked 도 live 처럼 pgid 로 회수)", () => {
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 8888 ? [9001] : []),
      execEnvHas: (pid, name, value) => pid === 9001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry({ state: "leaked", pgid: 8888 }), OWNER_DEAD, proc);
    expect(d).toEqual({ action: "kill", pgid: 8888, nonce: NONCE, reason: expect.any(String) });
  });

  test("live + 그룹 부재(groupMembers []=ESRCH) → gc(이미 소멸)", () => {
    const proc = makeProc({ groupMembers: () => [] });
    const d = evaluateReap(liveEntry(), OWNER_DEAD, proc);
    expect(d.action).toBe("gc");
    expect(d.reason).toMatch(/그룹 부재|ESRCH|소멸/);
  });

  test("live/leaked 인데 pgid 손상(≤1) → refuse(맨몸 신호 금지 · 방어심층)", () => {
    const proc = makeProc({ groupMembers: () => [1] });
    const d = evaluateReap(liveEntry({ pgid: 1 }), OWNER_DEAD, proc);
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/유효 pgid 부재|손상/);
  });

  // ── spawning 행 ──
  test("spawning + nonce 스캔이 그룹 발견 → scan-then-kill(발견 pgids 동봉)", () => {
    const proc = makeProc({
      scanByEnv: (name, value) => (name === SESSION_NONCE_ENV && value === NONCE ? [4321, 4322] : []),
    });
    const d = evaluateReap(spawningEntry(), OWNER_DEAD, proc);
    expect(d).toEqual({
      action: "scan-then-kill",
      nonce: NONCE,
      pgids: [4321, 4322],
      reason: expect.stringContaining("스캔"),
    });
  });

  test("★ kill·scan-then-kill 결정 **둘 다 nonce 를 동봉**한다(데몬 신호 직전 재검증용 · decision≠signal 계약)", () => {
    // CRITICAL 회귀: 판정→신호 사이 PID 재사용 창(verify→signal TOCTOU)을 좁히려면 데몬이 kill 직전에 다시 검증할
    //   nonce 가 결정에 실려야 한다. kill 에서 nonce 필드가 사라지면(옛 결함) 이 assertion 이 빨간불이어야 한다.
    const killProc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const killD = evaluateReap(liveEntry(), OWNER_DEAD, killProc);
    expect(killD.action).toBe("kill");
    // 판정 시점 검증만 담을 뿐 '신호 허가'가 아니다 — nonce 를 반드시 실어 데몬이 신호 직전 재검증하게 한다.
    expect(killD).toMatchObject({ action: "kill", pgid: 5555, nonce: NONCE });

    const scanProc = makeProc({
      scanByEnv: (name, value) => (name === SESSION_NONCE_ENV && value === NONCE ? [4321] : []),
    });
    const scanD = evaluateReap(spawningEntry(), OWNER_DEAD, scanProc);
    expect(scanD.action).toBe("scan-then-kill");
    // 스캔은 발견 전용이라 데몬이 발견된 각 pgid 를 nonce 로 재검증해야 한다 → nonce 동봉 필수.
    expect(scanD).toMatchObject({ action: "scan-then-kill", nonce: NONCE, pgids: [4321] });
  });

  test("spawning + 무발견 + killAt+여유 초과 → gc(미발생 의도 정리)", () => {
    const proc = makeProc({ scanByEnv: () => [] });
    const past: SupervisorState = { ...OWNER_DEAD, nowMs: KILL_AT + REGISTER_LAG_MARGIN_MS };
    const d = evaluateReap(spawningEntry(), past, proc);
    expect(d.action).toBe("gc");
    expect(d.reason).toMatch(/무발견|미발생/);
  });

  test("spawning + 무발견 + 아직 창 안(killAt+여유 이전) → wait", () => {
    const proc = makeProc({ scanByEnv: () => [] });
    const within: SupervisorState = { ...OWNER_DEAD, nowMs: KILL_AT + REGISTER_LAG_MARGIN_MS - 1 };
    const d = evaluateReap(spawningEntry(), within, proc);
    expect(d.action).toBe("wait");
    expect(d.reason).toMatch(/register-lag|대기/);
  });

  // ── owner 신원 게이트 ──
  test("owner 살아있고 신원 일치 → wait(데몬은 살아있는 owner 세션을 뺏지 않는다)", () => {
    // nonce 가 완벽히 일치해 회수 조건은 갖췄지만, owner 가 살아있으므로 **kill 이 아니라 wait**.
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry(), OWNER_ALIVE_OURS, proc);
    expect(d.action).toBe("wait");
    expect(d.reason).toMatch(/살아있고 신원 일치|defer/);
  });

  test("★ HIGH#2 — 생산측 ms 근사 vs 소비측 초 절삭(ps -o lstart) → 허용오차 안이면 wait(NOT kill · 살아있는 owner 보호)", () => {
    // 회귀 내용: 생산측(supervisor.ts)은 `Date.now()-uptime*1000` 으로 **ms** 를 기록하고, 소비측(W4 데몬)은 같은
    //   값을 `ps -o lstart` 의 **초 단위** 커널 값으로 읽는다. 옛 코드는 그 둘을 엄격 `===` 로 비교했으니 **절대**
    //   같아질 수 없다 → 살아있는 정상 supervisor 가 매번 'PID 재사용'으로 오판되고, 그 세션의 nonce 는 (당연히)
    //   일치하므로 kill 결정이 나 **데몬이 살아있는 owner 의 건강한 세션을 죽인다**. 픽스는 허용오차 비교.
    const ledgerMs = 1_000_000_123; // 생산측: ms 정밀도(…123ms)
    const observedSec = Math.floor(ledgerMs / 1000) * 1000; // 소비측: ps 가 초로 절삭 → …000ms (123ms 차이)
    expect(observedSec).not.toBe(ledgerMs); // 전제 확인 — 엄격 === 는 원리상 실패한다.
    expect(Math.abs(observedSec - ledgerMs)).toBeLessThanOrEqual(START_TIME_TOLERANCE_MS);
    const SAME_SUPERVISOR: SupervisorState = {
      ledger: { pid: 4242, startedAtMs: ledgerMs },
      observed: { alive: true, startedAtMs: observedSec },
      nowMs: 2_000_000,
    };
    // nonce 는 완벽히 일치한다(= 옛 코드가 kill 로 직행하던 조건). 그래도 owner 가 살아있으니 wait 이어야 한다.
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry(), SAME_SUPERVISOR, proc);
    expect(d.action).toBe("wait"); // ★ 살아있는 owner 에게 양보.
    expect(d.action).not.toBe("kill"); // ★ 절대 죽이지 않는다.
    expect(d.reason).toMatch(/신원 일치|defer/);
  });

  test("★ HIGH#2 — 허용오차 경계: 안쪽(≤tol)은 wait · 바깥(>tol)은 회수 진행(진짜 PID 재사용은 놓치지 않는다)", () => {
    const base = 1_000_000_000;
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const at = (observedStart: number): SupervisorState => ({
      ledger: { pid: 4242, startedAtMs: base },
      observed: { alive: true, startedAtMs: observedStart },
      nowMs: 2_000_000,
    });
    // 경계 안쪽(정확히 tol · 양방향 — 데몬이 앞뒤로 흔들려 읽어도 같은 owner 로 본다).
    expect(evaluateReap(liveEntry(), at(base + START_TIME_TOLERANCE_MS), proc).action).toBe("wait");
    expect(evaluateReap(liveEntry(), at(base - START_TIME_TOLERANCE_MS), proc).action).toBe("wait");
    // 경계 바깥(tol+1) — 초 단위 해상도 차이로 설명되지 않는 간격 = 다른 프로세스 → 회수 진행(고아 처리).
    expect(evaluateReap(liveEntry(), at(base + START_TIME_TOLERANCE_MS + 1), proc).action).toBe("kill");
    // 허용오차는 지터 위·재사용 간격 아래의 골짜기에 있어야 한다(값이 뒤집히면 안전 계약이 깨진다).
    expect(START_TIME_TOLERANCE_MS).toBeGreaterThanOrEqual(1_000); // 초 절삭(최대 1초) 지터를 덮는다.
    expect(START_TIME_TOLERANCE_MS).toBeLessThan(60_000); // 현실적 PID 재사용 간격(수 초~수 분)보다 한참 아래.
  });

  test("owner start-time 불일치 → not-our-supervisor(kill(pid,0)만으론 부족 · 고아 회수로 진행)", () => {
    // 같은 pid 가 살아있으나(observed.alive=true) 기동시각이 다르다 = PID 재사용. 그 pid 는 무관 프로세스이므로
    //   owner 로 대접하지 않고, 세션은 고아로 보고 nonce 검증하 회수한다 → live+nonce일치면 kill(wait 아님).
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry(), OWNER_PID_REUSED, proc);
    expect(d.action).toBe("kill"); // wait 이 아니라 회수로 진행.
    expect(d.reason).toMatch(/not-our-supervisor|PID 재사용/);
  });

  test("★ owner 살아있으나 기동시각 못 읽음(alive+startedAtMs=null) → wait(NOT kill · 살아있는 supervisor 세션 보호)", () => {
    // HIGH 회귀: 기동시각을 못 읽었다(권한/파싱)고 '다른 프로세스'로 단정하면, nonce 가 일치하는 살아있는 owner 의
    //   제 세션에 kill 결정이 나 supervisor 가 자기 세션을 죽인다. '못 읽음 ≠ 불일치' — 안전 방향은 wait/refuse.
    //   이 nonce 는 완벽히 일치(회수 조건 성립)하지만, 신원 확인 불가라 회수하면 안 된다.
    const OWNER_ALIVE_START_UNKNOWN: SupervisorState = {
      ledger: { pid: 4242, startedAtMs: 1_000_000 },
      observed: { alive: true, startedAtMs: null }, // 살아있으나 기동시각 못 읽음.
      nowMs: 2_000_000,
    };
    const proc = makeProc({
      groupMembers: (pgid) => (pgid === 5555 ? [6001] : []),
      execEnvHas: (pid, name, value) => pid === 6001 && name === SESSION_NONCE_ENV && value === NONCE,
    });
    const d = evaluateReap(liveEntry(), OWNER_ALIVE_START_UNKNOWN, proc);
    expect(d.action).toBe("wait"); // ★ kill 이 아니다 — 살아있는 owner 를 증명 못 하니 회수 보류.
    expect(d.action).not.toBe("kill");
    expect(d.reason).toMatch(/기동시각 못 읽음|신원 확인 불가|safe direction/);
  });

  test("owner dead → 고아 회수로 진행(reason 에 owner dead 표기)", () => {
    const proc = makeProc({ groupMembers: () => [] });
    const d = evaluateReap(liveEntry(), OWNER_DEAD, proc);
    expect(d.action).toBe("gc");
    expect(d.reason).toMatch(/owner dead/);
  });

  // ── terminal ──
  test("reaped 엔트리 → gc(이미 끝남 · 엔트리 정리)", () => {
    const d = evaluateReap(
      { nonce: NONCE, role: "main", state: "reaped", intentAtMs: 1, killAtMs: KILL_AT },
      OWNER_DEAD,
      makeProc(),
    );
    expect(d.action).toBe("gc");
    expect(d.reason).toMatch(/reaped/);
  });
});
