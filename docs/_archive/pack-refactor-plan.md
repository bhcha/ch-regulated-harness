# 팩 분리 리팩토링 계획 — 1차(팩 분리·동작 불변) + 2차(온보딩)

> **♻️ 아카이브(2026-07-07):** 이 계획은 [`../ops-and-pack-refactor-plan.md`](../ops-and-pack-refactor-plan.md)(통합 실행 계획 — 1부 운영 개선 + 2부 팩 분리 1차 + 3부 온보딩 2차)로 **승계·대체**됐다. 0단계 완료 시점까지의 상세 이력(실측 메모·블로커 해소 경위) 보존용 — **현행 작업의 SSoT 아님.**

> **이 문서의 지위:** 도메인 지식을 core(커널)에서 packs(팩)로 퇴거시키는 리팩토링의 **실행 계획 정본**이다.
> 사람(차병환)과 합의된 목표·범위·단계·증명 방법·열린 결정을 담는다. 실행 중 각 단계가 끝나면 이 문서의 해당 단계에 완료 표시와 실측 메모를 남긴다.
> **관계:** 규칙 SSoT = [`../AGENTS.md`](../AGENTS.md). 워크플로우 정본 = [`workflow-ssot.md`](./workflow-ssot.md)(각 단계 변경 시 **같은 변경에서** 동반 갱신 — 이 계획의 공통 원칙 5). 다중 도메인 1차 일반화 이력 = [`multi-domain-build-plan.md`](./multi-domain-build-plan.md)(이 계획은 그 후속 — 심의 팩화에서 **전체 상세 로직 팩화**로 확장). 비운영 파일 정리 이력 = [`_archive/cleanup-plan.md`](./_archive/cleanup-plan.md)(보존 판정 2건을 본 계획이 승계·재판정 — 부록B).
> **근거:** 이 계획의 모든 파일:줄 인용은 2026-07-02 레포 실물 조사(영역별 병렬 정독 + 적대 검증 2회, 실행 재현 포함)로 확인된 값이다.
> 작성 2026-07-02 · **갱신 2026-07-03**: 부록C 열린 결정 4건 사람 확정(전부 권고안 채택) · 0단계 착수(누출 grep 테스트 완료·병합)
> 상태: **계획 확정 · 0단계 진행 중**

---

## 0. 목표와 확정 사항

### 최종 그림

- **커널(core)** = 큰틀만: 페이즈 라우트 + "생성 → 사람(선택/승인) → 심의 → 전이" 4박자 게이트 상태기계 + 엔진 골격(검증기·심의 전송·렌더러·인입 파서). 도메인·포맷·블록 이름을 하나도 모르고, 팩이 준 카탈로그를 읽기만 한다.
- **팩(packs)** = 적용되는 기준 전부: 말할 수 있는 것(룰셋·어휘·실증 정책), 만드는 구조(캐논 블록 카탈로그 — **도메인×포맷 조합 단위로 통째 교체 가능**), 생성 재료(프롬프트 조각·예시·톤·디자인 토큰), 입력 계약(WB 템플릿·VOC 소스·ingest 프로파일), 자기 외부 연동 선언(env 간접 참조 — `adk_critic` 패턴의 일반화), 검증 동반물(테스트·골든·fixtures·stub 템플릿).
- **온보딩(2차)** = 새 팩을 만들어 끼우는 진입로. 운영 구조는 현재와 동일하게 유지되고, 온보딩 대화("산출물은 무엇을 만드실 건가요?" 등)의 답이 곧 새 팩 파일이 되어 코드 수정 없이 꽂힌다. 온보딩 = 팩 생성기(스캐폴더)이지 런타임 기능이 아니다.

### 사용자 확정 사항 (2026-07-02 합의)

1. **미선언·미등록 도메인 = fail-closed** + "등록된 팩 목록 + 새 유형이면 온보딩으로 만들어보세요" 제안. cosmetic 암묵 기본값 전부 폐지.
2. **1차 목표 = 팩으로 분리해서 현재와 동일하게 돌아가는 것**(바이트 단위). 테스트·골든·fixtures 는 1차에 반드시 포함 — **각 팩이 자기 테스트·골든·fixtures 를 선언**한다.
3. **캐논은 도메인×포맷 교차 산물** — 15블록은 "화장품×상세페이지" 조합의 값일 뿐, 의약품 상세페이지는 블록 세트 자체가 다를 수 있다. RTB 좋은점/나쁜점 등 모든 판정 기준이 팩 설정.
4. **멀티테넌시 = 팩별 API·외부 서비스를 .env/설정으로 격리**(`adk_critic` 패턴: 팩이 env 이름만 선언, core 는 해석, 값은 .env). 고객사 축 팩 신설이 아님. 대웅/이지듀 샘플은 화장품 팩의 샘플·픽스처로 팩과 함께 이동.

---

## 1. 공통 원칙 (1차 전 단계 적용)

1. **각 단계의 6박자**: 어댑터 계약 정의 → 팩에 현행 값 **그대로** 착지 → core 배선 교체 → core 상수/폴백 제거 → 골든·테스트 증명 → 문서 동반 갱신. **값은 옮기기만 하고 절대 바꾸지 않는다.** 내용 교정(예: drug 패키지명)은 "2차 이월 목록"(5장)에 적는다.
2. **커밋 분리 규율**: "순수 이동(값 불변)" 커밋과 "메커니즘 변경(배선 교체·스키마 완화)" 커밋을 분리한다 — 회귀 원인 판별 가능해야 한다.
3. **증명 도구 4종**:
   - ① 스텁 바이트 골든(`HARNESS_OFFLINE=1` 결정적 파이프라인 → `baseline.py` 매니페스트, run-상대경로 키 214항목)
   - ② 프롬프트 조립 골든(0단계 신설 — `--emit-context` 출력 + prompts/*.md 해시 + 원격 ADK Pass-A/B 지시문 조립 텍스트, 절대경로 정규화)
   - ③ 심의 골든셋(`golden_runner.py` 검출률·오탐률)
   - ④ core 도메인 어휘 누출 grep 테스트(0단계 신설 — allowlist 점감, 최종 0)
4. **온라인 카나리**: 원격 ADK 지시문·author 등 온라인 전용 경로(오프라인은 ADK resolve 자체를 건너뜀)는 위 골든 전부의 사각지대다. 해당 변경이 있는 단계는 실 ADK 1회 호출 확인을 절차화한다.
5. **`workflow-ssot.md` 동반 갱신은 단계마다** 같은 변경 단위에서 수행한다(AGENTS 4번 절 의무 — 마지막에 몰아치기는 규칙 위반 상태를 단계 내내 지속시킴).
6. **stub 렌더 환경 고정**: 베이스라인 골든에 Playwright 렌더 PNG가 포함되므로, 1차 진행 중 머신·브라우저 버전을 바꾸지 않는다(거짓 알람 방지).

---

## 2. 목표 팩 레이아웃 (1차 완료 시점)

```
packs/
  <도메인>/                  # 규제도메인 팩 (예: cosmetic, drug, quasi_drug, health_food)
    domain.json              # 레지스트리 엔트리: 라벨·법·aliases(1단계 신설)·status·adk_critic(env 간접 선언)·author
    ruleset.json             # 심의: 축 내용·lexicon(누락 키 2단계 보강)·실증 정책(임상 5요소·정본 디스클레이머)·필수기재
    ingest-profile.json      # 인입: VOC/페르소나 키워드·옵션 정규식·기능성 라벨·승인/실증/인증 마커·bp 힌트 (3단계)
    bundle-profile.json      # 크롤 번들 필드 매핑·자사 호스트 정책 (3단계)
    prompt-fragments/        # 생성 프롬프트 도메인 조각(예시·축 프리셋·금지어 예문) (5단계)
    critic-fragment.md       # 심의 프롬프트 도메인 조각(축 판정 예시) (5단계)
    canon/<포맷>.json        # (선택) 캐논 도메인 변형 — 조합 단위 전체 교체. 1차엔 규약만, 실사용은 2차
    labels.json              # 운영 라벨 오버레이 (6단계)
    stub-templates/          # 결정적 stub 콘텐츠(카피·축 세트) (5단계)
    samples/                 # WB 샘플·자사 자산 시드 (7단계)
    examples/                # 유사사례 (7단계)
    golden/                  # 심의 골든셋·추출 기대표 (8단계)
    fixtures/                # 단계 핸드오프 픽스처 (8단계)
    sources/                 # 규제 원문 (기존 유지)
  _format/                   # 산출물 포맷 팩 (규제도메인과 직교)
    format-profiles.json     # 포맷 레지스트리: id·aliases·채널 규격·active_phases·default (기존)
    <포맷>/
      canon.json             # 블록 카탈로그: 블록 id·포맷별 intent·risk_tier·evidence_required
                             #   + 블록 속성(evidence_gated/brand_gated/emits_image/필수 고지문/구도 힌트/root/차트 규칙)
                             #   + 구성요소 커버리지 (4단계 — 기존 canon-components*.json 흡수, 정본 1개)
      canon.md               # 사람용 문서 = canon.json 에서 생성(파생) — docs/canon-blocks.md 대체
      design-tokens.json     # 톤 팔레트·accent·타이포 (6단계)
      prompt-fragments/      # 레이아웃·포맷 힌트 조각 (5·6단계)
```

core 에 남는 것: `scripts/`(게이트 상태기계·엔진 골격·로더), `harness/`(동결 계약 스키마 — 패턴+카탈로그 대조로 완화), `prompts/`(단계 골격 — 도메인 조각은 라벨 주입), `assets/fonts/`(공용 로케일 인프라 — 잔류 판정), 합성 테스트 번들 fixture(0단계).

---

## 3. 1차 단계별 계획

### 0단계 — 증명 도구 복구·보강 (이동 없음, 최우선)

> ✅ **해소(2026-07-06)**: S1(합성 번들 value-replica)·S8(기본값 전환+베이스라인 재캡처)이 완료됐다. `tests/lib.sh:14`·`build-fixtures.sh` 기본값을 커밋 가능한 `tests/fixtures/bundle-cosmetic` 으로 전환하고, 구 크롤 `naver_*/` 심링크는 제거(decouple). b0 VOC·b1 VOC/페르소나/평점/offer·claim-basis 골든을 이 번들 기준으로 재캡처했다(b0/b1/b2/b3/b1e/b5 green). 아래 원본 블로커 서술은 이력 보존용.

**왜 최우선인가(실측·해소 전)**: 기본 테스트 번들 `core/naver_10910275313_20260617-1331` 이 디스크에 없어(`tests/lib.sh:14`, `.gitignore` 의 `naver_*/`) `verify-baseline.sh` 가 "정본 런 실패"로 즉사했다. 사본은 구 워크스페이스 `~/workspace/ch-detail-page-harness/` 에 존재. 이걸 고치기 전에는 이후 모든 단계의 "증명"이 공중에 떴다.

> **▼ 실측 메모 (2026-07-04 세션 — 브랜치 `refactor/pack-stage0-tools`)**: 0단계 증명 도구는 **거의 완료**(S1~S7 커밋). **미해결 블로커 2건**: ① **S1 합성 번들을 value-replica 로 재작성** 필요 — 전체 CI(`TEST_BUNDLE=합성`) 실행 시 `test-b0/b1` 이 실제 이지듀 번들의 **특정 추출값**을 단정(VOC `71/27/19/17/7/1/0/0` · persona `어머니5/엄마12/선물9` · 평점 5/4/3=`157/35/8` · `offer.price 49800` · `discount 37.44`)하는데 현 합성 번들은 일반값이라 불일치. 저작권 리뷰텍스트 없이 **동일 집계값을 내도록 합성 리뷰 엔지니어링** 필요(목표값은 구 워크스페이스 실번들 `~/workspace/ch-detail-page-harness/naver_10910275313_20260617-1331` 인입으로 확정). ② **S8 기본값 전환+베이스라인 재캡처는 비가역 → 사람 확인 후**, 그리고 S1 value-replica 완료 이후. · **범위밖 기록**: `test-critic-fanout` drug 3건 실패 = 사전존재 stale(drug adk_critic 블록이 브랜치 前 `157375f` 에서 배선됨, 테스트가 "drug=미구현" 전제) → 별도. · **수반 수정 완료**: `test-clinical-engine`(S6a 리팩터로 Pass-A 지시문이 `_build_passa_instruction` 로 이동 → inspect 대상 갱신), `test-b1g:133`(`unset`→`$HERMETIC_EXAMPLES`). · `.env` 는 **repo 루트**(`../.env`)에 있고 ADK_COSMETICS/ADK_DRUG 키 보유.

- [~] **번들 복구 2박자** — (a) 합성 번들 fixture **커밋 완료**(`tests/fixtures/bundle-cosmetic/`, S1 커밋 `34ab883`; `.gitattributes` 로 LF·바이너리 고정). **단 value-replica 미완**(위 블로커 ①). (b) 기본값 전환+재캡처 = **미실행**(S8, 비가역·사람확인, value-replica 후). 신규 항목 **examples 헤르메틱**(`tests/lib.sh:30` + 드라이버 복원, S4 커밋 `8a79868`)은 0단계 누락분으로 승격·완료. *(부록C 결정 1)*
- [x] 미추적 `ezderm-relief-provided.webp` — 화장품 시드로 유지·동결(부록C 결정 2, 이미 main 커밋). own_assets 전수수집 대상으로 매니페스트 편입 예정(S8 재캡처 시).
- [x] **drug 부분 골든 신설** — 완료(S5 커밋 `7eefa64`). `build-fixtures.sh` 파라미터화(`--domain/--wb/--bundle`, phase-guard 스냅) + 합성 drug 번들·WB + `fixtures/drug/{concept,conti}-in` + `baseline-manifest-drug.json`(106항목) + `test-drug-stub-golden.sh`(storyboard-plan iter4/4 escalated 동결·green×2). *(부록C 결정 4)*
- [x] **프롬프트 조립 골든 신설** — 완료(S6a `3ecfa64` + S6b `23798d6`). `adk_critic` Pass-A/B 지시문을 순수함수(`_build_pass{a,b}_instruction`)로 추출(온라인 바이트 동일 증명) + 오프라인 `emit-instruction` 서브커맨드. 골든 11항목(ctx 6·prompts.sha256·instr cosmetic/drug×A/B), 정규화 `<REPO>`/`<RID>`.
- [x] **누출 grep 테스트 신설**(`tests/test-core-domain-leak.sh`): core/ 에서 화장품 어휘(미백·주름·자외선차단·기능성…)·브랜드(이지듀·대웅·EGF·easydew)·블록명 검출. 초기 allowlist = 현재 결합 지점 전체, 단계마다 점감, 9단계에 0. **완료·병합**(merge `b850f57`, run-ci 배선, allowlist 14파일 현재 green).
- [x] `tests/golden/kcia-golden-set.json` 에 `regulatory_domain: "cosmetic"` 명기 — 완료(S2 커밋 `083a55d`). 스키마 무편집(이미 옵셔널 필드), `load_ruleset("cosmetic")==load_ruleset(None)` 증명, rates 불변.
- [x] **pack-lint 뼈대** + 팩 파일 스키마 검증 테스트 — 완료(S3 커밋 `c96f3b4`). `scripts/pack-lint.sh`+`pack_lint.py`+`test-pack-lint.sh`(4팩 통과·9손상 catch·PASS=15), run-ci 배선(S7a `41a308a`). (스키마 매핑 실측 위치 = `registry.json:32`.)

**증명**: 기존 전체 테스트 그린 + (재캡처 후) 신규 베이스라인 verify 그린 + 신규 골든 3종 자체가 산출물.

### 1단계 — 레지스트리 일원화 · cosmetic 폴백 소거

**정정된 사실**: 진입점(new-run.sh:46-49, ingest-bundle.sh:20-23)은 **이미** 미선언 fail-closed 다. 이 단계의 본체는 잔여 폴백 소거.

- [ ] `normalize_format`(new-run.sh:42-44) → `format-profiles.json` 의 **이미 존재하는** aliases 필드 질의로 통일(별칭 집합 동일 실측 = 바이트 불변). 현재는 닫힌 case 라 새 포맷은 표준 id 로도 진입 불가(도메인 축과 비대칭).
- [ ] 도메인 한국어 별칭(new-run.sh:31-41 case) → `domain.json` `aliases` 필드 신설·이관, normalize_domain 은 레지스트리 질의로.
- [ ] **cosmetic 폴백 전수 소거(확정 11지점)**: `kcia_engine.py` 5곳(:220 `default or "cosmetic"`·:225·:232·:241·:252-257), `common.sh` 2곳(:89-93 resolve_domain·build_context 최종 else 의 cosmetic 룰셋 방출), `kcia-check.sh:276`(도메인 룰셋 경로가 비면 화장품 룰셋을 원격 심의에 조용히 전달하는 은닉 폴백), `ingest.py:25`, `stub_stage.py:36`, `validate-stage.sh` 5곳(:134·:153·:181·:218·:222), `golden_runner.py:29`, `new-run.sh:71-78`(기능성 3범주 시드 → 미정의=빈). **env(`HARNESS_DOMAIN`) 선언 인정은 유지** — 이러면 테스트 수정 0건으로 fail-closed 와 양립(전수 조사 확정).
- [ ] `domain.json` `default: true` 의미 제거 + 미등록 안내문 = "등록된 팩 목록 + 온보딩 제안"(`operator_labels.py` 경유 평이 문구).
- [ ] 같은 커밋에서 레거시 일괄 철거: `harness/regulatory-domains.json`(기능 소비는 `kcia_engine.py:221-232` 폴백 단 1경로 — 테스트 0건 실측) + docs/regulation 레거시 3종(`registry.json:28-29` 사문 매칭·`LEGACY_RULESET`·`common.sh:118-120` sources 폴백 — 전부 매칭 실파일 부재 확인) + `ingest-profiles.json:3` 사문 `default` 키. 폴백 코드 블록 자체를 함께 제거(도달 불가 코드 잔류 금지 — 테스트가 이 경로를 커버하지 않아 "살아있음" 증명이 불가능하므로). **"packs 없는 core 단독 체크아웃" 시나리오 공식 폐기를 AGENTS 8번 절과 stale 문서(harness-architecture.md:53·163·181, pipeline-stage-definitions.md 등)에 반영.** *(부록B 승계 1)*
- [ ] `test-drug-golden.sh` 의 default 단정군(:221·:228·:242·:353) 을 "default 부재 = fail-closed" 단정으로 재작성. `docs/user-guide.md:55` 의 이미 깨진 new-run 예시(--domain 없음) 수정.

**증명**: 스텁 골든 2종 + 심의 골든셋 + 전체 테스트. **함정**: kcia-check.sh:276 과 build_context else 는 registry default 와 별개 지점이라 누락되기 쉽다(전수 조사에서 추가 발견된 지점).

### 2단계 — 심의 어휘·실증 정책 퇴거 (스키마 무변경)

**깨진 전제(실측)**: "core 상수 = 팩 lexicon 완전 일치"가 거짓. `FUNC_EFFICACY`·`CONDITION_TARGET`·`PHARMA_AUTHORITY`·zero_voc_exclude 는 완전 일치하지만, **`CONSUMER_DECEPTION_SEVERITY_HIGH` 19항목(무결점·완벽·최초·1위·피부나이·줄기세포·엑소좀·100%·무자극 등, kcia_engine.py:281-283)은 cosmetic ruleset 에 대응 키 자체가 없다.** 폴백을 그냥 공집합화하면 화장품 consumer_deception 위반이 전부 high→medium 으로 강등되어 verdict 바이트·confidence(:1197) 가 변한다.

- [ ] **커밋 a(이동)**: `consumer_deception_severity_high` 19항목을 `packs/cosmetic/ruleset.json` lexicon 에 값 그대로 추가 → 골든 그린 확인.
- [ ] **커밋 b(배선·소거)**: kcia_engine 상수 5종 + zero_voc_exclude 인라인 폴백(:959) 공집합화. `examples_analysis.py:247-252` 가 상수를 **직접 import** 해 00g deny-list 를 만드는 우회로를 룰셋 경유로 교체(놓치면 00g 게이트 동작 변경). `_MI_SIG_LEGACY` 는 활성 도메인 기준 도달 불가 확인(cosmetic 은 mandatory_inclusion 축 없음·drug 는 전 항목 signals 보유) — 공집합화하되 "signals-미정의 레거시 룰셋 지원 종료" 명기.
- [ ] 임상 실증 5요소·정본 디스클레이머("개인에 따라 차이가 있을 수 있습니다")·표기 정규식 → 룰셋 확장 키로(4축 객체 내부는 `additionalProperties:false` 라 불가 — **별도 키**로, axes 는 `additionalProperties:true` 라 스키마 무변경). 배선은 **3곳 전부**: `kcia_engine.py`(:398-496) + `adk_critic.py` 지시문(:554) + `completeness_advisor.py`(:68-110) — 마지막을 빠뜨리면 이미지 preflight 의 must_fill 판정과 심의 게이트의 5요소 정의가 드리프트.
- [ ] author 슈퍼셋(`adk_critic.py:202-205`): 제거가 아니라 **`domain.json` 선언으로 이관(합집합 유지)** — 원격 ADK 멀티에이전트가 sub-agent author 로 응답하는 경우 제거 즉시 온라인 fail-closed 리스크. + **온라인 카나리 1회**.

**증명**: 심의 골든셋(검출률·오탐률 불변) + 스텁 골든 + 프롬프트 조립 골든(ADK 지시문 부분) + 카나리.

### 3단계 — 인입 팩화

**확정된 사실**: `harness/ingest-profiles.json` 에 cosmetic 항목이 없다(`ingest.py:32-33` 이 cosmetic 이면 빈 dict 단락 → 모듈 상수 사용). 그리고 **역방향 함정** — 비화장품 3도메인 프로파일에 `bp_block_order`·`bp_hints` 키가 없어 화장품 기본값(:394-397)을 상속 중이다. 폴백을 제거하면 화장품이 아니라 **drug 런의 산출 바이트가 변한다** → 0단계 drug 골든이 이 단계의 전제조건(순서 의존).

- [ ] `harness/ingest-profiles.json` → `packs/<도메인>/ingest-profile.json` 이동. **cosmetic 프로파일 신설**(모듈 상수 값 그대로 착지: VOC_KEYWORDS·PERSONA_KEYWORDS·OPTION_REGEX(:43-45), FUNC_LABELS·APPROVAL/EVIDENCE 마커·CERT_KWS·EFFICACY_WORDS(:447-464·:552·:569), BP_BLOCK_ORDER·BP_HINTS(:394-411)). 비화장품 3도메인 프로파일에 현행 유효값(화장품 상속분 포함) 명시 착지.
- [ ] 번들 스키마 매핑(네이버 product.json 필드·reviews.csv 컬럼 가정, `ingest.py:236-341`·`examples_analysis.py:49-74`) → `bundle-profile.json` 선언. `img_lint.py` 자사 호스트 추론 정책 포함.

**증명**: 추출 정확도 골든 + voc/claim-basis 산출 바이트 + 스텁 골든 2종(특히 drug best-practices.json).

### 4단계 — 캐논 단일화 (최대 작업)

**현재 정본이 3곳으로 갈라져 있다**: 생성 측 `stub_stage.py:293-323` CANON, 검증 측 `validate_storyboard.py` + `storyline.schema.json` enum, 커버리지 측 `packs/_format/canon-components*.json`. 여기에 문서 `docs/canon-blocks.md`(15블록 — AGENTS 의 "12블록" 표기는 낡음). canon.json 신설 시 **기존 canon-components 를 흡수해 정본을 1개로** 만들지 않으면 4중 분열이 된다.

- [ ] **canon.json 정의**(`packs/_format/<포맷>/`): 블록 카탈로그 + **포맷별 intent 문구·risk_tier·evidence_required 포함** — 실측 확인: stub 의 CANON 4-튜플(type·intent·risk_tier·evidence_required)이 storyline.json 바이트에 직접 기록되고 같은 블록도 포맷별 intent 가 다르다(socialProof: multipage vs one_pager). 이게 빠지면 스텁 배선 불가 → 4/5단계 분리가 무너진다. + 블록 속성(evidence_gated/brand_gated/emits_image(`image_engine._block_emits_image`)/필수 고지문(beforeAfter '연출·개인차')/구도 힌트/root_required(`validate_storyboard.REQUIRED_ROOT`)/차트 규칙) + 구성요소 커버리지(canon-components 흡수).
- [ ] **커밋 a(배선)**: 소비처 8곳 재지향 — `stub_stage`(CANON·CANON_ONE_PAGER·EVIDENCE_GATED·BRAND_GATED)·`validate_storyboard`(_canon() 출처 교체 — **주의: :24-27 의 무음 하드코딩 폴백 `_CANON_FALLBACK` 을 fail-closed 로** 바꾸지 않으면 "완화한 줄 알았는데 옛 상수가 실효 지배")·`kcia_engine` 블록명 분기(:1070-1180 → 캐논 속성 구동)·`image_engine`·`examples_analysis`(BP)·`check_beforeafter`·`completeness_advisor`·`check_canon_coverage`.
- [ ] **커밋 b(스키마 완화)**: `plan-block`/`storyline` type enum(23종) → 패턴 + 카탈로그 대조(대조 로직은 `validate_storyboard.check_blocks:151-154` 에 이미 존재 — 출처만 교체). `state.schema` deliverable_format enum → 패턴 + format-profiles 등재 검증(regulatory_domain 완화 전례 복제, state.schema.json:22). `test-components.sh` 의 스키마 파일 grep 단정 2곳(:20-21·:109-110) 동반 수정.
- [ ] `docs/canon-blocks.md` → canon.json 에서 생성되는 파생 문서로 대체(경로·참조 동반: format-profiles.json:8 의 `"canon": "docs/canon-blocks.md"` 갱신).
- [ ] **도메인 변형 규약**(`packs/<도메인>/canon/<포맷>.json` 존재 시 전체 교체)은 규약·로더만 정의하고 **1차에선 아무 도메인도 변형을 만들지 않는다** = 동작 불변. drug 캐논 변형 제작은 2차.

**증명**: 스텁 골든 2종(storyline.json 의 intent/risk_tier 바이트 불변이 핵심) + 캐논 커버리지·스토리보드 검증 테스트 + 심의 골든셋.

### 5단계 — 생성 표면 팩화 (프롬프트 · stub 콘텐츠)

**증명 한계(실측)**: stub 은 build_context 를 쓰지 않아(`common.sh:350·370` 주석) 프롬프트 변경이 스텁 골든에 안 나타난다 → 0단계 프롬프트 조립 골든이 이 단계의 유일한 안전망(순서 의존).

- [ ] 프롬프트 도메인 조각 추출 → `packs/<도메인>/prompt-fragments/` + `packs/_format/<포맷>/prompt-fragments/`, build_context 신규 라벨로 주입: brief.md 의 EGF·모친선물 예시·기능성 어휘·리스크 항목(:11-30), concept.md 의 축 카탈로그+B-safety 정책(:11)·VOC 인용 규칙(:15,18), guideline.md 의 금지어·아누아/메디힐 실명 예문, storyboard/keyvisual 의 실증 어휘·이지덤→easydew 예문·포맷 힌트.
- [ ] `kcia-critic.md` 의 화장품 4축 예시 단락 → `packs/cosmetic/critic-fragment.md`. 사문 필드 `critic_prompt`(소비처 0건 확정) 실배선 — 깨진 `docs/regulation/` PDF 참조(원문은 packs/cosmetic/sources/ 로 이주 완료, 현재 dangling)도 이때 해소. *(부록B 승계 2)*
- [ ] stub 콘텐츠 템플릿(`stub_stage.py` 의 `_is_cosmetic` 이분법 카피·축 세트·명사·기능성 라벨 dict) → `packs/<도메인>/stub-templates/`, stub_stage 는 템플릿 렌더러로. **가장 엄격한 증명 구간** — 스텁 골든 바이트 불변.
- [ ] `run-stage.sh` 인라인 히어독(:353-367·:384-407·:429-470): 도달 불가 죽은 코드 실측 확정 — 팩으로 옮기지 않고 제거(골든 무영향).

**증명**: 프롬프트 조립 골든(조립 결과 문구 동일) + 스텁 골든 2종.

### 6단계 — 디자인·이미지·export·운영 라벨

- [ ] 디자인 토큰 코드 폴백 제거: `stub_stage.py:29` ACCENT_DEFAULT·:384-394 TONE_DIRECTIONS → `packs/_format/<포맷>/design-tokens.json`(값은 이미 팩 소유 구역 — 폴백만 제거). **폰트(`core/assets/fonts/PretendardVariable.woff2`)는 core 공용 자산으로 잔류** — 로케일 인프라 판정. 이동 시 상대경로 5단계 규약(keyvisual.md:20-21)+stub @font-face(:726)+골든 HTML 바이트가 연쇄 파손, 실익 없음(열린 항목으로 유지).
- [ ] 이미지 생성 프롬프트 골격(`image_engine.py:80-103` 한국어 지시·easydew 주석) → 포맷 팩 prompt-fragments.
- [ ] **export 경로(`export/kcia-package`)는 1차 불변** — baseline-manifest 16항목·advance-phase.sh:63 게이트·테스트 3파일·문서 9곳이 경로를 골든 계약으로 고정(전수 실측). `export_package` 필드(소비처 0건)는 "무시됨" 문서화만. 도메인별 패키지명 활성화 = 2차 이월.
- [ ] `operator_labels.py` 팩 오버레이(`labels.json` merge): '협회 자문용 패키지'·'피지량' 등 화장품·커머스 어휘 행만 cosmetic 팩으로. 누수 차단 장치(_FORBIDDEN_RE/scrub)는 커널 잔류. `prompts/operator-voice.md` 동기 규약 준수.

**증명**: 스텁 골든(키비주얼 HTML 바이트) + operator-language 테스트 + 키비주얼 스테이지 테스트.

### 7단계 — 샘플·자산·examples 퇴거 (독립 단계)

**분리 이유(적대 검증)**: 8단계(테스트 재편)와 합치면 베이스라인 재생성이 "무엇 때문에 해시가 변했는지"를 가려 증명 앵커를 잃는다. assets-manifest 의 기록 경로는 런-상대(`ingest.py:371`)라 시드 원위치와 무관하지만, own_assets = 시드 디렉터리 전수 수집이라 **내용 집합이 바뀌면 전부 변한다**.

- [ ] **커밋 a(경로만, 내용 집합 동결)**: `core/inputs/assets`·`examples`·WB 픽스처(wb-ezderm-relief.md 등) → `packs/<도메인>/samples/`·`examples/`. 기본 경로 3곳 재지정(ingest-bundle.sh:45·:77, common.sh:529) + 테스트 참조 수정 → **구 베이스라인으로 verify 통과 확인**(집합 동결이므로 해시 불변).
- [ ] **커밋 b(내용 분리 — 부록C 결정 3)**: 자산 교차 오염 교정 — 현재 화장품(ezderm)·의약품(ursa)·daewoong 로고가 한 폴더 혼재라 의약품 런에 화장품 이미지가 실제 유입 중. 도메인별 분리 = 의도된 동작 교정(cosmetic 런 own_assets 에서 ursa 이미지 제외)이므로 **베이스라인 재캡처 동반, 별도 커밋**.

### 8단계 — 팩별 테스트·골든·fixtures 선언 (사용자 확정 항목)

- [ ] 팩 검증 동반물 규약 확립: `packs/<도메인>/{golden/, fixtures/, stub-templates/}` + 선언(규약적 디렉터리 또는 tests 선언 파일).
- [ ] `core/fixtures/` 3종(concept-in·conti-in·keyvisual-in — 전부 cosmetic·이지듀 실측) → `packs/cosmetic/fixtures/` 바이트 동일 이동. 소비처 7곳 경로 동반 수정: `tests/lib.sh:35-37` seed_fixture, stage-concept/conti/keyvisual.sh, test-render-existence-depth.sh:98, test-insession-genmode.sh:161, test-gen-image-completeness.sh(4곳), test-image-engine.sh:342-343, run-stages.sh:5.
- [ ] `tests/golden/` 의 화장품 소유물(working-backwards.md·kcia-golden-set.json 등) → `packs/cosmetic/golden/`.
- [ ] 테스트 단정 문자열('대웅배너' test-components.sh:43-44·:75, '제조판매원 대웅제약'·'광고심의필' test-drug-golden.sh:66-83) → 팩 fixture 기대값 파일로.
- [ ] **팩 적합성 스위트**: 전 팩 순회 — 팩 스키마 검증(pack-lint) → 골든셋 회귀 → (가능한 팩) 스텁 파이프라인+베이스라인 → 커버리지. `build-fixtures --pack` 지원. "팩이 자기 테스트를 선언하고 core 가 순회 실행"이 이 단계의 산출물.
- [ ] `tests/lib.sh` 의 cosmetic env: "기본값" 의미 제거(각 테스트/드라이버가 명시 선언 — env 선언 인정 원칙과 양립, 수정 규모 최소).

### 9단계 — 마무리 검수

- [ ] 누출 grep allowlist 0 달성(잔여 소탕).
- [ ] 문서 최종 정합 검수(각 단계에서 동반 갱신했으므로 확인만): AGENTS.md(12블록→15 등)·workflow-ssot 헤더·README 죽은 지시(`KCIA_CRITIC_CMD` 13행 — 폐기 env 를 준비 절차로 안내 중)·`.env.example`(drug adk_critic "미구현" 서술이 실물과 모순 — packs/drug/domain.json:7 에 블록 실재)·harness-architecture.md·pipeline-stage-definitions.md stale.
- [ ] 죽은 코드 정리: `adk_critic.py:9` dangling docstring 등.

---

## 4. 1차 완료 판정 (Definition of Done)

1. 스텁 바이트 골든 2종 그린 — cosmetic done 전 구간 + drug 현행 동작(escalated까지).
2. 프롬프트 조립 골든 그린(생성 지시문 + ADK 지시문, 문구 단위 동일).
3. 심의 골든셋 검출률·오탐률 불변(cosmetic + drug).
4. 누출 grep 테스트: core/ 에서 도메인 어휘·브랜드·블록명 0건(allowlist 소진).
5. 4팩 적합성 스위트 그린 — 각 팩이 자기 테스트·골든·fixtures 선언 보유.
6. 미선언·미등록 = fail-closed + 등록 팩 목록·온보딩 제안 안내.
7. 온라인 카나리 1회 통과(원격 ADK 지시문·author 이관 확인).
8. workflow-ssot 등 문서 정합(단계별 동반 갱신 완료 상태 확인).

---

## 5. 2차 이월 목록 (1차에서 의도적으로 하지 않는 것)

| 항목 | 1차에서 못/안 하는 이유(실측 근거) |
|---|---|
| kcia 명명 중립화 | 108파일·263회 참조 + baseline 골든 계약(kcia-package 16항목) — "바이트 동일"과 양립 불가. 별도 배치로 격리 |
| 도메인별 export 패키지명(export-profile 실배선) | 경로가 골든 계약·advance-phase 게이트에 고정. 골든 재캡처 전제 |
| drug done-골든 | 스텁 도메인-인지(팩별 stub 템플릿의 drug 콘텐츠)가 신규 동작 |
| drug 캐논 변형(의약품 상세페이지 블록 세트) | 콘텐츠 제작 — "값 이동만" 원칙 밖 |
| 심의 축 카탈로그 선언화(축-일반 루프) | ruleset.schema 는 런타임 비강제(검증 호출 0건 실측)라 "스키마만 완화"는 실효 없음. 실행 경로는 scan_text 축별 하드코딩 디스패치 — 일반화는 동작 추가 |
| golden-set axis enum 완화 | 새 축 라벨용 — 기존 골든(4축 라벨)은 enum 통과 중이라 1차 불필요 |
| 페이즈 팩 기여(route-union) | phase-descriptors.schema 주석 자체가 "단계5/6 연기" 명시 — 1차 퇴거 대상은 페이즈를 추가하지 않음 |
| 폰트 팩/브랜드 자산화 | 상대경로 규약+골든 HTML 3중 결박 — 실익 대비 파손 범위 큼(열린 항목) |

---

## 6. 2차 계획 — 온보딩

### 준비 완화 묶음 (온보딩 선결 — 1차 이월분 처리)

- **2차 1단계 — 심의 축 카탈로그 선언화**: 팩이 축(id·라벨·검사방식 type: banned|conditional|trigger-evidence|hard-stop|mandatory-inclusion)을 선언, `scan_text` 를 축-일반 루프로, `golden-set.schema` axis enum 완화(패턴+카탈로그 대조 — 새 도메인이 자기 축 이름으로 골든셋을 만들 조건), drug 5축째(prescription_otc_distinction) 1급 승격 + mandatory_inclusion root 승격(현재 스키마 제약으로 axes 밑에 밀어넣어진 상태 해소). `_AXES_GUIDE`(adk_critic) 를 룰셋에서 생성.
- **2차 2단계 — 콘텐츠 교정 패스**: 팩별 stub 템플릿에 drug 콘텐츠(done 도달 가능) + drug done-골든 신설. **drug 캐논 변형 첫 실사용**(의약품×상세페이지 블록 세트 — "캐논은 조합 단위"의 실증; 현재 의약품 런이 화장품 캐논 required 를 우회 충족하는 왜곡 해소). export-profile 실배선(도메인별 패키지명 + 골든 재캡처). 필요 시 자산 교차 오염 교정(1차 7단계 커밋 b 를 이월한 경우).
- **2차 3단계(선택) — kcia 명명 중립화 배치**: review-check 등 개명 + 구명 별칭·env 별칭 유예기간. 골든 재캡처 동반.

### 온보딩 본체

- **2차 4단계 — 팩 계약의 자기술화**: `packs/_template/` + 팩 파일별 스키마(`harness/pack-*.schema.json`) + 각 표면에 "온보딩 질문" 메타. 1차에서 확정된 어댑터 표면이 곧 질문지다:
  - "무슨 제품이고, 법적으로 무엇을 말할 수 있나요?" → domain.json + ruleset.json
  - "산출물은 무엇을 만드실 건가요?" → 포맷 선택/신설 + 채널 규격 + active_phases
  - "캐논은 무엇을 주실 건가요?" → canon 변형(조합 단위) + 커버리지 오버레이
  - "브리프 단계에서는 무엇을 주실 건가요?" → WB 템플릿 + ingest/bundle 프로파일 + VOC 소스 정의 + examples + 자산 슬롯
  - "심의에서 무엇이 걸리나요? 무엇으로 증명하나요?" → 축·금지어·실증 정책·필수기재·critic-fragment
  - "외부 연동은 무엇인가요?" → adk_critic 식 env 간접 선언(멀티테넌시 표면)
- **2차 5단계 — 결정적 스캐폴더**: `scripts/new-pack.sh` — 빈 팩 생성. 규약: **전 lexicon 키를 공집합으로라도 명시 생성**(키 부재 시 폴백 누출을 원천 차단 — 1차 후엔 폴백이 없으므로 이 규약은 "미정의=비검사"의 명시화), status=tbd, **.env 스탠자를 domain.json 선언에서 기계 생성**(.env.example 드리프트 재발 방지 — 멀티테넌시 요구의 구현).
- **2차 6단계 — 온보딩 대화**: `/onboard-pack` 스킬(셸 1급 경로의 편의 래퍼 — 이식성 원칙 유지). 진행 상태는 별도 상태 파일이 아니라 **pack-lint 의 결손 리포트가 "다음 질문"을 결정**. LLM 은 팩 파일만 쓰고 검증은 스크립트(생성≠검증 격리 유지).
- **2차 7단계 — 점진 활성화 공식화**: tbd(빈 팩으로 파이프라인 체험 — placeholder-autopass) → ready(룰엔진-단독 심의) → active(원격 ADK 실심의). 각 전환의 최소 요건 = pack-lint 레벨로 정의, 전환은 사람 승인. quasi_drug·health_food 가 이미 걸어온 경로의 공식화.
- **2차 8단계 — 검증 동반물 온보딩**: 위반/통과 예문 인터뷰 → 골든셋 생성, 샘플 WB → fixtures(`build-fixtures --pack`), stub 템플릿 채움 → **팩 적합성 스위트 그린 = "온보딩 완료 = CI 가능"**.
- **2차 9단계 — 실전 검증(인수 테스트)**: health_food(또는 quasi_drug)를 온보딩 플로우만으로 ready 까지 채운다.

---

## 부록A. 검증으로 확정된 관통 사실 (계획 근거 요약)

- 진입 게이트는 이미 fail-closed(new-run.sh:46-49) — 1단계 본체는 잔여 폴백 11지점 소거.
- `--emit-context` 는 픽스처 기준 결정적(2회 diff 동일 실측) — 프롬프트 조립 골든 실현 가능. run-stage 실엔진 히어독은 도달 불가 죽은 코드.
- drug 오프라인 스텁의 현행 동작 = storyboard-plan 에서 escalated(스텁 brandTrust '수상·기술력' × drug 실증 규칙, 결정적 재현). ursa 런은 insession 실엔진 산출.
- baseline 매니페스트 키 = run-상대경로(소스 이동 자체론 안 깨짐). 깨지는 조건 = 시드 바이트 변화·스냅샷 집합 변화·기본 경로 배선 변경.
- cosmetic 상수 5종 중 `CONSUMER_DECEPTION_SEVERITY_HIGH` 만 팩 lexicon 에 부재(2단계 커밋 a 의 근거). `_lex()` 는 키 부재(None)일 때만 폴백 — 빈 배열/맵 명시는 비누출(drug 팩이 이행 중).
- `critic_prompt`·`export_package` 필드 소비처 0건(사문). `regulatory-domains.json` 기능 소비 1경로(레거시 폴백). registry.json:28-29 는 매칭 실파일 없는 사문 규칙.
- 블록 type 카탈로그 대조 로직은 `validate_storyboard.check_blocks` 에 이미 존재 — 완화 = 출처 교체(+무음 폴백 fail-closed 화). 완화 시 깨지는 곳 = test-components.sh 의 스키마 파일 grep 단정 2곳뿐.
- `verdict.schema` engine enum·phase-descriptors/routes 닫힘은 1차에서 불변이 맞다(도메인 팩이 값을 만들지 않음 / 스키마 주석이 연기 명시).

## 부록B. 선행 계획과의 승계 관계

1. **`_archive/cleanup-plan.md` 의 "regulatory-domains.json 절대 보존" 판정 승계·해제**: 보존 근거 = kcia_engine.py:223 기능 로드(폴백). 본 계획 1단계가 그 폴백 코드를 같은 커밋에서 제거하므로 근거가 소멸 — 순서 의존(코드 제거 선행)만 지키면 두 계획은 모순되지 않는다.
2. **cleanup-plan Tier 3 의 "kcia-critic.md + critic_prompt 4곳 = 별도 정책 리팩터로 처리" 판정 승계**: 본 계획 5단계가 그 지정 후속이다(critic_prompt 실배선 + 화장품 예시 단락의 팩 이관 + dangling docs/regulation 참조 해소).
3. `multi-domain-build-plan.md` 와의 관계: 그 계획의 "C 메커니즘"(enum→패턴+레지스트리 대조, state.schema regulatory_domain 에 기적용)을 본 계획 4단계가 블록 type·deliverable_format 에 복제한다. 발명이 아니라 반복.

## 부록C. 열린 결정 (2026-07-03 사람 확정 완료)

> **확정 상태(2026-07-03, 차병환):** 4건 전부 권고안 채택. 아래 "확정" 열이 실행 근거다.

| #   | 결정                                | 선택지                                                                | 권고              | 확정(2026-07-03) |
| --- | --------------------------------- | ------------------------------------------------------------------ | --------------- | --------------- |
| 1   | 0단계 번들 전략                         | (a) 합성 번들 커밋 + 베이스라인 재캡처(자립) / (b) 구 워크스페이스 사본 복원만(빠르나 레포 밖 의존 지속) | (a)             | **(a) 확정** — 합성 번들 커밋 + 재캡처(재캡처는 비가역이라 실행 직전 사람 재확인) |
| 2   | 미추적 `ezderm-relief-provided.webp` | 커밋(시드 편입) / 삭제                                                     | 어느 쪽이든 0단계에서 동결 | **화장품 시드로 유지·동결 확정**(이미 main 커밋) |
| 3   | 자산 교차 오염(의약품 런에 화장품 이미지 유입) 교정 시기 | 1차 7단계 커밋 b(골든 재캡처 1회 동반) / 2차 이월                                  | 1차 7단계          | **1차 7단계 커밋 b 확정** |
| 4   | drug 골든 범위                        | 1차 = 현행 동작(escalated까지) 동결, done-골든은 2차                            | 그대로 확정          | **현행 escalated 동결 확정** — done-골든 2차 이월 |
