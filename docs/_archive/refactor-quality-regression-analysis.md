# 리팩토링 이후 산출물 품질 저하 — 근본원인 분석(RCA) + 복원·재발방지 실행 설계

- 작성일: 2026-07-02 · 갱신: 2026-07-02(**실행 설계 통합** — 7장 이미지 품질 복원(경로 A/B), 8장 금지요소 결정적 가드, 부록B 검증 확정 사실. 코드 실물 검증 3축(라우팅 삽입 지점·컴포지팅 요건·가드 삽입 지점) 반영)
- 문서 구성: 1~5장 = 근본원인 분석(RCA, 확정) · 6장 = 우선순위 · **7~8장 = 실행 설계(구현 대상)** · 부록A = 결손 요약 · 부록B = 검증 확정 사실(파일:줄)
- 관계: 키비주얼 라벨 변질 개선계획 = [`keyvisual-label-corruption-improvement-plan.md`](./keyvisual-label-corruption-improvement-plan.md)(P0-1~P0-5·P1-1 구현됨 — 7장은 그 P2 후속의 구체화). 팩 분리 리팩토링 = [`pack-refactor-plan.md`](./pack-refactor-plan.md)(8장의 `disallowed_blocks`는 그 계획 1차 4단계 canon.json 카탈로그로 자연 흡수되는 위치 — 방향 충돌 없음).
- 대상 의심 변경: 2026-07-01 입력 통합 리팩토링(커밋 `2d26e02`) + 2026-07-02 정리 커밋(`1eb0e47` 및 병합)
- 비교 대상 런
  - 화장품: GOOD `runs/ezderm-relief-cos-multi`(06-30, 리팩토링 이전) vs NEW `runs/ezderm-relief-cos-0702`(07-02)
  - 의약품: GOOD `runs/ursa-lineup-2026`(07-01, `2d26e02` 이전) vs NEW `runs/ursa-drug-0702`(07-02)
- 공통 전제: 네 런 모두 동일 경로(세션 내 Claude, `state.json` 이력의 `generate:insession:<stage>:claude`)로 생성됨 → 생성 엔진은 변수(confound)가 아님.

---

## 1. 요약 (결론 먼저: 진짜 원인 순위)

체감 품질 저하는 **한 가지 원인이 아니라 세 가지 독립 요인**이 겹친 결과이며, **의심받던 07-01 입력 통합 리팩토링(`2d26e02`)은 콘텐츠 품질 저하의 원인이 아니다(사실상 무혐의).**

진짜 원인 순위:

1. **콘텐츠 편차(content_variance) — 가장 큰 요인, 특히 구매 버튼 문제의 직접 원인.**
   - 화장품 NEW 런이 사양에는 있으나 캐논 필수는 아닌 `cta`(구매하기 + 가격 9,900원) 블록을 스토리보드 단계에서 자체적으로 만들어 붙였다. 이는 생성 편차이며 리팩토링과 무관하다.
   - 의약품 비교는 애초에 **서로 다른 워킹백워드(WB) 씨앗**(18KB 임상 풍부 vs 6KB 허가효능-only)을 먹었으므로 대부분의 "빈약함"이 입력 차이로 설명된다.

2. **의도된 기능 커밋 `7777c2b`(06-30, `render_mode=html_only`) — 화장품의 가장 눈에 띄는 시각적 저하 원인.**
   - 사진형 키비주얼 장수가 10→3으로 급감한 것은 Nano Banana 한글 라벨 변질을 막기 위한 **의도적 프롬프트/코드 변경** 때문이다. GOOD 런은 이 커밋 이전에 생성되어 전 블록이 이미지 모드였다. 버그도 아니고 `2d26e02`도 아니다.

3. **오늘(07-02) 원격 ADK 심의 불안정 → 룰엔진-단독 강등(review_degrade) — 정교함/검증 강도 저하.**
   - NEW 런들의 스토리보드-plan·키비주얼 심의가 `critic_ran=false`, `critic_outcome=failed`로 강등되어 적대적 리파인 패스를 잃었다. 다만 이는 "빈약함을 유발"한 것이 아니라 "빈약함을 걸러낼 마지막 관문을 없앤" 것이다(아래 5단계 참조).

4. **리팩토링 코드 회귀(code_regression) — 콘텐츠 품질 관련 증거 없음(무혐의).**
   - `2d26e02`는 생성 프롬프트(brief/concept/storyboard-outline/storyboard-plan)와 `common.sh`의 `build_context`를 건드리지 않았다. 유일한 프롬프트 변경은 `keyvisual.md`의 상대경로 깊이 문구뿐이며 이는 `<img src>` 해석에만 영향한다.

한 줄 결론: **입력 통합 리팩토링을 되돌려도 품질은 회복되지 않는다.** 되돌려야 할 것이 있다면 `render_mode=html_only`의 적용 범위(3번 항목)이고, 재발을 막아야 할 것은 `cta` 블록 누출(1번 항목)이며, 오늘만의 이슈는 ADK 안정화(3번 항목)다.

---

## 2. 리팩토링 범위 (커밋별 변경)

### 2-1. `2d26e02` (07-01 23:04, 입력 통합 리팩토링)
`git show --stat 2d26e02`로 확인한 변경 성격:
- **입력 통합**: 원시 입력을 `runs/<id>/inputs/{working-backwards.md,assets,examples,bundle}`로 스냅샷. 공유 `core/inputs`는 씨앗 소스로 유지.
- **생성 이미지 이전**: `inputs/assets/generated/<id>/` → `runs/<id>/04-keyvisual/generated/`. `<img src>`를 `os.path.relpath`로 계산해 `../×5~6` 깊이 버그를 원천 제거.
- **경로 해석 기준 전환**: ROOT → run_dir(`image_engine`·`stub_stage`·`check_asset_paths`·`check_render_refs`·`img_lint`). `image-asset.schema` 패턴을 `^04-keyvisual/generated/`로.
- **프롬프트 변경은 `keyvisual.md` 단 하나(10줄)** — 상대깊이 규칙(폰트5·생성이미지2·자사컷3). `git show --stat 2d26e02 | grep prompts/` 결과 `core/prompts/keyvisual.md`만 나옴. brief/concept/storyboard-* 프롬프트는 바이트 불변.
- **문서 감사 정리**: 완료·폐기 문서 9건을 `docs/_archive/`로 이관, stale e2e-records 5건 삭제.

핵심: **생성 로직(build_context)·캐논·포맷 블록 선택·brief/concept/storyboard 프롬프트는 손대지 않았다.** 바뀐 것은 입력/이미지의 **위치와 경로 해석**뿐이다.

증거로, GOOD 화장품 런의 옵션 A HTML은 이미지를 옛 경로로 참조한다:
`src="../../../../../inputs/assets/generated/ezderm-relief-cos-multi/01-problem.png"` (10장). 이는 GOOD 런이 `2d26e02` 이전 레이아웃임을 스스로 증명한다.

### 2-2. 07-02 정리 커밋(`1eb0e47` 및 병합 `f337de5`)
- 비운영 이력·완료계획·데모시드 정리: 아카이브 문서, `core/inputs/assets-ursa/`·`bundle-ursa*/`·`core/e2e-records/` 하위 데모 시드 자산 제거.
- 참조 동반 정리. **런 산출물·생성 로직에 영향 없음** — 제거된 것은 데모 시드/이력 문서.

### 2-3. 인접 커밋(리팩토링이 아니지만 품질에 실제 영향)
- **`7777c2b`(06-30 13:53)**: `feat(keyvisual): 그래픽 블록 HTML/SVG 전용(render_mode=html_only)`. `core/prompts/storyboard-plan.md`(+15줄)·`keyvisual.md`(+2줄)·`plan-block.schema.json`·`check_render_refs.py` 변경. Nano Banana 한글 라벨/텍스트 변질 차단이 목적. **이 커밋이 화장품 시각 저하의 실제 원인.**
- **`f136d7a`(07-01 07:30)**: website 포맷 제거. `storyboard-outline.md`에서 `website=…CTA/푸터` 절만 삭제. multipage_bm·one_pager 절은 불변.

---

## 3. 단계별 품질 비교

### 3-0. 00-ingest (결손 점검) — "ingest에 빠진 것"에 대한 직접 답

**결론: ingest 단계는 신규 런에 빠진 산출물·필드가 없다. 오히려 자산·근거가 동등하거나 더 많다.**

| 항목 | 화장품 GOOD→NEW | 의약품 GOOD→NEW |
|---|---|---|
| 산출물 5종(voc·claim-basis·assets-manifest·best-practices·bundle-report) | 5/5 → 5/5 | 5/5 → 5/5 |
| voc: 리뷰수(collected/site_total) | 100/5931 → 100/5931 | 0/0 → 0/None |
| voc: 키워드빈도·페르소나·옵션분포 | 10·3·0 → 10·3·0 | 0·0·0 → 0·0·0 |
| voc: product_facts / offer / top_phrases | 有/有/有 → 有/有/有 | 有/無/無 → 有/無/無 |
| claim-basis: evidence_on_file | 2 → **4 (↑)** | 0 → 0 |
| claim-basis: functional_status·notified·certs·unsupported | 동일(전부 unknown/0) | 동일(전부 {}/0) |
| assets-manifest: 자사 자산 수 | 13 → **24 (↑)** | 10 → **24 (↑)** |
| best-practices: 블록타입 수 | 13 → 13 | 13 → 13 |

- **결손 없음**: 다섯 개 가공물 파일이 모두 존재하고, voc 정량 신호(리뷰·키워드·페르소나·product_facts)는 두 쌍 모두 사실상 동일 → ingest 파서/추출 동작은 리팩토링 전후로 같다.
- 신규가 더 많은 이유(결손의 반대): (a) 자사 자산은 07-02 시점 `inputs/assets/`에 이미지 시드가 더 쌓여 있어 13/10→24, (b) 화장품 claim-basis evidence가 2→4로 늘어남(WB 인체적용시험 절 추출).
- **provenance 정정**: 의약품 GOOD WB는 삭제되지 않았다 — 리팩토링 이전 경로 `runs/ursa-lineup-2026/00-ingest/inputs/working-backwards.md`(173줄/18KB)에 런 자체 스냅샷으로 남아 있다. 07-02 cleanup이 지운 것은 **공유 데모 시드**(`core/inputs/bundle-ursa-lineup/`·`assets-ursa/`)이지 런 스냅샷이 아니다. (단 신규 의약품 런은 그와 다른 6KB WB를 먹었다 — 아래 3-2.)

### 3-1. 화장품 (cos-multi GOOD vs cos-0702 NEW)

| 단계 | GOOD | NEW | delta | 원인 |
|---|---|---|---|---|
| brief | 차별점 5, 인용 3(voc), FAQ 4외+4내, 사용감 헤드라인. **풀 ADK**(critic_ran=true, ok) | 차별점 7, 인용 3(review), FAQ 5외+5내, 효능-경향 헤드라인. **풀 ADK**(critic_ran=true, ok) | different_not_worse | **content_variance** — NEW가 오히려 더 풍부. 양쪽 동일 풀 ADK → review_degrade 아님. brief 프롬프트 불변. |
| concept | 선택 A-invisibility, RTB 3, 키메시지 2. 풀 ADK ok | 선택 A-invisible, RTB 2, 키메시지 2. 풀 ADK ok | new_worse(경미) | **content_variance** — 선택 축 RTB 3→2. 양쪽 동일 풀 ADK → 생성 편차. |
| storyboard-outline | 11블록, brandBanner에서 종료, **cta 없음**. 7블록 risk_tier=high. 채널=네이버 860px | 12블록, **12-cta 추가**('가격 9,900원·구매 유도'). risk_tier 대부분 low로 평탄화. 채널=coupang 780px | new_worse | **content_variance** — 사용자 지적 이슈의 발원지. NEW의 00g `reference-notes.json`이 '라인업·CTA 순', '구매를 좌우'를 자유텍스트로 언급 + coupang 채널 선택. build_context·outline 프롬프트 불변. |
| storyboard-plan | 11블록, **전 블록 render_mode 없음(=이미지)**. 블록당 카피 풍부. **실제 ADK revise iter2/3/4** → plan-verdict rule_engine+critic, ok | 12블록, **9/12 render_mode=html_only**(hero/problem/solution만 image). iter2/3/4 돌았으나 **plan-verdict 룰엔진-단독**(critic_ran=false, failed) | new_worse | **① code_regression(`7777c2b`, 의도된 기능)** + **② review_degrade**(오늘 ADK). 확인: html_only 블록 수 = cos-0702 9개, cos-multi 0개. |
| keyvisual | 옵션 A 108줄/16.7KB, 11블록, **실제 생성 PNG 10장 참조**(옛 경로). cta 없음. 풀 ADK ok | 옵션 A 104줄/14.1KB, 12블록, **생성 PNG 3장만**. 하단 12-cta에 `<a class="buy">구매하기</a>` + 가격 9,900원. **룰엔진-단독**(failed) | new_worse | 사진 장수 10→3은 plan의 html_only(`7777c2b`) 하류 효과. 구매 CTA 존재는 outline/plan 편차. 심의 강등은 review_degrade. |

수치 확인:
- 생성 PNG: cos-multi 10장(export shots + 옵션 A가 10장 참조) vs cos-0702 3장.
- plan render_mode=html_only: cos-0702 9개 파일 / cos-multi 0개.
- 구매하기+가격 grep: cos-0702 옵션 A = 1, cos-multi 옵션 A = 0(구매/cta/가격/원 모두 0).

### 3-2. 의약품 (ursa-lineup-2026 GOOD vs ursa-drug-0702 NEW)

**⚠️ 이 쌍은 입력 통제가 안 됨** — 두 런이 서로 다른 WB 씨앗을 먹었다(`ursa-lineup-2026` 173줄/18KB 임상 풍부 vs `ursa-drug-0702` 78줄/6KB 허가효능-only). 따라서 리팩토링 격리에 부적합하다.

| 단계 | GOOD | NEW | delta | 원인 |
|---|---|---|---|---|
| brief | 18KB WB. 임상 수치 라이브(79.76% vs 45.68% n=168; ALT -14.7 U/L n=262), Oh2016/Kim2016 근거등급 구분, off-label 경고 | 6KB WB. 일반 체크리스트 FAQ, 임상 수치 0, '실증 근거 없음·후기 0건' 명시 | new_worse | **content_variance** — 서로 다른 WB. 양쪽 ingest 모두 claim-basis 빈 배열 → GOOD 수치는 풍부한 WB 자유텍스트에서 온 것. NEW brief는 얇은 WB를 충실히 반영 → 컨텍스트 조립 정상(가설 B 기각). |
| concept | C-lineup 선택, RTB 4(functional_basis 채움), 키메시지 5. 풀 ADK | A-efficacy 선택(동일 의도), RTB 5(functional_basis 전부 null), 키메시지 3. 풀 ADK | different_not_worse | **content_variance** — 같은 아이디어(3품목 중 고르기). WB 풍부도 + 축 이름 차이. concept 프롬프트 불변. |
| storyboard-outline | 14블록(품목별 심화 buyingGuide/mainPositioning/ingredientDetail/socialProof), cta 없음 | 12블록(일반 캐논), 품목별 심화 블록 제거, OTC **cta**+brandTrust 추가 | new_worse | **content_variance** — 14블록은 C-lineup+18KB WB의 산물, 12블록은 A-efficacy+얇은 WB. outline 프롬프트 불변. cta는 하단(order 11/12)이고 컴플라이언스-안전. |
| storyboard-plan | 14블록, 19,685B, ~773자/블록. **풀 ADK**, 첫 패스 통과(revise 0) | 12블록, 11,832B, ~455자/블록. **룰엔진-단독**(critic_ran=false, failed) | new_worse | **content_variance**(얇은 WB→outline 전파) + review_degrade(부차). 스키마/키 동일 = 구조 파손 없음. |
| keyvisual | 옵션 A 34,991B, AI 이미지 0(자사 3-SKU 공식컷), 필수기재 완비·반복. 풀 ADK. 구매/가격 신호 0 | 옵션 A 13,023B(GOOD의 37%), Nano Banana 4장. 필수기재 완비하나 희박. '구매' 2회 = **약국 문의 안내형 준수 CTA**(가격/장바구니/구매하기 버튼 아님). 룰엔진-단독 | new_worse | **content_variance**(얇은 plan 전파) + review_degrade. keyvisual.md 경로깊이 변경은 렌더에 무관(NEW 4장 정상 렌더). NEW의 cta는 화장품 결함과 달리 준수 안내형. |

**의약품 결론**: 비교가 confounded이므로 리팩토링 귀속 불가. 직접 diff 검사상 리팩토링은 생성 프롬프트·build_context를 건드리지 않았고, 양쪽 모두 **의약품 필수기재 준수**(사용상 주의·의사약사 상의·광고심의필·대웅제약·제품명·안전관리원 보고처). NEW의 cta는 준수 안내형이라 화장품의 구매 버튼 결함과 성격이 다르다.

---

## 4. 구매(CTA) 버튼 문제 — 정확한 현상·근본원인·재발방지

### 4-1. 정확한 현상 (사용자 지적의 정정)
- 대상: 화장품 NEW 런 `ezderm-relief-cos-0702`.
- 실체: 전용 블록 `<section class="blk blk-cta" data-block="cta" data-order="12">`(옵션 A `index.html` 93-99줄)이 헤드라인 "지금 만나보세요", `<p class="price">가격 9,900원</p>`, 그리고 `<a class="buy" href="#">구매하기</a>` 버튼을 렌더. 뒷받침 파일 `03-storyboard/plan/12-cta.json`(type:"cta", order:12).
- **"일찍 나타난다"는 프레이밍은 사실과 다르다**: 전체 페이지에서 구매 버튼은 **맨 아래**(brandBanner 다음, 법적 각주 order 99 직전)에 정확히 1개만 있다(grep=1). 스티키/플로팅 바 없음(position:fixed/sticky 없음). 상단 74/76줄의 "구매"는 '올리브영 구매고객 리뷰 5,931건' = 리뷰 출처 표기이지 버튼이 아님.
- **실제 결함**: 위치가 이른 것이 아니라, **하드코딩 가격(가격 9,900원)이 박힌 구매 CTA가 상세페이지에 존재한다는 것 자체**다. 세 옵션 A/B/C 모두 order 12에 동일 존재. GOOD 런은 구매 CTA를 전혀 만들지 않았다(brandBanner에서 종료).

### 4-2. 근본원인 = 스토리보드 단계의 블록 선택(생성 편차)
증거 사슬:
1. **캐논 필수 아님**: `docs/canon-blocks.md`에 cta/구매 블록 없음. 커버리지 게이트(canon-components)는 10개 컴포넌트를 요구하며 구매/CTA는 그중에 없다. cos-multi는 11블록·cta 없음으로 커버리지 통과.
2. **`cta`는 스키마-합법 가법(additive) 확장 블록**: `harness/plan-block.schema.json`이 cta/footer/header/nav/mainPositioning/point/ingredientDetail를 'M3 포맷 확장 블록 … 공통 cta(가법)'로 표시. 이들은 one_pager/제거된 website 포맷용 확장 블록이며, 그래서 cos-0702는 cta와 함께 out-of-scope `footer`(order 99)도 같이 자라났다(같은 부류의 확장 블록 누출).
3. **의심 리팩토링 아님**: `2d26e02`는 `keyvisual.md`(경로깊이)·`common.sh`·`image-asset.schema.json`만 변경 — 스토리보드/캐논/포맷 블록 선택 무관.
4. **프롬프트 회귀도 아님**: `storyboard-outline.md`의 포맷별 블록 지침은 두 런 모두 바이트 동일한 multipage_bm 안내를 봤다. `f136d7a`는 website 절만 삭제. 프롬프트는 CTA를 **one_pager 전용으로만** 긍정 표기(one_pager=키비주얼+핵심RTB요약+(수상/판매)+CTA) — multipage_bm에는 절대 없음.
5. **따라서 storyboard-outline/plan의 생성 편차**: NEW의 LLM이 구매전환을 추론(자체 `recommendation.json`이 옵션 A 장점으로 '구매전환 흐름이 자연스럽다'를 명시)하고 모호한 "12블록" 목표를 채우며 12번째 cta 블록(+footer)을 만들었다. 동일 지침에서 cos-multi는 11블록·cta 없음을 선택했다. 잠재 위험 = 덜 제약된 "12블록" 지시(canon-blocks.md는 실제로 15블록이라 "12블록"은 정확한 목록이 아님) + 프롬프트/게이트 어느 쪽도 multipage_bm에서 스키마-합법 cta를 **금지하지 않음**.

### 4-3. review_degrade의 기여(부차적)
오늘 ADK가 불안정해 cos-0702의 스토리보드/키비주얼 심의가 룰엔진-단독으로 강등되었다. 풀 ADK 적대 심의였다면 out-of-scope 하드코딩 가격/구매 요소를 문제 삼았을 가능성이 있다 → **누출을 걸러낼 마지막 관문이 오늘 없었다**는 의미의 기여 요인이지, 블록을 **만든** 원인은 아니다.

### 4-4. 재발방지

> ⚠ **이 절은 방향 제시이고, 코드 실물 검증을 거친 구현 설계는 8장이 정본이다.** 검증에서 두 가지가 정정됐다: ① 1번의 `canon-components.multipage_bm.json`은 **실재하지 않는 파일명**(실물은 `canon-components.json`이고, 그 로더 `check_canon_coverage.coverage_spec`이 `components` 배열만 반환해 확장 키를 소실시킴) — SSoT는 `format-profiles.json`으로 확정. ② 3번의 '추적 불가 가격 플래그'는 **이번 사고를 못 잡는다**(9,900원 = voc offer.price 9900과 일치하는 추적 가능 값) — 값-대조 방식으로 재설계, 사고 차단 축은 disallowed_blocks.

1. **결정적 게이트(1순위 처방)**: multipage_bm 포맷 캐논에 블록 금지목록 추가(→ 8장에서 `packs/_format/format-profiles.json`으로 확정), 예 `disallowed_blocks:["cta","footer","header","nav","mainPositioning","point","ingredientDetail"]`. `validate-stage.sh`/check-components.sh가 multipage_bm 런의 plan·keyvisual에 금지 블록이 있으면 fail-closed. LLM 편차·ADK 가용성과 무관하게 잡히므로 심의 불안정한 날에도 재발 불가.
2. **프롬프트 강화(보조)**: `storyboard-outline.md`의 모호한 "multipage_bm=12블록 세로 상세"를 명시 캐논 블록 집합 + 명시 배제로 교체 — "multipage_bm 은 구매/가격/CTA 블록을 포함하지 않는다 — 상세페이지는 판매채널 구매 UI 앞 콘텐츠다. CTA/가격 블록은 one_pager 전용." `storyboard-plan.md`·`keyvisual.md`에도 동일 주석.
3. **가격 단일출처 가드**: one_pager 경로조차 하드코딩 가격 금지. "가격 9,900원"이 `12-cta.json`/HTML에 하드코딩되어 AGENTS.md 6번 절(모든 정량 수치 단일출처=voc.json, 본문 하드코딩 금지) 위반. validate-stage가 voc.json 추적 불가한 가격/통화(숫자+원)를 플래그하도록 확장. (참고: 가격 9,900은 두 런 모두 voc.json에 실재 — 환각 아님. GOOD은 노출하지 않기로 선택했을 뿐.)
4. **회복 노트(선택)**: ADK 안정화 후 cos-0702 급 산출물을 풀 ADK 적대 심의로 재실행. 단 1번 게이트가 들어가면 이건 load-bearing이 아니다.

---

## 5. 원인 분해: 4가설 증거와 채택/기각

### (A) code_regression — 리팩토링이 생성/렌더/검증 로직을 바꿔 회귀 → **기각**
- `git show --stat 2d26e02`: 생성 프롬프트 중 `keyvisual.md`만(경로깊이 10줄). brief/concept/storyboard-outline/storyboard-plan 바이트 불변.
- `common.sh`의 `build_context` 미변경(변경은 이미지 경로 예측 + 00g examples/bundle 디렉터리 해석뿐).
- NEW의 생성 이미지 3장은 신 경로에서 정상 해석·렌더 → 경로깊이 변경으로 인한 렌더 파손 없음.
- **단, 별개의 의도된 코드/프롬프트 변경 `7777c2b`는 채택**: `render_mode=html_only`가 사진 장수 10→3을 만들었다(cos-0702 9/12 html_only, cos-multi 0). 그러나 이는 버그가 아니라 Nano Banana 라벨 변질 차단 기능이며 `2d26e02`도 아니다. GOOD은 이 커밋 이전 산출물.

### (B) context_assembly — 입력 통합이 생성기로 가는 컨텍스트를 줄이거나 깨뜨림 → **기각**
- `build_context` 미변경.
- 의약품 NEW brief가 자신의 얇은 6KB WB를 충실히 반영 = 입력이 생성기에 정상 도달했다는 증거.
- 양쪽 ingest 모두 동일한 빈 claim-basis 산출(evidence_on_file:[], review_count 0) — 차이는 WB 자유텍스트 풍부도이지 조립 파손이 아님.

### (C) review_degrade — 오늘 ADK 불안정 → 룰엔진-단독 → 리파인 감소 → **채택(부차)**
- NEW 화장품·의약품 모두 storyboard-plan·keyvisual 심의가 `critic_ran=false`, `critic_outcome=failed`로 강등. GOOD은 전 단계 풀 ADK.
- 화장품 GOOD은 storyboard-plan에서 실제 ADK revise iter2/3/4를 받았다.
- **한계(정직한 판단)**: 심의 강등이 "빈약함을 유발"하지 않았다 — 의약품 GOOD의 plan은 critic을 **첫 패스에 revise 0으로 통과**했으므로 critic이 GOOD을 풍부하게 만든 것도 아니다. 적대 critic은 카피 볼륨이 아니라 컴플라이언스/주장을 게이트한다. 따라서 review_degrade의 실제 비용은 "가장 컴플라이언스 민감한 산출물이 가장 적은 검증으로 배포됐다"는 점, 그리고 화장품에서 out-of-scope 구매 CTA를 걸러낼 관문이 없었다는 점이다.
- `adk_critic.py`는 리팩토링에서 변경되지 않음 — 오늘만의 원격 엔드포인트 불안정.

### (D) content_variance — 정상 LLM 런간 편차 → **채택(주 요인)**
- 화장품: brief 차별점 7 vs 5(NEW가 더 풍부), concept RTB 2 vs 3, outline cta 블록 추가/risk_tier 평탄화 — 모두 양쪽 동일 심의 조건에서 생성만 갈린 것.
- 의약품: 애초에 서로 다른 WB 씨앗 → brief 임상수치 유무, 14→12블록, ~773→455자/블록이 전부 입력 차이로 설명됨.
- 구매 CTA는 이 범주의 대표 사례(4-2 참조).

---

## 6. 권고 (되돌릴 것 / 고칠 것, 우선순위 — 실행 설계는 7·8장)

### P0 — 결정적 게이트로 구매 CTA/확장 블록 누출 차단 → **8장 실행 설계**
- multipage_bm 포맷에 `disallowed_blocks`(cta·footer·header·nav·mainPositioning·point·ingredientDetail) 선언하고 `validate-stage.sh`/check-components.sh가 storyboard-plan·keyvisual에서 fail-closed.
- 근거: 사용자 지적 결함의 유일한 결정적 방어선. LLM 편차·ADK 가용성과 독립적이라 심의 불안정한 날에도 재발 불가.

### P0′ — 이미지 품질 복원(사진 10→3 회복) → **7장 실행 설계**
- 모델-인지 라우팅(경로 A 방식 (a))으로 Pro 티어일 때 그래픽 블록 이미지 복귀 + 무텍스트 계약 유지. 선행 공통: image-manifest 모델 기록 + HTML 오버레이 지침.

### P1 — 프롬프트 명시화 + 가격 단일출처 가드 → **8장 실행 설계**
- `storyboard-outline.md`의 "12블록"을 명시 캐논 블록 집합 + "multipage_bm은 구매/가격/CTA 블록 없음, CTA는 one_pager 전용"으로 교체. `storyboard-plan.md`·`keyvisual.md`에 동일 주석.
- `validate-stage`에 가격(숫자+원) → voc offer **값-대조** 게이트 추가(AGENTS.md 6번 절 강제; '미추적 플래그' 방식은 4-4 주석대로 정정됨).

### P2 — 오늘의 ADK 심의 안정화 후 재검증
- 원격 ADK 엔드포인트 복구 후 cos-0702·ursa-drug-0702를 풀 ADK 적대 심의로 재실행해 룰엔진-단독으로 넘어간 산출물을 재검증. P0 게이트가 들어가면 load-bearing 아님.

### 되돌리지 말 것
- **`2d26e02`(입력 통합 리팩토링) 롤백은 불필요·무익** — 콘텐츠 품질 저하와 인과 없음. 오히려 `../×5~6` 경로 깊이 버그를 제거한 개선.
- **`7777c2b`(render_mode=html_only) 전면 롤백 지양** — Nano Banana 한글 라벨 변질 차단이 목적. 적용 범위 재조정은 **7장 경로 A(모델-인지 라우팅)로 확정** — 롤백이 아니라 Pro 티어 한정 완화.

### 실행 순서(권장)
8장 금지블록 게이트+회귀 테스트(유일한 결정적 방어선, 최소 규모) → 7장 선행 공통(model 기록+오버레이 지침) → 7장 경로 A → 8장 가격 가드 → (필요 시) 7장 경로 B(라벨-크리티컬 컷 한정).

---

## 7. 실행 설계 1 — 이미지 품질 복원 (경로 A/B)

> 2026-07-02 코드 실물 검증 결과 기반. 목표: **사진 풍부함을 되살리되 한글 라벨은 안 깨지게**. 개선계획 문서의 원칙("Nano Banana는 깨끗한 사진만, 텍스트·아이콘·뱃지·배너·차트는 HTML 레이어")은 유지한다 — 복귀하는 그래픽 블록 이미지도 무텍스트 비주얼이고 카피는 HTML이 담당한다.

### 7-0. 검증에서 나온 결정적 발견 2가지

1. **Pro 어댑터 검증은 이미 끝나 있다.** 레포루트 `.env:10`에 `HARNESS_NANOBANANA_MODEL=gemini-3-pro-image`가 설정돼 있고, cos-0702의 사진 3장이 실제로 이 Pro 모델로 생성에 성공했다(07-02 21:55~21:58, `_is_valid_png` 통과). 개선계획 P2-2가 우려한 "엔드포인트/파라미터 차이"는 실증 해소 — 모델명은 URL 경로 세그먼트에만 쓰이고(`image_engine.py:27, 31-34`) 요청 바디는 모델-무관(`:177-195`).
2. **관측성 공백**: image-manifest에 모델명이 기록되지 않는다(`image_engine.py:530` — engine=nanobanana만). 이번 실런이 Pro로 생성됐다는 사실이 산출물에 안 남아, 다음 품질 RCA 때 Pro/Flash 판별이 불가능하다. 어느 경로를 택하든 **model 기록이 선행 과제**.

### 7-1. 근본원인 재확인(1줄)

storyboard-plan LLM이 P0-3 지시(`prompts/storyboard-plan.md:34-39`)로 9/12블록을 `render_mode=html_only`로 마킹하고, `image_engine._block_emits_image`(`image_engine.py:419-432`)가 **모델을 전혀 보지 않는 순수 함수**로 이를 모델 선택 전에 스킵하기 때문 — `.env`의 Pro 설정은 html_only 블록에 닿지 않는다(3-1·개선계획 P0-1과 일치).

### 7-2. 경로 A — 모델-인지 라우팅

구현 방식 두 가지 중 **방식 (a) "plan 마킹 유지 + 엔진이 유효 render_mode 재판정"을 권고**한다. 방식 (b) "plan 생성 지시를 모델 티어로 분기"(build_context에 티어 라벨 방출 + storyboard-plan.md 조건부화)는 변경 파일이 2곳으로 적지만, LLM 준수 의존(soft)이고 plan 생성 시점과 keyvisual 시점의 모델이 달라지면 마킹이 stale이 되는 시점 불일치가 있어 보조로만.

방식 (a) 구체 변경점:

| 파일·함수 | 변경 |
|---|---|
| `image_engine.py` `_block_emits_image`(:419-432) | `(block, model)` 명시 인자형 **유효 술어**로 확장 — `render_mode==html_only`여도 Pro 티어면 True. Pro 티어 판정(모델명 prefix `gemini-3-pro`)은 상수 1곳에. **암묵 env 읽기 금지**(아래 리스크의 테스트 오염) |
| `image_engine.py` `generate_all`(:507-508) · `planned_image_summary`(:435-447) | 유효 술어로 재분류("html_only지만 Pro라 생성" 카운트). preflight(`image_preflight.py:22,45`)·run.md digest(`render_runmd.py:361-362`)는 이 함수 경유라 자동 동기 |
| `check_render_refs.py` `_html_only_stems`(:51-85, argv :109) | **필수 동반** — 현재 render_mode를 독자 재판독하고 모델 입력이 없어, 엔진만 고치면 P0-5 게이트가 Pro 생성 이미지를 오차단해 `render-design.sh:29`에서 렌더 전면 차단. 유효 술어 공유(호출부에서 모델 전달) 또는 "image-manifest에 실재하는 자산은 forbidden 제외"로 매니페스트-SSoT화 |
| `common.sh` :462-468 | `_block_emits_image`의 ImportError **인라인 폴백 복사본** — 자동 동기 안 됨. 놓치면 emit-context 예측(HTML 작성 시점 진실)과 실생성이 어긋나 존재성 게이트 차단 |
| `prompts/keyvisual.md` :24, :32 | "html_only 블록은 생성 PNG 참조 금지" 지시가 Pro에선 거짓이 됨 — "IMAGE_MANIFEST/예측 목록에 있는 블록만 `<img>`"로 **매니페스트-기준 재서술**(드리프트 최소) |
| 테스트 | `test-gen-image-completeness.sh` HO-a~d에 Pro 케이스 추가 + stub 불변 확인, `test-render-mode-gate.sh` Pro 케이스 |
| 문서 | `workflow-ssot.md`·개선계획 문서 동반 갱신(AGENTS 4번 절) |

리스크/회귀/골든:
- **골든 불변 조건 = 라우팅을 `render_mode==html_only` 블록에 한정.** 골든 fixture plan에는 render_mode가 아예 없어(HO-d: 13개 전부 생성 단언) 무영향이고 run.md는 baseline SKIP 대상. render_mode 부재 블록까지 자동 재분류로 확장하면 stub 골든 13건(image-manifest·generated/*.svg)이 깨진다.
- HO-a/b/c 테스트는 common.sh를 안 거치는 직접 python 호출 — 술어가 ambient env를 읽으면 Pro가 export된 셸에서 비결정 실패. 명시 인자 또는 `env -u` 고정(`test-image-engine.sh:46` 전례).
- **기본 모델 상수는 변경 금지**(`test-image-engine.sh:61`이 `gemini-2.5-flash-image` 단정) — .env 오버라이드 운영이 테스트 무변경.
- Pro가 PNG 외 MIME을 반환하면 `_parse_image`(:280)가 fail-closed — 실런에서 PNG 반환 확인됨이라 당장 유지 가능.
- 감사 관점: 승인된 plan의 html_only 의미가 렌더 시점 env로 뒤집히는 "승인-후 의미 변경" — run.md·매니페스트에 유효 판정 근거(모델명)를 남겨 상쇄(7-0의 model 기록과 동일 작업).

### 7-3. 경로 B — compositing (진짜 제품사진 + 오버레이)

- **API-측 합성(1안) 권고**: `_build_body`(:188-191)의 parts에 inlineData 복수 첨부(`_reference_part`(:143-174)를 리스트 인자화 — 경계검사·매직바이트 재사용)로 "제품 누끼 1장 + 배경/무드 참조 1장" relighting. stdlib 유지, 신규 의존 없음. 로컬 픽셀 합성(2안, Pillow)은 레포 의존 미선언 + `image_engine.py:11` "외부 import 0개" 원칙 충돌이라 지양.
- 누끼 입력은 **코드 무수정 조달**: 사람이 제공한 알파 PNG → `core/inputs/assets` → ingest 스냅샷 → plan `reference.own_asset_path`(`_RASTER_MIME`이 알파 PNG/webp 이미 허용). 실런 cos-0702에 `ezderm-relief-provided.webp`가 이미 이 채널로 들어와 있다.
- HTML 오버레이(사진 위 CSS 캡션)는 **게이트 중립 실측 확인** — `render.py`의 [data-block] 섹션 캡처, kcia 룰엔진의 HTML 텍스트 스캔(`kcia_engine.py:846-875`), ADK 카피 추출 모두 오버레이 텍스트를 정상 수집한다. `keyvisual.md` 프롬프트 지침 추가만으로 성립(현 실런 HTML은 이미지 띠+텍스트 순차 배치뿐, 오버레이 금지 규칙 없음).
- 동반 필수: `image-asset.schema.json` optional 확장(합성 마커·model 기록 — additionalProperties:false라 확장 없인 validate 반려), `_existing_is_valid`(:471-490) 멱등 skip이 합성 전/후를 구분 못 하므로 매니페스트 합성 마커로 이중합성/미합성 방지, 429 백오프(`gen-images.sh` 주석과 달리 실코드 없음 — 드리프트)·타임아웃(Pro 실런 장당 60~120초 vs 기본 120초).

### 7-4. 비교와 권고

| | 경로 A(모델-인지 라우팅) | 경로 B(compositing) |
|---|---|---|
| 코드 범위 | 4파일 동기화(엔진·게이트·common 폴백·프롬프트) + 테스트 | 엔진 내부 1곳(호출부 2곳 자동 동기) + 스키마 확장 + 멱등 마커 + 백오프 |
| 사진 복원 폭 | 그래픽 블록 전부 즉시 복귀(3→최대 12) | 라벨-크리티컬 컷 한정(선별) |
| 한글 라벨 안전 | Pro 성능 의존(무텍스트 계약은 유지) | 원본 픽셀 보존이라 가장 확실 |
| 골든/회귀 | html_only 한정이면 불변(실측) | stub 미경유라 불변, 스키마는 optional 확장만 |
| 심의추적성 | 보존(카피=HTML 불변) | 보존 — 단 픽셀에 텍스트 구우면 심의 사각(룰엔진·ADK 모두 픽셀 안 봄, 방어는 프롬프트 가드뿐) |
| 주 리스크 | P0-5 오차단(동반 수정으로 해소)·테스트 env 오염 | 이중합성·429/타임아웃·의존 원칙 |

**권고(단계적 조합)**: ① 선행 공통 — image-manifest **model 기록** + `keyvisual.md` **HTML 오버레이 지침**(코드 무수정, 시각 풍부함 일부 즉시 회복) → ② **본선 = 경로 A 방식 (a)**(무텍스트 계약 유지) → ③ **경로 B는 P2 원 취지대로 한정 후속** — A 복귀 후에도 라벨 변질이 재발하는 컷만 compositing.

> 범위 제외(요청 명시): 한글 라벨 픽셀 눈검증(실측)은 이 설계에 포함하지 않는다 — 경로 A 적용 후 실런에서 별도 수행.

---

## 8. 실행 설계 2 — 금지요소(구매버튼 등) 결정적 가드

### 8-0. 근본원인 재확인(1줄) + 검증 정정

`cta`는 스키마-합법 가법 확장 블록(`storyline.schema.json:29-34`·`plan-block.schema.json:9-15`)이고 `validate_storyboard.check_blocks`(:151-154)가 enum 전체를 캐논 SSoT로 읽어 **포맷 무관 통과**하며, 가격은 검증 코드가 전무(생성측 `common.sh:373-401` PRODUCT_FACTS 주입만 — AGENTS 6번 절 미구현)여서 과거 교정이 세션 수준에 머물러 재발했다(4-2와 일치).

검증 정정 2가지(4-4 주석과 동일): ① `canon-components.multipage_bm.json`은 실재하지 않음 — 실물은 `canon-components.json`이고 로더(`check_canon_coverage.py:121-122`)가 `components`만 반환해 확장 키 소실 → **SSoT는 `format-profiles.json`**. ② 사고의 9,900원은 `voc.json offer.price=9900`과 일치하는 추적 가능 값(실런 `12-cta.json:5,7,41` 확인) → 가격 가드는 값-대조 방식이어야 하고, **이 사고의 차단 축은 disallowed_blocks**다.

### 8-1. 구현안

1. **SSoT** = `packs/_format/format-profiles.json`의 `formats.multipage_bm`에 `disallowed_blocks` 추가. one_pager는 미선언(=금지 없음 — cta가 정당 블록: `canon-components.one_pager.json:7`, stub도 생성 `stub_stage.py:321`).
   > **구현 정정(2026-07-03, Codex 교차도메인 리뷰)**: 실제 채택 목록 = `["cta","header","nav","point"]`. 위 원안의 `footer`·`mainPositioning`·`ingredientDetail` 3개는 **제외**했다 — 이들은 drug(active) BM 이 **정당/필수**로 쓰기 때문이다: `footer`=광고심의필·제조판매원 등 **필수기재 컨테이너**(`test-drug-golden.sh`가 `<footer>광고심의필 …</footer>`를 준수형으로 단정), `mainPositioning`·`ingredientDetail`=품목 심화 블록(GOOD 런 `ursa-lineup-2026` 이 실사용). 이 목록은 원래 `plan-block.schema.json`의 'M3 포맷 확장 블록' 주석에서 왔는데(4-2.2), 그 분류는 화장품 사고 기준이라 drug BM 정당 블록과 충돌한다. 포맷-레벨 금지는 **도메인 무관 안전집합**만 담아야 하므로 3개를 뺐다(cta=구매전환 UI로 GOOD 화장품·GOOD drug BM 모두 미사용이라 유지; 가격 하드코딩은 값-대조 가드가 심층 방어). stub 골든이 이 충돌을 못 잡은 이유 = multipage_bm **stub 캐논에 이 블록들이 없어** 실 drug 런에서만 드러남.
2. **plan/outline 게이트** = `validate_storyboard.py`: `_format(rdir)`(:139-143, 이미 존재)로 format-profiles를 읽는 `_disallowed(fmt)` 헬퍼 + `check_blocks`(:151-154) 캐논 루프에 "포맷 금지 블록 → 오류" 추가. main()이 outline 3안(:202-207)·plan 전 블록(:209-213)을 이미 순회하므로 `validate-stage.sh:272-273` 기존 호출로 fail-closed — **호출부 무수정**.
3. **커버리지 보조**(운영 가시화) = `check_canon_coverage.py`에 present∩disallowed → fail. 단 plan 경로의 `_has_content` 필터(:50)가 빈 금지 블록을 놓치므로 금지 판정용 타입 수집은 필터 없이 raw type으로. `check-components.sh`·`--scope design`까지 같은 규칙 파급.
4. **HTML 전수 스캔 신설**(`scripts/lib/check_html_blocks.py`): 전 옵션 `options/*/index.html`의 `data-block` 스캔(`check_beforeafter.py:9-30` 정규식 전례 재사용). **design-manifest 검사만으론 불충분** — manifest는 선택안 섹션만 담아(`render.py:118-128`) 비선택 B/C 옵션의 금지 블록이 사각. 호출은 img_lint 전례대로 이중: `validate-stage.sh` 04 구간(:286-289 인접) + `render-design.sh`(:29-37 체인, 렌더 전 차단).
5. **가격 단일출처 가드**(같은 스캐너에 동거): plan 카피 필드(`kcia_engine._block_scan_texts`(:499-518)와 동일 범위 — headline/subcopy/bodyText/footnotes.text/claims.target_text/callouts)와 HTML 가시 텍스트(태그 제거 후)에서 `\d[\d,]*\s*원` 스캔 → **voc `offer.price` 값-대조**. offer 부재 런에서 발견 = 무조건 fail(하드코딩 금지). 값 일치 = 통과(one_pager의 정당한 가격 노출 보존 — 생성기가 PRODUCT_FACTS로 가격을 정식 공급받으므로 무조건 금지는 오답). 오탐 실측: '핵심 원료'·'안전관리원'은 숫자 비선행, '15g'·'10000ppm'은 '원' 없음 → 안전. '만원' 단위 표기는 범위 명시 후 확장 항목.
6. **스키마 enum 축소는 불가**: one_pager 커버리지·stub·`test-components.sh:109-124`(enum 가법 포함 단정)가 즉시 깨짐 — 금지는 포맷별 데이터 선언+게이트로만.
7. **프롬프트 보조(P1)**: `storyboard-outline.md:11`의 모호한 "12블록"을 명시 캐논 블록 집합 + "multipage_bm은 구매/가격/CTA 블록 없음(one_pager 전용)"으로 교체, `storyboard-plan.md`·`keyvisual.md` 동일 주석.
8. **회귀 테스트**(`test-components.sh` 증설, fixtures `conti-in`·`keyvisual-in` 재사용 — `tests/lib.sh` seed_fixture): ① plan에 cta 주입 → validate-stage 03 rc≠0 ② one_pager는 cta 허용 단정 ③ keyvisual HTML에 `data-block="cta"` 주입 → 04 rc≠0 ④ '가격 12,345원'(offer 불일치) 주입 → fail / '9,900원'(일치) → pass.

### 8-2. 리스크/회귀/골든 영향

- multipage_bm stub 캐논(`stub_stage.py:293-309`)에 cta/footer 없음 → **stub 골든 무영향**. 단 금지를 전 포맷 공통으로 걸면 one_pager stub(cta 생성)이 깨지므로 **반드시 포맷별 선언**.
- fixtures·tests/golden 전체에 "숫자+원" 문자열 0건(grep 실측) → 가격 가드도 골든 무영향. 향후 one_pager 골든이 가격 카피를 담으면 offer와 일치해야 통과(의도된 제약).
- 가격 가드 단독으로는 이 사고를 못 막는다(8-0 정정 ②) — **금지블록 게이트가 본체**이고 가격 가드는 심층 방어. 순서를 뒤집지 말 것.
- format-profiles.json(팩)·validate-stage.sh·validate_storyboard.py·check_canon_coverage.py 변경은 `workflow-ssot.md` 동반 갱신 대상(AGENTS 4번 절).

### 8-3. 일반화 — "하지 말라는 것"을 상주 게이트로 만드는 패턴

이 레포에 전례가 이미 3중으로 있다: `validate-stage.sh:146-202`의 00g 게이트 — reference-notes 자유텍스트에 팩 ruleset의 banned/lexicon을 **데이터-선언 deny-list**로 읽어 fail-closed(`examples_analysis.why_violations`), grounded_in 화이트리스트, reference_images 화이트리스트+deny. 이 패턴을 공식으로:

1. 금지를 **팩/포맷 데이터로 선언**한다(코드 하드코딩 금지 — 도메인·포맷마다 다르므로).
2. **validate-stage가 그 데이터를 읽어 fail-closed**한다 — LLM 편차·ADK 가용성과 무관한 결정적 차단(심의는 마지막 관문이지 유일한 관문이 아니다, 4-3 교훈).
3. **위반을 주입하는 회귀 테스트**로 게이트 자체를 동결한다(교정이 코드로 남았음을 CI가 증명).
4. 프롬프트 지시는 **보조(soft)**일 뿐 방어선으로 치지 않는다.

앞으로 세션 중 "이건 하지 마" 교정이 나오면 이 4박자를 기본 처리 절차로 삼는다. `disallowed_blocks`는 팩 분리 계획([`pack-refactor-plan.md`](./pack-refactor-plan.md)) 1차 4단계의 canon.json 블록 카탈로그 속성으로 자연 흡수된다.

---

## 부록A. 단계별 "빠지거나 줄어든 것" 결손 요약 (신규 vs 좋았던 런)

> ingest→storyboard 전 단계를 구조적으로 대조한 결과. `빠짐`=좋았던 런엔 있으나 신규에 없음, `줄어듦`=수량/깊이 감소, `추가`=신규에만 있음(이 경우 cta는 제거 대상).

### 화장품 (ezderm-relief-cos-multi → ezderm-relief-cos-0702) — 같은 릴리프·유사 WB, 깨끗한 비교
| 단계 | 빠짐 | 줄어듦 | 추가(주의) |
|---|---|---|---|
| 00-ingest | 없음 | 없음 | 자산 13→24·evidence 2→4 (증가) |
| 01-brief | 없음 | 없음 | 차별점 5→7·FAQ 8→10 (증가) |
| 02-concept | 없음 | 선택안 RTB 3→2 | — |
| 03-storyboard | 없음(블록 셋 동일) | risk_tier high 7개→대부분 low(위험주석 약화) | **`cta`(구매하기+가격) 블록** = 제거돼야 할 것 |
| 04-keyvisual | — | **사진형 이미지 10→3**(html_only=`7777c2b`) | cta/가격 노출 |
→ 화장품은 **구조적 결손이 사실상 없음**. 실질 이슈 = (1) 구매 CTA 추가(생성편차), (2) 사진 이미지 감소(`7777c2b`), (3) risk_tier 약화.

### 의약품 (ursa-lineup-2026 → ursa-drug-0702) — ⚠ WB 씨앗이 달라(18KB vs 6KB) 순수 결손 아님
| 단계 | 빠짐 | 줄어듦 | 추가 |
|---|---|---|---|
| 00-ingest | 없음 | 없음 | 자산 10→24 (증가) |
| 01-brief | 임상 수치(79.76%/45.68%·ALT -14.7 U/L n=262)·근거등급 구분(Oh2016/Kim2016)·off-label 경고 | sensitive_labels 11→4·FAQ 11→8·headline 64→28자 | — |
| 02-concept | functional_basis(근거 라벨) 채움→null | 키메시지 5→3 | — |
| 03-storyboard | **`buyingGuide`(품목 구매가이드)·`mainPositioning`(포지셔닝)·`ingredientDetail`(성분상세)·`socialProof`** | 14→12블록·블록당 카피 ~773→455자 | `brandTrust`·`cta`(준수 안내형) |
| 04-keyvisual | AI 이미지 0(자사 공식컷)→구성 변화 | 렌더 35KB→13KB·블록 높이 급감 | Nano Banana 4장 |
→ 의약품은 **빠진 것이 많아 보이나** 대부분 **서로 다른 WB(18KB 임상풍부 vs 6KB 허가효능-only) + 생성편차 + 오늘 심의강등**의 합작이다. 같은 WB로 재생성하면 격차의 상당부분이 사라질 가능성이 높다. 필수기재는 양쪽 완비, 신규 cta는 약국 문의 안내형(화장품 구매버튼 결함과 성격 다름).

### 한 줄
- **ingest·brief: 결손 없음**(화장품은 신규가 더 풍부). **concept: 경미 축소.** **storyboard: 화장품=cta 추가만, 의약품=품목심화 4블록 빠짐(단 WB 차이 기인).**
- 어느 결손도 **입력 통합 리팩토링(`2d26e02`)에 귀속되지 않음**. 화장품 이미지 감소=`7777c2b`, 의약품 빈약=WB 차이+생성편차+심의강등, cta=생성편차.

---

## 부록B. 실행 설계의 검증 확정 사실 (2026-07-02 코드 실물 검증, 파일:줄)

7·8장 설계가 딛고 선 사실 목록. 구현 시 이 지점들이 바뀌었는지부터 확인할 것.

**이미지 경로(7장):**
- `_block_emits_image`(`image_engine.py:419-432`) = 순수 함수(모델 입력 없음). 소비처 4곳: `generate_all`(:507-508)·`planned_image_summary`(:435-447)·`common.sh` 예측 분기(:460 import + **:462-468 ImportError 인라인 폴백 복사본** — 자동 동기 안 됨)·preflight/run.md digest(경유).
- `check_render_refs.py`는 술어를 import하지 않고 render_mode를 독자 재판독(:73-76 주석 명시, 판정 :76), argv에 엔진/모델 없음(:109), 호출처는 `render-design.sh:29` 단 1곳.
- 모델명: `HARNESS_NANOBANANA_MODEL`을 import 시 1회 읽음(`image_engine.py:27`, 기본 `gemini-2.5-flash-image`), URL 경로 세그먼트에만 사용(:31-34), 바디 모델-무관(:177-195), 응답은 PNG 구조 강제(:280), 모델명 안전토큰 검증(:319-321).
- `.env`(레포루트): `HARNESS_IMAGE_CLI=nanobanana`(9행)·`HARNESS_NANOBANANA_MODEL=gemini-3-pro-image`(10행) 설정됨. cos-0702 사진 3장이 Pro로 실생성 성공(각 1.1~1.3MB, `_is_valid_png` 통과) — **Pro 어댑터 호환 실증**.
- image-manifest에 model 미기록(:530, engine만). `_existing_is_valid`(:471-490)는 유효 PNG면 무조건 skip(합성 전/후 구분 불가). `gen-images.sh`(전체 26줄)에 429 백오프 없음(:335 주석은 드리프트).
- html_only 마킹 주체 = storyboard-plan LLM(`prompts/storyboard-plan.md:34-39`, 부재=이미지 기본 :39). 참조 첨부 = `has_ref`(:88) → `_reference_part`(:143-174, 경계검사+매직바이트, inlineData 1개 고정 :188-191). `_RASTER_MIME`=png/jpg/webp(:50-55).
- HTML 작성자(insession)는 이미지 생성 **전**에 emit-context를 읽음(`skills/keyvisual/SKILL.md:16-33` 순서, `run-stage.sh:325`에서야 엔진 호출) — 작성-시점 진실은 예측 분기.
- 골든: fixture plan에 render_mode 없음(HO-d 13개 전부 생성 단언), run.md는 baseline SKIP(`baseline.py:27`). 저지선 테스트 = `test-gen-image-completeness.sh:192-303`(HO-a~d, common.sh 미경유 직접 python — ambient env 오염 주의)·`test-image-engine.sh:46(env -u 격리)·:61(기본 모델 상수 단정)`.
- 심의는 픽셀을 안 본다: 룰엔진 = HTML 텍스트노드+노출속성+CSS content(`kcia_engine.py:846-875`), ADK = index.html 가시 텍스트만(shots/·export/ skip, `adk_critic.py:296-355`). 오버레이 텍스트는 정상 수집(심의 표면 안).

**가드 경로(8장):**
- `packs/_format/` 실물 = `canon-components.json`·`canon-components.one_pager.json`·`format-profiles.json` 3개뿐(`canon-components.multipage_bm.json` 없음). coverage_path: multipage_bm→`canon-components.json`(format-profiles.json:9), one_pager→`canon-components.one_pager.json`(:19, cta 구성요소 :7).
- `check_canon_coverage.coverage_spec`(:103-122)은 `["components"]`만 반환(:121-122 — 확장 키 소실). 검사 스코프: design=design-manifest sections(:41-43), plan=plan/*.json(:45-51, `_has_content` 필터 :50), outline=선택안/옵션별(:160-176). 호출처: `validate-stage.sh:274-277(03)·:290-294(04, manifest 존재 시만)`·`check-components.sh:11`.
- `validate_storyboard`: `_canon()`(:130-136)이 storyline.schema enum을 SSoT로 읽어 cta/footer 포맷 무관 통과, `_format(rdir)`(:139-143) 이미 존재(포맷 금지셋 주입 지점 준비됨), main()이 outline 3안(:202-207)+plan(:209-213) 순회, 호출 = `validate-stage.sh:272-273`.
- design-manifest는 **선택안 섹션만** 기록(`render.py:118-128`), block은 자유 문자열(`design-manifest.schema.json:20`) — 비선택 옵션 HTML 사각. HTML 전수 스캔 전례 = `check_beforeafter.py:9-30`(render-design.sh:36 호출), 이중 호출 전례 = img_lint(validate-stage.sh:286-289 + render-design.sh:32).
- voc 실물: `offer={"price":9900,"discount":23.26}`(cos-0702). 가격 검증 코드 0건(생성측 주입만 — `common.sh:373-401`, :387 '- 가격: %d원'). 사고 런 가격 실물: `12-cta.json:5,7,41`·옵션 A `index.html:96-97` — **9,900 = offer.price와 일치(추적 가능)**.
- 오탐 실측: fixtures·tests/golden에 `\d[\d,]*\s*원` 0건, '핵심 원료'·'안전관리원'은 숫자 비선행, '15g'·'10000ppm'은 '원' 없음.
- enum 축소 불가 근거: `storyline.schema.json:29-34`·`plan-block.schema.json:9-15`(가법 명시), one_pager stub cta 생성(`stub_stage.py:321`), `test-components.sh:109-124`(enum 포함 단정). multipage_bm stub 캐논(:293-309)에 cta/footer 없음 → 골든 무영향.
- deny-list→게이트 전례: `validate-stage.sh:146-202`(00g — 팩 ruleset banned 재사용·grounded_in 화이트리스트·reference_images deny). 회귀 테스트 패턴: `test-components.sh:6-17(drive_to_plan)·:41-44(블록 삭제→rc≠0)·:65-84(위반 주입)`, fixtures `conti-in`·`keyvisual-in` + `tests/lib.sh` seed_fixture.
