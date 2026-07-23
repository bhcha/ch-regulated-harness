#!/usr/bin/env python3
"""extract_accuracy.py — claim-basis 추출 정확도 게이트 (B1 c+).

워킹백워드 추출 결과(claim-basis.json)를 사람이 작성한 골든 기대표와 비교해
  누락(omission): 골든이 approved/근거인데 추출이 못 잡음
  오추출(false-extraction): 추출이 approved/근거인데 골든은 아님(환각 1차 방어선 누수)
를 센다. 둘 다 임계(기본 0) 이내여야 통과.

사용: extract_accuracy.py <claim-basis.json> <golden-expected.json> [--max-omission N] [--max-false N]
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json  # noqa: E402


def main():
    cb_path, golden_path = sys.argv[1], sys.argv[2]
    max_om = int(sys.argv[sys.argv.index("--max-omission") + 1]) if "--max-omission" in sys.argv else 0
    max_fe = int(sys.argv[sys.argv.index("--max-false") + 1]) if "--max-false" in sys.argv else 0
    cb = load_json(cb_path)
    g = load_json(golden_path)

    omissions, false_ext = [], []

    # 기능성 상태 비교
    cb_func = {k: v["status"] for k, v in cb["functional_status"].items()}
    for key, exp in g["functional_status"].items():
        got = cb_func.get(key, "unknown")
        if exp == "approved" and got != "approved":
            omissions.append("기능성 %s: 기대 approved, 추출 %s" % (key, got))
        if exp != "approved" and got == "approved":
            false_ext.append("기능성 %s: 추출 approved(오추출), 기대 %s" % (key, exp))

    # must_not_be_approved (환각 방지 핵심)
    for key in g.get("must_not_be_approved", []):
        if cb_func.get(key) == "approved":
            false_ext.append("must_not_approve 위반: %s 가 approved" % key)

    # approved 항목은 실재 근거 id(evidence_ref) 필수 — null 인데 approved 면 오추출
    if g.get("approved_requires_evidence_ref"):
        for key, v in cb["functional_status"].items():
            if v["status"] == "approved" and not v.get("evidence_ref"):
                false_ext.append("기능성 %s: approved 인데 evidence_ref 가 null(근거 없는 승인)" % key)

    # product_type 검증 (오추출 — 엉뚱한 유형)
    if "product_type_contains" in g:
        if g["product_type_contains"] not in (cb.get("product_type") or ""):
            false_ext.append("product_type '%s' 에 기대 토큰 '%s' 없음" % (cb.get("product_type"), g["product_type_contains"]))

    # notified_ingredients / certifications 거짓 양성 검사 (기대 목록 대비 초과 추출)
    if "notified_ingredients_expected" in g:
        got = [n["name"] for n in cb.get("notified_ingredients", [])]
        for n in got:
            if n not in g["notified_ingredients_expected"]:
                false_ext.append("notified_ingredients 오추출: '%s'" % n)
    if "certifications_expected" in g:
        for c in cb.get("certifications", []):
            if c not in g["certifications_expected"]:
                false_ext.append("certifications 오추출: '%s'" % c)

    # evidence_on_file 개수
    exp_ev = g.get("evidence_on_file_count")
    if exp_ev is not None:
        got_ev = len(cb["evidence_on_file"])
        if got_ev > exp_ev:
            false_ext.append("evidence_on_file 오추출: 추출 %d > 기대 %d" % (got_ev, exp_ev))
        if got_ev < exp_ev:
            omissions.append("evidence_on_file 누락: 추출 %d < 기대 %d" % (got_ev, exp_ev))

    # unsupported 포함 여부
    for w in g.get("unsupported_must_include", []):
        if w not in cb.get("unsupported_claims", []):
            omissions.append("unsupported 누락: '%s' 가 unsupported 목록에 없음" % w)

    result = {
        "omissions": omissions, "false_extractions": false_ext,
        "omission_count": len(omissions), "false_count": len(false_ext),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    ok = len(omissions) <= max_om and len(false_ext) <= max_fe
    if not ok:
        sys.stderr.write("[추출 정확도 실패] 누락 %d(≤%d), 오추출 %d(≤%d)\n"
                         % (len(omissions), max_om, len(false_ext), max_fe))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
