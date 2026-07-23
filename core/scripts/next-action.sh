#!/usr/bin/env bash
# next-action.sh — state.json → 구조화 JSON (Slack 어댑터가 버튼/carousel 을 '상태에서' 렌더할 단일 SSoT).
#   읽기 전용: state.json 을 절대 쓰지 않는다. render_runmd 의 next_command/옵션/추천 로직을 '그대로 재사용'해
#   터미널 run.md 와 불일치가 생기지 않게 한다(어댑터 버튼과 CLI '다음 명령'이 항상 동일 소스).
# 사용법: bash scripts/next-action.sh <run_id>   →  한 줄 JSON {phase,gate,status,action,stage,options[],recommended,...}
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 fail-closed
RDIR="$(run_dir "$RID")"

"$PY" - "$RID" "$RDIR" <<'PYEOF'
import sys, os, json
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
import render_runmd as R          # next_command/_option_keys/_recommendation/PHASE_LABEL 단일 재사용
from harness import load_json
rid, rdir = sys.argv[1], sys.argv[2]
st = load_json(os.path.join(rdir, "state.json"))
phase, step, status, gate = st["phase"], st["step"], st["status"], st["gate"]

# 인간용(터미널 run.md 와 동일) — 참고로 함께 싣는다(어댑터는 'action' 으로 분기)
cmd, gate_label, files, hint = R.next_command(rid, st, rdir)
recommended = R._recommendation(rdir, st)
options = R._option_keys(rdir, phase)
gate_type = R.gate_type(st, rdir)          # WS-GATES: 게이트 종류(auto|human-verify|setup|hard-stop|None)
stop_reason = R._stop_reason(rdir, st)     # WS-GATES: 구조화 멈춤 사유(있으면)
try:
    advisory = R.completeness_advisor.advise(rdir, st)   # 읽기전용 권고(보완 제안+품질) — run.md 와 동일 소스
except Exception:
    advisory = None

# 페이즈→스테이지 맵 SSoT(H-3, K-2 #7): harness/stage-phase-map.json (03-storyboard 는 아래에서 substage 특수처리).
stage_for_phase = json.load(open(os.path.join(os.environ["HARNESS_ROOT"], "harness", "stage-phase-map.json")))["phase_to_stage"]

# ── 기계용 action 결정 (next_command 의 분기 순서와 '동일 규칙') ──
action = None; stage = None; needs = None; ra_ok_required = False
if status == "escalated":
    action = "raise-limit"                                  # 한도 상향 후 재생성(에스컬레이션 복구)
elif phase == "done":
    action = "done"
elif phase == "00-ingest":
    action = "ingest"; needs = "bundle_dir"                 # <번들폴더> placeholder 대신 구조화 신호
elif gate == "user" and status == "approved":
    action = "resume-approve"                               # 중단 복구
elif gate == "select" and status == "selected":
    action = "resume-select"                                # 중단 복구
elif step == "generate":
    action = "generate"
    if phase == "03-storyboard":
        stage = "storyboard-%s" % R.storyboard_substage(rdir)
    else:
        stage = stage_for_phase.get(phase, phase)
elif gate == "review" and status == "pending":
    action = "review"                                       # kcia-check
elif gate == "select" and status == "pending":
    action = "select"                                       # 다안 선택(carousel) — options/recommended 동봉
elif gate == "user" and status == "pending":
    action = "approve"                                      # 승인/보완(revise)
    if phase == "01-brief":
        bp = os.path.join(rdir, "01-brief/brief.json")
        if os.path.exists(bp):
            try:
                ra_ok_required = any(s.get("status") == "approved"
                                     for s in load_json(bp).get("sensitive_labels", []))
            except Exception:
                ra_ok_required = False
else:
    action = "generate"; stage = stage_for_phase.get(phase, phase)

# M5(G2): 전부거절→재제안(revise) 가용 여부 — revise.sh 의 게이트 가드와 동일 규칙(select-pending / user-pending|escalated).
#   Slack carousel 의 [다시 제안]/[직접 입력해 다시 제안] 버튼 노출 신호(action 은 불변 — 어댑터가 별도 버튼으로 분기).
revise_available = (gate == "select" and status == "pending") or (gate == "user" and status in ("pending", "escalated"))

out = {
    "rid": rid,
    "phase": phase,
    "phase_label": R.phase_label(phase),   # 안전 라벨(미등록 phase 도 raw 누수 없음 — Codex 리뷰)
    "step": step,
    "gate": gate,
    "status": status,
    "awaiting": st.get("awaiting"),
    "iteration": st.get("iteration"),
    "max_iterations": st.get("max_iterations"),
    "action": action,                # ingest | generate | review | select | approve | raise-limit | resume-* | done
    "stage": stage,                  # generate 일 때 run-stage 인자(guideline/brief/...)
    "needs": needs,                  # ingest 일 때 'bundle_dir'
    "options": options,              # select 일 때 옵션 키(carousel 카드)
    "recommended": recommended,      # 추천 top-1(실재 옵션 교차검증)
    "ra_ok_required": ra_ok_required,  # 01-brief 승인 시 RA 사후검수 필요 여부
    "revise_available": revise_available,  # M5(G2): 전부거절·재제안(revise) 가용 — carousel [다시 제안] 버튼 신호
    "gate_type": gate_type,          # WS-GATES(TWEAK-2): auto|human-verify|setup|hard-stop|None (파생)
    "stop_reason": stop_reason,      # WS-GATES(TWEAK-3): {code,summary,required_fields} 또는 None
    "advisory": advisory,            # 읽기전용 권고 {must_fill, nice_to_have, completeness} 또는 None (run.md 와 동일 소스)
    "cmd": cmd,                      # 인간용 참고(터미널 run.md 와 동일)
    "gate_label": gate_label,
    "hint": hint,
    "files": files,                  # 검토 파일 경로(옵션별 산출물 등)
}
print(json.dumps(out, ensure_ascii=False))
PYEOF
