#!/usr/bin/env bash
# test-a2ui-surface.sh — A2UI surface 파생(scripts/a2ui-surface.sh) + 액션 브리지(scripts/a2ui-action.sh) 회귀 게이트
#   (결정적·오프라인·no-LLM·골든 무영향). Stage 5 계약 봉인:
#     1) surface ≡ next-action 동치: ≥3 게이트 상태(select@02-concept · user/approve@01-brief · escalated)에서
#        surface 의 action·options·recommended·revise_available 가 next-action.sh 와 정확히 같다(세 표면 drift 방지).
#     2) 브리지 위임: select/approve/revise ClientEvent 가 올바른 4동작 스크립트로 위임되고, 결과 state.json 이
#        직접 호출(select.sh/approve.sh/revise.sh)과 동일하다(타임스탬프·workflow_id 제외 deep-equal).
#     3) 거부(rc≠0·부작용 없음): 현재 게이트에 안 맞는 action · 미지 action · 없는 옵션키 · 방향 없는 revise ·
#        비-문자열 action · 플래그 주입({"action":"approve","comment":"--ra-ok","ra_ok":false} 은 RA_OK 승격 금지).
#     4) 성공 stdout = json 으로 파싱되는 단일 JSON envelope(Stage 3 계약).
#     5) a2ui-surface 는 읽기전용(아무것도 쓰지 않음) + 쓰기가능 임시파일 불요(Stage 3 이 heredoc 제거).
#   ⚠ test-a2ui-action.sh 는 브리지의 주입차단·envelope·resume·카탈로그 구동을 본다. 이 파일은 surface≡next-action
#     동치와 surface 읽기전용을 정조준한다(중복이 아니라 상보적 회귀 봉인).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## A2UI surface — surface≡next-action 동치·위임=직접호출·거부(부작용0)·envelope·읽기전용(오프라인·no-LLM)"

PY=python3; HP="$ROOT/scripts/lib/harness.py"
jset(){ $PY "$HP" jset "$ROOT/runs/$1/state.json" "$2" "$3" >/dev/null; }
# 브리지 실행 → 전역 RC/OUT.
act(){ OUT="$(bash "$ROOT/scripts/a2ui-action.sh" "$1" "$2" 2>/tmp/a2ui_surf_act.err)"; RC=$?; }
is_envelope(){ echo "$OUT" | $PY -c 'import sys,json;d=json.load(sys.stdin);assert set(("ok","action","delegate","exit","message"))<=set(d);print("y")' 2>/dev/null; }
env_field(){ echo "$OUT" | $PY -c "import sys,json;print(json.load(sys.stdin)['$1'])" 2>/dev/null; }
# surface≡next-action 동치(action·options·recommended·revise_available) — 세 표면 drift 방지(Stage 5 계약).
#   동치는 이 4필드만 본다(카탈로그-상한이 좌우하는 actions set 은 비교 대상 아님 — test-a2ui-action.sh 주석과 동일 계약).
equiv(){ $PY - "$ROOT" "$1" <<'PYEOF'
import subprocess,json,sys
root,rid=sys.argv[1],sys.argv[2]
def run(c): return json.loads(subprocess.run(["bash",c,rid],capture_output=True,text=True,cwd=root).stdout)
a=run("scripts/a2ui-surface.sh"); n=run("scripts/next-action.sh")
print("y" if all(a.get(k)==n.get(k) for k in ("action","options","recommended","revise_available")) else "n")
PYEOF
}
# 정규화 state(휘발성 ts·updated_at·workflow_id 제거) — 브리지 vs 직접호출 deep-equal 비교용.
norm_state(){ $PY -c "
import json
d=json.load(open('$ROOT/runs/$1/state.json'))
d.pop('updated_at',None); d.pop('workflow_id',None)
for h in d.get('history',[]): h.pop('ts',None)
print(json.dumps(d,sort_keys=True,ensure_ascii=False))
"; }
# surface 필드 조회.
surf(){ bash "$ROOT/scripts/a2ui-surface.sh" "$1" | $PY -c "import sys,json;print(json.load(sys.stdin)['$2'])"; }

# ── SETUP: 3개 게이트 상태 ─────────────────────────────────────────────────────────
CID="t-surf-sel"; seed_fixture concept "$CID"
bash "$ROOT/scripts/run-stage.sh" concept "$CID" >/tmp/a2ui_surf_c.log 2>&1
check "SETUP: 02-concept 선택 게이트(gate=select/pending)" \
  '[ "$(jq_phase '"$CID"' gate)" = "select" ] && [ "$(jq_phase '"$CID"' status)" = "pending" ]'

BID="t-surf-appr"; rm -rf "$ROOT/runs/$BID"
bash "$ROOT/scripts/ingest-bundle.sh" "$BUNDLE" "$BID" >/tmp/a2ui_surf_ing.log 2>&1
bash "$ROOT/scripts/run-stage.sh" brief "$BID" >/tmp/a2ui_surf_b.log 2>&1
check "SETUP: 01-brief 승인 게이트(gate=user/pending)" \
  '[ "$(jq_phase '"$BID"' gate)" = "user" ] && [ "$(jq_phase '"$BID"' status)" = "pending" ]'

EID="t-surf-esc"; seed_fixture concept "$EID"
bash "$ROOT/scripts/run-stage.sh" concept "$EID" >/tmp/a2ui_surf_e.log 2>&1
jset "$EID" gate '"review"'; jset "$EID" status '"escalated"'   # 실 런타임 escalated(gate=review·status=escalated)
check "SETUP: escalated 상태(gate=review/escalated)" \
  '[ "$(jq_phase '"$EID"' gate)" = "review" ] && [ "$(jq_phase '"$EID"' status)" = "escalated" ]'

# ── 1) surface ≡ next-action 동치(3 게이트) ─────────────────────────────────────────
check "동치[1/3]: a2ui-surface ≡ next-action @select(02-concept)" '[ "$(equiv '"$CID"')" = "y" ]'
check "동치[2/3]: a2ui-surface ≡ next-action @approve(01-brief)" '[ "$(equiv '"$BID"')" = "y" ]'
check "동치[3/3]: a2ui-surface ≡ next-action @escalated" '[ "$(equiv '"$EID"')" = "y" ]'
# 각 게이트 surface 유형이 기대와 맞는지(동치가 우연히 둘 다 틀려 성립하는 것 방지).
check "동치 보강: select 게이트 surface=select·action=select" \
  '[ "$(surf '"$CID"' surface)" = "select" ] && [ "$(surf '"$CID"' action)" = "select" ]'
check "동치 보강: approve 게이트 surface=approve·action=approve" \
  '[ "$(surf '"$BID"' surface)" = "approve" ] && [ "$(surf '"$BID"' action)" = "approve" ]'
check "동치 보강: escalated surface=escalated·action=raise-limit·revise_available=False" \
  '[ "$(surf '"$EID"' surface)" = "escalated" ] && [ "$(surf '"$EID"' action)" = "raise-limit" ] && [ "$(surf '"$EID"' revise_available)" = "False" ]'

# ── 5) a2ui-surface 읽기전용 + 쓰기가능 임시파일 불요 ─────────────────────────────────
SHASH1="$($PY -c "import hashlib;print(hashlib.sha256(open('$ROOT/runs/$CID/state.json','rb').read()).hexdigest())")"
LS1="$(cd "$ROOT/runs/$CID" && find . | sort | shasum | awk '{print $1}')"
bash "$ROOT/scripts/a2ui-surface.sh" "$CID" >/dev/null 2>&1
# 쓰기 불가 TMPDIR 로도 정상 동작(heredoc/mktemp 없음 증명) + 유효 JSON. JSON 은 임시파일로 받아 검증(따옴표
#   포함 페이로드를 check eval 문자열에 박지 않는다 — 검증 결과만 변수로 전달).
NOWR_OUT="$(mktemp "${TMPDIR:-/tmp}/a2ui-surf-nowr.XXXXXX")"
TMPDIR=/no/such/writable/dir bash "$ROOT/scripts/a2ui-surface.sh" "$CID" >"$NOWR_OUT" 2>/dev/null; NOWR_RC=$?
if $PY -c "import sys,json;json.load(open(sys.argv[1]))" "$NOWR_OUT" 2>/dev/null; then NOWR_VALID=y; else NOWR_VALID=n; fi
rm -f "$NOWR_OUT"
SHASH2="$($PY -c "import hashlib;print(hashlib.sha256(open('$ROOT/runs/$CID/state.json','rb').read()).hexdigest())")"
LS2="$(cd "$ROOT/runs/$CID" && find . | sort | shasum | awk '{print $1}')"
check "읽기전용: a2ui-surface 호출 후 state.json 불변(쓰기 없음)" '[ "$SHASH1" = "$SHASH2" ]'
check "읽기전용: a2ui-surface 호출 후 run 파일목록 불변(어떤 파일도 안 만듦)" '[ "$LS1" = "$LS2" ]'
check "임시파일 불요: 쓰기 불가 TMPDIR 로도 rc0 + 유효 JSON(Stage3 heredoc 제거)" \
  '[ "$NOWR_RC" = "0" ] && [ "$NOWR_VALID" = "y" ]'

# ── 2) 브리지 위임 = 직접 호출(select/approve/revise) — 결과 state.json 동일 ────────────
# select: 브리지 vs select.sh
SB="t-surf-sel-b"; seed_fixture concept "$SB"; bash "$ROOT/scripts/run-stage.sh" concept "$SB" >/dev/null 2>&1
SD="t-surf-sel-d"; seed_fixture concept "$SD"; bash "$ROOT/scripts/run-stage.sh" concept "$SD" >/dev/null 2>&1
act "$SB" '{"action":"select","value":"B-emotional"}'
check "위임[select]: 브리지 성공(rc0) + envelope(delegate=select.sh, exit=0)" \
  '[ "'"$RC"'" = "0" ] && [ "$(env_field delegate)" = "select.sh" ] && [ "$(env_field exit)" = "0" ]'
bash "$ROOT/scripts/select.sh" "$SD" B-emotional >/dev/null 2>&1
check "위임[select]: 브리지 결과 state == 직접 select.sh(ts/workflow_id 제외 deep-equal)" \
  '[ "$(norm_state '"$SB"')" = "$(norm_state '"$SD"')" ]'

# approve: 브리지(ra_ok=true) vs approve.sh --ra-ok (01-brief 승인)
AB="t-surf-appr-b"; rm -rf "$ROOT/runs/$AB"; bash "$ROOT/scripts/ingest-bundle.sh" "$BUNDLE" "$AB" >/dev/null 2>&1; bash "$ROOT/scripts/run-stage.sh" brief "$AB" >/dev/null 2>&1
AD="t-surf-appr-d"; rm -rf "$ROOT/runs/$AD"; bash "$ROOT/scripts/ingest-bundle.sh" "$BUNDLE" "$AD" >/dev/null 2>&1; bash "$ROOT/scripts/run-stage.sh" brief "$AD" >/dev/null 2>&1
act "$AB" '{"action":"approve","ra_ok":true}'
check "위임[approve]: 브리지 성공(rc0) + envelope(delegate=approve.sh)" \
  '[ "'"$RC"'" = "0" ] && [ "$(env_field delegate)" = "approve.sh" ]'
bash "$ROOT/scripts/approve.sh" "$AD" --ra-ok >/dev/null 2>&1
check "위임[approve]: 브리지 결과 state == 직접 approve.sh --ra-ok(deep-equal)" \
  '[ "$(norm_state '"$AB"')" = "$(norm_state '"$AD"')" ]'

# revise: 브리지(direction) vs revise.sh <direction> (02-concept 선택 게이트에서 전부거절→재제안)
RB="t-surf-rev-b"; seed_fixture concept "$RB"; bash "$ROOT/scripts/run-stage.sh" concept "$RB" >/dev/null 2>&1
RD="t-surf-rev-d"; seed_fixture concept "$RD"; bash "$ROOT/scripts/run-stage.sh" concept "$RD" >/dev/null 2>&1
act "$RB" '{"action":"revise","direction":"톤 순화"}'
check "위임[revise]: 브리지 성공(rc0) + envelope(delegate=revise.sh)" \
  '[ "'"$RC"'" = "0" ] && [ "$(env_field delegate)" = "revise.sh" ]'
bash "$ROOT/scripts/revise.sh" "$RD" "톤 순화" >/dev/null 2>&1
check "위임[revise]: 브리지 결과 state == 직접 revise.sh(deep-equal)" \
  '[ "$(norm_state '"$RB"')" = "$(norm_state '"$RD"')" ]'

# ── 4) 성공 envelope = 단일 JSON(파싱 가능) ────────────────────────────────────────
check "envelope: 성공 stdout 이 json 파싱 가능한 단일 envelope(ok/action/delegate/exit/message)" \
  '[ "$(is_envelope)" = "y" ] && [ "$(env_field ok)" = "True" ]'

# ── 3) 거부(rc≠0·부작용 없음) — 선택 게이트 전용 run 에서 ─────────────────────────────
RJ="t-surf-reject"; seed_fixture concept "$RJ"; bash "$ROOT/scripts/run-stage.sh" concept "$RJ" >/dev/null 2>&1
check "REJECT SETUP: 선택 게이트(gate=select/pending)" \
  '[ "$(jq_phase '"$RJ"' gate)" = "select" ] && [ "$(jq_phase '"$RJ"' status)" = "pending" ]'
act "$RJ" '{"action":"approve"}';               check "거부: 선택 게이트에 안 맞는 approve(rc2·envelope)" '[ "'"$RC"'" = "2" ] && [ "$(is_envelope)" = "y" ]'
act "$RJ" '{"action":"frobnicate"}';            check "거부: 미지 action(rc2)"                            '[ "'"$RC"'" = "2" ]'
act "$RJ" '{"action":"select","value":"ZZZ"}';  check "거부: 없는 옵션키(rc2)"                             '[ "'"$RC"'" = "2" ]'
act "$RJ" '{"action":"revise"}';                check "거부: 방향 없는 revise(rc2)"                        '[ "'"$RC"'" = "2" ]'
act "$RJ" '{"action":{"x":1}}';                 check "거부: 비-문자열 action(rc2·traceback 아님)"         '[ "'"$RC"'" = "2" ] && [ "$(is_envelope)" = "y" ] && ! grep -q Traceback /tmp/a2ui_surf_act.err'
check "거부군: 상태 불변(부작용 없음)" \
  '[ "$(jq_phase '"$RJ"' gate)" = "select" ] && [ "$(jq_phase '"$RJ"' status)" = "pending" ]'

# ── 3b) 플래그 주입 차단: comment='--ra-ok'(ra_ok=false) 은 RA_OK 승격 금지 ───────────────
FI="t-surf-flag"; rm -rf "$ROOT/runs/$FI"; bash "$ROOT/scripts/ingest-bundle.sh" "$BUNDLE" "$FI" >/dev/null 2>&1; bash "$ROOT/scripts/run-stage.sh" brief "$FI" >/dev/null 2>&1
APPROVED_SENS="$($PY -c "import json;d=json.load(open('$ROOT/runs/$FI/01-brief/brief.json'));print(sum(1 for s in d.get('sensitive_labels',[]) if s.get('status')=='approved'))")"
check "플래그주입 SETUP: 기능성 승인표시 ≥1(RA 게이트 활성)" '[ "'"$APPROVED_SENS"'" -ge 1 ]'
act "$FI" '{"action":"approve","comment":"--ra-ok","ra_ok":false}'
check "플래그주입: comment=--ra-ok 는 rc2 거부(위임 안 함, RA_OK 미승격)" \
  '[ "'"$RC"'" = "2" ] && [ "$(env_field delegate)" = "None" ]'
check "플래그주입: 거부 후 상태 불변(RA_OK 미설정 → 승인 미전진 · gate=user/pending)" \
  '[ "$(jq_phase '"$FI"' gate)" = "user" ] && [ "$(jq_phase '"$FI"' status)" = "pending" ]'

# 정리(테스트 산출 run 은 결정적 재생성 가능 — 골든 무영향).
rm -rf "$ROOT/runs/$CID" "$ROOT/runs/$BID" "$ROOT/runs/$EID" \
       "$ROOT/runs/$SB" "$ROOT/runs/$SD" "$ROOT/runs/$AB" "$ROOT/runs/$AD" \
       "$ROOT/runs/$RB" "$ROOT/runs/$RD" "$ROOT/runs/$RJ" "$ROOT/runs/$FI" 2>/dev/null || true

printf '\n[a2ui-surface] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
