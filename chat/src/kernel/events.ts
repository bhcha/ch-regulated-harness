/**
 * events.ts — 중립 입력 이벤트(ChatEvent) · 커널이 소유하는 SSoT.
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-2): 플랫폼 어댑터가 자기 이벤트(Slack ActionEvent·메시지 등)를
 *   이 중립 형태로 번역해 커널 flow 에 넘긴다. 커널은 플랫폼 이벤트 타입을 import 하지 않는다.
 *
 * actor 규약(감사 체인의 시작점): 어댑터가 `chat:<플랫폼>:<user>`(예 `chat:slack:U123`)로 **정규화해** 싣는다.
 *   커널은 actor 를 불투명 문자열로 취급한다(플랫폼 태깅은 어댑터 책임 — 커널은 플랫폼 무지).
 */

/** @멘션 진입 — 새 작업 설정 시작 트리거. */
export interface MentionReceived {
  type: "mention";
  threadId: string;
  actor: string;
  /**
   * 멘션 메시지의 자유 텍스트(P3 · 선택). 있으면 커널이 NL 파서로 의도를 뽑아 NlProposal 을 낸다(설정/파일 인입).
   *   없거나 의미 없으면 기존대로 빈 설정 카드로 시작한다(후방호환 — additive).
   */
  text?: string;
}

/** 스레드 답글(자유 입력) — 제품명·워킹백워드 본문·보완 사유. */
export interface TextReply {
  type: "text";
  threadId: string | null;
  text: string;
  actor: string;
  hasAttachments: boolean;
}

/**
 * 버튼/Select 조작. actionId 로 분기(설정 Select·[시작]·RA 확인·잡 버튼).
 *   value = 버튼에 실린 페이로드(잡 버튼은 JSON `{run_id, action, ...}`; 설정 Select 는 선택 토큰).
 */
export interface ButtonPressed {
  type: "button";
  actionId: string;
  value?: string;
  actor: string;
  threadId: string | null;
}

/**
 * 다안 중 한 안을 고름(P1) — [이걸로] 클릭. run_id 는 싣지 않는다(스레드↔run 매핑으로 커널이 해석 —
 *   1 스레드=1 run, 클라이언트가 준 run_id 를 신뢰하지 않음). actor 는 어댑터가 정규화한 감사 시작점.
 */
export interface ChoiceMade {
  type: "choice";
  optionKey: string;
  actor: string;
  threadId: string | null;
  /**
   * 클릭한 카드가 낸 다안의 도장(stamp) — 어댑터가 버튼 value 에서 실어 보낸다. 커널이 현재 run 의 select
   *   게이트(phase·iteration)와 대조해 stale 클릭(재생성·다음 단계 옛 카드)을 거른다. 부재 시 대조 생략.
   */
  expectedPhase?: string;
  expectedIteration?: number | null;
}

/** 커널 flow 가 소비하는 중립 입력 이벤트. */
export type ChatEvent = MentionReceived | TextReply | ButtonPressed | ChoiceMade;
