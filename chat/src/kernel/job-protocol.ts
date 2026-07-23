/**
 * job-protocol.ts — 생성 잡 파일 큐 **프로토콜 v2**(경로·시계·next-action 전부 주입 · 플랫폼 무지).
 *
 * 이 파일 큐가 세 소비자(봇 · 무인 데몬 · 사람 운영자)의 **유일한 이음새**다(chat-dual-surface-plan 잠긴 결정 2).
 *   수명주기: `pending/<rid>-<stage>.json → claimed/<consumer>/… → 성공 삭제 · 실패 failed/ + .reason`
 *   사람이 읽는 규약 문서 = `chat/jobs/README.md`(이 모듈과 같은 변경에서 개정한다 — 규약이 두 곳에 있으면 갈라진다).
 *
 * 네 축:
 *   ① **절대 마감**(`expires_at`) — 적재시각+대기상한을 잡에 박아 둔다. duration 이 아니라 절대시각이라야
 *      늦게 집은 소비자가 적재 시각을 몰라도 '이미 늦었다'를 스스로 안다.
 *   ② **클레임-by-rename** — 원자성 원천은 OS 다. 두 소비자가 같은 잡을 집으면 rename 이 하나만 성공하고
 *      패자는 원본 소실(ENOENT)로 조용히 진다. ⚠ 잠금파일·'있는지 보고 옮기기'로 대체하지 않는다(그건 경합에 열려 있다).
 *   ③ **2중 검사** — 일하기 전에 둘 다 확인한다: ㉠ 남은 시간이 잡 예산+기동 여유보다 크다 ㉡ next-action 이
 *      여전히 그 단계 생성 차례다. 하나라도 어긋나면 일하지 않는다(만료→failed · 전이완료→삭제).
 *   ④ **적재 = 원자 대체**(supersede-then-create · 봇 몫 = `enqueueJob`) — 클레임은 오직 `pending/X` 에서 태어나므로,
 *      새 잡을 쓰기 **전에** 그 파일을 원자적으로 없앤다(unlink) → 산 클레임 조회 → 배타 생성(link). '검사는 통과했는데
 *      그 직후 옛 잡이 집히는' 창이 좁아지는 게 아니라 **전제부터 없다**(검사할 무렵 집힐 물건이 이미 없다).
 *
 * 마감(리스)이 유일한 처분 근거다 — **생사 추정은 펜스가 아니다**. 적재 차단(`findBlockingClaimedJob`)도
 *   뒷정리(`reapClaimedJobs`)도 '누가 살아 있나'(하트비트 = 추정)가 아니라 '마감이 남았나'(파일에 박힌 사실)로 가른다.
 *   한 잡의 생사를 두 곳이 다르게 판정하지 않는다.
 *
 * 보증 3분법(같은 계획): 데몬=구조적(kill_at 결박 — 후속 단계) · 사람=절차(README 규약) ·
 *   봇=화해([상태 다시 확인] — 늦은 성공을 따라잡고, 회수돼 사라진 요청은 [다시 만들기]로 새 마감을 받는다).
 *   이 모듈은 셋이 공유하는 '검사·클레임' 만 소유한다 — 세션 실행·kill 스케줄은 소비자 몫이다.
 *
 * 불변식: state.json 직접 쓰기 0(잡 파일만 만진다). 봇 프로세스 밖(데몬)에서도 import 되므로 전역 설정·플랫폼에
 *   의존하지 않는다 — 디렉터리·시계·next-action 조회는 전부 인자로 받는다.
 */
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isSafeRunId } from "../config.js";
import type { NextAction } from "../types/contract.js";
import type { GenerateJobFile } from "../types/jobs.js";

/** 잡 파일에 기재하는 프로토콜 버전(부재 = v1 레거시). */
export const JOB_PROTOCOL_VERSION = 2;

/** ENOENT(이미 없어짐) 판정 — 경합 패배·멱등 재호출의 **정상 신호**라 예외로 올리지 않는다. */
function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** EEXIST(이미 있음) — link() 기반 no-clobber 이동의 정상 신호. */
function isEexist(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "EEXIST";
}

/** 실패 사유 파일 접미사 — `failed/<rid>-<stage>.json.reason`. */
const REASON_SUFFIX = ".reason";

/** stage 는 파일명 세그먼트가 되므로 안전 토큰만(소문자·숫자·하이픈). 경로분리·`..` 차단. */
const SAFE_STAGE = /^[a-z0-9-]+$/;
/**
 * 소비자 id 는 `claimed/<consumer>/` 디렉터리명이 된다 — 같은 이유로 안전 토큰만.
 *   ⚠ 문자 클래스만으론 부족하다: `.` 와 `..` 는 이 패턴을 통과하지만 디렉터리명이 아니라 **경로 이동**이다.
 *     `.` = 클레임이 `claimed/` 바로 밑에 놓여 reaper 의 소비자 폴더 스캔에 영영 안 잡히고(고아 회수 불능),
 *     `..` = jobs 루트로 나가 수명주기(pending·claimed·failed) 밖으로 잡이 사라진다. isSafeRunId 와 같은 규칙으로 막는다.
 */
const SAFE_CONSUMER = /^[A-Za-z0-9._-]{1,64}$/;

/** 소비자 id 안전 판정(`claimed/<consumer>/` 디렉터리명이 될 수 있는가). 점 세그먼트(`.`·`..`)는 거부. */
export function isSafeConsumerId(consumerId: string): boolean {
  if (typeof consumerId !== "string") return false;
  if (consumerId === "." || consumerId === "..") return false;
  return SAFE_CONSUMER.test(consumerId);
}

export function isSafeStage(stage: string): boolean {
  return SAFE_STAGE.test(stage);
}

/** 잡 인자 검증 — 변조된 잡의 run_id/stage 가 파일경로를 탈출(`../`)하는 것을 파일 접촉 전에 차단. */
export function assertJobArgs(run_id: string, stage: string): void {
  if (!isSafeRunId(run_id)) throw new Error(`job-protocol: run_id 형식이 안전하지 않습니다: ${run_id}`);
  if (!isSafeStage(stage)) throw new Error(`job-protocol: stage 형식이 안전하지 않습니다: ${stage}`);
}

function assertConsumerId(consumerId: string): void {
  if (!isSafeConsumerId(consumerId)) {
    throw new Error(`job-protocol: 소비자 id 형식이 안전하지 않습니다: ${consumerId}`);
  }
}

/** 프로토콜 디렉터리 3면. 경로 조립 SSoT 는 config.storagePaths — 여기서 다시 join 하지 않는다(jobDirsOf 참조). */
export interface JobDirs {
  pending: string;
  claimed: string;
  failed: string;
}

/** config.storagePaths() 모양 → JobDirs(이름만 바꾼다 · 경로 계산 없음). 데몬·봇이 같은 경로를 보게 하는 어댑터. */
export function jobDirsOf(paths: { jobsPending: string; jobsClaimed: string; jobsFailed: string }): JobDirs {
  return { pending: paths.jobsPending, claimed: paths.jobsClaimed, failed: paths.jobsFailed };
}

/** 잡 파일명 — 한 런의 한 단계 = 잡 1건(재적재는 같은 이름을 덮어쓴다 → 중복 잡이 쌓이지 않는다). */
export function jobFileName(run_id: string, stage: string): string {
  assertJobArgs(run_id, stage);
  return `${run_id}-${stage}.json`;
}

// ── 잡 만들기·읽기·쓰기 ────────────────────────────────────────────────────────

/** 절대 마감(ISO-8601 UTC) = 적재시각 + 대기 상한. 사람 소비자도 읽는 파일이라 기계·사람 공용 문자열로 싣는다. */
export function computeExpiresAt(enqueuedAtMs: number, timeoutMs: number): string {
  return new Date(enqueuedAtMs + timeoutMs).toISOString();
}

/**
 * 마감 문자열의 **정확한** 형태 = `computeExpiresAt` 이 내는 `toISOString()` 산물 그대로.
 *   `Date.parse` 는 관대해서(`"12/31/9999"` 같은 비규약 문자열도 유효한 미래로 읽는다) 그것만 믿으면
 *   **신뢰할 수 없는 마감을 진짜 마감으로 오인해 자동 클레임**된다 — 마감은 구조적 보증의 뿌리라 형태를 조인다.
 *   확장 연도(`+275760-…`)도 배제한다(규약 밖 문자열이 영원한 마감으로 통과하지 않게).
 */
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 잡의 절대 마감(ms). 부재·**비규약 형식** = null(= 마감 미기재 · v1 레거시 잡 → 자동 소비 대상 아님).
 *   판정은 3중: 형태(위 정규식) → 파싱 가능 → **왕복 일치**(`new Date(ms).toISOString() === raw`).
 *   왕복까지 보는 이유 = 형태는 맞지만 존재하지 않는 날짜(`2026-02-31T…`)를 JS 가 조용히 넘겨 읽기 때문.
 *   ⚠ 신뢰할 수 없는 마감은 '만료'가 아니라 '마감 없음'으로 환원한다 — 자동 소비만 막고(안전) 사람 소비자는
 *     여전히 그 잡을 볼 수 있게(잡을 조용히 처분하지 않는다).
 */
export function parseDeadline(job: GenerateJobFile): number | null {
  const raw = job.expires_at;
  if (typeof raw !== "string" || !ISO_UTC_MS.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === raw ? ms : null;
}

export interface BuildJobInput {
  run_id: string;
  stage: string;
  /** 적재 시각(ms) — 호출부 주입(테스트 결정성). */
  enqueuedAtMs: number;
  /** 봇 대기 상한(ms · config.bridgeTimeout). expires_at 의 원천. */
  timeoutMs: number;
}

/** v2 잡 파일 1건 조립(순수). expires_at 은 여기서만 만든다 — 마감 원천이 흩어지지 않게. */
export function buildGenerateJob(input: BuildJobInput): GenerateJobFile {
  assertJobArgs(input.run_id, input.stage);
  return {
    version: JOB_PROTOCOL_VERSION,
    kind: "generate",
    run_id: input.run_id,
    stage: input.stage,
    job_id: randomUUID(),
    enqueued_at: new Date(input.enqueuedAtMs).toISOString(),
    expires_at: computeExpiresAt(input.enqueuedAtMs, input.timeoutMs),
  };
}

/**
 * pending 잡 파일 원자 기록(tmp+rename — 소비자가 반쯤 쓰인 파일을 읽는 일이 없게). @returns 기록 경로.
 *
 * ⚠ **봇의 적재 경로가 아니다 — 1급 적재는 `enqueueJob` 하나뿐이다.** 이 함수는 목적지를 **무조건 덮어쓰는**
 *   저수준 기록 primitive 다(rename 의 성질). 봇 경로에서 이걸 직접 부르면 `enqueueJob` 의 원자 대체(unlink →
 *   산 클레임 조회 → 배타 생성)를 통째로 우회해 **이중 소비 구멍이 되살아난다**: 덮어쓰기의 전제인 '옛 잡을
 *   아무도 안 집었다' 는 검사 없이는 참이 아니다(그 전제가 깨지는 순간이 정확히 옛 결함 ㉠이었다).
 *   남은 쓰임새는 잡 파일을 **있는 그대로** 놓아야 하는 자리뿐이다(테스트 픽스처 · 손으로 만든 v1 잡 재현 등).
 */
export async function writePendingJob(pendingDir: string, job: GenerateJobFile): Promise<string> {
  const name = jobFileName(job.run_id, job.stage);
  await mkdir(pendingDir, { recursive: true });
  const dest = join(pendingDir, name);
  // tmp 는 '.' 로 시작 — listPendingJobs 가 건너뛴다(반쯤 쓰인 파일이 잡으로 보이지 않게).
  const tmp = join(pendingDir, `.${name}.tmp-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await rename(tmp, dest);
  return dest;
}

/**
 * 잡을 얻지 못한 **이유** — `readJobFile` 의 null 하나에 뭉쳐 있는 두 사실을 가른다:
 *   gone    = 파일이 없다(ENOENT) — 목록에 잡힌 뒤 정상적으로 처분됐다(소비자의 완료·경합 패배·다른 pass)
 *   corrupt = 파일은 있는데 잡이 아니다(JSON 깨짐 · kind 다름 · 경로탈출 rid) — 사람이 봐야 한다
 * 대부분의 호출부에는 둘 다 '일감이 아니다' 하나로 족하다(그래서 readJobFile 의 null 계약이 그대로 옳다).
 *   **처분이 정반대인 자리에서만** 이 구분이 필요하다 — reaper 는 gone 을 조용히 넘기고 corrupt 만 격리한다.
 */
type JobRead = { job: GenerateJobFile } | { job: null; cause: "gone" | "corrupt" };

/**
 * 잡 파일 읽기 + 최소 형태 검증(이유까지 딸린 원본). `readJobFile` 은 이 결과에서 job 만 떼어낸 얇은 투영이라
 *   판정 규칙은 **여기 한 곳에만** 있다(두 벌로 갈라져 서로 다른 파일을 잡으로 보는 일이 없게).
 *   ⚠ ENOENT·형태 불일치 밖의 fs 오류(EACCES·EIO·EMFILE…)는 **삼키지 않고 던진다**: '일시적으로 못 읽음'과
 *     '내용이 깨졌음'은 다르다. 둘을 뭉뚱그리면 reaper 가 멀쩡한 잡을 디스크 딸꾹질 한 번에 failed/ 로 강등한다.
 */
async function readJobFileWithCause(path: string): Promise<JobRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return { job: null, cause: "gone" }; // 없음 = 잡 아님(경합 패배·이미 처분됨).
    throw e; // 읽기 실패 ≠ 깨진 잡 — 호출부가 재시도하게 올린다.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { job: null, cause: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { job: null, cause: "corrupt" };
  const j = parsed as Record<string, unknown>;
  if (j.kind !== "generate") return { job: null, cause: "corrupt" };
  if (typeof j.run_id !== "string" || !isSafeRunId(j.run_id)) return { job: null, cause: "corrupt" };
  if (typeof j.stage !== "string" || !isSafeStage(j.stage)) return { job: null, cause: "corrupt" };
  // 미지 필드는 그대로 보존(forward-compat) — 재구성하지 않고 캐스팅만.
  return { job: parsed as GenerateJobFile };
}

/**
 * 잡 파일 읽기 + 최소 형태 검증. **없음(ENOENT)·깨짐·형태 불일치 = null**(모르는 파일은 일감이 아니다).
 *   ⚠ 그 외 fs 오류(EACCES·EIO·EMFILE…)는 **삼키지 않고 던진다**: '일시적으로 못 읽음'과 '내용이 깨졌음'은 다르다.
 *     둘을 뭉뚱그리면 reaper 가 멀쩡한 잡을 디스크 딸꾹질 한 번에 failed/ 로 강등한다(호출부는 재시도해야 한다).
 *   ⚠ '없음'과 '깨짐'을 **일부러** 한 값으로 뭉갠다 — 목록·조회 호출부에는 둘의 처분이 같기 때문이다(건너뛴다).
 *     둘을 갈라 봐야 하는 호출부(reaper)는 `readJobFileWithCause` 를 쓴다(이 함수의 계약은 건드리지 않는다).
 */
export async function readJobFile(path: string): Promise<GenerateJobFile | null> {
  return (await readJobFileWithCause(path)).job;
}

/**
 * pending/ 의 잡 목록(파일명 오름차순 = 결정적 순서). 숨김(tmp)·비-json·형태 불일치는 건너뛴다.
 *   **파일명 규약(`<rid>-<stage>.json`)을 지키는 것만** 잡으로 본다: 하류(takePendingJob·claimJob)가 잡 내용에서
 *   canonical 이름을 다시 만들어 쓰므로, 이름이 어긋난 파일을 잡으로 넘기면 매 회차 '찾을 수 없음'만 되풀이한다.
 */
export async function listPendingJobs(
  pendingDir: string,
): Promise<Array<{ path: string; job: GenerateJobFile }>> {
  let names: string[];
  try {
    names = await readdir(pendingDir);
  } catch (e) {
    if (isEnoent(e)) return []; // 폴더가 아직 없음 = 잡 없음.
    throw e; // 권한·IO 오류를 '빈 큐'로 위장하지 않는다(있는 일감이 조용히 사라진다).
  }
  const out: Array<{ path: string; job: GenerateJobFile }> = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const path = join(pendingDir, name);
    const job = await readJobFile(path);
    if (!job || jobFileName(job.run_id, job.stage) !== name) continue;
    out.push({ path, job });
  }
  return out;
}

// ── 2중 검사 ──────────────────────────────────────────────────────────────────

/**
 * 2중 검사 판정 사유. 소비자(데몬·사람)는 이 값으로 클레임/포기를 가른다:
 *   ok           → 클레임하고 일한다
 *   expired      → 마감까지 남은 시간이 잡 예산+기동 여유에 못 미친다 → failed/ 격리(늦은 성공 창 자체를 없앤다)
 *   transitioned → 그 단계 생성 차례가 아니다(이미 됐거나 다음으로 감) → 잡 삭제(stale 재실행 차단)
 *   no_deadline  → expires_at 미기재(v1 레거시 잡) → 자동 소비 대상 아님(마감을 못 걸어 구조적 보증이 성립 안 함) · 사람 소비자 몫
 *   unreadable   → next-action 조회 실패 → 판단 불가라 손대지 않는다(다음 회차 재시도 — 조회 실패로 잡을 버리지 않는다)
 */
export type JobCheckReason = "ok" | "expired" | "transitioned" | "no_deadline" | "unreadable";

export interface JobCheck {
  ok: boolean;
  reason: JobCheckReason;
  /** 진단용 상세(로그·failed/ 사유 파일). 사람 카드 문구가 아니다. */
  detail?: string;
}

/**
 * 검사 ㉠(시간) — 순수. `지금 + 잡 예산 + 기동 여유 ≤ expires_at` 이어야 집는다.
 *   '마감이 아직 안 지났나'가 아니라 '**끝낼 수 있나**'를 본다 — 마감 3초 전에 8분짜리 잡을 시작하면 실패 카드 뒤
 *   늦은 성공이 되기 때문이다(그 창을 시작 전에 없앤다).
 */
export function checkBudget(
  job: GenerateJobFile,
  nowMs: number,
  budgetMs: number,
  startupMarginMs: number,
): JobCheck {
  const deadline = parseDeadline(job);
  if (deadline === null) {
    return { ok: false, reason: "no_deadline", detail: "expires_at 미기재(v1 레거시 잡) — 자동 소비 대상 아님" };
  }
  const need = budgetMs + startupMarginMs;
  const remain = deadline - nowMs;
  if (remain < need) {
    return { ok: false, reason: "expired", detail: `남은 시간 ${remain}ms < 필요 ${need}ms(예산 ${budgetMs} + 기동여유 ${startupMarginMs})` };
  }
  return { ok: true, reason: "ok" };
}

/**
 * 검사 ㉡(차례) — 지금 이 단계의 생성 차례인가. 봇(브리지)의 전이 감지와 **같은 판정**을 쓴다(이중 진실 금지).
 *   step 은 페이즈 횡단 전역이라 `step==generate` 만 보면 stale 한 brief 잡을 다음 단계(concept)의 차례와 혼동한다
 *   → stage 까지 같아야 '아직 그 잡의 차례'다.
 */
export function isGenerateTurn(na: NextAction, stage: string): boolean {
  return na.step === "generate" && na.stage === stage;
}

export interface DoubleCheckDeps {
  /** 현재시각(ms) — 주입(테스트 결정성). */
  now: () => number;
  /** 잡 wall-clock 예산(ms) — 소비자가 자기 값을 준다(데몬 = CHAT_SDK_GEN_TIMEOUT · 후속 단계 소유). */
  budgetMs: number;
  /** 기동 여유(ms) — 검사·클레임·세션 spawn 오버헤드 몫. */
  startupMarginMs: number;
  /** next-action 조회(읽기 전용). */
  readNext: (rid: string) => Promise<NextAction>;
}

/**
 * 2중 검사 — 시간(㉠) 먼저, 차례(㉡) 나중. 순서 주의: ㉠ 이 셸 없이 즉답이라 마감 지난 잡에 next-action spawn 비용을
 *   쓰지 않는다. 둘 다 통과해야만 ok(하나라도 어긋나면 일하지 않는다 — fail-closed).
 *
 * ⚠ ㉠은 ㉡ **뒤에 한 번 더** 본다: ㉡의 next-action 조회는 셸 spawn 이라 수백 ms가 걸릴 수 있고, 그동안 기동 여유가
 *   닳는다. 조회 전 시각으로만 판정하면 '검증할 땐 있던 예산'이 일을 시작할 땐 없다. 재검사는 순수 계산이라 공짜다.
 */
export async function doubleCheckJob(job: GenerateJobFile, deps: DoubleCheckDeps): Promise<JobCheck> {
  const budget = checkBudget(job, deps.now(), deps.budgetMs, deps.startupMarginMs);
  if (!budget.ok) return budget;
  let na: NextAction;
  try {
    na = await deps.readNext(job.run_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "unreadable", detail: `next-action 조회 실패: ${msg}` };
  }
  if (!isGenerateTurn(na, job.stage)) {
    return {
      ok: false,
      reason: "transitioned",
      detail: `그 단계 생성 차례가 아님(현재 step=${String(na.step)} stage=${na.stage ?? "-"})`,
    };
  }
  return checkBudget(job, deps.now(), deps.budgetMs, deps.startupMarginMs); // 조회에 걸린 시간만큼 예산 재확인
}

// ── 클레임·정리(rename 기반) ───────────────────────────────────────────────────

/**
 * 클레임 = `rename(pending/X → claimed/<consumer>/X)`. **경합의 승자는 OS 가 정한다**: 동시에 집으면 rename 이
 *   하나만 성공하고 나머지는 원본이 사라져 ENOENT → null(깨끗한 패배). 승자만 그 잡을 만진다.
 * @returns 승자면 claimed 경로, 패자·이미 없어짐이면 null.
 */
export async function claimJob(
  dirs: JobDirs,
  job: GenerateJobFile,
  consumerId: string,
): Promise<string | null> {
  assertConsumerId(consumerId);
  const name = jobFileName(job.run_id, job.stage);
  const destDir = join(dirs.claimed, consumerId);
  await mkdir(destDir, { recursive: true });
  const to = join(destDir, name);
  try {
    await rename(join(dirs.pending, name), to);
    return to;
  } catch (e) {
    if (isEnoent(e)) return null; // 누가 먼저 집었거나 봇이 회수함 — 정상 패배.
    throw e;
  }
}

/** 성공 = 잡 파일 삭제(수명주기 종료). 이미 없으면 no-op(멱등). */
export async function completeJob(claimedPath: string): Promise<void> {
  try {
    await unlink(claimedPath);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

/**
 * 실패 = `failed/X` + 사유 파일(`X.reason`). 부분 성공은 없다 — 실패한 잡은 큐에서 빠지고 사람이 본다.
 *
 * 순서: **잡을 먼저 옮기고 사유를 쓴다.** 반대로 하면(사유 먼저) 사유 파일 경로가 잡보다 먼저 존재해, 같은 잡을
 *   처분하려던 다른 호출이 자기 실패를 정리하며 **승자의 사유 파일을 지운다**(사유 없는 실패 잡). 이 순서면 진 쪽은
 *   아무것도 쓰지 않는다. 남는 위험은 '옮긴 직후 죽어 사유가 안 써지는' 창(µs)뿐이고, 그건 사유 없는 실패 잡 하나로
 *   그친다(파일은 남아 사람이 본다).
 *   ⚠ 검토 이력(㉢): 이 순서는 리뷰에서 **의도적으로 유지**하기로 했다 — 뒤집는 대안이 더 나쁘고(위), 나머지 대안은
 *     값이 더 비싸다(사람 규약 복잡화). 재검토 불필요.
 *   ⚠ 호출 전제: **그 잡을 소유한 상태**(클레임 승자)여야 한다 — takePendingJob 은 클레임 뒤에만 부른다.
 *   ⚠ 알려진 한계: failed 경로도 `<rid>-<stage>` 라, 같은 단계의 잡 둘이 **동시에 살아 있다가 둘 다 실패**하면
 *     나중 것이 앞의 기록을 덮는다(사유가 다른 실패를 가리킬 수 있다). 그 상황 자체가 이미 비정상이고(같은 단계를
 *     두 소비자가 동시에 생성 — core 락·멱등 게이트가 상태는 지킨다), 실패 기록 한 줄의 정확도 문제라 파일명에
 *     job_id 를 붙여 사람 규약(jobs/README 의 `mv … failed/`)을 복잡하게 만드는 대신 이 한계를 남긴다.
 * @returns failed 경로.
 */
export async function failJob(dirs: JobDirs, fromPath: string, reason: string): Promise<string> {
  const name = basename(fromPath);
  await mkdir(dirs.failed, { recursive: true });
  const dest = join(dirs.failed, name);
  await rename(fromPath, dest);
  await writeFile(`${dest}${REASON_SUFFIX}`, `${reason}\n`, "utf8");
  return dest;
}

/**
 * 클레임 해제 = pending 복귀. **쓰이는 자리는 하나뿐이다 — `takePendingJob` 이 일을 시작하기도 전에 물러설 때**
 *   (레거시·판단 불가·처분 중 IO 오류). 그 시점엔 세션이 없으므로 되돌려도 아무도 두 번 일하지 않는다.
 *
 * ★ **W4 계약(못 박는다): 세션이 뜬 뒤엔 절대 해제하지 않는다 — 그 뒤의 결말은 complete(성공)·fail(실패) 둘뿐이다.**
 *   일하는 중인 세션의 잡을 대기줄에 되돌리면 그 세션과 그 잡을 새로 집는 소비자가 **같은 런을 동시에 쓴다**
 *   (reaper 가 재큐를 버린 이유와 같다 — 되살릴 근거는 늘 '저쪽은 죽었을 것'이라는 추정이고, 추정은 펜스가 아니다).
 * ⚠ reaper 는 이 함수를 쓰지 않는다(마감 리스 — 재큐 개념 자체가 없다).
 *
 * **no-clobber**: 같은 이름의 새 잡이 이미 대기 중이면 그 새 잡(마감이 더 넉넉하다)을 옛 클레임으로 덮지 않고,
 *   이쪽을 버린다(중복 잡 제거). link+unlink 를 쓰는 이유 = rename 은 무조건 덮어써서 '있는지 보고 옮기기'의
 *   경합 창이 생기기 때문(`enqueueJob` 의 배타 생성도 같은 패턴이다).
 * @returns 실제로 복귀시켰으면 true, 새 잡이 있어 버렸으면 false.
 */
export async function releaseJob(dirs: JobDirs, claimedPath: string): Promise<boolean> {
  const name = basename(claimedPath);
  await mkdir(dirs.pending, { recursive: true });
  const dest = join(dirs.pending, name);
  try {
    await link(claimedPath, dest);
  } catch (e) {
    if (!isEexist(e)) throw e;
    await completeJob(claimedPath); // 새 잡이 이미 대기 중 — 고아는 중복이라 버린다.
    return false;
  }
  await completeJob(claimedPath); // 하드링크 성공 → 원본 링크 제거(= 이동 완료).
  return true;
}

/**
 * 봇 타임아웃 회수 — **자기 잡일 때만** pending 에서 거둬들인다(job_id 대조). 소비자가 이미 클레임했으면(파일 없음)
 *   no-op 이고, 같은 단계로 **새 잡이 다시 적재**됐으면(job_id 다름) 건드리지 않는다 — 남의 요청을 지우면 그 요청이 증발한다.
 *
 * **이 회수는 2차 방어다(1차는 마감 그 자체).** 봇이 타임아웃하는 순간은 정의상 `now ≥ expires_at` 이라, 남아 있는
 *   잡은 이미 만료다 — 어떤 소비자가 집으려 해도 2중 검사 ㉠에 걸려 failed/ 로 간다. 회수는 그 뻔한 결말을 앞당기는
 *   **정리**일 뿐이라 실패해도 안전하다(그래서 읽기 오류도 '회수 못 함'으로 환원한다).
 * ⚠ 읽기-후-삭제라 원자적이지 않다. 창이 좁게 유지되는 근거는 **적재자가 하나**라는 배치 전제다: pending/ 을 쓰는 것은
 *   봇뿐이고(Socket Mode 봇은 워크스페이스당 1 프로세스), 그 잡큐는 run 별 FIFO 라 같은 run 의 다음 생성 잡은 이
 *   execute 가 끝난 **뒤에** 적재된다. job_id 대조는 그 위의 2차 방어다. 봇을 다중화하려면(같은 jobs/ 를 공유하는
 *   2 프로세스) 이 회수도 클레임처럼 rename 기반으로 바꿔야 한다 — 다만 그 배치는 카드·잡 중복부터 깨진다.
 * @returns 실제로 회수했으면 true.
 */
export async function recallPendingJob(pendingDir: string, job: GenerateJobFile): Promise<boolean> {
  const path = join(pendingDir, jobFileName(job.run_id, job.stage));
  // 읽기 실패(권한·IO)는 '회수 못 함'으로 환원한다 — 봇의 타임아웃 보고를 fs 예외로 바꾸지 않는다(사람 문구가 사라진다).
  const cur = await readJobFile(path).catch(() => null);
  // job_id 는 v2 잡에만 있다 — 둘 다 '비지 않은 문자열'이고 같을 때만 자기 잡으로 인정(옛/변조 잡 오삭제 차단).
  if (!cur || !job.job_id || cur.job_id !== job.job_id) return false;
  try {
    await unlink(path);
    return true;
  } catch (e) {
    if (isEnoent(e)) return false; // 그 사이 누가 집었다 — 정상.
    throw e;
  }
}

/** 같은 run·stage 를 이미 집고 있는 클레임 1건(적재 차단 판정의 근거). */
export interface ClaimedJobRef {
  /** 클레임 경로(`claimed/<consumer>/<rid>-<stage>.json`). */
  path: string;
  /** 그 잡을 집은 소비자 id(= `claimed/` 밑 디렉터리명). */
  consumer: string;
  /** 집힌 잡 실물(이름이 아니라 이 내용이 그 소비자가 할 일이다). */
  job: GenerateJobFile;
  /** 절대 마감(ms). **null = 마감 미기재**(v1 레거시) — '만료'가 아니라 '알 수 없음'이다. */
  deadlineMs: number | null;
}

/**
 * **적재 차단 조회(봇 몫 · `enqueueJob` 2단계)** — 같은 run·stage 를 **마감이 아직 남은 소비자가 이미 집고 있는가**.
 *   있으면 그 클레임을, 없으면 null 을 낸다. non-null 이면 새 잡을 적재하지 않는다(in_progress).
 *
 * 왜 필요한가(이중 소비 구멍): 회수(recallPendingJob)는 `pending/` 만 본다 — 소비자가 이미 집었으면 회수에 실패하고
 *   봇은 실패 카드를 낸다. 그런데 core 는 그대로 그 단계 생성 차례라, [상태 다시 확인] → [다시 만들기] 가 **새 잡**을
 *   적재한다(파일명이 같아도 옛 잡은 `claimed/` 에 있어 덮이지 않는다). 그러면 두 소비자가 같은 런의 산출물을 동시에
 *   쓰고 돈도 두 번 든다. "[다시 만들기]는 클레임된 잡을 되살리지 않는다"는 v2 의 보증은 **같은 잡 파일**에만 참이라
 *   이 결말을 막지 못한다 — 막을 자리는 되살리기가 아니라 **적재 그 자체**다(enqueueJob 이 1단계 unlink 로 옛 잡을
 *   내린 **뒤** 이 조회를 부르므로, 여기서 보이는 클레임은 '이미 내구적으로 성립한 것' 전부다 — 그 근거는 enqueueJob 주석).
 *
 * 판정 규칙(마감이 기준 · 소비자 생사를 묻지 않는다 — 그건 reaper 의 지식이다):
 *   · 마감이 남음(`expires_at > now`) → **막는다**. 규약상 그 소비자는 마감까지 일할 권리가 있다.
 *   · 마감 지남 → 막지 않는다. 규약상 아무도 마감 뒤엔 일하지 않으므로(2중 검사 ㉠), 죽은 클레임 하나가 런을 영영
 *     묶어선 안 된다. 그 잡의 뒷정리는 reaper 몫이고 새 요청은 새 마감을 받는다.
 *   · **마감 미기재(v1 레거시) → 막는다(fail-closed)**. '죽었다'를 증명할 수 없어서다. 여기서 마감을 지어내면
 *     (예 '적재시각+상한') 사람이 손으로 소비 중인 잡을 봇이 죽은 것으로 단정한다 — 모르는 것을 아는 척하는 쪽이
 *     더 나쁘다. 그 잡이 끝나거나 사람이 치우면 곧 풀린다.
 *
 * ⚠ **이름으로만 찾는다**: claimJob 이 목적지 이름을 잡 내용에서 만들므로(`jobFileName(run_id, stage)`), 규약대로
 *   집힌 클레임은 반드시 이 이름으로 있다. 내용이 이름과 어긋나는 파일은 그 이름의 일감이 아니라 건너뛴다
 *   (listPendingJobs 와 같은 가드 — 하류가 canonical 이름을 쓴다).
 * ⚠ 읽기 실패(권한·IO)는 **던진다** — '클레임 없음'으로 위장하면 이 함수의 존재 이유(중복 적재 차단)가 조용히
 *   무력화된다. 막을지 말지는 호출부가 정한다(enqueueJob = unknown 으로 fail-closed). ENOENT(그 소비자는 이 잡을 안
 *   갖고 있음)·형태 불일치만 readJobFile 규약대로 '일감 아님'이다.
 *
 * ⚠ **'우리 잡은 빼고 본다'(옛 excludeJobId)는 없다**: 그건 적재 **뒤** 재검사 전용이었는데(그때 보이는 우리 잡은
 *   소비자가 제 일을 집어 간 정상이라 빼야 했다), 원자 대체(enqueueJob)는 적재 **전에** 한 번만 조회하므로 그 시점에
 *   우리 잡은 존재하지도 않는다 — 뺄 것이 없다. 보이는 클레임은 전부 남의 것이고, 전부 막을 근거다.
 */
export async function findBlockingClaimedJob(
  claimedDir: string,
  run_id: string,
  stage: string,
  nowMs: number,
): Promise<ClaimedJobRef | null> {
  const name = jobFileName(run_id, stage); // assertJobArgs 포함 — 경로 탈출은 fs 접촉 전에 거부
  let consumers: string[];
  try {
    consumers = (await readdir(claimedDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // 이름순 = 결정적 순서(여럿이 막아도 같은 것을 보고한다)
  } catch (e) {
    if (isEnoent(e)) return null; // claimed/ 없음 = 아무도 집지 않았다.
    throw e; // 권한·IO 오류를 '클레임 없음'으로 위장하지 않는다.
  }
  for (const consumer of consumers) {
    const path = join(claimedDir, consumer, name);
    const job = await readJobFile(path);
    if (!job || jobFileName(job.run_id, job.stage) !== name) continue;
    const deadlineMs = parseDeadline(job);
    if (deadlineMs !== null && deadlineMs <= nowMs) continue; // 마감 지남 = 산 클레임이 아니다.
    return { path, consumer, job, deadlineMs };
  }
  return null;
}

// ── 봇 진입점(적재 = 원자 대체) ────────────────────────────────────────────────

/** 적재가 만지는 두 면. 실패 격리는 적재의 일이 아니라 `failed` 를 요구하지 않는다(JobDirs 도 그대로 들어맞는다). */
export type EnqueueDirs = Pick<JobDirs, "pending" | "claimed">;

export interface EnqueueInput {
  run_id: string;
  stage: string;
  /** 봇 대기 상한(ms · config.bridgeTimeout). expires_at 의 원천. */
  timeoutMs: number;
}

/**
 * 적재 결과 — **적재자가 아는 결말은 이 셋뿐이다**:
 *   ok=true      → 우리 잡이 대기줄에 정확히 1건 있다. 봇은 `job.expires_at` 을 제 폴링 마감으로 쓴다(마감 단일 원천).
 *   in_progress  → 같은 run·stage 를 마감 남은 소비자가 이미 집고 있다 → **적재하지 않았다**.
 *   unknown      → **남이 일하는 중임을 배제하지 못했다** → 적재하지 않았다(fail-closed).
 *
 * 두 실패를 가르는 기준은 '확신'이다: in_progress 는 산 클레임을 **봤다**, unknown 은 **못 봤을 뿐 없다고 말할 수
 *   없다**. 사람에게 가는 문구가 달라지므로(모르는 것을 아는 척하지 않는다) 한 값으로 뭉개지 않는다.
 */
export type EnqueueResult =
  | { ok: true; job: GenerateJobFile; path: string }
  | { ok: false; reason: "in_progress" | "unknown" };

export interface EnqueueDeps {
  /** 현재시각(ms) — 주입(테스트 결정성). */
  now: () => number;
  /**
   * 배타 생성(3단계) 주입 — 기본 = link 기반 no-clobber(`createPendingExclusive`). 테스트가 EEXIST 경합을
   *   결정적으로 재현하는 **유일한 이음새**다: 진짜 EEXIST 는 이 프로세스 밖의 남이 그 찰나에 같은 이름을 만들어야
   *   생기는데, 그 순간을 안에서 흉내낼 방법이 없다(now() 처럼 주입으로만 붙잡힌다).
   */
  createExclusive?: (pendingDir: string, dest: string, job: GenerateJobFile) => Promise<boolean>;
}

/**
 * 배타 생성(no-clobber) — tmp 에 쓰고 `link` 로 목적지를 **잡는다**. rename 은 무조건 덮어써서 '있는지 보고 옮기기'의
 *   경합 창이 생기지만, link 는 목적지가 이미 있으면 EEXIST 로 진다(releaseJob 과 같은 패턴 · 원자성 원천은 OS).
 * @returns 우리가 목적지를 잡았으면 true, 이미 누가 있으면 false. tmp 는 이기든 지든 반드시 지운다(찌꺼기 금지).
 */
async function createPendingExclusive(pendingDir: string, dest: string, job: GenerateJobFile): Promise<boolean> {
  // tmp 는 '.' 로 시작 — listPendingJobs 가 건너뛴다(반쯤 쓰인 파일이 잡으로 보이지 않게).
  const tmp = join(pendingDir, `.${basename(dest)}.tmp-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  try {
    await link(tmp, dest);
    return true;
  } catch (e) {
    if (!isEexist(e)) throw e;
    return false;
  } finally {
    await unlink(tmp).catch(() => {}); // 이겼으면 링크 하나 줄이고(= 이동 완료), 졌으면 찌꺼기를 치운다.
  }
}

/**
 * **적재 1급 경로(봇 몫) = 원자 대체(supersede-then-create)**. 세 걸음으로만 잡을 낳는다:
 *   1) `unlink(pending/X)` — 옛 잡을 **시장에서 내린다**(ENOENT = 애초에 없었음 = 정상).
 *   2) `findBlockingClaimedJob` — 마감이 남은 클레임이 있으면 in_progress(적재 없음).
 *   3) 배타 생성(tmp → `link` → tmp 제거) — EEXIST 면 1)로 **한 번만** 되돌아간다.
 *
 * ★ **왜 이것이 이중 소비를 닫는가**(창을 좁히는 게 아니라 전제를 없앤다): 클레임은 오직 `pending/X` 에서만 태어난다
 *   (`rename(pending/X → claimed/C/X)` 말고 잡이 claimed 로 갈 길이 없다). 1) 이 그 파일을 원자적으로 없애므로 —
 *   unlink 와 소비자의 rename 은 커널이 직렬화해 **정확히 한쪽만 파일을 갖는다** — 어떤 클레임 시도든 둘 중 하나다:
 *     ㉮ unlink **전에 이미 성공했다** → 그 클레임은 2) 의 readdir 시점에 `claimed/` 에 **내구적으로 보인다** → 막는다.
 *     ㉯ unlink **뒤에 시도한다** → 원본이 없어 ENOENT 로 진다(빈손).
 *   즉 옛 결함 ㉠('검사 통과 → 그 직후 C1 이 옛 잡을 집음 → 봇이 새 잡을 씀 → C2 가 집음')의 **첫 걸음이 성립하지
 *   않는다**: 검사할 무렵엔 집힐 물건이 이미 없다. 그래서 적재 후 재검사·보상(옛 assertNobodyElseTookOver/withdraw)이
 *   필요 없다 — 그 보상은 제 자신도 실패할 수 있었고(C2 가 우리 잡을 먼저 집으면 회수 불가), 창이
 *   readdir+readFile+unlink 만큼 길었다.
 *
 * **1)~3) 사이에 `pending/X` 를 만들 수 있는 자**: 적재자는 봇 하나뿐이고(recallPendingJob 주석의 배치 전제 — Socket
 *   Mode 봇 = 워크스페이스당 1 프로세스 · 잡큐는 run 별 FIFO 라 같은 run 의 다음 적재는 이 execute 뒤다), 예외는
 *   `takePendingJob` 이 **일을 시작하기도 전에** 되돌리는 자기 클레임(releaseJob)뿐이다. 그것과 3) 이 부딪히면
 *   EEXIST → 1)로 한 번 되돌아가 그 잡까지 대체한다. 되돌려진 잡은 정의상 **아직 아무도 시작하지 않은 같은 일**이라
 *   더 신선한 것으로 대체하는 게 옳다. 그래서 재시도는 **1회면 족하다** — 2회째 EEXIST 는 '적재자가 봇 하나'라는
 *   전제가 깨졌다는 뜻이고(누군가 계속 같은 이름을 만든다), 그건 남이 일하는 중임을 배제하지 못한 것이라 unknown 이다.
 *
 * **정책(그대로 유지)**: 같은 이름의 옛 pending 잡은 **더 신선한 요청으로 대체**한다(같은 일의 옛 요청 · v1→v2 승격
 *   경로 포함 — jobs/README 'v1 레거시 잡' 절). 바뀐 것은 **기전**뿐이다: 덮어쓰기(rename) → 원자 제거 + 배타 생성.
 *   옛 잡을 **채택**(그대로 두고 기다리기)하지 않는 이유 = 그 잡의 마감은 남이 정한 것이라 봇의 폴링 마감이 정의되지
 *   않는다(마감 단일 원천이 깨진다).
 *
 * **오류 처리 원칙**: `unknown` 은 '**남이 일하는 중인지 판정하지 못했다**'는 뜻이지 '기록이 실패했다'가 아니다.
 *   1)·2) 의 IO 오류는 그 판정을 불가능하게 만들므로(옛 잡이 살아남아 언제든 집힐 수 있다 · 클레임을 못 본다)
 *   unknown 으로 막고, 3) 의 IO 오류(EEXIST 아님)는 판정에 모호함이 없는 순수 기록 실패라 **그대로 던진다**
 *   (아무것도 만들지 않았다). 두 실패를 뭉개면 호출부가 사람에게 할 말이 달라진다.
 *
 * ⚠ 전제(로컬 POSIX fs): rename·unlink·link 의 원자성과 **즉시 가시성**. `jobs/` 를 NFS/FUSE 에 두면 이 펜스는 깨진다.
 */
export async function enqueueJob(
  dirs: EnqueueDirs,
  input: EnqueueInput,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  assertJobArgs(input.run_id, input.stage);
  const name = jobFileName(input.run_id, input.stage);
  const dest = join(dirs.pending, name);
  const create = deps.createExclusive ?? createPendingExclusive;
  // 잡은 **한 번만** 만든다(재시도해도 같은 도장·같은 마감): 봇의 폴링 마감이 이 잡에서 나오므로 재시도마다 마감이
  //   자라면 '적재 1건 = 마감 1개'가 흔들린다. 1~3단계에 드는 시간은 마감(기본 900초)에 견줘 무시할 수준이다.
  const job = buildGenerateJob({
    run_id: input.run_id,
    stage: input.stage,
    enqueuedAtMs: deps.now(),
    timeoutMs: input.timeoutMs,
  });
  await mkdir(dirs.pending, { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 1) 원자 대체 1단계 — 옛 잡을 내린다. 이 뒤로 그 잡을 집을 수 있는 자는 없다(위 ㉯).
    try {
      await unlink(dest);
    } catch (e) {
      // ENOENT = 애초에 없었음(정상 · 대부분의 경우). 그 외(권한·IO)는 옛 잡이 **살아남았다**는 뜻이라 막는다:
      //   그대로 적재하면 옛 잡과 새 잡이 동시에 집힐 수 있다(우리가 없애려는 바로 그 결말).
      if (!isEnoent(e)) return { ok: false, reason: "unknown" };
    }
    // 2) 산 클레임 조회 — 여기서 보이는 것은 '1) 전에 이미 성립한 클레임' 전부다(위 ㉮).
    let blocking: ClaimedJobRef | null;
    try {
      blocking = await findBlockingClaimedJob(dirs.claimed, input.run_id, input.stage, deps.now());
    } catch {
      return { ok: false, reason: "unknown" }; // 조회 실패 = 판정 불가 → fail-closed.
    }
    if (blocking) return { ok: false, reason: "in_progress" };
    // 3) 배타 생성 — 이겼으면 대기줄의 그 이름은 우리 잡 하나뿐이다.
    if (await create(dirs.pending, dest, job)) return { ok: true, job, path: dest };
  }
  // 2회째 EEXIST — 단일 적재자 전제가 깨졌다(누가 계속 같은 이름을 만든다). 배제하지 못했으니 막는다.
  return { ok: false, reason: "unknown" };
}

// ── 소비자 진입점(집기) ────────────────────────────────────────────────────────

/** 잡 1건을 집으려는 시도의 결과. */
export type TakeAction =
  | "claimed" /** 2중 검사 통과 + rename 승리 → 이 소비자가 일한다(path 는 claimed 경로) */
  | "lost" /** 경합 패배·이미 사라짐 — 다른 소비자 몫(조용히 넘어간다) */
  | "failed" /** 만료·형식 오류 → failed/ 격리(+ .reason) */
  | "dropped" /** 전이 완료 → 잡 삭제(할 일이 이미 끝났다) */
  | "skipped"; /** 레거시(미클레임) · 판단 불가(복귀) — 일감으로 삼지 않는다 */

export interface TakeResult {
  action: TakeAction;
  reason: JobCheckReason;
  /** action="claimed" 일 때의 claimed 경로. */
  path?: string;
  detail?: string;
}

export interface TakeDeps extends DoubleCheckDeps {
  dirs: JobDirs;
  /** 이 소비자의 id(= `claimed/<consumerId>/` 디렉터리명 · 안전 토큰). */
  consumerId: string;
}

/**
 * **소비자 1급 경로** — pending 잡 1건을 집어 2중 검사를 걸고 그 결과대로 처분한다(사람 소비자도 같은 규약을 손으로 따른다):
 *   통과 → 그대로 보유(작업) · 만료 → failed/ · 전이완료 → 삭제 · 레거시/판단불가 → 대기줄 복귀.
 *   검사 실패 잡을 그냥 두지 않고 **처분까지** 하는 이유: 남겨두면 다음 회차마다 같은 검사·spawn 을 되풀이하고
 *   사람 눈에도 '대기 중'으로 보인다(큐가 거짓말을 한다).
 *
 * ★ 순서가 핵심 — **먼저 집고(claim), 집은 것을 검사한다.** 반대로 하면(검사 후 집기) 검사한 잡과 집은 잡이 다를 수
 *   있다: rename 은 잡이 아니라 **경로**를 집는데, 그 사이 같은 이름으로 새 잡이 들어올 수 있기 때문이다. 그러면
 *   ㉠ 검사 안 한 잡을 들고 일하거나 ㉡ 멀쩡한 새 잡을 남의 판정으로 failed/ 에 처박는다. 소유한 뒤 검사하면 검사
 *   대상과 처분 대상이 같음이 보장되고(경합 패배자는 아무것도 만지지 않는다), 느린 next-action 조회 동안 예산이
 *   닳는 문제도 같이 사라진다(검사 시각이 소유 이후다).
 *   예외 하나 — **v1 레거시는 집지도 않는다**: 마감이 없다는 건 파일만 보고 알 수 있고(셸 0), 집었다 되돌리면 사람이
 *   손으로 소비 중인 파일을 매 회차 흔들게 된다(contract: 레거시는 사람 몫).
 */
export async function takePendingJob(job: GenerateJobFile, deps: TakeDeps): Promise<TakeResult> {
  assertJobArgs(job.run_id, job.stage);
  // 0) 순수 사전 필터(파일만 보고 판단 · fs 접촉 0): 레거시 잡은 애초에 집지 않는다.
  if (parseDeadline(job) === null) {
    return { action: "skipped", reason: "no_deadline", detail: "expires_at 미기재(v1 레거시 잡) — 사람 소비자 몫" };
  }
  // 1) 집는다(경합의 승자는 OS 가 정한다).
  const path = await claimJob(deps.dirs, job, deps.consumerId);
  if (path === null) return { action: "lost", reason: "ok" };
  try {
    // 2) 집은 **실물**을 읽는다 — 검사도 처분도 이 실물에 대해서만 한다(목록의 잡은 '뭔가 있다'는 힌트일 뿐).
    const mine = await readJobFile(path);
    if (!mine) {
      await failJob(deps.dirs, path, "잡 파일을 읽을 수 없음(형식 오류)");
      return { action: "failed", reason: "unreadable", detail: "잡 파일 형식 오류" };
    }
    // 3) 2중 검사 → 처분. 판정 불가·레거시면 되돌린다(버리지 않는다 — 다음 회차·사람이 다시 본다).
    const check = await doubleCheckJob(mine, deps);
    const detail = check.detail ? { detail: check.detail } : {};
    if (check.ok) return { action: "claimed", reason: "ok", path };
    if (check.reason === "expired") {
      await failJob(deps.dirs, path, check.detail ?? "만료(expires_at 초과)");
      return { action: "failed", reason: check.reason, ...detail };
    }
    if (check.reason === "transitioned") {
      await completeJob(path); // 이미 됐다 → 재실행 금지.
      return { action: "dropped", reason: check.reason, ...detail };
    }
    // no_deadline(사전 필터 뒤 바뀐 경우) · unreadable — **아직 일을 시작하기 전**이라 되돌려도 아무도 두 번 일하지
    //   않는다(releaseJob 의 W4 계약이 허용하는 유일한 자리). 세션이 뜬 뒤라면 여기서도 complete/fail 만 했어야 한다.
    await releaseJob(deps.dirs, path);
    return { action: "skipped", reason: check.reason, ...detail };
  } catch (e) {
    // 소유한 채 판단·처분에 실패하면(IO 오류 등) 대기줄로 되돌리고 예외를 올린다. 안 그러면 그 잡은 살아 있는
    //   소비자의 claimed/ 에 갇힌다 — reaper 는 산 소비자의 클레임을 건드리지 않으므로 재기동 전까지 아무도 못 집는다
    //   (고아가 아니라 '실종'이라 더 나쁘다). 되돌리기 실패는 삼킨다 — 원래 원인을 가리면 안 된다.
    await releaseJob(deps.dirs, path).catch(() => {});
    throw e;
  }
}

// ── reaper(마감 지난 클레임 뒷정리) ────────────────────────────────────────────

export interface ReapDeps {
  dirs: JobDirs;
  /** 현재시각(ms) — 주입(테스트 결정성). */
  now: () => number;
  /** next-action 조회(읽기 전용) — **마감이 지난** 클레임의 처분(뒷정리냐 만료 격리냐)만 가른다. */
  readNext: (rid: string) => Promise<NextAction>;
}

export interface ReapResult {
  path: string;
  consumer: string;
  /**
   * leased    = 마감이 남았다 → **불가침**(손대지 않는다)
   * completed = 마감 지남 + 이미 전이됨 → 잡 삭제(뒷정리)
   * failed    = 마감 지남 + 아직 그 단계 생성 차례 → failed/ 격리(+.reason) · 깨진 잡 파일도 여기
   * skipped   = v1(마감 미기재) · 판단 불가(next-action 조회 실패) · 목록에 잡힌 뒤 사라짐 → 손대지 않는다
   */
  action: "leased" | "completed" | "failed" | "skipped";
  /**
   * 판정 어휘(JobCheckReason) + reaper 고유 사유 둘:
   *   leased   = 마감이 남아 판정 자체를 하지 않았다
   *   vanished = **목록에 잡힌 뒤 사라졌다** — 멀쩡한 소비자가 그 사이 일을 마쳤거나(completeJob) 다른 pass 가
   *              이미 처분했다. `unreadable`(깨진 잡 = 사람이 봐야 한다)과 **뜻이 정반대**라 그 값을 재활용하지
   *              않는다: 하나는 정상 경합의 흔적이고 하나는 사람을 부르는 신호다.
   */
  reason: JobCheckReason | "leased" | "vanished";
  detail?: string;
}

/**
 * '목록에 잡힌 뒤 사라짐' 보고 1건(처분 없음 · 정상). readdir 로 이름을 본 **뒤의 모든 접촉**은 소비자의 정상 완료와
 *   경합하므로, reaper 는 이 결말을 오류가 아니라 결과의 한 종류로 보고한다.
 */
function vanishedResult(path: string, consumer: string): ReapResult {
  return {
    path,
    consumer,
    action: "skipped",
    reason: "vanished",
    detail: "목록에 잡힌 뒤 사라짐(소비자가 그 사이 끝냈거나 다른 pass 가 처분함) — 처분할 것이 없다",
  };
}

/**
 * reaper 의 격리 = **경합에 져도 pass 를 깨지 않는 failJob**. `failJob` 자체는 ENOENT 를 던져야 옳다
 *   (takePendingJob 은 자기가 소유한 잡을 옮기므로 원본이 사라지는 것이 진짜 이상 신호다). 반면 reaper 가 만지는 잡의
 *   주인은 **남**이라, rename 이 ENOENT 로 지는 것은 '그 소비자가 방금 정상적으로 끝냈다'는 뜻이다 — 오류가 아니다.
 *   ⚠ 삼키는 것은 ENOENT 하나뿐이다: EACCES·EIO 는 그대로 올린다. 진짜 오류를 조용한 skip 으로 바꾸는 것이 이
 *     결함의 **거울상**이고(머리말이 경계하는 바로 그것), 그러면 격리돼야 할 잡이 아무 흔적 없이 큐에 남는다.
 * @returns 실제로 격리했으면 true, 그 사이 사라졌으면 false.
 */
async function failJobUnlessGone(dirs: JobDirs, path: string, reason: string): Promise<boolean> {
  try {
    await failJob(dirs, path, reason);
    return true;
  } catch (e) {
    if (isEnoent(e)) return false; // 옮길 원본이 없다 = 그 잡은 이미 끝났다(정상).
    throw e;
  }
}

/**
 * 기동 reaper — `claimed/<소비자>/` 를 훑어 **마감이 지난** 클레임만 뒷정리한다. 처분은 마감(리스)이 정한다:
 *
 *   | 클레임 상태              | 처분                                                |
 *   |--------------------------|-----------------------------------------------------|
 *   | 마감이 남음              | **불가침**(leased) — 하트비트를 묻지도 않는다        |
 *   | 마감 지남 + 전이 완료    | 삭제(completed) — 이미 끝난 일의 흔적만 치운다       |
 *   | 마감 지남 + 아직 그 차례 | failed/ 격리(failed) — **재큐하지 않는다**           |
 *   | 마감 미기재(v1)          | 보고만(skipped) — 생사를 알 수 없는 것에 손대지 않는다 |
 *   | 그새 사라짐              | 보고만(skipped/vanished) — 처분할 것이 없다(아래 ★)  |
 *
 * ★ **한 잡의 정상 소멸이 pass 를 깨지 않는다.** 목록(readdir)은 스냅샷이라, 이름을 본 **뒤의 모든 접촉**(읽기·
 *   failJob·completeJob)은 '멀쩡한 소비자가 그 사이 제 일을 끝냈다'와 경합한다 — 그 잡의 주인은 우리가 아니다.
 *   그때의 ENOENT 는 오류가 아니라 **정상 결말**(vanished)이라 조용히 넘기고 그렇게 보고한다. 여기서 예외를 올리면
 *   'reaper 를 먼저 돌린 뒤 폴링'(아래 호출 순서 규약) 때문에 **소비자 기동 자체가** 남의 정상 완료 하나로 실패한다.
 *   ⚠ 그 반대도 금물이다: **삼키는 것은 ENOENT 뿐**이고 EACCES·EIO 는 그대로 올린다(진짜 오류를 조용한 skip 으로
 *     바꾸면 격리돼야 할 잡이 흔적 없이 큐에 남는다 — readJobFile 머리말의 경고와 같은 축).
 *
 * ★ **생사 추정은 펜스가 아니다**(이 재작성의 이유). 옛 구현은 `isConsumerAlive()===false` 를 '죽음'으로 믿고 잡을
 *   재큐했는데, **하트비트 정지 ≠ 죽음**이다(멈췄다 재개하는 소비자 · 느린 소비자 · 하트비트만 끊긴 소비자). 그
 *   추정이 한 번 틀리면 원 소비자와 재큐된 잡을 집은 새 소비자가 **같은 런을 동시에 쓴다** — 이중 소비를 막아야 할
 *   reaper 가 그 원천이 된다. 그래서 판정 근거를 '누가 살아 있나'(추정)에서 **'마감이 남았나'(파일에 박힌 사실)** 로
 *   바꿨다. 적재 차단(findBlockingClaimedJob)이 쓰는 규칙과 **같은 규칙**이다 — 한 잡의 생사를 두 곳이 다르게
 *   판정하면 한쪽이 반드시 틀린다. (하트비트는 폐기가 아니라 **강등**이다: W4 의 관측성·로그 몫이지 처분 근거가 아니다.)
 *
 * ★ **재큐를 버린 이유**: 되돌린 잡에는 새 마감이 필요한데 마감을 발행하는 자는 봇뿐이다(마감 단일 원천). reaper 가
 *   마감을 지어내면 그 잡의 마감과 봇의 대기 마감이 갈라진다. 게다가 정규 복구 경로가 **이미 있다** — 만료된 클레임은
 *   적재를 막지 않으므로(위와 같은 규칙) 봇의 자동 이어가기·[다시 만들기] 가 **새 마감을 단 새 잡**을 적재한다.
 *   reaper 가 할 일은 큐가 거짓말하지 않게 흔적을 치우는 것뿐이다.
 *
 * ⚠ 예산(budgetMs·startupMarginMs)을 받지 않는다: 예산은 '지금 시작해서 끝낼 수 있나'를 묻는 값인데 reaper 는
 *   **아무에게도 일을 주지 않는다**(재큐 없음). 물을 것이 없으므로 요구하지 않는다.
 * ⚠ 호출 순서 규약: 소비자는 **기동 시 이 reaper 를 먼저 돌린 뒤 폴링을 시작한다**. 지난 생의 고아
 *   (`claimed/<자기 id>/`)를 남겨 둔 채 새로 집으면 같은 이름의 클레임을 자기가 덮어써 그 기록을 잃는다.
 */
export async function reapClaimedJobs(deps: ReapDeps): Promise<ReapResult[]> {
  // 시각은 pass 당 **한 번**만 읽는다: 스캔 도중 시계가 흐르면 같은 리스가 파일마다 다르게 판정된다(어중간한 상태).
  //   스냅샷이 낡아 봐야 방금 만료된 리스를 'leased'(불가침)로 볼 뿐이라 늘 안전한 쪽으로 틀린다 — 다음 pass 가 치운다.
  const nowMs = deps.now();
  let consumers: string[];
  try {
    consumers = (await readdir(deps.dirs.claimed, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if (isEnoent(e)) return []; // claimed/ 없음 = 고아 없음.
    throw e; // 권한·IO 오류를 '고아 없음'으로 위장하지 않는다.
  }
  const out: ReapResult[] = [];
  for (const consumer of consumers) {
    const dir = join(deps.dirs.claimed, consumer);
    // ENOENT = 그 사이 비워짐(정상). 그 외 오류는 '잡 없음'으로 위장하지 않고 올린다.
    const names = (
      await readdir(dir).catch((e: unknown) => {
        if (isEnoent(e)) return [] as string[];
        throw e;
      })
    ).sort();
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      const path = join(dir, name);
      const read = await readJobFileWithCause(path);
      if (!read.job) {
        if (read.cause === "gone") {
          // ★ 목록(readdir) 이후 사라짐 = **정상 경합**이지 깨진 잡이 아니다: 멀쩡한 소비자가 그 사이 일을 마쳐
          //   잡을 지웠거나(completeJob) 다른 pass 가 이미 처분했다. 이걸 '읽을 수 없음 = 깨짐'으로 뭉뚱그리면
          //   failJob 의 rename 이 ENOENT 로 터져 **pass 전체가 거부**되고, 기동 시 reaper 를 먼저 돌리는 소비자는
          //   (호출 순서 규약 — 아래) 남의 정상 완료 하나 때문에 뜨지 못한다. 그래서 조용히 넘기고 그렇게 보고한다.
          out.push(vanishedResult(path, consumer));
          continue;
        }
        // 파일은 있는데 잡이 아니다 = 깨진 잡 파일 → 마감을 읽을 수 없다 = 리스를 존중할 근거도 없다 → 사람이 보게
        //   failed/ 로(큐에 남겨 되풀이 읽지 않는다). 리스 존중의 예외지만 안전하다: 읽을 수 없는 파일은 소비자도
        //   일감으로 삼지 못한다. 격리 도중 사라지는 것 역시 정상이다(그 사이 사람이 치웠다).
        const moved = await failJobUnlessGone(deps.dirs, path, "잡 파일을 읽을 수 없음(형식 오류)");
        out.push(
          moved
            ? { path, consumer, action: "failed", reason: "unreadable", detail: "잡 파일 형식 오류" }
            : vanishedResult(path, consumer),
        );
        continue;
      }
      const job = read.job;
      const deadlineMs = parseDeadline(job);
      if (deadlineMs === null) {
        // v1 레거시 — 마감이 없으니 리스가 살았는지 죽었는지 **알 수 없다**. 모르는 것에 손대지 않는다(사람 몫).
        //   옛 구현은 이걸 대기줄로 되돌렸는데, 사람이 손으로 소비 중인 파일을 매 pass 마다 흔드는 짓이었다.
        out.push({
          path,
          consumer,
          action: "skipped",
          reason: "no_deadline",
          detail: "expires_at 미기재(v1 레거시 잡) — 생사 판정 불가 · 사람 소비자 몫",
        });
        continue;
      }
      if (deadlineMs > nowMs) {
        // 리스가 살아 있다 → **불가침**. 하트비트가 끊겼든 말든 그 소비자는 마감까지 일할 권리가 있다
        //   (적재 차단과 같은 규칙 — findBlockingClaimedJob).
        out.push({ path, consumer, action: "leased", reason: "leased" });
        continue;
      }
      // 마감 지남 — 규약상 아무도 마감 뒤엔 일하지 않는다(2중 검사 ㉠). 남은 물음은 '뒷정리냐 만료 격리냐' 하나뿐이라
      //   여기서만 next-action 을 부른다(산 리스에는 셸 비용을 쓰지 않는다).
      let na: NextAction;
      try {
        na = await deps.readNext(job.run_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 조회 실패 = 판단 불가 → 손대지 않는다(다음 pass 재시도). 조회 실패로 잡을 처분하지 않는다.
        out.push({ path, consumer, action: "skipped", reason: "unreadable", detail: `next-action 조회 실패: ${msg}` });
        continue;
      }
      if (!isGenerateTurn(na, job.stage)) {
        // 늦게라도 전이됐다 → 다 끝난 일의 흔적만 치운다. completeJob 은 ENOENT 를 no-op 으로 삼키므로(멱등) 그새
        //   소비자가 제 손으로 지웠어도 결말이 같다(흔적 없음) — 여기선 따로 감쌀 것이 없다.
        await completeJob(path);
        out.push({
          path,
          consumer,
          action: "completed",
          reason: "transitioned",
          detail: `그 단계 생성 차례가 아님(현재 step=${String(na.step)} stage=${na.stage ?? "-"})`,
        });
        continue;
      }
      // 마감이 지났는데 전이도 안 됐다 = 그 소비자는 못 끝냈다. **재큐하지 않는다** — 되돌린 잡엔 새 마감이 필요한데
      //   마감은 봇만 발행한다. 복구는 새 요청(새 마감)의 몫이고, 만료된 이 클레임은 그 적재를 막지 않는다.
      //   ⚠ 여기도 경합한다: 읽기·next-action 조회 사이에 소비자가 아슬아슬하게 끝냈으면 옮길 원본이 없다(정상).
      const moved = await failJobUnlessGone(
        deps.dirs,
        path,
        `만료(마감 ${String(job.expires_at)} · 지금 ${new Date(nowMs).toISOString()}) — 마감까지 전이되지 않음`,
      );
      out.push(
        moved
          ? {
              path,
              consumer,
              action: "failed",
              reason: "expired",
              detail: "마감이 지난 채 전이되지 않음 — 재큐하지 않는다(새 요청이 새 마감을 받는다)",
            }
          : vanishedResult(path, consumer),
      );
    }
  }
  return out;
}
