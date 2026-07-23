/**
 * llm-parser.ts — 실 LLM 자연어 파서(구조화 출력 1콜 · Anthropic Messages API 직접 HTTPS).
 *
 * chat-hexagonal-gateway-plan P3: 온라인·키 존재 시 이 파서가 구조화 추출을 한다(오프라인/CI 는 StubNlParser).
 *   ⚠ **오프라인 테스트 대상이 아니다** — 실제 네트워크(Anthropic API)가 필요하다. 순수 응답-매핑(intentFromToolInput)만
 *     오프라인 단위 테스트로 덮고, HTTP 호출 자체는 라이브 수동 검증이다(테스트에서 실 API 호출 금지).
 *
 * 인증·모델: `ANTHROPIC_API_KEY`(config.anthropicApiKey) + `CHAT_NL_MODEL`(기본 claude-sonnet-5, config.nlModel).
 *   신규 무거운 의존성 없이 Node 전역 fetch + tool-use(구조화 출력)로 추출한다. 어떤 실패(무키/네트워크/파싱)든
 *   주입된 fallback(StubNlParser)으로 우아하게 강등 — flow 는 절대 예외로 깨지지 않는다.
 *
 * 격리(잠긴 결정 7): 파서 계약(SYSTEM_PROMPT·DECLARE_INTENT_TOOL·intentFromToolInput = "명시 선언만 추출,
 *   내용 기반 추론 금지")은 이제 `./contract.js` 단일 모듈에 산다(잠긴 결정 5 — CLI 파서와 공유). 이 파일은 그 계약을
 *   Anthropic Messages API HTTP 표면에만 결합한다. LLM 클라이언트는 커널 관심사(플랫폼-중립 — slack/gchat 토큰 0)라
 *   kernel/ 에 있어도 헥사고날 가드를 통과한다.
 */
import { DECLARE_INTENT_TOOL, SYSTEM_PROMPT, intentFromToolInput } from "./contract.js";
import { type NlIntent, type NlParseContext, type NlParser } from "./parser.js";

/** 파서 계약(intentFromToolInput)을 재노출 — nl/index.ts 의 기존 re-export 경로를 유지한다. */
export { intentFromToolInput } from "./contract.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface LlmNlParserDeps {
  apiKey: string;
  model: string;
  /** 어떤 실패든 강등할 결정적 파서(보통 StubNlParser). */
  fallback: NlParser;
  /** 테스트/주입용(기본 = 전역 fetch). 오프라인 단위 테스트는 이 파서를 직접 부르지 않는다(순수 매핑만 검증). */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/**
 * 실 LLM 파서 — Anthropic Messages API 에 tool_choice 로 구조화 추출 1콜.
 *   실패(무응답/비-200/도구블록 없음/예외)면 fallback.parse 로 강등한다(flow 무중단).
 */
export class LlmNlParser implements NlParser {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  constructor(private readonly deps: LlmNlParserDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.endpoint = deps.endpoint ?? ANTHROPIC_MESSAGES_URL;
  }

  async parse(text: string, ctx?: NlParseContext): Promise<NlIntent> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.deps.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.deps.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: [DECLARE_INTENT_TOOL],
          tool_choice: { type: "tool", name: DECLARE_INTENT_TOOL.name },
          messages: [{ role: "user", content: text ?? "" }],
        }),
      });
      if (!res.ok) return this.deps.fallback.parse(text, ctx);
      const data = (await res.json()) as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
      const block = (data.content ?? []).find((b) => b.type === "tool_use" && b.name === DECLARE_INTENT_TOOL.name);
      if (!block) return this.deps.fallback.parse(text, ctx);
      return intentFromToolInput(block.input);
    } catch {
      return this.deps.fallback.parse(text, ctx);
    }
  }
}
