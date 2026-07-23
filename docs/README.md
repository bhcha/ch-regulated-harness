# 문서·구조 총지도 (레포 내비게이션 · 정본)

> **이 문서의 지위:** "어디에 무엇이 있는가"의 **시작점(총지도)**. 레포의 전 영역(코드·팩·프롬프트·스킬·스키마·테스트·문서·런타임·설정)을 한 줄+링크로 훑고, 심화는 축별 조회 정본으로 넘긴다. 어떤 질문이든 여기서 2홉 안에 실제 파일에 닿는 것이 목표.
> **관계:** 규칙·안전 불변식 SSoT = [`../core/AGENTS.md`](../core/AGENTS.md)(헌법). 현업 5분 시작 = [`../core/README.md`](../core/README.md). 이 문서는 그 위에 얹는 개발자용 지도다.
> **본문 원칙:** 현재 존재하는 것만 담는다(변경 이력 서술 금지). 이력은 git.
> 작성 2026-07-10 · 최신 갱신 2026-07-18
> **유지보수(keep-in-sync):** 이 문서는 AGENTS.md 4번 절 D-1 동반갱신 대상이다 — 디렉터리를 신설하거나, 문서를 신설/강등/아카이브하면 같은 변경에서 아래 지도·문서 지위표를 갱신한다.

---

## 1. 영역 지도 — 어디에 무엇이 사는가

운영 루트 = `core/`(도메인-중립 커널). 규제 데이터는 형제 `packs/`.

| 영역 | 위치 | 무엇 | 심화(조회 정본) |
|---|---|---|---|
| **기능(로직)** | `core/scripts/` · `core/scripts/lib/` | 게이트·전이·엔진·검증·렌더 등 모든 실행코드 | [`feature-catalog.md`](canonical/feature-catalog.md) |
| **팩(데이터)** | `packs/<도메인>/` · `packs/_format/` | 도메인 룰셋·1차 출처·포맷 캐논(순수 데이터, 코드 없음) | [`pack-catalog.md`](canonical/pack-catalog.md) |
| **프롬프트** | `core/prompts/` | 단계 생성 프롬프트 SSoT(CLI 무관) + 심의·화법 | [`feature-catalog.md`](canonical/feature-catalog.md) 11절 |
| **인터페이스** | `core/skills/`(원본) → `core/.claude/commands/`(생성물) | 슬래시 편의 래퍼(세션 내 진입점) | [`feature-catalog.md`](canonical/feature-catalog.md) 11절 |
| **계약(스키마)** | `core/harness/*.schema.json`(`agui-projection.schema.json` = AG-UI 투영 이벤트 계약 포함) · `registry.json`·`phase-descriptors.json`·`pipeline-routes.json`·`a2ui-catalog.json`(A2UI 선택지 카탈로그 데이터 — 스키마 아님) | 동결 스키마 + 단계/라우트 매핑 + A2UI 카탈로그 | (스키마 파일 자체가 SSoT) |
| **테스트(검증)** | `core/tests/` | 결정적 CI 머지 게이트 `run-ci.sh` + 스위트·픽스처·골든·크리틱 스텁 | [`feature-catalog.md`](canonical/feature-catalog.md) 11절(가드테스트 열) |
| **문서** | `docs/`(루트, core 형제) | 정본·가이드·스냅샷·계획·아카이브 | 이 총지도(아래 지위표) |
| **파이프라인 소비 문서** | `core/docs/reference/` | regulation/(심의 해시 스캔)·design-tokens.md(keyvisual 프롬프트)·canon-blocks.md(storyboard 프롬프트) — 경로 결합이라 이동 금지 | (원본 코드/캐논 우선) |
| **런타임 산출물** | `core/runs/<id>/` | 런별 `state.json`·`run.md`·단계 산출물 + `.events/`(AG-UI 이벤트 로그 `agui.jsonl` — 전이마다 append·골든 제외)(스크립트만 씀; gitignore) | [`workflow-ssot.md`](canonical/workflow-ssot.md) |
| **씨앗 입력** | `core/inputs/` | 워킹백워드·자사 자산·동일 도메인 사례(일부 gitignore) | [`workflow-ssot.md`](canonical/workflow-ssot.md) 1단계 |
| **렌더 자산** | `core/assets/fonts/` | Playwright 렌더용 폰트(비코드) | — |
| **설정·비밀** | `.env`(`cp .env.example`) | 엔진 키·도메인별 ADK 엔드포인트 | [`config-reference.md`](canonical/config-reference.md) + AGENTS 2번 절 |
| **챗 게이트웨이(어댑터)** | `chat/`(core 형제) | Slack driving adapter — 하네스 스크립트 spawn(코어 무수정)·결합 계약 4면 소비 | `chat/README.md` · [`plans/chat-layer-plan.md`](plans/chat-layer-plan.md) |
| **헌법·지침** | `../core/AGENTS.md` · `../core/CLAUDE.md` · 루트 `AGENTS.md`/`CLAUDE.md` | 규칙·안전 불변식(단일 진실) | [`../core/AGENTS.md`](../core/AGENTS.md) |

## 2. 축별 조회 — "무엇을 알고 싶은가 → 어느 문서"

| 축 | 질문 | 조회 정본 |
|---|---|---|
| 기능 | 이 기능 어디에 어떻게 구현? 모듈 경계는? | [`feature-catalog.md`](canonical/feature-catalog.md) |
| 팩 | 이 도메인/포맷엔 뭐가 있나? 심의 룰셋·출처는? | [`pack-catalog.md`](canonical/pack-catalog.md) |
| 프롬프트·인터페이스·테스트 | 이 기능의 프롬프트/스킬/가드테스트는? | [`feature-catalog.md`](canonical/feature-catalog.md) 11절 |
| 흐름 | 어떤 순서로 무슨 일이? 심의는 언제? | [`workflow-ssot.md`](canonical/workflow-ssot.md) |
| 설정 | 이 환경변수 뭐고 기본값은? | [`config-reference.md`](canonical/config-reference.md) |
| 규칙 | 뭐가 금지/강제인가? | [`../core/AGENTS.md`](../core/AGENTS.md) |

## 3. 문서 지위표 — `docs/`

**용도별 하위 폴더**(지위 = 폴더): `canonical/`(정본 D-1) · `reference/`(참조·가이드·스펙) · `snapshots/`(강등 참조) · `plans/`(진행 중 계획) · `history/`(이력 raw) · `_archive/`(완료·폐기). `README.md`(이 총지도)만 docs 루트에 둔다. 파이프라인 소비 3건(regulation/·design-tokens·canon-blocks)은 경로 결합 때문에 `core/docs/reference/` 에 산다.

분류 기준 = 각 문서 헤더 + AGENTS 4번 절 D-1. 불일치 시 코드/AGENTS 우선.

| 지위 | 문서 | 갱신 의무 |
|---|---|---|
| **정본(D-1 동반갱신)** | [`workflow-ssot.md`](canonical/workflow-ssot.md)(흐름) · [`feature-catalog.md`](canonical/feature-catalog.md)(기능) · [`pack-catalog.md`](canonical/pack-catalog.md)(팩) · [`config-reference.md`](canonical/config-reference.md)(설정) · `README.md`(이 총지도) | **있음** — 해당 변경과 같은 커밋에서 갱신 |
| 규칙 SSoT(헌법) | [`../core/AGENTS.md`](../core/AGENTS.md) | 있음(규칙 자체) |
| 참조·가이드·스펙 | [`user-guide.md`](reference/user-guide.md)(현업) · [`deployment.md`](reference/deployment.md)(배포) · [`canon-blocks.md`](../core/docs/reference/canon-blocks.md)(캐논 파생) · [`design-tokens.md`](../core/docs/reference/design-tokens.md) · [`harness-design.md`](reference/harness-design.md)(설계) · [`ci-cost-and-target-map.md`](reference/ci-cost-and-target-map.md)(CI 계측 스냅샷) · [`agent-sdk-unmanned-worker-research.md`](reference/agent-sdk-unmanned-worker-research.md)(무인 생성 워커 리서치 스냅샷 — 챗 v2 P4/S-1 근거 · **상단 정책 확정 추기 우선**: SDK 구독 인증 경로는 폐기, 실 CLI 경로로 이관) · [`daemon-live-verification-runbook.md`](reference/daemon-live-verification-runbook.md)(라이브 인수 검증 운영자 런북 — 무인 데몬+AI 구동 온라인 E2E 수동 게이트 · 챗 레이어) · [`regulation/`](../core/docs/reference/regulation/)(README만) · [`workflow-diagram/`](reference/workflow-diagram/)(다이어그램 자산) | 파생/참조 — 원본(코드/팩/canon.json) 우선 |
| 참조 스냅샷(강등, 갱신의무 밖) | [`pipeline-stage-definitions.md`](snapshots/pipeline-stage-definitions.md) · [`harness-architecture.md`](snapshots/harness-architecture.md) · [`stage-contracts.md`](snapshots/stage-contracts.md) | **없음** — 작성 시점 스냅샷(불일치 시 코드 우선) |
| 진행 중 계획(유지) | [`ops-and-pack-refactor-plan.md`](plans/ops-and-pack-refactor-plan.md)(1·2부 완료 · **3부 온보딩 잔존**) · [`multi-domain-build-plan.md`](plans/multi-domain-build-plan.md)(**의약외품·건기식 심의자료 대기**) · [`chat-layer-plan.md`](plans/chat-layer-plan.md)(**챗 레이어 1차 — `main` 병합 완료(`2dd84cb`)**) · [`chat-hexagonal-gateway-plan.md`](plans/chat-hexagonal-gateway-plan.md)(**챗 게이트웨이 v2 — P0~P4 구현·`main` 병합 완료 · 라이브 스파이크[S-1/S-3/S-4] 후속**) · [`chat-dual-surface-plan.md`](plans/chat-dual-surface-plan.md)(**이중 표면 실행 설계 — Q1[헤드리스 NL 파서] 완료 · Q2[S-1 실측] 완료(ⓓ 과금 귀속 제외) · Q3 진행 중 · 집행은 실행 계획으로 이관**) · [`chat-unmanned-consumer-plan.md`](plans/chat-unmanned-consumer-plan.md)(**무인 생성 소비자[cli-consumer] — 실 CLI 세션 워커 · W0~W4 완료(W4=데몬 · Codex 2라운드 수렴 · verify green) · W5[라이브] 잔존 · 사람 승인 대기 1건[잠긴 결정 4 killAt 에스컬레이션]**) · [`chat-live-acceptance-test-plan.md`](plans/chat-live-acceptance-test-plan.md)(**라이브 인수테스트 — S5 온라인 백엔드+런북 구축 완료(`chat/src/live/`) · 잠긴 결정 4 확정 · 실 라이브 런은 사람 수동 게이트 잔존**) · [`chat-atdd-acceptance-plan.md`](plans/chat-atdd-acceptance-plan.md)(**개발방법 전환 = ATDD 인수 계층 · CI 우선/사람 최종확인 · 데몬 유지+빠진 표면 흐름 인수 계층 추가**) · [`chat-live-driver-fix-plan.md`](plans/chat-live-driver-fix-plan.md)(**라이브 드라이버 수정+브리프-너머 생성 배선 — 1차 라이브 런 결함 3건 처방 · 유료 재런으로 3안 카드 3종(concept/outline/keyvisual) Slack 실증 목표 · 계획 수립(사람 go 대기)**) · [`harness-skeleton-and-seams.md`](plans/harness-skeleton-and-seams.md)(**Seam A·B·C·F 완결 · C-2/F-2/C-4·SSoT 반영·E2E 캡스톤 잔존**) · [`agui-a2ui-projection-plan.md`](plans/agui-a2ui-projection-plan.md)(**AG-UI·A2UI 투영 레이어 — 실행·상태·중단·재개=AG-UI, 선택지=A2UI · 구현 착수(feat/agui-a2ui-projection)**) | 계획 진행 시 갱신 · 완료 시 `_archive/` |
| 이력(raw) | [`workflow-ssot-history.md`](history/workflow-ssot-history.md) | append 전용 |
| 아카이브(완료·폐기·이력) | [`_archive/`](./_archive/) — 색인 [`_archive/README.md`](./_archive/README.md)(완료 계획 다수 · 7차 정리) | 없음 |

> **루트 문서:** 레포 루트에는 모노레포 루트 파일(`README.md`·`AGENTS.md`·`CLAUDE.md`)만 남았다(계획성 문서 0). 병렬 트랙 스크래치(`parallel-run.goal`·`meta-*`·`track-a-e2e-validation`·`track-b-cleanup-impl`·`fix-plan-intake-defects`)는 7차 정리에서 전부 `docs/_archive/` 로 이동했다.

## 4. 폴더별 변경 → 갱신 문서 조회표 (D-1 사람용 색인)

> 규칙 SSoT = [`../core/AGENTS.md`](../core/AGENTS.md) 4번 절 D-1(변경 **종류** 기준). 아래는 같은 규칙을 **"어느 폴더를 고쳤나"** 기준으로 뒤집은 조회표다 — 충돌 시 AGENTS 가 우선.

| 바뀐 폴더 | 같은 변경(커밋)에서 갱신할 문서 |
|---|---|
| `core/scripts/` · `core/scripts/lib/` | [`feature-catalog.md`](canonical/feature-catalog.md) — 단계·게이트·전이 흐름까지 바뀌면 + [`workflow-ssot.md`](canonical/workflow-ssot.md) |
| `core/harness/`(스키마·phase-descriptors·pipeline-routes·registry) | [`workflow-ssot.md`](canonical/workflow-ssot.md) — 스키마 파일 자체가 계약 SSoT |
| `core/prompts/` | [`feature-catalog.md`](canonical/feature-catalog.md) 11절(동반물 매핑) |
| `core/skills/`(원본 → `.claude/commands/` 생성물) | [`feature-catalog.md`](canonical/feature-catalog.md) 11절 |
| `core/tests/` | [`feature-catalog.md`](canonical/feature-catalog.md) 11절(가드테스트 열) |
| `packs/<도메인>/` · `packs/_format/` | [`pack-catalog.md`](canonical/pack-catalog.md) — `adk_critic` 등 env 신설이면 + AGENTS 2번 절·[`config-reference.md`](canonical/config-reference.md) |
| env 규약(`.env.example`·기본값 변경) | AGENTS 2번 절 + [`config-reference.md`](canonical/config-reference.md) |
| `docs/`(문서 신설/강등/아카이브) | 이 총지도(지위표) — 아카이브면 + [`_archive/README.md`](./_archive/README.md) 색인 |
| `docs/plans/`(계획 신설·상태 변화·완료) | 이 총지도 3번 절 상태표 — 완료 시 `_archive/` 이동 |
| `core/docs/reference/`(파이프라인 소비: regulation/·design-tokens·canon-blocks) | 갱신 의무 없음(파생·소비 데이터) — 단 프롬프트·심의 스캔이 경로 참조하므로 **이동/이름변경 금지** |
| `chat/` | `chat/README.md`(어댑터 자체 문서) + [`plans/chat-layer-plan.md`](plans/chat-layer-plan.md) 진행 로그 — core 정본 5개 무관(core 무수정 원칙). 단 결합 계약 4면이 바뀌면 그건 core 변경이므로 위 해당 행 적용 |
| `core/inputs/` · `core/runs/` · `core/assets/` | 갱신 의무 없음(씨앗·런타임·렌더 자산) |
| 디렉터리 신설(위치 불문) | 이 총지도 1번 절 영역 지도 |

## 5. 시작 경로(현업 vs 개발자)
- **현업(4동작)**: `runs/<id>/run.md` "지금 할 일" 한 줄만 본다 → [`../core/README.md`](../core/README.md) 5분 가이드.
- **개발자**: 이 총지도 → 축별 조회 정본(2번 표) → 실제 파일. 규칙 확인은 항상 [`../core/AGENTS.md`](../core/AGENTS.md).
