# 유지보수성 리팩토링 계획 — 하드코딩·중복·5레이어 점검 (조사 보고 + 실행 계획)

> **이 문서의 지위:** 2026-07-07 전 코드 스캔(하드코딩 · 중복 · 레이어 구성 · 변경비용)의 **조사 보고이자 처방 계획**이다. 목적 = "수정 1건마다 시간이 오래 걸린다"는 유지보수 비용의 원인 실측과 절감.
> **관계:** 실행 중인 정본 [`ops-and-pack-refactor-plan.md`](./ops-and-pack-refactor-plan.md)(1부 완료 · 2부 팩 분리 진행 중)를 **대체하지 않는다**. 이 계획의 본체(K·D 트랙)는 **2부 1차 완료 후** 착수하고, 즉시 항목(I 트랙)만 선행한다(6장). 규칙 SSoT = [`../AGENTS.md`](../AGENTS.md).
> **근거:** 파일:줄 인용 = 2026-07-07 워킹트리(브랜치 `refactor/pack-stage-2`, 2부 2단계 커밋 a·b 완료 시점) 실측. 이후 커밋으로 줄번호가 흐르므로 **착수 시 심볼(함수·상수명) 기준 재확인**한다.
> 작성 2026-07-07 · 상태: **계획 수립 — 부록B 열린 결정 4건 사람 확정 대기**

---

## 0. 한눈 요약

**질문 1 — "지금 구조(spec-flow·GSD 참고)로 충분한가, 5레이어(Memory/Tools/Permissions/Hooks/Observability) 구성으로 리팩토링해야 하나?"**

→ **골격은 충분하다. 레이어 재구성(hooks·MCP·프레임워크 도입)은 하지 않는다.** 이 하네스는 5레이어 모델의 핵심 요구("프롬프트가 아니라 메커니즘으로 품질 강제")를 이미 `state.json + scripts/*.sh` 결정론 게이트로 달성했고, 그 노선은 ADR(`docs/_archive/orchestration-architecture-decision.md` — "현 파일 기반 단계-게이트 유지, 프레임워크 이식 불필요")로 명문화돼 있다. hooks 는 AGENTS 절대규칙 3(이식성)이 명시 금지하며, 도입하면 두 CLI(Claude·Codex) 공통 SSoT 가 깨진다. 다만 레이어 갭 2건 — **L3(권한 정책 파일 부재) · L5(실행 주체 메타 미기록)** — 은 저비용·고이득이라 부분 채택한다(4장 판정표).

**질문 2 — "왜 수정 1건마다 오래 걸리나?"** (실측 = 부록A)

1. **문서 동반 갱신이 사람 기억에만 의존**: 최근 30커밋 중 24커밋(80%)이 docs 동반, `workflow-ssot.md` 는 30커밋 중 8회 수정. 문서-코드 정합을 검증하는 기계 장치가 없다.
2. **전체 CI 의무 = 커밋당 약 26분**: 40개 스위트 순차(`tests/run-ci.sh:35`), 2026-07-07 실측 25분 49초. 항목 커밋마다 전체 CI 가 규율이다.
3. **커널 내부 중복 약 1,000줄+**: 같은 로직이 셸·파이썬에 2~14벌(3장) — 수정 지점 탐색·동기화 비용, 드리프트 위험.
4. **조용한 스킵 2곳 + 사람-기억 동기 다수**: 빠뜨려도 CI 가 빨개지지 않는 지점(5장 표).

**즉시 조치(2부 트랙 편입 권고) 1건:** 2부 1단계(cosmetic 폴백 전수 소거)의 **누락 지점 = `scripts/intake.sh` 2건** — 2장 H-1.

---

## 1. 조사 방법

- 병렬 전수 스캔 4축(하드코딩 / 셸 중복 / 파이썬·스키마·테스트 중복 / 레이어 인벤토리) + 변경비용 시나리오 배선 추적(S1~S5) + git 이력·CI 소요 실측.
- 스캔 결과 중 상충·핵심 항목은 별도 재검증했다(단계순서 정본, harness.py import 15파일, `_REGULATED` 2벌, intake.sh 폴백, tests/lib.sh 커버리지 40개 중 39개, CI 25분 49초). 스캔 보고 중 반증된 주장(예: kcia_merge.py 사문설 — 실제 `kcia-check.sh` 가 소비, skills↔commands 드리프트설 — 실제 없음)은 본 문서에서 제외했다.
- 대상 = `core/scripts`·`core/harness`·`core/prompts`·`core/skills`·`core/tests` (제외 = `runs/`·`docs/_archive`·`packs/*/sources`).

---

## 2. 조사 결과 1 — 하드코딩

### 2-1. 이미 계획(2부)에 잡혀 있는 것 — 재작업 금지

도메인 어휘 하드코딩의 본체는 누출 grep allowlist 14파일(`tests/test-core-domain-leak.sh:22-37`)로 관리되며 2부 단계별 소거가 이미 계획돼 있다: ingest.py·examples_analysis.py(3단계) / stub_stage.py `_is_cosmetic` 이분법 14분기·프롬프트 5종(5단계) / operator_labels.py·image_engine.py·render_runmd.py(6단계) / 브랜드 픽스처·테스트 단정(7·8단계) / kcia_engine 임상 정책·adk_critic author 슈퍼셋(2단계 잔여 ⏸). **본 계획은 이들을 건드리지 않는다.**

### 2-2. 계획 밖 발견 (본 계획의 대상)

| id | 위치 | 내용 | 처방 트랙 |
|---|---|---|---|
| **H-1** | `scripts/intake.sh:34-47` · `:129-133` | **2부 1단계 소거 누락 2건(재검증 완료)**. ① `normalize_domain`/`normalize_format` 을 인라인 case 로 재구현(new-run.sh 는 1단계 c43b8e3 에서 `domain_alias_resolve`/`format_alias_resolve` 레지스트리 질의로 이관 완료 — intake 만 갈라짐). ② 기능성 카테고리 폴백이 `["whitening","wrinkle","uv_protection"]` 화장품 트리플 잔존(new-run.sh:67-69 는 a08f9c0 에서 `[]` 소거) — **intake 런과 new-run 런의 초기 state 가 달라지는 실동작 차이** | **I-1 (즉시, 2부 편입)** |
| H-2 | `scripts/lib/common.sh:682` ↔ `scripts/lib/image_engine.py:640` | 규제 도메인 정책 집합 `{"drug","quasi_drug","health_food"}` 가 셸·파이썬 각자 정의(공통 출처 없음). 도메인 추가 시 둘 다 기억해야 함 | K-1 (장기적으로는 domain.json 속성화 = 팩 소유가 정답이나 2부 범위 밖 — 우선 정의 1곳화) |
| H-3 | `common.sh` stage_phase case(:353-359) · `kcia-check.sh:36-42` · `next-action.sh:32` | **페이즈↔스테이지 이름 맵 3벌**(정방향 1 + 역방향 2). 단계 순서·반복상한은 `harness/pipeline-routes.json` 단일 출처(양호, 재검증)지만 이름 맵은 각자 하드코딩 | K-2 |
| H-4 | 7묶음(아래 2-3 표) | **env 기본값·정책값의 셸/파이썬 이중 정의** — 드리프트 위험 | K-1 |
| H-5 | `golden_runner.py:23-27`(MIN_REVISE=10·MIN_PASS=5·min_detect=0.8·max_fp=0.15) · `image_engine.py:542`(종횡비 0.1~10)·`:571`(1% 허용) · `run-stage.sh:79`(raise-limit +2) 등 | env 불가 인라인 매직 넘버 8건 내외. 대부분 저위험이나 의미가 코드에만 있음 | K-1 (상수 명명·주석만 — 값 불변) |
| H-6 | `harness/reference-notes.schema.json:19`(아누아·메디힐 예시) · `skills/check-components/SKILL.md:7`(대웅배너) · `intake.sh:18`(ezderm 예시) · 한국어 도메인명 나열 usage/die 문구 다수 | **누출 grep 의 사각지대**: 정규식에 아누아·메디힐·ezderm 부재 + 스캔 범위가 `scripts/ prompts/ harness/` 뿐(skills/ tests/ 제외) | I-2 (정규식·범위 보강 — 2부 9단계 allowlist 소진과 조율) |
| H-7 | 셸 `die` 한국어 124건 등 operator_labels 밖 현업 노출 문구 | 대부분 **도메인-중립 커널 오류문**이라 팩 이관 대상 아님. 전면 중앙화는 실익 낮음(오류문은 발생 지점 근처가 유지보수 유리) — 도메인 어휘가 섞인 2건(`new-run.sh:39`·`ingest-bundle.sh:22` 의 도메인명 나열)만 `operator_labels.registered_domains_hint` 경유로 | I-1 에 편승(선택) |

### 2-3. env 기본값 이중 정의 7묶음 (H-4 상세)

| 값 | 정의 지점 | 비고 |
|---|---|---|
| `gemini-2.5-flash-image` | common.sh:667 · image_engine.py:27 · image_engine.py:756 | **3곳** — 모델 기본 변경 시 3곳 동기 필요 |
| `HARNESS_GEN_POLL` 기본 5 | common.sh:234 · obs.sh:79 | 2곳 |
| `HARNESS_GEN_HEARTBEAT` 기본 30 | common.sh:235 · obs.sh:79 | 2곳 |
| `multipage_bm` 포맷 폴백 | run-stage.sh:117 · stub_stage.py:44 + 파이썬 리더 6~7벌(3-2) | 셸+파이썬 산재 |
| `PACKS_DIR`/`FORMATS_DIR` 해석 | common.sh:10,13 + 파이썬 8곳 | kcia_engine.py:208 주석이 "common.sh 와 동일 — split-brain 방지"라고 위험을 자인 |
| nanobanana retry 리터럴 | image_engine.py:88-89 · :436-438 | 같은 파일 안 env 기본과 폴백 리터럴 중복 |
| 600초 상한 2종 | HARNESS_GEN_TIMEOUT(common.sh:233) · KCIA_CRITIC_TIMEOUT(obs.sh:76) | 다른 변수·같은 값 — 경합 문제는 1부 O-1 이 처방(호출 표면), 값 관계는 주석으로만 존재 |

---

## 3. 조사 결과 2 — 중복 구성

### 3-1. 셸 계층 (총 4,163줄)

| 중복 | 규모 | 처방 |
|---|---|---|
| **`build_context`(common.sh:413-739) 한 함수가 327줄 = 파일의 35.6%**, 내부에 인라인 파이썬 조각 10개 | 최대 단일 항목 | K-3: `lib/build_context.py` 이관(안전망 = 프롬프트 조립 골든) |
| **인라인 파이썬 약 55사이트**(heredoc 26 + `python -c` 30) — 특히 `validate-stage.sh` 한 파일에 14블록 | 셸 최다 밀도 | K-3: `lib/validate_stage.py` 모듈화 |
| **state.json 쓰기 heredoc 11벌**(new-run·intake·gate·advance-phase·run-stage·ingest-bundle 이 각자 load→변형→atomic_write 구현) | ~60-80줄 | K-2: gate.sh:26 `transition()` 을 common.sh 로 승격해 공용화 |
| **state 스캐폴딩 2벌**: new-run.sh:54-96 ≡ intake.sh:118-158 (42줄 heredoc, H-1 의 폴백 불일치가 여기서 발생) | ~40줄 | I-1(불일치 해소) + K-2(공용화) |
| sha256 인라인 4벌(kcia-check:241·intake:108·approve:65·validate-stage:199) / sensitive 승인수 3벌 / ra_reviewed 2벌 / deliverable_format 폴백 관용구 7벌 / claim-basis 재동기화 2벌(gate.sh:91 주석이 "ingest-bundle 과 동형"이라 자인) | ~30-40줄 | K-1·K-2 |
| kcia-check autopass writer 2벌(:132-157 review-exempt ≡ :169-194 placeholder) / `image_manifest_complete`↔`_incomplete` 반전 쌍(common.sh:886-918) / 생성 watchdog 2벌(run_llm ↔ obs_watch_pid — obs.sh:71 주석 자인) / 락 획득 댄스 9곳 / `advance-phase --render-only` 꼬리 6곳 | ~70줄 | K-2 |
| 죽은 함수: `domain_sources_dir`(common.sh:164-166, 호출 0) | 3줄 | I-3 |

셸 계층 회수 여지 추정: **약 550~650줄**.

### 3-2. 파이썬 계층 (lib 29개)

| 중복 | 규모 | 처방 |
|---|---|---|
| **ROOT 3단 dirname 재계산 11파일**(재검증) — harness.py 가 ROOT 를 export 하는데도 지역 재정의. harness.py 자체는 15파일이 import 중(load_json 등) | ~40줄+드리프트 | K-1: `from harness import ROOT` 일원화 |
| **원자적 쓰기 4벌**(stub_stage:44 fsync 없음 · ingest:70 있음 · image_engine:388 있음 · adk_critic:537 없음) — **fsync 유무 불일치** | 신뢰성 편차 | K-1: harness.atomic_write 계열로 통일 |
| deliverable_format 리더 6~7벌(check_canon_coverage 한 파일 안 2벌 포함, docstring 까지 복붙) | ~40줄 | K-1: `harness.run_format(rdir)` |
| 마이크로 헬퍼 복제: `_is_num` 5벌 · 경로안전 `_safe_token`/`_assert_under` 2쌍 · `_domain`/`_active_domain` 2벌 · html escape 2벌 · `_sha256_file` 2벌 · plan 블록 순회 5벌 | ~90-100줄 | K-1 |
| check_*.py 검증기 6파일의 main 스켈레톤·options_dir 유도 3벌 | ~60-90줄 | K-1(low priority) |
| ingest.py 섹션 파서 6개 동형 골격 | ~80줄 | 3단계(인입 팩화)와 같은 파일 — **2부 3단계 이후 K-1 에서** |

### 3-3. 스키마 계층

| 중복 | 처방 |
|---|---|
| 블록 type 16종 enum 이 storyline.schema ↔ plan-block.schema verbatim 2벌(+ stub_stage.CANON 파이썬 미러) | **2부 4단계가 해소 예정(캐논 단일화)** — 본 계획 비대상 |
| functional_status enum 3스키마+state 내부 4회 / reference_image_id 패턴 3벌 / regulatory_domain 패턴 4~5벌 / 공용 `common-defs.schema.json` 부재 | K-4: 파일 간 `$ref` 는 검증기 지원 확인 필요 → 안전한 대안 = **드리프트 감시 lint**(패턴 문자열 일치 단정을 test 로) |
| phase enum 3곳(state.schema:42 · pipeline-routes.schema:10,30 · phase-descriptors.schema:67) | 의도된 동결 계약(`route_assert_valid` 가 전이마다 3중 검증) — **비대상**(닫힘 유지가 1차 원칙) |

### 3-4. 테스트 계층

- `tests/lib.sh` 커버리지는 **양호**(재검증: test-*.sh 40개 중 39개 source, 예외 = test-core-domain-leak.sh 1개뿐).
- 남은 중복: lib.sh 내부 drive 드라이버 3벌(`drive_pipeline`·`drive_to_done`·`drive_format_pipeline`, ~50줄) · adk-mock 기동/종료 패턴 2벌(test-critic-fanout ↔ test-observability, lib.sh 밖) · 인라인 state 리더를 자체 정의한 테스트 다수(`jq_phase` 헬퍼 미사용). → K-5.

### 3-5. 사문·잔재

| 항목 | 실측 | 처방 |
|---|---|---|
| `core/.claude/settings.local.json` — 실체 없는 MCP enable(`kcia`,`openalex`; `.mcp.json` 레포 전무) | dangling | I-3 |
| 루트 `.claude/settings.local.json` — 폐기된 `KCIA_CRITIC_CMD` export allow 등 과거 세션 잔여 allowlist 9건 | 폐기 규약과 모순 | I-3 + L-2 |
| `verdict.schema.json` engine enum 의 `"mcp"` 잔존 | 동결 계약이라 축소는 신중 | 부록B 결정 M-4 |
| `domain.json` `critic_prompt`(5단계 실배선 예정)·`export_package` 필드(소비 0) | 계획 문서 기지 사실 | 비대상(2부) |

**중복 총량(3장 합): 약 1,000~1,200줄** — 파이프라인 코드(셸 4,163줄 + lib 파이썬)의 유의미한 비중이며, 실제 비용은 줄수보다 **"한 가지를 고치려면 몇 곳을 찾아야 하는가"**(드리프트 표면적)다.

---

## 4. 5레이어 점검 — 구성 여부와 트레이드오프 판정

| 레이어 | 모델의 요구 | 현 구현(실측) | 갭 | **판정** |
|---|---|---|---|---|
| **L1 Memory** | 기계 판별 가능한 산출물(코드·테스트·스키마·CI) + ADR 만 리포에. 서술 문서 최소화 | AGENTS.md 128줄 단일 수렴(체인: 루트→core→AGENTS) + ADR 실존(_archive/orchestration-architecture-decision.md) + 동결 스키마 33개 + CI 40스위트. **단, 대형 서술 SSoT 3종**(workflow-ssot 98KB · harness-design 90KB · pipeline-stage-definitions 53KB)과 살아있는 계획 문서 8개가 동반 갱신 대상 | 문서 체계가 기준 초과 — 갱신 비용의 주범(커밋 80%) | **구조 유지, 문서 다이어트(D-1)**. AGENTS.md 자체는 적정 규모 |
| **L2 Tools** | atomic·composable·well-described 도구 표면 | 현업 4동작 셸(run-stage/kcia-check/approve/revise/select) + 스킬 16개 = 편의 래퍼(1급 아님, sync-skills 로 생성). MCP 미사용은 의도적(심의 = 원격 ADK) | 실질 갭 없음. 잔재만(dangling MCP enable, verdict enum "mcp") | **변경 불필요, 잔재 정리(I-3)** |
| **L3 Permissions** | 프롬프트가 아닌 메커니즘(settings.json)으로 강제 | 커밋형 settings.json **부재**, deny 규칙 **0**, 세션 자동축적 allowlist 만(폐기 규약 모순 항목 포함). 실질 권한은 CLI 플래그 위임(`--permission-mode acceptEdits`·`--sandbox workspace-write`, common.sh:226-227) | **갭 실재** — 절대규칙 1("state.json 은 scripts 만 쓴다")이 규약+테스트로만 방어되고 세션 에이전트의 직접 편집을 막는 메커니즘이 없음 | **부분 채택(L-2)**: 커밋형 `.claude/settings.json` + deny 최소셋(state.json 편집 거부). Claude 측 2차 방어막으로 자리매김(1급 통제는 여전히 scripts — AGENTS 금지 목록에 settings 는 없어 이식성 원칙 비저촉, Codex 는 sandbox 가 담당) |
| **L4 Hooks** | PreToolUse/PostToolUse 로 품질 게이트를 결정론 강제 | **의도적 비구성**(AGENTS 절대규칙 3 명시 금지 + ADR). 대신 결정론 게이트가 실행 경로 자체에 내장: validate-stage(스키마·금지표현) · kcia-check(심의 게이트·ADK resolve 분기) · gate/advance-phase(전이 강제, 승인 우회 차단) · run-stage preflight 10여 종(fail-closed) · check_*.py 6종 · image_preflight(비용 앞 결손 점검) | hooks 가 주는 것 중 "세션 내 모든 툴콜 개입"만 미충족 | **도입하지 않음(현행 유지)**. 얻는 것(툴콜 시점 개입) < 잃는 것(Codex 이식성 파괴 = 절대규칙 3 위반, 게이트 로직 이원화, hooks 미발동 환경이 2급으로 전락, 오프라인 CI 결정성에 새 변수). 전이가 scripts 로만 가능한 현 구조에서 게이트는 이미 우회 불가 — 남는 구멍(게이트 사이 산출물 직접 조작)은 L-2 deny + 기존 재검증(autopass 직전 validate 등)으로 좁힘 |
| **L5 Observability** | 실행마다 모델/프롬프트/도구 버전·유효 권한·승인/실패/복구를 기록한 운영 기록 | run-local 관측은 강함: `.logs/timing.jsonl`(단계·엔진·소요·outcome, 1부 O-3 로 시작 레코드까지) + 생성/크리틱 캡처 로그 + verdict 관측 필드(critic_ran/critic_outcome/review_depth/critic_engine) + state.history[].verdict_id 역참조 | **모델명·프롬프트 버전(해시)·git sha·유효 플래그 스냅샷 전면 미기록**(스키마 재검증) — 재현성 앵커가 골든 바이트에만 의존, "이 산출물을 무엇이 만들었나"를 사후 감사할 수 없음 | **채택(L-1)**: 런/생성/심의 시점 provenance 기록. `.logs` 는 골든 제외 경로라 **골든 바이트 무영향**·이식성 무저촉. 규제 도메인 특성(감사 추적)과 정합 — 이득/비용 비율 최고 |

**종합:** 5레이어 모델을 "그 모델의 표준 메커니즘(hooks·settings·MCP)을 썼는가"로 읽으면 이 레포는 L3~L5 미구성이지만, **모델의 목적("메커니즘으로 강제")으로 읽으면 L1·L2·L4 는 이미 다른 수단으로 충족**돼 있고 그 수단이 이식성(두 CLI)·결정성(오프라인 골든)이라는 이 레포 고유 제약에 더 적합하다. 따라서 레이어 재구성은 손해이고, **진짜 갭은 L3 의 2차 방어막과 L5 의 실행 주체 메타 2건**뿐이다.

---

## 5. 변경 비용 실측 — 무엇이 기계로 잡히고 무엇이 사람 기억인가

시나리오별 "실제 손대야 하는 파일"(배선 추적 실측):

| 시나리오 | 실질 파일 수 | 기계가 잡아줌(CI 빨개짐) | **사람이 기억해야 함(조용히 지나감)** |
|---|---|---|---|
| S1 새 도메인 팩 활성화 | **core 코드 0** + 팩 2~3 + docs 3 | ruleset 부재·status(pack-lint) | AGENTS 8번 절, workflow-ssot, (.env) |
| S2 파이프라인 단계 추가 | **40+** (닫힌 스키마 3 + routes/descriptors + 스테이지 맵 6곳 + 신규 prompt/skill + 골든 2 + 파이프라인 구동 테스트 ~19-28 + docs 5) | 스키마·라우트(route_assert_valid)·test-routes·골든 | **format-profiles active_phases(누락 = 조용한 스킵)** · **validate-stage TARGETS 기본 `*)` = 조용한 통과** · run-ci.sh TESTS 등록 · docs 5개 |
| S3 현업 라벨 1개 변경 | 1~2 | 금지토큰 누수만(test-operator-language) | operator-voice.md 문자열 복제분 동기(**이미 드리프트 실존** — line 40 등) |
| S4 env 노브 추가 | 코드 1 + 문서 3~5 | 코드 1곳(기능 테스트 있을 때만) | **AGENTS 2번 절·workflow-ssot·.env.example·deployment 전부 사람 기억**(.env.example 에 HARNESS_GEN_TIMEOUT 부재 = 관례 비일관의 실증) |
| S5 산출물 필드 추가 | 1(순수 optional)~5 | 스키마(additionalProperties:false)·골든 2 | 프롬프트 유도문 |

**진단:** 마이크로커널화 덕에 S1·S3·S5 의 core 비용은 이미 0~1파일로 억제돼 있다(2부 방향이 옳다는 실증). 남은 비용의 정체는 ① S2 류 팬아웃(단, 단계 추가는 저빈도 — 7장 참조) ② **모든 시나리오에 공통인 문서 동기 = 100% 사람 기억** ③ 조용한 스킵 2곳 ④ 커밋당 CI 26분이다.

---

## 6. 실행 계획

### 공통 원칙

1. **2부(팩 분리)와의 간섭 회피가 최우선.** 본체(K·D)는 **2부 1차 완료(9단계 병합) 후** 착수. 선행은 I·L·C 트랙만(2부가 만지는 파일과 무접촉이거나 2부 트랙에 편입).
2. ops-and-pack 계획의 규율 승계: 값 불변("옮기기만") · 이동/배선 커밋 분리 · 골든 증명(스텁 2종 + 프롬프트 조립 + 심의 골든셋) · 항목 커밋 시 전체 CI · workflow-ssot 동반 갱신.
3. 모든 K 항목의 완료 판정 = **동작 불변(골든 바이트 동일)** + 중복 정의 지점 수 감소를 커밋 메시지에 명기.

### I 트랙 — 즉시 (2부 진행 중에도 안전)

- **I-1. intake.sh 1단계 잔무 소거(H-1)**: 별칭 case → `domain_alias_resolve`/`format_alias_resolve` 질의, cats 폴백 → new-run 과 동일(`[]`). 성격상 **2부 1단계의 후속 커밋** — 현재 2부를 진행 중인 트랙에 편입해 처리한다(같은 파일을 두 트랙이 만지지 않도록). 검증: `tests/test-intake.sh` + 전체 CI.
- **I-2. 누출 감지망 사각 보강(H-6)**: `test-core-domain-leak.sh` 정규식에 아누아·메디힐·ezderm 추가 + 스캔 범위에 `skills/` 포함, `reference-notes.schema.json` 예시 일반화. ⚠ allowlist 점감(2부 각 단계)과 맞물리므로 **2부 담당과 조율 후**(신규 히트는 allowlist 등재로 시작).
- **I-3. 잔재 정리**: `core/.claude/settings.local.json` dangling MCP enable 제거 · 루트 settings.local.json 의 폐기 `KCIA_CRITIC_CMD` allow 제거 · `common.sh domain_sources_dir`(호출 0) 제거. 코드 동작 무영향.

### L 트랙 — 레이어 갭 (즉시 가능, 2부 무접촉)

- **L-1. 실행 기록(provenance) 신설(L5 갭)**: `obs.sh` 확장 — 런 시작·생성·심의 시점에 `.logs/provenance.jsonl` 1줄 append: `{ts, step, engine, model(확인 가능 시), git_sha, prompts_sha256(테스트 골든의 해시 재사용), effective: {GEN_TIMEOUT, CRITIC_TIMEOUT, CLAUDE_FLAGS, IMAGE_CLI...}}`. `.logs` 는 골든 제외(baseline.py SKIP_PREFIX)라 **골든 바이트 무영향**. 검증: `test-observability.sh` 확장. run.md/현업 표면 비노출(내부 진단 전용).
- **L-2. 커밋형 권한 정책(L3 갭)** — 부록B M-2 확정 후: `.claude/settings.json`(커밋) 신설, deny 최소셋 = `runs/**/state.json` 에 대한 Edit/Write 거부(절대규칙 1 의 메커니즘화). allow 는 넣지 않는다(세션별 local 유지). Codex 비대칭은 문서에 명시(Codex 는 sandbox + test-b0 grep 이 기존 방어).

### C 트랙 — CI 비용 (계측 먼저)

- **C-1. 스위트별 소요 계측 + 타겟 매핑표**: run-ci 1회를 스위트별 `time` 으로 계측해 상위 병목 5개를 식별(추정 후보: test-clinical-chart 1,600줄·test-multiproduct-extraction 913줄·렌더 계열). 산출물 = "변경 파일 → 최소 타겟 테스트" 매핑표를 본 문서 부록에 추가(현행 규율 "반복 중 타겟만, 커밋 시 전체"의 실행을 돕는 표). **병렬화는 하지 않는다**(runs/ci-* 공유·전역 lock·결정성 — 부록B M-3 에서 재론 가능).

### K 트랙 — 커널 정리 (2부 1차 완료 후 착수)

> 근거: K 가 만지는 파일(ingest.py·stub_stage.py·kcia_engine.py·common.sh·validate-stage.sh·image_engine.py 등)의 대부분이 2부 3~9단계의 이동·배선 대상과 겹친다. 겹친 채 진행하면 "회귀 원인 판별 가능해야 한다"(커밋 분리 규율)가 깨진다.

- **K-1. 마이크로 헬퍼 일원화(값 불변)**: harness.py 로 승격 — `ROOT`(11벌) · packs/formats 경로(9곳) · `run_format`(7벌) · 원자적 쓰기(4벌, **fsync 있는 쪽으로 통일**) · `_is_num`(5벌) · sha256(파이썬 2벌+셸 4벌은 K-2) · escape·안전경로·도메인 리더(각 2벌) · `_REGULATED` 집합(H-2, 파이썬 1곳 정의 + 셸은 그 값을 질의). 커밋 단위 = 헬퍼별(원인 격리). 검증: 골든 2종 + 전체 CI.
- **K-2. 셸 상태·게이트 보일러 통합**: `transition()` 승격(state 쓰기 11벌 → 헬퍼) · 스캐폴딩 공용화(new-run≡intake) · autopass writer 2벌 통합 · watchdog 2벌 통합 · `with_lock` 헬퍼(락 댄스 9곳) · `image_manifest_*` 쌍 통합 · sha256 셸 4벌. 검증: test-gates·test-routes·test-b0 + 골든 + 전체 CI.
- **K-3. 대형 이관 2건(최대 항목·별도 브랜치)**: ① `build_context` → `lib/build_context.py`(안전망 = **프롬프트 조립 골든** — 2부 5단계와 같은 앵커이므로 5단계 완료 직후가 적기, 조립 결과 바이트 동일 증명) ② `validate-stage.sh` 인라인 파이썬 14블록 → `lib/validate_stage.py`(케이스 디스패치는 셸에 유지, 검증 본문만 이관).
- **K-4. 스키마 드리프트 감시**: 공용 `$defs` 파일화는 검증기의 파일 간 `$ref` 지원 확인 후에만. 안전한 기본 = **정합 lint 테스트 신설**(functional_status·reference_image_id·regulatory_domain 패턴 문자열이 스키마 간 일치하는지 단정) — 스키마 무수정, 드리프트만 차단.
- **K-5. 테스트 위생**: lib.sh drive 3벌 파라미터화 통합 · adk-mock 기동/종료 헬퍼 lib.sh 승격 · 인라인 state 리더 → `jq_phase` 유도. ⚠ 2부 8단계(팩별 테스트 선언)가 tests 를 재배치하므로 **8단계 완료 후**.

### D 트랙 — 문서 다이어트 (결정은 지금, 집행은 2부 9단계와 합류)

- **D-1. 동반 갱신 의무의 대상 축소 + 문서 역할 경계 재정의**: 실측(커밋 80% docs 동반, workflow-ssot 팬아웃 최고)의 처방.
  - 원칙: **"같은 사실은 한 문서에만"** — 동반 갱신 의무(AGENTS 4번 절)는 `workflow-ssot.md` 하나에만 유지(현행과 동일)하되, 나머지 대형 문서의 지위를 명시 강등해 갱신 의무에서 제외한다.
  - 후보(부록B M-1 로 확정): `pipeline-stage-definitions.md`·`harness-architecture.md`·`stage-contracts.md` → 헤더에 "참조 문서(스냅샷 — 갱신 의무 없음, 정본은 workflow-ssot)" 명기 또는 `_archive/` 이동. `canon-blocks.md` 는 2부 4단계가 canon.json 파생 문서로 대체 예정(그때 처리). `harness-design.md` 는 설계 사상 기록(ADR 성격)으로 유지하되 "현재 상태 서술" 구역만 제거.
  - 완료된 계획 문서는 **완료 즉시 `_archive/` 이동**을 규율화(현재 살아있는 계획 8개 중 다수가 완료분 — 에이전트가 낡은 계획을 동등 권위로 읽는 리스크 축소).
- **D-2(선택). 문서 동기 최소 기계화**: env 노브가 AGENTS 2번 절·.env.example 에 존재하는지 grep 하는 소형 정합 테스트 — S4 의 "전부 사람 기억"을 부분 기계화. 비용 대비 효과는 M-1 확정 후 재평가.

### 순서 요약

```
지금(2부 진행 중):   I-1(2부 트랙 편입) · I-2(조율 후) · I-3 · L-1 · [M-2 확정 시] L-2 · C-1(계측)
2부 1차 완료 후:     K-1 → K-2 → K-3 → K-4 → [8단계 후] K-5,  D-1(9단계 문서 검수와 합류)
3부(온보딩) 전:      K 트랙 완료가 이상적(온보딩 스캐폴더가 커널 헬퍼 위에 얹히므로) — 의무는 아님
```

---

## 7. 하지 않는 것 (명시적 비채택)

| 항목 | 이유 |
|---|---|
| hooks(PreToolUse/PostToolUse) 도입 | AGENTS 절대규칙 3 위반(이식성 — 두 CLI SSoT). 게이트는 이미 실행 경로에 내장돼 우회 불가. 4장 L4 판정 |
| MCP 재도입 / 프레임워크(LangGraph 등) 이식 | ADR 이 기각한 노선. 결정성(오프라인 골든)·이식성과 상충 |
| 단계 디스패치의 완전 선언화(S2 비용 40+ 의 근본 해소) | 단계 추가는 저빈도(파이프라인은 동결 계약, route-union 도 2차로 연기됨). 완전 데이터화의 비용(전면 재배선 + 골든 전체 재캡처 + 회귀 위험) > 이득. **국소 정리만**(H-3 이름 맵 3벌 통합은 K-2 에 포함) |
| 셸 die 문구 124건의 전면 중앙화 | 오류문은 발생 지점 근처가 유지보수 유리. 현업 노출 표면(run.md·next-action·timing)은 이미 operator_labels 로 SSoT — 실익 없음 |
| verdict.schema engine enum 정리("mcp" 제거 등) | 동결 계약 — 후방호환 확인 없이 축소 금지(부록B M-4) |
| CI 병렬화 | runs/ci-* 공유 + 전역 lock + 결정성 설계와 상충. C-1 계측 결과가 특정 스위트 병목을 가리키면 그 스위트만 최적화 |
| kcia 명명 중립화·export 경로 변경 | ops-and-pack 계획의 2차 이월 판정 승계 |

---

## 8. 완료 판정 (Definition of Done)

1. I-1: intake 런과 new-run 런의 초기 state 동일성(폴백 포함) 테스트 단정 추가 + 그린.
2. L-1: 실런 1회에서 provenance.jsonl 에 git sha·엔진·유효 플래그 기록 확인, 골든 2종 바이트 불변.
3. K-1~K-2: 3장 표의 중복 정의 지점 수가 각 항목 1곳으로 감소(커밋 메시지에 before/after 지점 수 명기), 골든 4종 + 전체 CI 그린.
4. K-3: 프롬프트 조립 골든 바이트 동일 + common.sh 줄수 900→600 이하.
5. D-1: 동반 갱신 의무 대상 = workflow-ssot 1개 문서로 명문화(AGENTS 4번 절 갱신), 강등 문서 전건 헤더 명기.
6. 전 트랙: 선재 실패 4건(critic-fanout drug ADK 3·b4 1) 외 CI 그린 유지.

---

## 부록A. 실측 수치 모음 (2026-07-07)

| 항목 | 수치 |
|---|---|
| 전체 CI 1회(40스위트 순차) | **25분 49초**(19:39:25→20:05:14), 실패 4 = 선재(critic-fanout 3·b4 1) |
| 최근 30커밋 평균 변경 파일 | 7.9개 (최대 68개 = c822d2a) |
| 최근 30커밋 중 docs 동반 커밋 | **24개(80%)** — workflow-ssot.md 8회 · AGENTS.md 4회 |
| 셸 계층 총량 | 4,163줄 (최대: common.sh 919 — 그중 build_context 327줄 = 35.6%) |
| 파이썬 lib | 29파일 (최대: ingest.py 2,147 · kcia_engine.py 1,397 · stub_stage.py 1,069) |
| 인라인 파이썬(셸 안) | 약 55사이트 (validate-stage.sh 단독 14블록) |
| 중복 회수 여지 | 셸 ~550-650줄 + 파이썬·스키마·테스트 ~430-550줄 ≈ **1,000-1,200줄** |
| 대형 서술 문서 | workflow-ssot 97.9KB · harness-design 90.2KB · pipeline-stage-definitions 52.6KB (+ 살아있는 계획 문서 8개, _archive 14개) |
| 변경 비용 시나리오 | S1 도메인 활성 = core 0파일 / S2 단계 추가 = 40+ / S3 라벨 = 1-2 / S4 env = 1+문서 3-5(전부 사람 기억) / S5 필드 = 1-5 |
| 문서 팬아웃(비아카이브) | 'kcia-check' 11개 문서 · '00g-guideline' 9개 · 'HARNESS_OFFLINE' 4개 |

> C-1 스위트별 실측·타겟 매핑표(c181284 스냅샷, 41스위트 23분 47초): [ci-cost-and-target-map.md](./ci-cost-and-target-map.md)
## 부록B. 열린 결정 (사람 확정 대기)

| # | 결정 | 선택지 | 권고 |
|---|---|---|---|
| M-1 | D-1 문서 강등 범위 | 강등 후보 각각: 참조 강등 / _archive 이동 / 현행 유지 | pipeline-stage-definitions·harness-architecture·stage-contracts = 참조 강등(헤더 명기), 완료 계획 문서 = _archive 이동 규율화 |
| M-2 | L-2 커밋형 `.claude/settings.json` 신설 | 신설(deny 최소셋) / 안 함 | **신설** — deny 는 `runs/**/state.json` 편집 거부 1건부터(절대규칙 1 의 메커니즘화). Claude 전용 2차 방어막임을 문서 명기 |
| M-3 | K 트랙 착수 시기 | 2부 1차 완료 후 일괄(권고) / 2부 단계 사이 삽입 | **완료 후 일괄** — 파일 겹침으로 회귀 원인 판별 규율이 깨지는 것 방지. 예외 = I 트랙 |
| M-4 | verdict.schema engine enum 의 "mcp" 등 잔재 정리 | 2차 배치(kcia 명명 중립화와 동행) / 지금 | **2차 배치 동행** — 동결 계약 단독 수정 금지 |

## 고지

본 계획은 법적 통과 보증 체계가 아니라 자율·비법적 사전 점검 하네스의 유지보수성 개선 계획이다. 최종 책임은 사람(현업/RA)에게 있다.
