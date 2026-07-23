# 다제품 워킹백워드 추출 경계 — 결함 수정계획 (M-1 ~ M-3)

> 작성 2026-07-06. 첨부 통합 인입(00a-intake, `docs/attachment-intake-plan.md`) + P-1~P-4 구현 직후
> **실폴더 E2E 2건**(릴리프 `ezderm-relief-e2e` 화장품 · 우루사 `ursa-drug-e2e` 의약품, 둘 다 done 완주)의
> 검증 과정에서 opus 검증 에이전트가 발견한 **다제품 워킹백워드(WB) 추출 경계 결함**의 수정 설계 SSoT.
> **이번 런엔 무해했다** — 선언 도메인(state.json)이 심의를 지배하므로 오추출이 최종 산출물엔 반영되지 않았다.
> 그러나 **다제품 입력 일반화 시 실결함**이다(추출 정확도·제품 귀속). 근거 메모: 자동메모 `e2e-intake-verification-2026-07`.
> 구현은 dev-loop(웨이브·스테이지별 Codex 리뷰·critical/high 0 수렴). **AGENTS.md 4번 절 의무: 각 커밋에서 `docs/workflow-ssot.md` 동반 갱신.**

## 구현 완료 (2026-07-06)

3건 전부 구현·커밋(branch `fix/multiproduct-extraction-boundary`). Codex 적대 리뷰 **20라운드** 수렴(critical/high=0 — 매 라운드 서로 다른 실제 WB 구조 엣지: 스팬 유실·접두사/브랜드/괄호/용량 접미사·헤딩-only·제목+마커·중첩마커·메타순서·마커-free·substring·라벨·카테고리 그룹핑·혼합마커·헤딩정체성·혼합계층·카테고리 리드-인·플랫 폴백 등 24+ 형태). 회귀 `tests/test-multiproduct-extraction.sh`(60 checks)·`tests/test-examples-analysis.sh`(12) run-ci.sh 등록 + 넓은 골든 green. 정본 최종 진실 = `docs/workflow-ssot.md` 1단계 claim-basis 행, 변경 이력 = `docs/workflow-ssot-history.md`.

## 알려진 한계 (fail-open 으로 안전 — 향후 개선 후보)

Codex 적대 리뷰가 21라운드째에 짚은 **불일치 마커 형제**(형제 제품 블록이 제각각 — 한 블록은 `제품명:`만, 다른 블록은 `제품유형:`만) 레이아웃은 각 마커 종류 카운트가 1이라 다제품으로 감지되지 않고 **전체-WB 폴백**(감사줄 없이)된다. 이는 사용자 확정 fail-open 원칙상 **오늘 baseline(전체-WB)과 동일 = 오염 아님**이지만, 그 특정 제품으로 스코핑되지도 않고 경고도 없다. 실전에서 형제 제품을 서로 다른 마커로 표기하는 경우는 드물고(대개 일관된 헤딩/마커), 안전(오염 없음)하므로 현 릴리스에서는 fail-open 으로 남긴다. 향후: `multi` 판정을 결합 마커 카운트로 바꿔 최소한 감사 경고를 내거나, 마커 종류 혼합을 결합해 스코핑하도록 확장 가능.

## 확정 결정 (2026-07-06, 사람 확인 완료)

- **범위**: 3건 전부(M-1·M-2·M-3).
- **M-2 후방호환 전략**: **fail-open 폴백** — 모호/단제품이면 현행 전체-WB 추출로 폴백(오늘보다 나빠지지 않음, 단제품 골든 바이트 불변). 모호 다제품은 사람 확인으로 가시화.
- **실행**: dev-loop(Codex 적대 리뷰 + 회귀 게이트). 새 브랜치 `fix/multiproduct-extraction-boundary`.
- **불변 제약**: 단제품 WB 골든 바이트 불변 · state.json 은 스크립트만 씀 · 넓은 오프라인 회귀 green 유지.

## 우선순위 요약

| # | 심각도 | 제목 | 한 줄 | 파일 |
|---|---|---|---|---|
| M-1 | MEDIUM | claim-basis `product_type` 첫 제품 오추출 | 다제품 WB 에서 정규식이 첫 제품 유형을 집음 | `ingest.py` |
| M-2 | **HIGH(정확도)** | evidence 타제품 혼입 | 근거를 전 절 무차별 수집, 제품 귀속 무관 | `ingest.py` |
| M-3 | LOW(견고성) | `reference_images:[]` 자기거부 | detail 이미지 없는 크롤이 자기 검증을 못 통과 | `examples_analysis.py` |

> **공통 근인**: `ingest.py` 의 WB 추출(`cmd_claim_basis`·`_extract_product_facts`)이 **WB 전체를 제품 경계 없이 평면 스캔**하고,
> **state.json 의 선언 제품을 전혀 참조하지 않는다**. 호출부 `ingest-bundle.sh:119` 는 `claim-basis <WB> <out>` 만 넘긴다(선언제품 미전달).
> 단제품 WB 에선 맞지만, 다제품 WB 에선 잘못된 제품의 데이터를 집는다. M-1·M-2 는 이 근인을 공유한다(M-3 은 독립).

---

## M-1. claim-basis product_type 첫 제품 오추출 (MEDIUM)

**증상(실측·릴리프 E2E)**: 선언 제품 = 이지덤 뷰티 릴리프(화장품)인데, `claim-basis.product_type` 에 WB 첫 제품(이지덤 뷰티=의약외품)의 유형이 실렸다.

**근본원인**: `ingest.py:564-567` —
```python
product_type = _PROFILE.get("product_type_default", "color_cosmetic_cushion")
m = re.search(r"제품유형[:\s]*([^\n,，]+)", text)   # 전체 text 에서 첫 1건만
if m:
    product_type = m.group(1).strip()
```
`text` = WB 전체. 다제품이면 첫 `제품유형:` 마커 = 첫 제품. 선언 제품 무관.

**소비처(vestigial 아님)**: `extract_accuracy.py:47-49` 가 `product_type_contains` 로 검사 + `claim-basis.schema.json` required 필드.

**수정**: M-2 의 제품 섹션 스코핑에 흡수한다 — 선언 제품 섹션으로 스코프되면, 그 섹션 안의 첫 `제품유형:` 가 올바른 값이다. 섹션에 `제품유형:` 가 없으면 현행 `product_type_default` 유지(폴백).

---

## M-2. evidence 타제품 혼입 (HIGH — 정확도)

**증상(실측·릴리프 E2E)**: `ev-04` "acnes 사멸 항균 시험"이 릴리프의 근거로 승격됐으나, 실제로는 WB 안 타제품(퀵카밍) 절에서 나온 근거였다.

**근본원인**: `ingest.py:517-545` — evidence 를 WB **전 절(clause) 무차별** 수집한다(부정·계획 절만 제외). 제품 소속 판정이 없다.
`func`(기능성 상태)·`certs`(인증)·`notified`(고시성분)·`unsupported` 도 같은 방식으로 전-WB 평면 수집이라 동일 취약.

**수정 — 선언제품 기준 결정적 제품 섹션 스코핑**:
1. **1단계(호출부 전달)**: `ingest-bundle.sh` 가 state.json 의 `product.name` 을 읽어 `claim-basis` 호출에 3번째 인자로 전달한다(스크립트만 state 읽음 — 규칙 준수). `_extract_product_facts`(voc 경로)도 동일하게 전달.
2. **2단계(WB 세그먼터)**: `ingest.py` 에 결정적 세그먼터 추가 —
   - 마크다운 헤딩(`#`/`##`/`###`) 경계 + 제품 마커(`제품명:`/`제품유형:`/제품명 문자열)로 WB 를 제품 섹션으로 분할.
   - 헤딩이 없으면(평문 WB) 제품명 출현 지점을 경계로 사용(폴백 세그먼트).
3. **3단계(선언제품 국소화)**: 선언 제품명이 **정확히 한 섹션**에 국소화되면 → `func`·`evidence`·`certs`·`product_type`·`notified`·`unsupported` 를 **그 섹션(+ 제품마커 이전 공용 서두)에서만** 추출.
4. **4단계(fail-open 폴백)**: 섹션이 1개(단제품)거나, 선언명 미발견/2섹션 이상 매칭(모호)이면 → **현행 전체-WB 추출로 폴백**. 폴백 시 stderr 감사 1줄("다제품 국소화 실패 → 전체-WB 추출, 사람 확인 권장").

**후방호환**: 단제품 WB(씨앗 WB = 제품마커 1개)는 섹션 1개 → 전체-WB → **골든 바이트 불변**. 다제품이지만 모호한 경우도 오늘과 동일(전체-WB) — 절대 나빠지지 않는다.

**위험·완화**: 세그먼트 휴리스틱 오분류. 완화 = 명백한 다제품(제품마커 ≥2 + 선언명 정확히 1섹션)일 때만 스코핑, 그 외 전체-WB 폴백. 모호 다제품은 감사 로그로 가시화(사람 확인).

---

## M-3. reference_images:[] 자기거부 (LOW — 견고성)

**증상(실측·릴리프 E2E)**: `00g-guideline` stand-in(`examples_analysis.py`)이 detail 이미지 없는 크롤 3건(coupang_6484363424·9525442925·9542212705 = `images/main` 만 있고 `images/detail` 없음)에 `reference_images:[]` 를 산출 → 같은 저장소의 `validate-stage` 가 fail-closed 거부. stand-in 산출물이 자기 검증을 못 통과. (opus 는 main 이미지 기반 항목을 수동 보강해 우회.)

**근본원인**:
- `examples_analysis.py:326-330` — `_reference_images` 가 `_list_detail`(=`images/detail/`)만 매핑. detail 이 비면 루프가 즉시 break → 빈 리스트.
- `validate-stage.sh:304` — `if not ri: sys.exit(2)` (무조건 비어있지않음 — 우회 차단 목적, 의도된 가드).

**수정 — 메인이미지 폴백**:
- `_reference_images` 가 `images/detail/` 이 비면 **`images/main/` 파일로 폴백**해 ≥1건 생성(크롤이 실제 가진 이미지). src=`images/main/<file>` 은 validate 검사(디자인자산 `inputs/assets/` 아님 · 비어있지않음 · 화이트리스트 태그 · why 자기인용)를 통과.
- detail 이 있는 크롤 → 기존 경로 유지(**무변경**).
- detail·main **둘 다 없는** 진짜 빈 크롤 → 여전히 빈 리스트 → validate 거부(정당 — 불완전 크롤이지 stand-in 버그 아님).
- `validate-stage` 무조건 비어있지않음 검사는 **유지**(우회 차단 가드 보존).

**후방호환**: 기존 골든 example 크롤이 모두 detail 보유면 무변경(바이트 불변). 회귀에서 확인.

---

## 실행 계획 (dev-loop)

**브랜치**: `fix/multiproduct-extraction-boundary` (main `6f5679b` 기준).

**Wave 1 (병렬 — 파일 disjoint)**:
- **Stage A (M-1+M-2)**: `ingest.py`(세그먼터 + 선언제품 스코핑 + fail-open) + `ingest-bundle.sh`(product.name 전달) + 신규 픽스처(다제품 WB → 선언제품 스코핑 검증 · 단제품 WB 골든 바이트 불변).
- **Stage B (M-3)**: `examples_analysis.py`(main 이미지 폴백) + 신규 픽스처(detail 없는 크롤 → main 폴백 · detail 있는 크롤 무변경).

두 스테이지 파일 겹침 없음(A=ingest / B=examples_analysis). validate-stage.sh 는 무변경(M-3 는 생성기만 고침).

**스테이지별 Codex 적대 리뷰 → critical/high 0 수렴**.

**회귀 게이트(오프라인)**:
- 넓은 골든 green: b0/b1*/b3/routes/components/drug-*/clinical-*/evidence-*/intake/image-engine.
- **단제품 WB 골든 바이트 불변**(핵심 후방호환).
- 신규 회귀: `test-multiproduct-extraction.sh`(가칭) — 다제품 WB 픽스처 → 선언제품 국소화·타제품 혼입 0·모호 폴백 감사 · detail없는 크롤 main 폴백.

**커밋 규율**: 커밋마다 `docs/workflow-ssot.md` 동반 갱신(부록별 소유 구역 + 헤더 갱신 날짜·요약). state.json 스크립트-단독.

## 완료 기준(수용 조건)

1. 다제품 WB 픽스처에서 선언 제품(릴리프)만 스코프 → `product_type` 정확 · `evidence` 에 타제품 근거 0.
2. 모호/단제품 → 전체-WB 폴백(감사 로그) · **단제품 골든 바이트 불변**.
3. detail 없는 크롤 → `images/main` 폴백으로 `reference_images` ≥1 → validate 통과. detail 있는 크롤 무변경.
4. 넓은 오프라인 회귀 green · Codex critical/high 0.

## 고지

본 수정은 다제품 입력 일반화의 추출 정확도 개선이며, 최종 책임은 사람(현업/RA)에게 있다(AGENTS.md 7번 절). 모호 다제품 WB 는 폴백 후 사람 확인이 권장된다.
