# 메타프롬프트 — L·C·D 병렬 트랙 (Track B(K)와 파일 무접촉으로 동시 실행)

> 이 문서는 **실행 가능한 메타프롬프트**다. `maintainability-refactor-plan.md` 의 **L·C·D 트랙 중, 지금 진행 중인
> Track B(커널 dedup = K-1~K-5)와 파일이 겹치지 않아 병렬 실행이 안전한 항목만** 담는다.
> 담긴 항목: **C-1(CI 계측·매핑표) · L-2(커밋형 settings.json) · D-1(문서 다이어트)**.
> **반드시 별도 워크트리에서** 돌린다(아래 0절). Track B 는 `../ch-harness-kernel`(cleanup/kernel-track)에서 도는 중이다.
> 규칙 정본 = `core/AGENTS.md` · 조사 원문 = `core/docs/maintainability-refactor-plan.md`(L/C/D 트랙·부록B).

---

## 0. 격리 규칙 (병렬 안전의 전제 — 엄수)

### 0-1. 전용 워크트리
```bash
cd /Users/chabh/workspace/ch-regulated-harness
git worktree add -b parallel/lcd-track ../ch-harness-lcd main
git worktree list   # 3개 확인: primary(main) · ../ch-harness-kernel(kernel-track=TrackB) · ../ch-harness-lcd(lcd-track)
```
- 모든 작업은 `../ch-harness-lcd` 에서. `runs/` 가 분리돼 C-1 의 전체 CI 가 Track B·primary 와 무충돌.

### 0-2. ★ 건드리면 안 되는 파일 (= Track B K-1~K-5 표면 — 충돌 방지 핵심)
아래는 Track B 가 이동·배선 중이다. **읽기만 하고 절대 수정하지 마라**:
- `core/scripts/lib/harness.py` · `core/scripts/lib/common.sh` · `core/scripts/lib/ingest.py` ·
  `core/scripts/lib/image_engine.py` · `core/scripts/lib/stub_stage.py` · `core/scripts/lib/obs.sh`(K-1 env·K-2 watchdog)
- `core/scripts/gate.sh` · `new-run.sh` · `intake.sh` · `kcia-check.sh` · `advance-phase.sh` · `run-stage.sh` · `next-action.sh` · `validate-stage.sh`
- `core/tests/lib.sh` 및 기존 `core/tests/test-*.sh`(K-5 위생 대상)
- `core/harness/*.schema.json`(K-4 lint 대상 — 스키마 자체 무수정)
- `core/docs/workflow-ssot.md`(Track B 동반 갱신 SSoT — D-1 도 이 파일 내용은 안 바꾼다)

허용 표면(이 트랙이 만지는 것): **`core/docs/`(workflow-ssot 제외) · 루트/`core/.claude/settings.json`(신규) · `core/AGENTS.md` 4번 절(D-1 의 최소 한 hunk)** 뿐.

### 0-3. 브랜치·머지
- 각 항목 = 독립 하위 브랜치(`parallel/c1-ci-metrics` · `parallel/l2-settings` · `parallel/d1-docs`) → 검증 → `parallel/lcd-track` 로 `--ff-only` 병합.
- **main 직접 병합 금지.** `parallel/lcd-track` 에 쌓는다. 최종 main 통합은 오케스트레이터가 조율한다(Track B 의 kernel-track 과 파일 disjoint 라 순서 무관·clean; kernel-track 먼저 main 병합 후 lcd-track 을 그 위에 rebase 또는 3-way).
- 커밋 = 항목별 분리. `docs/workflow-ssot-history.md` 에 변경 한 줄 append(정본 부풀림 금지).

### 0-4. 값 불변·CI 기준선
- 이 트랙은 **생성 경로를 만지지 않는다** → 골든 4종(verify-baseline·drug-stub·prompt-assembly·b3)은 **불변이어야 한다**(무접촉이므로 자동 불변, 그래도 각 항목 완료 시 1회 확인).
- 전체 CI 정상 실패 = **선재 4건**(critic-fanout drug ADK 3 + b4 1). 그 외 실패 = 신규 회귀 → 멈추고 보고.
- state.json 은 scripts 만 쓴다 · 누출 allowlist 0 유지 · hooks/MCP 재구성 금지.

---

## 1. C-1 — CI 스위트 계측 + 변경→타겟 매핑표 (착수 게이트 없음 · 지금 바로)

> 출처: maintainability-plan 6장 C 트랙 · 부록A(CI 25분 49초). **코드 무수정, 측정 + 문서만.**

### 할 일
1. `../ch-harness-lcd/core` 에서 전체 CI 1회를 **스위트별 소요와 함께** 계측:
   - `tests/run-ci.sh` 의 스위트 목록(TESTS 배열)을 읽어, 각 스위트를 `time` 으로 감싸 순차 실행(오프라인 결정성 위해 `HARNESS_OFFLINE=1`). 계측 스크립트는 **스크래치에만** 두고 `core/scripts` 에 커밋하지 마라(허용 표면 밖).
   - 산출: 스위트명 → 초 단위 소요 표. 상위 병목 5개 식별(추정 후보: test-clinical-chart·test-multiproduct-extraction·렌더 계열).
2. **변경 파일 → 최소 타겟 테스트 매핑표** 작성(현행 규율 "반복 중엔 타겟만, 커밋 시 전체"의 실행 도구):
   - 예: `image_engine.py→test-image-engine·gen-image-completeness` · `adk_critic.py→test-prompt-assembly·b3` · `gate.sh→test-gates·test-routes` · `ingest.py→test-b1·test-intake` 등. 심볼·소스 기준으로 실측 확인.
3. 산출물 위치 = **새 문서 `core/docs/ci-cost-and-target-map.md`**(신규, 허용 표면). 헤더에 "계측 기준 커밋(main c181284) · 스냅샷"과 "선재 실패 4건" 명기. maintainability-plan 부록에 링크 한 줄만 추가(그 문서 본문은 안 건드림).

### 검증·DoD
- 매핑표가 실제 스위트명과 일치(오타 없음) · 병목 5개 소요 수치 기재 · 선재 4건 확인 기록.
- 코드 diff = 0(문서만). 골든 무영향(자동).

---

## 2. L-2 — 커밋형 `.claude/settings.json` (state.json 편집 deny) · ★ 착수 게이트 = M-2

> 출처: maintainability-plan 4장 L3 판정 · 6장 L-2 · 부록B **M-2**. AGENTS 이식성 원칙 비저촉(금지 목록에 settings 없음), Claude 전용 2차 방어막.

### ★ 착수 전 BLOCKING: M-2 사람 확정
착수 전 사람에게 확정받는다: **"커밋형 `.claude/settings.json` 을 신설해 `runs/**/state.json` 에 대한 Edit/Write 를 deny 로 막을까(절대규칙 1 'state.json 은 scripts 만' 의 메커니즘화)?"**
- **확정(진행)** 시에만 아래 수행. **미확정이면 이 항목 전체를 건너뛴다**(C-1 만 수행).

### 할 일 (M-2 확정 시)
1. `core/.claude/settings.json`(신규, 커밋 대상) 생성 — **deny 최소셋 1건**: `runs/**/state.json` 에 대한 `Edit`·`Write` 거부. **allow 는 넣지 않는다**(세션별 local 유지). 정확한 스키마는 `update-config` 스킬/현행 settings 문법으로 확인.
2. Codex 비대칭 명시: 문서(새 `core/docs/permissions-note.md` 또는 AGENTS 보충 메모)에 "이 deny 는 Claude 전용 2차 방어막 · Codex 는 sandbox + test-b0 grep 이 기존 방어" 1문단.
3. ⚠ **hooks 아님**(PreToolUse/PostToolUse 금지 — 절대규칙 3). deny 규칙만.

### 검증·DoD
- deny 로 `runs/**/state.json` 편집이 차단되는지 세션에서 1회 확인(정상 4동작 scripts 경로는 영향 없음 — settings deny 는 Claude 툴콜만, 셸 스크립트 무관 → 골든·CI 무영향).
- 전체 CI 선재 4건 확인(settings.json 은 CI 무관이라 자동).

---

## 3. D-1 — 문서 다이어트 (동반 갱신 대상 축소) · ★ 착수 게이트 = M-1

> 출처: maintainability-plan 6장 D-1 · 부록B **M-1**. 실측(커밋 80% docs 동반)의 처방. **workflow-ssot 는 유일 SSoT 로 유지**(내용 무수정).

### ★ 착수 전 BLOCKING: M-1 사람 확정
착수 전 사람에게 강등 범위를 확정받는다: **"어느 문서를 '참조 스냅샷(갱신 의무 없음)'으로 강등/아카이브할까?"** 권고 후보 = `pipeline-stage-definitions.md`·`harness-architecture.md`·`stage-contracts.md`(참조 강등, 헤더 명기) · 완료된 계획 문서(→ `_archive/` 이동 규율화).
- **확정된 범위만** 수행. **미확정이면 이 항목 전체를 건너뛴다.**

### 할 일 (M-1 확정 범위)
1. 확정된 참조-강등 문서 각 헤더에 1줄: `> 참조 문서(스냅샷 — 갱신 의무 없음, 정본은 docs/workflow-ssot.md)`.
2. 완료된 계획 문서를 `core/docs/_archive/` 로 이동(git mv). 어느 게 완료인지도 M-1 에서 확정(현재 살아있는 계획 8개 중 완료분).
3. `core/AGENTS.md` 4번 절에 **최소 한 hunk**: "동반 갱신 의무 = `docs/workflow-ssot.md` 1개 문서로 한정, 강등 문서는 의무 밖" 명문화. ⚠ Track B 가 AGENTS.md 를 동시 수정 중이면 이 hunk 는 머지 시 조율(작은 충돌).

### 검증·DoD
- 강등 문서 전건 헤더 명기 · 완료 계획 _archive 이동 · AGENTS 4번 절 갱신 · 코드 diff = 0.
- 누출 grep(H-6 망)·pack-lint 등 문서-이동에 민감한 테스트만 타겟 확인(문서 이동이 스캔 범위를 안 깨는지) + 선재 4건.

---

## 4. 실행 순서·보고

```
전제: M-1·M-2 결정 수집(C-1 은 결정 불필요)
착수:  C-1(항상) ∥ [M-2 확정 시] L-2 ∥ [M-1 확정 시] D-1   — 세 항목도 서로 파일 disjoint 라 내부 병렬 가능
각 항목: 하위 브랜치 → 작업 → 타겟 검증 + 골든 무영향 확인 → 단위 Codex 리뷰 → parallel/lcd-track ff 병합 → 한 단락 보고
완료:  parallel/lcd-track 에서 전체 CI 1회(선재 4건) → 오케스트레이터에 보고(최종 main 통합은 조율)
```
- 각 항목 완료마다 간결 보고: 무엇을 바꿨나 · 타겟/CI 결과(선재 4건인지) · Codex 발견 · 골든 무영향 확인.
- Track B 파일을 건드려야 할 상황이 생기면 **즉시 멈추고 보고**(그건 병렬 불가 신호 = 이 트랙 범위 밖).

## 5. 하지 않는 것
- 0-2 금지 파일 수정(K 충돌) · main 직접 병합 · workflow-ssot 내용 변경 · hooks/MCP 도입 ·
  M-1·M-2 미확정 항목 착수 · 반병렬(L-1)·병렬불가(A-DEF-1/2) 항목 손대기(→ `meta-deferred-lcd.md`) ·
  골든 재캡처 · state.json 손편집.
