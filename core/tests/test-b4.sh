#!/usr/bin/env bash
# test-b4.sh — B4 스토리보드(아웃라인→기획안) + 근거(수동 mock) + enabled_if + 주장-각주.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B4 — 스토리보드(아웃라인→기획안) + 근거 mock"

drive_to_storyboard() {  # $1=rid — 03-storyboard generate 직전까지(아웃라인 생성 직전, substage=outline/step=generate)
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  export HARNESS_CLI=claude HARNESS_OFFLINE=1
  # M4 순서: 생성 → 사람 승인/선택 → 심의 → 전이. (단안 brief=approve --ra-ok, 다안 concept=select)
  ( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" B && bash scripts/kcia-check.sh "$rid" ) >/dev/null 2>&1
  unset HARNESS_CLI HARNESS_OFFLINE
}

RID=ci-b4
drive_to_storyboard "$RID"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID" ) >/dev/null 2>&1

# (a) 12블록 스토리라인 2안
check "(a) 스토리라인 2안(A/B) 생성" "[ -f '$ROOT/runs/$RID/03-storyboard/outline/options/A/storyline.json' ] && [ -f '$ROOT/runs/$RID/03-storyboard/outline/options/B/storyline.json' ]"

# (a) enabled_if: 실증 미등록(evidence_on_file==[]) → clinicalEvidence/beforeAfter 자동 제외 (환각 차단)
EXCL="$(python3 -c "
import json
sl=json.load(open('$ROOT/runs/$RID/03-storyboard/outline/options/A/storyline.json'))
types=[b['type'] for b in sl['blocks']]
print('OK' if ('clinicalEvidence' not in types and 'beforeAfter' not in types) else 'BAD:%s'%types)
")"
check "(a) 실증 미등록 → clinicalEvidence/beforeAfter 스토리라인 제외" "[ \"$EXCL\" = 'OK' ]"

# (d) sources/results.json 은 오프라인 stub 경로(범위 안)로 작성됨: stub_stage 가 search_stub(engine=manual) 로
#     결정적 mock 을 쓴다(온라인 자동 OpenAlex 는 evidence_search.py 경로 — 별도 test-openalex.sh 가 커버).
#     트리거 없으면 빈 결과 + evidence_sufficient=false.
check "(d) sources/results.json (오프라인 stub: search_stub(engine=manual)) 생성" "python3 '$ROOT/scripts/lib/harness.py' validate '$ROOT/runs/$RID/03-storyboard/sources/results.json' >/dev/null 2>&1"
ES="$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID/03-storyboard/sources/results.json" evidence_sufficient)"
check "(d) 트리거 없음 → evidence_sufficient=false (범위 안: 오프라인 stub 경로 stub_stage→search_stub)" "[ \"$ES\" = 'false' ]"

# 아웃라인 선택·심의 → 기획안 생성 (M4: 다안 outline 은 select 먼저 → kcia-check → 전이 후 plan 생성)
( cd "$ROOT" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-plan "$RID" ) >/dev/null 2>&1

# (c) 블록 단위 기획안 파일 (부분 재생성 가능 구조)
NBLK="$(ls "$ROOT"/runs/$RID/03-storyboard/plan/*.json 2>/dev/null | wc -l | tr -d ' ')"
check "(c) 블록 단위 plan/NN-type.json 생성 (≥8 블록)" "[ \"$NBLK\" -ge 8 ]"
check "(a) 기획안에도 clinicalEvidence 블록 없음(실증 미등록)" "[ \"\$(ls $ROOT/runs/$RID/03-storyboard/plan/*clinical* 2>/dev/null | wc -l | tr -d ' ')\" = '0' ]"

# (b) 주장-각주 페어링: efficacy 강주장에 각주 없으면 자동 revise
python3 - "$ROOT/runs/$RID/03-storyboard/plan/01-hero.json" <<'PYEOF'
import json,sys
p=sys.argv[1];b=json.load(open(p))
b["claims"].append({"target_text":"콜라겐 증가 입증","claim_strength":"efficacy","evidence_ref":"ev-FAKE","footnote_id":None})
json.dump(b,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4: plan(단안) 은 생성 후 gate=user → approve(plan 은 --ra-ok 불필요, export 없음) → 심의가 위반을 잡는다.
( cd "$ROOT" && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
PV="$ROOT/runs/$RID/03-storyboard/plan-verdict.json"
check "(b) 강주장+각주부재/가짜근거 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$PV" verdict)\" = 'fail' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# enabled_if '활성' 경로: 실증 등록 시 clinicalEvidence/beforeAfter 포함
RID2=ci-b4ev; rm -rf "$ROOT/runs/$RID2"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# 실증 보유 WB(fixture)로 ingest (claim-basis 에 evidence_on_file 채워짐) — HARNESS_WB 로 직접 지정(공유 inputs swap 제거)
( cd "$ROOT" && HARNESS_WB="$PACKS_DIR/cosmetic/golden/wb-with-evidence.md" bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" ) >/dev/null 2>&1
EVN="$(python3 -c "import json;print(len(json.load(open('$ROOT/runs/$RID2/00-ingest/claim-basis.json'))['evidence_on_file']))")"
check "(enabled_if) 실증 WB → evidence_on_file ≥1" "[ \"$EVN\" -ge 1 ]"
# (provenance) evidence source 도 source.from 과 동일하게 run 사본을 가리킴(Codex medium#1 — basename 잔재 제거)
EVSRC="$(python3 -c "import json;e=json.load(open('$ROOT/runs/$RID2/00-ingest/claim-basis.json'))['evidence_on_file'];print(e[0]['source'] if e else 'NONE')")"
check "(provenance) evidence source = run 사본 경로(inputs/working-backwards.md)" "[ \"$EVSRC\" = 'inputs/working-backwards.md' ]"
# M4 순서: 생성 → 승인/선택 → 심의 → 전이. (brief=approve --ra-ok, concept=select)
( cd "$ROOT" && bash scripts/run-stage.sh brief "$RID2" && bash scripts/approve.sh "$RID2" --ra-ok && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh concept "$RID2" && bash scripts/select.sh "$RID2" B && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh storyboard-outline "$RID2" ) >/dev/null 2>&1
INCL="$(python3 -c "
import json
sl=json.load(open('$ROOT/runs/$RID2/03-storyboard/outline/options/A/storyline.json'))
types=[b['type'] for b in sl['blocks']]
print('OK' if ('clinicalEvidence' in types and 'beforeAfter' in types) else 'BAD:%s'%types)
")"
check "(enabled_if) 실증 등록 시 clinicalEvidence/beforeAfter 포함" "[ \"$INCL\" = 'OK' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# (e) 임의 단계 중단 후 다른 CLI 로 재개 성공 (MS1 재개 1회)
RID3=ci-b4r; drive_to_storyboard "$RID3"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 다안 outline = 생성 → select → 심의(전이). 선택 뒤 심의로 substage=plan 전이.
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID3" && bash scripts/select.sh "$RID3" A && bash scripts/kcia-check.sh "$RID3" ) >/dev/null 2>&1
PLAN_MT_DIR="$ROOT/runs/$RID3/03-storyboard/outline/options/A/storyline.json"
mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }
OUTLINE_MT1="$(mt "$PLAN_MT_DIR")"; sleep 1
export HARNESS_CLI=codex   # 다른 CLI 로 재개
# M4: 단안 plan = 생성 → approve(--ra-ok 불필요) → 심의 통과해야 04-keyvisual 로 전이.
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-plan "$RID3" && bash scripts/approve.sh "$RID3" && bash scripts/kcia-check.sh "$RID3" ) >/dev/null 2>&1
RC_RES=$?
unset HARNESS_CLI HARNESS_OFFLINE
check "(e) 다른 CLI 로 재개해 기획안 완성·승인→04-keyvisual" "[ $RC_RES -eq 0 ] && [ \"\$(jq_phase $RID3 phase)\" = '04-keyvisual' ]"
check "(e) 재개 시 완료된 아웃라인 비재생성(mtime 불변)" "[ \"$OUTLINE_MT1\" = \"\$(mt "$PLAN_MT_DIR")\" ]"

# (R2) 동시 approve 시 lock 친절 종료
RID4=ci-b4c; drive_to_storyboard "$RID4"
hold_lock "$ROOT/runs/$RID4"
OUT_LK="$( ( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID4" ) 2>&1 )"; RC_LK=$?
release_held "$ROOT/runs/$RID4"
check "(R2) 동시 실행 lock 친절 종료" "[ $RC_LK -ne 0 ] && echo \"\$OUT_LK\" | grep -q '다른 작업이 진행 중'"

# ─────────── [Codex B4 리뷰 수용] 회귀 잠금 ───────────
# #2 A/B 스토리라인 순서가 실제로 다르다
RID5=ci-b4d; drive_to_storyboard "$RID5"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID5" ) >/dev/null 2>&1
DIST="$(python3 -c "
import json
a=[x['type'] for x in json.load(open('$ROOT/runs/$RID5/03-storyboard/outline/options/A/storyline.json'))['blocks']]
b=[x['type'] for x in json.load(open('$ROOT/runs/$RID5/03-storyboard/outline/options/B/storyline.json'))['blocks']]
print('DISTINCT' if a!=b else 'SAME')")"
check "(#2) A/B 스토리라인 전개 순서 상이" "[ \"$DIST\" = 'DISTINCT' ]"

# #1 enabled_if 를 validate-stage 가 강제(stub 외): 실증 미등록인데 clinicalEvidence 주입 → validate 거부
python3 - "$ROOT/runs/$RID5/03-storyboard/outline/options/A/storyline.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p))
d["blocks"].append({"order":99,"type":"clinicalEvidence","intent":"실증","risk_tier":"high","enabled_if":"x"})
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
OUT_EI="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RID5" 03-storyboard ) 2>&1 )"; RC_EI=$?
check "(#1) 실증 미등록인데 clinicalEvidence 주입 → validate-stage 거부" "[ $RC_EI -ne 0 ] && echo \"\$OUT_EI\" | grep -q '게이트 블록'"
unset HARNESS_CLI HARNESS_OFFLINE

# #5 컨셉에 실증 트리거가 있으면 query.json 에 기록
RID6=ci-b4q; drive_to_storyboard "$RID6"   # 선택 컨셉 = B-emotional
python3 - "$ROOT/runs/$RID6/02-concept/options/B-emotional/rtb.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p));d["rtb"][0]["claim"]="콜라겐 함유 성분"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID6" ) >/dev/null 2>&1
QC="$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID6/03-storyboard/sources/query.json" claim)"
check "(#5) 컨셉 트리거(콜라겐) → query.json.claim 기록" "[ \"$QC\" != 'null' ] && [ -n \"$QC\" ]"
unset HARNESS_CLI HARNESS_OFFLINE

# #4 evidence_sufficient=false 인 sources id 는 신뢰 안 함
RID7=ci-b4s
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4 순서: 각 페이즈 생성 → 승인/선택 → 심의 → 전이. (단안 brief=approve --ra-ok, 다안 concept/outline=select)
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID7" &&
  bash scripts/run-stage.sh brief "$RID7" && bash scripts/approve.sh "$RID7" --ra-ok && bash scripts/kcia-check.sh "$RID7" &&
  bash scripts/run-stage.sh concept "$RID7" && bash scripts/select.sh "$RID7" B && bash scripts/kcia-check.sh "$RID7" &&
  bash scripts/run-stage.sh storyboard-outline "$RID7" && bash scripts/select.sh "$RID7" A && bash scripts/kcia-check.sh "$RID7" &&
  bash scripts/run-stage.sh storyboard-plan "$RID7" ) >/dev/null 2>&1
python3 - "$ROOT/runs/$RID7/03-storyboard/sources/results.json" <<'PYEOF'
import json,sys
p=sys.argv[1];json.dump({"results":[{"id":"W9","title":"t","grade":"SCI/SCIE","year":2023,"doi":None,"abstract_ko":"a"}],"evidence_sufficient":False,"engine":"manual"},open(p,"w"),ensure_ascii=False)
PYEOF
python3 - "$ROOT/runs/$RID7/03-storyboard/plan/01-hero.json" <<'PYEOF'
import json,sys
p=sys.argv[1];b=json.load(open(p))
b["claims"].append({"target_text":"효능","claim_strength":"efficacy","evidence_ref":"W9","footnote_id":"fn-9"})
b["footnotes"].append({"id":"fn-9","text":"각주"})
json.dump(b,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4: plan(단안) 은 승인(gate=user→review) 뒤 심의가 약한 근거 참조를 잡는다.
( cd "$ROOT" && bash scripts/approve.sh "$RID7" && bash scripts/kcia-check.sh "$RID7" ) >/dev/null 2>&1
check "(#4) evidence_sufficient=false 인 근거 id 참조 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID7/03-storyboard/plan-verdict.json" verdict)\" = 'fail' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# #7 블록 단위 재개: 일부 블록 삭제 후 재실행 → 누락 블록만 재생성, 나머지 mtime 불변
RID8=ci-b4b; drive_to_storyboard "$RID8"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 다안 outline = 생성 → select → 심의(전이) → plan 생성 → approve(gate=user→review).
#   plan 생성 직후 gate=user 라 run-stage 재호출이 막힌다. approve 로 review 게이트에 두면(심의 직전)
#   누락 블록 보충(idempotent) 재개 경로가 열린다(나머지 유효 블록은 보존).
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RID8" && bash scripts/select.sh "$RID8" A && bash scripts/kcia-check.sh "$RID8" && bash scripts/run-stage.sh storyboard-plan "$RID8" && bash scripts/approve.sh "$RID8" ) >/dev/null 2>&1
PD="$ROOT/runs/$RID8/03-storyboard/plan"
KEEP="$(ls "$PD"/*.json | grep -v '01-hero' | head -1)"
KEEP_MT="$(mt "$KEEP")"; rm -f "$PD/01-hero.json"; sleep 1
# 재개: review 게이트에서 누락 블록만 보충(나머지 유효 블록은 보존·mtime 불변). 직접 plan-block 재호출 경로 검증.
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-plan "$RID8" ) >/dev/null 2>&1 || true
check "(#7) 삭제된 블록(01-hero) 재생성됨" "[ -f '$PD/01-hero.json' ]"
check "(#7) 나머지 블록 비재생성(mtime 불변)" "[ \"$KEEP_MT\" = \"\$(mt "$KEEP")\" ]"
unset HARNESS_CLI HARNESS_OFFLINE

# #8 gate.sh select 가드: select 게이트 아닐 때 직접 호출 거부
RID9=ci-b4g
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID9" && bash scripts/run-stage.sh brief "$RID9" ) >/dev/null 2>&1
OUT_G="$( ( cd "$ROOT" && bash scripts/gate.sh "$RID9" select ) 2>&1 )"; RC_G=$?
check "(#8) select 게이트 아닐 때 gate.sh select 거부" "[ $RC_G -ne 0 ] && echo \"\$OUT_G\" | grep -q 'select 게이트'"
unset HARNESS_CLI HARNESS_OFFLINE

# (outline-bypass·3R Critical + plan-fc·2R High) — 한 런으로 두 우회 가드 검증
H="$ROOT/scripts/lib/harness.py"
RIDPF=ci-b4-fc; drive_to_storyboard "$RIDPF"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline "$RIDPF" && bash scripts/select.sh "$RIDPF" A ) >/dev/null 2>&1
# (outline-bypass) gate=review·substage=outline 에서 outline-verdict=pass 직접 쓰고 no-arg advance → 거부(03→04 plan 우회 차단)
echo '{"verdict":"pass","engine":"x","confidence":1.0,"violations":[],"escalate":false}' > "$ROOT/runs/$RIDPF/03-storyboard/outline-verdict.json"
OUT_OB="$( ( cd "$ROOT" && bash scripts/advance-phase.sh "$RIDPF" ) 2>&1 )"; RC_OB=$?
check "(outline-bypass) 03 outline no-arg advance → 거부(plan 우회 차단)" "[ $RC_OB -ne 0 ] && [ \"\$(jq_phase $RIDPF phase)\" = '03-storyboard' ]"
# 정상 진행: kcia-check(outline→plan 전이) → plan 생성
( cd "$ROOT" && bash scripts/kcia-check.sh "$RIDPF" && bash scripts/run-stage.sh storyboard-plan "$RIDPF" ) >/dev/null 2>&1
# (plan-bypass·4R High) plan 존재·plan-verdict=pass 라도 gate.sh review-pass 마커 없이 직접 no-arg advance → 거부(plan 검증 우회 차단)
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" gate '"review"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" status '"pending"' >/dev/null
echo '{"verdict":"pass","engine":"x","confidence":1.0,"violations":[],"escalate":false}' > "$ROOT/runs/$RIDPF/03-storyboard/plan-verdict.json"
OUT_PB="$( ( cd "$ROOT" && bash scripts/advance-phase.sh "$RIDPF" ) 2>&1 )"; RC_PB=$?
check "(plan-bypass) gate.sh review 마커 없이 no-arg advance → 거부" "[ $RC_PB -ne 0 ] && [ \"\$(jq_phase $RIDPF phase)\" = '03-storyboard' ] && echo \"\$OUT_PB\" | grep -q 'review-pass'"
# (plan-fc) plan substage 인데 plan 산출물 부재 → kcia-check verdict=fail (무내용 pass 차단·legacy flip 방어)
rm -rf "$ROOT/runs/$RIDPF/03-storyboard/plan"            # 손상/legacy 모사: plan 산출물 제거
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" storyboard_substage '"plan"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" step '"review"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" gate '"review"' >/dev/null
python3 "$H" jset "$ROOT/runs/$RIDPF/state.json" status '"pending"' >/dev/null
( cd "$ROOT" && bash scripts/kcia-check.sh "$RIDPF" ) >/dev/null 2>&1
PFV="$(python3 "$H" jget "$ROOT/runs/$RIDPF/03-storyboard/plan-verdict.json" verdict 2>/dev/null || echo MISSING)"
check "(plan-fc) plan substage·산출물 부재 → verdict=fail(무내용 pass 차단)" "[ \"$PFV\" = 'fail' ]"
unset HARNESS_CLI HARNESS_OFFLINE

rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B4: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
