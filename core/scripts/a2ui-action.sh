#!/usr/bin/env bash
# a2ui-action.sh — A2UI ClientEvent(named action) → 현업 4동작 스크립트 위임(pure pass-through).
#   ★ 절대 규칙: state.json 을 직접 쓰지 않는다. 현재 surface(a2ui-surface 와 동일 파생)의 허용 action 을
#     검증한 뒤, 유효하면 select.sh/approve.sh/revise.sh/run-stage.sh(raise-limit) 로 '위임'한다
#     — 상태 변이는 그 4동작 스크립트가 수행한다(여기선 검증·라우팅만).
#   검증 실패(잘못된 게이트·미지 action·없는 옵션키·필수 payload 누락)는 비-0 종료 + 명료한 메시지.
# 사용법: bash scripts/a2ui-action.sh <run_id> <event>
#   <event> = action.json 파일 경로 또는 인라인 JSON. 예:
#     bash scripts/a2ui-action.sh <id> '{"action":"select","value":"A-efficacy"}'
#     bash scripts/a2ui-action.sh <id> '{"action":"approve","ra_ok":true}'
#     bash scripts/a2ui-action.sh <id> '{"action":"revise","direction":"이 표현 빼줘"}'
#     bash scripts/a2ui-action.sh <id> '{"action":"raise-limit"}'
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"; shift || true
assert_ingest_complete "$RID"   # N10: 썩은 인입 위 상태변이 차단(위임 스크립트도 각자 방어하나 여기서 조기 차단)
EVENT="${1:-}"
[ -n "$EVENT" ] || die "action 이벤트가 필요합니다(action.json 경로 또는 인라인 JSON). 예: bash scripts/a2ui-action.sh $RID '{\"action\":\"approve\"}'"
RDIR="$(run_dir "$RID")"

# a2ui_action.py 가 검증 후 4동작 스크립트를 subprocess 로 실행하고, 성공·거부 모두 stdout 에 단일 JSON
#   envelope({ok,action,delegate,exit,message}) 한 줄을 방출한다(기계 파서 계약). 위임의 exit code 를
#   그대로 보존하므로(파이썬이 sys.exit(위임코드)), 여기서 exec 하면 그 코드가 이 스크립트의 종료코드가 된다.
#   상태 변이는 위임 스크립트가 lock 잡고 수행(여기선 검증·라우팅만; state.json 미접촉).
exec "$PY" "$HARNESS_ROOT/scripts/lib/a2ui_action.py" "$RID" "$RDIR" "$EVENT"
