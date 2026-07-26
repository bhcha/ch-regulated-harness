/**
 * skill-rewrite.test.ts — SKILL.md 결정론 치환 + allow 규칙 도출의 회귀 가드.
 *
 * 이 스위트가 지키는 것(계획 부록A-9·A-10·A-11 실측):
 *   1. 치환 결정론 — 같은 입력 → 바이트 동일 산출(경계가 실행마다 흔들리면 안 된다).
 *   2. 선별성 — 인용문·인라인 백틱·비-run-stage 펜스는 **절대 allow 규칙이 되지 않는다**.
 *      특히 결정 명령(approve/select/revise)은 사람의 몫이라(AGENTS 5번 절) 규칙화 자체가 금지다.
 *   3. 결박 핀 — 실제 SKILL.md 원문에서 도출한 규칙 문자열을 **리터럴로 못박는다**(R-3 조기경보).
 *   4. fail-closed — keyvisual·미지원 단계는 예외.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AUX_ALLOW_RULES, SUPPORTED_STAGES, rewriteSkill } from "../../src/worker/skill-rewrite.js";

/**
 * 합성 픽스처의 coreRoot·rid 는 **고정 상수**다 — 절대경로 치환 결과를 리터럴로 단언하려면
 *   머신마다 달라지는 실제 경로를 쓰면 안 된다(CI·타 머신에서 오실패). 모듈은 순수(경로를 열지 않는다)라
 *   실재하지 않는 절대경로여도 무해하다.
 */
const FIXED_CORE = "/abs/core";
const FIXED_RID = "pin-rid-0716";

/** 형제 core 체크아웃(모노레포 배치: chat/ 와 core/ 는 형제). 결박 핀이 **원문**을 읽어야 하므로 실경로. */
const REAL_CORE = join(dirname(fileURLToPath(import.meta.url)), "../../../core");
const realSkill = (stage: string): string => readFileSync(join(REAL_CORE, "skills", stage, "SKILL.md"), "utf8");

/**
 * 합성 적대 픽스처 — 실제 SKILL.md 가 가진 '함정' 형태를 한 문서에 모았다.
 *   배열로 조립하는 이유: 마크다운 펜스(백틱 3개)를 템플릿 리터럴에 넣으면 이스케이프 지옥이 되고,
 *   리스트 항목 안 펜스의 **들여쓰기 3칸**(실제 SKILL.md 관례)을 눈에 보이게 고정하려는 목적도 있다.
 */
const ADVERSARIAL_LINES = [
  "---",
  "name: fixture",
  "---",
  "# /fixture — 합성 적대 픽스처",
  "",
  "> 함정①(인용문 + 인라인 백틱): 헤드리스로 돌리려면 `HARNESS_CLI=claude bash scripts/run-stage.sh brief <RUN>`",
  "",
  "함정②(인라인 백틱): 다음은 `bash scripts/kcia-check.sh <RUN>` 로 심의한다.",
  "",
  "1. **입력·지침 로드(읽기전용):**",
  "   ```bash",
  "   bash scripts/run-stage.sh brief <RUN> --emit-context",
  "   ```",
  "",
  "2. **함정③(펜스 안 결정 명령 — 사람의 몫이라 규칙화 금지):**",
  "   ```bash",
  "   bash scripts/approve.sh <RUN>",
  "   ```",
  "",
  "3. **검증·전이:**",
  "   ```bash",
  "   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
  "   ```",
  "",
  "> 금지: `select.sh`/`approve.sh`/`revise.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).",
];
const ADVERSARIAL = ADVERSARIAL_LINES.join("\n");

const rewriteAdversarial = () =>
  rewriteSkill({ skillMd: ADVERSARIAL, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

describe("선별성 — 펜스 밖 명령은 규칙이 되지 않는다(경계의 핵심)", () => {
  it("인용문·인라인 백틱 명령은 allow 규칙이 되지 않는다", () => {
    const { allowRules } = rewriteAdversarial();

    // 함정①: 인용문 안 헤드리스 형태(접두가 다름)가 규칙으로 새면 경계가 넓어진다.
    expect(allowRules).not.toContain(`Bash(HARNESS_CLI=claude bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID})`);
    // 함정②: 심의는 생성과 다른 엔진(별 프로세스)이라 무인 생성 세션에 절대 허용되면 안 된다.
    expect(allowRules.some((r) => r.includes("kcia-check"))).toBe(false);
  });

  it("펜스 안이어도 결정 명령(approve.sh)은 규칙이 아니라 '예상 밖'으로만 보고된다", () => {
    const { allowRules, unexpectedFencedCommands } = rewriteAdversarial();

    // 승인은 사람의 몫(AGENTS 5번 절) — 어떤 경로로도 allow 규칙이 될 수 없다.
    expect(allowRules.some((r) => r.includes("approve.sh"))).toBe(false);
    // 다만 조용히 버리지 않는다 — 호출부가 거부(noisy failure)할 수 있도록 그대로 보고한다.
    expect(unexpectedFencedCommands).toEqual([`bash scripts/approve.sh ${FIXED_RID}`]);
  });

  it("규칙은 펜스 안 run-stage 호출 2개(입력 로드·전이)뿐이다", () => {
    const { allowRules, transitionCommand } = rewriteAdversarial();

    expect(allowRules).toEqual([
      `Bash(bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID} --emit-context)`,
      `Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID})`,
    ]);
    expect(transitionCommand).toBe(
      `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    );
  });

  it("치환 자체는 문서 전체에 적용된다(선별은 '규칙 도출' 단계의 일이다)", () => {
    const { prompt } = rewriteAdversarial();

    // 인용문의 run-stage 도 절대경로로 치환된다(산문이 거짓이 되지 않게) — 그런데도 규칙은 아니다(위 테스트).
    expect(prompt).toContain(`HARNESS_CLI=claude bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`);
  });
});

describe("치환 결정론(부록A-10 — 프리앰블 교정이 아니라 원문 치환)", () => {
  it("같은 입력 → 바이트 동일 산출", () => {
    const a = rewriteAdversarial();
    const b = rewriteAdversarial();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("<RUN> 자리표시자가 하나도 남지 않는다", () => {
    const { prompt, allowRules, transitionCommand } = rewriteAdversarial();
    expect(prompt).not.toContain("<RUN>");
    expect(allowRules.join("\n")).not.toContain("<RUN>");
    expect(transitionCommand).not.toContain("<RUN>");
  });

  it("스크립트 경로는 절대경로다(상대경로 잔존 0 — 부록A-10: 상대경로는 깊이 오산으로 10건 거부)", () => {
    const { allowRules, transitionCommand } = rewriteAdversarial();
    for (const rule of allowRules.filter((r) => r.includes("run-stage.sh"))) {
      expect(rule).toContain(`${FIXED_CORE}/scripts/run-stage.sh`);
      expect(rule).not.toMatch(/(?:\.\.\/|\s)scripts\/run-stage\.sh/);
    }
    expect(transitionCommand).toContain(`${FIXED_CORE}/scripts/run-stage.sh`);
  });

  it("coreRoot 는 절대경로여야 한다(상대경로 = cwd 의존 = 비결정)", () => {
    expect(() => rewriteSkill({ skillMd: ADVERSARIAL, stage: "brief", rid: FIXED_RID, coreRoot: "core" })).toThrow(
      /절대경로/,
    );
  });

  it("rid 는 안전 토큰만 — 규칙 문자열에 주입될 수 있으므로 fail-closed", () => {
    expect(() =>
      rewriteSkill({ skillMd: ADVERSARIAL, stage: "brief", rid: "x && rm -rf /", coreRoot: FIXED_CORE }),
    ).toThrow(/run_id/);
  });
});

/**
 * 결박 핀(R-3 조기경보) — **실제** SKILL.md 원문에서 도출한 규칙을 리터럴로 못박는다.
 *
 * ⚠ core/skills/{intake,brief}/SKILL.md 의 명령 줄이 바뀌면 이 테스트는 **깨져야 한다**.
 *   그것이 이 핀의 존재 이유다(스킬-게이트 드리프트 조기 발견 — 부록A-9 교훈: 명령 문자열을 정하는 건
 *   프롬프트인데 allow 규칙이 그걸 못 따라가면 전이가 조용히 거부되고 무인 세션이 정체한다).
 *   깨지면 '테스트를 고치는' 게 아니라 SKILL.md 변경이 의도된 것인지 먼저 확인한다.
 */
describe("결박 핀 — 실제 SKILL.md ↔ allow 규칙(R-3 드리프트 알람)", () => {
  it("brief: 원문에서 도출한 규칙이 정확히 이 2개다", () => {
    const out = rewriteSkill({ skillMd: realSkill("brief"), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([
      "Bash(bash /abs/core/scripts/run-stage.sh brief pin-rid-0716 --emit-context)",
      "Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash /abs/core/scripts/run-stage.sh brief pin-rid-0716)",
    ]);
    expect(out.transitionCommand).toBe(
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash /abs/core/scripts/run-stage.sh brief pin-rid-0716",
    );
    // brief 는 보조 도구가 필요 없었다(부록A-11 3번 실측).
    expect(AUX_ALLOW_RULES.brief).toEqual([]);
    // 원문에 예상 밖 펜스 명령이 없다 = 호출부가 거부할 이유가 없다.
    expect(out.unexpectedFencedCommands).toEqual([]);
  });

  it("intake: 원문 규칙 2개 + 실측 보조 도구(shasum) 1개", () => {
    const out = rewriteSkill({ skillMd: realSkill("intake"), stage: "intake", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([
      "Bash(bash /abs/core/scripts/run-stage.sh intake pin-rid-0716 --emit-context)",
      "Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash /abs/core/scripts/run-stage.sh intake pin-rid-0716)",
      "Bash(shasum:*)",
    ]);
    expect(out.transitionCommand).toBe(
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash /abs/core/scripts/run-stage.sh intake pin-rid-0716",
    );
    expect(out.unexpectedFencedCommands).toEqual([]);
  });

  it("intake 원문의 인용문 stub 명령(HARNESS_OFFLINE)은 규칙이 되지 않는다", () => {
    const out = rewriteSkill({ skillMd: realSkill("intake"), stage: "intake", rid: FIXED_RID, coreRoot: FIXED_CORE });
    // stub 은 CI 전용(AGENTS 2번 절) — 운영 무인 세션에 허용되면 안 된다. 인용문이라 애초에 도출 대상이 아니다.
    expect(out.allowRules.some((r) => r.includes("HARNESS_OFFLINE"))).toBe(false);
  });
});

/**
 * env 접두 경계 — **이 모듈이 필터인 이유가 걸린 자리**.
 *
 * 부록A-9 가 "원문 그대로 보존"을 요구한 건 `HARNESS_CLI=claude HARNESS_GEN_MODE=insession` 이라는
 *   **실측된 두 쌍**이지 '임의의 env' 가 아니다. 접두를 이름 패턴(`^[A-Za-z_]\w*=`)으로 열어두면
 *   아래 형태가 '정상 전이'로 분류돼 allow 규칙이자 전이 명령이 된다:
 *
 *     BASH_ENV=/abs/core/runs/r1/01-brief/.boot bash /abs/core/scripts/run-stage.sh brief r1
 *
 *   bash 는 run-stage 를 실행하기 **전에** `BASH_ENV` 가 가리키는 파일을 source 한다. 그 파일에
 *   `trap 'bash …/approve.sh r1 --ra-ok' EXIT` 한 줄만 있으면 사람의 승인 게이트와 RA 확인이 함께
 *   자동 통과되는데, 밖에서 보이는 도구 호출은 **허용된 run-stage 한 줄뿐**이다(결정은 사람의 몫 = AGENTS 5번 절).
 *   펜스 안 `approve.sh` 를 거부하는 위쪽 핀은 이 **간접 등가물**을 잡지 못한다 — 그래서 여기서 따로 못박는다.
 *   같은 부류: `ENV`·`LD_PRELOAD`·`PATH`·`SHELLOPTS`·`IFS`·`BASH_FUNC_*=`.
 */
describe("env 접두는 실측된 허용 목록만 — 그 밖은 규칙이 아니다(간접 실행 밀반입 차단)", () => {
  /** 적대 접두 1개 + 정상 전이 1개. 전이가 있어야 '전이 0개' 예외에 가리지 않고 **분류**를 볼 수 있다. */
  const hostileFixture = (prefix: string): string =>
    [
      "```bash",
      `${prefix} bash scripts/run-stage.sh brief <RUN>`,
      "```",
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");

  const LEGIT_TRANSITION = `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`;

  const HOSTILE_PREFIXES: ReadonlyArray<[string, string]> = [
    // run-stage 실행 **전에** source 된다 → 그 안에서 approve.sh 를 돌리면 승인 게이트가 자동 통과된다.
    ["BASH_ENV(간접 실행)", `BASH_ENV=${FIXED_CORE}/runs/${FIXED_RID}/01-brief/.boot`],
    // sh 모드의 BASH_ENV 등가물.
    ["ENV(간접 실행)", `ENV=${FIXED_CORE}/runs/${FIXED_RID}/.boot`],
    // 로더가 bash 프로세스에 임의 공유객체를 주입한다.
    ["LD_PRELOAD(주입)", "LD_PRELOAD=/tmp/evil.so"],
    // run-stage 경로는 절대경로지만, 그 스크립트가 부르는 모든 보조 명령이 바뀐다.
    ["PATH(보조 명령 탈취)", "PATH=/tmp/evil:/usr/bin"],
    // 셸 해석 자체를 바꾼다.
    ["SHELLOPTS(셸 해석 변조)", "SHELLOPTS=xtrace"],
    ["IFS(토큰 분해 변조)", "IFS=,"],
    // 무해해 보여도 목록 밖이면 통과 못 한다(allow 는 양성 목록이지 거부 목록이 아니다).
    ["임의 이름", "FOO=bar"],
    // 이름은 맞지만 **값**이 다르다: stub 은 CI 전용(AGENTS 2번 절), subprocess 는 폐기된 세션 밖 헤드리스 경로.
    ["허용 이름 + 금지 값(stub)", "HARNESS_CLI=stub"],
    ["허용 이름 + 금지 값(subprocess)", "HARNESS_GEN_MODE=subprocess"],
    // skills 코퍼스에 실재하지만 **지원 단계의 도출 대상이 아니다** — 코퍼스에 있다고 통째 허용하지 않는다.
    ["코퍼스 타 단계 접두", "HARNESS_IMAGE_CLI=nanobanana"],
    ["코퍼스 stub 접두", "HARNESS_OFFLINE=1"],
  ];

  it.each(HOSTILE_PREFIXES)("%s 접두가 붙은 run-stage 는 규칙이 되지 않는다", (_label, prefix) => {
    const out = rewriteSkill({ skillMd: hostileFixture(prefix), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    // ① 규칙으로 새지 않는다 — 정상 전이 1개만 남는다.
    expect(out.allowRules).toEqual([`Bash(${LEGIT_TRANSITION})`]);
    // ② 조용히 버리지도 않는다 — 호출부가 거부(noisy failure)하도록 그대로 보고된다.
    expect(out.unexpectedFencedCommands).toEqual([
      `${prefix} bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    ]);
    // ③ 전이 명령이 이 접두를 실어나르지 않는다(복구 세션이 그대로 타이핑하는 문자열이다).
    expect(out.transitionCommand).toBe(LEGIT_TRANSITION);
    expect(out.transitionCommand).not.toContain(prefix);
  });

  it("접두가 허용 목록 안이어도 중복이면 규칙이 아니다(원문에 없는 형태 = 드리프트 신호)", () => {
    const prefix = "HARNESS_CLI=claude HARNESS_CLI=claude";
    const out = rewriteSkill({ skillMd: hostileFixture(prefix), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([`Bash(${LEGIT_TRANSITION})`]);
    expect(out.unexpectedFencedCommands).toEqual([
      `${prefix} bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    ]);
  });

  it("접두가 허용 목록 안이어도 순서가 뒤집히면 규칙이 아니다(원문 순서가 정본)", () => {
    const prefix = "HARNESS_GEN_MODE=insession HARNESS_CLI=claude";
    const out = rewriteSkill({ skillMd: hostileFixture(prefix), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([`Bash(${LEGIT_TRANSITION})`]);
    expect(out.unexpectedFencedCommands).toEqual([
      `${prefix} bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    ]);
  });

  it("허용 접두 뒤에 적대 접두를 덧붙여도 통과하지 못한다(부분 일치로 뚫리지 않는다)", () => {
    const prefix = `HARNESS_CLI=claude BASH_ENV=${FIXED_CORE}/runs/${FIXED_RID}/.boot`;
    const out = rewriteSkill({ skillMd: hostileFixture(prefix), stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([`Bash(${LEGIT_TRANSITION})`]);
    expect(out.allowRules.some((r) => r.includes("BASH_ENV"))).toBe(false);
    expect(out.unexpectedFencedCommands).toEqual([
      `${prefix} bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    ]);
  });

  it("실측된 접두(HARNESS_CLI=claude HARNESS_GEN_MODE=insession)는 계속 통과한다(부록A-9 회귀)", () => {
    // 이 핀이 깨지면 경계를 좁히다가 **측정된 정상 경로**를 부순 것이다(전이 3회 거부 = 부록A-9 의 그 사고).
    const md = [
      "```bash",
      "bash scripts/run-stage.sh brief <RUN> --emit-context",
      "```",
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");
    const out = rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([
      `Bash(bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID} --emit-context)`,
      `Bash(${LEGIT_TRANSITION})`,
    ]);
    expect(out.unexpectedFencedCommands).toEqual([]);
  });
});

describe("fail-closed — 지원하지 않는 단계", () => {
  it("keyvisual 은 타입드 도구 대응물 부재로 거부(W0 미해결 3번)", () => {
    expect(() =>
      rewriteSkill({ skillMd: ADVERSARIAL, stage: "keyvisual", rid: FIXED_RID, coreRoot: FIXED_CORE }),
    ).toThrow(/keyvisual/);
  });

  it("미지원(미실측) 단계는 거부 — 실측 근거가 있는 단계만 무인", () => {
    expect(() =>
      rewriteSkill({ skillMd: ADVERSARIAL, stage: "concept", rid: FIXED_RID, coreRoot: FIXED_CORE }),
    ).toThrow(/concept/);
    expect(SUPPORTED_STAGES).toEqual(["intake", "brief"]);
  });
});

describe("fail-closed — 규칙 도출이 애매하면 규칙을 만들지 않는다", () => {
  /** 펜스 안 여러 줄(백슬래시 연속) 명령: allow 규칙은 '한 줄 정확 문자열'이라 결박이 불가능하다. */
  it("여러 줄 연속(\\) 명령은 run-stage 처럼 보여도 규칙이 아니라 '예상 밖'이다", () => {
    const md = [
      "1. 입력:",
      "   ```bash",
      "   bash scripts/run-stage.sh brief <RUN> \\",
      "     --emit-context",
      "   ```",
      "2. 전이:",
      "   ```bash",
      "   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "   ```",
    ].join("\n");
    const out = rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([
      `Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID})`,
    ]);
    expect(out.unexpectedFencedCommands).toEqual([
      `bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID} --emit-context`,
    ]);
  });

  it("파이프·연쇄 등 셸 조합이 섞인 명령은 규칙이 아니다", () => {
    const md = [
      "```bash",
      "bash scripts/run-stage.sh brief <RUN> --emit-context | head -5",
      "```",
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");
    const out = rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules.some((r) => r.includes("head"))).toBe(false);
    expect(out.unexpectedFencedCommands).toEqual([
      `bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID} --emit-context | head -5`,
    ]);
  });

  it("치환을 비껴간 상대경로 호출은 규칙이 아니다(상대경로 규칙 유출 차단)", () => {
    // `sh …`(bash 아님)라 치환 패턴에 안 걸린다 → 상대경로가 남는다 → 규칙이 되면 부록A-10 이 금지한 형태가 된다.
    const md = [
      "```bash",
      "sh scripts/run-stage.sh brief <RUN> --emit-context",
      "```",
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");
    const out = rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules.some((r) => r.includes("sh scripts/run-stage.sh"))).toBe(false);
    expect(out.unexpectedFencedCommands).toEqual([`sh scripts/run-stage.sh brief ${FIXED_RID} --emit-context`]);
  });

  it("전이 명령이 없으면 예외(무인 세션이 전이 못 하면 정체한다 — 조용한 실패 금지)", () => {
    const md = ["```bash", "bash scripts/run-stage.sh brief <RUN> --emit-context", "```"].join("\n");
    expect(() => rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE })).toThrow(/전이/);
  });

  it("전이 명령이 둘 이상이면 예외(어느 것이 복구 세션용인지 확정 불가)", () => {
    // 두 줄 다 **도출 자격이 있는 형태**여야 이 핀이 의도한 '전이 2개' 상태에 도달한다.
    //   (접두가 허용 목록 밖이면 애초에 규칙 자격을 잃어 전이로 세지 않는다 — 그건 아래 별도 핀이 지킨다.)
    const md = [
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
      "```bash",
      "bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");
    expect(() => rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE })).toThrow(/전이/);
  });

  /**
   * `HARNESS_CLI=codex` 는 **하네스가 받지 않는 엔진 값**이고(생성 엔진은 `claude|stub` 단일화 — AGENTS 2번 절),
   *   무인 워커가 띄우는 것도 `claude` 세션이라 지원 단계의 원문은 이 접두를 쓰지 않는다. 허용 목록이 값까지
   *   고정하므로 임의의 다른 접두는 규칙이 되지 않는다 — '그럴싸한 env = 허용'이 아니라 '실측된 접두 = 허용'임을 못박는다.
   */
  it("타 엔진 접두(HARNESS_CLI=codex)는 규칙이 아니다", () => {
    const md = [
      "```bash",
      "HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
      "```bash",
      "HARNESS_CLI=codex HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>",
      "```",
    ].join("\n");
    const out = rewriteSkill({ skillMd: md, stage: "brief", rid: FIXED_RID, coreRoot: FIXED_CORE });

    expect(out.allowRules).toEqual([
      `Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID})`,
    ]);
    expect(out.unexpectedFencedCommands).toEqual([
      `HARNESS_CLI=codex HARNESS_GEN_MODE=insession bash ${FIXED_CORE}/scripts/run-stage.sh brief ${FIXED_RID}`,
    ]);
  });
});
