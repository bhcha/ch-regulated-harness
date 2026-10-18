---
name: concept
description: 컨셉 3안(축별 독립) 생성 (운영자·에이전트용)
disable-model-invocation: true
---
# /concept — 컨셉/빅아이디어(축별 독립) · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 컨셉을 생성한다(헤드리스 `claude -p` 미사용).
산출물만 쓰고 **상태 전이는 스크립트에 위임**한다(state.json 금지).

`<RUN>` = 현재 run_id. 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh concept <RUN> --emit-context
   ```
   `PROMPT_FILE`(= `prompts/concept.md`)과 `build_context` 의 입력 파일(VOC · CLAIM_BASIS · BRIEF ·
   RULESET · PROJECT_GUIDELINE)을 모두 읽는다.

2. **생성 — 축별 *독립* 작성(한 번에 N안 금지, mode collapse 방지):**
   `prompts/concept.md` 의 계약·규칙·스키마를 그대로 지켜 `runs/<RUN>/02-concept/` 하위에:
   1. `concept-axes.json` — 서로 다른 축 정의(VOC 없는 도메인은 감성 축 대신 안전성·정보 축).
   2. 각 축마다 **따로** `options/<axis-id>/rtb.json` 과 `options/<axis-id>/key-message.json`
      (한 축을 쓸 때 다른 축을 보지 말 것 — 독립 생성). 효능 주장은 `claim-basis` approved + 실재 `evidence_ref` 만.
   3. `recommendation.json` — 통과 가능한 안들 pairwise 비교, `ranked[]` 는 **실재 축 id** 만, `rationale` 포함.
   - 각 축은 비지 않은 rtb·key-message 가 ≥1 이어야 검증을 통과한다. **state.json 은 건드리지 않는다.**

3. **검증·전이(스크립트가 상태를 쓴다):**
   ```bash
   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh concept <RUN>
   ```
   모든 축의 산출물 완전성(`validate-stage`)을 검증하고 심의 게이트로 전이한다(엔진 자동 감지·기록).

4. **다음:** `bash scripts/kcia-check.sh <RUN>` → 통과 후 `bash scripts/select.sh <RUN> <축id>`.

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(생성과 선택/전이 분리).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
