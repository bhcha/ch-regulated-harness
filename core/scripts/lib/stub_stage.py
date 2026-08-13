#!/usr/bin/env python3
"""stub_stage.py — 결정적 단계 생성기 (오프라인/CI 경로).

실 LLM 경로(세션 내 claude 생성)와 '동일한 산출물 계약'을 만족하는 결정적 출력.
실입력(voc.json, claim-basis.json)에 근거를 두며, 환각 방지 규칙을 코드로 내장한다:
 - 근거 없는 효능을 컨셉 주축/카피로 쓰지 않는다(emotional/factual 만).
 - claim_strength superlative/efficacy/speed 는 실재 evidence_ref + footnote 가 있을 때만.
 - evidence_on_file 비었으면 clinicalEvidence/beforeAfter 블록 자동 제외(enabled_if).

이식성(a1): 출력은 엔진과 무관하게 구조 동일.
사용법: stub_stage.py <stage> <run_id> <run_dir>
"""
import sys, os, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json, ROOT, PACKS_DIR, FORMATS_DIR, canon_json, is_number as _isnum, sha256_file as _sha256_file, html_escape  # noqa: E402
import openalex as _openalex  # noqa: E402  # B-4: 근거검색 배선(오프라인 결정적 stub = search_stub). import 부작용 0(순수 라이브러리).


def _h(s):
    """HTML escape (인젝션 차단). 현재 stub 텍스트엔 특수문자가 없어 골든 byte 는 불변.
    K-1: 코어는 harness.html_escape(동일 None-guard 시맨틱 → 바이트 불변)."""
    return html_escape(s)

# ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)
# PACKS_DIR·FORMATS_DIR: harness 에서 import (K-1 일원화 — 경로 해석 단일화). ROOT 는 폰트 상대경로(아래)에 여전히 사용.

# 디자인 토큰(accent·톤 방향 시드)은 포맷 팩이 소유(6단계-B): packs/_format/design-tokens.json.
#   도메인 무관·포맷 축. 값은 그대로(산출 바이트 불변) 팩에서 읽는다.
_DESIGN_TOKENS = load_json(os.path.join(FORMATS_DIR, "design-tokens.json"))
ACCENT_DEFAULT = _DESIGN_TOKENS["accent_default"]


# ── 도메인/제품 파생 ──────────────────────────────────────────
# run-stage.sh 가 state 에서 env 로 주입(HARNESS_DOMAIN/HARNESS_PRODUCT_NAME). stub 은 state 파일을
# 직접 읽지 않는다(쓰기 주체 단일화 가드와 정합). 미주입 시 안전 기본값(cosmetic/'제품')으로 폴백.
def _domain():
    d = os.environ.get("HARNESS_DOMAIN")
    if not d:
        raise SystemExit("stub_stage: HARNESS_DOMAIN 미설정 — 규제도메인 선언이 필요합니다(2부 1단계: cosmetic 폴백 폐지). new-run/ingest-bundle 이 선언합니다.")
    return d


def _format():
    # run-stage.sh 가 state.product.deliverable_format 를 env 로 주입(미주입 시 레거시 multipage_bm).
    return os.environ.get("HARNESS_FORMAT") or "multipage_bm"


def _channel():
    """현재 포맷의 채널 프로파일(packs/_format/format-profiles.json[format].channel). 누수#5 제거:
       이전엔 stub 이 naver_smartstore/860px 를 하드코딩 → 포맷이 달라도 BM 채널을 강제했다. 이제 포맷별 채널을 데이터에서 읽는다.
       미정의 포맷/필드는 레거시(naver_smartstore 860) 폴백 → multipage_bm 출력 바이트 불변.
       (포맷별 블록 시퀀스(CANON) format-aware 생성은 M7 — 현재 one_pager 는 03 스킵이라 잠재 누수.)"""
    ch = {}
    try:
        fp = load_json(os.path.join(FORMATS_DIR, "format-profiles.json"))
        ch = ((fp.get("formats", {}) or {}).get(_format(), {}) or {}).get("channel") or {}
    except Exception:
        ch = {}
    return {"name": ch.get("name", "naver_smartstore"),
            "width_px": ch.get("width_px", 860),
            "max_height_px": ch.get("max_height_px", 5000),
            "gif_allowed": ch.get("gif_allowed", True)}


def _is_cosmetic():
    return _domain() == "cosmetic"


_STUB_TMPL_CACHE = {}


def _stub_tmpl():
    """도메인 stub 콘텐츠 템플릿(packs/<도메인>/stub-templates/content.json). 화장품-전용 표시 리터럴
    (기능성 라벨·추천 근거·법정 km 접미)을 팩이 소유 → core 도메인 어휘 소거·산출 바이트 불변.
    화장품 경로에서만 호출된다(비화장품은 functional_status/approved 비어 이 리터럴에 도달 안 함)."""
    dom = _domain()
    if dom not in _STUB_TMPL_CACHE:
        _STUB_TMPL_CACHE[dom] = load_json(os.path.join(PACKS_DIR, dom, "stub-templates", "content.json"))
    return _STUB_TMPL_CACHE[dom]


def _product_name():
    return os.environ.get("HARNESS_PRODUCT_NAME") or "제품"


def _brand():
    """제품명 앞 '[브랜드 ...]' 접두에서 브랜드 파생(없으면 ''=브랜드 배너 생략/면제). 하드코딩 브랜드 제거."""
    m = re.match(r"\s*\[([^\]]+)\]", _product_name())
    toks = m.group(1).split() if m else []
    return toks[0] if toks else ""


def _noun():
    """헤드라인용 짧은 제품 명사. 화장품(레퍼런스 샘플)=쿠션, 그 외 도메인=중립 '제품'."""
    return _stub_tmpl()["noun"] if _is_cosmetic() else "제품"


def ingest(rdir):
    voc = load_json(os.path.join(rdir, "00-ingest", "voc.json"))
    cb = load_json(os.path.join(rdir, "00-ingest", "claim-basis.json"))
    return voc, cb


def top_keywords(voc, n=4):
    kf = voc["keyword_frequency"]
    return [k for k, v in sorted(kf.items(), key=lambda x: -x[1]) if v > 0][:n]


def zero_keywords(voc):
    return [k for k, v in voc["keyword_frequency"].items() if v == 0]


# ───────────────────────── brief ─────────────────────────
def _confirmed_guideline(rdir):
    """(파기) 구 '유사점 3안 확정'은 제거됨 — 00g 는 이제 크롤 참조 노트(reference-notes)로 캡처되고
       다운스트림(스토리라인·아웃라인·이미지)이 build_context REFERENCE_NOTES 로 직접 참조한다(브리프 미경유).
       브리프 스키마의 confirmed_guideline 은 optional(후방호환)로 남되 stub 은 더 이상 채우지 않는다."""
    return None


def gen_brief(rdir):
    voc, cb = ingest(rdir)
    top = top_keywords(voc)
    phrase = top[0] if top else _noun()
    out = os.path.join(rdir, "01-brief")
    os.makedirs(out, exist_ok=True)

    quotes = [{"type": "customer", "text": "%s 좋고 자연스러워요" % k, "voc_phrase": k} for k in top[:3]]
    sensitive = []
    for key, v in cb["functional_status"].items():
        label = _stub_tmpl()["functional_labels"][key]
        sensitive.append({"label": label, "basis": v["evidence_ref"], "status": v["status"]})
    for w in cb.get("unsupported_claims", []):
        sensitive.append({"label": w, "basis": None, "status": "unsupported"})

    brief = {
        "pr": {
            "headline": "매일 손이 가는 %s — 자연스러운 데일리 %s" % (phrase, _noun()),
            "subhead": "본인 사용 + 가족 선물(가설) 가설 페르소나, VOC 빈도 기반",
            "problem": "소비자는 효능보다 '%s' 같은 사용 경험으로 제품을 평가한다(voc.json 근거)." % ", ".join(top),
            "solution": {
                "differentiators": ["데일리 %s감" % phrase, _stub_tmpl()["brief_differentiator_1"] if _is_cosmetic() else "신뢰할 수 있는 구성"],
                "today_alternatives": _stub_tmpl()["brief_today_alternatives"] if _is_cosmetic() else ["기존 대안 제품", "직접 비교 대상"],
            },
            "quotes": quotes,
        },
        "faq": {
            "external": [{"q": "구성은?", "a": _stub_tmpl()["faq_external_answer"] if _is_cosmetic() else "제품 구성·함량은 제품 표기·첨부문서를 확인하세요."}],
            "internal": [
                {"q": "규제/실증 리스크?", "a": "기능성 상태=unknown 항목은 주장 불가. 속효('단 1일') 표현 금지. 절대표현(최초/1위/무결점) 금지."},
                {"q": "근거 없는 효능 주장?", "a": "claim-basis 근거 없는 효능(%s)은 unsupported로 카피 배제." % (", ".join(cb.get("unsupported_claims", [])) or "없음")},
                {"q": "VOC 0건 개념?", "a": "%s 는 리뷰 0건 → 컨셉 주축 금지." % (", ".join(zero_keywords(voc)) or "없음")},
            ],
        },
        "sensitive_labels": sensitive,
        # M1(G4): ⓪ 선언 2축(도메인×포맷)을 브리프 산출물이 자기 안에 담는다(포맷-인지).
        "output_type": {"regulatory_domain": _domain(), "deliverable_format": _format()},
    }
    cg = _confirmed_guideline(rdir)
    if cg:
        brief["confirmed_guideline"] = cg
    atomic_write_json(os.path.join(out, "brief.json"), brief)
    _write_brief_md(out, brief)


def _write_brief_md(out, brief):
    pr = brief["pr"]
    lines = ["# 브리프 (PR/FAQ)\n\n", "## PR\n", "- **헤드라인**: %s\n" % pr["headline"],
             "- **서브헤드**: %s\n" % pr["subhead"], "- **문제**: %s\n" % pr["problem"],
             "- **차별점**: %s\n" % ", ".join(pr["solution"]["differentiators"]),
             "\n## 고객 인용(VOC)\n"]
    for q in pr["quotes"]:
        lines.append("- \"%s\" _(voc: %s)_\n" % (q["text"], q["voc_phrase"]))
    lines.append("\n## 내부 FAQ — 규제/실증 리스크\n")
    for qa in brief["faq"]["internal"]:
        lines.append("- **%s** %s\n" % (qa["q"], qa["a"]))
    lines.append("\n## 민감 표시 확인 대상 (사람 게이트)\n")
    for s in brief["sensitive_labels"]:
        lines.append("- %s — 상태: **%s**%s\n" % (s["label"], s["status"], (" (근거 %s)" % s["basis"]) if s["basis"] else ""))
    with open(os.path.join(out, "brief.md"), "w", encoding="utf-8") as f:
        f.write("".join(lines))


# ───────────────────────── concept ─────────────────────────
# A-efficacy·C-science 는 두 도메인 공통(공유). B 슬롯만 도메인 분기: 화장품=감성축(B-emotional, 팩 소유
#   packs/cosmetic/stub-templates), 그 외=안전성·정보축(B_SAFETY, 도메인-중립 core 기본값). — 5단계-B.
AXES = [
    {"id": "A-efficacy", "label": "효능 중심", "angle": "기능성 승인·실증 근거 한정 효능(없으면 제품 사실로 절제)"},
    {"id": "C-science", "label": "성분·과학", "angle": "고시성분/구성의 사실적 설명"},
]
# 비화장품(의약품 등 광고 제한·소비자 리뷰 없음) 도메인: 감성·VOC 축(B-emotional)은
#   VOC(keyword_frequency)에 전적으로 의존해 리뷰 0건이면 빈 산출물→스키마(minItems:1) 위반.
#   따라서 도메인-aware 로 안전성·정보 축(B-safety, VOC 비의존)으로 치환한다(restricted 광고 정합).
B_SAFETY = {"id": "B-safety", "label": "안전성·정보", "angle": "허가사항·복약·주의 정보 기반(감성·VOC 비의존)"}


def _axes():
    """도메인-aware 축 세트. 화장품=감성축(B-emotional, 팩 소유), 그 외=안전성·정보축(B-safety)."""
    b_axis = _stub_tmpl()["axis_b_emotional"] if _is_cosmetic() else B_SAFETY
    return [AXES[0], b_axis, AXES[1]]


def gen_concept_axes(rdir):
    """① 축 정의만 (독립 생성의 1단계)."""
    out = os.path.join(rdir, "02-concept")
    os.makedirs(out, exist_ok=True)
    atomic_write_json(os.path.join(out, "concept-axes.json"), {"axes": _axes()})


def gen_concept_option(rdir, axis_id):
    """② 한 축만 생성 (축별 독립 호출). mode collapse 방지."""
    voc, cb = ingest(rdir)
    top = top_keywords(voc)
    approved = {k: v for k, v in cb["functional_status"].items() if v["status"] == "approved"}
    odir = os.path.join(rdir, "02-concept", "options", axis_id)
    os.makedirs(odir, exist_ok=True)
    rtb, km = _concept_axis_content(axis_id, top, approved, cb)
    atomic_write_json(os.path.join(odir, "rtb.json"), {"concept_axis": axis_id, "rtb": rtb})
    atomic_write_json(os.path.join(odir, "key-message.json"), {"concept_axis": axis_id, "key_messages": km})


def gen_concept_reco(rdir):
    """③ pairwise 추천 (통과 가능안 비교)."""
    voc, _ = ingest(rdir)
    top = top_keywords(voc)
    out = os.path.join(rdir, "02-concept")
    # 실제 존재하는 옵션만 ranked 에 (render/select 와 정합 — 외부리뷰 #8)
    odir = os.path.join(out, "options")
    existing = sorted(os.listdir(odir)) if os.path.isdir(odir) else []
    if _is_cosmetic():
        pref = _stub_tmpl()["reco_pref"]
        rationale = _stub_tmpl()["reco_rationale"] % ", ".join(top)
    else:
        # 비화장품(광고 제한·리뷰 없음): 감성 VOC 축 미적용. 허가 효능(A)·안전성 정보(B-safety) 우선.
        pref = ["A-efficacy", "B-safety", "C-science"]
        rationale = ("허가 효능·효과(A)를 top-1, 안전성·복약 정보(B-safety)·성분/기전(C)을 보조축으로 한다. "
                     "리뷰 0건·광고 제한 도메인이라 감성 VOC 축은 적용하지 않는다(근거 없는 효능·감성 단정 금지).")
    ranked = [a for a in pref if a in existing] + [a for a in existing if a not in pref]
    atomic_write_json(os.path.join(out, "recommendation.json"), {"ranked": ranked, "rationale": rationale})


def gen_concept(rdir):
    """오케스트레이터(오프라인): 축 → 축별 독립 생성 → 추천. run-stage 가 단계별로 호출하기도 함."""
    gen_concept_axes(rdir)
    for ax in _axes():
        gen_concept_option(rdir, ax["id"])
    gen_concept_reco(rdir)


def _concept_axis_content(axis_id, top, approved, cb):
    rtb, km = [], []
    if axis_id == "B-emotional":
        for i, k in enumerate(top[:3], 1):
            rtb.append({"id": "rtb-%d" % i, "claim": _stub_tmpl()["axis_b_emotional_rtb"] % k,
                        "claim_strength": "emotional", "evidence_ref": None,
                        "functional_basis": None, "review_status": "pending"})
            km.append({"id": "km-%d" % i, "slot": "emotional", "headline": _stub_tmpl()["axis_b_emotional_km"] % k,
                       "voc_phrase": k, "claim_strength": "emotional",
                       "evidence_ref": None, "functional_basis": None, "review_status": "pending"})
    elif axis_id == "B-safety":
        # 안전성·정보 축(비화장품·restricted 광고): 허가사항·복약·주의 기반. VOC 비의존 → 항상 ≥1, 효능 단정 없음.
        rtb.append({"id": "rtb-1", "claim": "허가사항(효능·효과·용법·용량)에 따라 사용하는 제품",
                    "claim_strength": "factual", "evidence_ref": None,
                    "functional_basis": None, "review_status": "pending"})
        rtb.append({"id": "rtb-2", "claim": "사용 전 첨부문서·사용상 주의사항을 확인",
                    "claim_strength": "factual", "evidence_ref": None,
                    "functional_basis": None, "review_status": "pending"})
        km.append({"id": "km-1", "slot": "legal", "headline": "허가사항·복약 정보를 먼저 확인하세요",
                   "voc_phrase": None, "claim_strength": "factual",
                   "evidence_ref": None, "functional_basis": None, "review_status": "pending"})
    elif axis_id == "A-efficacy":
        # 효능 슬롯은 approved 기능성만. 없으면 제품 사실(factual)로 절제.
        if approved:
            for i, (key, v) in enumerate(approved.items(), 1):
                rtb.append({"id": "rtb-%d" % i, "claim": "%s 기능성 표시(법정)" % key,
                            "claim_strength": "factual", "evidence_ref": v["evidence_ref"],
                            "functional_basis": "%s:approved" % key, "review_status": "pending"})
                km.append({"id": "km-legal-%d" % i, "slot": "legal", "headline": "%s %s" % (key, _stub_tmpl()["legal_km_headline_suffix"]),
                           "voc_phrase": None, "claim_strength": "factual",
                           "evidence_ref": v["evidence_ref"], "functional_basis": "%s:approved" % key,
                           "review_status": "pending"})
        else:
            _fallback = top[0] if top else _noun()
            _claim = _stub_tmpl()["axis_a_fallback_claim"] if _is_cosmetic() else "제품을 사실 그대로 절제하여 전달한다"
            _head = _stub_tmpl()["axis_a_fallback_head"] % _fallback if _is_cosmetic() else "%s 중심" % _fallback
            rtb.append({"id": "rtb-1", "claim": _claim,
                        "claim_strength": "factual", "evidence_ref": None,
                        "functional_basis": None, "review_status": "pending"})
            # 비화장품(VOC 없음)은 감성 슬롯 대신 legal 슬롯(voc_phrase 불요) — 감성슬롯은 실재 VOC 인용을 심의가 강제.
            km.append({"id": "km-1",
                       "slot": "emotional" if _is_cosmetic() else "legal",
                       "headline": _head,
                       "voc_phrase": _fallback if _is_cosmetic() else None,
                       "claim_strength": "factual",
                       "evidence_ref": None, "functional_basis": None, "review_status": "pending"})
    else:  # C-science
        ings = [n["name"] for n in cb.get("notified_ingredients", [])]
        if not ings:
            ings = ["베이스 성분"]
        for i, n in enumerate(ings[:2], 1):
            rtb.append({"id": "rtb-%d" % i, "claim": "%s 함유(성분 사실)" % n,
                        "claim_strength": "factual", "evidence_ref": None,
                        "functional_basis": None, "review_status": "pending"})
        km.append({"id": "km-1", "slot": "legal", "headline": "성분을 사실 그대로",
                   "voc_phrase": None, "claim_strength": "factual",
                   "evidence_ref": None, "functional_basis": None, "review_status": "pending"})
    return rtb, km


# ───────────────────── storyboard-outline ─────────────────────
# 캐논 정본 = packs/_format/<format>/canon.json(4단계, SSoT 1개). blocks 시퀀스(포맷별 intent/risk_tier/evidence_required —
#   스텁이 storyline.json 으로 방출)·evidence_gated(clinicalEvidence/beforeAfter)·brand_gated(brandBanner, 브랜드 미선언 시
#   자동 제외 — 하드코딩 배너 강제 금지) 를 담는다. 미정의 포맷 → multipage_bm 폴백(현행 CANON_BY_FORMAT 폴백과 동형).
def _load_canon(fmt, dom=None):
    """캐논 로드 — harness.canon_json 위임(포맷 정본 + 도메인 오버레이 병합).
    dom 미지정/오버레이 부재 = 포맷 정본 그대로(기존 도메인 바이트 불변; 예 drug=교육콘텐츠 캐논)."""
    c = canon_json(fmt, dom)
    seq = [(b["type"], b["intent"], b["risk_tier"], bool(b.get("evidence_required", False))) for b in c["blocks"]]
    return seq, set(c.get("evidence_gated") or []), set(c.get("brand_gated") or [])


# 게이팅 집합은 포맷-불변(clinicalEvidence/beforeAfter · brandBanner) → 캐논 정본에서 로드(모듈 상수 소거).
_, EVIDENCE_GATED, BRAND_GATED = _load_canon("multipage_bm")


def _variant_seq(canon, opt):
    """A/B/C 3안의 전개 순서(이슈3a: 최소 3안). A=대안 전개(앞 후크 2블록 swap), B=기본 순서, C=근거/솔루션 선행(다른 배치).
       multipage: A=problem(idx2)을 socialProof(idx1) 앞으로(swap idx1↔idx2). C=solution(idx3)을 앞쪽으로(다른 후크 전략)."""
    seq = list(canon)
    if opt == "A" and len(seq) >= 3:
        seq = [seq[0], seq[2], seq[1]] + seq[3:]
    elif opt == "C" and len(seq) >= 4:
        seq = [seq[0], seq[3], seq[1], seq[2]] + seq[4:]   # 솔루션/근거 선행 변주(A·B 와 구별되는 3안)
    return seq


def _build_blocks(seq, has_evidence, has_brand=True, has_quant=False):
    blocks = []
    o = 1
    for (typ, intent, risk, ev_req) in seq:
        if typ == "beforeAfter" and not has_quant:
            continue  # 전후대비는 '측정 전/후' 정량 근거가 있을 때만(정성 인증만 있으면 제외 — 환각 대비 차단)
        if typ in EVIDENCE_GATED and not has_evidence:
            continue  # enabled_if: 실증 미등록 → 자동 제외 (환각 차단)
        if typ in BRAND_GATED and not has_brand:
            continue  # 브랜드 미선언 → 브랜드 배너 자동 제외(브랜드 종속 제거)
        blk = {"order": o, "type": typ, "intent": intent, "risk_tier": risk}
        if ev_req:
            blk["evidence_required"] = True
        if typ in EVIDENCE_GATED:
            blk["enabled_if"] = "claim-basis.evidence_on_file != []"
        blocks.append(blk)
        o += 1
    return blocks


def gen_storyboard_outline(rdir):
    voc, cb = ingest(rdir)
    has_evidence = len(cb["evidence_on_file"]) > 0
    # 정량(측정 전/후 쌍) 근거 유무 — beforeAfter(측정 대비 블록) 게이팅용. 정성-only 근거면 beforeAfter 제외.
    # _isnum: harness.is_number 를 모듈-레벨 import (_isnum 별칭, K-1 일원화)
    has_quant = any(isinstance(e, dict) and _isnum(e.get("before")) and _isnum(e.get("after"))
                    for e in cb.get("evidence_on_file", []))
    has_brand = bool(_brand())   # 제품명에 '[브랜드 …]' 접두가 있을 때만 브랜드 배너 포함
    out = os.path.join(rdir, "03-storyboard")
    profile = _channel()   # 누수#5: 포맷별 채널을 format-profiles 에서(하드코딩 제거). multipage_bm=naver_smartstore/860(불변).
    canon = _load_canon(_format(), _domain())[0]   # M7/4단계: 포맷별 캐논 정본 + 도메인 오버레이(예: drug 교육콘텐츠 캐논; 오버레이 없는 도메인=포맷 정본 그대로)
    for opt in ("A", "B", "C"):   # 이슈3a: 최소 3안
        odir = os.path.join(out, "outline", "options", opt)
        os.makedirs(odir, exist_ok=True)
        atomic_write_json(os.path.join(odir, "storyline.json"),
                          {"channel_profile": profile, "blocks": _build_blocks(_variant_seq(canon, opt), has_evidence, has_brand, has_quant)})
    # sources (수동 mock): 선택 컨셉 카피에서 실증 트리거를 결정적으로 감지해 query 에 기록(#5).
    sdir = os.path.join(out, "sources")
    os.makedirs(sdir, exist_ok=True)
    triggers = _detect_triggers(rdir)
    claim = triggers[0] if triggers else None
    atomic_write_json(os.path.join(sdir, "query.json"),
                      {"claim": claim, "triggers": triggers,
                       "filters": {"grade": ["SCI/SCIE", "전문학회지"], "lang": ["ko", "en"]}, "limit": 5})
    # 안전 카피는 트리거 미발생 → 빈 결과/불충분. 실증 필요 시 사람이 수동으로 results 를 채운다.
    # B-4 배선: 오프라인 결정적 stub = openalex.search_stub(engine="manual"). 빈결과 기본 + evidence_sufficient=false 라
    #   반환 dict 는 {"results": [], "evidence_sufficient": False, "engine": "manual"} — 종전 하드코딩과 바이트 동일(골든 불변).
    #   온라인 실검색(engine:openalex)은 run-stage.sh 의 STUB_MODE!=1 단계(evidence_search.py)가 이 mock 을 덮어쓴다.
    atomic_write_json(os.path.join(sdir, "results.json"),
                      _openalex.search_stub(claim, engine="manual"))
    atomic_write_json(os.path.join(out, "outline", "recommendation.json"),
                      {"ranked": ["A", "B", "C"], "rationale": "문제공감 선행(A)이 VOC 고민 환기와 자연스럽게 연결. B=기본 순서, C=솔루션/근거 선행 변주."})


# ───────────────────── 기본 톤 스타일(M3: tone 흡수 — 기획안 visual.concept 의 palette/typography/mood 기본값) ─────────────────────
# 페이지 전체 톤&매너 방향 3안. 스캔되는 텍스트(mood/composition/handoff/direction)는
# 효능·절대·권위 암시어가 전혀 없는 '중립 디렉션'만 — kcia scan_text 가 통과해야 한다.
# 톤 방향 3안 = 포맷 디자인 토큰(6단계-B): packs/_format/design-tokens.json 이 소유(값 불변).
#   스캔되는 텍스트(mood/composition/handoff/direction)는 효능·절대·권위 암시어가 없는 '중립 디렉션'만.
TONE_DIRECTIONS = _DESIGN_TOKENS["tone_directions"]
# _write_html 의 PRODUCT_BLOCKS 와 동일 의미(자사 제품컷 우선 슬롯). 골든 보존 위해 별도 상수로 둠.
TONE_PRODUCT_BLOCKS = {"hero", "colorSwatch", "ingredientTech", "solution"}
_COMPOSITION_DEFAULT = "정면 중앙 배치, 여백 확보"
_DIRECTION_DEFAULT = "제품을 명확히 보여주는 정돈된 구도"


def _own_assets(rdir):
    am = load_json(os.path.join(rdir, "00-ingest", "assets-manifest.json"))
    files = [o["path"] for o in am["own_assets"]["files"]]
    product = next((p for p in files if "product" in p.lower()), None)
    svgs = [p for p in files if "product" not in p.lower()] or files
    return product, svgs


def _own_asset_for_block(product, svgs, order, typ):
    if product and typ in TONE_PRODUCT_BLOCKS:
        return product
    if svgs:
        return svgs[(int(order) - 1) % len(svgs)]
    return product or "inputs/assets/product-main.jpg"


def _bp_blocks(rdir):
    """best-practices.json(있으면) → {block_type: block}. 없으면 빈 dict(폴백)."""
    p = os.path.join(rdir, "00-ingest", "best-practices.json")
    if not os.path.exists(p):
        return {}
    return {b["block_type"]: b for b in load_json(p).get("blocks", [])}


# M3: tone 서브스테이지 흡수 — 기획안 블록 visual.concept 를 직접 산출(별도 톤 선택·N안 비교 없음).
#   기본 스타일(palette/typography/mood) = TONE_DIRECTIONS[0](결정적 기본 톤). 실 LLM 경로는
#   prompts/storyboard-plan.md 가 블록별 구도/무드/참조를 직접 산출한다. tone-direction(s).schema 는 후방호환 보존.
_DEFAULT_STYLE = TONE_DIRECTIONS[0]


# ───────────────────── 전역 아트디렉션(P0-ⓠ: 톤 일관성 선결 조건) ─────────────────────
def _art_direction(rdir):
    """현재 run 의 전역 아트디렉션(03-storyboard/art-direction.json). 없으면 기본 톤(_DEFAULT_STYLE)에서 파생.
       블록 visual.concept 가 이 master_palette/color_temp/lighting/typography 를 상속 → 블록마다 다른
       경쟁사 스타일에 앵커되던 분열 제거. stub 기본값 = _DEFAULT_STYLE 이므로 기존 plan 블록 바이트 불변."""
    p = os.path.join(rdir, "03-storyboard", "art-direction.json")
    if os.path.exists(p):
        try:
            return load_json(p)
        except Exception:
            pass
    product, _svgs = _own_assets(rdir)
    return {
        "master_palette": _DEFAULT_STYLE["palette"],
        "color_temp": _DEFAULT_STYLE["mood"]["color_temp"],
        "lighting": _DEFAULT_STYLE["mood"]["lighting"],
        "typography": _DEFAULT_STYLE["typography"],
        "master_reference": product or "inputs/assets/product-main.jpg",
    }


def gen_art_direction(rdir):
    """전역 아트디렉션 1회 생성(블록보다 먼저). 마스터 팔레트·색온도·라이팅·타이포·마스터 제품 reference.
       master_reference = 자사 제품컷(모든 블록 이미지 호출의 공통 첫 입력 = 일관성 1차 레버)."""
    product, _svgs = _own_assets(rdir)
    out = os.path.join(rdir, "03-storyboard")
    os.makedirs(out, exist_ok=True)
    ad = {
        "master_palette": _DEFAULT_STYLE["palette"],
        "color_temp": _DEFAULT_STYLE["mood"]["color_temp"],
        "lighting": _DEFAULT_STYLE["mood"]["lighting"],
        "typography": _DEFAULT_STYLE["typography"],
        "master_reference": product or "inputs/assets/product-main.jpg",
        "mood_keywords": ["데일리", "정돈된"],
        "notes": "전 블록 공통 톤앤매너(브랜드킷). 블록은 composition·subject·aspect_ratio 등 고유만 둔다.",
    }
    atomic_write_json(os.path.join(out, "art-direction.json"), ad)


def _build_concept(rdir, order, typ):
    """기획안 블록의 visual.concept(구도/무드/팔레트/참조)를 직접 구성(tone 흡수).
       palette·mood·typography 는 전역 아트디렉션(art-direction.json)에서 상속(블록 분열 방지, P0-ⓠ).
       composition=크롤 베스트프랙티스(있으면)·기본, reference=자사컷 + bp 방향(픽셀 미전송)."""
    product, svgs = _own_assets(rdir)
    bp = _bp_blocks(rdir)
    bpb = bp.get(typ)
    direction = bpb["composition_note"] if bpb else _DIRECTION_DEFAULT
    ad = _art_direction(rdir)   # 전역 상속(master_palette ⊇ 블록 palette 가 항상 성립)
    return {
        "subject": "%s 제품컷" % _product_name(),
        "composition": _COMPOSITION_DEFAULT,
        "mood": {"color_temp": ad.get("color_temp", _DEFAULT_STYLE["mood"]["color_temp"]),
                 "lighting": ad.get("lighting", _DEFAULT_STYLE["mood"]["lighting"]),
                 "texture": _DEFAULT_STYLE["mood"]["texture"]},
        "palette": ad.get("master_palette", _DEFAULT_STYLE["palette"]),
        "typography": ad.get("typography", _DEFAULT_STYLE["typography"]),
        "aspect_ratio": "1:1",
        "handoff_note": "누끼 경계 깔끔하게, 그림자 자연스럽게",
        "reference": {
            "own_asset_path": _own_asset_for_block(product, svgs, order, typ),
            "direction": direction,
            "crawl_pattern_ref": ("bp:%s" % typ) if bpb else None,
            "pixel_reference_allowed": False,
        },
    }


# ───────────────────── storyboard-plan ─────────────────────
RULE_TRIGGERS = ["안티에이징", "콜라겐", "항균", "수분", "다크서클", "탄력", "모공", "멜라닌", "색소침착", "여드름"]


def _detect_triggers(rdir):
    """선택 컨셉 카피에서 실증 트리거 표현을 결정적으로 감지(#5)."""
    found = []
    cdir = os.path.join(rdir, "02-concept")
    dec = os.path.join(cdir, "decision.json")
    opts = []
    if os.path.exists(dec):
        opts = [load_json(dec)["selected"]]
    elif os.path.isdir(os.path.join(cdir, "options")):
        opts = sorted(os.listdir(os.path.join(cdir, "options")))
    for opt in opts:
        for f in ("rtb.json", "key-message.json"):
            p = os.path.join(cdir, "options", opt, f)
            if os.path.exists(p):
                txt = open(p, encoding="utf-8").read()
                for t in RULE_TRIGGERS:
                    if t in txt and t not in found:
                        found.append(t)
    return found


def _selected_storyline(rdir):
    out = os.path.join(rdir, "03-storyboard")
    sel = "A"
    dec = os.path.join(out, "outline", "decision.json")
    if os.path.exists(dec):
        sel = load_json(dec)["selected"]
    return load_json(os.path.join(out, "outline", "options", sel, "storyline.json"))


def _reflect_evdocs(rdir):
    """{doc-id: 선언} — reflect:true 근거 문서(매니페스트). 없으면 {}. 오프라인 stub 이 반영 블록을
    결정적으로 생성하기 위한 verdict_text·시험성적서 원천(claim-basis 엔 verdict_text 가 없으므로)."""
    p = os.path.join(rdir, "00-ingest", "evidence-documents.json")
    if not os.path.exists(p):
        return {}
    try:
        docs = load_json(p).get("documents") or []
    except Exception:
        return {}
    return {d["id"]: d for d in docs if isinstance(d, dict) and d.get("reflect") is True and d.get("id")}


# 일반 참조 문서(kind!=test_report) 반영 블록 매핑 — 내용 적합 블록에 각주 인용 + 반영 포인트 원문 주입(오프라인 stub).
_GENERAL_REFLECT_BLOCK = {
    "brand_story": "brandBanner", "ingredient_dossier": "ingredientTech", "certification": "socialProof",
    "guide": "howToUse", "paper": "ingredientTech", "patent": "ingredientTech", "general": "brandBanner",
}
# 매핑 블록이 스토리라인에 없을 때 폴백 순서(존재하는 첫 블록에 반영 — 반영 누락으로 done 불가한 상황 방지).
_GENERAL_FALLBACK_ORDER = ["ingredientTech", "brandBanner", "rtbSummary", "socialProof", "solution", "targetAudience", "howToUse"]


def _general_target_block(kind, present_types):
    """일반 참조 문서 반영 블록 결정: 매핑 블록이 스토리라인에 있으면 그것, 없으면 폴백(존재하는 첫 적합 블록,
    그것도 없으면 hero 를 제외한 첫 블록, 최후엔 첫 블록). 매핑 블록 부재로 반영이 통째로 누락되는 것 차단(외부리뷰)."""
    mapped = _GENERAL_REFLECT_BLOCK.get(kind or "general", "brandBanner")
    if mapped in present_types:
        return mapped
    for t in _GENERAL_FALLBACK_ORDER:
        if t in present_types:
            return t
    for t in present_types:
        if t != "hero":
            return t
    return present_types[0] if present_types else "hero"


def _inject_general_reflection(plan, evdocs, present_types):
    """일반 참조 문서(kind!=test_report)를 대상 블록(_general_target_block)에 반영: 반영 포인트 원문을 bodyText 에,
    doc-NN 을 각주(footnotes)에 인용. 각주 인용 채널(claim-basis 미승격이라 evidence_ref 불가). doc 없으면 no-op."""
    typ = plan.get("type")
    for did, d in (evdocs or {}).items():
        if (d.get("kind") or "general") == "test_report":
            continue
        if typ != _general_target_block(d.get("kind") or "general", list(present_types or [])):
            continue
        pts = [p for p in (d.get("reflection_points") or []) if p]
        if not pts:
            continue
        plan.setdefault("bodyText", []).append(pts[0])   # 반영 포인트 원문은 '본문'에(결박 기준·각주-only 반영 차단)
        plan.setdefault("footnotes", []).append({"id": "fn-ref-%s" % did.split("-")[-1],
                                                  "text": "%s 참조" % did})   # 각주 = doc-id 인용만(내용은 본문에)


def gen_plan_block(rdir, order, typ):
    """기획안 블록 1개만 생성(부분 재생성·재개 단위, #6/#7).
    M3: visual.concept(구도/무드/팔레트/참조)를 항상 부착(tone 서브스테이지 흡수)."""
    voc, cb = ingest(rdir)
    top = top_keywords(voc)
    storyline = _selected_storyline(rdir)
    blk = next((b for b in storyline["blocks"] if int(b["order"]) == int(order) and b["type"] == typ), None)
    if blk is None:
        return
    pdir = os.path.join(rdir, "03-storyboard", "plan")
    os.makedirs(pdir, exist_ok=True)
    _evd = _reflect_evdocs(rdir)
    plan = _plan_block(blk, top, cb, _evd)
    _present = [b.get("type") for b in storyline.get("blocks", []) if isinstance(b, dict)]
    _inject_general_reflection(plan, _evd, _present)   # 일반 참조 문서 반영(각주+포인트 원문, 대상 블록 폴백 포함)
    plan["visual"]["concept"] = _build_concept(rdir, blk["order"], typ)
    atomic_write_json(os.path.join(pdir, "%02d-%s.json" % (blk["order"], blk["type"])), plan)
    _write_plan_md(pdir, blk["order"], blk["type"], plan)


def gen_storyboard_plan(rdir):
    """오케스트레이터(오프라인): 전역 아트디렉션 먼저 → 선택 스토리라인의 모든 블록을 개별 생성."""
    gen_art_direction(rdir)   # P0-ⓠ: 블록보다 먼저(블록 visual.concept 가 상속)
    for blk in _selected_storyline(rdir)["blocks"]:
        gen_plan_block(rdir, blk["order"], blk["type"])


def _plan_block(blk, top, cb, evdocs=None):
    evdocs = evdocs or {}
    typ = blk["type"]; phrase = top[0] if top else _noun()
    claims, footnotes = [], []
    _body_override = None   # 반영 문서 본문 카피(clinicalEvidence 정성 인증형) — 각주가 아니라 '본문'에 내용을 둔다
    visual_kind = "photo"
    if typ == "hero":
        headline = "매일의 %s, 자연스럽게" % phrase
        visual_kind = "nukki"
    elif typ == "socialProof":
        headline = "많은 분들이 선택한 데일리 %s" % _noun()
        claims.append({"target_text": "누적 판매 다수", "claim_strength": "factual",
                       "evidence_ref": None, "footnote_id": "fn-1"})
        footnotes.append({"id": "fn-1", "text": "판매 수치는 기준일·집계 출처 표기 필요(자리표시)."})
    elif typ == "colorSwatch":
        headline = _stub_tmpl()["plan_colorswatch_headline"] if _is_cosmetic() else "다양한 구성·옵션"; visual_kind = "swatch"
    elif typ == "reviewCapture":
        headline = "리뷰 속 한마디"; visual_kind = "chat"
    elif typ == "rtbSummary":
        # 핵심 RTB 요약 3-4개 — VOC 상위어로 절제 카피(효능 단정 금지)
        headline = "이 %s을 고르는 이유" % _noun()
        if _is_cosmetic():
            body = [x % phrase if "%s" in x else x for x in _stub_tmpl()["plan_rtbsummary_body"]]
        else:
            body = ["%s 중심의 핵심 가치" % phrase,
                    "꾸준히 선택받는 이유", "신뢰할 수 있는 구성"]
        return _block(typ, blk, headline, "핵심 RTB 3-4가지", body, "photo")
    elif typ == "ingredientTech":
        headline = "성분·기술로 보는 차별점"
        return _block(typ, blk, headline, "성분/배합·원료기술·사용편의(meta 근거 한정)",
                      ["고시성분/구성은 claim-basis 근거 내에서만 표기"], "photo")
    elif typ == "targetAudience":
        # 추천 타겟 — voc 페르소나 '가설'. 질환 암시 금지(안전 타겟만).
        headline = "이런 분께 추천"
        if _is_cosmetic():
            body = [x % phrase if "%s" in x else x for x in _stub_tmpl()["plan_targetaudience_body"]]
        else:
            body = ["%s가 필요한 분" % phrase,
                    "꼼꼼히 비교하는 분", "가족 선물을 찾는 분(VOC 가설)"]
        return _block(typ, blk, headline, "추천 타겟(가설, 질환 암시 금지)", body, "photo")
    elif typ == "brandBanner":
        # 브랜드 헤리티지 배너 — 브랜드명은 제품명에서 파생(하드코딩 금지). 전문성/효능 권위 표현 금지(kcia 가드).
        brand = _brand() or "브랜드"
        return _block(typ, blk, brand, "%s 헤리티지 배너(브랜드 신뢰)" % brand,
                      ["%s 브랜드 신뢰 요소" % brand], "photo")
    elif typ == "clinicalEvidence":
        headline = "실증 결과(절제 표현)"; visual_kind = "graph"
        # 반영 문서(doc-*, reflect:true) 우선 — 판정문 '원문'으로 결박된 정성 인증-표시형 반영 블록을
        #   결정적으로 생성(오프라인 반영 강제 E2E·골든). 복수 문서는 각각 claim+각주(모든 doc-* 반영 —
        #   done 게이트가 문서 전건 반영을 요구). doc-* 없으면 기존 동작 그대로(골든 바이트 불변).
        doc_evs = [e for e in (cb.get("evidence_on_file") or [])
                   if isinstance(e, dict) and str(e.get("id", "")).startswith("doc-") and evdocs.get(e.get("id"))]
        if doc_evs:
            visual_kind = "photo"   # 정성(측정값 없음) = 인증-표시형(수치 차트 아님)
            _body_override = []
            for _i, doc_ev in enumerate(doc_evs, 1):
                did = doc_ev["id"]; decl = evdocs[did]
                vt = (decl.get("verdict_text") or "").strip()
                tr = decl.get("test_report") or {}
                bits = []
                if tr.get("institution"):
                    bits.append(str(tr["institution"]))
                if tr.get("sample_size") is not None:
                    bits.append("n=%s" % tr["sample_size"])
                if tr.get("duration"):
                    bits.append(str(tr["duration"]))
                # 내용(판정문 원문 + 시험기관·n·기간 + 개인차 디스클레이머)은 '본문'(bodyText)에 둔다 — 각주-only
                #   반영을 막기 위함(각주는 doc-id 인용만). 판정 카피 claim(target_text=판정문)은 결박 검증용.
                _body_override.append("%s (%s). 개인에 따라 차이가 있을 수 있습니다" % (vt, ", ".join(bits)))
                _fnid = "fn-%d" % _i
                claims.append({"target_text": vt, "claim_strength": "factual",
                               "evidence_ref": did, "footnote_id": _fnid})
                footnotes.append({"id": _fnid, "text": "%s 참조" % did})   # 각주 = 인용만(내용은 본문에)
        else:
            ev = cb["evidence_on_file"][0] if cb["evidence_on_file"] else None
            if ev:
                claims.append({"target_text": "인체적용시험 결과", "claim_strength": "efficacy",
                               "evidence_ref": ev["id"], "footnote_id": "fn-1"})
                footnotes.append({"id": "fn-1", "text": "인체적용시험 결과. 개인차가 있을 수 있습니다."})
    elif typ == "beforeAfter":
        # 외부리뷰 FIX 3b: beforeAfter 는 인체적용시험 수치 대비 블록 → 수치 차트(graph)로 렌더한다.
        #   기존엔 default photo 로 떨어져 validate_storyboard 수치차트 가드와 충돌. graph 로 명시.
        #   골든-안전: 실증 미등록 골든 런엔 beforeAfter 블록 자체가 없다(evidence-gated 제외, stub_stage 8행).
        headline = "사용 전후 비교(절제 표현)"; visual_kind = "graph"
    elif typ == "footer":
        # 필수기재 컨테이너(캐논 도메인 축) — 최종 페이지 mandatory_inclusion 게이트가 요구하는 신호를
        #   결정적으로 기재: 정확한 제품명(독립 노출)·소비자 주의문구·광고심의필·회사명(자리표시).
        #   footer 는 도메인 오버레이 캐논(예: drug 교육콘텐츠 캐논)에만 시퀀스로 등장 → cosmetic 골든 무영향.
        #   실엔진 경로는 DOMAIN_GEN_RULES(gen-fragment)·keyvisual 프롬프트가 채운다.
        return _block(typ, blk, _product_name(), blk["intent"],
                      ["부작용이 있을 수 있으니 첨부된 '사용상의 주의사항'을 잘 읽고, 의사·약사와 상의하십시오.",
                       "광고심의필 : 심의번호 기재(자리표시)",
                       "제조판매원 : 회사명 기재(자리표시)"], "photo")
    else:
        headline = "%s — %s" % (typ, blk["intent"])
    return {
        "type": typ, "order": blk["order"], "headline": headline,
        "subcopy": blk["intent"],
        "bodyText": _body_override if _body_override else ["VOC 근거 일상 표현(%s)" % phrase],
        "visual": {"kind": visual_kind, "ref": None},
        "claims": claims, "footnotes": footnotes, "approval_state": "draft",
    }


def _block(typ, blk, headline, subcopy, body, visual_kind):
    return {
        "type": typ, "order": blk["order"], "headline": headline, "subcopy": subcopy,
        "bodyText": body, "visual": {"kind": visual_kind, "ref": None},
        "claims": [], "footnotes": [], "approval_state": "draft",
    }


def _write_plan_md(pdir, order, typ, plan):
    with open(os.path.join(pdir, "%02d-%s.md" % (order, typ)), "w", encoding="utf-8") as f:
        f.write("# %02d %s\n\n## %s\n\n%s\n" % (order, typ, plan["headline"], plan["subcopy"]))


# ───────────────────────── keyvisual ─────────────────────────
def _generated_image_map(rdir):
    """P0-①: image-manifest.json(키비주얼 생성 전 image_engine 이 작성) → {(order,type): rel_path}.
       매니페스트가 없으면(image_engine 미선행) 빈 dict → _write_html 이 자사컷 폴백. 자사 생성물(generated/)은 img_lint allowlist 통과."""
    p = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
    if not os.path.exists(p):
        return {}
    try:
        m = load_json(p)
    except Exception:
        return {}
    out = {}
    for a in m.get("assets", []):
        path = a.get("path")
        if path and a.get("order") is not None and a.get("type"):
            out[(int(a["order"]), a["type"])] = path
    return out


def gen_keyvisual(rdir):
    voc, cb = ingest(rdir)
    am = load_json(os.path.join(rdir, "00-ingest", "assets-manifest.json"))
    plan_dir = os.path.join(rdir, "03-storyboard", "plan")
    blocks = []
    if os.path.isdir(plan_dir):
        for fn in sorted(os.listdir(plan_dir)):
            if fn.endswith(".json"):
                blocks.append(load_json(os.path.join(plan_dir, fn)))
    own = am["own_assets"]["files"]
    gen_map = _generated_image_map(rdir)   # P0-①: 블록별 생성 이미지 우선 참조
    _w = (_channel() or {}).get("width_px") or 860   # M8: 포맷별 렌더 폭(multipage_bm=860 불변; one_pager=채널값)
    for opt in ("A", "B", "C"):   # 이슈3a: 최소 3안
        odir = os.path.join(rdir, "04-keyvisual", "options", opt)
        os.makedirs(os.path.join(odir, "shots"), exist_ok=True)
        _write_html(odir, opt, blocks, own, rdir, _w, gen_map)
    # pairwise 추천 (select/렌더 기준 옵션). 실재 옵션만.
    atomic_write_json(os.path.join(rdir, "04-keyvisual", "recommendation.json"),
                      {"ranked": ["A", "B", "C"], "rationale": "A안이 누끼 제품컷 중심으로 채널 규격에 더 적합(가설). B·C 는 레이아웃 변주."})


# 이슈3a: 키비주얼 옵션 A/B/C 가 '실제로 구별되는' 디자인 변주(레이아웃 밀도·헤드라인·accent 처리)를 갖도록 결정적 분기.
#   동일 HTML 3장이 게이트를 통과하던 hollow-ness 차단(외부리뷰 3a HIGH). 실 LLM 은 prompts/keyvisual.md 가 3안 디자인을 지시.
_KV_VARIANT = {
    "A": {"pad": "40px 24px", "hl": "32px", "accent_deco": "color:%s;" % ACCENT_DEFAULT, "note": "기본 레이아웃"},
    "B": {"pad": "28px 20px", "hl": "30px", "accent_deco": "color:%s;border-bottom:2px solid %s;" % (ACCENT_DEFAULT, ACCENT_DEFAULT), "note": "조밀 레이아웃(밀도↑)"},
    "C": {"pad": "56px 28px", "hl": "36px", "accent_deco": "color:#fff;background:%s;padding:0 4px;" % ACCENT_DEFAULT, "note": "여백 강조 레이아웃"},
}


def _write_html(odir, opt, blocks, own, rdir, width=860, gen_map=None):
    # rel = HTML 위치(odir)에서 프로젝트 루트까지의 상대경로. per-run 계약에선 **shared 폰트(core/assets/fonts)
    #   전용** — 폰트만 ROOT 기준이므로 남긴다. per-run 이미지(생성물·자사컷)는 아래 _img_src(run_dir 기준)로 계산.
    rel = os.path.relpath(ROOT, os.path.abspath(odir)).replace("\\", "/")
    odir_abs = os.path.abspath(odir)

    def _img_src(path):
        """런 상대 정규경로(inputs/assets/… · 04-keyvisual/generated/…)를 HTML 파일 디렉터리(odir) 기준
           상대경로로 직접 계산(손계산 ../ 제거 = 깊이버그 원천 차단). 해석 기준 base = run_dir(rdir)."""
        return os.path.relpath(os.path.join(rdir, path), odir_abs).replace("\\", "/")
    _w = width if (width and width > 0) else 860   # M8: 포맷별 폭(0/미정 → 860 폴백)
    gen_map = gen_map or {}
    _v = _KV_VARIANT.get(opt, _KV_VARIANT["A"])   # 이슈3a: 옵션별 디자인 변주(구별되는 3안)
    # 저작권: img src 는 자사 자산만(allowlist). 자사 제품컷(product-*)은 제품 비주얼 블록에 우선 사용.
    product = next((o["path"] for o in own if "product" in o["path"].lower()), None)
    svgs = [o["path"] for o in own if "product" not in o["path"].lower()] or [o["path"] for o in own]
    PRODUCT_BLOCKS = {"hero", "colorSwatch", "ingredientTech", "solution"}
    secs = []
    for b in blocks:
        order = b["order"]; typ = b["type"]
        img = ""
        gen_path = gen_map.get((int(order), typ))   # P0-①: 블록별 생성 이미지 우선(자사 생성물)
        if gen_path:
            img = '<img src="%s" alt="%s">' % (_h(_img_src(gen_path)), _h(_product_name()))
        elif product and typ in PRODUCT_BLOCKS:
            img = '<img src="%s" alt="%s">' % (_h(_img_src(product)), _h(_product_name()))
        elif svgs:
            img = '<img src="%s" alt="자사 자산">' % _h(_img_src(svgs[(order - 1) % len(svgs)]))
        else:
            img = '<div class="placeholder">[자사 이미지 자리 — 타이포/도형 대체]</div>'
        fns = "".join('<p class="footnote">%s</p>' % _h(f["text"]) for f in b.get("footnotes", []))
        body = b.get("bodyText", []) or []
        body_html = ("<ul class=\"body\">" + "".join("<li>%s</li>" % _h(t) for t in body) + "</ul>") if body else ""
        secs.append(
            '  <section data-block="%s" data-order="%d">\n'
            '    <h2 class="hl">%s</h2>\n    <p class="sub">%s</p>\n    %s\n    %s\n%s  </section>'
            % (_h(typ), order, _h(b["headline"]), _h(b["subcopy"]), body_html, img, ("    " + fns + "\n") if fns else ""))
    html = (
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">\n'
        '<!-- 옵션 %s: %s -->\n' % (_h(opt), _h(_v["note"])) +
        '<style>\n'
        '@font-face{font-family:"Pretendard";src:url("' + rel + '/assets/fonts/PretendardVariable.woff2");}\n'
        'body{font-family:"Pretendard",sans-serif;margin:0;}\n'
        '.detail{width:' + str(_w) + 'px;margin:0 auto;}\n'
        'section{padding:' + _v["pad"] + ';border-bottom:1px solid #eee;}\n'
        '.hl{font-size:' + _v["hl"] + ';} .accent{' + _v["accent_deco"] + '}\n'
        '.footnote{font-size:12px;color:#888;} .placeholder{height:200px;background:#f3f3f3;'
        'display:flex;align-items:center;justify-content:center;color:#aaa;}\n'
        '.sub{color:#666;} .body{color:#333;line-height:1.7;padding-left:18px;}\n'
        'img{max-width:100%%;max-height:520px;object-fit:contain;display:block;margin-top:12px;background:#faf7f4;}\n'
        '</style></head>\n<body>\n<main class="detail variant-' + _h(opt) + '" data-variant="' + _h(opt) + '">\n%s\n</main>\n</body></html>\n'
        % "\n".join(secs))
    with open(os.path.join(odir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    with open(os.path.join(odir, "styles.css"), "w", encoding="utf-8") as f:
        f.write("/* 인라인 스타일 사용. 옵션 %s */\n" % opt)


# ───────────────────────── evidence (00e 반영 제안 초안) ─────────────────────────
def _pending_evidence_docs(rdir):
    """00-ingest/evidence-documents.json 에서 spec_status=="pending" 인 문서(문서만 첨부·반영 스펙 미정).
       없으면 []. 00e 는 pending 문서가 있을 때만 진입하므로 실사용 경로에선 항상 ≥1."""
    p = os.path.join(rdir, "00-ingest", "evidence-documents.json")
    if not os.path.exists(p):
        return []
    try:
        docs = load_json(p).get("documents") or []
    except Exception:
        return []
    return [d for d in docs if isinstance(d, dict) and d.get("spec_status") == "pending" and d.get("id")]


_EVIDENCE_RASTER_EXTS = ("png", "jpg", "jpeg", "webp")


def gen_evidence(rdir):
    """00e 반영 제안 초안(결정적 stand-in):
       · 일반 kind(비-test_report) pending 문서 → kind=general + 결정적 반영 포인트(각주 인용 채널).
       · kind=test_report intent(W-3, 00e 스펙 2차 관문) pending 문서 → 결정적 시험성적서 초안(기관·n·기간·판정문·test_items).
       실 LLM 경로(prompts/evidence.md)는 문서 원문에서 kind 추정·원문 발췌·시험성적서 스펙(전후사진 페이지 포함)을 수행하고 사람이 승인한다.
       결정적: id 정렬·고정 문자열·타임스탬프/랜덤 없음. spec_origin=agent_proposed_human_approved.
       reflection-proposal.schema.json 준수(docs 1:1, id/filename/kind/claim/reflection_points 필수)."""
    pend = sorted(_pending_evidence_docs(rdir), key=lambda d: d["id"])
    out = os.path.join(rdir, "00e-evidence")
    os.makedirs(out, exist_ok=True)
    docs = []
    for d in pend:
        did = d["id"]
        fn = d.get("filename") or did
        # claim = 매니페스트에 이미 있으면 그대로(결정적), 없으면 파일명에서 결정적 파생.
        claim = (str(d.get("claim")).strip() if d.get("claim") else "") or ("%s 참조 문서" % fn)
        if d.get("kind") == "test_report":
            # W-3: 사람이 kind:test_report 로 intent 선언(상세 생략)한 pending 문서 → 결정적 시험성적서 초안.
            #   series 100→60(−40%)은 자기일관(clinical_chart 도출과 일치) → apply-proposal 의 change_pct 정규화 무모순.
            item = {
                "metric": "임상 지표 개선",
                "unit": "점",
                "series": [{"label": "사용 전", "value": 100.0}, {"label": "4주 후", "value": 60.0}],
                "change_pct": -40,
                "stat_note": "p<0.05 (결정적 자리표시 — 원문 확인 필요)",
            }
            # 이미지 추출은 래스터(원본이 이미지)만 결정적으로 결박한다 — PDF 전후사진 추출은 poppler(pdftoppm)가
            #   필요하므로 stub(오프라인/헤르메틱)은 PDF 근거에 image_ref 를 넣지 않는다(실 LLM 경로는 페이지 후보를 제안).
            if (d.get("ext") or "").lower() in _EVIDENCE_RASTER_EXTS:
                item["image_ref"] = {"pages": [1]}
            docs.append({
                "id": did,
                "filename": fn,
                "kind": "test_report",
                "claim": claim,
                "grade": "인체적용시험",
                "verdict_text": "시험 결과 적합한 것으로 판단됨(결정적 자리표시 — 원문 판정문 확인 필요)",
                "reflection_points": ["시험 결과 원문 발췌(사람 확인 필요)"],
                "test_report": {
                    "institution": "시험연구기관(원문 확인 필요)",
                    "sample_size": 20,
                    "duration": "4주",
                    "test_items": [item],
                },
                "rationale": "오프라인 결정적 초안(자리표시). 기관·n·기간·판정문·지표 수치·전후사진 페이지는 세션 내 에이전트가 PDF 원문에서 추출하고 사람이 승인한다.",
            })
        else:
            docs.append({
                "id": did,
                "filename": fn,
                "kind": "general",
                "claim": claim,
                # 결정적 자리표시(원문 발췌는 실 LLM/사람 승인 단계에서 확정). 고정 문자열 = 골든 결정성.
                "reflection_points": ["%s 문서의 핵심 내용(원문 발췌 필요 — 사람 확인)" % fn],
                "rationale": "오프라인 결정적 초안(자리표시). 원문 발췌·kind 추정은 세션 내 에이전트가 수행하고 사람이 승인한다.",
            })
    proposal = {"docs": docs, "spec_origin": "agent_proposed_human_approved"}
    atomic_write_json(os.path.join(out, "reflection-proposal.json"), proposal)


# ───────────────────────── intake (00a 첨부 자료 보편 분류 제안) ─────────────────────────
_INTAKE_IMG_EXT = (".webp", ".png", ".jpg", ".jpeg", ".gif")
_INTAKE_DOC_EXT = (".docx", ".md")
_INTAKE_CRAWL_FILES = ("product.json", "reviews.csv")


# _sha256_file: harness.sha256_file 를 import (K-1 일원화 — 스트리밍 파일 해시. 청크 64KiB→1MiB 통일, hexdigest 불변)


def _intake_name_tokens():
    """선언 제품명에서 대조 토큰(자사/타사 크롤 구분). 대괄호 접두 제거·2자 이상."""
    name = re.sub(r"\[[^\]]*\]", " ", _product_name())
    return [t for t in re.split(r"\s+", name) if len(t) >= 2]


def _intake_snapshot_files(rdir):
    """스냅샷 최상위 첨부 파일(정렬) — _unpacked 디렉터리·닷파일(.sha256sums 등) 제외."""
    adir = os.path.join(rdir, "inputs", "attachments")
    if not os.path.isdir(adir):
        return adir, []
    out = [fn for fn in sorted(os.listdir(adir))
           if not fn.startswith(".") and os.path.isfile(os.path.join(adir, fn))]
    return adir, out


def _classify_intake(fn):
    """확장자·이름 기반 결정적 분류 → (category, route, kind, reflect_preview, confidence, actions)."""
    low = fn.lower()
    if low.endswith(_INTAKE_DOC_EXT):
        return ("working_backwards", "working_backwards", None,
                "전 단계의 사실 원천(핵심 정리·카피)", "high",
                (["converted"] if low.endswith(".docx") else ["none"]))
    if low.endswith(_INTAKE_IMG_EXT):
        return ("product_image", "assets", None,
                "대표 이미지 픽셀 레퍼런스·자사컷", "high", ["none"])
    if low.endswith(".pdf"):
        return ("evidence_test_report", "evidence", "test_report",
                "임상 TEST 섹션(차트+전후사진) 후보 — 스펙은 다음 관문", "low", ["none"])
    if low.endswith(".zip"):
        toks = _intake_name_tokens()
        if any(t in fn for t in toks):
            return ("own_product_crawl", "bundle", None, "고객 후기 인용·가격·제품 사실", "low", ["unpacked"])
        return ("reference_crawl", "examples", None, "구도·전개 참조(원본 이미지 직접 사용 금지)", "low", ["unpacked"])
    if low in _INTAKE_CRAWL_FILES:
        return ("own_product_crawl", "bundle", None, "고객 후기 인용·가격·제품 사실", "low", ["none"])
    return ("unknown", "hold", None, "판단 불가 — 사람이 분류를 지정해야 해요", "low", ["none"])


_INTAKE_AGG_LABEL = {
    "working_backwards": "제품 기획 문서 %d건 → 사실 원천",
    "own_product_crawl": "자사 상품 크롤 %d건 → 후기 인용·제품 사실",
    "reference_crawl": "참고 상품 크롤 %d건 → 구도 참조",
    "product_image": "자사 제품 이미지 %d건 → 대표 이미지 레퍼런스",
    "evidence_test_report": "시험성적서 후보 %d건 → 임상 섹션(스펙은 다음 관문)",
    "unknown": "판단 불가 %d건 → 사람이 분류 지정 필요",
}


def gen_intake(rdir):
    """00a 첨부 자료 보편 분류 제안(결정적 stand-in): 스냅샷 첨부를 확장자/이름으로 분류.
       실 LLM(/intake, W-2)은 파일 원문·구조·제품명 대조로 정밀 분류한다. 고정 문자열·타임스탬프/랜덤 없음.
       intake-proposal.schema.json 준수(files 1:1, category/route/kind enum·sha256·confidence·actions)."""
    adir, names = _intake_snapshot_files(rdir)
    out = os.path.join(rdir, "00a-intake")
    os.makedirs(out, exist_ok=True)
    files, counts = [], {}
    for fn in names:
        cat, route, kind, rp, conf, actions = _classify_intake(fn)
        counts[cat] = counts.get(cat, 0) + 1
        rec = {
            "filename": fn,
            "sha256": _sha256_file(os.path.join(adir, fn)),
            "category": cat,
            "route": route,
            "reflect_preview": rp,
            "rationale": "확장자·파일명 기반 결정적 제안(원문 대조는 사람/에이전트 확인).",
            "confidence": conf,
            "actions": actions,
        }
        if kind:
            rec["kind"] = kind
        files.append(rec)
    bits = [_INTAKE_AGG_LABEL[c] % counts[c]
            for c in ("working_backwards", "own_product_crawl", "reference_crawl",
                      "product_image", "evidence_test_report", "unknown")
            if counts.get(c)]
    proposal = {
        "files": files,
        "aggregate_preview": ", ".join(bits) if bits else "분류할 첨부가 없어요.",
        "product_name_declared": _product_name(),
    }
    atomic_write_json(os.path.join(out, "intake-proposal.json"), proposal)
    # 워킹백워드 변환본(00a-intake/converted/working-backwards.md) — apply-intake 가 WB 채널로 라우팅한다(열린 결정 3).
    #   실 LLM(/intake)은 docx→md 변환. stub 은 소스 내용을 결정적으로 옮긴다(오프라인 픽스처는 텍스트 가정).
    wb_srcs = [rec["filename"] for rec in files if rec["category"] == "working_backwards"]
    if wb_srcs:
        conv_dir = os.path.join(out, "converted")
        os.makedirs(conv_dir, exist_ok=True)
        # ★ 외부리뷰 W4-R6: 워킹백워드가 여러 문서면 '전부' 결합한다(첫 파일만 쓰면 나머지 기획문서의 사실이 유실).
        parts = []
        for _w in wb_srcs:
            try:
                with open(os.path.join(adir, _w), "r", encoding="utf-8", errors="replace") as fh:
                    parts.append(fh.read())
            except Exception:
                pass
        body = "\n\n".join(p for p in parts if p and p.strip())
        if not body.strip():
            body = "# %s\n\n(워킹백워드 변환본 — 결정적 stand-in)\n" % _product_name()
        with open(os.path.join(conv_dir, "working-backwards.md"), "w", encoding="utf-8") as fh:
            fh.write(body)


STAGES = {
    "intake": gen_intake,
    "brief": gen_brief,
    "concept": gen_concept,
    "storyboard-outline": gen_storyboard_outline,
    "storyboard-plan": gen_storyboard_plan,
    "keyvisual": gen_keyvisual,
    "evidence": gen_evidence,
}


def main():
    if len(sys.argv) < 4:
        sys.exit("사용법: stub_stage.py <stage> <run_id> <run_dir> [axis]")
    stage, rid, rdir = sys.argv[1], sys.argv[2], sys.argv[3]
    # 컨셉 독립 생성 하위 명령 (run-stage 가 축별로 호출)
    if stage == "concept-axes":
        gen_concept_axes(rdir); print("[stub] concept-axes 생성"); return
    if stage == "concept-option":
        gen_concept_option(rdir, sys.argv[4]); print("[stub] concept-option %s 생성" % sys.argv[4]); return
    if stage == "concept-reco":
        gen_concept_reco(rdir); print("[stub] concept-reco 생성"); return
    if stage == "art-direction":   # P0-ⓠ: 전역 아트디렉션(블록보다 먼저)
        gen_art_direction(rdir); print("[stub] art-direction 생성"); return
    if stage == "plan-block":   # M3: tone_sel 인자 제거(visual.concept 직접 산출)
        gen_plan_block(rdir, sys.argv[4], sys.argv[5])
        print("[stub] plan-block %s-%s 생성" % (sys.argv[4], sys.argv[5])); return
    if stage not in STAGES:
        sys.exit("stub 미지원 stage: %s" % stage)
    STAGES[stage](rdir)
    print("[stub] %s 생성 완료" % stage)


if __name__ == "__main__":
    main()
