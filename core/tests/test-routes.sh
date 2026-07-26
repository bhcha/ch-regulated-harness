#!/usr/bin/env bash
# test-routes.sh — WS-ROUTES: 선언적 라우트 테이블(harness/pipeline-routes.json) 골든 가드.
#   라우트 테이블이 셸 하드코딩(next_phase·max_iterations·render ORDER)을 '동일하게' 재현하는지,
#   그리고 조건부 술어(active_phases@advance)가 라우트로 '융합되지 않고' 그대로 동작하는지 보장한다.
#   (1) 스키마 유효 (2) 테이블 커버리지·ORDER 도출 (3) 전이/ max_iterations 골든 (4) one_pager active_phases 술어 유지(M7: 03 거침·04 만 스킵)
#   (5) 미정의 페이즈 hard-fail (6) next-action.json ↔ render 일관.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## WS-ROUTES — 선언적 라우트 테이블 골든"
export HARNESS_CLI=stub HARNESS_OFFLINE=1
H="$ROOT/scripts/lib/harness.py"
RT="$ROOT/harness/pipeline-routes.json"

# ── N11·N12 양성완료 게이트 케이스((3·ingest)·(5b3))용 최소 합성 번들 ──
#   이 케이스들은 00-ingest '완료'(status=passed+필수4종)가 전제라 실 ingest 가 필요하다. 시드 번들($BUNDLE)이
#   이 박스엔 없으므로(번들 비의존 원칙) test-evidence-attachment 와 동일하게 최소 합성 번들/WB 를 만든다.
RSCRATCH="$(mktemp -d)"; RBUNDLE="$RSCRATCH/bundle"; RWB="$RSCRATCH/wb.md"; RASSETS="$RSCRATCH/assets"
mkdir -p "$RBUNDLE" "$RASSETS"
cat > "$RBUNDLE/product.json" <<'JSON'
{"name":"라우트 테스트 제품","collectedReviewCount":2,"totalReviewCount":2,"rating":4.5,"price":{"current":10000}}
JSON
printf 'content,score,option\n"커버 좋아요",5,"21호"\n"촉촉합니다",4,"21호"\n' > "$RBUNDLE/reviews.csv"
cat > "$RWB" <<'MD'
# 워킹백워드 — 라우트 테스트 픽스처
## 제품 개요
- 제품유형: 색조화장품(쿠션)
- 핵심 사용 가치: 커버력, 촉촉
MD

# ── (1) 라우트 테이블이 자기 스키마를 만족 ──
check "(1) pipeline-routes.json 이 pipeline-routes.schema.json 검증 통과" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
import harness
sch=harness.load_json('$ROOT/harness/pipeline-routes.schema.json')
data=harness.load_json('$RT')
v=harness.Validator(sch,sch); v.validate(data,sch)
sys.exit(0 if not v.errors else 1)
PY"

# ── (2) 커버리지: 모든 next 타깃은 (페이즈 키 ∪ end) · entry/end 존재 · 도출 ORDER = 정전 선형순서 ──
check "(2a) 모든 next 타깃이 정의된 페이즈이거나 end (dangling 없음)" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import load_json
d=load_json('$RT'); ph=set(d['phases']); end=d['end']
bad=[p for p,v in d['phases'].items() if v['next']!=end and v['next'] not in ph]
assert d['entry'] in ph, 'entry not a phase'
sys.exit(0 if not bad else 1)
PY"
check "(2b) render ORDER 가 라우트 테이블에서 도출되어 정전 선형순서와 일치" \
  "[ \"\$(python3 -c \"import sys;sys.path.insert(0,'$ROOT/scripts/lib');import render_runmd as R;print(','.join(R.ORDER))\")\" = '00-ingest,01-brief,02-concept,03-storyboard,04-keyvisual' ]"
# (2c) 전체 테이블 골든: 모든 행(00g-guideline 포함)을 기대 dict 와 '바이트 동일' 비교 — 어떤 한 행의 next/max_iterations
#      가 옛 하드코딩값에서 벗어나면 즉시 실패(부분 EXPECT 가 놓치는 00g 행까지 가드).
check "(2c) 라우트 테이블 전체 = 기대 dict (00g 행 포함 전 행 골든)" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import load_json
got=load_json('$RT')['phases']
want={'00a-intake':{'next':'00-ingest','max_iterations':3},
      '00-ingest':{'next':'01-brief','max_iterations':3},
      '00e-evidence':{'next':'01-brief','max_iterations':3},
      '00g-guideline':{'next':'01-brief','max_iterations':3},
      '01-brief':{'next':'02-concept','max_iterations':3},
      '02-concept':{'next':'03-storyboard','max_iterations':3},
      '03-storyboard':{'next':'04-keyvisual','max_iterations':4},
      '04-keyvisual':{'next':'done','max_iterations':2}}
sys.exit(0 if got==want else 1)
PY"
# (2d) 닫힌 스키마 가드레일: 동결 외 페이즈(typo/registry 표류)는 스키마가 거부해야 한다(라우트가 phase registry 로 변질 방지).
check "(2d) 스키마가 동결 외 페이즈 키('05-bogus')를 거부" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
import harness, copy
sch=harness.load_json('$ROOT/harness/pipeline-routes.schema.json'); data=harness.load_json('$RT')
bad=copy.deepcopy(data); bad['phases']['05-bogus']={'next':'done','max_iterations':1}
v=harness.Validator(sch,sch); v.validate(bad,sch)
sys.exit(0 if v.errors else 1)   # errors 있어야(=거부) 통과
PY"
check "(2e) 스키마가 동결 외 next 타깃('99-nowhere')을 거부" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
import harness, copy
sch=harness.load_json('$ROOT/harness/pipeline-routes.schema.json'); data=harness.load_json('$RT')
bad=copy.deepcopy(data); bad['phases']['04-keyvisual']['next']='99-nowhere'
v=harness.Validator(sch,sch); v.validate(bad,sch)
sys.exit(0 if v.errors else 1)
PY"

# ── (3) 전이 골든: multipage 런을 advance-phase 로 구동 → 페이즈/ max_iterations 가 테이블과 동일 ──
#   (생성 없이 전이만 검증 — 라우트 테이블이 next_phase·max_iterations 하드코딩을 정확히 재현함을 확인.)
RID=ci-routes-mp; rm -rf "$ROOT/runs/$RID"
( cd "$ROOT" && bash scripts/new-run.sh "$RID" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
check "(3·entry) new-run → phase=00-ingest, max_iterations=3 (테이블 entry)" \
  "[ \"\$(jq_phase "$RID" phase)\" = '00-ingest' ] && [ \"\$(jq_phase "$RID" max_iterations)\" = '3' ]"
# N11·N12(00-ingest 양성완료 게이트): fresh new-run 만으론 00-ingest→후속 --to 가 거부된다(status≠passed·필수4종 미검증).
#   실 ingest(오프라인 결정적)로 00-ingest 를 genuinely 완료시킨다 — ingest-bundle 이 필수4종을 검증(status=passed)한
#   '뒤' 정당 후속으로 --to 전이하므로(사례 없음 → 01-brief), 00-ingest→01-brief 전이는 양성완료 게이트를 정상 통과한다.
#   (HERMETIC_EXAMPLES=빈 사례로 라우팅 결정성 고정 — 로컬 사례corpus 오염 무관하게 01-brief 직행 재현.)
( cd "$ROOT" && HARNESS_WB="$RWB" HARNESS_ASSETS_DIR="$RASSETS" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" bash scripts/ingest-bundle.sh "$RBUNDLE" "$RID" ) >/dev/null 2>&1
check "(3·ingest) 실 ingest 완료 → 00-ingest→01-brief 전이(양성완료 게이트 통과)·max_iterations=3" \
  "[ \"\$(jq_phase "$RID" phase)\" = '01-brief' ] && [ \"\$(jq_phase "$RID" max_iterations)\" = '3' ]"
# 기대 전이표 (phase:max) — 03=4(3 substage 공유)·04=2(디자인 ≤2)·그외=3. (00-ingest→01-brief 는 위 ingest 가 수행)
EXPECT=( "02-concept:3" "03-storyboard:4" "04-keyvisual:2" )
ok_seq=1
for e in "${EXPECT[@]}"; do
  want_p="${e%%:*}"; want_m="${e##*:}"
  route_pass_advance "$RID" >/dev/null 2>&1
  got_p="$(jq_phase "$RID" phase)"; got_m="$(jq_phase "$RID" max_iterations)"
  [ "$got_p" = "$want_p" ] && [ "$got_m" = "$want_m" ] || { ok_seq=0; echo "    전이 불일치: 기대 $want_p:$want_m · 실제 $got_p:$got_m"; }
done
check "(3·seq) 01→02→03→04 전이 + 페이즈별 max_iterations 골든 일치" "[ $ok_seq -eq 1 ]"
route_pass_advance "$RID" >/dev/null 2>&1
check "(3·end) 04-keyvisual 이후 done 전이" "[ \"\$(jq_phase "$RID" phase)\" = 'done' ]"
check "(3·hist) phase:enter 시퀀스 = 01-brief,02-concept,03-storyboard,04-keyvisual" "python3 - <<'PY'
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import load_json
h=load_json('$ROOT/runs/$RID/state.json')['history']
seq=[e['phase'] for e in h if e['event']=='phase:enter']
sys.exit(0 if seq==['01-brief','02-concept','03-storyboard','04-keyvisual'] else 1)
PY"

# ── (4) 술어 비융합(M8): M8 에서 전 포맷이 03·04 mainline 을 거치므로(렌더러 활성) mainline skip 은 없고,
#   active_phases 술어의 현재 작용점은 00g-guideline(off-mainline) 진입 제어다 — ingest 가 examples 있어도
#   '포맷 active_phases 에 00g 가 있을 때만' 00g 로 라우팅(단계5). one_pager=00g 포함 → 00g.
EXR4="$(mktemp -d)"; mkdir -p "$EXR4/cosmetic"; cp -r "$BUNDLE" "$EXR4/cosmetic/ex1"
RID2b=ci-routes-opg; rm -rf "$ROOT/runs/$RID2b"
( cd "$ROOT" && HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=one_pager HARNESS_EXAMPLES_DIR="$EXR4" bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2b" ) >/dev/null 2>&1
check "(4·op00g) one_pager: examples → 00g 진입 (active_phases 에 00g 포함 — 비융합 확인)" \
  "[ \"\$(jq_phase "$RID2b" phase)\" = '00g-guideline' ]"
rm -rf "$EXR4" "$ROOT/runs/$RID2b"

# ── (5) 미정의 페이즈 = hard-fail (silent 폴백/eval 표류 차단 가드레일) ──
check "(5a) route_next 미정의 페이즈 → 비0 종료(hard-fail)" \
  "( cd \"$ROOT\" && HARNESS_ROOT=\"$ROOT\" bash -c 'source scripts/lib/common.sh; route_next bogus-phase' ) >/dev/null 2>&1; [ \$? -ne 0 ]"
# advance-phase --to <동결 외 페이즈>: route_max_iter 가 hard-fail → 동결 외 phase 가 state.json 에 안 써진다.
RID4=ci-routes-tobogus; rm -rf "$ROOT/runs/$RID4"
( cd "$ROOT" && bash scripts/new-run.sh "$RID4" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/advance-phase.sh "$RID4" --to 05-bogus ) >/dev/null 2>&1; TO_RC=$?
check "(5b) advance-phase --to 동결외('05-bogus') → 비0 종료(hard-fail)" "[ $TO_RC -ne 0 ]"
check "(5c) 실패한 --to 후 state.phase 가 동결 외 값으로 오염되지 않음" \
  "[ \"\$(jq_phase "$RID4" phase)\" = '00-ingest' ]"
# (5b2·외부리뷰 2R Critical) --to <유효 동결 phase 지만 비후속>(04-keyvisual) → 거부: --to 는 00-ingest 후속(00g/01-brief)만.
#   심의 게이트 보유 페이즈로 점프해 사람승인·심의를 우회하는 것 차단(부록A-9).
( cd "$ROOT" && bash scripts/advance-phase.sh "$RID4" --to 04-keyvisual ) >/dev/null 2>&1; TOKV_RC=$?
check "(5b2) --to 04-keyvisual(유효 phase·비후속) → 거부(00g/01-brief 만)" "[ $TOKV_RC -ne 0 ]"
check "(5b2·noop) 거부 후 phase 유지(00-ingest)" "[ \"\$(jq_phase "$RID4" phase)\" = '00-ingest' ]"
# (5b3) 정당 후속(01-brief)은 00-ingest '완료' 후 허용 — ingest 라우팅 비회귀.
#   N11·N12: fresh new-run(위 (5b)/(5b2) 거부 후에도 phase=00-ingest 유지) 만으론 양성완료 게이트가 --to 를 거부한다.
#   같은 RID4 에 실 ingest(오프라인 결정적, 빈 사례)를 돌려 00-ingest 를 완료시키면, ingest-bundle 이 필수4종 검증
#   (status=passed) 뒤 정당 후속(사례 없음 → 01-brief)으로 --to 전이한다 → 00-ingest→01-brief 정상 라우팅 통과.
( cd "$ROOT" && HARNESS_WB="$RWB" HARNESS_ASSETS_DIR="$RASSETS" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" bash scripts/ingest-bundle.sh "$RBUNDLE" "$RID4" ) >/dev/null 2>&1; TOOK_RC=$?
check "(5b3) 실 ingest 완료 → 00-ingest 정당 후속(01-brief) 전이 허용(정상 라우팅 비회귀)" "[ $TOOK_RC -eq 0 ] && [ \"\$(jq_phase "$RID4" phase)\" = '01-brief' ]"
# (5d) route_assert_valid 가 '모든' 페이즈에서 체인을 본다: off-mainline(00g-guideline) self-cycle 는
#      스키마-유효(next 가 동결 enum)지만 체인이 깨졌으므로 런타임 게이트가 거부해야 한다(본선만 보면 놓침).
BADRT="$ROOT/runs/.bad-routes-cycle.json"; mkdir -p "$ROOT/runs"
python3 - "$RT" "$BADRT" <<'PY'
import sys, json
d=json.load(open(sys.argv[1])); d['phases']['00g-guideline']['next']='00g-guideline'  # self-cycle
json.dump(d, open(sys.argv[2],'w'))
PY
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash -c 'source scripts/lib/common.sh; ROUTES_FILE="'"$BADRT"'"; route_assert_valid' ) >/dev/null 2>&1; CYC_RC=$?
check "(5d) route_assert_valid 가 00g-guideline self-cycle(스키마유효·체인깨짐) 거부" "[ $CYC_RC -ne 0 ]"
rm -f "$BADRT"
# (5e) 외부 오염 방어: state.phase 가 동결 외 값이면 --to 로도 전이 거부 + 상태 미변경.
RID5=ci-routes-corrupt; rm -rf "$ROOT/runs/$RID5"
( cd "$ROOT" && bash scripts/new-run.sh "$RID5" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
python3 "$H" jset "$ROOT/runs/$RID5/state.json" phase '"05-bogus"' >/dev/null 2>&1   # 오염 모사(스크립트 외 직접쓰기)
( cd "$ROOT" && bash scripts/advance-phase.sh "$RID5" --to 01-brief ) >/dev/null 2>&1; CORR_RC=$?
check "(5e) 오염된 현재 phase(05-bogus) + --to 01-brief → 비0 종료(우회 차단)" "[ $CORR_RC -ne 0 ]"
check "(5e·noop) 거부 후 phase 가 그대로(전이 미발생)" "[ \"\$(jq_phase "$RID5" phase)\" = '05-bogus' ]"

# ── (6) next-action ↔ render 라우트 일관(비공허): 기계용 SSoT 의 stage 가 render next_command 와 동일 +
#       보드 순서(_effective_order)가 라우트 도출 ORDER 와 동일(순서 드리프트 가드). ──
RID3=ci-routes-na; rm -rf "$ROOT/runs/$RID3"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID3" ) >/dev/null 2>&1
check "(6a) next-action.stage == render next_command stage (== 'brief'), 배선 드리프트 가드" "python3 - <<'PY'
import sys, os, json, subprocess
sys.path.insert(0,'$ROOT/scripts/lib')
import render_runmd as R
from harness import load_json
rdir='$ROOT/runs/$RID3'; st=load_json(os.path.join(rdir,'state.json'))
na=json.loads(subprocess.check_output(['bash','$ROOT/scripts/next-action.sh','$RID3'],cwd='$ROOT'))
# render 가 실제로 emit 한 명령에서 stage 를 '파싱'해 비교(하드코딩 금지) — render 가 다른 run-stage
# 명령을 내보내도록 바뀌면 이 비교가 깨져야 한다(비공허). cmd 예: 'bash scripts/run-stage.sh brief <rid>'.
cmd,_,_,_=R.next_command('$RID3', st, rdir)
parts=cmd.split()
idx=next((i for i,p in enumerate(parts) if p.endswith('run-stage.sh')), None)   # 토큰은 'scripts/run-stage.sh'
render_stage=parts[idx+1] if idx is not None else None
sys.exit(0 if na.get('stage')==render_stage=='brief' else 1)
PY"
check "(6b) 보드 순서 _effective_order == 라우트 도출 ORDER (순서 SSoT 드리프트 없음)" "python3 - <<'PY'
import sys, os
sys.path.insert(0,'$ROOT/scripts/lib')
import render_runmd as R
from harness import load_json
rdir='$ROOT/runs/$RID3'; st=load_json(os.path.join(rdir,'state.json'))
# 00g 미사용(단일 번들) 런 → 보드 순서 = 라우트 도출 선형 ORDER 와 동일해야
sys.exit(0 if R._effective_order(st, rdir)==R.ORDER else 1)
PY"

rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID3" "$ROOT/runs/$RID4" "$ROOT/runs/$RID5" "$RSCRATCH"
printf '\n[routes] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
