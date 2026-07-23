#!/usr/bin/env bash
# test-gates.sh — WS-GATES: 타입화 게이트(gate_type, 파생) + 멈춤사유(feedback.stop_reason).
#   gate_type 은 state 에 저장하지 않고 render_runmd.gate_type 가 (gate,status,phase)+민감표시에서 파생 →
#   next-action.json 에 노출(Slack SSoT). stop_reason 은 revise --reason 가 feedback.json 에 기록.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## WS-GATES — gate_type(파생) + stop_reason"
export HARNESS_CLI=stub HARNESS_OFFLINE=1
H="$ROOT/scripts/lib/harness.py"
na_gt() { bash "$ROOT/scripts/next-action.sh" "$1" | python3 -c "import json,sys;print(json.load(sys.stdin).get('gate_type'))"; }

# ── (A/B/C) gate_type 파생 (M4 순서: 생성→setup(민감 user) → 승인→auto(review) → concept→human-verify(select)) ──
RID=ci-gates; rm -rf "$ROOT/runs/$RID"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" && bash scripts/run-stage.sh brief "$RID" ) >/dev/null 2>&1
# M4: 생성 직후 brief 는 민감표시 user 게이트(승인 대기) → setup.
check "(A) 01-brief 민감표시 user 대기 → gate_type=setup" "[ \"$(na_gt $RID)\" = 'setup' ]"
# M4: 승인 뒤 review 게이트(심의 대기) → auto.
( cd "$ROOT" && bash scripts/approve.sh "$RID" --ra-ok ) >/dev/null 2>&1
check "(B) 승인 후 심의(review) 대기 → gate_type=auto" "[ \"$(na_gt $RID)\" = 'auto' ]"
# M4: 심의 통과 → 02-concept 전진 → concept 생성 시 다안 select 게이트 → human-verify.
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID" && bash scripts/run-stage.sh concept "$RID" ) >/dev/null 2>&1
check "(C) concept 다안 select 대기 → gate_type=human-verify" "[ \"$(na_gt $RID)\" = 'human-verify' ]"

# ── (D) hard-stop / None: 파생 함수 직접(합성 상태; check 의 eval 재파싱을 피해 변수로 선계산) ──
HS="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;print(R.gate_type({'status':'escalated','gate':'review','phase':'02-concept'},'/tmp'))")"
check "(D) escalated → gate_type=hard-stop" "[ \"$HS\" = 'hard-stop' ]"
NONE="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;print(R.gate_type({'status':'pending','gate':None,'phase':'01-brief'},'/tmp'))")"
check "(D) 생성 단계(게이트 아님) → gate_type None" "[ \"$NONE\" = 'None' ]"

# ── (F) 중단 복구 상태(approved/selected)도 null 이 아니라 underlying 게이트 종류 ──
RU="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;print(R.gate_type({'status':'approved','gate':'user','phase':'02-concept'},'/tmp'))")"
check "(F) 중단복구 user/approved → human-verify(null 금지)" "[ \"$RU\" = 'human-verify' ]"
RS="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;print(R.gate_type({'status':'selected','gate':'select','phase':'02-concept'},'/tmp'))")"
check "(F) 중단복구 select/selected → human-verify(null 금지)" "[ \"$RS\" = 'human-verify' ]"

# ── (G) _stop_reason 기인별 분기: 사람(changes_requested)만 feedback, 기계(revise/escalated)는 generic ──
SRD="$(mktemp -d)"; mkdir -p "$SRD/02-concept"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import atomic_write_json;atomic_write_json('$SRD/02-concept/feedback.json',{'items':[{'target_text':'x','issue':'y'}],'stop_reason':{'code':'human_revise','summary':'s'}})"
SRC() { python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;sr=R._stop_reason('$SRD',{'status':'$1','phase':'$2'});print(sr['code'] if sr else 'NONE')"; }
check "(G) 비-중단(pending) → 미노출(staleness 방지)" "[ \"$(SRC pending 02-concept)\" = 'NONE' ]"
check "(G) changes_requested(사람 revise) → feedback 사유(human_revise)" "[ \"$(SRC changes_requested 02-concept)\" = 'human_revise' ]"
check "(G) revise(기계 review-실패)+stale human feedback → generic(옛 human 무시)" "[ \"$(SRC revise 02-concept)\" = 'revise' ]"
check "(G) escalated(기계 review/loop-guard, history 없음) → generic" "[ \"$(SRC escalated 04-keyvisual)\" = 'escalated' ]"
HE="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;sr=R._stop_reason('$SRD',{'status':'escalated','phase':'02-concept','history':[{'event':'human:revise→escalated:3/3'}]});print(sr['code'] if sr else 'NONE')")"
check "(G) escalated(사람 revise 상한초과, history=human) → feedback 사유(human_revise)" "[ \"$HE\" = 'human_revise' ]"
# 사람 escalate → raise-limit 복구(status=revise) 체인도 사람 기인 추적(round4 엣지)
RH="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;sr=R._stop_reason('$SRD',{'status':'revise','phase':'02-concept','history':[{'event':'human:revise→escalated:3/3'},{'event':'limit:raised:5→generate'}]});print(sr['code'] if sr else 'NONE')")"
check "(G) revise(사람 escalate→raise-limit 복구) → feedback 사유(human_revise)" "[ \"$RH\" = 'human_revise' ]"
rm -rf "$SRD"

# ── (E) stop_reason: revise --reason 기록 / 미지정 시 생략(back-compat) ──
# M4: 생성 직후 user 게이트에서 revise(거절) 가능 — 심의는 승인 뒤이므로 여기선 호출하지 않는다.
RID2=ci-gates-sr; rm -rf "$ROOT/runs/$RID2"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" && bash scripts/run-stage.sh brief "$RID2" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/revise.sh "$RID2" "이 표현 빼줘" "헤드라인" --reason human_revise ) >/dev/null 2>&1
FB="$ROOT/runs/$RID2/01-brief/feedback.json"
check "(E) revise --reason → feedback.stop_reason.code 기록" "[ \"$(python3 "$H" jget "$FB" stop_reason.code 2>/dev/null)\" = 'human_revise' ]"
RF="$(python3 -c "import json;print((json.load(open('$FB')).get('stop_reason',{}).get('required_fields') or [''])[0])")"
check "(E) stop_reason.required_fields 에 대상 기록" "[ \"$RF\" = '헤드라인' ]"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import atomic_write_json;atomic_write_json('/tmp/fb-nosr-$$.json',{'items':[{'target_text':'','issue':'x'}]})"
check "(E) stop_reason 없는 feedback 도 스키마 통과(back-compat)" "python3 '$H' validate /tmp/fb-nosr-$$.json --schema feedback.schema.json >/dev/null 2>&1"

# ── (E2) revise(--reason 없음) → stop_reason 키 미생성(full-rewrite → stale 불가) ──
RID3=ci-gates-nr; rm -rf "$ROOT/runs/$RID3"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID3" && bash scripts/run-stage.sh brief "$RID3" \
  && bash scripts/revise.sh "$RID3" "이 표현 빼줘" "헤드라인" ) >/dev/null 2>&1
FB3="$ROOT/runs/$RID3/01-brief/feedback.json"
check "(E2) revise(--reason 없음) → stop_reason 키 미생성" "python3 -c \"import json,sys;sys.exit(0 if 'stop_reason' not in json.load(open('$FB3')) else 1)\""

rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID2" "$ROOT/runs/$RID3" /tmp/fb-nosr-$$.json
printf '\n[gates] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
