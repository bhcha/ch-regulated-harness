# 비운영 파일 정리 계획 (cleanup-plan)

- 상태: **실행 완료(2026-07-02)**. 이 문서는 "무엇을 왜 지우는가"의 확정 목록이었고, 전-트리 참조 재검증(4-렌즈 독립 확인) 후 Tier 0·1·2 + 데모 시드를 실행했다. Tier 3(kcia-critic.md)은 계획대로 별도 정책 결정으로 보류. 완료 기록으로 아카이브 보관한다.
- 작성: 2026-07-02. 근거: 리포 전수 감사(7-에이전트 병렬) + 전-트리 참조 재검증(anchored grep, functional/comment 구분).
- 방침(사람 결정 반영): 데모/샘플 시드(아래 '데모 시드' 구역)는 **전량 삭제** 승인됨.
- 실행 완료 후 이 문서는 `docs/_archive/` 로 옮긴다(완료 계획 보관 규칙).

이 정리의 목적은 **하네스를 실행·유지하는 데 쓰이지 않는** 이력·아카이브·부산물을 제거하는 것이다. 룰셋·스크립트·스키마·팩·현행 SSoT·테스트 자산은 대상이 아니다.

## 판정 기준 (safe 의 정의)

한 파일이 **"삭제 안전"** 하려면, 정리 후 **살아남는 파일 중 아무도 그 파일을 가리키지 않아야** 한다.

- 참조가 **다른 삭제-대상**에서만 오면 → 함께 지우면 안전(같은 커밋).
- 참조가 **살아남는 문서**(예: `workflow-ssot.md`·`AGENTS.md`·`README.md`)에서 오면 → 그 인용 문구를 **같이 제거**해야 안전(needs-ref-cleanup).
- 참조가 **코드/테스트**에서 오면 → 그 참조가 **기능적 로드**인지 **주석/문서 링크**인지 구분한다. 본 계획의 모든 코드 참조는 재검증 결과 **전부 주석·docstring·title 문자열**이며 파일을 기능적으로 읽지 않는다(삭제해도 실행·테스트 안 깨짐). 근거는 각 표의 '참조 성격'.

> 앞선 자동 감사(synthesis)는 "즉시삭제 안전 22건"이라 보고했으나, 전-트리 재검증에서 상당수가 살아있는 `workflow-ssot.md` 등에 인용돼 있었다. 아래 수치가 재검증된 값이다: **매니페스트만 손보면 되는 안전삭제 12건 + 살아있는 문서·주석 인용정리 동반 15건.**

## 요약

| 구분 | 건수 | 처리 |
|---|---|---|
| Tier 0 · 작업트리 부산물 | 다수(≈40파일) | `rm`(이미 .gitignore, git 영향 없음) |
| Tier 1 · 안전삭제(매니페스트만) | 12 | `git rm` + `_archive/README.md` 표만 정리 |
| Tier 2 · 인용정리 동반삭제 | 15 | `git rm` + 살아있는 문서/주석의 인용 문구 동시 수정 |
| 데모 시드(전량삭제 승인) | 9항목(≈18파일) | `git rm`(한 단위로 함께) |
| Tier 3 · 범위 밖(삭제 보류) | 1 | 정책 아티팩트 — 별도 결정 |
| 보존(함정·설계근거) | 8 | 손대지 않음 |

---

## Tier 0 — 작업트리 부산물 (rm; 이미 gitignore)

git 추적에 없고 에디터/툴 캐시라 작업트리에서 지우면 된다. 하네스 런타임과 무관.

| 경로 | 무엇 |
|---|---|
| `.DS_Store`, `core/.DS_Store` | macOS 디렉터리 메타 |
| `.dev-loop-state.json` | dev-loop 스킬 런타임 상태 |
| `.claude/settings.local.json`, `core/.claude/settings.local.json` | Claude CLI 로컬 설정 |
| `.claude/scheduled_tasks.lock` | schedule 스킬 락 |
| `.obsidian/*` (9), `core/.obsidian/*` (4) | Obsidian 노트에디터 설정 |
| `.playwright-mcp/*` (25) | Playwright 브라우저 트레이스·콘솔 로그(≈800K) |

---

## Tier 1 — 안전삭제 (살아남는 파일이 안 가리킴; `_archive/README.md` 매니페스트 표만 정리)

이 12개는 살아있는 문서·코드가 인용하지 않는다. 유일한 인바운드는 `docs/_archive/README.md`(아카이브 자기-매니페스트 표)뿐이라, 삭제 시 그 표에서 해당 행만 지우면 된다.

| 경로 | 무엇 | 인바운드 |
|---|---|---|
| `core/docs/_archive/four-issue-improvement-plan.md` | 4대 이슈 개선(완료) | 매니페스트만 |
| `core/docs/_archive/ezderm-acne-test-record.md` | ezderm-acne v1 주행기록 | 매니페스트 (+ 삭제대상 wb-ezderm-acne.md) |
| `core/docs/_archive/ezderm-acne-v2-test-record.md` | ezderm-acne v2 주행기록 | 매니페스트만 |
| `core/docs/_archive/render-existence-check-hardening-plan.md` | 렌더 존재성 검사 강화(완료) | 매니페스트만 |
| `core/docs/_archive/preimage-final-warning-plan.md` | 이미지 직전 최종점검 게이트(완료) | 매니페스트만 |
| `core/docs/_archive/REFACTORING-RESUME.md` | 리팩터링 재개(미완, 버려짐) | 없음(CLEAN) |
| `core/docs/_archive/workflow-impl-plan.md` | 워크플로우 M1–M9(완료) | 매니페스트 (+ 삭제대상 REFACTORING-*) |
| `core/docs/_archive/image-concept-build-plan.md` | 톤&매너 A/B·이미지 컨셉(완료) | 매니페스트 (+ 삭제대상 nanobanana-build-plan) |
| `core/docs/_archive/v2-chat-interface-research.md` | 2차 챗 인터페이스 리서치(미착수) | 매니페스트 (+ 삭제대상 slack-poc-plan) |
| `core/docs/background-hang-control.md` | 백그라운드 행 제어 참고(watchdog로 대체) | 매니페스트 '현행문서' 문단 |
| `core/docs/brief-to-concept-handoff.md` | 브리프→컨셉 핸드오프(SSoT로 병합) | 매니페스트 (+ 삭제대상 website-format) |
| `core/docs/retrospective-fix-plan.md` | 2026-06-27 회고 수정계획(구현 완료) | 매니페스트만 |

---

## Tier 2 — 인용정리 동반삭제 (살아있는 문서/주석의 인용 문구를 같은 커밋에서 수정)

기능 코드는 손대지 않는다. 아래 '함께 고칠 참조'는 전부 **문서 인용 링크** 또는 **코드 주석/docstring**이다(기능 로드 아님 — 재검증 완료).

| 경로 | 함께 고칠 참조 | 참조 성격 |
|---|---|---|
| `core/docs/_archive/harness-improvement-plan.md` | `workflow-ssot.md` | 문서 인용 |
| `core/docs/_archive/website-format-removal-plan.md` | `workflow-ssot.md` | 문서 인용 |
| `core/docs/_archive/detail-workflow-redesign-plan.md` | `pipeline-stage-definitions.md`, `workflow-ssot.md` | 문서 인용 |
| `core/docs/_archive/orchestration-upgrade-plan.md` | `_archive/in-session-generation-proposal.md`(보존) | 문서 인용 |
| `core/docs/_archive/slack-poc-plan.md` | `_archive/in-session-generation-proposal.md`(보존) | 문서 인용 |
| `core/docs/_archive/REFACTORING-PLAN.md` | 루트 `README.md:32`(링크) · `baseline.py:2`·`capture-baseline.sh:3`·`test-drug-golden.sh:2` | 링크 1 + 나머지 docstring/주석(단계 라벨) |
| `core/docs/_archive/critic-engine-restructure-plan.md` | `workflow-ssot.md` · `test-insession-genmode.sh` | 문서 인용 + 테스트 주석 |
| `core/docs/_archive/pass-escalate-fix-plan.md` | `workflow-ssot.md` · `kcia_merge.py:97` | 문서 인용 + 코드 주석 |
| `core/docs/_archive/build-plan.md` | `core/README.md` · `multi-domain-build-plan.md` · `golden_runner.py:2` | 문서 인용 + docstring |
| `core/docs/_archive/in-session-genmode-build-plan.md` | `common.sh:265` | 코드 주석(비기능) |
| `core/docs/_archive/generation-watchdog.md` | `AGENTS.md`(2번 절) · `workflow-ssot.md` · `common.sh:183` | 문서 인용 + 코드 주석 |
| `core/docs/_archive/nanobanana-build-plan.md` | `AGENTS.md`(2번 절) · `test-image-engine.sh:3` | 문서 인용 + 테스트 주석 |
| `core/docs/_archive/insession-conversion-plan.md` | `AGENTS.md:30` · `workflow-ssot.md:53` · `run-stage.sh:234` · `render_runmd.py:92` · `test-insession-genmode.sh:3` | 문서 인용 + 코드 주석 (test 주석은 stale 경로 `docs/insession-conversion-plan.md` — 삭제 시 함께 제거) |
| `core/docs/ezderm-relief-test-record.md` | `workflow-ssot.md`(327·328행, E2E 검증기록으로 인용) | 문서 인용 |
| `core/prompts/kcia-refute.md` | `harness-architecture.md` · `pipeline-stage-definitions.md` | 문서 인용(폐기된 2-pass 설계 언급) |

주의:
- `AGENTS.md` 2번 절에는 generation-watchdog·nanobanana-build-plan·insession-conversion-plan 의 "(설계: docs/_archive/…)" 링크가 있다. 문서 삭제 시 그 링크 문구를 함께 제거한다(기능 설명 문장은 유지).
- `_archive/build-plan.md` 는 `AGENTS.md` 가 직접 가리키지 않는다(그건 `multi-domain-build-plan.md`·`nanobanana-build-plan.md` 등 '-build-plan' 접미 파일이다 — 접미사 오탐 주의).
- 인용정리 후 `_archive/README.md` 매니페스트 표도 함께 정리한다(Tier 1·2 삭제분 행 제거). 정리 후 `_archive/` 잔존 = README + 아래 보존 2건뿐.

---

## 데모 시드 — 전량 삭제 (승인됨, 한 단위로 함께)

per-run 격리(`runs/<id>/inputs/`) 도입 후 공유 씨앗 시드는 낡은 컨벤션이다. 재검증 결과 **살아남는 파일은 이들을 참조하지 않는다**(상호 참조만 존재 → 함께 지우면 안전).

| 경로 | 인바운드(전부 삭제-대상) |
|---|---|
| `core/inputs/wb-ezderm-acne.md` | `_archive/ezderm-acne-test-record.md`(삭제대상) |
| `core/inputs/wb-ezderm-relief-mp1.md` | 없음 |
| `core/inputs/wb-ursa.md` | 없음 |
| `core/inputs/wb-ursa-lineup.md` | 없음 |
| `core/inputs/assets-ursa/` (10) | `bundle-ursa/product.json`·`bundle-ursa-lineup/product.json`(둘 다 삭제대상) |
| `core/inputs/bundle-ursa/{product.json,reviews.csv}` | 없음 |
| `core/inputs/bundle-ursa-lineup/{product.json,reviews.csv}` | 없음 |

> ⚠️ 이름이 비슷한 `core/inputs/wb-ezderm-relief.md`(=mp1 아님)는 **활성 테스트 픽스처**라 삭제 금지(아래 보존 표).

---

## Tier 3 — 범위 밖 (삭제 보류, 별도 정책 결정)

| 경로 | 왜 보류 |
|---|---|
| `core/prompts/kcia-critic.md` | 로컬 크리틱은 폐기됐지만, `AGENTS.md` **1번 규칙**이 이 파일을 '적대 스탠스(근거부족 기본 + SIGNAL_RULES deny-list)' SSoT로 명시하고, `packs/{cosmetic,drug}/domain.json`·`regulatory-domains.json` 이 `critic_prompt: "prompts/kcia-critic.md"` 로 지목한다. `critic_prompt` 필드를 읽는 코드는 현재 없지만(정의만 됨), 삭제는 안전규칙+팩설정 4곳+살아있는 문서 5곳을 건드리는 **정책 리팩터**다. 크루프트 정리가 아니라 별도 과제로 다룬다. |

---

## 절대 보존 (함정 — 삭제처럼 보이나 실행에 필요)

| 경로 | 기능 근거(확인) |
|---|---|
| `core/harness/regulatory-domains.json` | `kcia_engine.py:223` 가 packs 부재 시 `load_json(LEGACY_REGISTRY)` 로 실제 로드(폴백 레지스트리) |
| `core/inputs/working-backwards.md` | `ingest-bundle.sh:47` 운영 기본 WB(`${HARNESS_WB:-…/inputs/working-backwards.md}`) — 테스트 픽스처가 아니라 운영 기본 씨앗 |
| `core/inputs/wb-ezderm-relief.md` | `test-relief-facts.sh:10` 활성 픽스처(`RELIEF_WB`) |
| `core/inputs/assets/` (23) | `ingest-bundle.sh:45` 기본 `ASSETS_DIR`, 런으로 복사 + golden `baseline-manifest.json` 계약 |
| `core/docs/keyvisual-label-corruption-improvement-plan.md` | `_archive` 아님 — 진행 중 개선계획(`test-render-mode-gate.sh`·`check_render_refs.py` 참조) |
| `core/docs/_archive/README.md` | 아카이브 자기-매니페스트(삭제 아님 — Tier1·2 반영해 정리) |
| `core/docs/_archive/in-session-generation-proposal.md` | 설계근거 SSoT(genmode 제어흐름 역전; `run-stage.sh:232` 주석이 근거로 인용) |
| `core/docs/_archive/orchestration-architecture-decision.md` | 파일기반 단계-게이트 영구 ADR |

---

## 부수 발견 (본 정리 범위 밖, 참고)

- `core/scripts/lib/adk_critic.py:9` docstring 이 존재하지 않는 `docs/adk-critic-build-plan.md` 를 가리킨다(이미 dangling — 본 정리와 무관, 별도 정리 후보).
- 루트 `README.md:32` 의 `[REFACTORING-PLAN.md](REFACTORING-PLAN.md)` 링크는 루트 상대라 현재도 실파일과 어긋난다(REFACTORING-PLAN 은 `core/docs/_archive/` 에 있음). Tier 2 에서 이 링크를 제거한다.

---

## 권장 실행 순서

1. **Tier 0 부산물**을 작업트리에서 `rm` — 위험 0, git 영향 없음.
2. **Tier 1 (12건) + 데모 시드**를 `git rm` — 살아있는 문서/코드가 안 가리키므로 바로 삭제. 같은 커밋에서 `_archive/README.md` 매니페스트 표와 '현행문서' 문단을 정리.
3. **Tier 2 (15건)**은 파일 삭제와 인용정리를 **한 커밋**으로 — 기능 코드는 손대지 말고 문서 인용 링크·코드 주석 문구만 제거. `AGENTS.md` 2번 절·`workflow-ssot.md`·루트 `README.md:32` 는 특히 꼼꼼히.
4. **Tier 3 (kcia-critic.md)**는 이번 정리에서 제외 — 로컬 크리틱 완전 폐기를 별도로 결정할 때 `critic_prompt` 4곳 + `AGENTS.md` 1번 규칙과 함께 처리.
5. **보존 표는 절대 손대지 않는다** — 특히 `regulatory-domains.json`(레거시 폴백)·`working-backwards.md`(운영 기본)·`wb-ezderm-relief.md`(픽스처)는 삭제처럼 보여도 실행에 필요.

## 고지

본 문서는 자율·비법적 사전 정리 계획이며, 실제 삭제 실행 전 사람 승인이 필요하다. 각 참조가 '주석/문서 링크(비기능)'라는 판정은 grep 재검증 기준이며, 실행 시 삭제 후 `bash core/tests/run-ci.sh`(회귀 스위트)로 재확인한다.
