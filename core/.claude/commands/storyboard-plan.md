---
name: storyboard-plan
description: 12블록 기획안 생성 (운영자·에이전트용)
disable-model-invocation: true
---
# /storyboard-plan — 12블록 기획안(블록 단위) · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

지금 이 세션의 에이전트가 직접 선택된 스토리라인의 모든 블록 기획안을 생성한다. 산출물만 쓰고 **전이는 스크립트에 위임**(state.json 금지).
> 헤드리스(Slack/배치): `HARNESS_CLI=claude bash scripts/run-stage.sh storyboard-plan <RUN>`

`<RUN>` = 현재 run_id (스토리라인(outline)이 먼저 확정돼 있어야 함; M3: tone 서브스테이지 흡수). 순서:
1. **입력·지침(읽기전용):** `bash scripts/run-stage.sh storyboard-plan <RUN> --emit-context` — PROMPT_FILE(`prompts/storyboard-plan.md`)·입력·OUT 읽기. 선택된 outline(`03-storyboard/outline/decision.json`)을 따르고, 구도/무드/참조는 블록별 `visual.concept` 에 직접 산출한다.
2. **생성**(블록 단위 — 선택 스토리라인의 **모든** 블록):
   - `runs/<RUN>/03-storyboard/plan/NN-<type>.json` (예: `01-hero.json` … 선택 스토리라인의 모든 블록)
   - 모든 정량 수치는 `voc.json` 단일 출처, 자산 경로는 `inputs/assets` 하위. 주요 구성요소 커버리지 충족. **state.json 금지.**
3. **검증·전이:** `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh storyboard-plan <RUN>`
4. **다음:** `bash scripts/kcia-check.sh <RUN>` → `bash scripts/approve.sh <RUN>` (기획안 확정).
> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다.
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
