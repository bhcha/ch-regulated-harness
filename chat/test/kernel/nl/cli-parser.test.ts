/**
 * cli-parser.test.ts — CliNlParser + buildClaudeArgs + selectNlParser 분기(결정적 · 실 spawn 0).
 *
 * 전략(계획 7절 단위 계층): fake runClaude 를 주입해 봉투 파싱·폴백·도구감지·타임아웃을 실 claude 없이 검증한다.
 *   fallback 은 인식 가능한 sentinel 을 돌려주는 stub → 폴백 경로가 실제로 탔는지 반환값으로 확인.
 *   selectNlParser 는 주입 deps(offline/mode/probe/key/verified)로 매트릭스를 결정적으로 덮는다.
 *
 * ⚠ 실 claude 는 절대 spawn 하지 않는다(makeScratchDir/cleanup 도 주입해 실 FS 미접촉).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  CliNlParser,
  CLAUDE_TOOL_DISABLE_FLAG,
  extractIntentObject,
  looksToolFree,
  type RunClaudeArgs,
  type RunClaudeFn,
  type RunClaudeResult,
} from "../../../src/kernel/nl/cli-parser.js";
import { INTENT_JSON_SCHEMA } from "../../../src/kernel/nl/contract.js";
import { selectNlParser } from "../../../src/kernel/nl/index.js";
import { LlmNlParser } from "../../../src/kernel/nl/llm-parser.js";
import { StubNlParser } from "../../../src/kernel/nl/stub-parser.js";
import type { NlIntent, NlParser } from "../../../src/kernel/nl/parser.js";

/** 폴백이 탔음을 반환값으로 식별하는 sentinel 파서. */
const SENTINEL_CONFIDENCE = 0.4242;
class SentinelFallback implements NlParser {
  calls = 0;
  async parse(): Promise<NlIntent> {
    this.calls++;
    return { kind: "unknown", files: [], uncertain: [], confidence: SENTINEL_CONFIDENCE };
  }
}
const isSentinel = (i: NlIntent): boolean => i.confidence === SENTINEL_CONFIDENCE;

/** 고정 결과를 돌려주는 fake runClaude(+ 마지막 인자 캡처). */
function fakeRun(result: RunClaudeResult): { fn: RunClaudeFn; seen: RunClaudeArgs[] } {
  const seen: RunClaudeArgs[] = [];
  const fn: RunClaudeFn = async (args) => {
    seen.push(args);
    return result;
  };
  return { fn, seen };
}

/** 실 FS·spawn 미접촉 CliNlParser(스크래치/정리 주입). */
function makeCli(runClaude: RunClaudeFn, fallback: NlParser, baseEnv: NodeJS.ProcessEnv = {}): CliNlParser {
  return new CliNlParser({
    fallback,
    model: "claude-test",
    timeoutMs: 1234,
    runClaude,
    baseEnv,
    makeScratchDir: () => "/fake/scratch",
    cleanup: () => {},
  });
}

describe("CliNlParser — 봉투 파싱(성공 경로)", () => {
  it("structured_output 경로 → 도메인/포맷/제품/파일 정확 매핑(intentFromToolInput)", async () => {
    const { fn } = fakeRun({
      code: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({
        num_turns: 1,
        structured_output: {
          kind: "setup",
          domain: "화장품",
          format: "여러장",
          product: "릴리프 세럼",
          files: [
            { role: "working_backwards", path: "/wb.md" },
            { role: "test_report", path: "/r.pdf" },
          ],
        },
      }),
    });
    const i = await makeCli(fn, new SentinelFallback()).parse("...");
    expect(isSentinel(i)).toBe(false); // 폴백 아님
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
    expect(i.product).toBe("릴리프 세럼");
    expect(i.kind).toBe("intake"); // 파일 있으면 intentFromToolInput 이 intake
    expect(i.files).toEqual([
      { role: "working_backwards", path: "/wb.md" },
      { role: "test_report", path: "/r.pdf" },
    ]);
  });

  it("result 텍스트(코드펜스 감싼 JSON) 경로 → 파싱", async () => {
    const { fn } = fakeRun({
      code: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({
        num_turns: 1,
        result: '```json\n{"kind":"setup","domain":"의약품","format":"한장","product":"우루사"}\n```',
      }),
    });
    const i = await makeCli(fn, new SentinelFallback()).parse("...");
    expect(isSentinel(i)).toBe(false);
    expect(i.kind).toBe("setup");
    expect(i.domain).toBe("의약품");
    expect(i.format).toBe("한장");
    expect(i.product).toBe("우루사");
    expect(i.uncertain).toEqual([]);
  });

  it("hygienicSpawnEnv 가 러너 env 에 적용된다(CONFIG_DIR=스크래치 · ACK_GAPS=0)", async () => {
    const { fn, seen } = fakeRun({ code: 0, timedOut: false, stderr: "", stdout: "{}" });
    await makeCli(fn, new SentinelFallback(), { ANTHROPIC_API_KEY: "leak", PATH: "/usr/bin" }).parse("...");
    const env = seen[0]!.env;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/fake/scratch"); // 전용 격리 CONFIG_DIR
    expect(env.HARNESS_ACK_GAPS).toBe("0"); // 핀 고정
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // 과금 키 스크럽됨
    expect(seen[0]!.cwd).toBe("/fake/scratch"); // 빈 스크래치 cwd
  });

  it("CLAUDE_CODE_OAUTH_TOKEN 이 있으면 러너 env 로 주입된다(격리 CONFIG_DIR 로 끊긴 구독 인증 복원)", async () => {
    const { fn, seen } = fakeRun({ code: 0, timedOut: false, stderr: "", stdout: "{}" });
    // baseEnv 에 구독 토큰 + API 키가 동시에 있어도: OAuth 는 주입(구독 인증), API 키는 스크럽(과금 누수 차단).
    await makeCli(fn, new SentinelFallback(), {
      CLAUDE_CODE_OAUTH_TOKEN: "sub-oauth-abc",
      ANTHROPIC_API_KEY: "leak",
      ANTHROPIC_AUTH_TOKEN: "leak-bearer",
      PATH: "/usr/bin",
    }).parse("...");
    const env = seen[0]!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sub-oauth-abc"); // 구독 인증 자격증명 전달
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // 여전히 API 키 스크럽(우선순위상 -p 가 API 로 새는 사고 차단)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined(); // bearer 토큰(우선순위 2위)도 스크럽 — OAuth(5위)만 남게
  });

  it("CLAUDE_CODE_OAUTH_TOKEN 이 없으면 주입하지 않는다(인증 실패 → 안전 폴백은 상위에서)", async () => {
    const { fn, seen } = fakeRun({ code: 0, timedOut: false, stderr: "", stdout: "{}" });
    await makeCli(fn, new SentinelFallback(), { PATH: "/usr/bin" }).parse("...");
    expect(seen[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("CliNlParser — 실패는 전부 fallback 강등", () => {
  it("code!==0 → fallback", async () => {
    const fb = new SentinelFallback();
    const { fn } = fakeRun({ code: 2, timedOut: false, stderr: "boom", stdout: "" });
    const i = await makeCli(fn, fb).parse("화장품이야");
    expect(isSentinel(i)).toBe(true);
    expect(fb.calls).toBe(1);
  });

  it("timedOut → fallback", async () => {
    const fb = new SentinelFallback();
    const { fn } = fakeRun({ code: 124, timedOut: true, stderr: "", stdout: "" });
    expect(isSentinel(await makeCli(fn, fb).parse("..."))).toBe(true);
  });

  it("파싱 불가 stdout → fallback", async () => {
    const fb = new SentinelFallback();
    const { fn } = fakeRun({ code: 0, timedOut: false, stderr: "", stdout: "not json at all" });
    expect(isSentinel(await makeCli(fn, fb).parse("..."))).toBe(true);
  });

  it("도구 사용/이상(is_error) → 결과 폐기·fallback", async () => {
    const fb = new SentinelFallback();
    const { fn } = fakeRun({
      code: 0,
      timedOut: false,
      stderr: "",
      // 유효한 structured_output 이 있어도 is_error 면 폐기해야 한다.
      stdout: JSON.stringify({ is_error: true, structured_output: { kind: "setup", domain: "화장품" } }),
    });
    expect(isSentinel(await makeCli(fn, fb).parse("..."))).toBe(true);
  });

  it("실제 도구 사용 흔적(permission_denials 비어있지 않음) → 결과 폐기·fallback", async () => {
    const fb = new SentinelFallback();
    const { fn } = fakeRun({
      code: 0,
      timedOut: false,
      stderr: "",
      // structured_output 이 유효해도 실제 도구 호출 흔적이 있으면 폐기.
      stdout: JSON.stringify({ permission_denials: [{ tool: "Read" }], structured_output: { kind: "setup", domain: "화장품" } }),
    });
    expect(isSentinel(await makeCli(fn, fb).parse("..."))).toBe(true);
  });

  it("실측형 다중턴 봉투(num_turns=3·stop_reason tool_use·denials 빈배열)는 폴백 아님 — structured_output 채택", async () => {
    // 실 CLI 실측: --json-schema 구조화출력이 다중턴으로 나오지만 내장 도구 미실행 → 정상 결과여야 한다(회귀 가드).
    const { fn } = fakeRun({
      code: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({
        is_error: false,
        num_turns: 3,
        stop_reason: "tool_use",
        permission_denials: [],
        structured_output: { kind: "setup", domain: "화장품", format: "여러장", files: [] },
      }),
    });
    const i = await makeCli(fn, new SentinelFallback()).parse("화장품이고 여러장이야");
    expect(isSentinel(i)).toBe(false); // 폴백 아님
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
  });
});

describe('looksToolFree — 실제 도구 사용 흔적만 폐기(--tools "" 가 1차 경계 · 턴 수 무관)', () => {
  it("깨끗한 봉투 → true (num_turns 는 판정에서 뺀다)", () => {
    expect(looksToolFree({ is_error: false, num_turns: 1 })).toBe(true);
    expect(looksToolFree({ num_turns: 1 })).toBe(true);
    // 실측 실 CLI 봉투: 구조화출력이 num_turns=3·stop_reason "tool_use" 로 나오지만 내장 도구 미실행 → true(회귀 가드).
    expect(looksToolFree({ is_error: false, num_turns: 3, stop_reason: "tool_use", permission_denials: [] })).toBe(true);
    expect(looksToolFree({ num_turns: 2 })).toBe(true); // 턴 수는 위험 신호 아님
    expect(looksToolFree({ permission_denials: [] })).toBe(true); // 빈 배열 = 흔적 아님
    expect(looksToolFree({})).toBe(true); // 도구 흔적 없으면 통과(봉투는 우리 CLI 출력 · 결과 객체 유효성은 extract 가 별도 검증)
  });
  it("실제 도구 사용 흔적 → false", () => {
    expect(looksToolFree({ is_error: true })).toBe(false); // 에러 봉투(예: 인증 실패)
    expect(looksToolFree({ permission_denials: [{ tool: "Bash" }] })).toBe(false);
    // 비-배열 truthy(객체·문자열)도 도구 시도 흔적으로 본다(비-배열 truthy 가 새던 구멍 봉쇄).
    expect(looksToolFree({ permission_denials: { tool: "Read" } })).toBe(false);
    expect(looksToolFree({ permission_denials: "denied" })).toBe(false);
    // 명시 도구 사용 마커(tool_use·tool_calls) → false.
    expect(looksToolFree({ tool_use: { name: "Read" } })).toBe(false);
    expect(looksToolFree({ tool_calls: [{ name: "Bash" }] })).toBe(false);
  });
});

describe("extractIntentObject — 우선순위(structured_output > result)", () => {
  it("structured_output 우선", () => {
    const o = extractIntentObject(
      JSON.stringify({ structured_output: { kind: "setup" }, result: '{"kind":"execute"}' }),
    );
    expect(o).toEqual({ kind: "setup" });
  });
  it("structured_output 없으면 result JSON", () => {
    expect(extractIntentObject(JSON.stringify({ result: '{"kind":"execute"}' }))).toEqual({
      kind: "execute",
    });
  });
  it("실측형 다중턴 봉투(num_turns=3·stop_reason tool_use·denials 빈배열)도 structured_output 채택(회귀)", () => {
    const env = {
      is_error: false,
      num_turns: 3,
      stop_reason: "tool_use",
      permission_denials: [],
      structured_output: { kind: "setup", domain: "화장품" },
    };
    expect(extractIntentObject(JSON.stringify(env))).toEqual({ kind: "setup", domain: "화장품" });
  });
  it("실제 도구 흔적(permission_denials 비어있지 않음)이면 폐기 → undefined", () => {
    expect(
      extractIntentObject(JSON.stringify({ structured_output: { kind: "setup" }, permission_denials: [{ tool: "Read" }] })),
    ).toBeUndefined();
  });
  it("둘 다 객체 아님 → undefined", () => {
    expect(extractIntentObject(JSON.stringify({ num_turns: 1, result: "그냥 텍스트" }))).toBeUndefined();
    expect(extractIntentObject("깨진 출력")).toBeUndefined();
  });
});

describe("buildClaudeArgs — 필수 플래그", () => {
  it("-p · --output-format json · --json-schema(인라인 JSON) · 빈 도구목록(--tools) 포함", () => {
    const schemaJson = JSON.stringify(INTENT_JSON_SCHEMA);
    const args = buildClaudeArgs({ model: "m", prompt: "hi", schemaJson });
    const joined = args.join(" ");
    expect(args).toContain("-p");
    expect(joined).toContain("--output-format json");
    expect(args).toContain("--json-schema");
    // --json-schema 다음 인자는 **인라인 JSON 문자열**이어야 한다(파일 경로 아님, 실측 CLI 2.1.210).
    const schemaIdx = args.indexOf("--json-schema");
    expect(args[schemaIdx + 1]).toBe(schemaJson);
    expect(args[schemaIdx + 1]!.startsWith("{")).toBe(true); // 경로가 아니라 JSON 객체 문자열
    expect(CLAUDE_TOOL_DISABLE_FLAG).toBe("--tools"); // 실측 CLI 2.1.210: 사용 가능 도구 집합 지정(허용목록보다 강함)
    expect(args).toContain(CLAUDE_TOOL_DISABLE_FLAG); // 빈 도구목록(--tools "") = 사용 가능 도구 0
    expect(args).toContain("m"); // 모델
    // 도구 비활성 플래그(variadic)는 맨 끝, 그 뒤는 빈 문자열(도구목록 비움)
    expect(args[args.length - 2]).toBe(CLAUDE_TOOL_DISABLE_FLAG);
    expect(args[args.length - 1]).toBe("");
  });
});

describe("selectNlParser — 매트릭스(주입 deps)", () => {
  const base = { model: "m", timeoutMs: 1000 };

  // ⚠ 밀폐(hermetic): 이 매트릭스는 **주입 deps 만**으로 판정돼야 한다. 주변 env 에 키가 export 된 개발/CI
  //   프로세스에서도 같은 결과가 나오는지 보려고, 여기선 일부러 키를 심어 둔다 — 무키 분기는 `apiKey: null`
  //   (명시 주입)로 표현하고, 그게 이 env 를 이겨야 한다(이기지 못하면 무키 분기가 기계에 따라 사라진다).
  const AMBIENT_KEY = "sk-ambient-must-not-leak-into-deps";
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = AMBIENT_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("오프라인 → Stub", () => {
    expect(selectNlParser({ offline: true })).toBeInstanceOf(StubNlParser);
  });

  it("mode cli + claude 발견 → Cli", () => {
    expect(
      selectNlParser({ offline: false, mode: "cli", hasClaudeBinary: () => true, ...base }),
    ).toBeInstanceOf(CliNlParser);
  });

  it("mode cli + claude 미발견 → throw(fail-fast)", () => {
    expect(() => selectNlParser({ offline: false, mode: "cli", hasClaudeBinary: () => false, ...base })).toThrow(
      /claude/,
    );
  });

  it("mode api + 키 있음 → Llm", () => {
    expect(selectNlParser({ offline: false, mode: "api", apiKey: "sk", ...base })).toBeInstanceOf(LlmNlParser);
  });

  it("mode api + 키 없음(null 명시 주입) → throw(fail-fast · 주변 env 키를 끌어오지 않는다)", () => {
    expect(() => selectNlParser({ offline: false, mode: "api", apiKey: null, ...base })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("apiKey 미지정(속성 없음) → 실 config(주변 env) 사용 — null 과 구분된다", () => {
    // 이 대비가 밀폐의 근거다: 미지정 = env 위임(운영 기본값) · null = '키 없음' 명시(테스트가 무키를 재현).
    expect(selectNlParser({ offline: false, mode: "api", ...base })).toBeInstanceOf(LlmNlParser);
  });

  it("auto + claude 발견 + 과금 검증됨 → Cli", () => {
    expect(
      selectNlParser({ offline: false, mode: "auto", hasClaudeBinary: () => true, cliVerified: true, ...base }),
    ).toBeInstanceOf(CliNlParser);
  });

  it("auto + claude 발견 + 미검증 → (키 있으면 Llm)", () => {
    expect(
      selectNlParser({
        offline: false,
        mode: "auto",
        hasClaudeBinary: () => true,
        cliVerified: false,
        apiKey: "sk",
        ...base,
      }),
    ).toBeInstanceOf(LlmNlParser);
  });

  it("auto + claude 발견 + 미검증 + 무키 → Stub", () => {
    expect(
      selectNlParser({
        offline: false,
        mode: "auto",
        hasClaudeBinary: () => true,
        cliVerified: false,
        apiKey: null,
        ...base,
      }),
    ).toBeInstanceOf(StubNlParser);
  });

  it("auto + claude 미발견 + 키 있음 → Llm(검증돼 있어도 바이너리 없으면 cli 불가)", () => {
    expect(
      selectNlParser({
        offline: false,
        mode: "auto",
        hasClaudeBinary: () => false,
        cliVerified: true,
        apiKey: "sk",
        ...base,
      }),
    ).toBeInstanceOf(LlmNlParser);
  });

  it("auto + 아무것도 없음 → Stub", () => {
    expect(
      selectNlParser({
        offline: false,
        mode: "auto",
        hasClaudeBinary: () => false,
        cliVerified: false,
        apiKey: null,
        ...base,
      }),
    ).toBeInstanceOf(StubNlParser);
  });

  it("미검증(auto)에서는 claude 프로브를 호출하지 않는다(과금 게이트 우선)", () => {
    let probed = false;
    selectNlParser({
      offline: false,
      mode: "auto",
      hasClaudeBinary: () => {
        probed = true;
        return true;
      },
      cliVerified: false,
      apiKey: null,
      ...base,
    });
    expect(probed).toBe(false); // cliVerified=false 라 short-circuit
  });
});
