# 라이브 인수테스트 계획 — AI 구동 온라인 E2E (착수: 백엔드+런북 구축 완료)

> **지위**: `docs/plans/`(진행 중 계획 · **착수 — S5 백엔드+런북 구축 완료 · 실 라이브 런은 사람 수동 게이트로 잔존**). **작성**: 2026-07-19.
> **진행(S5, 2026-07-19)**: 잠긴 결정 1~3 승계 + 잠긴 결정 4 **확정**(아래 표)로 온라인 실행 백엔드를 **공용 하네스의
> 백엔드 스왑**으로 구축했다 — `chat/src/live/`(TeeChatPort·온라인 게이트웨이 조립·LiveDriver·stuck 디텍터·판정
> 리포트) + 오프라인 단위 테스트(`chat/test/live/`) + 운영자 런북([`../reference/daemon-live-verification-runbook.md`](../reference/daemon-live-verification-runbook.md)).
> **남은 것 = 사람의 수동 게이트 런 1회**(실 과금 · 런북대로). 코드는 실 서비스를 호출하지 않는다(조립·판정만).
> **근거 분석**: Fable 심층 타당성 분석(코드 근거, 2026-07-19) — 아래 '제약·불가능' 절이 그 요지다.
> 관계: [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md)(W4 데몬)의 **라이브 검증(W5) 후속**.

## 0. 한 줄 정의

W4까지는 사람이 Slack에서 손으로 눌러 확인해야 한다. 그 사람 실측을 **AI가 대신** 하도록, 멘션 이후부터
**실 온라인/라이브**(실 claude 세션·실 과금·실 자격증명)로 파이프라인을 돌리고, **어떤 화면이 떴고 · 무엇을
선택할 수 있고 · 선택 후 무슨 일이 났고 · 끝까지 가는 데 무슨 문제·부족이 있는지**를 AI가 판독·판단할 수 있는
**인수테스트**(stub 아님)를 만든다.

## 1. 잠긴 결정 (사람, 2026-07-19)

| # | 결정 | 값 |
|---|---|---|
| 1 | **화면 조작(입력 충실도)** | **커널 이벤트 발화** — 렌더된 카드의 payload 에서 도출해 `onAction`/`onChoice`/`onReply`/`onMention` 발화. Slack 버튼 클릭은 API 로 불가(사람 클릭만)라, 어댑터 번역이 순수 매핑인 점을 근거로 커널 이벤트를 **Slack 클릭의 정직한 동치**로 쓴다(지어낸 버튼 금지 · stamp 정직 전달). |
| 2 | **완주 범위 + 종료 판정** | **done 까지**(keyvisual 이미지 포함 시도) + **심의 작동 = 유효**. 심의가 revise/escalation 으로 끝나는 런은 '실패'가 아니라 '적대적 심의가 일한 유효 결과'로 판정한다(루프 상한 내). 인수 판정 = **구조적**(done 도달·산출물 존재+스키마·게이트 순서 준수·감사 actor·image-manifest 완결·Failure 0·잡 수명주기 위반 0). LLM 본문 내용 일치는 assert 대상이 아니다. |
| 3 | **관측 방식** | **실 Slack tee + JSONL** — 커널로 구동하되 실 Slack 채널에도 카드를 tee 게시(사람 참관·사후검토) + recorder JSONL 트랜스크립트(화면·선택지·동작·전이·문제). SLACK 토큰 + 전용 채널 필요. |
| 4 | **브리프 너머 생성 경로** | **확정(S5, 2026-07-19) = CI 실증 기본안** — **데몬은 intake·brief 만 무인 소비**(`CHAT_SDK_STAGES=intake,brief` = `live-assembly.LIVE_DAEMON_STAGES` · keyvisual 무인은 구조적 차단이라 넓히지 않는다 — 하네스 hazard-8). **브리프 너머(concept/storyboard/keyvisual) 생성은 운영자-동등 세션이 C2 브리지로 소비**하고, **선택/승인 같은 사람-버튼 결정은 AI 드라이버(`LiveDriver`)가 직전 렌더에서 도출해 발화**한다. 이는 CI 시나리오 ②(Bridge+데몬 핸드오프)·①(멘션→done)이 오프라인으로 검증한 그대로다(옛 대안 (a)=드라이버 운영자-동등 소비 채택, (b)=데몬 확장 기각). |

## 2. 제약·불가능 (Fable 코드근거 분석 · 정직 고지)

### ❌ 원리적으로 불가능
- **AI 가 실 Slack UI 버튼을 클릭** — Slack 에 *다른 앱의 block_actions 를 발화시키는 API 가 없다*(사람 클릭만).
  텍스트(멘션·답글)는 사용자 토큰으로 가능하나 버튼은 불가. 유일한 진짜-클릭 = Playwright 브라우저 자동화
  (로그인/2FA/DOM 취약 · CI 부적합). → 잠긴 결정 1 이 커널 이벤트 발화를 택한 이유.
- **keyvisual 무인 생성** — `chat/src/worker/skill-rewrite.ts:151-157` 이 명시적으로 throw. keyvisual 전이가
  백그라운드 이미지 bake(10~14장)+폴링이라 무인 세션의 '전이 명령 정확히 1개' 결박(skill-rewrite.ts:319-325)과
  구조적으로 양립 불가. 데몬 직접 전이도 insession 마커 부재로 core fail-closed(AGENTS 2번 절). SKILL.md 는 core
  소유(수정 금지)라 **재설계 없이는 불가**.
- **CI 상시 실행** — 런당 ~$15–30(구독 환산) + 1~2.5시간 + 비결정 심의 + live-only 자격증명. **수동 게이트
  라이브 런**만 성립.
- **LLM 산출 내용 정확 일치 assert** — 실엔진 비결정. 구조적 assert 만 유효(잠긴 결정 2).

### ⚠ 오늘 데몬 무인으로 가능한 범위
- `SUPPORTED_STAGES = ["intake","brief"]`(skill-rewrite.ts:49)뿐. concept/storyboard 는 미측정(부록A-11 이
  단계별 dry-run 실측 선행 요구), keyvisual 은 구조적 차단. **데몬만으로는 브리프까지 무인 라이브, concept 차례에서
  정지.** done 까지 가려면 잠긴 결정 4(보류)의 경로 확정 필요.

### ✅ 결정 이벤트의 정직성
- 승인/선택/RA 는 설계상 사람 버튼(데몬은 generate 만 소비). 렌더된 카드 payload 에서 도출해 커널 이벤트로
  발화하면 Slack 클릭과 **계약 동치**(어댑터 번역이 순수 매핑 — `adapters/slack/events.ts` 의 순수 변환 함수).
  stamp(phase·iteration)도 정직 전달 → stale 가드 통과. 검증 안 되는 것 = Slack 실 렌더·클릭 왕복(그건
  Playwright 표본만 커버).

## 3. 착수 시 아키텍처 (전부 chat/ 안 · core 무수정)

1. **드라이버(오케스트레이터)** — `chat/test/acceptance/` 또는 `chat/src/acceptance/`. `createGateway({chat: teePort, …})`
   를 in-process 조립. 온라인 env(오프라인 아님)라 생성은 자동으로 Bridge → W4 데몬/운영자-동등 소비.
2. **TeeChatPort** — RecordingChatPort(모든 Presentation 을 `{ts, threadId, presentation}` JSONL) + 실 Slack ChatPort
   (transport.ts 재사용) 이중 렌더(잠긴 결정 3).
3. **Affordance 추출기(신규 순수 모듈)** — `Presentation → 가능한 ChatEvent[]`(render.ts `payload()` 규약 미러).
   AI 심판이 "이 화면에서 무엇을 누를 수 있었고 무엇을 눌렀나"를 구조적으로 판정하는 재료. **render.ts 규약 드리프트는
   렌더 스냅샷 테스트로 봉인**.
4. **결정 정책** — 기본 auto-happy(추천안 select · approve · RA confirm) + revise/escalation 도달 시 기록·상한 내 재시도.
   모든 발화는 직전 렌더에서 도출(잠긴 결정 1).
5. **생성 소비** — 잠긴 결정 4 확정에 따라: 데몬(intake·brief[+확장]) 또는 드라이버의 운영자-동등 소비(keyvisual 포함).
6. **판정 리포트** — recorder JSONL + `jobs/failed/*.reason` + core `state.json` history/`timing.jsonl`/`verdict.json`
   (`critic_ran`/`critic_outcome`/`review_depth`) + (tee 시) `conversations.replies` 덤프 → AI 심판 입력.
   **stuck 디텍터**(같은 next-action > N분) 신규 필요.

## 4. 필요 자격증명·외부 서비스 (전부 fail-closed)

| 자격 | 용도 | 부재 시 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 무인/운영자 세션 구독 인증 | 세션 인증 실패로 잡 failed |
| `NANOBANANA_API_KEY` | keyvisual 이미지 실생성 | fail-closed die(common.sh) |
| `ADK_COSMETICS_CRITIC_URL`(+`_ALLOWED_HOST`) | cosmetic 심의(원격 ADK) | 설정오류 fail-closed(KCIA_CRITIC_REQUIRED 자동 1) |
| `CHAT_APPROVERS`(테스트 actor 포함) | 결정 이벤트 승인자 가드 | 아무도 승인 불가(fail-closed) |
| `SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`(+테스트 사용자 토큰) | 실 Slack tee/수신(잠긴 결정 3) | tee 불가(커널-드라이브는 됨) |
| `HARNESS_ROOT`·`CHAT_SDK_STAGES` | 배선 | fail-fast |

## 5. 예산·시간 (수동 게이트 런 · 잠긴 결정 2)

- 비용(구독 환산): intake $4 + brief $1 + concept/outline/plan 각 ~$1–3 + keyvisual HTML ~$3–8 ≈ **$12–20** + 이미지(Gemini)·심의(GCP).
- 벽시계: 순정 45분–1.5시간, revise 1–2회 포함 시 **1–2.5시간**.
- → **CI 불가 · 수동 게이트 라이브 인수 런**(1회 실행 = 1개 판정 가능한 트랜스크립트).

## 6. 착수 상태 (S5 완료 · 수동 게이트 잔존)

1. **W4 데몬 작업 완료** — ✅ 코드 완성 · verify green · Codex 2라운드 수렴(critical/high 0).
2. **S5 온라인 백엔드 + 런북 구축** — ✅ (2026-07-19): 공용 하네스의 **백엔드 스왑**으로 구축 — `chat/src/live/`
   (TeeChatPort=`tee-port.ts`[동결 `RecordChatPort` delegate 이음새로 실 Slack tee + JSONL] · 온라인 게이트웨이 조립
   =`live-assembly.ts`[`createGateway({chat: teePort})` → selectGenExecutor 자동 Bridge] · `LiveDriver`[auto-happy 정책
   =`policy.decideForward`, affordancesOf 재사용] · stuck 디텍터=`stuck-detector.ts` · 판정 리포트=`report-assembler.ts`)
   + 오프라인 단위 테스트(`chat/test/live/`) + 운영자 진입점(`pnpm live` · `CHAT_LIVE_GO=1` 안전 ack). verify green
   (standalone·stub E2E 5·인수 7/7·core diff 0 불변). **코드는 실 서비스를 호출하지 않는다**(조립·판정만).
3. **런북 작성** — ✅ [`../reference/daemon-live-verification-runbook.md`](../reference/daemon-live-verification-runbook.md)
   (자격증명·env·단계별 실행·관측·구조 판정·예산·안전). 이 문서 7번 절이 가리키던 dangling 링크 해소.
4. **남은 것 = 사람의 수동 게이트 라이브 런 1회** — 실 자격·실 과금으로 런북대로 실행해 판정 가능한 트랜스크립트 1개를 얻고
   구조 판정(잠긴 결정 2)을 확인한다. CI 는 이 런을 대체하지 못한다(실 Slack 렌더·실 과금·심의 비결정·이미지 실생성).

> **⚠ 실행 방식 개정(2026-07-19)**: 이 라이브 인수테스트는 이제 **독립 구축이 아니라 [`chat-atdd-acceptance-plan.md`](chat-atdd-acceptance-plan.md)
> 의 공용 하네스(SurfaceDriver·affordance 추출기·transcript·분석기)의 온라인 백엔드**로 짓는다(S5). 3번 절 부품 5종은
> "라이브 때 새로 짓는 것"이 아니라 "CI에서 이미 검증된 하네스에 실행 백엔드만 스왑". 잠긴 결정 1~3 은 그대로 승계되고,
> S1a(규약 결박 테스트)가 잠긴 결정 1(커널 이벤트 발화 = Slack 클릭의 정직한 동치)의 근거를 CI 로 상시 증명한다.

## 7. 고지

본 산출물·인수테스트는 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). 라이브 런은 실 과금이
발생하며, 비결정 심의의 revise/escalation 은 결함이 아니라 설계된 적대적 게이트의 작동이다(잠긴 결정 2).
