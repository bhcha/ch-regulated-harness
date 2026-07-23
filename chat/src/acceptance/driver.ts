/**
 * driver.ts — 인수 하네스용 SurfaceDriver(계획 2-2 "SurfaceDriver").
 *
 * 실제 게이트웨이(createGateway)를 감싸 표면 흐름을 **결정론적으로** 구동한다. 이 드라이버가 실행 백엔드다 —
 *   같은 드라이버를 라이브(온라인)에서도 재사용하고 백엔드만 스왑한다(계획 2-3). CI 결정성을 위해 아래를 주입한다:
 *   · chat = RecordChatPort(기록형 포트) — 드라이버는 이 기록을 읽어 다음 수를 정한다.
 *   · isApprover = () => true — onAction/onChoice/onReply 의 승인 게이트 통과(자동-happy actor 가 승인/선택 가능).
 *     ⚠ 게이트웨이 핸들러 게이트만 연다. 워커(createGateway 내부)는 config.isApprover(=CHAT_APPROVERS)를 쓰므로
 *       상태변이 잡(approve/select)이 워커에서 거부되지 않으려면 시나리오가 CHAT_APPROVERS 에 actor 를 넣어야 한다.
 *   · bundleDir/stagedWbPath — 인입(INGEST_STAGED)이 잡으로 라우팅되려면 둘 다 필요(flow.onAction ingest 분기).
 *   · readSurface = () => null — null-object 오버레이 주입(게이트마다 a2ui-surface.sh spawn 회피 → 속도·결정성).
 *     ApproveGate 의 boolean 은 na(vm.*)에서 오며 이는 관측 동등한 소스다.
 *
 * ── auto-happy 결정 정책(계획 2-2) ──────────────────────────────────────────────
 *   정지 후(quiescence) 최신 인터랙티브 화면을 보고 affordancesOf(추출기)로 '전진' affordance 를 고른다
 *   (이벤트를 손으로 만들지 않는다 — 추출기가 낸 것 중에서 무엇을 발화할지만 고른다):
 *     · NlProposal   → confirm affordance(확정 버튼)가 있으면 발화(없으면 사람 입력 대기 = 정지).
 *     · IngestPrompt → INGEST_STAGED(스테이징 인입) 발화.
 *     · ApproveGate  → approve 발화. raOkRequired 면 approve 에 ra_required 가 실려 ConfirmGate 로 이어지고,
 *                      다음 스텝이 ConfirmGate 의 RA 확인 affordance 를 발화한다.
 *     · ConfirmGate  → RA 확인 affordance 발화.
 *     · OptionSet/ImageOptionSet → 추천(recommended) 안의 select-<key> 발화(없으면 첫 안).
 *     · Progress/Verdict(pass) → affordance 없음(표시 전용) → 정지(자동 이어가기는 큐가 이미 했다).
 *     · Failure/GenerateRetry/Escalation → 비-happy 출구. 맹목 발화 금지 — 정지하고 분석기가 표시한다(S3 가 명시 구동).
 *     · Setup → 제품명 답글이 필요한 사람-입력 화면 → 정지(자동-happy 아님).
 *     · Done → 종단, 정지.
 *
 * ── 스텝 예산 ────────────────────────────────────────────────────────────────
 *   막힌 흐름이 무한 루프 대신 결정론적으로 끝나도록 최대 반복(기본 40)을 둔다 — 소진 시 budgetExhausted 로 기록.
 *
 * 커널-중립: kernel/·types/·acceptance/(같은 계층) 만 import(어떤 챗 플랫폼도 모른다 — kernel-neutral 가드 정신).
 */
import {
  createGateway,
  makeRunId,
  onAction,
  onMention,
  onReply,
  parseActionValue,
  type Gateway,
} from "../kernel/flow.js";
import type { ButtonPressed, ChatEvent, MentionReceived, TextReply } from "../kernel/events.js";
import type { Presentation } from "../kernel/presentation.js";
import type { NextAction } from "../types/contract.js";
import { affordancesOf, type AffordanceContext } from "./affordances.js";
import { RecordChatPort, type RecordedRender } from "./recording-port.js";
import { Transcript } from "./transcript.js";

/** ApproveGate 1차 액션 actionId(render.ts 미러 · affordances.ts 와 동일 규약). */
const APPROVE_ACTION_ID = "approve";
/** 다안 [이걸로] 버튼 actionId 접두어(render.ts `select-${key}`). */
const SELECT_ACTION_PREFIX = "select-";
/** 기본 감사 actor — 플랫폼 무지 토큰(끝 세그먼트 user id 는 CHAT_APPROVERS 매칭용). */
const DEFAULT_ACTOR = "chat:accept:U-driver";
/** 기본 스텝 예산(막힌 흐름의 결정론적 종료 상한). */
const DEFAULT_STEP_BUDGET = 40;

/** runToGate/runToDone 의 종료 사유. */
export type DriveStopReason = "predicate" | "terminal" | "no-forward" | "budget";

/** 구동 결과 — 도달 여부·사유·스텝 수·마지막 화면. */
export interface DriveResult {
  /** predicate(또는 runToDone 의 Done)에 도달했는가. */
  reached: boolean;
  reason: DriveStopReason;
  /** 소비한 스텝 수. */
  steps: number;
  /** 마지막(정지 시점) 화면. */
  final: Presentation | null;
}

/** SurfaceDriver 구성 옵션. */
export interface SurfaceDriverOptions {
  /** 인입 번들 폴더 절대경로(INGEST_STAGED 라우팅 필수). */
  bundleDir: string;
  /** 스테이징 워킹백워드 .md 절대경로(INGEST_STAGED 라우팅 필수). */
  stagedWbPath: string;
  /** 감사 actor(기본 DEFAULT_ACTOR). state.json history 에 --by 로 기록된다. */
  actor?: string;
  /** state 저장 루트(미지정 시 CHAT_STATE_DIR env). config 게터는 호출 시 env 를 읽으므로 생성 전 env set 필요. */
  stateDir?: string;
  /** 스텝 예산(기본 40). */
  stepBudget?: number;
}

/** runToGate predicate — (최신 화면, 그 시점 na) → 정지 여부. */
export type GatePredicate = (latest: Presentation | null, na: NextAction | null) => boolean;

/**
 * SurfaceDriver — 실 게이트웨이를 감싸 mention/reply/fire/quiesce 로 표면 흐름을 구동하고, 기록형 포트의
 *   Presentation 기록과 시간순 Transcript 를 노출한다. 결정 정책은 auto-happy(위 주석).
 */
export class SurfaceDriver {
  private readonly gw: Gateway;
  private readonly chatPort: RecordChatPort;
  private readonly _transcript = new Transcript();
  private readonly _actor: string;
  private readonly budget: number;
  /** 마지막으로 다룬 스레드(mention/reply/fire 가 갱신) — na 스냅샷 rid 해석용. */
  private _threadId: string | null = null;
  /** transcript 에 이미 접힌 기록 수(다음 스텝은 이후 렌더만 담는다). */
  private _consumed = 0;
  private _budgetExhausted = false;

  constructor(options: SurfaceDriverOptions) {
    this._actor = options.actor ?? DEFAULT_ACTOR;
    this.budget = options.stepBudget ?? DEFAULT_STEP_BUDGET;
    this.chatPort = new RecordChatPort();
    this.gw = createGateway({
      chat: this.chatPort,
      isApprover: () => true,
      bundleDir: () => options.bundleDir,
      stagedWbPath: () => options.stagedWbPath,
      readSurface: async () => null,
      ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    });
  }

  /** 감사 actor(state.json history 대조용). */
  get actor(): string {
    return this._actor;
  }

  /** 스텝 예산 소진 여부(막힌 흐름의 결정론적 종료 신호 — 분석기/시나리오가 읽는다). */
  get budgetExhausted(): boolean {
    return this._budgetExhausted;
  }

  /** 진행 중(대기 포함) run 수 — 정지 후 0 이어야 한다(잡 잔존 없음). */
  get activeRuns(): number {
    return this.gw.queue.activeRuns;
  }

  /** 시간순 트랜스크립트(빌더). */
  get transcript(): Transcript {
    return this._transcript;
  }

  /** 추출기/분석기용 런타임 바인딩(현재 스레드·actor). */
  affordanceContext(): AffordanceContext {
    return { actor: this._actor, threadId: this._threadId ?? "" };
  }

  /** 기록된 render 목록(방어적 스냅샷). */
  recorded(): RecordedRender[] {
    return this.chatPort.renders();
  }

  /** 기록된 화면들(순서 보존). */
  presentations(): Presentation[] {
    return this.chatPort.renders().map((r) => r.presentation);
  }

  /** 마지막(가장 최근) 화면 — 정지 후엔 resting 화면이다. 없으면 null. */
  latestPresentation(): Presentation | null {
    const all = this.chatPort.renders();
    return all.length > 0 ? all[all.length - 1]!.presentation : null;
  }

  /** 현재 스레드의 next-action 스냅샷(run 미생성/읽기 실패 시 null · best-effort). */
  async readNa(): Promise<NextAction | null> {
    const tid = this._threadId;
    if (!tid) return null;
    const rid = await this.gw.map.runForThread(tid).catch(() => null);
    if (!rid) return null;
    return this.gw.readNext(rid).catch(() => null);
  }

  /** 현재 스레드가 가리키는 run_id(없으면 null). */
  async runId(): Promise<string | null> {
    const tid = this._threadId;
    if (!tid) return null;
    return this.gw.map.runForThread(tid).catch(() => null);
  }

  /**
   * 게이트웨이가 사람의 답글/입력을 기다리는 상태인가(현재 스레드에 pending 설정됨). analyzer 의 dead-end 억제
   *   입력이다(analyze({..., awaitingReply}) — 보완 사유 요청·WB 붙여넣기 안내처럼 버튼 없이 답글이 출구인 화면을
   *   막다른 화면으로 오탐하지 않게). 읽기 전용 · best-effort(false 폴백).
   */
  async awaitingReply(): Promise<boolean> {
    const tid = this._threadId;
    if (!tid) return false;
    const pending = await this.gw.pending.get(tid).catch(() => null);
    return pending != null;
  }

  /** 큐 정지 대기 — 봇의 자동 이어가기(onOutcome 이 review/generate 잡 자동적재) 캐스케이드까지 정착. */
  async quiesce(): Promise<void> {
    await this.gw.queue.drain();
  }

  // ── 발화 프리미티브(모두 결정론 · 벽시계 0) ──────────────────────────────────

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

  /**
   * 발화된 affordance 라우팅. affordancesOf 는 버튼/Select 를 **모두 ButtonPressed 로** 방출한다(전송 계층이
   *   모든 클릭을 onAction 으로 전달하는 정직한 동치) → onAction 으로 라우팅한다. onChoice 를 직접 부르지 않는다
   *   (flow.onAction 이 action:"select" 를 내부에서 ChoiceMade 로 변환 — production 과 동일).
   */
  async fire(event: ButtonPressed): Promise<void> {
    if (event.threadId) this._threadId = event.threadId;
    await onAction(event, this.gw);
    await this.recordStep(event);
  }

  // ── 고수준 구동 ──────────────────────────────────────────────────────────────

  /**
   * predicate(최신 화면·na) 가 참이 될 때까지 auto-happy 발화를 반복한다. 매 스텝: quiesce → 최신 화면 검사 →
   *   predicate/종단이면 정지, 아니면 auto-happy affordance 발화. 스텝 예산 초과 시 결정론적 종료(budgetExhausted).
   */
  async runToGate(predicate: GatePredicate): Promise<DriveResult> {
    for (let i = 0; i < this.budget; i++) {
      await this.quiesce();
      const latest = this.latestPresentation();
      const na = await this.readNa();
      if (latest && predicate(latest, na)) {
        return { reached: true, reason: "predicate", steps: i, final: latest };
      }
      if (latest?.type === "Done") {
        return { reached: false, reason: "terminal", steps: i, final: latest };
      }
      const event = latest ? this.decide(latest) : null;
      if (!event) {
        return { reached: false, reason: "no-forward", steps: i, final: latest ?? null };
      }
      await this.fire(event);
    }
    this._budgetExhausted = true;
    return { reached: false, reason: "budget", steps: this.budget, final: this.latestPresentation() };
  }

  /** Done 종단까지 auto-happy 구동. */
  async runToDone(): Promise<DriveResult> {
    const res = await this.runToGate((p) => p?.type === "Done");
    return res;
  }

  /**
   * auto-happy 결정 — 화면 → 발화할 affordance(추출기가 낸 것 중에서 고른다). 비-happy/표시전용/종단은 null(정지).
   */
  decide(p: Presentation): ButtonPressed | null {
    const affs = affordancesOf(p, this.affordanceContext()) as ButtonPressed[];
    switch (p.type) {
      case "NlProposal":
        // 확정 버튼이 있으면 발화(complete 설정/인입). 질문만 있으면 [] → 사람 입력 대기 = 정지.
        return affs[0] ?? null;
      case "IngestPrompt":
        return affs[0] ?? null; // INGEST_STAGED(단일 affordance)
      case "ApproveGate":
        // 1차 액션(approve) 발화 — raOkRequired 면 ra_required 가 실려 다음이 ConfirmGate 다.
        return affs.find((a) => a.actionId === APPROVE_ACTION_ID) ?? affs[0] ?? null;
      case "ConfirmGate":
        return affs[0] ?? null; // RA 확인(단일 affordance)
      case "OptionSet":
      case "ImageOptionSet": {
        // 추천 안(recommended:true) 우선, 없으면 첫 안 — 그 안의 select-<key> affordance 를 value.option 으로 매칭.
        const recommended = p.options.find((o) => o.recommended)?.key ?? p.options[0]?.key;
        const chosen = affs.find(
          (a) => a.actionId.startsWith(SELECT_ACTION_PREFIX) && parseActionValue(a.value)?.option === recommended,
        );
        return chosen ?? affs.find((a) => a.actionId.startsWith(SELECT_ACTION_PREFIX)) ?? null;
      }
      // 표시 전용/사람-입력/비-happy/종단 → 정지(분석기가 문제면 표시).
      case "Setup":
      case "Progress":
      case "Verdict":
      case "Failure":
      case "GenerateRetry":
      case "Escalation":
      case "Done":
        return null;
      default: {
        // union 변이 추가 시 컴파일 실패 — 결정 정책도 새 변이를 다뤄야 한다(exhaustiveness).
        const _exhaustive: never = p;
        void _exhaustive;
        return null;
      }
    }
  }

  /** makeRunId 노출(시나리오가 core runs/<rid> 를 대조할 때). */
  static runIdFor(seed: string): string {
    return makeRunId(seed);
  }

  /**
   * 한 스텝 기록 — 발화 뒤 quiesce 하고, 지난 스텝 이후 렌더된 화면들 + na 스냅샷을 transcript 에 append.
   *   Transcript.append 가 깊은 복사로 시점 스냅샷을 봉인하므로 이후 재사용/변형과 격리된다.
   */
  private async recordStep(utterance: ChatEvent): Promise<void> {
    await this.quiesce();
    const all = this.chatPort.renders();
    const screens = all.slice(this._consumed).map((r) => r.presentation);
    this._consumed = all.length;
    const na = await this.readNa();
    this._transcript.append(utterance, screens, na ?? undefined);
  }
}
