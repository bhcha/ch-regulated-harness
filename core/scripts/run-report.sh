#!/usr/bin/env bash
# run-report.sh — 실행 리포트(읽기전용): 단계별 [선택·심의·반복·소요]를 기존 산출물에서 결정적으로 조립.
#   수기 GENERATION-LOG 의존 제거(F-3 Seam D). ⚠ state.json 불가침(읽기만; AGENTS 1번 절) — 이 스크립트는
#   산출물/verdict/timing 만 읽어 markdown 을 stdout 으로 낸다. 회고·RA 인수인계·사후 분석의 고정 비용 제거.
#   사용법: bash scripts/run-report.sh <run_id>
set -euo pipefail
RID="${1:?사용법: run-report.sh <run_id>}"
# 경로 traversal 방지(외부리뷰 High) — run_id 는 안전 문자만 + '..' 금지(runs/ 밖 파일 노출 차단).
[[ "$RID" =~ ^[A-Za-z0-9._-]+$ && "$RID" != *".."* ]] || { echo "잘못된 run_id: $RID (영숫자·.·-·_ 만, .. 금지)" >&2; exit 1; }
HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export HARNESS_ROOT
RDIR="$HARNESS_ROOT/runs/$RID"
[ -d "$RDIR" ] || { echo "런 없음: $RDIR" >&2; exit 1; }

python3 - "$RDIR" "$RID" <<'PY'
import sys, os, json, glob

rdir, rid = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
try:
    import operator_labels as O
    def phase_label(p): return O.phase_label(p) or p
except Exception:
    def phase_label(p): return p


def _load(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# 단계 순서(존재하는 것만). 03-storyboard 는 outline/plan 하위 verdict 를 함께 본다.
STAGES = ["00a-intake", "00-ingest", "00e-evidence", "00g-guideline",
          "01-brief", "02-concept", "03-storyboard", "04-keyvisual"]

# ── 소요/반복: timing.jsonl 을 (stage) 별로 집계 ────────────────────────────
timing = {}   # stage -> {"dur": float, "revise": int, "review": int}
tj = os.path.join(rdir, ".logs", "timing.jsonl")
if os.path.exists(tj):
    with open(tj, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if not isinstance(r, dict):   # 유효 JSON 이라도 dict 아니면 스킵(외부리뷰 High: []·"x"·null 크래시 방지)
                continue
            st = r.get("stage") or ""
            if not st:
                continue
            t = timing.setdefault(st, {"dur": 0.0, "revise": 0, "review": 0})
            d = r.get("duration_s")
            if isinstance(d, (int, float)):
                t["dur"] += float(d)
            step = (r.get("step") or "")
            if r.get("outcome") == "start":
                continue
            if "review" in step:
                t["review"] += 1
            if r.get("outcome") in ("revise", "escalated") or "revise" in step:
                t["revise"] += 1

out = ["# 실행 리포트 — %s\n" % rid,
       "> 읽기전용 자동 조립(F-3). 단계별 선택·규정 점검·반복·소요. state 불가침.\n"]

for st in STAGES:
    sdir = os.path.join(rdir, st)
    if not os.path.isdir(sdir):
        continue
    out.append("\n## %s (%s)\n" % (phase_label(st), st))
    # 선택(decision)
    dec = _load(os.path.join(sdir, "decision.json"))
    if dec is None:  # 03-storyboard 는 outline/decision.json 일 수 있음
        dec = _load(os.path.join(sdir, "outline", "decision.json"))
    if isinstance(dec, dict) and dec.get("selected") is not None:
        c = (dec.get("comment") or "").strip()
        out.append("- 선택: **%s**%s\n" % (dec["selected"], (" — %s" % c) if c else ""))
    # 심의(verdict) — 스테이지 루트 + 하위(outline/plan) verdict 파일 수집
    vlist = sorted(glob.glob(os.path.join(sdir, "*-verdict.json"))
                   + glob.glob(os.path.join(sdir, "*", "*-verdict.json")))
    for vp in vlist:
        v = _load(vp)
        if not isinstance(v, dict):
            continue
        vd = v.get("verdict", "?")
        depth = v.get("review_depth") or ""
        nviol = len(v.get("violations") or [])
        who = os.path.basename(os.path.dirname(vp)) if os.path.dirname(vp) != sdir else ""
        tag = ("%s " % who) if who and who != st else ""
        out.append("- %s규정 점검: **%s**%s%s\n" % (
            tag, vd,
            (" · 지적 %d건" % nviol) if nviol else "",
            (" · %s" % depth) if depth else ""))
    # 반복·소요(timing)
    t = timing.get(st)
    if t:
        bits = []
        if t["review"]:
            bits.append("규정 점검 %d회" % t["review"])
        if t["revise"]:
            bits.append("보완 %d회" % t["revise"])
        if t["dur"]:
            bits.append("소요 %d초" % round(t["dur"]))
        if bits:
            out.append("- (%s)\n" % " · ".join(bits))

sys.stdout.write("".join(out))
PY
