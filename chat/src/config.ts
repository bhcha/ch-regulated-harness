/**
 * config.ts — 챗 레이어 환경설정 단일 출처(SSoT).
 *
 * 규칙: 다른 모듈은 process.env 를 직접 읽지 않는다 — 여기 함수/상수만 쓴다.
 *   · core(하네스) 절대경로와, core scripts spawn 시 넘길 env(HARNESS_*) 를 한 곳에서 조립한다.
 *   · Slack 토큰은 'env 이름'만 상수로 선언하고(SLACK_ENV), 값 읽기는 함수(slackTokens)로 캡슐화한다.
 *   · 저장 루트(.state/·data/·jobs/)는 chat 패키지 디렉터리 기준 절대경로로 되돌린다.
 *
 * core 무수정 불변식: 게이트웨이는 state.json 을 직접 쓰지 않고 core scripts 를 spawn 한다.
 *   harnessRoot()/harnessEnv() 가 그 spawn 의 실행 위치·env 를 제공한다.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 이 chat 패키지 루트(= chat/). 저장 루트의 기준. 파일 위치 chat/src/config.ts → 두 단계 상위. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Slack 토큰 env '이름'만 선언(값 아님). 단일 워크스페이스 Socket Mode 기준. */
export const SLACK_ENV = {
  botToken: "SLACK_BOT_TOKEN",
  appToken: "SLACK_APP_TOKEN",
  signingSecret: "SLACK_SIGNING_SECRET",
} as const;

/** 빈 문자열은 미설정으로 취급(값이 있을 때만 반환). */
function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
}

/**
 * core(하네스) 절대경로 — env HARNESS_ROOT 로 **주입 필수**. 항상 절대경로로 정규화.
 *
 * 헥사고날 관점: 이 챗은 '구동 어댑터'이고 하네스(core)는 그 포트다. 포트 주소(=core 체크아웃 경로)는
 *   어댑터가 스스로 추측(형제 경로 유도)하지 않고 **주입받는다** — 리포지토리 분리(chat·core 별도 레포) 대비.
 *   미주입(미설정/빈값)이면 조용히 엉뚱한 core 를 붙드는 대신 **즉시 실패**한다(fail-fast): 명확한 안내로 멈추는 편이,
 *   잘못된 하네스를 말없이 spawn 하는 것보다 안전하다.
 * @throws HARNESS_ROOT 미설정/빈값이면 Error(한국어 주입 안내).
 */
export function harnessRoot(): string {
  const root = readEnv("HARNESS_ROOT");
  if (root === undefined) {
    throw new Error(
      "HARNESS_ROOT 환경변수가 필요합니다 — 이 챗 어댑터는 하네스(core) 체크아웃 경로를 주입받아야 합니다. 예: HARNESS_ROOT=/path/to/core",
    );
  }
  return isAbsolute(root) ? root : resolve(root);
}

/** 오프라인(stub) 여부 — HARNESS_OFFLINE=1 일 때만 true. */
export function isOffline(): boolean {
  return readEnv("HARNESS_OFFLINE") === "1";
}

/**
 * 데모(촬영) 모드 — **stub 생성/심의/이미지를 실 Slack tee 와 함께** 쓴다(HARNESS_OFFLINE=1 을 반드시 동반).
 *   라이브 진입점은 평소 offline 을 거부하지만(stub 누수 방지), 이 플래그가 있을 때만 그 거부를 해제해
 *   "결정적 stub 생성 + 실 Slack 렌더"를 허용한다 — 데몬·ADK·과금 없이 챗 표면 흐름을 촬영하기 위함.
 *   ⚠ **촬영용 UX 데모 전용이지 컴플라이언스 런이 아니다**: 카피는 정형 stub, 심의는 offline autopass(실 규정
 *   점검 아님). 플래그가 없으면(프로덕션·CI) 라이브 경로는 기존대로 offline 을 거부한다(동작 불변).
 */
export function stubSlackDemo(): boolean {
  return readEnv("CHAT_STUB_SLACK") === "1";
}

/**
 * 데모 키비주얼 미리보기 이미지 소스 디렉터리(CHAT_DEMO_KV_IMAGES · 절대경로 · 04-keyvisual 레이아웃).
 *   설정 시 keyvisual-reader 가 현재 run 산출물 대신 이 디렉터리의 `options/<key>/shots/full.png` 실 PNG 를
 *   옵션 미리보기로 올린다 — stub 키비주얼은 svg 라 미리보기가 없어, **최근 실 런의 이미지를 촬영용으로 대체**한다.
 *   미설정/빈 값이면 기존 동작(run 산출물). 데모 전용(프로덕션 미설정).
 */
export function demoKeyvisualDir(): string | undefined {
  const v = readEnv("CHAT_DEMO_KV_IMAGES");
  return v === undefined || v === "" ? undefined : v;
}

/** core scripts spawn 시 넘길 env. 설정된 값만 실어 하네스 기본값을 덮지 않는다. */
export interface HarnessEnv {
  HARNESS_ROOT: string;
  HARNESS_OFFLINE?: string;
  HARNESS_EXAMPLES_DIR?: string;
  HARNESS_WB?: string;
}
export function harnessEnv(): HarnessEnv {
  const out: HarnessEnv = { HARNESS_ROOT: harnessRoot() };
  const offline = readEnv("HARNESS_OFFLINE");
  const examples = readEnv("HARNESS_EXAMPLES_DIR");
  const wb = readEnv("HARNESS_WB");
  if (offline !== undefined) out.HARNESS_OFFLINE = offline;
  if (examples !== undefined) out.HARNESS_EXAMPLES_DIR = examples;
  if (wb !== undefined) out.HARNESS_WB = wb;
  return out;
}

/**
 * 승인자 allowlist. env CHAT_APPROVERS 콤마분리. 미설정=빈 배열.
 * 감사 actor 는 `chat:slack:<user>` 형식이지만, allowlist 항목은 형식에 관대하게 매칭한다
 * (아래 actorUserId 로 끝 user id 만 비교) → `U123`·`slack:U123`·`chat:slack:U123` 모두 허용.
 */
export function approvers(): string[] {
  const raw = readEnv("CHAT_APPROVERS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** actor 문자열에서 끝 user id 만 뽑는다(형식 정규화). `chat:slack:U123`→`U123`, `slack:U123`→`U123`, `U123`→`U123`. */
export function actorUserId(actor: string): string {
  const parts = actor.split(":");
  return parts[parts.length - 1] || actor;
}

/**
 * actor 가 allowlist 안에 있는지. **끝 user id 로 정규화 비교**(actor 형식 `chat:slack:` 접두어와 무관).
 * 빈 allowlist 면 항상 false(fail-closed 기본).
 */
export function isApprover(actor: string): boolean {
  const uid = actorUserId(actor);
  return approvers().some((a) => actorUserId(a) === uid);
}

/**
 * core(및 하위 생성 서브프로세스)로 전파하면 안 되는 챗 레이어 비밀 env '이름' 목록(최소권한 스크럽).
 * 커널(harness-cli)이 core spawn 전 이 이름들을 빈 문자열로 덮어 비밀 노출면을 줄인다 — 어느 플랫폼의
 * 비밀인지는 config(플랫폼 인지 계층)만 알고, 커널은 '스크럽 대상 목록'만 받는다(커널 플랫폼 무지 보존).
 */
export function chatSecretEnvNames(): string[] {
  return [SLACK_ENV.botToken, SLACK_ENV.appToken, SLACK_ENV.signingSecret];
}

/** Slack 토큰 '값'(설정된 것만). 값 읽기는 여기서만. */
export interface SlackTokens {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
}
export function slackTokens(): SlackTokens {
  const out: SlackTokens = {};
  const bot = readEnv(SLACK_ENV.botToken);
  const app = readEnv(SLACK_ENV.appToken);
  const sign = readEnv(SLACK_ENV.signingSecret);
  if (bot !== undefined) out.botToken = bot;
  if (app !== undefined) out.appToken = app;
  if (sign !== undefined) out.signingSecret = sign;
  return out;
}

/**
 * 챗 레이어 로컬 저장 루트(절대경로). .gitignore 대상: .state/·data/·jobs/{pending,claimed,failed}/.
 *   · state:       커스텀 파일 StateAdapter 백엔드 + run_id↔thread 매핑
 *   · data:        수신 첨부/산출물 스냅샷 등
 *   · jobs:        잡큐 루트(run별 FIFO)
 *   · jobsPending: 대기 중 생성 잡(소비자가 집기 전)
 *   · jobsClaimed: 소비자가 집은 잡(`claimed/<소비자>/` — 클레임-by-rename 의 목적지)
 *   · jobsFailed:  실패·만료 격리 잡(+ `.reason` 사유 파일)
 * 잡 큐 3면의 규약 = kernel/job-protocol.ts(프로토콜 v2) · 사람용 문서 = jobs/README.md.
 * env 오버라이드: CHAT_STATE_DIR · CHAT_DATA_DIR · CHAT_JOBS_DIR.
 */
export interface StoragePaths {
  state: string;
  data: string;
  jobs: string;
  jobsPending: string;
  jobsClaimed: string;
  jobsFailed: string;
}
export function storagePaths(): StoragePaths {
  const state = readEnv("CHAT_STATE_DIR") ?? join(PACKAGE_ROOT, ".state");
  const data = readEnv("CHAT_DATA_DIR") ?? join(PACKAGE_ROOT, "data");
  const jobs = readEnv("CHAT_JOBS_DIR") ?? join(PACKAGE_ROOT, "jobs");
  return {
    state: resolve(state),
    data: resolve(data),
    jobs: resolve(jobs),
    jobsPending: resolve(join(jobs, "pending")),
    jobsClaimed: resolve(join(jobs, "claimed")),
    jobsFailed: resolve(join(jobs, "failed")),
  };
}

/**
 * 인입 번들 폴더(운영자 사전준비 절대경로). env CHAT_BUNDLE_DIR. 미설정=undefined.
 * 계획 8장: 크롤 번들(product.json+reviews.csv+images)은 현업 업로드가 아니라 운영자가 미리 스테이징한 경로다.
 *   챗 업로드는 워킹백워드(.md)뿐이고, ingest 는 이 번들 경로 + 업로드 WB 를 함께 쓴다.
 */
export function bundleDir(): string | undefined {
  return readEnv("CHAT_BUNDLE_DIR");
}

/**
 * 운영자 스테이징 워킹백워드 .md 절대경로(선택). env CHAT_STAGED_WB.
 * [붙여넣기 없이 진행]은 이 값이 있을 때만 동작한다 — 없으면 core 가 레포 샘플 WB 로 폴백해
 * 무관한 샘플 주장(claim)이 실런에 오인입되므로 챗 레이어가 진행 자체를 막는다(fail-closed).
 */
export function stagedWbPath(): string | undefined {
  return readEnv("CHAT_STAGED_WB");
}

/**
 * 자연어 이해(P3) 설정 — '이해는 자연어, 방아쇠는 버튼'(chat-hexagonal-gateway-plan P3).
 *   · anthropicApiKey(): 실 LLM 파서(LlmNlParser)의 인증 키. 미설정이면 결정적 stub 파서로 폴백(오프라인/CI 결정성).
 *     ⚠ 이 경로는 네트워크가 필요해 **오프라인 테스트 대상이 아니다** — 파서 선택(selectNlParser)이 오프라인/무키면 stub 을 쓴다.
 *   · nlModel(): 구조화 추출에 쓸 모델(기본 claude-sonnet-5). 오버라이드 CHAT_NL_MODEL.
 *   · nlFileRoots(): NL 파일 인입(P3-2)의 allowlist 루트(콜론 분리 **절대경로**). 미설정=빈 배열 → 파일 인입 불가(fail-closed).
 *     절대경로만 받는다(상대경로는 무시) — realpath 봉쇄(intake-files)가 이 루트 하위만 통과시킨다(임의 경로 인입 차단, R-4).
 */
export function anthropicApiKey(): string | undefined {
  return readEnv("ANTHROPIC_API_KEY");
}
export function nlModel(): string {
  return readEnv("CHAT_NL_MODEL") ?? "claude-sonnet-5";
}
export function nlFileRoots(): string[] {
  const raw = readEnv("CHAT_NL_FILE_ROOTS");
  if (!raw) return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isAbsolute(s));
}

/**
 * NL 파서 선택 스위치(chat-dual-surface-plan 5-1 · env 규약표) — env CHAT_NL_PARSER(기본 "auto").
 *   허용: auto|stub|cli|api. 그 외 **비-빈** 값은 오설정이므로 즉시 예외(fail-fast) — 운영 중 "왜 stub 이지?"
 *   미스터리를 기동 시점에서 끊는다(계획 4절 '명시 스위치 + fail-fast'). 빈/미설정은 기본 auto.
 * @throws 알 수 없는 값이면 Error(한국어 안내).
 */
export function nlParser(): "auto" | "stub" | "cli" | "api" {
  const raw = readEnv("CHAT_NL_PARSER");
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "stub" || raw === "cli" || raw === "api") return raw;
  throw new Error(
    `CHAT_NL_PARSER 값이 올바르지 않습니다: "${raw}" — auto|stub|cli|api 중 하나여야 합니다.`,
  );
}

/**
 * '초 단위 env' → 밀리초 상한(공용 규약 — nlCliTimeout·bridgeTimeout·sdkGenTimeout 셋이 공유).
 *
 * **미설정은 기본값, 명시했는데 못 읽는 값은 즉시 예외**(계획 4절 '명시 스위치 + fail-fast'):
 *   · 미설정/빈값 → 기본값. 아무 것도 안 정한 운영자에게 안전한 기본을 주는 건 오설정이 아니다.
 *   · 명시했는데 숫자로 못 읽거나 0 이하(`30m`·`abc`·공백뿐·`-5`) → **예외**. 예전엔 조용히 기본값으로 폴백했지만,
 *     그건 오타 하나가 **더 큰 예산**(예 `CHAT_SDK_GEN_TIMEOUT=30m` → 480초)을 말없이 승인해주는 짓이었다.
 *     이 값들은 과금·무인 실행의 상한이라 '의도한 30분'과 '오타로 얻은 8분'을 운영자가 구별할 수 없으면 안 된다.
 *     기동 시점에 끊는 편이, 잘못 읽은 상한으로 몇 분씩 태우는 것보다 안전하다.
 *   · 유효한 양수인데 서브초 → **하한 1000ms 로 clamp**(예외 아님). 0.5초는 '읽을 수 없는 값'이 아니라
 *     '너무 빡빡한 진짜 duration' 이라 시스템 바닥(1초)을 씌운다 — 서브초(0.0001초→0ms)로 반올림되면 상한이
 *     사실상 0/즉시가 돼 '언제나 kill 할 수 있어야 한다'·'적재된 잡을 누군가는 집을 수 있어야 한다'는 전제가 깨진다.
 *     clamp 는 위로 올려도 최대 1초라, 위 '오타가 큰 예산을 부른다' 실패 양상과는 자릿수가 다르다.
 * @throws 명시했는데 초 단위 양수로 못 읽으면 Error(한국어 안내). 환산 결과가 Date 로 표현 못 할 만큼 커도 Error.
 */
/**
 * timeout 계열 env 의 **환산 후** 상한(ms) = 2^31−1(≈24.8일 · Node 타이머 한계). 업무 정책이 아니라 **표현 가능성 가드**다:
 *   ① 이 값들은 전부 `expires_at`(ISO 문자열) 로 잡 파일에 실리므로 Date 로 못 그리는 상한은 상한이 아니다.
 *   ② 이 값들은 `setTimeout`(realSleep·백오프·대기)에도 실리는데, Node 는 2^31−1ms 초과 지연을 **1ms 로 조용히
 *      clamp** 한다 — 몇 주짜리 백오프가 즉시 재시도(과금 동반 가능)로 붕괴하므로 타이머로 못 그리는 상한도 상한이 아니다.
 *   ③ 2^31−1(≈24.8일)은 챗 잡의 대기 상한(기본 900초)보다 자릿수로 한참 위라 정당한 설정을 막지 않으면서,
 *      Date 표현 한계(±8.64e15ms)에서도 멀어 `지금 + 상한` 이 안전하다. 덤으로 단위 착오(초 자리에 밀리초)를 잡는다.
 * clamp 가 아니라 **throw** 다 — 운영자가 쓰지 않은 값을 지어내지 않는다(이 파일의 다른 게터와 같은 규칙).
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function timeoutEnvMs(name: string, defaultMs: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return defaultMs;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(
      `${name} 값이 올바르지 않습니다: "${raw}" — 초 단위 양수여야 합니다(예: ${Math.round(defaultMs / 1000)}). ` +
        `단위 접미사(30m·30s)나 빈칸은 쓸 수 없습니다.`,
    );
  }
  const ms = Math.max(1000, Math.round(sec * 1000));
  // ⚠ 입력이 유한해도 **환산 결과**는 아닐 수 있다: `1e308` 은 유한 양수라 위 검사를 통과하지만 ×1000 은 Infinity 다.
  //   그러면 기동은 성공하고 **첫 잡 적재**에서 터진다 — `computeExpiresAt` 의 `new Date(now + Infinity).toISOString()`
  //   이 RangeError. 그건 이 함수가 방금 약속한 '명시 오설정은 기동 시 끊는다'의 정반대다(운영자는 봇이 뜬 걸 보고
  //   설정이 맞다고 믿는다). 그래서 **환산 후**를 한 번 더 본다: 마감은 ISO 문자열로 잡 파일에 실려 소비자가 읽는
  //   값이라, Date 로 표현 못 하는 상한은 상한이 아니다.
  if (!Number.isSafeInteger(ms) || ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} 값이 너무 큽니다: "${raw}" — 초 단위로 ${Math.round(MAX_TIMEOUT_MS / 1000)} 이하여야 합니다. ` +
        `밀리초를 초 자리에 쓰지 않았는지 확인해 주세요.`,
    );
  }
  return ms;
}

/**
 * 초 문자열 1개 → 밀리초(콤마목록 env 의 **원소 변환용**). timeoutEnvMs 의 원소 규칙과 같다:
 *   · 숫자로 못 읽거나 0 이하(빈 원소 `""` 포함 — `Number("")===0`) → **예외**. 그래서 `"60,,300"` 의 빈 원소가
 *     조용히 드롭되지 않고 여기서 끊긴다(콤마목록은 원소 하나가 비면 운영자의 의도를 알 수 없다).
 *   · 유효한 양수인데 서브초 → 하한 1000ms 로 clamp(0ms 백오프면 대기가 사실상 사라진다).
 *   · 환산 후 상한(MAX_TIMEOUT_MS) 초과 → 예외(단위 착오 가드).
 * @throws 초 단위 양수로 못 읽으면 Error(한국어 안내). 환산 결과가 상한을 넘어도 Error.
 */
function secStrToMs(name: string, raw: string): number {
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(
      `${name} 값이 올바르지 않습니다: "${raw}" — 초 단위 양수 콤마목록이어야 합니다(예: 60,300). ` +
        `빈 원소("60,,300")·단위 접미사(30m)·공백은 쓸 수 없습니다.`,
    );
  }
  const ms = Math.max(1000, Math.round(sec * 1000));
  if (!Number.isSafeInteger(ms) || ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} 값이 너무 큽니다: "${raw}" — 각 원소는 초 단위로 ${Math.round(MAX_TIMEOUT_MS / 1000)} 이하여야 합니다. ` +
        `밀리초를 초 자리에 쓰지 않았는지 확인해 주세요.`,
    );
  }
  return ms;
}

/**
 * CliNlParser 1콜 wall-clock 상한 — env CHAT_NL_CLI_TIMEOUT(**초 단위**), 반환은 **밀리초**. 기본 120000ms(=120초).
 *   미설정=기본값 · 명시했는데 못 읽는 값=예외 · 서브초=하한 1000ms clamp 는 timeoutEnvMs 규약
 *   (멈춘 CLI 를 언제나 죽일 수 있도록 최소 1초 보장).
 * @throws 명시했는데 초 단위 양수가 아니면 Error.
 */
export function nlCliTimeout(): number {
  return timeoutEnvMs("CHAT_NL_CLI_TIMEOUT", 120_000);
}

/**
 * 봇(브리지) 생성 대기 상한 — env CHAT_BRIDGE_TIMEOUT(**초 단위**), 반환은 **밀리초**. 기본 900000ms(=900초).
 *   구 하드코딩 600000ms 를 env 로 승격한 값이다(chat-dual-surface-plan 6절 env 규약).
 *
 * ⚠ 이 값은 봇의 폴링 상한이자 **잡 `expires_at` 의 원천**이다(적재시각 + 이 값 = 절대 마감). 봇·소비자가 같은
 *   마감을 보게 하려면 마감의 출처가 하나여야 한다(이중 시계 금지) — 그래서 두 쓰임이 같은 함수를 읽는다.
 *   미설정=기본값 · 명시했는데 못 읽는 값=예외 · 서브초=하한 1000ms clamp 는 timeoutEnvMs 규약
 *   (서브초 마감이면 적재되자마자 만료돼 아무도 못 집는다). 오타 하나가 조용히 900초 마감을 만들면
 *   봇·소비자가 **운영자가 정한 적 없는 마감**을 같은 얼굴로 공유하게 되므로 여기서도 fail-fast 다.
 * @throws 명시했는데 초 단위 양수가 아니면 Error(봇 기동 경로에서 즉시 드러난다).
 */
export function bridgeTimeout(): number {
  return timeoutEnvMs("CHAT_BRIDGE_TIMEOUT", 900_000);
}

/**
 * 자동 리뷰 재적재 최대 횟수(0=끄기, 기본 2 → 총 3회 시도) — env CHAT_REVIEW_RETRY.
 *   잡-레벨 리뷰 재적재(chat-review-retry-plan 2장)의 예산 상한이다: 리뷰 잡이 일시 실패하면 attempt<이 값일 때만
 *   백오프 후 다시 적재하고, 소진 후엔 반드시 fail-closed(멈춤 — 조용한 강등 금지).
 *
 * **미설정=기본 2 · 명시했는데 0 이상의 정수가 아니면 예외**(clamp·반올림 없음). sdkMaxTurns 와 같은 규칙이되
 *   **하한만 0 으로 낮춘다**: `0`(자동 재시도 끔)은 오타가 아니라 유효한 선택이다 — 기존 시나리오를 재시도 0 회로
 *   그대로 재현할 수 있어야 하기 때문(계획 리스크 7). 반면 음수·소수(`-1`·`2.5`)·문자열 위장(`2O`)은 여전히
 *   운영자가 쓰지 않은 값이라 지어내지 않고 던진다.
 * @throws 명시했는데 0 이상의 정수가 아니면 Error(한국어 안내).
 */
export function reviewRetryMax(): number {
  const raw = readEnv("CHAT_REVIEW_RETRY");
  if (raw === undefined) return 2;
  // 공백뿐인 값 가드 — Number("   ")===0 이라 트림 없이 넘기면 '명시적 0(끄기)' 으로 조용히 수용돼 복구 동작이
  //   말없이 꺼진다. 0 이 유효한 이 게터에선 timeoutEnvMs 의 `<=0` 거부가 못 잡으므로 여기서 직접 끊는다(fail-fast).
  if (raw.trim() === "") {
    throw new Error(
      `CHAT_REVIEW_RETRY 값이 올바르지 않습니다: "${raw}" — 0 이상의 정수여야 합니다(0=자동 재시도 끔, 기본 2 → 총 3회 시도).`,
    );
  }
  const n = Number(raw);
  // isSafeInteger — sdkMaxTurns 와 같은 이유(정밀도 깎인 큰 값을 지어내지 않는다). 다른 점은 하한이 0 인 것뿐.
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `CHAT_REVIEW_RETRY 값이 올바르지 않습니다: "${raw}" — 0 이상의 정수여야 합니다(0=자동 재시도 끔, 기본 2 → 총 3회 시도).`,
    );
  }
  return n;
}

/**
 * 리뷰 재적재 전 대기(백오프) — env CHAT_REVIEW_RETRY_BACKOFF(**초 단위 콤마목록**), 반환은 **밀리초 배열**.
 *   기본 [60000, 300000](= "60,300"). 1층 인트라-크리틱 백오프의 초 단위와 달리 **분 단위**로 degraded 구간을
 *   넘겨본다(chat-review-retry-plan 2-2). 원소 규칙은 timeoutEnvMs 와 같다(secStrToMs):
 *   못 읽음/0 이하/빈 원소=예외 · 서브초=하한 1000ms clamp · 상한 MAX_TIMEOUT_MS 캡.
 *
 *   · 미설정/빈 문자열 → 기본값(운영자가 안 정한 건 오설정이 아니다). 단 빈 원소("60,,300")는 조용히 드롭하지 않고 예외.
 *   · ⚠ attempt 인덱스가 리스트 길이를 넘으면 **마지막 원소를 반복**한다 — 그 반복은 **호출부**가 min(attempt, len-1)로
 *     처리하고, 이 게터는 파싱된 배열만 돌려준다(반복 로직 미포함).
 * @throws 명시했는데 초 단위 양수 콤마목록이 아니면 Error(한국어 안내).
 */
export function reviewRetryBackoffMs(): number[] {
  const raw = readEnv("CHAT_REVIEW_RETRY_BACKOFF");
  if (raw === undefined) return [60_000, 300_000];
  return raw.split(",").map((el) => secStrToMs("CHAT_REVIEW_RETRY_BACKOFF", el));
}

/**
 * cli 파서 과금 활성화 게이트 ack 여부(계획 5-1·잠긴 결정 6) — env CHAT_NL_CLI_VERIFIED === "1" 일 때만 true.
 *   운영자가 첫 실콜의 과금 귀속(구독/크레딧/API 중 어디에 잡히는지)을 실측 확인했다는 명시 ack 다.
 *   이 확인 전에는 selectNlParser 의 auto 경로에서 cli 를 제외한다(명시 CHAT_NL_PARSER=cli opt-in 만 허용).
 */
export function nlCliVerified(): boolean {
  return readEnv("CHAT_NL_CLI_VERIFIED") === "1";
}

/**
 * 생성 무인화(S-1 · P4) 채택 여부 — env CHAT_GEN_UNMANNED_S1="1" 일 때만 true. 기본 false → 온라인 생성은
 *   검증된 C2 브리지(운영자 세션 소비)를 쓴다. true 라도 Agent SDK 호출(sdkGenerate)이 배선돼 있어야 실제로
 *   AgentSdkGenExecutor 가 선택된다(selectGenExecutor) — 둘 중 하나라도 없으면 브리지로 폴백(S-1 는 live-only 미검증).
 */
export function genUnmannedS1(): boolean {
  return readEnv("CHAT_GEN_UNMANNED_S1") === "1";
}

/**
 * 무인 워커(W3 세션 러너 · W4 소비자 데몬) env 규약 — chat-unmanned-consumer-plan 5절.
 *   무인화 범위는 '생성'뿐이고 core 게이트·승인·심의는 불변이다. 아래 값들은 그 무인 세션의 **상한**과
 *   **적용 범위**를 정하는 다이얼이다(러너/데몬은 여기만 읽는다 — 이 파일이 env 단일 출처).
 */

/**
 * 무인 세션 기동 여유(ms) — 잡 wall-clock 상한과 봇의 대기 상한 사이에 남겨두는 완충.
 *
 * 왜 필요한가: 봇의 마감(`expires_at` = 적재시각 + bridgeTimeout)은 **적재 순간**부터 흐르지만, 세션의
 *   wall-clock 예산(sdkGenTimeout)은 **세션이 실제로 뜬 순간**부터 흐른다. 그 사이의 지연(데몬 폴링 주기 →
 *   클레임-by-rename → CLI 콜드스타트)만큼 두 시계가 어긋나므로, 예산을 마감에 딱 붙여 잡으면 세션이
 *   정상 완주하고도 이미 만료된 잡이 된다(일해놓고 버려짐).
 * 왜 60초인가: 저 세 지연의 합에 대한 넉넉한 상한이다(폴링 주기는 초 단위, 클레임은 rename 1회, CLI
 *   콜드스타트는 수 초). 크게 잡을수록 안전하지만 그만큼 세션 예산을 깎으므로, '여유'로 인지 가능한
 *   최소 자릿수인 1분으로 둔다. 기본값(480+60=540초 ≤ 900초)은 360초를 더 남기므로 여유롭게 통과한다.
 */
export const WORKER_STARTUP_MARGIN_MS = 60_000;

/**
 * 무인 잡 1건의 wall-clock 예산 — env CHAT_SDK_GEN_TIMEOUT(**초 단위**), 반환은 **밀리초**. 기본 480000ms(=480초).
 *   '주 세션 + 복구 세션 합산'이다(둘의 각각이 아니라 잡 하나에 허용된 총 시간 — supervisor 의 `kill_at` 원천).
 *   미설정=기본값 · 명시했는데 못 읽는 값=예외 · 서브초=하한 1000ms clamp 는 timeoutEnvMs 규약.
 *   ⚠ 무인·과금 경로의 시간 상한이다 — `30m` 같은 오타가 조용히 기본 480초로 읽히면 운영자는 30분을 준 줄 알고
 *     8분을 받는다(반대로 짧게 준 줄 알고 길게 태울 수도 있다). 그래서 명시 오설정은 던진다.
 * @throws 명시했는데 초 단위 양수가 아니면 Error.
 */
export function sdkGenTimeout(): number {
  return timeoutEnvMs("CHAT_SDK_GEN_TIMEOUT", 480_000);
}

/**
 * 무인 세션 1건의 턴 상한 — env CHAT_SDK_MAX_TURNS. 기본 50. CLI `--max-turns` 로 넘어간다.
 *   폭주 세션(같은 실패를 무한 재시도)의 하드 천장이다 — 시간 상한(sdkGenTimeout)이 벽시계를 막는다면
 *   이쪽은 '한 세션이 몇 번이나 더 시도해볼 수 있는가'를 막는다.
 * **미설정=기본 50 · 명시했는데 1 이상의 정수가 아니면 예외**(clamp·반올림 없음).
 *
 * 왜 clamp 가 아니라 throw 인가(판정): 시간 상한(timeoutEnvMs)의 서브초 clamp 는 '0.5초'라는 **진짜 duration** 에
 *   시스템 바닥을 씌우는 일이지만, 턴은 이산량이라 그 아래 구간에 '너무 빡빡한 진짜 값'이 없다 — `0`·`-3` 은
 *   빡빡한 예산이 아니라 **오타**고(0 턴 세션은 존재할 수 없다), `7.6` 은 애초에 횟수가 아니다. 그런 값을 1 로
 *   올리거나 8 로 반올림하는 건 운영자가 쓴 적 없는 값을 대신 지어내는 것이며, `5O`(알파벳 O) → 50 이 조용히
 *   통과하던 것과 같은 부류의 사고다. 읽을 수 없으면 지어내지 말고 멈춘다.
 * @throws 명시했는데 1 이상의 정수가 아니면 Error(한국어 안내).
 */
export function sdkMaxTurns(): number {
  const raw = readEnv("CHAT_SDK_MAX_TURNS");
  if (raw === undefined) return 50;
  const n = Number(raw);
  // isInteger 가 아니라 **isSafeInteger** 다: `9007199254740993` 은 Number 로 읽으면 …992 로 정밀도가 깎이는데
  //   isInteger 는 참이라, 운영자가 쓰지 않은 다른 값을 턴 상한으로 되돌려주게 된다(이 게터가 clamp·반올림을
  //   거부한 이유와 같은 규칙 — 지어내지 않는다).
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `CHAT_SDK_MAX_TURNS 값이 올바르지 않습니다: "${raw}" — 1 이상의 정수여야 합니다(예: 50).`,
    );
  }
  return n;
}

/**
 * 데몬 폴링 간격 — env CHAT_SDK_POLL_INTERVAL(**초 단위**), 반환은 **밀리초**. 기본 5000ms(=5초).
 *   데몬은 대기줄이 비면 이만큼 자고 다시 훑는다(빈 폴링의 CPU·셸 spawn 을 줄인다). 미설정=기본값 ·
 *   명시했는데 못 읽는 값=예외 · 서브초=하한 1000ms clamp 는 timeoutEnvMs 규약(0 간격 타이트루프 방지).
 * @throws 명시했는데 초 단위 양수가 아니면 Error.
 */
export function sdkPollIntervalMs(): number {
  return timeoutEnvMs("CHAT_SDK_POLL_INTERVAL", 5_000);
}

/**
 * 무인 소비 잡 수 상한(사용량 측정 불가 시 폴백) — env CHAT_SDK_DAILY_JOB_CAP. 기본 20. **비용 상한이 아니라
 *   잡 수 상한**이다(계획 5절 · 단계별 비용차는 못 잡는다 — 부록A-10 이 지적). 데몬은 trailing 24h 창에서 소비한
 *   잡이 이 수에 이르면 더 집지 않는다(과금 폭주의 성긴 백스톱). 진짜 사용량 게이지가 생기기 전의 폴백이다.
 *   **미설정=기본 20 · 명시했는데 1 이상의 정수가 아니면 예외**(clamp·반올림 없음 — sdkMaxTurns 와 같은 규칙:
 *   `0`·`-3`·`7.6`·`2O` 는 빡빡한 예산이 아니라 오타라, 운영자가 쓰지 않은 값을 지어내지 않는다).
 * @throws 명시했는데 1 이상의 정수가 아니면 Error.
 */
export function sdkDailyJobCap(): number {
  const raw = readEnv("CHAT_SDK_DAILY_JOB_CAP");
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `CHAT_SDK_DAILY_JOB_CAP 값이 올바르지 않습니다: "${raw}" — 1 이상의 정수여야 합니다(예: 20).`,
    );
  }
  return n;
}

/**
 * 무인 소비자 id — env CHAT_SDK_CONSUMER_ID, 기본 `daemon`. `claimed/<이 id>/` 디렉터리명이 되므로 **안전
 *   토큰만**(job-protocol.SAFE_CONSUMER 와 같은 규칙의 **의도적 미러** — config 는 바닥 계층이라 import 하지 않는다).
 *   기본값을 **안정 문자열**(pid 무관)로 두는 이유: 데몬이 기동 시 자기 지난 생의 클레임(`claimed/daemon/`)을
 *   reaper 로 먼저 정리하려면 id 가 재기동 간 같아야 한다(pid 를 섞으면 매 기동 새 소비자가 돼 지난 고아를 못 찾는다).
 *   ⚠ 데몬을 다중화하려면 각자 다른 id 를 줘야 클레임 폴더가 충돌하지 않는다(단, 배치 전제는 단일 데몬 · 동시성 1).
 *   ⚠ 규칙이 바뀌면 job-protocol.ts 의 SAFE_CONSUMER 와 **함께** 고친다(두 곳이 같은 규칙을 말한다).
 * @throws 안전하지 않은 id(점 세그먼트·경로문자·64자 초과·빈값)면 Error(fail-fast — 기동 시 끊는다).
 */
const SAFE_CONSUMER_ID = /^[A-Za-z0-9._-]{1,64}$/;
export function sdkConsumerId(): string {
  const raw = readEnv("CHAT_SDK_CONSUMER_ID");
  if (raw === undefined) return "daemon";
  if (raw === "." || raw === ".." || !SAFE_CONSUMER_ID.test(raw)) {
    throw new Error(
      `CHAT_SDK_CONSUMER_ID 값이 안전하지 않습니다: "${raw}" — 영숫자·'.'·'_'·'-' 64자 이내여야 하고 ` +
        "'.'·'..'(경로 이동)은 쓸 수 없습니다(이 값은 claimed/<id>/ 디렉터리명이 됩니다).",
    );
  }
  return raw;
}

/**
 * 단계별 무인 enablement 규칙(job-protocol 의 SAFE_STAGE 와 동일). **의도적 미러**(import 아님):
 *   job-protocol.ts 가 이미 이 파일의 isSafeRunId 를 import 하므로, 역방향 import 는 순환이 된다
 *   (config = 다른 모듈이 의존하는 바닥 계층 — 아무 것도 import 하지 않는 자리를 지킨다).
 *   ⚠ 규칙이 바뀌면 job-protocol.ts 의 SAFE_STAGE 와 **함께** 고친다(두 곳이 같은 규칙을 말한다).
 */
const SAFE_STAGE_SEGMENT = /^[a-z0-9-]+$/;

/**
 * 무인화가 켜진 단계 목록 — env CHAT_SDK_STAGES(콤마분리). **미설정=빈 배열 = 어느 단계도 무인 아님**.
 *   기본 off 가 fail-closed 자세다(잠긴 결정 7 — 단계별 enablement): 실측으로 무인 완주를 확인한 단계만
 *   운영자가 명시로 켠다. 데몬은 미등재 단계의 잡을 아예 집지 않는다(사람 소비자 몫으로 남는다).
 *
 * ⚠ 여기 적는 값은 **잡의 stage 네임스페이스**(`run-stage.sh` 인자 = `intake`·`brief` …)이지, state.json 의
 *   페이즈 이름(`00a-intake`·`01-brief` 류)이 아니다. 데몬은 이 목록을 잡의 `stage` 문자열과 **그대로 비교**하므로
 *   페이즈 이름을 적으면 `stage:"brief"` 잡이 영영 안 켜진다 — 운영자는 켠 줄 아는데 잡은 조용히 대기만 한다.
 *   실제 무인 지원 단계는 worker/skill-rewrite 의 SUPPORTED_STAGES 가 정한다(config 는 바닥 계층이라 import 하지
 *   않는다 — 아래 문법 검사는 '파일명 안전' 규칙일 뿐 '무인 지원' 여부와 별개다).
 *
 * 안전하지 않은 토큰은 **조용히 버리지 않고 즉시 예외**(fail-fast)다 — 단계명은 파일경로 세그먼트가 되므로
 *   (`../evil` 류) 조용한 드롭은 '켠 줄 알았는데 안 켜진' 오설정을 운영 중 미스터리로 남기고, 통과시키면
 *   경로 탈출이 된다. 기동 시점에 오설정을 끊는 편이 안전하다.
 * @throws 안전하지 않은 단계명이 섞이면 Error(한국어 안내).
 */
export function sdkStages(): string[] {
  const raw = readEnv("CHAT_SDK_STAGES");
  if (!raw) return [];
  const stages = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of stages) {
    if (!SAFE_STAGE_SEGMENT.test(s)) {
      throw new Error(
        `CHAT_SDK_STAGES 에 안전하지 않은 단계명이 있습니다: "${s}" — 단계명은 영소문자·숫자·하이픈만 쓸 수 있습니다(예: intake,brief).`,
      );
    }
  }
  return stages;
}

/**
 * 무인 워커 시간 설정의 정합 검사 — `sdkGenTimeout() + 기동 여유 ≤ bridgeTimeout()` (계획 5절 기동 검증).
 *   어기면 세션이 예산을 다 쓰기 전에 잡이 먼저 만료된다 = 완주한 산출물이 버려지고 운영자는 이유를 모른다.
 *
 * **관계 위반은 던지지 않고 결과로 돌려준다**(순수 검사기) — 기동 배선은 W4(소비자 데몬)의 몫이고, 여기서 throw 하면
 *   이 값을 안 쓰는 다른 경로(봇 등)까지 config 를 읽다 죽는다. 부르는 쪽이 언제 멈출지 정한다.
 *
 * 단 **env 자체가 오설정이면 getter(sdkGenTimeout·bridgeTimeout)의 예외가 그대로 올라온다** — 일부러 그렇게 둔다.
 *   이 검사기가 판정하는 건 '잘 읽힌 두 값 사이의 관계'지 '값을 읽을 수 있는가'가 아니다. 오설정을 {ok:false} 로
 *   바꿔 담으면 관계 위반과 구별이 안 되고, 무엇보다 fail-fast 를 드러내야 할 자리에서 되레 삼키게 된다.
 * @throws CHAT_SDK_GEN_TIMEOUT·CHAT_BRIDGE_TIMEOUT 이 명시됐는데 초 단위 양수가 아니면 Error(getter 전파).
 */
export interface WorkerTimeoutCheck {
  ok: boolean;
  /** ok=false 일 때만. 운영자가 무엇을 어떻게 고쳐야 하는지 알려주는 평이한 한국어 사유. */
  reason?: string;
}
export function validateWorkerTimeouts(): WorkerTimeoutCheck {
  const gen = sdkGenTimeout();
  const bridge = bridgeTimeout();
  const needed = gen + WORKER_STARTUP_MARGIN_MS;
  if (needed <= bridge) return { ok: true };
  const sec = (ms: number) => Math.round(ms / 1000);
  return {
    ok: false,
    reason:
      `무인 생성 시간(CHAT_SDK_GEN_TIMEOUT=${sec(gen)}초)에 기동 여유 ${sec(WORKER_STARTUP_MARGIN_MS)}초를 더하면 ` +
      `${sec(needed)}초라, 봇의 대기 상한(CHAT_BRIDGE_TIMEOUT=${sec(bridge)}초)을 넘습니다 — 세션이 다 끝내기 전에 ` +
      `요청이 먼저 만료돼 결과가 버려집니다. CHAT_SDK_GEN_TIMEOUT 을 ${sec(bridge - WORKER_STARTUP_MARGIN_MS)}초 이하로 줄이거나 ` +
      `CHAT_BRIDGE_TIMEOUT 을 ${sec(needed)}초 이상으로 올리세요.`,
  };
}

/**
 * run_id 가 '경로 세그먼트로 안전한가' — 파일경로에 넣기 전 검증(디렉터리 탈출·클로버 방지).
 * 허용: 영숫자 · '.'·'_'·'-' (하네스 run_id 관례 = kebab/영숫자). 슬래시·역슬래시·널·`.`/`..` 단독은 불가.
 * (chat 레이어가 rid 를 data/<rid> 등 경로에 쓰므로 `../other` 같은 값이 남의 run 입력을 덮어쓰는 것을 막는다.)
 */
export function isSafeRunId(rid: string): boolean {
  if (typeof rid !== "string" || rid.length === 0 || rid.length > 128) return false;
  if (rid === "." || rid === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(rid);
}
