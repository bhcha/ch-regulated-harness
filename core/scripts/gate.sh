#!/usr/bin/env bash
# gate.sh — verdict/decision 을 읽어 state 를 결정론적으로 전이 (설계 §5.3).
#   state.json 의 게이트 전이는 오직 여기(+run-stage generate→review, advance-phase)에서만.
# 사용법(보통 다른 스크립트가 호출):
#   bash scripts/gate.sh <run_id> review     # kcia-check 가 verdict 쓴 뒤
#   bash scripts/gate.sh <run_id> select     # select.sh 가 decision 쓴 뒤
#   bash scripts/gate.sh <run_id> approve    # approve.sh
#   bash scripts/gate.sh <run_id> revise     # revise.sh (feedback 기록 후)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; EVENT="${2:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 전이 전 fail-closed. 방어심층(직접 호출 대비; 내부 호출은 상류 가드가 이미 차단, 부재 시 no-op)
SF="$(state_file "$RID")"
# 호출자가 락을 이미 잡았으면 재획득하지 않음 (중첩 방지) — 소유 시 LOCK_OWN=1
lock_acquire_own "$RID"

# WS-TRACE: 상속된 HARNESS_VERDICT_ID 를 제거(누출 방지). review 분기에서만 verdict.id 로 재설정한다.
unset HARNESS_VERDICT_ID 2>/dev/null || true

PHASE="$(jget "$SF" phase)"
ITER="$(jget "$SF" iteration)"; MAXIT="$(jget "$SF" max_iterations)"
MULTI="$(phase_is_multi "$RID")"

# transition() 은 common.sh 로 승격됨(K-2 #1) — state.json 병합-전이 공용 프리미티브.
#   gate.sh 의 transition 호출부(아래 case)는 field kv 만 넘겨 종전과 동일하게 동작한다.

case "$EVENT" in
  review)
    # M4(코덱스 CRITICAL): review 게이트 가드 — gate=review 가 아니면 거부.
    #   직접 gate.sh review 호출로 사람 승인·self-grading 가드를 우회해 advance/export 하는 것을 차단(부록A-9).
    [ "$(jget "$SF" gate)" = "review" ] \
      || die "심의(review) 게이트가 아닙니다 (gate=$(jget "$SF" gate)). 생성→승인/선택 후 심의하세요(승인 우회 차단)."
    VP="$(verdict_path "$RID")"
    [ -f "$VP" ] || die "verdict 파일이 없습니다: ${VP#"$HARNESS_ROOT"/}. 먼저 kcia-check 를 실행하세요."
    validate_artifact "$VP" >/dev/null
    VERDICT="$(jget "$VP" verdict)"; ESCALATE="$(jget "$VP" escalate)"
    # WS-TRACE: 이 review 전이를 일으킨 verdict 의 id 를 history.verdict_id 로 역참조(없으면 생략, back-compat).
    #   review 분기는 배타적이고 이후엔 advance-phase --render-only(히스토리 미기록)만 호출하므로 export 누수 없음.
    VID="$(jget "$VP" id 2>/dev/null || true)"; { [ -n "$VID" ] && [ "$VID" != "null" ]; } && export HARNESS_VERDICT_ID="$VID"
    if [ "$VERDICT" = "pass" ] && [ "$ESCALATE" != "true" ]; then
      # M4: 심의 통과 = **유일한 advance/finalize 분기**(부록A-9 — advance 는 review-pass 에서만).
      if [ "$PHASE" = "04-keyvisual" ]; then
        # C3: 심의 통과 finalize — export 직전 선택안 검증(저작권/구성요소) 재확인(직접 gate.sh approve 가 approve.sh 렌더·검증을
        #   우회했을 경우 방어) → 통과면 export_package(협회) 1회 → done.
        # H1(코덱스 2R): 렌더된 design-manifest 의 선택안이 decision 과 일치하는지 확인 — 직접 gate.sh approve 가 approve.sh 의
        #   '선택안 재렌더'를 우회해 다른 안(A) manifest 로 검증 통과시키고 선택안(B) shots 를 export 하는 불일치를 차단.
        _KV_DSEL="$(jget "$(run_dir "$RID")/04-keyvisual/decision.json" selected 2>/dev/null || true)"
        _KV_MSEL="$(jget "$(run_dir "$RID")/04-keyvisual/design-manifest.json" selected_option 2>/dev/null || true)"
        { [ -z "$_KV_DSEL" ] || [ "$_KV_DSEL" = "$_KV_MSEL" ]; } \
          || die "디자인 manifest 선택안($_KV_MSEL) ≠ 결정($_KV_DSEL) — approve.sh 로 선택안을 재렌더하세요(렌더·심의 우회 차단)."
        bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 04-keyvisual >/dev/null 2>&1 \
          || die "키비주얼 선택안 검증 실패 — export 보류(저작권/구성요소). approve.sh 로 선택안을 렌더·검증하세요."
        # 반영 강제는 (1)03-storyboard validate 에서 plan-반영을 correctable 하게 잡고(1급) (2)바로 위 validate-stage
        #   04-keyvisual 이 선택 HTML 반영-생존을 export 前에 강제하며(reflect:true 미반영이면 export 차단 → 재렌더 가능
        #   시점에서 교정) (3)advance-phase done 게이트가 최종 백스톱한다 — 여기(04 finalize)엔 별도 게이트를 두지
        #   않는다(위 validate 가 이미 반영을 강제했고 export 는 HTML-aware reflected_in 을 정확 기록).
        "$PY" "$HARNESS_ROOT/scripts/lib/export_package.py" "$(run_dir "$RID")" \
          || die "협회 패키지 export 실패(심의 통과 finalize) — 디자인 렌더/선택 확인."
        append_history "$SF" "$PHASE" "review:passed→export-finalize" "gate.sh"
        bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID"   # → done (심의 통과 finalize)
      elif [ "$PHASE" = "03-storyboard" ] && [ "$(storyboard_substage "$RID")" = "outline" ]; then
        # 코덱스 3R Medium: 스토리라인(outline) 완전성 재검증(선택안 storyline 누락/손상 → plan 진행 차단).
        bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 03-storyboard >/dev/null 2>&1 \
          || die "스토리라인(outline) 검증 실패 — plan 진행 보류(storyline 누락/손상). run-stage storyboard-outline 으로 보충하세요."
        # 스토리라인 심의 통과 → 커서 outline→plan + 같은 페이즈 generate(state 전이와 한 atomic write).
        transition step='"generate"' gate=null status='"passed"' awaiting='"none"' storyboard_substage='"plan"'
        append_history "$SF" "$PHASE" "review:passed→plan-generate" "gate.sh"
        info "스토리라인 규정 점검 통과 → 다음: bash scripts/run-stage.sh storyboard-plan $RID"
      elif [ "$PHASE" = "00e-evidence" ]; then
        # 00e 반영 제안 finalize: 사람 승인(면제 autopass) 직후 제안(reflection-proposal.json)을 매니페스트에 반영해
        #   spec_status:pending 을 해소한다 → 그 다음에야 advance(pending 초크 게이트가 열림). 직접 gate.sh approve 로도
        #   이 훅을 우회 못한다(04 export-finalize 와 동형). 실패 시 die → gate=review 유지 → 재-kcia-check 로 재시도(멱등).
        #   ⚠ W-3(00e 스펙 2차 관문): 일반 참조 문서(각주 채널)뿐 아니라 사람이 kind:test_report 로 intent 선언한 pending
        #     시험성적서도 해소한다. test_report 해소는 ingest 가 doc-NN/doc-NN-tKK 를 claim-basis 로 승격하므로,
        #     여기서 state.product.evidence_on_file/functional_status 를 claim-basis 에서 재동기화한다(state 는 셸만 쓴다).
        # A-DEF-1: apply 훅은 ingest.py 를 직접 호출하므로 도메인을 셸이 전달한다(ingest-bundle.sh:38 과 동형).
        #   사람이 state 에 선언한 도메인(진실)을 주입만 — 새 결정·폴백 없음. ⚠ apply-proposal 은 추출 프로파일을
        #   안 건드려(lazy 화 이후 import 만으로 안 죽음) 도메인 없이도 완주하므로, 셸 경계에서 명시 fail-closed 로
        #   미선언 진행을 막는다(ingest-bundle.sh:41 과 동형 · 정상 new-run 은 도메인 필수라 도달 불가 · cosmetic 조용 폴백 부활 금지).
        HARNESS_DOMAIN="$(resolve_domain "$SF")"; export HARNESS_DOMAIN
        [ -n "$HARNESS_DOMAIN" ] || die "규제 도메인이 선언되지 않았습니다(state.product.regulatory_domain 없음) — new-run.sh 로 도메인을 선언하세요(fail-closed)."
        "$PY" "$HARNESS_ROOT/scripts/lib/ingest.py" apply-proposal "$RID" \
          || die "반영 제안 반영(pending 해소) 실패 — 제안(reflection-proposal.json)을 확인하고 다시 규정 점검(kcia-check)하세요."
        # claim-basis → state 재동기화(ingest-bundle.sh 와 동형 PYEOF). general-only 면 claim-basis 무변경 → 같은 값 재기록(무해).
        _CB_SYNC="$(run_dir "$RID")/00-ingest/claim-basis.json"
        if [ -f "$_CB_SYNC" ]; then
          "$PY" - "$SF" "$_CB_SYNC" <<'PYEOF' || die "00e 반영 후 state 재동기화 실패(claim-basis)."
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
sf, cb_path = sys.argv[1], sys.argv[2]
st = load_json(sf); cb = load_json(cb_path)
st["product"]["functional_status"] = {k: v["status"] for k, v in cb["functional_status"].items()}
st["product"]["evidence_on_file"] = [e["id"] for e in cb["evidence_on_file"]]
st["updated_at"] = now_iso()
atomic_write_json(sf, st)
PYEOF
        fi
        append_history "$SF" "$PHASE" "review:passed→advance" "gate.sh"
        bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID"
      elif [ "$PHASE" = "00a-intake" ]; then
        # 00a 발효(apply-intake): 사람 승인(면제 autopass) 직후 승인된 분류대로 '기존 채널'로 결정적 라우팅(routed/) →
        #   이어서 기존 ingest-bundle 을 routed/ 채널로 호출해 00-ingest 내부·조건부 라우팅(00e/00g/01-brief)이 그대로 흐른다.
        #   test_report intent 는 evidence-docs 완전성 게이트에서 자연히 spec_status:pending → 00e 2차 관문(W-3)으로 연쇄.
        #   ⚠ ingest-bundle 은 보유 락으로 재진입한다 — HARNESS_LOCK_HELD=1 을 넘겨 재획득 데드락을 막는다(ingest-bundle
        #     의 재진입 가드). 실패 시 die → gate=review 유지 → 재-kcia-check 재진입(멱등: apply-intake wipe+rebuild,
        #     ingest-bundle exact-replacement)이 회복한다. state.json 은 셸(ingest-bundle)만 쓴다.
        append_history "$SF" "$PHASE" "review:passed→apply-intake+ingest" "gate.sh"
        RDIR_AI="$(run_dir "$RID")"
        # ⚠ Codex W4-R2 회복성: 훅(apply-intake + ingest-bundle)이 실패하면 state 를 '훅 이전(phase=00a-intake)'으로
        #   복원해 재-kcia-check 가 훅을 재진입(멱등: apply-intake wipe+rebuild · ingest-bundle exact-replacement)하게 한다.
        #   복원 없이 ingest-bundle 이 phase=00-ingest+`.ingest-incomplete` 를 남기면, 복구 명령이 assert_ingest_complete 에서
        #   죽어 재진입 불가(wedge)다. 부분 00-ingest 산출·센티넬은 다음 ingest-bundle 재실행이 재구축·클리어한다.
        _SF_BAK="$(mktemp)"; cp "$SF" "$_SF_BAK"
        _ai_restore() { cp "$_SF_BAK" "$SF"; rm -f "$_SF_BAK" "$RDIR_AI/00-ingest/.ingest-incomplete" 2>/dev/null || true; }
        # A-DEF-1: apply-intake(ingest.py 직접 호출)와 이어지는 ingest-bundle 에 도메인 전달(ingest-bundle.sh:38 과 동형).
        #   state 선언 도메인 주입만. 미선언이면 셸 경계에서 명시 fail-closed(ingest-bundle.sh:41 과 동형 · apply-intake 는
        #   ingest.py:2044 에서도 걸리지만 invariant 를 셸에서 먼저 못박음 · cosmetic 조용 폴백 부활 금지).
        HARNESS_DOMAIN="$(resolve_domain "$SF")"; export HARNESS_DOMAIN
        [ -n "$HARNESS_DOMAIN" ] || { _ai_restore; die "규제 도메인이 선언되지 않았습니다(state.product.regulatory_domain 없음) — new-run.sh 로 도메인을 선언하세요(fail-closed)."; }
        "$PY" "$HARNESS_ROOT/scripts/lib/ingest.py" apply-intake "$RID" \
          || { _ai_restore; die "첨부 분류 발효(라우팅) 실패 — 분류 제안(intake-proposal.json)을 확인하고 다시 규정 점검(kcia-check)하세요."; }
        ROUTED="$RDIR_AI/00a-intake/routed"
        HARNESS_LOCK_HELD=1 \
        HARNESS_WB="$ROUTED/working-backwards.md" \
        HARNESS_ASSETS_DIR="$ROUTED/assets" \
        HARNESS_EXAMPLES_DIR="$ROUTED/examples" \
        HARNESS_EVIDENCE_DIR="$ROUTED/evidence" \
          bash "$HARNESS_ROOT/scripts/ingest-bundle.sh" "$ROUTED/bundle" "$RID" \
          || { _ai_restore; die "첨부 라우팅 후 인입(ingest-bundle) 실패 — routed/ 스테이징을 확인하고 다시 규정 점검(kcia-check)하면 재시도합니다."; }
        rm -f "$_SF_BAK"
        # ingest-bundle 이 phase 를 00-ingest→조건부(00e/00g/01-brief)로 전이·렌더까지 마쳤다(여기서 advance 안 함).
      else
        # brief·concept·00g·storyboard-plan: 심의 통과 → 다음 페이즈로 advance.
        # 코덱스 3R High: 03-storyboard plan 은 advance 직전 plan 완전성 재검증(부분 plan 손상 → 무내용 pass 차단).
        #   validate-stage(03 plan scope)는 선택 스토리라인의 모든 블록이 plan/NN-type.json 으로 존재하는지 확인한다.
        if [ "$PHASE" = "03-storyboard" ]; then
          bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 03-storyboard >/dev/null 2>&1 \
            || die "기획안(plan) 완전성 검증 실패 — 심의 통과 보류(블록 누락/손상). run-stage storyboard-plan 으로 보충하세요."
        fi
        append_history "$SF" "$PHASE" "review:passed→advance" "gate.sh"
        bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID"
      fi
    else
      # revise
      if [ "$ITER" -ge "$MAXIT" ] || [ "$ESCALATE" = "true" ]; then
        transition step='"review"' gate='"review"' status='"escalated"' awaiting='"user"'
        append_history "$SF" "$PHASE" "review:revise→escalated:$ITER/$MAXIT" "gate.sh"
        err "여러 번 고쳤지만 규정 점검을 통과하지 못했어요 → 사람 개입 필요."
      else
        NEWIT=$((ITER + 1))
        transition step='"generate"' gate=null status='"revise"' awaiting='"none"' iteration="$NEWIT"
        append_history "$SF" "$PHASE" "review:revise→generate:iter$NEWIT" "gate.sh"
        info "고칠 점 반영 → 다시 만들어요 (${NEWIT}번째 · 최대 ${MAXIT}번)."
      fi
    fi
    ;;

  select)
    # 가드: 선택 게이트에서만(Codex B4 #8). 03-storyboard 에서 gate=select 는 outline substage 만(M3: tone 제거).
    CUR_GATE="$(jget "$SF" gate)"; CUR_STATUS="$(jget "$SF" status)"
    if [ "$CUR_GATE" != "select" ] || { [ "$CUR_STATUS" != "pending" ] && [ "$CUR_STATUS" != "selected" ]; }; then
      die "select 게이트가 아닙니다 (gate=$CUR_GATE, status=$CUR_STATUS)."
    fi
    # M4: select 는 substage 를 전진시키지 않는다(전진은 review-pass 만). 현재 substage 의 decision 을 읽는다.
    DEC="$(run_dir "$RID")/$(sel_decision_rel "$RID")"
    [ -f "$DEC" ] || die "decision.json 이 없습니다. 먼저 select.sh 로 선택하세요."
    validate_artifact "$DEC" >/dev/null
    SELECTED="$(jget "$DEC" selected)"
    transition selected_option="\"$SELECTED\"" status='"selected"'
    append_history "$SF" "$PHASE" "select:$SELECTED" "gate.sh"
    if [ "$(phase_needs_approve_after_select "$RID")" = "1" ]; then
      # 04-keyvisual: 2중승인 — 선택 후 사람 최종 승인(approve) 대기. 승인 직후 render+validate, 심의는 그 뒤.
      transition step='"human"' gate='"user"' status='"pending"' awaiting='"user"'
      info "선택 완료($SELECTED) → 한 번 더 승인할 차례: bash scripts/approve.sh $RID"
    else
      # M4: 00g·concept·storyboard-outline — 선택 = 사람 결정 → **심의로**(advance 안 함).
      transition step='"review"' gate='"review"' status='"pending"' awaiting='"review"'
      info "선택 완료($SELECTED) → 다음은 규정 점검: bash scripts/kcia-check.sh $RID"
    fi
    ;;

  approve)
    # M4(코덱스 CRITICAL): approve 게이트 가드 + 사람-승인 안전검사 — 직접 gate.sh approve 로 RA 확인을 우회 못하게.
    CUR_GATE_A="$(jget "$SF" gate)"; CUR_STATUS_A="$(jget "$SF" status)"
    if [ "$CUR_GATE_A" != "user" ] || { [ "$CUR_STATUS_A" != "pending" ] && [ "$CUR_STATUS_A" != "escalated" ]; }; then
      die "승인(user) 게이트가 아닙니다 (gate=$CUR_GATE_A, status=$CUR_STATUS_A)."
    fi
    # brief 기능성 '승인' 표시 → RA 사후검수 확인(sensitive-confirmation.ra_reviewed)이 있어야 승인(fail-closed, 직접호출 포함).
    if [ "$PHASE" = "01-brief" ]; then
      _APPR_SENS="$("$PY" -c "import json
try:
  d=json.load(open('$(run_dir "$RID")/01-brief/brief.json'))
  print(sum(1 for s in d.get('sensitive_labels',[]) if s['status']=='approved'))
except Exception: print(0)")"
      if [ "${_APPR_SENS:-0}" -gt 0 ]; then
        _CONF="$(run_dir "$RID")/01-brief/sensitive-confirmation.json"
        _CONF_RA="$([ -f "$_CONF" ] && "$PY" -c "import json;print(json.load(open('$_CONF')).get('ra_reviewed') is True)" 2>/dev/null || echo False)"
        [ "$_CONF_RA" = "True" ] || die "브리프 기능성 '승인' 표시 → RA 사후검수 확인 필요(fail-closed): bash scripts/approve.sh $RID --ra-ok"
      fi
    fi
    # M4: 승인 = 사람 결정 → **심의로**(advance 안 함; advance 는 review-pass 만). 한 atomic 전이.
    transition step='"review"' gate='"review"' status='"pending"' awaiting='"review"'
    append_history "$SF" "$PHASE" "human:approved→review" "approve.sh"
    info "승인 완료 → 다음은 규정 점검: bash scripts/kcia-check.sh $RID"
    ;;

  revise)
    if [ "$ITER" -ge "$MAXIT" ]; then
      transition step='"review"' gate='"review"' status='"escalated"' awaiting='"user"'
      append_history "$SF" "$PHASE" "human:revise→escalated:$ITER/$MAXIT" "gate.sh"
      err "여러 번 고쳤지만 멈췄어요 → 사람 개입 필요."
    else
      NEWIT=$((ITER + 1))
      transition step='"generate"' gate=null status='"changes_requested"' awaiting='"none"' iteration="$NEWIT"
      append_history "$SF" "$PHASE" "human:changes_requested→generate:iter$NEWIT" "gate.sh"
      info "고칠 점 기록 → 다시 만들어요 (${NEWIT}번째 · 최대 ${MAXIT}번)."
    fi
    ;;

  *) die "알 수 없는 게이트 이벤트: $EVENT (review|select|approve|revise)" ;;
esac

# AG-UI 투영: 위 case 의 전이(StateDelta) + 생명주기(review 통과 StepFinished·해소 StepStarted·kcia.verdict Custom) +
#   사람 게이트 도달 시 RunFinished{interrupt:select|approve}. 재구성 sync 라 어느 분기든 한 지점에서 포착(멱등).
#   ⚠ 안쪽에서 부른 advance-phase(review-pass 전이)가 이미 sync 했으면 커서가 앞서 있어 여기선 중복 append 없음.
agui_emit "$RID"
bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
lock_release_own
exit 0
