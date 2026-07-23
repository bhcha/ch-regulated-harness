/**
 * parser.ts — 자연어 이해(P3)의 중립 계약: NlParser 포트 + NlIntent 모델(플랫폼-중립).
 *
 * chat-hexagonal-gateway-plan P3: "이해는 자연어, 방아쇠는 버튼". 파서는 멘션/답글의 자유 텍스트를 **구조화된 의도**로만
 *   바꾼다(파싱·제안까지). 상태 변이·실행은 절대 하지 않는다 — 커널 flow 가 NlProposal 확인 카드를 띄우고, 사람이
 *   버튼을 눌러야 기존 잡 경로로 실행된다(오해석이 상태를 오염 못 하게 — 잠긴 결정 6).
 *
 * ⚠ 도메인 선언은 사람의 몫(AGENTS 규칙 8 · 잠긴 결정 7): 파서는 **명시 선언만** 추출한다("화장품이야"→cosmetic).
 *   내용 기반 추론 금지 — 선언이 없으면 미확신(uncertain)으로 남기고 flow 가 되묻는다.
 *
 * 격리: 이 모듈은 어떤 플랫폼도, 하네스(core)도 모른다. 두 구현이 이 포트를 만족한다 —
 *   StubNlParser(결정적 키워드 규칙 · 오프라인/CI 기본) · LlmNlParser(실 LLM 1콜 · env 뒤 · 오프라인 미검증).
 */

/** 주 의도 분류. */
export type NlKind = "setup" | "intake" | "execute" | "unknown";

/** NL 이 가리키는 파일 참조 1건(P3-2). role 은 하류 00a-intake 분류 힌트(자동 승격 아님 — W-3: test_report 는 intent 선언만). */
export interface NlFileRef {
  role: "working_backwards" | "test_report" | "reference";
  /** 사람이 준 원본 경로(검증 전 — 커널이 allowlist·realpath 봉쇄로 재검증). */
  path: string;
}

/**
 * 파싱 결과(중립). flow 가 이걸 보고 NlProposal 확인 카드를 만든다.
 *   · setup: domain/format/product 명시 선언(없으면 uncertain).
 *   · intake: files + (setup 필드 — intake.sh 가 도메인/포맷/제품명을 요구하므로 함께).
 *   · execute: 게이트 실행 의도(승인/선택/보완/시작) — flow 가 버튼 카드를 재게시(NL 은 실행하지 않음).
 */
export interface NlIntent {
  kind: NlKind;
  /** 규제도메인 CLI 토큰(화장품|의약외품|건기식|의약품) — 명시 선언만. */
  domain?: string;
  /** 산출물 포맷 CLI 토큰(한장|여러장) — 명시 선언만. */
  format?: string;
  /** 제품명(따옴표 인용 또는 "제품명은 X") — 명시만. */
  product?: string;
  /** 파일 참조(P3-2 · 없으면 빈 배열). */
  files: NlFileRef[];
  /** 게이트 실행 의도(있을 때만). */
  execute?: "approve" | "select" | "revise" | "start";
  /** 미확신(되물어야 할) 필드 이름(setup/intake 에서 빠진 domain/format/product). 그 외 kind 는 빈 배열. */
  uncertain: string[];
  /** 파서 확신도(0..1 · stub 은 규칙 매칭 여부로 대략). */
  confidence: number;
}

/** 파싱 문맥(선택) — 진행 중 run 여부 등 힌트. 순수 파서는 대체로 무시하지만 계약상 받는다. */
export interface NlParseContext {
  hasRun?: boolean;
}

/** 자연어 파서 포트 — flow 가 주입받아 소비. 절대 상태를 바꾸지 않는다(파싱만). */
export interface NlParser {
  parse(text: string, ctx?: NlParseContext): Promise<NlIntent>;
}

/** setup/intake 완결에 필요한 3필드. */
export const SETUP_FIELDS = ["domain", "format", "product"] as const;

/** domain/format/product 중 빠진 것의 이름 목록(되묻기 입력). */
export function fieldsUncertain(i: { domain?: string; format?: string; product?: string }): string[] {
  const out: string[] = [];
  if (!i.domain) out.push("domain");
  if (!i.format) out.push("format");
  if (!i.product) out.push("product");
  return out;
}

/** setup/intake 완결(3필드 모두 있음) 여부. */
export function isSetupComplete(i: { domain?: string; format?: string; product?: string }): boolean {
  return Boolean(i.domain && i.format && i.product);
}
