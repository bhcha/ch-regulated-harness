/**
 * worker.ts — 잡 1건을 core scripts 쓰기 동작으로 환원하는 워커.
 *
 * 역할: JobQueue 가 run별 FIFO 로 넘긴 Job 을 kind 에 따라 harness-cli 쓰기 래퍼(approve/select/...)나
 *   주입된 GenExecutor(생성)로 위임하고, 결과를 현업 회신용 WorkerOutcome 으로 돌려준다.
 *
 * 불변식(dev-loop-grounding 3): state.json 직접 쓰기 0 — 워커는 harness-cli(=core scripts spawn)와
 *   GenExecutor 로만 상태를 변이한다. 워커 자체는 state 파일을 만지지 않는다.
 *
 * 격리·주입: harness-cli 함수 묶음(HarnessCli)·GenExecutor·readNext·isApprover 를 모두 생성자 주입으로 받는다
 *   → 테스트가 fake 로 교체해 네트워크·셸 없이 매핑/가드/메시지 로직만 검증한다.
 *
 * 안전:
 *   · 상태변이 잡(approve/select/revise)은 실행 전 isApprover(actor) 가드 — 비승인자면 셸 미호출로 거부.
 *   · harness 비-0 종료·내부 예외는 '평이 메시지'로만 회신한다(종료코드·stderr·스택 등 내부 노출 금지).
 *     진단용 원문은 outcome.detail(로그 전용 · 카드 비노출)에만 담는다.
 *   · 완료 후 readNextAction 으로 '다음 할 일'을 outcome.next 에 담는다(읽기 실패는 결과를 뒤엎지 않음 → null).
 */
import { readNextAction } from "./contract-client.js";
import { GenerationInProgressError } from "./gen-executor.js";
import {
  approve as defaultApprove,
  ingestBundle as defaultIngestBundle,
  intake as defaultIntake,
  kciaCheck as defaultKciaCheck,
  raiseLimit as defaultRaiseLimit,
  revise as defaultRevise,
  runStage as defaultRunStage,
  select as defaultSelect,
  type ApproveOpts,
  type HarnessResult,
  type IngestBundleOpts,
  type IntakeOpts,
  type ReviseOpts,
  type SelectOpts,
} from "./harness-cli.js";
import { isApprover as defaultIsApprover } from "../config.js";
import type { NextAction } from "../types/contract.js";
import type { GenExecutor, Job, JobKind } from "../types/jobs.js";

/**
 * core scripts 쓰기 래퍼 묶음. 기본 구현은 실제 harness-cli(spawnSync) 함수들이고,
 * 테스트는 같은 시그니처의 fake 를 주입해 셸 없이 인자 매핑을 검증한다.
 */
export interface HarnessCli {
  approve(rid: string, opts: ApproveOpts): Promise<HarnessResult>;
  select(rid: string, key: string, opts: SelectOpts): Promise<HarnessResult>;
  revise(rid: string, reason: string, opts: ReviseOpts): Promise<HarnessResult>;
  raiseLimit(rid: string): Promise<HarnessResult>;
  ingestBundle(bundleDir: string, rid: string, opts?: IngestBundleOpts): Promise<HarnessResult>;
  intake(attachDir: string, rid: string, opts: IntakeOpts): Promise<HarnessResult>;
  /** run-stage 생성 전용(gen-executor 경로). raise-limit 는 raiseLimit 브리지로 옮겨 여기서 쓰지 않는다. */
  runStage(stage: string, rid: string): Promise<HarnessResult>;
  kciaCheck(rid: string): Promise<HarnessResult>;
}

/** '다음 할 일' 읽기 함수(기본 = 실제 readNextAction spawn). 테스트가 fake 주입. */
export type ReadNextFn = (rid: string) => Promise<NextAction>;

/** 워커 의존성(모두 주입 가능). gen 만 필수 — 이 스테이지에는 실 GenExecutor 기본구현이 없다(병렬 Stage H 소유). */
export interface WorkerDeps {
  /** 생성(run-stage) 위임 대상. 필수. */
  gen: GenExecutor;
  /** core scripts 쓰기 래퍼. 기본 = 실제 harness-cli. */
  cli?: HarnessCli;
  /** 다음 할 일 읽기. 기본 = 실제 readNextAction. */
  readNext?: ReadNextFn;
  /** 승인자 판정. 기본 = config.isApprover. */
  isApprover?: (actor: string) => boolean;
}

/**
 * 워커 처리 결과 — F2(어댑터)가 카드 edit 에 쓴다.
 *   ok      : 잡이 반영됐는지(승인거부·비-0 종료·예외 = false)
 *   message : 현업 회신용 평이 문구(내부 종료코드·경로·스택 비노출)
 *   next    : 완료 후 '다음 할 일'(readNextAction). 읽기 실패 시 null
 *   detail  : 진단용 원문(로그 전용 · 사용자 카드 비노출). 성공 시 생략.
 */
export interface WorkerOutcome {
  ok: boolean;
  kind: JobKind;
  run_id: string;
  message: string;
  next: NextAction | null;
  detail?: string;
}

/** 실행 전 승인자 가드가 필요한 상태변이 잡. (생성·인입·심의·한도상향은 게이트 대상 아님 — 요건 명시.) */
// 승인자(allowlist) 확인이 필요한 상태변이 잡. raise-limit 는 에스컬레이션(하드스톱=사람 개입 게이트)을
//   해제해 보완 한도를 올리는 소비적 동작이라 반드시 승인자만 — 비승인자 우회 금지.
const MUTATING: ReadonlySet<JobKind> = new Set<JobKind>(["approve", "select", "revise", "raise-limit", "intake"]);

// generate 경로가 허용하는 '생성 단계'(default-deny). 출처 = core stage-phase-map.json 의 phase_to_stage 값
//   전체(intake·evidence·guideline·brief·concept·keyvisual) + 03-storyboard 서브스테이지(outline/plan).
//   run-stage 제어 verb(raise-limit·emit-context)는 여기 없으므로 generate 로 위장해 스머글링될 수 없다(승인 가드 우회 차단).
const GENERATION_STAGES: ReadonlySet<string> = new Set<string>([
  "intake",
  "evidence",
  "guideline",
  "brief",
  "concept",
  "storyboard-outline",
  "storyboard-plan",
  "keyvisual",
]);

/** 성공 시 평이 회신(kind별). */
const OK_MESSAGES: Record<JobKind, string> = {
  generate: "생성을 마쳤습니다.",
  approve: "승인 처리했습니다.",
  select: "선택을 반영했습니다.",
  revise: "보완 요청을 전달했습니다.",
  ingest: "자료를 불러왔습니다.",
  intake: "첨부 자료를 불러왔습니다.",
  review: "규정 점검을 마쳤습니다.",
  "raise-limit": "보완 한도를 올렸습니다.",
};

/** 실패(비-0/예외) 시 평이 회신(kind별) — 내부코드·stderr 를 대신하는 사람 문구. */
const FAIL_MESSAGES: Record<JobKind, string> = {
  generate: "생성을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.",
  approve: "승인을 반영하지 못했습니다. 현재 상태를 확인해 주세요.",
  select: "선택을 반영하지 못했습니다. 현재 상태를 확인해 주세요.",
  revise: "보완 요청을 반영하지 못했습니다. 현재 상태를 확인해 주세요.",
  ingest: "자료 불러오기를 마치지 못했습니다. 자료 폴더를 확인해 주세요.",
  intake: "첨부 자료 불러오기를 마치지 못했습니다. 자료를 확인해 주세요.",
  review: "규정 점검을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "raise-limit": "보완 한도 상향을 반영하지 못했습니다. 현재 상태를 확인해 주세요.",
};

/** 권한 없는 상태변이 요청 거부 문구(평이). */
const MSG_NO_PERMISSION =
  "이 작업을 승인할 권한이 없어 처리하지 않았습니다. 담당자에게 요청해 주세요.";

/**
 * 우리가 만든 '입력 부족' 오류 — 메시지가 평이한 한국어라 사용자에게 그대로 노출해도 안전.
 * (harness-cli/gen 등 제3자 예외는 내부 노출 위험이 있어 FAIL_MESSAGES 로 치환한다.)
 */
class BadJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadJobError";
  }
}

/** 필수 문자열 payload 추출 — 없으면 노출안전한 BadJobError. */
function requireStr(v: unknown, label: string): string {
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new BadJobError(`${label} 정보가 없어 처리할 수 없습니다.`);
}

/** 선택 문자열 payload 추출(빈 문자열/비문자열 = 미지정). */
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 원 게이트 서명 결박(P2) — 재적재 리뷰 잡(attempt>0)의 stale 가드 보강.
 *   flow 의 지연 재적재가 스케줄 시점의 게이트 서명(phase·stage·iteration)을 payload 에 실으면, 워커도 현재 게이트가
 *   **정확히 같은 게이트**일 때만 진행한다. action==="review" 재확인만으로는 백오프 중 다음 페이즈의 review 로 전진한
 *   경우를 못 거른다 — 옛 게이트 재시도가 나중 게이트로 승계돼 정규 리뷰와 중복될 수 있다(그래서 서명까지 본다).
 *   서명 부재(구형 잡 — phase 미기재)는 후방호환으로 항상 true(기존 action-만 검사로 폴백).
 */
function gateSignatureMatches(job: Job, na: NextAction): boolean {
  const sigPhase = job.payload.phase;
  if (typeof sigPhase !== "string") return true; // 서명 없음 = 구형 잡 → action-만 검사(후방호환)
  const sigStage = asStr(job.payload.stage) ?? null; // review 게이트 stage 는 null(정규화 비교)
  const sigIter = typeof job.payload.iteration === "number" ? job.payload.iteration : null;
  return sigPhase === na.phase && sigStage === (na.stage ?? null) && sigIter === (na.iteration ?? null);
}

/** 로그용 원문 꼬리(과다 방지 상한). */
function tail(s: string, n = 800): string {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(-n) : t;
}

/** 기본 harness-cli 묶음(실제 spawn 래퍼). */
const DEFAULT_CLI: HarnessCli = {
  approve: defaultApprove,
  select: defaultSelect,
  revise: defaultRevise,
  raiseLimit: defaultRaiseLimit,
  ingestBundle: defaultIngestBundle,
  intake: defaultIntake,
  runStage: defaultRunStage,
  kciaCheck: defaultKciaCheck,
};

/**
 * Worker — 잡 1건을 처리한다(순수 위임 · 상태 직접쓰기 없음).
 * JobQueue 가 run별 FIFO 로 process(job) 를 호출한다. process 는 정상 흐름에서 예외를 던지지 않고
 * 항상 WorkerOutcome 으로 환원한다(예외는 내부에서 흡수 → 큐 체인이 깨지지 않게).
 */
export class Worker {
  private readonly gen: GenExecutor;
  private readonly cli: HarnessCli;
  private readonly readNext: ReadNextFn;
  private readonly isApprover: (actor: string) => boolean;

  constructor(deps: WorkerDeps) {
    this.gen = deps.gen;
    this.cli = deps.cli ?? DEFAULT_CLI;
    this.readNext = deps.readNext ?? ((rid: string): Promise<NextAction> => readNextAction(rid));
    this.isApprover = deps.isApprover ?? defaultIsApprover;
  }

  async process(job: Job): Promise<WorkerOutcome> {
    const { kind, actor } = job;

    // 상태변이 잡: 승인자 아니면 실행 전 거부(셸 미호출).
    if (MUTATING.has(kind) && !this.isApprover(actor)) {
      return this.finalize(job, false, MSG_NO_PERMISSION);
    }

    // stale ingest 방어(fail-CLOSED): ingest-bundle.sh 는 기존 run 을 받아 상태를 인입(00-ingest)으로 되돌려쓴다
    //   (core/scripts/ingest-bundle.sh 185행). 하류로 진행한 런에 재생/지연된 업로드가 실행되면 진행분이 리셋된다.
    //   다른 kind 와 달리 core 에는 ingest 를 막는 현재-단계 게이트가 없어 멱등 필터가 stale 을 못 거른다 — 그래서
    //   여기서 막아야 한다. → '지금이 인입 차례'임을 **적극 확인**했을 때만 진행한다. 읽기 실패(throw→null)나 다른
    //   action 이면 차단한다: 정당한 인입이 일시적 읽기 실패로 막히는 건 재시도로 복구되지만, stale 인입이 하류 런을
    //   조용히 덮어쓰는 건 복구 불가라 파괴적 비용이 훨씬 크다(read 실패 시 진행=core 위임은 이 kind 엔 오답).
    if (kind === "ingest") {
      const na = await this.readNext(job.run_id).catch(() => null);
      if (!na) {
        return this.finalize(
          job,
          false,
          "지금 상태를 확인하지 못해 자료 불러오기를 멈췄습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      if (na.action !== "ingest") {
        return this.finalize(job, false, "이미 지난 단계예요 — 지금은 자료 불러오기 차례가 아닙니다.");
      }
    }

    // stale-review 안전망(fail-CLOSED · ingest 가드와 같은 결): RE-ENQUEUE 된 리뷰 잡(attempt>0)만 대상이다.
    //   최초 리뷰(attempt 부재/0)는 이 블록을 건너뛰어 기존 동작이 바이트 동일하게 보존된다. 재적재된 재시도가
    //   게이트가 이미 전진한 뒤(캐스케이드/수동 전이) 도착하면 엉뚱한 단계에 stale kciaCheck 를 돌려선 안 된다 —
    //   그래서 '지금이 심의 차례'임을 적극 확인하고(read 실패/다른 action) 아니면 셸(runCli/kciaCheck) 미호출로
    //   벤인 no-op 회신한다. ok:false 로 두는 건 의도적이다: ok:true 면 성공/verdict 표시 경로로 라우팅돼 워커가
    //   내지 않은 판정을 지어낼 수 있고, ok:false + 벤인 문구는 flow.onOutcome 에서 재시도 비대상(next.action≠review)
    //   이라 루프 없이 깨끗이 종료된다.
    if (kind === "review" && typeof job.payload.attempt === "number" && job.payload.attempt > 0) {
      const na = await this.readNext(job.run_id).catch(() => null);
      // 심의 차례가 아니면(read 실패/action≠review) 또는 원 게이트 서명 불일치면 셸 미호출 벤인 스킵.
      if (!na || na.action !== "review" || !gateSignatureMatches(job, na)) {
        return this.finalize(job, false, "이미 점검이 끝났어요 — 지금은 점검 차례가 아니에요.");
      }
    }

    try {
      // generate 는 HarnessResult 가 아니라 GenExecutor(예외=실패)로 위임.
      if (kind === "generate") {
        const stage = requireStr(job.payload.stage, "생성할 단계");
        // ⚠ default-deny: generate 경로는 '생성 단계'만 허용한다. run-stage 제어 verb(raise-limit 등)를
        //   stage 로 넣어 승인 가드(MUTATING)를 우회하는 스머글링 차단(변조 잡 방어).
        if (!GENERATION_STAGES.has(stage)) {
          throw new BadJobError(`생성할 수 없는 단계입니다: ${stage}`);
        }
        await this.gen.execute(job.run_id, stage);
        return await this.finalize(job, true, OK_MESSAGES.generate);
      }

      // 나머지: core scripts 쓰기 래퍼(비동기 spawn — 이벤트 루프 블로킹 금지).
      const result = await this.runCli(job);
      if (result.code !== 0) {
        return await this.finalize(job, false, FAIL_MESSAGES[kind], tail(result.stderr));
      }
      return await this.finalize(job, true, OK_MESSAGES[kind]);
    } catch (e) {
      // 우리가 쓴 평이 문구(BadJobError·GenerationInProgressError)만 그대로 노출, 그 외 제3자 예외는 평이 문구로
      //   치환(내부 비노출). GenerationInProgressError 를 FAIL_MESSAGES 로 덮으면 "생성을 마치지 못했습니다"가 되는데
      //   그건 사실과 다르다 — 못 만든 게 아니라 다른 소비자가 지금 만들고 있어 중복 요청을 넣지 않은 것이다.
      const safeMessage =
        e instanceof BadJobError || e instanceof GenerationInProgressError ? e.message : FAIL_MESSAGES[kind];
      const detail = e instanceof Error ? e.message : String(e);
      return await this.finalize(job, false, safeMessage, detail);
    }
  }

  /** kind → harness-cli 쓰기 래퍼 매핑(generate 는 호출부에서 별도 처리). 각 래퍼는 비동기 spawn. */
  private runCli(job: Job): Promise<HarnessResult> {
    const { kind, run_id, actor, payload } = job;
    switch (kind) {
      case "approve":
        return this.cli.approve(run_id, {
          comment: asStr(payload.comment),
          // ⚠ 엄격 boolean — JSON 에서 온 truthy 비-boolean("false"·"0"·1 등)이 --ra-ok 로 새면 RA 게이트가
          //   우회된다(규제 통제). 정확히 true 일 때만 RA 확인으로 인정, 그 외엔 미확인 → core 가 fail-closed.
          raOk: payload.ra_ok === true,
          by: actor,
        });
      case "select":
        return this.cli.select(run_id, requireStr(payload.option, "선택한 옵션"), { by: actor });
      case "revise":
        return this.cli.revise(run_id, requireStr(payload.feedback, "보완 요청 내용"), { by: actor });
      case "ingest":
        return this.cli.ingestBundle(requireStr(payload.bundle_dir, "자료 폴더 경로"), run_id, {
          wbPath: asStr(payload.wb_path),
        });
      case "intake":
        // 00a-intake 정문(P3-2): 불변 스냅샷 폴더 + 사람 선언(제품명·도메인·포맷)으로 새 run 생성.
        return this.cli.intake(requireStr(payload.folder, "첨부 폴더 경로"), run_id, {
          product: requireStr(payload.product, "제품명"),
          domain: requireStr(payload.domain, "규제도메인"),
          format: requireStr(payload.format, "산출물 포맷"),
        });
      case "review":
        return this.cli.kciaCheck(run_id);
      case "raise-limit":
        // a2ui-action.sh 브리지 위임(run-stage raise-limit). runStage 직접 호출은 생성(gen-executor) 전용으로 남긴다.
        return this.cli.raiseLimit(run_id);
      default:
        // generate 는 process 에서 걸러지므로 여기 오면 미지 kind.
        throw new BadJobError(`처리할 수 없는 작업 종류입니다: ${String(kind)}`);
    }
  }

  /** 결과 확정 — 완료 후 '다음 할 일'을 읽어 담는다(읽기 실패는 결과를 뒤엎지 않음 → next=null). */
  private async finalize(
    job: Job,
    ok: boolean,
    message: string,
    detail?: string,
  ): Promise<WorkerOutcome> {
    let next: NextAction | null = null;
    try {
      next = await this.readNext(job.run_id);
    } catch {
      next = null; // 다음 할 일 조회 실패는 잡 결과와 무관하게 흡수(카드에 next 만 생략).
    }
    const outcome: WorkerOutcome = { ok, kind: job.kind, run_id: job.run_id, message, next };
    if (detail) outcome.detail = detail;
    return outcome;
  }
}
