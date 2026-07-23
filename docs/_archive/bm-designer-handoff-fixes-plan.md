# BM 디자이너 핸드오프 — E2E 발견 결함 수정계획 (P-1 ~ P-5)

> 작성 2026-07-05. 전제 전환(G-A 전 블록 이미지 + G-B 참고문서 이미지 추출, `docs/bm-designer-handoff-plan.md`) 구현 직후
> **실런 2건**(릴리프 `ezderm-relief-cosmetic-v3` 화장품 · 우루사 `ursa-drug-v2` 의약품, 둘 다 done 완주)이 드러낸 결함의 수정 설계 SSoT.
> 기능 자체는 검증 완료 — G-B(차트+추출 전후사진 페어 TEST 섹션) 완전 성공, G-A(그래픽 블록 이미지)는 우루사 14/14 성공·릴리프는 P-1 로 부분 폴백.
> 구현은 dev-loop(웨이브·스테이지별 Codex 리뷰·critical/high 0 수렴). **AGENTS.md 4번 절 의무: 각 커밋에서 `docs/workflow-ssot.md` 동반 갱신.**

## 우선순위 요약

| # | 심각도 | 제목 | 한 줄 |
|---|---|---|---|
| P-1 | **HIGH(버그)** | 이미지 부분실패 시 매니페스트 전량 유실 → 그래픽 블록 전면 폴백 | 429 한 방에 G-A 가 무력화(all-or-nothing) |
| P-2 | MEDIUM | 선언 change_pct(정수) vs 도출값(소수1) 정확일치 충돌 | 사람 선언이 반올림 차이로 차트 도출 null |
| P-3 | MEDIUM(구조) | zero_voc 억제 vs 판정문 반영 게이트 충돌 | 신제품(리뷰0) 화장품에서 판정문 원문을 못 씀 |
| P-4 | MEDIUM(품질) | 그래픽 블록 브랜드 환각("GREEN ESSENCE") | 픽셀 레퍼런스 없는 그래픽이 가짜 브랜드 발명 |
| P-5 | LOW(운영) | Pro 기본모델 × bake-all(10~14장) = 429 빈발 | P-1 백오프·강등 다이얼로 흡수 |
| P-6 | MEDIUM(기능) | 시험성적서 상세의 '사람 승인' 게이트 부재 | ⚠ **`docs/attachment-intake-plan.md` 로 흡수**(사용자 재방향 2026-07-05: 시험성적서만이 아니라 '첨부 통합 인입·보편 분류·승인·라우팅'의 하위 관문 W-3). 아래 P-6 절은 그 W-3 의 상세 설계로 유효 |

---

## P-1. 이미지 부분실패 내성 (HIGH — 버그)

**증상(실측·릴리프 v3)**: Nano Banana 429(RESOURCE_EXHAUSTED)가 13번째 블록에서 발생 → `image_engine.generate_all` 크래시 →
**`image-manifest.json` 이 아예 안 써짐**(9장은 디스크에 실재하는데 등재 0) → `check_render_refs` 의 그래픽(html_only) 예외가
매니페스트-SSoT 라 전면 차단 → 그래픽 5블록이 전부 인라인 SVG 폴백. G-A 가 "생성 전부 성공"일 때만 완성되는 all-or-nothing.

**RCA(코드 확정)**:
- `image_engine.py:575~588` — 매니페스트는 **루프 종료 후 한 번만** 원자 기록. 중간 예외 = 유실.
- `image_engine.py:358` 주석 "429 는 상위 gen-images 백오프가 처리" 는 **거짓** — `run-stage.sh:344` 는 image_engine 을 직접 호출하고
  (gen-images.sh 는 락 데드락으로 우회), 어디에도 429 백오프가 없다. `_call_nanobanana` 의 재시도는 RECITATION/빈응답 전용, 429 는 즉시 raise.
- `image-manifest.json` **존재 자체**가 '이미지 생성 완료' 마커로 소비된다(preflight 면제 `AGENTS.md 2번 절`·멱등 재진입) → 부분 매니페스트를 무조건 쓰면 '완료' 오인.

**수정 설계**:
1. **429 지수 백오프**(`_call_nanobanana` 또는 generate_all 루프): 429 수신 시 `HARNESS_NANOBANANA_BACKOFF`(기본 예: 15s→30s→60s, 총 `HARNESS_NANOBANANA_RETRY_429` 기본 3회) 대기 후 재시도. 거짓 주석(358행) 삭제·정정.
2. **모델 자동 강등 다이얼**: 429 백오프 소진 시 `HARNESS_NANOBANANA_FALLBACK_MODEL`(기본 `gemini-2.5-flash-image`)로 그 블록부터 강등 재시도 — 우루사 런에서 사람이 수동으로 한 것을 자동화. 강등 발생 시 stdout 감사 한 줄 + 매니페스트 top-level `model` 은 '이번 호출 설정 모델' 의미 유지(강등 사용 여부는 자산별 기록이 스키마상 불가하면 stdout 로그로만 — 동결 스키마 존중). 강등 자체를 끄려면 env 를 빈 값으로.
3. **증분 매니페스트 + `incomplete` 마커**: generate_all 이 **각 자산 성공 직후** `{"engine":…, "incomplete": true, "assets":[…지금까지]}` 를 원자 기록하고, 전 블록 완료 시 `incomplete` 를 **제거한 최종본**을 기록. 소비자 조정:
   - `run-stage.sh` preflight 면제·멱등 '완료' 판정 = **매니페스트 존재 && `incomplete` 부재**로 강화(부분 매니페스트는 재생성 트리거).
   - `check_render_refs` 는 무수정 — 부분 매니페스트라도 **등재된 자산은 실재·유효 PNG**이므로 그래픽 `<img>` 예외가 정당(이게 이 수정의 핵심 이득: 9/13 성공이면 9개는 이미지로 실린다).
   - `image-asset.schema`(매니페스트 스키마)에 optional `incomplete` additive 확인(동결 원칙: 완화만). stub 경로는 전 블록 성공이라 최종본만 기록 → **골든 바이트 불변**.
4. 실패 종료는 유지(fail-closed): 백오프·강등까지 소진해 못 만든 블록이 남으면 비-0 종료 + 남은 블록 명시. 단 이제 매니페스트가 있으니 재실행(멱등)·부분 렌더가 가능.

**파일**: `scripts/lib/image_engine.py`(백오프·강등·증분 기록) · `scripts/run-stage.sh`(완료 판정 강화) · `harness/image-asset.schema.json`(optional `incomplete`) · `scripts/lib/common.sh`(예측/포트 무영향 확인).
**검증**: 신규/확장 `tests/test-image-engine.sh` — (a) mock 실패 주입 시 증분 매니페스트에 성공분 등재+`incomplete:true` (b) 완주 시 `incomplete` 부재·기존 바이트 불변 (c) run-stage 완료판정이 incomplete 매니페스트를 재생성 대상으로 취급 (d) check_render_refs 가 부분 매니페스트 등재 자산 `<img>` 허용. stub 골든 전체 불변.

## P-2. 선언 change_pct 정규화 (MEDIUM)

**증상(실측)**: 시험성적서 선언 `change_pct:-41`(보고서 표기 정수) vs series 도출 `-40.9`(ROUND_PREC=1) →
`clinical_chart.derive_chart` 교차검증(60~61행 정확일치)이 null → 차트 도출 실패. 서브에이전트가 사이드카를 소수1자리로 손보정.

**RCA**: 도출·검증 SSoT(`clinical_chart.ROUND_PREC=1`)는 옳다(하류 불변). 문제는 **인입이 사람 선언을 정규화 없이 통과**시켜
모순된 레코드를 만드는 것 — 보고서는 관행상 정수(−41%)로 표기하므로 흔한 충돌.

**수정 설계(인입 정규화 — 하류 무수정)**: `ingest.py` test_items 승격 시 series(또는 before/after)가 있으면 change 를 동일 규칙
(`clinical_chart` 재사용, 소수1자리)으로 **계산**하고:
- 선언 change_pct 가 **계산값의 정수 반올림과 일치**(|선언 − round(계산,0)| < 0.5)하면 → **계산값(소수1)로 정규화 기록** + stdout 한 줄
  ("선언 -41 → 도출 -40.9 로 정규화(보고서 정수 표기 허용)").
- 그 밖(진짜 모순, 예: 선언 -41 vs 계산 -33)이면 → **fail-closed**(정확한 계산값을 에러 메시지에 제시 — 사람이 선언을 고친다).
- 선언 change_pct 없고 series 만 있으면 계산값 자동 기입(선택 편의).
**파일**: `scripts/lib/ingest.py`(+`clinical_chart` import 재사용). **검증**: `tests/test-clinical-chart.sh` 또는 evidence 테스트에
케이스 3개(정수표기 정규화·진짜 모순 fail-closed·미선언 자동기입) 추가. 기존 measured_values 경로 바이트 불변.

## P-3. 판정문 반영 vs zero_voc 충돌 (MEDIUM — 구조, **열린 결정 1**)

**증상(실측·릴리프)**: 리뷰 0건 신제품 → `kcia_engine`(303~353행) zero_voc 가 voc count==0 효능어("여드름" 등)를 컨셉 주축 금지로 억제.
그런데 반영 게이트(`check_evidence_reflection`)는 선언 판정문 원문("**여드름성** 피부 사용에 적합하며…")의 카피 생존을 요구 →
충돌. 서브에이전트가 판정문의 적법 부분문자열("피부 진정에 도움을 주는 제품으로 판단됨")로 우회(합법이나 판정문 반쪽).

**참고**: 실BM 정본(012쪽)도 "여드름성 피부 사용 적합" 인증 배지를 표기 — 현실에서 판정문 원문 표기는 정상 관행.

**수정 설계(권고 = a안)**:
- **a안(권고, 좁은 면제)**: zero_voc 판정(kcia_engine ⑤)에서 **`evidence_ref=doc-NN`(test_report·verdict_text 보유)로 결박된 claim 의
  target_text 가 판정문 원문의 부분문자열인 경우** 그 claim 범위에 한해 zero_voc 억제를 면제한다 — 판정문은 '소비자 수요 개념'이
  아니라 **시험 결과의 공식 표기**이므로 zero_voc 의 취지(수요 근거 없는 개념 주축 금지) 밖이다. 컨셉 '주축'(concept-axes·헤드라인)
  은 여전히 억제(면제는 판정 카피 1점에만). 원격 ADK 는 독립 심의 주체라 별도 지적 가능 — 그것은 심의의 몫(격리 불변).
- b안(팩 레버): `ruleset.json` `zero_voc_exclude` lexicon 에 판정문 어휘 추가 — 제품별 판정문마다 팩 수정이라 부적절(기각 사유 기록).
- c안(광역): 리뷰 0 런은 zero_voc 를 advisory 강등 — 과도(기각).
**파일**: `scripts/lib/kcia_engine.py`(⑤ 분기) · `prompts/storyboard-plan.md`(판정문 카피 결박 지침 한 줄). **검증**: `tests/test-gates.sh`
또는 clinical-engine 테스트에 (a) 결박 판정카피 면제 (b) 동일 어휘의 비결박 카피는 여전히 억제 (c) 헤드라인 주축은 억제 유지.

## P-4. 그래픽 블록 브랜드 환각 (MEDIUM — 품질)

**증상(실측·우루사)**: 픽셀 레퍼런스 없이 생성된 그래픽 블록(rtbSummary)에 가짜 브랜드 "GREEN ESSENCE" 로고가 구워짐.
디자이너 시안이라 치명은 아니나 시안 신뢰도를 깎는다.

**수정 설계**:
1. `image_engine.build_prompt` graphic 분기에 **실제 제품/브랜드명 텍스트 주입** — concept 에서 브랜드를 알 수 없으므로
   호출부(generate_all)가 run 의 제품명(state.product.name 은 스크립트 소유 — 대신 `voc.json`/`product.json` 스냅샷에서 읽거나
   generate_all 인자로 전달)을 넘겨 "브랜드 표기가 필요하면 '<브랜드명>'만 사용하라(다른 브랜드/로고 발명 금지·no fictional brand)"
   문구를 추가한다(한글 깨짐 허용 전제라 인-이미지 브랜드명 OK).
2. `prompts/storyboard-plan.md` 그래픽 블록 지침에 **`reference.pixel_reference_allowed=true` + own_asset_path(마스터 제품컷) 유지**를
   명시(이미 스키마 필수 — 그래픽 블록도 자사 제품컷을 픽셀 레퍼런스로 보내 브랜드 락) + build_prompt graphic 분기가 has_ref 일 때
   '참조 제품 브랜드 외 타 브랜드 발명 금지'를 이미 보존 지시와 함께 강화.
**파일**: `scripts/lib/image_engine.py` · `prompts/storyboard-plan.md`(+prompt-assembly sha256 재캡처). **검증**: build_prompt 단위
단언(graphic+브랜드명 문구 포함) + 실런 눈검증(후속 카나리).

## P-5. Pro 기본모델 × bake-all 쿼터 (LOW — 운영, P-1 에 흡수)

**증상**: 전제 전환으로 생성 장수가 6장 → 10~14장으로 늘어 `.env` 기본 `gemini-3-pro-image` 쿼터(429)를 양 런 모두에서 소진.
**처방**: P-1 의 백오프+자동 강등이 기술적 해소. 운영 문서(`AGENTS.md` 2번 절 이미지 절·workflow-ssot)에 "bake-all 이후 Pro 는
쿼터 여유가 필요 — 강등 다이얼 기본 flash" 한 줄 기재. 별도 코드 없음(P-1 완료 시 종결).

## P-6. 시험성적서 스펙 자동 제안 + 사람 승인 (MEDIUM — 기능, 00e 확장)

> ⚠ **재프레임(2026-07-05)**: 이 절은 상위 계획 **`docs/attachment-intake-plan.md`(첨부 통합 인입 — 받고→보편 분류 제안→사람
> 승인→채널 라우팅)의 W-3 하위 관문**으로 흡수됐다. 착수는 그 문서의 웨이브를 따르고, 아래는 W-3 의 상세 설계로 유효하다.

**동기(실런 관찰·사용자 확인)**: 현재 test_report 는 상세(기관·n·기간·test_items 수치·페이지)까지 **사람이 통째로 사이드카에
타이핑**해야 한다. 릴리프 v3 데모에선 운영자(에이전트)가 사용자 제공 수치로 사이드카를 작성했고 **형식적 승인 게이트가 없었다** —
일반 문서에는 이미 있는 관문(00e: 제안→사람 approve)이 시험성적서엔 없다. 지루한 추출은 에이전트가, 확정은 사람이 하도록 확장한다.

**단계 = 기존 `00e-evidence` 조건부 페이즈 재사용**(새 페이즈 없음 — G5 관문의 두 번째 고객):
```
트리거: 사이드카에 {"kind":"test_report","reflect":true} 만 선언(상세 생략)
  → 인입이 현재의 fail-closed 대신 spec_status:pending 기록 → 00e 라우팅   (완전 선언은 기존대로 인입 즉시 추출·승격 — 무변경)
제안: 00e 세션 에이전트가 PDF 를 읽어 기관·n·기간·판정문 원문·test_items(metric·series·change_pct·stat_note)·
  전후사진 페이지 후보를 reflection-proposal 에 초안(보고서에서 읽을 수 있는 값만 — 원문주의·지어내기 금지)
승인: run.md 에 초안을 평이한 표(지표/수치/페이지/판정문)로 노출 → 기존 approve.sh(단안) = '사람 선언' 확정 게이트
발효: gate.sh → ingest.py apply-proposal 이 매니페스트에 test_report 확정 기록(pending 해소) 후
  **인입과 같은 함수 재사용**으로 이미지 추출(_extract_test_images)+claim-basis 승격(doc-NN+doc-NN-tKK+image_path) 실행
  → 01-brief 부터 하류 동일 소비. P-2 정규화·5요소 게이트·정확일치 결박이 결정적 백스톱.
```

**지키는 안전선(불변식 재정의 — 완화가 아니라 정밀화)**: 에이전트 제안은 **사람이 이미 `kind:test_report` 로 선언한 문서의
상세만** 채울 수 있다. bare 첨부(일반 문서)를 제안이 test_report 로 승격하는 것은 **계속 금지** — `validate-stage` 00e 규칙이
"제안 kind=test_report ⇒ 매니페스트의 그 문서에 사람 선언 intent(kind=test_report) 존재"를 fail-closed 검사. bare 첨부에는
기존 `evidence_clinical_signal` 권고가 intent 선언을 유도. 즉 **규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람 승인**.
00e 심의 면제(review:false)는 유지 정당 — 제안은 광고 카피가 아니고, 실제 카피·차트는 하류(브리프~키비주얼)에서 실 ADK 심의 + 결정적 결박 게이트를 다 거친다.

**계약 변경(additive)**: `reflection-proposal.schema.json`(optional `test_report` 블록: institution/sample_size/duration/
verdict_text/test_items[] — evidence-index 와 동일 형상) · `evidence-index.schema` 무변경(intent-only 선언은 이미 유효) ·
`ingest.py`(불완전 test_report: SystemExit → pending; apply-proposal: test_report 거부 → intent-match 시 수용+추출·승격 재사용) ·
`validate-stage`(00e 규칙 intent-match) · `prompts/evidence.md`+`skills/evidence/SKILL.md`(test_report 초안 지시) ·
`render_runmd`(제안 표 노출). 기존 G5 일반-문서 경로·no-evidence 골든 바이트 불변.

**검증**: `tests/test-b1e.sh` 확장 — (a) intent-only test_report → pending → 00e 제안(stub) → 승인 → 추출·승격·pending 해소
(b) bare 일반 문서 제안이 test_report 로 승격 시도 → fail-closed (c) 완전 선언은 00e 미경유(기존 경로 불변)
(d) 승인 전 하류 진출 차단(pending choke 기존 가드). + 헤르메틱 PDF 로 apply 시 추출 실패 fail-closed.

---

## 웨이브 (파일 소유 디스조인트)

- **Wave 1(병렬)**: P-1(image_engine·run-stage·image-asset.schema) ∥ P-2(ingest.py) ∥ P-3(kcia_engine.py)
- **Wave 2(병렬)**: P-4(image_engine build_prompt — P-1 과 같은 파일이라 **P-1 뒤 순차** · storyboard-plan.md 프롬프트+골든 재캡처) ∥ **P-6**(ingest.py — **P-2 뒤 순차**(같은 파일) · reflection-proposal.schema·validate-stage·prompts/evidence.md·skills/evidence·render_runmd) ∥ 테스트 확장(P-1/2/3 케이스)
- **Wave 3**: P-6 테스트(test-b1e 확장·헤르메틱 PDF) + workflow-ssot·AGENTS.md 동반 갱신 + 전체 회귀(touched + 넓은 골든) + Codex 수렴 → 커밋
- **Wave 4(검증 카나리)**: 릴리프 재런 1회 — **intent-only 선언(kind:test_report 만)으로 시작**해 00e 제안→승인→추출·승격(P-6) + 429 백오프/강등으로 그래픽 블록까지 이미지 완주(P-1) + 판정문 원문 노출(P-3) + change_pct 정수 선언 그대로 통과(P-2) 확인.

## 열린 결정 — **전부 확정(2026-07-05 사용자 "권고안대로" 일괄 확정, attachment-intake-plan 확정과 함께)**

1. **P-3 = a안 확정**: 판정문-결박 좁은 면제. (b/c안 기각 사유 위 기재)
2. **P-1 자동 강등 = 기본 on 확정**: `HARNESS_NANOBANANA_FALLBACK_MODEL` 기본 `gemini-2.5-flash-image`(디자이너 시안 용도라
   완주 > 티어; 강등 시 감사 로그로 가시화. 끄려면 env 빈 값).
3. **P-2 정규화 = 정수 반올림(<0.5) 자동 정규화 확정**: 그 밖의 모순은 fail-closed(계산값 제시).

## 검증·불변식
- stub/오프라인 골든 바이트 불변(P-1 증분 기록은 실엔진 경로만·stub 은 최종본만) · state.json 스크립트 단독 기록 ·
  생성≠심의 격리 · 차트 데이터-뷰(확산모델 날조 금지) · test_report 직접선언 전용 — 전부 불변.
- 각 Wave 완료 시 Codex 리뷰(critical/high 0), 커밋마다 workflow-ssot 동반 갱신.

## 착수 메타프롬프트(다음 세션용)
`/dev-loop core/docs/bm-designer-handoff-fixes-plan.md — P-1~P-4 구현(P-5 는 P-1 에 흡수, P-6 는 attachment-intake-plan.md W-3 로 이관). 열린 결정 3건은 사람 확인 후 착수(권고: P-3=a안·강등 기본 on·P-2 정수 반올림 정규화). 브랜치 feat/bm-designer-handoff 이어서. 완료 후 릴리프 카나리 재런으로 P-1/2/3 실증. 이어서 attachment-intake-plan.md 착수.`
