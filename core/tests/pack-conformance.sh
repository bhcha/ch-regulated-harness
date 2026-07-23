#!/usr/bin/env bash
# tests/pack-conformance.sh — 4팩 적합성 스위트 (2부 8단계, DoD 5).
#   "팩이 자기 검증물을 선언하고 core 가 순회 실행한다." 전 팩(packs/<도메인>)을 순회하며:
#     (0) 레지스트리 동결 불변식 — 전 팩 pack-lint(domain==디렉터리명·status enum·active⇒ruleset 스키마).
#     (1) 각 팩의 선언물(domain.json·ingest-profile.json·[active]ruleset.json) 존재.
#     (2) 검증 도메인(active + 골든셋 보유)의 골든셋 회귀(검출률/오탐률 게이트, golden_runner).
#   스텁 베이스라인(cosmetic verify-baseline · drug test-drug-stub-golden)은 run-ci 의 도메인별 골든이
#   담당하므로 여기서는 중복 실행하지 않는다(이 스위트는 '팩별 선언 + 회귀'를 가시화하는 순회 러너).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
PACKS_DIR="${PACKS_DIR:-$(cd "$ROOT/.." && pwd)/packs}"
PY=python3
PASS=0; FAIL=0
chk() { local m="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ✓ $m"; PASS=$((PASS + 1)); else echo "  ✗ $m"; FAIL=$((FAIL + 1)); fi; }

echo "## 팩 적합성 스위트 — 전 팩 순회 (2부 8단계)"

# (0) 레지스트리 동결 불변식 — 전 팩 pack-lint
chk "레지스트리 불변식(pack-lint 전 팩)" env PACKS_DIR="$PACKS_DIR" "$PY" "$ROOT/scripts/lib/pack_lint.py"

for pack in "$PACKS_DIR"/*/; do
  dom="$(basename "$pack")"
  [ "$dom" = "_format" ] && continue
  [ -f "$pack/domain.json" ] || continue
  status="$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1])).get('status',''))" "$pack/domain.json" 2>/dev/null)"
  echo "## [$dom] status=$status"
  chk "[$dom] domain.json 선언" test -f "$pack/domain.json"
  chk "[$dom] ingest-profile.json 선언" test -f "$pack/ingest-profile.json"
  if [ "$status" = "active" ]; then
    chk "[$dom] ruleset.json 선언(active)" test -f "$pack/ruleset.json"
    gs="$pack/golden/kcia-golden-set.json"   # 8단계: 전 도메인 골든셋을 packs/<도메인>/golden 이 소유(cosmetic·drug 대칭)
    if [ -f "$gs" ]; then
      chk "[$dom] 골든셋 회귀(검출률/오탐률 게이트)" env PACKS_DIR="$PACKS_DIR" "$PY" "$ROOT/scripts/lib/golden_runner.py" "$gs"
    else
      echo "  ⊘ [$dom] 골든셋 미선언 — 스킵"
    fi
  else
    echo "  ⊘ [$dom] status≠active(TBD) — ruleset/골든셋 회귀 면제(placeholder-autopass 도메인)"
  fi
done

printf '\n[pack-conformance] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
