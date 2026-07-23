/**
 * flow.ts — 게이트웨이 커널의 오케스트레이션(플랫폼-중립).
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 3장): 구 adapter/slack/bot.ts 의 handle* 로직을 여기로 옮겼다.
 *   커널은 중립 입력 이벤트(events.ts)를 받아 잡큐/상태를 전이하고, "무엇을 보여줄지"를 중립 표현(presentation.ts)으로
 *   ChatPort.render 에 내보낸다 — **어떤 플랫폼도 모른다**(Slack/GChat/Block Kit 단어 0). 플랫폼 어댑터가
 *   이벤트를 번역해 넣고, Presentation 을 자기 네이티브 UI 로 렌더한다.
 *
 * 불변식(dev-loop-grounding 3): 핸들러는 즉시 ack(가벼움) 후 JobQueue.submit 으로 위임(ack-후-비동기).
 *   상태변이·생성은 잡큐→워커→core scripts. state.json 직접 쓰기 0. 행위자(actor)는 어댑터가 `chat:<platform>:<user>`
 *   로 태그해 이벤트에 싣는다(감사 --by; 플랫폼 태깅은 어댑터 책임 — 커널은 불투명 취급).
 */
import { randomUUID } from "node:crypto";
import { FileStateAdapter } from "./file-state-adapter.js";
import { ThreadRunMap } from "./thread-run-map.js";
import { PendingInputStore } from "./pending-input.js";
import { JobQueue } from "./job-queue.js";
import { Worker, type WorkerOutcome } from "./worker.js";
import { selectGenExecutor } from "./gen-executor.js";
import { toViewModel, type ViewModel } from "./viewmodel.js";
import { saveWorkingBackwardsText, stageIntakeFolder } from "./intake.js";
import { newRun as defaultNewRun } from "./harness-cli.js";
import { readNextAction as defaultReadNextAction } from "./contract-client.js";
import { readA2uiSurface as defaultReadA2uiSurface } from "./a2ui-surface-client.js";
import {
  GENERATE_RETRY_ACTION_ID,
  NL_INTAKE_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
  RA_CONFIRM_ACTION_ID,
} from "./interaction.js";
import { fieldsUncertain, selectNlParser, validateIntakeFiles, type NlIntent, type NlParser } from "./nl/index.js";
import type { ChatPort } from "./ports.js";
import type {
  ApproveGatePresentation,
  ConfirmGatePresentation,
  DonePresentation,
  EscalationPresentation,
  FailurePresentation,
  GenerateRetryPresentation,
  ImageOptionSetPresentation,
  IngestPromptPresentation,
  NlProposalPresentation,
  OptionSetPresentation,
  Presentation,
  ProgressPresentation,
  SetupPresentation,
  VerdictOutcome,
  VerdictPresentation,
} from "./presentation.js";
import { findSection, readOptionsDoc, type OptionsDoc } from "./option-reader.js";
import { readKeyvisualOptions, type KeyvisualOption } from "./keyvisual-reader.js";
import type { ButtonPressed, ChoiceMade, MentionReceived, TextReply } from "./events.js";
import {
  bundleDir as defaultBundleDir,
  isApprover as defaultIsApprover,
  nlFileRoots as defaultNlFileRoots,
  reviewRetryBackoffMs,
  reviewRetryMax,
  stagedWbPath as defaultStagedWbPath,
} from "../config.js";
import type { Job, JobKind } from "../types/jobs.js";
import type { NextAction } from "../types/contract.js";
import type { A2uiSurface } from "../types/a2ui.js";

/** A2UI 읽기 표면 오버레이 읽기 함수 타입(파생 뷰 · best-effort null — 예외 없음). */
export type ReadSurface = (rid: string) => Promise<A2uiSurface | null>;

/**
 * readSurface 기본값 = null-object. 오버레이를 명시 주입하지 않은 모든 경로(기존 테스트·비-production 호출)는 이걸 써
 *   surface 를 **읽지 않고**(spawn 0) na.* 기반으로 폴백한다 → 관측 동등·단위테스트 결정성 보장(불변식 1·3).
 *   production 소비는 createGateway 가 gw.readSurface=readA2uiSurface(실 클라이언트)로 켠다.
 */
const NO_SURFACE: ReadSurface = async () => null;

/**
 * 오버레이 게이트 스냅샷 일치 가드(TOCTOU 방어). na 는 상류에서 먼저 읽히고 surface 는 표현 빌더에서 두 번째로 읽힌다 —
 *   그 사이 core 가 전이하면 surface 가 **다른 게이트**(phase/gate/status)를 가리킬 수 있고, 그러면 카드가 옛 게이트
 *   내용(na 기반: header/gateLabel/options)에 **다른 게이트의 플래그**(reviseAvailable/raOkRequired)를 섞는다. 그래서
 *   surface 는 na 와 **같은 게이트 스냅샷**(phase·gate·status 일치)일 때만 쓰고, 어긋나면 null 로 환원해 na.* 로 폴백한다
 *   (오버레이는 na 스냅샷 위에만 얹힌다 — 불변식 4: na 가 주계약). 일치하면 그대로 반환.
 */
function gateConsistentSurface(surface: A2uiSurface | null, na: NextAction): A2uiSurface | null {
  if (!surface) return null;
  return surface.phase === na.phase && surface.gate === na.gate && surface.status === na.status
    ? surface
    : null;
}

/** 게이트웨이 묶음 — 핸들러가 소비. */
export interface Gateway {
  queue: JobQueue;
  map: ThreadRunMap;
  pending: PendingInputStore;
  newRun: typeof defaultNewRun;
  readNext: (rid: string) => Promise<NextAction>;
  /**
   * A2UI 읽기 표면 오버레이(파생 뷰 · best-effort null). 인터랙티브 게이트(approve/select)에서 버튼셋 boolean 소스를
   *   surface.actions/ra_ok_required 로 교차확인한다 — na 를 대체하지 않는다(오버레이). fake 로 주입 가능(테스트=null-object).
   */
  readSurface: ReadSurface;
  isApprover: (actor: string) => boolean;
  bundleDir: () => string | undefined;
  stagedWbPath: () => string | undefined;
  /** 자연어 파서(P3 — 오프라인/무키=stub · 온라인+키=실 LLM). 파싱만; 상태 변이 안 함. */
  nl: NlParser;
  /** NL 파일 인입(P3-2) allowlist 루트(config.nlFileRoots). 빈 배열이면 파일 인입 불가(fail-closed). */
  nlFileRoots: () => string[];
  /**
   * 지연 재적재의 **주입 가능 시계**(live-assembly 의 주입 sleep 미러). 잡-레벨 리뷰 재적재(chat-review-retry-plan 2-3)가
   *   백오프 대기에 쓴다. 미주입이면 실제 대기(realSleep). 테스트는 즉시-resolve 가짜를 넣어 벽시계 0(결정론).
   */
  delay?: (ms: number) => Promise<void>;
  /**
   * 자동 리뷰 재적재 예산(잡-레벨 재시도 · chat-review-retry-plan 2장). max=재적재 최대 횟수(0=끄기), backoffMs=재적재 전
   *   대기(ms) 목록(attempt 인덱스가 넘으면 마지막 원소 반복). 미주입이면 재시도 없음(max 0 취급 → 기존 즉시 Failure).
   */
  reviewRetry?: { max: number; backoffMs: number[] };
  chat: ChatPort;
}

/** 자동 단계(생성/심의) 잡의 actor — 사람 아님(승인 게이트 대상도 아님 · --by 로 안 나감). 플랫폼 무관. */
const AUTO_ACTOR = "chat:auto";

/** 지연 재적재 기본 시계 — 주입(gw.delay) 안 하면 실제 대기. 테스트는 gw.delay 로 즉시-resolve 가짜를 넣어 벽시계 0. */
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 봇이 사람 개입 없이 자동으로 이어 생성하는 단계(P2 로 keyvisual 까지 확장 — 디자인도 자동 생성 후 이미지 다안 제시).
 *   흐름: brief 통과 → concept 자동생성 → (다안 선택 대기) → 선택 후 storyboard-outline 자동생성 →
 *         (다안 선택 대기) → storyboard-plan 자동생성 → 승인 → keyvisual 자동생성 → (이미지 다안 선택 대기) →
 *         선택 후 확정 승인 → 심의 → done.
 *   선택(select)은 자동이 아니다: 사람이 [이걸로]를 눌러야 다음 단계로 넘어간다(생성만 자동, 결정은 사람).
 */
const AUTO_GENERATE_STAGES: ReadonlySet<string> = new Set([
  "intake",
  "evidence",
  "guideline",
  "brief",
  "concept",
  "storyboard-outline",
  "storyboard-plan",
  "keyvisual",
]);

/** run_id 생성 — seed(threadId)를 경로-안전 토큰으로 축약(isSafeRunId 통과). */
export function makeRunId(seed: string): string {
  const safe = seed.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `chat-${safe || "run"}`;
}

/** 버튼 value(JSON) 파싱 — {run_id, action, ...}. 실패 시 null. */
export function parseActionValue(
  value: string | undefined,
): {
  run_id: string;
  action: string;
  stage?: string;
  ra_required?: boolean;
  option?: string;
  phase?: string;
  iteration?: number | null;
} | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (typeof v.run_id !== "string" || typeof v.action !== "string") return null;
    return {
      run_id: v.run_id,
      action: v.action,
      stage: typeof v.stage === "string" ? v.stage : undefined,
      ra_required: v.ra_required === true,
      option: typeof v.option === "string" ? v.option : undefined,
      // 다안 stale 가드용 도장(stamp) — 옵션 버튼에만 실린다.
      phase: typeof v.phase === "string" ? v.phase : undefined,
      iteration: typeof v.iteration === "number" ? v.iteration : v.iteration === null ? null : undefined,
    };
  } catch {
    return null;
  }
}

/** action 문자열 → 잡 kind. 알 수 없으면 null(무시). */
function actionToKind(action: string): JobKind | null {
  switch (action) {
    case "approve":
    case "select":
    case "revise":
    case "ingest":
    case "review":
    case "raise-limit":
      return action;
    case "generate":
      return "generate";
    default:
      return null;
  }
}

// ── 중립 표현 빌더(ViewModel 라벨 → Presentation · passthrough 보존) ─────────────
function setupP(c: { product?: string; domain?: string; format?: string } = {}): SetupPresentation {
  const p: SetupPresentation = { type: "Setup" };
  if (c.product !== undefined) p.product = c.product;
  if (c.domain !== undefined) p.domain = c.domain;
  if (c.format !== undefined) p.format = c.format;
  return p;
}
function progressP(vm: ViewModel, message: string): ProgressPresentation {
  return { type: "Progress", rid: vm.rid, header: vm.header, message };
}
/**
 * 진행 표시 렌더(best-effort side-channel) — 긴 생성 구간에서 gen-executor(브리지)가 부르는 onProgress 의 몸통.
 *   rid→threadId 를 ThreadRunMap 으로 해석하고, 있으면 현재 상태(header)를 곁들인 ProgressPresentation 을 render 한다.
 *   ⚠ 전이/마감 판정과 무관한 **표시 전용**이다 — 어떤 실패(threadId 미해석·readNext 실패·render 실패)도 조용히
 *     흡수한다(진행 표시가 생성 완주를 방해하지 않게). 전이 후의 정식 카드는 onOutcome 이 낸다(이건 그 사이 증분 표시).
 *   ⚠ 새 Presentation 변이를 만들지 않는다 — 기존 ProgressPresentation 을 재사용한다(불변식 6).
 */
export async function renderProgress(
  gw: Pick<Gateway, "map" | "readNext" | "chat">,
  rid: string,
  message: string,
): Promise<void> {
  try {
    const threadId = await gw.map.threadForRun(rid).catch(() => null);
    if (!threadId) return; // 스레드 미해석이면 표시할 곳이 없다(best-effort 스킵).
    const na = await gw.readNext(rid).catch(() => stubNext(rid)); // header 재료(읽기 실패는 빈 라벨 폴백).
    await gw.chat.render(threadId, progressP(toViewModel(na), message));
  } catch {
    // 진행 표시의 어떤 실패도 흡수 — side-channel 이라 생성 루프/전이/완주를 흔들지 않는다.
  }
}
/** 실패 카드 — 사유 + [상태 다시 확인](늦은 성공 화해 · 읽기 전용). */
function failureP(vm: ViewModel, message: string): FailurePresentation {
  return { type: "Failure", rid: vm.rid, header: vm.header, message };
}
/** 생성 재요청 카드 — 생성 차례인데 아무도 만들고 있지 않을 때(회수된 요청)의 출구. 방아쇠는 사람의 버튼. */
function generateRetryP(vm: ViewModel, stage: string): GenerateRetryPresentation {
  return {
    type: "GenerateRetry",
    rid: vm.rid,
    header: vm.header,
    message: "아직 만들어지지 않았어요 — 다시 요청할 수 있어요.",
    stage,
  };
}
function ingestP(vm: ViewModel): IngestPromptPresentation {
  return { type: "IngestPrompt", rid: vm.rid, header: vm.header, gateLabel: vm.gateLabel, hint: vm.hint };
}
/**
 * 단안 승인/보완 게이트 카드. **surface 오버레이(관측 동등 · drift 보호)**: surface 가 non-null 이면 버튼 boolean 을
 *   surface 에서 소싱한다 — reviseAvailable ← surface.actions.includes("revise") · raOkRequired ← surface.ra_ok_required.
 *   두 값은 core 에서 na 와 동치라 오늘 출력은 동일하고(관측 동등 근거), 미래에 카탈로그가 revise 를 이 게이트에서
 *   빼면 chat 버튼이 자동으로 따라간다(drift 보호). surface=null(기본)이면 기존 na 소스(vm.*)로 폴백.
 *   ⚠ 출력 형태(ApproveGate 변이·필드)는 불변 — boolean 소스만 surface 우선(불변식 1·4).
 *
 *   ⚠ **1차/2차 액션 비대칭(의도)**: surface.actions 로는 **2차 액션(revise)** 만 게이트한다 — 1차 액션(approve)은
 *     surface.actions 로 억제하지 않는다. 이유: 이 카드에 오는 것 자체가 na.action==="approve" 로 **라우팅**된 결과이고,
 *     na.action 은 a2ui_surface.decide()(surface.actions 의 소스)와 **같은 core 헬퍼로 파생**되므로, 렌더 시점엔
 *     surface.actions 가 approve 를 반드시 포함한다(둘이 어긋나려면 core 가 자기모순이어야 하는데 같은 파생이라 불가).
 *     반대로 1차 버튼을 surface.actions 로 억제하면 '진행 버튼 없는 승인 게이트'라는 망가진 카드가 나온다 — 2차(revise)는
 *     '있으면 좋은' 수식 액션이라 숨겨도 게이트가 성립하지만, 1차는 게이트의 존재 이유라 숨기면 카드가 무의미해진다.
 *     클릭↔재파생 사이 상태 변화(stale click)는 a2ui-action.sh 가 클릭 시점에 재검증해 거부하는 기존 fail-closed 가 처리한다.
 */
async function approveP(na: NextAction, readSurface: ReadSurface): Promise<ApproveGatePresentation> {
  const vm = toViewModel(na);
  // best-effort 방어(readSurface 는 이미 throw 안 함) + 게이트 스냅샷 일치 가드(전이 TOCTOU → 다른 게이트면 na 폴백).
  const surface = gateConsistentSurface(await readSurface(na.rid).catch(() => null), na);
  return {
    type: "ApproveGate",
    rid: vm.rid,
    header: vm.header,
    gateLabel: vm.gateLabel,
    hint: vm.hint,
    reviseAvailable: surface ? surface.actions.includes("revise") : vm.reviseAvailable,
    raOkRequired: surface ? surface.ra_ok_required : vm.raOkRequired,
  };
}
function verdictP(vm: ViewModel, outcome: VerdictOutcome): VerdictPresentation {
  return { type: "Verdict", rid: vm.rid, header: vm.header, outcome, stage: vm.stage };
}
function escalationP(vm: ViewModel): EscalationPresentation {
  return { type: "Escalation", rid: vm.rid, header: vm.header, gateLabel: vm.gateLabel, hint: vm.hint };
}
function confirmP(rid: string): ConfirmGatePresentation {
  return { type: "ConfirmGate", rid, kind: "ra" };
}

// ── 자연어 이해(NL · P3) — '이해는 자연어, 방아쇠는 버튼' ─────────────────────
/** 미확신 필드(domain/format/product) → 사람용 되물음(평이 한국어). */
function questionFor(field: string): string {
  switch (field) {
    case "domain":
      return "어떤 제품인가요? (화장품 · 의약외품 · 건기식 · 의약품 중에서 알려 주세요)";
    case "format":
      return "결과물을 한 장으로 만들까요, 여러 장으로 만들까요?";
    case "product":
      return "제품 이름을 알려 주세요.";
    default:
      return "";
  }
}
/** 설정 제안 요약(평이) — 뽑힌 값 · 미정 표기. */
function nlSetupSummary(i: NlIntent): string {
  return `규제도메인: ${i.domain ?? "미정"} · 산출물: ${i.format ?? "미정"} · 제품명: ${i.product ?? "미정"}`;
}
/** 인입 제안 요약(평이) — 파일별 역할 + 설정 값. */
function nlIntakeSummary(i: NlIntent, acceptedCount: number): string {
  const roleLabel: Record<string, string> = {
    working_backwards: "제품 자료",
    test_report: "시험성적서",
    reference: "참고 자료",
  };
  const lines = i.files.map((f) => `· ${roleLabel[f.role] ?? "자료"}: ${f.path}`);
  const head = `첨부 자료 ${acceptedCount}건으로 시작할게요 — ${nlSetupSummary(i)}`;
  return [head, ...lines].join("\n");
}
function questionsFor(intent: NlIntent): string[] {
  return intent.uncertain.map(questionFor).filter((q) => q.length > 0);
}
/** 뽑힌 설정 필드만 patch 로(undefined 미포함). */
function setupPatch(i: NlIntent): { product?: string; domain?: string; format?: string } {
  const p: { product?: string; domain?: string; format?: string } = {};
  if (i.domain !== undefined) p.domain = i.domain;
  if (i.format !== undefined) p.format = i.format;
  if (i.product !== undefined) p.product = i.product;
  return p;
}

/**
 * P3-1 설정 제안: 뽑은 값을 pending=setup 에 병합(이후 Select/[시작] 경로가 그대로 작동)하고 NlProposal 을 낸다.
 *   완결(도메인+포맷+제품명)이면 [시작](SETUP_ACTION_IDS.start) 버튼만; 미확신이면 질문 + 설정 카드로 사람이 채운다.
 *   ⚠ 자동 시작 없음 — [시작] 은 startRun 이 pending 을 읽어 실행(잠긴 결정 6).
 */
async function handleNlSetup(threadId: string, gw: Gateway, intent: NlIntent): Promise<void> {
  const patch = setupPatch(intent);
  await gw.pending.set(threadId, { kind: "setup", ...patch });
  await gw.chat.subscribe(threadId);
  const complete = Boolean(intent.domain && intent.format && intent.product);
  const proposal: NlProposalPresentation = {
    type: "NlProposal",
    kind: "setup",
    summary: nlSetupSummary(intent),
    questions: complete ? [] : questionsFor(intent),
    ...(complete ? { confirm: { actionId: SETUP_ACTION_IDS.start, label: "시작" } } : {}),
  };
  await gw.chat.render(threadId, proposal);
  // 미확신이면 설정 카드도 띄워 Select/답글로 마저 채우게(자동 시작 금지).
  if (!complete) await gw.chat.render(threadId, setupP(patch));
}

/**
 * P3-2 파일 인입 제안: 경로를 allowlist + realpath 봉쇄로 검증. 통과분이 없으면 거부 안내(잡·대기 없음).
 *   설정 3필드가 다 있으면 pending=intake 로 두고 [이 자료로 시작] 버튼(확정 시 스테이징 + intake 잡). 미확신이면 질문만.
 *   ⚠ 여기서 잡을 만들지 않는다 — 확정 버튼(confirmNlIntake)이 방아쇠다(잠긴 결정 6).
 */
async function handleNlIntake(threadId: string, gw: Gateway, intent: NlIntent): Promise<void> {
  await gw.chat.subscribe(threadId);
  // ⚠ 새 인입 제안은 이전 인입 제안을 즉시 무효화한다(Codex P3 HIGH): 선언이 바뀌었으므로 옛 제안 대기는 폐기.
  //   아래에서 '전부 통과 + 3필드 완비'일 때만 새 대기(intake)를, 제품명만 미정이면 새 draft(intake_draft)를 심는다 —
  //   거부/불완전이면 대기가 없어, 옛 카드 클릭·옛 draft 완성이 pending 부재로 no-op(거부된 재선언 뒤 옛 자료 확정 차단).
  //   ⚠ intake 뿐 아니라 intake_draft 도 비운다: 거부된 재선언이 옛 draft 를 남기면 뒤이은 제품명 답글이 옛 파일로
  //     완성돼 버린다(fail-closed 위반 · Codex intake_draft HIGH).
  const prior = await gw.pending.get(threadId);
  if (prior?.kind === "intake" || prior?.kind === "intake_draft") await gw.pending.clear(threadId);
  const roots = gw.nlFileRoots();
  const v = validateIntakeFiles(intent.files, roots);
  // 파일 경로를 하나도 못 잡음(빈 목록/파싱 실패).
  if (v.accepted.length === 0 && v.rejected.length === 0) {
    await gw.chat.render(
      threadId,
      progressP(toViewModel(stubNext(makeRunId(threadId))), "받은 메시지에서 파일 경로를 찾지 못했어요 — 파일 위치를 알려 주세요."),
    );
    return;
  }
  // ⚠ 부분 반입 금지(fail-closed · Codex P3 HIGH): 하나라도 거부되면 전체를 보류한다. 규제 인입에서 '현업이 검토한
  //   자료'와 '실제 반입된 자료'가 어긋나면 안 된다(거부분을 조용히 빼고 시작 금지). 거부 사유를 알려 고치게 한다.
  if (v.rejected.length > 0) {
    const lines = v.rejected.map((r) => `· ${r.ref.path}: ${r.reason}`).join("\n");
    const head =
      roots.length === 0
        ? "파일을 불러올 폴더가 설정되어 있지 않아요 — 운영자에게 문의해 주세요."
        : `일부 파일을 확인하지 못했어요 — 전부 확인돼야 시작할 수 있어요. 아래를 고쳐 다시 알려 주세요:\n${lines}`;
    await gw.chat.render(threadId, progressP(toViewModel(stubNext(makeRunId(threadId))), head));
    return; // pending·confirm 없음(fail-closed).
  }
  // 전부 통과. 설정 3필드가 있어야 확정 버튼을 낸다(없으면 질문만 — 자동 시작 금지).
  const complete = Boolean(intent.domain && intent.format && intent.product);
  let confirm: NlProposalPresentation["confirm"];
  if (complete) {
    // stale 가드용 도장(nonce): 이 제안을 대기에 심고, 확정 버튼에도 실어 옛 카드 클릭이 새 제안을 실행하는 것을 막는다.
    const nonce = randomUUID();
    await gw.pending.set(threadId, {
      kind: "intake",
      files: intent.files,
      domain: intent.domain!,
      format: intent.format!,
      product: intent.product!,
      nonce,
    });
    confirm = { actionId: NL_INTAKE_CONFIRM_ACTION_ID, label: "이 자료로 시작", payload: JSON.stringify({ nonce }) };
  } else if (intent.domain && intent.format) {
    // 제품명만 미정(파일·도메인·포맷은 있음): 제안 맥락을 draft 대기로 심어, 다음 답글(제품명)이 이 제안을
    //   완성하게 한다(P3-2 보완). draft 는 확정 버튼이 없다 — 완성돼야 [이 자료로 시작] 이 붙는다.
    await gw.pending.set(threadId, { kind: "intake_draft", files: intent.files, domain: intent.domain, format: intent.format });
  }
  // (도메인/포맷까지 미정이면 draft 를 심지 않는다 — 되물음만; 사람이 자연어로 다시 선언한다. rule 8: 도메인은 사람 선언.)
  const proposal: NlProposalPresentation = {
    type: "NlProposal",
    kind: "intake",
    summary: nlIntakeSummary(intent, v.accepted.length),
    questions: complete ? [] : questionsFor(intent),
    ...(confirm ? { confirm } : {}),
  };
  await gw.chat.render(threadId, proposal);
}

/**
 * NL 파일 인입 확정(P3-2) — 확정 버튼 클릭. 상태 변이(새 run 생성)라 승인자만. 확정 시점에 경로를 **재검증**하고
 *   불변 스냅샷 폴더로 복사한 뒤 intake 잡을 큐에 넣는다(실제 intake.sh spawn 은 워커가 수행 — S-3 경계).
 */
async function confirmNlIntake(
  threadId: string,
  actor: string,
  gw: Gateway,
  nonce?: string,
): Promise<{ enqueued?: Job } | void> {
  if (!gw.isApprover(actor)) return; // 워커도 재검사하지만 방어적으로(잡 미생성).
  const pending = await gw.pending.get(threadId);
  if (pending?.kind !== "intake") return; // 지난 카드 재클릭 등 — no-op.
  // ⚠ stale 제안 가드(Codex P3 HIGH): 버튼 도장(nonce)이 현재 대기 제안과 **정확히** 일치해야 확정한다. 옛 카드
  //   (다른 nonce)·도장 없는/변조 버튼(nonce=undefined)은 전부 거부한다 — 우리 렌더는 항상 nonce 를 싣으므로
  //   nonce 부재 = 옛 포맷/변조. 부재를 허용하면 아무 버튼이나 '현재 대기'를 확정해 버린다(부분·오확정).
  //   ⚠ 둘 다 '비지 않은 문자열'이어야 한다(Codex P3): 옛 포맷 pending(nonce 없음=undefined)이 도장 없는 버튼과
  //     undefined===undefined 로 통과하던 구멍 차단.
  if (!nonce || !pending.nonce || nonce !== pending.nonce) {
    await gw.chat.render(threadId, progressP(toViewModel(stubNext(makeRunId(threadId))), "새 제안이 있어요 — 최신 카드의 버튼을 눌러 주세요."));
    return;
  }
  const existing = await gw.map.runForThread(threadId);
  if (existing) {
    const vm = toViewModel(await gw.readNext(existing).catch(() => stubNext(existing)));
    await gw.chat.render(threadId, progressP(vm, "이 스레드에는 이미 진행 중인 작업이 있어요 — 새 작업은 새 스레드에서 저를 멘션해 주세요."));
    return;
  }
  const roots = gw.nlFileRoots();
  const v = validateIntakeFiles(pending.files, roots); // 확정 시점 재검증(파일이 사라졌거나 루트가 바뀌었을 수 있음).
  // 확정 시점도 fail-closed(Codex P3 HIGH): 하나라도 거부되면 진행 안 함(부분 반입 금지).
  if (v.rejected.length > 0 || v.accepted.length === 0) {
    await gw.chat.render(threadId, progressP(toViewModel(stubNext(makeRunId(threadId))), "받은 경로에서 일부 파일을 확인하지 못했어요 — 파일 위치를 다시 확인해 주세요."));
    return;
  }
  const rid = makeRunId(threadId);
  const staged = await stageIntakeFolder(rid, v.accepted);
  if (!staged.ok) {
    await gw.chat.render(threadId, progressP(toViewModel(stubNext(rid)), staged.reason));
    return;
  }
  await gw.map.bindThreadToRun(threadId, rid);
  await gw.pending.clear(threadId);
  const job: Job = {
    kind: "intake",
    run_id: rid,
    actor,
    payload: { folder: staged.folder, product: pending.product, domain: pending.domain, format: pending.format },
  };
  await gw.queue.submit(job);
  return { enqueued: job };
}

/**
 * [상태 다시 확인] — 실패 카드의 **화해**(잡 큐 프로토콜 v2 보증 3분법의 봇 몫). next-action 을 다시 읽어 지금
 *   게이트 카드를 그린다. 늦게 성공한 생성(봇이 포기한 뒤 소비자가 끝낸 경우)을 사람이 JSON 손편집 없이 따라잡는 길이다.
 *
 * 승인자 가드가 없는 이유: **상태를 바꾸지 않는다**(잡 0 · next-action 은 읽기 전용) — 4동작의 '본다'에 해당한다.
 * run_id 는 스레드↔run 매핑으로 해석한다(버튼 value 의 run_id 불신 — 변조된 value 가 남의 런 상태를 이 스레드에
 *   그리게 하지 않는다). 매핑이 없으면 확인할 대상이 없으므로 no-op.
 *
 * ⚠ export 인 이유(라이브 attach): 죽은 라이브 드라이버 재기동(live-assembly.LiveDriver.attach)이 **재멘션 없이**
 *   현재 게이트 카드를 재게시할 때 이 함수를 호출한다 — 재게시 경로는 이 하나뿐이다(readNext 재파생 카드만 · 지어낸
 *   버튼 금지). onAction 라우팅·화해 의미는 불변(읽기 전용 · 상태 변이 0).
 */
export async function reconcile(threadId: string, gw: Gateway): Promise<void> {
  const rid = await gw.map.runForThread(threadId);
  if (!rid) return;
  const na = await gw.readNext(rid).catch(() => null);
  if (!na) {
    await gw.chat.render(
      threadId,
      progressP(toViewModel(stubNext(rid)), "지금 상태를 확인하지 못했어요 — 잠시 후 다시 눌러 주세요."),
    );
    return;
  }
  const p = await presentationForStatusCheck(na, gw.readSurface);
  await gw.chat.render(threadId, p ?? progressP(toViewModel(na), "아직 진행 중이에요 — 잠시 후 다시 확인해 주세요."));
}

/**
 * 리뷰 게이트 재적재(라이브 attach 전용 · 죽은 프로세스 재개의 **유일한 재적재 경로**). na=review 면 심의 잡 1건을
 *   적재하고 그 잡을, 아니면 null 을 반환한다.
 *
 * ⚠ 왜 필요한가(제약): 리뷰 잡과 재시도 백오프 타이머는 드라이버 프로세스의 in-memory 큐/타이머에만 산다 — 프로세스가
 *   죽으면 소실된다. attach 의 reconcile 은 현재 게이트 카드(리뷰 중이면 "규정 점검 중" Progress)만 재게시할 뿐
 *   리뷰 잡을 다시 넣지 않는다. 그러면 decideLive(Progress)=wait 라 아무도 심의를 재적재하지 않아 stuck→stalled 로
 *   죽는다. 이 헬퍼가 그 소실을 화해한다.
 * ⚠ 잠긴 결정:
 *   · 적재 형태는 onOutcome 자동 이어가기(review 캐스케이드)와 **정확히 같다**(kind/actor/payload). 심의 재적재는 이미
 *     잡-레벨 재시도(review-retry)로 자동화된 결이라 여기서의 자동 재적재도 허용된다.
 *   · **generate(유료 생성)는 절대 여기서 적재하지 않는다** — 중복 과금 우려의 GenerateRetry 는 사람 몫이다(자동 금지).
 *   · payload:{} 라 attempt 예산은 처음부터 다시 센다 — 재기동은 운영자 수동 행위라, 죽은 프로세스의 잔여 백오프
 *     예산을 복원하지 않고 정직하게 새로 시작한다.
 * readNext 읽기 실패(reject)는 null 로 흡수(관측 불가 = 재개 대상 아님).
 */
export async function enqueueReviewIfDue(gw: Gateway, rid: string): Promise<Job | null> {
  const na = await gw.readNext(rid).catch(() => null);
  if (na?.action !== "review") return null;
  const job: Job = { kind: "review", run_id: rid, actor: AUTO_ACTOR, payload: {} };
  await gw.queue.submit(job);
  return job;
}

/**
 * [다시 만들기] — 회수된 생성의 출구(보증 3분법의 봇 몫 나머지 절반). **옛 요청을 되살리지 않는다**: 기존 생성 잡
 *   경로로 다시 넣어 **새 마감(expires_at)이 붙은 새 요청**을 만든다(프로토콜 v2 — stale 부활 금지).
 *
 * ⚠ 방아쇠 전에 core 에 되묻는다(진실의 출처 = next-action): 지금도 그 단계 생성 차례일 때만 요청한다. 그 사이
 *   소비자가 늦게 성공했거나 다음 단계로 넘어갔으면 요청 대신 지금 게이트 카드를 그린다 — 봇의 옛 타이머를 근거로
 *   이미 끝난 일을 다시 시키지 않는다.
 * run_id 는 스레드↔run 매핑으로 해석한다(reconcile 과 동일 — 버튼 value 의 run_id 불신). 버튼이 실은 stage 는
 *   **도장(stamp)** 이다: 지금 단계와 다르면 옛 카드를 보고 누른 것이라 만들지 않는다(다안 [이걸로] 와 같은 결).
 */
async function retryGenerate(
  threadId: string,
  actor: string,
  stampStage: string | undefined,
  gw: Gateway,
): Promise<{ enqueued?: Job } | void> {
  const rid = await gw.map.runForThread(threadId);
  if (!rid) return; // 스레드에 run 이 없으면 다시 만들 대상이 없다.
  const na = await gw.readNext(rid).catch(() => null);
  if (!na) {
    await gw.chat.render(
      threadId,
      progressP(toViewModel(stubNext(rid)), "지금 상태를 확인하지 못했어요 — 잠시 후 다시 눌러 주세요."),
    );
    return;
  }
  if (na.action !== "generate" || !na.stage || (stampStage !== undefined && stampStage !== na.stage)) {
    // 지금은 생성 차례가 아니거나(늦은 성공·다음 단계로 전진) 옛 카드의 클릭 — 상태만 다시 보여준다(잡 0).
    const p = await presentationForStatusCheck(na, gw.readSurface);
    await gw.chat.render(threadId, p ?? progressP(toViewModel(na), "아직 진행 중이에요 — 잠시 후 다시 확인해 주세요."));
    return;
  }
  const job: Job = { kind: "generate", run_id: rid, actor, payload: { stage: na.stage } };
  await gw.queue.submit(job);
  await gw.chat.render(threadId, progressP(toViewModel(na), "다시 요청했어요 — 다 만들어지면 알려드릴게요."));
  return { enqueued: job };
}

/**
 * 사람이 '지금 어떻게 됐어요?'라고 물었을 때의 표현([상태 다시 확인] · 자연어 실행 요청). presentationForNext 와
 *   같되 **생성 차례면 [다시 만들기] 카드**를 낸다.
 *   이유: 사람이 물어보는 시점의 '생성 차례'는 봇이 이미 포기한 뒤다(실패 카드에서만 [상태 다시 확인]이 나온다).
 *   그 요청은 회수돼 큐에 없으므로 버튼 없는 "만드는 중이에요…"는 사실이 아니고, 출구도 없다(런이 고립된다).
 * ⚠ 자동 이어가기(presentationForOutcome)는 이 표현을 쓰지 않는다 — 그쪽은 카드를 낸 직후 생성 잡을 넣으므로
 *   정말 만드는 중이고, 재요청 버튼을 붙이면 진행 중인 생성에 중복 요청을 부른다.
 */
async function presentationForStatusCheck(
  na: NextAction,
  readSurface: ReadSurface = NO_SURFACE,
): Promise<Presentation | null> {
  if (na.action === "generate" && na.stage) return generateRetryP(toViewModel(na), na.stage);
  return presentationForNext(na, readOptionsDoc, readKeyvisualOptions, readSurface);
}

/**
 * 대기 없는 답글 처리(P3): 스레드에 run 이 있고 자연어가 게이트 실행 의도("승인해줘"·"시작해줘"·"이걸로")면
 *   현재 게이트의 버튼 카드를 다시 띄운다(NL 은 실행하지 않음 — 잠긴 결정 6). 그 외 자유 답글은 무시.
 */
async function handleNoPendingReply(threadId: string, text: string, gw: Gateway): Promise<void> {
  const rid = await gw.map.runForThread(threadId);
  if (!rid) return; // run 없는 스레드의 잡담 — 무시.
  const t = (text ?? "").trim();
  if (!t) return;
  const intent = await gw.nl.parse(t, { hasRun: true });
  if (intent.kind !== "execute") return; // 실행 의도가 아니면 아무것도 안 함.
  const na = await gw.readNext(rid).catch(() => stubNext(rid));
  // 물어본 사람에게도 [다시 만들기] 출구를 준다(버튼 클릭과 같은 화면) — 여기서 실행하지는 않는다(잠긴 결정 6).
  const p = await presentationForStatusCheck(na, gw.readSurface);
  if (p) await gw.chat.render(threadId, p);
}

/** 답글 선두의 봇 멘션 토큰(`<@U…>` 또는 `@U…` 형태) 1개 제거 — 재멘션으로 답할 때 제품명에 멘션이 섞이지 않게. */
function stripLeadingMention(text: string): string {
  return (text ?? "").replace(/^\s*<?@[A-Za-z0-9._-]+>?\s+/, "");
}

/** 파일 맥락 신호 ①: 절대경로 토큰(확장자 유무·종류 무관 — 파서가 못 잡은 경로도 포착). */
const FILE_PATH_TOKEN = /(?:^|[\s"'(<])\/[^\s"'>]/;
/**
 * 파일 맥락 신호 ②: 파일/자료를 **가리키는 말**(명사). 한국어는 부분문자열, 영어는 단어경계(\b) —
 *   영어 부분문자열 오탐(profile/documentation/ladder) 방지.
 */
const FILE_NOUN = /(파일|첨부|자료|문서|성적서)/;
const FILE_NOUN_EN = /\b(file|files|document|documents|report|reports|material|materials|attach|upload)\b/i;
/** 변경 동사 — **그 자체로는 파일 얘기가 아니다**(설정·제품명도 "바꿔"·"추가"의 대상이 된다). */
const MUTATE_VERB = /(빼|제거|삭제|없이|바꿔|교체|추가)/;
const MUTATE_VERB_EN = /\b(remove|without|replace|delete|add|drop)\b/i;

/**
 * 답글이 **파일/자료를 바꾸거나 빼려는 의도**를 담고 있는가 — intake_draft 완성 시 fail-closed 판단용(Codex intake_draft
 *   HIGH). 이게 참인데 파서가 파일을 깨끗이 못 잡았으면, 옛 draft 파일로 조용히 완성하지 않고 되묻는다(현업이 바꾸려던
 *   자료가 옛 자료로 확정되는 것 차단). 판정은 두 단계다:
 *
 *   ① **파일 맥락**(절대경로 토큰 · 파일/자료 명사) → 무조건 참. 제품명에 그 낱말이 섞인 과탐도 안전 방향으로 남긴다
 *      (예 "…문서…" → 되물음). 여기서 파서가 뽑은 제품명을 근거로 예외를 두면 "이 자료 빼고 제품명은 X" 가 옛 자료로 확정된다.
 *   ② 파일 맥락 없이 **변경 동사만** 있으면(예 "한장으로 바꿔줘") 파일 얘기로 단정하지 않는다 — 그 답글을 파서가
 *      설정/제품명 선언으로 이해했으면 그 선언으로 본다. 이해하지 못했으면(무엇을 바꾸라는지 불명) 여전히 참 =
 *      fail-closed(예 "그거 빼줘"). 동사만으로 참을 내던 옛 규칙은 설정 보완("한장으로 바꿔줘")까지 거부해 draft 를
 *      날렸다 — 자료를 지키려다 대화를 막았다.
 */
function replyTargetsFiles(text: string, parsed: NlIntent): boolean {
  const t = text ?? "";
  if (FILE_PATH_TOKEN.test(t) || FILE_NOUN.test(t) || FILE_NOUN_EN.test(t)) return true; // ① 파일 맥락
  if (!MUTATE_VERB.test(t) && !MUTATE_VERB_EN.test(t)) return false; // 변경 의도 자체가 없음 — 평문(제품명)
  // ② 변경 동사만 — 파서가 설정/제품명 선언으로 이해했으면 그 선언, 아니면 무엇을 바꾸려는지 불명이라 fail-closed.
  return !(parsed.domain || parsed.format || parsed.product);
}

// ── 핸들러(순수) — fake 이벤트·게이트웨이로 테스트 ───────────────────────────

/**
 * ① @멘션 → 새 작업 설정 시작. 멘션에 의미 있는 자연어가 실렸으면(P3) 파서로 의도를 뽑아 NlProposal 을 낸다:
 *   파일 참조가 있으면 인입 제안(P3-2), 설정 선언(도메인/포맷/제품명)이면 설정 제안(P3-1). 그 외/빈 텍스트는 기존 빈 설정 카드.
 *   ⚠ 자동 시작 없음 — 확정 버튼이 방아쇠다(잠긴 결정 6). 미확신 필드는 질문 + 설정 카드로 사람이 채운다.
 */
export async function onMention(ev: MentionReceived, gw: Gateway): Promise<void> {
  const { threadId } = ev;
  // 재멘션 방어: 이미 run 이 있는 스레드면 설정으로 리셋하지 않는다(wb/feedback 대기 오염 방지 · 1 스레드=1 run).
  const existing = await gw.map.runForThread(threadId);
  if (existing) {
    const vm = toViewModel(await gw.readNext(existing).catch(() => stubNext(existing)));
    await gw.chat.render(threadId, progressP(vm, "이 스레드에는 이미 진행 중인 작업이 있어요 — 새 작업은 새 스레드에서 저를 멘션해 주세요."));
    return;
  }
  const text = (ev.text ?? "").trim();
  if (text) {
    const intent = await gw.nl.parse(text, { hasRun: false });
    if (intent.kind === "intake" && intent.files.length > 0) {
      await handleNlIntake(threadId, gw, intent);
      return;
    }
    if (intent.kind === "setup") {
      await handleNlSetup(threadId, gw, intent);
      return;
    }
    // execute/unknown 는 신규 멘션엔 run 이 없어 실행할 대상이 없다 → 기존 빈 설정 카드로 폴백.
  }
  await gw.pending.set(threadId, { kind: "setup" });
  await gw.chat.subscribe(threadId); // 이후 답글(WB 붙여넣기·보완 사유)이 오게
  await gw.chat.render(threadId, setupP());
}

/**
 * ② 버튼/Select 라우팅. actionId 우선 분기(설정 Select 의 value 는 JSON 이 아니라 선택 토큰이다),
 *   그 외에는 value JSON({run_id, action})으로 잡을 만든다.
 */
export async function onAction(event: ButtonPressed, gw: Gateway): Promise<{ enqueued?: Job } | void> {
  const { actionId, value, actor, threadId } = event;

  // ── 새 작업 설정(Select 수집 → [시작]) ──
  if (actionId === SETUP_ACTION_IDS.domain || actionId === SETUP_ACTION_IDS.format) {
    if (!threadId || !value) return;
    // ⚠ stale Select 방어(2중): 카드는 누적 게시라 옛 설정 카드의 Select 가 [시작] 이후에도 클릭될 수 있다.
    //   ① wb/feedback 대기 중이면 무시(대기를 setup 으로 리셋해 다음 답글 증발 금지)
    //   ② 이미 run 이 바인딩된 스레드면 pending 이 비어 있어도 무시(setup 재생성 → 이후 답글 오소비 금지)
    const cur = await gw.pending.get(threadId);
    if (cur !== null && cur.kind !== "setup") return;
    if (cur === null && (await gw.map.runForThread(threadId))) return;
    const patch = actionId === SETUP_ACTION_IDS.domain ? { domain: value } : { format: value };
    await gw.pending.mergeSetup(threadId, patch);
    return;
  }
  if (actionId === SETUP_ACTION_IDS.start) {
    if (!threadId) return;
    return startRun(threadId, gw);
  }

  // ── NL 파일 인입 제안 확정(P3-2) → 스테이징 스냅샷 + intake 잡(승인자만) ──
  if (actionId === NL_INTAKE_CONFIRM_ACTION_ID) {
    if (!threadId) return;
    // 버튼 value = {nonce}(run_id 없음 — 아직 run 이 없다). nonce 로 stale 제안을 가른다.
    let nonce: string | undefined;
    if (value) {
      try {
        const parsedVal = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsedVal.nonce === "string") nonce = parsedVal.nonce;
      } catch {
        /* 파싱 실패 → nonce 미상(아래 confirm 의 대기 kind 가드가 잡는다). */
      }
    }
    return confirmNlIntake(threadId, actor, gw, nonce);
  }

  // ── [상태 다시 확인](실패 카드) → 상태 재조회 후 지금 게이트 카드 재게시(잡 0 · 읽기 전용 화해) ──
  if (actionId === RECONCILE_ACTION_ID) {
    if (!threadId) return;
    return reconcile(threadId, gw);
  }

  // ── [다시 만들기](생성 재요청 카드) → 상태 재확인 후 **새 요청**(새 마감)으로 생성 잡 재적재 ──
  //   value 의 stage 만 도장으로 쓴다(run_id 는 스레드 매핑이 진실 — 변조 value 로 남의 런을 만들지 못하게).
  if (actionId === GENERATE_RETRY_ACTION_ID) {
    if (!threadId) return;
    return retryGenerate(threadId, actor, parseActionValue(value)?.stage, gw);
  }

  // ── RA 확인 카드의 명시 확인 클릭 → approve(ra_ok=true) 잡(승인자만) ──
  if (actionId === RA_CONFIRM_ACTION_ID) {
    const parsed = parseActionValue(value);
    if (!parsed) return;
    if (!gw.isApprover(actor)) return; // 워커도 재검사하지만 방어적으로(ra_ok 잡 미생성)
    const job: Job = { kind: "approve", run_id: parsed.run_id, actor, payload: { ra_ok: true } };
    await gw.queue.submit(job);
    return { enqueued: job };
  }

  // ── 일반 버튼(value = JSON {run_id, action, ...}) ──
  const parsed = parseActionValue(value);
  if (!parsed) return;
  const { run_id, action, stage, ra_required } = parsed;

  // RA 필수 승인 → 2단계 확인 표현(직접 승인 금지 · ra_ok 는 확인 클릭 후에만).
  if (action === "approve" && ra_required) {
    const tid = threadId ?? (await gw.map.threadForRun(run_id));
    if (tid) await gw.chat.render(tid, confirmP(run_id));
    return;
  }
  // 보완 → 사유를 답글로. pending=feedback + 안내 렌더.
  if (action === "revise") {
    // 대기 상태 '선점'도 승인자만 — 비승인자 클릭이 feedback 대기를 걸면 이후 승인자의 무관한 답글이
    //   보완 사유로 오소비된다(상태 생성 자체를 권한자에 한정).
    if (!gw.isApprover(actor)) return;
    const tid = threadId ?? (await gw.map.threadForRun(run_id));
    if (!tid) return;
    await gw.pending.set(tid, { kind: "feedback", rid: run_id });
    await gw.chat.render(
      tid,
      progressP(toViewModel(await gw.readNext(run_id).catch(() => stubNext(run_id))), "빼거나 고칠 내용을 이 스레드에 답글로 적어 주세요."),
    );
    return;
  }

  // 다안 선택 [이걸로] → 중립 ChoiceMade 로 바꿔 onChoice(승인자 게이트 + 선택 차례 확인)에 위임.
  //   ⚠ 이 인터셉트가 없으면 generic 잡 경로가 payload.option 없는 select 잡을 만들어 워커에서 실패한다.
  if (action === "select" && parsed.option) {
    return onChoice(
      { type: "choice", optionKey: parsed.option, actor, threadId, expectedPhase: parsed.phase, expectedIteration: parsed.iteration },
      gw,
    );
  }

  const kind = actionToKind(action);
  if (!kind) return;
  const payload: Job["payload"] = {};
  if (kind === "generate" && stage) payload.stage = stage;
  if (kind === "ingest") {
    // [붙여넣기 없이 진행] — 운영자가 번들 + **WB 까지** 스테이징했을 때만 동작(fail-closed).
    //   WB 스테이징 없이 진행하면 core 가 레포 샘플 WB 로 폴백해 무관한 샘플 주장이 실런에 오인입된다.
    const bundle = gw.bundleDir();
    const stagedWb = gw.stagedWbPath();
    if (!bundle || !stagedWb) {
      const tid = threadId ?? (await gw.map.threadForRun(run_id));
      if (tid) {
        await gw.chat.render(
          tid,
          progressP(
            toViewModel(await gw.readNext(run_id).catch(() => stubNext(run_id))),
            "준비된 자료가 없어 이대로 진행할 수 없어요 — 제품 자료 본문을 이 스레드에 답글로 붙여넣어 주세요.",
          ),
        );
      }
      return; // pending(wb 대기)은 유지 — 붙여넣기로 재개
    }
    payload.bundle_dir = bundle;
    payload.wb_path = stagedWb;
    // wb 대기 해제는 여기서 하지 않는다 — 인입이 '성공'해야 해제(onOutcome). 실패 시 대기가 남아 재붙여넣기로 복구.
  }
  const job: Job = { kind, run_id, actor, payload };
  await gw.queue.submit(job);
  return { enqueued: job };
}

/** [시작] — pending setup 의 선택값으로 new-run → 스레드 바인딩 → 인입 안내 + pending=wb. */
async function startRun(threadId: string, gw: Gateway): Promise<void> {
  // ⚠ 재시작 방어: 이 스레드에 이미 run 이 바인딩돼 있으면(재멘션·stale 설정 카드 클릭) 새로 시작하지 않는다.
  const existing = await gw.map.runForThread(threadId);
  if (existing) {
    const vm = toViewModel(await gw.readNext(existing).catch(() => stubNext(existing)));
    await gw.chat.render(threadId, progressP(vm, "이 스레드에는 이미 진행 중인 작업이 있어요 — 새 작업은 새 스레드에서 저를 멘션해 주세요."));
    return;
  }
  const pending = await gw.pending.get(threadId);
  const setup = pending?.kind === "setup" ? pending : null;
  // 제품명(답글 수집)·도메인·포맷 셋 다 있어야 시작 — placeholder "제품" 진행은 다제품 추출 키(state.product.name)를
  //   오염시키므로 제품명도 필수다(미비 시 설정 표현 재게시 = 현재 수집 상태 반영).
  if (!setup || !setup.product || !setup.domain || !setup.format) {
    await gw.chat.render(threadId, setupP(setup ?? {}));
    return;
  }
  const rid = makeRunId(threadId);
  const res = await gw.newRun(rid, { domain: setup.domain, format: setup.format, name: setup.product });
  if (res.code !== 0) {
    await gw.chat.render(threadId, progressP(toViewModel(stubNext(rid)), "작업을 시작하지 못했어요 — 이미 시작됐거나 설정이 맞지 않아요."));
    return;
  }
  await gw.map.bindThreadToRun(threadId, rid);
  await gw.pending.set(threadId, { kind: "wb", rid });
  const vm = toViewModel(await gw.readNext(rid).catch(() => stubNext(rid)));
  await gw.chat.render(threadId, ingestP(vm));
}

/**
 * ③ 스레드 답글(구독 메시지) — pending 에 따라 자유 입력을 소비한다.
 *   wb: 본문을 working-backwards.md 로 저장 → 인입 잡(스테이징 번들 + 붙여넣은 WB)
 *   feedback: 승인자의 답글만 보완 사유로 수용 → revise 잡
 */
export async function onReply(ev: TextReply, gw: Gateway): Promise<void> {
  const { threadId, text, actor, hasAttachments } = ev;
  if (!threadId) return;
  const pending = await gw.pending.get(threadId);
  if (!pending) {
    // 대기 입력 없음: 게이트에서 "승인해줘"·"시작해줘" 같은 자연어 실행 요청이면 해당 게이트 버튼 카드를 다시 띄운다
    //   (NL 은 실행하지 않음 — 잠긴 결정 6). 그 외 자유 답글은 무시.
    await handleNoPendingReply(threadId, text, gw);
    return;
  }

  if (pending.kind === "setup") {
    // 설정 중 답글 = 제품명 수집. 수집 상태를 설정 표현으로 반영 재게시.
    const product = text.trim();
    if (!product || hasAttachments) return; // 빈/첨부 답글은 무시
    const merged = await gw.pending.mergeSetup(threadId, { product });
    if (merged?.kind !== "setup") return; // 그 사이 [시작]으로 전이됨(no-op)
    await gw.chat.render(threadId, setupP(merged));
    return;
  }

  if (pending.kind === "wb") {
    if (hasAttachments) {
      await gw.chat.render(threadId, progressP(toViewModel(await gw.readNext(pending.rid).catch(() => stubNext(pending.rid))), "파일 첨부 대신 문서 **본문을 답글로 붙여넣어** 주세요."));
      return;
    }
    const saved = await saveWorkingBackwardsText(pending.rid, text);
    if (!saved.ok) {
      await gw.chat.render(threadId, progressP(toViewModel(await gw.readNext(pending.rid).catch(() => stubNext(pending.rid))), saved.reason));
      return; // pending 유지 — 다시 붙여넣기 가능
    }
    const bundle = gw.bundleDir();
    if (!bundle) {
      await gw.chat.render(threadId, progressP(toViewModel(await gw.readNext(pending.rid).catch(() => stubNext(pending.rid))), "자료 폴더가 설정되지 않았어요 — 운영자에게 문의하세요."));
      return; // WB 는 저장됨 — 운영자 설정 후 재붙여넣기로 재개 가능(pending 유지)
    }
    // ⚠ wb 대기는 여기서 해제하지 않는다 — 인입 '성공' 시 onOutcome 이 해제한다.
    const job: Job = {
      kind: "ingest",
      run_id: pending.rid,
      actor,
      payload: { bundle_dir: bundle, wb_path: saved.path },
    };
    await gw.queue.submit(job);
    return;
  }

  // intake_draft 대기(P3-2 보완): 제품명만 미정인 인입 제안에서 온 답글 = 제품명. 되물음에 대한 직접 답이므로
  //   자유-파싱하지 않고 답 그대로를 제품명으로 채택한다(도메인 추론 아님 → rule 8 무관). 완성 → handleNlIntake 가
  //   경로를 재검증하고 [이 자료로 시작] 버튼 제안으로 승격한다(방아쇠는 여전히 버튼 — 잠긴 결정 6).
  if (pending.kind === "intake_draft") {
    if (hasAttachments) return; // 첨부는 무시(draft 보존)
    const t = stripLeadingMention(text).trim();
    if (!t) return; // 빈 답글 무시(draft 보존)
    const draft = pending; // 평문 답=제품명 경로에서 쓸 파일·도메인·포맷을 파싱 전에 포착
    // ⚠ 경쟁 차단(intake 분기와 동일): 비동기 재파싱 전에 draft 대기를 먼저 비운다.
    // ⚠ 재선언 대응(Codex intake_draft HIGH #2): 구독 스레드에선 재멘션/재선언도 여기(onReply)로 온다 —
    //   답글을 무조건 제품명으로 삼으면 '거부돼야 할 재선언'이 옛 draft 의 제품명으로 삼켜져 옛 파일이 확정된다.
    //   그래서 먼저 재파싱해 새 선언인지 가른다: 파일 재선언→새 제안(옛 draft 폐기) · 설정 재선언(파일 없음)→draft
    //   파일과 병합 · 그 외(평문)만 → 되물음의 답=제품명으로 draft 완성(자유-파싱 아님이라 rule 8 무관).
    await gw.pending.clear(threadId);
    const parsed = await gw.nl.parse(t, { hasRun: false });
    // ① 새 파일 재선언(파싱 성공) → 새로 검증·제안(옛 draft 폐기 · 잘못된 파일은 handleNlIntake 가 fail-closed 거부).
    if (parsed.kind === "intake" && parsed.files.length > 0) {
      await handleNlIntake(threadId, gw, parsed);
      return;
    }
    // ② 답글이 파일/자료 변경 의도(경로 토큰·파일 명사·정체불명 변경 지시)를 담았는데 파싱이 깨끗한 파일을 못 냄
    //    → **fail-closed**. Codex intake_draft HIGH: 공백/미인식/확장자-밖 경로 재선언·파일 제거 의도가 옛 draft
    //    파일 완성으로 새는 것 차단(판정 상세 = replyTargetsFiles).
    if (replyTargetsFiles(t, parsed)) {
      await gw.chat.render(
        threadId,
        progressP(
          toViewModel(stubNext(makeRunId(threadId))),
          "자료를 바꾸거나 빼려면, 쓸 파일 경로를 모두 포함해 새 메시지로 저를 다시 멘션해 주세요(제품명만 답글로 주시면 그건 제품명으로 처리돼요).",
        ),
      );
      return;
    }
    // ③ 파일 의도 없음 → 옛 draft 파일 유지 안전. 되물음의 답=제품명(+파싱된 설정 refinement 병합).
    //    제품명은 '파싱된 product' 우선, 그게 없고 답글이 순수 평문(설정필드·파일 0)이면 답글 전체를 제품명으로.
    //    설정 재선언(도메인/포맷만, 제품명 없음)이면 product 미설정 → handleNlIntake 가 draft 를 다시 심어 제품명을 재요청.
    const isBare = !parsed.domain && !parsed.format && !parsed.product && parsed.files.length === 0;
    const product = parsed.product ?? (isBare ? t : undefined);
    const merged = {
      domain: parsed.domain ?? draft.domain,
      format: parsed.format ?? draft.format,
      ...(product ? { product } : {}),
    };
    const completed: NlIntent = {
      kind: "intake",
      files: draft.files,
      ...merged,
      // ⚠ 미확신은 **병합 결과에서 다시 계산**한다(하드코딩 [] 금지): 답글이 설정만 고치면(예 "한장") 제품명이 여전히
      //   비는데, uncertain 이 비어 있으면 handleNlIntake 가 되물음도 확정 버튼도 없는 카드를 낸다(대화가 막힌다).
      uncertain: fieldsUncertain(merged),
      confidence: 0.9,
    };
    await handleNlIntake(threadId, gw, completed);
    return;
  }

  // intake 대기(P3-2): 확정은 버튼(confirmNlIntake)이지만, 구독된 스레드라 **재멘션·재선언도 여기(onReply)로 온다**.
  //   새 자연어 선언이면 다시 파싱해 해당 핸들러로 넘긴다 — handleNlIntake 가 이전 인입 대기를 무효화하고 다시 제안한다
  //   (거부/불완전이면 대기 없음 → 옛 카드 확정 불가). 그 외(잡담·실행요청)는 무시(확정은 버튼 — 잠긴 결정 6).
  if (pending.kind === "intake") {
    const t = text.trim();
    if (!t || hasAttachments) return; // 빈/첨부는 무시(대기 보존).
    // ⚠ 경쟁 차단(Codex P3): 비동기 재파싱(nl.parse — LLM 이면 네트워크 대기) 전에 이전 인입 대기를 **먼저** 비운다.
    //   파싱 대기 중 동시 확정 클릭이 옛 대기를 확정하는 레이스를 닫는다(파싱 창 동안 확정 대상이 없음).
    //   fail-closed: 애매한 메시지(잡담 등)면 대기는 비운 채 두고, 사람이 다시 선언하게 한다(옛 카드 확정 불가).
    await gw.pending.clear(threadId);
    const intent = await gw.nl.parse(t, { hasRun: false });
    if (intent.kind === "intake") {
      await handleNlIntake(threadId, gw, intent);
    } else if (intent.kind === "setup") {
      await handleNlSetup(threadId, gw, intent);
    }
    return;
  }

  // 그 외는 feedback.
  if (pending.kind !== "feedback") return;
  const feedback = text.trim();
  if (!feedback) return;
  if (!gw.isApprover(actor)) {
    // 보완(revise)은 상태변이 — 승인자 답글만 수용(pending 유지, 승인자가 다시 답글).
    await gw.chat.render(threadId, progressP(toViewModel(await gw.readNext(pending.rid).catch(() => stubNext(pending.rid))), "보완 요청 권한이 없어요 — 담당자가 답글로 적어 주세요."));
    return;
  }
  await gw.pending.clear(threadId);
  await gw.queue.submit({ kind: "revise", run_id: pending.rid, actor, payload: { feedback } });
}

/**
 * ③′ 다안 선택([이걸로]) — 선택은 상태변이라 승인자만(revise 와 동일 게이트). run_id 는 스레드↔run 매핑으로
 *   해석한다(1 스레드=1 run · 클라이언트 run_id 불신). 지금 정말 선택 차례일 때만 select 잡을 만든다
 *   (stale 카드 재클릭 방어 — worker.ts 의 stale-ingest 가드와 같은 결).
 */
export async function onChoice(ev: ChoiceMade, gw: Gateway): Promise<{ enqueued?: Job } | void> {
  const { optionKey, actor, threadId } = ev;
  if (!gw.isApprover(actor)) return; // 워커도 재검사하지만 방어적으로(잡 미생성)
  const key = (optionKey ?? "").trim();
  if (!key) return;
  const rid = threadId ? await gw.map.runForThread(threadId) : null;
  if (!rid || !threadId) return; // 스레드에 바인딩된 run 이 없으면 무시(어느 run 을 고른 건지 불명)
  const na = await gw.readNext(rid).catch(() => null);
  if (!na || na.action !== "select") {
    // 지난 선택 카드 재클릭 등 — 상태를 건드리지 않고 평이 안내만(no-op).
    await gw.chat.render(threadId, progressP(toViewModel(na ?? stubNext(rid)), "지금은 고를 차례가 아니에요."));
    return;
  }
  // ⚠ stale 다안 가드: 같은 옵션 키(A/B/C)가 재생성·다음 단계에서 재사용된다. 클릭이 낸 도장(phase·iteration)이
  //   지금의 select 게이트와 다르면(다시 제안으로 새 안이 나왔거나 다음 단계로 넘어간 옛 카드), 그 옛 카드를 보고 고른
  //   것이므로 선택을 만들지 않는다 — 최신 안에서 다시 고르도록 안내(현업이 검토한 것과 감사 기록이 어긋나는 것 방지).
  const phaseMismatch = ev.expectedPhase !== undefined && ev.expectedPhase !== na.phase;
  const iterMismatch = ev.expectedIteration !== undefined && (ev.expectedIteration ?? null) !== (na.iteration ?? null);
  if (phaseMismatch || iterMismatch) {
    await gw.chat.render(threadId, progressP(toViewModel(na), "새로운 안이 준비돼 있어요 — 최신 안에서 [이걸로]를 다시 눌러 주세요."));
    return;
  }
  const job: Job = { kind: "select", run_id: rid, actor, payload: { option: key } };
  await gw.queue.submit(job);
  return { enqueued: job };
}

/** ④ 잡 완료 → 다음 표현으로 스레드 갱신 + 자동 단계(생성/심의)는 스스로 이어간다. */
export async function onOutcome(outcome: WorkerOutcome, gw: Gateway, job?: Job): Promise<void> {
  const threadId = await gw.map.threadForRun(outcome.run_id);
  if (!threadId) return;

  // 실패면 자동 재시도하지 않고 사유를 알린다 — next-action 이 그대로라 같은 잡을 무한 재큐하는 것 방지.
  //   카드에 [상태 다시 확인]을 붙인다(프로토콜 v2 화해): 생성 대기 상한 초과처럼 '봇은 포기했지만 소비자가
  //   늦게 성공할 수 있는' 실패가 있어, 사람이 스스로 지금 상태를 물어볼 수 있어야 스레드가 고아가 되지 않는다.
  if (!outcome.ok) {
    // ── 리뷰 실패 특례: 잡-레벨 재적재(chat-review-retry-plan 2-3) ─────────────────────
    // ⚠ **의도적 리뷰-전용 경계**(적용 whack-a-mole 예방 — STALL-LOG). 이 특례가 이 kind 에만 걸리는 이유:
    //   · 진짜 위반(deny)은 절대 여기 안 온다 — verdict=fail 은 kcia-check 가 **정상 종료(exit 0)** 하고 게이트를
    //     revise 로 전이하므로 `ok:true` 리뷰 아웃컴으로 도착한다(이 `!outcome.ok` 분기에 진입 불가). 즉 flaky 로
    //     가릴 구조적 여지가 없다(회귀 잠금 = 아래 deny 테스트).
    //   · 여기 들어오는 리뷰는 '심의를 끝내지 못한' 비-0 종료(ADK 비결정 빈응답/블록누락·타임아웃·REQUIRED die)뿐이다.
    //   · 생성/인입 실패는 각자 복구(GenerateRetry·재붙여넣기)가 있어 이 특례에서 **의도적으로 제외**한다.
    //   · revise 사이클 뒤 새 심의는 자동 캐스케이드(아래 auto 이어가기)가 `payload:{}` 로 적재 → **사이클마다 예산이
    //     새로 시작**한다(무한 아님: revise 사이클 자체가 escalation 상한으로 bounded — 의도).
    if (outcome.kind === "review") {
      const attempt = typeof job?.payload.attempt === "number" ? job.payload.attempt : 0;
      const max = gw.reviewRetry?.max ?? 0;
      const backoffMs = gw.reviewRetry?.backoffMs ?? [];
      const next = outcome.next;
      // ── 하류 원-게이트 결박(P2 TOCTOU): 재적재 잡(서명 동봉)이 워커 stale 가드에 걸려 돌아왔는데, 그 사이 런이
      //   **다음 페이즈의 review 게이트**까지 전진했으면 next.action 은 여전히 "review" 다 — action 만 보는 아래
      //   재시도 분기가 이 stale 에코를 **새 게이트의 재시도**로 승계하거나(옛 예산 + 캐스케이드 정규 리뷰와 중복),
      //   소진 시 거짓 '소진 Failure' 를 그린다. 잡에 실린 원 게이트 서명(phase·stage·iteration)이 next 와 어긋나면
      //   이 outcome 은 지난 게이트의 메아리이므로 재시도/Failure 어느 쪽도 아니고, 현재 게이트 카드 재파생이 진실이다.
      //   서명 없는 잡(최초 리뷰 payload:{})은 stale 가드 대상이 아니라 이 검사를 건너뛴다(후방호환).
      const jobSigPhase = typeof job?.payload.phase === "string" ? job.payload.phase : undefined;
      if (next && jobSigPhase !== undefined) {
        const staleEcho =
          jobSigPhase !== next.phase ||
          (job?.payload.stage ?? null) !== (next.stage ?? null) ||
          (job?.payload.iteration ?? null) !== (next.iteration ?? null);
        if (staleEcho) {
          const p = await presentationForStatusCheck(next, gw.readSurface);
          await gw.chat.render(
            threadId,
            p ?? progressP(toViewModel(next), "아직 진행 중이에요 — 잠시 후 다시 확인해 주세요."),
          );
          return;
        }
      }
      // 재시도 대상: 게이트가 그대로 '심의 미완'(next.action==="review")이고 예산이 남았을 때만.
      //   next 가 null(읽기 실패)이거나 다른 action(그 사이 수동 전이 등)이면 재시도하지 않는다(fail-closed 쪽으로).
      if (next?.action === "review" && attempt < max) {
        const nth = attempt + 1; // N번째 시도(1-기반)
        const total = max + 1; // 총 시도 횟수(최초 1 + 재적재 max)
        // ⚠ 원 게이트 서명(스케줄 시점 스냅샷 · P2): 재적재 직전 재확인이 **정확히 이 게이트**(phase·stage·iteration)일
        //   때만 다시 돈다. 백오프(60/300초) 중 다른 프로세스가 런을 다음 페이즈의 review 로 전진시키면 action 은 그대로
        //   review 라, 서명 없이 action 만 보면 옛 타이머가 나중 게이트 리뷰로 승계된다(이전 게이트 재시도 예산을 갖고 ·
        //   캐스케이드가 낸 정규 리뷰와 중복). 서명으로 그 승계를 끊는다.
        const gateSig = { phase: next.phase, stage: next.stage ?? null, iteration: next.iteration ?? null };
        // ⚠ 이 카드는 어떤 심의 판정도 단언하지 않는다 — 통과/합격/실패 판정 금지(STALL-LOG 2026-07-19 P1: 비권위
        //   채널의 근거 없는 규정 통과 주장 = P1 위험). "일시 문제로 끝나지 않았고 잠시 뒤 다시 점검한다"만 말한다.
        await gw.chat.render(
          threadId,
          progressP(
            toViewModel(next),
            `규정 점검이 일시적인 문제로 끝나지 않았어요 — 잠시 뒤 자동으로 다시 점검합니다 (${nth}번째 시도 / 최대 ${total}번).`,
          ),
        );
        // 감사 1줄(관측성 — 조용한 재시도 금지 · 계획 2-5). 콘솔 진단용이라 내부 용어 허용(현업 카드 아님).
        console.log(
          `[review-retry] rid=${outcome.run_id} stage=${next.stage ?? next.phase} attempt=${attempt} -> retry ${nth}/${total}`,
        );
        // fire-and-forget: 싱크를 백오프로 점유하지 않는다(run 별 FIFO 체인이 대기에 묶이지 않게 · 계획 2-2). 예외는 전부 흡수.
        const sleep = gw.delay ?? realSleep;
        void (async () => {
          try {
            await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0);
            // 재적재 직전 재확인 — 대기 중 상태가 전진했으면(수동 전이·늦은 성공) 포기(로그만). 게이트 불변일 때만 다시 돈다.
            let na: NextAction | null;
            try {
              na = await gw.readNext(outcome.run_id);
            } catch {
              // ⚠ 읽기 실패(reject)는 '게이트 전진'이 아니다 — null→포기로 뭉개면 "다시 점검합니다" 카드가 거짓 약속으로 남고
              //   런이 review 에 고착된다(조용한 스트랜딩 금지 · 계획 2-4). 그래서 읽기 실패는 보이는 fail-closed 로 끊는다.
              await gw.chat.render(
                threadId,
                failureP(toViewModel(stubNext(outcome.run_id)), "규정 점검을 다시 시작하지 못했어요 — 담당자 확인이 필요해요."),
              );
              return;
            }
            // 원 게이트 서명 결박(P2): action==="review" 이고 phase·stage·iteration 이 스케줄 시점과 전부 일치할 때만 재적재.
            const sigMatch =
              na.action === "review" &&
              na.phase === gateSig.phase &&
              (na.stage ?? null) === gateSig.stage &&
              (na.iteration ?? null) === gateSig.iteration;
            if (sigMatch) {
              // 재적재 잡에 원 게이트 서명을 실어 워커 stale 가드도 같은 결박을 적용하게 한다(양쪽 결박).
              await gw.queue.submit({
                kind: "review",
                run_id: outcome.run_id,
                actor: AUTO_ACTOR,
                payload: { attempt: attempt + 1, phase: gateSig.phase, stage: gateSig.stage, iteration: gateSig.iteration },
              });
            } else {
              // 성공적으로 읽었으나 (a) 게이트가 전진(action≠review) 또는 (b) 서명 불일치(다음 페이즈 review 로 전진) —
              //   둘 다 이 재적재는 이미 지난 게이트 얘기라 폐기한다. 전이/캐스케이드가 낸 새 카드가 이미 자리를 덮는다. 로그만.
              const reason = na.action !== "review" ? "gate advanced" : "gate signature mismatch";
              console.log(`[review-retry] rid=${outcome.run_id} abandon(${reason}) attempt=${attempt}`);
            }
          } catch {
            // 재적재 경로의 어떤 실패도 흡수 — 싱크 밖 IIFE 라 throw 하면 unhandled rejection 이 된다(소진 fail-closed 는 별도 경로).
          }
        })();
        return;
      }
      // ── P1: 무해한 stale/경합 실패는 Failure 가 아니라 현재 게이트 카드로 그린다 ─────────────────────
      // 재시도 대상이 아닌데(위 if 미진입) 게이트가 이미 review 를 지났으면(next.action≠review), 이 리뷰 outcome 은
      //   무엇이었든(워커 stale-review 스킵·경합 실패) **이미 지난 얘기**다 — 런은 다른 프로세스가 이미 전진시켰다.
      //   게이트가 review 가 아니면 그 리뷰 결과는 지난 게이트의 것이므로 Failure 는 거짓 신호다. 게다가 아티팩트
      //   세션화 + 전 세션 집계 리포트의 failure-zero 기준을 이 거짓 Failure 가 **영구 오염**시킨다. 그래서 Failure 대신
      //   reconcile 과 같은 재파생(presentationForStatusCheck)으로 현재 게이트 카드를 그린다 — 지어낸 버튼 0(readNext
      //   재파생만) · 생성 차례면 GenerateRetry 카드(그 함수의 기존 규약). null(카드 없음)이면 reconcile 490행과 같은
      //   문구 결의 progressP 폴백.
      //   ⚠ next=null(읽기 실패)·여전히 review(진짜 심의 미완/소진)는 이 분기에 안 들어와 아래 Failure 를 유지한다(fail-closed 불변).
      if (next && next.action !== "review") {
        const p = await presentationForStatusCheck(next, gw.readSurface);
        await gw.chat.render(
          threadId,
          p ?? progressP(toViewModel(next), "아직 진행 중이에요 — 잠시 후 다시 확인해 주세요."),
        );
        return;
      }
      // 소진 또는 비대상 → fail-closed. 재시도가 설정·소비된 경우(max>0 && attempt>=max)엔 소진 문구로 1회 실패와 구분(계획 2-5).
      //   [상태 다시 확인] affordance 는 기존 그대로(failureP). 비대상(next=null·still-review 소진)은 기존 사유 문구(오늘과 동일).
      const exhausted = max > 0 && attempt >= max;
      const message = exhausted
        ? "여러 번 다시 점검했지만 끝나지 않았어요 — 담당자 확인이 필요해요."
        : outcome.message;
      await gw.chat.render(threadId, failureP(toViewModel(next ?? stubNext(outcome.run_id)), message));
      return;
    }
    // ── 사람-결정(approve/select) 실패의 게이트-전진 진실 검사 — 진 클릭을 Failure 로 그리지 않는다 ──
    //   드라이버 자동 주행과 사람 클릭(라이브 배선)·사람끼리의 동시 클릭은 큐 FIFO 가 중재한다: 첫 잡이 게이트를
    //   전진시키면 둘째 잡은 core 가 멱등 거부한다(ok:false). 그 거부는 오류가 아니라 **이미 처리된 결정**인데,
    //   Failure 카드로 그리면 (a) 개입한 사람이 실패로 오독하고 (b) 세션 트랜스크립트 집계 리포트의 failure-zero 를
    //   영구 오염시킨다. next 가 그 kind 의 차례가 더는 아니면(전진 증거) 현재 게이트 카드 재파생이 진실이다.
    //   ⚠ 같은 kind 차례가 그대로면(진짜 그 게이트의 실패 — 예: RA 요건) 기존 Failure 유지(fail-closed 불변).
    //   ⚠ review 는 위 특례가 같은 검사를 이미 수행하고, generate 는 GenerateRetry 회복 경로가 따로 있다(범위 밖).
    if ((outcome.kind === "approve" || outcome.kind === "select") && outcome.next && outcome.next.action !== outcome.kind) {
      const p = await presentationForStatusCheck(outcome.next, gw.readSurface);
      await gw.chat.render(
        threadId,
        p ?? progressP(toViewModel(outcome.next), "이미 처리된 결정이에요 — 최신 카드에서 이어가 주세요."),
      );
      return;
    }
    await gw.chat.render(threadId, failureP(toViewModel(outcome.next ?? stubNext(outcome.run_id)), outcome.message));
    return;
  }

  // 성공 시 stale 대기 정리(wb: 인입 성공 시만 · feedback: 다른 성공 동작으로 게이트 전진 시 무효화).
  {
    const cur = await gw.pending.get(threadId);
    if (cur?.kind === "wb" && cur.rid === outcome.run_id && outcome.kind === "ingest") {
      await gw.pending.clear(threadId);
    }
    if (cur?.kind === "feedback" && cur.rid === outcome.run_id) {
      await gw.pending.clear(threadId);
    }
  }

  const p = await presentationForOutcome(outcome, readOptionsDoc, readKeyvisualOptions, gw.readSurface);
  if (p) await gw.chat.render(threadId, p);

  // 자동 단계 이어가기(성공 시만): 심의는 항상 자동, 생성은 AUTO_GENERATE_STAGES(브리프~스토리보드)까지 자동.
  //   select(다안)는 자동이 아니다 — OptionSet 을 게시하고 사람의 [이걸로]를 기다린다(위 presentationForOutcome).
  const na = outcome.next;
  if (na && na.action === "review") {
    await gw.queue.submit({ kind: "review", run_id: outcome.run_id, actor: AUTO_ACTOR, payload: {} });
  } else if (na && na.action === "generate") {
    if (na.stage && AUTO_GENERATE_STAGES.has(na.stage)) {
      // P2: keyvisual 도 자동 생성한다(생성 후 이미지 다안을 제시 → 사람 선택 대기 = presentationForOutcome 의 ImageOptionSet).
      await gw.queue.submit({ kind: "generate", run_id: outcome.run_id, actor: AUTO_ACTOR, payload: { stage: na.stage } });
    } else {
      // 자동 대상이 아닌 미지 생성 단계 — 자동 잇지 않고 담당자에게 안내(방어적 폴백).
      await gw.chat.render(
        threadId,
        progressP(toViewModel(na), "여기까지 자동으로 진행했어요 — 다음 단계는 담당자와 함께 진행하세요."),
      );
    }
  }
}

/**
 * outcome.next → 현업에게 보일 중립 표현. 심의=verdict · 인입/승인=사람 표현 · 다안=OptionSet ·
 *   생성/심의진행=상태 표현. select 분기만 options-compare.md 를 읽으므로 async 다(readOptions 주입 가능 — 테스트용).
 */
export async function presentationForOutcome(
  outcome: WorkerOutcome,
  readOptions: (rid: string, phase: string) => Promise<OptionsDoc> = readOptionsDoc,
  readKeyvisual: (
    rid: string,
    keys: string[],
    recommended: string | null,
  ) => Promise<KeyvisualOption[]> = readKeyvisualOptions,
  readSurface: ReadSurface = NO_SURFACE,
): Promise<Presentation | null> {
  const na = outcome.next;
  if (!na) return null;
  // 심의(review) 아웃컴은 verdict 로 보인다 — 단 에스컬레이션(raise-limit)·완료(done)는 그 전에 각자 복구/마무리 화면으로
  //   (escalate 버튼만 뜨는 stuck 방지 · done 은 pass verdict 대신 마지막 화면). 그 판정은 presentationForNext 상단이 처리.
  if (outcome.kind === "review" && na.action !== "raise-limit" && na.action !== "done") {
    return verdictP(toViewModel(na), deriveVerdict(na));
  }
  return presentationForNext(na, readOptions, readKeyvisual, readSurface);
}

/**
 * NextAction → 지금 게이트의 중립 표현(verdict 특수처리 없음 — 순수 '다음 할 일' 매핑). onReply 의 자연어 실행 요청에
 *   대응해 현재 게이트 버튼 카드를 재게시할 때도 쓴다(NL 은 실행하지 않고 카드만 다시 띄운다 — 잠긴 결정 6).
 */
export async function presentationForNext(
  na: NextAction,
  readOptions: (rid: string, phase: string) => Promise<OptionsDoc> = readOptionsDoc,
  readKeyvisual: (
    rid: string,
    keys: string[],
    recommended: string | null,
  ) => Promise<KeyvisualOption[]> = readKeyvisualOptions,
  readSurface: ReadSurface = NO_SURFACE,
): Promise<Presentation | null> {
  const vm = toViewModel(na);
  // ⚠ surface 는 인터랙티브 게이트(approve/select)에서만 읽는다 — escalation/generate/review/ingest/done 은 소싱할
  //   boolean 이 없어(Escalation 은 reviseAvailable 필드 자체가 없음) 읽어도 소비할 곳이 없다 → 불필요 spawn 회피.
  if (na.action === "raise-limit") return escalationP(vm);
  if (na.action === "done") return doneP(vm, na);
  switch (na.action) {
    case "ingest":
      return ingestP(vm);
    case "approve":
      return approveP(na, readSurface);
    case "select":
      // 04-keyvisual 은 이미지 다안(ImageOptionSet), 그 외(02-concept·03-storyboard)는 md 다안(OptionSet).
      return na.phase === "04-keyvisual"
        ? imageOptionSetP(na, readKeyvisual, readSurface)
        : optionSetP(na, readOptions, readSurface);
    case "generate":
      return progressP(vm, "만드는 중이에요…");
    case "review":
      return progressP(vm, "규정 점검 중이에요…");
    default:
      return null;
  }
}

/**
 * select next → OptionSet 표현. 안별 제목/본문은 options-compare.md(부재 시 키만) — 콘텐츠 매칭 키는 기존 소스 유지.
 *   surface 오버레이는 **reviseAvailable boolean 만** 소싱한다(surface 있으면 actions.includes("revise"), 없으면 na).
 *   options/recommended 는 surface 로 대체하지 않는다(둘 다 na 와 동치지만 콘텐츠 매칭 키는 기존 na 소스 유지 — 불변식 5).
 *   ⚠ 1차 액션(select)은 surface.actions 로 억제하지 않는다 — approveP 주석의 1차/2차 비대칭 근거와 동일(1차는 na.action
 *     라우팅으로 결정 = surface 와 동일 파생 · 억제하면 '선택 버튼 없는 다안'이라는 망가진 카드).
 */
async function optionSetP(
  na: NextAction,
  readOptions: (rid: string, phase: string) => Promise<OptionsDoc>,
  readSurface: ReadSurface,
): Promise<OptionSetPresentation> {
  const doc = await readOptions(na.rid, na.phase);
  const surface = gateConsistentSurface(await readSurface(na.rid).catch(() => null), na); // 게이트 스냅샷 일치 시만(TOCTOU 방어)
  const keys = Array.isArray(na.options) ? na.options : [];
  const options = keys.map((key) => {
    const sec = findSection(doc.sections, key);
    return {
      key,
      title: sec?.title ?? key,
      body: sec?.body ?? "",
      recommended: key === na.recommended,
    };
  });
  return {
    type: "OptionSet",
    rid: na.rid,
    header: na.phase_label ?? "",
    phase: na.phase,
    iteration: na.iteration ?? null,
    options,
    compareMd: doc.compareMd,
    reviseAvailable: surface ? surface.actions.includes("revise") : (na.revise_available ?? false),
  };
}

/**
 * keyvisual select next → ImageOptionSet 표현. 안별 미리보기 이미지·캡션은 keyvisual-reader(부재 시 빈 경로) — 콘텐츠
 *   경계 불변(불변식 5). surface 오버레이는 optionSetP 와 동일하게 **reviseAvailable boolean 만** 소싱한다.
 */
async function imageOptionSetP(
  na: NextAction,
  readKeyvisual: (rid: string, keys: string[], recommended: string | null) => Promise<KeyvisualOption[]>,
  readSurface: ReadSurface,
): Promise<ImageOptionSetPresentation> {
  const keys = Array.isArray(na.options) ? na.options : [];
  const opts = await readKeyvisual(na.rid, keys, na.recommended ?? null);
  const surface = gateConsistentSurface(await readSurface(na.rid).catch(() => null), na); // 게이트 스냅샷 일치 시만(TOCTOU 방어)
  return {
    type: "ImageOptionSet",
    rid: na.rid,
    header: na.phase_label ?? "",
    phase: na.phase,
    iteration: na.iteration ?? null,
    options: opts.map((o) => ({
      key: o.key,
      imagePaths: o.imagePaths,
      caption: o.caption,
      recommended: o.recommended,
    })),
    reviseAvailable: surface ? surface.actions.includes("revise") : (na.revise_available ?? false),
  };
}

/** done next → 완료(Done) 표현. 최종 산출물 경로(files)가 있으면 곁들이고, 없으면 평이 완료 한 줄만. */
function doneP(vm: ViewModel, na: NextAction): DonePresentation {
  const files = Array.isArray(na.files) ? na.files.filter((f): f is string => typeof f === "string") : [];
  return {
    type: "Done",
    rid: vm.rid,
    header: vm.header || "완료",
    message: "모든 단계를 마쳤어요 — 최종 결과물이 준비됐어요.",
    files,
  };
}

/**
 * 심의 결과를 next-action **status** 로 유도(step 무관 — pass 도 다음 단계 생성이라 step=generate).
 *   escalated→human · (revise|changes_requested)→revise · 그 외→pass.
 */
export function deriveVerdict(na: NextAction): VerdictOutcome {
  if (na.status === "escalated") return "human";
  if (na.status === "revise" || na.status === "changes_requested") return "revise";
  return "pass";
}

/** readNext 실패 시 안전 폴백(표현이 최소 렌더되게 — 라벨 없음). */
function stubNext(rid: string): NextAction {
  return {
    rid,
    phase: "00-ingest",
    phase_label: "",
    step: "generate",
    gate: "None",
    status: "pending",
    awaiting: null,
    iteration: null,
    max_iterations: null,
    action: "ingest",
    stage: null,
    needs: "bundle_dir",
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
  } as unknown as NextAction;
}

// ── 조립 ─────────────────────────────────────────────────────────────────────

export interface GatewayDeps {
  newRun?: typeof defaultNewRun;
  readNext?: (rid: string) => Promise<NextAction>;
  /** A2UI 읽기 표면 오버레이(기본 = readA2uiSurface: 실 a2ui-surface.sh spawn · best-effort null). 테스트가 fake 주입. */
  readSurface?: ReadSurface;
  isApprover?: (actor: string) => boolean;
  bundleDir?: () => string | undefined;
  stagedWbPath?: () => string | undefined;
  /** 자연어 파서(P3 · 기본 = selectNlParser: 오프라인/무키=stub · 온라인+키=실 LLM). */
  nl?: NlParser;
  /** NL 파일 인입 allowlist 루트(기본 = config.nlFileRoots). */
  nlFileRoots?: () => string[];
  /** 플랫폼 어댑터가 구현한 ChatPort(중립 표현 렌더 + 구독). */
  chat: ChatPort;
  stateDir?: string;
}

/** 게이트웨이(잡큐·워커·상태·매핑·대기입력) 조립. gen 은 오프라인=stub 직접, 온라인=브리지(C2). */
export function createGateway(deps: GatewayDeps): Gateway {
  const state = new FileStateAdapter(deps.stateDir);
  const map = new ThreadRunMap(state);
  const pending = new PendingInputStore(state);
  const gw: Gateway = {
    queue: undefined as unknown as JobQueue,
    map,
    pending,
    newRun: deps.newRun ?? defaultNewRun,
    readNext: deps.readNext ?? defaultReadNextAction,
    // production 오버레이 소비(opt-in): 실 클라이언트를 켠다 — 인터랙티브 게이트에서 a2ui-surface.sh 를 실제로 타
    //   버튼셋 boolean 을 교차확인한다(현재 상태 출력은 동등 · 미래 drift 보호). 테스트는 fakeGateway 가 null-object 주입.
    readSurface: deps.readSurface ?? defaultReadA2uiSurface,
    isApprover: deps.isApprover ?? defaultIsApprover,
    bundleDir: deps.bundleDir ?? defaultBundleDir,
    stagedWbPath: deps.stagedWbPath ?? defaultStagedWbPath,
    nl: deps.nl ?? selectNlParser(),
    nlFileRoots: deps.nlFileRoots ?? defaultNlFileRoots,
    // 잡-레벨 리뷰 재적재(chat-review-retry-plan)의 시계·예산. 조립 시점에 config 게터를 읽는다 — 오설정이면
    //   여기서 fail-fast(selectNlParser 와 같은 자세): 봇이 뜬 채로 조용히 잘못된 재시도 예산을 쓰는 것보다 낫다.
    delay: realSleep,
    reviewRetry: { max: reviewRetryMax(), backoffMs: reviewRetryBackoffMs() },
    chat: deps.chat,
  };
  // 생성 실행기 선택(선택기 단일화): 오프라인=Stub · 온라인=Bridge(C2, 기본) · S-1(무인) 채택+SDK 배선 시 AgentSdk.
  //   이 레포엔 sdkGenerate 를 넘기지 않으므로 온라인은 항상 Bridge(동작 불변) — S-1 활성화는 배선 추가만.
  //   onProgress: 브리지가 긴 생성 구간에 증분 진행을 표시하도록 배선(rid→threadId→render · best-effort · **표시 전용**,
  //   전이/마감 판정과 무관). 이 클로저는 잡 실행 중(createGateway 반환 뒤)에만 불리므로 gw 가 완전 초기화된 뒤 실행된다.
  const gen = selectGenExecutor({ onProgress: (rid, message) => renderProgress(gw, rid, message) });
  const worker = new Worker({ gen });
  gw.queue = new JobQueue({ worker, onOutcome: (outcome, job) => onOutcome(outcome, gw, job) });
  return gw;
}
