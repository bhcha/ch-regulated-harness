/**
 * transport.ts — Slack 어댑터의 전송·배선(Socket Mode) + ChatPort 구현.
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-1): vercel/chat SDK 는 **Slack 어댑터의 내부 구현 세부**다
 *   (전송·이벤트 배관·Block Kit 렌더). 이 파일이 그 SDK 를 커널과 격리한다:
 *     · ChatPort 구현: 커널의 중립 Presentation 을 render.toCard 로 Slack 카드로 번역해 게시.
 *     · SDK 이벤트 핸들러: Slack 이벤트를 events.ts 로 중립 ChatEvent 로 번역해 커널 flow 에 위임.
 *   커널(flow)은 이 파일도 SDK 도 모른다.
 *
 * 불변식: 핸들러는 즉시 ack 후 flow(→JobQueue)로 위임. state.json 직접 쓰기 0.
 *   1차 지원 표면 = **채널 스레드**만(DM 은 안내만 — 카드 액션/텍스트 답글 threadId 정합 미보장).
 */
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { Chat, stringifyMarkdown, type ActionEvent, type FileUpload } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { FileStateAdapter } from "../../kernel/file-state-adapter.js";
import { createGateway, onAction, onMention, onReply, type Gateway } from "../../kernel/flow.js";
import type { JobQueue } from "../../kernel/job-queue.js";
import type { ChatPort } from "../../kernel/ports.js";
import type { ImageOptionSetPresentation } from "../../kernel/presentation.js";
import { slackTokens } from "../../config.js";
import { toButtonEvent, toMentionEvent, toTextEvent } from "./events.js";
import { toCards } from "./render.js";

/**
 * Slack `Chat`(Socket Mode) 인스턴스 조립 — 전송 SDK·어댑터·상태를 묶는다(연결은 호출부가 initialize/listener 로).
 *   createBot 과 라이브 백엔드(live/) 가 **같은 조립**을 공유하게 별도 함수로 뽑았다(단일 진실 · 동작 불변).
 */
export function createSlackChat(): Chat {
  const state = new FileStateAdapter();
  const slack = createSlackAdapter({ mode: "socket", ...slackTokens() });
  return new Chat({ adapters: { slack }, state, userName: "규제 상세페이지 도우미" });
}

/**
 * Slack ChatPort — 커널의 중립 표현을 Slack 카드로 번역해 스레드에 게시(+ 구독 + 능력 선언).
 *   createBot(봇 상주) 과 라이브 백엔드(TeeRecordingPort 의 delegate) 가 **동일 렌더 규약**을 공유하도록
 *   여기 하나에서 만든다(uploadImageOptions 포함 · 두 경로가 갈라져 미묘한 업로드 로직이 이중화되지 않게).
 */
export function buildSlackChatPort(chat: Chat): ChatPort {
  return {
    render: async (threadId, p) => {
      // 이미지 다안(P2)은 선택 버튼 카드보다 **먼저** 미리보기 이미지를 스레드에 올린다(네이티브 파일 첨부).
      //   업로드 실패는 흐름을 막지 않는다(best-effort) — 선택 카드는 그대로 게시된다(캡션이 장수를 밝힘).
      if (p.type === "ImageOptionSet") {
        await uploadImageOptions(chat, threadId, p);
      }
      // 다안(OptionSet/ImageOptionSet)은 안별로 카드가 여러 장이다 — post 는 요소 1개씩만 받으므로 순차 게시.
      for (const card of toCards(p)) {
        await chat.thread(threadId).post(card as never);
      }
    },
    subscribe: async (threadId) => {
      await chat.thread(threadId).subscribe();
    },
    // Slack 은 파일 업로드(files_upload_v2)로 이미지 다안을 네이티브 전달한다(P2 · 인프라 0).
    capabilities: () => ({ imageDelivery: "upload" }),
  };
}

/** 실 Slack 봇 생성 — Socket Mode. 커널 flow 에 ChatPort(Slack 렌더)와 중립 이벤트를 위임한다. */
export function createBot(): { chat: Chat; queue: JobQueue } {
  const chat = createSlackChat();
  // ChatPort — 중립 표현을 Slack 카드로 번역해 스레드에 게시(+ 구독 + 능력 선언).
  const chatPort: ChatPort = buildSlackChatPort(chat);
  const gw = createGateway({ chat: chatPort });
  // 인터랙션 배선 추출(S-7) — 4핸들러 등록을 wireInteractionHandlers 로 뽑아 라이브 백엔드(live-assembly)와 공유한다.
  //   프로덕션 봇(여기)과 라이브 프로세스가 **같은 배선**으로 실 사람 클릭/답글을 게이트웨이에 라우팅한다(관측 동등).
  wireInteractionHandlers(chat, gw);
  return { chat, queue: gw.queue };
}

/**
 * 인터랙션 핸들러 배선(S-7) — Slack 이벤트(DM/멘션/버튼/답글) 4개를 중립 ChatEvent 로 번역해 커널 flow 에 위임한다.
 *   createBot(봇 상주) 과 라이브 백엔드(live-assembly.assembleLiveBackend) 가 **동일 배선**을 공유하도록 뽑았다 —
 *   추출 전 createBot 인라인 블록과 등록 순서·핸들러 몸통·문구가 바이트 동일(관측 동등 리팩터링).
 *   ⚠ 지어낸 버튼 금지: 여기서 하는 일은 실 플랫폼 이벤트 → 중립 이벤트 번역·위임뿐(버튼은 core readNext 재파생 카드에서만).
 *   ⚠ state.json 직접 쓰기 0: 즉시 위임 후 flow(→JobQueue)가 결정. 이 함수는 등록만 하고 연결(Socket Mode)은 호출부.
 *
 *   ⚠ opts.threadScope(라이브 전용 · additive): 지정 시 멘션/버튼/답글 핸들러가 **그 스레드 이벤트만** gw 로 위임하고
 *     다른 threadId 이벤트는 조용히 무시한다. 라이브 리허설 프로세스는 단일 스레드 전용이라, 이 스코프 없이는 같은
 *     게이트웨이·드라이버 뷰가 워크스페이스 전 스레드의 활동으로 오염된다(교차-스레드 상태 변이 · 남의 런 카드로 오발화).
 *     다른 스레드 개입은 프로덕션 봇 몫이다. **미지정(createBot 경로)이면 스코프 없음** = 전-스레드 배선(동작 바이트 불변).
 *     DM 안내는 스레드 무관 무해라 스코프 밖에서도 유지한다.
 */
export function wireInteractionHandlers(chat: Chat, gw: Gateway, opts?: { threadScope?: string }): void {
  const scope = opts?.threadScope;
  /**
   * 스코프 게이트 — 미지정이면 전부 통과. 지정 시 **논리 접두** 판정(엄격 일치 아님): CHAT_LIVE_THREAD 의 문서화된
   *   채널형(`slack:C…`)에서 Slack 은 카드별 버튼/답글을 자식 합성 id(`slack:C…:<message_ts>`)로 실어 보낸다 —
   *   엄격 일치는 그 실 사람 클릭을 전부 조용히 버려 개입 경로를 무음 차단한다(드라이버는 계속 돌아 가려짐).
   *   `<scope>:` 콜론 경계 접두라 `slack:C1` 이 `slack:C12…` 를 오매치하지 않는다.
   */
  const inScope = (tid: string | null | undefined): boolean =>
    scope === undefined || tid === scope || (typeof tid === "string" && tid.startsWith(`${scope}:`));

  // ⓪ DM 은 범위 밖 — 안내만(상태·잡 생성 없음). 스레드 무관 무해라 스코프와 무관하게 유지.
  chat.onDirectMessage(async (thread) => {
    await thread.post("여기(DM)에서는 진행할 수 없어요 — 작업 채널에서 저를 멘션해 주세요.");
  });

  // ① 진입 = @멘션. 멘션 메시지의 threadId 가 이 대화의 스레드다(SDK 가 구성). 멘션 본문(text)을 함께 실어
  //    커널이 자연어 의도를 뽑게 한다(P3 — 설정/파일 인입 제안). 빈/무의미 텍스트면 기존 빈 설정 카드로 폴백.
  chat.onNewMention(async (_thread, message) => {
    if (!inScope(message.threadId)) return; // 스코프 밖 스레드 멘션은 프로덕션 봇 몫(교차-스레드 오염 차단).
    await onMention(
      toMentionEvent({ threadId: message.threadId, userId: message.author.userId, text: message.text ?? "" }),
      gw,
    );
  });

  // ② 버튼/Select — 중립 ButtonPressed 로 번역해 flow 로.
  chat.onAction(async (event: ActionEvent) => {
    if (!inScope(event.threadId ?? null)) return; // 스코프 밖 스레드 버튼은 무시(라이브 드라이버 뷰 격리).
    await onAction(
      toButtonEvent({
        actionId: event.actionId,
        value: event.value,
        userId: event.user.userId,
        threadId: event.threadId ?? null,
      }),
      gw,
    );
  });

  // ③ 구독 스레드의 답글 — 자유 입력(WB 붙여넣기·보완 사유). 봇 자신 메시지는 무시.
  //   ⚠ 구독 후 재멘션도 여기로 온다(SDK 라우팅). 대기 입력이 있으면 답글 소비가 우선(멘션 재진입은 대기 없을 때만).
  chat.onSubscribedMessage(async (_thread, message) => {
    if (message.author.isMe || message.author.isBot) return;
    if (!inScope(message.threadId)) return; // 스코프 밖 스레드 답글/재멘션은 무시(교차-스레드 오염 차단).
    const threadId = message.threadId ?? null;
    const pending = threadId ? await gw.pending.get(threadId) : null;
    if (message.isMention && !pending) {
      await onMention(
        toMentionEvent({ threadId: message.threadId, userId: message.author.userId, text: message.text ?? "" }),
        gw,
      );
      return;
    }
    // ⚠ 마크다운 보존: message.text 는 포맷 제거 평문이라 붙여넣은 WB 의 구조가 소실된다. formatted(mdast)를
    //   markdown 으로 되돌려 core 에 저작 구조 그대로 넘긴다(실패 시 평문 폴백).
    let body = message.text ?? "";
    try {
      if (message.formatted) body = stringifyMarkdown(message.formatted);
    } catch {
      /* 평문 폴백 */
    }
    await onReply(
      toTextEvent({
        threadId,
        text: body,
        userId: message.author.userId,
        hasAttachments: (message.attachments ?? []).length > 0,
      }),
      gw,
    );
  });
}

/**
 * 이미지 다안 미리보기 게시(P2 · S-4 스파이크 결론) — vercel/chat 의 네이티브 파일 첨부를 쓴다.
 *
 * ── S-4 스파이크(파일 업로드 SDK 표면 실측) ────────────────────────────────────
 *   질문: `chat`/`@chat-adapter/slack` 이 파일 업로드를 노출하는가?
 *   실측: **노출한다.** `chat` 의 `thread.post()` 는 `PostableObject` 를 받고, 그 변이들(PostableMarkdown/
 *     PostableCard/…)이 `files?: FileUpload[]`(`{ data: Buffer|Blob|ArrayBuffer, filename, mimeType? }`)를 싣는다.
 *     `@chat-adapter/slack` 이 이를 받아 내부에서 `files.getUploadURLExternal`+`files.completeUploadExternal`
 *     (= `WebClient.files.uploadV2`, 곧 files_upload_v2)로 **스레드(thread_ts) 배치까지** 처리한다.
 *   선택: **SDK 네이티브 경로**(`post({ markdown, files })`)를 쓴다 — `@slack/web-api` 직접 호출·신규 의존성
 *     불필요(그 패키지는 슬랙 어댑터의 전이 의존이라 chat 루트에서 직접 resolve 되지도 않는다). 커널은 무관
 *     (업로드는 어댑터 내부 부수효과 — 구조 훼손 0).
 *   폴백: 업로드가 실패해도(경로 없음·네트워크·권한) 흐름은 계속된다 — 선택 카드가 그대로 게시되고 캡션이
 *     이미지 장수를 밝힌다(경로-캡션 폴백은 renderImageOptionSet 의 caption 이 이미 담당).
 *   ⚠ 무음 금지(라이브 실측 처방): 실패는 흐름을 막지 않되 **stderr 감사 1줄**은 남긴다 — 봇 토큰에
 *     `files:write` scope 가 없으면 files.uploadV2 가 missing_scope 로 죽는데, 조용히 삼키면 "첨부 0개"만 남고
 *     로그 무흔적이라 진단 불가였다(2026-07 데모 런). Slack SDK 에러 메시지는 에러 코드만 담아 토큰 비노출.
 *     ⚠ 전제조건: 이미지 첨부에는 Slack 앱 봇 토큰에 **`files:write` scope 가 필요**하다(chat:write 만으론 불가).
 *   오프라인 테스트: 실제 업로드는 Slack API(네트워크)라 **오프라인 검증 불가**(라이브 Slack 수동 1건 필요 —
 *     P2 DoD). 순수 렌더(renderImageOptionSet)와 커널 흐름은 오프라인 단위/통합 테스트가 덮는다.
 *     post 가 만드는 구조(업로드 선행·카드 후행·캡션 markdown)는 구조적 fake 로 단위 테스트가 잠근다
 *     (test/adapters/slack/transport.test.ts).
 */
async function uploadImageOptions(
  chat: Chat,
  threadId: string,
  p: ImageOptionSetPresentation,
): Promise<void> {
  for (const opt of p.options) {
    const files: FileUpload[] = [];
    // imagePaths 는 keyvisual-reader 가 realpath 로 심링크를 해소해 kvDir 하위 실파일만 vetting 한 것이다
    //   (임의 로컬 파일 업로드 차단 — Codex P2 HIGH). 여기선 그 검증된 경로만 읽는다.
    for (const path of opt.imagePaths) {
      try {
        files.push({ data: await readFile(path), filename: basename(path) });
      } catch (e) {
        // 개별 파일 읽기 실패는 건너뛴다(나머지 미리보기는 올린다). 단 감사 1줄(무음 소실 금지).
        process.stderr.write(
          `[slack-upload] ${opt.key}안 이미지 읽기 실패(건너뜀): ${basename(path)} — ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    if (files.length === 0) continue; // 올릴 이미지 없음(HTML 만) — 캡션 카드로 대체.
    try {
      await chat.thread(threadId).post({ markdown: opt.caption, files } as never);
    } catch (e) {
      // 업로드 실패는 흐름을 막지 않는다 — 선택 카드는 이어서 게시된다(best-effort). 단 감사 1줄은 남긴다:
      //   조용히 삼키면 "첨부 0개"만 남고 로그 무흔적이라 진단 불가(라이브 실측 — missing_scope 가 그랬다).
      //   Slack SDK 에러 메시지는 에러 코드 수준이라 토큰/시크릿 비노출.
      process.stderr.write(
        `[slack-upload] ${opt.key}안 이미지 업로드 실패(${files.length}장 · 흐름 계속): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}
