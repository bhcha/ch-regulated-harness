/**
 * render.ts — 중립 Presentation → Slack Block Kit 카드(vercel/chat 함수형 API · JSX 미사용).
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-3): 이 파일은 **Slack 어댑터의 렌더 세부**다. 커널이 내보낸
 *   중립 표현(kernel/presentation.ts)을 Slack 네이티브 UI(카드·버튼·Select)로 번역한다. GChat 어댑터는
 *   같은 Presentation 을 Cards v2 로 번역할 것이다(커널·표현은 무수정 — 구조 분리의 증명).
 *
 * ⚠ 라벨 passthrough: header(=phase_label)·gateLabel·hint 는 커널이 실어 준 core 산출을 **그대로** 싣는다
 *   (번역/트림 금지). 카드 고유의 UI 문구(안내·상태 이모지·버튼 라벨)만 이 파일이 소유한다.
 *   단 하나의 예외 = **카드 제목의 Slack 하드리밋 clamp**(clampTitle): 카드 title 은 Slack header 블록
 *   (plain_text 최대 150자)으로 게시되는데, SDK 전송 경로가 절단 없이 그대로 싣기 때문에 151자 이상이면 Slack 이
 *   `invalid_blocks` 로 **post 전체를 거부**한다(라이브 실측: 03-storyboard 다안 제목 173자 → 안 카드 3장+트레일링
 *   카드 소실). 150자 이하는 바이트 불변(passthrough 유지)이고, 초과분만 말줄임(…)한다 — 자르지 않으면 정보 보존이
 *   아니라 카드 소실이다(전문은 body 로 보존, renderOptionSet 참조).
 *
 * ⚠ 카드 텍스트 팩토리는 `Text` 가 아니라 **`CardText`** 다(`chat` 루트에서 `Text` 는 mdast 노드와 충돌해
 *   런타임 export 가 undefined). 버튼 style 은 `"primary" | "danger"` 만 명시(그 외 = 중립 기본).
 */
import { Actions, Button, Card, CardText, Select, SelectOption } from "chat";
import type { ButtonElement, CardChild, CardElement, SelectOptionElement } from "chat";
import {
  GENERATE_RETRY_ACTION_ID,
  INGEST_STAGED_ACTION_ID,
  NL_INTAKE_CONFIRM_ACTION_ID,
  RA_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
} from "../../kernel/interaction.js";
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
} from "../../kernel/presentation.js";

// 어댑터가 재노출(구 cards.ts 호환 · 봇 배선/테스트 참조).
export {
  GENERATE_RETRY_ACTION_ID,
  INGEST_STAGED_ACTION_ID,
  NL_INTAKE_CONFIRM_ACTION_ID,
  RA_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
};

// ── 카드 고유 UI 문구 (라벨 passthrough 대상 아님 — 카드 자체 chrome) ─────────
const SETUP_PROMPT =
  "① 제품명을 이 스레드에 **답글로** 알려 주세요 · ② 규제도메인과 산출물 포맷을 고른 뒤 [시작]을 눌러 주세요.";
const SETUP_PRODUCT_MISSING = "제품명: (아직 없음 — 답글로 알려 주세요)";
const PASTE_PROMPT = "제품 자료(제품 소개·핵심 문서) 본문을 이 스레드에 **답글로 붙여넣어** 주세요.";
const STAGED_HINT = "크롤 자료 묶음(제품 정보·리뷰·이미지)은 운영자가 미리 준비합니다.";
const RA_INDICATOR = "RA(담당자) 사후 확인 필요";
const RA_CONFIRM_PROMPT =
  "기능성 표시가 있어 담당자(RA) 확인이 필요해요. 확인이 끝났으면 아래 버튼으로 승인을 완료해 주세요.";
const OPTION_RECOMMEND_BADGE = "⭐ 추천 · ";
const OPTION_REPLY_HINT =
  "마음에 드는 안의 [이걸로]를 눌러 주세요. 직접 쓰고 싶으면 이 스레드에 답글로 적어 주셔도 돼요.";
const IMAGE_OPTION_HINT = "위 미리보기 중 마음에 드는 디자인의 [이걸로]를 눌러 주세요.";
const NL_PROPOSAL_TITLE = "이렇게 이해했어요";
const FAILURE_RECONCILE_HINT =
  "그새 처리가 끝났을 수도 있어요 — [상태 다시 확인]을 누르면 지금 상태를 다시 알려드릴게요.";
const GENERATE_RETRY_HINT = "[다시 만들기]를 누르면 처음부터 다시 요청할게요.";
const VERDICT_STATUS: Record<VerdictOutcome, string> = {
  pass: "통과 🟢",
  revise: "보완 🟠",
  human: "사람확인 🔴",
};

// 규제도메인/포맷 선택지 — value = core `new-run.sh` 가 받는 CLI 토큰(별칭). passthrough 로 그대로 제출된다.
const DOMAIN_OPTIONS: SelectOptionElement[] = [
  SelectOption({ label: "화장품", value: "화장품" }),
  SelectOption({ label: "의약외품", value: "의약외품" }),
  SelectOption({ label: "건기식", value: "건기식" }),
  SelectOption({ label: "의약품", value: "의약품" }),
];
const FORMAT_OPTIONS: SelectOptionElement[] = [
  SelectOption({ label: "한장", value: "한장" }),
  SelectOption({ label: "여러장", value: "여러장" }),
];

/** 버튼 payload — 항상 `{ run_id, action }`(snake_case run_id). value 는 단일 문자열이라 JSON.stringify 로 싣는다. */
function payload(runId: string, action: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ run_id: runId, action, ...(extra ?? {}) });
}

/** Slack header 블록 plain_text 한도(문자 수) — 151자 이상이면 API 가 post 전체를 invalid_blocks 로 거부한다. */
export const SLACK_HEADER_TITLE_MAX = 150;

/**
 * 카드 제목 clamp — 한도 이하는 **바이트 불변**(passthrough 원칙 유지), 초과분만 149자+말줄임(…)으로 줄인다.
 *   코드포인트 단위로 자른다(서로게이트 쌍/이모지를 반 토막 내 깨진 문자를 만들지 않게).
 *   ⚠ 이것은 번역/트림이 아니라 전달 보장이다: 넘치면 Slack 이 그 post 를 통째로 거부해 카드 자체가 소실된다
 *   (버튼 payload 는 title 이 아니라 key/rid 를 쓰므로 선택·승인 동작은 clamp 와 무관).
 */
export function clampTitle(title: string): string {
  const cps = Array.from(title);
  if (cps.length <= SLACK_HEADER_TITLE_MAX) return title;
  return `${cps.slice(0, SLACK_HEADER_TITLE_MAX - 1).join("")}…`;
}

/** 새 작업 설정 카드 — 카드 내 Select 2개 + [시작] 버튼(제품명은 답글로 수집). */
export function renderSetup(p: SetupPresentation): CardElement {
  return Card({
    title: "새 작업 시작",
    children: [
      CardText(SETUP_PROMPT),
      CardText(p.product ? `제품명: ${p.product}` : SETUP_PRODUCT_MISSING),
      Actions([
        // ⚠ placeholder 필수: Actions 블록 안 Select 는 Slack 변환에서 label 이 무시되고 placeholder 만 노출된다.
        Select({
          id: SETUP_ACTION_IDS.domain,
          label: "규제도메인",
          placeholder: "규제도메인 선택",
          options: DOMAIN_OPTIONS,
          ...(p.domain ? { initialOption: p.domain } : {}),
        }),
        Select({
          id: SETUP_ACTION_IDS.format,
          label: "산출물 포맷",
          placeholder: "산출물 포맷 선택",
          options: FORMAT_OPTIONS,
          ...(p.format ? { initialOption: p.format } : {}),
        }),
        Button({ id: SETUP_ACTION_IDS.start, label: "시작", style: "primary" }),
      ]),
    ],
  });
}

/** RA(담당자) 확인 카드 — 2단계 명시 확인. [확인 완료 · 승인] 클릭만이 ra_ok=true 승인 잡을 만든다. */
export function renderConfirmGate(p: ConfirmGatePresentation): CardElement {
  return Card({
    title: "담당자(RA) 확인",
    children: [
      CardText(RA_CONFIRM_PROMPT),
      Actions([
        Button({
          id: RA_CONFIRM_ACTION_ID,
          label: "확인 완료 · 승인",
          style: "primary",
          value: payload(p.rid, "approve"),
        }),
      ]),
    ],
  });
}

/** 진행 상태 카드(자동 단계·안내 한 줄). 버튼 없음. 헤더(header)는 passthrough. */
export function renderProgress(p: ProgressPresentation): CardElement {
  return Card({ title: clampTitle(p.header), children: [CardText(p.message)] });
}

/**
 * 실패 카드 — 사유(passthrough) + [상태 다시 확인]. 그 버튼은 **읽기 전용 화해**다: 봇이 대기 상한에 포기한 뒤에도
 *   잡을 집어 간 소비자가 늦게 성공할 수 있어(프로토콜 v2 보증 3분법), 사람이 지금 상태를 다시 물을 수 있어야 한다.
 */
export function renderFailure(p: FailurePresentation): CardElement {
  return Card({
    title: clampTitle(p.header),
    children: [
      CardText(p.message), // 워커의 평이 회신(passthrough)
      CardText(FAILURE_RECONCILE_HINT),
      Actions([
        Button({
          id: RECONCILE_ACTION_ID,
          label: "상태 다시 확인",
          style: "primary",
          value: payload(p.rid, "reconcile"),
        }),
      ]),
    ],
  });
}

/**
 * 생성 재요청 카드 — 상태 안내(passthrough) + [다시 만들기]. 커널이 **지금도 그 단계 생성 차례임을 확인했을 때만**
 *   내보내는 표현이라(회수된 요청), 이 버튼은 옛 요청을 되살리는 게 아니라 새 요청(새 마감)을 만든다.
 *   value 의 stage 는 도장(stamp) — 커널이 지금 단계와 대조해 옛 카드 클릭을 걸러낸다.
 */
export function renderGenerateRetry(p: GenerateRetryPresentation): CardElement {
  return Card({
    title: clampTitle(p.header),
    children: [
      CardText(p.message),
      CardText(GENERATE_RETRY_HINT),
      Actions([
        Button({
          id: GENERATE_RETRY_ACTION_ID,
          label: "다시 만들기",
          style: "primary",
          value: payload(p.rid, "generate", { stage: p.stage }),
        }),
      ]),
    ],
  });
}

/** 에스컬레이션 복구 카드 — [한 번 더 시도](raise-limit). 라벨(gateLabel/hint)은 passthrough. */
export function renderEscalation(p: EscalationPresentation): CardElement {
  const children: CardChild[] = [CardText("여러 번 고쳐도 규정 점검을 통과하지 못했어요.")];
  if (p.gateLabel) children.push(CardText(p.gateLabel));
  if (p.hint) children.push(CardText(p.hint));
  children.push(
    Actions([Button({ id: "raise-limit", label: "한 번 더 시도", style: "primary", value: payload(p.rid, "raise-limit") })]),
  );
  return Card({ title: clampTitle(p.header), children });
}

/** 인입 안내 카드 — 자료 본문을 **답글로 붙여넣기** 요청 + [붙여넣기 없이 진행]. 라벨 passthrough. */
export function renderIngestPrompt(p: IngestPromptPresentation): CardElement {
  const children: CardChild[] = [CardText(PASTE_PROMPT), CardText(STAGED_HINT)];
  if (p.gateLabel) children.push(CardText(p.gateLabel)); // passthrough
  if (p.hint) children.push(CardText(p.hint)); // passthrough
  children.push(
    Actions([
      Button({ id: INGEST_STAGED_ACTION_ID, label: "붙여넣기 없이 진행", value: payload(p.rid, "ingest") }),
    ]),
  );
  return Card({ title: clampTitle(p.header), children });
}

/**
 * 승인/보완 카드 — 헤더=header, 본문=gateLabel/hint(passthrough).
 *   [승인] 항상 · [보완]은 reviseAvailable 일 때만 · raOkRequired 면 RA 확인 표시.
 */
export function renderApproveGate(p: ApproveGatePresentation): CardElement {
  const children: CardChild[] = [];
  if (p.gateLabel) children.push(CardText(p.gateLabel)); // passthrough
  if (p.hint) children.push(CardText(p.hint)); // passthrough
  if (p.raOkRequired) children.push(CardText(RA_INDICATOR));

  const buttons: ButtonElement[] = [
    Button({
      id: "approve",
      label: p.raOkRequired ? "승인 (담당자 확인 필요)" : "승인",
      style: "primary",
      // RA 필수면 value 에 ra_required 신호만 싣는다 — 봇이 이를 보고 RA 확인 카드로 라우팅해 그 카드의 명시
      //   클릭 후에만 approve 잡의 payload.ra_ok 를 설정한다. ⚠ 여기서 ra_ok:true 를 직접 넣지 않는다(RA 게이트 우회 금지).
      value: p.raOkRequired
        ? payload(p.rid, "approve", { ra_required: true })
        : payload(p.rid, "approve"),
    }),
  ];
  if (p.reviseAvailable) {
    buttons.push(Button({ id: "revise", label: "보완", value: payload(p.rid, "revise") }));
  }
  children.push(Actions(buttons));
  return Card({ title: clampTitle(p.header), children });
}

/**
 * 심의 verdict 카드 — 통과🟢/보완🟠/사람확인🔴 3상태.
 *   보완 → [보완 반영 재생성](primary·generate+stage) · 사람확인 → [담당자 호출](danger) · 통과 → 버튼 없음.
 */
export function renderVerdict(p: VerdictPresentation): CardElement {
  const children: CardChild[] = [CardText(VERDICT_STATUS[p.outcome])];

  const buttons: ButtonElement[] = [];
  if (p.outcome === "revise") {
    // 보완 verdict 뒤 core 는 이미 step=generate 로 되돌린다 → 이 버튼은 재생성(generate)를 트리거(stage 동봉).
    buttons.push(
      Button({
        id: "regenerate",
        label: "보완 반영 재생성",
        style: "primary",
        value: payload(p.rid, "generate", { stage: p.stage }),
      }),
    );
  } else if (p.outcome === "human") {
    buttons.push(
      Button({ id: "escalate", label: "담당자 호출", style: "danger", value: payload(p.rid, "escalate") }),
    );
  }
  if (buttons.length > 0) children.push(Actions(buttons));

  return Card({ title: clampTitle(p.header), children });
}

/**
 * 다안 md 선택 → 안별 카드 배열(안 하나당 카드 1장) + 트레일링 액션 카드([다시 제안]·답글 안내).
 *   안 카드: 제목(추천이면 ⭐ 배지) + 본문 md 전문(CardText) + [이걸로](select) 버튼. 본문이 한 카드를 넘을 수
 *   있으나 통째로 싣는다(options-compare 섹션 ~0.8KB — 여유). 버튼 style 은 primary/미지정만.
 */
export function renderOptionSet(p: OptionSetPresentation): CardElement[] {
  const cards: CardElement[] = p.options.map((o) => {
    const children: CardChild[] = [];
    const fullTitle = o.title || o.key;
    const title = clampTitle(`${o.recommended ? OPTION_RECOMMEND_BADGE : ""}${fullTitle}`);
    // 제목이 clamp 됐는데 body 가 전문을 담고 있지 않으면 전문을 본문 첫 줄로 보존한다(정보 손실 0 —
    //   라이브 실측 173자 storyboard 제목은 body 가 전개 순서 전문을 이미 반복하므로 통상 추가되지 않는다).
    if (title !== `${o.recommended ? OPTION_RECOMMEND_BADGE : ""}${fullTitle}` && !(o.body ?? "").includes(fullTitle)) {
      children.push(CardText(fullTitle));
    }
    if (o.body) children.push(CardText(o.body)); // 안 md 전문(passthrough)
    children.push(
      Actions([
        Button({
          id: `select-${o.key}`,
          label: "이걸로",
          style: "primary",
          // phase·iteration 도장(stamp) 동봉 — 커널 onChoice 가 stale 클릭(재생성·다음 단계 옛 카드)을 걸러낸다.
          value: payload(p.rid, "select", { option: o.key, phase: p.phase, iteration: p.iteration }),
        }),
      ]),
    );
    return Card({ title, children });
  });
  // 트레일링: 헤더(phase_label passthrough) + 답글 안내 + [다시 제안](가용 시).
  const trailing: CardChild[] = [CardText(OPTION_REPLY_HINT)];
  if (p.reviseAvailable) {
    trailing.push(Actions([Button({ id: "revise", label: "다시 제안", value: payload(p.rid, "revise") })]));
  }
  cards.push(Card({ title: clampTitle(p.header), children: trailing }));
  return cards;
}

/**
 * 다안 이미지 선택 → 안별 [이걸로] 버튼 카드 배열(P2). **이미지 자체는 이 순수 렌더가 싣지 않는다** — 파일
 *   게시는 transport(ChatPort.render)의 부수효과(네이티브 파일 첨부)로 카드보다 먼저 이뤄진다. 여기서는 캡션 +
 *   [이걸로](select · phase·iteration 도장 동봉) + 트레일링 [다시 제안]만 만든다. OptionSet 과 동일한 stale 가드.
 */
export function renderImageOptionSet(p: ImageOptionSetPresentation): CardElement[] {
  const cards: CardElement[] = p.options.map((o) => {
    const children: CardChild[] = [CardText(o.caption)];
    children.push(
      Actions([
        Button({
          id: `select-${o.key}`,
          label: "이걸로",
          style: "primary",
          // OptionSet 과 동일한 도장(stamp) — 커널 onChoice 가 stale 클릭(재생성·다음 단계 옛 카드)을 걸러낸다.
          value: payload(p.rid, "select", { option: o.key, phase: p.phase, iteration: p.iteration }),
        }),
      ]),
    );
    const title = clampTitle(`${o.recommended ? OPTION_RECOMMEND_BADGE : ""}${o.key}안`);
    return Card({ title, children });
  });
  // 트레일링: 헤더(phase_label passthrough) + 선택 안내 + [다시 제안](가용 시).
  const trailing: CardChild[] = [CardText(IMAGE_OPTION_HINT)];
  if (p.reviseAvailable) {
    trailing.push(Actions([Button({ id: "revise", label: "다시 제안", value: payload(p.rid, "revise") })]));
  }
  cards.push(Card({ title: clampTitle(p.header), children: trailing }));
  return cards;
}

/**
 * NL 이해 확인 카드(NlProposal · P3) — 요약 + 미확신 질문 + (있으면) 방아쇠 버튼. 방아쇠는 기존 잡 경로의 actionId 다
 *   (설정=[시작] · 인입=[이 자료로 시작]). 모달/텍스트입력/파일입력 요소는 방출하지 않는다(공통분모 · NL 은 실행 안 함).
 */
export function renderNlProposal(p: NlProposalPresentation): CardElement {
  const children: CardChild[] = [CardText(p.summary)];
  for (const q of p.questions) children.push(CardText(q)); // 미확신 되물음(있으면)
  if (p.confirm) {
    children.push(
      Actions([
        Button({
          id: p.confirm.actionId,
          label: p.confirm.label,
          style: "primary",
          ...(p.confirm.payload ? { value: p.confirm.payload } : {}),
        }),
      ]),
    );
  }
  return Card({ title: NL_PROPOSAL_TITLE, children });
}

/** 완료(Done) 카드 — 마무리 안내 + 최종 산출물 경로(있으면). 버튼 없음. */
export function renderDone(p: DonePresentation): CardElement {
  const children: CardChild[] = [CardText(p.message)];
  for (const f of p.files) children.push(CardText(f)); // 산출물 경로 passthrough
  return Card({ title: clampTitle(p.header), children });
}

/** 중립 표현 → Slack 카드 디스패치(단일 카드 표현). OptionSet/ImageOptionSet(다중 카드)은 toCards 를 쓴다. */
export function toCard(p: Presentation): CardElement {
  switch (p.type) {
    case "Setup":
      return renderSetup(p);
    case "IngestPrompt":
      return renderIngestPrompt(p);
    case "Progress":
      return renderProgress(p);
    case "Failure":
      return renderFailure(p);
    case "GenerateRetry":
      return renderGenerateRetry(p);
    case "ApproveGate":
      return renderApproveGate(p);
    case "ConfirmGate":
      return renderConfirmGate(p);
    case "Verdict":
      return renderVerdict(p);
    case "Escalation":
      return renderEscalation(p);
    case "OptionSet":
      // 다안은 여러 카드다(toCards). 단일 진입점(toCard)에선 대표로 첫 카드만 — 실 게시는 toCards 를 쓴다.
      return renderOptionSet(p)[0]!;
    case "ImageOptionSet":
      // 이미지 다안도 여러 카드다(toCards). 단일 진입점에선 대표로 첫 카드만 — 실 게시는 toCards 를 쓴다.
      return renderImageOptionSet(p)[0]!;
    case "NlProposal":
      return renderNlProposal(p);
    case "Done":
      return renderDone(p);
    default: {
      // 미지 표현(향후 union 추가분) — 컴파일 시 exhaustiveness 강제.
      const _exhaustive: never = p;
      throw new Error(`renderer: 알 수 없는 Presentation 타입: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * 중립 표현 → Slack 카드 **배열**(ChatPort.render 가 사용). 대부분 카드 1장이지만 다안(OptionSet)은
 *   안별로 여러 장을 게시한다(post 는 요소 1개만 받으므로 어댑터가 순차 게시).
 */
export function toCards(p: Presentation): CardElement[] {
  if (p.type === "OptionSet") return renderOptionSet(p);
  if (p.type === "ImageOptionSet") return renderImageOptionSet(p);
  return [toCard(p)];
}
