#!/usr/bin/env bash
# test-agui-projection.sh — AG-UI 이벤트 방출기(scripts/lib/agui_events.py + agui-events.sh + run-stage/gate/
#   advance-phase/kcia-check 의 agui_emit 4지점) 런타임 회귀 게이트(결정적·오프라인·no-LLM·골든 무영향).
#   ⚠ test-agui-contracts.sh 는 스키마/카탈로그 JSON '구조'만 본다(방출 미구동). 이 파일은 실제 오프라인 stub 런을
#     끝까지 몰아 runs/<id>/.events/agui.jsonl 로 방출되는 이벤트 스트림의 '동작'을 검증한다.
#   커버(Stage 5 계약):
#     A. 게이트별 이벤트 시퀀스(순서): StateSnapshot·RunStarted(1회) → StepStarted/Finished(생성) →
#        StateDelta(전이) → Custom(kcia.verdict, 심의) → RunFinished{interrupt}(사람 게이트) → RunFinished{success}(done).
#     B. events ↔ state.history 교차검증(양방향·고아 없음) — 합성 이벤트(RunStarted/StateSnapshot/StateDelta) 제외.
#     C. interrupt→resume 페어링: select/user 게이트의 RunFinished{interrupt} 는 재개 가능한 action(kind + select 는 options)
#        을 실어야 하고, 4동작 재개 뒤 continuation 이 이어지며(중단 복구), 같은 개입은 재방출되지 않는다(interruptId dedup).
#     D. 멱등 재진입 = 중복 방출 0(S2 dedup 회귀 봉인): 같은 상태에서 재sync → 이벤트수 불변.
#     E. 같은-초(same-second) 서로 다른 두 history 행 = 둘 다 방출(위치 기반 투영 회귀 — 옛 전체-행 해시 dedup false-collapse 폐기).
#     F. 방출된 모든 이벤트가 harness/agui-projection.schema.json 을 통과(레포 stdlib harness.Validator — jsonschema 미설치).
#     G. agui-events.sh replay: snapshot + delta 순차 적용이 최종 state.json 을 재구성(deep-equal).
#     H. .events/ 는 골든 제외(baseline.py SKIP_PREFIX 에 '.events').
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## AG-UI 방출기 — 게이트별 시퀀스·교차검증·interrupt재개·멱등·같은초·스키마검증·replay재구성(오프라인·no-LLM)"

PY=python3
# agui_emit(common.sh) 과 동일한 재sync 호출(방출 모듈 sync). 멱등/재진입 단정에 쓴다.
sync_run(){ "$PY" "$ROOT/scripts/lib/agui_events.py" sync "$1" >/dev/null 2>&1; }
evfile(){ echo "$ROOT/runs/$1/.events/agui.jsonl"; }
evcount(){ wc -l < "$(evfile "$1")" | tr -d ' '; }
iid_int_count(){ "$PY" -c "import json;print(sum(1 for l in open('$(evfile "$1")') if l.strip() and json.loads(l).get('type')=='RunFinished' and (json.loads(l).get('outcome') or {}).get('type')=='interrupt'))"; }

# ── SETUP: 오프라인 stub 전 파이프라인을 done 까지 완주(agui_emit 이 4지점에서 방출) ─────────────────
DID="t-agui-done"
drive_to_done "$DID" stub
check "SETUP: 오프라인 stub 파이프라인 done 완주" '[ "$(jq_phase "'"$DID"'" phase)" = "done" ]'
check "SETUP: .events/agui.jsonl 방출됨(비어있지 않음)" '[ -s "$(evfile "'"$DID"'")" ]'

# ── H: .events 골든 제외(baseline.py SKIP_PREFIX) ───────────────────────────────────
check "H: .events 는 골든 제외(baseline.SKIP_PREFIX ∋ '.events')" \
  '"$PY" -c "import sys,os;sys.path.insert(0,\"'"$ROOT"'/scripts/lib\");os.environ.setdefault(\"HARNESS_ROOT\",\"'"$ROOT"'\");import baseline;sys.exit(0 if \".events\" in baseline.SKIP_PREFIX else 1)"'

# ── A/B/C-구조/F/G: done 런 정적 분석(단일 파이썬 러너 — test-agui-contracts 패턴: OK/FAIL/__COUNT__ 파싱) ──
# ⚠ macOS bash 3.2 heredoc 괄호 버그 회피: 명령치환이 아니라 python3 stdin 으로 넘기고 stdout 을 파일로 리다이렉트.
AGUI_TMP="$(mktemp "${TMPDIR:-/tmp}/agui-projection.XXXXXX")"
"$PY" - "$ROOT" "$DID" > "$AGUI_TMP" 2>&1 <<'PY'
import json, os, sys, subprocess

root, rid = sys.argv[1], sys.argv[2]
os.environ["HARNESS_ROOT"] = root
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from harness import Validator, load_json          # 레포 stdlib 검증기(jsonschema 미설치)
import agui_events as A                            # 방출 모듈(replay 재구성 apply_patch 재사용)

results = []
def R(ok, label, detail): results.append((bool(ok), label, detail))

SCHEMA = load_json(os.path.join(root, "harness", "agui-projection.schema.json"))
st = load_json(os.path.join(root, "runs", rid, "state.json"))
hist = st.get("history") or []

# 이벤트 로그 = .events/agui.jsonl 원본 라인.
ef = os.path.join(root, "runs", rid, ".events", "agui.jsonl")
file_evs = [json.loads(l) for l in open(ef, encoding="utf-8") if l.strip()]

# ── G(1): agui-events.sh replay 가 로그와 동일 내용을 스트림하는가(셸 replay 충실성) ──
shell = subprocess.run(["bash", os.path.join(root, "scripts", "agui-events.sh"), rid],
                       capture_output=True, text=True, cwd=root,
                       env=dict(os.environ, HARNESS_ROOT=root, HARNESS_OFFLINE="1", HARNESS_NO_DOTENV="1"))
replay_evs = [json.loads(l) for l in shell.stdout.splitlines() if l.strip()]
R(replay_evs == file_evs,
  "G: agui-events.sh replay 스트림 == .events/agui.jsonl 로그(셸 replay 충실)",
  "replay=%d file=%d" % (len(replay_evs), len(file_evs)))

evs = file_evs
def cnt(pred): return sum(1 for e in evs if pred(e))
def is_int(e, kind=None):
    if e.get("type") != "RunFinished": return False
    oc = e.get("outcome") or {}
    if oc.get("type") != "interrupt": return False
    return kind is None or any(i.get("kind") == kind for i in (oc.get("interrupts") or []))
def is_success(e):
    return e.get("type") == "RunFinished" and (e.get("outcome") or {}).get("type") == "success"
def is_kcia(e):
    return e.get("type") == "Custom" and e.get("name") == "kcia.verdict"

# ── F: 방출된 모든 이벤트가 projection 스키마 통과(레포 Validator) ─────────────────────
bad = []
for i, e in enumerate(evs):
    v = Validator(SCHEMA); v.validate(e, SCHEMA)
    if v.errors:
        bad.append("[%d]%s:%s" % (i, e.get("type"), v.errors))
R(not bad and len(evs) >= 1,
  "F: 방출된 전 이벤트(%d건) projection 스키마 통과(harness.Validator)" % len(evs),
  "위반=%s" % bad[:3] if bad else "%d건 전부 유효" % len(evs))

# ── A: 게이트별 이벤트 시퀀스(순서) — 정렬된 부분수열(subsequence) 매칭 ─────────────────
#   전체 시퀀스를 리터럴 고정하면 취약하므로, '이 순서로 등장해야 하는 핵심 이벤트'를 부분수열로 검증한다.
def sub_ok(preds):
    it = iter(evs)
    for p in preds:
        for e in it:
            if p(e): break
        else:
            return False
    return True
order = [
    lambda e: e.get("type") == "StateSnapshot",                                   # 1) 첫 스냅샷
    lambda e: e.get("type") == "RunStarted",                                      # 2) 런 시작
    lambda e: e.get("type") == "StepStarted" and e.get("stepName") == "phase:01-brief",
    lambda e: is_int(e, "approve"),                                               # 4) 브리프 승인 게이트
    is_kcia,                                                                       # 5) 브리프 심의 결과
    lambda e: e.get("type") == "StepFinished" and e.get("stepName") == "review:01-brief" and e.get("outcome") == "passed",
    lambda e: e.get("type") == "StepStarted" and e.get("stepName") == "phase:02-concept",
    lambda e: is_int(e, "select"),                                                # 8) 컨셉 선택 게이트
    lambda e: e.get("type") == "StepStarted" and e.get("stepName") == "phase:04-keyvisual",
    is_success,                                                                    # 10) done
]
R(sub_ok(order), "A: 게이트별 이벤트 순서(스냅샷→런시작→생성→승인게이트→심의→통과→…→done) 부분수열 일치",
  "부분수열 매칭 실패" if not sub_ok(order) else "10개 앵커 순서대로 등장")
R(cnt(lambda e: e.get("type") == "RunStarted") == 1, "A: RunStarted 정확히 1회",
  "n=%d" % cnt(lambda e: e.get("type") == "RunStarted"))
R(cnt(lambda e: e.get("type") == "StateSnapshot") == 1, "A: StateSnapshot 정확히 1회",
  "n=%d" % cnt(lambda e: e.get("type") == "StateSnapshot"))
R(cnt(is_success) == 1, "A: RunFinished{success} 정확히 1회(done)", "n=%d" % cnt(is_success))
R(cnt(lambda e: is_int(e)) >= 1, "A: RunFinished{interrupt} ≥1회(사람 게이트)", "n=%d" % cnt(lambda e: is_int(e)))
R(cnt(lambda e: e.get("type") == "StepStarted" and (e.get("stepName") or "").startswith("generate:")) >= 1
  and cnt(lambda e: e.get("type") == "StepFinished" and (e.get("stepName") or "").startswith("generate:")) >= 1,
  "A: 생성 StepStarted/StepFinished 방출됨", "start=%d finish=%d" % (
    cnt(lambda e: e.get("type") == "StepStarted" and (e.get("stepName") or "").startswith("generate:")),
    cnt(lambda e: e.get("type") == "StepFinished" and (e.get("stepName") or "").startswith("generate:"))))
R(cnt(lambda e: e.get("type") == "StateDelta") >= 1, "A: 전이 StateDelta 방출됨",
  "n=%d" % cnt(lambda e: e.get("type") == "StateDelta"))

# ── B: events ↔ state.history 교차검증(양방향·고아 없음) ─────────────────────────────
#   두 계산을 '독립'으로 한다: history 는 event 문자열 prefix 로, events 는 type/stepName 으로 센다. 양쪽 개수가
#   '정확히 같으면' 어느 방향으로도 고아가 없다(합성 이벤트 RunStarted/StateSnapshot/StateDelta 는 제외).
def hc(pref): return sum(1 for h in hist if (h.get("event") or "").startswith(pref))
kcia_ev = cnt(is_kcia)
phase_ev = cnt(lambda e: e.get("type") == "StepStarted" and (e.get("stepName") or "").startswith("phase:"))
revpass_ev = cnt(lambda e: e.get("type") == "StepFinished" and (e.get("stepName") or "").startswith("review:") and e.get("outcome") == "passed")
succ_ev = cnt(is_success)
int_ev = cnt(lambda e: is_int(e))
R(hc("run:created") == 1 and cnt(lambda e: e.get("type") == "RunStarted") == 1,
  "B: run:created(history) ↔ RunStarted(events) 1:1", "h=%d e=%d" % (hc("run:created"), cnt(lambda e: e.get("type") == "RunStarted")))
R(hc("review:produced:") == kcia_ev and kcia_ev >= 1,
  "B: review:produced(history) ↔ Custom(kcia.verdict) 개수 일치(양방향 고아 없음)", "h=%d e=%d" % (hc("review:produced:"), kcia_ev))
R(hc("phase:enter") == phase_ev and phase_ev >= 1,
  "B: phase:enter(history) ↔ StepStarted(phase:*) 개수 일치", "h=%d e=%d" % (hc("phase:enter"), phase_ev))
R(hc("review:passed") == revpass_ev and revpass_ev >= 1,
  "B: review:passed(history) ↔ StepFinished(review:* passed) 개수 일치", "h=%d e=%d" % (hc("review:passed"), revpass_ev))
R(hc("workflow:complete") == succ_ev == 1,
  "B: workflow:complete(history) ↔ RunFinished{success} 1:1", "h=%d e=%d" % (hc("workflow:complete"), succ_ev))
# 사람 게이트 개입 ↔ 해소 마커(모든 개입이 done 까지 해소됨): approve 해소 + select 해소 = interrupt 방출 수.
resolved = hc("human:approved→review") + hc("select:")
R(resolved == int_ev and int_ev >= 1,
  "B/C: 개입 해소 마커(human:approved→review + select:) ↔ RunFinished{interrupt} 개수 일치(모두 재개됨)",
  "resolved=%d interrupts=%d" % (resolved, int_ev))
# 고아 방지(events→): StepStarted/StepFinished 의 stepName 이 알려진 prefix 로만 구성(정체불명 스텝=고아).
KNOWN = ("phase:", "generate:", "review:", "ingest", "report", "intake:")
orphan = [e.get("stepName") for e in evs if e.get("type") in ("StepStarted", "StepFinished")
          and not any((e.get("stepName") or "").startswith(k) for k in KNOWN)]
R(not orphan, "B: 고아 스텝 없음(모든 Step*.stepName 이 history prefix 로 추적됨)", "고아=%s" % orphan[:3] if orphan else "없음")

# ── C(구조): 각 interrupt 가 재개 가능한 action 을 싣는가(kind + select 는 options) ──────
int_items = []
for e in evs:
    if is_int(e):
        int_items.extend((e.get("outcome") or {}).get("interrupts") or [])
bad_kind = [i for i in int_items if i.get("kind") not in ("select", "approve", "revise", "raise-limit")
            or not i.get("interruptId") or not i.get("phase")]
R(int_items and not bad_kind,
  "C: 모든 interrupt 가 kind∈{select,approve,revise,raise-limit} + interruptId + phase 보유",
  "위반=%s" % bad_kind[:2] if bad_kind else "%d개 개입 전부 정상" % len(int_items))
sel_items = [i for i in int_items if i.get("kind") == "select"]
bad_sel = [i for i in sel_items if not (isinstance(i.get("options"), list) and len(i["options"]) >= 1)]
R(sel_items and not bad_sel,
  "C: select 개입은 options(≥1) 를 실어 재개 선택지 제공", "위반=%s" % bad_sel[:2] if bad_sel else "%d개 select 전부 options 보유" % len(sel_items))

# ── G(2): replay(snapshot + delta) 재구성 == state.json (deep-equal) ─────────────────
proj, has_snap = A._reconstruct_state(replay_evs)
R(has_snap and proj == st,
  "G: replay snapshot+delta 순차적용 == 최종 state.json(deep-equal)",
  "has_snapshot=%s equal=%s" % (has_snap, proj == st))

for ok, label, detail in results:
    print("%s\t%s\t%s" % ("OK" if ok else "FAIL", label, detail))
print("__COUNT__\t%d\t" % len(results))
sys.exit(0 if all(ok for ok, _, _ in results) else 1)
PY
AGUI_RC=$?
AGUI_OUT="$(cat "$AGUI_TMP")"; rm -f "$AGUI_TMP"

check "러너 정상 완료(rc∈{0,1}, 크래시 아님)" '[ "$AGUI_RC" = "0" ] || [ "$AGUI_RC" = "1" ]'
check "러너 출력 비어있지 않음(fail-closed)" '[ -n "$AGUI_OUT" ]'
NLINES=0; EXPECTED=""
while IFS=$'\t' read -r status label detail; do
  [ -z "${status:-}" ] && continue
  if [ "$status" = "__COUNT__" ]; then EXPECTED="$label"; continue; fi
  [ -z "${label:-}" ] && continue
  NLINES=$((NLINES+1))
  if [ "$status" = "OK" ]; then pass "$label — $detail"; else fail "$label — $detail"; fi
done <<< "$AGUI_OUT"
check "완결 마커(__COUNT__) 수신 — 부분출력 아님" '[ -n "$EXPECTED" ]'
check "처리된 결과 줄 = 러너 보고 개수($EXPECTED)" '[ -n "$EXPECTED" ] && [ "$NLINES" = "$EXPECTED" ]'

# ── D: 멱등 재진입 = 중복 방출 0(S2 dedup 회귀) — done 런에서 재sync 반복 → 이벤트수 불변 ──
D_BEFORE="$(evcount "$DID")"
sync_run "$DID"; sync_run "$DID"
D_AFTER="$(evcount "$DID")"
check "D: 멱등 재sync(×2) 이벤트수 불변(${D_BEFORE}→${D_AFTER}, 중복 방출 0)" '[ "$D_BEFORE" = "$D_AFTER" ]'

# ── C(라이브): interrupt→resume 페어링 — select 게이트에서 재개 뒤 continuation·개입 미재방출 ──
SID="t-agui-resume"; rm -rf "$ROOT/runs/$SID"
( cd "$ROOT" && export HARNESS_CLI=stub HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" &&
  bash scripts/ingest-bundle.sh "$BUNDLE" "$SID" >/dev/null 2>&1 &&
  bash scripts/run-stage.sh brief "$SID" >/dev/null 2>&1 &&
  bash scripts/approve.sh "$SID" --ra-ok >/dev/null 2>&1 && bash scripts/kcia-check.sh "$SID" >/dev/null 2>&1 &&
  bash scripts/run-stage.sh concept "$SID" >/dev/null 2>&1 ) >/dev/null 2>&1
check "C(라이브): SETUP 컨셉 선택 게이트 도달(gate=select/pending)" \
  '[ "$(jq_phase "'"$SID"'" gate)" = "select" ] && [ "$(jq_phase "'"$SID"'" status)" = "pending" ]'
# 마지막 이벤트 = select 개입(kind=select + options + interruptId).
LAST_INT="$(tail -1 "$(evfile "$SID")" | "$PY" -c 'import sys,json;e=json.load(sys.stdin);o=e.get("outcome") or {};i=(o.get("interrupts") or [{}])[0];print("%s|%s|%d|%s"%(e.get("type"),i.get("kind"),len(i.get("options") or []),bool(i.get("interruptId"))))')"
check "C(라이브): 마지막 방출 = RunFinished{interrupt} kind=select + options≥1 + interruptId(재개 가능 action)" \
  '[ "$LAST_INT" = "RunFinished|select|3|True" ]'
RS_BEFORE_N="$(evcount "$SID")"; RS_BEFORE_INT="$(iid_int_count "$SID")"
sync_run "$SID"; sync_run "$SID"    # 게이트에서 재sync → 개입 재방출 없어야(interruptId dedup)
check "C/D(라이브): 선택 게이트 재sync 이벤트수 불변(개입 중복 방출 0)" '[ "$RS_BEFORE_N" = "$(evcount "'"$SID"'")" ]'
# 4동작(select.sh B)으로 재개 → 게이트 전진 + continuation 방출 + 개입 미재방출.
( cd "$ROOT" && export HARNESS_CLI=stub HARNESS_OFFLINE=1 && bash scripts/select.sh "$SID" B-emotional >/dev/null 2>&1 ) >/dev/null 2>&1
check "C(라이브): select.sh 재개 후 게이트 전진(select→review)" '[ "$(jq_phase "'"$SID"'" gate)" = "review" ]'
check "C(라이브): 재개 뒤 continuation 방출(이벤트 증가 ${RS_BEFORE_N}→$(evcount "$SID"))" '[ "$(evcount "'"$SID"'")" -gt "$RS_BEFORE_N" ]'
check "C(라이브): 재개돼도 같은 select 개입 재방출 안 함(interrupt 수 불변 ${RS_BEFORE_INT}→$(iid_int_count "$SID"))" \
  '[ "$RS_BEFORE_INT" = "$(iid_int_count "'"$SID"'")" ]'
# continuation 은 심의 스텝 시작(StepStarted review:02-concept)을 포함.
check "C(라이브): continuation 에 심의 스텝 시작(StepStarted review:02-concept) 포함" \
  'tail -n +$(('"$RS_BEFORE_N"'+1)) "$(evfile "'"$SID"'")" | grep -q "\"stepName\": \"review:02-concept\""'

# ── E: 같은-초(same-second) 서로 다른 두 history 행 = 둘 다 방출(위치 기반 투영 회귀 — 옛 전체-행 해시 false-collapse 폐기) ──
#   full stub 런은 같은-초 행을 만들지만 '서로 다른 kind' 다. 위치 기반 dedup 을 정조준하려면 '내용이 동일한(같은 event/ts/
#   phase/by)' 두 행이 둘 다 방출돼야 함을 봐야 한다(옛 해시 dedup 이라면 1개로 collapse). 결정적 재현을 위해 방출기 API
#   에 넣을 합성 state.json 을 만든다(테스트 픽스처 — 산출물 아님).
ESID="t-agui-samesec"; rm -rf "$ROOT/runs/$ESID"; mkdir -p "$ROOT/runs/$ESID"
"$PY" - "$ROOT/runs/$ESID/state.json" <<'PY'
import json, sys
# 같은-초(00:00:05Z) + 완전 동일 내용(event/phase/by) 인 phase:enter 두 행 → 위치 투영이면 둘 다, 해시 dedup 이면 하나.
st = {"$schema": "harness/state.schema.json", "workflow_id": "t-agui-samesec",
      "phase": "01-brief", "step": "generate", "gate": None, "status": "pending",
      "iteration": 1, "max_iterations": 3, "history": [
          {"ts": "2026-07-18T00:00:00Z", "phase": "00-ingest", "event": "run:created", "by": "new-run.sh"},
          {"ts": "2026-07-18T00:00:05Z", "phase": "01-brief", "event": "phase:enter", "by": "advance-phase.sh"},
          {"ts": "2026-07-18T00:00:05Z", "phase": "01-brief", "event": "phase:enter", "by": "advance-phase.sh"}]}
json.dump(st, open(sys.argv[1], "w"))
PY
sync_run "$ESID"
SAMESEC_N="$("$PY" -c "import json;print(sum(1 for l in open('$(evfile "$ESID")') if l.strip() and json.loads(l).get('stepName')=='phase:01-brief'))")"
check "E: 같은-초 동일내용 두 history 행 → StepStarted(phase:01-brief) 2건 방출(위치 기반; 해시 collapse 아님)" \
  '[ "$SAMESEC_N" = "2" ]'
SS_BEFORE="$(evcount "$ESID")"; sync_run "$ESID"
check "E: 그 상태 재sync 여전히 멱등(이벤트수 불변 $SS_BEFORE)" '[ "$SS_BEFORE" = "$(evcount "'"$ESID"'")" ]'

# 정리(테스트 산출 run 은 결정적 재생성 가능 — .events 는 골든 제외라 무영향).
rm -rf "$ROOT/runs/$DID" "$ROOT/runs/$SID" "$ROOT/runs/$ESID" 2>/dev/null || true

printf '\n[agui-projection] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
