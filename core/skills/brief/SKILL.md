---
name: brief
description: 브리프 생성 (PR/FAQ)
disable-model-invocation: true
---
# /brief — 브리프 생성 (PR/FAQ) · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 브리프를 생성한다(헤드리스 `claude -p` 미사용).
산출물만 쓰고 **상태 전이는 스크립트에 위임**한다(state.json 은 절대 건드리지 않는다).

`<RUN>` = 현재 run_id(대화/인자에서 확인). 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh brief <RUN> --emit-context
   ```
   출력의 `PROMPT_FILE`(= `prompts/brief.md`)과 `build_context` 가 가리키는 입력 파일
   (VOC · CLAIM_BASIS · RULESET · PROJECT_GUIDELINE 등)을 **모두 읽는다**.

2. **생성:** `prompts/brief.md` 의 계약·규칙·스키마(`harness/brief.schema.json`)를 그대로 지켜
   `runs/<RUN>/01-brief/brief.json` 과 사람용 `runs/<RUN>/01-brief/brief.md` 를 직접 작성한다.
   - 효능 단정 금지. `claim-basis` 가 `approved` 아닌 기능성은 카피에 쓰지 않는다(미승인 표현 배제).
   - quotes 의 voc_phrase 는 voc.json 의 실제 키워드만. `sensitive_labels[]` 누락 금지.
   - **state.json 은 건드리지 않는다. 산출물 파일만 쓴다.**

3. **검증·전이(스크립트가 상태를 쓴다):**
   ```bash
   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief <RUN>
   ```
   산출물을 검증하고 심의 게이트로 전이한다(생성 엔진은 신뢰 마커로 자동 감지·기록).

4. **다음:** `bash scripts/kcia-check.sh <RUN>` (심의는 생성과 **다른 엔진**으로 — 별 프로세스).

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
