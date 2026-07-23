/**
 * policy.ts — 라이브 드라이버의 auto-happy 결정 정책(순수).
 *
 * ── 동결 SurfaceDriver.decide 의 '정책'을 그대로 미러한다 ─────────────────────────
 *   CI 백엔드는 동결 `SurfaceDriver`(acceptance/driver.ts)가 자기 내부 기록 포트를 몰고, 그 `decide()` 가
 *   auto-happy 결정(추천안 select · approve · RA 확인 · 인입 · NL 확정)을 낸다. 라이브 백엔드는 **teePort**(실 Slack
 *   tee)를 게이트웨이 chat 포트로 써야 하는데, 동결 SurfaceDriver 는 생성자에서 자기 포트를 만들어 delegate 를
 *   받지 못한다(동결 — 수정 금지). 그래서 라이브는 게이트웨이를 teePort 로 **직접 조립**하고, 결정 정책은 이
 *   순수 함수로 **같은 형태를 미러**한다(driver.ts 의 decide 스위치와 동일 · affordancesOf 는 그대로 재사용).
 *
 *   드리프트 봉인 = **exhaustiveness never 가드**(driver.ts·affordances.ts 와 동일 기법): Presentation union 에
 *   변이가 추가되면 이 파일이 **컴파일 실패**한다 → 정책도 새 변이를 다뤄야 한다. 정책이 done 까지 닿는다는 것은
 *   CI 의 mention-to-done 인수 시나리오가 (같은 형태로) 상시 증명한다.
 *
 * 플랫폼 무지: kernel/·types/·acceptance/(affordancesOf) 만 import.
 */
import { parseActionValue } from "../kernel/flow.js";
import type { ButtonPressed } from "../kernel/events.js";
import type { Presentation } from "../kernel/presentation.js";
import { affordancesOf, type AffordanceContext } from "../acceptance/affordances.js";

/** ApproveGate 1차 액션 actionId(render.ts 미러 · driver.ts 와 동일). */
const APPROVE_ACTION_ID = "approve";
/** 다안 [이걸로] 버튼 actionId 접두어(render.ts `select-${key}`). */
const SELECT_ACTION_PREFIX = "select-";

/**
 * auto-happy 결정 — 화면 → 발화할 affordance(추출기가 낸 것 중에서 고른다). 비-happy/표시전용/종단은 null(정지).
 *   affordancesOf 가 방출한 ButtonPressed 중에서만 고른다(이벤트를 손으로 짓지 않는다 — 잠긴 결정 1: 직전 렌더에서 도출).
 *   ⚠ driver.ts 의 SurfaceDriver.decide 와 **정확히 같은 정책**이다(라이브·CI 동일 결정으로 스왑 가능).
 */
export function decideForward(p: Presentation, ctx: AffordanceContext): ButtonPressed | null {
  const affs = affordancesOf(p, ctx) as ButtonPressed[];
  switch (p.type) {
    case "NlProposal":
      // 확정 버튼이 있으면 발화(complete 설정/인입). 질문만 있으면 [] → 사람 입력 대기 = 정지.
      return affs[0] ?? null;
    case "IngestPrompt":
      return affs[0] ?? null; // INGEST_STAGED(단일 affordance)
    case "ApproveGate":
      // 1차 액션(approve) 발화 — raOkRequired 면 ra_required 가 실려 다음이 ConfirmGate 다.
      return affs.find((a) => a.actionId === APPROVE_ACTION_ID) ?? affs[0] ?? null;
    case "ConfirmGate":
      return affs[0] ?? null; // RA 확인(단일 affordance)
    case "OptionSet":
    case "ImageOptionSet": {
      // 추천 안(recommended:true) 우선, 없으면 첫 안 — 그 안의 select-<key> affordance 를 value.option 으로 매칭.
      const recommended = p.options.find((o) => o.recommended)?.key ?? p.options[0]?.key;
      const chosen = affs.find(
        (a) => a.actionId.startsWith(SELECT_ACTION_PREFIX) && parseActionValue(a.value)?.option === recommended,
      );
      return chosen ?? affs.find((a) => a.actionId.startsWith(SELECT_ACTION_PREFIX)) ?? null;
    }
    // 표시 전용/사람-입력/비-happy/종단 → 정지(판정 리포트/분석기가 문제면 표시).
    case "Setup":
    case "Progress":
    case "Verdict":
    case "Failure":
    case "GenerateRetry":
    case "Escalation":
    case "Done":
      return null;
    default: {
      // union 변이 추가 시 컴파일 실패 — 결정 정책도 새 변이를 다뤄야 한다(driver.ts 와 동일 exhaustiveness).
      const _exhaustive: never = p;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * 라이브 드라이버 결정 — decideForward(CI 미러)의 2분법(발화/정지)을 라이브의 4분법으로 확장한다.
 *   CI(오프라인 stub)는 quiesce()가 자동 이어가기 캐스케이드를 **동기적으로 전부** 소화해 drain 뒤 최신 화면이
 *   이미 다음 인터랙티브 게이트였다. 라이브는 생성이 Bridge(pending 잡 + 폴링)라 대기·타임아웃·실패 화면이
 *   최신 렌더로 **남을 수 있다** — decideForward 는 그 화면들에 전부 null(정지)이라 드라이버가 유휴로 죽는다.
 *   decideLive 는 그 표시전용/실패/판정 화면에 wait·recover·stop 을 준다(계획 2-2 결정표).
 */
export type LiveDecision =
  | { kind: "fire"; event: ButtonPressed } // 행복 전진(decideForward 위임)
  | { kind: "recover"; event: ButtonPressed } // 회복 발화(Failure→reconcile · 읽기 전용 · 유료 동작 없음)
  | { kind: "wait" } // 표시전용/자동 캐스케이드 대기(유한 — stuck 임계·runBudget 이 상한)
  | { kind: "stop"; reason: "done" | "escalation" | "human-input" };

/**
 * 라이브 auto-happy 결정 정책(순수) — 화면(Presentation) → fire/recover/wait/stop.
 *   모든 발화 이벤트는 직전 렌더의 affordancesOf 산출에서만 도출한다(잠긴 결정 1 · 지어낸 버튼 금지) —
 *   fire 는 decideForward(=affordancesOf 중 전진 affordance)를, recover 는 affordancesOf 의 회복 affordance 를 쓴다.
 *
 *   ⚠ **Verdict 는 발화하지 않는다(핵심)**: pass 든 revise 든 onOutcome 이 이미 다음 잡(재생성/심의/다음 생성)을
 *      자동 적재한다(flow.ts). 여기서 Verdict 카드의 [다시 만들기](affordances.ts REGENERATE)를 또 누르면 **이중 적재**가
 *      되어 enqueueJob 이 in_progress 로 거부 → 스스로 Failure 카드를 만든다. 그래서 pass/revise = 캐스케이드가 다음
 *      인터랙티브 게이트를 낼 때까지 **wait**(발화 금지)이고, human 만 stop:escalation.
 *
 *   exhaustiveness never 가드는 decideForward 와 동일 — Presentation union 에 변이가 추가되면 컴파일 실패한다.
 */
export function decideLive(p: Presentation, ctx: AffordanceContext): LiveDecision {
  switch (p.type) {
    // 행복 게이트 — decideForward 에 위임(추천안 select · approve · RA 확인 · 인입 · NL 확정).
    //   결과가 null(질문만 있는 NlProposal 등)이면 사람 입력이 필요하므로 stop:human-input.
    case "NlProposal":
    case "IngestPrompt":
    case "ApproveGate":
    case "ConfirmGate":
    case "OptionSet":
    case "ImageOptionSet": {
      const event = decideForward(p, ctx);
      return event ? { kind: "fire", event } : { kind: "stop", reason: "human-input" };
    }
    // 완결 NL 멘션이면 애초에 NlProposal 이 온다 — Setup 잔류는 제품명 답글이 필요한 사람 입력 화면.
    case "Setup":
      return { kind: "stop", reason: "human-input" };
    // 표시 전용 — 캐스케이드(자동 review/generate 적재)나 Bridge 폴링이 진행 중. 유한 대기.
    //   ⚠ Progress 는 전이형(생성/심의 중)과 **종단형 사람 안내**(자료 재요청·재멘션 거부·보완 답글 대기·미지 단계
    //   "담당자와 함께")를 한 타입에 겹쳐 쓴다. 그러나 **auto-driver 가 종단형에 닿는 일은 사실상 없다**: 그것들은
    //   답글/재멘션/revise/에러 등 드라이버가 하지 않는 사람-트리거 경로에서만 뜨고(멘션은 1회뿐·revise 미발화),
    //   표준 브리프 너머 생성은 AUTO_GENERATE_STAGES 라 quiesce 가 Bridge 에서 전이시킨다(991 "담당자와 함께" 는
    //   미지 단계 방어 폴백뿐). 만에 하나 종단형에 닿아도 화면에 버튼이 없어 재렌더를 스스로 못 하므로(잠긴 결정 1 —
    //   지어낸 버튼 금지) wait 로 두고, 안 움직이면 **stuck 임계(기본 15분)가 stalled 로 마감**한다(수동 게이트라 참관
    //   중인 사람이 그 지점을 본다). '종단 Progress → 즉시 human-input' 분기는 Presentation 에 전이/종단 구분 필드가
    //   없어(kernel presentation 변경 = src/live 범위 밖) 문자열 매칭 없이는 불가하다 — stuck 백스톱으로 대신한다.
    case "Progress":
      return { kind: "wait" };
    // pass·revise → 발화 금지(위 주석 이중 적재) = wait. human → 사람 판단(Escalation 과 동일 취급).
    case "Verdict":
      return p.outcome === "human" ? { kind: "stop", reason: "escalation" } : { kind: "wait" };
    // 회복 발화(읽기 전용) — 직전 렌더의 affordance 를 그대로 쓴다(지어낸 버튼 금지).
    //   Failure = [상태 다시 확인](RECONCILE · **읽기 전용 화해** · 상태 변이 0 · 잡 적재 0) → core 상태를 다시 읽어
    //   현재 게이트 카드를 재현한다. 그 사이 생성이 **완료됐으면**(소비자가 늦게 성공·전이함) reconcile 이 다음 게이트를
    //   자동으로 그려 흐름이 이어진다(유료 동작 0). affordancesOf 가 비면(있을 수 없지만 방어적) stop:human-input.
    case "Failure": {
      const affs = affordancesOf(p, ctx) as ButtonPressed[];
      const event = affs[0];
      return event ? { kind: "recover", event } : { kind: "stop", reason: "human-input" };
    }
    // ⚠ **자동 유료 재생성 금지(중복 과금·run 경합 방지)**: GenerateRetry 는 Failure→[상태 다시 확인](읽기 전용
    //   reconcile)이 상태를 다시 읽어도 **여전히 '생성 차례'로 남은 경우에만** 뜬다 = 생성이 **완료되지 않았다는 신호**다.
    //   여기서 [다시 만들기](GENERATE_RETRY)를 자동 발화하면, Bridge 타임아웃이 모호한 창(소비자가 아직 생성 중이나
    //   core 전이 전 — 이때 na.action 은 여전히 'generate' 라 retryGenerate 의 재확인 가드를 통과한다)에 겹칠 때
    //   **두 번째 유료 생성**을 일으켜 같은 run 디렉터리 경합·중복 외부 비용을 낼 수 있다(운영자 세션은 잡을 클레임하지
    //   않아 Bridge check-first 의 in_progress 가드로도 안 걸린다). 그래서 유료 재발화는 **사람 판단으로 남기고 멈춘다**.
    //   (늦은 성공은 위 Failure→reconcile 이 다음 게이트로 자동 회복하므로 이 화면에 도달하지 않는다 — happy path 무해.)
    case "GenerateRetry":
      return { kind: "stop", reason: "human-input" };
    // 심의 반복 상한 해제(raise-limit)는 적대 게이트를 무력화하는 사람/RA 결정 — 자동 발화 금지. 멈추고 가시화.
    case "Escalation":
      return { kind: "stop", reason: "escalation" };
    case "Done":
      return { kind: "stop", reason: "done" };
    default: {
      // union 변이 추가 시 컴파일 실패 — 라이브 정책도 새 변이를 다뤄야 한다(decideForward 와 동일 exhaustiveness).
      const _exhaustive: never = p;
      void _exhaustive;
      return { kind: "stop", reason: "human-input" };
    }
  }
}
