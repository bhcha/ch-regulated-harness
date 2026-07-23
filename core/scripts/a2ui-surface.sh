#!/usr/bin/env bash
# a2ui-surface.sh — state.json → A2UI(선언형 UI) 메시지 (한 줄 JSON, 읽기전용·기계 표면).
#   현재 게이트에 맞는 surface 를 harness/a2ui-catalog.json 계약대로 방출한다.
#   ★ 읽기전용: state.json 을 절대 쓰지 않는다(파생만). next-action.sh 와 '동일한 render_runmd 헬퍼'로
#     options/recommended/revise_available/action 을 파생 → 세 표면(run.md·next-action·a2ui)이 절대 어긋나지 않는다.
#   stdout 은 기계용 JSON 이다(next-action.sh 처럼) — 현업 평이화 대상 아님(test-operator-language 비대상).
# 사용법: bash scripts/a2ui-surface.sh <run_id>   →  한 줄 JSON {surface, action, actions[], options[], recommended, revise_available, components[], ...}
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 fail-closed
RDIR="$(run_dir "$RID")"

# a2ui_surface.py 는 실 모듈이므로 heredoc(임시파일 필요 → 읽기전용 FS 에서 "cannot create temp file" 실패) 대신
#   agui-events.sh 처럼 모듈을 '직접 실행'한다(__main__ 이 state.json → derive() 를 한 줄 JSON 으로 출력).
#   임시파일·heredoc 없음 = 읽기전용 역할 보존(state.json 미접촉·파생만).
exec "$PY" "$HARNESS_ROOT/scripts/lib/a2ui_surface.py" "$RID" "$RDIR"
