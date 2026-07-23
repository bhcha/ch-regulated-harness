/**
 * live-assembly.ts — 라이브(온라인) 실행 백엔드 조립(잠긴 결정 1~4 · 계획 3번 절 부품 1·2·5).
 *
 * ── 무엇을 조립하나 ──────────────────────────────────────────────────────────────
 *   CI 하네스와 **같은** 부품(RecordChatPort·affordancesOf·Transcript·auto-happy 정책)에 **실행 백엔드만 스왑**한다
 *   (chat-atdd-acceptance-plan 2-3). 라이브 백엔드 =
 *     ① TeeRecordingPort(delegate=실 Slack ChatPort) — 기록 + 실 Slack tee + JSONL(잠긴 결정 3).
 *     ② createGateway({chat: teePort, …}) **온라인**(HARNESS_OFFLINE 아님) → selectGenExecutor 가 자동으로 **Bridge**(C2)를
 *        고른다 → 생성 잡은 pending 파일로 적재되고, **데몬(intake·brief)** + **운영자-동등 세션(브리프 너머)** 이 소비한다.
 *     ③ LiveDriver — 동결 SurfaceDriver 의 auto-happy 정책(policy.decideForward 미러)으로 멘션→done 을 몬다.
 *        모든 발화는 직전 렌더의 affordancesOf 에서 도출(잠긴 결정 1 · 지어낸 버튼 금지 · stamp 정직 전달).
 *
 * ── 잠긴 결정 4 확정(브리프 너머 생성 경로) ─────────────────────────────────────────
 *   보류였던 결정 4 를 **CI 가 실증한 기본안**으로 확정한다: **데몬은 intake·brief 만 무인 소비**(LIVE_DAEMON_STAGES =
 *   CHAT_SDK_STAGES · keyvisual 무인은 구조적 차단이라 넓히지 않는다 — 하네스 hazard-8), 그 **너머(concept/storyboard/
 *   keyvisual)의 생성은 운영자-동등 세션(C2 브리지 소비)** 이 하고, **선택/승인 같은 사람-버튼 결정은 이 드라이버가**
 *   직전 렌더에서 도출해 발화한다. 이는 CI 시나리오 ②(Bridge+데몬 핸드오프)·①(멘션→done)이 오프라인으로 검증한 그대로다.
 *
 * ── ⚠ 실 서비스 미실행(안전) ─────────────────────────────────────────────────────
 *   이 파일은 **조립만** 한다 — 실 Slack/claude/ADK/NanoBanana 호출은 하지 않는다. 실제 라이브 런은 사람이 런북
 *   (docs/reference/daemon-live-verification-runbook.md)대로 여는 **수동 게이트**다. isOffline()이면 조립을 거부한다
 *   (stub 은 CI 전용 — 온라인 백엔드에서 stub 누수 금지).
 *
 * 이 파일은 platform-aware(transport.ts=Slack 를 import)라 **src/live/ 에 둔다** — src/acceptance/ 에 두면
 *   kernel-neutral 가드(slack 토큰 스캔)에 걸린다. src/live/ 는 그 스캔 밖이다.
 */
import { join } from "node:path";
import type { Chat } from "chat";
import { buildSlackChatPort, createSlackChat, wireInteractionHandlers } from "../adapters/slack/transport.js";
import {
  createGateway,
  enqueueReviewIfDue,
  makeRunId,
  onAction,
  onMention,
  onReply,
  reconcile,
  type Gateway,
} from "../kernel/flow.js";
import type { ButtonPressed, ChatEvent, MentionReceived, TextReply } from "../kernel/events.js";
import type { Presentation } from "../kernel/presentation.js";
import type { NextAction } from "../types/contract.js";
import { Transcript } from "../acceptance/transcript.js";
import type { RecordedRender } from "../acceptance/recording-port.js";
import type { AffordanceContext } from "../acceptance/affordances.js";
import { isOffline, stubSlackDemo } from "../config.js";
import { TeeRecordingPort } from "./tee-port.js";
import { decideLive, type LiveDecision } from "./policy.js";
import { DEFAULT_STUCK_THRESHOLD_MS, nextActionSignature, StuckDetector, type StuckVerdict } from "./stuck-detector.js";

/**
 * 라이브 데몬 무인 enablement(잠긴 결정 4 확정 · CHAT_SDK_STAGES 로 넘길 값). intake·brief 만 — keyvisual 무인은
 *   구조적 차단(skill-rewrite SUPPORTED_STAGES)이라 넓히지 않는다. 그 너머는 운영자-동등 세션이 C2 브리지로 소비.
 */
export const LIVE_DAEMON_STAGES: readonly string[] = ["intake", "brief"];

/** 라이브 아티팩트 경로 묶음(세션화 + terminal). liveArtifactPaths 산출. */
export interface LiveArtifactPaths {
  /** 이 세션의 tee JSONL 트랜스크립트(세션 epoch suffix — 재기동이 옛 세션을 덮어쓰지 않는다). */
  transcript: string;
  /** 이 세션 종료 시점 판정 리포트(.md · 세션 epoch suffix). */
  reportMd: string;
  /** 이 세션 종료 시점 판정 리포트(.json · 세션 epoch suffix). */
  reportJson: string;
  /** done 도달 시 terminal 리포트(.md · 세션 무관 고정 이름 — stale 세션 리포트가 done 을 가리지 않게). */
  finalReportMd: string;
  /** done 도달 시 terminal 리포트(.json · 세션 무관 고정 이름). */
  finalReportJson: string;
}

/**
 * 라이브 아티팩트 경로 산출(순수 · 계획 수정 4 · S-4). 세션마다 다른 epoch 를 받아 transcript/report 를 **세션화**한다
 *   — 죽은 드라이버 재기동이 같은 RID 경로를 덮어써 옛 세션 리포트(예 "01-brief·pass=false")가 실제 done 을 가리던
 *   문제를 없앤다(세션별 보존). final* 는 세션 무관 **고정 이름**이라, done 을 관측한 세션이 terminal 리포트를 여기
 *   덮어쓰면 그게 항상 최종 진실이 된다(호출부 main 이 result.reached 일 때만 final* 를 쓴다).
 */
export function liveArtifactPaths(artifactDir: string, rid: string, sessionEpoch: number): LiveArtifactPaths {
  return {
    transcript: join(artifactDir, `${rid}-transcript.${sessionEpoch}.jsonl`),
    reportMd: join(artifactDir, `${rid}-report.${sessionEpoch}.md`),
    reportJson: join(artifactDir, `${rid}-report.${sessionEpoch}.json`),
    finalReportMd: join(artifactDir, `${rid}-report.final.md`),
    finalReportJson: join(artifactDir, `${rid}-report.final.json`),
  };
}

/**
 * 기본 감사 actor. 끝 세그먼트를 `svc-` 접두로 두어 리포트 분류기(report-assembler)가 드라이버 자동 결정을
 *   **서비스(사람 아님)** 로 표기하게 한다 — 자동 주행을 사람 결정으로 오분류하면 감사 정직화가 무력화된다.
 *   CHAT_APPROVERS 에 끝 user id(`svc-driver`)가 있어야 승인/선택 잡이 워커에서 거부되지 않는다(actorUserId 비교).
 */
const DEFAULT_ACTOR = "chat:live:svc-driver";
/** 기본 스텝 예산(fire 발화 상한 · 막힌 흐름의 결정론적 종료). */
const DEFAULT_STEP_BUDGET = 40;
/** 전체 루프 벽시계 상한(기본 4시간) — 모든 대기의 최후 백스톱. */
const DEFAULT_RUN_BUDGET_MS = 4 * 60 * 60 * 1000;
/** wait 재관측 간 sleep(기본 5초 · 주입 가능). */
const DEFAULT_WAIT_POLL_MS = 5000;
/** next-action 서명별 recover 예산(기본 3 — 무한 reconcile↔retry 핑퐁 차단). */
const DEFAULT_RECOVER_BUDGET = 3;
/** 실 sleep(주입 기본값 · now 와 동일하게 테스트에서 fake 로 대체). */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * runToDone 종료 사유. `no-forward`·`terminal` 은 decideLive 도입 후 도달 불가라 제거했다
 *   (표시전용/판정/실패 화면은 wait·recover·stop 으로 흡수 · Done 은 stop:done→predicate). main.ts 는
 *   reason 을 문자열로 로그·리포트에 흘릴 뿐 타입 협착하지 않는다(제거 안전 · 동결 driver.ts 는 별도 union 보유).
 */
export type DriveStopReason = "predicate" | "budget" | "stalled" | "escalation" | "human-input";

export interface DriveResult {
  reached: boolean;
  reason: DriveStopReason;
  steps: number;
  final: Presentation | null;
}

/**
 * driveLoop 의존성(주입 seam) — 게이트웨이·플랫폼·벽시계를 전혀 모른다. LiveDriver 가 자기 메서드를 감아 넣고,
 *   테스트는 스크립트 fake(프리젠테이션 큐 + 가짜 시계/sleep)를 넣어 오프라인 결정론으로 루프를 검증한다
 *   (stuck-detector·policy 의 "순수 함수 + 주입 시계" 패턴과 동형).
 */
export interface DriveLoopDeps {
  /** 큐 정지 대기(자동 캐스케이드·Bridge 폴링 정착). */
  quiesce(): Promise<void>;
  /** 최신 렌더 화면(없으면 null). */
  latestPresentation(): Presentation | null;
  /** 화면 → 라이브 결정(decideLive 를 affordanceContext 로 감은 것). */
  decide(p: Presentation): LiveDecision;
  /** 결정된 이벤트 발화(recordStep 이 quiesce+stuck 관측을 이미 수행 — 여기서 중복 관측 금지). */
  fire(event: ButtonPressed): Promise<void>;
  /**
   * 현재 next-action 서명(읽기 실패 시 null). ⚠ **호출부가 항상 화면 타입으로 폴백**한다(빈 관측 금지) — recover 분기는
   *   `?? latest.type`(예산 키), wait 분기는 `?? screen:${latest.type}`(stuck 관측). null 을 그냥 흘리면 스냅샷이 안
   *   쌓여 stuck 이 영영 안 뜨는 4시간 대기 버그가 난다.
   */
  readNaSignature(): Promise<string | null>;
  /** wait 분기의 stuck 관측(fire 분기는 recordStep 이 대신 관측하므로 여기만 명시 관측). */
  observeStuck(atMs: number, signature: string): void;
  /** 시간 기반 stuck 판정(주입 now). */
  evaluateStuck(atMs: number): StuckVerdict;
  /** 주입 시계(벽시계 미접촉 — 테스트는 fake clock). */
  now(): number;
  /** 주입 sleep(테스트는 clock 을 전진시키는 fake). */
  sleep(ms: number): Promise<void>;
}

/** driveLoop 예산. */
export interface DriveLoopOptions {
  /** fire 발화 상한(wait 는 계상 안 함 — 시간 예산 소관). */
  stepBudget: number;
  /** 전체 루프 벽시계 상한(ms). */
  runBudgetMs: number;
  /** wait 재관측 간 sleep(ms). */
  waitPollMs: number;
  /** next-action 서명별 recover 예산. */
  recoverBudget: number;
}

/** driveLoop 결과 — DriveResult + budgetExhausted(LiveDriver 게터가 읽어 반영). */
export interface DriveLoopResult extends DriveResult {
  budgetExhausted: boolean;
}

/**
 * 순수 라이브 구동 루프(계획 2-3) — 멘션 이후 done/정지까지 fire/recover/wait/stop 을 돈다.
 *   **행 금지 불변식**: 모든 대기가 유한이다 — quiesce 는 Bridge 상한(외부), wait 는 stuck 임계, recover 는
 *   서명별 예산, 전체는 runBudgetMs·stepBudget 이 막는다. 스텝(fire) 예산은 fire/recover 발화에만 계상하고
 *   wait 는 시간 예산 소관이다.
 *
 *   ⚠ 경계 2가지(문서화 — 재플래그 방지):
 *   ① runBudgetMs 는 **반복 사이**에서만 재평가하는 coarse 백스톱이다(블로킹 await 를 중간에 끊지 않는다). 한 번의
 *      quiesce/fire 가 스스로 유한한 건 **per-op 상한(quiesce=CHAT_BRIDGE_TIMEOUT)**이 보장한다 — 권장 3600초는
 *      4시간 runBudget 보다 훨씬 작아 단일 await 가 runBudget 을 넘길 수 없다(그러려면 CHAT_BRIDGE_TIMEOUT>4h 오설정
 *      필요). await 중단(AbortController)은 게이트웨이 전반 배선이 필요해 범위 밖 — per-op 상한이 실질 방어다.
 *   ② wait 는 **스스로 재렌더하지 않는다**(버튼 없는 화면을 드라이버가 다시 그리는 건 잠긴 결정 1 위반). 다음 화면은
 *      quiesce 의 캐스케이드(자동 review/generate 적재→outcome)가 낸다. 큐가 빈 표시화면(종단)은 그래서 안 바뀌고
 *      stuck 임계로 stalled 마감된다 — 이게 정상 백스톱이다(무한 행 아님).
 */
export async function driveLoop(deps: DriveLoopDeps, opts: DriveLoopOptions): Promise<DriveLoopResult> {
  let fireSteps = 0;
  const startMs = deps.now();
  const recoverSpent = new Map<string, number>();

  while (fireSteps < opts.stepBudget && deps.now() - startMs < opts.runBudgetMs) {
    await deps.quiesce(); // 자동 캐스케이드/Bridge 폴링 정착.
    const latest = deps.latestPresentation();
    if (latest === null) {
      // 아무것도 렌더되지 않음 — 사람 입력 대기(방어적 · main.ts 는 멘션을 먼저 하므로 정상 흐름엔 안 옴).
      return { reached: false, reason: "human-input", steps: fireSteps, final: null, budgetExhausted: false };
    }
    const d = deps.decide(latest);
    switch (d.kind) {
      case "stop":
        if (d.reason === "done") {
          return { reached: true, reason: "predicate", steps: fireSteps, final: latest, budgetExhausted: false };
        }
        // escalation · human-input → 리포트에 가시화하고 멈춘다.
        return { reached: false, reason: d.reason, steps: fireSteps, final: latest, budgetExhausted: false };
      case "fire":
        await deps.fire(d.event); // recordStep 이 quiesce+stuck 관측 수행.
        fireSteps++;
        break;
      case "recover": {
        // 서명별 회복 예산 차감 — 무한 reconcile↔retry 핑퐁 차단(na 없으면 화면 타입으로 폴백 키).
        const sig = (await deps.readNaSignature()) ?? latest.type;
        const spent = recoverSpent.get(sig) ?? 0;
        if (spent >= opts.recoverBudget) {
          return { reached: false, reason: "stalled", steps: fireSteps, final: latest, budgetExhausted: false };
        }
        recoverSpent.set(sig, spent + 1);
        await deps.fire(d.event); // recover 발화도 전진이므로 스텝 계상.
        fireSteps++;
        break;
      }
      case "wait": {
        // 현재 na 서명을 관측하고 시간 기반 stuck 판정 — 같은 서명이 임계 이상 지속되면 stalled(유한).
        //   ⚠ na 읽기 실패(null)여도 **항상 관측한다** — 화면 타입 폴백(`screen:` 접두)으로 서명을 만든다. null 을
        //     건너뛰면(옛 버그) contract 읽기 반복 실패·attach 직후 빈 디텍터일 때 스냅샷이 하나도 안 쌓여 stuck 이
        //     영영 안 뜨고 4시간 runBudget 까지 대기한다. recover 분기의 `?? latest.type` 폴백과 같은 결이되, `screen:`
        //     접두로 실제 na 서명과의 우연 충돌을 막는다(recover 예산 키는 순수 na 서명이라 그쪽엔 접두를 섞지 않음).
        const sig = (await deps.readNaSignature()) ?? `screen:${latest.type}`;
        deps.observeStuck(deps.now(), sig);
        const v = deps.evaluateStuck(deps.now());
        if (v.stuck) {
          return { reached: false, reason: "stalled", steps: fireSteps, final: latest, budgetExhausted: false };
        }
        await deps.sleep(opts.waitPollMs); // 유한 대기 후 재관측(스텝 미계상).
        break;
      }
      default: {
        // LiveDecision union 에 변이 추가 시 컴파일 실패(exhaustiveness).
        const _exhaustive: never = d;
        void _exhaustive;
        throw new Error(`driveLoop: 알 수 없는 LiveDecision: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  // 루프 종료 — fire 예산 소진이 우선(그 다음이 시간 예산).
  if (fireSteps >= opts.stepBudget) {
    return { reached: false, reason: "budget", steps: fireSteps, final: deps.latestPresentation(), budgetExhausted: true };
  }
  // runBudgetMs 소진(시간).
  return { reached: false, reason: "stalled", steps: fireSteps, final: deps.latestPresentation(), budgetExhausted: false };
}

/**
 * LiveDriver — 조립된 온라인 게이트웨이(teePort)를 감싸 mention/reply/fire/runToDone 으로 표면 흐름을 몬다.
 *   동결 SurfaceDriver 와 **같은 auto-happy 정책**(policy.decideForward)·같은 Transcript 를 쓰되, 게이트웨이 chat
 *   포트가 teePort(실 Slack tee)라는 점만 다르다(백엔드 스왑). 라이브라 벽시계를 쓴다(주입 now 로 stuck 관측 시각).
 *   ⚠ 이 클래스는 실 서비스를 몬다 — 테스트는 조립·정책(policy.ts)만 검증하고 이걸 실행하지 않는다(런북 수동 게이트).
 */
export class LiveDriver {
  private readonly gw: Gateway;
  private readonly teePort: TeeRecordingPort;
  private readonly _actor: string;
  private readonly budget: number;
  private readonly _transcript = new Transcript();
  private readonly stuck: StuckDetector;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly runBudgetMs: number;
  private readonly waitPollMs: number;
  private readonly recoverBudget: number;
  private _threadId: string | null = null;
  /**
   * transcript 소비 커서 — 이미 append 한 렌더 수. ⚠ **myRenders(자기 스레드 필터) 목록 길이 기준**이다(전체
   *   teePort.renders() 아님). 같은 게이트웨이를 공유하는 남의 스레드 렌더가 커서를 밀면 내 렌더를 건너뛰거나
   *   남의 카드를 내 트랜스크립트로 삼킨다(교차-스레드 오염) — 필터된 목록으로 커서를 통일해 격리한다(myRenders 주석).
   */
  private _consumed = 0;
  private _budgetExhausted = false;

  constructor(
    gw: Gateway,
    teePort: TeeRecordingPort,
    opts: {
      actor?: string;
      stepBudget?: number;
      stuckThresholdMs?: number;
      now?: () => number;
      runBudgetMs?: number;
      waitPollMs?: number;
      recoverBudget?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.gw = gw;
    this.teePort = teePort;
    this._actor = opts.actor ?? DEFAULT_ACTOR;
    this.budget = opts.stepBudget ?? DEFAULT_STEP_BUDGET;
    this.stuck = new StuckDetector(opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
    this.runBudgetMs = opts.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS;
    this.waitPollMs = opts.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
    this.recoverBudget = opts.recoverBudget ?? DEFAULT_RECOVER_BUDGET;
  }

  get actor(): string {
    return this._actor;
  }
  get budgetExhausted(): boolean {
    return this._budgetExhausted;
  }
  get activeRuns(): number {
    return this.gw.queue.activeRuns;
  }
  get transcript(): Transcript {
    return this._transcript;
  }

  /** 추출기/정책용 런타임 바인딩(현재 스레드·actor). */
  affordanceContext(): AffordanceContext {
    return { actor: this._actor, threadId: this._threadId ?? "" };
  }

  /**
   * 자기 스레드로 필터된 렌더 목록 — 드라이버 뷰의 **유일한 렌더 소스**(presentations·latestPresentation·recordStep·
   *   stuckSignature 가 전부 이걸 쓴다). 라이브 리허설 프로세스는 **단일 스레드 전용**이라, 같은 게이트웨이·같은
   *   TeeRecordingPort 를 공유하는 다른 스레드(프로덕션 봇이 응대하는 남의 런)의 렌더가 이 뷰에 새면 (a) 남의 런
   *   카드에서 결정을 도출해 오발화하고 (b) 트랜스크립트·stuck 렌더-수 마커를 오염시킨다(교차-스레드 상태 변이).
   *   그래서 소비 지점 전부를 `r.threadId === this._threadId` 필터 목록으로 통일한다(다른 스레드 개입은 프로덕션 봇 몫).
   *   ⚠ _threadId null(mention/attach 전)이면 방어적으로 전체를 반환한다 — 그 시점엔 소비 지점 자체가 없어 안전.
   */
  private myRenders(): RecordedRender[] {
    const all = this.teePort.renders();
    return this._threadId === null ? all : all.filter((r) => r.threadId === this._threadId);
  }

  presentations(): Presentation[] {
    return this.myRenders().map((r) => r.presentation);
  }
  latestPresentation(): Presentation | null {
    const mine = this.myRenders();
    return mine.length > 0 ? mine[mine.length - 1]!.presentation : null;
  }

  /** 현재 스레드의 next-action 스냅샷(없으면 null · best-effort). */
  async readNa(): Promise<NextAction | null> {
    const tid = this._threadId;
    if (!tid) return null;
    const rid = await this.gw.map.runForThread(tid).catch(() => null);
    if (!rid) return null;
    return this.gw.readNext(rid).catch(() => null);
  }

  async runId(): Promise<string | null> {
    const tid = this._threadId;
    if (!tid) return null;
    return this.gw.map.runForThread(tid).catch(() => null);
  }

  /** 시간 기반 stuck 판정(직전 관측들 + 현재 벽시계). 판정 리포트/운영자 감시가 읽는다. */
  stuckVerdict(): StuckVerdict {
    return this.stuck.evaluate(this.now());
  }

  /**
   * stuck 관측 서명에 **렌더 수 마커**(#rN)를 덧댄다 — 잡-레벨 리뷰 재시도(백오프 60·300초 + 심의 최대 600초×여러 시도)는
   *   전 구간 같은 na 서명(review)이라, 마커 없이는 15분 임계에서 조기 stalled 로 죽는다. 그러나 재시도는 시도마다 새
   *   Progress 카드("…n번째 시도")를 렌더하므로 **새 렌더 = 활동 신호**다. 렌더 수가 늘면 서명이 바뀌어 stuck 창이
   *   리셋되고, 더는 렌더가 없는 종단 화면은 서명이 고정돼 기존대로 임계에 발화한다.
   *   ⚠ **readNaSignature(recover 예산 키)에는 이 마커를 섞지 않는다** — recover 키에 마커가 붙으면 reconcile 렌더마다
   *     키가 바뀌어 회복 예산이 영영 안 차기 때문이다(driveLoop 의 서명별 예산 무력화). 마커는 stuck 관측 전용이다.
   */
  private stuckSignature(base: string): string {
    // ⚠ 렌더 수 마커도 **자기 스레드 필터**(myRenders) 길이다 — 전체 renders 로 세면 남의 스레드 렌더가 늘 때마다
    //   마커가 바뀌어 stuck 창이 부당하게 리셋된다(내 종단 화면이 영영 stalled 안 됨 · 교차-스레드 오염).
    return `${base}#r${this.myRenders().length}`;
  }

  /** 큐 정지 대기 — 봇의 자동 이어가기(onOutcome 자동 review/generate 적재) 캐스케이드 정착. */
  async quiesce(): Promise<void> {
    await this.gw.queue.drain();
  }

  /** @멘션 — 새 작업 진입. */
  async mention(threadId: string, text?: string): Promise<void> {
    this._threadId = threadId;
    const ev: MentionReceived = {
      type: "mention",
      threadId,
      actor: this._actor,
      ...(text !== undefined ? { text } : {}),
    };
    await onMention(ev, this.gw);
    await this.recordStep(ev);
  }

  /**
   * 중간-재개(attach) — 죽은 드라이버가 남긴 기존 run 을 **재멘션 없이** 이어받는다(계획 수정 2 · S-2).
   *   재기동 드라이버가 mention 을 다시 쏘면 onMention 이 "이미 진행 중"으로 거부(flow.ts 재멘션 방어 = 프로덕션
   *   계약, 불변)하고 드라이버는 Progress=wait 로 stuck→stalled 죽는다. 그래서 attach 는:
   *     ① 스레드를 현재 세션에 바인딩(_threadId) — 이후 fire/readNa 가 이 스레드로 해석.
   *     ② 스레드↔run 매핑 조회. 없으면(신규 스레드) {attached:false} 로 호출부가 mention 폴백.
   *     ③ 있으면 reconcile(읽기 전용 화해)로 **현재 게이트 카드를 1회 재게시**(readNext 재파생 카드만 · 지어낸 버튼
   *        금지 · 상태 변이 0). 사람이 Slack 에서 무엇을 눌러야 할지 다시 보인다.
   *     ④ 리뷰 차례면 심의 잡을 **1회 재적재**(enqueueReviewIfDue) — reconcile 은 "규정 점검 중" Progress 만 재게시할 뿐
   *        리뷰 잡을 다시 넣지 않아, 죽은 프로세스의 소실된 in-memory 리뷰 잡/백오프 타이머를 화해하지 못하면
   *        decideLive(Progress)=wait 로 stuck→stalled 죽는다. generate(유료 생성)는 여기서 적재하지 않는다(사람 몫).
   *   stuck 탐지기는 새 인스턴스라 이미 초기화 상태다(옛 세션의 stuck 관측을 물려받지 않는다). runToDone 재진입은
   *   호출부(main)가 attach 뒤에 이어 부른다(자동 주행 계속).
   */
  async attach(threadId: string): Promise<{ attached: boolean; rid: string | null; reviewResumed: boolean }> {
    this._threadId = threadId;
    const rid = await this.gw.map.runForThread(threadId).catch(() => null);
    if (!rid) return { attached: false, rid: null, reviewResumed: false }; // 매핑 없음 → 재개할 run 이 없다(호출부 mention 폴백).
    await reconcile(threadId, this.gw); // gw.chat=teePort 이므로 재게시가 tee(실 Slack)로 나간다.
    const resumed = await enqueueReviewIfDue(this.gw, rid); // 리뷰 게이트에서만 심의 잡 재적재(위 ④ · 유일한 재적재 경로).
    return { attached: true, rid, reviewResumed: resumed !== null };
  }

  /** 스레드 답글(제품명·워킹백워드 본문·보완 사유). */
  async reply(threadId: string, text: string, opts?: { hasAttachments?: boolean }): Promise<void> {
    this._threadId = threadId;
    const ev: TextReply = {
      type: "text",
      threadId,
      text,
      actor: this._actor,
      hasAttachments: opts?.hasAttachments ?? false,
    };
    await onReply(ev, this.gw);
    await this.recordStep(ev);
  }

  /** 발화된 affordance 라우팅(모두 onAction — production 과 동일 · driver.ts 미러). */
  async fire(event: ButtonPressed): Promise<void> {
    if (event.threadId) this._threadId = event.threadId;
    await onAction(event, this.gw);
    await this.recordStep(event);
  }

  /**
   * Done 종단까지 auto-happy 구동(policy.decideLive · 유한 루프). 판정/진행/실패 화면에서 멈추지 않고
   *   wait(캐스케이드 대기)·recover(회복 발화)로 몰아 done 까지 간다. 순수 driveLoop 에 자기 메서드/시계를 감아 넣어
   *   실행하고, budgetExhausted 만 게터로 반영한다(루프 골격은 driveLoop 이 단독 소유 → 오프라인 결정론 검증 가능).
   */
  async runToDone(): Promise<DriveResult> {
    const res = await driveLoop(
      {
        quiesce: () => this.quiesce(),
        latestPresentation: () => this.latestPresentation(),
        decide: (p) => decideLive(p, this.affordanceContext()),
        fire: (event) => this.fire(event),
        readNaSignature: async () => {
          // 순수 na 서명 그대로(마커 없음) — driveLoop 의 recover 예산 키가 이걸 쓴다(stuckSignature 주석 참조).
          const na = await this.readNa();
          return na ? nextActionSignature(na) : null;
        },
        // wait 분기의 stuck 관측만 여기서 마커를 덧댄다(fire 분기는 recordStep 이 같은 조성으로 관측 — 아래).
        observeStuck: (atMs, signature) => this.stuck.observe(atMs, this.stuckSignature(signature)),
        evaluateStuck: (atMs) => this.stuck.evaluate(atMs),
        now: this.now,
        sleep: this.sleep,
      },
      {
        stepBudget: this.budget,
        runBudgetMs: this.runBudgetMs,
        waitPollMs: this.waitPollMs,
        recoverBudget: this.recoverBudget,
      },
    );
    this._budgetExhausted = res.budgetExhausted;
    return { reached: res.reached, reason: res.reason, steps: res.steps, final: res.final };
  }

  /** 한 스텝 기록 — 발화 뒤 quiesce, 지난 스텝 이후 렌더 + na 스냅샷을 transcript 에 append + stuck 관측(driver.ts recordStep 미러). */
  private async recordStep(utterance: ChatEvent): Promise<void> {
    await this.quiesce();
    // ⚠ 자기 스레드 렌더만 소비한다(myRenders) — _consumed 커서도 이 필터된 목록 길이 기준이다(교차-스레드 오염 차단).
    const mine = this.myRenders();
    const screens = mine.slice(this._consumed).map((r) => r.presentation);
    this._consumed = mine.length;
    const na = await this.readNa();
    this._transcript.append(utterance, screens, na ?? undefined);
    // fire 분기의 stuck 관측 — wait 분기(observeStuck)와 **같은 서명 조성**(na 서명 + 렌더 마커)이어야 두 관측 지점을
    //   가로지르는 연속 구간 계산이 깨지지 않는다(stuckSignature 주석의 조성 일치 제약).
    if (na) this.stuck.observe(this.now(), this.stuckSignature(nextActionSignature(na)));
  }
}

export interface LiveBackendOptions {
  /** 인입 번들 폴더 절대경로(INGEST_STAGED 라우팅 필수). */
  bundleDir: string;
  /** 스테이징 워킹백워드 .md 절대경로(INGEST_STAGED 라우팅 필수). */
  stagedWbPath: string;
  /** 감사 actor(기본 DEFAULT_ACTOR · CHAT_APPROVERS 에 끝 user id 필요). */
  actor?: string;
  /**
   * 라이브 리허설 대상 스레드(설정 시 인터랙션 배선을 이 스레드로 **스코프 제한**). 라이브 프로세스는 단일 스레드
   *   전용이라, 지정하면 wireInteractionHandlers 가 다른 스레드의 멘션/버튼/답글을 조용히 무시한다(교차-스레드 상태
   *   변이 차단 — 다른 스레드 개입은 프로덕션 봇 몫). 미지정이면 스코프 없음(프로덕션 봇과 동일 전-스레드 배선).
   */
  threadId?: string;
  /** tee JSONL 트랜스크립트 지속 경로(관측 아티팩트 · 판정 리포트 입력). */
  jsonlPath?: string;
  /** state 저장 루트(미지정 시 CHAT_STATE_DIR env). */
  stateDir?: string;
  stepBudget?: number;
  stuckThresholdMs?: number;
  /** 전체 루프 벽시계 상한(ms · 기본 4시간). */
  runBudgetMs?: number;
  /** wait 재관측 간 sleep(ms · 기본 5초). */
  waitPollMs?: number;
  /** next-action 서명별 recover 예산(기본 3). */
  recoverBudget?: number;
}

export interface LiveBackend {
  /** 온라인 게이트웨이(chat 포트 = teePort · gen = Bridge 자동선택). */
  gw: Gateway;
  /** 기록+tee+JSONL 포트. */
  teePort: TeeRecordingPort;
  /** auto-happy 드라이버(멘션→done). */
  driver: LiveDriver;
  /** 실 Slack Chat — 호출부가 initialize()·Socket Mode listener·Ctrl-C teardown 을 한다(런북). */
  slackChat: Chat;
}

/**
 * 라이브 실행 백엔드 조립(실행 아님 · 사람이 런북대로 연다). isOffline()이면 거부(stub 은 CI 전용).
 *   ⚠ 여기서는 어떤 실 서비스도 호출하지 않는다 — Slack initialize·listener·드라이브는 호출부(main/런북)가 한다.
 */
export function assembleLiveBackend(opts: LiveBackendOptions): LiveBackend {
  // 기본은 offline 거부(stub 누수 방지). 단 **데모(촬영) 모드**(CHAT_STUB_SLACK=1)면 offline stub 생성을 실 Slack tee 와
  //   함께 허용한다 — 그때 아래 createGateway 는 offline 이라 selectGenExecutor 가 StubDirect(동기 in-process 생성 · 데몬
  //   불필요)를 고르고, chat 포트는 실 Slack teePort 그대로다(config.stubSlackDemo 주석 — 컴플라이언스 런 아님).
  if (isOffline() && !stubSlackDemo()) {
    throw new Error(
      "라이브 백엔드는 온라인 전용입니다 — HARNESS_OFFLINE 을 해제하세요(stub 은 CI/골든 전용이라 라이브에서 누수 금지).",
    );
  }
  const slackChat = createSlackChat();
  const slackPort = buildSlackChatPort(slackChat);
  const teePort = new TeeRecordingPort({
    delegate: slackPort,
    ...(opts.jsonlPath !== undefined ? { jsonlPath: opts.jsonlPath } : {}),
  });
  // 온라인 → selectGenExecutor 가 Bridge(C2)를 고른다(gen-executor).
  //   ⚠ isApprover 는 **기본값(config.isApprover = CHAT_APPROVERS)** 을 그대로 쓴다 — 옛 `()=>true` override 는
  //     이벤트 소스가 드라이버뿐일 때의 지름길이었는데, 실 사람 배선(아래 wireInteractionHandlers)이 붙은 지금은
  //     **핸들러-레벨 흐름의 승인 구멍**이 된다: NL 인입 확정(confirmNlIntake) 같은 흐름은 워커 잡 이전에 게이트웨이
  //     핸들러가 파일 스테이징·스레드↔run 결박·대기입력 정리를 수행하므로, 워커의 늦은 거부만으론 비승인 클릭이
  //     이미 부수효과를 남긴다. 드라이버 actor(svc)는 main.ts 기동 검증이 CHAT_APPROVERS 포함을 강제하므로 실
  //     predicate 아래서도 자동 주행은 무손상이고, 사람 클릭은 프로덕션(createBot 기본 gw)과 같은 규칙으로 걸러진다.
  const gw = createGateway({
    chat: teePort,
    bundleDir: () => opts.bundleDir,
    stagedWbPath: () => opts.stagedWbPath,
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
  });
  // 실 사람 인터랙션 배선(S-7) — slackChat 의 Socket Mode 이벤트(버튼 클릭·스레드 답글)를 이 gw 로 라우팅한다.
  //   ⚠ 드라이버 fire 와 **같은 게이트웨이·같은 계약**(onAction/onReply)으로 들어온다 — 프로덕션 봇(createBot)과
  //     정확히 동일 경로다(그 함수에서 추출한 배선이라 관측 동등). 즉 "드라이버는 자동 주행, 사람은 언제든 Slack 개입".
  //   ⚠ 승인은 두 겹이다: 게이트웨이 핸들러 게이트(config.isApprover — 위 gw 주석: 핸들러-레벨 부수효과 차단) +
  //     워커의 상태변이 잡 재검사(CHAT_APPROVERS · actorUserId 비교). 사람 클릭·드라이버 fire 둘 다 같은 규칙.
  //   ⚠ 드라이버 자동 주행과 사람 클릭의 경합은 stale-stamp/멱등 가드가 처리한다(설계된 동시성) — 옛 카드 재클릭·
  //     선점 대기 오소비 방어는 flow.ts onAction/onChoice 가 이미 담당(라우팅은 번역만, 판정은 커널).
  //   ⚠ 실측 확증은 W5 라이브 리허설(사람 게이트)의 몫이다 — 이 파일은 조립(배선)만 하고 실 Slack 을 연결하지 않는다.
  //   ⚠ 라이브 스코프(opts.threadId): 지정되면 배선이 그 스레드 이벤트만 gw 로 위임한다 — 라이브 리허설은 단일 스레드
  //     전용이라 다른 스레드 개입(남의 런)이 이 게이트웨이·드라이버 뷰를 오염시키는 것을 원천 차단한다(그건 프로덕션 봇 몫).
  const wireOpts = opts.threadId !== undefined ? { threadScope: opts.threadId } : undefined;
  wireInteractionHandlers(slackChat, gw, wireOpts);
  const driver = new LiveDriver(gw, teePort, {
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.stepBudget !== undefined ? { stepBudget: opts.stepBudget } : {}),
    ...(opts.stuckThresholdMs !== undefined ? { stuckThresholdMs: opts.stuckThresholdMs } : {}),
    ...(opts.runBudgetMs !== undefined ? { runBudgetMs: opts.runBudgetMs } : {}),
    ...(opts.waitPollMs !== undefined ? { waitPollMs: opts.waitPollMs } : {}),
    ...(opts.recoverBudget !== undefined ? { recoverBudget: opts.recoverBudget } : {}),
  });
  return { gw, teePort, driver, slackChat };
}

/** makeRunId 재노출(런북/판정 리포트가 core runs/<rid> 를 대조할 때). */
export { makeRunId };
