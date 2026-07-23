# In-Session 생성 모드 — 제안 및 의사결정 기록

> **성격:** 제안서(구현 계획 아님). [`orchestration-architecture-decision.md`](./orchestration-architecture-decision.md)(ADR, "현 구조 유지·재구축 불필요") 위에서 움직인다.
> 불변식·안전 규칙의 SSoT 는 [`../AGENTS.md`](../AGENTS.md) §0~§8 이며, 이 문서는 그 위에서만 움직인다.
> **핵심 질문:** *"현 파일 기반 단계-게이트 구조를 100% 유지한 채, `claude -p`/`codex exec`(헤드리스 서브프로세스)를 **Slack 같은 외부 래핑에서만** 쓰고,
> Claude Code/Codex 안에서 사람이 인터랙티브하게 돌릴 땐 GSD·spec-flow 처럼 **in-session 생성**을 쓸 수 있는가?"*
> 작성일: 2026-06-21

---

## 0. 한 줄 결론 / 권고

**가능하다. 단 순수 *선택적(additive)* 이고, 현 구조가 안정적이며 *의도적으로 선택된* 설계이므로 — 지금 당장 바꿀 필요는 없다.**

- **바꾸지 않으면 안 되는 것은 없다.** 현 서브프로세스 경로(`run-stage.sh` → `run_llm` → `claude -p`/`codex exec`)는 잘 돌고, CI 도 그린이며, ADR 이 외부 4개 1차 근거로 정당화를 끝낸 구조다.
- in-session 모드가 주는 이득은 **오직 "사람이 Claude Code 안에서 손으로 run 을 모는" 인터랙티브 UX** 다(생성 과정을 대화에서 보고, 중간 개입하고, 불투명한 하위 `claude -p` 와 별도 컨텍스트 비용을 피함). **Slack 경로에는 아무 이득이 없다**(Slack 은 헤드리스가 정답).
- 따라서 권고: **지금은 이 문서로 "꺼내 쓸 수 있는 설계"만 동결해 두고, 인터랙티브 손운전이 잦아져 불투명 하위-Claude 비용이 실제로 아플 때** 최소·페일클로즈드로 얹는다(§10·§11).

> 한 문장: *"할 수 있지만, 안 해도 된다. 한다면 Claude 전용·플래그·additive 로, Slack/서브프로세스 경로는 손대지 않고, §6 의 단 하나의 안전조건을 페일클로즈드로 박는 조건에서만."*

---

## 1. 질문과 동기 — 왜 이 생각이 나왔나

GSD·spec-flow 는 `claude -p`/`codex exec` 같은 헤드리스 서브프로세스를 띄우지 않는다. 사람이 **이미 들어와 있는** Claude Code/Codex 세션의 그 에이전트가 **직접** 산출물을 쓴다(in-session). 반면 본 하네스는 사람이 Claude Code 안에 있어도 `bash scripts/run-stage.sh brief myrun` 이 내부에서 **또 다른** `claude -p` 자식 프로세스를 띄운다. 인터랙티브 상황에선 이게:

- **불투명하다** — 생성이 내 대화창이 아니라 하위 프로세스에서 일어나 안 보이고 중간 개입이 안 된다.
- **비싸다** — 별도 컨텍스트 창(이중 과금), 기본 모델로 떨어질 수 있음(내 세션은 Opus 4.8 1M 인데 하위는 기본값).
- **GSD/spec-flow 보다 손맛이 나쁘다.**

자동화(Slack)에서는 서브프로세스가 **정답**이다(세션 없는 헤드리스). 그래서 질문이 "둘 다 되게, 호출 표면에 따라 다르게" 로 좁혀진다.

---

## 2. 핵심 통찰 — 제어흐름의 역전 (inverted control flow)

두 표면은 **프로세스 위상의 쌍대(dual)** 다.

| | 부모(parent) | 자식(child) | 누가 생성하나 |
|---|---|---|---|
| **서브프로세스 모드**(Slack/헤드리스) | **셸**(`run-stage.sh`) | **LLM**(`claude -p`) | 셸이 프롬프트를 만들어 LLM 자식을 띄움 → 자식이 산출물 write → 부모 셸이 검증·전이 |
| **in-session 모드**(사람이 Claude Code 안) | **LLM**(대화 중인 에이전트) | **셸**(스크립트) | 에이전트가 곧 생성기. 산출물 write 후 셸을 *불러* 검증·전이 |

**자식 셸은 자기를 띄운 부모 LLM 을 동기적으로 되부를 수 없다.** OS 에 그런 원시연산이 없다(시도하면 *중첩된 두 번째* 모델을 띄우는 것으로 변질 — 바로 없애려는 그 위상). 그러므로:

> **in-session 생성 = `run_llm` 호출을 `run-stage.sh` 밖으로 들어내 스킬/에이전트 본문으로 올리고, 셸을 "검증 + 전이 + history 기록"으로 강등하는 것.**

이것이 spec-flow·GSD 가 실제로 도는 방식이고, 유일하게 옳은 모양이다(§4).

---

## 3. 지금 구조는 왜 안정적인가 — 바꾸지 않아도 되는, 그리고 *이미 의도된* 이유

1. **ADR 이 끝낸 판정.** 파일=상태 / 셸=결정론 전이 / LLM=산출물만 / 생성≠심의 / 사람=게이트 는 ICM·Anthropic·Conductor·LangChain 4개 1차 근거의 교집합이다. "임시방편"이 아니다.
2. **서브프로세스 1급 경로는 *이식성을 위해 의식적으로 선택*됐다.** `docs/harness-design.md` §11.4 / 부록 A 실측:
   > Codex 0.140 은 레포 `.agents/skills/` 를 **자동 발견하지 않고**(스킬은 전역 `~/.codex/skills/`), **`codex skills` 서브커맨드도 없다.**

   그래서 슬래시/스킬을 "편의 래퍼"로 강등하고 `prompts/<stage>.md` SSoT + `run-stage.sh`(`claude -p`/`codex exec`)를 표준으로 삼았다. **즉 in-session 생성은 이 하네스가 *일부러 피한* 의존성(인터랙티브 스킬 자동발견)을 부분적으로 되살리는 일이다.** 안정성의 근거가 곧 "함부로 건드리지 말 이유"다.
3. **현재 우선 목표는 Slack(브랜치 `feature/slack-poc-p0`).** Slack 은 서브프로세스가 정답이고 in-session 으로 얻는 게 0 이다.

→ **결론: 강제 변경 사유 없음.** in-session 은 "필요"가 아니라 "기호(인터랙티브 UX)"다.

---

## 4. spec-flow / GSD 리서치 — 차용할 것 / 베끼지 말 것

**차용(검증된 아이디어):** 둘 다 생성을 **in-session(LLM=부모)** 으로 돌리고 `claude -p` 서브프로세스가 **전혀 없다**(spec-flow 레포 `claude -p` 검색 결과 0건). 둘 다 셸/Node 를 에이전트가 *호출하는* 결정론 상태 I/O 로 강등한다(spec-flow `interaction-manager.sh`/`spec-cli.py`, GSD `gsd-tools.cjs` — *"LLM 자신은 상태를 직접 쓰지 않는다"*). **이건 본 하네스의 §1-1("스크립트가 상태, LLM 이 산출물")과 정확히 같다.** 즉 제어흐름 역전 리팩터는 도박이 아니라 *현역 패턴*이라는 산 증거다. GSD 의 **4종 체크포인트**(auto/human-verify/setup/hard-stop)는 ADR §8.5·업그레이드 플랜 WS-GATES 의 게이트 타입화로 이미 흡수 중.

**베끼지 말 것:**
- **Task() 서브에이전트 / `.claude/agents` 자동발견** — Claude 전용, Codex 에 동등물 없음. §1-3 위반.
- **hooks** — GSD 원본은 Claude 라이프사이클 hooks 13개를 쓰지만 *권고(advisory)*일 뿐 정확성에 필수 아님. 본 하네스의 no-hooks 가 더 엄격·이식적 — **유지.**
- **에이전트 주도 전이 / 프롬프트로 강제하는 게이트** — 둘 다 체크포인트를 *에이전트 프롬프트*로 강제한다. 본 하네스의 **스크립트=심판**(상태는 스크립트만, 생성≠심의는 substring 가드)이 더 강하다. in-session 으로 옮길 때 **프롬프트 준수 의존으로 후퇴 금지.**
- **역할만 분리한 크리틱** — 둘 다 크리틱 *역할*만 나누고 *모델*은 선택적. 본 하네스의 **물리적 프로세스/엔진 격리**(`KCIA_CRITIC_CMD≠HARNESS_CLI`, substring 가드, Snorkel 98.1%→56.9% 근거)가 더 강하다 — **그대로 보존.**

> ADR §8.1 보정: GSD 는 "헤드리스 서브프로세스"가 아니라 **in-session Task 서브에이전트**다. "Claude 전용+hooks"는 절반만 맞다(원본 스냅샷엔 맞지만 hooks 는 advisory, GSD-Core 는 멀티런타임). *— 웹 리서치 기반, 재확인 권고.*

---

## 5. 제안 설계 — `GEN_MODE` seam (채택할 경우에만)

환경변수 하나로 표면을 가른다. **기본은 오늘 그대로.**

```
HARNESS_GEN_MODE = subprocess | insession      # 기본 subprocess
HARNESS_CLI      = claude | codex | stub        # 기존 그대로. stub 은 GEN_MODE 보다 우선(오프라인/CI 불변)
```

**진입점**

| 경로 | 변화 | 역할 |
|---|---|---|
| `scripts/run-stage.sh <stage> <id>` | **기존 1급 경로 유지** + GEN_MODE 분기 | `subprocess`(기본)=프롬프트 빌드+`run_llm`+꼬리(오늘과 바이트 동일). `insession`=**`run_llm` 호출 거부**, 산출물 부재/무효면 **die("에이전트가 먼저 산출물을 써라")**, 절대 몰래 재생성 안 함, 그 후 꼬리 호출. `stub` 은 두 모드보다 먼저 단락. |
| `scripts/transition-stage.sh …` | **신규** | `run-stage.sh` 의 결정론 *꼬리*를 추출: `validate-stage.sh` + `step==generate` 전이 + `generate:*` history 이벤트 + `advance-phase.sh --render-only`. **두 모드가 공유하는 유일한 상태-쓰기 주체.** |
| `scripts/run-stage.sh … --emit-context` | **신규(읽기전용)** | `build_context()` 출력 + 단계별 fan-out 파일 목록(`concept-axes.json`/`tone-directions.json`/`storyline.json`)을 그대로 뱉어, in-session 스킬 본문이 **재유도 없이** 같은 파일을 쓰게(컨셉/톤/플랜 SSoT 드리프트 차단). |
| `skills/<stage>/SKILL.md` | 얇은 래퍼 → **in-session 생성 본문**으로 재구성 | "prompts/<stage>.md 읽기 + 컨텍스트 읽기 + 산출물 write + `run-stage.sh` 호출"의 순수 지시. `sync-skills.sh` 가 그대로 배포. |
| `scripts/next-action.sh <id>` | **불변** | run.md·Slack 어댑터 공용 읽기전용 SSoT. |
| `scripts/kcia-check.sh <id>` | **불변** | 항상 별프로세스 크리틱(`KCIA_CRITIC_CMD`). in-session 생성 경로에 **절대 포함되지 않음**(§6). |

**핵심:** `transition-stage.sh` 가 **항상** 진짜 `generate:*` 이벤트를 남기되 끝 토큰이 *진짜 엔진* 이어야 한다 — `generate:ok:<stage>:<engine>`(subprocess) 또는 `generate:insession:<stage>:<engine>`(insession). 그래야 `kcia-check.sh` 의 GEN_CLI 추출이 **두 모드 모두에서** 발동한다.

---

## 6. §1-4 생성≠심의 격리 — in-session 에서 어떻게 지키나 (★ 단 하나의 필수 조건)

**in-session 생성: 가능. in-session 자가심의: 불가능 — 구조적으로.** 한 인터랙티브 세션의 사람은 **정확히 하나의** CLI(Claude Code *또는* Codex) 안에 있다. 그 한 엔진이 생성기다. 따라서 *다른 엔진* 크리틱은 같은 세션에서 못 돈다 — **반드시 서브프로세스 셸아웃**이어야 한다. `kcia-check.sh` 는 in-session 생성 경로의 일부가 **결코 아니다**; 생성 *후에* 사람이 `bash scripts/kcia-check.sh <id>` 로 따로 돌려 다른 프로세스/모델을 띄운다. → **"생성은 in-session, 심의는 out-of-session"이 공짜로 떨어지고, §1-4 물리 격리는 그대로 유지된다.**

**단, 단 하나의 진짜 구멍 = GEN_CLI 토큰의 출처.** 내가 직접 확인한 가드 동작(`kcia-check.sh:71-75`):

```python
g=[e['event'] for e in history if e['event'].startswith('generate')]
GEN_CLI = g[-1].split(':')[-1] if g else "${HARNESS_CLI:-stub}"
# 직후: KCIA_CRITIC_CMD 가 GEN_CLI 를 substring 으로 포함하면 die (self-grading 차단)
```

- 토큰이 `insession` 이나 `stub` 으로 기록되면 `claude -p` 와 substring 매칭이 **안 돼** 가드가 **조용히 풀린다** → Claude Code 안의 사람이 Claude 크리틱을 돌릴 수 있다(= 하네스가 막으려는 바로 그 Snorkel 자가비판 패러독스).
- **따라서 토큰은 반드시 *진짜 엔진 패밀리*(`claude`/`codex`)여야 하고, *스크립트가* 신뢰 가능한 비-에이전트 신호에서 박아야 하며, 스킬 본문이 위조할 수 없어야 한다.**

> **이 조건이 채택의 유일한 비협상 게이트(adversarial #1, BLOCKING).** 페일클로즈드 4종:
> 1. **엔진 출처 잠금** — in-session 엔진을 스킬 본문이 set 불가. `run-stage.sh`/`transition-stage.sh` 가 살아있는 CLI 를 신뢰 신호에서 감지해 `{claude,codex}` allow-list 로 검증, 신뢰 신호 없이 insession 요청 시 **die**.
> 2. **페일클로즈드** — `generate:insession:*` 인데 토큰이 `stub`/빈값/미상이면 **에러(die)**, 조용한 skip 금지. "진짜 stub 런"과 "엔진 미해결"을 구분.
> 3. **네임스페이스 예약** — `generate:insession:*` 끝 토큰이 `{claude,codex}` 안인지 assert.
> 4. **테스트** — 올바른 패밀리 토큰 기록 + 동일패밀리 크리틱 die + **부정 케이스**(스킬 본문이 `HARNESS_INSESSION_ENGINE=stub/codex` 로 가드 무력화 시도 실패, 엔진 미해결 시 페일클로즈드).

---

## 7. Codex 이식성 — 진짜 발목 (이미 §11.4/부록 A 에서 의도적으로 피한 의존)

- **해결됨:** subprocess·stub 경로는 Claude/Codex/stub 에서 **바이트 동일** 유지(`run_llm` 불변, 기본 모드).
- **갭(레포 자체 실측, §11.4(d)):** Codex 가 `SKILL.md` 본문을 **in-session 으로 실행**하는지가 핀 버전에서 **미검증**(0.140 은 `.agents/skills` 자동발견 X, `codex skills` 서브커맨드 X, 스킬은 전역). 이 설계는 스킬 본문을 **인터랙티브 모드의 정확성에 load-bearing 으로** 만든다 — 하네스가 *일부러 의존 안 하기로 한* 바로 그 기반 위로 정확성을 옮기는 것. run-id 주입도 갈림(`$ARGUMENTS`/`$1` 은 Claude 전용, Codex 인자치환 미문서화).
- **위험(adversarial #3, HIGH):** `.agents/skills` 자동발견에 *정확성*을 거는 건 §1-3 정면충돌이고 Codex 업그레이드마다 재검증 필요 → 정의상 "동일 거동" 아님.
- **해소:** `HARNESS_GEN_MODE=insession` 을 §11.4(d)가 핀 Codex 빌드에서 부록-A 실측으로 닫힐 때까지 **Claude 전용**으로 출하. Codex-인터랙티브는 "검증 전까진 subprocess(`HARNESS_CLI=codex`) 쓰라"고 문서화. `.agents/skills` 방출은 *선택적 편의 복사일 뿐*, 하드 보장은 "subprocess 는 스킬 발견 0 으로 어느 엔진에서나 동작".

---

## 8. 보존 / 변경 — 한눈에

**절대 안 건드림(안정적 핵심):**
state.json 단일 쓰기(§1-1) · 생성≠심의 물리 격리(§1-4) · 라우팅에 LLM 미개입(G5) · 동결 스키마(G1) · stub+골든테스트(GEN_MODE 앞에서 단락) · **Slack 경로 전체(`next-action.sh` SSoT, run-stage.sh 서브프로세스)** · `run_llm`(추가될 뿐 대체 안 됨) · `prompts/<stage>.md` CLI-중립 생성 SSoT.

**변경(채택 시):**
`run-stage.sh`(GEN_MODE 분기 + `--emit-context`) · 신규 `transition-stage.sh` · 13개 `skills/<stage>/SKILL.md` in-session 본문화 · `sync-skills.sh`(선택적 `.agents/skills/` 방출) · `tests/test-gen-not-review-isolation.sh` 확장 · `AGENTS.md §2` 문서화.

---

## 9. 적대검증이 찾은 위험 (채택 시 필수 방어 — non-trivial 만)

| # | 위험 | 심각도 | 완화 |
|---|---|---|---|
| A | **자가심의 가드 페일오픈(조용히)** — 엔진 토큰이 에이전트-set 가능하거나 `stub` 폴백이면 생성기가 자기 죄증 토큰을 통제 → 가드 skip | **BLOCKING** | §6 의 출처잠금+페일클로즈드+네임스페이스+부정테스트 (한 묶음) |
| B | **몰래 재생성 구멍** — `primary_ok()` false 시 latent resume 경로가 `run_llm` 로 fall-through → 에이전트 자식 셸이 *중첩* `claude -p` 를 띄움 | MEDIUM | insession 은 산출물 부재/무효 시 **하드 die**, 9개 `run_llm` 사이트 전부 skip. 테스트: insession+산출물부재 ⇒ 비정상종료, 서브프로세스 0, state 불변 |
| C | **verdict 신선도** — subprocess 재생성은 stale verdict 삭제(`run-stage.sh:146-147`)하나 insession/resume 경로는 안 함 → revise 루프서 stale `pass` 가 review 로 생존 | MEDIUM | `transition-stage.sh`(스크립트, 에이전트 아님)가 신선 산출물 시 stale verdict 제거 후 `gate=review` 전이 |
| D | **꼬리 추출은 거동 동일해야** — `next-action.json` 은 온디맨드(항상 신선), run.md 는 *물질화 캐시*(writer 가 render 호출해야 갱신) | MEDIUM | `transition-stage.sh` 가 `run-stage.sh:338-350` 을 *정확히* 재현 + 끝에 반드시 `advance-phase.sh --render-only`. fan-out per-item `generate:*` 는 꼬리 아닌 생성 분기에 유지. CI: GEN_MODE 미설정 vs `=subprocess` 골든 동일성(history 토큰+structdiff), stub 우선 assert |
| E | **스킬 본문 격리** — 본문이 순수 지시여야(state.json write 금지, 생성중 select/approve/revise 호출 금지) | MEDIUM | 모든 insession `SKILL.md` 에 금지 패턴 grep 린트/테스트 |

---

## 10. 단계적 적용 (채택할 경우에만, 작은 것부터 — 골든테스트 게이트)

```
WS-TAIL        transition-stage.sh 추출(거동 0변화 리팩터). run-stage.sh subprocess 가 호출.
  GATE         골든 전수 그린 + history 토큰 동일 + structdiff. 바이트 동등 전엔 아무것도 더 안 나감.
   │
WS-GENMODE     run-stage.sh GEN_MODE 분기(insession=die-on-missing, run_llm skip, stub 우선).
               + 출처잠금 엔진감지 + kcia-check 페일클로즈드(A) + stale-verdict 제거(C) = 한 안전 단위.
  GATE         확장 test-gen-not-review-isolation.sh(부정/스푸프 포함) + insession-산출물부재 테스트.
   │
WS-EMIT-CTX    run-stage.sh --emit-context(읽기전용) — fan-out 3종 + idempotent-skip 집합 커버.
  GATE         select.sh VALID 목록 + recommendation 교차검증 불변.
   │
WS-SKILLS-CC   skills/<stage>/SKILL.md in-session 본문화 + 본문격리 린트(E). Claude 전용.
               단일-primary(brief/guideline/outline/keyvisual) 먼저 → fan-out(concept/tone/plan) 은 --emit-context.
  GATE         수동 호출만(disable-model-invocation:true), subprocess 1급 유지.
   │
WS-CODEX-VFY   §11.4(d) 핀 Codex 빌드 실측(본문 in-session 실행+run_id 전달?). 스킬 미설치로 전 사이클 완주 회귀.
  GATE         그린일 때만 insession 을 Claude전용→검증 allow-list 로 승격. .agents/skills 는 선택 편의.
```

---

## 11. 권고 — 언제 하고, 언제 안 하나

- **지금 하지 않는다.** 강제 사유 0, Slack 이득 0, 인터랙티브 손운전 빈도가 아직 비용으로 청구되지 않음. 이 문서로 설계만 동결.
- **이럴 때 꺼낸다(트리거):** Claude Code 안에서 사람이 손으로 단계를 자주 몰면서 (a) 하위 `claude -p` 의 불투명·이중컨텍스트 비용이 실제로 거슬리거나, (b) 생성 중간 개입 욕구가 반복될 때. → **WS-TAIL 만** 먼저(거동 0변화, 그 자체로 코드 정리 이득). 그다음 WS-GENMODE(+§6 안전단위)까지가 "최소 의미 있는 단위".
- **하더라도 불변 원칙:** Claude 전용 시작 · 플래그 기본 off · additive(`run_llm` 대체 금지) · Slack/서브프로세스 경로 무수정 · §6 페일클로즈드 동반 출하 · Codex-인터랙티브는 검증 전까지 subprocess.

> 즉, **"안정적이면 무리해서 바꾸지 않는다"가 이 제안의 1순위 판단축이며, 본 제안은 그 축을 *위반하지 않는* 형태(선택·additive·역행불가 안전조건)로만 존재한다.**

---

## 12. 미해결 질문 (구현 결정 시)

1. **엔진 토큰 출처 메커니즘(WS-GENMODE 블로킹):** `run-stage.sh` 가 에이전트-set env 를 신뢰하지 않고 *어떻게* 살아있는 CLI 를 감지하나? Claude Code/Codex 가 주입하는, 스킬 본문이 위조 못 하는 마커 env 가 있나? 없으면 insession 은 추측 말고 die — **이게 load-bearing 결정.**
2. **토큰 입도:** 패밀리(`claude`/`codex`) vs 정확 모델 id. substring 가드가 동일패밀리 크리틱과 충돌하려면 **패밀리(coarse)가 필수** — 확정 필요.
3. **fan-out `step==generate` 전제:** `--emit-context` 가 부분-resume + fan-out 3종을 커버해 부분쓰기+전이가 state 를 어긋내지 않음을 확인.
4. **표면 시그널링:** `next-action.sh` JSON 모양을 동결(호출자가 모드 선택: Slack=미설정→subprocess, 스킬=insession) vs `surface` 필드 추가(Slack 어댑터 보조변경 동반). 계약 확정.
5. **수동전용 범위:** 생성 스킬에 `disable-model-invocation:true`(Claude)/`allow_implicit_invocation:false`(Codex) — 단계-게이트 철학과 정합. 범위 확정.
6. **Codex 인터랙티브 타이밍:** §11.4(d) 검증이 이번 범위인가, 아니면 "Claude전용 insession + Codex=subprocess" 가 당분간 종착 상태로 OK 인가.

---

> **고지(AGENTS.md §7).** 본 제안은 법적 통과 보증이 아니라 자율·비법적 사전 점검 도구의 *선택적* 보강이다. 최종 책임은 사람(현업/RA)에게 있다.
