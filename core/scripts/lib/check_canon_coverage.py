#!/usr/bin/env python3
"""check_canon_coverage.py — 상세페이지 '주요 구성요소' 커버리지 검사 (전용 체크 단계).

packs/_format/<format>/canon.json(정본 1개, format 팩)의 components 구성요소가 산출물(스토리라인/기획안/디자인)에
실제로 들어있는지 결정론적으로 검사하고 canon-coverage.json 리포트를 남긴다.
 - covered: satisfied_by 의 블록 type 중 하나라도 present.
 - evidence_gated 구성요소(과학/임상)는 claim-basis.evidence_on_file 가 비면 '면제'(환각 차단 우선).
 - claim_gated 구성요소(판매/수상)는 그 주장이 실제로 제기되지 않으면(brief sensitive_labels 부재/전부 not_claimed) '면제'
   — 범용 브랜드 카피만으로 socialProof/brandTrust 가 present 라 해서 '필수 충족'으로 오판하지 않도록(거짓 충족 신호 차단).
필수 구성요소가 누락(non-exempt)이면 exit 1.

사용: check_canon_coverage.py <run_dir> [--scope plan|outline|design] [--out <path>]
"""
import sys, os, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, atomic_write_json, PACKS_DIR, FORMATS_DIR, deliverable_format  # noqa: E402

# PACKS_DIR·FORMATS_DIR: harness 에서 import (K-1 일원화 — 경로 해석 단일화)


def _declared_brand(rdir):
    """제품 브랜드 선언 여부 — state.product.name 의 '[브랜드 …]' 접두에서 파생(없으면 '')."""
    sf = os.path.join(rdir, "state.json")
    if not os.path.exists(sf):
        return ""
    try:
        name = (load_json(sf).get("product", {}) or {}).get("name", "") or ""
    except Exception:
        return ""
    m = re.match(r"\s*\[([^\]]+)\]", name)
    toks = m.group(1).split() if m else []
    return toks[0] if toks else ""


# 판매/수상 계열 라벨 어휘(socialProof '판매/순위' · brandTrust '수상·기술력' 에 대응). \d+위=판매순위.
_SALES_AWARD_RE = re.compile(r"판매|매출|순위|수상|어워드|재구매|베스트\s*셀러|\d+\s*위|\d+\s*등|no\.?\s*1|#\s*1|rank|award", re.I)


def _has_sales_claim(rdir):
    """판매/수상 주장이 산출물에서 실제로 제기됐는지 — brief.json sensitive_labels 근거.
       판매/수상 계열 라벨이 하나라도 '실제 카피 노출'(status ∉ {not_claimed, unsupported}; 예 approved)이면 True(주장됨).
       라벨 부재 또는 전부 not_claimed/unsupported 면 False(미주장 → salesAward 면제 대상) —
       not_claimed=애초 미주장 · unsupported=근거없어 카피에서 배제, 둘 다 광고에 판매/수상 데이터가 실리지 않는다.
       판정 불가(brief 부재/손상)면 True(보수 — 기존 엄격 동작 보존, 조용한 완화 금지)."""
    bp = os.path.join(rdir, "01-brief/brief.json")
    if not os.path.exists(bp):
        return True
    try:
        labels = load_json(bp).get("sensitive_labels", []) or []
    except Exception:
        return True
    for s in labels:
        if _SALES_AWARD_RE.search(s.get("label") or "") and s.get("status") not in ("not_claimed", "unsupported"):
            return True
    return False


def present_types(rdir, scope):
    """scope 별 현재 산출물에 존재하는 블록 type 집합(plan/design 및 선택 후 outline=단일 set)."""
    types = set()
    if scope == "design":
        man = os.path.join(rdir, "04-keyvisual/design-manifest.json")
        if os.path.exists(man):
            types = {s["block"] for s in load_json(man).get("sections", [])}
    elif scope == "plan":
        pdir = os.path.join(rdir, "03-storyboard/plan")
        if os.path.isdir(pdir):
            for fn in sorted(os.listdir(pdir)):
                if fn.endswith(".json"):
                    b = load_json(os.path.join(pdir, fn))
                    if _has_content(b):   # 빈/placeholder 블록은 구성요소 충족으로 인정 안 함(#3)
                        types.add(b.get("type"))
    else:  # outline (선택 후: selected 만; 선택 전: 합집합 — main 이 per-option 평가로 대체)
        for _opt, t in _outline_options(rdir, selected_only=True):
            types |= t
    return {t for t in types if t}


def _selected_outline(rdir):
    dec = os.path.join(rdir, "03-storyboard/outline/decision.json")
    if os.path.exists(dec):
        try:
            return load_json(dec).get("selected")
        except Exception:
            return None
    return None


def _outline_options(rdir, selected_only=False):
    """[(opt, types)] — outline 각 옵션의 블록 type 집합. selected_only 면 선택안만(없으면 전 옵션)."""
    odir = os.path.join(rdir, "03-storyboard/outline")
    sel = _selected_outline(rdir)
    opts = [sel] if (selected_only and sel) else (
        sorted(os.listdir(os.path.join(odir, "options"))) if os.path.isdir(os.path.join(odir, "options")) else [])
    out = []
    for opt in opts:
        p = os.path.join(odir, "options", opt, "storyline.json")
        if os.path.exists(p):
            out.append((opt, {b.get("type") for b in load_json(p).get("blocks", []) if b.get("type")}))
    return out


def _run_format(rdir):
    """run 의 선언 포맷(state.product.deliverable_format). 부재/오류 → multipage_bm(후방호환)."""
    fmt = "multipage_bm"
    sf = os.path.join(rdir, "state.json")
    if os.path.exists(sf):
        try:
            fmt = deliverable_format(load_json(sf))
        except Exception:
            fmt = "multipage_bm"
    return fmt


def _disallowed_for(rdir):
    """포맷별 금지 블록 집합(format-profiles.formats.<fmt>.disallowed_blocks). 부재/오류 → 빈 집합(가법 게이트)."""
    try:
        fp = load_json(os.path.join(FORMATS_DIR, "format-profiles.json"))
        db = (((fp.get("formats") or {}).get(_run_format(rdir))) or {}).get("disallowed_blocks") or []
        return set(db)
    except Exception:
        return set()


def _option_html_blocks(rdir):
    """전 옵션 04-keyvisual/options/*/index.html 의 data-block 값 집합(금지블록 탐지 한정).
       check_html_blocks 의 견고한 파서를 재사용(CSS/주석 오탐 없음). design-manifest 는 '선택안'만 담아
       비선택 B/C 옵션의 금지블록이 사각이므로(RCA 8-1.4) 커버리지 경로에서도 전수 스캔한다(외부리뷰 P2)."""
    odir = os.path.join(rdir, "04-keyvisual/options")
    if not os.path.isdir(odir):
        return set()
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from check_html_blocks import _BlockAttrParser
    except Exception:
        return set()
    out = set()
    for root, _dirs, fnames in os.walk(odir):
        for fn in sorted(fnames):
            if not fn.endswith(".html"):
                continue
            try:
                text = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            p = _BlockAttrParser()
            p.feed(text)
            out |= set(p.blocks)
    return out


def _raw_present_types(rdir, scope):
    """scope 별 산출물의 RAW 블록 type 집합 — 금지블록 탐지용(빈/placeholder 도 잡도록 _has_content 필터 미적용, RCA 8-1.3).
       outline 은 선택 전/후 무관 전(全) 옵션 union(어느 옵션의 금지블록도 잡음).
       design 은 design-manifest(선택안) + 전 옵션 HTML data-block union → 비선택 B/C 사각 해소(외부리뷰 P2)."""
    types = set()
    if scope == "design":
        man = os.path.join(rdir, "04-keyvisual/design-manifest.json")
        if os.path.exists(man):
            types = {s.get("block") for s in load_json(man).get("sections", [])}
        types |= _option_html_blocks(rdir)   # 비선택 B/C 옵션의 금지블록도 잡음(전수 스캔)
    elif scope == "plan":
        pdir = os.path.join(rdir, "03-storyboard/plan")
        if os.path.isdir(pdir):
            for fn in sorted(os.listdir(pdir)):
                if fn.endswith(".json"):
                    types.add(load_json(os.path.join(pdir, fn)).get("type"))
    else:  # outline — 전 옵션 raw union(_outline_options 는 이미 필터 없음)
        for _opt, t in _outline_options(rdir, selected_only=False):
            types |= t
    return {t for t in types if t}


def _has_content(b):
    """블록이 실질 콘텐츠를 가졌는지 — 빈 헤드라인/내용은 구성요소 충족으로 인정 안 함."""
    if len((b.get("headline") or "").strip()) < 2:
        return False
    body = b.get("bodyText") or []
    return bool(body or b.get("claims") or b.get("footnotes") or (b.get("visual") or {}).get("ref"))


def auto_scope(rdir):
    if os.path.exists(os.path.join(rdir, "04-keyvisual/design-manifest.json")):
        return "design"
    if os.path.isdir(os.path.join(rdir, "03-storyboard/plan")) and os.listdir(os.path.join(rdir, "03-storyboard/plan")):
        return "plan"
    return "outline"


def out_path_for(rdir, scope):
    return os.path.join(rdir, "04-keyvisual/canon-coverage.json" if scope == "design"
                        else "03-storyboard/canon-coverage.json")


def coverage_spec(rdir):
    """4단계: 구성요소 커버리지 SSoT = 포맷 캐논 정본 canon.json 의 components(packs/_format/<fmt>/canon.json).
       canon-components.<format>.json 는 canon.json 으로 흡수됨. 미정의/부재 포맷 → multipage_bm 캐논 폴백."""
    fmt = "multipage_bm"
    sf = os.path.join(rdir, "state.json")
    if os.path.exists(sf):
        try:
            fmt = deliverable_format(load_json(sf))
        except Exception:
            fmt = "multipage_bm"
    p = os.path.join(FORMATS_DIR, fmt, "canon.json")
    if not os.path.exists(p):
        p = os.path.join(FORMATS_DIR, "multipage_bm", "canon.json")
    return load_json(p)["components"]


def _eval_one(spec, present, has_evidence, has_brand, has_sales_claim):
    """단일 type set 평가 → (comps, missing_required)."""
    comps, missing = [], []
    for c in spec:
        hit = [t for t in c["satisfied_by"] if t in present]
        covered = bool(hit)
        if c.get("evidence_gated") and not has_evidence:
            status = "exempt(실증미등록)"
        elif c.get("brand_gated") and not has_brand:
            status = "exempt(브랜드미선언)"   # 브랜드 미선언 → 특정 브랜드 배너 강제 면제(범용화)
        elif c.get("claim_gated") == "sales_award" and not has_sales_claim:
            status = "exempt(미주장)"   # 판매/수상 주장 미제기 → 범용 브랜드 카피의 거짓 충족 신호 면제
        elif covered:
            status = "covered"
        else:
            status = "missing"
            if c["required"]:
                missing.append(c["id"])
        comps.append({"id": c["id"], "label": c["label"], "required": c["required"],
                      "evidence_gated": bool(c.get("evidence_gated")),
                      "covered": covered, "status": status, "present_by": hit})
    return comps, missing


def main():
    rdir = sys.argv[1]
    scope = sys.argv[sys.argv.index("--scope") + 1] if "--scope" in sys.argv else auto_scope(rdir)
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else out_path_for(rdir, scope)

    spec = coverage_spec(rdir)   # M3: 포맷별 커버리지 SSoT(하드코딩 제거)
    cb = load_json(os.path.join(rdir, "00-ingest/claim-basis.json"))
    has_evidence = len(cb.get("evidence_on_file", [])) > 0
    has_brand = bool(_declared_brand(rdir))
    has_sales_claim = _has_sales_claim(rdir)   # 판매/수상 주장 실제 제기 여부(claim_gated 면제 신호)

    # 외부리뷰 M3 HIGH: outline 선택 전(다옵션)은 '합집합'이 아니라 '각 옵션 독립' 평가 —
    #   불완전한 옵션을 사용자가 선택해도 누락이 안 잡히는 false-pass 차단(두 단계 커버리지 목적).
    per_option = None
    if scope == "outline" and not _selected_outline(rdir):
        opts = _outline_options(rdir, selected_only=False)
        if len(opts) > 1:
            per_option = {}
            union = set()
            worst_comps, missing = None, []
            for opt, types in opts:
                c_comps, c_missing = _eval_one(spec, types, has_evidence, has_brand, has_sales_claim)
                per_option[opt] = c_missing
                union |= types
                if c_missing:                      # 누락 있는 옵션을 대표 comps 로(가시화)
                    if worst_comps is None or len(c_missing) > len(missing):
                        worst_comps, missing = c_comps, c_missing
            present = union
            comps = worst_comps if worst_comps is not None else _eval_one(spec, union, has_evidence, has_brand, has_sales_claim)[0]
            # gate: 어느 한 옵션이라도 required missing 이면 fail
            missing = sorted({m for ms in per_option.values() for m in ms})

    if per_option is None:
        present = present_types(rdir, scope)
        comps, missing = _eval_one(spec, present, has_evidence, has_brand, has_sales_claim)

    # 포맷 금지 블록 가시화(보조 게이트) — 존재하는 RAW 블록이 포맷 disallowed_blocks 에 걸리면 실패.
    #   validate_storyboard 가 outline/plan 을 이미 막지만, 이 경로는 --scope design·check-components.sh 까지 파급되어
    #   비어있는 금지블록(_has_content 필터로 놓칠 수 있는)도 raw type 으로 결정적으로 잡는다(RCA 8-1.3).
    #   ★ report 기록(atomic_write_json) '전'에 계산·주입한다 — 실패한 검사가 canon-coverage.json 에 남아
    #     run.md/완결성 요약이 위반을 보이게(가시화 목적). write 뒤 주입은 미영속(외부리뷰 P2).
    disallowed = _disallowed_for(rdir)
    banned_present = sorted(disallowed & _raw_present_types(rdir, scope)) if disallowed else []

    report = {
        "scope": scope,
        "components": comps,
        "missing_required": missing,
        "all_required_covered": len(missing) == 0,
        "present_blocks": sorted(present),
    }
    if per_option is not None:
        report["per_option_missing"] = per_option   # 옵션별 누락(선택 전 독립 평가)
    if banned_present:
        report["disallowed_present"] = banned_present
    atomic_write_json(out, report)

    n_req = sum(1 for c in comps if c["required"] and not c["status"].startswith("exempt"))
    n_cov = sum(1 for c in comps if c["status"] == "covered")
    if "--json" in sys.argv:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print("[구성요소 커버리지] scope=%s · 충족 %d/%d (필수)" % (scope, n_cov, n_req))
        for c in comps:
            mark = "—" if c["status"].startswith("exempt") else {"covered": "✓", "missing": "✗"}.get(c["status"], "?")
            print("  %s %s(%s)%s" % (mark, c["label"], c["id"],
                                     ("" if c["status"] != "covered" else " ← " + ",".join(c["present_by"]))))
        if missing:
            print("  누락 필수 구성요소:", ", ".join(missing))
    if banned_present:
        sys.stderr.write("[구성요소 커버리지] 포맷 '%s' 금지 블록이 산출물에 존재: %s (이 포맷에서 허용되지 않음)\n"
                         % (_run_format(rdir), ", ".join(banned_present)))
    sys.exit(0 if (report["all_required_covered"] and not banned_present) else 1)


if __name__ == "__main__":
    main()
