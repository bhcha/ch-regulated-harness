/**
 * contract-client.ts — core `scripts/next-action.sh <rid>` 읽기 클라이언트(읽기 전용).
 *
 * 역할: 하네스 상태를 '읽어' 어댑터가 버튼/카드를 그릴 구조화 계약(NextAction)으로 돌려준다.
 *   · `bash <harnessRoot>/scripts/next-action.sh <rid>` 를 spawn(cwd=harnessRoot, env=harnessEnv 병합).
 *   · stdout 한 줄 JSON 을 파싱해 NextAction 으로 반환(미지 top-level 필드는 무시=그대로 보존).
 *   · 비-0 종료 / 빈 출력 / JSON 파싱 실패 / 필수 계약 필드(rid·step·action·stage) 누락·불일치 = 명확한
 *     Error(종료코드·stderr·원문 스니펫 포함)로 throw(읽기 계약: 안전 해석 불가 = 예외).
 *
 * 불변식(dev-loop-grounding 3): state.json 은 core scripts 만 쓴다 — 이 모듈은 **읽기 전용**(state 직접 쓰기 0).
 *   next-action.sh 자체가 읽기 전용이라 이 spawn 은 상태를 변이하지 않는다.
 *
 * forward-compat: NextAction 은 index signature 로 미지 키를 허용하므로 파싱 결과를 재구성하지 않고 캐스팅만 한다
 *   → next-action.sh 가 새 top-level 필드를 추가해도 파싱이 깨지지 않고 알려진 필드는 보존된다.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { harnessEnv, harnessRoot, isSafeRunId } from "../config.js";
import type { Action, NextAction, Step } from "../types/contract.js";

/** spawn 1회 결과(종료코드·stdout·stderr). */
export interface HarnessRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 자식 출력 스트림 상한(스트림당) — OOM/폭주 방지. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// step·action enum 멤버십 집합(런타임 검증용). SSoT 는 contract.ts 의 Step·Action union 이다 —
//   TS type union 은 런타임 값이 없어 import 로 못 가져오므로 여기서 리터럴을 **미러**한다(drift 나면 contract.ts 를
//   따른다). ⚠ **양방향 컴파일 가드**: `new Set<Step>` 만으로는 "contract.ts 에 없는 값을 넣음"(과다)만 잡고
//   "contract.ts 에 새 멤버가 늘었는데 여기서 누락"(과소)은 못 잡는다 — 후자가 더 위험하다(정당한 새 상태를 전면
//   차단). 그래서 아래 `_STEP_EXHAUSTIVE`/`_ACTION_EXHAUSTIVE` 를 `Record<Step, true>`/`Record<Action, true>` 로 두어
//   union 에 멤버가 늘면 **키 누락으로 컴파일이 깨지게** 한다(양방향 drift 검출). 런타임 소거되는 타입 전용 장치다.
const _STEP_EXHAUSTIVE: Record<Step, true> = {
  generate: true,
  review: true,
  select: true,
  human: true,
  done: true,
};
const _ACTION_EXHAUSTIVE: Record<Action, true> = {
  ingest: true,
  generate: true,
  review: true,
  select: true,
  approve: true,
  "raise-limit": true,
  "resume-approve": true,
  "resume-select": true,
  done: true,
};
const STEP_VALUES: ReadonlySet<string> = new Set<Step>(
  Object.keys(_STEP_EXHAUSTIVE) as Step[],
);
const ACTION_VALUES: ReadonlySet<string> = new Set<Action>(
  Object.keys(_ACTION_EXHAUSTIVE) as Action[],
);

/**
 * next-action.sh 실행기. 기본은 실제 **비동기** spawn(defaultRunner). 테스트는 fake 를 주입해
 * spawn 없이 파싱 로직(미지 필드 보존·오류 분기)을 검증한다.
 */
export type NextActionRunner = (rid: string) => Promise<HarnessRunResult>;

/** 실제 비동기 spawn: `bash <harnessRoot>/scripts/next-action.sh <rid>` (이벤트 루프 블로킹 금지 — spawnSync 아님). */
function defaultRunner(rid: string): Promise<HarnessRunResult> {
  const root = harnessRoot();
  const script = join(root, "scripts", "next-action.sh");
  return new Promise<HarnessRunResult>((resolve, reject) => {
    const child = spawn("bash", [script, rid], { cwd: root, env: { ...process.env, ...harnessEnv() } });
    // 출력 상한(OOM/폭주 방지) — next-action JSON 은 한 줄이라 정상 출력은 상한 근처에도 안 가지만, 방어적으로 캡.
    let stdout = "";
    let stderr = "";
    let over = false;
    const cap = (cur: string, d: Buffer): string => {
      if (over) return cur;
      const room = MAX_OUTPUT_BYTES - cur.length;
      const s = d.toString("utf8");
      if (s.length <= room) return cur + s;
      over = true;
      child.kill();
      return cur + s.slice(0, Math.max(0, room));
    };
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    // spawn 자체 실패(bash 부재 등)는 종료코드가 없다 — 읽기 계약상 실패는 예외로 승격.
    child.on("error", (err) => reject(new Error(`next-action.sh 실행 실패(rid=${rid}): ${err.message}`)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * 하네스의 '지금 할 일' 구조화 계약을 읽는다(읽기 전용).
 * @param rid    run_id.
 * @param runner 실행기(기본 defaultRunner — 실제 next-action.sh spawn). 테스트가 fake 주입.
 * @throws 비-0 종료 / 빈 출력 / JSON 파싱 실패 / 필수 계약 필드(rid·step·action·stage) 누락·불일치 시
 *   Error(종료코드·stderr·원문 스니펫 포함).
 */
export async function readNextAction(
  rid: string,
  runner: NextActionRunner = defaultRunner,
): Promise<NextAction> {
  if (!rid || rid.trim() === "") {
    throw new Error("readNextAction: run_id 가 비었습니다.");
  }
  // 읽기 경로도 write 래퍼와 동일하게 경로-안전 rid 만 허용 — next-action.sh 가 $HARNESS_ROOT/runs/$rid 로
  //   경로를 만들므로 `../runs/other` 같은 값이 다른 run 을 들여다보지 않도록 fail-closed.
  if (!isSafeRunId(rid)) {
    throw new Error(`readNextAction: run_id 형식이 안전하지 않습니다: ${rid}`);
  }
  const { code, stdout, stderr } = await runner(rid);
  const errTail = stderr.trim() || "(stderr 없음)";
  if (code !== 0) {
    throw new Error(`next-action.sh 비정상 종료(rid=${rid}, code=${code}): ${errTail}`);
  }
  const text = stdout.trim();
  if (text === "") {
    throw new Error(`next-action.sh 빈 출력(rid=${rid}, code=${code}): ${errTail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `next-action.sh JSON 파싱 실패(rid=${rid}): ${msg} — 원문(앞 200자): ${text.slice(0, 200)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`next-action.sh JSON 이 객체가 아닙니다(rid=${rid}): ${text.slice(0, 200)}`);
  }
  // 필수 계약 필드 검증(next-action.sh out 딕셔너리 SSoT: rid·step·stage·action 은 항상 실린다).
  //   '객체다'만으로는 부족하다 — 소비자(cli-session-runner)는 isGenerateTurn(na) 이 false 면 '전이 완료'로 보고
  //   성공 처분한다. 그래서 필드가 빠진 퇴화 응답({} 등)은 'generate 아님 = 전이 완료'로 오독돼 **미전이 잡을
  //   성공으로 삭제**한다. 안전하게 해석할 수 없는 next-action 은 여기서 fail-closed 한다(모든 호출부가 throw 를
  //   실패/폴백으로 흡수 — runner=next_action_unreadable · worker/flow=.catch()). 미지 필드는 아래처럼 건드리지 않아
  //   forward-compat(index signature 보존)은 그대로다 — 필수 필드의 존재·타입만 본다.
  const p = parsed as Record<string, unknown>;
  const snip = text.slice(0, 200);
  // rid: 요청한 rid 를 그대로 되돌려줘야 한다(불일치·부재 = 다른 run 을 읽었거나 봉투가 깨짐 → 신뢰 불가).
  if (p.rid !== rid) {
    throw new Error(`next-action.sh rid 불일치(요청 rid=${rid}, 응답 rid=${String(p.rid)}): ${snip}`);
  }
  // step·action: 계약상 enum(contract.ts Step·Action) 멤버여야 한다. '비어있지 않은 문자열'만으론 부족 —
  //   `step:"unknown"` 같은 오탈자·미지 값이 통과하면 소비자(isGenerateTurn: step==="generate" && stage 일치)가
  //   'generate 아님'으로 읽어 **전이 완료로 오독** → 미전이 잡을 성공 삭제한다(HIGH #1). enum 밖 값은 안전
  //   해석 불가 → fail-closed. (빈 문자열도 enum 에 없으므로 자연히 걸린다.)
  if (typeof p.step !== "string" || !STEP_VALUES.has(p.step)) {
    throw new Error(`next-action.sh step 값이 유효하지 않습니다(rid=${rid}): ${snip}`);
  }
  if (typeof p.action !== "string" || !ACTION_VALUES.has(p.action)) {
    throw new Error(`next-action.sh action 값이 유효하지 않습니다(rid=${rid}): ${snip}`);
  }
  // stage: 계약상 nullable(contract.ts `stage: string | null`) — 문자열 또는 null 만 허용, 그 외 타입은 거부
  //   (정당한 null 은 통과시키고 숫자 등 오염만 막는다 — over-tighten 금지).
  if (p.stage !== null && typeof p.stage !== "string") {
    throw new Error(`next-action.sh stage 가 문자열/null 이 아닙니다(rid=${rid}): ${snip}`);
  }
  // 교차규칙(contract.ts: action=generate ⟹ stage 는 non-empty 문자열 · contract.test.ts 165행에 고정):
  //   action 이 generate 인데 stage 가 null/빈 문자열이면 어느 단계를 만들지 없는 **퇴화 봉투**다. 이걸 통과시키면
  //   isGenerateTurn 이 stage 불일치로 false → '전이 완료'로 오독된다(HIGH #1 의 핵심 구멍 — 부분/오류 객체가
  //   성공으로 읽힘). generate 아닌 action 의 stage:null 은 정당하므로 건드리지 않는다(over-tighten 금지).
  if (p.action === "generate" && (typeof p.stage !== "string" || p.stage === "")) {
    throw new Error(`next-action.sh action=generate 인데 stage 가 비어있습니다(rid=${rid}): ${snip}`);
  }
  // 미지 필드 무시=그대로 보존: 재구성 없이 캐스팅만(index signature 가 미지 키를 담는다).
  return parsed as NextAction;
}
