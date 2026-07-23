#!/usr/bin/env bash
# stage-concept.sh — 컨셉/빅아이디어(02-concept) 단독 격리 검증.
#   입력 = 동결된 핸드오프 픽스처 fixtures/concept-in (브리프→컨셉 계약). 앞 단계 실행 불필요.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## STAGE 컨셉/빅아이디어 (02-concept) — 입력=fixtures/concept-in"
RID="stage-concept"; trap 'rm -rf "$ROOT/runs/$RID"' EXIT
export HARNESS_OFFLINE=1

seed_fixture concept "$RID"
[ "$(jq_phase "$RID" phase)" = "02-concept" ] && pass "입력 계약 로드(phase=02-concept)" || fail "픽스처 로드 실패(실제 $(jq_phase "$RID" phase))"

( cd "$ROOT" && bash scripts/run-stage.sh concept "$RID" && bash scripts/select.sh "$RID" B && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1

for f in 02-concept/concept-axes.json 02-concept/recommendation.json 02-concept/decision.json; do
  [ -f "$ROOT/runs/$RID/$f" ] && pass "출력 $f" || fail "출력 누락 $f"
done
validate_all_artifacts "$RID" && pass "전 산출물 스키마 통과" || fail "스키마 검증 실패"
[ "$(jq_phase "$RID" phase)" = "03-storyboard" ] && pass "컨셉 완료 → 03-storyboard 핸드오프(=conti-in 계약)" || fail "핸드오프 전진 실패(실제 $(jq_phase "$RID" phase))"

echo "STAGE-CONCEPT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
