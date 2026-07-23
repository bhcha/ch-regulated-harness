#!/usr/bin/env bash
# check-components.sh — 상세페이지 '주요 구성요소' 커버리지 체크 단계 (현업/CI 공용).
#   현업 제공 표(packs/_format/<format>/canon.json 의 components)의 10대 구성요소가 산출물에 들어있는지 한 번에 점검하고
#   canon-coverage.json 리포트를 남긴다. 필수 구성요소 누락 시 비정상 종료(친절 안내).
# 사용법: bash scripts/check-components.sh <run_id> [--scope plan|outline|design]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"; shift || true
RDIR="$(run_dir "$RID")"

if "$PY" "$HARNESS_ROOT/scripts/lib/check_canon_coverage.py" "$RDIR" "$@"; then
  ok "주요 구성요소 커버리지 충족 (canon-coverage.json 기록)"
  exit 0
else
  err "주요 구성요소가 누락되었습니다. 위 ✗ 항목 블록을 스토리라인/기획안/디자인에 추가하세요."
  err "(과학/임상은 실증 미등록 시 자동 면제됩니다 — 환각 차단)"
  exit 1
fi
