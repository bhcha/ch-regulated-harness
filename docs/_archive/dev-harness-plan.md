# 개발 하네스 제도화 계획 — dev-loop 스킬 중앙화 (스킬 = 메커니즘+상태 · 레포 = 최소 정책)

> **지위**: **완료(2026-07-26) · 아카이브**. 2~7단계 전부 실행하고 단계마다 Codex 리뷰를 critical/high 0 이 될 때까지 반복했다(12 라운드 · 37 건 수정 · 마지막 3 라운드 findings 0). 산출물 — 스킬 `SKILL.md`(899행 전면 개정) · `REVIEW.md`(초판) · `STALL-LOG.d/`(항목당 1파일) · 중앙 `state/<repo-slug>/` 규약. 4단계는 무작업 확인, 7단계는 개정 2 로 소멸. 기존 산란물 삭제와 이 문서의 아카이브 이동은 사람 승인 후 같은 날 수행. **미완 항목**: SKILL.md 의 "First-run verification" 6 개(첫 실루프에서 확정) 및 그에 딸린 4단계 1번(표 A `AGENTS.md` 채널).
> **작성**: 2026-07-25 · 같은 날 Bun Zig→Rust 포팅 사례 심층 조사 반영(아래 "실전 참고"). **실행 전제**: 이 문서만 읽고 **별도 세션**에서 실행 가능하도록 자기완결로 쓴다.
> **개정**: 2026-07-26 — dev-loop 스킬·Codex 리뷰 경로를 이 머신에서 실측 검증하고 반영(아래 "리서치 근거 3"). 1단계 조사 완료, 열린 질문 2 해소, "다중 레포 동시 실행" 절 신설, 열린 질문 5 신설.
> **개정 2**: 2026-07-26 — **구조 전환(사람 결정)**: 상태를 레포 `meta/loops/` 가 아니라 **스킬 중앙 `state/<repo-slug>/`** 에서 레포별로 관리한다. 근거 — dev-loop 는 전역 스킬이고 4개 레포에서 동시에 도는데, 레포마다 `meta/` 를 신설하는 것보다 스킬이 상태를 중앙 관리하면 레포 쪽 사전 작업이 0 이 된다(선례: Claude Code `~/.claude/projects/<슬러그>/` · Codex 플러그인 `state/<repo>-<hash>/`). 이에 따라 열린 질문 1 소멸·3 해소, 목표 구조·공존 규칙·2~7단계·검증 재작성. 세부 결정 둘 다 사람 확정: ① 상태 위치 = 스킬 폴더 안 `state/`(재설치 시 보존 규칙 필수) ② 이력 = 중앙 보관만(레포 git 에 아무것도 남기지 않음).
> **개정 3**: 2026-07-26 — **리뷰 폴백 등급 변경(사람 결정)**: Codex 두 표 연속 실패·쿼터 소진 시에도 Claude 다표 격리 리뷰로 내려가지 않고 **폴백도 Codex 고정**(재시도 · 쿼터 해제 대기). 3단계 폴백 사다리·리서치 근거 3 쿼터 조항·열린 질문 2에 반영. `review_degraded` 최후 수단은 유지.
> **개정 4**: 2026-07-26 — **2단계 축소(사람 결정)**: 기존 산란물·STALL-LOG 이력을 이관하지 않는다. 새 중앙 구조는 빈 상태로 시작해 신규 루프부터 쌓는다. 기존 파일은 죽은 파일로 두고 삭제는 별도 확인 후 1회 정리. 2단계·6단계·검증 조항 갱신.
> **개정 5**: 2026-07-26 — **열린 질문 4 해소(사람 결정)**: 동적 워크플로는 **병행** — 기본은 스킬, 한 스테이지의 독립 작업 단위가 10개 이상일 때만 그 스테이지를 동적 워크플로로 fan-out. 1단계 갈래 2·3단계·검증에 반영. 이로써 열린 질문 전부 닫힘.
> **형제 계획**: [`gate-hardening-plan.md`](../plans/gate-hardening-plan.md) — 그 계획의 1단계(머지 게이트)가 이 계획 5단계의 전제다. 또한 그 계획의 "Codex 흔적 제거"는 **런 하네스(core/) 기능에 한정**되며, 개발 하네스의 리뷰 벤더 선택은 이 계획의 열린 질문 2다.

## 배경 (무엇이 문제인가)

이 레포에는 이미 하네스가 **두 개** 공존한다:

1. **런 하네스**(`core/` — 공식): 규제 제품 홍보물을 `runs/<id>/state.json` + 셸 게이트로 생성하는 운영 파이프라인.
2. **개발 하네스**(dev-loop — 비공식): 하네스 코드베이스 자체를 고치는 plan→implement→review 루프. **레포 루트에 산란해 있다** — `.dev-loop-state.json`(request→waves→stage_status→review_rounds→final 구조의 사실상 state.json; `invariants` 필드에 "core diff 0 · state.json 불가침" 같은 경계 선언까지 포함), `.dev-loop-w2/`(리뷰 로그·디프·프롬프트 스크래치), `codex-review.log`. 셋 다 **추적도 gitignore 도 안 된 채** 루트 네임스페이스를 오염 중. 같은 산란이 이 레포만이 아니라 dev-loop 가 도는 모든 레포(chatbot-ui · new_psi · space-widget)와 심지어 **스킬 폴더 자신**(`~/.claude/skills/dev-loop/.dev-loop-state.json` — 2026-07-02 자 stray)에서 재현된다. 문제의 뿌리는 "상태가 cwd 를 따라간다"는 스킬 설계다.

필요한 것은 신설이 아니라 **제도화**: 이미 있는 개발 하네스에 자리(중앙 상태 폴더)·헌법(지침)·게이트(머지)를 주는 것. 자리는 레포가 아니라 **스킬이 소유한다**(개정 2).

## 리서치 근거 1 — 구조 패턴 (2026-07 조사 · 출처 요약)

- **같은 레포, 별도 네임스페이스가 표준** — Rust cargo-xtask: 개발 자동화를 같은 workspace 의 별도 패키지 `xtask/` 로(결합이 문제 되면 별도 workspace 로 격리 한 단계 상향하는 다이얼 제공). Nx: `tools/` 밑 독립 프로젝트 관례 공식 문서화. Bazel: `//tools` 관례. (github.com/matklad/cargo-xtask · nx.dev/docs/extending-nx/organization-specific-plugin)
- **여러 레포를 상대하는 전역 도구의 상태는 프로젝트별 중앙 데이터 폴더가 표준** — Claude Code: 세션 상태를 `~/.claude/projects/<경로-슬러그>/` 로 중앙 관리. Codex 플러그인: `~/.claude/plugins/data/codex-openai-codex/state/<repo>-<hash>/`(이 머신에서 가동 중 — dev-loop SKILL.md 가 이미 이 경로를 소비). 같은 레포 안 별도 네임스페이스(xtask·tools) 패턴은 **레포 전용 도구**용이다. 개정 2의 선례 근거.
- **디렉터리별 에이전트 지침은 스펙 차원 공식 메커니즘** — agents.md 표준: "가장 가까운 AGENTS.md 우선", 모노레포 중첩 공식 권고. Claude Code: 서브디렉터리 CLAUDE.md 는 그 영역 파일을 읽을 때 on-demand 로드, 디렉터리 스코프 스킬(`paths`), 시작 디렉터리가 로드 스코프 결정. (agents.md · code.claude.com/docs/en/memory · /large-codebases)
- **메타 계층(자기 자신을 고치는 자동화)에는 별도 권한 경계** — GitHub 은 워크플로 파일을 예약 디렉터리에 격리하고 `GITHUB_TOKEN` 으로는 워크플로 자신을 수정 불가(자기수정 재귀 차단). (docs.github.com/en/actions)
- **자기수정 도구는 known-good 기준으로** — 컴파일러 부트스트랩: 개발 도구가 수정 대상 코드(공용 lib)에 런타임 의존하면 수정 도중 자기가 깨진다. 의존을 끊거나 검증된 버전에 고정. (bootstrappable.org/best-practices)
- **실사례** — openai/codex 루트 AGENTS.md = "codex 를 개발하는" 지침(제품 사용 지침과 별개) · cline `.clinerules/` · anthropics/claude-agent-sdk-python 루트 CLAUDE.md = 순수 개발 워크플로 지침.

## 리서치 근거 2 — 실전 참고: Bun Zig→Rust 포팅 (2026-05 · bun.com/blog/bun-in-rust)

Zig 53.5만 줄 → Rust 전면 포팅을 **1명 엔지니어 + 11일 + 최대 64개 Claude 병렬**(4 워크트리 × 16 루프, 약 50개 동적 워크플로)로 완주한 사례. 전 플랫폼 테스트 100% green 후 사람이 머지(테스트 스킵 삭제 0건). 우리 개발 하네스와 같은 문제(코드베이스를 고치는 에이전트 루프의 게이트·규율·상태 관리)의 대규모 실증이라 심층 참고한다.

**실물 산출물(전부 열람 가능 — git 히스토리 포함):**

| 산출물 | 위치 |
|---|---|
| 본 PR(+1,009,257/−4,024) | github.com/oven-sh/bun/pull/30412 |
| PORTING.md(756줄 · Zig→Rust 규칙 18섹션) · LIFETIMES.tsv(2,253행 · 필드별 소유권 11분류+근거) | 히스토리 커밋 `eeb4d9fdf6e9` 의 `docs/` (머지 직전 정리 커밋 `10cfa0b237f8` 으로 브랜치에서 삭제 — **git 히스토리가 보존소**) |
| 동적 워크플로 54개(`.claude/workflows/*.workflow.js`) + 헬퍼 19종 | 머지 커밋 `23427dbc12fd` 트리(10분 뒤 `19d8ade2c6` 으로 삭제) |
| CLAUDE.md(AGENTS.md 는 symlink) · REVIEW.md(**머지 PR 약 2,500건의 리뷰 이력에서 증류한 리뷰 기준서**) · `.claude/`(PreToolUse/PostToolUse 훅·스킬 8종) | main 현존 |

**하네스 구조 요약**(복원한 `phase-g-mega-swarm.workflow.js` 등에서 확인):
- 루프 = 라운드마다 `Build(오케스트레이터/데몬 1회) → Survey(전 테스트 병렬 프로브) → Fix(실패당 에이전트 1) → Review(2표) → Apply(교정 반영) → push`.
- **리뷰 2표 합의제**: 리뷰어 2명이 각각 diff(`git show <commit>`)+진단만 받고(구현 의도 미제공) "왜 틀렸을지"를 찾는다. **둘 다 accept + 신규 unsafe 0 이어야 통과**, 교정은 dedupe 후 제3 에이전트가 적용. 규칙 문서 자체(PORTING.md)도 별도 워크플로(8차원 감사 + 3표 반박)로 검증.
- **리워드 해킹 = 명시 거부 카테고리**: "정당화 주석 금지(한 문단짜리 SAFETY/PORT NOTE 에세이가 필요하면 코드가 잘못된 것)" — 리뷰어가 grep 으로 탐지해 `severity:"reward-hack"` 으로 거부. stub 채우기·테스트 스킵도 같은 부류(스킵 삭제 0건을 지표로 추적).
- **기준선 divergence triage**: 기준선(system bun) 결과를 캐시하고 **기준선 대비 갈라진 것만 버그**로 큐에 넣는다(기준선도 실패=환경 문제로 분류·제외). 에이전트에게 "버그 아님" 탈출로(`triaged-slow` 등재, 커밋 금지) 를 명시적으로 제공해 억지 수정을 방지.
- **병렬 git 규율(HARD 블록 원문)**: "Never git reset/checkout/stash/rebase/pull · 커밋은 **본인이 수정한 명시 경로만** add · push 금지 · `--allow-empty` 금지 · 커밋 메시지 80자 이하, 분석 에세이 금지". 빌드/테스트 같은 느린 명령은 에이전트 금지 — **비싼 연산은 오케스트레이터가 라운드당 1회 소유**. apply 단계는 flock 으로 직렬화.
- **상태 = 파일 스코어보드**: `passing.txt`(누적, 재조사 안 함)·`triaged-slow.txt`·`failing-rN.txt`·`results-rN.txt` + git 커밋 자체가 원장. 라운드마다 push(내구성).
- **사람 역할**: 사전 3시간(규칙 문서 공동 작성+검증) → **trial run 3파일 수동 검토 후 확장 승인** → 매일 출력 읽고 프롬프트/규칙 편집(예: stub 채우기 감지 → 리뷰어 규칙 강화) → 최종 머지 버튼. 러너(워크플로 실행 엔진)는 Claude Code 의 동적 워크플로 기능으로 미공개.

**우리 대비 함의**: dev-loop 가 이미 하는 것(웨이브·다라운드 리뷰·수렴 판정)은 방향이 맞고, 없는 것은 ① 규칙 문서 자체의 적대 감사, ② 파일럿 게이트(소량 시범→사람 go→확장), ③ 리워드 해킹 명시 거부 카테고리, ④ 기준선 triage 와 "버그 아님" 탈출로, ⑤ 병렬 git 규율의 헌법화, ⑥ 리뷰 이력의 상설 기준서 증류(REVIEW.md 패턴)다. 아래 단계에 반영.

## 리서치 근거 3 — Codex 리뷰 경로 실측·근본원인 (2026-07-26 · 이 머신에서 검증)

개발 하네스의 리뷰 게이트를 손대기 전에 현행 Codex 리뷰의 한계를 실측했다. 결론: **한계는 실재하지만 Codex 모델의 문제가 아니라 Claude Code 용 플러그인의 결함이며, 우회 가능하다.** 따라서 Codex 를 끊을 이유가 없다.

**실측(리뷰 job 110건)**: 소요 p50 6.4분 · p90 12.3분 · 최대 220분(3.6h 행). 종료 상태 completed 89 · running 고아 14 · failed 5 · cancelled 2 → **실질 성공률 81%**.

**행의 근본원인**: 플러그인의 `scripts/lib/app-server.mjs:157` `handleServerRequest()` 가 서버가 보낸 **모든** 요청을 `-32601 Unsupported server request` 로 거부한다. app-server 가 `codex_apps/*` 툴 호출 승인(elicitation)을 요청하면 응답이 없어 영구 대기하고, 로그가 `Calling codex_apps/X.` 에서 멈춘다. 업스트림 openai/codex-plugin-cc#258 로 등록돼 있고 **v1.0.6 에도 미수정**. `tool_timeout_sec`(기본 60초)로 막히지 않는다 — 툴 호출이 시작조차 안 되고 승인 왕복에서 멈추기 때문.

- **context7 특정 문제가 아니다**: 고아 14건 중 3건이 `codex_apps` 호출에서 정지했고 그중 **2건이 `naverserch_search_webkr`** 다. 위험 단위는 `codex_apps` 툴 클래스 전체다. 지금까지 "context7 을 피한다"는 대응은 원인을 잘못 짚고 있었다.
- **별개 행 클래스 하나 더**: 사용자 `~/.codex/config.toml` 의 `mcp_servers.openaiDeveloperDocs`·`node_repl` 는 고전적 MCP 서버라 `--disable apps` 로 사라지지 않는다 → `-c mcp_servers={}` 도 함께 필요.
- 관련 상위 버그: codex#25061(`resources/list` 프로브가 타임아웃 없이 블록) · #24397 · #20167.

**속도 원인**: 전역 config 가 `model_reasoning_effort = "xhigh"` 이고, companion 의 `review` 명령에는 `--effort` 가 없으며(`task` 에만 있음) `app-server.mjs:188` 이 `spawn("codex", ["app-server"])` 로 설정 오버라이드를 하나도 넘기지 않는다 → **모든 리뷰가 xhigh 고정이고 그 경로로는 낮출 수 없다**. 독립 근거: gstack `codex` 스킬은 *"xhigh 는 high 보다 토큰 ~23배, 큰 컨텍스트에서 50분 이상 행"*(OpenAI #8545·#8402·#6931)을 이유로 이미 high 를 기본값으로 쓴다. → **결정: dev-loop 리뷰는 `high` 고정**, 전역 config 는 건드리지 않고 호출마다 전달.

**플러그인 v1.0.1 → v1.0.6 업데이트(2026-07-26 완료)**. 고쳐진 것: ENOBUFS(`git.mjs` 가 `maxBuffer` + inline diff 캡 도입 — 2026-07-25 스톨) · cancel/resume 의 세션 스코핑(다중 레포 오진 감소). **안 고쳐진 것**: elicitation 행 · `core.quotePath` 누락(비ASCII untracked 경로 ENOENT 대응은 계속 필요).

**우회 경로 = 원시 CLI.** `codex exec review` 가 리뷰 대상 지정과 exec 플래그를 겸한다(플래그 실측):

- 있는 것: `--commit/--base/--uncommitted` · `-m` · `-c` 임의 키 · `--disable/--enable` · `--output-schema` · `-o` · `--json` · `--ephemeral` · `--ignore-user-config` · `--skip-git-repo-check`
- 없는 것: `-s/--sandbox` · `-C/--cd` · `-p/--profile` · **타임아웃 옵션(세 경로 모두 없음)**
- 검증된 설정 키: `approval_policy`(`untrusted|on-failure|on-request|granular|never`) · `sandbox_mode`(`read-only|workspace-write|danger-full-access`). `approval_policy=never` 면 승인 필요 동작이 블록이 아니라 **거부**되므로 승인 대기 행이 설정으로 닫힌다. 주의 — `model_reasoning_effort` 는 값 검증을 하지 않아 오타가 **서버 400** 이 된다.
- `-c features.apps=false` / `--disable apps` 는 `~/.codex/config.toml` 을 오염시키지 않는다(검증).
- 리뷰 모드에는 **네이티브 findings 스키마**가 내장돼 있다(`findings[].title/body/confidence_score/priority/code_location` + `overall_correctness/overall_explanation/overall_confidence_score`).

**argv 배타 제약 — 설계를 규정하는 사실**: `--commit` · `--base` · `--uncommitted` · `PROMPT` 는 **정확히 하나만 골라야 하는 배타 집합**이다(`-` stdin 형태도 PROMPT 로 취급). 즉 커스텀 렌즈 프롬프트와 기계적 디프 스코핑은 한 호출에 공존할 수 없다. gstack 도 같은 제약에 부딪혀 `--base` 를 버리고 스코프를 프롬프트 산문에 넣었다.

**→ 결론: 비대칭 2표.** 배타 제약이 강제하는 구성이다.

| | 표 A | 표 B |
|---|---|---|
| 대상 | `--commit <sha>` — 기계적 보장 | 프롬프트 산문(`git show <sha>` 지시) |
| 리뷰 프롬프트 | codex 네이티브 튜닝 | 우리 렌즈(reward-hack · 양방향 대칭 · 파일시스템 경계 · 마커) |
| 구조화 | 네이티브 findings 스키마 | `--output-schema` 강제 |
| 다양성 축 | — | 절차 + 렌즈 + 모델(`-m`) |

- 격리는 **별개 프로세스라는 사실**에서 나온다. `--ephemeral` 은 영속성 전용이라 격리에 기여하지 않고 rollout 감사 추적과 `exec resume` 만 잃으므로 쓰지 않는다.
- 합의는 **findings 합집합**으로 판정한다 — 한 표만 올린 high 도 triage 에 들어가고, 2표 요구는 게이트 통과에만 적용한다. 한 표가 행이고 한 표가 clean 이면 `review_votes_counted: 1` 로 기록하고 통과시킨다(never-block 원칙이 2표 순수성보다 우선).
- 쿼터 소진은 **행과 별개 클래스**다: kill·재시도 금지, `codex_quota_blocked_until` 기록 후 해제 시각까지 리뷰를 대기시킨다(재발사는 쿼터를 확정적으로 더 태운다 — 개정 3에 따라 타 벤더 폴백 없이 Codex 재개를 기다린다). 바이너리에 시그니처 존재(`rate_limit_reached`·`usage_limit_reached`·`credits_depleted`).
- 표 A 는 프롬프트를 못 받으므로 파일시스템 경계·reward-hack 지시를 실을 수 없다. 대안 채널은 **레포의 `AGENTS.md`**(`--ignore-rules` 플래그가 있다는 것은 기본적으로 rules 파일을 읽는다는 뜻 — 첫 런 확인 대상). 전달이 확인되면 대상 레포 루트 `AGENTS.md` 에 한 절을 추가해 싣는다(4단계).

**gstack 에서 차용**(집안의 실전 자산 — 새로 발명하지 않는다): `_gstack_codex_timeout_wrapper`(gtimeout→timeout→미랩; 이 머신에 둘 다 설치됨) · **exit 124 를 다른 비영 종료와 별도 분류**(gstack #1327: "출력 없음"을 조용한 API 스톨로 오독해 30~60분 오진하는 것을 막기 위함 — dev-loop 가 반복해서 당한 실패) · 비영 종료 stderr 표면화 · auth 다중신호 프로브 · 불량 버전 거부목록 · 타임아웃 시 학습 자동 기록 · **파일시스템 경계 프리픽스**(`~/.claude/`·`.claude/skills/` 를 읽지 말라 — gstack 은 이 회귀를 두 번 겪었다 #1503·#1522) · DIFF_START/DIFF_END 인젝션 방어 · 매 호출 `cd $(git rev-parse --show-toplevel)` · 프롬프트 내 마커(`-c` 마커와 달리 rollout JSONL 에 남아 복구 가능).

**차용 제외**: `--enable web_search_cached`(툴 호출 경로 제거가 우리 행 대책의 핵심이라 정면 충돌) · gstack 의 330초 값(Bash 300초 캡에 맞춘 수치이고 우리는 백그라운드라 무관 — 실측 후 정한다).

## 목표 구조

두 하네스는 **기질(substrate)이 다르다** — 이 대응이 설계의 축:

| | 런 하네스 (`core/`) | 개발 하네스 (dev-loop 스킬) |
|---|---|---|
| 작업 기질 | `runs/<id>/` 파일 | git 브랜치·워킹트리 |
| 상태 | `runs/<id>/state.json` | 스킬 중앙 `state/<repo-slug>/loops/<loop-id>/`(상태+스코어보드; 현 `.dev-loop-state.json`) |
| 산출물 | 단계 산출물 파일 | 커밋·디프·PR |
| 결정적 게이트 | validate-stage·gate.sh·advance-phase | `core/tests/run-ci.sh` + 머지 게이트 · 기준선 divergence triage |
| 사람 게이트 | approve / select | 파일럿 go · PR 리뷰·머지 승인 |
| 심의(격리 리뷰) | 원격 ADK(Gemini) | Codex 비대칭 2표 격리 합의(`codex exec review` — 리서치 근거 3) |

```
~/.claude/skills/dev-loop/            # 개발 하네스의 집 (스킬 = 메커니즘 + 정책 기본값 + 상태)
  SKILL.md                            #   SSoT — 루프 메커니즘·병렬 규율·리뷰 게이트 (3단계에서 개정)
  REVIEW.md                           #   리뷰 기준서 (6단계에서 증류 — Bun REVIEW.md 패턴, 전 레포 공통)
  STALL-LOG.d/<날짜>-<슬러그>.md       #   스톨 원장 (항목당 1파일 — 현 STALL-LOG.md 에서 전환)
  state/<repo-slug>/                  #   레포별 상태 (슬러그 = git rev-parse --show-toplevel 경로)
    config.json                       #     레포별 정책: pilot · review_votes · review_effort · invariants
    watchdog.pid · resume.log         #     5시간 워치독 (현 <repo>/.dev-loop-watchdog.pid 등을 대체 — 신규 생성분부터)
    loops/<loop-id>/                  #     루프별 state.json · 스코어보드 · scratch/ · 리뷰 로그

<대상 레포>/                           # 레포에 남는 것 = 0 (선택 2가지만)
  AGENTS.md                           #   (선택) 표 A 채널 절 — 첫 런 검증 5 통과 시 (4단계)
  (머지 게이트)                        #   ch-regulated-harness: 형제 계획 1단계 (5단계)
```

- **재설치 보존 규칙**: 스킬 업데이트·재설치·동기화는 `SKILL.md`·`REVIEW.md` 만 교체하고 `state/`·`STALL-LOG.d/` 는 건드리지 않는다. 이 규칙 자체를 SKILL.md 에 명문화한다(스킬 폴더 안에 상태를 두는 대가).
- **슬러그 규칙**: `git rev-parse --show-toplevel` 절대경로의 비영숫자를 `-` 로 치환(Claude Code `~/.claude/projects/` 와 같은 인코딩 — 사람이 읽을 수 있고, 워크트리는 경로가 다르므로 자동 분리).

## 공존 규칙 (SKILL.md 에 명문화할 다섯 가지)

1. **상태 물리 분리**: 개발 하네스의 상태는 전부 스킬 중앙 `state/<repo-slug>/` 에 있고, **대상 레포의 워킹트리에는 상태 파일을 하나도 만들지 않는다**(레포에 남는 diff = 작업 그 자체뿐). 런 상태(`core/runs/**`)는 읽을 수는 있어도 쓰지 않는다.
2. **모드는 사람이 진입점으로 선언**: 세션 성격(운영/개발)을 AI 가 추측하지 않는다 — 런 운영 = `bash core/scripts/run-stage.sh …`, 개발 = `/dev-loop`. 도메인 선언을 사람이 하는 기존 원칙(AGENTS 규칙 8번 절)의 확장.
3. **SSoT 스코핑**: 개발 하네스의 SSoT 는 스킬 `SKILL.md`(+`REVIEW.md`), 대상 레포의 SSoT(예: `core/AGENTS.md`)는 그 레포 제품의 규칙이다. **무엇이 올바른 코드인가**는 레포 SSoT 가, **루프를 어떻게 돌리는가**는 스킬 SSoT 가 답한다. 충돌 시 작업 대상의 SSoT 우선.
4. **커널 공유 금지(known-good 원칙)**: 스킬은 대상 레포의 라이브러리를 import 하지 않는다(개발 하네스의 본업이 그 코드 수정이라, 공유하면 수정 도중 자기가 깨진다). 스킬 폴더는 자기완결 — 필요한 유틸은 복제.
5. **메타 계층 권한 = 머지 게이트**: 개발 하네스가 대상 레포의 게이트 스크립트·동결 스키마를 고치는 행위는 일반 편집과 다른 등급의 관문(PR + CI 필수 통과)을 지난다. 세션-내 훅으로 막지 않는다(운영/개발 모드 구분 문제를 훅에 끌어들이지 않음 — 형제 계획 3단계와 합의된 분담).

## 다중 레포 동시 실행 (전역 스킬의 제약)

dev-loop 스킬은 **전역**(`~/.claude/skills/dev-loop/`)이고 실제로 여러 레포에서 동시에 돈다(확인: ch-regulated-harness · chatbot-ui 63KB · new_psi 25KB · space-widget 에 각자 `.dev-loop-state.json`). 개정 2에 따라 구분은 **스킬 = 메커니즘+상태 / 레포별 정책 = 중앙 `state/<repo-slug>/config.json`** 이다. 스킬 본문에 특정 레포 이름·경로를 박지 않는다.

1. **루프 폴더 해석 규칙**: 항상 스킬 중앙 `state/<repo-slug>/` — 슬러그가 `git rev-parse --show-toplevel` 경로에서 기계적으로 나오므로 해석 분기가 없고 워크트리도 자동 분리된다. 레포별 정책은 같은 폴더의 `config.json`(키: `pilot` · `review_votes` · `review_vendor` · `review_effort` · `invariants`). 레포 안 `.dev-loop/config.json` 과 `loop_dir` 키는 불필요해져 폐기.
2. **브로커는 레포별**이다(검증: `state/<repo>-<hash>/broker.json` 마다 pid·유닉스 소켓이 상이. 동시 생존 2개 관측). 다른 레포끼리는 이미 격리돼 있으므로 진짜 위험은 "브로커 공유"가 아니라 `pkill -f codex` 가 **모든 레포의 브로커·app-server 를 함께 잡는 것**이다. 금지는 유지하고 근거를 수정한다. 같은 레포 두 세션은 실제로 브로커를 공유하므로 `broker.json` 삭제-재기동은 그때만 경쟁이 된다.
3. **소유권 확인 후에만 kill**: 3요소 — 생존(`kill -0`) + argv 에 이 표의 `-o` 경로 포함 + `lstart` 바이트 일치. 취소된 job 의 래퍼 pid 가 몇 분간 살아남고 **다른 세션 소유**인 사례를 실측했다. `-o $VOTE_DIR/verdict.json` 경로가 전역 고유 argv 마커 역할을 하므로 별도 마커가 필요 없다(`-c` 마커는 rollout·이벤트 어디에도 안 남는 쓰기 전용이고, 향후 config 검증이 조여지면 전 dispatch 가 깨지므로 기각). 전역 프로세스 스캔은 하지 않는다 — `ps` 는 단일 pid 확인에만 쓴다.
4. **STALL-LOG 경쟁 조건**: 전역 1개 파일 + "최신을 맨 위로" = read-modify-write 이므로 두 루프가 동시에 스톨을 기록하면 하나가 유실된다. 항목당 1파일(`STALL-LOG.d/<날짜>-<슬러그>.md`, 생성 전용)로 바꾼다. **잠금은 쓰지 않는다 — 필요가 없기 때문**이다(항목 분리로 각 쓰기가 독립). 스톨 기록은 하필 상황이 나쁠 때 일어나므로, 잠금을 올바로 잡는 설계보다 애초에 막히거나 유실될 수 없는 설계가 낫다. ~~macOS 에 `flock(1)` 이 없다~~ → **정정(2026-07-26 실측)**: 없는 것은 GNU `flock(1)` 뿐이고 macOS 는 `/usr/bin/lockf`(flock(2) 기반 · `-t` 타임아웃 · 홀더가 SIGKILL 돼도 커널이 해제)와 `/usr/bin/shlock` 을 기본 제공한다. Bun 의 flock 직렬화를 베낄 때 `flock(1)` 을 그대로 쓰면 실패하지만, 공유 파일을 정말 고쳐야 하는 곳(스킬 `REVIEW.md` 승격)에서는 `lockf` 가 정답이고 손수 만든 `mkdir` 락은 쓰지 않는다(TOCTOU).
5. **워치독 동시 발사**: 레포마다 워치독이 뜨면 리밋 해제 순간 N개가 동시에 `claude -c` 를 쏜다. 통합 대신 결정적 stagger: `reset + 120 + (cksum(repo) mod 600)`. `claude -c` 는 이미 cwd 별이라 오귀속 위험은 없고 동시 발사만 문제다.
6. **동시 리뷰 상한**: 레포당 2(하드), 전역 3~4(최선노력 — `active-reviews.d/<pid>-<repohash>` 파일 존재 개수로 계수, 잠금 없음, 죽은 pid 는 무시). 실측 최대 동시 브로커가 2였으므로 전역 상한은 보류하고 레포당 상한만 먼저 넣어도 된다.

## 1단계 — 루프 엔진 조사 (2026-07-26 완료)

**갈래 1 — dev-loop 스킬 경로: 판정 = 설정 가능.** 상태 경로가 스킬에 박혀 있긴 하지만 `SKILL.md:220` 의 **산문 한 줄**(`<repo>/.dev-loop-state.json`)이 전부다. 코드가 아니라 지시문이므로 한 번의 편집으로 바뀐다. 따라서 gitignore 차선책은 불필요하고, 래퍼 우회도 필요 없다. 단 스킬은 **전역**이고 여러 레포에서 동시에 도는 것이 확인됐으므로 특정 레포 경로를 못 박지 않는다 — 개정 2에 따라 목적지는 스킬 중앙 `state/<repo-slug>/` 로 고정(위 "다중 레포 동시 실행" 1번).

**갈래 2 — 동적 워크플로: 해소(2026-07-26 개정 5 · 사람 결정) = 병행.** 상태 경로 문제가 갈래 1로 해소돼 워크플로 채택은 "필수"가 아니라 "스웜형 대량 작업용 선택"이 됐고, 채택 범위는 병행으로 확정(열린 질문 4 참조).

**추가 조사(계획 착수 후 필요해진 것) — 리뷰 엔진**: 리뷰 게이트의 속도·신뢰성 한계를 실측하고 근본원인을 특정했다. 결과는 별도 절(리서치 근거 3)로 분리했고, 그 결론이 열린 질문 2를 해소한다.

2. **Claude Code 동적 워크플로**(신규 선택지 — Bun 의 러너가 바로 이 기능): `<레포>/.claude/workflows/*.workflow.js` 정의 파일(meta·agent()·pipeline()·parallel()·schema 구조화 출력)을 레포에 커밋하고 Claude Code 가 실행. 장점 — 루프 구조가 **레포의 1급 코드**가 되어 리뷰·버전 관리 가능(Bun 은 54개를 커밋), 스킬 의존 제거. 유의 — Claude Code 기능 결합이므로 SKILL.md 에 "동적 워크플로는 개발 하네스 전용, 런 하네스(core)는 불가침(core AGENTS 규칙 3 유지)"을 명시. 워크플로는 상태가 아니라 코드이므로 개정 2(상태 중앙화)와 독립.

판정 기준: 상태 파일 위치 제어 가능성 · 루프 정의의 버전 관리 가능성 · 기존 dev-loop 자산(재개·리뷰 라운드 로직) 재사용성. 병행(스킬로 시작, 대량 병렬 작업만 워크플로)도 허용.

## 2단계 — 스킬 중앙 state/ 신설 (이관 없음 — 개정 4)

**사람 결정(2026-07-26): 기존 산란물·이력을 이관하지 않는다. 새 구조는 빈 상태로 시작해 신규 루프부터 쌓는다.**

1. `state/<repo-slug>/` 는 사전 생성하지 않는다 — 각 레포의 첫 루프가 필요 시점에 생성한다(레포 쪽 사전 작업 0 이라는 개정 2의 이점이 스킬 쪽에도 그대로 적용).
2. 스톨 원장: 신규 항목부터 `STALL-LOG.d/<날짜>-<슬러그>.md` 항목당 1파일(아래 "다중 레포 동시 실행" 4번의 경쟁 조건 해소). 기존 `STALL-LOG.md`(42KB)는 분해하지 않고 읽기 전용 아카이브로 제자리에 둔다(참조는 가능).
3. 루프 이력 보존 정책(열린 질문 3 — **해소**): 중앙 보관만. 레포 git 에는 아무것도 커밋하지 않는다(작업 디프 자체 제외). 오래된 루프 폴더의 정리 주기는 운용하며 정한다.
4. 기존 산란물(4개 레포 루트의 `.dev-loop-state.json`·`.dev-loop-w2/`·`codex-review.log`·워치독 파일, 스킬 폴더 루트의 stray)은 새 구조가 참조하지 않는 죽은 파일이 된다. **삭제는 사람 확인 후 별도 1회 정리로 수행**(이 계획의 실행 범위 밖). `.git/info/exclude` 의 dev-loop 항목 제거도 그 정리에 포함.

## 3단계 — SKILL.md 개정 (메커니즘 + 헌법을 한 문서로)

개정 범위(위 공존 규칙 다섯 가지 + Bun 실증 규율 + 리서치 근거 3 구현 — 이 단계가 이 계획의 본체다):

- **상태 경로 전환**: SKILL.md 의 `<repo>/.dev-loop-state.json`(현 220행 부근) → `state/<repo-slug>/loops/<loop-id>/state.json`. 워치독 pid·resume 로그도 같은 폴더로(`<repo>/.dev-loop-watchdog.pid` 등 폐기). `.git/info/exclude`/gitignore 지시(현 243행 부근)는 삭제 — 레포에 만들 파일이 없다.
- **리뷰 엔진 교체**: 플러그인 companion(`codex-companion.mjs review --background`) 경로를 **원시 `codex exec review` 비대칭 2표**(리서치 근거 3)로 교체 — 표 A `--commit <sha>` + 표 B 프롬프트 렌즈 `--output-schema`, findings 합집합 판정, `approval_policy=never` · `sandbox_mode=read-only` · `-c mcp_servers={}` · effort `high` 고정, gtimeout 래퍼(exit 124 별도 분류), 소유권 3요소 확인 후에만 kill, 쿼터 소진은 행과 별개 클래스(`codex_quota_blocked_until`). 폴백 사다리 재정의(개정 3 · 사람 결정): **폴백도 Codex 고정** — 두 표 연속 실패 시 타임아웃 래퍼로 정리 후 Codex 재시도, 쿼터 소진 시 `codex_quota_blocked_until` 해제까지 리뷰를 대기시킨 뒤 Codex 로 재개(워치독의 리밋 대기와 같은 패턴). Claude 다표 격리 리뷰 폴백은 두지 않는다. Codex 가 장기 불능인 극단 상황에만 기존 `review_degraded` 최후 수단 유지.
- **병렬 작업 규율**(Bun HARD 블록 이식·우리 관례와 병합): 병렬 루프는 워크트리 격리 필수 · `git reset/checkout/stash/rebase/pull` 금지 · **구현 에이전트는 커밋하지 않는다**(열린 질문 5 승인) — 스테이지 커밋은 오케스트레이터가 스테이지 종료 시 그 스테이지의 **명시 경로만** add 해 1커밋(`add .`/디렉터리 add 금지) · push 금지(머지는 사람) · `--allow-empty` 금지 · 커밋 메시지는 무엇이 바뀌었는지만(분석 에세이 금지) · **비싼 연산(전체 CI·빌드)은 오케스트레이터가 라운드당 1회 소유**, 개별 에이전트는 진단 파일에서만 작업.
- **리뷰 규칙**: 리뷰어는 구현 에이전트와 컨텍스트 분리, **diff+진단만 제공(구현 의도 미제공)**, 스탠스는 "왜 틀렸을지 찾아라". 다표 합의(기본 2표 — 전원 accept 여야 통과, 레포별 `config.json` 의 `review_votes` 로 조정), 교정은 dedupe 후 별도 적용 단계. 구체 구현(비대칭 2표 구성·findings 합집합 판정·쿼터 별개 클래스·gstack 차용 목록)은 리서치 근거 3.
- **리워드 해킹 거부 카테고리**(명시): ① 정당화 주석(문단짜리 변명이 필요하면 코드를 고쳐라) ② stub/빈 구현 채우기 ③ 테스트 스킵·약화·삭제(스킵 삭제 카운트 0 을 지표로) ④ 게이트/검증 코드 자체 완화. 리뷰어가 탐지 시 `reward-hack` 등급으로 자동 거부 — 기존 P/T/X triage 에 앞서는 선분류.
- **"버그 아님" 탈출로**: 진단 결과 결함이 아니면(환경·flaky·기준선도 실패) 수정하지 말고 분류 파일에 등재 후 종료 — 억지 수정 방지.
- **스톨 로그 전환**: 단일 `STALL-LOG.md` append 지시 → `STALL-LOG.d/` 항목당 1파일 생성으로(읽기는 디렉터리 전체).
- **REVIEW.md 소비**: 리뷰어 프롬프트(표 B)가 스킬 폴더 `REVIEW.md` 를 읽게 한다(6단계와 연동).
- **다중 레포 규칙 반영**: 동시 리뷰 상한(레포당 2) · 워치독 결정적 stagger(`reset + 120 + (cksum(repo) mod 600)`) · 재설치 보존 규칙("목표 구조" 참조).
- **스웜 문턱 규칙**(열린 질문 4 해소 반영): 한 스테이지의 독립 작업 단위가 10개 이상이면 그 스테이지만 동적 워크플로(대상 레포 `.claude/workflows/*.workflow.js`)로 fan-out, 그 외는 스킬 표준 경로. 동적 워크플로는 개발 하네스 전용 — 런 하네스(core)는 불가침(core AGENTS 규칙 3 유지).
- **사람 개입 지점**: 루프 출력 정기 검토 → 규칙/프롬프트 편집(발견된 우회 패턴은 거부 카테고리로 승격) · 파일럿 go(수명주기) · 머지 버튼.
- 검증 규약: 반복 = 타겟 테스트, 스테이지 커밋 = 프로젝트 전체 게이트(ch-regulated-harness 는 `core/tests/run-ci.sh`; 레포별 게이트 명령은 `config.json` 에).
- dev-loop 상태 파일의 루프별 `invariants`(예: "state.json 불가침·runs/ 불가침") 중 **상설 규칙**은 레포별 `config.json` 의 `invariants` 로 승격.

**루프 수명주기 표준**(SKILL.md 의 한 절 — Bun 의 사람 게이트 배치 이식):

1. **W0 규칙 문서 + 적대 감사**: 루프 착수 전 작업 규칙/계획 문서를 만들고, 실행 전에 그 **문서 자체를 격리 리뷰로 감사**(Bun 은 PORTING.md 를 8차원 감사+3표 반박 워크플로로 검증 후에야 대량 실행).
2. **파일럿 게이트**: 대상 2~3건만 시범 실행 → **사람이 결과 검토 후 go** → 확장(fan-out). 스웜형 작업의 필수 관문.
3. **기준선 triage**: 작업 전 기준선(base 브랜치/known-good 커밋)의 테스트 결과를 캐시하고, **기준선 대비 갈라진 것만** 작업 큐에 넣는다(기준선도 실패 = 환경 문제로 분류·제외).
4. **스코어보드**: `state/<repo-slug>/loops/<id>/` 에 누적 통과 목록(재조사 제외)·라운드별 실패 목록·분류 파일을 파일로 유지, 라운드마다 갱신(내구성·관측성 — 중앙 보관, 레포 커밋 없음).
5. **수렴 판정**: 실패 0 + 미조사 0 일 때만 done(카운트 목표가 아니라 소진 기준).

## 4단계 — 레포 쪽 잔여 작업 (최소·선택)

레포에 새 디렉터리는 만들지 않는다. 남는 것 두 가지:

1. **표 A 채널(선택)**: 첫 런 검증 5(레포 `AGENTS.md` 가 프롬프트 없는 `codex exec review --commit` 호출에 전달되는지)가 확인되면, 대상 레포 루트 `AGENTS.md` 에 리뷰어용 한 절(파일시스템 경계 — `~/.claude/`·`.claude/skills/` 읽기 금지 · reward-hack 거부 카테고리)을 추가한다. 전달이 안 되면 표 A 는 네이티브 그대로 두고 렌즈는 표 B 전담.
2. **ch-regulated-harness 라우팅**: 루트 `CLAUDE.md`/`AGENTS.md` 는 현행(core 위임 한 줄) 유지 — `meta/` 가 없어졌으므로 라우팅 추가·`docs/README.md` 등재(구 D-1)는 불필요. `core/AGENTS.md` 무수정(런 하네스 SSoT 로 유지).

## 5단계 — 머지 게이트 연계 (의존: 형제 계획 1단계)

공존 규칙 5(SKILL.md)를 실체화: 개발 루프의 마무리는 "PR + CI green + 사람 머지"로 정의(직접 main push 는 개발 하네스 경로가 아님). Bun 의 머지 기준(전 플랫폼 테스트 100% + 사람이 버튼)과 같은 형태. 형제 계획 1단계가 미완이면 이 단계는 규율 문구로 먼저 두고, 머지 게이트 가동 시 자동으로 실효성을 얻는다.

## 6단계 — 리뷰 기준 증류 (스킬 폴더 REVIEW.md · 학습 루프)

Bun 의 REVIEW.md(머지 PR 2,500건의 리뷰 이력에서 "리뷰어가 실제로 거부한 것"을 증류한 상설 기준서) 패턴 이식: dev-loop 의 리뷰 라운드 이력(`open_findings`·review 로그 — 개정 4에 따라 신규 루프부터 `state/*/loops/*/` 에 축적; 필요 시 구 산란물·구 `STALL-LOG.md` 를 제자리에서 참조)에서 **반복 지적 유형을 증류해 스킬 폴더 `REVIEW.md` 로 승격**하고, 이후 루프의 리뷰어 프롬프트(표 B)가 이를 읽게 한다. 전 레포 공통 기준은 본문에, 특정 레포에만 해당하는 기준은 그 레포 `config.json` 의 `invariants` 또는 레포 `AGENTS.md` 절(4단계)에. 주기: 루프 완주 시마다 1회 추가 증류(승격 사다리 — 한 번 지적 = 그 턴 교정, 반복 지적 = REVIEW.md 승격).

## 7단계 — 소멸 (개정 2)

구 7단계(디렉터리 스코프 스킬·`claudeMdExcludes` 로 지침 로드 격리)는 `meta/` 가 없어지면서 대상이 사라졌다. 개발 하네스 지침은 `/dev-loop` 호출 시에만 로드되는 스킬 안에 있으므로 교차 오염이 구조적으로 차단된다.

## 검증 (완료 기준)

- **신규 루프가** 레포 루트·스킬 폴더 루트에 만드는 산란물 0 · 상태는 스킬 중앙 `state/<repo-slug>/` 에만(기존 잔존물은 이관·삭제하지 않음 — 별도 정리, 개정 4).
- SKILL.md 개정 반영: 중앙 상태 경로 · 비대칭 2표 리뷰(플러그인 companion 경로 제거·폴백도 Codex 고정) · 병렬 규율 · reward-hack 카테고리 · 수명주기 표준 · STALL-LOG.d 전환 · 재설치 보존 규칙 · 스웜 문턱 규칙 · 스킬 폴더 `REVIEW.md` 존재.
- 임의 레포에서 dev-loop 1회 구동 시: 레포 워킹트리 diff = 작업 그 자체뿐(상태 파일 0), 상태·로그는 그 레포 슬러그 폴더에만 생성.
- 다음 실루프 1회에서 수명주기 표준 적용 확인: W0 문서 감사 수행 · 파일럿 go 기록 · 리뷰 다표 + reward-hack 카테고리 작동(거부 사례 또는 0건 명시) · 루프 완주 후 REVIEW.md 증류 1회.
- ch-regulated-harness: 런 하네스 전체 CI green(이 계획은 core 무수정이므로 기존 골든 불변).

**첫 런 검증 항목**(리서치 근거 3 중 정적으로 확인 못 한 것 — 실루프 1회로 확정한다):

1. `-o` 파일이 리뷰 모드에서 원시 findings JSON 인지, 렌더된 텍스트인지.
2. `-c sandbox_mode=read-only` · `-c approval_policy=never` 의 `codex exec review` **런타임** 효과(파싱은 검증됨, 적용은 미검증).
3. `-c "mcp_servers={}"` 가 실제로 MCP 테이블을 비우는지.
4. `--json` 출력이 파일로 리다이렉트될 때 이벤트 단위로 플러시되는지(블록 버퍼링이면 `stdbuf -oL` 를 끼우거나 mtime-only 생존판정으로 후퇴).
5. 레포 `AGENTS.md` 가 표 A(프롬프트 없는 호출)에 전달되는지 — 전달되면 파일시스템 경계·reward-hack 지시를 표 A 에도 실을 수 있다.
6. `findings[].priority` 필드의 실제 존재율(없을 때의 등급 매핑 규칙이 필요한지).

## 열린 질문

1. ~~**디렉터리 이름**~~ → **소멸(2026-07-26 개정 2)**: 레포에 `meta/` 를 만들지 않는다 — 자리는 스킬 중앙 `state/<repo-slug>/`. 아래는 소멸 전 기록: `meta/` vs `tools/` vs `devharness/`. 제안 기본값 = `meta/`(xtask 처럼 "레포 자신에 대한 작업"임을 드러냄. 루트 스크래치들이 과거 `meta-*` 접두어를 쓴 전례도 있음).
2. ~~**개발 심의(리뷰) 벤더**~~ → **해소(2026-07-26)**: **Codex 유지 + 비대칭 2표 격리 합의**로 확정. 3회 반복된 행이 Codex 모델의 한계가 아니라 플러그인의 4줄 결함(`app-server.mjs:157`)이었고, 원시 `codex exec review` 경로가 그 결함을 통과하지 않는다(리서치 근거 3). 부수 이득 — 리뷰 추론이 Codex 쿼터에서 일어나므로 Claude 토큰이 절약된다(스테이지당 전체 디프 리뷰 패스 0회). ~~Claude 다표 격리 리뷰는 폴백 등급으로 보존(Codex 두 표가 연속 실패·쿼터 소진 시)~~ → **개정 3(사람 결정)으로 폐기**: 폴백도 Codex 고정(재시도 · 쿼터 해제 대기). 아래는 해소 전 검토 기록: 현행 Codex 리뷰 유지 vs 대체. 형제 계획이 런 하네스에서 Codex 기능을 제거해도 개발 하네스의 리뷰는 별개 문제. **참고**: Bun 은 다른 벤더 없이 **같은 벤더(Claude)의 컨텍스트 격리 + 2표 합의 + 반증 스탠스**만으로 완주했다 — Codex 를 끊는 경우 "Claude 다표 격리 리뷰"가 실증된 대안. 런 하네스의 타-벤더 원칙(ADK)은 규제 심의라 더 강한 격리가 필요한 것이고, 개발 리뷰는 격리 수준을 한 단계 낮출 근거가 있다. **사람 결정**.
3. ~~**루프 이력 보존 방식**~~ → **해소(2026-07-26 개정 2 · 사람 결정)**: **중앙 보관만** — 이력 전부 `state/<repo-slug>/loops/` 에 두고 레포 git 에는 아무것도 남기지 않는다. Bun 방식(브랜치 커밋 → 히스토리 = 보존소)은 중앙 저장과 양립 불가라 명시적으로 포기(감사 추적은 중앙 폴더가 담당). 아래는 해소 전 기록: `meta/loops/` gitignore + 요약만 추적(기본) vs **Bun 방식**(브랜치에 전부 커밋 → 머지 직전 정리 커밋으로 삭제, 히스토리 = 보존소). 감사 추적성이 중요하면 Bun 방식 우세.
4. ~~**동적 워크플로 채택 범위**~~ → **해소(2026-07-26 개정 5 · 사람 결정)**: **병행** — 기본은 스킬, 스웜형 대량 작업만 동적 워크플로. 문턱 규칙 = 한 스테이지의 독립 작업 단위가 10개 이상이면 그 스테이지만 워크플로로 fan-out(SKILL.md 에 한 줄로 명문화 — 3단계). 근거 — 전면 전환은 dev-loop 핵심 자산(5시간 리밋 자동 재개 워치독·리뷰 라운드 수렴 판정)이 세션 수준 메커니즘이라 재구현 비용만 들고 리뷰 게이트도 Codex 외부 프로세스라 워크플로 안에 있을 이유가 없으며, 워크플로의 실익(결정적 제어 흐름 — 오케스트레이션에 모델 토큰 0 · agent 단위 resume 캐시 — 중단 후 재개 시 완료분 재실행 0 · 스키마 강제 구조화 출력)은 대량 fan-out 에서만 발생한다. 정의 파일 위치는 대상 레포의 `.claude/workflows/*.workflow.js`(Bun 관례 — 워크플로는 상태가 아니라 코드라 개정 2와 독립). 아래는 해소 전 기록: dev-loop 스킬 유지 vs 동적 워크플로 전환 vs 병행(스웜형 대량 작업만 워크플로). 1단계 갈래 1이 해소돼 이제 "필수"가 아니라 선택이다.
5. ~~**스테이지별 커밋 정책**~~ → **승인(2026-07-26)**: 오케스트레이터가 스테이지마다 작업 브랜치에 1커밋(80자 이하 메시지 · 그 스테이지의 명시 경로만 add · push 금지 · 머지는 사람)을 만든다. 이로써 표 A 의 `--commit <sha>` 스코핑이 성립하고 병렬 웨이브의 두 스테이지가 서로 겹치지 않는 리뷰 범위를 갖는다. 3단계 병렬 규율의 커밋 조항을 "구현 에이전트는 커밋하지 않는다"로 함께 정정했다. 아래는 결정 근거 기록: 거부 시 `--uncommitted` 로 후퇴하고, 그러면 병렬 웨이브에서 두 표가 각자 다른 범위를 보는 게 아니라 **둘 다 웨이브 합집합 디프를 보게 되어** 비대칭 2표의 핵심 이점이 사라진다(한 스테이지의 잡음이 다른 스테이지의 라운드 수를 부풀린다). 현행 스킬은 사용자 승인 전까지 아무것도 커밋하지 않으므로 기존 관례의 변경이다. **사람 결정**.

## 참고 원문 (실행 세션에서 열람 가능)

- 블로그: https://bun.com/blog/bun-in-rust
- PR: https://github.com/oven-sh/bun/pull/30412
- PORTING.md: https://raw.githubusercontent.com/oven-sh/bun/eeb4d9fdf6e9a7bdd45388d7f3a03dcf570839ad/docs/PORTING.md · LIFETIMES.tsv: 같은 커밋 `docs/LIFETIMES.tsv`
- 워크플로 54개: https://github.com/oven-sh/bun/tree/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows (대표: `phase-g-mega-swarm.workflow.js` — 2표 리뷰·reward-hack 거부·기준선 triage·HARD 규율 / `porting-md-zigleakage.workflow.js` — 규칙 문서 자체 감사)
- main 현존: `CLAUDE.md`(AGENTS.md symlink) · `REVIEW.md` · `.claude/`(훅·스킬)
