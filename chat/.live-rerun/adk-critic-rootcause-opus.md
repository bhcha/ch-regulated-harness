# ADK 규정점검 차단 — Opus 근본원인 분석 (2026-07-19 라이브 런)

> 이 문서는 **Opus 로그·원문 분석 결과**다. 실제 계획 수립은 Fable 이 이걸 근거로 한다.
> 대상 런: `chat-slack-C0BJ7FJ4A8M`(이지덤 뷰티 릴리프·cosmetic·multipage_bm). 채널 C0BJ7FJ4A8M.

## 1. 증상 (관측된 사실)
- 라이브 런이 **02-concept 심의(규정점검) Pass-A**에서 막혔다. 드라이버는 정상(Failure→reconcile 회복). 블로커는 심의.
- `.logs/critic-passA-*.log`: `adk_critic: 원격 심의 실패(재시도 3회 소진): 응답에서 구조화 블록(json)을 찾지 못함(flaky)`.
- 그 직후 **수동 재실행(kcia-check)은 통과**(걸린 부분 0개) → 전이 02-concept→03-storyboard. 즉 **비결정적**.
- 01-brief 심의는 **1회에 통과**(60s, revise 없음). concept 만 실패.

## 2. 근본원인 (원문 캡처로 확정 — scratchpad/adk_diag.py·adk_diag2.py)
원격 ADK 엔드포인트(`cosmetics-agent-...run.app`, app=cosmetics_agent, author=cosmetics_review_agent)를 동일 concept 페이로드로 직접 여러 번 호출해 **RAW 응답**을 캡처한 결과:

- 에이전트는 **Gemini 2.5 Flash** 기반이며 **`file_search`(화장품 지침 RAG) + `tool_code`/`thought`(사고사슬)** 를
  **응답 텍스트로** 방출한다(구조화 functionCall 아님 — 모델의 thinking 이 본문으로 샘). 예(concept):
  `tool_code\nprint(file_search.query(query="...얇은 시트/반투명/핀셋 위반사례..."))\nthought\nThe user wants me to act as a compliance reviewer...` (4887자, 추론만, **최종 ```json 블록 없음**).
- 단일턴 `/run`(streaming:false) 응답이 **비결정적**:
  - (실패A) 추론 텍스트만 반환, 최종 ```json 없음 → `_parse_json_block`=None → "구조화 블록 못 찾음". (concept 원래 실패)
  - (실패B) **완성토큰 0개**(finishReason=STOP, content.parts 없음, totalTokenCount==promptTokenCount) → 빈 텍스트. (진단서 5/5, trivial 호출도 동일)
  - (성공) 추론 후 ```json{"violations":[...]}``` 까지 방출 → 통과. (brief 1회 통과·concept 수동 재실행 통과)
- 즉 **에이전트가 사고사슬만 내고 최종 구조화 JSON을 비결정적으로 누락/공백**한다. 진단 시점엔 5/5 빈응답(에이전트 degraded 구간).

### 왜 통과할 때도 있나
`_run_agent`(adk_critic.py:222)가 parse_fn=None/빈텍스트에 **인트라-크리틱 재시도**(ADK_CRITIC_RETRY=3, backoff 2,5,10)를 한다.
"JSON 이 나오는 턴"이 재시도 안에서 걸리면 흡수(통과). 에이전트가 지속적으로 추론만/빈응답이면 전 재시도 소진 → 실패.
=> 재시도는 **비결정성 도박**이지 결정론적 보증이 아니다.

### 왜 런이 영구 차단되나 (챗 플로우 갭)
`chat/src/kernel/flow.ts` `onOutcome`(952): 리뷰 잡 `!outcome.ok` → `failureP` 렌더 후 **return**. **잡-레벨 재시도·재적재 없음.**
그래서 인트라-크리틱 재시도가 소진돼 리뷰 잡이 한 번 실패하면, 상태는 `02-concept review pending` 으로 고착.
드라이버(수정본)는 Failure→recover(reconcile, 읽기전용)로 대응하지만, reconcile 은 리뷰를 **다시 돌리지 않는다**(읽기전용).
=> **단일 transient ADK 히컵 하나가 런을 영구 차단**한다. (수동 kcia-check 로만 뚫었고, 그건 게이트웨이 캐스케이드를 깨서 이 런의 드라이버 자동진행은 복구 불가.)

## 3. 영향 범위
- 남은 심의 게이트(03-storyboard-outline·03-storyboard-plan·04-keyvisual)가 **모두 같은 ADK 에이전트**를 탄다 → 같은 비결정 실패에 노출.
- 에이전트가 degraded 구간이면 재시도 경로가 있어도 막힐 수 있다(재시도는 확률 개선이지 보증 아님).
- 드라이버 수정(dev-loop 산출물)과 **무관** — 드라이버는 검증됨(① 카드 게시·자동 select·Verdict/Progress/Failure 유휴정지 없이 통과·회복).

## 4. 고칠 지점 후보 (Fable 가 계획으로 구체화)
- **(가) 챗 플로우 잡-레벨 리뷰 재시도**(사용자 요청 "재시도 경로"): `onOutcome` 의 리뷰 실패 분기에서 **bounded 재적재**
  (예 최대 N회, 지수 백오프) 후 그래도 실패면 Failure(fail-closed 유지). 인트라-크리틱 재시도(단일 _run_agent 내)와 **직교**한
  '리뷰 잡 통째 재실행' 계층. transient/degraded-일시 구간을 넘긴다. ⚠ 계획 수정3의 "새 재시도 메커니즘 안 만든다"와
  충돌하므로 그 결정을 개정하는 사람 승인 필요. fail-closed 사양(반복 실패 시 중단)은 N회 후 유지.
- **(나) 근본: adk_critic 멀티턴/프로토콜 정합**: 에이전트가 tool_code/thought 를 텍스트로 방출하고 최종 JSON 을 비결정적으로
  누락하는 게 진짜 원인. `/run` 단일턴 대신 (i) 에이전트가 최종 구조화 JSON 을 **반드시** 내도록 instruction/parse 강건화,
  (ii) 또는 응답에서 JSON 이 없을 때 "JSON 만 다시 내놔" 후속 턴(same session) 재질의, (iii) 또는 에이전트측(cosmetics_review_agent
  repo)에서 thinking 노출 억제·구조화 출력 보장. (i)(ii)는 core adk_critic 변경, (iii)은 외부 ADK 레포.
- **(다) 재시도/백오프 튜닝**(경량·env): ADK_CRITIC_RETRY 상향(예 6~8)+backoff 연장 — 도박 횟수↑. 계획 수정3과 일관(기존 다이얼).
  단 degraded 구간엔 무력. (가)/(나)의 보완재.
- **(라) `_parse_json_block` 강건화**: 펜스 없는 JSON·부분 JSON 회수. 단 '추론만/빈응답'엔 무력(회수할 JSON 자체가 없음).

## 5. 제약·불변식 (계획이 지켜야 함)
- **fail-closed 가 사양**: 재시도는 bounded, 소진 후엔 반드시 fail-closed(조용한 강등·KCIA_CRITIC_REQUIRED=0 우회 금지 — 메모리 kcia-required-leak).
- 계획 수정3은 "ADK_CRITIC_RETRY + fail-closed, 새 재시도 메커니즘 없음"을 **의도적으로 선택**했다 → (가)는 그 결정의 개정(사람 승인).
- 격리: 생성≠심의(원격 ADK, 다른 벤더). adk_critic 은 egress allowlist·격리가드 유지.
- 오프라인 CI 불변: 변경은 온라인 경로만, 골든 바이트·stub E2E·인수 불변. core 변경 시 D-1 정본 동반갱신.
- 관측성: 재시도·실패는 timing.jsonl·critic 로그에 가시화(조용한 재시도 금지).

## 6. 참고 (재현 도구)
- `scratchpad/adk_diag.py` (N회 호출·status 요약), `scratchpad/adk_diag2.py` (copy_text·RAW event·liveness·brief 비교).
- 핵심 코드: `core/scripts/lib/adk_critic.py` `_run_agent`(222)·`_parse_json_block`(541)·`_do_passa`(647);
  `core/scripts/kcia-check.sh` Pass-A(386~436); `chat/src/kernel/flow.ts` `onOutcome`(952~).
