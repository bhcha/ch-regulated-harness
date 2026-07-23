# 규제 상세페이지 도우미 — 챗 게이트웨이(Slack 어댑터)

규제 대상 제품(화장품·의약외품·건기식·의약품)의 홍보/상세 자료를 만드는 **하네스(`ch-regulated-harness`
core)를 Slack 으로 구동**하는 어댑터다. 헥사고날(ports & adapters) 관점에서 core = 애플리케이션 코어,
이 챗 레이어 = 그 포트를 사용자 쪽에서 구동하는 **driving adapter**.

- **core 무수정**: 게이트웨이는 `state.json` 을 직접 쓰지 않는다 — `bash <HARNESS_ROOT>/scripts/*.sh` 를
  **spawn** 해 생성/승인/보완/선택/인입/심의/한도상향을 환원한다. 상태 쓰기는 항상 하네스 스크립트만.
- **포트 = 동결 계약 4면**: next-action JSON(읽기) · 4동작 CLI(쓰기) · 산출물 파일 · 평이 라벨.
- 심의(원격 ADK)는 반대편 driven adapter 다 — 이 어댑터와 대칭.

## 요구사항

- Node `^20.19.0 || >=22.12.0`, `pnpm`.
- **하네스 체크아웃**: `ch-regulated-harness` 의 `core/`. 그 절대/상대 경로를 `HARNESS_ROOT` 로 **주입**한다.
  어댑터는 포트 주소를 추측하지 않는다 — 미설정이면 기동·통합검증이 즉시 중단된다(fail-fast).

## 설치

```bash
pnpm install
```

## 설정

`.env.example` 를 복사해 값을 채운다(또는 프로세스 env 로 주입). `config.ts` 가 유일 SSoT.

| env | 필수 | 뜻 |
|---|---|---|
| `HARNESS_ROOT` | ✔ | 하네스 core 체크아웃 경로(주입). 미설정 = fail-fast. |
| `SLACK_BOT_TOKEN`·`SLACK_APP_TOKEN` | ✔(기동) | Socket Mode 봇 토큰. |
| `SLACK_SIGNING_SECRET` | | 선택. |
| `CHAT_APPROVERS` | | 콤마분리 승인자 id. 비우면 아무도 승인 불가(fail-closed). |
| `CHAT_BUNDLE_DIR`·`CHAT_STAGED_WB` | | 운영자 사전 스테이징(크롤 번들·워킹백워드). |
| `CHAT_STATE_DIR`·`CHAT_DATA_DIR`·`CHAT_JOBS_DIR` | | 저장 루트 오버라이드(기본 = 패키지 하위). |
| `CHAT_BRIDGE_TIMEOUT` | | 봇의 생성 대기 상한(**초**, 기본 900). 잡 `expires_at`(절대 마감)의 원천 — [`jobs/README.md`](jobs/README.md). |
| `CHAT_REVIEW_RETRY` | | 규정 점검이 일시 문제로 끝나지 않았을 때 **자동 재점검 최대 횟수**(기본 **2** = 총 3회 시도). 소진하면 멈추고 담당자 확인으로 넘긴다(조용한 통과 없음). |
| `CHAT_REVIEW_RETRY_BACKOFF` | | 자동 재점검 전 **대기 초**(콤마목록, 기본 `60,300`). ADK 재시도(초 단위)와 달리 **분 단위**로 일시 장애 구간을 넘겨본다. |
| `CHAT_SDK_GEN_TIMEOUT` | | 무인 잡 1건의 wall-clock 예산(**초**, 기본 480 — 주+복구 세션 합산). `+기동 여유 ≤ CHAT_BRIDGE_TIMEOUT` 이어야 한다. |
| `CHAT_SDK_MAX_TURNS` | | 무인 세션 1건의 턴 상한(**1 이상의 정수**, 기본 50). 폭주 세션의 하드 천장. |
| `CHAT_SDK_STAGES` | | 무인화를 켤 단계 목록(콤마분리, 예 `intake,brief`). 비우면 **어느 단계도 무인 아님**(기본 off = fail-closed). |
| `CHAT_SDK_POLL_INTERVAL` | | 데몬 폴링 간격(**초**, 기본 5). 대기줄이 비면 이만큼 자고 다시 훑는다. |
| `CHAT_SDK_DAILY_JOB_CAP` | | 무인 소비 잡 수 상한(정수, 기본 20). trailing 24h 창의 성긴 과금 백스톱(비용 상한 아님). |
| `CHAT_SDK_CONSUMER_ID` | | 데몬 소비자 id(기본 `daemon` · `claimed/<id>/`). 재기동 간 같아야 자기 지난 클레임을 정리한다. |
| `CLAUDE_CODE_OAUTH_TOKEN` | | 무인 세션 구독 인증(온라인). 없으면 세션이 인증 실패로 죽는다(잡을 집을 때만 필요). |
| `HARNESS_OFFLINE=1` | | 결정적 stub(CI/테스트). 운영 미설정. |

> **시간·횟수 env 는 "비우면 기본, 적었는데 못 읽으면 중단"이다.** 위 `CHAT_*_TIMEOUT`(초 단위 양수)과
> `CHAT_SDK_MAX_TURNS`(1 이상 정수)는 미설정/빈값이면 기본값을 쓰지만, **명시했는데 형식이 틀리면**
> (`30m`·`5O`·`0`·공백뿐) 조용히 기본값으로 돌아가지 않고 **기동 시 중단**한다 — 오타 하나가 운영자가 정한 적 없는
> 예산(시간·턴)을 말없이 승인해주면 안 되기 때문. 초 단위 숫자만 적는다(`900`, `480`). 30일을 넘는 값도 중단한다
> (마감은 잡 파일에 시각 문자열로 실리므로, 표현 못 할 상한은 상한이 아니다 — 밀리초를 초 자리에 쓴 실수도 여기서 걸린다).
>
> **`CHAT_SDK_STAGES` 값은 잡의 단계 이름**(`run-stage.sh` 인자 = `intake`·`brief`)이지, `state.json` 의
> 페이즈 이름(`00a-intake`·`01-brief`)이 아니다. 페이즈 이름을 적으면 문법 검사는 통과하지만 잡과 이름이 달라
> **켠 줄 알았는데 그 단계가 영영 무인으로 안 돈다**(잡이 조용히 대기만 한다). 현재 무인 지원 단계 = `intake`·`brief`.

## 테스트 3계층(standalone / integration / acceptance)

하네스 없이도 도는 **standalone**, 하네스를 실제 구동하는 **integration**, 실 게이트웨이로 표면 흐름을
끝까지 모는 **acceptance(인수 시나리오)** 를 나눈다.

```bash
pnpm test              # standalone — 단위 전부(하네스 불필요). test/e2e·*.accept.test.ts 제외.
pnpm test:integration  # integration — stub E2E. HARNESS_ROOT 필요; 미주입이면 '보이게' 생략.
pnpm test:accept       # acceptance — 인수 시나리오(표면 흐름). HARNESS_ROOT 필요; 미주입이면 '보이게' 생략.
pnpm verify            # 게이트: build + standalone. HARNESS_ROOT 주입 시 integration·acceptance 까지.
```

- `HARNESS_ROOT` 미주입이면 통합·인수 계층은 **명시적으로 생략**된다(조용한 통과 금지 — 시나리오별 경고 1줄 · skipIf).
- `pnpm verify` 체인: ① build(tsc --noEmit) → ② 단위 → **[HARNESS_ROOT 주입 시]** ③ 계약 픽스처 재캡처 멱등
  (next-action 드리프트 감지) → ④ stub E2E → ⑤ **인수 시나리오**(`pnpm test:accept`) → ⑥ **core 무수정 증명**.
  - **⑤ 를 ⑥ 앞에 두는 이유**: 인수 시나리오도 core 를 offline 으로 spawn 하므로, core 무수정 증명(`git -C
    "$HARNESS_ROOT" status`)은 그 **뒤**라야 인수가 낸 오염까지 잡는다. 부리기 전에 검사하면 놓친다(false-pass).
    ③·④ 를 ⑥ 앞에 두는 것과 같은 순서 원칙이다.

### 인수 하네스(kernel-neutral · `src/acceptance/`)

어댑터 무지(kernel-neutral)한 인수 부품 — core stub 을 실 게이트웨이로 구동해 **표면 흐름**을 판정한다.

- **RecordChatPort** — 렌더된 화면을 시점 스냅샷으로 기록하는 ChatPort(structuredClone 격리).
- **affordances 추출기**(`affordances.ts`) + **결박 테스트**(`affordance-convention.test.ts`) — 추출기 출력이
  실렌더 버튼 집합(`toCards()`)과 일치함을 전 Presentation 변이에서 증명(union never-exhaustive 로 봉인).
- **SurfaceDriver**(`driver.ts`) — 게이트웨이를 감싸 mention/reply/fire/quiesce 로 몰고, 다안·게이트에서
  **auto-happy** affordance 를 골라 발화(oracle 순환 없이 core next-action 만 웨이포인트로 읽음).
- **analyzer**(`analyzer.ts`) — 5종 문제 클래스(failure·dead-end·stuck·job-residue·unknown) 판정.
- **transcript**(`transcript.ts`) — 발화·화면·na 스냅샷을 시간순으로 쌓아 **결정론 JSONL** 로 직렬화.

시나리오(`test/acceptance/*.accept.test.ts`):

| 시나리오 | 무엇을 덮나 | 유형 |
|---|---|---|
| mention→brief | 멘션 → 인입 → 자동 브리프 생성 → 승인 → 심의 → 02-concept | 드라이버 |
| mention→done | 멘션 → 자동 이어가기로 전 파이프라인 완주(done) | 드라이버 |
| bridge-daemon-handoff | Bridge 적재 ↔ 데몬 클레임·소비 핸드오프(이음새) | 이음새 |
| non-happy-revise | 브리프 [보완] → 답글 → 재생성 루프(실패 아님) | 드라이버 |
| non-happy-escalation | 보완 상한 소진 → Escalation → [한 번 더] 복구 | 드라이버 |
| non-happy-stale-select | 도장 어긋난 [이걸로] 거부, 최신 안은 정상 전진 | 드라이버 |
| non-happy-generate-retry | 브리지 회수 → [상태 다시 확인] → GenerateRetry → 재요청(이음새) | 이음새 |

- **시간 예산**: `pnpm test:accept` 는 총 **약 41초**. mention→done 이 **약 40초**(keyvisual 옵션 HTML 을
  offline stub 에서도 Playwright 로 렌더 — 무거운 경로), 나머지는 각 수 초. keyvisual 완주는 이 1건으로 몰고
  나머지는 빠른 비-keyvisual 구조 커버로 분업한다.
- **integration-전용**: HARNESS_ROOT + offline core 가 필요하다. HARNESS_ROOT 미주입이면 각 시나리오가
  경고 1줄과 함께 **보이게 생략**된다.

### 트랜스크립트 아티팩트

드라이버 시나리오는 트랜스크립트를 결정론 JSONL 로 떨군다 — `verify.sh` 가 `CHAT_ACCEPT_ARTIFACT_DIR`
(= `.acceptance-artifacts/`, **gitignore**)를 set 했을 때만(opt-in · env 없으면 no-op → 부수 파일 0). 이 JSONL 의
**두 역할**: ① CI 구조 assert 재료 ② 사람/AI 판독물(라이브 공유). **CI 는 구조만 assert** 한다 — CI 안에 LLM
심판을 넣지 않는다(비결정). 사람/라이브가 최종 확인이고 CI 는 1차 게이트다(계획 4번 절).

## 기동(Slack Socket Mode)

```bash
HARNESS_ROOT=/path/to/core \
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
CHAT_APPROVERS=slack:U0000000 \
pnpm exec tsx src/index.ts
```

`pnpm build`(`tsc --noEmit`)는 **타입체크 전용**이라 `dist/` 를 만들지 않는다 — 실행은 위처럼 `tsx` 로 한다.
Socket Mode 라 인바운드 포트 오픈이 필요 없다(상주 프로세스가 WebSocket 으로 연결).

## 운영자 규약(생성 잡 큐)

온라인에서 실엔진 생성은 챗 레이어가 스스로 띄우지 않는다(헤드리스 실엔진 = core fail-closed).
생성 요청은 `jobs/pending/` 에 파일로 적재되고, **소비자**(오늘 = 운영자의 Claude Code 세션)가 그 잡을 집어
세션 내(insession) 생성으로 런을 전이시킨다.

잡 큐는 **프로토콜 v2**를 따른다 — 잡마다 절대 마감(`expires_at`), 클레임은 rename, 일하기 전 2중 검사
(남은 시간 · 아직 그 단계 차례인지), 수명주기는 `pending/ → claimed/<소비자>/ → 성공 삭제 · 실패 failed/`.
**사람 소비자도 데몬과 같은 규약을 따른다** — 명령 단위 절차·마감 규약·[상태 다시 확인] 화해까지 상세 =
[`jobs/README.md`](jobs/README.md), 코드 SSoT = `src/kernel/job-protocol.ts`.

## 무인 소비자 데몬(W4)

봇/사람 대신 **데몬**이 생성 잡을 소비하는 별도 상주 프로세스다(무인화 범위 = '생성'뿐 · 승인·선택·심의는 불변).
사람 관점 무인, core 관점 insession — core 게이트는 전부 그대로다.

```bash
HARNESS_ROOT=/path/to/core \
CHAT_SDK_STAGES=intake,brief \
CLAUDE_CODE_OAUTH_TOKEN=... \
pnpm worker                    # = tsx src/worker/main.ts
```

무엇을 하나(한 회차): `jobs/pending/` 폴링 → **enablement 필터**(`CHAT_SDK_STAGES` 미등재 단계는 안 집음 · 기본
off) → 잡 수 상한(`CHAT_SDK_DAILY_JOB_CAP`) → **클레임 후 2중 검사**(남은 시간·아직 그 단계 차례) → 잡 세션 →
성공 삭제 / 실패 `failed/`(+`.reason`). **동시성 1**(한 번에 잡 1건). 잡당 1줄 관측 로그(rid·stage·대기·소요·결과).

- **잡 세션**: 온라인 = 잡마다 `supervisor.ts` 를 detached 로 띄워(자기 그룹 리더) 세션이 산출물 작성 → insession
  전이까지 스스로 완주(잠긴 결정 4) · 오프라인(`HARNESS_OFFLINE=1`) = `run-stage.sh` 직접(결정적 stub · CI/E2E).
- **기동 리퍼 2종**: ① **큐 리퍼** — 지난 생의 stale 클레임을 **마감(리스)만 보고** 정리(생사추정 없음 · 재큐 없음).
  ② **프로세스 소유권 리퍼** — supervisor 급사로 고아가 된 세션 그룹을 **nonce 소유권 원장**(`jobs/ledgers/`)으로
  회수한다. raw-PID/하트비트가 아니라 **exec-env nonce 를 신호 직전 검증한 뒤에만** `kill(-pgid)` 하고(PID 재사용
  그룹엔 절대 신호 안 함), 미지 원장 버전은 거부한다.
- **우아한 종료**: `SIGTERM`/`SIGINT` → 루프 정지 → 살아있는 supervisor 에 **`SIGTERM` 먼저**(종료 전파가 세션
  그룹 SIGKILL) → 소유권 리퍼 백스톱 → 종료.

⚠ **라이브 활성화 전제**(계획 W5): `CHAT_SDK_STAGES` 에 실측으로 무인 완주를 확인한 단계만 올리고, 과금 귀속을
사람이 콘솔에서 확인한 뒤에 켠다. 온라인 supervisor spawn·실 프로세스 회수는 **라이브 전용**이라 단위/E2E 는
fake/stub 로만 검증한다(오프라인 결정성 유지). 규약·경계 상세 = [`../docs/plans/chat-unmanned-consumer-plan.md`](../docs/plans/chat-unmanned-consumer-plan.md).

## 계약 드리프트

이 어댑터는 하네스의 **next-action 계약**에 의존한다. 모노레포에서는 chat 과 core 가 같은 커밋으로
공진화하므로 별도 커밋 핀 없이, 통합 검증(`pnpm verify` 의 계약 픽스처 재캡처 멱등)이 형제 core 에 대해
드리프트를 감지한다 — 재캡처된 next-action JSON 이 어긋나면 하네스 계약이 바뀐 것이므로 픽스처를
같은 커밋에서 재캡처한다. (하네스 쪽 의무: next-action JSON 은 additive-only.)
저장소 분리를 되살릴 경우의 커밋-핀(`HARNESS_REF`) 메커니즘은 `docs/_archive/chat-gateway-split-plan.md` 참조.

## 고지

본 산출물은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**이다. 최종 책임은 사람(현업/RA)에게 있다.
