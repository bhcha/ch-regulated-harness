/**
 * cli-session-runner.ts — 무인 잡 1건의 **수명주기**를 도는 API(`runJobSession`). W4 데몬이 supervisor 안에서 부른다.
 *
 * 한 잡 = 한 단계를 무인 생성하는 실 `claude` 세션을 띄워 산출물을 쓰게 하고, 세션이 스스로 insession 전이까지
 *   마치게 한다. 이 모듈은 그 조립·순서·백스톱만 소유한다 — **큐를 만지지 않고(성공/실패 처분은 데몬 몫)** core 를
 *   직접 호출하지도 않는다(주/복구 세션은 **언제나 supervisor 가 spawn** 한다 · 잠긴 결정 4). 여기가 하는 일은:
 *
 *   조립 → 스폰(supervisor) → 전이 확인(next-action) → 복구 백스톱 → **결과 보고**(RunJobResult).
 *
 * 순서(계획 부록A-9/A-11 · W3):
 *   ① readDeclaredDomain — state.json 에서 도메인 한 필드(팩 선택 키). **스폰 전** fail-closed(잘못된 팩 방지).
 *   ② rewriteSkill      — SKILL.md 결정론 치환 → 프롬프트 + allow 규칙 + 전이 명령(손으로 짜지 않는다 · A-9 교훈).
 *   ③ buildSessionPlan  — 부록A-9 '작동한 최소 구성'(argv·cwd·env·격리 settings) 한 덩이 조립.
 *   ④ writeSettings     — 격리 CLAUDE_CONFIG_DIR/settings.json 기록(쓰기 deny — 이 모듈의 유일한 파일 쓰기).
 *   ⑤ superviseSession  — supervisor 가 주 세션을 detached 로 띄우고 kill_at 스케줄로 마감을 강제. 세션 종료까지 대기.
 *      주 세션은 잡 예산 전체가 아니라 **선확보 스케줄(잡 kill_at − RECOVERY_RESERVE_MS)** 로 마감한다 — 복구 세션
 *      몫(최소예산 90s + 스폰/마감 여유 30s)을 미리 떼어 남긴다. 주 세션이 이 앞당긴 kill_at 까지 예산을 꽉 채워
 *      죽어도 복구 판정(잡 스케줄 기준) 시점 잔여가 복구 최소예산 이상 남게 하는 게 목적이다. ⚠ **소예산 폴백**:
 *      선확보하면 주 세션조차 스폰 여유가 없는 잡(소예산)에서는 잡 스케줄로 폴백(주 세션은 뜨지만 복구는 굶을 수 있음).
 *   ⑥ readNext          — 전이됐나? (isGenerateTurn == false = 전이 완료). 됐으면 성공(via=main).
 *   ⑦ 복구 백스톱       — 전이 안 됐지만 **산출물이 있고** **잡 스케줄** 기준 복구 예산이 남으면, **전이 전용** 세션
 *      1회(A-9 1차 실패 양상: 산출물은 썼는데 전이만 실패 → 그 한 줄만 다시 친다). 프롬프트·규칙은 **같은 전이 명령
 *      문자열**에서 나온다(결정론 · 프리앰블 교정이 아니다). 복구 판정·복구 세션은 **잡 스케줄(전체 kill_at)** 을 쓴다
 *      — 주(선확보 kill_at)+복구(잡 kill_at) 합이 잡 하나의 예산을 넘지 않는다(불변식). 그래도 전이 안 되면 실패
 *      보고(데몬이 failed/ 로 옮긴다 — 이 모듈은 보고만).
 *
 * ⚠ **이 모듈은 insession 마커를 스스로 지니지 않는다** — 마커는 실 CLI 가 자기 Bash 자식에 네이티브 주입한다(부록A-2).
 * ⚠ **오프라인 유지(W3 DoD)**: 스폰·next-action·시계·파일쓰기·도메인읽기는 전부 주입 seam 뒤에 있다. W3 단위
 *   테스트는 가짜 스폰/가짜 시계로 돈다 — **실 `claude` 세션은 여기서도 검증에서도 뜨지 않는다**(과금 게이트·라이브
 *   스모크는 W5 몫). keyvisual 은 무인 대상이 아니므로(rewriteSkill 가 던진다) 여기서 **깨끗이 실패**한다(compose_error).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sdkGenTimeout, sdkMaxTurns } from "../config.js";
import { isGenerateTurn } from "../kernel/job-protocol.js";
import { readNextAction } from "../kernel/contract-client.js";
import type { NextAction } from "../types/contract.js";
import { buildSessionPlan } from "./cli-session.js";
import type { SessionPlan } from "./cli-session.js";
import type { SessionRole } from "./ownership.js";
import { readDeclaredDomain } from "./run-domain.js";
import { rewriteSkill } from "./skill-rewrite.js";
import {
  type KillSchedule,
  type SessionOutcome,
  type SuperviseResult,
  TERM_MARGIN_MS,
  computeKillSchedule,
  hasSpawnRoom,
  remainingBeforeKill,
} from "./supervisor.js";

/**
 * 복구 세션 예산 = 90초. 전이 안 됐지만 산출물이 있을 때, 전이 명령 한 줄만 다시 치는 짧은 세션에 남겨두는 최소 시간.
 *   왜 90초: CLI 콜드스타트(수 초) + 전이 명령 ≤5턴(부록A-10 절대경로 전이 = 2턴·거부 0)에 넉넉한 상한이고, 잡
 *   예산(기본 480초)에 견줘선 작다. TERM_MARGIN(30초)보다 커서 복구 세션도 우아한 종료 여유를 갖는다 — 잡 스케줄
 *   기준 남은 시간이 이보다 적으면 복구를 시작하지 않는다(시작하자마자 죽일 세션은 띄우지 않는다). 이 잔여를 확보하는
 *   장치가 아래 RECOVERY_RESERVE_MS(주 세션 kill_at 선확보)다.
 */
export const RECOVERY_BUDGET_MS = 90_000;

/**
 * 주 세션 kill_at **선확보분** = 복구 최소예산(90초) + 스폰/마감 여유(TERM_MARGIN 30초) = 120초. 주 세션의 kill
 *   스케줄을 잡 kill_at 보다 이만큼 **앞당겨** 복구 세션 몫을 미리 남긴다 — 주 세션이 자기(선확보된) kill_at 까지
 *   예산을 꽉 채워 죽어도, 복구 예산 판정(잡 스케줄 기준) 시점의 잔여가 RECOVERY_BUDGET_MS 이상 남게 하는 하한이다.
 *   왜 90+30 인가: 복구 세션이 최소예산(90초)을 온전히 쓰고도 supervisor 가 우아하게 마감(TERM_MARGIN 30초)할 여유
 *   까지 **잡 kill_at 안에** 들어가야 하므로. 라이브 실측(주 세션이 예산을 다 먹어 복구 판정 잔여 29.5초 < 90초 →
 *   recovery_budget_insufficient 실패)이 이 상수를 처방했다. 주 세션조차 이만큼 못 떼는 소예산 잡에서는 선확보를
 *   접고 잡 스케줄로 폴백한다(runJobSession — 주 세션은 뜨되 복구는 굶을 수 있음).
 */
export const RECOVERY_RESERVE_MS = RECOVERY_BUDGET_MS + TERM_MARGIN_MS;

/** 복구 세션 턴 상한 = 5. 전이 명령 한 줄이면 끝나야 하므로 작게(폭주 방지). 주 세션(기본 50)과 다르다. */
export const RECOVERY_MAX_TURNS = 5;

/**
 * 복구 세션 도구 표면 = **`Bash` 하나**(Finding 4). 복구는 '전이 명령 한 줄만 실행하는' 최소 세션이라 그 한 줄
 *   (`Bash(<전이명령>)` allow 규칙)에 필요한 건 Bash 뿐이다 — Write/Edit/Read/Glob/Grep 은 불필요하다.
 *
 * ⚠ **왜 프롬프트가 아니라 도구 목록에서 빼는가**: 복구 플랜은 주 세션과 같은 `buildSessionPlan()` 으로 조립돼
 *   `--permission-mode acceptEdits` 를 물려받는데, 그 아래선 cwd(= 런 디렉터리) 안 파일 작성이 **자동 승인**된다.
 *   즉 `--tools` 에 Write/Edit 가 남아 있으면 복구 모델이 산출물을 덮어써도 게이트가 막지 못한다. 프롬프트의
 *   "쓰지 마세요"는 경계가 아니다(잠긴 결정 2 — 프롬프트를 신뢰 경계로 쓰지 않는다). `--tools` 에서 아예 빼면
 *   그 도구 자체가 실행 대상이 아니게 된다(cli-session 의 도구 표면 계약·NL 파서의 `--tools ""` 와 같은 1차 경계).
 */
export const RECOVERY_SESSION_TOOLS = "Bash";

/** 실패 사유 — 데몬이 사람에게 할 말과 큐 처분(failed/·drop)을 가른다. 이 모듈은 처분하지 않고 **분류만** 한다. */
export type RunJobFailReason =
  | "config_error" /** 잡 설정(env) 조회 실패(예: CHAT_SDK_MAX_TURNS=0·sdkGenTimeout 오설정) · kill_at 스케줄 계산
      실패(잡 스펙 시각이 비유한) · 감독/산출물 seam 의 예기치 못한 rejection · supervisor 진입점 실패 —
      runJobSession 이 던지지 않고 늘 구조적 결과를 보고한다는 계약의 catch-all(MEDIUM#2) */
  | "compose_error" /** 도메인/스킬/치환 조립 실패(keyvisual·미지원 단계 포함) — 스폰 전 fail-closed */
  | "unexpected_commands" /** SKILL.md 펜스에 예상 밖 명령(스킬-게이트 드리프트) — 호출부 거부 계약(부록A-11 3번) */
  | "refused_insufficient_time" /** 주 세션 스폰 여유 부족(남은 시간 < TERM_MARGIN) */
  | "spawn_failed" /** 세션 스폰이 pid 를 못 냄(claude 부재·EACCES) — 실행된 그룹 없음(HIGH#1) */
  | "output_cap" /** 세션 출력이 상한(32MiB) 초과 → cap-kill = 실패(전이 관측과 무관 · MEDIUM#4) */
  | "ledger_unwritable" /** 소유권 원장(2급 백스톱)이 내구적으로 안 써짐(intent 또는 register 실패) → 세션을 백스톱
      없이 돌리지 않고 회수 = 실패(HIGH — configured-but-broken safety net). supervisor 가 그룹을 SIGKILL 하고 이
      outcome 을 돌려준다. ⚠ S3 가 옛 raw-PID 하트비트 백스톱을 nonce 원장(ownership.ts)으로 교체하며 supervisor
      outcome 을 이 이름으로 개명했고, S4 가 러너 소비를 여기에 정렬한다(옛 하트비트 outcome 이름은 폐기) */
  | "reap_failed" /** 주 세션 마감 강제 실패(kill_at 시점 그룹 생존) — 마감 기계 자체가 실패 */
  | "next_action_unreadable" /** next-action 조회 실패 — 전이 여부 판단 불가 */
  | "not_transitioned_no_artifact" /** 전이 안 됨 + 산출물 없음 → 복구 무의미(주 세션이 아무것도 못 씀) */
  | "recovery_budget_insufficient" /** 전이 안 됨 + 산출물 있음이나 복구할 시간 부족 */
  | "recovery_compose_error" /** 복구 세션 조립·격리 settings 기록 실패(디스크 오류 등) — 복구가 뜨지도 못함(MEDIUM#3) */
  | "recovery_reap_failed" /** 복구 세션 마감 강제 실패 */
  | "still_not_transitioned"; /** 복구 세션까지 돌렸는데 여전히 전이 안 됨 */

/** 잡 1건 처리 결과 — 성공(어느 세션이 전이시켰나) 또는 실패(분류 + 진단). 큐 처분은 데몬 몫. */
export type RunJobResult =
  | { ok: true; via: "main" | "recovery"; detail: string }
  | { ok: false; reason: RunJobFailReason; detail: string };

export interface RunJobSessionInput {
  /** core(하네스) 체크아웃 절대경로. */
  coreRoot: string;
  /** 이 잡의 run_id. */
  rid: string;
  /** run-stage 인자(intake·brief · SUPPORTED_STAGES). */
  stage: string;
  /** 세션 기동(클레임) 시각 ms — kill_at 예산의 기준. */
  claimedAtMs: number;
  /** 잡 절대 마감 ms(잡 파일 expires_at → ms). kill_at = min(claimedAt+genTimeout, deadline). */
  deadlineMs: number;
  /** 워커가 이 잡용으로 만든 전용 빈 디렉터리(절대경로) = 격리 CLAUDE_CONFIG_DIR. 생성·정리는 데몬 몫. */
  configDir: string;
  /** 구독 인증 토큰(chat/.env 의 CLAUDE_CODE_OAUTH_TOKEN). 없으면 세션은 인증 실패로 죽는다(부록A-8). */
  oauthToken?: string;
  /** 위생 재구성 base(기본 process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** 잡 wall-clock 예산 ms(기본 config.sdkGenTimeout()). 테스트가 kill_at 스케줄을 고정하려 override. */
  genTimeoutMs?: number;
  /** 세션 턴 상한(기본 config.sdkMaxTurns()). */
  maxTurns?: number;
}

/** 주입 seam — 프로덕션 기본은 실 파일/실 next-action/실 supervisor. 테스트는 전부 가짜(오프라인·결정적). */
export interface RunJobSessionDeps {
  /** 현재 절대 시각 ms(기본 Date.now). refuse·복구 예산 판정에 쓴다 — supervisor 시계와 같은 벽시계를 본다. */
  now?: () => number;
  /** 도메인 읽기(기본 readDeclaredDomain — state.json 한 필드). */
  readDomain?: (coreRoot: string, rid: string) => Promise<string>;
  /** SKILL.md 원문 읽기(기본 core/skills/<stage>/SKILL.md). */
  readSkillMd?: (coreRoot: string, stage: string) => Promise<string>;
  /** 격리 settings.json 쓰기(기본 mkdir -p + writeFile). 이 모듈의 유일한 파일 쓰기. */
  writeSettings?: (path: string, content: string) => Promise<void>;
  /**
   * **스폰 seam(필수 · 기본값 없음)** — supervisor 가 세션을 detached 로 띄우고 kill_at 스케줄로 마감을 강제한다.
   *   `role`(main·recovery)은 러너가 안다 — supervise 뒤의 원장에 세션 역할을 정직하게 라벨링하려고 seam 으로 실어
   *   보낸다(evaluateReap 은 role 로 분기하지 않지만 감사 라벨은 정확해야 한다). 주 세션=main, 복구 세션=recovery.
   *
   * ⚠ **왜 기본 seam 이 없나(옛 defaultSupervise 폐기 · S4 결정)**: supervise 는 **소유권 원장(2급 백스톱)을 실어야**
   *   하는데, 그 원장은 **잡·런별**이고 경로도 데몬이 정한다(supervisor.ts main() 이 CHAT_SESSION_LEDGER 로 createLedger).
   *   러너는 원장 수명주기를 소유하지 않으므로 **원장 없는 '기본' seam 을 만들 수 없다** — 옛 defaultSupervise 는
   *   superviseSession 을 원장 없이 불러 런타임에 'ledger seam 미주입'으로 **던지는** 이름뿐인 default 였다(위험한 죽은
   *   경로). 그래서 이 seam 을 **필수**로 두어, 원장을 배선한 호출자(main()·테스트)만 러너를 돌릴 수 있게 한다.
   */
  supervise: (plan: SessionPlan, role: SessionRole, schedule: KillSchedule) => Promise<SuperviseResult>;
  /** next-action 조회(기본 readNextAction · 읽기 전용). 전이 확인의 단일 채널. */
  readNext?: (rid: string) => Promise<NextAction>;
  /** 산출물 존재 확인(복구 백스톱 게이트 · 기본 = 단계 산출 디렉터리 비어있지 않음). */
  artifactPresent?: (coreRoot: string, rid: string, stage: string) => Promise<boolean>;
}

// ── 프로덕션 기본 seam ─────────────────────────────────────────────────────────

async function defaultReadSkillMd(coreRoot: string, stage: string): Promise<string> {
  return readFile(join(coreRoot, "skills", stage, "SKILL.md"), "utf8");
}

async function defaultWriteSettings(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * 무인 지원 단계 → core 페이즈 산출 디렉터리(AGENTS 3번 절 실측 배치). **core 레이아웃에 얕게 결합**하므로
 *   지원 단계(intake·brief)만 담는다 — 다른 단계는 conservative 하게 '없음'(복구 안 함). ⚠ W4/W5 에서 실 배치로
 *   확정(드리프트 시 복구가 조용히 안 도는 방향이라 안전). 테스트는 이 기본을 안 타고 artifactPresent 를 주입한다.
 */
const STAGE_ARTIFACT_DIR: Record<string, string> = {
  intake: "00a-intake",
  brief: "01-brief",
};

async function defaultArtifactPresent(coreRoot: string, rid: string, stage: string): Promise<boolean> {
  const sub = STAGE_ARTIFACT_DIR[stage];
  if (sub === undefined) return false;
  const { readdir } = await import("node:fs/promises");
  try {
    const names = await readdir(join(coreRoot, "runs", rid, sub));
    return names.some((n) => !n.startsWith(".")); // 숨김 아닌 파일이 하나라도 있으면 산출물 있음.
  } catch {
    return false; // 디렉터리 부재·읽기 실패 = 산출물 없음(conservative — 복구 안 함).
  }
}

/**
 * supervise outcome → 러너 처분(순수 · **exhaustive**). 갈래는 둘뿐이다:
 *   · `check-transition` — 세션이 신호 전/후로 **그룹 소멸 확인**된 정상 종료(exited·killed). 아직 성공이 아니다 —
 *      러너가 next-action 으로 **전이됐을 때만** ok:true 로 승격한다(전이 안 됐으면 복구/실패로 간다).
 *   · `fail` — 그 외 모든 outcome 은 즉시 타입드 실패다. **전이 관측과 무관**하게 실패로 처분한다: output_cap(폭주
 *      출력 회수)·reap_failed(마감 기계 실패)·spawn_failed(그룹 미기동)·ledger_unwritable(2급 백스톱 미확립)·
 *      refused(스폰 여유 부족)는 전이가 우연히 보여도 성공이 아니다(MEDIUM#4·HIGH#1).
 *
 * ⚠ **성공 오판 방지가 이 매핑의 핵심**: 어떤 outcome 도 매핑 없이 아래 전이 확인으로 흘러 ok:true 가 되면 안 된다.
 *   switch 끝의 `never` 가드가 SessionOutcome 이 늘 때 **컴파일을 깨** 새 outcome 을 명시 매핑하게 강제한다
 *   (unmapped-fallthrough-to-success = 이 재정렬이 막으려는 바로 그 버그류).
 *
 * `reap_failed` 만 phase 로 갈린다 — 주 세션은 `reap_failed`, 복구 세션은 `recovery_reap_failed`(진단 분리). 나머지
 *   실패 사유는 phase 무관(같은 의미). detail 은 호출부가 supervise 결과의 detail 을 그대로 싣는다.
 */
type OutcomeDisposition =
  | { kind: "check-transition" }
  | { kind: "fail"; reason: RunJobFailReason };

function classifyOutcome(outcome: SessionOutcome, phase: SessionRole): OutcomeDisposition {
  switch (outcome) {
    case "exited":
    case "killed":
      // 그룹 소멸 확인된 정상 종료 — 성공은 전이됐을 때만(러너가 next-action 으로 판정).
      return { kind: "check-transition" };
    case "reap_failed":
      // 마감 기계 자체가 실패(그룹 생존). '결국 종료'가 아니라 지금 실패다 — 복구도 시도하지 않는다.
      return { kind: "fail", reason: phase === "recovery" ? "recovery_reap_failed" : "reap_failed" };
    case "refused":
      // 스폰 여유 부족으로 애초에 안 띄웠다(러너 사전검사 뒤 시계가 흘러 supervisor 가 다시 거부한 경우 포함).
      return { kind: "fail", reason: "refused_insufficient_time" };
    case "spawn_failed":
      // 세션이 pid 를 못 냄(claude 부재·EACCES) — 실행된 그룹 없음(HIGH#1). 전이·산출물 확인 무의미.
      return { kind: "fail", reason: "spawn_failed" };
    case "ledger_unwritable":
      // 소유권 원장(2급 백스톱)이 안 서서 supervisor 가 그룹을 회수했다 — 백스톱 없이 돌지 않았다(HIGH).
      return { kind: "fail", reason: "ledger_unwritable" };
    case "output_cap":
      // 출력 상한(32MiB) 초과 cap-kill = 실패. **전이 관측 전에** 끊는다(우연한 전이를 성공으로 오판 금지 · MEDIUM#4).
      return { kind: "fail", reason: "output_cap" };
    default: {
      // 도달 불가 — 위 케이스가 SessionOutcome 을 소진한다(never 가 컴파일 타임 보증). 방어적으로 실패 처분한다
      //   (미처리 outcome 이 절대 성공 경로로 새지 않게 · runJobSession 은 여기서도 던지지 않는다).
      const _exhaustive: never = outcome;
      void _exhaustive;
      return { kind: "fail", reason: "config_error" };
    }
  }
}

/**
 * 복구 세션 프롬프트(전이 전용) — **고정 최소 템플릿 + 전이 명령 verbatim**. 프리앰블로 생성 명령 형태를
 *   교정하려는 게 아니다(부록A-10 이 금지한 것): 여기선 '정확히 이 한 줄만 쳐라'라고 말하고, 그 한 줄이 곧 **유일한
 *   allow 규칙**이라 모델이 다른 걸 치면 fail-closed 된다. 프롬프트의 변수는 transitionCommand 하나뿐(결정론).
 */
function recoveryPrompt(transitionCommand: string): string {
  return [
    "# 복구 세션(전이 전용)",
    "",
    "이 단계의 산출물은 이미 작성됐고, 상태 전이 호출만 실패했습니다.",
    "아래 명령을 **정확히 그대로** 한 번만 실행하세요. 경로·인자·환경변수 접두를 바꾸거나 다른 명령을 덧붙이지 마세요:",
    "",
    "```bash",
    transitionCommand,
    "```",
    "",
    "이 명령 외에는 파일을 읽거나 쓰지 말고, 아무 것도 하지 마세요. 전이가 끝나면 종료하세요.",
  ].join("\n");
}

/**
 * 복구 플랜 argv 의 `--tools` 값을 복구 전용 최소 집합(RECOVERY_SESSION_TOOLS)으로 좁힌다(Finding 4).
 *
 * ⚠ **왜 조립부(cli-session.ts)가 아니라 여기서 하는가**: 이상적 seam 은 `buildSessionPlan` 의 `tools` 파라미터지만
 *   cli-session.ts 는 이 작업의 소유 밖이라 고칠 수 없다(고쳐야만 가능하면 중단·보고가 규칙). buildSessionPlan 이
 *   `--tools` 를 고정 리터럴로만 실으므로, 복구 경로에서 그 **한 토큰만** 결정론적으로 치환한다 — 프롬프트가 아니라
 *   argv(조립 산물) 수준의 경계 조정이라 잠긴 결정 2 를 지킨다. `--tools` 가 없으면 조립 계약이 바뀐 것이니 fail-closed.
 */
function restrictRecoveryTools(argv: string[]): string[] {
  const i = argv.indexOf("--tools");
  if (i < 0 || i + 1 >= argv.length) {
    throw new Error(
      "복구 플랜 argv 에 --tools 가 없습니다 — cli-session 의 도구 표면 조립 계약이 바뀌었습니다(복구 최소화 불가).",
    );
  }
  const out = argv.slice();
  out[i + 1] = RECOVERY_SESSION_TOOLS; // 그 한 토큰만 최소 집합으로 치환(나머지 플래그·순서 불변).
  return out;
}

/**
 * 잡 1건의 무인 세션 수명주기를 돈다. **큐를 만지지 않고** 결과만 보고한다(성공/실패 처분은 데몬 몫).
 *
 * @throws 던지지 않는다 — 조립 예외(도메인/스킬/치환)는 `compose_error` 결과로 환원해 **깨끗이 실패**한다
 *   (keyvisual 같은 미지원 단계도 여기로 떨어진다). 데몬이 결과만 보고 큐를 처분할 수 있게 예외를 새로 흘리지 않는다.
 */
export async function runJobSession(
  input: RunJobSessionInput,
  deps: RunJobSessionDeps,
): Promise<RunJobResult> {
  const now = deps.now ?? Date.now;
  const readDomain = deps.readDomain ?? readDeclaredDomain;
  const readSkillMd = deps.readSkillMd ?? defaultReadSkillMd;
  const writeSettings = deps.writeSettings ?? defaultWriteSettings;
  const supervise = deps.supervise; // 필수 seam(기본값 없음 — 원장 배선은 호출자 몫 · 위 supervise 주석).
  const readNext = deps.readNext ?? readNextAction;
  const artifactPresent = deps.artifactPresent ?? defaultArtifactPresent;

  // MEDIUM#2 — config 게터(sdkGenTimeout·sdkMaxTurns)는 **명시 오설정에 던진다**(예: CHAT_SDK_MAX_TURNS=0 ·
  //   CHAT_SDK_GEN_TIMEOUT=30m). 이 읽기가 아래 첫 try 밖에 있으면 그 throw 가 runJobSession 을 **reject** 시키고,
  //   supervisor 의 `void main()` 이 결과 없이 죽어 데몬이 실패를 분류 못 한다. '늘 구조적 RunJobResult 를 보고한다'는
  //   계약을 지키려면 던질 수 있는 이 읽기도 가드 안으로 들여, config_error(실패)로 환원한다. input 으로 값이 오면
  //   (테스트 경로) 게터를 아예 안 불러 던질 일이 없다.
  let genTimeoutMs: number;
  let maxTurns: number;
  try {
    genTimeoutMs = input.genTimeoutMs ?? sdkGenTimeout();
    maxTurns = input.maxTurns ?? sdkMaxTurns();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `잡 설정(env) 조회 실패: ${msg}` };
  }
  const baseEnv = input.baseEnv ?? process.env;

  // ── 조립(①~④) — 어느 단계든 던지면 compose_error 로 깨끗이 실패(스폰 전이므로 부작용 0) ──
  let mainPlan: SessionPlan;
  let transitionCommand: string;
  let domain: string; // 복구 플랜에서 재사용(이미 검증된 값 — 재조회 불필요).
  try {
    domain = await readDomain(input.coreRoot, input.rid); // ① 스폰 전 fail-closed(잘못된 팩 방지)
    const skillMd = await readSkillMd(input.coreRoot, input.stage);
    const rewritten = rewriteSkill({ skillMd, stage: input.stage, rid: input.rid, coreRoot: input.coreRoot }); // ②
    // 펜스에 예상 밖 명령이 있으면 **호출부가 거부한다**(부록A-11 3번 · 조용히 규칙으로 승격하지 않는다).
    if (rewritten.unexpectedFencedCommands.length > 0) {
      return {
        ok: false,
        reason: "unexpected_commands",
        detail: `SKILL.md(stage=${input.stage}) 펜스에 예상 밖 명령: ${rewritten.unexpectedFencedCommands.join(" · ")}`,
      };
    }
    transitionCommand = rewritten.transitionCommand;
    mainPlan = buildSessionPlan({
      // ③
      coreRoot: input.coreRoot,
      rid: input.rid,
      domain,
      prompt: rewritten.prompt,
      allowRules: rewritten.allowRules,
      maxTurns,
      configDir: input.configDir,
      ...(input.oauthToken !== undefined ? { oauthToken: input.oauthToken } : {}),
      baseEnv,
    });
    await writeSettings(mainPlan.settingsPath, mainPlan.settingsJson); // ④ 격리 settings(쓰기 deny)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "compose_error", detail: msg };
  }

  // MEDIUM#2 — computeKillSchedule 은 claimedAt/genTimeout/deadline 이 비유한이면 assertFiniteMs 로 **던진다**
  //   (예: 잡 파일 expires_at 파싱이 깨져 deadlineMs 가 NaN). 이 계산이 가드 밖이면 그 throw 가 runJobSession 을
  //   reject 시켜 '늘 구조적 RunJobResult 를 보고한다'는 함수 계약을 깬다(직접 호출자에 rejection 누수). 스폰 전
  //   조립 단계이므로 부작용 0 — config_error(잡 스펙 시각 오류)로 환원한다.
  // 잡 스케줄 — 주+복구 세션 합산 상한(잡 하나의 kill_at). 복구 판정·복구 세션이 이 전체 스케줄을 쓴다(불변).
  let jobSchedule: KillSchedule;
  try {
    jobSchedule = computeKillSchedule({
      claimedAtMs: input.claimedAtMs,
      genTimeoutMs,
      deadlineMs: input.deadlineMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `kill_at 스케줄 계산 실패(잡 스펙 시각이 비유한): ${msg}` };
  }

  // 즉시 죽여야 할 세션은 애초에 띄우지 않는다(스폰 결정 시점 여유 부족).
  //   MEDIUM(계약 구멍 · 선행 라운드 잔여) — now() 는 주입 seam 이라 **던질 수 있다**. 이 판정 지점의 now() 가
  //   가드 밖이면 그 throw 가 runJobSession 을 **reject** 시켜 '늘 구조적 RunJobResult' 계약을 깬다(computeKillSchedule/
  //   supervise/artifactPresent 는 선행 라운드가 이미 가드했으나 now() 두 지점은 남아 있었다). now() 를 한 번 떠
  //   변수로 고정한다 — throw 는 config_error(실패)로 환원하고, detail 도 같은 스냅샷을 써 일관된다.
  let spawnNowMs: number;
  try {
    spawnNowMs = now();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `시계 seam 예외(스폰 여유 판정): ${msg}` };
  }

  // 주 세션 전용 **선확보 스케줄** — 잡 예산·마감을 둘 다 RECOVERY_RESERVE_MS 만큼 당겨 계산하면 killAt 이 정확히
  //   jobKillAt − RECOVERY_RESERVE_MS 가 된다(min(a,b) 의 두 인자에서 같은 상수를 빼면 min 도 그만큼 준다). 주 세션이
  //   이 앞당긴 kill_at 까지 예산을 꽉 채워 죽어도, 복구 예산 판정(아래 · 잡 스케줄 기준) 시점 잔여가 최소
  //   RECOVERY_RESERVE_MS 남아 복구 세션 몫이 보장된다.
  //   ⚠ **폴백(소예산 안전)**: 이 계산이 던지거나(비유한 방어 — 잡 스케줄이 성공했으면 사실상 던지지 않지만 방어적)
  //   선확보 스케줄이 주 세션에게 **의미 있는 작업 창을 못 주면 잡 스케줄로 폴백**한다 — 그 경우 복구는 오늘처럼
  //   예산 부족으로 굶을 수 있다(정직한 한계). '의미 있는 창' 판정은 hasSpawnRoom(하드킬 −30초 여유)만으로는 부족하다:
  //   예산이 경계 바로 위(예 151초)면 선확보 killAt 이 claimed+31초라 스폰 여유(30초)는 통과하는데 **termAt(SIGTERM)
  //   까지는 0초** — 뜨자마자 우아한 종료 신호를 받아 주 세션 시간이 사실상 전부 증발한다. 그래서 폴백 경계를
  //   **SIGTERM 전 가용 시간**으로 판정한다: termAt − now ≥ RECOVERY_BUDGET_MS(90초 — 복구 세션 최소예산보다도 작은
  //   주-세션 창이라면 선확보가 본말전도다). 폴백 경계 = throw ∪ (preReserved.termAtMs − spawnNow < RECOVERY_BUDGET_MS).
  let mainSchedule: KillSchedule;
  try {
    const preReserved = computeKillSchedule({
      claimedAtMs: input.claimedAtMs,
      genTimeoutMs: genTimeoutMs - RECOVERY_RESERVE_MS,
      deadlineMs: input.deadlineMs - RECOVERY_RESERVE_MS,
    });
    mainSchedule = preReserved.termAtMs - spawnNowMs >= RECOVERY_BUDGET_MS ? preReserved : jobSchedule;
  } catch {
    mainSchedule = jobSchedule; // 비유한 방어 — 원 동작(잡 스케줄)으로 환원.
  }

  // 스폰 여유 거부 판정은 **실제 사용하는 mainSchedule** 기준(선확보분 폴백이면 잡 스케줄, 아니면 선확보 스케줄).
  if (!hasSpawnRoom(mainSchedule, spawnNowMs)) {
    return {
      ok: false,
      reason: "refused_insufficient_time",
      detail: `주 세션 스폰 여유 부족(남은 ${remainingBeforeKill(mainSchedule, spawnNowMs)}ms)`,
    };
  }

  // ⑤ 주 세션 — supervisor 가 spawn·마감강제(**선확보 스케줄** mainSchedule 로). 세션 종료(자가/강제)까지 대기.
  //   role="main" 을 seam 으로 실어 원장이 주 세션을 정직하게 라벨링하게 한다(복구는 아래에서 role="recovery").
  //   MEDIUM#2 — superviseSession 은 계약상 늘 resolve 하지만, 주입된 supervise seam(또는 미래 변경)이 reject 하면
  //   그 rejection 이 함수 밖으로 샌다. '늘 구조적 결과' 계약을 지키려 seam rejection 도 config_error 로 환원한다.
  let mainResult: SuperviseResult;
  try {
    mainResult = await supervise(mainPlan, "main", mainSchedule);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `주 세션 감독 seam 예외(계약상 resolve 여야 함): ${msg}` };
  }
  // 모든 SessionOutcome 을 **빠짐없이** 처분한다(classifyOutcome 의 never 가드). exited/killed 만 전이 확인으로
  //   진행하고, 그 외(reap_failed·refused·spawn_failed·ledger_unwritable·output_cap)는 전이 관측 전에 즉시 실패다.
  const mainDisp = classifyOutcome(mainResult.outcome, "main");
  if (mainDisp.kind === "fail") {
    return { ok: false, reason: mainDisp.reason, detail: mainResult.detail };
  }

  // ⑥ 전이됐나 — next-action 이 단일 채널. isGenerateTurn == false = 그 단계 생성 차례가 아니다 = 전이 완료.
  let na: NextAction;
  try {
    na = await readNext(input.rid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "next_action_unreadable", detail: `주 세션 후 next-action 조회 실패: ${msg}` };
  }
  if (!isGenerateTurn(na, input.stage)) {
    return { ok: true, via: "main", detail: "주 세션이 전이까지 완료" };
  }

  // ⑦ 복구 백스톱 — 전이 안 됨. 산출물이 있고 예산이 남을 때만 전이 전용 세션 1회.
  //   MEDIUM#2 — 기본 artifactPresent 는 스스로 catch 하지만(부재=false), 주입 seam 이 reject 하면 함수 밖으로 샌다.
  let artifact: boolean;
  try {
    artifact = await artifactPresent(input.coreRoot, input.rid, input.stage);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `산출물 존재 확인 seam 예외: ${msg}` };
  }
  if (!artifact) {
    return {
      ok: false,
      reason: "not_transitioned_no_artifact",
      detail: "주 세션이 전이도 산출물 작성도 못 함 — 복구 무의미",
    };
  }
  // MEDIUM(계약 구멍) — 위 스폰 여유 판정과 같은 이유로 이 복구 예산 판정의 now() 도 가드 안에서 뜬다(throw→config_error).
  let recNowMs: number;
  try {
    recNowMs = now();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `시계 seam 예외(복구 예산 판정): ${msg}` };
  }
  // 복구 예산 판정은 **잡 스케줄** 기준(변경 없음) — 주 세션이 선확보분을 남기고 죽었으므로 정상 동작 시 이 잔여는
  //   최소 RECOVERY_RESERVE_MS(= RECOVERY_BUDGET_MS + TERM_MARGIN) 다. 소예산 폴백이었다면 오늘처럼 부족할 수 있다.
  if (remainingBeforeKill(jobSchedule, recNowMs) < RECOVERY_BUDGET_MS) {
    return {
      ok: false,
      reason: "recovery_budget_insufficient",
      detail: `산출물은 있으나 복구 예산 부족(남은 ${remainingBeforeKill(jobSchedule, recNowMs)}ms < ${RECOVERY_BUDGET_MS}ms)`,
    };
  }

  // 복구 플랜 조립 + 격리 settings 기록 — **초기 조립(①~④)과 같은 구조적-결과 보증 아래** 둔다(MEDIUM#3).
  //   이 세 단계(buildSessionPlan·restrictRecoveryTools·writeSettings)는 던질 수 있다(플랜 검증 실패 · 디스크
  //   오류 ENOSPC/EACCES). try/catch 밖에 두면 그 rejection 이 `void main()` 까지 새어 supervisor 가 **구조적
  //   RunJobResult 없이** 죽고, W4 데몬이 실패를 분류하지 못한다. runJobSession 의 계약은 '던지지 않고 늘 결과를
  //   보고한다'이므로, 복구가 뜨지도 못하면 recovery_compose_error(실패)로 환원한다.
  let recoveryPlan: SessionPlan;
  try {
    // 프롬프트·규칙 모두 **같은 전이 명령 문자열**에서. allow 규칙은 그 전이 한 줄뿐(최소).
    const recoveryPlanBase = buildSessionPlan({
      coreRoot: input.coreRoot,
      rid: input.rid,
      domain, // 조립 단계에서 검증된 도메인 재사용(재조회 불필요)
      prompt: recoveryPrompt(transitionCommand),
      allowRules: [`Bash(${transitionCommand})`],
      maxTurns: RECOVERY_MAX_TURNS,
      configDir: input.configDir,
      ...(input.oauthToken !== undefined ? { oauthToken: input.oauthToken } : {}),
      baseEnv,
    });
    // 도구 표면을 복구 최소 집합(Bash 하나)으로 좁힌다 — acceptEdits 자동승인 하에서도 산출물 Write/Edit 불가(Finding 4).
    recoveryPlan = {
      ...recoveryPlanBase,
      argv: restrictRecoveryTools(recoveryPlanBase.argv),
    };
    await writeSettings(recoveryPlan.settingsPath, recoveryPlan.settingsJson); // 같은 내용(멱등) — 격리 settings 보증.
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "recovery_compose_error", detail: `복구 세션 조립·격리 settings 기록 실패: ${msg}` };
  }

  // 복구 세션은 **잡 스케줄(전체 kill_at)** 아래 — 주 세션은 선확보 kill_at(jobKillAt − RESERVE)까지만 돌고 죽었으니
  //   그 앞당긴 마감과 잡 kill_at 사이가 복구 몫이다. 주(선확보 kill_at)+복구(잡 kill_at)를 합쳐도 잡 하나의 예산
  //   (잡 kill_at)을 넘지 않는다(불변식). role="recovery" 를 seam 으로 실어 원장이 복구 세션을 정직하게 라벨링하게
  //   한다(evaluateReap 은 role 로 분기 안 하지만 감사 정확성).
  //   MEDIUM#2 — 주 세션과 같은 이유로 supervise seam rejection 을 config_error 로 환원(함수 계약 보존).
  let recResult: SuperviseResult;
  try {
    recResult = await supervise(recoveryPlan, "recovery", jobSchedule);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "config_error", detail: `복구 세션 감독 seam 예외(계약상 resolve 여야 함): ${msg}` };
  }
  // 복구 세션도 같은 exhaustive 매핑으로 처분한다(phase="recovery" → reap_failed 는 recovery_reap_failed 로 분리).
  const recDisp = classifyOutcome(recResult.outcome, "recovery");
  if (recDisp.kind === "fail") {
    return { ok: false, reason: recDisp.reason, detail: recResult.detail };
  }

  let na2: NextAction;
  try {
    na2 = await readNext(input.rid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "next_action_unreadable", detail: `복구 세션 후 next-action 조회 실패: ${msg}` };
  }
  if (!isGenerateTurn(na2, input.stage)) {
    return { ok: true, via: "recovery", detail: "복구 세션이 전이 완료" };
  }
  return { ok: false, reason: "still_not_transitioned", detail: "복구 세션까지 돌렸으나 여전히 전이 안 됨" };
}
