#!/usr/bin/env bash
# tests/verify-baseline.sh — 정본 런 1회 → 골든 매니페스트 대조(미변경 경로 의미 바이트 보존, 0순위 알람).
#   마이그레이션(단계1~6) 매 단계 후 실행. 의도된 골든 갱신이면 capture-baseline.sh 재실행 후 커밋에 명시.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## verify-baseline — 미변경 경로 바이트 보존 검증"
M="$ROOT/tests/golden/baseline-manifest.json"
[ -f "$M" ] || { echo "  ✗ 골든 없음: ${M#"$ROOT"/} (먼저 capture-baseline.sh)"; exit 1; }
drive_to_done base-vrf claude || { echo "  ✗ 정본 런 실패(done 미도달)"; exit 1; }
python3 "$ROOT/scripts/lib/baseline.py" verify "$ROOT/runs/base-vrf" "$M"; rc=$?
rm -rf "$ROOT/runs/base-vrf"
exit $rc
