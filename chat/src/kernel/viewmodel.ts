/**
 * viewmodel.ts — NextAction → ViewModel(봇이 렌더할 중립 뷰).
 *
 * 역할: 계약(NextAction)을 어댑터-중립 뷰로 정리한다. `action` 을 분기 키로,
 *   header/gateLabel/hint/cmd 안내와 옵션·추천·신호·권고를 '노출용'으로 모아 준다.
 *
 * ⚠ 라벨 passthrough(dev-loop-grounding 3): 라벨 문자열(phase_label·gate_label·hint·cmd)은 **core 산출을 그대로 전달**한다.
 *   여기서 새 문구를 짓거나 번역/트림하지 않는다(자체 번역 사전 금지). 하위 stage(F1 Slack 카드)가 이 뷰를 소비한다.
 *
 * 방어적 정규화: 입력은 next-action.sh 산출을 JSON 파싱해 캐스팅한 것이라 런타임에 필드가 빠질 수 있다.
 *   렌더가 깨지지 않도록 컬렉션/불리언/nullable 기본값만 보정한다(라벨 값 자체는 절대 변형하지 않음).
 */
import type { Action, Advisory, GateType, NextAction, Phase, StopReason } from "../types/contract.js";

/** 봇이 카드/버튼을 그릴 어댑터-중립 뷰. 라벨 문자열은 전부 core passthrough. */
export interface ViewModel {
  /** run_id. */
  rid: string;
  /** 기계용 분기 키(카드 종류 선택). */
  action: Action;
  /** 현재 페이즈(원본). */
  phase: Phase;
  /** 헤더 = phase_label(passthrough). */
  header: string;
  /** 게이트 안내 = gate_label(passthrough). */
  gateLabel: string;
  /** 힌트 = hint(passthrough · 비어있을 수 있음). */
  hint: string;
  /** 참고 명령 = cmd(passthrough · 그대로 실행 가능). */
  cmd: string;
  /** 보완 반복 회차(없으면 null). */
  iteration: number | null;
  /** 보완 반복 상한(없으면 null). */
  maxIterations: number | null;
  /** generate 카드용 run-stage 인자(아니면 null). */
  stage: string | null;
  /** ingest 카드가 필요로 하는 것(bundle_dir · 아니면 null). */
  needs: "bundle_dir" | null;
  /** select 카드용 옵션 키(비-select 는 빈 배열 · 복사본). */
  options: string[];
  /** 추천 top-1 옵션 키(없으면 null). */
  recommended: string | null;
  /** carousel [다시 제안] 버튼 노출 신호. */
  reviseAvailable: boolean;
  /** 01-brief 승인 시 RA 사후검수 필요 신호. */
  raOkRequired: boolean;
  /** 게이트 종류(파생 · 카드 스타일 힌트). */
  gateType: GateType;
  /** 구조화 멈춤 사유(없으면 null). */
  stopReason: StopReason | null;
  /** 읽기전용 보완 권고(없으면 null). */
  advisory: Advisory | null;
  /** 검토 파일 경로(복사본). */
  files: string[];
}

/**
 * NextAction 을 ViewModel 로 변환한다. 라벨은 passthrough(변형 없음), 컬렉션은 복사본으로 노출한다.
 */
export function toViewModel(na: NextAction): ViewModel {
  return {
    rid: na.rid,
    action: na.action,
    phase: na.phase,
    // 라벨 4종 — passthrough(변형 금지). 부재 시에만 "" 로 보정(값이 있으면 원문 그대로).
    header: na.phase_label ?? "",
    gateLabel: na.gate_label ?? "",
    hint: na.hint ?? "",
    cmd: na.cmd ?? "",
    iteration: na.iteration ?? null,
    maxIterations: na.max_iterations ?? null,
    stage: na.stage ?? null,
    needs: na.needs ?? null,
    // 컬렉션은 복사본으로(원본 NextAction 변형 방지) + 부재 시 빈 배열.
    options: Array.isArray(na.options) ? [...na.options] : [],
    recommended: na.recommended ?? null,
    reviseAvailable: na.revise_available ?? false,
    raOkRequired: na.ra_ok_required ?? false,
    gateType: na.gate_type ?? null,
    stopReason: na.stop_reason ?? null,
    advisory: na.advisory ?? null,
    files: Array.isArray(na.files) ? [...na.files] : [],
  };
}
