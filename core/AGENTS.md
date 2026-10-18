# AGENTS.md — 상세페이지 생성 자동화 하네스 (SSoT)

> 이 파일은 이 하네스의 **단일 진실 지침**이다. 생성 CLI 는 **Claude Code 단일**이다(생성 엔진 = `claude|stub`).
> Claude 는 `CLAUDE.md`(→ `@AGENTS.md`)로 자동 로드한다. 파일명을 `AGENTS.md` 로 두는 것은 agents.md 표준
> (미래 도구 호환·중첩 우선순위 메커니즘)을 따르기 위함이며, 다른 CLI 를 운영 경로로 지원한다는 뜻이 아니다.

## 0. 한 줄 정의
규제 대상 제품(**화장품·의약외품·건기식·의약품**)의 **홍보/상세 자료**(상세페이지·한장 홍보물)를 **파일 기반
단계 게이트**로 생성한다. 제품·규제도메인·산출물 포맷은 **사람이 선언**한다(§8, AI 자동분류 없음). 프레임워크가
아니라 `state.json` + `scripts/*.sh` 가 상태를 결정론적으로 전이하고, LLM 은 산출물 파일만 쓴다.
> 예시(PoC) 제품: **이지듀 쿠션**(화장품 도메인 샘플). 하드코딩이 아니라 교체 가능한 샘플 입력일 뿐이다.

> **진행 중(다중 규제도메인 일반화)**: 임의 워킹백워드를 받아 **제품의 규제도메인(화장품/의약외품/건기식/의약품)을
> 사람이 선언**하면 그 도메인 심의 가이드가 적용되도록 일반화 중이다(§8). 설계·빌드순서: `../docs/plans/multi-domain-build-plan.md`.

## 1. 절대 규칙 (이식성·안전)
1. **state.json 은 오직 `scripts/*.sh` 만 쓴다.** LLM/스킬은 산출물·`verdict.json`·`feedback.json`만 쓴다.
2. **1급 경로는 셸**: `bash scripts/run-stage.sh <stage> <run_id>`. 슬래시/커맨드는 편의 래퍼일 뿐 의존 금지.
3. **훅 의존 금지 · 자동발견 금지**: `.claude/agents` subagent 자동발견, 레포 `.agents/skills` 자동발견 금지.
   루프 제어는 항상 `state.json` + 명시 호출. **훅(hooks)은 게이트를 대체하지 않는 비-load-bearing 경화
   계층으로만 허용**한다 — 훅이 있다는 전제로 어떤 게이트도 완화하지 않으며, 훅이 없는 환경(CI stub
   subprocess·미래의 다른 실행기)에서도 **모든 fail-closed 가 그대로 성립**해야 한다. 전면 금지의
   옛 근거는 이중 CLI(Claude·Codex) 이식성이었으나 생성이 Claude 단일이 되어 그 전제가 소멸했다.
   현재 유일한 훅 = `scripts/hooks/deny-state-writes.sh`(PreToolUse — 런 `state.json`·`.logs/` 직접
   Write/Edit 을 도구 레벨에서 거부. 배선 = 레포 루트 `.claude/settings.json`, 회귀 = `tests/test-hook-deny.sh`).
   '운영 세션에선 금지지만 개발 세션에선 본업'인 보호(`scripts/`·`harness/` 스키마 수정)는 훅이 아니라
   머지 게이트(`.github/workflows/ci.yml`)가 맡는다.
4. **생성 ≠ 심의**: 생성과 심의는 다른 **벤더·원격 세션**. 운영 심의 엔진 = **원격 ADK(`adk-http`) 단일** — 다른 벤더(Gemini)·원격 세션이라 같은 스레드 자가비판이 구조적으로 불가능하다. 로컬 헤드리스 크리틱(`claude -p`)·`KCIA_CRITIC_CMD`·self-grading substring 가드는 **폐기**(원격 ADK 는 충돌 불가라 불필요).
   가드: `scripts/kcia-check.sh`(도메인 `adk_critic` 가용성으로 분기 + 작업영역-밖 scratch·baseline 해시·매니페스트 무결성). 적대 스탠스: `prompts/kcia-critic.md`(default=근거부족 + SIGNAL_RULES deny-list, ADD-only). 근거: Snorkel self-critique paradox(자가비판 98.1%→56.9%). 회귀 가드: `tests/test-gen-not-review-isolation.sh`.
   - **심의 엔진은 도메인별 원격 ADK 로 고른다**(2번 절). `packs/<도메인>/domain.json` 의 `adk_critic` 블록이 'ADK 구현됨' 마커이고, 그 블록이 가리키는 env(URL/host)로 원격 엔드포인트를 잡는다. 격리는 '다른 벤더·원격 세션 + 적대 역할 프롬프트 + 작업영역-밖 scratch'로 충족. `KCIA_CRITIC_ENGINE` 은 비우거나 `adk-http` 만 허용(`claude-subagent` 등 로컬 크리틱 값은 폐기). ⚠ `.claude/agents` 자동발견 의존 금지 — 원격 ADK 호출만(3번 규칙).
5. **환각 안전 기본값**: 워킹백워드에 근거 없는 효능 = `unknown`/빈 배열(주장 불가). 근거 없는 효능은 컨셉 주축 금지.
6. **evidence 존재성**: `claim_strength` 가 superlative/efficacy/speed 인 주장은 실재 근거 id(claim-basis/sources)와
   1:1 매칭 + 각주가 있어야 한다. 가짜/누락 id 는 자동 revise.

## 2. 환경변수 규약
> 사람용 조회표(변수·기본값·역할 한 표) = [`../docs/canonical/config-reference.md`](../docs/canonical/config-reference.md)(D-1 동반갱신). 아래는 규칙·의미 SSoT — env 를 추가/변경하면 여기와 그 조회표를 같은 변경에서 갱신한다.
- **stub 게이트 = `HARNESS_OFFLINE=1`(유일)**: stub(결정적 오프라인)은 CI/골든 전용이며, 그 진입 조건은 `HARNESS_OFFLINE=1` 하나로 통일한다(개편계획 ③). 운영(온라인)에서는 stub 이 절대 새지 않는다(실엔진 강제).
- `HARNESS_CLI=claude|stub` — 생성 엔진(**Claude 단일**; 다른 CLI 값은 거부·중단). **기본값은 환경 의존**: 오프라인(`HARNESS_OFFLINE=1`)=`stub` · 온라인=`claude`(`run-stage.sh`). ⚠ **온라인에서 `HARNESS_CLI=stub` 명시 = 거부(중단)** — stub 은 CI 전용이다.
- `HARNESS_GEN_MODE=subprocess|insession` — 생성 표면. **미지정 시 자동선택**: Claude Code 세션이 신뢰 마커로 감지되고 STUB_MODE 가 아니면(실엔진 claude + 온라인) **`insession`**(세션 안 에이전트가 산출물을 먼저 쓰고 스크립트가 검증·전이만 — 헤드리스 600초 행/0바이트 회피), 아니면 `subprocess`. ⚠ **세션 밖 실엔진 헤드리스 생성(`subprocess`+실엔진, 옛 `run_llm` 의 `claude -p`)은 폐기** — 비-STUB_MODE 인데 insession 미감지로 subprocess 귀결 시 **fail-closed**(중단). 따라서 도달 가능한 모드는 **insession(실엔진, 세션 내 직접 생성)** 또는 **subprocess+STUB_MODE(CI/오프라인 stub)** 뿐이다. ★ STUB_MODE(`HARNESS_CLI=stub` 또는 `HARNESS_OFFLINE=1`)는 명시 `insession` 이라도 **항상 subprocess+stub 로 강제**(CI/골든 결정성 불변). 세션 내 1급 경로 = 슬래시 `/<stage>` 스킬(산출물 작성 → `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> <id>` 로 전이). 키비주얼 포함 전 생성단계 지원(키비주얼 렌더는 전이 단계의 Playwright 후처리로 분리).
- **이미지 실생성(Nano Banana)**: `HARNESS_IMAGE_CLI=nanobanana|stub`(기본 `nanobanana`, 텍스트 엔진과 직교). `common.sh:resolve_image_engine` = **오프라인(`HARNESS_OFFLINE=1`)일 때만 stub SVG**(골든 바이트 불변), 그 외(온라인)에는 실엔진 강제 — `NANOBANANA_API_KEY` 존재 시 **Gemini 2.5 Flash Image (Nano Banana)** REST 실호출, **온라인인데 키 없음/명시 `stub` = fail-closed**(무음 stub 강등 금지; CI 는 `HARNESS_OFFLINE=1` 사용). 오버라이드: `HARNESS_NANOBANANA_MODEL`(기본 `gemini-2.5-flash-image`) · `HARNESS_IMAGE_TIMEOUT`(초, 기본 120; 비정상 값은 안전 폴백). 키는 URL 쿼리에만 — 로그·예외·매니페스트 비노출.
  - **부분실패 내성(P-1)**: 429(쿼터) 수신 시 지수 백오프(`HARNESS_NANOBANANA_BACKOFF` 기본 `15,30,60`초·`HARNESS_NANOBANANA_RETRY_429` 기본 3회; 확률적 금지콘텐츠/일시차단 재시도는 별개 다이얼 `HARNESS_NANOBANANA_RETRY` 기본 4회 — 429 백오프와 직교) → 소진 시 `HARNESS_NANOBANANA_FALLBACK_MODEL`(기본 `gemini-2.5-flash-image`·빈 값=끄기)로 해당 블록부터 자동 강등(stderr 감사 1줄). **증분 매니페스트**: 각 자산 성공 직후 `{…,"incomplete":true,…}` 원자 기록, 전 블록 완료 시 `incomplete` 제거 최종본 → 부분 성공분(예 9/13)도 이미지로 실린다. **완료 판정**(preflight 면제·멱등) = 매니페스트 존재 && `incomplete` 부재(`common.sh image_manifest_complete`). 실엔진 비-0 종료/incomplete 매니페스트면 `run-stage.sh` 가 fail-closed(미완결 이미지가 검증·전이로 누수 차단). stub 은 최종본만 → 골든 불변. ⚠ bake-all(그래픽 전 블록 이미지, 10~14장)로 Pro 쿼터 소진이 잦으므로 강등 다이얼 기본 flash(P-5).
- **실증 근거 검색(OpenAlex)**: `HARNESS_EVIDENCE_CLI=openalex|stub`(기본 `openalex`, 텍스트·이미지 엔진과 직교). `common.sh:resolve_evidence_engine` = **오프라인(`HARNESS_OFFLINE=1`)일 때만 stub**(결정적 → 골든 바이트 불변), 그 외(온라인)에는 실엔진(`openalex`) 강제 — **온라인인데 명시 `HARNESS_EVIDENCE_CLI=stub` = fail-closed**(무음 stub 강등 금지; CI 는 `HARNESS_OFFLINE=1` 사용). ⚠ OpenAlex 는 무료라 **키가 필요 없다** — NanoBanana 의 "키 없으면 fail-closed" 게이트는 여기 없다(엔진 선택은 오프라인/온라인만으로 결정). 오버라이드: `OPENALEX_MAILTO`(선택 — polite pool 이메일, URL 쿼리에만 실려 로그·예외 비노출) · `HARNESS_OPENALEX_TIMEOUT`(초, 기본 30) · `HARNESS_OPENALEX_RETRY`(429/5xx 백오프 재시도 횟수). MCP 아닌 **직접 HTTP**(이식성). **온라인 검색 실패=근거 없음(주장 불가)으로 처리하되, 엔진 자체 실패는 fail-closed**(무음 stub 강등 금지 — 온라인 검색은 네트워크 필요, 네트워크 실패는 호출부가 fail-closed 처리).
- **이미지 생성 직전 '최종 점검'**(비용·비가역 단계 앞 결손 점검 — 생성 쪽, 심의 아님): keyvisual 의 이미지 실생성 호출 직전, 읽기전용 `scripts/lib/image_preflight.py`(state 미기록)가 결손 권고와 예정 생성 장수를 종합해 "무엇이 빠졌고 → 그대로 가면 결과가 어떻게 나올지 → 그림 몇 장 예정"을 평이 한국어 digest 로 보여준다. **임계 결손**(임상 측정치가 등록됐는데 시험성적서 요소[시험기관·참여자수·시험기간·전후값] 중 빠짐 = 결손권고의 `must_fill`)이면 `run-stage.sh` 가 이미지 생성을 멈춘다(멈춤은 셸만 수행). 그래도 진행하는 비대화형 override = `HARNESS_ACK_GAPS=1`(또는 `--proceed-with-gaps`, 기본 미설정; 진행 시 감사용 한 줄). **면제**: stub/오프라인(STUB_MODE) 또는 `04-keyvisual/image-manifest.json` 존재(이미지 생성 완료=멱등 재진입)면 점검 자체를 건너뛴다(no-op 재개 보존). 강제 심의 게이트·verdict 는 불변이고 이건 심의(원격 ADK)가 아니다(생성≠심의 격리). `render-design.sh` 단독 경로는 image_engine 을 멱등 재호출하지만 preflight 미추가(비표준 경로). 회귀: `tests/test-gen-image-completeness.sh`.
- **심의 엔진 = 원격 ADK(`adk-http`) 단일 · 도메인별 엔드포인트**: 로컬 헤드리스 크리틱(`KCIA_CRITIC_CMD`·`KCIA_CRITIC_ENGINE=claude-subagent` 등·self-grading substring 가드)은 **폐기**. `KCIA_CRITIC_ENGINE` 은 **비우거나 `adk-http` 만** 허용(그 외 값은 중단). 엔드포인트는 도메인이 가리킨다 — `packs/<도메인>/domain.json` 의 **`adk_critic` 블록**(`url_env`/`host_env`/`app`/`author`)이 'ADK 구현됨' 마커이고, URL/host 는 그 `url_env`/`host_env` 가 가리키는 env 에서 읽는다. 예: 화장품 = `ADK_COSMETICS_CRITIC_URL` + `ADK_COSMETICS_CRITIC_ALLOWED_HOST`(app `cosmetics_agent` · author `cosmetics_review_agent`). **단일 `ADK_CRITIC_URL`/`ADK_CRITIC_ALLOWED_HOST`/`ADK_CRITIC_APP` 은 폐기.** 새 도메인 = `domain.json` 에 `adk_critic` 블록 + `.env` 에 그 env 추가만(core 코드 무수정).
  - **가용성 판정(가시화)**: `kcia-check.sh` 가 `adk_critic.py resolve --domain <d>`(네트워크 없음)로 분기한다 — `adk_critic` 블록 + URL env **둘 다 있음** → 원격 ADK 강제(`KCIA_CRITIC_REQUIRED=1`, 조용한 강등 금지, 엔드포인트는 `preflight` 사전검증) · 블록은 있으나 **URL env 비었음** → **설정오류 fail-closed**(중단) · **블록 없음(미구현 — `adk_critic` 블록 미배선 도메인)** → **ADK 생략·룰엔진-단독**(`review_depth=rule_engine_only`·`critic_ran=false`, "사람 확인 권장"으로 가시화). `status != active` 도메인은 그 위에 `placeholder-autopass`(8번 절). 오프라인/stub 생성은 결정성상 ADK resolve 자체를 건너뛴다.
  - (선택 env, `adk_critic.py` 가 읽음) `ADK_CRITIC_AUTH=none|oidc`(+ `oidc` 면 `ADK_CRITIC_ID_TOKEN`) · `ADK_CRITIC_HTTP_TIMEOUT`(초, 기본 300) · `ADK_CRITIC_RETRY`(빈응답 재시도) · `ADK_CRITIC_RETRY_BACKOFF`(재시도 간 지수 백오프 초 콤마목록, 기본 `2,5,10`; 콜드스타트 빈응답을 즉시 두드리지 않음 — Seam E C-1) · `ADK_CRITIC_ALLOW_LOCAL=1`(테스트 전용 — http/localhost·SSRF 가드 면제).
- `HARNESS_CLAUDE_FLAGS`(기본 `--permission-mode acceptEdits`)
  — 세션 내(insession) 실 LLM 생성이 산출물 파일을 쓰도록 하는 권한 플래그(생성 전용; 심의는 원격 ADK 라 무관).
- **생성 watchdog**(행/좀비 방지 — 생성 CLI 가 산출물을 다 쓰고도 종료 안 하면 무한 대기로 마무리 전이가 멈추는 문제 처방):
  - `HARNESS_GEN_TIMEOUT`(기본 600초) — 생성 1회 하드 상한. 산출물 없는 진짜 행의 백스톱(초과 시 자식 종료 후 중단, 재실행=idempotent 재개).
  - `HARNESS_GEN_POLL`(기본 5초) — 상태 점검 간격. 출력 완료 / 자식 종료 / 상한 초과를 주기 확인.
  - `HARNESS_GEN_HEARTBEAT`(기본 30초, 0=끄기) — 진행 하트비트 출력 간격(체감 정체 완화). 핵심: 산출물(watch 파일)이 완성되면 좀비 자식을 더 기다리지 않고 곧장 검증·전이로 진행한다.
- **심의(크리틱) watchdog·관측성**(개선계획 2부 — 원격 ADK 호출이 응답 없이 늘어지면 무한 행이 되므로 상한이 필요하다. 사람-노출 문구는 1부 평이화를 따른다):
  - `KCIA_CRITIC_TIMEOUT`(기본 600초) — 원격 ADK 심의 1회(Pass-A 또는 Pass-B 1건) 하드 상한. ADK 호출은 `spawn_session.py`(setsid)로 띄워 watchdog(`obs_watch_pid`)가 상한·하트비트·`kill_proc_tree`로 회수(생성 `run_llm` 과 동일 형태). 초과 시 `outcome=timeout`.
  - `KCIA_CRITIC_FANOUT_CAP`(기본 8) — Pass-B(건별 적대검증) 항목별 fan-out 상한(`kcia-check.sh`).
  - `KCIA_CRITIC_REQUIRED`(기본 미설정=0; **단 `adk_critic` 구현+설정된 도메인은 `kcia-check.sh` 가 자동으로 `1` 설정 → 조용한 강등 금지**) — `1` 이면 원격 ADK 심의가 실패/타임아웃일 때 **강등 대신 fail-closed**(중단). 미구현 도메인은 애초에 ADK 를 안 돌리고 룰엔진-단독으로 가시화한다.
  - 측정 로그 `runs/<id>/.logs/timing.jsonl`(append; 생성·심의·Pass-A/B·전이 소요·결과) + 출력 캡처(생성 `<stage>-<engine>-generate-<ts>.log` · 크리틱 `critic-passA-<ts>.log`·`critic-passB-<i>-<ts>.log`; 실패 시 에러에 tail) + `verdict.json` 가시화 필드(`critic_ran`·`critic_outcome`·`review_depth`). `.logs` 는 스크립트만 쓰는 진단용(verdict 경로 아님; 골든 제외). 요약: `bash scripts/timing.sh <id>`. 회귀: `tests/test-observability.sh`.
- **현업 화면 평이 라벨 단일 출처**(개선계획 1부): `scripts/lib/operator_labels.py` 가 페이즈/게이트종류/status/신호등/번역표의 단일 사전. `render_runmd.py`·`next-action.sh` 가 import 공유(+`kcia-check.sh` 가 placeholder 문구 호출), 4동작 스크립트·`prompts/operator-voice.md` 는 같은 평이 문구를 쓴다 → 내부 코드(auto/human-verify/escalated/scope=/iteration N/M 등) 현업 화면 미노출. 회귀: `tests/test-operator-language.sh`.

## 3. 디렉터리 지도
> 사람용 전체 내비게이션(어디에 무엇이 있는지 · 문서 지위표) = [`../docs/README.md`](../docs/README.md) 총지도(D-1 동반갱신). 아래는 에이전트용 최소 지도.
> 모노레포(마이크로커널): 운영 위치 = `core/`(이 디렉터리, 도메인-중립 커널). 규제도메인 데이터는 형제 `../packs/`(팩)가 소유.
```
core/  (= 이 운영 루트, HARNESS_ROOT)
  prompts/        # 단계 생성 프롬프트 SSoT (CLI 무관)
  scripts/        # 결정적 게이트 + 상태 단일 쓰기 (lib/ 공용; 규제 로더는 packs 우선 조립)
  harness/        # 동결 계약 스키마(*.schema.json) + registry.json (레거시 regulatory-domains.json 폴백은 2부 1단계에서 폐지 — packs/ 가 유일 레지스트리 SSoT)
  docs/reference/ # 파이프라인 소비 문서만(경로 결합 — 이동 금지): regulation/(kcia-check 해시 스캔) · design-tokens.md(keyvisual 프롬프트) · canon-blocks.md(storyboard 프롬프트). 사람·에이전트용 문서는 루트 ../docs/
  inputs/         # 씨앗 소스(ingest 가 런으로 스냅샷): working-backwards.md · assets/(자사 이미지) · examples/<도메인>/(동일 도메인 사례). override: HARNESS_WB/HARNESS_ASSETS_DIR/HARNESS_EXAMPLES_DIR
  runs/<id>/      # 실행 단위(런별 진실; 스크립트가 생성): state.json · run.md
    inputs/       #   런별 원시 입력(ingest 가 씨앗/크롤에서 스냅샷): working-backwards.md · assets/(자사) · examples/<도메인>/(사례) · bundle/(크롤 원본 product.json·reviews.csv·images/)
    00-ingest/    #   가공물만: voc.json · claim-basis.json · assets-manifest.json · best-practices.json · bundle-report.md
    00g-guideline/ … 03-storyboard/  #   단계 산출물(00g-guideline·01-brief·02-concept·03-storyboard)
    04-keyvisual/ #   generated/(생성 이미지 NN-type.{svg,png}) · options/{A,B,C}/index.html · image-manifest.json · export/kcia-package/
  skills/ .claude/commands/  # 편의 래퍼(run-stage.sh 호출 한 줄)
packs/<도메인>/   # 규제도메인 팩 SSoT(core 형제). domain.json(레지스트리 엔트리) + ruleset.json + sources/(협회·식약처 원문, 읽기 전용)
                  #   새 도메인 = 팩 폴더 추가(레지스트리 자동 조립). 단 진입 게이트(new-run·state.schema enum)는 통제 추가 필요.
docs/             # 사람·에이전트용 문서(core 형제, 총지도=docs/README.md): canonical/(정본 D-1) · reference/(user-guide·deployment·harness-design·ci-cost-and-target-map·workflow-diagram/) · snapshots/(강등 참조) · plans/(진행 중 계획) · history/(이력 raw) · _archive/(완료·폐기)
```

## 4. 파이프라인
`[00a-intake] → 00-ingest → [00e-evidence] → [00g-guideline] → 01-brief → 02-concept → 03-storyboard(outline→plan; 2-cycle, tone 흡수) → 04-keyvisual → done`
> `[00a-intake]`·`[00e-evidence]`·`[00g-guideline]` = **조건부**(대괄호). **00a-intake(W-1/W-2) = opt-in 새 정문** — 현업이 첨부 폴더 하나를 통째로 줄 때만 활성(`intake.sh <폴더> <id> --product --domain --format`; 기존 채널 시작이면 미등장 → no-intake 골든 불변). 세션 에이전트(`/intake`)가 파일별 **보편 분류 제안**(working_backwards·own/reference crawl·product_image·evidence:*·unknown) → 사람이 표로 **한 번의 approve 로 일괄 확정**(unknown 잔존·sha256 불일치·시맨틱 위반 시 거부) → `gate.sh` 가 승인 분류대로 **기존 채널로 결정적 라우팅**(apply-intake→ingest-bundle)해 00-ingest 로 잇는다. 규제도메인·제품명 선언은 여전히 사람(state.json). 분류표는 라우팅 결정 입력이라 **심의 면제**(review:false). 00e-evidence = 사람이 참조 문서를 **문서만 첨부**(반영 스펙 미정)했을 때만 활성 — 인입이 `spec_status:pending` 으로 기록하고 세션 내 에이전트가 반영 포인트를 추출·제안 → 사람 승인 → 매니페스트 재기록(pending 해소)해야 하류로 나간다(G5). 둘 다 활성이면 순서 00e→00g. 00e 대상 = **일반 참조 문서(각주 인용 채널)** + **시험성적서(`test_report`) 스펙 초안(W-3)**. ⚠ **시험성적서 규칙(W-3)**: 사람이 인입에서 `kind:test_report` 로 **intent 선언(상세 생략)** 한 문서만 00e 에서 에이전트가 스펙(기관·n·기간·판정문 원문·test_items·전후사진 페이지) 초안을 **`kind:"test_report"` 제안**으로 낸다 → 사람 승인 → apply-proposal 확정·추출·승격. 세션 에이전트는 그런 pending test_report 를 **일반(general) kind 로 강등 제안하면 안 된다**(validate-stage·apply 가 fail-closed). **bare/일반 첨부를 test_report 로 자동 승격하는 것은 여전히 금지**(intent-match — 규제 성격 선언은 사람의 몫). 완전 선언(상세 포함)은 기존대로 인입 즉시 추출·승격(00e 미경유).
각 페이즈: **생성(generate) → 사람(선택select / 승인approve) → 심의(review) → 전이(advance)**.
> ⚠️ **순서 주의(구현 진실)**: 심의는 **생성 직후가 아니라 사람의 선택/승인 뒤**에 돈다 — 다안은 `select→review`,
> 단안은 `approve→review`. 생성 직후 상태는 `gate=select`(다안)·`gate=user`(단안)이라 그 시점엔 `kcia-check` 가
> 거부된다(`run-stage.sh` 365행 주석 = 구현 진실). '심의가 선택보다 먼저'로 안내하지 말 것.
> ⚠️ **심의가 없는 페이즈**: `00a-intake`(첨부 분류표 = 광고 카피가 아니라 라우팅 결정 입력, review:false)·`00-ingest`(인입만 → 곧장 다음 단계)·`00e-evidence`(참조 문서 반영 제안 초안 = 광고 카피가 아니라
> 하류 참조 입력, review:false)·`00g-guideline`(크롤 참조 노트 = 광고 카피가 아니라
> 다운스트림 참조 입력 → **심의 면제**[phase-descriptors `review:false`, 닫힌 스키마상 00g·00e·00a 에만 허용(guideline_leaf $def); kcia-check 진입 시
> route_assert_valid 로 변조 fail-closed]; 승인 뒤 `kcia-check` 가 실제 critic 심의 대신 `review-exempt-autopass`(verdict=pass)로
> 자동 통과시킨다. 단 **autopass 직전 `validate-stage` 로 현재 산출물을 재검증**(금지표현·형식 → 생성후 변조도 fail-closed) —
> 빠진 건 중복 critic 뿐이지 검증이 아니다. 실제 카피는 하류에서 심의)·`done`. 나머지 페이즈(01-brief·02-concept·03-storyboard·04-keyvisual)는
> 위 순서대로 **실제 심의가 돈다**(active 도메인 기준; `status != active` 도메인은 placeholder-autopass — 8번 절).

**브리프(앞단 1~4단계)** = ⓪ 유형 선언(규제도메인+산출물 포맷, `new-run --domain --format`, 가장 먼저 강제) →
① 워킹백워드·번들 인입(`00-ingest`) → ② 유사사례 취합(`inputs/examples/<도메인>/`, 동일 도메인) →
③ **크롤 참조 노트** 입력·현업 확정(`00g-guideline`, **단안 approve · 심의 면제**[review:false] → 승인 즉시 자동 통과) → 정리(`01-brief` PR/FAQ).
`00g-guideline` 은 **조건부**(사례 있을 때만). 이후 컨셉→스토리보드→키비주얼.
> **③ 변경(구 '유사점 3안 추출' 파기)**: 크롤한 사례 중 '무엇이 왜 좋았는지'를 자유텍스트 `reference-notes.json` 으로
> 입력만 받는다(방향 3가지로 가르지 않음). 이 참조는 `build_context` 의 `REFERENCE_NOTES` 라벨로 **컨셉(RTB·키메시지)·
> 스토리라인·아웃라인·이미지** 생성에 주입되어 참조된다(soft 권고, 법=룰셋 우선). example-analysis(객관 분석·구도 카탈로그)는 유지.

> **워크플로우 정본 = `../docs/canonical/workflow-ssot.md`.** 단계·입출력·도메인 참조의 사람용 정본. 본문은 **현재의 최종 진실만** 담는다(변경 이력·"…였다가 …로 바꿈" 축적 금지) — 시간순 변경 요약 한 줄은 별도 raw `../docs/history/workflow-ssot-history.md` 에 append 하고 헤더엔 최신 갱신 날짜만 둔다(정본을 이력으로 부풀리지 않는다).

> **D-1 — 동반 갱신 의무(정본 5개).** 아래 5개 문서는 코드/규칙/팩이 바뀔 때 **같은 변경(커밋)에서** 해당 구역을 최신 상태로 덮어써야 하는 사람용 정본이다(예전 서술은 남기지 말고 교체; 코드와 어긋나면 정본이 거짓이 된다). 무엇이 바뀌면 무엇을 갱신하는가:
>
> | 무엇이 바뀌면 | 갱신할 정본 |
> |---|---|
> | 단계·게이트·파이프라인(`scripts/*.sh`·`harness/*.json`·`phase-descriptors.json`) | `../docs/canonical/workflow-ssot.md`(흐름) |
> | 기능(`scripts/*.sh`·`scripts/lib/*`) + 대응 `prompts/`·`skills/` 추가/변경/삭제 | `../docs/canonical/feature-catalog.md`(기능 인벤토리·동반물 매핑) |
> | 도메인·포맷 팩 추가 · `domain.json` status 전환 · 룰셋/캐논 구조 변경 | `../docs/canonical/pack-catalog.md`(팩 조회) |
> | 환경변수 추가 · 기본값 변경 | 이 2번 절(규칙 SSoT) **+** `../docs/canonical/config-reference.md`(조회표) |
> | 디렉터리 신설 · 문서 신설/강등/아카이브 | `../docs/README.md`(문서·구조 총지도) |
>
> 위 표는 **변경 종류** 기준이다. **"어느 폴더를 고쳤으면 어떤 문서를 갱신하는가"** 폴더-키 조회표 = [`../docs/README.md`](../docs/README.md) 4번 절(같은 규칙의 사람용 색인 — 충돌 시 이 표가 우선).
>
> 각 정본 본문은 **현재 존재하는 것만** 담는다(변경 이력 서술 금지). 이력은 `workflow-ssot.md` 만 history raw(`workflow-ssot-history.md`)에 append 하고, 나머지 4개는 git 이력에 맡긴다(별도 history 파일 없음). **이 5개 외 문서는 갱신 의무 밖이다** — `pipeline-stage-definitions.md`·`harness-architecture.md`·`stage-contracts.md` 등 '참조 스냅샷'으로 강등된 문서(헤더에 명기)와 `_archive/` 문서는 작성 시점 스냅샷이라 코드와 어긋날 수 있다(불일치 시 **코드 우선**; 현재상태 SSoT 는 코드다). 다른 문서가 이 강등 문서를 상세 참조로 가리켜도 그 링크는 **스냅샷 참조**일 뿐 갱신 의무를 부활시키지 않는다. 완료된 계획 문서는 완료 즉시 `_archive/` 로 옮긴다.

## 5. 현업 4동작 (JSON 손편집 금지)
- 본다: `runs/<id>/run.md` 의 "지금 할 일"
- 생성: `bash scripts/run-stage.sh <stage> <id>`
- 심의: `bash scripts/kcia-check.sh <id>`
- 승인/보완/선택: `bash scripts/{approve,revise,select}.sh <id> [...]`

## 6. 산출물 규약
- 모든 정량 수치의 단일 출처는 `00-ingest/voc.json`. 본문 하드코딩 금지.
- 모든 JSON 산출물은 `harness/*.schema.json` 을 만족해야 한다(`scripts/validate-stage.sh`).
- 디자인 `<img src>` 는 자사 자산(`inputs/assets/`·생성 이미지 `04-keyvisual/generated/`·product.json 자사 URL)만. 크롤 원본(`inputs/bundle/images/`) 금지.

## 7. 고지
본 산출물은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다. 최종 책임은 사람(현업/RA)에게 있다.

## 8. 규제도메인(다중) — 진행 중
- **도메인 선언은 사람이 한다**(AI 자동분류 없음). `new-run.sh <id> "제품명" <제품유형> <규제도메인>` 또는 ingest 단계에서 선언.
  값: `cosmetic`(기본) · `quasi_drug`(의약외품) · `health_food`(건기식) · `drug`(의약품).
- **도메인 레지스트리(팩 SSoT)** — 각 도메인은 `packs/<도메인>/domain.json`(레지스트리 엔트리: 라벨·법·크리틱·기능범주·사전심의·광고가능·그래픽생성억제[`no_graphic_generation`]·필수기재·status) + `ruleset.json` + `sources/`를 소유한다. core 로더(`kcia_engine.load_domain_registry` · `common.sh domain_field`)가 `packs/*/domain.json`을 스캔해 레지스트리를 조립하고, 심의엔진·`build_context`·`new-run.sh` 가 도메인별 룰셋을 선택한다. **`packs/` 가 유일 레지스트리 SSoT다(2부 1단계: 레거시 `harness/regulatory-domains.json` 폴백·`default→cosmetic` 메커니즘·`docs/regulation/ruleset.json` 최후폴백 전부 폐지).** 등록됐는데 ruleset 파일 부재/손상 → 미완 룰셋 fail-closed; **미선언·미등록 도메인은 cosmetic 으로 조용히 폴백하지 않고 fail-closed**('packs 없는 core 단독 체크아웃' 시나리오도 공식 폐기). 사람용 도메인 심의 매트릭스·포맷 팩 조회 = [`../docs/canonical/pack-catalog.md`](../docs/canonical/pack-catalog.md)(D-1 동반갱신).
- ⚠️ **TBD/미제공 도메인 = 심의 무조건 통과(placeholder)**: `status != active` 인 도메인은 실제 심의기준(ruleset)이
  **추후 제공될 때까지** `kcia-check.sh` 가 `verdict=pass`(engine=`placeholder-autopass`, note 기재)로 **무조건 통과**시킨다.
  현재 **실심의 도메인 = `cosmetic`·`drug`(status=active) 둘뿐**이고, `quasi_drug`(의약외품)=`tbd`(빈 축 플레이스홀더 ruleset)·
  `health_food`(건기식)=`ready-only`(ruleset 파일 부재) **둘 다 placeholder-autopass** 로 무조건 통과한다(도메인별 현황표 =
  `../docs/canonical/pack-catalog.md`). **TODO: 의약외품/건기식 심의기준 문서 입수 후 `packs/<도메인>/ruleset.json` 를
  4축+`mandatory_inclusion`(필수기재) 카탈로그로 채우고 `domain.json` status 를 active 로 전환**(전환 즉시 자동으로 실제 심의 적용). 의약품(drug)=active 완료.
- 동결 스키마(`ruleset`/`verdict`/`claim-basis`/`state`)는 도메인-중립으로 일반화됨(완화만, 화장품 후방호환). 상세: `../docs/plans/multi-domain-build-plan.md`.

## 9. 운영자(현업 응대) 규칙 — 다이렉트/대화형
> 운영 에이전트가 **현업과 대화**할 때(다이렉트 in-session, 또는 진행을 사람에게 설명할 때) 지키는 화법·진행 규칙.
> 상세 화법·용어 번역표는 `prompts/operator-voice.md`. (이 규칙은 생성 에이전트용이며 심의 크리틱과 무관하다.)

1. **다음 단계는 추측하지 않는다 — `runs/<id>/run.md` 의 "다음 명령" 한 줄만 읽어 안내한다.** 4번 절 정형문을
   머릿속에서 풀어 '심의가 먼저' 같은 순서를 예고하지 말 것(실제 순서는 게이트가 정한다 = 생성 → 사람 → 심의).
   run.md 가 진실의 출처다. 게이트 전이로 run.md 가 바뀌면 그때 다음 한 줄을 안내한다.
2. **현업에게는 평이한 한국어로 말한다.** 내부/개발 용어(워킹백워드·claim-basis·fail-closed·unsupported·VOC·
   pairwise·escalated·iteration·심의 축 등)를 그대로 쓰지 말고 번역해 말한다(번역표: `prompts/operator-voice.md`).
   셸 명령 한 줄은 그대로 보여주되, 그 의미는 일상어로 풀어준다.
3. **4동작 바깥의 일을 현업에게 시키지 않는다.** JSON 손편집·환경변수·내부 파일 경로를 현업의 할 일로
   제시하지 않는다(운영자가 대신 처리). 현업의 할 일은 본다·생성·승인/보완·선택뿐(5번 절).
