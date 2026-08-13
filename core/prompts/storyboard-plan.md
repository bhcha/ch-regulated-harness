# 프롬프트 — 기획안(본문, 블록 단위)

확정된 스토리라인의 각 블록에 대해 본문 기획안을 **블록 단위**로 작성한다.

## 계약 (ICM — 이 단계의 입출력 경계)
- **Inputs** (`build_context` 라벨): CONCEPT_DECISION · CLAIM_BASIS · REGULATORY_DOMAIN · RULESET · STORYLINE · DELIVERABLE_FORMAT · REFERENCE_NOTES · REFERENCE_IMAGES · PRODUCT_FACTS · EVIDENCE_DOCS · REFERENCE_DOCS
- **Process**: ① 전역 아트디렉션 1회 정의 → ② 확정 스토리라인의 블록별 본문 기획(주장-각주 페어링 강제, 구도/무드/참조를 visual.concept 에 직접 산출, 아트디렉션 상속).
- **Outputs**: `03-storyboard/art-direction.json`(harness/art-direction.schema.json, **먼저**) · `03-storyboard/plan/NN-<type>.json`(harness/plan-block.schema.json) · 사람용 `plan/NN-<type>.md`
- **결손 입력 처리(품질 권고)**: 입력에 `(미제공 …)` 으로 표시된 항목은 '있으면 품질이 오르는' 선택 입력이다 — 없으면 **그 부분을 절제해 쓰고(없는 사실을 지어내지 말 것)**, 채우면 좋을 점은 사람용 `plan/NN-<type>.md` 에 'ⓘ 보강 권장'으로 남겨라. 임상 측정치 차트 블록은 **측정 전·후 값·시험기관·참여자 수·시험기간**이 근거(claim-basis evidence)에 모두 있을 때만 만든다 — 하나라도 없으면 그 블록을 만들지 말고(환각 금지) '실증 자료 보강 필요'로 표시한다. 변화율·p값은 있으면 신뢰도가 오르는 권고 항목이다.
- **근거 문서 반영(EVIDENCE_DOCS — 첨부=반영, 필수)**: `EVIDENCE_DOCS` 에 `doc-NN` 항목이 있으면 **그 문서를 반영하는 전담 블록을 반드시 만든다**(반영 누락 시 done 게이트가 차단). ① **정성**(측정값 없음 — 사용적합·적합판정 류): `clinicalEvidence` 블록을 `visual.render_mode:"html_only"` 로 만들고, 카피는 선언 **판정문(원문) 그대로**만 쓰되(예: 시험 판정문 원문 그대로) 병기로 **시험기관·참여자 수(n)·시험기간** + 고정 디스클레이머 `개인에 따라 차이가 있을 수 있습니다` 를 넣는다. 측정 수치·효능 단정은 넣지 않는다. ② **정량**(측정값 있음): 기존 `clinicalEvidence`/`beforeAfter` + `chart_data` 경로(측정 차트·5요소)로 만든다. **여러 시험 항목**(예: 여러 정량 지표)이 `EVIDENCE_DOCS` 에 `test_items` 로 오면 **항목마다 별도 블록(TEST 01/02/03 식)**으로 만들어 각 차트를 렌더한다. ⚠ **근거 결박(중요)**: 각 항목은 claim-basis 에 별도 근거 레코드로 승격돼 있고 그 **근거 id 를 `EVIDENCE_DOCS` 각 시험항목 줄에 '근거 id(…): doc-NN-tKK' 로 알려준다** — 그 블록의 차트 강주장 `claims[].evidence_ref` 에는 **그 항목 근거 id(`doc-NN-tKK`)**를 쓴다(차트 수치 결박). 그리고 그 블록의 **각주(`footnotes[].text`)에는 문서 id `[doc-NN]`을 인용**한다(반영·인용은 문서 단위 — 각주에 doc-NN 이 있어야 done 반영 게이트가 그 문서를 반영으로 인정). 즉 차트 evidence_ref=항목 id, 각주=[doc-NN] 둘 다 넣는다. 그리고 그 항목에 **추출된 시험 이미지(전후 사진 등)** 가 있으면(EVIDENCE_DOCS 줄의 '시험이미지(자사 <img>)' 또는 claim-basis `image_path`) 그 블록의 `visual.reference.own_asset_path` 를 **그 추출 이미지 경로로 지정**해 차트 옆에 이어붙인다(실BM TEST 02/03: 차트→전후사진→시험기관 캡션 레이아웃). 추출 이미지는 자사 자산(`inputs/assets/evidence/…`)이라 정당한 `<img>` 대상이다. ③ 두 경우 모두 그 블록의 각주가 `doc-NN` 을 인용하고, 해당 판정 카피 claim 은 `evidence_ref: "doc-NN"` 로 결박한다(`target_text` 는 판정문 원문의 부분문자열 — **원문 밖 단정어[무자극·저자극 등] 확장 금지**, validate 에서 fail-closed). `reflect:false`(EVIDENCE_DOCS 에 안 뜸)인 첨부는 반영하지 않는다.
- **판정문 카피 = 1차 점검 리뷰0 억제 면제 조건(결박 필수)**: 판정문 원문을 인용하는 카피는 그 claim 에 반드시 `evidence_ref: "doc-NN"`(해당 test_report 문서)를 달고 `target_text` 를 그 문서 판정문 원문의 **정확한 부분문자열**로 둔다 — 이 결박이 있어야, 아직 소비자 리뷰가 0건인 효능어(예: 특정 효능어)를 담은 판정 카피라도 그 결박된 한 점에 한해 1차 점검의 리뷰0(수요 근거 없는 개념) 억제에서 면제된다. 결박 없이(또는 test_report 아닌 문서·부분문자열 아님) 같은 단어를 헤드라인·컨셉 주축·다른 자리에 쓰면 여전히 억제된다.
- **참조 문서 반영(REFERENCE_DOCS — 첨부=반영, 일반 참조 필수)**: `REFERENCE_DOCS` 에 `doc-NN` 항목이 있으면 그 문서의 **반영 포인트(원문)를 내용에 가장 맞는 블록**(성분자료→`ingredientTech`, 브랜드스토리→`brandBanner`, 수상·인증→`socialProof`, 가이드→`howToUse` 등)의 카피(headline/subcopy/bodyText)에 **원문 그대로** 넣고, 그 블록 **각주(`footnotes[].text`)에 `doc-NN` 을 인용**한다(반영 누락 시 done 게이트 차단). ⚠ 일반 참조 문서는 실증셋(claim-basis)이 아니므로 `claims[].evidence_ref` 로 인용하지 마라(가짜 인용으로 심의 반려) — **각주 인용만**. 반영 포인트 원문 밖 내용을 지어내지 말 것(환각 금지).

## 전역 아트디렉션(먼저 — 이슈4 P0-ⓠ, 톤 일관성 선결)
- 블록보다 **먼저** `03-storyboard/art-direction.json` 을 1회 작성한다: `master_palette`(전 블록 공통 팔레트)·`color_temp`·`lighting`·`typography` + `master_reference` = **선택한 제품의 실제 사진**(ASSETS_MANIFEST 의 자사 제품컷, `inputs/assets/`). 톤의 기본값은 디자인 토큰이 정한다 — REGULATORY_DOMAIN 팩에 `design-tokens-overlay.json` 이 있으면 **그 `tone_directions`·`visual_guidance` 를 우선 반영**한다(도메인 축; 없으면 포맷 토큰 `packs/_format/design-tokens.json`). 모든 블록 이미지가 이 한 장을 공통 첫 입력으로 써 '바로 그 제품'을 일관 유지한다. ⚠ PoC 샘플 시드(`product-main.jpg` 등 다른 제품)나 일반 도형을 master_reference 로 쓰지 마라.
  - **master_reference 선택 힌트(soft)**: ASSETS_MANIFEST 에 `role=package_front` 자산이 있으면 그것을 master_reference 로 우선 선택하라(제품 정면컷이 브랜드·패키지 식별에 가장 강함). 게이트가 아니라 권고다 — 없으면 기존대로 자사 제품컷 중 대표 1장을 고른다.
- 이후 모든 블록 `visual.concept` 는 이 아트디렉션을 **상속**한다 — 블록은 `composition`·`subject`·`aspect_ratio` 등 **고유만** 둔다. 블록 `palette` 는 `master_palette` 의 **부분집합**이어야 한다(검증 fail-closed). 블록마다 다른 경쟁사 스타일/무드에 앵커하지 말 것.
- `mood_keywords`·`master_reference` 등 아트디렉션 텍스트에도 효능·질환·권위·절대 표현 금지.

## 규칙 (주장-각주 페어링 강제)
- 블록마다 `plan/NN-<type>.json` 1개 (harness/plan-block.schema.json).
- 필드: `type,order,headline,subcopy,bodyText[],visual{kind,concept{…}},claims[],footnotes[],approval_state`.
- **모든 블록은 `visual.concept` 필수**(M3 tone 흡수) — 최소 `composition` 또는 `mood{…}` + `reference.own_asset_path`(`inputs/assets/` 자사 자산). 누락 시 검증 반려.
- `claims[]` 의 `claim_strength` 가 superlative/efficacy/speed 면 **대응 footnote 필수** + `evidence_ref` 가 실재 근거 id.
  근거가 없으면 표현을 factual/emotional 로 절제하라.
- socialProof(순위/판매)는 기준일·출처 각주 필수.
- **(multipage_bm) 구매전환 블록 금지**: DELIVERABLE_FORMAT 이 `multipage_bm`(세로 상세페이지)이면 `cta`(구매하기·가격·장바구니)·`header`·`nav` 블록을 만들지 않는다 — 상세페이지는 판매채널 구매 UI '앞'의 콘텐츠다. CTA·가격 블록은 `one_pager` 전용이다(검증에서 강제 — 있으면 반려된다). `footer`(도메인 필수기재 컨테이너)·품목 심화(`mainPositioning`·`ingredientDetail`) 블록은 금지 대상이 아니다.
- 위반 블록만 부분 재생성(전체 재생성 금지 — 비용·이력 보존).
- 사람이 읽을 `plan/NN-<type>.md` 도 함께.

## 이미지 컨셉(visual.concept — 기획안 내부에 직접 산출; M3 tone 흡수)
- 블록마다 구도/무드/참조를 `visual.concept` 로 **직접 작성**한다(별도 톤 선택 단계 없음 — 기획안이 곧 톤·구도 확정).
- `visual.concept = {subject, composition, mood{color_temp,lighting,texture}, palette[], typography, aspect_ratio, handoff_note, reference{own_asset_path(^inputs/assets/), direction, crawl_pattern_ref, reference_image_id, pixel_reference_allowed}}`.

### 블록 subject/composition — 사진형 vs 그래픽 (P0-3, 디자이너 핸드오프 전제)
> 이 BM 은 **디자이너 핸드오프 시안**이다(docs/bm-designer-handoff-plan.md). **전 블록이 이미지로 생성된다**(수치 차트 블록만 예외). 한글 카피가 이미지에 다소 깨져도 무방(디자이너가 재조판) — 대신 실BM 처럼 브랜드 톤·뱃지·타이포가 살아있는 '디자인'을 보여주는 것이 목표다.
- **사진형 블록**(`hero`·`problem`·`solution`·`ingredientTech`·`howToUse`·`targetAudience`): `subject`·`composition` 은 **실제 제품·성분·사용 장면의 사진 연출**로 쓴다(`macro`·`closeup`·`product_focus`·`context_scene`). `render_mode` 는 생략(또는 `"image"`). 사진형은 인-이미지 신규 텍스트를 굽지 않는다(제품 라벨 보존 + 카피는 HTML 레이어).
- **그래픽/인포그래픽 블록**(`rtbSummary`·`socialProof`·`brandTrust`·`brandBanner`·`reviewCapture`·수치 차트 없는 `clinicalEvidence`): `visual.render_mode = "html_only"` 로 표시하고, `subject` 에 **만들 디자인을 구체적으로 기술**한다 — 아이콘+카피 요약 카드·판매/수상 뱃지 클러스터·브랜드 배너·리뷰 말풍선·인증 스탬프 등(실BM 처럼). 이 블록도 **이미지로 생성**되며(온라인), 그래픽 프롬프트 분기로 **디자인 한글 카피·뱃지·배너를 인-이미지로 렌더**한다. `ART_DIRECTION` 팔레트를 상속해 페이지 톤을 통일하라.
  - ⚠ **브랜드 픽셀-락(P-4)**: 그래픽 블록도 `reference.pixel_reference_allowed: true` + `reference.own_asset_path`(art-direction.master_reference = 선택 제품의 실제 제품컷)를 **반드시 유지**한다 — 픽셀 레퍼런스 없이 텍스트만으로 그래픽을 생성하면 모델이 가짜 브랜드/로고(예: GREEN ESSENCE)를 지어 굽는다. 실제 제품컷을 image-to-image 로 보내 브랜드를 픽셀에 고정하라(그 위에 실제 브랜드명만 표기, 타 브랜드 발명 금지).
  - ⚠ **`render_mode:"html_only"` 의 뜻(전제 전환)**: 예전엔 '이미지 미생성(HTML/SVG 전용)'이었으나, 이제는 **'사진형이 아니라 그래픽 디자인 블록'이라는 표식**이다 — 온라인 실엔진은 이 블록도 이미지로 굽고(그래픽 프롬프트), CI/오프라인(stub)에서만 이미지 생성을 건너뛴다(결정성). 그러니 사진형/그래픽 어느 쪽이든 자유롭게 표시하되, 사진형에 html_only 를 붙이면 그래픽 프롬프트로 생성돼 어색할 수 있으니 성격에 맞게 표시하라.
  - `visual.kind` 는 `"photo"` 로 둔다. `kind:"graph"` 는 **실증(chart_data) 측정 차트 전용**이며, 실증 미등록 런에서 graph 비주얼은 `validate_storyboard` 가 환각 차단으로 거부한다.
- (참고) `render_mode` 부재 = 사진형(이미지 생성, 후방호환). 수치 차트(`visual.chart_data`)를 가진 clinicalEvidence/beforeAfter 는 render_mode 와 무관하게 **이미지로 굽지 않고 인라인 차트로 렌더**된다(아래 절 — 데이터 날조 금지·규제 장치).

### 리드/메인 이미지엔 자사 제품을 주피사체로(P1-1)
- **리드(첫 블록)와 hero 블록의 `subject` 는 자사 제품을 주피사체로** 둔다(메인 화면에서 우리 제품이 또렷이 식별되게). 이 블록들은 사진형으로 두고 `reference.own_asset_path`(이 run 의 실제 제품 사진)를 화면 초점에 둔다.
- 특히 **problem 블록이 앞(리드)에 오면** '경쟁/기존 제품의 문제'만 보여주지 말고 **자사 제품을 화면 안에 초점으로 포함**하라 — 예: 얇은 자사 패치를 손에 들거나 피부에 자연스럽게 대 두께 차이를 대비. problem-first 의 공감 후킹은 살리되 첫 화면에서 제품 식별을 확보한다. (블록 순서 자체는 바꾸지 않는다 — 카피는 HTML 레이어 담당.)

### 예외 — clinicalEvidence/beforeAfter 블록의 인체적용시험 수치 차트 (`visual.chart_data` 보유 시)
인체적용시험 측정값(정량 지표의 % 변화)이 있는 `clinicalEvidence`/`beforeAfter` 블록에서
**`visual.chart_data` 를 채운 경우**(수치 차트):
- `visual.concept` 는 **스키마 필수 요소를 그대로 채운다** (subject + reference.own_asset_path 필수).
  단, **`chart_data` 가 있는 블록은 이미지 생성 대상이 아니다** — image_engine 이 그 블록을 건너뛰므로 생성 PNG/SVG를 기대하지 마라(차트로 렌더). `chart_data` 가 없으면 일반 블록처럼 생성 이미지가 만들어진다.
- **추가로** `visual.chart_data`를 채운다. ⚠ **차트 수치는 evidence 레코드에서 결정적으로 도출되며, 검증은 정확 일치(허용오차 없음)다**:
  - `chart_type`: `"bar"` 또는 `"line"`
  - `series[].value`: claim-basis evidence_on_file 의 실재 수치를 **그대로·같은 순서로** 넣는다. `series` 가 있으면 그 값/순서, 없으면 `[before, after]` 순. (값·순서가 evidence 와 정확히 같지 않으면 검증 반려 — 전/후를 바꿔 넣으면 방향이 뒤집혀 반려.)
  - `callouts[]`: 변화율은 evidence 의 `change_pct`(또는 `(after-before)/before*100`, 소수 1자리)와 **부호까지 정확히 동일**한 값만 쓴다(예 변화 -20% → `"-20%"` 또는 `"20% 감소"`; `"+20%"`·`"99%"` 등 불일치 값은 반려). 맨숫자 콜아웃은 series 값 중 하나여야 한다.
  - `footnote_ref`: 대응 각주 id(블록 footnotes 에 실재).
- **개인차 디스클레이머는 다음 '정확한 문자열'을 그대로** headline/subcopy/bodyText/footnotes 중 한 곳에 반드시 포함한다(verbatim, 변형·축약 금지): **`개인에 따라 차이가 있을 수 있습니다`**
- 시험기관·n수·시험기간도 사람이 읽을 수 있는 형태로 노출한다. ⚠ **시험기관명·시험기간은 EVIDENCE_DOCS/claim-basis 근거 레코드의 문자열을 글자 그대로**(A-3 — 법인 표기 `㈜` 포함, 날짜범위형이면 범위 전체) 쓰라 — 축약·의역하면 실증 맥락 검출이 실패해 반려된다(예: subcopy = "가나다 피부과학연구소㈜ 인체적용시험, 52명, 4주. 개인에 따라 차이가 있을 수 있습니다"). p값은 있으면 함께 노출(권고)이며 필수 조건은 아니다.
- `chart_data` 가 있는 이 블록은 keyvisual 단계에서 `<img src>` PNG가 아닌 **인라인 SVG/HTML 바 차트**로 렌더된다.
- `reference.own_asset_path` = **선택한 제품(이 run 의 제품)의 실제 사진**(ASSETS_MANIFEST 의 자사 제품컷, `inputs/assets/`). 모든 블록이 **같은 제품 사진 1장**을 가리켜 일관성을 유지한다(art-direction.master_reference 와 동일). PoC 샘플 시드(예: `product-main.jpg`)나 다른 제품 이미지를 쓰지 마라.
- `reference.pixel_reference_allowed` = **true**(이미지 생성 시 그 실제 제품 사진을 image-to-image 참조로 보내 '바로 그 제품'을 보존). ⚠ 이게 false 면 텍스트만으로 생성돼 모델이 **유명 실존 브랜드로 치환·환각**한다(자사 제품명이 비슷한 실존 브랜드로 바뀌어 구워짐). 반드시 true.
- 생성 이미지에는 **브랜드명·글자를 렌더하지 않는다**(한글 on-image 정확도 낮음 + 오브랜드 글자 환각). 브랜드·카피는 키비주얼 HTML 레이어가 담당.
- `reference.direction` 은 크롤 베스트프랙티스의 **텍스트 방향**만. `own_asset_path` 는 자사 자산(`inputs/assets/`)만.
- (있으면) `REFERENCE_NOTES`(크롤 참조 — 현업이 좋다고 한 **구도/무드**)를 visual.concept 의 구도/무드 방향에 **참조**한다(soft; 효능·절대 표현 금지).
- (있으면) `PRODUCT_FACTS`(가격·구성·성분 함량)를 블록 본문의 **사실 후크**로 활용한다(효능 단정·최상급 금지).
- 컨셉 텍스트(composition/handoff_note/direction 등)에도 효능·질환·권위·절대 표현 금지(kcia revise 대상).

state.json 은 건드리지 마라.
