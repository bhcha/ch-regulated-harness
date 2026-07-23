#!/usr/bin/env bash
# stage-conti.sh — 콘티/스토리보드(03-storyboard: outline→plan (M3 2-cycle)) 단독 격리 검증.
#   입력 = fixtures/conti-in (컨셉→콘티 계약). 앞 단계 실행 불필요.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## STAGE 콘티/스토리보드 (03-storyboard) — 입력=fixtures/conti-in"
RID="stage-conti"; trap 'rm -rf "$ROOT/runs/$RID"' EXIT
export HARNESS_OFFLINE=1

seed_fixture conti "$RID"
[ "$(jq_phase "$RID" phase)" = "03-storyboard" ] && pass "입력 계약 로드(phase=03-storyboard)" || fail "픽스처 로드 실패(실제 $(jq_phase "$RID" phase))"

( cd "$ROOT" &&
  bash scripts/run-stage.sh storyboard-outline "$RID" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-plan "$RID" && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1

[ -f "$ROOT/runs/$RID/03-storyboard/plan/01-hero.json" ] && pass "출력 plan/01-hero.json" || fail "출력 plan 누락"
[ -f "$ROOT/runs/$RID/03-storyboard/outline/decision.json" ] && pass "아웃라인 선택 기록" || fail "아웃라인 decision 누락"
validate_all_artifacts "$RID" && pass "전 산출물 스키마 통과" || fail "스키마 검증 실패"
[ "$(jq_phase "$RID" phase)" = "04-keyvisual" ] && pass "콘티 완료 → 04-keyvisual 핸드오프(=keyvisual-in 계약)" || fail "핸드오프 전진 실패(실제 $(jq_phase "$RID" phase))"

echo "STAGE-CONTI: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
