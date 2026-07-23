/**
 * index.ts — 자연어 이해(P3) 공개 표면 + 파서 선택.
 *
 * 선택 규칙(chat-dual-surface-plan 5-1 · 오프라인/CI 결정성 보존):
 *   1. 오프라인(HARNESS_OFFLINE=1) → StubNlParser (CI 결정성, 불변).
 *   2. CHAT_NL_PARSER 명시(stub|cli|api) → 그대로. **명시인데 불가**(cli: claude 미발견 / api: 키 없음) → 기동 fail-fast.
 *   3. auto(기본): cli 는 **과금 활성화 게이트(CHAT_NL_CLI_VERIFIED=1)** 통과 + claude 발견 시에만(잠긴 결정 6 —
 *      그 전까지 auto 에서 제외). 아니면 ANTHROPIC_API_KEY 있으면 api(LlmNlParser), 없으면 stub.
 *   selectGenExecutor 와 같은 **주입 가능 deps** 패턴 — 단위 테스트가 프로브/키/모드를 결정적으로 주입한다.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { anthropicApiKey, isOffline, nlCliTimeout, nlCliVerified, nlModel, nlParser } from "../../config.js";
import { CliNlParser } from "./cli-parser.js";
import { LlmNlParser } from "./llm-parser.js";
import type { NlParser } from "./parser.js";
import { StubNlParser } from "./stub-parser.js";

export type { NlFileRef, NlIntent, NlKind, NlParseContext, NlParser } from "./parser.js";
export { fieldsUncertain, isSetupComplete, SETUP_FIELDS } from "./parser.js";
export { StubNlParser } from "./stub-parser.js";
export { intentFromToolInput, LlmNlParser } from "./llm-parser.js";
export { CliNlParser } from "./cli-parser.js";
export {
  validateIntakeFiles,
  type AcceptedIntakeFile,
  type IntakeFileValidation,
  type RejectedIntakeFile,
} from "./intake-files.js";

/**
 * claude 실행파일 존재 프로브(기본) — **실행하지 않고** PATH 만 스캔한다. PATH(path.delimiter 분리)의 각
 *   디렉터리에 실행가능한 `claude` 파일이 있으면 true.
 *   ⚠ 프로브는 **불신 PATH 바이너리를 봇 환경으로 절대 실행해선 안 된다** — 예전 구현은 `claude --version` 을
 *     봇의 상속 env(Slack 토큰·Anthropic 자격·CODEX_* 마커·세션 신호)로 돌려서, PATH 상 악성 shim 이 그 비밀을
 *     탈취할 수 있었다. exec 없이 존재+실행권한만 확인해 이 유출면을 없앤다.
 */
function defaultHasClaudeBinary(): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK); // 존재 + 실행권한(실행은 하지 않음)
      return true;
    } catch {
      // 이 디렉터리엔 없음/실행 불가 — 다음 디렉터리로.
    }
  }
  return false;
}

/** selectNlParser 주입 deps(전부 선택 — 미주입 시 실 config/프로브). */
export interface SelectNlParserDeps {
  /** 오프라인 판정(기본 isOffline()). */
  offline?: boolean;
  /** 파서 모드(기본 nlParser() = env CHAT_NL_PARSER). */
  mode?: "auto" | "stub" | "cli" | "api";
  /** claude 실행파일 존재 프로브(기본 = 실 프로브). */
  hasClaudeBinary?: () => boolean;
  /**
   * Anthropic API 키. **미지정(속성 없음/undefined) = 실 config(env ANTHROPIC_API_KEY)** · **null = '키 없음'을
   *   명시 주입**. 둘을 가르는 이유: 다른 deps 는 '없음' 값이 undefined 가 아니라(false·"stub" 등) `?? 기본값` 으로
   *   충분하지만, 키의 '없음'은 곧 undefined 라 `?? anthropicApiKey()` 가 주변 env 로 새어 들어간다 —
   *   키가 export 된 개발/CI 프로세스에선 무키 분기(명시 api=fail-fast · auto=stub)를 테스트할 수 없다.
   */
  apiKey?: string | null;
  /** cli 과금 활성화 게이트 ack(기본 nlCliVerified() = env CHAT_NL_CLI_VERIFIED). */
  cliVerified?: boolean;
  /** 구조화 추출 모델(기본 nlModel()). */
  model?: string;
  /** cli 1콜 상한 ms(기본 nlCliTimeout()). */
  timeoutMs?: number;
}

/**
 * 환경/설정에 맞는 파서를 고른다(주입 deps 로 결정적 테스트 가능). 규칙은 위 헤더 주석 참조.
 *   기존 no-arg 호출부(selectNlParser())는 그대로 동작한다(deps 전부 기본값).
 * @throws 명시 모드가 불가능하면(cli+claude 미발견 · api+키없음) 기동 fail-fast Error.
 */
export function selectNlParser(deps?: SelectNlParserDeps): NlParser {
  const stub = new StubNlParser();

  const offline = deps?.offline ?? isOffline();
  if (offline) return stub; // 1. 오프라인 → stub(불변)

  const mode = deps?.mode ?? nlParser();
  const hasClaudeBinary = deps?.hasClaudeBinary ?? defaultHasClaudeBinary;
  // 키만 `??` 를 쓰지 않는다 — 주입된 '키 없음'(null)이 주변 env 로 대체되면 무키 분기가 테스트에서 사라진다(위 deps 주석).
  const apiKey = deps?.apiKey === undefined ? anthropicApiKey() : deps.apiKey;
  const cliVerified = deps?.cliVerified ?? nlCliVerified();
  const model = deps?.model ?? nlModel();
  const timeoutMs = deps?.timeoutMs ?? nlCliTimeout();

  const makeCli = (): NlParser => new CliNlParser({ fallback: stub, model, timeoutMs });
  const makeApi = (key: string): NlParser => new LlmNlParser({ apiKey: key, model, fallback: stub });

  switch (mode) {
    case "stub":
      return stub;
    case "cli":
      // 2. 명시 cli 인데 claude 미발견 → fail-fast(운영 미스터리 제거).
      if (!hasClaudeBinary()) {
        throw new Error(
          "CHAT_NL_PARSER=cli 인데 claude 실행파일을 찾을 수 없습니다 — PATH 에 claude 를 설치하거나 다른 파서를 지정하세요.",
        );
      }
      return makeCli();
    case "api":
      // 2. 명시 api 인데 키 없음 → fail-fast.
      if (!apiKey) {
        throw new Error(
          "CHAT_NL_PARSER=api 인데 ANTHROPIC_API_KEY 가 없습니다 — 키를 설정하거나 다른 파서를 지정하세요.",
        );
      }
      return makeApi(apiKey);
    case "auto":
    default:
      // 3. auto: cli 는 과금 게이트(cliVerified) 통과 전 제외(계획 5-1). cliVerified 를 먼저 봐 미검증 시
      //    claude 프로브(프로세스 spawn)를 아예 건너뛴다.
      if (cliVerified && hasClaudeBinary()) return makeCli();
      if (apiKey) return makeApi(apiKey);
      return stub;
  }
}
