#!/usr/bin/env bash
# test-b9.sh — M7(G5): 모든 포맷이 스토리보드(03)를 돈다 — one_pager format-aware 생성.
#   한장(one_pager)도 03-storyboard 를 거쳐 포맷별 캐논 블록으로 스토리라인·기획안을 생성하고
#   포맷별 커버리지(packs/_format/<format>/canon.json 의 components)를 통과한 뒤 done 까지 완주하는지 검증한다.
#   엔진=stub(결정적). multipage_bm 바이트 보존은 verify-baseline/b0/b4 가 가드(여기선 비-BM 포맷의 03 진입을 검증).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B9 — M7: one_pager 스토리보드(03) format-aware 완주"

entered_03() {  # $1=rid → '1' if 03-storyboard phase:enter in history
  python3 -c "import json;h=json.load(open('$ROOT/runs/$1/state.json'))['history'];print('1' if any(e.get('phase')=='03-storyboard' and e['event']=='phase:enter' for e in h) else '0')" 2>/dev/null
}
sel_blocks() {  # $1=rid → comma-joined block types of selected storyline
  python3 -c "
import json,os
b='$ROOT/runs/$1/03-storyboard/outline'
d=os.path.join(b,'decision.json'); sel=json.load(open(d))['selected'] if os.path.exists(d) else 'A'
sl=json.load(open(os.path.join(b,'options',sel,'storyline.json')))
print(','.join(x['type'] for x in sl['blocks']))" 2>/dev/null
}
cov_ok() {  # $1=rid → 'True' if all_required_covered
  python3 -c "import json;print(json.load(open('$ROOT/runs/$1/03-storyboard/canon-coverage.json')).get('all_required_covered'))" 2>/dev/null
}

# ── one_pager: 00→00g(조건부)→01→02→03→(04 스킵)→done ──
RID1=ci-b9-op; drive_format_pipeline "$RID1" claude cosmetic one_pager
check "(op) one_pager done 완주" "[ \"\$(jq_phase $RID1 phase)\" = 'done' ]"
check "(op) 03-storyboard 진입(스토리보드 스킵 안 함)" "[ \"\$(entered_03 $RID1)\" = '1' ]"
OPB="$(sel_blocks $RID1)"
check "(op) 포맷 캐논 필수 블록(hero·rtbSummary) 존재" "echo '$OPB' | grep -q hero && echo '$OPB' | grep -q rtbSummary"
check "(op) 커버리지 통과(packs/_format/one_pager/canon.json 정본)" "[ \"\$(cov_ok $RID1)\" = 'True' ]"
NPB="$(ls "$ROOT"/runs/$RID1/03-storyboard/plan/*.json 2>/dev/null | wc -l | tr -d ' ')"
check "(op) 기획안 블록 plan/*.json 생성(≥2)" "[ \"$NPB\" -ge 2 ]"
check "(op) plan 산출물 스키마 유효" "validate_all_artifacts $RID1"

# ── A/B 전개 순서 상이(2안 다름) — one_pager outline ──
AB_DIFF="$(python3 -c "
import json,os
b='$ROOT/runs/$RID1/03-storyboard/outline/options'
# A 는 done 후 history 로 이동됐을 수 있으니 active+history 모두 탐색
import glob
def blocks(opt):
    for base in [os.path.join(b,opt,'storyline.json')]+glob.glob('$ROOT/runs/$RID1/03-storyboard/history/*/outline/options/%s/storyline.json'%opt):
        if os.path.exists(base): return [x['type'] for x in json.load(open(base))['blocks']]
    return None
A,B=blocks('A'),blocks('B')
print('DIFF' if (A and B and A!=B) else ('SAME' if A and B else 'PARTIAL:%s/%s'%(A is not None,B is not None)))" 2>/dev/null)"
check "(op) A/B 스토리라인 전개 순서 상이(2안 비교 의미)" "[ \"$AB_DIFF\" = 'DIFF' ]"

# ── M8: one_pager 도 04-keyvisual 렌더러를 거쳐 키비주얼 산출(포맷별 렌더 폭) ──
ent04() { python3 -c "import json,sys;h=json.load(open('$ROOT/runs/$1/state.json'))['history'];sys.exit(0 if any(e.get('phase')=='04-keyvisual' and e['event']=='phase:enter' for e in h) else 1)"; }
manw() { python3 -c "import json;print(json.load(open('$ROOT/runs/$1/04-keyvisual/design-manifest.json'))['width_px'])" 2>/dev/null; }
check "(op·M8) one_pager 04-keyvisual 진입(키비주얼 렌더)" "ent04 $RID1"
check "(op·M8) one_pager design-manifest 포맷 폭=860(single 채널)" "[ \"\$(manw $RID1)\" = '860' ]"

# ── 포맷 직교: 전 포맷이 04 를 거치되 '폭/블록'이 포맷별(M8). multipage 비회귀 확인 ──
RID3=ci-b9-mp; drive_format_pipeline "$RID3" claude cosmetic multipage_bm
check "(mp) multipage_bm done 완주(04-keyvisual 포함)" "[ \"\$(jq_phase $RID3 phase)\" = 'done' ]"
check "(mp) multipage 04-keyvisual 진입 + design-manifest 폭=860(naver_smartstore, 비회귀)" \
  "ent04 $RID3 && [ \"\$(manw $RID3)\" = '860' ]"

rm -rf "$ROOT"/runs/ci-b9-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B9: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
