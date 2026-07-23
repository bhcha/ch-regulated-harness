#!/usr/bin/env bash
# test-b1g.sh — 00g-guideline 페이즈(유사사례 분석 → 프로젝트 가이드라인) + 조건부 라우팅 + 후방호환.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B1G — 00g-guideline (유사사례 AI 분석 → 프로젝트 가이드라인)"

RID="ci-guideline"; RID2="ci-guideline-skip"
# 동일 도메인 하위로 사례 배치(inputs/examples/<도메인>/). 테스트 도메인=cosmetic.
EXROOT="$(mktemp -d)"; mkdir -p "$EXROOT/cosmetic"; cp -r "$BUNDLE" "$EXROOT/cosmetic/ex1"
cleanup() { rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID2" "$EXROOT"; }
trap cleanup EXIT
rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID2"

G="$ROOT/runs/$RID/00g-guideline"
phase_is() { [ "$(jq_phase "$RID" phase)" = "$1" ]; }

# ── 사례 존재 → 00g-guideline 라우팅 ──
export HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$EXROOT"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" ) >/dev/null 2>&1
if phase_is "00g-guideline"; then pass "사례 존재 → ingest 가 00g-guideline 로 라우팅"; else fail "ingest 라우팅(기대 00g-guideline, 실제 $(jq_phase "$RID" phase))"; fi

# ── 생성: 사례별 분석 + 크롤 참조 노트(자유텍스트). 구 '유사점 3안 추출' 파기. ──
( cd "$ROOT" && bash scripts/run-stage.sh guideline "$RID" ) >/dev/null 2>&1
[ -f "$G/reference-notes.json" ] && pass "크롤 참조 노트(reference-notes) 생성" || fail "reference-notes 누락"
{ [ ! -d "$G/options" ] && [ ! -f "$G/recommendation.json" ]; } \
  && pass "구 유사점 3안(options/recommendation) 미생성 — 파기 확인" || fail "구 3안 잔존(파기 안 됨)"
[ -f "$G/examples/ex1/example-analysis.json" ] && pass "example-analysis.json 생성(사례별, 유지)" || fail "example-analysis.json 누락"
python3 "$ROOT/scripts/lib/harness.py" validate "$G/reference-notes.json" >/dev/null 2>&1 && pass "reference-notes 스키마 통과" || fail "reference-notes 스키마 실패"
python3 "$ROOT/scripts/lib/harness.py" validate "$G/examples/ex1/example-analysis.json" >/dev/null 2>&1 && pass "example-analysis 스키마 통과" || fail "example-analysis 스키마 실패"
python3 -c "
import json,sys
n=json.load(open('$G/reference-notes.json'))
sys.exit(0 if (n.get('flow_refs') or n.get('composition_notes') or (n.get('notes') or '').strip()) else 1)" 2>/dev/null \
  && pass "참조 노트 내용 존재(flow_refs/composition_notes/notes ≥1)" || fail "참조 노트 비어있음"
# fail-closed(Codex P1 H2): 참조 노트에 효능·절대어(한/영) → validate-stage 거부(룰엔진 한국어 갭 봉인)
cp "$G/reference-notes.json" "$G/reference-notes.json.bak"
_rn_blocked=1
for _bad in '"whitening effect, No.1 anti-aging"' '"미백 효과 최고"'; do
  python3 "$ROOT/scripts/lib/harness.py" jset "$G/reference-notes.json" notes "$_bad" >/dev/null
  ( cd "$ROOT" && bash scripts/validate-stage.sh "$RID" 00g-guideline ) >/dev/null 2>&1 && _rn_blocked=0
done
mv "$G/reference-notes.json.bak" "$G/reference-notes.json"
[ "$_rn_blocked" = "1" ] && pass "fail-closed: 참조노트 효능·절대어(한/영) → validate-stage 거부" || fail "fail-closed 미작동: 참조노트 효능어 통과"

# ── fail-closed: why_good 전부 측정신호 grounded ──
python3 -c "
import json,sys
a=json.load(open('$G/examples/ex1/example-analysis.json'))
sys.exit(0 if a['why_good'] and all(x['grounded_in'] for x in a['why_good']) else 1)" 2>/dev/null \
  && pass "why_good 전부 측정신호 grounded(fail-closed)" || fail "why_good grounded 위반"

# ── M2(G3): 감각 reference_images 캡처 + fail-closed (코덱스 M2 R1/R2 반영) ──
EA="$G/examples/ex1/example-analysis.json"
python3 -c "
import json,sys; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import ALLOWED_COMPOSITION_TAGS, ALLOWED_MOOD_TAGS
ri=json.load(open('$EA')).get('reference_images') or []
ok=bool(ri) and all(r.get('composition_tags') and r.get('mood_tags') and (r.get('why') or '').strip() for r in ri)
ok=ok and all(t in ALLOWED_COMPOSITION_TAGS for r in ri for t in r['composition_tags'])
ok=ok and all(t in ALLOWED_MOOD_TAGS for r in ri for t in r['mood_tags'])
ok=ok and all(not (r.get('src') or '').startswith('inputs/assets/') for r in ri)  # 저작권: 디자인 자산 아님
ok=ok and all(r['id'].startswith('ex1#') for r in ri)                              # join 키 형식
sys.exit(0 if ok else 1)" 2>/dev/null \
  && pass "reference_images 감각 캡처(구도·무드 화이트리스트, why, src=크롤경로, id=ex1#NN)" || fail "reference_images 캡처/화이트리스트/저작권 위반"
cp "$EA" "$EA.bak"
mutate_reject() {  # $1=설명 $2=python-변조식
  python3 -c "import json,sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import load_json,atomic_write_json;a=load_json('$EA');$2;atomic_write_json('$EA',a)"
  ( cd "$ROOT" && bash scripts/validate-stage.sh "$RID" 00g-guideline ) >/dev/null 2>&1 \
    && fail "fail-closed 미작동: $1" || pass "fail-closed: $1 → validate-stage 거부"
  cp "$EA.bak" "$EA"   # 복원
}
mutate_reject "reference_images 누락"        "a['reference_images']=[]"
mutate_reject "비화이트리스트 태그(효능어)"   "a['reference_images'][0]['composition_tags']=['미백']"
mutate_reject "why 효능·절대어(영문 포함)"    "a['reference_images'][0]['why']='No.1 anti-aging 효과 최고'"
mutate_reject "id 형식 위반(비 ex1#NN)"      "a['reference_images'][0]['id']='hero#1'"
mutate_reject "src 가 디자인 자산(저작권)"    "a['reference_images'][0]['src']='inputs/assets/x.jpg'"
rm -f "$EA.bak"
# why deny 도메인-aware + 우회 강건성(코덱스 M2 R3): drug lexicon(치료/예방) + 영문 우회 차단, 정상어 오탐 0
python3 -c "
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import why_violations as wv
ZW='​'
CB='́'
blocked = all(wv(s,d) for s,d in [
    ('치료 효과','drug'),('예방에 도움','drug'),('피임','drug'),                 # 도메인 lexicon
    ('치'+ZW+'료','drug'),('anti'+ZW+'-aging','cosmetic'),('업계 1_위','cosmetic'), # zero-width/구두점 우회
    ('치,료','cosmetic'),('anti+aging','cosmetic'),('치'+CB+'료','drug'),         # 구두점/기호/결합문자 우회(카테고리 기반)
    ('치%료','cosmetic'),('anti%aging','cosmetic'),('최%고','cosmetic'),          # '%'-삽입 우회(plain deny 는 % 제거 뷰)
    ('anti_aging','cosmetic'),('No.1','cosmetic'),('완치','cosmetic'),           # 영문/보편 의학어
    ('탄력 개선','cosmetic'),('수분 42% 개선','cosmetic'),('수분 42퍼센트 개선','cosmetic'),('5배 효과','drug'),  # 실증triggers(N→숫자, %/퍼센트 통일)
    ('항%균','cosmetic'),('탄%력 개선','cosmetic'),('수%분 42% 개선','cosmetic'),('100%','cosmetic'),('부작용 0%','drug'),  # 트리거 %-삽입 우회 + 순수 숫자%
    ('0%','drug'),('0프로','drug'),('100%','drug')])  # drug lexicon.safety_overclaim 의 순수 숫자%(banned 아님)
clean   = not any(wv(s,'cosmetic') for s in ['상단 히어로','시선 위치','38컷 중 1번째 컷','grid 구도와 soft 무드','구도 개선이 또렷','100가지 구도','수분감이 느껴지는 컷'])
sys.exit(0 if (blocked and clean) else 1)" 2>/dev/null \
  && pass "why deny: 도메인 lexicon+실증triggers(N→숫자)+zero-width/유니코드 우회 차단, 정상어 오탐 0" || fail "why deny 도메인-aware/우회 강건성 위반"

# ── M4: 생성 직후 단안(승인) 게이트(심의는 승인 뒤). 구 '유사점 3안 select' 파기 → 단안 approve. ──
[ "$(jq_phase "$RID" gate)" = "user" ] && pass "생성 후 크롤 참조 노트 승인(단안) 게이트" || fail "승인 게이트 기대(user), 실제 $(jq_phase "$RID" gate)"

# ── 현업 승인 → 심의 게이트 → kcia-check(참조 노트=광고카피 아님 → 심의 면제 자동 통과) → 01-brief 전진 ──
( cd "$ROOT" && bash scripts/approve.sh "$RID" --ra-ok ) >/dev/null 2>&1
[ "$(jq_phase "$RID" gate)" = "review" ] && pass "승인 → 심의 게이트 전이" || fail "심의 게이트 기대(review), 실제 $(jq_phase "$RID" gate)"
GV="$G/guideline-verdict.json"
# ── 면제 autopass 회귀 가드(Codex R1 CRITICAL): 면제라도 autopass '전' validate-stage 재검증 → 생성 후 변조된 금지표현은 fail-closed.
#   (중복 '심의(크리틱)' 제거가 '검증 우회'가 되면 안 된다 — 빠른 룰엔진 재검증은 유지.)
cp "$G/reference-notes.json" "$G/reference-notes.json.clean"
python3 "$ROOT/scripts/lib/harness.py" jset "$G/reference-notes.json" notes '"미백 효과 최고 No.1 anti-aging"' >/dev/null
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
{ [ "$(jq_phase "$RID" phase)" = "00g-guideline" ] && [ ! -f "$GV" ]; } \
  && pass "면제 autopass: 생성후 변조(효능·절대어) → validate-stage fail-closed(전진·verdict 차단)" \
  || fail "면제 autopass 가 변조 산출물을 통과시킴(검증 우회) — phase=$(jq_phase "$RID" phase) verdict존재=$([ -f "$GV" ] && echo Y || echo N)"
mv "$G/reference-notes.json.clean" "$G/reference-notes.json"
# ── 정상(복원) 산출물 → 심의 면제 자동 통과 → 01-brief 전진 ──
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
[ "$(python3 "$ROOT/scripts/lib/harness.py" jget "$GV" verdict)" = "pass" ] && pass "참조 노트 심의 면제 자동 통과(verdict=pass)" || fail "참조 노트 verdict 비정상"
# 심의 면제(phase-descriptors review:false) 회귀 가드: 실제 룰엔진/critic 이 아니라 review-exempt-autopass 로 통과해야 한다(중복 심의 제거).
{ [ "$(python3 "$ROOT/scripts/lib/harness.py" jget "$GV" engine)" = "review-exempt-autopass" ] \
  && [ "$(python3 "$ROOT/scripts/lib/harness.py" jget "$GV" review_depth)" = "exempt" ]; } \
  && pass "00g-guideline 심의 면제(engine=review-exempt-autopass · review_depth=exempt)" \
  || fail "00g 심의 면제 미적용(engine=$(python3 "$ROOT/scripts/lib/harness.py" jget "$GV" engine))"
# L-1(Codex P3 회귀 가드): autopass 심의(면제)도 provenance.jsonl 에 review 기록을 남긴다 — 감사 로그가 면제 경로를 빠뜨리면 안 됨.
PJG="$ROOT/runs/$RID/.logs/provenance.jsonl"
{ [ -f "$PJG" ] && grep -q '"engine": *"review-exempt-autopass"' "$PJG"; } \
  && pass "(L-1) 면제 autopass 도 provenance review 기록(engine=review-exempt-autopass)" \
  || fail "(L-1) autopass 심의 provenance 누락(감사 로그가 면제 경로 빠뜨림)"
phase_is "01-brief" && pass "참조 노트 승인+면제 통과 → 01-brief 전진" || fail "01-brief 전진 실패(실제 $(jq_phase "$RID" phase))"

# ── 브리프 생성(참조 노트는 브리프 경유 아님 — 다운스트림이 build_context REFERENCE_NOTES 로 직접 참조) ──
( cd "$ROOT" && bash scripts/run-stage.sh brief "$RID" ) >/dev/null 2>&1
[ -f "$ROOT/runs/$RID/01-brief/brief.json" ] && pass "브리프 생성(confirmed_guideline 미반영 — 파기)" || fail "브리프 누락"
# 크롤 참조 노트가 build_context REFERENCE_NOTES 로 컨셉·스토리라인·이미지 생성에 주입(자유텍스트 인라인 — 1번 작업의 핵심)
RNOUT="$( source "$ROOT/scripts/lib/common.sh"; build_context "$RID" storyboard-outline 2>/dev/null )" || true
case "$RNOUT" in
  *"REFERENCE_NOTES"*) pass "REFERENCE_NOTES 가 다운스트림(스토리라인) 컨텍스트에 주입(참조 입력 반영)";;
  *) fail "REFERENCE_NOTES 미주입(참조 노트가 스토리라인/아웃라인/이미지로 안 흘러감)";;
esac

# ── 후방호환: 사례 없으면 00g-guideline 건너뛰고 01-brief 직행 ──
# '사례 없음' = 헤르메틱 빈 사례 디렉터리(로컬 inputs/examples/<도메인> corpus 로부터 격리; lib.sh:26).
#   unset 은 기본 inputs/examples 로 폴백해 로컬 corpus 존재 머신에서 00g 로 오라우팅됨(dev 오염) → 헤르메틱 명시.
export HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" ) >/dev/null 2>&1
[ "$(jq_phase "$RID2" phase)" = "01-brief" ] && pass "사례 없음 → 00g-guideline 건너뜀(후방호환)" || fail "사례 없을 때 01-brief 기대, 실제 $(jq_phase "$RID2" phase)"

# ── M2 골격: ingest 도메인 프로파일(화장품=모듈 기본값, 비화장품=오버라이드) ──
[ "$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import ingest as i;print('커버' in i.VOC_KEYWORDS and 'whitening' in i.FUNC_LABELS)")" = "True" ] \
  && pass "ingest 프로파일: cosmetic = 모듈 기본값(byte-호환)" || fail "cosmetic ingest 기본값 변형됨"
[ "$(HARNESS_DOMAIN=quasi_drug python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import ingest as i;print(i.VOC_KEYWORDS==[] and i.FUNC_LABELS=={} and i.OPTION_REGEX=='' and i._PROFILE.get('product_type_default')=='quasi_drug')")" = "True" ] \
  && pass "ingest 프로파일: quasi_drug 오버라이드(화장품 키워드 미적용)" || fail "quasi_drug 프로파일 미적용"

# ── ⓐ 유형 선언 강제(브리프 0단계: 규제도메인 + 산출물 포맷) ──
rm -rf "$ROOT/runs/ci-decl" "$ROOT/runs/ci-nodecl"
( unset HARNESS_DOMAIN HARNESS_FORMAT; cd "$ROOT" && bash scripts/new-run.sh ci-decl ) >/dev/null 2>&1 \
  && fail "유형 미선언 new-run 이 통과됨(중단돼야 함)" || pass "유형 미선언 new-run → 친절히 중단"
( cd "$ROOT" && bash scripts/new-run.sh ci-decl --domain 의약외품 --format 한장 ) >/dev/null 2>&1
{ [ "$(jq_phase ci-decl product.regulatory_domain)" = "quasi_drug" ] && [ "$(jq_phase ci-decl product.deliverable_format)" = "one_pager" ]; } \
  && pass "유형 선언(한국어 별칭) → state 에 도메인(의약외품→quasi_drug)+포맷(한장→one_pager) 기록" || fail "유형 선언 기록 실패"
( unset HARNESS_DOMAIN HARNESS_FORMAT; cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-nodecl ) >/dev/null 2>&1 \
  && fail "유형 미선언 ingest 가 통과됨(cosmetic 자동폴백 금지)" || pass "유형 미선언 ingest → 친절히 중단(cosmetic 자동폴백 제거)"
rm -rf "$ROOT/runs/ci-decl" "$ROOT/runs/ci-nodecl"

# ── 포맷 분기(M8): one_pager 도 04-keyvisual 까지 전 페이즈 완주(렌더러 활성). 포맷 차이는 phase-skip 이 아니라 캐논/렌더 폭. ──
rm -rf "$ROOT/runs/ci-onepager" "$ROOT/runs/ci-multi"
( cd "$ROOT" && bash scripts/new-run.sh ci-onepager --domain 화장품 --format 한장 ) >/dev/null 2>&1
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-onepager/state.json" phase '"02-concept"' >/dev/null
route_pass_advance ci-onepager >/dev/null 2>&1   # 02→03-storyboard
[ "$(jq_phase ci-onepager phase)" = "03-storyboard" ] && pass "one_pager: 02-concept → 03-storyboard(스토리보드 거침)" || fail "one_pager 03 진입 실패(실제 $(jq_phase ci-onepager phase))"
route_pass_advance ci-onepager >/dev/null 2>&1   # 03→04-keyvisual (M8: 04 거침)
[ "$(jq_phase ci-onepager phase)" = "04-keyvisual" ] && pass "one_pager: 03-storyboard → 04-keyvisual(M8 — 키비주얼 렌더러 활성)" || fail "one_pager M8 04 진입 실패(실제 $(jq_phase ci-onepager phase))"
route_pass_advance ci-onepager >/dev/null 2>&1   # 04→done
[ "$(jq_phase ci-onepager phase)" = "done" ] && pass "one_pager: 04-keyvisual → done(전 페이즈 완주)" || fail "one_pager 04→done 실패(실제 $(jq_phase ci-onepager phase))"
( cd "$ROOT" && bash scripts/new-run.sh ci-multi --domain 화장품 --format 여러장 ) >/dev/null 2>&1
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-multi/state.json" phase '"02-concept"' >/dev/null
route_pass_advance ci-multi >/dev/null 2>&1
[ "$(jq_phase ci-multi phase)" = "03-storyboard" ] && pass "multipage: 02-concept → 03-storyboard(정상, 회귀 없음)" || fail "multipage 포맷 분기 회귀(실제 $(jq_phase ci-multi phase))"
rm -rf "$ROOT/runs/ci-onepager" "$ROOT/runs/ci-multi"

echo "B1G: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
