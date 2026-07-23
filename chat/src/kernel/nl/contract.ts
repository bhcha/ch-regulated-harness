/**
 * contract.ts — 자연어 파서 계약 단일 모듈(플랫폼-중립 · CLI/실LLM 공통 SSoT).
 *
 * chat-dual-surface-plan 파서 계약 단일 모듈(잠긴 결정 5): "명시 선언만 추출, 내용 기반 추론 금지"(AGENTS 규칙 8 ·
 *   잠긴 결정 7) 규칙을 **한 곳에** 둔다. 실 LLM 파서(LlmNlParser, Anthropic Messages API)와 곧 추가될
 *   CLI 파서(CliNlParser)가 **같은 계약**(허용 집합 · JSON Schema · system 프롬프트 · 순수 매핑)을 소비하도록
 *   이 모듈에서 내보낸다. 어떤 표면도 이 계약을 재정의하지 않는다 — 여기가 유일 진실이다.
 *
 * 격리: 이 모듈은 어떤 플랫폼도, 하네스(core)도 모른다(순수 NL 계약). kernel/ 헥사고날 가드를 통과한다
 *   (slack/gchat 등 플랫폼 토큰 0).
 */
import { fieldsUncertain, type NlFileRef, type NlIntent, type NlKind } from "./parser.js";

/** 구조화 추출 도구 이름(tool_use 블록 매칭·tool_choice 강제 · CLI --json-schema 공용). */
export const INTENT_TOOL_NAME = "declare_intent";

/** 허용 도메인/포맷 CLI 토큰(LLM 이 벗어난 값을 주면 드롭). */
export const DOMAINS = new Set(["화장품", "의약외품", "건기식", "의약품"]);
export const FORMATS = new Set(["한장", "여러장"]);
export const KINDS = new Set<NlKind>(["setup", "intake", "execute", "unknown"]);
export const ROLES = new Set<NlFileRef["role"]>(["working_backwards", "test_report", "reference"]);
export const EXECUTES = new Set(["approve", "select", "revise", "start"]);

/**
 * INTENT_JSON_SCHEMA — declare_intent 입력의 JSON Schema. API 도구 래퍼(DECLARE_INTENT_TOOL.input_schema)와
 *   미래 CLI `--json-schema` 플래그가 **동일한** 스키마를 쓰도록 단독 내보낸다.
 */
export const INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["setup", "intake", "execute", "unknown"] },
    domain: { type: "string", enum: ["화장품", "의약외품", "건기식", "의약품"], description: "명시 선언 시에만" },
    format: { type: "string", enum: ["한장", "여러장"], description: "명시 선언 시에만" },
    product: { type: "string", description: "따옴표 인용 또는 '제품명은 X'로 명시된 제품명만" },
    execute: { type: "string", enum: ["approve", "select", "revise", "start"] },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["working_backwards", "test_report", "reference"] },
          path: { type: "string" },
        },
        required: ["role", "path"],
      },
    },
  },
  required: ["kind"],
} as const;

/** 구조화 추출 도구 — 단일 tool, tool_choice 로 강제해 확정적 JSON 을 받는다(API 래퍼). */
export const DECLARE_INTENT_TOOL = {
  name: INTENT_TOOL_NAME,
  description:
    "사용자가 챗에 남긴 자유 텍스트에서 '명시적으로 선언한' 것만 구조화한다. 내용으로 추론하지 말 것.",
  input_schema: INTENT_JSON_SCHEMA,
} as const;

export const SYSTEM_PROMPT = [
  "너는 규제 상세페이지 제작 챗봇의 자연어 이해기다.",
  "사용자 텍스트에서 사용자가 '명시적으로 선언한' 것만 declare_intent 도구로 뽑아라.",
  "규제도메인(화장품/의약외품/건기식/의약품)은 사람이 선언했을 때만 넣는다 — 제품 성격을 보고 추론하지 마라.",
  "제품명은 따옴표로 감쌌거나 '제품명은 …'처럼 명시했을 때만 넣는다.",
  "파일 경로(워킹백워드·시험성적서·참고자료)를 언급하면 files 에 role 과 함께 넣는다. 시험성적서는 role=test_report 로만 표시하고 자동 승격하지 마라.",
  "승인/시작/선택/보완 같은 실행 요청이면 kind=execute, execute 에 해당 값을 넣는다.",
].join("\n");

/**
 * tool_use.input(임의 JSON) → 정규화된 NlIntent. **순수 함수**(오프라인 단위 테스트 대상).
 *   허용 밖 값은 드롭하고, uncertain(빠진 setup 필드)을 재계산한다(LLM 이 uncertain 을 틀리게 줘도 커널이 재산정).
 */
export function intentFromToolInput(input: unknown): NlIntent {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

  const domain = str(o.domain);
  const format = str(o.format);
  const product = str(o.product);
  const executeRaw = str(o.execute);
  const kindRaw = str(o.kind);

  const files: NlFileRef[] = Array.isArray(o.files)
    ? o.files
        .map((f): NlFileRef | null => {
          const fo = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
          const path = str(fo.path);
          const roleRaw = str(fo.role);
          const role = roleRaw && ROLES.has(roleRaw as NlFileRef["role"]) ? (roleRaw as NlFileRef["role"]) : "reference";
          return path ? { role, path } : null;
        })
        .filter((f): f is NlFileRef => f !== null)
    : [];

  const cleanDomain = domain && DOMAINS.has(domain) ? domain : undefined;
  const cleanFormat = format && FORMATS.has(format) ? format : undefined;
  const execute = executeRaw && EXECUTES.has(executeRaw) ? (executeRaw as NlIntent["execute"]) : undefined;

  // kind 를 신뢰하되, 커널 규칙과 일치시킨다(파일 있으면 intake · 설정필드 있으면 setup 우선).
  let kind: NlKind;
  if (files.length > 0) kind = "intake";
  else if (cleanDomain || cleanFormat || product) kind = "setup";
  else if (execute) kind = "execute";
  else if (kindRaw && KINDS.has(kindRaw as NlKind)) kind = kindRaw as NlKind;
  else kind = "unknown";

  const uncertain =
    kind === "setup" || kind === "intake"
      ? fieldsUncertain({ domain: cleanDomain, format: cleanFormat, product })
      : [];

  const intent: NlIntent = { kind, files, uncertain, confidence: kind === "unknown" ? 0.3 : 0.9 };
  if (cleanDomain) intent.domain = cleanDomain;
  if (cleanFormat) intent.format = cleanFormat;
  if (product) intent.product = product;
  if (execute) intent.execute = execute;
  return intent;
}
