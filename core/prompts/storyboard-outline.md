# 프롬프트 — 스토리라인(포맷별 캐논 아웃라인)

선택된 컨셉을 **산출물 포맷(DELIVERABLE_FORMAT)에 맞는 캐논**에 배치한 **스토리라인 3안(이슈3a: 최소 3안)**을 만든다.

## 계약 (ICM — 이 단계의 입출력 경계)
- **Inputs** (`build_context` 라벨): BRIEF · CONCEPT_DECISION · CLAIM_BASIS · REGULATORY_DOMAIN · RULESET · DELIVERABLE_FORMAT · REFERENCE_NOTES · PRODUCT_FACTS · EVIDENCE_DOCS · REFERENCE_DOCS
- **Process**: 선택 컨셉을 포맷별 캐논에 배치한 스토리라인 **3안 이상**(실증 미등록 블록 자동 제외). `EVIDENCE_DOCS` 에 반영 문서(`doc-NN`)가 있으면 스토리라인에 그 **반영 블록**(정성=인증-표시형 `clinicalEvidence`)을 반드시 배치한다(하류 done 게이트가 반영 누락을 차단). `REFERENCE_DOCS`(일반 참조 문서)가 있으면 그 반영이 들어갈 **내용 적합 블록**(성분→`ingredientTech`·브랜드→`brandBanner`·수상/인증→`socialProof` 등)도 스토리라인에 포함한다.
- **Outputs** (스키마 harness/*.schema.json): `03-storyboard/outline/options/{A,B,C}/storyline.json`(storyline, **최소 3안**) · `outline/recommendation.json`(recommendation, ranked **3개 이상**) · `03-storyboard/sources/results.json`(results)

## 규칙
- **M7(포맷별 캐논)**: 블록 구성을 DELIVERABLE_FORMAT 에 맞춘다 — `multipage_bm`=BM 캐논 블록으로 구성한 세로 상세페이지(블록 집합·순서의 SSoT = docs/reference/canon-blocks.md 의 BM 캐논 = storyline.schema.json enum 의 BM 블록군 hero~buyingGuide + 확장 motionDemo), `one_pager`=1매 압축(키비주얼+핵심RTB요약+(수상/판매)+CTA). 포맷별 **필수 구성요소**는 해당 포맷 커버리지 캐논(packs/_format/canon-components.<format>.json)을 충족해야 한다(누락 시 커버리지 fail). BM 캐논을 다른 포맷에 강제하지 마라. **도메인이 요구하는 확장 블록은 가법으로 허용**한다 — 예: 의약품 BM 의 `footer`(광고심의필·제조판매원 등 필수기재 컨테이너)·`mainPositioning`·`ingredientDetail`(품목 심화)는 정당하니 필요하면 쓴다.
- **multipage_bm 구매전환 블록 배제(구매/가격/CTA 없음)**: `multipage_bm`(세로 상세페이지)에는 **구매전환 UI**(`cta` = 구매하기·가격·장바구니)와 **웹 크롬**(`header`·`nav`)을 넣지 않는다 — 상세페이지는 판매채널의 구매 UI '앞'에 놓이는 콘텐츠다. CTA·가격 블록은 `one_pager` 전용이다. (이 배제는 검증에서 강제된다 — `multipage_bm` 에 이런 블록이 있으면 스토리보드 검증에서 반려되니 애초에 만들지 마라.) 단 `footer`(의약품 필수기재)·품목 심화 블록은 **배제 대상이 아니다**.
- 전개 순서 **3안 이상**(예: A=문제공감/대안 선행, B=기본 순서, C=솔루션/근거 선행). 각 안은 서로 구별되는 전개여야 한다.
- (있으면) `REFERENCE_NOTES`(크롤 참조 — 현업이 좋다고 한 **전체 상세페이지 플로우**·구도)를 **참조**해 스토리라인 전개 순서에 반영한다(soft; 효능·절대 표현 차용 금지, 법=룰셋 우선).
- (있으면) `PRODUCT_FACTS`(가격·구성·성분 함량)를 스토리라인 소재로 활용한다(사실 후크, 효능 단정 금지).
- `clinicalEvidence`·`beforeAfter` 블록은 **claim-basis.evidence_on_file 가 비어있지 않을 때만** 포함한다.
  실증 미등록이면 해당 블록을 스토리라인에서 **자동 제외**(환각 그래프/대비 차단). `enabled_if` 명시.
- 실증 대상 표현 감지 시 `03-storyboard/sources/` 에 근거를 수집한다(PoC 는 **수동 mock**: query.json + results.json).
  보도자료/블로그 grade 는 거부. 트리거 없으면 results 는 빈 배열 + evidence_sufficient=false.

## 산출물
- `03-storyboard/outline/options/{A,B,C}/storyline.json` (harness/storyline.schema.json, 최소 3안)
- `03-storyboard/outline/recommendation.json` (ranked/rationale)
- `03-storyboard/sources/{query.json,results.json}` (results → harness/results.schema.json)

state.json 은 건드리지 마라.
