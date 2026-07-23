# 챗 이중 표면 실행 설계 — 무인 실 CLI 세션 워커(S-1) · 헤드리스 NL 파서

> **지위**: `docs/plans/`(진행 중 계획). **작성**: 2026-07-15 · **개정 r10**: Q2 실측 흡수 — 도구 경계 모델 실측 확정 · 마감 거부층 삭제 결정 · 봇 additive 4건
> (r2: C1·H5 → r3: H2 → r4: H2 → r5: H3 → r6: H4 → r7: H2[정적 마감·co-edit 축소] → r8: H1[co-edit 활성조건에 changes_requested 포함] → r9: 실 CLI 전제 정정 → r10: Q2 실측 흡수).
> **관계**: [`chat-hexagonal-gateway-plan.md`](chat-hexagonal-gateway-plan.md) P3(자연어)·P4(S-1)의 **실행 설계** —
> 그 계획의 "라이브 스파이크 후속"을 구체화한다. Q1(헤드리스 NL 파서)은 구현·라이브 검증 완료.
> **Q2·Q3 의 실행 계획 = [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md)**(W0~W5 — 이 문서의 설계를 실 CLI 로 집행한다).
> **실측 SSoT = 그 문서의 부록A**(2026-07-16 · claude 2.1.211 · 라이브 프로브). 이 문서의 도구 경계·마커·스킬-게이트
> 서술은 전부 그 실측이 정본이며, 상충하면 **부록A 가 이긴다**. 이 문서는 설계(무엇을 왜), 부록A 는 관측(무엇이 실제로 그런가).
> 근거 리서치 = [`agent-sdk-unmanned-worker-research.md`](../reference/agent-sdk-unmanned-worker-research.md)(참조 스냅샷 — SDK 전제 부분은 그 문서 상단의 정책 확정 추기가 우선).
> 규칙 SSoT = [`../../core/AGENTS.md`](../../core/AGENTS.md)(불변). **core 무수정 원칙 유지.**

---

> **개정 r10 — 실측이 정본이다(부록A).** 무인 세션의 실행 표면·도구 경계·마커·스킬-게이트 호환은 이제 추정이 아니라
> **라이브 실측**([`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md) 부록A · 2026-07-16 · claude
> 2.1.211)이 정본이다. 실측이 확정한 것:
>
> 1. **실행 표면 = 실 `claude` CLI spawn**(2026-07-15 정책 실측): 구독 OAuth 는 **공식 CLI 의 통상적 사용에만 허용**되고
>    **Agent SDK 를 포함한 제품/서비스 개발은 API 키를 쓰라**고 명문화돼 있으며 **2026-01-09 부터 구독 OAuth 의 SDK
>    인증은 서버측 차단**이다. 실 CLI 는 Q1(헤드리스 NL 파서)이 같은 인증(OAuth 토큰 주입)으로 라이브 검증했다.
> 2. **읽기 경계 = cwd + `--add-dir`**(부록A-4): 작업 디렉터리 자체가 **기본-거부 허용목록**이고 **Bash 경유 읽기도
>    포함**한다. r8 의 realpath 허용목록의 CLI 네이티브 대응물 — 열거가 아니라 **구조**로 막는다.
> 3. **실행 경계 = 승인 게이트의 헤드리스 fail-closed**(부록A-3): `--allowedTools` 는 제한 장치가 아니라 승인 필요
>    명령을 통과시키는 **예외 등록**이다. 나머지를 막는 힘은 **헤드리스에 승인을 답할 주체가 없다**는 구조다.
> 4. **마커는 CLI 가 자기 Bash 서브프로세스에 네이티브 주입**(부록A-2) — 주입 코드도, 그 적정성 논쟁(R-9)도 불요.
> 5. **프롬프트 = 워커가 SKILL.md 를 결정론적으로 치환한 산물**(부록A-9·A-10·A-11): 모델의 명령 형태는 실행마다
>    비결정적이라 프리앰블(프롬프트) 위에 경계를 세울 수 없다.
>
> **경계 철학은 그대로다 — 경계는 프롬프트가 아니라 코드가 보증한다.** 실측은 이 철학을 반증한 게 아니라 **입증했다**:
> 읽기 경계는 열거가 아니라 cwd 라는 구조이고, 실행 경계는 규칙이 아니라 승인 주체의 부재다. 둘 다 프롬프트 준수와 무관하다.
> 남은 미해결은 **keyvisual 전용 타입드 도구 2건**(5-3 B-3 ⚠ · R-12·R-13)과 **과금 귀속 확인**(부록A ⓓ — 사람의 콘솔
> 확인, 코드로 대체 불가), 그리고 **부록A 가 재지 않은 표면 4종**(5-3 B-3 의 미실측 표 — 재기 전엔 열지 않는다)뿐이다.

## 0. 한 줄 정의

같은 하네스를 **두 표면**이 구동한다 — ① 기본 Claude Code(대화형 세션, 오늘의 1급 경로 그대로) ②
chat(Slack, 사람 없는 무인 경로). 무인 경로의 생성은 "헤드리스 subprocess"가 아니라 **워커가 잡마다 띄우는
실 `claude` CLI 세션** 이 수행한다 — 사람 관점 무인, core 관점 insession. NL 이해만 세션이 불필요한
1콜 헤드리스(파싱은 상태를 안 바꾸고 방아쇠는 버튼)로 처리한다.

## 1. 잠긴 결정 (2026-07-15 · r9 — 변경 시 재합의)

| # | 결정 | 근거 |
|---|---|---|
| 1 | **무인 생성 = 파일 큐 소비 데몬(별도 프로세스)** — 봇 in-process 가 아니라 `chat/jobs/` 큐를 소비하는 독립 워커 | 이음새가 파일 큐 하나로 유지. 사람 운영자 ↔ 데몬 교체 가능, 크래시 격리, 커뮤니티 검증 패턴(sleepless-agent·kraken) |
| 2 | **소비자 프로토콜 v2 = 클레임-by-rename + 절대 마감(deadline)** — 잡 파일에 `expires_at` 을 싣고, 소비자(사람 포함)는 **클레임 전 2중 검사**(① 잔여시간 ≥ 잡 예산+기동 여유 ② next-action 이 여전히 그 단계 생성 차례). **늦은-성공 보증은 3분법**: 데몬=구조적(잡 kill 시각을 `expires_at` 에 결박 — 4번 결정) · 사람=절차적(2중 검사 + "마감 후 전이 금지" 규약) · 봇=화해(읽기전용 [상태 다시 확인] 버튼 — 늦은 전이가 나도 스레드가 고아가 되지 않음 · **회수된 요청은 [다시 만들기]로 새 마감을 받아 재요청** — 아무도 클레임하기 전에 마감이 지나도 런이 고립되지 않음). `jobs/README.md` 를 Q3 에서 개정 | (R1-3·R2-2·R3-2) rename 은 이중 소비만 막는다. 사람에게 타이머를 강제할 수는 없으므로 보증 수준을 소비자별로 **정직하게 분리**하고, UX 어긋남은 화해 버튼으로 닫는다. 회수는 마감을 지키지만 그 자체로 런을 멈춰 세우므로(core 는 여전히 생성 차례) 화해 경로가 재요청까지 맡아야 닫힌다(3절). core 락·멱등 게이트가 상태 안전의 최종 방어 |
| 3 | **무인 세션 도구 경계 = CLI 네이티브 통제 3층**(실측 확정 — 부록A-3·A-4·A-5) — ① **읽기 경계 = cwd + `--add-dir`(기본 거부)**: 작업 디렉터리가 곧 허용목록이고 **Bash 경유 읽기도 포함**한다(cwd 밖은 규칙을 하나도 안 걸어도 차단). cwd = **런 디렉터리**(`core/runs/<rid>`), `--add-dir` = 필요한 고정 경로만(`core/prompts`·`core/harness`·`core/scripts`·`packs/<선언 도메인>`) → 타 런 `runs/*`·`.env`·`chat/jobs/**`·`~/.claude/**` 는 **열거 없이** 경계 밖 ② **실행 경계 = 승인 게이트의 헤드리스 fail-closed**: 승인 필요 부류(스크립트 실행·`sh -c`/`python3 -c` 같은 간접 스펠링·쓰기)는 헤드리스에 승인을 답할 주체가 없어 구조적으로 차단된다. `--allowedTools` 는 제한 장치가 아니라 **그 게이트를 통과시키는 예외 등록**(전이·emit-context·스테이지별 보조 Bash 규칙)이며, 규칙 문자열은 **워커가 `skills/<stage>/SKILL.md` 를 치환한 산물에서 도출**한다(부록A-11 — 손으로 짜지 않는다) ③ **`permissions.deny` = 경계 안쪽에서 파내는 예외**(워커 소유 격리 `CLAUDE_CONFIG_DIR/settings.json`): 런 안의 `state.json`·`run.md`·`.lock` 쓰기 금지 등. **읽기 허용목록을 여기서 열거하지 않는다**(①이 담당) + **상한**: `--max-turns` · 잡 wall-clock(supervisor kill) · 출력 캡. 경계 수단이 **아닌 것**(실측): `deny` 는 `allow` 를 이기므로 "전부 deny + 내 것만 allow" 형태의 허용목록은 만들 수 없고, `ask` 는 Bash 읽기에 적용되지 않으며, `--permission-mode manual` 도 안전 읽기(자동승인 부류)를 막지 못한다. deny 목록은 **동의어를 열거할 필요가 없다**(간접 스펠링은 그 자체가 승인 필요 부류 → fail-closed). ⚠ **`--bare` 금지**(부록A-6): 인증이 `ANTHROPIC_API_KEY`/`apiKeyHelper` 로 강제돼 OAuth·keychain 을 아예 안 읽는다 = **API 과금 경로** → 잠긴 결정 6 과 정면 충돌. CONFIG_DIR 는 워커가 잡마다 만드는 디렉터리라 사용자 훅/플러그인/MCP/`apiKeyHelper` 가 애초에 없고, settings 내용은 **코드가 결정론적으로 조립**(단위 테스트 대상). **부록A 가 재지 않은 표면은 열지 않는다**(fail-closed — 목록은 5-3 B-3) | (R1-1·R2-1·R3-1) **경계는 프롬프트가 아니라 코드(여기선 cwd 선택 + CLI 설정)가 보증한다** — 실측이 이 철학을 반증한 게 아니라 **입증했다**: 읽기 경계는 열거가 아니라 **구조**(cwd)이고, 실행 경계는 규칙이 아니라 **승인 주체의 부재**다. 둘 다 프롬프트 준수와 무관하며, cwd 경계는 r8 의 realpath 허용목록보다 오히려 **강하다**(기본 거부 · Bash 경유 포함 · 열거 누락이 불가능). 적대 우회 표(체이닝·간접 스펠링·인자 치환·타 rid·경로 밖)는 부록A-5 에서 **관측으로 확정**됐고 7절 회귀 표로 고정한다. 규칙 매칭은 버전 종속이므로 CLI 업그레이드 시 그 표를 카나리로 재실행한다 |
| 4 | **마커는 '실제 Claude 세션'의 env 에만** + **잡당 supervisor 프로세스 토폴로지** — 데몬 자신이 마커를 갖고 core 를 직접 호출하는 것 금지. 백스톱도 **복구 세션**(전이 규칙 1건만 허용된 최소 세션). Node 는 기존 PGID 합류 API 가 없으므로("한 그룹에 나중 자식 합류"는 구현 불가) **잡마다 `detached:true` supervisor 프로세스 1개**(자기 PGID 의 리더)를 띄우고, 주 세션·복구 세션은 **모두 supervisor 가 spawn**(그 그룹 상속 — 세션의 Bash 자식도 그 아래). **kill_at(= min(클레임+`CHAT_SDK_GEN_TIMEOUT`, `expires_at`)) 은 '검증된 정적(quiescence) 시각'**이다: TERM 은 `kill_at-유예₁`, **KILL 은 `kill_at-유예₂`(마감 전!)** 에 발사하고, `kill_at` 에는 그룹 소멸을 **확인(reap 검증)** 한다(타이머 지연·KILL 전달≠종료 를 여유₂가 흡수). **r8 의 '전이 요청은 마감 후 거부'는 승계하지 않는다**(2026-07-16 결정 · 사람): 그 층은 SDK 의 호출별 허용 콜백으로 구현됐는데 **실 CLI 엔 대응물이 없다**(부록A-7 4번). 마감 강제는 **supervisor 단층**(TERM/KILL/reap)으로 한정하고, 마감 직전 시작된 전이가 늦게 성공하는 창은 **프로토콜 v2 의 [상태 다시 확인] 화해 버튼**(R-4)과 core 락이 흡수한다 — **늦은 전이는 그 자체로 유해하지 않다**(core 가 진실의 출처이고 게이트는 정당하게 전진한 것). r8 의 거부층은 이중 안전장치였지 필수가 아니었다 | (R1-2·R2-2·R3-2·R4-1) kill 앵커를 마감 자체에 결박 + **구현 가능한 토폴로지**(supervisor=그룹 리더)로 명시. 테스트는 kill_at 계산만이 아니라 **주/복구 자식이 실제 종료**되는지 검증. 백그라운드 이탈 차단은 그룹 kill 이 1차 방어다(자유 셸 부재라는 r8 의 원천 차단이 없으므로 — 잠긴 결정 3) |
| 5 | **NL 파싱 = 도구 0 헤드리스 1콜** + 파서 계약(명시 선언만·도메인 추론 금지)은 **api/cli 공용 단일 모듈**로 공유 | (R1-4·R1-5) Slack 텍스트는 불신 입력 — 도구 없는 경계 + rule 8(사람 선언) 계약을 프롬프트 소스 한 곳에 |
| 6 | **과금은 서술이 아니라 '활성화 게이트(실측)'** — 정책 문서 간 상충(구독 차감 vs 크레딧 분리) 존재. 어느 쪽이든 첫 실콜/1런에서 과금 귀속을 실측 확인해야 다음 단계 진행. + 잡당 **턴/시간 상한** 필수 | (R1-6) env 스크럽만으로 OAuth 강제 불가(`ANTHROPIC_AUTH_TOKEN`·클라우드 모드·`apiKeyHelper` 우선순위). 격리 설정 디렉터리 + 상한으로 구조 보강 |
| 7 | **무인 활성화는 단계별 점진(stage enablement)** — 스킬-게이트 호환이 **실측으로 통과된 단계만** 무인 대상에 편입(브리프 구간부터, keyvisual 은 마지막). 미편입 단계 잡은 데몬이 집지 않는다(운영자 소비) | (R2-1) 스킬 지시문과 게이트 요구의 드리프트(예: keyvisual 스킬 2안 vs 게이트 3안)는 실측으로만 확인된다. 드리프트 발견 = core 스킬 버그로 별도 트랙(core 변경 합의) — 무인화가 그것을 가리지 않게 |
| 8 | **결정은 사람** — 무인화 범위는 '생성'만. 선택·승인·RA 게이트는 Slack 버튼 그대로 | 규제 통제(AGENTS 1번 절) + 전 계획 잠긴 결정 5/6 |
| 9 | **기본 Claude Code 표면 무변경** — 대화형 insession 1급 경로·4동작·스킬은 손대지 않는다 | 두 표면은 같은 core 계약을 소비할 뿐, 서로를 모른다 |

> ⚠ **잠긴 결정 4 — 2차례 개정(둘 다 사람 승인 대상 · 조용한 변경 금지)**: W3 재설계(nonce 소유권 원장)가 원래
> supervisor 토폴로지를 두 번 정련했다. **W3 코드가 이미 구현했으므로 이 기록은 사후 승인 요청이다**(SIGTERM
> 전파·nonce 검증-후-kill 둘 다 명문 승인 대상 — 원 잠긴 결정을 바꾸므로 재합의 없이 확정으로 취급하지 말 것).
> - **1차 개정 — 종료 전파(termination propagation)**: supervisor 는 `SIGTERM`/`SIGINT`/정상 exit 를 받으면 자기
>   그룹을 빠져나가기 **전에** 살아있는 세션 하위그룹을 전부 `kill(-sessionPgid, SIGKILL)` 한다(in-memory
>   `SessionGroupRegistry` 기준 · `installSupervisorTerminationHandlers`). 데몬이 회수할 때는 **supervisor 에
>   `SIGTERM` 을 먼저** 보내 이 전파가 돌게 하는 것이 우아한 1경로다(옛 "데몬이 `kill(-supervisorPid)` 로 그룹째"
>   산문을 대체).
> - **2차 개정 — nonce 검증-후-kill + 스캔(데몬은 파일 pgid 직격 금지)**: 세션마다 재사용불가 nonce
>   (`CHAT_SESSION_NONCE`)를 exec-env 로 주입하고, 데몬은 대상 그룹 구성원의 exec-env 가 그 nonce 를 지녔는지
>   **신호 직전 검증한 뒤에만** `kill(-pgid)` 한다. pgid 미확정(register-lag) 창은 nonce **스캔**으로 그룹을 발견해
>   회수한다. raw-PID 하트비트는 폐기 — 근거: 5라운드 리뷰가 raw pgid 로는 register-lag·PID 재사용을 안전하게 못
>   가른다고 증명(SSoT = `chat/src/worker/ownership.ts` 헤더).
> - ⚠ **포터블 잔여(정직 고지 · 숨기지 말 것)**: PID 재사용은 **좁혀질 뿐 완전히 닫히지 않는다** — ① verify→signal
>   사이 ms급 비원자 창 ② supervisor pid 가 `START_TIME_TOLERANCE_MS`(2초) 안에 재사용되면 데몬이 그 세션 회수를
>   **보류(wait)** 한다(S34-R2 리뷰 지적 · 실패 방향은 안전[kill 아님]이나 마감 넘긴 고아를 영구 보류하는 잔여).
>   **완전 폐쇄는 W3 범위 밖**: Linux cgroup v2(커널 진실 멤버십) 또는 W4 데몬의 killAt-바운드 에스컬레이션
>   ('owner 살아있으나 마감+유예 초과 → 회수') — **둘 다 사람 승인 대상**이며 `evaluateReap` 은 아직 소비자(W4)가
>   없어 이 잔여는 오늘 도달 불가한 휴면이다.

## 2. 실측 근거 — core insession 게이트는 3중이다

`core/scripts/run-stage.sh`(262~298행)·`common.sh:detect_insession_engine`(429~441행) 실측(2026-07-15):

| 게이트 | 내용 | 무인 워커에 주는 함의 |
|---|---|---|
| ① 모드 | `HARNESS_GEN_MODE=insession` 명시 또는 마커 자동감지. STUB_MODE 면 강제 subprocess | 전이 명령에 명시(C2 규약과 동일) |
| ② 마커(필수) | **명시 모드여도** `CLAUDECODE` 또는 `CLAUDE_CODE_ENTRYPOINT` 없으면 die. 활성 `CODEX_*` 마커가 보이면 차단(deny-by-default) | **실측 해소**(부록A-2): CLI 가 자기 Bash 서브프로세스에 `CLAUDECODE=1`·`CLAUDE_CODE_ENTRYPOINT=sdk-cli` 를 **네이티브 주입**한다 → 무인 세션의 insession 판정이 그대로 성립하고 **주입 코드는 만들지 않는다**. 마커 보유 주체는 항상 '세션'(잠긴 결정 4). 워커 env 위생(`CODEX_*` 스크럽) 필수 |
| ③ 산출물 선행 | `insession_primary_ok` — 세션이 산출물을 **먼저** 썼어야 전이 가능 | 존재·유효성 보증(작성 주체 증명은 아님 — 그래서 ②를 세션에 한정) |

추가 실측 2건:
- `run-stage.sh` 175행대의 **산출물-재개(NEED_GENERATE=0) 예외 목록에 concept·storyboard-plan 은 빠져 있다** —
  세션이 산출물만 쓰고 전이 없이 죽은 런은 "다시 insession 으로 재진입"해야 복구된다 → 백스톱은 데몬 직접 호출이
  아니라 **복구 세션**이어야 한다(5-3 B-4).
- 스킬 지시문은 전이 외의 명령을 **정당하게** 요구하며(모든 스킬이 `run-stage --emit-context` 선행, guideline 은
  `examples_analysis.py`, keyvisual 은 이미지 생성 대기), 그 형태는 **복합 셸**(백그라운드·리다이렉션·`$(…)`·글롭)이다
  → "전이 1개"만 허용(R2-1)해서는 스킬이 돌지 않는다. 실 CLI 에는 타입드 도구를 꽂을 지점(SDK 콜백)이 없으므로 이
  보조 명령들은 **스테이지별 Bash 허용 규칙**으로 연다(잠긴 결정 3 ②). 규칙 문자열은 **그 스킬이 모델에게 타이핑하라고
  시킨 형태에서 도출**하고, 보조 규칙은 **실측으로만 추가**한다 — intake 는 첨부 해시 검증에 `Bash(shasum:*)` 가
  필요했고 brief 는 불필요했다(부록A-11). 체이닝·간접 스펠링의 우회 표면은 부록A-5 가 관측으로 닫았다(승인 필요
  명령이 섞이면 **명령줄 전체가 거부**되고 앞부분도 실행되지 않는다).
- **세션 프롬프트로 명령 형태를 교정하는 설계(도구 어댑테이션 프리앰블)는 성립하지 않는다**(부록A-9·A-10 실측):
  모델의 명령 형태는 **실행마다 비결정적**이다 — brief 세션은 프리앰블을 따랐고 intake 세션은 같은 프리앰블을
  무시하고 SKILL.md 원문을 그대로 타이핑했다. 프리앰블 위에 경계를 세우면 **경계가 프롬프트 준수에 의존**하게 되어
  잠긴 결정 3 의 철학과 충돌한다. 대신 **워커가 SKILL.md 를 결정론적으로 치환**하고(절대 스크립트 경로 + rid) 허용
  규칙을 **같은 치환 산물에서 도출**한다 — 프롬프트와 경계가 한 소스에서 나오므로 어긋날 수가 없다.

핵심: core 가 금지하는 것은 **"세션 없는 생성"**(스크립트가 눈먼 subprocess 로 생성)이지 "사람 없는 세션"이
아니다. 단 그 신뢰 경계(②)는 세션에만 부여한다 — 세션 밖 프로세스(데몬)는 어떤 경우에도 마커를 자기선언하지
않는다(잠긴 결정 4).

## 3. 아키텍처 — 이중 표면 · 단일 계약

```
                  ┌──────────────────────────────────────────────┐
                  │ core 계약(무수정): 세션이 산출물 먼저 →          │
                  │ run-stage.sh 는 검증·전이만 (3중 게이트, 2절)     │
                  └──────────────────────────────────────────────┘
                      ▲                                ▲
  [표면 A] 기본 Claude Code                [표면 B] chat(Slack) — 무인
  사람 ↔ 대화형 세션 (무변경)               Slack 버튼/NL ↔ 게이트웨이 커널(기존)
    · NL이해 = 세션 에이전트 자체            · NL이해 = CliNlParser(도구 0 헤드리스 1콜, Q1)
    · 생성 = /brief 등 스킬로 세션이 직접     · 생성 = BridgeGenExecutor(C2 — additive 4건: 잡에
    · 전이 = 세션 안 run-stage insession         expires_at·회수·[상태 다시 확인]·[다시 만들기])
                                                  └ jobs/ 파일 큐 → ★소비자만 교체(프로토콜 v2):
                                                    사람 운영자 세션(오늘) ↔ 실 CLI 소비 데몬(Q3)
                      ╲                                ╱
              공유 계약면: state.json · next-action.sh · 4동작 스크립트 · jobs/ 파일 큐
              (락+멱등 게이트 + 클레임 2중 검사 + 절대 마감 → 두 표면·두 소비자 공존 안전)
              결정(선택·승인·RA)은 양쪽 다 사람 — 무인 세션은 도구 경계(cwd + 승인 게이트)로 생성만 가능
```

**잡 수명주기(종단 기한 — R2-2 처방).** "실패 카드 후 늦은 성공"의 시간 창을 마감으로 **좁히고**, 남는 창은
**화해**로 닫는다(마감 거부층은 두지 않는다 — 잠긴 결정 4):

```
enqueue(봇): pending/X 작성, X.expires_at = enqueue시각 + CHAT_BRIDGE_TIMEOUT ← 종단 마감 단일 원천
              (봇 폴링 마감도 같은 expires_at 에서 계산 — 이중 시계 금지)
claim(소비자): now + CHAT_SDK_GEN_TIMEOUT + 기동여유 ≤ expires_at  그리고  next-action == 그 단계 생성 차례
              아니면 클레임 안 함(만료 → failed/ 이동 · 전이완료 → 삭제)
job kill(구조적 보증 — supervisor 자기집행 1차 · 데몬은 백스톱): kill_at = min(클레임시각 + CHAT_SDK_GEN_TIMEOUT, expires_at)
              잡마다 detached supervisor(그룹 리더)가 주/복구 세션을 spawn(그룹 상속 — 세션의 Bash 자식도 그 아래)
              → TERM=kill_at-유예₁ · KILL=kill_at-유예₂(마감 전) · kill_at=그룹 소멸 확인(reap 검증)
              (supervisor 급사 시 데몬 백스톱은 pgid 직격이 아니라 nonce 검증-후-kill — 잠긴 결정 4 2차 개정)
              마감 거부층 없음(잠긴 결정 4) → 마감 뒤 생존은 불가하나 마감 직전 시작된 전이가 KILL 전에
                 끝나는 창은 남는다 — 늦은 전이는 유해하지 않고 봇 화해 버튼·core 락이 흡수한다
사람 소비자(절차적): 동일 2중 검사 + "expires_at 뒤 전이 금지" 규약(jobs/README v2) — 타이머 강제는 불가함을 명시
bot timeout: 실패 카드(+[상태 다시 확인] 버튼 — 늦은 전이 화해) + pending/X 회수
              ↳ 아무도 클레임하기 전에 회수되면 core 는 여전히 그 단계 생성 차례인데 챗엔 되살릴 동작이
                 없다(고아) → 화해 경로의 [다시 만들기]가 next-action 재조회 후 **새 expires_at 으로 재적재**
reaper: claimed/ 고아 → 재큐 전 동일 2중 검사(만료·전이완료면 재큐 안 함 — stale 재실행 차단)
```

- 봇(게이트웨이)의 변경은 **additive 4건뿐**(expires_at 기재 · 타임아웃 시 회수 · 실패 카드 [상태 다시 확인] 버튼 ·
  화해 경로의 [다시 만들기] 재요청) — 큐·커널 로직 불변.
  - **[다시 만들기]가 왜 필요한가**: 마감이 **아무도 클레임하기 전에** 지나면 회수가 pending 을 지우는데 core 는
    여전히 `action=generate` 다 — 그 런은 챗에서 되살릴 동작이 없어 고립된다. 버튼은 **읽기전용 화해 경로**
    ([상태 다시 확인])에 달리고 — **실패 카드가 아니다** — next-action 을 재조회해 **여전히 그 단계 생성 차례일
    때만** 새 마감의 잡을 **새로** 적재한다(이미 전이됐으면 카드만 갱신). 클레임된 잡을 되살리지 않으므로 이중 소비
    표면이 늘지 않는다.
- P4 에 스캐폴드한 `AgentSdkGenExecutor`(봇 in-process 실행)는 스캐폴드로 남되 **기본 비활성**이며, **구독
  인증으로는 쓸 수 없다**(정책 실측 — 개정 r10 의 1번: SDK 는 API 키 경로). 포트(`SdkGenerate`)가 동일해 어떤 실행기를
  꽂아도 커널은 무수정이라는 점만 유효하다.

## 4. 유지보수성 원칙 — 설계 규칙 → 코드 배치

| 규칙 | 코드 배치 | 왜 유지보수가 쉬운가 |
|---|---|---|
| **포트 동결·어댑터 추가(additive-only)** | `NlParser`(stub·api·cli) · `GenExecutor`(stub·bridge·sdk) · `SdkGenerate`(데몬/in-process 공용) | 새 백엔드 = 구현 파일 1개 + 선택기 한 줄. 기존 구현 무수정 |
| **파서 계약 단일 모듈** | `nl/contract.ts`(가칭): 시스템 계약문(명시 선언만·도메인 추론 금지 — AGENTS 규칙 8)·의도 JSON 스키마·응답 매핑을 api/cli 파서가 **공유** | rule 8 이 프롬프트 복제본마다 흩어지지 않는다(중복 진실 제거) |
| **지시문 SSoT 재사용 + 권한은 코드** | 세션 프롬프트 = `core/skills/<stage>/SKILL.md` 원문의 **결정론적 치환 산물**(복제 금지 — 워커가 스크립트 호출을 절대경로로, `<RUN>` 을 rid 로 바꾼다). 스킬의 생성-밖 행위(승인류)는 **allow 규칙이 없다는 사실만으로 승인 필요 → 헤드리스 fail-closed**(부록A-5) — 프롬프트를 신뢰 경계로 쓰지 않음 | 스킬은 한 곳, 경계는 코드 한 곳. 치환이 결정적이라 프롬프트와 허용 규칙이 **한 소스에서** 나온다(어긋날 수가 없다) |
| **경계 = CLI 네이티브 통제 3층(코드가 조립)** | **cwd = 런 디렉터리 + `--add-dir` 고정 경로**(읽기 기본-거부) + `--allowedTools`(전이·emit-context·스테이지 보조 Bash 규칙 = 승인 게이트의 예외 등록) + 격리 `CLAUDE_CONFIG_DIR/settings.json` 의 `permissions.deny`(경계 **안쪽** 예외: `state.json`·`run.md`·`.lock` 쓰기) + `--max-turns`. 인자·규칙·settings 는 **워커 코드가 잡 값과 SKILL.md 치환 산물로 결정론적으로 조립**(`worker/` 순수 함수 — 단위 테스트 대상) | 경계가 프롬프트가 아니라 **cwd 선택 + 설정 파일·인자 한 곳**에 모인다. 스킬이 보조 작업을 추가하면 허용 규칙 한 줄 diff 로 드러난다(**의도적 중복** — 조용한 드리프트 대신 시끄러운 실패, 보안 > DRY). 강도는 부록A-3·A-4·A-5 의 관측으로 확정됐다 — 읽기는 열거 누락이 불가능한 구조적 경계라 r8 의 realpath 허용목록보다 강하고, 규칙 매칭은 버전 종속이라 CLI 업그레이드 시 적대 카나리를 재실행한다 |
| **이음새는 파일 큐 하나(프로토콜 v2)** | `pending/ → claimed/<consumer>/ → (성공 삭제 · 실패 failed/)` + `expires_at` — 데몬·운영자·봇이 이 규약만 안다. 규약 문서 = `chat/jobs/README.md`(Q3 개정) | 소비자 교체·수동 개입·재처리가 파일 조작으로 끝난다. 이중 소비=rename, 늦은 성공=마감이 차단 |
| **명시 스위치 + fail-fast** | `CHAT_NL_PARSER=auto\|stub\|cli\|api`(기본 auto) — 명시했는데 불가면 기동 시 중단. 타임아웃 정합(`CHAT_SDK_GEN_TIMEOUT ≤ CHAT_BRIDGE_TIMEOUT`)도 기동 시 검증 | 운영 중 "왜 stub 이지?" 미스터리 제거 |
| **fail-closed 기본** | 파서 실패→stub 폴백 · 미등재 명령→거부 · 복구 실패→`failed/` 격리+알림 · 만료 잡→미클레임 · 부분 성공 없음 | 실패가 조용히 통과로 둔갑하지 않는다 |
| **무인 spawn 위생 한 곳** | 공통 유틸: **화이트리스트 재구성**(최소 env + 필요한 것만 주입) + **전용 `CLAUDE_CONFIG_DIR`**(사용자 훅/플러그인/MCP/`apiKeyHelper` 미로드) + 스크럽 목록(`ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·클라우드 모드 플래그·Slack 비밀·활성 `CODEX_*`·상속 `CLAUDECODE*`·`HARNESS_ACK_GAPS`[스크럽이 아니라 **0 핀 고정** — core .env set-if-unset 로더가 unset 을 되채우므로]) | 스크럽 중복·누락 방지 + env 밖 경로(설정 파일)의 과금 우회까지 봉쇄 |
| **테스트 3계층 결정성** | 단위(fake spawn·권한 정책 함수·수명주기)·stub E2E(오프라인 결정적)·라이브 체크리스트(문서) | live-only 를 CI 에 섞지 않아 CI 가 늘 결정적 |
| **결정은 사람·감사 불변** | 게이트 버튼·`--by` 감사 체인 무변경 + 무인 세션은 승인류 호출이 구조적으로 불가 | 규제 통제가 무인화와 직교 — 코드가 보증 |

## 5. 컴포넌트 설계

### 5-1. Q1 — `CliNlParser` (chat 전용 · 도구 0 헤드리스 파싱)

`chat/src/kernel/nl/cli-parser.ts` — `NlParser` 포트의 세 번째 구현. **Slack 텍스트는 불신 입력**으로 취급한다.

- **파서 계약 공유(단일 모듈)**: 시스템 계약문(“**사용자가 명시적으로 선언한 값만** 추출 — 내용으로 도메인을
  추론·분류 금지[AGENTS 규칙 8], 미확신은 비움”)·의도 JSON 스키마·응답 매핑(`intentFromToolInput`)을
  `nl/contract.ts` 로 추출해 **기존 `LlmNlParser`(api)와 이 파서(cli)가 같은 소스를 소비**한다.
- **출력 프로토콜(실측 확정)**: `claude -p` 의 `--output-format json` 은 **봉투(envelope)** 를 돌려준다 —
  의도 필드는 최상위가 아니라 `structured_output`(스키마 지정 시) 또는 `result`(텍스트) 안에 있다.
  1차 = `--json-schema <의도 스키마>` + `structured_output` 파싱. 설치 CLI 가 미지원이면 폴백 =
  `result` 텍스트를 JSON 파싱(코드펜스 제거). **Q1 첫 작업이 이 표면 실측**이며, 확정 결과를 본 문서에 추기한다.
- **도구 0 경계**: 빈 cwd 만으로는 부족 — 사용자 설정·훅·플러그인·MCP·내장 도구가 남는다. 강제 수단:
  ① 도구 비활성 플래그(빈 허용목록 — 정확한 플래그는 Q1 실측으로 확정) ② **전용 `CLAUDE_CONFIG_DIR`**(빈 격리
  설정 — 훅/플러그인/MCP/`apiKeyHelper` 미로드) ③ 응답 봉투의 턴/도구 사용 지표 검증 — **도구 호출이 1건이라도
  있으면 그 결과를 버리고 stub 폴백**(단위 테스트로 강제) ④ 프롬프트에서 사용자 텍스트를 구분자로 격리.
  (참고: `--bare` 는 인증을 `ANTHROPIC_API_KEY`/`apiKeyHelper` 로 **강제**해 OAuth·keychain 을 아예 읽지 않는다 =
  **API 과금 경로**라 본 설계와 양립 불가 — 부록A-6 · 잠긴 결정 6. 위 ①~④ 조합으로 대체.)
- **spawn**: stdin=`</dev/null`(행 방지) · wall-clock 타임아웃 `CHAT_NL_CLI_TIMEOUT`(기본 120초, 초과 시 프로세스
  트리 kill) · 출력 상한(기존 32MiB 캡 재사용) · cwd=빈 스크래치 디렉터리(프로젝트 컨텍스트 미로드).
- **env**: 4절 위생 유틸 적용(화이트리스트 재구성 + 전용 CONFIG_DIR + 스크럽 목록 전체).
- **실패 = stub 폴백**: 비-0/타임아웃/JSON 파싱 실패/도구 사용 감지 → `StubNlParser`(기존 계약과 동일 — flow 무중단).
- **선택기** `selectNlParser` 확장(명시 스위치 규칙):
  1. 오프라인(`HARNESS_OFFLINE=1`) → stub (CI 결정성, 불변)
  2. `CHAT_NL_PARSER` 명시(stub|cli|api) → 그대로. **명시인데 불가**(cli: `claude` 미발견 / api: 키 없음) → 기동 시 fail-fast
  3. auto(기본): `claude` 실행파일 발견 → cli · 아니면 `ANTHROPIC_API_KEY` 있으면 api · 아니면 stub
- **UX 가드(선택)**: 파싱 5~15초 지연 대비, 멘션 직후 "읽는 중" Progress 카드 1장(기존 표현 재사용).
- **과금 활성화 게이트(잠긴 결정 6)**: 첫 실콜 후 ① API 콘솔 무과금 ② 구독(또는 크레딧) 사용량 이동 확인 ③
  spawn env·설정 격리 증적 로그 1줄. **이 확인 전에는 cli 파서를 기본(auto)에서 제외**(명시 opt-in 만).

### 5-2. Q2 — S-1 스파이크 (실측 반나절~1일 · 코드 변경 0)

> **집행 = [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md) 의 W1**(ⓐ~ⓓ 동일 항목). 실측 결과는
> 그 문서 부록에 추기한다 — 아래는 그 실측이 무엇을 확정해야 하는지의 설계 근거다.

순서대로, 스크래치 런에서:

- ⓐ **마커 실측**: 도구를 켠 실 CLI 세션(`claude -p`)의 Bash 서브프로세스에서 `env | grep -E 'CLAUDECODE|CLAUDE_CODE'`
  — 네이티브 주입되면 끝(실 CLI 는 자기 Bash 도구에 마커를 스스로 주입할 가능성이 높아 ⓑ 자체가 소멸할 수 있다).
- ⓑ **미주입 시 — 세션 env 에 한해 명시 선언 주입**: 데몬이 **세션 spawn env** 에 `CLAUDE_CODE_ENTRYPOINT=cli-worker`
  를 넣는다(세션 밖 프로세스 주입은 금지 — 잠긴 결정 4). 근거: (i) 실질 보증은 게이트 ③(산출물 선행)+도구 경계(5-3)
  이고 (ii) 마커가 공급하는 엔진 라벨(claude)은 실 CLI 세션에서 사실이며 (iii) 라벨 소비처(self-review 가드)와
  심의(원격 ADK·타 벤더)는 충돌 불가(2절).
- ⓑ' **CLI 통제 실측(r9 신설 — 잠긴 결정 3 의 확정 조건)**: `--allowedTools` 규칙 문법이 전이 명령을 인자 고정으로
  좁히는지 · 경로 스코프 `Edit`/`Write` 규칙이 실제로 그 경로 밖을 막는지 · 격리 settings 의 `permissions.deny` 가
  읽기(`.env`·타 런)·승인류 Bash 를 막는지 · 복합 셸 우회(체이닝·치환·인자추가·경로변형)가 규칙을 빠져나가는지.
  **막힘이 실측된 것만 열고, 나머지는 미허용**(추측 금지 — Q1 `--tools` 교훈).
- ⓒ **과금·상한 실측**: 1개 스테이지 생성 1런 → 과금 귀속 확인(잠긴 결정 6 — 구독/크레딧/API 중 어디에 잡히는지
  실측이 정답) · 세션당 비용/턴 로그 · 행(hang) 시 타임아웃 동작 · **턴 상한 동작**(`--max-turns`) 확인.
- ⓓ **스킬-게이트 호환 실측(단계별 — 잠긴 결정 7 의 입력)**: 각 스테이지 스킬 지시문을 무인 세션에 그대로 주고
  게이트(검증·전이)까지 통과하는지 단계별 dry-run. **통과 단계만 무인 enablement 목록에 편입**(브리프 구간부터).
  이 과정에서 필요한 보조 명령을 **허용 규칙 초안**으로 수확한다(emit-context·examples_analysis 등).
  드리프트 발견(예: keyvisual 스킬 2안 vs 게이트 3안 류) = core 스킬 버그로 **별도 트랙 보고**(core 변경 합의 —
  무인화 범위에 편입하지 않고 우회하지도 않는다).
- **통과 기준**: 스크래치 런 1개 스테이지가 실 CLI 세션 생성 → insession 전이 → next-action 게이트 도달까지 완주 +
  과금 귀속 실측 확인 + 도구 경계 스모크(승인류 명령 거부 확인). 실패 시: C2 유지(폴백 확보), 실패 지점을 기록.

### 5-3. Q3 — `cli-consumer` 무인 소비 데몬 (S-1 통과 시)

`chat/src/worker/cli-consumer.ts`(+ 기동 진입점) — **봇과 별개 프로세스**. 프로토콜 v2(잠긴 결정 2)의 소비자 구현.

> **집행 = [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md) 의 W2~W5**(큐 v2 → cli-session-runner →
> 데몬 → 라이브). 아래는 그 구현이 만족해야 할 설계다.

**(A) 큐 프로토콜 v2** (`chat/jobs/README.md` 를 같은 변경에서 개정 — 사람 소비자 규약도 함께):

```
jobs/pending/<rid>-<stage>.json    # 봇이 적재(+ expires_at = enqueue + CHAT_BRIDGE_TIMEOUT)
  → 클레임 전 2중 검사(사람도 동일): ① now + 잡 예산 ≤ expires_at  ② next-action == 그 단계 생성 차례
      · 만료 → mv failed/ (+.reason)   · 이미 전이됨 → 삭제   · 통과 → mv claimed/<consumer-id>/
  → 성공: claimed/<...>/X 삭제 (봇은 next-action 폴링으로 전이 감지 — 기존)
  → 실패: mv claimed/<...>/X failed/X + 사유 파일 — 부분 성공 없음, Slack 실패 카드(기존 경로)
봇 타임아웃: 실패 카드 + pending/X 회수(additive — 만료 잡 잔존해도 2중 검사가 클레임을 막는 2중 방어)
기동 reaper: claimed/ 고아(하트비트 만료) → **동일 2중 검사 후** pending/ 복귀(만료·전이완료면 복귀 안 함 — stale 재실행 차단)
```

**(B) 잡 실행** (잡당 fresh 세션 · 아티팩트 핸드오프 · 상주 금지 · **enablement 목록 단계만** — 잠긴 결정 7):

1. `core/skills/<stage>/SKILL.md` 원문 + 런 컨텍스트(rid)로 세션 프롬프트 구성(지시문 SSoT 재사용)
2. 세션 실행(cwd=core, 4절 env 위생, 마커는 ⓐ/ⓑ 에 따라 세션 env 에) — 세션이 산출물 작성 후 **세션 안에서**
   전이 명령 실행(스킬 지시문에 이미 포함된 그 명령)
3. **도구 경계(잠긴 결정 3 — CLI 네이티브 통제 3층 · 인자·설정은 워커 코드가 잡 값으로 조립)**:
   - **① 허용 — `--allowedTools`(정확·최소)**:
     - **전이·emit-context Bash 규칙**: `bash scripts/run-stage.sh …` 를 잡 값(stage·rid)으로 고정한 규칙. 세션
       프롬프트에는 그 캐논 문자열을 그대로 제시한다(도구 어댑테이션 프리앰블 — **안내일 뿐 경계가 아니다**)
     - **스테이지별 보조 Bash 규칙**(Q2-ⓓ 수확분 — 예: guideline 의 `examples_analysis.py`)
     - **`Edit`/`Write`**: 자기 단계 산출물 디렉터리 `runs/<rid>/<단계>/**` 로 경로 스코프
     - **`Read`/`Glob`/`Grep`**: 경계는 아래 ②의 deny
   - **② 거부 — 격리 `CLAUDE_CONFIG_DIR/settings.json` 의 `permissions.deny` + `--disallowedTools`(2차 방어)**:
     - **읽기**: `.env`(core·상위 어디든)·타 런 `runs/*`(자기 rid 제외)·`chat/jobs/**`·설정/자격증명 경로
       (`~/.claude/**` 등). 무인 세션은 사용자 제공 문서를 읽으므로 prompt injection 의 유출 표적이다(R-11) —
       비밀이 세션에 필요한 경우는 없다(이미지·ADK 비밀은 core 스크립트가 자기 .env 에서 읽음)
     - **쓰기**: `state.json`·`run.md`·`.lock`·런 밖
     - **Bash(결정·상태변이 — 결정은 사람)**: `approve/select/revise/gate/kcia-check/new-run/ingest-bundle/ingest/
       intake/apply-*/advance-phase`. r8 에선 "자유 셸 부재"가 1차 방어라 이 목록이 2차 문서화였지만,
       **r9 에선 이 목록 자체가 1차 방어**다 → 적대 테스트의 주 대상
   - **③ 상한**: `--max-turns`(`CHAT_SDK_MAX_TURNS`) + 잡 wall-clock(supervisor kill — C절) + 출력 캡
   - **조립은 순수 함수**로 분리해 단위 테스트(인자·settings 생성의 결정성) — 스킬 문구가 바뀌어도 경계는 코드가
     쓴다. 단 **경계의 강도는 조립이 아니라 CLI 규칙 엔진이 정하므로**, Q2-ⓑ' 실측 결과를 **적대 우회 표**(체이닝
     (`;`·`&&`)·치환(`$(…)`)·인자추가(`--proceed-with-gaps` 등)·경로변형·타 rid·승인류 — 전부 거부)로 고정해
     회귀시킨다(7절)
   - ⚠ **규칙 문법·매칭 동작은 Q2-ⓑ' 실측으로 확정**(추측 금지 — Q1 `--tools` 교훈): 인자 고정·경로 스코프가 실제로
     좁혀지는지, 복합 셸 우회가 규칙을 빠져나가는지. **막힘이 실측된 형태만 열고, 확인 안 된 것은 열지 않는다**
   - ⚠ **r9 미해결 ⑴ — 읽기 경계의 기본값이 뒤집힌다**: r8 의 읽기 **allowlist**(현재 런 `runs/<rid>/**` + 고정 core
     지침·스키마·프롬프트 경로 + 선언 도메인의 `packs/<도메인>/**`·`packs/_format/**`[emit-context 가 방출하는
     룰셋·포맷 캐논 = 필수 입력]만 허용, realpath 정규화 = **기본 거부**)가 CLI 통제에서는 **deny 목록(기본 허용)**
     으로 바뀐다 — "열거되지 않은 경로는 읽힌다"가 잔여 위험으로 남는다. Q2-ⓑ' 는 deny 규칙의 경로 매칭(심링크·
     상대경로 우회 포함)과 함께 **읽기를 허용목록으로 표현할 수 있는지**도 실측한다 — 가능하면 기본-거부로 되돌린다
   - ⚠ **r9 미해결 ⑵ — keyvisual 전용 타입드 도구 2건**: r8 이 SDK 타입드 도구로 설계한 ㉮ **합성 `generate_images`**
     (`image_preflight → must_fill 결손이면 즉시 실패 → image_engine → 완성 매니페스트 확인` 순서를 코드가 강제 —
     R4-2·R-12) ㉯ **`storyboard_coedit`**(keyvisual 보완 시 core 프롬프트가 허용하는 범위 = **기존 블록**의
     `claims[].target_text`·각주 텍스트만 패치 · 블록 생성/삭제·증거 ref·순서·type·visual 은 해시 보존으로 불변 강제 ·
     활성 = `phase=04-keyvisual && step=generate && status ∈ {revise, changes_requested}` — R6-2·R7-1·R-13)은
     실 CLI 에 꽂을 지점이 없다. keyvisual 은 enablement **마지막**이므로(잠긴 결정 7) 그 전에 재설계·재합의하고,
     **그때까지 keyvisual 은 무인 편입 금지**. 그 사이 남는 보증: ㉮ 는 core `run-stage.sh` 자신의 preflight(비용성
     이미지 생성 직전 결손 점검)가 세션-경로에서 그대로 돌고 **`HARNESS_ACK_GAPS=0` 핀 고정**(core `.env` 로더가
     set-if-unset 이라 unset/스크럽은 .env 값으로 되채워짐 — 빈값·핀 고정만 유효, harness-cli 의 Slack 비밀 스크럽과
     동일 교훈)이 env 경유 override 를 막는다(단 `--proceed-with-gaps` **인자 추가** 차단은 이제 허용 규칙의 매칭에
     달렸다 — Q2-ⓑ') · ㉯ 는 대응물 없음(03-storyboard 디렉터리 쓰기를 열면 승인된 storyboard 과대 변경 위험, 안 열면
     현업 보완 경로 차단 — 둘 다 불가하므로 재설계 없이는 진행 불가)
4. **백스톱 = 복구 세션**: 세션 종료 후 데몬이 next-action 으로 전이 확인. 미전이 + 산출물 존재 시
   **전이 규칙 1건만 허용된 최소 복구 세션**을 1회 spawn — 단 잡의 **kill_at(= min(클레임+예산, expires_at))
   안에서만**(잔여 부족 시 복구 생략 → failed/). concept·storyboard-plan 처럼 산출물-재개 예외에 없는 단계도 이
   경로가 insession 재진입으로 복구한다(2절 실측). 그래도 실패면 `failed/` 격리 + Slack 실패 카드.
   **데몬이 마커를 갖고 core 를 직접 호출하는 일은 없다.** 주/복구 세션은 전부 잡 supervisor 가 spawn
   (잠긴 결정 4 토폴로지). **마감 강제 = supervisor 자기집행이 1차**(살아있는 동안 TERM/KILL/reap) · **데몬은
   supervisor 급사 시의 백스톱**이다 — 파일의 pgid 를 직격하지 않고 **소유권 원장의 nonce 를 신호 직전 검증한
   뒤에만** 회수한다(잠긴 결정 4 **2차 개정** — 1번 절 개정 노트). 데몬이 우아하게 회수할 땐 **supervisor 에
   SIGTERM 을 먼저** 보내 종료 전파(**1차 개정**)가 세션 그룹을 정리하게 한다.
5. 성공 시 잡 삭제 → 봇의 next-action 폴링이 전이를 감지해 카드 자동 갱신(기존 동작)

**(C) 가드** (리서치 3-2 + R1-6·R2-2):

- **잡 kill_at = min(클레임시각+`CHAT_SDK_GEN_TIMEOUT`, `expires_at`) 은 검증된 정적 시각** — supervisor 토폴로지
  (잠긴 결정 4)로 한 그룹, TERM=`kill_at-유예₁` · KILL=`kill_at-유예₂`(마감 전) · `kill_at`=그룹 소멸 reap 확인.
  이것이 데몬의 구조적 보증이다(사람 소비자는 절차적 — 3절). ⚠ **r9**: r8 이 여기 겹치던 전이 허용 콜백의
  monotonic 마감 거부는 대응물이 없어(잠긴 결정 4 ⚠) **"마감 뒤 시작조차 불가"는 더 이상 주장하지 않는다** —
  마감 직전 시작된 전이가 KILL 전에 끝나는 창이 남고, 그 어긋남은 봇의 [상태 다시 확인] 화해 버튼과 core 락·
  멱등 게이트가 흡수한다
- **기동 시 정합 검증**: `CHAT_SDK_GEN_TIMEOUT + 기동여유 ≤ CHAT_BRIDGE_TIMEOUT` 위반 = fail-fast
- **턴 상한** `CHAT_SDK_MAX_TURNS`(기본 50 — 잡당 폭주의 경성 상한) + 세션당 비용/턴 로그
- **사용량 임계 자동정지** `CHAT_SDK_USAGE_PAUSE_PCT`(기본 95): **잡 시작 전** 확인(94%에서 시작해 잔여를 다
  태우는 창은 턴 상한+잡 예산이 봉쇄). 측정 수단은 스파이크 ⓒ에서 확정 — 측정 불가 시 폴백 = 일일 잡 수 상한
  `CHAT_SDK_DAILY_JOB_CAP`(비용 상한이 아니라 **잡 수 상한**임을 명시 — 진짜 비용 경계는 턴 상한과 잡 예산)
- stdin 차단 · 하트비트 파일 · 기동 reaper(A 절 2중 검사 포함) · 동시성 1(직렬 — 구독 보호, 확장은 후속)
- **관측성**: 잡당 1줄 로그(rid·stage·대기시간·소요·턴·비용·결과) — 기존 timing.jsonl 사상과 동일(챗 레이어 파일)

## 6. env 규약 (전부 chat 레이어 — `chat/README.md` 가 문서 소유, core config-reference 무관)

| env | 기본 | 뜻 |
|---|---|---|
| `CHAT_NL_PARSER` | `auto` | NL 파서 선택(stub·cli·api·auto). 명시인데 불가 = 기동 fail-fast. cli 는 과금 게이트(5-1) 통과 전 auto 제외 |
| `CHAT_NL_CLI_TIMEOUT` | `120` | CliNlParser 1콜 상한(초) |
| `CHAT_NL_MODEL` | (기존) | cli/api 공용 모델 지정 |
| `CHAT_BRIDGE_TIMEOUT` | `900` | 봇(브리지) 생성 대기 상한(초) — 기존 하드코딩 600 을 env 로 승격. 잡 `expires_at` 의 원천 |
| `CHAT_SDK_GEN_TIMEOUT` | `480` | 데몬 잡 wall-clock(주+복구 세션 합산). `≤ CHAT_BRIDGE_TIMEOUT` 기동 시 강제 |
| `CHAT_SDK_MAX_TURNS` | `50` | 데몬 세션 잡당 턴 상한(폭주 경성 경계) |
| `CHAT_SDK_USAGE_PAUSE_PCT` | `95` | 사용량 임계 자동정지(잡 시작 전 확인) |
| `CHAT_SDK_DAILY_JOB_CAP` | `20` | 사용량 측정 불가 시 폴백(잡 수 상한 — 비용 상한 아님) |
| `CHAT_SDK_STAGES` | (Q2-ⓓ 결과) | 무인 enablement 단계 목록(콤마) — 미등재 단계 잡은 데몬이 집지 않음(잠긴 결정 7) |
| `CLAUDE_CODE_OAUTH_TOKEN` | (설정 필요) | 구독 인증 — 무인 spawn 은 전용 `CLAUDE_CONFIG_DIR` 격리(4절)라 **로컬 CLI 로그인이 가려진다** → 세션 spawn env 에 토큰 주입이 필수(Q1 라이브 실측). `ANTHROPIC_API_KEY`/`AUTH_TOKEN` 은 스크럽 — API 과금 경로 물리적 부재 |

## 7. 테스트 전략 (3계층 — 기존 verify.sh 계층 유지)

| 계층 | 무엇 | 결정성 |
|---|---|---|
| 단위 | CliNlParser(봉투 파싱·비-0·타임아웃·깨진 출력·**도구 사용 감지→폴백**) · 파서 계약 모듈 공유 · selectNlParser 분기·fail-fast · **CLI 통제 조립 순수 함수(`--allowedTools` 규칙·격리 settings `permissions.deny`·`--disallowedTools`·`--max-turns` 인자 조립의 결정성)** · **적대 우회 표(전이·emit-context·스테이지 보조 규칙 ✓ / 체이닝·치환·인자추가·경로변형·타 rid·approve 류 ✗ / state.json·run.md 쓰기 ✗ / 읽기: `.env`·타 런·jobs·`~/.claude` ✗)** — ⚠ 이 표는 **CLI 규칙 엔진의 실제 매칭을 Q2-ⓑ' 로 실측한 뒤 그 결과를 고정하는** 회귀 표다(조립 함수만 검증하면 경계를 검증한 게 아니다) · **잡 수명주기(만료 미클레임·전이완료 삭제·kill_at=min(…) 계산·reaper 2중 검사·잔여 부족 시 복구 생략)** · **supervisor kill 실증(KILL=kill_at-유예₂ 발사 후 kill_at 시점 reap 확인으로 자식 전부 소멸 — "결국 종료"가 아님, 프로세스 픽스처)** · env 위생(ACK_GAPS 0 핀 포함 — `.env` 에 `HARNESS_ACK_GAPS=1` 이 있어도 세션 env 는 0) · 타임아웃 정합 | 완전 결정적 |
| stub E2E | 기존 4건 불변 + 데몬 루프 stub 1잡 완주(pending→검사→클레임→전이→삭제) + 만료 잡 failed 격리 + 실패 잡 failed 격리 | `HARNESS_OFFLINE=1` 결정적 |
| 라이브 체크리스트(문서) | Q1 출력 프로토콜 실측 · S-1 ⓐⓑⓑ'ⓒⓓ · 과금 활성화 게이트 · 도구 경계 스모크(승인류·체이닝·경로 밖 거부) · Slack 실멘션(따옴표·공백 경로 파싱) · 데몬 1런 완주 · **CLI 업그레이드 시 적대 카나리 재실행**(규칙 매칭이 버전 종속이므로 — r9) | 사람 확인(CI 밖) |

kernel-neutral 가드(기존) 유지: `nl/cli-parser`·`worker/` 모두 플랫폼 단어 0.

## 8. 리스크

| # | 리스크 | 완화 |
|---|---|---|
| R-1 | 무인 세션의 게이트 월권(승인/심의/state.json 직접 조작) | **CLI 네이티브 통제 3층**(허용 규칙 최소·`permissions.deny`·`--disallowedTools` — 5-3 B-3) + 적대 우회 표 + 라이브 스모크. ⚠ r9: r8 의 "자유 셸 부재"라는 원천 차단이 사라져 **경계 강도가 CLI 규칙 매칭에 의존**한다 → Q2-ⓑ' 실측 전에는 어떤 단계도 무인 편입 금지 |
| R-2 | 과금 정책 유동·상충 + env 밖 과금 경로(`apiKeyHelper` 등) | 활성화 게이트=실측(잠긴 결정 6) + 전용 CONFIG_DIR 격리 + 확장 스크럽 + 턴/잡 예산 경성 상한. r9: 2026-07-15 정책 실측으로 **SDK 경로는 구독 인증 불가**가 확정됐고 실 CLI 경로만 남았다 — 재변경 대비로 CLI 업그레이드 카나리에 정책 재확인을 포함 |
| R-3 | 파서 프롬프트 인젝션(불신 Slack 텍스트) | 도구 0 경계 + 도구 사용 감지 시 폐기·폴백 + 구분자 격리 + 실행은 항상 버튼 |
| R-4 | 사람·데몬 이중 소비 / 늦은 성공 / stale 재실행 | 프로토콜 v2: rename + `expires_at` + 2중 검사 + **kill_at 결박(데몬 구조적)** + 사람=절차 규약 + 봇 [상태 다시 확인] 화해 버튼. core 락·멱등 게이트 최종 방어 |
| R-5 | 세션이 전이를 잊음 / 산출물-재개 예외 단계 | 복구 세션 백스톱(잡 예산 안에서 1회) — 데몬 직접 호출 아님. 실패는 failed/ 격리+알림 |
| R-6 | 스킬 필요 작업과 허용 규칙의 드리프트 | fail-closed(미허용 명령=시끄러운 실패) + Q2-ⓓ 실측 수확 + 단계별 enablement(잠긴 결정 7) — 조용한 월권·조용한 기능 파손 둘 다 불가 |
| R-7 | 봇-데몬 타임아웃 어긋남 / 클레임 오버헤드 창 | 종단 마감 모델(3절): `expires_at` 단일 원천(봇 폴링도 동일 시계) + 클레임 조건 + **kill_at=min(클레임+예산, expires_at)** + 기동 시 정합 검증 |
| R-8 | 봇/데몬이 개발 세션의 자식으로 뜰 때 env 오염(마커·키 상속) | 화이트리스트 재구성 + 스크럽(4절) — 상속 자체를 신뢰하지 않음 |
| R-9 | 마커 미주입 + 명시 선언의 적정성 논쟁 | 스파이크 ⓑ의 3근거 문서화(세션 env 한정). 불안 시 core 측 '워커 세션 공식 마커' 제안(후속 — core 변경이라 별도 합의). r9: 실 CLI 가 자기 Bash 도구에 마커를 **네이티브 주입**하면 이 리스크는 소멸한다 — Q2-ⓐ 가 판정 |
| R-10 | 스킬-게이트 드리프트(예: keyvisual 안 수 불일치)로 무인 단계가 게이트에 막힘 | Q2-ⓓ 단계별 dry-run 으로 사전 발견 → 해당 단계 미편입 + core 버그 별도 트랙 보고(우회 금지) |
| R-11 | prompt injection 으로 무인 세션이 비밀(`.env`)·타 런 데이터를 읽어 산출물로 유출 | `permissions.deny` 읽기 목록(`.env`·타 런·jobs·`~/.claude`) + 심링크·유출 적대 테스트(5-3 B-3). ⚠ **r9 잔여**: 경계가 allowlist(기본 거부) → deny 목록(기본 허용)으로 뒤집혀 "열거 안 된 경로는 읽힌다" — Q2-ⓑ' 에서 읽기의 허용목록 표현 가능성을 실측해 가능하면 기본-거부로 복귀 |
| R-12 | 무인 이미지 생성이 core 의 결손 점검(preflight)을 우회해 비용성 생성 강행 | core `run-stage.sh` 자신의 preflight(세션-경로에서 그대로 작동) + `HARNESS_ACK_GAPS=0` **핀 고정**(스크럽 무효 — .env set-if-unset) + `.env=1` 회귀 테스트. ⚠ **r9 미해결**: 합성 도구(preflight→결손 시 실패→engine→완성 확인)의 CLI 대응물 부재 + `--proceed-with-gaps` **인자 추가** 차단이 허용 규칙 매칭에 의존 → keyvisual 은 재설계 전까지 무인 편입 금지 |
| R-13 | keyvisual 동반 수정 권한이 승인된 storyboard 를 과대 변경 / 보완 경로 차단 | ⚠ **r9 미해결**: `storyboard_coedit` 타입드 도구(기존 블록 카피 필드만·타 필드 해시 보존)의 CLI 대응물이 없다. 디렉터리 쓰기로 열면 과대 변경, 안 열면 보완 경로 차단 — 둘 다 불가 → **재설계·재합의 전까지 keyvisual 무인 편입 금지**(enablement 마지막이라 일정 영향 없음) |

## 9. 단계·DoD

| 단계 | 내용 | DoD |
|---|---|---|
| Q1 | 파서 계약 모듈 추출 + CliNlParser + 선택기 + 위생 유틸 | **완료**(구현·Codex 클린·라이브 검증) — build ✓ · 단위(봉투·폴백·도구감지·fail-fast·스크럽·계약 공유) ✓ · 기존 E2E 4건 불변 ✓ · 라이브: 출력 프로토콜 실측 + 실멘션 파싱 + 과금 활성화 게이트 통과 |
| Q2 | S-1 스파이크(코드 0) | **완료(ⓓ 제외)**(= 실행 계획의 W1 · 결과 = 그 문서 부록A) — ⓐ 마커 네이티브 주입 확인 · ⓑ CLI 통제 실측(경계 모델 정정 → 이 문서 r10 이 흡수) · ⓒ brief·intake 무인 완주 · 허용 규칙은 SKILL.md 치환 산물에서 도출로 확정. ⚠ **ⓓ 과금 귀속 = 미완**(사람 콘솔 확인 · 코드 대체 불가) → **잠긴 결정 6 상 Q3 착수 전 해소 필요** |
| Q3 | 큐 프로토콜 v2(jobs/README.md 개정 + 브리지 additive 3건[expires_at·회수·화해 버튼]) + cli-consumer 데몬 + 도구 경계(CLI 네이티브 통제 3층 — Q2-ⓑ' 실측 반영) + `CHAT_BRIDGE_TIMEOUT` env 승격 | **진행 중**(실행 계획의 W2~W5 로 분해) — **W2 완료**(큐 v2 + 브리지 additive + `CHAT_BRIDGE_TIMEOUT` 승격: build ✓ · 단위 425/425 ✓ · stub E2E 4/4 ✓ · core 무수정 ✓) · **W3(세션 러너)·W4(데몬)·W5(라이브) 미착수**. 잔여 DoD: 단위+stub E2E(데몬 1잡·만료/실패 격리·클레임 경합·reaper 검사·**적대 우회 표 전항 거부**) · 라이브: enablement 단계 1개 무인 완주 · 도구 경계 스모크(승인류·체이닝 거부) · kill_at 그룹 kill 동작 |

각 단계 완료 시 Codex 리뷰(critical/high 0) 후 다음 단계 — 기존 dev-loop 방식 유지.
**Q2·Q3 의 집행 분해(W0~W5)와 실측 추기는 [`chat-unmanned-consumer-plan.md`](chat-unmanned-consumer-plan.md) 가 소유한다** —
이 문서는 설계(무엇을 왜)를, 그 문서는 실행(어떤 순서로·어디까지 실측됐는지)을 맡는다.

## 10. 고지

본 산출물·챗 레이어는 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다(AGENTS 7번 절). 무인화는 '생성'에
한정되며 승인·선택·RA 확인은 사람의 판단 기록이다 — 그 한정은 프롬프트가 아니라 코드(r9 에서는 워커가 조립하는
CLI 통제 설정)가 보증한다. 과금·정책 관련 서술은 작성 시점 실측이며 원문과 재실측이 우선한다.
