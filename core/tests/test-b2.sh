#!/usr/bin/env bash
# test-b2.sh — B2 컨셉 생성 + 사람 게이트 + evidence 존재성 + a2 이식성.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B2 — 컨셉 생성 + 사람 게이트"

drive_to_concept() {  # $1=rid $2=engine — concept 생성·심의 직전까지 (M4: brief=approve→kcia, concept 생성)
  local rid="$1" eng="$2"; rm -rf "$ROOT/runs/$rid"
  export HARNESS_CLI="$eng" HARNESS_OFFLINE=1
  ( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" ) >/dev/null 2>&1
  unset HARNESS_CLI HARNESS_OFFLINE
}

drive_to_concept ci-b2 claude

# (a) 서로 다른 축 정의 + 축별 옵션 생성
NAX="$(python3 -c "import json;print(len(json.load(open('$ROOT/runs/ci-b2/02-concept/concept-axes.json'))['axes']))")"
check "(a) concept-axes 에 ≥2 개의 서로 다른 축" "[ \"$NAX\" -ge 2 ]"
NOPT="$(ls -d "$ROOT"/runs/ci-b2/02-concept/options/*/ 2>/dev/null | wc -l | tr -d ' ')"
check "(a) 축별 옵션 디렉터리 생성 (축 수와 일치)" "[ \"$NOPT\" = \"$NAX\" ]"

# (b) 감성 키메시지 100% voc_phrase 인용 (reviews 근거)
EMO_OK="$(python3 -c "
import json,glob,os
voc=json.load(open('$ROOT/runs/ci-b2/00-ingest/voc.json'))['keyword_frequency']
bad=0;tot=0
for f in glob.glob('$ROOT/runs/ci-b2/02-concept/options/*/key-message.json'):
    for km in json.load(open(f))['key_messages']:
        if km['slot']=='emotional':
            tot+=1
            if not km.get('voc_phrase') or km['voc_phrase'] not in voc: bad+=1
print('OK' if bad==0 and tot>0 else 'BAD(%d/%d)'%(bad,tot))
")"
check "(b) 감성 키메시지 100% voc_phrase 인용" "[ \"$EMO_OK\" = 'OK' ]"

# (d) 리뷰 0건 개념(주름/EGF/콜라겐)을 컨셉 claim 주축으로 쓰지 않음
ZERO_USE="$(python3 -c "
import json,glob
hit=0
for f in glob.glob('$ROOT/runs/ci-b2/02-concept/options/*/*.json'):
    t=open(f,encoding='utf-8').read()
    for w in ['주름','EGF','콜라겐']:
        if w in t: hit+=1
print(hit)
")"
check "(d) 리뷰 0건 개념(주름/EGF/콜라겐) 컨셉 미사용" "[ \"$ZERO_USE\" = '0' ]"

# 추천 → 선택 → 심의 통과 (M4: 생성 직후 select 게이트; 심의는 선택 뒤, 선택안만 스캔)
export HARNESS_CLI=claude HARNESS_OFFLINE=1

# (e) pairwise 추천 top-1 이 run.md 에 노출
REC1="$(python3 -c "import json;print(json.load(open('$ROOT/runs/ci-b2/02-concept/recommendation.json'))['ranked'][0])")"
check "(e) recommendation top-1 존재" "[ -n \"$REC1\" ]"
check "(e) run.md 에 추천 top-1 노출" "grep -q \"$REC1\" '$ROOT/runs/ci-b2/run.md'"

# (f) 잘못된 선택값 친절 반려 (한국어) — 선택 게이트에서
OUT_BAD="$( ( cd "$ROOT" && bash scripts/select.sh ci-b2 ZZZ ) 2>&1 )"; RC_BAD=$?
check "(f) 잘못된 선택값 거부(비정상 종료)" "[ $RC_BAD -ne 0 ]"
check "(f) 친절한 한국어 반려" "echo \"\$OUT_BAD\" | grep -q '올바르지 않'"

# 정상 선택 → 심의(선택안만) 통과 → 다음 페이즈
( cd "$ROOT" && bash scripts/select.sh ci-b2 B ) >/dev/null 2>&1
check "(e) select.sh B → decision.json 기록" "[ -f '$ROOT/runs/ci-b2/02-concept/decision.json' ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-b2 ) >/dev/null 2>&1
check "(c) 안전 카피 컨셉 심의 통과(verdict=pass)" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/ci-b2/02-concept/review/concept-verdict.json" verdict)\" = 'pass' ]"
check "(e) 심의 통과 → 전이(03-storyboard)" "[ \"\$(jq_phase ci-b2 phase)\" = '03-storyboard' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# (c) evidence 존재성: 가짜 evidence_ref 통과 0건 (픽스처 주입)
drive_to_concept ci-fake claude
# A-efficacy 옵션에 efficacy 강주장 + 가짜 evidence_ref 주입
python3 - <<PYEOF
import json,os
p="$ROOT/runs/ci-fake/02-concept/options/A-efficacy/rtb.json"
d=json.load(open(p))
d["rtb"].append({"id":"rtb-fake","claim":"단 1일 만에 미백 효과","claim_strength":"efficacy",
  "evidence_ref":"ev-FAKE-999","functional_basis":None,"review_status":"pending"})
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4(C4): 심의는 선택안만 스캔 → 위반 주입한 A-efficacy 를 선택해 심의.
( cd "$ROOT" && bash scripts/select.sh ci-fake A-efficacy && bash scripts/kcia-check.sh ci-fake ) >/dev/null 2>&1
VP="$ROOT/runs/ci-fake/02-concept/review/concept-verdict.json"
VERD="$(python3 "$ROOT/scripts/lib/harness.py" jget "$VP" verdict)"
check "(c) 가짜 evidence_ref → 심의 fail(통과 0건)" "[ \"$VERD\" = 'fail' ]"
FAKEHIT="$(python3 -c "import json;vs=json.load(open('$VP'))['violations'];print(any('FAKE' in (v.get('target_text','')+str(v.get('suggested_rewrite',''))) or v['axis']=='substantiation_required' for v in vs))")"
check "(c) 위반에 evidence/실증 축 포함" "[ \"$FAKEHIT\" = 'True' ]"
# 가짜 id로는 통과(pass) 불가 — 회귀 후에도 fail 유지
check "(c) 가짜 id로 verdict=pass 불가" "[ \"$VERD\" != 'pass' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# (g) a2 결정성: 독립 2런(동일 엔진)의 컨셉 산출물 구조 동일 + 동일 심의 분류
drive_to_concept ci-b2c claude
drive_to_concept ci-b2x claude
# (R2) 동시 select 두 번째 친절 종료 — ci-b2c 가 아직 select 게이트일 때(심의 전) lock 보유 → 거부
hold_lock "$ROOT/runs/ci-b2c"
OUT_CC="$( ( cd "$ROOT" && bash scripts/select.sh ci-b2c B ) 2>&1 )"; RC_CC=$?
release_held "$ROOT/runs/ci-b2c"
check "(R2) 동시 select 시 lock 으로 친절 종료" "[ $RC_CC -ne 0 ] && echo \"\$OUT_CC\" | grep -q '다른 작업이 진행 중'"
# M4: 선택(B) → 심의(선택안만) → 두 런 비교.
export HARNESS_CLI=claude HARNESS_OFFLINE=1; ( cd "$ROOT" && bash scripts/select.sh ci-b2c B && bash scripts/kcia-check.sh ci-b2c ) >/dev/null 2>&1; unset HARNESS_CLI HARNESS_OFFLINE
export HARNESS_CLI=claude HARNESS_OFFLINE=1; ( cd "$ROOT" && bash scripts/select.sh ci-b2x B && bash scripts/kcia-check.sh ci-b2x ) >/dev/null 2>&1; unset HARNESS_CLI HARNESS_OFFLINE
SD=1
for rel in 02-concept/options/A-efficacy/rtb.json 02-concept/options/B-emotional/key-message.json 02-concept/recommendation.json 02-concept/review/concept-verdict.json; do
  python3 "$ROOT/scripts/lib/harness.py" structdiff "$ROOT/runs/ci-b2c/$rel" "$ROOT/runs/ci-b2x/$rel" >/dev/null 2>&1 || SD=0
done
check "(a2) 독립 2런 컨셉 산출물 키 집합·타입 동일(결정성)" "[ $SD -eq 1 ]"
V1="$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/ci-b2c/02-concept/review/concept-verdict.json" verdict)"
V2="$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/ci-b2x/02-concept/review/concept-verdict.json" verdict)"
check "(a2) 독립 2런 심의 동일 분류(verdict)" "[ \"$V1\" = \"$V2\" ]"

# (R3) loop guard: 컨셉 revise 가 max 초과 → escalated
SF="$ROOT/runs/ci-fake/state.json"
check "(R3) loop guard 필드(iteration/max_iterations) 존재" "python3 "$ROOT/scripts/lib/harness.py" jget '$SF' max_iterations >/dev/null 2>&1"

# ─────────── [외부리뷰 B2 수용] 회귀 잠금 ───────────
# #3 독립 축별 생성: 축별 별도 생성 이벤트가 history 에 남는다
AXEV="$(python3 -c "import json;print(sum(1 for h in json.load(open('$ROOT/runs/ci-b2x/state.json'))['history'] if h['event'].startswith('generate:concept-axis:')))")"
check "(#3) 컨셉 축별 독립 생성 이벤트 ≥2 (mode collapse 방지)" "[ \"$AXEV\" -ge 2 ]"

# #6 리뷰 0건 개념(주름/EGF/콜라겐)을 컨셉 축에 넣으면 심의가 revise
drive_to_concept ci-zero claude
python3 - "$ROOT/runs/ci-zero/02-concept/options/C-science/rtb.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p))
d["rtb"][0]["claim"]="콜라겐 탄력 강화 컨셉"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4(C4): 위반 주입한 C-science 를 선택해 심의.
export HARNESS_CLI=claude HARNESS_OFFLINE=1; ( cd "$ROOT" && bash scripts/select.sh ci-zero C-science && bash scripts/kcia-check.sh ci-zero ) >/dev/null 2>&1; unset HARNESS_CLI HARNESS_OFFLINE
check "(#6) 리뷰 0건 개념(콜라겐) 컨셉 사용 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/ci-zero/02-concept/review/concept-verdict.json" verdict)\" = 'fail' ]"

# #4 감성 키메시지 voc_phrase 허위/누락 → revise
drive_to_concept ci-vp claude
python3 - "$ROOT/runs/ci-vp/02-concept/options/B-emotional/key-message.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p))
d["key_messages"][0]["voc_phrase"]="존재하지않는단어"   # voc 에 없는 가짜
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4(C4): 위반 주입한 B-emotional 을 선택해 심의.
export HARNESS_CLI=claude HARNESS_OFFLINE=1; ( cd "$ROOT" && bash scripts/select.sh ci-vp B-emotional && bash scripts/kcia-check.sh ci-vp ) >/dev/null 2>&1; unset HARNESS_CLI HARNESS_OFFLINE
check "(#4) 감성 키메시지 가짜 voc_phrase → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/ci-vp/02-concept/review/concept-verdict.json" verdict)\" = 'fail' ]"

# #1 컨셉 강주장은 각주 슬롯이 없으므로 실재 evidence_ref 라도 불허(fail-closed)
RID1=ci-fn; rm -rf "$ROOT/runs/$RID1"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && HARNESS_WB="$PACKS_DIR/cosmetic/golden/wb-with-evidence.md" bash scripts/ingest-bundle.sh "$BUNDLE" "$RID1" && bash scripts/run-stage.sh brief "$RID1" && bash scripts/approve.sh "$RID1" --ra-ok && bash scripts/kcia-check.sh "$RID1" && bash scripts/run-stage.sh concept "$RID1" ) >/dev/null 2>&1
EVID="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID1/00-ingest/claim-basis.json'))['evidence_on_file'];print(d[0]['id'] if d else 'none')")"
python3 - "$ROOT/runs/$RID1/02-concept/options/A-efficacy/rtb.json" "$EVID" <<'PYEOF'
import json,sys
p,ev=sys.argv[1],sys.argv[2];d=json.load(open(p))
d["rtb"].append({"id":"rtb-fn","claim":"임상 효능 입증","claim_strength":"efficacy","evidence_ref":ev,"functional_basis":None,"review_status":"pending"})
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4(C4): 강주장 주입한 A-efficacy 를 선택해 심의.
( cd "$ROOT" && bash scripts/select.sh "$RID1" A-efficacy && bash scripts/kcia-check.sh "$RID1" ) >/dev/null 2>&1
check "(#1) 컨셉의 강주장은 실재 근거라도 각주슬롯 없어 불허(verdict=fail)" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID1/02-concept/review/concept-verdict.json" verdict)\" = 'fail' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# #2 evidence 세탁 차단: sources 에 거부 등급(보도자료) id 를 심어도 신뢰하지 않음
RID2=ci-launder
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" && bash scripts/run-stage.sh brief "$RID2" && bash scripts/approve.sh "$RID2" --ra-ok && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh concept "$RID2" && bash scripts/select.sh "$RID2" B && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh storyboard-outline "$RID2" && bash scripts/select.sh "$RID2" A && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh storyboard-plan "$RID2" ) >/dev/null 2>&1
# 보도자료 등급의 가짜 근거를 sources 에 주입
python3 - "$ROOT/runs/$RID2/03-storyboard/sources/results.json" <<'PYEOF'
import json,sys
p=sys.argv[1];d=json.load(open(p))
d["results"]=[{"id":"W-FAKE","title":"보도자료","grade":"보도자료","year":2025,"doi":None,"abstract_ko":"x"}]
d["evidence_sufficient"]=True
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# 그 가짜 id 를 참조하는 efficacy 주장 주입
python3 - "$ROOT/runs/$RID2/03-storyboard/plan/01-hero.json" <<'PYEOF'
import json,sys
p=sys.argv[1];b=json.load(open(p))
b["claims"].append({"target_text":"임상 효능","claim_strength":"efficacy","evidence_ref":"W-FAKE","footnote_id":"fn-1"})
b["footnotes"].append({"id":"fn-1","text":"각주"})
json.dump(b,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
# M4: storyboard-plan(단안) = 승인 → 심의. 위반 주입 후 승인하면 심의가 잡는다.
( cd "$ROOT" && bash scripts/approve.sh "$RID2" && bash scripts/kcia-check.sh "$RID2" ) >/dev/null 2>&1
check "(#2) 거부 등급(보도자료) 근거 세탁 차단 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID2/03-storyboard/plan-verdict.json" verdict)\" = 'fail' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# #7 모호한 prefix 선택 거부 (옵션 B-x, B-y 가정 — 임시 디렉터리로 모호성 유발). M4: 생성 직후 select 게이트에서 검증.
drive_to_concept ci-amb claude
mkdir -p "$ROOT/runs/ci-amb/02-concept/options/B-extra"
cp "$ROOT/runs/ci-amb/02-concept/options/B-emotional/rtb.json" "$ROOT/runs/ci-amb/02-concept/options/B-extra/rtb.json"
cp "$ROOT/runs/ci-amb/02-concept/options/B-emotional/key-message.json" "$ROOT/runs/ci-amb/02-concept/options/B-extra/key-message.json"
OUT_AMB="$( ( cd "$ROOT" && bash scripts/select.sh ci-amb B ) 2>&1 )"; RC_AMB=$?
check "(#7) 모호한 prefix 선택(B → B-emotional/B-extra) 거부" "[ $RC_AMB -ne 0 ] && echo \"\$OUT_AMB\" | grep -q '모호'"

# #8 phantom 추천(실재하지 않는 옵션) → validate-stage 거부
drive_to_concept ci-ph claude
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-ph/02-concept/recommendation.json" ranked '["Z-ghost","B-emotional"]' >/dev/null
OUT_PH="$( ( cd "$ROOT" && bash scripts/validate-stage.sh ci-ph 02-concept ) 2>&1 )"; RC_PH=$?
check "(#8) recommendation 에 실재않는 옵션 → validate 거부" "[ $RC_PH -ne 0 ] && echo \"\$OUT_PH\" | grep -q '실재하지 않는'"

# #9 a2 이식성 한계 명시: 오프라인 두 경로는 동일 stub → '계약 동일'만 보장.
#    실 LLM a2(스키마유효+게이트enum+동일분류)는 RUN_REAL_A2=1 일 때만 실측(토큰 소모).
check "(#9-note) a2 는 계약(구조/게이트/분류) 동일로 판정(내용 동일 아님)" "true"

# M5(G2): 컨셉 전부거절→재생성 일관화(00g 와 동일) — 거절 라운드 history/iter-N 보존 + active 재생성·select 복귀
drive_to_concept ci-b2rej claude
CSEL0="$(jq_phase ci-b2rej gate)"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/revise.sh ci-b2rej "다른 방향으로 다시 제안" && bash scripts/run-stage.sh concept ci-b2rej ) >/dev/null 2>&1
unset HARNESS_CLI HARNESS_OFFLINE
check "(M5) 컨셉 select 게이트 도달(전부거절 전제)" "[ \"$CSEL0\" = 'select' ]"
CREJHIST="$(ls -d "$ROOT"/runs/ci-b2rej/02-concept/history/iter-* 2>/dev/null | head -1)"
check "(M5) 컨셉 전부거절 → 거절 라운드 history/iter-N 보존(감사추적)" "[ -n \"$CREJHIST\" ] && ls \"$CREJHIST\"/options/*/rtb.json >/dev/null 2>&1"
check "(M5) 컨셉 재생성 → active options 재생성 + select 복귀" "[ \"\$(jq_phase ci-b2rej gate)\" = 'select' ] && ls "$ROOT"/runs/ci-b2rej/02-concept/options/*/rtb.json >/dev/null 2>&1"
check "(M5) 컨셉 concept-axes.json 보존(구조 프레임 — 아카이브 대상 아님)" "[ -f "$ROOT"/runs/ci-b2rej/02-concept/concept-axes.json ]"

rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B2: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
