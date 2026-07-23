#!/usr/bin/env bash
# stage-brief.sh — 브리프(유형선언+00-ingest+[00g-guideline]+01-brief) 단독 격리 검증.
#   입력 = 원시(working-backwards + bundle + 유형선언). 출력 = concept-in 핸드오프 계약.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## STAGE 브리프 (유형선언→인입→[유사점]→정리) — 출력=concept-in 계약"
RID="stage-brief"; trap 'rm -rf "$ROOT/runs/$RID"' EXIT
export HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm
rm -rf "$ROOT/runs/$RID"

( cd "$ROOT" &&
  bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" &&
  bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1

{ [ "$(jq_phase "$RID" product.regulatory_domain)" = "cosmetic" ] && [ "$(jq_phase "$RID" product.deliverable_format)" = "multipage_bm" ]; } \
  && pass "유형선언(도메인+포맷) 기록" || fail "유형선언 누락"
for f in 00-ingest/voc.json 00-ingest/claim-basis.json 00-ingest/assets-manifest.json 01-brief/brief.json; do
  [ -f "$ROOT/runs/$RID/$f" ] && pass "핸드오프 $f" || fail "핸드오프 누락 $f"
done
validate_all_artifacts "$RID" && pass "전 산출물 스키마 통과" || fail "스키마 검증 실패"
[ "$(jq_phase "$RID" phase)" = "02-concept" ] && pass "브리프 완료 → 02-concept 핸드오프" || fail "핸드오프 전진 실패(실제 $(jq_phase "$RID" phase))"
python3 "$ROOT/scripts/lib/harness.py" structdiff "$ROOT/runs/$RID/state.json" "$PACKS_DIR/cosmetic/fixtures/concept-in/state.json" >/dev/null 2>&1 \
  && pass "출력 state 구조 = concept-in 동결 계약(키·타입 일치)" || fail "state 구조가 concept-in 계약과 불일치"

echo "STAGE-BRIEF: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
