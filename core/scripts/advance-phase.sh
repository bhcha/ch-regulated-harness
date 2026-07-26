#!/usr/bin/env bash
# advance-phase.sh — 페이즈 전이 + run.md 재생성 (설계 §5.3, §10.2).
# 사용법:
#   bash scripts/advance-phase.sh <run_id>              # 다음 페이즈로(iteration=1 리셋)
#   bash scripts/advance-phase.sh <run_id> --to <phase> # 특정 페이즈로
#   bash scripts/advance-phase.sh <run_id> --render-only# run.md 만 재생성
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든(--to·자동·--render-only 포함) fail-closed
SF="$(state_file "$RID")"

render() { "$PY" "$HARNESS_ROOT/scripts/lib/render_runmd.py" "$RID" "$(run_dir "$RID")"; }

if [ "${2:-}" = "--render-only" ]; then render; exit 0; fi

_ADV_T0="$(date +%s)"   # 개선0(측정): 실제 페이즈 전이 시각(--render-only 제외 — 진짜 전이만 기록).
LOCK_OWN=0
if [ -z "${HARNESS_LOCK_HELD:-}" ]; then acquire_lock "$RID"; LOCK_OWN=1; fi

# M4(외부리뷰 CRITICAL/HIGH): 페이즈 전이 우회 가드 — **lock 획득 뒤** state 를 읽어(stale-read 경쟁 차단) 검증한다.
#   ① no-arg 자동 전이는 심의 통과 상태(gate=review + 현재 페이즈 verdict=pass)에서만(부록A-9). env 토큰이 아닌 비위조 state 검증.
#   ② --to 명시 라우팅은 **입력단계(00-ingest)에서만** 허용 — 심의게이트 없는 입력단계가 00g/01-brief 로 가는 정당 경로.
#      그 외 페이즈(user/select/review 게이트)에서 --to 로 점프해 사람승인·심의를 우회하는 것을 차단(부록A-9). 'done' 직행 금지.
_ADV_PHASE="$(jget "$SF" phase 2>/dev/null || true)"
if [ "${2:-}" = "--to" ]; then
  [ "${3:-}" != "done" ] || die "--to done 금지: 종료(done) 전이는 심의 통과 finalize(gate.sh review-pass)에서만."
  # ② --to 명시 라우팅은 **입력단계(00-ingest)에서 그 정당 후속(00g-guideline|01-brief)으로만**(외부리뷰 2R Critical).
  #   00-ingest 는 심의게이트가 없는 입력단계라 ingest-bundle 이 examples 유무에 따라 00g/01-brief 로 라우팅한다.
  #   현재 phase 나 타깃을 제한하지 않으면 user/select/review 게이트에서 임의 phase 로 점프해 사람승인·심의를 우회(부록A-9).
  [ "$_ADV_PHASE" = "00-ingest" ] \
    || die "--to 명시 라우팅은 00-ingest(입력단계)에서만 허용됩니다(현재 phase=${_ADV_PHASE:-?}). 심의 게이트 보유 페이즈의 전이는 gate.sh review-pass(자동)만 — 승인·심의 우회 금지(부록A-9)."
  case "${3:-}" in
    00e-evidence|00g-guideline|01-brief) ;;
    *) die "--to 타깃은 00-ingest 의 정당 후속(00e-evidence|00g-guideline|01-brief)만 허용됩니다('${3:-}' 금지) — 심의 게이트 보유 페이즈로 점프 금지(부록A-9)." ;;
  esac
  # ── N11·N12: 00-ingest 양성 완료 게이트 — 정당 후속(00g-guideline·01-brief) 양쪽 모두에 적용. ──
  #   sentinel 부재는 '필요조건'일 뿐 충분조건이 아니다: fresh 런(ingest 미시작)은 sentinel 이 애초에 없어
  #   '부재=완료'로 오판하면 ingest 를 건너뛴 직행 점프가 열린다(외부리뷰 r8). 특정 타깃(01-brief)만 막으면 다른
  #   후속(00g-guideline)으로 우회되므로 위 case 의 두 후속 모두에 적용한다(외부리뷰 r9). 따라서 '양성 완료'를
  #   증명해야 전이한다: ① state.status=passed(00-ingest) 그리고 ② 필수 4종(voc·claim-basis·assets-manifest·
  #   best-practices) present+valid. 결정적·오프라인 안전(네트워크/LLM 없음): state 읽기 + 로컬 스키마 검증뿐.
  #   정상 경로: ingest-bundle.sh 가 이 4종을 검증(status=passed)한 '뒤' --to 를 부르므로 통과한다.
  _ADV_ING_ST="$(jget "$SF" status 2>/dev/null || true)"
  [ "$_ADV_ING_ST" = "passed" ] \
    || die "00-ingest 가 아직 끝나지 않았어요(현재 상태=${_ADV_ING_ST:-없음}) — bash scripts/ingest-bundle.sh <번들> $RID 로 인입을 먼저 끝내세요."
  _ADV_ING_RDIR="$(run_dir "$RID")"
  for _ing_a in voc.json claim-basis.json assets-manifest.json best-practices.json; do
    { [ -f "$_ADV_ING_RDIR/00-ingest/$_ing_a" ] && validate_artifact "$_ADV_ING_RDIR/00-ingest/$_ing_a" >/dev/null 2>&1; } \
      || die "00-ingest 필수 산출물이 없거나 형식이 맞지 않아요($_ing_a) — bash scripts/ingest-bundle.sh <번들> $RID 로 인입을 다시 실행하세요."
  done
else
  _ADV_G="$(jget "$SF" gate 2>/dev/null || true)"
  _ADV_VP="$(verdict_path "$RID" 2>/dev/null || true)"
  _ADV_V=""; [ -n "$_ADV_VP" ] && [ -f "$_ADV_VP" ] && _ADV_V="$(jget "$_ADV_VP" verdict 2>/dev/null || true)"
  if [ "$_ADV_G" != "review" ] || [ "$_ADV_V" != "pass" ]; then
    die "자동 페이즈 전이는 심의 통과(gate=review + verdict=pass) 후에만 가능합니다(부록A-9). 현재 gate=${_ADV_G:-?}, verdict=${_ADV_V:-없음}. 승인·심의 우회 금지."
  fi
  # ★ 근본 가드(외부리뷰 4R High): no-arg 전이는 **gate.sh review-pass 가 직전에 기록한 전이 의도 history 마커**가 있어야만 허용한다.
  #   gate.sh review-pass 는 phase별 검증(03-plan=plan 완전성 validate / 04=manifest 일치+export_package)을 마친 뒤
  #   'review:passed→advance'(일반) 또는 'review:passed→export-finalize'(04) 를 history 에 남기고 advance-phase 를 부른다.
  #   직접 no-arg 호출은 이 마커가 없으므로(마지막 이벤트가 verdict/사람행위) 거부 → phase별 검증 우회를 phase 불문 한 번에 차단.
  #   (env 토큰이 아닌 비위조 state(history) 기반 — 위조는 state.json 단일쓰기 불변식 소관, M4 철학 준수.)
  _ADV_LASTEV="$("$PY" -c "import json
try:
  h=json.load(open('$SF')).get('history') or []
  print(h[-1].get('event','') if h else '')
except Exception: print('')" 2>/dev/null || true)"
  case "$_ADV_LASTEV" in
    "review:passed→advance"|"review:passed→export-finalize") ;;
    *) die "no-arg 페이즈 전이는 gate.sh review-pass 직후에만 허용됩니다(부록A-9) — 직접 호출로 phase별 검증(03-plan 완전성·04 export) 우회 금지. 마지막 history 이벤트='${_ADV_LASTEV:-없음}'." ;;
  esac
  # ① 직접 no-arg 호출이 gate.sh review-pass 의 검사를 우회 못하게(외부리뷰 2R Critical, 위 마커와 중첩 방어):
  #   escalate≠true(에스컬레이션 verdict 로 전이 금지) + 04 는 export 패키지 완료 요구(gate.sh review-pass 가 export_package 뒤 advance 호출).
  #   (verdict 스키마 검증은 gate.sh review 가 이미 수행하고, 스키마만으로는 위조 verdict 를 못 거르므로 여기선 생략 — 위조 방지는 단일쓰기 불변식 소관.)
  [ "$(jget "$_ADV_VP" escalate 2>/dev/null || true)" != "true" ] \
    || die "verdict.escalate=true — 자동 전이 불가(에스컬레이션은 사람 개입). 부록A-9."
  if [ "$_ADV_PHASE" = "04-keyvisual" ]; then
    [ -f "$(run_dir "$RID")/04-keyvisual/export/kcia-package/package.json" ] \
      || die "04→done 은 gate.sh review-pass(export finalize)에서만 — 협회 export 패키지 부재(직접 advance 로 export 우회 금지, 부록A-9)."
  fi
  # 03-storyboard outline 심의통과는 gate.sh review-pass 가 **intra-phase 로 outline→plan** 전이한다(라우트 03→04 아님).
  #   no-arg advance 는 라우트 전이(03→04)를 수행해 plan 생성·심의를 통째 건너뛰므로 outline substage 에서는 금지(외부리뷰 3R Critical).
  if [ "$_ADV_PHASE" = "03-storyboard" ] && [ "$(storyboard_substage "$RID")" = "outline" ]; then
    die "03-storyboard outline 심의통과는 gate.sh review-pass 가 plan 으로 전이합니다 — advance-phase 직접 호출 금지(plan 단계 우회, 부록A-9)."
  fi
fi

# WS-ROUTES 무결성 게이트: 라우트 테이블이 닫힌 스키마(동결 phase 집합)+사이클없는 체인을 만족하는지
# state 전이 '전에' 검증한다. 깨진 테이블이 동결 외 페이즈를 state.json 에 쓰는 fail-open 을 차단.
route_assert_valid

# 다음 페이즈는 라우트 테이블(harness/pipeline-routes.json)에서만 읽는다(WS-ROUTES).
# end 센티넬(done) 은 idempotent (done→done) 로 유지하고, 그 외 미정의 페이즈는 route_next 가 hard-fail.
ROUTE_END="$(route_end)"
next_phase() {
  if [ "$1" = "$ROUTE_END" ]; then printf '%s' "$ROUTE_END"; return; fi
  route_next "$1"
}

CUR="$(jget "$SF" phase)"
# WS-ROUTES 가드: 현재 phase 가 동결 페이즈(또는 end)인지 먼저 확인한다. 외부 오염 등으로 state.phase 가
# 동결 외 값이면 --to 든 자동이든 전이를 거부(hard-fail) — "미등록 페이즈=hard-fail" 불변식이 --to 경로로 우회되지 않게.
[ "$CUR" = "$ROUTE_END" ] || route_next "$CUR" >/dev/null
if [ "${2:-}" = "--to" ]; then
  TARGET="${3:?--to 다음에 페이즈명}"
  # --to 는 명시적 override 지만, 포맷 active_phases 밖 페이즈로 강제하면 경고(깨진 경로 조기 인지).
  _FMT="$(jget "$SF" product.deliverable_format 2>/dev/null || true)"
  if [ -n "$_FMT" ] && [ "$TARGET" != "done" ]; then
    _ACT="$(jget "$FORMATS_DIR/format-profiles.json" "formats.$_FMT.active_phases" 2>/dev/null || true)"
    [ -z "$_ACT" ] || printf '%s' "$_ACT" | grep -q "\"$TARGET\"" || info "주의: '$TARGET' 은 포맷 '$_FMT' active_phases 밖입니다(--to 강제)."
  fi
else
  TARGET="$(next_phase "$CUR")"
  # G5: 00e-evidence 를 나갈 때(no-arg, gate.sh review-pass 직후) 두 번째 조건부(00g-guideline)를 조건부 라우터로
  #   잇는다 — examples 있으면 00g, 없으면 01-brief(정적 route next=01-brief 를 덮어씀). 00e 진입은 pending 해소가
  #   전제(gate.sh apply-proposal)라 라우터를 from=00e-evidence 로 불러 pending 술어는 재평가하지 않는다.
  [ "$CUR" != "00e-evidence" ] || TARGET="$(compute_next_conditional "$RID" 00e-evidence)"
  # 산출물 포맷 프로파일의 active_phases 에 없는 페이즈는 건너뛴다(예: one_pager → 03-storyboard 생략).
  FMT="$(jget "$SF" product.deliverable_format 2>/dev/null || true)"
  if [ -n "$FMT" ]; then
    ACTIVE="$(jget "$FORMATS_DIR/format-profiles.json" "formats.$FMT.active_phases" 2>/dev/null || true)"
    if [ -n "$ACTIVE" ]; then
      while [ "$TARGET" != "done" ] && ! printf '%s' "$ACTIVE" | grep -q "\"$TARGET\""; do
        TARGET="$(next_phase "$TARGET")"
      done
    fi
  fi
fi

# G5 pending 초크 게이트: 미해소(spec_status:pending) 참조 문서가 있으면 00e-evidence 외 어떤 전이도 막는다
#   (01-brief·00g-guideline·done 모두 — 01-brief 만 막으면 00g 로 데드엔드 우회되므로 전 타깃에 적용).
#   진입/재진입(--to 00e·no-arg→00e)은 TARGET=00e-evidence 라 통과. 00e 에서 에이전트 제안→사람 승인으로 pending 이
#   해소돼야(gate.sh apply-proposal) 하류로 나간다. 읽기 전용(state 미기록). pending 없음/no-evidence 면 no-op(골든 불변).
if [ "$TARGET" != "00e-evidence" ] && [ "$(evidence_pending "$RID")" = "1" ]; then
  die "미확정 참조 문서가 있어요(반영할 내용 제안·승인 필요) — bash scripts/run-stage.sh evidence $RID 로 제안을 받고 승인하세요."
fi

if [ "$TARGET" = "done" ]; then
  # 반영 강제 done 게이트(evidence-content-integration 6단계): reflect:true 근거 문서가 최종 산출물에 반영
  #   블록으로 실리지 않았으면 done 차단(첨부만 되고 내용 반영 못 한 채 완료 도달 방지). 근거 없음/첨부-전용만
  #   있으면 게이트가 즉시 통과(no-op) → no-evidence 골든/동작 불변. 읽기 전용(state 미기록, 셸만 멈춤).
  "$PY" "$HARNESS_ROOT/scripts/lib/check_evidence_reflection.py" "$(run_dir "$RID")" \
    || die "근거 문서가 첨부만 되고 반영되지 않았습니다 — 해당 doc-NN 을 인용하는 반영 블록을 추가하거나, evidence/index.json 에 reflect:false(첨부-전용)를 명시하고 재-인입하세요."
  # done 전이(공용 transition — storyboard_substage 커서 제거[stale 방지] + history 1건, 단일 원자 쓰기)
  transition phase='"done"' step='"done"' gate=null status='"approved"' awaiting='"none"' \
             storyboard_substage=__UNSET__ '@history=done|workflow:complete|advance-phase.sh'
else
  NEWMAX="$(route_max_iter "$TARGET")"   # WS-ROUTES: 페이즈별 max_iterations 도 라우트 테이블에서만 (03=4·디자인=2·그외=3)
  # M4(C2): 03-storyboard 진입 시 서브스테이지 커서를 outline 으로 초기화. 그 외 페이즈로 가면 제거(stale 방지).
  if [ "$TARGET" = "03-storyboard" ]; then _SUB='storyboard_substage="outline"'; else _SUB='storyboard_substage=__UNSET__'; fi
  transition phase="\"$TARGET\"" step='"generate"' gate=null status='"pending"' awaiting='"none"' \
             iteration=1 selected_option=null max_iterations="$NEWMAX" "$_SUB" \
             "@history=$TARGET|phase:enter|advance-phase.sh"
fi

render
obs_timing "$RID" phase="$TARGET" stage="${CUR}→${TARGET}" step=transition gen_source=advance outcome=ok \
  rc=0 duration_s="$(( $(date +%s) - _ADV_T0 ))"
# AG-UI 투영: 페이즈 전이(StepStarted phase:enter + StepFinished review:passed) + StateDelta,
#   done 이면 RunFinished{success}. --render-only 는 위 15행에서 이미 종료돼 여기 미도달(진짜 전이만 방출).
agui_emit "$RID"
[ "$LOCK_OWN" = "1" ] && release_lock
ok "페이즈 전이: $CUR → $TARGET"
