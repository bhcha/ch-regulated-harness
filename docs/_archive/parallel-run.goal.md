# 병렬 실행 GOAL — 팩분리 E2E 검증(트랙 A) ∥ 후속정리 2~6단계 구현(트랙 B)

> 이 파일은 `/goal` 로 물리는 **최상위 오케스트레이션 지시**다. 당신(메인 에이전트)의 역할은
> **두 트랙을 병렬로 띄우고 감독·조율**하는 것이다. 트랙 A(테스트)는 **현재 main 작업트리**에서,
> 트랙 B(구현)는 **별도 git 워크트리**에서 돈다. 둘은 코드/브랜치/runs 가 격리돼 서로를 깨지 않는다.

**실행 = 단일 명령**: `/goal @parallel-run.goal.md` 한 줄이면 이 파일이 모든 것을 지시한다. 트랙별 **상세
전문은 별도 파일**이며, 각 트랙을 띄울 때 **그 파일을 Read 해 프롬프트로 전달**한다(같은 폴더, 미추적):
- 트랙 A 전문 = `track-a-e2e-validation.md`
- 트랙 B 전문 = `track-b-cleanup-impl.md`

**착수 절차(메인 에이전트)**: 1절 셋업 → 두 트랙 파일을 Read → 트랙 A 서브에이전트 2개(sonnet)와 트랙 B
/dev-loop 을 **각각 백그라운드로 병렬 기동**(그 파일 전문을 프롬프트로) → 4절대로 감독·조율·최종 통합.

---

## 0. 불변 규칙 (양 트랙 공통)
- **완료 문서는 재실행 금지**: `core/docs/ops-and-pack-refactor-plan.md`(2부 팩분리)는 **전부 main 병합 완료**.
  그 단계(2잔여~9)를 다시 실행하지 마라 — 중복·파괴적. 후속정리 1단계(H-1·H-6·사문)도 **main `c181284` 완료**.
- **실행 대상 = `core/docs/post-pack-cleanup-plan.md` 의 미체크([ ]) 항목만**(2~6단계). 조사 원문
  `core/docs/maintainability-refactor-plan.md` 는 참조만. 규칙 정본 = `core/AGENTS.md`.
- **값 불변**: 트랙 B는 옮기고 일원화만(동작·바이트 불변). 판정자 = 골든 4종
  (verify-baseline·test-drug-stub-golden·test-prompt-assembly·test-b3). 골든이 바뀌면 위반 → 멈추고 보고.
- **CI 선재 기준선**: 전체 CI 의 정상 실패 = **선재 4건**(critic-fanout drug ADK 3 + b4 1 = run-ci 의
  `HARNESS_NO_DOTENV` 환경 아티팩트). 그 외 실패 = 신규 회귀.
- **CI 실행 중 그 워크트리의 작업트리 수정 금지**(거짓 실패 실측 교훈).
- state.json 은 scripts 만 쓴다 · 누출 allowlist 0 유지 · hooks/MCP 재구성 금지.

---

## 1. 1회성 셋업 (병렬 시작 전 메인 에이전트가 수행)
```bash
cd /Users/chabh/workspace/ch-regulated-harness
git switch main && git pull --ff-only 2>/dev/null; git status --porcelain   # 작업트리 클린 확인
# 트랙 B 전용 워크트리 + 통합 브랜치(main 기준). ★ 트랙 B는 이 워크트리에서만 작업.
git worktree add -b cleanup/kernel-track ../ch-harness-kernel main
git worktree list   # 두 워크트리 확인: (primary)=main[트랙A] · ../ch-harness-kernel=cleanup/kernel-track[트랙B]
```
- **트랙 A = primary 작업트리(현재 디렉터리, main)** — 읽기전용 E2E. 코드 커밋 안 함.
- **트랙 B = `../ch-harness-kernel`(cleanup/kernel-track)** — 구현. **main 을 직접 건드리지 않는다**
  (git 은 다른 워크트리가 잡은 main 갱신을 거부 → 트랙 B는 통합 브랜치에만 쌓는다).

---

## 2. 트랙 A — 팩분리 E2E 검증 (main · 읽기전용 · 서브에이전트 2개, 둘 다 sonnet)
> **전문 = `track-a-e2e-validation.md` (이 파일을 Read 해 서브에이전트 프롬프트로 전달 — 아래는 요지).**
> 목적: 팩 분리가 실전에서 분리 전과 동등하게 작동하는지 + 사람 게이트·심의기관 누락 시 하네스가
> **멈추고 물어보는지** 검증.

- **순차 실행**(A→B, NanoBanana 쿼터·ADK·환경오염 함정) · 코드/골든/팩/temp 원본 **무수정**.
- **서브 A (sonnet · 화장품 여러장)**: `/Users/chabh/Documents/temp/` 통째로 00a-intake 정문
  (`intake.sh <폴더> <id> --product "이지덤 뷰티 릴리프" --domain 화장품 --format 여러장`). PNK 결과보고서의
  test_report 여정(00a 분류→00e 스펙 승인→추출·승격→임상 TEST 섹션) 추적. done 까지.
- **서브 B (sonnet · 의약품 여러장)**: `/Users/chabh/Documents/temp3/우루사 최신지견 3rd edition.pdf`
  워킹백워드(대웅우루사·복합우루사·우루사정 3품목), 이미지는 리서치 확보 후 스크래치에 모아 intake.
  `packs/drug/rtb-writing-guide.md` 7축·금지표현 준수(최종 grep 0건). done 까지.
- **감시 체크리스트**: P1 심의근거=팩 축 · P2 교차오염 0 · P3 core/packs 추적파일 무변경 · P4 이미지 규약/상대경로
  깊이 · Q1~Q4 사람 게이트(승인·스펙·select/approve·이미지 최종점검) · **Q5 심의기관 누락 네거티브 프로브**
  (첫 심의 게이트에서 URL env 비우고 kcia-check → 조용한 통과=FAIL, 파일 무변조 확인 후 정상 재실행) ·
  Q6 verdict critic_ran=true·adk-http · O1 운영화면 평이 한국어.
- 게이트마다 서브가 멈추면 메인이 "하네스가 실제로 물었는지" 확인 후 SendMessage 로 재개. **안 묻고 지나가면 FAIL**.

---

## 3. 트랙 B — 후속정리 2~6단계 구현 (워크트리 · /dev-loop · CI 변경분만)
> **전문 = `track-b-cleanup-impl.md` (이 파일을 Read 해 /dev-loop 프롬프트로 전달 — 아래는 요지).**
> 실행 위치 = `../ch-harness-kernel`(cleanup/kernel-track). **/dev-loop 으로 구동**.

### 3-1. 브랜치·머지 규율 (워크트리용으로 조정)
- 각 단계: `cd ../ch-harness-kernel && git switch -c cleanup/stage-N-<슬러그> cleanup/kernel-track`
  → 작업 → 검증 → **`git switch cleanup/kernel-track && git merge --ff-only cleanup/stage-N-<슬러그>`**.
- **main 병합은 트랙 B가 하지 않는다**(main 은 트랙 A가 잡음). 전 단계는 `cleanup/kernel-track` 에 쌓는다.
  최종 통합은 4절에서 메인 에이전트가 수행.
- 커밋 = 헬퍼/항목별 분리 + 메시지에 **중복 지점 수 before/after** 기재.

### 3-2. ★ CI 변경분만 (커밋마다 전체 CI 금지 — 명시 요구)
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
  (오프라인 결정성 위해 `HARNESS_OFFLINE=1`; 트랙 A 온라인과 자원 무충돌.)
- 각 단계 검증 순서: **타겟 테스트(변경분) → 해당 골든 → 단계 머지 직전 전체 CI 1회 → 단위별 Codex 리뷰**
  (codex-rescue; "백그라운드 실행 중" 조기반환 시 SendMessage 로 실제 발견 수집) → 계획서 [x]+실측 메모.

### 3-3. 실행 순서 (post-pack-cleanup-plan 그대로)
1. **2단계 심의 grounding — 사람 게이트 필수**: 착수 전 "룰엔진이 기능성 lexicon 을 이미 결정론 검사(이중
   안전망)인데 ADK 지시문 힌트 추가의 실익 vs 오탐/과제약" 브리핑 → **진행/보류 답을 받는다**. 보류면 계획서에
   사유 기록하고 3단계로. 진행 시: `_ruleset_grounding` 에 `conditional`·`lexicon.functional_efficacy` 방출
   추가(1500자 상한) → instr 골든 **같은 커밋** 재캡처(`PROMPT_ASSEMBLY_REGEN=1`) → **온라인 카나리 1회**
   (실 cosmetic ADK — ⚠ 트랙 A 온라인과 겹치면 트랙 A 유휴 시점에) → b3 검출률·오탐률 불변.
2. **3단계 K-1** 마이크로 헬퍼 일원화(ROOT 11·PACKS_DIR 11·원자쓰기 fsync 통일·H-2 domain.json 속성화·H-4·H-5).
3. **4단계 K-2** 셸 상태·게이트 보일러(state 쓰기 11벌 transition 공용화·스캐폴딩·watchdog·with_lock·H-3·sha256).
4. **5단계 K-3** 대형 이관 2건(build_context→모듈, validate-stage 14블록→모듈) — 각각 하위 브랜치.
5. **6단계 K-4/K-5** 스키마 정합 lint(무수정)·테스트 위생.

---

## 4. 병렬 조율 + 최종 통합 (메인 에이전트)
- **자원 격리 확인**: 두 워크트리는 runs/ 가 분리(각자 디렉터리) · 트랙 B CI 는 오프라인 stub(온라인 무접촉) ·
  유일 온라인 경합 = 트랙 B 2단계 ADK 카나리 ↔ 트랙 A → 트랙 A 유휴 창에서만 카나리.
- **진행 감독**: 트랙 A 는 게이트마다 보고(사람 대행) · 트랙 B 는 단계 완료마다 보고. 각 트랙 백그라운드로 띄우고
  완료 알림으로 회수. **트랙 A 가 결함(FAIL)을 내면 트랙 B 의 K 정리보다 결함 처리가 우선** — 사람에게 보고·확인.
- **최종 통합(양 트랙 done 후)**:
  1. 트랙 A 검증 보고서 확정(체크포인트 매트릭스·결함목록·종합판정).
  2. 트랙 B: `cleanup/kernel-track` 에서 **전체 CI 1회(선재 4건만)** 최종 확인.
  3. main 통합 — 트랙 A 가 main 을 놓은 뒤(E2E 종료) primary 트리에서:
     `git switch main && git merge --ff-only cleanup/kernel-track` (kernel-track 은 main 기준이라 ff).
     충돌/비-ff 면 멈추고 보고(트랙 A 가 main 을 움직였을 리 없음=읽기전용, 발생 시 원인부터).
  4. `git worktree remove ../ch-harness-kernel` 정리 · 계획서 DoD 절 전 항목 실측 검증 · 메모리 갱신.
- **완료 판정**: post-pack-cleanup-plan "완료 판정(DoD)" 전 항목 그린 + 트랙 A 종합판정 "동등 작동" + 최종 CI 선재 4건.
  그 후 **멈춘다**(3부 온보딩 등 범위 밖은 사람 지시 대기).

---

## 5. 하지 않는 것
- `ops-and-pack-refactor-plan.md`(2부) 단계 재실행 · 후속정리 1단계 재실행(완료).
- 트랙 B의 **커밋마다 전체 CI**(변경분 타겟만; 전체 CI 는 단계 머지 직전·최종 통합 직전만).
- 트랙 B의 **main 직접 병합**(통합 브랜치에만 쌓고, 최종에 메인 에이전트가 ff).
- 2단계 사람 승인 없는 착수 · 골든 임의 재캡처 · 계획서 "보류"표·L/C/D 트랙(범위 밖, 착수 전 확인).
- 코드/골든/팩/temp·temp3 원본 무단 수정 · state.json 손편집 · HARNESS_ACK_GAPS·stub 강제.
