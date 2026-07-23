# 키비주얼 이미지 라벨/텍스트 변질·리드 이미지 개선 계획 (plan only)

> 상태: **구현 중(dev-loop, 브랜치 `feat/keyvisual-html-only-render`)**. 작성 2026-06-30 · 갱신 2026-06-30(구현 착수 — P0-1~P0-5·P1-1 구현, P2 후속).
> 현업 결정(2026-06-30): 리드/메인 이미지 교정은 **P1-1(problem 컷에 자사 제품 주피사체 포함, 순서 유지)** 채택. 열린 결정(6번 절) 중 1·2(명시 플래그 정본화·게이트 강제)는 **구현으로 확정**(명시 플래그 `visual.render_mode="html_only"` + P0-5 게이트 채택), 3(리드 교정)은 P1-1. 4·5(07 정책·소형 라벨 픽셀 정확도 P2)는 후속.
> **구현 범위(이번 dev-loop):** P0-1~P0-5(라벨 변질 근본 차단) + P1-1(리드 제품 부각). **이번 범위 제외(후속):** P2(원본 compositing·Pro 모델 상향 — 소형 라벨 픽셀 정확도). 코드 변경은 `image_engine.py`·`plan-block.schema.json`·`keyvisual.md`·`storyboard-plan.md`·`check_render_refs.py` 와 본 문서·`docs/workflow-ssot.md` 동반 갱신(AGENTS.md 4번 절).
> 대상 run: `core/runs/ezderm-relief-cos-multi` (제품 = 이지덤 릴리프, 화장품·플라스타 패치).
> 이미지 엔진 = Google Gemini 2.5 Flash Image(코드명 Nano Banana), image-to-image(master reference = `core/inputs/assets/ezderm-relief-product.webp`).

이 문서는 **계획만** 담는다(구현 아님). 채택 시 image_engine·keyvisual.md·storyboard-plan.md 변경과 함께 `docs/workflow-ssot.md` 를 동반 갱신한다(AGENTS.md 4번 절).

사용자 세 우려에 매핑한다.
- 우려 1 (치명적): 04/07/11 에서 제품 라벨/텍스트 변질 — '밋밋한 민트색 빈 봉투' + 한글 깨짐("티트리잎"→"티트리얼").
- 우려 2 (양호): 05/06/09/10 은 좋음 → 건드리지 않고 패턴을 확장.
- 우려 3 (BM 방향): 01-problem 이 리드/메인인데 우리 제품이 아니라 '기존 패치의 문제'를 앞세움.

---

## 1. 핵심 진단(확정) — 왜 04/07/11 만 깨졌나, Nano Banana 문제인가?

답: **Nano Banana 의 알려진 한계와 우리 프롬프트의 자기모순이 겹친 결과**다. 둘 중 하나가 아니라 둘의 결합이다.

(A) 모델 한계(우리 코드로 못 고침): 확산모델은 이미지 안 텍스트, 특히 한글/CJK 를 신뢰성 있게 렌더하지 못한다. 학습 데이터에서 CJK 가 과소표현되고 자형이 복잡해 깨진다(arXiv DiffCJK·한글 폰트 생성 논문). Google 도 2.5 Flash 의 장문 텍스트·문자 일관성을 '개선 중'이라 명시했고, 생성 텍스트는 '직접 정확성 확인 필요'라고 공식 문서에 적었다. "티트리잎→티트리얼"은 이 한글 글리프 붕괴의 전형이다.

(B) 프롬프트 자기모순(우리 코드, 확정): `core/scripts/lib/image_engine.py` 의 `build_prompt` 가 image-to-image(`has_ref`)일 때 한 프롬프트에 두 지시를 동시에 넣는다 —
- 90행: "아래 참조 이미지에 있는 '바로 그 제품'(브랜드 패키지·형태·색·로고)을 그대로 유지하라. 다른 제품이나 다른 브랜드를 새로 만들지 마라."
- 99행: "이미지 안에 어떤 글자·문자·숫자·로고·브랜드명도 그려 넣지 마라(no text, no lettering, no logo). 패키지 위 문구도 새로 만들지 마라."

라벨 위 인쇄 텍스트/로고는 '제품'의 일부다. 모델은 이 충돌을 '라벨을 지우는 쪽'으로 해소해 빈 민트 봉투가 된다. Google/DeepMind/Google Cloud 공식 가이드는 부정 지시("no X")를 명시적으로 비권장하고 긍정 프레이밍("describe what you want, not what you don't want")을 권한다 — 99행은 공식 권고에 반하면서 90행과도 충돌하는 이중 악수다.

(C) 복잡도 상관(코드로 확정): `_block_emits_image`(410~418행)는 `type in (clinicalEvidence, beforeAfter) AND visual.chart_data` 일 때만 이미지 생성을 제외한다. **그래픽/인포그래픽 성격 subject 를 제외하는 분기는 없다.** 이번 run 의 11블록 plan 은 전부 `kind=photo`·`chart_data` 없음이라(매니페스트 전수 확인) 11블록 전부가 Nano Banana image-to-image 로 보내졌다.
- 실패 블록(그래픽 subject): 04-rtbSummary(`icon_row,grid`, "아이콘과 짧은 카피로 정돈한 요약 그래픽") · 07-clinicalEvidence(`badge_cluster`, "인증 스타일 그래픽", 차트 없음) · 11-brandBanner(`centered, negative_space`, "브랜드 배너 그래픽") · 03-socialProof(`badge_cluster`).
- 성공 블록(순수 사진): 05-solution(`macro,closeup`) · 06-ingredientTech(`product_focus,diagonal` still-life) · 09-howToUse · 10-targetAudience(`context_scene`).

그래픽 subject 일수록 모델이 '아이콘·뱃지·배너+한글 카피'를 그리려다 라벨 충실도와 attention 을 경쟁시켜 더 망가진다(공식·전문 가이드 공통 설명).

(D) 결정적으로, 그 그래픽 블록의 실제 콘텐츠는 **이미 HTML 로 렌더돼 있다**(`runs/ezderm-relief-cos-multi/04-keyvisual/options/A/index.html`): 04 = `.pt-grid` 4카드 + 인라인 SVG 선화, 07 = `.cert-badge` + SVG, 11 = `.brand-copy` 텍스트. CSS `.block-img{width:100%;display:block;margin:22px 0}` 때문에 생성 PNG 가 HTML 카드 위/아래에 풀폭 띠로 **중복** 적층됐다. 사용자가 본 '빈 봉투'는 바로 그 잉여 PNG 띠다.

(E) 적대검증 보정 — **반드시 반영(과신 금지)**:
- '사진형으로 바꾸면 라벨 보존'은 **대형 워드마크에만** 성립한다. 02-hero·06 실측에서 큰 브랜드명('이지덤 릴리프')·'42매'는 보존되지만, 패키지 위 **소형 인쇄 한글**('티트리잎 오일 고함유로 피부진정에 도움' 등)은 사진형에서도 흐릿하게 뭉개진다(모델 세대 한계). 따라서 그래픽→사진형 전환은 '빈 봉투화'(완전 증발)는 막지만 **소형 라벨 텍스트 픽셀 정확도는 보장하지 못한다** → 보조책(원본 compositing/Pro 모델)이 정당히 필요(P2). 하네스진단의 good_pattern "라벨 보존이 자연스럽게 성립"은 과신.
- 04 의 실패는 라벨 증발만이 아니다. 04 PNG 안에 깨진 한글 카피('티트리얼 오일 함유')와 아이콘 4개가 통째로 구워져 있다 = 모델이 99행 'no text' 를 무시하고 그래픽 subject 를 그렸다. 즉 'no text' 는 강제가 아니라 **subject 가 더 강하게 작동**한다. 잉여 PNG 는 단순 중복이 아니라 '깨진 한글까지 담은 오염'(중복+오염)이다.
- 07/11 은 더 극단: 브랜드/로고/텍스트가 전혀 없는 완전 빈 민트 봉투(11 은 얼굴 일러스트조차 없음). '빈 봉투화' 묘사는 정확.

(F) BM 메인(우려 3)은 위와 **독립한 별개 문제**다. 01-problem 은 순수 photo(`context_scene`)라 라벨 변질 위험 블록이 아니다. 다만 subject 가 '두꺼운 패치를 붙여 도드라지는 상황'(기존 패치 불편)이고 블록 순서상 problem(order 1)이 hero(order 2)보다 먼저라 리드/메인에서 자사 제품이 부각되지 않는 BM 약점이다.

---

## 2. 권장 방향 — "Nano Banana 는 깨끗한 사진만, 텍스트·아이콘·뱃지·배너·차트는 HTML 레이어"

업계 표준과 공식 가이드가 한목소리로 같은 처방을 낸다.
- 공식: 보존하려는 세부(얼굴·로고)는 '아주 자세히 묘사해 보존'하라(Gemini API docs ai.google.dev, Google Developers Blog). 부정 지시 대신 긍정 프레이밍(Google Cloud Blog "Use positive framing"). 절대 정확도가 필요한 텍스트는 인-이미지가 아니라 디자인 도구로 오버레이.
- 접근성/SEO/심의추적성: 이미지에 구운 텍스트는 스크린리더가 못 읽고(Princeton Digital Accessibility, BOIA), SEO 색인이 안 되며, 규제 카피가 픽셀에 박혀 정정·각주 매칭·버전관리가 불가능하다. 규제 도메인에서는 카피가 단일 출처(HTML/`voc.json`)에 있어야 한다.
- 제품 라벨 보존: 진짜 제품 사진을 합성 입력으로 두고 배경/조명만 relighting + 보존 디테일을 명시 묘사(ComfyUI relight, Claid.ai). '없애라'가 아니라 '바꾸지 말고 그대로 유지하라'.

우리 하네스는 이미 이 방향과 정합한다: 채널이 HTML 에서 인라인 SVG 아이콘을 렌더할 수 있고(04/07/11 이 이미 그렇게 렌더됨), 08-reviewCapture 는 이미 `<img>` 없이 순수 HTML 채팅 카드로 통과한 산 증거가 있다.

---

## 3. 우선순위 개선안

### P0 — 라벨/텍스트 변질 근본 차단 (우려 1)

**P0-1. 그래픽 성격 블록을 이미지 생성 대상에서 제외 (명시 플래그)** — **구현됨(`feat/keyvisual-html-only-render`):** plan-block 에 `visual.render_mode="html_only"` 플래그 신설(default=image-emitting 후방호환), `_block_emits_image` 단일 술어가 chart_data 에 더해 html_only 도 제외 → `generate_all` skip·`planned_image_summary`(`{total,image,chart,html_only}` — html_only 를 chart 로 오집계 안 함)·`common.sh` 매니페스트-없을 때 예측·`image_preflight` digest 가 모두 동기화. 1차 대상 = 03-socialProof / 04-rtbSummary / 07-clinicalEvidence(차트 없을 때) / 11-brandBanner / reviewCapture.
- 파일: `core/scripts/lib/image_engine.py` (`_block_emits_image` 410~418행) + `core/harness/plan-block.schema.json`
- 변경: plan-block 스키마에 명시 플래그 `visual.render_mode = "html_only"`(또는 `visual.kind = "graphic"`) 추가. `_block_emits_image` 가 그 값이면 `False` 반환(이미지 생성 제외). composition 토큰(icon_row/badge_cluster) 휴리스틱보다 **명시 플래그를 권장** — 결정론·검증가능, 미래 블록 과제외 위험 없음. `_block_emits_image` 가 단일 출처라 `image_preflight` digest·`generate_all` skip·`planned_image_summary` 카운트가 자동 동기화된다.
- 후방호환: 스키마 default 는 image-emitting(플래그 없으면 기존대로 생성). 1차 대상 = 03-socialProof / 04-rtbSummary / 07-clinicalEvidence(차트 없을 때) / 11-brandBanner.
- 리스크: 스키마 필드 추가 → `validate_storyboard`·stub 골든 동반 갱신 필요(default 유지로 기존 골든 불변 확인).
- 검증: 새 플래그를 단 plan 으로 `planned_image_summary` 가 해당 블록을 `image` 카운트에서 빼는지 단위 확인. stub 골든 회귀가 깨지지 않는지(default 경로).

**P0-2. keyvisual 프롬프트에서 그래픽 블록은 `<img>` 금지·HTML/SVG 만** — **구현됨:** `keyvisual.md` 에 chart_data 예외와 같은 형태로 html_only 예외 절 추가 — `render_mode=html_only` 블록은 생성 PNG `<img>` 대신 인라인 SVG 선화+HTML 카드/뱃지/배너로만 구성하고, 생성 이미지는 사진형 블록에만 붙인다(P0-② 아이콘 규칙과 정합).
- 파일: `core/prompts/keyvisual.md` (24행 "생성 이미지 우선(P0-①)" + 27행 chart_data 예외)
- 변경: 27행의 chart_data 예외와 같은 형태로 예외 절 추가 — `render_mode=html_only`(P0-1 플래그) 블록은 생성 PNG `<img>` 를 쓰지 말고 인라인 SVG 선화 + HTML 카드/뱃지/배너로만 구성하라(이미 있는 P0-② 아이콘 규칙과 정합). 생성 이미지는 사진형 블록(hero·solution·ingredient·howToUse·targetAudience·problem)에만 `<img>`. P0-1 과 짝 — 엔진이 그 PNG 를 애초에 안 만들면 keyvisual 도 참조하지 않는다.
- 리스크: 프롬프트 가이드라 모델 준수 100% 아님. `render-design.sh` 의 `check_render_refs` 는 '참조한 PNG 존재'만 검사하고 'PNG 를 써야/말아야 할 블록'은 강제 안 함 → 강제하려면 게이트 추가(P0-5). 동반: `docs/workflow-ssot.md` 갱신 의무.

**P0-3. storyboard-plan 에서 그래픽 subject 자유생성 차단** — **구현됨:** `storyboard-plan.md` 의 visual.concept 절에서 subject 를 실제 제품/성분/사용장면의 사진 연출로 제약하고, 아이콘 요약·뱃지·배너·리뷰카드 같은 그래픽 구성은 `visual.render_mode=html_only` 로 표시하도록 안내(`kind:"graph"` 는 실증 차트 전용, html_only 그래픽 블록은 `kind:"photo"`). image_engine·keyvisual.md·storyboard-plan.md 세 곳이 '그래픽 블록 = HTML 전용' 한 정의를 공유.
- 파일: `core/prompts/storyboard-plan.md` ('이미지 컨셉(visual.concept)' 절)
- 변경: subject 를 '실제 제품/성분/사용장면의 사진 연출'로 제약. 아이콘 요약·뱃지·배너·리뷰카드 같은 그래픽 구성은 visual.concept 의 subject 로 적지 말고 `visual.render_mode = html_only`(P0-1 플래그)로 표시하게 안내. composition 권장값에서 icon_row/badge_cluster 같은 그래픽 토큰을 사진 블록과 분리.
- 정합성: image_engine·keyvisual.md·storyboard-plan.md 세 곳이 '그래픽 블록 = HTML 전용' **한 정의**를 공유해야 드리프트가 없다.
- 리스크: 스토리보드 생성 모델 행동 변경 → 골든 plan 재기준 가능. `docs/canon-blocks.md` 의 rtbSummary='3-4개 직관 카피'·brandBanner='헤리티지 배너' 서술이 그래픽 성격을 부추기므로 함께 점검. `docs/workflow-ssot.md` 동반 갱신.

**P0-4. build_prompt 90행↔99행 모순 해소 (긍정 프레이밍 분리)** — **구현됨:** `build_prompt`(image-to-image)에서 '기존 인쇄 라벨/로고/한글은 그대로 보존(변형·삭제·새 글자 생성 금지)'와 '참조에 없는 새 텍스트·카피·엠블럼은 추가 생성 금지'를 긍정 프레이밍 두 지시로 분리 — 기존 라벨까지 지우던 자기모순 제거. (stub 골든은 build_prompt 미사용이라 무영향, 사진형 라벨 보존은 실런 눈 검증 대상.)
- 파일: `core/scripts/lib/image_engine.py` (`build_prompt` 88~100행)
- 변경: 두 지시를 분리·정렬한다.
  - (기존 라벨 보존, 긍정) "참조 제품에 이미 인쇄된 라벨/로고/한글은 그대로 보존하라(변형·삭제·새 글자 생성 금지)."
  - (신규 텍스트 환각 차단, 긍정) "새로운 텍스트·카피·엠블럼을 추가로 만들지 마라."
  현재 99행은 '보존해야 할 기존 라벨까지 지우라'고 읽힌다 — '기존 라벨 보존'과 '신규 텍스트 생성 금지'를 명확히 가른다. P0-1 로 그래픽 블록을 빼면 이 충돌의 실질 피해 표면이 사진형 블록만 남아 줄지만, 프롬프트 자체도 무모순으로 고치는 게 정석. 이 fix 단독으로는 소형 한글 라벨 깨짐을 해결 못 함(1-E, 모델 세대 한계 → P2 보완).
- 리스크: 프롬프트 문구 변경 → 실엔진 출력 비결정(stub 골든은 build_prompt 미사용이라 무영향). 사진형 블록 라벨 보존 회귀는 **실런 눈 검증** 필요. 보존을 너무 세게 걸면 모델이 편집을 무시하고 원본을 되돌려주는 역방향 실패(Google AI 포럼 보고)로 샐 수 있으니 구도/배경/조명 재구성 지시는 분리 유지.

**P0-5. 그래픽 블록 `<img>` 금지를 게이트로 강제** — **구현됨(채택):** `check_render_refs.py`(`render-design.sh` 호출)가 `render_mode=html_only` 블록에 생성 PNG `<img>` 가 박히면 **fail-closed** 로 차단 → P0-2 의 프롬프트 권고를 검증 게이트로 승격(준수율 강제). 6번 절 결정 2(권고 vs 게이트)는 게이트 강제로 확정.
- 파일: `core/scripts/lib/check_render_refs.py`(또는 `img_lint.py`) — `render-design.sh` 가 호출
- 변경: `render_mode=html_only` 블록에 생성 PNG `<img>` 가 박히면 fail-closed. P0-2 의 프롬프트 권고를 검증 게이트로 승격(준수율 100% 보장).
- 리스크: 후방호환·골든 영향 검토 필요. 권고에서 멈출지 게이트로 강제할지는 사람 결정(6번 절).

### P1 — 리드/메인 이미지 BM 교정 (우려 3)

BM 진단으로 확정: 블록 순서는 **캐논 강제가 아니라 스토리보드 단계의 사람 선택**이다.
- `docs/canon-blocks.md` 표 제목 = "블록 캐논 (기본 순서)", 기본값 = order 1 hero · 2 socialProof · 3 problem → **캐논 기본이 오히려 hero-first**.
- `core/harness/storyline.schema.json` 의 `blocks[].order` = "integer minimum 1", 시퀀스 무제약.
- 이번 run outline 에 B안(socialProof→hero→problem)·C안(hero 선행)이 실제 존재했고, recommendation 이 A(problem-first)를 top-1 추천 → `00g-guideline`/outline `decision.json` selected="A" 로 사람이 problem-first 를 확정.
- reference-notes 의 careplus/anua/innisfree 플로우는 전부 hero→problem.

**P1-1. (권장, 최소·안전) problem 컷에 자사 제품을 주피사체로 — 순서 유지** — **구현됨:** 리드·hero 블록 subject 는 자사 제품을 주피사체로 두도록 생성 지시에 반영(problem-first 의 공감 후킹을 살리되 첫 화면에서 제품 식별 확보; 순서 무변경). 카피는 HTML 담당. (특정 run 의 plan JSON 적용은 운영 4동작 밖 운영자 처리 영역 — `revise.sh` 보완 후 재렌더.)
- 파일: `core/runs/ezderm-relief-cos-multi/03-storyboard/plan/01-problem.json` (`visual.concept.subject`·`composition`·`handoff_note`·`reference.direction`)
- 변경: subject 를 '기존 두꺼운 패치의 불편'에서 '얇은 이지덤 릴리프 패치를 손에 들거나 피부에 자연스럽게 부착해 두께 차이를 대비'로. `reference.own_asset_path` 제품(ezderm-relief-product.webp)을 주피사체로, composition 을 context_scene + 제품 closeup 으로. 카피(headline/subcopy)는 HTML 담당.
- 운영 경로: `revise.sh` 로 storyboard 보완 후 재렌더(JSON 직접 손편집은 운영자 처리 영역, 현업 4동작 밖).
- 효과: problem-first 의 공감 후킹을 살리면서 첫 화면에서 제품 식별 확보. master reference 가 실제 제품 사진이라 image-to-image 로 제품 주피사체화에 자산 이미 있음.

**P1-2. (대안) 순서를 hero-first 로 재배치**
- 신규 run: outline 에서 B안 또는 C안 선택(`decision.json` selected 를 A 아닌 값으로). 캐논/스키마 무수정.
- 기존 run: `plan/01-problem.json`·`02-hero.json`·`03-socialProof.json` 의 order 재배치(hero=1) + 04-keyvisual 재렌더.
- 리스크: 순서 변경은 다운스트림 outline/plan/design-manifest 전부 재생성 동반 → P1-1(최소 변경)이 더 안전.

**P1-3. (선택 가드) 추천 로직을 캐논 hero-first 와 정렬**
- 파일: `core/prompts/storyboard-outline.md`(추천 rationale 가 problem-first 를 top-1 로 미는 경향 완화), `storyboard-plan.md` 의 'ⓘ 보강 권장'에 problem-first 채택 시 '리드 제품 부각' 조건 명문화.
- 강제 아님 — 순서 자유는 설계 의도이므로 스키마 강제는 하지 않는다.

### P2 — 라벨 충실도 추가 안전장치 (적대검증 보정 반영, 보조책) — **후속(이번 dev-loop 범위 제외, 미구현)**

P0 만으로는 **소형 인쇄 한글 픽셀 정확도**가 완결되지 않는다(02-hero·06 실측 근거). 1순위는 항상 '텍스트=HTML 레이어'(P0). 아래는 보조이지 근본책 아님. **이번 구현 범위 밖**이며 소형 라벨 픽셀 정확도가 실제로 필요한 컷이 확인되면 별도 착수한다(6번 절 결정 5).

**P2-1. 원본 제품 누끼 compositing (가장 확실한 픽셀 보존)**
- 라벨이 픽셀 단위로 정확해야 하는 컷은 원본 제품 사진을 누끼로 따 배경합성/relighting. 현재 1패스 urllib REST 구조(image_engine)에 마스킹 단계 추가 필요.

**P2-2. Nano Banana Pro(Gemini 3 Pro Image) 모델 상향 — 한정 케이스**
- 파일: `HARNESS_NANOBANANA_MODEL` 오버라이드(현재 기본 `gemini-2.5-flash-image` 고정)
- HTML 레이어 분리가 불가능한 특수 케이스만 Pro 세대로. Pro 는 단행 텍스트 오류율 대부분 10% 미만·한글 포함 다국어. 단 엔드포인트/파라미터(현재 v1 generateContent + responseModalities)가 다를 수 있어 어댑터 검증 필요, 비용·레이턴시 상승. 근본책 아닌 보조.

**P2-3. 멀티이미지 일관성 — 동일 master reference + 클린 컨텍스트**
- 11장을 같은 reference 로 매번 독립 호출(누적편집 stacked revision 회피), 보존할 팔레트·제품 형태를 매 프롬프트에 동일 문구로 명시. Google 권장: 컷 사이 바뀌면 안 되는 것을 매번 spell out.

---

## 4. 이번 run 재생성으로 검증하는 방법 (이미지 멱등 재생성)

- 이미지 멱등 재진입: `04-keyvisual/image-manifest.json` 이 존재하면 이미지-직전 최종점검이 건너뛰어지고(no-op 재개 보존), `generate_all` 도 멱등 재호출이 된다. **새 프롬프트/제외 플래그를 반영해 재생성하려면 기존 매니페스트·PNG 를 비워야** 한다.
- P0 변경(엔진·프롬프트) 적용 후 절차: storyboard plan 의 04/07/11/03 에 `render_mode=html_only` 플래그를 달고(P0-1) → 이미지 재생성 → keyvisual 재렌더(P0-2). 기대 결과: 04/07/11 은 PNG `<img>` 없이 HTML/SVG 만, 사진형 블록만 PNG.
- P0-4(프롬프트 모순 해소) 효과는 stub 골든으로 확인 불가(stub 은 build_prompt 미사용) → **실엔진 눈 검증**: 사진형 블록(02-hero·05·06·09·10)의 대형 워드마크 보존 유지/개선 확인, 소형 한글은 여전히 흐릴 수 있음(P2 대상).
- 운영 4동작 경로 우선(`run-stage.sh`·`render-design.sh`); JSON 직접 손편집은 운영자 처리 영역.

---

## 5. 회귀/검증 — 재발 방지

- P0-1: 단위 테스트 — `render_mode=html_only` 블록이 `_block_emits_image`/`planned_image_summary`/`generate_all` skip 에서 일관되게 빠지는지. 기존 `tests/test-gen-image-completeness.sh` 확장.
- P0-5(채택 시): `check_render_refs.py`/`img_lint.py` 에 '그래픽 블록 `<img>` 금지' 규칙 → 회귀 테스트 추가.
- 골든: 스키마 필드 추가는 default=image-emitting 으로 후방호환 → 기존 stub 골든 불변 확인. plan 프롬프트 변경 시 골든 plan 재기준 여부 판단.
- **커버리지 안전(적대검증 확정, 반드시 반영)**: `check_canon_coverage.py` 는 블록 TYPE '존재'(satisfied_by)만 검사하고 `<img>`/생성 PNG 유무와 무관(design scope = design-manifest.json sections[].block 집합). → 04/07/11 에서 PNG `<img>` 를 빼고 HTML 컴포넌트만 남겨도 rtbSummary/scienceEvidence/brandBanner 구성요소 covered 유지(clinicalEvidence=evidence_gated, brandBanner=brand_gated 라 미충족 시 애초에 면제). `check_render_refs.py`/`img_lint.py` 둘 다 '이미지 필수' 강제 없음(08-reviewCapture 가 `<img>` 없이 통과한 산 증거). **커버리지·렌더 게이트는 막지 않는다.** 유일한 동반작업: `_block_emits_image` 술어 확장 시 image-manifest 와 단일 출처 동기화 + (명시 플래그 채택 시) plan-block.schema.json·validate_storyboard·stub 골든 동반 갱신(후방호환 default 유지).
- 동반 갱신 의무: image_engine/keyvisual.md/storyboard-plan.md 변경 시 `docs/workflow-ssot.md` 동반 갱신(AGENTS.md 4번 절).

---

## 6. 미해결 / 사람 결정 필요

1. 그래픽 블록 제외 신호 정본화: 명시 스키마 플래그(`visual.render_mode=html_only`·`visual.kind=graphic`) vs composition/type 휴리스틱. **명시 플래그 권장**(결정론·검증가능)이나 스키마/골든/validate_storyboard 동반 변경 필요. 결정 후 image_engine·keyvisual.md·storyboard-plan.md 가 같은 정의 공유.
2. 그래픽 블록 `<img>` 미생성을 '권고(프롬프트, P0-2/P0-3)'에서 멈출지 '게이트(render-design.sh 검증, P0-5)'로 강제할지.
3. 리드 이미지 교정 방식: **→ 현업 결정 P1-1 채택**(problem 컷에 제품 포함, 최소·안전). P1-2(hero-first 재배치)는 다운스트림 재생성 동반이라 보류. (신규 run 이면 outline 선택만 바꿔도 hero-first 가능.)
4. 07-clinicalEvidence 정책: 이번 run 은 인체적용시험 수치 evidence 가 없어 차트 대신 인증 뱃지로 갔다. evidence 미등록 clinicalEvidence 를 (a) 이미지 생성 아예 면제(canon enabled_if/brand_gated 처럼) 할지 (b) HTML 뱃지 전용으로 둘지 정책 결정.
5. 소형 라벨 픽셀 정확도가 실제로 필요한 컷이 있는지 — 있으면 P2-1(compositing) 또는 P2-2(Pro) 투자 여부.

---

## 부록 — 우려 ↔ 처방 매핑 요약

| 사용자 우려 | 근본원인 | 처방 |
|---|---|---|
| 1. 라벨/텍스트 변질(치명적, 04/07/11) | 그래픽 subject 가 이미지 생성에 포함(`_block_emits_image` 미분기) + `build_prompt` 90↔99 모순; 한글 인-이미지 모델 한계 | P0-1~P0-4(+선택 P0-5), 보조 P2 |
| 2. 05/06/09/10 양호 | 순수 사진 subject 라 모델이 글자를 새로 그릴 필요 없음 | 패턴 유지·확장(건드리지 않음) |
| 3. 리드가 기존 패치 문제 | problem-first 가 사람 선택(캐논 기본은 hero-first), problem subject 에 제품 없음 | P1-1(권장) 또는 P1-2 |

> 본 산출물은 법적 통과 보증이 아니며 자율·비법적 사전 점검이다(AGENTS 7번 절). 최종 책임은 사람(현업/RA)에게 있다.
