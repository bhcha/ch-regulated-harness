/**
 * cli-session-runner.test.ts — 무인 잡 수명주기(runJobSession)의 회귀 가드.
 *
 * ⚠ 마감 강제 기계(supervisor) 자체의 회귀는 **supervisor.test.ts** 로 분리됐다(소유권 원장 배선 포함) — 이 파일은
 *   **러너의 조립·순서·백스톱**만 다룬다(supervise seam 은 결과 큐로 흉내낸다).
 *
 * 전부 **완전 결정적**이다: 가짜 시계(now 주입)와 가짜 스폰(supervise seam)으로 돈다.
 *   ⚠ 실 `claude` 세션은 여기서 **뜨지 않는다**(W3 오프라인 DoD). 규칙 문자열이 실제로 무엇을 막는지·프로세스그룹
 *     kill 이 실제 손자까지 닿는지는 여기서 증명되지 않는다 — 그건 W5 라이브 카나리다.
 *   ⚠ **행 금지**: 회귀는 ms 안에 실패해야 한다. supervise seam 이 결과를 즉시 돌려주므로 promise 가 매달리지 않는다.
 */
import { describe, expect, test } from "vitest";

import type { NextAction } from "../../src/types/contract.js";
import type { SessionPlan } from "../../src/worker/cli-session.js";
import {
  RECOVERY_BUDGET_MS,
  RECOVERY_MAX_TURNS,
  RECOVERY_RESERVE_MS,
  RECOVERY_SESSION_TOOLS,
  type RunJobFailReason,
  type RunJobSessionDeps,
  type RunJobSessionInput,
  runJobSession,
} from "../../src/worker/cli-session-runner.js";
import type { SessionRole } from "../../src/worker/ownership.js";
import {
  type KillSchedule,
  type SessionOutcome,
  type SuperviseResult,
  TERM_MARGIN_MS,
} from "../../src/worker/supervisor.js";

// ── 고정 상수(머신 무관 · 조립 결정론) ──────────────────────────────────────────
const CORE = "/abs/core";
const RID = "run-abc-0718";
const CONFIG_DIR = "/abs/worker/cfg";
const CLAIMED = 1_000_000;
const GEN_TIMEOUT = 480_000;
const DEADLINE = CLAIMED + GEN_TIMEOUT + 100_000; // 마감이 예산보다 멀다 → kill_at = 예산 마감(claimed+gen)
const KILL_AT = CLAIMED + GEN_TIMEOUT; // 1_480_000
const TERM_AT = KILL_AT - TERM_MARGIN_MS; // 1_450_000

const ABS_RUN_STAGE = `${CORE}/scripts/run-stage.sh`;
const EMIT_CMD = `bash ${ABS_RUN_STAGE} brief ${RID} --emit-context`;
const TRANSITION_CMD = `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${ABS_RUN_STAGE} brief ${RID}`;

/** 합성 brief SKILL.md — rewriteSkill 이 받아들이는 최소형(읽기전용 로드 + 전이 두 펜스). 실 core 없이 조립을 검증. */
const SKILL_BRIEF = [
  "---",
  "name: brief",
  "---",
  "# /brief",
  "",
  "읽기전용 입력 로드:",
  "```bash",
  "bash scripts/run-stage.sh brief <RUN> --emit-context",
  "```",
  "",
  "전이:",
  "```bash",
  "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
  "```",
].join("\n");

// ── NextAction 팩토리 ───────────────────────────────────────────────────────────
function makeNa(over: Partial<NextAction>): NextAction {
  return {
    rid: RID,
    phase: "01-brief",
    phase_label: "브리프",
    step: "generate",
    gate: null,
    status: "pending",
    awaiting: null,
    iteration: null,
    max_iterations: null,
    action: "generate",
    stage: "brief",
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
    ...over,
  };
}
/** 아직 그 단계 생성 차례(= 전이 안 됨). */
const NA_STILL_GENERATE = makeNa({ step: "generate", stage: "brief" });
/** 전이 완료(사람 승인 게이트로 넘어감). */
const NA_TRANSITIONED = makeNa({ step: "human", stage: "brief", gate: "user" });

// ── 러너 seam 헬퍼 ──────────────────────────────────────────────────────────────
function makeInput(over: Partial<RunJobSessionInput> = {}): RunJobSessionInput {
  return {
    coreRoot: CORE,
    rid: RID,
    stage: "brief",
    claimedAtMs: CLAIMED,
    deadlineMs: DEADLINE,
    configDir: CONFIG_DIR,
    baseEnv: { PATH: "/usr/bin" },
    genTimeoutMs: GEN_TIMEOUT,
    maxTurns: 50,
    ...over,
  };
}

/** supervise seam 을 결과 큐로 흉내내고 호출(플랜·역할·스케줄)을 기록한다. role 은 러너가 주=main·복구=recovery 로 실어준다. */
function makeSupervise(results: SuperviseResult[]) {
  const calls: Array<{ plan: SessionPlan; role: SessionRole; schedule: KillSchedule }> = [];
  const supervise = async (
    plan: SessionPlan,
    role: SessionRole,
    schedule: KillSchedule,
  ): Promise<SuperviseResult> => {
    calls.push({ plan, role, schedule });
    const r = results[calls.length - 1];
    if (!r) throw new Error(`makeSupervise: 예상보다 많은 supervise 호출(${calls.length})`);
    return r;
  };
  return { supervise, calls };
}

/**
 * 기본 seam 한 벌(성공 경로) — 개별 테스트가 필요한 것만 덮는다. `supervise` 는 **필수**다(러너가 기본 seam 을
 *   두지 않으므로 · 원장 배선은 호출자 몫): 모든 러너 테스트가 가짜 supervise 를 주입한다.
 */
function makeDeps(over: Partial<RunJobSessionDeps> & Pick<RunJobSessionDeps, "supervise">): RunJobSessionDeps {
  return {
    now: () => CLAIMED + 1_000, // 넉넉한 여유
    readDomain: async () => "cosmetic",
    readSkillMd: async () => SKILL_BRIEF,
    writeSettings: async () => {},
    readNext: async () => NA_TRANSITIONED,
    artifactPresent: async () => true,
    ...over,
  };
}

/** allowedTools 규칙 슬라이스(그 다음 플래그 전까지)를 뽑는다. */
function allowRulesOf(argv: string[]): string[] {
  const at = argv.indexOf("--allowedTools");
  if (at < 0) return [];
  let end = at + 1;
  while (end < argv.length && !argv[end].startsWith("--")) end++;
  return argv.slice(at + 1, end);
}

// ── 테스트 2·3·4: runJobSession 수명주기 ────────────────────────────────────────
describe("runJobSession — 조립 → 스폰(supervisor) → 전이확인 → 복구 백스톱", () => {
  // 테스트 3
  test("성공 경로: 주 세션이 전이시키면 복구 세션을 띄우지 않는다", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    let artifactChecked = false;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => NA_TRANSITIONED,
        artifactPresent: async () => {
          artifactChecked = true;
          return true;
        },
      }),
    );
    expect(res).toEqual({ ok: true, via: "main", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1); // 복구 미스폰
    expect(artifactChecked).toBe(false); // 전이됐으면 산출물 확인조차 안 한다
  });

  // 테스트 4
  test("전이 안 됨 → 복구 세션을 정확히 1회 띄우고, 그 argv 는 전이 규칙 하나만 싣는다", async () => {
    const sup = makeSupervise([
      { outcome: "exited", exitCode: 0, detail: "" }, // 주
      { outcome: "exited", exitCode: 0, detail: "" }, // 복구
    ]);
    let naCalls = 0;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => (naCalls++ === 0 ? NA_STILL_GENERATE : NA_TRANSITIONED),
        artifactPresent: async () => true,
      }),
    );
    expect(res).toEqual({ ok: true, via: "recovery", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(2); // 정확히 1회 복구

    // 주 세션 allowedTools = 읽기전용 로드 + 전이 두 규칙 · max-turns 50.
    const mainArgv = sup.calls[0].plan.argv;
    expect(allowRulesOf(mainArgv)).toEqual([`Bash(${EMIT_CMD})`, `Bash(${TRANSITION_CMD})`]);
    expect(mainArgv[mainArgv.indexOf("--max-turns") + 1]).toBe("50");

    // 복구 세션 allowedTools = **전이 규칙 하나뿐**(emit-context 없음) · max-turns 5.
    const recArgv = sup.calls[1].plan.argv;
    expect(allowRulesOf(recArgv)).toEqual([`Bash(${TRANSITION_CMD})`]);
    expect(allowRulesOf(recArgv)).not.toContain(`Bash(${EMIT_CMD})`);
    expect(recArgv[recArgv.indexOf("--max-turns") + 1]).toBe(String(RECOVERY_MAX_TURNS));
    // 프롬프트(마지막 토큰)는 그 전이 명령을 verbatim 으로 담는다(프롬프트·규칙 같은 출처 = 결정론).
    expect(recArgv[recArgv.length - 1]).toContain(TRANSITION_CMD);

    // 복구 세션 --tools = 최소(Bash 하나) — acceptEdits 자동승인 하에서도 산출물 Write/Edit 불가(Finding 4).
    const recTools = recArgv[recArgv.indexOf("--tools") + 1];
    expect(recTools).toBe(RECOVERY_SESSION_TOOLS);
    expect(recTools).not.toContain("Write");
    expect(recTools).not.toContain("Edit");
    // 대조: 주 세션은 산출물을 써야 하므로 --tools 에 Write/Edit 를 담는다.
    const mainTools = mainArgv[mainArgv.indexOf("--tools") + 1];
    expect(mainTools).toContain("Write");
    expect(mainTools).toContain("Edit");

    // 선확보(S-5): 주 세션은 앞당긴 kill_at(잡 kill_at − RECOVERY_RESERVE), 복구 세션은 잡 kill_at 아래 돈다.
    //   기본 예산(gen=480s)은 선확보해도 스폰 여유가 넉넉해 폴백하지 않는다(주=선확보 스케줄).
    expect(sup.calls[0].schedule.killAtMs).toBe(KILL_AT - RECOVERY_RESERVE_MS);
    expect(sup.calls[1].schedule.killAtMs).toBe(KILL_AT);
  });

  test("전이 안 됨 + 복구도 전이 실패 → still_not_transitioned(보고만 · 큐 미접촉)", async () => {
    const sup = makeSupervise([
      { outcome: "exited", exitCode: 0, detail: "" },
      { outcome: "exited", exitCode: 0, detail: "" },
    ]);
    const res = await runJobSession(
      makeInput(),
      makeDeps({ supervise: sup.supervise, readNext: async () => NA_STILL_GENERATE, artifactPresent: async () => true }),
    );
    expect(res).toEqual({ ok: false, reason: "still_not_transitioned", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(2);
  });

  // 테스트 2 (A)
  test("스폰 결정 시점 여유 부족(남은 < TERM_MARGIN) → 주 세션조차 안 띄운다(refused)", async () => {
    const sup = makeSupervise([]); // 하나라도 호출되면 던진다
    const res = await runJobSession(
      makeInput(),
      makeDeps({ supervise: sup.supervise, now: () => TERM_AT + 1 }),
    );
    expect(res).toEqual({ ok: false, reason: "refused_insufficient_time", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(0);
  });

  // 테스트 2 (B)
  test("전이 안 됨 + 산출물 있음이나 복구 예산 부족 → 복구를 건너뛴다(skip)", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]); // 주만
    let nowCalls = 0;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        // 1번째 now(스폰 결정)=여유 충분 · 이후(복구 예산 판정)=남은 시간 < RECOVERY_BUDGET.
        now: () => (nowCalls++ === 0 ? CLAIMED + 1_000 : KILL_AT - (RECOVERY_BUDGET_MS - 40_000)),
        readNext: async () => NA_STILL_GENERATE,
        artifactPresent: async () => true,
      }),
    );
    expect(res).toEqual({ ok: false, reason: "recovery_budget_insufficient", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1); // 복구 미스폰
  });

  test("전이 안 됨 + 산출물 없음 → 복구 무의미(not_transitioned_no_artifact)", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput(),
      makeDeps({ supervise: sup.supervise, readNext: async () => NA_STILL_GENERATE, artifactPresent: async () => false }),
    );
    expect(res).toEqual({ ok: false, reason: "not_transitioned_no_artifact", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1);
  });

  test("주 세션 reap 실패 → 즉시 실패(복구 시도 안 함 · 마감 기계 자체가 실패)", async () => {
    const sup = makeSupervise([{ outcome: "reap_failed", exitCode: null, detail: "그룹 생존" }]);
    let naChecked = false;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => {
          naChecked = true;
          return NA_STILL_GENERATE;
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "reap_failed", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1);
    expect(naChecked).toBe(false); // 마감 기계 실패면 next-action 도 신뢰 안 한다
  });

  // ── HIGH#1(러너): 주 세션 spawn_failed → 즉시 실패(전이·산출물 확인 무의미) ─────────────────────────
  test("주 세션 spawn_failed → 전이 확인 없이 spawn_failed 로 처분", async () => {
    const sup = makeSupervise([{ outcome: "spawn_failed", exitCode: null, detail: "유효 pgid 없음" }]);
    let naChecked = false;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => {
          naChecked = true;
          return NA_TRANSITIONED;
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "spawn_failed", detail: expect.any(String) });
    expect(naChecked).toBe(false); // 세션이 뜨지도 못했으면 next-action 을 보지 않는다.
  });

  // ── MEDIUM#4(러너): output_cap 은 전이가 관측돼도 실패 ────────────────────────────────────────────
  test("주 세션 output_cap → 전이가 관측돼도 ok:false(우연한 전이를 성공으로 오판하지 않는다)", async () => {
    const sup = makeSupervise([{ outcome: "output_cap", exitCode: null, detail: "출력 상한 초과" }]);
    let naChecked = false;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => {
          naChecked = true;
          return NA_TRANSITIONED; // 전이가 보여도
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "output_cap", detail: expect.any(String) });
    expect(naChecked).toBe(false); // output_cap 이면 전이 확인 전에 끊는다.
  });

  // ── HIGH(러너): ledger_unwritable 은 전이 확인 없이 실패로 처분(2급 백스톱 없이 안 돌린다) ─────────────────────
  //   S3 가 supervisor outcome 을 이 이름으로 개명(옛 하트비트 백스톱 → nonce 원장)했고, S4 가 러너 소비를 여기에
  //   정렬했다. 옛 하트비트 outcome 이름은 이제 소스·테스트 어디에도 없다.
  test("주 세션 ledger_unwritable → 전이 확인 없이 ledger_unwritable 로 처분", async () => {
    const sup = makeSupervise([{ outcome: "ledger_unwritable", exitCode: null, detail: "백스톱 미확립" }]);
    let naChecked = false;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => {
          naChecked = true;
          return NA_TRANSITIONED; // 전이가 보여도
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "ledger_unwritable", detail: expect.any(String) });
    expect(naChecked).toBe(false); // 2급 백스톱이 안 서서 회수된 세션은 next-action 을 보지 않는다.
  });

  // ── MEDIUM#2: config 게터 오설정은 reject 가 아니라 구조적 config_error(늘 RunJobResult 를 보고한다) ──────────
  test("CHAT_SDK_MAX_TURNS=0(오설정) + maxTurns 미지정 → reject 아니라 config_error(스폰 전 · 구조적 실패)", async () => {
    const sup = makeSupervise([]); // 하나라도 호출되면 던진다 — config 단계에서 끊겨야 한다.
    const prev = process.env.CHAT_SDK_MAX_TURNS;
    process.env.CHAT_SDK_MAX_TURNS = "0"; // sdkMaxTurns() 가 던지는 오설정.
    let res: Awaited<ReturnType<typeof runJobSession>>;
    try {
      res = await runJobSession(
        // 스펙에서 maxTurns 를 지워 게터를 타게 한다(genTimeoutMs 는 남겨 그쪽 게터는 안 탄다).
        makeInput({ maxTurns: undefined }),
        makeDeps({ supervise: sup.supervise }),
      );
    } finally {
      if (prev === undefined) delete process.env.CHAT_SDK_MAX_TURNS;
      else process.env.CHAT_SDK_MAX_TURNS = prev;
    }
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("config_error");
    expect(sup.calls).toHaveLength(0); // config 오설정은 스폰 전(첫 try 앞)에서 끊긴다.
  });

  // ── MEDIUM#2: 비유한 스케줄 입력·seam rejection 도 reject 가 아니라 구조적 실패(함수 계약) ──────────
  test("비유한 deadlineMs(런타임 오류) → reject 아니라 config_error(computeKillSchedule 가드 · 스폰 전)", async () => {
    // 잡 파일 expires_at 파싱이 깨져 deadlineMs 가 비유한이면 computeKillSchedule 이 던진다. 가드 밖이면 그 throw 가
    //   runJobSession 을 reject 시켜 함수 계약('늘 구조적 RunJobResult')을 깬다 — config_error 로 환원돼야 한다.
    const sup = makeSupervise([]); // 스케줄에서 끊겨야 한다 — 하나라도 호출되면 던진다.
    const res = await runJobSession(
      makeInput({ deadlineMs: "bad" as unknown as number }),
      makeDeps({ supervise: sup.supervise }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("config_error");
    expect(sup.calls).toHaveLength(0); // 스케줄 계산(스폰 전)에서 끊긴다.
  });

  test("supervise seam 이 reject 해도 runJobSession 은 reject 하지 않고 config_error 를 돌려준다(함수 계약)", async () => {
    // superviseSession 은 계약상 늘 resolve 하지만, 주입/미래 seam 이 reject 하면 함수 밖으로 새면 안 된다.
    const supervise = async (): Promise<SuperviseResult> => {
      throw new Error("감독 seam 내부 오류(계약 위반)");
    };
    const res = await runJobSession(makeInput(), makeDeps({ supervise }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("config_error");
  });

  // ── MEDIUM#3: 복구 조립·settings 기록 실패 → reject 가 아니라 구조적 실패 결과 ──────────────────────
  test("복구 settings 기록이 디스크 오류로 실패해도 reject 하지 않고 recovery_compose_error 를 돌려준다", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]); // 주 세션만(복구는 조립에서 죽는다)
    let writeCalls = 0;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => NA_STILL_GENERATE, // 전이 안 됨 → 복구 진입
        artifactPresent: async () => true, // 산출물 있음 → 복구 진입
        // 첫 기록(주 세션 격리 settings)은 통과, 두 번째(복구)에서 디스크 오류.
        writeSettings: async () => {
          writeCalls++;
          if (writeCalls >= 2) throw new Error("ENOSPC: no space left on device");
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("recovery_compose_error");
    expect(sup.calls).toHaveLength(1); // 복구는 스폰 전(조립)에서 죽어 supervise 미호출.
  });

  test("keyvisual(미지원 단계)은 스폰 전에 깨끗이 실패한다(compose_error · 예외를 흘리지 않는다)", async () => {
    const sup = makeSupervise([]);
    const res = await runJobSession(
      makeInput({ stage: "keyvisual" }),
      makeDeps({ supervise: sup.supervise, readSkillMd: async () => "irrelevant" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("compose_error");
    expect(sup.calls).toHaveLength(0); // 스폰 없음
  });

  test("도메인 읽기 실패 → 스폰 전 compose_error(fail-closed)", async () => {
    const sup = makeSupervise([]);
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readDomain: async () => {
          throw new Error("state.json 을 읽을 수 없습니다");
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("compose_error");
    expect(sup.calls).toHaveLength(0);
  });

  test("SKILL.md 펜스에 예상 밖 명령이 있으면 호출부 거부(unexpected_commands)", async () => {
    const sup = makeSupervise([]);
    const skillWithStray = [
      "---",
      "name: brief",
      "---",
      "```bash",
      "bash scripts/run-stage.sh brief <RUN> --emit-context",
      "```",
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
      "```bash",
      "rm -rf /tmp/whatever", // 예상 밖(run-stage 호출 아님)
      "```",
    ].join("\n");
    const res = await runJobSession(
      makeInput(),
      makeDeps({ supervise: sup.supervise, readSkillMd: async () => skillWithStray }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unexpected_commands");
    expect(sup.calls).toHaveLength(0);
  });

  test("주 세션 후 next-action 조회 실패 → next_action_unreadable(전이 판단 불가)", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => {
          throw new Error("next-action.sh 비정상 종료");
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("next_action_unreadable");
  });

  test("복구 예산 상수는 TERM_MARGIN 보다 크다(복구 세션도 우아한 종료 여유를 갖는다)", () => {
    expect(RECOVERY_BUDGET_MS).toBeGreaterThan(TERM_MARGIN_MS);
  });

  // ── S-5: 회복예산 선확보 — 주 세션 kill_at 을 잡 kill_at 보다 RECOVERY_RESERVE 만큼 앞당겨 복구 몫을 미리 남긴다 ──
  //   선확보분 = RECOVERY_BUDGET_MS(90s) + TERM_MARGIN_MS(30s) = 120s. 상수 정합을 먼저 못 박는다.
  test("선확보 상수 정합: RECOVERY_RESERVE_MS === RECOVERY_BUDGET_MS + TERM_MARGIN_MS(= 120s)", () => {
    expect(RECOVERY_RESERVE_MS).toBe(RECOVERY_BUDGET_MS + TERM_MARGIN_MS);
    expect(RECOVERY_RESERVE_MS).toBe(120_000);
  });

  // (a) 기본 예산(gen=480s)에서 주 세션 supervise 에 전달된 스케줄의 kill_at 은 정확히 잡 kill_at − 120s.
  test("(a) 기본 예산: 주 세션 supervise 스케줄의 kill_at = 잡 kill_at − RECOVERY_RESERVE", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput(),
      makeDeps({ supervise: sup.supervise, readNext: async () => NA_TRANSITIONED }),
    );
    expect(res).toEqual({ ok: true, via: "main", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1);
    expect(sup.calls[0].role).toBe("main");
    expect(sup.calls[0].schedule.killAtMs).toBe(KILL_AT - RECOVERY_RESERVE_MS); // 1_360_000
  });

  // (b) 주 세션이 자기(선확보된) kill_at 까지 예산을 소진 + 산출물 있음 + 미전이 → recovery_budget_insufficient 가
  //     **아니라** 복구 세션이 role="recovery" 로 뜬다. 가짜 시계로 복구 예산 판정 시점(2번째 now)을 mainKillAt 로 전진:
  //     그 시점 잔여(잡 스케줄 기준) = jobKillAt − mainKillAt = RECOVERY_RESERVE(120s) ≥ RECOVERY_BUDGET(90s).
  //     ⚠ 선확보 전이라면 주 세션이 잡 kill_at 까지 다 먹어 이 시점 잔여가 0 → 옛 실패(라이브 실측 29.5s<90s) 재현.
  test("(b) 주 세션이 선확보 kill_at 까지 소진해도 복구가 뜬다(recovery_budget_insufficient 아님 · role=recovery)", async () => {
    const MAIN_KILL_AT = KILL_AT - RECOVERY_RESERVE_MS; // 주 세션 선확보 마감 = 1_360_000
    const sup = makeSupervise([
      { outcome: "exited", exitCode: 0, detail: "" }, // 주
      { outcome: "exited", exitCode: 0, detail: "" }, // 복구
    ]);
    let nowCalls = 0;
    let naCalls = 0;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        // 1번째 now(스폰 여유)=여유 충분 · 2번째 now(복구 예산 판정)=주 세션이 선확보 kill_at 까지 소진한 시각.
        now: () => (nowCalls++ === 0 ? CLAIMED + 1_000 : MAIN_KILL_AT),
        readNext: async () => (naCalls++ === 0 ? NA_STILL_GENERATE : NA_TRANSITIONED),
        artifactPresent: async () => true,
      }),
    );
    expect(res).toEqual({ ok: true, via: "recovery", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(2); // 복구가 실제로 떴다(옛 코드였다면 잔여 0으로 미스폰).
    expect(sup.calls[1].role).toBe("recovery");
  });

  // (c) 복구 세션 supervise 스케줄은 잡 스케줄(kill_at = 잡 kill_at) — 복구 몫이 선확보분을 쓴다. 주 세션은 앞당긴
  //     스케줄, 복구 세션은 전체 스케줄 → 둘은 이제 **다르다**(선확보 이전엔 같았다).
  test("(c) 복구 세션 supervise 스케줄 = 잡 스케줄(kill_at = 잡 kill_at) · 주 세션은 선확보 스케줄", async () => {
    const MAIN_KILL_AT = KILL_AT - RECOVERY_RESERVE_MS;
    const sup = makeSupervise([
      { outcome: "exited", exitCode: 0, detail: "" }, // 주
      { outcome: "exited", exitCode: 0, detail: "" }, // 복구
    ]);
    let nowCalls = 0;
    let naCalls = 0;
    await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        now: () => (nowCalls++ === 0 ? CLAIMED + 1_000 : MAIN_KILL_AT),
        readNext: async () => (naCalls++ === 0 ? NA_STILL_GENERATE : NA_TRANSITIONED),
        artifactPresent: async () => true,
      }),
    );
    expect(sup.calls).toHaveLength(2);
    expect(sup.calls[0].schedule.killAtMs).toBe(MAIN_KILL_AT); // 주 = 선확보(잡 − RESERVE)
    expect(sup.calls[1].schedule.killAtMs).toBe(KILL_AT); // 복구 = 잡 kill_at(전체)
    expect(sup.calls[0].schedule.killAtMs).not.toBe(sup.calls[1].schedule.killAtMs); // 이제 다르다
  });

  // (d) 소예산(gen=100s): 선확보하면 jobKillAt − RESERVE 가 지금(claimed+ε)보다 앞이라 주 세션조차 스폰 여유가 없다
  //     → 폴백. 주 세션 supervise 가 **잡 스케줄**로 돌아(기존 동작 동일) kill_at = 잡 kill_at. 이때 복구는 오늘처럼
  //     예산 부족으로 굶을 수 있음(정직) — 여기선 전이 성공시켜 스케줄 폴백만 확인한다.
  test("(d) 소예산(gen=100s) → 선확보 스폰 여유 부족 → 주 세션이 잡 스케줄로 폴백(기존 동작 동일)", async () => {
    const SMALL_GEN = 100_000; // 100s < RECOVERY_RESERVE(120s) → 선확보 killAt 이 claimed 이전으로 밀린다
    const smallDeadline = CLAIMED + SMALL_GEN + 100_000; // 마감은 예산보다 멀다 → jobKillAt = claimed + gen
    const smallJobKillAt = CLAIMED + SMALL_GEN; // 1_100_000
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput({ genTimeoutMs: SMALL_GEN, deadlineMs: smallDeadline }),
      makeDeps({ supervise: sup.supervise, now: () => CLAIMED + 1_000, readNext: async () => NA_TRANSITIONED }),
    );
    expect(res).toEqual({ ok: true, via: "main", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1);
    expect(sup.calls[0].schedule.killAtMs).toBe(smallJobKillAt); // 폴백 = 잡 스케줄(선확보 아님)
  });

  // (d') 경계 바로 위 예산(gen=151s): 선확보 killAt = claimed+31s 라 스폰 여유(하드킬 −30s)는 통과하지만
  //      termAt(SIGTERM) 까지는 0s — hasSpawnRoom 만으로 폴백을 정하면 주 세션이 뜨자마자 SIGTERM 을 받아
  //      작업 창이 전부 증발한다(외부리뷰 W2R2 P2). 폴백 경계가 'SIGTERM 전 가용 ≥ RECOVERY_BUDGET(90s)' 임을 잠근다.
  test("(d') 경계 예산(gen=151s) → 선확보 termAt 여유 0 → 주 세션이 잡 스케줄로 폴백(즉시-SIGTERM 방지)", async () => {
    const EDGE_GEN = 151_000; // 선확보 killAt = claimed+31s → 스폰 여유 30s 는 통과, termAt 여유는 0s
    const edgeDeadline = CLAIMED + EDGE_GEN + 100_000; // 마감은 예산보다 멀다 → jobKillAt = claimed + gen
    const edgeJobKillAt = CLAIMED + EDGE_GEN;
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput({ genTimeoutMs: EDGE_GEN, deadlineMs: edgeDeadline }),
      makeDeps({ supervise: sup.supervise, now: () => CLAIMED + 1_000, readNext: async () => NA_TRANSITIONED }),
    );
    expect(res).toEqual({ ok: true, via: "main", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(1);
    expect(sup.calls[0].schedule.killAtMs).toBe(edgeJobKillAt); // 폴백 = 잡 스케줄(선확보였다면 claimed+31s)
  });

  // ── S4: role 라벨링 — 러너가 seam 으로 주=main·복구=recovery 를 실어 원장이 세션 역할을 정직하게 라벨링하게 한다 ──
  test("복구 세션은 seam 에 role='recovery' 로 실린다(주 세션은 'main')", async () => {
    const sup = makeSupervise([
      { outcome: "exited", exitCode: 0, detail: "" }, // 주
      { outcome: "exited", exitCode: 0, detail: "" }, // 복구
    ]);
    let naCalls = 0;
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        readNext: async () => (naCalls++ === 0 ? NA_STILL_GENERATE : NA_TRANSITIONED), // 주=전이안됨 → 복구 진입
        artifactPresent: async () => true,
      }),
    );
    expect(res).toEqual({ ok: true, via: "recovery", detail: expect.any(String) });
    expect(sup.calls).toHaveLength(2);
    expect(sup.calls[0].role).toBe("main"); // 주 세션
    expect(sup.calls[1].role).toBe("recovery"); // 복구 세션(원장 감사 라벨)
  });

  // ── S4(MEDIUM): 던지는 now() 도 reject 가 아니라 구조적 config_error(늘 RunJobResult 를 보고한다) ──────────────
  //   선행 라운드가 computeKillSchedule/supervise/artifactPresent 를 가드했으나, now() 두 판정 지점(스폰 여유·복구
  //   예산)은 try/catch 밖에 남아 있었다. now() 가 던지면 runJobSession 이 reject 되던 구멍을 config_error 로 닫는다.
  test("던지는 now()(스폰 여유 판정) → reject 아니라 config_error(스폰 전)", async () => {
    const sup = makeSupervise([]); // 하나라도 호출되면 던진다 — now() 에서 끊겨야 한다.
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        now: () => {
          throw new Error("시계 seam 폭발");
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("config_error");
    expect(sup.calls).toHaveLength(0); // now() 는 스폰 결정 전이라 supervise 미호출.
  });

  test("던지는 now()(복구 예산 판정) → reject 아니라 config_error(주 세션 뒤)", async () => {
    // 주 세션은 정상 스폰·종료돼야 복구 예산 판정의 now() 에 닿는다. 그래서 now() 를 **호출 순번으로** 조종한다:
    //   1번째(스폰 여유)=여유 충분 · 2번째(복구 예산)=던진다. 그러면 복구 예산 지점의 가드가 config_error 로 환원한다.
    let nowCalls = 0;
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]); // 주만(복구 전에 죽는다)
    const res = await runJobSession(
      makeInput(),
      makeDeps({
        supervise: sup.supervise,
        now: () => {
          if (nowCalls++ === 0) return CLAIMED + 1_000; // 스폰 여유 판정 = 충분
          throw new Error("시계 seam 폭발(복구 예산 판정)");
        },
        readNext: async () => NA_STILL_GENERATE, // 전이 안 됨 → 복구 예산 판정으로 진행
        artifactPresent: async () => true, // 산출물 있음 → 복구 예산 판정으로 진행
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("config_error");
    expect(sup.calls).toHaveLength(1); // 복구는 예산 판정(now)에서 죽어 supervise 미호출.
  });

  // ── S4: exhaustive outcome→result 매핑 — 모든 SessionOutcome 이 RunJobResult 로 매핑되고, ok:true 는 **전이됐을
  //   때만** 나온다(unmapped-fallthrough-to-success = 이 재설계가 막는 버그류). 아래 Record 는 **컴파일 타임 exhaustive**
  //   다 — SessionOutcome 이 늘면 키 누락으로 이 파일이 컴파일 실패해 표를 갱신하게 강제한다. ─────────────────────
  type OutcomeExpect =
    | { transitionalSuccess: true } // exited/killed — 전이되면 ok:true(via:main), 아니면 실패로 떨어진다.
    | { transitionalSuccess: false; reason: RunJobFailReason }; // 그 외 — 전이 관측과 무관하게 즉시 실패.
  const MAIN_OUTCOME_MAP: Record<SessionOutcome, OutcomeExpect> = {
    exited: { transitionalSuccess: true },
    killed: { transitionalSuccess: true },
    reap_failed: { transitionalSuccess: false, reason: "reap_failed" },
    refused: { transitionalSuccess: false, reason: "refused_insufficient_time" },
    spawn_failed: { transitionalSuccess: false, reason: "spawn_failed" },
    ledger_unwritable: { transitionalSuccess: false, reason: "ledger_unwritable" },
    output_cap: { transitionalSuccess: false, reason: "output_cap" },
  };

  for (const [outcome, expected] of Object.entries(MAIN_OUTCOME_MAP) as Array<[SessionOutcome, OutcomeExpect]>) {
    test(`주 세션 outcome=${outcome} → 전이 관측 하에서도 계약대로 매핑(exhaustive)`, async () => {
      const sup = makeSupervise([{ outcome, exitCode: null, detail: `outcome=${outcome}` }]);
      const res = await runJobSession(
        makeInput(),
        // 전이가 **보이는** 상태로 고정(readNext=전이됨) — 그래도 실패 outcome 은 성공으로 새면 안 된다.
        makeDeps({ supervise: sup.supervise, readNext: async () => NA_TRANSITIONED, artifactPresent: async () => true }),
      );
      if (expected.transitionalSuccess) {
        // exited/killed + 전이 관측 = 유일하게 ok:true 가 정당한 경우.
        expect(res).toEqual({ ok: true, via: "main", detail: expect.any(String) });
      } else {
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe(expected.reason);
      }
    });
  }

  test("ok:true 는 오직 전이된 런에서만 — exited 라도 전이 안 되고 산출물 없으면 실패(성공 오판 금지)", async () => {
    const sup = makeSupervise([{ outcome: "exited", exitCode: 0, detail: "" }]);
    const res = await runJobSession(
      makeInput(),
      // 세션은 깨끗이 종료(exited)했지만 전이 안 됨 + 산출물 없음 → 성공이 아니다.
      makeDeps({ supervise: sup.supervise, readNext: async () => NA_STILL_GENERATE, artifactPresent: async () => false }),
    );
    expect(res).toEqual({ ok: false, reason: "not_transitioned_no_artifact", detail: expect.any(String) });
  });
});
