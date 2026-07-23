---
name: storyboard-outline
description: 스토리라인 2안 생성
disable-model-invocation: true
---
# /storyboard-outline — 스토리라인 2안 · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

지금 이 세션의 에이전트가 직접 스토리라인 2안을 생성한다. 산출물만 쓰고 **상태 전이는 스크립트에 위임**(state.json 금지).
> 헤드리스(Slack/배치): `HARNESS_CLI=claude bash scripts/run-stage.sh storyboard-outline <RUN>`

`<RUN>` = 현재 run_id. 순서:
1. **입력·지침(읽기전용):** `bash scripts/run-stage.sh storyboard-outline <RUN> --emit-context` — PROMPT_FILE(`prompts/storyboard-outline.md`)·입력·OUT 목록을 읽는다.
2. **생성**(prompts/storyboard-outline.md 의 계약·스키마대로 직접 작성):
   - `runs/<RUN>/03-storyboard/sources/results.json`
   - `runs/<RUN>/03-storyboard/outline/options/{A,B}/storyline.json` (서로 다른 2안)
   - `runs/<RUN>/03-storyboard/outline/recommendation.json` (ranked=실재 옵션 id)
   - 주요 구성요소 커버리지를 만족해야 검증 통과. **state.json 금지.**
3. **검증·전이:** `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh storyboard-outline <RUN>`
4. **다음:** `bash scripts/kcia-check.sh <RUN>` → `bash scripts/select.sh <RUN> <옵션id>` (그 다음 storyboard-plan; M3: tone 서브스테이지 흡수).
> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다.
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
