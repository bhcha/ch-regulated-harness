/**
 * spawn-hygiene.test.ts — 무인 spawn 위생 env 조립(hygienicSpawnEnv) 단위 검증.
 *
 * 검증 축(계획 4절·5-1):
 *   1) 화이트리스트: PATH/HOME/LANG 등 최소 env 만 통과, 그 외 base 값은 드롭.
 *   2) 스크럽: 과금/인증/클라우드모드/마커/접두어/Slack 비밀은 출력에 절대 없음.
 *   3) HARNESS_ACK_GAPS 는 base 가 "1" 이라도 "0" 으로 핀 고정.
 *   4) CLAUDE_CONFIG_DIR 는 opts.configDir 로만 설정.
 *   5) inject: 무해 env 는 되싣되, 스크럽 이름은 거부 + ACK_GAPS 핀은 여전히 이긴다.
 *   6) 결정성: 같은 입력 두 번 → deep-equal.
 */
import { describe, expect, test } from "vitest";
import { chatSecretEnvNames } from "../src/config.js";
import {
  SPAWN_ENV_ALLOWLIST,
  SPAWN_ENV_SCRUB_EXACT,
  SPAWN_ENV_SCRUB_PREFIXES,
  hygienicSpawnEnv,
} from "../src/spawn-hygiene.js";

describe("hygienicSpawnEnv — 화이트리스트 재구성", () => {
  test("화이트리스트 env(PATH/HOME/LANG)는 base 에 있으면 통과한다", () => {
    const out = hygienicSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "en_US.UTF-8",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.LANG).toBe("en_US.UTF-8");
  });

  test("화이트리스트에 없는 base env 는 드롭된다", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin", SOME_RANDOM_VAR: "keep-me-not" });
    expect(out.SOME_RANDOM_VAR).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  test("base 에 없는 화이트리스트 env 는 출력에 없다(빈 값 조작 없음)", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" });
    for (const name of SPAWN_ENV_ALLOWLIST) {
      if (name !== "PATH") expect(name in out).toBe(false);
    }
  });
});

describe("hygienicSpawnEnv — 스크럽(방어심층)", () => {
  const scrubbedBase: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok-secret",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CODEX_THREAD_ID: "codex-123",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
    ANTHROPIC_VERTEX_PROJECT_ID: "proj-1",
  };

  test.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID", // 접두어 CODEX_
    "ANTHROPIC_BEDROCK_BASE_URL", // 접두어 ANTHROPIC_BEDROCK_
    "ANTHROPIC_VERTEX_PROJECT_ID", // 접두어 ANTHROPIC_VERTEX_
  ])("%s 는 출력에서 제거된다", (name) => {
    const out = hygienicSpawnEnv(scrubbedBase);
    expect(name in out).toBe(false);
  });

  test("Slack/플랫폼 비밀(chatSecretEnvNames)은 출력에서 제거된다", () => {
    const secretNames = chatSecretEnvNames();
    expect(secretNames.length).toBeGreaterThan(0);
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const n of secretNames) base[n] = "platform-secret";
    const out = hygienicSpawnEnv(base);
    for (const n of secretNames) expect(n in out).toBe(false);
  });

  test("스크럽 상수(exact/prefix)가 명세대로 노출된다", () => {
    expect([...SPAWN_ENV_SCRUB_EXACT]).toContain("ANTHROPIC_API_KEY");
    expect([...SPAWN_ENV_SCRUB_EXACT]).toContain("CLAUDECODE");
    expect([...SPAWN_ENV_SCRUB_PREFIXES]).toContain("CODEX_");
  });
});

describe("hygienicSpawnEnv — HARNESS_ACK_GAPS 핀 고정", () => {
  test('base 에 "1" 이 있어도 "0" 으로 고정된다', () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin", HARNESS_ACK_GAPS: "1" });
    expect(out.HARNESS_ACK_GAPS).toBe("0");
  });

  test("base 에 없어도 항상 \"0\" 으로 설정된다", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" });
    expect(out.HARNESS_ACK_GAPS).toBe("0");
  });
});

describe("hygienicSpawnEnv — CLAUDE_CONFIG_DIR", () => {
  test("opts.configDir 를 주면 CLAUDE_CONFIG_DIR 로 설정된다", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" }, { configDir: "/iso/config" });
    expect(out.CLAUDE_CONFIG_DIR).toBe("/iso/config");
  });

  test("opts.configDir 미지정이면 CLAUDE_CONFIG_DIR 는 설정되지 않는다", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" });
    expect("CLAUDE_CONFIG_DIR" in out).toBe(false);
  });
});

describe("hygienicSpawnEnv — inject", () => {
  test("무해한 inject env 는 되싣는다", () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" }, { inject: { HARNESS_ROOT: "/core" } });
    expect(out.HARNESS_ROOT).toBe("/core");
  });

  test("inject 에 스크럽 이름이 있으면 거부된다(주입 안 됨)", () => {
    const secretName = chatSecretEnvNames()[0];
    const out = hygienicSpawnEnv(
      { PATH: "/usr/bin" },
      { inject: { ANTHROPIC_API_KEY: "sk-x", CODEX_THREAD_ID: "c1", [secretName]: "s1" } },
    );
    expect("ANTHROPIC_API_KEY" in out).toBe(false);
    expect("CODEX_THREAD_ID" in out).toBe(false);
    expect(secretName in out).toBe(false);
  });

  test('inject 가 HARNESS_ACK_GAPS="1" 을 넣어도 "0" 핀이 이긴다', () => {
    const out = hygienicSpawnEnv({ PATH: "/usr/bin" }, { inject: { HARNESS_ACK_GAPS: "1" } });
    expect(out.HARNESS_ACK_GAPS).toBe("0");
  });
});

describe("hygienicSpawnEnv — 결정성", () => {
  test("같은 입력 두 번 → deep-equal", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-secret",
      HARNESS_ACK_GAPS: "1",
    };
    const opts = { configDir: "/iso/config", inject: { HARNESS_ROOT: "/core" } };
    const a = hygienicSpawnEnv(base, opts);
    const b = hygienicSpawnEnv(base, opts);
    expect(a).toEqual(b);
  });
});
