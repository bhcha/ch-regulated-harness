#!/usr/bin/env bash
# test-components.sh — 주요 구성요소 커버리지 단계/게이트 + 신규 블록(rtbSummary·targetAudience·brandBanner).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 구성요소 — 커버리지 체크 단계 + 신규 블록"

drive_to_plan() {  # $1=rid, $2=wb(옵션) — 03-storyboard plan 생성까지
  local rid="$1" wb="${2:-}"; rm -rf "$ROOT/runs/$rid" "$ROOT/inputs/bundle"
  export HARNESS_CLI=stub
  # M4: 생성 → 사람 승인/선택 → 심의 → advance. (단안=approve, 다안=select)
  #   wb 인자 있으면 그 WB(fixture)로 ingest(공유 inputs swap 제거), 없으면 lib.sh 기본 fixture.
  ( cd "$ROOT" && HARNESS_WB="${wb:-$HARNESS_WB}" bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" B && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-outline "$rid" && bash scripts/select.sh "$rid" A && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-plan "$rid" ) >/dev/null 2>&1
  unset HARNESS_CLI
}

# 신규 블록 enum 검증
check "신규 블록 canon 정본 types 포함(rtbSummary/targetAudience/brandBanner)" \
  "python3 -c \"import json,sys;t=set(json.load(open('$FORMATS_DIR/multipage_bm/canon.json'))['types']);sys.exit(0 if {'rtbSummary','targetAudience','brandBanner'}<=t else 1)\""
check "canon.json 10대 구성요소 정의(정본 1개)" \
  "[ \"\$(python3 -c \"import json;print(len(json.load(open('$FORMATS_DIR/multipage_bm/canon.json'))['components']))\")\" = '10' ]"

RID=ci-cmp; drive_to_plan "$RID"
# (a) 신규 3블록이 기획안에 생성됨
for t in rtbSummary targetAudience brandBanner; do
  check "(블록) 기획안에 $t 생성" "ls '$ROOT'/runs/$RID/03-storyboard/plan/*$t*.json >/dev/null 2>&1"
done
# (b) 신규 블록 심의 통과(안전 콘텐츠) — M4: plan(단안) 승인 뒤 심의.
( cd "$ROOT" && HARNESS_CLI=stub bash scripts/approve.sh "$RID" && HARNESS_CLI=stub bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
check "(심의) 신규 블록 포함 기획안 verdict=pass" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID/03-storyboard/plan-verdict.json" verdict)\" = 'pass' ]"

# (c) 커버리지 체크 단계 — 필수 전부 충족, 리포트 스키마 유효
COV="$(python3 "$ROOT/scripts/lib/check_canon_coverage.py" "$ROOT/runs/$RID" --scope plan --json 2>/dev/null)"
check "(커버리지) 모든 필수 구성요소 충족" "[ \"\$(echo '$COV' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"all_required_covered\"])')\" = 'True' ]"
check "(커버리지) canon-coverage.json 스키마 유효" "python3 '$ROOT/scripts/lib/harness.py' validate '$ROOT/runs/$RID/03-storyboard/canon-coverage.json' >/dev/null 2>&1"
check "(커버리지) 실증 미등록 → scienceEvidence 면제(미누락)" "echo '$COV' | grep -q '실증미등록'"

# (c-claim) claim_gated: 판매/수상 주장이 실제로 제기되지 않으면(brief sensitive_labels 부재/미주장)
#   범용 socialProof/brandTrust 만으로 salesAward 를 '충족'으로 오판하지 않고 면제(거짓 충족 신호 차단).
SA="$(echo "$COV" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(c['status'] for c in d['components'] if c['id']=='salesAward'))" 2>/dev/null)"
check "(c-claim) 판매/수상 미주장 → salesAward=exempt(미주장)" "[ \"$SA\" = 'exempt(미주장)' ]"
check "(c-claim) salesAward 면제라도 필수 누락 아님(하드페일 없음)" \
  "[ \"\$(echo '$COV' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"all_required_covered\"])')\" = 'True' ]"
# 판매/수상 주장이 실제 제기되면(approved 라벨) salesAward=covered 로 동일 유지(면제 안 됨).
python3 - "$ROOT/runs/$RID/01-brief/brief.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p))
b.setdefault("sensitive_labels", []).append({"label": "약국 판매 1위", "basis": "제안서", "status": "approved"})
json.dump(b, open(p, "w"), ensure_ascii=False)
PYEOF
SA2="$(python3 "$ROOT/scripts/lib/check_canon_coverage.py" "$ROOT/runs/$RID" --scope plan --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(c['status'] for c in d['components'] if c['id']=='salesAward'))" 2>/dev/null)"
check "(c-claim) 판매/수상 주장(approved) → salesAward=covered(동일 유지)" "[ \"$SA2\" = 'covered' ]"
# 주입 라벨 제거 — 하류 검사에 영향 없도록 원복.
python3 - "$ROOT/runs/$RID/01-brief/brief.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p))
b["sensitive_labels"] = [s for s in b.get("sensitive_labels", []) if s.get("label") != "약국 판매 1위"]
json.dump(b, open(p, "w"), ensure_ascii=False)
PYEOF
# unsupported(근거 없어 카피 배제) 판매/수상 라벨도 '미주장'으로 면제 — 광고에 안 실리므로 salesAward 요구 안 함(not_claimed 과 동일 취급).
python3 - "$ROOT/runs/$RID/01-brief/brief.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p))
b.setdefault("sensitive_labels", []).append({"label": "판매 1위", "basis": None, "status": "unsupported"})
json.dump(b, open(p, "w"), ensure_ascii=False)
PYEOF
SA3="$(python3 "$ROOT/scripts/lib/check_canon_coverage.py" "$ROOT/runs/$RID" --scope plan --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(c['status'] for c in d['components'] if c['id']=='salesAward'))" 2>/dev/null)"
check "(c-claim) 판매/수상 unsupported(카피 배제) → salesAward=exempt(미주장)" "[ \"$SA3\" = 'exempt(미주장)' ]"
python3 - "$ROOT/runs/$RID/01-brief/brief.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p))
b["sensitive_labels"] = [s for s in b.get("sensitive_labels", []) if s.get("label") != "판매 1위"]
json.dump(b, open(p, "w"), ensure_ascii=False)
PYEOF

# (d) 하드 게이트 — 필수 블록 제거 시 validate-stage(plan) 실패
rm -f "$ROOT"/runs/$RID/03-storyboard/plan/*brandBanner*.json
OUT_G="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RID" 03-storyboard ) 2>&1 )"; RC_G=$?
check "(게이트) 대웅배너 제거 시 validate-stage 거부" "[ $RC_G -ne 0 ]"
check "(게이트) 누락 구성요소 명시" "echo \"\$OUT_G\" | grep -qi 'brandBanner\|대웅'"

# (e) 운영 명령 check-components.sh 정상/실패 종료코드
drive_to_plan "ci-cmp2"
( cd "$ROOT" && bash scripts/check-components.sh ci-cmp2 --scope plan ) >/dev/null 2>&1
check "(운영) check-components.sh 충족 시 exit 0" "[ $? -eq 0 ]"
rm -f "$ROOT"/runs/ci-cmp2/03-storyboard/plan/*targetAudience*.json
( cd "$ROOT" && bash scripts/check-components.sh ci-cmp2 --scope plan ) >/dev/null 2>&1
check "(운영) 누락 시 exit 비정상" "[ $? -ne 0 ]"

# (f) run.md 가 커버리지 요약 노출
check "(run.md) 주요 구성요소 커버리지 노출" "grep -q '주요 구성요소 커버리지' '$ROOT/runs/$RID/run.md'"

# (g) 실증 등록 시 scienceEvidence 가 '필수'가 되고 clinicalEvidence 로 충족
RID3=ci-cmp3; drive_to_plan "$RID3" "$PACKS_DIR/cosmetic/golden/wb-with-evidence.md"
COV3="$(python3 "$ROOT/scripts/lib/check_canon_coverage.py" "$ROOT/runs/$RID3" --scope plan --json 2>/dev/null)"
SCI="$(echo "$COV3" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(c['status'] for c in d['components'] if c['id']=='scienceEvidence'))" 2>/dev/null)"
check "(g) 실증 등록 시 scienceEvidence=covered(clinicalEvidence)" "[ \"$SCI\" = 'covered' ]"

# [외부리뷰 coverage 수용] 회귀 잠금
# #5 추천 타겟 질환 타겟팅 차단
RID4=ci-cmp4; drive_to_plan "$RID4"
python3 - "$ROOT/runs/$RID4/03-storyboard/plan" <<'PYEOF'
import json,os,sys,glob
p=glob.glob(sys.argv[1]+'/*targetAudience*.json')[0]
b=json.load(open(p)); b["bodyText"]=["여드름이 고민이신 분께 추천"]; json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
# M4: plan(단안) 승인 뒤 심의 — 위반 주입 후 승인하면 심의가 잡는다.
( cd "$ROOT" && HARNESS_CLI=stub bash scripts/approve.sh "$RID4" && HARNESS_CLI=stub bash scripts/kcia-check.sh "$RID4" ) >/dev/null 2>&1
check "(#5) targetAudience 질환 타겟팅 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID4/03-storyboard/plan-verdict.json" verdict)\" = 'fail' ]"

# #6 대웅배너 제약 권위 차단
RID5=ci-cmp5; drive_to_plan "$RID5"
python3 - "$ROOT/runs/$RID5/03-storyboard/plan" <<'PYEOF'
import json,os,sys,glob
p=glob.glob(sys.argv[1]+'/*brandBanner*.json')[0]
b=json.load(open(p)); b["bodyText"]=["제약사 전문성으로 만든 쿠션"]; json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
# M4: plan(단안) 승인 뒤 심의 — 위반 주입 후 승인하면 심의가 잡는다.
( cd "$ROOT" && HARNESS_CLI=stub bash scripts/approve.sh "$RID5" && HARNESS_CLI=stub bash scripts/kcia-check.sh "$RID5" ) >/dev/null 2>&1
check "(#6) brandBanner 제약 권위 표현 → verdict=fail" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID5/03-storyboard/plan-verdict.json" verdict)\" = 'fail' ]"

# #3 빈/placeholder 블록은 커버리지 충족으로 인정 안 함
RID6=ci-cmp6; drive_to_plan "$RID6"
python3 - "$ROOT/runs/$RID6/03-storyboard/plan" <<'PYEOF'
import json,os,sys,glob
p=glob.glob(sys.argv[1]+'/*rtbSummary*.json')[0]
b=json.load(open(p)); b["headline"]="x"; b["bodyText"]=[]; b["claims"]=[]; b["footnotes"]=[]; b["visual"]={"kind":"photo","ref":None}
json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
( cd "$ROOT" && bash scripts/check-components.sh "$RID6" --scope plan ) >/dev/null 2>&1
check "(#3) 빈 rtbSummary 블록은 커버리지 미충족(누락 판정)" "[ $? -ne 0 ]"

# ── M3: 포맷별 커버리지 SSoT(coverage_path 하드코딩 제거) + 블록 enum 포맷 확장 ──
check "(단계4) format-profiles 모든 포맷 canon 정본 경로 정의" \
  "python3 -c \"import json,sys;f=json.load(open('$FORMATS_DIR/format-profiles.json'))['formats'];sys.exit(0 if all(v.get('canon','').endswith('/canon.json') for v in f.values()) else 1)\""
check "(단계4) multipage_bm canon=format팩 상대 multipage_bm/canon.json(정본 1개)" \
  "[ \"\$(python3 -c \"import json;print(json.load(open('$FORMATS_DIR/format-profiles.json'))['formats']['multipage_bm']['canon'])\")\" = 'multipage_bm/canon.json' ]"
check "(단계4) one_pager 4 구성요소 커버리지(canon.json 정본)" \
  "[ \"\$(python3 -c \"import json;print(len(json.load(open('$FORMATS_DIR/one_pager/canon.json'))['components']))\")\" = '4' ]"
check "(M3) check_canon_coverage 포맷별 spec 로드(one_pager→4, 미지원→BM 폴백10)" \
  "python3 -c \"import sys,os,tempfile,json;sys.path.insert(0,'$ROOT/scripts/lib');from check_canon_coverage import coverage_spec
def n(fmt):
 d=tempfile.mkdtemp();json.dump({'product':{'deliverable_format':fmt}},open(os.path.join(d,'state.json'),'w'));return len(coverage_spec(d))
sys.exit(0 if (n('one_pager'),n('bogus'),n('multipage_bm'))==(4,10,10) else 1)\""
check "(단계4) 블록 카탈로그 확장(cta/footer/header/mainPositioning) canon 정본 types" \
  "python3 -c \"import json,sys;t=set(json.load(open('$FORMATS_DIR/multipage_bm/canon.json'))['types']);sys.exit(0 if {'cta','footer','header','mainPositioning'}<=t else 1)\""
# 새 포맷 블록(M3 확장)을 가진 storyline 이 스키마+의미검증(필수 루트 header) 통과 — 가법 enum
python3 - <<PYEOF >/dev/null 2>&1
import json,sys,os; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import load_json, Validator
sch=load_json('$ROOT/harness/storyline.schema.json')
sl={"channel_profile":{"name":"generic","width_px":0,"max_height_px":0,"gif_allowed":False},
    "blocks":[{"order":1,"type":"header","intent":"브랜드 식별","risk_tier":"low"},
              {"order":2,"type":"mainPositioning","intent":"핵심 한 줄","risk_tier":"medium"},
              {"order":3,"type":"cta","intent":"전환","risk_tier":"low"},
              {"order":4,"type":"footer","intent":"법적 고지","risk_tier":"low"}]}
v=Validator(sch,sch); v.validate(sl,sch)
sys.exit(0 if not v.errors else 1)
PYEOF
check "(M3) 새 포맷 블록(header/mainPositioning/cta/footer) storyline 스키마 통과" "[ $? -eq 0 ]"

# (M3 HIGH1) visual.concept fail-closed: 기획안 블록에서 concept 제거 시 validate-stage(plan) 거부
RIDvc=ci-cmp-vc; drive_to_plan "$RIDvc"
python3 - "$ROOT/runs/$RIDvc/03-storyboard/plan" <<'PYEOF'
import json,sys,glob
p=glob.glob(sys.argv[1]+'/*hero*.json')[0]
b=json.load(open(p)); b["visual"]={"kind":"photo","ref":None}  # concept 제거(구도/무드/참조 소실)
json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDvc" 03-storyboard ) >/dev/null 2>&1 \
  && fail "(M3) visual.concept 제거에도 통과(fail-open)" || pass "(M3) 기획안 블록 visual.concept 누락 → validate-stage 거부(tone 흡수 fail-closed)"

# (M3 HIGH2) outline 커버리지 per-option: 한 옵션(B)만 hero 제거 → 합집합 false-pass 아니라 fail
RIDpo=ci-cmp-po; rm -rf "$ROOT/runs/$RIDpo" "$ROOT/inputs/bundle"; export HARNESS_CLI=stub
# M4: 생성 → 승인/선택 → 심의 → advance.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDpo" &&
  bash scripts/run-stage.sh brief "$RIDpo" && bash scripts/approve.sh "$RIDpo" --ra-ok && bash scripts/kcia-check.sh "$RIDpo" &&
  bash scripts/run-stage.sh concept "$RIDpo" && bash scripts/select.sh "$RIDpo" B && bash scripts/kcia-check.sh "$RIDpo" &&
  bash scripts/run-stage.sh storyboard-outline "$RIDpo" ) >/dev/null 2>&1; unset HARNESS_CLI
COVpo="$(python3 "$ROOT/scripts/lib/check_canon_coverage.py" "$ROOT/runs/$RIDpo" --scope outline --json 2>/dev/null)"
check "(M3) 선택 전 A/B 둘 다 충족 → outline 커버리지 통과" "[ \"\$(echo '$COVpo' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"all_required_covered\"])')\" = 'True' ]"
python3 - "$ROOT/runs/$RIDpo/03-storyboard/outline/options/B/storyline.json" <<'PYEOF'
import json,sys
sl=json.load(open(sys.argv[1])); sl["blocks"]=[b for b in sl["blocks"] if b["type"]!="hero"]
for i,b in enumerate(sorted(sl["blocks"],key=lambda x:x["order"])): b["order"]=i+1
json.dump(sl,open(sys.argv[1],"w"),ensure_ascii=False)
PYEOF
( cd "$ROOT" && python3 scripts/lib/check_canon_coverage.py "runs/$RIDpo" --scope outline ) >/dev/null 2>&1 \
  && fail "(M3) B안 hero 제거에도 합집합 통과(false-pass)" || pass "(M3) outline 옵션별 독립 평가 — B안 hero 누락 → 커버리지 fail(합집합 false-pass 차단)"

# ── 포맷 금지 블록(disallowed_blocks) 결정적 게이트 (RCA 8장 — 구매 CTA 등 out-of-scope 블록 누출 차단) ──
#   LLM 편차·ADK 가용성과 무관한 결정적 방어선. 위반 주입으로 게이트 자체를 동결(교정이 코드로 남았음을 CI 가 증명).
# (a) multipage_bm plan 에 cta 주입 → validate-stage 03 거부(rc≠0). brandBanner 복사라 다른 plan 게이트는 모두 통과 → 금지 게이트만 발동.
RIDdb=ci-cmp-disblk-bm; seed_fixture keyvisual "$RIDdb"
python3 - "$ROOT/runs/$RIDdb/03-storyboard/plan" <<'PYEOF'
import json,sys,os
pdir=sys.argv[1]
b=json.load(open(os.path.join(pdir,"12-brandBanner.json")))   # visual.concept/palette 유효한 실블록 복사(타 게이트 통과 보장)
b["type"]="cta"; b["order"]=14; b["headline"]="지금 구매하기"
json.dump(b,open(os.path.join(pdir,"14-cta.json"),"w"),ensure_ascii=False)
PYEOF
OUT_DB="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDdb" 03-storyboard ) 2>&1 )"; RC_DB=$?
check "(금지블록 a) multipage_bm plan 에 cta 주입 → validate-stage 03 거부" "[ $RC_DB -ne 0 ]"
check "(금지블록 a) 금지 블록 사유 명시" "echo \"\$OUT_DB\" | grep -qi '금지 블록'"

# (b) one_pager 는 cta 가 정당 블록 → 동일 주입에도 통과(rc==0). 포맷별(전역 아님) 증명.
RID1p=ci-cmp-disblk-1p; seed_fixture keyvisual "$RID1p"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import load_json,atomic_write_json;d=load_json('$ROOT/runs/$RID1p/state.json');d['product']['deliverable_format']='one_pager';atomic_write_json('$ROOT/runs/$RID1p/state.json',d)"
python3 - "$ROOT/runs/$RID1p/03-storyboard/plan" <<'PYEOF'
import json,sys,os
pdir=sys.argv[1]
b=json.load(open(os.path.join(pdir,"12-brandBanner.json")))
b["type"]="cta"; b["order"]=14; b["headline"]="지금 구매하기"
json.dump(b,open(os.path.join(pdir,"14-cta.json"),"w"),ensure_ascii=False)
PYEOF
( cd "$ROOT" && bash scripts/validate-stage.sh "$RID1p" 03-storyboard ) >/dev/null 2>&1
check "(금지블록 b) one_pager 는 동일 cta 주입에도 통과(포맷별 선언, 전역 금지 아님)" "[ $? -eq 0 ]"

# (c) 키비주얼 옵션 HTML 에 data-block=cta 주입 → validate-stage 04 거부(전 옵션 전수 스캔 — 비선택 옵션까지).
RIDkv=ci-cmp-disblk-kv; seed_fixture keyvisual "$RIDkv"
( cd "$ROOT" && HARNESS_CLI=stub bash scripts/run-stage.sh keyvisual "$RIDkv" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDkv" 04-keyvisual ) >/dev/null 2>&1
check "(금지블록 c) 정상 키비주얼 옵션 → validate-stage 04 통과(금지블록 없음)" "[ $? -eq 0 ]"
python3 - "$ROOT/runs/$RIDkv/04-keyvisual/options/A/index.html" <<'PYEOF'
import sys
p=sys.argv[1]; t=open(p,encoding="utf-8").read()
inj='  <section data-block="cta" data-order="99">\n    <h2 class="hl">지금 구매하기</h2>\n  </section>\n'
open(p,"w",encoding="utf-8").write(t.replace("</main>", inj+"</main>"))
PYEOF
OUT_KV="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDkv" 04-keyvisual ) 2>&1 )"; RC_KV=$?
check "(금지블록 c) 옵션 HTML data-block=cta 주입 → validate-stage 04 거부" "[ $RC_KV -ne 0 ]"
check "(금지블록 c) 금지 블록 사유 명시" "echo \"\$OUT_KV\" | grep -qi '금지 블록'"

# ── 가격 단일출처 가드(voc offer.price 값-대조) (RCA 8-1.5 · AGENTS 6번 절) ──
#   '숫자+원' 하드코딩 가격을 plan 카피(03)·옵션 HTML 가시 텍스트(04)에서 voc offer.price 와 값-대조.
#   본 방어선은 disallowed_blocks(위 a/b/c)이고 이 가격 가드는 심층 방어(RCA 8-2 순서 불변). seed_fixture=번들 비의존.
# 오탐 안전(문서 실측): '핵심 원료'·'안전관리원'(원 비-숫자선행)·'15g'·'10000ppm'('원' 없음)은 미매치여야.
check "(가격 오탐안전) '핵심 원료'·'안전관리원'·'15g'·'10000ppm' 미매치" \
  "python3 -c \"import sys;sys.path.insert(0,'$ROOT/scripts/lib');import check_html_blocks as c;bad=[s for s in ['핵심 원료','안전관리원','15g','10000ppm'] if c._scan_price(s,True,9900)];sys.exit(1 if bad else 0)\""

# (④a plan) offer.price=9900 인데 plan 카피에 '가격 12,345원'(불일치) 주입 → validate-stage 03 거부.
RIDpp=ci-cmp-price-plan; seed_fixture keyvisual "$RIDpp"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import load_json,atomic_write_json;v=load_json('$ROOT/runs/$RIDpp/00-ingest/voc.json');v['offer']={'price':9900,'discount':0};atomic_write_json('$ROOT/runs/$RIDpp/00-ingest/voc.json',v)"
python3 - "$ROOT/runs/$RIDpp/03-storyboard/plan/12-brandBanner.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p)); b["bodyText"]=list(b.get("bodyText") or [])+["가격 12,345원"]
json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
OUT_PP="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDpp" 03-storyboard ) 2>&1 )"; RC_PP=$?
check "(④a plan) offer 불일치 '12,345원' plan 카피 주입 → validate-stage 03 거부" "[ $RC_PP -ne 0 ]"
check "(④a plan) 가격 단일출처 위반 사유 명시" "echo \"\$OUT_PP\" | grep -qi '가격'"

# (④b plan) offer.price=9900 이고 plan 카피에 '9,900원'(일치) 주입 → validate-stage 03 통과(정당 가격 노출 보존).
RIDpm=ci-cmp-price-match; seed_fixture keyvisual "$RIDpm"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import load_json,atomic_write_json;v=load_json('$ROOT/runs/$RIDpm/00-ingest/voc.json');v['offer']={'price':9900,'discount':0};atomic_write_json('$ROOT/runs/$RIDpm/00-ingest/voc.json',v)"
python3 - "$ROOT/runs/$RIDpm/03-storyboard/plan/12-brandBanner.json" <<'PYEOF'
import json,sys
p=sys.argv[1]; b=json.load(open(p)); b["bodyText"]=list(b.get("bodyText") or [])+["9,900원"]
json.dump(b,open(p,"w"),ensure_ascii=False)
PYEOF
( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDpm" 03-storyboard ) >/dev/null 2>&1
check "(④b plan) offer 일치 '9,900원' plan 카피 주입 → validate-stage 03 통과(값-대조)" "[ $? -eq 0 ]"

# (④a html) offer.price=9900 인데 옵션 HTML 가시 텍스트에 '가격 12,345원'(불일치) 주입 → validate-stage 04 거부.
#   허용 블록(hero)에 주입해 disallowed 게이트와 분리(가격 게이트만 발동). 전 옵션 전수 스캔.
RIDph=ci-cmp-price-html; seed_fixture keyvisual "$RIDph"
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import load_json,atomic_write_json;v=load_json('$ROOT/runs/$RIDph/00-ingest/voc.json');v['offer']={'price':9900,'discount':0};atomic_write_json('$ROOT/runs/$RIDph/00-ingest/voc.json',v)"
( cd "$ROOT" && HARNESS_CLI=stub bash scripts/run-stage.sh keyvisual "$RIDph" ) >/dev/null 2>&1
python3 - "$ROOT/runs/$RIDph/04-keyvisual/options/A/index.html" <<'PYEOF'
import sys
p=sys.argv[1]; t=open(p,encoding="utf-8").read()
inj='  <section data-block="hero" data-order="98"><p>가격 12,345원</p></section>\n'
open(p,"w",encoding="utf-8").write(t.replace("</main>", inj+"</main>"))
PYEOF
OUT_PH="$( ( cd "$ROOT" && bash scripts/validate-stage.sh "$RIDph" 04-keyvisual ) 2>&1 )"; RC_PH=$?
check "(④a html) offer 불일치 '12,345원' 옵션 HTML 주입 → validate-stage 04 거부" "[ $RC_PH -ne 0 ]"
check "(④a html) 가격 단일출처 위반 사유 명시" "echo \"\$OUT_PH\" | grep -qi '가격'"

rm -rf "$ROOT"/runs/ci-cmp* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "COMPONENTS: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
