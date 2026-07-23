#!/usr/bin/env bash
# test-openalex.sh — OpenAlex 근거검색(B-7) 오프라인·결정적 회귀 가드 (네트워크 0회).
#   실 api.openalex.org 호출은 절대 하지 않는다 — resolve 분기·search_stub·순수함수·evidence_search 를
#   전부 오프라인/monkeypatch 로만 검증한다(온라인 실검색은 라이브 실증에서만 확인).
#   1) resolve_evidence_engine 분기(offline→stub · online→openalex · online+명시stub→die · 잘못된값→die).
#   2) search_stub 결정성·스키마(results.schema)·기본값·engine 주입.
#   3) 환각 안전(evidence_sufficient 기본 false·opt-in 문턱·비정상 env false 폴백).
#   4) _build_url per-page 하이픈 계약(OpenAlex 는 per-page, 언더스코어 per_page 아님).
#   5) grade=발견강도(high/moderate/low; ruleset evidence_grade 아님 — 자동인용 0 계약).
#   6) evidence_search 오프라인 no-op/트리거 로직(monkeypatch, 무네트워크).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B7-OpenAlex — 근거검색 오프라인 단위·회귀(네트워크 0)"

PYL="$ROOT/scripts/lib"
H="$ROOT/scripts/lib/harness.py"
# 동시작업 비충돌 scratch(고유 PID). run_dir 계약과 무관한 순수 임시경로(evidence_search 는 rdir 를 인자로 받음).
SCRATCH="$ROOT/runs/ci-openalex-$$"; mkdir -p "$SCRATCH"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

# ── 1) resolve_evidence_engine 엔진 해석 분기(common.sh source; 무네트워크·무키) ──
#   offline→stub(CI/골든 결정성) · online→openalex(키 불필요·무료 API) · online+명시stub→fail-closed die · 잘못된값→die.
#   (HARNESS_NO_DOTENV=1 은 lib.sh 가 export → bash -c 자식이 상속, .env 오염 없음.)
# (a) 오프라인 → stub (lib.sh 기본 HARNESS_OFFLINE=1)
ENG_OFF="$( cd "$ROOT" && bash -c 'unset HARNESS_EVIDENCE_CLI; source scripts/lib/common.sh; resolve_evidence_engine' 2>/dev/null )"
check "(1a) 오프라인 → stub" "[ \"$ENG_OFF\" = stub ]"
# (b) 온라인(HARNESS_OFFLINE unset) → openalex
ENG_ON="$( cd "$ROOT" && bash -c 'unset HARNESS_OFFLINE HARNESS_EVIDENCE_CLI; source scripts/lib/common.sh; resolve_evidence_engine' 2>/dev/null )"
check "(1b) 온라인 → openalex(키 불필요)" "[ \"$ENG_ON\" = openalex ]"
# (c) 온라인 + 명시 HARNESS_EVIDENCE_CLI=stub → fail-closed die(무음 stub 강등 금지)
( cd "$ROOT" && HARNESS_EVIDENCE_CLI=stub bash -c 'unset HARNESS_OFFLINE; source scripts/lib/common.sh; resolve_evidence_engine' >/dev/null 2>&1 ); RC_C=$?
check "(1c) 온라인 + 명시 stub → die(rc≠0)" "[ $RC_C -ne 0 ]"
# (d) 잘못된 HARNESS_EVIDENCE_CLI 값 → die
( cd "$ROOT" && HARNESS_EVIDENCE_CLI=bogus bash -c 'unset HARNESS_OFFLINE; source scripts/lib/common.sh; resolve_evidence_engine' >/dev/null 2>&1 ); RC_D=$?
check "(1d) 잘못된 HARNESS_EVIDENCE_CLI 값 → die(rc≠0)" "[ $RC_D -ne 0 ]"

# ── 2) search_stub 결정성·스키마·기본값·engine 주입(무네트워크·무시각) ──
# (a) 두 번 호출 동일(결정적 — random/실시각 미사용)
DET="$( cd "$ROOT" && python3 -c "
import json,sys; sys.path.insert(0,'$PYL'); import openalex
a=json.dumps(openalex.search_stub('콜라겐'),sort_keys=True,ensure_ascii=False)
b=json.dumps(openalex.search_stub('콜라겐'),sort_keys=True,ensure_ascii=False)
print('SAME' if a==b else 'DIFF')" )"
check "(2a) search_stub 두 번 호출 동일 출력(결정적)" "[ \"$DET\" = SAME ]"
# (b) 기본 반환 = 빈결과·false·stub
DEF="$( cd "$ROOT" && python3 -c "
import sys; sys.path.insert(0,'$PYL'); import openalex
r=openalex.search_stub('q')
print('OK' if r=={'results':[],'evidence_sufficient':False,'engine':'stub'} else 'BAD')" )"
check "(2b) search_stub 기본값 = {results:[],evidence_sufficient:false,engine:stub}" "[ \"$DEF\" = OK ]"
# (c) 반환이 results.schema.json 유효
SS_JSON="$SCRATCH/stub-results.json"
( cd "$ROOT" && python3 -c "
import json,sys; sys.path.insert(0,'$PYL'); import openalex
json.dump(openalex.search_stub('q'),open('$SS_JSON','w'),ensure_ascii=False)" )
check "(2c) search_stub 반환 results.schema 유효" "python3 '$H' validate '$SS_JSON' --schema results.schema.json >/dev/null 2>&1"
# (d) engine='manual' 주입 → engine=manual(나머지 동일)
MAN="$( cd "$ROOT" && python3 -c "
import sys; sys.path.insert(0,'$PYL'); import openalex
r=openalex.search_stub('q',engine='manual')
print('OK' if r=={'results':[],'evidence_sufficient':False,'engine':'manual'} else 'BAD')" )"
check "(2d) engine='manual' 주입 → engine=manual" "[ \"$MAN\" = OK ]"

# ── 3) 환각 안전 — evidence_sufficient 기본 false·opt-in 문턱·비정상 env false 폴백 ──
#   문턱 env(HARNESS_OPENALEX_MIN_RELEVANCE)는 outer 에 없어야 함 → env -u 로 격리 후 python 내부에서 명시 세팅.
HS="$( cd "$ROOT" && env -u HARNESS_OPENALEX_MIN_RELEVANCE python3 - <<PY
import sys,os
sys.path.insert(0,'$PYL'); import openalex
es=openalex._evidence_sufficient
r2=[{'id':'W1','title':'t','grade':'high','relevance':2.0},{'id':'W2','title':'t','grade':'low','relevance':0.5}]
out=[]
out.append('a1' if es([])==False else 'A1BAD')                      # 0건 → false(문턱 미설정)
out.append('a2' if es(r2)==False else 'A2BAD')                      # 다건 주입 + 문턱 미설정 → false(미검증)
ss=openalex.search_stub('q', results=r2)                            # search_stub 다건 주입도 기본 false(자동 true 금지)
out.append('a3' if ss['evidence_sufficient']==False else 'A3BAD')
os.environ['HARNESS_OPENALEX_MIN_RELEVANCE']='1.0'
out.append('a4' if es([{'relevance':2.0}])==True else 'A4BAD')      # 문턱 1.0 + relevance 2.0 → true
out.append('a5' if es([{'relevance':0.5}])==False else 'A5BAD')     # 문턱 1.0 + relevance 0.5 → false
os.environ['HARNESS_OPENALEX_MIN_RELEVANCE']='notanumber'
out.append('a6' if es([{'relevance':2.0}])==False else 'A6BAD')     # 비정상 env → 문턱 미적용(false 폴백)
print(' '.join(out))
PY
)"
check "(3a) 0건 → evidence_sufficient=false" "echo \"$HS\" | grep -qw a1"
check "(3b) 다건 주입 + 문턱 미설정 → false(미검증)" "echo \"$HS\" | grep -qw a2"
check "(3c) search_stub 다건 주입도 기본 false(자동 true 금지)" "echo \"$HS\" | grep -qw a3"
check "(3d) 문턱 1.0 + relevance 2.0 → true" "echo \"$HS\" | grep -qw a4"
check "(3e) 문턱 1.0 + relevance 0.5 → false" "echo \"$HS\" | grep -qw a5"
check "(3f) 비정상 문턱 env → false 폴백" "echo \"$HS\" | grep -qw a6"

# ── 4) _build_url per-page 하이픈 계약(OpenAlex 는 per-page; 언더스코어 per_page 는 무시됨) ──
URLCHK="$( cd "$ROOT" && python3 -c "
import sys; sys.path.insert(0,'$PYL'); import openalex
u=openalex._build_url('q',5,None)
print('OK' if ('per-page=' in u and 'per_page=' not in u) else 'BAD')" )"
check "(4) _build_url 에 per-page= 포함·per_page= 부재" "[ \"$URLCHK\" = OK ]"

# ── 5) grade = 발견강도(high/moderate/low) — ruleset evidence_grade(SCI/SCIE 등) 아님(자동인용 0 계약) ──
GR="$( cd "$ROOT" && python3 - <<PY
import sys
sys.path.insert(0,'$PYL'); import openalex
g=[openalex._grade(150), openalex._grade(50), openalex._grade(1)]
allowed={'high','moderate','low'}
ok=(g==['high','moderate','low']) and all(x in allowed for x in g) and not any('SCI' in x for x in g)
print('OK' if ok else 'BAD')
PY
)"
check "(5) _grade 반환은 high/moderate/low(강도)·evidence_grade 아님" "[ \"$GR\" = OK ]"

# ── 6) evidence_search 오프라인 no-op/트리거 로직(monkeypatch — 실 API 0회) ──
ES6="$( cd "$ROOT" && python3 - "$SCRATCH" <<PY
import sys,os,json,shutil
scratch=sys.argv[1]
sys.path.insert(0,'$PYL')
import openalex, evidence_search

def mkrun(rid, trigger_text, seed_openalex=False):
    rdir=os.path.join(scratch, rid)
    if os.path.exists(rdir): shutil.rmtree(rdir)
    optdir=os.path.join(rdir,'02-concept','options','B'); os.makedirs(optdir)
    json.dump({'selected':'B'}, open(os.path.join(rdir,'02-concept','decision.json'),'w'), ensure_ascii=False)
    json.dump({'rtb':[{'claim':trigger_text}]}, open(os.path.join(optdir,'rtb.json'),'w'), ensure_ascii=False)
    if seed_openalex:
        sdir=os.path.join(rdir,'03-storyboard','sources'); os.makedirs(sdir)
        json.dump({'results':[{'id':'STALE','title':'old','grade':'high'}],'evidence_sufficient':True,'engine':'openalex'},
                  open(os.path.join(sdir,'results.json'),'w'), ensure_ascii=False)
    return rdir

calls={'n':0}
def fake_search(claim, *a, **k):
    calls['n']+=1
    return {'results':[{'id':'W-FAKE','title':claim,'grade':'high'}],'evidence_sufficient':False,'engine':'openalex'}
openalex.search=fake_search   # monkeypatch — 실 네트워크 대체(무-네트워크 보장)

out=[]
# (a) engine != openalex → no-op(sources 미생성·search 미호출)
rdir=mkrun('r-noop','콜라겐'); calls['n']=0
rc=evidence_search.main(['r-noop', rdir, 'stub'])
sp=os.path.join(rdir,'03-storyboard','sources')
out.append('b1' if (rc==0 and calls['n']==0 and not os.path.exists(sp)) else 'B1BAD')
# (b) 트리거 있음 + openalex → fake search 호출·results 기록·query.claim 기록
rdir=mkrun('r-trig','콜라겐'); calls['n']=0
rc=evidence_search.main(['r-trig', rdir, 'openalex'])
res=json.load(open(os.path.join(rdir,'03-storyboard','sources','results.json')))
q=json.load(open(os.path.join(rdir,'03-storyboard','sources','query.json')))
out.append('b2' if (rc==0 and calls['n']==1 and res['results'][0]['id']=='W-FAKE' and q['claim']=='콜라겐') else 'B2BAD')
# (c) 무-트리거 → search 미호출·빈 sources 정리(engine=manual)
rdir=mkrun('r-notrig','좋은 화장품'); calls['n']=0
rc=evidence_search.main(['r-notrig', rdir, 'openalex'])
res=json.load(open(os.path.join(rdir,'03-storyboard','sources','results.json')))
out.append('b3' if (rc==0 and calls['n']==0 and res['results']==[] and res['evidence_sufficient']==False and res['engine']=='manual') else 'B3BAD')
# (d) 기존 engine:openalex 파일이 있어도 항상 재검색(mock 신뢰 안 함)
rdir=mkrun('r-stale','콜라겐', seed_openalex=True); calls['n']=0
rc=evidence_search.main(['r-stale', rdir, 'openalex'])
res=json.load(open(os.path.join(rdir,'03-storyboard','sources','results.json')))
out.append('b4' if (rc==0 and calls['n']==1 and res['results'][0]['id']=='W-FAKE') else 'B4BAD')
print(' '.join(out))
PY
)"
check "(6a) engine!=openalex → no-op(sources 미생성·search 미호출)" "echo \"$ES6\" | grep -qw b1"
check "(6b) 트리거 있음+openalex → search 호출·results 기록·query.claim 기록" "echo \"$ES6\" | grep -qw b2"
check "(6c) 무-트리거 → search 미호출·빈 sources 정리(engine=manual)" "echo \"$ES6\" | grep -qw b3"
check "(6d) 기존 openalex 파일 있어도 항상 재검색(mock 신뢰 안 함)" "echo \"$ES6\" | grep -qw b4"

echo "B7-OpenAlex: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
