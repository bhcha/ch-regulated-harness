#!/usr/bin/env bash
# agui-events.sh — AG-UI 이벤트 로그 재생(replay). ★ 읽기 전용 ★ (state.json·.events 를 절대 쓰지 않는다).
#   next-action.sh 와 같은 '파생-전용' 설계: 방출 모듈(scripts/lib/agui_events.py)의 replay 로 위임해
#   runs/<id>/.events/agui.jsonl(투영 로그: StateSnapshot + StateDelta + 생명주기 이벤트)을 stdout JSONL 로 스트림한다.
#   로그가 아직 없으면 현재 state.json 에서 즉석 파생(스냅샷 + 생명주기, 델타 없음) — 역시 쓰기 없음.
#   재구성: 스냅샷에 델타를 순차 적용하면 최종 state.json 이 재구성된다(replay = 그 스트림).
# 사용법: bash scripts/agui-events.sh <run_id>
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
exec "$PY" "$HARNESS_ROOT/scripts/lib/agui_events.py" replay "$RID"
