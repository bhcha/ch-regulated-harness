# 메타프롬프트 — pack-refactor 0단계 마무리 → 1차 1단계 (fresh session)

> 세션 클리어 후 이 파일을 첫 메시지로 붙여넣거나 "core/docs/pack-refactor-resume-2-stage1.md 읽고 이어서" 라고 지시.
> 작성 2026-07-04 (직전 세션 핸드오프). 실행 계획 SSoT = `core/docs/pack-refactor-plan.md`. 규칙 SSoT = `core/AGENTS.md`.

## 리포지토리 / 브랜치
`/Users/chabh/workspace/ch-regulated-harness` · 운영 루트 = `core/` · **작업 브랜치 `refactor/pack-stage0-tools`**(main 아님, 이어서 이 브랜치에서).
`.env` 는 **repo 루트**(`../.env`, core 기준)에 있고 ADK_COSMETICS_/ADK_DRUG_ CRITIC_URL 키를 보유(온라인 심의 가능).

## 이미 완료·커밋됨 — 다시 하지 말 것 (0단계 증명 도구 S1~S7)
브랜치 `refactor/pack-stage0-tools` 의 `main..HEAD` 커밋:
- `14d93a2` docs: 부록C 4결정 확정 기록 + 완료표시
- `34ab883` S1: 합성 화장품 번들 fixture(`tests/fixtures/bundle-cosmetic/`, `.gitattributes` LF·바이너리 고정) — **⚠ value-replica 미완(아래 블로커 ①)**
- `083a55d` S2: `kcia-golden-set.json` 에 `regulatory_domain:cosmetic`(스키마 무편집)
- `c96f3b4` S3: pack-lint(`scripts/pack-lint.sh`+`lib/pack_lint.py`+`tests/test-pack-lint.sh`, PASS=15)
- `8a79868` S4: examples 헤르메틱(`tests/lib.sh:30` 기본값 + drive_pipeline/drive_to_done 종료 시 `unset`→`$HERMETIC_EXAMPLES` 복원)
- `7eefa64` S5: `build-fixtures.sh` 파라미터화(`--domain/--wb/--bundle`, phase-guard 스냅, 스킵 시 stale rm) + 합성 drug 번들·WB + `fixtures/drug/{concept,conti}-in` + `baseline-manifest-drug.json`(106) + `test-drug-stub-golden.sh`(escalated 동결)
- `3ecfa64` S6a: `adk_critic.py` Pass-A/B 지시문 순수함수 추출(`_build_pass{a,b}_instruction`, 온라인 바이트 동일 증명) + 오프라인 `emit-instruction` 서브커맨드
- `23798d6` S6b: 프롬프트 조립 골든(`tests/golden/prompt-assembly/` 11항목: ctx 6·prompts.sha256·instr cosmetic/drug×A/B, 정규화 `<REPO>`/`<RID>`) + `tests/test-prompt-assembly.sh`
- `41a308a` S7a: run-ci 에 test-drug-stub-golden·test-prompt-assembly 배선
- `90e4814` S7b: 수반 테스트 2건 수정 — `test-clinical-engine`(inspect 대상 `_do_passa`→`_build_passa_instruction`), `test-b1g:133`(`unset`→`$HERMETIC_EXAMPLES`)
- (사전 병합) 누출 grep `tests/test-core-domain-leak.sh`(merge `b850f57`, allowlist 14파일, green)

**전체 CI 실측(2026-07-04, `TEST_BUNDLE=합성`)**: 33 스위트 중 대부분 green. 실패 = ① B0/B1 content-coupling(아래 블로커 ①) ② `test-critic-fanout` drug 3건(**사전존재 stale**: drug adk_critic 블록이 브랜치 前 `157375f` 배선, 테스트가 "drug=미구현" 전제 — 범위밖) — 그 외 전부 green.

## 이어하기 지점 = 0단계 미해결 블로커 2건 → 그 뒤 1차 1단계

### 블로커 ① (최우선) — S1 합성 번들을 **value-replica** 로 재작성
현 합성 번들은 일반값이라 `test-b0/b1` 이 단정하는 **실제 이지듀 번들 추출값**과 불일치. 목표값(테스트가 요구):
- VOC keyword_frequency(순서=`ingest.py` VOC_KEYWORDS): `71 27 19 17 7 1 0 0`(+ b1 은 10키 `71 27 19 17 7 1 0 0 0 0`)
- persona_signals(어머니/엄마/선물): `5 12 9`
- rating_distribution(5★/4★/3★): `157 35 8`
- `offer.price = 49800` · `offer.discount = 37.44`(→ product.json 에 `price` 객체 추가 필요; 현 합성은 price 생략)
**작업**: 구 워크스페이스 실번들 `~/workspace/ch-detail-page-harness/naver_10910275313_20260617-1331` 을 인입(`TEST_BUNDLE=<그경로>`)해 정확한 목표 voc.json(위 + top_phrases 등)을 뽑고, **저작권 리뷰 텍스트 없이 동일 집계값을 산출하는 합성 reviews.csv+product.json 를 엔지니어링**(리뷰 문장은 창작, 단 키워드/페르소나 히트 빈도·평점 분포·옵션 분포·가격을 목표값에 맞춤). `.gitattributes` LF 고정 유지. 재-인입 2회 diff 바이트 동일(결정성) + `TEST_BUNDLE=합성 bash tests/run-ci.sh` 에서 B0/B1 green 확인. `test-b0/b1` 이 단정하는 다른 값(top_phrases·top_signals 등)도 함께 맞춘다(실패 목록 = 스펙). **값-불변 예외로 문서화**(합성 번들은 실번들 값을 의도적으로 재현).

### 블로커 ② — S8 기본값 전환 + 베이스라인 재캡처 (비가역·사람 확인 필수)
블로커 ① 완료 후. **비가역**(현 `baseline-manifest.json` 을 덮어씀) → **실행 직전 사람 확인**.
- 게이트 전 감사(읽기전용): `TEST_BUNDLE=~/workspace/ch-detail-page-harness/naver_... bash tests/verify-baseline.sh` 로 실패집합이 **정확히 webp 클로저**(assets-manifest·bundle-report·keyvisual HTML/PNG — `ezderm-relief-provided.webp` 추가분)인지 기록. 예상외 키 = 중단·조사.
- 전환: `tests/lib.sh:14` + `scripts/build-fixtures.sh` 의 `TEST_BUNDLE` 기본값 → `$ROOT/tests/fixtures/bundle-cosmetic`.
- 재캡처: `bash tests/capture-baseline.sh`(drive_to_done ×2 intersect → `tests/golden/baseline-manifest.json` 덮어씀) → `bash tests/verify-baseline.sh` green → `bash tests/run-ci.sh` **전체 green**(TEST_BUNDLE env 없이). **전환+재캡처 = 한 커밋**(감사 단위). fixtures/{concept,conti,keyvisual}-in(코스메틱 frozen)은 재생성 금지.
- **0단계 완료 판정**: 전체 CI green(합성 기본값) + 신규 골든 3종(드럭·프롬프트조립·pack-lint) green + verify-baseline green.

### 그 다음 = 1차 1단계 (레지스트리 일원화·cosmetic 폴백 소거) — plan 3장 "1단계"
정본 = `pack-refactor-plan.md` 1단계(라인 ~93-104). 요지:
1. `normalize_format`(new-run.sh:42-44) → `format-profiles.json` aliases 질의로 통일(별칭 집합 동일=바이트 불변).
2. 도메인 한국어 별칭(new-run.sh:31-41 case) → `packs/<도메인>/domain.json` `aliases` 신설·이관, `normalize_domain` 은 레지스트리 질의로.
3. **cosmetic 폴백 전수 소거(11지점)**: `kcia_engine.py`(:220 `default or "cosmetic"`·:225·:232·:241·:252-257) · `common.sh`(:89-93 resolve_domain·build_context else) · `kcia-check.sh:276`(은닉 폴백) · `ingest.py:25` · `stub_stage.py:36` · `validate-stage.sh`(:134·:153·:181·:218·:222) · `golden_runner.py:29` · `new-run.sh:71-78`. **env(`HARNESS_DOMAIN`) 선언 인정은 유지**(테스트 수정 0건으로 fail-closed 양립). ⚠ `kcia-check.sh:276` 과 build_context else 는 registry default 와 별개 지점(누락 주의).
4. `domain.json` `default:true` 의미 제거 + 미등록 안내 = "등록 팩 목록 + 온보딩 제안"(`operator_labels.py` 경유).
5. **같은 커밋에서 레거시 철거**: `harness/regulatory-domains.json`(폴백 1경로) + docs/regulation 레거시 3종(사문) + `ingest-profiles.json:3` `default` 키 + 폴백 코드블록 자체. stale 문서(AGENTS 8번 절·harness-architecture.md·pipeline-stage-definitions.md)에 "packs 없는 core 단독" 폐기 반영.
6. `test-drug-golden.sh` default 단정군(:221·:228·:242·:353) → "default 부재=fail-closed" 로 재작성. `docs/user-guide.md:55` new-run 예시 수정.

**1단계 증명**: 스텁 골든 2종 + 심의 골든셋 + 전체 CI. **함정**: kcia-check.sh:276·build_context else 누락 쉬움.
**정정된 사실(plan 부록A)**: 진입점(new-run/ingest-bundle)은 **이미** 미선언 fail-closed. 1단계 본체 = 잔여 폴백 11지점 소거.

## 불변 규율 (매 단계 · plan 1장)
- **6박자**: 어댑터 계약 → 팩에 현행값 **그대로** 착지 → core 배선 교체 → core 상수/폴백 제거 → 골든·테스트 증명 → 문서 동반 갱신. **값은 옮기기만, 내용 절대 불변**.
- **커밋 분리**: "순수 이동(값불변)" vs "메커니즘 변경(배선·스키마)". (S6a 처럼 바이트-불변 리팩터는 소스-결합 테스트도 함께 갱신 — 이번 세션 교훈.)
- **workflow-ssot.md 동반 갱신**(AGENTS 4번 절 — 몰아치기 금지).
- **누출 allowlist 점감**: 파일이 packs 로 비면 `test-core-domain-leak.sh` ALLOW 에서 제거(9단계 0).
- **회귀 판정**: main 실패집합 vs 브랜치 실패집합 동일 = 회귀 0. (합성 번들 들어오면 이 마찰 해소.)

## 실행 방식 권고
`/dev-loop`(계획→분해→병렬 Opus 구현→단계별 Codex 리뷰, critical/high 0까지). 각 스테이지 파일-소유권 disjoint 확인 후 병렬. **비가역(S8 재캡처)는 사람 확인 후.** CI 는 `TEST_BUNDLE=$PWD/tests/fixtures/bundle-cosmetic bash tests/run-ci.sh`(value-replica 전) 또는 env 없이(S8 후).

## 참고: 진행 중인 별건 (pack-refactor 아님)
- **실제 런 `runs/ezderm-relief-acne-live`**(이지덤 릴리프 여드름, cosmetic multipage)이 이 브랜치의 `runs/`(**git-ignored**)에 있음 — 사용자 요청 end-to-end 검증(evidence-link 인입→export 확인·ADK 심의 whack-a-mole 관찰). **pack-refactor 커밋·골든과 무관**(runs/ 는 추적 안 됨). 이 런의 세부는 세션 대화·`.dev-loop-state.json` 참조. 새 세션이 pack-refactor 만 이어간다면 이 런은 무시해도 됨.
- 미추적 문서 `docs/insession-default-build-plan.md`·`docs/pack-refactor-resume-prompt.md`(구 버전) 는 커밋셋 제외 유지.
