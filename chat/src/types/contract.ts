/**
 * contract.ts — core `scripts/next-action.sh <run_id>` 가 내보내는 한 줄 JSON 계약 타입.
 *
 * 이 계약이 챗 어댑터 버튼/카드의 단일 SSoT다(터미널 run.md 와 동일 소스).
 *   생성 SSoT: core/scripts/next-action.sh 의 `out` 딕셔너리.
 *   필드 값 enum SSoT: core/harness/state.schema.json (phase/step/gate/status/awaiting).
 *   대표 픽스처: .scratch-fixtures/01-guideline-approve.json.
 *
 * 파싱 정책(forward-compat): 어댑터는 '아래 명시된 필드만' 사용하고,
 *   next-action.sh 가 새 top-level 필드를 추가해도 파싱이 깨지지 않도록 무시한다.
 *   → NextAction 에 index signature `[k: string]: unknown` 를 두어 미지 필드를 허용한다
 *     (미지 키 접근값 타입은 unknown — 명시 필드만 좁은 타입).
 */

/** 파이프라인 페이즈(state.schema.json: phase.enum). */
export type Phase =
  | "00a-intake"
  | "00-ingest"
  | "00e-evidence"
  | "00g-guideline"
  | "01-brief"
  | "02-concept"
  | "03-storyboard"
  | "04-keyvisual"
  | "done";

/** 페이즈 내 단계(state.schema.json: step.enum). */
export type Step = "generate" | "review" | "select" | "human" | "done";

/** 게이트 종류 커서(state.schema.json: gate.enum — null 가능). */
export type Gate = "review" | "user" | "select" | null;

/** 게이트 상태(state.schema.json: status.enum). */
export type Status =
  | "pending"
  | "passed"
  | "revise"
  | "escalated"
  | "approved"
  | "changes_requested"
  | "selected";

/** 대기 대상(state.schema.json: awaiting.enum). next-action 은 st.get() 이라 부재 시 null. */
export type Awaiting = "review" | "user" | "select" | "none" | null;

/**
 * 기계용 분기 키 — 어댑터는 이 값으로 버튼/카드를 렌더한다(next-action.sh out['action']).
 *   ingest         : 자료 불러오기(bundle_dir 필요)
 *   generate       : run-stage <stage> 생성
 *   review         : kcia-check(규정 점검)
 *   select         : 다안 선택(carousel · options/recommended 동봉)
 *   approve        : 단안 승인/보완(revise)
 *   raise-limit    : 보완 상한 초과(escalated) 복구
 *   resume-approve : 중단된 승인 이어서(gate=user·status=approved)
 *   resume-select  : 중단된 선택 이어서(gate=select·status=selected)
 *   done           : 완료
 */
export type Action =
  | "ingest"
  | "generate"
  | "review"
  | "select"
  | "approve"
  | "raise-limit"
  | "resume-approve"
  | "resume-select"
  | "done";

/** 게이트의 인간-상호작용 종류(next-action 파생: gate_type). 게이트 아니면 null. */
export type GateType = "auto" | "human-verify" | "setup" | "hard-stop" | null;

/** 구조화 멈춤 사유(WS-GATES: render_runmd._stop_reason). 없으면 null. */
export interface StopReason {
  code: string;
  summary: string;
  required_fields?: string[];
  /** forward-compat: feedback.json 유래 등 추가 키 허용. */
  [k: string]: unknown;
}

/** 임계 결손 항목(completeness_advisor: must_fill[]). */
export interface AdvisoryMustFill {
  key: string;
  /** 빠진 필드 코드 목록. */
  missing?: string[];
  /** 평이어 라벨 목록. */
  labels?: string[];
  /** 그대로 진행 시 결과 투영(평이어). */
  projection?: string;
  /** forward-compat: 추가 키 허용. */
  [k: string]: unknown;
}

/** 있으면 좋은 권고 항목(completeness_advisor: nice_to_have[]). */
export interface AdvisoryNiceToHave {
  key: string;
  /** 채우면 좋은 것(평이어 제안). */
  propose?: string;
  /** 채웠을 때 품질 투영(평이어). */
  projection?: string;
  /** forward-compat: 추가 키 허용. */
  [k: string]: unknown;
}

/**
 * 읽기전용 보완 권고(completeness_advisor.advise). run.md 와 동일 소스. 없으면 null.
 * ⚠ must_fill·nice_to_have 는 문자열이 아니라 **객체 배열**이다(core 실측: {key,missing,labels,projection} 등).
 */
export interface Advisory {
  /** 임계 결손(반드시 채울 것) — 객체 배열. */
  must_fill: AdvisoryMustFill[];
  /** 있으면 좋은 것 — 객체 배열. */
  nice_to_have: AdvisoryNiceToHave[];
  /** [채운 수, 전체 수]. */
  completeness: number[];
  /** forward-compat: 추가 권고 키 허용. */
  [k: string]: unknown;
}

/**
 * next-action.sh 한 줄 JSON 의 구조화 형태.
 * nullable 필드는 정확히 표기(next-action.sh 가 None 을 낼 수 있는 곳).
 */
export interface NextAction {
  /** run_id. */
  rid: string;
  /** 현재 페이즈. */
  phase: Phase;
  /** 사람용 페이즈 라벨(평이어 passthrough — 자체 번역 금지). */
  phase_label: string;
  /** 페이즈 내 단계. */
  step: Step;
  /** 게이트 커서(null 가능). */
  gate: Gate;
  /** 게이트 상태. */
  status: Status;
  /** 대기 대상(부재 시 null). */
  awaiting: Awaiting;
  /** 현재 보완 반복 회차(부재 시 null). */
  iteration: number | null;
  /** 보완 반복 상한(부재 시 null). */
  max_iterations: number | null;
  /** 기계용 분기 키(어댑터 렌더 스위치). */
  action: Action;
  /** action=generate 일 때 run-stage 인자(guideline/brief/concept/storyboard-outline/...). 그 외 null. */
  stage: string | null;
  /** action=ingest 일 때 'bundle_dir'. 그 외 null. */
  needs: "bundle_dir" | null;
  /** action=select 일 때 옵션 키(carousel 카드). 그 외 빈 배열. */
  options: string[];
  /** 추천 top-1 옵션 키(실재 옵션 교차검증). 없으면 null. */
  recommended: string | null;
  /** 01-brief 승인 시 RA(담당자) 사후검수 필요 여부. */
  ra_ok_required: boolean;
  /** 전부거절→재제안(revise) 가용 여부 — carousel [다시 제안] 버튼 신호. */
  revise_available: boolean;
  /** 게이트 종류(파생). 게이트 아니면 null. */
  gate_type: GateType;
  /** 구조화 멈춤 사유. 없으면 null. */
  stop_reason: StopReason | null;
  /** 읽기전용 보완 권고. 없으면 null. */
  advisory: Advisory | null;
  /** 사람용 참고 명령(터미널 run.md 와 동일 · 그대로 실행 가능). */
  cmd: string;
  /** 사람용 게이트 라벨(평이어 passthrough). */
  gate_label: string;
  /** 사람용 힌트(평이어 passthrough · 비어있을 수 있음). */
  hint: string;
  /** 검토 파일 경로(옵션별 산출물 등 · 없으면 빈 배열). */
  files: string[];
  /**
   * forward-compat: next-action.sh 가 추가하는 미지 top-level 필드 허용.
   * 명시 필드는 위 좁은 타입, 미지 키 접근값은 unknown.
   */
  [k: string]: unknown;
}
