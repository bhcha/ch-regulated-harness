# 메타프롬프트 — evidence 내용 반영 G5(문서만 주면 자동 제안)·G7(온라인 카나리) (fresh session)

> 세션 클리어 후 이 파일을 첫 메시지로 붙여넣거나 "core/docs/evidence-content-resume-G5-G7.md 읽고 이어서" 라고 지시.
> 작성 2026-07-04 (직전 세션 핸드오프). 설계 SSoT = `core/docs/evidence-content-integration-plan.md`(특히 9번 절). 규칙 SSoT = `core/AGENTS.md`. 워크플로우 정본 = `core/docs/workflow-ssot.md`(동반 갱신 의무).

> **✅✅ 현재 상태(2026-07-05) — G5·G7 모두 완료. evidence '내용 반영' 기능은 끝났다. 다음 작업 = pack-refactor(팩 분리).**
> - **G5 완료**(브랜치 `feat/evidence-content-propose`, 미커밋 41파일): 조건부 `00e-evidence` 페이즈(방식 B). 상세 = 아래 G5 note·절.
> - **G7(온라인 ADK 카나리) 완료**: 실 PDF(`/Users/chabh/Documents/temp/PNK-22627-A1R … 이지덤뷰티 릴리프 여드름피부사용적합 결과보고서.pdf`)로 화장품 여러장 실런 `runs/ezderm-relief-cosmetic-live` 를 **done 완주**. 실제 화장품 ADK 심의(원격, `ADK_COSMETICS_CRITIC_URL`) 각 단계 통과 + Nano Banana 실이미지 렌더 + doc-01 이 `09-brandTrust` 각주로 `reflected_in` 기록(안전성-평가 프레이밍 = 효능 미승격, 각주 채널). 최종 HTML 규정 준수(금지표현 0·독립 재검증). **릴리프만 화장품**(다른 이지덤 제품은 참고소개). 산출물 = `runs/ezderm-relief-cosmetic-live/04-keyvisual/{options/A/index.html, export/kcia-package/}`. (G7 절의 '실 PDF 2종' 중 일반 참조 1건은 이번 런에선 미사용 — PNK 1건으로 완주.)
> - **E2E 발견 2건(후속 범위)**: ① Nano Banana 제품이미지에 **구운 텍스트가 ADK 텍스트 심의를 우회** — 오타(티트리임→티트리잎·시위→샤워)·오수치(7,000ppm, WB=10,000)·미심의 마케팅 문구(피부진정/커버력)가 픽셀로 들어감(ADK 는 이미지 OCR 안 함). → `render_mode=html_only`(제품 라벨은 굽지 말 것) 처방 실측 확증(메모리 nanobanana-graphic-block-label-corruption). ② **다중-제품 WB 인입 오염**: `cmd_claim_basis` 가 비-범위 제품(퀵카밍/리얼카밍/마그네슘)의 임상 마커 35건을 evidence_on_file 로 오추출 → scienceEvidence 교착. 실런에선 evidence_on_file=[] 로 수동 교정. → 인입이 제품-범위를 인지해 추출하도록 고칠 것(메모리 ev-03 추출 결함).
> - **G5 커밋 대기**: `feat/evidence-content-propose` 41파일 미커밋(Codex 최종 clean·전체 CI 회귀 0[critic-fanout 3·B4 1 은 사전존재]·E2E 검증). **pack-refactor 착수 전 G5 먼저 커밋/병합** — 1차 1~3단계가 `ingest.py`/`common.sh`/`validate-stage` 를 겹치게 건드리므로("먼저 병합=기준선" 원칙).
> - **다음 작업 메타프롬프트 = `core/docs/pack-refactor-resume-2-stage1.md`**(구 `pack-refactor-resume-prompt.md` 대체). ⚠ 정정: 그 문서의 작업 브랜치 지시(`refactor/pack-stage0-tools`)는 **이미 main 에 병합**됨(0단계 도구 S1~S7 = main; `git log main..refactor/pack-stage0-tools` 공집합) → 새 작업은 **main(=G5 병합 후)에서 분기**. 착수 순서: 부록C **4개 열린 결정 사람 확정**(번들전략 a·webp 유지·교차오염 1차7단계·drug 골든 escalated 동결) → 0단계 잔여(**번들 복구 최우선**, 베이스라인 재캡처 비가역→사람 확인 후) → 1차 1~9단계.

> **✅ G5 완료(2026-07-04, 브랜치 `feat/evidence-content-propose`) — 이제 남은 것은 G7(온라인 ADK 카나리) 하나뿐.** 방식 B(조건부 `00e-evidence` 페이즈, 00g-guideline 패턴 복제)로 구현했다: 사람이 참조 문서를 **문서만 첨부**(반영 스펙 미정)하면 인입이 fail-closed 대신 `spec_status:pending` 으로 기록 → 조건부 페이즈 `00e-evidence`(`review:false`)에서 세션 내 에이전트가 `inputs/evidence/*` 를 읽어 `00e-evidence/reflection-proposal.json`(문서별 kind 추정·claim·원문 reflection_points) 초안 작성 → `validate-stage`(제안↔pending 문서 1:1·kind enum·포인트≥1) → 사람 `approve.sh`(단안) → `kcia-check` review-exempt-autopass → `gate.sh review` 가 `ingest.py apply-proposal` 로 매니페스트 재기록(pending 해소·`spec_origin:agent_proposed_human_approved`) → 다음 조건부 페이즈. **00e 는 `test_report` 를 거부 — 일반 참조/각주 인용 채널만**(효능 실증 시험성적서는 인입 직접 선언 전용, 자동 제안 승격 우회 금지). 단일 라우터 `common.sh compute_next_conditional`(pending→00e·사례→00g·else 01-brief) · `advance-phase` pending choke 가드 · `--to` allow-list `00e-evidence|00g-guideline|01-brief` · done pending backstop. 계약 additive: `state.schema`·`pipeline-routes`·`phase-descriptors`(guideline_leaf 00g+00e)·`format-profiles` active_phases·`registry`·`evidence-documents.schema`(spec_status:pending)·신규 `harness/reflection-proposal.schema.json`. 슬래시 `/evidence`(skill `core/skills/evidence/SKILL.md`·`core/prompts/evidence.md`). **회귀 green**: 신규 `core/tests/test-b1e.sh`(run-ci 등록) · `core/tests/test-evidence-reflection.sh`(문서만→done E2E) · `core/tests/test-evidence-attachment.sh`(pending). 아래 'G5' 절은 완료 기록으로 남긴다 — **다시 착수하지 말 것**. **남은 임무 = G7 뿐**(아래 G7 절).

## 임무
evidence(근거/참조 문서) '내용 반영' 기능의 남은 조각을 완성하라. **G5**(사람이 반영 포인트를 안 적고 **문서만** 첨부해도 in-session 에이전트가 BM 용 내용을 추출·제안하고 사람이 승인하는 흐름) 은 **✅ 완료**(2026-07-04, `feat/evidence-content-propose` — 상단 note 참조, 다시 하지 말 것). 따라서 **남은 임무는 G7 하나** = 실 PDF 로 온라인 ADK 심의까지 done 완주 카나리. 진행 방식은 `/dev-loop`(스테이지별 구현→Codex 심의→수정→회귀→커밋), 각 커밋 `workflow-ssot.md` 동반.

## 리포지토리 / 브랜치
`/Users/chabh/workspace/ch-regulated-harness` · 운영 루트 `core/` · **작업 브랜치는 evidence 작업이 병합된 브랜치**(직전 세션 종료 시 `feat/evidence-content-integration`; main 병합 여부는 `git log --oneline -5` 로 확인 후 이어갈 브랜치 결정 — main 에 있으면 main 에서 새 브랜치 `feat/evidence-content-propose` 분기). `.env` 는 repo 루트(`../.env`, core 기준)에 `ADK_COSMETICS_CRITIC_URL` 보유(온라인 심의 가능).

## 이미 완료·커밋됨 — 다시 하지 말 것 (a~e + G0~G6)
핵심 동작(검증됨): **사람이 참조 문서(임의 kind)를 첨부하며 반영 포인트를 지정하거나(또는 시험성적서면) 그 내용이 상세페이지에 반드시 반영되고, 안 되면 done 이 막힌다.**
- `03b2658`(a) 반영 선언 스키마 · `2b228c4`(b) 인입 승격(doc-NN·claim→summary)+판정문 결박 · `e0b8ca9`(c+d) EVIDENCE_DOCS 컨텍스트+2층 반영 강제(03 validate+advance-phase done 게이트)+export reflected_in · `3b6ae1f`(e) stub doc-인지+정성 인증형 완화+오프라인 E2E
- `67fb237`(G0) 일반화 설계(§9) · `ea92c43`(G1) `kind`·`reflection_points`·`spec_origin` 스키마 · `aad4f69`(G2~G6) 인입 kind 분기·일반 문서 각주 인용 채널·REFERENCE_DOCS 라벨/프롬프트·일반 결박·done 게이트(doc-id+내용 둘다생존)·stub 일반-doc 반영·오프라인 E2E · `30ff47f` 이월 기록

## 지키기 — 안전 불변식(회귀 시 깨지면 안 됨)
- 일반 참조 문서(kind≠test_report)는 **claim-basis.evidence_on_file 미편입**(`ingest.py` 승격은 `kind=="test_report"` 만). 편입하면 `check_canon_coverage:202`(clinicalEvidence 강제) + `kcia_engine` 강주장 실증 오용.
- 일반 문서 인용 = **각주(footnotes[].text 에 doc-NN)** 만. `claims[].evidence_ref` 금지(kcia "가짜 인용"·validate 거부).
- 반영 판정(`check_evidence_reflection.reflected_map`) = 선택 HTML 블록 섹션에 **doc-id(추적성) AND 내용(판정문/포인트 원문) 둘 다** 생존(정확 doc 토큰·HTML 엔티티 디코드). 일반 결박(`validate_storyboard._check_reference_binding`) = 반영 포인트 원문 ⊆ 블록 **본문** 카피(각주 제외).
- no-evidence 런 골든 바이트 불변. reflect:false = 첨부-전용. `import html` 이 함수-로컬 `html` 변수에 가려지지 않게 주의(직전 버그).

## 검증 커맨드 (오프라인, 결정적)
```
bash core/tests/test-evidence-attachment.sh    # 103 PASS (인입·kind 분기·일반 문서·안전 불변식)
bash core/tests/test-evidence-reflection.sh    # 17 PASS (오프라인 E2E: test_report 정성 + 일반 brand_story done 완주)
bash core/tests/test-prompt-contract.sh        # 25 PASS · bash core/tests/test-prompt-assembly.sh  # 12 PASS(프롬프트 수정 시 PROMPT_ASSEMBLY_REGEN=1 재캡처)
```
⚠ **테스트 실번들 복원 필수**: ingest 스위트는 `core/naver_10910275313_20260617-1331`(git-ignored)을 기본으로 쓴다(`tests/lib.sh:14`). 없으면 대량 red →
`ln -sfn /Users/chabh/workspace/ch-detail-page-harness/naver_10910275313_20260617-1331 core/naver_10910275313_20260617-1331` 후 `.git/info/exclude` 등록(커밋 차단). (pack-refactor S1 value-replica·S8 flip 완료되면 불필요 — `pack-refactor-resume-2-stage1.md`.)

## 이어하기 = G5 → G7

### G5 — "문서만 주면 자동 추출·제안" (✅ 완료 2026-07-04 — 방식 B 채택; 아래는 완료 기록·다시 하지 말 것)
> **완료:** 방식 **B(조건부 `00e-evidence` 페이즈)** 로 구현했다(상단 note 요약). 이하 B/C 검토 내용은 착수 판단 기록으로 보존한다.
현재는 스펙 없는 reflect:true 일반 문서 = 인입 fail-closed(`ingest.py cmd_evidence_docs` 완전성 게이트). 확정 결정 1(a)의 에이전트-초안 경로를 붙인다.
**⚠ 착수 전 사람에게 방식 재확인**(직전 세션 사람이 이월 결정, B/C 최종 미확정):
- **B안 — 조건부 `00e-evidence` 페이즈**(00g-guideline 패턴 복제, 상태머신 변경 큼):
  1. ingest: 스펙 없는 reflect:true 를 fail-closed 대신 `spec_status:"pending"` 매니페스트 기록(승격·라벨·반영의무 보류).
  2. advance 게이트: pending 있으면 01-brief 진입 차단.
  3. 신규 `00e-evidence`(pending 있을 때만 활성): in-session 에이전트가 `inputs/evidence/*` 읽고 `00e-evidence/reflection-proposal.json`(kind 추정+원문 발췌 포인트 초안) 작성 → validate-stage → 사람 approve → 매니페스트 재기록(`spec_origin:agent_proposed_human_approved`)+test_report 면 승격 재실행. `review:false`.
  4. 배선: `harness/state.schema.json`·`harness/phase-descriptors.json`(00e descriptor)·`scripts/advance-phase.sh`·`scripts/new-run.sh`/route·신규 `prompts/evidence-draft.md`·신규 `harness/reflection-proposal.schema.json`. **참조 패턴 = 00g-guideline 조건부 페이즈 전체**(조건부 활성·review-exempt-autopass·양성-완료 advance 게이트). 회귀=routes·gates·advance·b0~b9 전부.
- **C안 — 경량 인입-전 사이드카 초안**(state 무변경): ingest fail-closed 유지, 실패 메시지가 "에이전트에게 초안 요청" 안내 → 에이전트가 `inputs/evidence/index.json` 초안(kind+reflection_points 제안) 작성 → 사람 확정 → 재-인입. 신규 `prompts/evidence-draft.md`+스킬만. 승인=파일 수령(state 감사 없음).
착수 원칙: 환각 안전(AI 초안·사람 확정) · 결정론(state 는 scripts) · 생성≠심의(추출=생성) 유지.

### G7 — 온라인 ADK 카나리 (✅ 완료 2026-07-05 — 다시 하지 말 것)
> **완료:** 실 PDF `PNK-22627 … 이지덤뷰티 릴리프 여드름피부사용적합 결과보고서.pdf` 를 참고자료(bare 첨부)로 넣어 화장품(릴리프-only) 여러장 실런 `runs/ezderm-relief-cosmetic-live` 를 `HARNESS_OFFLINE` 미설정(온라인)·`ADK_COSMETICS_CRITIC_URL` 로 **done 완주**시켰다. 결과: doc-01 이 00e 에서 각주(general/footnote)로 제안·승인·반영 → `09-brandTrust` 에 `reflected_in` 기록(안전성-평가 프레이밍, 정량 효능 미승격) · 실제 화장품 ADK 심의를 brief·concept·storyboard-plan·keyvisual 각 단계 통과(여드름 치료/효능/최상급 문구는 심의가 반려 → 진정/사용적합/물리스펙으로 재작성) · Nano Banana 실이미지 렌더(429 쿼터 시 graceful fallback) · 최종 HTML 규정 준수 재검증. 발견 2건은 상단 배너 참조(Nano Banana 구운-텍스트 심의 우회 · 다중-제품 WB claim-basis 오염). 산출물: `04-keyvisual/options/A/index.html`·`export/kcia-package/`.
> 원 계획(참고): 실 PDF 2종(시험성적서 + 일반 참조 1건)으로 온라인 done 완주 → 두 doc 모두 `reflected_in` + ADK 통과. 실제로는 PNK 1건(참고자료 경로)으로 완주했고, '시험성적서 경로'는 별도로 시험기관-누락 fail-closed 로 시연함(인입 완전성 게이트 확인). 4동작(run-stage·select/approve·kcia-check) + run.md '다음 명령'. 비용·비가역이라 실행은 사람 확인 후 진행했다.

## 먼저 읽을 파일 (코드 앵커)
`scripts/lib/ingest.py`(cmd_evidence_docs — 완전성 게이트 kind 분기·승격 test_report 한정) · `scripts/lib/check_evidence_reflection.py`(reflected_map·done 게이트) · `scripts/lib/validate_storyboard.py`(_check_verdict_binding·_check_reference_binding·_block_copy_blob) · `scripts/lib/common.sh`(build_context EVIDENCE_DOCS/REFERENCE_DOCS) · `scripts/lib/kcia_engine.py`(_qualitative_cert_ok·_has_measured_pair) · `scripts/lib/stub_stage.py`(_inject_general_reflection·clinicalEvidence doc-인지) · `scripts/lib/export_package.py`(reflected_in·README) · 참조 패턴(G5 B안) 00g-guideline 조건부 페이즈.
