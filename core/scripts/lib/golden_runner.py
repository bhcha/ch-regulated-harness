#!/usr/bin/env python3
"""golden_runner.py — 심의 골든셋 회귀 (B3, 설계 §12).

골든셋 각 항목 텍스트를 결정적 룰엔진(kcia_engine)으로 심의해
expected_verdict 와 비교, 검출률·오탐률을 계산한다.
  검출률 = (정답 revise 중 잡은 비율)   ≥ 0.80
  오탐률 = (정답 pass 중 revise 한 비율) ≤ 0.15
라벨 품질 게이트: 불일치율 ≤ threshold, 승인됨.
룰엔진 단독 baseline 이므로 별도 보고(서브에이전트 결합 시 향상).

사용: golden_runner.py <golden-set.json> [--min-detect 0.8] [--max-fp 0.15] [--json]
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, ROOT  # noqa: E402
from kcia_engine import Engine, load_ruleset  # noqa: E402

# ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)


SEV_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
MIN_REVISE = 10   # 퇴화(전부 pass/전부 revise) 방지 최소 클래스 수
MIN_PASS = 5
DEFAULT_MIN_DETECT = 0.8   # 검출률 하한 게이트 기본값(H-5: run() 시그니처·main() 이중정의 일원화)
DEFAULT_MAX_FP = 0.15      # 오탐률 상한 게이트 기본값(H-5: 상동)


def run(golden_path, min_detect=DEFAULT_MIN_DETECT, max_fp=DEFAULT_MAX_FP):
    gs = load_json(golden_path)
    ruleset = load_ruleset(gs.get("regulatory_domain"))  # 골든셋은 regulatory_domain 명시 필수(2부 1단계: 미기재 → cosmetic 폴백 폐지 → 미완 룰셋 fail-closed)
    # 골든 항목은 functional_status 전부 unknown(고위험 가정), evidence 없음.
    eng = Engine(ruleset, {"whitening": "unknown", "wrinkle": "unknown", "uv_protection": "unknown"}, [])

    # 룰엔진 baseline 은 'ruleset 으로 잡을 수 있다고 라벨된' 항목에 대해서만 측정(서브에이전트 전용 항목 분리).
    rs_revise = rs_detected = exp_pass = false_pos = 0
    subagent_only = 0
    misses, fps, axis_conf, sev_conf = [], [], [], []
    total_revise = 0

    for it in gs["items"]:
        vio = eng.scan_text(it["text"], set())
        got_axes = {v["axis"] for v in vio}
        got_sev = max((SEV_ORDER[v["severity"]] for v in vio), default=-1)
        if it["expected_verdict"] == "revise":
            total_revise += 1
            by = it.get("detectable_by", "ruleset")
            if by == "subagent":
                subagent_only += 1
                continue  # 룰엔진 baseline 측정 대상 아님(문맥/외국어 — 서브에이전트 몫)
            rs_revise += 1
            if not vio:
                misses.append("%s:%s" % (it["id"], it["text"])); continue
            if it["axis"] not in got_axes:
                axis_conf.append("%s expected %s got %s" % (it["id"], it["axis"], sorted(got_axes)))
                misses.append("%s(축불일치):%s" % (it["id"], it["text"])); continue
            rs_detected += 1
            if got_sev < SEV_ORDER.get(it["severity"], 0):
                sev_conf.append("%s expected≥%s got %s" % (it["id"], it["severity"], got_sev))
        else:
            exp_pass += 1
            if vio:
                false_pos += 1; fps.append("%s:%s" % (it["id"], it["text"]))

    detect_rate = rs_detected / rs_revise if rs_revise else 0.0
    fp_rate = false_pos / exp_pass if exp_pass else 1.0

    disagree = sum(1 for it in gs["items"] if not it["agreed"])
    disagree_rate = disagree / len(gs["items"]) if gs["items"] else 1.0
    label_ok = (disagree_rate <= gs["meta"]["disagreement_threshold"]) and gs["meta"].get("approved", False)

    # 퇴화 골든셋 방지: 클래스 균형 강제
    balance_ok = (total_revise >= MIN_REVISE) and (exp_pass >= MIN_PASS)

    result = {
        "items": len(gs["items"]), "total_revise": total_revise, "expected_pass": exp_pass,
        "ruleset_revise": rs_revise, "subagent_only_revise": subagent_only,
        "detection_rate": round(detect_rate, 4), "false_positive_rate": round(fp_rate, 4),
        "baseline": "ruleset-only (deterministic); subagent-only 항목 %d개 제외" % subagent_only,
        "misses": misses, "false_positives": fps,
        "axis_confusion": axis_conf, "severity_confusion": sev_conf,
        "label_disagreement_rate": round(disagree_rate, 4), "label_quality_ok": label_ok,
        "balance_ok": balance_ok,
        "gate_pass": (detect_rate >= min_detect and fp_rate <= max_fp and label_ok
                      and balance_ok and rs_revise > 0 and exp_pass > 0),
        "thresholds": {"min_detect": min_detect, "max_fp": max_fp, "min_revise": MIN_REVISE, "min_pass": MIN_PASS},
    }
    return result


def main():
    gp = sys.argv[1]
    min_d = float(sys.argv[sys.argv.index("--min-detect") + 1]) if "--min-detect" in sys.argv else DEFAULT_MIN_DETECT
    max_f = float(sys.argv[sys.argv.index("--max-fp") + 1]) if "--max-fp" in sys.argv else DEFAULT_MAX_FP
    r = run(gp, min_d, max_f)
    if "--json" in sys.argv:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print("[골든셋 회귀] 항목 %d (revise %d / pass %d · subagent-only %d)"
              % (r["items"], r["total_revise"], r["expected_pass"], r["subagent_only_revise"]))
        print("  룰엔진 baseline 검출률 %.0f%%(≥%.0f%%, 대상 %d) · 오탐률 %.0f%%(≤%.0f%%) · 라벨불일치 %.0f%% · 균형 %s"
              % (r["detection_rate"] * 100, min_d * 100, r["ruleset_revise"], r["false_positive_rate"] * 100,
                 max_f * 100, r["label_disagreement_rate"] * 100, "OK" if r["balance_ok"] else "미달"))
        if r["misses"]:
            print("  미검출:", "; ".join(r["misses"]))
        if r["false_positives"]:
            print("  오탐:", "; ".join(r["false_positives"]))
        if r["axis_confusion"]:
            print("  축 불일치:", "; ".join(r["axis_confusion"]))
        if r["severity_confusion"]:
            print("  심각도 confusion:", "; ".join(r["severity_confusion"]))
        print("  라벨 품질:", "OK" if r["label_quality_ok"] else "미달", "· 게이트:", "통과" if r["gate_pass"] else "실패")
    sys.exit(0 if r["gate_pass"] else 1)


if __name__ == "__main__":
    main()
