# AG-UI·A2UI 투영 계획 — 실행·상태·중단·재개 계약의 표준화 (core 한정)

> 상태: **계획 확정 대기** · 작성 2026-07-17
> 작업 브랜치/워크트리: `feat/agui-a2ui-projection` @ `/Users/chabh/workspace/ch-regulated-harness-agui`
> 범위: `core/` 만 (당시 chat/ 는 영향권 밖이었고, 이후 Slack 챗 레이어 `chat/` 는 폐기·삭제됨)

## 1. 배경과 검증 결론

실행·상태·중단·재개 계약을 **AG-UI 표준**(이벤트 스트림 프로토콜)으로, 화면 선택지를
**A2UI 표준**(Google 선언적 UI 프로토콜, v0.9.1 안정/v1.0 RC)으로 표준화한다.
사전 검증 결론:

1. **AG-UI ↔ 현행 게이트 모델은 1:1 대응이다.** AG-UI 의 중단·재개는
   `RunFinished{outcome:{type:"interrupt", interrupts:[...]}}` 로 런이 끝나고 클라이언트가
   `resume` 배열을 담아 새 런을 시작하는 구조다. 현행 `gate=select/user`(사람 대기) →
   `select.sh/approve.sh/revise.sh`(재개)와 개념이 같다. 상태 동기화는
   `StateSnapshot`/`StateDelta`(RFC 6902 JSON Patch)로, `state.json` + `common.sh transition()`
   병합 구조가 그대로 투영된다. 전송 계층 비고정(transport-agnostic)이라 파일 기반으로 성립한다.
2. **A2UI 에는 공식 터미널/CLI 렌더러가 없다**(렌더러: Angular/Flutter/Lit/React).
   그러나 A2UI 는 실행 코드가 아니라 **선언적 JSON**(flat component list + catalog,
   의도적으로 LLM-friendly)이므로, **Claude Code 세션 에이전트가 A2UI JSON 을 읽어
   AskUserQuestion(터미널 선택 UI)으로 재렌더하는 어댑터 방식**으로 선택지 제공이 유지된다.
   현행 선택지 규모(3안 + "다시 만들기")는 AskUserQuestion 한도(질문당 옵션 4개 + Other 자동)에
   정확히 들어간다.
3. 근거 표면이 이미 준비돼 있다 — `scripts/next-action.sh` 가
   `options[]`/`recommended`/`revise_available`/`gate_type`/`stop_reason` 을 단일 JSON 으로
   방출 중이고, run.md(사람)·next-action(기계)이 같은 렌더 헬퍼에서 파생돼 드리프트가 없다.

## 2. 아키텍처 결정 — "대체"가 아니라 "투영(projection)"

AGENTS.md 절대 규칙 1(**state.json 은 오직 scripts 만 쓴다**)·결정론 골든·이식성 원칙 때문에
내부 계약(state.json + gate.sh)을 AG-UI 런타임으로 대체하지 않는다. 대신:

- **내부 SSoT 불변**: `state.json`(스키마 `harness/state.schema.json`) + `scripts/gate.sh` 전이 +
  `run.md`(사람 표면) + `next-action.sh`(기계 표면)는 그대로 둔다.
- **AG-UI/A2UI 는 외부 계약(제3의 표면)으로 얹는다**: 이벤트는 append-only
  `runs/<id>/.events/agui.jsonl`, 선택지는 읽기 전용 `a2ui-surface` 파생 출력.
- **쓰기 주체 불변**: 이벤트 파일도 기존 단일 쓰기 지점(스크립트)만 쓴다. 세션/LLM 은
  기존처럼 산출물·verdict·feedback 만 쓴다.
- 결과: 기존 CI·골든·chat 어댑터 전부 무변경 통과가 설계 목표(additive-only).

### 매핑표 (현행 개념 → 표준)

| 현행 (core) | AG-UI / A2UI |
|---|---|
| `state.json` 전체 | `StateSnapshot` |
| `common.sh transition()` 병합 | `StateDelta` (RFC 6902 patch) |
| run-stage 생성 시작/종료 · timing.jsonl 스텝 | `RunStarted` / `StepStarted`·`StepFinished` |
| `gate=select` / `gate=user` 도달 | `RunFinished{outcome: interrupt}` (interrupt 종류 = select/approve) |
| `select.sh`/`approve.sh`/`revise.sh` 입력 | 새 런의 `RunAgentInput.resume` |
| fail-closed 중단 · escalated | `RunError` / Custom 이벤트(`harness.escalated`) |
| `verdict.json` 심의 결과 | Custom 이벤트(`kcia.verdict`) |
| 선택 화면(options/recommended/파일/다시 만들기) | A2UI surface(`createSurface`/`updateComponents`/`updateDataModel`) + named action → 4동작 스크립트 |

## 3. 작업 단계

### 1단계 — 계약 동결 (스키마·카탈로그)
- `harness/agui-projection.schema.json` 신설: state.json 필드 → AG-UI 이벤트 매핑 규칙을
  닫힌 스키마로 동결. `history[]` 이벤트 문자열(`generate:insession:…`,
  `review:passed→advance` 등) ↔ 이벤트 타입 대응표 포함.
- `harness/a2ui-catalog.json` 신설: 하네스 전용 A2UI 컴포넌트 카탈로그(카드·텍스트·
  선택버튼·승인/보완 버튼·파일링크). 게이트별 surface 정의:
  - select(3안 카드 + 추천 배지 + 다시 만들기)
  - approve(승인/보완 2버튼)
  - keyvisual `needs_approve_after_select`(선택 → 승인 2단)
  - raise-limit/escalated(안내 + 한도 올리기)
- **A2UI 버전은 v0.9.1 로 핀**(v0.8→v0.9 에서 메시지명 변경 전례 — `surfaceUpdate`→
  `updateComponents`. 방출 모듈 한 곳에 격리해 v1.0 승격 시 그 파일만 수정).
- 검증: 스키마 meta-validate 테스트.

### 2단계 — AG-UI 이벤트 방출기 (실행·상태·중단·재개 계약)
- `scripts/lib/agui_events.py` 신설 + `runs/<id>/.events/agui.jsonl`(append-only).
  방출 지점은 기존 `obs_timing`/`transition` 호출 지점에 한 줄씩 나란히:
  - `run-stage.sh` → RunStarted/StepStarted·Finished
  - `gate.sh` → StateDelta · interrupt(RunFinished)
  - `advance-phase.sh` → phase 전이 StateDelta · done 시 RunFinished{success}
  - `kcia-check.sh` → Custom(`kcia.verdict`)
- 재생 명령 `scripts/agui-events.sh <id>` 신설: 읽기 전용, snapshot+delta 스트림을 표준
  출력(next-action.sh 와 같은 파생-전용 설계 → 드리프트 방지).
- `.events/` 는 `.logs/` 처럼 골든 제외(타임스탬프 비결정) — 결정적 필드만 뽑는 회귀로 커버.
- (선택) 방출 토글 env `HARNESS_AGUI=0|1`(기본 1) — 추가 시 AGENTS.md 2번 절 +
  config-reference 동반 갱신.

### 3단계 — A2UI 선택지 표면
- `scripts/a2ui-surface.sh <id>` 신설: `next-action.sh` 와 동일 헬퍼(`render_runmd` 의
  `next_command`/`_option_keys`/`_recommendation`, 라벨은 `operator_labels.py`)에서 A2UI
  메시지(JSON) 생성. run.md·next-action·A2UI 세 표면이 한 소스에서 파생.
- `scripts/a2ui-action.sh <id> <action.json>` 신설: A2UI named action 을 검증해 **기존
  4동작 스크립트로만 위임**(select/approve/revise 호출 — state.json 직접 쓰기 없음).

### 4단계 — Claude 세션 렌더러 (선택지 제공 유지의 실체)
- 운영자 스킬 갱신: 사람 게이트에서 `a2ui-surface.sh` 출력을 읽어 AskUserQuestion 으로
  제시(A/B/C + 다시 만들기), 응답을 `a2ui-action.sh` 로 위임.
- 화법 SSoT 는 기존대로 `prompts/operator-voice.md`(질문 4단 포맷) — A2UI 페이로드는
  **구조** SSoT.
- 키비주얼 HTML 미리보기는 터미널에 못 그리므로 현행대로 절대경로 파일링크 + `open`
  안내를 A2UI 파일링크 컴포넌트로 유지.
- run.md 렌더링 무변경(현업 표면 보존).

### 5단계 — 회귀 테스트
- `tests/test-agui-projection.sh`·`tests/test-a2ui-surface.sh` 신설
  (`HARNESS_OFFLINE=1` 결정적 실행): 게이트별 이벤트 시퀀스, interrupt→resume 왕복,
  멱등 재진입 시 이벤트 중복 없음, A2UI 액션→4동작 위임, next-action 하위호환.
- 기존 골든·`test-operator-language.sh` 무변경 통과 확인.

### 6단계 — D-1 정본 동반 갱신
- `docs/canonical/workflow-ssot.md`(흐름) · `feature-catalog.md`(신규 스크립트·스킬) ·
  `config-reference.md` + AGENTS.md 2번 절(신규 env) · `docs/README.md`(`.events/` 신설).

## 4. 7단계 — 신·구 구조 이중 완주 비교 검증 (E2E)

구현 완료 후, **같은 입력으로 현재 구조(A런)와 변경 구조(B런)를 각각 끝까지(done)
완주**시키고 과정·결과물을 비교해 "이상 없이 변경"을 판정한다.

### 4-1. 입력 자산 (실측 완료 — `/Users/chabh/Documents/temp/`)

| 파일 | 분류(예상 intake 라우팅) |
|---|---|
| `이지덤 뷰티 여드름 워킹백워드.docx` | working_backwards (**docx→md 변환은 /intake 세션 에이전트 담당** — ingest.py 확인됨) |
| `제품이미지.webp` | product_image (자사 자산) |
| `coupang_6484363424_….zip` 이지덤 밴드 뷰티 릴리프 스팟패치 | **own crawl(자사)** |
| `oliveyoung_A000000140818_….zip` 이지덤 릴리프 스팟패치 | **own crawl(자사)** — 동일 상품 폴더 2개(0627/0705)는 최신 zip 만 사용 |
| `coupang_8936617595_….zip` 아누아 PDRN 히알루론산 캡슐 100 세럼 | reference crawl ✅ (요청한 아누아 PDRN **포함 확인**) |
| `coupang_8137835304_….zip` 이니스프리 그린티 씨드 세럼 | reference crawl (**비패치류** 플로우 참고) |
| `coupang_6528456202/9182621621/9525442925/9542212705` (케어플러스·해서린·아크네스·패치파이) | reference crawl (패치류 4건) |
| `PNK-22627-A1R … 여드름피부사용적합 결과보고서.pdf` | evidence — **⚠ 시험성적서(test_report)는 사람이 intake 에서 intent 선언해야 함**(W-3: bare 첨부 자동승격 금지). 선언 시 00e 에서 스펙 초안(기관·n·기간·판정문) → 승인 → 확정 |

- **메디힐 마데카소사이드 흔적 리페어 세럼은 크롤에 없음**(전 zip product.json 실측).
  대응: (권장) 00g 참조 노트(`reference-notes.json` 자유텍스트)에 "메디힐 마데카소사이드
  세럼의 전체 상세페이지 플로우 참고" 취지를 기입 — soft 권고로 컨셉·스토리라인·아웃라인
  생성에 주입된다. 크롤 zip 을 추가 확보하면 reference crawl 로 승격.
- "비패치류 포함 전체 플로우 참고"는 아누아 PDRN 세럼 + 이니스프리 세럼 크롤로 충족.

### 4-2. 시나리오 선언 (사람 선언 사항)
- 규제도메인: `cosmetic` · 산출물 포맷: **여러 장 상세페이지**(`multipage_bm`, 현행 예시 런과 동일)
- 제품: 이지덤 뷰티 릴리프 (여드름피부 대상 스팟패치 — 화장품)
- 진입: **00a-intake 정문** — `bash scripts/intake.sh /Users/chabh/Documents/temp <run_id> --product … --domain cosmetic --format multipage_bm`
- ⚠ 심의 리스크 선지식: 화장품 도메인에서 "여드름" 기능성 표방 불가(ADK 적발 이력) —
  "여드름피부사용적합" 시험 문구는 판정문 원문주의로만 반영. 두 런 공통 조건이므로
  비교 자체에는 영향 없음.

### 4-3. 실행 절차
1. **A런(현재 구조)**: main 기준 워킹트리 `/Users/chabh/workspace/ch-regulated-harness`(core 는 main 과 동일)에서
   `run_id=ezderm-acne-agui-a` 로 intake → done 완주.
2. **B런(변경 구조)**: 본 워크트리 `/Users/chabh/workspace/ch-regulated-harness-agui`(구현 완료 후)에서
   `run_id=ezderm-acne-agui-b` 로 동일 입력·동일 선언 완주.
3. run_id 분리 = 런 격리(워크트리별 `core/runs/` 라 물리적으로도 분리). 환경(.env — ADK
   cosmetic 크리틱 URL·NANOBANANA 키)은 두 런 동일하게.
4. 사람 게이트 입력 통일 규칙: **모든 select 는 추천안(top-1) 선택, 모든 approve 는 즉시
   승인, revise 없이 1-pass 완주 시도**. B런에서는 선택·승인을 A2UI surface →
   AskUserQuestion → `a2ui-action.sh` 경로로 수행(4단계 렌더러의 실전 검증).
5. 비용 유의: bake-all 이미지 10~14장 × 2런 — Pro 쿼터 429 시 P-1 백오프·강등 다이얼 동작
   확인(두 런 모두 동일 조건).

### 4-4. 비교·판정 기준

실 LLM 생성이라 **바이트 동일성 비교가 아니라 계약·과정 동일성 검증**이다(산출물 내용은
비결정). 비교는 읽기 전용 스크립트로 재현 가능하게 만든다(`tests/compare-dual-run.sh`
신설 또는 scratch 스크립트 — state 미기록).

**(가) 과정 동일성**
- `state.json`: 최종 `phase=done`·`status=approved`, `history[]` 이벤트 **종류·순서** 동일
  (타임스탬프·revise 반복 횟수는 제외 — 반복은 심의 비결정으로 다를 수 있음 →
  "게이트 종류 시퀀스" 수준으로 비교).
- `.logs/timing.jsonl`: 스텝 세트·`outcome=ok` 동일(소요 시간 제외).
- `verdict.json`(단계별): `verdict=pass`·`engine`·`review_depth`·`critic_ran` 동등.

**(나) 결과물 동등성**
- 파일 트리 목록 diff: **B런 − A런 = `.events/` 뿐**이어야 한다(그 외 추가/누락 = 실패).
- 전 단계 `validate-stage` 통과, `image-manifest.json` 완결(`incomplete` 부재),
  스토리보드 블록 수·키비주얼 옵션 수 동등, voc.json 수치 단일출처 준수.

**(다) 표면 하위호환**
- `run.md`: 게이트별 스냅샷의 구조(섹션·"다음 명령" 형식) 동일 — B런에서 run.md 는 무변경
  원칙이므로 렌더 형식 diff 가 없어야 한다.
- `next-action.sh` JSON: A런 필드셋 ⊆ B런 필드셋(기존 필드 제거·의미 변경 없음 = chat
  어댑터 호환 보증).

**(라) 신규 계약 정합 (B런만)**
- `.events/agui.jsonl` 시퀀스 ↔ `state.json history[]` 1:1 교차 대조(빠짐·중복 없음).
- 사람 게이트마다 `RunFinished{interrupt}` ↔ resume(4동작) 짝 성립.
- 멱등 재진입 1회 고의 수행(같은 단계 run-stage 재실행) → 이벤트 중복 방출 없음.
- A2UI surface 의 옵션·추천·다시만들기 ↔ `next-action.sh` 의
  `options[]`/`recommended`/`revise_available` 일치.
- **선택지 제공 검증(핵심 질문)**: B런의 AskUserQuestion 에 제시된 선택지 세트가 A2UI
  payload 항목과 일치하고, A런에서 run.md 가 제시한 선택지 세트와 동일한지 확인.

**판정**: (가)~(라) 전 항목 통과 = "이상 없이 변경". 실패 항목은 개별 원인 분석 후 수정 →
해당 축만 재검증.

## 5. 워크트리 운영
- 구현(1~6단계)·검증(7단계 B런)은 전부 본 워크트리(`feat/agui-a2ui-projection`)에서.
- main(및 main 동일 core 의 기존 워킹트리)은 **현재 구조 보존 = A런 기준선**으로만 사용.
- 병합은 7단계 판정 통과 후.

## 6. 보류 항목
- **AG-UI 실시간 전송 서버(SSE/HTTP)**: 외부 웹 클라이언트 등장 시점까지 보류.
  이번 범위는 파일 기반 투영(jsonl + replay 명령)까지. 전송 계층 비고정이라 추후
  서버는 `agui-events.sh` 재생 출력을 SSE 로 흘리는 어댑터 추가만으로 성립.
- A2UI v1.0 정식 릴리스 시 버전 승격(방출 모듈 1곳 수정).

## 7. 리스크
| 리스크 | 대응 |
|---|---|
| A2UI 스펙 이동(v0.9→v1.0 메시지명 변경 가능) | 버전 핀 + 방출 모듈 격리(1단계) |
| 이벤트 방출이 골든/CI 를 흔듦 | `.events/` 골든 제외 + additive-only + 5단계 회귀 |
| AskUserQuestion 옵션 4개 한도 | 현행 3안+revise 로 충족; 옵션 증가 시 분할 제시 규칙을 카탈로그에 정의 |
| 화장품 여드름 표방 심의 적발 | 판정문 원문주의·기능성 표방 회피(두 런 공통 — 비교 무영향) |
| 이미지 쿼터(429) 이중 소진 | P-1 백오프·강등 다이얼 확인, 런 간 시간 분리 |
