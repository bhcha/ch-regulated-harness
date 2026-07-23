# W2 Codex 리뷰 브리프 — 챗 잡 큐 프로토콜 v2

> 대상 커밋: `df89d59`(main 병합 = `a8188c0`) · 베이스: `71d33d5` · diff: `w2.diff`(2,912줄)
> 레포: `/Users/chabh/workspace/ch-regulated-harness` · 리뷰 브랜치: `fix/chat-w2-codex`
> 규칙 SSoT: `core/AGENTS.md` · 설계: `docs/plans/chat-unmanned-consumer-plan.md`(W2 행) + `chat-dual-surface-plan.md`(잠긴 결정 2·4)

## 0. 무엇을 리뷰하는가

봇(`BridgeGenExecutor`)이 `chat/jobs/pending/` 에 적재한 **생성 잡**을 소비자(오늘=사람 운영자, 후속=무인 데몬)가
집어 세션 내(insession) 생성으로 런을 전이시킨다. W2 는 그 **큐 규약을 v2 로 올린 것**이다 — 코드 SSoT =
`chat/src/kernel/job-protocol.ts`(571줄, 신규).

**범위(2026-07-17 사람 결정 — '2번')**: 순수 Q1 파일(`nl/cli-parser.ts`·`nl/contract.ts`·`spawn-hygiene.ts` 와 그
테스트 ≈ 900줄)은 **이미 Codex 클린**이라 diff 에서 제외했다. **그 외는 전부 리뷰 대상이다.**

⚠ `flow.ts`·`config.ts`·`config.test.ts`·`README.md` 는 Q1·W2 가 **한 파일에 섞여 있는데, 경계를 긋지 말고
파일 전체를 보라.** 이유: Q1 의 '클린' 판정은 **Q1 시점의 코드 기준**이고, 그 뒤 W2 가 같은 파일을 고쳤으므로
Q1 부분도 그 사이 바뀌었을 수 있다. 섞인 파일에서 "이건 Q1 이니 넘어간다"고 판단하지 말 것.
(참고용 대략 분할 — 제외 근거가 아니라 방향 감각용: `config.ts` W2 = `bridgeTimeout()`, Q1 = `nlParser()`·
`nlCliTimeout()`·`nlCliVerified()` · `flow.ts` W2 = 잡 적재·마감·회수·화해 경로, Q1 = NL 파서 배선)

## 1. 이 설계가 지켜야 하는 불변식 (여기서 어긋나면 결함)

1. **마감은 절대시각·단일 원천** — `expires_at` = 적재시각 + `CHAT_BRIDGE_TIMEOUT`. duration 이 아니라 절대시각이라야
   늦게 집은 소비자도 같은 마감을 본다. **봇 폴링 마감도 같은 `expires_at` 에서 계산**(이중 시계 금지).
2. **클레임 = rename 원자성** — `pending/ → claimed/<consumer>/`. 이중 소비(사람·데몬 동시)를 rename 이 막는다.
3. **클레임 전 2중 검사** — ① `지금 + 잡 예산 + 기동 여유 ≤ expires_at` ② `next-action == 그 단계 생성 차례`.
   둘 중 하나라도 실패면 집지 않는다(만료 → `failed/` · 이미 전이됨 → 삭제).
4. **v1 레거시 잡(`expires_at` 부재) = `no_deadline` → 자동 소비 대상 아님**(사람 소비자 몫). 마감을 못 걸면
   구조적 보증이 성립하지 않으므로 **만료와 구분**해야 한다(조용히 만료 처리하면 결함).
5. **수명주기** — `pending/ → claimed/<소비자>/ → 성공 삭제 · 실패 `failed/` + `.reason`. **부분 성공 없음**.
6. **봇 타임아웃 = 실패 카드 + `pending/` 회수**(2차 방어 — 1차는 마감 자체).
7. **화해 2경로** — [상태 다시 확인] = **읽기전용**(늦은 전이가 나도 스레드가 고아가 안 되게) · [다시 만들기] =
   회수된 요청의 출구. **next-action 재조회 후 여전히 그 단계 생성 차례일 때만** 새 `expires_at` 으로 **새로** 적재.
   **클레임된 잡을 되살리면 안 된다**(이중 소비 표면 증가).
8. **reaper** — `claimed/` 고아(하트비트 만료) → 재큐 **전에 동일 2중 검사**. 만료·전이완료면 재큐 금지(stale 재실행 차단).
9. **core 무수정** — 게이트웨이는 `state.json` 을 직접 쓰지 않는다. 상태 쓰기는 `bash <HARNESS_ROOT>/scripts/*.sh` spawn 만.
10. **kernel-neutral** — 커널(`src/kernel/**`)에 플랫폼 단어(Slack 등) 0. 표현은 `presentation.ts` 의 중립 모델로.
11. **결정은 사람** — 무인화 범위는 '생성'뿐. 승인·선택·RA 게이트는 버튼 그대로(AGENTS 1번 절 규제 통제).
12. **fail-closed 기본** — 실패가 조용히 통과로 둔갑하지 않는다.

## 2. 특히 의심해서 볼 곳 (적대적으로)

- **TOCTOU**: 2중 검사와 rename 사이의 창 — 검사 통과 후 rename 전에 마감이 지나거나 다른 소비자가 집으면?
- **경합**: 두 소비자가 같은 잡을 동시에 rename 할 때 패자가 어떻게 되는가(조용한 실패? 중복 처리?).
- **reaper vs 살아있는 소비자**: 하트비트 판정이 느린 잡을 고아로 오인해 재큐하면 이중 실행이 된다.
- **시계**: `Date.now()` 혼용·monotonic 아님·타임존·문자열 파싱 실패 시 폴백이 안전한 쪽인가(마감 미상 = 집지 않음이 안전).
- **`expires_at` 파싱**: 깨진 값/미래값/음수 — 만료로 볼지 no_deadline 으로 볼지(안전한 쪽 = 집지 않음).
- **[다시 만들기]가 클레임된 잡을 되살리는 경로가 있는가**(불변식 7 위반).
- **회수(reclaim)와 소비자의 경합**: 봇이 회수하는 순간 소비자가 집고 있으면?
- **`failed/` 격리 실패 시**(디스크 오류 등) 잡이 어디로 가는가 — 조용히 사라지면 결함.
- 타임아웃 정합(`CHAT_SDK_GEN_TIMEOUT ≤ CHAT_BRIDGE_TIMEOUT`)이 어디서 강제되는가(W3/W4 몫이면 그렇다고 판정).

## 3. DoD (이 리뷰가 닫는 항목)

계획서 W2 행 DoD = `build ✓ · 단위(수명주기: 만료 미클레임·전이완료 삭제·경합 rename·reaper)+stub E2E ✓ · **Codex 클린**`.
앞의 것들은 검증됨(2026-07-17): build ✓ · 단위 425/425(job-protocol 54 포함) · stub E2E 4/4 ✓ · core 무수정 ✓ ·
docs-integrity 15/15 ✓. **남은 건 이 Codex 리뷰뿐**이며, critical/high 0 이어야 W3(세션 러너)로 넘어간다.

## 4. 재현·검증 명령

```bash
cd /Users/chabh/workspace/ch-regulated-harness/chat
pnpm build                                   # tsc --noEmit
pnpm test                                    # 단위 425 (하네스 불필요)
HARNESS_ROOT=/Users/chabh/workspace/ch-regulated-harness/core pnpm test:integration   # stub E2E 4건
```

⚠ `HARNESS_ROOT` 를 안 주면 통합 4건이 **조용히 생략**되지 않고 "생략" 로그를 남기며 skip 된다 — 그린으로 오독 말 것.

## 5. 산출 형식

발견을 **severity(critical/high/medium/low) · 파일:라인 · 불변식 번호 · 재현 시나리오(입력→잘못된 결과)** 로
적어라. **추정이 아니라 코드로 논증**하라. critical/high 가 0 이면 그렇게 판정하라(없는 결함을 만들지 말 것).
