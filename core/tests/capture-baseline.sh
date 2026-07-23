#!/usr/bin/env bash
# tests/capture-baseline.sh — 정본 런(cosmetic·multipage_bm) 2회 → 의미 바이트 골든 캡처.
#   "바이트 골든 + structdiff 골든". 마이그레이션 단계마다 verify-baseline.sh 로
#   '미변경 경로 의미 바이트 보존'(부록A·7장)을 0순위 알람으로 확인한다. 2회 런 교집합으로 잔여 비결정을 자동 배제.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## capture-baseline — 정본 런(done 까지) 2회 → tests/golden/baseline-manifest.json"
drive_to_done base-cap-a claude || { echo "  ✗ 정본 런 A 실패(done 미도달)"; exit 1; }
drive_to_done base-cap-b claude || { echo "  ✗ 정본 런 B 실패(done 미도달)"; exit 1; }
python3 "$ROOT/scripts/lib/baseline.py" intersect \
  "$ROOT/runs/base-cap-a" "$ROOT/runs/base-cap-b" \
  "$ROOT/tests/golden/baseline-manifest.json" || { rm -rf "$ROOT/runs/base-cap-a" "$ROOT/runs/base-cap-b"; exit 1; }
rm -rf "$ROOT/runs/base-cap-a" "$ROOT/runs/base-cap-b"
echo "  ✓ 캡처 완료"
