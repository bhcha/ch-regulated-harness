/**
 * spawn-hygiene.ts — 무인 `claude -p` spawn 용 위생 env 조립(순수 유틸).
 *
 * 계획 4절 '무인 spawn 위생 한 곳' + 5-1(env)의 단일 구현이다. 헤드리스 세션(NL 파서·무인 데몬)이
 *   개발 세션의 자식으로 뜰 때 마커·과금 키·플랫폼 비밀을 상속하는 오염(R-8)을 차단한다.
 *
 * 왜 kernel/ 이 아니라 chat/src/ 루트인가: 이 유틸은 비밀 env '이름'(ANTHROPIC_*·CODEX_* 등)을
 *   직접 참조해야 하는데, 커널-중립 가드가 kernel/ 안에서 그 이름 참조를 금한다. 그래서 config.ts 처럼
 *   플랫폼 인지 계층(chat/src/ 루트)에 둔다.
 *
 * 설계 원칙:
 *   · 순수·결정적 — process.env 를 직접 읽지 않고 base 를 인자로 받는다. 같은 입력 → 같은 출력.
 *   · 화이트리스트 재구성이 1차 방어(base 통째 복사 아님, 최소 env 만). 스크럽 목록은 방어심층 2차.
 *   · HARNESS_ACK_GAPS 는 스크럽이 아니라 "0" 핀 고정 — core .env 로더가 set-if-unset 이라
 *     생략/스크럽만으론 .env 값으로 되채워진다(계획 4절·R-12).
 */
import { chatSecretEnvNames } from "./config.js";

/** 화이트리스트: base 에서 이 이름들만(존재하는 것만) 통과시킨다. 나머지는 전부 버린다. */
export const SPAWN_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
] as const;

/** 스크럽(정확일치): 과금/인증/클라우드모드/마커 env — base 에 있어도 절대 싣지 않는다. */
export const SPAWN_ENV_SCRUB_EXACT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
] as const;

/** 스크럽(접두어): 이 접두어로 시작하는 이름은 전부 제거(Codex 마커·Bedrock/Vertex 자격증명 계열). */
export const SPAWN_ENV_SCRUB_PREFIXES = ["CODEX_", "ANTHROPIC_BEDROCK_", "ANTHROPIC_VERTEX_"] as const;

/**
 * 이름이 스크럽 대상인가 — 정확일치 목록 + 접두어 목록 + Slack/플랫폼 비밀(chatSecretEnvNames).
 * Slack 비밀 이름은 config(플랫폼 인지 계층)에서만 조회해 이 파일에 하드코딩하지 않는다.
 */
function isScrubbed(name: string): boolean {
  if ((SPAWN_ENV_SCRUB_EXACT as readonly string[]).includes(name)) return true;
  if (chatSecretEnvNames().includes(name)) return true;
  return SPAWN_ENV_SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 무인 spawn 에 넘길 위생 env 를 조립한다(순수).
 *
 * @param base   상속 후보 env(보통 process.env). 통째로 복사하지 않고 화이트리스트로만 재구성한다.
 * @param opts.configDir  주면 CLAUDE_CONFIG_DIR 로 고정 — 사용자 훅/플러그인/MCP/apiKeyHelper 미로드 격리.
 *   미지정이면 설정하지 않는다(호출부는 보통 전용 격리 디렉터리를 넘겨야 한다 — 계획 5-1 도구0 경계).
 * @param opts.inject     화이트리스트 재구성 뒤 되싣는 명시 env. 단 (a) 스크럽 대상 이름은 거부(무시),
 *   (b) HARNESS_ACK_GAPS 는 아래 "0" 핀이 항상 이긴다.
 */
export function hygienicSpawnEnv(
  base: NodeJS.ProcessEnv,
  opts?: { configDir?: string; inject?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1) 화이트리스트 재구성 — base 에서 허용 이름만(존재+비스크럽). 나머지는 전부 드롭.
  for (const name of SPAWN_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined && !isScrubbed(name)) out[name] = value;
  }

  // 5) inject — 명시 env 되싣기. 스크럽 대상 이름은 거부(방어심층 2차).
  if (opts?.inject) {
    for (const [name, value] of Object.entries(opts.inject)) {
      if (isScrubbed(name)) continue;
      out[name] = value;
    }
  }

  // 4) 전용 CLAUDE_CONFIG_DIR — 주어졌을 때만 설정(사용자 설정 격리).
  if (opts?.configDir !== undefined) out.CLAUDE_CONFIG_DIR = opts.configDir;

  // 3) HARNESS_ACK_GAPS "0" 핀 고정 — inject·base 무관하게 항상 마지막에 덮어 이긴다.
  out.HARNESS_ACK_GAPS = "0";

  return out;
}
