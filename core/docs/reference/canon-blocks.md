# 상세페이지 캐논 블록 + 주요 구성요소 (파생 문서)

> **정본(SSoT) = `packs/_format/<format>/canon.json` + 도메인 오버레이 `packs/<도메인>/canon-overlay.json`**
> (4단계: 3분산 통합 · 캐논 도메인 축). 이 문서는 사람이 읽기 위한 **파생 설명**일 뿐이며, 값의 진실은
> canon.json(+오버레이 병합 결과 = `harness.canon_json(fmt, domain)`)이다(불일치 시 canon.json 이 이긴다).
> - `blocks`: 포맷별 생성 시퀀스(`type`·`intent`·`risk_tier`·`evidence_required`) — 스텁이 `storyline.json` 으로 방출.
> - `types`: 전역 유효 블록 카탈로그 — `validate_storyboard._canon` 이 대조(미등록 type=캐논 외 fail).
> - `evidence_gated`(clinicalEvidence·beforeAfter)·`brand_gated`(brandBanner)·`required_root`(hero): 조건부 제외·필수 루트.
> - `components`: 주요 구성요소 커버리지 — `check_canon_coverage.py` 가 검사.

## 포맷별 캐논

- **multipage_bm**(여러장 BM 세로 상세페이지): `packs/_format/multipage_bm/canon.json` — 15블록 시퀀스 + 10대 구성요소.
- **one_pager**(한장 홍보물): `packs/_format/one_pager/canon.json` — 4블록 압축 시퀀스 + 4구성요소.

## 도메인 캐논 오버레이

규제도메인 팩에 `canon-overlay.json` 이 있으면 그 도메인×포맷 조합에서 `blocks`(생성 시퀀스)·`components`(필수
구성요소)가 **통째로 교체**되고, `types` 는 **가법**(포맷 카탈로그 ∪ `types_add` — 기존 런 후방호환)이다.
오버레이 부재 도메인(화장품 등)은 포맷 캐논 그대로(no-op).

- **drug(의약품) = 교육콘텐츠 캐논**: `packs/drug/canon-overlay.json`
  - **multipage_bm** — 11블록 시퀀스(hero 교육주제/핵심메시지 → problem 문제 인식 → mechanism 발생 원리 →
    ingredientTech 성분 이해 → ingredientDetail 작용 원리 → rtbSummary 핵심 포인트 → clinicalEvidence 연구
    근거[실증 게이트] → targetAudience 이런 분들은 알아두세요 → faq → precautions 주의사항 → footer 필수기재)
    + 11대 구성요소.
  - **one_pager** — 4블록 1매 압축(hero → rtbSummary 핵심 포인트 → precautions → footer 필수기재) + 4구성요소.
    포맷 캐논의 CTA 필수를 대체한다(의약품 한장 홍보물에 구매전환 블록 없음).
  - 판매/순위/후기 직접 설득 블록(socialProof·reviewCapture·buyingGuide 등)은 시퀀스에 없다(질환→원인→성분→근거 흐름).
    신규 블록 type = `mechanism`·`faq`·`precautions`.
  - 디자인 언어 짝: `packs/drug/design-tokens-overlay.json`(클리니컬·에듀케이션 톤 — `harness.design_tokens` 병합).

블록 목록·intent·risk_tier·구성요소 매핑은 위 canon.json/canon-overlay.json 파일을 직접 본다. 스키마
(`harness/storyline.schema.json`·`plan-block.schema.json`)의 `type` 은 4단계에서 닫힌 enum → 구조적 패턴으로
완화됐고(C 메커니즘), 유효 카탈로그 대조는 canon.json(+오버레이) 이 강제한다.
