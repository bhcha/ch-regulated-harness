# 트랙 B — 후속정리 2~6단계 구현 (워크트리 · /dev-loop · CI 변경분만)

> 이 파일은 **트랙 B 전문**이다. 병렬 오케스트레이션(`parallel-run.goal.md`)이 이 파일을 Read 해
> /dev-loop 로 구동한다. 실행 위치 = **`../ch-harness-kernel` 워크트리(`cleanup/kernel-track` 브랜치)**.
> 실행 계획 SSoT = `core/docs/post-pack-cleanup-plan.md` — **미체크([ ]) 항목만**(2~6단계) 수행.
> 조사 원문 `core/docs/maintainability-refactor-plan.md` 는 참조만. 규칙 정본 = `core/AGENTS.md`.

## 체크포인트 — 이미 끝난 것 (재작업 절대 금지)
- 2부 팩 분리 전체 + 2차 내용 교정: **main 병합 완료** — `ops-and-pack-refactor-plan.md` 는 완료 문서다.
  그 문서의 단계(2잔여~9)를 다시 실행하지 마라(재실행 = 중복 커밋·파괴적).
- 후속정리 1단계(H-1 intake 일원화·H-6 누출망·사문): **main c181284 병합 완료**, 누출 allowlist 0 · critic_prompt 0.
- CI 기준선: 전체 CI 의 정상 실패 = **선재 4건**(critic-fanout drug ADK 3 + b4 1 = run-ci 의 HARNESS_NO_DOTENV
  환경 아티팩트)만. **그 외 실패 = 신규 회귀.**

## 시작 전 확인
1. 워크트리가 `../ch-harness-kernel`·브랜치 `cleanup/kernel-track`·작업트리 클린 확인. main 기준.
2. **트랙 A 검증 보고서**가 있으면 먼저 읽어라 — FAIL 발견이 있으면 K 트랙보다 결함 처리가 우선이므로
   사람에게 보고하고 방향을 확인한다.
3. 계획서의 파일:줄 인용은 **심볼 기준으로 재확인**(줄번호 흘렀음). 정밀 정찰은 Explore subagent 에 위임해
   컨텍스트를 아껴라.

## 공통 규율 (전 단계 — 2부에서 확립한 패턴 그대로)
- **값 불변**: 옮기고 일원화만, 동작·바이트 불변. 판정자 = 골든 4종
  (verify-baseline · test-drug-stub-golden · test-prompt-assembly · test-b3 심의 골든셋).
  **골든이 바뀌면 값 불변 위반** — 즉시 멈추고 사람에게 보고(골든 재캡처 = 사람 승인 게이트.
  유일한 예외는 2단계 instr 골든의 같은-커밋 재캡처).
- 커밋 = 헬퍼/항목별 분리(원인 격리) + 커밋 메시지에 **중복 지점 수 before/after** 기재.
- **CI 실행 중 이 워크트리의 작업트리 수정 금지**(거짓 실패 실측 교훈).
- 누출 allowlist 0 유지(test-core-domain-leak) · state.json 은 scripts 만 쓴다.

## 브랜치·머지 규율 (워크트리용 — ★ main 직접 병합 금지)
- 각 단계: `git switch -c cleanup/stage-N-<슬러그> cleanup/kernel-track` → 작업 → 검증 →
  `git switch cleanup/kernel-track && git merge --ff-only cleanup/stage-N-<슬러그>`.
- **main 병합은 트랙 B가 하지 않는다**(main 은 트랙 A가 잡음 → git 이 다른 워크트리의 main 갱신을 거부).
  전 단계는 `cleanup/kernel-track` 에 쌓고, 최종 main 통합은 오케스트레이터가 수행.

## ★ CI 변경분만 (커밋마다 전체 CI 금지 — 명시 요구)
- **커밋 단위 검증 = 변경 파일이 만지는 타겟 테스트 + 영향받는 골든만.** 40스위트 전체 CI 를 커밋마다 돌리지 않는다.
- 변경 표면 → 타겟 매핑(착수 시 심볼로 재확인):

  | 변경 표면 | 타겟 테스트(변경분) |
  |---|---|
  | `harness.py`·`common.sh` 마이크로헬퍼(ROOT/PACKS_DIR/원자쓰기/format) | `test-b0` · `test-gates` · `verify-baseline` · `pack-conformance` |
  | `adk_critic.py` grounding(2단계) | `test-prompt-assembly` · `test-b3` |
  | H-2 `domain.json` 정책 속성화 | `test-b3` · `test-pack-lint` · `pack-conformance` |
  | 게이트/상태 보일러(K-2: transition·watchdog·lock) | `test-gates` · `test-routes` · `test-b0` · `verify-baseline` |
  | `build_context`→모듈(K-3①) | `test-prompt-assembly`(ctx 골든) · `verify-baseline` · `test-b2` |
  | `validate-stage`→모듈(K-3②) | `test-components` · 해당 스테이지 검증 테스트 |
  | 스키마 lint·테스트 위생(K-4/5) | 신설 lint 테스트 · `test-*`(위생 대상) |

- **생성 경로를 만지면 골든 4종 중 해당분은 반드시 포함**(값 불변 증명). 골든이 바뀌면 즉시 멈춤.
- **전체 CI(선재 4건 확인)는 커밋마다가 아니라 → ① 각 단계 머지 직전 1회 · ② 최종 통합 직전 1회**만.
  오프라인 결정성 위해 `HARNESS_OFFLINE=1`(트랙 A 온라인과 자원 무충돌). 이 워크트리의 runs/ 로 격리 실행.
- 각 단계 검증 순서: **타겟 테스트(변경분) → 해당 골든 → 단계 머지 직전 전체 CI 1회 → 단위별 Codex 리뷰**
  (codex-rescue 서브에이전트; "백그라운드 실행 중" 조기반환 시 SendMessage 로 실제 발견 수집) →
  계획서 [x]+실측 메모 → `cleanup/kernel-track` 로 ff 머지 → 한 단락 보고 후 다음 단계.

## 실행 순서 (post-pack-cleanup-plan 그대로)

### 2단계 — 심의 grounding 확장 (유일한 동작 변경 · 사람 게이트 필수)
**착수 전 반드시 사람에게 묻는다**: "룰엔진(kcia_engine)이 기능성 lexicon 을 이미 결정론으로 검사 중(이중
안전망)인데, ADK 지시문에 기능성-오인 힌트를 추가하는 실익 vs 오탐·과제약 리스크"를 요약 브리핑하고
**진행/보류** 답을 받아라. 보류면 계획서에 보류 사유를 기록하고 3단계로 넘어간다. 진행 승인 시:
`adk_critic.py` `_ruleset_grounding`(실측 :467)에 ruleset 의 `conditional`·`lexicon.functional_efficacy`
방출 추가(지시문 상한 1500자 준수 확인) → `instr-*.txt` 골든 **같은 커밋** 재캡처(`PROMPT_ASSEMBLY_REGEN=1`)
→ **온라인 카나리 1회**(실 cosmetic ADK, `.env` 자격 존재 — ⚠ 트랙 A 온라인과 겹치면 트랙 A 유휴 시점에)
→ b3 심의 골든셋 검출률·오탐률 **불변** 확인 → 전체 CI(선재 4건만).

### 3단계 — K-1 마이크로 헬퍼 일원화 (헬퍼별 커밋)
ROOT 재계산 11파일 → `from harness import ROOT` · PACKS_DIR/FORMATS_DIR 해석 11곳 1곳화 ·
원자쓰기 4벌 fsync 있는 쪽으로 통일 · deliverable_format 리더 6~7벌 · `_is_num`/sha256/escape 마이크로 헬퍼 ·
**H-2 업그레이드**(`_REGULATED` 실측 common.sh:682·image_engine.py:640 → `domain.json` 정책 속성
[예: `advertising_restricted: true`], 셸·파이썬은 질의만) · H-4 env 이중정의 7묶음 → 1곳화 ·
H-5 매직넘버 8건(상수 명명·주석만, 값 불변). 검증: 골든 4종 + 단계 머지 직전 전체 CI.

### 4단계 — K-2 셸 상태·게이트 보일러 통합
state 쓰기 heredoc 11벌 → `transition()` common.sh 승격 공용화 · 스캐폴딩 공용화(new-run ≡ intake) ·
autopass writer 2벌(review-exempt ≡ placeholder) · watchdog 2벌(run_llm ↔ obs_watch_pid) ·
`with_lock` 헬퍼(락 댄스 9곳) · `image_manifest_*` 반전 쌍 · **H-3** 페이즈↔스테이지 이름 맵 3벌
(common.sh stage_phase · kcia-check · next-action) 1곳화 · sha256 셸 4벌. 검증에 test-gates·test-routes·test-b0 추가.

### 5단계 — K-3 대형 이관 2건 (각각 별도 하위 브랜치)
① `build_context`(common.sh 327줄, 파일의 35.6%) → `lib/build_context.py`. 안전망 = **프롬프트 조립 골든**
(ctx-*.txt 바이트 동일 증명). DoD: common.sh 600줄 이하. ② `validate-stage.sh` 인라인 파이썬 14블록 →
`lib/validate_stage.py`(케이스 디스패치는 셸 유지, 검증 본문만 이관).

### 6단계 — K-4 스키마 정합 lint(스키마 무수정) + K-5 테스트 위생
K-4: functional_status·reference_image_id·regulatory_domain 패턴 문자열이 스키마 간 일치하는지 단정하는
lint 테스트 신설(파일 간 `$ref` 는 검증기 지원 확인 전 금지, phase enum 3곳은 동결 계약=비대상).
K-5: lib.sh drive 드라이버 3벌 파라미터화 통합 · adk-mock 기동/종료 헬퍼 lib.sh 승격 · 인라인 state 리더 → `jq_phase` 유도.

## 완료 후
6단계까지 끝나면 계획서 "완료 판정(DoD)" 절 전 항목을 실측 검증해 오케스트레이터에 보고한다.
main 최종 통합은 오케스트레이터가 수행(트랙 A가 main 을 놓은 뒤 ff). 그 후 **멈춘다**.

## 하지 않는 것
- `ops-and-pack-refactor-plan.md`(2부) 단계 재실행 · 후속정리 1단계 재실행(완료 문서).
- 커밋마다 전체 CI(변경분 타겟만) · **main 직접 병합**(통합 브랜치에만 쌓기).
- 2단계 사람 승인 없는 착수 · 골든 임의 재캡처 · 계획서 "보류"표 · L/C/D 트랙(범위 밖, 착수 전 사람 확인) ·
  hooks/MCP 재구성 · state.json 손편집.
