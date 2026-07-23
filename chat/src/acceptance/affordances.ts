/**
 * affordances.ts — 중립 표현(Presentation) → 그 화면에서 사용자가 발화할 수 있는 입력 이벤트 집합.
 *   "이 화면에서 어떤 입력이 들어올 수 있나"의 기계화(순수·결정론). 인수 하네스가 실렌더 대신 이 추출기로
 *   화면별 affordance 를 뽑아 발화한다.
 *
 * ── 규약 미러(단일 진실 = adapters/slack/render.ts) ──────────────────────────────
 *   이 추출기는 render.ts 의 payload() 규약과 변이별 버튼/Select 구성을 **그대로** 반영한다. 어긋나면(드리프트)
 *   test/acceptance/affordance-convention.test.ts 가 실렌더 버튼 집합과의 전수 결박(actionId·value 왕복 일치)에서
 *   실패한다 — 그 결박 테스트가 런타임 드리프트 봉인이다("지어낸 버튼" 금지).
 *
 * ── 정직한 클릭 동치(설계 제약) ─────────────────────────────────────────────────
 *   전송 계층은 모든 버튼/Select 조작을 커널에 ButtonPressed 로 전달한다(actionId=select id · value=선택 토큰).
 *   select→choice 변환은 flow.onAction 의 몫이지 여기가 아니다. 따라서 이 추출기도 버튼과 Select 선택지를
 *   **모두 ButtonPressed 로** 방출한다 — ChoiceMade 로 미리 변환하지 않는다("커널 이벤트 발화 = 정직한 클릭 동치").
 *   Select 를 빠뜨리면 설정 화면이 거짓이 된다(빠뜨린 affordance 없음·지어낸 버튼 없음).
 *
 * ── exhaustiveness(드리프트 봉인의 타입 절반) ───────────────────────────────────
 *   switch 의 default 에서 `const _exhaustive: never = p` 로 컴파일 시 전수성을 강제한다(render.ts toCard 미러).
 *   Presentation union 에 변이가 추가되면 이 파일이 **컴파일 실패**한다 — 런타임 테스트는 '빠진 union 멤버'를
 *   증명할 수 없으므로 타입이 그 역할을 진다.
 *
 * kernel-neutral: kernel/·types/·node builtin 만 import(adapters/ 금지 — 플랫폼 무지).
 */
import type { ButtonPressed, ChatEvent } from "../kernel/events.js";
import type { Presentation } from "../kernel/presentation.js";
import {
  GENERATE_RETRY_ACTION_ID,
  INGEST_STAGED_ACTION_ID,
  RA_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
} from "../kernel/interaction.js";

/** 추출 시점의 런타임 바인딩(감사 시작점 actor · 스레드). 입력에 결정론적이다. */
export interface AffordanceContext {
  actor: string;
  threadId: string;
}

// ── render.ts 규약 미러 상수 ─────────────────────────────────────────────────
// 아래 actionId·옵션 토큰은 render.ts 에만 존재하는 raw 리터럴이라(커널 interaction.ts 어휘 밖) 여기서 미러한다.
//   드리프트는 affordance-convention.test.ts 가 실렌더 버튼/Select 와 전수 대조해 잡는다.
const APPROVE_ACTION_ID = "approve";
const REVISE_ACTION_ID = "revise";
const REGENERATE_ACTION_ID = "regenerate";
const ESCALATE_ACTION_ID = "escalate";
const RAISE_LIMIT_ACTION_ID = "raise-limit";
/** 다안 [이걸로] 버튼 actionId 접두어(render.ts `select-${key}`). */
const SELECT_ACTION_PREFIX = "select-";

// 설정 Select 선택지 토큰 — render.ts DOMAIN_OPTIONS/FORMAT_OPTIONS 의 value 미러(core new-run.sh CLI 토큰).
//   Select 변경도 onAction(actionId=setup_domain/setup_format · value=이 토큰)으로 들어오므로 선택지마다 1건 방출.
const DOMAIN_OPTION_VALUES = ["화장품", "의약외품", "건기식", "의약품"] as const;
const FORMAT_OPTION_VALUES = ["한장", "여러장"] as const;

/**
 * 버튼 payload — render.ts payload() 와 **동일** 규약(키 순서: run_id, action, …extra).
 *   value 바이트 동치를 보장해야 결박 테스트가 실렌더 버튼 value 와 정확히 일치한다.
 */
function payload(runId: string, action: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ run_id: runId, action, ...(extra ?? {}) });
}

/**
 * 화면(Presentation) → 발화 가능한 입력 이벤트(모두 ButtonPressed). 상호작용 요소가 없는 화면은 `[]`.
 *   ctx 는 런타임 actor/스레드 바인딩(입력에 결정론적).
 */
export function affordancesOf(p: Presentation, ctx: AffordanceContext): ChatEvent[] {
  // value 없는 버튼(설정 [시작]·payload 없는 NL 확정)은 value 키를 아예 싣지 않는다(실렌더와 동형).
  const btn = (actionId: string, value?: string): ButtonPressed => ({
    type: "button",
    actionId,
    ...(value !== undefined ? { value } : {}),
    actor: ctx.actor,
    threadId: ctx.threadId,
  });

  switch (p.type) {
    case "Setup": {
      // Select 2개(도메인/포맷)의 각 선택지 + [시작] 버튼(value 없음 — pending 을 읽음).
      const events: ButtonPressed[] = [];
      for (const v of DOMAIN_OPTION_VALUES) events.push(btn(SETUP_ACTION_IDS.domain, v));
      for (const v of FORMAT_OPTION_VALUES) events.push(btn(SETUP_ACTION_IDS.format, v));
      events.push(btn(SETUP_ACTION_IDS.start));
      return events;
    }
    case "IngestPrompt":
      return [btn(INGEST_STAGED_ACTION_ID, payload(p.rid, "ingest"))];
    case "Progress":
      return []; // 버튼 없음
    case "Failure":
      return [btn(RECONCILE_ACTION_ID, payload(p.rid, "reconcile"))];
    case "GenerateRetry":
      return [btn(GENERATE_RETRY_ACTION_ID, payload(p.rid, "generate", { stage: p.stage }))];
    case "ApproveGate": {
      const events: ButtonPressed[] = [
        btn(
          APPROVE_ACTION_ID,
          // raOkRequired 면 ra_required 신호만 실린다(ra_ok 직접 안 실음 — RA 게이트 우회 금지).
          p.raOkRequired
            ? payload(p.rid, "approve", { ra_required: true })
            : payload(p.rid, "approve"),
        ),
      ];
      if (p.reviseAvailable) events.push(btn(REVISE_ACTION_ID, payload(p.rid, "revise")));
      return events;
    }
    case "ConfirmGate":
      return [btn(RA_CONFIRM_ACTION_ID, payload(p.rid, "approve"))];
    case "Verdict":
      if (p.outcome === "revise")
        return [btn(REGENERATE_ACTION_ID, payload(p.rid, "generate", { stage: p.stage }))];
      if (p.outcome === "human") return [btn(ESCALATE_ACTION_ID, payload(p.rid, "escalate"))];
      return []; // pass → 버튼 없음
    case "Escalation":
      return [btn(RAISE_LIMIT_ACTION_ID, payload(p.rid, "raise-limit"))];
    case "OptionSet":
    case "ImageOptionSet": {
      // 안별 [이걸로](select-<key>) + phase·iteration 도장 + (가용 시) 트레일링 [다시 제안]. 두 변이 동일 규약.
      const options: ReadonlyArray<{ key: string }> = p.options;
      const events: ButtonPressed[] = options.map((o) =>
        btn(
          `${SELECT_ACTION_PREFIX}${o.key}`,
          payload(p.rid, "select", { option: o.key, phase: p.phase, iteration: p.iteration }),
        ),
      );
      if (p.reviseAvailable) events.push(btn(REVISE_ACTION_ID, payload(p.rid, "revise")));
      return events;
    }
    case "NlProposal":
      // 방아쇠 버튼(확정 가능할 때만). actionId·payload 는 표현에 실린 데이터(기존 잡 경로의 것).
      return p.confirm ? [btn(p.confirm.actionId, p.confirm.payload)] : [];
    case "Done":
      return []; // 버튼 없음
    default: {
      // union 변이 추가 시 컴파일 실패 — 드리프트 봉인의 타입 절반(exhaustiveness).
      const _exhaustive: never = p;
      throw new Error(`affordances: 알 수 없는 Presentation 타입: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
