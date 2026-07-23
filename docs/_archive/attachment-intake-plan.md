# 첨부 통합 인입(Intake) 계획 — 받고 → 분석·보편 분류 제안 → 사람 승인 → 채널 라우팅

> 작성 2026-07-05(사용자 재방향: "첨부파일들을 받아서 분석해서 보편적으로 분류하고, 분류된 것들을 결과물에 어떻게 반영할지가
> 들어가야 한다"). 이 문서가 이 기능의 설계 SSoT 다. 기존 `docs/bm-designer-handoff-fixes-plan.md` 의 P-6(시험성적서 스펙
> 제안·승인)은 **이 계획의 한 하위 단계로 흡수**된다(그 문서에 대체 표시). 구현은 dev-loop. **AGENTS.md 4번 절 의무:
> 각 커밋에서 `docs/workflow-ssot.md` 동반 갱신.**

## 0. 동기 (실측)

현업이 실제로 주는 것은 **폴더 하나**다 — 실런 사례(`/Users/chabh/Documents/temp/`): 워킹백워드 docx · 제품이미지 webp ·
쿠팡/올리브영 크롤 zip·폴더(리뷰·상품정보) · PNK 시험 결과보고서 PDF 가 한 폴더에 섞여 있었다. 그런데 하네스의 입력은
채널별로 분산돼 있어(`HARNESS_WB`·`HARNESS_ASSETS_DIR`·`HARNESS_EXAMPLES_DIR`·`HARNESS_EVIDENCE_DIR`+사이드카·번들 인자)
**운영자가 파일마다 성격을 판단해 수동 라우팅**해야 했다(E2E 에서 실제로 그렇게 함). 게다가 시험성적서 상세(index.json)는
운영자가 통째로 타이핑했고 사람 승인 게이트가 없었다.

**목표**: 첨부 폴더 하나를 받으면 → 에이전트가 파일별로 분석해 **보편 분류 + "결과물에 어떻게 반영될지"를 제안** →
사람이 표를 보고 **승인/보완** → 승인된 분류대로 **기존 채널에 결정적으로 라우팅**(새 반영 메커니즘을 만드는 게 아니라
이미 검증된 채널·게이트로 흘려보낸다).

## 1. 원칙 (불변식)

1. **분류는 제안, 확정은 사람** — 자동분류를 조용히 적용하지 않는다(G5 관문 패턴 재사용: 제안 → run.md 표 → approve/revise).
2. **규제도메인·산출물 포맷 선언은 여전히 사람**(AGENTS 8절 무변경) — intake 는 '파일 성격' 분류이지 도메인 분류가 아니다.
3. **효능 스펙(시험성적서 수치)은 분류 승인과 별도 승인** — 분류 관문은 "이 PDF 는 시험성적서다"까지, 수치·페이지 스펙 초안은
   00e 두 번째 관문(구 P-6)이 잇는다(성격이 다른 결정 = 게이트 분리).
4. **새 반영 경로를 만들지 않는다** — 라우팅 목적지는 전부 기존 채널(bundle/evidence/examples/assets/WB)이고, 반영·게이트는
   기존 파이프라인(voc·claim-basis·00e·00g·차트 결박·img-lint)이 그대로 담당. 크롤 원본 `<img>` 금지 등 기존 안전선 불변.
5. **기존 경로 후방호환** — env 채널·직접 사이드카 선언(전문가 경로)은 그대로 동작. intake 는 opt-in 새 정문. no-intake 런
   골든 바이트 불변.

## 2. 보편 분류 체계 (카테고리 → 라우팅 → 결과물 반영)

| 분류(제안 어휘) | 신호(분석 근거) | 라우팅(기존 채널) | 결과물에 반영되는 방식 |
|---|---|---|---|
| `working_backwards` 제품 기획/브리프 문서 | docx/md/pdf 서사형, 제품·컨셉 서술 | 변환(docx→md) → `inputs/working-backwards.md` | 전 단계의 사실 원천(claim-basis·카피) |
| `own_product_crawl` 자사 상품 크롤 | product.json/reviews.csv 구조, 제품명 = 선언 제품 | `inputs/bundle/` | VOC(후기 인용·키워드)·가격·product facts |
| `reference_crawl` 참고/경쟁 상품 크롤 | 크롤 구조인데 제품명 ≠ 선언 제품 | `inputs/examples/<도메인>/` | 00g 참조 노트·구도 카탈로그(soft 참조, 원본 이미지 직접 사용 금지) |
| `product_image` 자사 제품 이미지 | 이미지 파일, 제품 식별 | `inputs/assets/` | 키비주얼 픽셀 레퍼런스·자사컷 |
| `evidence:test_report` 시험성적서/결과보고서 | 시험기관·판정문·측정표 구조 | `inputs/evidence/` + 사이드카 `kind:test_report`(intent) | **임상 TEST 섹션**(차트+추출 전후사진) — 스펙 상세는 00e 2차 관문(구 P-6) |
| `evidence:certification/paper/patent/ingredient_dossier/brand_story/guide/general` | 기존 kind 어휘 그대로 | `inputs/evidence/` + 사이드카 kind | 각주 인용·해당 블록 반영(00e 반영 포인트 제안 경로) |
| `unknown` 판단 불가 | — | 라우팅 보류 | 사람이 표에서 지정(승인 전 하류 차단) |

> 분류 어휘는 **기존 어휘의 상위 집합**(evidence kind 8종은 이미 스키마에 있음)이다 — 새 반영 채널을 발명하지 않는다(원칙 4).
> 자사/타사 크롤 구분(2·3행)은 **intake 시 사람이 선언한 제품명**(아래 3절 — intake.sh 인자) 대조가 신호이며 확신 낮으면
> `unknown` 으로 두고 사람이 정한다.
>
> **반영 강제 수준(끝-대-끝 보증)**: ⓐ **hard** — 근거 문서(evidence:*)는 기존 '첨부=반영' done 게이트가 최종 HTML 생존을
> 강제(시험성적서=TEST 섹션[차트+전후사진], 일반=반영 포인트+각주). ⓑ **soft** — 참고 크롤(구도 참조)·VOC(후기 인용)는
> 기존 설계대로 권고 참조(법=룰셋 우선, 강제 아님). WB·자사 이미지는 구조적으로 항상 소비된다(카피 원천·픽셀 레퍼런스).
> 즉 "분류된 것이 키비주얼까지 이어진다"의 보증은 evidence 계열=게이트 강제, 나머지=기존 채널의 소비 방식 그대로다.

## 3. 파이프라인 배치 — 새 조건부 페이즈 `00a-intake` (G5 패턴 복제)

```
[00a-intake](조건부) → 00-ingest → [00e-evidence] → [00g-guideline] → 01-brief → … → done
```
- **활성 조건**: 첨부 폴더로 시작한 런만(`intake.sh <첨부폴더> <run_id> --domain --format`). 기존 채널 시작이면 00a 는 아예
  등장하지 않는다(골든·후방호환 — 00e/00g 조건부와 동일한 방식: pipeline-routes·phase-descriptors additive).
- **왜 인입 '앞'인가**: 분류가 확정돼야 무엇이 bundle/evidence/examples 인지 정해지므로 00-ingest 의 입력을 만드는 단계다.
  런 폴더·state 는 intake.sh(셸)가 만들고, 원본은 `runs/<id>/inputs/attachments/` 에 스냅샷(불변 보존·sha256).
- **심의 면제(review:false)**: 분류표는 광고 카피가 아니라 라우팅 결정 입력 — 00e/00g 와 같은 근거로 autopass(닫힌 스키마
  guideline_leaf 에 00a 추가·route_assert_valid 변조 차단). 실제 카피·근거는 하류 게이트가 전부 심의.

### 흐름 상세 (4동작 그대로)
1. **스테이징(셸)**: `intake.sh <첨부폴더> <run_id> --product "제품명" --domain <도메인> --format <포맷>` 가 런 생성 + 첨부
   스냅샷(+zip 해체는 분석 편의를 위해 `attachments/_unpacked/` 에 읽기전용 전개) + `phase=00a-intake`, `gate=generate`.
   **제품명·도메인·포맷은 사람 선언 인자**(AGENTS 8절 준용 — 번들 product.json 이 없을 수 있으므로 제품명을 여기서 받는다;
   제품명은 자사/타사 크롤 구분의 대조 기준).
2. **분석·제안(세션 에이전트, `/intake` 스킬)**: 파일별로 열어 보고(원문·구조·제품명 대조) `00a-intake/intake-proposal.json`
   작성 — 파일별 `{filename, sha256, category, route, kind(근거문서면), reflect_preview(결과물 반영 예고 한 줄), rationale,
   confidence(high|low), actions(변환·해체 등)}`. **집계 예고**도 포함: "리뷰 N건 → 후기 인용, 시험성적서 1건 → 임상 섹션(스펙은
   다음 관문), 참고 크롤 3건 → 구도 참조…" — 사용자가 요구한 "분류된 것들이 결과물에 어떻게 반영될지"가 표에 보인다.
3. **승인(사람)**: run.md 에 평이한 표(파일 → 무엇으로 분류 → 결과물 어디에 반영)로 노출. `approve.sh`(전체 승인) 또는
   `revise.sh "<지시>"`(재분류 — 예: "coupang_648… 은 자사 아님, 참고로"). `unknown` 잔존 시 approve 거부(fail-closed).
4. **발효(apply, 셸+ingest)**: `gate.sh` → `ingest.py apply-intake` 가 승인된 분류대로 결정적 라우팅 — zip 해체 산출을
   `inputs/bundle|examples/` 로, 이미지를 `inputs/assets/` 로, 근거 문서를 `inputs/evidence/` + **사이드카 index.json 자동 생성**
   (승인된 kind·intent 반영 — **00a 승인이 곧 test_report intent 의 '사람 선언'을 구성**한다: validate-stage 의 00e intent-match
   는 승인된 intake 분류를 사람 선언으로 인정). WB 변환은 열린 결정 3 확정대로 00a 세션 에이전트가 수행(승인 표에 '변환됨').
   **자사 상품 크롤이 하나도 없으면 apply 가 최소 합성 번들을 생성**한다(선언 제품명 + 리뷰 0 — 신제품 관행; 지금까지 E2E 마다
   운영자가 수동으로 하던 일의 자동화). 이어서 **기존 00-ingest 내부를 그대로 실행**(voc·claim-basis·evidence-docs·조건부
   라우팅) → 시험성적서 intent 가 있으면 자연히 `spec_status:pending` → **00e 2차 관문(스펙 초안 제안→승인, 구 P-6)** 으로 연쇄.

## 4. 계약 (additive)

- 신규 `harness/intake-proposal.schema.json`(닫힌 스키마 — category/route/kind enum·sha256·confidence·actions).
- `state.schema` phase enum + `pipeline-routes` + `phase-descriptors`(`review:false`, guideline_leaf 에 00a 허용) — 전부 additive,
  G5 가 이미 낸 길 그대로.
- 신규 `scripts/intake.sh`(런 생성·스냅샷·전이) · `ingest.py apply-intake`(라우팅·사이드카 생성·멱등) · `prompts/intake.md` ·
  `skills/intake/SKILL.md` · `registry.json`(intake-proposal 매핑) · `render_runmd/operator_labels/next-action` 라벨.
- 00e 확장(구 P-6): `reflection-proposal.schema` optional `test_report` 블록 + `apply-proposal` intent-match 수용 + 불완전
  test_report 인입 = pending(기존 fail-closed 대체) — 상세는 fixes-plan P-6 절 원문 참조(이 계획의 W-3).

## 5. 안전 불변식 (요약)
- 승인 전 하류 차단(00a pending choke — advance 가드), `unknown` 잔존 시 승인 거부.
- 에이전트 제안은 **분류까지** — 효능 수치는 별도 관문(00e), 일반 문서의 test_report 승격은 intent-match 로만(P-6 안전선 그대로).
- 크롤 라우팅 후에도 기존 게이트 불변: 참고 크롤 원본 `<img>` 금지(img_lint)·자사 번들만 VOC 소스·도메인 사례는 동일 도메인만.
- state.json 은 셸만 기록. 원본 첨부는 스냅샷 불변(sha256), 라우팅은 사본. 재인테이크 멱등(stale 제안 무효화 — G5 P1 패턴).
- no-intake 런(기존 채널) 골든 바이트 불변. HARNESS_OFFLINE stub 은 결정적(제안은 stub 고정물).

## 6. 웨이브

- **W-1 (관문 골격)**: intake.sh·00a 라우팅(state/routes/descriptors)·intake-proposal 스키마·pending choke·run.md 표 — 헤르메틱
  픽스처(가짜 zip·docx·pdf)로 (제안은 stub) E2E.
- **W-2 (분석·발효)**: `/intake` 스킬·prompts(파일 분석 지침: 구조 신호·제품명 대조·kind 판별·reflect_preview 문구) ·
  `apply-intake`(해체·변환·라우팅·사이드카 생성·멱등) · revise 재분류 루프.
- **W-3 (00e 스펙 관문 = 구 P-6)**: fixes-plan P-6 절 그대로(intent-only pending → 스펙 초안 → 승인 → 추출·승격 재사용).
- **W-4 (문서·회귀·카나리)**: workflow-ssot·AGENTS 4절 파이프라인 도식에 `[00a-intake]` 추가 + 넓은 골든 회귀 + **실폴더 카나리**:
  `/Users/chabh/Documents/temp/` 를 통째로 intake → 분류표 승인 → done 완주(사용자 실제 워크플로 그대로).
- 선행/병행: fixes-plan **P-1~P-4 는 독립 선행 가능**(파일 겹침: P-2/P-6 가 ingest.py — W-3 전에 P-2 완료 권장).

## 7. 열린 결정 — **전부 확정(2026-07-05 사용자 "권고안대로")**
1. **관문 수 = 분리 2관문(확정)**: 분류 승인(00a)과 시험성적서 스펙 승인(00e)을 분리한다 — 성격이 다른 결정(라우팅 vs 효능
   수치)이고, 스펙 검증은 문서 정독이 필요해 표가 무거워진다.
2. **확실 분류도 일괄 승인(확정)**: 명백한 파일(reviews.csv 등 confidence=high)도 전부 표에 올리고 **한 번의 approve 로 일괄
   확정**한다. 무승인 자동 라우팅 없음('조용한 분류' 금지).
3. **WB 변환 = 세션 에이전트 변환(확정)**: pandoc 등 의존 추가 없이 00a 세션 에이전트가 docx→md 변환하고, 승인 표에
   **'변환됨'을 명시**해 사람이 확인한다.

> (연관) `docs/bm-designer-handoff-fixes-plan.md` 의 열린 결정 3건도 같은 날 권고안으로 일괄 확정:
> **P-3=a안(판정문-결박 좁은 면제) · P-1 자동 강등 기본 on(fallback=gemini-2.5-flash-image) · P-2 정수 반올림(<0.5) 자동 정규화.**

## 8. 착수 메타프롬프트 (새 세션 `/goal` 용 — 그대로 붙여넣기)

> 아래 블록 전체를 `/goal` 뒤에 붙여넣는다. Stop hook 조건이 되므로 개발→검증→보고까지가 한 목표다.

```
/dev-loop 첨부 통합 인입(00a-intake) 구현 + 실폴더 E2E 검증 — 아래를 순서대로 전부 완수하라.

[구현 1 — 선행 버그수정] core/docs/bm-designer-handoff-fixes-plan.md 의 P-1~P-4 를 dev-loop 로 구현한다(P-5 는 P-1 에 흡수,
P-6 는 intake W-3 로 이관됨). 열린 결정은 확정됨: P-3=a안(판정문-결박 좁은 면제) · P-1 자동 강등 기본 on(HARNESS_NANOBANANA_FALLBACK_MODEL
기본 gemini-2.5-flash-image, 429 지수 백오프+증분 매니페스트 incomplete 마커) · P-2 정수 반올림(<0.5) 자동 정규화.

[구현 2 — 본편] core/docs/attachment-intake-plan.md 의 W-1~W-4 를 dev-loop 로 구현한다(00a-intake 조건부 페이즈 = 받고→분석·
보편 분류 제안→사람 승인→기존 채널 라우팅; W-3 = 시험성적서 스펙 2차 관문). 열린 결정은 확정됨: 분리 2관문 · 확실 분류도
표에 올려 approve 1회 일괄 확정(무승인 자동 없음) · WB 변환은 세션 에이전트 + 승인 표에 '변환됨' 명시.

[구현 규율] 브랜치 feat/bm-designer-handoff 이어서. 웨이브별 Codex 리뷰 critical/high=0 수렴. 커밋마다 docs/workflow-ssot.md
동반 갱신. 오프라인 회귀(touched + 넓은 골든: b0/b1*/b3/routes/components/drug-*/clinical-*/evidence-*) green 유지.
state.json 은 스크립트만 씀. no-intake 런 골든 바이트 불변.

[검증 — 구현 완료 후, 두 개의 서브에이전트로 아래 정보를 바탕으로 끝까지 실행] 하나는 opus, 하나는 sonnet 모델로 돌린다.
메인 에이전트는 앞선 계획들이 제대로 구현되었는지/진행되는지 체크하고, 심의기관 같은 것이 누락되었을 때 하네스가 물어보는지 체크한다.

(opus · 화장품 여러장) /Users/chabh/Documents/temp/ 폴더를 통째로 00a-intake 정문에 넣어 시작한다 — 운영자 수동 라우팅 금지,
분류 제안→승인 관문 검증이 목적이다. 폴더 안: '이지덤 뷰티 여드름 워킹백워드.docx' = 워킹백워드, '제품이미지.webp' = 자사
제품 이미지, 나머지 크롤 파일들 = 크롤링된 참고 제품(전체 상세페이지 플로우는 비패치류 포함 아누아 PDRN 히알루론산세럼·
메디힐 마데카소사이드 흔적 리페어 세럼 등을 참고). 'PNK-22627-A1R (220804) 220627 (주)대웅제약 이지덤뷰티 릴리프
여드름피부사용적합 결과보고서.pdf' 는 참고자료다 — 어떤 단계에서 참고하고 어떻게 제안하고 어떻게 쓰는지 지켜본다
(기대 경로: 00a 가 시험성적서로 분류 제안 → 사람 승인 → 00e 가 스펙[기관·n·기간·지표 수치·전후사진 페이지] 초안 제안 →
승인 → 추출·승격 → 임상 TEST 섹션[차트+전후사진 페어]). 릴리프만 화장품 — 다른 이지덤 제품은 참고 소개 정도만. done 까지.

(sonnet · 의약품 여러장) '/Users/chabh/Documents/temp3/우루사 최신지견 3rd edition.pdf' 가 워킹백워드이고 우루사는 대웅우루사·
복합우루사·우루사정 3가지 품목이다. 이미지는 리서치해서 붙인다. packs/drug/rtb-writing-guide.md 의 우루사 RTB 작성 지침
(7축·좋은/나쁜 예시·금지표현)을 제대로 지켰는지 확인한다(최종 산출물 금지표현 grep 0건 포함). done 까지.

[판정 기준 — 전부 충족해야 목표 달성] ① 00a 분류표가 temp/ 실파일을 올바르게 분류·라우팅(docx→WB 변환됨 표시·webp→자사
자산·크롤들→참고 사례·PNK→시험성적서 intent) ② 승인 전 하류 진행 차단 + unknown 잔존 시 승인 거부 동작 ③ PNK 가 기대
경로(00a 분류→00e 스펙 초안→승인→추출·승격→TEST 섹션)대로 흐름 ④ 두 런 모두 phase=done + 심의(원격 ADK) 통과(폴백 사용
시 정직 기재) ⑤ 전 블록 이미지 생성이 429 에도 완주(P-1 백오프·강등·증분 매니페스트) ⑥ 의약품 금지표현 0건. 결과를 두
계획 문서 기준으로 구조화 보고하고 완료 이미지를 띄운다.
```

