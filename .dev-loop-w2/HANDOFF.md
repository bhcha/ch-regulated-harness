# 이어받기 메타프롬프트 — chat 무인 워커(W3) 재설계

> **작성**: 2026-07-18 (세션 사용 한도로 중단됨) · **읽는 사람**: 이 작업을 이어받는 다음 세션
> 이 파일 하나만 읽고 바로 이어갈 수 있게 썼다. 상태 파일 = `.dev-loop-state.json`(같은 디렉터리 규약).

---

## 0. 지금 당장 할 일 (한 줄)

**S34 리뷰가 낸 high 2건을 고치고 → 재리뷰(클린까지) → S5 문서 → 커밋.** 아래 2번 절이 그 2건의 완전한 명세다.

---

## 1. 현재 상태 (검증된 사실 — 2026-07-18 확인)

| 항목 | 값 |
|---|---|
| 레포 | `/Users/chabh/workspace/ch-regulated-harness` |
| 브랜치 | `fix/chat-w2-codex` (main = `a8188c0`, **아직 병합 안 함**) |
| 커밋됨 | `6158f44`(W2 리뷰수정) · `a5817f8`(Wave1 큐 펜싱) · `66b6c9b`(Wave2 세션 조립) |
| **미커밋**(워킹트리) | Wave3 전체 + 재설계 S1~S4: `chat/src/worker/{supervisor,cli-session-runner,run-domain,ownership}.ts` + 각 테스트(신규) · `chat/src/kernel/{contract-client,worker}.ts` + 테스트(수정) |
| 검증 | build ✓ · 단위 **708/708** ✓ · stub E2E **4/4** ✓ · `core/` 무수정 ✓ |
| 중단 사유 | 세션 사용 한도. 마지막 서브에이전트는 **탐색 중 종료 → 편집 0** (트리 깨끗함을 재검증 완료) |

**주의**: 워킹트리에 커밋 안 된 작업이 많다. 커밋 전에 날리지 말 것.

---

## 2. 멈춘 작업 — S34 리뷰의 high 2건 (미수정, 완전 명세)

두 건 모두 nonce 원장 재설계의 **핵심 배선** 결함이다. 파일: `chat/src/worker/supervisor.ts` · `chat/src/worker/ownership.ts` + 각 테스트.

### high#1 — register 실패 경로가 소멸 확인 없이 `reaped` 로 처분 (살아있는 그룹 유실)

- **위치**: `supervisor.ts` 의 `superviseSession` 안, `ledger.register(nonce, pgid)` 가 throw 하는 분기(대략 357~367행).
- **현상**: register 가 실패하면 그룹에 SIGKILL 을 보낸 **직후 확인 없이** 인메모리 release + `ledger.settle(nonce, "reaped")` 한다. `reaped` 는 pgid 를 버리므로(`ownership.ts` ~399행), **그룹이 SIGKILL 을 견디면 추적 수단이 사라진다** — 종료 전파 대상도 없고 데몬은 reaped 를 GC 한다.
- **왜 결함인가**: 정규 `reap_failed` 경로는 이미 `leaked`(잔존)로 올바른데, **register 실패라는 별도 가지**만 처분-무지(disposition-blind)로 남았다. 원래 high#1(처분 무지)이 이 가지에 살아남은 것.
- **처방**: register 실패 후 **정규 reap-verify 와 같은 로직**으로 그룹 소멸을 확인한다(`groupAlive(pgid)` — kill_at reap 이 쓰는 그 검사). 소멸 확인 → `reaped` + release(현행). **살아있으면 → `leaked` + 인메모리 엔트리 유지**(종료 전파가 계속 겨냥하게). 병렬 로직을 새로 만들지 말고 기존 것을 재사용할 것.
- **⚠ 테스트가 결함을 고정 중**: `supervisor.test.ts` ~641행이 `groupAlive: () => true` 인데 reaped+release 를 기대한다 → **그 테스트를 다시 써야 한다**(현재는 버그를 핀으로 박아둔 상태).
- **핀**: register 실패 + 그룹이 SIGKILL 생존 → `leaked`(reaped 아님), 인메모리 엔트리 잔존.

### high#2 — start-time 신원: 생산자 ms vs 소비자 초, `===` 비교라 영원히 불일치 → 살아있는 supervisor 의 세션을 kill

- **위치**: 생산자 `supervisor.ts` ~775행(`startedAtMs = Date.now() - process.uptime()*1000`) · 소비자 `ownership.ts` ~494행(`evaluateReap` 의 owner-identity strict `===`).
- **현상**: 생산자는 **밀리초** 근사, 데몬은 `ps -o lstart`(**초** 단위 커널 값)를 읽는다. `===` 비교라 **절대 같아질 수 없다** → `alive && 불일치` → "PID 재사용된 남의 supervisor" 판정 → reap 진행 → 그 세션의 nonce 는 당연히 일치 → **`kill` 결정** → 데몬이 **살아있는 정상 supervisor 의 세션을 죽인다.**
- **처방(허용오차 도입)**: 이 신원검사의 진짜 임무는 "**같은** supervisor 프로세스(자기측정 vs ps 사이의 초 미만~초 단위 지터)" 와 "**다른** 프로세스가 PID 재사용(옛 프로세스 사망→새 프로세스 기동이라 필연적으로 수 초~수 분 차이)" 를 가르는 것이다.
  - `evaluateReap` 의 비교를 `Math.abs(observed - ledger) <= START_TIME_TOLERANCE_MS` 로(예 2000ms). **그 값을 정당화하는 주석 필수**: 지터보다 넉넉하고 실제 PID 재사용 간격보다 한참 작아야 한다.
  - 허용오차 안 → 같은 supervisor → 기존 `alive+match → wait` 경로. 벗어나면 → 기존 reap-진행 경로. **`null`(unknown, 관측 실패) → `wait` 유지**(앞 라운드에서 고친 안전 방향 — 되돌리지 말 것).
  - 생산자는 ms 근사 유지(자기측정의 한계). **모듈 헤더의 W3↔W4 계약을 생산자↔소비자 정합하게** 고쳐라: 데몬은 `ps -o lstart` 를 ms 로 환산해 **허용오차로** 비교한다고 명시.
  - **정직 유지**: 허용오차 신원은 이식 경로의 **강한 휴리스틱이지 완전한 커널 신원이 아니다**(완전한 건 Linux cgroup). **nonce 가 여전히 1차 방어**이고 이 검사는 "살아있는 주인에게 양보할지"만 정한다 — 실패 방향은 항상 안전(kill 보다 wait/refuse).
- **핀**: 생산자-ms vs 초-절삭 관측값이 허용오차 안 → `wait`(kill 아님) · 명백히 다른 시각 → reap 경로 · null → wait.

---

## 3. 그다음 (S34 클린 이후)

1. **S5 — 문서 정본화**(마지막 스테이지). 소유 파일: `docs/plans/chat-unmanned-consumer-plan.md` · `docs/plans/chat-dual-surface-plan.md`.
   - **잠긴 결정 4 의 2차 개정**을 명문 기록: "데몬은 파일의 pgid 를 직격하지 않고 **nonce 검증-후-kill + 스캔**". 1차 개정(SIGTERM 전파 계약)과 같은 격으로 **사람 승인 대상**임을 표기(조용한 변경 금지).
   - dual-surface `:116`·`:280` 의 "데몬이 `kill(-supervisorPid)`(그룹째)" 산문이 **거짓**이므로 교체.
   - W3 행을 부록A-11 정본으로 갱신(프리앰블·`cwd=core` 옛 문장은 이미 폐기됨).
   - W5 카나리 목록 기재(아래 5번 절).
   - `bash core/tests/test-docs-integrity.sh` 그린 확인.
2. **Wave 3 커밋**(재설계 전체를 하나의 응집 단위로). `main` 병합은 **사람 확인 후**.

---

## 4. 작업 규약 (이 세션에서 확립된 것 — 반드시 지킬 것)

- **검증은 직접 재실행한다**(서브에이전트 보고를 믿지 않는다):
  ```bash
  cd chat && pnpm build && pnpm test
  HARNESS_ROOT=/Users/chabh/workspace/ch-regulated-harness/core pnpm test:integration   # 반드시 단독 실행
  git -C .. status --short core/    # 비어야 함
  ```
- **⚠ chat E2E 는 동시 실행 불가**: 고정 run id(`chat-e2e-*`)를 공유 `core/runs/` 에 쓰고 `beforeAll` 이 `rmSync` 한다 → 병렬 실행 시 서로의 런을 지워 **간헐 실패·가짜 skip**. 실패를 보면 `pgrep -fl "run-stage.sh|vitest"` 로 경쟁 확인 후 **조용한 창에서 재실행**. (메모리에도 기록됨: `harness-test-env-fragility` 함정 6)
- **Codex 리뷰 실행 형태**(백그라운드 필수 3종):
  ```bash
  nohup codex exec --sandbox read-only --skip-git-repo-check "$(cat <프롬프트파일>)" </dev/null > <로그> 2>&1 &
  ```
  `</dev/null` 없으면 stdin 대기로 무한정 멈춘다. 리뷰는 10~25분 걸리므로 포그라운드 금지.
- **무력화 실험(neuter)**: 수정마다 "가드를 되돌리면 그 테스트가 **밀리초 안에** 깨지는가"를 확인시킨다. 이 파일 계열은 잘못 짠 테스트가 **행(hang)** 되므로 가짜 시계·가짜 spawn 필수.
- **서브에이전트 주장은 원전 대조 후 수용**. 이 세션에서 미검증 전파로 2번 틀렸다(토폴로지 상속 모순 오독, 하트비트 first-vs-later 착오). 계획서·코드 원문을 직접 열어볼 것.
- **소유 파일 경계**를 서브에이전트에 명시하고, 병렬은 **파일이 서로소일 때만**.

---

## 5. 미해결·승계 항목 (닫지 말고 인지만)

- **ⓓ 과금 귀속 확인** — 사람의 콘솔 확인. W3 는 전부 오프라인이라 저촉 없으나 **W5(라이브)·데몬 활성화의 게이트**.
- **W5 라이브 카나리**: ① `ps -E` 가 이 macOS 에서 세션의 nonce 를 실제로 노출하는가 ② **Bash 손자가 nonce 를 상속하는가**(미상속이면 마감 강제 약화 — 실패 방향은 안전) ③ register 창에서 supervisor 를 실제 `kill -9` 했을 때 스캔 경로가 실프로세스를 회수하는가 ④ 그룹 SIGKILL 이 detached 하위그룹·Bash 손자까지 실제 소멸시키는가 ⑤ `--allowedTools` 다중 규칙 argv 형태(**미실측** — 규칙별 토큰으로 조립했고 틀리면 fail-closed) ⑥ 격리 settings 의 `//abs/**` deny 글롭이 의도대로 매칭되는가(⚠ `acceptEdits` 라 cwd 안 쓰기가 자동승인 → 이 deny 가 `state.json` 직접쓰기를 막는 **유일한** 장치).
- **Darwin 원리적 잔여**(정직 고지 유지, 숨기지 말 것): 검증→신호 사이 짧은 비원자 창 · env 세탁 후 re-exec 손자. **cgroup 만 완전 폐쇄**.
- **`writePendingJob`** 은 운영에서 죽었지만 export 존치 — 미래 호출자가 봇 경로에서 쓰면 큐 펜싱(㉠)이 되살아난다(주석 방어뿐).
- **잠긴 결정 4 는 이미 2번 개정됨**(SIGTERM 전파 · nonce 검증-후-kill) — 둘 다 **사람 승인 대상**으로 S5 에서 기록해야 한다.
- **W4(데몬)는 미구현**: `src/worker/**` 는 아직 운영 코드에 **배선 0**(호출부 없음). 그래서 위 결함들의 오늘 운영 도달성은 없다 — 그러나 W4 가 붙는 순간 전부 활성이다.

---

## 6. 참고 자료 위치

- 리뷰 로그·diff·프롬프트: `.dev-loop-w2/` (git-excluded)
  - 최신 판정: `wave3rd-s34-review.log` (S34: high 2건 = 위 2번 절)
  - 재설계 토대 리뷰: `wave3rd-s12-r2-review.log` (critical/high 0 통과)
- 루프 상태: `.dev-loop-state.json`
- 설계 정본: `docs/plans/chat-unmanned-consumer-plan.md`(**부록A = 라이브 실측 SSoT · 계획 본문보다 우선**) · `docs/plans/chat-dual-surface-plan.md`
- 규칙 SSoT: `core/AGENTS.md`(불변 — `state.json` 은 `scripts/*.sh` 만 쓴다 · 결정은 사람)
