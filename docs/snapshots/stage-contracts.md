# 단계 분리 — 경계 프로토콜 & 격리 검증 (Stage Contracts)

> ⚠️ **참조 문서(스냅샷) — 동반 갱신 의무 없음(D-1).** 단계 경계 프로토콜 이해용 스냅샷이며 동반 갱신 의무 대상이 아니다(규칙 SSoT=`AGENTS.md`, 현재상태 SSoT=코드). 세부는 코드와 어긋날 수 있다(**코드 우선**). 동반 갱신 의무가 있는 유일한 문서는 [`workflow-ssot.md`](../canonical/workflow-ssot.md) 다.

> 목적: 비대해진 하네스를 **4단계(브리프·컨셉·콘티·키비주얼)**로 나눠 **각자 개발·검증 후 합친다.**
> 핵심: 이 하네스는 "파일=상태"라 **단계 경계가 이미 파일 계약(스키마)으로 존재**한다.
> 이 문서는 그 경계를 **동결(freeze)**하고, 각 단계를 앞 단계 없이 단독 검증하는 방법을 정의한다.

## 0. 분리 단위 (4단계 ↔ 페이즈)
| 단계 | 페이즈 | 브랜치 | 격리 테스트 |
|---|---|---|---|
| **브리프** | 유형선언 + `00-ingest` + `[00g-guideline]` + `01-brief` | `stage/brief` | `tests/stage-brief.sh` |
| **컨셉/빅아이디어** | `02-concept` | `stage/concept` | `tests/stage-concept.sh` |
| **콘티/스토리보드** | `03-storyboard`(outline→plan; M3 2-cycle) | `stage/conti` | `tests/stage-conti.sh` |
| **키비주얼/아트워크** | `04-keyvisual` + export | `stage/keyvisual` | `tests/stage-keyvisual.sh` |

## 1. 경계 프로토콜 (동결) — 각 단계 출력 = 다음 입력
경계 = **스키마(`harness/*.schema.json`) + 동결 골든 핸드오프 픽스처(`fixtures/<boundary>-in/`)**.
픽스처는 `scripts/build-fixtures.sh`(결정적 stub)로 생성하며, **계약을 재협의할 때만** 재생성·커밋한다.

| 경계 | 건너가는 산출물(스키마) | 동결 픽스처 |
|---|---|---|
| **입력 → 브리프** | `inputs/working-backwards.md` · 크롤 번들 · 유형선언(domain,format) · (`inputs/examples/<도메인>/`) | (원시 입력) |
| **브리프 → 컨셉** | `00-ingest/{voc,claim-basis,assets-manifest}.json` · `01-brief/brief.json`(+ `confirmed_guideline`) · `state.product{regulatory_domain,deliverable_format,functional_status}` | `fixtures/concept-in/` (phase=02-concept) |
| **컨셉 → 콘티** | `02-concept/{concept-axes,recommendation,decision}.json` · `options/<sel>/{rtb,key-message}.json` | `fixtures/conti-in/` (phase=03-storyboard) |
| **콘티 → 키비주얼** | `03-storyboard/plan/*.json`(visual.concept 포함) · `outline/decision.json` · `assets-manifest` | `fixtures/keyvisual-in/` (phase=04-keyvisual) |
| **키비주얼 → done** | `04-keyvisual/{design-manifest,canon-coverage}.json` · `options/<sel>/` · `export/kcia-package/` | (done) |

## 2. 단독 검증 (각 단계, 앞 단계 없이)
`bash tests/stage-<단계>.sh` — 동결 입력 픽스처를 run 으로 로드 → 그 단계만 실행 → 출력 스키마·핸드오프 검증.
- `stage-brief`: 원시 입력 → **concept-in 계약**(state `structdiff` 일치)
- `stage-concept`/`conti`/`keyvisual`: `fixtures/<X>-in` → 다음 핸드오프 전진
- 전체: `bash tests/run-stages.sh` (4단계 격리 일괄).

→ 예: **컨셉 팀은 `fixtures/concept-in`만으로** 컨셉을 개발·검증한다. 브리프를 한 번도 안 돌려도 된다.

## 3. 소유권 (변경 충돌 최소화)
**공유 백본(동결, 변경 시 4단계 합의 + 픽스처 재생성):**
`harness.py` · `gate.sh` · `advance-phase.sh` · `run-stage.sh`(디스패처 골격) · `common.sh`(헬퍼) ·
`kcia_engine.py`(scan_text/load_ruleset/evaluate 골격) · `kcia-check.sh` · `registry.json` ·
`{regulatory-domains,format-profiles,ingest-profiles}.json` · **경계 스키마** · `state.schema.json` ·
`canon-blocks.md`(파생)·`packs/_format/<포맷>/canon.json`(캐논 정본 — 콘티·키비주얼 공유).

| 단계 | 단계-소유 파일 |
|---|---|
| 브리프 | `new-run.sh` · `ingest-bundle.sh` · `ingest.py` · `examples_analysis.py` · `prompts/{brief,guideline}.md` · brief/guideline/example-analysis 스키마 · stub `gen_brief`·`_confirmed_guideline` · gather(01-brief,00g) · validate-stage(00-ingest,00g,01-brief) · `tests/{test-b1,test-b1g,stage-brief}.sh` |
| 컨셉 | `prompts/concept.md` · concept-axes/rtb/key-message 스키마 · stub `gen_concept*` · gather(02)+voc_phrase 규칙 · validate-stage(02) · `tests/{test-b2,stage-concept}.sh` |
| 콘티 | `prompts/storyboard-*.md` · storyline/plan-block 스키마(tone* 레거시) · stub `gen_storyboard_{outline,plan}` · `image_engine.py`·`gen-images.sh` · `check_canon_coverage.py`·`validate_storyboard.py` · gather(03) · validate-stage(03) · `tests/{test-b4,test-components,stage-conti}.sh` |
| 키비주얼 | `prompts/keyvisual.md` · design-manifest 스키마 · `render-design.sh`·`img_lint.py`·`check_asset_paths.py`·`export_package.py` · gather(04) · validate-stage(04) · `tests/{test-b5,stage-keyvisual}.sh` |

**조정 지점(공유 파일에 단계별 1행씩):** `run-stage.sh`(stage→primary case) · `common.sh`(stage_phase/verdict_path/phase_is_multi/sel_decision_rel case) · `kcia_engine.gather()` · `validate-stage.sh`(phase case) · `render_runmd.py`(ORDER/LABEL/stage_for_phase). 각 단계는 자기 행만 추가 → 머지 충돌 최소.

## 4. 머지 게이트 (합치자)
1. **단계 머지 조건:** 자기 `stage-<X>.sh` 통과 **AND** 공유 백본·경계 스키마 무변경(변경 시 §3 합의 + `build-fixtures.sh` 재생성).
2. **통합 게이트:** `bash tests/run-ci.sh` end-to-end 그린 — 단계 N의 *실제* 출력이 N+1로 흐르는 전체 파이프라인(골든 핸드오프가 실제 출력과 일치 = 경계 무손상).

## 5. 워크플로 (git worktree)
```bash
# main = 동결 baseline(공유 백본 + 계약 + 픽스처)
git worktree add ../ch-stage-brief    stage/brief
git worktree add ../ch-stage-concept  stage/concept
git worktree add ../ch-stage-conti    stage/conti
git worktree add ../ch-stage-keyvisual stage/keyvisual
# 각 worktree에서: 자기 소유 파일 개발 → bash tests/stage-<X>.sh 통과 → main 머지 → run-ci.sh 통합 그린
```
