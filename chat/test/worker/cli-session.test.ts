/**
 * cli-session.test.ts — 무인 세션 조립(argv · cwd · env · 격리 settings)의 회귀 가드.
 *
 * 이 스위트가 지키는 것:
 *   1. **부록A-9 축의 결박** — '작동한 최소 구성'의 여섯 축이 전부, 그 형태 그대로 조립된다(하나라도 빠지면 실패).
 *   2. **금지 플래그 트립와이어** — `--bare`(= API 과금 경로 · 부록A-6 · 잠긴 결정 6) 와 승인 우회 계열이
 *      **어떤 경로로도** argv 에 들어가지 못한다.
 *   3. **env 위생** — 과금키·마커·플랫폼 비밀이 무인 세션에 상속되지 않고 `HARNESS_ACK_GAPS` 는 "0" 으로 핀.
 *   4. **settings 결정성** — 같은 입력 → 바이트 동일. 실행마다 흔들리는 경계는 경계가 아니다.
 *   5. **적대 우회 표(조립 수준)** — 계획의 우회 표 각 행이 우리가 만든 allow 집합에 **매칭될 여지조차 없음**을 고정.
 *   6. **fail-closed** — 검증 안 된 도메인·rid·상한은 조립 단계에서 끊는다.
 *
 * ⚠ **이 스위트는 조립만 못 박는다.** 규칙 문자열이 실제로 무엇을 막는지(정확일치인지 · 체이닝을 통째로 거부하는지 ·
 *   경로 글롭이 Bash 경유 읽기에도 걸리는지)는 **부록A-5 의 라이브 실측**이 답한 것이고, 여기서 증명되지 않는다.
 *   따라서 **CLI 업그레이드 때 적대 카나리를 다시 돌려야 한다**(계획 7번 절 R-1·R-7 이 같은 ⚠ 를 진다).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { chatSecretEnvNames } from "../../src/config.js";
import {
  DECISION_SCRIPTS,
  SESSION_CLAUDEAI_MCP_ENV,
  SESSION_CLAUDEAI_MCP_VALUE,
  SESSION_SETTING_SOURCES,
  SESSION_TOOLS,
  WORKER_SETTINGS_FILENAME,
  buildAddDirs,
  buildDisallowedTools,
  buildRunCwd,
  buildSessionArgs,
  buildSessionEnv,
  buildSessionPlan,
  buildWorkerSettings,
  serializeWorkerSettings,
} from "../../src/worker/cli-session.js";
import { rewriteSkill } from "../../src/worker/skill-rewrite.js";

/**
 * 고정 상수 — 절대경로 조립 결과를 **리터럴로** 단언하려면 머신마다 달라지는 실제 경로를 쓰면 안 된다
 *   (CI·타 머신에서 오실패). 조립 모듈은 순수해서 경로를 열지 않으므로 실재하지 않아도 무해하다.
 */
const FIXED_CORE = "/abs/core";
const FIXED_RID = "pin-rid-0717";
const FIXED_DOMAIN = "cosmetic";
const FIXED_CONFIG_DIR = "/abs/worker/job-config";
const FIXED_TOKEN = "sk-ant-oat-fixture";

/** 형제 core 체크아웃(모노레포 배치: chat/ 와 core/ 는 형제). 결박 핀이 **원문**을 읽어야 하므로 실경로. */
const REAL_CORE = join(dirname(fileURLToPath(import.meta.url)), "../../../core");
const realSkill = (stage: string): string => readFileSync(join(REAL_CORE, "skills", stage, "SKILL.md"), "utf8");

/** 조립 입력의 allow 규칙은 **손으로 짜지 않는다**(부록A-9 교훈) — 실제 SKILL.md 도출 산물을 그대로 쓴다. */
const briefRewrite = () =>
  rewriteSkill({ skillMd: realSkill("brief"), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

const EXPECTED_ADD_DIRS = [
  `${FIXED_CORE}/prompts`,
  `${FIXED_CORE}/harness`,
  `${FIXED_CORE}/scripts`,
  "/abs/packs/cosmetic", // core 의 형제 packs/ + 선언 도메인 하나
];

const EXPECTED_DISALLOWED = [
  `Bash(bash ${FIXED_CORE}/scripts/a2ui-action.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/advance-phase.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/apply-learnings.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/approve.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/gate.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/ingest-bundle.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/ingest.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/intake.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/kcia-check.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/new-run.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/revise.sh:*)`,
  `Bash(bash ${FIXED_CORE}/scripts/select.sh:*)`,
];

/** 조립 편의 — 기본은 '실제 brief 도출 산물 + 깨끗한 base env'. */
function planFixture(over: Partial<Parameters<typeof buildSessionPlan>[0]> = {}) {
  const { prompt, allowRules } = briefRewrite();
  return buildSessionPlan({
    coreRoot: FIXED_CORE,
    rid: FIXED_RID,
    domain: FIXED_DOMAIN,
    prompt,
    allowRules,
    maxTurns: 50,
    configDir: FIXED_CONFIG_DIR,
    baseEnv: { PATH: "/usr/bin" },
    ...over,
  });
}

// ── 1. 부록A-9 축 결박 ────────────────────────────────────────────────────────

describe("argv 조립 — 부록A-9 '작동한 최소 구성'의 축이 전부 있다", () => {
  test("합성 입력의 argv 전문이 기대 형태와 정확히 같다(순서·토큰까지)", () => {
    const argv = buildSessionArgs({
      prompt: "---\nname: brief\n---\n# /brief",
      allowRules: ["Bash(bash /abs/core/scripts/run-stage.sh brief pin-rid-0717 --emit-context)"],
      disallowRules: [`Bash(bash ${FIXED_CORE}/scripts/approve.sh:*)`],
      maxTurns: 50,
      addDirs: EXPECTED_ADD_DIRS,
    });

    expect(argv).toEqual([
      "-p",
      "--output-format",
      "json", // 봉투가 있어야 러너가 결과·비용·permission_denials 를 읽는다
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "50",
      "--setting-sources",
      "user", // project/local 배제 — 레포의 settings.local.json 이 무인 경계에 병합되지 않는다
      "--strict-mcp-config", // --mcp-config 없음 = MCP 서버 0개(도구 표면 결정성)
      "--add-dir",
      `${FIXED_CORE}/prompts`,
      `${FIXED_CORE}/harness`,
      `${FIXED_CORE}/scripts`,
      "/abs/packs/cosmetic",
      "--tools",
      "Bash,Read,Write,Edit,Glob,Grep",
      "--allowedTools",
      "Bash(bash /abs/core/scripts/run-stage.sh brief pin-rid-0717 --emit-context)",
      "--disallowedTools",
      `Bash(bash ${FIXED_CORE}/scripts/approve.sh:*)`,
      "--",
      "---\nname: brief\n---\n# /brief",
    ]);
  });

  test("--tools 는 부록A-9 리터럴 그대로다(도구를 늘리지도 줄이지도 않는다)", () => {
    const { argv } = planFixture();
    expect(SESSION_TOOLS).toBe("Bash,Read,Write,Edit,Glob,Grep");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit,Glob,Grep");
  });

  test("--permission-mode 는 acceptEdits(파일 작성 자동승인 · Bash 는 규칙이 지배)", () => {
    const { argv } = planFixture();
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  test("--setting-sources 는 정확히 'user' 하나다 — project/local 은 어떤 형태로도 실리지 않는다", () => {
    // 격리 CLAUDE_CONFIG_DIR 는 **user 설정만** 옮긴다. project/local 은 별개 소스라, cwd 가 레포 안인 이 세션에는
    //   레포의 `.claude/settings.local.json` 이 그대로 병합된다(실재 확인: 결정 명령 `select.sh …` allow +
    //   cwd 밖 절대경로 `Read(//Users/…/**)` allow). 그 파일은 사람이 '허용'을 누를 때마다 자라므로,
    //   핀이 풀리면 무인 경계가 **사람의 클릭을 따라 조용히 넓어진다** = 불변식 위반.
    const { argv } = planFixture();
    expect(SESSION_SETTING_SOURCES).toBe("user");
    const at = argv.indexOf("--setting-sources");
    expect(at).toBeGreaterThan(-1); // 플래그 자체가 사라지면 CLI 기본값(= user,project,local)으로 되돌아간다
    expect(argv[at + 1]).toBe("user");

    // 값 자리를 '포함'이 아니라 **정확일치**로 본다: "user,project" 같은 확장이 조용히 통과하면 안 된다.
    const sources = argv[at + 1].split(",").map((s) => s.trim());
    expect(sources).toEqual(["user"]);
    for (const forbidden of ["project", "local"]) expect(sources).not.toContain(forbidden);
  });

  test("--strict-mcp-config 가 실린다 — 그리고 --mcp-config 는 없다(= MCP 서버 0개)", () => {
    // `--tools` 는 빌트인만 제한한다. core/.mcp.json(openalex-paper-search)이 실재하고 cwd 가 core 안이라
    //   이 핀이 없으면 프로젝트 MCP 서버가 도구 표면에 붙는다.
    //   ⚠ 우회 증명이 아니다 — MCP 도구도 제 승인이 필요해 헤드리스면 어차피 fail-closed. 여기서 지키는 건 **결정성**.
    const { argv } = planFixture();
    expect(argv).toContain("--strict-mcp-config");
    // strict 는 '--mcp-config 것만 쓴다'는 뜻이라, --mcp-config 를 주면 서버가 0개가 아니게 된다.
    expect(argv).not.toContain("--mcp-config");
  });

  test("--strict-mcp-config 는 불리언이다 — 뒤 토큰을 값으로 삼키지 않는다", () => {
    // 값 있는 플래그로 잘못 다루면 뒤 플래그가 값으로 먹혀 조립이 통째로 어긋난다(순서 규약 ②).
    const { argv } = planFixture();
    expect(argv[argv.indexOf("--strict-mcp-config") + 1]).toBe("--add-dir");
  });

  test("--add-dir 는 4종(core/prompts·harness·scripts + 선언 도메인 팩)뿐이고 전부 절대경로다", () => {
    const { argv, addDirs } = planFixture();
    expect(addDirs).toEqual(EXPECTED_ADD_DIRS);
    const at = argv.indexOf("--add-dir");
    expect(argv.slice(at + 1, at + 5)).toEqual(EXPECTED_ADD_DIRS);
    // 다섯 번째 자리는 이미 다음 플래그여야 한다 — 경로가 더 열리면 읽기 경계가 그만큼 넓어진다.
    expect(argv[at + 5]).toBe("--tools");
    for (const dir of addDirs) expect(dir.startsWith("/")).toBe(true);
  });

  test("packs 루트를 통째로 열지 않는다(선언 도메인 하나만) — 남의 도메인 룰셋은 경계 밖", () => {
    const { addDirs } = planFixture();
    expect(addDirs).toContain("/abs/packs/cosmetic");
    expect(addDirs).not.toContain("/abs/packs");
    expect(addDirs.some((d) => d === "/abs/packs/drug" || d === "/abs/packs/health_food")).toBe(false);
  });

  test("--max-turns 가 실린다(폭주 세션의 하드 천장)", () => {
    const { argv } = planFixture({ maxTurns: 31 });
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("31");
  });

  test("allow 규칙은 SKILL.md 도출 산물 그대로 실린다(손으로 짜지 않는다 — 부록A-9)", () => {
    const { allowRules } = briefRewrite();
    const { argv } = planFixture();
    const at = argv.indexOf("--allowedTools");
    expect(argv.slice(at + 1, at + 1 + allowRules.length)).toEqual(allowRules);
    // 실제 결박 핀: brief 는 읽기전용 입력 로드 + 전이 두 줄이다(원문이 바뀌면 여기서 깨진다 = R-3 조기경보).
    expect(allowRules).toEqual([
      `Bash(bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID} --emit-context)`,
      `Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID})`,
    ]);
  });

  test("cwd = 런 디렉터리다(= 읽기 경계 · 부록A-4). core 를 cwd 로 잡지 않는다", () => {
    const { cwd } = planFixture();
    // core 를 cwd 로 잡으면 core/runs/* 전체가 경계 안 = 타 런 읽기 허용(A-7 3번이 재검토를 요구한 지점).
    expect(cwd).toBe(`${FIXED_CORE}/runs/${FIXED_RID}`);
    expect(cwd).not.toBe(FIXED_CORE);
  });

  test("프롬프트는 `--` 뒤 피연산자다 — SKILL.md frontmatter(`---`)가 옵션으로 오독되는 것을 막는다", () => {
    const { prompt } = briefRewrite();
    const { argv } = planFixture();
    // 실측(claude 2.1.212 · 파서 수준 · API 콜 없음): `--` 없이 넘기면 `unknown option '---…'` 로 즉사한다.
    expect(prompt.startsWith("---")).toBe(true); // 전제: 모든 SKILL.md 는 frontmatter 로 시작한다
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe(prompt);
    // `--` 뒤에는 프롬프트 하나뿐 — 뒤에 뭘 더 붙이면 그 토큰도 피연산자가 돼 프롬프트 해석이 흐려진다.
    expect(argv.slice(argv.indexOf("--") + 1)).toHaveLength(1);
  });

  test("조립은 결정적이다 — 같은 입력 두 번 → 동일 argv/cwd/env/settings", () => {
    expect(planFixture()).toEqual(planFixture());
  });
});

// ── 2. 금지 플래그 트립와이어 ─────────────────────────────────────────────────

describe("금지 플래그 — 과금·경계 해제 트립와이어", () => {
  /**
   * ⚠ 이 테스트가 무너지면 **구독이 아니라 API 과금**으로 새거나(잠긴 결정 6) 경계가 통째로 사라진다.
   *   · `--bare`(부록A-6): 인증이 `ANTHROPIC_API_KEY`/`apiKeyHelper` 로 강제되고 OAuth·keychain 을 절대 안 읽는다.
   *   · `--dangerously-*` / `bypassPermissions`: 승인 게이트가 곧 실행 경계인데(A-3) 그걸 끄는 스위치다.
   */
  const FORBIDDEN = [
    "--bare",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "bypassPermissions",
  ];

  test("금지 플래그는 argv 어디에도 없다(플래그 자리든 값 자리든)", () => {
    const { argv } = planFixture();
    for (const flag of FORBIDDEN) {
      expect(argv).not.toContain(flag);
      expect(argv.some((token) => token.includes(flag))).toBe(false);
    }
  });

  test("금지 플래그는 `--` 앞(옵션 구간) 어디에도 없다 — 프롬프트 본문 언급은 무해하다", () => {
    const { argv } = planFixture();
    const options = argv.slice(0, argv.indexOf("--"));
    for (const flag of FORBIDDEN) expect(options.some((t) => t.includes(flag))).toBe(false);
  });

  test("규칙·경로 토큰이 '-' 로 시작하면 거부한다 — 그 토큰은 파서에게 '플래그'로 보인다", () => {
    // 이게 caller 문자열이 **플래그로 승격되는** 유일한 길이다(예: 규칙인 척 넘어온 `--dangerously-skip-permissions`).
    //   덤으로 variadic 수집이 그 토큰에서 조기 종료돼 뒤 규칙이 조용히 누락되는 것도 함께 막는다.
    const base = {
      prompt: "p",
      allowRules: ["Bash(echo hi)"],
      disallowRules: [],
      maxTurns: 5,
      addDirs: EXPECTED_ADD_DIRS,
    };
    expect(() => buildSessionArgs({ ...base, allowRules: ["--dangerously-skip-permissions"] })).toThrow(/'-' 로 시작할 수 없습니다/);
    expect(() => buildSessionArgs({ ...base, disallowRules: ["--bare"] })).toThrow(/'-' 로 시작할 수 없습니다/);
    expect(() => buildSessionArgs({ ...base, addDirs: ["--add-dir"] })).toThrow(/'-' 로 시작할 수 없습니다/);
  });
});

// ── 3. env 위생 ───────────────────────────────────────────────────────────────

describe("buildSessionEnv — 위생·격리·인증", () => {
  /** 오염된 base: 개발 세션이 물려주는 마커·과금키·플랫폼 비밀 + 운영자가 켜둔 결손 무시 스위치. */
  const DIRTY_BASE = (): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/worker",
      HARNESS_ACK_GAPS: "1", // 사람이 켜둔 '결손 무시' — 무인 세션에 상속되면 안 된다
      ANTHROPIC_API_KEY: "sk-should-never-ride",
      ANTHROPIC_AUTH_TOKEN: "tok-should-never-ride",
      CODEX_THREAD_ID: "codex-123",
      CODEX_HOME: "/codex",
    };
    // 플랫폼 비밀 이름은 config(플랫폼 인지 계층)에서만 조회한다 — 이 테스트에 하드코딩하지 않는다.
    for (const name of chatSecretEnvNames()) base[name] = `secret-${name}`;
    return base;
  };

  test("HARNESS_ACK_GAPS 는 base 가 '1' 이라도 '0' 으로 핀 고정된다", () => {
    // 이미지 생성 직전 '최종 점검'(임계 결손 fail-closed)을 무인 세션이 조용히 통과시키지 못하게 하는 핀이다.
    const env = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect(env.HARNESS_ACK_GAPS).toBe("0");
  });

  test("과금키·AUTH 토큰·CODEX_*·플랫폼 비밀은 실리지 않는다", () => {
    const env = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // API 과금 경로의 물리적 부재(잠긴 결정 6)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    for (const name of Object.keys(env)) expect(name.startsWith("CODEX_")).toBe(false);
    for (const name of chatSecretEnvNames()) expect(env[name]).toBeUndefined();
  });

  test("격리 CLAUDE_CONFIG_DIR 가 설정된다(사용자 훅/플러그인/MCP/apiKeyHelper 미로드)", () => {
    const env = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect(env.CLAUDE_CONFIG_DIR).toBe(FIXED_CONFIG_DIR);
  });

  test("claude.ai 커넥터는 env 로 꺼진다(ENABLE_CLAUDEAI_MCP_SERVERS=false)", () => {
    // 커넥터는 **OAuth 계정**을 타고 도구를 노출한다 → 격리 CONFIG_DIR 도 --strict-mcp-config 도 못 닫는다.
    // 실측(2.1.212 번들): vu(env) 가 참이면 `[claudeai-mcp] Disabled via env var`, vu 는 ["0","false","no","off"] 를
    //   참으로 읽는 falsy 파서다 → "false" 가 곧 '끔'. 값이 "0"/"true" 등으로 흔들리면 이 핀의 의미가 달라진다.
    const env = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect(SESSION_CLAUDEAI_MCP_VALUE).toBe("false");
    expect(env[SESSION_CLAUDEAI_MCP_ENV]).toBe("false");
  });

  test("커넥터 차단은 OAuth 토큰 유무와 무관하게 항상 실린다(표면이 토큰에 따라 달라지지 않는다)", () => {
    const withToken = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR, oauthToken: FIXED_TOKEN });
    const without = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect(withToken[SESSION_CLAUDEAI_MCP_ENV]).toBe("false");
    expect(without[SESSION_CLAUDEAI_MCP_ENV]).toBe("false");
  });

  test("base 가 커넥터를 켜두어도 무인 세션에선 꺼진다(상속 오염 차단)", () => {
    // 개발 세션이 ENABLE_CLAUDEAI_MCP_SERVERS=true 를 물려주는 경우 — 위생 화이트리스트가 1차로 떨구고
    //   inject 핀이 2차로 덮는다. 어느 층이 무너져도 다른 층이 남도록 둘 다 확인한다.
    const env = buildSessionEnv({ PATH: "/usr/bin", [SESSION_CLAUDEAI_MCP_ENV]: "true" }, { configDir: FIXED_CONFIG_DIR });
    expect(env[SESSION_CLAUDEAI_MCP_ENV]).toBe("false");
  });

  test("OAuth 토큰은 주면 실리고, 안 주면 아예 없다", () => {
    const withToken = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR, oauthToken: FIXED_TOKEN });
    expect(withToken.CLAUDE_CODE_OAUTH_TOKEN).toBe(FIXED_TOKEN);

    const without = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR });
    expect("CLAUDE_CODE_OAUTH_TOKEN" in without).toBe(false);

    // 빈 문자열 = 미설정 취급(config.readEnv 관례). 빈 값을 실으면 인증이 '설정됐는데 실패'로 흐려진다.
    const empty = buildSessionEnv(DIRTY_BASE(), { configDir: FIXED_CONFIG_DIR, oauthToken: "" });
    expect("CLAUDE_CODE_OAUTH_TOKEN" in empty).toBe(false);
  });

  test("격리 CONFIG_DIR 가 비었거나 상대경로면 거부한다(런 산출물 안에 워커 설정이 생기는 것을 막는다)", () => {
    expect(() => buildSessionEnv({}, { configDir: "" })).toThrow(/절대경로/);
    expect(() => buildSessionEnv({}, { configDir: "relative/dir" })).toThrow(/절대경로/);
  });

  test("plan 의 env 도 같은 위생을 통과한다(러너가 손으로 재조립하지 않는다)", () => {
    const { env } = planFixture({ baseEnv: DIRTY_BASE(), oauthToken: FIXED_TOKEN });
    expect(env.HARNESS_ACK_GAPS).toBe("0");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(FIXED_CONFIG_DIR);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FIXED_TOKEN);
  });
});

// ── 4. settings 결정성 + deny/disallowed 내용 ────────────────────────────────

describe("buildWorkerSettings — 경계 안쪽에서 파내는 예외(부록A-7 2번)", () => {
  const RUN_DIR = `${FIXED_CORE}/runs/${FIXED_RID}`;

  test("런의 state.json·run.md·.lock 쓰기/편집이 금지된다(상태는 run-stage.sh 만 쓴다)", () => {
    const settings = buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS });
    for (const target of ["state.json", "run.md", ".lock", ".lock/**"]) {
      expect(settings.permissions.deny).toContain(`Write(//abs/core/runs/${FIXED_RID}/${target})`);
      expect(settings.permissions.deny).toContain(`Edit(//abs/core/runs/${FIXED_RID}/${target})`);
    }
  });

  test("--add-dir 루트 4종은 쓰기 금지다(입력이지 산출물이 아니다)", () => {
    const settings = buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS });
    for (const dir of EXPECTED_ADD_DIRS) {
      // scripts 쓰기를 열어두면 세션이 run-stage.sh 를 고쳐놓고 '허용된 그 한 줄'로 실행할 수 있다(규칙 정밀도 우회).
      // packs 쓰기를 열어두면 자기 심의 기준(ruleset.json)을 고쳐 쓴다(self-grading).
      expect(settings.permissions.deny).toContain(`Write(/${dir}/**)`);
      expect(settings.permissions.deny).toContain(`Edit(/${dir}/**)`);
    }
  });

  test("런 산출물은 막지 않는다 — 경계가 일을 방해하면 그 세션은 완주할 수 없다", () => {
    const settings = buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS });
    const denied = settings.permissions.deny.join("\n");
    expect(denied).not.toContain(`Write(//abs/core/runs/${FIXED_RID}/01-brief`);
    expect(denied).not.toContain(`Write(//abs/core/runs/${FIXED_RID}/**)`);
  });

  test("읽기 허용목록도, 읽기 deny 열거도 만들지 않는다(cwd 가 경계 · allow 는 deny 를 못 이긴다)", () => {
    const settings = buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS });
    // A-4: `.env`·타 런·jobs·~/.claude 는 cwd 밖이라 규칙 없이 이미 차단된다 → 열거는 착시만 준다.
    // A-3: deny 가 allow 를 이기므로 '전부 deny + 내 것만 allow' 형태는 애초에 만들 수 없다.
    expect(settings.permissions.deny.some((r) => r.startsWith("Read("))).toBe(false);
    expect("allow" in settings.permissions).toBe(false);
    expect("ask" in settings.permissions).toBe(false); // ask 는 Bash 읽기에 적용되지 않아 수단이 아니다
  });

  test("직렬화는 결정적이다(같은 입력 → 바이트 동일 · 끝 개행)", () => {
    const a = serializeWorkerSettings(buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS }));
    const b = serializeWorkerSettings(buildWorkerSettings({ runDir: RUN_DIR, addDirs: EXPECTED_ADD_DIRS }));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(JSON.parse(a)).toEqual({ permissions: { deny: expect.any(Array) } });
  });

  test("plan 은 settings 내용·경로를 함께 준다(러너는 쓰기만 한다)", () => {
    const plan = planFixture();
    expect(plan.settingsPath).toBe(`${FIXED_CONFIG_DIR}/${WORKER_SETTINGS_FILENAME}`);
    expect(plan.settingsJson).toBe(serializeWorkerSettings(plan.settings));
  });
});

describe("buildDisallowedTools — 2차 방어(결정·상태변이 스크립트)", () => {
  test("결정 스크립트 전부가 접두 규칙으로 실린다", () => {
    expect(buildDisallowedTools(FIXED_CORE)).toEqual(EXPECTED_DISALLOWED);
  });

  test("목록의 스크립트는 core 에 실재한다 — 개명되면 규칙이 조용히 헛돈다(드리프트 알람)", () => {
    for (const name of DECISION_SCRIPTS) {
      expect(() => readFileSync(join(REAL_CORE, "scripts", name), "utf8")).not.toThrow();
    }
  });

  test("무인 대상인 run-stage.sh 는 거부 목록에 없다(있으면 세션이 아무 일도 못 한다)", () => {
    expect(buildDisallowedTools(FIXED_CORE).some((r) => r.includes("run-stage.sh"))).toBe(false);
  });

  test("a2ui-action.sh 도 거부 목록에 있다(select/approve/revise/raise-limit 우회 브리지 차단 · 간접 구멍 닫힘)", () => {
    // a2ui-action.sh 가 빠지면, 결정 스크립트를 직접 못 쓰도록 막아둔 무인 세션이 이 브리지로 우회해
    //   approve.sh 등에 닿을 수 있다(간접 구멍). 접두 규칙으로 명시 거부돼 있어야 한다.
    expect(buildDisallowedTools(FIXED_CORE)).toContain(`Bash(bash ${FIXED_CORE}/scripts/a2ui-action.sh:*)`);
    expect(DECISION_SCRIPTS).toContain("a2ui-action.sh");
    // 바이트순 결정론: "a2..." 가 "ad..."(advance-phase) 앞에 온다(맨 앞).
    expect(DECISION_SCRIPTS[0]).toBe("a2ui-action.sh");
  });
});

// ── 5. 적대 우회 표(조립 수준) ───────────────────────────────────────────────

/**
 * 조립된 allow 집합이 이 명령을 **통과시킬 여지가 있는가**.
 *   정확일치(`Bash(cmd)`)와 접두(`Bash(cmd:*)`) **두 의미론을 모두 가정**하고 본다 — 어느 쪽이 참이든
 *   '우리 규칙 중 이 명령에 걸릴 수 있는 게 하나도 없다'를 말하려면 둘 다 봐야 한다.
 */
function allowSetWouldMatch(allowRules: string[], command: string): boolean {
  return allowRules.some((rule) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const body = m[1];
    return body.endsWith(":*") ? command.startsWith(body.slice(0, -2)) : command === body;
  });
}

describe("적대 우회 표(조립 수준) — 계획 6번 절 '승인류·체이닝·타 rid·경로 밖'", () => {
  /**
   * ⚠ **이 표는 조립만 못 박는다.** 실제 CLI 규칙 매칭(인자 정밀도 · 체이닝 통째 거부 · 간접 스펠링 fail-closed)은
   *   **부록A-5 의 라이브 실측**이 답한 것이고 여기서 증명되지 않는다 — 우리가 고정하는 건 '우리 문자열'뿐이다.
   *   그러므로 **CLI 업그레이드 시 적대 카나리를 다시 돌려야 한다**(계획 7번 절 R-1·R-7 이 같은 ⚠ 를 진다).
   */
  const TRANSITION = `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`;

  const ATTACKS = [
    {
      what: "승인류 — 결정을 세션이 스스로 내린다(approve/select/revise)",
      command: `bash ${FIXED_CORE}/scripts/approve.sh ${FIXED_RID}`,
      // 1차 방어 = allow 규칙 부재(승인 필요 부류 → 헤드리스 fail-closed) · 2차 = disallow 명시.
      defense: `Bash(bash ${FIXED_CORE}/scripts/approve.sh:*)`,
    },
    {
      what: "체이닝 — 허용된 전이 뒤에 승인 명령을 잇는다",
      command: `${TRANSITION}; bash ${FIXED_CORE}/scripts/select.sh ${FIXED_RID} B`,
      // A-5 실측: 승인 필요 명령이 섞인 줄은 **전체가 거부**되고 앞부분도 실행되지 않는다.
      defense: `Bash(bash ${FIXED_CORE}/scripts/select.sh:*)`,
    },
    {
      what: "타 rid 전이 — 남의 런을 전진시킨다",
      command: `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief other-rid-9999`,
      // 방어 = allow 규칙에 rid 가 박혀 있다(A-5 인자 정밀도) + 타 런은 cwd 경계 밖이다(A-4·A-9 실측).
      defense: undefined,
    },
    {
      what: "인자 덧붙이기 — --proceed-with-gaps 로 결손 게이트를 무력화한다",
      command: `${TRANSITION} --proceed-with-gaps`,
      // 방어 = allow 규칙이 접두(`:*`)가 아니라 정확일치라 덧붙인 인자는 매칭되지 않는다.
      defense: undefined,
    },
    {
      what: "경로 밖 — cd 로 cwd 경계를 빠져나가 상대경로로 실행한다",
      command: `cd ${FIXED_CORE} && HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief ${FIXED_RID}`,
      // A-9 실측에서 무인 세션이 **실제로 시도**했고 allow 규칙 정밀도가 막은 형태다(통과했다면 경계 밖으로 나갔다).
      defense: undefined,
    },
  ];

  for (const attack of ATTACKS) {
    test(`조립된 allow 집합은 이 명령에 걸릴 여지가 없다 — ${attack.what}`, () => {
      const { allowRules } = briefRewrite();
      expect(allowSetWouldMatch(allowRules, attack.command)).toBe(false);
      if (attack.defense !== undefined) {
        expect(buildDisallowedTools(FIXED_CORE)).toContain(attack.defense);
      }
    });
  }

  test("전이 규칙은 접두(`:*`)가 아니라 정확일치다 — 인자 덧붙이기의 방어가 여기서 나온다", () => {
    const { allowRules } = briefRewrite();
    for (const rule of allowRules) expect(rule.endsWith(":*)")).toBe(false);
  });

  test("--proceed-with-gaps 의 env 쌍둥이(HARNESS_ACK_GAPS=1)도 조립에서 닫힌다", () => {
    // 같은 우회의 두 스펠링이다 — 플래그 쪽은 allow 정확일치가, env 쪽은 위생 핀이 막는다.
    const { env } = planFixture({ baseEnv: { PATH: "/usr/bin", HARNESS_ACK_GAPS: "1" } });
    expect(env.HARNESS_ACK_GAPS).toBe("0");
  });

  test("레포 소유 설정(project/local)은 경계 조립에 참여하지 않는다 — 경계는 워커 코드가 보증한다", () => {
    // 이 세션의 cwd 는 `core/runs/<rid>` = **레포 안**이라, 핀이 없으면 레포의 `.claude/settings.local.json` 이
    //   권한에 병합된다. 실재하는 그 파일에는 결정 명령(`select.sh … B-usevalue`) allow 와 cwd 밖 절대경로
    //   `Read(//Users/…/**)` allow 가 들어 있었다(둘 다 무인 세션이 가져선 안 되는 권한).
    //   ⚠ 이 테스트는 '그 규칙이 오늘 악용 가능한가'를 보지 않는다 — **레포 파일이 경계를 정할 여지 자체**를 못 박는다.
    const { argv } = planFixture();
    const at = argv.indexOf("--setting-sources");
    expect(argv[at + 1]).toBe("user");
    // 어떤 토큰도 project/local 소스를 되살리지 않는다(값 확장·플래그 중복 재지정 포함).
    expect(argv.filter((t) => t === "--setting-sources")).toHaveLength(1);
    expect(argv.slice(0, argv.indexOf("--")).some((t) => /(^|,)(project|local)(,|$)/.test(t))).toBe(false);
  });

  test("두 핀은 각각 독립으로 필요하다 — 하나만 남기는 리팩터를 깨운다", () => {
    // ⚠ 이 테스트의 옛 이름·주석은 "settings.local.json 의 빈 enabledMcpjsonServers 가 .mcp.json 을 억누르는
    //   유일한 것이라, 설정소스 핀만 넣으면 MCP 가 오히려 열린다"고 적었는데 **틀린 기록이었다**(외부리뷰 W2-R2):
    //   그 필드는 거부가 아니라 **승인 목록**이고, 프로젝트 MCP 로더는 projectSettings 미선택 시 즉시 빈 집합을 낸다.
    //   → 두 핀은 '결합'이 아니라 **각자 독립**으로 선다: 설정소스 핀 = project/local 권한 합성 차단 ·
    //     MCP 핀 = 도구 표면 0 고정(claude.ai connector 는 설정소스 통제 밖이라 이쪽만이 막는다).
    //   이 테스트가 고정하는 건 그 둘의 **동시 존재**뿐이다 — CLI 의 실제 로딩 동작을 재현하지는 않는다(그건 W5 카나리).
    const { argv } = planFixture();
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
  });

  test("타 런은 cwd(읽기 경계) 밖이다 — 어떤 allow 규칙도 남의 런을 가리키지 않는다", () => {
    const { cwd, argv } = planFixture();
    expect(cwd).toBe(`${FIXED_CORE}/runs/${FIXED_RID}`);
    const at = argv.indexOf("--add-dir");
    // add-dir 로 runs/ 를 열면 cwd 경계가 무의미해진다(A-4: cwd 선택이 곧 읽기 경계).
    expect(argv.slice(at + 1, at + 5).some((d) => d.includes("/runs"))).toBe(false);
    for (const rule of briefRewrite().allowRules) expect(rule).not.toContain("other-rid");
  });

  test("보조 도구 규칙은 실측된 것뿐이다 — intake 의 shasum 외에 조용히 늘지 않는다", () => {
    const { allowRules } = rewriteSkill({
      skillMd: realSkill("intake"),
      stage: "intake",
      rid: FIXED_RID,
      coreRoot: FIXED_CORE,
    });
    const aux = allowRules.filter((r) => !r.includes("run-stage.sh"));
    expect(aux).toEqual(["Bash(shasum:*)"]); // 부록A-11 3번: 보조 도구는 실측으로만 추가
  });
});

// ── 6. fail-closed 입력 검증 ─────────────────────────────────────────────────

describe("입력 검증 — 검증 안 된 값은 경로·규칙 문자열에 박히기 전에 끊는다", () => {
  test("도메인 형식 위반은 예외다(경로 탈출·규칙 훼손 차단)", () => {
    for (const bad of ["", "Cosmetic", "1cosmetic", "cosmetic-x", "../packs/drug", "cos metic", "cosmetic)", "*"]) {
      expect(() => buildAddDirs({ coreRoot: FIXED_CORE, domain: bad })).toThrow(/규제도메인 형식/);
    }
  });

  test("정상 도메인(4종 형식)은 통과한다 — 검사하는 건 형식이지 등록 여부가 아니다", () => {
    for (const ok of ["cosmetic", "quasi_drug", "health_food", "drug"]) {
      expect(buildAddDirs({ coreRoot: FIXED_CORE, domain: ok })[3]).toBe(`/abs/packs/${ok}`);
    }
  });

  test("coreRoot 가 상대경로·공백·메타문자를 품으면 예외다", () => {
    expect(() => buildAddDirs({ coreRoot: "relative/core", domain: FIXED_DOMAIN })).toThrow(/절대경로/);
    expect(() => buildAddDirs({ coreRoot: "/abs/co re", domain: FIXED_DOMAIN })).toThrow(/메타문자/);
    expect(() => buildRunCwd({ coreRoot: "/abs/core;rm", rid: FIXED_RID })).toThrow(/메타문자/);
  });

  test("안전하지 않은 rid 는 예외다(cwd 경로와 규칙 문자열에 그대로 박힌다)", () => {
    for (const bad of ["", "../other", "rid with space", "rid;sh", ".."]) {
      expect(() => buildRunCwd({ coreRoot: FIXED_CORE, rid: bad })).toThrow(/run_id/);
    }
  });

  test("max-turns 는 1 이상의 정수만 — clamp·반올림 없이 멈춘다(지어내지 않는다)", () => {
    const base = { prompt: "p", allowRules: ["Bash(echo hi)"], disallowRules: [], addDirs: EXPECTED_ADD_DIRS };
    for (const bad of [0, -3, 7.6, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildSessionArgs({ ...base, maxTurns: bad })).toThrow(/max-turns/);
    }
    expect(buildSessionArgs({ ...base, maxTurns: 1 })).toContain("1");
  });

  test("allow 규칙 0개는 예외다 — 세션이 산출물만 쓰고 게이트에서 정체하는 상태(부록A-9 1차 실패)를 조립에서 끊는다", () => {
    expect(() =>
      buildSessionArgs({ prompt: "p", allowRules: [], disallowRules: [], maxTurns: 5, addDirs: EXPECTED_ADD_DIRS }),
    ).toThrow(/allowRules 가 비어/);
  });

  test("add-dir 0개·빈 프롬프트도 예외다", () => {
    expect(() =>
      buildSessionArgs({ prompt: "p", allowRules: ["Bash(echo hi)"], disallowRules: [], maxTurns: 5, addDirs: [] }),
    ).toThrow(/addDirs 가 비어/);
    expect(() =>
      buildSessionArgs({ prompt: "  ", allowRules: ["Bash(echo hi)"], disallowRules: [], maxTurns: 5, addDirs: EXPECTED_ADD_DIRS }),
    ).toThrow(/프롬프트가 비어/);
  });
});
