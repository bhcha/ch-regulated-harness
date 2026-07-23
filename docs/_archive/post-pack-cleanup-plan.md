# 팩 분리 후 정리 계획 — 잔여 이월 + 중복·하드코딩 (실측 재평가판)

> 작성 2026-07-08 · 상태: **실행 대기(1단계부터 착수 가능)**

> **완료 현황(2026-07-09 · dev-loop):** 3단계(K-1)·4단계(K-2)·5단계(K-3①②)·6단계(K-4·K-5) 전부 구현·**단위별 Codex 리뷰 루프(High/Critical 0)**·kernel-track ff → **main 병합 완료**(머지 커밋). 2단계(grounding)=**보류**(사람/RA). **DoD**: 골든 4종 바이트 동일(verify-baseline 180)·누출 allowlist 0·critic_prompt 0·중복지점 각 항목 1곳(커밋 before/after)·전체 CI 선재 4건만. ⚠ **미충족 1건**: 5단계 DoD 'common.sh 600 이하' → 실제 **703줄**(build_context 341줄 추출로 −336, 남은 함수 전부 소형이라 단일 추출로 600 미달 — 추가 이관은 범위 밖, 정직 기록). ingest.py 섹션 파서 편승 항목=미착수(우선순위 낮음).
> **출처 2개를 현 시점(팩 분리 1차 완료, main `cb554b8` · pack-stage 50커밋)에 재실측해, 아직 유효한 항목만 추린 실행 계획.**
> ① `docs/maintainability-refactor-plan.md`(2026-07-07 조사)의 **2장 하드코딩 · 3장 중복** — 조사 원문·근거는 그 문서가 정본.
> ② `docs/ops-and-pack-refactor-plan.md` 의 잔여 이월(심의 grounding 확장 등).
> 원 조사의 L(레이어 갭)·C(CI 비용)·D(문서 다이어트) 트랙은 이 문서 범위 밖(원 문서 참조).
> ⚠ 원 조사(7/7)의 파일:줄은 팩 분리 50커밋 이전 기준 — **각 단계 착수 시 심볼 기준 재정찰 필수.** 이 문서의 파일:줄 중 "실측(7/8)" 표기는 이번 재검증에서 확인한 현행 값.

## 0. 전제 — 팩 분리가 이미 해소/변경한 것 (재작업 금지)

| 원 계획 항목 | 현 상태 |
|---|---|
| 2-1장 도메인 어휘 하드코딩 본체(allowlist 14파일) | **완료** — 누출 allowlist 14→0 (2부 5·6·9단계) |
| 3-3장 블록 type enum 2벌(storyline↔plan-block ↔ stub CANON) | **완료** — 2부 4단계 canon.json 정본 1개가 흡수 |
| K 트랙 착수 조건("2부 1차 완료 후") | **충족** — 전 트랙 unblock (K-3 전제=5단계 완료·K-5 전제=8단계 완료 포함) |
| critic_prompt "5단계 실배선 예정"(원 3-5장) | **미배선 확정**(정찰+Codex 검증 SOUND, 커밋 fab4b61·cb554b8) → 필드는 사문 확정, 아래 1단계에서 제거 |

**처방이 바뀐 것(팩 분리가 열어준 것):**
- **H-2** `_REGULATED` 집합: 원 처방 "우선 정의 1곳화" → 이제 **`domain.json` 정책 속성화(팩 소유)가 곧장 가능**(원 문서 스스로 "장기 정답"이라 판정한 노선).
- **H-6** 누출망 보강: 원 우려 "allowlist 점감과 조율" → **allowlist=0 이라 조율 불요, 지금이 적기**.
- **PACKS_DIR/FORMATS_DIR 해석**: 원 9곳 → **실측(7/8) 11곳으로 증가**(팩 분리 과정에서 파생 — stub_stage·pack_lint·build-fixtures·pack-conformance 등) → K-1 시급성 상승.

## 공통 규율 (전 단계 적용 — 2부에서 확립한 패턴 승계)

1. **값 불변**(옮기기/일원화만, 동작 변경은 2단계 grounding 뿐 — 그건 온라인 카나리로 증명).
2. 이동 커밋 / 배선 커밋 분리 · 커밋 메시지에 **중복 지점 수 before/after 명기**.
3. 검증 순서 = 타겟 테스트 → **골든 4종**(verify-baseline 180 · drug-stub 100 · prompt-assembly 12 · b3 심의 골든셋) → **전체 CI(선재 4건만: critic-fanout drug ADK 3 + b4 1)**.
4. **단위별 Codex 리뷰**(커밋 → CI → Codex → 발견 반영 → 병합) — 7B 에서 실결함(High#1) 포착 실적.
5. 착수 시 심볼 재정찰(Explore 위임) · workflow-ssot 동반 갱신 · 단계 = 독립 브랜치/병합 단위 · **CI 실행 중 작업트리 수정 금지**(7B 교훈).

---

## 1단계 — 실동작 버그·오염망 소거 (최우선 · 소규모)

**H-1. intake.sh 의 2부 1단계 소거 누락 2건 — [x] 완료** [커밋 a4e5a32]:
- [x] `normalize_domain`·`normalize_format` 인라인 case → `domain_alias_resolve`/`format_alias_resolve` 레지스트리 질의(new-run 동일). 등가 실측: 화장품→cosmetic·여러장→multipage_bm·의약품→drug.
- [x] 기능성 카테고리 폴백 화장품 트리플 → `[]`(new-run 동일).
- **정정(계획 초안 '실동작 버그' 과장)**: 트리플 폴백은 `functional_categories is None` 일 때만 발동하는데 등록 도메인은 전부 list/`[]`(None 아님) + normalize 가 미등록을 die → **유효 런에선 도달 불가**. 따라서 라이브 초기 state 회귀가 아니라 **코드 일원화**. **Codex 검증: SAFE + 판단 맞음**(유일 이론적 반례=손상/미래 팩의 키 누락 None 경로조차 이번 변경이 new-run 과 동일 `[]` 로 처리 → 개선). LOW 2(테스트가 cosmetic 실 registry 로 비교해 `[]` 폴백 미-exercise·format-registry 손상 경계). 검증: test-intake 64/0(H-1 가드 3 신설)·leak 0·b0 39/0·전체 CI 선재 4건.
- 검증: `tests/test-intake.sh` + **intake 런=new-run 런 초기 state 동일성(폴백 포함) 단정 추가** + 전체 CI.

**H-6. 누출 감지망 사각 보강 — [x] 완료** [커밋 a802072]:
- [x] BRAND_RE 에 `ezderm|아누아|메디힐` 추가(한글 '아누아' — 영문 'anua' 는 'manual' 오탐이라 회피) + SCAN_DIRS 에 `skills` 추가.
- [x] 신규 히트 4건 도메인-중립화: reference-notes.schema(아누아/메디힐 예시)·intake.sh(ezderm die 예시)·render-design.sh(ezderm 주석)·skills/check-components(대웅배너→브랜드배너). **allowlist 0 유지**.
- ⏭ **LOW(수용 경계, Codex)**: `tests/` 는 여전히 누출망 밖(test-components 대웅배너·test-drug-golden 제조판매원 대웅제약 등) — 회귀 아님(누출 테스트 계약상 tests/ 미스캔). 8B "테스트 시나리오=net-negative" 판단과 일관해 tests/ 미포함 유지.

**사문 정리 — [x] 완료** [커밋 6eb5376]:
- [x] `common.sh` `domain_sources_dir`(호출 0) 제거 — Codex 확인(scripts/tests+heredoc 문자열까지 0 호출).
- [x] **`packs/*/domain.json` `critic_prompt` 필드 4건 제거** — 미배선 확정 사문(Codex 확인: 읽는 코드 0·ADK는 adk_critic+ruleset·pack-lint/스키마 미요구). 줄-기반 제거로 포맷 보존. pack-lint 21/0·pack-conformance 13/0.
- ⏭ settings.local.json 잔재는 **gitignored 로컬**이라 커밋 대상 아님(로컬 housekeeping 별개).

## 2단계 — 심의 grounding 확장 (보류 — 이번 정리 범위 밖)

> 출처: critic 미배선 결정의 Codex 적대 검증이 지목한 **진짜 갭**. 마크다운 배선이 아니라 ruleset-파생 확장(단일 출처 유지).

- [ ] **착수 게이트(사람/RA 판단 1회)** — **보류(사람/RA 판단, 2026-07-08): 룰엔진이 기능성 lexicon 을 이미 결정론 검사(이중 안전망)라 ADK 지시문 힌트 추가의 오탐·과제약 리스크 대비 실익 불확실 — 이번 정리에서 제외, 값-불변 이관만 수행.** (원 게이트: 룰엔진 `kcia_engine.py:345` 부근이 기능성 lexicon 을 이미 결정론 검사 중[belt-and-suspenders] — ADK 지시문 힌트 추가의 실익/오탐·과제약 리스크를 확인 후 착수.)
- [ ] `adk_critic.py:_ruleset_grounding`(실측 :467)에 ruleset 의 `conditional`·`lexicon.functional_efficacy` 방출 추가 → ADK 지시문에 기능성-오인 힌트("미백/주름/자외선=approved 필요") 편입. 상한(1500자) 준수 확인.
- 검증: `instr-*.txt` 골든 재캡처(**같은 커밋**, `PROMPT_ASSEMBLY_REGEN=1`) + **온라인 카나리 1회**(실 cosmetic ADK — `.env` 자격 존재) + b3 심의 골든셋 불변(검출률·오탐률) + 전체 CI.

## 3단계 — K-1 마이크로 헬퍼 일원화 (값 불변 · 커밋=헬퍼별)

원 3-2장 + H-4·H-5. 전부 harness.py 로 승격, 각 커밋에 지점 수 before/after. **완료(브랜치 cleanup/stage-3-k1-microhelpers · 커밋 88d8d0e~591d55e · 골든4 전 커밋 ALL GREEN)**:
- [x] `ROOT` 3단 dirname 재계산 → `from harness import ROOT`. **before 11(정의 1+재계산 10) → after 2**(harness 정의 1 + check_html_blocks 격리 1). 재계산 9파일 흡수. [88d8d0e]
- [x] **`PACKS_DIR`/`FORMATS_DIR` 해석** → harness.py 정의·질의. **before 11(PACKS 6+FORMATS 5) → after 2**(harness 정본 1 + check_html_blocks 격리 1쌍). env override 존중. [4d0962d]
- [x] 원자적 쓰기 → fsync 통일 + `harness.atomic_write_bytes` 승격(image_engine 위임). adk_critic 은 fsync 추가(no-newline 바이트 보존·격리 유지) · PNG normalizer 는 best-effort 미학 경로라 생략. **4벌 매체 상이(json/bytes/PNG/no-newline)로 완전 병합은 바이트 위반 → fsync 유무만 일원화.** [40c4d73]
- [x] `deliverable_format` 리더 → `harness.deliverable_format(state)`. **before 5 인라인 → after 0**(호출부 try/except 보존). [8703a5f]
- [x] 마이크로 헬퍼: `_is_num`(7→2, clinical_chart 격리) → `harness.is_number` [1f5eb40] · sha256(2→1) → `harness.sha256_file`(청크 무관 실증) [ebe17f1] · escape(코어 2→1) → `harness.html_escape`(발산 시맨틱 인자 보존·11케이스 실증) [2ebe7a3] · 도메인 리더(3→0) → `harness.regulatory_domain` [e175a4b]. **안전경로 가드는 제외** — 자립 보안 스캐너(check_asset_paths·check_render_refs)·격리 크리틱(adk_critic, negated 형)라 net-negative.
- [x] **H-2 업그레이드**: `_REGULATED_NO_GRAPHIC`(image_engine)·`_REGULATED`(common.sh 폴백) → **`domain.json` 의 `no_graphic_generation`**(drug/quasi_drug/health_food=true·cosmetic=false; 옛 frozenset 정확 일치) 질의. 셸·파이썬 질의만. 새 도메인=팩 선언만. (⚠ `ad_eligibility` 와 다른 축이라 재사용 안 함·신규 속성.) workflow-ssot·AGENTS §8 동반 갱신. [591d55e]
- [x] H-4 env 기본값 이중정의 → 언어별 1곳화: gemini 모델 python 2→1(`_NB_DEFAULT_MODEL`) · nanobanana retry 4/3 python 각 2·3→1 · GEN_POLL/HEARTBEAT 셸 2→1(common.sh 정본, obs.sh 참조). (multipage_bm python 은 3단계에서·셸은 4단계 K-2; gemini 크로스-언어 리터럴은 언어별 1곳 유지.) [76ac0e8]
- [x] H-5 매직 넘버 8건 상수 명명(값 불변): golden_runner 0.8/0.15(이중정의 겸 dedup) · image_engine CHANNEL_WIDTH_PX 860·aspect 범위 0.1/10.0·no-op tol 0.01·레터박스 bg · render +2 · clinical_chart raw 1e-6→기존 `_NUM_EPS`. [0707356]
- 검증: 골든 4종 전 커밋 ALL GREEN · 단계 머지 직전 전체 CI(아래 DoD).

## 4단계 — K-2 셸 상태·게이트 보일러 통합

원 3-1장. 대상(착수 시 재정찰):
- [x] state.json 쓰기 heredoc 11벌 → `gate.sh transition()` 을 common.sh 승격 공용화.
- [x] state 스캐폴딩 2벌(new-run ≡ intake, 1단계 H-1 과 연쇄) 공용화.
- [x] kcia-check autopass writer 2벌(review-exempt ≡ placeholder) 통합.
- [x] 생성 watchdog 2벌(run_llm ↔ obs_watch_pid) 통합 · `with_lock` 헬퍼(락 댄스 9곳) · `image_manifest_*` 반전 쌍 통합.
- [x] **H-3** 페이즈↔스테이지 이름 맵 3벌(common.sh stage_phase · kcia-check · next-action) 1곳화.
- [x] sha256 셸 인라인 4벌 · sensitive 승인수 3벌 · deliverable_format 셸 폴백 관용구.
- 검증: test-gates·test-routes·test-b0 + 골든 4종 + 전체 CI. (회수 여지: 셸 ~550-650줄)

## 5단계 — K-3 대형 이관 2건 (각각 별도 브랜치)

- [x] ① `build_context`(common.sh 327줄, 파일의 35.6%) → `lib/build_context.py`. 안전망 = **프롬프트 조립 골든**(ctx-*.txt 바이트 동일 증명). DoD: common.sh 900→600 이하.
- [x] ② `validate-stage.sh` 인라인 파이썬 14블록 → `lib/validate_stage.py`(케이스 디스패치는 셸 유지, 검증 본문만 이관).

## 6단계 — K-4 스키마 드리프트 lint + K-5 테스트 위생

- [x] K-4: 스키마 **무수정**, 정합 lint 테스트 신설 — functional_status·reference_image_id·regulatory_domain 패턴 문자열이 스키마 간 일치하는지 단정(파일 간 `$ref` 는 검증기 지원 확인 전 금지). phase enum 3곳은 의도된 동결 계약 — 비대상.
- [x] K-5: lib.sh drive 드라이버 3벌 파라미터화 통합 · adk-mock 기동/종료 헬퍼 lib.sh 승격 · 인라인 state 리더 → `jq_phase` 유도.
- [ ] (편승) ingest.py 섹션 파서 6개 동형 골격(~80줄) — 3단계(인입 팩화) 완료로 unblock, 우선순위 낮음. — **보류(우선순위 낮음, 미착수)**

---

## 보류 (우선순위 낮음 — 근거와 함께 명시)

| 항목 | 보류 근거 |
|---|---|
| 7B 잔여 High#2(TBD 도메인 무이미지 미보장) | 교차오염 아님(stub SVG 생성) — placeholder-autopass 도메인 활성화 시 재론 |
| 7B 잔여 Low#7(WB 기본값 cosmetic → 도메인 WB samples) | 자산 seam 과 동형 작업이나 실사용 경로는 전부 명시 오버라이드 중 |
| 8B 단정문자열 → 팩 fixture | 다행 도메인 시나리오 HTML mock(테스트 스캐폴딩) — 추출은 net-negative, 누출-grep 미스캔이라 allowlist 무관 |
| lib.sh cosmetic env "기본값 의미 제거" | semantic·바이트 무영향이나 broad 파손 위험 |
| bundle-profile(소스/포맷 프로파일) | 이동이 아니라 신규 설계 — 2차 |
| 재캡처 해시-온리·픽스처 타임스탬프(7B Codex Medium#3/#5) | pre-existing 관측 — baseline.py 개선은 별건 |
| 원 계획 7장 "하지 않는 것"(hooks·MCP·CI 병렬화·die 중앙화·완전 선언화 등) | 판정 승계 — 비채택 유지 |

## 완료 판정 (Definition of Done)

1. 1단계: intake=new-run 초기 state 동일성 단정 그린 + 보강 누출망에서 **allowlist 0 유지** + critic_prompt 필드 0.
2. 2단계: instr 골든 재캡처 정합 + 온라인 카나리 1회 통과 + 심의 골든셋 검출률·오탐률 불변.
3. 3~4단계: 중복 정의 지점 수 각 항목 1곳(커밋 메시지 before/after) + 골든 4종 + 전체 CI 그린.
4. 5단계: 프롬프트 조립 골든 바이트 동일 + common.sh 600줄 이하.
5. 전 단계: 선재 4건 외 CI 그린 · 단위별 Codex 리뷰 수행 기록.
