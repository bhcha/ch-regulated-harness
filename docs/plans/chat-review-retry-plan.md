# 챗 규정점검 재시도 경로 구축 계획 — ADK 비결정 실패에 잡-레벨 재적재 (fail-closed 유지)

> **지위**: `docs/plans/`(진행 중 계획 · **chat 계층 문서 — core 정본 D-1 갱신 의무 밖**). **작성**: 2026-07-19. **브랜치**: `feat/chat-live-driver-fix`.
> **관계**: [`../../chat/.live-rerun/adk-critic-rootcause-opus.md`](../../chat/.live-rerun/adk-critic-rootcause-opus.md)(**근본원인 분석 — 본 계획의 근거, 재도출 아님**) ·
> [`chat-live-driver-fix-plan.md`](chat-live-driver-fix-plan.md)(**수정 3 을 본 계획이 개정** — 사람 승인 필요) ·
> [`../reference/daemon-live-verification-runbook.md`](../reference/daemon-live-verification-runbook.md)(런북 — env 표 갱신 대상).
>
> ⚠ **이 문서는 계획일 뿐이다 — 사람의 go 전에는 아무것도 실행하지 않는다.** 코드 수정·env 변경·데몬 기동·라이브 런·과금은
> 전부 아래 웨이브의 사람 승인 게이트 뒤에 있다. 이 계획 작성 자체는 읽기 전용이었다(코드 0줄 수정 · 프로세스 0개 기동).

---

## 0. 한 줄 정의 · 목표

라이브 런 `chat-slack-C0BJ7FJ4A8M`(채널 C0BJ7FJ4A8M)이 02-concept 규정점검(원격 ADK 심의)의 **비결정 실패 1회**로
영구 차단됐다. 이 계획은 ① 그 원인을 Opus 분석으로 확정 인용하고 ② **잡-레벨 리뷰 재시도 경로**(bounded 재적재 +
백오프 + 소진 시 fail-closed)를 챗 플로우에 구축하며 ③ 더 깊은 처방(adk_critic 프로토콜 정합·에이전트측 수정)을
후속으로 계층화한다. **fail-closed 는 사양이다** — 재시도는 확률을 올릴 뿐 통과를 보증하지 않으며, 소진 후엔 반드시
멈춘다(조용한 강등 금지).

---

## 1. 근본원인 (Opus 분석 요약 — `adk-critic-rootcause-opus.md` 인용, 재도출 아님)

원격 ADK `cosmetics_review_agent`(Gemini 2.5 Flash · file_search RAG · tool_code/thought 를 **응답 텍스트로** 방출)가
단일턴 `/run` 에서 **비결정적으로**:

- (실패A) 사고사슬 텍스트만 내고 **최종 ```json verdict 블록을 누락**하거나(`_parse_json_block`=None),
- (실패B) **완성토큰 0개의 빈 응답**(finishReason=STOP, content.parts 없음)을 낸다 — 진단 시점엔 5/5 빈응답(degraded 구간).

그 위에 두 겹의 갭이 얹혀 런이 영구 차단됐다:

1. **인트라-크리틱 재시도는 도박이다**: `adk_critic.py` `_run_agent`(222행)가 빈응답/블록누락을 `ADK_CRITIC_RETRY` 회
   재시도(백오프 `2,5,10`초)로 흡수하지만, "JSON 이 나오는 턴"이 재시도 안에 걸리길 비는 확률 게임일 뿐이다. 소진 시
   `_die`(282행, exit≠0) → `kcia-check.sh` 가 `CRITIC_OUTCOME=failed`(441행) → 구현 도메인은 `KCIA_CRITIC_REQUIRED`
   자동 1(318행)이라 die(498~500행) → kcia-check 비-0 종료. **덧붙여 라이브 env(`chat/.live-rerun/env.sh` 18행)가
   `ADK_CRITIC_RETRY=3` 으로 코드 기본값 8(`_resolve_retries`, 188~198행)보다 낮게 핀**해 소진을 앞당겼다.
2. **챗 플로우에 잡-레벨 재시도가 없다**: `chat/src/kernel/flow.ts` `onOutcome`(952행) 의 실패 분기(959~962행)는
   리뷰 잡 `!outcome.ok` 를 Failure 카드 렌더 후 **return** — 재적재 없음. 상태는 `02-concept review pending` 으로
   고착되고, 드라이버의 Failure→recover(reconcile)는 **읽기 전용**이라 리뷰를 다시 돌리지 않는다.
   → **단일 transient ADK 히컵 하나가 런을 영구 차단**한다. (수동 `kcia-check` 로만 뚫었고, 그 수동 전이가 게이트웨이
   캐스케이드를 깨서 이 런의 자동 진행은 복구 불가가 됐다.)

남은 심의 게이트(03-storyboard-outline·plan·04-keyvisual)도 전부 같은 ADK 에이전트를 타므로 같은 비결정 실패에 노출된다.

---

## 2. 재시도 경로 설계 (주 산출물) — 잡-레벨 리뷰 재적재

### 2-1. 계층 구분 — 무엇이 이미 있고 무엇을 새로 만드는가

| 계층 | 무엇 | 지금 | 이 계획 |
|---|---|---|---|
| 1층(기존) | **인트라-크리틱 재시도** — `_run_agent` 1회 호출 안에서 빈응답/블록누락 N회 재호출(초 단위 백오프) | `ADK_CRITIC_RETRY`(코드 기본 8) + `ADK_CRITIC_RETRY_BACKOFF`(기본 `2,5,10`) | **튜닝만**(3장 (다) — env, 코드 0줄) |
| 2층(신규) | **잡-레벨 리뷰 재적재** — kcia-check(룰엔진+Pass-A+Pass-B) **전체를 새 리뷰 잡으로 다시 돌리는** 층. 1층과 직교(1층 소진 = 2층의 시도 1회 실패) | **없음**(갭) | **구축**(이 장) |
| 3층(후속) | **프로토콜 정합** — JSON 누락 시 same-session 재질의 / 에이전트측 구조화 출력 보장 | 없음 | 후속 웨이브 W5(3장 (나) — 별도 승인) |

⚠ **수정 3 개정 플래그**: `chat-live-driver-fix-plan.md` 4장(수정 3)은 "`ADK_CRITIC_RETRY` 상향 + fail-closed,
새 재시도 메커니즘 없음"을 **의도적으로 선택**했다. 2층 신설은 그 결정의 개정이므로 **W0 에서 사람 승인을 명시적으로
받는다**(승인 없이는 W2 착수 불가).

### 2-2. 어디에 — 터치포인트 (전부 chat 계층 · core 무수정)

| 파일 | 변경 |
|---|---|
| `chat/src/kernel/flow.ts` | ① `onOutcome` 시그니처에 선택 3번째 인자 `job?: Job` 추가(기존 호출 호환) ② 실패 분기(959~962행)에 **리뷰 실패 특례** 삽입(아래 2-3) ③ `createGateway`(1220행) 싱크를 `onOutcome: (outcome, job) => onOutcome(outcome, gw, job)` 로 — `OutcomeSink` 는 이미 job 을 넘긴다(`job-queue.ts` 30·102행, 배선만 안 돼 있음) |
| `chat/src/types/jobs.ts` | `JobPayload` 에 `attempt?: number`(리뷰 재적재 회차, 0=최초) 명시 필드 추가 — index signature 로 이미 허용되나 타입으로 못박는다 |
| `chat/src/config.ts` | 신규 env 게터 2개(엄격 파싱 — `timeoutEnvMs` 결): `CHAT_REVIEW_RETRY`(자동 재적재 최대 횟수, **기본 2** = 총 3회 시도) · `CHAT_REVIEW_RETRY_BACKOFF`(재적재 전 대기 초 콤마목록, **기본 `60,300`** — 1층의 초 단위와 달리 **분 단위**로 degraded 구간을 넘겨본다) |
| `chat/src/kernel/worker.ts` | (안전망) **stale-review 가드** — `payload.attempt > 0` 인 리뷰 잡은 실행 전 `readNext` 로 `action === "review"` 를 적극 확인, 아니면 벤인 no-op 회신("이미 점검이 끝났어요"). ingest 의 stale 가드(207~219행)와 같은 결 |
| `chat/test/kernel/flow.test.ts` 등 | 재시도 표적 단위 테스트(2-6) + 기존 리뷰 실패 기대 갱신 |
| 런북·`chat/README.md` | env 표에 `CHAT_REVIEW_RETRY`·`CHAT_REVIEW_RETRY_BACKOFF` 행 추가(chat 계층 env — core config-reference 대상 아님) |

배치 근거 — **worker 내부 루프가 아니라 flow.onOutcome 재적재**를 고른 이유:
① 시도마다 카드가 남는다(조용한 재시도 금지 — 관측성 요구), ② run 별 FIFO 체인을 백오프 대기로 점유하지 않는다
(드라이버의 [상태 다시 확인] 등 다른 잡이 사이에 흐를 수 있음), ③ 시도 1회의 시간 상한이 기존 워치독
(`KCIA_CRITIC_TIMEOUT` 등)으로 그대로 유지된다. 리뷰 잡은 드라이버 유무와 무관하게 항상 이 싱크를 지나므로
(리뷰는 데몬 소비 경로가 아니라 워커 in-process `kciaCheck` spawn) 단일 지점으로 충분하다.

### 2-3. 재시도 의미론 — onOutcome 리뷰 실패 분기 (의사코드)

```
if (!outcome.ok && outcome.kind === "review") {
  attempt = job?.payload.attempt ?? 0
  // (a) 재시도 대상 판별 — 전부 아니면 기존 그대로 Failure 렌더:
  //     · outcome.next?.action === "review" 일 때만(게이트 불변 = '심의 미완'). next 가 null(읽기실패)이나
  //       다른 action(그 사이 수동 전이 등)이면 재시도하지 않는다.
  //     · attempt < CHAT_REVIEW_RETRY 일 때만.
  if (재시도 대상) {
    render Progress("규정 점검이 일시 문제로 끝나지 않았어요 — 잠시 뒤 자동으로 다시 점검합니다 (N번째 시도/최대 M번)")
    로그 1줄(콘솔 · attempt·rid·stage — 감사)
    비동기 지연 재적재(fire-and-forget, 예외 흡수):
      await delay(backoff[attempt])            # 주입 가능(테스트=가짜 시계) · 기본 60→300초
      na = await gw.readNext(rid)              # 재적재 직전 재확인 — 대기 중 상태가 전진했으면 포기(로그만)
      if (na.action === "review")
        gw.queue.submit({ kind:"review", run_id, actor: AUTO_ACTOR, payload: { attempt: attempt+1 } })
    return
  }
  // (b) 소진 또는 비대상 → fail-closed: Failure 카드(기존 [상태 다시 확인] 유지) + "담당자 확인 필요" 평이 문구.
  render Failure(...); return
}
```

- **무엇이 재시도되나**: '심의를 끝내지 못한' 비-0 종료뿐이다(ADK 재시도 소진·타임아웃·REQUIRED die 등 → worker
  236~238행이 ok:false 로 환원). **위반 판정(deny)은 재시도 대상이 아니다** — verdict=fail 은 kcia-check **정상 종료
  (exit 0)** + 게이트 전이(revise)라 ok:true 리뷰 아웃컴으로 온다. 즉 **진짜 deny 를 flaky 로 가릴 구조적 여지가 없다**.
- **회차 원장 = 잡 payload**: `attempt` 카운터가 잡을 따라 흐른다(제출→큐→워커[무시]→싱크). 별도 상태 파일·메모리
  원장 없음 — state.json 불가침(core scripts 만 씀) 불변식 유지. revise 사이클 후의 새 심의는 자동 캐스케이드
  (`flow.ts` 982행)가 `payload:{}` 로 적재하므로 **사이클마다 예산이 새로 시작**한다(의도 — 무한이 아님: revise
  사이클 자체가 escalation 상한으로 bounded).
- **지연 재적재의 시계는 주입 가능**하게(`Gateway` 에 선택 `delay` 또는 모듈 주입 — live-assembly 의 주입 시계·sleep
  기존 패턴). 테스트는 즉시-resolve 가짜로 결정론.
- **드라이버와의 합성**: 재시도 대기·재점검 동안 최신 렌더는 Progress → `decideLive`=wait(드라이버 개입 없음).
  소진 후 Failure → recover(reconcile, 읽기 전용) → stalled 로 정직하게 종료. 이중 발화 없음.

### 2-4. 소진 후 fail-closed — 금지사항 (사양)

- 소진 시 **반드시 Failure 로 멈춘다**. 다음은 전부 **금지**:
  - `KCIA_CRITIC_REQUIRED=0` 우회(조용한 룰엔진-단독 강등) — **메모리 kcia-required-leak 교훈**: 구현 ADK 도메인의
    조용한 강등은 P2 결함으로 이미 한 번 막았다. kcia-check 318행의 자동 `:=1` 을 어떤 경로로도 무력화하지 않는다.
  - 무한/무기록 재시도, 수동 `kcia-check` 를 챗 밖에서 돌리는 우회(캐스케이드를 깬다 — 이번 런이 그 실증).
- 소진 후 정식 출구는 사람이다: 운영자가 ADK 헬스를 점검(진단 도구 6장)·회복 확인 후, **(선택 승인 시)** 2-7 의 수동
  [다시 점검] 버튼 또는 (미채택 시) 새 런/재개 결정.

### 2-5. 관측성 — 조용한 재시도 금지

- **core 쪽(무수정으로 공짜)**: 잡-레벨 재시도는 `kcia-check.sh` 를 통째로 재실행하므로 시도마다
  `runs/<id>/.logs/timing.jsonl` 에 `step=review outcome=start` / `step=review-passA outcome=failed …` 레코드와
  `critic-passA-<ts>.log` 캡처가 **자동으로 한 벌씩** 남는다. `bash scripts/timing.sh <id>` 로 시도 횟수가 보인다.
- **chat 쪽(신규)**: 시도마다 Progress 카드(평이 한국어 — 내부 용어 ADK/flaky 비노출, operator-voice 준수) + 콘솔
  로그 1줄. 드라이버 트랜스크립트 JSONL 이 카드를 그대로 캡처한다. 소진 Failure 카드 문구에 "여러 번 다시 점검했지만
  끝나지 않았다"를 명시(1회 실패와 구분).

### 2-6. 큐·상태 상호작용 — 이중 전이가 구조적으로 불가한 이유 + 표적 테스트

- **이중 advance 불가**: 게이트 전이는 core `gate.sh` 단독이고, `kcia-check.sh` 는 진입 시 게이트 검증(심의 차례가
  아니면 거부 — run-stage 365행 구현 진실)·idempotent 재개 가드(생산 마커+바인딩 해시, 193~229행)·verdict 원자쓰기
  (merge 1회)를 가진다. 재적재된 리뷰가 이미 전진한 상태를 만나면 core 가 거부한다(비-0) — 그마저 2-3(a) 의 사전
  재확인과 2-2 worker stale-review 가드가 대부분 걸러 벤인 no-op 로 끝낸다.
- **동시 실행 불가**: JobQueue 는 run 별 FIFO(같은 run 순차)라 리뷰 2건이 겹쳐 돌지 않는다. 지연 재적재는 체인 밖
  타이머지만 submit 자체는 체인 끝에 붙는다.
- **표적 단위 테스트**(전부 오프라인 결정론 — 가짜 게이트웨이·즉시 시계):
  1. 리뷰 실패 + next=review + attempt<N → Progress 렌더 + 백오프 후 attempt+1 리뷰 잡 재적재.
  2. 재적재 직전 재확인에서 action≠review → 재적재 포기(잡 0건 · 로그만).
  3. attempt=N 소진 → Failure 렌더(fail-closed) · 재적재 0건.
  4. verdict=fail(위반 판정, ok:true) → 재시도 경로 미진입(기존 verdictP 그대로 — deny 가림 없음 회귀 가드).
  5. next=null(읽기 실패) → 재시도 없이 Failure(기존과 동일).
  6. 리뷰 아닌 kind 실패(generate 등) → 기존 동작 불변.
  7. worker stale-review 가드: attempt>0 + action≠review → 셸 미호출 벤인 no-op.

### 2-7. (선택 · W0 결정) 소진 후 수동 [다시 점검] 버튼

소진 후 게이트웨이 안에서 사람이 리뷰를 재개할 유일한 방법이 현재는 없다(수동 kcia-check = 캐스케이드 파괴).
GenerateRetry 의 [다시 만들기] 패턴을 미러해 **소진 Failure 카드에 [다시 점검] 버튼**(새 액션 id → `kind:"review"`,
`attempt` 초기화, 승인자 게이트)을 다는 안을 **선택지로** 올린다. 대가: `interaction.ts`·presentation·어댑터 렌더·
`affordances`·드라이버 policy·인수 affordance-convention 테스트까지 면이 넓어진다. **기본 제안 = 이번 범위 미포함**
(최소 변경 — 자동 재시도가 주 산출물), 채택 여부는 W0 에서 사람이 정한다.

---

## 3. 더 깊은 처방 비교 — Opus (나)/(다)/(라) 와 계층 권고

| 안 | 내용 | 효과 범위 | 비용/위험 | 권고 |
|---|---|---|---|---|
| (다) 재시도·백오프 튜닝 | env 만: 라이브 env 의 `ADK_CRITIC_RETRY=3` **핀 제거**(코드 기본 8 복귀) 또는 ≥8 명시 + `ADK_CRITIC_RETRY_BACKOFF` 연장(예 `2,5,10,20,30`) | 실패A·B 모두 확률 개선 · degraded 구간엔 무력 | 0(코드 무수정 · 수정 3 과도 일관) | **지금(W1)** |
| (가) 잡-레벨 리뷰 재적재 | 2장 설계 — 분 단위 백오프로 kcia-check 전체 재실행 | 1층이 못 넘는 **긴 flaky 창**을 넘김 · degraded 장기화엔 여전히 무력 | chat 코드 변경 · **수정 3 개정(사람 승인)** | **지금(W2)** |
| (나)-i/ii adk_critic 프로토콜 정합 | (i) instruction/파싱 강건화 (ii) JSON 누락 시 **same-session 재질의**("위 심의 결과를 ```json 블록으로만 다시") — 실패A 의 직접 처방(추론은 이미 끝났으니 싼 후속 턴) | 실패A 근치 후보 · **실패B(빈응답)엔 무력** | **core 변경**(`adk_critic.py` `_run_agent`/`_do_passa`) → D-1 동반갱신 + 회귀(test-prompt-assembly 등) 필요 | **후속(W5 · 별도 승인)** |
| (나)-iii 에이전트측 수정 | `cosmetics_review_agent`(외부 ADK 레포)에서 thinking 텍스트 노출 억제·구조화 출력(response schema) 보장 | **실패A·B 의 진짜 근치**(방출측) | 이 레포 밖(외부 소유) — 요청·조율 필요 | **병행 액션 아이템**(W5 에서 전달문 작성) |
| (라) `_parse_json_block` 강건화 | 펜스 없는/부분 JSON 회수 | 이번 실패 모드엔 **무력**(회수할 JSON 자체가 없음 — 이미 보수 폴백 있음, 541~556행) | 낮음 | **비권고(기록만)** |

**권고 = 계층화**: 지금은 (다)+(가) — 싼 튜닝으로 1층 도박 횟수를 코드 기본으로 되돌리고, 2층 재적재로 분 단위
창을 추가한다. 근치는 (나)-iii(에이전트측 구조화 출력)이고 (나)-ii(재질의 턴)가 이 레포에서 할 수 있는 차선 —
둘 다 후속으로 뺀다(core/외부 변경이라 이번 라이브 재검증을 지연시키지 않기 위해).
**정직한 한계**: 진단 시점처럼 에이전트가 **지속 빈응답(5/5)인 degraded 창**에서는 (다)+(가)를 다 써도 소진될 수
있다. 그때 멈추는 것(fail-closed)이 옳은 동작이며, 이 계획은 그 경우의 성공을 약속하지 않는다.

---

## 4. 제약 · 불변식 (구현이 지켜야 함)

1. **fail-closed 가 사양**: 재시도는 bounded, 소진 후 반드시 중단. `KCIA_CRITIC_REQUIRED=0`·룰엔진-단독 조용한 강등
   금지(메모리 kcia-required-leak). 자동 `:=1`(kcia-check 318행) 불가침.
2. **수정 3 개정은 사람 승인**: "새 재시도 메커니즘 없음"은 의도된 결정이었다 — W0 게이트에서 명시 개정 승인 없이
   W2 착수 금지(승인 시 `chat-live-driver-fix-plan.md` 4장에 개정 각주 1줄 추가).
3. **오프라인 CI 바이트 불변**: 변경은 chat 온라인 경로뿐. stub/CI 에서 리뷰는 결정적(룰엔진)이라 실패하지 않으므로
   재시도 코드는 휴면 — 골든 바이트·stub E2E 5·인수 7·**core diff 0** 전부 불변이 게이트(W3). 단위 테스트는 가짜
   시계로 결정론(실 sleep 0).
4. **core 무수정(W1~W4)**: W5(나)-ii 를 승인해 core `adk_critic.py`/env 를 만지는 경우에만 D-1 동반갱신 —
   `feature-catalog.md`(scripts/lib 변경) + 새 env 시 `AGENTS.md` 2번 절 + `config-reference.md` 를 **같은 커밋**에서.
   `CHAT_REVIEW_RETRY*` 는 chat 계층 env 라 D-1 대상 아님(런북·chat/README 에만).
5. **격리(생성≠심의) 보존**: 재적재는 `kcia-check.sh` 를 있는 그대로 재호출(원격 ADK·적대 프롬프트·작업영역-밖
   scratch 불변). 생성 세션이 심의를 대신하는 경로 신설 금지.
6. **egress allowlist 불변**: 외부 전송면 추가 0 — 같은 instruction 조립·outbound allowlist(`_collect_copy`)·선택안
   좁힘 fail-closed 를 그대로 재사용. 새 종량 API 없음(추가 호출은 기존 GCP ADK 반복분뿐).
7. **state.json 불가침**: 회차 원장은 잡 payload — chat 은 어떤 상태 파일도 직접 쓰지 않는다.
8. **현업 카드 평이어**: 재시도·소진 문구는 operator-voice 준수(ADK·flaky·attempt 등 내부 용어 비노출).

---

## 5. 웨이브 분해 (의존 순서 · 사람-go 게이트)

| 웨이브 | 내용 | 산출물 | 게이트 |
|---|---|---|---|
| **W0** | 계획 검토 — ① **수정 3 개정 승인**(잡-레벨 재시도 신설) ② 기본값 확정(`CHAT_REVIEW_RETRY=2` · 백오프 `60,300`) ③ 2-7 수동 [다시 점검] 버튼 채택 여부 ④ W5(core 재질의 턴) 착수 여부는 별도 보류 가능 | 이 문서 | **사람 go(계획+개정 승인)** |
| **W1** | 경량 튜닝(다) — 코드 0줄: `chat/.live-rerun/env.sh` 의 `ADK_CRITIC_RETRY=3` 핀 제거(코드 기본 8) 또는 ≥8 명시 + 백오프 연장, 런북 76행 문구를 "코드 기본(8) 이상 유지 — 기본보다 낮춘 핀이 1차 차단 기여"로 교정 | env·런북 갱신 | — |
| **W2** | 잡-레벨 재시도 구현(가) — 2-2 터치포인트 전부: flow.onOutcome 특례 + 싱크 job 배선 + jobs/config env + worker stale-review 가드 + 카드 문구 + 표적 단위 테스트(2-6 의 7건) (+ W0 채택 시 2-7 버튼) | 코드 + 테스트 | 로컬 단위 green |
| **W3** | **검증(오프라인)** — `pnpm verify` 전체(빌드→단위 기존+신규→픽스처 멱등→stub E2E 5→인수 7→**core diff 0**) + 기존 리뷰-실패 기대 테스트 갱신분 통과 확인 | verify green | CI 불변 확인 |
| **W4** | **라이브 재검증**(과금 · 아래 5-1 레시피) — 채널 `C0BJ7FJ4A8M` **새 스레드** 신규 런으로 done 까지; 재시도 경로 발화 여부는 timing.jsonl·트랜스크립트로 판독 | 트랜스크립트·리포트·timing 판독 | **사람 go(과금 승인)** |
| **W5** | 후속(별도 승인) — (나)-ii adk_critic same-session 재질의 턴(core + D-1 동반갱신 + 회귀) · (나)-iii 에이전트 레포에 구조화 출력 보장 요청문 · (라) 비권고 기록 | 별도 계획/PR | **사람 go(core 변경 승인)** |

### 5-1. W4 라이브 재검증 레시피 (채널 C0BJ7FJ4A8M)

- **기존 런은 버린다(중요)**: `chat-slack-C0BJ7FJ4A8M` 은 수동 kcia-check 전이로 게이트웨이 캐스케이드가 깨져
  자동 진행 복구가 불가하다 — 깨끗한 검증은 **새 런**이어야 한다. 채널에 새 메시지를 올리고
  `CHAT_LIVE_THREAD=slack:C0BJ7FJ4A8M:<새 thread_ts>` 복합 id 로 rid 를 유일화한다(드라이버 계획 5-0 과 동일 수법).
  `CHAT_JOBS_DIR` 도 재검증 전용 새 디렉터리로.
- **사전 헬스 프로브(권장 · 과금 미미)**: Opus 재현 도구(`scratchpad/adk_diag.py`·`adk_diag2.py` — 분석 문서 6장)로
  ADK 엔드포인트 liveness 를 3~5회 찔러 degraded 창인지 먼저 본다. degraded(연속 빈응답)면 재런을 미룬다 —
  재시도 경로는 확률 개선이지 degraded 창의 보증이 아니다(3장).
- env 는 드라이버 계획 5-2 기준 + 본 계획 차분: `ADK_CRITIC_RETRY` 핀 제거(또는 ≥8) · `CHAT_REVIEW_RETRY`/
  `CHAT_REVIEW_RETRY_BACKOFF` 는 기본값이면 export 불요. 토폴로지(데몬+드라이버+운영자 세션)는 드라이버 계획 5-1 그대로.
- **관측 포인트**: ① 심의 게이트 4곳이 Failure 카드 없이 통과(재시도 카드가 떠도 최종 verdict 로 이어지면 성공)
  ② `bash core/scripts/timing.sh <rid>` 에서 `review` 시도 레코드 수 = 재시도 소비량 ③ 트랜스크립트 JSONL 에
  재시도 Progress 카드 캡처 ④ 소진이 발생하면 Failure 에서 멈추는지(fail-closed 검증 — 이 경우도 경로 자체는 합격).

---

## 6. 리스크 · 함정

1. **이중 적재/캐스케이드 desync**: 재적재와 자동 캐스케이드·수동 전이가 겹치는 창 — 3중 방어(재적재 직전 next 재확인
   · worker stale-review 가드 · core kcia-check 게이트/idempotent 가드)로 닫고, 겹쳐도 core 가 거부한다(2-6). FIFO 라
   동시 리뷰 2건은 불가.
2. **무한 재시도**: `attempt` 카운터가 잡을 따라가는 bounded 예산 + revise 사이클은 escalation 상한이 bounded —
   두 겹 다 유한. 시도마다 카드·로그가 남아 폭주가 보인다.
3. **진짜 deny 를 flaky 로 가림**: 구조적으로 불가 — deny(verdict=fail)는 exit 0 정상 완료라 재시도 분기에 진입하지
   않는다(2-3). 회귀 테스트 4번이 못박는다. 반대로 설정오류(preflight die 등) 같은 비일시 실패는 N회 헛재시도 후
   소진된다 — 수용(N 작음), 런북에 "critic-passA 로그 꼬리로 설정 vs flaky 를 먼저 가려라" 트리아지 1줄 추가.
4. **ADK 추가 호출 비용**: 최악 (N+1)×(Pass-A + Pass-B fan-out≤8)/게이트 — bounded 이고 승인된 비용 스탠스
  (GCP ADK) 안, 새 종량 API 없음. 백오프가 분 단위라 벽시계도 게이트당 최대 +~7분 수준.
5. **degraded 창은 여전히 막는다**: 진단 시점(5/5 빈응답) 같은 구간이면 2층까지 소진될 수 있다 — 그때 멈추는 것이
   사양이다. 완화는 W5(에이전트측 근치)와 사전 헬스 프로브(5-1).
6. **현 라이브 런 복구 불가**: 수동 kcia-check 가 이미 캐스케이드를 깼다 — W4 는 반드시 새 런(5-1). 기존
   `runs/chat-slack-C0BJ7FJ4A8M` 은 감사용 보존.
7. **기존 테스트 기대 충돌**: onOutcome 리뷰-실패의 기대가 "즉시 Failure"에서 "재시도 후 Failure"로 바뀐다 — 관련
   단위/인수 기대를 W2 에서 같이 갱신하고, 재시도 정책(횟수·시계)을 주입 가능하게 해 기존 시나리오는 0 재시도로도
   재현 가능하게 한다.
8. **드라이버 stuck 임계와의 간섭**: 재시도 대기(최대 300초)+재점검(인트라-크리틱 백오프 포함 수 분)이 이어지면
   같은 na 서명의 wait 가 길어진다 — 드라이버 `stuckThresholdMs`(기본 15분)로 대부분 수용되나, 재런 시 옵션 상향
   여지를 런북에 메모. 소진 Failure→recover(reconcile)→Progress 잔상으로 마지막에 stalled 종료가 15분 지연될 수
   있음(정직한 종료 — 리포트 reason 으로 가시화).

---

## 7. DoD (완료 정의)

1. **오프라인**: `pnpm verify` 전체 green(core diff 0 포함) + 2-6 표적 테스트 7건 green. core/packs 무수정(W5 제외).
2. **동작 사양**: 리뷰 잡 실패 시 — 게이트 불변 + 예산 내면 백오프 후 자동 재적재(카드·로그 가시화), 소진/비대상이면
   Failure fail-closed. deny 는 재시도 미진입. `KCIA_CRITIC_REQUIRED` 우회 코드 0줄(리뷰로 확인).
3. **라이브(W4, 사람 go 후)**: 채널 C0BJ7FJ4A8M 새 런이 수동 kcia-check 0회로 done 도달(재시도 소비는 timing.jsonl 로
   판독), 또는 degraded 로 소진 시 Failure 에서 멈춘 것을 확인(fail-closed 검증도 합격 조건).
4. 수정 3 개정이 승인·기록됨(`chat-live-driver-fix-plan.md` 각주) · 런북 env 표 갱신.

> **재확인: 본 문서는 계획이며, 사람 go(W0 개정·계획 승인 · W4 과금 승인 · W5 core 변경 승인) 전에는 어떤 코드
> 수정·env 변경·프로세스 기동·과금도 하지 않는다.**

---

## 8. 고지

본 산출물·재검증은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). 재시도는 일시 장애를 넘기는
장치일 뿐 심의 판정을 바꾸지 않으며, 반복 실패 시 멈추고 사람이 본다 — 최종 책임은 사람(현업/RA)에게 있다.
