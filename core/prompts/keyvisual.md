# 프롬프트 — 키비주얼/디자인 (포맷별 HTML/CSS)

확정 기획안을 **산출물 포맷(`DELIVERABLE_FORMAT`)에 맞는 HTML/CSS 3안(이슈3a: 최소 3안)**으로 디자인한다. 레이아웃은 아래 "포맷별 레이아웃"으로 분기한다.

## 계약 (ICM — 이 단계의 입출력 경계)
- **Inputs** (`build_context` 라벨): ASSETS_MANIFEST · REGULATORY_DOMAIN · RULESET · DELIVERABLE_FORMAT · STORYLINE · STORYBOARD_PLAN · ART_DIRECTION · IMAGE_MANIFEST · REFERENCE_IMAGES · REFERENCE_NOTES · PRODUCT_FACTS · EVIDENCE_DOCS · REFERENCE_DOCS
- **Process**: 확정 기획안을 `DELIVERABLE_FORMAT` 레이아웃 규격의 HTML/CSS **3안 이상**으로 디자인(자사 자산만, 크롤 원본 금지). `EVIDENCE_DOCS` 반영 블록(정성 인증-표시형 `clinicalEvidence`)은 `render_mode:"html_only"`(그래픽 블록)로 두고 인증 카드 디자인을 **인라인 HTML/SVG 로 구성**한다(F1(C) 규제안전 — baked PNG `<img>` 참조 금지). **판정문 원문·시험기관·n·시험기간·개인차 디스클레이머의 정본 텍스트를 HTML 텍스트 레이어에 그대로** 쓴다(규제 텍스트 정확성·심의 스캔 채널 — 원문 밖 단정어[무자극·저자극 등] 금지). `REFERENCE_DOCS`(일반 참조) 반영 블록도 **반영 포인트 원문 + `doc-NN` 각주 인용**을 HTML 텍스트 레이어에 표기한다(원문 밖 지어내기 금지).
- **Outputs**: `04-keyvisual/options/{A,B,C}/{index.html,styles.css,shots/}`(**최소 3안**) · `04-keyvisual/recommendation.json`(harness/recommendation.schema.json, ranked **3개 이상**) → render-design.sh 가 섹션 PNG·`04-keyvisual/design-manifest.json`(harness/design-manifest.schema.json) 생성
- **결손 입력 처리(품질 권고)**: 입력에 `(미제공 …)` 으로 표시된 항목은 '있으면 품질이 오르는' 선택 입력이다 — 없으면 절제해 디자인하고(없는 사실 날조 금지), 임상 수치 차트(clinicalEvidence/beforeAfter)는 **시험기관·참여자 수·시험기간·개인차 디스클레이머**가 갖춰진 근거가 있을 때만 그린다(없으면 그 차트를 만들지 말 것). 변화율·p값은 있으면 차트 신뢰도가 오르는 권고 항목이다.

## 포맷별 레이아웃 (`DELIVERABLE_FORMAT` 으로 분기)
- **`multipage_bm`(여러장 BM)** — 네이버 스마트스토어 규격 **860px 세로 단일 스크롤 섹션 스택**. 기획안 블록을 내러티브 순서로 적층(판매/수상 → 키비주얼 → 문제 → VOC → RTB 요약/세부 → 과학·임상 → 사용법 → 타겟 → 브랜드 배너). 막대그래프·말풍선 리뷰 등 BM 관용 표현 사용.
- **`one_pager`(한장)** — **1매 압축 포스터형**. 키비주얼 + 핵심 RTB 3~4개 + (선택)수상/판매 신호 + CTA 를 한 화면 흐름에 압축. 과도한 세로 스크롤 지양.

> 블록 타입·시퀀스는 기획안(STORYBOARD_PLAN)의 **포맷별 캐논**을 따른다(스토리보드 단계에서 포맷별로 이미 구성됨). 키비주얼은 그 블록을 포맷 레이아웃에 맞게 시각화한다.

## 규칙 (공통)
- 각 블록을 `<section data-block="<type>" data-order="N">` 으로 감싼다(DOM 단위 캡처용).
- `docs/reference/design-tokens.md` 토큰 사용: 단일 accent, 헤드라인 부분 컬러 하이라이트, **하단 각주 라인(의무 슬롯)**, 누끼 제품컷. 시각 관용 표현은 포맷에 맞게(BM=막대그래프·말풍선 / one_pager=압축 히어로).
- 셀프호스팅 폰트(`assets/fonts/PretendardVariable.woff2`)를 `@font-face` 로 로드(렌더 재현성).
  - **상대경로 깊이 — 폰트만 `../` 정확히 5단계(공유 core)**: 폰트는 공유 `core/assets/fonts/` 에 있으므로 HTML(`04-keyvisual/options/<opt>/index.html`) 기준 `../` 를 **정확히 5단계** 써야 한다(`opt → options → 04-keyvisual → <id> → runs → core`). 폰트 예시(정본): `@font-face { src: url("../../../../../assets/fonts/PretendardVariable.woff2"); }`. 폰트 정본 폴더는 `assets/fonts/` 다(`inputs/assets/fonts/` 가 아님 — 실파일 없음). ⚠ 생성이미지·자사컷은 이제 런-로컬이라 깊이가 다르다 — 생성이미지 = `../../generated/NN-type.<ext>`(2단계), 자사컷 = `../../../inputs/assets/<fn>`(3단계). 아래 '생성 이미지 우선' 규칙 참조.
- **전역 아트디렉션 상속(P0-ⓠ)**: `ART_DIRECTION` 의 `master_palette`·`color_temp`·`lighting`·`typography` 를 페이지 전체에 일관 적용한다. 블록마다 색·무드를 새로 만들지 말 것(톤 분열 방지). 색은 `master_palette` 안에서 변주.
- **생성 이미지 우선(P0-①)**: 블록 비주얼은 `IMAGE_MANIFEST` 가 가리키는 자사 생성물(런-상대 정규경로 `04-keyvisual/generated/NN-type.{png,svg}`)을 블록 `<img src>` 로 **우선** 사용한다. 해당 블록 생성 이미지가 없으면 자사컷(`ASSETS_MANIFEST`) → 그래도 없으면 타이포/도형 박스. (도형 박스를 1순위로 쓰지 말 것.)
  - ⚠ 참조 가능 여부의 단일 기준은 **`IMAGE_MANIFEST`(또는 위 '생성 예정' 예측 목록) 등재 여부**다 — **사진형 블록**은 그 블록의 생성 이미지가 `IMAGE_MANIFEST`/예측 목록에 있으면 `<img src>` 로 참조하고, 없으면(=생성 안 됨) 자사컷→타이포/도형 박스로 대체한다. **⚠ F1(C) 규제안전(docs/keyvisual-image-safety-fixes-plan.md): 그래픽 블록(`render_mode==html_only`)은 생성 이미지를 `<img>` 로 참조하지 않는다** — 인라인 SVG/HTML 텍스트 레이어로만 구성한다(아래 그래픽 블록 절). 수치 차트 블록도 인라인 차트(아래 절). 즉 **`<img>` 대상 = 사진형 생성 이미지·자사컷·차트 전후사진뿐**이다.
  - **상대경로 깊이 — 생성이미지 `../` 2단계·자사컷 3단계**: 생성이미지는 런-로컬 `04-keyvisual/generated/` 에 있으므로 옵션 HTML(`04-keyvisual/options/<opt>/index.html`) 기준 `../` 를 **정확히 2단계** 쓴다. `IMAGE_MANIFEST` 가 주는 런-상대 정규경로 `04-keyvisual/generated/NN-type.<ext>` 를 옵션 HTML 기준 `../../generated/NN-type.<ext>` 로 참조하라. 예시(정본): `<img src="../../generated/01-hero.png">`. (자사컷 ref 는 런-로컬 `inputs/assets/` 라 3단계 — `../../../inputs/assets/<fn>` 를 가리킨다.)
  - ⚠ **깊이가 틀리면 렌더 차단**: `../` 를 잘못된 단계 수로 짧게/길게 쓰면 Playwright 렌더에서 그 파일을 못 찾아 이미지가 깨지고, 존재성 게이트(`render-design.sh`)가 fail-closed 로 차단한다. 생성 단계에서 애초에 위 깊이(생성이미지 2단계·자사컷 3단계)로 정확히 써라.
  - **이미지 표시 = 자연 비율(크롭 금지, F3)**: 블록 `<img>` 는 **원본 비율 그대로** 표시한다 — `width:860px`(BM) 또는 `max-width:100%` + **`height:auto`**. ⚠ **고정 height 박스 + `object-fit:cover` 금지**(예 `.block-img{height:645px;object-fit:cover}`): 생성 이미지는 블록마다 aspect 가 제각각(와이드·세로)이라 고정 4:3 박스에 cover 로 담으면 제품컷 가장자리(맨 끝 제품·라벨)가 상하좌우로 잘린다. 스크롤형 상세페이지는 섹션 높이가 이미지별로 달라도 무해하다. (레터박스가 필요하면 `object-fit:contain`+배경 — cover 금지.) 생성측도 목표 aspect 로 규격화(패드, image_engine 후처리)해 크롭 0·블록 간 정렬을 맞춘다.
- **예외 — clinicalEvidence/beforeAfter 수치 차트 블록 (`visual.chart_data` 가 있는 경우만)**: `visual.chart_data` 가 있으면 그 블록은 **`<img src>` PNG로 렌더하지 않는다** — image_engine 이 그 블록을 건너뛰어 생성 이미지가 없으므로, `visual.chart_data` 의 수치를 읽어 **인라인 `<svg>` 또는 HTML bar/line 차트**로 직접 렌더한다. **`chart_data` 가 없으면** 그 블록은 일반 블록처럼 `IMAGE_MANIFEST` 의 생성 이미지를 `<img src>` 로 사용한다(차트 강제 아님).
  - 수치 콜아웃(`callouts[]`)을 차트 안에 표시.
  - 캡션에 시험기관·n수·시험기간을 노출하되, **시험기관명·시험기간은 근거 레코드 문자열 그대로**(A-3 — 법인 표기 `㈜` 포함, 날짜범위형이면 범위 전체) 쓴다 — 축약·의역하면 실증 맥락 검출이 실패해 반려된다(p값은 있으면 함께 노출 권고).
  - 개인차 디스클레이머는 **다음 정확한 문자열을 그대로** 캡션 또는 각주에 반드시 삽입한다(verbatim, 변형 금지): **`개인에 따라 차이가 있을 수 있습니다`** (사람 2중 승인 대상).
  - **차트 수치는 claim-basis evidence_on_file 에서 결정적으로 도출된 값만 쓴다 — series 값·순서는 evidence 와 정확히 같아야 하고, % 콜아웃은 변화율과 부호까지 정확히 일치해야 한다(환각·스왑·부호반전 금지).**
  - **매칭 시험 이미지 페어(참고문서 추출)**: 그 evidence 항목에 `image_path`(참고문서에서 추출한 전후 사진 등, `inputs/assets/evidence/…`)가 있으면 **인라인 차트 아래(또는 옆)에 그 추출 이미지를 `<img src>` 로 이어붙인다**(실BM TEST 02/03 레이아웃: 차트 → '사용 전/사용 후' 전후사진 → 시험기관·n·기간·개인차 캡션). 추출 이미지는 자사 자산이라 정당한 참조다(경로 깊이는 자사컷 규칙과 동일). 이 이미지는 원본 시험 사진 그대로이므로 캡션만 HTML 로 얹는다(굽지 않음).
- **그래픽/인포그래픽 블록 (`visual.render_mode == "html_only"`) — 인라인 SVG/HTML 로만(F1(C) 규제안전)**: 뱃지·배너·아이콘·카드·요약표 등 그래픽 성격 블록은 **인라인 `<svg>` 선화 + HTML 카드/뱃지/배너**로 직접 구성한다. **생성 이미지(baked PNG)를 `<img>` 로 참조하지 말 것.** 확산모델은 그래픽/인포그래픽에 없는 인증(FDA)·수상·순위·수치를 창작(환각)해 굽고, 그게 shots 스크린샷 → 협회 제출 패키지로 새면 허위표시(약사법·표시광고법 위반)가 된다. `check_render_refs.py` 가 그래픽 블록의 생성 PNG `<img>` 참조를 **전 도메인 fail-closed** 로 막는다(규제도메인 drug/quasi_drug/health_food 은 image_engine 이 애초에 미생성, 화장품은 디자이너 참고로 굽되 옵션 HTML/export 에는 안 실림). 위 `chart_data` 예외와는 별개(차트 블록은 항상 인라인 차트). `render_mode` 부재 = 사진형(후방호환).
  - ⚠ **카피는 HTML 텍스트가 정본(게이트·접근성 채널)**: 그래픽 블록은 이미지에 굽지 않으므로 헤드라인·RTB·판정문 등 정본 카피가 그 `<section>` 의 HTML 텍스트 레이어에 그대로 존재한다 — 심의 텍스트 스캔·evidence 원문 생존·카피 추출·접근성이 이미지 밖에서 정상 작동한다(RCA 7-3).
- **아이콘은 인라인 SVG 선화(P0-②)**: 성분/포인트/사용법 아이콘은 **빈 동그라미·빈 점 금지** — 의미를 담은 인라인 `<svg>` 선화(stroke, currentColor)로. 외부 아이콘 폰트·이미지 금지. 항상 텍스트 라벨 동반.
- **사진형 블록의 텍스트는 HTML 오버레이(픽셀에 굽지 말 것)**: **사진형 블록**(제품·성분·사용장면 사진)에서 캡션·수치·라벨은 이미지 픽셀에 **굽지 말고** 사진을 배경으로 그 위에 HTML/CSS 오버레이(`position:relative`+`absolute`)로 얹는다. 원칙(사진형): **이미지 = 무텍스트 비주얼, 텍스트 = HTML 레이어** — (a) 제품 라벨 변질 회피 (b) 오버레이 텍스트가 심의 스캔·카피 추출에 정상 수집(RCA 7-3). **그래픽 블록(html_only)도 동일 원칙** — 카피·뱃지·인증·순위는 인라인 HTML/SVG 로 구성하고 baked PNG 를 참조하지 않는다(F1(C), 위 그래픽 블록 절).
- **커머스 밀도(P1-③) — `multipage_bm` 한정**: 실제 상세처럼 그라데이션 색섹션·넘버드 포인트 뱃지·스펙 콜아웃·씰을 1급 컴포넌트로 쓴다(`docs/reference/design-tokens.md`). ⚠ 밀도/시각은 자유롭게, **주장(카피·인증·수치·전후비교)은 실증·룰셋 게이트 그대로** — 가짜 인증/의약외품 오인 도장·근거 없는 수치 금지.
- **모든 보이는 텍스트 = 실 DOM 텍스트(O-5)**: 번호·뱃지·라벨·씰 등 화면에 보이는 글자는 **모두 실제 HTML 텍스트 노드**(`<span>01</span>` 처럼)로 쓴다. **CSS 생성 텍스트 금지** — `content:"01"`·`::before`/`::after` 로 번호·라벨을 넣지 말 것. 필수기재(제품명 등) 검증이 CSS 생성 콘텐츠를 신뢰 불가로 처리해 규정 점검이 멈춘다(제품명 glue-risk 가드 fail-closed). 넘버드 뱃지도 CSS 카운터(`counter()`)가 아니라 실 텍스트로.
- **저작권**: `<img src>` 는 자사 자산(`inputs/assets/`)·생성물(`04-keyvisual/generated/`)·product.json 자사 URL만. 크롤 원본(`inputs/bundle/images/`) 절대 금지.
- (있으면) `REFERENCE_NOTES`(크롤 참조 — 현업이 좋다고 한 구도/무드·플로우)를 **레이아웃·비주얼 방향에 참조**한다(soft; 픽셀 복제 아님, 효능·절대 표현 금지).
- (있으면) `PRODUCT_FACTS`(가격·구성·성분 함량)를 디자인 텍스트 요소의 **사실 후크**로 활용한다(효능 단정·최상급 금지).
- `beforeAfter` 섹션 **내부에** "연출"·"개인차" 두 토큰이 든 디스클레이머 문장을 **네가 반드시 직접 써 넣어라**(A-4 — 시스템이 자동으로 넣어주지 않는다; `check_beforeafter.py` 가 섹션 단위로 사후 차단만 한다). 사람 2중 승인 대상.
- **필수기재**(의약품 광고심의필 등): `final_page_phase` 가 가리키는 최종 페이지(예: 최종 섹션 푸터)에 반드시 포함(누락 시 게이트 반려 — 부록A-6).
- **보완(revise) 시 근거-연결 카피는 기획안과 동반 갱신(O-6)**: 각주(`doc-NN`)가 달린 근거-연결 문장(판정문·인증-표시·전후 수치 등)을 고칠 때는 **`STORYBOARD_PLAN`(03-storyboard/plan)의 해당 블록 claim `target_text`·각주 텍스트도 같은 표현으로 함께 갱신**한다. 심의(원격 ADK) 통과용으로 키비주얼 HTML 카피만 바꾸면, done 전이의 반영강제 게이트가 보는 기획안 claim/각주와 어긋나 막힌다(두 게이트가 같은 문자열을 봐야 통과). 게이트를 완화하지 않는다 — 원문주의(반영 실효성) 유지.

## 산출물
- `04-keyvisual/options/{A,B,C}/{index.html,styles.css,shots/}` (최소 3안)
- 이후 `bash scripts/render-design.sh <run_id>` 가 로컬 Playwright 로 섹션 PNG + design-manifest.json 생성(뷰포트 폭은 포맷 채널에서 자동: BM/one_pager=860).

state.json 은 건드리지 마라.
