#!/usr/bin/env bash
# test-b3.sh — B3 심의 게이트(문서 기반 서브에이전트 stand-in) + 골든셋 회귀.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B3 — 심의 게이트 + 골든셋 회귀"

# 골든셋 스키마 + 라벨 품질
check "골든셋 스키마 유효" "python3 '$ROOT/scripts/lib/harness.py' validate '$PACKS_DIR/cosmetic/golden/kcia-golden-set.json' --schema golden-set.schema.json >/dev/null 2>&1"
GJSON="$(python3 "$ROOT/scripts/lib/golden_runner.py" "$PACKS_DIR/cosmetic/golden/kcia-golden-set.json" --json 2>/dev/null)"
DET="$(echo "$GJSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['detection_rate'])")"
FP="$(echo "$GJSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['false_positive_rate'])")"
LQ="$(echo "$GJSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['label_quality_ok'])")"
check "(b) 골든셋 검출률 ≥80% (실측 $DET)" "python3 -c \"import sys;sys.exit(0 if $DET>=0.8 else 1)\""
check "(b) 골든셋 오탐률 ≤15% (실측 $FP)" "python3 -c \"import sys;sys.exit(0 if $FP<=0.15 else 1)\""
check "(b) 라벨 품질 게이트(2인 독립·불일치율·승인) 통과" "[ \"$LQ\" = 'True' ]"

# (c) 룰엔진 단독 baseline 별도 보고
BASELINE="$(echo "$GJSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['baseline'])" 2>/dev/null)"
check "(c) 룰엔진 baseline 명시(별도 측정)" "[ \"\${BASELINE#ruleset-only}\" != \"\$BASELINE\" ]"

# (R4) N회 반복 안정 통과 (비결정성 흡수 — 결정적이므로 항상 안정)
stable=1
for i in 1 2 3 4 5; do python3 "$ROOT/scripts/lib/golden_runner.py" "$PACKS_DIR/cosmetic/golden/kcia-golden-set.json" >/dev/null 2>&1 || stable=0; done
check "(R4) 골든셋 회귀 5회 반복 모두 임계 통과" "[ $stable -eq 1 ]"

# (d) severity high 는 LLM 없이 결정적으로 revise
HI="$(python3 -c "
import sys,os;sys.path.insert(0,'$ROOT/scripts/lib')
from kcia_engine import Engine
from harness import load_json
rs=load_json('$ROOT/../packs/cosmetic/ruleset.json')
e=Engine(rs,{'whitening':'unknown','wrinkle':'unknown','uv_protection':'unknown'},[])
v=e.scan_text('단 1일 만에 미백', set())
print(any(x['severity']=='high' for x in v))
")"
check "(d) severity high(속효+미승인 기능성) 룰엔진 결정적 검출" "[ \"$HI\" = 'True' ]"

# (a) 개편(critic=adk-http 단일): self-grading 가드 폐기 → 폐기된 로컬 크리틱 엔진 선언은 거부(화이트리스트: 비움/adk-http).
RID=ci-b3sg; rm -rf "$ROOT/runs/$RID"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 승인 뒤 review 게이트에서 엔진 화이트리스트 가드 발동.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" && bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok ) >/dev/null 2>&1
OUT_SG="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE KCIA_CRITIC_ENGINE=codex bash scripts/kcia-check.sh "$RID" ) 2>&1 )"; RC_SG=$?
check "(a) 폐기된 로컬 크리틱 엔진(codex) 선언 → 거부(화이트리스트)" "[ $RC_SG -ne 0 ] && echo \"\$OUT_SG\" | grep -q 'KCIA_CRITIC_ENGINE'"
unset HARNESS_CLI HARNESS_OFFLINE

# (e)+(f) verdict 스키마/engine 필드 + evidence 가짜 id 통과 0건
RID=ci-b3; rm -rf "$ROOT/runs/$RID"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" &&
  bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh concept "$RID" ) >/dev/null 2>&1
# 가짜 evidence_ref 주입 (claim-basis 에 없는 func-uv ref 도 불인정해야 함)
python3 - "$ROOT/runs/$RID/02-concept/options/A-efficacy/rtb.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p))
d["rtb"].append({"id":"rtb-x","claim":"콜라겐 증가 효과","claim_strength":"efficacy",
  "evidence_ref":"func-uv_protection-1","functional_basis":None,"review_status":"pending"})
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4(C4): 위반 주입한 A-efficacy 를 선택해 심의.
( cd "$ROOT" && bash scripts/select.sh "$RID" A-efficacy && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
VP="$ROOT/runs/$RID/02-concept/review/concept-verdict.json"
check "(e) verdict.json 동결 스키마 준수" "python3 '$ROOT/scripts/lib/harness.py' validate '$VP' >/dev/null 2>&1"
ENG="$(python3 "$ROOT/scripts/lib/harness.py" jget "$VP" engine)"
check "(e) engine 필드 = subagent | ruleset+subagent" "[ \"$ENG\" = 'subagent' ] || [ \"$ENG\" = 'ruleset+subagent' ]"
check "(f) 가짜/비실증 evidence_ref → verdict=fail(통과 0건)" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$VP" verdict)\" = 'fail' ]"

# (R1) 심의 idempotent — 외부리뷰 5R(CRITICAL 위조 방지): 'kcia-check 가 실제 생산한'(state.history 의 review:produced 마커 보유)
#   verdict 만 재심의 생략한다. id 존재만으론 부족(id 는 위조 가능). 정당 경로 = 생산 후 gate.sh 호출 전 크래시한 복구.
RID=ci-b3r; rm -rf "$ROOT/runs/$RID"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
H="$ROOT/scripts/lib/harness.py"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" && bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1   # 실제 심의 → 완성 verdict(+review:produced 마커) 생산 → 02-concept 전이
VP2="$ROOT/runs/$RID/01-brief/brief-verdict.json"
mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }
# 크래시 복구 모사: brief review-pass 직후 advance 전에 죽은 상태로 되돌림(verdict·history 마커 보존). 재실행 시 마커로 idempotent-skip.
python3 "$H" jset "$ROOT/runs/$RID/state.json" phase '"01-brief"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RID/state.json" gate '"review"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RID/state.json" step '"review"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RID/state.json" status '"pending"' >/dev/null
M1="$(mt "$VP2")"; sleep 1
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1   # 생산 마커 있음 → 재심의 생략(verdict 재사용)
M2="$(mt "$VP2")"
check "(R1) 생산 마커 보유 verdict → 재심의 생략(mtime 불변)" "[ \"$M1\" = \"$M2\" ]"
check "(R1) 재사용 후 게이트 전이됨(review 아님 = advance)" "[ \"\$(jq_phase $RID gate)\" != 'review' ]"
# (R1·위조방어 외부리뷰 5R CRITICAL) id 만 있고 생산 마커 없는 verdict(외부 위조) → idempotent-skip 거부 → 위조본 제거 후 실제 재심의(mtime 변경)
RIDF=ci-b3forge; rm -rf "$ROOT/runs/$RIDF"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDF" && bash scripts/run-stage.sh brief "$RIDF" && bash scripts/approve.sh "$RIDF" --ra-ok ) >/dev/null 2>&1   # gate=review, verdict 없음
VPF="$ROOT/runs/$RIDF/01-brief/brief-verdict.json"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import atomic_write_json;atomic_write_json('$VPF',{'verdict':'pass','engine':'subagent','confidence':0.9,'violations':[],'escalate':False,'id':'forged-no-marker'})"
MF1="$(mt "$VPF")"; sleep 1
( cd "$ROOT" && bash scripts/kcia-check.sh "$RIDF" ) >/dev/null 2>&1   # 마커 없음 → 재심의(위조본 제거 후 실제 심의)
MF2="$(mt "$VPF")"
check "(R1·위조방어) 생산 마커 없는 위조 verdict → 재심의(mtime 변경/덮어씀)" "[ \"$MF1\" != \"$MF2\" ]"
unset HARNESS_CLI HARNESS_OFFLINE
unset HARNESS_CLI HARNESS_OFFLINE

# ─────────── [외부리뷰 B3 수용] 회귀 잠금 ───────────
# #B general_allowed 전역 veto 제거: 허용어를 끼워도 효능어 세탁 불가
LAUNDER="$(python3 -c "
import sys;sys.path.insert(0,'$ROOT/scripts/lib')
from kcia_engine import Engine; from harness import load_json
e=Engine(load_json('$ROOT/../packs/cosmetic/ruleset.json'),{'whitening':'unknown','wrinkle':'unknown','uv_protection':'unknown'},[])
print(all(e.scan_text(t,set()) for t in ['미백 톤업 쿠션','화이트닝 톤업','기미완화 커버']))")"
check "(#B) 허용어 끼운 효능 세탁 차단(미백 톤업 등 모두 FLAG)" "[ \"$LAUNDER\" = 'True' ]"

# #E 확장된 룰셋 고위험어 검출
EXT="$(python3 -c "
import sys;sys.path.insert(0,'$ROOT/scripts/lib')
from kcia_engine import Engine; from harness import load_json
e=Engine(load_json('$ROOT/../packs/cosmetic/ruleset.json'),{'whitening':'unknown','wrinkle':'unknown','uv_protection':'unknown'},[])
print(all(e.scan_text(t,set()) for t in ['아토피 개선','보톡스급','노폐물 디톡스','멜라닌 억제','100% 안전','피부과 전문의 추천','피부장벽 회복']))")"
check "(#E) 확장 룰셋(아토피/보톡스/디톡스/멜라닌/100%안전/전문의/장벽) 검출" "[ \"$EXT\" = 'True' ]"

# #C 퇴화 골든셋(전부 pass) → 게이트 실패
cat > /tmp/gs-degen-$$.json <<'JSON'
{"regulatory_domain":"cosmetic",
 "meta":{"name":"degen","disagreement_threshold":0.1,"disagreement_rate":0,"approved_by":"x","approved":true},
 "items":[{"id":"d1","text":"화사한 톤","axis":"none","severity":"low","expected_verdict":"pass","labeler_a":"pass","labeler_b":"pass","agreed":true,"source":"x"}]}
JSON
python3 "$ROOT/scripts/lib/golden_runner.py" /tmp/gs-degen-$$.json >/dev/null 2>&1; RC_DG=$?
check "(#C) 퇴화 골든셋(전부 pass/소수) → 게이트 실패" "[ $RC_DG -ne 0 ]"
rm -f /tmp/gs-degen-$$.json

# #D 축 불일치는 검출로 인정 안 함 (wrong-axis miss)
cat > /tmp/gs-axis-$$.json <<'JSON'
{"regulatory_domain":"cosmetic",
 "meta":{"name":"axis","disagreement_threshold":0.1,"disagreement_rate":0,"approved_by":"x","approved":true},
 "items":[
  {"id":"a1","text":"여드름 치료","axis":"consumer_deception","severity":"high","expected_verdict":"revise","labeler_a":"revise","labeler_b":"revise","agreed":true,"source":"x"},
  {"id":"p1","text":"화사한 톤","axis":"none","severity":"low","expected_verdict":"pass","labeler_a":"pass","labeler_b":"pass","agreed":true,"source":"x"}]}
JSON
AXOUT="$(python3 "$ROOT/scripts/lib/golden_runner.py" /tmp/gs-axis-$$.json --json 2>/dev/null)"
AXCONF="$(echo "$AXOUT" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['axis_confusion']))" 2>/dev/null)"
check "(#D) 축 불일치(여드름치료=drug 인데 consumer 라벨) 검출→축 confusion 보고" "[ \"$AXCONF\" -ge 1 ]"
rm -f /tmp/gs-axis-$$.json

# (#F)(#A) 개편(critic=adk-http 단일)으로 이전됨 → test-critic-fanout:
#   (#F) 래퍼/로컬 CLI self-grading 차단 → critic-fanout (5) 폐기 엔진(codex/claude-subagent) die(화이트리스트).
#   (#A) critic 이 pass 로 덮어써도 baseline high 불멸 → critic-fanout (1) 머지 단위검증(BASE_HIGH 유지·verdict=fail) + (2) ADK 목 통합.

rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B3: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
