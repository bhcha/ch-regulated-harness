/**
 * skill-rewrite.ts — SKILL.md 결정론 치환 + allow 규칙 도출(순수).
 *
 * 무인 `claude` 세션이 한 단계를 생성할 때, **프롬프트와 `--allowedTools` 경계는 한 출처에서 나와야 한다**.
 *   이 모듈이 그 출처다: `skills/<stage>/SKILL.md` 원문을 결정론적으로 치환해 프롬프트를 만들고,
 *   **같은 치환 산물에서** allow 규칙을 도출한다. 둘이 갈라지면 경계가 무너지거나 세션이 정체한다.
 *
 * 왜 이 설계인가(계획 부록A 실측 — 이 모듈의 존재 이유):
 *   · **부록A-10**: 프리앰블(프롬프트)로 모델의 명령 형태를 교정하려는 시도는 **실패했다**.
 *     brief 는 프리앰블을 따랐는데 intake 는 무시하고 SKILL.md 원문을 그대로 타이핑했다 —
 *     즉 모델의 명령 형태는 **실행마다 비결정적**이라 '프롬프트 준수' 위에 경계를 세울 수 없다.
 *     → 워커가 원문을 **결정론적으로 치환**하고 규칙을 그 산물에서 뽑는다(손으로 문자열을 짜지 않는다).
 *   · **부록A-9**: allow 규칙은 "워커가 선호하는 형태"가 아니라 **스킬이 모델에게 타이핑하라고 시킨 문자열**이어야 한다.
 *     `HARNESS_CLI=… HARNESS_GEN_MODE=insession bash …` 접두를 뺀 규칙을 썼더니 매칭 실패로 전이가 3회 거부됐다
 *     (산출물은 썼는데 전이만 실패 → next-action 정체). **env 접두는 원문 그대로 보존한다**.
 *     ⚠ 단 이 보존은 **실측된 접두 목록**(ENV_PREFIX_SEQUENCE)에 한한다 — '임의 env 허용'이 아니다.
 *     임의 env 를 통과시키면 `BASH_ENV=…` 로 run-stage **실행 전에** 임의 파일이 source 돼,
 *     허용된 run-stage 한 줄 뒤에서 승인 게이트를 자동 통과시킬 수 있다(아래 ENV_PREFIX_SEQUENCE 주석).
 *   · **부록A-10**: 치환은 **절대경로**로 한다. 상대경로를 주면 모델이 깊이를 오산해(`../../` → `../../../../`)
 *     전이 전 10건이 거부됐다. 절대경로 실측 = **2턴·거부 0·첫 시도 성공**(모델이 셈할 게 없으니 문서대로 타이핑한다).
 *     ⚠ 부록A-9 표의 상대경로 예시는 **A-10 이 대체**했다 — 상대경로 규칙을 부활시키지 말 것.
 *   · **부록A-11**: 단계별 보조 도구는 **실측으로만** 추가한다(파싱으로 늘리지 않는다) — 아래 AUX_ALLOW_RULES.
 *
 * 호출부 계약(중요):
 *   · `unexpectedFencedCommands` 가 비어있지 않으면 **호출부는 그 잡을 거부해야 한다**(noisy failure).
 *     이 모듈은 그것을 규칙으로 승격하지 않고 **보고만** 한다 — 펜스에 새 명령이 생겼다는 건 SKILL.md 가
 *     변했다는 뜻이고, 그 명령이 무인 세션에 필요한지는 **실측으로 판단할 사람의 몫**이다(부록A-11 3번).
 *     조용히 허용하면 경계가 파싱 결과에 따라 저절로 넓어진다 = 잠긴 결정 2(경계는 프롬프트에 의존하지 않는다)와 충돌.
 *   · 이 모듈은 **순수**다 — 파일을 읽지도 쓰지도 않고 프로세스를 띄우지도 않는다(SKILL.md 내용은 인자로 받는다).
 *     같은 입력 → 바이트 동일 출력. 경계가 실행마다 흔들리면 그 경계는 무효다.
 *
 * 파싱 범위(의도적으로 좁다):
 *   명령 도출은 **```bash 로 태그된 펜스 안**만 본다. core/skills/ 전체가 이 관례를 지킨다(펜스 오프너 25/25 = ```bash).
 *   인용문(`>`)·인라인 백틱은 **산문**이라 도출 대상이 아니다 — 실제로 두 SKILL.md 의 함정이 전부 그 형태다
 *   (intake 의 stub 명령·brief 의 헤드리스 대안·kcia-check 안내). 도출에서 빠진 명령이 '허용'되는 일은 없다
 *   (allow 는 양성 목록이라 미도출 = 미허용 = 안전한 방향의 실패).
 */
import { isAbsolute, join } from "node:path";

// run_id 안전 판정은 config 의 단일 규칙을 재사용한다(중복 정의 금지 — kernel/job-protocol.ts 도 같은 것을 쓴다).
//   rid 는 아래에서 **allow 규칙 문자열에 그대로 박히므로**, 공백·셸 메타문자가 섞이면 규칙이 깨지거나
//   경계가 의도보다 넓어질 수 있다(주입면). config 규칙(영숫자·`.`·`_`·`-`)이 그 위험을 이미 차단한다.
import { isSafeRunId } from "../config.js";

/**
 * 무인화 대상 단계 — **실측 근거가 있는 것만**(부록A-9 brief · A-10 intake 무인 완주 통과).
 *   concept·storyboard 는 미측정이라 편입 전 각 1회 dry-run 이 필요하다(계획 부록A-11).
 */
export const SUPPORTED_STAGES = ["intake", "brief"] as const;
export type SupportedStage = (typeof SUPPORTED_STAGES)[number];

/**
 * 단계별 보조 도구 규칙 — **실측 수확물**(부록A-11 3번). 파싱으로 도출하지 않는다.
 *   intake: 첨부 sha256 정합 검증에 `shasum` 이 필요했다(없어서 4형태가 거부됨 — 부록A-10 표).
 *   brief : 불필요(실측). 빈 배열이 '아직 안 채움'이 아니라 **측정 결과**임을 명시한다.
 */
export const AUX_ALLOW_RULES: Record<SupportedStage, readonly string[]> = {
  intake: ["Bash(shasum:*)"],
  brief: [],
};

/** SKILL.md 원문의 상대 호출 형태(치환 대상) — core/skills 관례상 항상 `bash scripts/run-stage.sh`. */
const RUN_STAGE_INVOCATION = "bash scripts/run-stage.sh";
/** run-stage 스크립트의 core 상대 경로(절대경로 조립용). */
const RUN_STAGE_RELPATH = ["scripts", "run-stage.sh"] as const;
/** SKILL.md 의 run_id 자리표시자. */
const RUN_PLACEHOLDER = "<RUN>";
/** 읽기전용 입력 로드 호출을 가르는 플래그(전이 명령 판별에 사용). */
const EMIT_CONTEXT_FLAG = "--emit-context";

/**
 * 셸 조합 문자 — 하나라도 있으면 그 명령은 규칙이 될 수 없다.
 *   allow 규칙은 '한 줄 정확 문자열' 매칭이라 파이프·연쇄·치환이 섞이면 결박 자체가 성립하지 않고,
 *   `(`·`)` 는 `Bash(...)` 규칙 문법을 깨뜨린다. 실측에서도 모델의 파이프 시도(`… | head -5`)는 거부됐다(부록A-10).
 *   치환되지 않은 자리표시자(`<FOO>`)도 여기 걸려 fail-closed 된다 — 자리표시자 드리프트의 안전망.
 */
const SHELL_METACHARS = /[|&;<>()`$\\'"]/;

/**
 * 허용되는 env 접두 — **이름 패턴이 아니라 `NAME=VALUE` 리터럴의 정확 목록**이자 그 **정본 순서**다.
 *
 * 부록A-9 가 "접두를 원문 그대로 보존하라"고 요구한 건 실측된 **이 두 쌍**이지 '임의의 env' 가 아니다.
 *   접두를 이름 패턴(`^[A-Za-z_]\w*=`)으로 열어두면 아래가 '정상 전이'로 분류돼 규칙이 된다:
 *
 *     BASH_ENV=<run 디렉터리>/.boot bash <절대>/scripts/run-stage.sh brief r1
 *
 *   bash 는 run-stage 를 실행하기 **전에** `BASH_ENV` 가 가리키는 파일을 source 한다. 거기에
 *   `trap 'bash …/approve.sh r1 --ra-ok' EXIT` 한 줄이면 사람의 승인 게이트와 RA 확인이 함께 자동 통과되는데,
 *   밖에서 보이는 도구 호출은 **허용된 run-stage 한 줄뿐**이다 — 즉 펜스 안 `approve.sh` 를 거부하는 필터를
 *   **간접 등가물로 우회**한다. 결정은 사람의 몫이고(AGENTS 5번 절) 그 경계는 코드가 보장해야 한다.
 *   같은 부류: `ENV`·`LD_PRELOAD`·`PATH`·`SHELLOPTS`·`IFS`·`BASH_FUNC_*=`.
 *   → 목록 밖 접두가 붙으면 규칙이 아니라 '예상 밖'으로 보고한다(fail-closed).
 *
 * **값까지** 고정하는 이유: 이름만 맞으면 통과시키면 `HARNESS_CLI=stub`(CI 전용 — AGENTS 2번 절)이나
 *   `HARNESS_GEN_MODE=subprocess`(폐기된 세션 밖 헤드리스 생성)가 무인 세션에 새어든다.
 *   실제로 skills 코퍼스에는 `HARNESS_GEN_MODE=subprocess`·`HARNESS_IMAGE_CLI=nanobanana`·`HARNESS_OFFLINE=1` 이
 *   존재하지만, **지원 단계(intake·brief)의 도출 대상 명령이 쓰는 건 아래 둘뿐이다**(원문 실측).
 *   코퍼스에 있다는 이유로 통째 허용하지 않는다 — 허용은 실측이 요구한 만큼만.
 *
 * **순서·중복**까지 고정하는 이유: 리터럴이 고정이라 순서를 바꿔도 결과 env 는 같아 그 자체가 위험하진 않다.
 *   다만 지원 단계의 원문은 정확히 이 순서이고, 일탈은 **SKILL.md 가 변했다는 신호**다 —
 *   조용히 흡수하면 경계가 파싱 결과를 따라 저절로 넓어진다. 새 형태의 채택 여부는 실측할 사람의 몫이다(부록A-11 3번).
 */
const ENV_PREFIX_SEQUENCE = ["HARNESS_CLI=claude", "HARNESS_GEN_MODE=insession"] as const;

/**
 * 명령 앞의 env 접두를 소비하고 **다음 토큰의 인덱스**를 돌려준다.
 *   허용 = ENV_PREFIX_SEQUENCE 의 순서를 지키는 **부분 수열**(중복 없음). 접두가 아예 없어도 된다(`--emit-context` 줄).
 *   목록 밖·순서 역전·중복을 만나면 **거기서 멈춘다** — 그러면 호출부의 `tokens[i] !== "bash"` 검사에 걸려
 *   그 명령은 규칙 자격을 잃는다(별도 예외를 던지지 않아도 fail-closed 로 수렴한다).
 */
function consumeEnvPrefix(tokens: string[]): number {
  let i = 0;
  let nextAllowed = 0; // 다음에 올 수 있는 정본 위치 — 순서 강제 + 같은 쌍의 재등장(중복) 차단.
  while (i < tokens.length) {
    const at = (ENV_PREFIX_SEQUENCE as readonly string[]).indexOf(tokens[i]);
    if (at < 0 || at < nextAllowed) break;
    nextAllowed = at + 1;
    i++;
  }
  return i;
}

/** 마크다운 펜스 오프너/클로저(리스트 항목 안이라 들여쓰기가 있을 수 있어 trim 후 판정). */
const FENCE_OPEN = /^```(\S*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

export interface RewriteSkillInput {
  /** `skills/<stage>/SKILL.md` 원문(읽기는 호출부의 일 — 이 모듈은 순수). */
  skillMd: string;
  /** 단계명(SUPPORTED_STAGES 중 하나). */
  stage: string;
  /** 실제 run_id — `<RUN>` 자리에 박힌다. */
  rid: string;
  /** core 체크아웃 **절대경로**. 상대경로는 cwd 의존이라 거부(결정론 위반). */
  coreRoot: string;
}

export interface RewrittenSkill {
  /** 무인 세션에 그대로 넘길 프롬프트 = 치환된 SKILL.md 전문(프리앰블을 덧붙이지 않는다 — 부록A-10). */
  prompt: string;
  /** `--allowedTools` 에 넘길 규칙 = 도출 규칙(문서 순서) + 실측 보조 도구 규칙. */
  allowRules: string[];
  /** 치환된 전이 명령 한 줄(복구 세션이 정확히 이 문자열을 필요로 한다). */
  transitionCommand: string;
  /** 펜스 안인데 run-stage 호출이 아닌 명령들 — **보고 전용**. 비어있지 않으면 호출부가 거부해야 한다. */
  unexpectedFencedCommands: string[];
}

/** 단계 지원 판정 — keyvisual 은 별도 메시지로 먼저 가른다(원인이 다르다: 미측정이 아니라 구조적 부재). */
function assertSupportedStage(stage: string): asserts stage is SupportedStage {
  if (stage === "keyvisual") {
    throw new Error(
      "keyvisual 은 무인 세션으로 돌릴 수 없습니다(계획 W0 미해결 3번) — 이 단계가 쓰는 도구들의 " +
        "타입드 도구 대응물이 존재하지 않아, 재설계 없이는 무인 편입이 불가능합니다. 사람 소비자로 남깁니다.",
    );
  }
  if (!(SUPPORTED_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `무인 지원 단계가 아닙니다: '${stage}'. 지원 = ${SUPPORTED_STAGES.join(" · ")} ` +
        "(부록A-11 — 무인 완주 실측이 있는 단계만 편입합니다. 새 단계는 dry-run 1회로 먼저 측정하세요).",
    );
  }
}

/** core 절대경로 검증 + run-stage 절대경로 조립. */
function resolveRunStagePath(coreRoot: string): string {
  if (typeof coreRoot !== "string" || coreRoot.trim() === "") {
    throw new Error("coreRoot 가 필요합니다 — core(하네스) 체크아웃 절대경로를 넘기세요.");
  }
  if (!isAbsolute(coreRoot)) {
    throw new Error(
      `coreRoot 는 절대경로여야 합니다(받은 값: '${coreRoot}'). 상대경로는 cwd 에 따라 결과가 달라져 ` +
        "치환 결정론이 깨지고, 부록A-10 실측상 모델이 상대경로 깊이를 오산해 명령이 거부됩니다.",
    );
  }
  if (/\s/.test(coreRoot) || SHELL_METACHARS.test(coreRoot)) {
    throw new Error(`coreRoot 에 공백·셸 메타문자를 쓸 수 없습니다(allow 규칙 문자열이 깨집니다): '${coreRoot}'`);
  }
  return join(coreRoot, ...RUN_STAGE_RELPATH);
}

/** 펜스 안에서 뽑아낸 논리 명령 한 건. */
interface FencedCommand {
  /** 치환 후 논리 명령(백슬래시 연속행은 한 줄로 결합). */
  command: string;
  /** 이 논리 명령이 몇 개의 물리 줄로 쓰였나 — 2 이상이면 규칙 결박이 불가능하다(아래 참조). */
  physicalLines: number;
}

/**
 * ```bash 펜스 안의 명령만 순서대로 수집한다(치환된 텍스트 기준).
 *   · 인용문 안 펜스(`> ```)는 trim 후에도 `>` 로 시작해 오프너에 걸리지 않는다 — 자연히 제외된다.
 *   · 백슬래시 연속행은 한 논리 명령으로 결합하되 physicalLines 로 흔적을 남긴다(분류에서 fail-closed).
 */
function collectFencedBashCommands(text: string): FencedCommand[] {
  const out: FencedCommand[] = [];
  let inFence = false;
  let isBashFence = false;
  let pending: string[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    out.push({ command: pending.join(" "), physicalLines: pending.length });
    pending = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (!inFence) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        inFence = true;
        isBashFence = open[1] === "bash";
      }
      continue;
    }

    if (FENCE_CLOSE.test(line)) {
      // 닫히지 않은 연속행(끝이 `\`)이 남아있으면 그대로 흘려보낸다 → 분류에서 '예상 밖'이 된다.
      flushPending();
      inFence = false;
      isBashFence = false;
      continue;
    }
    if (!isBashFence) continue;

    // 빈 줄·주석은 명령이 아니다(다만 연속행 중간이라면 그 연속은 끊긴 것으로 본다).
    if (line === "" || line.startsWith("#")) {
      flushPending();
      continue;
    }
    if (line.endsWith("\\")) {
      pending.push(line.slice(0, -1).trim());
      continue;
    }
    pending.push(line);
    flushPending();
  }
  flushPending(); // 펜스가 안 닫힌 문서도 조용히 삼키지 않는다.
  return out;
}

/**
 * 이 논리 명령이 '이 단계의 run-stage 호출'로서 규칙이 될 자격이 있는가.
 *
 * 통과 조건(전부 만족해야 한다 — 하나라도 어긋나면 규칙이 아니라 '예상 밖'으로 보고):
 *   ① 물리 줄 1개  — allow 규칙은 한 줄 정확 문자열이라 여러 줄 명령은 결박 불가.
 *   ② 셸 메타문자 없음 — 파이프·연쇄가 섞이면 경계가 무의미해진다.
 *   ③ `bash <절대 run-stage 경로>` 로 시작(env 접두는 **허용 목록 안일 때만** 허용·보존) — 치환을 비껴간 **상대경로 호출은 거부**한다.
 *      (치환 패턴은 `bash scripts/run-stage.sh` 리터럴이라, 원문이 `sh …`·`./scripts/…` 로 드리프트하면
 *       상대경로가 남는데 그걸 규칙으로 승격하면 부록A-10 이 금지한 바로 그 형태가 된다.)
 *   ④ 스크립트 다음 토큰 = 이 단계명, 그 다음 토큰 = 이 rid — 남의 단계·남의 런을 건드리는 형태는 규칙이 아니다.
 *   ⑤ 나머지 토큰은 `--flag` 형태만.
 */
function isDerivableRunStageCommand(cmd: FencedCommand, absRunStage: string, stage: string, rid: string): boolean {
  if (cmd.physicalLines !== 1) return false;
  if (SHELL_METACHARS.test(cmd.command)) return false;

  const tokens = cmd.command.split(/\s+/);
  // env 접두는 **허용 목록에 있는 리터럴만** 소비·보존한다(부록A-9 는 이 두 쌍을 요구했지 임의 env 를 허용한 게 아니다).
  //   목록 밖 접두(BASH_ENV·LD_PRELOAD·PATH…)는 소비되지 않고 남아 바로 아래 `bash` 검사에서 걸린다.
  let i = consumeEnvPrefix(tokens);
  if (tokens[i] !== "bash") return false;
  i++;
  if (tokens[i] !== absRunStage) return false;
  i++;
  if (tokens[i] !== stage) return false;
  i++;
  if (tokens[i] !== rid) return false;
  i++;
  return tokens.slice(i).every((t) => t.startsWith("--"));
}

/**
 * SKILL.md 를 결정론적으로 치환하고 그 산물에서 allow 규칙을 도출한다.
 *
 * @throws 미지원 단계 · 안전하지 않은 rid · 비-절대 coreRoot · 전이 명령이 정확히 1개가 아닌 경우.
 */
export function rewriteSkill(input: RewriteSkillInput): RewrittenSkill {
  const { skillMd, stage, rid, coreRoot } = input;

  assertSupportedStage(stage);
  if (!isSafeRunId(rid)) {
    throw new Error(
      `run_id 가 안전한 토큰이 아닙니다: '${rid}'. 영숫자·'.'·'_'·'-' 만 허용합니다 ` +
        "(이 값은 allow 규칙 문자열에 그대로 박히므로 공백·셸 메타문자는 경계를 훼손합니다).",
    );
  }
  if (typeof skillMd !== "string" || skillMd.trim() === "") {
    throw new Error(`SKILL.md 원문이 비어있습니다(stage=${stage}) — 읽기는 호출부의 일입니다.`);
  }
  const absRunStage = resolveRunStagePath(coreRoot);

  // ① 상대 호출 → 절대경로(부록A-10) ② <RUN> → 실제 rid. split/join = 리터럴 전역 치환(정규식 이스케이프 불필요).
  //   치환은 **문서 전체**에 적용한다(산문의 안내 명령도 절대경로가 돼야 거짓말이 되지 않는다).
  //   선별은 아래 '규칙 도출' 단계의 일이지 치환의 일이 아니다 — 두 관심사를 섞지 않는다.
  const prompt = skillMd
    .split(RUN_STAGE_INVOCATION)
    .join(`bash ${absRunStage}`)
    .split(RUN_PLACEHOLDER)
    .join(rid);

  const derived: string[] = [];
  const unexpectedFencedCommands: string[] = [];
  const transitions: string[] = [];

  for (const cmd of collectFencedBashCommands(prompt)) {
    if (!isDerivableRunStageCommand(cmd, absRunStage, stage, rid)) {
      unexpectedFencedCommands.push(cmd.command);
      continue;
    }
    derived.push(cmd.command);
    // 전이 = 상태를 쓰는 호출. `--emit-context` 는 읽기전용 입력 로드라 전이가 아니다.
    if (!cmd.command.split(/\s+/).includes(EMIT_CONTEXT_FLAG)) transitions.push(cmd.command);
  }

  if (transitions.length !== 1) {
    throw new Error(
      `SKILL.md(stage=${stage})에서 전이 명령을 정확히 1개 찾지 못했습니다(찾은 개수: ${transitions.length}). ` +
        "무인 세션은 산출물을 쓴 뒤 이 한 줄로 검증·전이해야 하고, 복구 세션도 정확히 같은 문자열을 씁니다 — " +
        "0개면 세션이 산출물만 쓰고 게이트가 정체하고, 2개 이상이면 어느 것이 그 한 줄인지 확정할 수 없습니다. " +
        "SKILL.md 의 전이 단계가 바뀌었는지 확인하세요(스킬-게이트 드리프트).",
    );
  }

  // 도출 규칙(문서 순서) + 실측 보조 도구. 중복은 제거하되 첫 등장 순서를 보존한다(결정론).
  const allowRules = [...new Set([...derived.map((c) => `Bash(${c})`), ...AUX_ALLOW_RULES[stage]])];

  return { prompt, allowRules, transitionCommand: transitions[0], unexpectedFencedCommands };
}
