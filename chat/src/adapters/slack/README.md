# Slack 어댑터 (ChatPort 구현)

커널이 내보내는 중립 `Presentation` 을 Slack 네이티브 UI(Block Kit 카드 · 파일 첨부)로 번역하는 어댑터다.
커널(`src/kernel/`)은 이 폴더도 vercel/chat SDK 도 모른다(헥사고날 — 플랫폼 무지).

- `transport.ts` — Socket Mode 배선 + `ChatPort` 구현(중립 표현 게시 + 구독 + 능력 선언 + 이미지 첨부).
- `render.ts` — `Presentation` → Block Kit 카드(순수 · 업로드/부수효과 없음).
- `events.ts` — Slack 이벤트 → 중립 `ChatEvent` 번역.

## S-4 스파이크 — Slack 파일 업로드 SDK 표면 (P2)

**질문**: `chat` / `@chat-adapter/slack` SDK 가 파일 업로드 API 를 노출하는가?

**실측 결과 — 노출한다(SDK 네이티브 경로 채택)**:

- `chat` 의 `Thread.post()` 는 `PostableObject` 를 받고, 그 변이(`PostableMarkdown`·`PostableCard`·
  `PostableRaw`·`PostableAst`)가 모두 `files?: FileUpload[]` 를 싣는다.
- `FileUpload = { data: Buffer | Blob | ArrayBuffer; filename: string; mimeType?: string }`.
- `@chat-adapter/slack` 이 `files` 가 실린 메시지를 받으면 내부 `postMessage` 가 `extractFiles()` →
  `uploadFiles()` → `WebClient.files.uploadV2({ channel_id, file_uploads, thread_ts })` 로 처리한다
  (= `files_upload_v2`). **스레드(thread_ts) 배치까지 SDK 가 알아서** 한다.

**선택**: SDK 네이티브 `thread.post({ markdown, files })` 를 쓴다.
- `@slack/web-api` 를 직접 부르거나 새 의존성으로 추가하지 **않는다** — 그 패키지는 `@chat-adapter/slack` 의
  전이 의존이라 `chat/` 루트에서 직접 resolve 되지도 않고(offline 설치 불가), SDK 가 이미 같은 `files.uploadV2` 를
  내부에서 호출하므로 중복이다. 커널은 무관(업로드는 어댑터 내부 부수효과 — 구조 훼손 0).

**렌더/전송 분리**:
- `render.ts` 의 `renderImageOptionSet` 은 **순수**하다 — 캡션 + `[이걸로]`(도장 동봉) + `[다시 제안]` 카드만
  만들고 이미지 바이트를 만지지 않는다.
- 실제 이미지 첨부는 `transport.ts` `ChatPort.render` 의 부수효과다: `p.type === "ImageOptionSet"` 이면 선택
  카드보다 **먼저** 각 안의 이미지를 `post({ markdown: caption, files })` 로 스레드에 올린다.

**폴백(graceful degrade)**: 업로드가 실패해도(경로 없음·네트워크·권한) 흐름은 계속된다 — 선택 카드가 그대로
게시되고 캡션이 이미지 장수(또는 "미리보기 없음")를 밝힌다. 개별 파일 읽기 실패도 나머지 미리보기는 올린다.

**오프라인 테스트 범위**: 실제 업로드는 Slack API(네트워크)라 **오프라인 검증 불가**(라이브 Slack 수동 1건이
P2 DoD). 순수 렌더(`renderImageOptionSet`)와 커널 흐름(ImageOptionSet 생산·select 게이트 완주)은 오프라인
단위/통합 테스트가 덮는다.
