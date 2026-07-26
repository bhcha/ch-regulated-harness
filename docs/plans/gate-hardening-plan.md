# 게이트 경화 계획 — 머지 게이트 · Codex 흔적 제거 · PreToolUse 경계

> **지위**: 진행 중 계획(`docs/plans/`). 완료 시 `_archive/` 이동.
> **작성**: 2026-07-25. **실행 전제**: 이 문서만 읽고 별도 세션에서 실행 가능하도록 자기완결로 쓴다.
> **형제 계획**: `dev-harness-plan.md`(개발 하네스 meta/ 제도화) — **별도 프로젝트로 분리됨**(`~/workspace/dev-loop/dev-harness-plan.md`, 이 저장소 밖). 이 계획의 1단계(머지 게이트)가 그 계획의 전이 게이트를 제공한다. **Codex 제거 범위 경계**: 이 계획은 **런 하네스(core/)의 기능·문서 흔적**만 다룬다. 개발 하네스(dev-loop)의 Codex '리뷰 벤더' 유지/대체는 형제 계획의 열린 질문이다.

## 배경 (왜 지금 이 셋인가)

외부 점검(2026-07) 평가 요지 — 현 하네스는 "SSOT + 결정론적으로 집행되는 워크플로 게이트"(상태 전이·verdict 해시 바인딩·라우트 우회 방지 = 실구현·테스트 통과)이지만, 감사용 완성 패키지가 되려면 세 공백이 남는다:

1. **실제 머지 차단 게이트 없음** — `core/tests/run-ci.sh` 는 좋은 결정적 러너지만 `.github/workflows` 0개, branch protection 미설정(현 비공개 저장소 플랜에서 API 403). "머지 전에 돌려야 하는 규율"이지 머지를 차단하는 게이트가 아니다.
2. **우회 불가능한 공통 에이전트 경계 없음** — 직접 Claude 세션이 `state.json` 을 직접 쓰는 것을 막는 도구-레벨(PreToolUse) 경계가 없다(챗 워커에는 Write/Edit deny 구현됨). 현행 헌법(AGENTS.md 규칙 3)이 이식성을 이유로 hooks 를 금지하고 있어서다.
3. **전 도메인 fail-closed 아님** — `health_food`(ready-only)·`quasi_drug`(tbd)는 `placeholder-autopass`.

여기에 사용자 결정으로 **Codex 흔적 제거**가 추가된다. 이는 단순 청소가 아니라 2번의 전제 정리다: 훅 도입의 최대 비용이 "이중 CLI(Claude·Codex) 비대칭 — Codex 에는 PreToolUse 등가물이 없어 훅이 영원히 중복 계층"이었는데, **런 하네스를 Claude 단일 CLI 로 만들면 그 비대칭 비용이 소멸**하고 규칙 3의 이식성 근거도 함께 정리된다.

## 불변 원칙 (이 계획 전체에 적용)

- **게이트(셸) = 판정의 SSoT.** 훅은 비-load-bearing 경화 계층 — 훅이 있다는 전제로 어떤 게이트도 완화하지 않는다. 훅이 없는 표면(CI stub subprocess·챗 워커·미래의 다른 실행기)은 훅 없이도 지금처럼 안전해야 한다(기존 fail-closed 전부 유지).
- **D-1 동반 갱신**: 각 단계의 코드 변경과 같은 커밋에서 해당 정본(workflow-ssot·feature-catalog·config-reference·docs/README + AGENTS.md 규칙 절)을 갱신한다.
- **CI 방침**: 반복 작업 = 타겟 테스트, 단계 마무리 커밋 = 전체 `run-ci.sh`.
- `docs/snapshots/`·`docs/_archive/`·`docs/history/` 는 작성 시점 스냅샷/이력이므로 **건드리지 않는다**(Codex 언급이 남아도 정상 — 갱신 의무 밖).

## 1단계 — 머지 게이트 (원격 CI + 브랜치 보호)

**왜 첫 번째인가**: 벤더 중립이라 CLI 비대칭 문제가 없고, 이후 2·3단계의 위험한 리팩토링 PR 을 이 게이트가 보호한다. 위협 모델 분담 — 훅은 "세션 내 상태 오염" 방어, 머지 게이트는 "코드베이스 오염(게이트 스크립트·스키마 자체의 변경)" 방어.

작업:
1. `.github/workflows/ci.yml` 신설 — PR·push(main) 트리거, `HARNESS_OFFLINE=1 bash core/tests/run-ci.sh` 실행(오프라인 stub 게이트라 네트워크·키 불요, 결정적). chat 테스트 러너가 별도면 잡 추가.
2. 필요 러너 의존성 확인(bash·python3·jq 등 — `run-ci.sh` 가 요구하는 것들을 ubuntu 러너에 설치하는 step).
3. **브랜치 보호(결정 필요)**: 비공개 저장소 무료 플랜에서 branch protection/ruleset API 403. 선택지 — (a) 플랜 업그레이드 후 required status check 지정(정석), (b) 과도기: main 직접 push 금지를 규율로 두고 PR + CI green 을 사람이 확인. (b)로 시작하더라도 워크플로 등록만으로 "PR 마다 자동 실행·기록"이라는 감사 증거는 확보된다.

완료 기준: PR 을 열면 CI 가 자동 실행되고 결과가 PR 에 기록된다. (a) 채택 시 CI red 인 PR 은 머지가 물리적으로 차단된다.

## 2단계 — Codex 흔적 제거 (생성 엔진 Claude 단일화)

**범위 선언**: 흔적은 두 층이다. **A. 기능 흔적**(엔진 옵션·env·배포 경로 — 필수 제거)과 **B. 리뷰 인용 주석**(과거 dev-loop Codex 리뷰 지적사항 표기, 예 "Codex R2 CRITICAL" — 수백 건, 중립화). B 는 정보(왜 이 코드가 이렇게 생겼는지의 출처)를 담고 있으므로 삭제가 아니라 표기 치환으로 보존한다.

### 2-A. 기능 흔적 인벤토리 (실행 세션에서 `grep -ri codex` 로 재확인 후 착수)

| 위치 | 현재 | 조치 |
|---|---|---|
| `core/scripts/lib/common.sh:326` | `HARNESS_CODEX_FLAGS` 기본값 | 변수·참조 삭제 |
| `core/scripts/lib/common.sh:383` | `codex exec` 서브프로세스 분기 | 분기 삭제(도달 가능 모드는 insession 또는 stub 뿐 — 이미 헤드리스 실엔진 폐기) |
| `core/scripts/lib/common.sh:436-438` | `CODEX_*` env 활성 감지(insession 신뢰 마커 보조) | **검토 후 결정** — "Codex 세션 안에서 claude 하네스 오인 방지" 방어라면 유지 가능(열린 질문 3) |
| `core/scripts/run-stage.sh:95` | `HARNESS_CLI` enum `claude\|codex\|stub` | `claude\|stub` 로 축소 |
| `core/scripts/run-stage.sh:296` | fail-closed 안내문의 `claude\|codex(subprocess)` | 문구 정정(헤드리스 실엔진은 폐기라 애초 스테일) |
| `core/scripts/kcia-check.sh:68` | 엔진 토큰 화이트리스트 `""\|claude\|codex\|stub` | `codex` 제거 |
| `core/scripts/kcia-check.sh:74` | insession raw 토큰 `claude\|codex` | `claude` 만 |
| `core/scripts/kcia-check.sh:63` | 거부 메시지에 codex 언급 | 문구 정리(폐기 안내는 유지 가능) |
| `core/scripts/sync-skills.sh` | `~/.codex/skills` 전역 배포 경로 | Codex 배포 절 삭제 → `.claude/commands` 단일 배포 |
| `.env.example:19,22` | `HARNESS_CLI=claude \| codex` 주석 등 | 문구 정리 |
| `core/AGENTS.md` 헤더(3-4행) | "두 CLI(Claude Code · Codex) 공통" 선언 | Claude 단일 지침으로 개정. **파일명 AGENTS.md 는 유지**(agents.md 표준 — 미래 도구 호환·중첩 우선순위 메커니즘) |
| `core/AGENTS.md` 규칙 3 | "Codex `approval_policy`/`resume`/`fork`" 금지 조항 | 조항 삭제(대상 소멸). hooks 문구 개정은 3단계에서(같이 착수 시 한 번에 개정 가능) |
| `core/AGENTS.md` 2번 절 | `HARNESS_CLI=claude\|codex\|stub` · `HARNESS_CODEX_FLAGS` 정의 | enum 축소·변수 삭제 |
| `.claude/settings.local.json` | 스테일 allow `KCIA_CRITIC_CMD="codex exec…"` | 삭제(위생 — KCIA_CRITIC_CMD 자체가 폐기) |
| `chat/src/spawn-hygiene.ts:41` | `CODEX_*` env 스크럽 접두어 | **유지 권장**(무해한 심층 방어 — 열린 질문 4) |

### 2-B. 리뷰 인용 주석·문서 표기 중립화

- 대상: `core/scripts/**`·`core/tests/**`·`core/harness/*.json`·`chat/src/**`·`packs/_format/**`·`docs/canonical/**` 의 주석·설명문 안 "Codex …" 리뷰 인용(예 `Codex R2 CRITICAL`, `Codex P0`).
- 조치: `Codex <id>` → `외부리뷰 <id>` 기계 치환(id·심각도 보존 = 출처 추적성 유지). **주석·설명문 한정** — 코드 문자열·테스트 픽스처 기대값에 걸리는 건 개별 판단.
- 제외: `docs/snapshots/`·`docs/_archive/`·`docs/history/`(갱신 의무 밖), 레포 밖(메모리 파일 등).

### 2-C. 테스트·정본 동반 갱신

- 테스트 개정(확인된 것): `test-b0.sh`(sync-skills Codex 배포 검증 부분), `test-insession-genmode.sh`(codex 엔진 토큰 케이스), kcia 엔진 토큰 화이트리스트를 다루는 테스트들. 나머지 codex 언급 테스트는 대부분 주석(2-B 로 처리) — 실행 세션에서 개별 확인.
- D-1: `config-reference.md`(HARNESS_CLI 행·HARNESS_CODEX_FLAGS 행 삭제) · `workflow-ssot.md`(원칙 10 "두 CLI 공통 substrate" 개정) · `feature-catalog.md`(sync-skills 행) · AGENTS.md 2번 절 — 같은 커밋.

완료 기준: 운영 표면(`core/`·`packs/`·`chat/`·`docs/canonical/`·루트 설정)에서 `grep -ri codex` 가 0(단 2-A 에서 '유지' 결정한 방어 코드와 스냅샷·아카이브·이력은 예외 목록으로 명시) + 전체 CI green.

## 3단계 — PreToolUse 좁은 deny (경화 계층)

**전제**: 2단계 완료(단일 CLI 화 + 규칙 3 개정 준비). **핵심 설계 원칙 — 훅에는 "세션 모드와 무관하게 절대 금지"인 것만 담는다.** "운영 세션에선 금지지만 개발 세션에선 본업"인 보호(core/scripts·스키마 수정)는 훅이 아니라 1단계 머지 게이트가 맡는다. 이 분담으로 "이 세션이 운영인가 개발인가" 구분 문제가 훅 설계에서 사라진다.

작업:
1. **deny 목록(최소 시작)**: `Write|Edit` → `core/runs/**/state.json`(상태는 스크립트 전용 — 스크립트는 Bash 로 쓰므로 도구-레벨 deny 가 정당 작업을 막지 않는다) · `core/runs/**/.logs/**`(스크립트 전용 진단). Bash 명령 문자열 파싱 기반 차단은 **하지 않는다**(공식 문서 스스로 fail-open·best-effort 인정 — 오탐이 이득보다 큼. Bash 우회는 사후 게이트[해시 바인딩·advance 마커]가 잡는 게 이 하네스의 원설계).
2. **배선**: 프로젝트 커밋 `.claude/settings.json` 의 `hooks.PreToolUse`(matcher `Write|Edit`) + 훅 스크립트(`core/scripts/hooks/` 또는 `meta/` — 형제 계획과 위치 협의). exit 2 + stderr 사유("상태는 스크립트만 씁니다 — bash scripts/… 를 사용하세요")로 교정 신호 제공.
3. **헌법 개정(같은 커밋)**: AGENTS.md 규칙 3 "hooks 금지" → "훅 **의존** 금지 — 게이트를 대체하지 않는 비-load-bearing 경화 계층으로만 허용. 훅 부재 환경에서도 모든 fail-closed 가 성립해야 한다". 근거 문구(이중 CLI 이식성)는 2단계에서 소멸.
4. **회귀 테스트**: 훅 스크립트 단위 테스트(이벤트 JSON 픽스처 → deny/허용 판정) 1개 추가. Claude Code 실세션 통합은 수동 확인 1회 기록.

**실전 선례**(2026-07 조사 — 형제 계획 `dev-harness-plan.md`(별도 프로젝트 `~/workspace/dev-loop/`) "리서치 근거 2" 참고): Bun(github.com/oven-sh/bun) main 은 **프로젝트 커밋 `.claude/settings.json` 에 PreToolUse 훅**(`pre-bash-guard.js` — rustfmt 직접 실행 거부·`USE_SYSTEM_BUN` 감시 등)과 PostToolUse 훅(`post-edit-format.js` — 편집 파일 자동 포맷)을 실제 운용 중이다. 53만 줄 포팅을 최대 64개 에이전트로 돌린 레포가 채택한 배선 채널이 정확히 이 계획의 2번(프로젝트 커밋 settings.json + 좁은 가드 스크립트)과 같은 형태 — deny 대상도 "임의 로직이 필요한 좁은 명령 가드"에 한정하고 나머지는 저장소-레벨 게이트(CI·리뷰)에 맡긴다는 분담까지 동일하다.

완료 기준: 대화형 세션에서 `state.json` 직접 Write/Edit 시도가 deny 되고 사유가 피드백된다 · 훅을 제거해도 전체 CI·기존 게이트 동작 불변(비-load-bearing 증명) · 규칙 3 개정 반영.

## 4단계 — 문서 무결성 (감사 지적 소거 · 독립 실행 가능)

- 끊어진 링크 2건 수정, 미등재 계획 문서 3건(`chat-live-slack-resume-plan.md`·`chat-review-retry-plan.md`·`chat-atdd-acceptance-resume-prompt.md`) 을 docs/README.md 상태표에 등재하거나 `_archive/` 이동 판단.
- 이 계획과 형제 계획 2건은 생성 시점에 등재 완료.

## 5단계 — 전 도메인 fail-closed (외부 의존 · 코드 작업 아님)

`quasi_drug`·`health_food` 심의기준 문서 입수 → `packs/<도메인>/ruleset.json` 4축+`mandatory_inclusion` 채움 → `domain.json` status=active 전환(전환 즉시 실심의 — 게이트 코드는 준비 완료). placeholder-autopass 의 verdict 가시화(engine·note)는 그때까지 유지. **트래킹 항목으로 관리**(입수 일정이 병목).

## 순서·의존성

1단계(머지 게이트) → 2단계(Codex 제거) → 3단계(PreToolUse). 4단계는 독립(언제든), 5단계는 외부 의존. 2·3단계의 AGENTS.md 규칙 3 개정은 연속 착수 시 한 번에 묶어도 된다.

## 열린 질문

1. 브랜치 보호: 플랜 업그레이드 (a) vs 과도기 규율 (b) — 사람 결정.
2. 2-B 주석 중립화 치환어: "외부리뷰" vs "리뷰" vs 유지 — 기본 제안은 "외부리뷰"(출처 중립화 + id 보존).
3. `common.sh:436` CODEX_ env 감지: 방어 유지 vs 제거.
4. `chat/src/spawn-hygiene.ts` CODEX_ 스크럽: 유지 권장(무해 방어) — 이견 없으면 유지.
