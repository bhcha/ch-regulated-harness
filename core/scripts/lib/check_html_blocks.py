#!/usr/bin/env python3
"""check_html_blocks.py — 키비주얼 옵션 HTML 전수 스캔: 포맷 금지 블록(data-block) 결정적 차단 (RCA 8-1.4).

왜 HTML 전수 스캔인가: design-manifest 는 '선택안 섹션'만 기록하므로 비선택 B/C 옵션의 금지 블록이 사각이다.
전 옵션 options/*/index.html 의 data-block 속성을 스캔해 그 run 포맷의 disallowed_blocks(format-profiles)에 걸리면
fail-closed(LLM 편차·ADK 가용성과 무관한 결정적 방어선). stub multipage_bm 캐논에는 cta/footer 가 없어 골든 무영향.

가격 단일출처 가드도 같은 스캐너에 동거(RCA 8-1.5, AGENTS 6번 절 = 모든 정량 수치 단일출처 voc.json·본문 하드코딩 금지).
'숫자+원' 하드코딩 가격을 plan 카피 필드(03)와 옵션 HTML 가시 텍스트(04)에서 찾아 **voc offer.price 값-대조** —
일치 = 통과(정식 공급값), 불일치·offer 부재 = fail-closed. 이 사고(9,900원 cta)의 본 방어선은 disallowed_blocks 이고
가격 가드는 심층 방어다(RCA 8-2 순서 불변).

stdlib 전용(외부 import 0개 — image_engine 규약).

사용:
  check_html_blocks.py <options_dir> [run_dir]   # 옵션 HTML 스캔: 금지 블록 + 가격 단일출처(04·render-design)
  check_html_blocks.py --plan-price <run_dir>    # plan 카피 필드 가격 단일출처 스캔(03-storyboard 게이트 전용)
  - options_dir: <run_dir>/04-keyvisual/options
  - run_dir 미지정 시 options_dir 에서 유추(dirname 2단계 상위 = run_dir; 예 .../04-keyvisual/options → run_dir).
확장점: main() 은 독립 스캐너를 함수별로 조립한다 — check_disallowed_blocks 와 나란히 check_* 함수를 만들어
  main 의 `bad += ...` 체인에 이어붙인다(가격 스캐너 = 이 확장점의 첫 사례).
exit 1 = 위반.
"""
import sys, os, json, re
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# check_canon_coverage.py 와 동일한 FORMATS_DIR 해석(packs/_format).
PACKS_DIR = os.environ.get("PACKS_DIR") or os.path.join(os.path.dirname(ROOT), "packs")
FORMATS_DIR = os.environ.get("FORMATS_DIR") or os.path.join(PACKS_DIR, "_format")


class _BlockAttrParser(HTMLParser):
    """실제 시작 태그의 data-block 속성값만 수집. 원문 정규식 스캔과 달리 <style> 안 CSS 선택자
    (예: [data-block="cta"]{})·HTML 주석 안의 data-block 을 태그 속성으로 오인하지 않는다(외부리뷰 P2 오탐 차단).

    ⚠ 의도적 범위: '블록' 판정은 data-block 속성으로만 한다(raw 시맨틱 태그 이름은 보지 않는다). 이유 —
    disallowed 에는 실제 HTML 태그와 겹치는 이름(header/nav)이 있는데, 이를 태그 단위로 잡으면
    정당한 블록 안의 시맨틱 자식 래퍼(예: <section data-block="hero"><header><h1>…</h1></header></section>)까지
    오탐한다(키비주얼 프롬프트는 블록을 section[data-block] 로만 요구할 뿐 자식 시맨틱 태그를 금지하지 않음).
    이 파이프라인의 블록은 render.py 가 언제나 [data-block] 섹션으로 렌더하므로(전 런 raw header/nav 0건 실측),
    data-block 스캔만으로 '블록' 표현은 결정적으로 잡힌다. 오탐(정상 HTML 차단)이 이 게이트가 못 잡는
    이론상 raw 크롬 우회보다 나쁘다 — 그래서 data-block-only 로 확정(외부리뷰 5↔6 라운드 상반 지적의 정합 해법)."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []   # data-block 속성값

    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k.lower() == "data-block" and v and v.strip():
                self.blocks.append(v.strip())

    handle_startendtag = handle_starttag   # <x .../> 자기닫힘 태그도 동일 처리


class _VisibleTextParser(HTMLParser):
    """가시 텍스트 노드만 수집(태그명·속성값·<style>/<script> 내부 제외). 가격 정규식이 CSS·스크립트·
    속성 안의 숫자를 오탐하지 않도록 style/script 구간은 건너뛴다(원문 정규식 스캔 대비 안전)."""
    _SKIP = {"style", "script"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.texts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self._SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0 and data and data.strip():
            self.texts.append(data)


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _run_format(rdir):
    """run 의 선언 포맷(state.product.deliverable_format). 부재/오류 → multipage_bm(후방호환)."""
    try:
        return (_load_json(os.path.join(rdir, "state.json")).get("product") or {}).get("deliverable_format") or "multipage_bm"
    except Exception:
        return "multipage_bm"


def _disallowed(rdir):
    """포맷별 금지 블록 집합(format-profiles.formats.<fmt>.disallowed_blocks). 부재/오류 → 빈 집합(가법 게이트)."""
    try:
        fp = _load_json(os.path.join(FORMATS_DIR, "format-profiles.json"))
        db = (((fp.get("formats") or {}).get(_run_format(rdir))) or {}).get("disallowed_blocks") or []
        return set(db)
    except Exception:
        return set()


def check_disallowed_blocks(options_dir, rdir):
    """전 옵션 HTML 의 data-block 이 포맷 disallowed_blocks 에 걸리면 위반 문자열 목록 반환([] = clean)."""
    disallowed = _disallowed(rdir)
    if not disallowed or not os.path.isdir(options_dir):
        return []
    dis_lower = {d.lower() for d in disallowed}   # 대소문자 우회 차단(예: data-block="CTA" 가 'cta' 금지 통과 방지)
    bad = []
    for root, _dirs, fnames in os.walk(options_dir):
        for fn in sorted(fnames):
            if not fn.endswith(".html"):
                continue
            fp = os.path.join(root, fn)
            try:
                text = open(fp, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            parser = _BlockAttrParser()
            parser.feed(text)
            rel = os.path.relpath(fp, options_dir)
            # data-block 속성값이 금지 블록이면 차단(블록 판정은 data-block 으로만 — 위 파서 docstring 의 의도적 범위).
            for b in sorted(f for f in set(parser.blocks) if f.lower() in dis_lower):
                bad.append("%s: 포맷 금지 블록 data-block='%s' (이 포맷에서 허용되지 않음)" % (rel, b))
    return bad


# ── 가격 단일출처 가드 (RCA 8-1.5 · AGENTS 6번 절) ────────────────────────────────
# '숫자+원' 하드코딩 가격을 voc offer.price 와 값-대조: 일치=통과(정식 공급값), 불일치·offer 부재=위반.
# 판별 기준 = '금액 규모'(외부리뷰 P2 오탐/누락을 한 번에 해소 — 한글 조사/어미 lookahead 로는 원칙↔원입니다 를 못 가름):
#   통화 금액으로 인정 = (a) 천단위 콤마 금액(9,900 / 12,345) 또는 (b) 3자리 이상 정수(9900 / 1000 / 10000).
#   그 뒤 '원' 이 오면 뒤에 무엇이 붙든(입니다·에·부터·짜리·./공백·끝) 매칭 → '9900원입니다'·'9,900원에' 등 조사/어미형도 잡음.
#   '3원칙'·'5원칙'(1자리 카운트+단어)·'원료'·'안전관리원'(원 비-숫자선행)·'15g'·'10000ppm'('원' 없음)은 미매치.
#   근거: KRW 상세페이지 제품가는 사실상 ≥1000(3자리+)이고, 원칙/원료류 오탐은 1~2자리 카운트라 규모로 분리된다.
#   캡처그룹 없음(findall=전체매치).
_PRICE_RE = re.compile(r"(?:\d{1,3}(?:,\d{3})+|\d{3,})\s*원")


def _voc_offer_price(rdir):
    """00-ingest/voc.json 의 offer.price → (has_price, price:int|None).
    offer 부재 또는 price 키 없음(=추적 불가) → (False, None): 발견 가격은 모두 하드코딩 위반.
    price 존재 → (True, int): 값-대조로 일치할 때만 통과."""
    try:
        offer = (_load_json(os.path.join(rdir, "00-ingest", "voc.json")) or {}).get("offer")
    except Exception:
        return (False, None)
    if not isinstance(offer, dict) or "price" not in offer:
        return (False, None)
    try:
        return (True, int(offer["price"]))
    except (TypeError, ValueError):
        return (False, None)


def _price_value(match):
    """매치 문자열('9,900원')에서 숫자만 뽑아 정수로. 실패 → None."""
    digits = re.sub(r"[^\d]", "", match)
    return int(digits) if digits else None


def _scan_price(text, has_price, price):
    """text 에서 '숫자+원' 을 찾아 voc offer.price 와 값-대조. 위반(비일치/추적불가) 매치 문자열 목록 반환([]=clean)."""
    bad = []
    for m in _PRICE_RE.findall(text or ""):
        val = _price_value(m)
        if has_price and val is not None and val == price:
            continue   # voc offer.price 와 일치 = 단일출처 추적 가능(정당한 가격 노출 보존)
        bad.append(m.strip())
    return bad


def _plan_copy_texts(b):
    """plan 블록의 카피 필드 — kcia_engine._block_scan_texts 범위 미러(headline/subcopy/bodyText/
    footnotes[].text/claims[].target_text/callouts). 가격 하드코딩 스캔 대상은 '가시 카피'만이므로
    visual.concept 등 내부 디자인 디렉션 필드는 제외한다(RCA 8-1.5 열거 그대로)."""
    out = [b.get("headline", ""), b.get("subcopy", "")]
    out += list(b.get("bodyText") or [])
    out += [(f.get("text") or "") for f in (b.get("footnotes") or [])]
    out += [c.get("target_text", "") for c in (b.get("claims") or [])]
    out += list(((b.get("visual") or {}).get("chart_data") or {}).get("callouts") or [])
    return [t for t in out if t]


def check_hardcoded_price_plan(rdir):
    """03-storyboard/plan/*.json 카피 필드의 하드코딩 가격(voc offer.price 불일치) 위반 목록 반환([]=clean)."""
    plan_dir = os.path.join(rdir, "03-storyboard", "plan")
    if not os.path.isdir(plan_dir):
        return []
    has_price, price = _voc_offer_price(rdir)
    bad = []
    for fn in sorted(os.listdir(plan_dir)):
        if not fn.endswith(".json"):
            continue
        try:
            b = _load_json(os.path.join(plan_dir, fn))
        except Exception:
            continue
        if not isinstance(b, dict):
            continue
        for t in _plan_copy_texts(b):
            for hit in _scan_price(t, has_price, price):
                bad.append("03-storyboard/plan/%s: 카피에 하드코딩 가격 '%s' (voc offer.price 단일출처 위반 — AGENTS 6번 절)" % (fn, hit))
    return bad


def check_hardcoded_price_html(options_dir, rdir):
    """전 옵션 options/*/index.html 가시 텍스트의 하드코딩 가격(voc offer.price 불일치) 위반 목록 반환([]=clean).
    태그 제거 후 가시 텍스트만 스캔(CSS/스크립트/속성 내부 숫자 오탐 방지)."""
    if not os.path.isdir(options_dir):
        return []
    has_price, price = _voc_offer_price(rdir)
    bad = []
    for root, _dirs, fnames in os.walk(options_dir):
        for fn in sorted(fnames):
            if not fn.endswith(".html"):
                continue
            fp = os.path.join(root, fn)
            try:
                text = open(fp, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            parser = _VisibleTextParser()
            parser.feed(text)
            rel = os.path.relpath(fp, options_dir)
            # 텍스트 노드별로 스캔한다(전체 결합 금지). 결합하면 무관한 인접 노드가 이어져 '큰숫자 + 원-단어' 오탐이
            #   생긴다(예: '리뷰 9,900' 노드 + '원료' 라벨 노드 → '9,900 원료' → 가격 오검, 외부리뷰 P2). 한 노드 안의
            #   자연스러운 카피는 '9,900원입니다' 처럼 숫자와 원이 붙어 있어 정상 검출된다. 요소로 쪼갠 가격
            #   (<strong>12,345</strong>원)의 04 검출은 포기하되(희소·HTML 직접작성 한정) 그 값은 03 plan 카피 스캔과
            #   disallowed 게이트가 이미 잡는다(심층 방어라 허용되는 트레이드오프 — RCA 8-2 순서).
            for chunk in parser.texts:
                for hit in _scan_price(chunk, has_price, price):
                    bad.append("%s: 가시 텍스트에 하드코딩 가격 '%s' (voc offer.price 단일출처 위반 — AGENTS 6번 절)" % (rel, hit))
    return bad


def main():
    argv = sys.argv[1:]
    # --plan-price <run_dir>: plan 카피 필드 가격 단일출처 스캔 전용(03-storyboard 게이트에서 호출; HTML 스캔과 분리해 04 이중스캔 회피).
    if argv and argv[0] == "--plan-price":
        if len(argv) < 2:
            sys.stderr.write("사용: check_html_blocks.py --plan-price <run_dir>\n")
            sys.exit(2)
        rdir = os.path.abspath(argv[1])
        bad = check_hardcoded_price_plan(rdir)
        if bad:
            sys.stderr.write("[기획안 가격 단일출처 검증 실패]\n" + "\n".join("  - " + b for b in bad) + "\n")
            sys.exit(1)
        print("[기획안 가격 단일출처 검증 통과]")
        return

    if not argv:
        sys.stderr.write("사용: check_html_blocks.py <options_dir> [run_dir] | --plan-price <run_dir>\n")
        sys.exit(2)
    options_dir = argv[0]
    # run_dir: 명시 인자 우선, 없으면 options_dir(.../04-keyvisual/options)에서 2단계 상위로 유추.
    rdir = argv[1] if len(argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(options_dir)))

    bad = []
    bad += check_disallowed_blocks(options_dir, rdir)
    # 확장점 첫 사례: HTML 가시 텍스트 가격 단일출처 스캔(plan 카피는 03 게이트의 --plan-price 로 분리 → 04 이중스캔 없음).
    bad += check_hardcoded_price_html(options_dir, rdir)

    if bad:
        sys.stderr.write("[키비주얼 HTML 금지요소 검증 실패]\n" + "\n".join("  - " + b for b in bad) + "\n")
        sys.exit(1)
    print("[키비주얼 HTML 금지요소 검증 통과]")


if __name__ == "__main__":
    main()
