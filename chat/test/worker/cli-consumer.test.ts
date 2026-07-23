/**
 * cli-consumer.test.ts — 무인 소비자 데몬(W4)의 회귀 가드. **완전 결정적**: 실 fs tmpdir(잡큐) + 주입 시계 +
 *   가짜 runJob(세션 없음) + 가짜 procView(실 ps/pgrep·실 신호 0). 실 `claude` 세션·실 supervisor spawn·실
 *   프로세스 신호는 **여기서 뜨지 않는다**(라이브 스모크는 W5).
 *
 * 두 축:
 *   1) 데몬 수명주기 — 1잡 완주 · 만료/실패 failed/ 격리 · 클레임 경합(둘 중 하나만) · enablement 미등재 스킵(+로그 dedup) ·
 *      잡 수 상한 · v1 레거시(마감 없음) 미클레임.
 *   2) 프로세스 소유권 리퍼(evaluateReap 첫 소비자) — nonce 일치 회수+원장삭제 · PID 재사용 거부(맨몸 kill 금지) ·
 *      killAt-바운드 에스컬레이션(잠긴 결정 4 개정)과 그 nonce 검증 · 미지 원장 버전 거부 · owner 생존 창 내 대기.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConsumerDaemon,
  makeStubRunJob,
  reapOwnershipLedgers,
  type ReapOwnershipDeps,
  type RunJobFn,
  type RunJobInput,
  type SupervisorObservation,
} from "../../src/worker/cli-consumer.js";
import { buildGenerateJob, jobFileName, writePendingJob } from "../../src/kernel/job-protocol.js";
import {
  LEDGER_VERSION,
  REGISTER_LAG_MARGIN_MS,
  SESSION_NONCE_ENV,
  serialize,
  type Ledger,
  type ProcView,
  type SessionEntry,
} from "../../src/worker/ownership.js";
import type { NextAction } from "../../src/types/contract.js";
import type { GenerateJobFile } from "../../src/types/jobs.js";
import type { HarnessResult } from "../../src/kernel/harness-cli.js";
import type { RunJobResult } from "../../src/worker/cli-session-runner.js";

const T0 = 1_700_000_000_000;
const CORE = "/abs/core";

// ── NextAction 팩토리(2중 검사 = generate 차례) ─────────────────────────────────
function na(step: string, stage: string | null): NextAction {
  return {
    rid: "r",
    phase: "01-brief",
    phase_label: "",
    step,
    gate: "user",
    status: "pending",
    awaiting: null,
    iteration: null,
    max_iterations: null,
    action: step === "generate" ? "generate" : "approve",
    stage,
    needs: null,
    options: [],
    recommended: null,
    ra_ok_required: false,
    revise_available: false,
    gate_type: null,
    stop_reason: null,
    advisory: null,
    cmd: "",
    gate_label: "",
    hint: "",
    files: [],
  } as NextAction;
}

let root: string;
let dirs: { jobsPending: string; jobsClaimed: string; jobsFailed: string; jobs: string };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chat-w4-"));
  dirs = {
    jobs: root,
    jobsPending: join(root, "pending"),
    jobsClaimed: join(root, "claimed"),
    jobsFailed: join(root, "failed"),
  };
  await mkdir(dirs.jobsPending, { recursive: true });
});
afterEach(async () => {
  // macOS(APFS)에서 `rm -r` 이 빈 디렉터리 트리에 간헐 ENOTEMPTY 를 내는 경우가 있어 몇 번 재시도한다(테스트 정리
  //   견고화 — 제품 코드와 무관. 잡은 `await consuming` 으로 이미 완료됐다). force:true 라 부재는 무해.
  for (let i = 0; i < 5; i++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
});

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const ls = (d: string): Promise<string[]> => readdir(d).then((n) => n.sort(), () => []);

/** v2 잡 1건을 pending 에 적재. */
async function enqueue(
  rid: string,
  stage: string,
  opts: { enqAt?: number; timeout?: number } = {},
): Promise<GenerateJobFile> {
  const job = buildGenerateJob({
    run_id: rid,
    stage,
    enqueuedAtMs: opts.enqAt ?? T0,
    timeoutMs: opts.timeout ?? 900_000,
  });
  await writePendingJob(dirs.jobsPending, job);
  return job;
}

/** 데몬 seam 기본값(전부 주입 — 실 CLI·실 ps 0). runJob·now·stages 를 테스트가 덮는다. */
function daemon(over: Partial<ConstructorParameters<typeof ConsumerDaemon>[0]> = {}): ConsumerDaemon {
  return new ConsumerDaemon({
    now: () => T0,
    runJob: async () => ({ ok: true, via: "main", detail: "fake" }),
    readNext: async () => na("generate", "brief"),
    reapOwnership: () => [], // 소비 테스트에선 소유권 리퍼 no-op(실 ps 회피 — 리퍼는 별도 테스트).
    stages: ["brief"],
    budgetMs: 480_000,
    startupMarginMs: 60_000,
    dailyJobCap: 20,
    consumerId: "c1",
    pollIntervalMs: 5000,
    coreRoot: CORE,
    paths: dirs,
    sleep: async () => {},
    log: () => {},
    ...over,
  });
}

// ══════════════════════════════════════════════════════════════════════════════════
describe("데몬 수명주기 — 폴링·클레임·소비·처분(동시성 1)", () => {
  it("1잡 완주: pending → 2중 검사 → 클레임 → runJob 성공 → 잡 삭제", async () => {
    await enqueue("r1", "brief");
    const seen: RunJobInput[] = [];
    const runJob: RunJobFn = async (input) => {
      seen.push(input);
      return { ok: true, via: "main", detail: "완주" };
    };
    const d = daemon({ runJob });
    const o = await d.consumeOne();
    expect(o?.action).toBe("claimed");
    expect(o?.ok).toBe(true);
    expect(o?.via).toBe("main");
    // 성공 → 잡 삭제(pending·claimed 모두 비어야 한다).
    expect(await ls(dirs.jobsPending)).toEqual([]);
    expect(await ls(join(dirs.jobsClaimed, "c1"))).toEqual([]);
    // runJob 은 올바른 입력으로 정확히 1회 호출.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ coreRoot: CORE, rid: "r1", stage: "brief", claimedAtMs: T0 });
    expect(seen[0].deadlineMs).toBe(T0 + 900_000);
  });

  it("만료 잡: 남은 시간 < 예산+여유 → failed/ 격리(+.reason) · runJob 미호출", async () => {
    // enqAt 을 과거로 → expires_at 이 지금(T0)보다 앞. 남은 시간 < 필요(예산480+여유60=540초).
    await enqueue("r1", "brief", { enqAt: T0 - 1_000_000, timeout: 900_000 }); // expires T0-100_000 < T0
    let called = 0;
    const d = daemon({ runJob: async () => (called++, { ok: true, via: "main", detail: "" }) });
    const o = await d.consumeOne();
    expect(o).toBeNull(); // 클레임된 게 없다(만료는 takePendingJob 이 failed/ 로 처분).
    expect(called).toBe(0); // 만료 잡은 세션을 돌리지 않는다.
    expect(await ls(dirs.jobsPending)).toEqual([]);
    const failedName = jobFileName("r1", "brief");
    expect(await exists(join(dirs.jobsFailed, failedName))).toBe(true);
    expect(await exists(join(dirs.jobsFailed, `${failedName}.reason`))).toBe(true);
  });

  it("세션 실패: runJob ok=false → failed/ 격리(+.reason=사유)", async () => {
    await enqueue("r1", "brief");
    const runJob: RunJobFn = async () => ({ ok: false, reason: "still_not_transitioned", detail: "전이 안 됨" });
    const d = daemon({ runJob });
    const o = await d.consumeOne();
    expect(o?.action).toBe("claimed");
    expect(o?.ok).toBe(false);
    expect(o?.failReason).toBe("still_not_transitioned");
    expect(await ls(dirs.jobsPending)).toEqual([]);
    const failedName = jobFileName("r1", "brief");
    expect(await exists(join(dirs.jobsFailed, failedName))).toBe(true);
    const reason = await readFile(join(dirs.jobsFailed, `${failedName}.reason`), "utf8");
    expect(reason).toMatch(/still_not_transitioned/);
    expect(reason).toMatch(/전이 안 됨/);
  });

  it("클레임 경합: 두 데몬(c1·c2)이 한 잡을 동시에 집으면 **정확히 하나만** 승리(rename 원자성)", async () => {
    await enqueue("r1", "brief");
    let runCount = 0;
    const runJob: RunJobFn = async () => (runCount++, { ok: true, via: "main", detail: "" });
    const c1 = daemon({ consumerId: "c1", runJob });
    const c2 = daemon({ consumerId: "c2", runJob });
    const [o1, o2] = await Promise.all([c1.consumeOne(), c2.consumeOne()]);
    const claimed = [o1, o2].filter((o) => o?.action === "claimed");
    expect(claimed).toHaveLength(1); // 둘 중 하나만 클레임·실행.
    expect(runCount).toBe(1); // 세션도 정확히 1회.
    // 진 쪽은 lost(경합 패배) 또는 null(그새 사라짐).
    const loser = [o1, o2].find((o) => o?.action !== "claimed");
    if (loser !== null) expect(loser?.action).toBe("lost");
  });

  it("enablement 미등재 단계는 집지 않는다(대기줄에 남긴다 — 사람 소비자 몫)", async () => {
    await enqueue("r1", "concept"); // stages=["brief"] 에 없음
    let called = 0;
    const d = daemon({ runJob: async () => (called++, { ok: true, via: "main", detail: "" }) });
    const o = await d.consumeOne();
    expect(o).toBeNull();
    expect(called).toBe(0);
    // 잡은 pending 에 그대로(클레임·failed 아님).
    expect(await ls(dirs.jobsPending)).toEqual([jobFileName("r1", "concept")]);
  });

  it("미등재 스킵 로그 dedup: 같은 잡이 pending 에 남은 채 consumeOne 2회 → 스킵 로그 1회만(도배 방지)", async () => {
    // 미등재 잡은 클레임되지 않고 pending 에 남아 매 폴마다 재관측된다(S-8: 실측 live-daemon.log 6~138행 도배).
    await enqueue("r1", "concept"); // stages=["brief"] 미등재
    const logs: string[] = [];
    const d = daemon({ log: (l) => logs.push(l) });
    expect(await d.consumeOne()).toBeNull();
    expect(await d.consumeOne()).toBeNull(); // 같은 잡을 두 번째로 다시 훑음
    const skipLogs = logs.filter((l) => l.includes("스킵(enablement 미등재)"));
    expect(skipLogs).toHaveLength(1); // 두 번 훑어도 로그는 1회만.
    // 로그만 억제했을 뿐 스킵 동작 자체는 불변 — 잡은 pending 에 그대로.
    expect(await ls(dirs.jobsPending)).toEqual([jobFileName("r1", "concept")]);
  });

  it("미등재 스킵 로그 dedup: 다른 rid·다른 stage 미등재 잡은 각자 1회씩 로그(잡별 키 rid#stage)", async () => {
    await enqueue("r1", "concept"); // 미등재
    await enqueue("r2", "concept"); // 다른 rid
    await enqueue("r1", "storyboard"); // 같은 rid·다른 stage
    const logs: string[] = [];
    const d = daemon({ log: (l) => logs.push(l) });
    await d.consumeOne();
    await d.consumeOne(); // 재폴 — 새 스킵 로그 없어야 한다.
    const skipLogs = logs.filter((l) => l.includes("스킵(enablement 미등재)"));
    expect(skipLogs).toHaveLength(3); // 세 잡(rid#stage)이 각자 1회.
    expect(skipLogs.filter((l) => l.includes("rid=r1 ") && l.includes("stage=concept"))).toHaveLength(1);
    expect(skipLogs.filter((l) => l.includes("rid=r2 ") && l.includes("stage=concept"))).toHaveLength(1);
    expect(skipLogs.filter((l) => l.includes("rid=r1 ") && l.includes("stage=storyboard"))).toHaveLength(1);
  });

  it("잡 수 상한 도달 시 더 집지 않는다(대기줄에 남긴다 · 성긴 과금 백스톱)", async () => {
    await enqueue("r1", "brief");
    await enqueue("r2", "brief");
    const d = daemon({ dailyJobCap: 1 });
    const results = await d.consumeAvailable();
    // 첫 잡 완주 → 상한(1) 도달 → 둘째는 skipped_cap.
    const claimed = results.filter((r) => r.action === "claimed");
    expect(claimed).toHaveLength(1);
    expect(results.some((r) => r.action === "skipped_cap")).toBe(true);
    // 둘째 잡은 pending 에 남는다.
    const remaining = await ls(dirs.jobsPending);
    expect(remaining).toHaveLength(1);
  });

  it("v1 레거시(마감 없음) 잡은 집지 않고 그대로 둔다(사람 소비자 몫 · 무한대기·좀비 금지)", async () => {
    // expires_at 부재 = v1. writePendingJob 은 있는 그대로 놓는다.
    await writePendingJob(dirs.jobsPending, { version: 1, kind: "generate", run_id: "v1r", stage: "brief" } as GenerateJobFile);
    let called = 0;
    const d = daemon({ runJob: async () => (called++, { ok: true, via: "main", detail: "" }) });
    const o = await d.consumeOne();
    expect(o).toBeNull();
    expect(called).toBe(0);
    expect(await ls(dirs.jobsPending)).toEqual([jobFileName("v1r", "brief")]); // 그대로 유지.
  });

  it("start(): 기동 리퍼 → 소비 → stop 으로 우아하게 종료(잡 완주)", async () => {
    await enqueue("r1", "brief");
    let d!: ConsumerDaemon;
    d = daemon({ sleep: async () => d.stop() }); // 첫 sleep 에서 정지 요청.
    await d.start();
    expect(await ls(dirs.jobsPending)).toEqual([]); // 소비됨.
  });

  it("makeStubRunJob: run-stage code 0 → ok · 비-0 → 실패(still_not_transitioned)", async () => {
    const okStub = makeStubRunJob(async (): Promise<HarnessResult> => ({ code: 0, stdout: "", stderr: "" }));
    await expect(
      okStub({ coreRoot: CORE, rid: "r", stage: "brief", claimedAtMs: T0, deadlineMs: T0 + 1, configDir: "/c", ledgerPath: "/l" }),
    ).resolves.toMatchObject({ ok: true, via: "main" });
    const failStub = makeStubRunJob(async (): Promise<HarnessResult> => ({ code: 3, stdout: "", stderr: "터졌다" }));
    const r = (await failStub({ coreRoot: CORE, rid: "r", stage: "brief", claimedAtMs: T0, deadlineMs: T0 + 1, configDir: "/c", ledgerPath: "/l" })) as Extract<RunJobResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("still_not_transitioned");
    expect(r.detail).toMatch(/터졌다/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
describe("Codex R1 수정 회귀(P1/P2)", () => {
  it("#2 실패 잡도 잡 수 상한에 집계된다(실패 세션도 과금) — cap=1, 첫 잡 실패 → 둘째 skipped_cap", async () => {
    await enqueue("r1", "brief");
    await enqueue("r2", "brief");
    const d = daemon({ dailyJobCap: 1, runJob: async () => ({ ok: false, reason: "still_not_transitioned", detail: "실패" }) });
    const results = await d.consumeAvailable();
    // 첫 잡: claimed+실패(집계됨) → 상한(1) 도달 → 둘째: skipped_cap.
    expect(results.filter((r) => r.action === "claimed").length).toBe(1);
    expect(results.some((r) => r.action === "skipped_cap")).toBe(true);
    expect((await ls(dirs.jobsPending)).length).toBe(1); // 둘째는 대기줄에 남는다.
  });

  it("#4 원장·configDir 경로가 잡별 유니크(job_id 부착) — 재시도가 미해결 원장을 clobber 하지 않는다", async () => {
    const job = await enqueue("r1", "brief");
    expect(typeof job.job_id).toBe("string");
    let captured: RunJobInput | undefined;
    const d = daemon({
      runJob: async (input) => {
        captured = input;
        return { ok: true, via: "main", detail: "" };
      },
    });
    await d.consumeOne();
    expect(captured?.ledgerPath).toContain(job.job_id as string);
    expect(captured?.configDir).toContain(job.job_id as string);
    // rid-stage 만으로 이름이 정해지지 않음(유니크 도장 포함).
    expect(captured?.ledgerPath).not.toMatch(/\/r1-brief\.json$/);
  });

  it("#3 drainInFlight: 진행 중 잡 없으면 즉시 true", async () => {
    const d = daemon();
    expect(await d.drainInFlight(10)).toBe(true);
  });

  it("#3 drainInFlight: 진행 중 잡이 유예 안에 끝나면 true", async () => {
    await enqueue("r1", "brief");
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // runJob 이 실제 **호출된** 시점 신호 — 그때 consumeOne 이 inFlight 를 세팅했음이 보장된다(async 단계 이후).
    const started = new Promise<void>((r) => (signalStarted = r));
    const d = daemon({ runJob: async () => { signalStarted(); await gate; return { ok: true, via: "main", detail: "" }; } });
    const consuming = d.consumeOne();
    await started; // inFlight 세팅 보장(마이크로태스크 1회로는 async fs 단계를 못 넘긴다)
    const drainP = d.drainInFlight(5000);
    release(); // 잡 완료
    expect(await drainP).toBe(true);
    await consuming;
  });

  it("#3 drainInFlight: 유예를 넘겨도 매달리지 않고 false(백스톱에 위임)", async () => {
    await enqueue("r1", "brief");
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (signalStarted = r));
    const d = daemon({ runJob: async () => { signalStarted(); await gate; return { ok: true, via: "main", detail: "" }; } });
    const consuming = d.consumeOne();
    await started;
    expect(await d.drainInFlight(20)).toBe(false); // 유예 20ms 초과 → false(행 없음)
    release();
    await consuming;
  });

  it("#7 주기 리퍼: start() 가 소유권 리퍼를 기동 + 매 폴링 주기에 돌린다(기동-only 아님)", async () => {
    let reapCalls = 0;
    let d!: ConsumerDaemon;
    d = daemon({
      reapOwnership: () => { reapCalls++; return []; },
      sleep: async () => d.stop(), // 첫 sleep 에서 정지(한 주기 후)
    });
    await d.start();
    // 기동 1회 + 루프 주기 1회 = 최소 2회(consumeAvailable 안 잡별 리퍼는 잡이 없어 안 돔).
    expect(reapCalls).toBeGreaterThanOrEqual(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
describe("프로세스 소유권 리퍼(evaluateReap 첫 소비자) — nonce 검증-후-kill", () => {
  const LEDGER_PATH = "/led/r1-brief.json";
  const SUP_PID = 9999;
  const PGID = 4242;
  const NONCE = "nonce-abc";

  /** 세션 1건짜리 원장 텍스트(직렬화). */
  function ledgerText(entry: Partial<SessionEntry>, supOver: Partial<Ledger["supervisor"]> = {}): string {
    const session: SessionEntry = {
      nonce: NONCE,
      role: "main",
      state: "live",
      pgid: PGID,
      intentAtMs: T0 - 500_000,
      killAtMs: T0 - 10_000, // 기본 = 과거(마감 지남)
      ...entry,
    };
    const ledger: Ledger = {
      v: LEDGER_VERSION,
      supervisor: { pid: SUP_PID, startedAtMs: 1000, rid: "r1", stage: "brief", ...supOver },
      sessions: [session],
    };
    return serialize(ledger);
  }

  function procView(over: Partial<ProcView> = {}): ProcView {
    return {
      groupMembers: () => [],
      execEnvHas: () => false,
      scanByEnv: () => [],
      ...over,
    };
  }

  /** 리퍼 seam(전부 가짜). 킬·삭제를 캡처. */
  function reapDeps(over: Partial<ReapOwnershipDeps> & { text?: string }): {
    deps: ReapOwnershipDeps;
    kills: Array<[number, string]>;
    deleted: string[];
  } {
    const kills: Array<[number, string]> = [];
    const deleted: string[] = [];
    const { text, ...rest } = over;
    const deps: ReapOwnershipDeps = {
      ledgerDir: "/led",
      now: () => T0,
      listLedgers: () => [LEDGER_PATH],
      readLedger: () => text ?? ledgerText({}),
      deleteLedger: (p) => deleted.push(p),
      procView: procView(),
      observeSupervisor: (): SupervisorObservation => ({ alive: false, startedAtMs: null }), // owner dead 기본
      signalGroup: (pgid, sig) => kills.push([pgid, sig]),
      groupAlive: () => false, // kill 성공(소멸 확인) 기본
      log: () => {},
      ...rest,
    };
    return { deps, kills, deleted };
  }

  it("owner dead + live 세션 + nonce 일치 → SIGKILL 회수 + 원장 삭제", () => {
    const { deps, kills, deleted } = reapDeps({
      text: ledgerText({}),
      procView: procView({
        groupMembers: (p) => (p === PGID ? [5000] : []),
        execEnvHas: (pid, name, val) => pid === 5000 && name === SESSION_NONCE_ENV && val === NONCE,
      }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.killed).toEqual([PGID]);
    expect(r.refused).toEqual([]);
    expect(r.deleted).toBe(true);
    expect(kills).toEqual([[PGID, "SIGKILL"]]);
    expect(deleted).toEqual([LEDGER_PATH]);
  });

  it("PID 재사용(nonce 불일치) → 신호 **거부**(맨몸 kill 금지) — 이 한 줄이 옛 재앙을 닫는다", () => {
    const { deps, kills } = reapDeps({
      text: ledgerText({}),
      procView: procView({
        groupMembers: (p) => (p === PGID ? [5000] : []), // pgid 는 살아있으나…
        execEnvHas: () => false, // …우리 nonce 가 없다(재사용된 무관 그룹)
        scanByEnv: () => [],
      }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.refused).toEqual([PGID]);
    expect(r.killed).toEqual([]);
    expect(kills).toEqual([]); // ★ 절대 신호하지 않는다.
  });

  it("owner 생존 + 신원 일치 + 마감 창 안(killAt 미래) → wait(회수 보류 · 원장 유지)", () => {
    const { deps, kills, deleted } = reapDeps({
      text: ledgerText({ killAtMs: T0 + 100_000 }), // 마감 미래 = 아직 owner 관리 중
      observeSupervisor: () => ({ alive: true, startedAtMs: 1000 }), // 기동시각 원장과 일치(허용오차 안)
      procView: procView({ groupMembers: () => [5000], execEnvHas: () => true }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.waited).toBe(true);
    expect(r.deleted).toBe(false); // owner 소유라 원장을 남긴다.
    expect(kills).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("killAt-바운드 에스컬레이션(잠긴 결정 4 개정): owner 생존이라 wait 여도 killAt+여유 초과면 nonce 검증하 회수", () => {
    const { deps, kills } = reapDeps({
      // owner 살아있고 신원 일치 → evaluateReap 은 wait. 하지만 세션은 killAt+여유를 넘겨 생존.
      text: ledgerText({ killAtMs: T0 - REGISTER_LAG_MARGIN_MS - 1000 }),
      observeSupervisor: () => ({ alive: true, startedAtMs: 1000 }),
      procView: procView({
        groupMembers: (p) => (p === PGID ? [5000] : []),
        execEnvHas: (pid) => pid === 5000, // nonce 일치
      }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.escalated).toEqual([PGID]); // 에스컬레이션으로 회수.
    expect(r.killed).toEqual([PGID]);
    expect(kills).toEqual([[PGID, "SIGKILL"]]);
    // ★ kill 은 했어도 owner 가 살아있으므로(신원 일치 wait) 원장은 **삭제하지 않는다** — owner settle 과 경합 회피.
    expect(r.deleted).toBe(false);
  });

  it("에스컬레이션도 nonce 를 검증한다: 마감 초과여도 nonce 불일치면 **거부**(맨몸 kill 절대 없음)", () => {
    const { deps, kills } = reapDeps({
      text: ledgerText({ killAtMs: T0 - REGISTER_LAG_MARGIN_MS - 1000 }),
      observeSupervisor: () => ({ alive: true, startedAtMs: 1000 }),
      procView: procView({
        groupMembers: (p) => (p === PGID ? [5000] : []),
        execEnvHas: () => false, // nonce 불일치 → 에스컬레이션도 거부해야 한다
        scanByEnv: () => [],
      }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.refused).toEqual([PGID]);
    expect(r.killed).toEqual([]);
    expect(kills).toEqual([]); // 에스컬레이션 경로도 맨몸 신호 없음.
  });

  it("미지 원장 버전 → 거부(회수 안 함 · 파일 유지)", () => {
    const { deps, kills, deleted } = reapDeps({
      text: `${JSON.stringify({ v: 99, supervisor: { pid: 1, startedAtMs: 0, rid: "r", stage: "s" }, sessions: [] })}\n`,
      procView: procView({ groupMembers: () => [5000], execEnvHas: () => true }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.parseError).toMatch(/미지 버전|원장 거부/);
    expect(r.killed).toEqual([]);
    expect(kills).toEqual([]);
    expect(deleted).toEqual([]); // 파싱 못 한 원장은 삭제하지 않는다.
  });

  it("owner dead + 그룹 이미 소멸(ESRCH) → gc(회수할 것 없음) + 원장 삭제", () => {
    const { deps, kills, deleted } = reapDeps({
      text: ledgerText({}),
      procView: procView({ groupMembers: () => [] }), // ESRCH — 그룹 없음
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.killed).toEqual([]);
    expect(kills).toEqual([]);
    expect(r.deleted).toBe(true); // 고아 없음 → 원장 정리.
    expect(deleted).toEqual([LEDGER_PATH]);
  });

  it("SIGKILL 후에도 생존(leaked) → 원장 유지(다음 pass 재시도)", () => {
    const { deps, deleted } = reapDeps({
      text: ledgerText({}),
      procView: procView({ groupMembers: (p) => (p === PGID ? [5000] : []), execEnvHas: () => true }),
      groupAlive: () => true, // kill 했으나 그룹 생존
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.killed).toEqual([]); // 소멸 확인 안 됨 → killed 로 세지 않는다.
    expect(r.deleted).toBe(false); // 살아있는 그룹 → 원장 유지.
    expect(deleted).toEqual([]);
  });

  it("#5 프로세스 관측 실패(procView throw) → 회수·삭제 보류 + 원장 유지(불확실→보류 · 조기삭제 금지)", () => {
    const { deps, kills, deleted } = reapDeps({
      text: ledgerText({}),
      procView: procView({
        groupMembers: () => {
          throw new Error("pgrep 실패(타임아웃)"); // 조작 실패 = '알 수 없음'(무매칭 아님)
        },
      }),
    });
    const [r] = reapOwnershipLedgers(deps);
    expect(r.inspectError).toMatch(/pgrep 실패/);
    expect(r.killed).toEqual([]); // 회수 보류.
    expect(kills).toEqual([]); // 신호 없음.
    expect(r.deleted).toBe(false); // ★ 관측 실패를 '그룹 없음'으로 오독해 삭제하지 않는다.
    expect(deleted).toEqual([]);
  });
});
