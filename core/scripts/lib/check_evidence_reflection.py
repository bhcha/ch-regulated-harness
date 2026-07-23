#!/usr/bin/env python3
"""check_evidence_reflection.py — 반영 강제 done 게이트(evidence-content-integration 6단계·G3 처방).

reflect:true 근거 문서(doc-NN)가 최종 산출물에 '반영 블록'으로 실렸는지 결정적으로 확인한다(첨부=반영 강제).
반영 인정 = 03-storyboard/plan 의 어느 블록이 그 doc-NN 을 claims[].evidence_ref 또는 각주(footnotes[].text)로 인용.
plan 단계를 건너뛰는 포맷(one_pager 등, plan 디렉터리 부재)은 선택 옵션 HTML 에 doc-NN 문자열이 있으면 반영으로 인정(폴백).

매니페스트 없음 / reflect:true 문서 0건 → 통과(exit 0, no-evidence 런 바이트/동작 불변). 미반영 → exit 1(+미반영 id).
읽기 전용(state 미기록). 사용: check_evidence_reflection.py <run_dir>
"""
import sys, os, json, glob, re, html

_DOC_TOKEN_RE = re.compile(r"doc-\d+")   # 정확 토큰 매칭(부분문자열 금지: doc-10 ≠ doc-100)
# data-block 섹션 시작 태그 오프셋 추출(내용 슬라이싱용). 렌더는 flat section stack(render.py)이므로
#   블록 N 의 내용 = 이 시작부터 '다음 블록 시작'까지 → 판정 카피가 '그 블록 안'에 있는지 확인(Codex P1).
_SECTION_RE = re.compile(r'<[a-zA-Z][^>]*\bdata-block\s*=\s*["\']([^"\']+)["\']', re.I)
# <style>/<script>/주석 안의 data-block(예: CSS 선택자 [data-block="cta"]{})은 태그가 아니므로 섹션 경계에서
#   제외한다(공백으로 치환해 오프셋 보존 — 잘못된 경계 슬라이스 방지). check_html_blocks 의 style/script skip 과 동형.
_STRIP_RE = re.compile(r'<style\b[^>]*>.*?</style>|<script\b[^>]*>.*?</script>|<!--.*?-->', re.I | re.S)


def _blank_noncontent(html):
    """style/script/주석 구간을 같은 길이의 공백으로 치환(오프셋 보존)."""
    return _STRIP_RE.sub(lambda m: " " * (m.end() - m.start()), html)


def _load(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _selected_html_text(rdir):
    """선택된 키비주얼 HTML(최종 산출물)의 원문 문자열. 선택 HTML 이 아직 없으면 None
    (→ 반영 판정을 plan-only 로 폴백; 렌더 전 게이트 호출·테스트 픽스처). 반영 '내용'(판정 카피/doc-id)이
    실제 최종 산출물에 들어있는지 확인하는 근거 — 블록 type 만 있는 빈/일반 섹션의 거짓 통과 차단(Codex P1)."""
    dec = _load(os.path.join(rdir, "04-keyvisual/decision.json")) or {}
    sel = dec.get("selected")
    if not sel:
        return None
    hp = os.path.join(rdir, "04-keyvisual/options", str(sel), "index.html")
    if not os.path.exists(hp):
        return None
    try:
        with open(hp, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _selected_html_sections(rdir):
    """선택 키비주얼 HTML → [(block_type, section_text)]. flat section stack 가정: 각 data-block 시작부터
    '다음 data-block 시작'까지를 그 블록의 내용으로 슬라이스 → 판정 카피/doc-id 가 '그 반영 블록 안'에
    있는지 확인(빈/일반 섹션 + 다른 섹션에 텍스트가 있는 거짓 통과 차단 — Codex P1). 선택 HTML 없으면 None."""
    html = _selected_html_text(rdir)
    if html is None:
        return None
    scan = _blank_noncontent(html)   # 경계 탐지는 style/script/주석 제거본(오프셋 동일)에서
    marks = [(m.start(), m.group(1).strip()) for m in _SECTION_RE.finditer(scan)]
    sections = []
    for i, (pos, typ) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(html)
        sections.append((typ, html[pos:end]))   # 내용은 원본에서 슬라이스(오프셋 보존)
    return sections


def _selected_block_keys(rdir):
    """선택된 스토리라인의 (order,type) 집합 — 스테일/미선택 plan 블록을 반영 판정에서 배제(Codex P2).
    선택 결정/스토리라인이 없으면 None(전체 plan 허용 — back-compat·테스트 픽스처)."""
    dec = _load(os.path.join(rdir, "03-storyboard/outline/decision.json")) or {}
    sel = dec.get("selected")
    if not sel:
        return None
    sl = _load(os.path.join(rdir, "03-storyboard/outline/options", str(sel), "storyline.json"))
    if not isinstance(sl, dict):
        return None
    keys = {(b.get("order"), b.get("type")) for b in (sl.get("blocks") or [])
            if isinstance(b, dict) and b.get("order") is not None and b.get("type")}
    return keys or None


def _evdocs_by_id(rdir):
    """{doc-id: 선언} — 매니페스트(evidence-documents.json). 일반 참조 문서 reflection_points 를
    내용 프로브에 넣기 위함(각주 인용 채널). 없으면 {}."""
    m = _load(os.path.join(rdir, "00-ingest/evidence-documents.json"))
    if not isinstance(m, dict):
        return {}
    return {d["id"]: d for d in (m.get("documents") or []) if isinstance(d, dict) and isinstance(d.get("id"), str)}


def reflected_map(rdir, need):
    """{doc-id: [반영 블록 라벨]} — need(doc-NN) 각각이 최종 산출물의 어느 블록에 반영됐는지(단일 출처).
    반영된 doc 은 라벨 리스트가 비어있지 않다(미반영은 []). 게이트(_reflected_ids)와 export(reflected_in) 공용.
    plan 블록은 '선택된 스토리라인'의 블록으로 한정한다(스테일/미선택 블록 배제 — Codex P2).
    내용 프로브 = test_report: doc-id+판정 카피(target_text) / 일반 참조: doc-id+reflection_points 원문."""
    need = list(need)
    out = {d: [] for d in need}
    need_set = set(need)
    docs_by_id = _evdocs_by_id(rdir)
    pdir = os.path.join(rdir, "03-storyboard/plan")
    plan_files = sorted(glob.glob(os.path.join(pdir, "*.json"))) if os.path.isdir(pdir) else []
    if plan_files:
        allowed = _selected_block_keys(rdir)   # 선택 스토리라인 블록 (order,type); None=전체 허용
        per_doc = {d: [] for d in need}        # {doc: [(label, block_type, {content_probes})]}
        for pf in plan_files:
            b = _load(pf)
            if not isinstance(b, dict):
                continue
            order, typ = b.get("order"), b.get("type")
            if allowed is not None and (order, typ) not in allowed:
                continue   # 스테일/미선택 plan 블록은 반영으로 세지 않음(선택 산출물만 — Codex P2)
            label = ("%02d-%s" % (order, typ)) if isinstance(order, int) else str(typ)
            cited = {}   # {doc: {content_probes}} — 그 블록 섹션 안에서 확인할 내용(판정 카피/doc-id)
            for c in (b.get("claims") or []):
                if not isinstance(c, dict):
                    continue
                # 반영 인정 = doc-NN 을 근거로 인용 + 실제 판정 카피(target_text) 존재. 빈 target_text 는
                #   validate_storyboard 의 판정문 결박도 건너뛰므로(실질 반영 아님) 인정하지 않는다(Codex P2).
                ref, tt = c.get("evidence_ref"), (c.get("target_text") or "").strip()
                if ref in need_set and tt:
                    cited.setdefault(ref, set()).add(tt)   # 내용 프로브 = 판정 카피(target_text). doc-id 는 인용 표식일 뿐 내용 아님.
            for fn in (b.get("footnotes") or []):
                if not isinstance(fn, dict):
                    continue
                # 각주 텍스트의 doc-\d+ 토큰을 '정확히' 매칭(부분문자열 금지 — Codex P3).
                for tok in _DOC_TOKEN_RE.findall(fn.get("text") or ""):
                    if tok in need_set:
                        probes = cited.setdefault(tok, set())
                        # 내용 프로브(doc-id 는 표식일 뿐 내용 아님 — 내용이 살아남아야 반영 인정, Codex):
                        #   test_report=verdict_text 원문 · 일반 참조=reflection_points 원문.
                        _d = docs_by_id.get(tok, {})
                        _vt = (_d.get("verdict_text") or "").strip()
                        if _vt:
                            probes.add(_vt)
                        for p in (_d.get("reflection_points") or []):
                            if p:
                                probes.add(p)
            for did, probes in cited.items():
                per_doc[did].append((label, typ, probes))
        # 최종 선택 키비주얼 HTML 의 '그 반영 블록 섹션 안'에 (a)doc-id 인용[추적성]과 (b)내용 프로브[생존]가
        #   '둘 다' 들어있어야 반영 인정한다 — 빈/일반 섹션·doc-id만·내용만의 거짓 통과 전부 차단(Codex).
        #   선택 HTML 이 아직 없으면(렌더 전 게이트 호출·테스트) plan-only 폴백.
        sections = _selected_html_sections(rdir)
        # 섹션 텍스트는 HTML 엔티티 디코드 후 매칭(카피에 &/< 있으면 렌더 시 &amp;/&lt; 로 이스케이프됨 →
        #   raw 매칭 false-negative 차단, Codex). doc-id 는 '정확 토큰' 매칭(doc-01 ⊂ doc-010 오탐 차단).
        sec_tok = None
        if sections is not None:
            sec_tok = []
            for st, sec in sections:
                dec = html.unescape(sec)
                sec_tok.append((st, dec, set(_DOC_TOKEN_RE.findall(dec))))
        for did, entries in per_doc.items():
            labels = []
            for lab, btype, probes in entries:
                if sec_tok is None:
                    labels.append(lab)
                elif any(st == btype and did in toks and any(p and p in sec for p in probes)
                         for (st, sec, toks) in sec_tok):
                    labels.append(lab)
            seen = set()
            out[did] = [x for x in labels if not (x in seen or seen.add(x))]
        return out
    # plan 단계를 건너뛰는 포맷(one_pager) — 선택 옵션 HTML 에서 doc-NN 인용 확인(폴백).
    dec = _load(os.path.join(rdir, "04-keyvisual/decision.json")) or {}
    sel = dec.get("selected")
    if sel:
        try:
            with open(os.path.join(rdir, "04-keyvisual/options", str(sel), "index.html"), encoding="utf-8") as f:
                html_str = f.read()   # ⚠ 'html' 로 두면 `import html` 모듈을 함수-로컬로 가려 위 html.unescape 가 UnboundLocalError
        except Exception:
            html_str = ""
        dec_html = html.unescape(html_str)
        toks = set(_DOC_TOKEN_RE.findall(dec_html))   # doc-\d+ 정확 토큰(부분문자열 금지)
        for did in need_set:
            if did not in toks:
                continue
            # plan 경로와 동일: doc-id(추적성) + 내용(판정문/반영 포인트 원문) '둘 다' HTML 에 있어야 반영 인정
            #   (doc-id 만으로 통과하던 planless 폴백 강화 — Codex).
            d = docs_by_id.get(did, {})
            _probes = [(d.get("verdict_text") or "").strip()] + [p for p in (d.get("reflection_points") or []) if p]
            if any(p and p in dec_html for p in _probes):
                out[did].append("04-keyvisual/%s" % sel)
    return out


def _reflected_ids(rdir, need):
    """need(doc-NN 집합) 중 최종 산출물에 반영된 id 집합(reflected_map 에서 라벨≥1)."""
    return {d for d, labels in reflected_map(rdir, need).items() if labels}


def _excerpt(s, n=48):
    """근거 문장 발췌(긴 문장은 …로 절단) — 실패 메시지에 '어떤 문장이 어긋났나'를 보여줄 때만 쓴다."""
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[:n] + "…"


def _citation_attempts(rdir, need):
    """진단용(게이트 판정 불변 — reflected_map 과 별개, HTML 섹션 매칭 안 함): plan 블록에서 need(doc-NN)를
    '인용 시도'한 곳 → {doc-id: [(블록라벨, [근거문장 발췌])]}. '반영 안 됨'인 doc 이 실은 plan 에 인용돼 있었는지
    구별해, 'HTML 카피만 고쳐 plan 과 어긋난' 경우(O-6)에 '그 문장'을 짚어 안내하기 위함."""
    need_set = set(need)
    docs_by_id = _evdocs_by_id(rdir)
    pdir = os.path.join(rdir, "03-storyboard/plan")
    plan_files = sorted(glob.glob(os.path.join(pdir, "*.json"))) if os.path.isdir(pdir) else []
    allowed = _selected_block_keys(rdir) if plan_files else None
    out = {d: [] for d in need}
    for pf in plan_files:
        b = _load(pf)
        if not isinstance(b, dict):
            continue
        order, typ = b.get("order"), b.get("type")
        if allowed is not None and (order, typ) not in allowed:
            continue
        label = ("%02d-%s" % (order, typ)) if isinstance(order, int) else str(typ)
        cited = {}
        for c in (b.get("claims") or []):
            if not isinstance(c, dict):
                continue
            ref, tt = c.get("evidence_ref"), (c.get("target_text") or "").strip()
            if ref in need_set and tt:
                cited.setdefault(ref, set()).add(tt)
        for fn in (b.get("footnotes") or []):
            if not isinstance(fn, dict):
                continue
            for tok in _DOC_TOKEN_RE.findall(fn.get("text") or ""):
                if tok in need_set:
                    probes = cited.setdefault(tok, set())
                    _d = docs_by_id.get(tok, {})
                    _vt = (_d.get("verdict_text") or "").strip()
                    if _vt:
                        probes.add(_vt)
                    for p in (_d.get("reflection_points") or []):
                        if p:
                            probes.add(p)
        for did, probes in cited.items():
            out[did].append((label, sorted(probes)))
    return out


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("사용법: check_evidence_reflection.py <run_dir>\n")
        return 2
    rdir = sys.argv[1]
    man = _load(os.path.join(rdir, "00-ingest/evidence-documents.json"))
    if not isinstance(man, dict):
        return 0   # 매니페스트 없음 = 근거 없음 → no-op(골든/동작 불변)
    # G5 백스톱: 미해소(spec_status:pending) 참조 문서가 있으면 done 불가(advance 초크 게이트가 이미 막지만
    #   게이트 우회 시에도 done 도달 차단 — 다중 방어). 00e-evidence 제안·승인으로 pending 을 먼저 해소해야 한다.
    pending = [d["id"] for d in (man.get("documents") or [])
               if isinstance(d, dict) and d.get("spec_status") == "pending" and isinstance(d.get("id"), str)]
    if pending:
        sys.stderr.write(
            "[반영 강제] 미확정(반영 스펙 미정) 참조 문서가 있어 완료할 수 없습니다: %s\n"
            "  → bash scripts/run-stage.sh evidence <run_id> 로 반영할 내용을 제안받아 승인(00e-evidence)한 뒤 진행하세요.\n"
            % ", ".join(pending))
        return 1
    need = [d["id"] for d in (man.get("documents") or [])
            if isinstance(d, dict) and d.get("reflect") is True and isinstance(d.get("id"), str)]
    if not need:
        return 0   # 첨부-전용(reflect:false)만 있으면 반영 의무 없음 → 통과
    reflected = _reflected_ids(rdir, set(need))
    missing = [d for d in need if d not in reflected]
    if missing:
        # O-6: '반영 안 됨'을 두 경우로 갈라 안내한다 —
        #   (A) plan 에 인용돼 있는데 그 근거 문장이 최종 HTML 에 없음 = 심의 통과용으로 HTML 카피만 고쳐 plan 과
        #       어긋난 경우 → '그 문장'을 짚고 'plan 도 같이 고치라' 안내(게이트 완화 아님 — 반영 실효성 유지).
        #   (B) 어디에도 인용 안 됨 → 반영 블록 추가 또는 reflect:false 안내(종전).
        attempts = _citation_attempts(rdir, missing)
        lines = ["[반영 강제] 근거 문서가 최종 산출물(키비주얼 HTML)에 반영되지 않아 완료할 수 없습니다:"]
        for did in missing:
            att = attempts.get(did) or []
            if att:
                where = "; ".join(
                    "%s 블록의 %s" % (lab, "·".join("'%s'" % _excerpt(p) for p in probes) if probes else "(근거 문장)")
                    for lab, probes in att)
                lines.append(
                    "  · %s — 기획안(plan)에는 인용됨(%s)이지만 그 문장이 최종 HTML 에 없습니다. "
                    "표현을 고쳤다면 기획안 블록의 근거 문장(claim target_text)·각주도 '같은 표현'으로 함께 고쳐 주세요 "
                    "(HTML 카피만 바꾸면 기획안과 어긋나 여기서 막힙니다)." % (did, where))
            else:
                lines.append(
                    "  · %s — 어디에도 인용되지 않았습니다. 이 doc-NN 을 인용하는 반영 블록(각주/근거)을 추가하거나, "
                    "evidence/index.json 에 reflect:false(첨부-전용)로 두세요." % did)
        sys.stderr.write("\n".join(lines) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
