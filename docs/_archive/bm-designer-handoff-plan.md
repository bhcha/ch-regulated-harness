# BM 디자이너 핸드오프 전환 계획 — G-A(전 블록 이미지 생성) · G-B(참고문서 이미지 추출 파이프라인)

> 작성 2026-07-05. 설계 SSoT. 사용자 확정 전제. 구현은 dev-loop(웨이브별 병렬 + 스테이지별 Codex 리뷰).
> 관련 정본: `AGENTS.md`(규칙)·`docs/workflow-ssot.md`(워크플로우, 동반 갱신 의무)·`docs/keyvisual-label-corruption-improvement-plan.md`(뒤집는 전제)·`docs/evidence-content-integration-plan.md`(확장 대상).

## 0. 전제 전환 (사용자 확정 2026-07-05)

`multipage_bm` 산출물은 **최종 완성본이 아니라 디자이너에게 보내는 디자인 시안(핸드오프)** 이다.
- 디자이너가 텍스트를 다시 조판하므로 **이미지 안 한글 라벨이 깨져도 무방**하다.
- 반대로 "흰 카드 + 선화 SVG" HTML 렌더는 디자인 방향을 못 보여줘, 사람이 검수한 실BM(브랜드 그린 배경·핑크 강조 타이포·뱃지·말풍선이 전 27장에 구워진 밀도) 대비 얇고 밋밋하다.
- 기준 실BM 정본: `/Users/chabh/Documents/temp/oliveyoung_A000000140818_20260705-0944/images/detail`(27장, 사람 검수 완료).

**따라서**: (G-A) 전 블록을 이미지로 생성한다(한글깨짐 허용). (G-B) 참고문서(시험성적서)의 시험 이미지를 추출해 차트와 페어로 인용한다.

## 1. 안전장치 구분 — '품질 장치'만 완화, '규제 장치'는 유지

| 구분 | 예 | 이번 처리 |
|---|---|---|
| **품질 장치(완화)** | `render_mode=html_only` 이미지 미생성 · `build_prompt` 무텍스트 계약(신규 텍스트 금지) · keyvisual "픽셀에 굽지 말 것" · check_render_refs html_only 역참조 금지 | **해제**(전 블록 이미지 생성·인-이미지 한글 카피 허용) |
| **규제/환각 장치(유지)** | 심의 게이트(원격 ADK) · evidence 결박(claim_strength↔근거 id) · 금지표현/금지블록 결정적 게이트 · **차트=chart_data(확산모델로 데이터 날조 금지)** · 크롤 원본 img-src 금지 · 정본 카피 HTML 레이어 병행(심의 텍스트 스캔·evidence 생존 채널) | **불변** |

⚠ **차트는 예외**: 측정 수치 차트(`chart_data`)는 여전히 확산모델로 굽지 않고 인라인 SVG/HTML로 렌더한다 — 데이터 날조 방지(규제 장치). 사용자 결정 1(차트 재렌더)과도 일치.
⚠ **정본 카피 병행**: 이미지에 카피를 구워도, 같은 카피를 HTML 텍스트 레이어에도 둔다(오버레이 또는 시각 숨김). 심의 텍스트 스캔·evidence 원문 생존·카피 추출 게이트가 이미지 밖에서 계속 작동해야 하기 때문(RCA 7-3). 이미지 속 텍스트는 '디자인 참고용', HTML 텍스트는 '게이트·접근성용'.

## 2. G-A — 전 블록 이미지 생성 (한글깨짐 허용)

- **A-ENGINE** (`scripts/lib/image_engine.py` + `scripts/lib/common.sh`):
  - `_block_emits_image`: `render_mode=="html_only"` 억제 **제거**. 제외는 **`chart_data` 보유 블록만**(clinicalEvidence/beforeAfter 차트). 모델 티어(Pro/Flash) 분기 제거(단순화 — 이제 비-차트 전 블록이 티어 무관 생성). ⚠ stub(오프라인)은 여전히 결정적 stub SVG(골든 바이트 불변).
  - `build_prompt`: 그래픽 블록용 프롬프트 분기 추가 — 뱃지·배너·인포그래픽·말풍선 스타일 + **인-이미지 한글 카피/라벨 생성 허용**(무텍스트 계약 해제). 단 **참조 제품에 이미 인쇄된 라벨 보존**(브랜드 충실도) + **크롤 원본 미참조**는 유지. `ART_DIRECTION` 팔레트 상속으로 톤 일관.
  - `planned_image_summary`: html_only 카운트를 image 로 흡수(차트만 별도). `common.sh` 인라인 `_emits` 폴백 동기.
- **A-GATE** (`scripts/lib/check_render_refs.py`): html_only 블록의 생성 PNG 역참조 금지 **제거**. **존재성 검사 + PNG 유효성**은 유지(깨진/누락 이미지 렌더 차단). Pro 매니페스트 예외 로직도 불필요해져 정리.
- **A-PROMPT** (`prompts/storyboard-plan.md` + `prompts/keyvisual.md`) — *Wave 2(B-CONTRACT 이후, 페어블록 레이아웃 반영 위해)*:
  - storyboard-plan: html_only 절을 **차트 전용**으로 축소(chart_data 블록만). 사진형/그래픽 subject 구분·그래픽 subject 묘사 금지(P0-3) 해제 — 그래픽 블록도 이제 '이미지로 만들 디자인'을 subject 로 기술. render_mode 닫힌목록/사진형 강제 문구 정리(전제 소멸).
  - keyvisual: 전 블록 `IMAGE_MANIFEST` `<img>` 우선. html_only→SVG-only 예외 제거. **정본 카피 HTML 레이어 병행 규칙 유지**. 임상 페어블록 레이아웃(차트→추출 전후사진→기관/n/기간/통계/개인차) 명시.
- **A-CLEANUP** (`scripts/lib/completeness_advisor.py` + `scripts/lib/operator_labels.py` + `tests/test-completeness-advisory.sh`):
  - `photographic_html_only` 권고 **폐기**(전제 소멸 — 이제 전 블록 이미지). `evidence_clinical_signal` 권고는 **유지**(여전히 유효). 관련 라벨·테스트 케이스 (10)(11) 제거.

## 3. G-B — 참고문서 이미지 추출 파이프라인 (범용, 어떤 결과보고서든)

사람이 **초반에 명시 선언**(test_report 직접 선언 — 자동제안 우회 금지 불변식 유지). 어떤 도메인/제품/문서든 동일 계약.

- **B-CONTRACT** (`harness/evidence-documents.schema.json` + `harness/claim-basis.schema.json` + `harness/registry.json`) — additive:
  - `test_report.test_items[]` = `{metric, unit, series[]|{before,after,wk2...}, change_pct, stat_note, image_ref:{pages:[N..], caption}}`. 기존 test_report(institution/n/duration) 위에 추가.
  - `claim-basis.evidence_on_file[]` 에 `image_path`(추출 전후사진 자사경로) 필드 추가(additive). 기존 측정 필드(metric/before/after/series/change_pct/p_value/institution/sample_size/duration) 재사용.
- **B-INGEST** (`scripts/lib/ingest.py cmd_evidence_docs`):
  - test_report 에 `test_items[].image_ref.pages` 선언 시 → **`pdftoppm -r <dpi> -f p -l p`** 로 그 페이지 렌더 → **`inputs/assets/evidence/doc-NN-pNN.png`**(⭐ `inputs/assets/` 하위라 img_lint 화이트리스트 이미 포함 — 게이트 무수정) → `assets-manifest.json` 등록(sha256·doc 결박).
  - test_items → `claim-basis.evidence_on_file`(kind=clinical_trial) **자동 승격**: metric·측정값·change_pct + test_report 메타(institution/n/duration) + image_path. (test_report 직접선언만 승격 — general 은 불가, 안전 불변식.)
  - poppler(pdftoppm) 부재/추출 실패 = fail-closed(선언했는데 못 뽑으면 중단, 무음 누락 금지).
- **B-CHART** (`scripts/lib/clinical_chart.py`): test_items 승격 evidence → 기존 결정적 `derive_chart` 경로로 chart_data 도출(TEST 01~03 라인차트). 수치·방향·단위·지표명 evidence 정확일치 결박 재사용.
- **페어블록**: clinicalEvidence/beforeAfter = **인라인 차트(chart_data)** + **추출 전후사진(`<img>` 자사경로)** + **캡션(기관·n·기간·통계각주·개인차)**. 실BM TEST 01/02/03 레이아웃. (블록 레이아웃 지시 = A-PROMPT; 데이터 도출 = B-CHART; 검증 = VALIDATE.)

## 4. 웨이브 · 파일 소유 (병렬 = 디스조인트 파일)

- **Wave 1(병렬)**: A-ENGINE(image_engine.py·common.sh) ∥ A-GATE(check_render_refs.py) ∥ A-CLEANUP(completeness_advisor.py·operator_labels.py·test-completeness-advisory.sh) ∥ B-CONTRACT(harness/*.schema.json·registry.json)
- **Wave 2(병렬, W1 이후 — B-CONTRACT 의존)**: A-PROMPT(storyboard-plan.md·keyvisual.md) ∥ B-INGEST(ingest.py) ∥ B-CHART(clinical_chart.py)
- **Wave 3(병렬)**: VALIDATE(validate_storyboard.py — 페어블록 규칙·선언페이지 실재·추출물 생존·done 게이트) ∥ CI(신규 헤르메틱 PDF 테스트·test-render-mode-gate 재정의·image-engine 테스트 갱신)
- **Wave 4(마지막)**: GOLDEN(prompt-assembly·stub·drug-stub 골든 재캡처 + `docs/workflow-ssot.md` 동반 갱신 + AGENTS.md 2번 절 문구 동기)

스테이지마다 완료 즉시 Codex 리뷰 → critical/high 0까지 수정.

## 5. 검증
- 회귀-free: b0/b1*/b3/routes/components/clinical-*/prompt-contract 골든은 의도 변경분만 재캡처(diff 최소 확인). stub/오프라인 골든 바이트 불변(stub 은 html_only 억제와 무관하게 결정적).
- 신규: 헤르메틱 소형 PDF 픽스처로 test_items→추출→차트+이미지 페어 E2E(오프라인). poppler 의존은 CI 정책 명시(없으면 skip+경고, 운영은 fail-closed).
- E2E(실런): PNK 실PDF로 test_items 3건(유분량 41%↓·피지량 33%↓·진정 31%↓ + 전후사진 페이지) 선언 → TEST 섹션 3개(차트+추출사진) 재현 → 릴리프 재런 done.

## 5-1. 알려진 한계 (Codex 리뷰 수용 사항)
- **item 근거 id 네임스페이스**: 항목 승격 id = `doc-NN-tKK`(부모 `doc-NN` 레코드도 항상 승격 → 정성 판정 claim 의 `evidence_ref=doc-NN` 및 check_claim 실재성 보존). `doc-NN-tKK` 는 `doc-\d+` 토큰에 `doc-NN` 이 임베드되나, 반영 게이트는 **토큰+내용 프로브(판정 카피/차트)** 둘 다 요구하므로 거짓 반영-통과가 아니다(부모 doc 반영 크레딧은 항목이 그 doc 의 실증 내용이라 정당).
- **오프라인 stub 의 항목별 차트**: 온라인 실런은 EVIDENCE_DOCS 컨텍스트(항목·근거 id·image_path)로 실 LLM 이 항목별 차트+추출이미지를 만든다(검증=E2E). 오프라인 stub 생성기는 evidence-documents(doc-NN)만 읽어 자식 레코드(doc-NN-tKK)를 모르므로 항목별 차트를 결정적으로 생성하지 않는다 — 이 기능의 **헤르메틱 CI 테스트는 후속**(현재는 온라인 E2E + 헤르메틱 추출 스모크로 검증).
- **매칭 이미지 = 항목당 1페이지**: `image_path` 단일 슬롯이라 `image_ref.pages` 는 한 페이지(전후 합성 컷)만 허용(다중 = 인입 fail-closed). 여러 이미지가 필요하면 시험항목을 나눈다.
- **sha256 미영속**: 추출 이미지 sha256 은 감사 로그로만(동결 assets-manifest 스키마에 슬롯 없음). doc↔이미지 결박은 claim-basis `image_path` + 파일명 규약(`doc-NN-pP.png`).
- **래스터 근거 검증**: .png/.jpg/.webp 근거는 매직바이트로 실제 이미지 확인 후 복사(손상/위장 fail-closed, P2-6).

## 6. 범용성 불변식 (하드코딩 금지)
- 제품명·도메인·문서 종류·페이지 번호를 코어 코드에 하드코딩 금지. 전부 **사람 선언(사이드카)** 으로 구동.
- 팩(`packs/<도메인>`)·포맷(`packs/_format`)만 도메인 데이터 소유. 코어는 중립.
- test_report = 사람 직접선언 전용(자동제안 승격 우회 금지) 불변식 유지.
