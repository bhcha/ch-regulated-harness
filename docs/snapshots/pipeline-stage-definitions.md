# 파이프라인 단계 정의 (코드 근거 현재상태 스냅샷 — 참조)

> ⚠️ **참조 문서(스냅샷) — 동반 갱신 의무 없음(D-1).** 이 하네스의 현재상태 SSoT 는 **코드**이며, 이 문서는 그 스냅샷이라 코드와 어긋날 수 있다(불일치 시 **코드 우선**). 동반 갱신 의무가 있는 유일한 문서는 [`workflow-ssot.md`](../canonical/workflow-ssot.md)(`AGENTS.md` 4번 절)이고, 이 문서는 그 대상이 아니다.
> **이 문서의 지위:** 하네스 전 단계의 구현 상태를 코드(file:line)로 정독→적대검증(17 에이전트)→교차점검해 정리한 스냅샷(작성 시점 기준).
> **성격:** 서술형 레퍼런스(코드가 SSoT, 이 문서는 도면). **갱신 의무 없음** — 참고용이며, 최신 진실은 코드에서 확인한다.
> **갱신 2026-07-06:** ① 조건부 단계 **00a-intake**(opt-in 첨부 폴더 통합 인입)·**00e-evidence**(근거/시험성적서 반영 제안 2차 관문) 단계 정의 추가(W-1~W-4·G5 반영, 1.2 파이프라인 도식 포함) — 둘 다 심의 면제. ② **키비주얼 이미지 안전·품질(F1·F2·F3)** 반영(04-keyvisual 노트): F1(C) 그래픽 블록 도메인 게이팅(규제도메인 미생성·전 도메인 참조 금지)·F2 Pro 400 자동 강등·F3 aspect 크롭 제거(CSS 자연비율 + Pillow 규격화). 설계 = `docs/_archive/keyvisual-image-safety-fixes-plan.md`.
> **갱신 2026-07-03:** 근거 문서(시험성적서·결과보고서) 첨부 기능 반영 — 00-ingest 조건부 산출물 `evidence-documents.json`(링크 B)·입력 채널 `HARNESS_EVIDENCE_DIR`/사이드카 `inputs/evidence/index.json`·인입-완료 표식 `00-ingest/.ingest-incomplete`(9개 진입점 존중)·양성-완료 advance 게이트·export `kcia-package/evidence/`(링크 C)·신규 스키마 2종 추가. 전면 조건부(근거 없으면 no-op → 골든 불변)·첨부 전송이지 주장 실증 아님(심의 실증셋 미편입). 설계 = `docs/_archive/evidence-attachment-plan.md`.

---

## 1. 전체 골격

### 1.1 3개 직교 축 (서로 독립, 각자 다른 파일이 SSoT)

| 축 | SSoT 파일 | 정하는 주체 | 무엇을 가르나 |
|---|---|---|---|
| **플로우(흐름)** | `harness/pipeline-routes.json` | 고정(도메인 무관) | 단계 순서(successor) + 단계별 `max_iterations` |
| **규제도메인** | `harness/regulatory-domains.json` + `docs/regulation/<도메인>/ruleset.json` | **사람 선언** | 심의 룰셋·가이드 원문 선택, 기능범주 |
| **산출물 포맷** | `packs/_format/format-profiles.json`(`active_phases`) | **사람 선언** | 어떤 페이즈를 도는가. ✅ M7/M8/G6: 전 포맷이 storyboard(03, format-aware)·keyvisual(04, 프롬프트 format-aware)을 돈다. stub 키비주얼은 generic 세로 템플릿(실 LLM 경로만 포맷-native). |

AI 자동분류 없음 — 도메인·포맷은 사람이 `new-run.sh` 인자(또는 `HARNESS_DOMAIN/HARNESS_FORMAT`)로 선언(AGENTS.md §8).

### 1.2 파이프라인

```
⓪ 유형 선언
  ↓
[00a-intake]      (조건부 — opt-in 새 정문. 첨부 폴더 하나를 통째로 받아 분류→승인→기존 채널 라우팅. 심의 면제)
  ↓
00-ingest
  ↓
[00e-evidence]    (조건부 — 참조/시험성적서 문서만 첨부[spec_status:pending]했을 때. 반영 제안→승인→추출·승격. 심의 면제)
  ↓
[00g-guideline]   (조건부 — 동일 도메인 유사사례 있을 때만. 크롤 참조 노트. 심의 면제)
  ↓
01-brief
  ↓
02-concept
  ↓
03-storyboard  (outline(스토리라인) → plan(기획안), 한 페이즈 내 2 서브스테이지; M3: tone 흡수)
  ↓
04-keyvisual
  ↓
done
```
> **조건부 3단계**(대괄호)는 opt-in/데이터 존재 시에만 등장한다. `00a-intake`·`00e-evidence`·`00g-guideline` 은 모두 **심의 면제**(phase-descriptors `review:false` → 승인 뒤 `kcia-check` 가 `review-exempt-autopass`; 분류표·반영 제안·참조 노트는 광고 카피가 아니라 라우팅/참조 입력이라 중복 심의 제거, 실제 카피는 하류에서 심의). 둘 다 활성이면 순서 `00e→00g`(단일 조건부 라우터 `common.sh compute_next_conditional`). 기존 채널(new-run+ingest-bundle) 시작이면 00a 미등장(no-intake 골든 불변).

### 1.3 게이트 사이클(모든 생성 페이즈 공통)

`생성(generate) → 심의(review) → [선택(select)] → 승인/보완(approve/revise)`

상태기계 enum(동결 스키마 `harness/state.schema.json`, **검증 정정 반영**):
- `step ∈ {generate, review, select, human, done}` — 5값(`state.schema.json:43`). `select`는 다안 페이즈가 review 통과 후 진입하는 실재 step(`gate.sh:51`).
- `gate ∈ {review, select, user, null}`
- `status ∈ {pending, passed, revise, escalated, approved, changes_requested, selected}` — 7값(`state.schema.json:45`).

**쓰기 주체:** `state.json` 은 오직 `scripts/*.sh`(new-run·ingest-bundle·gate·run-stage·advance-phase 등)만 쓴다. LLM/스킬은 **산출물·`verdict.json`·`feedback.json`** 만 쓴다(AGENTS.md §1-1). `decision.json`(사람 선택 기록)은 `select.sh` 가 쓰는 게이트 산출물로 **LLM 작성 대상이 아니다**(select 게이트 무결성). `feedback.json` 기록은 `revise.sh`, `verdict.json` 병합은 `kcia-check.sh`(kcia_merge.py)가 수행.

**다안(select 게이트) 페이즈:** `00g-guideline` · `02-concept` · `03-storyboard{outline}` · `04-keyvisual`(`phase_is_multi`). **M3: tone 서브스테이지 제거(2-cycle)** — outline(스토리라인)만 다안.
**단안(review→바로 user 승인):** `01-brief` · `03-storyboard plan`(기획안; 구도/무드/참조를 visual.concept 에 직접 산출).
**유일하게 2중승인(select→approve):** `04-keyvisual`(`phase_needs_approve_after_select`, `common.sh:289-292`).

### 1.4 max_iterations (라우트 테이블 기준)

| 페이즈 | 00-ingest | 00g | 01-brief | 02-concept | 03-storyboard | 04-keyvisual |
|---|---|---|---|---|---|---|
| max_iterations | 3 | 3 | 3 | 3 | **4** | **2** |

`gate.sh` review/revise 분기가 `iteration>=max` 면 `escalated`(사람 개입). `escalated`에서만 raise-limit 으로 `+2` 상향(`run-stage.sh:43-65`). 03-storyboard 의 2 서브스테이지(M3)는 **한 페이즈 카운터를 공유**(서브스테이지 진입 시 리셋 없음).

---

## 2. 단계별 정의

각 단계: **목적 / 조건 / 입력 / 생성 / 산출물 / 게이트 / 심의 / max / 하류 / 갭**.

### ⓪ 유형 선언 — 규제도메인 × 산출물 포맷 (`new-run.sh`)

- **목적/성격:** 파이프라인의 강제 1번째 동작. 사람이 2축(도메인=심의 룰셋 키, 포맷=캐논/페이즈 키)을 선언. **별도 phase 가 아니라** `new-run.sh` 가 `state.json` 을 스캐폴딩하며 `product.regulatory_domain`/`deliverable_format` 에 값을 박는 행위(`new-run.sh:4` 주석).
- **조건:** 항상 + **하드스톱** — 둘 중 하나라도 없으면 die(`new-run.sh:37-38`). 인자 없으면 `HARNESS_DOMAIN/HARNESS_FORMAT` env 폴백. `ingest-bundle.sh` 가 run 없이 호출돼도 동일 강제(`ingest-bundle.sh:20-23`).
- **입력:** CLI 인자 `--domain/--format/--name/--type` · `pipeline-routes.json`(entry+초기 max) · `regulatory-domains.json`(도메인 functional_categories 시드). build_context 라벨은 받지 않음(LLM 생성 아님).
- **생성:** 결정적 스크립트(LLM/stub 아님). 정규화→무결성검증(`route_assert_valid`)→state 시드. 환각 안전 기본값: `evidence_on_file=[]`; `functional_status` 는 **화장품만** 3종(whitening/wrinkle/uv_protection) unknown 시드, **비화장품(quasi_drug/health_food/drug)은 빈 `{}`** (레지스트리 cats=[] 그대로; `new-run.sh:62-66,75`).
- **산출물:** `state.json`(product 2축 + phase=00-ingest/step=generate/iter=1/max=3) · `run.md`.
- **게이트/심의:** **둘 다 없음**. 받는 검증은 `state.schema.json` 검증뿐(`new-run.sh:93`).
- **하류:** 도메인 → `REGULATORY_DOMAIN`/`RULESET` 라벨로 전파(`common.sh:181-195`). 포맷 → **라벨이 아니라** `advance-phase` 의 `active_phases` 페이즈 분기 데이터로만 흐름(`advance-phase.sh:46-54`).
- **⚠️ 갭:**
  - 선언 강제는 **스키마 required 가 아니라 셸 die 에만** 있음 — `state.schema.json` 에선 두 축이 **optional**(미기재 시 cosmetic/multipage_bm 레거시 폴백). new-run 우회 시 빠질 수 있음.
  - 의약품 전문/일반 구분(`rx_classification`)·광고매체(`ad_audience`)는 ⓪이 시드하지 않음 — 의약품 하드스톱 발동에 별도 선언 경로 필요(`regulatory-domains.json:54`).

### 00a-intake — 첨부 폴더 통합 인입 (조건부 · opt-in 새 정문)

- **파일:** `scripts/intake.sh`(런 생성 + 첨부 스냅샷) · `prompts/intake.md`·`skills/intake`(세션 에이전트 분류 제안) · `scripts/lib/ingest.py apply-intake`(발효 라우팅) · `gate.sh`(승인 훅, `00a-intake` 분기).
- **조건:** **opt-in** — `bash scripts/intake.sh <첨부폴더> <run_id> --product --domain --format` 로 시작한 런만 이 페이즈로 진입. 기존 `new-run`/`ingest-bundle` 시작이면 미등장(no-intake 골든 바이트 불변).
- **입력:** 첨부 폴더 하나(WB·자사/타사 크롤·제품이미지·근거문서 혼재). intake.sh 가 `runs/<id>/inputs/attachments/` 로 원본 스냅샷(+sha256, zip 읽기전용 해체). 제품명·도메인·포맷은 사람 선언(state.json — AI 자동분류 없음). run_id 는 apply-intake 안전토큰과 동일 규칙(영숫자._-)으로 생성단계에서 강제(W4-R7).
- **생성(세션 에이전트):** `/intake` 가 파일별 **보편 분류 + '결과물 반영 미리보기' 제안** `00a-intake/intake-proposal.json`(category[working_backwards·own/reference crawl·product_image·evidence:*·unknown]·route·reflect_preview·confidence·actions; docx→md '변환됨' 표기).
- **사람:** run.md 분류표를 보고 **한 번의 approve 로 일괄 확정**. `unknown` 잔존·sha256 불일치·시맨틱 위반 시 approve 거부(fail-closed). **분류 승인(00a)과 시험성적서 스펙 승인(00e)은 분리된 2관문**(라우팅 vs 효능 수치).
- **심의:** **면제**(phase-descriptors `review:false`, 닫힌 스키마 `guideline_leaf` $def 가 00a·00e·00g 허용). 승인 뒤 `kcia-check` 가 `review-exempt-autopass`(분류표=광고 카피 아닌 라우팅 결정 입력) — autopass 직전 `validate-stage` 로 재검증.
- **발효:** `gate.sh review` 가 `ingest.py apply-intake`(승인 분류 → `00a-intake/routed/` 결정적 라우팅) + `ingest-bundle`(routed/ 채널로 00-ingest 연쇄) 실행. 훅 실패 시 state 를 훅-이전(phase=00a-intake)으로 복원해 재진입(멱등: apply-intake wipe+rebuild · ingest-bundle exact-replacement, W4-R2). 자사 크롤 없으면 apply-intake 가 최소 합성 번들(선언 제품명+리뷰0) 생성.
- **산출물:** `00a-intake/intake-proposal.json` · `00a-intake/routed/` · `00a-intake/intake-verdict.json`. **회귀:** `tests/test-intake.sh`.

### 00-ingest — 입력 정규화(결정적, no-LLM)

- **목적:** 크롤 번들 + 워킹백워드 + 자사 자산을 4종 산출물로 정규화. **모든 정량의 단일 출처**(본문 하드코딩 금지, AGENTS.md §6).
- **조건:** 항상(진입 페이즈). fail-closed 전제: ⓪선언 선행 + `reviews.csv` 존재 + 워킹백워드 비어있지 않을 것(빈 파일이면 all-unknown 조용한 통과 차단). **다음 분기만 조건부**: `inputs/examples/<도메인>/` 에 사례 있으면 →00g, 없으면 →01-brief. 산출물 4종 검증 통과 시 재생성 생략(idempotent).
- **입력 파일:** `<번들>/{product.json,reviews.csv,images/}` · `inputs/working-backwards.md`(`HARNESS_WB` 오버라이드) · `inputs/assets/` · `packs/<도메인>/ingest-profile.json`(도메인별 추출 프로파일 — 3단계 팩 이전) · `state.json`(도메인 주입) · **(조건부) 근거 문서** — 소스 우선순위 `HARNESS_EVIDENCE_DIR` → `<번들>/evidence/` → 없음 + 예약 사이드카 `inputs/evidence/index.json`(사람 선언 grade·linked_claim_ids; 아래 근거 첨부 노트).
- **생성:** `ingest.py` 규칙엔진(LLM/stub 아님). **claim-basis 는 절(clause) 단위**로 분리해 강한 승인표지(심사필/통지)가 *같은 절*에 있고 부정·계획 표지가 없을 때만 `approved`, 그 외 `unknown`(근거 leak 차단).
- **산출물(모두 닫힌 스키마·required 강제):**
  - `voc.json`(정량 단일출처: keyword_frequency·rating·option_distribution·persona_signals)
  - `claim-basis.json`(functional_status·notified_ingredients·certifications·product_type·evidence_on_file·unsupported_claims·source — 7키 required, additionalProperties:false)
  - `assets-manifest.json`(own_assets=디자인 src 허용원, bundle_images=src 금지)
  - `best-practices.json`(blocks[]{block_type,shot_type,composition_note,source_files})
  - `bundle-report.md`(사람용)
  - **(조건부) `evidence-documents.json`** — 근거 문서 첨부 매니페스트(링크 B). **유효 문서 1건 이상일 때만 생성**(0건이면 파일·`inputs/evidence/`·`state.artifacts` 항목 모두 prune → 골든 불변). 4종 산출물의 regen-skip 과 **독립**으로 매 인입마다 재평가되고 `state.artifacts` 에는 **존재 시에만** append(부재 시 prune). 상세 = 아래 근거 첨부 노트.
- **게이트/심의:** **둘 다 없음**(gate=None 으로 통과 후 곧장 advance). claim-basis 가 사실상 '결정적 사전심의'(fail-closed 근거표)이나 LLM 심의는 아님.
- **하류:** `VOC`/`CLAIM_BASIS`/`ASSETS_MANIFEST`/(있으면)`BEST_PRACTICES` 라벨로 전 단계에 방출. functional_status/evidence_on_file 는 state.product 에도 반영.
- **⚠️ 갭(검증 정정):**
  - **비화장품 TBD**: `packs/<도메인>/ingest-profile.json`(3단계 이전) 의 quasi_drug/health_food/drug 가 전부 빈값 → **VOC 키워드·기능성 추출이 빈값**. drug 는 functional_status 가 `unknown` 이 아니라 **빈 `{}`**. **단 evidence_on_file·product_type 추출은 정상 동작**(EVIDENCE_MARKERS/POSSESSION_MARKERS 가 도메인-무관 모듈상수 `ingest.py:209-210` — drug 워킹백워드도 evidence 5건 추출 확인). "워킹백워드를 줘도 추출이 안 된다"는 VOC·functional 한정.
  - **참조이미지 '느낌'의 출처가 정적 사전**: `composition_note`/`shot_type` 은 실제 픽셀 분석이 아니라 정적 사전 `BP_HINTS`(`ingest.py:149-163`)를 12블록타입에 round-robin 배정한 결정론적 플레이스홀더(`source_files` 정렬순 `i%len`). 개별 이미지의 실제 구도/색감을 캡처하지 않음.
  - **스키마-구현 드리프트**: claim-basis 스키마엔 `regulatory_domain` 키·`not_claimed`/`paper` enum 이 있으나 추출기가 **실제로는 안 씀**(approved/unknown·clinical_trial/in_vitro/notification/other 만 산출). `ingest-profiles.json:3` 의 `default:cosmetic` 키도 코드에서 미참조(문서용 메타).

> **근거 문서(시험성적서·결과보고서) 첨부 — 전면 조건부 3링크(현재상태):** 규제 근거 실파일을 최종 협회 광고자문 제출 패키지로 **실어나른다**(첨부 전송). 근거가 없으면 신규 파일·필드·상태·표식이 **전혀 나타나지 않는다**(골든 바이트 불변). PDF 파싱·OCR·자동 근거추출 없음(결정적, no-LLM). 설계 = `docs/_archive/evidence-attachment-plan.md`.
> - **링크 A — 입력 채널(`ingest-bundle.sh`):** 소스 우선순위 `HARNESS_EVIDENCE_DIR` → `<번들>/evidence/` → 없음. claim-basis 정규화 뒤(대조 데이터 준비 후)에 돌며, 매 인입마다 `runs/<id>/inputs/evidence/` 로 **정확복제(exact-replacement) 스냅샷**한다 — 먼저 `rmtree` 로 비우고 현재 유효 문서만 재적재(bundle images 의 dest-초기화 패턴 계승)해, 이전 런에서 지우거나 이름 바꾼 첨부의 stale 사본이 **부분 축소(3→2건)** 때도 남지 않는다. 최상위 파일만 단층 순회하며 **디렉터리·심볼릭·특수파일·`..`/경로구분자·화이트리스트 밖 확장자·0바이트·NFC 정규화 후 파일명 충돌·파일당 20MB·총 50MB 초과는 전부 fail-closed**(조용한 무시 없음; 상한 env override `HARNESS_EVIDENCE_MAX_FILE_BYTES`·`HARNESS_EVIDENCE_MAX_TOTAL_BYTES`). 허용 확장자 = `.pdf .hwp .hwpx .doc .docx .xls .xlsx .png .jpg .jpeg .webp`. 예약 사이드카 `inputs/evidence/index.json`(파일명→`grade`·`linked_claim_ids` 사람 선언)은 문서목록에서 제외·메타로만 반영되고, **그 외 모든 `.json` 은 거부**.
> - **링크 B — 매니페스트(신규 `00-ingest/evidence-documents.json`):** `ingest.py cmd_evidence_docs` 가 NFC 파일명 정렬순 `doc-NN` 을 부여해 `{documents[]{id·filename·ext·bytes·sha256·grade·linked_claim_ids}, source{channel,count}}` 를 쓴다. **유효 문서 1건 이상일 때만 생성**(0건이면 파일·`inputs/evidence/` 제거·`state.artifacts` prune). 4종 산출물 regen-skip 과 **독립**으로 매 인입마다 재평가되고, 스냅샷(파일 복사)이 전부 끝난 **뒤 마지막에** `atomic_write_json`(temp+fsync+os.replace)으로 기록해 미완 스냅샷을 절대 반영하지 않는다. **유일성(id·filename·NFC 정규화명 중복)·0바이트·NFC 충돌은 스키마가 아니라 `ingest.py` 코드가 fail-closed 강제**(로컬 JSON 검증기는 `uniqueItems` 미지원). 사이드카 무결성 = index.json 스키마 검증 + 선언 파일명이 복사된 문서와 **정확히 1:1**(미존재 파일명 키 = fail-closed) + `linked_claim_ids` 는 `claim-basis.json` 의 `evidence_on_file[].id` 와 **대조만**(미존재 id = fail-closed).
> - **링크 C — export 반영(`export_package.py`):** 4단계 04-keyvisual export 참조(아래 04-keyvisual 정의).
> - **인입-완료 표식(`00-ingest/.ingest-incomplete`, write-ahead):** `ingest-bundle.sh` 가 어떤 run-input(근거 스냅샷·기존 4종 regen 포함)을 건드리기 **전에** 원자적으로 표식을 쓰고, 터미널 상태-기록(state.artifacts·status=passed·atomic state)이 성공한 **뒤에만** 제거한다. 표식이 있으면 하류가 **fail-closed**·재-인입 강제 — 존중하는 진입점은 **9개**: `run-stage.sh`·`validate-stage.sh`(run 모드; `--file` 단건검증은 면제)·`advance-phase.sh`·`next-action.sh`·`approve.sh`·`select.sh`·`revise.sh`·`kcia-check.sh`·`gate.sh`. 표식 쓰기 자체가 원자적이라 유무는 이진(부분상태 없음).
> - **양성-완료 advance 게이트:** `advance-phase --to` 로 00-ingest 를 떠나는 **양쪽 출구(00g-guideline·01-brief)** 는 표식 부재만으론 부족하고 **양성 완료**(state.status=passed + 필수 4종[voc·claim-basis·assets-manifest·best-practices] present&valid)를 요구한다 — fresh 미인입 런(new-run 직후·status≠passed)은 표식이 없어 "부재=완료"로 오판할 여지가 있으므로 양쪽 출구 모두 거부한다. 재-인입(멱등 정확복제)만이 표식을 해소한다.
> - **첨부 ≠ 실증(불변):** 첨부 문서 id 는 **심의(원격 ADK/룰엔진)가 실증 근거로 읽는 어떤 집합에도 편입되지 않는다** — `kcia_engine` 은 claim-basis/results 에서만 id 를 구성한다. `linked_claim_ids`↔claim-basis 대조도 '연결 표기용 존재성 대조'일 뿐 미승인 주장을 정당화하지 못하며, **강제 심의 게이트·verdict 는 그대로**다(생성·전이 쪽 파일 전송 ↔ 심의 격리 불변).
> - **신규 스키마:** `harness/evidence-documents.schema.json`·`harness/evidence-index.schema.json`(둘 다 `additionalProperties:false`) + `harness/registry.json` 매핑(00-ingest 필수 4종·`TARGETS` 불변). `validate-stage.sh` 스윕은 매니페스트를 **존재 시에만** 검증하고, 사이드카 `inputs/evidence/index.json` 은 phase-local 스윕 대상이 아니라 **ingest 코드가** 직접 검증한다.

### 00e-evidence — 근거/시험성적서 반영 제안 2차 관문 (조건부)

- **파일:** `prompts/evidence`·세션 에이전트(반영 제안) · `scripts/lib/ingest.py apply-proposal`(확정·추출·승격) · `gate.sh`(`00e-evidence` 분기)·`advance-phase.sh`·`common.sh compute_next_conditional`(조건부 라우팅).
- **조건:** 사람이 근거/참조 문서를 **"문서만" 첨부(반영할 점 미지정)** 했을 때만. 인입이 fail-closed 대신 `spec_status:"pending"` 으로 기록 → 이 페이즈 활성. pending 이 안 풀리면 하류 advance 차단. 반영할 점을 이미 지정한 일반 문서·완전 선언(상세 포함) 시험성적서는 인입 즉시 처리(00e 미경유).
- **입력:** pending 문서(일반 참조 = 각주 인용 채널 · **시험성적서 `test_report`** = 사람이 `kind:test_report` 로 intent 선언[상세 생략]한 문서, W-3) + 00-ingest 매니페스트 `evidence-documents.json` + 스냅샷 `inputs/evidence/`.
- **생성(세션 에이전트):** 문서를 읽어 **반영 제안 초안** `00e-evidence/reflection-proposal.json`(문서별 `kind`·`claim`·원문 `reflection_points`≥1; **test_report 면** 스펙 초안: 기관·n·기간·판정문 원문·`test_items`[metric·series·change_pct·stat_note]·전후사진 페이지 후보 — 원문주의·지어내기 금지).
- **사람:** run.md 스펙 표(지표/수치/페이지/판정문)를 보고 **단안 approve** 또는 보완요청(재생성).
- **심의:** **면제**(phase-descriptors `review:false`) — 승인 뒤 `review-exempt-autopass`(제안 초안=하류 참조 입력). autopass 직전 `validate-stage 00e` 로 제안↔pending 1:1·kind enum·포인트≥1 재검증(실제 카피는 하류 심의).
- **발효:** `gate.sh review`→`ingest.py apply-proposal` 이 매니페스트 재기록(pending 해소·`spec_origin:agent_proposed_human_approved`) + **인입과 같은 함수(`_extract_test_images`·`_promote_evidence_docs`)로 전후사진 추출 + claim-basis 승격(doc-NN·doc-NN-tKK·image_path)** → gate 가 state.evidence_on_file 재동기화 → 01-brief 부터 하류 동일 소비.
- **⚠ 안전 불변식(완화 아님·정밀화):** 에이전트 제안은 **사람이 `kind:test_report` 로 선언한 문서의 상세만** 채운다 — bare/일반 첨부를 test_report 로 승격은 **금지**(validate-stage 00e + apply-proposal intent-match fail-closed "intent 선언 필요"). 규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람 승인.
- **산출물:** `00e-evidence/reflection-proposal.json` · `00e-evidence/evidence-verdict.json`. 둘 다 활성이면 순서 **00-ingest → 00e-evidence → 00g-guideline → 01-brief**. **회귀:** `tests/test-evidence-reflection.sh`·`test-evidence-attachment.sh`.

### 00g-guideline — 유사사례 분석 → 크롤 참조 노트 (조건부)

> **설계 변경(구 '유사점 3안' 파기):** 방향을 A-trust/B-usevalue/C-composition 3안으로 가르고 `project-guideline.json` 을 `select` 하던 옛 설계는 파기됐다(정본 `workflow-ssot.md`). 현재 00g 는 사례별 객관 분석(`example-analysis.json`)은 유지하되, 종합 판단은 **자유텍스트 참조 노트 한 건(`reference-notes.json`)**으로 받고 **단안 approve · 심의 면제**로 전이한다.

- **목적:** 동일 규제도메인 사례 N개를 측정신호(가격·할인·평점·리뷰수·포토리뷰비·재구매·VOC테마·블록시퀀스)에 그라운딩해 **"왜 좋은가(`why_good`)"** 와 구도/무드를 도출 → 현업이 자유텍스트 참조 노트로 확정. 하류(컨셉·스토리라인·이미지)에 제품-무관 참조를 soft 권고로 공급(법=룰셋 우선).
- **조건:** **조건부(off-mainline)**. 본선은 00-ingest→01-brief 직행. `inputs/examples/<도메인>/` 에 사례 있을 때만 진입(`ingest-bundle.sh:147-153`). **기본 레포엔 이 디렉터리가 없어** 실제로는 자기 번들 1건 폴백(`run-stage.sh:228`)이거나 미진입.
- **입력:** 항상 라벨 VOC·CLAIM_BASIS·ASSETS_MANIFEST·REGULATORY_DOMAIN·RULESET + 인라인 RUN_ID·EXAMPLE_DIRS. 파일: `inputs/examples/<도메인>/<사례>/{product.json,reviews.csv,images/}` + 00-ingest 산출물 + `prompts/guideline.md`.
- **생성:** 이중경로. stub=`examples_analysis.py`(신호계산·why_good 임계치 템플릿·구도/무드 태깅·참조 노트 결정적 산출), 실LLM=`prompts/guideline.md`(① why_good.grounded_in 은 실재 signals/voc_themes/structure 키만 인용=fail-closed, ② no-pixel, ③ 법>가이드라인, ④ 동일 도메인만).
- **산출물:**
  - `examples/<id>/example-analysis.json`(signals·voc_themes·structure{block_sequence,pacing}·**why_good[]{claim,grounded_in[minItems:1],confidence}**·reference_images·analyzed_by)
  - `reference-notes.json`(자유텍스트 크롤 참조 노트: flow_refs·composition_notes·notes; 효능·절대 표현 금지)
- **게이트:** generate→**approve**(단안·`is_multi=false`, select 없음)→advance(01-brief). 승인 즉시 자동 통과(2중승인 아님). revise 재진입 시 reference-notes 재생성, examples/ 보존.
- **심의:** **면제**(phase-descriptors `review:false` → `kcia-check` `review-exempt-autopass`). 크롤 참조 노트는 광고 카피가 아닌 다운스트림 참조 입력이라 중복 심의를 제거 — 금지표현 차단은 **생성 시 `validate-stage` 룰엔진**이 맡고(why_good.grounded_in 실재키, reference_images 태그 화이트리스트·why deny, regulatory_domain==state 도메인 fail-closed), 참조에서 흘러나온 표현은 하류(컨셉·스토리보드·키비주얼) 심의에서 잡힌다.
- **max:** 3.
- **하류:** `REFERENCE_NOTES` 라벨로 컨셉(RTB·키메시지)·스토리라인·아웃라인·이미지 생성에 주입(soft 권고, 법=룰셋 우선; `reference-notes.json` 실재 시에만 방출, `common.sh:350-354`). example-analysis 의 reference_images 는 구도/무드 reference 로 하류 조인.
- **참조이미지 캡처(M2):**
  - ~~참조이미지의 구도/느낌 캡처 슬롯 부재~~ → **M2 구현**: `example-analysis.reference_images[]{id,src,block_type,similarity,composition_tags[],mood_tags[],why,rights}`(감각 구도·무드 캡처; id=`<example_id>#NN` join 키). `tone-direction`·`plan-block` reference 에 `reference_image_id`(M6 에서 조인 배선). `examples_analysis.py` 가 화이트리스트 어휘로 결정적 생성(실 LLM=`prompts/guideline.md`). **fail-closed**: validate-stage 가 신규 00g 에서 reference_images 비어있지 않음 + 태그 화이트리스트 + why 효능·절대·속효·실증/정량 deny(도메인 룰셋 banned+lexicon 로드, NFKC·카테고리 기반 정규화로 zero-width/구두점/%-삽입 우회 차단) + id 형식·전역유일 + src=크롤경로(저작권) 강제. (잔여: reference_image_id referential-integrity 는 M6 조인 때.)

### 01-brief — PR/FAQ 정리

- **목적:** 앞단 결과를 Amazon PR/FAQ(`brief.json`)로 정리해 컨셉에 핸드오프. 효능 단정 대신 VOC 상위 키워드로 헤드라인, approved 아닌 기능성은 카피 배제, 규제/실증 리스크는 internal FAQ + `sensitive_labels` 로 명시.
- **조건:** 항상.
- **입력 라벨:** VOC·CLAIM_BASIS·ASSETS_MANIFEST·REGULATORY_DOMAIN·RULESET(항상) + FEEDBACK·BEST_PRACTICES·BRIEF(자기참조)(조건부). (구 PROJECT_GUIDELINE 라벨 파기 — 00g 참조는 concept 이후 REFERENCE_NOTES 로 주입)
- **생성:** 3택(실LLM/insession/stub). brief 전용 분기 없이 generic 경로(가장 단순). 프롬프트 핵심: VOC 키워드 헤드라인, approved≠기능성 카피 배제, 리뷰0 개념 컨셉주축 금지, 페르소나=VOC 비례 가설, internal FAQ 에 규제/실증 리스크 필수, 00g 경유 시 `confirmed_guideline` 으로 정합.
- **산출물:** `brief.json`(pr·faq required; faq.internal minItems:2; sensitive_labels; 00g 경유 시 confirmed_guideline{framing_id,label,thesis}) · `brief.md`.
- **게이트:** generate→review→**user**(단안, select 없음)→approve→advance(02-concept). **approve 시 RA 게이트:** sensitive_labels 에 `approved` 가 1건↑이면 `--ra-ok`(또는 `KCIA_RA_OK=1`) 없이 승인 불가(`approve.sh:48-59`).
- **심의:** 있음. pr·pr.quotes·solution·confirmed_guideline·external FAQ 스캔, **internal FAQ 는 의도적 제외**(금지어 카탈로그 자기검출 방지, `kcia_engine.py:325`). Pass-A critic 이 도메인 `sources/*.md` 가이드 원문 직접 열람. 비활성 도메인 placeholder-autopass.
- **max:** 3.
- **하류:** 02-concept 로 `BRIEF` 라벨(brief.json 경로)로 동봉 — 단 컨셉은 brief 를 **직접 파싱하지 않고**(handoff 문서 명시) 방향 힌트로만 참조. 컨셉의 하드 의존은 voc/claim-basis/도메인.
- **⚠️ 갭(사용자 질문 ①):**
  - ~~⓪선언이 **비대칭으로만** 취합됨 — 포맷(`deliverable_format`)이 build_context·brief 스키마·brief.md 어디에도 없음~~ → **M1(G4)에서 해소**: build_context 가 `DELIVERABLE_FORMAT` 라벨 항상 방출 · `brief.schema.json` 에 `output_type{regulatory_domain,deliverable_format}`(additive-optional) · `prompts/brief.md` Inputs+힌트 · stub `gen_brief` 가 output_type 기록(env `HARNESS_FORMAT` 주입) · `validate-stage.sh` 01-brief 분기가 output_type 존재+state 일치 **fail-closed 강제**. 이제 브리프는 도메인-인지·**포맷-인지**.
  - 00g 의 풍부한 why_good 근거(grounded_in 키들)는 brief 로 오며 `confirmed_guideline` 의 thesis 한 줄로 환원(보존 안 됨).
  - 참조이미지 구도/느낌 캡처 전무(설계상 후단 storyboard 로 미룸).

### 02-concept — 빅아이디어·RTB·키메시지

- **목적:** 컨셉 축(A-efficacy / B-emotional|B-safety / C-science)별 **독립 생성**(mode collapse 방지)으로 RTB(Reason To Believe)+키메시지 → pairwise 추천. 효능은 approved 기능성+실재 evidence_ref 만, 감성 키메시지는 voc_phrase 100% 인용 강제. VOC 비거나 광고제한 도메인이면 B-emotional→B-safety 치환.
- **조건:** 항상.
- **입력 라벨:** VOC·CLAIM_BASIS·ASSETS_MANIFEST·REGULATORY_DOMAIN·RULESET(항상) + BRIEF·CONCEPT_DECISION·BEST_PRACTICES·REFERENCE_NOTES·FEEDBACK(조건부). (M3: TONE_DECISION 제거)
- **생성:** 축정의→축별 단독호출→추천 3스텝 독립생성(N안 동시호출 금지). stub=결정적 파생, insession=검증·전이만.
- **산출물:** `concept-axes.json`(axes minItems:2) · `options/<축>/rtb.json`(rtb[]{id,claim,claim_strength,evidence_ref,review_status}) · `options/<축>/key-message.json`(emotional 슬롯 voc_phrase 강제) · `recommendation.json` · `decision.json`.
- **게이트:** generate→review→**select**→advance(03-storyboard). validate 가 **concept-axes·recommendation 까지 하드 TARGET**으로 강제하고, 모든 축에 rtb+key-message 존재를 부분생성 차단으로 요구. loop-guard 2곳(`gate.sh:59,118` + `run-stage.sh:156-164`). 축별 idempotent skip(`run-stage.sh:264-273`).
- **심의:** 있음(verdict=`02-concept/review/concept-verdict.json`). 룰엔진 evidence 존재성 1차(superlative/efficacy/speed 인데 evidence_ref 가 실재 id 와 매칭 안 되면 revise) + critic 2-pass. verdict 재개 멱등은 id(완료마커) 보유 시만.
- **max:** 3.
- **하류:** `CONCEPT_DECISION` 라벨(02-concept/decision.json)로 이후 전 단계 전파. selected_option 은 state.json 기록.
- **⚠️ 갭(검증 정정):**
  - 포맷-무지(도메인만 인지). 포맷은 keyvisual 단계에서만 가드.
  - **REFERENCE_NOTES 라벨**은 00g 의 자유텍스트 크롤 참조 노트(`reference-notes.json`: flow_refs·composition_notes·notes)를 방출한다(구 `PROJECT_GUIDELINE`/`project-guideline.json` 리치 객체·thesis 3안은 파기). soft 권고, 법=룰셋 우선. `concept.md` 프롬프트가 이 라벨을 참조한다.
  - recommendation 이 pairwise 비교근거를 구조화 안 함(rationale 문자열뿐).

### 03-storyboard — outline(스토리라인) → plan(기획안) (한 페이즈, 2 서브스테이지; M3: tone 흡수)

- **목적:** 선택 컨셉(`02-concept/decision.json`)을 한국형 캐논(`canon-blocks.md` 15블록/10대 구성요소)에 배치. **outline(스토리라인)**=블록순서 2안 A/B + 근거(`sources/results.json`), **plan(기획안)**=블록별 본문카피(헤드라인/서브카피/본문/claims/footnotes/visual) + **구도/무드/참조를 `visual.concept` 에 직접 산출**(M3: tone 서브스테이지 흡수), 강주장-각주 페어링 강제. ✅ **M7/M8/G6**: one_pager 도 active_phases(03·04)에 포함되어 포맷별 스토리라인·기획안·키비주얼을 거친다(format-aware 생성기 `CANON_BY_FORMAT`: multipage_bm=15블록 / one_pager=1매 캐논). **03-storyboard 의 본질: 포맷별 스토리라인·기획안을 "좋은 키비주얼이 나오도록" 기획·리서치.**
- **조건:** 항상. outline→plan 순서 강제(위반 시 die). 내부 조건부: clinicalEvidence/beforeAfter 블록은 `evidence_on_file` 비어있지 않을 때만; results.json 은 효능 텍스트 감지 시만 채움(else 빈배열+evidence_sufficient=false).
- **입력 라벨:** 표준 항상5 + BRIEF·CONCEPT_DECISION·BEST_PRACTICES·PROJECT_GUIDELINE·FEEDBACK(조건부). (M3: TONE_DECISION 라벨 제거.)
- **생성:** outline=generic 경로(storyline A/B+추천+sources 한 패스), plan=전용 분기(선택 storyline 블록별 개별 생성, **visual.concept 항상 부착**, idempotent skip, **revise 시 위반 블록만** 재생성). 프롬프트: 효능·질환·권위·절대표현 금지, 강주장(superlative/efficacy/speed)은 각주+실재 evidence_ref 페어링, 크롤 이미지는 텍스트 방향으로만(픽셀 기본 자사컷).
- **산출물:**
  - `outline/options/{A,B}/storyline.json`(channel_profile·blocks{order,type,intent,risk_tier,enabled_if}) + `outline/recommendation.json`
  - `sources/results.json`(results[]{id,title,grade}·evidence_sufficient·**engine enum=`[manual,mcp]`만**) + `query.json`
  - `plan/NN-<type>.json`(type·order·headline·subcopy·bodyText·**visual{kind,concept{composition,mood,palette,typography,reference{own_asset_path,direction,crawl_pattern_ref,reference_image_id}}}**·claims{target_text,claim_strength,evidence_ref,footnote_id}·footnotes·approval_state) + `NN-<type>.md`
  - (M3: `tone/*` 산출물 제거. tone-direction(s).schema 는 레거시 후방호환만.)
- **게이트:** outline=multi select(서브스테이지 내 전진=plan, advance 아님), plan=단안 approve→advance(04). plan primary 는 `plan/01-hero.json` 하드코딩(첫 블록=hero 가정).
- **심의:** 2 서브스테이지 모두 대상. plan 은 블록 단위+실증게이트블록 환각 차단(강주장-각주 페어링) + **visual.concept(구도/무드/reference.direction)도 add_block 이 스캔**(tone 흡수). **outline 은 `kcia_engine.gather()` 전용 분기가 없어 banned-text 심의가 사실상 빈검사**(본문카피 없어 의미상 타당; outline 의미 게이트는 `validate_storyboard.py`·커버리지가 담당). Pass-A critic 도메인 원문 열람. **활성인데 ruleset.axes 가 비면 강제 escalate**. 비활성 도메인 placeholder-autopass.
  - **커버리지 두 단계(M3):** outline(선택 전 **각 옵션 독립** 평가 — 합집합 false-pass 차단)·plan 둘 다 `check_canon_coverage.py --scope` 하드 게이트. plan 은 **visual.concept fail-closed**(모든 블록 구도/무드+reference.own_asset_path). 포맷별 커버리지 SSoT=`format-profiles.coverage_path → canon-components.<format>.json`.
  - **검증 정정:** `validate_storyboard.py` 는 거부(hard-fail) 게이트(실증 미등록 상태에서 게이트블록·graph 비주얼 *존재하면* exit 1). hero(BM)/format-aware 필수 루트 블록 누락·order 오름차순/유일성도 하드 강제. CANON enum 은 storyline 스키마에서 로드(format-aware).
- **max:** 4(2 서브스테이지 공유).
- **하류:** 선택 storyline 이 plan 의 블록리스트 소스(같은 페이즈 내). 구도/무드/참조는 plan visual.concept 에 직접 산출. plan 산출물은 04-keyvisual 로 진행(STORYLINE/STORYBOARD_PLAN 라벨은 M6 에서 추가).
- **✅ 반전 / ⚠️ 갭:**
  - 참조이미지 **구도/느낌 텍스트 캡처는 plan visual.concept 에서 구현됨**. 감각 reference_images(구도/무드 태그)는 M2 에서 00g 에 신설, plan reference_image_id 조인은 M6.
  - 포맷 폭은 `channel`(`_channel()`)로 stub 에 반영(M8: BM/one_pager 860), 블록 시퀀스는 `CANON_BY_FORMAT` 로 포맷별. stub 키비주얼 HTML 레이아웃은 generic 세로 템플릿(실 LLM 은 프롬프트 분기로 포맷-native).

### 04-keyvisual — 디자인 생성·렌더·export

- **목적:** 확정 plan 을 **포맷별 레이아웃**(multipage_bm=860 세로 섹션 스택 / one_pager=1매 포스터)의 HTML/CSS 2안(A/B)으로 디자인, 로컬 Playwright 로 `[data-block]` 요소 단위 섹션 PNG 캡처→`design-manifest.json`, 선택안 기준 협회 광고자문 제출 패키지(kcia-package) export. 좌표 슬라이싱이 아닌 DOM 요소 단위 캡처 + 셀프호스팅 폰트로 재현성 확보.
- **조건:** 항상 + 가드 2: (1) **포맷** status≠active 면 친절중단(`run-stage.sh:83-89`이 `format-profiles.json` 의 `formats.<fmt>.status` 검사 — 현재 multipage_bm·one_pager 모두 active), (2) 현재 phase 가 04 아니면 중단. in-session 모드 미지원(subprocess 강제, `run-stage.sh:35,192`). ✅ 전 포맷이 04 active(M7/M8) + 키비주얼 프롬프트 format-aware(G6) — 실 LLM 이 포맷-native 키비주얼 생성(stub 키비주얼은 폭·블록은 포맷 반영하나 레이아웃은 generic 세로 템플릿).
- **입력:** assets-manifest(자사 src allowlist 근거)·voc·claim-basis·`bundle/product.json`(자사 URL allowlist)·**plan/NN-<type>.json(확정 기획안=디자인 입력, visual.concept 포함)**·`inputs/assets/`(자사) + 생성 이미지(`04-keyvisual/generated/`)·셀프호스팅 폰트·design-tokens·`packs/_format/<포맷>/canon.json`(캐논 정본, 4단계 통합).
- **생성:** **2단 구조** — 생성(LLM/stub)=HTML 2안, 렌더/캡처/manifest/lint=**결정적 Python**(`render.py`·`img_lint.py`·`check_beforeafter.py`). `<img src>` 는 자사 자산/생성물/자사 URL 만(부족 시 타이포/도형 대체). beforeAfter 섹션엔 '연출·개인차' 디스클레이머 자동 삽입. (선택)`gen-images.sh` 가 plan visual.concept 를 슬롯별 이미지로 생성해 `04-keyvisual/generated/` 에 둠.
- **산출물:** `options/{A,B}/index.html`(+styles.css,shots/) · `recommendation.json` · `design-manifest.json`(channel·width_px=포맷별(BM/one_pager 860)·dpi·selected_option·sections[]{block,order,selector,screenshot,self_review{layout_ok,overflow,contrast_ok}}) · (gen-images 시)`image-manifest.json` · `decision.json`(스키마 **실재**, `harness/decision.schema.json`) · `design-verdict.json` · **`canon-coverage.json`**(scope=design 출력물) · `export/kcia-package/`(+ 00-ingest 근거 매니페스트 있으면 조건부 `kcia-package/evidence/`·`package.json.evidence_documents`·README `## 첨부 근거 문서` 절 — 아래 근거 첨부 export 노트).
- **게이트:** generate→review→**select→approve(2중승인)**→advance(done). approve 가 선택안으로 render-design 재렌더→validate 재검증→export_package.
- **심의:** 있음(verdict=`design-verdict.json`). critic 이 도메인 `sources/*.md` 가이드 원문 참조. index.html 노출텍스트+노출속성(alt/title/aria/data-*)+CSS content+design-manifest self_review 스캔. **저작권 lint 는 2곳**(`render-design.sh:14-16` + `validate-stage.sh:194-198`)에서 이중 강제. `render.py:48` 이 안 보이는 섹션(shot 실패·height≤0·빈 텍스트)을 manifest 에서 drop 해 커버리지 우회 차단. 비활성 도메인 placeholder-autopass.
- **max:** 2.
- **하류:** 종착(next=done). 같은 페이즈 내부 전파: design-manifest.sections→canon 커버리지 게이트, decision/recommendation→export 선택옵션.
- **⚠️ 갭:**
  - 도메인·포맷 '소비'만(design-manifest 에 도메인/포맷 필드 없음).
  - 참조이미지(크롤 원본)의 구도/느낌을 텍스트로 옮기는 중간 산출물 없음(assets-manifest 는 count/gif 만).
  - `contrast_ok` 는 `render.py:57` 에서 항상 True 하드코딩(실측 아님). layout_ok/overflow 는 박스 좌표 기반 실측.
  - **실제 이미지 픽셀을 심의하는 멀티모달 게이트는 전 파이프라인에 없음** — design-manifest self_review 가 stand-in.

> **근거 문서 첨부 export(링크 C, `export_package.py` — 조건부):** approve 의 export_package 단계에서, 00-ingest 매니페스트 `evidence-documents.json` 이 **있을 때만** 협회 제출 패키지에 `kcia-package/evidence/`(첨부 실파일) + `package.json.evidence_documents[{id,filename,grade,sha256,bytes,linked_claim_ids}]` + README `## 첨부 근거 문서` 절(**WB 추출 텍스트 근거표와 별개 절**)을 만든다. 순서 = ① orphan 가드(`inputs/evidence/` 에 정규파일이 있는데 매니페스트 부재 = fail-closed, "근거 없음" 조용한 처리 차단) → ② `kcia-package/evidence/` **항상 `rmtree`**(shots 패턴, stale 자기정리) → ③ 정확집합 대조(디스크 정규파일 집합 == 매니페스트 filename 집합 + 각 sha256 일치; extra·missing·해시불일치 = fail-closed) → ④ 안전순서 무결성 복사(**바이트를 읽기 전에** lstat 정규파일 확인·realpath run-local 경계검사·크기 상한 재확인 → 원본 재해시·매니페스트 대조 → 복사 → **복사본 재해시**로 사본 무결성 확인). `package.json`/`README.md` 는 매번 새로 써서 근거 필드/절이 자기정리된다. **근거 없는 런은 evidence/·필드·절이 전혀 안 생겨 기존 패키지가 바이트 불변.** 첨부는 HTML/CSS `<img src>` 참조와 무관(img_lint 대상 아님)이며 **첨부 전송이지 주장 실증이 아니다**(첨부 id 심의 실증셋 미편입 — 00-ingest 근거 첨부 노트). 상세 = `docs/_archive/evidence-attachment-plan.md`.

> **키비주얼 이미지 안전·품질(F1·F2·F3, 2026-07-06, `docs/_archive/keyvisual-image-safety-fixes-plan.md`):**
> - **F1(C) 그래픽 블록 규제안전(도메인 게이팅):** 확산모델(Nano Banana)이 그래픽/인포그래픽 블록(`render_mode==html_only`)에 없는 인증(FDA)·수상·순위·수치를 환각해 굽는 규제 리스크를 차단. `image_engine._block_emits_image(b, model, domain)` 이 **규제도메인(drug/quasi_drug/health_food)은 그래픽 블록을 온라인에서도 미생성**, 화장품(cosmetic)·미선언은 굽되(디자이너 참고) **어느 도메인이든 그 baked PNG 를 옵션 HTML/export 가 참조 금지** — `check_render_refs.py` 가 html_only 블록의 생성 PNG `<img>` 참조를 **전 도메인 fail-closed**(2026-07-05 핸드오프 예외 회수). 도메인은 `gen-images.sh`·`render-design.sh` 가 `--domain`(resolve_domain)으로 전달. 그래픽 블록은 인라인 SVG/HTML 텍스트 레이어로만 표시·심의·게재. **오프라인 골든 불변**(stub 은 html_only 미생성). 회귀 = `test-render-mode-gate.sh`(case 5 역참조 금지로 전환)·`test-image-engine.sh`(8, 도메인 게이팅).
> - **F2 Pro 400 자동 강등:** `image_engine._call_nanobanana` 가 400(INVALID_ARGUMENT)에서 `NanoBananaModelRejected`(status=400, `NanoBananaQuotaExhausted` 형제)를 던지고 `generate_all` 이 429 와 동일 다이얼로 `HARNESS_NANOBANANA_FALLBACK_MODEL` 자동 강등. fallback 도 400 이면 fail-closed(증분 매니페스트 incomplete). 감사 1줄(키 마스킹). 회귀 = `test-image-engine.sh`(6e).
> - **F3 aspect 크롭 제거:** (a) `prompts/keyvisual.md` 가 블록 `<img>` 를 자연비율(`height:auto`, `object-fit:cover` 고정박스 금지)로 지시 → 제품컷 가장자리 크롭 0. (c) `image_engine._normalize_png_aspect`(Pillow) 가 생성 PNG 를 선언 aspect 로 **패드(레터박스, 크롭 0)** 규격화(Pro/flash 크기차 흡수·표시 정렬). online 전용(stub SVG 무관 → 골든 불변). 회귀 = `test-image-engine.sh`(7).

### 게이트·심의 (전 단계 횡단)

- **gen≠review 물리격리:** `HARNESS_CLI`(생성)가 `KCIA_CRITIC_CMD`(심의)에 substring 으로라도 등장하면 self-grading hard-stop(`kcia-check.sh:74-78`; Snorkel self-critique paradox 98.1%→56.9% 근거). 가드는 현재 stage 의 generate 이벤트 토큰 기반 — 재개 전이는 `resume:transition:<stage>`(generate: 접두 없음)라 GEN_CLI 가 비어 critic-live 면 fail-closed die.
- **심의 2층:**
  1. 1차 결정적 룰엔진(`kcia_engine.py`, ruleset 4~5축 정규식+spaceless+`N`→`\d+` 매칭 + evidence 존재성, **항상**). **verdict=fail 은 'high 위반'이 아니라 위반 1건이라도 있으면**(severity 무관, `kcia_engine.py:583`); escalate(하드스톱, 전문의약품 대중광고 등)은 `:587`. 결과는 작업영역 밖 scratch baseline 으로 씀.
  2. 2차 선택 critic 2-pass(`KCIA_CRITIC_CMD` 설정+비오프라인+비stub): Pass-A(`kcia-critic.md`, default=근거부족, ADD-only — 룰엔진이 놓친 문맥위반 추가) → Pass-B(default refuted=true, 건별 적대검증). `kcia_merge.py` 가 baseline∪(Pass-A 후보 중 Pass-B refuted:false) ADD-only 병합, baseline high/substantiation 은 삭제·완화 불가.
- **도메인 가이드 원문 참조:** 룰엔진은 ruleset.json(축·lexicon)만, **Pass-A critic 프롬프트엔 `docs/regulation/<도메인>/sources/*.md` 원문 경로 주입 → critic 이 직접 열어 그 도메인 광고심의 기준으로 심의**(`kcia-check.sh:171-180`).
- **비활성 도메인:** status≠active(quasi_drug=tbd, health_food=ready-only)는 placeholder-autopass(verdict=pass, engine=placeholder-autopass)로 **무조건 통과** — ruleset 채우고 status=active 전환 전까지 실질 심의 없음(설계상 TODO, AGENTS.md §8). cosmetic·drug 만 active.
- **revise 경로(검증 정정):** revise 는 user 게이트뿐 아니라 **select 게이트에서도 허용**(`revise.sh:24-31` — 00g/02-concept '3안 전부거절→재생성'의 근거 경로). select.sh/approve.sh 에 중단복구 멱등 분기 존재.
- **무결성 다중방어:** 작업영역 매니페스트 해시·$VP 선출현 검출·baseline 해시 검증으로 critic 변조/위조 fail-closed 차단. 완성 verdict(id 보유)면 재심의 생략.
- **인입-완료 표식(근거 첨부 정합성):** `ingest-bundle.sh` 가 write-ahead 로 쓰는 `00-ingest/.ingest-incomplete` 표식이 있으면 **9개 진입점**(`run-stage`·`validate-stage`[run 모드; `--file` 면제]·`advance-phase`·`next-action`·`approve`·`select`·`revise`·`kcia-check`·`gate`)이 어느 phase 에서든 fail-closed·재-인입 강제한다. `advance-phase --to` 로 00-ingest 를 떠나는 양쪽 출구(00g-guideline·01-brief)는 표식 부재만으론 부족하고 **양성 완료**(status=passed + 필수 4종 present&valid)를 요구한다(상세 = 00-ingest 근거 첨부 노트).
- **산출물 verdict 경로(verdict_path):** 00g=`guideline-verdict.json` · 01-brief=`brief-verdict.json` · 02-concept=`review/concept-verdict.json` · 03-storyboard=`{outline-verdict,plan-verdict}.json`(M3: tone-verdict 제거) · 04-keyvisual=`design-verdict.json`.

---

## 3. 교차점검 결론

### ⚑ 의도 대비 갭 — 사람 확인 추가 (3건, 2026-06-21)

아래는 코드/문서가 *정확히 현재를 기술*하나 **사람이 밝힌 의도와 어긋나는** 지점이다(현재상태 기술은 이 스냅샷 유지, 목표 설계는 재설계 계획서가 담당).

- **갭-A (크롤 "왜 좋은가" = 정량뿐, 감각적 인사이트 아님):** 의도는 "크롤된 사례를 분석해 현업이 **감각적으로** 좋다고 느끼는 지점의 '왜 좋은가'를 제안 → 인사이트 제공". 코드 현실: (1) `best-practices.json` composition_note 는 정적 사전 `BP_HINTS`(분석 아님·why 없음, `ingest.py:149-163`), (2) `example-analysis.why_good` 는 **정량·상업 신호**(할인·평점·리뷰·재구매)에만 그라운딩(`examples_analysis.py:100-125`) — 시각/감각적 "이 디자인이 왜 보기 좋은가"는 없음. → 재설계 **WS-C** 가 reference_images 로 근접하나 그 `why` 도 정량 키 인용이라 **감각 why 까지 확장 필요**.
- **갭-B (포맷이 스토리보드를 스킵 = 임시방편) — ✅ 해소(M7/M8/G6):** 의도였던 "한장도 포맷에 맞는 스토리보드·아웃라인·키비주얼"이 구현됨. `format-profiles.json` 의 one_pager active_phases 에 03-storyboard·04-keyvisual 포함(M7/M8), 스토리보드는 format-aware 생성기(CANON_BY_FORMAT), 키비주얼 프롬프트는 `DELIVERABLE_FORMAT` 분기(G6). **잔여(비차단)**: canon DRAFT/STUB 정식화 · stub 키비주얼 format-aware化(선택 — 결정적 픽스처).
- **갭-C (3단계 = 포맷별 기획 리서치로 재정의) — ✅ 해소(M7/M8/G6):** 의도였던 "03-storyboard = 한장/여러장 각각의 스토리라인·아웃라인을 좋은 키비주얼이 나오도록 기획"이 구현됨 — `CANON_BY_FORMAT` 포맷별 캐논 + 포맷별 커버리지 SSoT(`canon-components.<format>.json`, one_pager=STUB) + 키비주얼 프롬프트 format-aware(G6). 잔여: canon 정식화.

→ 이 3건의 **목표 설계·구현**은 재설계 계획서로 반영(§0.7 + WS-C 확장 + 신규 **WS-G**).

### ① 유형선언이 브리프에 취합 안 되는 이유 (사용자 질문 1)
- `new-run.sh` 가 2축을 `state.json` 에 박는 게 **취합의 전부**고, 01-brief 는 **도메인만 컨텍스트로 소비**(brief.json 엔 미기록), **포맷은 어느 build_context 라벨에도·brief 스키마에도 없음**(`common.sh:172-231` awk 본문에 deliverable_format printf 부재). 계획서 §0.1 은 "브리프=[워킹백워드→산출물 유형 정의→유사사례 취합]"을 한 묶음으로 보지만, **코드는 이걸 3곳(new-run / 00-ingest / 00g)으로 흩뜨려** 놓았고 브리프 산출물은 유형을 자기 안에 담지 않음.
- 포맷의 실제 소비처는 brief 가 아니라 하류 분기뿐: `advance-phase`(active_phases 스킵) · `run-stage.sh:86-92`(keyvisual 게이트) · `kcia_engine.py`(prescription audit·mandatory_inclusion final_page). 모두 state.json 직접 읽기.
- **→ 재설계 보완 필요(WS-F).**

### ② 유사사례 분석·왜 좋은지 제안 (사용자 질문 2)
- "왜 좋은가"(why_good) 도출은 **구현됨**(00g; 구 3안 thesis 는 파기, 현재 자유텍스트 reference-notes). 참조이미지의 구도/느낌도 M2 에서 `example-analysis.reference_images` 로 캡처된다(아래 ③ 재설계 메모는 그 이전 스냅샷).
- **→ 재설계 WS-C 가 정확히 이 갭을 메움**(example-analysis 에 `reference_images[]{composition_tags,mood_tags,why}` + tone/plan reference 에 `reference_image_id`, 전부 additive·미구현).

### ③ 누적(디자인=상위 종합)
- brief·concept 는 04 에 `BRIEF`/`CONCEPT_DECISION` 라벨로 흘러감. 그러나 **storyboard plan/storyline 은 전용 라벨이 없음**(M3 에서 TONE_DECISION 라벨 제거). `keyvisual.md` 는 입력을 3개(ASSETS_MANIFEST·REGULATORY_DOMAIN·RULESET)만 선언. → STORYLINE/STORYBOARD_PLAN/REFERENCE_IMAGES 라벨은 M6 에서 추가.
- **→ 재설계 WS-D 가 `STORYLINE`/`STORYBOARD_PLAN`/`REFERENCE_IMAGES` 라벨 추가로 메움**(미구현).

### 계획 vs 코드 충돌 (구현 전 주의)
- **심의-after-승인(WS-A)은 미구현** — 현재 코드는 정반대(생성→심의→승인). 계획서는 미래 목표.
- ~~**TONE_DECISION 라벨** 충돌~~ → **M3 에서 해소**: tone 서브스테이지 제거(흡수), TONE_DECISION 라벨 제거. STORYLINE/STORYBOARD_PLAN/REFERENCE_IMAGES 누적 라벨은 M6.
- **`inputs/examples/` 픽스처가 레포에 없어** 00g 유사사례 입력이 사실상 비어 있음(자기 번들 1건 폴백).

---

## 부록 — 검증 출처

이 문서는 8개 단위(⓪·00·00g·01·02·03·04·게이트심의)를 각각 **정독 → 적대검증(다른 에이전트가 인용 파일 재대조) → 전체 교차점검**한 결과다(워크플로우 17 에이전트, 366 tool 호출). 검증자가 잡은 정정(step enum 5값, status enum 7값, results engine enum=`[manual,mcp]`, validate_storyboard 거부-vs-제외, PROJECT_GUIDELINE 전체객체, drug claim-basis 빈`{}`+evidence 정상동작, decision.schema 실재, 저작권 lint 2곳, verdict=fail 조건 등)을 본문에 반영했다.
