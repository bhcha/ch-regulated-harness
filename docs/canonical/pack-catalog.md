# 팩 카탈로그 — 도메인·포맷 팩 조회 지도(정본)
> **이 문서의 지위:** "어떤 규제도메인/산출물 포맷이 있고, 각각 어떤 심의 룰셋·1차 출처·ADK 엔드포인트·캐논을 갖는가"의 사람용 조회 정본.
> **관계:** 규칙 SSoT = [`../AGENTS.md`](../../core/AGENTS.md)(3·8번 절). 도메인 데이터 SSoT = 형제 [`../../packs/<도메인>/`](../../packs/). 워크플로우 정본 = [`workflow-ssot.md`](workflow-ssot.md). 기능 인벤토리 = [`feature-catalog.md`](feature-catalog.md).
> **본문 원칙:** 현재 존재하는 팩만 담는다(변경 이력 서술 금지). 이력은 git.
> 작성 2026-07-10 · 최신 갱신 2026-08-13
> **유지보수(keep-in-sync):** 이 문서는 AGENTS.md 4번 절 D-1 동반갱신 대상이다 — 도메인/포맷 팩을 추가하거나, `domain.json` status 를 전환하거나, 룰셋/캐논 구조가 바뀌면 같은 변경에서 이 문서 해당 행을 갱신한다.

---

## 1. 도메인 팩 — 심의 참조 매트릭스

**심의 메커니즘:** 운영 심의 엔진 = **원격 ADK(`adk-http`) 단일** — 생성과 **다른 벤더(Gemini)·원격 세션**이라 같은 스레드 자가비판이 구조적으로 불가능하다(로컬 헤드리스 크리틱 `claude-subagent`/`KCIA_CRITIC_CMD`·self-grading substring 가드는 **폐기**; `KCIA_CRITIC_ENGINE` 은 비우거나 `adk-http` 만 허용). 1차 결정적 룰엔진(`kcia_engine.py`, ruleset 축) + 2차 원격 ADK 2-pass(`scripts/lib/adk_critic.py`: Pass-A 선택안 카피만 외부 전송, Pass-B 건별 적대검증).

**ADK 엔드포인트는 도메인별이다.** `packs/<도메인>/domain.json` 의 **`adk_critic` 블록**(`url_env`/`host_env`/`app`/`author` + 선택 `author_aliases`·`retry`)이 'ADK 구현됨' 마커다. URL/host 는 그 `url_env`/`host_env` 가 가리키는 환경변수에서 읽는다(예: 화장품 = `ADK_COSMETICS_CRITIC_URL` + `ADK_COSMETICS_CRITIC_ALLOWED_HOST`, app `cosmetics_agent` · author `cosmetics_review_agent`). 단일 `ADK_CRITIC_URL`/`ADK_CRITIC_ALLOWED_HOST`/`ADK_CRITIC_APP` 은 **폐기**. 새 도메인 = `domain.json` 에 `adk_critic` 블록 + `.env` 에 그 env 추가만(core 코드 무수정). **응답 provenance(author) 안전 슈퍼셋은 하드코딩이 아니라 등록 전 도메인의 `author`+선택 `author_aliases` 합집합에서 조립한다**(`adk_critic._known_authors`; 특정 도메인에 매이지 않는 `guideline_review_agent` 는 cosmetic `author_aliases` 가 홈). `kcia-check.sh` 가 `adk_critic.py resolve --domain <d>`(네트워크 없음)로 분기한다:
- **블록 + URL env 둘 다 있음** → 원격 ADK 강제(`KCIA_CRITIC_REQUIRED=1` 자동, 조용한 강등 금지, `preflight` 로 엔드포인트 사전검증). 도메인 전용 에이전트 파일은 없고 — 원격 ADK 에 도메인별 룰셋·가이드 발췌(금지표현 요약)를 instruction 으로 주입한다(참조 문서만 도메인별로 갈림).
- **블록은 있으나 URL env 비었음** → **설정오류 fail-closed**(중단; 구현된 도메인의 조용한 강등 금지).
- **블록 없음(미구현 — `adk_critic` 블록 미배선)** → ADK 생략, **룰엔진-단독**(`review_depth=rule_engine_only`·`critic_ran=false`)로 진행하되 "사람 확인 권장"으로 가시화. 추후 엔드포인트 받으면 블록+env 만 추가하면 자동 활성.
- 오프라인(`HARNESS_OFFLINE=1`)/stub 생성 → 결정성상 ADK resolve 자체를 건너뛰고 룰엔진 baseline 만(골든 불변).

> **경로 균일(packs 리팩토링 완료):** 심의자료가 있는 도메인(active)은 모두 `packs/<도메인>/ruleset.json` + `packs/<도메인>/sources/` 로 co-located 된다(과거 cosmetic 만 최상위 `docs/regulation/ruleset.json` 였던 비일관은 해소 — 현재 [`regulation/`](../../core/docs/reference/regulation/) 에는 README.md 만 남음). **자료 대기 도메인은 아직 co-located 되지 않았다**: quasi_drug 는 빈 축 플레이스홀더 `ruleset.json`(+`sources/` 없음), health_food 는 `ruleset.json`·`sources/` 둘 다 부재(아래 표 참조). core 로더(`kcia_engine.load_domain_registry` · `common.sh domain_field`)가 `packs/*/domain.json` 을 스캔해 레지스트리를 조립한다. *(AGENTS 규칙 3·8)*

| 도메인 | status | ADK(`adk_critic` 블록) | 심의 룰셋(팩 co-located) | 심의 가이드 원문(critic 직접 열람) | 심의 동작 |
| --- | --- | --- | --- | --- | --- |
| **화장품**(cosmetic) | **active** | **있음** → `ADK_COSMETICS_CRITIC_URL`/`_ALLOWED_HOST`(app `cosmetics_agent`·author `cosmetics_review_agent`) | [`packs/cosmetic/ruleset.json`](../../packs/cosmetic/ruleset.json)(판정 4축: 의약품오인·기능성오인·소비자기만·실증 + lexicon 사전 + clinical_substantiation 실증 표기 정책) | [`packs/cosmetic/sources/`](../../packs/cosmetic/sources/) 2종(.md+.pdf) — 화장품 광고자문기준 해설서(2025, 대한화장품협회) · 화장품 표시·광고 관리지침(식약처) | **실심의(룰엔진+원격 ADK)** — URL 미설정 시 fail-closed |
| **의약품**(drug) | **active** | **있음** → `ADK_DRUG_CRITIC_URL`/`_ALLOWED_HOST`(app `pharma_agent`·author `pharma_review_agent`) | [`packs/drug/ruleset.json`](../../packs/drug/ruleset.json)(7축 = 5개 명명 축 drug_misperception·functional_misperception·consumer_deception·substantiation_required·prescription_otc_distinction + lexicon + mandatory_inclusion) | [`packs/drug/sources/`](../../packs/drug/sources/) 2종(.md+.pdf) — 의약품 광고심의 가이드라인(식약처, 2022.11) · 광고심의 실무 매뉴얼(제약바이오협회, 2021) | **실심의(룰엔진+원격 ADK)** — URL 미설정 시 fail-closed + 전문/일반 하드스톱(`product.rx_classification`×`ad_audience` 선언 시; 전문의약품×대중매체 → high+escalate, 미선언=미발동) + 필수기재(04-keyvisual 페이지-레벨) |
| **의약외품**(quasi_drug) | tbd | 없음 | [`packs/quasi_drug/ruleset.json`](../../packs/quasi_drug/ruleset.json)(**빈 축 플레이스홀더**) | **없음** | **placeholder-autopass**(무조건 통과 + 사람 확인 필요) — 자료 대기 |
| **건강기능식품**(health_food) | ready-only | 없음 | **파일 부재**(`packs/health_food/ruleset.json` 없음 → 로더가 미완 룰셋 반환 = fail-closed) | **없음** | **placeholder-autopass** — 자료 대기 |

- ⚠️ active 2개도 **1차 추출 초안**(cosmetic=2025 PDF 실입수 후 별표 재대조, drug=전문/일반 구분·허가사항 초과·필수기재 적용범위 현업 확인 의존). 카탈로그 완전성 미검증. *(각 `packs/<도메인>/ruleset.json` 의 meta.note)*
- **팩 소유 부가 파일(도메인별, core 무수정으로 자동 배선)**: `ruleset.json`·`domain.json`·`sources/` 외에 — `ingest-profile.json`(도메인별 추출 프로파일 — VOC·페르소나·기능성/인증 어휘·form_factors 등, `ingest.py`·`form_factor.py` 가 읽음; 4개 도메인 모두 보유, 부재 시 공집합 추출 fail-safe) · `canon-overlay.json`(**도메인 캐논 오버레이** — 포맷 캐논 위에 도메인×포맷 blocks 시퀀스·components 커버리지를 통째 교체하고 types 는 가법, `harness.canon_json` 이 병합해 스토리보드 생성·검증·커버리지가 소비; **drug 저작됨 = 교육콘텐츠 캐논**[multipage_bm: hero 교육주제→problem→mechanism→ingredientTech→ingredientDetail→rtbSummary→clinicalEvidence→targetAudience→faq→precautions→footer 필수기재 · one_pager: hero→rtbSummary→precautions→footer 1매 압축(CTA 없음); 신규 블록 mechanism·faq·precautions], 부재 도메인=포맷 캐논 그대로 no-op) · `design-tokens-overlay.json`(**도메인 디자인 토큰 오버레이** — 포맷 토큰 위에 최상위 키 교체·신규 키 가법, `harness.design_tokens` 병합; **drug 저작됨 = 클리니컬·에듀케이션 톤** + `visual_guidance`[인포그래픽 1급·수치 콜아웃·직접 설득 배제], 부재=no-op) · `gen-fragment.md`(도메인 생성 규칙, `build_context` 가 `DOMAIN_GEN_RULES` 로 주입·Seam B; cosmetic·drug 저작됨) · `critic-fragment.md`(심의 참조 — **의도적 미배선**: ADK 지시문은 ruleset 단일 출처 조립이라 배선하면 중복+격리 후퇴, 조각 파일 헤더에 결정 명기) · `rtb-writing-guide.md`(도메인 RTB 작성 가이드 — `build_context` 가 **concept 단계에만** `DOMAIN_RTB_GUIDE` 로 주입[ctx 비대 방지·부재=no-op]; drug 저작됨) · `common-terms.json`(보편어 가드 입력, 스키마 `common-terms.schema.json`·Seam F; cosmetic·drug 시드) · `learned/deny.json`(학습 승격 금지어, 스키마 `learned-lexicon.schema.json`·Seam F, **사람 승인 승격 시에만 생성**, 부재=no-op) · `learned/brands/<브랜드>.json`(선택 유래 선호, 브랜드 스코프). 부재 파일은 전부 no-op(골든 불변). *(생성=`/learn-analyze`→`apply-learnings.sh`; 자동 승격 없음)*
- ⚠️ **ADK 구현/미구현 = `adk_critic` 블록 유무**(status 와 직교): 현재 **화장품·의약품 둘 다 블록이 있어 원격 ADK 실심의가 돈다**(URL env 미설정 시 fail-closed). `adk_critic` 블록이 없는 도메인은 룰엔진-단독 + 사람 확인 권장으로 가시화한다(조용한 강등 금지). 추후 다른 도메인도 엔드포인트를 받으면 `packs/<도메인>/domain.json` 에 `adk_critic` 블록 + `.env` 에 `ADK_<도메인>_CRITIC_URL`/`_ALLOWED_HOST` 추가만으로 자동 활성(core 무수정).
- ⚠️ `status != active`(의약외품 tbd · 건기식 ready-only)는 `kcia-check.sh` 가 evaluate 이전에 `placeholder-autopass`(verdict=pass+note)로 무조건 통과시킨다(데드엔드 방지). 자료 입수·`active` 전환 시 자동 실심의.
- ⚠️ 레거시 폴백(`harness/regulatory-domains.json` · `docs/regulation/ruleset.json`=`LEGACY_RULESET` · `default→cosmetic` 메커니즘)은 **폐지**됐다 — `packs/` 가 유일 레지스트리 SSoT다. 등록은 됐는데 ruleset 파일이 없으면(health_food) '미완 룰셋'(빈 축)을 반환해 fail-closed 하고, **미선언·미등록 도메인도 cosmetic 으로 조용히 폴백하지 않고 fail-closed** 한다.

---

## 2. 포맷 팩 — `packs/_format/`

**포맷은 도메인(심의)과 직교한다** — 도메인=무엇을 말할 수 있나, 포맷=어떤 구조로 만드나. 산출물 포맷 팩은 규제도메인 팩과 별도의 비-도메인 팩 [`../../packs/_format/`](../../packs/_format/)이 소유한다. 단일 SSoT = [`format-profiles.json`](../../packs/_format/format-profiles.json)(포맷 → 캐논/실행페이즈/채널 프로파일). core 로더(`FORMATS_DIR = PACKS_DIR/_format`)가 이 SSoT 를 읽고, **기본 포맷 = `multipage_bm`** 이다.

| 포맷(내부 키) | 한글 포맷명(label) | 별칭(aliases) | 캐논 정본 | 채널 프로파일 | status |
| --- | --- | --- | --- | --- | --- |
| **multipage_bm**(기본) | 여러장 BM자료(세로 상세페이지) | 여러장 · 여러장짜리 · BM · BM자료 · 상세페이지 · multipage | [`packs/_format/multipage_bm/canon.json`](../../packs/_format/multipage_bm/canon.json) | naver_smartstore · 860px 폭 · 최대 5000px · gif 허용 | **active** |
| **one_pager** | 한장 홍보자료 | 한장 · 한장짜리 · 홍보물 · 홍보자료 · 포스터 · onepager | [`packs/_format/one_pager/canon.json`](../../packs/_format/one_pager/canon.json) | single · 860px 폭 · 최대 1200px · gif 불가 | **active** |

- **한글 ↔ 내부 키 매핑:** 한장/포스터 = `one_pager` · 여러장/상세페이지/BM = `multipage_bm`. (과거 '홈페이지/website' 포맷은 제거됐다 — 현재 존재하는 포맷은 위 2종뿐이다. `multipage_bm` 의 `disallowed_blocks` 에 남은 `header`/`nav` 는 그 제거된 website 포맷의 크롬 잔재를 결정적으로 금지하는 항목이다.)
- **두 포맷 공통:** 실행 페이즈 = `00-ingest → 00e-evidence → 00g-guideline → 01-brief → 02-concept → 03-storyboard → 04-keyvisual`, 최종 페이지 페이즈(`final_page_phase`) = `04-keyvisual`(의약품 `mandatory_inclusion` 필수기재가 여기서 페이지-레벨로 게이팅).

**공용 자산(포맷 무관, `packs/_format/` 최상위):**

| 파일 | 역할 |
| --- | --- |
| [`format-profiles.json`](../../packs/_format/format-profiles.json) | 포맷 목록·기본 포맷·별칭·캐논 경로·채널·활성 페이즈의 단일 SSoT |
| [`design-tokens.json`](../../packs/_format/design-tokens.json) | 렌더 디자인 토큰(색·타이포·간격 등) 공용 정본 |

- **캐논(canon) 정본 위치 = `packs/_format/<포맷>/canon.json`.** 각 canon.json 은 `blocks`(생성 시퀀스: order·intent·risk_tier·evidence_required) · `evidence_gated`/`brand_gated`(조건부 제외 집합) · `required_root`(필수 루트 블록) · `types`(전역 유효 블록 카탈로그) · `components`(커버리지)로 구성된다.
- **도메인 캐논 오버레이 = `packs/<도메인>/canon-overlay.json`(있으면).** 캐논은 포맷×도메인 2축이다 — 도메인 팩에 오버레이가 있으면 그 도메인×포맷 조합에서 `blocks`·`components` 가 통째 교체되고 `types` 는 가법(`types_add`; 허용 카탈로그는 좁히지 않음 — 기존 런 후방호환), 병합은 `harness.canon_json(fmt, domain)` 단일 리더가 한다. 현재 저작: **drug = 교육콘텐츠 캐논**(질환→원인→성분→근거 흐름 — multipage_bm 11블록 + 11대 구성요소[필수기재 footer 포함] · one_pager 4블록 1매 압축[CTA 없음]; 판매/순위/후기 직접 설득 블록은 시퀀스에 없음). 오버레이 부재 도메인(cosmetic 등)=포맷 캐논 그대로(no-op·바이트 불변).
- **디자인 토큰 도메인 오버레이 = `packs/<도메인>/design-tokens-overlay.json`(있으면)** — 같은 축의 디자인 언어 버전: `harness.design_tokens(domain)` 이 포맷 토큰(`packs/_format/design-tokens.json`) 위에 최상위 키를 교체 병합(신규 키 가법). drug = 클리니컬·에듀케이션 톤(tone_directions[0]) + `visual_guidance`. stub 아트디렉션 기본 톤과 실 LLM 프롬프트(storyboard-plan·keyvisual)가 소비한다.
- **수출(export) 패키지도 도메인 축이다** — `domain.json` 의 `export_package` 값이 제출 패키지 디렉터리·표지 라벨을 결정한다(`harness.export_package_profile`): 화장품 `kcia-advisory`=`export/kcia-package/`(협회 광고자문 · 레거시 디렉터리명 유지) · 의약품 `drug-ad-review`=`export/drug-ad-review/`(사전심의 제출 참고) · 건기식 `hff-pre-review`(예약). 소비처 = `export_package.py`(생성)·`advance-phase.sh`(04→done 게이트)·`render_runmd.py`(done 안내).
- **사람용 파생 설명 = [`canon-blocks.md`](../../core/docs/reference/canon-blocks.md)** — 캐논 블록의 사람용 해설이며, 정본은 어디까지나 `canon.json`(+오버레이 병합 결과)이다(불일치 시 canon.json 우선). 디자인 토큰의 사람용 설명은 [`design-tokens.md`](../../core/docs/reference/design-tokens.md).

---

## 3. 팩 구조 규약(짧게)

- **팩 = 순수 데이터**(json · md · 이미지 · csv). 실행 코드는 팩에 두지 않는다 — 로직은 전부 core(`core/scripts/*`)가 소유한다. 도메인·포맷을 바꿀 때 건드리는 것은 데이터 파일뿐이다.
- **새 규제도메인 추가** = 팩 폴더 신설(`packs/<도메인>/` + `domain.json` + `ruleset.json` + `sources/`) → core 로더가 레지스트리를 자동 조립. 단 진입 게이트([`../scripts/new-run.sh`](../../core/scripts/new-run.sh)의 허용 도메인 · [`../harness/state.schema.json`](../../core/harness/state.schema.json)의 domain enum)는 통제된 추가가 필요하다(자동 아님). ADK 심의를 붙이려면 `domain.json` 에 `adk_critic` 블록 + `.env` 에 그 env 를 추가한다(core 무수정).
- **새 산출물 포맷 추가** = `packs/_format/<포맷>/canon.json` 신설 + [`format-profiles.json`](../../packs/_format/format-profiles.json)의 `formats` 에 등록(label·aliases·canon 경로·active_phases·channel·status).
