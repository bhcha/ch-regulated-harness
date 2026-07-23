# adapters/gchat/ — Google Chat 어댑터 (설계 자리 · 구현은 다음 차수)

> **지위**: 설계·매핑표만. 구현 코드 없음(chat-hexagonal-gateway-plan 잠긴 결정 3 — 출하는 Slack 먼저).
> 이 폴더가 존재한다는 것 자체가 **구조 분리의 증명**이다: 새 플랫폼 = `adapters/<플랫폼>/` 추가 + 레지스트리
> 등록만으로 붙고, **커널(`../../kernel/`)·P1~P3 산출물은 무수정**이어야 한다.

## 무엇을 구현하나 — `ChatPort` 하나

커널은 중립 `Presentation`(`kernel/presentation.ts`)을 내보내고 중립 `ChatEvent`(`kernel/events.ts`)를 받는다.
GChat 어댑터가 할 일은 Slack 어댑터(`../slack/`)와 **정확히 동형**이다:

| 파일 | 책임 | Slack 대응 |
|---|---|---|
| `transport.ts` | GChat 인입(webhook/HTTP 또는 Pub/Sub) 배선 + `ChatPort` 구현 | `slack/transport.ts`(Socket Mode) |
| `render.ts` | `Presentation` → **Cards v2** 번역 | `slack/render.ts`(Block Kit) |
| `events.ts` | GChat 이벤트 → 중립 `ChatEvent`(actor = `chat:gchat:<user>`) | `slack/events.ts` |

커널·포트(`kernel/ports.ts`)·표현·이벤트는 **import 만** 한다(무수정). `capabilities()` 로 자기 매핑 방식을 선언한다.

## 기능→플랫폼 매핑표 (chat-hexagonal-gateway-plan 2-3)

| 중립 기능(Presentation) | Slack 매핑(구현됨) | GChat 매핑(설계) |
|---|---|---|
| `Setup`/`ApproveGate`/`Verdict`/`IngestPrompt`/`Progress`/`ConfirmGate`/`Escalation` | 카드 + 버튼/Select(Block Kit) | **Cards v2** + 버튼/`selectionInput` |
| `OptionSet`(md 다안, P1) | 안별 카드 + [이걸로]/[다시 제안] 버튼 | 안별 Card v2 + 버튼 |
| `ImageOptionSet`(이미지 다안, P2) | `files_upload_v2` 스레드 업로드(**인프라 0**) | **호스팅 URL 이미지 카드** — `ImageHost` 보조 포트 필요 |
| 자유 입력(제품명·WB·보완 사유) | 스레드 답글(`TextReply`) | 스레드 답글(`TextReply`) |

> 원칙(잠긴 결정 2): 교집합으로 UX 를 깎지 않는다. 매핑 방식이 달라도 **커널이 보내는 Presentation·받는 Event 는 동일**하다.

## 활성화 시 결정해야 할 것 (이번 차수 범위 밖)

1. **인증**: GChat 앱은 서비스계정 JWT(Bearer) 또는 Chat API webhook. `slackTokens()` 대응 = GChat 자격증명 로더
   (`config.ts` 에 `GCHAT_*` env 추가 — Slack 과 직교, 커널 무관).
2. **이미지 호스팅(`ImageHost` 포트)**: GChat 은 파일 업로드 대신 **접근 가능한 이미지 URL**을 카드에 실어야 한다
   (`kernel/ports.ts` 의 `ImageHost.publish(filePath) → url`). 인프라(터널/프록시/클라우드 버킷·서명 단기 URL)는
   GChat 활성화 시 결정. Slack 은 `imageDelivery:"upload"` 라 이 포트가 **불필요**하다(R-6 격리).
3. **인입 표면**: Socket Mode 상주가 아니라 HTTP 엔드포인트(Cloud Run/Functions) 또는 Pub/Sub 구독 — `index.ts`
   기동을 어댑터 레지스트리로 선택.

## 감사 불변식(플랫폼 무관)

선택/승인 감사는 **Event(actor) → 잡큐 → core `--by chat:gchat:<user>`** 경로에서 남는다(표시 방식과 무관).
Slack 과 동일하게 3겹(core `state.json` history · 단계 `decision.json` · 챗 스레드)로 보존된다.
