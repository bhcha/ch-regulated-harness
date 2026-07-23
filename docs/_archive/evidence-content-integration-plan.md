# evidence 내용 반영 설계 — "첨부 = 최종 산출물 반영" 강제 (빌드 플랜)

> **지위**: 근거 문서(evidence) 채널을 "read-only 첨부 전송"에서 "**내용이 최종 산출물에 반드시 반영되는** 채널"로
> 승격하는 실행 설계 정본. 선행 설계 = [`evidence-attachment-plan.md`](./evidence-attachment-plan.md)(첨부 전송, 심의 미편입 —
> 그 설계는 유효하며 본 설계가 그 위에 '내용 반영' 층을 얹는다). 규칙 SSoT = [`AGENTS.md`](../../AGENTS.md).
> 구현 시 [`workflow-ssot.md`](../workflow-ssot.md) 동반 갱신 의무(AGENTS 4번 절).
> 작성 2026-07-04 · 근거: 실제 런 `ezderm-relief-acne-live`(이지덤 릴리프, cosmetic) 완주 실측 + 코드 정독(파일:줄 인용).
> **갱신 2026-07-04**: 열린 결정 4건 사람 확정(전부 권고안 채택, 차병환) · 상태 = **계획 확정 · 구현 대기(새 세션 착수)** — 착수 지침은 8번 절.
> **갱신 2026-07-04(b) — 범위 확장**: 좁은 설계(1~8번 절)는 evidence 를 **시험성적서**로 좁게 모델링했다. 사용자 요구로 evidence 를
> **범용 참조 문서**(시험성적서는 한 kind)로 일반화한다 — 복수 문서 · 사람이 반영점을 지정하거나 **문서만 주면 최적 BM 내용을
> 추출·제안(사람 승인)**. **1~8번 절 = `kind=test_report` 특수 케이스로 그대로 유효**(구현 완료: 커밋 a~e). 일반화 설계·결정·변경계획은 **9번 절**.

## 1. 배경 — 왜 반영이 안 됐나 (실측 확정된 3중 공백)

실제 런에서 사용자가 첨부한 `여드름피부사용적합 결과보고서.pdf`(인체적용시험)는 export 패키지에
**파일로는** 실렸으나(`kcia-package/evidence/`), 상세페이지 **본문에는 한 글자도 반영되지 않았다**(grep 0건 실측).

| # | 공백 | 실측 근거 |
|---|---|---|
| G1 | **내용 미추출** — 인입이 파일 바이트 메타(sha256·bytes·filename)만 기록, 내용 파싱 없음 | `ingest.py:672 cmd_evidence_docs`(:779-781 `grade:None·linked_claim_ids:[]` 기본), 주석 :619 "대조만 하고 실증으로 미편입" |
| G2 | **생성 미주입** — `build_context` 에 EVIDENCE 라벨이 아예 없어 생성 에이전트가 근거 내용을 볼 경로 자체가 없음 | `common.sh` grep "EVIDENCE" 0건 실측 |
| G3 | **반영 미강제** — 근거 문서가 있어도 반영 블록 0개인 채 done 도달 가능 | 이번 런이 그 상태로 done 완주(첨부 1건·본문 반영 0건) |
| (부수) | 유일한 내용 후보였던 clinicalEvidence 블록은 PDF 가 아니라 **WB 텍스트에서 생성**됐고, "무자극" 단정어로 심의 적발(consumer_deception high ×3 + substantiation_required high) 후 제거됨 | plan-verdict.json 실측 |
| (부수) | claim-basis `evidence_on_file` 은 WB 스캔 전용이라 **blank-claim 오염**(claim 빈 인체적용시험 마커 4건)이 생겼고, 이게 도리어 부적절한 clinicalEvidence 블록을 강제했다 | ev-01~04 claim="" 실측(비-릴리프/리얼카밍 유출) |

핵심: **첨부 채널(evidence-documents)과 실증 채널(claim-basis.evidence_on_file)이 끊겨 있고**(F5 "대조만"),
생성 표면(컨텍스트)과 완료 게이트 어디에도 근거 내용이 발을 딛지 못한다.

## 2. 목표와 불변 원칙

**목표**: 근거 문서를 첨부하면, 그 문서가 입증하는 내용이 심의-준수 형태로 **최종 산출물(상세페이지)에 반드시 반영**되고,
반영 없이는 done 에 도달하지 못한다(fail-closed). 반영을 원치 않는 문서만 **명시적으로** 첨부-전용(attach-only)으로 선언한다.

지키는 불변 원칙(기존 하네스 원칙과의 양립):
1. **사람이 선언한다** — PDF 내용의 진실은 AI 추측이 아니라 **선언 사이드카**(`evidence/index.json`, 이미 존재하는 메커니즘)가
   담는다. in-session 에이전트가 PDF 를 읽어 **초안**을 쓸 수는 있으나, 인입은 사람이 승인한 선언만 신뢰한다(환각 안전·AGENTS 1-5).
2. **결정론 게이트** — 반영 강제는 LLM 판단이 아니라 스크립트 게이트(`state.json`+scripts)가 한다(AGENTS 1-1·1-2).
3. **생성 ≠ 심의** — 심의(원격 ADK)는 불변. 선언 내용은 실증 데이터로 심의 게이트(5요소)를 **통과할 재료**를 줄 뿐,
   심의를 우회하지 않는다.
4. **판정문 원문주의** — 산출물 카피는 선언된 **판정문 원문**(예: "여드름 피부 사용 적합 판정")만 쓰고, 문서에 없는
   단정어(무자극·저자극 등)로 확장하지 않는다. ← 이번 런 "무자극" 적발의 직접 교훈.

## 3. 데이터 계약 — 선언 사이드카 확장 (시험성적서 kind)

> ⚠ 이 절은 **`kind=test_report`(시험성적서)** 선언이다. 범용 참조 문서용 필드(`kind`·`reflection_points`)와
> 일반화된 계약은 **9번 절**. (또한 실제 구현은 `evidence-documents.schema.json` 도 확장했다 — 사이드카는 런에 스냅샷되지
> 않아 매니페스트가 반영 선언의 유일한 런내 출처다. "유일한 스키마 변경" 표현은 부정확했다.)

`harness/evidence-index.schema.json` 의 문서별 선언 객체를 확장한다(additionalProperties:false 유지):

```jsonc
// evidence/index.json — 파일명 → 선언 (기존 필드 + 신설 필드)
{
  "ezderm-relief-acne-suitability-report.pdf": {
    "grade": "인체적용시험",                       // 기존
    "linked_claim_ids": [],                        // 기존(WB 스캔 evidence 와의 대조용 — 유지)
    "reflect": true,                               // 신설. 기본 true = 내용 반영 의무. false = 첨부-전용(명시 opt-out)
    "claim": "여드름 피부 사용 적합",              // 신설. 이 문서가 입증하는 내용(한 줄)
    "verdict_text": "여드름 피부 사용에 적합함",   // 신설. 문서의 공식 판정문 '원문'(카피가 쓸 수 있는 유일한 판정 표현)
    "test_report": {                               // 신설. 시험성적서 요소(심의 실증 5요소와 정렬)
      "institution": "P&K피부임상연구센타",         //  시험기관
      "sample_size": 22,                           //  참여자 수
      "duration": "1주",                           //  시험 기간
      "method": "첩포시험(패치테스트)",             //  시험 방법(선택)
      "measured_values": null                      //  전/후 측정값 쌍(정량 시험만; 사용적합 같은 정성 판정은 null)
    }
  }
}
```

- `reflect:true`(기본)인데 `claim`/`verdict_text`/`test_report`(기관·n·기간) 결손 → **인입 fail-closed**
  ("근거 문서 내용 선언이 불완전합니다 — 채우거나 reflect:false 로 첨부-전용을 명시하세요").
- `measured_values` 유무가 **정량/정성**을 가른다: 정량(측정값 쌍 있음) → clinicalEvidence 차트 경로,
  정성(null) → 인증-표시형(suitability) 경로. 이번 릴리프 케이스 = 정성.

## 4. 파이프라인 변경 — 6단계 (인입 → 컨텍스트 → 커버리지 → 생성 → 검증·심의 → 완료·export)

### 1단계. 인입: 선언 승격 (ingest.py — G1 처방)
- `cmd_evidence_docs` 가 확장 선언을 스키마 검증 후 `evidence-documents.json` 에 그대로 기록(현행 무결성 가드 전부 유지).
- **신설 승격 단계**: `reflect:true` 문서의 선언을 `claim-basis.json` `evidence_on_file` 에 **문서-유래 엔트리**로 추가:
  `{"id":"doc-01","claim":"여드름 피부 사용 적합","grade":"인체적용시험","source":"inputs/evidence/<파일명>", ...test_report}`.
  - id 는 `doc-NN`(문서 id 재사용) — WB-스캔 엔트리(`ev-NN`)와 **네임스페이스 분리**(blank-claim 오염과 섞이지 않음).
  - WB-스캔 쪽 blank-claim(claim 빈 마커)은 이 기회에 **승격 금지 + 인입 경고**로 가시화(별건 결함 — 메모리 four-issue의 ev-03 추출 결함).
- 순서: 현행 인입에서 claim-basis 가 evidence-docs 보다 먼저 생성되므로(ingest-bundle.sh:128 주석),
  승격은 evidence-docs 단계가 claim-basis 를 **재기록**(원자적)하는 방식. 골든: no-evidence 런은 no-op(바이트 불변).

### 2단계. 생성 컨텍스트: EVIDENCE_DOCS 라벨 주입 (common.sh build_context — G2 처방)
- `build_context` 에 신설 라벨: 근거 문서가 있으면
  `EVIDENCE_DOCS: doc-01 여드름 피부 사용 적합 | 판정문(원문): "…" | 시험기관/…/n=22/1주 | 정성(측정값 없음) | 반영 의무`
  를 brief·concept·storyboard(outline/plan)·keyvisual 컨텍스트에 방출.
- 프롬프트(SSoT) 보강: `prompts/storyboard-plan.md` 등에 "EVIDENCE_DOCS 가 있으면 해당 내용을 전담 블록으로 반영하되
  **판정문 원문 밖 표현 금지**·시험성적서 요소 병기" 지시 한 단락. (프롬프트 조립 골든이 이 변경을 커버 — 0단계 S6 안전망.)

### 3단계. 커버리지: 기존 메커니즘 그대로 (무수정)
- `check_canon_coverage.py:202,225` — `evidence_on_file` 비어있지 않으면 scienceEvidence(clinicalEvidence) 필수는 **이미 작동**.
  1단계 승격으로 이제 그 게이트가 "**실제 문서-유래 근거**"에 의해 당겨진다(blank-claim 오염이 아니라).

### 4단계. 생성 규율: 반영 블록의 형태 (프롬프트/캐논 규약)
- 정성 판정(measured_values null): **인증-표시형** clinicalEvidence — 판정문 원문 + 기관·n·기간 병기 + "개인차" 디스클레이머,
  측정 수치·효능 단정 없음, render_mode=html_only(한글 텍스트 변질 회피).
- 정량(측정값 쌍 있음): 기존 clinicalEvidence 차트 경로(측정 차트 엔진·5요소 게이트 기존대로).
- 각주 필수: 블록 각주가 `doc-NN`(evidence-documents id)을 인용 → export README 와 상호참조.

### 5단계. 검증·심의: 판정문 결박 (validate 신설 1건 + 기존 게이트)
- **신설(결정적)**: `validate_storyboard` 에 "evidence-반영 블록의 판정 표현은 선언 `verdict_text` 의 부분문자열이어야 한다"
  검사 — 문서에 없는 단정어(무자극 등) 확장을 심의 전에 fail-closed. (무자극 사건의 재발 방지 지점.)
- 기존 유지: 심의 5요소 게이트(`kcia_engine :398-496`)·`completeness_advisor`(이미지 preflight must_fill)·원격 ADK.
  선언 test_report 가 5요소 재료를 공급하므로, 이번 런처럼 "재료가 없어 블록을 지워야 하는" 상황이 구조적으로 사라진다.

### 6단계. 완료 게이트·export: 반영 강제 (advance-phase — G3 처방)
- **신설 done 게이트**: `reflect:true` 문서 ≥1 인데 최종 산출물(선택 옵션 HTML/plan)에 해당 `doc-NN` 각주-인용 블록이
  0개면 **advance 차단**("근거 문서가 첨부만 되고 반영되지 않았습니다 — 반영 블록을 추가하거나 reflect:false 를 명시하세요").
- export 반영 기록: `package.json` evidence_documents 에 `reflected_in: ["09-clinicalEvidence"]` 필드 + README 에
  "이 근거는 N번 블록에 반영됨" 한 줄(협회 자문 시 추적성).

## 5. 이번 런 교훈의 명시적 반영

| 교훈(실측) | 설계 반영 |
|---|---|
| "무자극" → consumer_deception 적발 | 판정문 원문주의(2번 원칙) + 5단계 verdict_text 결박 검사 |
| clinicalEvidence 블록 자체 → substantiation_required | 선언 test_report 가 5요소 재료 공급(4·5단계) — 블록이 근거를 갖고 태어남 |
| blank-claim evidence_on_file 오염(비-릴리프 유출) | doc-NN/ev-NN 네임스페이스 분리 + blank-claim 승격 금지·경고(1단계) |
| "릴리프만 화장품"(제품-라인 전이 금지) | 선언 claim 은 **문서가 입증하는 제품**에 대해 사람이 쓰는 것 — 라인 전이가 선언 단계에서 차단됨 |
| ADK flaky/비결정 | 본 설계와 직교(심의 불변). 반영 재료가 좋아져 유효-fail 확률만 감소 |

## 6. 구현 순서·커밋 분리·검증

1. **커밋 a(계약)**: evidence-index.schema.json 확장 + 문서(본 계획·workflow-ssot 동반).
2. **커밋 b(인입 승격 + fail-closed)**: ingest.py 1단계 + `tests/test-evidence-attachment.sh` 확장
   (신규 케이스: reflect 기본 fail-closed / attach-only 통과 / doc-NN 승격 / blank-claim 비승격 / no-evidence 골든 불변).
3. **커밋 c(컨텍스트+프롬프트)**: build_context 라벨 + prompts 보강 → **프롬프트 조립 골든 재캡처**(의도 변경 명시).
4. **커밋 d(검증·게이트)**: verdict_text 결박 검사 + done 게이트 + export reflected_in.
5. **온라인 카나리 1회**: 실 ADK 로 인증-표시형 블록 심의 통과 확인(정성 케이스).
6. 회귀: 스텁 골든(no-evidence 불변) + evidence 픽스처 런 골든 신설.

**pack-refactor 와의 순서**: 본 설계는 core 메커니즘 변경(ingest/common/validate/advance)이라
pack-refactor 1차(값 이동·바이트 불변)와 **동시 진행 금지**. 권장: pack-refactor 0단계 마무리(S1 value-replica·S8 재캡처) 후
별도 브랜치로 — 3단계(인입 팩화)와 파일이 겹치므로 먼저 들어가는 쪽이 기준선이 되고 나중 쪽이 리베이스.

## 7. 열린 결정 (2026-07-04 사람 확정 완료 — 전부 권고안 채택)

> **확정 상태(2026-07-04, 차병환): 4건 전부 권고안 채택.** 아래 "확정" 열이 구현 근거다.

| # | 결정 | 선택지 | 권고 | 확정 |
|---|---|---|---|---|
| 1 | 선언 초안 작성 주체 | (a) in-session 에이전트가 PDF 읽고 초안 → 사람 승인 / (b) 순수 수동 작성 | (a) — pdf 읽기는 에이전트, 진실 확정은 사람(승인 게이트 재사용) | **(a) 확정** |
| 2 | reflect 기본값 | (a) true(반영 의무, 미선언=fail-closed) / (b) false(첨부-전용, opt-in 반영) | (a) — 사용자 요구 "반드시 반영"의 직접 구현 | **(a) 확정** |
| 3 | done 게이트 강도 | (a) advance 차단(hard) / (b) 경고+감사로그(soft) | (a) — soft 는 이번 런 재발을 못 막음 | **(a) 확정** |
| 4 | 정성 판정의 커버리지 컴포넌트 | scienceEvidence 재사용 / 신설 suitability 컴포넌트 | 재사용(캐논 변경 없음) — 팩 분리 4단계와 충돌 회피 | **재사용 확정** |

## 8. 새 세션 착수 지침 (이 문서만 읽고 시작할 수 있게)

- **리포지토리/위치**: `/Users/chabh/workspace/ch-regulated-harness` · 운영 루트 `core/`. 이 문서와 커밋들은 현재
  **브랜치 `refactor/pack-stage0-tools`** 에 있다(main 미병합). 구현은 **이 브랜치에서 새 브랜치 분기**
  (예: `feat/evidence-content-integration`) — main 에서 분기하면 이 문서·0단계 도구가 없다.
- **선행 조건 주의**: pack-refactor 0단계 잔여(S1 value-replica·S8 재캡처, `_archive/pack-refactor-resume-2-stage1.md`)와
  **병행 금지 권장**(6번 절) — 단 본 설계는 evidence 채널만 건드리므로, pack-refactor 를 미루고 이것부터 해도
  파일 충돌은 없다(겹치는 파일: `ingest.py`·`common.sh`·`validate-stage` 계열 — pack-refactor 1차 1~3단계와 겹침.
  **어느 쪽이든 먼저 병합되는 쪽이 기준선, 나중 쪽이 리베이스**).
- **구현 순서 = 6번 절 커밋 a~d + 카나리** 그대로. 각 커밋마다 `workflow-ssot.md` 동반 갱신(AGENTS 4번 절).
- **먼저 읽을 파일**: `scripts/lib/ingest.py:672-890`(cmd_evidence_docs — 사이드카·무결성 가드),
  `harness/evidence-index.schema.json`(확장 대상), `scripts/lib/common.sh` build_context(라벨 주입 지점),
  `scripts/lib/check_canon_coverage.py:196-260`(evidence_gated 게이트), `scripts/lib/validate_storyboard.py`(판정문 결박 추가 지점),
  `scripts/advance-phase.sh`(done 게이트 추가 지점), `scripts/lib/export_package.py:52-100`(reflected_in 추가 지점),
  `tests/test-evidence-attachment.sh`(확장할 회귀 스위트).
- **검증 재료(이미 존재)**: 실제 근거 PDF = `/Users/chabh/Documents/temp/PNK-22627-A1R … 결과보고서.pdf`
  (릴리프 사용적합, 인체적용시험 — 선언 예시는 3번 절). 완주 실측 런 = `runs/ezderm-relief-acne-live`(git-ignored, 참고용).
  합성 번들 = `tests/fixtures/bundle-cosmetic/`(0단계 S1 — 오프라인 테스트 시드).
- **완료 판정(DoD)**: ① no-evidence 런 골든 바이트 불변 ② reflect:true 미선언 = 인입 fail-closed
  ③ 선언 런에서 done 도달 시 반영 블록 존재 + export `reflected_in` 기록 ④ verdict_text 밖 단정어 = validate 거부
  ⑤ test-evidence-attachment 확장 케이스 green ⑥ 실 ADK 카나리 1회(인증-표시형 블록 심의 통과).
  → 좁은(test_report) 구현 완료: 커밋 a(03b2658)·b(2b228c4)·c+d(e0b8ca9)·e(3b6ae1f). ⑥ 카나리는 9번 절 G7 로 통합.

## 9. 일반 참조 모델 (범용 근거 문서로 일반화)

> **지위**: 1~8번 절의 시험성적서 모델을 **범용 참조 문서**로 일반화. 좁은 구현(a~e)은 `kind=test_report` 특수 케이스로 그대로 유효 —
> 버리는 코드 없이 그 위에 얹는다. Fable ultrathink 설계 + 사용자 4건 확정(2026-07-04).

### 9-0. 무엇이 바뀌나
- **evidence = 범용 참조 문서**(시험성적서·논문·특허·성분자료·브랜드스토리·인증서·가이드 등 무엇이든), 그 내용이 BM 산출물에 반영돼야 한다.
- **복수 문서**(이미 `doc-NN` 복수 지원).
- **두 인입 모드**: (a) 사람이 파일 + **반영할 점을 지정**, (b) 사람이 **문서만 첨부** → 하네스가 **BM 에 가장 좋은 내용을 추출·제안**(사람 승인).

### 9-1. 확정 결정 (2026-07-04, 차병환)
| # | 결정 | 확정 |
|---|---|---|
| 진행 | 좁은 구현 처리 | **커밋 a~e 를 test_report 특수케이스로 완결 커밋 + 일반화 후속(G0~G7)** |
| 위치 | 추출·제안·승인 흐름 | **조건부 페이즈 `00e-evidence`**(00g-guideline 패턴 — in-session 에이전트 초안 → 사람 approve, state 감사·4동작 안) |
| 결박 | 일반 문서 반영 결박 | **승인 `reflection_points` 원문이 인용 블록 카피에 verbatim 포함**(test_report 는 카피⊆verdict_text 유지 — 방향 반대) |
| 편입 | claim-basis 승격 범위 | **`test_report` 만 편입**(효능 실증). 일반 문서는 각주 인용 채널로만 |

### 9-2. 안전 불변식 (코드로 확정 — 반드시 보존)
**일반 참조 문서는 `claim-basis.evidence_on_file` 에 편입하지 않는다.** 편입하면 ① `check_canon_coverage.py:202`(evidence_on_file
비어있지 않으면 clinicalEvidence 강제)가 브랜드스토리 PDF 로 임상 블록을 강제 발동(1번 절 blank-claim 오염 사고 재현), ②
`kcia_engine` `evidence_ids`(claim-basis 유래)에 들어가 **강주장(efficacy)이 그 문서를 실증 근거로 인용**할 수 있게 됨(브랜드스토리로
효능 실증 = AGENTS 1-6 후퇴). 편입 안 하면 `kcia_engine check_claim`("가짜 인용" high)이 `claims[].evidence_ref` 인용 자체를
막으므로 **일반 문서의 인용 채널 = 각주(footnotes) 전용**이 자동 강제된다(`check_evidence_reflection` 이 이미 각주 doc-토큰 인용을 인정).

### 9-3. 일반화 설계
- **선언 스키마 v2(additive)**: `kind`(enum: `test_report`|`certification`|`paper`|`patent`|`ingredient_dossier`|`brand_story`|`guide`|`general`) ·
  `reflection_points[]`(사람 지정/승인된 반영 원문 포인트) · `spec_origin`(`human`|`agent_proposed_human_approved`). 기존 `claim`·`verdict_text`·`test_report`
  는 유지(test_report 전용화). kind 추론: `test_report` 객체 있으면 test_report, 없으면 `general`.
- **인입 fail-closed 분기**(`ingest.py` 완전성 게이트): `kind=test_report` → 현행(claim/verdict_text/grade/기관·n·기간). `kind≠test_report` →
  `claim` + `reflection_points≥1` 필요; 스펙 없으면 `spec_status:"pending"` 으로 기록(승격·라벨·반영의무 보류)하고 advance 차단 → 00e 에서 해소.
- **승격**: `kind=test_report` 만 claim-basis `doc-NN` 승격(정량/정성 분기 그대로). 그 외 kind → 승격 금지(9-2).
- **컨텍스트 주입**: test_report → `EVIDENCE_DOCS` 라벨(판정문 원문 지시). 일반 문서 → `REFERENCE_DOCS` 라벨(반영 포인트 + doc-NN 각주 인용 지시).
  (라벨 분리 권고 — 프롬프트 의미 분명; 단일 라벨 서식분기도 가능.)
- **산출물 반영**: 캐논 변경 없음 — 내용 적합 블록 자유(성분자료→ingredientTech·브랜드스토리→brandBanner·수상/인증→socialProof 등).
  인용 = 각주(`footnotes[].text` 에 `doc-NN`). 지정은 프롬프트, 강제는 게이트.
- **결박 일반화**(`validate_storyboard`): test_report = 카피 ⊆ verdict_text(현행). 일반 = 승인 reflection_point 원문 ⊆ 인용 블록 카피(방향 반대·결정적).
- **done 게이트/ export**: `check_evidence_reflection` 로직 불변(각주-인용 프로브에 반영 포인트 텍스트 추가). `reflected_in` 그대로.
- **00e-evidence 페이즈**(제안·승인): 스펙 없는 reflect:true 문서 있을 때만 활성(00g 조건부와 동형). in-session 에이전트가
  `inputs/evidence/*` 읽고 `00e-evidence/reflection-proposal.json`(kind 추정 + 원문 발췌 반영 포인트 초안) 작성 → `validate-stage`(스키마+금지어) →
  사람 `approve.sh`(단안) → 결정 스크립트가 매니페스트 재기록. `review:false`(참조 입력·하류 심의). 3권분립: 추출=생성(에이전트)·확정=사람·강제=스크립트.

### 9-4. REFERENCE_NOTES 와의 관계 (2계층 참조)
크롤 사례 `REFERENCE_NOTES`(무엇이 왜 좋았나 자유텍스트 = **soft 영감**, 반영 의무 없음)와 첨부 참조 문서(**hard 반영 의무**, done 차단)는
성격이 달라 **합치지 않는다**. 참조에는 두 층 — 영감(REFERENCE_NOTES) vs 의무(첨부 문서).

### 9-5. 변경 계획 (커밋 단위 — 전부 오프라인 결정적, G7 만 온라인 카나리)

> **진행 상태(2026-07-04)**: **G0~G6 + G5 구현·커밋 완료 — 남은 것은 G7(온라인 카나리) 하나뿐.**
> G0=67fb237 · G1=ea92c43 · G2~G6=aad4f69 · **G5 = 브랜치 `feat/evidence-content-propose`(2026-07-04 완료)**. 좁은 test_report 경로 = 커밋 a~e.
> → 사람이 참조 문서(임의 kind)를 첨부하며 반영 포인트를 지정하거나(또는 시험성적서면), **문서만 첨부해도**(G5) 그 내용이 최종 산출물에 반드시 반영되고,
> 안 되면 done 이 막힌다(오프라인 E2E 완주 검증). **G5 완료 — 방식 B(조건부 `00e-evidence` 페이즈) 채택**: 스펙 없는 일반 참조 문서를
> `spec_status:pending` 으로 받아 세션 내 에이전트가 반영 포인트를 추출·제안(`00e-evidence/reflection-proposal.json`) → 사람 승인(단안) →
> 매니페스트 재기록(pending 해소·`spec_origin:agent_proposed_human_approved`)해야 하류로 나간다. **핵심 안전 결정 — 00e 는 `test_report` 를 거부한다**
> (일반 참조/각주 인용 채널 전용): 효능 실증(시험성적서)은 인입 직접 선언 전용이고 자동 제안 승격을 우회 금지한다(9-2 불변식).
> **G7(온라인 ADK 카나리)만 후속 이월**(2026-07-04, 차병환): 실 PDF 2종(시험성적서 + 일반 참조) done 완주·reflected_in·ADK 통과.
- **G0(문서·SSoT 우선)**: 본 9번 절 확정 기록 + `workflow-ssot.md` 동반(다음 코드 커밋 전 필수 — 정본이 코드와 어긋나지 않게).
- **G1(계약)**: 두 스키마에 `kind`·`reflection_points`·`spec_origin` additive.
- **G2(인입 일반화 + 승격 kind-게이트)**: `ingest.py` 완전성 게이트 kind 분기 + 승격 test_report 한정. 안전 회귀 3종(일반 doc claim-basis 부재·가짜인용 차단·골든 불변).
- **G3(컨텍스트+프롬프트)**: `common.sh` `REFERENCE_DOCS` 라벨 + 프롬프트 kind 분기 단락 + 프롬프트 조립 골든 재캡처.
- **G4(검증·게이트 일반화)**: `validate_storyboard` 일반 결박(포인트 ⊆ 블록 카피) + `check_evidence_reflection` 각주 프로브에 포인트 텍스트.
- **G5(00e 제안·승인 페이즈)** — ✅ **DONE**(브랜치 `feat/evidence-content-propose`, 2026-07-04; 방식 B = 조건부 `00e-evidence` 페이즈, 00g-guideline 패턴 복제). 배선:
  `state.schema`(phase enum) · `pipeline-routes`(+스키마) · `phase-descriptors`(+스키마; `guideline_leaf` $def 를 00g+00e 로 일반화) · `format-profiles` active_phases(양 포맷) ·
  `registry`(reflection-proposal.json) · 신규 `harness/reflection-proposal.schema.json` · `common.sh compute_next_conditional`(**단일 조건부 라우터**: pending→00e · 동일 도메인 사례→00g · else 01-brief;
  둘 다면 00e→00g→01-brief; `ingest-bundle.sh`·`advance-phase.sh` 공유) · `advance-phase.sh`(pending choke 가드[pending 있는데 00e 아닌 target 으로 전이=die] + `--to` allow-list
  `00e-evidence|00g-guideline|01-brief`[origin 은 00-ingest 만] + done pending backstop) · `ingest.py`(스펙 없는 일반 문서=`spec_status:pending`; `apply-proposal` 이 승인 후 매니페스트 재기록·
  `spec_origin:agent_proposed_human_approved`, 일반 문서는 claim-basis 미승격) · `check_evidence_reflection.py`(pending backstop = done 도달 불가) · 신규 프롬프트 `prompts/evidence.md` + 스킬
  `skills/evidence/SKILL.md`(슬래시 `/evidence`) · `validate-stage.sh` 00e 규칙(제안↔pending 문서 1:1[id+NFC 파일명]·문서별 claim+reflection_points≥1·kind∈{certification,paper,patent,ingredient_dossier,brand_story,guide,general}, `test_report` 거부; apply-proposal+validate 멱등).
  흐름 = run-stage evidence(생성) → approve(단안) → kcia-check(review-exempt-autopass: validate-stage 재검증→verdict) → gate review(매니페스트 재기록) → advance. **핵심 안전 — 00e 는 `test_report` 를 거부**(일반 참조/각주 인용 채널만; 시험성적서는 인입 직접 선언 전용 — 9-2). 오프라인 stub = `stub_stage.gen_evidence`. 근거 없는 런 골든 바이트 불변.
  회귀 = 신규 `tests/test-b1e.sh`(run-ci 등록) · 확장 `tests/test-evidence-reflection.sh`(문서만→done E2E) · `tests/test-evidence-attachment.sh`(pending 케이스). (원 계획의 `prompts/evidence-draft.md` → 실제 `prompts/evidence.md`.)
- **G6(stub+오프라인 E2E)**: 일반-doc 반영 stub(각주 인용) + `test-evidence-reflection.sh` 에 general 단독·test_report+general 혼합 2문서 시나리오.
- **G7(온라인 카나리 1회)**: 실 PDF 2종(PNK 성적서 + 일반 참조 1건) done 완주 — 둘 다 reflected_in·ADK 통과.
