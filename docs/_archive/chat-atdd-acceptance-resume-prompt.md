# 이어-착수 메타 프롬프트 — ATDD 인수 계층 구축 (chat 표면 흐름)

> ## 진행 상태 (2026-07-19 갱신 · 아래 원 스펙 본문은 보존)
>
> **S1–S4 (stub-CI 인수 계층) — 완료·커밋·main 병합(`603e92b`).** verify green: build · 단위 908(871+37 S5) ·
> stub E2E 5 · 인수 7/7 · core diff 0. 산출물 = `chat/src/acceptance/`(affordances·recording-port·transcript·driver·
> analyzer) + `chat/test/acceptance/`(규약 결박 + 6 시나리오) + `verify.sh` 인수 단계 + README. Codex 4라운드 수렴
> (critical/high 0 · P2 7건 수정).
>
> **S5 (라이브 온라인 백엔드) — 구축 완료 · 브랜치 `feat/chat-s5-live-backend`(미커밋).** `chat/src/live/`
> (tee-port·policy·stuck-detector·report-assembler·live-assembly·main) + `chat/test/live/` 37 오프라인 테스트 +
> 런북 `docs/reference/daemon-live-verification-runbook.md`. 잠긴 결정 4 확정(데몬 intake·brief + 운영자-동등 세션).
>
> **라이브 유료 런 — 1회 시도 · $0(파이프라인 진입 전 정지).** Slack auth·Socket Mode·데몬·자격증명(루트 `.env` 의
> ADK·NanoBanana 포함) 전부 실측 정상. 두 전제에서 멈춤(런북에 반영): ① `CHAT_LIVE_THREAD` 는 `slack:<채널ID>` 복합
> id 필수(맨 채널ID면 `ADAPTER_NOT_FOUND`) · ② **봇이 tee 채널 멤버여야 함**(사람이 `/invite @<봇>` — 봇 토큰에
> `channels:join` 없어 자가입장 불가).
>
> **재개 절차(라이브 완주):** (1) 사람이 tee 채널에 봇 초대 → (2) `CHAT_LIVE_THREAD=slack:<채널ID>` + 런북 3단계 env
> export → (3) 데몬(`CHAT_SDK_STAGES=intake,brief pnpm worker`) + 운영자 세션(브리프 너머 생성) 준비 → (4)
> `CHAT_LIVE_GO=1 pnpm live`. 상세 = `docs/reference/daemon-live-verification-runbook.md`.

> **용도**: 새 세션에서 이 프롬프트를 `/dev-loop`(또는 `/goal`)에 그대로 붙여 넣으면 ATDD 인수 하네스 구축을 이어서
> 착수한다. 아래 구분선 안이 프롬프트 본문이다(그대로 복사).

---

/dev-loop ATDD 인수 계층(표면 흐름) 구축 — 멘션→화면→입력→게이트→done 을 core 유도 조건으로 결정론 CI 검증.
리포 루트 /Users/chabh/workspace/ch-regulated-harness, 대상 = chat/ 레이어(TypeScript · Node20+ · pnpm+vitest).
core(../core)와 packs 는 **절대 수정 금지 — 읽기만**.

## 현재 상태 (착수 전 필히 인지)
- **W4 데몬 완료·리뷰됨 — 재작성 금지.** `chat/src/worker/cli-consumer.ts`·`main.ts` 는 Codex 2라운드 수렴
  (critical/high 0) + `pnpm verify` green(standalone 831 · stub E2E 5 · core diff 0). 미커밋(브랜치 `feat/w4-cli-consumer`).
  이 인수 계층은 데몬을 **소급 커버**만 한다(재작성 아님).
- **이 작업의 단일 진실 = `docs/plans/chat-atdd-acceptance-plan.md`.** 이미 작성됨. 특히 2단계(하네스 설계)·
  3단계(웨이브·단계별 CI 합격 기준)·6단계(리스크)를 그대로 따른다.
- **판정(이미 확정)**: 전면 리프레임 불필요. 데몬 유지 + 유일하게 비어 있는 "사용자 자리 흐름" 인수 계층만 테스트-퍼스트로 추가.

## 착수 전 필독(SSoT)
1. `docs/plans/chat-atdd-acceptance-plan.md` — 이 작업의 단일 진실(2·3·6단계).
2. `docs/plans/chat-live-acceptance-test-plan.md` — 라이브 = **이 하네스의 온라인 백엔드**(잠긴 결정 1~3 승계 · 커널
   이벤트 발화=Slack 클릭의 정직한 동치 · tee+JSONL · done+심의작동=유효). 라이브(S5)는 이번 범위 밖.
3. 코드: `chat/src/kernel/`의 flow.ts(onMention/onAction/onChoice/onReply/onOutcome · createGateway/GatewayDeps ·
   presentationForNext/presentationForOutcome/deriveVerdict) · presentation.ts(Presentation union 13종) · ports.ts(ChatPort) ·
   events.ts(ChatEvent union) · interaction.ts(actionId 어휘) · viewmodel.ts. `adapters/slack/render.ts`(payload() 규약 ·
   toCards()) · `gen-executor.ts`(selectGenExecutor: 오프라인=StubDirect · 온라인=Bridge · makeStubRunJob) · `job-queue.ts`(drain).
4. 씨앗·재사용: `test/e2e/nl-flow.e2e.test.ts`(유일하게 실 createGateway + 기록형 fake ChatPort 로 Presentation assert →
   확장 대상) · `test/adapters/slack/render.test.ts`(버튼 walk 로직 재사용) · `test/fixtures/next-action/`(core 유도 웨이포인트) ·
   `scripts/verify.sh`(CI 게이트 — 인수 단계를 4단계 stub E2E 와 5단계 core 무수정 증명 **사이**에 넣는다).

## 목표
멘션 이후 **어떤 화면이 뜨고·어떤 입력(버튼·선택·답글)이 가능하고·선택 후 어떻게 전이하고·무슨 문제가 있는지**를,
core 가 낸 실제 답(next-action JSON · surface.actions · 픽스처)에서 유도한 조건으로 **결정론 CI**(HARNESS_OFFLINE=1)로
덮는다. 같은 하네스를 라이브(온라인 백엔드)에서 재사용하지만 이번엔 **stub-CI 만** 짓는다.

## 소유 파일(신규/수정)
- `chat/src/acceptance/recording-port.ts` (신규 — ChatPort 구현 · render 마다 Presentation 기록 · 라이브 tee 확장 여지)
- `chat/src/acceptance/affordances.ts` (신규 — 순수 `Presentation → ChatEvent[]` · render.ts payload 규약 미러)
- `chat/src/acceptance/transcript.ts` (신규 — 시간순 {발화, 이후 화면들, na 스냅샷} JSONL)
- `chat/src/acceptance/driver.ts` (신규 — 실 createGateway 래핑 · mention/reply/fire/quiescence · auto-happy 결정 정책)
- `chat/src/acceptance/analyzer.ts` (신규 — 순수 문제 분석: Failure·막다른 화면·stuck·잡 잔존·미지 Presentation)
- `chat/test/acceptance/affordance-convention.test.ts` (신규 — 추출기 출력 ≡ toCards() 실렌더 버튼 전수 결박)
- `chat/test/acceptance/*.accept.test.ts` (신규 — 멘션→done 완주·보완루프·에스컬레이션·[다시 만들기]·stale 거부·Bridge+데몬 핸드오프)
- `chat/scripts/verify.sh` (수정 — 인수 시나리오 단계 추가 · core 무수정 증명 **앞**)
- `chat/README.md` (수정 — 테스트 계층 절에 인수 계층 + 시간 예산)
- **NOT touch**: `core/**`·`packs/**` · 데몬(`cli-consumer.ts`·`main.ts` 재작성 금지) · W1~W3 확정 모듈 계약 · `presentation.ts`/`render.ts`/`events.ts` 계약(소비만).

## 반드시 지킬 불변식
- **core 무수정**: verify 5단계 `git -C ../core status` 로 검증(인수 시나리오가 core stub 을 부린 뒤라야 오염을 잡는다 — 순서 유지).
- **결정론 CI**: `HARNESS_OFFLINE=1` · 주입 시계·폴링 간격 단축 · 실 LLM/네트워크/신호 0. **LLM 심판을 CI 안에 넣지 않는다**(구조 assert 만).
- **추출기 ↔ render.ts 규약 결박 선행(S1a)**: affordance 추출기 출력이 실렌더 버튼(actionId·value)과 전수 일치함을
  결박 테스트로 못 박는다. 결박 없는 추출기는 "지어낸 버튼" — **절대 선행**. Presentation union 변이 추가 시 컴파일/테스트가 깨져야 한다(exhaustive).
- **oracle 순환 금지**: 기대 화면을 프로덕션 `presentationForNext` 재실행으로 계산하지 않는다 — 웨이포인트는 **픽스처-핀
  매핑표(테스트 소유)**, 나머지는 폐쇄 속성(모든 화면 affordance 수용·발화 시 전진·N스텝 내 done·Failure/막다른 화면 0).
- **커널-중립**: `src/acceptance/`(driver·port·추출기·분석기)는 어떤 챗 플랫폼도 import 하지 않는다(플랫폼 무지 · kernel-neutral
  가드 정신). 단 `test/acceptance/affordance-convention.test.ts` 만 결박 목적으로 slack render 를 import 한다(테스트라 허용).
- **ci-examples 오염 회피**: 추적 안 되는 `inputs/examples/cosmetic` 이 ingest 를 00g 로 라우팅→대량 실패. 전 시나리오가
  mktemp `HARNESS_EXAMPLES_DIR`(brief-flow.e2e 선례) 답습 · `--format 여러장`으로 00g 안 태우기(금지토큰 stall) 승계.
- **env 게터 타이밍**: config 게터는 호출 시 env 를 읽는다 — createGateway/데몬 생성 **전에** env set · 스위트당 파일 1개 · afterAll 복원.
- **fs·시간 flakiness**: 전용 rid(`chat-e2e-accept-*`) + afterAll `rmSync`(macOS ENOTEMPTY 재시도 패턴) · 벽시계 assert 금지.
- **데몬 enablement CI 왜곡 금지**: 데몬 핸드오프 시나리오에서 `CHAT_SDK_STAGES` 를 전 단계로 늘려 "CI 에서만 되는 무인"을
  만들지 않는다 — 라이브 계약(intake·brief 만 · keyvisual 구조 차단) 미러, 그 너머는 드라이버 운영자-동등 소비로 정직히 가른다.

## 단계·웨이브 (계획 3단계 표 · 각 단계 Codex critical/high 0 후 다음)
- **W-A(병렬)**: S1a 추출기+규약결박 · S1b 기록포트+transcript
- **W-B**: S2 드라이버+분석기 (멘션→brief승인 구간 완주·문제 0 = nl-flow 확장)
- **W-C**: S3 전 파이프라인 시나리오 (①멘션→done 완주[자동 이어가기 실검증] ②Bridge+데몬 핸드오프 ③비-happy: 보완·에스컬레이션·[다시 만들기]·stale 거부)
- **W-D**: S4 verify.sh 게이트 배선 + README
- **W-E(보류·범위 밖)**: S5 라이브 백엔드+런북

## DoD (각 단계 회귀 게이트)
`HARNESS_ROOT=/Users/chabh/workspace/ch-regulated-harness/core pnpm verify` green — build(tsc --noEmit 0) → 단위 →
픽스처 멱등 → stub E2E → **인수(신규)** → core diff 0. 기존 831 단위 + 5 stub E2E 불변. kernel-neutral green.

## 범위 밖(하지 말 것)
- **S5 라이브 백엔드**(실 Slack tee·온라인 게이트웨이·실 데몬·stuck 디텍터·런북) — CI green 뒤 별도.
- **데몬 재작성** · **CI 내 LLM 심판** · **Playwright 상시 구동** · **keyvisual 무인 편입** · core/packs 수정.

## 리뷰
각 단계 완료 즉시 Codex 리뷰(`review --background`, run_in_background) → critical/high 0 까지 수정·재리뷰(라운드 캡 3).
적대적 리뷰 예상: 추출기↔render 규약 드리프트·oracle 순환·stub-라이브 충실도 갭·핸드오프 경합. X-class 는 문서화하고 수렴.

---

> **참고**: 데몬 작업(W4)은 이미 완료·리뷰·verify green 상태이며 아직 커밋 전이다(`feat/w4-cli-consumer`). 커밋 여부는
> 사람 지시 대기. 이 인수 계층은 그 위에 얹는 별도 작업이다.
