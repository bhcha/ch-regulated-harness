---
name: evidence
description: 반영 제안 초안 생성 (첨부 참조 문서 → kind 추정 + 원문 발췌 반영 포인트)
disable-model-invocation: true
---
# /evidence — 반영 제안 초안 생성 · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 00e-반영제안(첨부 참조 문서의 kind 추정 + 원문 발췌 반영 포인트) 초안을 생성한다(헤드리스 `claude -p` 미사용).
산출물만 쓰고 **상태 전이는 스크립트에 위임**한다(state.json 은 절대 건드리지 않는다).

반영 제안 초안은 **광고 카피가 아니라 하류(스토리보드·키비주얼) 반영을 위한 참조 입력**이다(심의 면제, review:false).
현업이 **문서만 첨부**(반영 스펙 미정)한 참조 문서를 세션 내 에이전트가 읽고, **kind 추정 + 원문 발췌 반영 포인트**를 제안한다.
**사람이 이후 승인**하므로, 창작하지 말고 문서에 실제로 있는 것만 충실히 제안한다(환각 안전).

`<RUN>` = 현재 run_id(대화/인자에서 확인). **문서별 fan-out(한 건씩) + 체크포인트**로 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh evidence <RUN> --emit-context
   ```
   출력의 `PROMPT_FILE`(= `prompts/evidence.md`)·`EVIDENCE_DIR`(첨부 참조 문서 원본 폴더)·`PENDING_DOCS`(반영 스펙 미정 문서 목록)·
   `build_context` 가 가리키는 입력(RULESET · REGULATORY_DOMAIN 등)을 **모두 읽는다**.
   `RUN_DIR` 의 `00e-evidence/`(= `<EDIR>`)가 산출물 위치다.

2. **첨부 문서 정독(세션 내, 문서별 한 건씩 — fan-out + 체크포인트):**
   `EVIDENCE_DIR`(`runs/<RUN>/inputs/evidence/`)의 **모든 파일을 직접 읽는다**. `PENDING_DOCS` 의 각 문서를 **한 번에 하나씩** 처리한다.
   매니페스트(`00-ingest/evidence-documents.json`)의 그 문서 `kind` 로 두 갈래로 나뉜다:
   - **일반 참조 문서**(kind 미선언/비-test_report): `kind` 추정(certification/paper/patent/ingredient_dossier/brand_story/guide/general) +
     `claim`(한 줄) + `reflection_points`(반드시 반영할 **원문 발췌** 포인트). **원문 발췌만(창작·의역 금지)** — 문서 원문 문장 그대로.
     ⚠ 스스로 `test_report` 를 새로 고르지 마라(규제 성격 선언은 사람 몫).
   - **시험성적서 intent**(매니페스트 `kind==test_report` + `spec_status==pending`, W-3): 사람이 "이 문서=시험성적서"까지만 선언하고
     상세는 00e 에서 채우기로 한 문서다. **PDF 원문에서 그대로 읽을 수 있는 값만** `kind:"test_report"` 로 제안한다(지어내기 금지):
     `claim` · `verdict_text`(공식 판정문 원문) · `grade`(예 인체적용시험) · `test_report.institution`(시험기관) ·
     `test_report.sample_size`(참여자수 n, 정수) · `test_report.duration`(기간) ·
     `test_report.test_items[]`(항목별 `metric`·`unit`·`series`[시점별 {label,value}]·`before`/`after`·`change_pct`[보고서 정수 표기 OK — 인입이 정규화]·
     `stat_note`[통계 각주 원문]·`image_ref.pages`[전후사진이 실린 문서 페이지 — 추출돼 임상 TEST 섹션 전후 이미지로 결박, 한 항목=한 페이지]) ·
     `reflection_points`(판정문/핵심 결과 원문 ≥1). 값은 전부 문서 원문의 실제 수치여야 한다.

3. **초안 작성:** `00e-evidence/reflection-proposal.json` 을 스키마(`harness/reflection-proposal.schema.json`)대로 작성한다.
   `docs[]` 는 `PENDING_DOCS` 와 1:1(`id`=doc-NN·`filename` 매니페스트 일치), `spec_origin="agent_proposed_human_approved"`.
   **법(심의 룰셋) > 문서:** 미승인 기능성·효능·절대 표현을 반영 포인트로 올리지 마라. **state.json 은 건드리지 않는다. 산출물 파일만 쓴다.**

4. **검증·전이(스크립트가 상태를 쓴다):**
   ```bash
   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh evidence <RUN>
   ```
   제안 초안의 완전성(pending 문서 전건 커버·조건부 필수)을 검증하고 다음 게이트로 전이한다(생성 엔진은 신뢰 마커로 자동 감지·기록).
   00e 는 **심의 면제**(review:false)라 승인 뒤 `kcia-check` 가 실제 심의 대신 자동 통과시킨다(승인 직전 형식은 재검증).

5. **다음:** `runs/<RUN>/run.md` 의 "다음 명령" 한 줄을 따른다(승인 → 점검은 게이트가 정한다).

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
