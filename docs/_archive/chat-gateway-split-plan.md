# 챗 게이트웨이 저장소 분리 계획 — 헥사고날 어댑터 정렬 (SUPERSEDED)

> **⛔ SUPERSEDED (2026-07-13)**: 이 계획(외부 저장소 분리)은 **실행되지 않았다**. 사용자가 분리 대신
> **모노레포 병합**을 택해 챗 레이어(`chat/`)는 `main` 에 병합됐다(merge commit `2dd84cb`). 이 문서는 이력·참고용으로
> `_archive/` 에 보존한다 — 분리를 되살릴 경우 아래 S1~S8·DoD 는 그대로 유효하다(현행 `chat/` 는 이미 분리-READY:
> `HARNESS_ROOT` 주입·`../core` 기본값 제거·테스트/verify 2계층, dev-loop 검증 완료).
> **작성**: 2026-07-12. 근거 = 접점 실측(아래 2장 — merge-base diff · 참조 grep 전수) + 사용자 방향
> ("헥사고날 아키텍처처럼 이 부분은 infra/adapter 레이어가 적절") + 구현 현황(`chat/` v2 · 테스트 178 · Codex 수렴).
> **관계**: 챗 레이어 설계·구현 정본 = [`chat-layer-plan.md`](../plans/chat-layer-plan.md)(그 문서 14장이 이 계획을 가리킨다).
> 하네스 규칙 SSoT = [`../../AGENTS.md`](../../AGENTS.md)(불변 — 이 분리는 core 를 한 줄도 바꾸지 않았다).

---

## 0. 한 줄 정의

챗 레이어(`chat/`)를 하네스 모노레포에서 **별도 저장소로 추출**한다. 프레이밍은 헥사고날(ports & adapters) —
core 하네스 = 애플리케이션 코어, **포트 = 동결 계약 4면**(next-action JSON[읽기] · 4동작 CLI[쓰기] · 산출물 파일 ·
평이 라벨), 챗 = 그 포트를 사용자 쪽에서 구동하는 **driving adapter**(원격 ADK 심의가 driven adapter 인 것과 대칭).
어댑터는 코어 저장소 밖에 산다.

## 1. 왜 분리하는가

1. **아키텍처 정렬(사용자 방향)**: 어댑터/infra 레이어가 도메인 코어와 같은 저장소에 동거하면 릴리스·CI·권한이
   계속 얽힌다. 포트(계약 4면)가 이미 동결돼 있으므로 물리 분리의 전제가 충족돼 있다.
2. **코어 위생**: 하네스 저장소의 관심사는 규제 파이프라인이다. 챗은 표면이 여럿 생길 수 있는(Slack·GChat·웹)
   전달 계층이라 수명주기가 다르다.
3. **병렬 작업 충돌 제거**: 하네스 쪽 seam 작업과 챗 작업이 같은 저장소에서 브랜치·워크트리를 나눠 쓰는 현 상태의
   운영 마찰(혼합 커밋 위험·총지도 경합)을 없앤다.

## 2. 현황 분석 (2026-07-12 실측)

| 접점 | 실태 | 분리 시 처리 |
|---|---|---|
| core 안 산출물 | **문서 2개뿐** — `core/docs/plans/chat-layer-plan.md`(+이 문서) + 총지도 등재 줄. 코드 0(merge-base diff 실측) | S2 이관 |
| 저장소 동거 | `chat/` 이 모노레포 형제 디렉터리(같은 git · 브랜치 `feat/chat-layer-plan`, main 미머지·미푸시) | S1 추출 |
| core → chat 역참조 | **0건**(단방향 의존 — core CI 는 chat 을 모른다) | 분리 가능 조건 충족 ✓ |
| 경로 기본값 | `chat/src/config.ts` `DEFAULT_HARNESS_ROOT = ../core`(형제 체크아웃 가정) | S3 제거 |
| 테스트 결합 | `test/fixtures/capture-fixtures.sh`·`test/e2e/`(하네스 스크립트·`tests/fixtures/bundle-cosmetic` 실행) — 계약 검증용, 의도된 결합 | S4 env 게이트 |
| verify 게이트 | `chat/scripts/verify.sh` 가 `git status -- core/`(모노레포 가정) | S5 재정의 |
| 스크래치 | `.scratch-api/`·`.scratch-fixtures/`·`.dev-loop-state.json`(git exclude, 비추적) | 이관 불필요(재생성물) |

단위 테스트(177)는 하네스 없이 green(픽스처는 chat 내 추적본) — 하네스가 필요한 것은 픽스처 **재캡처**와 stub E2E 뿐.

## 3. 분리 단계 (S1~S8)

### S1. 저장소 추출(이력 보존)
- 새 저장소 생성: 이름 **미정(결정 1)** — 제안 `ch-chat-gateway`.
- `git subtree split -P chat -b split/chat` 으로 `chat/` 경로 커밋 이력만 추출 → 새 저장소 루트로 push
  (chat/ 하위가 새 repo 의 루트가 된다: `src/`·`test/`·`scripts/`·`jobs/`·`package.json`…).
- 모노레포 브랜치 `feat/chat-layer-plan` 은 하네스에 **머지하지 않는다** — 아카이브 태그(`archive/chat-monorepo`)로
  보존 후 브랜치 삭제. 워크트리 `ch-chat-layer` 제거 → 새 저장소 단독 클론으로 대체.

### S2. 문서 이관(소유 이전)
- `chat-layer-plan.md` + 이 문서 → 새 repo `docs/`(예: `docs/plan.md`·`docs/split-plan.md`, 완료 시 split-plan 은
  `docs/_archive/`). 문서 헤더의 하네스 상대링크(AGENTS·workflow-ssot)는 절대 참조(저장소명/경로 표기)로 조정.
- 하네스 총지도(`core/docs/README.md`)에서 챗 계획 항목 제거(D-1). **외부 저장소 포인터 1줄을 남길지 = 결정 2**
  (남기면 하네스 main 에 1줄짜리 별도 PR — 그 외 챗 흔적 0).

### S3. 포트 주소 명시화(형제 가정 제거)
- `config.ts`: `DEFAULT_HARNESS_ROOT`(=`../core`) 삭제 → **`HARNESS_ROOT` env 필수**, 미설정이면 기동·테스트에서
  fail-fast(명확한 한국어 안내). 헥사고날 원칙: 어댑터는 포트 주소를 추측하지 않고 주입받는다.

### S4. 테스트 2계층(standalone / integration)
- **standalone**(하네스 불필요): 단위 177 + 계약 픽스처 검증(추적본 대상) — `pnpm test` 기본.
- **integration**(`HARNESS_ROOT` 지정 시에만): 픽스처 재캡처 멱등 + stub E2E — 미지정이면 **명시적 skip**(무음 통과 금지,
  "하네스 미지정 — 통합 생략" 1줄).
- CI 2잡: standalone(항상) · integration(하네스 저장소를 **핀 커밋 `HARNESS_REF`** 로 클론 후 실행 — 계약 드리프트 감지 유지).

### S5. verify 게이트 재정의(의미 보존·가정 이전)
- "core 무수정 증명"의 의미는 유지하되 검사 대상을 자기-repo 에서 → **`HARNESS_ROOT` 체크아웃의
  `git status --porcelain`** 으로(어댑터 실행이 코어 체크아웃을 더럽히지 않음을 증명). 하네스 미지정이면 해당 단계 skip 표기.

### S6. 설정 독립
- 새 repo `.env.example`: `HARNESS_ROOT`(필수) · `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`/`SLACK_SIGNING_SECRET` ·
  `CHAT_APPROVERS` · `CHAT_BUNDLE_DIR` · `CHAT_STAGED_WB` · (선택) `CHAT_STATE_DIR`/`CHAT_DATA_DIR`/`CHAT_JOBS_DIR`.
- `.gitignore`(node_modules·.state·data·jobs/pending·*.log) 이관 확인. README(기동·운영자 규약=jobs/README 통합) 작성.

### S7. 계약 버전 핀 · 드리프트 절차
- 새 repo 에 `HARNESS_REF`(검증된 하네스 커밋/태그) 기록. 하네스 계약 변경(additive 초과) 시:
  픽스처 재캡처 + `HARNESS_REF` 상향을 **한 커밋**으로(chat-layer-plan 4-4 계약 변경 규칙의 저장소-분리판).
- 하네스 쪽 의무는 불변: next-action JSON 은 additive-only(기존 `test-b8` 회귀가 지킴).

### S8. 완료 기준(DoD)
- 새 repo **단독 클론**에서 `pnpm i && pnpm verify`(standalone) green.
- `HARNESS_ROOT` 지정 시 integration(픽스처 멱등·stub E2E) green.
- 어댑터 실행 후 하네스 체크아웃 `git status` 오염 0.
- 하네스 저장소: main 에 chat 관련 diff 0 · 총지도에서 챗 계획 항목 제거(±포인터 1줄) · 아카이브 태그 존재.

## 4. 실행 순서·소요(승인 후)

S1→S2→S3→S4·S5(같은 PR)→S6→S7→S8 검증. 코드 변경은 S3~S5 의 3파일(config.ts·verify.sh·capture/E2E 게이트)
중심으로 소폭 — 반나절 규모. 리뷰는 기존 규율(Codex critical/high 0) 유지.

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| subtree split 후 이력 단절 오해 | 아카이브 태그로 모노레포 시점 보존 + 새 repo 첫 README 에 유래 명기 |
| integration 미실행 채로 드리프트 누적 | CI integration 잡 필수화(핀 커밋) + skip 은 항상 가시 로그 |
| `HARNESS_REF` 방치(옛 계약에 고정) | 하네스 태그 릴리스 시 상향 체크를 운영 루틴에 포함(S7 절차) |
| 하네스 쪽 포인터 부재로 발견성 저하 | 결정 2(포인터 1줄) — 남기는 쪽 권장 |

## 6. 결정 필요(실행 전)

1. **새 저장소 이름**: 제안 `ch-chat-gateway`(대안: `ch-regulated-chat` 등).
2. **하네스 총지도에 외부 포인터 1줄을 남길지**(권장: 남김 — 1줄 PR).

## 7. 고지

이 분리는 배치 변경일 뿐 동작 계약을 바꾸지 않는다 — core 무수정 · 생성≠심의 · state 는 scripts 만 등
하네스 불변식(AGENTS)은 그대로이며, 챗 산출물 고지(법적 보증 아님 · 최종 책임은 사람)도 불변이다.
