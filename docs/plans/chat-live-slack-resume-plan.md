# 챗 라이브(Slack) 재개·가시성 수정 계획 — 드라이버 생애 분리 + 중간-재개(attach) + 아티팩트 정직화

> **지위**: `docs/plans/`(진행 중 계획 · **chat 계층 문서 — core 정본 D-1 갱신 의무 밖**). **작성**: 2026-07-21. **브랜치**: `feat/chat-live-driver-fix`.
> **관계**: [`chat-review-retry-plan.md`](../_archive/chat-review-retry-plan.md)(**완료·아카이브** — 잡-레벨 재시도, 이번 라이브에서 발화·검증됨) ·
> [`chat-live-driver-fix-plan.md`](chat-live-driver-fix-plan.md)(드라이버 정책 — 본 계획은 그 위에 attach 를 얹는다) ·
> [`../reference/daemon-live-verification-runbook.md`](../reference/daemon-live-verification-runbook.md)(런북 — 운영 규칙·기동 표준 갱신 대상).
> **근거**: 2026-07-20 이지덤 뷰티 여드름 라이브 런(rid `chat-slack-C0BJ7FJ4A8M-1784518245-189909`) 회고 — 본인 분석 + Codex 병렬 리뷰 취합.
>
> ⚠ **이 문서는 계획일 뿐이다 — 사람의 go 전에는 아무것도 실행하지 않는다.** 코드 수정·env 변경·데몬 기동·라이브 런·과금 전부 아래 웨이브의 사람 승인 게이트 뒤에 있다.

---

## 0. 한 줄 정의 · 범위

라이브 런이 Slack(챗 표면)으로 done 까지 이어지지 못하고 **① 드라이버 프로세스 사망 → ② 재기동 재개 불가 → ③ (운영자가 core 로 우회) → ④ Slack 침묵 + stale 아티팩트**로 무너졌다. 이 계획은 **Slack 경로에서 실제로 깨진 것만** 고친다 — 드라이버 생애 분리, 중간-재개(attach), 현재 게이트 카드 재게시, 아티팩트 세션화, 데몬 회복예산, 감사 identity 정직화.

**범위 밖(core — 별도 계획, 6번 절)**: 이미지 픽셀 심의 커버리지(OCR), ingest 다중-서브라인 오추출, 후기 원문 결박, provenance dirty-worktree. 이건 Slack 여부와 무관한 core 결함이라 여기 안 담는다(단, 풀 라이브 재런의 전제 — 순서만 명시).

**유지(잘 된 것 — 건드리지 않음)**: 잡-레벨 재시도 경로(라이브 발화·검증됨) · escalation [한 번 더] 복구 경로 · tee 자체(드라이버 생존 중엔 정상) · GenerateRetry 자동 유료 재생성 금지(드라이버 계획의 P1 수정) · core fail-closed 전부.

---

## 1. 무슨 일이 있었나 (Slack 관점 타임라인 — 실측)

| 시각(KST) | 사건 | Slack 에 보인 것 |
|---|---|---|
| 12:30~13:00 | 드라이버1 정상 구동: 멘션→인입→가이드라인→브리프 + **재시도 경로 발화**(`[review-retry] retry 1/3` → 성공) | 카드 정상 tee ✓ |
| ~13:00 | 데몬 brief 3차 재생성 실패(`recovery_budget_insufficient` 잔여 29.5s<90s) → Failure→reconcile→GenerateRetry → 드라이버1 **정상 정지(reason=human-input)** 후 상주 | 마지막 카드 = 재생성 대기 |
| 13:0x | **운영자 세션 종료가 드라이버1 을 SIGTERM(exit 143)** — 프로세스가 세션의 자식이었음 | **봇 오프라인 — 이후 클릭 불가** |
| 13:5x | 드라이버2 재기동 → `onMention` 기존 run 거부("이미 진행 중") → Progress=wait → 903초 stuck → **stalled(steps=0)** 반환, 같은 RID 아티팩트 **덮어씀**(stale 리포트 01-brief·pass=false) | "이미 진행 중" 카드 1장뿐 |
| 14:18~16:43 | 운영자가 **core 4동작으로 우회 구동**(brief 적응→concept→storyboard→keyvisual→done). 전이는 `.events/agui.jsonl` 에 기록됐으나 Slack 미투영 | **침묵**(사용자 관찰 그대로) — 이미지 3안 선택 카드 포함 전무 |

핵심: **②(재개 불가)가 ③(core 우회)을 유인했고, ③이 ④(침묵)를 만들었다.** 운영자의 core 우회는 잘못이지만(운영 규칙으로 봉인, 5번 절 R-1), 우회 없이는 그 run 이 Slack 에서 **영구 침묵**이었을 것 — 근본은 ①·②다.

---

## 2. 식별된 문제 (Slack 경로만 · 회고+Codex 취합)

| id | 문제 | 심각도 | 분류 | 근거 |
|---|---|---|---|---|
| **S-1** | **드라이버 생애가 운영자 세션에 묶임** — Bash 자식으로 기동 → 세션 종료 SIGTERM 에 봇째 사망. (orphan 기동한 2차는 3h+ 생존 = 기동 방식 문제) | P0 | 운영+설계 | live-driver.log 말미 `exit 143` |
| **S-2** | **중간-재개 불가** — `main.ts` 는 무조건 `mention()→runToDone()`(main.ts 100~102), `onMention` 은 기존 run 재멘션을 거부 Progress 만 렌더(flow.ts 614), `decideLive` 는 Progress=wait(policy.ts 122) → 재기동 드라이버 **steps=0·903s stuck·stalled**. 죽은 드라이버의 run 은 챗 표면에서 복구 불가 | P0 | 설계 한계 | live-driver2.log · flow.ts:614 · policy.ts:122 |
| **S-3** | **현재 게이트 카드 재게시 부재** — 재기동 후 사람이 Slack 에서 무엇을 눌러야 할지 알 수 없음(마지막 실카드 = 옛 상태). 아웃오브밴드 전진(core)은 `.events/agui.jsonl` 에 남지만 Slack 으로 투영 안 됨(agui-events-client 는 best-effort 진행 side-channel일 뿐) | P0 | 설계 한계 | agui.jsonl 108~118행에 select/approve/verdict/done 실재 · Slack 무 |
| **S-4** | **아티팩트 덮어쓰기·stale 판정** — 재기동이 같은 RID 경로의 transcript/report 를 덮어씀(main.ts 75·105~110) → 트랜스크립트 1줄·리포트 "01-brief·pass=false"가 실제 done 을 가림. done 관측 시 terminal 재조립 없음 | P1 | 설계 한계 | artifacts/*-report.json(stale) vs state=done |
| **S-5** | **데몬 회복예산 부족으로 revise 재생성 실패** — 3차 brief 재생성이 주 세션이 예산을 소진해 복구 세션 최소 90s 를 못 남김(`recovery_budget_insufficient` 29.5s<90s) → Failure→GenerateRetry(human-input) 정지. revise 재생성은 피드백 컨텍스트로 더 오래 걸리는데 예산은 동일 | P1 | 코드/설정 | jobs/failed/*.reason · cli-session-runner.ts:87 |
| **S-6** | **감사 actor 위장** — `CHAT_LIVE_ACTOR=chat:live:<사람 승인자 id>`(env-common.sh 26행)라 드라이버 자동 결정이 **사람 승인처럼** 기록. 자동주행 자체는 승인된 설계지만 기록이 부정직 | P1 | 설정/거버넌스 | state history 의 human:approved(실은 드라이버) |
| **S-7** | **실 사람 클릭/답글의 게이트웨이 라우팅 미확증** — 라이브 백엔드가 드라이버 fire 는 `onAction` 으로 라우팅(live-assembly.ts 327~330)하지만, **실 Slack 버튼 클릭·답글**이 살아있는 라이브 프로세스에서 onAction/onReply 로 들어오는지 실측된 적 없음. "사람이 Slack 에서 이어가기"의 전제 | P2(검증) | 검증 필요 | 런북 1절("실버튼 클릭은 API 로 불가" = 드라이버 쪽 서술일 뿐) |
| **S-8** | **관측 노이즈·소결함** — 데몬이 미등재 guideline 잡 스킵을 매 폴 로그(도배), socket pong 경고, 내 kcia 중도킬로 timing 미종결 start 2건 | P2 | 관측 | live-daemon.log 6~138행 · timing.jsonl |

---

## 3. 수정 설계

### 수정 1 — 드라이버·데몬 분리 기동 표준 (S-1 · 코드 0~소)
- 런북에 **분리 기동 패턴을 1급으로 명문화**: `( nohup bash -c '…' </dev/null >log 2>&1 & )` 서브셸 orphan(macOS — setsid 없음) + pid 파일. 실측: 이 패턴으로 띄운 2차 드라이버·데몬은 세션 전환을 3h+ 생존.
- (선택) `chat/scripts/live-up.sh` 래퍼(데몬+드라이버 기동·pid/log 기록·`live-down.sh` 종료) — W0 에서 채택 결정. 기본 제안 = 런북만(최소 변경).

### 수정 2 — `LiveDriver.attach(threadId)` 중간-재개 (S-2 · 핵심)
- 새 진입: 매핑(`threadForRun`)이 이미 있으면 **멘션을 다시 쏘지 않고** ① 스레드 구독 ② `readNext(rid)` 로 권위 상태 재독 ③ `presentationForNext` 로 **현재 게이트 카드 재게시** ④ stuck 탐지기 초기화 ⑤ `runToDone()` 재진입(자동 주행 계속).
- `main.ts`: 기동 시 기존 run 감지(threadForRun) → `mention` 대신 `attach` (명시 오버라이드 `CHAT_LIVE_ATTACH=0` 로 옛 동작). `onMention` 커널 계약은 **불변**(재멘션 거부는 봇 프로덕션 계약 — 손대지 않고 드라이버 쪽에 attach 를 얹는다).
- **잠긴 결정 1 합치**: 재게시 카드는 core `readNext` 재파생(지어낸 버튼 0) — 기존 reconcile(읽기 전용 화해)과 같은 결이다. GenerateRetry 자동 유료 재생성 금지(stop:human-input)도 **불변**.

### 수정 3 — 현재 게이트 카드 재게시 (S-3 · 수정 2 에 포함 + 선택 확장)
- **최소(기본 제안)**: attach 시 1회 재게시(수정 2 ③). 운영 규칙 R-1(5번 절)이 core 우회를 봉인하므로 아웃오브밴드 투영의 필요성 자체가 줄어든다.
- **확장(선택 · W0 결정)**: 상주 projector — `.events/agui.jsonl` tail 을 **wake 신호로만** 쓰고(내용 신뢰 금지 — STALL-LOG 의 위조가능-이벤트 교훈), 깨어나면 `readNext` 재독→현재 카드 idempotent 재게시. 대가: 면적(파일 watch·중복게시 억제)·이벤트 로그 신뢰경계 설계. 기본 = 미채택.

### 수정 4 — 아티팩트 세션화 + terminal 재조립 (S-4)
- transcript/report 경로에 **드라이버 세션 suffix**(`<rid>-transcript.<session-epoch>.jsonl` 등) — 덮어쓰기 제거, 세션별 보존.
- 종료 시(정상·stalled 불문) 그 시점 상태로 리포트 재조립(기존과 동일)하되, **attach 재개가 done 을 관측하면 terminal 리포트를 새로 조립**해 `<rid>-report.final.*` 로 남긴다(stale 판정이 done 을 가리는 일 제거).

### 수정 5 — 데몬 회복예산 보장 (S-5)
- `cli-session-runner` 의 잡 예산 배분을 조정: **주 세션 상한 = 잡 예산 − 복구 최소예산(90s) − 스폰 여유** 로 선확보(지금은 주 세션이 다 먹고 복구가 굶음). 또는 revise 재생성(iteration>1) 잡에 예산 가산(`CHAT_SDK_GEN_TIMEOUT` 대비 배수 다이얼). W0 에서 방식 택1 — 기본 제안 = **선확보**(다이얼 추가 없음·결정론).
- 정합 체크 유지: `CHAT_SDK_GEN_TIMEOUT + 기동여유 ≤ CHAT_BRIDGE_TIMEOUT`(런북 기존 규칙).

### 수정 6 — 감사 identity 정직화 (S-6)
- 라이브 auto-happy 의 actor 를 **서비스 identity** 로: `CHAT_LIVE_ACTOR=chat:live:svc-<봇id>` + `CHAT_APPROVERS` 에 서비스 id 추가(승인 게이트 통과는 유지하되 **기록이 '드라이버가 했다'로 정직**해짐). 실제 사람 클릭은 그 사람 Slack user id 그대로(S-7 배선 후).
- run.md/리포트에 **synthetic 주행 표기**(리포트 "감사 actor" 기준은 사람/서비스 구분 표시로 보강). 프로덕션 export 게이트와의 관계는 core 범위라 여기선 표기까지만.

### 수정 7 — 실 사람 인터랙션 라우팅 검증·배선 (S-7)
- 스파이크: 살아있는 라이브 프로세스에서 **실 버튼 클릭·스레드 답글**이 onAction/onReply 로 라우팅되는지 실측(과금 0 — 클릭/답글만). 미배선이면 소켓 이벤트→게이트웨이 핸들러 배선 추가(프로덕션 봇 경로와 동일 계약).
- 이것이 되어야 "드라이버는 자동 주행, 사람은 언제든 Slack 에서 개입"이 완성된다(사용자 요구 방향).

### 수정 8 — 관측 정리 (S-8 · 소)
- 데몬 미등재-스테이지 스킵 로그 dedup(같은 잡당 1회). 런북에 socket pong 경고=네트워크 재시도 정상 메모.

---

## 4. 검증 계획

1. **오프라인(W4)**: 기존 그린 전부 불변(단위 956+·stub E2E 5·인수 7·core diff 0) + 신규 표적:
   - attach 단위: 기존 run + 죽은-드라이버 상태 재현 → attach → 현재 게이트 카드 재게시 + runToDone 이 approve/select 를 이어서 자동 발화(가짜 게이트웨이·주입 시계).
   - 아티팩트 세션화: 두 세션이 각자 파일 · terminal 리포트가 done 반영.
   - 회복예산: 주 세션이 예산을 소진해도 복구 90s 선확보로 `recovery_budget_insufficient` 미발생(가짜 시계).
   - 인수: "드라이버 kill→재기동(attach)→계속→done" 시나리오 1건(stub·오프라인).
2. **라이브 리허설(W5 · 과금 소·사람 go)**: 새 스레드 소규모 런에서 **kill-and-reattach** — 드라이버를 고의 kill → 재기동 attach → Slack 에 현재 게이트 카드 재게시 확인 → 자동 계속 → 사람 클릭 개입 1회(S-7 실측) → 정상 진행.
3. **풀 라이브 재런은 이 계획 밖의 core 수정(6번 절) 뒤에** — 픽셀 심의 구멍이 열린 채의 done 은 신뢰 불가이므로 순서를 지킨다.

---

## 5. 운영 규칙 (코드 아님 — 즉시 유효)

- **R-1**: 라이브 런 진행 중 운영자(에이전트)는 **core 4동작 스크립트를 직접 호출하지 않는다** — 결정·진행은 챗 표면(드라이버/Slack 버튼)으로만. 예외는 사람의 명시 지시뿐이며, 우회했다면 그 사실을 즉시 보고한다. (이번 런의 침묵 절반은 이 우회가 만들었다 — 재발 방지.)
- **R-2**: 드라이버·데몬은 **항상 분리 기동**(수정 1 패턴) — 운영자 세션의 자식으로 띄우지 않는다.
- **R-3**: 재기동은 반드시 attach 경로(수정 2 배선 후) — 재멘션으로 새 run 을 만들거나 기존 run 을 두드리지 않는다.

---

## 6. 범위 밖 — core 결함 (별도 계획 필요 · 풀 라이브 재런의 전제)

| 결함 | 심각도 | 한 줄 |
|---|---|---|
| **이미지 픽셀 심의 커버리지** | P0 | 베이크 PNG 에 "피부진정·방수·7,000ppm" 인쇄됐는데 verdict=0 — OCR 이 deny-list 3축뿐, ADK 는 HTML 텍스트만. 픽셀 OCR 전축 심의 필요 |
| **ingest 다중-서브라인 오추출** | P0 | 라인앵커 실패 시 WB 전체 스캔 fail-open → 타 라인 근거·유형 오귀속. + 타깃 시험성적서 PDF 인입 경로(HARNESS_EVIDENCE_DIR) 미사용 |
| **후기 원문 결박·출처 표기** | P0 | 표시 후기를 리뷰 행 id·출처 해시에 결박, "자사몰" 오표기 방지 |
| **provenance dirty-worktree** | P1 | 미커밋 코드 실행이 커밋 sha 로만 기록 — 재현 불가 |

---

## 7. 웨이브 (사람-go 게이트)

| 웨이브 | 내용 | 게이트 |
|---|---|---|
| **W0** | 계획 검토 — ① 수정 3 확장(projector) 채택 여부(기본 미채택) ② 수정 1 래퍼 스크립트 채택 여부(기본 런북만) ③ 수정 5 방식(기본 선확보) ④ 수정 6 서비스 identity 승인 | **사람 go** |
| **W1** | 수정 2+3최소+4(attach·재게시·아티팩트) + 표적 단위 | 로컬 green |
| **W2** | 수정 5+6+7(회복예산·identity·인터랙션 배선) | 로컬 green |
| **W3** | 수정 1+8 + 런북(기동 표준·R-1~3·관측 메모) | — |
| **W4** | 오프라인 verify 전체(기존 그린 불변 + 신규) | CI 불변 확인 |
| **W5** | kill-and-reattach 라이브 리허설(새 스레드·소과금) | **사람 go(과금)** |

## 8. 불변식

1. **core 무수정** — 전부 chat 계층(`chat/src`·`chat/test`·런북)뿐. core diff 0 이 W4 게이트.
2. **잠긴 결정 1**(지어낸 버튼 금지) — attach 재게시는 `readNext` 재파생 카드만.
3. **자동 유료 재생성 금지 불변** — GenerateRetry 는 여전히 stop:human-input(드라이버 계획 P1 수정 유지).
4. **오프라인 CI 바이트 불변** — stub/골든/인수 기존 기대 불변(신규 추가만).
5. **state.json 불가침** — attach·projector 는 읽기 전용, 전이는 core scripts 만.
6. **fail-closed 유지** — 재시도·escalation 경로 의미론 변경 없음.

## 9. DoD

1. 오프라인: verify 전체 green(core diff 0) + attach/아티팩트/예산 표적 테스트 green.
2. 리허설(W5): 드라이버 kill 후 attach 재기동으로 **Slack 에 현재 게이트 카드가 다시 뜨고**, 자동 주행이 이어지며, 사람 클릭 1회가 게이트웨이에 라우팅됨(S-7 실측). 아티팩트가 세션별 보존 + terminal 리포트가 실상 반영.
3. 감사 기록에서 드라이버 자동 결정과 사람 결정이 구분됨(수정 6).
4. 런북에 기동 표준·R-1~3 반영.

## 10. 고지

본 산출물·검증은 법적 통과 보증이 아니라 자율·비법적 사전 점검이다(AGENTS 7번 절). 이 계획은 Slack 경로의 재개·가시성만 다루며, 픽셀 심의 등 core 결함(6번 절)이 닫히기 전의 done 은 배포 대상이 아니다 — 최종 책임은 사람(현업/RA)에게 있다.
