# 디자인 토큰 (키비주얼 프리미티브)

> `prompts/keyvisual.md` + `scripts/render-design.sh` 가 참조. 브랜드별 디자인 시스템(스킬)이 있으면 연계.
> **토큰 값 정본 = `packs/_format/design-tokens.json` + 도메인 오버레이 `packs/<도메인>/design-tokens-overlay.json`(있으면)** —
> 병합 단일 리더는 `harness.design_tokens(domain)`(디자인 토큰 도메인 축, 캐논 오버레이와 동형). 오버레이 도메인은
> 그 `tone_directions`·`visual_guidance` 가 우선하고, 오버레이 없는 도메인은 포맷 토큰 그대로다.

## 채널 프로파일 (네이버 스마트스토어)
- 콘텐츠 폭: **860px**, DPR 1, 96dpi. 세로 섹션 스택. gif 허용.
- 섹션 캡처: `[data-block]` DOM 요소 단위(좌표 슬라이싱 금지 → 결정적 분할).

## 타이포
- 셀프호스팅 폰트 **Pretendard**(`assets/fonts/PretendardVariable.woff2`) — 머신/CLI 간 렌더 재현성.
- 풀블리드 헤드라인, **부분 컬러 하이라이트**(`.accent`).

## 전역 아트디렉션(브랜드킷, 이슈4 P0-ⓠ)
- 모든 키비주얼은 기획안 단계의 **전역 아트디렉션**(`03-storyboard/art-direction.json`, `build_context` 의 `ART_DIRECTION` 라벨)을 **상속**한다 — `master_palette`·`color_temp`·`lighting`·`typography`·`master_reference`(마스터 제품 시트 1장).
- 블록마다 색·무드를 새로 정하지 말 것(블록별 다른 경쟁사 스타일 앵커 = 톤 분열). 블록은 **구도(composition)·subject·aspect_ratio** 등 고유만 둔다. 블록 `palette` 는 `master_palette` 의 **부분집합**이어야 한다(`validate-stage.sh` fail-closed).

## 컬러
- 기본은 **단일 accent color**(`--accent`, **기본값** `#c0392b` 계열 — `stub_stage.py:ACCENT_DEFAULT`) + 전역 `master_palette`. 도메인/브랜드별 디자인 프로파일 seam 은 후속.
- **커머스 밀도 완화(이슈4 P1-③) — `multipage_bm` 포맷에 한정**: 실제 쿠팡/스마트스토어 상세처럼 **그라데이션 색섹션**·다색 포인트를 허용한다. ⚠ 단 `one_pager` 등 다른 포맷에는 적용하지 않는다(회귀 방지). 색은 전역 `master_palette` 안에서 변주(밝기/채도 단계)로 풀고, 임의 신규 색 추가는 지양.

## 컴포넌트
- 누끼 제품컷(`visual.kind: nukki`), 막대그래프(`graph`), 색상 스와치(`swatch`), 말풍선 리뷰(`chat`), 사진(`photo`).
- **하단 각주 라인(의무 슬롯)**: 강한 주장 블록은 `.footnote` 라인을 반드시 가진다(주장-각주 페어링의 시각적 대응).

### 아이콘 — 인라인 SVG 선화 (이슈4 P0-②)
- 성분/포인트/사용법 아이콘은 **빈 동그라미(`<div>` 점·빈 원) 금지**. 의미를 담은 **인라인 `<svg>` 선화**(stroke 기반, `currentColor`/`--accent`)를 쓴다 — 외부 아이콘 폰트·이미지 금지(자체완결·저작권 안전).
- 패턴: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ...><!-- path --></svg>`. 24px 그리드, 라운드 cap/join, 1.4~1.8 stroke.
- 예: 물방울(수분)·잎(저자극)·시계(데일리)·실드(보호)·체크(편의). 텍스트 라벨을 항상 동반(아이콘 단독 금지).

### 커머스 밀도 컴포넌트 (이슈4 P1-③ — `multipage_bm` 한정, 사실 기반)
- **넘버드 포인트 뱃지**: `01 / 02 / 03 …` 원형/사각 번호 + 한 줄 포인트(RTB 요약의 시각 강조).
- **스펙 콜아웃**: 용량·구성·성분 함량 등 **사실 수치**(출처 `voc.json`/`claim-basis`)를 카드로. 추정·과장 금지.
- **씰/뱃지**: 수상·인증은 **실제 보유분만**(가짜 인증·의약외품 오인 도장 금지 — 화장품은 "식약처 허가 의약외품" 류 도장 절대 금지). 미보유면 슬롯 비움.
- **소셜프루프**: 후기/판매 수치는 기준일·출처 각주 필수. 후기 없으면 "수집 중" placeholder 유지(가짜 후기 금지).
- ⚠ **밀도는 자유, 주장(카피·인증·수치·전후비교)은 실증·룰셋 게이트 그대로.** 시각 관용(레이아웃·아이콘·색섹션)만 따라가고, 주장은 절대 따라하지 않는다.

## 저작권
- `<img src>` 는 자사 자산/생성물(`inputs/assets/`·`04-keyvisual/generated/`)/product.json 자사 URL만. 크롤 원본(`inputs/bundle/images/`)은 레퍼런스 전용 → `validate-stage.sh` lint 차단.
- **생성 이미지 우선(이슈4 P0-①)**: 블록 비주얼은 `IMAGE_MANIFEST` 의 자사 생성물(`04-keyvisual/generated/NN-type.{png,svg}`)을 블록 `<img src>` 로 **우선** 참조한다. 없을 때만 자사컷 → 그래도 없으면 도형/타이포 박스.
