# 무인 생성 소비자(cli-consumer) 구현 계획 — 실 CLI 세션 워커

> **지위**: `docs/plans/`(진행 중 계획). **작성**: 2026-07-16 · **갱신 2026-07-17**: 진행 상태 최신화 —
> **W0·W1·W2 완료**(W1 은 ⓓ 과금 귀속 제외) · **W3 완료(조건부 — 단위 711/711 · Codex 잔여 1건은 W4/사람 승인 승계)** · **W4~W5 잔존** · W5 재료 정정(v1 잡은 데몬이 안 집는다 → 재적재 필요).
> **갱신 2026-07-19**: **W4 완료(조건부 — 사람 승인 대기 1건)**. 데몬(`chat/src/worker/cli-consumer.ts` + `main.ts`)이 폴링·클레임·소비·리퍼(큐+소유권)·관측로그·enablement·동시성1 을 구현. `evaluateReap` 의 **첫 소비자**로 nonce 검증-후-kill 을 배선했고, S34-R2 잔여를 **killAt-바운드 에스컬레이션**으로 폐쇄했다 — 이는 **잠긴 결정 4 개정**이라 **사람 승인 대상**(아래 개정 노트 3차). **W5 잔존**(라이브 활성화). 검증: build ✓ · chat 단위 831/831 ✓(cli-consumer 24 + config 게터 11 추가 · Codex R1 4×P1+3×P2 → 5수정+1이미수정+1 X-class) · stub E2E 5/5 ✓(신규 데몬 1 + 기존 4 불변) · kernel-neutral green · core 무수정 ✓.
> **관계**: [`chat-dual-surface-plan.md`](chat-dual-surface-plan.md)(r8, Codex 클린)의 **Q2·Q3 실행 계획**이다 — 단
> r8 의 "Agent SDK 세션" 전제를 **정책 실측에 따라 '실 `claude` CLI 세션'으로 정정**한다(아래 잠긴 결정 1 · W0).
> Q1(헤드리스 NL 파서)은 구현·Codex 클린·라이브 검증 완료 — 그 실측 자산을 재사용한다.
> 규칙 SSoT = [`../../core/AGENTS.md`](../../core/AGENTS.md)(불변). **core 무수정 원칙 유지.**

---

## 0. 한 줄 정의

봇(BridgeGenExecutor)이 `chat/jobs/pending/` 에 적재한 생성 잡을, **사람 운영자 대신 데몬이 실 `claude` CLI
세션을 잡마다 띄워** 소비한다(산출물 작성 → 세션 안 insession 전이). 사람 관점 무인, core 관점 insession —
core 게이트·승인·심의는 전부 불변이고, 무인화 범위는 '생성'뿐이다.

## 1. 잠긴 결정 (2026-07-16 — r8 승계 + 정정 1건)

| # | 결정 | 근거 |
|---|---|---|
| 1 | **무인 세션 = Agent SDK 가 아니라 실 `claude` CLI spawn** (r8 정정) | 정책 실측(2026-07-15, 공식 legal 문서): 구독 OAuth 는 "ordinary use of Claude Code(공식 CLI)"에만 허용, **Agent SDK 를 포함한 제품/서비스 개발은 API 키를 쓰라**고 명문 + 2026-01-09 부터 구독 OAuth 의 SDK 인증은 **서버측 차단**. 실 CLI 는 Q1 이 이미 같은 인증(OAuth 주입)으로 라이브 검증함. 부수 이점: 실 CLI 는 자기 Bash 도구에 마커(`CLAUDECODE`)를 스스로 주입할 가능성이 높아(W1-ⓐ 실측) r8 R-9(마커 명시 주입 논쟁)가 소멸할 수 있다 |
| 2 | **도구 경계 = CLI 네이티브 통제로 재설계** — r8 의 SDK `canUseTool` 콜백 대신: ① `--allowedTools` 정확 지정(전이·emit-context Bash 규칙 + 경로 스코프 Edit/Write) ② **격리 `CLAUDE_CODE_CONFIG` 디렉터리의 `settings.json` `permissions.deny`**(읽기 경계: `.env`·타 런·jobs·자격증명 경로 — CONFIG_DIR 는 워커 소유라 완전 통제) ③ `--disallowedTools` 2차 방어(승인류 스크립트) ④ `--max-turns` 턴 상한 | 경계 철학(r8)은 유지 — "프롬프트가 아니라 코드(여기선 CLI 설정)가 경계". CLI 2.1.210 실측 플래그만 사용(추측 금지, W1 에서 재실측) |
| 3 | **소비자 프로토콜 v2 승계**(r8 결정 2) — `expires_at` 절대 마감 + 클레임-by-rename + 2중 검사 + 보증 3분법(데몬=구조적 kill_at · 사람=절차 · 봇=[상태 다시 확인] 화해 버튼) | r8 에서 Codex 클린까지 다듬은 설계 그대로 — 메커니즘(SDK→CLI)과 무관 |
| 4 | **supervisor 토폴로지·검증된 정적 마감 승계**(r8 결정 4) — 잡당 detached supervisor(그룹 리더)가 주/복구 세션 spawn, TERM=`kill_at-유예₁`·KILL=`kill_at-유예₂`(마감 전)·`kill_at`=reap 확인. ⚠ **r8 의 '전이 요청은 마감 후 거부'는 승계하지 않는다**(2026-07-16 결정) — 그 층은 SDK 의 호출별 허용 콜백으로 구현됐는데 **실 CLI 엔 대응물이 없다**(부록A-7 4번). 마감 강제는 **supervisor 단층**(TERM/KILL/reap)으로 한정하고, 마감 직전 시작된 전이가 늦게 성공하는 창은 **프로토콜 v2 의 [상태 다시 확인] 화해 버튼**(R-4)과 core 락이 흡수한다 — 늦은 전이는 그 자체로 유해하지 않다(core 가 진실의 출처이고 게이트는 정당하게 전진한 것). r8 의 거부층은 이중 안전장치였지 필수가 아니었다 | spawn 대상만 SDK→CLI + 거부층 삭제 |
| 5 | **결정은 사람·단계별 enablement·과금 활성화 게이트 승계**(r8 결정 6·7·8) — 승인/선택/RA 는 Slack 버튼, `CHAT_SDK_STAGES` 에 실측 통과 단계만, 과금 귀속은 실측 확인 | 불변 |
| 6 | **위생·인증 = Q1 자산 재사용** — `hygienicSpawnEnv`(화이트리스트 재구성·스크럽·`HARNESS_ACK_GAPS=0` 핀) + **OAuth 토큰 주입**(격리 CONFIG_DIR 가 로컬 로그인을 가리므로 — Q1 실측) + `ANTHROPIC_API_KEY`/`AUTH_TOKEN` 스크럽(API 과금 구조적 차단) | 전부 Q1 에서 라이브 검증됨(구독 과금·유출 차단 실증) |

> ⚠ **잠긴 결정 4 — 3차례 개정(전부 사람 승인 대상 · 조용한 변경 금지)**: W3 재설계(nonce 소유권 원장)가 원래
> supervisor 토폴로지를 두 번 정련했고(1·2차), W4 가 S34-R2 잔여를 닫는 세 번째 개정을 구현했다.
> **코드가 이미 구현했으므로 이 기록은 사후 승인 요청이다**(원 잠긴 결정을 바꾸므로 재합의 없이 확정으로 취급하지
> 말 것). dual-surface 잠긴 결정 4 개정 노트와 동일 내용이다.
> - **1차 개정 — 종료 전파**: supervisor 는 `SIGTERM`/`SIGINT`/정상 exit 시 자기 그룹을 빠져나가기 **전에** 살아있는
>   세션 하위그룹을 전부 `kill(-sessionPgid, SIGKILL)` 한다(in-memory `SessionGroupRegistry` ·
>   `installSupervisorTerminationHandlers`). 데몬 회수의 우아한 1경로 = **supervisor 에 `SIGTERM` 먼저**.
> - **2차 개정 — nonce 검증-후-kill + 스캔(데몬은 파일 pgid 직격 금지)**: 세션마다 재사용불가 nonce
>   (`CHAT_SESSION_NONCE`)를 exec-env 로 주입 → 데몬은 대상 그룹의 exec-env nonce 를 **신호 직전 검증한 뒤에만**
>   `kill(-pgid)`, register-lag 창은 nonce **스캔**으로 발견 회수(raw-PID 하트비트 폐기 · SSoT =
>   `chat/src/worker/ownership.ts` 헤더). 근거: 5라운드 리뷰가 raw pgid 의 register-lag·PID 재사용 미판별을 증명.
> - **3차 개정 — killAt-바운드 에스컬레이션(W4 구현 · ★사람 승인 대기)**: `reapOwnershipLedgers`(`cli-consumer.ts`)가
>   `evaluateReap` 의 첫 소비자로서, 세션이 자기 `killAt + REGISTER_LAG_MARGIN` 을 넘겨 살아있으면 evaluateReap 이
>   `wait`(owner 살아있음/신원확인 불가)를 돌려도 **백스톱으로 회수**한다. 이는 "살아있는 owner 세션을 뺏지 않는다"는
>   W3 의 안전 기본값을 **의도적으로 넘어서는** 정책이라 잠긴 결정 4 의 개정이다. 안전 제약 둘로 봉인한다: ①오직
>   마감을 넘긴 세션에만 ②오직 **nonce 검증-후-kill**(맨몸 pgid 신호 절대 없음 · 회귀 테스트가 못 박음). 이것이
>   S34-R2 잔여(허용오차 안 supervisor PID 재사용 시 고아 영구 보류)의 폐쇄 경로다. **사람 승인 필요** — 승인 전까진
>   '구현됐으나 미승인' 상태로 둔다(끄려면 escalate 분기 제거).
> - ⚠ **포터블 잔여(정직 고지 · X-class · STALL-LOG 2026-07-18)**: PID 재사용은 **좁혀질 뿐 완전히 닫히지 않는다** —
>   ① verify→signal ms급 비원자 창(Darwin 은 nonce 검증과 그룹 신호를 원자로 묶을 수 없다) ② 실 `ps`/`pgrep`
>   ProcView 는 라이브 전용이라 exec-env nonce 노출·되읽기가 실세션에서만 확증된다(W5 카나리). **완전 폐쇄 = cgroup v2
>   (`cgroup.kill`, 그룹 멤버십이 커널 진실)뿐**이고, 그 외 경로는 nonce 검증-후-kill 로 좁히는 게 최선이다(X-class).

## 2. 이미 확보된 실측 (Q1 라이브 — 재검증 불필요)

| 사실 | 출처 |
|---|---|
| 격리 CONFIG_DIR + `CLAUDE_CODE_OAUTH_TOKEN` env 주입으로 헤드리스 인증 성립, 과금=구독(`total_cost_usd` 는 환산치) | Q1 스모크(봉투 `is_error:false`) |
| `ANTHROPIC_API_KEY`/`AUTH_TOKEN` 스크럽 시 API 과금 경로 물리적 부재(인증 우선순위 3·2위 제거 → OAuth 5위만) | 공식 authentication 문서 + Q1 코드/테스트 |
| CLI 2.1.210 플래그: `--tools`(가용 도구 집합)·`--allowedTools`/`--disallowedTools`(승인 규칙)·`--json-schema`(인라인)·`--max-turns`·`--permission-mode` | `claude --help` 실측 |
| detached spawn + 그룹 KILL + stdin ignore + 출력 캡 패턴 | Q1 `cli-parser.ts` 러너(Codex 클린) |
| 봉투의 `num_turns`/`stop_reason` 은 위험 신호가 아님(구조화출력 메커니즘) — 실제 도구 흔적은 `permission_denials` 등 | Q1 재보정 실측 |

## 3. 구현 스테이지 (dev-loop — 각 단계 Codex critical/high 0 후 다음)

| 단계 | 내용 | DoD |
|---|---|---|
| **W0** 계획 정정(문서만) | [`chat-dual-surface-plan.md`](chat-dual-surface-plan.md) 를 r9 로: Q2/Q3 의 "Agent SDK 세션"→"실 CLI 세션", 도구 경계 절을 CLI 네이티브 통제로 교체, 근거(정책 실측) 명기. [`agent-sdk-unmanned-worker-research.md`](../reference/agent-sdk-unmanned-worker-research.md) 에 정책 확정 추기(스냅샷 지위라 원문 유지 + 추기) | **완료** — dual-surface r9 반영 후 W1 실측을 흡수해 **r10** 까지 진행 · docs-integrity 15/15 green |
| **W1** Q2 실측 스파이크(코드 0 · 반나절) | ⓐ **마커**: 도구 켠 `claude -p`(cwd=스크래치, `--allowedTools "Bash(env*)"` 류 최소 허용)로 Bash 서브프로세스의 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` 실측 — 네이티브면 주입 불요 확정, 아니면 세션 env 주입(r8 근거 승계) ⓑ **CLI 통제 실측**: `--allowedTools` 정확 문자열 규칙·경로 스코프 Edit 규칙·격리 settings `permissions.deny` 가 실제로 막는지 스모크 ⓒ **스킬-게이트 dry-run**: 스크래치 런에서 intake·brief 각 1회 — SKILL.md 프롬프트로 실 CLI 세션이 산출물 작성→insession 전이→next-action 도달까지. 여기서 enablement 초기 목록·보조 도구 필요 목록 수확 ⓓ 과금 귀속 재확인(1런) | **완료(ⓓ 제외)** — 결과 = 부록A(2026-07-16 · claude 2.1.211). ⓐ 통과(마커 네이티브 주입 → R-2 소멸) · ⓑ 통과(단 경계 모델이 실측과 달라 4번 절 정정 — 실제 모델이 더 강함) · ⓒ brief·intake 둘 다 무인 완주 후 사람 승인 게이트에서 정지 · **ⓓ 과금 귀속 = 미완**(사람의 콘솔 확인 · 코드로 대체 불가) → **잠긴 결정 5(과금 활성화 게이트)상 W3 착수 전 해소 필요** |
| **W2** 큐 프로토콜 v2 + 브리지 additive | `expires_at`(=enqueue+`CHAT_BRIDGE_TIMEOUT`) 기재 · 클레임-by-rename(`pending/→claimed/<consumer>/→성공 삭제·실패 failed/+.reason`) · 클레임/reaper 2중 검사(잔여시간·next-action) · 봇 타임아웃 시 pending 회수 · 실패 카드 **[상태 다시 확인] 버튼**(늦은 전이 화해) · `CHAT_BRIDGE_TIMEOUT` env 승격(기본 900초) · `chat/jobs/README.md` v2 개정(사람 소비자 규약 포함) | **완료** — 코드 SSoT = `src/kernel/job-protocol.ts`(+`types/jobs.ts` 의 `expires_at` · `config.ts` 의 `CHAT_BRIDGE_TIMEOUT` 승격 · `presentation.ts` 의 [상태 다시 확인]·[다시 만들기]). 검증(2026-07-17): build ✓ · 단위 425/425 ✓(job-protocol 54건 포함) · stub E2E 4/4 ✓ · core 무수정 ✓ · docs-integrity 15/15 ✓ (2026-07-17 재검증: 단위 **454/454**). **Codex 리뷰 R1~R4**: R1(P1 1 + P2 6) 전부 수정 → R2(critical 0·high 2·med 2) → **수정 2건**[high#1 이중 잡 적재 가드 · med#3 마감 파싱 엄격화] → R3(신규 high 1 = 가드 비원자성) → **수정 1건**[재검사·보상] → **R4 = critical 0 · high 1 · med 2**. ⚠ **남은 high 1건 = 프로토콜 결정 대기(사람)** — 상세는 아래 'W2 리뷰 잔여' 절. 그 결정 전까지 W2 는 **조건부 완료**(기능·테스트는 그린, 큐 원자성 결정만 미결) |
| **W3** cli-session-runner | 잡당 fresh 실 CLI 세션 spawn 모듈(`cli-session.ts`·`cli-session-runner.ts`·`supervisor.ts`·`ownership.ts`·`run-domain.ts`·`skill-rewrite.ts`): 프롬프트=**워커가 `skills/<stage>/SKILL.md` 를 결정론적으로 치환**(절대 스크립트 경로+rid · **프리앰블 없음** — 부록A-10/A-11) · **cwd=런 디렉터리**(`core/runs/<rid>`, **cwd=core 아님** — 부록A-4) + `--add-dir` 고정 경로 · env=`hygienicSpawnEnv`(+OAuth 주입·ACK_GAPS=0 핀·`CODEX_*` 스크럽) · CLI 통제(잠긴 결정 2·3 — W1-ⓑ 실측 · `--setting-sources user`) · supervisor(detached)+`kill_at`(TERM/KILL/reap) + **nonce 소유권 원장**(raw-PID 하트비트 대체 · 잠긴 결정 4 2차 개정) · `--max-turns` · 복구 세션(전이 1건만 허용) 백스톱 | **완료(조건부)** — build ✓ · 단위 **711/711** ✓(worker+kernel fake spawn/fs · 적대 우회 표 · settings 결정성) · stub E2E 4/4 ✓ · core 무수정 ✓. **Codex 리뷰**: 재설계 전 R1~R5(근본 재설계 필요) → **[A] Fable 재설계**(nonce 원장) S12(critical/high 0) → S34-R2(**critical/high 1 = 인지·수용된 설계 잔여**: `START_TIME_TOLERANCE` 아래쪽 PID 재사용 보류 · 실패 방향 안전[wait] · W4/cgroup 이관 · 위 개정 노트) + medium 1 수정(공허 assertion 핀 강화). **잔여 1건 = 사람 승인·W4 설계 요구로 승계**(오늘 도달 불가 — `evaluateReap` 소비자 부재) |
| **W4** cli-consumer 데몬 | 별도 프로세스(`chat/src/worker/cli-consumer.ts` + `main.ts`): 폴링→2중 검사→클레임→세션 러너→next-action 전이 확인→복구 백스톱→성공 삭제/실패 failed/ · 기동 reaper(큐+소유권)·동시성 1 · `CHAT_SDK_STAGES` enablement(미등재 단계 잡은 안 집음) · 잡당 1줄 관측 로그(rid·stage·대기·소요·턴·비용·결과) | **완료(조건부 — 사람 승인 대기 1건)** — build ✓ · chat 단위 **831/831** ✓(cli-consumer 24 + config 게터 11 추가 · Codex R1 4×P1+3×P2 → 5수정+1이미수정+1 X-class) · stub E2E **5/5** ✓(신규 데몬 1잡 완주 + 기존 4 불변) · kernel-neutral green · core 무수정 ✓. 잡세션 seam = 온라인 detached supervisor spawn(라이브 전용) · 오프라인 run-stage 직접(stub). **소유권 리퍼가 `evaluateReap` 의 첫 소비자** — nonce 검증-후-kill(PID 재사용 그룹 거부) + 미지 원장버전 거부 + **killAt-바운드 에스컬레이션**(★잠긴 결정 4 3차 개정 · **사람 승인 대기** · 위 개정 노트). ⚠ 관측 로그의 **턴·비용은 세션 봉투 필드라 W3 `RunJobResult` 계약에 없어 '-' 로 표기**(surfacing = W3 계약 변경 = 범위 밖). ⚠ 온라인 spawn·실 `ps`/`pgrep` ProcView·실 신호는 **라이브 전용**(W5 카나리). **Codex 리뷰 대기** |
| **W5** 라이브 검증 | 걸려 있는 실런(`chat-slack-…895939` — intake 생성 대기)을 W5 재료로: 데몬 기동 → **intake→brief 무인 완주**(Slack 카드가 자동 전진). ⚠ **재료 정정(2026-07-17)** — 그 런의 `jobs/pending/` 잡은 **v1 형식(`expires_at` 부재)**이라 W2 의 클레임 2중 검사가 `no_deadline` 으로 판정해 **데몬이 집지 않는다**(마감을 못 걸면 구조적 보증이 성립 안 하므로 — 사람 소비자 몫. `job-protocol.ts` · 단위 테스트로 고정). 데몬 재료로 쓰려면 **새 마감의 잡으로 재적재**해야 한다 — 그 런은 여전히 intake 생성 차례라 화해 경로의 **[다시 만들기]**(next-action 재조회 후 새 `expires_at` 으로 적재)가 정규 출구다 · 도구 경계 스모크(승인류·경로 밖 거부 실증) · kill_at 그룹 kill 동작 · **nonce/소유권 카나리**(부록A·잠긴 결정 4 개정 노트 — 순수 단위 테스트가 fake procView 로 못 박는 실프로세스 사실들): ① `ps -E` 가 세션 nonce 를 실제 노출 ② Bash 손자가 nonce 상속(미상속=마감 강제 약화·실패 방향 안전) ③ register 창에서 supervisor `kill -9` 시 nonce 스캔 경로가 실프로세스 회수 ④ 그룹 SIGKILL 이 detached 하위그룹·Bash 손자까지 소멸 ⑤ `--allowedTools` 다중 규칙 argv 형태(미실측 — 틀리면 fail-closed) ⑥ 격리 settings `//abs/**` deny 글롭 매칭 ⑦ supervisor PID 가 `START_TIME_TOLERANCE_MS`(2초) 안에 재사용되지 않음(S34-R2 잔여 — 위반 시 회수 보류이므로 W4 killAt-바운드 에스컬레이션 필요) · 이후 단계(concept·storyboard) enablement 확장, keyvisual 은 마지막(이미지 비용) | 계획 DoD 충족 · 라이브 체크리스트 갱신 · 본 문서에 결과 추기 |

### 3-1. W2 리뷰 잔여 (Codex R1~R4 · 2026-07-17) — **사람 결정 대기**

R4 가 남긴 3건이다. **뿌리가 하나다: 큐에 펜싱(소유권 무효화)이 없다** — 그래서 개별 패치가 아니라 한 번에 설계하는 게 맞다.

| # | 판정 | 무엇 | 왜 지금 안 고쳤나 |
|---|---|---|---|
| ㉠ | **high** | **보상 경합**(`gen-executor.ts` 적재 경로): 검사→적재→재검사→보상(자기 잡 회수)로 창을 좁혔으나 **0 이 아니다**. C2 가 재검사보다 먼저 우리 잡을 집으면 회수 실패(남의 클레임은 못 되돌린다) → C1·C2 동시 실행. **R4 정정**: 창은 'µs' 가 아니라 `readdir`+소비자별 순차 `readFile`+pending 재읽기+`unlink` 에 걸친 **상한 없는 구간**이고, C2 선클레임뿐 아니라 **회수 IO 실패**로도 보상이 무력화된다. 실패로 보고하므로(fail-closed) 조용한 통과는 없지만 이중 과금·산출물 동시쓰기는 일어난다 | 완전 폐쇄 = **원자 적재 또는 동등한 펜싱** = 잠긴 결정 2 의 큐 프로토콜 변경. ⚠ **R4 정정**: no-clobber 자체는 '마감 단일 원천'(불변식 1)과 충돌하지 않는다(기존 잡을 채택하면 그 잡의 `expires_at` 을 함께 채택하면 된다). 실제로 충돌하는 것은 **"재요청이 기존 pending 을 더 신선한 요청으로 덮어쓴다"는 현행 정책**(`writePendingJob` 주석)이다. 그 정책을 바꿀지가 결정 사항 |
| ㉡ | ~~medium~~ **폐쇄(W4)** | **휴면 reaper 의 무펜싱 재큐**(`reapClaimedJobs`): `isConsumerAlive=false` 를 실제 사망으로 신뢰 → 하트비트를 일시적으로 놓친 살아있는 C1 의 잡을 재큐 → C2 와 동시 실행. 펜싱 토큰 없음 | **폐쇄(2026-07-19 · W4)**: 두 층으로 닫혔다. ① **큐 리퍼**(`reapClaimedJobs`)는 W2/W3 에서 이미 **마감(리스) 기반**으로 재작성됐다 — `isConsumerAlive` 를 안 쓰고 **재큐하지 않는다**(생사추정 폐기 · job-protocol 헤더). ② **프로세스 회수의 펜싱** = W4 의 소유권 리퍼(`reapOwnershipLedgers`)가 `evaluateReap` + **exec-env nonce 검증-후-kill** 로 배선했다(하트비트 아님 · PID 재사용 그룹은 신호 거부). 즉 '재큐로 이중 실행'의 두 원천(큐·프로세스)이 모두 펜싱됐다 |
| ㉢ | medium | **`failJob` 부분 성공**: `rename` 후 `.reason` 쓰기가 ENOSPC/EACCES/EISDIR 로 실패하면 사유 없는 failed 잡이 남는다(원래 claimed 경로는 이미 없어 복귀 불가) | 코드 주석이 **반대 순서(사유 먼저)의 더 나쁜 결함**(경합 패자가 승자의 사유 파일 삭제)을 논증하고 트레이드오프를 명시 수용한다. ⚠ **R3/R4 반대 의견**: 그 주석은 경합 순서만 논증할 뿐 부분 성공을 제거하지 못하며, 위험이 '프로세스 사망 µs 창'에 한정되지 않는다(디스크·권한). 선택지는 두 순서만이 아니고 **원자 실패 레코드/복구 가능한 저널**이 있다 |

**권고**: ㉠·㉡ 는 같은 뿌리(펜싱 부재)이므로 **W3/W4 에서 한 번에 설계**한다(㉡ 은 그때 활성화되므로 어차피 그 시점 결정이고, ㉠ 의 원자 적재도 소비자 규약을 함께 바꾸므로 소비자를 만드는 단계가 제자리다). 그때까지 ㉠ 의 노출: 봇이 **단일 적재자**이고 트리거가 '옛 pending 잔존 + 그 창에 클레임'이라 좁으며, 실패로 보고된다(조용한 성공 없음).

## 4. 도구 경계 상세 (잠긴 결정 2 의 구체화 — W1-ⓑ 실측으로 확정)

무인 생성 세션은 파서(도구 0)와 달리 **도구가 필요**하다(파일 작성 + 전이 Bash). 경계는 3층:

1. **허용(정확·최소)**: `--allowedTools` 에
   - `Bash(bash scripts/run-stage.sh <stage> <rid>*)` — 전이·emit-context(인자 잡 값 고정)
   - 스테이지별 보조 Bash 규칙(W1-ⓒ 수확분 — 예: guideline 의 `examples_analysis.py`)
   - `Edit`/`Write` — 격리 settings 의 경로 규칙으로 `runs/<rid>/<단계 산출물 디렉터리>/**` 로 스코프
   - `Read`/`Glob`/`Grep` — 읽기(아래 deny 가 경계)
2. **거부(명시)**: 격리 `CLAUDE_CONFIG_DIR/settings.json` `permissions.deny` 에
   - 읽기: `.env`(어디든)·타 런 `runs/*`(자기 rid 제외)·`chat/jobs/**`·`~/.claude/**`
   - 쓰기: `state.json`·`run.md`·`.lock`·런 밖
   - Bash: `approve.sh|select.sh|revise.sh|gate.sh|kcia-check.sh|new-run.sh|ingest-bundle.sh|intake.sh|apply-*|advance-phase` (결정·상태변이 — 결정은 사람)
3. **상한**: `--max-turns`(기본 50) + 잡 wall-clock(`CHAT_SDK_GEN_TIMEOUT`, supervisor kill) + 출력 캡.

CONFIG_DIR 는 워커가 잡마다 생성하는 **워커 소유 디렉터리**라 사용자 훅/플러그인/MCP/`apiKeyHelper` 는 애초에
없고(과금·행동 우회 차단 — Q1 검증), settings 내용은 코드가 결정론적으로 쓴다(단위 테스트 대상).
⚠ 규칙 문법·매칭 동작은 **W1-ⓑ 에서 실측 확정**(추측 금지 — Q1 의 `--tools` 교훈).

## 5. env 규약 (chat 레이어 — `chat/README.md` 소유)

| env | 기본 | 뜻 |
|---|---|---|
| `CHAT_BRIDGE_TIMEOUT` | `900` | 봇 생성 대기 상한(초) — 하드코딩 600 승격. `expires_at` 원천 |
| `CHAT_SDK_GEN_TIMEOUT` | `480` | 잡 wall-clock(주+복구 세션 합산). `+기동여유 ≤ CHAT_BRIDGE_TIMEOUT` 기동 검증 |
| `CHAT_SDK_MAX_TURNS` | `50` | 세션 턴 상한 |
| `CHAT_SDK_STAGES` | (W1-ⓒ 결과) | 무인 enablement 단계 목록(콤마) |
| `CHAT_SDK_DAILY_JOB_CAP` | `20` | 사용량 측정 불가 시 폴백(잡 수 상한 — 비용 상한 아님) |
| `CLAUDE_CODE_OAUTH_TOKEN` | (설정됨) | 구독 인증 — 세션 spawn env 에 주입(Q1 과 동일) |

(r8 의 `CHAT_SDK_USAGE_PAUSE_PCT` 는 측정 수단이 W1 에서 확정될 때까지 보류 — 폴백은 잡 수 상한.)

## 6. 테스트 전략 (3계층 — 기존 유지)

| 계층 | 무엇 | 결정성 |
|---|---|---|
| 단위 | 수명주기(만료·클레임 경합·reaper 2중 검사·kill_at 계산·복구 생략) · 세션 러너 인자 조립·경계 규칙 · **적대 우회 표**(승인류/체이닝/타 rid/경로 밖 → 전부 거부) · settings 생성 결정성 · env 위생(Q1 유틸 재사용 확인) | 완전 결정적(fake spawn/fs) |
| stub E2E | 데몬 1잡 완주(pending→검사→클레임→stub 전이→삭제) · 만료/실패 failed 격리 · 기존 4건 불변 | `HARNESS_OFFLINE=1` |
| 라이브 체크리스트 | W1 ⓐ~ⓓ · W5(무인 완주·경계 스모크·kill 동작) · CLI 업그레이드 시 적대 카나리 재실행(Q1 항목과 통합) | 사람 확인(CI 밖) |

## 7. 리스크

| # | 리스크 | 완화 |
|---|---|---|
| R-1 | CLI 통제(allowedTools/deny) 문법·동작이 기대와 다름 | W1-ⓑ 실측 선행(추측 금지 — Q1 `--tools` 교훈). 실측 실패 시 해당 도구는 미허용(fail-closed)·C2 유지 |
| R-2 | 마커 미주입(실 CLI 도) | W1-ⓐ 실측 → 미주입 시 세션 env 주입(r8 3근거 승계 — 세션 한정·산출물 선행 게이트가 실질 보증) |
| R-3 | 스킬-게이트 드리프트로 무인 단계가 게이트에 막힘 | W1-ⓒ dry-run 으로 사전 발견 → 미편입 + core 버그 별도 트랙(우회 금지 — r8 승계) |
| R-4 | 늦은 성공·이중 소비·stale 재실행 | 프로토콜 v2(잠긴 결정 3) — r8 에서 Codex 클린까지 다듬은 그대로 |
| R-5 | 무인 세션의 게이트 월권·비밀 유출 | 3층 경계(4번 절) + 적대 테스트 + 최종 방어는 사람 버튼·core 락 |
| R-6 | 구독 한도 소진(무인 다량 소비) | 동시성 1·`--max-turns`·잡 wall-clock·일일 잡 수 상한 · keyvisual(이미지) 는 enablement 마지막 |
| R-7 | 정책 재변경(구독 자동화 조건) | 과금·정책은 실측 게이트 우선(r8 승계) · CLI 업그레이드 카나리에 정책 재확인 포함 |

## 8. 고지

본 산출물·챗 레이어는 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). 무인화는 '생성'에
한정되며 승인·선택·RA 확인은 사람의 판단 기록이다 — 그 한정은 프롬프트가 아니라 CLI 통제(코드가 쓰는 설정)가
보증한다. 과금·정책 서술은 작성 시점 실측이며 변경 시 실측 게이트가 우선한다.

---

## 부록A — W1 실측 결과 (2026-07-16 · claude 2.1.211 · 라이브)

> 실측 환경: 스크래치 픽스처(`repo/` 에 `.env`(가짜 카나리)·`readme.txt`·`notes.txt`·`runs/rid-a`·`runs/rid-b`·
> `scripts/run-stage.sh`(스텁)). 각 프로브는 `claude -p` 1회. 판정은 **관측된 동작만** 적는다(모델의 자기설명·
> 추정은 근거로 쓰지 않는다 — 실제로 실행됐는지·`permission_denials` 에 기록됐는지로만 판정).

### A-1. 판정 요약

| 항목 | 판정 | 요지 |
|---|---|---|
| ⓐ 마커 | **통과** | CLI 가 자기 Bash 서브프로세스에 `CLAUDECODE=1`·`CLAUDE_CODE_ENTRYPOINT=sdk-cli` 를 **네이티브 주입**. 주입 코드 불요 → **R-2 소멸** |
| ⓑ CLI 통제 | **통과(설계 정정 필요)** | 계획 4번 절의 경계 모델이 **실측과 다르다**. 단 실제 모델은 더 강하다(A-3·A-5) |
| ⓒ 스킬-게이트 dry-run | **brief·intake 둘 다 통과** | 무인 세션이 완주하고 **사람 승인 게이트에서 정확히 멈춤**(A-9·A-10) |
| ⓓ 과금 귀속 | **미완** | 사람의 콘솔 확인 필요(코드로 대체 불가) |
| (부수) 격리 CONFIG_DIR | **재현 → 해소** | 격리 CONFIG_DIR + 스크럽 env = `Not logged in`(Q1 실측이 2.1.211 에서도 성립). **OAuth 토큰 주입으로 성립 확인**(A-8) |

### A-2. ⓐ 마커 — 네이티브 주입 확인

도구 켠 `claude -p` 의 Bash 서브프로세스에서 `CLAUDECODE=1` · `CLAUDE_CODE_ENTRYPOINT=sdk-cli` 관측.
core 의 `scripts/lib/common.sh` 439행이 정확히 이 두 변수를 보므로 **무인 세션의 insession 판정은 그대로 성립**한다.
W3 은 마커 주입 코드를 만들지 않는다(r8 R-9 논쟁 종결).

### A-3. ⓑ 실측된 권한 모델 (계획 4번 절과 다름)

헤드리스 `-p` 의 권한 판정은 **명령 부류 × 규칙**으로 갈린다:

| 명령 부류 | 규칙 없음 | `allow` 규칙 매칭 | `deny` 규칙 매칭 |
|---|---|---|---|
| 안전 읽기(`ls`·`cat`·`grep` 등 CLI 가 읽기전용으로 분류) | **자동승인 → 실행** | 실행 | **차단** |
| 그 외(스크립트 실행·`sh -c`·`python3 -c`·쓰기) | **승인 필요 → 헤드리스에선 차단(fail-closed)** | **실행** | 차단 |

**따라서 계획 4번 절 1층("허용(정확·최소) `--allowedTools` 로 나머지를 막는다")은 사실과 다르다.**
`--allowedTools` 는 제한 장치가 아니라 **승인 필요 명령을 통과시키는 게이트**다. 나머지를 막는 실제 힘은
**헤드리스에 승인 프롬프트를 답할 주체가 없다는 것**(구조적 fail-closed)이다. 읽기는 그 게이트에 걸리지
않으므로(자동승인) **읽기 경계는 전혀 다른 수단이 필요하다** → A-4.

- `ask` 규칙은 **Bash 읽기에 적용되지 않는다**(`ask:["Read(./readme.txt)"]` 로도 `cat readme.txt` 실행, denials 0) → 경계 수단 아님.
- `deny` 는 **allow 를 이긴다**(`allow:["Read(./runs/rid-a/**)"]` + `deny:["Read(//**)"]` → 자기 런 읽기까지 차단).
  즉 **"전부 deny + 내 것만 allow" 형태의 허용목록은 만들 수 없다**.
- `--permission-mode manual` 도 자동승인 부류를 막지 못한다(안전 읽기는 모드와 무관하게 실행).
- `Read(//**)` 는 유효한 전체 글롭. `Read(./runs/rid-b/**)` 같은 경로 글롭 deny 는 **Bash 경유 읽기도** 막는다
  (CLI 가 Bash 명령을 파싱해 파일 접근을 권한 규칙에 건다).

### A-4. ⓑ 읽기 경계 — cwd + `--add-dir` 가 네이티브 허용목록이다 (핵심 발견)

**작업 디렉터리 자체가 기본-거부 읽기 경계다 — Bash 경유도 포함.** cwd 밖 경로는 규칙을 하나도 안 걸어도 차단된다
("path ... sits outside this session's allowed working directory"). `--add-dir` 은 그 경계에 **경로를 정확히 추가**한다:

| cwd = `runs/rid-a` · `--add-dir scripts` 상태에서 | 결과 |
|---|---|
| `cat 01-brief/input.txt`(cwd 안) | 실행 |
| `cat ../../scripts/run-stage.sh`(add-dir) | 실행 |
| `cat ../../.env`(밖) | **차단** |
| `cat ../rid-b/state.json`(타 런 = 밖) | **차단** |

이것이 **r8 의 realpath 허용목록(기본 거부 + 현재 런 + 고정 지침 경로 + 선언 도메인 packs)의 CLI 네이티브 대응물**이다.
W0 이 남긴 미해결 2번(읽기 기본값이 deny 목록이라 기본-허용으로 후퇴)은 **이 발견으로 닫힌다** — 열거가 아니라 구조로 막는다.
⚠ 단 **cwd 선택이 곧 읽기 경계**이므로, 계획 W3 의 `cwd=core` 는 재검토 대상이다(`core` 를 cwd 로 잡으면
`core/runs/*` 전체가 경계 안 = 타 런 읽기 허용, `.env` 는 레포 루트라 밖 = 차단). 타 런 격리를 원하면
cwd = 해당 런 디렉터리 + 필요한 경로만 `--add-dir` 이 정답이다.

### A-5. ⓑ 적대 우회 표 (관측된 것만)

| 시도 | 규칙 | 결과 |
|---|---|---|
| 승인류 스크립트 실행(`run-stage.sh approve rid-b`) | allow = `brief rid-a` 만 | **차단**(인자 정밀도 성립 — 다른 인자는 매칭 안 됨) |
| 체이닝 — 허용 명령 뒤에 **승인 필요** 명령(`… brief rid-a; … approve rid-b`) | allow = `brief rid-a` 만 | **차단**(명령줄 **전체** 거부 · 앞부분도 미실행 · `permission_denials` 기록) |
| 체이닝 — 허용 명령 뒤에 **안전 읽기**(`… brief rid-a; cat runs/rid-b/state.json`) | allow = `brief rid-a` 만 | **실행됨(유출)** — 단 이는 체이닝 우회가 아니라 안전읽기 자동승인 탓. A-4 의 cwd 경계로 닫힘 |
| 간접 스펠링 `sh -c 'cat …'` | deny = `Read(./notes.txt)` | **차단**(간접 스펠링 자체가 승인 필요 부류라 fail-closed) |
| 간접 스펠링 `python3 -c "open(…)"` | 동일 | **차단** |
| Bash 로 파일 deny 우회(`cat .env`) | deny = `Read(./.env)` | **차단**(Read 규칙이 Bash 읽기에도 적용) |
| 규칙 없는 cwd 안 읽기(`cat notes.txt`) | 없음 | **실행됨** — 읽기는 기본 허용(경계는 cwd) |

**함의**: deny 목록이 **동의어를 열거할 필요가 없다**(간접 스펠링은 승인 게이트가 잡는다). 체이닝도 구조적으로 안전하다.

### A-6. 함정 — `--bare` 는 쓰면 안 된다

`--bare` 는 훅/플러그인/keychain 읽기를 건너뛰어 격리에 유혹적으로 보이나, 문서상 **인증이
`ANTHROPIC_API_KEY` 또는 `apiKeyHelper` 로 강제**된다(OAuth·keychain 을 절대 안 읽음) = **구독이 아니라 API 과금 경로**.
잠긴 결정 6(API 과금 구조적 차단)과 정면 충돌하므로 **금지**한다.

### A-7. W1 이 계획에 요구하는 정정

1. **4번 절 1층 교체** — "`--allowedTools` 로 최소 허용해 나머지를 막는다" → "**읽기 경계 = cwd + `--add-dir`(기본 거부)**,
   **실행 경계 = 승인 게이트의 헤드리스 fail-closed**, `--allowedTools` 는 전이 명령을 통과시키는 **예외 등록**".
2. **2층(deny) 역할 축소** — 읽기 허용목록은 cwd 가 담당하므로, deny 는 **경계 안쪽에서 파내는 예외**(예: 런 안의
   `state.json`·`run.md`·`.lock` 쓰기 금지)로 한정한다. `ask` 는 무효라 쓰지 않는다.
3. **W3 의 `cwd=core` 재검토** — A-4 참조(cwd 가 곧 읽기 경계).
4. **잠긴 결정 4 의 "전이 요청 마감 후 거부" 는 수단 없음** — W0 미해결 1번과 동일 결론. 실 CLI 엔 호출별 판정 지점이
   없다(SDK `canUseTool` 대응물 부재). **결정됨(2026-07-16, 사람)**: 거부층을 **삭제**하고 마감 강제는 supervisor
   단층으로 한정한다 — 잠긴 결정 4 갱신 완료. 근거는 그 표에 적었다.

### A-8. 격리 + 인증 + 경계를 한 구성으로 실측 (W3 이 쓸 최종 형태)

`env -i`(화이트리스트 재구성) + `CLAUDE_CONFIG_DIR=<워커 소유 빈 디렉터리>` + `CLAUDE_CODE_OAUTH_TOKEN` 주입 +
cwd = 런 디렉터리 로 1회 실행:

| 관측 | 값 |
|---|---|
| 인증 | **성립**(`is_error: false`) — 격리로 가려진 로컬 로그인을 토큰 주입이 대체(Q1 설계 그대로) |
| 읽기 경계 | **유지** — cwd 안 `01-brief/input.txt` 읽힘 · `../../.env` **차단**(`permission_denials` 기록) |
| 비용 | 봉투에 `total_cost_usd` 보고(구독 환산치 — Q1 재보정 참조. 실제 귀속은 ⓓ 에서 사람이 확인) |

즉 **격리·인증·경계가 서로 상충하지 않는다**. 토큰은 `chat/.env` 의 `CLAUDE_CODE_OAUTH_TOKEN`(gitignore 됨)을 쓴다.

### A-9. ⓒ 스킬-게이트 dry-run — brief 무인 완주 (통과)

스크래치 런(`w1c-brief-0716` · cosmetic · multipage_bm · 사례 없이 인입해 00g 생략 → 곧장 01-brief)에서
**실 CLI 세션 1회**로 brief 를 무인 생성했다. 전후 `next-action` 이 진실의 출처다(AGENTS 9번 절):

| | next-action |
|---|---|
| 전 | `01-brief` · step=generate |
| 후 | `01-brief` · step=**human** · gate=**user** · cmd=`approve.sh` |

**세션이 스스로 한 일**: `--emit-context` 로 입력 목록 획득 → `prompts/brief.md`·스키마·`00-ingest/*`·`packs/cosmetic/ruleset.json` 읽기
→ `01-brief/brief.json`+`brief.md` 작성 → insession 전이 호출. **사람 승인 게이트에서 정확히 멈췄다**(approve/revise 를 스스로 부르지 않음 — 스킬 금지 규칙 준수).

**측정치**(1회): `is_error=false` · `num_turns=31` · `282초` · `total_cost_usd=0.94`(구독 환산치).
→ `CHAT_SDK_GEN_TIMEOUT=480` 은 여유 있음. **`CHAT_SDK_MAX_TURNS=50` 은 31턴 관측 대비 여유가 크지 않다** — 단계·입력이 커지면 상향 검토.

**작동한 최소 구성**(W3 이 인코딩할 것):

| 축 | 값 |
|---|---|
| cwd | `core/runs/<rid>` (= 읽기 경계) |
| `--add-dir` | `core/prompts` · `core/harness` · `core/scripts` · `packs/<도메인>` |
| `--tools` | `Bash,Read,Write,Edit,Glob,Grep` |
| `--allowedTools` | `Bash(bash ../../scripts/run-stage.sh <stage> <rid> --emit-context)` + **`Bash(HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash ../../scripts/run-stage.sh <stage> <rid>)`** |
| `--permission-mode` | `acceptEdits` (파일 작성 자동승인 — Bash 는 여전히 규칙이 지배하므로 경계 유지) |
| env | `env -i` 화이트리스트 + 격리 `CLAUDE_CONFIG_DIR` + OAuth 주입 + `HARNESS_ACK_GAPS=0` |

**경계가 실제로 하중을 받았다** — 세션의 `permission_denials` 3건 전부 의미 있다:

| 거부된 시도 | 왜 중요한가 |
|---|---|
| `ls core/runs/ \| head -30` (*"참고 사례용 기존 런 목록"*) | 무인 세션이 **타 런을 뒤지려 실제로 시도**했고 cwd 경계가 막았다. A-4 가 이론이 아님 |
| `ls core/runs/` (재시도) | 동일 |
| `cd …/core && HARNESS_CLI=… bash scripts/run-stage.sh …` | 통과했다면 **세션이 cwd 경계 밖으로 나갈 수 있었다**. allow 규칙 정밀도가 막음 |

그러고도 세션은 완주했다 — **경계가 일을 방해하지 않는다**.

**⚠ W3 핵심 교훈 — allow 규칙은 SKILL.md 원문에서 도출해야 한다.**
1차 시도는 전이가 **거부돼 실패**했다: 프리앰블로 "env 는 이미 설정했으니 접두를 붙이지 마라"라고 지시했으나 세션은
**SKILL.md 원문 그대로** `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash …` 를 타이핑했고, 접두 없는 형태로 쓴 allow 규칙이
매칭에 실패했다(3회 재시도 전부 거부 → 산출물은 썼으나 전이 실패 → next-action 정체). 즉 **명령 문자열을 정하는 건 프롬프트(SKILL.md)이므로,
allow 규칙은 워커가 선호하는 형태가 아니라 그 스킬이 모델에게 타이핑하라고 시킨 문자열에서 도출**해야 한다.
프리앰블로 형태를 교정하려는 설계는 "경계가 프롬프트 준수에 의존"하게 되어 잠긴 결정 2 의 철학과 충돌한다.
→ W3 은 스테이지별 allow 규칙을 **해당 `skills/<stage>/SKILL.md` 의 3단계 명령 원문과 결박**하고, 그 결박을 단위 테스트로 고정한다
(SKILL.md 가 바뀌면 테스트가 깨져야 한다 = 스킬-게이트 드리프트 조기 발견).

### A-10. ⓒ intake 무인 완주 + **프롬프트 결정론 치환**(W3 설계 확정)

라이브 런(`…-895939`)의 첨부 2종(PDF)을 스크래치로 복사해 동일 상태의 런(`w1c-intake-0716` · `00a-intake` generate)을 만들고 측정했다.
라이브 런은 읽기만 했다(불변).

**1차(프리앰블로 경로 교정 지시) = 실패.** 세션이 산출물(`intake-proposal.json`·`converted/`)은 썼으나 전이에서
`bash scripts/run-stage.sh …`(cwd=core 기준 원문 그대로)를 타이핑해 거부 — **brief 때는 프리앰블을 따랐는데 intake 에선 무시했다.**
즉 **모델의 명령 형태는 실행마다 비결정적**이라 프리앰블(프롬프트) 위에 경계를 세울 수 없다(A-9 교훈의 재확인·강화).

**2차(워커가 SKILL.md 를 결정론적으로 치환) = 통과.** `00a-intake` generate → **human · gate=user · `approve.sh`**.
치환 규칙: ① `bash scripts/run-stage.sh` → 런-상대 경로 ② `<RUN>` → 실제 rid. **allow 규칙은 같은 치환 산물에서 도출**(손으로 문자열을 짜지 않는다).

**⚠ 단 2차도 전이 전 10건이 거부됐다** — 모델이 **상대경로 깊이를 틀렸다**(`../../` 를 `../../../../` 로). 거부된 형태:

| 시도 | 판정 |
|---|---|
| `cd …/core && HARNESS_CLI=… bash scripts/run-stage.sh …` | **차단** — 통과했다면 **cwd 읽기 경계를 탈출**했다 |
| `bash ../../../../scripts/run-stage.sh …` (깊이 오산) | 차단 |
| `export HARNESS_CLI=…; bash ../../../../…` | 차단 |
| `HARNESS_CLI=… ../../../../scripts/run-stage.sh …` (bash 없이) | 차단 |
| `… --emit-context \| head -5` (파이프) | 차단 |
| `shasum -a 256 <첨부>` 4형태 (첨부 해시 검증) | 차단 → **보조 도구 규칙 필요**(아래) |
| `find core/runs -iname intake-proposal.json` · Glob `core/runs/*/00a-intake/…` | **차단** — 타 런 훔쳐보기 시도를 경계가 막음 |

**→ 확정: 치환은 절대경로로 한다.** 별도 실측(스텁 픽스처)에서 명령을 절대경로로 주자 **2턴·거부 0·첫 시도 성공**했다
(모델이 셈할 게 없으니 문서대로 타이핑한다). 상대경로 치환은 fail-closed 라 안전하긴 하나 턴·비용을 낭비한다.

**측정치**: 1차 `28턴·256초·$3.65` · 2차 `34턴·327초·$4.80`(전이 재시도 포함). **intake 는 brief($0.94)보다 4~5배 비싸다**(PDF 판독).
→ `CHAT_SDK_DAILY_JOB_CAP` 를 '잡 수'로만 잡으면 단계별 비용차(5배)를 못 잡는다는 뜻 — 상한 설계 시 유의.

**산출물 품질**(사람 승인 대기 상태): 첨부 2건 분류 = `제품제안서.pdf` → `working_backwards`(confidence high) ·
`이지덤 모공패치 피부임상데이터_2508.pdf` → `evidence_test_report`/`kind: test_report`(**confidence low** — 시험성적서의 제품명이
"이지덤뷰티 피디알엔 주름패치 700샷"으로 선언 제품명과 달라 사람 확인 필요로 표시). **환각 안전이 작동했다** — 세션이 불일치를 덮지 않고 사람에게 올렸다.

### A-11. W3 이 인코딩할 확정 설계 (ⓒ 종합)

1. **프롬프트 = 워커가 `skills/<stage>/SKILL.md` 를 결정론적으로 치환한 결과**(절대 스크립트 경로 + rid). 프리앰블로 형태를 교정하지 않는다.
2. **allow 규칙 = 같은 치환 산물에서 도출**(문자열 수기 금지) + **그 결박을 단위 테스트로 고정** → SKILL.md 가 바뀌면 테스트가 깨져 스킬-게이트 드리프트가 조기 발견된다(R-3).
3. **스테이지별 보조 도구는 실측으로만 추가** — intake 는 첨부 해시 검증에 `Bash(shasum:*)` 가 필요했다. brief 는 불필요.
4. 나머지 축은 A-9 표 그대로(cwd=런 디렉터리 · `--add-dir` 4종 · `--tools` 6종 · `acceptEdits` · env 위생+격리 CONFIG_DIR+OAuth).

**`CHAT_SDK_STAGES` 초기 후보**: 실측 근거가 있는 **`intake`·`brief`** 2종(W5 의 무인 완주 대상과 일치).
concept·storyboard 는 미측정 → 편입 전 각 1회 dry-run. keyvisual 은 W0 미해결 3번(타입드 도구 대응물 부재)으로 **재설계 없이 편입 불가**.
