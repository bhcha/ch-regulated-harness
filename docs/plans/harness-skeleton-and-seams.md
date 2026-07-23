# 하네스 구조 뼈대 · seam 지도 — 개선안 23건 반영 전 설계

> **성격**: 설계 문서(코드 무수정). 이 문서는 `runs/ezderm-retinal-detail-0711/IMPROVEMENT-PROPOSAL.md`의 개선안 23건을
> **하나씩 국소 수정하지 않고 구조로 흡수**하기 위한 렌즈다. 앞으로의 모든 수정은 "이 수정이 어느 seam의 계약을
> 만족하는가"를 인용한다 — 그게 표면적 수정을 막는 메커니즘이다.
> 추가로 **Seam F(선택·심의 학습 루프)** — 사용자 선택과 심의 반려가 팩으로 환류되어 다음 생성에 반영되는 확장 — 을
> 포함한다(7번 절 상세 · 9번 절 외부 선례).
> **지위**: `docs/plans/`(진행 중 계획). 구현·골든 재캡처는 이 문서 기준으로 **별도 승인 후** 진행.
> **작성 근거**: origin/main 6555d4f 코드 실측 + IMPROVEMENT-PROPOSAL.md.

---

## 1. 지금 뼈대 — 이미 튼튼한 것 (불변으로 지킨다)

하네스의 하중을 받치는 5축은 건강하다. 어떤 개선도 이걸 훼손하지 않는다.

1. **state.json + scripts 결정론 전이 · LLM은 산출물만 쓴다** (제어 흐름 척추, AGENTS 1번 절)
2. **생성 ≠ 심의 — 다른 벤더·원격 세션** (무결성 경계, AGENTS 1번 절 4)
3. **마이크로커널: core(도메인 중립) + packs(도메인 데이터)** (확장 척추, AGENTS 3·8번 절)
4. **동결 스키마 + validate-stage** (계약 척추, AGENTS 6번 절)
5. **환각 안전 기본값: 근거 없으면 unknown/빈 배열** (안전 척추, AGENTS 5번 절)

**문제는 이 뼈대가 아니다.** 문제는 **가로지르는 관심사(cross-cutting concern)가 뼈대 안에 지정석이 없어서**,
각 단계가 그 관심사를 리터럴 검사로 그때그때 재구현한다는 것이다. 그래서 결함이 국소적으로 재발한다.

---

## 2. 핵심 원리 — "국소 수정 금지"의 진짜 의미

**팩 공통 원칙(전 seam 관통 — 2026-07-11 사용자 지시).** 모든 seam의 **메커니즘은 core 소유·도메인-중립**이라 등록된 모든
팩(cosmetic·drug·quasi_drug·health_food…)에 **균일하게 적용**된다 — 특정 팩 전용 하드코딩(예: `if domain=="cosmetic"`)
절대 금지. 팩-소유 **데이터**(gen-fragment·learned·domain.json 노브)는 **활성 팩 전체에 같은 규약으로 배선**하되, 파일
부재 시 **no-op 폴백**(TBD 팩은 깨지지 않고 빈 상태로 통과). 아래에서 `packs/cosmetic/…`은 **예시일 뿐** — 규약은 `packs/<도메인>/…`
로 모든 팩에 동형 적용된다(core 로더가 `packs/*` 스캔으로 자동 조립, AGENTS 8번 절).

⚠ **이 문서를 오해하면 정반대의 실수를 한다: "구조 = 큰 리팩터"가 아니다.**

- 개선안 23건 중 상당수는 **1줄 수정**이다(E-3 `manual-mock` 하드코드, D-1 change_pct 부호 한 줄, A-2 concept.md 문구).
- 이걸 억지로 "구조"로 부풀리면 과설계다.
- **진짜 규칙**: *모든 수정은 명명된 seam의 계약을 인용한다.* 수정이 작아도 좋다 — 다만 그것이 **어느 seam의 어떤 계약을
  만족시키는지** 말할 수 있어야 하고, 그 seam이 없으면 만들거나(작게라도) 매핑한 뒤 고친다.
- 이렇게 하면 24번째 특수 케이스가 아니라 **기존 계약의 인스턴스**로 떨어진다. 앞으로의 결함도 같은 seam으로 분류된다.

즉 이 문서의 산출은 "리팩터 로드맵"이 아니라 **분류 체계(taxonomy) + seam별 계약**이다. 구현은 그 계약을 따르는 작은 변경들의 합이다.

---

## 3. 빠진 seam 6개 — 계약 정의

각 seam = 지금 지정석 없이 흩어진 하나의 cross-cutting 관심사. 계약(무엇을 집행/정규화/기록) · 현재 인터페이스(코드 실측) ·
구멍 · 흡수 개선안 · 골든/안전 제약을 못박는다.

### Seam A — 증거 출처 원장 (provenance ledger)
가장 하중이 크고 규제-안전의 핵심. **최종면에 실리는 모든 정량 수치·주장이 실재 근거로 추적·집행된다.**

- **현재 인터페이스**:
  - `kcia_engine.py:378-381` — 비-null `evidence_ref`는 실재 id(claim-basis evidence + sources results)와 매칭돼야 함(가짜 인용 차단).
  - `kcia_engine.py:382-404` — `claim_strength ∈ {superlative,efficacy,speed}`(STRONG)인 주장만 각주+`evidence_ref`+`derive_chart` 수치/방향 일치 강제.
  - `validate_storyboard.py:40-77` — `chart_data`를 그 차트를 실증하는 단일 강주장의 `derive_chart` 도출값에 **정확 일치** 결박.
- **구멍**: `claim_strength=factual` + `evidence_ref=null` 조합은 **어떤 원천 대조도 안 받는다**(378은 ref 비-null일 때만, 382는 STRONG일 때만 발동). 그래서 설문 맨숫자 4.091점(B-4)이 통과하고, 상류에서 마케팅 비교문 "100% 동일"이 성분 함량으로 오파싱돼 PRODUCT_FACTS 채널로 흘러도(D-2) 막히지 않는다. **"모든 정량 수치의 단일출처=voc.json"(AGENTS 6번 절)에 factual 수치용 집행 장치가 없다.**
- **계약**: 최종면 카피의 모든 정량 토큰(`\d+(\.\d+)?\s*(점|%|㎟|㎜|배|명…)`)은 4원천 — ① voc.json ② PRODUCT_FACTS ③ claim-basis evidence ④ 대응 claim의 `evidence_ref` 레코드 — 중 하나로 **유도 가능**해야 하며, 유도 불가면 반려. 상류(ingest)는 비교문("동일·일치·유사")을 성분 함량으로 오파싱하지 않는다(원천 오염 차단). 원장은 export에서 **레코드 실제 출처로 라벨**되고(E-3), 미채택 발견은 별도 절로 분리되며(D-4), 배제·미주장 표현은 단일 대장으로 동봉된다(E-2).
- **흡수 개선안**: **B-4**(factual 수치 결박) · **D-2**(PRODUCT_FACTS 오염·product_type 파이프) · **E-3**(manual-mock 라벨) · **D-4**(미채택 발견 분리) · **E-2**(배제 대장). *E-3·D-4·E-2는 Seam D와 표면 공유 — 데이터 소유는 A, 표출은 D.*
- **골든/안전 제약**: 강화형(집행 추가) → false-positive 이행계획 필수(단위 화이트리스트 좁게 시작). ingest 파싱 변경 → **팩 픽스처 골든(voc/claim-basis) 재검증 + 같은 변경에서 픽스처 갱신**. 환각-안전을 강화하는 방향이라 원칙과 정합.

### Seam B — 도메인 규칙 단일출처 → 생성·심의 양쪽 주입
비용·품질의 핵심. **엔진/크리틱이 집행하는 규칙을 팩이 한 번 저작하고 생성기에도 흘려보낸다.**

- **현재 인터페이스**: `build_context.py:384` — RULESET을 **파일 경로로만** 주입(`RULESET: <abs_path>`). 규칙 자체(무엇이 반려되는가)는 생성기에 증류되지 않는다. `REFERENCE_NOTES`(399)·`EVIDENCE_DOCS`(412)·`PRODUCT_FACTS`(421) 라벨은 있으나 `DOMAIN_GEN_RULES` 라벨은 없다.
- **구멍**: 엔진이 결정적으로 아는 규칙(zero-voc 등장 금지 `kcia_engine.py:354-362`, condition_target 타겟팅 금지 `1333-1335`)과 ADK가 일관 집행하는 규칙(마이크로샷 어휘·효능 헤드라인·컨셉 강효능 불가·기관/기간 verbatim·change_pct 부호·suggested_rewrite 불신)이 `prompts/*.md`에 없어, 생성기가 **8사이클 시행착오로 재발견**(brief 심의비용의 78%). 프롬프트-엔진 기준 불일치(예: brief.md 17행 "컨셉 주축 금지" vs 엔진 "등장 자체 위반")가 생성기를 오도한다.
- **계약**: 도메인 규칙 지식은 **팩이 소유**(예: `packs/<도메인>/gen-fragment.md` 신규)하고, 생성-측은 `build_context`의 `DOMAIN_GEN_RULES` 라벨로 주입(soft 권고 — 법=룰셋 우선). 심의용 `critic-fragment.md`와 **별개 파일이되 같은 규칙의 두 표현**(생성 프롬프트에 규칙을 넣어도 심의 게이트는 그대로 — 선인코딩은 비용 절감이지 검증 대체가 아니다). 프롬프트 문구는 엔진 실동작과 일치시킨다.
- **흡수 개선안**: **A-1**(기지 규칙 선인코딩) · **A-2**(컨셉 강효능 불가) · **A-3**(기관/기간 verbatim 지시) · **A-4**('자동삽입' 오해) · **C-3**(suggested_rewrite 불신) · **D-1**(change_pct 부호 규약) · **E-1**(효능어 제품명 표준 대응) · **D-3**(팩 lexicon 한→영 검색 별칭).
- **골든/안전 제약** ⚠ **두 갈래로 갈린다**:
  - **B-prompt** (`prompts/*.md` 파일만 수정) = **산출물 골든 불변**(stub 생성기는 프롬프트를 안 타므로 verify-baseline·test-drug-stub-golden·ctx-*.txt·instr-*.txt 전부 불변). ⚠ **단 `test-prompt-assembly` 의 `prompts.sha256`(프롬프트 원문 해시 동결 tripwire)는 트립된다** — 이는 산출물 변경이 아니라 "프롬프트를 의도적으로 편집했다"는 기록으로, **프롬프트 편집과 같은 커밋에서 재캡처하는 루틴 동반물**이다(선례: ops-plan 다수). 산출물 바이트는 불변이므로 무거운 출력-골든 재캡처와 성격이 다르나, 골든 파일이 바뀌므로 재캡처는 사람 승인으로 남긴다.
  - **B-context** (`build_context.py`에 `DOMAIN_GEN_RULES` 라벨 추가) = **ctx 골든 재캡처 필요**. build_context 출력은 `test-prompt-assembly.sh`가 `ctx-*.txt`로 **바이트 검사**한다(build_context.py 헤더 6-7행). 라벨 추가 = ctx 바이트 변경 → **사람 승인 골든 게이트**. (개선안 A-1의 "build_context는 stub 미사용이라 골든 불변"은 stub-산출물 골든에만 맞고 ctx 골든엔 틀리다 — 정정.)
  - 따라서 **가능하면 B-prompt로 먼저 해소**하고(골든 0), 프롬프트만으로 부족한 규칙만 B-context로 승격(ctx 재캡처 감수).

### Seam C — 증거-맥락 정규화 계층
견고화. **기관명·시험기간·고지문을 리터럴이 아니라 정본형(canonical form)으로 비교한다.**

- **현재 인터페이스**: `kcia_engine.py` `_block_shows_context`(~504-535) — institution은 `inst not in blob` 정확 부분문자열(511), duration은 `re.match`로 문자열 **선두**의 기간 토큰만(527) → 실패 시 전체-verbatim 폴백(533). `check_beforeafter.py:25` — `"연출" in body and "개인차" in body` 단순 substring 2개. 정본 고지 문구는 `CLINICAL_DISCLAIMER`(kcia_engine.py:446)처럼 verbatim 상수로 이미 존재.
- **구멍**: ① `㈜` 한 글자 차이로 기관 불일치(B-2) ② 날짜범위형 duration이 선두매칭 실패 → 카피가 강제로 길어짐(B-1) ③ 리터럴 '연출'이 **부정문 "연출 아님"으로 게이밍**되고, 측정 실사진(연출 아님)에 문구 의미가 어긋남(B-3).
- **계약**: 맥락 검출은 **정본형 비교**를 쓴다 — 법인 접미(`㈜`·`(주)`·`주식회사`)는 양쪽 정규화 후 비교(축약은 불허), duration은 '주/개월' 단위 토큰 추출 비교(우발 '일' 토큰 제외), 고지문은 `CLINICAL_DISCLAIMER`와 동일 설계의 **정본 문구 집합**(연출용/측정용 2종)에 대한 정확 부분문자열. B-1은 데이터 정규화(00e, 엔진 무수정) 우선.
- **흡수 개선안**: **B-1**(duration) · **B-2**(institution) · **B-3**(disclaimer). *A-3은 이 seam의 생성-측 짝 → Seam B.*
- **골든/안전 제약**: 이건 **심의-측(엔진) 변경**이라 골든 위험. 완화형(B-1 2안·B-2)은 "무엇이 덜 검사되는가"를 명시하고 보수 조건을 기본값으로. B-3은 **2단계 이행**(정본 문구 추가 허용→픽스처 갱신→리터럴 토큰 경로 제거). 오프라인 골든/팩 픽스처 재검증 필수.

### Seam D — 런 감사·관측 표면
가시화. **런의 비용·판정·배제·수용을 산출물에서 결정론적으로 조립한다(LLM 불개입).**

- **현재 인터페이스**: `export_package.py`(README/package.json 조립) · `render_runmd.py`(run.md) · `gate.sh`/`next-action.sh`(escalated 안내) · `timing.sh`(심의 소요 요약, 미배선) · `scripts/lib/operator_labels.py`(평이 라벨 단일사전). verdict 이력은 라운드별 파일로 존재(diff 계산 가능).
- **구멍**: 심의 비용(호출 34회·18분)이 `.logs/timing.jsonl`에만(F-1) · 반복지적 vs 신규 미구분(F-2) · 배제·미주장 표현이 4곳 산재·export 미수록(E-2) · 사람 수용위험 기록 경로 없음(C-4) · 근거 상태 오라벨(E-3) · 미채택 발견 혼입(D-4) · 효능어 제품명 사전 경고 없음(E-1) · reviewCapture 대체 미플래그(E-4) · 실행 기록 수기(F-3).
- **계약**: 런 감사 표면을 기존 JSON 산출물에서 **결정론적으로 재조립**한다 — 심의 비용 요약 1줄(F-1) · 반복/신규 지적 diff(F-2) · 배제 대장(E-2) · 근거 상태 실출처 라벨(E-3) · 발견후보 분리절(D-4) · 제품명 효능어 경고(E-1) · reviewCapture 대체 플래그(E-4) · 읽기전용 런 리포트(F-3). 전부 `operator_labels` 경유(평이 라벨, 내부 용어 미노출). **C-4(사람 수용위험)는 이 seam에서 가장 민감** — 자동 무시 금지, 사람 명시 동작 + 감사 로그 + export 동봉 3중 조건.
- **흡수 개선안**: **F-1·F-2·F-3** · **C-4** · **E-4** (+ 표면 절반 공유: E-1·E-2·E-3·D-4 — 데이터 소유는 A, 표출은 D).
- **골든/안전 제약**: export 픽스처 바이트 변경 가능(오프라인은 engine=manual·결과 0건이라 영향 적을 수 있으나 확인 필수). run.md는 `test-operator-language.sh` 회귀 대상 — 평이 라벨 사전 등재 후 사용. `.logs`는 진단 전용(골든 제외).

### Seam E — 원격 심의 회복탄력성 계층
**flaky한 원격 ADK 호출 주위의 재시도·백오프·캐시.**

- **현재 인터페이스**: `adk_critic.py` `_run_agent`(201-254) — 재시도 간 sleep/백오프 **없음**, 기본 retry=8. `kcia-check.sh`(449-473) — Pass-B 1건 실패가 REQUIRED=1에서 라운드 전체 중단·재실행. `packs/cosmetic/domain.json` `adk_critic` 블록에 `retry` 키 없음.
- **구멍**: 첫 턴 빈응답(콜드스타트)을 즉시 24번 두드림(C-1) · Pass-B 후보 1건 소진 실패가 Pass-A+전 Pass-B 재실행 유발(C-2).
- **계약**: 재시도 루프에 지수 백오프(`ADK_CRITIC_RETRY_BACKOFF` env, NanoBanana 429 백오프와 동형) · retry 기본값은 **core 상향(전 팩 상속) + 팩 `adk_critic.retry` 오버라이드**(cosmetic 전용 아님 — 팩 공통 원리) · 산출물 콘텐츠 해시를 키로 Pass-A/Pass-B 단건 결과를 scratch 캐시(성공분 재사용, 실패 후보만 재호출).
- **흡수 개선안**: **C-1**(백오프·retry) · **C-2**(후보별 캐시).
- **골든/안전 제약**: ADK는 온라인 전용이라 **골든 무관**. 캐시는 반드시 산출물 해시 결박(1바이트 변경 = 전체 재심의) — 아니면 '수정 후 옛 심의 재사용' 우회가 된다. env 추가 시 **D-1 동반 갱신**(config-reference.md + AGENTS 2번 절).

### Seam F — 선택·심의 학습 루프 (learned lexicon)
**신규 능력**(23건 결함 흡수가 아니라 확장 요구). **사용자의 선택과 심의 반려가 런을 넘어 축적되고, 별도 분석 단계를
거쳐 팩 소유 학습 어휘(금지어·권장어·선호)로 승격되어, 다음 런의 생성 전 선차단 + 결정적 검증에 반영된다.**
상세 데이터 흐름 = 7번 절.

- **현재 인터페이스** (기록층은 이미 절반 존재):
  - 런별 기록: `decision.json`(선택+근거) · `*-verdict.json` 라운드별(반려 target_text·rule) · `feedback.json`(보완 지시) · `.logs/provenance.jsonl`(L-1 실행 이벤트) — **전부 이미 파일로 남는다**.
  - 팩 어휘 집행 채널: `packs/<도메인>/ruleset.json` lexicon(condition_target 등)을 `kcia_engine`이 결정적으로 집행 — **팩 데이터로 규칙을 먹이는 채널이 이미 있다**.
  - 생성 주입 채널: Seam B의 `DOMAIN_GEN_RULES`(설계) — 학습 어휘도 같은 채널을 탄다.
- **구멍**: 기록이 **런 안에 갇힌다** — 런을 넘는 집계·승격·재주입 경로가 없어, 같은 반려가 다음 런에서 그대로 재발한다(이번 E2E의 기지 규칙 8사이클이 그 증거이자 비용 실측).
- **계약**: ① **기록**(브리프~키비주얼): 새 동작 없음 — 기존 산출물이 이벤트 원장이다(쌓기만, 런 중 행동 불변). ② **분석+③ 승격 = 세션 스킬 `/learn-analyze`(신규 — 사용자 지시)**: 스킬이 읽기 전용 집계 스크립트를 호출해 (target_text, rule) 키로 런·라운드 횡단 집계 → **노이즈·보편어 필터로 자동 제외**한 뒤 **일관성 임계**(독립 K런 이상 일관 반려)를 넘은 것만 후보 → 제안 표로 사람/RA에 제시 → **사람 승인 필수**(확정 — 00e apply-proposal과 동형) → 승인분만 스크립트가 팩에 기록. **자동 제외 필터**: (a) 1회 반려·핑퐁(자기 rewrite 반려) — 크리틱 노이즈 (b) **보편어 가드(사용자 지시)** — 단일 보편 명사(모공·피부·효과 등 팩 `common-terms` 목록에 든 말)는 **단독 금지어 승격 금지**. 승격 후보 = 다토큰 특정 표현 또는 common-terms 밖 희소 표현만(보편 단어를 통째로 막아 정당 카피까지 죽이는 것 방지). ④ **반영**: `packs/<도메인>/learned/` 소유(core 무수정) — 금지어=도메인 스코프 · 선호=브랜드 스코프 **이원화**(확정). 전 엔트리 `scope`·`applies_to`(단계)·`provenance`(유래 run_id·이벤트·승인일) 필수. ⑤ **주입**: 금지어 = 생성 프롬프트 선차단(`DOMAIN_GEN_RULES`) **+** 룰셋 lexicon 병합의 결정적 검증(이중) · 권장어/선호 = 생성 힌트만(soft, 법=룰셋 우선).
- **흡수/연계**: 신규 능력. **C-4**(사람의 위험 수용)와 같은 (target_text, rule) 원장의 반대 방향 · **F-2**(반복지적 diff)가 분석의 일관성 신호 그 자체 · **Seam B** 주입 채널 공유.
- **골든/안전 제약**: `learned/` 부재 → 라벨 미방출·lexicon 병합 no-op(**바이트 불변**) — 골든 픽스처 팩에 learned 없음을 유지하면 기존 골든 전부 불변. **크리틱(ADK) 방향 주입 절대 금지**(관대화·오염 — 생성≠심의 붕괴). 자동 승격 금지(크리틱 비결정성이 영구 규칙으로 굳는 것을 사람이 거른다).

---

## 4. 개선안 23건 → seam 매핑 (전수)

| 개선안 | 주 seam | 부 seam / 비고 | 골든 영향 |
|---|---|---|---|
| A-1 기지 규칙 선인코딩 | B | B-prompt + B-context(gen-fragment) | prompt=0 / ctx 재캡처 |
| A-2 컨셉 강효능 불가 | B | B-prompt만 | 0 |
| A-3 기관/기간 verbatim 지시 | B | C(정규화)의 생성-측 짝 | 0(프롬프트) |
| A-4 '자동삽입' 오해 | B | B-prompt, B-3과 동기화 | 0 |
| B-1 duration 날짜범위 | C | 1안=데이터(00e), 2안=엔진 | 1안 0 / 2안 픽스처 |
| B-2 institution ㈜ | C | 또는 A-3 프롬프트만 | 픽스처 확인 |
| B-3 연출 토큰 게이밍 | C | A-4와 동기화, 2단계 이행 | 픽스처(2단계) |
| B-4 factual 수치 결박 | A | 1단계 프롬프트→2단계 검증 | 강화형 |
| C-1 ADK 백오프·retry | E | env 추가→D-1 | 0(온라인) |
| C-2 Pass-B 캐시 | E | scratch 해시결박 | 0(온라인) |
| C-3 rewrite 불신 | B | gen-fragment(A-1 통합) | prompt=0 |
| C-4 수용위험 경로 | D | **최고 민감** 3중 조건 | export 픽스처 |
| D-1 change_pct 부호 | B | B-prompt(+선택 ingest 정규화) | 0 / 신규분기 |
| D-2 PRODUCT_FACTS 오염 | A | ingest 파싱 | 팩 픽스처 |
| D-3 OpenAlex 질의 품질 | B | 팩 lexicon 별칭 + A/D 라벨 | stub 0 |
| D-4 미채택 발견 분리 | A | 표출=D | export 픽스처 |
| E-1 효능어 제품명 | B | 감지=D, 대응패턴=B | 0(감지·프롬프트) |
| E-2 배제 대장 | A | 데이터=A, 표출=D | export 픽스처 |
| E-3 manual-mock 라벨 | A | 표출=D, operator_labels | export 픽스처 |
| E-4 reviewCapture 대체 | D | B-4와 묶음 | export 픽스처 |
| F-1 심의 비용 가시화 | D | timing→run.md 배선 | run.md 회귀 |
| F-2 반복지적 diff | D | verdict 이력 diff | run.md 회귀 |
| F-3 실행 리포트 | D | 신규 run-report.sh | 신규 |

23건 전수 커버. **주 seam 분포**: A=5(B-4·D-2·E-2·E-3·D-4) · B=8(A-1~4·C-3·D-1·D-3·E-1) · C=3(B-1·B-2·B-3) · D=5(C-4·E-4·F-1·F-2·F-3) · E=2(C-1·C-2). *(다중-seam 항목은 주 seam으로 1회 집계.)*

> **Seam F(학습 루프)는 이 표 밖이다** — 23건의 결함 흡수가 아니라 신규 능력 확장. 단 C-4(사람 수용)·F-2(반복지적
> diff)와 같은 (target_text, rule) 원장을 공유한다(상세 = 7번 절).

---

## 5. seam 간 관계 (구조적 사실)

- **A ↔ D는 같은 provenance 객체를 공유한다.** A는 "생성·검증 시점 집행", D는 "export·run.md 시점 표출". E-3·D-4·E-2는 결국 *provenance를 눈에 보이게 만든 것*이다 → **데이터 모델을 A에서 한 번 정의하면 D는 재조립만** 한다(중복 파싱 금지).
- **B는 생성-측이라 대부분 골든 안전**(B-prompt), C는 심의-측이라 골든 위험. **A-3(생성 verbatim 지시)과 B-1/B-2(엔진 정규화)는 벨트-앤-서스펜더** — 같은 문제의 생성-측·심의-측 두 짝이므로 함께 개정.
- **E는 다른 넷과 직교**(온라인 전용·골든 무관) → 독립 착수 가능.
- **F는 B·D를 재사용하고, 심의로는 흐르지 않는다**: 분석의 일관성 판정 = F-2의 (target_text, rule) diff와 같은 키 · 승격 어휘의 생성 주입 = B의 `DOMAIN_GEN_RULES` 채널 · 결정적 집행 = 기존 룰셋 lexicon 병합. **크리틱 방향 주입은 금지**(관대화 오염 — 생성≠심의). C-4(사람의 위험 수용)와 F의 금지어 승격은 **같은 원장의 반대 방향 항목**이다(수용=재지적을 revise 트리거에서 제외 / 금지=생성 자체를 차단).
- **골든 위험 순위**: 낮음(B-prompt·E) → 중간(ctx 재캡처: B-context) → 높음(픽스처 재캡처: A ingest·C 엔진·D export). 골든 재캡처는 **전부 사람 승인 게이트**.

---

## 6. 새 seam으로 이동·통합이 필요한 기존 기능

seam은 새 계약이지만, 그 관심사를 지금 **부분적으로·흩어져** 구현하는 기존 코드가 이미 있다. 새로 만들기 전에
그것들을 seam의 지정 위치로 **모으거나(consolidate) 이동(relocate)**해야 국소 재구현이 반복되지 않는다.
⚠ 이동은 대부분 작다 — "공유 헬퍼로 추출" / "하드코드 대신 올바른 출처 참조" / "이미 있는 도구 배선"이 대부분이다(2번 절 원리).

**먼저: 이미 올바른 3개 모델 — 이동의 템플릿.**
- `clinical_chart.py` — 차트 도출의 단일 출처, `kcia_engine`·`validate_storyboard`가 함께 import. → **Seam A가 따를 패턴**(공유 모듈 1개를 여러 집행 지점이 참조).
- `operator_labels.py` — 평이 라벨 단일 사전, `render_runmd`·`next-action`이 공유. → **Seam D가 따를 패턴**.
- `image_engine.py:70-95` `_nb_backoff`/`_nb_retry_429` — 429 지수 백오프. → **Seam E가 공유·채택할 원본**.

### Seam A로 모을 것 (provenance)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 근거 실재성·강주장 결박 | `kcia_engine.py:378-404` | 집행이 STRONG·비-null ref에만 | 이 지점 유지 + **factual 정량 수치 스캔을 같은 계층에 추가**(clinical_chart와 나란히 공유) |
| 차트↔도출 결박 | `validate_storyboard.py:40-77` | OK(clinical_chart 공유) | 유지 — 새 정량 스캔이 도출값 재사용 |
| 근거 상태 라벨 | `export_package.py:235`(`"manual-mock"` 하드코드) | **검색엔진 라벨을 사람승인 근거에 오적용**(E-3) | `evidence-documents.json` `spec_origin`(schema:141-144)·kind 기반 라벨 → provenance 라벨링을 A의 공유 로직으로(export는 호출만) |
| 검색엔진 감사 라벨 | `export_package.py:19-27` `_SOURCE_STATUS` | sources용으론 정상 | **claim-basis 근거와 분리 유지**(두 라벨 도메인을 섞지 않음 — 이게 E-3의 근본) |
| 성분 함량 추출 | `ingest.py:492-508` | 비교문("100% 동일")을 함량으로 오파싱(D-2) | 비교-문맥 deny를 추출부에 넣어 **원천에서 차단**(하류 검증 이전) |

### Seam B로 모을 것 (도메인 규칙 단일출처)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 심의 규칙 서술 | `prompts/kcia-critic.md`(core, 중립) | 도메인 규칙 지식의 **팩 소유 홈이 없다** | 사람이 읽는 도메인 규칙을 **신규 `packs/<도메인>/gen-fragment.md`로 저작**(첫 팩-소유 규칙 지식) |
| 인라인 규칙 로직 | `kcia_engine.py:354-362`(zero-voc)·`1333-1335`(condition_target) | 엔진 로직은 여기 유지 정당 | **로직은 이동 안 함** — 단 그 규칙의 사람-읽는 서술을 gen-fragment에 병기(생성기에 흘림) |
| 생성 프롬프트 규칙 재진술 | `prompts/brief.md:17` 등 | 엔진과 기준 불일치("주축 금지" vs "등장 금지") | 도메인 특수 서술은 gen-fragment로, 코어 프롬프트는 `DOMAIN_GEN_RULES` 참조(코어=중립 유지) |
| 규칙 주입 지점 | `build_context.py:384`(RULESET=경로만) | 규칙 자체 미증류 | `DOMAIN_GEN_RULES` 라벨 추가(⚠ ctx 골든 재캡처) |

### Seam C로 모을 것 (맥락 정규화)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 고지문 검증 | `check_beforeafter.py:25`(독립 validator, 리터럴 substring) | `CLINICAL_DISCLAIMER`와 **별개 메커니즘 2개** | 두 곳을 **정본 고지문 집합 공유 모듈**로 수렴 |
| 정본 고지 상수 | `kcia_engine.py:446` `CLINICAL_DISCLAIMER` | 좋은 모델, 단일 문구 | 연출용/측정용 2종으로 확장·공유(B-3) |
| 기관/기간 맥락 검출 | `kcia_engine.py` `_block_shows_context`(~511·527) | 리터럴/선두매칭 인라인 | 정본형 비교 헬퍼로 추출(공유) |
| 흩어진 정규화 헬퍼 | `ingest.py:1206`·`openalex.py:245`·`validate_storyboard.py:208` | 파일별 산발 | 맥락 정규화만 **하나의 헬퍼**로(기존 것들은 용도별이라 강제 통합 아님 — C 관심사만 모음) |

### Seam D로 배선할 것 (감사 표면)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 심의 소요 요약 | `timing.sh`(요약), `render_runmd.py:459`(진행 신호만 읽음) | **요약이 run.md/export에 미배선** | 호출수·재시도·소요를 render_runmd/export에 배선(F-1, operator_labels 경유) |
| 배제·미주장 데이터 | brief.json `sensitive_labels`·claim-basis `unsupported_claims`·00e 플래그 | 4곳 산재·export 미수집 | export_package가 **단일 배제 대장으로 수집**(E-2 — 생산자 유지, 소비자 신설) |
| 평이 라벨 | `operator_labels.py` | 좋은 모델 | 유지 — 새 표면 문구 전부 여기 등재(회귀=test-operator-language) |

### Seam E로 공유할 것 (심의 회복탄력성)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 429 지수 백오프 | `image_engine.py:70-95`(NanoBanana 전용) | ADK엔 없음 | 백오프 로직을 **공유 헬퍼로 일반화**, `adk_critic.py:210` 루프가 채택(C-1) |
| ADK 재시도 | `adk_critic.py:189-210`(retry, 백오프 없음) | 콜드스타트를 즉시 두드림 | 공유 백오프 채택 + 팩 `adk_critic.retry` 기본값 |

### Seam F가 재사용할 것 (신설이지만 부품은 전부 기존)
| 기존 기능 | 현재 위치 | 문제 | 이동·통합 목표 |
|---|---|---|---|
| 선택 기록 | `runs/<id>/*/decision.json` | 런 안에 갇힘 | 분석 단계가 런 횡단 수집(이동 아님 — **소비자 신설**) |
| 반려 기록 | `*-verdict.json` 라운드별 | 〃 | 〃 (F-2와 같은 (target_text, rule) 키) |
| 실행 원장 | `.logs/provenance.jsonl`(L-1) | 진단 전용 | 분석의 이벤트 소스로 승격(읽기 전용) |
| 팩 어휘 집행 | `ruleset.json` lexicon + `kcia_engine` | 정적(수동 저작만) | `learned/deny`를 lexicon 병합으로 수렴 — **같은 집행 코드 재사용** |
| 제안→승인→기록 패턴 | 00e apply-proposal | 00e 전용 | 승격 게이트가 같은 패턴 재사용(제안 파일 → 사람 승인 → 스크립트만 기록) |

**이동 요약**: seam A~E의 신규 파일은 사실상 2개(`packs/<도메인>/gen-fragment.md` · 공유 백오프/정규화 헬퍼)뿐이고,
나머지는 **하드코드 교정·기존 도구 배선·인라인 로직의 공유 추출**이다. **Seam F만 진짜 신설** — 세션 스킬 `/learn-analyze`
(분석+승격, 00e apply-proposal 패턴 재사용) + 읽기전용 집계 스크립트 + `apply-learnings.sh` + `learned-lexicon.schema.json`
+ 팩 `learned/`·`common-terms.json`(전 팩 동형) — 이며, 그마저 기록층·집행층·승인 패턴은 전부 기존 재사용이다(위 표).

---

## 7. Seam F 상세 — 학습 루프 데이터 흐름

```
[기록 — 런 안 · 이미 존재 · 쌓기만]
  decision.json(선택+근거) · *-verdict.json 라운드(반려) · feedback.json(보완)
  · .logs/provenance.jsonl(실행 이벤트)
        │  브리프~키비주얼: 새 동작 없음 — 런 중 행동 불변(요구 그대로)
        ▼
[분석+승격 — 런 밖 · 세션 스킬 `/learn-analyze` · 신규]     state.json 무관(스크립트만 기록)
  스킬이 읽기전용 집계 스크립트 호출:
    → (target_text, rule) 키 결정적 집계(런·라운드 횡단)
    → 자동 제외 필터:
        · 1회 반려·핑퐁(크리틱이 자기 rewrite 반려) — 노이즈
        · ★ 보편어 가드(사용자 지시) — 팩 common-terms 의 단일 보편 명사(모공·피부·효과…)는
          단독 금지어 승격 금지. 후보 = 다토큰 특정 표현 또는 common-terms 밖 희소 표현만
          (보편 단어를 통째로 막아 정당 카피까지 죽이는 것 방지)
    → 일관성 임계(독립 K≥2 런 일관 반려) 통과분만 learned-proposal.json 후보(+provenance)
        ▼ 스킬이 제안 표로 사람/RA 에 제시(00e apply-proposal 동형)
    사람 승인 → apply-learnings.sh (승인분만 팩 기록 — 스크립트만 씀; state 규칙 1번)
        ▼
[반영 — 팩 소유 · core 무수정 · 전 팩 동형]
  packs/<도메인>/learned/deny.json            # 심의반려 유래 금지어(도메인 스코프)
  packs/<도메인>/learned/brands/<브랜드>.json   # 선택 유래 선호(브랜드 스코프)
  packs/<도메인>/common-terms.json            # 보편어 가드 입력(단독 승격 금지 목록; 팩 소유·사람 저작)
  · harness/learned-lexicon.schema.json(신규 동결 계약)으로 검증
  · 전 엔트리 필수: scope(domain|brand) · applies_to(적용 단계 목록|all)
    · provenance(유래 run_id·이벤트·승인일) · 재검토일(권장)
        ▼
[주입 — 각 단계 · 이중]
  생성 선차단: build_context 가 DOMAIN_GEN_RULES(Seam B 채널)에 learned 병합 주입
  결정적 집행: 금지어 → 룰셋 lexicon 병합 → kcia_engine/validate-stage 기존 코드로
              fail-closed(생성돼도 못 나감). 권장어·선호 → 힌트만(soft, 법=룰셋 우선)
```

**단계별 적용**(`applies_to` 필터로 결정 — 하드코딩 없음):

| 단계 | 금지어(deny) | 권장어·선호(prefer) |
|---|---|---|
| 01-brief | 헤드라인·PR·FAQ 카피 선차단+검증 | 톤·서술 패턴 힌트 |
| 02-concept | RTB·키메시지 선차단+검증 | 축 선호(선택 이력) 힌트 |
| 03-storyboard | 블록 카피 선차단+검증 | 구도·스토리 패턴 힌트 |
| 04-keyvisual | HTML 카피 선차단+검증 | 레이아웃·비주얼 선호 힌트 |
| 00a·00e·00g | 적용 안 함(카피 아님 — 심의 면제 단계와 동일 논리) | 〃 |

**핵심 불변식 4개**:
1. **기록층은 런 중 행동을 바꾸지 않는다** — 쌓기만. 분석·승격은 전부 런 밖(파이프라인 단계 삽입 아님).
2. **자동 승격 금지 — 사람 승인 필수**(확정). 크리틱 비결정성(이번 E2E 실측: 핑퐁·flaky·escalate 갈림)이 영구 규칙으로 굳는 것을 사람이 거른다. 분석기의 일관성 임계는 승인 전 노이즈 필터일 뿐 승인 대체가 아니다.
3. **scope·provenance는 첫날부터 필수 필드** — 스코프는 소급 불가능한 데이터 차원이다(섞어 쌓은 뒤엔 못 가른다). 이원화(금지어=도메인·선호=브랜드)로 시작(확정) → 훗날 단일로 합치기는 '스코프 무시 병합' 한 번이라 쉽고, 역방향(단일→이원화)은 불가능. **이것이 스코프 결정의 구조적 근거다.**
4. **크리틱 방향 주입 금지** — learned는 생성·룰엔진에만. 심의(원격 ADK)에 넣으면 관대화 오염(생성≠심의 붕괴).

**골든**: `learned/` 부재 시 완전 no-op(라벨 미방출·병합 없음 = 바이트 불변). 골든 픽스처 팩에 learned 없음을 유지 →
기존 골든 전부 불변, learned 포함 경로는 신규 테스트로만 커버.

---

## 8. 사용자 활용성·피드백루프 저해 체크 ⚠

구조 변경이 현업 루프("본다→생성→승인/보완/선택→심의"와 다시 돌리기)를 해치지 않도록 별도 관리하는 리스크 목록.
방향 자체는 순이익 — **"무음 오류 + 비싼 비결정 반려" → "이르고 결정적인 반려 + 싼 재실행"** — 이지만 아래 7건은 지키지 않으면 역효과다.

| # | 저해 요소 | 어느 seam | 완화(설계 요건) |
|---|---|---|---|
| ① | **승인 밖 수치 반려의 회복 경로 미결** — "맞는 수치인데 스펙에 없어 못 쓴다"일 때 이미 지나온 00e로 되돌아가는 경로가 없다. 방치하면 사용자가 갇히거나 JSON 손편집(4동작 위반) 유발 | A | 반려 문구가 평이 한국어로 두 갈래를 지목: (a) 카피에서 수치 제거(revise 루프가 자연 처리) (b) **00e 스펙 재개방→재승인→하류 재검** 경로 신설 — seam A 구현의 필수 요소(10번 절 결정거리) |
| ② | **신호 마스킹 + 이중표현 드리프트** — 생성기가 위반을 안 만들면 "규칙이 아직 유효한가" 신호가 사라지고, gen-fragment와 엔진이 어긋나면 "시키는 대로 했는데 반려" 혼란 | B·F | fragment·learned를 D-1 동반갱신에 편입 + 룰셋↔fragment 정합 테스트. 심의 게이트 불변(마스킹 감지의 최후선) |
| ③ | **이행기 비일관** — 2단계 이행(정본 문구 추가 허용→리터럴 제거) 중 같은 문구가 시점 따라 pass/fail | C | 이행을 짧게, 런 단위로 끊기(런 중간 규칙 변경 금지) |
| ④ | **run.md 정보 과잉** — 감사 정보가 "지금 할 일 한 줄"을 희석 | D | run.md엔 행동 필요분만(반복지적 경고 1줄·심의비용 1줄), 대장·리포트는 export/run-report로. operator_labels 등재 + test-operator-language 회귀 |
| ⑤ | **백오프 체감 정체** — 실패 확정까지 대기가 길어져 행으로 오인(이번 런 idle-폴링 오인 실존) | E | 하트비트에 "재시도 N/M — 심의 서버 응답 대기 중" 평이 문구. 캐시 해시결박은 안전 불변식으로 회귀 테스트 선행 |
| ⑥ | **골든 재캡처 기간의 루프 정지** — 재캡처 사이클 동안 개선 반영 지연 | A·C·D | 착수 순서로 완화: 골든 0인 B-prompt·E 먼저, A·C·D는 seam별 1회 묶음 승인 |
| ⑦ | **보수화 나선·사어(死語) 영구화** — 금지어가 쌓일수록 산출물 균질·보수화, 규제/룰셋이 바뀌어도 옛 금지어가 영구 차단(F의 고유 리스크) | F | 엔트리 재검토일 + 분석 단계가 "최근 N런에서 한 번도 안 걸린 금지어" 리포트(불용 후보 가시화) → 해제도 사람 승인. 선호는 브랜드 스코프 격리로 오염 차단 |

---

## 9. 유사 구조 리서치 — 외부 선례가 검증하는 것 (2026-07 조사)

| 선례 | 대응 | 검증하는 것 / 경고하는 것 |
|---|---|---|
| **제약 MLR 사전심의 — Veeva PromoMats 클레임 라이브러리·모듈러 콘텐츠** ([제품](https://www.veeva.com/products/veeva-promomats/) · [MLR AI 분석](https://intuitionlabs.ai/articles/automating-mlr-review-veeva-promomats-ai) · [MLR pre-check 개관](https://www.getshaman.com/post/mlr-precheck-solutions-pharma)) | **Seam F 전체와 도메인까지 동일**(규제 마케팅 자료의 사전점검) | 승인·반려된 클레임을 라이브러리로 축적→재사용(클레임 재사용 최대 70%·리뷰 사이클 50% 단축 보고). AI 'Quick Check'가 가이드라인 대조 **사전점검** = 우리 '생성 전 선차단'과 동형. **사람(MLR) 승인 게이트는 불변** — 업계 표준도 자동 승격을 안 한다 |
| **DSPy — 프롬프트 컴파일 최적화** ([개관](https://www.dbreunig.com/2024/12/12/pipelines-prompt-optimization-with-dspy.html) · [Databricks 사례](https://www.databricks.com/blog/optimizing-databricks-llm-pipelines-dspy)) | '분석 단계의 런 밖 분리' | 피드백→프롬프트 개선을 **런타임이 아닌 오프라인 컴파일 단계**로 분리하는 것이 확립된 패턴 — 우리의 "런 중엔 쌓기만, 분석은 별도" 결정과 동형 |
| **NeMo Guardrails / policy-as-YAML(OPA)** ([구성 가이드](https://docs.nvidia.com/nemo/guardrails/latest/user-guides/configuration-guide.html) · [OPA 방식](https://medium.com/@aatakansalar/writing-guardrails-as-yaml-enforcing-them-with-opa-e17c76e05a4a)) | '팩 소유·하드코딩 금지' | 정책(deny·rails)을 **코드 밖 선언 데이터**로 분리해 도메인 전문가가 코드 무수정으로 유지보수 — packs/learned 소유 구조와 동형 |
| **에이전트 장기메모리·선호 학습 연구(2025-26)** ([실무 정리](https://www.philschmid.de/memory-in-agents) · [Preference-Aware Memory Update](https://arxiv.org/pdf/2510.09720)) | '선호 축적·주입' | 선호를 프롬프트에 직주입하는 패턴은 확립 — 단 **스코프 분리 없이 공유 프롬프트에 섞으면 컨텍스트 오염**(브랜드 스코프 이원화 결정을 지지). append-only가 아니라 주기적 **통합(consolidation)**이 필요 = 우리 분석 단계의 역할 |

종합: 이 구조(축적→오프라인 분석→사람 승인 승격→선언적 정책 주입)는 발명이 아니라 **규제 콘텐츠 업계(MLR)와 LLM 운영
양쪽에서 수렴된 패턴**이다. 선례들이 공통 경고하는 함정 2개 — 노이즈 오염(→사람 승인 게이트)·컨텍스트 오염(→스코프
이원화) — 는 이미 계약에 반영했다.

---

## 10. 다음 결정거리

**확정(2026-07-11 사용자 결정)**:
- Seam F 승격 게이트 = **사람 승인 필수** · 학습 스코프 = **이원화**(금지어=도메인 팩 · 선호=브랜드 오버레이; 근거 = 7번 절 불변식 3 — 스코프는 소급 불가).
- **착수 순서 = B-prompt·E 먼저 → A → C·D → F**(골든 0 즉효부터, F는 B 채널 완성 뒤 — 그동안 런 기록은 자연 축적).
- **E-3(manual-mock 오표기)은 seam 순서와 별개로 즉시 수정**(Seam A 계약 인용 1건 — 라벨은 레코드 실출처 기준). **[완료 c986f7c · 골든-0 검증]**
- **Seam F 분석+승격 = 세션 스킬 `/learn-analyze`** · **보편어 가드**(단일 보편 명사는 단독 금지어 승격 금지 — 팩 `common-terms`; 보편 단어 전면 차단으로 정당 카피까지 죽이는 것 방지).
- **팩 공통** — 모든 seam의 core 메커니즘은 도메인-중립이라 전 팩 균일 적용(팩 전용 하드코딩 금지). 팩 데이터는 활성 팩 전체에 동형 배선(부재=no-op).
- **검증·문서 규율** — 각 단계 **Codex 리뷰로 지속 검증**(이상 0까지 fix 반복). 전 작업 완료 후 **SSoT 반영**: `AGENTS.md`(env/규칙) + 정본 5개(D-1 동반갱신 의무) 해당 구역 갱신.
- 권장값 채택: 분석 임계 K=2(독립 런 기준)·분석 명시 실행 · 브랜드 선언 = `new-run --brand` 선택 인자(+intake 인자, 미선언=브랜드 학습 비활성) · 골든 재캡처 = seam별 1회 묶음 승인.

미결(해당 seam 구현 승인 전 확정 필요):

1. **seam A의 데이터 모델** — provenance 원장의 필드/스키마(동결 계약 → 완화만, 후방호환). A·D·F가 공유하므로 먼저 확정.
2. **seam A 반려의 00e 재개방 회복 경로**(저해 ①) — 스펙 재승인→하류 재검의 게이트 설계. seam A 구현의 선행 조건.

---

## 11. 구현 진행 로그 (2026-07-11 · feat/harness-seams)

| 단계 | 상태 | 커밋 | 검증 |
|---|---|---|---|
| 작업0 E-3 | ✅ 완료 | c986f7c | 골든-0(cosmetic 180·drug 100) · Codex High 0 |
| 선재 drift 정정(prompts.sha256) | ✅ 완료 | f02f5e2 | 10ccba2 docs reorg 동반 누락 정정 · prompt-assembly 12/0 회복 |
| 1차 B-prompt(A-2·A-3·A-4·D-1·brief) | ✅ 완료 | 969f704 | prompt-assembly 12/0 · 산출물골든 불변 · 도메인누출 0 · Codex High(도메인어휘) 해소 |
| 1차 Seam E C-1(백오프) | ✅ 완료 | 23dad9b | test-observability 31/0 · 백오프 파싱 견고 · Codex High/Critical 0 |
| 1차 Seam E **C-2(Pass-B 캐시)** | ⏸ **deferred** | — | online-only·해시결박 안전-critical(설계상 "가장 민감"). **C-1 백오프가 flaky 재시도 비용을 이미 줄이므로 E2E 에서 C-1 효과 측정 후 필요성 판단** — 아니면 focused 별도 스텝(온라인 검증 동반) |
| 2차 B-context(gen-fragment cosmetic+drug + build_context 배선) | ✅ 완료 | (커밋) | ctx-*.txt 6개 사람 승인 재캡처 · prompt-assembly 12/0 · verify-baseline 180·drug 100 불변 · domain-leak PASS · Codex High/Critical 0. C-3(rewrite 불신)도 gen-fragment 에 포함 |
| 3차 B-4(정량 스캔) | ✅ 완료 | (커밋) | 검증 스캔(스키마 무변경) · 골든-0(근거0=임상수치 없음) · test-b4 신규실패 0 · Codex High/Critical 0 |
| 3차 D-2(ingest 오파싱) | ✅ 완료 | (커밋) | 비교-deny + 파이프 strip · 기능 PASS · 골든-0(골든 WB에 패턴 없음) · Codex High/Critical 0 |
| 3차 D-4(발견/실증 분리) | ✅ 완료 | (커밋) | discovery 조건부 분리 · 골든-0(오프라인 discovery=0) · Codex High/Critical 0 |
| 3차 E-2(배제 대장) | ✅ 완료 | (커밋) | export 골든 사람승인 재캡처(정확히 README+package.json 2항목) · verify-baseline 180 · Codex High(approved dedup) 수정 → **3차 Seam A 완결** |
| 4차 Seam C(B-1 duration·B-2 ㈜·B-3 연출/측정) | ✅ 완료 | (커밋) | 정본형 비교 완화 · 골든-0(근거0 inert) · test-components 43/0 · Codex High/Critical 0 → **Seam C 완결** |
| 4차 Seam D — F-1·F-3·E-4 | ✅ 완료 | (커밋) | F-1 심의재시도 가시화(online·골든무관) · F-3 실행리포트(신규·읽기전용) · E-4 reviewCapture 플래그(VOC0+collected 판정, 골든 inert). 각 Codex High 발견·수정(F-3 traversal·crash, E-4 review_count 객체) |
| 4차 Seam D — **F-2**(반복지적 diff) | ⏸ **deferred** | — | ⚠ 발견: verdict 라운드 이력이 없다(단일 파일 덮어씀) — 설계 가정과 다름. **round-history 보존이 선행**돼야 하는 더 큰 변경(가벼운 additive 아님). 이력 보존 설계 후 착수 |
| 4차 Seam D — **C-4**(수용위험 acknowledged-violations) | ⏸ **deferred** | — | ⚠ **계획 전체에서 가장 민감한 변경**(AGENTS: 자동무시 절대금지·3중조건 사람명시동작+감사로그+export동봉). 신규 레코드+approve.sh+kcia-check+export 교차. 신선한 예산에서 전용 착수 |
| 5차 Seam F | ✅ 완료 | (커밋) | F-a 스키마+common-terms · F-inject 이중(생성 선차단 build_context + 룰엔진 집행 kcia_engine) · F-b analyze_learnings(K임계·보편어·핑퐁) · F-c apply-learnings.sh + /learn-analyze 스킬. 각 Codex High 다수 수정(regulatory_domain 크래시·malformed 가드·traversal·'.' domain). 전체 learned 부재=no-op(verify-baseline 180) |
| SSoT 반영 | ▶ 다음 | — | AGENTS.md(ADK_CRITIC_RETRY_BACKOFF env) + config-reference·feature-catalog·pack-catalog·README(D-1) |
| E2E 재검증 | 대기 | — | 서브에이전트 상세기록·온라인 실엔진(capstone) |
| 5차 Seam F | 대기 | — | learned 스키마·분석/승격 스킬·주입·보편어 가드(대형 신규) |
| E2E 재검증 | 대기 | — | 서브에이전트 상세기록·온라인 실엔진 |
| SSoT 반영 | 대기 | — | AGENTS.md(env: ADK_CRITIC_RETRY_BACKOFF) + 정본 5개(D-1) |
| 5차 Seam F | 대기 | — | learned 스키마·분석/승격 스킬·주입 + 보편어 가드(대형 신규) |
| E2E 재검증 | 대기 | — | 서브에이전트 상세기록(화장품 다장, temp4 PDF) · 온라인 실엔진 |
| SSoT 반영 | 대기 | — | AGENTS.md(env) + 정본 5개(D-1) — 전 작업 완료 후 배치 |

**SSoT 반영 대기(pending — 전 작업 완료 후 배치)**: `ADK_CRITIC_RETRY_BACKOFF`(C-1 신규 env) → `AGENTS.md` 2번 절 + `docs/canonical/config-reference.md`(D-1 동반갱신). 그 밖 seam별 env·동작 변경도 완료 시 정본 5개 해당 구역 갱신.

**C-3(rewrite 불신)** = 1차에서 2차로 이동(gen-fragment 소속). C-1 은 팩 retry 오버라이드 기존 지원 + 백오프 전 팩 공통.

## 12. 공통 안전 제약 (전 seam 적용 — AGENTS 재확인)

1. **실증·환각-안전 약화 금지**: 완화형(C, B-1 2안, D-1 2안)은 "무엇이 덜 검사되는가" 명시 + 보수 조건 기본값. 강화형(A: B-4·D-2)은 false-positive 이행계획 동반.
2. **골든 바이트 불변이 기본**: 흔들리면 **멈추고 사람 승인**(임의 재캡처 금지). B-prompt·E는 안전, 나머지는 픽스처/ctx 재캡처 게이트.
3. **생성 ≠ 심의 격리 불변**: 어떤 개선도 로컬 크리틱 부활·크리틱 관대화 이력주입·심의 게이트 우회를 만들지 않는다. Seam E 캐시는 산출물 해시 결박 필수.
4. **D-1 동반 갱신**: env 추가(Seam E 백오프)·파이프라인 동작 변경 시 `docs/canonical/config-reference.md`·`workflow-ssot.md` 해당 구역 같은 변경에서 갱신.
5. **제품 심의는 하네스가 대신 판정하지 않는다**(AGENTS 7번 절): E-1 제품명·E-4 대체·C-4 수용은 전부 **정보 제공까지**, 판단은 RA.
6. **학습 어휘(Seam F)는 생성·룰엔진 방향만** — 심의(원격 ADK)에 주입 금지(관대화 오염). 승격은 사람 승인 + provenance 필수, 자동 승격 금지. 해제(불용 금지어 제거)도 사람 승인.
7. **learned/ 부재 = 완전 no-op** — 골든 픽스처 팩에 learned 없음 유지로 기존 골든 바이트 불변. learned 경로는 신규 테스트로만 커버.
