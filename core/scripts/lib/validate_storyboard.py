#!/usr/bin/env python3
"""validate_storyboard.py — 스토리보드 의미 검증 (B4 enabled_if/캐논 강제, Codex B4 #1/#9).

스키마(구조)로 못 막는 의미 규칙을 결정적으로 강제한다:
 - 실증 미등록(claim-basis.evidence_on_file == [])이면 storyline/plan 에
   clinicalEvidence·beforeAfter 블록과 graph 비주얼이 존재하면 안 된다(환각 차단).
 - 블록 order 는 오름차순·중복 없음, type 은 캐논 enum, hero 는 필수(캐논 완전성).
사용: validate_storyboard.py <run_dir>  (exit 1 = 위반)
"""
import sys, os, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, ROOT, deliverable_format, is_number as _is_num  # noqa: E402
from clinical_chart import derive_chart, numbers_consistent, metric_matches_claim  # noqa: E402  (도출·숫자·지표 단일 출처)

# ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)
# format 다이얼 전용 비-도메인 팩(packs/_format/). check_canon_coverage.py 와 동일한 FORMATS_DIR 해석.
PACKS_DIR = os.environ.get("PACKS_DIR") or os.path.join(os.path.dirname(ROOT), "packs")
FORMATS_DIR = os.environ.get("FORMATS_DIR") or os.path.join(PACKS_DIR, "_format")
GATED = {"clinicalEvidence", "beforeAfter"}

# 필수 루트 블록·유효 블록 카탈로그(types)는 포맷 캐논 정본(packs/_format/<fmt>/canon.json)에서 읽는다
#   (4단계: storyline 스키마 enum·하드코딩 폴백 폐지 — _canon/_required_root). 로드 실패=미완 캐논 fail-closed.


_EPS = 1e-6   # 부동소수 표현 오차만 — 의미적 허용오차 아님(정확 일치)
_GATED = {"clinicalEvidence", "beforeAfter"}
_STRONG = {"superlative", "efficacy", "speed"}   # kcia_engine.STRONG 과 동일(강주장)


# _is_num: harness.is_number 를 import (K-1 일원화)


def _vals_equal(a, b):
    """순서·길이·값(표현오차 1e-6) 정확 일치."""
    return len(a) == len(b) and all(abs(x - y) <= _EPS for x, y in zip(a, b))


def _check_chart_evidence_binding(b, evidence_by_id, where, errs):
    """chart_data 를 '그 차트를 실증하는 단일 강주장'의 evidence 도출(derive_chart)에 '정확 일치'로 결박한다(절대규칙 5).
    ⚠ Codex FIX GG: chart_data 는 clinicalEvidence/beforeAfter 블록에만 허용(다른 type 은 image_engine 이 이미지 생성).
    ⚠ Codex FIX BB/FF: footnote_ref 가 가리키는 강주장들의 'distinct evidence_ref'가 정확히 1개여야 함(0/복수 → 오류).
    ⚠ Codex FIX CC: series 는 도출 (label, value) 쌍을 '순서까지' 정확히 일치.
    ⚠ Codex FIX EE: 콜아웃 숫자는 clinical_chart.numbers_consistent 단일 규칙으로 검증(% = 변화율, 맨숫자 = 값).
    chart_data 없으면 no-op."""
    vis = b.get("visual") or {}
    cd = vis.get("chart_data")
    if not isinstance(cd, dict):
        return
    btype = b.get("type")
    # FIX GG: chart_data 는 게이트 블록(clinicalEvidence/beforeAfter)에만 허용.
    if btype not in _GATED:
        errs.append("%s: '%s' 블록에 chart_data 사용 불가 — chart_data 는 clinicalEvidence/beforeAfter 에만 허용" % (where, btype))
        return
    # FIX BB/FF: footnote_ref → 그 각주를 가진 강주장들 → distinct evidence_ref 정확히 1개.
    fr = cd.get("footnote_ref")
    if not fr:
        errs.append("%s: '%s' chart_data.footnote_ref 가 없음 — 차트를 실증하는 강주장을 특정할 수 없음" % (where, btype))
        return
    fn_ids = {f.get("id") for f in (b.get("footnotes") or [])}
    if fr not in fn_ids:
        errs.append("%s: '%s' chart_data.footnote_ref '%s' 가 블록 각주에 없음" % (where, btype, fr))
        return
    strong_claims = [c for c in b.get("claims", [])
                     if c.get("claim_strength") in _STRONG and c.get("footnote_id") == fr
                     and evidence_by_id.get(c.get("evidence_ref")) is not None]
    refs = {c.get("evidence_ref") for c in strong_claims}
    if len(refs) == 0:
        errs.append("%s: '%s' chart_data 를 실증하는 강주장(footnote_id==%s)·evidence 가 없음(환각 차단)"
                    % (where, btype, fr))
        return
    if len(refs) > 1:
        errs.append("%s: '%s' chart evidence ambiguous: footnote_ref '%s' 가 서로 다른 근거를 가진 복수 강주장을 가리킴"
                    % (where, btype, fr))
        return
    ev = evidence_by_id.get(next(iter(refs)))
    d = derive_chart(ev)
    if not d:
        errs.append("%s: '%s' 참조 evidence 정량필드가 불일치/불완전해 차트 도출 불가(fail-closed)" % (where, btype))
        return
    # FIX JJ: 차트 owner 강주장 target_text 가 evidence metric 을 명시해야 함(metric 있을 때).
    #   ⚠ Codex FIX QQ: 정확 부분문자열이 아니라 metric_matches_claim(접미 '량' stem) 으로 — '수분량' vs '수분 개선' 허용.
    if d.get("metric") and not any(metric_matches_claim(d["metric"], c.get("target_text") or "") for c in strong_claims):
        errs.append("%s: '%s' 차트 metric 불일치: 강주장이 evidence metric('%s')을 명시하지 않음"
                    % (where, btype, d["metric"]))
    # FIX KK: 차트 owner 강주장(footnote_id==footnote_ref)의 수치/방향도 evidence 도출값과 정확히 일치해야 함.
    #   (chart_data 만 맞고 강주장이 "수분 +99% 증가" 처럼 조작된 경우 차단 — numbers_consistent 단일 규칙.)
    for c in strong_claims:
        cok, _cn = numbers_consistent(c.get("target_text") or "", d)
        if not cok:
            errs.append("%s: '%s' 강주장 수치가 evidence 와 불일치(조작): '%s'" % (where, btype, c.get("target_text")))
            break
    # FIX CC: series 의 (label, value) 쌍을 도출값과 '순서까지' 정확 일치.
    cd_series = [s for s in (cd.get("series") or []) if isinstance(s, dict)]
    cd_vals = [float(s["value"]) for s in cd_series if _is_num(s.get("value"))]
    cd_labels = [str(s.get("label") or "") for s in cd_series]
    vals_ok = (d["values"] is not None and _vals_equal(cd_vals, d["values"]))
    labels_ok = (len(cd_labels) == len(d["labels"]) and all(x == y for x, y in zip(cd_labels, d["labels"])))
    if not (vals_ok and labels_ok):
        errs.append("%s: '%s' chart_data.series (라벨,값) 쌍이 evidence 도출값과 순서까지 정확히 일치하지 않음(환각/스왑)"
                    % (where, btype))
    # FIX JJ/LL: unit 결박 — evidence 에 unit 이 있으면 '모든' series 항목이 그 unit 을 명시·일치해야 한다
    #   (누락으로 우회 불가). evidence unit 이 없는데 series 에 unit 이 있으면 그것도 불일치(검증 불가 → fail-closed).
    ev_unit = d.get("unit") or ""
    for s in cd_series:
        su = s.get("unit")
        if ev_unit:
            if su is None or str(su) != ev_unit:
                errs.append("%s: '%s' chart_data.series unit 누락/불일치 — evidence unit('%s') 와 항목별로 정확히 일치해야 함"
                            % (where, btype, ev_unit))
                break
        elif su is not None:
            errs.append("%s: '%s' chart_data.series unit('%s')이 evidence unit(없음)과 불일치" % (where, btype, su))
            break
    # FIX EE: 콜아웃 숫자는 claim 검사와 '동일한' numbers_consistent 규칙으로(% = 변화율, 맨숫자 = 값).
    # FIX HH: 모든 콜아웃은 evidence-도출 수치를 '하나 이상' 가져야 함(숫자 없는 텍스트 콜아웃 거부 — 예 "여드름 치료").
    for co in (cd.get("callouts") or []):
        ok, n_matched = numbers_consistent(co, d)
        if not ok:
            errs.append("%s: '%s' chart_data callout '%s' 수치가 evidence 도출값과 불일치(환각)" % (where, btype, co))
        elif n_matched < 1:
            errs.append("%s: '%s' chart_data callout '%s' 에 evidence-도출 수치가 없음(텍스트 콜아웃 금지)" % (where, btype, co))


_DOC_ID_RE = re.compile(r"^doc-[0-9]{2,}$")


def _load_evidence_docs(rdir):
    """00-ingest/evidence-documents.json → {doc-id: 선언}. 매니페스트 부재/파손 시 빈 dict(no-op)."""
    p = os.path.join(rdir, "00-ingest/evidence-documents.json")
    if not os.path.exists(p):
        return {}
    try:
        docs = load_json(p).get("documents") or []
    except Exception:
        return {}
    return {d["id"]: d for d in docs if isinstance(d, dict) and isinstance(d.get("id"), str)}


def _check_verdict_binding(blocks, docs_by_id, errs):
    """반영 판정문 원문 결박(evidence-content-integration 5단계·2번 원칙). plan 블록의 claim 이
    반영 문서(doc-NN)를 evidence_ref 로 인용하면, 그 target_text(카피)는 선언 verdict_text 의
    '부분문자열'이어야 한다 — 문서에 없는 단정어(무자극 등) 확장을 심의 전에 fail-closed.
    (이번 런 '무자극' consumer_deception 적발의 재발 방지 지점.) 매니페스트 없으면 no-op(골든-중립)."""
    if not docs_by_id:
        return
    for b in blocks:
        for c in (b.get("claims") or []):
            ref = c.get("evidence_ref")
            if not (isinstance(ref, str) and _DOC_ID_RE.match(ref)):
                continue
            doc = docs_by_id.get(ref)
            if doc is None:
                errs.append("plan: claim 이 알 수 없는 근거 문서 id '%s' 를 인용(evidence-documents 매니페스트에 없음)" % ref)
                continue
            vt = doc.get("verdict_text")
            if not vt:
                # verdict_text 없음 → evidence_ref 로 인용 불가. 일반 참조 문서(reflect:true·kind!=test_report)는
                #   각주 인용 채널이 맞고, reflect:false 는 첨부-전용. 각각 맞는 안내로 fail-closed.
                if doc.get("reflect") is True and (doc.get("kind") or "general") != "test_report":
                    errs.append("plan: 일반 참조 문서 '%s' 는 claims.evidence_ref 로 인용할 수 없습니다 — "
                                "각주(footnotes)에 doc-NN 을 인용하고 reflection_points 를 블록 카피에 반영하세요." % ref)
                else:
                    errs.append("plan: 첨부-전용 근거 문서 '%s'(verdict_text 없음)를 반영 근거로 인용할 수 없음" % ref)
                continue
            tt = (c.get("target_text") or "").strip()
            if tt and tt not in vt:
                errs.append("plan: 판정문 원문 결박 위반 — '%s' 는 선언 판정문 원문('%s')의 부분문자열이 아님"
                            "(문서에 없는 단정어 확장 금지)" % (tt, vt))


def _block_copy_blob(b):
    """블록의 '본문 카피'(headline/subcopy/bodyText/claims.target_text) 결합. ⚠ footnotes 는 제외한다 —
    반영 포인트는 블록 '카피'에 있어야 하고 각주는 doc-NN '인용'만(각주에만 포인트가 있으면 반영 아님, Codex)."""
    parts = [b.get("headline", ""), b.get("subcopy", "")]
    parts += list(b.get("bodyText") or [])
    parts += [(c.get("target_text") or "") for c in (b.get("claims") or []) if isinstance(c, dict)]
    return " ".join(t for t in parts if t)


def _check_reference_binding(blocks, docs_by_id, errs):
    """일반 참조 문서(reflect:true, kind!=test_report) 반영 결박(확정 결정 — 승인 포인트 원문⊆블록 카피):
    각주로 doc-NN 을 인용하는 블록은 그 문서의 reflection_points 중 '적어도 하나'를 블록 카피에 원문(verbatim)
    포함해야 한다 — 바 각주 인용만으로는 내용 반영이 아니다(환각/공허한 인용 차단). 매니페스트 없으면 no-op."""
    if not docs_by_id:
        return
    ref_docs = {i: d for i, d in docs_by_id.items()
                if isinstance(d, dict) and d.get("reflect") is True
                and (d.get("kind") or "general") != "test_report"
                and [p for p in (d.get("reflection_points") or []) if p]}
    if not ref_docs:
        return
    for b in blocks:
        blob = _block_copy_blob(b)
        for fn in (b.get("footnotes") or []):
            if not isinstance(fn, dict):
                continue
            for tok in re.findall(r"doc-\d+", fn.get("text") or ""):
                d = ref_docs.get(tok)
                if not d:
                    continue
                pts = [p for p in (d.get("reflection_points") or []) if p]
                if not any(p in blob for p in pts):
                    errs.append("plan: 참조 문서 '%s' 를 각주로 인용한 블록에 반영 포인트 원문이 없습니다 — "
                                "reflection_points 중 하나를 블록 카피에 원문 그대로 반영하세요(각주 인용만으로는 반영 아님)." % tok)


def _canon_json(fmt):
    """포맷 캐논 정본(packs/_format/<fmt>/canon.json) 로드. 미정의/부재 포맷 → multipage_bm 폴백."""
    p = os.path.join(FORMATS_DIR, fmt, "canon.json")
    if not os.path.exists(p):
        p = os.path.join(FORMATS_DIR, "multipage_bm", "canon.json")
    return load_json(p)


def _canon(fmt):
    """캐논 유효 블록 카탈로그 = 정본 canon.json 의 types(4단계: storyline 스키마 enum 대신 정본 1개).
    로드 실패 = 미완 캐논 fail-closed(빈 집합 → check_blocks 가 모든 블록을 '캐논 외'로 거부; 옛 무음 폴백 폐지)."""
    try:
        return set(_canon_json(fmt).get("types") or [])
    except Exception:
        return set()


def _required_root(fmt):
    """포맷별 필수 루트 블록 = 정본 canon.json 의 required_root. 로드/키 부재 → ['hero'](BM 후방호환)."""
    try:
        rr = _canon_json(fmt).get("required_root")
        return rr if rr else ["hero"]
    except Exception:
        return ["hero"]


def _format(rdir):
    try:
        return deliverable_format(load_json(os.path.join(rdir, "state.json")))
    except Exception:
        return "multipage_bm"


def _disallowed(fmt):
    """포맷별 금지 블록 집합 — format-profiles.json 의 formats.<fmt>.disallowed_blocks.
    가법 게이트라 설정 부재/오류 시 빈 집합(fail-open on config absence — 기존 런 무영향)."""
    try:
        fp = load_json(os.path.join(FORMATS_DIR, "format-profiles.json"))
        db = (((fp.get("formats") or {}).get(fmt)) or {}).get("disallowed_blocks") or []
        return set(db)
    except Exception:
        return set()


# ── B-4: 비차트 정량(측정·설문) 수치의 근거 결박 스캔 ───────────────────────────
#   문제: claim_strength=factual + evidence_ref=null 인 맨숫자(예 설문 기호도 4.091점)는 강주장·차트 결박을
#   둘 다 우회해 무검증 통과 → 승인 스펙 밖(문서 원문에만 있는) 수치도, 날조 수치도 동일하게 done 도달.
#   처방: 블록 카피의 '측정·설문 단위' 수치가 승인 근거(voc 단일출처 + claim-basis evidence 도출값)에서
#   유도되지 않으면 반려. ⚠ **좁은 단위 화이트리스트로 시작**(false-positive 관리) — 가격[원]·매수[매]·각주
#   번호·%(차트 콜아웃은 chart_data 결박이 이미 커버) 등은 대상이 아니다. 점진 확대(설계 B-4).
#   ⚠ 보수적 시작의 알려진 한계(점진 확대 백로그, Codex 검토): (a) 정확 일치라 반올림 카피("4.1점" vs 근거
#   4.091)는 유도 실패로 처리(마케팅 반올림 허용 시 재검토) (b) derivable 풀이 voc 전체 숫자라 정수 점수(예 "4점")는
#   4주·매수 등과 우연 일치해 약하게 검사됨 — 실제 리스크인 소수 설문·측정값(4.091점·0.187㎟)은 강하게 잡힌다.
_CLINICAL_NUM_RE = re.compile(r'(\d+(?:\.\d+)?)\s*(점|㎟|㎜|㎣)')


def _collect_numbers(obj, out):
    """JSON 안의 모든 정량값을 float(소수 3자리 반올림)로 수집 — 유도 가능 집합(voc 단일출처·evidence 도출값)."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.add(round(float(obj), 3))
    elif isinstance(obj, str):
        for m in re.finditer(r'-?\d+(?:\.\d+)?', obj):
            try:
                out.add(round(float(m.group()), 3))
            except ValueError:
                pass
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_numbers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_numbers(v, out)


def _check_quantitative_provenance(blocks, derivable, where, errs):
    """B-4: 측정·설문 단위 수치가 승인 근거에서 유도되지 않으면 반려(환각·스펙밖 수치 차단).
       derivable = voc.json 전체 수치 ∪ claim-basis evidence 레코드 수치(도출 원천). 유도=값 정확 일치."""
    for b in blocks:
        for m in _CLINICAL_NUM_RE.finditer(_block_copy_blob(b)):
            val = round(float(m.group(1)), 3)
            if not any(abs(val - d) <= _EPS for d in derivable):
                errs.append("%s: 측정·설문 수치 '%s%s' 가 승인 근거(voc·claim-basis evidence)에서 유도되지 않음 — "
                            "문서 원문에 있어도 승인 스펙에 없는 수치는 쓸 수 없습니다(환각과 구분 불가)"
                            % (where, m.group(1), m.group(2)))


def check_blocks(blocks, has_evidence, where, errs, canon, req_root, evidence_by_id=None, disallowed=None):
    evidence_by_id = evidence_by_id or {}
    disallowed = disallowed or set()
    orders = [b.get("order") for b in blocks]
    if orders != sorted(orders) or len(set(orders)) != len(orders):
        errs.append("%s: 블록 order 가 오름차순·유일하지 않음 (%s)" % (where, orders))
    types = [b.get("type") for b in blocks]
    for t in types:
        if t not in canon:
            errs.append("%s: 캐논 외 블록 type '%s'" % (where, t))
    # 포맷 금지 블록(disallowed_blocks) — 스키마-합법이라도 이 포맷에선 허용되지 않는 블록(예: multipage_bm 의 구매 cta).
    #   LLM 편차·ADK 가용성과 무관한 결정적 차단(RCA 8장). disallowed 빈 집합이면 no-op(포맷 미선언 = 무영향).
    for t in types:
        if t in disallowed:
            errs.append("%s: 포맷 금지 블록 '%s' (이 포맷에서 허용되지 않음)" % (where, t))
    if not any(r in types for r in req_root):
        errs.append("%s: 필수 루트 블록 누락(%s 중 하나 필요)" % (where, "|".join(req_root)))
    if not has_evidence:
        for b in blocks:
            if b.get("type") in GATED:
                errs.append("%s: 실증 미등록인데 게이트 블록 '%s' 존재(환각 차단)" % (where, b["type"]))
            if isinstance(b.get("visual"), dict) and b["visual"].get("kind") == "graph":
                errs.append("%s: 실증 미등록인데 graph 비주얼 존재" % where)
    elif where == "plan":
        # 실증 등록 상태 + plan 단계에서만: beforeAfter 블록의 비주얼은 측정치 차트여야 한다(WS⑤ 본래 의도).
        #   kind=="graph" 또는 chart_data 존재여야 하며, kind=="photo"/"nukki" 단독(chart_data 없음 = 연출컷)은 오류.
        #   이는 측정 수치 전후대비를 단정 연출 이미지로 대체하는 환각을 차단한다.
        # ⚠ Codex FIX C: clinicalEvidence 는 정성적 사진(예: "피부 적합성 테스트 완료" 인증컷)도 정당하므로
        #   차트 강제 대상에서 제외한다 — 'beforeAfter' 만 차트 강제(기존 정성 clinicalEvidence photo 블록 보존).
        # ⚠ Codex FIX 3: outline(storyline) 블록은 visual 슬롯이 없어 kind=None 오탐 → where=="plan" 한정 +
        #   visual dict 가 실제 있는 블록만 검사(outline-safe).
        for b in blocks:
            if b.get("type") != "beforeAfter":
                continue
            if not isinstance(b.get("visual"), dict):
                continue   # visual 슬롯이 없는 블록(outline storyline 등)은 검사 대상 아님
            vis = b["visual"]
            kind = vis.get("kind")
            has_chart = (kind == "graph") or bool(vis.get("chart_data"))
            if not has_chart:
                errs.append(
                    "%s: 실증 등록 상태인데 'beforeAfter' 블록의 visual 이 측정치 차트가 아님 "
                    "(kind=%r, chart_data 없음) — 전후대비 블록은 graph 또는 chart_data 필수" % (where, kind)
                )
    # chart_data 결박 검증(Codex FIX Q) — plan 단계, chart_data 보유 블록만(has_evidence 무관: 미참조 시도 차단).
    #   차트 수치는 실재 evidence 정량필드에서만 도출돼야 한다(환각 차단). chart_data 없으면 no-op → 골든-중립.
    if where == "plan":
        for b in blocks:
            if isinstance((b.get("visual") or {}).get("chart_data"), dict):
                _check_chart_evidence_binding(b, evidence_by_id, where, errs)


def main():
    rdir = sys.argv[1]
    cb = load_json(os.path.join(rdir, "00-ingest/claim-basis.json"))
    has_evidence = len(cb.get("evidence_on_file", [])) > 0
    evidence_by_id = {e["id"]: e for e in cb.get("evidence_on_file", []) if isinstance(e, dict) and e.get("id")}
    fmt = _format(rdir)
    canon = _canon(fmt)
    req_root = _required_root(fmt)
    disallowed = _disallowed(fmt)
    errs = []
    sb = os.path.join(rdir, "03-storyboard")

    odir = os.path.join(sb, "outline/options")
    if os.path.isdir(odir):
        for opt in sorted(os.listdir(odir)):
            p = os.path.join(odir, opt, "storyline.json")
            if os.path.exists(p):
                check_blocks(load_json(p).get("blocks", []), has_evidence, "outline/%s" % opt, errs, canon, req_root,
                             disallowed=disallowed)

    pdir = os.path.join(sb, "plan")
    if os.path.isdir(pdir):
        blocks = [load_json(os.path.join(pdir, fn)) for fn in sorted(os.listdir(pdir)) if fn.endswith(".json")]
        if blocks:
            check_blocks(blocks, has_evidence, "plan", errs, canon, req_root, evidence_by_id, disallowed=disallowed)
            # B-4: 측정·설문 수치 근거 결박(voc 단일출처 + claim-basis evidence 도출값). 근거 없는 골든은
            #   임상 블록이 없어 측정·설문 단위 수치도 없다 → 스캔 무영향(golden-중립). evidence 유래 수치는 결박 강제.
            _derivable = set()
            _vp = os.path.join(rdir, "00-ingest/voc.json")
            if os.path.exists(_vp):
                _collect_numbers(load_json(_vp), _derivable)
            for _e in evidence_by_id.values():
                _collect_numbers(_e, _derivable)
            _check_quantitative_provenance(blocks, _derivable, "plan", errs)
            docs_by_id = _load_evidence_docs(rdir)
            # 반영 판정문 원문 결박: doc-NN 인용 카피는 선언 verdict_text 의 부분문자열이어야 한다(test_report).
            _check_verdict_binding(blocks, docs_by_id, errs)
            # 일반 참조 문서 결박: 각주로 doc-NN 인용한 블록은 reflection_points 원문을 카피에 포함해야 한다.
            _check_reference_binding(blocks, docs_by_id, errs)
            # 반영 강제(1급·correctable): reflect:true 근거 문서는 plan 에 반영 블록으로 인용돼야 한다. 여기(03)서
            #   잡으면 storyboard 보완(revise → run-stage storyboard-plan → 재심의)으로 교정 가능하고, 반영 블록의
            #   판정 카피가 이 단계 심의에서 실제로 검토된다. 최종 선택 HTML 반영-생존은 done 게이트가 백스톱.
            reflect_ids = [d for d, doc in docs_by_id.items() if isinstance(doc, dict) and doc.get("reflect") is True]
            if reflect_ids:
                from check_evidence_reflection import reflected_map   # 반영 판정 단일 출처(03=HTML 없음→plan-only)
                rmap = reflected_map(rdir, reflect_ids)
                miss = [d for d in reflect_ids if not rmap.get(d)]
                if miss:
                    errs.append("plan: reflect:true 근거 문서가 반영 블록으로 인용되지 않음(%s) — 해당 doc-NN 을 "
                                "인용하는 반영 블록(정성=clinicalEvidence 인증-표시형)을 추가하거나 "
                                "evidence/index.json 에 reflect:false(첨부-전용)를 명시하세요." % ", ".join(miss))

    if errs:
        sys.stderr.write("[스토리보드 의미 검증 실패]\n" + "\n".join("  - " + e for e in errs) + "\n")
        sys.exit(1)
    print("[스토리보드 의미 검증 통과]")


if __name__ == "__main__":
    main()
