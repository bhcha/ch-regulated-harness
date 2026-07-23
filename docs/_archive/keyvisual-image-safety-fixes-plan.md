# 키비주얼 이미지 안전 결함 수정계획 (F1·F2·F3)

> 작성 2026-07-06. 다제품 추출 경계 수정(M-1~M-3) 직후 **실폴더 E2E 2건**(릴리프 `ezderm-relief-mp` 화장품 · 우루사 `ursa-drug-mp` 의약품, 둘 다 done)의
> 검증에서 드러난 **키비주얼 이미지 안전·품질 결함 3건**의 수정 설계 SSoT. 파이프라인 로직·심의(ADK)는 정상 동작했고, 문제는 **생성 이미지 산출물(baked PNG)** 쪽이다.
> 근거: 자동메모 `nanobanana-graphic-block-label-corruption`·`e2e-intake-verification-2026-07`. 관련 선행 설계 = `keyvisual-label-corruption-improvement-plan.md`(render_mode=html_only 처방, G-A 로 역전됨).
> 구현은 dev-loop(웨이브·스테이지별 Codex 리뷰·critical/high 0 수렴). **AGENTS.md 4번 절 의무: 커밋마다 `docs/workflow-ssot.md` 본문(최종 진실)·`workflow-ssot-history.md`(이력 한 줄) 동반 갱신.**

## 우선순위 요약

| # | 심각도 | 제목 | 한 줄 |
|---|---|---|---|
| F1 | **HIGH(규제 리스크)** | 그래픽 블록 baked 이미지에 허위 규제표시 환각 | Nano Banana 가 FDA·1위·오수치를 이미지에 구워 넣음 — 그대로 게재 시 약사법/표시광고법 위반 |
| F2 | MEDIUM(운영·완결성) | Pro 400 INVALID_ARGUMENT 자동 강등 누락 | 429 만 flash 강등되고 400 은 즉시 fail-closed → 완주 막힘(수동 개입 필요) |
| F3 | MEDIUM(품질) | 생성 이미지 aspect 불일치 × 고정박스 object-fit:cover → 상하좌우 크롭 | 이미지가 제각각 비율인데 CSS 가 860×645 고정박스+cover 로 담아 제품컷 가장자리(맨 끝 제품·라벨)가 잘림 |

---

## F1. 그래픽 블록 baked 이미지 허위 규제표시 (HIGH — 규제 리스크)

**증상(실측·우루사 E2E)**: `04-keyvisual/generated/08-socialProof.png`(그래픽 블록)에 **날조된 규제 주장이 이미지로 구워짐** —
"미국 FDA 인증 획득 1996"(허위 — 우루사 FDA 승인 아님), "소비자 추천 1위 / 조선일보 선정 1위"(날조 수상 + 금지 최상급), "국내 최초"(금지),
"76.5%/53.8%"(실제 79.76%/69.4% 와 다른 오수치). `06-ingredientDetail.png`엔 가짜 제품명(우루사-F). 릴리프도 그래픽 블록 동일 취약.

**근본원인(코드 확정)**:
- `image_engine.py:561-562` `_block_emits_image`: `render_mode=="html_only"` 그래픽 블록이 **온라인(실엔진)이면 `return bool(model)` → 이미지로 구워짐**(G-A 디자이너 핸드오프 전환 — "전 블록 이미지·한글깨짐 허용"). 확산모델은 그래픽/인포그래픽에서 텍스트 충실도를 잃고 **없는 내용(FDA·1위·수치)을 창작**한다.
- **안전망은 유지되고 있다**: HTML 텍스트레이어가 컴플라이언스 정본이고(검증 데이터·각주로 깨끗), ADK(pharma/cosmetics-agent)가 그 레이어를 심의·통과한다. baked 이미지 텍스트는 심의 대상이 아니다(디자인 참고).
- **그러나 산출 deliverable(export `kcia-package/` + `options/*/index.html` 의 `<img>`)에 baked 그래픽 PNG 가 그대로 들어가**, 현업이 그걸 그대로 쓰면 허위표시가 된다. "한글깨짐 허용" 전제(bm-designer-handoff)를 **넘어선다** — 단순 깨짐이 아니라 없는 인증·순위·수치를 만든다.

> ⚠ **대조(정상)**: 임상 블록(clinicalEvidence + chart_data)은 `_block_emits_image:559` 로 **항상 이미지 제외**되고 HTML/SVG 인라인 차트 + 추출 전후사진으로 렌더된다 → 데이터 날조 없음(릴리프 임상 섹션 = 정확·규제 안전). 즉 **차트 경로는 안전, 그래픽 블록 baked 경로가 위험**하다.

**열린 결정(사람 판단 필요 — 규제 접근)**: 아래 중 택. dev-loop 착수 전 확정.
- **(A) 그래픽 블록 안 굽기(html_only 억제 복원)** — `_block_emits_image` 가 `render_mode=="html_only"` 를 온라인에서도 제외(G-A 부분 역전). 그래픽 블록은 HTML/SVG 레이어로만 렌더(텍스트·아이콘·뱃지·배너는 원래 HTML 이 담당). 가장 깨끗·규제안전. 손실 = 디자이너가 그래픽 블록의 '이미지 시안'을 못 받음(HTML 렌더샷으로 대체 가능).
- **(B) 굽되 deliverable 격리 + 워터마크** — 그래픽 블록은 계속 굽되(디자이너 참고용), export `kcia-package` 와 심의 패키지에서 **제외**하고 `options/*` HTML 의 그래픽 `<img>`를 HTML/SVG 렌더로 대체(또는 "심의 미대상·재조판 필수" 워터마크 오버레이). 디자이너 이미지 시안 유지 + 오게재 차단.
- **(C) 도메인 게이팅** — 규제 도메인(drug/quasi_drug/health_food)만 (A), 화장품은 (B). 규제 강도별 차등.

> 권고: **규제 도메인은 (A)**(허위 인증/순위/수치가 특히 위험), 화장품 등은 최소 (B). 즉 (C) 지향. 단 사람이 확정.

**수정(택안 확정 후)**: `_block_emits_image` 그래픽 분기 조정(A/C) + `plan-block.schema` render_mode 의미 재정의 · export(`gen-images`/`render-design`/kcia-package 조립)에서 그래픽 baked PNG 제외 또는 워터마크(B) · `keyvisual.md`/`storyboard-plan.md` 프롬프트 동기화 · `planned_image_summary` 카운트 일관. **stub/오프라인 골든 바이트 불변**(결정성) 유지.

**후방호환·위험**: (A)는 온라인 그래픽 블록 이미지 미생성 → 온라인 산출 변화(골든은 오프라인이라 불변). image-manifest 카운트·완료판정(P-1 incomplete)·check_render_refs(매니페스트-SSoT) 동기화 주의. `bm-designer-handoff-plan`(G-A) 문구와 상충하므로 그 전제를 "그래픽 블록 예외"로 정정(문서 동반).

**테스트**: 그래픽 블록(render_mode=html_only) 이 (택안대로) 이미지 미생성/격리됨을 확인 · 사진형·차트 블록은 불변 · export 패키지에 그래픽 baked PNG 부재(B/A) · 오프라인 골든 바이트 불변. 회귀 = `tests/test-render-mode-gate.sh`(확장)·`test-gen-image-completeness.sh`.

---

## F2. Pro 400 INVALID_ARGUMENT 자동 강등 누락 (MEDIUM — 운영·완결성)

**증상(실측·릴리프 E2E)**: 기본 모델 `gemini-3-pro-image`(Pro)가 일부 블록에서 **400 INVALID_ARGUMENT** 반환. P-1 자동 강등은 **429 만** 처리하므로 400 은 즉시 fail-closed → 3/10 에서 완주가 막혔다(코디네이터가 수동으로 `HARNESS_NANOBANANA_MODEL=flash` 전환해 완결). flash 는 같은 프롬프트를 정상 처리 → **모델-특유 400**(Pro 가 특정 입력을 거부)이다.

**근본원인(코드 확정)**: `image_engine.py:436-457` `_call_nanobanana` —
- 429(RESOURCE_EXHAUSTED) → 지수 백오프 → 소진 시 `NanoBananaQuotaExhausted`(status=429) → `generate_all` 이 잡아 **fallback 모델로 자동 강등**.
- 그 외 모든 HTTP 오류(400 포함) → `raise RuntimeError("Nano Banana HTTP 오류 (status=%s)")`(455-457행) → generate_all 이 강등 대상으로 안 잡음 → **즉시 실패**.
- 즉 강등 트리거가 429 하나뿐 — Pro 가 400 으로 거부하는 모델-특유 실패에 폴백이 없다.

**수정**: 400(및 모델-특유로 판단되는 4xx)을 **강등-대상**으로 분류한다.
- 새 타입 마커 `NanoBananaModelRejected`(status=400, `NanoBananaQuotaExhausted` 와 형제 — RuntimeError 하위) 도입. `_call_nanobanana` 가 400(INVALID_ARGUMENT 계열)에서 이를 던지고, `generate_all` 이 429 강등 경로와 동일하게 `HARNESS_NANOBANANA_FALLBACK_MODEL` 로 재시도.
- **안전**: fallback 모델도 400 이면 진짜 잘못된 요청이므로 그대로 fail-closed(모델-특유가 아닌 요청 버그는 폴백에서도 실패 → 강등이 '더 나빠지지 않음'). 즉 400 강등은 모델-특유 거부만 구제하고 진짜 버그는 여전히 잡힌다.
- 로그 1줄(감사): "400 model-rejected on <model>; fallback to <fallback>". 키/URL 비노출(_redact_key 경유).

**후방호환·위험**: 기본 fallback 이 flash(=`HARNESS_NANOBANANA_FALLBACK_MODEL` 기본값)라 Pro 400 → flash 자동 재시도. fallback 빈 값(강등 끄기)이면 기존대로 즉시 실패(옵트아웃 보존). stub/오프라인 무관(실엔진 전용). 증분 매니페스트(P-1)와 결합 — 강등 블록도 incomplete 갱신·완료판정 일관.

**테스트**: mock 400 응답 → fallback 모델 재시도·성공 시 완결 · fallback 도 400 이면 fail-closed · 429 경로 회귀 불변. 회귀 = `tests/test-image-engine.sh`(400 강등 케이스 추가).

---

## F3. 생성 이미지 aspect 불일치 × 고정박스 object-fit:cover → 상하좌우 크롭 (MEDIUM — 품질)

**증상(실측·우루사 E2E)**: `04-keyvisual/options/A/shots/*.png`(렌더 섹션 스크린샷)의 여러 블록에서 제품컷 **가장자리가 상하좌우로 조금씩 잘림**. 예: `02-hero`(3품목 패키지)는 **좌우가 잘려** 맨 왼쪽 병·맨 오른쪽 '복합우루사' 박스가 프레임 밖으로 나가고, `08-socialProof`는 **상하가 잘림**.

**근본원인(코드·수치 확정)** — Playwright 요소 스크린샷 문제가 아니라 **CSS 고정박스 × 가변 aspect 소스 이미지**의 `object-fit: cover` 크롭이다:
- `options/A/styles.css` `.block-img { width: 860px; height: 645px; object-fit: cover; }` — 표시 박스가 **860×645(4:3 = 1.333) 고정**.
- 생성 이미지는 aspect 가 **제각각**: `02-hero` = **1376×768(1.79, 와이드)** · `08-socialProof` = **928×1152(0.81, 세로)**. Nano Banana 가 단일 목표 aspect 를 신뢰성 있게 지키지 않고, **Pro(gemini-3-pro-image)와 강등된 flash(gemini-2.5-flash-image)가 서로 다른 크기를 낸다**(F2 강등이 이 불일치를 키움).
- `object-fit: cover` 는 고정박스를 '채우기' 위해 넘치는 축을 **크롭**한다 → 와이드 이미지(1.79 > 1.333)는 높이를 645 에 맞추고 폭 초과분(≈1156→860, 좌우 각 ~148px)을 **좌우 크롭** · 세로 이미지(0.81 < 1.333)는 폭을 860 에 맞추고 높이 초과분(≈1067→645, 상하 각 ~211px)을 **상하 크롭**. 파일마다 aspect 가 달라 전체적으로 "상하좌우가 조금씩" 잘린 것처럼 보인다. `render.py`(DPR=1·`el.screenshot()`)는 정상 — 크롭은 렌더 이전 CSS 레이아웃에서 이미 확정된다.
- **F1 과 복합**: 그래픽 블록의 baked 텍스트(환각 포함)까지 함께 잘려 더 어긋난다. 정당한 제품컷(맨 끝 제품)도 잘리므로 품질·정확도 저하.

**수정(택안)**:
- **(a) 자연 비율 표시(권장)**: `.block-img { width: 860px; height: auto; }` (고정 height·object-fit 제거) → 이미지를 원본 비율 그대로 전폭 표시(크롭 0). 섹션 높이가 이미지별로 달라지나 스크롤형 상세페이지엔 무해. `keyvisual.md` 템플릿 CSS 동기화.
- **(b) 레터박스**: `object-fit: contain` + 배경 → 크롭 0 이나 여백 바 생김(디자인상 덜 선호).
- **(c) 생성측 aspect 고정**: image_engine 이 목표 aspect(예 4:3·860×645 상당)를 프롬프트/파라미터로 요청 + 후처리 리사이즈/패드로 규격화 → 박스와 일치시켜 cover 크롭 제거. 단 확산모델 aspect 준수는 불안정이라 후처리 리사이즈(Pillow 등)가 확실. Pro/flash 크기 차이도 여기서 흡수.
- 권고: **(a) + (c)** — 표시는 자연비율(크롭 0)로 안전하게 하고, 생성은 일관 규격으로 후처리(디자인 정렬·Pro/flash 크기차 흡수). 최소한 (a)만으로 크롭은 즉시 사라진다.

**후방호환·위험**: (a)는 CSS만 바꾸면 되고 stub/오프라인 골든(HTML 바이트)은 keyvisual 템플릿 변경에 따라 재캡처 필요할 수 있음(섹션 높이 변화는 shots 픽셀 뿐, HTML 구조 불변이면 골든 영향 적음 — 확인 필요). (c)는 image_engine 후처리 추가(Pillow 의존·결정성 유지).

**테스트**: 서로 다른 aspect 픽스처 이미지 → 렌더 섹션에 원본이 크롭 없이 담기는지(폭 860, 높이=원본비율) 확인. 회귀 = `tests/test-render-existence-depth.sh`(확장) 또는 신규 렌더-크롭 가드.

---

## 실행 계획 (dev-loop)

**브랜치**: `fix/keyvisual-image-safety`(main 기준) 또는 현행 `fix/multiproduct-extraction-boundary` 이어서(사람 확정).

**Wave 1 (병렬 — 파일 대체로 disjoint)**:
- **Stage F2 (Pro 400 강등)**: `image_engine.py`(`NanoBananaModelRejected` + generate_all 강등 분기) + `tests/test-image-engine.sh`. 위험 낮음(429 경로 패턴 복제).
- **Stage F3 (크롭)**: `keyvisual.md`/렌더 템플릿 CSS(`.block-img` height:auto·(a)) + (택 시) `image_engine.py` 후처리 규격화(c) + 렌더 회귀. (a)만이면 CSS·프롬프트 템플릿뿐이라 저위험.
- **Stage F1 (그래픽 블록 안전)**: **열린 결정 확정 후** 착수 — `_block_emits_image`/export/프롬프트 + 스키마 + 회귀. F2·F3 와 image_engine/keyvisual 을 함께 만질 수 있어 순서·머지 주의(같은 파일이면 순차).

> F2·F3 먼저(독립·저위험) → F1(열린 결정 + 다중 파일). F1 은 규제 판단이라 사람 확정 게이트가 앞선다. F3-(c) 를 택하면 F3 도 image_engine 을 만지므로 F2 와 순차.

**회귀 게이트(오프라인)**: 넓은 골든 green · **오프라인 골든 바이트 불변**(F1·F2 모두 실엔진 경로라 stub 무영향) · 신규/확장 회귀 통과 · Codex critical/high 0.

**커밋 규율**: 커밋마다 `docs/workflow-ssot.md` 본문 최종 진실 + `workflow-ssot-history.md` 한 줄. state.json 스크립트-단독.

## 완료 기준(수용 조건)

1. (F1·택안대로) 그래픽 블록 baked 이미지가 심의/게재 deliverable 에서 제외 또는 미생성 — 허위 규제표시가 산출물에 실리지 않음. 사진형·차트 블록·HTML 텍스트레이어 불변.
2. (F2) Pro 400 → fallback 모델 자동 재시도로 완결(mock 검증) · fallback 도 실패면 fail-closed · 429 경로 불변.
3. (F3) 서로 다른 aspect 이미지가 렌더 섹션에 **크롭 없이** 담김(폭 860·원본 비율 유지) — 제품컷 가장자리 유실 없음.
4. 넓은 오프라인 회귀 green · 골든 바이트 불변(또는 keyvisual 템플릿 변경분 재캡처) · Codex critical/high 0.

## 고지

본 수정은 생성 이미지 산출물의 규제 안전·완결성 개선이다. F1 의 규제 접근(택안)은 사람(현업/RA) 확정 사항이며, 최종 게재 전 baked 그래픽 이미지의 사람 검수 책임은 남는다(AGENTS.md 7번 절).
