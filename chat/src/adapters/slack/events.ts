/**
 * events.ts — Slack 이벤트 → 중립 ChatEvent 번역(어댑터 세부).
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-2): 플랫폼 이벤트를 커널이 아는 중립 형태(kernel/events.ts)로
 *   번역한다. 감사 체인의 시작점인 actor 를 여기서 `chat:slack:<user>` 로 정규화해 싣는다(플랫폼 태깅은
 *   어댑터 책임 — 커널은 actor 를 불투명 취급).
 */
import type { ButtonPressed, MentionReceived, TextReply } from "../../kernel/events.js";

/** Slack userId → 감사 actor(`chat:slack:<user>`). */
export const actorOf = (userId: string): string => `chat:slack:${userId}`;

/** Slack 버튼/Select 액션 → 중립 ButtonPressed. */
export function toButtonEvent(e: {
  actionId: string;
  value?: string;
  userId: string;
  threadId: string | null;
}): ButtonPressed {
  return { type: "button", actionId: e.actionId, value: e.value, actor: actorOf(e.userId), threadId: e.threadId };
}

/** Slack @멘션 → 중립 MentionReceived. text 를 실으면 커널이 NL 파서로 의도를 뽑는다(P3 · 선택). */
export function toMentionEvent(e: { threadId: string; userId: string; text?: string }): MentionReceived {
  return {
    type: "mention",
    threadId: e.threadId,
    actor: actorOf(e.userId),
    ...(e.text !== undefined ? { text: e.text } : {}),
  };
}

/** Slack 스레드 답글 → 중립 TextReply. */
export function toTextEvent(e: {
  threadId: string | null;
  text: string;
  userId: string;
  hasAttachments: boolean;
}): TextReply {
  return {
    type: "text",
    threadId: e.threadId,
    text: e.text,
    actor: actorOf(e.userId),
    hasAttachments: e.hasAttachments,
  };
}
