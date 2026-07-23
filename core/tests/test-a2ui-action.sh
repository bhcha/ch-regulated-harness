#!/usr/bin/env bash
# test-a2ui-action.sh — A2UI 액션 브리지(a2ui-action.sh / a2ui-surface.sh) 런타임 회귀 게이트(결정적·오프라인).
#   Stage 3(A2UI surface + action bridge)의 Codex 리뷰 실결함 회귀 봉인:
#     CRITICAL: 사용자 텍스트(comment/by/value)가 위임 스크립트 옵션('--ra-ok'/'--by=')으로 오인돼 RA 승인 우회·
#               감사 행위자 위조되는 것 차단(브리지가 rc2 로 거부, RA_OK 미설정).
#     HIGH-A: 성공·거부 모두 stdout 이 단일 JSON envelope(json.loads 가능) + 위임 exit code 보존.
#     HIGH-B: resume-select 가 브리지로도 복구(select surface + select action 위임 → 게이트 전진).
#     HIGH-1(재리뷰): 위임 출력 디코드/exit 충실성 — 비-UTF8 바이트가 있어도 위임 exit 을 잃지 않고(옛 text=True 는
#               크래시→rc3·delegate=None 오보), 비-0 충실, 신호사망은 128+signal(envelope["exit"]==프로세스 rc), 대용량은 캡처 상한.
#     MED:    허용 action 이 a2ui-catalog.json 이 구동(카탈로그의 해당 surface actions 를 비우면 실제로 사라지고 거부).
#     MED-2(재리뷰): 카탈로그가 '엄격한 상한' — escalated surface 는 [raise-limit] 만 선언(ReviseButton 없음)하므로
#               레거시 gate=user·status=escalated(revise_available=true)여도 revise 를 방출하지 않는다(컴포넌트 없는 action 금지).
#     LOW:    비-문자열 action(dict) 은 traceback 대신 깔끔한 rc2 거부.
#   ⚠ test-agui-contracts.sh 는 카탈로그/스키마 JSON '구조'만 본다(런타임 미구동). 이 파일이 런타임 계약을 본다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## A2UI 액션 브리지 — 주입 차단·JSON envelope·resume 복구·카탈로그 구동(오프라인·no-LLM)"

PY=python3; HP="$ROOT/scripts/lib/harness.py"; CAT="$ROOT/harness/a2ui-catalog.json"
jset(){ $PY "$HP" jset "$ROOT/runs/$1/state.json" "$2" "$3" >/dev/null; }
# 브리지 실행 → 전역 RC/OUT 세팅.
act(){ OUT="$(bash "$ROOT/scripts/a2ui-action.sh" "$1" "$2" 2>/tmp/a2ui_act.err)"; RC=$?; }
# stdout 이 JSON envelope 인지 + 필드값 조회.
is_envelope(){ echo "$OUT" | $PY -c 'import sys,json;d=json.load(sys.stdin);assert set(("ok","action","delegate","exit","message"))<=set(d);print("y")' 2>/dev/null; }
env_field(){ echo "$OUT" | $PY -c "import sys,json;print(json.load(sys.stdin)['$1'])" 2>/dev/null; }
# surface≡next-action 동치(action/options/recommended/revise_available) — 표면↔다음행동 drift 방지(Stage 5 계약). $1=rid → y|n.
#   note: 동치는 이 4필드만 본다(카탈로그-상한이 좌우하는 'actions' set 은 비교 대상 아님 → escalated 에서 revise 를 빼도 동치 불변).
equiv(){ $PY - "$ROOT" "$1" <<'PYEOF'
import subprocess,json,sys
root,rid=sys.argv[1],sys.argv[2]
def run(c): return json.loads(subprocess.run(["bash",c,rid],capture_output=True,text=True,cwd=root).stdout)
a=run("scripts/a2ui-surface.sh"); n=run("scripts/next-action.sh")
print("y" if all(a.get(k)==n.get(k) for k in ("action","options","recommended","revise_available")) else "n")
PYEOF
}
# escalated surface 프로브: $1=rid → "surface|actions|components|revise_available".
esc_probe(){ bash "$ROOT/scripts/a2ui-surface.sh" "$1" | $PY -c 'import sys,json;d=json.load(sys.stdin);print("%s|%s|%s|%s"%(d["surface"],",".join(d["actions"]),",".join(c["component"] for c in d["components"]),d["revise_available"]))'; }

# ── SETUP: 01-brief 승인 게이트(기능성 '승인' 표시 → RA 사후검수 필요) ─────────────────
RID="t-a2ui-brief"; rm -rf "$ROOT/runs/$RID"
bash "$ROOT/scripts/ingest-bundle.sh" "$BUNDLE" "$RID" >/tmp/a2ui_ing.log 2>&1
bash "$ROOT/scripts/run-stage.sh" brief "$RID" >/tmp/a2ui_brief.log 2>&1
check "SETUP: 01-brief 승인 게이트 도달(gate=user/pending)" \
  '[ "$(jq_phase '"$RID"' gate)" = "user" ] && [ "$(jq_phase '"$RID"' status)" = "pending" ]'
APPROVED_SENS="$($PY -c "import json;d=json.load(open('$ROOT/runs/$RID/01-brief/brief.json'));print(sum(1 for s in d.get('sensitive_labels',[]) if s.get('status')=='approved'))")"
check "SETUP: 기능성 '승인' 표시 ≥1건(RA 게이트 활성)" '[ "'"$APPROVED_SENS"'" -ge 1 ]'

# ── CRITICAL: comment='--ra-ok'(ra_ok=false) → RA 우회 주입 차단 ──────────────────────
act "$RID" '{"action":"approve","comment":"--ra-ok","ra_ok":false}'
check "CRITICAL: comment=--ra-ok 는 rc2 거부(위임 안 함)" '[ "'"$RC"'" = "2" ] && [ "$(env_field delegate)" = "None" ]'
check "CRITICAL: 거부 후에도 상태 불변(RA_OK 미설정 → 승인 미전진)" \
  '[ "$(jq_phase '"$RID"' gate)" = "user" ] && [ "$(jq_phase '"$RID"' status)" = "pending" ]'
check "CRITICAL: 거부 stdout 이 JSON envelope(ok=false)" '[ "$(is_envelope)" = "y" ] && [ "$(env_field ok)" = "False" ]'

# ── CRITICAL: 감사 행위자(by) 위조 차단 ────────────────────────────────────────────
act "$RID" '{"action":"approve","comment":"--by=forged"}'
check "CRITICAL: comment=--by=forged 위조 차단(rc2)" '[ "'"$RC"'" = "2" ]'
act "$RID" '{"action":"approve","by":"--ra-ok","ra_ok":true}'
check "CRITICAL: by=--ra-ok 위조 차단(rc2)" '[ "'"$RC"'" = "2" ]'

# ── CRITICAL/HIGH-A: 정당한 ra_ok=true → 승인 전진 + JSON envelope(exit=0) ──────────────
act "$RID" '{"action":"approve","ra_ok":true}'
check "LEGIT: ra_ok=true 는 승인 전진(rc0)" '[ "'"$RC"'" = "0" ]'
check "HIGH-A: 성공 stdout 이 JSON envelope(ok=true, exit=0, delegate=approve.sh)" \
  '[ "$(is_envelope)" = "y" ] && [ "$(env_field ok)" = "True" ] && [ "$(env_field exit)" = "0" ] && [ "$(env_field delegate)" = "approve.sh" ]'
check "LEGIT: 승인 후 심의 게이트로 전진(gate=review)" '[ "$(jq_phase '"$RID"' gate)" = "review" ]'

# ── LOW: 비-문자열 action → traceback 아닌 깔끔한 rc2 ──────────────────────────────────
act "$RID" '{"action":{"x":1}}'
check "LOW: dict action 은 rc2 깔끔 거부(traceback 아님)" \
  '[ "'"$RC"'" = "2" ] && [ "$(is_envelope)" = "y" ] && ! grep -q "Traceback" /tmp/a2ui_act.err'

# ── HIGH-1(Codex 재리뷰): 위임 출력 디코드/exit 충실성 — _delegate_result seam 직접 검증(no-LLM) ──
#   비-UTF8 바이트가 있어도 위임 exit 을 '잃지 않음'(옛 text=True 는 그 바이트에서 크래시→rc3·delegate=None 오보),
#   비-0 충실, 신호사망은 128+signal 로 envelope["exit"]==프로세스 rc 일치, 대용량 출력은 캡처 상한(OOM 방지).
DR="$($PY - "$ROOT" <<'PYEOF'
import sys, os, json
sys.path.insert(0, os.path.join(sys.argv[1], "scripts", "lib"))
os.environ.setdefault("HARNESS_ROOT", sys.argv[1])
import a2ui_action as B
def one(argv):
    ok, dele, code, msg = B._delegate_result(argv)
    return {"ok": ok, "exit": code, "msg_is_str": isinstance(msg, str),
            "capped": len(msg) <= B._READ_CAP + 128, "bounded": len(msg) < 5000000}
print(json.dumps({
    "utf8":    one(["bash", "-c", "printf 'good\\xff\\xfebye'; exit 0"]),                 # 비-UTF8 + exit 0
    "nonzero": one(["bash", "-c", "printf err; exit 7"]),                                 # 비-0 충실
    "signal":  one(["bash", "-c", "kill -TERM $$"]),                                       # 신호사망 → 128+15=143
    "huge":    one(["bash", "-c", "head -c 5000000 /dev/zero | tr '\\0' A; exit 0"]),      # 대용량 → 캡처 상한
}))
PYEOF
)"
dr(){ echo "$DR" | $PY -c "import sys,json;print(json.load(sys.stdin)['$1']['$2'])" 2>/dev/null; }
check "HIGH-1: 비-UTF8 바이트+exit0 위임 → ok=true·exit=0 (위임 exit 안 잃음, 디코드 크래시 없음)" \
  '[ "$(dr utf8 ok)" = "True" ] && [ "$(dr utf8 exit)" = "0" ] && [ "$(dr utf8 msg_is_str)" = "True" ]'
check "HIGH-1: 비-0 종료 위임 → exit 충실(ok=false·exit=7)" \
  '[ "$(dr nonzero ok)" = "False" ] && [ "$(dr nonzero exit)" = "7" ]'
check "HIGH-1: 신호사망(SIGTERM) 위임 → 128+signal 매핑(exit=143, envelope==프로세스 rc)" \
  '[ "$(dr signal ok)" = "False" ] && [ "$(dr signal exit)" = "143" ]'
check "HIGH-1: 대용량(5MB) 출력 위임 → 캡처 상한(OOM 방지)·exit=0" \
  '[ "$(dr huge exit)" = "0" ] && [ "$(dr huge capped)" = "True" ] && [ "$(dr huge bounded)" = "True" ]'

# ── SETUP: 02-concept 선택 게이트 ──────────────────────────────────────────────────
SID="t-a2ui-sel"; seed_fixture concept "$SID"
bash "$ROOT/scripts/run-stage.sh" concept "$SID" >/tmp/a2ui_gen.log 2>&1
check "SETUP: 02-concept 선택 게이트 도달(gate=select/pending)" \
  '[ "$(jq_phase '"$SID"' gate)" = "select" ] && [ "$(jq_phase '"$SID"' status)" = "pending" ]'

# 표면↔next-action 동치(#1 select/pending).
check "동치[1/4]: a2ui-surface ≡ next-action @select/pending" '[ "$(equiv '"$SID"')" = "y" ]'

# ── 거부군: 잘못된 게이트·미지 action·없는 옵션·flaglike·revise 방향누락·비-escalated raise-limit ──
act "$SID" '{"action":"approve"}';            check "REJECT: 선택 게이트에서 approve(rc2)"        '[ "'"$RC"'" = "2" ] && [ "$(is_envelope)" = "y" ]'
act "$SID" '{"action":"frobnicate"}';         check "REJECT: 미지 action(rc2)"                    '[ "'"$RC"'" = "2" ]'
act "$SID" '{"action":"select","value":"ZZ"}';check "REJECT: 없는 옵션키(rc2)"                     '[ "'"$RC"'" = "2" ]'
act "$SID" '{"action":"select","value":"--x"}';check "REJECT: flaglike value=--x(rc2)"             '[ "'"$RC"'" = "2" ]'
act "$SID" '{"action":"revise"}';             check "REJECT: revise 방향 누락(rc2)"                '[ "'"$RC"'" = "2" ]'
act "$SID" '{"action":"raise-limit"}';        check "REJECT: 비-escalated raise-limit(rc2)"        '[ "'"$RC"'" = "2" ]'
check "REJECT군: 상태 불변(부작용 없음)" \
  '[ "$(jq_phase '"$SID"' gate)" = "select" ] && [ "$(jq_phase '"$SID"' status)" = "pending" ]'

# ── HIGH-A round-trip: select 위임 성공 → JSON envelope + 게이트 전진(직접 스크립트와 동치) ──
act "$SID" '{"action":"select","value":"B"}'
check "ROUND-TRIP: select 위임 성공(rc0) + envelope(delegate=select.sh)" \
  '[ "'"$RC"'" = "0" ] && [ "$(env_field ok)" = "True" ] && [ "$(env_field delegate)" = "select.sh" ]'
check "HIGH-1: 정상 종료 위임의 envelope[exit] == 브리지 프로세스 rc(둘 불일치 없음)" \
  '[ "$(env_field exit)" = "'"$RC"'" ] && [ "$(env_field error)" = "None" ]'
check "ROUND-TRIP: select 후 게이트 전진(select→review)" '[ "$(jq_phase '"$SID"' gate)" = "review" ]'

# ── HIGH-B: resume-select 브리지 복구(중단 후 select surface 로 매핑 → 위임 재개) ────────────
#   방금 select 로 review 로 갔으니 gate=select/status=selected 로 되돌려 중단 상황 재현(decision.json 존재).
jset "$SID" gate '"select"'; jset "$SID" status '"selected"'
SURF_ACT="$(bash "$ROOT/scripts/a2ui-surface.sh" "$SID" | $PY -c 'import sys,json;d=json.load(sys.stdin);print(d["action"],d["surface"],",".join(d["actions"]))')"
check "HIGH-B: resume-select → surface=select, actions 에 select 포함" \
  '[ "$SURF_ACT" = "resume-select select select" ]'
check "동치[2/4]: a2ui-surface ≡ next-action @resume-select(selected)" '[ "$(equiv '"$SID"')" = "y" ]'
act "$SID" '{"action":"select"}'   # value 없이(중단 복구) — select.sh 가 전이만 재개
check "HIGH-B: resume-select 브리지 복구 성공(rc0)" '[ "'"$RC"'" = "0" ]'
check "HIGH-B: 복구 후 selected/select 벗어남(전이 재개)" \
  '! { [ "$(jq_phase '"$SID"' gate)" = "select" ] && [ "$(jq_phase '"$SID"' status)" = "selected" ]; }'

# ── MED: 허용 action 은 카탈로그가 구동 — select surface actions 를 비우면 select 가 사라지고 거부 ──
cp "$CAT" "$CAT.tbak"
$PY - "$CAT" <<'PYEOF'
import json,sys
p=sys.argv[1]; c=json.load(open(p)); c["surfaces"]["select"]["actions"]=[]
json.dump(c,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
MID="t-a2ui-med"; seed_fixture concept "$MID"
bash "$ROOT/scripts/run-stage.sh" concept "$MID" >/tmp/a2ui_med.log 2>&1
MED_ACTS="$(bash "$ROOT/scripts/a2ui-surface.sh" "$MID" | $PY -c 'import sys,json;print(json.load(sys.stdin)["actions"])')"
act "$MID" '{"action":"select","value":"B"}'; MED_RC=$RC
cp "$CAT.tbak" "$CAT"; rm -f "$CAT.tbak"    # 원상복구(반드시)
check "MED: 카탈로그 select.actions 를 비우면 a2ui actions=[] (카탈로그 구동)" '[ "$MED_ACTS" = "[]" ]'
check "MED: 그 상태에서 select 는 브리지가 거부(rc2, 카탈로그 강제)" '[ "'"$MED_RC"'" = "2" ]'
RESTORED="$($PY -c "import json;print(json.load(open('$CAT'))['surfaces']['select']['actions'])")"
check "MED: 카탈로그 원상복구됨(select.actions=['select','revise'])" "[ \"$RESTORED\" = \"['select', 'revise']\" ]"

# ── MED-2(Codex 재리뷰): escalated surface = 카탈로그 '엄격한 상한' — 컴포넌트 없는 action(revise) 방출 금지 ──
#   실 런타임 escalated = gate=review·status=escalated(revise_available=false) → actions=[raise-limit]·ReviseButton 없음(Stage1 불변).
#   레거시(합성) gate=user·status=escalated 는 revise_available=true 여도 카탈로그 escalated 가 revise 를 안 실으니 revise 미방출.
EID="t-a2ui-esc"; seed_fixture concept "$EID"
bash "$ROOT/scripts/run-stage.sh" concept "$EID" >/tmp/a2ui_esc.log 2>&1   # gate=select/pending
jset "$EID" gate '"review"'; jset "$EID" status '"escalated"'             # 실 런타임 escalated
ESC_REAL="$(esc_probe "$EID")"
check "MED-2: 실 escalated(gate=review) → surface=escalated·actions=raise-limit·ReviseButton 없음·revise_available=False (Stage1 불변)" \
  '[ "$ESC_REAL" = "escalated|raise-limit|Text,ApproveButton|False" ]'
check "동치[3/4]: a2ui-surface ≡ next-action @escalated(gate=review)" '[ "$(equiv '"$EID"')" = "y" ]'
jset "$EID" gate '"user"'; jset "$EID" status '"escalated"'              # 레거시(합성) escalated — revise_available=true
ESC_LEG="$(esc_probe "$EID")"
check "MED-2: 레거시 escalated(gate=user·revise_available=True)여도 revise/ReviseButton 미방출(카탈로그 상한, 컴포넌트 없는 action 금지)" \
  '[ "$ESC_LEG" = "escalated|raise-limit|Text,ApproveButton|True" ]'
check "동치[4/4]: a2ui-surface ≡ next-action @escalated(gate=user, 레거시)" '[ "$(equiv '"$EID"')" = "y" ]'
# 카탈로그 escalated.actions=[] → raise-limit 조차 사라짐(actions=[]) + revise 절대 없음 + 컴포넌트 없는 action 없음.
cp "$CAT" "$CAT.tbak"
$PY - "$CAT" <<'PYEOF'
import json,sys
p=sys.argv[1]; c=json.load(open(p)); c["surfaces"]["escalated"]["actions"]=[]
json.dump(c,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
ESC_EMPTY="$(esc_probe "$EID")"
cp "$CAT.tbak" "$CAT"; rm -f "$CAT.tbak"    # 원상복구(반드시 · byte-identical)
check "MED-2: 카탈로그 escalated.actions=[] → a2ui actions=[] (raise-limit 조차 사라짐, revise 없음)" \
  '[ "${ESC_EMPTY%%|*}" = "escalated" ] && [ "$(echo "$ESC_EMPTY" | cut -d"|" -f2)" = "" ]'
RESTORED_ESC="$($PY -c "import json;print(json.load(open('$CAT'))['surfaces']['escalated']['actions'])")"
check "MED-2: 카탈로그 escalated 원상복구됨(actions=['raise-limit'])" "[ \"$RESTORED_ESC\" = \"['raise-limit']\" ]"

# 정리(테스트 산출 run 은 결정적 재생성 가능 — 골든 무영향).
rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$SID" "$ROOT/runs/$MID" "$ROOT/runs/$EID" 2>/dev/null || true

printf '\n[a2ui-action] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
