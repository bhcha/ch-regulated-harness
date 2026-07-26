/**
 * cli-session.ts — 무인 `claude` CLI 세션 1건의 **조립**(순수 · 스폰 없음).
 *
 * 한 단계를 무인 생성하는 세션을 띄우는 데 필요한 전부(argv · cwd · env · 격리 settings)를 결정론적으로 조립한다.
 *   스폰·파일쓰기·시계·네트워크는 **없다**(그건 러너의 몫이다). 왜 이렇게 가르나: 여기가 **경계를 정하는 자리**라서다.
 *   경계가 스폰 코드와 뒤섞이면 단위 테스트로 못 박을 수 없고, 못 박지 못하는 경계는 실행마다 흔들린다(= 경계가 아니다).
 *   조립을 순수하게 떼어놓으면 적대 우회 표를 fake spawn 없이 **문자열로** 고정할 수 있다.
 *
 * 축은 전부 **실측 산물**이다(계획 부록A-9 '작동한 최소 구성' · A-11 확정 설계 — 이 표가 SSoT 다):
 *   | cwd              | `<coreRoot>/runs/<rid>` — 이게 곧 **읽기 경계**다(A-4)                       |
 *   | `--add-dir`      | core/prompts · core/harness · core/scripts · packs/<도메인> (전부 절대경로) |
 *   | `--tools`        | `Bash,Read,Write,Edit,Glob,Grep`                                            |
 *   | `--allowedTools` | skill-rewrite 가 SKILL.md 원문에서 도출한 규칙(손으로 짜지 않는다 — A-9 교훈) |
 *   | `--permission-mode` | `acceptEdits`(파일 작성 자동승인 · Bash 는 여전히 규칙이 지배)           |
 *   | `--setting-sources` | `user` 하나 — project/local 설정을 경계에서 배제한다(아래 '설정 소스')   |
 *   | `--strict-mcp-config` | `--mcp-config` 없이 켜서 **MCP 서버 0개**(아래 '도구 표면')            |
 *   | env              | hygienicSpawnEnv + 격리 CLAUDE_CONFIG_DIR + OAuth 주입 + HARNESS_ACK_GAPS=0 핀 |
 *
 * 설정 소스(`--setting-sources user`) — **격리 CONFIG_DIR 만으론 부족했다**:
 *   격리 `CLAUDE_CONFIG_DIR` 가 옮기는 건 **user 설정뿐**이고, project/local 설정은 **별개 소스**라 그대로 병합된다.
 *   우리 cwd 는 `core/runs/<rid>` = **레포 안**이라 레포의 `.claude/settings.local.json` 이 이 세션의 권한에 섞인다
 *   (부록A-9 의 드라이런은 레포 **밖** scratch 픽스처에서 돌아 이걸 못 봤다). 실재 확인(2026-07-17): 레포 루트 파일에
 *   `Bash(bash scripts/select.sh … B-usevalue)`(= **결정** 명령 — 결정은 사람의 몫이다 · AGENTS 5번 절) 와
 *   `Read(//Users/chabh/Documents/temp/**)`·`Read(//Users/chabh/Downloads/NAVERWORKS/**)`(= cwd **밖 절대경로 읽기**)가
 *   들어 있었다. 더 나쁜 건 그 파일이 **사람이 대화형 세션에서 '허용'을 누를 때마다 자란다**는 점이다 — 특정 규칙이
 *   오늘 악용 가능한가와 무관하게, 무인 경계가 **사람의 클릭을 따라 조용히 넓어지는** 구조 자체가 불변식 위반이다.
 *   그래서 소스를 `user` 로 핀한다(실측 `claude --help` 2.1.212: `--setting-sources <sources>` = `user,project,local`).
 *   ⚠ **잔여 리스크(정직하게)**: `user` 가 우리 `CLAUDE_CONFIG_DIR` 로 해석되지 **않는다면** 아래 `permissions.deny` 가
 *     조용히 증발한다. 다만 그 층은 **방어심층**이지 경계의 본체가 아니고(본체 = cwd + allow 규칙 부재), project/local
 *     배제는 어느 쪽이 참이든 **엄격한 개선**이다(넓히는 방향이 없다). → **W5 라이브 카나리 항목**:
 *       ① 우리 deny 규칙이 실제로 발효 중인가(런의 `state.json` 쓰기가 거부되는가)
 *       ② 절대경로 `Read(//Users/...)` allow 가 cwd 기본-거부를 **뚫지 못하는가**(뚫으면 경계 모델이 틀린 것이다)
 *
 * 도구 표면(`--strict-mcp-config`) — `--tools` 는 **빌트인만** 제한한다:
 *   `core/.mcp.json` 이 실재하고(서버 `openalex-paper-search`) 세션 cwd 가 core 안이라 프로젝트 MCP 서버가 붙을 수 있다.
 *   claude.ai 커넥터도 OAuth 계정을 타고 도구를 노출하며 **설정 소스의 지배를 받지 않는다**. 즉 '도구 정확히 여섯 개인
 *   결정적 세션'은 오늘 기준 사실이 아니었다 → `--strict-mcp-config`(`--mcp-config` 없음 = **서버 0개**) + env
 *   `ENABLE_CLAUDEAI_MCP_SERVERS=false` 로 **결정적 도구 표면 계약을 복원**한다.
 *   ⚠ 이건 **게이트 우회 증명이 아니다**(과장 금지): MCP 도구도 제 몫의 승인이 필요하므로 헤드리스에선 어차피
 *     fail-closed 다. 여기서 되찾는 건 '무엇이 붙어 있는지 우리가 안다'는 **결정성**이지 뚫린 구멍을 막는 게 아니다.
 *   ⚠ **정정(외부리뷰 W2-R2)**: 앞선 주석은 "`core/.claude/settings.local.json` 의 `{"enabledMcpjsonServers": []}` 가
 *     오늘 `.mcp.json` 을 억누르는 유일한 것이라, 설정소스 핀만 넣으면 MCP 가 오히려 열린다"고 적었는데 **틀렸다**.
 *     ① `enabledMcpjsonServers` 는 **거부 목록이 아니라 승인 목록**이라 빈 배열이 무언가를 억제하는 게 아니다
 *        (명시 거부는 `disabledMcpjsonServers`). ② 2.1.212 의 프로젝트 MCP 로더는 `projectSettings` 가 선택되지
 *        않으면 즉시 빈 서버 집합을 반환한다 → `--setting-sources user` 만으로도 `core/.mcp.json` 은 안 실린다.
 *     그래도 **두 핀을 함께 둔다**: MCP 핀은 설정소스 핀에 기대지 않고 **독립적으로** 도구 표면을 0 으로 고정하며
 *     (claude.ai connector 는 애초에 설정소스의 통제 밖이다), 미래에 소스 선택이 바뀌어도 표면이 따라 흔들리지 않는다.
 *
 * 경계 모델(A-3·A-4 실측 — 계획 4번 절의 **옛 모델과 다르다**. A-7 이 그 정정을 요구했고 실제 모델이 더 강하다):
 *   · **읽기 경계 = cwd + `--add-dir`(기본 거부)**. 열거가 아니라 구조로 막는다 — cwd 밖은 규칙을 하나도 안 걸어도
 *     차단되고 **Bash 경유 읽기도 포함**이다(A-9 실측: 무인 세션이 실제로 타 런을 뒤지려 했고 cwd 경계가 막았다).
 *     그래서 이 모듈은 read 허용목록을 만들지 않는다 — A-3 상 `deny` 가 `allow` 를 이기므로 '전부 deny + 내 것만 allow'
 *     형태는 **애초에 만들 수 없고**, `ask` 는 Bash 읽기에 적용되지 않아 경계 수단이 아니다.
 *   · **실행 경계 = 승인 게이트의 헤드리스 fail-closed**. `--allowedTools` 는 제한 장치가 아니라 **승인 필요 명령을
 *     통과시키는 예외 등록**이다(A-3). 나머지를 막는 힘은 '헤드리스엔 승인 프롬프트를 답할 주체가 없다'는 구조다.
 *   · **deny 는 경계 안쪽에서 파내는 예외**(A-7 2번) — 런의 `state.json`·`run.md`·`.lock` 쓰기 금지 + add-dir 루트 쓰기 금지.
 *     읽기 deny(`.env`·타 런·jobs·`~/.claude`)를 열거하지 않는 이유는 위 cwd 경계가 이미 구조로 막기 때문이다.
 *
 * ⚠ **절대 쓰지 않는 플래그**:
 *   · `--bare` — 훅/플러그인/keychain 을 건너뛰어 격리에 유혹적으로 보이지만, 문서상 인증이 `ANTHROPIC_API_KEY`
 *     또는 `apiKeyHelper` 로 **강제**되고 OAuth·keychain 을 절대 안 읽는다 = 구독이 아니라 **API 과금 경로**(부록A-6).
 *     잠긴 결정 6(API 과금 구조적 차단)과 정면 충돌하므로 금지다.
 *   · `--dangerously-skip-permissions` · `--allow-dangerously-skip-permissions` · `--permission-mode bypassPermissions`
 *     — 승인 게이트가 곧 실행 경계인데(A-3) 그걸 끄면 경계가 통째로 사라진다.
 *
 * 이 모듈이 보증하지 못하는 것(정직하게 적는다): 여기서 만드는 건 **문자열**이고, 그 문자열을 CLI 가 실제로 어떻게
 *   매칭하는지는 부록A-5 의 라이브 실측이 답한 것이다. 즉 **CLI 업그레이드 때 적대 카나리를 다시 돌려야 한다**
 *   (계획 7번 절 R-1·R-7). 단위 테스트는 '우리가 무엇을 조립했는가'를 고정할 뿐 '그 규칙이 무엇을 막는가'를 증명하지 않는다.
 */
import { isAbsolute, join, resolve } from "node:path";

// rid 안전 판정은 config 의 단일 규칙을 재사용한다(중복 정의 금지 — skill-rewrite.ts·job-protocol.ts 도 같은 것을 쓴다).
import { isSafeRunId } from "../config.js";
// env 위생(화이트리스트 재구성 · 과금키/마커/플랫폼 비밀 스크럽 · HARNESS_ACK_GAPS="0" 핀)은 이미 구현돼 있다.
//   여기서 다시 만들지 않는다 — 비밀 이름 목록이 두 곳에 있으면 갈라지고, 갈라진 스크럽은 스크럽이 아니다.
import { hygienicSpawnEnv } from "../spawn-hygiene.js";

/** 부록A-9 '작동한 최소 구성'의 도구 집합. 콤마 1토큰(= `--help` 예시 `"Bash,Edit,Read"` 와 같은 형태). */
export const SESSION_TOOLS = "Bash,Read,Write,Edit,Glob,Grep";

/**
 * 부록A-9 의 권한 모드. `acceptEdits` = 파일 작성 자동승인이라 세션이 산출물을 쓸 수 있고, **Bash 는 여전히
 *   규칙이 지배**하므로 실행 경계는 유지된다(A-3). `bypassPermissions` 는 그 게이트 자체를 없애므로 금지다.
 */
export const SESSION_PERMISSION_MODE = "acceptEdits";

/** 격리 CLAUDE_CONFIG_DIR 안의 settings 파일명(= 이 CLI 의 '사용자' 설정 자리). 쓰기는 러너의 몫. */
export const WORKER_SETTINGS_FILENAME = "settings.json";

/**
 * `--setting-sources` 에 넘기는 값 — **`user` 하나뿐**(콤마 목록의 1원소 · 위 '설정 소스' 절).
 *
 * `user` 를 남기는 이유: 우리 `permissions.deny` 가 사는 곳이 격리 `CLAUDE_CONFIG_DIR/settings.json` = **user 자리**다.
 *   `project`·`local` 을 빼는 이유: 그건 **레포가 소유한 파일**이고, 경계는 **워커 코드가 보증해야지 워커가 소유하지
 *   않은 파일에 맡길 수 없다**. 사람이 대화형으로 '허용'을 누를 때마다 자라는 파일이 무인 경계를 정하게 두지 않는다.
 * ⚠ 값에 `project`/`local` 을 **절대 더하지 말 것** — 그 순간 레포의 allow 규칙이 무인 세션 권한으로 병합된다.
 */
export const SESSION_SETTING_SOURCES = "user";

/**
 * claude.ai 커넥터(OAuth 계정에 묶인 MCP 도구)를 끄는 env 핀.
 *
 * 실측(2.1.212 번들): `vu(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)` 가 참이면 `[claudeai-mcp] Disabled via env var`.
 *   그 `vu` 는 `["0","false","no","off"]` 를 참으로 읽는 **falsy 문자열 파서**다 → `"false"` 가 곧 '끔'이다.
 *   `--strict-mcp-config`(설정 파일發 MCP 차단)로는 이 경로가 안 닫힌다 — 커넥터는 설정 소스가 아니라 **계정**을 탄다.
 */
export const SESSION_CLAUDEAI_MCP_ENV = "ENABLE_CLAUDEAI_MCP_SERVERS";
export const SESSION_CLAUDEAI_MCP_VALUE = "false";

/** `--add-dir` 로 여는 core 하위 경로 — 부록A-9 표 순서 그대로(결정론). packs/<도메인> 은 형제라 따로 잡는다. */
const ADD_DIR_CORE_SUBDIRS = ["prompts", "harness", "scripts"] as const;

/** core 의 형제 팩 루트 디렉터리명(core/scripts/lib/common.sh 의 `PACKS_DIR` 기본값과 같은 규칙). */
const PACKS_DIRNAME = "packs";

/** 런 디렉터리들의 부모(= `<coreRoot>/runs`). cwd 는 그 **한 칸 아래**여야 타 런이 경계 밖이 된다(A-4). */
const RUNS_DIRNAME = "runs";

/**
 * 규제도메인 형식 검사 — `core/harness/state.schema.json` 의 `regulatory_domain` 패턴과 **같은 규칙**이다.
 *   여기서 보는 건 '형식'이지 '등록 여부'가 아니다(등록 강제는 core 의 `new-run.sh normalize_domain` 이 팩
 *   레지스트리로 한다 — state 의 유일한 쓰기 주체). 이 모듈이 도메인을 검사하는 이유는 하나다:
 *   **검증 안 된 도메인 문자열이 경로(`packs/<domain>`)와 권한 규칙 문자열에 그대로 박히기 때문**이다
 *   (`../../etc` 는 add-dir 로 엉뚱한 경로를 열고, `)` 하나면 `Write(//…/**)` 규칙 문법이 깨져 조용히 무효가 된다).
 */
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 경로에 섞이면 안 되는 문자 — 공백·셸/규칙 메타문자.
 *   skill-rewrite 의 `SHELL_METACHARS` 와 **같은 취지의 중복**이다(그쪽은 export 하지 않고, 이 파일은 그 파일을
 *   고칠 수 없다). 여기서 막는 이유는 그쪽과 다르다: 이 경로들은 셸이 아니라 **권한 규칙 문자열에 박힌다** —
 *   `Write(//a b)/**)` 처럼 `)` 가 섞이면 규칙이 조기 종료돼 **의도한 것보다 좁게(=구멍) 해석**되고, 그 실패는
 *   조용하다(규칙 파싱 오류를 우리가 볼 수 없다). 그래서 '경계 문자열을 만들 수 없는 입력'은 조립 단계에서 끊는다.
 */
const PATH_UNSAFE = /[\s|&;<>()`$\\'"*?[\]{}]/;

/**
 * 결정·상태변이 스크립트 — `--disallowedTools` 2차 방어의 대상(계획 4번 절 2층).
 *
 * ⚠ **이건 1차 경계가 아니다**(A-5). 이 명령들은 '승인 필요' 부류라 **allow 규칙이 없다는 사실만으로 이미
 *   fail-closed**(헤드리스엔 승인을 답할 주체가 없다). 그러므로 여기 목록은 방어심층이지 경계의 본체가 아니고,
 *   **동의어를 열거하려 들지 않는다**(A-5: 간접 스펠링 `sh -c`·`python3 -c` 는 승인 게이트가 잡는다 —
 *   열거는 어차피 불완전한데 완전하다는 착각만 준다).
 *   그럼에도 굳이 적는 이유: 결정은 사람의 몫이라(AGENTS 5번 절) **명시적으로 거부됐다는 기록**이 남는 편이,
 *   '규칙이 없어서 우연히 막혔다'보다 감사에 유리하고 allow 규칙이 실수로 넓어진 날의 마지막 그물이 된다.
 *
 * 목록은 실제 `core/scripts/*.sh` 파일명이다(계획의 `apply-*` = 오늘 기준 `apply-learnings.sh` 하나 —
 *   `apply-intake`·`apply-proposal` 은 독립 스크립트가 아니라 `gate.sh` 내부 훅이다). 정렬 = 결정론(바이트순).
 *   ⚠ core 가 이 파일들을 개명하면 규칙이 조용히 헛돈다 → 단위 테스트가 실재를 확인해 드리프트를 깨운다.
 *
 * ⚠ `a2ui-action.sh` 를 반드시 포함한다(맨 앞 — "a2" < "ad" 바이트순): 이 스크립트는 select/approve/revise/
 *   run-stage(raise-limit)로 위임하는 **결정 브리지**다. deny 목록에서 빠지면, select.sh 등을 직접 못 쓰도록 막아둔
 *   무인 세션이 `bash .../a2ui-action.sh <id> '{"action":"approve"}'` 로 **우회해 결정 스크립트에 닿는 간접 구멍**이
 *   열린다. deny 에 넣어 그 우회를 닫는다(직접 결정 스크립트 차단과 동일 효력).
 */
export const DECISION_SCRIPTS = [
  "a2ui-action.sh",
  "advance-phase.sh",
  "apply-learnings.sh",
  "approve.sh",
  "gate.sh",
  "ingest-bundle.sh",
  "ingest.sh",
  "intake.sh",
  "kcia-check.sh",
  "new-run.sh",
  "revise.sh",
  "select.sh",
] as const;

/**
 * 절대경로 → 권한 규칙의 **절대 글롭 표기**(`//abs/...`). 부록A-3 의 `Read(//**)`(유효한 전체 글롭)와 같은 표기다.
 *
 * 왜 상대 표기(`./state.json`)를 쓰지 않나: 규칙의 상대경로가 **무엇을 기준으로** 풀리는지가 부록A 에 없다
 *   (settings 파일이 있는 디렉터리인가, cwd 인가 — A-3 의 프로브는 그 둘이 갈리는 배치가 아니었다).
 *   우리 settings 는 cwd(런 디렉터리)가 아니라 **격리 CONFIG_DIR** 안에 있으므로 그 차이가 곧 규칙의 유효/무효를
 *   가른다. 절대 표기는 그 질문 자체를 없앤다.
 * ⚠ **미실측 — W5 카나리 확인 필요**: A-3 이 실측한 절대 글롭은 `Read(//**)` 이고, `Write`/`Edit` 규칙의 절대
 *   표기·매칭은 기록이 없다. 틀렸다면 이 deny 는 조용히 무효다 → 그래서 이 층을 '경계의 본체'로 부르지 않는다.
 */
function absGlob(absPath: string): string {
  return `/${absPath}`;
}

/** 경로 인자 검증(절대 + 규칙 문자열에 박을 수 있는 형태). 통과하면 그 경로를 그대로 돌려준다. */
function assertRulePath(label: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 가 필요합니다 — 절대경로를 넘기세요.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(
      `${label} 는 절대경로여야 합니다(받은 값: '${value}'). 상대경로는 cwd 에 따라 결과가 달라져 조립 결정론이 깨지고, ` +
        "부록A-10 실측상 모델이 상대경로 깊이를 오산해 명령이 거부됩니다.",
    );
  }
  if (PATH_UNSAFE.test(value)) {
    throw new Error(
      `${label} 에 공백·셸/글롭 메타문자를 쓸 수 없습니다(권한 규칙 문자열이 깨집니다): '${value}'`,
    );
  }
  return value;
}

/**
 * 이 세션의 cwd = `<coreRoot>/runs/<rid>` — **이게 곧 읽기 경계다**(부록A-4).
 *
 * ⚠ 계획 W3 초안의 `cwd=core` 는 여기서 채택하지 않는다(A-7 3번이 재검토를 요구했고, A-4 가 답을 줬다):
 *   core 를 cwd 로 잡으면 `core/runs/*` **전체가 경계 안**이라 타 런 읽기가 열린다. 런 디렉터리를 cwd 로 잡고
 *   필요한 경로만 `--add-dir` 로 여는 것이 r8 의 realpath 허용목록(기본 거부 + 현재 런 + 고정 지침 경로 +
 *   선언 도메인 packs)의 **CLI 네이티브 대응물**이다.
 */
export function buildRunCwd(input: { coreRoot: string; rid: string }): string {
  const core = assertRulePath("coreRoot", input.coreRoot);
  if (!isSafeRunId(input.rid)) {
    throw new Error(
      `run_id 가 안전한 토큰이 아닙니다: '${input.rid}'. 영숫자·'.'·'_'·'-' 만 허용합니다 ` +
        "(이 값은 cwd 경로와 권한 규칙 문자열에 그대로 박히므로, 경로 탈출·규칙 훼손을 조립 전에 끊습니다).",
    );
  }
  return join(core, RUNS_DIRNAME, input.rid);
}

/**
 * `--add-dir` 4종(절대경로 · 부록A-9 표 순서) — cwd 경계에 **정확히 이 경로들만** 추가한다.
 *
 * 왜 이 4개인가(A-9 실측 = 무인 완주에 실제로 필요했던 최소):
 *   prompts(단계 계약) · harness(스키마) · scripts(전이·emit-context) · packs/<선언 도메인>(룰셋).
 *   ⚠ 도메인은 **선언된 그 하나만** 연다. `packs` 루트를 통째로 열면 남의 도메인 룰셋까지 경계 안이 된다.
 *
 * packs 는 core 의 **형제**다(모노레포 배치). core 는 `PACKS_DIR="${PACKS_DIR:-$HARNESS_ROOT/../packs}"` 로 같은
 *   경로를 유도하고, 우리 env 위생(화이트리스트 재구성)은 `PACKS_DIR` 를 싣지 않으므로 **세션 안 core 스크립트도
 *   반드시 이 형제 경로를 본다** — 두 계산이 갈라질 여지가 구조적으로 없다(env 를 넓히면 그 보증이 깨진다).
 *
 * @throws 도메인 형식 위반 · coreRoot 가 절대경로가 아니거나 규칙에 박을 수 없는 형태일 때.
 */
export function buildAddDirs(input: { coreRoot: string; domain: string }): string[] {
  const core = assertRulePath("coreRoot", input.coreRoot);
  if (typeof input.domain !== "string" || !DOMAIN_PATTERN.test(input.domain)) {
    throw new Error(
      `규제도메인 형식이 올바르지 않습니다: '${input.domain}' — 영소문자로 시작하는 영소문자·숫자·'_' 조합이어야 ` +
        "합니다(예: cosmetic·quasi_drug·health_food·drug). 검증되지 않은 도메인은 팩 경로와 권한 규칙 문자열에 " +
        "그대로 박히므로 조립 전에 끊습니다(등록 여부는 core 의 new-run 이 레지스트리로 강제합니다).",
    );
  }
  const packsRoot = resolve(core, "..", PACKS_DIRNAME);
  return [...ADD_DIR_CORE_SUBDIRS.map((sub) => join(core, sub)), join(packsRoot, input.domain)];
}

/**
 * `--disallowedTools` 규칙(2차 방어 · 결정·상태변이 스크립트). 접두 매칭(`:*`)이라 인자와 무관하게 걸린다.
 *   1차 경계는 **allow 규칙의 부재**라는 점을 잊지 말 것(A-5 · 위 DECISION_SCRIPTS 주석).
 */
export function buildDisallowedTools(coreRoot: string): string[] {
  const core = assertRulePath("coreRoot", coreRoot);
  return DECISION_SCRIPTS.map((name) => `Bash(bash ${join(core, "scripts", name)}:*)`);
}

/** 격리 CONFIG_DIR 에 쓸 settings 내용(러너가 직렬화해 쓴다 — 이 모듈은 파일을 만들지 않는다). */
export interface WorkerSettings {
  permissions: { deny: string[] };
}

/**
 * 격리 `CLAUDE_CONFIG_DIR/settings.json` 내용 — **경계 안쪽에서 파내는 예외**만 담는다(부록A-7 2번).
 *
 * ⚠ **이 deny 는 '보조 방어'가 아니라 하중을 받는다**(외부리뷰 W2-R2 정정): `--permission-mode acceptEdits` 라
 *   **cwd 안 쓰기는 자동 승인**되는데 cwd(`runs/<rid>`) 안에 `state.json` 이 있다. 즉 아래 ①을 빼면 세션이
 *   state 를 직접 쓰는 걸 막는 게 **아무것도 없다**. 읽기 경계(cwd)·실행 경계(allow 규칙 부재)와 달리 이건
 *   구조가 아니라 **규칙 문자열이 실제로 매칭돼야** 성립한다 → 아래 ⚠(글롭 철자 미실측)가 그래서 중요하다.
 *
 * 담는 것:
 *   ① 런의 `state.json`·`run.md`·`.lock` 쓰기 금지 — **상태는 오직 `run-stage.sh` 가 쓴다**(AGENTS 1번 절).
 *      세션이 state 를 직접 쓸 수 있으면 게이트를 건너뛴 '전이'가 가능해져 승인·심의 전제가 통째로 무너진다.
 *      `.lock` 은 파일이 아니라 **디렉터리**(core 의 mkdir 원자성 락)라 실질 표적은 `.lock/pid`(보유 PID 위조)다 →
 *      루트와 하위를 함께 막는다.
 *   ② `--add-dir` 루트 4종 쓰기 금지 — 그것들은 **입력이지 산출물이 아니다**. `acceptEdits` 아래선 파일 작성이
 *      자동승인이므로, 막지 않으면 세션이 `scripts/run-stage.sh` 를 고쳐놓고 **허용된 그 한 줄로 실행**할 수 있다
 *      (= allow 규칙 정밀도를 우회하는 지름길). `packs/<도메인>/ruleset.json` 쓰기 금지는 같은 이유의 심의판
 *      — 자기 심의 기준을 고쳐 쓰는 세션은 self-grading 이다(AGENTS 1번 절 4).
 *
 * 담지 않는 것: **읽기 허용목록도, 읽기 deny 열거도 없다.** cwd 가 이미 기본-거부 읽기 경계라 `.env`·타 런·
 *   `chat/jobs`·`~/.claude` 는 전부 구조적으로 밖이고(A-4), A-3 상 `deny` 가 `allow` 를 이기므로 '전부 deny +
 *   내 것만 allow' 는 만들 수도 없다. `ask` 는 Bash 읽기에 적용되지 않아 수단이 아니다.
 *
 * 결정론: 규칙 순서는 선언 순서 고정(같은 입력 → 바이트 동일 산출). 설정 파일이 실행마다 달라지면 그 경계는 무효다.
 */
export function buildWorkerSettings(input: { runDir: string; addDirs: string[] }): WorkerSettings {
  const runDir = assertRulePath("runDir", input.runDir);
  if (!Array.isArray(input.addDirs) || input.addDirs.length === 0) {
    throw new Error("addDirs 가 비어 있습니다 — buildAddDirs() 의 산물을 그대로 넘기세요(입력 경로 쓰기 금지 대상).");
  }

  const deny: string[] = [];
  // ① 런 안에서 스크립트만 만질 수 있어야 하는 것들.
  for (const rel of ["state.json", "run.md", ".lock", join(".lock", "**")]) {
    const target = absGlob(join(runDir, rel));
    deny.push(`Write(${target})`, `Edit(${target})`);
  }
  // ② 입력 경로(add-dir 루트)는 읽기 전용이다.
  for (const dir of input.addDirs) {
    const target = absGlob(join(assertRulePath("addDirs 항목", dir), "**"));
    deny.push(`Write(${target})`, `Edit(${target})`);
  }
  return { permissions: { deny } };
}

/** settings 직렬화(결정적) — 2칸 들여쓰기 + 끝 개행. 러너가 이 문자열을 그대로 쓴다. */
export function serializeWorkerSettings(settings: WorkerSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * 무인 세션 env — 위생 재구성(hygienicSpawnEnv) + 격리 CONFIG_DIR + OAuth 주입.
 *
 * hygienicSpawnEnv 가 이미 하는 일은 **다시 하지 않는다**: 화이트리스트 재구성(base 통째 복사 아님) ·
 *   `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`·`CODEX_*`·Bedrock/Vertex·마커·플랫폼 비밀 스크럽 ·
 *   `HARNESS_ACK_GAPS="0"` 핀(core 의 .env 로더가 set-if-unset 이라 생략만으론 되채워진다).
 *
 * 여기서 더하는 두 가지:
 *   · **격리 CONFIG_DIR 필수** — 사용자 훅/플러그인/MCP/`apiKeyHelper` 를 애초에 없애는 층이라(과금·행동 우회 차단)
 *     선택지가 아니다. 절대경로만 받는다: 상대경로면 CLI 가 **cwd(=런 디렉터리) 기준**으로 풀어 워커 설정이
 *     남의 산출물 폴더 안에 생긴다(= 격리 실패 + 런 오염).
 *   · **OAuth 토큰 주입** — 격리 CONFIG_DIR 는 로컬 로그인 자격증명까지 가려서 그대로 두면 `Not logged in` 이다
 *     (부록A-1 부수 관측). 토큰 주입으로 인증·격리·경계가 한 구성에서 성립함이 A-8 에서 실측됐다.
 *     ⚠ 토큰은 **API 키가 아니라 구독 토큰**이라 과금이 구독으로 잡힌다(잠긴 결정 6). 빈 문자열은 '미설정'으로
 *     취급한다(config 의 readEnv 관례) — 빈 값을 실어보내면 인증이 '설정됐는데 실패'로 흐려진다.
 *   · **claude.ai 커넥터 끄기**(`ENABLE_CLAUDEAI_MCP_SERVERS=false`) — 커넥터는 **OAuth 계정**을 타고 도구를 노출하므로
 *     바로 위 토큰 주입이 여는 경로다(= 격리 CONFIG_DIR 도 `--strict-mcp-config` 도 못 닫는다). 인증을 주는 대가로
 *     열리는 표면이니 인증과 **같은 자리에서** 닫는다. 도구 표면 결정성 계약이지 승인 게이트 대체물이 아니다.
 *
 * ⚠ 여기 핀은 `hygienicSpawnEnv` 의 `inject` 를 탄다 — 그쪽이 스크럽 대상 이름을 거부하고(방어심층) `HARNESS_ACK_GAPS`
 *   "0" 핀은 inject 보다 **뒤에 덮어써서 항상 이긴다**. 그 순서에 기대므로 위생 모듈을 고칠 땐 이 결합을 함께 볼 것.
 */
export function buildSessionEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: { configDir: string; oauthToken?: string },
): Record<string, string> {
  const configDir = opts.configDir;
  if (typeof configDir !== "string" || configDir.trim() === "" || !isAbsolute(configDir)) {
    throw new Error(
      `격리 CLAUDE_CONFIG_DIR 는 절대경로여야 합니다(받은 값: '${configDir}') — 워커가 잡마다 만드는 전용 디렉터리를 넘기세요. ` +
        "상대경로는 세션 cwd(런 디렉터리) 기준으로 풀려 워커 설정이 런 산출물 안에 생깁니다.",
    );
  }
  const token = opts.oauthToken;
  return hygienicSpawnEnv(baseEnv, {
    configDir,
    inject: {
      // 커넥터 차단은 **토큰 유무와 무관하게** 항상 실린다 — 토큰이 없는 실행(인증 실패로 죽는 경로)에서도
      //   도구 표면 계약이 구성상 같아야 한다. 조건부로 달면 '토큰 없을 때만 표면이 다른' 세션이 생긴다.
      [SESSION_CLAUDEAI_MCP_ENV]: SESSION_CLAUDEAI_MCP_VALUE,
      ...(typeof token === "string" && token !== "" ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    },
  });
}

export interface SessionArgsInput {
  /** 세션에 넘길 프롬프트 = skill-rewrite 의 치환 산물(SKILL.md 전문). 프리앰블을 덧붙이지 않는다(부록A-10). */
  prompt: string;
  /** `--allowedTools` 규칙 — **skill-rewrite 도출 산물**(손으로 짜지 않는다 · 부록A-9 교훈). */
  allowRules: string[];
  /** `--disallowedTools` 규칙(buildDisallowedTools 산물). */
  disallowRules: string[];
  /** `--max-turns`(config 의 sdkMaxTurns). 이 모듈은 env 를 읽지 않는다 — 순수 유지. */
  maxTurns: number;
  /** `--add-dir`(buildAddDirs 산물 · 절대경로). */
  addDirs: string[];
}

/**
 * argv 조립(순수).
 *
 * **cwd 는 여기 없다** — CLI 에 cwd 플래그가 없기 때문이다(cwd 는 spawn 속성이라 러너가 넘긴다).
 *   그래도 cwd 는 이 모듈이 정한다(buildRunCwd·buildSessionPlan): 경계를 정하는 자리는 한 곳이어야 한다.
 *
 * 순서 규약(두 가지 실측이 강제한다 — 로컬 파서 수준 프로브 · claude 2.1.212 · **API 콜 없음**):
 *   ① **프롬프트는 `--` 뒤 피연산자**로 넘긴다. cli-parser 의 `-p <prompt>` 관례에서 벗어나는 유일한 지점이고,
 *      이유가 있다: `-p` 는 값을 받지 않는 불리언이라 프롬프트는 위치인자인데, 우리 프롬프트는 SKILL.md 전문이라
 *      **YAML frontmatter(`---`)로 시작**한다 → 대시로 시작하는 토큰이라 인자 파서가 **옵션으로 읽는다**.
 *        `claude -p "---\nname: brief" --zzz-unknown --output-format json` → `error: unknown option '---\nname: brief…'`
 *        `claude -p --zzz-unknown --output-format json -- "---\nname: brief"` → `error: unknown option '--zzz-unknown'`
 *      (뒤쪽 = 프롬프트가 피연산자로 정상 수용됐다는 증거. 미지 옵션 오류는 옵션 파싱이 **끝난 뒤** 나므로 이 대조가
 *       결정적이다 — 대조군 없이 앞쪽만 보면 오독을 놓친다.) `--` 없이 조립하면 **모든 SKILL.md 프롬프트가 첫 줄에서
 *      죽는다**. 부록A 는 프롬프트 전달 형태를 기록하지 않아 이 지점은 A 가 답을 주지 않는 자리였다.
 *   ② **variadic 플래그를 뒤에 모은다**. `--add-dir`·`--tools`·`--allowedTools`·`--disallowedTools` 는 전부
 *      `<x...>` 수집기라 뒤 토큰을 삼킨다. 실측상 수집은 다음 `-` 접두 토큰(그리고 `--`)에서 멈추므로,
 *      '값 있는 플래그들 → variadic 들 → `--` → 프롬프트' 순서면 서로를 먹지 않는다(cli-parser 가 `--tools ""` 를
 *      맨 끝에 둔 것과 같은 조심의 일반화).
 *
 * @throws 프롬프트가 비었거나 · maxTurns 가 1 이상의 정수가 아니거나 · addDirs/allowRules 가 비었거나 ·
 *         규칙/경로 토큰이 `-` 로 시작할 때.
 */
export function buildSessionArgs(input: SessionArgsInput): string[] {
  const { prompt, allowRules, disallowRules, maxTurns, addDirs } = input;

  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("프롬프트가 비어 있습니다 — skill-rewrite 의 치환 산물(SKILL.md 전문)을 넘기세요.");
  }
  // config.sdkMaxTurns 와 같은 규칙(지어내지 않는다): 읽을 수 없으면 clamp·반올림이 아니라 멈춘다.
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`--max-turns 값이 올바르지 않습니다: '${maxTurns}' — 1 이상의 정수여야 합니다(예: 50).`);
  }
  if (!Array.isArray(addDirs) || addDirs.length === 0) {
    throw new Error("addDirs 가 비어 있습니다 — buildAddDirs() 의 산물을 넘기세요(읽기 경계에 추가할 경로).");
  }
  if (!Array.isArray(allowRules) || allowRules.length === 0) {
    // 규칙 0개면 세션은 산출물만 쓰고 전이하지 못한다 — 부록A-9 1차 시도의 실패 양상(산출물은 썼는데
    //   전이 3회 거부 → next-action 정체) 그대로다. 조용히 그 상태를 만드는 대신 조립에서 끊는다.
    throw new Error(
      "allowRules 가 비어 있습니다 — 무인 세션은 전이 명령 한 줄을 통과시킬 규칙이 없으면 산출물만 쓰고 게이트에서 정체합니다. " +
        "skill-rewrite 의 도출 산물을 넘기세요.",
    );
  }

  // variadic 자리에 들어가는 caller 문자열은 **`-` 로 시작하면 안 된다**: 파서가 그 토큰을 옵션으로 읽어
  //   ① 수집을 조기 종료(= 뒤 규칙들이 조용히 누락 = 경계가 의도와 달라짐) ② 최악의 경우 그 토큰 자체가
  //   플래그로 해석된다(`--dangerously-skip-permissions` 를 규칙인 척 흘려보내는 길). 조립에서 끊는다.
  for (const [label, values] of [
    ["--add-dir", addDirs],
    ["--allowedTools", allowRules],
    ["--disallowedTools", disallowRules],
  ] as const) {
    for (const v of values) {
      if (typeof v !== "string" || v === "") {
        throw new Error(`${label} 항목이 비어 있습니다 — 빈 토큰은 인자 위치를 밀어 조립을 어긋나게 합니다.`);
      }
      if (v.startsWith("-")) {
        throw new Error(
          `${label} 항목은 '-' 로 시작할 수 없습니다: '${v}' — 인자 파서가 이 토큰을 옵션으로 읽어 뒤 항목을 누락시키거나 ` +
            "플래그로 실행합니다(경계가 조용히 달라집니다).",
        );
      }
    }
  }

  return [
    "-p",
    // 봉투(JSON)로 받아야 러너가 결과·비용·permission_denials 를 읽는다(도구 흔적 = 경계가 하중을 받은 증거).
    "--output-format",
    "json",
    "--permission-mode",
    SESSION_PERMISSION_MODE,
    "--max-turns",
    String(maxTurns),
    /**
     * 설정 소스 = `user` 하나(모듈 상단 '설정 소스' 절). 격리 CONFIG_DIR 는 **user 설정만** 옮기므로 이 핀이 없으면
     *   레포의 `.claude/settings.local.json`(= 사람이 '허용'을 누를 때마다 자라는 파일)이 무인 세션 권한에 병합된다.
     *   `<sources>` 는 variadic 이 아니라 **단일 콤마목록 값**이라 variadic 구간 앞에 두어도 뒤 토큰을 삼키지 않는다.
     */
    "--setting-sources",
    SESSION_SETTING_SOURCES,
    /**
     * MCP 서버 0개 — `--mcp-config` 를 **주지 않은 채** 이 플래그를 켜면 '설정에서 온 MCP 전부 무시'가 된다.
     *   `--tools` 는 빌트인만 제한하므로 이게 없으면 `core/.mcp.json` 이 도구 표면에 붙을 수 있다(불리언 = 값 없음).
     */
    "--strict-mcp-config",
    // 여기부터 variadic — 각각 다음 `-` 접두 토큰에서 멈춘다(위 순서 규약 ②).
    "--add-dir",
    ...addDirs,
    "--tools",
    SESSION_TOOLS,
    /**
     * 규칙 **1건 = argv 토큰 1개**로 넘긴다.
     *
     * ⚠ **미실측 — W5 카나리 확인 필요**: 부록A 는 `--allowedTools` 에 **여러 규칙을 어떤 형태로 넘겼는지
     *   기록하지 않았다**(한 토큰에 공백으로 이어붙였는지 · 규칙마다 토큰을 나눴는지 · 플래그를 반복했는지).
     *   A-9 가 확인해 준 건 '두 규칙이 실제로 매칭됐다'는 결과뿐이다. 그러니 이 선택은 실측이 아니라 **판단**이다:
     *     · 우리 규칙은 **내부에 공백이 있다**(`Bash(bash /abs/scripts/run-stage.sh brief rid)`). 한 토큰에
     *       이어붙이면 규칙 내부 공백과 구분자 공백을 CLI 가 무엇으로 가르는지에 경계를 맡기게 된다.
     *     · A-9 는 공백 포함 규칙 하나가 **온전히 매칭**됐음을 보였다(전이 성공) = 토큰 내부 공백으로 규칙을
     *       쪼개지는 않는다. 그렇다면 토큰을 나누는 쪽이 '구분자 해석'을 CLI 에 넘기지 않는 유일한 형태다.
     *   다만 **여러 토큰을 각각 독립 규칙으로 읽는지**는 라이브에서만 확인된다. 틀리면 전이가 거부되고
     *   next-action 이 정체해 드러난다(= 조용한 통과가 아니라 fail-closed) — W5 무인 완주가 그 카나리다.
     */
    "--allowedTools",
    ...allowRules,
    ...(disallowRules.length > 0 ? ["--disallowedTools", ...disallowRules] : []),
    // `--` 가 옵션 파싱을 끝낸다 → 뒤의 프롬프트는 frontmatter 로 시작해도 피연산자로 안전하게 수용된다(위 ①).
    "--",
    prompt,
  ];
}

/** 세션 1건을 띄우는 데 필요한 전부(러너가 이걸 그대로 소비한다 — 축을 빠뜨릴 여지를 없앤다). */
export interface SessionPlan {
  /** `claude` 에 넘길 argv. */
  argv: string[];
  /** spawn cwd = 읽기 경계(`<coreRoot>/runs/<rid>`). */
  cwd: string;
  /** spawn env(위생 재구성 + 격리 CONFIG_DIR + OAuth). */
  env: Record<string, string>;
  /** 격리 CONFIG_DIR 에 쓸 settings 내용·경로(쓰기는 러너의 몫 — 이 모듈은 순수). */
  settings: WorkerSettings;
  settingsJson: string;
  settingsPath: string;
  /** 조립에 쓰인 add-dir(관측·로그용). */
  addDirs: string[];
}

export interface SessionPlanInput {
  /** core(하네스) 체크아웃 절대경로(config.harnessRoot()). */
  coreRoot: string;
  /** 이 잡의 run_id. */
  rid: string;
  /** state.json 에 사람이 선언한 규제도메인(팩 선택 키) — 이 세션이 볼 수 있는 팩은 이것 하나뿐이다. */
  domain: string;
  /** skill-rewrite 의 치환 산물. */
  prompt: string;
  /** skill-rewrite 의 도출 규칙. */
  allowRules: string[];
  /** config.sdkMaxTurns(). */
  maxTurns: number;
  /** 워커가 이 잡용으로 만든 전용 빈 디렉터리(절대경로). 생성·정리는 러너의 몫. */
  configDir: string;
  /** 구독 인증 토큰(chat/.env 의 CLAUDE_CODE_OAUTH_TOKEN). 없으면 세션은 인증 실패로 죽는다(A-8). */
  oauthToken?: string;
  /** 위생 재구성의 base(보통 process.env). 이 모듈은 process.env 를 직접 읽지 않는다 — 순수 유지. */
  baseEnv: NodeJS.ProcessEnv;
}

/**
 * 세션 1건 조립의 단일 진입점 — 부록A-9 의 축을 **한 번에** 묶는다.
 *
 * 왜 조립기를 따로 두나: 축이 하나라도 빠지면 경계가 조용히 약해진다(add-dir 를 빠뜨리면 세션이 못 읽어 시끄럽게
 *   실패하지만, **settings 를 빠뜨리면 state 쓰기 금지가 사라지고 아무 소리도 안 난다**). 러너가 축을 손으로
 *   재조립하지 않도록 여기서 한 덩이로 돌려준다 — '경계를 정하는 자리는 한 곳'이라는 이 모듈의 존재 이유 그대로다.
 */
export function buildSessionPlan(input: SessionPlanInput): SessionPlan {
  const cwd = buildRunCwd({ coreRoot: input.coreRoot, rid: input.rid });
  const addDirs = buildAddDirs({ coreRoot: input.coreRoot, domain: input.domain });
  const settings = buildWorkerSettings({ runDir: cwd, addDirs });
  const argv = buildSessionArgs({
    prompt: input.prompt,
    allowRules: input.allowRules,
    disallowRules: buildDisallowedTools(input.coreRoot),
    maxTurns: input.maxTurns,
    addDirs,
  });
  const env = buildSessionEnv(input.baseEnv, {
    configDir: input.configDir,
    ...(input.oauthToken !== undefined ? { oauthToken: input.oauthToken } : {}),
  });
  return {
    argv,
    cwd,
    env,
    settings,
    settingsJson: serializeWorkerSettings(settings),
    settingsPath: join(input.configDir, WORKER_SETTINGS_FILENAME),
    addDirs,
  };
}
