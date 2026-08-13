#!/usr/bin/env python3
# build_context.py — LLM 1급 경로용 생성 컨텍스트 조립(K-3①: common.sh build_context 이관).
#   common.sh 의 build_context() 얇은 래퍼가 이 모듈을 호출한다(호출부 인터페이스 보존): build_context <rid> <stage>.
#   입력 파일 경로 + 핵심 근거 요약(REFERENCE_NOTES·claim-basis·voc·evidence 등 라벨)을 조립해 stdout 으로 방출한다.
#   state 는 포함하지 않는다.
#   ⚠ 출력은 바이트 단위로 원본 build_context 와 동일해야 한다(LLM 입력 → 어떤 드리프트도 골든 실패).
#     stub 생성기는 이 경로를 안 타므로 안전망 = tests/test-prompt-assembly.sh(ctx-*.txt 골든 바이트 동일).
import sys, os, json, re

_LIB = os.path.dirname(os.path.abspath(__file__))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

from form_factor import resolve_form_factor as _resolve_form_factor  # noqa: E402  (F2: 제형 고정 서브라인)

HARNESS_ROOT = os.environ.get("HARNESS_ROOT") or os.path.abspath(os.path.join(_LIB, "..", ".."))


# ── 셸 헬퍼 재현(common.sh 와 바이트 동일한 값) ──────────────────────────
def _run_dir(rid):
    return "%s/runs/%s" % (HARNESS_ROOT, rid)


def _state_file(rid):
    return "%s/runs/%s/state.json" % (HARNESS_ROOT, rid)


def _jget(path, dotted):
    """harness.py cmd_jget 와 동일 출력 문자열을 반환. 미존재/exit1(키 없음·로드실패) → None
       (셸의 '2>/dev/null || true' → 빈 캡처와 동형)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    node = data
    for part in dotted.split("."):
        if part == "":
            continue
        m = re.match(r"^(.+)\[(\d+)\]$", part)
        if m:
            try:
                node = node[m.group(1)][int(m.group(2))]
            except Exception:
                return None
        else:
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
    if isinstance(node, (dict, list)):
        return json.dumps(node, ensure_ascii=False)
    elif node is None:
        return "null"
    elif isinstance(node, bool):
        return "true" if node else "false"
    else:
        return str(node)


def _resolve_domain(sf):
    """common.sh resolve_domain: product.regulatory_domain(미선언/null → 빈 값, cosmetic 폴백 폐지)."""
    v = _jget(sf, "product.regulatory_domain")
    if v is None or v == "" or v == "null":
        return ""
    return v


def _reg_query(dom, field):
    """common.sh _reg_query: 검증 레지스트리(load_domain_registry) 조회. 없음/예외 → 빈문자열."""
    try:
        from kcia_engine import load_domain_registry
        e = (load_domain_registry().get("domains", {}) or {}).get(dom) or {}
        v = e.get(field, "")
        return "" if v is None else str(v)
    except Exception:
        return ""


def _pack_fragment_file(dom, fname):
    """packs/<도메인>/<fname> 내용(없으면 None) — 팩 소유 생성 참조 조각 공용 리더.
       전 팩 공통·도메인 중립(cosmetic 하드코딩 없음). **파일 부재 = no-op**(방출 안 함 → ctx 골든
       바이트 불변). PACKS_DIR 은 kcia_engine 단일 출처."""
    if not dom:
        return None
    try:
        from kcia_engine import PACKS_DIR
    except Exception:
        return None
    p = os.path.join(PACKS_DIR, dom, fname)
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _pack_gen_fragment(dom):
    """packs/<도메인>/gen-fragment.md — Seam B 도메인 생성 규칙 조각(부재=no-op)."""
    return _pack_fragment_file(dom, "gen-fragment.md")


def _pack_learned_deny(dom, stage):
    """packs/<도메인>/learned/deny.json 의 '이 단계 적용' 학습 금지어 목록(없으면 []) — Seam F 생성 선차단.
       과거 심의에서 일관 반려돼 사람 승인 승격된 표현을 생성기가 애초에 안 쓰게 한다. **부재 = no-op**(ctx 골든
       불변). applies_to 에 stage 또는 'all' 포함된 kind=deny 만. 전 팩 공통·도메인 중립. PACKS_DIR 단일 출처."""
    if not dom or not stage:
        return []
    try:
        from kcia_engine import PACKS_DIR
    except Exception:
        return []
    p = os.path.join(PACKS_DIR, dom, "learned", "deny.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if not isinstance(data, dict):   # top-level 비-dict([]·"x"·null) 방어 — 파괴 대신 no-op(외부리뷰 High)
        return []
    ents = data.get("entries")
    if not isinstance(ents, list):   # entries 비-list(예 1) → TypeError 방어
        return []
    out = []
    for e in ents:
        if not isinstance(e, dict) or e.get("kind") != "deny":
            continue
        ap = e.get("applies_to")
        if not isinstance(ap, list):   # applies_to 비-list(예 123) 방어 — 'stage in ap' 크래시 차단
            continue
        term = e.get("term")
        if isinstance(term, str) and term and (stage in ap or "all" in ap):   # term 비-string 방어
            out.append(term)
    return out


def _resolve_image_engine():
    """common.sh resolve_image_engine 을 호출부 관점('$(resolve_image_engine 2>/dev/null || echo stub)')에서 재현.
       ⚠ 셸에서 resolve_image_engine 의 die(=exit 1)는 command-substitution 서브셸을 '즉시 종료'하므로
       `|| echo stub` 이 복구하지 못한다 → 평문 할당 `_img_eng="$(...)"` 이 rc1 → set -e 로 build_context 가
       중단된다(빈 엔진도 stub 도 아님). die 메시지는 2>/dev/null 로 삼켜져 무출력이다.
       따라서 죽는 모든 경우(불량 CLI·온라인 명시 stub·온라인 무키)는 stub 으로 강등하지 않고 조용한 nonzero 중단."""
    explicit = os.environ.get("HARNESS_IMAGE_CLI", "")
    cli = explicit if explicit else "nanobanana"
    if cli not in ("nanobanana", "stub"):
        sys.exit(1)                       # 불량 CLI → die(온라인·오프라인 무관, 셸 case 검사가 offline 앞)
    if os.environ.get("HARNESS_OFFLINE", "0") == "1":
        return "stub"                     # 오프라인 = 결정적 stub(정상 경로, 골든 불변)
    if cli == "stub":
        sys.exit(1)                       # 온라인 + 명시 stub → die
    if os.environ.get("NANOBANANA_API_KEY", ""):
        return "nanobanana"               # 온라인 + 키 → 실엔진(정상 경로)
    sys.exit(1)                           # 온라인 + 무키 → die(무음 stub 강등 금지)


def _ls_nonempty(d):
    """[ -d "$d" ] && [ -n "$(ls -A "$d")" ] 동형(디렉터리 존재 + 비어있지 않음, dotfile 포함)."""
    try:
        return os.path.isdir(d) and len(os.listdir(d)) > 0
    except Exception:
        return False


# ── evidence-documents 매니페스트 계열 판정(셸 detection -c 재현) ─────────
def _has_evidence_kind(evman, want_test_report):
    """reflect:true & spec_status!=pending 문서 중 kind==test_report(want_test_report=True) 또는
       kind!=test_report(False) 가 하나라도 있는가."""
    try:
        m = json.load(open(evman))
        def _k(d):
            return d.get("kind") or ("test_report" if d.get("test_report") is not None else "general")
        return any(
            isinstance(d, dict) and d.get("reflect") is True and d.get("spec_status") != "pending"
            and ((_k(d) == "test_report") if want_test_report else (_k(d) != "test_report"))
            for d in (m.get("documents") or [])
        )
    except Exception:
        return False


# ── 인라인 python 조각(원본 로직·순서·공백 그대로 이관) ──────────────────
def _emit_reference_notes(path):
    try:
        n = json.load(open(path))
        for fr in n.get("flow_refs", []):
            if str(fr).strip():
                print("- 플로우: " + str(fr).strip())
        for c in n.get("composition_notes", []):
            if str(c).strip():
                print("- 구도/무드: " + str(c).strip())
        note = (n.get("notes") or "").strip()
        if note:
            print("- 메모: " + note)
    except Exception:
        pass


def _emit_evidence_docs(evman, claim_basis):
    try:
        m = json.load(open(evman))
        # 항목별 승격 레코드 = claim-basis 가 진실 — (source=doc-NN, metric) 키로 매핑. cbid=차트 결박용 근거 id, cbmap=추출 시험이미지.
        cbmap = {}
        cbid = {}
        try:
            cb = json.load(open(claim_basis))
            for e in (cb.get("evidence_on_file") or []):
                if isinstance(e, dict) and e.get("source") is not None and e.get("metric") is not None:
                    _k = (str(e["source"]), str(e["metric"]))
                    if e.get("id"):
                        cbid[_k] = e["id"]
                    if e.get("image_path"):
                        cbmap[_k] = e["image_path"]
        except Exception:
            pass
        for d in (m.get("documents") or []):
            # 미확정(spec_status:pending) 시험성적서는 EVIDENCE_DOCS 로 방출 안 함 — 00e 승인 전 blank/부분 의무가
            #   확정 근거처럼 노출되는 것 차단(REFERENCE_DOCS 와 동형·외부리뷰 3R-3). 승인 후 pending 해소되면 정상 방출.
            if not (isinstance(d, dict) and d.get("reflect") is True) or d.get("spec_status") == "pending":
                continue
            k = d.get("kind") or ("test_report" if d.get("test_report") is not None else "general")
            if k != "test_report":
                continue
            tr = d.get("test_report") or {}
            bits = []
            if tr.get("institution"):
                bits.append(str(tr["institution"]))
            if tr.get("sample_size") is not None:
                bits.append("n=%s" % tr["sample_size"])
            if tr.get("duration"):
                bits.append(str(tr["duration"]))
            if tr.get("method"):
                bits.append(str(tr["method"]))
            mv = tr.get("measured_values")
            items = tr.get("test_items") or []
            kd = "정량(측정값 있음 — 측정 차트)" if (isinstance(mv, dict) or items) else "정성(측정값 없음 — 인증-표시형)"
            print('- %s %s | 판정문(원문): "%s" | %s | %s | 반영 의무'
                  % (d.get("id"), d.get("claim") or "", d.get("verdict_text") or "", "/".join(bits), kd))
            # G-B: 시험 항목별 수치·통계각주·추출 시험이미지 방출(스토리보드가 차트 도출·키비주얼이 <img> 결박).
            for it in items:
                if not isinstance(it, dict):
                    continue
                metric = str(it.get("metric") or "")
                unit = it.get("unit") or ""
                seg = []
                ser = it.get("series") or []
                if ser:
                    seg.append(" → ".join("%s %s" % (s.get("label"), s.get("value")) for s in ser if isinstance(s, dict)))
                if it.get("before") is not None and it.get("after") is not None:
                    seg.append("전 %s → 후 %s" % (it["before"], it["after"]))
                if it.get("change_pct") is not None:
                    seg.append("변화 %s%%" % it["change_pct"])
                line = "    · 시험항목 %s%s: %s" % (metric, ("(%s)" % unit if unit else ""), " / ".join(seg) or "(수치 미상)")
                eid = cbid.get((d.get("id"), metric))
                if eid:
                    line += " | 근거 id(차트 claim 의 evidence_ref 에 이 값을 쓸 것): %s" % eid
                if it.get("stat_note"):
                    line += " | 통계각주: %s" % it["stat_note"]
                img = cbmap.get((d.get("id"), metric))
                if img:
                    line += " | 시험이미지(자사 <img>): %s" % img
                cap = (it.get("image_ref") or {}).get("caption") if isinstance(it.get("image_ref"), dict) else None
                if cap:
                    line += " | 캡션: %s" % cap
                print(line)
    except Exception:
        pass


def _emit_reference_docs(evman):
    try:
        m = json.load(open(evman))
        for d in (m.get("documents") or []):
            if not (isinstance(d, dict) and d.get("reflect") is True):
                continue
            if d.get("spec_status") == "pending":   # G5: 미확정 문서는 라벨 미방출(00e 승인 전까지)
                continue
            k = d.get("kind") or ("test_report" if d.get("test_report") is not None else "general")
            if k == "test_report":
                continue
            pts = [p for p in (d.get("reflection_points") or []) if p]
            print('- %s [%s] %s | 반영 포인트(원문): %s | doc-NN 각주 인용 의무'
                  % (d.get("id"), k, d.get("claim") or "", " ; ".join('"%s"' % p for p in pts)))
    except Exception:
        pass


def _emit_product_facts(voc_pf):
    try:
        v = json.load(open(voc_pf))
        offer = v.get("offer") or {}
        pf = v.get("product_facts") or {}
        out = []
        if offer.get("price"):
            disc = offer.get("discount")
            out.append("- 가격: %d원%s" % (offer["price"], (" (%.2f%% 할인)" % disc if disc else "")))
        pc = pf.get("pack_count")
        if pc:
            out.append("- 매수: %d매" % pc)
        ki = pf.get("key_ingredients") or []
        if ki:
            out.append("- 유효성분 함량: " + ", ".join("%s %s" % (x["name"], x["amount"]) for x in ki))
        comps = pf.get("components") or []
        if comps:
            out.append("- 구성: " + ", ".join(comps))
        if out:
            print("\n".join(out))
        else:
            # 결손 안내(생성기가 '빠진 사실 후크'를 인지 → 절제·보강 권장, 환각 금지). stub 은 build_context 미사용 → 골든 불변.
            print("- (가격·구성·성분 미추출 — 있으면 본문·대표이미지 품질↑; 없으면 일반 문구로 절제, 효능 단정 금지)")
    except Exception:
        pass


def _emit_art_direction(path):
    try:
        a = json.load(open(path))
        print("- master_palette: " + ", ".join(a.get("master_palette", [])))
        print("- color_temp: %s / lighting: %s" % (a.get("color_temp", ""), a.get("lighting", "")))
        print("- typography: %s" % a.get("typography", ""))
        print("- master_reference(자사 자산, 모든 이미지 호출의 첫 입력 = 일관성 1차 레버): %s" % a.get("master_reference", ""))
        mk = a.get("mood_keywords") or []
        if mk:
            print("- mood: " + ", ".join(mk))
    except Exception:
        pass


def _emit_image_manifest(path):
    try:
        m = json.load(open(path))
        for a in m.get("assets", []):
            if a.get("path") and a.get("order") is not None and a.get("type"):
                print("- 블록 %02d-%s → %s" % (a["order"], a["type"], a["path"]))
    except Exception:
        pass


def _emit_image_predictions(pdir, ext, model, domain):
    # 생성 이미지를 만드는 블록 판정은 image_engine._block_emits_image 단일 출처로(드리프트 방지).
    #   임포트 실패 시에만 동일 '유효 술어'로 폴백(임상 차트 chart_data 제외 · html_only 는 규제도메인 제외/그 외 실엔진이면 생성·stub 제외).
    # ⚠ 옛 셸: 이 인라인 python 블록 전체를 `"$PY" - ... <<PYEOF ... PYEOF 2>/dev/null || true` 로 감쌌다 →
    #   손상/불완전 plan JSON(order/type 누락 등)에서 예외가 나면 조용히 삼키고 build_context 는 계속 진행했다
    #   (다음 라벨 REFERENCE_IMAGES/FEEDBACK 로, rc0). in-process 이관 시 무가드 접근이 전체 중단을 유발하므로
    #   동일하게 블록 전체를 감싼다(부분 출력은 예외 전까지 print 된 그대로 보존 — 옛 서브프로세스 flush 와 동형).
    try:
        try:
            from image_engine import _block_emits_image as _emits
        except Exception:
            # H-2: '그래픽 억제' 정책은 image_engine 과 동일하게 팩 소유(domain.json no_graphic_generation)에서 읽는다.
            #   harness 도 부재하면 최후 하드코딩 미러(폴백의 폴백).
            _ng_cache = {}
            def _no_graphic(dom):
                if not dom:
                    return False
                if dom not in _ng_cache:
                    try:
                        from harness import PACKS_DIR as _PDIR, load_json as _lj
                        _v = _lj(os.path.join(_PDIR, dom, "domain.json")).get("no_graphic_generation")
                    except Exception:
                        _v = None
                    # 명시 선언(true/false)=그 값; 미선언(None)/로드실패=보수 폴백셋(fail-safe, fail-open 금지)
                    _ng_cache[dom] = bool(_v) if _v is not None else (dom in {"drug", "quasi_drug", "health_food"})
                return _ng_cache[dom]
            def _emits(b, model=None, domain=None):
                _v = b.get("visual") or {}
                if b.get("type") in ("clinicalEvidence", "beforeAfter") and _v.get("chart_data"):
                    return False
                if _v.get("render_mode") == "html_only":
                    if _no_graphic(domain):
                        return False       # F1(C): 규제도메인 그래픽 블록 미생성(온라인에서도)
                    return bool(model)     # 화장품/미선언: 실엔진(모델명)=생성, stub(""/None)=제외 — image_engine._block_emits_image 와 동일
                return True
        for fn in sorted(os.listdir(pdir)):
            if not fn.endswith(".json"):
                continue
            try:
                b = json.load(open(os.path.join(pdir, fn)))
            except Exception:
                continue
            if not ((b.get("visual") or {}).get("concept")):
                continue
            # 생성 이미지를 안 만드는 블록(임상 차트 chart_data·규제도메인/stub html_only)은 경로 예측에서도 제외 — image_engine 과 동일 유효 술어.
            if not _emits(b, model, domain):
                continue
            print("- 블록 %02d-%s → 04-keyvisual/generated/%02d-%s.%s (생성 예정)" % (b["order"], b["type"], b["order"], b["type"], ext))
    except Exception:
        # 옛 `2>/dev/null || true` 등가 — 손상 plan 의 예외 삼키고 계속(REFERENCE_IMAGES/FEEDBACK 로 진행, rc0).
        pass


def _emit_feedback(path):
    try:
        fb = json.load(open(path))
        for it in fb.get("items", []):
            issue = (it.get("issue") or "").strip()
            if not issue:
                continue
            line = "- " + issue
            tgt = (it.get("target_text") or "").strip()
            if tgt:
                line += " (대상: %s)" % tgt
            alt = (it.get("suggested_alternative") or "")
            if alt:
                line += " (대안: %s)" % alt
            print(line)
    except Exception:
        pass


# ── 조립 본체(common.sh build_context 533~869 라인 그대로) ──────────────
def build_context(rid, stage):
    rdir = _run_dir(rid)
    sf = _state_file(rid)
    print("VOC: %s/00-ingest/voc.json" % rdir)
    print("CLAIM_BASIS: %s/00-ingest/claim-basis.json" % rdir)
    # A-DEF-2 커밋③: 다제품 기획서에서 특정 제품으로 좁히지 못하고 전체를 참고한(unscoped) 근거면 소프트 권고 1줄.
    #   골든 불변: 단제품/스코핑 미발동은 claim-basis 에 product_scope 키가 없으므로(또는 declared) 아무 것도 방출 안 함.
    try:
        _cb = json.load(open(rdir + "/00-ingest/claim-basis.json", encoding="utf-8"))
        if _cb.get("product_scope") == "unscoped":
            print("PRODUCT_SCOPE_ADVISORY: 이 근거는 여러 제품이 함께 적힌 기획서에서 특정 제품으로 좁히지 못하고 전체를 참고했습니다 — 다른 제품의 근거가 섞였을 수 있으니 인용 전 확인이 필요합니다.")
    except Exception:
        pass   # 파일 없음/파싱 실패 시 조용히 스킵(advisory 는 best-effort)
    print("ASSETS_MANIFEST: %s/00-ingest/assets-manifest.json" % rdir)
    # 규제도메인별 룰셋 경로(팩 레지스트리). load_ruleset 와 동일 의미: 등록된 도메인인데 파일 없으면
    #   '잘못된 화장품 룰셋' 노출 금지 → 미제공 노트. 미등록/미선언도 cosmetic 폴백 금지(2부 1단계) → fail-closed 노트.
    dom = _resolve_domain(sf)
    known = _reg_query(dom, "label")
    status = _reg_query(dom, "status")
    abs_path = _reg_query(dom, "ruleset_path")
    print("REGULATORY_DOMAIN: %s" % dom)
    # 산출물 포맷(어떤 구조로 만드나) — 도메인과 직교. M1(G4): 브리프가 포맷-무지였던 갭을 메우려
    #   stage 무관 항상 방출(무해). state 미기재 시 레거시 multipage_bm 폴백(state.schema 와 동일 의미).
    fmt = _jget(sf, "product.deliverable_format")
    if not fmt:
        fmt = "multipage_bm"
    print("DELIVERABLE_FORMAT: %s" % fmt)
    if known and status != "active":
        # 등록됐지만 비활성(tbd/ready-only) — placeholder 파일이 있어도 '미제공' 노트(잘못된 룰셋 노출 금지)
        print("RULESET: (도메인 %s 심의기준 미제공/미활성 — status=%s; 법>가이드라인, 위법 표현 금지)" % (dom, status or "unknown"))
    elif abs_path:
        print("RULESET: %s" % abs_path)
    elif known:
        print("RULESET: (도메인 %s 심의기준 미제공 — 추후 제공)" % dom)
    else:
        # 미등록/미선언 도메인 — cosmetic 룰셋 조용한 폴백 금지(2부 1단계). 심의기준 없음(fail-closed).
        print("RULESET: (도메인 %s 미등록/미선언 — 심의기준 없음; 등록된 팩만 지원)" % (dom or "(미선언)"))
    # DOMAIN_GEN_RULES(Seam B) — 팩 소유 생성 규칙 조각(gen-fragment.md) 선주입: 심의가 일관 집행하는 기지 규칙을
    #   생성기에 미리 흘려 revise 사이클을 줄인다(soft 권고, 법=RULESET 우선). 심의용 critic-fragment 와 별개(미배선).
    #   전 팩 공통·도메인 중립(PACKS_DIR/<dom>/gen-fragment.md). **파일 존재 도메인만 방출 → 부재 팩=무방출(ctx 골든 불변)**.
    #   stub 은 build_context 미사용 → 골든 바이트는 gen-fragment 있는 도메인의 ctx 스냅샷에만 반영.
    _genfrag = _pack_gen_fragment(dom)
    if _genfrag:
        print("DOMAIN_GEN_RULES(도메인 생성 규칙 — 심의 기지 규칙 선주입; soft 권고, 법=RULESET 우선):")
        print(_genfrag.rstrip("\n"))
    # DOMAIN_RTB_GUIDE — 팩 소유 RTB 작성 가이드(rtb-writing-guide.md, 강제 게이트가 아니라 참조 예시).
    #   RTB·키메시지를 저작하는 concept 단계에만 주입(ctx 비대 방지 — 좋은/나쁜 문장 예시가 길다).
    #   부재 팩=무방출(ctx 골든 불변; cosmetic 미저작 → 기존 골든 바이트 불변). 법·근거 하드게이트가 항상 우선.
    if stage == "concept":
        _rtbg = _pack_fragment_file(dom, "rtb-writing-guide.md")
        if _rtbg:
            print("DOMAIN_RTB_GUIDE(도메인 RTB 작성 가이드 — 참조 예시; 법·근거 하드게이트 우선):")
            print(_rtbg.rstrip("\n"))
    # LEARNED_DENY(Seam F) — 과거 심의에서 일관 반려돼 사람 승인 승격된 학습 금지어를 생성 선차단. 부재=무방출(ctx
    #   골든 불변). soft 권고(법=RULESET 우선); 심의-측은 룰셋 lexicon 병합으로 이중 집행(kcia_engine).
    _ldeny = _pack_learned_deny(dom, stage)
    if _ldeny:
        print("LEARNED_DENY(학습된 금지 표현 — 과거 심의에서 일관 반려된 표현; 소비자 카피에 쓰지 말 것):")
        for _t in _ldeny:
            print("- %s" % _t)
    if os.path.isfile(rdir + "/01-brief/brief.json"):
        print("BRIEF: %s/01-brief/brief.json" % rdir)
    if os.path.isfile(rdir + "/02-concept/decision.json"):
        print("CONCEPT_DECISION: %s/02-concept/decision.json" % rdir)
    if os.path.isfile(rdir + "/00-ingest/best-practices.json"):
        print("BEST_PRACTICES: %s/00-ingest/best-practices.json" % rdir)
    # 크롤 참조 노트(REFERENCE_NOTES) — 구 PROJECT_GUIDELINE(유사점 3안 선택) 대체. 현업이 '크롤 중 무엇이 좋았는지' 자유텍스트로 입력한 것.
    #   내용을 인라인(FEEDBACK 패턴)해 스토리라인·아웃라인·이미지 생성이 직접 참조한다. stub 은 build_context 미사용 → 골든 바이트 불변.
    if os.path.isfile(rdir + "/00g-guideline/reference-notes.json"):
        print("REFERENCE_NOTES(크롤 참조 — 스토리라인·아웃라인·이미지에 반영; soft 권고, 법=룰셋 우선):")
        _emit_reference_notes(rdir + "/00g-guideline/reference-notes.json")
    else:
        # 참조 노트 미제공(비슷한 제품 메모 없음) — 생성기가 결손을 인지하게 안내. stub 은 build_context 미사용 → 골든 불변.
        print("REFERENCE_NOTES: (미제공 — 참고할 유사 사례 메모가 없어요; 있으면 스토리라인·구도 품질↑, 없으면 룰셋 우선·절제, 효능 단정 금지)")
    # 반영 근거/참조 문서 라벨(일반화 G3) — 두 계열:
    #   EVIDENCE_DOCS = kind=test_report(실증형 — 판정문 원문 반영·claim-basis 승격, 부분문자열 결박) ·
    #   REFERENCE_DOCS = 그 외 kind(일반 참조 — 반영 포인트를 내용 적합 블록에 원문 반영 + doc-NN '각주' 인용).
    #   헤더는 shell `printf`(test-prompt-contract 라벨 어휘 추출 대상)로, 각 계열 reflect:true 문서가 있을 때만 방출
    #   → no-evidence/해당 kind 부재면 무방출(ctx 골든 바이트 불변). 본문은 python(kind 내부 필터). stub 은 build_context 미사용.
    _evman = rdir + "/00-ingest/evidence-documents.json"
    if os.path.isfile(_evman):
        if _has_evidence_kind(_evman, True):
            print("EVIDENCE_DOCS(첨부 시험성적서 — 판정문 원문 반영 의무; 원문 밖 표현 금지·시험성적서 요소 병기):")
            _emit_evidence_docs(_evman, rdir + "/00-ingest/claim-basis.json")
        if _has_evidence_kind(_evman, False):
            print("REFERENCE_DOCS(첨부 참조 문서 — 반영 포인트를 내용 적합 블록에 원문 반영 + doc-NN 각주 인용 의무; 원문 밖 지어내기 금지):")
            _emit_reference_docs(_evman)
    # WS3+WS4: 제품 사실 후크(가격·구성·성분 함량) — 1급 카피 소재로 제공(효능 단정·최상급 금지).
    #   stub 은 build_context 미사용 → 골든 바이트 불변(실 LLM 재생성에만 반영).
    _voc_pf = rdir + "/00-ingest/voc.json"
    if os.path.isfile(_voc_pf):
        print("PRODUCT_FACTS(가격·구성·성분 함량 — 사실 후크; 효능 단정·최상급 금지):")
        _emit_product_facts(_voc_pf)
        # F2(제형 고정): 정규화된 제품 형태 — 이미지·카피가 제형·용기를 임의 치환하지 않게. COMPUTED(claim-basis
        #   product_type[사람 선언] + voc components → 팩 form_factors 표; 미매칭=선언값 축자, 없으면 무방출).
        #   저장하지 않는다(voc/claim-basis 골든 불변) — 프롬프트에만 실린다. stub 은 build_context 미사용.
        _ff = _resolve_form_factor(rdir, dom)
        if _ff:
            print("- 제품 형태(제형 고정): %s" % _ff)
    # M6(G8): 키비주얼·기획안이 상위 산출물(스토리라인·기획안·참조이미지)을 명시 입력으로 받도록 누적 라벨(조건부, 확정본 존재 시).
    #   stub 은 이 라벨을 무시 → 골든 바이트 불변(실 LLM 재생성에만 반영). H5: 키비주얼이 종합 입력을 받아야 함.
    if os.path.isfile(rdir + "/03-storyboard/outline/decision.json"):
        _ssel = _jget(rdir + "/03-storyboard/outline/decision.json", "selected") or ""
        if _ssel and os.path.isfile("%s/03-storyboard/outline/options/%s/storyline.json" % (rdir, _ssel)):
            print("STORYLINE: %s/03-storyboard/outline/options/%s/storyline.json (확정 스토리라인)" % (rdir, _ssel))
    if _ls_nonempty(rdir + "/03-storyboard/plan"):
        print("STORYBOARD_PLAN: %s/03-storyboard/plan/ (블록별 기획안 NN-<type>.json; 주장-각주·visual.concept)" % rdir)
    # P0-ⓠ(전역 아트디렉션): 기획안 블록·키비주얼이 master_palette/톤/마스터 reference 를 '상속'한다(블록마다 다른 경쟁사 스타일 앵커 = 톤 분열 제거).
    #   stub 은 build_context 미사용 → 골든 바이트 불변(실 LLM 재생성에만 반영).
    if os.path.isfile(rdir + "/03-storyboard/art-direction.json"):
        print("ART_DIRECTION(전역 톤앤매너 — 모든 블록·이미지가 상속; 블록 palette ⊆ master_palette):")
        _emit_art_direction(rdir + "/03-storyboard/art-direction.json")
    # P0-①(생성 이미지 매니페스트): 블록별 생성 PNG/SVG 의 결정적 경로 — 키비주얼 HTML 이 블록 <img src> 로 '우선' 참조(없으면 자사컷→도형박스).
    #   render-design 직전(또는 키비주얼 생성 전) image_engine 이 동일 경로로 생성 → 참조-생성 경로 일치. 자사 생성물(generated/)은 img_lint allowlist 통과.
    if _ls_nonempty(rdir + "/03-storyboard/plan"):
        print("IMAGE_MANIFEST(블록별 생성 이미지 — 키비주얼 <img src> 우선 참조; 자사 생성물 allowlist):")
        if os.path.isfile(rdir + "/04-keyvisual/image-manifest.json"):
            # ★ 실제 매니페스트가 권위(정확한 경로·확장자) — image_engine 이 키비주얼 생성 '전' 선행 실행되므로 보통 존재(외부리뷰 HIGH: 예측 확장자 불일치 차단).
            _emit_image_manifest(rdir + "/04-keyvisual/image-manifest.json")
        else:
            # 매니페스트 부재(예: in-session emit-context — 아직 image_engine 미실행) → 결정적 예측 경로(전이 시 '동일 엔진'으로 생성되어 일치).
            # 유효 술어(RCA 7-2 방식 a)에 넘길 운영 모델·확장자: nanobanana=png+HARNESS_NANOBANANA_MODEL,
            #   stub=svg+""(비-Pro). generate_all 의 `model = _NB_MODEL if engine==nanobanana else None` 과 정합 —
            #   emit-context 예측(HTML 작성 시점)이 실생성과 어긋나 존재성 게이트가 오차단하지 않도록 동일 모델을 쓴다.
            _img_eng = _resolve_image_engine()
            _img_ext = "svg"
            _img_model = ""
            if _img_eng == "nanobanana":
                _img_ext = "png"
                _img_model = os.environ.get("HARNESS_NANOBANANA_MODEL") or "gemini-2.5-flash-image"
            # F1(C): 선언 규제도메인 — 규제도메인(drug/quasi_drug/health_food)은 그래픽 블록 미생성이므로 예측에서도 제외해
            #   실생성(generate_all --domain)과 일치시킨다(불일치 시 insession HTML 이 미생성 PNG 를 참조 → render 존재성 fail).
            _img_domain = _resolve_domain(rdir + "/state.json")   # 미선언 → 빈 값(2부 1단계: cosmetic 폴백 폐지). 실런은 new-run 에서 도메인 강제 선언됨.
            _emit_image_predictions(rdir + "/03-storyboard/plan", _img_ext, _img_model, _img_domain)
    # REFERENCE_IMAGES: 메타 SSoT=00g example-analysis.reference_images(카탈로그). 키비주얼은 plan 의 reference_image_id 로 조인.
    #   ⚠ 분석/참조용 메타일 뿐 — 디자인 <img src> 는 자사 자산만(부록A-4). 카탈로그 경로만 가리킨다(중복 임베드 아님).
    if _ls_nonempty(rdir + "/00g-guideline/examples"):
        print("REFERENCE_IMAGES: %s/00g-guideline/examples/ (example-analysis.json[].reference_images 메타 SSoT; plan reference_image_id 로 조인 — 디자인 src 아님)" % rdir)
    # M3: TONE_DECISION 라벨 제거(tone 서브스테이지 흡수). 구도/무드/참조는 기획안 visual.concept 에 직접 산출.
    # 현업 보완(거절/refine)의 자유텍스트를 프롬프트에 '인라인'한다(generic 한 줄 신호가 아니라 실제 내용).
    #   stub 생성기는 feedback 을 무시하므로 이 인라인은 실엔진(claude) 재생성에만 반영된다.
    # 옛 셸: `_fb="$rdir/$(jget "$(state_file "$rid")" phase)/feedback.json"` — 무가드 jget(2>/dev/null 없음).
    #   jget 은 state.json 부재/손상(load_json 예외) 또는 phase 키 없음(cmd_jget sys.exit(1))에 rc1 → 평문 할당이
    #   rc1 → set -e 로 build_context 중단. 위 resolve_domain/deliverable_format 은 `2>/dev/null || true` 라 관대해
    #   미선언 state.json 도 여기까지 도달한 뒤 이 지점에서 중단한다. (phase=null 은 jget 이 "null" 을 rc0 로 출력
    #   → 중단 아님, _fb=.../null/feedback.json 로 진행 — _jget 도 "null" 문자열 반환으로 동형.)
    _phase = _jget(sf, "phase")
    if _phase is None:                    # 옛 jget rc1(state.json 부재/손상/phase 미키) ⟺ set -e 중단
        sys.exit(1)
    _fb = rdir + "/" + _phase + "/feedback.json"
    if os.path.isfile(_fb):
        print("FEEDBACK(현업 보완 — 반드시 반영):")
        _emit_feedback(_fb)
    return 0


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("사용법: build_context.py <rid> <stage>\n")
        return 1
    build_context(argv[1], argv[2])
    return 0   # 마지막 조건이 false 여도 비0 을 반환하지 않게(원본 build_context 의 `return 0` 보존)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
