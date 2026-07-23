#!/usr/bin/env python3
"""examples_analysis.py — 수집 사례 N개 '왜 좋은가' 결정적 분석 + 프로젝트 가이드라인 종합.

00g-guideline 페이즈의 결정적 stand-in(ingest.py 와 동일 위상: no-LLM, 측정 신호 그라운딩).
실 LLM 경로(prompts/guideline.md)는 이 산출물과 동일 스키마(harness/example-analysis·project-guideline)를 쓴다.

원칙:
 - why_good 은 반드시 signals/voc_themes/structure 의 '실재 키'를 grounded_in 으로 인용한다(fail-closed).
   조건이 성립하지 않으면 항목을 만들지 않는다(근거 없는 칭찬 금지).
 - 사례는 타깃과 '동일 도메인'만 입력한다(상위 호출자 책임).
 - 경쟁사 페이지는 텍스트·구조 신호만 본다(no-pixel, 저작권). 이미지 픽셀 복제 없음.
 - 법(심의 룰셋) > 가이드라인. 가이드라인은 soft 권고.

사용:
  examples_analysis.py <out_dir> <domain> <example_dir> [<example_dir> ...]
    → <out_dir>/examples/<example_id>/example-analysis.json (사례별)
    → <out_dir>/project-guideline.json (종합)
"""
import sys, os, csv, io, json, re, unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json  # noqa: E402

try:
    from kcia_engine import load_ruleset  # 도메인 룰셋 banned(soft mirror)
except Exception:  # pragma: no cover
    def load_ruleset(domain=None):
        return {"axes": {}}

try:
    from ingest import BP_BLOCK_ORDER  # 캐논 블록 순서(현재 화장품 기본; M2/M5 에서 도메인화)
except Exception:  # pragma: no cover
    BP_BLOCK_ORDER = ["hero", "problem", "solution", "socialProof", "howToUse", "buyingGuide"]

_TOKEN = re.compile(r"[가-힣A-Za-z0-9]{2,}")
_STOP = {"있어요", "좋아요", "구입", "구매", "배송", "사용", "제품", "정말", "너무", "그리고", "해서", "에요", "이에", "합니다", "있습니다", "같아요"}


def _read_bom_csv(path):
    """BOM 제거 + RFC4180 CSV 파싱(content 내 콤마/줄바꿈 안전)."""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _ratio(num, den):
    return round(num / den, 4) if den else None


def _signals(example_dir):
    pj_path = os.path.join(example_dir, "product.json")
    pj = load_json(pj_path) if os.path.exists(pj_path) else {}
    price = pj.get("price", {}) or {}
    rows = []
    rv_path = os.path.join(example_dir, "reviews.csv")
    if os.path.exists(rv_path):
        rows = _read_bom_csv(rv_path)
    review_count = pj.get("collectedReviewCount") or len(rows)
    photo = sum(1 for r in rows if (r.get("hasPhoto") or "").strip().upper() == "Y")
    repurch = sum(1 for r in rows if (r.get("repurchase") or "").strip().upper() == "Y")
    detail_dir = os.path.join(example_dir, "images", "detail")
    dfiles = [f for f in os.listdir(detail_dir) if not f.startswith(".")] if os.path.isdir(detail_dir) else []
    gif = sum(1 for f in dfiles if f.lower().endswith(".gif"))
    sig = {
        "price_current": price.get("current"),
        "price_original": price.get("original"),
        "discount_rate": price.get("discountRate"),
        "rating": pj.get("rating"),
        "review_count": int(review_count or 0),
        "photo_review_ratio": _ratio(photo, len(rows)),
        "repurchase_ratio": _ratio(repurch, len(rows)),
        "detail_image_count": len(dfiles),
        "gif_count": gif,
    }
    return sig, pj, rows


def _voc_themes(rows, top=8):
    """리뷰 본문 토큰 빈도(리뷰당 등장 1회 계수) 상위 N. 결정적(빈도 desc, 토큰 asc)."""
    freq = {}
    for r in rows:
        seen = set()
        for tok in _TOKEN.findall(r.get("content") or ""):
            if tok in _STOP or len(tok) < 2:
                continue
            if tok not in seen:
                seen.add(tok)
                freq[tok] = freq.get(tok, 0) + 1
    items = sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
    return [{"phrase": k, "count": v} for k, v in items]


def _structure(sig):
    n = sig["detail_image_count"]
    seq = BP_BLOCK_ORDER[: max(0, min(len(BP_BLOCK_ORDER), n))] if n else []
    rating = sig.get("rating") or 0
    pacing = "social-proof-first" if (rating >= 4.5 and sig["review_count"] >= 100) else "problem-first"
    return {"block_sequence": list(seq), "pacing": pacing}


# ── M2(G3): 감각 reference_images 생성 ─────────────────────────────
# 사례 이미지의 '왜 보기 좋은가'(구도·무드)를 화이트리스트 어휘로 캡처. 효능·절대어 0(저작권·환각 안전).
#   결정적 stand-in(ingest BP_HINTS 와 동일 위상): 실 LLM 경로(prompts/guideline.md)는 실제 감각 분석.
#   블록타입별 구도/무드 어휘 — 모두 시각·감각어(효능/주장어 아님).
COMPOSITION_VOCAB = {
    "hero":           ["centered", "closeup", "negative_space"],
    "problem":        ["context_scene", "split_frame"],
    "solution":       ["product_focus", "diagonal"],
    "socialProof":    ["grid", "badge_cluster"],
    "reviewCapture":  ["grid", "quote_card"],
    "rtbSummary":     ["icon_row", "stacked"],
    "ingredientTech": ["macro", "diagram"],
    "howToUse":       ["step_sequence", "flat_lay"],
    "buyingGuide":    ["table", "comparison"],
    "brandTrust":     ["full_bleed", "symmetry"],
    "brandBanner":    ["full_bleed", "centered"],
}
MOOD_VOCAB = {
    "hero":           ["clean", "bright"],
    "problem":        ["calm", "muted"],
    "solution":       ["fresh", "natural"],
    "socialProof":    ["warm", "soft"],
    "reviewCapture":  ["warm", "soft"],
    "rtbSummary":     ["clean", "vivid"],
    "ingredientTech": ["cool", "clean"],
    "howToUse":       ["airy", "natural"],
    "buyingGuide":    ["neutral", "clean"],
    "brandTrust":     ["calm", "cozy"],
    "brandBanner":    ["calm", "bright"],
}
_DEFAULT_COMP = ["centered", "balanced"]
_DEFAULT_MOOD = ["clean", "natural"]

# 감각 어휘 화이트리스트(allowed set) — validate-stage 가 이 집합으로 fail-closed 강제(효능·절대어 0).
#   생성 vocab 은 이 집합의 부분집합이어야 하고, 실 LLM(prompts/guideline.md)도 이 어휘만 쓴다.
#   순수 시각·구도·무드·색온도·라이팅 어휘만(효능/주장/절대표현 없음).
ALLOWED_COMPOSITION_TAGS = frozenset([
    "centered", "balanced", "closeup", "macro", "negative_space", "full_bleed",
    "rule_of_thirds", "diagonal", "symmetry", "grid", "stacked", "layered",
    "overhead", "flat_lay", "step_sequence", "context_scene", "split_frame",
    "product_focus", "badge_cluster", "quote_card", "icon_row", "diagram",
    "table", "comparison", "framing",
])
ALLOWED_MOOD_TAGS = frozenset([
    "clean", "natural", "bright", "soft", "warm", "cool", "calm", "muted",
    "fresh", "vivid", "airy", "neutral", "cozy", "crisp", "pastel", "monochrome",
    "high_key", "low_key", "backlit", "soft_light",
])


def _list_detail(example_dir):
    d = os.path.join(example_dir, "images", "detail")
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if not f.startswith("."))


def _list_main(example_dir):
    """images/main 이미지 나열(닷파일 제외, 정렬) — detail 부재(main 만 있는 불완전 크롤) 시 폴백 소스."""
    d = os.path.join(example_dir, "images", "main")
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if not f.startswith("."))


# reference_images.why 효능·절대·속효 deny (코덱스 M2 R2/R3 HIGH 반영) — 하드코딩 대신 active 도메인
#   룰셋(banned + axes.lexicon)을 로드 + 영문 큐레이션 보강. 도메인-aware(drug 의 치료/예방/피임 등 포함).
#   매칭: NFKC 정규화 → 소문자 → 공백/유니코드 대시류/슬래시/언더스코어/middot/점 제거 부분문자열
#         → 영문 우회(anti/aging·anti_aging·anti–aging·per_fect) 차단. '%'(의미기호)·한글 보존.
#   랭킹어(N위)는 '위치' 오탐을 피하려 부분문자열이 아니라 별도 정규식으로 판정.
# 정규화(normalize) 문자열에서 일관 검사(코덱스 M2 R4/R5 HIGH): 속효·랭킹도 raw 가 아니라 norm 에서.
_DENY_SPEED = re.compile(r"단\d+(일|시간|분|주|개월|초)?만에")   # norm(공백·구두점제거)에서
_DENY_RANK_KO = re.compile(r"(?<!\d)\d+위(?!치)")               # norm 에서 'N위' 랭킹(위치 오탐 제외)
_RANK_TERM = re.compile(r"^\d+\s*위$")
_PCT_RE = re.compile(r"퍼센트|프로|％|%")                      # 정량 단위 표기 통일(자연어 우회 차단)
# 단위(정량) 앞 'N' placeholder → \d+ (그 외 대문자 N 은 리터럴 유지: 'No.1' 깨짐 방지)
_TRIG_UNIT = "%배억살위건회개일월년시간분초주차단계종명원"
_CURATED_DENY = [
    # 효능(EN; 룰셋은 한글 위주라 영문 보강)
    "whitening", "wrinkle", "antiaging", "anti-aging", "collagen", "regenerat", "acne", "antiwrinkle", "brightening",
    # 보편 의학/효능어(도메인 무관 — 감각 why 에 부적절. 룰셋이 'bare 치료'를 안 담는 화장품도 차단)
    "치료", "완치", "치유", "의약품", "처방", "부작용",
    # 절대·최상급(KO 보강)
    "최고", "최상", "최대", "최소", "독보적", "압도적", "넘버원",
    # 절대(EN)
    "no.1", "no1", "best", "perfect", "ultimate", "unrivaled", "onlyone",
]
# '%' 포함 deny(정량) — keepcase 뷰(nk)에서만 매칭(코덱스 R6: plain 뷰는 '%' 까지 제거해 '치%료' 우회 차단).
_CURATED_PCT = ["100%"]


def _strip_norm(s, keep_pct):
    """NFKC → 퍼센트/프로/％→% 통일 → 공백·포맷(Cf)·결합문자(M*)·구두점(P*)·기호(S*) 제거.
       유니코드 카테고리 기반(고정 문자셋 아님) — comma/colon/plus/middot/combining-accent/'%' 삽입 우회 차단.
       keep_pct=True 만 '%'(정량 의미기호)를 보존(트리거·100% 매칭 전용)."""
    s = unicodedata.normalize("NFKC", (s or ""))
    s = _PCT_RE.sub("%", s)
    out = []
    for c in s:
        if c.isspace():
            continue
        cat = unicodedata.category(c)
        if cat == "Cf" or cat[0] == "M":                      # zero-width/포맷 + 결합문자(악센트) 제거
            continue
        if cat[0] in ("P", "S") and not (keep_pct and c == "%"):   # 모든 구두점·기호 제거
            continue
        out.append(c)
    return "".join(out)


def _norm_keepcase(s):     # '%' 보존(트리거 N%·100% 매칭). 대소문자 보존.
    return _strip_norm(s, keep_pct=True)


def _norm_deny(s):         # '%' 까지 제거 + 소문자(plain deny/속효/랭킹). '치%료' 등 '%' 삽입 우회 차단.
    return _strip_norm(s, keep_pct=False).lower()


def _ruleset_axes(domain):
    try:
        return (load_ruleset(domain) or {}).get("axes", {}) or {}
    except Exception:                       # 룰셋 파손/레지스트리 오류 → 큐레이션·레거시 baseline 으로 계속(fail-safe)
        return {}


def _plain_deny(domain):
    """N·'%' 없는 단순 deny 어휘(nd 뷰 부분문자열). banned + axes.lexicon + 큐레이션 + 레거시 baseline.
       N·'%' 포함 항목은 _pct_patterns 정규식으로(여기서 제외 — '치%료' 우회·N placeholder 오매칭 방지)."""
    deny = set(t for t in _CURATED_DENY if "%" not in t and "N" not in t)
    ax = _ruleset_axes(domain)

    def _ok(t):
        return len(t) >= 2 and not _RANK_TERM.match(t) and "N" not in t and "%" not in t

    for axkey in ("drug_misperception", "consumer_deception", "prescription_otc_distinction"):
        for b in (ax.get(axkey, {}) or {}).get("banned", []):
            term = b.split("(")[0].strip()
            if _ok(term):
                deny.add(term)
    lex = ax.get("lexicon", {}) or {}
    fe = lex.get("functional_efficacy")
    if isinstance(fe, dict):
        for vs in fe.values():
            if isinstance(vs, list):
                deny.update(v for v in vs if _ok(v))
    elif isinstance(fe, list):
        deny.update(v for v in fe if _ok(v))
    for k in ("condition_target", "superlative_authority", "safety_overclaim", "pharma_authority"):
        v = lex.get(k)
        if isinstance(v, list):
            deny.update(x for x in v if _ok(x))
    # (2부 2단계) 화장품 상수(FUNC_EFFICACY/CONDITION_TARGET) 직접 import 폴백 제거 — 00g deny-list 우회로였다.
    #   어휘의 유일 출처는 도메인 룰셋 lexicon(위 239-250). cosmetic 은 lexicon 이 동일 어휘를 제공해 불변,
    #   타 도메인은 자기 lexicon 만 쓰므로 화장품 어휘 비누출.
    return deny


def _mark_placeholder(raw):
    """ruleset placeholder 'N'(단위/% 앞 대문자 N)만 센티넬(\\x00)로. 'No.1' 의 N 등 letter-N 은 보존."""
    return re.sub(r"N(?=\s*[%s])" % _TRIG_UNIT, "\x00", raw)


def _to_regex(s):
    """센티넬(\\x00) → \\d+ (그 사이 리터럴은 re.escape). 정규화된 문자열 입력."""
    return r"\d+".join(re.escape(p) for p in s.split("\x00"))


def _trigger_specs(domain):
    """실증/정량 트리거 → (nd_pats, nk_pats). 한글/영문 앵커 있으면 nd('%'제거 — '%' 삽입 우회 차단),
       순수 숫자%(100%·0%)만 nk('%' 보존 — '100가지' 오탐 차단)."""
    ax = _ruleset_axes(domain)
    raws = list((ax.get("substantiation_required", {}) or {}).get("triggers", [])) + list(_CURATED_PCT)
    for axkey in ("drug_misperception", "consumer_deception", "prescription_otc_distinction"):
        for b in (ax.get(axkey, {}) or {}).get("banned", []):
            t = b.split("(")[0].strip()
            if "N" in t or "%" in t:
                raws.append(t)
    # axes.lexicon 의 N/%-포함 항목도 수집(코덱스 R8: drug safety_overclaim 의 0%/100% 는 banned 가 아니라 lexicon).
    #   _plain_deny 는 N/% 포함을 제외하므로, 여기서 안 모으면 크랙으로 누수한다.
    lex = ax.get("lexicon", {}) or {}
    for k in ("functional_efficacy", "condition_target", "superlative_authority", "safety_overclaim", "pharma_authority"):
        v = lex.get(k)
        items = (sum((x for x in v.values() if isinstance(x, list)), []) if isinstance(v, dict)
                 else v if isinstance(v, list) else [])
        for t in items:
            if isinstance(t, str) and ("N" in t or "%" in t):
                raws.append(t)
    nd_pats, nk_pats = [], []
    for raw in raws:
        marked = _mark_placeholder(raw)
        nd = _norm_deny(marked)              # '%' 제거 + 소문자(센티넬 보존)
        anchor = nd.replace("\x00", "")
        if len(anchor) < 1 and "\x00" not in nd:
            continue
        if anchor == "" or anchor.isdigit():    # 순수 숫자%(앵커 없음) → nk 뷰(리터럴 '%' 필요)
            nk = _norm_keepcase(marked)
            if len(nk.replace("\x00", "")) >= 2:
                nk_pats.append(_to_regex(nk))
        else:                                    # 한글/영문 앵커 → nd 뷰('%' 삽입 우회까지 차단)
            if len(anchor) >= 2:
                nd_pats.append(_to_regex(nd))
    return nd_pats, nk_pats


def why_violations(text, domain):
    """why 텍스트의 효능·절대·속효·랭킹·실증/정량 표현 검출(fail-closed, 도메인-aware). 정규화 2뷰: nd('%'제거)·nk('%'보존)."""
    nk = _norm_keepcase(text)           # '%' 보존(순수 숫자% 100%·0% 매칭), 대소문자 보존
    norm = _norm_deny(text)             # '%' 제거 + 소문자(plain deny/트리거/속효/랭킹) — '치%료'·'항%균' 등 우회 차단
    hits = sorted({t for t in _plain_deny(domain) if len(_norm_deny(t)) >= 2 and _norm_deny(t) in norm})
    nd_pats, nk_pats = _trigger_specs(domain)
    for pat in nd_pats:
        if re.search(pat, norm):
            hits.append("실증/정량:%s" % pat)
    for pat in nk_pats:
        if re.search(pat, nk):
            hits.append("정량%%:%s" % pat)
    if _DENY_SPEED.search(norm):
        hits.append("단 N일 만에(속효)")
    if _DENY_RANK_KO.search(norm):
        hits.append("N위(랭킹)")
    return hits


def _reference_images(example_id, example_dir, structure, sig):
    """block_sequence 블록을 사례 상세 이미지(정렬순)에 1:1 매핑해 감각 캡처. 이미지 부족분은 중단.
       detail 부재(images/main 만 있는 불완전 크롤)면 images/main 파일로 폴백해 ≥1건 생성한다 —
       stand-in 이 validate-stage 무조건-비어있지않음 가드를 스스로 통과(우회 아님, 크롤 실이미지 기반).
       detail 보유 크롤은 이 분기를 안 타므로 산출물 바이트 불변(골든). detail·main 둘 다 없으면 빈 리스트(정당)."""
    files = _list_detail(example_dir)
    seq = structure["block_sequence"]
    src_dir = "images/detail"
    from_main = False
    if not files:                                     # detail 부재 → main 폴백(detail 있으면 미진입 = 골든 불변)
        mfiles = _list_main(example_dir)
        if mfiles:
            files, src_dir, from_main = mfiles, "images/main", True
            # detail 이 비어 structure.block_sequence 도 비었으니, main 장수만큼 캐논 블록을 앞에서 결정적으로 취함.
            seq = BP_BLOCK_ORDER[: max(0, min(len(BP_BLOCK_ORDER), len(files)))]
    out = []
    for idx, block in enumerate(seq):
        if idx >= len(files):
            break
        comp = COMPOSITION_VOCAB.get(block, _DEFAULT_COMP)
        mood = MOOD_VOCAB.get(block, _DEFAULT_MOOD)
        # 문구는 자기 태그(comp·mood) + 실측 신호를 인용한다(grounded). '#N 위치' 같은
        #   숫자-한글 인접('1위' 등 절대어)과 충돌하지 않도록 'N번째 컷'(1-index)으로 표기.
        if from_main:
            # main 폴백 문구: detail 의 '사례 상세 N컷 중 M번째 컷'(골든 검증필 안전 표현)을 '사례 이미지' 기준으로 조정.
            #   ('대표'는 drug 도메인 최상급어라 회피.) 자기 태그(comp·mood) 인용 유지(validate:312) · 효능·절대·랭킹어 0(validate:311).
            why = "%s 구도와 %s 무드로 '%s' 블록의 시선 흐름이 또렷하게 읽힌다 (사례 이미지 %d컷 중 %d번째 컷)" % (
                "·".join(comp), "·".join(mood), block, len(files), idx + 1)
        else:
            why = "%s 구도와 %s 무드로 '%s' 블록의 시선 흐름이 또렷하게 읽힌다 (사례 상세 %d컷 중 %d번째 컷)" % (
                "·".join(comp), "·".join(mood), block, sig["detail_image_count"], idx + 1)
        out.append({
            "id": "%s#%02d" % (example_id, idx),
            # src=크롤 사례 경로(분석/추적 전용). inputs/assets/(디자인 자산) 패턴과 충돌하지 않음(저작권 부록A-4).
            "src": "%s/%s" % (src_dir, files[idx]),
            "block_type": block,
            "similarity": round(max(0.3, 0.9 - 0.07 * idx), 2),
            "composition_tags": list(comp),
            "mood_tags": list(mood),
            "why": why,
            "rights": "reference_only_no_pixel_copy",
        })
    return out


def _why_good(sig, voc):
    out = []
    dr = sig.get("discount_rate")
    if dr and dr >= 20:
        out.append({"claim": "원가 대비 강한 할인율로 가격 매력을 전면에 세운다",
                    "grounded_in": ["discount_rate", "price_original"],
                    "confidence": "high" if dr >= 30 else "medium"})
    rating = sig.get("rating")
    if rating and sig["review_count"] >= 100 and rating >= 4.5:
        out.append({"claim": "높은 평점과 다수 리뷰로 사회적 증거가 강하다",
                    "grounded_in": ["rating", "review_count"], "confidence": "high"})
    pr = sig.get("photo_review_ratio")
    if pr and pr >= 0.3:
        out.append({"claim": "포토리뷰 비율이 높아 실사용 신뢰가 형성된다",
                    "grounded_in": ["photo_review_ratio"], "confidence": "high" if pr >= 0.5 else "medium"})
    rr = sig.get("repurchase_ratio")
    if rr and rr >= 0.1:
        out.append({"claim": "재구매 비율이 유의미해 반복 수요가 있다",
                    "grounded_in": ["repurchase_ratio"], "confidence": "medium"})
    if voc:
        out.append({"claim": "소비자가 '%s' 등 사용경험 언어를 반복적으로 언급한다" % voc[0]["phrase"],
                    "grounded_in": ["voc_themes"], "confidence": "medium"})
    if sig["detail_image_count"] >= 20:
        out.append({"claim": "상세 구성이 풍부해 정보 밀도가 높다",
                    "grounded_in": ["detail_image_count"], "confidence": "low"})
    return out


def analyze_example(example_dir, domain):
    sig, pj, rows = _signals(example_dir)
    voc = _voc_themes(rows)
    example_id = os.path.basename(os.path.normpath(example_dir))
    structure = _structure(sig)
    return {
        "example_id": example_id,
        "source": {
            "site": pj.get("site", "unknown"),
            "product_id": str(pj.get("productId", "")),
            "url": pj.get("url", ""),
            "collected_at": pj.get("collectedAt", ""),
        },
        "regulatory_domain": domain,
        "signals": sig,
        "voc_themes": voc,
        "structure": structure,
        "why_good": _why_good(sig, voc),
        "reference_images": _reference_images(example_id, example_dir, structure, sig),
        "analyzed_by": "examples_analysis.py (deterministic)",
    }


def synthesize_reference_notes(analyses, domain):
    """결정적 '크롤 참조 노트' scaffold(객관 분석 기반 — 효능·VOC 미포함 → 심의 안전).
       (구 '유사점 3안 추출'을 대체.) 실제 현업 자유텍스트는 실엔진(prompts/guideline.md)이 채우고,
       stub/오프라인은 사례의 전개순서(block_sequence)·구도/무드(whitelist 태그)만 골격으로 정리한다.
       flow_refs/composition_notes 는 구조·시각 어휘만 담아 banned/효능어가 새지 않는다(법=룰셋 우선)."""
    ids = [a["example_id"] for a in analyses]
    flow_refs = []
    for a in sorted(analyses, key=lambda x: x["example_id"]):
        seq = (a.get("structure") or {}).get("block_sequence") or []
        if seq:
            flow_refs.append("사례 %s 전개 순서 참고: %s" % (a["example_id"], " → ".join(seq)))
    comp = []
    for a in sorted(analyses, key=lambda x: x["example_id"]):
        for r in (a.get("reference_images") or []):
            ct = ", ".join(r.get("composition_tags") or [])
            mt = ", ".join(r.get("mood_tags") or [])
            if ct or mt:
                comp.append("%s: 구도[%s] 무드[%s]" % (r.get("id", ""), ct, mt))
    notes = ("크롤 사례 %d건의 전개 순서·구도/무드를 참조 골격으로 정리했습니다(자유텍스트). "
             "스토리라인·아웃라인·이미지 생성 시 이 참조를 반영하세요(soft 권고; 법=룰셋 우선, 효능·절대 표현 금지)." % len(analyses))
    return {
        "regulatory_domain": domain,
        "examples_analyzed": ids,
        "flow_refs": flow_refs,
        "composition_notes": comp,
        "notes": notes,
        "source": {"from": "inputs/examples/*", "synthesized_by": "examples_analysis.py (deterministic)"},
    }


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("사용법: examples_analysis.py <out_dir> <domain> <example_dir> [<example_dir> ...]\n")
        sys.exit(1)
    out_dir, domain, ex_dirs = sys.argv[1], sys.argv[2], sys.argv[3:]
    analyses = []
    for ed in sorted(ex_dirs):
        a = analyze_example(ed, domain)
        atomic_write_json(os.path.join(out_dir, "examples", a["example_id"], "example-analysis.json"), a)
        analyses.append(a)
    # 구 '유사점 3안 + 추천'(파기) → 단일 '크롤 참조 노트'. 현업이 select 로 1안 고르는 대신, 참조 입력만 받아 다운스트림이 참조.
    notes = synthesize_reference_notes(analyses, domain)
    atomic_write_json(os.path.join(out_dir, "reference-notes.json"), notes)
    print("[examples-analysis] %d개 사례 → example-analysis + 크롤 참조 노트(reference-notes) (domain=%s)" % (len(analyses), domain))


if __name__ == "__main__":
    main()
