#!/usr/bin/env bash
# revise.sh — 현업 보완 요청 (JSON 손편집 대체). feedback.json 기록 후 재생성 루프.
# 사용법: bash scripts/revise.sh <run_id> "이 표현 빼줘" ["target_text"] [--by <행위자id>]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"; shift || true
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 보완요청 전 fail-closed(썩은 인입 위 상태변이 차단)
# 플래그(--by) 먼저 분리, 위치인자(issue·target) 계약 보존. --by = 사람 행위자 → 감사 history.actor.
ISSUE=""; TARGET=""; BY=""; REASON=""; _pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --by)       BY="${2:-}"; shift 2 ;;
    --by=*)     BY="${1#--by=}"; shift ;;
    --reason)   REASON="${2:-}"; shift 2 ;;      # WS-GATES: 멈춤 사유 코드(stop_reason.code)
    --reason=*) REASON="${1#--reason=}"; shift ;;
    *)          if [ "$_pos" -eq 0 ]; then ISSUE="$1"; else TARGET="$1"; fi; _pos=$((_pos + 1)); shift ;;
  esac
done
if [ -n "$BY" ]; then export HARNESS_ACTOR="$BY"; fi
[ -n "$ISSUE" ] || die "보완 내용이 필요합니다. 예: bash scripts/revise.sh $RID \"이 표현 빼줘\""
acquire_lock "$RID"; export HARNESS_LOCK_HELD=1
SF="$(state_file "$RID")"

GATE="$(jget "$SF" gate)"; STATUS="$(jget "$SF" status)"
# 보완(거절/refine)은 사람 게이트(user)뿐 아니라 선택 게이트(select=다안)에서도 허용한다.
#   예: 00g 크롤 참조 노트(단안=user) 보완 · 컨셉/스토리라인 다안(select) '전부 거절 → 재생성'. user→status∈{pending,escalated}; select→status=pending 만
#   (선택 진행 중(selected)에 거절이 끼어드는 race 방지).
if { [ "$GATE" != "user" ] && [ "$GATE" != "select" ]; } \
   || { [ "$GATE" = "user" ] && [ "$STATUS" != "pending" ] && [ "$STATUS" != "escalated" ]; } \
   || { [ "$GATE" = "select" ] && [ "$STATUS" != "pending" ]; }; then
  die "지금은 고쳐 달라고 요청할 차례가 아니에요. run.md 의 '다음 명령'을 확인하세요."
fi

PHASE="$(jget "$SF" phase)"
FB="$(run_dir "$RID")/$PHASE/feedback.json"
mkdir -p "$(dirname "$FB")"
# WS-GATES: feedback 전체를 매 revise 마다 한 번에 원자 작성한다(부분 jset 누적으로 옛 stop_reason 이
#   잔존하던 것 방지). --reason 가 있을 때만 stop_reason 키를 만든다 → 없으면 stale 자체가 불가능.
"$PY" - "$FB" "$TARGET" "$ISSUE" "$REASON" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import atomic_write_json
fb_path, target, issue, reason = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
fb = {"items": [{"target_text": target, "issue": issue, "regulation_ref": None, "suggested_alternative": None}]}
if reason:
    sr = {"code": reason, "summary": issue}
    if target:
        sr["required_fields"] = [target]
    fb["stop_reason"] = sr
atomic_write_json(fb_path, fb)
PYEOF
validate_artifact "$FB" >/dev/null

bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" revise
unset HARNESS_LOCK_HELD; release_lock
ok "보완 요청 기록: $RID — \"$ISSUE\""
