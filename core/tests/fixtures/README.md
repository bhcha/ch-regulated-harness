# tests/fixtures

## bundle-cosmetic — 합성(synthetic) 화장품 번들 픽스처

**목적**: 오프라인 결정적 파이프라인(`HARNESS_OFFLINE=1`)이 실제 크롤 번들 없이도
자립적으로 돌 수 있게 하는 **커밋 가능한 골든 번들**이다. 실제 크롤 번들
(`naver_10910275313_*`)은 저작권상 커밋 불가(.gitignore)라 이 픽스처가 대체한다.

**사용/전환 상태(2026-07-06 전환 완료)**: `tests/lib.sh:14`·`scripts/build-fixtures.sh` 의 `TEST_BUNDLE`
기본값이 **이 합성 번들(`tests/fixtures/bundle-cosmetic`)로 전환됨** — 구 크롤 심링크(`naver_10910275313_*`)는
제거(decouple)했다. 베이스라인도 이 번들 기준으로 재캡처했다(b0 VOC·b1 VOC/페르소나/평점/offer·claim-basis).
다른 번들로 돌리려면 `TEST_BUNDLE`/`--bundle` 로 지정한다(예: `TEST_BUNDLE=<경로> bash tests/run-ci.sh`).

**출처**: 100% 합성. 크롤 원문·리뷰·이미지 픽셀이 **전혀 포함되지 않는다**.
- `product.json` / `reviews.csv` 텍스트는 사람이 손으로 작성한 가공 문구다.
- `images/detail/*`, `images/main/*` 는 PIL 로 생성한 1×1 단색 플레이스홀더다
  (파이프라인은 픽셀을 디코드하지 않고 파일명·확장자만 읽는다 — no-pixel).

**계약 근거**: `scripts/lib/ingest.py` 가 소비하는 필드에 정확히 맞춘다.
- `product.json`: `name`(스텁 브랜드배너 게이트용 `[브랜드] ` 접두 포함) ·
  `rating` · `collectedReviewCount`(= CSV 행 수) · `totalReviewCount`.
  `price`(=`{current, discountRate}`) 는 **포함**(기본 번들이 offer 추출을 커버하도록 — b1 WS3).
  `mainImage` 는 **생략**(외부 이미지 참조를 만들지 않기 위함).
- `reviews.csv`: UTF-8, RFC4180. 컬럼 `content,score,option`.
  `repurchase`/`재구매` 컬럼은 **두지 않는다**(top_signals 유발 방지).
  8번째 행은 콤마+줄바꿈을 포함한 인용 필드로 RFC4180 파서 속성을 잠근다.
- `images/detail/`: BP_BLOCK_ORDER(13) 버킷에 맞춘 13장(11 jpg + 2 gif).
  `images/main/`: 1장.

**주의**: 이 픽스처의 리뷰 텍스트는 규제 위험어(미백·주름·여드름·기미 등)를
의도적으로 배제한 안전 VOC 어휘(커버·촉촉·밀착·화사)만 쓴다. `evidence/`
서브디렉터리는 없다(근거 문서 첨부 채널 미사용).
