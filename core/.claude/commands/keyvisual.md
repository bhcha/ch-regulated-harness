---
name: keyvisual
description: 디자인 2안(HTML/CSS) 생성
disable-model-invocation: true
---
# /keyvisual — 디자인 2안(HTML/CSS) 생성 · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 디자인 2안(HTML/CSS)을 작성한다(헤드리스 `claude -p` 미사용).
HTML 산출물만 쓰고 **렌더(Playwright 섹션 캡처)·design-manifest·저작권 lint·검증·전이는 스크립트에 위임**한다(state.json 금지).

`<RUN>` = 현재 run_id. 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh keyvisual <RUN> --emit-context
   ```
   `PROMPT_FILE`(= `prompts/keyvisual.md`)과 `build_context` 의 입력(STORYLINE·STORYBOARD_PLAN·REFERENCE_IMAGES·RULESET 등)을 **모두 읽는다**.

2. **생성 — `prompts/keyvisual.md` 의 캐논·디자인토큰·스키마대로 직접 작성:**
   - `runs/<RUN>/04-keyvisual/options/{A,B}/index.html` (서로 다른 디자인 2안, 단일 HTML/CSS — 외부 의존 없이 self-contained).
   - `runs/<RUN>/04-keyvisual/recommendation.json` (`ranked` = 실재 옵션 id, `rationale`).
   - **`<img src>` 는 자사 자산만**(`inputs/assets/`·생성물·product.json 자사 URL). 크롤 원본(`inputs/bundle/images/`) 금지 — 저작권 lint 가 fail-closed.
   - beforeAfter 섹션엔 '연출'·'개인차' 디스클레이머를 그 섹션 안에 둔다. 모든 정량 수치는 `voc.json` 단일 출처.
   - **design-manifest·섹션 PNG·canon-coverage·self-review 는 쓰지 마라** — 렌더 단계(아래 3)가 Playwright 로 생성한다. **state.json 도 건드리지 않는다.**

3. **렌더·검증·전이(스크립트가 한다) — 이미지 bake 포함이라 수 분~십수 분:**
   이 스텝은 로컬 Playwright 렌더(섹션 캡처 + design-manifest + 저작권 lint + 커버리지) **와 전 사진 블록 이미지 실생성(Pro 10~14장 + 429 백오프)** 을 함께 돌린다. 포그라운드 단일 툴콜은 세션 무진행 상한에 걸리니 **백그라운드로 띄우고 폴링**한다:
   ```bash
   mkdir -p "runs/<RUN>/.logs"
   nohup env HARNESS_CLI=claude HARNESS_GEN_MODE=insession \
     bash scripts/run-stage.sh keyvisual <RUN> </dev/null \
     >"runs/<RUN>/.logs/keyvisual-bg-$(date +%s).log" 2>&1 &
   echo "PID=$!"        # </dev/null 필수(백그라운드 stdin 무한 행 방지)
   ```
   **30~45초 간격 폴링**(툴콜 1회 = 스트림 진행):
   ```bash
   kill -0 <PID> 2>/dev/null && echo "진행 중" || echo "끝남"                       # ① 생존
   tail -n 5 "runs/<RUN>/.logs/"keyvisual-bg-*.log                                    # ② 로그(자산별 진행·429·강등)
   jq -r '.incomplete // "완료"' runs/<RUN>/04-keyvisual/image-manifest.json 2>/dev/null  # ③ 이미지 진행(증분 매니페스트 — incomplete=미완결)
   ```
   **완료 판정** = 프로세스 종료 + `image-manifest.json` 에 `incomplete` 부재 + `run.md` "다음 명령"(**선택 게이트**로 전이됨; 생성 엔진은 신뢰 마커로 자동 감지·기록). 중단은 자식까지: `pkill -P <PID>`.
   > Claude Code Bash 툴이면 `run_in_background: true` 로 같은 경로(백그라운드 실행 → 완료 통지 → 위 폴링).

4. **다음:** `runs/<RUN>/run.md` 의 "다음 명령"을 따른다(선택 → 승인 → 규정 점검은 게이트가 정한다).

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
