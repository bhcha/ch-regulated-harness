#!/usr/bin/env bash
# run-stages.sh — 4단계 격리 검증 일괄(각 단계 단독, 동결 핸드오프 픽스처 입력).
#   통합 게이트는 run-ci.sh(end-to-end). 이건 분리 개발 중 '단계별 단독 검증'용.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -d ../packs/cosmetic/fixtures/concept-in ] || { echo "픽스처 없음 → 생성: bash scripts/build-fixtures.sh"; bash scripts/build-fixtures.sh; }
rc=0
for s in brief concept conti keyvisual; do
  bash "tests/stage-$s.sh" || rc=1; echo
done
if [ "$rc" -eq 0 ]; then echo "==== STAGES: 4단계 격리 전체 통과 ✓ ===="; else echo "==== STAGES: 실패 ✗ ===="; fi
exit $rc
