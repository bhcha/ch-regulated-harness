# 기능 카탈로그 — 하네스 기능 인벤토리(정본)

> **이 문서의 지위:** 하네스가 가진 **기능(capability)의 단일 목록**이다. "어떤 기능이 있고, 어디(core/팩)에 어떤 파일로 구현돼 있고, 진입점은 무엇이며, 규제도메인(팩)에 얼마나 결합돼 있는가"를 한눈에 본다. 모듈화·리팩토링·신규 기능 배치의 기준표.
> **관계:** 규칙·안전 불변식 SSoT = [`../AGENTS.md`](../../core/AGENTS.md). 워크플로우(단계·입출력) 정본 = [`workflow-ssot.md`](workflow-ssot.md). 코드가 *실제로* 하는 현재상태 = 코드 자체(불일치 시 **코드 우선**). 도메인 데이터 SSoT = 형제 [`../../packs/<도메인>/`](../../packs/).
> **본문 원칙:** 본문은 **현재 존재하는 기능만** 담는다(변경 이력·"…였다가 …로" 서술 금지). 시간순 이력은 **git 이력에 맡긴다**(별도 history 파일을 만들지 않는다). 헤더에는 최신 갱신 날짜만 둔다.
> 작성 2026-07-10 · 최신 갱신 2026-07-18

> **유지보수(keep-in-sync) — 의무:** **기능을 새로 만들거나, 기존 기능을 바꾸거나, 없앨 때 같은 변경에서 이 문서의 해당 행을 갱신한다**(추가=행 추가, 변경=설명/결합 열 수정, 삭제=행 제거). 대상 = `core/scripts/*.sh`·`core/scripts/lib/*`(스크립트·모듈)와 그 진입점·환경변수 — **대응하는 `prompts/`·`skills/` 가 바뀌면 11절 동반물 매핑도 같이 갱신한다**. 이 의무는 `AGENTS.md` 4번 절 D-1 규칙이 명시한다. 이 문서가 코드와 어긋나면 인벤토리가 거짓이 된다.

---

## 읽는 법 — 도메인 결합(팩 종속) 표기

각 기능의 **규제도메인(팩) 결합도**를 4단계로 표기한다. 모듈화 시 이 열이 "떼어내기 얼마나 깨끗한가"를 알려준다.

| 표기 | 뜻 | 모듈화 관점 |
|---|---|---|
| 🟢 **무관** | 팩/도메인 지식 0. 규제 지식 없이 동작하는 순수 기계. | 독립 모듈 후보(깨끗) |
| 🟡 **팩값** | 팩 데이터를 **입력으로 읽지만** 로직은 도메인-중립. | 팩 입력만 파라미터화하면 분리 가능(얇은 seam) |
| 🔴 **규제코어** | 도메인 심의/레지스트리/캐논 **그 자체**. 팩에 강결합. | 분리 대상 아님(팩과 한 몸) |
| ⚙️ **공용인프라** | 팩 레이아웃을 아는 토대 lib(다른 기능이 딛는 바닥). | 분리보다 안정화 대상 |

> 결합 표기의 근거 = 각 파일의 팩 결합 신호(`PACKS_DIR`·`packs/`·`ruleset`·`load_domain`·`domain.json`) 스캔 + 파일 역할. **최종 권위는 코드다** — 표기와 코드가 어긋나면 코드가 맞다. 팩 자체는 **순수 데이터**(json·md·이미지·csv)이며 실행코드가 없다 — 모든 로직은 core 소유.

---

## 1. 생성 엔진 — 직교 3축(텍스트·이미지·근거)

세 축은 서로 독립(`HARNESS_CLI` / `HARNESS_IMAGE_CLI` / `HARNESS_EVIDENCE_CLI`). 각 축은 오프라인=결정적 stub, 온라인=실엔진 강제.

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 텍스트 생성(세션내/subprocess) | `run-stage.sh` · `HARNESS_CLI`·`HARNESS_GEN_MODE` | `scripts/run-stage.sh` · `scripts/lib/spawn_session.py` | 세션내 에이전트가 산출물 작성 → 스크립트가 검증·전이. 세션 spawn+watchdog(행/좀비 회수). | 🟢 |
| 생성 컨텍스트 조립 | (run-stage 내부) | `scripts/lib/build_context.py` | 룰셋·레퍼런스 노트·voc 를 LLM 프롬프트 컨텍스트로 조립(도메인별 주입). **`DOMAIN_GEN_RULES`**(팩 `gen-fragment.md` 도메인 생성 규칙 선주입, Seam B) · **`LEARNED_DENY`**(팩 `learned/deny.json` 학습 금지어 생성 선차단, Seam F) 포함(부재=no-op·ctx 골든 불변). | 🟡 |
| **이미지 생성(Nano Banana)** | `gen-images.sh` · `run-stage.sh`(keyvisual) · `render-design.sh` · `HARNESS_IMAGE_CLI` | `scripts/lib/image_engine.py` | Gemini 2.5 Flash Image REST 실호출·프롬프트 빌드·PNG 파싱/검증·aspect 정규화·429 백오프/강등·stub SVG. **팩 결합=`no_graphic_generation` boolean 1개(`_domain_no_graphic`)뿐.** | 🟡 |
| 이미지 생성전 최종점검 | (run-stage keyvisual 직전) | `scripts/lib/image_preflight.py` | 비용/비가역 단계 앞 결손 digest(읽기전용, state 미기록). | 🟢 |
| **근거 검색(OpenAlex)** | `run-stage.sh`(온라인) · `HARNESS_EVIDENCE_CLI` | `scripts/lib/openalex.py` · `scripts/lib/evidence_search.py` | OpenAlex 직접 HTTP(MCP 아님, stdlib urllib) 논문검색·인용수 grade·초록 재구성 + 트리거 감지 배선. **팩 결합 0**(검색 grade ≠ 룰셋 evidence_grade). | 🟢 |
| 엔진 선택 게이트 | (모든 축 공통) | `scripts/lib/common.sh` `resolve_{image,evidence}_engine` | 오프라인=stub·온라인=실엔진 강제. 이미지는 키 없으면 fail-closed, 근거는 키 불필요(무료). | 🟢 |

## 2. 파이프라인 오케스트레이션 — 상태·게이트·전이

`state.json` 은 오직 스크립트만 쓴다(절대 규칙 1번).

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 단계 실행기(1급 경로) | `bash scripts/run-stage.sh <stage> <id>` | `scripts/run-stage.sh` | 생성→검증→전이 오케스트레이션. 슬래시 비의존. | 🟢 |
| 게이트 전이 | (내부) | `scripts/gate.sh` | verdict/decision 을 읽어 state 를 결정론적으로 전이. | 🟢 |
| 페이즈 전이 | (내부) | `scripts/advance-phase.sh` | 페이즈 전이 + run.md 재생성. | 🟢 |
| 런 스캐폴딩 | `bash scripts/new-run.sh <id> "제품명" <유형> <도메인>` | `scripts/new-run.sh` | state.json 생성(안전 기본값: 근거 없는 효능=unknown/[]). 도메인 선언·레지스트리 검증. | 🟡 |
| 상태→구조화 JSON | (내부/Slack 어댑터) | `scripts/next-action.sh` | state → 버튼/carousel 렌더용 단일 SSoT. | 🟢 |
| AG-UI 이벤트 투영(방출·재생) | (전이 시 자동 방출) `scripts/lib/common.sh agui_emit` · 재생 `bash scripts/agui-events.sh <id>` | `scripts/agui-events.sh` · `scripts/lib/agui_events.py` | state.json 파생 뷰를 AG-UI 이벤트(RunStarted·StepStarted·StepFinished·StateSnapshot·StateDelta·RunFinished·RunError·Custom)로 `runs/<id>/.events/agui.jsonl` 에 append(항상·best-effort·실패 무시로 파이프라인 비차단·state 미기록·`.events` 골든 제외). 재생은 읽기전용 스트림. | 🟢 |
| A2UI 선택지 표면 | `bash scripts/a2ui-surface.sh <id>` | `scripts/a2ui-surface.sh` · `scripts/lib/a2ui_surface.py` | 현재 게이트의 선택/승인 화면을 A2UI(선언형 UI) JSON 으로 파생(next-action.sh 와 동일 render_runmd 헬퍼 → run.md·next-action·a2ui 세 표면 정합·읽기전용·state 미기록). | 🟢 |
| A2UI 액션 브리지 | `bash scripts/a2ui-action.sh <id> <event>` | `scripts/a2ui-action.sh` · `scripts/lib/a2ui_action.py` | A2UI named action(select/approve/revise/raise-limit)을 검증해 현업 4동작 스크립트로 위임(`--`-플래그 주입 차단·`ra_ok:true` 일 때만 `--ra-ok` 전달·state 미기록·위임 스크립트만 상태 변이). | 🟢 |
| 진행 보드 | `runs/<id>/run.md` 열람 | `scripts/lib/render_runmd.py` | "지금 할 일/다음 명령" 자동 생성. | 🟢 |
| 실행 리포트(F-3) | `bash scripts/run-report.sh <id>` | `scripts/run-report.sh` | 단계별 [선택·규정 점검·반복·소요]를 산출물에서 읽기전용 조립(수기 GENERATION-LOG 대체). state 불가침. | 🟢 |
| 다안 옵션 파생 MD | (내부) | `scripts/lib/render_options_md.py` | select 페이즈 옵션 JSON → 사람용 비교 MD. | 🟢 |

## 3. 현업 4동작 (JSON 손편집 대체)

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 승인 | `bash scripts/approve.sh <id>` | `scripts/approve.sh` | 현업 승인 + 민감표현 RA 게이트. | 🟢 |
| 보완요청(재생성) | `bash scripts/revise.sh <id> [...]` | `scripts/revise.sh` | 자유텍스트 ISSUE → feedback.json → 재생성 루프. | 🟢 |
| 선택 | `bash scripts/select.sh <id> [...]` | `scripts/select.sh` | multi-option 선택 기록(decision.json). | 🟢 |

## 4. 인입 / 컨텍스트

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 첨부 정문(00a-intake) | `bash scripts/intake.sh <폴더> <id> ...` | `scripts/intake.sh` | 첨부 폴더 스냅샷(불변 보존·sha256)·zip 해체·분류/라우팅(opt-in). | 🟢 |
| 번들 정규화(00-ingest) | `bash scripts/ingest.sh` → `ingest-bundle.sh` | `scripts/ingest-bundle.sh` · `scripts/lib/ingest.py` | 크롤/씨앗 번들을 voc·claim-basis·assets 로 결정적 정규화(no-LLM). 도메인별 ingest-profile 적용. | 🟡 |
| 사례 분석 | (00g-guideline) | `scripts/lib/examples_analysis.py` | 수집 사례 "왜 좋은가" 결정적 분석 + 가이드라인 종합. | 🟡 |
| 결손 권고 | (내부, 읽기전용) | `scripts/lib/completeness_advisor.py` | 결손값 권고 단일 계산(preflight·run.md digest 소비). | 🟡 |

## 5. 심의 — 규제 코어(생성≠심의 격리)

운영 심의 엔진 = 원격 ADK(`adk-http`) 단일·도메인별 엔드포인트. 미구현 도메인은 룰엔진-단독 가시화.

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 심의 게이트 | `bash scripts/kcia-check.sh <id>` | `scripts/kcia-check.sh` | ADK 가용성 분기·scratch/baseline 무결성·placeholder-autopass·review-exempt-autopass. | 🔴 |
| 결정적 룰엔진 | (내부) | `scripts/lib/kcia_engine.py` | 룰셋 4축 심의 + evidence 존재성 검증 + 레지스트리 로드. **학습 금지어 결정 집행(⑦ `learned_deny`, Seam F, 부재=no-op)** 포함. | 🔴 |
| 정량 수치 근거 결박(B-4) | (내부, 03-storyboard 검증) | `scripts/lib/validate_storyboard.py` | 비차트 측정·설문 수치(점·㎟…)를 voc·claim-basis evidence 유도로 강제(승인 밖 수치 차단, Seam A). | 🟡 |
| **학습 루프(Seam F)** | `/learn-analyze <도메인>` → `scripts/lib/analyze_learnings.py`(읽기전용 분석) → `scripts/apply-learnings.sh`(사람 승인분 팩 기록) | 위 + `skills/learn-analyze/` | 심의 반려·선택이 런 넘어 축적 → 일관 반려(독립 K런)·비보편어·비핑퐁 후보 → **사람 승인** 승격 → `packs/<도메인>/learned/deny.json`(스키마 `learned-lexicon`)·`common-terms.json`(보편어 가드). 생성 선차단+룰엔진 집행 이중. 자동 승격 없음. | 🟡 |
| 2-pass 병합 | (내부) | `scripts/lib/kcia_merge.py` | 건별 적대검증 2-pass 심의 병합. | 🔴 |
| 원격 ADK 어댑터 | (내부) | `scripts/lib/adk_critic.py` | GCP guideline_agent 원격 심의 호출·resolve·watchdog. | 🔴 |
| 심의 골든셋 회귀 | (CI) | `scripts/lib/golden_runner.py` | 심의 판정 골든 회귀. | 🔴 |

## 6. 검증 / 린트

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 산출물 스키마 검증 | (run-stage 내부) | `scripts/validate-stage.sh` · `scripts/lib/validate_stage.py` | 산출물 JSON 을 harness/*.schema.json 로 검증(친절한 반려). | 🟢 |
| 스토리보드 의미검증 | (내부) | `scripts/lib/validate_storyboard.py` | enabled_if·캐논 강제. | 🟡 |
| 구성요소 커버리지 | `bash scripts/check-components.sh` | `scripts/check-components.sh` · `scripts/lib/check_canon_coverage.py` | 상세페이지 주요 구성요소 커버리지 검사. | 🟡 |
| HTML 금지블록 스캔 | (내부) | `scripts/lib/check_html_blocks.py` | 포맷 금지 블록(data-block) 결정적 차단. | 🟡 |
| 이미지 픽셀 금지어 | (내부) | `scripts/lib/image_ocr_scan.py` | 생성 이미지 픽셀-텍스트 금지어 스캔(NARROW). | 🟡 |
| 자산 경로 안전성 | (내부) | `scripts/lib/check_asset_paths.py` | 저작권 traversal 우회 차단. | 🟢 |
| 렌더 참조 검사 | (내부) | `scripts/lib/check_render_refs.py` | 키비주얼이 참조하는 생성 이미지 존재 검사. | 🟢 |
| beforeAfter 디스클레이머 | (내부) | `scripts/lib/check_beforeafter.py` | '연출/개인차' 디스클레이머 강제. | 🟢 |
| 근거 반영 done 게이트 | (내부) | `scripts/lib/check_evidence_reflection.py` | 참조 문서 반영 강제(반영 0 done 차단). | 🟢 |
| 이미지 출처 allowlist | (render 내부) | `scripts/lib/img_lint.py` | 디자인 이미지 출처 allowlist(저작권). | 🟢 |
| 추출 정확도 | (내부) | `scripts/lib/extract_accuracy.py` | claim-basis 추출 정확도 게이트. | 🟢 |
| 팩 무결성 린트 | `bash scripts/pack-lint.sh` | `scripts/pack-lint.sh` · `scripts/lib/pack_lint.py` | packs/<도메인>/ 팩 무결성 검사(산출물 바이트 무영향). | 🔴 |

## 7. 렌더링 / 출력

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 로컬 Playwright 렌더 | `bash scripts/render-design.sh <id>` | `scripts/render-design.sh` · `scripts/lib/render.py` | HTML 렌더 + DOM 요소 단위 섹션 PNG 분할 + 저작권 lint. | 🟢 |
| 임상 차트 도출 | (내부) | `scripts/lib/clinical_chart.py` | 인체적용시험 차트 결정적 도출 단일 출처. | 🟢 |
| 제출 패키지 | (내부) | `scripts/lib/export_package.py` | 협회 광고자문 제출 패키지 생성. | 🟢 |

## 8. 관측성 / 운영자 언어

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 타이밍 요약 | `bash scripts/timing.sh <id>` | `scripts/timing.sh` · `scripts/lib/obs.sh` | 단계별 소요시간(timing.jsonl → 평이 표) + 생성/심의 watchdog·캡처. | 🟢 |
| 평이 라벨 단일출처 | (공유 import) | `scripts/lib/operator_labels.py` | 현업 화면용 평이 라벨/번역표 단일 사전(도메인 라벨 포함). | 🟡 |

## 9. 공용 인프라 / 토대

| 기능 | 진입점 | 구현 | 한 줄 설명 | 결합 |
|---|---|---|---|---|
| 결정적 코어 라이브러리 | (전 모듈 import) | `scripts/lib/harness.py` | atomic write·load_json·경로 상수(ROOT/PACKS_DIR)·레지스트리 로더(no-LLM). | ⚙️ |
| 셸 공용 | (전 스크립트 source) | `scripts/lib/common.sh` | 락·die·도메인 필드·엔진 선택 등 셸 공용 함수. | ⚙️ |
| 제형 정규화 | (내부) | `scripts/lib/form_factor.py` | 제품 형태(제형/용기) 정규화 — `packs/<domain>/ingest-profile.json` 의 `form_factors` 표를 읽어 first-match(이미지 프롬프트 제형 결박에 주입). | 🟡 |
| 오프라인 stub 생성 | (STUB_MODE) | `scripts/lib/stub_stage.py` | 결정적 단계 생성기(오프라인/CI 경로). 도메인별 stub 템플릿. | 🟡 |
| 마이그레이션 안전망 | (CI) | `scripts/lib/baseline.py` | 바이트 골든 + structdiff 골든 회귀. | ⚙️ |
| 골든 픽스처 생성 | `bash scripts/build-fixtures.sh` | `scripts/build-fixtures.sh` | 단계 경계 골든 핸드오프 픽스처(결정적 stub). | 🟢 |
| 스킬 배포 | `bash scripts/sync-skills.sh` | `scripts/sync-skills.sh` | skills/ 원본 → Claude 슬래시(`.claude/commands`) 단일 배포. | 🟢 |
| **PreToolUse 경화 훅(비-load-bearing)** | (Claude Code 세션이 Write/Edit 직전 자동 호출 · 배선 = 레포 루트 `.claude/settings.json`) | `scripts/hooks/deny-state-writes.sh` | 런 `state.json`·`.logs/` 직접 Write/Edit 을 도구 레벨에서 거부(종료 2 + 평이 한국어 교정 사유). 스크립트는 Bash 로 상태를 쓰므로 정당 작업 무영향. Bash 명령 문자열 파싱은 하지 않고, 깨진 이벤트/`file_path` 부재는 허용(fail-open). **게이트를 대체하지 않는 경화 계층** — 파일을 지워도 판정·fail-closed 불변(판정 SSoT = 셸 게이트, AGENTS 규칙 3). | 🟢 |

## 10. 팩 (데이터 SSoT — 로직 아님)

`packs/<도메인>/`(cosmetic·drug·health_food·quasi_drug)와 `packs/_format/` 은 **순수 데이터**다 — `domain.json`(레지스트리 엔트리)·`ruleset.json`·`sources/`·`golden/`·`fixtures/`·`canon.json`. 실행코드가 없으며 위 core 기능들이 이 데이터를 읽는다. 새 도메인 = 팩 폴더 추가(레지스트리 자동 조립) + 진입 게이트(new-run·state.schema enum) 통제 추가.

## 11. 기능 동반물 매핑 — 모듈 경계

위 1~10절은 각 기능의 **로직 파일**만 잡는다. 하지만 기능을 모듈로 떼어낼 때 실제로 함께 옮기는 경계는 **로직 + 프롬프트 + 스킬(진입) + 계약 스키마 + 가드 테스트 + env** 다. 이 표는 "한 기능을 옮길 때 무엇을 함께 옮기나"를 파이프라인 단계(핵심 기능) 단위로 한눈에 보여준다. 스키마 계약은 `harness/*.schema.json`(6번 절 검증 대상), **env 동반물은 [`config-reference.md`](config-reference.md)** 를 가리킨다(여기 표에는 넣지 않는다). 없는 동반물 칸은 `—`.

**볼드 2행 = 도메인-무관(🟢) 헤드라인 기능** — 규제 지식 없이 그 자체로 떼어 쓸 수 있는 순수 기계(근거검색·이미지생성).

| 기능(파이프라인 단계/핵심) | 로직(scripts·lib) | 프롬프트(prompts/) | 스킬/커맨드(skills/) | 계약 스키마(harness/) | 가드 테스트(tests/) |
|---|---|---|---|---|---|
| 첨부 인입(00a-intake) | `intake.sh` | `intake.md` | `intake` | `intake-proposal` | `test-intake`·`test-runmd-intake`·`test-intake-enrich` |
| 번들 인입(00-ingest) | `ingest.sh`·`ingest-bundle.sh`·`lib/ingest.py` | — (no-LLM 결정적) | — | `voc`·`claim-basis`·`assets-manifest`·`best-practices` | `test-b1`·`test-relief-facts`·`test-multiproduct-extraction` |
| **근거검색(00e-evidence · OpenAlex)** | `lib/openalex.py`·`lib/evidence_search.py`(+`lib/check_evidence_reflection.py`) | `evidence.md` | `evidence` | `results`·`evidence-documents`·`evidence-index`·`reflection-proposal` | `test-openalex`·`test-evidence-attachment`·`test-evidence-reflection`·`test-b1e` |
| 가이드라인(00g-guideline) | `lib/examples_analysis.py` | `guideline.md` | `guideline` | `reference-notes`·`example-analysis` | `test-b1g`·`test-examples-analysis` |
| 브리프(01-brief) | (공통 `run-stage.sh`·`lib/build_context.py`) | `brief.md` | `brief` | `brief` | `stage-brief` |
| 컨셉(02-concept) | (공통 `run-stage.sh`) | `concept.md` | `concept` | `concept-axes`·`rtb`·`key-message` | `stage-concept`·`test-b2` |
| 스토리보드 아웃라인(03-storyboard) | `lib/validate_storyboard.py` | `storyboard-outline.md` | `storyboard-outline` | `storyline`·`tone-direction`·`tone-directions` | `stage-conti`·`test-b4` |
| 스토리보드 기획안(03-storyboard) | `lib/validate_storyboard.py` | `storyboard-plan.md` | `storyboard-plan` | `plan-block`·`art-direction` | `stage-conti`·`test-b4` |
| **키비주얼/이미지생성(04-keyvisual · Nano Banana)** | `lib/image_engine.py`(+`lib/image_preflight.py`) | `keyvisual.md` | `keyvisual`·`gen-images` | `image-asset`·`design-manifest` | `test-image-engine`·`test-gen-image-completeness`·`test-image-rebake`·`test-ocr-compliance`·`stage-keyvisual` |
| 심의(kcia-check) | `kcia-check.sh`·`lib/kcia_engine.py`·`lib/kcia_merge.py`·`lib/adk_critic.py` | `kcia-critic.md` | `kcia-check` | `verdict`·`ruleset` | `test-b3`·`test-critic-fanout`·`test-gen-not-review-isolation`·`test-drug-golden` |
| 구성요소 커버리지(check-components) | `check-components.sh`·`lib/check_canon_coverage.py` | — | `check-components` | `canon-coverage` | `test-components` |
| 현업 4동작(approve/revise/select) | `approve.sh`·`revise.sh`·`select.sh` | `operator-voice.md` | `approve`·`revise`·`select` | `decision`·`feedback` | `test-gates` |
| AG-UI·A2UI 투영(관측·선택지 표면) | `agui-events.sh`·`a2ui-surface.sh`·`a2ui-action.sh`·`lib/agui_events.py`·`lib/a2ui_surface.py`·`lib/a2ui_action.py`(+`common.sh agui_emit` 전이 방출) | `operator-voice.md`(surface→AskUserQuestion→action 브리지 화법) | `select`·`approve`·`revise`(surface/action 브리지 안내) | `agui-projection`(이벤트 한 줄 검증 스키마) + `a2ui-catalog`(A2UI v0.9.1 카탈로그 — 스키마 아닌 데이터) | `test-agui-contracts`·`test-agui-projection`·`test-a2ui-surface`·`test-a2ui-action` |
| 렌더링(render-design) | `render-design.sh`·`lib/render.py` | — | — | — | `test-render-mode-gate`·`test-render-existence-depth` |
| PreToolUse 경화 훅(상태 직접쓰기 거부) | `scripts/hooks/deny-state-writes.sh` | — | — (스킬 아님. 배선 = 레포 루트 `.claude/settings.json` `hooks.PreToolUse` matcher `Write\|Edit`) | — | `test-hook-deny`(좁은 deny 판정·fail-open·교정 문구 + **게이트가 훅을 참조하지 않음** = 비-load-bearing 증명) |
| 문서 무결성 / D-1 정본 거버넌스 | — | — | — | — | `test-docs-integrity`(살아있는 문서 링크 해소[README·AGENTS·canonical·plans·reference 포함, _archive/history/snapshots 제외]·plans 등재·정본 5종 존재·파이프라인 소비경로[regulation/·design-tokens·canon-blocks] 고정) · `test-b0` 의 (d) 블록이 skills↔`.claude/commands` 드리프트를 내용 비교(비변조)로 실패로 잡음(조용한 덮어쓰기 금지) |

> **노트:** 동반물이 없는 기능(순수 검증/렌더 유틸, 공용 인프라 lib 등 — 6·7·9절의 대부분)은 **로직만 이동**한다(프롬프트·스킬·전용 스키마·전용 테스트 없음). 위 표는 파이프라인 단계/핵심 기능 단위라 전체 스키마(예 `phase-descriptors`·`pipeline-routes`·`state`·`golden-set`·`recommendation`)나 단계-비종속 스킬(예 `status`)까지 망라하지 않는다 — 이들은 여러 기능이 공유하는 토대다. **env 동반물은 표에 넣지 않고 [`config-reference.md`](config-reference.md) 를 참조**한다.
