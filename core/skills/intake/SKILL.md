---
name: intake
description: 첨부 자료 보편 분류 제안 생성 (첨부 폴더 → 파일별 category/route/kind + reflect_preview + docx→md 변환)
disable-model-invocation: true
---
# /intake — 첨부 자료 보편 분류 제안 생성 · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 00a-분류제안(첨부 파일별 보편 분류 + 라우팅 + 결과물 반영 예고)을 생성한다(헤드리스 `claude -p` 미사용).
산출물만 쓰고 **상태 전이는 스크립트에 위임**한다(state.json 은 절대 건드리지 않는다).

> 헤드리스(배치·CI)는 **결정적 stub 만** 지원: `HARNESS_OFFLINE=1 bash scripts/run-stage.sh intake <RUN>`. 실엔진 헤드리스 생성은 fail-closed(설계상 세션-밖 실엔진 금지)라, 실제 첨부 분석·제안은 **세션 내 `/intake`(이 스킬)로만** 한다.

분류 제안은 **광고 카피가 아니라 라우팅 결정 입력**이다(심의 면제, review:false). 현업이 넘긴 **첨부 폴더 하나**(워킹백워드·제품이미지·
크롤 zip·시험성적서 PDF 등)를 세션 내 에이전트가 파일마다 읽고 **보편 분류 + "결과물에 어떻게 반영될지"** 를 제안한다.
**사람이 이후 승인**하므로, 창작하지 말고 파일에 실제로 있는 것만 충실히 분류한다(환각 안전 — 규제 성격 선언은 사람 몫).

`<RUN>` = 현재 run_id(대화/인자에서 확인). **파일별 fan-out(한 건씩) + 체크포인트**로 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh intake <RUN> --emit-context
   ```
   출력의 `PROMPT_FILE`(= `prompts/intake.md`)·`ATTACHMENTS_DIR`(스냅샷 첨부 원본 폴더)·`PRODUCT_NAME_DECLARED`·
   `DECLARED_DOMAIN`·`DECLARED_FORMAT` 를 **모두 읽는다**. `RUN_DIR` 의 `00a-intake/`가 산출물 위치다.

2. **첨부 정독(세션 내, 파일별 한 건씩 — fan-out + 체크포인트):**
   `ATTACHMENTS_DIR`(`runs/<RUN>/inputs/attachments/`)의 **최상위 파일을 전부 직접 읽는다**(zip 해체본은 `_unpacked/<zip이름>/`,
   닷파일·`_unpacked`는 분류 대상 아님). 파일마다 **한 번에 하나씩** 원문·구조를 보고 분류한다:
   - **워킹백워드**(서사형 기획/브리프): `working_backwards` / route `working_backwards`.
   - **자사 상품 크롤**(product.json/reviews.csv + 제품명 = `PRODUCT_NAME_DECLARED`): `own_product_crawl` / `bundle`.
   - **참고 상품 크롤**(크롤 구조인데 제품명 ≠ 선언 제품): `reference_crawl` / `examples`(원본 이미지 직접 사용 금지 — 구도 참조).
   - **자사 제품 이미지**: `product_image` / `assets`.
   - **근거 문서**(시험성적서·인증·논문·특허·원료자료·브랜드스토리·가이드): `evidence_*` / `evidence` + `kind`.
     ⚠ 시험성적서로 보여도 **category(+`kind:"test_report"`)만 제안**하고 효능 수치·판정 상세는 채우지 마라 — 그건 사람 승인 뒤 00e 2차 관문이 한다.
   - **판단 불가**: `unknown` / `hold`(승인 게이트에서 사람이 정한다).

3. **워킹백워드 변환(열린 결정 3):** `working_backwards` 로 분류한 문서를 **직접 md 로 변환**해
   `00a-intake/converted/working-backwards.md` 로 저장하고, 그 파일 항목 `actions` 에 `converted` 를 넣는다(승인 표에 '변환됨' 표시).

4. **초안 작성:** `00a-intake/intake-proposal.json` 을 스키마(`harness/intake-proposal.schema.json`)대로 작성한다.
   `files[]` 는 스냅샷 최상위 첨부와 **1:1**(정렬), 파일별 `sha256` 는 실제 스냅샷 파일 해시와 정확히 일치해야 한다(위변조 시 승인 거부).
   `aggregate_preview` 에 집계 반영 예고 한 줄. **분류는 제안일 뿐 — state.json 은 건드리지 않는다. 산출물 파일만 쓴다.**

5. **검증·전이(스크립트가 상태를 쓴다):**
   ```bash
   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh intake <RUN>
   ```
   제안의 완전성(스냅샷 1:1 커버리지·sha256 정합·enum)을 검증하고 다음 게이트(gate=user, 승인 대기)로 전이한다.
   00a 는 **심의 면제**(review:false)라 승인 뒤 `kcia-check` 가 실제 심의 대신 자동 통과시키고, 그 마무리 훅이 승인된 분류대로
   기존 채널로 **라우팅(apply-intake)+인입(ingest-bundle)** 을 잇는다(승인 직전 형식은 재검증).

6. **다음:** `runs/<RUN>/run.md` 의 "다음 명령" 한 줄을 따른다(승인 → 점검 → 인입은 게이트가 정한다).

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
