# 메타프롬프트 — 통합 실행 계획 진행 (/goal + /dev-loop)

> 새 세션에서 아래를 순서대로 쓴다. 실행 계획 SSoT = `core/docs/ops-and-pack-refactor-plan.md` · 작업 루트 = `core/` · 팩은 레포 루트 `packs/`(core 형제).
> ⚠ 부록D 열린 결정 4건은 권고안대로 **확정됨**(D-1 retry 기본 8 · D-2 Pro 유지+순차 규율 · D-3 가드 예외 없음 · D-4 게이트 완화 없음).

---

## A. 현재 진행 상태 (체크포인트 2026-07-07) — **여기서 이어서 한다**

**완료·main 병합됨** (main tip = `d788ef9`):
- ✅ **1부 (O-1~O-9)** — 운영 개선. 브랜치 ops/o-items → main.
- ✅ **2부 선결: verify-baseline 재캡처** — 0단계 재캡처가 c822d2a 에서 **누락**(커밋 메시지만·매니페스트 미갱신)돼 59커밋 stale RED 였다. `capture-baseline.sh` 로 재캡처 → 골든 **190항목**(현 bundle-cosmetic) · verify-baseline 그린. (`46d3812`)
- ✅ **2부 1단계** (레지스트리 일원화·cosmetic 폴백 전수 소거) — 별칭 팩 이관·11지점+α fail-closed·레거시 철거(regulatory-domains.json 삭제)·미등록 안내(등록 팩 목록+온보딩)·B3 인라인 골든셋 도메인 명시. verify-baseline 190 바이트 불변 실증. (`c43b8e3`·`a08f9c0`·`c734af6`·`e33dc56`·`d788ef9`)

**진행 중 (브랜치 `refactor/pack-stage-2`, main 미병합)** — 2부 2단계의 절반:
- ✅ 커밋 a (`345ab2a`): `consumer_deception_severity_high`(18항목) → `packs/cosmetic/ruleset.json` axes.lexicon.
- ✅ 커밋 b (`59b1556`): 화장품 어휘 상수 공집합화(FUNC_EFFICACY·CONDITION_TARGET·PHARMA_AUTHORITY·CONSUMER_DECEPTION_SEVERITY_HIGH·zero_voc 인라인·_MI_SIG_LEGACY) + examples_analysis 우회로 제거.
- 검증(바이트 불변): verify-baseline 190 · b3 18/0(심의 골든셋) · test-examples-analysis 12/0 · core-domain-leak 2/0. **a+b 전체 CI 확인됨(2026-07-07): 선재 4건(critic-fanout drug ADK 3 · b4 1)뿐 · 신규 델타 0 = 클린.** 재개 시 재실행 불필요(원하면 재확인만).

**⏸ 2부 2단계 잔여 (다음 착수점 — 정찰상 리팩토링 전체 최고 드리프트 위험):**
1. **임상 실증 정책 팩화**: 정본 disclaimer `"개인에 따라 차이가 있을 수 있습니다"`(kcia_engine.py `CLINICAL_DISCLAIMER` :449) + 표기 정규식(`_block_shows_context` :462~) → 룰셋 확장 키(`axes.clinical_substantiation.*`, axes 는 additionalProperties:true 라 스키마 무변경). **함정**: `_block_has_disclaimer`(:452)·`_block_shows_context` 는 **모듈 함수라 ruleset 미접근** → 시그니처에 disclaimer/정규식을 스레딩해야 함(호출부 :533·:1279·:1306, 전부 Engine 메서드 안이라 self.rs 보유). **byte-frozen 중복 주의**: adk_critic.py `_build_passa_instruction`(:565, 한국어 prose — test-prompt-assembly 골든) · stub_stage.py(:693 disclaimer **리터럴** — stub 골든) · operator_labels.py(:189-193 라벨) · completeness_advisor.py(:83-88 `_req_flags`/`order`, 스펠링 다름: measured_pair/institution/sample_size/duration). 5요소 `satisfied_when`은 **이미 룰셋 존재**(cosmetic ruleset.json:54). ⚠ 각 이동은 반드시 **개별 바이트 검증**(verify-baseline·test-drug-stub-golden·test-prompt-assembly·test-completeness-advisory·b3).
2. **author 슈퍼셋 → domain.json**: adk_critic.py:217 `known = {author} | {"guideline_review_agent","cosmetics_review_agent","pharma_review_agent"}`. cosmetics/pharma_review_agent 는 이미 각 domain.json `adk_critic.author` 와 중복 — **`guideline_review_agent` 만 무주지**. domain.json adk_critic 에 `author_aliases`(배열) 신설 + guideline 홈 지정. offline 무영향(online 전용) → **온라인 카나리**(실 ADK)로 확인.
3. 완료 후: workflow-ssot 동반 갱신 → 전체 CI(선재 4건만) → **2단계 전체를 main 병합**(a+b+잔여 한 단위).

---

## B. 2부 2단계 잔여 이어서 실행 (dev-loop 1회)

```
/dev-loop core/docs/ops-and-pack-refactor-plan.md 를 읽고 2부 2단계의 잔여(임상 실증 disclaimer·표기 정규식 팩화 + author 슈퍼셋 domain.json 이관)를 완결하라. 전제: 브랜치 refactor/pack-stage-2 에 커밋 a(345ab2a)·b(59b1556) 이미 있음(어휘 lexicon 이동 완료·바이트 검증됨). 먼저 a+b 전체 CI 를 돌려 "선재 4건(critic-fanout drug ADK 3·b4 1)만"인지 확인하라. 잔여는 리팩토링 최고 드리프트 위험 — 정찰(계획서 2단계 잔여 메모·resume A절)의 함정(모듈함수 ruleset 미접근·byte-frozen adk_critic 지시문/stub_stage 리터럴/operator_labels 라벨/completeness_advisor 스펠링)을 반드시 반영하고, 각 값 이동마다 개별 바이트 검증(verify-baseline·test-drug-stub-golden·test-prompt-assembly·test-completeness-advisory·b3·심의 골든셋)을 하라. author 이관은 온라인 카나리(실 ADK 호출, .env 자격 존재)로 확인. workflow-ssot 동반 갱신·계획서 2단계 완료 표시 후, 전체 CI(선재 4건만) 확인하고 2단계 전체를 main 병합하라. 브랜치: refactor/pack-stage-2 계속.
```

## C. 2부 3~9단계 + 3부 (단계당 dev-loop 1회 — 세션 분리 권장)

```
/dev-loop core/docs/ops-and-pack-refactor-plan.md 를 읽고 2부 N단계만 실행하라(N=3..9). 전제: N-1단계 병합·그린(계획서 완료 표시 확인). 착수 시 그 단계의 파일:줄 인용을 심볼 기준으로 재확인하라(줄번호 흘렀음). 공통 원칙 1~7 준수 — 특히 이동 커밋/배선 커밋 분리·값 불변. 정밀 정찰은 Explore subagent 에 위임해 컨텍스트를 아껴라. 검증 = 그 단계 검증 절 순서(타겟 → 골든 → 전체 CI) + 누출 grep allowlist 점감. workflow-ssot 동반 갱신 후, 계획서 해당 단계에 완료 표시·실측 메모 남기고 병합·보고하라. 브랜치: refactor/pack-stage-N.
```

3부(온보딩 2차)는 2부 완료 후 계획서 3부 절대로.

---

## D. 규율·함정 (이 세션에서 실증된 교훈 — 반드시 준수)

1. **커밋 전 스테이징 반드시 확인**: `git add A B C` 에 **하나라도 잘못된 pathspec**(예: 이미 git rm 된 파일)이 섞이면 git add 가 **atomic 실패 → 아무것도 스테이징 안 됨**. 이 세션에서 Commit B 코드 14파일이 이렇게 누락됐다(CI 는 워킹트리를 읽어 통과 → HEAD 엔 코드 없음). **매 커밋 직후 `git status --porcelain` 으로 의도한 파일이 첫 컬럼(스테이징)에 있는지 확인**하고, `git show HEAD --stat` 로 커밋 내용 검증.
2. **바이트 불변 = verify-baseline(190항목) 이 정본 안전망**. 선언 도메인 런은 값이 룰셋으로 옮겨가도 `_lex(ruleset,key,상수)` 가 룰셋 값을 반환해 불변. 미선언만 fail-closed. 스텁은 build_context 미사용 → 프롬프트 변경은 verify-baseline 에 안 나타남(프롬프트 조립 골든이 안전망).
3. **선재 CI 실패 4건**(clean main 과 동일): `critic-fanout` drug ADK-미구현 3건 + `b4` storyboard 1건. 이건 델타 아님(환경 아티팩트) — 신규 실패만 내 회귀로 판정. 확신 없으면 `git stash` 로 clean 대조.
4. **CI 실행 중 코드 파일 편집 금지**(테스트가 워킹트리를 라이브로 읽어 불일치). 문서(.md)·계획서는 CI 중 편집 안전.
5. **오래 걸리는 작업(전체 CI·capture-baseline·심의)은 백그라운드+Monitor**(포그라운드 단일 툴콜 = watchdog 사망). 완료 마커: `grep RUNCI_EXIT= /tmp/*.log`.
6. **골든 재캡처(capture-baseline)는 결과 큰 행위** — 사람 확정 후에만. verify-baseline 이 stale 이면 원인부터 진단(이 세션: 0단계 재캡처 누락).

## 참고: 최초 세션 목표 고정(이미 설정됨)

```
/goal core/docs/ops-and-pack-refactor-plan.md(통합 실행 계획)를 순서대로 완주한다 — 1부 운영 개선(O-1~O-9) → 2부 팩 분리 1~9단계 → 3부는 별도. 규율: 한 단계 = 분리→테스트→검증→병합의 독립 완결, 이전 단계 그린 전 다음 착수 금지, 커밋마다 변경분 CI(bash tests/run-ci.sh) 그린.
```
