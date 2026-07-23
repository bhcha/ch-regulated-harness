#!/usr/bin/env bash
# stage-keyvisual.sh — 키비주얼/아트워크(04-keyvisual) 단독 격리 검증.
#   입력 = fixtures/keyvisual-in (콘티→키비주얼 계약). 앞 단계 실행 불필요.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## STAGE 키비주얼/아트워크 (04-keyvisual) — 입력=fixtures/keyvisual-in"
RID="stage-keyvisual"; trap 'rm -rf "$ROOT/runs/$RID"' EXIT
export HARNESS_OFFLINE=1

seed_fixture keyvisual "$RID"
[ "$(jq_phase "$RID" phase)" = "04-keyvisual" ] && pass "입력 계약 로드(phase=04-keyvisual)" || fail "픽스처 로드 실패(실제 $(jq_phase "$RID" phase))"

( cd "$ROOT" &&
  bash scripts/run-stage.sh keyvisual "$RID" && bash scripts/select.sh "$RID" A && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1

[ -f "$ROOT/runs/$RID/04-keyvisual/options/A/index.html" ] && pass "출력 디자인 HTML(A)" || fail "디자인 HTML 누락"
[ -f "$ROOT/runs/$RID/04-keyvisual/design-manifest.json" ] && pass "출력 design-manifest.json" || fail "design-manifest 누락"
[ -f "$ROOT/runs/$RID/04-keyvisual/canon-coverage.json" ] && pass "출력 canon-coverage.json" || fail "canon-coverage 누락"
validate_all_artifacts "$RID" && pass "전 산출물 스키마 통과" || fail "스키마 검증 실패"
[ "$(jq_phase "$RID" phase)" = "done" ] && pass "키비주얼 완료 → done(최종 산출)" || fail "완료 전진 실패(실제 $(jq_phase "$RID" phase))"

echo "STAGE-KEYVISUAL: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
