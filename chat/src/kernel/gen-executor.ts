/**
 * gen-executor.ts — 생성(run-stage <stage>) 위임 3구현 + 선택기.
 *
 * 배경(grounding W4 · core AGENTS 2번 절): 온라인 실엔진 '헤드리스' 생성(세션 밖 subprocess)은 core 가 fail-closed 로
 *   막는다(옛 run_llm claude -p/codex exec 폐기 = C3 금지). 도달 가능한 모드:
 *     · stub 직접(오프라인/CI): HARNESS_OFFLINE=1 에서 run-stage.sh 를 직접 spawn(결정적).
 *     · insession(세션 안 에이전트가 산출물 작성 후 전이) — 챗 레이어에선 **브리지**로 운영자 세션에 위임(C2, 검증된 기본).
 *     · S-1(무인화): Agent SDK 세션 워커가 운영자 없이 insession 생성 — AgentSdkGenExecutor(아래, live-only 미검증).
 *   따라서 게이트웨이는 온라인에서 스스로 '헤드리스' 실엔진 생성을 spawn 하지 않는다(브리지/SDK 워커는 세션 안 생성).
 *
 * ── P4 / S-1 스파이크 결론(무인 생성) ──────────────────────────────────────────────
 *   질문: 브리지(C2, 운영자 세션 소비)를 Agent SDK 세션 워커로 대체해 브리프 너머까지 **무인** 완주할 수 있는가?
 *   설계: `AgentSdkGenExecutor` 가 그 자리다. 실제 생성은 주입된 `sdkGenerate(rid, stage)`(Claude Agent SDK 로
 *     insession 산출물 작성 → `HARNESS_CLI=claude HARNESS_GEN_MODE=insession run-stage.sh` 전이)가 하고, 이 클래스는
 *     그 뒤 next-action 으로 전이를 확인한다(브리지와 동일 완료 계약). 세션 마커(신뢰 감지)·SDK 배선은 이 레포에
 *     아직 없다 → **오프라인 검증 불가(live-only)**. 그래서 `sdkGenerate` 미주입 시 명확히 fail-closed.
 *   기본값: **C2 브리지 유지**(selectGenExecutor 는 S-1 플래그+SDK 가 둘 다 있을 때만 AgentSdk 를 고른다). S-1 이
 *     실패/미배선이면 폴백이 이미 확보돼 있으므로 다른 단계를 막지 않는다(계획 P4).
 *
 * 불변식: state.json 직접 쓰기 0. 브리지는 pending 잡 '파일'만 기록하고 전이는 core scripts(세션)가 한다.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { bridgeTimeout, genUnmannedS1, isOffline, isSafeRunId, storagePaths } from "../config.js";
import { runStage as defaultRunStage, type HarnessResult } from "./harness-cli.js";
import { readNextAction as defaultReadNextAction } from "./contract-client.js";
import { latestLifecycleProgress, readAguiEvents as defaultReadAguiEvents } from "./agui-events-client.js";
import {
  enqueueJob,
  isGenerateTurn,
  isSafeStage,
  jobFileName,
  parseDeadline,
  recallPendingJob,
} from "./job-protocol.js";
import type { GenExecutor } from "../types/jobs.js";
import type { NextAction } from "../types/contract.js";
import type { AguiEvent } from "../types/a2ui.js";

// ── 1) stub 직접(오프라인 전용) ─────────────────────────────────────────────
export interface StubDirectDeps {
  /** 테스트 주입용 runStage(기본 harness-cli.runStage — 비동기 spawn). fake 는 동기 반환도 허용(await 흡수). */
  runStage?: (stage: string, rid: string) => HarnessResult | Promise<HarnessResult>;
  /** 오프라인 판정(기본 config.isOffline). */
  offline?: () => boolean;
}

/**
 * StubDirectGenExecutor — **오프라인(HARNESS_OFFLINE=1)일 때만** run-stage.sh 를 직접 spawn.
 *   온라인이면 throw(헤드리스 실엔진 생성 금지 — C3). CI/골든 결정 경로 전용.
 */
export class StubDirectGenExecutor implements GenExecutor {
  private readonly runStage: (stage: string, rid: string) => HarnessResult | Promise<HarnessResult>;
  private readonly offline: () => boolean;
  constructor(deps: StubDirectDeps = {}) {
    this.runStage = deps.runStage ?? defaultRunStage;
    this.offline = deps.offline ?? isOffline;
  }
  async execute(run_id: string, stage: string): Promise<void> {
    assertGenArgs(run_id, stage);
    if (!this.offline()) {
      throw new Error(
        "StubDirectGenExecutor: 온라인에서는 직접 생성 spawn 이 금지됩니다(헤드리스 실엔진 금지 — C3). " +
          "온라인은 브리지(BridgeGenExecutor)로 세션 내 생성에 위임하세요.",
      );
    }
    const res = await this.runStage(stage, run_id);
    if (res.code !== 0) {
      const tail = res.stderr.trim() || res.stdout.trim() || "(출력 없음)";
      throw new Error(`stub 생성 실패(stage=${stage}, code=${res.code}): ${tail}`);
    }
  }
}

// ── 2) 브리지(C2 — 기본 운영 경로) ─────────────────────────────────────────

/**
 * 이미 누가 집어 **작업 중**이라 새 요청을 적재하지 않았다는 신호(이중 소비 차단 — enqueueJob 의 ok=false).
 *
 * 별도 타입인 이유: worker 는 제3자 예외를 "생성을 마치지 못했습니다"(FAIL_MESSAGES)로 치환하는데, 여기선 그게
 *   **거짓말**이다 — 못 만든 게 아니라 지금 만들고 있다. 그래서 worker 가 이 오류만은 알아보고 message 를 그대로
 *   카드에 싣는다(BadJobError 와 같은 계약: 우리가 쓴 평이 한국어라 노출 안전).
 * 실패(ok=false)로 환원하는 것은 의도다: 성공으로 두면 onOutcome 의 자동 이어가기가 같은 단계 생성 잡을 **또**
 *   넣어(next-action 이 그대로 생성 차례다) 우리가 막은 그 중복을 스스로 만든다.
 */
export class GenerationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInProgressError";
  }
}

/**
 * 적재 차단 시 현업에게 보이는 한 줄(operator-voice — 내부 용어 0: '클레임'·'잡'·'소비자'를 쓰지 않는다).
 *   실패 카드에 실려 [상태 다시 확인] 버튼과 함께 뜬다(어댑터 renderFailure) — '다시 확인'의 실제 출구가 그 버튼이다.
 */
const MSG_ALREADY_IN_PROGRESS = "이미 만들고 있어요 — 잠시 후 다시 확인해 주세요.";
/** 판단 불가(권한·IO)일 때의 한 줄 — 만들고 있다고 **단정하지 않는다**(모르는 것을 아는 척하지 않는다). */
const MSG_CANNOT_TELL = "지금 상태를 확인하지 못했어요 — 잠시 후 다시 확인해 주세요.";

export interface BridgeDeps {
  /** 전이 감지용 next-action 조회(기본 contract-client.readNextAction). */
  readNext?: (rid: string) => Promise<NextAction>;
  /** pending 잡 디렉터리(기본 storagePaths().jobsPending). */
  jobsPendingDir?: string;
  /** claimed 잡 디렉터리(기본 storagePaths().jobsClaimed) — 이중 소비 차단 조회용(읽기 전용). */
  jobsClaimedDir?: string;
  /** 폴링 간격(ms, 기본 3000). */
  pollIntervalMs?: number;
  /** 최대 대기(ms, 기본 config.bridgeTimeout() = env CHAT_BRIDGE_TIMEOUT · 900초). 초과 시 Error(무한대기 금지). */
  timeoutMs?: number;
  /** 테스트 주입: sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** 테스트 주입: 현재시각(ms). */
  now?: () => number;
  /**
   * 진행 표시 side-channel(**옵셔널 · 기본 undefined**) — 주입 시에만 poll 루프가 긴 생성 구간의 증분 진행을 emit 한다.
   *   미주입이면 진행 로직 자체가 no-op → **현행 동작 완전 동일**(진행 emit 0). ⚠ 진행 표시는 **표시 전용**이지
   *   전이 신호가 아니다 — transitioned/deadline/recall/enqueue 판정을 한 글자도 바꾸지 않는다(불변식 1).
   */
  onProgress?: (rid: string, message: string) => void | Promise<void>;
  /** AG-UI 이벤트 읽기(기본 readAguiEvents · best-effort []). 테스트가 fake 주입(실 spawn 0). */
  readEvents?: (rid: string) => Promise<AguiEvent[]>;
  /** 진행 emit 최소 간격(ms · 기본 15000) — 매 iteration spawn 방지(throttle). 3s 폴링에서 수십 회 spawn 과부하 차단. */
  progressMinIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 생성 인자 검증 — 변조된 잡의 run_id/stage 가 파일경로를 탈출(`../`)하는 것 차단(세 실행기 공통). */
function assertGenArgs(run_id: string, stage: string): void {
  if (!isSafeRunId(run_id)) throw new Error(`gen-executor: run_id 형식이 안전하지 않습니다: ${run_id}`);
  if (!isSafeStage(stage)) throw new Error(`gen-executor: stage 형식이 안전하지 않습니다: ${stage}`);
}

/**
 * BridgeGenExecutor — 셸을 직접 띄우지 않고 pending 잡 파일을 적재한 뒤, 소비자(운영자 Claude Code 세션 ·
 *   후속의 무인 데몬)가 세션 내(insession) 생성으로 전이시키기를 next-action 폴링으로 기다린다(전이 감지 시 resolve).
 *   무한 대기 금지 — timeoutMs 초과 시 명확한 Error. 파일 기록만(state 직접쓰기 0).
 *
 * 프로토콜 v2 에서 봇 몫(chat-dual-surface-plan 3절 — 큐·커널 로직은 그대로, 봇 변경은 additive):
 *   · 적재하는 잡에 `expires_at`(= 적재시각 + timeoutMs) 을 싣는다 — 봇의 폴링 마감과 **같은 값**이다(이중 시계 금지).
 *   · 대기 상한 초과 시 아직 pending 인 **자기 잡을 회수**한다(나중 소비자가 봇 몰래 되살리는 창을 닫는다).
 *   · 회수 실패(이미 클레임됨) = 늦은 성공이 가능하다는 뜻 → 그 화해는 실패 카드의 [상태 다시 확인] 버튼이 한다
 *     (보증 3분법의 봇 몫 — 봇은 소비자를 죽일 수 없으므로 UX 로 닫는다).
 *   · 회수 성공 = 요청이 사라졌다는 뜻(core 는 그대로 생성 차례) → [상태 다시 확인]이 그 사실을 확인하고 [다시 만들기]
 *     카드를 낸다(flow.presentationForStatusCheck). 그 클릭은 옛 잡 부활이 아니라 이 실행기를 다시 타는 **새 요청**이다.
 *   · **회수 실패 = 적재 금지**: 그 '새 요청'이 무조건 적재되면, 옛 잡을 집은 소비자와 새 잡을 집을 소비자가 같은
 *     런을 동시에 쓴다(이중 소비 · 이중 과금). 그 차단은 **적재 그 자체**가 한다 — `enqueueJob`(원자 대체)이
 *     '옛 잡 내리기(unlink) → 산 클레임 조회 → 배타 생성'을 한 걸음처럼 수행하고, 막을 사정이면 아무것도 쓰지 않고
 *     ok=false 를 낸다. 이 실행기는 그 결과를 사람의 문구로 옮길 뿐 스스로 검사·보상하지 않는다(판정 SSoT 는 하나다).
 *
 * ⚠ 옛 설계(check → write → re-check → 보상)는 폐기됐다: 검사와 적재가 두 걸음이라 그 사이에 옛 잡이 집히는 창이
 *   남았고, 보상(우리 잡 회수)은 제 자신도 실패할 수 있었다. 지금은 그 창의 **전제**(집을 수 있는 옛 잡)가 적재
 *   1단계에서 사라진다 — 근거는 job-protocol.enqueueJob 주석이 SSoT.
 */
export class BridgeGenExecutor implements GenExecutor {
  private readonly readNext: (rid: string) => Promise<NextAction>;
  private readonly jobsPendingDir: string;
  private readonly jobsClaimedDir: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  // ── 진행 표시 side-channel(전이/마감/회수 상태와 완전 분리 — 표시 전용) ──
  private readonly onProgress?: (rid: string, message: string) => void | Promise<void>;
  private readonly readEvents: (rid: string) => Promise<AguiEvent[]>;
  private readonly progressMinIntervalMs: number;
  // 진행 커서 = **run_id 별** throttle·dedupe 상태(하나의 실행기 인스턴스가 createGateway 에서 공유되고, JobQueue 는
  //   서로 다른 run_id 를 **동시**로 처리한다[run별 FIFO = 같은 run 만 직렬 · 다른 run 은 병렬] → 인스턴스-전역 스칼라면
  //   run A 의 진행 활동이 run B 의 throttle 을 앞당기거나 run B 의 이벤트를 dedupe 로 억제한다. 커서를 run_id 로 키잉해
  //   run 간 간섭을 끊고, execute 종료 시 해당 run 커서를 지운다[unbounded 성장 방지]). 표시 전용이라 전이/마감엔 무관.
  private readonly progressCursors = new Map<
    string,
    { lastAt: number; lastTs: string | null; lastKind: string | null }
  >();
  constructor(deps: BridgeDeps = {}) {
    this.readNext = deps.readNext ?? defaultReadNextAction;
    this.jobsPendingDir = deps.jobsPendingDir ?? storagePaths().jobsPending;
    this.jobsClaimedDir = deps.jobsClaimedDir ?? storagePaths().jobsClaimed;
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.timeoutMs = deps.timeoutMs ?? bridgeTimeout();
    this.sleep = deps.sleep ?? defaultSleep;
    // 주입 없으면 Date.now — 애플리케이션 런타임 코드라 사용 가능(Workflow 스크립트 아님).
    this.now = deps.now ?? (() => Date.now());
    this.onProgress = deps.onProgress; // 미주입 = 진행 로직 no-op(현행 동작 완전 동일).
    this.readEvents = deps.readEvents ?? defaultReadAguiEvents;
    this.progressMinIntervalMs = deps.progressMinIntervalMs ?? 15_000;
  }

  async execute(run_id: string, stage: string): Promise<void> {
    assertGenArgs(run_id, stage);
    // ★ check-first: 요청한 stage 가 더 이상 현재 생성 대상이 아니면(중복 클릭·이미 다음 단계로 진행) pending
    //   파일을 쓰지 않고 즉시 반환. 안 그러면 아무도 소비 안 하는 stale 잡 파일이 남아 엉뚱한 게이트에 처리될 수 있다.
    if (this.transitioned(await this.readNext(run_id), stage)) return;
    // ★ 이중 소비 차단 = 적재 그 자체(원자 대체). 검사와 적재가 갈라져 있지 않으므로 '그 사이'가 없다 —
    //   막을 사정이면 아무것도 쓰이지 않은 채 ok=false 로 돌아온다(보상할 것도 없다).
    const res = await enqueueJob(
      { pending: this.jobsPendingDir, claimed: this.jobsClaimedDir },
      { run_id, stage, timeoutMs: this.timeoutMs },
      { now: this.now },
    );
    if (!res.ok) {
      // 두 사정을 뭉개지 않는다: 산 클레임을 **본** 것과, 못 봤을 뿐 **없다고 말할 수 없는** 것은 다르다.
      //   후자에 "만들고 있어요"라고 답하면 모르는 것을 아는 척하는 것이다(둘 다 fail-closed 인 건 같다).
      throw new GenerationInProgressError(res.reason === "in_progress" ? MSG_ALREADY_IN_PROGRESS : MSG_CANNOT_TELL);
    }
    const job = res.job;
    // 종단 마감 단일 원천(프로토콜 v2): 봇의 폴링 마감을 **잡 파일에 실린 그 값**에서 읽는다 — 따로 재면 봇이
    //   포기한 뒤에도 소비자가 '아직 안 늦었다'고 보는 어긋남이 생긴다.
    const deadline = parseDeadline(job);
    if (deadline === null) {
      // buildGenerateJob 이 만든 잡이라 도달 불가. 조용히 지어낸 마감으로 폴링하느니 드러낸다(마감은 보증의 뿌리다).
      throw new Error(`적재한 잡에 마감이 없습니다(run=${run_id}, stage=${stage}) — 프로토콜 위반.`);
    }
    // try/finally: 어떤 경로로 루프를 벗어나든(전이 return · 마감 throw · 예기치 못한 throw) 이 run 의 진행 커서를
    //   지운다 → Map 무한 성장 방지. 전이/마감/회수 판정은 finally 밖(루프 안)에 그대로라 로직 불변.
    try {
      for (;;) {
        const na = await this.readNext(run_id);
        // ⚠ 순서 주의(의도): 마감 검사보다 **전이 검사가 먼저**다. 마감이 지난 뒤에 본 전이라도 그건 '실제로 된 것'이라
        //   성공으로 보고한다 — 우리 타이머가 지났다는 이유로 끝난 일을 실패로 알리면 카드가 사실과 어긋난다.
        //   (봇이 이미 포기해 실패 카드를 띄운 뒤의 늦은 전이는 이 루프 밖의 일이라 [상태 다시 확인]이 맡는다.)
        if (this.transitioned(na, stage)) {
          await this.cleanupPendingJob(run_id, stage); // 전이 완료 → 남은 pending 파일 정리(stale 방지)
          return; // 생성 완료 → 게이트 도달
        }
        if (this.now() >= deadline) {
          // 봇 타임아웃 = 회수: 아직 pending 인 **자기 잡**만 거둬들인다(job_id 대조 — 같은 단계로 새로 적재된
          //   잡이 있으면 그건 남의 요청이라 손대지 않는다). 이미 클레임됐으면 회수 실패 → 늦은 성공이 가능하다.
          const recalled = await recallPendingJob(this.jobsPendingDir, job);
          throw new Error(
            recalled
              ? `브리지 생성 대기 시간 초과(run=${run_id}, stage=${stage}) — 아무도 처리하지 않아 대기 중이던 요청을 거둬들였습니다.`
              : // 회수 실패의 사정은 여럿이다(소비자가 집어 감 · 만료 처분됨 · 새 잡이 덮어씀) — 봇은 구분하지 못하므로
                // 단정하지 않는다. 어느 쪽이든 사람이 확인할 길은 같다([상태 다시 확인]).
                `브리지 생성 대기 시간 초과(run=${run_id}, stage=${stage}) — 대기 중이던 요청을 회수하지 못했습니다` +
                `(소비자가 이미 집었거나 처분된 상태). 늦게 완료될 수 있습니다([상태 다시 확인]으로 화해).`,
          );
        }
        // ── 진행 표시 side-channel(sleep 직전에만 끼운다 · best-effort) ──────────────────
        //   ⚠ 위 transitioned()·deadline·recall 로직은 **한 글자도 바뀌지 않았다** — 전이 판정 SSoT 는 그대로다.
        //   emitProgress 는 무슨 일이 나든 흡수하므로(내부 try/catch) 루프/전이/마감을 지연·왜곡시키지 않는다.
        //   onProgress 미주입이면 emitProgress 는 즉시 반환(no-op) → 현행 동작 완전 동일.
        await this.emitProgress(run_id);
        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      this.progressCursors.delete(run_id); // 이 run 실행 종료 → 커서 회수(다음 실행은 깨끗한 커서로 시작).
    }
  }

  /**
   * 진행 표시 side-channel(best-effort) — poll 루프가 sleep 직전에 부른다. **전이/마감/회수 판정과 완전 분리**:
   *   여기서 무슨 일이 나든(읽기 실패·파싱 실패·onProgress throw) 흡수해 루프를 깨거나 마감을 지연·왜곡시키지 않는다.
   *   · throttle: 직전 시도 후 progressMinIntervalMs 미경과면 스킵(매 iteration spawn 방지 — 실패해도 시도 시각을
   *     먼저 기록해 빠른 실패가 매 폴링 spawn 하지 않게 한다).
   *   · dedupe: 최신 생명주기 이벤트가 직전 emit(kind·ts)과 같으면 스킵(새 이벤트일 때만 emit).
   *   · onProgress 미주입이면 즉시 반환(no-op → 현행 동작 완전 동일 · 진행 emit 0).
   */
  private async emitProgress(run_id: string): Promise<void> {
    if (!this.onProgress) return; // 미주입 = 진행 로직 없음(현행 동작 완전 동일 · now()/커서 미접촉).
    const nowT = this.now();
    // 커서는 **run_id 별**(동시 실행되는 다른 run 과 throttle·dedupe 상태가 섞이지 않게). 최초엔 lastAt=0 →
    //   첫 시도는 throttle 통과(기존 인스턴스-전역 lastProgressAt=0 초기값과 동일 의미, 단 run 별로 독립).
    const cur = this.progressCursors.get(run_id) ?? { lastAt: 0, lastTs: null, lastKind: null };
    if (nowT - cur.lastAt < this.progressMinIntervalMs) return; // throttle(run별): 매 폴링 spawn 방지.
    cur.lastAt = nowT; // 시도 시각 먼저 기록 — 아래가 실패해도 throttle 을 지킨다.
    this.progressCursors.set(run_id, cur); // 최초 생성 시 등록(throttle 갱신도 반영).
    try {
      const events = await this.readEvents(run_id); // best-effort([]) — 자체로 throw 안 하지만 방어적 catch 도 둔다.
      const prog = latestLifecycleProgress(events, cur.lastTs ?? undefined);
      if (prog === null) return; // 새 이벤트 없음.
      if (prog.kind === cur.lastKind) return; // 직전과 동일 이벤트 = dedupe(fallback ts 흔들림 대비 · run별).
      await this.onProgress(run_id, prog.message);
      cur.lastTs = prog.ts;
      cur.lastKind = prog.kind;
    } catch {
      // 진행 표시의 어떤 실패(spawn·파싱·onProgress throw)도 흡수 — 루프·전이·마감에 영향 0(불변식 3).
    }
  }

  /**
   * 전이 완료 후 남은 pending 잡 파일 정리(소비자가 이미 지웠으면 no-op).
   *   ⚠ 회수(recall)와 달리 job_id 를 대조하지 않는다 — 전이가 확인된 시점엔 그 rid·stage 의 **어떤** 잡도
   *     이미 stale 이다(그 단계 생성 차례가 지났다). 반대로 회수는 아직 그 차례라 남의 새 잡을 지우면 안 된다.
   */
  private async cleanupPendingJob(run_id: string, stage: string): Promise<void> {
    await unlink(join(this.jobsPendingDir, jobFileName(run_id, stage))).catch(() => {});
  }

  /** 생성 완료 판정 — 요청한 stage 가 더 이상 '현재 생성 대상'이 아니면 전이로 본다(판정 SSoT = job-protocol). */
  private transitioned(na: NextAction, requestedStage: string): boolean {
    return !isGenerateTurn(na, requestedStage);
  }
}

// ── 3) Agent SDK 세션 워커(S-1 · 무인 · live-only 미검증) ─────────────────────────
/** Agent SDK 로 insession 생성을 수행하는 실제 워커. 산출물 작성 + `run-stage.sh`(insession) 전이까지 책임진다. */
export type SdkGenerate = (run_id: string, stage: string) => Promise<void>;

export interface AgentSdkDeps {
  /**
   * 실제 Agent SDK 생성 호출. **미주입이면 S-1 미배선**으로 보고 실행 시 명확히 실패한다(fail-closed) —
   *   selectGenExecutor 는 sdkGenerate 가 있을 때만 이 실행기를 고른다(없으면 브리지).
   */
  sdkGenerate?: SdkGenerate;
  /** 전이 확인용 next-action 조회(기본 contract-client). */
  readNext?: (rid: string) => Promise<NextAction>;
}

/**
 * AgentSdkGenExecutor — 운영자 세션 없이 Agent SDK 세션 워커로 insession 생성을 돌리고(무인, S-1), 그 뒤
 *   next-action 으로 전이를 확인한다(브리지와 동일 완료 계약). 세션 마커·SDK 배선은 이 레포에 없어 **오프라인
 *   검증 불가**(live-only) — sdkGenerate 미주입 시 fail-closed. state.json 직접 쓰기 0(전이는 core scripts).
 */
export class AgentSdkGenExecutor implements GenExecutor {
  private readonly sdkGenerate: SdkGenerate;
  private readonly readNext: (rid: string) => Promise<NextAction>;
  constructor(deps: AgentSdkDeps = {}) {
    this.sdkGenerate =
      deps.sdkGenerate ??
      (() => {
        throw new Error(
          "AgentSdkGenExecutor: S-1(Agent SDK 세션 워커)가 배선되지 않았습니다 — sdkGenerate 를 주입하거나 C2 브리지를 쓰세요.",
        );
      });
    this.readNext = deps.readNext ?? defaultReadNextAction;
  }
  async execute(run_id: string, stage: string): Promise<void> {
    assertGenArgs(run_id, stage);
    // 이미 전이돼 있으면(중복) 즉시 반환.
    if (this.transitioned(await this.readNext(run_id), stage)) return;
    await this.sdkGenerate(run_id, stage); // Agent SDK insession 워커: 산출물 작성 + run-stage(insession) 전이.
    // 완료 계약(브리지와 동일): 세션 워커가 다 했으면 요청 stage 가 더 이상 현재 생성 대상이 아니어야 한다.
    if (!this.transitioned(await this.readNext(run_id), stage)) {
      throw new Error(`AgentSdk 생성 후 전이 미확인(run=${run_id}, stage=${stage}) — 세션 워커가 전이시키지 못했습니다.`);
    }
  }
  /** 브리지와 동일 판정(SSoT = job-protocol.isGenerateTurn). */
  private transitioned(na: NextAction, requestedStage: string): boolean {
    return !isGenerateTurn(na, requestedStage);
  }
}

// ── 선택기 ─────────────────────────────────────────────────────────────────────
export interface SelectGenDeps {
  /** 오프라인 판정(기본 config.isOffline). */
  offline?: () => boolean;
  /** S-1 무인화 채택 플래그(기본 config.genUnmannedS1 = env CHAT_GEN_UNMANNED_S1). */
  unmannedS1?: () => boolean;
  /** Agent SDK 생성 호출(있고 S-1 채택 시에만 AgentSdk 를 고른다). 미주입=S-1 미배선. */
  sdkGenerate?: SdkGenerate;
  /**
   * 진행 표시 side-channel(옵셔널) — **브리지(C2)에만** 전달한다(StubDirect/AgentSdk 는 poll 대기가 없어 진행 표시 불필요).
   *   미주입이면 브리지 진행 로직이 no-op → 현행 동작 완전 동일. 후방호환(기존 시그니처 불변).
   */
  onProgress?: (rid: string, message: string) => void | Promise<void>;
}

/**
 * 생성 실행기 선택(단일 진입점). **기본은 현행 그대로**: 오프라인=StubDirect · 온라인=Bridge(C2).
 *   S-1(무인) 은 **플래그(CHAT_GEN_UNMANNED_S1)와 sdkGenerate 가 둘 다 있을 때만** AgentSdk 로 승격 — 둘 중 하나라도
 *   없으면 검증된 C2 브리지로 폴백(계획 P4: S-1 실패/미배선이 다른 단계를 막지 않음). 이 레포엔 sdkGenerate 가
 *   배선돼 있지 않아 온라인은 항상 Bridge 로 귀결(동작 불변).
 */
export function selectGenExecutor(deps: SelectGenDeps = {}): GenExecutor {
  const offline = deps.offline ?? isOffline;
  if (offline()) return new StubDirectGenExecutor();
  const unmanned = deps.unmannedS1 ?? genUnmannedS1;
  if (unmanned() && deps.sdkGenerate) return new AgentSdkGenExecutor({ sdkGenerate: deps.sdkGenerate });
  // 진행 표시는 브리지에만 전달(미주입이면 no-op → 현행 동작 완전 동일). 전이/마감 판정과 무관한 side-channel.
  return new BridgeGenExecutor(deps.onProgress ? { onProgress: deps.onProgress } : {});
}
