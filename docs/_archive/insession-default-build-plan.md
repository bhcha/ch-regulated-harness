# 생성=기본 in-session 전환 + 가이드라인 사례별 분석(B안) — 빌드 플랜 (v0.1)

> **성격:** 실행 가능한 빌드 계획. 기반 메커니즘(`HARNESS_GEN_MODE` 스위치·엔진 감지·제어흐름 역전)의 설계 근거는
> [`_archive/in-session-generation-proposal.md`](./_archive/in-session-generation-proposal.md) · [`_archive/in-session-genmode-build-plan.md`](./_archive/in-session-genmode-build-plan.md) 가 SSoT.
> 이 문서는 그 기반 위에서 **① 기본값을 insession 으로 전환**하고(인터랙티브 세션 한정), **② 미구현이던 가이드라인 단계를 in-session 사례별 fan-out 으로 완성**한다.
> 불변식·안전 규칙의 SSoT 는 [`../AGENTS.md`](../AGENTS.md) 0~9번 절. 워크플로 정본은 [`workflow-ssot.md`](./workflow-ssot.md)(동반 갱신 의무).
> 작성일: 2026-06-24.

---

## 0. 한 줄 정의

**심의가이드(크리틱)는 `claude -p` 별 세션 그대로 두고, 그 외 모든 생성은 무조건 in-session 으로 돌린다.**
생성=claude(세션 내 직접) + 심의=claude(`-p` 별 프로세스) → "생성≠심의" 격리를 유지하면서 헤드리스 생성의 권한대기·좀비·600초 행을 제거한다. 가이드라인은 사례를 **한 건씩** 분석(체크포인트)해 "단위=단계 전체"를 "단위=사례 1건"으로 줄인다.

## 1. 배경·진단 (왜 지금 이 변경인가)

가이드라인 단계가 반복해서 헤드리스 `claude -p` 서브프로세스로 떨어져 600초 워치독에 걸리고 산출물이 0바이트로 남았다. 원인은 두 가지로 확정됐다.

1. **가이드라인 in-session 스킬이 없다.** `HARNESS_GEN_MODE=insession bash scripts/run-stage.sh guideline <id>` 플러밍은 이미 동작한다(workflow-ssot 가 "코드 진실"로 명시). 그러나 brief·concept·storyboard-* 와 달리 **`skills/guideline/`(= in-session 작업 지시서)가 없어서** 운영자가 헤드리스 경로로 떨어졌다.
2. **run.md 라우팅이 헤드리스를 가리킨다.** `scripts/lib/render_runmd.py`(89·120행)가 "다음 명령"을 맨몸 `bash scripts/run-stage.sh <stage> <id>`(= subprocess/stub)로 찍는다. in-session 경로를 가리키지 않는다.

또한 현재 `GEN_MODE` 기본값이 `subprocess`(run-stage.sh 201행)라, 운영자가 신경 쓰지 않으면 인터랙티브 세션에서도 헤드리스로 돈다 — 코드 주석(204–205행)이 이미 "인터랙티브 사용자가 HARNESS_CLI 를 신경 쓰지 않아도 insession 이 작동해야 한다"는 의도를 적어두었으나, 기본값이 그 의도를 실현하지 못한 상태였다.

## 2. 리서치 근거 (신뢰성 패턴)

GSD(Get Shit Done)·spec-kit(spec-driven development)·Anthropic 멀티에이전트 리서치 시스템이 수렴하는 신뢰성 원리:

- **큰 콘텐츠를 한 방에 분석하지 않는다.** 작은 자기완결 단위로 쪼개(분해) → 각 단위를 깨끗한 컨텍스트로 → 중간 산출물을 파일로 체크포인트 → 마지막에 합친다(map-reduce / fan-out with merge).
- **GSD**: "context rot" 처방 = 작업마다 새 컨텍스트(Task 도구), 통신은 오직 파일, 결정적 로직은 스크립트(LLM 아님), 스테이지 웨이브.
- **spec-kit**: plan → `tasks.md`(병렬 마커 `[P]` + 파일경로) 로 분해해 모놀리식 생성을 막음.
- **Anthropic**: orchestrator-worker 팬아웃 + 체크포인트(컨텍스트 잘리기 전 저장) + durable execution(에러 지점부터 재개) + 독립 지속 artifact.

이 하네스는 이미 그 골격(`state.json` + scripts 가 결정적 전이, LLM 은 산출물 파일만)을 갖췄다. **in-session 은 그 골격에 정확히 맞고**(셸=오케스트레이터/검증·전이, 세션 에이전트=산출물 작성), 가이드라인 사례별 fan-out 은 위 원리의 직접 적용이다(부분 완료 보존 → 재개가 싸다).

## 3. 목표·비목표

**목표**
- `HARNESS_GEN_MODE` 미지정 시, Claude Code 세션이 감지되면 기본 insession(그 외 subprocess 폴백).
- 미구현이던 가이드라인 in-session 경로를 사례별 fan-out + reduce + 체크포인트로 완성(신규 스킬).
- run.md "다음 명령"이 항상 in-session 경로를 가리켜 헤드리스 재발 차단.
- 가능하면 키비주얼까지 in-session(렌더를 결정적 후처리로 분리).

**비목표**
- 심의(크리틱) 격리 변경 금지 — `kcia-check.sh` 는 `claude -p` 별 세션 그대로(코드 변경 0).
- subprocess 생성 능력 삭제 금지 — 헤드리스 자동화(Slack/cron/codex)·CI 골든은 명시 opt-in 또는 오프라인으로 보존.
- stub/오프라인 결정성 변경 금지(CI/골든 바이트 동일).

## 4. 변경 범위 식별 (어디부터 어디까지)

| # | 영역 | 파일 | 변경 성격 |
|---|---|---|---|
| A | in-session 기본값 전환 | `scripts/run-stage.sh` 198–206행 | 핵심(behavior) |
| B | 가이드라인 in-session 스킬 + 사례별 fan-out(B안) | `skills/guideline/SKILL.md`(신규) → `sync-skills.sh` → `.claude/commands/guideline.md` | 핵심(신규) |
| C | `--emit-context` 에 EXAMPLE_DIRS 방출 (+ DRY 헬퍼) | `scripts/run-stage.sh` 16–37·237–245행, `scripts/lib/common.sh` | 소 |
| D | run.md "다음 명령" in-session 라우팅 | `scripts/lib/render_runmd.py` 85–120행, `scripts/next-action.sh` | 중(라우팅) |
| E | 키비주얼 in-session(렌더 후처리 분리) | `scripts/run-stage.sh` 209·387–389행, `skills/keyvisual/SKILL.md` | 중·난이도↑("가능하면") |
| F | 심의 = claude -p 분리 (불변) | `scripts/kcia-check.sh` | **코드 변경 없음** — 운영자 env 만 |
| G | 회귀 가드·테스트 | `tests/*` | 검증 |
| H | 정본 문서 동반 갱신 | `workflow-ssot.md`, `AGENTS.md`, `harness-improvement-plan.md` | 문서 의무 |

핵심 seam 은 이미 깨끗하다: `run-stage.sh` 207–224행의 `GEN_MODE=insession` 분기가 `NEED_GENERATE=0` 으로 모든 `run_llm` 호출을 skip 하고, 세션 내 에이전트가 먼저 쓴 산출물을 검증·전이만 한다. 격리 가드(`generate:insession:<stage>:<engine>` 토큰 → kcia-check 자가심의 차단)도 이 경로에서 그대로 작동한다.

## 5. A — in-session 기본값 전환 ("무조건 insession")

`scripts/run-stage.sh` 201행:
```sh
GEN_MODE="${HARNESS_GEN_MODE:-subprocess}"   # 현재: 기본 subprocess
```
→ **Claude Code 세션이 감지되면(= `detect_insession_engine` 성공) 기본 insession**, 아니면 subprocess:
```sh
# 기본값 자동선택(무조건 insession 사상): HARNESS_GEN_MODE 미지정 시, Claude Code 세션이 감지되고
#   오프라인이 아니면 insession, 아니면(세션밖/cron/codex/CI) subprocess 로 폴백.
if [ -n "${HARNESS_GEN_MODE:-}" ]; then GEN_MODE="$HARNESS_GEN_MODE"
elif [ "${HARNESS_OFFLINE:-0}" != "1" ] && [ -n "$(detect_insession_engine 2>/dev/null || true)" ]; then GEN_MODE="insession"
else GEN_MODE="subprocess"; fi
```
- 불변 유지: `HARNESS_OFFLINE=1` → subprocess 강제(206행, CI/골든 결정성). stub 경로 영향 없음.
- subprocess 능력 보존: `HARNESS_GEN_MODE=subprocess` 명시 또는 세션밖 자동 폴백. → "무조건 insession"은 **인터랙티브 세션에서** 성립, 헤드리스 자동화는 안전(looser coupling, 되돌리기 쉬움).
- 효과: 맨몸 `bash scripts/run-stage.sh <stage> <id>` 가 세션 안에서 곧 insession(= 검증·전이) 의미가 된다 → D(라우팅)와 짝. 생성은 스킬이 산출물을 **먼저** 쓴 뒤 이 명령으로 전이.

`detect_insession_engine`(`common.sh` 256행)은 이미 존재 — Codex 활성 시 fail-closed, `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` 마커로 claude 감지. 198행 주석도 새 기본값에 맞춰 갱신.

## 6. B — 가이드라인 in-session 스킬 + 사례별 fan-out (핵심)

**신규 `skills/guideline/SKILL.md`** — `skills/brief/SKILL.md` 패턴을 미러링(머리에 "운영자·생성 에이전트용, 현업 비대상" 한 줄, `disable-model-invocation: true`). 본문 워크플로 = 사례별 fan-out + reduce + 체크포인트:

1. **컨텍스트 로드(읽기전용):** `bash scripts/run-stage.sh guideline <RUN> --emit-context` → `PROMPT_FILE`(`prompts/guideline.md`)·`EXAMPLE_DIRS`(C에서 추가)·`build_context` 입력을 모두 읽는다.
2. **(하이브리드 정량 레이어, 결정적):** `python3 scripts/lib/examples_analysis.py <GDIR> <domain> <EXAMPLE_DIRS...>` 로 사례별 `signals`·`voc_themes`·`structure` 베이스라인 + `reference-notes.json` 종합을 **먼저** 만든다. (이미 구현: `analyze_example` 378행, `synthesize_reference_notes` 401행.)
3. **(감각 레이어, in-session 사례별 fan-out):** 각 사례 폴더를 **한 건씩**(또는 사례당 Task 서브에이전트 병렬 — 둘 다 in-session, 헤드리스 아님) 처리:
   - 그 사례의 상세 이미지·리뷰 원본을 직접 보고, `00g-guideline/examples/<id>/example-analysis.json` 의 감각 필드(`reference_images`: composition_tags·mood_tags·why, `why_good.grounded_in`)를 스키마(`harness/example-analysis.schema.json`)대로 보강해 덮어쓴다.
   - **체크포인트/idempotent:** 이미 있고 valid 한 사례는 skip. 4번 사례에서 끊겨도 1~3번은 파일로 보존 → 재실행 = 진짜 증분 재개(헤드리스 0바이트 전체 재실행과 대비).
   - 화이트리스트 어휘·효능/절대/속효어 금지(생성 시 `validate-stage` 룰엔진이 차단).
4. **종합 보강:** 사례별 보강이 끝나면 `00g-guideline/reference-notes.json`(`flow_refs`·`composition_notes`·`notes`) 최종화. 법=룰셋 우선, banned/효능어 배제.
5. **검증·전이:** `HARNESS_GEN_MODE=insession bash scripts/run-stage.sh guideline <RUN>` → `validate-stage`(필수 집합 = reference-notes + 사례별 example-analysis 전부)가 완전성 강제 후 전이. 00g 는 심의 면제(`review:false`)라 승인 뒤 `review-exempt-autopass`.

→ `bash scripts/sync-skills.sh` 로 `.claude/commands/guideline.md` 생성(슬래시 소스 = skills/SKILL.md, CI test-b0 정합).

## 7. C — `--emit-context` 에 EXAMPLE_DIRS 방출 (DRY)

드리프트 방지를 위해 `common.sh` 에 헬퍼 `guideline_example_dirs <rid>` 를 추가(동일 도메인 `inputs/examples/<도메인>/*` 열거, 없으면 `00-ingest/bundle` 폴백 — `HARNESS_EXAMPLES_DIR` 오버라이드 존중). 이를 **두 곳이 공유**:
- `run-stage.sh` 16–37행 `--emit-context` 의 guideline 케이스: `EXAMPLE_DIRS=` 한 줄 방출.
- `run-stage.sh` 237–245행 본 디스패치: 기존 인라인 열거를 헬퍼 호출로 치환.

→ in-session 에이전트가 순회할 사례 폴더를 재유도 없이, subprocess 와 **동일 입력**으로 받는다(15행 주석 "두 모드 간 입력 드리프트 차단" 사상).

## 8. D — run.md "다음 명령" in-session 라우팅

`scripts/lib/render_runmd.py` 85–120행: 생성-스텝(step=generate)의 "다음 명령"을 맨몸 subprocess 가 아니라 **in-session 스킬 경로**로 라우팅. 즉 "`/<stage>` 슬래시(또는 emit-context → 산출물 작성 → `HARNESS_GEN_MODE=insession run-stage.sh <stage>`)". 키비주얼은 E 채택 여부에 따름. `next-action.sh`(Slack 어댑터)가 같은 로직을 재사용하므로 한 곳 수정으로 두 채널 정합. 현업 노출 문구는 평이어 유지(`operator_labels` SSoT). → 운영자/에이전트가 다시 헤드리스로 안 떨어진다.

## 9. E — 키비주얼 in-session ("가능하면") — 렌더 후처리 분리

현재 막힘: `run-stage.sh` 209행이 keyvisual+insession 을 die. 387행이 렌더(`render-design.sh`)를 `NEED_GENERATE != 0`(= subprocess)일 때만 실행 → insession 이면 렌더 skip → design-manifest 없어 validate 실패.

처방:
- 209행 die 제거.
- 387행 가드를 "HTML 산출물 존재 + design-manifest 없음/stale 이면 렌더"로 바꿔 **insession 에서도 렌더가 돈다**(`render-design.sh` 는 Playwright 결정적 스크립트라 claude 불필요). 순서 보존: 렌더(387) → validate(391).
- `skills/keyvisual/SKILL.md` 를 in-session 으로 재작성: 에이전트가 `options/{A,B}/index.html` + `recommendation.json` 작성 → `HARNESS_GEN_MODE=insession run-stage.sh keyvisual` 가 렌더 캡처 + manifest + 저작권 lint + 검증 + 전이.
- **안전판:** 렌더 디커플링은 회귀 위험이 크다(manifest/lint 타이밍). 회귀 테스트 통과 못 하면 키비주얼만 subprocess 로 남기고(209행 die 복구) 나머지는 in-session 유지 — "가능하면"의 출구.

## 10. F — 심의 = claude -p 별 세션 (불변, 코드 변경 0)

- `kcia-check.sh` 변경 없음. 운영자가 `export KCIA_CRITIC_ENGINE=claude-subagent` 만 선언하면(명령 미설정 시 70행이 자동 `claude -p $HARNESS_CLAUDE_FLAGS`) 크리틱이 별 프로세스 `claude -p` 로 돈다.
- 자가심의 가드 정합: 생성이 insession 이어도 history 에 `generate:insession:<stage>:claude` 로 박히고, 크리틱은 claude-subagent 예외 경로(별 세션 + 적대 프롬프트 + 작업영역밖 scratch)로 허용된다(43–157행). → 생성=claude(insession) + 심의=claude(`-p` 별 세션)이 정확히 의도한 분리.

## 11. 안전 불변식 (절대 안 바뀜)

- 생성≠심의 격리, evidence 존재성, 필수기재, 전문의약품 하드스톱, 저작권 lint, 환각 게이트 전부 그대로.
- `state.json` 은 여전히 `scripts/*.sh` 만 쓴다(in-session 에이전트는 산출물 파일만).
- in-session fail-closed 가드 유지: generate 스텝에서만 · 1차 산출물 없으면 die · 엔진 마커 미상이면 die.
- `HARNESS_OFFLINE=1`/stub = subprocess 결정성 불변(CI/골든).

## 12. 검증 (end-to-end)

1. **가이드라인 in-session 실데이터(이번 막힌 run):** `KCIA_CRITIC_ENGINE=claude-subagent` 선언 → 가이드라인 스킬 워크플로로 사례 6건을 한 건씩 분석(체크포인트 확인: 중간에 끊고 재실행 시 완료 사례 skip) → `HARNESS_GEN_MODE=insession run-stage.sh guideline <id>` 전이 → 600초 행 없이 통과. `bash scripts/timing.sh <id>` 로 소요 확인.
2. **격리 회귀:** `bash tests/test-gen-not-review-isolation.sh` green. 생성=claude(insession)+심의=claude-subagent 에서 self-grading 가드 통과, 잘못된 동일명령은 여전히 차단되는지.
3. **결정성 회귀(CI):** `HARNESS_OFFLINE=1` 골든/픽스처(`scripts/build-fixtures.sh`, 골든 러너)가 subprocess+stub 로 변함없이 통과.
4. **슬래시 동기화:** `bash scripts/sync-skills.sh` 후 `.claude/commands/guideline.md` 생성, test-b0 정합.
5. **키비주얼(E 채택 시):** in-session HTML 작성 → 전이가 렌더 캡처 + manifest + lint + 검증까지 돌아 done 도달. 실패 시 안전판(subprocess 복구) 동작 확인.
6. **관측성:** `runs/<id>/.logs/timing.jsonl` 에 `gen_source=insession` 기록 확인(`tests/test-observability.sh`).

## 13. 작업 묶음(PR)

- **PR1(핵심):** A(기본값 전환) + B(가이드라인 스킬·fan-out) + C(emit-context) + D(라우팅) + G·H 해당분. ← "반복 헤드리스/600초 행" 즉시 해소.
- **PR2("가능하면"):** E(키비주얼 in-session) — 렌더 디커플링 + 회귀. PR1 과 독립.

## 14. 동반 갱신 의무 (구현 시)

- [`workflow-ssot.md`](./workflow-ssot.md): 가이드라인 insession 을 "미구현 → 구현"으로, 미구현 4항목 중 ①(하이브리드)·②(emit-context EXAMPLE_DIRS)·③(`/guideline` 커맨드) 반영. 헤더 '갱신' 날짜·변경요약 기재.
- [`../AGENTS.md`](../AGENTS.md) 2번 절: `HARNESS_GEN_MODE` 기본값 자동선택(세션 감지 시 insession) 명시.
- [`harness-improvement-plan.md`](./harness-improvement-plan.md): 9번 절 insession 연결 메모 갱신.

## 15. 범위 밖 / 후속

- workflow-ssot 미구현 ④ "subprocess `/tmp`·examples 폴백 버그"는 in-session 이 헤드리스 경로를 가리지 않도록 **별도** 소수정(생성 1급 경로가 insession 이 되면 우선순위↓이나, 헤드리스 자동화 보존을 위해 후속에서 수정 권장).
- `run_llm` 거짓 성공 차단(`common.sh` 216–221) 등 `harness-improvement-plan.md` 9번 절 후보는 이 작업과 독립.
