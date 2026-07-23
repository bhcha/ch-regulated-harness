#!/usr/bin/env python3
"""analyze_learnings.py — 학습 루프 분석(읽기전용, Seam F).

runs/ 를 런·라운드 횡단으로 훑어 (target_text, rule/axis)로 일관 반려된 표현을 집계하고, 노이즈·보편어
필터 후 일관성 임계(독립 K런 이상)를 넘은 것만 learned-proposal.json 후보로 낸다. ⚠ **state 불가침**(읽기만) —
승격은 사람 승인(apply-learnings.sh)이 팩에 기록한다. 자동 승격 금지(크리틱 비결정성이 영구 규칙으로 굳는 것 차단).

자동 제외 필터:
  (a) 1회 반려·핑퐁 — 크리틱이 스스로 제안한 suggested_rewrite 가 나중에 반려된 표현(자기모순)은 후보에서 제외.
  (b) 보편어 가드(사용자 지시) — 팩 common-terms.json 의 단일 보편 명사(모공·피부…)는 단독 금지어 승격 금지.
      후보 = 다토큰 특정 표현 또는 common-terms 밖 희소 표현만(보편 단어 전면 차단으로 정당 카피까지 죽이는 것 방지).

사용법: analyze_learnings.py <domain> [--k N] [--runs id1,id2,...] [--out path]
  --runs 미지정 시 runs/ 에서 선언 도메인이 <domain> 인 런 전체를 대상으로 한다.
"""
import sys, os, json, argparse, glob, re

HARNESS_ROOT = os.environ.get("HARNESS_ROOT") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PACKS_DIR = os.environ.get("PACKS_DIR") or os.path.join(os.path.dirname(HARNESS_ROOT), "packs")

_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_id(s):
    """도메인·run_id 식별자 안전 검사(path traversal 차단, Codex High) — 영숫자·.·-·_ 만 + '..' 금지."""
    return isinstance(s, str) and bool(_SAFE_ID.match(s)) and ".." not in s

# verdict 파일명 → 단계(applies_to 도출).
_STAGE_OF = {"brief-verdict.json": "01-brief", "concept-verdict.json": "02-concept",
             "storyboard-verdict.json": "03-storyboard", "outline-verdict.json": "03-storyboard",
             "plan-verdict.json": "03-storyboard", "keyvisual-verdict.json": "04-keyvisual"}


def _load(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _stage_of(path):
    base = os.path.basename(path)
    if base in _STAGE_OF:
        return _STAGE_OF[base]
    # 상위 디렉터리명이 단계면 그걸로(00e-evidence 등 비대상은 무시).
    parent = os.path.basename(os.path.dirname(path))
    return parent if parent[:2].isdigit() else None


def _run_domain(rid):
    st = _load(os.path.join(HARNESS_ROOT, "runs", rid, "state.json"))
    if not isinstance(st, dict):
        return None
    return ((st.get("product") or {}).get("regulatory_domain"))


def _common_terms(domain):
    d = _load(os.path.join(PACKS_DIR, domain, "common-terms.json"))
    if not isinstance(d, dict):
        return set()
    return set(t for t in (d.get("common_terms") or []) if isinstance(t, str))


def analyze(domain, run_ids, k=2):
    _empty = {"domain": domain, "k": k, "analyzed_runs": 0, "candidates": [],
              "dropped": {"below_k": 0, "common_term": 0, "pingpong": 0}}
    if not _safe_id(domain):          # domain traversal 차단(Codex High)
        _empty["error"] = "invalid domain id"
        return _empty
    runs_root = os.path.join(HARNESS_ROOT, "runs")
    if not run_ids:
        run_ids = [r for r in sorted(os.listdir(runs_root)) if os.path.isdir(os.path.join(runs_root, r))
                   and _run_domain(r) == domain] if os.path.isdir(runs_root) else []
    run_ids = [r for r in run_ids if _safe_id(r)]     # run_id traversal 차단(Codex High)
    common = _common_terms(domain)

    # (target_text, axis) → {rule, stages, run_ids}
    agg = {}
    rewrites = set()   # 크리틱이 제안한 suggested_rewrite 전체(핑퐁 필터용)
    for rid in run_ids:
        rdir = os.path.join(runs_root, rid)
        if _run_domain(rid) != domain:
            continue
        for vp in glob.glob(os.path.join(rdir, "*", "*-verdict.json")) + glob.glob(os.path.join(rdir, "*", "*", "*-verdict.json")):
            v = _load(vp)
            if not isinstance(v, dict):
                continue
            stage = _stage_of(vp)
            violations = v.get("violations")
            if not isinstance(violations, list):   # violations 비-list(예 123) → TypeError 방어(Codex High)
                continue
            for viol in violations:
                if not isinstance(viol, dict):
                    continue
                tt = (viol.get("target_text") or "").strip()
                axis = viol.get("axis") or ""
                if not tt or not axis:
                    continue
                sr = (viol.get("suggested_rewrite") or "").strip()
                if sr:
                    rewrites.add(sr)
                key = (tt, axis)
                a = agg.setdefault(key, {"rule": viol.get("rule") or "", "stages": set(), "run_ids": set()})
                a["run_ids"].add(rid)
                if stage:
                    a["stages"].add(stage)

    candidates = []
    dropped = {"below_k": 0, "common_term": 0, "pingpong": 0}
    for (tt, axis), a in sorted(agg.items()):
        n = len(a["run_ids"])
        if n < k:
            dropped["below_k"] += 1
            continue
        if tt in common:                      # 보편어 가드: 단일 보편 명사 단독 승격 금지
            dropped["common_term"] += 1
            continue
        if tt in rewrites:                     # 핑퐁: 크리틱이 제안했던 rewrite 는 후보 제외(자기모순)
            dropped["pingpong"] += 1
            continue
        candidates.append({
            "term": tt, "kind": "deny", "axis": axis, "rule": a["rule"],
            "applies_to": sorted(a["stages"]) or ["all"],
            "event": "consistent_rejection",
            "source_run_ids": sorted(a["run_ids"]), "count": n,
        })
    candidates.sort(key=lambda c: (-c["count"], c["term"]))
    return {"domain": domain, "k": k, "analyzed_runs": len(run_ids),
            "candidates": candidates, "dropped": dropped}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("domain")
    ap.add_argument("--k", type=int, default=2)
    ap.add_argument("--runs", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    run_ids = [r for r in args.runs.split(",") if r] if args.runs else []
    result = analyze(args.domain, run_ids, k=max(1, args.k))
    out = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        # --out 보호경로 가드(Codex High): runs/·packs/ 밖이어야 한다(state·팩·산출물 덮어쓰기 차단).
        outp = os.path.abspath(args.out)
        for _prot in (os.path.abspath(os.path.join(HARNESS_ROOT, "runs")), os.path.abspath(PACKS_DIR)):
            if outp == _prot or outp.startswith(_prot + os.sep):
                sys.stderr.write("거부: --out 은 runs/·packs/ 밖이어야 합니다(보호 경로 쓰기 금지): %s\n" % args.out)
                sys.exit(2)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
        print("learned-proposal 저장: %s (후보 %d건 · 분석 런 %d)" % (args.out, len(result["candidates"]), result["analyzed_runs"]))
    else:
        print(out)


if __name__ == "__main__":
    main()
