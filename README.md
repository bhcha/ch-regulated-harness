# ch-regulated-harness — 규제 상세페이지 생성 하네스 (모노레포 마이크로커널)

규제(화장품·의약외품·건기식·의약품) 상세페이지 생성 워크플로우를 결정론 상태기계(bash+python)로 굴리는 하네스.
원본 `~/workspace/ch-detail-page-harness`(무수정 참조)를 모노레포 마이크로커널로 리팩토링한 결과물이다.

## 구조

```
ch-regulated-harness/
├── core/      ← 커널: 도메인 무관 엔진(scripts·harness·prompts·tests·fixtures·inputs·docs/reference[파이프라인 소비 3건]·…). state.json 단일쓰기·게이트·심의 격리 불변식 보유.
├── packs/     ← 도메인 팩: cosmetic·drug(active) · quasi_drug(tbd) · health_food(ready-only) · _format(포맷 캐논). 무엇을 말할 수 있나(룰셋)·어떤 단계(라우트)·무엇으로(포맷).
└── docs/      ← 사람·에이전트용 문서: 총지도 docs/README.md · 정본 canonical/ · 계획 plans/ · 아카이브 _archive/
```

## 운영 위치 = `core/`

하네스의 **1급 경로(셸 명령)는 `core/` 에서 실행**한다(`core/` 가 커널 루트 = 스크립트가 계산하는 `ROOT`). 팩은 `core/../packs` 로 참조된다.

```bash
cd core/
bash scripts/new-run.sh <run_id> --domain 화장품 --format 여러장   # 런 생성
bash scripts/run-stage.sh brief <run_id>                          # 단계 생성
bash scripts/kcia-check.sh <run_id>                               # 심의(별세션)
bash scripts/approve.sh <run_id>   # / select.sh / revise.sh      # 현업 게이트
cat runs/<run_id>/run.md                                          # "지금 할 일"
bash tests/run-ci.sh                                              # 회귀(결정적)
```

> `core/README.md`·`core/AGENTS.md`·`core/.claude/commands/`·`core/skills/` 의 명령 안내는 모두 이 **`core/` 기준**이다.

## 진행 상태

정본 워크플로우: [`docs/canonical/workflow-ssot.md`](docs/canonical/workflow-ssot.md). 규칙·안전 불변식: [`core/AGENTS.md`](./core/AGENTS.md).
