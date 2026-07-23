#!/usr/bin/env bash
# test-critic-fanout.sh — WS-CRITIC-B: 건별 적대검증 2-pass(Pass-A 전체 + Pass-B 건별 refute).
#   개편(critic=adk-http 단일): 옛 로컬 critic(KCIA_CRITIC_CMD claude/codex)·self-grading 가드는 폐기됐다.
#   심의 엔진 = 원격 ADK(adk_critic.py) 단일 — 도메인 domain.json 의 adk_critic 블록이 가용성 마커.
#   (1) 머지 단위검증: baseline high 불멸 · refute 된 후보 제외 · confirm 된 후보 유지(엔진 무관, 보존).
#   (2) 통합(로컬 ADK 목 서버): Pass-A 후보 → Pass-B refute → 최종 verdict 에 confirm 만 (ADK_CRITIC_ALLOW_LOCAL=1).
#   (3) offline(CI) → 양 pass 스킵(머지=baseline, 결정성 불변).
#   (4) ADK 미구현 도메인(drug=adk_critic 블록 없음, resolve 4) → 룰엔진-단독(critic_ran=false·review_depth=rule_engine_only).
#   (5) 폐기된 critic 엔진 선언(codex/claude-subagent) → die(화이트리스트 adk-http/미설정만).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## WS-CRITIC-B — 건별 적대검증 2-pass (critic=adk-http)"
export HARNESS_ROOT="$ROOT"     # 단위 heredoc 이 scripts/lib 를 찾도록(integration 은 kcia-check 가 별도 export)
H="$ROOT/scripts/lib/harness.py"
MERGE="$ROOT/scripts/lib/kcia_merge.py"

# ── (1) 머지 단위검증(합성 baseline/passa/passb) — 엔진 무관(merge 계약은 불변) ──
W="$(mktemp -d)"; mkdir -p "$W/pb"
python3 - "$W" <<'PYEOF'
import sys, os, json
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import atomic_write_json
w = sys.argv[1]
def vio(t, sev): return {"target_text": t, "axis": "consumer_deception", "rule": "r", "severity": sev, "detected_by": "subagent", "suggested_rewrite": "x"}
atomic_write_json(os.path.join(w, "baseline.json"), {"verdict": "fail", "engine": "ruleset", "confidence": 0.9, "violations": [vio("BASE_HIGH", "high")], "escalate": False})
# passa: baseline 중복(BASE_HIGH) + 신규 2건(CONFIRM, REFUTE)
atomic_write_json(os.path.join(w, "passa.json"), {"verdict": "fail", "engine": "subagent", "confidence": 0.8, "violations": [vio("BASE_HIGH", "high"), vio("CONFIRM", "medium"), vio("REFUTE", "low")], "escalate": False})
# 후보 순서: [CONFIRM(0), REFUTE(1)] (BASE_HIGH 은 baseline → 후보 아님). pb/0=유지, pb/1=refute
atomic_write_json(os.path.join(w, "pb", "0.json"), {"refuted": False, "reason": "ok"})
atomic_write_json(os.path.join(w, "pb", "1.json"), {"refuted": True, "reason": "weak"})
PYEOF
# 후보 추출 순서 확인
CANDS="$(python3 "$MERGE" candidates "$W/baseline.json" "$W/passa.json" 8 | python3 -c "import sys,json;print(','.join(json.loads(l)['target_text'] for l in sys.stdin))")"
check "(1) 후보 = baseline 제외, 순서 [CONFIRM,REFUTE]" "[ \"$CANDS\" = 'CONFIRM,REFUTE' ]"
python3 "$MERGE" merge "$W/out.json" "$W/baseline.json" "$W/passa.json" "$W/pb" "adk-http" 8
TXTS="$(python3 -c "import json;print(','.join(v['target_text'] for v in json.load(open('$W/out.json'))['violations']))")"
check "(1) baseline high 불멸(BASE_HIGH 유지)" "echo \"$TXTS\" | grep -q 'BASE_HIGH'"
check "(1) confirm 된 후보 유지(CONFIRM)" "echo \"$TXTS\" | grep -q 'CONFIRM'"
check "(1) refute 된 후보 제외(REFUTE 없음)" "! echo \"$TXTS\" | grep -q 'REFUTE'"
check "(1) verdict=fail(baseline high) · engine=ruleset+subagent" "[ \"$(python3 "$H" jget "$W/out.json" verdict)\" = 'fail' ] && [ \"$(python3 "$H" jget "$W/out.json" engine)\" = 'ruleset+subagent' ]"
# offline 등가: passa 없음 + 빈 pb → 머지=baseline
python3 "$MERGE" merge "$W/out2.json" "$W/baseline.json" "$W/none.passa" "$W/pb-empty" "" 8
check "(1) passa 없음(offline 등가) → 머지=baseline(BASE_HIGH 1건, engine=subagent)" \
  "[ \"$(python3 -c "import json;print(len(json.load(open('$W/out2.json'))['violations']))")\" = '1' ] && [ \"$(python3 "$H" jget "$W/out2.json" engine)\" = 'subagent' ]"
rm -rf "$W"

# ── (1b) 견고성: cap 경계 · Pass-B 누락=refute · Pass-A invalid/malformed 안전 ──
W2="$(mktemp -d)"; mkdir -p "$W2/pb"
python3 - "$W2" "$ROOT" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(sys.argv[2], "scripts", "lib"))
from harness import atomic_write_json
w = sys.argv[1]
def vio(t, sev="medium"): return {"target_text": t, "axis": "consumer_deception", "rule": "r", "severity": sev, "detected_by": "subagent", "suggested_rewrite": "x"}
atomic_write_json(os.path.join(w, "baseline.json"), {"verdict": "pass", "engine": "ruleset", "confidence": 0.9, "violations": [], "escalate": False})
atomic_write_json(os.path.join(w, "passa.json"), {"verdict": "fail", "engine": "subagent", "confidence": 0.8, "violations": [vio("C1"), vio("C2")], "escalate": False})
atomic_write_json(os.path.join(w, "passa-bad.json"), {"verdict": "fail", "engine": "subagent", "confidence": 0.8, "violations": [{"target_text": "MALFORMED"}, vio("GOOD")], "escalate": False})
vx = vio("EX"); vx["EXTRA"] = "nope"   # required + extra key
atomic_write_json(os.path.join(w, "passa-extra.json"), {"verdict": "fail", "engine": "subagent", "confidence": 0.8, "violations": [vx], "escalate": False})
open(os.path.join(w, "passa-invalid.json"), "w").write("{not json")
PYEOF
check "(1b) cap=1 → 후보 1건" "[ \"$(python3 "$MERGE" candidates "$W2/baseline.json" "$W2/passa.json" 1 | grep -c .)\" = '1' ]"
check "(1b) cap=0 → 후보 0건(off-by-one 제거)" "[ \"$(python3 "$MERGE" candidates "$W2/baseline.json" "$W2/passa.json" 0 | grep -c .)\" = '0' ]"
python3 "$MERGE" merge "$W2/out.json" "$W2/baseline.json" "$W2/passa.json" "$W2/pb" "adk-http" 8
check "(1b) Pass-B 파일 누락 → default=refute(후보 제외, merged=baseline 0건)" "[ \"$(python3 -c "import json;print(len(json.load(open('$W2/out.json'))['violations']))")\" = '0' ]"
python3 "$MERGE" merge "$W2/out-inv.json" "$W2/baseline.json" "$W2/passa-invalid.json" "$W2/pb" "" 8 2>/dev/null
check "(1b) Pass-A invalid JSON → 크래시 없이 머지=baseline" "[ -f \"$W2/out-inv.json\" ] && [ \"$(python3 -c "import json;print(len(json.load(open('$W2/out-inv.json'))['violations']))")\" = '0' ]"
CN="$(python3 "$MERGE" candidates "$W2/baseline.json" "$W2/passa-bad.json" 8 | python3 -c "import sys,json;print(','.join(json.loads(l)['target_text'] for l in sys.stdin))")"
check "(1b) malformed 후보 필터(잘 형성된 GOOD 만, MALFORMED 제외)" "[ \"$CN\" = 'GOOD' ]"
EK="$(python3 "$MERGE" candidates "$W2/baseline.json" "$W2/passa-extra.json" 8 | python3 -c "import sys,json;print(','.join(sorted(json.loads(sys.stdin.readline()).keys())))")"
check "(1b) 후보 extra 키 제거(정확한 스키마 6키만 투영)" "[ \"$EK\" = 'axis,detected_by,rule,severity,suggested_rewrite,target_text' ]"
# (1c) malformed baseline → strict load 실패 → 비0 종료(fail-closed, 빈 baseline pass 위조 차단)
printf '{bad json' > "$W2/badbase.json"
python3 "$MERGE" merge "$W2/out-bad.json" "$W2/badbase.json" "$W2/passa.json" "$W2/pb" "" 8 2>/dev/null; RCB=$?
check "(1c) malformed baseline → merge 비0 종료 + 출력 미생성(fail-closed)" "[ $RCB -ne 0 ] && [ ! -f \"$W2/out-bad.json\" ]"
rm -rf "$W2"

# ── (1d~1f) pass+escalate 게이트 버그 수정(Opt-2): escalate 는 '차단' 신호 → verdict==pass 면 critic escalate 미전파 ──
WE="$(mktemp -d)"; mkdir -p "$WE/pb"
python3 - "$WE" "$ROOT" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(sys.argv[2], "scripts", "lib"))
from harness import atomic_write_json
w = sys.argv[1]
def vio(t, sev="high"): return {"target_text": t, "axis": "consumer_deception", "rule": "r", "severity": sev, "detected_by": "subagent", "suggested_rewrite": "x"}
# (1d) 깨끗한 통과 baseline + critic(passa)이 escalate:true(계약외 노이즈)
atomic_write_json(os.path.join(w, "base-pass.json"), {"verdict": "pass", "engine": "ruleset", "confidence": 0.9, "violations": [], "escalate": False})
atomic_write_json(os.path.join(w, "passa-esc.json"), {"verdict": "pass", "engine": "subagent", "confidence": 0.8, "violations": [], "escalate": True})
# (1e) 진짜 fail(baseline high)에 탄 critic escalate → 전파되어야(final_fail-게이트 형태 확인; 순진한 'base만' 아님)
atomic_write_json(os.path.join(w, "base-fail.json"), {"verdict": "fail", "engine": "ruleset", "confidence": 0.9, "violations": [vio("HI")], "escalate": False})
# (1f) 전문약 하드스톱: baseline escalate:true + high → 무조건 보존
atomic_write_json(os.path.join(w, "base-hardstop.json"), {"verdict": "fail", "engine": "ruleset", "confidence": 0.9, "violations": [vio("RX", "high")], "escalate": True})
atomic_write_json(os.path.join(w, "passa-noesc.json"), {"verdict": "pass", "engine": "subagent", "confidence": 0.8, "violations": [], "escalate": False})
PYEOF
python3 "$MERGE" merge "$WE/o-1d.json" "$WE/base-pass.json" "$WE/passa-esc.json" "$WE/pb" "adk-http" 8
V1D="$(python3 -c "import json;d=json.load(open('$WE/o-1d.json'));print(d['verdict'],d['escalate'])")"
check "(1d) 통과(위반0)+critic escalate=true → verdict=pass·escalate 미전파(거짓 escalated 방지)" "[ \"$V1D\" = 'pass False' ]"
python3 "$MERGE" merge "$WE/o-1e.json" "$WE/base-fail.json" "$WE/passa-esc.json" "$WE/pb" "adk-http" 8
V1E="$(python3 -c "import json;d=json.load(open('$WE/o-1e.json'));print(d['verdict'],d['escalate'])")"
check "(1e) fail(baseline high)에 탄 critic escalate=true → 전파(final_fail-게이트; base만 아님)" "[ \"$V1E\" = 'fail True' ]"
python3 "$MERGE" merge "$WE/o-1f.json" "$WE/base-hardstop.json" "$WE/passa-noesc.json" "$WE/pb" "adk-http" 8
V1F="$(python3 -c "import json;d=json.load(open('$WE/o-1f.json'));print(d['verdict'],d['escalate'])")"
check "(1f) 베이스라인 escalate=true(전문약 하드스톱) → verdict=fail·escalate=true(무조건 보존)" "[ \"$V1F\" = 'fail True' ]"
rm -rf "$WE"

# ── 로컬 ADK 목 서버 헬퍼(start_mock/stop_mock) 는 lib.sh 공용(K-5 승격) ──
# brief 까지 구동(offline stub) 후 approve --ra-ok → review 게이트(kcia 진입 조건). HARNESS_OFFLINE 은 lib.sh 기본=1.
seed_brief_review() {  # $1=rid
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" \
      && bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok ) >/dev/null 2>&1
}

# ── (2) 통합: 로컬 ADK 목으로 Pass-A→Pass-B fan-out (kcia-check.sh, 화장품=adk_critic 블록 보유) ──
#   온라인(HARNESS_OFFLINE unset) + 화장품 + 기록된 생성 토큰(claude) → resolve 0 → ADK 강제(REQUIRED) → Pass-A/B 실행.
RID=ci-cfan
# 생성 시점 엔진=claude(history 의 generate 토큰)로 기록 — kcia 의 GEN_CLI 판정용. (offline stub 생성이지만 엔진 라벨은 claude.)
( cd "$ROOT" && HARNESS_CLI=claude bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok ) >/dev/null 2>&1
VP="$ROOT/runs/$RID/01-brief/brief-verdict.json"
# Pass-A 가 두 후보(CONFIRM_OK, REFUTE_ME)를 올리고 Pass-B 가 REFUTE_ME 만 refute. ASCII 센티넬(룰셋 grounding 비충돌).
export ADK_MOCK_PASSA_TARGET="CONFIRM_OK 문맥,REFUTE_ME 약주장"
export ADK_MOCK_PASSA_AXIS="consumer_deception"
export ADK_MOCK_REFUTE_SUBSTR="REFUTE_ME"
start_mock
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
stop_mock
unset ADK_MOCK_PASSA_TARGET ADK_MOCK_PASSA_AXIS ADK_MOCK_REFUTE_SUBSTR
VT="$(python3 -c "import json;print(','.join(v['target_text'] for v in json.load(open('$VP'))['violations']))" 2>/dev/null || echo ERR)"
check "(2) Pass-A confirm 후보 → 최종 verdict 에 유지(CONFIRM_OK)" "echo \"$VT\" | grep -q 'CONFIRM_OK'"
check "(2) Pass-B refute 후보 → 최종 verdict 에서 제외(REFUTE_ME 없음)" "! echo \"$VT\" | grep -q 'REFUTE_ME'"
check "(2c) /tmp scratch 누수 없음(cleanup trap)" "[ -z \"$(ls -d ${TMPDIR:-/tmp}/kcia.* 2>/dev/null)\" ]"
check "(2) ADK critic 실행 → engine=ruleset+subagent" "[ \"$(python3 "$H" jget "$VP" engine)\" = 'ruleset+subagent' ]"
check "(2) critic_ran=true · review_depth=rule_engine+critic 가시화" \
  "python3 -c \"import json;d=json.load(open('$VP'));import sys;sys.exit(0 if d.get('critic_ran') is True and d.get('review_depth')=='rule_engine+critic' else 1)\""
rm -rf "$ROOT/runs/$RID"

# ── (2b) Pass-A 위반 0건(목이 빈 violations) → CONFIRM 없음, baseline 만(critic_ran=true 여도 후보 0) ──
RIDB=ci-cfan2
( cd "$ROOT" && HARNESS_CLI=claude bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDB" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RIDB" && bash scripts/approve.sh "$RIDB" --ra-ok ) >/dev/null 2>&1
VPB="$ROOT/runs/$RIDB/01-brief/brief-verdict.json"
export ADK_MOCK_PASSA_TARGET=""   # 위반 0건
start_mock
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "$RIDB" ) >/dev/null 2>&1
stop_mock
unset ADK_MOCK_PASSA_TARGET
# 유효 Pass-A(위반 0)는 정상 critic 실행 → engine=ruleset+subagent, critic_ran=true.
check "(2b) 빈 Pass-A(유효, 위반0) → critic_ran=true · engine=ruleset+subagent" \
  "[ \"$(python3 "$H" jget "$VPB" engine)\" = 'ruleset+subagent' ] && python3 -c \"import json;d=json.load(open('$VPB'));import sys;sys.exit(0 if d.get('critic_ran') is True else 1)\""
rm -rf "$ROOT/runs/$RIDB"

# ── (2e) retry-on-empty: 목이 첫 /run 만 빈 이벤트([]) → adk_critic 재시도 흡수 → 정상 Pass-A ──
RIDE=ci-cfane
( cd "$ROOT" && HARNESS_CLI=claude bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDE" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RIDE" && bash scripts/approve.sh "$RIDE" --ra-ok ) >/dev/null 2>&1
VPE="$ROOT/runs/$RIDE/01-brief/brief-verdict.json"
export ADK_MOCK_PASSA_TARGET="KEEP_ME 문맥"
export ADK_MOCK_EMPTY_FIRST=1
start_mock
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "$RIDE" ) >/dev/null 2>&1
stop_mock
unset ADK_MOCK_PASSA_TARGET ADK_MOCK_EMPTY_FIRST
VTE="$(python3 -c "import json;print(','.join(v['target_text'] for v in json.load(open('$VPE'))['violations']))" 2>/dev/null || echo ERR)"
check "(2e) 첫 응답 빈 이벤트 → 재시도 흡수 → KEEP_ME 후보 유지" "echo \"$VTE\" | grep -q 'KEEP_ME'"
rm -rf "$ROOT/runs/$RIDE"

# ── (2f) TMPDIR 이 작업영역 안 → 스냅샷이 critic 쓰기범위 안 → fail-closed(die) ──
#   (offline 이라 critic 미실행이어도 scratch 위치 가드는 critic 진입 전 — review 게이트 진입 즉시 평가됨.)
RIDF=ci-cfanf
seed_brief_review "$RIDF"
mkdir -p "$ROOT/.tmp-inside-ws"
OUTF="$( ( cd "$ROOT" && TMPDIR="$ROOT/.tmp-inside-ws" bash scripts/kcia-check.sh "$RIDF" ) 2>&1 )"; RCF=$?
check "(2f) TMPDIR 이 작업영역 안 → fail-closed(die + 메시지)" "[ $RCF -ne 0 ] && echo \"$OUTF\" | grep -q 'fail-closed'"
check "(2f) fail-closed die → 부분 verdict 미잔존(재실행 fail-open 차단)" "[ ! -f \"$ROOT/runs/$RIDF/01-brief/brief-verdict.json\" ]"
# 정상 TMPDIR(offline) 로 재실행 → 정상 심의 완료(02-concept 전이)
( cd "$ROOT" && bash scripts/kcia-check.sh "$RIDF" ) >/dev/null 2>&1
check "(2f) 정상 TMPDIR 재실행 → 심의 완료(02-concept 전이)" "[ \"$(jq_phase "$RIDF" phase)\" = '02-concept' ] && [ \"$(jq_phase "$RIDF" gate)\" = 'null' ]"
rm -rf "$ROOT/.tmp-inside-ws" "$ROOT/runs/$RIDF"

# ── (2g) retry 해석 우선순위: env ADK_CRITIC_RETRY > 팩 adk_critic.retry > 코드 기본 8 (O-2/D-1) ──
#   순수 단위(_resolve_retries) — 네트워크·파이프라인 없음. 빈응답 flaky 흡수 상향(3→8)이 기본값임을 고정.
RR="$( cd "$ROOT" && env -u ADK_CRITIC_RETRY python3 - <<'PY'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
import adk_critic as a
assert a._resolve_retries({"app": "x"}) == 8, "미지정 → 기본 8"
assert a._resolve_retries({}) == 8, "빈 cfg → 기본 8"
assert a._resolve_retries({"app": "x", "retry": 5}) == 5, "팩 retry 오버라이드"
os.environ["ADK_CRITIC_RETRY"] = "11"
assert a._resolve_retries({"app": "x", "retry": 5}) == 11, "env > 팩"
assert a._resolve_retries({}) == 11, "env 단독"
os.environ["ADK_CRITIC_RETRY"] = ""        # 빈문자열 = 미설정 취급(_env)
assert a._resolve_retries({"retry": 6}) == 6, "빈 env → 팩"
print("OK")
PY
)"
check "(2g) retry 우선순위 env>팩>기본8(=재시도 상향 3→8)" "[ \"$RR\" = 'OK' ]"

# ── (3) offline(CI) → 양 pass 스킵(critic 미실행, baseline 만) ──
RID3=ci-cfan3; rm -rf "$ROOT/runs/$RID3"
seed_brief_review "$RID3"
VP3="$ROOT/runs/$RID3/01-brief/brief-verdict.json"
# offline(lib.sh 기본=1)이라 ADK URL 이 설정돼 있어도 resolve 자체를 건너뛴다(결정성). 목은 띄우지 않는다(무네트워크).
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID3" ) >/dev/null 2>&1
check "(3) offline → engine=subagent(critic 미실행, baseline 동일성)" "[ \"$(python3 "$H" jget "$VP3" engine)\" = 'subagent' ]"
check "(3) offline → critic_ran=false · review_depth=rule_engine_only" \
  "python3 -c \"import json;d=json.load(open('$VP3'));import sys;sys.exit(0 if d.get('critic_ran') is False and d.get('review_depth')=='rule_engine_only' else 1)\""
rm -rf "$ROOT/runs/$RID3"

# ── (4) ADK 미구현 도메인(drug = adk_critic 블록 없음, resolve 4) → 룰엔진-단독(가시화) ──
#   온라인이어도 drug 는 ADK 블록이 없어 critic 을 생략(die 아님) → critic_ran=false·review_depth=rule_engine_only.
RIDD=ci-cfan-drug; rm -rf "$ROOT/runs/$RIDD"
( cd "$ROOT" && HARNESS_CLI=claude HARNESS_DOMAIN=drug HARNESS_FORMAT=multipage_bm bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDD" \
    && HARNESS_CLI=claude HARNESS_DOMAIN=drug bash scripts/run-stage.sh brief "$RIDD" && bash scripts/approve.sh "$RIDD" --ra-ok ) >/dev/null 2>&1
VPD="$ROOT/runs/$RIDD/01-brief/brief-verdict.json"
OUTD="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE bash scripts/kcia-check.sh "$RIDD" ) 2>&1 )"; RCD=$?
check "(4) drug(ADK 미구현) 온라인 심의 → die 아님(rc=0, 룰엔진-단독)" "[ $RCD -eq 0 ] && [ -f \"$VPD\" ]"
check "(4) 룰엔진-단독 가시화 → critic_ran=false · review_depth=rule_engine_only" \
  "python3 -c \"import json;d=json.load(open('$VPD'));import sys;sys.exit(0 if d.get('critic_ran') is False and d.get('review_depth')=='rule_engine_only' else 1)\""
check "(4) 사람 확인 권장 평이 안내(조용한 강등 금지)" "echo \"$OUTD\" | grep -q '사람 확인'"
rm -rf "$ROOT/runs/$RIDD"

# ── (5) 폐기된 critic 엔진 선언 → die(화이트리스트: 비움/adk-http 만) ──
RIDX=ci-cfan-eng; rm -rf "$ROOT/runs/$RIDX"
seed_brief_review "$RIDX"
for badeng in codex claude-subagent gpt; do
  OUTX="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE KCIA_CRITIC_ENGINE="$badeng" bash scripts/kcia-check.sh "$RIDX" ) 2>&1 )"; RCX=$?
  check "(5/$badeng) 폐기 critic 엔진 선언 → die(adk-http/미설정만)" "[ $RCX -ne 0 ] && echo \"$OUTX\" | grep -q 'KCIA_CRITIC_ENGINE'"
done
check "(5) 폐기 엔진 die 후 verdict 미생성(누수 없음)" "[ ! -f \"$ROOT/runs/$RIDX/01-brief/brief-verdict.json\" ]"
rm -rf "$ROOT/runs/$RIDX"

# ── (6) outline(no-copy) 구조 스켈레톤 → adk_critic passa benign skip(exit 7) → fail-closed 아님(룰엔진-단독) ──
#   실버그 회귀 가드: 03-storyboard outline 옵션은 블록 순서·intent 만 있는 구조 스켈레톤(광고 카피 필드 없음).
#   온라인+구현 도메인(화장품, auto KCIA_CRITIC_REQUIRED=1)에서 adk_critic passa 가 '심의할 카피 없음'을 감지하면
#   네트워크 호출 전에 전용 종료코드 7(no-copy benign skip)로 빠지고, kcia-check 는 timeout/failed 가 아닌 7 은
#   fail-closed 대상에서 제외해 룰엔진-단독(critic_ran=false·review_depth=rule_engine_only·rc=0)으로 정상 진행한다.
RS_COSMETIC="$( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash -c 'source scripts/lib/common.sh; domain_ruleset_abs cosmetic' )"   # 팩 룰셋 절대경로(DOM_RULESET_REL 관용; packs 는 core 형제라 상대 packs/… 는 cwd=core 에서 부재)

# ── (6a) 단위: adk_critic passa 가 카피 없는 대상 → exit 7(네트워크 전, benign skip) ──
#   대상은 작업영역(HARNESS_ROOT) '안'이어야 한다 — _selected_copy_text 가 작업영역 밖 경로를 egress 가드로 거부(rc=2≠7).
#   no-copy: _COPY_FILES 허용 파일(storyline.json)이지만 _COPY_KEYS(headline/copy/text…) 없는 구조 필드만 → 수집 텍스트 0 → exit 7.
NOCOPY="$(mktemp -d "$ROOT/.tmp-nocopy.XXXXXX")"; OUT6A="$(mktemp)"
cat > "$NOCOPY/storyline.json" <<'J6A'
{"block_order":["hook","problem","solution"],"blocks":[{"id":"b1","intent":"awareness","risk_tier":"high"},{"id":"b2","intent":"proof"}]}
J6A
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:1/" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    python3 "$ROOT/scripts/lib/adk_critic.py" passa \
      --selected-artifact "$NOCOPY" --domain cosmetic --ruleset "$RS_COSMETIC" --phase 03-storyboard --out "$OUT6A" ) >/dev/null 2>&1
RC6A=$?
check "(6a) 카피 없는 대상 → adk_critic passa exit 7(no-copy benign skip)" "[ $RC6A -eq 7 ]"
# (대조) 카피가 있는 대상(headline=실 카피)은 exit-7 게이트를 통과 → 도달 불가 URL 네트워크 단계에서 다른 코드로 실패(≠7).
COPYD="$(mktemp -d "$ROOT/.tmp-copy.XXXXXX")"; OUT6A2="$(mktemp)"
cat > "$COPYD/storyline.json" <<'J6A2'
{"block_order":["hook"],"headline":"촉촉한 수분 가득 데일리 쿠션"}
J6A2
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:1/" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    python3 "$ROOT/scripts/lib/adk_critic.py" passa \
      --selected-artifact "$COPYD" --domain cosmetic --ruleset "$RS_COSMETIC" --phase 03-storyboard --out "$OUT6A2" ) >/dev/null 2>&1
RC6A2=$?
check "(6a) 카피 있는 대상 → exit-7 게이트 통과(≠7; 네트워크 단계에서 다른 실패)" "[ $RC6A2 -ne 7 ]"
rm -rf "$NOCOPY" "$COPYD" "$OUT6A" "$OUT6A2"

# ── (6b) 통합: kcia-check 가 outline(no-copy) 온라인 심의 → fail-closed 아님, 룰엔진-단독 가시화 ──
#   offline stub 으로 화장품 런을 storyboard-outline 리뷰 게이트(select A 직후)까지 몬다. 생성 토큰=claude(kcia GEN_CLI 판정).
RID6=ci-cfan6b; rm -rf "$ROOT/runs/$RID6"
( cd "$ROOT" && HARNESS_CLI=claude bash scripts/ingest-bundle.sh "$BUNDLE" "$RID6" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID6" && bash scripts/approve.sh "$RID6" --ra-ok && bash scripts/kcia-check.sh "$RID6" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh concept "$RID6" && bash scripts/select.sh "$RID6" B && bash scripts/kcia-check.sh "$RID6" \
    && HARNESS_CLI=claude bash scripts/run-stage.sh storyboard-outline "$RID6" && bash scripts/select.sh "$RID6" A ) >/dev/null 2>&1
VP6="$ROOT/runs/$RID6/03-storyboard/outline-verdict.json"
SEL6="$ROOT/runs/$RID6/03-storyboard/outline/options/A"   # select.sh "$RID6" A → 선택안 = options/A
# 먼저 선택된 outline 옵션이 실제로 exit 7(no-copy)을 내는지 확인 — 거짓 그린 방지(stub outline 은 구조 스켈레톤이라 정상적으로 exit 7).
OUT6PRE="$(mktemp)"
( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:1/" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    python3 "$ROOT/scripts/lib/adk_critic.py" passa \
      --selected-artifact "$SEL6" --domain cosmetic --ruleset "$RS_COSMETIC" --phase 03-storyboard --out "$OUT6PRE" ) >/dev/null 2>&1
RC6PRE=$?; rm -f "$OUT6PRE"
check "(6b) 선택된 outline 옵션이 자연히 no-copy(exit 7) — 거짓 그린 아님" "[ $RC6PRE -eq 7 ]"
# 온라인으로 outline kcia-check 실행(목 서버 가동 — preflight 통과용; passa 는 그 전에 exit 7 이라 ADK_MOCK_* 불필요).
start_mock
OUT6="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "$RID6" ) 2>&1 )"; RC6=$?
stop_mock
check "(6b) outline no-copy 온라인 심의 → fail-closed 아님(rc=0, verdict 생성)" "[ $RC6 -eq 0 ] && [ -f \"$VP6\" ]"
check "(6b) 룰엔진-단독 가시화: critic_ran=false · review_depth=rule_engine_only" \
  "python3 -c \"import json;d=json.load(open('$VP6'));import sys;sys.exit(0 if d.get('critic_ran') is False and d.get('review_depth')=='rule_engine_only' else 1)\""
check "(6b) benign-skip 평이 안내(광고 카피 없음 + 구조 단계)" "echo \"$OUT6\" | grep -q '광고 카피가 없' && echo \"$OUT6\" | grep -q '구조 단계'"
rm -rf "$ROOT/runs/$RID6"

printf '\n[critic-fanout] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
