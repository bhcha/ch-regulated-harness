# Agent SDK 무인 생성 워커 리서치 — 인증·정책·사례 (2026-07-15)

> **지위**: 참조 스냅샷(작성 시점 사실 — 과금 정책은 유동이므로 원문 링크가 우선).
> **목적**: [`chat-hexagonal-gateway-plan.md`](../plans/chat-hexagonal-gateway-plan.md) P4(S-1 생성 무인화)의 근거 조사.
> 질문 3개 — ① 구독으로 무인 워커 인증이 되는가(토큰 과금을 피할 수 있는가) ② "챗 봇 → 잡 큐 → Claude 워커" 동형 사례가 있는가 ③ SDK 세션에 insession 신뢰 마커가 주입되는가.
> **조사**: 2026-07-15 세션 내 웹 리서치 2건(공식 문서 · 커뮤니티 사례). GitHub 레포 메타데이터는 `gh api` 로 2026-07-14 기준 확인.

---

## ⚠ 추기 — 정책 확정 (2026-07-15 실측 · 아래 본문보다 우선)

> **본문은 조사 시점 스냅샷 그대로 보존한다(수정하지 않음). 다만 아래 1부 1-2 "자동화 워크로드에 대한 명시 금지
> 없음"이라는 조사 결론은 그 뒤의 정책 실측으로 뒤집혔다** — 아래가 현재의 사실이다.

**실측(2026-07-15, 공식 legal 문서).** 구독 OAuth 는 **공식 CLI(Claude Code)의 통상적 사용에만 허용**되고,
**Agent SDK 를 포함한 제품/서비스 개발에는 API 키를 쓰라**고 명문화돼 있다. 또한 **2026-01-09 부터 구독 OAuth 의
SDK 인증은 서버측에서 차단**된다. 즉 본문 1-1 의 "`CLAUDE_CODE_OAUTH_TOKEN` 으로 SDK 를 구독 인증할 수 있다"는
경로는 **구독으로는 더 이상 성립하지 않는다**(SDK 를 쓰려면 API 키 = API 과금).

**설계 귀결.** 무인 생성 워커의 실행 표면은 **Agent SDK 세션 → 실 `claude` CLI 세션 spawn** 으로 옮겼다. 실 CLI 는
Q1(헤드리스 NL 파서)이 **같은 인증(격리 `CLAUDE_CONFIG_DIR` + OAuth 토큰 주입)으로 라이브 검증**했다. SDK 의
`canUseTool` 권한 콜백을 전제하던 도구 경계도 **CLI 네이티브 통제**(`--allowedTools` · 격리 settings 의
`permissions.deny` · `--disallowedTools` · `--max-turns`)로 재설계됐다.

**현행 설계·계획은 여기로.**
- 설계(r9) = [`chat-dual-surface-plan.md`](../plans/chat-dual-surface-plan.md)
- 실행 계획(W0~W5) = [`chat-unmanned-consumer-plan.md`](../plans/chat-unmanned-consumer-plan.md)

**본문에서 계속 유효한 것.** 인증 경로 서술(1-1)과 정책 판단(1-2) **외의** 조사 결과는 그대로 쓸모 있다 —
2부 사례(잡 큐 소비 무인 워커 패턴·과금 사고 사례), 3부 교훈 3가지(fresh 세션+아티팩트 핸드오프 · 자격증명 명시
검증 · 사용량 임계 자동정지), 벤치마크 레포. 이들은 SDK/CLI 어느 표면에서든 성립한다. 특히 **3-2 (b)의
"`claude -p`+OAuth 조합의 의도치 않은 API 과금 사고" 경고는 실 CLI 경로에서 더 중요해졌다** — 그래서 현행 설계는
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 을 스크럽해 API 과금 경로를 물리적으로 없앤다.

---

## 1부 — 공식 문서 (인증 · 정책 · 마커 · 호스팅 패턴)

### 1-1. Agent SDK 인증 방식 — 구독 인증 가능

Agent SDK 는 `ANTHROPIC_API_KEY`(API 과금) **외에** Claude 구독으로 인증 가능하다.

| 인증 방식 | 설명 | 과금 |
|---|---|---|
| `ANTHROPIC_API_KEY` | API 콘솔 발급 키 | API 과금(토큰당) |
| **`CLAUDE_CODE_OAUTH_TOKEN`** | **`claude setup-token`** 으로 생성(1년 유효) | **구독 사용량 차감** |
| 클라우드 제공자 | Bedrock · Vertex · Foundry | 해당 제공자 과금 |

구독 토큰 공식 명시(원문):
> "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It is scoped to inference only..."

출처: <https://code.claude.com/docs/en/authentication.md> (Generate a long-lived token 절)

### 1-2. 정책/약관 — 자동화 워크로드에 대한 명시 금지 없음

- 구독 토큰을 CI·봇·자동화에 쓰는 것을 **명시적으로 금지하는 공식 약관은 발견되지 않음**.
- Agent SDK overview 의 주의 문구: "Unless previously approved, Anthropic does not allow third party developers to
  offer claude.ai login... to their products" — 이는 **제3자가 자기 제품에 claude.ai 로그인을 내장해 파는 것**을
  막는 것이지, 자기 자동화에 자기 구독을 쓰는 것까지 금지한 게 아니다.
- Hosting 문서는 오히려 "Long-running sessions" 등 자동화 패턴을 **공식 권장**한다.
- 출처: <https://code.claude.com/docs/en/agent-sdk/overview.md> · <https://code.claude.com/docs/en/agent-sdk/hosting.md>
- 참고: 정책이 불명확한 지점은 **support@anthropic.com** 사전 확인 권장.

### 1-3. SDK 세션의 환경 마커 — 문서 미명시 (S-1 실측 필요 그대로)

- `CLAUDECODE` · `CLAUDE_CODE_ENTRYPOINT` 같은 세션 식별 환경변수는 **공식 문서에 명시되지 않음**.
- Hosting 문서에서 발견된 env: `ANTHROPIC_API_KEY` · `CLAUDE_CONFIG_DIR`(설정 디렉터리) ·
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`(다중 테넌트 격리용).
- 결론: **S-1 스파이크(SDK 세션 Bash 에 마커 주입 여부 실측)는 여전히 필요**하다.
- 출처: <https://code.claude.com/docs/en/agent-sdk/hosting.md>

### 1-4. 장기 실행 워커 패턴 — 공식 권장 4종

| 패턴 | 용례 | 사용 예 |
|---|---|---|
| Ephemeral | 1회성 작업 | 문서 번역, 버그 조사 |
| **Long-running** | **지속적 서비스** | **이메일 에이전트, Slack 챗봇, 사이트 빌더** |
| Hybrid | 주기적 상호작용 | 프로젝트 관리자, 장시간 리서치 |
| Multi-agent | 협력 에이전트 | 다중 에이전트 시뮬레이션 |

Long-running 원문:
> "Run persistent container instances, often hosting multiple SDK processes per container, to serve ongoing work.
> Best for agents that take autonomous action, serve content, or handle high-volume message streams."

추가 지원: 세션 지속성 `SessionStore` 어댑터(S3·Redis·Postgres) · OpenTelemetry 관측성 · 토큰/세션별 비용 추적.
출처: <https://code.claude.com/docs/en/agent-sdk/hosting.md> (Choose a session pattern 절)

### 1-5. 권장 다음 단계 (조사 에이전트 결론)

1. 자동화 워크로드의 정책 적합성을 support@anthropic.com 에 사전 확인.
2. 프로덕션 배포 시 <https://code.claude.com/docs/en/agent-sdk/secure-deployment.md> 의 credential management ·
   isolation 절 검토.

---

## 2부 — 커뮤니티·공식 사례

### 2-1. GitHub — Slack 봇 → Claude 직접 호출 계열

| 이름/링크 | 스타/활동 | 아키텍처 한 줄 | 인증/과금 | 배울 점 |
|---|---|---|---|---|
| [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) | 176⭐, 2025-06 이후 정체 | Slack 메시지마다 Claude Code SDK 를 프로그래매틱 호출(큐 없음), 스레드=세션 | API 키 / Bedrock / Vertex | 스레드별 작업 디렉터리 바인딩 패턴. 큐가 없어 무인 운영엔 부족 |
| [Innei/Kagura](https://github.com/Innei/Kagura) | 52⭐, 2026-07 활발 | Socket Mode → 스레드 컨텍스트 로드 → repo cwd 에서 Agent SDK/Codex 실행 → 스트리밍 회신, SQLite 세션·메모리 영속 | SDK 기반(키/구독 양쪽 가능) | 스레드-세션 매핑·재시작 후 세션 복원·중지 키워드 등 Slack 어댑터 완성도가 가장 높음 |
| [acip/slack-claude-agent](https://github.com/acip/slack-claude-agent) | 3⭐, 2026-07 활동 | 스레드당 Agent SDK 세션 1개, 브리지가 턴 직렬화, thread→session 맵 JSON 영속 | `claude` CLI 로그인(구독) 또는 `ANTHROPIC_API_KEY` | 쓰기 도구를 Slack 카드 승인 전까지 잠그는 plan-approval 게이트, Slack 재시도 dedup |
| [sweatco/archie-hq](https://github.com/sweatco/archie-hq) | 15⭐, 2026-07 활발 | Slack 위임 → PM 에이전트가 전문 에이전트 팀에 분배(Agent SDK), 상태는 DB 없이 파일+git | API 키 | **실운영 사례**(약 100인 회사를 단일 서버로 커버 주장). 브로커·DB 없이 파일 기반 상태로 크래시 복구 — 본 하네스의 파일 큐 철학과 동일 |
| [yuya-takeyama/cc-slack](https://github.com/yuya-takeyama/cc-slack) | 14⭐ | `/cc` 슬래시 커맨드로 디렉터리 선택 후 세션 시작(Go) | CLI 위임 | 최소 구현 참고용 |
| [AnandChowdhary/claude-code-slack-bot](https://github.com/AnandChowdhary/claude-code-slack-bot) | 11⭐, 2026-07 | Slack → Cloudflare Workers → GitHub 이슈 생성 → claude-code-action(CI)이 구현 | GitHub Actions 쪽 키/OAuth 토큰 | "GitHub 를 큐로 쓰기" — Slack 은 접수만, 실행은 CI 러너로 위임하는 무인 패턴 |
| [khaterdev/kirie](https://github.com/khaterdev/kirie) · [iaminawe/clawd](https://github.com/iaminawe/clawd) · [RobGruhl/hello-claw](https://github.com/RobGruhl/hello-claw) | 각 6/2/4⭐ | Agent SDK 상주 개인 비서(백그라운드 태스크, 샌드박스, HITL 승인) | API 키 | OpenClaw 대체 소형 구현들. hello-claw 는 in-process MCP + OS 샌드박스 + 승인 워크플로 |

### 2-2. GitHub — "잡 큐 소비 무인 워커" 계열 (본 하네스와 동형)

| 이름/링크 | 스타/활동 | 아키텍처 한 줄 | 인증/과금 | 배울 점 |
|---|---|---|---|---|
| [context-machine-lab/sleepless-agent](https://github.com/context-machine-lab/sleepless-agent) | **826⭐**, 2026-03 | Slack 봇 → SQLite 큐 → 데몬 이벤트루프 → Python Agent SDK 로 Claude Code 실행 → git 커밋/PR | **구독**(`claude login`), 사용량 96%/95% 임계로 자동 일시정지 | 구독 잔여 사용량을 야간에 소진하는 설계. 태스크별 격리 워크스페이스, 30분 비활성 타임아웃, Planner/Worker/Evaluator 턴 상한, systemd/launchd 데몬화 |
| [cgeene/commandcenter](https://github.com/cgeene/commandcenter) | 2⭐, 2026-07 신생 | `agentd` 데몬이 SQLite 큐 소유 → 태스크당 git worktree+tmux 창에 `claude` 세션 spawn → **독립 적대 리뷰어**가 거부 시도 → PR | 대화형 `claude`(구독) | 본 하네스와 철학이 가장 유사(큐+결정적 데몬+생성/심의 분리+사람 머지 게이트). "리뷰어는 워커 대화에 접근 불가 + 편집도구 거부" 격리 설계 |
| [rafael-adcp/kraken](https://github.com/rafael-adcp/kraken) | 2⭐, 2026-07 활발 | **GitHub Issues = 큐**, 이름 붙은 Claude Code 워커들이 라벨+comment 로 클레임 → 실행 → 증적 기록. 하트비트 comment + 시간별 reaper 워크플로 | Claude Code 플러그인(구독) | 인프라 제로 큐 + **죽은 워커 회수(하트비트/reaper)** 프로토콜. 단 워커는 사람이 터미널에서 `/kraken:unleash` 로 띄움 — 정확히 본 하네스의 현재 반자동(C2) 단계 |
| [ghostwright/phantom](https://github.com/ghostwright/phantom) | **1,447⭐**, 2026-07 활발 | Agent SDK 기반 상주 "AI 동료"(자기 컴퓨터·영속 메모리·MCP 서버·이메일 신원) | API 키 | Agent SDK 상주형 중 최대 규모 프로젝트. 상주 프로세스 설계 참고 |
| [TadMSTR/temporal-build-worker](https://github.com/TadMSTR/temporal-build-worker) | 0⭐ | Temporal 내구 실행 → task-queue async activity completion 패턴으로 Claude Code 세션 브리지 | — | "내구 워크플로 엔진 + 비동기 완료" — 장시간 생성 작업의 정석적 큐 패턴 |
| [GodModeAI2025/NightShift](https://github.com/GodModeAI2025/NightShift) · [terrapper/taskcommand](https://github.com/terrapper/taskcommand) · [johnapacher-sudo/claude-auto-worker](https://github.com/johnapacher-sudo/claude-auto-worker) | 13/0/0⭐ | 스킬/대시보드로 태스크 큐를 Claude Code 가 무인 소비 | 구독 | 동일 발상의 소형 변주들 — 이 패턴 자체가 2026년 커뮤니티 표준이 됐다는 증거 |

### 2-3. 블로그·경험담 — 무인 운영의 함정과 해법

- [Running Claude Code Autonomously Overnight — What Breaks](https://medium.com/@evekhm/running-claude-code-autonomously-overnight-what-breaks-and-how-to-fix-it-3bee3bd958b5)
  (Eva Khmelinskaya, 2026-05): **"자율 세션은 대화가 아니라 CI 파이프라인처럼 다뤄라."** 깨지는 것 = 컨텍스트 창
  포화(도구 출력 전부 유입) · compaction 후 CLAUDE.md 규칙 희석 · 백그라운드 stdin 행(`< /dev/null` 필수).
  해법 = 30~60분 단위 페이즈로 쪼개 페이즈마다 fresh `claude --print` + STATUS.md 아티팩트 핸드오프 +
  `--max-budget-usd` 가드.
- [ayautomate Headless Mode](https://www.ayautomate.com/resources/breakdowns/headless-mode): **BullMQ 워커가 잡마다
  `claude -p` 를 spawn**(타임아웃 120초 · `--output-format json` 파싱 · 지수 백오프 3회 · 소진 시 Slack 알림) —
  무인 워커의 교과서적 코드 골격.
- [Claude Code in CI/CD and Headless Automation](https://hidekazu-konishi.com/entry/claude_code_cicd_and_headless_automation.html):
  행(hang) 프로세스가 무한 과금하지 않도록 파이프라인 레벨 wall-clock 타임아웃으로 감싸라.
- [codewithseb CI/CD Playbook](https://www.codewithseb.com/blog/claude-code-headless-mode-cicd-automation-playbook) ·
  [amux self-hosting guide](https://amux.io/guides/claude-code-headless/): 토큰 예산·프로덕션 패턴.
- **과금 사고 사례(실존)**:
  - [claude-code#37686](https://github.com/anthropics/claude-code/issues/37686) — Max 구독자가 `claude -p` 안내를
    따랐다가 **이틀에 $1,800 API 과금**.
  - [claude-code#43333](https://github.com/anthropics/claude-code/issues/43333) — OAuth `claude -p` 가 구독이 아닌
    API 로 계산되는 케이스.
  - → 무인 워커에서 **어떤 자격증명이 실제로 잡히는지 명시 검증이 필수**.
- **과금 정책 현황(2026-07 기준 — 유동)**:
  - Anthropic 이 5/14 발표한 "Agent SDK·`claude -p`·서드파티 앱을 구독에서 분리해 월 크레딧($20/$100/$200)으로
    이관"하는 6/15 변경은 [공식 헬프센터](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)에서
    **보류(paused)** 확인 — 현재는 구독 한도에서 그대로 차감.
  - 단 [Zed 블로그](https://zed.dev/blog/anthropic-subscription-changes) ·
    [digitalapplied 분석](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026) 모두
    "정책 유동적, 재도입 예고됨"으로 판단.
  - SDK 를 안 거치고 구독 OAuth 를 흉내내는 방식(OpenClaw 류)은 이미 차단됨
    ([shareuhack 정리](https://www.shareuhack.com/en/posts/openclaw-claude-code-oauth-cost)).
  - 손익분기: [Max 5x 는 일 $3.33, 20x 는 일 $6.67 이상 쓰면 API 보다 유리](https://www.buildthisnow.com/blog/guide/development/claude-code-max-plan-vs-api).

### 2-4. Anthropic 공식

- [Claude Code in Slack → Claude Tag](https://code.claude.com/docs/en/slack): 공식 Slack 통합. @Claude 멘션 → 코딩
  의도 감지 → **claude.ai/code 클라우드 세션** 생성 → 스레드에 진행 게시 → PR 버튼. 실행은 로컬이 아닌 Anthropic
  클라우드 샌드박스, 과금은 멘션한 개인의 플랜 한도. GitHub 전용.
- [Claude Code Channels](https://code.claude.com/docs/en/channels) (2026-03 research preview): **채널 = 실행 중인
  Claude Code 세션에 이벤트를 push 하는 MCP 서버**. Telegram/Discord/iMessage 공식 제공, Slack 은 커뮤니티 커넥터로
  제작 가능. "챗 → 로컬 상주 세션" 브리지를 Anthropic 이 공식 프리미티브로 만든 것 — 본 하네스 `chat/` 게이트웨이와
  정확히 같은 문제 인식.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  + 예제 레포 [anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents) (485⭐):
  initializer 에이전트가 환경 셋업(init.sh·progress 파일·git 커밋) → 이후 세션마다 fresh context 로 "증분 진행 +
  구조화된 아티팩트 남기기". **세션 영속이 아니라 아티팩트 핸드오프가 공식 권장 패턴**.
- [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) ·
  [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents): 컨텍스트 수집→행동→검증 루프,
  서브에이전트 격리, 서버 호스팅 에이전트("뇌와 손 분리") 방향.

### 2-5. 한국어 자료

- [Luna(윤정) — Claude Code Scheduled Agents 로 일일 Slack 브리핑 자동화](https://medium.com/@yunjeongiya/automating-daily-slack-briefings-with-claude-code-scheduled-agents-b093e138cc4f)
  (한국어 버전 별도 존재): 클라우드 환경이 외부 HTTP 를 막아 **"git 을 메시지 큐로"** 사용(에이전트가 JSON 을 push →
  GitHub Actions 가 감지해 Slack webhook 발송). Max 구독 내 포함 과금.
- [gpters — Claude Code 스킬·세션을 슬랙에서 쓰는 OpenClaw 연동](https://www.gpters.org/dev/post/claude-code-use-skills-l8UEgc6QqBHJ3YN)
- [wikidocs — 클로드 코드 입문 11-4 Slack 통합](https://wikidocs.net/332181)
- [Hyperithm 기술블로그 — Claude Code 심화(GitHub Actions CI/CD 통합)](https://tech.hyperithm.com/claude_code_guides_2)
- [AI타임스 — 슬랙 클로드 코드 기능 보도](https://www.aitimes.com/news/articleView.html?idxno=204639)
- 한국어권은 대부분 공식 통합·OpenClaw 소개 수준이고, 자체 큐 워커 구축 경험담은 Luna 글이 유일하게 근접.

---

## 3부 — 종합

### 3-1. "잡 큐 소비 무인 워커" 패턴 Top 3

1. **sleepless-agent** (826⭐) — Slack 봇 → SQLite 큐 → 상주 데몬 → Agent SDK 실행기 → git 커밋/PR. 목표 구조(큐 +
   무인 소비)와 1:1 대응이며, 구독 인증으로 무인 운영하면서 **사용량 임계(95~96%)에서 자동 일시정지**하는 구독 보호
   장치까지 갖춤. 규모·완성도에서 최우선 벤치마크.
2. **cgeene/commandcenter** (2⭐, 신생) — SQLite 큐를 소유한 데몬이 태스크당 worktree+tmux 로 `claude` 를 spawn 하고,
   **워커 대화에 접근 불가한 독립 적대 리뷰어**가 검수 후에만 사람에게 도달. 스타는 없지만 생성/심의 격리·사람 머지
   게이트·예산 내 스케줄러까지 본 하네스 설계 어휘와 가장 겹침(설계 검증용 정독 가치).
3. **sweatco/archie-hq** (15⭐) — Slack 위임 → Agent SDK 멀티에이전트, **DB·브로커 없이 파일+git 만으로 상태 관리**하며
   실제 약 100인 회사 운영 주장. "파일 기반 큐로도 프로덕션이 된다"는 가설의 실증이자 Agent SDK 무인 워커의 가장
   성숙한 공개 코드.

차점: **kraken**(GitHub Issues 큐 + 하트비트/reaper 로 죽은 워커 회수 — 사람이 터미널에 워커를 띄우는 "현재 C2"
단계를 프로토콜화) · **ayautomate BullMQ 패턴**(무인화 시 코드 골격) · **Temporal 브리지**(내구 실행 필요 시).

### 3-2. 핵심 교훈 3가지

- **(a) 신뢰성** — 잡마다 fresh 세션 + wall-clock 타임아웃 + stdin 리다이렉트 + 하트비트/reaper + 턴·예산 상한이
  공통 처방(본 하네스 watchdog 설계와 일치).
- **(b) 과금** — 현재는 Agent SDK 도 구독 차감이 유지되나(6/15 변경 보류) 정책이 유동적이므로, 무인 워커는 API 키로
  분리하거나 구독 활용형(sleepless 방식)을 쓰려면 **사용량 임계 모니터링을 반드시** 넣을 것. `claude -p`+OAuth 조합의
  의도치 않은 API 과금 사고 사례 존재.
- **(c) 장기 세션** — 세션을 상주시키지 말고 아티팩트(progress 파일·git)로 핸드오프하는 것이 Anthropic 공식 패턴.

### 3-3. 본 하네스 설계와의 대조

| 커뮤니티 공통 교훈 | 본 하네스 상태 |
|---|---|
| 잡마다 fresh 세션 + 아티팩트 핸드오프(세션 상주 금지) | ✅ 이미 그 구조(잡 파일 → 산출물 파일) |
| wall-clock 타임아웃·행 방지 | ✅ core watchdog(`HARNESS_GEN_TIMEOUT` 등) |
| 하트비트 + 죽은 워커 회수(reaper) | ⚠ 부분(생성 하트비트만) — P4 워커에 reaper 추가 가치 |
| 구독 사용량 임계 자동정지 | ❌ 없음 — **P4 에 추가**(계획 반영됨) |
| 과금 자격증명 명시 검증 | ❌ 없음 — **S-1 통과 기준에 추가**(계획 반영됨) |

### 3-4. 계획 반영

이 리서치는 [`chat-hexagonal-gateway-plan.md`](../plans/chat-hexagonal-gateway-plan.md) P4 에 다음 4항목으로 반영됨
(2026-07-14/15): ① 인증 = 구독 OAuth 토큰 우선 검증 + 과금 자격증명 명시 검증을 S-1 통과 기준에 포함 ② 구독 사용량
임계 자동정지 가드 ③ 워커 위생(fresh 세션·아티팩트 핸드오프·하트비트·reaper) ④ 벤치마크 레포(sleepless-agent ·
commandcenter · archie-hq) + 공식 Channels.
