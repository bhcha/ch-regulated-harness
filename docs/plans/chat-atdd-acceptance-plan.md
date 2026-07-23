# 개발 방법 변경 계획 — ATDD 인수 계층(표면 흐름) · CI 우선, 사람 최종확인

> **지위**: `docs/plans/`(진행 중 계획). **작성**: 2026-07-19. **근거**: Fable 코드근거 분석(2026-07-19).
> **관계**: [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md)(W4 데몬 — 완료·보완) ·
> [`chat-live-acceptance-test-plan.md`](chat-live-acceptance-test-plan.md)(라이브 인수 — 개정·같은 하네스의 온라인 백엔드).
> chat 계층 문서라 core 정본 D-1 갱신 의무 밖(AGENTS 3번 절) — `docs/README.md` 총지도에 한 줄만 등재.

## 0. 한 줄 정의 + 필요성 판정(정직)

멘션 이후 **어떤 화면이 뜨고 · 어떤 입력(버튼·선택·답글)이 가능하고 · 선택 후 어떻게 전이하고 · 끝까지 가는 데 무슨
문제가 있는지**를, **core에서 유도한 인수조건**으로 **테스트 코드가 결정론 CI**로 덮고(+AI가 시나리오 저작·트랜스크립트
판독), 그 CI가 green인 **뒤에만** 사람이 라이브/Slack로 최종 확인한다.

**필요성 판정 — "전면 리프레임(데몬 재작성)"은 불필요, "부분 채택(빠진 인수 계층 추가 + CI 승격)"이 정답.**
- **데몬을 테스트-퍼스트로 다시 쓸 필요: 없음.** `cli-consumer.ts`+`main.ts`는 전 로직이 주입 seam 뒤라 결정론 단위
  24건 + Codex 2라운드 수렴(critical/high 0) + 데몬 stub E2E(1잡 완주)로 이미 덮였다. 재작성은 같은 코드를 비용
  들여 재도출할 뿐 새 정보 0. → **소급(retroactive) 인수 커버**가 옳다.
- **오늘 실제로 빠진 것 = 표면 전체 흐름 인수 테스트**(1단계 절). 그래서 "굳이 다 하지 않아도" — **데몬은 유지**하고
  **빠진 인수 계층만** 테스트-퍼스트로 짓는다. 완료·리뷰·green인 작업은 재수행하지 않는다.

## 1. 왜 필요한가 — 오늘 비어 있는 것(코드 근거)

현재 stub E2E 5건과 단위 테스트로도 **멘션→화면→입력→게이트→done의 표면 흐름은 검증되지 않는다**:

1. **stub E2E 4건 중 3건이 게이트웨이(flow.ts)를 우회한다.** `brief-flow`·`select-flow`·`keyvisual-flow` 전부
   `new Worker(...)`+`new JobQueue(...)`를 직접 조립해 손으로 만든 Job을 넣는다. `onMention/onAction/onChoice/onReply/
   onOutcome`을 하나도 타지 않고 **Presentation(화면)을 단 한 번도 assert하지 않는다**(검증 = next-action phase·
   decision.json·파일 실재뿐).
2. **봇의 자동 이어가기가 실 core 대상으로 미검증.** `onOutcome`의 자동 review/generate 적재(flow.ts `AUTO_GENERATE_STAGES`)는
   `flow.test.ts`에서 **가짜 NextAction**으로만 검증된다. "brief 통과→concept 자동생성→…→done"을 봇이 스스로 끌고
   가는 실제 루프는 어디서도 끝까지 돌지 않는다(e2e는 review 잡을 손으로 넣는다).
3. **화면·입력(affordance)의 폐쇄성 미검증.** 렌더된 버튼(render.ts `payload()`)이 커널 수용 이벤트(`parseActionValue`)와
   왕복 정합인지, 모든 화면에 출구가 있는지(막다른 화면 0), stale 도장 거부가 흐름을 안 막는지 — 이걸 묶어 보는 테스트가 없다.
4. **데몬이 게이트웨이 루프 '안'에서 소비자로 도는 조합 미검증.** consumer-daemon e2e는 잡을 손 적재한다 —
   Bridge(적재·폴링) ↔ 데몬(클레임·소비) 핸드오프가 아웃컴 루프와 함께 도는 시나리오가 없다.
5. **씨앗은 있다.** `nl-flow.e2e.test.ts`가 유일하게 실 `createGateway`+기록형 fake ChatPort로 Presentation을
   assert한다 — 단 IngestPrompt에서 멈춘다. 빠진 계층의 배아가 이 파일이다.

## 2. ATDD 방법 — 인수조건의 core 유도 + CI 하네스

### 2-1. 인수조건을 core에서 유도(지어낸 화면 금지)

관측 가능한 인수 표면은 core가 이미 기계 계약으로 낸다:
- **`next-action.sh` 한 줄 JSON** = 주계약(`action`·`options[]`·`recommended`·`revise_available`·`ra_ok_required`·`stage`·`iteration`).
- **`a2ui-surface.sh`** = core가 "이 게이트에서 사람이 발화 가능한 named event 집합"을 **직접 선언**(`A2uiSurface.actions`).
- **NextAction→Presentation 매핑은 전수 코드**(`presentationForNext`·`presentationForOutcome`·`deriveVerdict`).
- **드리프트 가드 이미 존재**: `test/fixtures/next-action/` 6개 픽스처를 `capture-fixtures.sh`가 실 stub 런에서
  재캡처, `verify.sh` 3단계가 재캡처 멱등(diff 0) 강제 → **core 계약이 바뀌면 CI가 먼저 안다**.

유도식: *"페이즈 X에서 na를 읽으면(실 core stub) action=Y → 그때 화면 타입·버튼셋은 (na, surface.actions)에서
유도 → 추출한 affordance A를 발화하면 core 게이트머신이 na'로 전이"*. 손으로 화면을 짓지 않는다.

⚠ **oracle 순환 주의**: 기대 화면을 프로덕션 `presentationForNext`를 재실행해 계산하면 "코드가 코드와 같다"는
공허한 검증이 된다. 웨이포인트 기대값 = **픽스처에 핀된 별도 매핑표(테스트 소유)**, 나머지는 폐쇄 속성으로 assert:
①렌더된 모든 화면의 affordance는 커널이 수용 ②발화하면 na 전진 ③N스텝 안에 done ④Failure/막다른 화면 0.

### 2-2. CI 인수 하네스(전부 chat/ 안 · core 무수정)

| 부품 | 위치 | 내용 |
|---|---|---|
| **RecordingChatPort** | `chat/src/acceptance/recording-port.ts` | `ChatPort` 구현: render마다 `{seq, threadId, presentation}` 기록(메모리+JSONL). 라이브에선 실 Slack 포트와 합성해 Tee |
| **Affordance 추출기** | `chat/src/acceptance/affordances.ts` | 순수 `Presentation → ChatEvent[]`(actionId·value를 render.ts payload 규약대로). **"어떤 입력이 들어올 수 있나"의 기계화** |
| **규약 결박 테스트** | `chat/test/acceptance/affordance-convention.test.ts` | 각 Presentation 변이를 `toCards()`로 실렌더→버튼 walk→(actionId,value) 집합 ≡ 추출기 출력 전수 assert. **"커널 이벤트 발화=Slack 클릭의 정직한 동치"의 CI 증명 + 드리프트 봉인** |
| **SurfaceDriver** | `chat/src/acceptance/driver.ts` | 실 `createGateway`(deps 주입) 래핑. `mention`/`reply`/`fire(affordance)`/quiescence 대기(`queue.drain`) + 결정 정책(auto-happy: recommended 선택·승인·RA) + 스텝 예산. **실행 백엔드 스왑 가능** |
| **Transcript** | `chat/src/acceptance/transcript.ts` | 시간순 `{발화 이벤트, 이후 렌더 화면들, na 스냅샷}` JSONL — CI assert 재료이자 **AI 판독 입력**(라이브 공유) |
| **문제 분석기** | `chat/src/acceptance/analyzer.ts` | 순수 분석: Failure 화면·막다른 화면(미완인데 affordance 0)·stuck(같은 게이트 N회 정체)·잡 잔존·미지 Presentation |
| **시나리오 스펙** | `chat/test/acceptance/*.accept.test.ts` | `HARNESS_OFFLINE=1`+실 core stub. 멘션→done 완주·보완 루프·에스컬레이션·[다시 만들기]·stale 거부 |

**"AI+테스트코드가 화면·입력 커버"의 실체**: 테스트 코드가 구조(화면·버튼·전이·완주)를 결정론 assert하고, AI는
①시나리오(결정 정책·적대 순서)를 코드로 저작 ②CI/라이브 transcript를 읽어 구조 assert가 못 잡는 질적 문제(안내
문구 혼란·출구 부족)를 판독한다. **LLM 심판을 CI 안에 넣지 않는다**(비결정 — CI는 구조 assert만).

### 2-3. stub-CI vs 라이브 = 하나의 하네스, 두 백엔드

같은 SurfaceDriver+추출기+transcript+분석기에 **실행 백엔드만** 갈아 끼운다:
- **CI 백엔드(싼 것·결정론)**: 오프라인 env → `selectGenExecutor`=StubDirect → 실 core stub 결정론 전이. 별도
  시나리오로 Bridge 주입 + `ConsumerDaemon`(`makeStubRunJob`)을 같은 잡 디렉터리에 물려 적재→클레임→소비→전이
  감지 핸드오프까지 CI에서 돈다(폴링 간격 주입 단축).
- **라이브 백엔드(비싼 것·수동 게이트)**: RecordingPort를 실 Slack transport와 Tee, 온라인 env, 생성 소비 = 실
  데몬(intake·brief) + 브리프 너머는 드라이버 운영자-동등 소비. assert는 구조 판정으로 완화(done 도달·심의
  revise/escalation=유효). **CI 불가·수동 게이트**(런당 $15-30·1-2.5h)는 그대로 — 다만 라이브가 검증할 것이
  "전부"에서 **"라이브에서만 알 수 있는 것"**(Slack 실렌더·실 과금·심의 비결정·nonce/ps 카나리)으로 줄어든다.

## 3. 단계 계획 (의존 순서 웨이브 · 단계별 CI 합격 기준)

| 웨이브 | 단계 | 산출물 | CI 합격 기준 | 방식 |
|---|---|---|---|---|
| **W-A**(병렬) | **S1a** 추출기+결박 | `affordances.ts`+`affordance-convention.test.ts` | Presentation 전 변이(13종)에서 추출기 출력 ≡ `toCards()` 실렌더 버튼 집합. union 변이 추가 시 컴파일/테스트 실패(exhaustive) | 테스트-퍼스트 |
| | **S1b** 기록 포트+transcript | `recording-port.ts`·`transcript.ts` | 단위 green(순서·직렬화 결정성) | 테스트-퍼스트 |
| **W-B** | **S2** 드라이버+분석기 | `driver.ts`(auto-happy)·`analyzer.ts` | 실 게이트웨이+core stub로 멘션→IngestPrompt→WB답글→…→brief 승인 구간 완주, 분석기 발견 0(nl-flow 확장) | 테스트-퍼스트 |
| **W-C** | **S3** 전 파이프라인 시나리오 | ①멘션→done 완주(자동 이어가기 실검증) ②Bridge+데몬 핸드오프(intake·brief=데몬, 이후=드라이버 소비 · 라이브 enablement 미러) ③비-happy: 보완 루프·에스컬레이션·[다시 만들기]·stale 거부 | 전 시나리오 결정론 green(HARNESS_OFFLINE=1)·전용 rid+정리·시간 예산 문서화 | **소급**(게이트웨이 자동 루프+데몬 재작성 없이 커버) |
| **W-D** | **S4** CI 게이트 배선 | `verify.sh`에 "인수 시나리오" 단계 추가(4단계와 **core 무수정 증명 5단계 사이** — 순서 원칙 유지)+transcript 아티팩트+README 갱신 | `pnpm verify` 한 번에 build→단위→픽스처멱등→stub E2E→**인수**→core diff 0 | 배선 |
| **W-E**(보류) | **S5** 라이브 백엔드+런북 | TeeChatPort·온라인 게이트웨이·실 데몬·stuck 디텍터 + `daemon-live-verification-runbook.md` | CI 대상 아님 — 수동 게이트 런 1회=판정 가능한 transcript 1개 | 라이브 계획 실행 |

## 4. 사람 테스트의 위치

**CI(stub 결정론 인수)가 1차 게이트, 사람/라이브는 최종 확인 — 1차 검증이 아니다.**
1. 모든 머지/단계 완료 조건 = **CI 인수 green**(S4 이후 `pnpm verify` 전체).
2. CI green **후에만** 사람이: **(a) 라이브 인수 런**(S5 · 실 과금 — CI가 원리적으로 못 보는 것만: nonce/ps
   카나리·과금 귀속·심의 비결정 작동·Slack 실렌더 왕복) · **(b) 실 Slack 스모크**(Socket Mode 수신·카드 실렌더·파일
   업로드·실클릭 — Playwright 표본 외엔 자동화 불가).
3. 사람 검증 선행물 = **데몬 라이브 검증 런북**(현재 부재 · S5에서 작성). ※ `chat-live-acceptance-test-plan.md`가
   이 런북을 링크하나 파일 미존재(dangling) — S5에서 해소.

## 5. 두 기존 계획과의 정합

- **`chat-unmanned-consumer-plan.md` → 보완(본문 무수정)**: W0~W4 완료·잠긴 결정·사람 승인 대기 1건은 그대로.
  변화 하나 — **W5(라이브 검증)의 실행 수단**이 "사람 손 체크리스트"에서 "S5 드라이버가 돌리고 사람이 transcript로
  판정"으로 업그레이드(카나리 ①~⑦은 여전히 라이브 전용). W5 행에 한 줄 추기.
- **`chat-live-acceptance-test-plan.md` → 개정(대체 아님)**: 잠긴 결정 1~3(커널 이벤트 발화·구조 판정·tee+JSONL)
  **승계**되고 S1a 결박 테스트가 결정 1의 근거를 CI로 상시 증명. 바뀌는 것: ①3번 절 부품 5종이 "라이브 때 새로
  짓는 것"→"**CI에서 이미 검증된 공용 하네스에 백엔드만 스왑**" ②미결이던 잠긴 결정 4(브리프 너머 생성 경로)에 CI가
  기본안 실증(데몬 intake·brief + 드라이버 운영자-동등 소비) ③"CI 상시 불가"는 라이브 런에 한해 참, 싼 CI 대체물
  존재 명기 ④런북 dangling 해소.
- **신규 문서 = 이 문서**. 두 문서를 상호 참조.

## 6. 리스크·함정

1. **추출기↔render.ts 드리프트**(유일 실질 위험): S1a 전수 결박 테스트(실렌더 버튼 walk 비교)+union never-exhaustive로
   봉인. 결박 없는 추출기는 "지어낸 버튼" — 절대 선행.
2. **oracle 순환**: 기대 화면을 프로덕션 매퍼 재실행으로 계산 금지 → 웨이포인트는 픽스처-핀 매핑표, 나머지 폐쇄 속성.
3. **stub-라이브 충실도 갭**: stub은 LLM 내용·심의 비결정·실 이미지·Slack API·과금을 못 본다 — 결함 아니라 분업.
   그 목록을 "라이브 전용 검증 항목"으로 명시해 CI green 과신 방지.
4. **ci-examples 오염**: 추적 안 되는 `inputs/examples/cosmetic`이 ingest를 00g로 라우팅→대량 실패. 전 시나리오가
   mktemp `HARNESS_EXAMPLES_DIR`(brief-flow 선례) 답습 필수 · `--format 여러장`으로 00g 안 태우기(금지토큰 stall) 승계.
5. **env 전역 변이·게터 타이밍**: config 게터는 호출 시 env를 읽는다 — 데몬/게이트웨이 생성 **전에** env set(consumer-daemon.e2e 선례). 스위트당 파일 1개+afterAll 복원.
6. **실 fs·시간 flakiness**: 전용 rid+afterAll rmSync(macOS rm 내성 기존 패턴)·폴링 간격 주입 단축·벽시계 assert 금지·verify 5단계(core diff 0)가 인수 뒤라 정리 누락을 CI가 잡음.
7. **과잉 범위**: 분석기 5체크로 충분 — 범용 봇 테스트 프레임워크·CI 내 LLM 심판·Playwright 상시 구동은 비범위.
   keyvisual 구간은 stub도 Playwright 렌더로 느림(기존 e2e 360s) — 완주 시나리오는 integration 계층만, 시간 예산 문서화.
8. **데몬 enablement의 CI 왜곡**: 시나리오 ②에서 `CHAT_SDK_STAGES`를 전 단계로 늘려 "CI에서만 되는 무인"을 만들지
   말 것 — 라이브 계약(intake·brief만·keyvisual 구조 차단) 미러, 그 너머는 드라이버 운영자-동등 소비로 정직히 가른다.

## 7. 고지

본 계획·인수 하네스는 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). CI 인수는 결정론
구조 검증이고, LLM 내용·심의 비결정·실 과금·Slack 실렌더는 **라이브 전용**이라 CI green이 그것을 보증하지 않는다.
