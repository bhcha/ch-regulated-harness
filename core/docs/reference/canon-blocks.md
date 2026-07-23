# 상세페이지 캐논 블록 + 주요 구성요소 (파생 문서)

> **정본(SSoT) = `packs/_format/<format>/canon.json`** (4단계: 3분산 통합). 이 문서는 사람이 읽기 위한 **파생 설명**일 뿐이며, 값의 진실은 canon.json 이다(불일치 시 canon.json 이 이긴다).
> - `blocks`: 포맷별 생성 시퀀스(`type`·`intent`·`risk_tier`·`evidence_required`) — 스텁이 `storyline.json` 으로 방출.
> - `types`: 전역 유효 블록 카탈로그 — `validate_storyboard._canon` 이 대조(미등록 type=캐논 외 fail).
> - `evidence_gated`(clinicalEvidence·beforeAfter)·`brand_gated`(brandBanner)·`required_root`(hero): 조건부 제외·필수 루트.
> - `components`: 주요 구성요소 커버리지 — `check_canon_coverage.py` 가 검사.

## 포맷별 캐논

- **multipage_bm**(여러장 BM 세로 상세페이지): `packs/_format/multipage_bm/canon.json` — 15블록 시퀀스 + 10대 구성요소.
- **one_pager**(한장 홍보물): `packs/_format/one_pager/canon.json` — 4블록 압축 시퀀스 + 4구성요소.

블록 목록·intent·risk_tier·구성요소 매핑은 위 canon.json 파일을 직접 본다. 스키마(`harness/storyline.schema.json`·`plan-block.schema.json`)의 `type` 은 4단계에서 닫힌 enum → 구조적 패턴으로 완화됐고(C 메커니즘), 유효 카탈로그 대조는 canon.json 이 강제한다.
