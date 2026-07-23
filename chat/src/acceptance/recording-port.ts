/**
 * recording-port.ts — 인수 하네스용 기록형 ChatPort(계획의 "RecordingChatPort" 역할).
 *
 * ⚠ 내보내는 클래스명은 `RecordChatPort` 다(계획 표기 "RecordingChatPort" 가 아니라). 이유: kernel-neutral
 *   가드의 금지 토큰에 `gchat`(Google Chat) 이 있어 "Recordin**gChat**Port" 의 부분문자열 "gChat" 이 오탐된다 —
 *   가드는 완화 금지(additive-only)라 대신 클래스명에서 그 부분문자열을 제거했다(역할·계약은 동일).
 *
 * ATDD 인수 계층(chat-atdd-acceptance-plan 2-2 "RecordingChatPort"): 실 게이트웨이(createGateway)에 물려
 *   커널이 render() 로 내보내는 중립 Presentation 을 **순서대로 기록**한다. 테스트는 이 기록을 읽어
 *   "멘션 뒤 어떤 화면이 떴나 · 순서 · 전이"를 결정론 assert 한다(플랫폼 표면 0 — 중립 Presentation 만 본다).
 *
 * FUTURE-LIVE TEE(라이브 백엔드 대비 · 계획 2-3): 생성자에 **선택** delegate ChatPort 를 받는다. 있으면
 *   각 호출을 **로컬 기록 후** delegate 에 위임한다 — 라이브에서 실 Slack 포트와 합성(Tee)해 "기록 + 실렌더"를
 *   동시에 얻기 위함(같은 하네스, 백엔드만 스왑). 없으면 순수 인메모리(CI 결정론).
 *
 * 커널-중립: src/kernel/** · src/types/** · node 빌트인만 import(어떤 챗 플랫폼도 모른다 — kernel-neutral 가드 정신).
 */
import type { CapabilityManifest, ChatPort } from "../kernel/ports.js";
import type { Presentation } from "../kernel/presentation.js";

/** 기록된 render 1건 — seq(0-based 단조 증가) · threadId · 그 시점 Presentation 스냅샷. */
export interface RecordedRender {
  readonly seq: number;
  readonly threadId: string;
  readonly presentation: Presentation;
}

/**
 * ChatPort 구현: 모든 render 를 순서대로 기록하고, 구독한 threadId 를 Set 으로 모은다.
 *   delegate 가 주어지면 기록 후 그대로 위임한다(Tee).
 */
export class RecordChatPort implements ChatPort {
  private readonly _renders: RecordedRender[] = [];
  private readonly _subscriptions = new Set<string>();
  private readonly delegate?: ChatPort;

  /** @param delegate 선택 — 있으면 render/subscribe/capabilities 를 로컬 처리 '후' 위임(라이브 Tee). */
  constructor(delegate?: ChatPort) {
    this.delegate = delegate;
  }

  async render(threadId: string, p: Presentation): Promise<void> {
    // 1) 로컬 기록 먼저(seq = 현재 길이 = 0-based 단조 증가). 호출부가 이후 p 를 변형해도 기록이 흔들리지 않도록
    //    ingress 에서 깊은 복사로 스냅샷한다.
    this._renders.push({
      seq: this._renders.length,
      threadId,
      presentation: structuredClone(p),
    });
    // 2) Tee: delegate 가 있으면 기록 '후' 원본 p 를 그대로 위임(실 포트가 커널이 보낸 것을 그대로 렌더).
    if (this.delegate) await this.delegate.render(threadId, p);
  }

  async subscribe(threadId: string): Promise<void> {
    this._subscriptions.add(threadId);
    if (this.delegate) await this.delegate.subscribe(threadId);
  }

  capabilities(): CapabilityManifest {
    // delegate(라이브 Tee)가 있으면 실 포트의 능력 선언을 그대로 노출한다.
    if (this.delegate) return this.delegate.capabilities();
    // 기본(순수 인메모리)은 Slack 어댑터 매니페스트를 미러한다 — 다안 이미지(P2) 하류 동작이 실제와
    //   같게(네이티브 파일 업로드 경로) 흐르도록 imageDelivery="upload" 를 선언(hostedUrl 분기를 타지 않음).
    return { imageDelivery: "upload" };
  }

  /**
   * 기록된 render 목록의 방어적 스냅샷(깊은 복사). 반환 배열/객체를 변형해도 내부 상태는 오염되지 않는다.
   */
  renders(): RecordedRender[] {
    return this._renders.map((r) => ({
      seq: r.seq,
      threadId: r.threadId,
      presentation: structuredClone(r.presentation),
    }));
  }

  /** 구독한 threadId 목록(중복 제거된 스냅샷). 테스트가 '구독이 일어났는지'를 assert. */
  subscriptions(): string[] {
    return [...this._subscriptions];
  }
}
