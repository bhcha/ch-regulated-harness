# 메타프롬프트 — pack-refactor-plan.md 1차 이어하기 (fresh session)

> 세션 클리어 후 이 파일 내용을 첫 메시지로 붙여넣거나, "core/docs/pack-refactor-resume-prompt.md 읽고 이어서 진행" 이라고 지시.
> 작성 2026-07-03 (직전 세션 핸드오프).

## 목표
`core/docs/pack-refactor-plan.md` 의 **1차(팩 분리·동작 불변) 9단계**를 실행한다. 그 문서가 실행 계획 SSoT다. 도메인 지식을 core(커널)에서 packs(팩)로 퇴거시키되 **바이트 단위 동작 불변**이 원칙. (2차 온보딩은 1차 완료 후 별도.)

## 리포지토리
`/Users/chabh/workspace/ch-regulated-harness` · 운영 루트 = `core/` · 브랜치 `main`.

## 이미 완료·병합됨 — 다시 하지 말 것
- **RCA 7·8** (`core/docs/refactor-quality-regression-analysis.md`): 금지블록 게이트·가격 값-대조 가드·모델-인지 이미지 라우팅·workflow-ssot 동반갱신. 커밋 `9758226`/`78db82f`/`6888160`, merge `38fc2c4`. 실런 검증 완료(`runs/ezderm-relief-verify-0703` done — runs/ 는 git-ignored라 골든 영향 없음).
- **pack-refactor 0단계 7항목 중 1개만**: 누출 grep 테스트 `core/tests/test-core-domain-leak.sh` (merge `b850f57`, run-ci 배선됨, allowlist 14파일→목표 0, 현재 green). ⚠ **plan 문서의 0단계 체크박스는 아직 미갱신** — 이어하는 세션이 완료 항목에 완료표시부터.

## 이어하기 지점 = 0단계 나머지 (plan 3장 "0단계")

### 먼저: 부록C 열린결정 4건 확정 (plan 부록C — "실행 전 사람 확정 필요")
직전 세션이 사람 부재로 plan 권고안을 잠정 채택했으나 **정식 미확정**. 첫 작업으로 사람에게 확정받을 것(또는 아래 채택안 진행 재확인):
1. **번들 전략**: (a) 합성 번들 커밋 + 베이스라인 재캡처(자립) [권고·잠정채택] / (b) 구 워크스페이스 사본 복원만
2. **`ezderm-relief-provided.webp`**: 화장품 시드로 유지(이미 main 커밋됨)·0단계 동결 [잠정채택]
3. **자산 교차오염 교정 시기**: 1차 7단계 커밋b [권고·잠정채택] / 2차 이월
4. **drug 골든 범위**: 1차=현행 동작(escalated) 동결, done-골든은 2차 [권고·잠정채택]

### 환경 아티팩트 (0단계 전제 — 실측 확인됨)
- 크롤 테스트 번들 `core/naver_10910275313_20260617-1331` **부재**(.gitignore `naver_*/`) → `verify-baseline.sh` 즉사, `run-ci.sh` 20개 스위트 실패(전부 이 원인, RCA 병합 시 회귀 0로 확인됨). 부록C 결정1(합성 번들)이 이걸 처방. **0단계 최우선.**
- `core/inputs/examples/cosmetic` 존재 → ingest 를 00g-guideline 로 라우팅해 CI 오염(memory `ci-examples-pollution`). 0단계에서 처리.

### 0단계 남은 항목 (plan 3장 0단계 체크리스트 순서)
- [ ] **번들 복구 2박자**(부록C 결정1): 합성 product.json+reviews.csv+플레이스홀더 이미지 fixture 커밋 → 기본값 전환 → 베이스라인 1회 재캡처(**비가역 골든 재작성 — 사람 확인 후 진행**). `tests/lib.sh:14` `TEST_BUNDLE` 기본값 대상.
- [ ] **`ezderm-relief-provided.webp` 0단계 동결**(부록C 결정2 — 이미 커밋). own_assets 전수수집(`ingest.py:367-371`)이라 골든 포함.
- [ ] **drug 부분 골든 신설**(부록C 결정4): `build-fixtures.sh` 파라미터화(도메인·WB·번들, `fixtures/<도메인>/<boundary>-in` + `tests/lib.sh` seed_fixture). 현행 escalated 동작 동결. 커밋 가능한 합성 drug 시드 별도 제작(ursa 런은 insession 실엔진이라 골든 씨앗 불가).
- [ ] **프롬프트 조립 골든 신설**: 각 단계 `run-stage.sh <stage> <id> --emit-context` 출력 + `prompts/*.md` 해시 + 원격 ADK Pass-A/B 지시문 조립 텍스트(`adk_critic.py`). `$HARNESS_ROOT`·RUN_ID 정규화. (2·5단계 문구 이동의 유일 안전망.)
- [ ] **`kcia-golden-set.json` 도메인 명기**: `regulatory_domain:"cosmetic"` 추가(현재 0건 실측 — 1단계 폴백 소거 시 깨짐). **값-불변 원칙의 명시적 예외로 기록.**
- [ ] **pack-lint 뼈대 + 팩 스키마 검증 테스트**: `packs/*/ruleset.json` 은 `registry.json:30` 스키마 매핑만 있고 검증 테스트 0건(공백). 바이트 무영향.
- [x] 누출 grep 테스트 — **완료**(위).

**0단계 증명**: 기존 전체 테스트 그린 + 재캡처 후 신규 베이스라인 verify 그린 + 신규 골든 3종 자체가 산출물.

## 그 다음 = 1차 1~9단계 (plan 3장 상세 — 각 단계 파일:줄·함정·증명 명시)
1. 레지스트리 일원화·cosmetic 폴백 전수 소거(확정 11지점 — plan 1단계에 나열) + 레거시 철거
2. 심의 어휘·실증 정책 퇴거(커밋 a 이동 → 커밋 b 배선/소거; `CONSUMER_DECEPTION_SEVERITY_HIGH` 19항목 팩 부재 주의; 온라인 카나리)
3. 인입 팩화(ingest-profile/bundle-profile; 비화장품 3도메인 bp_hints 상속 함정 → drug 골든 전제)
4. **캐논 단일화(최대 작업)**: canon.json 정본1개(stub CANON + validate enum + canon-components 흡수); enum→패턴+카탈로그 대조; 무음 폴백 fail-closed 화
5. 생성 표면 팩화(프롬프트 조각·critic-fragment·stub-templates); run-stage 죽은 히어독 제거
6. 디자인·이미지·export·운영 라벨(design-tokens·labels 오버레이; 폰트·export 경로 불변)
7. 샘플·자산·examples 퇴거(커밋 a 경로만 동결 → 커밋 b 교차오염 교정+재캡처)
8. 팩별 테스트·골든·fixtures 선언 + 팩 적합성 스위트
9. 마무리 검수(누출 allowlist 0 달성, 문서 정합)

## 불변 규율 (plan 1장 — 매 단계 적용)
- **6박자/단계**: 어댑터 계약 → 팩에 현행값 **그대로** 착지 → core 배선 교체 → core 상수/폴백 제거 → 골든·테스트 증명 → 문서 동반 갱신. **값은 옮기기만, 내용 절대 불변**(교정은 2차 이월 5장).
- **커밋 분리**: "순수 이동(값불변)" 커밋 vs "메커니즘 변경(배선·스키마 완화)" 커밋 분리(회귀 원인 판별).
- **증명 4종**: ① 스텁 바이트 골든 ② 프롬프트 조립 골든 ③ 심의 골든셋 ④ 누출 grep(allowlist→0). 온라인 전용 경로(ADK 지시문·author)는 골든 사각 → 해당 단계 실 ADK 1회 카나리.
- **workflow-ssot.md 단계마다 동반 갱신**(AGENTS 4번 절 — 몰아치기 금지).
- **누출 테스트 allowlist 점감**: 파일이 packs 로 비면 `test-core-domain-leak.sh` ALLOW 에서 제거(9단계 0).
- **stub 렌더 환경 고정**: 베이스라인 골든에 Playwright PNG 포함 → 진행 중 머신·브라우저 버전 불변.
- **회귀 판정법(RCA 병합 때 사용)**: 크롤번들 부재로 CI 가 20개 실패 상태이므로, main 베이스라인 실패집합과 브랜치 실패집합을 비교해 **동일 = 회귀 0**. (0단계에서 합성 번들이 들어오면 이 마찰 해소.)

## 실행 방식 권고
`/dev-loop`(계획→분해→병렬 Opus 구현→단계별 Codex 리뷰, critical/high 0까지 루프) 또는 단계별 서브에이전트 + Codex 리뷰. 각 단계 독립 브랜치 → `--no-ff` main 병합(레포 관행). **비가역 단계(베이스라인 재캡처)는 사람 확인 후.**

## 필독 문서
- `core/docs/pack-refactor-plan.md` — **실행 SSoT**(단계별 파일:줄·함정·증명)
- `core/AGENTS.md` — 규칙 SSoT
- `core/docs/workflow-ssot.md` — 워크플로우 정본(동반 갱신 대상)
- `core/docs/multi-domain-build-plan.md` — 선행 "C 메커니즘"(enum→패턴+레지스트리, 4단계가 복제)

## 참고: 직전 실런 검증에서 나온 후속거리 (RCA/pack-refactor 범위 밖 — 별도 판단)
- Nano Banana **Pro 분당 rate limit(429)** — 코드에 백오프 부재(RCA 7-3 드리프트 지적). 멱등 재시도로 회복.
- **증분 매니페스트 기록** — 부분 생성 실패 시 매니페스트 미기록 → 렌더 fail-closed 마찰(정상이나 개선 여지).
- **화장품 정성-임상 clinicalEvidence 게이트 긴장** — 정량 임상 없는 화장품은 실증 게이트 만족이 까다로움.
