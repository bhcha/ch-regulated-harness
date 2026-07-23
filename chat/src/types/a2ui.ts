/**
 * a2ui.ts — A2UI ClientEvent 브리지(core `a2ui-action.sh`)의 챗측 계약 타입.
 *
 * SSoT: core/scripts/lib/a2ui_action.py — envelope 계약·서버측 검증·위임 규칙의 **단일 진실**이다.
 *   `bash <coreRoot>/scripts/a2ui-action.sh <rid> <event-json>` 은 현재 게이트에서 허용된 action 인지
 *   서버측 검증 후 select.sh/approve.sh/revise.sh/run-stage.sh(raise-limit)로 위임하고, 성공·거부 모두
 *   stdout 마지막 줄에 **단일 JSON envelope 한 줄**을 방출한다:
 *     {"ok":bool, "action":str|null, "delegate":str|null, "exit":int, "message":str, "error":str|null}
 *   프로세스 종료코드 = 위임 exit code(충실 보존). error="bridge" = 브리지 자체 거부/내부오류(위임 미실행/실행실패),
 *   error=null = 위임 결과(위임 exit 그대로).
 *
 * ⚠ Stage 2 가 이 파일에 A2uiSurface(읽기 표면) 타입을 뒤에 추가했다(아래) — Stage 1 의 A2uiActionEnvelope 는 그대로.
 */

/**
 * a2ui-action.sh 가 방출하는 단일 JSON envelope.
 *   forward-compat: SSoT(a2ui_action.py)가 새 top-level 필드를 더해도 파싱이 깨지지 않도록 index signature 로 허용한다
 *   (미지 키 접근값 타입은 unknown — 명시 필드만 좁은 타입).
 */
export interface A2uiActionEnvelope {
  /** 위임이 정상 반영됐는지(위임 exit==0). 거부/실패면 false. */
  ok: boolean;
  /** 요청 action(select|approve|revise|raise-limit) 또는 형태 위반 시 null. */
  action: string | null;
  /** 위임된 스크립트 basename(예 approve.sh) 또는 브리지 거부 시 null. */
  delegate: string | null;
  /** 프로세스 종료코드와 일치(위임 exit 그대로 · 신호사망은 128+signal). */
  exit: number;
  /** 위임 출력(사람용 TEXT) 또는 거부 사유 — worker 가 진단으로 쓴다. */
  message: string;
  /** "bridge"=브리지 자체 거부/내부오류 · null=위임 결과. */
  error: string | null;
  /** forward-compat: SSoT 가 추가하는 미지 필드 허용. */
  [k: string]: unknown;
}

/**
 * stdout 의 **마지막 비어있지 않은 줄**을 JSON envelope 로 파싱한다.
 *   위임 스크립트는 사람용 TEXT 를 앞줄에 찍을 수 있으므로(a2ui_action.py 가 message 로 감싼다) 마지막 줄만 본다.
 *   파싱 실패·형태 불일치 시 **null**(throw 금지 — 호출부가 평이 회신으로 흡수). 최소 필드(ok:boolean·exit:number)
 *   존재로 형태를 확인한다(부분 객체가 envelope 로 오인되지 않게).
 */
export function parseActionEnvelope(stdout: string): A2uiActionEnvelope | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") {
      last = lines[i]!;
      break;
    }
  }
  if (last === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean" || typeof obj.exit !== "number") return null;
  return obj as A2uiActionEnvelope;
}

/**
 * a2ui-surface.sh(→ core/scripts/lib/a2ui_surface.py `derive()`)가 방출하는 한 줄 JSON **읽기 표면**의 챗측 계약.
 *
 * SSoT: core/scripts/lib/a2ui_surface.py — derive() 반환 dict 가 계약 진실이다. surface 는 state.json 의 **파생 뷰**
 *   (읽기전용·기계 표면)이며 next-action.sh 와 동치인 필드(options/recommended/revise_available/action)를 공유한다.
 *   챗 레이어는 이 표면을 na(주계약)의 **오버레이/교차검증**으로만 쓴다(na 를 대체하지 않는다).
 *
 * forward-compat: derive() 가 새 top-level 필드(a2ui_version·catalogId·gate·status·components 등)를 실어도 파싱이
 *   깨지지 않도록 index signature 로 흡수한다(명시하지 않은 키 접근값 타입은 unknown). 아래 명시 필드만 좁은 타입.
 */
export interface A2uiSurface {
  /** 요청 run_id 를 그대로 echo(불일치 시 신뢰 불가 → 클라이언트가 null 처리). */
  rid: string;
  /** 현재 페이즈(원본 · 예 "02-concept"). */
  phase: string;
  /** 현재 게이트의 A2UI surface. 비-대화형(generate/review/ingest/done)이면 null. */
  surface: "select" | "approve" | "keyvisual" | "escalated" | null;
  /** keyvisual 2단계의 현재 스텝(select|approve) 또는 그 외 null. */
  step: "select" | "approve" | null;
  /** keyvisual: 선택 뒤 확정 승인이 이어지는지(surface==="keyvisual"). */
  needs_approve_after_select: boolean;
  /** ≡ next-action.sh action(동치). */
  action: string;
  /** 이 surface 에서 사람이 되돌려보낼 수 있는 named event 집합(카탈로그 상한과 정합). 버튼 게이트의 소스. */
  actions: string[];
  /** ≡ next-action.sh options. */
  options: string[];
  /** ≡ next-action.sh recommended(없으면 null). */
  recommended: string | null;
  /** ≡ next-action.sh revise_available. */
  revise_available: boolean;
  /** 01-brief 승인 시 RA(담당자) 사후검수 필요 여부. */
  ra_ok_required: boolean;
  /** forward-compat: derive() 가 추가하는 미지 필드(a2ui_version·catalogId·gate·status·components …) 허용. */
  [k: string]: unknown;
}

/**
 * AG-UI 이벤트 1건(core `agui-events.sh` replay 의 JSONL 한 줄)의 챗측 계약 — **passthrough**.
 *
 * SSoT: core/scripts/lib/agui_events.py — replay()가 방출하는 이벤트 dict 가 계약 진실이다. 각 이벤트는
 *   `type`(필수) + `timestamp`(생성상 항상 실림) + 타입별 필드를 갖는다. 챗 레이어는 이 스트림을 **긴 생성 구간의
 *   증분 진행 표시 전용 side-channel** 로만 소비한다(전이 신호 아님 — 전이 판정 SSoT 는 next-action.sh).
 *
 * 알려진 type(참고 · 좁히지 않고 passthrough 유지): RunStarted · StepStarted{stepName} · StepFinished{stepName,outcome?}
 *   · StateSnapshot{snapshot} · StateDelta{delta} · RunFinished{outcome:{type:"success"|"interrupt",...}}
 *   · RunError · Custom{name,value}(name=`kcia.verdict`·`harness.escalated`·`harness.ingest-incomplete`).
 *
 * forward-compat: type 을 string-literal union 으로 좁히지 않고 `string` 으로 둔다 — 미지 type·미지 필드를 전부
 *   보존해야(index signature) 방출 모듈이 이벤트를 늘려도 파싱이 깨지지 않는다. 소비부(latestLifecycleProgress)가
 *   관심 있는 type 만 골라 쓴다.
 */
export interface AguiEvent {
  /** 이벤트 종류(예 "StepStarted"·"Custom"). 좁히지 않는다(passthrough). */
  type: string;
  /** 방출 시각(ISO-8601 · strict). 최신성 판단(dedupe)에 쓴다. 부재 가능(passthrough 보수). */
  timestamp?: string;
  /** forward-compat: 타입별 필드(stepName·outcome·name·value·snapshot·delta …) 전부 보존. */
  [k: string]: unknown;
}
