# docs/_archive — 완료된 계획 · 이력 문서

여기 있는 문서들은 **구현이 끝났거나(완료 계획) 역사적 의사결정 기록**이라 `docs/` 최상위에서 내려 보관한 것이다. 삭제하지 않은 이유: 설계 근거·결정 이력의 추적성. **현행 작업의 SSoT 아님.**

> 2026-06-21 정리. 상대 링크가 일부 깨질 수 있음(한 단계 위로 이동) — 이력 보존용이라 본문 링크는 손대지 않았다.
> 2026-07-01 정리(2차). 문서 감사로 '완료(shipped)·폐기(대체됨)' 9건을 추가 보관 — inbound 경로링크(AGENTS.md·workflow-ssot·pipeline-stage-definitions)는 `docs/_archive/` 로 갱신했다(dangling 없음).
> 2026-07-02 정리(3차). **비운영 이력·완료계획 정리(cleanup-plan).** 완료·폐기된 계획서·실증 주행기록 다수를 삭제하고, 살아있는 문서·코드 주석의 인용 문구를 같은 정리에서 함께 제거했다(dangling 없음, 기능 코드 불변). 남은 아카이브 = 설계 근거 SSoT 2건 + 이 정리의 확정 목록(cleanup-plan.md).
> 2026-07-06 정리(4차). **완료된 계획·재개프롬프트 8건 보관.** BM 디자이너 핸드오프(P-1~P-5)·첨부 통합 인입(W-1~W-4)·다제품 추출 경계(M-1~M-3) 등 구현 끝난 계획서와 세션 재개/핸드오프 프롬프트를 `docs/` 최상위에서 내렸다. 유지파일(evidence-content-integration-plan)의 inbound 인용 1건은 `_archive/` 경로로 갱신(dangling 없음). 이동대상 간 상호참조·`workflow-ssot-history.md`(raw 이력 로그)의 설계 SSoT 포인터는 이력 보존용이라 그대로 둔다.
> 2026-07-07 정리(5차). **통합 계획 승계.** E2E 운영 결함 관찰(e2e-operational-findings)과 팩 분리 원계획(pack-refactor-plan, 0단계 완료 이력)을 `docs/ops-and-pack-refactor-plan.md` 통합 실행 계획으로 합치고 원본 2건을 보관(각 문서 머리에 승계 배너). inbound 참조 1건(tests/test-core-domain-leak.sh 주석)은 새 경로로 갱신(dangling 없음).
> 2026-07-08 정리(6차). **구현완료 계획 4건 보관(D-1 문서 다이어트 · 병렬 lcd-track).** 근거 문서 첨부(evidence-attachment-plan, `e0b8ca9`+회귀 2종)·키비주얼 이미지 안전 F1/F2/F3(keyvisual-image-safety-fixes-plan, `7c7f49a`)·BM 디자이너 핸드오프 G-A/G-B(bm-designer-handoff-plan, `665318c`+Wave1~5)·근거 내용 반영 통합(evidence-content-integration-plan, `e0b8ca9` 반영강제+`test-evidence-reflection` 회귀; 헤더 '구현 대기'는 스테일)는 main 에 구현·검증 완료라 보관. inbound 링크 갱신(allowed surface): evidence-content-integration-plan(1 링크)·pipeline-stage-definitions(5 경로) → `_archive/`. ⚠ **미갱신(트랙 격리상 무접촉 대상)**: `workflow-ssot.md`(설계 SSoT 포인터)·코드 주석(image_engine·completeness_advisor·check_render_refs)·프롬프트(storyboard-plan·keyvisual)·테스트 주석·history 로그의 경로 인용 — 전부 주석/프로즈/inline-code(기능 무관·비-링크)라 아무것도 안 깨지며, 최종 main 통합 시 일괄 갱신 예정. 코드·골든 무영향.
> 2026-07-10 정리(7차). **완료·소임완료 계획 9건 보관(SSoT 문서 분할 후속).** core/docs 4건(maintainability-refactor-plan[post-pack 승계·구현완료]·post-pack-cleanup-plan[K-1~K-5 main 병합]·keyvisual-label-corruption-improvement-plan[F1~F3·image-guards 구현완료+디자이너핸드오프로 설계 승계]·ops-pack-resume-prompt[소임완료]) + **레포 루트 5건**(병렬 트랙 오케스트레이션 스크래치: fix-plan-intake-defects[A-DEF-1/2 종결]·meta-deferred-lcd·meta-parallel-lcd·parallel-run.goal·track-b-cleanup-impl[kernel-track 병합])을 `docs/_archive/`로 내렸다. `track-a-e2e-validation.md`(루트 — 팩분리 E2E 검증 지시서)도 사용자 확인 후 아카이브(E2E 실런 2건 done·결함 2건 수정 확인, 최종 보고서는 세션 트랜스크립트에만 존재). 유지(현행)=ops-and-pack-refactor-plan(3부 온보딩 미착수)·multi-domain-build-plan(의약외품/건기식 자료 대기)·ci-cost-and-target-map(계측 참조 스냅샷). 이동 문서 상호 링크·history 로그 경로 인용은 이력 보존용이라 그대로 둔다(선례). 코드·골든 무영향.

| 문서 | 무엇 | 상태 |
|---|---|---|
| `pack-refactor-plan.md` | 팩 분리 1차·2차 원계획(0단계 완료 이력·실측 메모) | ♻️ 승계(5차 → `docs/ops-and-pack-refactor-plan.md`) |
| `e2e-operational-findings.md` | E2E 실런 2건 운영 결함 관찰(O-1~O-9 증상 원문) | ♻️ 승계(5차 → 동일 통합 계획 1부) |
| `in-session-generation-proposal.md` | in-session 생성 모드 제안서·결정기록(설계 근거 SSoT) | 📌 근거 |
| `orchestration-architecture-decision.md` | 파일기반 단계-게이트 정당성 ADR(영구 기록) | 📌 영구 |
| `cleanup-plan.md` | 비운영 파일 정리 계획(3차 정리의 확정 목록·근거) | ✅ 실행완료(2026-07-02) |
| `bm-designer-handoff-fixes-plan.md` | BM 디자이너 핸드오프 E2E 결함수정(P-1~P-5) | ✅ 구현완료(4차) |
| `attachment-intake-plan.md` | 첨부 통합 인입 00a-intake(W-1~W-4) | ✅ 구현완료(4차) |
| `multiproduct-extraction-boundary-fixes-plan.md` | 다제품 WB 추출 경계(M-1~M-3) | ✅ 구현완료(4차) |
| `insession-default-build-plan.md` | in-session 생성 기본화 빌드계획 | ✅ 구현완료(4차) |
| `refactor-quality-regression-analysis.md` | 리팩토링 품질 회귀 분석(RCA 7·8) | ✅ 반영완료(4차) |
| `pack-refactor-resume-prompt.md` · `pack-refactor-resume-2-stage1.md` · `evidence-content-resume-G5-G7.md` | 세션 재개/핸드오프 프롬프트(완료) | ✅ 소임완료(4차) |
| `evidence-attachment-plan.md` | 근거 문서 첨부(시험성적서·결과보고서) 전송 설계 v10 | ✅ 구현완료(6차 · `e0b8ca9`) |
| `keyvisual-image-safety-fixes-plan.md` | 키비주얼 이미지 안전 F1·F2·F3(그래픽 게이팅·400 강등·크롭 제거) | ✅ 구현완료(6차 · `7c7f49a`) |
| `bm-designer-handoff-plan.md` | BM 디자이너 핸드오프 G-A(전 블록 이미지)·G-B(참고문서 이미지 추출) | ✅ 구현완료(6차 · `665318c`+Wave1~5) |
| `evidence-content-integration-plan.md` | 근거 내용 반영 통합(reflect:true 기본·done 게이트·export reflected_in) | ✅ 구현완료(6차 · `e0b8ca9`+`test-evidence-reflection`) |
| `maintainability-refactor-plan.md` | 유지보수 리팩토링 조사+처방(I/L/C/K/D 트랙) | ✅ 구현완료(7차 · post-pack-cleanup 승계) |
| `post-pack-cleanup-plan.md` | 팩분리 후속정리 1·3~6단계(K-1~K-5) | ✅ 구현완료(7차 · `18c16d6`·kernel-track `eec54f0`) |
| `keyvisual-label-corruption-improvement-plan.md` | 키비주얼 라벨/한글 변질 처방(P0-1~P1-1) | ✅ 구현완료(7차 · F1~F3 `7c7f49a`·image-guards `30e3601`; 이후 디자이너핸드오프로 설계 승계) |
| `ops-pack-resume-prompt.md` | 팩 리팩토링 2부 세션 재개 프롬프트 | ✅ 소임완료(7차) |
| `fix-plan-intake-defects.md` | intake 정문 결함 수정(A-DEF-1 도메인 배관·A-DEF-2 다품목 스코핑) | ✅ 소임완료(7차 · `4824dae`~`d6dc926`, 재스코핑 종결) |
| `meta-deferred-lcd.md` | 병렬 트랙 지연항목(L-1·D-2) 실행 메타프롬프트 | ✅ 소임완료(7차 · `5167b38`·`d85833c`) |
| `meta-parallel-lcd.md` | 병렬 트랙 무접촉항목(C-1·D-1) 메타프롬프트 | ✅ 소임완료(7차 · lcd-track `69c3fa4`) |
| `parallel-run.goal.md` | track A ∥ B 병렬 기동·통합 GOAL(일회성 오케스트레이션) | ✅ 소임완료(7차) |
| `track-b-cleanup-impl.md` | 후속정리 K-1~K-5 구현 트랙 지시서 | ✅ 소임완료(7차 · kernel-track `eec54f0`) |
| `track-a-e2e-validation.md` | 팩분리 E2E 실전 검증 지시서(감독관+현업 게이트 대행) | ✅ 소임완료(7차 · 실런 2건 done·결함 A-DEF-1/2 수정 확인) |
| `chat-gateway-split-plan.md` | 챗 게이트웨이 저장소 분리(헥사고날 어댑터 정렬 · S1~S8 · DoD) | ⛔ 미실행·보류(8차 · 모노레포 병합 선택 `2dd84cb`) — 되살릴 시 S1~S8·DoD 유효 |

**현행 문서**(docs/, 살아있음만 · 용도별 하위 폴더): **D-1 정본 5** = `README.md`(총지도, docs 루트) + `canonical/`{`workflow-ssot.md`(흐름)·`feature-catalog.md`(기능)·`pack-catalog.md`(팩)·`config-reference.md`(설정)}. **진행 중 계획 4** = `plans/`{`ops-and-pack-refactor-plan.md`(3부 온보딩 잔존)·`multi-domain-build-plan.md`(의약외품·건기식 자료 대기)·`chat-layer-plan.md`(챗 레이어 — main 병합 완료 `2dd84cb`·2차 이후 잔존)·`harness-skeleton-and-seams.md`(Seam C-2/F-2/C-4·SSoT 반영·E2E 잔존)}. **참조·스펙** = 현재상태 SSoT는 코드(상세 스냅샷 `snapshots/`{`pipeline-stage-definitions.md`·`harness-architecture.md`·`stage-contracts.md`} = D-1 강등, 갱신 의무 없음) + `reference/`{`harness-design`·`user-guide`·`deployment`·`ci-cost-and-target-map`(계측 스냅샷)·`workflow-diagram/`}. **파이프라인 소비 3건**(경로 결합) = core/docs/reference/{regulation/·design-tokens·canon-blocks}. **이력 raw** = `history/workflow-ssot-history.md`. 전체 분류·내비게이션 = `README.md`(총지도).
