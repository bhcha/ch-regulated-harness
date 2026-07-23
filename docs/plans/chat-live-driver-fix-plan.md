# 라이브 드라이버 수정 + 브리프-너머 생성 배선 계획 — 3안 카드 3종을 실 Slack 에서 done 까지 (option ㉯)

> **지위**: `docs/plans/`(진행 중 계획 · **chat 계층 문서 — core 정본 D-1 갱신 의무 밖**). **작성**: 2026-07-19. **브랜치**: `feat/chat-s5-live-backend`.
> **관계**: [`chat-live-acceptance-test-plan.md`](chat-live-acceptance-test-plan.md)(잠긴 결정 1~4 — 본 계획은 그 **1차 라이브 런의 결함 수정 + 재런**) ·
> [`chat-atdd-acceptance-plan.md`](chat-atdd-acceptance-plan.md)(공용 하네스 — 오프라인 CI 불변 유지) ·
> [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md)(W4 데몬) ·
> [`../reference/daemon-live-verification-runbook.md`](../reference/daemon-live-verification-runbook.md)(런북 — 본 계획이 재런 레시피로 보강).
>
> ⚠ **이 문서는 계획일 뿐이다 — 사람의 go 전에는 아무것도 실행하지 않는다.** 코드 수정·데몬 기동·라이브 런·과금은 전부
> 아래 웨이브의 사람 승인 게이트 뒤에 있다. 이 계획 작성 자체는 읽기 전용이었다(코드 0줄 수정 · 프로세스 0개 기동).

---

## 0. 한 줄 정의 · 목표 · 비용 스탠스

**1차 라이브 런**(2026-07-19)은 실 Slack 채널 `C0BJAELG2KU` 에서 brief 실 ADK 심의(revise→재생성→pass)까지 도달했지만,
**3안(A/B/C) 제안 카드는 0건** 게시된 채 드라이버가 유휴로 멈췄다. 이 계획은 그 원인 3가지를 고쳐 **유료 재런 1회**에서:

- **02-concept — 메시지 방향 3안**(OptionSet 카드),
- **03-storyboard(outline) — 스토리라인 3안**(OptionSet 카드),
- **04-keyvisual — 이미지 디자인 3안**(ImageOptionSet 카드 · 실 NanoBanana 이미지 첨부),

이 **세 카드 세트가 전부 실 Slack 채널 `C0BJAELG2KU` 에 tee 로 게시**되고, 드라이버가 그 사이의 판정(Verdict)·진행
(Progress)·실패(Failure) 화면에서 멈추지 않고 **done 까지** 몰고 가는 것을 사람이 눈으로 보게 한다.

**비용 스탠스(사용자 확정)**: 구독 플랜 Claude 세션(무인 데몬 + 운영자-동등 세션) + NanoBanana 이미지 실생성 비용은
**승인됨**(키비주얼 실이미지 포함 풀런). 피해야 할 것은 **예상 밖의 종량(metered) API 지출**뿐이다 — 본 계획의 외부
호출면은 ①구독 세션(Claude) ②Gemini 이미지(NanoBanana 키) ③원격 ADK(GCP Cloud Run) ④OpenAlex(무료) ⑤Slack(무료)로
한정되며, 새 종량 API 를 추가하지 않는다. 사용자는 채널을 참관하며 **전 구간을 지켜본다**.

---

## 1. 1차 런에서 확인된 사실 (코드 근거 — 재도출 아님 · 본 계획 수립 시 파일로 재확인)

### 원인 1 — 라이브 드라이버가 Verdict/Progress/Failure 에서 유휴로 멈춘다

- `chat/src/live/policy.ts` `decideForward()` 는 동결 `SurfaceDriver.decide`(CI 백엔드)의 **미러**라, 행복 게이트
  (NlProposal·IngestPrompt·ApproveGate·ConfirmGate·OptionSet·ImageOptionSet)에서만 발화 이벤트를 내고
  `Setup·Progress·Verdict·Failure·GenerateRetry·Escalation·Done` 은 전부 `null` 을 낸다(policy.ts 54~62행).
- `chat/src/live/live-assembly.ts` `LiveDriver.runToDone()`(184~199행)은 `null` 을 곧장 `no-forward` 종료로 취급한다.
- CI(오프라인 stub)에서는 이 정책이 문제되지 않았다 — `quiesce()`(= `gw.queue.drain()`, `job-queue.ts` 97~101행)가
  onOutcome 의 자동 이어가기(심의·생성 자동 적재, `flow.ts` 978~994행)까지 **동기적으로 전부 소화**해, drain 뒤의
  최신 화면이 이미 다음 인터랙티브 게이트였기 때문이다. 라이브에서는 생성이 **Bridge**(pending 잡 적재 + 폴링,
  `gen-executor.ts` 191~251행)라 대기·타임아웃·실패 화면이 최신 렌더로 남을 수 있고, 그 순간 드라이버가 죽는다.

### 원인 2 — 브리프 너머 생성 잡을 아무도 소비하지 않는다

- 온라인 게이트웨이의 생성 실행기는 자동으로 **BridgeGenExecutor**(C2)다: pending 잡 파일을 적재하고 외부 소비자가
  전이시키기를 `CHAT_BRIDGE_TIMEOUT`(기본 **900초**, `config.ts` 288행)까지 폴링한다.
- 무인 데몬의 enablement 는 `CHAT_SDK_STAGES=intake,brief`(= `live-assembly.ts` 51행 `LIVE_DAEMON_STAGES`)뿐이고,
  구조 상한도 같다 — `chat/src/worker/skill-rewrite.ts` 49행 `SUPPORTED_STAGES = ["intake","brief"]`.
- 따라서 brief 통과 후 자동 적재된 **concept 생성 잡은 900초 뒤 회수·실패**로 끝났고(Failure 카드), 원인 1과 겹쳐
  드라이버가 그 자리에서 유휴가 됐다. OptionSet/ImageOptionSet 은 생성 전이 후에만 만들어지므로 **한 번도 나오지 못했다**.

### 원인 3 — `HARNESS_DOMAIN` 미주입 → 심의 스폰이 fail-closed + ADK Pass-A 빈응답 flaky

- `core/scripts/lib/ingest.py` 26~28행: `HARNESS_DOMAIN` 미설정이면 `raise SystemExit(...)` — **BaseException** 이라
  `except Exception` 계층에 안 잡히고, `examples_analysis.py`→`ingest.py` import 경로를 타는 guideline 심의가
  fail-closed 로 죽었다. 1차 런은 `export HARNESS_DOMAIN=cosmetic` 으로 우회했다.
- chat 의 core 스폰은 `harness-cli.ts` 50행에서 `{...process.env, ...harnessEnv(), ...}` 로 env 를 전달하므로,
  **부모 프로세스에 export 만 돼 있으면 전파된다**(harnessEnv() 자체는 HARNESS_ROOT/OFFLINE/EXAMPLES_DIR/WB 만 명시).
- ADK Pass-A 빈응답 flaky 는 `ADK_CRITIC_RETRY` 상향으로 완화했다(+ 기존 메모리: `○○○○` 포이즌·대용량 출력 한계).

### 추가 실측 (본 계획 수립 중 확인 — 수정 2 의 방향을 결정)

- `core/skills/concept/SKILL.md` 는 ```bash 펜스 규약을 지킨다(펜스 2개: `--emit-context` 읽기 + 전이 1개 — rewriteSkill
  의 "전이 정확히 1개" 결박 통과 가능 형태). 그러나 **`storyboard-outline`·`storyboard-plan` 의 SKILL.md 는 ```bash
  펜스가 아예 없고 인라인 코드로만 명령을 적는다** → `rewriteSkill` 은 펜스만 파싱하므로(skill-rewrite.ts 33~37행 주석
  · 319~325행 전이 1개 강제) **전이 0개로 throw = 데몬 편입이 코드 수정 없이는 불가능**하다.
- keyvisual 은 기존 진단 그대로 구조적 차단(skill-rewrite.ts 151~157행 명시 throw — 백그라운드 이미지 bake+폴링이
  '전이 명령 정확히 1개' 결박과 양립 불가). 인터랙티브/운영자 세션이 필요하다.

---

## 2. 수정 1 — 드라이버 정책 + runToDone: 판정·진행·실패에서 멈추지 않기

### 2-1. 설계 원칙

- **동결물 무수정**: `acceptance/driver.ts`(동결 SurfaceDriver)와 기존 `decideForward()` 는 그대로 둔다 —
  `decideForward` 는 CI 정책의 미러라는 정체성(주석·기존 `test/live/policy.test.ts`)을 유지해야 오프라인 CI 가 불변이다.
- **신규 순수 함수 `decideLive()`** 를 `policy.ts` 에 추가한다. 행복 게이트는 `decideForward` 에 위임하고, 나머지
  변이에 **3분법**(wait · recover · stop)을 준다. exhaustiveness never 가드 동일 적용(변이 추가 시 컴파일 실패).

```ts
export type LiveDecision =
  | { kind: "fire"; event: ButtonPressed }     // 행복 전진(decideForward 위임)
  | { kind: "recover"; event: ButtonPressed }  // 회복 발화(Failure→[상태 다시 확인] · GenerateRetry→[다시 만들기])
  | { kind: "wait" }                           // 자동 이어가기 캐스케이드가 다음 게이트를 낼 때까지 유한 대기
  | { kind: "stop"; reason: "done" | "escalation" | "human-input" };
```

### 2-2. 변이별 결정표 (decideLive)

| Presentation | 결정 | 근거 |
|---|---|---|
| NlProposal·IngestPrompt·ApproveGate·ConfirmGate·OptionSet·ImageOptionSet | `fire`(decideForward 결과) · 결과가 null 이면 `stop:human-input` | 기존 auto-happy 그대로(잠긴 결정 1 — 직전 렌더의 affordance 에서만 도출) |
| Setup | `stop:human-input` | 완결 NL 멘션이면 애초에 NlProposal 이 온다 — Setup 잔류는 사람 입력 필요 |
| Progress | `wait` | 표시 전용 — 캐스케이드(자동 review/generate 적재)가 진행 중이거나 Bridge 가 폴링 중 |
| Verdict(pass·revise) | `wait` | **발화 금지가 핵심**: revise 든 pass 든 `onOutcome` 이 이미 다음 잡(재생성/심의/다음 생성)을 자동 적재한다(flow.ts 978~994행). 여기서 Verdict 카드의 [다시 만들기](affordances.ts 110~112행)를 또 누르면 **이중 적재**가 되어 enqueueJob 이 in_progress 거부 → 불필요한 Failure 카드를 스스로 만든다 |
| Verdict(human) | `stop:escalation` | 사람 판단 대상(아래 Escalation 과 동일 취급) |
| Failure | `recover`([상태 다시 확인] = RECONCILE affordance, affordances.ts 91~92행) | 읽기 전용 화해 — 현재 게이트 카드를 다시 그린다. 생성 차례면 GenerateRetry 카드가 온다(flow.ts presentationForStatusCheck) |
| GenerateRetry | `recover`([다시 만들기] affordance, affordances.ts 93~94행) | **새 마감이 붙은 새 요청**을 적재(프로토콜 v2 — stale 부활 아님). Bridge 타임아웃 후 소비자가 늦었을 때의 정식 출구 |
| Escalation | `stop:escalation` | 심의 반복 상한 해제(raise-limit)는 적대 게이트를 무력화하는 **사람/RA 결정** — 자동 발화 금지. 카드·리포트로 가시화하고 멈춘다 |
| Done | `stop:done` | 종단 |

### 2-3. runToDone 루프 (live-assembly.ts 재작성 골격)

```
반복 (fire 스텝 < stepBudget[기본 40 유지] AND 경과 < runBudgetMs[신규 · 기본 4시간]):
  quiesce()                       # queue.drain — 자동 캐스케이드·Bridge 폴링을 여기서 소화(기존 그대로)
  latest = latestPresentation()
  d = decideLive(latest)
  · stop:done        → reached=true 반환
  · stop:escalation / stop:human-input → reached=false, reason 그대로 반환(리포트에 가시화)
  · fire             → fire(event) (스텝 +1 · recordStep = 기존 transcript/stuck 관측 유지)
  · recover          → 서명별 회복 예산(기본 3회 · nextActionSignature 키) 차감 후 fire(event);
                        예산 소진 → reason="stalled" 반환(무한 reconcile↔retry 핑퐁 차단)
  · wait             → sleep(waitPollMs · 기본 5초, 주입 가능) 후 na 재관측(stuck.observe)만 하고 continue;
                        같은 na 서명이 stuckThresholdMs(기본 15분 · 키비주얼 대비 옵션 상향) 지속 → reason="stalled" 반환
```

- **행 금지 보장**: 모든 대기는 유한이다 — quiesce 는 Bridge 상한(`CHAT_BRIDGE_TIMEOUT`)이, wait 는 stuck 임계가,
  recover 는 서명별 예산이, 전체는 `runBudgetMs` 가 막는다. 스텝 예산은 **fire 에만** 계상(wait 는 시간 예산 소관).
- `DriveStopReason` 확장: 기존 `predicate|terminal|no-forward|budget` 에 `stalled|escalation|human-input` 추가
  (`no-forward` 는 decideLive 도입 후 도달 불가 — 제거 또는 방어 잔존은 구현 시 결정). `main.ts` 는 reason 을
  기존처럼 로그·리포트에 흘린다(추가 배선 불요).

### 2-4. 바뀌는 파일 · 테스트 · 불변식

| 파일 | 변경 |
|---|---|
| `chat/src/live/policy.ts` | `decideLive()`·`LiveDecision` 추가(기존 `decideForward` 무수정 — CI 미러 유지) |
| `chat/src/live/live-assembly.ts` | `runToDone` 을 위 루프로 재작성 + `runBudgetMs`/`waitPollMs`/회복 예산 옵션(주입 시계·sleep — 기존 스타일) |
| `chat/src/live/main.ts` | (선택) 종료 reason 별 안내 한 줄 — 배선 glue 라 단위 테스트 밖(기존 지위 유지) |
| `chat/test/live/policy.test.ts` | decideLive 변이 전수(fire/wait/recover/stop) + exhaustiveness |
| `chat/test/live/live-assembly.test.ts`(신규 케이스) | fake 게이트웨이·주입 시계로: Verdict→(캐스케이드)→OptionSet 통과 · Failure→reconcile→GenerateRetry→retry 회복 · 회복 예산 소진 stalled · Escalation stop · wait 임계 stalled — 전부 오프라인 결정론 |

**보존 불변식**: ① 오프라인 CI 전부 green 유지(현 기준 단위 908 · stub E2E 5 · 인수 7 · core diff 0 — 신규 테스트는
추가만) ② `src/live/` 밖 무수정(kernel·acceptance·adapters·worker 불변 — 수정 1 범위에서) ③ core/packs 무수정
④ 동결 SurfaceDriver·affordancesOf 재사용(지어낸 버튼 0 — 모든 발화는 직전 렌더의 affordance).

---

## 3. 수정 2 — 브리프 너머 생성 소비: 무엇이 데몬-가능하고 무엇이 운영자 세션인가 (정직한 경계)

### 3-1. 선택지 비교

| | (a) 데몬 stage 확장(concept 등 편입) | (b) 운영자-동등 세션 1개가 브리프 너머 전부 소비 |
|---|---|---|
| 코드 변경 | `SUPPORTED_STAGES`·`AUX_ALLOW_RULES` 확장 + 단계별 dry-run 실측(부록A-11) + **storyboard-outline/plan 은 SKILL.md 에 ```bash 펜스가 없어 rewriteSkill 이 전이 0개로 throw** → core SKILL.md 수정(펜스 정규화) 또는 chat 파서 확장 필요 | **0** (검증된 C2 브리지 경로 그대로) |
| keyvisual | 불가(구조적 차단 — skill-rewrite 명시 throw) → 어차피 운영자 세션 필요 | 가능(세션 안에서 NanoBanana + Playwright 렌더 · core 1급 경로) |
| 잠긴 결정 4 | **개정 필요**(옛 대안 (b)=데몬 확장은 명시 기각됐다 — 라이브 계획 1번 절) — 사람 승인 사안 | **그대로**(확정안 = 운영자-동등 세션이 C2 로 소비) |
| CI 왜곡 위험 | 있음(atdd 계획 리스크 8: enablement 확장으로 "CI 에서만 되는 무인" 금지) | 없음 |
| 재런 토폴로지 | 데몬 + 운영자 세션(키비주얼) 둘 다 필요 — 프로세스 수 동일 | 데몬 + 운영자 세션 — 동일 |

### 3-2. 권고 아키텍처 = (b) 운영자-동등 세션 단일화 (잠긴 결정 4 유지)

**권고**: 데몬은 `intake·brief` 그대로 두고, **브리프 너머 4단계(concept · storyboard-outline · storyboard-plan ·
keyvisual)를 운영자-동등 Claude Code 세션 1개가 전부 소비**한다. 근거:

1. **keyvisual 은 어차피 운영자 세션이 필요**하다(구조적 차단). concept 만 데몬에 편입해도 프로세스 수·사람 개입
   지점이 줄지 않는다 — 확장의 실익이 없다.
2. **storyboard-outline/plan 은 데몬 편입에 core 수정(SKILL.md 펜스 정규화)이나 chat 파서 완화가 선행**되는데, 전자는
   core 변경(+D-1 feature-catalog 동반갱신 + `.claude/commands` sync 재생성)이고 후자는 skill-rewrite 가 문서로 못박은
   "펜스만 파싱(경계가 파싱 결과 따라 넓어지지 않게)" 설계를 흔든다. 재런 1회를 위한 대가로 과하다.
3. **잠긴 결정 4 를 개정하지 않는다** — CI 시나리오 ②(Bridge+데몬 핸드오프)가 실증한 계약(데몬=intake·brief · 너머=
   운영자-동등 소비)을 라이브가 그대로 미러한다. 개정 없음 = 사람 승인 부담도 없음.

**후일 편입 경로(비-이번-범위 · 기록만)**: 무인 범위를 넓히고 싶어지면 ① core SKILL.md 펜스 정규화(작은 core 변경 ·
feature-catalog 동반갱신) ② 부록A-11 대로 단계별 dry-run 1회 실측 ③ `SUPPORTED_STAGES`/`AUX_ALLOW_RULES` 확장 ④ 잠긴
결정 4 개정을 **사람 승인**으로 명문화 — 이 4개가 전부 갖춰져야 한다.

### 3-3. 운영자-동등 세션의 소비 프로토콜 (재런에서 실제로 하는 일)

운영자 세션 = core 체크아웃에서 연 **인터랙티브 Claude Code 세션 1개**(구독 인증). 세션에게 다음 상시 지시를 준다:

```
runs/<rid> 의 생성 잡이 $CHAT_JOBS_DIR/pending/ 에 나타나면(파일명 <rid>-<stage>.json),
그 단계를 core 1급 경로로 세션 안에서 생성하라:
  ① bash scripts/run-stage.sh <stage> <rid> --emit-context 로 입력·프롬프트를 읽고
  ② 산출물 파일을 작성한 뒤
  ③ HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> <rid> 로 검증·전이하라.
전이가 확인되면 pending 파일은 Bridge 가 정리한다(직접 지우지 말 것). done 까지 반복.
keyvisual 은 이미지 실생성(NanoBanana)·Playwright 렌더가 전이 단계에 포함된다 — 시간이 걸린다(정상).
```

- 이 세션은 **잡 파일을 클레임하지 않는다**(데몬 프로토콜 밖) — 전이 자체가 완료 신호이고, Bridge 가 next-action
  폴링으로 감지해 pending 을 청소한다(`gen-executor.ts` cleanupPendingJob). 데몬과의 이중 소비는 enablement 필터가
  구조적으로 차단한다(데몬은 미등재 단계를 집지 않는다 — cli-consumer.ts consumeOne).
- 봇(드라이버)·데몬·운영자 세션이 **같은 `CHAT_JOBS_DIR`** 을 봐야 한다(런북 2번 절 표 그대로).

### 3-4. Bridge 대기 상한 재조정 (keyvisual 느림 대비)

- `CHAT_BRIDGE_TIMEOUT=3600`(초) 으로 상향한다 — keyvisual 은 stub 조차 Playwright 렌더로 ~360초였고, 실런은
  이미지 bake(10~14장 + 429 백오프) + 세션 생성으로 **900초를 초과할 수 있다**. 상향은 env 만으로 되며 코드 무변경.
- 데몬 기동 정합(`validateWorkerTimeouts`: `CHAT_SDK_GEN_TIMEOUT(기본 480초) + 60초 ≤ CHAT_BRIDGE_TIMEOUT`)은
  3600초에서 자동 충족. 만에 하나 상한 내 미완이어도 수정 1 의 recover(reconcile→retry, 새 마감)가 출구다.

---

## 4. 수정 3 — HARNESS_DOMAIN 주입 + ADK flaky 완화 (core 무수정 · env 우선)

1. **`export HARNESS_DOMAIN=cosmetic` 을 세 프로세스 모두에** 준다 — 드라이버(`pnpm live`)·데몬(`pnpm worker`)·운영자
   세션 셸. 근거: chat 의 모든 core 스폰이 `{...process.env, ...}` 로 env 를 전파하므로(harness-cli.ts 50행 ·
   supervisor spawn 도 동일) export 만으로 `ingest.py` 의 SystemExit fail-closed 가 해소된다. **core 는 건드리지
   않는다**(SystemExit 를 잡도록 core 를 고치는 것은 이번 범위 밖 — 도메인 미선언 fail-closed 는 core 의 의도된 규칙).
2. **(선택 · chat-side 1줄)** `live/main.ts` 기동 점검에 `HARNESS_DOMAIN` 부재 경고를 추가한다(기존
   `ADK_COSMETICS_CRITIC_URL` 경고와 같은 결 — 62~67행). 재발 시 기동 로그에서 바로 보이게.
3. **ADK 재시도 상향 유지**: `ADK_CRITIC_RETRY`(빈응답 재시도)를 1차 런에서 올린 값으로 재런에도 export 하고,
   `ADK_CRITIC_RETRY_BACKOFF`(기본 `2,5,10`)는 콜드스타트 대비 기본 유지. 알려진 빈응답 원인(메모리:
   `○○○○`(U+25CB) 포이즌 · ~10블록↑ 대용량)은 관측만 하고 이번에 건드리지 않는다. `KCIA_CRITIC_REQUIRED` 는
   구현 도메인 자동 1(조용한 강등 금지) 그대로 — 임의로 0 을 주지 않는다.
4. **런북 env 표 갱신**: 2번 절 표에 `HARNESS_DOMAIN`(심의 스폰 필수 · 부재 시 guideline 심의 fail-closed) ·
   `CHAT_BRIDGE_TIMEOUT`(keyvisual 대비 3600 권장) · `ADK_CRITIC_RETRY` 행을 추가한다(문서 변경 — chat 계층 문서라
   D-1 의무 밖).

> **개정 각주(2026-07-19)**: 이 수정 3의 "새 재시도 메커니즘 없음" 결정은 [`chat-review-retry-plan.md`](chat-review-retry-plan.md) 의 **잡-레벨 리뷰 재시도 신설**로 개정·승인됨(W0). `ADK_CRITIC_RETRY` 는 상향이 아니라 **코드 기본(8) 이상 유지**로 교정한다.

---

## 5. 라이브 재런 레시피 (사람 go 후 · 실 과금)

### 5-0. 선행 정리 — 1차 런 잔재와의 충돌 회피 (중요)

- **1 스레드 = 1 run**: 1차 런이 `slack:C0BJAELG2KU`(채널 루트)를 run 에 바인딩했다. 같은 id 로 재멘션하면
  "이미 진행 중인 작업이 있어요" 로 거부되고(flow.onMention), 같은 rid(`chat-slack-C0BJAELG2KU`)는 core `runs/` 와도
  충돌한다. **권장 해법**: 채널에 새 메시지를 하나 올리고 그 `thread_ts` 로
  `CHAT_LIVE_THREAD=slack:C0BJAELG2KU:<thread_ts>` **복합 id** 를 쓴다 → rid 가
  `chat-slack-C0BJAELG2KU-<ts>` 로 유일해지고, 카드는 여전히 같은 채널(스레드) 안에 tee 된다.
  (대안: 새 `CHAT_STATE_DIR` + core `runs/chat-slack-C0BJAELG2KU` 이동/보관 — 손이 더 가므로 차선.)
- **`CHAT_JOBS_DIR` 를 재런 전용 새 디렉터리로** 판다 — 판정 리포트가 `jobs/failed/*.reason` 을 위반으로 세므로
  1차 런의 실패 잔재가 재런 판정을 오염시키지 않게 한다.
- 봇이 채널 멤버인지(1차 런에서 이미 초대됨), `slack:` 복합 id 형식인지 재확인(런북 2번 절 실측 전제).

### 5-1. 프로세스 토폴로지 (4자리)

| 자리 | 무엇 | 명령 | 역할 |
|---|---|---|---|
| 터미널 A | **무인 데몬** | `cd chat && pnpm worker` | intake·brief 생성 무인 소비(`CHAT_SDK_STAGES=intake,brief` — 잠긴 결정 4 그대로) |
| 터미널 B | **라이브 드라이버**(봇+tee) | `cd chat && CHAT_LIVE_GO=1 pnpm live` | Slack 연결 · 멘션 → done auto-happy 구동(수정 1 적용) · 전 카드 tee + JSONL |
| 터미널 C | **운영자-동등 세션** | core 체크아웃에서 Claude Code 인터랙티브 세션 | concept·storyboard-outline·storyboard-plan·keyvisual 생성 잡 소비(3-3 절 프로토콜) |
| 참관 | **사용자** | Slack 채널 `C0BJAELG2KU` | 3안 카드 3종·판정 카드·진행 카드를 눈으로 확인 |

### 5-2. env (세 터미널 공통 export — 자격증명은 전부 기존 보유분)

```bash
export HARNESS_ROOT=/Users/chabh/workspace/ch-regulated-harness/core
unset HARNESS_OFFLINE                          # 온라인(라이브)
export HARNESS_DOMAIN=cosmetic                 # ★ 수정 3 — 심의 스폰 fail-closed 방지
export CLAUDE_CODE_OAUTH_TOKEN=...             # 구독 세션(데몬·운영자)
export NANOBANANA_API_KEY=...                  # keyvisual 실이미지
export ADK_COSMETICS_CRITIC_URL=...            # 원격 ADK 심의
export ADK_COSMETICS_CRITIC_ALLOWED_HOST=...
export ADK_CRITIC_RETRY=...                    # ★ 수정 3 — 1차 런 상향값 유지(빈응답 flaky)
export SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
export CHAT_JOBS_DIR=/절대경로/live-rerun/jobs   # ★ 재런 전용 새 디렉터리(5-0)
export CHAT_SDK_STAGES=intake,brief            # 데몬 enablement(잠긴 결정 4 유지)
export CHAT_BRIDGE_TIMEOUT=3600                # ★ 수정 2 — keyvisual 느림 대비
export CHAT_BUNDLE_DIR=... CHAT_STAGED_WB=...  # 1차 런과 동일 인입 재료
export CHAT_APPROVERS=U-driver
export CHAT_LIVE_ACTOR=chat:live:U-driver
export CHAT_LIVE_THREAD=slack:C0BJAELG2KU:<새 thread_ts>   # ★ 5-0 복합 id
export CHAT_LIVE_MENTION='화장품이고 여러장이야, 제품명은 "..."'
export CHAT_LIVE_ARTIFACT_DIR=/절대경로/live-rerun/artifacts
```

### 5-3. 실행 순서

1. 터미널 A: `pnpm worker` — 로그 `무인 단계: intake, brief` 확인.
2. 터미널 C: 운영자 세션 기동 + 3-3 절 상시 지시 투입(아직 잡이 없으니 대기).
3. 터미널 B: `pnpm live`(GO 없이) — **미리보기**로 rid·경로·비용 계획 확인(연결·과금 0).
4. 터미널 B: `CHAT_LIVE_GO=1 pnpm live` — 실 구동. 이후 사람 손은 원칙적으로 **터미널 C 의 세션 감독뿐**이다
   (선택·승인 버튼은 전부 드라이버가 발화 — 잠긴 결정 1).

### 5-4. 관측 포인트 (사용자가 채널에서 보게 되는 것)

- intake→brief: 진행 카드·승인 카드·**판정 카드(revise 가 떠도 정상 — 적대 심의가 일한 것)** 가 흐르고, 이번엔
  판정 카드에서 **멈추지 않고** 이어진다(수정 1).
- **① concept OptionSet — 메시지 방향 3안(A/B/C · 추천 표시)** → 드라이버가 추천안 [이걸로] 발화 → 심의 → 다음.
- **② storyboard-outline OptionSet — 스토리라인 3안** → 동일.
- storyboard-plan 승인 → keyvisual 생성(여기가 최장 구간 — 터미널 C 에서 이미지 bake 진행 · 채널엔 증분 진행 카드).
- **③ keyvisual ImageOptionSet — 이미지 디자인 3안(실 NanoBanana 이미지 첨부)** → 선택 → 확정 승인 → 최종 심의 → **Done 카드**.
- 종료 후 `CHAT_LIVE_ARTIFACT_DIR` 에 `<rid>-transcript.jsonl`·`<rid>-report.md`·`<rid>-report.json`.

### 5-5. teardown

- 터미널 B: 참관 끝나면 Ctrl+C(연결 상주 설계 — 리포트는 이미 기록됨).
- 터미널 A: Ctrl+C(SIGINT) — 우아한 종료(진행 잡 drain + supervisor SIGTERM + 소유권 리퍼 백스톱 내장).
- 터미널 C: 세션 종료. `runs/<rid>` 는 감사용으로 보존, `CHAT_JOBS_DIR` 는 리포트 확인 후 정리(선택).

### 5-6. 비용·벽시계 추정 (참관 계획용)

- 구독 환산 ~$15–25(1차 런 대비 브리프 너머 4단계 + revise 여지 포함) + Gemini 이미지 10~14장(+429 재시도 —
  강등 다이얼 기본 flash) + ADK 심의(GCP) 4게이트+revise 반복분. **새 종량 API 없음.**
- 벽시계 **1.5–3시간**(keyvisual 이미지 구간이 최장 · revise 1–2회 가정). 사용자는 전 구간 참관 가능하며,
  Bridge 진행 side-channel 이 긴 구간에도 증분 카드를 tee 한다.

---

## 6. 웨이브 분해 (의존 순서)

| 웨이브 | 내용 | 산출물 | 게이트 |
|---|---|---|---|
| **W0** | 본 계획 사람 검토 — 특히 ①잠긴 결정 4 **유지**(데몬 확장 안 함) ②Escalation 은 자동 발화 없이 stop ③재런 예산 승인 | 이 문서 | **사람 go(계획 승인)** |
| **W1**(병렬 가능) | 수정 1: `policy.decideLive` + `runToDone` 재작성 + 단위 테스트 ∥ 수정 3 chat-측: `live/main.ts` HARNESS_DOMAIN 경고 1줄 | 코드 + 테스트 | 로컬 단위 green |
| **W2** | 문서 배선: 런북 env 표(HARNESS_DOMAIN·CHAT_BRIDGE_TIMEOUT·ADK_CRITIC_RETRY) + 재런 절(5장 요지) 추가 | 런북 갱신 | — |
| **W3** | 오프라인 검증: `pnpm verify` 전체(빌드→단위 908+신규→픽스처 멱등→stub E2E 5→인수 7→**core diff 0**) | verify green | CI 불변 확인 |
| **W4** | **라이브 재런**(5장 레시피 그대로 · 실 과금) | 트랜스크립트·판정 리포트·Slack 실카드 | **사람 go(과금 승인) 후 실행** |
| **W5** | 사후: 리포트 판독·라이브 계획 문서 상태 갱신·(선택) 후일 데몬 확장 검토 메모 | 문서 갱신 | — |

---

## 7. 리스크 · 함정

1. **드라이버 행(hang)**: 모든 대기가 유한임을 테스트로 못 박는다(2-3 절 — quiesce 는 Bridge 상한, wait 는 stuck
   임계, recover 는 서명별 예산, 전체는 runBudgetMs). 주입 시계·sleep 으로 오프라인 결정론 검증(기존 패턴).
2. **Bridge 타임아웃 vs 운영자 세션 지연**: keyvisual 이 3600초도 넘기면 Failure→recover 가 새 마감으로 다시 연다 —
   단 판정 리포트의 **"Failure 화면 0" 기준에 걸린다**(회복돼도 구조 판정은 REVIEW 로 강등). 그래서 1차 방어는
   **상한을 넉넉히**(3600초), recover 는 안전망으로만 쓴다. 재런 목표 = Failure 0 으로 done.
3. **keyvisual 느림(~360초+)**: 최장 구간임을 참관자에게 예고(5-4) + 진행 side-channel 카드로 체감 정체 완화.
   429 폭주 시 core 의 백오프·flash 강등(P-1)이 이미 흡수한다 — 추가 다이얼을 이번에 만지지 않는다.
4. **ADK flaky(빈응답)**: `ADK_CRITIC_RETRY` 상향 유지 + 백오프 기본. `KCIA_CRITIC_REQUIRED` 를 끄는 우회는
   금지(조용한 강등 — 메모리 kcia-required-leak 교훈). 반복 실패 시 런 중단이 옳다(fail-closed 가 사양).
5. **stale-select 도장**: OptionSet 버튼의 phase·iteration 도장이 재생성과 어긋나면 onChoice 가 거부하고 안내
   카드를 낸다 — 드라이버는 항상 **최신 렌더**에서 도출하므로 다음 루프에서 새 카드로 자가 회복된다(설계 확인 완료).
   Verdict 에서 발화하지 않는 결정(2-2)이 이 경합면 자체를 줄인다.
6. **오프라인 CI 회귀**: 변경을 `src/live/`(+런북 문서)로 한정하고 `decideForward`·동결 driver.ts·kernel·worker 를
   건드리지 않는다. W3 의 verify 전체(특히 core diff 0)가 게이트.
7. **1차 런 잔재 충돌**: 5-0 절(복합 thread id · 새 CHAT_JOBS_DIR) 미준수 시 재멘션 거부/rid 충돌/리포트 오염 —
   레시피에 선행 단계로 못 박았다.
8. **운영자 세션의 과잉 행동**: 세션 지시에 "pending 파일 직접 삭제 금지 · state.json 손대지 않기 · 1급 경로만"을
   명시(3-3) — 전이·청소의 소유권은 core 스크립트와 Bridge 에 있다.

---

## 8. DoD (완료 정의)

1. **오프라인**: `pnpm verify` 전체 green — 빌드 → 단위(기존 908 + 신규 전부) → 픽스처 멱등 → stub E2E 5 → 인수 7 →
   **core diff 0**. `decideForward`·동결 하네스 무수정.
2. **라이브 재런 1회**(사람 go 후): 실 Slack 채널 `C0BJAELG2KU` 에 **세 카드 세트가 전부 게시** —
   ① concept 메시지 방향 3안(OptionSet) ② storyboard-outline 스토리라인 3안(OptionSet)
   ③ keyvisual 이미지 디자인 3안(ImageOptionSet · 실이미지 첨부) — 이고, 드라이버가 Verdict/Progress 에서 멈추지 않고
   **`reached=true`(done)** 로 종료, 판정 리포트 구조 기준 통과(심의 revise 는 실패 아님 — 잠긴 결정 2).
3. 트랜스크립트 JSONL·리포트가 `CHAT_LIVE_ARTIFACT_DIR` 에 남고, 사용자가 참관으로 세 카드 세트를 직접 확인.

> **재확인: 본 문서는 계획이며, 사람 go(W0 계획 승인 · W4 과금 승인) 전에는 어떤 코드 수정·프로세스 기동·과금도
> 하지 않는다.**

---

## 9. 고지

본 산출물·재런은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). 심의의 revise/escalation 은
결함이 아니라 설계된 적대 게이트의 작동이고(잠긴 결정 2), 최종 책임은 사람(현업/RA)에게 있다.
