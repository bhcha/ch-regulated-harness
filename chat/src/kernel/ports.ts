/**
 * ports.ts — 커널→플랫폼 driven 포트(ChatPort) + 능력 선언(CapabilityManifest).
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-2): 커널은 중립 Presentation 을 render() 로 내보내고,
 *   각 플랫폼 어댑터가 이 포트를 구현해 자기 네이티브 UI(Slack Block Kit·GChat Cards v2 등)로 번역한다.
 *   새 플랫폼 = 이 포트를 구현하는 `adapters/<플랫폼>/` 추가 + 등록만(커널 무수정).
 *
 * 동결(additive-only): 메서드/필드는 추가만(기존 시그니처 변경 금지).
 */
import type { Presentation } from "./presentation.js";

/**
 * 어댑터가 자기 매핑 능력을 선언한다(기능→플랫폼 매핑표 2-3). 커널은 이 선언을 보고 중립 기능을
 *   플랫폼별 최적 방식으로 흘려보낸다(교집합으로 UX 를 깎지 않는다 — 잠긴 결정 2).
 */
export interface CapabilityManifest {
  /**
   * 다안 이미지(P2) 전달 방식.
   *   "upload"    — 네이티브 파일 업로드(예 Slack files_upload_v2 · 인프라 0)
   *   "hostedUrl" — 호스팅 URL 이미지 카드(예 GChat · ImageHost 보조 포트 필요)
   *   "none"      — 이미지 다안 미지원(경로 안내로 대체)
   */
  imageDelivery: "upload" | "hostedUrl" | "none";
}

/** ChatPort(커널→플랫폼, driven) — 어댑터가 구현. */
export interface ChatPort {
  /** 중립 표현 → 플랫폼 네이티브 게시. */
  render(threadId: string, p: Presentation): Promise<void>;
  /** 스레드의 후속 답글을 받도록 구독. */
  subscribe(threadId: string): Promise<void>;
  /** 어댑터의 매핑 능력 선언. */
  capabilities(): CapabilityManifest;
}

/**
 * ImageHost(보조 driven 포트 · P2/GChat 설계 자리) — 이미지 다안을 "hostedUrl" 로 내보내는 어댑터가
 *   서명 단기 URL 을 얻는 통로. Slack("upload")은 이 포트가 불필요하다. 활성 구현은 GChat 차수에서.
 */
export interface ImageHost {
  /** 로컬 이미지 파일 경로 → 접근 가능한 (단기) URL. */
  publish(filePath: string): Promise<string>;
}
