#!/usr/bin/env bash
# timing.sh — 단계별 소요시간 요약 (개선계획 2부 개선0). runs/<id>/.logs/timing.jsonl → 평이 표.
#   "어디서 느린지"가 추측이 아니라 데이터로 보인다. 현업 노출은 평이어("컨셉 만들기 42초 · 규정 점검 18초").
# 사용법: bash scripts/timing.sh <run_id>
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
RDIR="$(run_dir "$RID")"
TJ="$RDIR/.logs/timing.jsonl"
if [ ! -f "$TJ" ]; then
  info "아직 측정 로그가 없어요(runs/$RID/.logs/timing.jsonl). 한 단계라도 생성/점검을 돌리면 쌓여요."
  exit 0
fi

"$PY" - "$TJ" <<'PYEOF'
import sys, json, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
import operator_labels as O

# 단계(step) → 평이 라벨. stage(brief/concept/...) 는 phase 로 환산해 operator_labels.phase_label 재사용.
STEP_LABEL = {
    "generate": "만들기", "review": "규정 점검", "transition": "단계 넘기기",
    "review-passA": "규정 점검(꼼꼼히)", "review-passB": "규정 점검(건별 확인)",
    "bake": "이미지 만들기",
}
STAGE_PHASE = {
    "guideline": "00g-guideline", "brief": "01-brief", "concept": "02-concept",
    "storyboard-outline": "03-storyboard", "storyboard-plan": "03-storyboard", "keyvisual": "04-keyvisual",
}
OUTCOME = {"ok": "✅ 됐어요", "fail": "🚫 통과 못 함", "failed": "🚫 통과 못 함",
           "timeout": "⏱ 시간 초과", "degraded": "⚠ 일부만 점검", "skipped": "⏭ 건너뜀"}

def _label(stage, step_raw):
    ph = STAGE_PHASE.get(stage, stage)
    what = O.phase_label(ph) if ph else ""
    step = STEP_LABEL.get(step_raw, step_raw)
    return ((what + " " if what else "") + step).strip() or "(단계)"

# O-3(진행 신호): outcome=start 는 '시작 레코드'(duration 없음). 뒤에 같은 (stage,step) 완료가 오면 페어링해
#   완료 행만 보인다(완료된 단계 출력 = 종전과 동일 = 하위호환). 완료가 아직 없으면 '진행 중'으로 남겨 정체 오인을 막는다.
rows, total = [], 0.0
inflight = {}   # (stage, step) → 라벨. 시작만 있고 완료 미도달.
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        stage = r.get("stage") or ""
        step_raw = r.get("step", "")
        key = (stage, step_raw)
        if r.get("outcome") == "start":
            inflight[key] = _label(stage, step_raw)
            continue
        inflight.pop(key, None)   # 완료 = 더는 진행 중 아님(시작과 페어링)
        dur = r.get("duration_s")
        try:
            dur = float(dur); total += dur
            durtxt = "%d초" % round(dur)
        except (TypeError, ValueError):
            durtxt = "-"
        oc = OUTCOME.get(r.get("outcome", ""), r.get("outcome", ""))
        rows.append((_label(stage, step_raw), durtxt, oc))

# 시작만 있고 완료 미도달 = 진행 중(정체 아님) → 표 끝에 표시.
for lbl in inflight.values():
    rows.append((lbl, "-", "⏳ 진행 중"))

print("# 단계별 소요시간 — %s" % os.path.basename(os.path.dirname(os.path.dirname(sys.argv[1]))))
if not rows:
    print("- 기록 없음")
else:
    w = max(len(r[0]) for r in rows)
    for label, durtxt, oc in rows:
        print("- %-*s  %6s  %s" % (w, label, durtxt, oc))
    print("\n합계: 약 %d초" % round(total))
PYEOF
