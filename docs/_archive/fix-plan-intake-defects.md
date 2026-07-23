# intake 결함 수정계획 — A-DEF-1(도메인 전달 누락) · A-DEF-2(다품목 WB 스코핑)

> 작성 2026-07-08 · 상태: **실행 대기(착수 조건 있음 — 아래 0단계)**
> 출처: 팩분리 E2E 검증(트랙 A, 화장품 `relief-acne-e2e` · 의약품 `ursa-lineup-e2e` 실런)에서 발견된
> 선재 결함 2건. 파일:줄은 **2026-07-08 main `c181284` 실측** — 착수 시 심볼 기준 재확인 필수
> (트랙 B `cleanup/kernel-track` 병합 후에는 줄번호가 흐른다).
> ⚠ 두 건 모두 **동작 변경**이다 — 값-불변 정리(트랙 B) 범위 밖이며 별도 브랜치로 수행한다.

## 0단계 — 착수 조건·순서 (충돌 회피)

1. **병렬 런 종료 후 착수**: 트랙 A(E2E 검증) 완료 + 트랙 B(`cleanup/kernel-track`)가 main 에 병합된 **뒤**에 시작한다.
   - 이유: 트랙 B 4단계(K-2)가 `gate.sh` 상태 쓰기·스캐폴딩을, 5단계(K-3)가 `validate-stage`·`build_context` 를
     이관한다 — 본 수정과 파일이 겹친다(`gate.sh`·`ingest.py`). 먼저 병합된 최신 main 위에서 작업해야 충돌·재작업이 없다.
2. 브랜치: 결함별 독립 브랜치 — `fix/intake-domain-plumbing`(A-DEF-1) · `fix/wb-multi-sku-scoping`(A-DEF-2).
   A-DEF-1 이 먼저(작고 명확·온라인 정문이 현재 워크어라운드 없이는 막혀 있음), A-DEF-2 는 그 다음.
3. 공통 규율: 커밋 분리(원인 격리) · 단위별 Codex 리뷰 · 전체 CI(선재 실패 기준선 확인) ·
   `docs/workflow-ssot.md` 동반 갱신(동작 변경이므로 의무) · state.json 은 scripts 만 쓴다.
4. 검증 원칙: 이 수정들은 **막힌 경로를 뚫는 것**이지 산출물 값을 바꾸는 게 아니다 — 골든
   (verify-baseline·test-drug-stub-golden·test-prompt-assembly·test-b3)은 **불변**이어야 한다.
   골든이 흔들리면 수정이 생성 경로를 오염시킨 것 → 즉시 멈추고 원인 규명.

---

## 1단계 — A-DEF-1: 온라인 intake 정문의 HARNESS_DOMAIN 전달 누락 (High)

### 증상 (실런 재현 2지점)
- 첨부폴더 정문(`intake.sh`)으로 시작한 런이 **사람 승인 뒤 라우팅/반영 단계에서** 멈춘다:
  - 재현 1: 00a-intake 승인 → `gate.sh` 의 apply-intake 훅 → `[ingest] HARNESS_DOMAIN 미설정 …` 으로 중단.
  - 재현 2: 00e-evidence 스펙 승인 → `gate.sh` 의 apply-proposal 훅(`gate.sh:89` 부근에서
    `ingest.py apply-proposal` 직접 호출) → 동일 중단.
- 화장품(`relief-acne-e2e`)·의약품(`ursa-lineup-e2e`) 양 도메인에서 재현 — 도메인 무관 회귀.
- 현장 워크어라운드: `HARNESS_DOMAIN=<state 선언값>` 인라인 세팅(값 조작 아님). 이 계획으로 워크어라운드를 없앤다.

### 근본 원인 (코드 실측)
1. `scripts/lib/ingest.py:47` — **모듈 로드 시점**에 `_PROFILE = _ingest_profile()` 을 평가하고,
   그 안의 `_active_domain()`(:27-29)이 env `HARNESS_DOMAIN` 을 요구하며 없으면 즉시 die.
   → env 를 안 넘기는 호출자는 **서브커맨드 로직에 들어가 보지도 못하고** 모듈 임포트에서 죽는다.
2. 정상 채널은 배관이 있다: `scripts/ingest-bundle.sh:38` 이
   `HARNESS_DOMAIN="$(resolve_domain "$(state_file "$RID")")"; export HARNESS_DOMAIN` 으로
   **state.json(사람 선언의 진실)에서 도메인을 읽어 주입**한다.
3. `scripts/gate.sh` 에는 `HARNESS_DOMAIN` 참조가 **0곳** — apply 훅들이 배관 없이 `ingest.py` 를 호출한다.
   설계 의도(:1976 "사람 선언은 state.json 이 진실", :1981)와 구현이 어긋난 상태.
4. 테스트가 못 잡은 이유: `tests/test-intake.sh` 등이 env 를 **명시 export** 하고 돌려서 갭이 마스킹됐다.

### 수정 방안 (커밋 3개로 분리)

**커밋 ① gate.sh 배관 — apply 훅에 도메인 주입** (최소·핵심)
- 착수 정찰: `gate.sh` 안에서 `ingest.py`/`ingest-bundle.sh` 를 호출하는 지점 전수 나열(재현 2지점 외
  추가 호출부 유무 확인). `ingest-bundle.sh` 상단 가드(:21-22 env 요구 die)와 :38(state 재해석)의
  선후 관계도 확인해 apply-intake 경로가 정확히 어디서 죽는지 고정한다.
- 수정: 각 apply 훅에서 `ingest.py`/`ingest-bundle.sh` 호출 **직전**에 ingest-bundle 과 동형 한 줄:
  `HARNESS_DOMAIN="$(resolve_domain "$SF")"; export HARNESS_DOMAIN`
  (`resolve_domain` 은 `common.sh` 기존 헬퍼 — 산재 폴백 일원화가 이미 끝난 함수를 재사용한다.
  트랙 B 4단계가 gate.sh 를 만졌다면 그 시점 심볼로 재확인.)
- 의미: 사람이 이미 state 에 선언한 도메인을 셸이 전달만 하는 것 — 새 결정·폴백 없음.
  state 에 도메인이 없으면 기존대로 fail-closed(cosmetic 조용 폴백 폐지 결정 유지).

**커밋 ② ingest.py — 모듈로드 시점 die 제거(lazy 화)** (방어심층)
- `_PROFILE = _ingest_profile()`(:47) 를 **지연 평가**로 바꾼다: 최초 사용 시점에 로드·메모이즈하는
  액세서(예: `_profile()` 함수 + 캐시)로 치환하고, `VOC_KEYWORDS` 등 모듈 상수 소비부(:49-52 등)를
  액세서 경유로 정리한다.
- 효과: ① 도메인이 필요 없는 서브커맨드/임포트가 env 때문에 죽지 않는다 ② 도메인이 필요한 시점에는
  기존과 동일하게 fail-closed(메시지 불변). **동작 의미는 보존, 죽는 위치만 올바른 곳으로** 옮긴다.
- 주의: 이 커밋 단독으로도 재현이 사라질 수 있으나 커밋 ① 을 생략하지 않는다 — apply 훅이 도메인
  없이 호출하는 구조 자체가 설계 위반(state=진실 전달 의무)이므로 배관을 반드시 채운다.

**커밋 ③ 테스트 보강 — 마스킹 제거** (재발 방지)
- `tests/test-intake.sh` 에 케이스 추가:
  - (양성) intake 정문 런에서 `env -u HARNESS_DOMAIN` 상태로 승인→apply-intake→00-ingest 도달,
    이어서 00e 승인→apply-proposal 성공 — **env 없이 state 만으로 완주**를 단정.
  - (음성) state 에 도메인 없음 + env 없음 → 명확한 안내와 함께 fail-closed 단정(조용 진행 금지).
- 기존 케이스의 명시 export 는 유지(선언 채널 테스트)하되, 위 무-env 케이스가 갭을 상시 감시한다.

### 검증·DoD (A-DEF-1)
- 타겟: `test-intake` · `test-routes` · `test-b0` → 골든 4종 불변 → 전체 CI(기준선 외 실패 0) → Codex 리뷰.
- 온라인 스모크 1회: 첨부폴더 정문 미니 런으로 승인→라우팅→00-ingest 진입을 **워크어라운드 없이** 통과.
- DoD: 재현 2지점 소멸 · 무-env 테스트 그린 · 골든 불변 · workflow-ssot 해당 구역 갱신.

---

## 2단계 — A-DEF-2: 다품목 워킹백워드 제품 스코핑 실패 → 조용한 전체-문서 폴백 (Medium-High)

### 증상 (실런 재현)
- WB 문서가 여러 SKU 를 함께 서술(이지덤 뷰티/릴리프/퀵카밍/리얼카밍 4종)하는데, 선언 제품(릴리프) 절만
  추출돼야 할 스코핑이 실패 → **경고 없이 문서 전체로 폴백** → 상류 오염:
  - `00-ingest/claim-basis.json` 에 타 SKU 근거(퀵카밍 무자극·리얼카밍 40% 피지) + product_type 의약외품 혼입.
  - `00-ingest/voc.json` product_facts 에 리얼카밍 EGF 혼입.
- 하류 방어(functional_status unknown·unsupported 격리 + 생성 카피의 단일출처 규율)가 최종 카피 유입은
  차단했으나 — **방어 1겹에 의존**하는 상태이고, 워킹백워드 원문 자체가 제품 간 근거를 오귀속(릴리프
  임상수치를 리얼카밍 절에 서술)한 실사례까지 있었다. 상류에서 잡아야 한다.

### 근본 원인 (코드 실측)
- `scripts/lib/ingest.py:171-173` — 제품 경계 인식이 라인 앵커 라벨 형식만 지원:
  `_WB_PRODUCT_MARKER_RE = "(?:제품명|제품유형)\s*[:：]"`.
- 실무 문서(docx→md 변환)는 `제품명:` 라벨이 아니라 **헤딩 + 표** 형식 → 미매칭 → 스코핑 자체가
  발동하지 않고 전체 문서가 단일 제품처럼 인입된다. 실패가 **조용해서** 사람이 알 수 없다.

### 수정 방안 (커밋 4개로 분리 — 가시화 먼저, 인식 확장은 보수적으로)

**커밋 ① 조용한 폴백 제거 — 다품목 감지·가시화** (철학 정렬: 모르면 묻는다)
- 감지 로직(스코핑 미발동 시에만): 변환된 WB 에서 선언 제품명 외 **다른 제품 후보 신호**를 보수적으로
  탐지 — 예: 헤딩/넘버링 절 제목에 선언 제품명과 불일치하는 제품형 명칭이 2개 이상.
- 감지되면:
  - `00-ingest/bundle-report.md` 와 run.md 에 평이 한국어 경고 표출(예: "첨부 기획 문서에 여러 제품이
    함께 적혀 있어요. 지금은 문서 전체를 참고로 읽었어요 — 다른 제품의 근거가 섞이지 않았는지 확인해
    주세요."). 문구는 `operator_labels.py` 사전 경유(내부 용어 금지).
  - `claim-basis.json` 의 관련 항목에 `product_scope: "unscoped"` 마킹(커밋 ③ 스키마 완화와 함께).
- intake 정문 런이면 00a 분류표 rationale 에 같은 경고를 반영(승인 게이트에 정보가 실리도록 —
  이번 실런에서 세션 에이전트가 수동으로 한 일을 하네스가 스스로 하게 만드는 것).
- **fail-closed 로 만들지는 않는다**: 단일 제품 WB·의도적 전체 반영도 정상 사용례다. 상류는
  가시화+마킹, 차단 판단은 사람과 하류 게이트의 몫.

**커밋 ② 경계 인식 확장 — 헤딩 절 스코핑(보수적)** (실무 문서 형식 수용)
- 착수 정찰: 실런의 변환 산출물
  `runs/relief-acne-e2e/00a-intake/converted/working-backwards.md` 에서 실제 헤딩 형태
  (`## 2. 이지덤 뷰티 릴리프` 류)를 확인해 패턴을 고정한다.
- 기존 마커(`제품명:/제품유형:`) 유지 + **마크다운 헤딩(#·##·###) 및 "N. <제품명>" 넘버링 절 제목**을
  제품 경계 후보로 추가. 절 제목이 **선언 제품명(state)과 정확 포함 매칭**될 때만 그 절을 스코핑한다
  (퍼지 매칭 금지 — 오추출이 미추출보다 위험하다).
- 매칭 절이 정확히 1개면 스코핑 성공(기존 마커 경로와 동일 취급), 0개·복수면 커밋 ① 의
  가시화 경로로(조용한 전체 폴백은 이제 없음).

**커밋 ③ claim-basis SKU 태깅 — 방어심층 2겹째** (스키마 완화)
- `harness/claim-basis.schema.json` 에 **선택(optional) 필드** 추가: 항목별
  `product_scope: "declared" | "other_sku" | "unscoped"` (+ 선택 `sku_label`). 동결 계약은 완화만
  허용 — 필수화·기존 필드 변경 금지, 구 산출물 후방호환 유지.
- ingest 가 스코핑 결과에 따라 태깅: 선언 제품 절 출처=`declared` · 타 제품 절 출처=`other_sku` ·
  전체 폴백=`unscoped`.
- 하류 소비(`build_context` — 트랙 B 5단계 이후면 `lib/build_context.py`): `other_sku` 항목은
  생성 컨텍스트의 근거 목록에서 **제외하거나 "참고(인용 금지)" 라벨로 격리**. 이렇게 하면
  A-DEF-2 류 오염이 상류에 남아도 생성 프롬프트에 실리지 않는다.
- ⚠ 골든 주의: 태깅은 신규 필드라 기존 골든의 JSON 바이트가 변할 수 있다 — 골든 픽스처 WB 는 전부
  단일 제품(마커 형식)이므로 `declared` 만 나오게 되고, **필드 자체를 스코핑 미발동 시 생략**하는
  방식으로 기존 골든 바이트 불변을 지킨다(생략=구버전과 동일 출력). 불변이 안 되면 멈추고 재설계.

**커밋 ④ 테스트·픽스처** (재발 방지)
- 신규 픽스처: 헤딩+표 형식 다품목 WB(선언 제품 절 포함) — ① 헤딩 스코핑 성공 단정
  ② 타 SKU 근거 미혼입 단정 ③ 스코핑 불가 변형본에서 경고·`unscoped` 마킹 단정.
- 기존 `test-b1`(claim-basis 추출 정확도)·`test-intake` 회귀 유지 확인.

### 검증·DoD (A-DEF-2)
- 타겟: `test-b1` · `test-intake` · `test-b2`(컨텍스트 소비 변경분) → 골든 4종 **불변** → 전체 CI → Codex 리뷰.
- 실증 재현: 이번 실런의 이지덤 WB(temp/ 원본, 읽기 전용)로 재인입 시 — 릴리프 절 스코핑 성공 또는
  최소한 경고+마킹이 뜨는지 확인(조용한 오염 소멸).
- DoD: 조용한 전체-WB 폴백 경로 소멸(가시화 100%) · 헤딩 형식 스코핑 그린 · `other_sku` 근거가
  생성 컨텍스트에서 격리됨 · 골든 불변 · workflow-ssot 갱신.

---

## 하지 않는 것
- cosmetic 조용 폴백 부활(2부 1단계 폐지 결정 유지) · 스코핑 퍼지 매칭(오추출 위험) ·
  claim-basis 스키마의 필수 필드 추가/기존 필드 변경(동결 계약 — 완화만) ·
  00-ingest 에 새 심의 게이트 신설(가시화·마킹으로 충분, 차단은 기존 게이트 몫) ·
  트랙 B 정리와의 혼합 커밋(브랜치 분리 엄수).

## 참고 (검증 런 증거 위치)
- A-DEF-1 재현: `relief-acne-e2e`(00a·00e 각 1회) · `ursa-lineup-e2e`(00a) — 워크어라운드 사용 기록은
  각 런 진행 로그. 근본원인 코드: `ingest.py:27-29,:47` · `gate.sh:89 부근`(apply-proposal 직접 호출) ·
  대조 정상 배관: `ingest-bundle.sh:38`.
- A-DEF-2 재현: `runs/relief-acne-e2e/00-ingest/claim-basis.json`(퀵카밍·리얼카밍 혼입) ·
  `voc.json`(EGF) · 원인 코드: `ingest.py:171-173`. 하류 방어가 막은 증거: 01-brief 카피에 타 SKU 0
  (4회 심의 지적에도 타 SKU 흔적 없음).
