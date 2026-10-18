#!/usr/bin/env bash
# test-b8.sh — 00g 유사점 3안 '전부 거절 → 재생성(+자유텍스트 refine)' 게이트 + 에스컬레이션 복구(raise-limit).
#   '다시 제안'(전부 거절 → 재생성·자유텍스트 refine) 흐름의 하네스측 계약을 결정적으로 검증.
#   엔진은 stub(결정적); 자유텍스트의 '내용 반영'은 실엔진에서만 일어나므로 여기선 '배선(인라인 경로)'만 검증한다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B8 — 00g reject-all → regenerate (+free-text refine) + escalation recovery"

RID="ci-b8"
EXROOT="$(mktemp -d)"; mkdir -p "$EXROOT/cosmetic"; cp -r "$BUNDLE" "$EXROOT/cosmetic/ex1"
cleanup() { rm -rf "$ROOT/runs/$RID" "$EXROOT"; }
trap cleanup EXIT
rm -rf "$ROOT/runs/$RID"
G="$ROOT/runs/$RID/00g-guideline"

export HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$EXROOT"

# ── 00g 크롤 참조 노트 → 승인(단안) 게이트 (M4: 생성 직후 approve; 심의는 승인 뒤). 구 '유사점 3안 select' 파기. ──
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" \
  && bash scripts/run-stage.sh guideline "$RID" ) >/dev/null 2>&1
[ "$(jq_phase "$RID" gate)" = "user" ] && pass "00g 크롤 참조 노트 → 승인(단안) 게이트 도달" || fail "승인 게이트 도달 실패(gate=$(jq_phase "$RID" gate))"
[ -f "$G/reference-notes.json" ] && pass "크롤 참조 노트 생성" || fail "참조 노트 누락"
ITER0="$(jq_phase "$RID" iteration)"

# ── next-action.sh: 어댑터가 승인/보완 버튼을 렌더할 구조화 상태(action=approve + 보완 가용) ──
NA="$( cd "$ROOT" && bash scripts/next-action.sh "$RID" )"
echo "$NA" | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d['action']=='approve' and d['revise_available'] else 1)" 2>/dev/null \
  && pass "next-action.sh: 승인 게이트 → action=approve + 보완(revise) 가용" || fail "next-action.sh approve 출력 비정상: $NA"

# ── 보완/거절(직접 입력): user 게이트에서 revise 가 죽지 않고 재생성으로 전이 ──
( cd "$ROOT" && bash scripts/revise.sh "$RID" "이 플로우 말고 더 감성적인 참조로 다시" "reference" ) >/dev/null 2>&1 \
  && pass "user 게이트에서 revise(보완/직접입력) 허용" || fail "user 게이트 revise 거부됨"
[ -f "$G/feedback.json" ] && pass "보완 자유텍스트 feedback.json 기록" || fail "feedback.json 미기록"
{ [ "$(jq_phase "$RID" step)" = "generate" ] && [ "$(jq_phase "$RID" status)" = "changes_requested" ]; } \
  && pass "보완 → step=generate/status=changes_requested 전이" || fail "보완 전이 비정상(step=$(jq_phase "$RID" step) status=$(jq_phase "$RID" status))"
[ "$(jq_phase "$RID" iteration)" -gt "$ITER0" ] && pass "iteration 증가(보완 카운트)" || fail "iteration 미증가"

# ── 자유텍스트가 build_context FEEDBACK 로 '인라인'되는지(실엔진 재생성이 받는 입력 경로) ──
FBOUT="$( source "$ROOT/scripts/lib/common.sh"; build_context "$RID" guideline 2>/dev/null )" || true
case "$FBOUT" in
  *"더 감성적인 참조"*) pass "build_context FEEDBACK 에 보완 자유텍스트 인라인(실엔진 입력 경로)";;
  *) fail "FEEDBACK 인라인 누락(자유텍스트가 재생성 프롬프트로 안 흘러감)";;
esac

# ── 재생성: stale 참조노트 폐기(history 보존) 후 새 참조노트 → 다시 승인 (M4: 승인 전이라 심의 없음) ──
( cd "$ROOT" && bash scripts/run-stage.sh guideline "$RID" ) >/dev/null 2>&1
{ [ -f "$G/reference-notes.json" ] && [ "$(jq_phase "$RID" gate)" = "user" ]; } \
  && pass "재생성 → 참조노트 재작성 → 승인 게이트 복귀" || fail "재생성 후 승인 복귀 실패(gate=$(jq_phase "$RID" gate))"
# M5(G2): 거절된 옛 라운드(참조노트)가 rm 되지 않고 history/iter-N 으로 보존(부록A 감사추적).
B8HIST="$(ls -d "$G"/history/iter-* 2>/dev/null | head -1)"
{ [ -n "$B8HIST" ] && [ -f "$B8HIST/reference-notes.json" ]; } \
  && pass "거절된 옛 참조노트 history/iter-N 보존(감사추적, M5)" || fail "거절 라운드 history 보존 안 됨(HIST=$B8HIST)"

# ── 에스컬레이션: 상한까지 보완 → escalated(무한 재생성 방지) ──
n=0
while [ "$(jq_phase "$RID" status)" != "escalated" ] && [ "$n" -lt 6 ]; do
  ( cd "$ROOT" && bash scripts/revise.sh "$RID" "또 다른 참조로 다시" ) >/dev/null 2>&1 || true
  if [ "$(jq_phase "$RID" status)" = "changes_requested" ]; then
    ( cd "$ROOT" && bash scripts/run-stage.sh guideline "$RID" ) >/dev/null 2>&1 || true
  fi
  n=$((n+1))
done
[ "$(jq_phase "$RID" status)" = "escalated" ] && pass "상한까지 보완 → escalated(무한 재생성 방지)" || fail "escalated 미도달(status=$(jq_phase "$RID" status))"
echo "$( cd "$ROOT" && bash scripts/next-action.sh "$RID" )" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin)['action']=='raise-limit' else 1)" 2>/dev/null \
  && pass "next-action.sh: escalated → action=raise-limit(복구 안내)" || fail "next-action.sh escalated→raise-limit 미반영"

# ── 복구: raise-limit → 재생성 → 승인 게이트 복귀 (M4: 승인 전이라 심의 없음) ──
( cd "$ROOT" && bash scripts/run-stage.sh raise-limit "$RID" \
  && bash scripts/run-stage.sh guideline "$RID" ) >/dev/null 2>&1
[ "$(jq_phase "$RID" gate)" = "user" ] && pass "escalated → raise-limit → 재생성 → 승인 복귀" || fail "escalated 복구 실패(gate=$(jq_phase "$RID" gate))"

# ── 회귀 + --by 감사: 승인(approve)에 --by 동반 + 사람 행위자가 history.actor 에 기록 ──
# M4: 승인(--by) → 심의(kcia-check) 통과 → 01-brief 전진.
( cd "$ROOT" && bash scripts/approve.sh "$RID" --ra-ok --by user:U-tester && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
[ "$(jq_phase "$RID" phase)" = "01-brief" ] && pass "정상 승인(--by 동반)+심의 통과 → 01-brief 전진" || fail "01-brief 전진 실패(실제 $(jq_phase "$RID" phase))"
python3 -c "
import json,sys
h=json.load(open('$ROOT/runs/$RID/state.json'))['history']
sys.exit(0 if any(e.get('actor')=='user:U-tester' for e in h) else 1)" 2>/dev/null \
  && pass "--by: 사람 행위자(user:U-tester)가 history.actor 기록" || fail "--by actor 미기록"

echo "B8: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
