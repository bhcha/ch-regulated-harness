import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
// 동기 fs — 주입된 now() 안에서 남의 클레임(rename)을 끼워 넣기 위해서다(now 는 number 를 돌려주므로 await 불가).
import { mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSdkGenExecutor,
  BridgeGenExecutor,
  GenerationInProgressError,
  StubDirectGenExecutor,
  selectGenExecutor,
} from "../../src/kernel/gen-executor.js";
import {
  JOB_PROTOCOL_VERSION,
  buildGenerateJob,
  claimJob,
  readJobFile,
  writePendingJob,
} from "../../src/kernel/job-protocol.js";
import type { HarnessResult } from "../../src/kernel/harness-cli.js";
import type { NextAction } from "../../src/types/contract.js";
import type { GenerateJobFile } from "../../src/types/jobs.js";
import type { AguiEvent } from "../../src/types/a2ui.js";

const okResult: HarnessResult = { code: 0, stdout: "ok", stderr: "" };

function na(step: string, stage: string | null = null): NextAction {
  // 최소 필드만 채운 next-action(테스트에서 step·stage 만 관심 — 전이 판정은 둘을 함께 본다).
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

describe("StubDirectGenExecutor", () => {
  it("오프라인이면 runStage 를 직접 호출(성공)", async () => {
    const calls: Array<[string, string]> = [];
    const gen = new StubDirectGenExecutor({
      offline: () => true,
      runStage: (stage, rid) => {
        calls.push([stage, rid]);
        return okResult;
      },
    });
    await gen.execute("run-1", "guideline");
    expect(calls).toEqual([["guideline", "run-1"]]);
  });

  it("온라인이면 직접 spawn 금지(throw)", async () => {
    const gen = new StubDirectGenExecutor({ offline: () => false, runStage: () => okResult });
    await expect(gen.execute("run-1", "brief")).rejects.toThrow();
  });

  it("runStage 비-0 이면 실패로 throw", async () => {
    const gen = new StubDirectGenExecutor({
      offline: () => true,
      runStage: () => ({ code: 2, stdout: "", stderr: "boom" }),
    });
    await expect(gen.execute("run-1", "brief")).rejects.toThrow(/boom|실패/);
  });
});

describe("BridgeGenExecutor", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-bridge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

  it("pending 잡 파일을 기록하고(대기 중 존재), 전이 감지 시 정리 후 resolve(셸 spawn 0)", async () => {
    let calls = 0;
    let existedDuringPoll = false;
    const file = join(dir, "run-9-brief.json");
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 10,
      timeoutMs: 10_000,
      sleep: async () => {},
      readNext: async () => {
        calls++;
        if (calls === 1) return na("generate", "brief"); // check-first: brief 생성 대기 → pending 기록
        existedDuringPoll = await exists(file); // 생성 대기 중엔 pending 파일이 있어야(운영자 소비 대상)
        return na("human"); // 전이 → 정리 후 반환
      },
    });
    await gen.execute("run-9", "brief");
    expect(existedDuringPoll).toBe(true); // 대기 중 pending 파일 존재
    expect(await exists(file)).toBe(false); // 전이 후 정리됨(stale 방지)
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("이미 전이된 run(중복 클릭)은 pending 파일을 쓰지 않는다(멱등 · stale 방지)", async () => {
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      sleep: async () => {},
      readNext: async () => na("human"), // 이미 전이됨
    });
    await gen.execute("run-dup", "brief");
    expect(await exists(join(dir, "run-dup-brief.json"))).toBe(false); // 파일 미기록
  });

  it("run 이 이미 다음 단계(concept) 생성으로 진행했으면 stale brief 요청은 파일 안 씀", async () => {
    // step=generate 이지만 stage=concept → brief 요청은 더 이상 현재 대상 아님(전역 step 만 보면 오판).
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      sleep: async () => {},
      readNext: async () => na("generate", "concept"),
    });
    await gen.execute("run-stale", "brief");
    expect(await exists(join(dir, "run-stale-brief.json"))).toBe(false);
  });

  it("경로 탈출 run_id/stage 는 거부(pending 파일명 traversal 차단)", async () => {
    const gen = new BridgeGenExecutor({ jobsPendingDir: dir, sleep: async () => {}, readNext: async () => na("human") });
    await expect(gen.execute("../evil", "brief")).rejects.toThrow(/안전하지 않/);
    await expect(gen.execute("run-1", "../x")).rejects.toThrow(/안전하지 않/);
  });

  it("적재하는 잡은 프로토콜 v2 형식(expires_at = 적재시각 + timeoutMs · 봇 폴링 마감과 같은 값)", async () => {
    const T0 = 1_700_000_000_000;
    let seen: Awaited<ReturnType<typeof readJobFile>> = null;
    let calls = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 10,
      timeoutMs: 900_000,
      now: () => T0, // 시계 고정 — 마감 계산이 결정적이어야 한다
      sleep: async () => {},
      readNext: async () => {
        calls++;
        if (calls === 1) return na("generate", "brief"); // check-first
        seen = await readJobFile(join(dir, "run-9-brief.json")); // 대기 중 잡 파일 포착
        return na("human"); // 전이 → 정리
      },
    });
    await gen.execute("run-9", "brief");
    expect(seen).toMatchObject({
      version: JOB_PROTOCOL_VERSION,
      kind: "generate",
      run_id: "run-9",
      stage: "brief",
      enqueued_at: new Date(T0).toISOString(),
      expires_at: new Date(T0 + 900_000).toISOString(), // = 봇의 폴링 마감(이중 시계 금지)
    });
    expect(typeof seen!.job_id).toBe("string");
  });

  it("전이가 없으면 타임아웃 Error(무한 대기 금지) + 아직 pending 인 자기 잡을 회수(프로토콜 v2)", async () => {
    let clock = 1000;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 50,
      timeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readNext: async () => na("generate", "brief"), // 계속 brief generate(아무도 처리 안 함) → 타임아웃
    });
    await expect(gen.execute("run-x", "brief")).rejects.toThrow(/시간 초과|거둬들였/);
    // ⚠ v1 과 바뀐 지점: 타임아웃 = 회수. 잡을 남기면 봇이 포기한 뒤 소비자가 뒤늦게 집어 '봇 몰래' 되살린다.
    expect(await readdir(dir)).toEqual([]);
  });

  it("타임아웃 시 소비자가 이미 집어 갔으면(파일 없음) 회수 실패 — 그래도 실패로 끝난다(늦은 성공은 화해 버튼 몫)", async () => {
    let clock = 1000;
    let polls = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 50,
      timeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readNext: async () => {
        // 첫 폴링 뒤 소비자가 클레임(=pending 에서 사라짐)을 흉내 — 이후 봇 타임아웃.
        if (++polls === 2) await rm(join(dir, "run-c-brief.json"), { force: true });
        return na("generate", "brief");
      },
    });
    await expect(gen.execute("run-c", "brief")).rejects.toThrow(/회수하지 못했/);
  });

  it("타임아웃 시 같은 단계의 '새 잡'(job_id 다름)은 회수하지 않는다 — 남의 요청 증발 금지", async () => {
    let clock = 1000;
    let polls = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 50,
      timeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readNext: async () => {
        // 대기 중 같은 rid·stage 로 새 잡이 다시 적재된 상황(우리 잡을 덮어씀).
        if (++polls === 2) {
          await writePendingJob(dir, {
            version: JOB_PROTOCOL_VERSION,
            kind: "generate",
            run_id: "run-n",
            stage: "brief",
            job_id: "다른-잡",
            expires_at: new Date(9_999_999_999_999).toISOString(),
          });
        }
        return na("generate", "brief");
      },
    });
    await expect(gen.execute("run-n", "brief")).rejects.toThrow(/시간 초과|회수하지 못했/);
    const left = await readJobFile(join(dir, "run-n-brief.json"));
    expect(left?.job_id).toBe("다른-잡"); // 새 잡은 그대로 — 소비자가 이어서 집을 수 있다
  });
});

/**
 * 이중 소비 구멍의 회귀 가드 — 시나리오: 소비자 C1 이 잡을 집고 느리게 일하는 동안 봇이 대기 상한에 포기한다.
 *   회수는 `pending/` 만 보므로 실패하고(잡은 claimed/ 에 있다), core 는 그대로 생성 차례라 사람에게 [다시 만들기]가
 *   뜬다. 그 클릭이 **새 잡**을 적재하면 C2 가 집어 C1 과 같은 런을 동시에 쓴다(이중 소비 · 이중 과금).
 *   막는 자리는 **적재 그 자체**다(enqueueJob 의 원자 대체) — 아래는 그 차단이 실행기까지 이어져 있음을 못 박는다.
 *   판정 규칙(마감 남음/지남/미기재·조회 실패)의 근거는 job-protocol 주석이 SSoT 이고, 여기서는 그 결과가 사람에게
 *   가는 문구·적재 여부로 옳게 번역되는지만 본다.
 */
describe("BridgeGenExecutor — 이중 소비 차단(적재가 곧 검사)", () => {
  const T0 = 1_700_000_000_000;
  const TIMEOUT = 900_000;
  let root: string;
  let pendingDir: string;
  let claimedDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chat-bridge-dup-"));
    pendingDir = join(root, "pending");
    claimedDir = join(root, "claimed");
    await mkdir(pendingDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** v2 잡 1건(적재 T0 · 마감 T0+900초). over 로 마감·rid·stage 를 갈아끼운다. */
  function job(over: Partial<GenerateJobFile> = {}): GenerateJobFile {
    return {
      ...buildGenerateJob({ run_id: "run-1", stage: "brief", enqueuedAtMs: T0, timeoutMs: TIMEOUT }),
      ...over,
    };
  }
  /** 그 잡을 소비자가 집은 상태로 만든다(= claimed/<consumer>/<rid>-<stage>.json). */
  async function claim(j: GenerateJobFile = job(), consumer = "c1"): Promise<void> {
    await writePendingJob(pendingDir, j);
    await claimJob({ pending: pendingDir, claimed: claimedDir, failed: join(root, "failed") }, j, consumer);
    await rm(join(pendingDir, "run-1-brief.json"), { force: true }); // 집혔으니 대기줄엔 없다(잔재 정리)
  }

  /**
   * 결함 재현 조건의 봇 + **적재 감시**. core 는 아직 brief 생성 차례라(C1 이 전이시키기 전) check-first 를 통과해
   *   적재까지 갈 수 있는 상태다 — 차단이 없으면 여기서 두 번째 잡이 적재된다.
   *
   * ⚠ 폴링 2회차에 대기줄을 들여다본 뒤 **전이를 알려 execute 를 끝낸다**(시계는 T0 고정). 차단이 사라지면 이
   *   테스트들은 '적재된 잡을 봤고 execute 가 성공했다'로 **빠르게** 실패한다 — 마감까지 폴링을 돌려 무한 대기(행)로
   *   빠지지 않는다. 회귀 가드는 멈추지 않고 실패해야 쓸모가 있다.
   * @returns enqueued() = 대기줄에서 관측된 잡(적재된 적 없으면 null · 봇의 타임아웃 회수에 지워지기 전 값).
   */
  function watchingBridge(): { gen: BridgeGenExecutor; enqueued: () => GenerateJobFile | null } {
    let seen: GenerateJobFile | null = null;
    let calls = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: pendingDir,
      jobsClaimedDir: claimedDir,
      pollIntervalMs: 10,
      timeoutMs: TIMEOUT,
      now: () => T0,
      sleep: async () => {},
      readNext: async () => {
        if (++calls === 1) return na("generate", "brief"); // check-first: 아직 brief 생성 차례
        seen = await readJobFile(join(pendingDir, "run-1-brief.json")); // 적재됐나(= C2 가 집을 것이 있나)
        return na("human"); // 전이 → execute 종료
      },
    });
    return { gen, enqueued: () => seen };
  }

  it("★ 마감이 남은 클레임이 있으면 적재하지 않는다 — 사람에겐 '만들고 있다'고 사실대로 알린다", async () => {
    await claim(); // C1 이 집어 작업 중(마감 T0+900초 · 지금 T0)
    const { gen, enqueued } = watchingBridge();
    const err = await gen.execute("run-1", "brief").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerationInProgressError);
    expect((err as Error).message).toBe("이미 만들고 있어요 — 잠시 후 다시 확인해 주세요.");
    // ★ 핵심 단정: 새 잡이 **한 번도** 있은 적 없어야 C2 가 집을 것이 없다(이중 소비의 원천 차단).
    expect(enqueued()).toBeNull();
    expect(await readdir(pendingDir)).toEqual([]);
  });

  it("★ 마감이 지난 클레임은 적재를 막지 않는다(죽은 클레임 하나가 런을 영영 묶으면 안 된다)", async () => {
    await claim(job({ expires_at: new Date(T0 - 1).toISOString() }));
    const { gen, enqueued } = watchingBridge();
    await gen.execute("run-1", "brief");
    expect(enqueued()).toMatchObject({ run_id: "run-1", stage: "brief" }); // 새 요청이 실제로 적재됐다
  });

  it("★ 아무도 안 집은 옛 잡은 대체한다 — 대기줄엔 새 job_id 의 잡 1건(정책 불변 · 기전만 바뀌었다)", async () => {
    await writePendingJob(pendingDir, job({ job_id: "옛-잡" })); // 봇 재기동 등으로 남은 옛 요청
    const { gen, enqueued } = watchingBridge();
    await gen.execute("run-1", "brief");
    expect(enqueued()?.job_id).not.toBe("옛-잡"); // 더 신선한 요청으로 승격됐다
    expect(await readdir(pendingDir)).toEqual([]); // 전이 뒤 정리까지 — 잡이 쌓이지 않는다
  });

  it("★ 마감 없는 클레임(v1 레거시)은 막는다 — fail-closed(사람이 손으로 소비 중일 수 있다)", async () => {
    await claim({ kind: "generate", run_id: "run-1", stage: "brief" }); // v1: expires_at 없음
    const { gen, enqueued } = watchingBridge();
    await expect(gen.execute("run-1", "brief")).rejects.toThrow(GenerationInProgressError);
    expect(enqueued()).toBeNull();
  });

  it("다른 run 의 클레임은 막지 않는다(적재 진행)", async () => {
    await claim(job({ run_id: "run-2" }));
    const { gen, enqueued } = watchingBridge();
    await gen.execute("run-1", "brief");
    expect(enqueued()).toMatchObject({ run_id: "run-1", stage: "brief" });
  });

  it("같은 run 이라도 다른 stage(concept)의 클레임은 brief 요청을 막지 않는다", async () => {
    await claim(job({ stage: "concept" }));
    const { gen, enqueued } = watchingBridge();
    await gen.execute("run-1", "brief");
    expect(enqueued()).toMatchObject({ run_id: "run-1", stage: "brief" });
  });

  it("claimed/ 가 아예 없으면(ENOENT) 평소대로 적재한다 — 클레임 없음은 정상 상태다", async () => {
    const { gen, enqueued } = watchingBridge(); // claimed/ 미생성 상태 그대로
    await gen.execute("run-1", "brief");
    expect(enqueued()).toMatchObject({ run_id: "run-1", stage: "brief" });
  });

  it("★ 판단 불가(권한·IO)면 막는다(fail-closed) — 단 '만들고 있다'고 단정하지는 않는다", async () => {
    // 잡 파일 자리에 디렉터리 → EISDIR('없음'도 '깨짐'도 아닌 fs 오류의 대역). 모르면 적재하지 않는다.
    await mkdir(join(claimedDir, "c1", "run-1-brief.json"), { recursive: true });
    const { gen, enqueued } = watchingBridge();
    await expect(gen.execute("run-1", "brief")).rejects.toThrow("지금 상태를 확인하지 못했어요 — 잠시 후 다시 확인해 주세요.");
    expect(enqueued()).toBeNull();
  });

  it("이미 전이됐으면 클레임이 살아 있어도 조용한 no-op(다 끝난 일에 '만들고 있어요'라고 답하지 않는다)", async () => {
    await claim(); // C1 이 늦게 성공하고 클레임을 아직 안 지운 창
    const gen = new BridgeGenExecutor({
      jobsPendingDir: pendingDir,
      jobsClaimedDir: claimedDir,
      now: () => T0,
      sleep: async () => {},
      readNext: async () => na("human"), // 이미 전이됨
    });
    await expect(gen.execute("run-1", "brief")).resolves.toBeUndefined();
    expect(await readdir(pendingDir)).toEqual([]);
  });
});

/**
 * ★ 적재 원자성 회귀 가드(펜스 1) — 옛 설계(check → write → re-check → 보상)가 못 막던 순서:
 *     ㉠ 아무도 안 집은 **옛 잡**이 pending/X 에 남아 있다(봇 재기동 · 회수 못 한 옛 요청)
 *     ㉡ 검사 → claimed/ 가 비어 통과   ㉢ C1 이 그 옛 잡을 집는다(검사와 적재 사이)
 *     ㉣ 봇이 pending/X 를 덮어써 새 잡을 넣는다   ㉤ C2 가 그 새 잡을 집는다 → C1·C2 가 동시에 같은 단계를 만든다
 *   지금 설계는 창을 좁히는 대신 **㉢의 전제를 없앤다**: 적재 1단계 `unlink(pending/X)` 가 옛 잡을 원자적으로 내리므로
 *   ㉢은 ㉮'unlink 전에 이미 성공'(→ claimed/ 에 보여 막힌다) 또는 ㉯'unlink 뒤 시도'(→ ENOENT 로 빈손) 둘뿐이다.
 *   아래 두 테스트가 그 ㉮·㉯를 각각 못 박는다.
 */
describe("BridgeGenExecutor — 적재 원자성(원자 대체 · 펜스 1)", () => {
  const T0 = 1_700_000_000_000;
  const TIMEOUT = 900_000;
  const NAME = "run-1-brief.json";
  let root: string;
  let pendingDir: string;
  let claimedDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chat-bridge-race-"));
    pendingDir = join(root, "pending");
    claimedDir = join(root, "claimed");
    await mkdir(pendingDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** ㉠의 옛 잡 — 봇의 이번 요청보다 먼저 적재됐고(T0-1000) 마감은 아직 남았다(T0 기준 산 잡). */
  const oldJob = (): GenerateJobFile => ({
    ...buildGenerateJob({ run_id: "run-1", stage: "brief", enqueuedAtMs: T0 - 1000, timeoutMs: TIMEOUT }),
    job_id: "옛-잡",
  });

  /** 소비자가 지금 대기줄의 잡을 집는다(= 프로토콜의 클레임 = rename). **동기**여야 한다 — now() 안에서 부른다. */
  function claimSync(consumer: string): void {
    mkdirSync(join(claimedDir, consumer), { recursive: true });
    renameSync(join(pendingDir, NAME), join(claimedDir, consumer, NAME));
  }

  /**
   * 결함 재현용 봇 + 적재 감시. **주입된 시계가 이 경합의 이음새다**(프로덕션에 테스트 전용 구멍을 뚫지 않는다):
   *   execute → enqueueJob 안에서 now() 는 ① 잡 조립(= 적재 시각 · **unlink 전**) → ② 산 클레임 조회 인자
   *   (= 1단계 unlink 가 **끝난 뒤**) 순으로 불린다. 즉 onTick 의 call 2 는 정확히 '옛 잡을 내린 직후'라, 그 순간
   *   남의 클레임을 끼워 넣으면 ㉯(unlink 뒤 시도 → ENOENT)를 그대로 관측할 수 있다.
   *   ⚠ 이 이음새는 enqueueJob 의 now() 호출 순서에 기댄다(잡 조립 → 조회). 그 순서를 바꾸면 이 테스트도 같이 본다.
   *
   * ⚠ readNext 는 2회차부터 **전이**를 알린다(시계는 T0 고정) — 펜스가 사라지면 이 테스트들은 '적재된 잡을 봤고
   *   execute 가 그냥 끝났다'로 **밀리초 안에** 실패한다. 고정 시계로 폴링에 맡기면 마감이 영영 오지 않아 CI 가
   *   멈춘다(행) — 회귀 가드는 멈추지 말고 실패해야 쓸모가 있다.
   * @returns enqueued() = 폴링 중 대기줄에서 관측된 잡(= C2 가 집을 수 있었던 것 · 없으면 null).
   */
  function raceBridge(onTick: (call: number) => void): { gen: BridgeGenExecutor; enqueued: () => GenerateJobFile | null } {
    let seen: GenerateJobFile | null = null;
    let polls = 0;
    let ticks = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: pendingDir,
      jobsClaimedDir: claimedDir,
      pollIntervalMs: 10,
      timeoutMs: TIMEOUT,
      now: () => {
        onTick(++ticks);
        return T0;
      },
      sleep: async () => {},
      readNext: async () => {
        if (++polls === 1) return na("generate", "brief"); // check-first: 아직 brief 생성 차례
        seen = await readJobFile(join(pendingDir, NAME)); // 적재된 채 남았나(= C2 가 집을 것이 있나)
        return na("human"); // 전이 → execute 종료(행 방지)
      },
    });
    return { gen, enqueued: () => seen };
  }

  it("★★ ㉯ 적재 1단계(unlink) **뒤엔 옛 잡을 집을 수 없다** — 옛 결함의 창이 전제부터 사라졌다", async () => {
    // 옛 설계에서 C1 이 끼어들던 바로 그 순간(검사 통과 직후·적재 직전)에 클레임을 시도시킨다. 지금은 그 시점에
    //   옛 잡이 이미 내려가 있어(1단계 unlink) C1 은 **빈손으로 진다**(ENOENT = 프로토콜상 정상 패배).
    await writePendingJob(pendingDir, oldJob()); // ㉠ 아무도 안 집은 옛 잡이 대기줄에 남아 있다
    let claimFailed = false;
    const { gen, enqueued } = raceBridge((call) => {
      if (call === 2) {
        // call 2 = unlink 와 산 클레임 조회 사이.
        try {
          claimSync("c1");
        } catch {
          claimFailed = true; // rename 이 ENOENT — 집을 물건이 없다
        }
      }
    });
    await gen.execute("run-1", "brief");
    // ★ 핵심 단정 ①: C1 은 옛 잡을 집지 못했다 → 'C1 이 옛 잡을, C2 가 새 잡을' 이라는 결말의 첫 걸음이 없다.
    expect(claimFailed).toBe(true);
    expect(await readdir(join(claimedDir, "c1")).catch(() => [])).toEqual([]);
    // ★ 핵심 단정 ②: 대기줄엔 우리 잡 **하나만** 있다(옛 잡은 대체됐다 — 중복이 쌓이지 않는다).
    expect(enqueued()).toMatchObject({ run_id: "run-1", stage: "brief" });
    expect(enqueued()?.job_id).not.toBe("옛-잡");
  });

  it("★★ ㉮ unlink **전에** 이미 집혔으면 그 클레임이 보여 막는다 — 적재 없음(이중 소비의 원천 차단)", async () => {
    // ㉮ 쪽 가지: C1 의 클레임이 적재보다 먼저 성립했다면 그것은 claimed/ 에 내구적으로 보인다(2단계 조회).
    await writePendingJob(pendingDir, oldJob());
    mkdirSync(join(claimedDir, "c1"), { recursive: true });
    renameSync(join(pendingDir, NAME), join(claimedDir, "c1", NAME)); // C1 이 옛 잡을 집었다(적재 시도 전)
    const { gen, enqueued } = raceBridge(() => {});
    const err = await gen.execute("run-1", "brief").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerationInProgressError);
    expect((err as Error).message).toBe("이미 만들고 있어요 — 잠시 후 다시 확인해 주세요.");
    // ★ 핵심 단정: 새 잡이 **한 번도** 있은 적 없다 → C2 가 집을 것이 없다.
    expect(enqueued()).toBeNull();
    expect(await readdir(pendingDir)).toEqual([]);
    expect((await readJobFile(join(claimedDir, "c1", NAME)))?.job_id).toBe("옛-잡"); // C1 의 잡은 무사
  });
});

describe("AgentSdkGenExecutor (S-1 · 무인 · live-only 미검증)", () => {
  it("sdkGenerate 미주입이면 실행 시 fail-closed(S-1 미배선)", async () => {
    const gen = new AgentSdkGenExecutor({ readNext: async () => na("generate", "brief") });
    await expect(gen.execute("run-x", "brief")).rejects.toThrow(/배선|S-1/);
  });

  it("sdkGenerate 성공 + 전이 확인되면 완료", async () => {
    const calls: Array<[string, string]> = [];
    let after = false;
    const gen = new AgentSdkGenExecutor({
      sdkGenerate: async (rid, stage) => {
        calls.push([rid, stage]);
        after = true; // 생성 뒤 전이됨(step 이 generate 를 벗어남)
      },
      readNext: async () => (after ? na("human") : na("generate", "brief")),
    });
    await gen.execute("run-x", "brief");
    expect(calls).toEqual([["run-x", "brief"]]);
  });

  it("sdkGenerate 뒤에도 전이 미확인이면 실패(세션 워커가 전이 못 시킴)", async () => {
    const gen = new AgentSdkGenExecutor({
      sdkGenerate: async () => {}, // 아무 것도 전이 안 함
      readNext: async () => na("generate", "brief"), // 계속 brief generate
    });
    await expect(gen.execute("run-x", "brief")).rejects.toThrow(/전이 미확인/);
  });

  it("이미 전이돼 있으면(중복) sdkGenerate 호출 없이 즉시 반환", async () => {
    let called = false;
    const gen = new AgentSdkGenExecutor({
      sdkGenerate: async () => {
        called = true;
      },
      readNext: async () => na("human"), // 이미 다음 게이트
    });
    await gen.execute("run-x", "brief");
    expect(called).toBe(false);
  });
});

describe("selectGenExecutor — 기본 C2 유지 · S-1 는 플래그+SDK 둘 다 있을 때만", () => {
  it("오프라인 → StubDirectGenExecutor", () => {
    expect(selectGenExecutor({ offline: () => true })).toBeInstanceOf(StubDirectGenExecutor);
  });
  it("온라인 + S-1 off → BridgeGenExecutor(C2 기본)", () => {
    expect(selectGenExecutor({ offline: () => false, unmannedS1: () => false })).toBeInstanceOf(BridgeGenExecutor);
  });
  it("온라인 + S-1 on 이지만 sdkGenerate 미배선 → BridgeGenExecutor 폴백", () => {
    expect(selectGenExecutor({ offline: () => false, unmannedS1: () => true })).toBeInstanceOf(BridgeGenExecutor);
  });
  it("온라인 + S-1 on + sdkGenerate 배선 → AgentSdkGenExecutor", () => {
    const gen = selectGenExecutor({ offline: () => false, unmannedS1: () => true, sdkGenerate: async () => {} });
    expect(gen).toBeInstanceOf(AgentSdkGenExecutor);
  });
  it("onProgress 를 넘겨도 온라인 기본은 여전히 BridgeGenExecutor(진행 표시는 브리지 전용)", () => {
    const gen = selectGenExecutor({ offline: () => false, unmannedS1: () => false, onProgress: () => {} });
    expect(gen).toBeInstanceOf(BridgeGenExecutor);
  });
});

/**
 * 진행 표시 side-channel(dev-loop Stage 3) — **표시 전용**이지 전이 신호가 아니다. 회귀 가드의 핵심:
 *   ① onProgress 미주입이면 진행 로직 자체가 no-op(readEvents 미호출) → 현행 동작 완전 동일(진행 emit 0).
 *   ② 주입 시 새 이벤트마다 emit + throttle 로 과다 spawn 억제 + dedupe(같은 이벤트 재emit 안 함).
 *   ③ 진행 표시의 어떤 실패(readEvents throw · onProgress throw)도 루프·전이·마감에 영향 0(best-effort 흡수).
 *   ④ 전이/마감 판정은 진행 로직과 무관하게 동일(진행이 있어도 전이 없으면 타임아웃 그대로).
 */
describe("BridgeGenExecutor — 진행 표시 side-channel", () => {
  let dir: string;
  let clock: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-bridge-prog-"));
    clock = 100_000; // 첫 emit 이 throttle(15s)을 통과하도록 충분히 큰 시작값
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** N 회 generate 를 돌려주고(check-first 1 + loop) 그 뒤 human(전이)로 종료하는 readNext. */
  const genThenHuman = (generateCalls: number): (() => Promise<NextAction>) => {
    let calls = 0;
    return async () => {
      calls++;
      return calls <= generateCalls ? na("generate", "brief") : na("human");
    };
  };
  const stepEvent = (name: string, ts: string): AguiEvent => ({ type: "StepStarted", stepName: name, timestamp: ts });

  it("① onProgress 미주입 → 진행 로직 no-op(readEvents 미호출 · 현행 동작 동일)", async () => {
    let readEventsCalls = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000,
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => {
        readEventsCalls++;
        return [];
      },
      // onProgress 미주입
      readNext: genThenHuman(4),
    });
    await gen.execute("run-p1", "brief");
    expect(readEventsCalls).toBe(0); // 진행 로직 자체가 안 돈다(no-op)
  });

  it("② 새 이벤트마다 emit(throttle 통과 시) — 내부 스텝명 비노출 평이 문구", async () => {
    const emitted: string[] = [];
    let n = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000, // > 15s throttle → 매 폴링 통과
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => {
        n++;
        return [stepEvent("phase:0" + n, "2026-01-01T00:00:0" + n + ".000Z")]; // 매번 새 kind+ts
      },
      onProgress: async (_rid, msg) => void emitted.push(msg),
      readNext: genThenHuman(4), // check-first + 3 loop iters(emit) + human
    });
    await gen.execute("run-p2", "brief");
    expect(emitted).toHaveLength(3);
    for (const m of emitted) expect(m).not.toMatch(/phase|generate|brief/); // 내부 스텝명 미노출
  });

  it("② throttle — progressMinIntervalMs 안 지나면 readEvents spawn 도 스킵", async () => {
    const emitted: string[] = [];
    let readEventsCalls = 0;
    let n = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 5_000, // < 15s throttle → 첫 emit 뒤 폴링들은 스킵
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => {
        readEventsCalls++;
        n++;
        return [stepEvent("phase:0" + n, "2026-01-01T00:00:0" + n + ".000Z")];
      },
      onProgress: async (_rid, msg) => void emitted.push(msg),
      readNext: genThenHuman(4), // 3 loop iters, 간격 5s
    });
    await gen.execute("run-p3", "brief");
    expect(emitted).toHaveLength(1); // 첫 폴링만 emit(나머지는 throttle)
    expect(readEventsCalls).toBe(1); // throttle 이 spawn 자체를 막는다(과부하 방지)
  });

  it("② dedupe — 같은 이벤트(kind)면 재emit 안 함(ts 흔들려도)", async () => {
    const emitted: string[] = [];
    let n = 0;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000, // throttle 통과
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => {
        n++;
        // 같은 stepName(=같은 kind)인데 ts 만 흔들림(fallback 재파생 모사) → kind dedupe 로 억제돼야 한다.
        return [stepEvent("generate:01-brief", "2026-01-01T00:00:0" + n + ".000Z")];
      },
      onProgress: async (_rid, msg) => void emitted.push(msg),
      readNext: genThenHuman(4),
    });
    await gen.execute("run-p4", "brief");
    expect(emitted).toHaveLength(1); // 같은 kind → 첫 1회만
  });

  it("③ readEvents throw 흡수 → 루프·전이 무영향(정상 완주)", async () => {
    const emitted: string[] = [];
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000,
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => {
        throw new Error("agui boom");
      },
      onProgress: async (_rid, msg) => void emitted.push(msg),
      readNext: genThenHuman(4),
    });
    await expect(gen.execute("run-p5", "brief")).resolves.toBeUndefined(); // 전이까지 정상
    expect(emitted).toEqual([]); // 읽기 실패라 emit 없음
  });

  it("③ onProgress throw 흡수 → 루프·전이 무영향(정상 완주)", async () => {
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000,
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => [stepEvent("phase:02-concept", "2026-01-01T00:00:01.000Z")],
      onProgress: async () => {
        throw new Error("render boom");
      },
      readNext: genThenHuman(4),
    });
    await expect(gen.execute("run-p6", "brief")).resolves.toBeUndefined(); // onProgress 예외가 루프를 깨지 않는다
  });

  it("④ 진행 표시가 있어도 전이 없으면 타임아웃(마감 판정 불변)", async () => {
    let clk = 1000;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 50,
      timeoutMs: 100,
      now: () => clk,
      sleep: async (ms) => {
        clk += ms;
      },
      readEvents: async () => [stepEvent("generate:01-brief", "2026-01-01T00:00:01.000Z")],
      onProgress: async () => {},
      readNext: async () => na("generate", "brief"), // 아무도 처리 안 함 → 타임아웃
    });
    await expect(gen.execute("run-p7", "brief")).rejects.toThrow(/시간 초과|거둬들였/);
    expect(await readdir(dir)).toEqual([]); // 타임아웃 회수까지 동일(진행 표시가 회수를 방해하지 않는다)
  });

  // ⑤ 진행 커서는 **run_id 별**로 독립이어야 한다(하나의 실행기 인스턴스가 공유되고 JobQueue 는 다른 run 을 동시
  //    처리 = run별 FIFO). 커서가 인스턴스-전역이면 한 run 의 dedupe(ts/kind)·throttle 상태가 다른 run 을 억제한다.
  //    아래 두 테스트는 두 run 이 **같은 이벤트(kind+ts)** 를 볼 때 각자 1회씩 emit 하는지로 격리를 고정한다
  //    (전역 커서였다면 두 번째 run 이 dedupe 로 0회 = 회귀 신호).
  it("⑤ 순차 실행 — 같은 인스턴스라도 run 별 커서 독립(두 번째 run 이 첫 run 때문에 억제되지 않음)", async () => {
    const byRid: Record<string, string[]> = {};
    const calls = new Map<string, number>();
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000, // > 15s throttle → 매 폴링 통과
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      // 두 run 모두 '같은' 이벤트(kind+ts) — 커서가 전역이면 두 번째 run 이 dedupe(ts 비-신선/kind 동일)로 억제된다.
      readEvents: async () => [stepEvent("shared-step", "2026-01-01T00:00:01.000Z")],
      onProgress: async (rid, msg) => void (byRid[rid] ??= []).push(msg),
      readNext: async (rid) => {
        const c = (calls.get(rid) ?? 0) + 1;
        calls.set(rid, c);
        return c <= 2 ? na("generate", "brief") : na("human"); // check-first + 1 loop emit + human
      },
    });
    await gen.execute("run-iso-A", "brief");
    await gen.execute("run-iso-B", "brief"); // 같은 인스턴스·같은 이벤트 — 전역 커서였다면 여기서 0회 emit
    expect(byRid["run-iso-A"]).toHaveLength(1);
    expect(byRid["run-iso-B"]).toHaveLength(1); // 회귀 가드: run별 커서라 B 도 emit(전역이면 dedupe 로 0)
  });

  it("⑤ 동시 실행(Promise.all) — 두 run 이 서로의 throttle/dedupe 를 오염시키지 않음", async () => {
    const byRid: Record<string, number> = {};
    const calls = new Map<string, number>();
    let clk = 100_000;
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 100_000, // >> throttle → throttle 타이밍과 무관하게 dedupe 격리만 관측
      timeoutMs: 10_000_000,
      now: () => clk,
      sleep: async (ms) => {
        clk += ms;
      },
      readEvents: async () => [stepEvent("shared-step", "2026-01-01T00:00:01.000Z")],
      onProgress: async (rid) => void (byRid[rid] = (byRid[rid] ?? 0) + 1),
      readNext: async (rid) => {
        const c = (calls.get(rid) ?? 0) + 1;
        calls.set(rid, c);
        return c <= 2 ? na("generate", "brief") : na("human");
      },
    });
    await Promise.all([gen.execute("run-cc-A", "brief"), gen.execute("run-cc-B", "brief")]);
    expect(byRid["run-cc-A"]).toBe(1);
    expect(byRid["run-cc-B"]).toBe(1); // 전역 커서였다면 나중에 emitProgress 한 run 이 dedupe 로 0
  });

  it("⑤ execute 종료 후 그 run 의 커서는 회수된다(Map 무한 성장 방지 · 재실행은 깨끗한 커서)", async () => {
    let emits = 0;
    // 같은 run_id 를 두 번 실행하되 매 실행이 **같은 kind+ts** 이벤트를 본다. 커서가 회수되지 않으면 두 번째
    //   실행은 첫 실행이 남긴 lastKind/lastTs 로 dedupe 되어 emit 하지 않는다. 회수되면 매 실행이 깨끗한 커서로 emit.
    const gen = new BridgeGenExecutor({
      jobsPendingDir: dir,
      pollIntervalMs: 20_000,
      timeoutMs: 10_000_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readEvents: async () => [stepEvent("same-kind", "2026-01-01T00:00:01.000Z")],
      onProgress: async () => void emits++,
      readNext: (() => {
        let c = 0;
        return async () => (++c % 3 === 0 ? na("human") : na("generate", "brief")); // 3회마다 전이(실행당 1 emit)
      })(),
    });
    await gen.execute("run-reuse", "brief");
    await gen.execute("run-reuse", "brief"); // 커서 회수됐으면 같은 이벤트라도 다시 emit
    expect(emits).toBe(2); // 실행당 1회(회수 안 됐으면 두 번째는 dedupe 로 억제 → 1)
  });
});
