# 오케스트레이션 아키텍처 의사결정 기록 (ADR)

> 위치: 이 문서는 "내가 만든 파일 기반 단계-게이트 구조가 최선인가, 유지보수성이 떨어지지 않나?"라는 자기검증 질문에 대한 **영구 의사결정 기록**이다.
> 불변식·안전 규칙은 [`../AGENTS.md`](../AGENTS.md)(§0~§8 SSoT)가, 설계 상세는 [`harness-design.md`](./harness-design.md)·[`multi-domain-build-plan.md`](./multi-domain-build-plan.md)가 SSoT다. 이 문서는 그 구조의 **아키텍처적 정당성**을 외부 근거로 못박는다.
> 작성일 기준: 2026-06-20

---

## 0. 한 줄 결정 (TL;DR)

**현 파일 기반 단계-게이트 구조를 유지한다. 재구축(LangGraph/Temporal 등 프레임워크 이식)은 불필요하다.**

> 근거 한 문장: 이 하네스(`state.json` + `scripts/*.sh` 결정론 전이, LLM은 산출물만 작성)는 Anthropic의 'workflow' 정의·arXiv ICM 논문(파일시스템=오케스트레이션)·Microsoft Conductor(YAML 선언적 결정론 라우팅)와 **동형(isomorphic)** 인, 학계·산업이 검증한 정당한 패턴이며, 조건분기·HITL·생성≠심의 분리가 모두 1급 패턴으로 지원되기 때문이다.

---

## 1. 맥락 — 무엇을 물었나

질문은 두 가지다.
1. (정당성) 이 파일 기반 단계-게이트 구조가 **올바른 선택**인가?
2. (유지보수성) 시간이 지나며 **유지보수성이 떨어지지** 않는가, 더 정교한 오케스트레이터로 갔어야 하나?

### 1.1 현재 구조 요약 (검증 대상)

| 축 | 현 하네스의 결정 |
|---|---|
| 상태 소유 | `state.json` 은 오직 `scripts/*.sh` 만 쓴다. LLM/스킬은 산출물·`verdict.json`·`feedback.json` 만 쓴다(`AGENTS.md` §1-1).¹ |
| 전이 방식 | 셸 스크립트가 상태를 **결정론적으로** 전이. 오케스트레이션 루프에 LLM 없음. |
| 파이프라인 | `00-ingest → [00g-guideline] → 01-brief → 02-concept → 03-storyboard(outline→tone→plan) → 04-keyvisual → done` (`AGENTS.md` §4). |
| 생성≠심의 | `KCIA_CRITIC_CMD`(심의) ≠ `HARNESS_CLI`(생성). 같으면 오류 중단(self-grading 금지, §1-4). |
| HITL 게이트 | 각 페이즈 = 생성 → 심의 → [선택] → **사람(approve/revise/select)**. JSON 손편집 없이 셸 한 줄(§5). |
| 분기 | `00g-guideline` 은 **조건부**(유사 사례 있을 때만). 분기 결정은 **사람이 게이트**에서 한다. |
| 이식성 | hooks·subagent 자동발견·프레임워크 런타임 의존 금지. 루프 제어는 항상 `state.json` + 명시 호출(§1-3). |

> ¹ 정확성 보충: `feedback.json` 은 LLM 산출 관점의 분류이며, 실제로는 현업 보완(revise) 경로에서 `scripts/revise.sh`(스크립트)가 쓴다(`revise.sh:32`). `AGENTS.md` §1-1 의 'LLM/스킬만 쓰는 파일' 분류는 산출물 생성 관점의 단정이고, 코드 현실과는 이 한 점에서 미세하게 다르다.

이 ADR은 위 구조가 "임시방편으로 굴러가는 것"인지, 아니면 "독립적으로 도달된 정당한 패턴"인지를 외부 1차 근거로 판정한다.

---

## 2. 검증된 근거

> 아래 표는 6각도 딥리서치 → 22개 주장 적대검증의 **확정(findings)** 결과다. `vote` 는 3표 적대검증 결과(찬-반), `confidence` 는 확정 신뢰도다. 본 절은 가장 load-bearing 한 두 인용(Anthropic의 workflow 정의, ICM의 파일시스템=오케스트레이션)만 원문을 본문에 남기고, 나머지는 한국어로 단정 요약한다(원문 출처는 §10).

### 2.1 핵심 근거 8선

| # | 근거 | confidence | vote | 출처 |
|---|---|---|---|---|
| 1 | **Anthropic: workflow vs agent 구분.** scripts 결정론 전이·LLM 미자율인 본 하네스는 'workflow'로 분류되는 정당한 설계 범주다. 원문: *"Workflows are systems where LLMs and tools are orchestrated through predefined code paths. Agents are systems where LLMs dynamically direct their own processes and tool usage."* | high | 3-0 | Anthropic, Building Effective Agents² |
| 2 | **ICM: 파일시스템 = 오케스트레이션 레이어.** 번호 폴더=단계, 마크다운=프롬프트, 로컬 스크립트=비-AI 기계작업. 프레임워크 레벨 오케스트레이션을 대체. = **본 하네스와 동형.** 원문: *"replaces framework-level orchestration with filesystem structure. Numbered folders represent stages... Local scripts handle the mechanical work that does not need AI at all."* | high | 3-0 | arXiv 2603.16021 (ICM) |
| 3 | **Microsoft Conductor: 선언적 결정론 라우팅.** 워크플로우=버전관리 YAML, 라우팅=Jinja2 first-match-wins, 오케스트레이션 루프에 LLM 없음(토큰 0으로 다음 실행 결정). config 주도 상태전이와 직접 평행. | high | 3-0 | Microsoft Conductor (2026.5) |
| 4 | **Routing + prompt-chaining+gate.** routing=입력 분류 후 특화 후속 작업으로 보냄(관심사 분리). prompt-chaining=단계 시퀀스 분해 + 중간에 프로그래밍 'gate' 체크로 궤도 이탈 방지. = `state.json`+scripts 게이트에 직접 매핑. | high | 3-0 | Anthropic, Building Effective Agents² |
| 5 | **HITL 게이트.** 중요 단계(예: API 호출) 직전 일시정지해 사람이 실행 전 검토·승인하는 approval-gate 패턴. = 본 하네스 `approve/revise/select.sh` 와 기능적 평행. | high | 3-0 | LangChain, interrupt() HITL |
| 6 | **역할별 모델 격리(→ 생성≠심의).** 각 에이전트가 고유 세션·시스템프롬프트·모델·프로바이더·temperature 로 격리(분류=haiku, 추론=opus 식 혼용). = 본 하네스 `KCIA_CRITIC_CMD ≠ HARNESS_CLI` 강제와 부합.³ | high | 3-0 | Microsoft Conductor (2026.5) |
| 7 | **Claude Code: dynamic workflows.** 스크립트가 loop·branching·중간결과를 직접 보유하는 코드화 오케스트레이션을 네이티브 지원. 원문: *"A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer."* 별도 finding(claude-code-gen-vs-review)으로 **독립 에이전트의 적대적 교차검증**도 내장: *"it can have independent agents adversarially review each other's findings before they're reported..."*⁴ | high | 3-0 | Claude Code Workflows 문서 |
| 8 | **LangGraph: interrupt()/persistence.** HITL=interrupt()로 mid-run 일시정지, checkpointer/stores로 durable execution·장애복구. = 파일기반이 **못 가진 영역**(observability O, traceability/장애복구 X). | high | 3-0 | LangChain, durable execution |

> ² URL 주의: RESEARCH 의 workflow-vs-agent finding 실제 출처는 `https://www.anthropic.com/engineering/building-effective-agents` 이고, primarySources·본 ADR 본문은 `https://www.anthropic.com/research/building-effective-agents` 로 표기한다. `/engineering/` 와 `/research/` 는 동일 문서의 두 경로이며(§10 출처표 기준 URL), 본 ADR은 후자로 통일한다.
> ³ **한정(반드시 명시):** Conductor 출처는 **역할별 모델격리(세션/프롬프트/모델/프로바이더/temperature)** 까지만 직접 검증한다. 이를 **생성≠심의** 로 해석·연결하는 것은 **리뷰어 해석**이다(역할별 격리 사실 자체는 완전 검증). 따라서 #6 은 "검증된 사실(역할별 격리)" + "그 사실의 해석적 적용(생성≠심의)" 을 구분해 읽어야 한다.
> ⁴ #7 은 두 별개 finding(claude-code-dynamic-workflows + claude-code-gen-vs-review)을 한 행에 합쳤다. 위 첫 원문은 dynamic workflows 주장을, 둘째 원문은 적대적 교차검증 주장을 각각 1:1 로 뒷받침한다(인용이 모든 주장을 덮지 않는다).

### 2.2 보조 근거 (트레이드오프 정량화)

| 근거 | confidence | vote | 핵심 원문 | 출처 |
|---|---|---|---|---|
| **ICM 트레이드오프는 의도된 것.** 프로그래밍 오케스트레이터의 유연성을 plain text의 이식성·검사가능성·편집가능성과 명시적 교환. | high | 3-0 | "ICM trades the flexibility of a programmatic orchestrator for the portability, inspectability, and editability of plain files. That tradeoff is the point." | arXiv 2603.16021 |
| **관측가능성은 부산물.** 모든 중간 산출물이 plain 파일이라 로깅 레이어·대시보드 불필요, 폴더 열어 파일 읽으면 끝.⁵ | high | **2-1** | "the system is observable by default. There is no logging layer to build, no dashboard to configure... You open a folder and read the files." | arXiv 2603.16021 |
| **Conductor의 의도적 결정론 선택.** 구조가 알려진 워크플로우(review loop·research pipeline·plan-then-implement)에는 재계획 유연성보다 예측가능성·비용통제·감사가능성을 택함. | high | 3-0 | "...have known structure... We'd rather have predictability, cost control, and auditability than replanning flexibility." | Microsoft Conductor (2026.5) |

> ⁵ **2-1 split 사유:** 저자 인정 — ICM 는 observability(관측가능성)는 주지만 **traceability(추적성)는 아니다**. 즉 "폴더만 열면 현재 상태가 보인다"는 참이나, "어떤 전이가 누가·언제·왜 일어났는지 거슬러 추적"하는 traceability 는 별개이며, 이 갭이 split 의 근거다(보강은 §5-② → §6 임계점과 연결).

> 판정: 이 하네스가 독립적으로 도달한 설계(파일=상태, 셸=결정론 전이, LLM=산출물만, 생성≠심의, 사람=게이트)는 **네 개의 1차 출처**가 각각 정당화하는 패턴의 교집합이다. "우연히 굴러가는 임시방편"이 아니라, 학계(ICM)·플랫폼 벤더(Anthropic·Microsoft·LangChain)가 같은 결론에 수렴한 정규 패턴이다.

---

## 3. 트레이드오프 — 어디서 이기고 어디서 지는가

### 3.1 파일 기반이 **이기는** 지점

| 영역 | 왜 이기나 | 근거 |
|---|---|---|
| 관측가능성 | 로깅 인프라 0. 폴더 열고 파일 읽으면 전체 상태가 보인다(공짜). | ICM(2-1) |
| HITL | 모든 중간 산출물이 사람이 검토·편집 가능한 plain 파일 → 게이트가 자연스럽다. 별도 일시정지 메커니즘 불필요. | ICM, LangChain HITL |
| 이식성 | plain text + 셸. 두 CLI(Claude Code·Codex)에서 동일 구동. 프레임워크 런타임·배포 인프라 의존 없음. | ICM("That tradeoff is the point") |
| 디버깅 | 프롬프트·응답이 가려지지 않는다(프레임워크 추상화 레이어 없음). | Anthropic(프레임워크 경고) |
| 감사가능성 | 산출물·`verdict.json`·승인 이력이 전부 파일·git diff·`state.json.history` 로 남는다. | Conductor(version-controlled YAML) |

### 3.2 파일 기반이 **지는** 지점 (ICM 저자 자기고백)

| 약점 | 내용 | 본 하네스에 적용되나? |
|---|---|---|
| **AI 주도 mid-pipeline 자동분기** | "AI 결정 기반 복잡 분기 로직은 ICM에서 어색하다. 자동분기를 구현하면 ICM 자체가 프레임워크로 이동한다." | **❌ 안 걸림.** 본 하네스의 `00g-guideline` 분기는 **사람이 게이트에서** 결정한다(select.sh). AI가 mid-pipeline에서 자동으로 가지를 치지 않는다. |
| **실시간 다중에이전트 / 고동시성** | message-passing·큐잉·배포 인프라가 필요한 영역에는 부적합. | **❌ 안 걸림.** 본 하네스는 run 단위 순차·비동기 인간검토 파이프라인이다. 실시간 동시성 요구가 없다. |
| **traceability / 장애복구 지속성** | ICM은 observability는 주지만 traceability·durable 장애복구는 아니다. checkpointer가 없다. | **△ 부분 노출.** traceability 의 핵심(타임스탬프·행위자·이벤트)은 이미 채워져 있고(§5-②), 남은 갭만 보강한다. 프레임워크 전환 임계점은 **§6 단일 SSoT** 참조. |

> ICM 저자 원문: *"Workflows that require complex branching logic based on AI decisions mid-pipeline are awkward in ICM. A human can make branching decisions between stages... but automated branching would require scripting that moves ICM toward being a framework itself."*
>
> 핵심: 약점 3개 중 2개는 **본 하네스의 설계 전제(사람이 분기 게이트, 순차 인간검토)** 때문에 트레이드오프 범위 안에서 회피된다. 즉 약점이 "현재 우리에게 비용으로 청구되지 않는다." 남은 1개(traceability)도 이미 대부분 구현돼 있다(§5-②). "언제 프레임워크로 가는가"의 임계점 판단은 **§6** 에서 단일하게 정의한다.

---

## 4. 균형 / 반증 — 정직하게 기각된 과장

> 이 ADR을 "파일기반 만세"로 끌고 가려는 유혹이 있다. 적대검증은 그런 과장 3건을 **기각**했다. 이 문서는 그 기각을 사실처럼 적지 않는다.

| 기각된 주장 | vote | 왜 기각됐나 (이 ADR의 입장) |
|---|---|---|
| "Anthropic이 프레임워크 사용을 권하지 않으며, 성공 구현은 LangGraph를 안 썼다 → 파일기반이 프레임워크보다 **우월**하다" | **1-2 기각** | Anthropic의 실제 입장은 **균형**이다: "직접 API로 시작하라, 프레임워크를 쓸 거면 내부를 이해하라." '프레임워크보다 우월'은 일반화 금지. 프레임워크도 시작은 쉽게 한다. |
| "routing 패턴이 조건분기의 **유일한 정석(canonical) 메커니즘**이다" | **0-3 기각** | routing 패턴 자체는 3-0 확정이지만, '유일한 정석'이라는 강한 프레이밍은 기각. 조건분기 메커니즘은 여럿이다. |
| "Claude Code workflow 런타임은 mid-run HITL 입력을 지원하지 않아 단계별로 워크플로우를 쪼개야만 한다" | **1-2 기각** | 단정 금지. 그런 제약을 사실로 적지 않는다. |

> **이 ADR이 명시하는 한정(caveats):**
> - **시간 한정:** Anthropic 'Building Effective Agents'는 **2024.12 작성, 약 18개월 된 글**이다. 멀티에이전트/Agent SDK 출시 **이전** 시점의 관찰이다. "프레임워크보다 단순 패턴이 낫다"는 그 글의 톤은 **그 시점의 역사적 관찰**로만 유효하며, 오늘 시점의 우월성 일반화 근거로 쓰면 안 된다.
> - **최신성 한정:** Claude Code dynamic workflows(v2.1.154+, 2026.5)·Microsoft Conductor(2026.5.14 출시)는 매우 최신이라 **장기 프로덕션 안정성·통제비교 미검증**이다. ICM 논문도 저자 스스로 *통제비교 부재·자기선택 커뮤니티·단일 모델패밀리*를 인정한다 → 결론은 "파일기반이 프레임워크보다 우월"이 아니라 **"순차·인간검토 워크플로우에 실현가능·적합"** 까지만이다.
> - **해석 한정(§2.1 #6):** Conductor의 **역할별 모델격리** 를 **생성≠심의** 로 묶는 것은 **리뷰어 해석**이다(역할별 격리 사실 자체는 검증). 본 ADR의 생성≠심의 정당화는 이 한정 위에서 읽어야 한다.
> - **traceability 한정(§2.2):** ICM 의 observability ≠ traceability/장애복구 지속성. 저자 자기고백이며 §5-②·§6 의 전제다.

---

## 5. 결정

**현 구조를 유지한다. 재구축하지 않는다.** 단, 약점이 실제로 청구되지 않도록 **보강 3가지**를 한다. 보강은 모두 plain-text 원칙을 깨지 않는다.

| # | 보강 | 무엇을 | 왜 (근거) |
|---|---|---|---|
| ① | **도메인 룰셋 라우팅을 선언적 한 곳으로 (이미 SSoT)** | 도메인→{룰셋/크리틱/프로파일} **라우팅**은 이미 `harness/regulatory-domains.json` 이 단일 SSoT 이며 다수 스크립트(`build_context`·`new-run.sh`·심의엔진)가 소비한다. 보강은 새 도메인 추가 시 분기 조건이 스크립트로 흩어지지 않게 **이 레지스트리 중심으로 계속 집약**하는 것. ※ 단, 이 레지스트리가 라우팅하는 것은 **룰셋/프로파일 선택**이지 **파이프라인 분기**가 아니다 — 유일한 실제 분기인 `00g-guideline` 조건부 실행은 레지스트리가 아니라 **동일 도메인 사례(`inputs/examples/<도메인>/`) 존재 여부**로 게이트된다(`run-stage.sh:154~`, `render_runmd.py:27~`). 두 메커니즘은 별개다. | Conductor: "version-controlled, diffable, reviewable" 선언적 라우팅이 결정론 워크플로우의 정석. |
| ② | **traceability 갭 — 이미 대부분 구현됨, verdict 역참조만 남음** | `state.json.history` 는 모든 게이트 전이마다 `{ts, phase, event, by[, actor]}` 를 누적한다(`append_history()`, `common.sh:227~`; 스키마 `state.schema.json` history.required=`[ts,phase,event,by]`). **timestamp(ts)·행위자(actor, `--by`→`HARNESS_ACTOR`)는 이미 존재**한다(현 브랜치 커밋 e9c6dd5 '--by 감사'). **남은 갭**은 history 엔트리를 해당 심의 결과와 **1:1 로 링크**하는 것뿐인데, 주의: `verdict.json` 스키마에는 현재 **`id` 필드가 없다**(`verdict.schema.json` required=`[verdict,engine,confidence,violations,escalate]`). 따라서 '연결된 verdict.json id' 는 (a) `verdict.schema.json` 에 식별자 필드를 **신설**하거나 (b) `history.event` 에 **verdict 파일경로**(예: `01-brief/brief-verdict.json`)를 참조로 남기는 **신규 작업**이다. ts·actor 는 신규 구축이 아니라 **기존 구현의 일관 적용**이다. | ICM 자기고백: observability O / traceability X. 본 하네스는 ts·actor 까지 이미 채웠고 **verdict 역참조 한 칸만 남았다.** |
| ③ | **마이그레이션 임계점 사전 정의** | "언제 프레임워크로 가는가"의 신호 정의는 **§6 단일 SSoT** 에 못박는다. 임계점 도달 전에는 흔들지 않고, 도달하면 미루지 않는다. | 결정론 워크플로우의 임계점은 ICM 저자가 명시한 트레이드오프 경계선과 일치(§6). |

> **재구축 안 함**의 의미: LangGraph/Temporal/Conductor로 **지금** 이식하지 않는다. 현재 요구(순차·인간검토·생성≠심의·이식성)는 파일+셸로 완전히 충족되며, 프레임워크 도입은 디버깅 난이도·운영 인프라·이식성 손실이라는 비용만 추가한다.
>
> **감사 추적 현황(콜아웃):** 타임스탬프·행위자·이벤트 추적은 `state.json.history` 에 **이미 채워져 있다**(ts/phase/event/by/actor). 남은 것은 history 엔트리에서 해당 `verdict.json` 으로의 **역참조(verdict id 또는 파일경로 링크)** 한 가지뿐이다. "이 한 칸이 비어 있다"가 아니라 "한 칸만 남았다."

---

## 6. 마이그레이션 임계점 — 언제 LangGraph/Temporal을 검토하나 (단일 SSoT)

> 임계점 논의의 단일 진실은 **이 절**이다(§3.2·§5-③·§9 는 여기를 참조만 한다). 아래 신호 중 **하나라도** 지속적으로 발생하면, §5-③의 약속대로 프로그래밍 오케스트레이터(LangGraph/Temporal/Conductor) 검토를 **미루지 않고** 시작한다.

🚩 **신호 1 — AI 주도 mid-pipeline 자동분기 요구.** 사람 게이트 없이 AI 결정으로 파이프라인 중간에서 가지를 쳐야 한다. (ICM 저자가 명시한 파일기반의 알려진 약점 — 이걸 스크립트로 구현하면 이미 프레임워크다.)

🚩 **신호 2 — run이 시간·일 단위로 길어지고 장애복구가 필요.** 단일 run이 길어져 중단 후 재개·장애복구 지속성(durable execution)이 비용으로 청구된다. (LangGraph checkpointer / Temporal의 영역. 파일기반은 observability는 주지만 장애복구 지속성은 주지 않는다.)

🚩 **신호 3 — 고동시성 충돌.** 실시간 다중에이전트·고동시성으로 message-passing·큐잉·배포 인프라가 필요해진다. (ICM이 명시적으로 부적합하다고 한 영역.)

> 신호가 없는 동안에는 **흔들지 않는다.** 위 3개는 모두 ICM 저자가 자기고백한 트레이드오프의 경계선과 정확히 일치한다. 단, **임계점이 무엇인지**(=이 세 신호)는 여기서 단정하지만, **임계점에 도달했을 때 어떤 순서·절차로 점진 전환하는가**(마이그레이션 경로)는 아직 미검증이다 → §9-1.

---

## 7. 도구 선택 결정 트리

```
워크플로우가 순차적이고, 분기는 사람이 게이트에서 결정하며,
중간 산출물을 사람이 검토·편집하고, 이식성(여러 CLI/오프라인)이 중요한가?
│
├─ 예 ──────────────────────────────► [파일 기반 단계-게이트]  ← 본 하네스. 유지.
│                                       (state.json + scripts/*.sh, LLM=산출물만)
│
└─ 아니오  → 어느 신호인가? (§6)
   │
   ├─ AI가 사람 없이 mid-pipeline에서 자동 분기/재계획해야 하는가? (신호 1)
   │   └─ 예 ─► [LangGraph 류 그래프 오케스트레이터]
   │            (interrupt()/Command(resume=), 동적 라우팅)
   │
   ├─ run이 길고(시간·일) 장애복구·durable execution이 필요한가? (신호 2)
   │   └─ 예 ─► [Temporal / LangGraph checkpointer+stores]
   │            (체크포인트 기반 재개·fault tolerance)
   │
   └─ 실시간 다중에이전트·고동시성·message-passing이 핵심인가? (신호 3)
       └─ 예 ─► [AutoGen 류 다중에이전트 / 큐잉 인프라]
```

> 주의: 트리는 "어느 게 우월한가"가 아니라 "**어느 요구에 어느 도구가 맞는가**"다. 현재 본 하네스의 요구는 최상단 분기(예)에 정확히 떨어진다.

---

## 8. 참고 사례 (Prior Art) — 같은 구조로 잘 만들어진 사례

> 이 절은 본 ADR의 판정(파일 기반 단계-게이트 유지)을 **외부 구현 사례**로 보강한다. 2026-06-20, "이 구조로 잘 만들어진 베스트 프랙티스를 찾아달라"는 후속 요청에 따라 병렬 리서치 에이전트 3개가 각 링크를 WebSearch/WebFetch로 **실재 확인**해 큐레이션했다. 별/버전 등 성숙도 수치는 변동하므로 본문에 박제하지 않으며 **링크 실존만 보증**한다(확인 시점 2026-06-20). 외부 출처의 verbatim·정확성은 §10 단서와 동일하게 별도 재확인을 권고한다.

### 8.1 본 하네스와 가장 동형인 구현 (직접 표본)

| 사례 | URL | 정체 / 무엇이 닮았나 | 배울 점 ↔ 하네스 매핑 |
|---|---|---|---|
| **Spec-Flow** ⭐ | github.com/marcusgoll/Spec-Flow | 아이디어→런칭 6단계 + 런타임 상태 `interaction-state.yaml`로 어느 단계서든 재개 + 단계별 사람 승인 체크포인트 + `--auto` 무인 토글. **현존 사례 중 가장 동형·세련.** | `---COMPLETED--- / ---NEEDS_INPUT--- / ---FAILED---` **구조화 핸드오프 신호** → `verdict.json`/`feedback.json`에 응용. interaction-state.yaml ↔ `state.json`. **차이:** 제어흐름이 에이전트 주도(본 하네스는 셸 1급)·심의 모델 미분리(본 하네스가 더 엄격). |
| **GSD (Get Shit Done)** ⭐ | 분석 dstreefkerk.github.io/2026-02-agentic-architecture-playbook-patterns-for-reliable-llm-workflows/ · 원본 github.com/gsd-build/get-shit-done | **State Externalisation**(상태=LLM 밖 파일, 오케스트레이터는 경로·플래그 메타만 읽음) + 결정론 CLI 도구(`state get/patch/advance-plan`, 스키마검증) + **4종 체크포인트**(auto/human-verify/setup/hard-stop) + Auditor가 Planner와 분리. **본 하네스 4대 설계결정을 독립 검증.** | **게이트 타입화** → `approve/revise/select`를 4종으로 분류하면 `run.md`/`next-action.sh` 안내가 명확해짐. **차이/주의:** GSD는 Claude Code 전용+hooks 사용 → 이식성 원칙과 일부 충돌, **패턴만 차용.** |
| **planning-with-files** | github.com/OthmanAdi/planning-with-files | 디스크 마크다운 영속 계획 + 결정론 완료 게이트 + **SHA-256 attestation(계획 변조 잠금)** + **run ledger JSONL append**. | attestation → evidence 1:1 매칭을 *파일 레벨*로 강화. run ledger JSONL ↔ `state.json.history` 감사로그의 구조화판. **차이:** hooks 의존(본 하네스 금지). |
| (경계 밖) BMAD-METHOD · claude-flow | — | 별은 많으나 멀티에이전트 swarm/런타임 오케스트레이션 색채 → "프레임워크 런타임 없이" 기준 밖이라 큐레이션에서 제외. | — |

### 8.2 이론·원전 (왜 이 구조가 정당한가)

| 사례 | URL | 핵심 |
|---|---|---|
| **ICM** (arXiv) | github.com/RinDig/Interpreted-Context-Methdology · arxiv.org/abs/2603.16021 | "폴더 구조=에이전트 아키텍처"를 **arXiv 논문으로 정당화한 유일 사례**(§2 핵심근거 #2). 각 단계 `CONTEXT.md`로 **Inputs/Process/Outputs 계약** 명문화 → `prompts/`에 단계 입출력 계약 헤더 추가 시 차용. |
| **Anthropic — Building Effective Agents** | anthropic.com/research/building-effective-agents | 5대 패턴 원전(§10). 본 파이프라인 = prompt chaining+gate, 생성≠심의 = **evaluator-optimizer를 모델/세션 수준으로 강제**한 형태. |
| **Anthropic — claude-cookbooks/patterns/agents** | github.com/anthropics/anthropic-cookbook/tree/main/patterns/agents | 위 패턴을 프레임워크 없이 순수 호출로 구현한 공식 노트북(`evaluator_optimizer.ipynb` 등). `prompts/`(생성) + `scripts/`(전이) 분리의 검증 근거. |
| **OpenAI — AGENTS.md 가이드** | developers.openai.com/codex/guides/agents-md | "SSoT는 AGENTS.md 하나, 도구별 파일은 복사 말고 *참조*"가 공식 권고 = 본 레포 `CLAUDE.md → @AGENTS.md` import가 정확히 이 베스트프랙티스. 도메인별 하위 nested AGENTS.md로 룰셋 국소 override도 규약상 합법. |

### 8.3 "분기/전이를 코드 밖 선언 데이터로" 끌어낼 때 베껴올 표본

> §5-① 보강(분기 로직이 `scripts/*.sh`에 흩어지는 것)의 구체 참고 표본. 무거운 그래프 프레임워크가 아니라 *가벼운 결정론 오케스트레이터*만 추렸다.

| 사례 | URL | 무엇을 베끼나 |
|---|---|---|
| **Microsoft Conductor** | github.com/microsoft/conductor | 라우팅을 `routes: [{to, when}]` + Jinja **first-match-wins**로 *데이터 선언*, `type: script`로 비-LLM 단계를 한 그래프에, agent별 `model:`로 생성≠심의를 토폴로지에 박제. **개념적 쌍둥이.** (※ Netflix Conductor와 무관.) |
| **Apache Burr** | burr.apache.org | 전이를 **`(from, to, condition)`** 삼요소로, 각 노드가 만지는 상태를 **`@action(reads, writes)` 계약**으로 선언 → "state.json은 scripts만 쓴다"(§1-1)를 **키 단위 reads/writes 계약**으로 정밀화. |
| **PocketFlow** | github.com/The-Pocket/PocketFlow | **100줄** 미니 코어. "오케스트레이션에 무거운 프레임워크 불필요" = `AGENTS.md` §0과 정확히 일치. action 문자열→다음 노드 라벨 매칭 = verdict→다음 스테이지 매핑의 최소판. |
| **Mastra · Genkit (HITL)** | mastra.ai/docs/workflows/human-in-the-loop · genkit.dev/docs/interrupts | `suspend({reason})` / `defineInterrupt({inputSchema})` = "왜 멈췄는지 + 사람이 채울 필드 스키마"를 돌려줌 → `feedback.json`·`run.md "지금 할 일"`을 구조화 강화. |

### 8.4 생성≠심의가 옳다는 *실증* 근거 (본 하네스 강점의 정당화)

| 사례 | URL | 핵심 |
|---|---|---|
| **alexop.dev — Cloudflare 코드리뷰 250줄 재구현** | alexop.dev/posts/ultracode-review-workflow-cloudflare/ | 리뷰어=약한 모델 *생성*, 검증자=강한 모델 *반박*(디폴트=틀림), **건별 격리 검증**(anchoring 제거), `SIGNAL_RULES`로 "flag 하지 말 것"을 명시 = 본 하네스 "근거 없는 효능=금지"(§1-5)와 동일 사상. |
| **Snorkel AI — The Self-Critique Paradox** | snorkel.ai/blog/the-self-critique-paradox-why-ai-verification-fails-where-its-needed-most/ | 같은 모델 자가비판 시 정확도 **98.1%→56.9% 붕괴**(없는 결함을 발명). 다른 모델 패밀리를 judge로 권고 → `KCIA_CRITIC_CMD≠HARNESS_CLI`(§1-4)는 취향이 아니라 **측정된 실패모드 회피**다. |

### 8.5 결론 — 베껴올 3가지 · 보존할 1가지

세 갈래(동형 구현·선언적 오케스트레이터·생성≠심의 실증)의 독립 큐레이션이 **같은 3개 미세조정**으로 수렴한다. 셋 다 plain-text·이식성 원칙을 깨지 않는다.

1. **분기/전이/모델배정을 셸 코드 밖 *선언 데이터*로** (Conductor `routes/when` · Burr `(from, to, condition)`) — §5-①의 구체 표본. 단 `00g` 조건부 실행(예시 존재 여부 게이트)은 도메인 라우팅과 **별개 메커니즘**임을 유지.
2. **사람 게이트의 타입화**(auto / human-verify / setup / hard-stop) (GSD) — `state.json` 게이트 타입 필드 한 칸 + scripts 분기로 충분.
3. **적대 검증의 "건별 격리 + 디폴트=틀림" + 멈춤 사유 페이로드** (Cloudflare · Mastra · Genkit) — 각 효능 주장을 독립 평가, `feedback.json`에 "왜 멈췄나 + 채울 필드 스키마" 동봉.

> **보존할 강점(차용 아님):** 생성≠심의 *물리 격리*(다른 CLI/프로세스)는 위 어떤 사례보다 본 하네스가 강하다(Conductor·GSD조차 같은 런타임 내 모델지정에 그친다). Snorkel 데이터가 그 가치를 실증한다 — **유지·강조** 대상이다.

---

## 9. 미해결 질문

검증으로도 정답이 안 나온, 또는 직접 벤치마크가 없는 질문들이다.

1. **임계점 자체(=세 신호)는 §6에서 정의했다.** 미해결로 남는 것은 그 임계점에 도달했을 때의 **점진 전환 경로·마이그레이션 절차**다: 파일기반→프로그래밍 오케스트레이터로 plain-text 자산(state.json·산출물)을 어떻게 무중단·무손실로 옮기며, 어느 단계부터 부분 이식하는가? (문헌에 검증된 절차 없음.)
2. 생성≠심의를 위해 **CLI 분리(`KCIA_CRITIC_CMD≠HARNESS_CLI`) vs Conductor 에이전트별 모델격리 vs Claude Code 스크립트 내 모델라우팅** 중 무엇이 더 견고한가(self-grading 방지·비용·운영)? 직접 벤치마크 부재.
3. **Temporal은 durable execution·장애복구에서 LangGraph checkpointer와 어떻게 다르며**, 콘텐츠 파이프라인에 언제 더 적합한가? (confirmed claim에 미등장.)
4. 파일기반 traceability 보강에서, **이미 존재하는 감사로그**(`state.json.history`: ts/phase/event/by/actor + git 이력)에 **verdict 역참조(§5-②)** 까지 더하면 plain-text 원칙을 지키며 추적성이 **충분한가**, 아니면 결국 별도 로깅 인프라가 필요한가? (감사로그는 이미 존재하므로 질문은 '구축 여부'가 아니라 '충분성'이다.)

---

## 10. 출처

> 1차(primary) 출처 우선. 모든 핵심 주장은 아래 6개 1차 출처에 묶여 있다. 외부 출처의 verbatim·arXiv ID·URL 실재성은 본 ADR의 레포 대조 범위 밖이며, 별도 WebFetch 검증을 권고한다(특히 arXiv 2603.16021 은 미래 날짜 형식 ID라 재확인 가치 있음).

| 라벨 | URL | 품질 |
|---|---|---|
| Anthropic — Building Effective Agents (workflow vs agent 정의, routing/prompt-chaining, 프레임워크 경고) | https://www.anthropic.com/research/building-effective-agents | primary |
| Interpretable Context Methodology (Van Clief & McDermott, 2026.3) — 파일시스템=오케스트레이션, 약점 자기고백 | https://arxiv.org/abs/2603.16021 | primary |
| Microsoft Conductor (2026.5) — YAML 선언적·결정론 라우팅, 에이전트별 모델격리 | https://opensource.microsoft.com/blog/2026/05/14/conductor-deterministic-orchestration-for-multi-agent-ai-workflows/ | primary |
| Claude Code Workflows 공식문서 — dynamic workflows, 적대적 교차검증 | https://code.claude.com/docs/en/workflows | primary |
| LangChain — LangGraph durable execution/persistence(checkpointer/stores) | https://docs.langchain.com/oss/python/langgraph/durable-execution | primary |
| LangChain — interrupt() 기반 HITL | https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt | primary |

> **검증 방법론(요약):** 본 ADR의 근거는 `/deep-research` 하네스로 수집·검증됐다(6각도 딥리서치 → 다수 소스 fetch → 주장 추출 → 상위 25개 3표 적대검증[2/3 기각 규칙] → 22 확정/3 기각). 본 문서 자체는 `author-orchestration-adr` 워크플로우(초안 → 적대검증 3렌즈 → 수정)로 작성됐으며, §4의 기각 3건과 caveats 는 그 적대검증 산물이다. 레포 대조 검증 결과 본 ADR의 레포 경로·기능 참조는 정확함을 확인했다.
