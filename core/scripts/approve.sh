#!/usr/bin/env bash
# approve.sh — 현업 승인 (JSON 손편집 대체). 설계 §10.3 + B1 (e+) 민감표시 RA 게이트.
# 사용법: bash scripts/approve.sh <run_id> ["코멘트"] [--ra-ok] [--by <행위자id>]
#   --ra-ok (또는 env KCIA_RA_OK=1): 기능성 '승인' 표시에 대한 RA 사후검수 확인(fail-closed 해제).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"; shift || true
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 승인 전 fail-closed(썩은 인입 위 상태변이 차단)
# 플래그를 먼저 분리(위치인자 코멘트 보존). --by = 사람 행위자(Slack user 등) → 감사 history.actor.
COMMENT="승인"; RA_OK="${KCIA_RA_OK:-0}"; BY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ra-ok) RA_OK=1; shift ;;
    --by)    BY="${2:-}"; shift 2 ;;
    --by=*)  BY="${1#--by=}"; shift ;;
    *)       COMMENT="$1"; shift ;;
  esac
done
if [ -n "$BY" ]; then export HARNESS_ACTOR="$BY"; fi
lock_acquire "$RID"
SF="$(state_file "$RID")"

GATE="$(jget "$SF" gate)"; STATUS="$(jget "$SF" status)"; PHASE="$(jget "$SF" phase)"

# 중단 복구: 직전 승인이 status=approved 까지 커밋됐으나 게이트 전이 전 중단된 경우(레거시) → 전이만 재개.
#   M4: approve→review 는 gate.sh 한 atomic 전이라 보통 이 창은 없으나, 레거시 'approved+user' 상태를 안전 전이.
if [ "$STATUS" = "approved" ] && [ "$GATE" = "user" ]; then
  # fail-closed: 01-brief 의 기능성 '승인' 표시는 RA 확인(--ra-ok 또는 기존 확인기록)이 있어야 재개 가능.
  if [ "$PHASE" = "01-brief" ]; then
    CONF="$(run_dir "$RID")/01-brief/sensitive-confirmation.json"
    CONF_RA="$([ -f "$CONF" ] && "$PY" -c "import json;print(json.load(open('$CONF')).get('ra_reviewed') is True)" 2>/dev/null || echo False)"
    APPROVED_SENS="$("$PY" -c "import json
try:
  d=json.load(open('$(run_dir "$RID")/01-brief/brief.json'))
  print(sum(1 for s in d.get('sensitive_labels',[]) if s['status']=='approved'))
except Exception: print(0)")"
    if [ "${APPROVED_SENS:-0}" -gt 0 ] && [ "$RA_OK" != "1" ] && [ "$CONF_RA" != "True" ]; then
      die "이어서 승인하려 해도 담당자(RA) 확인이 필요해요(RA 사후검수). 확인이 끝나면 운영자가 처리합니다: bash scripts/approve.sh $RID --ra-ok"
    fi
  fi
  info "직전 승인이 중단되었습니다 — 심의 게이트 전이를 재개합니다."
  bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" approve
  lock_release; ok "승인 전이 재개 완료: $RID"; exit 0
fi
if [ "$GATE" != "user" ] || { [ "$STATUS" != "pending" ] && [ "$STATUS" != "escalated" ]; }; then
  die "지금은 승인할 차례가 아니에요. run.md 의 '다음 명령'을 확인하세요."
fi

# ── 00a-intake: 첨부 분류 승인 초크 (fail-closed) — unknown 잔존 또는 스냅샷 sha256 불일치면 승인 거부 ──
#   분류는 제안, 확정은 사람(불변식 1): '판단 불가'가 남아있으면 하류(00-ingest 라우팅)로 나가지 못한다.
#   sha256 대조 = 스냅샷 원본이 승인 시점과 동일한지(제안 작성 후 변조 감지). validate-stage 커버리지와 이중(심층방어).
if [ "$PHASE" = "00a-intake" ]; then
  PROP="$(run_dir "$RID")/00a-intake/intake-proposal.json"
  [ -f "$PROP" ] || die "첨부 분류 제안이 아직 없어요 — 먼저 bash scripts/run-stage.sh intake $RID 로 분류를 만드세요."
  _APRC="$("$PY" -c "
import os,json,sys,hashlib
rdir='$(run_dir "$RID")'
prop=json.load(open(os.path.join(rdir,'00a-intake','intake-proposal.json')))
adir=os.path.join(rdir,'inputs','attachments')
unknown=[]; mism=[]
for f in (prop.get('files') or []):
    if f.get('category')=='unknown': unknown.append(f.get('filename'))
    fp=os.path.join(adir, f.get('filename') or '')
    try:
        h=hashlib.sha256(open(fp,'rb').read()).hexdigest()
    except Exception:
        mism.append(f.get('filename')); continue
    if h!=f.get('sha256'): mism.append(f.get('filename'))
if unknown: print('UNKNOWN:'+', '.join(x or '?' for x in unknown)); sys.exit(2)
if mism: print('MISMATCH:'+', '.join(x or '?' for x in mism)); sys.exit(3)
print('OK'); sys.exit(0)" 2>/dev/null)"; _APST=$?
  if [ "$_APST" = "2" ]; then
    die "아직 '판단 불가'로 남은 첨부가 있어요(${_APRC#UNKNOWN:}) — 그대로는 승인할 수 없어요. 어느 파일을 무엇으로 볼지 정해 다시 분류하세요: bash scripts/revise.sh $RID \"어느 파일을 무엇으로\""
  elif [ "$_APST" = "3" ]; then
    die "첨부 원본이 분류 제안 작성 이후 바뀌었어요(${_APRC#MISMATCH:}) — 안전을 위해 승인을 멈췄어요. 다시 분류하세요: bash scripts/run-stage.sh intake $RID"
  elif [ "$_APST" != "0" ]; then
    die "첨부 분류 제안을 확인하지 못했어요 — 다시 분류하세요: bash scripts/run-stage.sh intake $RID"
  fi
  # ★ 외부리뷰 W4-R8: unknown·sha256 뿐 아니라 '전체 00a 검증'을 승인 직전에 재실행 — 생성 후 gate=user 에서 제안이 편집되거나
  #   변환본이 삭제돼 시맨틱 전제(워킹백워드 분류·변환본·category/kind·category/route 일관성)가 깨지면 여기서 막는다.
  #   (안 막으면 gate=review 로 넘어간 뒤 kcia-check 가 실패하는데 그 게이트에선 revise 불가 → wedge.) generate·approve 동일 검증.
  bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 00a-intake >/dev/null 2>&1 \
    || die "첨부 분류 제안이 요건을 못 갖췄어요(워킹백워드 분류·변환본·분류/성격·경로 일관성 등) — 고칠 게 있으면 다시 분류하세요: bash scripts/revise.sh $RID \"고칠 내용\""
fi

# ── B1 (e+): 브리프 민감표시 확인 게이트 + RA 사후검수 (fail-closed) ──
if [ "$PHASE" = "01-brief" ]; then
  BRIEF="$(run_dir "$RID")/01-brief/brief.json"
  APPROVED_SENS="$("$PY" -c "import json,sys
try:
  d=json.load(open('$BRIEF'))
  n=sum(1 for s in d.get('sensitive_labels',[]) if s['status']=='approved')
  print(n)
except Exception: print(0)")"
  if [ "${APPROVED_SENS:-0}" -gt 0 ] && [ "$RA_OK" != "1" ]; then
    err "기능성 '승인'으로 표시된 항목이 ${APPROVED_SENS}건 있어요. 담당자(RA) 확인을 거쳐야 승인돼요(RA 사후검수)."
    die "담당자 확인이 끝나면 운영자가 처리합니다: bash scripts/approve.sh $RID --ra-ok"
  fi
  # 확인 기록 (감사 추적)
  "$PY" - "$(run_dir "$RID")/01-brief/sensitive-confirmation.json" "$BRIEF" "$RA_OK" "${BY:-}" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
out, brief, ra, actor = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
b = load_json(brief)
labels = b.get("sensitive_labels", [])
rec = {
    "confirmed": True, "ra_reviewed": ra,
    "labels": labels, "confirmed_at": now_iso(),
}
if actor:
    rec["approved_by"] = actor
    if ra:
        rec["ra_reviewed_by"] = actor   # RA 사후검수 확인자(누가 --ra-ok 했나) — 감사 추적
atomic_write_json(out, rec)
PYEOF
  append_history "$SF" "01-brief" "sensitive:confirmed:ra=$RA_OK" "approve.sh"
fi

# plan 블록 승인 시 approval_state 갱신(있으면)
if [ "$PHASE" = "03-storyboard" ] && [ -d "$(run_dir "$RID")/03-storyboard/plan" ]; then
  "$PY" - "$(run_dir "$RID")/03-storyboard/plan" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json
pdir = sys.argv[1]
for fn in os.listdir(pdir):
    if fn.endswith(".json"):
        p = os.path.join(pdir, fn); b = load_json(p)
        if b.get("approval_state") in ("draft", "review_passed"):
            b["approval_state"] = "human_approved"; atomic_write_json(p, b)
PYEOF
fi

# 키비주얼 최종 승인 (M4/C3 fail-closed): 선택안 기준 재렌더 → 저작권·구성요소 재검증 **까지만**(심의 前).
#   export(협회 패키지)는 심의 통과 뒤 gate.sh review-pass 에서 1회(승인만으로 미심의 패키지 생성 차단).
if [ "$PHASE" = "04-keyvisual" ]; then
  SEL="$(jget "$(run_dir "$RID")/04-keyvisual/decision.json" selected 2>/dev/null || true)"
  if [ -n "$SEL" ]; then
    # 선택안(예: B)으로 매니페스트 재생성 — 미리보던 추천안과 다를 수 있으므로 선택안을 실제 검증(외부리뷰 coverage #1)
    bash "$HARNESS_ROOT/scripts/render-design.sh" "$RID" --option "$SEL" >/dev/null \
      || die "선택안($SEL) 렌더 실패 — 승인 보류."
    bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 04-keyvisual >/dev/null 2>&1 \
      || { bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 04-keyvisual || true
           die "선택안($SEL) 검증 실패(저작권/구성요소) — 승인 보류. 위 항목을 보완하세요."; }
  fi
fi

bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" approve
lock_release
ok "승인 완료: $RID — $COMMENT"
sed -n '1,8p' "$(run_dir "$RID")/run.md" 2>/dev/null || true
