# 라이브 인수 검증 런북 — 무인 데몬 + AI 구동 온라인 E2E (수동 게이트)

> **지위**: `docs/reference/`(운영자용 참조 · 챗 레이어 문서 — core 정본 D-1 갱신 의무 밖).
> **관계**: [`../plans/chat-live-acceptance-test-plan.md`](../plans/chat-live-acceptance-test-plan.md)(라이브 계획 · 잠긴 결정) ·
> [`../plans/chat-atdd-acceptance-plan.md`](../plans/chat-atdd-acceptance-plan.md)(공용 하네스 · 이 라이브는 그 **온라인 백엔드**) ·
> [`../plans/chat-unmanned-consumer-plan.md`](../plans/chat-unmanned-consumer-plan.md)(W4 데몬 · W5=이 검증).
> **대상**: 이 하네스를 실 자격으로 한 번 돌려 **판정 가능한 트랜스크립트 1개**를 얻으려는 운영자.

---

## 0. 한 줄 정의

CI(오프라인 stub)가 표면 흐름을 결정론으로 이미 덮었다. 이 런북은 **CI 가 원리적으로 못 보는 것만**(실 Slack 렌더·실
과금·심의 비결정 작동·이미지 실생성) 사람이 한 번 확인하는 **수동 게이트**다. 멘션 이후부터는 **AI 드라이버**가 사람
대신 화면을 읽고 결정 버튼을 발화하며(잠긴 결정 1), **데몬**이 intake·brief 생성을 무인 소비하고, 그 너머 생성은
**운영자 세션**이 소비한다. 끝나면 **구조적 판정 리포트**로 통과/미충족을 읽는다(잠긴 결정 2).

> ⚠ **실 과금**: 이 런은 실제로 돈을 쓴다(아래 5단계 예산). CI 가 아니라 **1회 수동 실행**이다.

---

## 1. 무엇이 자동이고 무엇이 사람인가 (정직한 경계)

| 구간 | 누가 | 방식 |
|---|---|---|
| 화면 읽기·결정 버튼(select·approve·RA 확인) | **AI 드라이버**(`LiveDriver`) | 직전 렌더의 affordance 에서 도출해 커널 이벤트로 발화(잠긴 결정 1 · 지어낸 버튼 없음). 동시에 라이브 조립이 **프로덕션 봇과 같은 인터랙션 핸들러**(멘션·버튼 클릭·스레드 답글·DM 안내)를 게이트웨이에 배선하므로, 사람이 Slack 에서 언제든 직접 개입할 수 있다 — 드라이버는 자동 주행, 사람은 실 클릭(실측 확증은 라이브 리허설 몫). |
| intake·brief **생성** | **데몬**(`pnpm worker`) | 무인 세션(`CHAT_SDK_STAGES=intake,brief`). keyvisual 무인은 구조적 차단이라 넓히지 않는다. |
| concept·storyboard·keyvisual **생성** | **운영자 세션**(사람) | 봇이 Bridge 로 적재한 생성 잡을 운영자의 Claude Code 세션이 세션 내(insession) 소비(C2 브리지). = 잠긴 결정 4 확정. |
| 심의(원격 ADK) | 자동 | 화장품 = `ADK_COSMETICS_CRITIC_URL`. revise/escalation 으로 끝나도 **실패가 아니라 적대적 심의가 일한 유효 결과**다. |
| tee 참관·최종 판정 | **사람** | 실 Slack 채널에서 카드가 뜨는 것을 보고, 리포트로 구조 판정을 확인한다. |

> **드라이버 진행 규칙(라이브 드라이버 수정 반영)**: 드라이버는 판정(Verdict)·진행(Progress)·실패(Failure) 화면에서
> **유휴로 멈추지 않는다.** 표시 전용·자동 이어가기(캐스케이드) 화면은 다음 게이트가 뜰 때까지 유한히 대기하고,
> 실패(Failure)는 **[상태 다시 확인]** 버튼(읽기 전용 · 상태 변이·잡 적재 0)으로 core 상태를 다시 읽어, 그 사이 생성이
> **완료됐으면** 다음 게이트로 자동 회복한다(늦은 성공 흡수 · 유료 동작 0). **다만 재생성 요청(GenerateRetry)에서는
> 자동으로 [다시 만들기]를 누르지 않고 멈춘다** — 상태를 다시 읽어도 '생성 차례'로 남았다는 건 생성이 **완료되지
> 않았다**는 신호이고, 이 화면에서의 유료 재생성은 모호한 타임아웃 창(운영자 세션이 아직 생성 중)에서 **중복 과금·run
> 경합**을 부를 수 있어 사람 판단으로 남긴다. 정상 런에서는 생성이 제때 끝나 GenerateRetry 자체가 뜨지 않는다(성공 시
> 자동 이어가기로 다음 게이트로 넘어감). 사람/RA 판단이 필요한 **에스컬레이션(Escalation)**·**GenerateRetry**·**Done**
> 에서만 멈춘다. 심의가 낸 revise/escalation 은 정상 결과이지 실패가 아니다(적대 심의가 일했다는 신호).

---

## 2. 사전 조건 · 자격증명 (전부 fail-closed)

| 자격/설정 | env | 용도 | 부재 시 |
|---|---|---|---|
| 하네스 경로 | `HARNESS_ROOT` | core 체크아웃 절대경로 | 즉시 fail-fast |
| **온라인** | (`HARNESS_OFFLINE` **미설정**) | stub 누수 금지 | 설정돼 있으면 라이브 거부 |
| 규제도메인 | `HARNESS_DOMAIN` | 심의 스폰(guideline)에 도메인 선언 — `cosmetic`(등). **세 프로세스(드라이버·데몬·운영자 세션) 모두에 export** | guideline 심의가 fail-closed(`ingest.py` SystemExit)로 죽음 |
| 구독 인증 | `CLAUDE_CODE_OAUTH_TOKEN` | 무인/운영자 생성 세션 | 세션 인증 실패로 잡 failed |
| 이미지 실생성 | `NANOBANANA_API_KEY` | keyvisual 이미지(Gemini 2.5 Flash Image) | keyvisual 이미지 fail-closed die |
| 심의(화장품) | `ADK_COSMETICS_CRITIC_URL` (+ `ADK_COSMETICS_CRITIC_ALLOWED_HOST`) | 원격 ADK 심의 | 설정오류 fail-closed(자동 `KCIA_CRITIC_REQUIRED=1`) |
| 승인자 | `CHAT_APPROVERS` (드라이버 서비스 actor 의 끝 user id `svc-<봇id>` 포함 · 기본 `svc-driver`. 실 사람 승인자도 쓰면 콤마로 추가) | 승인/선택 잡 게이트 | 아무도 승인 못 함(잡 거부) |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | tee 게시·수신(Socket Mode) | tee 불가(커널 구동은 됨) |
| 무인 단계 | `CHAT_SDK_STAGES=intake,brief` | 데몬 enablement | 비면 데몬이 아무 잡도 안 집음 |
| 잡큐 공유 | `CHAT_JOBS_DIR` | 봇·데몬이 **같은** 잡 디렉터리를 봐야 핸드오프됨 | 서로 다르면 데몬이 봇 잡을 못 봄 |
| 인입 번들 | `CHAT_BUNDLE_DIR` | 크롤 번들(product.json·reviews.csv·images) 절대경로 | 인입 라우팅 불가 |
| 워킹백워드 | `CHAT_STAGED_WB` | 스테이징 WB .md 절대경로 | 인입 fail-closed |

라이브 진입점(`pnpm live`)이 추가로 읽는 값:

| env | 뜻 |
|---|---|
| `CHAT_LIVE_THREAD` | tee 할 Slack 대상 — **`slack:<채널ID>` 복합 id 필수**(예 `slack:C0BJAELG2KU`). 특정 스레드면 `slack:<채널ID>:<thread_ts>`. **사람 개입(버튼 클릭·답글 라우팅) 검증까지 하려면 합성형(`slack:<채널ID>:<thread_ts>`) 권장** — 채널형은 카드별 클릭이 자식 합성 id(`slack:<채널ID>:<message_ts>`)로 도착해(배선은 논리-접두 스코프로 수용) 커널 스레드 매핑과 어긋날 수 있다. ⚠ 맨 채널ID나 맨 ts 는 SDK 가 첫 `:` 앞을 어댑터명으로 읽어 `ADAPTER_NOT_FOUND` 로 죽는다(실측). ⚠ id 의 `:` 는 `makeRunId` 에서 `-` 로 바뀌어 run_id 가 `chat-slack-<채널>` 이 된다. |
| `CHAT_LIVE_MENTION` | 멘션 본문(자연어 설정 선언 · 예: `화장품이고 여러장이야, 제품명은 "이지듀 릴리프"`). |
| `CHAT_LIVE_ARTIFACT_DIR` | 트랜스크립트·판정 리포트를 남길 디렉터리(세션화 이름 — 아래 4번 절 ⑤). |
| `CHAT_LIVE_ACTOR` | 감사 actor(선택 · 기본 **`chat:live:svc-driver`**). 끝 세그먼트 `svc-` 접두 = 판정 리포트가 **서비스(드라이버) actor** 로 표기해 드라이버 자동 결정을 사람 승인으로 위장하지 않는다. 표준은 `chat:live:svc-<봇id>` 이고 끝 user id(`svc-<봇id>`)가 `CHAT_APPROVERS` 에 있어야 한다. 실 사람 클릭은 그 사람 Slack user id 그대로 기록된다. |
| `CHAT_LIVE_ATTACH` | 중간-재개 스위치(선택 · **기본 켜짐**). 기동 시 이 스레드에 기존 run 매핑이 있으면 **재멘션 없이** `LiveDriver.attach` 로 이어받는다 — 현재 게이트 카드를 다시 게시(core `readNext` 재파생 카드만 · 지어낸 버튼 0)하고, 심의 차례(na.action=review)면 심의 잡을 재적재한 뒤 자동 주행에 재진입한다. 생성 차례면 GenerateRetry 카드만 게시한다(유료 재생성은 사람 클릭 몫 — 불변). `CHAT_LIVE_ATTACH=0` = 옛 동작(무조건 새 멘션). 매핑 없는 새 스레드는 멘션 폴백. |
| **`CHAT_LIVE_GO=1`** | **안전 ack** — 없으면 계획만 보여주고 **연결·구동 없이 종료**(미리보기). 실 구동은 이 값이 있을 때만. |

라이브/데몬이 읽는 튜닝 다이얼(선택 · 기본값 있음 · 재런 권장):

| env | 뜻 | 기본 / 권장 |
|---|---|---|
| `CHAT_BRIDGE_TIMEOUT` | 봇 브리지가 생성 잡 전이를 기다리는 상한(초) | 기본 **900** · keyvisual 느림(이미지 bake) 대비 **3600 권장**. 데몬 정합상 `CHAT_SDK_GEN_TIMEOUT`+60초 ≤ 이 값이어야 한다. |
| `ADK_CRITIC_RETRY` | ADK 심의 빈응답 재시도 횟수 | 코드 기본 **8** — **기본(8) 이상으로 유지**한다. 기본보다 낮춘 핀(예 3)은 빈응답 소진을 앞당겨 **1차 런 첫 라운드 차단에 기여**했다. 재런에도 8 이상으로 둔다. |
| `ADK_CRITIC_RETRY_BACKOFF` | ADK 재시도 간 대기(초 콤마목록) | 기본 `2,5,10` · 콜드스타트 대비 꼬리 연장 권장(예 `2,5,10,20,30`). |
| `CHAT_REVIEW_RETRY` | 규정 점검이 일시 문제로 끝나지 않았을 때 **자동 재점검 최대 횟수**(챗 계층) | 기본 **2**(총 3회 시도). 소진하면 멈추고 담당자 확인으로 넘긴다(조용한 통과 없음). |
| `CHAT_REVIEW_RETRY_BACKOFF` | 자동 재점검 전 **대기 초**(콤마목록 · 챗 계층) | 기본 `60,300` — ADK 재시도(초 단위)와 달리 **분 단위**로 일시 장애 구간을 넘겨본다. |

> ### 회복예산 선확보 (무인 잡 · 다이얼 아님 · 자동)
> 무인 잡의 **주 세션 kill 스케줄은 잡 마감(`kill_at`)보다 `RECOVERY_RESERVE_MS`(120초 = 복구 최소 90초 + 마감 여유
> 30초) 앞당겨** 잡히므로, 주 세션이 예산을 꽉 써도 전이-전용 복구 세션 몫이 미리 남는다(라이브에서 관측된
> `recovery_budget_insufficient` = 복구 잔여 29.5초 < 90초 를 처방한 상수다). 주 세션조차 이만큼 못 떼는 **소예산 잡**은
> 선확보를 접고 잡 스케줄로 폴백한다(주 세션은 뜨되 복구는 굶을 수 있음 — 기존 동작). 이 선확보와 별개로
> `CHAT_SDK_GEN_TIMEOUT + 기동여유 ≤ CHAT_BRIDGE_TIMEOUT` **정합 체크는 불변**이다(위 `CHAT_BRIDGE_TIMEOUT` 행).

> ### ⚠ 라이브 진입 전 실측 전제 (2026-07-19 첫 라이브 런에서 발견 · 둘 다 만족해야 tee 가 뜬다)
> 1. **봇을 tee 채널에 초대**한다 — 봇(`SLACK_BOT_TOKEN`의 봇 유저)이 `CHAT_LIVE_THREAD` 채널의 **멤버여야** 한다.
>    안 되어 있으면 `subscribe`/첫 카드 `post` 가 `not_in_channel` 로 **파이프라인 진입 전에 크래시**한다(기록·생성 0).
>    조치: 채널에서 `/invite @<봇>` (봇 토큰 스코프에 `channels:join` 이 없으면 자가입장 불가 → 사람이 초대하거나
>    `channels:join` 추가 후 앱 재설치). ⚠ 봇/앱 토큰만으로는 자동 초대 불가 — **사람의 한 단계**다.
> 2. **`CHAT_LIVE_THREAD` 는 `slack:<채널ID>` 복합 id**(위 표 참조) — 맨 채널ID면 `ADAPTER_NOT_FOUND`.
>
> 이 둘은 `pnpm live` 미리보기로는 안 걸린다(미리보기는 연결·subscribe 전에 종료). 실 구동(`CHAT_LIVE_GO=1`)에서만
> 드러나므로, 실행 전에 채널 멤버십과 복합 id 를 반드시 확인하라.

---

## 3. env 준비 예시

```bash
cd chat
export HARNESS_ROOT=/절대경로/ch-regulated-harness/core
unset HARNESS_OFFLINE                      # 온라인(라이브)
export HARNESS_DOMAIN=cosmetic             # 심의 스폰 fail-closed 방지(세 프로세스 공통)

# 인증·외부 서비스
export CLAUDE_CODE_OAUTH_TOKEN=...          # 구독 세션
export NANOBANANA_API_KEY=...              # keyvisual 이미지
export ADK_COSMETICS_CRITIC_URL=https://.../run
export ADK_COSMETICS_CRITIC_ALLOWED_HOST=...run.app
export ADK_CRITIC_RETRY=8                   # 코드 기본(8) 명시 — 기본보다 낮추지 말 것(낮춘 핀이 1차 라운드 차단에 기여)
export ADK_CRITIC_RETRY_BACKOFF=2,5,10,20,30  # 재시도 간 대기(초) 꼬리 연장(선택 · 기본 2,5,10)

# Slack(전용 채널 권장 — 참관·사후검토용)
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...

# 잡큐 공유 + 무인 단계(데몬)
export CHAT_JOBS_DIR=/절대경로/live-run/jobs
export CHAT_SDK_STAGES=intake,brief         # 데몬은 여기까지만 무인(잠긴 결정 4)
export CHAT_BRIDGE_TIMEOUT=3600             # keyvisual 느림 대비(기본 900)

# 인입 재료
export CHAT_BUNDLE_DIR=/절대경로/bundle      # product.json·reviews.csv·images/
export CHAT_STAGED_WB=/절대경로/working-backwards.md

# 승인자 = 드라이버 서비스 actor 의 끝 user id (svc- 접두 = 리포트가 '서비스'로 표기 · 사람 승인으로 위장 안 함)
export CHAT_APPROVERS=svc-driver              # 실 사람 승인자도 쓰면 콤마로 추가 (예: svc-driver,U0ABCDE)
export CHAT_LIVE_ACTOR=chat:live:svc-driver   # 기본값 그대로 · 표준은 chat:live:svc-<봇id>
# (선택) 재기동 attach 는 기본 켜짐 — 옛 '무조건 새 멘션' 이 필요하면 export CHAT_LIVE_ATTACH=0

# 라이브 런 파라미터
export CHAT_LIVE_THREAD=slack:C0XXXXXXXXX    # slack:<채널ID> 복합 id (특정 스레드면 slack:<채널ID>:<thread_ts>) · 봇이 그 채널 멤버여야 함
export CHAT_LIVE_MENTION='화장품이고 여러장이야, 제품명은 "이지듀 릴리프"'
export CHAT_LIVE_ARTIFACT_DIR=/절대경로/live-run/artifacts
```

> ### ⚠ 재런 시 (앞선 런 잔재와의 충돌 회피 · 1 스레드 = 1 run)
> 같은 스레드로 다시 돌리면 "이미 진행 중인 작업이 있어요"로 거부되고 run_id 도 앞선 런과 충돌한다. 재런은 아래 둘을
> 반드시 새로 잡는다.
> 1. **새 `thread_ts` 로 복합 thread id 를** 쓴다 — 채널에 새 메시지를 하나 올리고 그 `thread_ts` 로
>    `CHAT_LIVE_THREAD=slack:<채널ID>:<새 thread_ts>` 를 준다. run_id 가 `chat-slack-<채널>-<ts>` 로 유일해지고,
>    카드는 여전히 같은 채널(스레드) 안에 tee 된다.
> 2. **`CHAT_JOBS_DIR` 를 재런 전용 새 디렉터리로** 판다 — 판정 리포트가 `jobs/failed/*.reason` 을 위반으로 세므로,
>    앞선 런의 실패 잔재가 새 판정을 오염시키지 않게 한다.

> ### ⚠ 재기동(같은 run 이어받기) ≠ 재런(새 run) — 헷갈리지 말 것
> 위 '재런'은 **완전히 새 run** 을 시작할 때다(새 `thread_ts` + 새 `CHAT_JOBS_DIR`). 그러나 **드라이버가 죽었거나
> 세션이 바뀌어 진행 중이던 run 을 이어받고 싶을 때**(재기동)는 정반대 — 운영 규칙 R-3 대로 **같은 스레드·같은 env** 로
> `pnpm live` 를 다시 띄운다. 이 스레드에 이미 run 이 있으므로 진입점이 **재멘션 없이 attach**(현재 게이트 카드 재게시 →
> 자동 주행 재진입)로 이어받는다(`CHAT_LIVE_ATTACH` 기본 켜짐). **재기동에 새 thread_ts·새 run 을 만들지 말 것** —
> 새 멘션은 커널이 "이미 진행 중"으로 거부해 재기동 드라이버가 stuck 죽는 원인이었다.

---

## 4. 단계별 실행 (수동 게이트)

**① 데몬 기동(무인 생성 소비자 · 분리 기동).** intake·brief 생성을 무인 소비한다. 운영 규칙 R-2 대로
**운영자 세션의 자식으로 띄우지 않는다** — orphan 패턴으로 분리 기동해 세션이 바뀌어도 살아남게 한다(상세·종료 절차 =
아래 8번 절).

```bash
cd chat
mkdir -p /절대경로/live-run/logs
( nohup bash -c 'exec pnpm worker' </dev/null >/절대경로/live-run/logs/live-daemon.log 2>&1 & echo $! >/절대경로/live-run/logs/live-daemon.pid )
```

`live-daemon.log` 에 `무인 단계: intake, brief` 가 뜨면 준비 완료. (env 는 3단계에서 export 한 것을 그대로 상속 —
`CHAT_SDK_STAGES` 도 이미 export 돼 있으므로 명령줄에 다시 붙이지 않는다.)

**② 운영자 세션 준비(브리프 너머 생성 · 사람).** concept·storyboard·keyvisual 은 데몬이 안 집는다 — 봇이 Bridge 로
적재한 생성 잡을 **운영자의 Claude Code 세션**이 세션 내에서 소비한다(C2). core 의 세션 내 1급 경로(슬래시 `/<stage>`
스킬 → `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> <rid>` 전이)를 그때그때 실행한다.
데몬을 이 단계까지 켜지 않는 이유 = keyvisual 무인이 구조적으로 막혀 있어서다(과대 자동화 금지).

**③ 미리보기(연결·과금 0).** 먼저 `CHAT_LIVE_GO` **없이** 돌려 계획·비용을 확인한다.

```bash
pnpm live      # CHAT_LIVE_GO 미설정 → 계획만 출력하고 종료(연결 안 함)
```

**④ 실 구동(과금 시작 · 분리 기동).** 확인했으면 ack 를 켜고 **분리 기동**한다(R-2 · 운영자 세션 자식 금지).

```bash
( nohup bash -c 'CHAT_LIVE_GO=1 exec pnpm live' </dev/null >/절대경로/live-run/logs/live-driver.log 2>&1 & echo $! >/절대경로/live-run/logs/live-driver.pid )
```

- 라이브 진입점이 실 Slack 에 연결하고, `CHAT_LIVE_THREAD` 스레드로 카드를 **tee** 하며, 멘션→done 까지 auto-happy 로
  드라이브한다(모든 결정은 직전 렌더의 affordance 에서 도출).
- **재기동(attach)**: 드라이버가 죽었거나 세션이 바뀌면 **같은 env 로 이 줄을 그대로 다시** 실행한다(R-3). 이 스레드에
  이미 run 이 있으므로 진입점이 **재멘션 없이 attach** — 현재 게이트 카드를 다시 게시하고(core `readNext` 재파생 · 지어낸
  버튼 0) 자동 주행에 재진입한다. 새 멘션·새 run 을 만들지 않는다.
- concept·storyboard·keyvisual 생성 차례가 오면 봇이 잡을 적재하고 대기한다 — 이때 **②의 운영자 세션에서 해당 단계를
  세션 내로 생성**하면 봇이 전이를 감지해 이어간다.
- 구동이 끝나면 트랜스크립트·판정 리포트가 `CHAT_LIVE_ARTIFACT_DIR` 에 떨어진다(세션화 이름 + done 시 terminal 리포트 =
  바로 아래 ⑤). 실 Slack 연결은 상주하니, 참관을 마치면 **pid 종료 절차(8번 절)** 로 내린다(분리 기동이라 Ctrl+C 대상이 없다).

**⑤ 관측.**
- **실 Slack tee 채널**: 카드가 실제로 렌더되는지(버튼·이미지 첨부·한글) 사람이 눈으로 본다 — CI 가 못 보는 것.
- **트랜스크립트 JSONL**(`<rid>-transcript.<세션epoch>.jsonl`): 발화→렌더 화면→next-action 스냅샷 시간순. AI 심판/사람
  판독 입력. 드라이버 세션마다 새 파일이라 **재기동(attach)해도 이전 세션이 덮이지 않는다**.
- **세션 판정 리포트**(`<rid>-report.<세션epoch>.md` · `.json`): 그 세션이 관측한 것만 본 구조 판정.
- **terminal 판정 리포트**(`<rid>-report.final.md` · `.json`): **done 도달 시에만** 기록 — 이 RID 의 **전 세션
  트랜스크립트를 합산**한 run-수준 최종 판정이다(이전 세션이 남긴 Failure 도 반영하므로, stale 세션 리포트가 실제 done 을
  거짓 통과로 가리지 않는다). 최종 판정은 이 파일로 읽는다.

---

## 5. 어떻게 판정하나 (구조적 · 잠긴 결정 2)

판정 리포트(`report-assembler`)가 **구조**만 본다 — LLM 카피 내용은 채점하지 않는다. 통과(PASS) = 아래 전부 ok:

| 기준 | 통과 조건 |
|---|---|
| done 도달 | `state.json` phase = `done`. |
| 산출물·스키마 | `state.json` 이 필수 키를 갖춘 well-formed JSON + artifacts 기록됨. |
| 게이트 순서 | history 페이즈가 파이프라인 정순으로 비감소(뒤로 점프 0). |
| 감사 actor | history 에 감사 actor 가 `--by` 로 기록됨(승인/선택). 통과 조건은 합계>0 로 불변이되, 표기는 끝 세그먼트 `svc-` 접두면 **서비스(드라이버) actor**·아니면 **사람 actor** 로 갈라 보여준다 — 드라이버 자동 주행(서비스 identity)만 있어도 통과하고, 사람 실 클릭이 섞이면 사람 actor 로 따로 표기된다. |
| 이미지 매니페스트 완결 | `04-keyvisual/image-manifest.json` 존재 + `incomplete` 부재 + engine≠stub. |
| Failure 화면 0 | 트랜스크립트에 Failure 화면 없음. |
| 잡 수명주기 위반 0 | `jobs/failed/*.reason` 없음. |

> **⚠ 심의 revise/escalation 은 실패가 아니다.** 리포트는 verdict 의 `critic_ran`·`critic_outcome`·`review_depth` 를
> **증거로 보여줄 뿐** 채점하지 않는다. 적대적 심의가 revise 를 낸 것은 심의가 **일했다**는 신호다(루프 상한 내). AI
> 드라이버는 revise 도장을 정직히 따라 재생성·재승인을 이어간다.

리포트 조립은 사후에도 가능하다(진입점이 done 시 자동으로 `-report.final.*` 를 쓰지만, 필요하면 재조립). terminal(run-수준)
재조립은 `listRunTranscripts` 로 이 RID 의 **모든 세션 트랜스크립트**(`<rid>-transcript.<epoch>.jsonl`)를 모아 넘긴다 —
단일 세션 파일 하나만 넘기면 다른 세션의 Failure 를 놓친다:

```ts
import {
  assembleJudgmentReport,
  renderReportMarkdown,
  listRunTranscripts,
  defaultReader,
} from "./src/live/report-assembler.js";
const artifactDir = process.env.CHAT_LIVE_ARTIFACT_DIR!;
const report = assembleJudgmentReport({
  runDir: `${process.env.HARNESS_ROOT}/runs/<rid>`,
  transcriptPaths: listRunTranscripts(defaultReader, artifactDir, "<rid>"), // 전 세션 합산
  jobsFailedDir: `${process.env.CHAT_JOBS_DIR}/failed`,
});
console.log(renderReportMarkdown(report));
```

**stuck 감시**: 같은 next-action 에 오래 머물면(`LiveDriver.stuckVerdict()` · 기본 15분) 운영자 세션이 그 단계 생성을
안 집었거나 심의가 늘어진 것이다 — 운영자 세션 로그·데몬 로그를 확인한다.

> **메모(재런 시 stuck 임계 상향 여지)**: 자동 재점검 대기(`CHAT_REVIEW_RETRY_BACKOFF` 최대 300초)에 재점검 자체
> 시간까지 이어지면 같은 화면에 머무는 창이 길어져 15분 기본 임계에 걸릴 수 있다. keyvisual 이미지 구간이나 재점검을
> 넉넉히 두고 싶은 재런에서는 드라이버 `stuckThresholdMs` 를 15분보다 올릴 여지가 있다(정직한 종료는 그대로 유지).

---

## 6. 예산·시간 (수동 게이트 1회)

- 비용(구독 환산): intake ~$4 + brief ~$1 + concept/outline/plan 각 ~$1–3 + keyvisual HTML ~$3–8 ≈ **$12–20**
  + 이미지(Gemini)·심의(GCP).
- 벽시계: 순정 45분–1.5시간, revise 1–2회 포함 시 **1–2.5시간**.
- → **CI 불가 · 수동 게이트**. 1회 실행 = 판정 가능한 트랜스크립트 1개.

---

## 7. 안전 주의

- **실 과금**이 발생한다(위 6단계). `CHAT_LIVE_GO=1` 없이 돌리면 계획만 보고 종료하니, 먼저 미리보기로 확인하라.
- **stub 누수 금지**: `HARNESS_OFFLINE` 이 켜져 있으면 라이브가 거부한다(stub 은 CI/골든 전용).
- **revise/escalation = 정상**: 심의가 보완/에스컬레이션으로 끝난 것은 결함이 아니라 설계된 적대적 게이트의 작동이다.
- **재점검 반복 실패 트리아지**: 자동 재점검(`CHAT_REVIEW_RETRY`)이 계속 실패하면, 재런을 새로 걸기 전에
  `runs/<rid>/.logs/critic-passA-*.log` 의 **로그 꼬리**부터 본다 — 설정오류(엔드포인트·인증·도메인 미배선 등 비일시)
  인지 일시 장애(빈응답·타임아웃)인지 먼저 가려라. 설정오류면 재시도를 아무리 늘려도 헛돌 뿐이다(먼저 설정을 고친다).
- **관측 노이즈(무해 · 조치 불필요)**: ① 데몬 로그의 **미등재-단계 스킵**은 같은 잡당 1회만 찍힌다(dedup — 매 폴
  도배는 없어졌고 스킵 동작 자체는 불변). ② Slack **socket `pong` 경고**는 WebSocket 하트비트 재연결의 정상 신호다.
- **법적 보증 아님**: 본 산출물·판정은 법적 통과 보증이 아니라 자율·비법적 사전 점검이다(AGENTS 7번 절). 최종 책임은
  사람(현업/RA)에게 있다.
- 이 런북의 진입점·조립 코드는 `chat/src/live/`(플랫폼-aware)에 있고, 재사용 조립·정책·판정은 오프라인 단위 테스트로
  검증돼 있다(`chat/test/live/`). 실 서비스 호출은 이 수동 게이트에서만 일어난다.

---

## 8. 운영 규칙 (R-1~R-3) · 분리 기동 표준

라이브 런은 실 과금·실 Slack 이 걸린 1회 수동 실행이라, 운영자(사람·에이전트)가 지키는 규칙이 산출물만큼 중요하다.
아래 세 규칙은 즉시 유효하며, 특히 R-2(분리 기동)는 4번 절의 데몬·드라이버 기동을 지배한다.

- **R-1 — core 우회 금지(결정·진행은 챗 표면으로만).** 라이브 런이 도는 동안 운영자는 core 4동작 스크립트로
  **결정·진행을 직접 하지 않는다**(승인·선택·전이·보완 = approve/select/advance/revise). 그런 결정은 드라이버 또는
  사람의 Slack 버튼으로만 흐른다. **예외**: ②의 운영자 세션이 봇이 Bridge 로 적재한 **생성 잡을 세션 내에서 소비**하는 것은
  우회가 아니라 설계된 경로다(잠긴 결정 4 · C2). 그 밖의 core 4동작 사용은 아웃오브밴드이며, **사람의 명시 지시**가
  있을 때만 하고 우회했다면 그 사실을 **즉시 보고**한다. (아웃오브밴드 전진은 `.events/agui.jsonl` 에만 남고 Slack 으로
  투영되지 않아 **침묵**을 만든다 — 재발 방지.)
- **R-2 — 항상 분리 기동(운영자 세션 자식 금지).** 데몬·드라이버는 운영자 세션의 자식 프로세스로 띄우지 않는다.
  세션 자식으로 띄우면 **세션 종료 시 SIGTERM(exit 143)** 이 전파돼 봇째 죽는다(실측). 아래 orphan 패턴으로 분리 기동하면
  세션이 바뀌어도 살아남는다(실측: 이 패턴의 2차 드라이버·데몬이 세션 전환을 3h+ 생존).
- **R-3 — 재기동은 attach 경로.** 진행 중이던 run 을 이어받을 때는 **같은 스레드·같은 env** 로 진입점을 다시 띄운다
  (`CHAT_LIVE_ATTACH` 기본 켜짐 → 재멘션 없이 현재 게이트 카드 재게시 + 자동 주행 재진입). **재멘션으로 새 run 을
  만들거나 기존 run 을 두드리지 않는다**(커널이 "이미 진행 중"으로 거부 → 재기동 드라이버 stuck 사망).

### 분리 기동 표준(orphan 패턴 · macOS — setsid 없음)

macOS 에는 `setsid` 가 없으므로 **서브셸 + `nohup` + `</dev/null` + 백그라운드** 조합으로 세션에서 떼어낸다. 로그와
**pid 파일**을 함께 남겨 확인·종료를 결정론으로 한다.

```bash
# 공통 — 로그·pid 디렉터리
export LIVE_LOG=/절대경로/live-run/logs
mkdir -p "$LIVE_LOG"

# ① 데몬(무인 생성 소비자) 분리 기동
( nohup bash -c 'exec pnpm worker' </dev/null >"$LIVE_LOG/live-daemon.log" 2>&1 & echo $! >"$LIVE_LOG/live-daemon.pid" )

# ④ 드라이버(라이브 진입점) 분리 기동 — 과금 시작
( nohup bash -c 'CHAT_LIVE_GO=1 exec pnpm live' </dev/null >"$LIVE_LOG/live-driver.log" 2>&1 & echo $! >"$LIVE_LOG/live-driver.pid" )
```

**확인(살아있나 · 로그가 도나):**

```bash
ps -p "$(cat "$LIVE_LOG/live-daemon.pid")" "$(cat "$LIVE_LOG/live-driver.pid")"   # 둘 다 RUNNING 이어야 함
tail -f "$LIVE_LOG/live-driver.log"                                              # tee·전이 관측(Ctrl+C 로 tail 만 종료)
```

**종료(우아 → 백스톱):** 드라이버·데몬 순으로 SIGTERM 을 보낸다(데몬은 우아한 종료에서 살아있는 세션까지 정리한다).
pid 프로세스가 죽어도 자식(node)이 남으면 이름 매칭 백스톱으로 회수한다.

```bash
kill "$(cat "$LIVE_LOG/live-driver.pid")"  2>/dev/null   # 드라이버 먼저
kill "$(cat "$LIVE_LOG/live-daemon.pid")"  2>/dev/null   # 데몬(살아있는 잡 세션 정리 후 종료)
# 백스톱(자식이 남았을 때만) — 이름으로 정확히 이 프로세스만
pkill -f 'tsx src/live/main.ts'    2>/dev/null
pkill -f 'tsx src/worker/main.ts'  2>/dev/null
```

> **왜 pid 파일인가**: 분리 기동은 제어 터미널이 없어 Ctrl+C 대상이 없다. 기동 즉시 pid 를 파일로 박아 두면, 세션이
> 바뀌거나 다른 창에서도 **정확히 그 프로세스만** 확인·종료할 수 있다(무관한 프로세스 오살 방지). 재기동(R-3)은 같은
> pid 파일을 덮어쓰며 갱신된다.
