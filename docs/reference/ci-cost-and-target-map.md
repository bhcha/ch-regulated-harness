# CI 비용 실측 + 변경 파일 → 최소 타겟 테스트 매핑표 (C-1)

> 계측 기준 커밋 = main **c181284** · 스냅샷(**2026-07-08**)
> 전체 wall-clock = **23분 47초(1,427초)** · 스위트 **41개** 순차(no-LLM, `HARNESS_OFFLINE=1`)
> 선재 실패 **4건**(critic-fanout 3 + b4 1) — 이번 계측에서 **그대로 확인됨(일치)**. ⚠ critic-fanout 3건은 '미구현 도메인 스킵'이 아니라 **스테일-테스트 드리프트**다(원인 정정 = 1단계 표).
>
> 계측 방법: `tests/run-ci.sh` 의 env 프리앰블(누수 변수 unset + `HARNESS_OFFLINE=1`)만 미러링하고,
> 각 스위트를 `bash tests/<스위트>.sh` 로 **직접·순차** 실행해 스위트별 wall-clock(초)·pass/fail 를 기록했다
> (run-ci.sh 자체는 전역 lock 충돌 회피 위해 우회). 병렬화는 하지 않았다(타이밍 오염 방지 + 설계상 `runs/ci-*` 공유·전역 lock).

이 표는 유지보수성 리팩토링 계획 C-1(부록A) 및 ops-and-pack 규율의 실행을 돕는다: **반복 중엔 타겟 테스트만, 커밋 시 전체 CI**.

---

## 1단계. 선재 실패 확인 (기준선 4건 일치)

스위트 단위로는 **실패 2개**(`test-b4`, `test-critic-fanout`)이고, 그 안의 실패 **체크(assert)** 를 세면 정확히 **4건**이다:

| 실패 스위트 | 실패 체크 수 | 내용 | 원인(오프라인) |
|---|---|---|---|
| `test-critic-fanout` | **3** (PASS=39/FAIL=3) | 케이스 (4) — 테스트가 drug 를 'adk_critic 블록 없는 ADK 미구현 도메인' 예시로 하드코딩(주석: "drug=adk_critic 블록 없음")하고 룰엔진-단독 가시화(`critic_ran=false`)를 단정 | **스테일-테스트 드리프트**(미구현 스킵 아님): drug 는 c181284 에서 **`status: active`** 이고 `packs/drug/domain.json` 에 adk_critic 블록(`ADK_DRUG_CRITIC_URL`·app `pharma_agent`)이 **존재**한다 → 케이스 (4)의 'drug=미구현' 전제가 어긋나 3건 실패(관측 증상 = `runs/ci-cfan-drug/01-brief/brief-verdict.json` FileNotFoundError). ⚠ '무시 가능한 미구현'으로 넘기면 실제 회귀를 가릴 수 있음 |
| `test-b4` | **1** (PASS=22/FAIL=1) | `enabled_if` — 실증 등록 시 clinicalEvidence/beforeAfter 포함 단정 | 블록 리스트가 기대치('OK')와 불일치(`BAD:[...]`) — 알려진 선재 실패 |

**합계 = 3 + 1 = 4건.** 이 커밋(c181284)의 알려진 선재 실패 집합과 **정확히 일치**한다. 그 외 39개 스위트는 전부 PASS이며 **새로운(예상 밖) 실패는 없다.**

> **후속(이 트랙 범위 밖 — 기록만)**: `test-critic-fanout` 케이스 (4)는 drug 가 active 로 구현된 지금 **스테일**이다(미구현 예시로 쓰기엔 부적합). 실제 미구현 도메인(예: `quasi_drug`=TBD)을 픽스처로 쓰도록 갱신하는 게 맞으나, 기존 `tests/test-*.sh` 는 커널 정리(K-5 테스트 위생) 소유 표면이라 본 트랙(C·L·D)에서는 건드리지 않는다. b4 1건도 마찬가지로 커널/골든 트랙 소관.

---

## 2단계. 스위트별 소요(초) — 내림차순 전체

**상위 5개 병목**은 굵게 표시(합계 653초 = 전체의 약 46%).

| 순위 | 스위트 | 소요(초) | 결과 |
|---:|---|---:|:--:|
| 1 | **test-components** | **158** | PASS |
| 2 | **test-b4** | **144** | FAIL(선재) |
| 3 | **test-evidence-reflection** | **138** | PASS |
| 4 | **test-b0** | **111** | PASS |
| 5 | **test-b2** | **102** | PASS |
| 6 | test-b5 | 96 | PASS |
| 7 | test-critic-fanout | 81 | FAIL(선재) |
| 8 | test-b7 | 69 | PASS |
| 9 | test-b9 | 64 | PASS |
| 10 | test-evidence-attachment | 59 | PASS |
| 11 | test-intake | 49 | PASS |
| 12 | test-insession-genmode | 42 | PASS |
| 13 | test-operator-language | 37 | PASS |
| 13 | test-drug-stub-golden | 37 | PASS |
| 15 | test-observability | 35 | PASS |
| 16 | test-b3 | 25 | PASS |
| 17 | test-b1e | 22 | PASS |
| 18 | test-prompt-assembly | 20 | PASS |
| 19 | test-b1 | 16 | PASS |
| 19 | test-trace-verdict-id | 16 | PASS |
| 21 | test-b1g | 15 | PASS |
| 21 | test-gen-timeout | 15 | PASS |
| 23 | test-gates | 12 | PASS |
| 23 | test-gen-not-review-isolation | 12 | PASS |
| 25 | test-b8 | 11 | PASS |
| 25 | test-routes | 11 | PASS |
| 27 | test-gen-image-completeness | 10 | PASS |
| 28 | test-multiproduct-extraction | 6 | PASS |
| 29 | test-clinical-chart | 4 | PASS |
| 30 | test-image-engine | 2 | PASS |
| 31 | test-drug-golden | 1 | PASS |
| 31 | test-relief-facts | 1 | PASS |
| 31 | test-clinical-engine | 1 | PASS |
| 31 | test-completeness-advisory | 1 | PASS |
| 31 | test-render-existence-depth | 1 | PASS |
| 31 | test-pack-lint | 1 | PASS |
| 31 | test-examples-analysis | 1 | PASS |
| 38 | test-prompt-contract | 0 | PASS |
| 38 | test-render-mode-gate | 0 | PASS |
| 38 | test-core-domain-leak | 0 | PASS |
| 38 | pack-conformance | 0 | PASS |

**상위 5 병목**: `test-components`(158) · `test-b4`(144) · `test-evidence-reflection`(138) · `test-b0`(111) · `test-b2`(102).
공통점 = 전부 **stub 파이프라인을 여러 런 완주**시키는 E2E 스위트(구성요소 커버리지·근거 반영·스켈레톤·컨셉). 반대로 단위·순수함수 스위트(임상엔진·이미지엔진·라벨·라우트·pack-lint)는 1~4초로 저렴하다.

> 참고: 계획 C-1 의 추정 후보였던 `test-clinical-chart`(1,600줄)는 실제 **4초**로 병목이 아니다 — 합성 run dir + 레코드/블록 단위 검증이라 파이프라인을 돌지 않는다. `test-multiproduct-extraction`(913줄)도 **6초**. 병목은 코드 줄 수가 아니라 **완주하는 stub 런 수**가 좌우한다.

> 기준선 비교: 유지보수성 계획 부록A(2026-07-07)는 40스위트·25분 49초였다. 이번(c181284, 2026-07-08)은 41스위트(그 사이 `test-examples-analysis` 편입)·23분 47초. 차이는 스위트 구성/머신 편차 범위이며, 선재 실패 4건 정체성은 동일하다.

---

## 3단계. 변경 파일 → 최소 타겟 테스트 매핑표

반복(개발 루프) 중에는 아래 "최소 타겟"만 돌려 빠르게 회귀 확인하고, **커밋 직전 전체 CI**(`bash tests/run-ci.sh`)로 마감한다.
`(전용)` = 그 파일/심볼을 직접 검증하는 1급 스위트. 나머지는 동작 경로상 함께 도는 스위트.
근거 = 해당 테스트 소스에서 그 파일명/심볼을 실제 grep 한 결과(추측 아님). 모든 스위트명은 `core/tests/` 의 실파일명과 일치.

| 변경 파일 | 최소 타겟 테스트 | 근거(grep 심볼) |
|---|---|---|
| `lib/image_engine.py` | `test-image-engine`(전용) · `test-gen-image-completeness` · `test-render-existence-depth` · `test-clinical-chart` | `image_engine` (+ test-insession-genmode·test-core-domain-leak) |
| `lib/adk_critic.py` | `test-critic-fanout`(전용) · `test-pack-lint`(전용, adk_critic 블록 lint) · `test-clinical-engine` · `test-prompt-assembly` | `adk_critic` |
| `lib/kcia_engine.py` | `test-clinical-engine`(전용) · `test-clinical-chart`(전용) · `test-b3` · `test-drug-golden` · `test-gen-image-completeness` · `test-core-domain-leak` | `kcia_engine` (+ test-b5) |
| `lib/ingest.py` | `test-b1`(전용, claim-basis 추출) · `test-multiproduct-extraction`(전용) · `test-relief-facts`(전용) · `test-b1e` · `test-evidence-attachment` · `test-intake` · `test-core-domain-leak` | `ingest.py` |
| `lib/stub_stage.py` | `test-b0`(전용, state 미기록) · `test-insession-genmode`(전용) · `test-core-domain-leak` | `stub_stage` |
| `lib/operator_labels.py` | `test-operator-language`(전용, 금지 토큰 미출력) · `test-completeness-advisory` · `test-core-domain-leak` | `operator_labels` |
| `lib/render_runmd.py` | `test-gates`(전용, gate_type 파생) · `test-routes` · `test-completeness-advisory` · `test-gen-image-completeness` | `render_runmd` |
| `lib/common.sh` 전반 | `test-prompt-contract` · `test-routes` · `test-drug-golden` · `test-gen-timeout` · `test-intake` · `test-image-engine` · `test-clinical-chart` · `test-b1g` · `test-b8` · `test-gen-image-completeness` · `test-critic-fanout` | `common.sh` (공용 셸 — 광범위, 커밋 전 전체 CI 권고) |
| `build_context()` (common.sh 함수) | `test-prompt-contract`(전용, Inputs⊆라벨) · `test-prompt-assembly` · `test-b1g` · `test-b8` · `test-evidence-attachment` | `build_context` |
| `gate.sh` | `test-render-mode-gate`(전용) · `test-trace-verdict-id`(전용) · `test-b0` · `test-b1e` · `test-b3` · `test-b4` · `test-intake` | `gate.sh` |
| `validate-stage.sh` | `test-b0` · `test-components` · `test-examples-analysis` · `test-b1e` · `test-b1g` · `test-b2` · `test-b4` · `test-evidence-attachment` · `test-intake` | `validate-stage` |
| `run-stage.sh` | `test-gen-timeout`(전용, watchdog) · `test-gen-not-review-isolation`(전용, 생성≠심의) · `test-insession-genmode`(전용, GEN_MODE) · `test-b0` | `run-stage` (28 스위트 접촉 — 사실상 전 파이프라인, **커밋 전 전체 CI 필수**) |
| `new-run.sh` | `test-multiproduct-extraction` · `test-drug-golden`(도메인 선언) · `test-routes` · `test-b1g` · `test-intake` · `test-evidence-attachment` | `new-run` |
| `intake.sh` | `test-intake`(전용) · `test-routes`(intake 라우팅) | `intake.sh` |
| `harness/*.schema.json` (동결 계약) | `test-pack-lint`(ruleset) · `pack-conformance`(4팩) · `test-routes`(pipeline-routes) · `test-clinical-engine`(claim-basis) · `test-components`(storyline) · `test-gates` · `test-image-engine` · `test-evidence-attachment` · `test-clinical-chart` · `test-b3` · `test-core-domain-leak` (+ validate-stage.sh 소비 스위트 전부) | `.schema.json` (동결 계약 — **커밋 전 전체 CI 권고**) |
| `prompts/*.md` (단계 생성 프롬프트) | `test-prompt-assembly`(전용, 조립 골든) · `test-prompt-contract`(전용, Inputs 계약) · `test-core-domain-leak`(도메인 어휘 누출) | `prompts/` |

### 사용 규율(반복 중엔 타겟만, 커밋 시 전체)

- **반복 루프**: 위 표에서 변경 파일에 해당하는 "최소 타겟"만 `bash tests/<스위트>.sh` 로 순차 실행(대부분 몇 초~1분). 다중 파일을 만졌으면 각 행의 합집합.
- **커밋 직전**: 반드시 `bash tests/run-ci.sh` 전체(약 24분). `common.sh`·`run-stage.sh`·스키마처럼 광범위 접촉 파일은 반복 중에도 전체 CI 권고.
- **병렬화 금지**: `runs/ci-*` 공유 + 전역 lock + 결정성 설계상 스위트 병렬은 결과를 오염시킨다(유지보수성 계획 부록B M-3).
- **선재 실패 무시선**: `test-b4`(1) · `test-critic-fanout`(3)의 위 4개 체크는 오프라인 기준선. 이 4건 외에 빨간 줄이 새로 뜨면 그건 회귀다.

---

## 고지
본 문서는 계측 스냅샷(c181284, 2026-07-08)이며 코드를 바꾸지 않는다. 소요 시간은 머신·부하에 따라 변동한다. 절대 진실은 그때그때의 `tests/run-ci.sh` 실행 결과다.
