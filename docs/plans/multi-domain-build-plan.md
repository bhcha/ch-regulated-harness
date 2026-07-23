# 다중 규제도메인 + 사례분석 가이드라인 확장 — 설계 델타 / 빌드 플랜 (v0.1)

> 위치: 이 문서는 `docs/reference/harness-design.md`(v1.1)의 **개정 델타**다.
> 기존 하네스는 화장품 단일제품(이지듀 쿠션) 전용이고, 원래 BPMN(브리프 단계 사용자 레인)에
> 있던 **「산출물의 유형 정의」 + 「유사 사례 취합」** 두 스텝이 PoC로 좁히며 축약됐다.
> 이 델타는 그 둘을 **1급 단계로 복원**하고, 심의 가이드를 **규제도메인별로 분리**한다.
> 작성일 기준(협의 확정): 2026-06-18.

---

## 0. 한 줄 정의
임의의 워킹백워드를 받아 **제품의 규제도메인(화장품/의약외품/건기식/…)을 사람이 선언**하면,
그 도메인의 **심의 가이드(룰셋)**가 전 단계에 적용되고, **동일 도메인의 좋은 사례 N개를 AI가 분석**해
"왜 좋은가"를 도출한 **프로젝트 가이드라인**으로 전체 방향을 잡은 뒤, 기존 4페이즈 생성으로 이어간다.

---

## 0.5 브리프 재설계 — 앞으로 "브리프"는 이것이다 (2026-06-18 확정)

> ⚠️ **부분 파기 (2026-06-24~25):** 아래 '유사점 3안(A-신뢰/B-사용가치/C-구성) → `select` → `project-guideline.json`' 설계는 이후 **파기**되고, 자유텍스트 `reference-notes.json`(단안 approve · 심의 면제)로 대체됐다. "브리프=앞단 묶음" 골격은 유효하나 ③ 단계의 '3안 select' 부분은 현행이 아니다. **현행 정본 = `docs/canonical/workflow-ssot.md`.** (이 절은 2026-06-18 결정 기록으로 보존)

> **용어 고정:** 이 하네스에서 **"브리프"는 앞단 1~4단계 전체**를 가리킨다(원 BPMN "1. 브리프" 칼럼의 복원·강화).
> 단일 `01-brief`(PR/FAQ) 산출물만이 아니라 **유형 선언 → 인입 → 사례 취합 → 유사점 3안 확정 → 정리**의 묶음이다.
> 런타임 SSoT = `AGENTS.md §4`, 현업 화면 라벨 = `run.md`("브리프 ① 인입 / ② 유사점 3안 / ③ 정리"), 코드 = `render_runmd.py` PHASE_LABEL.

### 브리프 = 4스텝 (페이즈 매핑)
| 스텝 | 내용 | 구현 |
|---|---|---|
| **⓪ 유형 선언** (가장 먼저·강제) | **2축**: 규제도메인(심의) × 산출물 포맷(구조)을 사람이 선언 | `new-run --domain <화장품\|의약외품\|건기식\|의약품> --format <한장\|여러장>`. 미선언 시 ingest **친절 중단**(cosmetic 자동폴백 없음) |
| **① 워킹백워드·번들 인입** | 제품 근거(claim-basis)·VOC 추출 | `00-ingest`(결정적) |
| **② 유사사례 취합** | 동일 (도메인,포맷) 좋은 사례 수집 | `inputs/examples/<도메인>/<...>/` |
| **③ 유사점 3안 추출·현업 확정** | AI가 "공통적으로 좋은 점"을 **3안**(A-신뢰/B-사용가치/C-구성)으로 제안 → 현업 `select`로 협의·확정 | `00g-guideline`(조건부, 다안 select) |
| **정리** | 워킹백워드+확정 유사점을 PR/FAQ로 합성, **확정 느낌(`confirmed_guideline`) 반영** | `01-brief` |

이후: 컨셉 → 스토리보드 → 키비주얼 → 완료.

### "산출물 유형" = 직교 2축
- **규제도메인** = *무엇을 말할 수 있나(법·심의)* → 심의 룰셋(`harness/regulatory-domains.json`).
- **산출물 포맷** = *어떤 구조로 만드나* → 캐논·실행페이즈·채널(`packs/_format/format-profiles.json`). 한장 홍보물(`one_pager`) / 여러장 BM자료(`multipage_bm`).
- (도메인 × 포맷) 매트릭스. **둘 다 ⓪에서 함께 선언**한다(둘 중 하나라도 미선언이면 진행 불가).

### 유사점 3안 (현업 확인 방식)
- 동일 도메인 사례를 **3가지 공통 프레이밍**으로 종합: **A-신뢰·검증 / B-사용가치·감성 / C-구성·정보**.
- 각 안에 `framing.thesis` = **"공통적으로 좋다고 느끼실 만한 건 ㅇㅇㅇ. 맞을까요?"**(현업 확인 문구).
- 현업이 `select` 로 1안 확정 → **soft 가이드라인**(법 > 가이드라인). 확정안의 느낌이 PR/FAQ(`confirmed_guideline`)로 이어진다.

### 브리프 재설계 확정 결정 (§1 에 이어서)
| # | 주제 | 결정 |
|---|---|---|
| 6 | 산출물 유형 = 2축 | 규제도메인 + **산출물 포맷**(한장/여러장). 둘 다 **가장 먼저** 선언 |
| 7 | 포맷 범위 | `multipage_bm`·`one_pager` **2개**(M7/M8/G6). multipage=완성(정식 canon). one_pager(STUB)=구조·커버리지·렌더 폭·필수기재 게이팅 + **키비주얼 프롬프트 format-aware(G6)** active → 실 LLM 포맷-native. 잔여=canon 정식화·stub 키비주얼 format-aware化(선택) |
| 8 | 정리 산출물 | PR/FAQ **합성** + 현업이 확정한 **"좋다고 느낀 점"** 반영(`confirmed_guideline`) |
| 9 | 유사점 프레이밍 | **공통**(신뢰/사용가치/구성) 3안 |
| 10 | 1~4단계 명칭 | **"브리프"** 로 통일(이 섹션) |

---

## 1. 확정된 결정 (2026-06-18 협의)

| # | 주제 | 결정 |
|---|---|---|
| 1 | 의약외품 심의자료 | **추후 제공**. `quasi_drug/ruleset.json`은 **TBD 플레이스홀더**로 두고 골격부터 작업 |
| 2 | 법 vs 가이드라인 우선순위 | **법(심의 룰셋)이 항상 우선**. `project-guideline.json`은 *soft 디폴트*(권고)이지 hard 강제가 아님 |
| 3 | 사례 수집 도메인 | **타깃과 동일 도메인 사례만** 수집·합성 |
| 4 | 빌드 상한 / 전문약 | 실 빌드 상한 = **의약외품**(BM 팀 특성). 전문/일반 의약품(대중광고 불가 하드스톱)은 **이번 대상 아님** — 아키텍처 affordance로만 |
| 5 | 도메인 분류 | **사람이 직접 선언**("이건 의약외품/화장품"). AI 자동분류기 **불필요** — 단순 선언 입력 |

**불변 원칙(기존 유지):** state.json은 `scripts/*.sh`만 쓰기 · 생성≠심의 · 환각 fail-closed
(근거 없으면 주장 불가) · 크롤 원본 픽셀 복제 금지 · "법적 통과 보증 아님(자율 사전점검)".

---

## 2. 규제도메인 모델

### 2.1 도메인 enum
`cosmetic`(화장품법) · `quasi_drug`(의약외품, 약사법) · `health_food`(건강기능식품법) · `drug`(의약품, 약사법)

- **이번 빌드에서 룰셋을 실제로 채우는 도메인**: `cosmetic`(보유) + `quasi_drug`(자료 추후).
- `health_food`/`drug`은 **스키마·레지스트리상 ready**(플레이스홀더)로만 두고 데이터는 미채움.
- `drug`은 전문/일반 구분과 대중광고 금지(하드스톱) 이슈가 있으나 **이번 대상 아님**(§1-4).

### 2.2 도메인 레지스트리 — `harness/regulatory-domains.json` (신규)
도메인 → {표시명, 근거법, ruleset 경로, 크리틱 프롬프트, 기능범주, 사전심의 위상, 광고가능성,
필수기재 여부, export 패키지 유형}의 단일 매핑. 심의엔진·ingest·canon·export가 **이 한 곳**을 읽는다.

### 2.3 도메인별 심의 축 구조 (왜 "코드→데이터"가 불가피한가)

| 심의 축(타입) | 화장품 | 의약외품 | 건기식 | 의약품(ready-only) |
|---|---|---|---|---|
| `banned_expression` 금지표현 | 질병·약리효능, 절대표현 | 의약품 오인(허가범위 초과) | 질병 예방·치료 표방, 거짓·과장 | 허가 외 효능, 오남용 조장 |
| `conditional_allowed` 조건부허용 | 미백/주름/자외선=기능성 승인시 | 효능=허가범위 내 | 기능성=인정범위 내(고시/개별인정) | 효능효과=허가범위 내 |
| `substantiation_required` 실증 | 실증제(인체적용시험 등) | 허가자료 | 기능성 인정자료 | 허가 임상자료 |
| `mandatory_inclusion` **필수기재** ⬅️신규 | (적음) | 표준 사용·주의 문구 | "질병 예방·치료 의약품 아님" 등 법정문구 | 사용상 주의·안전성 문구 |
| `pre_review` 사전심의 | 자문(자율·비법적) | (확인 필요) | **의무**(한국건강기능식품협회) | 자율(제약바이오협회) |
| `ad_eligibility` 광고가능 | 가능 | 가능 | 가능 | 전문약=대중광고 불가(하드스톱) |

→ 도메인이 4개면 "화장품 4축 + union" 절충이 폭발한다. **엔진은 축 구조를 룰셋 데이터에서
읽는 도메인-중립 실행기**가 되고, 화장품 기존 4축은 `cosmetic/ruleset.json`에 그대로 남는다.
**새 축 타입 `mandatory_inclusion`(필수 기재)** 가 의약외품·건기식·의약품 공통으로 필요하다.

---

## 3. 일반화되는 동결 계약(스키마) — **후방호환(완화만)**

기존 화장품 데이터/테스트가 **그대로 통과**하도록 *제약을 좁히지 않고 넓히는* 방향으로만 바꾼다.

| 스키마 | 변경 | 후방호환 |
|---|---|---|
| `state.schema.json` | `product.regulatory_domain`(enum) 추가, `functional_status`를 도메인 오픈맵 허용 | 신규 필드 optional → 기존 통과 |
| `claim-basis.schema.json` | `functional_status` 고정 3키(whitening/wrinkle/uv_protection) → **도메인 키 오픈맵**(`additionalProperties: funcEntry`), `regulatory_domain` 추가 | 화장품 3키 그대로 유효 |
| `ruleset.schema.json` | 4축 고정 required·`additionalProperties:false` → **축 id 자유 + 각 축 공통 형태**(type/ref/…) | cosmetic 룰셋 4축 그대로 유효 |
| `verdict.schema.json` | `violation.axis` 4값 enum → **string**(룰셋 축 id 검증) | 기존 4값 그대로 유효 |

검증기(`harness.py`)는 `oneOf/anyOf/$ref/additionalProperties(schema)` 지원 확인됨 → 도메인-조건부 표현 가능.

---

## 4. 새 단계(스테이지)

### 4.1 ⓐ 제품유형·규제도메인 정의 (= 원 BPMN "산출물의 유형 정의")
- **형태**: 사람이 도메인을 **선언**(§1-5) → `new-run.sh`/`ingest`가 `state.product.regulatory_domain`에 기록 →
  민감표시처럼 **1회 확인 게이트**(기존 brief `sensitive-confirmation` 패턴 재사용).
- ingest의 키워드/기능범주 프로파일은 이 도메인으로 선택된다(화장품=기존 프로파일 기본값).
- `drug`+전문약이면 "대중광고 불가" 경고/하드스톱 affordance(이번 미빌드).

### 4.2 `00g-guideline` 신규 phase (= 원 BPMN "유사 사례 취합", AI 분석으로 강화)
- **위치**: `00-ingest → 00g-guideline → 01-brief …` (기존 번호 **재번호 없음**, 추가형).
- **입력**: `inputs/examples/<site>_<id>_<ts>/`(동일 도메인 N개) + 워킹백워드 + 규제도메인.
- **생성**: 사례별 `example-analysis.json`(측정신호 그라운딩한 "왜 좋은가") → 집계 `project-guideline.json`
  (권장 캐논 순서·톤 디폴트·메시지 위계·선호/금지 표현(룰셋과 교집합)·소셜프루프/근거 패턴·페르소나 가설).
- **게이트**: 생성 → 경량 review(도메인 적합성) → **사람 협의/승인**(= "초반 단계협의").
- **환각 안전**: "왜 좋은가"는 가격/할인·평점·리뷰량·포토리뷰비·재구매·VOC테마·블록시퀀스 등
  **실측 신호를 인용**해야 하며, 신호 없으면 "근거 부족"(claim-basis fail-closed와 동일). 텍스트·구조만(저작권).

### 4.3 다중 사례 입력
- 현재 단일 슬롯 `inputs/bundle/` → `inputs/examples/<...>/`(복수) 완화.
  크롤 폴더명이 이미 `{site}_{productId}_{ts}` 출처 인코딩 → 그대로 활용. 기존 best-practices.json은 흡수.

### 4.4 하드코딩 knob → 가이드라인 데이터 승격
`stub_stage.py`의 추천 선호순서/톤 순서, `CANON` 시퀀스, `TONE_DIRECTIONS`, 프롬프트 인라인 금지어가
**지금은 리터럴**. 이를 `project-guideline.json`/도메인 프로파일 데이터로 빼면 부수효과로
**하네스가 진짜 제품-무관 재사용 가능**해진다(근본 목표).

---

## 5. 빌드 순서 (증분 — 각 증분 후 `HARNESS_OFFLINE=1 bash tests/run-ci.sh` 그린 유지)

| 증분 | 내용 | 리스크 | 게이트 |
|---|---|---|---|
| **M1 도메인 기반** | 레지스트리 신규 + 스키마 4종 후방호환 완화 + 로더 도메인선택(기본 cosmetic, 레거시경로 폴백) + `state.regulatory_domain` + new-run 시드 | 낮음(가법·완화) | 화장품 CI 그린 |
| **M2 의약외품 프로파일** | ingest 키워드/기능범주/인증 프로파일 도메인화 · canon/stub 도메인 스코프 · `quasi_drug/ruleset.json`(자료 입수 후 채움, 그 전엔 TBD) | 중 | quasi_drug 더미 run 검증 |
| **M3 다중 사례 입력** | `inputs/examples/` 완화 + `example-analysis.schema.json` + 분석 산출 | 중 | 스키마 검증 |
| **M4 가이드라인 phase** | `00g-guideline` 배선(state enum·advance-phase·common.sh·run-stage·render_runmd·registry·prompt·래퍼) + 다운스트림 소비 | 중(가법, 게이트 로직 불변) | 신규 phase E2E(stub) |
| **M5 엔진 코드→데이터** | `FUNC_EFFICACY/CONDITION_TARGET/PHARMA_AUTHORITY/severity`를 룰셋 필드로 이전 → 엔진 도메인-중립 + `mandatory_inclusion` 축 실행 | 중~높음(행동변경) | 화장품 골든셋 회귀 동일 |

**깨끗한 seam**: `gate.sh`(생성/심의/선택/승인 전이)는 phase·도메인 무관 → 루프 로직 불변.
**최대 비용**: §3 동결 계약 완화(M1) + §5-M5 엔진 행동 이전. 둘 다 화장품 회귀로 가드한다.

### 진행 현황 (2026-06-18)
- **M1 ✅** 도메인 기반(레지스트리·스키마 완화·로더·state 필드). + **TBD-도메인 무조건 통과(placeholder-autopass)** 구현.
- **M3 ✅** `example-analysis` 스키마 + `examples_analysis.py`(결정적, 측정신호 grounded). *(구 `project-guideline` 스키마는 '유사점 3안' 파기로 제거됨 — 2026-06-26)*
- **M4 ✅** `00g-guideline` 신규 phase 배선(**조건부**: `inputs/examples/` 또는 `HARNESS_EXAMPLES_DIR` 있을 때만 활성, 없으면 01-brief 직행 → 후방호환). LLM 경로 `prompts/guideline.md` + stub 경로 `examples_analysis.py`. 전용 테스트 `tests/test-b1g.sh`(10). CI 248 green.
- **M2 골격 ✅** ingest 추출 프로파일 외부화 — `harness/ingest-profiles.json`(도메인키) + `ingest.py` 상수 `_PROFILE.get(key, 화장품기본값)` 래핑(cosmetic=모듈 기본값 → byte-identical, B1 31/31) + `ingest-bundle.sh` 가 `HARNESS_DOMAIN` 주입. quasi_drug=빈 프로파일(화장품 키워드 미적용).
- **M2 콘텐츠 ⏳ 차단** `quasi_drug/ruleset.json` 실내용 + ingest-profiles quasi_drug 키워드 = **의약외품 심의/VOC 자료 입수 후**.
- **M5 ⏳** 엔진 코드→데이터 이전(FUNC_EFFICACY/CONDITION_TARGET/PHARMA_AUTHORITY → 룰셋) + `mandatory_inclusion` 축 + stub_stage `CANON/AXES/TONE`·canon-components 도메인화(골든 byte 위험) — M2 룰셋 채운 뒤 함께.

---

## 6. 안전·고지
- **TBD/미제공 도메인 = 심의 무조건 통과(placeholder)** — 사용자 합의(2026-06-18). 레지스트리 `status != active` 도메인(현재 의약외품)은
  실제 심의기준(ruleset) **추후 제공 전까지** `kcia-check.sh` 가 `verdict=pass`(engine=`placeholder-autopass`, note 기재)로 통과시킨다.
  **TODO**: 심의기준 입수 → `docs/regulation/<도메인>/ruleset.json` 채움 + 레지스트리 `status=active` 전환 즉시 실제 심의 자동 적용.
- 동결 계약 완화는 **의식적 계약 변경**이며 화장품 후방호환 테스트(`tests/`)로 가드한다.
- 환각 fail-closed·크롤 저작권(픽셀 복제 금지·자사자산 img-src allowlist) 규약 유지.
- 본 산출물은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다. 최종 책임은 사람(현업/RA).
- `quasi_drug`(의약외품) 룰셋 내용은 **현업 제공 심의기준 문서 입수 후** 4축+필수기재 카탈로그로 1차 추출한다.
