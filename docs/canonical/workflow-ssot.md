# 상세페이지 생성 워크플로우 — 단일진실(SSoT)

> **이 문서의 지위:** 사람(차병환)이 재합의한 **정본 워크플로우**다. "무엇을 어떤 순서로, 각 단계가 무엇을 받고/내고, 도메인별로 어떤 심의자료를 참조하는가"의 **단일 진실**. 반복 재작성을 끝내기 위한 기준 문서.
> **관계:** 규칙·안전 불변식 SSoT = [`../AGENTS.md`](../../core/AGENTS.md). 코드가 *실제로* 하는 현재상태 = **코드 자체**(상세 스냅샷 = [`pipeline-stage-definitions.md`](../snapshots/pipeline-stage-definitions.md) — D-1 강등 참조라 불일치 시 코드 우선). **도메인 심의자료(룰셋·1차 출처) = 형제 [`../../packs/<도메인>/`](../../packs/)**(모노레포 팩 SSoT; 도메인·포맷 팩 조회 지도 = [`pack-catalog.md`](pack-catalog.md)). 전체 아키텍처 = [`harness-architecture.md`](../snapshots/harness-architecture.md). 기능 인벤토리 = [`feature-catalog.md`](feature-catalog.md) · 환경변수 조회 = [`config-reference.md`](config-reference.md) · 문서·구조 총지도 = [`README.md`](../README.md). **포맷 캐논 정본(SSoT) = `packs/_format/<포맷>/canon.json`**(4단계: blocks·types·evidence/brand_gated·required_root·components 통합; 사람용 파생 = [`canon-blocks.md`](../../core/docs/reference/canon-blocks.md)).
> **읽는 법:** 1~5단계 = 정본 플로우(각 단계: 입력·과정·결과물·도메인참조) + 포맷별 구성요소 가이드라인. 부록A = 전 단계 공통 불변식(사용자 스펙에 없었지만 빠지면 안 되는 것). 부록B = 도메인 심의 참조(→ [`pack-catalog.md`](pack-catalog.md) 이관 포인터). 부록C = **현재 구현과의 차이(Gap)**. 부록D = 미해결·리서치 필요. 부록E = 모노레포 마이크로커널 구조. 부록F = 운영 환경변수(→ [`config-reference.md`](config-reference.md) 이관 포인터). 부록G = 알려진 부채(이 SSoT 밖).
> 작성 2026-06-21 · 최신 갱신 2026-07-18 · **변경 이력(raw) = [`workflow-ssot-history.md`](../history/workflow-ssot-history.md)** — 이 문서 본문은 **최종 진실만** 담고, 시간순 변경 요약은 그 raw 파일에 append 한다.
>
> **유지보수(keep-in-sync):** 이 문서는 워크플로우 **정본**이고 본문은 **현재의 최종 진실만** 담는다(변경 이력·히스토리 서술 금지). `AGENTS.md`(규칙)·파이프라인(`scripts/*.sh`·`harness/*.json`·`phase-descriptors.json`)·팩(`packs/<도메인>`·`packs/_format`)·환경변수가 바뀌면 **같은 변경에서 이 문서 본문의 해당 구역을 최신 상태로 덮어쓴다**(예전 서술을 남기지 말고 교체). 시간순 **변경 요약 한 줄**은 별도 raw 파일 [`workflow-ssot-history.md`](../history/workflow-ssot-history.md)에 append 하고, 이 문서 헤더에는 **최신 갱신 날짜만** 둔다(정본을 이력으로 부풀리지 않는다). AGENTS.md 도 이 문서를 동반 갱신 대상으로 가리킨다.

> **구조(어디에 무엇이) — 모노레포·마이크로커널:** 운영 루트 = `core/`(도메인-중립 커널 = `prompts/`·`scripts/`·`harness/`(동결 스키마·레지스트리)·`docs/`·`runs/<id>/`). 규제도메인 데이터는 **형제** `packs/<도메인>/`(팩)가 소유한다 — `domain.json`(레지스트리 엔트리) + `ruleset.json` + `sources/`(협회·식약처 원문, 읽기 전용). 산출물 포맷 자산 = `packs/_format/`(`<포맷>/canon.json` 커버리지 + `format-profiles.json`). 새 도메인 = 팩 폴더 추가(레지스트리 자동 조립). 상세 = 부록E · [`../AGENTS.md`](../../core/AGENTS.md) 3번 절 디렉터리 지도.

---

## 공통 패턴 (모든 생성 단계 관통)

1. **다안 → 선택 OR 재생성** — 모든 생성 단계는 **여러 안**을 낸다. 사람은 (a) 그 중 하나를 **선택**하거나, (b) **프롬프트(자유 텍스트)를 줘서 다시 받는다**(보완요청·전부거절→재생성). *(Claude의 "선택지 클릭 + type something" 패턴.)* → 코드 매핑: 선택=`select.sh`, 재생성=`revise.sh`(자유텍스트 ISSUE → `feedback.json` 인라인 → 재생성). **재생성은 1급 동작**이며 다안(select)·단안(user) 게이트 **양쪽**에서 호출 가능하다(`revise.sh` 가 select 게이트의 '전부 거절→재생성'도 받는다).
2. **심의는 별도 벤더·원격 세션(생성≠심의 물리 격리)** — 생성과 **다른 벤더(Gemini)·원격 세션**이 심의한다. 운영 심의 엔진 = **원격 ADK(`adk-http`) 단일** — 원격이라 같은 스레드 자가비판이 구조적으로 불가능하다. 로컬 헤드리스 크리틱(`claude -p`)·`KCIA_CRITIC_CMD`·self-grading substring 가드는 **폐기**(`KCIA_CRITIC_ENGINE` 은 비우거나 `adk-http` 만 허용). 가드 = `scripts/kcia-check.sh`(모든 early-return '보다 먼저' 실행 → placeholder-autopass/verdict 재사용으로 우회 불가; 작업영역-밖 scratch·baseline 해시·매니페스트 무결성으로 critic 변조 차단; **verdict 의 idempotent 재사용(재개-스킵)은 리뷰된 1차 산출물 sha256 에 결박**[`.logs/review-binding.json`·골든제외]되어 심의 통과 '뒤' 산출물[키비주얼=선택안 옵션 디렉터리 index.html·styles.css·shots]이 바뀌면 재심의를 강제한다[생성후 편집이 재심의 없이 done 누수 차단, 외부리뷰 P0·`tests/test-verdict-binding.sh`]). 회귀 = `tests/test-gen-not-review-isolation.sh`. 근거 = Snorkel self-critique paradox(자가비판 98.1%→56.9%). **엔드포인트는 도메인별**(부록B) — `packs/<도메인>/domain.json` 의 `adk_critic` 블록(`url_env`/`host_env`/`app`/`author`)이 'ADK 구현됨' 마커이고, 그 env(예 화장품 `ADK_COSMETICS_CRITIC_URL`)로 원격 엔드포인트를 잡는다. **블록 없는 미구현 도메인**은 ADK 를 생략하고 룰엔진-단독으로 진행하되 "사람 확인 권장"으로 가시화한다(조용한 강등 금지). **도메인에 따라 참조 문서·기준이 달라진다**(부록B). 심의는 **사람 승인 뒤**에 온다(생성 → 사람 승인/선택 → 심의 → 통과/재생성).
3. **사람이 선언·확정** — 도메인·포맷 선언(0단계), 각 단계 승인·선택·반려는 모두 사람. AI 자동분류 없음.

> ⚠️ 이 외에도 흐름을 안전하게 굴리는 **하부 불변식**(환각 fail-closed·근거 페어링·저작권·필수기재·루프상한·상태 단일쓰기·이식성·생성 watchdog 등)은 부록A 에 모았다. 사용자 스펙에 없었지만 빠지면 환각·위법카피·상태손상으로 직결된다.

> **AG-UI·A2UI 투영(부가 표면 — 파이프라인·골든 불변):** 위 단계·게이트는 그대로 돌면서, 각 전이(생성 시작/종료·게이트·심의·페이즈 전이) 곁에서 **AG-UI 이벤트**(RunStarted·StepStarted·StepFinished·StateSnapshot·StateDelta·RunFinished·RunError·Custom)를 `runs/<id>/.events/agui.jsonl` 에 append 한다(항상·best-effort·`state.json` 미기록·실패해도 파이프라인 비차단·`.events` 골든 제외). 사람 게이트의 선택/승인 화면은 **A2UI(선언형 UI) surface**(`a2ui-surface.sh`)로도 파생돼 노출되고, 되돌아온 선택/승인은 `a2ui-action.sh` 가 현업 4동작(select/approve/revise/raise-limit)으로 위임한다(내부 SSoT = `state.json` + `gate.sh` 그대로 — **읽기전용 투영일 뿐, 새 단계·게이트 없음·파이프라인·골든 바이트 불변**). 상세 = 기능 인벤토리 [`feature-catalog.md`](feature-catalog.md) · 계획 [`../plans/agui-a2ui-projection-plan.md`](../plans/agui-a2ui-projection-plan.md).

---

## 0. 정의 — 유형 선언 (프로젝트 시작)

프로젝트는 **두 축을 사람이 선언**하며 시작한다(직교, 둘 다 강제):

| 축          | 값                                                                       | 무엇을 가르나                             |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------- |
| **규제도메인**  | `cosmetic`(화장품) · `quasi_drug`(의약외품) · `health_food`(건기식) · `drug`(의약품) | **무엇을 말할 수 있나** = 심의 룰셋·가이드 선택(부록B) |
| **산출물 포맷** | `multipage_bm`(여러장 BM 상세페이지) · `one_pager`(한장 홍보물)    | **어떤 구조로 만드나** = 캐논·실행 페이즈          |

- **강제:** 둘 다 미선언이면 진행 불가(친절 중단, 자동폴백 없음 — `ingest-bundle.sh` 의 cosmetic 자동폴백 제거됨). `new-run.sh --domain --format` 또는 `HARNESS_DOMAIN/HARNESS_FORMAT`.
- **결과물:** `state.json`(product 2축 + 진입상태) · `run.md`(사람용 "지금 할 일"). 게이트·심의 없음.

---

## 1. 브리프 (사람 주도 + 크롤 분석)

**입력 (사람이 폴더에 배치):**
- **워킹백워드** 파일을 지정 폴더에 사람이 직접 둔다. *md 가 아니면 md 로 변환 필요(이미지 포함).* → **씨앗 소스** `inputs/working-backwards.md`(`HARNESS_WB` 오버라이드); ingest 가 이를 **`runs/<id>/inputs/working-backwards.md`(런별 진실)** 로 스냅샷한다.
- **크롤링/클리퍼** 자료(경쟁·레퍼런스 사례)는 **별도 폴더**에 사람이 둔다. → 크롤 번들 = **`runs/<id>/inputs/bundle/`**(product.json·reviews.csv·images/); 동일 도메인 사례 **씨앗** = `inputs/examples/<도메인>/`(ingest 가 `runs/<id>/inputs/examples/<도메인>/` 로 스냅샷). 자사 자산 씨앗 `inputs/assets/` 도 `runs/<id>/inputs/assets/` 로 스냅샷된다.

**과정:**
- **(00a-intake · 조건부 · opt-in 새 정문) 첨부 폴더 하나를 통째로 받았을 때** — 현업이 파일마다 성격을 판단해 채널별(WB·번들·사례·자산·근거)로 수동 라우팅하던 것을, `intake.sh <첨부폴더> <run_id> --product --domain --format` 이 런 생성 + 원본 스냅샷(`runs/<id>/inputs/attachments/` + sha256, zip 읽기전용 해체)한 뒤, 세션 에이전트가 **파일별 보편 분류 + "결과물에 어떻게 반영될지"를 제안**(`00a-intake/intake-proposal.json`: 파일별 category[working_backwards·own/reference crawl·product_image·evidence:*·unknown]·route·reflect_preview·confidence·actions **+선택 role·provenance**[사람 확정 전용]) → 사람이 **표로 보고 한 번의 approve 로 일괄 확정**(확실 분류도 무승인 자동 라우팅 없음; `unknown` 잔존·sha256 불일치 시 approve 거부 fail-closed; docx→md 변환은 '변환됨' 표기) → 발효가 승인된 분류대로 **기존 채널에 결정적 라우팅**(새 반영 메커니즘 없음 — 기존 voc·claim-basis·00e·00g·차트결박·img-lint 게이트가 그대로 담당). **이 단계도 심의 면제**(phase-descriptors `review:false`, 닫힌 스키마 `guideline_leaf` $def 가 00g·00e·00a 를 함께 허용; 분류표는 광고 카피가 아니라 라우팅 결정 입력) → 승인 뒤 `kcia-check` 가 `review-exempt-autopass`. 기존 채널(new-run + ingest-bundle) 시작이면 00a 는 등장하지 않는다(후방호환 — no-intake 런 골든 바이트 불변). **분류 승인(00a)과 시험성적서 스펙 승인(00e)은 분리된 2관문**(성격이 다른 결정 — 라우팅 vs 효능 수치). **W-1=게이트 골격+오프라인 stub · W-2=온라인 실생성 표면(`prompts/intake.md`·`/intake` 스킬 = 세션 에이전트가 실제 분석·제안)·발효 `ingest.py apply-intake` 배선됨**(intake.sh→`/intake` 분석→승인→`gate.sh` 가 apply-intake[승인 분류→routed/ 라우팅]+ingest-bundle[routed/ 채널로 00-ingest 연쇄] 실행; 도메인·제품명은 state.json 사람 선언에서 읽음). 자사 크롤 없으면 apply-intake 가 최소 합성 번들(선언 제품명+리뷰0) 생성. **승인표 자산 미리보기·출처·역할(render-if-present)**: run.md 승인표는 자산 파일마다 (a) **썸네일 미리보기**(product_image 또는 래스터의 상대경로 이미지), (b) **출처 메모**(`provenance` — 예 "PDF 3쪽에서 추출"·"브랜드 제공 원본"), (c) **사람이 선언한 역할 태그**(`role` enum = `package_front`/`usage_shot`/`logo`/`ingredient_panel`/`other`)를 함께 보여준다. `role`·`provenance` 는 intake-proposal 의 **선택 필드**이고 **사람 확정 전용**(자동/VLM 픽셀 분류 없음 — 세션 에이전트는 파일명·맥락으로 제안만; `role` 은 `product_image` 에만 허용, 위반은 승인 전 검증 거부). approve 시 선언된 `role` 은 `routed/assets/asset-roles.json` 사이드카를 거쳐 `assets-manifest.json` 의 `role` 로 전파되고, 스토리보드 기획안(3-B)의 master_reference 선택이 `role=package_front` 를 우선한다(soft). 전부 가산·있을 때만 렌더 — no-intake·역할 무선언 런은 바이트 불변.
- (00-ingest, 결정적) 워킹백워드·리뷰·자산을 정규화 → 정량 단일출처(`ingest-bundle.sh`). **추출 프로파일(도메인별 VOC·페르소나·옵션 정규식·기능성 라벨·인증/효능 어휘·best-practices 블록순/힌트)은 `packs/<도메인>/ingest-profile.json` 이 소유**한다(3단계: `harness/ingest-profiles.json` + `ingest.py` 인라인 화장품 상수 폐지 — cosmetic 도 팩에서 읽고, 미선언 도메인은 공집합 추출로 fail-safe). 번들 스키마 매핑(naver 크롤-소스 포맷)은 도메인-독립이라 소스/포맷 프로파일 설계로 이월.
- **(00e-evidence · 조건부) 근거/참조 문서를 "문서만" 첨부(반영할 점 미지정)했을 때** — 인입이 fail-closed 대신 `spec_status:"pending"` 으로 기록하고, 조건부 페이즈 00e-evidence 에서 **세션 내 에이전트가 그 문서를 읽어 BM 에 반영할 내용을 추출·제안**(`00e-evidence/reflection-proposal.json`: 문서별 `kind` 추정·`claim`·원문 `reflection_points`) → 사람이 **승인(단안 approve)** 또는 보완요청(재생성). pending 이 풀려야 하류로 나간다(안 풀리면 advance 차단). **이 단계도 심의 면제**(phase-descriptors `review:false`, 00g 와 동형 — 닫힌 스키마 `guideline_leaf` $def 가 00g+00e 를 함께 허용) — 제안 초안은 광고 카피가 아니라 다운스트림 참조 입력이라, 승인 뒤 `kcia-check` 가 `review-exempt-autopass`(verdict=pass)로 자동 통과시킨다(단 autopass 직전 `validate-stage` 로 제안↔pending 문서 1:1·kind enum·포인트≥1 재검증; 실제 카피는 하류 심의). 일반 참조 문서(각주 인용 채널)에 더해, **시험성적서(`test_report`)도 00e 2차 관문으로 확장(W-3)** — 사람이 상세(기관·n·기간·수치·페이지)를 통째로 타이핑하는 대신 **intent 만 선언**(`{"kind":"test_report","reflect":true}`, 상세 생략)하면 인입이 `spec_status:"pending"` 으로 기록하고, 00e 세션 에이전트가 PDF 를 읽어 **스펙 초안**(기관·n·기간·판정문 원문·test_items[metric·series·change_pct·stat_note]·전후사진 페이지 후보 — 원문주의·지어내기 금지)을 `reflection-proposal.json` 의 optional `test_report` 블록에 제안 → run.md 스펙 표(지표/수치/페이지/판정문) → 사람 approve → `gate.sh`→`ingest.py apply-proposal` 이 확정 기록(pending 해소·`spec_origin:agent_proposed_human_approved`)하고 **인입과 같은 함수(`_extract_test_images`·`_promote_evidence_docs`)로 이미지 추출 + claim-basis 승격(doc-NN·doc-NN-tKK·image_path)** → gate.sh 가 state.evidence_on_file 재동기화 → 01-brief 부터 하류 동일 소비. ⚠ **안전 불변식(완화 아님·정밀화)**: 에이전트 제안은 **사람이 이미 `kind:test_report` 로 선언한 문서의 상세만** 채운다 — bare/일반 첨부를 제안이 test_report 로 승격하는 것은 **계속 금지**(validate-stage 00e + apply-proposal intent-match fail-closed "intent 선언 필요"). 즉 규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람 승인. 완전 선언(상세 포함)은 기존대로 인입 즉시 추출·승격(00e 미경유). 사람이 반영할 점을 이미 지정한 일반 문서면 00e 는 활성되지 않는다. 사례 분석(00g)과 함께 필요하면 순서는 **00-ingest → 00e-evidence → 00g-guideline → 01-brief**(단일 조건부 라우터 `common.sh compute_next_conditional`, `ingest-bundle.sh`·`advance-phase.sh` 공유). 승인 후 확정 스크립트가 매니페스트를 재기록해(`spec_origin:agent_proposed_human_approved`) pending 을 해소한다.
- **(핵심, 00g-guideline · 조건부) 크롤/클리퍼 자료를 분석해 "무엇이 왜 좋았는지"를 캡처** → 사람이 **승인(단안 approve)** 또는 보완요청(재생성). 동일 도메인 사례가 있을 때만 수행하며, 없으면 단일 번들(`inputs/bundle`)을 1개 사례로 폴백한다. **이 단계는 심의 면제**(phase-descriptors `review:false`) — 참조 노트는 광고 카피가 아니라 다운스트림 참조 입력이라, 승인 뒤 `kcia-check` 가 실제 룰엔진/critic 대신 `review-exempt-autopass`(verdict=pass)로 자동 통과시킨다(중복 심의 제거 — 금지표현은 생성 시 `validate-stage` 가 차단, 실제 카피는 컨셉·스토리보드·키비주얼에서 심의).
  - **방향을 3안으로 가르지 않는다(구 '유사점 3안 추출 + 선택' 파기).** 사례별 객관 분석(`example-analysis`, 정량·구조·구도/무드)은 유지하되, 종합 판단은 **자유텍스트 참조 노트**(`reference-notes`) 한 건으로 받는다.
  - 이 참조 노트는 `build_context` 의 **`REFERENCE_NOTES` 라벨**로 인라인되어 **컨셉·스토리라인·아웃라인·이미지** 생성에 직접 주입된다(soft 권고; **법=룰셋이 우선**). 효능·절대 표현은 넣지 않으며 **생성 시 `validate-stage` 룰엔진이 차단한다**(00g 심의 게이트는 면제 — `review-exempt-autopass`).
  - 사례의 감각적 "왜 보기 좋은가"(구도/무드)는 `example-analysis` 의 `reference_images[]`(composition_tags·mood_tags·why, 화이트리스트 어휘·fail-closed)와 `reference-notes` 의 `composition_notes` 로 캡처된다.

> **결정(크롤 분석 생성 경로) = insession 우선·하이브리드** *(2026-06-24 합의)*
> 00g-guideline(크롤 분석)은 파이프라인에서 **유일하게 날것 자료(상세 이미지·리뷰)를 직접 읽어야** 의미가 나오는 단계라, 헤드리스 서브프로세스(이미지 접근 취약·권한대기 행)보다 **세션 내 직접 생성(insession)** 이 품질·안정성 모두 낫다(insession 은 생성쪽 권한대기·600초 행도 제거).
> - **현재 지원(코드 진실, 2026-06-25 in-session 전환 완료):** 생성 기본값이 **세션 내(insession) 자동선택**으로 바뀌었다 — Claude 세션 + 실엔진(STUB_MODE 아님)이면 슬래시 `/<stage>`(=세션 내 스킬) 또는 `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> <id>` 가 세션 안에서 생성하고 스크립트는 검증·전이만 한다. **키비주얼 포함 전 생성단계 지원**(키비주얼 렌더는 전이 단계의 Playwright 후처리로 분리 — PR2-E). 격리 유지 — 생성은 세션 안(claude), **심의는 다른 벤더·원격 ADK**(`adk-http`)라 자가비판 충돌이 구조적으로 불가능하다(로컬 self-grading 가드 폐기 — 부록B). 가드: generate 단계에서만·1차 산출물 없으면 fail-closed·STUB_MODE(stub/오프라인)는 명시 insession 이라도 subprocess 강제(CI/골든 결정성).
> - **구현됨(2026-06-25):** ① 하이브리드 = 정량 신호/구조는 결정적 `examples_analysis.py`, 감각 레이어(`reference_images`·`composition_notes`·`why`)만 insession(`skills/guideline/SKILL.md` 사례별 fan-out + 체크포인트·idempotent) ② `run-stage.sh guideline --emit-context` 가 EXAMPLE_DIRS 방출(단일 출처 헬퍼 `common.sh:guideline_example_dirs` — emit-context 와 본 디스패치 공유) ③ `/guideline` 운영자 커맨드(현업 비대상, `sync-skills.sh` 배포). **잔여**: ④ 서브프로세스 "/tmp·examples 폴백" 버그는 **별도** 수정(insession 이 헤드리스 경로를 가리지 않게).

**결과물(현재 구현 기준):**

| 산출물 | 스키마 | 핵심 |
|---|---|---|
| `00-ingest/voc.json` | voc | 정량 단일출처(키워드빈도·평점·옵션·페르소나 신호 + **사실 후크**: `product_facts`[구성수량·성분함량·구성품 — WB 결정적 추출·fail-closed·부정/계획 절 제외]·`offer`[가격·할인율 — product.json 추출, 가격은 여기 한 곳에만]·`top_phrases`[규제어 격리 상위 어휘 + `_efficacy_filtered`]) — 신규 필드는 모두 optional(후방호환) |
| `00-ingest/claim-basis.json` | claim-basis | 효능근거표(기능성 상태·고시성분·인증·실증·unsupported) — **근거 없으면 unknown(주장 불가)**. **다제품 WB 는 선언 제품(state.product.name)으로 스코핑 추출** — `ingest-bundle.sh` 가 선언명을 claim-basis·voc 에 전달하고 `ingest.py` 가 WB 를 제품 tier(마커 품은 헤딩 ≥2)로 분할해 그 제품 스팬(중첩 하위섹션·조상 카테고리 리드-인 포함, 형제·타카테고리 제외)에서만 func·evidence·certs·product_type·notified·product_facts 를 뽑는다. 매칭 = 제품명 값/헤딩 토큰 부분열(브랜드 접두·괄호 변이·용량 접미사 흡수, 최장·최구체 우선). 마커 없거나 모호·미발견이면 **전체-WB 폴백(fail-open)** — 단제품 골든 바이트 불변. **스코핑 상태 태깅(문서 레벨, optional)**: 국소화 성공이면 `product_scope:"declared"`, 다제품인데 국소화 실패해 전체-WB 를 쓰면 `product_scope:"unscoped"`(사람 확인 권장 신호), 단제품/스코핑 미발동이면 필드 생략(골든 불변). `unscoped` 일 때만 `build_context` 가 생성 컨텍스트에 소프트 권고 1줄(`PRODUCT_SCOPE_ADVISORY` — 여러 제품이 섞였을 수 있으니 인용 전 확인)을 실어 하류·RA 에 가시화한다(soft 권고, 차단 아님) |
| `00-ingest/assets-manifest.json` | assets-manifest | 자사 자산(디자인 src 허용) vs 번들 이미지(src 금지). 자사 자산 엔트리는 **선택 `role`**(00a-intake 승인에서 사람이 선언한 세부역할이 `routed/assets/asset-roles.json` 사이드카를 거쳐 전파됨 — master_reference 가 `package_front` 우선 선택하는 soft 힌트, 미기재=역할 무구분·골든 불변) |
| `00-ingest/best-practices.json` | best-practices | 크롤 블록별 구도/컷유형(텍스트, no-pixel) |
| `00-ingest/evidence-documents.json`(조건부) | evidence-documents | **근거 문서 첨부 매니페스트(링크 B)** — 규제 근거 실파일(시험성적서·결과보고서 등) 목록{id·filename·ext·bytes·sha256·grade·linked_claim_ids `(+반영 선언 시 reflect·claim·verdict_text·test_report)`}+source{channel,count}. **유효 문서 1건 이상일 때만 생성**(없으면 파일·`state.artifacts` 항목 없음 → 골든 불변). **`reflect:false`(첨부-전용)면 첨부 전송이지 주장 실증 아님**(첨부 id 심의 실증셋 미편입); **`reflect:true`(기본)면 인입이 `doc-NN` 실증 엔트리로 승격돼 반영 의무를 진다**(부록A-16) — 아래 노트 참조 |
| `00e-evidence/reflection-proposal.json`(조건부) | reflection-proposal | **근거 문서 반영 제안 초안(G5)** — 스펙 미정(`spec_status:pending`) 문서가 있을 때만 세션 내 에이전트가 작성. pending 문서와 **1:1**(id+NFC 파일명), 문서별 `kind` 추정(일반 참조 enum: certification·paper·patent·ingredient_dossier·brand_story·guide·general·`claim`·원문 `reflection_points`≥1; **+ W-3: `test_report` 도 수용** — 단 사람이 인입에서 `kind:test_report` 로 intent 선언한 pending 문서에 한해 스펙[verdict_text·grade·기관·n·기간·test_items·전후사진 페이지] 초안 제안, bare/일반 문서를 test_report 로 승격은 여전히 fail-closed[intent-match]). **단안 approve → `review-exempt-autopass`**(phase-descriptors `review:false`) → `gate.sh review` 가 `ingest.py apply-proposal` 로 매니페스트 재기록(pending 해소·`spec_origin:agent_proposed_human_approved`; 일반 문서는 claim-basis **미승격** = 각주 인용 채널). 스펙 없는(문서만 첨부 안 한) 런엔 미생성 → 골든 불변 |
| `00g-guideline/examples/<id>/example-analysis.json` | example-analysis | 사례별 **why_good[]**(grounded_in 실측신호 강제) + **reference_images[]**(구도·무드 카탈로그, 화이트리스트 어휘·fail-closed) |
| `00g-guideline/reference-notes.json` | reference-notes | **크롤 참조 노트(자유텍스트)** — flow_refs(전개 플로우)·composition_notes(구도/무드)·notes. 효능·절대 표현 금지(**생성 시 `validate-stage` 룰엔진 차단**; 심의 게이트는 **면제**=`review-exempt-autopass`, phase-descriptors `review:false` — 광고 카피 아닌 참조 입력이라 중복 심의 제거). **단안 approve → 승인 즉시 자동 통과**. `build_context` 의 REFERENCE_NOTES 라벨로 컨셉·스토리라인·아웃라인·이미지에 주입(soft 권고, 법=룰셋 우선). 구 `project-guideline.json`(A-trust/B-usevalue/C-composition 3안)은 파기 |
| `01-brief/brief.json` + `brief.md` | brief | **PR/FAQ**(헤드라인·문제·차별점·VOC인용·internal FAQ=규제리스크 ≥2건 강제·민감표시 sensitive_labels·선언 2축 output_type). 구 '확정 유사점'(confirmed_guideline)은 스키마에 후방호환 optional 로만 잔존(stub 미채움) — 참조는 reference-notes 가 직접 담당 |

**도메인 참조:** 효능 표현 가능범위 = 도메인 룰셋(부록B). 근거 없는 효능 배제는 전 도메인 공통.

> **근거 문서(시험성적서·결과보고서) 첨부 = 협회 제출 패키지로 '실어나르기'(첨부 전송 ≠ 주장 실증):** 규제 근거 실파일(pdf·hwp/hwpx·doc/docx·xls/xlsx·png/jpg/jpeg/webp)을 받아 최종 협회 광고자문 제출 패키지에 **첨부 파일 + 목록**으로 실어나른다. **전면 조건부**(근거 없으면 아무것도 안 생김)인 3링크로 구현된다. 상세 설계 = `docs/_archive/evidence-attachment-plan.md`.
> - **입력 채널(링크 A, `ingest-bundle.sh`):** 근거 소스 우선순위 = `HARNESS_EVIDENCE_DIR`(env 로 폴더 지정) → `<번들>/evidence/`(크롤 원본 번들 안 evidence 폴더) → 없음. claim-basis 검증 뒤(대조 데이터 준비 후)에 돌며, 매 인입마다 `runs/<id>/inputs/evidence/` 로 **정확복제 스냅샷**(먼저 비우고 현재 유효 문서만 재적재 → 이전 런에서 지우거나 이름 바꾼 첨부의 stale 사본이 부분 축소[3→2건] 때도 안 남는다). 최상위 파일만 단층 순회하며 **심볼릭·하위 디렉터리·특수파일·화이트리스트 밖 확장자·`..`/경로구분자·0바이트·NFC 정규화 후 파일명 충돌·파일당 20MB·총 50MB 초과는 전부 fail-closed**(조용한 무시 없음; 상한 env override = `HARNESS_EVIDENCE_MAX_FILE_BYTES`·`HARNESS_EVIDENCE_MAX_TOTAL_BYTES`). 예약 사이드카 `inputs/evidence/index.json`(사람이 파일명→`grade`·`linked_claim_ids` 선언)은 문서목록에서 제외되고 메타로만 반영되며, 그 외 `.json` 은 거부한다.
> - **매니페스트(링크 B, 신규 `00-ingest/evidence-documents.json`):** NFC 파일명 정렬순 `doc-NN` 부여 + `{id·filename·ext·bytes·sha256·grade·linked_claim_ids}` + `source{channel,count}`. **유효 문서 1건 이상일 때만 생성**하고, 0건이면 파일과 `inputs/evidence/` 를 정리(제거)한다 → **골든 불변**. 4종 산출물 regen-skip(재생성 생략)과 **독립**으로 매 인입마다 재평가되고, 스냅샷이 전부 끝난 뒤 마지막에 원자적으로 기록된다. `state.artifacts` 에는 **존재 시에만 추가·부재 시 제거(prune)**(근거 있던 런 정리 후 stale 항목 잔존 차단). 사이드카 무결성 = index.json 스키마 검증(오타·미지 필드 조용한 드롭 차단) + 선언 파일명이 복사된 문서와 **정확히 1:1**(존재하지 않는 파일명 키 = fail-closed), `linked_claim_ids` 는 `claim-basis.json` 의 `evidence_on_file[].id` 와 **대조만**(미존재 id = fail-closed)한다. **반영 선언(신설, 첨부=반영 계약):** 사이드카/매니페스트 문서 객체는 `reflect`(boolean; 미기재=true 반영 의무·false=첨부-전용)·`claim`(입증 내용 한 줄)·`verdict_text`(판정문 원문)·`test_report`(institution·sample_size·duration·method·measured_values[정량이면 전/후 쌍, 정성이면 null])를 optional 로 담는다. 사이드카 `index.json` 은 런에 스냅샷되지 않으므로 반영 선언의 유일한 런내 출처는 이 매니페스트다(인입이 항상 `reflect` 를 명시 기록). `reflect:true` 인데 `claim`/`verdict_text`/`test_report`(기관·n·기간) 결손이면 인입 fail-closed(로컬 검증기가 조건부-required 미지원이라 스키마가 아닌 `ingest.py` 코드가 강제). **단 G5 이후 — 일반 참조 문서(`kind≠test_report`)를 반영 스펙(claim·reflection_points) 없이 첨부하면**(반영할 점 미지정) 인입이 fail-closed 대신 `spec_status:"pending"` 으로 기록하고, 조건부 페이즈 `00e-evidence` 가 에이전트 제안→사람 승인으로 해소한다(pending 이 남으면 하류 advance 차단; 승인 시 매니페스트가 `spec_origin:agent_proposed_human_approved` 로 재기록). **시험성적서(`test_report`)**: 사람이 `kind:test_report` 로 **intent 선언(상세 생략)** 하면 W-3 로 `spec_status:pending` → `00e-evidence` 2차 관문(에이전트 스펙 초안 → 사람 승인 → apply-proposal 확정·추출·승격); 그러나 **`kind` 선언 없이 `test_report` 객체만 불완전하게 준 경우(추론형)는 여전히 hard-fail**(효능 실증 우회 금지 — 규제 성격 선언은 사람의 몫). 상세는 1단계 00-ingest 승격 노트·부록A-16·`docs/_archive/evidence-content-integration-plan.md`.
> - **export 반영(링크 C, `export_package.py`):** 매니페스트가 있을 때만 협회 제출 패키지에 `kcia-package/evidence/`(첨부 실파일) + `package.json.evidence_documents{id·filename·grade·sha256·bytes·linked_claim_ids·reflect(+reflect:true 면 reflected_in[반영 블록 라벨])}` + README `## 첨부 근거 문서` 표(**기존 텍스트 근거표[WB 추출 실증]와 별개 절**; 반영/반영 블록 열 포함)를 만든다. 진입 시 orphan 가드(근거 파일은 있는데 매니페스트 부재 = fail-closed) → 정확집합 대조(디스크 정규파일 집합 == 매니페스트 filename 집합 + 각 sha256 일치) → 안전순서 무결성 복사(바이트 읽기 전 lstat·경계·크기 검사 → 원본 재해시 대조 → 복사 → 복사본 재해시)로 조용한 누락·변조를 fail-closed 한다. `reflected_in` 라벨은 done 게이트와 **동일한 `check_evidence_reflection.reflected_map` 단일 출처**(drift 방지). export 는 기록만 하고 반영 누락의 강제 멈춤은 done 게이트가 한다(아래). **근거 없는 런은 evidence/·필드·표·상태 항목이 전혀 안 생겨 기존 패키지가 바이트 불변.** 4단계 키비주얼 노트에도 재기재.
> - **반영 강제(조기 `validate-stage` 04 게이트 + done 백스톱, `check_evidence_reflection.py`):** `reflect:true` 근거 문서가 최종 산출물에 반영 블록(plan 블록이 그 `doc-NN` 을 `claims[].evidence_ref` 또는 각주로 인용; plan 생략 포맷은 선택 옵션 HTML 에 `doc-NN`)으로 실리지 않았으면 **전이 차단**(첨부만 되고 내용 반영 못 한 채 완료 금지). 근거 없음/첨부-전용(reflect:false)만 있으면 즉시 통과(no-op, 골든/동작 불변). 읽기 전용(state 미기록). **조기 게이트(외부리뷰 P0 수정): `validate-stage` 04-keyvisual 이 선택 HTML 반영을 export·심의 前에 강제**한다(approve 선택안 재렌더 직후 + `gate.sh` export 前 validate 二重) → 반영 실패가 **재렌더 가능한 시점**에 잡혀 섹션 PNG 스테일·스테일 패키지 export 를 막는다. `advance-phase.sh` done 분기가 **최종 백스톱**(다중 방어). (옛 구조는 done 게이트에만 있어 render·심의·export 後에야 막혀 재렌더 불가·스테일 패키지·pass verdict 잔존이었다.) `--to done` 은 금지(done 은 자동 전이로만).
> - **첨부의 두 모드(불변):** ① `reflect:false`(첨부-전용) 는 심의 실증에 편입되지 않고(옛 F5) `linked_claim_ids`↔claim-basis 대조도 '연결 표기용'일 뿐이며 심의 게이트는 그대로다. ② `reflect:true`(기본) 는 사람 선언 내용(claim·verdict_text·test_report)이 `claim-basis.evidence_on_file` 에 `doc-NN` 실증으로 **승격**되나(AI 가 아닌 사람 선언), 심의를 **우회하지 않고**(5요소 게이트 통과 필요) 카피는 `verdict_text` 원문만 쓴다. 미완/불완전 선언=인입 fail-closed(부록A-16).
> - **인입-완료 표식 + 양성-완료 전이 게이트:** 이 근거 스냅샷을 포함해 어떤 run-input 을 건드리기 전에 `ingest-bundle.sh` 가 미완 표식 `00-ingest/.ingest-incomplete` 를 원자적으로 쓰고 인입이 완주한 뒤에만 제거한다. 표식이 있으면 하류가 fail-closed·재-인입 강제, `advance-phase --to` 로 00-ingest 를 떠나는 세 출구(00e-evidence·00g-guideline·01-brief; G5 로 allow-list 확대) 모두 '양성 완료'를 요구한다(상세 = 부록A-17).

---

## 2. 컨셉 / 빅아이디어

**과정:**
- 브리프 자료(VOC·근거표)와 크롤 참조 노트(`REFERENCE_NOTES`, soft 권고·법=룰셋 우선)를 바탕으로 AI가 **RTB(Reason To Believe) + 키메시지**를 도출 → **여러 안** 제안(컨셉 축별 독립 생성, mode collapse 방지).
- 통과 가능한 안들의 **상대 품질**은 soft 4축(차별성·소비자 연관성·구매전환력·이해용이성) + `VOC` 정합으로 pairwise 비교해 `recommendation.json` 순위를 매긴다(근거성·구체성 = `claim_strength`↔`evidence_ref` 하드게이트, 심의안정성 = 룰셋 금지어로 이미 강제; 4축은 미승인 효능·절대표현을 정당화하지 못한다 = 법·근거 우선). 제품군 특화 예시는 도메인 지침에 박지 않고 per-run `REFERENCE_NOTES` 로 받는다.
- **사람이 보완요청(→재생성)하거나, 추천된 안 중 하나를 선택(select).**
- **선택하면 → 심의가이드를 별도 세션의 AI/서브에이전트로 검증**(도메인별, 부록B; 선택안만 검사). **부족하면 RTB·키메시지 단계로 회귀**, 문제없으면 다음 단계.

**결과물:**

| 산출물 | 스키마 | 핵심 |
|---|---|---|
| `02-concept/concept-axes.json` | concept-axes | 컨셉 축 정의(≥2; 예 A-efficacy/B-emotional/C-science) |
| `02-concept/options/<축>/rtb.json` | rtb | 축별 RTB(claim·claim_strength·evidence_ref·review_status) |
| `02-concept/options/<축>/key-message.json` | key-message | 축별 키메시지(slot=emotional/legal·헤드라인; 감성=voc_phrase 인용 강제) |
| `02-concept/recommendation.json` · `decision.json` | recommendation·decision | 추천 순위 + 사람 선택 |
| `02-concept/review/concept-verdict.json` | verdict | 심의 결과(선택 뒤 생성) |

---

## 3. 콘티 / 스토리보드

> ★ **모든 산출물(여러장 BM · 한장)이 같은 과정을 거친다.** 🟢 **전 포맷 완주** — `packs/_format/format-profiles.json` 의 `active_phases`(03·04)·`<포맷>/canon.json` 커버리지 게이트·`render.py` 포맷 폭(860)·`final_page_phase` 필수기재 게이팅이 전 포맷에서 작동한다. 스토리보드(03)·키비주얼(04) 생성 프롬프트(`prompts/keyvisual.md`)는 **format-aware**(`DELIVERABLE_FORMAT` 입력 + 포맷별 레이아웃: BM 860 세로 / one_pager 1매 포스터). **⚠️ 단 stub(오프라인/CI) 키비주얼은 generic 세로 템플릿**(폭·블록 시퀀스는 포맷 반영하나 레이아웃은 단일 — 결정적 테스트 픽스처; 실 LLM 경로만 포맷-native 레이아웃). 이 단계의 본질 = **포맷별 스토리라인·기획안을 "좋은 키비주얼이 나오도록" 기획**.

**3-A. 스토리라인 (서브스테이지 = `outline`, 다안 select):**
- **포맷별 구성요소 가이드라인(5단계)을 입력으로**, 브리프 + 컨셉 결과물을 바탕으로 **스토리라인 여러 안(A·B·C, 최소 3안 — 이슈3a)** 제안(BM=10대 구성요소 캐논 · 한장=1매 압축 캐논(카탈로그 4요소·필수 2); 모두 `packs/_format/<포맷>/canon.json`). 필요하면 도메인별·산출물별 양식을 리서치해 매핑.
  - **최소 3안 3중 강제(이슈3a):** 프롬프트(3안 이상 지시) + 스키마(`concept-axes.minItems=3`) + 게이트(`validate-stage` 옵션 디렉터리 ≥3 + `recommendation.ranked` ≥3 fail-closed)로 강제. concept·storyboard-outline·keyvisual 다안 페이즈 공통. (stub: A=대안전개·B=기본·C=솔루션/근거 선행.)
- **가이드라인 커버리지 체크 (스토리라인 단계부터):** 생성된 스토리라인이 포맷 가이드라인의 **필수 구성요소를 빠짐없이 담았는지** 게이트로 검증(누락 시 보완/재생성). 선택 전 다옵션은 **각 옵션 독립 평가**(어느 한 옵션이라도 필수 누락이면 fail). → 코드: `check_canon_coverage.py --scope outline`(커버리지 SSoT = `packs/_format/<포맷>/canon.json`, 포맷별로 `format-profiles.json` 의 `canon` 가 `<포맷>/canon.json` 선택).
- 제안된 스토리라인 중 **근거자료가 필요한 내용**(효능·과학성)은 **논문·학술자료를 검색해 매핑**한다. **온라인**: storyboard-outline 생성 중 실증 트리거가 감지되면 `scripts/lib/evidence_search.py` 가 **OpenAlex 를 직접 HTTP 로 검색**(MCP 아님·이식성)해 `sources/results.json`(`engine=openalex`)에 발견 후보를 싣는다 — 생성이 실제로 나는 시점에만 호출한다. **오프라인/CI**: `search_stub`(`engine=manual`·빈 결과)로 폴백해 골든 바이트가 불변이다. **환각 안전**: OpenAlex 결과는 **검증 전 발견 후보**라 `grade` 는 발견 강도일 뿐(자동 인용 0 · ruleset 의 근거 등급과 불일치)이고, `evidence_sufficient` 기본값은 `false`(opt-in 문턱 `HARNESS_OPENALEX_MIN_RELEVANCE` 설정 시에만 상향), 채택은 사람(현업/RA)이 한다. 엔진 선택 = `HARNESS_EVIDENCE_CLI`(openalex|stub · 기본 openalex · 온라인에서 명시 stub=fail-closed) · 세부 = `OPENALEX_MAILTO`·`HARNESS_OPENALEX_TIMEOUT`·`HARNESS_OPENALEX_RETRY`·`HARNESS_OPENALEX_BACKOFF`·`HARNESS_OPENALEX_MIN_RELEVANCE`. 허용 등급만 인정(SCI(E)·전문학회지·인체적용/인체외시험; 보도자료·블로그 거부).
- **사람이 반려 → 스토리라인 재생성**, 선택(select) → **심의가이드 체크** → 통과 시 다음.

→ **스토리라인 결과물:** `03-storyboard/outline/options/{A,B,C}/storyline.json`(최소 3안)(채널 프로파일 + 블록 순서/타입/위험차등(risk_tier)/실증게이트(evidence_required·enabled_if)) · `sources/results.json`(근거자료 매핑) · `outline/recommendation.json`·`outline/decision.json` · `outline-verdict.json`.

**3-B. 기획안 (서브스테이지 = `plan`, 단안 approve):**
- **① 전역 아트디렉션 먼저(이슈4 P0-ⓠ):** 블록보다 **먼저** `03-storyboard/art-direction.json`(브랜드킷 — `master_palette`·`color_temp`·`lighting`·`typography`·`master_reference`[자사 자산 1장 — ASSETS_MANIFEST 에 `role=package_front` 자산이 있으면 **그것을 우선 선택**하는 soft 힌트, 게이트 아님·없으면 대표 제품컷 1장])을 **한 번** 정의한다. 모든 블록 `visual.concept` 가 이를 **상속**(블록은 `composition`·`subject`·`aspect_ratio` 등 고유만) → 블록마다 다른 경쟁사 스타일에 앵커되던 톤 분열 제거. **블록 `palette` 는 `master_palette` 의 부분집합(+비어있지 않음)이어야 한다**(`validate-stage.sh` fail-closed). revise 시엔 아트디렉션을 **보존**(전 블록 공통 안정 브랜드킷 — 최초 1회만 정의).
- ② 스토리라인 확정본 바탕으로 **기획안(선택 스토리라인의 plan 블록 전부) 생성** → 사람 확인/반려. (경쟁 N안이 아니라 확정 스토리라인의 단일 구체화 — `multi=0`.)
- **가이드라인 커버리지 체크 (plan 에서도 다시):** 기획안이 포맷 가이드라인의 구성요소 커버리지를 **재충족**하는지 게이트 검증(스토리라인→기획안 구체화 중 구성요소 누락 방지). → `check_canon_coverage.py --scope plan`.
- 확인되면 **심의가이드 체크**.

→ **결과물:** `03-storyboard/art-direction.json`(전역 아트디렉션 — `harness/art-direction.schema.json`) · `03-storyboard/plan/NN-<type>.json`(블록별 헤드라인·본문·`visual.concept{subject·composition·mood·palette(⊆master)·reference}`·claims↔footnotes 페어링) · `plan-verdict.json`. **그리고 다음 단계로 넘길 때 = 참조디자인·구도 등 각 도메인별·산출물별 디자인 양식**으로(필요하면 리서치해 매핑).
  - (tone 서브스테이지를 기획안 내부로 흡수 — 구도/무드/참조를 plan-block `visual.concept` 에 직접 산출. tone.json/slot_concepts 제거, tone-direction(s).schema 와 `registry.json` 의 tone 매핑은 레거시 후방호환 잔존만.)
  - `build_context` 가 `ART_DIRECTION` 라벨로 전역 톤을 주입 → 블록 생성이 master_palette/톤을 상속. (stub 은 build_context 미사용 → 골든 불변.)

**결과물(BM 기준) = 캐논 정렬:** 스토리라인/기획안의 블록은 **`canon-blocks.md`(15블록 + `motionDemo` 확장) + 10대 필수 구성요소**를 따른다. 사용자가 준 BM 9구성요소는 이 캐논(필수 10대 = 9 + 🐻대웅 배너)에 **이미 1:1 매핑**돼 있다(4단계 표).

> **결정적 금지블록 게이트(RCA 8장):** 포맷이 허용하지 않는 out-of-scope 블록은 심의(원격 ADK) 이전에 **결정적 룰**로 막는다. SSoT = `packs/_format/format-profiles.json` 의 `formats.multipage_bm.disallowed_blocks = ["cta","header","nav","point"]`(cta=구매전환 UI[사고 원점]·header/nav=제거된 website 포맷 크롬·point=미사용 확장). `scripts/lib/validate_storyboard.py` 가 outline·plan 에 금지블록이 나타나면 fail-closed 한다(기존 `validate-stage 03` 경로), `scripts/lib/check_canon_coverage.py` 는 outline/plan/design 스코프에서 `disallowed_present`(가시화 필드; `harness/canon-coverage.schema.json` optional·design 스코프는 선택 안 된 B/C 포함 **모든** 옵션 HTML 스캔)를 표면화한다. 옵션 HTML(04) 전수검사는 신규 `check_html_blocks.py` 가 맡는다(4단계 노트). ⚠ `footer`·`mainPositioning`·`ingredientDetail` 은 **금지하지 않는다** — active 인 의약품(drug) 도메인이 정당·필수로 쓰기 때문이다(footer=광고심의필·제조판매원 등 필수기재 컨테이너[test-drug-golden 준수형], mainPositioning·ingredientDetail=품목 심화 블록[GOOD 런 ursa-lineup-2026]). 포맷-레벨 금지는 **도메인-불문 스코프-밖 블록만** 담는다. `one_pager` 는 금지목록이 없다(cta 는 한장 홍보물의 정당 블록).

> **가격 단일출처 값-대조 가드(RCA 8장 · AGENTS 6번 절):** 신규 `scripts/lib/check_html_blocks.py` 가 plan 카피 필드(03, `--plan-price` 로 `validate-stage 03` 배선)와 옵션 HTML 가시 텍스트(04)에서 **금액 규모 패턴**(천단위 콤마 또는 3자리+ 정수) + '원' 을 잡아 `voc.offer.price` 와 **값-대조**한다 — 일치=통과(정식 공급값), 불일치·offer 부재=fail-closed. 1~2자리 카운트/단어인 '3원칙'·'원료'는 오탐을 피하고 '9,900원입니다'(조사·어미형)는 포착한다. 부록A-3 '가격은 `voc.offer` 한 곳에만'을 게이트로 강제하는 장치다.

---

## 4. 키비주얼 / 아트워크

**과정:**
- 확정 기획안 바탕 **디자인 여러 안**(옵션 A·B) 제공.
- **사람이 선택 → 별도 승인 또는 보완요청(→재생성).** (04-keyvisual 만 선택 후 별도 사람 승인 = 2중 승인.)
- **심의가이드 체크**(design-verdict) → 완료.

**산출물 = 최초 정의한 포맷:**

| 포맷 | 산출물 | 캐논 |
|---|---|---|
| `multipage_bm`(여러장 BM) | 네이버 스마트스토어 860px HTML/CSS 세로 섹션스택 + 협회 제출 패키지 | `canon-blocks.md`(15블록/10구성요소) ✅ |
| `one_pager`(한장) | 1매 압축 포스터형 HTML/CSS(폭 860px·max 1200px·gif 불가) | `one_pager/canon.json`(커버리지 존재, ⚠️자기라벨=STUB) · 키비주얼 프롬프트 format-aware(실LLM=1매 압축 포스터 분기) · stub=포맷 무관 generic 세로 템플릿 |

**결과물:** `04-keyvisual/options/{A,B,C}/index.html`(최소 3안 — 이슈3a)(+`styles.css`·`shots/`) · `design-manifest.json`(섹션별 캡처·self_review) · `04-keyvisual/image-manifest.json`(블록별 생성 이미지) · `canon-coverage.json`(구성요소 커버리지, scope=design) · `recommendation`·`decision` · `design-verdict.json` · `export/kcia-package/`(협회 제출).

> **생성 이미지 연결(이슈4 P0-①):** 키비주얼 생성 '전'(run-stage)·렌더 '전'(render-design)에 `scripts/lib/image_engine.py` 가 plan 블록 `visual.concept` → `04-keyvisual/generated/NN-type.{png,svg}` + `image-manifest.json` 을 선행 생성한다(보유 락 재사용 — `gen-images.sh` 재락 회피). 키비주얼 HTML 은 `IMAGE_MANIFEST` 라벨의 자사 생성물을 블록 `<img src>` 로 **우선** 참조(없으면 자사컷 → 도형/타이포 박스). 엔진=`resolve_image_engine`(**오프라인[`HARNESS_OFFLINE=1`]일 때만** 결정적 stub SVG → 골든 불변; 온라인은 실엔진 강제 — 온라인 키없음/명시 stub = fail-closed[무음 stub 강등 금지]). `render-design.sh` 는 HTML 이 참조하는 생성 이미지가 디스크에 **실재하는지 fail-closed** 검사(깨진 이미지 렌더 차단) — 단순 파일명 존재가 아니라 **렌더(Playwright `file://`)와 동일하게 'ref 가 든 HTML/CSS 파일의 디렉터리 기준'으로 상대경로(`../` 깊이 포함)를 풀어** 디스크 존재를 확인하므로, 깊이가 틀려(예 `../`×4, 정답 `../`×5) 렌더 때 깨질 이미지도 **렌더 전에 fail-closed** 로 잡는다(옛 tail-only 검사는 깊이를 버려 거짓 통과 → done 누수 사고). 구현은 신규 `scripts/lib/check_render_refs.py`(ref 디코드는 `img_lint._refs` 공용 SSoT 재사용), 범위는 **단계 A = `04-keyvisual/generated/` 만**(폰트·자사컷 확장은 폰트 경로 정본화[`assets/fonts/`] 선결 후 단계 B 보류), 게이트 순서 불변(존재성→저작권→beforeAfter→render). 생성측 예방으로 `prompts/keyvisual.md` 에 상대경로 `../`×5 깊이 가이드를 둔다. 회귀=`tests/test-render-existence-depth.sh`. 생성물은 gitignore(재현 가능 출력). 같은 `check_render_refs.py` 게이트가 **그래픽 블록(`visual.render_mode="html_only"`)에 생성 PNG `<img>` 가 박힌 경우도 fail-closed** 로 차단한다(그래픽 블록은 HTML/SVG 레이어 전용 — 아래 임상 차트 단락의 html_only 설명 참조).

> **이미지 실생성 직전 '최종 점검'(비용·비가역 앞 결손 점검 — 생성 쪽, 심의 아님):** keyvisual 에서 `image_engine` 실생성 호출 직전(`run-stage.sh`), 읽기전용 `scripts/lib/image_preflight.py`(state 미기록)가 결손 권고(`completeness_advisor`)와 예정 생성 장수(`image_engine.planned_image_summary`)를 종합해 "무엇이 빠졌고 → 그대로 가면 결과가 어떻게 나올지 → 그림 몇 장 예정"을 평이 한국어 digest 로 보여준다. **임계 결손**(임상 측정치가 등록됐는데 시험성적서 요소[시험기관·참여자수·시험기간·전후값] 중 빠짐 = 결손권고의 `must_fill`)이면 이미지 생성을 **멈춘다**(조건부 멈춤; 멈춤은 셸 `run-stage.sh` 만 수행). 그래도 진행하려면 비대화형 override `HARNESS_ACK_GAPS=1`(또는 `--proceed-with-gaps`, 진행 시 감사용 한 줄). **면제**: stub/오프라인(STUB_MODE) 또는 `04-keyvisual/image-manifest.json` 이 이미 있으면(이미지 생성 완료=멱등 재진입) 점검을 건너뛴다(no-op 재개·골든 결정성 불변). 이는 읽기전용 결손 권고(부록A-14)가 **비용·비가역 단계 앞에서만 임계 결손에 한해 조건부 멈춤**을 더한 것이다 — 강제 심의 게이트·verdict 는 그대로이고, 점검은 렌더/표면화이지 심의가 아니다(생성≠심의 격리 불변). `render-design.sh` 단독 경로는 `image_engine` 을 멱등 재호출하지만(비용 큰 1차 실생성은 run-stage 경로) preflight 를 두지 않았다 — 비표준 경로(별도 게이트 미추가). run.md 의 결손 표면화(`render_runmd`)는 04-keyvisual·manifest 부재일 때 '이미지 생성 전 최종 점검' digest 로, 그 외엔 기존 '보완하면 더 좋아요'로 나온다. 회귀 = `tests/test-gen-image-completeness.sh`.

> 키비주얼 입력(`build_context` 라벨): `DELIVERABLE_FORMAT` · `STORYLINE` · `STORYBOARD_PLAN` · `ART_DIRECTION` · `IMAGE_MANIFEST` · `ASSETS_MANIFEST` · `REGULATORY_DOMAIN` · `RULESET` · `REFERENCE_IMAGES` · `REFERENCE_NOTES` · `PRODUCT_FACTS`(사실 후크 — 가격·구성·성분함량, 효능 단정 금지) · `EVIDENCE_DOCS`(반영 근거 문서 — 판정문 원문·시험기관·n·시험기간; reflect:true 만 방출, 원문 밖 단정어 금지, 정성=html_only 인증-표시형). `DELIVERABLE_FORMAT` 주입으로 **실LLM 프롬프트가 BM/one_pager 레이아웃을 분기**한다(`prompts/keyvisual.md`). 아이콘은 인라인 SVG 선화(빈 동그라미 금지, P0-②), 커머스 밀도 컴포넌트는 `multipage_bm` 한정(P1-③ — 시각만, 주장은 룰셋 게이트 그대로). stub 키비주얼은 포맷 무관 generic 세로 템플릿이며 폭만 채널값으로 가변(BM/one_pager=860).

> **제품 형태(제형) 고정 — 이미지·카피 프롬프트 앵커:** `build_prompt`(이미지 프롬프트)와 `build_context`(생성 프롬프트의 '제품 형태(제형 고정)' metaline)에 **정규화된 제품 형태 명사구**(예 "부착형 패치")를 실어, 확산모델이 참조/생성 제품의 제형·용기를 임의 치환(펌프·세럼 보틀 등 화장품 prior 로 회귀)하지 못하게 앵커한다. 형태 명사구는 **COMPUTED(산출물에 저장하지 않음)** — claim-basis `product_type`(사람 선언) + voc `product_facts.components` 를 **팩 소유 표** `packs/<도메인>/ingest-profile.json` 의 `form_factors`(배열=우선순위)에 대해 **first-match**(부분문자열, 대소문자 무시)로 결정적 산출하고, 미매칭이면 `product_type` 축자 폴백, 그것도 없으면 주입 없음(지어내지 않음). 동결 스키마·산출물 골든 불변(voc/claim-basis 미저장), stub/오프라인은 두 경로를 안 타 골든 바이트 불변. SSoT = `scripts/lib/form_factor.py`.

> **임상 측정치 차트 = 생성 이미지 아님(데이터-뷰):** `clinicalEvidence`·`beforeAfter` 블록의 인체적용시험 수치는 Nano Banana 생성 이미지가 아니라 plan-block `visual.chart_data`(evidence 정량필드에서 **결정적 도출**)로 **인라인 SVG/HTML 차트**로 렌더하고, 5요소 캡션(시험기관·n수·시험기간·p값·개인차 디스클레이머)을 함께 단다. 그래서 `image_engine.py`(키비주얼/렌더 선행 생성)와 `common.sh` 는 **chart_data 를 보유한 임상 블록을 생성 이미지 대상에서 제외**한다(동일 술어 — 데이터를 그림으로 날조하지 않음). 차트의 수치·라벨·방향·단위·지표명은 `scripts/lib/clinical_chart.py` 단일 출처(`derive_chart`/`numbers_consistent`/`metric_matches_claim`)가 evidence 와 정확일치로 결박한다. 효능 단정 문장이 아니라 "측정값의 변화"를 보여줄 뿐이다(부록A-12). 또 차트를 그릴 때 쓰는 `kind:"graph"` 는 이 실증(chart_data) 측정차트 **전용**이며, 아래 html_only 그래픽 블록은 `kind:"photo"` 로 둔다(둘을 섞지 않는다).

> **그래픽 블록 = HTML/SVG 전용, 생성 이미지 참조 금지(F1(C) 규제안전, 2026-07-06):** 차트가 아니라도 **그래픽·인포그래픽 성격 블록**(아이콘 요약 `rtbSummary`·판매/수상 뱃지 `socialProof`·차트 없는 인증 `clinicalEvidence`·브랜드 배너 `brandBanner`·리뷰캡처 `reviewCapture`)은 plan-block `visual.render_mode="html_only"` 로 표시하고, **텍스트·아이콘·뱃지·배너·인증·순위는 키비주얼 HTML/SVG 레이어로만** 렌더한다(생성 PNG `<img>` 참조 금지). 근본원인: 확산모델이 그래픽/인포그래픽에 **없는 인증(FDA)·수상·순위·수치를 창작(환각)해 굽고**(+한글 라벨 변질), 그 baked PNG 가 옵션 HTML `<img>`→shots 스크린샷→협회 제출 패키지로 새면 허위표시(약사법·표시광고법 위반)가 되기 때문이다. **도메인 게이팅(택안 C):** `image_engine._block_emits_image(b, model, domain)` 가 **규제도메인(정책 = `packs/<도메인>/domain.json` 의 `no_graphic_generation`; 현재 drug/quasi_drug/health_food=true)은 그래픽 블록을 온라인에서도 미생성**(아예 안 굽는다 — 하드코딩 집합 폐기·팩 소유화[K-1/H-2], 새 도메인은 팩 선언만으로 정책 반영), **화장품(cosmetic)·미선언은 실엔진이면 굽되(디자이너 참고 시안)** — 단 어느 도메인이든 그 baked PNG 를 옵션 HTML/export 가 참조하는 것은 금지. 도메인은 `gen-images.sh`·`render-design.sh` 가 `--domain`(`resolve_domain`)으로 전달, **stub(model None)은 도메인 무관 제외 → 골든 바이트 불변**. 제외 판단은 chart_data 와 **같은 단일 술어** `_block_emits_image` 가 맡아 `generate_all` skip·`planned_image_summary` 카운트(`{total,image,chart,html_only}`)·`common.sh` 예측·`image_preflight` digest 가 자동 동기화된다. 렌더 게이트 `check_render_refs.py` 가 html_only 블록의 생성 PNG `<img>` 참조를 **매니페스트 실재·도메인과 무관하게 전 도메인 fail-closed**(2026-07-05 '디자이너 핸드오프'의 '매니페스트 실재 baked PNG 허용' 예외를 회수). 카피(헤드라인·RTB·판정문)의 정본은 그 `<section>` HTML 텍스트(심의 스캔·evidence 원문·접근성 채널)다. 사진형 블록(hero·solution·ingredientTech·howToUse·targetAudience·problem)에만 생성 이미지가 붙고 그 위 텍스트는 HTML 오버레이. **후방호환:** 스키마 default 는 image-emitting(플래그 없으면 사진형 생성 — 골든 불변). **프롬프트 못박음:** `prompts/storyboard-plan.md` 는 html_only 를 그래픽 블록 **닫힌 허용목록**(`rtbSummary`·`socialProof`·`brandTrust`·`brandBanner`·`reviewCapture`·비차트 `clinicalEvidence`)에만 허용하고 사진형 블록엔 금지, `prompts/keyvisual.md` 는 그래픽 블록을 인라인 SVG/HTML 로만 구성하도록 지시한다. 설계 = `docs/_archive/keyvisual-image-safety-fixes-plan.md`(F1).

> **옵션 HTML 전수 블록검사(RCA 8장):** 신규 `scripts/lib/check_html_blocks.py` 가 `04-keyvisual/options/*/index.html` **전체**의 `data-block` 속성을 `html.parser` 로 파싱해(정규식이 아니라 실제 파서라 CSS 선택자·주석은 오탐하지 않는다) 금지블록(위 3단계 게이트)과 가격 패턴을 전수검사한다. `validate-stage 04` 와 `render-design.sh` 에 **이중 배선**(둘 다 fail-closed). 근거: `design-manifest.json` 은 **선택된 옵션만** 기록하므로 그것만 보면 B/C 옵션이 사각지대가 된다 — 그래서 매니페스트가 아니라 디스크의 모든 옵션 HTML 을 직접 스캔한다.

> **이미지 생성 모델 기록(RCA 7장 선행공통):** `image_engine.py` 가 `04-keyvisual/image-manifest.json` **최상위**에 `model` 필드를 기록한다(**nanobanana 실생성만** — stub 매니페스트는 바이트 불변이라 골든 불변; `harness/image-asset.schema.json` 에 optional top-level `model` 추가). 산출물만으로 Pro/Flash 를 사후 판별할 수 있다. `prompts/keyvisual.md` 는 사진의 캡션·라벨을 픽셀로 굽지 말고 **HTML/CSS 오버레이**로 얹으라는 지침을 담는다.

> **생성 이미지 픽셀 금지어 OCR 점검(04-keyvisual 심의, 좁은 결정적 룰):** 04-keyvisual 심의 시, 화면에 실려 나가는(deliverable-visible) 선택안 이미지 — 선택안 HTML/CSS 이 참조하는 `04-keyvisual/generated/*.png`(생성 PNG)와 직접 참조된 `inputs/assets/**` 래스터(png/jpg/jpeg/webp) — 를 `tesseract`(`-l kor+eng`)로 OCR 해 **기존 금지 deny-list 3계열만**(`drug_misperception`·`consumer_deception`·`prescription_otc_distinction`) 부분문자열 대조한다(텍스트 스캔이 놓치는, **픽셀에 구워진 금지 표현** 포착). 이건 결정적 룰엔진 신호일 뿐 **OCR 품질 게이트가 아니며**(스타일 글리프 miss·근거 스크린샷 오탐은 설계상 수용), 범위를 넓히지 않는다(triggers/zero_voc/functional_efficacy 절대 미포함). **실엔진 매니페스트(engine=nanobanana)일 때만** 스캔 — stub/오프라인은 건너뛰어 verdict 바이트 불변(CI 에 tesseract 불요). 스캔이 돌아야 하는데 `tesseract` 또는 kor/eng 언어데이터가 없으면 조용한 강등이 아니라 **fail-closed**(멈춤). SSoT = `scripts/lib/image_ocr_scan.py`(ref 디코드는 `img_lint._refs` 재사용), `kcia_engine` 이 high 위반으로 배선. 이는 심의(다른 벤더·원격 ADK)와 별개의 결정적 룰엔진 신호다(생성≠심의 격리 불변).

> **이미지 재굽기 무결성(입력 해시):** `04-keyvisual/image-manifest.json` 의 블록별 자산에 `input_hash`(= 프롬프트 + 레퍼런스 자산 바이트 + aspect/레퍼런스 경로의 정준 sha256; **nanobanana 경로만** 기록)를 남긴다. 재실행 때 각 블록은 **`input_hash` 가 바뀐 경우에만 다시 굽는다** — 레퍼런스 자산을 교체하거나 블록 프롬프트를 고치면 그 블록만 자동 재굽기되고 나머지는 기존 산출물을 재사용한다. **모델명은 해시에서 제외**(강등·모델 스위칭이 불필요한 재굽기를 유발하지 않게). 프롬프트는 위 제형 고정 주입이 반영된 최종본을 해시하므로 제형 문구 변화도 재굽기에 반영된다. `input_hash` 미기록 **레거시 매니페스트**는 값-부재만으로 재굽지 않고 기존의 싸구려 멱등 skip 을 유지하며 이번 런에서 해시를 자가-기록한다(self-migrate). stub 은 `build_prompt` 미호출 → `input_hash` 무기록·매니페스트 바이트 불변. SSoT = `scripts/lib/image_engine.py`(`_compute_input_hash`).

> **이미지 실생성 부분실패 내성·품질(F2·F3, 2026-07-06):** **F2 Pro 400 자동 강등** — `image_engine._call_nanobanana` 가 400(INVALID_ARGUMENT, 모델-특유 거부)에서 `NanoBananaModelRejected`(status=400, `NanoBananaQuotaExhausted` 형제)를 던지고 `generate_all` 이 429 와 **동일 다이얼**로 `HARNESS_NANOBANANA_FALLBACK_MODEL`(기본 flash)로 자동 강등한다(Pro 가 특정 입력을 400 으로 거부해 완주가 막히던 문제 — 수동 개입 제거). fallback 도 400 이면 진짜 요청 버그로 보고 fail-closed(증분 매니페스트 incomplete). 감사 1줄(stderr, 키 마스킹). **F3 aspect 크롭 제거** — 서로 다른 aspect 의 생성 이미지가 고정박스 + `object-fit:cover` 로 제품컷 가장자리가 잘리던 문제를 (a) `prompts/keyvisual.md` 가 블록 `<img>` 를 자연비율(`height:auto`, cover 고정박스 금지)로 지시 + (c) `image_engine._normalize_png_aspect`(Pillow)가 생성 PNG 를 선언 aspect 로 **패드(레터박스, 크롭 0)** 규격화(Pro/flash 크기차 흡수·블록 간 정렬)로 해소한다. 둘 다 **online(nanobanana) 전용 → stub/오프라인 골든 바이트 불변**. 회귀 = `tests/test-image-engine.sh`(6e·7). 설계 = `docs/_archive/keyvisual-image-safety-fixes-plan.md`(F2·F3). (참고: 그래픽 블록의 굽기 여부는 위 F1(C) 도메인 게이팅이 결정 — 폐기된 'Pro 티어에서만 html_only 되살림' 모델-인지 라우팅은 F1(C)로 대체됐다.)

> **협회 제출 패키지의 근거 문서 첨부(링크 C — 조건부):** `04-keyvisual/export/kcia-package/` export 시, 00-ingest 의 근거 매니페스트(`evidence-documents.json`)가 있으면 `kcia-package/evidence/`(첨부 실파일) + `package.json.evidence_documents{id·filename·grade·sha256·bytes·linked_claim_ids·reflect(+reflect:true 면 reflected_in)}` + README `## 첨부 근거 문서` 표(**WB 추출 텍스트 근거표와 별개 절**; 반영/반영 블록 열)를 함께 만든다(`export_package.py`). 복사는 orphan 가드(파일 있는데 매니페스트 없음 = fail-closed) → 정확집합 대조(디스크==매니페스트+sha256) → stale rmtree → 안전순서 무결성(lstat·realpath 경계·크기 검사 → 원본 재해시 대조 → 복사 → 복사본 재해시)로 fail-closed. 근거 없는 런은 evidence/·필드·표가 전혀 안 생겨 패키지 바이트 불변. **첨부-전용(reflect:false)은 주장 실증이 아니다**(심의 실증셋 미편입); **반영(reflect:true)은 사람 선언 내용이 `doc-NN` 실증으로 편입돼 실증 근거 목록·반영 블록에 실린다**(부록A-16). 반영 누락은 done 게이트가 차단(`check_evidence_reflection.py`, 위 1단계 노트). 상세 = `docs/_archive/evidence-content-integration-plan.md`·`docs/_archive/evidence-attachment-plan.md`.

### BM 여러장 상세페이지 정의 = 캐논 ↔ 사용자 9구성요소 매핑

`canon-blocks.md` 15블록 / `packs/_format/<포맷>/canon.json` 10대 필수 구성요소가 **SSoT**이며, 사용자가 준 9구성요소(+대웅 배너)와 **완전 대응**한다:

| 사용자 구성요소    | 캐논 블록(satisfied_by)           | risk   | 비고                                                           |
| ----------- | ----------------------------- | ------ | ------------------------------------------------------------ |
| 🏆판매/수상 데이터 | `socialProof` + `brandTrust`  | medium | 기준일·출처 각주 필수 · **claim-gated**: 판매/수상 주장 미노출(brief sensitive_labels 부재/전부 not_claimed·unsupported[근거없어 카피 배제]) 시 `exempt(미주장)` — 범용 브랜드 카피만 present 라고 필수충족 오판 안 함(외부리뷰 P1)                                                 |
| ⭐키비주얼       | `hero`                        | high   | 효능 단정 금지, evidence_required                                  |
| ❓문제(고민) 인식  | `problem`                     | high   | VOC 근거, Before(연출·개인차)                                       |
| 👍소비자 VOC   | `reviewCapture`               | medium | 별점·후기·공감리뷰                                                   |
| ✅핵심 RTB 요약  | `rtbSummary`                  | medium | 3–4개 직관 카피                                                   |
| ✅핵심 RTB 세부  | `ingredientTech` + `solution` | high   | 성분/기술/특허(meta 근거 한정)                                         |
| 🔎과학성/임상 근거 | `clinicalEvidence`            | high   | **실증 등록 시에만 활성**(enabled_if), 미등록=면제                         |
| 📌권장 사용 방법  | `howToUse`                    | low    | TPO·순서·횟수·팁                                                  |
| 👤추천 타겟     | `targetAudience`              | high   | "이런 분께 추천"=VOC 페르소나 가설, 질환 암시 금지                             |
| 🐻대웅제약 배너   | `brandBanner`                 | high   | 브랜드 헤리티지(brand_gated; 제품명에 브랜드 없으면 면제), 제약 전문성을 효능 권위로 쓰기 금지 |

> 캐논에는 사용자 표에 없는 보조 블록도 있음: `beforeAfter`(VOC Before/After를 **독립 critical 블록**으로 분리; 실증+2중승인) · `colorSwatch` · `buyingGuide` · 확장 `motionDemo`(gif). 사용자 9구성요소는 **필수 10대**, 나머지는 선택 블록.
> ⚠️ **두 어휘 주의:** 위 'satisfied_by' 열은 `canon-blocks.md` 의 **15블록 type 이름**(hero·socialProof·problem·reviewCapture·ingredientTech·solution·clinicalEvidence·brandBanner…)이고, 커버리지 게이트가 세는 **필수 구성요소는 10개**(`packs/_format/<포맷>/canon.json` 의 keyVisual·salesAward·problemAwareness·consumerVOC·rtbSummary·rtbDetail·scienceEvidence·howToUse·targetAudience·brandBanner)다. 한 구성요소가 여러 블록으로 충족될 수 있다. 또 `canon-blocks.md` 자체는 아직 옛 경로 `packs/_format/<포맷>/canon.json` 를 인용하나 실제 SSoT 는 `packs/_format/<포맷>/canon.json` 다(코드측 별건 부채 — 부록G).

---

## 5. 포맷별 구성요소 가이드라인 (스토리라인·아웃라인의 입력)

> **스토리라인·아웃라인(3단계)은 "포맷에 맞는 구성요소 가이드라인"을 입력으로 생성하고, 스토리라인·기획안 두 단계에서 그 가이드라인의 구성요소 커버리지를 게이트로 검증한다**(필수 구성요소 누락 시 보완/재생성). 이 가이드라인이 "어떤 구성요소를 어떤 순서로 담는가"의 골격이자 **커버리지 SSoT**다. 포맷이 다르면 가이드라인이 다르다 — BM(`packs/_format/multipage_bm/canon.json`(블록+구성요소 정본), ✅정식)·한장(`one_pager/canon.json`, ⚠️STUB) **모두 커버리지 SSoT 존재**(전부 `packs/_format/`; `check_canon_coverage.py` 가 `format-profiles.json` 의 `canon` 로 포맷별 캐논을 로드). 도메인(심의)은 이 위에 **무엇을 말할 수 있나**로 직교 적용된다.

### 5-1. 여러장 BM (`multipage_bm`) — `canon-blocks.md` ✅ 존재
세로 단일 스크롤 상세페이지. **9대 구성요소(+브랜드 배너 = 필수 10대) = 15블록 캐논**(4단계 BM 매핑 표 참조). 기본 내러티브: 판매/수상(신뢰) → 키비주얼 → 문제 → VOC → RTB 요약 → RTB 세부 → 과학/임상 → 사용법 → 추천 타겟 → 브랜드 배너.

> **금지블록**(`format-profiles.json` 의 `disallowed_blocks`) = `cta`·`header`·`nav`·`point`(도메인-불문 스코프-밖만; active 인 drug 의 필수기재/심화 블록 `footer`·`mainPositioning`·`ingredientDetail` 은 **미포함**) → outline·plan·옵션 HTML 에서 결정적 차단(3·4단계 노트·부록A-15).

### 5-2. 한장 (`one_pager`) — 홍보 1매 🟢 구조·프롬프트 active / canon=STUB · stub 키비주얼=generic 세로 템플릿
1매 압축 포스터형 구성: 키비주얼 + 핵심 RTB 3–4개 + (선택)수상/판매 신호 + CTA. `one_pager/canon.json`(⚠️STUB, 필수=키비주얼·RTB 요약, 수상/판매·CTA=optional) 커버리지·`active_phases`(인입~키비주얼 전 단계)·렌더 폭(채널 860)·`final_page_phase=04-keyvisual` 필수기재 게이팅이 작동하나 정식 구성요소는 추후 정의(부록D-1). **금지블록 목록은 없다**(`format-profiles.json` — cta 는 한장 홍보물의 정당 블록).

> 🟢 **현재 상태**: 5-2(한장)는 **커버리지 SSoT·포맷별 커버리지 게이트·active_phases·렌더 폭·필수기재 게이팅(`final_page_phase=04-keyvisual`) + 키비주얼 프롬프트 format-aware**까지 작동한다(실 LLM 이 포맷-native 키비주얼 생성). **잔여**: (a) canon STUB 정식화, (b) stub 키비주얼 format-aware化(선택 — 결정적 픽스처라 실 LLM 경로엔 불필요).

---

## 부록A. 전 단계 공통 안전수칙(불변식) (사용자 스펙엔 없었지만 필수 — AGENTS.md 규칙 1~8)

> 정본 플로우만으로는 안 보이는 "안전 substrate". 빠지면 환각·위법카피·상태손상·이식성 붕괴.

1. **환각 fail-closed** — 워킹백워드에 근거 없는 효능 = `unknown`/빈 배열(주장 불가). 근거 없는 효능은 컨셉 주축 금지. `claim-basis` 가 1차 방어선. *(AGENTS 규칙 1-5)*
2. **근거 1:1 페어링** — `claim_strength` 가 superlative/efficacy/speed 인 주장은 실재 근거 id(claim-basis/sources) + 각주와 1:1 매칭. 가짜/누락 id = 자동 revise. *(AGENTS 규칙 1-6)*
3. **VOC 단일출처** — 모든 정량은 `00-ingest/voc.json`. 본문 하드코딩 금지. 감성 키메시지는 voc_phrase 인용 강제(키워드빈도 **또는** `top_phrases` 실재 시 통과). 리뷰 0건 효능어는 주축 금지(zero-VOC 가드). **사실 후크**(`product_facts`·`offer`)는 `factual`(근거면제)이라 히어로·구매가이드 1급 카피 소재로 쓰되 효능 단정·최상급 금지(수식어 가드). 가격은 `voc.offer` 한 곳에만(중복 0) — **`check_html_blocks.py` 의 값-대조 가드가 이 단일출처를 게이트로 강제**한다(plan 03·옵션 HTML 04 의 금액+'원' ↔ `voc.offer.price` 정확일치, 불일치·offer 부재=fail-closed — 3·4단계 노트, RCA 8장). `build_context` 가 **`PRODUCT_FACTS` 라벨**로 voc 의 product_facts/offer 를 컨셉·스토리보드·키비주얼 생성에 주입. *(AGENTS 규칙 6)*
4. **디자인 src = 자사자산만(저작권)** — `<img src>` 는 `inputs/assets/`·생성 이미지(`04-keyvisual/generated/`)·자사 URL만. **크롤 번들 이미지는 분석·레퍼런스 입력 전용, 최종 디자인 src 금지**(픽셀복제 금지, lint 차단). 2단 lint: `img_lint.py`(출처 allowlist·크롤 번들 차단) + `check_asset_paths.py`(realpath traversal 차단). 크롤은 "왜 좋은가" 분석에만 쓰고 그림으로 쓰지 않는다. *(AGENTS 규칙 6)*
5. **법 > 참조** — 00g 크롤 참조 노트(`reference-notes.json`: flow_refs·composition_notes·notes)는 soft 권고로 컨셉·스토리라인·아웃라인·이미지에 주입되고, 심의 룰셋(법)이 항상 우선한다. 단 00g 자체는 **심의 게이트 면제**(phase-descriptors `review:false`) — 금지표현 차단은 **생성 시 `validate-stage` 룰엔진**이 맡고(심의 게이트가 아님), 참조에서 흘러나온 표현은 하류(컨셉·스토리보드·키비주얼) 심의에서 잡힌다. (구 '유사점 3안 confirmed_guideline'은 파기 — brief.json 잔존 필드만 01-brief 심의 대상.) *(multi-domain 문서)*
6. **필수기재(mandatory_inclusion)** — 비화장품(의약외품·건기식·의약품)은 법정 필수문구("질병 예방·치료 의약품 아님"·광고심의필·정확한 제품명·회사명·SNS 경제적 이해관계 표시 등) 누락 검사. 포맷별 최종 산출 페이지(`format-profiles.json` 의 `final_page_phase`; 현재 multipage_bm·one_pager 모두 04-keyvisual)에서 게이팅. *(packs/<도메인>/ruleset.json · packs/_format/format-profiles.json)*
7. **비활성 도메인 = 심의 무조건 통과** — `status != active` 도메인(현재 의약외품 tbd, 건기식 ready-only)은 `placeholder-autopass`(verdict=pass+note)로 통과(데드엔드 방지). 자료 입수·`active` 전환 시 자동으로 실심의. status enum 밖 손상값은 fail-closed. *(AGENTS 규칙 8)*
8. **루프 상한·에스컬레이션** — 페이즈별 `max_iterations`(텍스트 3·스토리보드 4·키비주얼 2) 초과 시 `escalated`(사람 개입 강제). 반려/회귀 루프의 무한루프 방지. **`escalated` 도달 경로는 둘뿐이다 — (a) 진짜 fail 에 동반된 escalate(예: 전문약 하드스톱 = high+fail+escalate), 또는 (b) 반복이 루프 상한(`iter≥max_iterations`)에 닿음.** 크리틱이 위반 0건 통과(pass)에 단 escalate(소프트 '사람 확인 권고')는 머지에서 무시되므로(부록G #4 해결) 깨끗한 통과가 `escalated` 로 가지 않는다. *(harness/pipeline-routes.json · scripts/lib/kcia_merge.py)*
9. **상태 단일쓰기·재개** — `state.json` 은 오직 `scripts/*.sh` 만 쓴다(원자적 write→`os.replace`, `.lock` 디렉터리=mkdir 원자성). LLM/스킬은 산출물·verdict·feedback·decision 만. 재개 = 산출물 존재+validate 통과 기준(LLM 결정성 비의존). 버전은 덮어쓰지 않고 history/options 누적(식약처 사후감시 감사추적). *(AGENTS 규칙 1-1)*
10. **이식성** — 1급 경로 = 셸 `bash scripts/run-stage.sh`. 슬래시/스킬/hooks/subagent 자동발견 의존 금지. 생성 CLI 는 Claude 단일(`HARNESS_CLI=claude|stub`)이고, 셸 게이트가 CLI-무관 substrate 다. *(AGENTS 규칙 1-2·1-3)*
11. **스키마 계약** — 모든 JSON 산출물은 동결 `harness/*.schema.json` 만족(validate-stage). 단계 경계 = 스키마 + 골든 픽스처. 컨셉의 하드 의존 3종 = voc·claim-basis·regulatory_domain(부재 시 중단). *(stage-contracts.md)*
12. **비법적 고지** — 본 산출물은 법적 통과 보증이 아닌 자율·비법적 사전점검(최종 책임=사람/RA). before/after·임상은 "연출·개인차" 디스클레이머 자동삽입 + 2중 승인(선택 후 사람 최종 approve). **임상 측정치 차트의 개인차 디스클레이머는 NLP 추정이 아니라 고정 정규 문자열 "개인에 따라 차이가 있을 수 있습니다"** 의 정확 부분문자열로 게이팅하며(이 정본 문자열과 시험맥락 표기 어휘[n수·피험자·시험기간 마커]는 `packs/<도메인>/ruleset.json` 의 `axes.clinical_substantiation` 이 소유하고 엔진이 팩 우선으로 읽는다 — 키 부재 시 화장품 레거시 기본값 폴백), 이 문자열은 5요소(측정 전/후 쌍·시험기관·n수·시험기간·개인차 디스클레이머) chart 하드게이트의 한 요소다. 또한 차트로 보여주는 모든 수치·라벨·방향·단위·지표명은 `scripts/lib/clinical_chart.py`(`derive_chart`/`numbers_consistent`/`metric_matches_claim`)가 실재 evidence 정량필드에서 **결정적으로 도출·정확일치 결박**한다 — 근거 없는 수치는 차트화 불가(fail-closed), 데이터를 그림으로 날조하지 않는다(4번 절 데이터-뷰 노트). *(AGENTS 규칙 7)*
13. **생성 watchdog(행/좀비 방지)** — 생성 CLI 가 산출물을 다 쓰고도 종료 안 하면 무한 대기로 마무리 전이가 멈추는 문제를 처방한다. 산출물(watch 파일) 완성 시 좀비 자식을 더 기다리지 않고 곧장 검증·전이로 진행. `HARNESS_GEN_TIMEOUT`(기본 600초, 산출물 없는 진짜 행의 하드 백스톱)·`HARNESS_GEN_POLL`(5초)·`HARNESS_GEN_HEARTBEAT`(30초). 초과 시 자식 종료 후 중단, 재실행=idempotent 재개. *(AGENTS 규칙 2)*
14. **결손값 권고 계층(읽기전용·비강제)** — 강제(fail-closed: validate-stage·kcia_engine) **그대로**, 그 위에 '있으면 품질이 오르는 값'이 빠지면 **채우라 제안 + 품질 저하 경고**하고 임상 차트 필수요소(측정 전·후 값·시험기관·n수·시험기간)가 빠지면 **무엇을 채울지 콕 집어** run.md 에 보여주는 별도 읽기전용 계층. `scripts/lib/completeness_advisor.py`(SSoT, 필수 4요소는 게이트와 동일하게 단일 evidence 레코드 기준) → `render_runmd.py` run.md '보완하면 더 좋아요(선택)' 섹션 + `next-action.sh` `advisory` 필드. 문구=`operator_labels.py` 단일출처(평이 한국어·내부어 누수 가드·**거짓 % 금지**, 정성 문구+핵심정보 N/M 카운트만). **매 렌더 재평가·무상태·자가소멸**(값 채우면 다음 렌더에 사라짐), state.json 미기록·게이트 판정 불변·run.md 골든 제외. 생성측 보완: `build_context` 결손 metaline '(미제공—있으면 품질↑)' + 생성 프롬프트 '결손 입력 처리' 지시(절제·보강권장·환각 금지). **품질 권고 2건(2026-07-05 추가):** ① `photographic_html_only` — plan 블록의 사진형 타입(hero·problem·solution·ingredientTech·howToUse·targetAudience)이 `render_mode=html_only` 로 표시돼 **생성 이미지가 버려질 때**(03/04) 경고(얇은 페이지 가시화). ② `evidence_clinical_signal` — 일반 참조 문서(kind≠test_report·reflect)인데 claim/반영포인트에 임상 신호(인체적용시험·사용적합 등)가 있으면 **'전용 임상 블록을 원하면 시험성적서로 선언'** 제안(01~04). 둘 다 비차단·자가소멸·count 불변(안전 불변식 '일반=각주 채널' 미변경 — 재분류 강제 아님). 회귀=`tests/test-completeness-advisory.sh`(10~13). **단 하나의 예외 — 이미지 실생성(비용·비가역) 직전**: 이 읽기전용 권고는 그 단계 앞에서만 **임계 결손**(임상 시험성적서 요소 `must_fill`)에 한해 **조건부 멈춤**으로 작동한다(읽기전용 점검기 `image_preflight.py`·멈춤은 `run-stage.sh` 만; override `HARNESS_ACK_GAPS=1`/`--proceed-with-gaps`, stub/오프라인·`image-manifest.json` 존재 시 면제 — 4번 절 '이미지 실생성 직전 최종 점검' 참조). 그 외 단계의 권고는 비강제 그대로이고, 강제 심의 게이트·verdict 는 불변이다. *(AGENTS 규칙 1·9 · operator_labels SSoT)*
15. **결정적 금지블록 게이트(RCA 8장)** — 포맷이 허용하지 않는 out-of-scope 블록(`packs/_format/format-profiles.json` 의 `disallowed_blocks`; multipage_bm=`cta`·`header`·`nav`·`point`, one_pager=없음)은 심의 이전 **결정적 룰**로 차단한다: `validate_storyboard.py`(outline·plan fail-closed, `validate-stage 03`) + 신규 `check_html_blocks.py`(모든 옵션 HTML `data-block` 을 `html.parser` 로 전수검사 → 선택 안 된 B/C 옵션 사각지대 제거, `validate-stage 04`+`render-design.sh` 이중배선) + `check_canon_coverage.py` 의 `disallowed_present` 가시화(outline/plan/design·design 스코프는 전 옵션 HTML 스캔; `harness/canon-coverage.schema.json` optional). active 인 drug 이 정당·필수로 쓰는 `footer`(필수기재 컨테이너)·`mainPositioning`·`ingredientDetail`(품목 심화)은 금지목록에서 제외 — 포맷-레벨 금지는 도메인-불문 스코프-밖 블록만 담는다. 가격 값-대조 가드(A-3)도 같은 `check_html_blocks.py` 에 산다. *(RCA 8장 · packs/_format/format-profiles.json)*
16. **첨부의 두 모드: 첨부-전용(reflect:false) ↔ 반영(reflect:true, 기본)** — 근거 문서 첨부는 기본이 **반영 채널**이다(reflect 미선언=true). ① **reflect:false(첨부-전용)**: 파일 전송(협회 제출 패키지로 실어나르기)이지 주장 실증이 아니다 — 그 `doc-NN` 은 심의 실증 집합에 편입되지 않고 `linked_claim_ids`↔`claim-basis.json`(`evidence_on_file[].id`) 대조도 '연결 표기용 존재성 대조'일 뿐이다(옛 F5 불변). ② **reflect:true(기본·반영)**: 사람이 선언한 내용(`claim`·`verdict_text`·`test_report`)을 인입이 `claim-basis.evidence_on_file` 에 `doc-NN` **문서-유래 실증 엔트리**로 승격해 실증 집합에 편입한다(`claim→summary` 매핑, `ev-*` 뒤 append, 네임스페이스 분리) — 단 이는 **AI 가 PDF 를 읽어 만든 게 아니라 사람 선언**이고(환각 안전·AGENTS 5), 심의를 **우회하지 않는다**(승격된 재료도 강제 심의 5요소 게이트·verdict 를 그대로 통과해야 함 — 생성·전이 ↔ 심의 격리 불변). 카피는 선언 `verdict_text` **원문**만 쓴다(3단계 `validate_storyboard` 부분문자열 결박 — 문서 밖 단정어 확장 fail-closed). WB-스캔 텍스트 근거(`ev-*`)와 문서-유래 근거(`doc-*`)는 별개 절로 병기한다. 미완/불완전 선언(reflect:true 인데 내용 결손)=인입 fail-closed. *(AGENTS 규칙 4·5·6 · docs/_archive/evidence-content-integration-plan.md · docs/_archive/evidence-attachment-plan.md F5 · 1단계 00-ingest 승격 노트·3단계 검증·6단계 done 게이트·export)*
17. **인입-완료 표식 + 양성-완료 전이 게이트(근거 첨부 정합성 · N10~N12)** — `ingest-bundle.sh` 는 어떤 run-input(근거 스냅샷 포함)을 건드리기 **전에** 원자적으로 미완 표식 `00-ingest/.ingest-incomplete` 를 쓰고, 인입이 완주(상태 기록 성공)한 **뒤에만** 제거한다(write-ahead). 표식이 있으면 하류가 **fail-closed**·재-인입 강제 — 존중하는 진입점은 **9개**: `run-stage.sh`·`validate-stage.sh`(run 모드; `--file` 단건검증은 면제)·`advance-phase.sh`·`next-action.sh`·`approve.sh`·`select.sh`·`revise.sh`·`kcia-check.sh`·`gate.sh`. 또한 `advance-phase --to` 로 00-ingest 를 떠나는 **세 출구(00e-evidence·00g-guideline·01-brief; G5 로 allow-list 확대, origin 은 00-ingest 만)** 는 표식 부재만으론 부족하고 **양성 완료**(state.status=passed + 필수 4종[voc·claim-basis·assets-manifest·best-practices] present&valid)를 요구한다(fresh 미인입 런은 모두 거부). 재-인입(멱등 정확복제)만이 표식을 해소한다. 재실행 안내문구 = `bash scripts/ingest-bundle.sh <번들> <id>`. *(N10~N12 · scripts/ingest-bundle.sh · scripts/advance-phase.sh · docs/_archive/evidence-attachment-plan.md)*

---

## 부록B. 도메인별 심의 참조 자료 → [`pack-catalog.md`](pack-catalog.md) 로 이관

도메인별 심의 참조 매트릭스(status·ADK 엔드포인트·룰셋·1차 출처·심의 동작)와 포맷 팩 카탈로그는 **[`pack-catalog.md`](pack-catalog.md)** 가 정본이다. 요지만: 운영 심의 엔진 = **원격 ADK(`adk-http`) 단일**(생성과 다른 벤더·원격 세션이라 자가비판 불가), 엔드포인트는 `packs/<도메인>/domain.json` 의 `adk_critic` 블록이 가리키는 도메인별 env(예 화장품 `ADK_COSMETICS_CRITIC_URL`). 현재 화장품·의약품=active(실심의), 의약외품·건기식=자료 대기(placeholder-autopass). 상세·전체 표 = pack-catalog.md.

---

## 부록C. 지금 구현과 다른 점(Gap) — 사용자 의도 vs 코드

> 초기 Gap 대부분은 코드에 반영되어 **현재 동작**이 됐다. 아래 표는 닫힌 항목(✅)을 사실 기록으로 남기되, **열린 Gap 은 G7 하나뿐**임을 분명히 한다.

| #   | 단계          | 사용자 의도(정본)                      | 현재 구현                                       | 상태 |
| --- | ----------- | ------------------------------- | ------------------------------------------- | --- |
| G1  | 공통(심의 순서)   | 생성 → **사람 승인 → 심의**             | 생성 → 사람 승인/선택 → 심의(`gate.sh` review-pass 만 advance/finalize) | ✅ 닫힘 |
| G2  | 공통(재생성)     | 다안 선택 OR **프롬프트로 재생성**(1급)      | `revise.sh` 가 단안(보완)·다안(전부거절) 양쪽에서 재생성을 받음 — 거절 라운드는 `history/iter-N` 아카이브 후 새 라운드 생성(`run-stage.sh` concept·00g·plan 부분재생성) | ✅ 닫힘 |
| G3  | 1 브리프       | 크롤을 "**감각적으로** 왜 좋은가" 분석        | 크롤 참조 노트(`reference-notes.json`)를 자유텍스트로 입력받아 `REFERENCE_NOTES` 라벨로 주입(구 정량-only 보완). 객관 구도/무드는 example-analysis 카탈로그(`reference_images[]`) | ✅ 닫힘 |
| G4  | 0/1 (유형 취합) | 유형(도메인·포맷)이 브리프에 담김             | `DELIVERABLE_FORMAT` 라벨이 build_context 에 항상 실림(`common.sh`); brief.output_type 2축 선언; 도메인=룰셋 선택 | ✅ 닫힘 |
| G5  | 3 스토리보드     | **모든 포맷** 동일 과정(포맷별 스토리라인·아웃라인) | 전 포맷 03 완주(format-aware 생성기·포맷 커버리지 SSoT) | ✅ 닫힘 |
| G6  | 4 키비주얼      | 한장 산출물도 생성                 | 전 포맷 04 active(커버리지·`render.py` 폭·필수기재) + `prompts/keyvisual.md` format-aware(`DELIVERABLE_FORMAT` 입력 + BM/one_pager 레이아웃 분기) → 실 LLM 포맷-native 키비주얼(stub 은 generic 세로 템플릿) | ✅ 닫힘 |
| G7  | 3 근거자료      | 논문/학술/보도 리서치 매핑                 | **OpenAlex 직접 HTTP 실연동**(온라인 `evidence_search.py`→results.json `engine=openalex`; 오프라인=stub 빈 결과·`engine=manual`, 골든 불변). 결과는 발견 후보(자동 인용 0 · `evidence_sufficient` 기본 false · 채택=사람/RA) | ✅ 닫힘 |
| G8  | 누적          | 디자인이 브리프+컨셉+스토리보드 종합            | `STORYLINE`·`STORYBOARD_PLAN`·`REFERENCE_IMAGES` 라벨이 build_context 에 누적 주입(`common.sh`; tone 서브스테이지 흡수로 TONE_DECISION 제거) | ✅ 닫힘 |

> **G1~G8 전부 닫힘** — G7 근거자료는 **OpenAlex 직접 HTTP 실연동**으로 닫혔다(온라인 실검색·오프라인 stub; 결과는 발견 후보라 채택은 사람/RA). 나머지 G1~G6·G8 도 코드 반영 완료(=현재 baseline). 비차단 후속: 한장 canon=STUB 정식화, (선택) stub 키비주얼 format-aware化.
> WS-A~G 의 상세 설계 초안(**⚠ 동결 — 재합의 중·구현 보류, 2026-06-21**)의 항목 다수는 이미 본 SSoT·코드에 흡수·구현됐다.

---

## 부록D. 앞으로 정할 것 (미해결)

1. 🟢 **대부분 닫힘** — 포맷별 커버리지 SSoT·두 단계 커버리지 게이트(3-A·3-B)·`active_phases`·`render.py` 폭·`final_page_phase`(의약품 필수기재) + **키비주얼 프롬프트 format-aware(실 LLM 포맷-native)** 작동. **미해결(비차단)**: (a) 한장 canon=STUB → 정식화, (b) stub 키비주얼 format-aware化(결정적 픽스처라 실 LLM 경로엔 불필요 — 선택).
2. ✅ **근거자료 검색 — 해결됨(OpenAlex 직접 HTTP).** 온라인 storyboard-outline 에서 실증 트리거 감지 시 `evidence_search.py` 가 OpenAlex 를 직접 HTTP 로 검색(MCP 아님)하고, 오프라인/CI 는 stub(빈 결과·`engine=manual`, 골든 불변)로 폴백한다. 결과는 검증 전 발견 후보라 자동 인용되지 않고(grade=발견 강도 · `evidence_sufficient` 기본 false) 채택은 사람(현업/RA). *(부록C G7 과 동일.)*
3. ◻ **의약외품·건기식 심의자료** — `quasi_drug`(`packs/quasi_drug/ruleset.json` 빈 축, status=**tbd**)·`health_food`(`packs/health_food/` 에 `domain.json`·`ingest-profile.json` 만, ruleset·sources 부재, status=**ready-only**). 둘 다 현재 `placeholder-autopass`. 자료 입수 후 `packs/<도메인>/ruleset.json` 을 4축+`mandatory_inclusion` 으로 채우고 `domain.json` status 를 `active` 로 전환하면 자동 실심의.
4. ✅ **regulation 경로 규약 통일 — 해결됨(packs 리팩토링).** 전 도메인 룰셋이 `packs/<도메인>/ruleset.json` 로 통일(`packs/cosmetic/ruleset.json`·`packs/drug/ruleset.json`). cosmetic 만 최상위였던 비일관이 사라졌고, `core/docs/reference/regulation/` 에는 `README.md` 만 잔존.
5. ◻ **active 도메인 룰셋 완전성** — cosmetic 2025 PDF 실대조, drug 전문/일반·필수기재 적용범위 현업 확인. 룰셋은 1차 추출 초안(원문 .md+.pdf 는 `packs/<도메인>/sources/` 에 실재 — cosmetic·drug 각 2종, 카탈로그 완전성 미검증).

---

## 부록E. 모노레포 마이크로커널 — 구조·확장·로더

> 정본 플로우는 도메인·포맷 무관 공통이지만, **그 위에서 데이터가 어디 사는가**는 모노레포 마이크로커널로 정해진다. 빠지면 '룰셋이 어디 있나·새 도메인을 어떻게 켜나'를 SSoT 만으로 알 수 없다. 전체 상세 = [`harness-architecture.md`](../snapshots/harness-architecture.md).

**직교 3축(가장 중요):** 흐름(파이프라인) ⊥ 규제(도메인) ⊥ 구성(포맷). 도메인이 바뀌어도 파이프라인은 같고, 포맷이 바뀌어도 도메인 심의는 같다.

| 위치 | 소유 | 무엇을 담나 |
|---|---|---|
| `core/`(=HARNESS_ROOT) | **커널(도메인 무관)** | scripts(상태 단일쓰기·게이트)·harness(동결 스키마·registry)·prompts·tests·inputs(**씨앗 소스** working-backwards.md·assets·examples — ingest 가 `runs/<id>/inputs/` 로 스냅샷)·runs(런별 진실) |
| `packs/<도메인>/` | **규제도메인 팩 SSoT** | `domain.json`(레지스트리 엔트리: 라벨·법·status·필수기재 등) + `ruleset.json`(심의 축) + `sources/`(협회·식약처 원문, 읽기전용) |
| `packs/_format/` | **포맷 팩(비-도메인)** | `format-profiles.json`(active_phases·final_page_phase) + `<포맷>/canon.json`(커버리지 SSoT). domain↔format 완전 분리 |

- **런별 inputs 통합(경로 계약):** 런의 모든 원시 입력은 `runs/<id>/inputs/{working-backwards.md, assets/, examples/<도메인>/, bundle/}`(런별 진실)에 모인다 — ingest 가 공유 씨앗 `core/inputs/{working-backwards.md,assets,examples}`(override: `HARNESS_WB`/`HARNESS_ASSETS_DIR`/`HARNESS_EXAMPLES_DIR`)와 크롤 번들에서 스냅샷한다. `00-ingest/` 는 **가공물만**(voc·claim-basis·assets-manifest·best-practices·bundle-report). 생성 이미지는 `04-keyvisual/generated/`. 자사 자산 정규경로 `inputs/assets/<file>`·크롤 참조 `inputs/bundle/images/...` 문자열은 불변(해석 기준만 ROOT→run_dir), 생성 이미지 정규경로만 `inputs/assets/generated/<id>/…` → `04-keyvisual/generated/…` 로 바뀌었다.
- **로더 조립:** `kcia_engine.load_domain_registry()` 가 `packs/*/domain.json` 을 스캔해 레지스트리를 조립한다(셸은 `common.sh domain_field` 가 동일 Python 을 질의 — 단일 출처). **`packs/` 가 유일 레지스트리 SSoT다(2부 1단계: 레거시 `harness/regulatory-domains.json`·`default→cosmetic` 폐지).** 등록됐는데 ruleset 파일 부재/손상 → '미완 룰셋'(빈 축) 반환 = fail-closed('잘못된 화장품 법' 조용한 폴백 금지). 미선언·미등록 도메인(팩 손상/누락 포함)도 cosmetic 조용한 폴백 금지(fail-closed). 팩 status 가 허용 enum(`active`/`tbd`/`ready-only`) 밖이면 '손상'으로 처리해 비-autopass·fail-closed. 도메인 별칭(한국어/id)은 `packs/<도메인>/domain.json` 의 `aliases` 필드가 소유(new-run 이 질의).
- **새 도메인 켜기 = 팩 폴더 추가(core 코드 0줄):** `packs/<도메인>/{domain.json,ruleset.json,sources/}` 를 두고 `domain.json.status` 를 `active` 로. 파이프라인·프롬프트·게이트·스키마는 그대로. **단 새 도메인 *타입*을 추가하려면 진입 게이트(`new-run.sh` 인자·`state.schema.json` enum)는 별도 통제 추가가 필요**(레지스트리 자동 인식 ≠ 입력 검증 자동 확장).

---

## 부록F. 운영 환경변수 → [`config-reference.md`](config-reference.md) 로 이관

운영 환경변수 전체 조회표(생성·이미지·근거검색·심의·권한·근거첨부·생성/심의 watchdog·관측성)는 **[`config-reference.md`](config-reference.md)** 가 정본이다. 동작 규칙·의미(fail-closed 게이트 등)의 SSoT 는 여전히 [`../AGENTS.md`](../../core/AGENTS.md) 2번 절이고, config-reference 는 거기서 변수 사실만 평평하게 뽑은 사람용 조회표다. 요지만: **stub 게이트 = `HARNESS_OFFLINE=1`(유일)** — stub(생성·이미지·근거)은 CI/골든 결정성 전용, 온라인에선 fail-closed 로 새지 않는다. 이 환경변수는 현업 4동작 바깥의 '운영자' 설정이라 현업에게 시키지 않는다(AGENTS.md 9번 절-3).

---

## 부록G. 알려진 부채 (이 SSoT 밖 — 코드/문서 잔존)

> 본 SSoT 는 현행 동작을 정확히 기술하나, 아래는 아직 정리되지 않은 코드/문서 잔존이다(독자가 마주쳐 혼동하지 않도록 명시). 본 문서의 오류가 아니다.

1. `scripts/lib/examples_analysis.py` 의 docstring(라인 5·17)이 옛 `00g-guideline/project-guideline.json` 산출을 언급하나, **실제 코드는 `example-analysis.json`·`reference-notes.json` 만 쓴다**(project-guideline.json 미생성 — 종전 '여전히 쓴다' 기술은 오류였다). 고아였던 `harness/project-guideline.schema.json` 은 **제거됨(2026-06-26)**. 남은 잔재 = 위 docstring 문구뿐(실행경로 파일이라 후속 정정 예정 — 본 감사 Tier 2).
2. **[4단계 해소 · 9단계 정합 완료]** 캐논은 이제 `packs/_format/<포맷>/canon.json` **정본 1개**로 통합됐다(구 `canon-components*.json`·스키마 type enum 흡수·삭제). `core/docs/reference/canon-blocks.md`·`AGENTS.md` 3번 절·본 문서 캐논 상세절의 구 `canon-components*.json`·`coverage_path` 참조를 전부 canon.json 정본으로 갱신했다(포맷별 캐논 경로는 `format-profiles.json` 의 `canon` 필드가 선택).
4. **[해결됨] 심의 `pass + escalate=true` 게이트 오처리** — *증상(과거):* critic 이 위반 0건 통과(pass)에 `escalate:true`(계약에 없는 소프트 '사람 확인 권고')를 달면, 머지가 그 escalate 를 무조건 전파해 `gate.sh` 전진 조건(`verdict==pass && escalate!=true`)에서 탈락 → `status=escalated` + 현업 화면에 "여러 번 고쳤지만 규정 점검을 통과하지 못했어요"(실제론 통과)라는 오메시지 + 전진 경로 부재. **채택 수정 = ② (머지-스트립).** `scripts/lib/kcia_merge.py` 에서 `final_fail = bool(merged or det_hard)`(차단 위반 또는 결정적 하드 신호 존재 여부)를 끌어올리고, critic(Pass-A)의 escalate 는 `final_fail` 일 때만 전파한다 — `"escalate": bool(base.get("escalate") or (final_fail and _safe_load(passa_p).get("escalate")))`. 즉 verdict==pass 면 critic 의 escalate(노이즈)를 떨어뜨리고, 베이스라인 escalate(전문약 하드스톱 등 — 항상 fail 동반)는 무조건 유지하므로 차단성 escalate 는 절대 누락되지 않는다. **동반:** critic 계약(`prompts/kcia-critic.md`) 출력 규약에 "위반 0건 통과(pass)에는 escalate=true 금지" 명문화. **① gate.sh 분기 추가는 미채택** — pass 에 달린 escalate 는 설계된 신호가 아니라 노이즈이며, 5번째 운영자 동작(사람 확인 분기)·`advance-phase` 가드 완화를 회피하기 위해 `gate.sh`·`advance-phase.sh`·스키마·운영자 화면은 손대지 않았다. **결정(사람, 2026-06-25):** (A) 조용히 자동 전진 + critic 계약 강화 채택(B 권고-필드/C 사람-확인 분기는 보류). **운영 주의:** 이미 pass+escalate `verdict.json` 을 쓰고 `escalated` 로 멈춘 기존 run 은 머지 코드만으론 자가치유되지 않는다(재심의 강제 필요) — 이를 수정 실패로 오인하지 말 것. (escalate 생산처: `scripts/lib/kcia_engine.py`=전문약 하드스톱[high+fail+escalate], critic Pass-A 출력=`scripts/kcia-check.sh`.)