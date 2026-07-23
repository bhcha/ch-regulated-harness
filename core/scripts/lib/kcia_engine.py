#!/usr/bin/env python3
"""kcia_engine.py — 결정적 심의 룰엔진 + evidence 존재성 검증 (설계 §8.3/§8.5).

역할:
 - ruleset.json 4축(banned/conditional/triggers)을 정규식·부분문자열로 매칭.
 - severity high(금지어·미승인 기능성 효능·속효/절대표현)는 LLM 없이 무조건 revise.
 - evidence 존재성: claim_strength ∈ {superlative,efficacy,speed} 인 claim 은
   evidence_ref 가 '실재 id'(claim-basis evidence + sources results)와 1:1 매칭되고
   대응 footnote 가 있어야 한다. 아니면 가짜 id → revise (가짜 통과 0건).

이 엔진은 B3 '룰엔진 baseline'이자 오프라인 심의 stand-in. 실 서브에이전트(KCIA_CRITIC_CMD)는
kcia-check.sh 에서 이 엔진 위에 추가된다.

사용:
  kcia_engine.py <run_id> <run_dir> <out_verdict.json> [--engine NAME] [--text TXT [--axis-hint ..]]
  (또는 단일 텍스트 검사: --text 만 주면 그 텍스트의 violations 만 stdout JSON 으로)
"""
import sys, os, json, re, unicodedata
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, atomic_write_json, storyboard_substage, PACKS_DIR, FORMATS_DIR, deliverable_format, is_number as _is_num, regulatory_domain  # noqa: E402
from clinical_chart import derive_chart, numbers_consistent, metric_matches_claim  # noqa: E402  (도출·숫자·지표 단일 출처)


class _HTMLText(HTMLParser):
    """최종 HTML 의 '사용자 노출' 텍스트 수집: text node + 노출 속성(alt/title/aria 등).
    style/script 내부 CSS/JS 는 노이즈라 제외(단, content: 등 CSS 텍스트도 보고 싶으면 확장)."""
    _ATTRS = {"alt", "title", "aria-label", "aria-description", "placeholder", "value"}

    _HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.texts = []
        self.hook_texts = []       # heading(h1~h6) 텍스트/속성 = 키비주얼 훅 → P-3 zero_voc 면제 절대 제외(Codex W1c b·8R)
        # 문단(블록경계) 집계 — 인라인 마크업(<p>여드름성 피부 <strong>사용에 적합…</strong></p>)으로 쪼개진 노드를
        #   블록 경계 단위로 묶는다. P-3 키비주얼 면제는 이 '문단 집계'에 require_full 을 적용해야 인라인 분할 본문을
        #   놓치지 않는다(Codex 9R). paragraphs = [(nodes:list[str], is_heading:bool)].
        self.paragraphs = []
        self._para = []
        self._skip = 0
        self._heading = 0

    def _flush_para(self):
        if self._para:
            self.paragraphs.append((list(self._para), self._heading > 0))
            self._para = []

    def _collect_attrs(self, attrs):
        # 노출 속성 + data-*(CSS content:attr(data-*) 로 화면 노출 가능) → 전부 scan(fail-closed).
        #   heading(h1~h6) 안(자신의 속성 포함)에서 노출되는 속성 텍스트는 hook 으로도 기록 → P-3 면제 제외(Codex 8R).
        for k, v in attrs:
            if (k in self._ATTRS or k.startswith("data-")) and v and v.strip():
                s = v.strip()
                self.texts.append(s)
                if self._heading:
                    self.hook_texts.append(s)

    def handle_starttag(self, tag, attrs):
        if tag in _BLOCK_TAGS:      # 블록 시작 = 문단 경계(직전 문단 flush)
            self._flush_para()
        # ★ heading 깊이를 '속성 수집 전에' 올린다 — h1 자신의 aria-label/title/alt/data-* 속성도 hook 으로 잡기 위해(Codex 8R).
        if tag in self._HEADINGS:
            self._heading += 1
        self._collect_attrs(attrs)
        if tag in ("style", "script"):
            self._skip += 1

    def handle_startendtag(self, tag, attrs):
        if tag in _BLOCK_TAGS:      # 자기닫힘 블록(<br/> 등) = 문단 경계
            self._flush_para()
        # 자기닫힘(void) 요소: 부모 heading 깊이(_heading)가 이미 반영돼 있으므로 _collect_attrs 가 hook 여부를 판정.
        self._collect_attrs(attrs)

    def handle_endtag(self, tag):
        if tag in _BLOCK_TAGS:      # 블록 끝 = 문단 경계(heading 깊이 내리기 '전'에 flush → is_heading 보존)
            self._flush_para()
        if tag in ("style", "script") and self._skip > 0:
            self._skip -= 1
        if tag in self._HEADINGS and self._heading > 0:
            self._heading -= 1

    def handle_data(self, data):
        if self._skip:
            return
        s = data.strip()
        if s:
            self.texts.append(s)
            self._para.append(s)
            if self._heading:
                self.hook_texts.append(s)

    def close(self):
        super().close()
        self._flush_para()          # 말단(닫힘 없는) 문단 flush   # heading 안 텍스트 = 훅(면제 제외)


# 블록 레벨 태그(시각적 줄/영역 경계) — 인접 텍스트가 한 단어로 안 읽힌다. 인라인(span/b/i/sup…)은 공백 없이 연결.
_BLOCK_TAGS = {"div", "p", "br", "hr", "li", "ul", "ol", "tr", "td", "th", "table", "section", "article",
               "header", "footer", "nav", "aside", "main", "h1", "h2", "h3", "h4", "h5", "h6",
               "blockquote", "pre", "figure", "figcaption", "dd", "dt", "dl", "form", "fieldset", "address",
               "caption", "legend", "summary", "details", "option", "button", "dialog", "menu",
               "thead", "tbody", "tfoot", "colgroup", "optgroup", "output"}


# 텍스트 미렌더 서브트리(화면 비노출) — 제품명 '가시 노출' 검사에서 제외(코덱스 단계2 6R H1).
#   head/title/meta = 본문 아님(<title>제품A정</title> 만으로 충족되던 fail-open), template/noscript = 비활성, style/script = 코드.
_SKIP_SUBTREE_TAGS = {"style", "script", "head", "title", "template", "noscript", "datalist"}
# void 요소(종료태그 없음) — 스택에 push 하지 않는다(미닫힘으로 스택 깨짐 방지).
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class _RenderedText(HTMLParser):
    """실제 화면 렌더에 가까운 '가시' 텍스트 복원 — 인라인 노드는 공백 없이 '연결', 블록 경계(div/p/h*/br/li/td…)에는 줄바꿈('\\n').
    gather/_HTMLText 는 모든 텍스트 노드를 일괄 공백결합해서 '제품A<span>정</span>'(=제품A정)와
    '<span>제품A정</span><span>플러스</span>'(=제품A정플러스)를 구분 못 한다 → 필수기재 제품명 검사에서
    내부 split fail-positive 와 경계 split fail-open 이 동시에 발생(코덱스 단계2 3R). 충실 렌더는 둘을 구분한다.
    블록 경계는 인라인 공백과 구분되는 '\\n' 로 — 이름 매처가 블록을 넘나들며 흩어진 글자를 합성('<h1>우</h1><p>루</p>')하는
    fail-open 차단(코덱스 5R). handle_data 는 HTML 흐름처럼 공백런을 1칸으로 축약(인라인 공백 신호만 보존, 노출 텍스트만; 속성 제외).
    ★ 미렌더/숨김(head/title/template/noscript · hidden · aria-hidden=true · display:none · visibility:hidden) 서브트리는 수집 제외 —
    필수기재는 '가시 노출' 기준. <title> 등 비노출 텍스트로 제품명 충족되던 fail-open 차단(코덱스 6R H1).
    (주의: gather/_HTMLText 는 금지어 스캔용이라 숨김 텍스트도 수집한다 — fail-closed. 여긴 제품명 '노출' 검사라 가시만.)"""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._stack = []          # 열린 비-void 요소 태그 스택
        self._hide_depth = None   # 숨김 시작 스택깊이(이하로 닫히면 해제); None=가시

    @staticmethod
    def _is_hidden(tag, attrs):
        # 인라인 마크업으로 판정 가능한 비노출. (코덱스 7R Medium 일부 폐쇄; class/계산CSS 의존 sr-only·clip·off-screen·
        #   font-size:0·color:transparent 은 정적 추출 한계로 수용 잔여 — fail-closed 아닌 fail-open 측이나 의도적 조작 필요.)
        d = {(k or "").lower(): (v or "") for k, v in attrs}
        if "hidden" in d:
            return True
        if d.get("aria-hidden", "").strip().lower() == "true":
            return True
        if tag in ("dialog", "details") and "open" not in d:
            return True   # open 없는 dialog/details = 화면 비표시(본문) — 템플릿서 우연 발생 가능(코덱스 7R)
        st = re.sub(r"\s+", "", d.get("style", "")).lower()
        if "display:none" in st or "visibility:hidden" in st or "visibility:collapse" in st:
            return True
        return bool(re.search(r"opacity:0(?:\.0+)?(?:;|!|$)", st))   # 인라인 opacity:0(투명)

    def _boundary(self, tag):
        if self._hide_depth is None and tag in _BLOCK_TAGS:
            self.parts.append("\n")   # 가시 상태에서만 블록 경계('\n', 인라인 공백 ' ' 와 구분 — 이름 매처가 넘지 못함)

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        hide_here = tag in _SKIP_SUBTREE_TAGS or self._is_hidden(tag, attrs)
        if tag not in _VOID_TAGS:
            self._stack.append(tag)
            if hide_here and self._hide_depth is None:
                self._hide_depth = len(self._stack)   # 이 요소부터 숨김 시작
        self._boundary(tag)                           # (숨김이면 _boundary 가 자체적으로 스킵)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if not self._is_hidden(tag, attrs) and tag not in _SKIP_SUBTREE_TAGS:
            self._boundary(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        self._boundary(tag)                           # pop 전(가시면) 닫힘 경계
        if tag in self._stack:                        # 매칭 종료까지 pop(말단 미닫힘 허용)
            while self._stack:
                t = self._stack.pop()
                if self._hide_depth is not None and len(self._stack) < self._hide_depth:
                    self._hide_depth = None           # 숨김 루트 닫힘 → 가시 복귀
                if t == tag:
                    break

    def handle_data(self, data):
        if self._hide_depth is not None:
            return
        self.parts.append(re.sub(r"\s+", " ", data))   # HTML 흐름 공백 축약(런→1칸). 인라인 split 은 공백 0, 소스 공백은 1칸

    def text(self):
        return "".join(self.parts)


def _decode_css_escapes(s):
    """CSS unicode escape(\\BBF8 등)를 실제 문자로 디코드 — '\\BBF8\\BC31'(효능어) 우회 차단.
    범위초과(>0x10FFFF) 코드포인트는 chr() 가 ValueError 라 엔진이 죽는다(코덱스 단계2 5R Medium) → 빈문자로 무시(fail-safe)."""
    def _rep(m):
        try:
            cp = int(m.group(1), 16)
            return chr(cp) if cp <= 0x10FFFF else ""
        except (ValueError, OverflowError):
            return ""
    return re.sub(r"\\([0-9a-fA-F]{1,6})\s?", _rep, s or "")


def _css_content_literals(text):
    """CSS content:"..." / '...' 문자열 추출(CSS escape 디코드) — ::before/::after 등 화면 노출 텍스트(심의 대상)."""
    out = []
    for m in re.finditer(r"content\s*:\s*(\"([^\"]*)\"|'([^']*)')", text or "", re.I):
        s = m.group(2) if m.group(2) is not None else m.group(3)
        s = _decode_css_escapes(s).strip()
        if s:
            out.append(s)
    return out

# PACKS_DIR·FORMATS_DIR: harness 에서 import (K-1 일원화 — core/ 형제 packs/ 및 packs/_format 해석 단일 출처. PACKS_DIR env 재정의는 harness 가 존중).
# (2부 1단계) 레거시 폴백 폐지: harness/regulatory-domains.json · docs/regulation/ruleset.json ·
#   registry default→cosmetic 은 모두 제거됐다. packs/ 가 유일한 도메인 레지스트리 SSoT 이고,
#   미선언·미등록 도메인은 cosmetic 으로 조용히 폴백하지 않고 fail-closed(미완·미등록 룰셋) 한다.


# 허용 도메인 status enum(레지스트리 게이트) — active=실심의, tbd/ready-only=의도된 placeholder-autopass.
#   이 집합 밖 값(오타·공백·대소문자·미정의)은 '손상'으로 fail-closed(코덱스 단계3 R5: autopass 우회 차단). 새 status 는 통제 추가.
_VALID_STATUS = {"active", "tbd", "ready-only"}


def _pack_ruleset_path(domain):
    return os.path.join(PACKS_DIR, domain, "ruleset.json")


def _load_learned_deny(domain, stage):
    """packs/<도메인>/learned/deny.json 의 '이 단계 적용' 학습 금지어(없으면 []) — Seam F 심의-측 결정 집행.
       build_context 의 생성 선차단(_pack_learned_deny)과 **이중**(생성 회피 + 심의 결정 차단). **부재 = []**(골든
       무영향). malformed(top-level 비-dict·applies_to 비-list) 방어 no-op. ⚠ 학습 어휘는 룰엔진(결정)에만 —
       원격 ADK 크리틱엔 주입 안 함(자기참조 게이밍 차단)."""
    if not domain or not stage:
        return []
    p = os.path.join(PACKS_DIR, domain, "learned", "deny.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    ents = data.get("entries")
    if not isinstance(ents, list):    # entries 비-list(예 1) → TypeError 방어(Codex High)
        return []
    out = []
    for e in ents:
        if not isinstance(e, dict) or e.get("kind") != "deny":
            continue
        ap = e.get("applies_to")
        if not isinstance(ap, list):
            continue
        t = e.get("term")
        if isinstance(t, str) and t and (stage in ap or "all" in ap):   # term 비-string(_match 크래시) 방어
            out.append(t)
    return out


def load_domain_registry():
    """규제도메인 레지스트리 조립 — packs/*/domain.json 이 유일 SSoT(2부 1단계: 레거시 폴백 폐지).
    마이크로커널: 새 도메인 = packs/<도메인>/domain.json 추가만으로 자동 등록(core 무수정).
    반환 {default:None(default→cosmetic 메커니즘 폐지), domains:{<dom>:{...필드, ruleset_path:절대경로|None}}}."""
    domains = {}
    if os.path.isdir(PACKS_DIR):
        for name in sorted(os.listdir(PACKS_DIR)):
            pdir = os.path.join(PACKS_DIR, name)
            dj = os.path.join(pdir, "domain.json")
            if not os.path.isdir(pdir) or not os.path.exists(dj):
                continue
            try:
                raw = load_json(dj)
            except Exception:
                raw = None
            e = dict(raw) if isinstance(raw, dict) else {}
            # 유효 팩 = JSON '객체'(dict) + status ∈ 허용 enum + domain==디렉터리명. 하나라도 어긋나면 '손상'(코덱스 단계3 R2/R3/R5 High·Medium):
            #   ① dict 강제(pair-list 배열의 dict 승격 차단) ② status enum(문자열 'foo'·'active '(공백)·'ACTIVE' 등 미정의값 → 손상; 오타 autopass 차단)
            #   ③ 디렉터리명을 도메인 id 로 신뢰(파일 내 domain 키 위조/누락 무력화). 손상 → incomplete·ruleset_path=None·default 무시·status="" → 상위 fail-closed(cosmetic 오폴백·autopass 금지).
            dom = name
            #   status 는 반드시 str 후 enum 검사(코덱스 단계3 R6 Medium: 배열/객체 status 가 'x in set' 에서 TypeError →
            #   레지스트리 전체 크래시. isinstance(str) 단락으로 차단 — 나쁜 팩 하나는 자신만 incomplete, 타 도메인 로드 유지).
            broken = not (isinstance(raw, dict) and isinstance(e.get("status"), str)
                          and e.get("status") in _VALID_STATUS and e.get("domain") == name)
            rp = _pack_ruleset_path(dom)
            e["domain"] = dom
            e["ruleset_path"] = (rp if (os.path.exists(rp) and not broken) else None)
            if broken:
                e["incomplete"] = True
                e["status"] = ""   # 손상 팩 status 무효화(문자열 'tbd' 라도) → 비active·비autopass. shell domain_field 가 이 값을 읽어 active 기본→엔진 fail-closed(코덱스 단계3 R4).
            domains[dom] = e
    # packs/ 단일 SSoT — 레거시 레지스트리(regulatory-domains.json)·default→cosmetic 폴백 폐지(2부 1단계).
    #   빈/미등록 레지스트리는 default=None → 상위(load_ruleset·new-run·kcia-check)가 fail-closed 로 처리.
    return {"default": None, "domains": domains}


def load_ruleset(domain=None):
    """규제도메인 → ruleset.json 로드(packs/<도메인>/ruleset.json; 레지스트리 조립).
    등록됐으나 파일 부재/손상 → 빈(미완) 룰셋(상위 fail-closed).
    ★ '명시 요청' 도메인이 레지스트리에 없으면(팩 손상/누락) cosmetic 으로 조용히 폴백 금지 → 미완 룰셋 fail-closed(코덱스 단계3 R2 High).
    (2부 1단계) domain 미지정(None)도 더는 cosmetic 레거시로 폴백하지 않는다 → fail-closed(미등록·미완 룰셋)."""
    reg = load_domain_registry()
    dom = domain or reg.get("default")   # default 는 이제 항상 None(default→cosmetic 메커니즘 폐지)
    entry = reg.get("domains", {}).get(dom) if dom else None
    if entry is not None:
        rp = entry.get("ruleset_path")
        if rp and os.path.exists(rp):
            return load_json(rp)
        # 등록됐는데 룰셋 파일 부재/손상 → '잘못된 화장품 법' 폴백 금지. 빈(미완) 룰셋(상위 fail-closed).
        return {"meta": {"domain": dom, "incomplete": True}, "axes": {}, "general_principle": ""}
    # 미지정(domain=None) 또는 명시 요청인데 미등록(팩 손상/누락) → cosmetic 조용한 폴백 금지, fail-closed.
    return {"meta": {"domain": dom, "incomplete": True, "unregistered": True}, "axes": {}, "general_principle": ""}


# ── 어휘 사전(legacy 화장품 기본값) ──
# 도메인 룰셋의 axes.lexicon 이 우선. 키 부재 시에만 아래 상수로 폴백(후방호환). 타 도메인은 자기 ruleset 에
# 자기 lexicon 을 둔다(미정의=공집합 → 화장품 어휘 비누출). _lex() 가 이 우선순위를 일원화한다.
# (2부 2단계) 화장품 심의 어휘 상수 공집합화 — 값은 packs/cosmetic/ruleset.json 의 axes.lexicon 이 소유한다.
#   _lex(ruleset,key,상수) 가 도메인 룰셋 lexicon 을 우선 읽고, 이 상수는 '미정의 도메인용 공집합 폴백'(화장품 어휘 비누출)일 뿐이다.
FUNC_EFFICACY = {}          # → axes.lexicon.functional_efficacy
STRONG = {"superlative", "efficacy", "speed"}   # 도메인-중립 claim 강도(어휘 아님, 잔류)
# scan_text 의 substantiation_required '트리거' 위반 rule 문자열(단일 출처).
#   ⚠ check_claim 의 무결성 위반(가짜/누락 근거·각주 부재 등)은 rule 이 달라 차트 억제에서 제외된다(Codex FIX A).
_SUBST_TRIGGER_RULE = "실증 필요 표현(근거 없으면 다운그레이드)"   # 도메인-중립 rule 문자열(잔류)
CONDITION_TARGET = []       # → axes.lexicon.condition_target (추천 타겟 블록 질환/효능 금지어)
PHARMA_AUTHORITY = []       # → axes.lexicon.pharma_authority (브랜드 배너 제약사 권위 금지어)
CONSUMER_DECEPTION_SEVERITY_HIGH = []   # → axes.lexicon.consumer_deception_severity_high (high 심각도 신호)
# 필수기재 항목 id→신호어 레거시 매핑. (2부 2단계) 공집합화 — 활성 도메인(drug)은 모든 required 항목이 signals
#   필드를 선언하므로 이 폴백은 도달 불가(signals-미정의 레거시 룰셋 지원 종료). 신호어는 룰셋 항목 signals 가 소유.
_MI_SIG_LEGACY = {}


def _lex(ruleset, key, fallback):
    """도메인 룰셋 axes.lexicon[key] → 없으면 화장품 레거시 상수(fallback)."""
    lex = ((ruleset.get("axes", {}) or {}).get("lexicon", {}) or {})
    val = lex.get(key)
    return val if val is not None else fallback


class Engine:
    def __init__(self, ruleset, func_status, evidence_ids, zero_voc=None, evidence_details=None,
                 zero_voc_exempt_texts=None, learned_deny=None):
        self.rs = ruleset["axes"]
        self.learned_deny = list(learned_deny or [])   # Seam F: 학습 금지어(부재=[] → 골든 무영향)
        self.func_status = func_status            # {whitening: 'unknown'|'approved'|..}
        self.evidence_ids = set(evidence_ids)     # 실재 근거 id 집합(등급 검증 통과분만)
        self.zero_voc = list(zero_voc or [])      # 리뷰 0건 개념(컨셉 주축 금지)
        # P-3(a안, 좁은 면제): 판정문(test_report verdict_text) 원문에 결박된 카피 문자열 집합 —
        #   이 정확 문자열은 zero_voc 억제에서 면제한다(판정문은 '소비자 수요 개념'이 아니라 시험 결과의 공식 표기).
        #   기본 공집합(면제 없음) → 기존 골든 바이트 불변. 결박은 evaluate()가 계산해 주입한다.
        self.zero_voc_exempt_texts = set(zero_voc_exempt_texts or ())
        # id → 근거 상세 dict (인체적용시험 수치 차트 충족 판정에 사용)
        self.evidence_details = evidence_details or {}
        # 어휘 사전(도메인 룰셋 우선, 화장품 상수 폴백) + 실증 법조항 ref(도메인별)
        self.func_efficacy = _lex(ruleset, "functional_efficacy", FUNC_EFFICACY)
        # 누수#1: consumer_deception high 심각도 신호를 도메인 lexicon 에서(없으면 화장품 상수).
        self.cd_severity_high = _lex(ruleset, "consumer_deception_severity_high", CONSUMER_DECEPTION_SEVERITY_HIGH)
        # 누수#4: 실증 ref 폴백을 화장품법 하드코딩이 아닌 **도메인 법령(ruleset.meta.law)**으로 일반화(도메인 ref 부재 시).
        #   (subst_ref 는 현재 _vio 출력에 실리지 않아 동작엔 무영향이나, 의약품 위반에 화장품법 인용이 새지 않도록 정정.)
        self.subst_ref = (self.rs.get("substantiation_required", {}).get("ref")
                          or (ruleset.get("meta", {}) or {}).get("law") or "")
        # 임상 실증 표기 정책(개인차 디스클레이머·시험맥락 표기 어휘)을 도메인 룰셋에서(없으면 화장품 레거시 기본값).
        self.clinical_subst = _clinical_subst(self.rs)

    def scan_text(self, text, footnote_ids=None):
        """텍스트 1건 → violations[]. 마크다운/공백/숫자 우회에 강건한 매칭(_match)."""
        v = []
        # ① drug_misperception
        for b in self.rs.get("drug_misperception", {}).get("banned", []):
            if _match(text, b):
                v.append(_vio(text, "drug_misperception", self.rs.get("drug_misperception", {}).get("ref", ""),
                              "high", "질병·약리 효능 표방 금지", b))
        # ③ consumer_deception
        for b in self.rs.get("consumer_deception", {}).get("banned", []):
            core = b.split("(")[0]
            if _match(text, core):
                sev = "high" if any(w in core for w in self.cd_severity_high) else "medium"
                v.append(_vio(text, "consumer_deception", self.rs.get("consumer_deception", {}).get("ref", ""),
                              sev, "절대표현/기만 소지", core))
        # ② functional_misperception: 미승인 기능성 효능 표현
        #   general_allowed(브라이트닝/톤업/화사 등)는 FUNC_EFFICACY 에 없으므로 별도 veto 불필요.
        #   '효능어 톤업' 처럼 허용어를 끼워 효능어를 세탁하지 못하도록 전역 veto 를 제거(Codex B3 #B).
        for key, phrases in self.func_efficacy.items():
            for ph in phrases:
                if _match(text, ph) and self.func_status.get(key) != "approved":
                    v.append(_vio(text, "functional_misperception",
                                  self.rs.get("functional_misperception", {}).get("ref", ""), "high",
                                  "기능성 미승인(%s) 효능 표현" % key, ph))
        # ④ substantiation_required: 실증 트리거 (N% 등 숫자 유연 매칭)
        for t in self.rs.get("substantiation_required", {}).get("triggers", []):
            if _match(text, t):
                v.append(_vio(text, "substantiation_required",
                              self.rs.get("substantiation_required", {}).get("ref", ""), "high",
                              _SUBST_TRIGGER_RULE, t))
        # ⑤ 소비자 수요 근거 없는 개념(리뷰 0건): 컨셉 주축 금지
        #   ★ P-3(a안, 좁은 면제): 이 '스캔 텍스트 단위'가 판정문 원문 결박 카피(zero_voc_exempt_texts 에 정확히
        #     포함)면 zero_voc 억제를 건너뛴다 — 판정문은 시험 결과의 공식 표기라 zero_voc 취지(수요 근거 없는
        #     개념 주축 금지) 밖이다. 면제는 결박된 그 카피 한 점뿐 — 헤드라인·컨셉 주축·비결박 동일어는 계속 억제.
        if text not in self.zero_voc_exempt_texts:
            for z in self.zero_voc:
                if _match(text, z):
                    v.append(_vio(text, "consumer_deception", "VOC 근거 없음",
                                  "medium", "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지", z))
        # ⑥ prescription_otc_distinction: 전문의약품 대중광고 신호어(banned) — 텍스트 스캔(의약품 도메인)
        for b in self.rs.get("prescription_otc_distinction", {}).get("banned", []):
            if _match(text, b):
                v.append(_vio(text, "prescription_otc_distinction",
                              self.rs.get("prescription_otc_distinction", {}).get("ref", ""),
                              "high", "전문의약품 대중광고 금지 표현", b))
        # ⑦ LEARNED_DENY(Seam F): 과거 심의 일관 반려·사람승인 승격 학습 금지어의 결정적 집행(생성 선차단의 심의-측
        #   이중). self.learned_deny 부재([]) → 루프 미발동 → 골든 무영향. 룰셋 banned 와 동일 _match 강건 매칭.
        for z in self.learned_deny:
            if _match(text, z):
                v.append(_vio(text, "learned_deny", "학습 금지어(과거 심의 일관 반려·사람승인)",
                              "high", "학습된 금지 표현(사람 승인 승격) — 소비자 카피 사용 금지", z))
        return v

    def check_claim(self, claim, footnote_ids):
        """강주장(efficacy/superlative/speed)의 evidence 존재성 + 각주 페어링(모든 산출물 공통).
        footnote_ids 가 None 이면 '각주 슬롯이 없는 산출물'(예: 컨셉)이므로 강주장 자체를 불허(fail-closed)."""
        v = []
        strength = claim.get("claim_strength")
        ref = claim.get("evidence_ref")
        tgt = claim.get("target_text", "")
        # 강도와 무관하게: 비-null evidence_ref 는 '실재(허용등급·충분)' id 여야 한다(가짜 인용 차단 #3).
        if ref and ref not in self.evidence_ids:
            v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                          "evidence_ref 가 실재 근거 id 와 매칭되지 않음(가짜/불충분/거부등급)", str(ref)))
        if strength in STRONG:
            if not ref or ref not in self.evidence_ids:
                v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                              "강한 주장에 실재 근거 필요(가짜/누락)", str(ref)))
            elif footnote_ids is None:
                # 각주 슬롯이 없는 산출물(컨셉)에서는 강주장 금지 → factual/emotional 로 절제.
                v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                              "이 단계(각주 슬롯 없음)에서는 강한 효능 주장 불가 — 절제 표현 사용", tgt))
            elif not claim.get("footnote_id"):
                v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                              "강한 주장에 각주 필수", tgt))
            elif claim["footnote_id"] not in footnote_ids:
                v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                              "대응 footnote 부재", claim["footnote_id"]))
            # ⚠ Codex FIX KK: 강주장이 '정량 evidence'(derive_chart 가능)를 참조하면 그 문구의 수치/방향이
            #   근거 도출값과 정확히 일치해야 한다. 트리거 문구가 아니어도("수분 +99% 증가") 조작 수치를 잡는다.
            #   rule 은 _SUBST_TRIGGER_RULE 과 다르므로(차트 억제 필터가 절대 제거 못함) — 가짜 수치 통과 0.
            d = derive_chart(self.evidence_details.get(ref)) if ref in self.evidence_ids else None
            if d is not None:
                ok, _n = numbers_consistent(tgt, d)
                if not ok:
                    v.append(_vio(tgt, "substantiation_required", self.subst_ref, "high",
                                  "강주장 수치가 근거 정량값과 불일치", tgt))
        return v

    def _evidence_satisfies(self, ev_id):
        """True iff 근거 '레코드'가 '인체적용시험 수치 차트' 충족 조건 4요소를 모두 갖춤(레코드 한정).
        필수 5요소 중 4개는 근거 레코드에서 검증:
          ① measured_value_pair: (before AND after 둘 다 숫자) OR (series 가 숫자 value 를 가진 항목 '2개 이상')
          ② test_institution: institution 필드(비어있지 않음)
          ③ sample_size_n: sample_size 필드(숫자)
          ④ duration: duration 필드(비어있지 않음)
        5번째 요소(individual_variation_disclaimer)는 근거 레코드가 아니라 블록 카피/각주에 산다 →
        여기서 검사하지 않고 호출부(_block_has_disclaimer)가 블록 레벨로 확인한다.
        ⚠ 하드닝(Codex FIX 2): series 가 [{}] 처럼 숫자 value 없이 truthy 인 경우를 거부한다.
        ⚠ 하드닝(Codex FIX J): '쌍(pair)'이므로 series 는 숫자 value 항목이 2개 이상이어야 한다(단일 포인트는 대비 아님)."""
        detail = self.evidence_details.get(ev_id)
        if not detail:
            return False
        has_pair = _has_measured_pair(detail)   # before/after OR series>=2 (단일 출처)
        # ⚠ Codex FIX P: 공백만(" ") institution/duration 은 미존재로 취급(strip 후 빈 문자열 거부).
        has_institution = bool(str(detail.get("institution") or "").strip())
        has_n = _is_num(detail.get("sample_size"))
        has_duration = bool(str(detail.get("duration") or "").strip())
        return has_pair and has_institution and has_n and has_duration


# _is_num: harness.is_number 를 import (K-1 일원화 — bool 은 int 서브클래스라 명시 제외)


def _has_measured_pair(detail):
    """측정 전/후 '쌍' 존재: (before AND after 숫자) OR (series 숫자 value 2개 이상). 정량/정성 판별 단일 출처
    (_evidence_satisfies·_qualitative_cert_ok 공용 — series 정량이 정성 완화로 새는 것 차단, Codex FIX)."""
    if not isinstance(detail, dict):
        return False
    series = detail.get("series")
    n_pts = (sum(1 for it in series if isinstance(it, dict) and _is_num(it.get("value")))
             if isinstance(series, list) else 0)
    return (_is_num(detail.get("before")) and _is_num(detail.get("after"))) or n_pts >= 2


# 개인차 디스클레이머 — '정본 문자열'(아키텍처 재설계: 퍼지 NLP 폐기, 정확 부분문자열만).
#   인체적용시험 차트의 5번째 충족 요소. 긍정/부정/절분리/강한자기부정 휴리스틱을 모두 폐기하고
#   '이 정확한 문자열'이 블록 가시 텍스트에 그대로 들어있는지만 본다(프롬프트가 verbatim 삽입을 강제).
CLINICAL_DISCLAIMER = "개인에 따라 차이가 있을 수 있습니다"

# 임상 실증 표기 정책 기본값(화장품 레거시) — 도메인 미선언 시 폴백. 값은 팩 ruleset(axes.clinical_substantiation)이
#   소유하며 kcia_engine 은 팩 우선으로 읽는다(도메인 오버라이드 가능). disclaimer 는 '빈 값=항상참' 위험이 있어
#   공집합화 대신 레거시 기본값 유지(도메인-중립 machinery; 값=현행 상수 축자 복사=바이트 불변).
_CLINICAL_SUBSTANTIATION_DEFAULT = {
    "disclaimer": CLINICAL_DISCLAIMER,
    "sample_size_markers": ["명의", "명", "인"],
    "subject_markers": ["피험자", "대상자", "참여자", "시험대상자"],
    "duration_units": ["주간", "주", "일", "개월간", "개월", "weeks", "week"],
    "duration_aliases": {"주": "(주간|주)", "주간": "(주간|주)", "일": "(일)",
                         "개월": "(개월간|개월)", "개월간": "(개월간|개월)",
                         "week": "(weeks|week)", "weeks": "(weeks|week)"},
}


def _clinical_subst(axes):
    """axes.clinical_substantiation(도메인 소유)를 팩에서 읽되, 각 키 부재 시 화장품 레거시 기본값으로 폴백.
    axes = ruleset['axes'] = Engine.rs. 도메인 선언 시 그 값이, 아니면 레거시 기본값이 쓰인다(_lex 패턴)."""
    cs = ((axes or {}).get("clinical_substantiation", {}) or {})
    out = dict(_CLINICAL_SUBSTANTIATION_DEFAULT)
    for k in _CLINICAL_SUBSTANTIATION_DEFAULT:
        v = cs.get(k)
        if v is not None:
            out[k] = v
    return out


def _block_has_disclaimer(b, disclaimer):
    """블록 가시 텍스트(headline/subcopy/bodyText/footnotes[].text)에 정본 디스클레이머 문자열이
    '정확 부분문자열'로 들어있으면 True. 정규식·부정어·절분리 없음(결정적).
    disclaimer 는 도메인 룰셋(axes.clinical_substantiation.disclaimer)에서 온다(호출부가 eng.clinical_subst 주입)."""
    fragments = [b.get("headline", ""), b.get("subcopy", "")]
    fragments += list(b.get("bodyText") or [])
    fragments += [(f.get("text") or "") for f in (b.get("footnotes") or [])]
    blob = " ".join(t for t in fragments if t)
    return bool(disclaimer) and disclaimer in blob


def _block_shows_context(b, detail, cs):
    """충족 블록은 시험 맥락(시험기관·n수·시험기간)을 '사람-가독 카피'에 노출해야 한다(Codex FIX E + ADK-가시성 설계).
    cs = 도메인 임상 표기 어휘(axes.clinical_substantiation, 호출부가 eng.clinical_subst 주입) — n수/피험자/시험기간 매칭.
    근거 레코드에만 있고 소비자-노출 카피(headline/subcopy/bodyText/footnotes[].text)에 안 보이면 소비자는
    실증 맥락을 못 보므로 그 트리거를 억제하지 않는다(미실증 주장 통과 방지).
    ⚠ p_value 는 satisfied_when SSoT(["measured_value_pair","test_institution","sample_size_n","duration",
      "individual_variation_disclaimer"])에 없으므로 하드 요건이 아니다 — 강제하면 계약-유효 차트를 오탐(false-fail).
      p값은 ADK 지시문 권고로만 둔다."""
    if not detail:
        return False
    blob = " ".join(t for t in (
        [b.get("headline", ""), b.get("subcopy", "")]
        + list(b.get("bodyText") or [])
        + [(f.get("text") or "") for f in (b.get("footnotes") or [])]
    ) if t)
    # ⚠ Codex FIX P: 공백만(" ") 인 institution/duration 은 미존재로 취급(strip 후 빈 문자열 거부).
    inst = str(detail.get("institution") or "").strip()
    dur = str(detail.get("duration") or "").strip()
    n = detail.get("sample_size")
    # ── institution: 라틴/영숫자 기관명은 'ASCII 단어경계'만(뒤 한글 조사 '에서' 등 허용) · 한글명은 부분문자열.
    #   ⚠ Codex 9R(PART 4): \w 한글 포함 → "ABC Lab에서" 가 (?!\w) 로 거부되던 문제 → ASCII 경계로 한정.
    if not inst:
        return False
    # B-2(Seam C): 법인 접미(㈜·(주)·주식회사)는 실증 맥락의 본질(기관 식별)이 아니므로 비교 전 양쪽에서 정규화(제거)
    #   — ㈜ 한 글자 차이로 불일치하던 브리틀함 처방. 접미 제거만(기관명 축약은 불허 — 나머지는 여전히 정확 부분문자열).
    _corp = re.compile(r"㈜|\(주\)|주식회사")
    inst_cmp = _corp.sub("", inst).strip() or inst   # 접미만이던 값은 원본 유지(방어)
    blob_cmp = _corp.sub("", blob)
    if re.fullmatch(r"[A-Za-z0-9 .,&'\-]+", inst_cmp):
        if not re.search(r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9])" % re.escape(inst_cmp), blob_cmp):
            return False
    elif inst_cmp not in blob_cmp:
        return False
    # ── sample_size: 숫자가 'n수 마커'에 인접해야 한다 — '52명이 참여'(조사 동반)도 충족(PART 4).
    #   허용: '<n>명/명의/인'(뒤 조사 허용) · 'n=<n>'(숫자경계) · '(피험자|대상자|참여자|시험대상자) <n> 명?'.
    if not _is_num(n):
        return False
    ns = re.escape(str(n))
    n_ok = (re.search(r"(?<!\d)%s\s*(%s)" % (ns, "|".join(cs["sample_size_markers"])), blob)
            or re.search(r"[nN]\s*=\s*%s(?!\d)" % ns, blob)
            or re.search(r"(%s)\s*%s\s*명?" % ("|".join(cs["subject_markers"]), ns), blob))
    if not n_ok:
        return False
    # ── duration: 숫자+'해당 단위 별칭만'으로 매칭 — Codex FIX N. "4주" 는 "4개월" 에 매칭되면 안 된다.
    if not dur:
        return False
    _DUR_ALIASES = cs["duration_aliases"]
    mdur = re.match(r"\s*(\d+)\s*(%s)" % "|".join(cs["duration_units"]), dur)
    if mdur:
        dnum = re.escape(mdur.group(1))
        alias = _DUR_ALIASES.get(mdur.group(2), "(%s)" % re.escape(mdur.group(2)))
        if not re.search(r"(?<!\d)%s\s*%s(?!\d)" % (dnum, alias), blob):
            return False
    else:
        # B-1(Seam C): 선두 매칭 실패(날짜범위형 "2026년 05월 26일 ~ … (제품 4주 사용)") — '주/개월/weeks' 단위
        #   토큰을 findall 로 뽑아 그중 하나가 blob 에 노출되면 통과(우발 '일' 토큰[날짜 26일] 제외 — 오탐 방지).
        #   하나도 못 뽑으면 기존 전체-verbatim 폴백. 완화 폭 = '기간 토큰 1개 이상 노출'로 제한(설계 B-1).
        _wm_units = [u for u in cs["duration_units"] if u != "일"]
        _dur_tokens = re.findall(r"(\d+)\s*(%s)" % "|".join(map(re.escape, _wm_units)), dur)
        if _dur_tokens:
            if not any(
                re.search(r"(?<!\d)%s\s*%s(?!\d)" % (re.escape(_dn), _DUR_ALIASES.get(_u, "(%s)" % re.escape(_u))), blob)
                for _dn, _u in _dur_tokens
            ):
                return False
        elif not re.search(r"(?<!\w)%s(?!\w)" % re.escape(dur), blob):
            return False
    return True


def _qualitative_cert_ok(b, fn_ids, eng):
    """정성 인증형 clinicalEvidence 유효성(evidence-content-integration — 사용적합 등 인증-표시형).
    강주장(효능/최상급/속도)이 아닌 판정/사실 표현이 '시험성적서 3요소(시험기관·n·시험기간) 보유·측정 전후쌍
    없음'인 정성 근거를 인용 + 각주 페어링 + 블록이 기관·n·기간 맥락 노출 + 개인차 디스클레이머면 유효로 본다.
    측정 기반 강주장(효능)은 이 완화를 못 쓴다(before/after 측정쌍 필요 = 기존 5요소 경로). beforeAfter 는
    본질상 측정 대비이므로 이 완화 미적용(clinicalEvidence 전용, 호출부에서 분기)."""
    for c in b.get("claims", []):
        if c.get("claim_strength") in STRONG:
            continue   # 강주장은 측정 근거 필요 — 정성 완화 대상 아님(효능 우회 차단)
        ref = c.get("evidence_ref")
        if ref not in eng.evidence_ids or c.get("footnote_id") not in fn_ids:
            continue
        det = eng.evidence_details.get(ref) or {}
        has_report = (bool(str(det.get("institution") or "").strip())
                      and _is_num(det.get("sample_size"))
                      and bool(str(det.get("duration") or "").strip()))
        no_measure = not _has_measured_pair(det)   # 정량(before/after OR series>=2)이면 정성 완화 불가(강주장 필요)
        if has_report and no_measure and _block_shows_context(b, det, eng.clinical_subst) and _block_has_disclaimer(b, eng.clinical_subst["disclaimer"]):
            return True
    return False


def _block_scan_texts(b):
    """provenance 버킷 스캔 대상 = gather().add_block 이 스캔하는 블록 텍스트 fragment 전체와 '동일 범위'.
    headline/subcopy/bodyText[]/footnotes[].text/claims[].target_text + visual.concept 텍스트(개별 필드).
    ⚠ Codex FIX D/G: gather 스코프와 어긋나면 차트 억제가 과소(트리거가 본문 밖 claim/각주/concept 에만 있을 때
      false-fail)되거나 과대해진다. concept 은 gather 가 '필드별 개별 텍스트'로 스캔하므로(조인 아님) 여기서도
      필드별로 담아 target_text 가 정확히 일치하게 한다. gather().add_block 과 함께 유지할 것."""
    out = [b.get("headline", ""), b.get("subcopy", "")]
    out += list(b.get("bodyText") or [])
    out += [(f.get("text") or "") for f in (b.get("footnotes") or [])]
    out += [c.get("target_text", "") for c in (b.get("claims") or [])]
    out += list(((b.get("visual") or {}).get("chart_data") or {}).get("callouts") or [])   # FIX HH: 콜아웃 스캔
    con = (b.get("visual") or {}).get("concept") or {}
    if con:
        out += [con.get(f, "") for f in ("subject", "composition", "handoff_note", "typography")]
        mood = con.get("mood") or {}
        out += [mood.get(f, "") for f in ("color_temp", "lighting", "texture")]
        out += list(con.get("palette") or [])
        out.append((con.get("reference") or {}).get("direction", ""))
    return [t for t in out if t]


def _claim_consistent_with_evidence(target_text, detail):
    """클레임이 '진짜 측정 주장'으로서 derive_chart(detail) 도출값과 정확히 일치할 때만 True(억제 자격).
    ⚠ Codex FIX DD: 자격 필요조건 — ① detail.metric 이 target_text 에 포함, ② 측정 숫자가 하나 이상 일치.
    ⚠ Codex FIX EE: 숫자 정합은 clinical_chart.numbers_consistent 단일 규칙으로(% = 변화율 부호 포함, 맨숫자 = 값) —
      chart 콜아웃 검증과 '동일 출처'라 절대 갈라지지 않는다. ('수분 40% 개선'·'수분 +20% 개선'(근거 -20%) → 불일치 → 자격 없음.)
    숫자 없음/지표 미언급 = 측정 주장 아님 → 자격 없음(억제 안 함, 트리거 그대로 적발).
    detail 차트화 불가(None)면 결박 불가 → 자격 없음."""
    d = derive_chart(detail)
    if not d:
        return False
    text = target_text or ""
    metric = str((detail or {}).get("metric") or "").strip()
    # ⚠ Codex FIX QQ: 정확 부분문자열이 아니라 metric_matches_claim(접미 '량' stem) 으로 — '수분량' vs '수분 개선' 인정.
    if not metric or not metric_matches_claim(metric, text):
        return False   # 지표명 미언급 → 측정 주장 아님(비-수치 효능 트리거는 그대로 적발)
    ok, n_matched = numbers_consistent(text, d)
    return ok and n_matched >= 1   # 모든 숫자 정합 + 측정 숫자 최소 1개(숫자 없으면 측정 주장 아님)


def _spaceless(text):
    return re.sub(r"\s+", "", re.sub(r"[*_`~]", "", text or ""))


def _match(text, needle):
    """우회 강건 매칭: 마크다운/공백 무시(spaceless) + 'N' 숫자 placeholder(\\d+)."""
    if not needle:
        return False
    nl = _spaceless(text)
    pat = re.escape(_spaceless(needle)).replace("N", r"\d+")
    try:
        return re.search(pat, nl) is not None
    except re.error:
        return _spaceless(needle) in nl


def _norm_visible(s):
    """가시 텍스트 정규화 — NFKC(전각→반각 등 호환 통일) + 비가시 문자 제거. 전각/ZWJ/CGJ/VS 등 경계우회 차단(코덱스 단계2 3R·4R).
    denylist 대신 유니코드 카테고리로 일반화: Cf(format: soft-hyphen·ALM·Mongol-sep·ZWSP/ZWNJ/ZWJ·WJ·BOM·bidi)·Cs·Co·
    제어문자(Cc, 탭/개행/CR 제외) + variation selector(U+FE00..FE0F·U+E0100..E01EF)·CGJ(U+034F)(Mn 이지만 비가시)."""
    out = []
    for ch in unicodedata.normalize("NFKC", s or ""):
        cat = unicodedata.category(ch)
        if cat in ("Cf", "Cs", "Co"):
            continue
        if cat == "Cc" and ch not in "\t\n\r":
            continue
        o = ord(ch)
        if 0xFE00 <= o <= 0xFE0F or 0xE0100 <= o <= 0xE01EF or o == 0x034F:
            continue
        out.append(ch)
    return "".join(out)


def _is_continuation(ch):
    """토큰 '연속' 문자인가 — 글자(L*)·숫자(N*)·결합표시(M*)·연결구두점(Pc, 밑줄). 이 문자가 매치 경계에 인접하면
    제품명이 더 긴 토큰의 일부('제품A정'⊂'제품A정플러스'·'제품A정丸'·'EZdewα') → '독립 노출' 아님. 비라틴 포함 모든 스크립트 일반화(코덱스 4R).
    공백·하이픈(Pd)·점(Po)·괄호 등은 연속 아님(경계). re 표준모듈은 \\p{L} 미지원이라 카테고리로 직접 판정."""
    if not ch:
        return False                       # 문자열 끝/시작 = 경계
    cat = unicodedata.category(ch)
    return cat[0] in ("L", "N", "M") or cat == "Pc"


def _name_present(page, name):
    """정확한 제품명(면허명) '독립 노출' 검사 — _match(spaceless)·raw substring 둘 다 부적합해서 별도 매칭.
      • Medium 차단(마크업 분할 fail-positive): 이름 문자 사이 공백 허용. 단 page 는 충실 렌더(_final_page_render)여야
        인라인 split('제품A<span>정')은 '제품A정'으로 연결되고 경계 split('제품A정<span>플러스')은 '제품A정플러스'로 글루된다.
      • High 차단(부분문자열 fail-open): 매치 양끝이 '연속 문자'(글자/숫자/결합/밑줄, 전 스크립트)면 불충족 — 더 긴 토큰의 일부.
      • 전각/ZWJ/CGJ/VS 우회 차단: 양쪽 _norm_visible(NFKC+비가시 카테고리 제거).
      • 경계 잔여 오탐(면허명+단위 '타이레놀500'⊄'타이레놀500mg')은 fail-closed(안전) — 위험한 fail-open 쪽만 엄격.
      • 블록횡단 합성 차단(코덱스 5R): 문자 사이 분리자는 '\\n'(블록경계) 불포함 + 갭 상한. '<h1>우</h1><p>루</p>…'='우\\n루…' 는 불일치.
      • 표준 re 는 \\p{L} 룩어라운드 불가 → finditer 로 후보 매치를 찾고 양끝 문자 카테고리로 경계 직접 판정.
      • 정책(코덱스 6R Low, 의도): '제품A정 플러스'(공백분리)·'제품A정-플러스'(하이픈)는 면허명이 독립 토큰으로 노출된 것으로 보아 충족.
        수식어구 분리까지 거부하지 않는다(과차단 회피). <pre> 보존문맥의 줄내 분할은 공백축약으로 충족될 수 있음(엣지, 안전영향 미미)."""
    page = _norm_visible(page)
    sig = re.sub(r"[\s*_`~]+", "", _norm_visible(name))   # 이름의 유의미 문자(공백/마크다운 제거)
    if not sig:
        return False
    # 문자 사이: 인라인 공백/탭/마크다운만(블록경계 '\n' 제외), 갭 상한(페이지 전반 글자 합성 차단). 인라인 split=갭0, 소스 letter-spacing=소수 갭.
    body = r"[ \t\f\v*_`~]{0,8}".join(re.escape(c) for c in sig)
    try:
        rx = re.compile(body)
    except re.error:
        return False                                      # re.escape 라 도달 불가 — 도달 시 fail-closed
    for m in rx.finditer(page):
        before = page[m.start() - 1] if m.start() > 0 else ""
        after = page[m.end()] if m.end() < len(page) else ""
        if not _is_continuation(before) and not _is_continuation(after):
            return True                                   # 양끝이 경계 → 독립 노출
    return False                                          # 모든 출현이 더 긴 토큰의 일부 → 누락(fail-closed)


# CSS ::before/::after 의 generated content 가 제품명 토큰을 시각적으로 '연장'(글루)할 수 있다
#   (예: h1::after{content:"플러스"} + <h1>제품A정</h1> → 화면 '제품A정플러스'). 정적 추출로 위치를 알 수 없으므로
#   글루 위험 존재 시 제품명 '독립 노출' 보장 불가 → fail-closed(누락 flag). 빈/기호/아이콘 content 만 무위험.
#   CSS 텍스트 생성 경로는 무한(attr/counter(s)/var/env/open-close-quote/escape/문자열연결…)이라 열거 대신 **default-deny**:
#   '명백히 무해'(빈·none·normal·기호/구두점만의 문자열 리터럴)가 아니면 전부 위험으로 본다(코덱스 단계2 5R).
#   수용 잔여(코덱스 6R, 의도적 합의): 정규식 스캐너라 CSS 토크나이저가 아니다 — 의도적 난독화('::bef\\6fre', 'con/**/tent',
#     content 문자열 안 '{')는 미탐(Medium). 이 하네스의 '생성자'는 적대적 외부인이 아니라 자체 stub/LLM 이라 우연 발생 불가(악용가능성 낮음).
#     또한 전역 글루감지라 페이지 어디든 단어 ::content(예: Material Icons 리거처)면 정상 제품명도 fail-closed(M2 운영 false-positive, 안전측).
#     PUA 아이콘(FontAwesome '\\f001')은 통과. 완전 차단엔 CSS 파서 필요 — 안전망 비용 대비 과해 미도입.
_PSEUDO_RE = re.compile(r":{1,2}(?:before|after)\b", re.I)
_CONTENT_FN = re.compile(r"\b(?:attr|counters?|var|env|url|image|image-set|linear-gradient)\s*\(", re.I)
_QUOTE_KW = re.compile(r"\b(?:open-quote|close-quote|no-open-quote|no-close-quote)\b", re.I)


def _content_values(body):
    """선언 블록 body 의 content 속성 값들 — 따옴표 안 세미콜론('플;러스')을 존중하며 선언 끝(unquoted ';')까지 추출."""
    vals = []
    for m in re.finditer(r"content\s*:", body, re.I):
        i, q, buf = m.end(), None, []
        while i < len(body):
            c = body[i]
            if q:
                buf.append(c)
                if c == "\\" and i + 1 < len(body):
                    i += 1; buf.append(body[i])      # CSS escape — 다음 문자 보존(따옴표 종료 아님)
                elif c == q:
                    q = None
            elif c in "\"'":
                q = c; buf.append(c)
            elif c == ";":
                break
            else:
                buf.append(c)
            i += 1
        vals.append("".join(buf))
    return vals


def _content_glues(val):
    """content 값이 제품명 토큰을 글자/숫자로 '연장'할 수 있나(default-deny). 무해=빈·none·normal·기호만 리터럴."""
    v = val.strip()
    if not v or v.lower() in ("normal", "none"):
        return False
    if _CONTENT_FN.search(v) or _QUOTE_KW.search(v):
        return True                                  # 동적/인용 생성 → 내용 불명·글자 산출 가능
    rest = re.sub(r"\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'", " ", v)   # 문자열 리터럴 제거(escape 포함)
    if re.search(r"[^\s/]", rest):
        return True                                  # 리터럴·공백·'/'(alt 구분) 외 미인식 토큰 잔존 → 위험(default-deny)
    for g1, g2 in re.findall(r"\"((?:[^\"\\]|\\.)*)\"|'((?:[^'\\]|\\.)*)'", v):
        # CSS escape(\\D50C) 디코드 후, NFKC 없이 글자(L*)·숫자(N*)만 검사(NFKC 는 ™→TM 과차단 → 미사용).
        if any(unicodedata.category(c)[0] in ("L", "N") for c in _decode_css_escapes(g1 or g2)):
            return True                              # 글자/숫자(전 스크립트) 리터럴 → 인접 시 토큰 연장(기호/구두점은 무위험)
    return False


def _has_gluing_generated_content(css):
    for sel, body in re.findall(r"([^{}]*)\{([^{}]*)\}", css or ""):
        if not _PSEUDO_RE.search(sel):
            continue
        if any(_content_glues(v) for v in _content_values(body)):
            return True
    return False


def _final_page_render(rdir, phase):
    """필수기재 제품명 검사용 — 선택안 최종 페이지의 (충실 렌더 텍스트, CSS 원문).
    렌더 텍스트: 인라인 연결·블록 분리(노출 텍스트만) — gather 일괄 공백결합이 못 구분하는 실제 렌더 경계 복원(코덱스 3R).
    CSS: 인라인 <style>(raw HTML) + styles.css — ::before/::after 생성콘텐츠 글루 위험 판정용(코덱스 4R)."""
    odir = os.path.join(rdir, phase, "options")
    opt = None
    sel = os.path.join(rdir, phase, "decision.json")
    if os.path.exists(sel):
        try:
            opt = load_json(sel).get("selected")
        except Exception:
            opt = None
    opts = [opt] if opt else (sorted(os.listdir(odir)) if os.path.isdir(odir) else [])
    texts, csss = [], []
    for o in opts:
        if not o:
            continue
        html = os.path.join(odir, o, "index.html")
        if os.path.exists(html):
            try:
                with open(html, encoding="utf-8") as f:
                    raw = f.read()
                rp = _RenderedText()
                rp.feed(raw)
                rp.close()
                texts.append(rp.text())
                csss.append(raw)            # 인라인 <style> 포함(raw 그대로 CSS 스캔 — _RenderedText 는 style 스킵)
            except Exception:
                pass
        cssf = os.path.join(odir, o, "styles.css")
        if os.path.exists(cssf):
            try:
                csss.append(open(cssf, encoding="utf-8", errors="ignore").read())
            except Exception:
                pass
    return "\n".join(texts), "\n".join(csss)


def _concept_text(b):
    """블록의 visual.concept '텍스트' 필드를 연결(경로 own_asset_path 제외). block-scoped 검사용."""
    con = (b.get("visual") or {}).get("concept") or {}
    if not con:
        return ""
    parts = [con.get(f, "") for f in ("subject", "composition", "handoff_note", "typography")]
    mood = con.get("mood") or {}
    parts += [mood.get(f, "") for f in ("color_temp", "lighting", "texture")]
    parts.append((con.get("reference") or {}).get("direction", ""))
    return " ".join(p for p in parts if p)


def _vio(target, axis, ref, severity, rule, matched):
    return {
        "target_text": (target or "")[:160],
        "axis": axis, "rule": rule, "severity": severity,
        "detected_by": "ruleset",
        "suggested_rewrite": "‘%s’ 표현을 근거 기반/절제 표현으로 대체하거나 삭제하세요." % matched,
    }


# ───────── 산출물에서 검사 대상 텍스트/claim 추출 ─────────
def _selected_options(rdir, decision_rel, options_dir):
    """M4(C4): 심의 대상 = **선택안만**(decision.json.selected 하나). select 가 심의 앞으로 오므로
       거절 옵션·archive 라운드를 제외(false-fail 차단). decision 부재(방어)면 전체 옵션 폴백."""
    dec = os.path.join(rdir, decision_rel)
    if os.path.exists(dec):
        try:
            sel = load_json(dec).get("selected")
            if sel and os.path.isdir(os.path.join(rdir, options_dir, sel)):
                return [sel]
        except Exception:
            pass
    od = os.path.join(rdir, options_dir)
    return sorted(os.listdir(od)) if os.path.isdir(od) else []


_VERDICT_MIN_CONTEXT = 4   # 판정문 부분문자열 면제 시, 효능어 제거 후 남아야 하는 최소 판정문 문맥(spaceless 자수) — bare 토큰 결박 우회 차단(Codex 11R)


def _verdict_exempt_ok(fragment, verdict_texts, zero_voc, require_full=False):
    """조각이 P-3(a안) zero_voc 면제 자격이 있는가 — 결박된 판정문과의 관계로 판정(단일 출처).
      · 조각 ⊆ 판정문   → 면제(순수 판정문 부분문자열 카피 — 판정문 어휘뿐이라 안전). ★ require_full=True 면 이 방향 불허.
      · 판정문 ⊆ 조각   → 판정문을 뺀 '나머지'에 zero_voc 효능어가 없을 때만 면제(본문 = 판정문 + 중립 맥락[기관·n·기간·
        디스클레이머] 렌더). 나머지에 효능어가 붙으면(판정문 문단에 마케팅 효능어 끼워넣기) 면제 안 함 → 스머글링 차단(Codex 5R).
    require_full(키비주얼 전용) = 04-keyvisual HTML 은 필드(헤드라인/본문) 구분이 불가·클래스명이 비결정적이라, '짧은
      판정문 조각'(조각 ⊆ 판정문)을 eyebrow/sub/kicker 같은 prominent 훅에 넣어 컨셉 축으로 쓰는 우회(Codex 7R)를 막기 위해
      '판정문 ⊆ 조각'(판정문 전문 + 맥락으로 렌더된 본문)만 면제한다 — 클래스-독립 견고 신호. 스토리보드는 필드 분류라 False.
    verdict_texts = 결박 확인된 판정문 목록 · zero_voc = 리뷰0 효능어 목록.
    ★ 겹침 판정은 공백 무시(_spaceless)로 한다 — 인라인 마크업 분할·소스 공백 차이로 판정문이 조각나도(Codex 9R) 견고."""
    zv = [z for z in (zero_voc or ()) if z]
    fsl = _spaceless(fragment)
    if not fsl:
        return False
    for vt in verdict_texts:
        vsl = _spaceless(vt)
        if not vsl:
            continue
        if (not require_full) and fsl in vsl:
            # ★ bare 효능어 우회 차단(Codex 11R): 조각이 판정문 부분문자열이라도, zero_voc 효능어를 뺀 '판정문 문맥'이
            #   충분히(_VERDICT_MIN_CONTEXT 자↑) 남아야 면제한다 — target_text:"여드름" 처럼 효능어 토큰 하나만 결박해
            #   그 bare 효능어를 통과시키는 우회를 막는다. 실제 판정 카피(예 "여드름성 피부 사용에 적합")는 문맥이 충분해 통과.
            stripped = fsl
            for z in zv:
                zsl = _spaceless(z)
                if zsl:
                    stripped = stripped.replace(zsl, "")
            if len(stripped) >= _VERDICT_MIN_CONTEXT:
                return True
        if vsl in fsl:
            remainder = fsl.replace(vsl, "")
            # ★ scan_text 와 '같은 정규화'(_match: spaceless + N placeholder)로 나머지의 효능어를 찾는다 —
            #   raw 부분문자열 검사는 '여 드름'(공백)·마크다운 난독화를 놓쳐 면제가 새므로(Codex 6R) 불가.
            if not any(_match(remainder, z) for z in zv):
                return True
    return False


def gather(rdir, phase, substage, verdict_docs=None, bound_doc_ids=None, zero_voc=None):
    """(texts[(text,footnote_ids)], claims[(claim,footnote_ids)], exempt_texts:set) 반환.
    exempt_texts = P-3(a안) zero_voc 면제 대상 = '시험성적서 판정문 원문을 결박하여 실은 카피'뿐. 결박·훅 규칙은 아래 참조.
      · verdict_docs {doc_id: verdict_text}(test_report) · bound_doc_ids = claim-basis 로 승격된 test_report doc_id(런-결박, 키비주얼용).
      · 03-storyboard: '블록에 evidence_ref→그 판정문 결박 claim(target_text ⊆ 판정문)이 있는' 경우에만 그 블록의 비-훅 조각
        (본문·각주·claim target) 중 판정문과 겹치는(⊆ 또는 ⊇[본문+맥락 렌더]) 것을 면제 — 결박 없는 블록/카피는 면제 안 함(Codex W1c a).
      · 04-keyvisual: claims 부재라 런-결박(bound_doc_ids) + heading(h1~h6)=훅 제외로, 비-heading 본문 중 판정문 겹침만 면제(Codex W1c b).
      · 훅(헤드라인·subcopy·콜아웃·concept 축·02-concept·키비주얼 heading)은 판정문 원문 반복이라도 결코 면제 안 함. 최종 exempt -= hook."""
    verdict_docs = verdict_docs or {}
    bound_doc_ids = set(bound_doc_ids or ())
    texts, claims = [], []
    hook_texts = set()        # 훅·컨셉 주축 — 면제 절대 제외(누수 차단, Codex W1 finding2/W1c b)
    exempt = set()            # 결박 판정문 카피 면제 후보(아래에서 조건 충족분만 add; 반환 직전 hook·비결박 차감)
    nonhook_unbound = set()   # '결박 없는' 블록의 비-훅 조각 — 같은 문자열이 결박 블록에도 있어도 면제에서 뺀다(블록-스코프 보수화, Codex 4R b)

    def add_block(b):
        fn_ids = {f["id"] for f in b.get("footnotes", [])}
        block_nonhook = []                     # 이 블록의 비-훅 조각(본문·각주·claim target) — 결박 시 판정문 겹침 면제 후보
        def _hook(t, fn):                      # 마케팅 훅·컨셉 주축 → texts + hook_texts(면제 절대 제외)
            texts.append((t, fn)); hook_texts.add(t)
        def _body(t, fn):                      # 비-훅(본문/각주/claim target) → texts + 블록 면제 후보
            texts.append((t, fn)); block_nonhook.append(t)
        for fld in ("headline", "subcopy"):
            if b.get(fld):
                _hook(b[fld], fn_ids)
        for t in b.get("bodyText", []):        # 본문 = 판정문 렌더 자리(결박 시 면제 후보)
            _body(t, fn_ids)
        for f in b.get("footnotes", []):       # 각주 본문도 HTML 에 노출 → scan (Codex 2차 A)
            if f.get("text"):
                _body(f["text"], fn_ids)
        for c in b.get("claims", []):
            _body(c.get("target_text", ""), fn_ids)   # claim target(결박 시 면제 후보)
            claims.append((c, fn_ids))
        # ⚠ Codex FIX HH: chart_data.callouts 는 소비자-노출 텍스트 → 전 축 스캔(금지어/효능 등). 경로/숫자 무관.
        for co in ((b.get("visual") or {}).get("chart_data") or {}).get("callouts", []):
            if co:
                _hook(co, fn_ids)
        # 신규: visual.concept 의 '텍스트' 필드도 scan (효능·절대표현 fail-closed).
        #   ★ 경로 필드(reference.own_asset_path)는 절대 스캔하지 않는다(자사컷 경로 오탐 방지).
        con = (b.get("visual") or {}).get("concept") or {}
        if con:
            for fld in ("subject", "composition", "handoff_note", "typography"):
                if con.get(fld):
                    _hook(con[fld], None)
            cmood = con.get("mood") or {}
            for fld in ("color_temp", "lighting", "texture"):
                if cmood.get(fld):
                    _hook(cmood[fld], None)
            for col in (con.get("palette") or []):
                _hook(col, None)
            cref = con.get("reference") or {}
            if cref.get("direction"):
                _hook(cref["direction"], None)
        # P-3(a안 · Codex W1c a) 블록-결박 판정문 면제: 이 블록에 'evidence_ref→그 판정문 결박 claim(target_text ⊆ 판정문)'이
        #   있을 때만, 그 블록의 비-훅 조각(본문·각주·claim target) 중 판정문과 겹치는 것을 면제. 결박 없으면 면제 없음.
        if verdict_docs:
            bvts = []
            for c in b.get("claims", []):
                ref = c.get("evidence_ref"); tgt = c.get("target_text")
                if not ref or not tgt:
                    continue
                did = ref if ref in verdict_docs else None
                if did is None:                          # 항목 서브id(doc-NN-tKK) → 부모 doc-NN
                    m = re.match(r"^(doc-\d+)-t\d+$", str(ref))
                    if m and m.group(1) in verdict_docs:
                        did = m.group(1)
                if did and tgt in verdict_docs[did]:       # target_text 가 판정문 원문의 부분문자열 → 결박 인정
                    bvts.append(verdict_docs[did])
            if bvts:
                for f in block_nonhook:
                    if f and _verdict_exempt_ok(f, bvts, zero_voc):
                        exempt.add(f)
            else:
                # 결박 없는 블록의 비-훅 조각 — 같은 문자열이 다른(결박) 블록에도 있으면 면제에서 뺀다(누수 차단, Codex 4R b).
                nonhook_unbound.update(f for f in block_nonhook if f)

    if phase == "00g-guideline":
        # 크롤 참조 노트(자유텍스트)만 스캔(법 > 참조노트). 구 '유사점 3안 project-guideline' 파기.
        #   example-analysis(객관 신호·VOC 원문)는 '분석 데이터'라 제외 — 소비자 노출 카피가 아니고, voc 원문 자기검출 false-fail 방지.
        rn = os.path.join(rdir, "00g-guideline/reference-notes.json")
        if os.path.exists(rn):
            n = load_json(rn)
            for t in n.get("flow_refs", []):
                texts.append((t, None))
            for t in n.get("composition_notes", []):
                texts.append((t, None))
            if n.get("notes"):
                texts.append((n["notes"], None))
    elif phase == "01-brief":
        p = os.path.join(rdir, "01-brief/brief.json")
        if os.path.exists(p):
            br = load_json(p)
            pr = br["pr"]
            for fld in ("headline", "subhead", "problem"):
                texts.append((pr.get(fld, ""), None))
            for q in pr.get("quotes", []):
                texts.append((q.get("text", ""), None))
            sol = pr.get("solution") or {}
            for t in sol.get("differentiators", []) + sol.get("today_alternatives", []):
                texts.append((t, None))
            cg = br.get("confirmed_guideline") or {}   # 확정 유사점 느낌도 심의(위법 표현 차단)
            for fld in ("label", "thesis"):
                if cg.get(fld):
                    texts.append((cg[fld], None))
            # 소비자 노출 FAQ(external) 도 심의. internal 은 리스크 주석이라 제외(금지어 카탈로그 자기검출 방지).
            for qa in (br.get("faq") or {}).get("external", []):
                for fld in ("q", "a"):
                    if qa.get(fld):
                        texts.append((qa[fld], None))
    elif phase == "02-concept":
        # M4(C4): 선택안만 심의(거절 옵션 제외 — false-fail 차단).
        odir = os.path.join(rdir, "02-concept/options")
        if os.path.isdir(odir):
            for opt in _selected_options(rdir, "02-concept/decision.json", "02-concept/options"):
                for f in ("rtb.json", "key-message.json"):
                    p = os.path.join(odir, opt, f)
                    if os.path.exists(p):
                        d = load_json(p)
                        items = d.get("rtb", d.get("key_messages", []))
                        for it in items:
                            txt = it.get("claim", it.get("headline", ""))
                            texts.append((txt, None))
                            hook_texts.add(txt)   # 02-concept 텍스트=컨셉 주축 → 결코 면제 안 함(P-3 a안)
                            claims.append(({"target_text": txt,
                                            "claim_strength": it.get("claim_strength"),
                                            "evidence_ref": it.get("evidence_ref"),
                                            "footnote_id": None}, None))
    elif phase == "03-storyboard" and substage == "plan":
        # M3: tone 흡수 — plan 블록의 visual.concept(구도/무드/참조 디렉션)도 add_block 이 scan(아래 tone 별도분기 불요).
        pdir = os.path.join(rdir, "03-storyboard/plan")
        if os.path.isdir(pdir):
            for fn in sorted(os.listdir(pdir)):
                if fn.endswith(".json"):
                    add_block(load_json(os.path.join(pdir, fn)))
    elif phase == "04-keyvisual":
        opt = None
        sel = os.path.join(rdir, "04-keyvisual/decision.json")
        if os.path.exists(sel):
            opt = load_json(sel)["selected"]
        odir = os.path.join(rdir, "04-keyvisual/options")
        opts = [opt] if opt else (sorted(os.listdir(odir)) if os.path.isdir(odir) else [])
        for o in opts:
            html = os.path.join(odir, o, "index.html")
            if os.path.exists(html):
                with open(html, encoding="utf-8") as f:
                    raw = f.read()
                # text node + 노출 속성(alt/title/aria/...) 전부 수집(속성 효능표현 우회 차단, Codex 3차).
                hp = _HTMLText()
                try:
                    hp.feed(raw); hp.close()
                except Exception:
                    hp.texts = re.findall(r">([^<>]+)<", raw)   # 파싱 실패 시 보수적 폴백
                _kv_heads = set(s.strip() for s in getattr(hp, "hook_texts", []) if s and s.strip())
                hook_texts |= _kv_heads       # heading(h1~h6) 텍스트/속성 = 훅 → 면제 절대 제외(Codex W1c b·8R)
                for s in hp.texts:
                    s = (s or "").strip()
                    if s:
                        texts.append((s, None))
                # P-3(a안) 키비주얼 면제 — claims 부재라 런-결박(bound_doc_ids)로만 인정. 면제는 '문단(블록경계) 집계' 단위로
                #   판정:비-heading 문단의 집계 텍스트가 require_full(판정문 전문+맥락, 짧은 훅 조각 제외 — Codex 7R)을 만족하면
                #   그 문단의 '구성 노드 전부'를 면제한다 → 인라인 마크업으로 쪼개진 본문도 놓치지 않음(Codex 9R). heading 문단은 제외.
                _kv_vts = [verdict_docs[d] for d in bound_doc_ids if d in verdict_docs] if (bound_doc_ids and verdict_docs) else []
                if _kv_vts:
                    _kv_nonexempt = set()   # 면제 미자격 문단(짧은 훅 등)의 노드 — 같은 문자열이 면제 문단에도 있어도 차감(occurrence 누수 차단, Codex 12R; 스토리보드 nonhook_unbound 와 대칭)
                    for _nodes, _is_head in getattr(hp, "paragraphs", []):
                        if _is_head:
                            continue
                        _agg = " ".join(n for n in _nodes if n).strip()
                        if _agg and _verdict_exempt_ok(_agg, _kv_vts, zero_voc, require_full=True):
                            for _n in _nodes:
                                _ns = (_n or "").strip()
                                if _ns and _ns not in _kv_heads:
                                    exempt.add(_ns)
                        else:
                            for _n in _nodes:
                                _ns = (_n or "").strip()
                                if _ns:
                                    _kv_nonexempt.add(_ns)
                    exempt -= _kv_nonexempt   # 짧은 훅 문단에도 등장한 문자열은 면제 취소(대칭 보수 closure)
                # CSS content:"..." (인라인 <style> + 로컬 styles.css) 도 화면 노출 → scan(Codex 4차).
                css = raw
                cssf = os.path.join(odir, o, "styles.css")
                if os.path.exists(cssf):
                    css += "\n" + open(cssf, encoding="utf-8", errors="ignore").read()
                for s in _css_content_literals(css):
                    texts.append((s, None))
    return texts, claims, (exempt - hook_texts - nonhook_unbound)


def evaluate(rid, rdir, out_path, engine_name):
    st = load_json(os.path.join(rdir, "state.json"))
    phase = st["phase"]
    # substage 판별은 단일 SSoT(harness.storyboard_substage): outline → plan (M3: 2-cycle, tone 흡수).
    substage = storyboard_substage(rdir) if phase == "03-storyboard" else None
    # M4(C4·코덱스 HIGH): 다안 페이즈는 심의 시점에 '선택안(decision.selected)'이 반드시 있어야 한다(심의는 선택 뒤).
    #   부재/손상 = 우회·손상 상태 → fail-closed escalate(전체옵션 폴백으로 거절안 false-fail / 무증거 pass 차단).
    #   storyboard-outline 도 다안(스토리라인 A/B)이므로 포함(outline decision 부재 시 무내용 pass+plan 전진 차단).
    #   (00g-guideline 은 단안=크롤 참조 노트로 전환되어 decision 이 없으므로 이 다안 체크에서 제외.)
    _multi_dbase = None
    if phase in ("02-concept", "04-keyvisual"):
        _multi_dbase = os.path.join(rdir, phase)
    elif phase == "03-storyboard" and substage == "outline":
        _multi_dbase = os.path.join(rdir, "03-storyboard", "outline")
    if _multi_dbase is not None:
        dbase = _multi_dbase
        sel = None
        try:
            if os.path.exists(os.path.join(dbase, "decision.json")):
                sel = load_json(os.path.join(dbase, "decision.json")).get("selected")
        except Exception:
            sel = None
        if not sel or not os.path.isdir(os.path.join(dbase, "options", str(sel))):
            verdict = {"verdict": "fail", "engine": engine_name, "confidence": 0.0,
                       "violations": [_vio("[decision]", "substantiation_required", "선택안 부재", "high",
                                           "심의 시점에 선택안(decision.selected) 없음/손상 — 선택 후 심의해야 함(M4)", str(sel))],
                       "escalate": True}
            if out_path:
                atomic_write_json(out_path, verdict)
            return verdict
    # 코덱스 HIGH(2R): 03-storyboard plan substage 인데 plan 산출물(plan/*.json)이 없으면 '무내용 pass' 금지 → fail-closed.
    #   legacy/직접 seed 가 outline-verdict=pass 만 갖고 plan 미생성 상태에서 plan 으로 재구성돼도 빈 plan 통과를 차단(R7 손상상태 fail-closed).
    if phase == "03-storyboard" and substage == "plan":
        _pdir = os.path.join(rdir, "03-storyboard", "plan")
        _has_plan = os.path.isdir(_pdir) and any(f.endswith(".json") for f in os.listdir(_pdir))
        if not _has_plan:
            verdict = {"verdict": "fail", "engine": engine_name, "confidence": 0.0,
                       "violations": [_vio("[plan]", "substantiation_required", "기획안 산출물 부재", "high",
                                           "plan substage 인데 03-storyboard/plan 산출물이 없음 — 생성 후 심의해야 함(무내용 pass 차단)", "plan")],
                       "escalate": True}
            if out_path:
                atomic_write_json(out_path, verdict)
            return verdict
    domain = regulatory_domain(st)
    ruleset = load_ruleset(domain)
    # 활성 도메인인데 룰셋 축이 비어있으면(파일 부재/오설정/실수로 비움) 조용한 무-심의 금지 → fail-closed 에스컬레이트.
    #   (TBD/미제공 도메인은 kcia-check.sh 가 evaluate 이전에 placeholder-autopass 로 처리하므로 여기 도달하지 않는다.)
    if not ruleset.get("axes"):
        verdict = {"verdict": "fail", "engine": engine_name, "confidence": 0.0,
                   "violations": [_vio("[ruleset]", "substantiation_required", "심의 룰셋 설정 오류", "high",
                                       "활성 도메인의 심의 룰셋 축이 비어있음(파일 부재/오설정) — 사람 확인 필요", str(domain))],
                   "escalate": True}
        if out_path:
            atomic_write_json(out_path, verdict)
        return verdict
    cb = load_json(os.path.join(rdir, "00-ingest/claim-basis.json"))
    func_status = {k: v["status"] for k, v in cb["functional_status"].items()}
    # 실재 근거 id 집합 = 보유 실증 파일 + 기능성 '승인' 근거(통지/심사 ref) + 고시성분 ref.
    evidence_ids = [e["id"] for e in cb["evidence_on_file"]]
    # 근거 상세 map: id → 전체 근거 dict (인체적용시험 수치 차트 충족 판정에 사용)
    evidence_details = {e["id"]: e for e in cb["evidence_on_file"]}
    evidence_ids += [v["evidence_ref"] for v in cb["functional_status"].values()
                     if v.get("status") == "approved" and v.get("evidence_ref")]
    evidence_ids += [n["evidence_ref"] for n in cb.get("notified_ingredients", []) if n.get("evidence_ref")]
    # sources 근거는 '03 단계 이후 + 허용 등급 + evidence_sufficient=true'일 때만 신뢰(세탁 차단 #2/#4).
    if phase in ("03-storyboard", "04-keyvisual"):
        res_path = os.path.join(rdir, "03-storyboard/sources/results.json")
        if os.path.exists(res_path):
            res = load_json(res_path)
            _sub = ruleset.get("axes", {}).get("substantiation_required", {})
            allowed = _sub.get("evidence_grade", [])
            rejected = _sub.get("rejected_grade", [])
            if res.get("evidence_sufficient") is True:   # 불충분 표기 시 어떤 id 도 신뢰하지 않음
                for r in res.get("results", []):
                    g = r.get("grade", "")
                    if any(a in g for a in allowed) and not any(x in g for x in rejected):
                        evidence_ids.append(r["id"])

    # 도메인 어휘 사전(룰셋 axes.lexicon 우선, 화장품 상수 폴백)
    condition_target = _lex(ruleset, "condition_target", CONDITION_TARGET)
    pharma_authority = _lex(ruleset, "pharma_authority", PHARMA_AUTHORITY)
    zero_voc_exclude = set(_lex(ruleset, "zero_voc_exclude", []))   # (2부 2단계) 화장품 인라인 어휘 → axes.lexicon.zero_voc_exclude
    # 리뷰 0건 개념(소비자 수요 근거 없음) — voc.json 에서 count==0 인 효능어
    zero_voc = []
    vpath = os.path.join(rdir, "00-ingest/voc.json")
    voc_kw = {}
    voc_top = {}   # WS2: top_phrases (규제어 제외 상위 N 어휘)
    if os.path.exists(vpath):
        voc_data = load_json(vpath)
        voc_kw = voc_data.get("keyword_frequency", {})
        voc_top = voc_data.get("top_phrases", {})
        zero_voc = [k for k, c in voc_kw.items() if c == 0 and k not in zero_voc_exclude]

    # P-3(a안, 좁은 면제 · Codex W1/W1b/W1c) — 시험성적서 판정문(verdict_text) '결박 카피'만 zero_voc 억제에서 면제.
    #   면제 계산은 gather 가 블록/페이즈 맥락으로 수행(결박 요구 — Codex W1c a) — 여기선 판정문 사전만 만들어 넘긴다:
    #     · verdict_docs = {doc_id: verdict_text}(test_report) — 03-storyboard 블록-결박(claim.evidence_ref) 확인용.
    #     · bound_doc_ids = claim-basis 로 '승격된' test_report doc_id(런-결박) — 04-keyvisual(claims 부재)에서만 사용.
    #   매니페스트 부재/판정문 없음 → gather 가 공집합 반환 = 기존 골든 바이트 불변. 원격 ADK 는 독립 심의 주체(격리 불변).
    verdict_docs = {}
    _evdocs_path = os.path.join(rdir, "00-ingest/evidence-documents.json")
    if os.path.exists(_evdocs_path):
        try:
            _documents = load_json(_evdocs_path).get("documents") or []
        except Exception:
            _documents = []
        verdict_docs = {doc["id"]: doc["verdict_text"] for doc in _documents
                        if isinstance(doc, dict) and doc.get("kind") == "test_report"
                        and doc.get("id") and doc.get("verdict_text")}
    bound_doc_ids = set(verdict_docs) & {e.get("id") for e in cb.get("evidence_on_file", []) if isinstance(e, dict)}
    texts, claims, zero_voc_exempt = gather(rdir, phase, substage,
                                            verdict_docs=verdict_docs, bound_doc_ids=bound_doc_ids,
                                            zero_voc=zero_voc)
    eng = Engine(ruleset, func_status, evidence_ids, zero_voc=zero_voc, evidence_details=evidence_details,
                 zero_voc_exempt_texts=zero_voc_exempt,
                 learned_deny=_load_learned_deny(domain, phase))   # Seam F 심의-측 집행(domain=이미 계산됨; 부재=[])
    violations = []
    seen = set()

    # #4 컨셉 감성 키메시지 voc_phrase 강제(reviews 근거) — 누락/허위 시 revise. M4(C4·R9): 선택안만.
    if phase == "02-concept":
        odir = os.path.join(rdir, "02-concept/options")
        if os.path.isdir(odir):
            for opt in _selected_options(rdir, "02-concept/decision.json", "02-concept/options"):
                kp = os.path.join(odir, opt, "key-message.json")
                if not os.path.exists(kp):
                    continue
                for km in load_json(kp).get("key_messages", []):
                    if km.get("slot") == "emotional":
                        vp = km.get("voc_phrase")
                        # WS2: keyword_frequency 또는 top_phrases 둘 중 하나라도 존재하면 통과
                        if not vp or (voc_kw.get(vp, 0) <= 0 and voc_top.get(vp, 0) <= 0):
                            violations.append(_vio(km.get("headline", ""), "consumer_deception",
                                              "VOC 인용 규약", "medium",
                                              "감성 키메시지 voc_phrase 누락/비실재(reviews 근거 필요)", str(vp)))

    # ⑦ prescription_otc_distinction 하드스톱 (런-레벨: 품목 허가구분 × 매체) — 약사법 제68조제6항.
    #   전문의약품을 일반 소비자(대중) 매체에 광고 = 무조건 revise(하드스톱·escalate). 전문가매체/예외는 면제.
    #   허가구분은 사람이 선언(product.rx_classification). 미선언이면 판정 불가 → 하드스톱 미발동(banned 스캔은 별개로 동작).
    escalate_hardstop = False
    _product = st.get("product") or {}
    _pod = ruleset.get("axes", {}).get("prescription_otc_distinction")
    if _pod:
        _rx = _product.get("rx_classification")             # prescription | otc | (미선언)
        _audience = _product.get("ad_audience", "public")   # public(대중) | professional(전문가)
        if _rx == "prescription" and _audience != "professional":
            violations.append(_vio(
                "[rx=prescription · audience=%s · format=%s]" % (_audience, _product.get("deliverable_format") or ""),
                "prescription_otc_distinction", _pod.get("ref", ""), "high",
                "전문의약품 대중광고 금지 하드스톱(약사법 제68조제6항) — 전문가매체/예외 아니면 revise", "전문의약품×대중매체"))
            escalate_hardstop = True

    # ⑧ mandatory_inclusion 필수기재 완비 — 포맷의 '최종 페이지' 단계에서만(키비주얼 고정 제거, 포맷별 일반화).
    #   format-profiles.json 의 포맷별 final_page_phase 를 읽는다(최종 산출 페이지가 만들어지는 단계).
    #   final_page_phase 는 format-profiles.json 에서 포맷별로 동적 로드(현재 multipage_bm·one_pager=04-keyvisual).
    #   다음 단계는 콘티/스토리보드(03)이지 키비주얼이 아니다 — 필수기재는 '다음 단계'가 아니라 '최종 페이지' 기준.
    _mi = ruleset.get("axes", {}).get("mandatory_inclusion")
    if _mi:
        _fmt = deliverable_format(st)
        try:
            _fp = load_json(os.path.join(FORMATS_DIR, "format-profiles.json"))
            _final_page_phase = ((_fp.get("formats", {}).get(_fmt)) or {}).get("final_page_phase")
        except Exception:
            _final_page_phase = "04-keyvisual"   # 폴백(레거시)
        if _final_page_phase and phase == _final_page_phase:
            _page = " ".join(t for t, _ in texts)
            # 제품명 '독립 노출' 검사는 충실 렌더(_final_page_render)로 — gather 일괄 공백결합이 못 구분하는
            #   인라인 split('제품A<span>정'=제품A정) vs 경계 split('제품A정<span>플러스'=제품A정플러스) 구분(코덱스 3R).
            #   다른 4항목(키워드 매칭)은 기존 _page(spaceless _match) 그대로.
            #   가시 렌더 텍스트가 없으면(예: 제품명이 alt 속성에만) 필수기재(가시 노출) 미충족 → flag(fail-closed).
            #   CSS ::before/::after 단어콘텐츠 글루 위험(코덱스 4R) 있으면 정적 검증 불가 → 제품명 fail-closed.
            _rendered, _css = _final_page_render(rdir, phase)
            _glue_risk = _has_gluing_generated_content(_css)
            _prod_name = ((st.get("product") or {}).get("name") or "").strip()   # '{product_name}' 토큰 해석용
            _GENERIC_NAMES = {"", "제품"}   # new-run 기본 플레이스홀더 — '정확한 제품명' 아님(fail-closed 대상, 코덱스 단계2 High)
            for _item in _mi.get("required", []):
                # 누수#3 제거: 검사 신호를 룰셋 항목 signals 에서 읽는다(코드 하드코딩 제거 — 항목 추가 시 코드 무수정으로 검사).
                #   signals 미정의(레거시 룰셋) 항목만 _MI_SIG_LEGACY 폴백. '{product_name}' 토큰 = 정확한 제품명(state.product.name).
                _sig = _item.get("signals")
                if _sig is None:
                    _sig = _MI_SIG_LEGACY.get(_item.get("id"))
                if not _sig:
                    continue   # 신호 정의 없음(레거시 폴백도 없음) → 검사 불가, 스킵(false-flag 금지)
                _satisfied = False
                for s in _sig:
                    if s == "{product_name}":
                        # 정확한 제품명: state.product.name(일반 플레이스홀더 '제품'·빈값 제외)이 충실 렌더에 '독립 노출'돼야 충족.
                        #   _name_present(_rendered): 인라인 split 복원(Medium) + 부분문자열/전각/ZWJ/CGJ/비라틴 fail-open 차단(High, 코덱스 3R·4R).
                        #   _glue_risk(CSS 생성콘텐츠 글루) 시 정적 검증 불가 → 미충족(fail-closed, 코덱스 4R).
                        #   일반 플레이스홀더/미선언이면 어떤 페이지로도 충족 불가 → 필수기재 누락(fail-closed, 코덱스 단계2 High).
                        if _prod_name not in _GENERIC_NAMES and not _glue_risk and _name_present(_rendered, _prod_name):
                            _satisfied = True
                            break
                    elif _match(_page, s):
                        _satisfied = True
                        break
                if not _satisfied:
                    violations.append(_vio("[필수기재 누락]", "mandatory_inclusion", _item.get("ref", ""),
                                           "high", "의약품 필수기재 누락 — %s" % _item.get("label", _item.get("id")), _item.get("id")))

    for (txt, fn_ids) in texts:
        for v in eng.scan_text(txt, fn_ids):
            key = (v["target_text"], v["axis"], v["rule"])
            if key not in seen:
                seen.add(key); violations.append(v)
    for (claim, fn_ids) in claims:
        for v in eng.check_claim(claim, fn_ids):
            key = (v["target_text"], v["axis"], v["rule"])
            if key not in seen:
                seen.add(key); violations.append(v)

    # 03-storyboard plan: 실증 게이트 블록(clinicalEvidence/beforeAfter)은 실증 미등록 시 존재 불가(환각 차단 #1),
    #   등록 시에도 실재 근거+각주를 갖춘 강주장 claim 을 1개 이상 가져야 한다(#3).
    if phase == "03-storyboard" and substage == "plan":
        has_evidence = len(cb["evidence_on_file"]) > 0   # 실증 '파일' 등록 여부(기능성 승인 ref 아님)
        pdir = os.path.join(rdir, "03-storyboard/plan")
        # 수치 차트 충족 '클레임' substantiation_required stale 트리거 억제 — 클레임-스코프 + 정확매칭(Codex FIX M).
        #   ⚠ Codex FIX M(설계): 억제 단위는 '블록'이 아니라 '충족 클레임의 자기 target_text' 하나뿐이다.
        #     한 블록이 어떤 측정 클레임으로 충족되더라도, 그 블록의 무관한 다른 트리거(예: 헤드라인 '모공 축소 확인',
        #     concept, 다른 클레임)는 면제되지 않는다. → 측정 클레임 본인 문구만 통과, 나머지 미실증 주장은 그대로 적발.
        #   ① satisfied_texts = '완전 충족' 클레임 c 의 target_text 집합. 완전 충족 =
        #      claim_strength∈STRONG · evidence_ref∈evidence_ids · footnote_id∈블록 fn_ids ·
        #      _evidence_satisfies(레코드 4요소) · _block_shows_context(기관·n·기간 카피 노출) · _block_has_disclaimer.
        #   ② satisfied_pairs = satisfied_texts 문자열'만' scan_text → (target_text, rule) 수집.
        #   ③ unsatisfied_pairs = 모든 블록 텍스트(_block_scan_texts, gather 동일 범위) 중 satisfied_texts 에
        #      '없는' 문자열을 scan_text → (target_text, rule). (충족 클레임 자기 문구는 제외되어야 억제가 성립.)
        #   ④ suppressible = satisfied_pairs - unsatisfied_pairs. 전역 위반은 axis==substantiation_required AND
        #      rule==_SUBST_TRIGGER_RULE AND (target_text, rule)∈suppressible 일 때만 제거.
        #   ⚠ Codex FIX A: 버킷은 scan_text(트리거) 위반만 담아 rule 이 항상 _SUBST_TRIGGER_RULE 이고, 억제 필터도
        #     rule 을 명시 확인하므로 check_claim 무결성 위반(가짜/누락 근거·각주, 다른 rule)은 절대 억제되지 않는다.
        #   ⚠ 교차블록: satisfied_texts 에 없는 문자열(다른 블록 트리거 포함)은 모두 unsatisfied 로 빠져 억제 불가.
        #   절대 억제 금지 축: drug_misperception / functional_misperception / consumer_deception.
        _plan_blocks = []
        if os.path.isdir(pdir):
            for fn in sorted(os.listdir(pdir)):
                if fn.endswith(".json"):
                    _plan_blocks.append(load_json(os.path.join(pdir, fn)))
        # ⚠ Codex FIX R: 충족 클레임 target_text 제외는 '블록별(per-block)'이어야 한다 — 전역 집합이면
        #   다른 블록(예: hero)의 '동일 문자열' 헤드라인이 unsatisfied 에서 제외돼 잘못 억제된다.
        #   per_block_sat[i] = i번째 블록 '자기' 의 완전 충족 클레임 target_text 집합.
        per_block_sat = []
        # Pass 1: 게이트 검증 + 블록별 충족 클레임 target_text 수집 + 타겟/배너 축 검사.
        for b in _plan_blocks:
            btype = b.get("type")
            fn_ids = {f["id"] for f in b.get("footnotes", [])}
            bsat = set()   # 이 블록 '자기' 의 충족 클레임 target_text
            if btype in ("clinicalEvidence", "beforeAfter"):
                if not has_evidence:
                    violations.append(_vio("[%s]" % btype, "substantiation_required", "실증 미등록",
                                      "high", "실증 미등록 상태에서 실증 게이트 블록 존재(환각 그래프/대비)", btype))
                else:
                    ok = any(c.get("claim_strength") in STRONG and c.get("evidence_ref") in eng.evidence_ids
                             and c.get("footnote_id") in fn_ids for c in b.get("claims", []))
                    # 정성 인증형(evidence-content-integration): clinicalEvidence 는 doc 정성 근거(기관·n·기간·측정쌍
                    #   없음)+맥락+디스클레이머면 강주장 없이도 유효(사용적합 인증-표시형). beforeAfter 는 측정 전용이라 미적용.
                    if not ok and btype == "clinicalEvidence" and _qualitative_cert_ok(b, fn_ids, eng):
                        ok = True
                    if not ok:
                        violations.append(_vio("[%s]" % btype, "substantiation_required", "실증-각주 페어링",
                                          "high", "실증 게이트 블록에 근거·각주 갖춘 강주장 부재", btype))
                    else:
                        block_disc = _block_has_disclaimer(b, eng.clinical_subst["disclaimer"])
                        for c in b.get("claims", []):
                            ref = c.get("evidence_ref")
                            tt = c.get("target_text", "")
                            # ⚠ Codex FIX W: 클레임 문구의 수치/방향이 evidence 와 일치(_claim_consistent_with_evidence)
                            #   할 때만 억제 대상에 넣는다 — 조작 수치("수분 99% 개선")는 충족 판정에서 제외 → 그대로 적발.
                            if (c.get("claim_strength") in STRONG
                                    and ref in eng.evidence_ids
                                    and c.get("footnote_id") in fn_ids
                                    and eng._evidence_satisfies(ref)
                                    and _block_shows_context(b, eng.evidence_details.get(ref), eng.clinical_subst)
                                    and block_disc
                                    and _claim_consistent_with_evidence(tt, eng.evidence_details.get(ref))):
                                if tt:
                                    bsat.add(tt)
                    # ⚠ Codex FIX OO: chart_data 보유 게이트 블록은 트리거 어휘와 무관하게 '5요소'를 HARD GATE 강제 —
                    #   측정 레코드(기관·n·기간·측정쌍) + 카피 노출(기관·n·기간) + 개인차 디스클레이머. 누락 시 distinct
                    #   rule(억제 불가) 위반. (정량 지표처럼 트리거 아닌 metric 차트도 디스클레이머/맥락 없이 렌더 못 함.)
                    _cd = (b.get("visual") or {}).get("chart_data")
                    if isinstance(_cd, dict):
                        _fr = _cd.get("footnote_ref")
                        _ref = next((c.get("evidence_ref") for c in b.get("claims", [])
                                     if c.get("claim_strength") in STRONG and c.get("footnote_id") == _fr
                                     and c.get("evidence_ref") in eng.evidence_ids), None)
                        _detail = eng.evidence_details.get(_ref) if _ref else None
                        if not (_ref and eng._evidence_satisfies(_ref)
                                and _block_shows_context(b, _detail, eng.clinical_subst)
                                and _block_has_disclaimer(b, eng.clinical_subst["disclaimer"])):
                            violations.append(_vio("[%s]" % btype, "substantiation_required", "정량 차트 필수요소",
                                              "high",
                                              "정량 차트 필수요소(시험기관·n수·기간·개인차 디스클레이머) 누락", btype))
            # 추천 타겟: 질환·고민 명사로 타겟팅 금지(의약품/기능성 오인, Codex coverage #5)
            if btype == "targetAudience":
                btext = " ".join([b.get("headline", ""), b.get("subcopy", "")] + (b.get("bodyText") or []) + [_concept_text(b)])
                for term in condition_target:
                    if _match(btext, term):
                        violations.append(_vio(term, "drug_misperception", "추천 타겟 질환·고민 타겟팅",
                                          "high", "질환/효능 고민으로 타겟팅 — 의약품/기능성 오인 소지", term))
            # 브랜드 배너: 제약사 등 전문성을 효능 권위로 쓰는 표현 금지(의약품 오인, Codex coverage #6)
            if btype == "brandBanner":
                btext = " ".join([b.get("headline", ""), b.get("subcopy", "")] + (b.get("bodyText") or []) + [_concept_text(b)])
                for term in pharma_authority:
                    if _match(btext, term):
                        violations.append(_vio(term, "consumer_deception", "제약사 권위 오인",
                                          "high", "제약사/과학 전문성을 효능 권위로 표현 — 의약품 오인 소지", term))
            per_block_sat.append(bsat)
        # Pass 2: 버킷 — 각 블록에서 '자기' 충족 target_text 는 satisfied, 그 외 텍스트는 unsatisfied(per-block 제외).
        satisfied_pairs = set()
        unsatisfied_pairs = set()
        for b, bsat in zip(_plan_blocks, per_block_sat):
            fn_ids = {f["id"] for f in b.get("footnotes", [])}
            for bt in _block_scan_texts(b):
                if not bt:
                    continue
                target_bucket = satisfied_pairs if bt in bsat else unsatisfied_pairs
                for v in eng.scan_text(bt, fn_ids):
                    if v["axis"] == "substantiation_required":
                        target_bucket.add((v["target_text"], v["rule"]))
        # 정확매칭 억제: 충족 클레임 자기 문구에만 등장한 (target_text, rule) 트리거만 제거.
        suppressible = satisfied_pairs - unsatisfied_pairs
        if suppressible:
            violations = [
                v for v in violations
                if not (v["axis"] == "substantiation_required"
                        and v["rule"] == _SUBST_TRIGGER_RULE
                        and (v["target_text"], v["rule"]) in suppressible)
            ]

    # 04-keyvisual: 멀티모달 stand-in — 렌더 self_review(오버플로/레이아웃)를 verdict 에 반영.
    #   '최종 clean'은 이 (다른 세션) 심의 + 사람 승인이 판정(self-grading 차단, Exit a).
    if phase == "04-keyvisual":
        man = os.path.join(rdir, "04-keyvisual/design-manifest.json")
        if os.path.exists(man):
            for s in load_json(man).get("sections", []):
                sr = s.get("self_review", {})
                if sr.get("overflow") or not sr.get("layout_ok", True):
                    violations.append(_vio("[%s]" % s["block"], "consumer_deception", "디자인 품질",
                                      "medium", "섹션 레이아웃 오버플로/이탈(시각검증 미수렴)", s["block"]))
        # F4(NARROW): 화면에 실려 나가는 선택안 생성 이미지의 '픽셀 텍스트'에서 기존 금지 3계열(drug_misperception/
        #   consumer_deception/prescription_otc_distinction)만 OCR 로 훑어 위반 추가. 이건 결정적 룰엔진 점검이지
        #   원격 ADK 심의 호출이 아니다(생성≠심의 격리 유지). 게이트: image-manifest engine=nanobanana 일 때만 —
        #   stub/오프라인은 스캔 자체를 건너뛰어 오프라인 verdict 바이트 불변(image_ocr_scan.scan 이 내부에서 게이트).
        import image_ocr_scan  # 지연 import(순환·이식성): image_ocr_scan 은 kcia_engine 를 모듈-레벨로 import 하지 않는다.
        for _hit in image_ocr_scan.scan(rdir, ruleset.get("axes", {})):
            violations.append(_vio(
                "[%s] %s" % (_hit["image_path"], _hit["hit_term"]),
                _hit["axis"], (ruleset.get("axes", {}).get(_hit["axis"], {}) or {}).get("ref", ""),
                "high", "생성 이미지 픽셀 텍스트 금지어(OCR)", _hit["hit_term"]))

    has_high = any(v["severity"] == "high" for v in violations)
    verdict = {
        "verdict": "fail" if violations else "pass",
        "engine": engine_name,
        "confidence": 0.9 if not violations else (0.95 if has_high else 0.7),
        "violations": violations,
        "escalate": bool(escalate_hardstop),   # 전문의약품 대중광고 하드스톱은 사람 에스컬레이션
    }
    if out_path:
        atomic_write_json(out_path, verdict)
    return verdict


def main():
    args = sys.argv[1:]
    if "--text" in args:
        # 단일 텍스트 모드 (골든셋 회귀용). --domain 으로 도메인 룰셋 선택(미지정 → 2부 1단계: cosmetic 폴백 폐지 → 미완 룰셋 fail-closed).
        dom = args[args.index("--domain") + 1] if "--domain" in args else None
        rs = load_ruleset(dom)
        if not rs.get("axes"):   # 빈/미제공 룰셋 → 조용한 pass 금지(fail-closed)
            print(json.dumps({"verdict": "fail", "violations": [],
                              "note": "심의 룰셋 축 비어있음(미제공/오설정) — 통과 불가"}, ensure_ascii=False))
            return
        i = args.index("--text"); text = args[i + 1]
        func = {"whitening": "unknown", "wrinkle": "unknown", "uv_protection": "unknown"}
        eng = Engine(rs, func, [])
        vio = eng.scan_text(text, set())
        print(json.dumps({"verdict": "fail" if vio else "pass", "violations": vio}, ensure_ascii=False))
        return
    rid, rdir, out = args[0], args[1], args[2]
    engine_name = "ruleset"
    if "--engine" in args:
        engine_name = args[args.index("--engine") + 1]
    v = evaluate(rid, rdir, out, engine_name)
    # 1차 룰엔진 진단 — 현업 점검 화면에 노출되므로 평이어(잭곤 verdict=/violations=/engine= 제거).
    print("[규정 점검·1차] %s · 걸린 부분 %d개" % ("통과" if v["verdict"] == "pass" else "미통과", len(v["violations"])))


if __name__ == "__main__":
    main()
