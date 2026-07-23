# 하네스 전체 구조 — 설계 개요 (아키텍처 맵)

> ⚠️ **참조 문서(스냅샷) — 동반 갱신 의무 없음(D-1).** 구조 이해용 개요이며 동반 갱신 의무 대상이 아니다(규칙 SSoT=`AGENTS.md`, 현재상태 SSoT=코드). 작성 시점 스냅샷이라 세부는 코드와 어긋날 수 있다(**코드 우선**). 동반 갱신 의무가 있는 유일한 문서는 [`workflow-ssot.md`](../canonical/workflow-ssot.md) 다.

> **위치/성격:** 이 문서는 상세페이지 생성 하네스의 **전체 구조를 한 장으로 이해**하기 위한 reader-oriented 설계 개요다.
> *무엇을·왜* 의 규칙 SSoT 는 [`../AGENTS.md`](../../AGENTS.md), 결정 근거는 [`orchestration-architecture-decision.md`](../_archive/orchestration-architecture-decision.md)(ADR),
> 다중 도메인 빌드 순서는 [`multi-domain-build-plan.md`](../plans/multi-domain-build-plan.md) 다. 이 문서는 그 위에서 **구조를 설명**한다(규칙을 덮어쓰지 않는다).
> 작성일: 2026-06-21

---

## 0. 한 문장 핵심 (척추)

> **프레임워크가 아니라, `state.json`(현재 위치) + `scripts/*.sh`(유일한 상태 쓰기 주체)가 상태를 결정론적으로 전이하는 상태기계다.
> LLM 은 "산출물 파일"만 쓴다. 분기·게이트·전이에 LLM 은 절대 개입하지 않는다.**

이 한 줄이 모든 설계의 이유다. 나머지는 전부 이 척추에 꽂히는 **데이터 다이얼**이다.

```
              ┌──────────── 결정론 엔진 (척추) ────────────┐
              │   state.json   ⇄   scripts/*.sh           │
              │  (지금 어디?)      (유일한 상태 쓰기)        │
              └────────────────────┬─────────────────────┘
   사람이 선언 →  new-run --domain 의약품 --format 여러장
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
 [흐름 다이얼]                [규제 다이얼]                 [구성 다이얼]
 pipeline-routes.json     regulatory-domains.json        format-profiles.json
 00→01→02→03→04→done      → docs/regulation/             → active_phases
  "무엇을 거치나"             <도메인>/ruleset.json            "어떤 페이즈 쓰나"
  (도메인·포맷 무관, 공통)     "무엇을 말할 수 있나"(심의)        (포맷별 페이즈 스킵)

         각 페이즈에서 LLM 은 2역할 — 물리적으로 격리됨:
   ┌────────────────────┐        ┌────────────────────┐
   │ 생성 (claude)       │   ≠   │ 심의 (codex)        │
   │ prompts/<stage>.md  │  격리  │ ruleset + critic    │
   │ → 산출물.json 씀     │        │ → verdict.json 씀   │
   └────────────────────┘        └────────────────────┘
   HARNESS_CLI               KCIA_CRITIC_CMD (다른 CLI/세션 강제)
```

> **직교성(가장 중요):** 흐름(파이프라인) ⊥ 규제(도메인) ⊥ 구성(포맷) 은 서로 독립이다.
> 도메인이 바뀌어도 파이프라인은 같고, 포맷이 바뀌어도 도메인 심의는 같다.

---

## 1. 제어하는 것들 → 역할 매핑

| 요소 | 종류 | 무엇을 제어하나 | 누가 읽나 |
|---|---|---|---|
| `runs/<id>/state.json` | **상태** | 지금 어느 페이즈·게이트·반복인지 (런별 1개, **scripts 만 씀**) | 전부 |
| `scripts/*.sh` | **코드(결정론)** | 상태 전이·게이트·검증 (LLM 무개입) | — |
| `harness/pipeline-routes.json` | 데이터 | **페이즈 흐름** (successor + 반복상한). 도메인/포맷 무관 | advance-phase · render_runmd |
| `harness/regulatory-domains.json` | 데이터 | **도메인 → 룰셋·크리틱·메타·status** (단일 SSoT) | kcia-check · ingest · build_context |
| `docs/regulation/<도메인>/ruleset.json` | 데이터 | **도메인별 심의 기준** (축별 금지어·실증요구) | kcia_engine |
| `packs/_format/format-profiles.json` | 데이터 | **포맷 → active_phases** (어떤 페이즈를 쓰고 스킵하나). 단계4: 전용 비-도메인 format 팩으로 이전(domain↔format 분리, FORMATS_DIR) | advance-phase |
| `harness/registry.json` | 데이터 | **산출물 경로 → 스키마** 매핑 (검증용) | validate-stage |
| `prompts/<stage>.md` | 텍스트 | **단계별 생성 지침** (LLM 이 무엇을 어떻게 만드나) | run-stage → 생성 LLM |
| `prompts/kcia-critic.md` | 텍스트 | **심의 지침** (적대 스탠스) | kcia-check → 심의 LLM |
| `harness/*.schema.json` (동결) | 계약 | **산출물 형식** 고정 (모든 산출물이 만족해야 함) | validate-stage |
| `packs/_format/<포맷>/canon.json` | 데이터 | 포맷 캐논 정본(블록 카탈로그 + 필수 구성요소 커버리지) — 4단계 통합(구 `canon-components*.json`·스키마 enum 흡수) | check-components·validate_storyboard·stub_stage |
| `packs/<도메인>/ingest-profile.json` | 데이터 | 번들 인입 **추출 프로파일**(도메인 소유) — 3단계 이전(구 `harness/ingest-profiles.json` 폐지) | ingest-bundle |

**핵심 분리:** **데이터(제어)** ↔ **코드(전이)** ↔ **LLM(생성·심의)** 가 섞이지 않는다.

### 스크립트 1급 경로 (state.json 유일 쓰기 주체)

| 스크립트 | 역할 |
|---|---|
| `new-run.sh` | 런 생성(유형 선언: `--domain`·`--format`). 안전 기본값(근거 없는 효능 = unknown/[]). |
| `ingest-bundle.sh` | 임의 번들 → `voc.json`·`claim-basis.json`·`assets-manifest.json` 결정적 정규화. |
| `run-stage.sh` | **단계 생성기**: 프롬프트+컨텍스트로 LLM 호출 → 산출물 작성 → gate=review. |
| `kcia-check.sh` | **심의 게이트**: ruleset baseline + critic 2-pass → `verdict.json`. |
| `approve.sh`·`revise.sh`·`select.sh` | 현업 동작: 승인 / 보완(재생성 루프) / 다안 선택. |
| `advance-phase.sh` | 페이즈 전이 + `run.md` 재생성 (라우트 테이블 조회). |
| `gate.sh` | `verdict`/`decision` 을 읽어 state 를 결정론적으로 전이. |
| `next-action.sh` | state → 구조화 JSON (Slack 어댑터 단일 SSoT, 읽기 전용). |
| `lib/render_runmd.py` | state → `run.md`("지금 할 일 + 다음 명령 1개") 렌더. |
| `lib/kcia_engine.py` | 룰셋 기반 결정론 위반 탐지(baseline). |
| `lib/kcia_merge.py` | 2-pass(Pass-A/Pass-B) verdict 머지(ADD-only). |
| `lib/common.sh` | 공용 헬퍼: 락·검증·`build_context`·라우트 조회·LLM 디스패처. |

---

## 2. 각 개념이 하는 일

**`state.json` — "지금 어디?"**
런 1개의 현재 위치(`phase`·`step`·`gate`·`status`·`iteration`·`history`). **오직 `scripts/*.sh` 만 쓴다.** LLM 은 절대 못 쓴다. → 재현·감사·이식성의 핵심.

**`scripts/*.sh` — "전이 엔진"**
`state.json` 을 읽고 결정론적으로 다음 상태로 옮긴다. 분기는 전부 셸 `case`/데이터 조회 — **eval·LLM 없음**.

**룰셋(`ruleset.json`) — "무엇을 말할 수 있나" (심의 기준)**
도메인별 **축**(예: 의약품 = `drug_misperception`·`functional_misperception`·`consumer_deception`·`substantiation_required`·`prescription_otc_distinction`)마다 **금지어·트리거·실증요구·어휘사전**을 담은 데이터. `kcia_engine` 이 산출물 텍스트를 이 룰셋으로 스캔해 위반을 찾는다. **"카피가 통과/탈락"을 결정.** 생성에는 관여 안 함, **심의에만** 쓰인다.

**프롬프트(`prompts/<stage>.md`) — "어떻게 만드나" (생성 지침)**
각 단계 생성 LLM 에게 주는 지침(ICM 입출력 계약 + 절차 + 환각방지 규칙). **단계(STAGE)로만 선택**되고 도메인은 안 본다(`prompts/$STAGE.md`). 도메인은 `build_context` 가 **데이터로 주입**(`RULESET`·`REGULATORY_DOMAIN`) → 같은 프롬프트 틀 안에서 LLM 이 적응한다.

**status(레지스트리) — "이 도메인 심의 켤까?"**
`active`=실심의 / `≠active`=무조건통과(placeholder-autopass). 도메인 룰셋이 준비되기 전엔 **틀린 판정을 내리지 않도록** autopass. **심의 ON/OFF 토글.**

**스키마(`*.schema.json`) — "산출물 형식 계약"**
모든 산출물(brief·concept·verdict…)이 만족해야 하는 동결 형식. `validate-stage` 가 강제. **도메인 중립** → 모든 도메인이 같은 틀로 산출물·룰셋을 쓴다. (변경은 추가-선택 필드만; `required`·`additionalProperties:false` 불변.)

**생성 ≠ 심의 (물리 격리)**
`HARNESS_CLI`(생성, 예: claude) ≠ `KCIA_CRITIC_CMD`(심의, 예: codex). 같으면 `kcia-check` 가 오류 중단(self-grading 금지). 근거: 자가비판 붕괴(98.1%→56.9%).

---

## 3. 워크플로우 — 페이즈 정의 + 각 페이즈 상세

**카테고리(=파이프라인 페이즈)는 `pipeline-routes.json` 에 고정 정의** (모든 도메인 공통):

```
00-ingest → [00g-guideline] → 01-brief → 02-concept → 03-storyboard → 04-keyvisual → done
 (인입)      (참조노트,조건부)    (브리프)     (컨셉)      (콘티,2substage)  (키비주얼)
 max_iter:3      3              3          3             4            2
```

**각 페이즈의 "상세 워크플로우"는 동일한 4-스텝 게이트 사이클**로 정의된다(`scripts` + `prompts` 에 고정):

```
   생성(generate) ──→ 심의(review) ──→ [선택(select)] ──→ 사람(approve/revise)
   run-stage          kcia-check       select.sh           approve / revise
   prompts/<st>.md    ruleset+critic   (다안일 때만)         (통과 / 보완 후 재생성)
   → 산출물.json       → verdict.json   → decision.json      → 다음 페이즈로 전이
```

페이즈별 상세 단계는 프롬프트에 박혀 있다(도메인 무관 공통):

| 페이즈               | 내부 단계                                                                   | 사람 게이트                                |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| **브리프**(앞단 1~4단계) | ⓪유형선언(규제도메인×포맷) → ①인입(워킹백워드·VOC) → ②유사사례·선호 → ③크롤 참조 노트·현업확정 → 정리(PR/FAQ) | approve (민감표시 시 `--ra-ok` setup 게이트)  |
| **컨셉/빅아이디어**      | 축 정의 → 축별 독립 생성(RTB·키메시지) → pairwise 추천                                 | **select (3안)**                       |
| **콘티/스토리보드**      | outline(스토리라인 2안) → plan(기획안+visual.concept; M3 tone 흡수)                      | outline=**select**, plan=approve |
| **키비주얼/아트워크**     | 디자인 2안(HTML/CSS) → 심의                                                   | **select (2안)** → approve             |

> 게이트는 **`gate.sh` 가 `verdict`/`decision` 을 읽어 결정론적으로** 전이한다.
> 반복상한(`max_iterations`) 초과 시 `escalated`(hard-stop)로 사람 개입을 요구한다.

---

## 4. 현업 4동작 (선택 메커니즘)

현업은 JSON 손편집 없이 **4동작**만 한다 (전부 scripts 가 state 전이):

| 동작 | 명령 | 동작 방식 |
|---|---|---|
| **본다** | `runs/<id>/run.md` 읽기 | render_runmd 가 state → "지금 할 일 + 다음 명령 1개" 렌더 |
| **생성** | `bash scripts/run-stage.sh <stage> <id>` | 프롬프트+컨텍스트로 LLM 이 산출물 작성 → gate=review |
| **심의** | `bash scripts/kcia-check.sh <id>` | ruleset baseline + critic 2-pass → verdict → 통과면 다음 게이트 |
| **승인/보완/선택** | `approve` / `revise [--reason]` / `select <opt>` | approve=통과, revise=`feedback.json` 기록 후 재생성, select=다안 중 1개 `decision.json` |

타입화 게이트(`gate_type`)는 render 시 파생: `auto`(심의 대기) · `human-verify`(승인/선택) · `setup`(`--ra-ok` 선행) · `hard-stop`(에스컬레이션).

---

## 5. 도메인 분기 (건기식·의약품) — 단일 스위치

**분기는 파이프라인이 아니라 "심의 1지점"에서만** 일어난다:

```
kcia-check 실행
   ↓ regulatory-domains.json 에서 status + ruleset_path 읽음
   ├─ status=active & 룰셋 있음 → kcia_engine.load_ruleset(도메인) → 실심의   [화장품·의약품]
   ├─ status≠active            → placeholder-autopass (무조건 통과)          [의약외품=tbd]
   └─ 등록됐지만 룰셋 파일 없음   → 빈 룰셋 폴백 (안전, '잘못된 화장품 법' 금지)   [건기식=ready-only]
```

### 현재 도메인 상태

| 도메인 | status | 심의 | 비고 |
|---|---|---|---|
| 화장품 `cosmetic` | **active** | 실심의 (4축, 기능성 3카테고리) | 기본값 · 레거시 룰셋 |
| 의약품 `drug` | **active** | 실심의 (5축 + 전문/일반 하드스톱 + 필수기재) | 식약처+협회 매뉴얼 추출 |
| 의약외품 `quasi_drug` | tbd | 무조건 통과(placeholder) | 룰셋 추후 제공 |
| 건기식 `health_food` | ready-only | 룰셋 미채움 → 폴백 | 스키마·레지스트리만 준비 |

### 새 도메인(예: 건기식) "켜기" = 데이터 2곳, 코드 0줄

1. `docs/regulation/health_food/ruleset.json` 작성 — drug/cosmetic 룰셋을 **템플릿**으로(스키마 동결이라 구조 동일). 4축 + 금지어(질병 예방·치료 표현 금지 등) + 필수기재 카탈로그.
2. `regulatory-domains.json` 에서 `health_food.status: ready-only → active`.

→ 파이프라인·프롬프트·게이트·스키마·new-run **전부 그대로**. `load_ruleset` 가 새 룰셋을 자동으로 읽어 실심의 시작.

### 포맷 분기 (직교)

`format-profiles.json` 의 `active_phases` 가 페이즈 스킵을 제어한다(도메인과 독립):

| 포맷 | active_phases | status |
|---|---|---|
| `multipage_bm`(여러장 상세페이지) | 00·00g·01·02·03·04 (전부) | active |
| `one_pager`(한장 홍보물) | 00·00g·01·02·03·04 (전부, M7/M8) | active |

---

## 6. 왜 이렇게 설계했나 (불변식)

| # | 불변식 | 이유 |
|---|---|---|
| 1 | `state.json` 은 scripts 만 쓴다 | 재현·감사·이식성 (LLM 비결정성 격리) |
| 2 | 생성 ≠ 심의 물리 격리 | self-grading(자가비판 붕괴) 차단 |
| 3 | 분기에 LLM 미개입 (셸 case/데이터) | 결정론·디버그 가능성 |
| 4 | 데이터로 제어, 코드 무수정 | 도메인/포맷/흐름 확장이 JSON 추가로 끝남 |
| 5 | 동결 스키마 = 추가-선택만 | 디스크 기존 산출물 후방호환 |
| 6 | 안전 기본값 (근거 없으면 unknown/폴백/autopass) | 환각·오판 방지(fail-closed) |
| 7 | 세 라우팅 술어 비융합 (examples_exist@ingest · active_phases@advance · uses_guideline@render) | 시점·SSoT 다른 분기를 합치면 "동작 불변" 골든테스트를 통과하며 의미가 바뀜 |

---

## 한 줄 요약

**결정론 엔진(`state.json`+`scripts`)이 척추**이고, 그 위에 **3개의 데이터 다이얼** — **흐름**(pipeline-routes)·**규제**(domains+ruleset)·**구성**(format-profiles) — 이 직교로 꽂힌다.
**워크플로우 단계는 `prompts`/`scripts` 에 고정·공유**되고, **도메인 차이는 오직 "심의 룰셋(데이터) + status 토글"로만** 표현된다.
그래서 새 도메인 추가 = **워크플로우 구축이 아니라 룰셋 파일 1개 + status 한 줄**이다.
