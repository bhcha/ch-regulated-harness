#!/usr/bin/env python3
"""ingest.py — 결정적 입력 정규화 (설계 §6.0, no-LLM).

  reviews.csv (BOM + RFC4180) → voc.json
  inputs/bundle/images, inputs/assets → assets-manifest.json
  inputs/working-backwards.md → claim-basis.json (결정적 추출, fail-closed)

서브커맨드:
  voc <reviews.csv> <product.json> <bundle_name> <out.json>
  assets <bundle_images_dir> <own_assets_dir> <out.json> [--min N]
  claim-basis <working-backwards.md> <out.json>
  evidence-docs <run_id> --src <evidence_src_dir> --channel <HARNESS_EVIDENCE_DIR|bundle>
"""
import sys, os, csv, json, re, hashlib, unicodedata, shutil, stat, errno, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json, Validator, ROOT as _ROOT, PACKS_DIR as _PACKS_DIR, is_number as _num  # noqa: E402
import clinical_chart  # noqa: E402  (변화율 도출·반올림 단일 출처 ROUND_PREC — P-2 정규화 재사용)

# _ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)
# _PACKS_DIR: harness.PACKS_DIR 를 import (K-1 일원화 — 경로 해석 단일화; PACKS_DIR env 재정의는 harness 가 존중).
#   커스텀/테스트 도메인 팩이 PACKS_DIR 로 주입되면 isolation 어휘도 그 팩에서 읽는다.


def _active_domain():
    d = os.environ.get("HARNESS_DOMAIN")
    if not d:
        raise SystemExit("[ingest] HARNESS_DOMAIN 미설정 — 규제도메인 선언이 필요합니다(2부 1단계: cosmetic 폴백 폐지). new-run/ingest-bundle 이 선언합니다.")
    return d


def _ingest_profile():
    """규제도메인별 추출 프로파일(packs/<도메인>/ingest-profile.json). VOC/기능성/마커/BP 등 값은 팩이 소유한다
    (3단계: harness/ingest-profiles.json + ingest.py 인라인 화장품 상수 폐지 — cosmetic 도 팩에서 읽는다). 미정의 키는
    아래 상수 정의부의 안전-공집합 기본값으로만 폴백(화장품 기본값 폴백 폐지). 도메인은 HARNESS_DOMAIN(ingest-bundle.sh 주입)."""
    dom = _active_domain()
    try:
        return (load_json(os.path.join(_PACKS_DIR, dom, "ingest-profile.json")) or {})
    except Exception:
        return {}


# 지연 평가(lazy + 메모이즈): _ingest_profile() 을 import 시점이 아니라 프로파일이 '실제로 필요한 최초 시점'에만
#   1회 로드한다 → HARNESS_DOMAIN 을 안 넘긴 호출자(도메인 불필요 서브커맨드·단순 import)는 import 단계에서
#   죽지 않는다. 도메인이 필요한 순간엔 _active_domain() 이 기존과 '똑같은 메시지'로 fail-closed(죽는 '위치'만
#   import→사용시점으로 이동). _PROFILE_LOADED sentinel 로 빈 {}/falsy 반환도 올바르게 캐시.
_PROFILE_CACHE = None
_PROFILE_LOADED = False


def _profile():
    """규제도메인 추출 프로파일을 메모이즈 로드(최대 1회, 반복 호출 시 캐시 반환). 도메인 미선언이면 첫 호출에서
    _ingest_profile()→_active_domain() 이 SystemExit(기존과 동일 메시지)."""
    global _PROFILE_CACHE, _PROFILE_LOADED
    if not _PROFILE_LOADED:
        _PROFILE_CACHE = _ingest_profile()
        _PROFILE_LOADED = True
    return _PROFILE_CACHE


# ── lazy 프로파일 액세서(옛 모듈 상수 대체) ──
#   VOC 키워드 — 소비자가 효능을 무엇으로 말하는지. 값은 팩 ingest-profile.json 소유(도메인별). 미정의=공집합.
#   내부 소비 함수는 이 액세서를 지역 변수로 읽고, 외부 importer(`from ingest import ...`)는 아래 __getattr__(PEP 562)
#   가 같은 값을 lazy 로 돌려준다(값·동작 불변, 로드 시점만 지연).
def _voc_keywords():
    return _profile().get("voc_keywords", [])


def _persona_keywords():
    return _profile().get("persona_keywords", [])


def _option_regex():
    return _profile().get("option_regex", "")


# PEP 562 모듈 __getattr__ — 옛 모듈 상수 이름을 lazy 속성으로 유지(외부 importer 후방호환:
#   examples_analysis 의 `from ingest import BP_BLOCK_ORDER`). 값 접근 시점에 _profile() 로드(도메인 미선언이면
#   그 시점에 동일 메시지로 SystemExit — 원래 import 시점 실패와 사람-관측 동작 동일). 매핑은 이름→액세서함수명이라
#   후방 정의(_bp_*/_func_labels)를 call time 에 globals() 로 해석(전방참조 없음).
_LAZY_MODULE_ATTRS = {
    "VOC_KEYWORDS": "_voc_keywords",
    "PERSONA_KEYWORDS": "_persona_keywords",
    "OPTION_REGEX": "_option_regex",
    "BP_BLOCK_ORDER": "_bp_block_order",
    "BP_HINTS": "_bp_hints",
    "FUNC_LABELS": "_func_labels",
    # 옛 `_PROFILE` 모듈 상수도 lazy 별칭으로 유지(외부 importer 후방호환: test-b1g 의
    #   `import ingest as i; i._PROFILE.get('product_type_default')`). _profile() 이 곧 프로파일 dict 액세서라
    #   그대로 매핑 — 값·동작 불변, 로드 시점만 지연(도메인 미선언이면 접근 시 동일 메시지로 SystemExit).
    "_PROFILE": "_profile",
}


def __getattr__(name):   # PEP 562
    accessor = _LAZY_MODULE_ATTRS.get(name)
    if accessor is not None:
        return globals()[accessor]()
    raise AttributeError("module %r has no attribute %r" % (__name__, name))

# WS3+WS4 product_facts 추출은 **제품/도메인 고유 어휘를 core 에 두지 않는다**(범용 BM 하네스 — 특정 상품 비하드코딩).
#   성분/구성품 이름은 generic '구조적' 단서로 추출하고, 도메인 임상지표는 packs/<도메인> 룰셋에서 읽는다.
# 구성품: '명사구 을/를 동봉/증정/…' 직접 인접 패턴만 추출(범용·보수적, 제품 어휘 비의존).
#   명사구=1~2 한글 토큰, 포함 동사 바로 앞(을/를)이라 문장 경계 넘는 오염이 구조적으로 불가.
_COMPONENT_RE = re.compile(r"([가-힣]+(?:\s+[가-힣]+)?)\s*(?:을|를)\s*(동봉되|동봉|증정|함께\s*드리)")
# 성분 추출 줄에 요구하는 generic '함유/배합' 문맥어(임상 결과 수치를 성분 함량으로 오인하는 것 차단).
_INGREDIENT_CONTEXT = ["함유", "함량", "배합", "첨가", "성분", "들어"]
# 구성품 배제 표지(NEG_MARKERS 에 없는 '미포함/별매' 류 — '동봉하지 않' 류는 NEG_MARKERS '않' 이 커버).
_COMPONENT_EXCLUSION_MARKERS = ["미포함", "불포함", "미동봉", "별매", "별도 구매", "별도구매"]
# 명사구 결합 시 제외할 generic 수식/잡토큰(제품명이 아님 — "소재의 위생 핀셋"에서 '소재' 결합 방지).
_COMPONENT_STOP_TOKENS = {"소재", "과정", "직접", "형태", "보관", "휴대", "사용", "제품", "구성", "성분", "기능", "효과"}
# 성분명으로 부적절한 generic 일반어·메타라벨(라벨/인라인 추출 시 스킵 — fail-closed).
#   "제품유형: … 15g"(순중량 메타) 같은 라벨이 성분으로 오추출되는 것 차단.
_INGREDIENT_STOP_TOKENS = {"성분", "유효성분", "주성분", "함량", "함유", "원료", "제품",
                           "제품유형", "유형", "용량", "중량", "순중량", "가격", "구성", "제품명",
                           "브랜드", "분류", "종류", "사용법", "사용방법", "보관", "제형", "본품", "리필"}
# 인접 임상 결과 표지(generic) — 측정대상 단순 언급이 아닌 '측정/확인된 결과'임을 뒷받침.
_CLINICAL_RESULT_MARKERS = ["개선", "도움", "확인", "적합", "판단", "완화", "감소", "평가", "결과"]
# 함량 단위 정규식. 소수(0.5%) 포함 — \d+ 만이면 소수점 뒤만 잡아 '5%' 로 부풀려 기록됨(외부리뷰 P2).
#   '%' 뒤 \b 미매칭 회피 위해 후행 영숫자 부정 lookahead.
_AMOUNT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:ppm|%|mg|ml|g)(?![A-Za-z0-9])", re.IGNORECASE)
# 한국어 조사 꼬리(명사구 경계 정리용).
_PARTICLE_RE = re.compile(r"(을|를|이|가|은|는|와|과|의|으로|로|에서|에|도|만|이나|나)$")


def read_reviews(csv_path):
    """BOM 제거 + RFC4180 파서(content 내 콤마/줄바꿈 안전). 단순 cut/grep 금지."""
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows


def _load_isolation_set():
    """top_phrases 에서 격리할 '위험어'만 룰셋에서 추출(효능·질환·권위·임상 + banned/triggers).
    ⚠ 안전 allowlist(general_allowed)·안전 일반어(lexicon.zero_voc_exclude=커버/촉촉 등)·메타(ref/grade/
    conditional)는 격리하지 않는다(외부리뷰 P2: 안전 VOC 어휘까지 격리하면 voc_phrase 게이트가 정당한 상위
    리뷰 어휘를 못 받음). 파일 없으면 빈 셋(graceful)."""
    domain = _active_domain()
    rp = os.path.normpath(os.path.join(_PACKS_DIR, domain, "ruleset.json"))
    try:
        rs = load_json(rp)
        terms = set()
        axes = rs.get("axes", {})
        # 1) 모든 축의 banned/triggers — 본질적 위험어.
        for ax_val in axes.values():
            if not isinstance(ax_val, dict):
                continue
            for key in ("banned", "triggers"):
                v = ax_val.get(key)
                if isinstance(v, list):
                    terms.update(str(t) for t in v if isinstance(t, str))
        # 2) lexicon 의 효능·질환·권위·임상 어휘 — 단 안전 일반어(zero_voc_exclude)·주석 제외.
        lex = axes.get("lexicon", {})
        if isinstance(lex, dict):
            for k, v in lex.items():
                if k in ("_comment", "zero_voc_exclude") or "allow" in k:
                    continue
                if isinstance(v, list):
                    terms.update(str(t) for t in v if isinstance(t, str))
                elif isinstance(v, dict):
                    for vv in v.values():
                        if isinstance(vv, list):
                            terms.update(str(t) for t in vv if isinstance(t, str))
        return frozenset(terms)
    except Exception:
        return frozenset()


def _load_clinical_metrics():
    """도메인 임상 측정지표 어휘 = packs/<도메인>/ruleset.json 의 axes.lexicon.clinical_metrics.
    제품/도메인 고유 어휘는 core 하드코딩이 아니라 팩 데이터에서 온다. 없으면 빈 리스트(fail-closed:
    지표 없으면 인접 임상 evidence 승격을 아예 안 함). 미구현 도메인 = 빈 리스트."""
    domain = _active_domain()
    rp = os.path.normpath(os.path.join(_PACKS_DIR, domain, "ruleset.json"))
    try:
        rs = load_json(rp)
        v = rs.get("axes", {}).get("lexicon", {}).get("clinical_metrics", [])
        return [str(t) for t in v if isinstance(t, str)]
    except Exception:
        return []


def _ingredient_name_from_line(line, amount_start):
    """함량 단위가 있는 한 '줄'에서 성분명을 generic 구조로 추출(제품 어휘 비의존).
    - 줄에 콜론(:)이 있으면 라벨(콜론 앞, 불릿·괄호 제거, 짧은 라벨만) = 성분명 ('성분명(역할): … N단위' 불릿형)
    - 없으면 함량 직전 마지막 한글 토큰(조사 제거, 일반어 스킵) = 성분명 ('… 성분명 N단위' 인라인형)"""
    if ":" in line or "：" in line:
        label = re.split(r"[:：]", line, 1)[0]
        label = re.sub(r"^[\-\*•\s]+", "", label)
        label = re.sub(r"[\(（][^\)）]*[\)）]", "", label).strip()
        # 메타라벨(제품유형/용량/가격 등)·일반어는 성분명이 아니다(fail-closed).
        label_toks = label.split()
        if (label and len(label_toks) <= 3 and re.search(r"[가-힣]", label)
                and label not in _INGREDIENT_STOP_TOKENS
                and not any(t in _INGREDIENT_STOP_TOKENS for t in label_toks)):
            return label
    before = line[:amount_start]
    toks = re.findall(r"[가-힣]+", before)
    if not toks:
        return None
    last = _PARTICLE_RE.sub("", toks[-1])
    if not last or last in _INGREDIENT_STOP_TOKENS or not re.search(r"[가-힣]", last):
        return None
    # 1~2 토큰 명사구("티트리잎 오일") — 직전 토큰이 조사 제거 후 일반어/메타가 아니면 결합("유효성분: 티트리잎 오일").
    if len(toks) >= 2:
        prev = _PARTICLE_RE.sub("", toks[-2])
        if prev and prev not in _INGREDIENT_STOP_TOKENS:
            return prev + " " + last
    return last


# ─────────────── 다제품 WB 제품 섹션 스코핑 (M-1·M-2, fail-open) ───────────────
# 결정적 세그먼터: WB 를 '제품 섹션'으로 분할해, 선언 제품(state.product.name — 스크립트만 state 를 읽고
#   ingest.py 는 인자로만 선언명을 받는다)이 정확히 한 섹션에 국소화되면 그 섹션(+ 공용 서두)에서만 추출한다.
#   단제품/모호/미발견이면 전체-WB 추출로 폴백(fail-open) — 오늘보다 나빠지지 않고 단제품 골든 바이트 불변.
_WB_HEADING_LEVEL_RE = re.compile(r"^(#{1,6})\s", re.MULTILINE)      # 마크다운 헤딩 + 레벨('#' 개수) 캡처
# 제품 마커 = '라인 시작(불릿 허용) 앵커' 필수 — '이전 제품명:'·'구 제품명:' 같은 비-제품 라벨이 매칭돼
#   단제품을 다제품으로 오판하는 것 차단(외부리뷰 R10 P2). MULTILINE 로 blob 내 각 라인 시작에 매칭.
_MK = r"(?m)^[ \t]*[-*·・•‣◦]?[ \t]*"   # 불릿 = -, *, 가운뎃점(·/・), Word/Docs 불릿(•/‣/◦) 허용(외부리뷰 R14 P2)
_WB_PRODUCT_MARKER_RE = re.compile(_MK + r"(?:제품명|제품유형)\s*[:：]")   # 제품 마커(제품명:/제품유형:)
_WB_PRODUCT_NAME_RE = re.compile(_MK + r"제품명\s*[:：]")                    # 제품 '정체성' 마커(새 제품 경계)
_WB_PRODUCT_TYPE_RE = re.compile(_MK + r"제품유형\s*[:：]")                  # 제품유형 마커(정체성 마커 부재 시 폴백 경계)
_WB_PRODUCT_NAME_VALUE_RE = re.compile(_MK + r"제품명\s*[:：]\s*(.+)")       # 제품명 '값'(정확일치 매칭용)
_WB_PRODUCT_TYPE_VALUE_RE = re.compile(_MK + r"제품유형\s*[:：]\s*(.+)")     # 제품유형 '값'(마커-경계 모드 정체성)


def _token_subseq(short, long_):
    """토큰열 short 가 long_ 의 '연속 부분열'로 등장하면 True(공백-경계 토큰 매칭). 임의 char 부분문자열
    (복합제품A⊃제품A·제품A정⊃제품A)은 토큰이 다르므로 매칭 안 함(외부리뷰 R9)."""
    n, m = len(short), len(long_)
    if n == 0 or n > m:
        return False
    return any(long_[st:st + n] == short for st in range(m - n + 1))


def _match_declared(dn, ident):
    """선언명 dn 을 제품별 정체성 후보 dict(idx→[후보,...])에 매칭. 각 제품의 후보 = {제품명 값, 헤딩} 둘 다 —
    선언이 제품명 또는 헤딩 어느 쪽과 맞아도 식별(외부리뷰 R16: 제품명 누락/불일치라도 헤딩으로 식별). 정확일치 우선,
    없으면 '토큰 연속 부분열'(선언 접미사 '제품A 100정'⊃'제품A' · 선언 단어 '변형C'⊂'브랜드B 뷰티 변형C').
    여러 제품이면 **매칭 토큰 수 최다**만(외부리뷰 R12/R13 최장/최구체 SKU). 임의 char 부분문자열은 토큰 경계상
    매칭 안 함(외부리뷰 R9). 반환 = 매칭 인덱스 리스트(정확히 1건일 때만 국소화; 0/2+ 는 호출부가 폴백)."""
    dt = dn.split()
    exact = [i for i, cands in ident.items() if any(c == dn for c in cands)]
    if exact:
        return exact
    scored = []
    for i, cands in ident.items():
        best_i = 0
        for v in cands:
            vt = (v or "").split()
            if not vt or not dt:
                continue
            if len(dt) <= len(vt) and _token_subseq(dt, vt):
                best_i = max(best_i, len(dt))      # 선언이 후보의 부분열(선언 단어/짧은 명)
            elif len(vt) < len(dt) and _token_subseq(vt, dt):
                best_i = max(best_i, len(vt))      # 후보가 선언의 부분열(선언에 SKU 접미사)
        if best_i > 0:
            scored.append((best_i, i))
    if not scored:
        return []
    best = max(s for s, _ in scored)
    return [i for s, i in scored if s == best]   # 매칭 토큰 최다(최구체)만


def _norm_name(s):
    """제품명 정규화: **괄호 '문자'만** 공백으로 치환(내용은 보존) + 공백 접기 + 앞뒤 제거.
    괄호 문자만 제거하므로 변이 태그 내용은 살아 서로 구분되고('(소형) 패치'→'소형 패치' ≠ '(대형) 패치'→'대형 패치',
    외부리뷰 R14), 브랜드 괄호도 토큰 경계가 맞아 부분열 매칭이 된다('[브랜드사 브랜드B] 멜라…'→'브랜드사 브랜드B 멜라…'
    에서 WB '브랜드B 멜라…'가 토큰 부분열, 외부리뷰 R15). 괄호 '토큰 통째 제거'가 아님(R14 변이 태그 보존)."""
    s = re.sub(r"[\[\]（）()［］{}]", " ", s or "")
    return re.sub(r"\s+", " ", s).strip()


def _segment_wb(text):
    """WB 를 (섹션텍스트, 헤더 or None, 레벨) 리스트로 결정적 분할(문서순).
      레벨 = 헤딩 '#' 개수(1~6); 헤딩 아닌 경계(제품마커 폴백)·공용 서두 = 0.
      경계 = 마크다운 헤딩(우선) 또는 제품마커(헤딩 전무 시 폴백). 첫 경계 이전 = 공용 서두(header=None·level 0).
    결정적(Date/random 무사용, 문서순 안정)."""
    hmatches = list(_WB_HEADING_LEVEL_RE.finditer(text))
    if hmatches:
        bounds = [(m.start(), len(m.group(1))) for m in hmatches]
    else:
        # 헤딩 전무 평문 WB → 제품마커(제품명:/제품유형:) 출현 지점을 경계로(level 0 폴백 세그먼트).
        bounds = [(m.start(), 0) for m in _WB_PRODUCT_MARKER_RE.finditer(text)]
    if not bounds:
        return [(text, None, 0)]
    sections = []
    if bounds[0][0] > 0:
        sections.append((text[:bounds[0][0]], None, 0))   # 공용 서두(첫 경계 이전)
    starts = [b[0] for b in bounds] + [len(text)]
    for i, (pos, lvl) in enumerate(bounds):
        chunk = text[pos:starts[i + 1]]
        header = chunk.split("\n", 1)[0].strip()
        sections.append((chunk, header, lvl))
    return sections


def _tier_products(sections, level, marker_re):
    """레벨-`level` 헤딩 중 자기 span(다음 ≤level 헤딩 전까지)에 marker_re 를 **정확히 1개** 품은 '리프 제품'
    목록. 각 원소 = (heading_idx, end_idx). 마커가 ### 하위섹션에 중첩돼도 제품은 상위 헤딩 단위로 잡혀 그
    제품의 리드-인 메타·근거를 안 버린다(외부리뷰 R7 P1). 마커 2개↑ 헤딩은 **카테고리 그룹핑**(예 '## 패치 라인'
    안에 '### 제품A/B')이라 제외 → 더 깊은 실제 제품 레벨을 tier 로 찾게 한다(외부리뷰 R10 P2)."""
    n = len(sections)
    out = []
    for i in range(n):
        if sections[i][2] != level:
            continue
        end = next((j for j in range(i + 1, n) if 0 < sections[j][2] <= level), n)
        if len(marker_re.findall("".join(sections[j][0] for j in range(i, end)))) == 1:
            out.append((i, end))
    return out


def _block_start(text, pos):
    """평문 마커블록에서 제품명 마커(pos)의 '제품 블록 시작' = 그 라인 시작에서 직전 제품유형 리드-인 라인을 위로
    흡수(외부리뷰 R7 P1: 제품유형이 제품명 앞에 오면 그 제품 유형이 이전 청크/서두로 새는 것 차단). 빈줄·데이터·이전
    제품 마커에서 멈춘다. 결정적."""
    ls = text.rfind("\n", 0, pos) + 1
    while ls > 0:
        pe = ls - 1
        ps = text.rfind("\n", 0, pe) + 1
        line = text[ps:pe].strip().lstrip("-*・ ").strip()
        if line and _WB_PRODUCT_TYPE_RE.match(line):
            ls = ps
        else:
            break
    return ls


def _scope_wb_to_product(text, declared_name):
    """선언 제품명 기준 제품 섹션 스코핑(fail-open). 반환 (scoped_text, audit_msg_or_None, scope_status).
    scope_status: "declared"=국소화 성공(선언 제품 subset) · "unscoped"=다제품인데 국소화 실패(전체-WB, 감사) · None=no-op(스코핑 미발동; 단제품/마커전무/선언명 미지정).
    명백한 다제품이고 선언명이 정확히 '한' 제품에 국소화되면 → 공용 서두 + 그 제품의 '스팬 전체'를 반환한다.
      제품 경계 판정(tier): 제품(마커를 품은 헤딩)이 ≥2 인 '가장 얕은 헤딩 레벨' = 제품 tier. 그 tier 헤딩 단위로
      제품을 잡아 스팬을 앵커링한다 → 마커가 ### 하위섹션에 중첩되거나 제품유형이 제품명보다 앞서도 그 제품의
      메타·근거를 안 버리고 타제품과 안 섞인다(외부리뷰 R6/R7). 헤딩이 제품을 안 나누면(제목만+마커블록) 마커 위치로
      재분할하되 리드-인 제품유형을 흡수한다. 마커 전무면 헤딩-only tier.
    단제품·선언명 미지정/미발견/2건↑ 매칭(모호)이면 → 전체-WB 그대로(폴백). 폴백이 '모호/미발견'이면 감사 메시지."""
    if not declared_name:
        return text, None, None
    sections = _segment_wb(text)
    dn = _norm_name(declared_name)
    by_name = bool(_WB_PRODUCT_NAME_RE.search(text))
    has_marker = by_name or bool(_WB_PRODUCT_TYPE_RE.search(text))
    levels = sorted({sec[2] for sec in sections if sec[2] > 0})

    def _audit(m):
        return ("[claim-basis] 다제품 국소화 실패(%s: '%s') → 전체-WB 추출, 사람 확인 권장"
                % ("모호" if m else "미발견", declared_name))

    def _scope_tier(products, ident):
        # products = [(heading_idx, end_idx)] · ident = {k: [정체성후보,...]}. 매칭 1건이면 (스팬, matched),
        #   아니면 (None, matched) → 호출부가 다음 tier/마커종류를 계속 시도(외부리뷰 R16: 제품명 tier 미매칭이어도
        #   제품유형/헤딩 tier 로 이어가게).
        matched = _match_declared(dn, ident)
        if len(matched) != 1:
            return None, matched
        hi, end = products[matched[0]]
        # 공용 서두 = '구조 레벨'(형제 ≥2 인 가장 얕은 레벨 = 제품/카테고리 tier)의 헤딩 중 '첫 제품-보유'(스팬에
        #   마커 있음) 이전까지. 그 tier 의 마커 '없는' 공유 섹션(## 공통 안내 등)이 앞에 있으면 포함되고(외부리뷰
        #   R18b: 공유 인증/성분/근거 보존), 다른 제품 카테고리(패치 라인 등, 마커 보유)는 제외된다(외부리뷰 R11).
        #   제목(# level1)은 스팬이 문서 전체라 마커를 품지만 구조 레벨이 아니므로 대상이 아니다(항상 서두에 포함).
        lv_counts = {}
        for s in sections:
            if s[2] > 0:
                lv_counts[s[2]] = lv_counts.get(s[2], 0) + 1
        struct = [L for L in sorted(lv_counts) if lv_counts[L] >= 2]
        struct_lv = struct[0] if struct else sections[hi][2]
        first_prod = hi
        for j in range(len(sections)):
            if sections[j][2] != struct_lv:
                continue
            ej = next((k for k in range(j + 1, len(sections)) if 0 < sections[k][2] <= struct_lv), len(sections))
            if _WB_PRODUCT_MARKER_RE.search("".join(sections[k][0] for k in range(j, ej))):
                first_prod = j
                break
        preamble = "".join(sections[j][0] for j in range(min(first_prod, hi)))
        # 중첩 제품(제품 레벨 > 구조 레벨)이면 조상 카테고리의 '리드-인'(카테고리 헤딩 ~ 첫 자식 전 = 그 카테고리의
        #   공유 제품유형/인증)을 포함한다(외부리뷰 R19: 선택 제품에 적용되는 카테고리 메타 유실 방지). 형제 카테고리·
        #   형제 제품은 여전히 제외(리드-인은 조상~첫자식까지만).
        cat_leadin = ""
        if sections[hi][2] > struct_lv:
            anc = max((j for j in range(hi) if sections[j][2] == struct_lv), default=None)
            if anc is not None:
                first_child = next((k for k in range(anc + 1, len(sections)) if sections[k][2] > struct_lv), hi)
                cat_leadin = "".join(sections[j][0] for j in range(anc, first_child))
        span = "".join(sections[j][0] for j in range(hi, end))
        return preamble + cat_leadin + span, matched

    if has_marker:
        # 마커 종류 우선순위: 제품명(정체성) → 제품유형(폴백). 각 종류로 tier·마커경계 검출을 시도한다 —
        #   제품유형은 전 섹션에 있는데 제품명은 한 섹션만 있어도 제품유형으로 tier 를 잡게(외부리뷰 R15 P2a).
        marker_specs = []
        if by_name:
            marker_specs.append((_WB_PRODUCT_NAME_RE, _WB_PRODUCT_NAME_VALUE_RE))
        if bool(_WB_PRODUCT_TYPE_RE.search(text)):
            marker_specs.append((_WB_PRODUCT_TYPE_RE, _WB_PRODUCT_TYPE_VALUE_RE))

        def _blob_ident(hi, end):   # 제품 정체성 후보 = [제품명 값(있으면), 헤딩] 둘 다(제품명 OR 헤딩으로 매칭·R16)
            blob = "".join(sections[j][0] for j in range(hi, end))
            cands = []
            m = _WB_PRODUCT_NAME_VALUE_RE.search(blob)
            if m:
                cands.append(_norm_name(m.group(1)))
            h = _norm_name(re.sub(r"^#+\s*", "", sections[hi][1] or ""))
            if h:
                cands.append(h)
            return cands

        last_matched = []
        # (1) 헤딩 tier = 리프 제품(마커 정확히 1개 헤딩)이 ≥2 인 레벨(카테고리 그룹핑 레벨은 건너뜀). 얕은→깊은
        #   모든 레벨·마커종류를 스캔하고 **유니크 매칭에서만** 반환한다. 이 레벨 매칭 0건(제품이 더 깊은 tier 에
        #   있음)이면 다음 레벨을 계속 본다(외부리뷰 R17: 단제품 카테고리 2개 + 다제품 카테고리 혼합). 모호(≥2)는
        #   기록만 하고 계속(끝내 유니크 없으면 모호로 폴백; break 로 얕은 레벨을 authoritative 삼지 않음).
        for mre, _vre in marker_specs:
            for L in levels:
                products = _tier_products(sections, L, mre)
                if len(products) >= 2:
                    scoped, matched = _scope_tier(products, {k: _blob_ident(hi, end) for k, (hi, end) in enumerate(products)})
                    if scoped is not None:
                        return scoped, None, "declared"
                    if matched:
                        last_matched = matched   # 모호(≥2) 기록 — 미발견(0)보다 우선 표기
        # (2) 마커 위치로 재분할(제목+마커블록·R5/R7 · 헤딩 제품과 flat 마커블록 혼합·R18a). tier 에서 '모호'가
        #   나왔으면(last_matched 비지 않음) 그건 진짜 모호라 마커-경계로 안 뒤집는다(모호→미발견 방지·R16).
        #   tier 가 선언 제품을 못 찾았거나(미발견·0건) tier 자체가 없으면 마커-경계를 시도한다(R18a).
        for mre, vre in ([] if last_matched else marker_specs):
            positions = [m.start() for m in mre.finditer(text)]
            if len(positions) < 2:
                continue
            blk = sorted({_block_start(text, p) for p in positions})
            starts = blk + [len(text)]
            chunks = [text[blk[i]:starts[i + 1]] for i in range(len(blk))]
            ident = {}
            for i, ch in enumerate(chunks):
                cands = []   # 후보 = 제품명 값 + 제품유형 값(제품유형으로 분할해도 청크의 제품명으로 매칭·외부리뷰 R20a)
                mn = _WB_PRODUCT_NAME_VALUE_RE.search(ch)
                if mn:
                    cands.append(_norm_name(mn.group(1)))
                mt = _WB_PRODUCT_TYPE_VALUE_RE.search(ch)
                if mt:
                    cands.append(_norm_name(mt.group(1)))
                ident[i] = cands
            matched = _match_declared(dn, ident)
            if len(matched) == 1:
                # 헤딩 없는 플랫 마커 WB 는 신뢰할 공유 섹션이 없다 — 첫 블록 이전(첫 제품의 인증/근거 등 메타일 수
                #   있음)을 preamble 로 붙이면 뒤 제품에 유출된다(외부리뷰 R20b). 그 제품 청크만 반환(fail-safe).
                return chunks[matched[0]], None, "declared"
            last_matched = matched   # 이 마커 종류로 국소화 실패 → 다음 종류 시도
        # 모든 종류로 tier·경계 국소화 실패. 마커가 ≥2(다제품)면 fail-open+감사, <2(단제품)면 조용한 no-op(골든 불변).
        multi = any(len(mre.findall(text)) >= 2 for mre, _vre in marker_specs)
        return (text, _audit(last_matched), "unscoped") if multi else (text, None, None)

    # 마커 전무 → 스코핑하지 않고 전체-WB 폴백(외부리뷰 R8 P2). 마커(제품명/제품유형) 없이 헤딩만으로는
    #   '제품 헤딩'과 '섹션 헤딩(보유 실증 자료·사용법 등)'을 구분할 수 없어, 단제품 WB 를 다제품으로 오판하면
    #   같은 제품의 실증/성분 섹션을 버린다(오늘보다 나빠짐). 사용자 확정 fail-open 원칙상 모호하면 전체-WB.
    #   신뢰 가능한 다제품 스코핑은 제품명/제품유형 마커가 있을 때만 한다(사람이 마커로 선언 → 위 has_marker 경로).
    return text, None, None


def _extract_product_facts(wb_path, declared_name=None):
    """WB 텍스트에서 제품 사실(pack_count·key_ingredients·components) 결정적 추출(fail-closed).
    근거 없으면 null/빈 배열. 파일 없어도 안정 형태를 반환. **제품 어휘 비하드코딩** — generic 구조 추출.
    declared_name 이 주어지고 명백한 다제품이면 그 제품 섹션으로 스코핑(감사줄은 claim-basis 가 단일로 냄)."""
    pack_count = None
    key_ingredients = []
    components = []

    if not wb_path or not os.path.exists(wb_path):
        return {"pack_count": pack_count, "key_ingredients": key_ingredients, "components": components}

    with open(wb_path, "r", encoding="utf-8") as f:
        text = f.read()
    text_clean = re.sub(r"[*_`]", "", text)
    # M-2: 선언제품 섹션 스코핑(fail-open). 감사줄 중복을 피해 여기선 조용히 스코프(claim-basis 가 같은 WB·선언명으로 1줄 냄).
    #   scope 상태(3번째 반환)는 voc 태깅 범위 밖 → 무시.
    text_clean, _scope_audit, _ = _scope_wb_to_product(text_clean, declared_name)

    # 숫자 천단위 콤마 제거("10,000"→"10000") — 콤마가 함량 토큰을 쪼개는 것 방지.
    text_norm = re.sub(r"(\d),(\d)", r"\1\2", text_clean)

    # pack_count: (\d+)\s*매 — 단 부정/계획 절은 제외(외부리뷰 P2: "30매가 아니라 60매"·"30매 구성 예정" 누출 차단).
    for cl in _split_clauses(text_norm):
        if _negated(cl) or any(p in cl for p in PLANNED_MARKERS):
            continue
        m_pc = re.search(r"(\d+)\s*매", cl)
        if m_pc:
            pack_count = int(m_pc.group(1))
            break

    # key_ingredients: '함량 단위(ppm/%/mg/ml/g)' 가 있는 '줄' 단위 generic 구조 추출(제품 성분 어휘 비의존).
    #   줄 자체가 부정/계획이면 적재 안 함(fail-closed). 또 '함유/배합' 문맥어가 있는 줄만 —
    #   "유분량 20% 개선" 같은 임상 결과 수치를 성분 함량으로 오인하지 않게(외부리뷰 P2).
    seen_ingredients = {}  # name → amount (중복 제거, 첫 출현 우선)
    for line in text_norm.split("\n"):
        line = line.strip()
        am = _AMOUNT_RE.search(line)
        if not am:
            continue
        if _negated(line) or any(p in line for p in PLANNED_MARKERS):
            continue
        # D-2: 비교 문맥 deny — "N% 동일/일치/유사/같/同" 는 성분 함량이 아니라 비교 표현(마케팅 절대표현).
        #   기존 _INGREDIENT_CONTEXT('성분' 등) 만으로는 "주요 성분: …와 100% 동일" 같은 줄을 함량으로 오파싱한다.
        if re.match(r"\s*(동일|일치|유사|같|同)", line[am.end():am.end() + 8]):
            continue
        if not any(c in line for c in _INGREDIENT_CONTEXT):
            continue
        name = _ingredient_name_from_line(line, am.start())
        if name and name not in seen_ingredients:
            seen_ingredients[name] = am.group(0).strip()
    key_ingredients = [{"name": n, "amount": a} for n, a in sorted(seen_ingredients.items())]

    # components: '명사구 을/를 동봉/증정/제공' 직접 인접 패턴만(_COMPONENT_RE) — 제품 구성품 어휘 비의존.
    #   포함 동사 바로 앞 명사구라 문장 경계 넘는 오염 불가(외부리뷰 P2). 동사 직후 부정/배제/계획이면 제외(fail-closed).
    comp_set = {}
    for m in _COMPONENT_RE.finditer(text_norm):
        name = re.sub(r"\s+", " ", m.group(1)).strip()
        cue_end = m.end()
        post = text_norm[m.start(2):cue_end + 10]
        if (any(x in post for x in _COMPONENT_EXCLUSION_MARKERS)
                or any(neg in post for neg in NEG_MARKERS)
                or any(p in post for p in PLANNED_MARKERS)):
            continue
        toks = name.split()
        # 선두 generic 수식/잡토큰 제거("소재의 위생 핀셋" → "위생 핀셋"; "구성 지퍼파우치" → "지퍼파우치").
        while len(toks) > 1 and (toks[0] in _COMPONENT_STOP_TOKENS or _PARTICLE_RE.search(toks[0])):
            toks = toks[1:]
        name = " ".join(toks)
        last = _PARTICLE_RE.sub("", toks[-1]) if toks else ""
        if not last or last in _COMPONENT_STOP_TOKENS:
            continue
        if len(toks) == 1:
            name = last
        comp_set.setdefault(name, True)
    comps = list(comp_set.keys())
    dominated = set()
    for t in comps:
        for o in comps:
            if o != t and t in o:
                dominated.add(t)
    components = sorted(t for t in comps if t not in dominated)

    return {"pack_count": pack_count, "key_ingredients": key_ingredients, "components": components}


def cmd_voc(args):
    csv_path, product_path, bundle_name, out_path = args[0], args[1], args[2], args[3]
    # WS3+WS4: 선택적 5번째 인수 = WB 경로(없거나 파일 부재 시 graceful)
    wb_path = args[4] if len(args) > 4 else None
    # M-2: 선택적 6번째 인수 = 선언 제품명(다제품 WB 에서 product_facts 를 그 제품 섹션으로 스코핑). 빈 값이면 폴백.
    declared_name = _clean_decl_str(args[5]) if len(args) > 5 else None
    rows = read_reviews(csv_path)
    product = load_json(product_path) if os.path.exists(product_path) else {}

    # 도메인 프로파일 어휘 = lazy 액세서 경유(옛 모듈 상수와 값·순서 동일; 여기서 처음 프로파일이 필요하면 로드).
    VOC_KEYWORDS = _voc_keywords()
    PERSONA_KEYWORDS = _persona_keywords()
    OPTION_REGEX = _option_regex()

    # 키워드 빈도 = 해당 키워드를 포함한 '리뷰 건수'
    kw_freq = {k: 0 for k in VOC_KEYWORDS}
    persona = {k: 0 for k in PERSONA_KEYWORDS}
    rating_dist = {}
    option_dist = {}
    repurchase_col = None   # WS2: 재구매 컬럼 감지
    repurchase_count = 0

    for r in rows:
        content = (r.get("content") or "")
        for k in VOC_KEYWORDS:
            if k in content:
                kw_freq[k] += 1
        for k in PERSONA_KEYWORDS:
            if k in content:
                persona[k] += 1
        score = (r.get("score") or "").strip()
        if score:
            rating_dist[score] = rating_dist.get(score, 0) + 1
        # 옵션 색호 추출: "색상: 21호 ..." → "21호" (도메인 프로파일 regex; 빈 값이면 옵션 분포 생략)
        opt = (r.get("option") or "")
        m = re.search(OPTION_REGEX, opt) if OPTION_REGEX else None
        if m:
            key = m.group(1) + "호"
            option_dist[key] = option_dist.get(key, 0) + 1
        # WS2 top_signals: 재구매 컬럼 감지(repurchase | 재구매)
        if repurchase_col is None:
            for col in r.keys():
                if col in ("repurchase", "재구매"):
                    repurchase_col = col
                    break
        if repurchase_col:
            val = (r.get(repurchase_col) or "").strip().upper()
            if val in ("Y", "TRUE", "1", "YES"):
                repurchase_count += 1

    # WS2 top_phrases: 리뷰 전체 한글 2자+ 형태소 빈도(단순 set per review → 리뷰 건수 기준)
    top_n = _profile().get("top_n", 30)
    min_freq = _profile().get("min_freq", 3)
    efficacy_filter = _profile().get("efficacy_filter", True)
    isolation_set = _load_isolation_set()

    phrase_counts = {}
    for row in rows:
        content = row.get("content", "") or ""
        tokens_in_review = set(re.findall(r'[가-힣]{2,}', content))
        for tok in tokens_in_review:
            phrase_counts[tok] = phrase_counts.get(tok, 0) + 1

    # 빈도 내림차순 → 동순위는 어휘 오름차순(결정적)
    sorted_phrases = sorted(phrase_counts.items(), key=lambda x: (-x[1], x[0]))
    top_phrases = {}
    top_phrases_efficacy_filtered = {}
    count = 0
    for phrase, freq in sorted_phrases:
        if freq < min_freq:
            continue
        is_isolated = any(
            phrase == term or (len(term) >= 2 and term in phrase)
            for term in isolation_set
        ) if efficacy_filter else False
        if is_isolated:
            top_phrases_efficacy_filtered[phrase] = freq
        else:
            if count < top_n:
                top_phrases[phrase] = freq
                count += 1

    # WS3: offer from product.json price 객체(price.current 존재 시에만)
    price_obj = product.get("price") or {}
    offer = None
    if price_obj.get("current") is not None:
        offer = {
            "price": int(price_obj["current"]),
            "discount": price_obj.get("discountRate") if price_obj.get("discountRate") is not None else None,
        }

    # WS4: product_facts from WB 텍스트(파일 없으면 안정 형태). 선언명 있으면 다제품 섹션 스코핑(fail-open).
    product_facts = _extract_product_facts(wb_path, declared_name)

    voc = {
        "source": {"bundle": bundle_name, "parser": "rfc4180 (BOM 제거, python csv)", "rows": len(rows)},
        "review_count": {
            "collected": product.get("collectedReviewCount", len(rows)),
            "site_total": product.get("totalReviewCount"),
        },
        "rating": product.get("rating"),
        "rating_distribution": dict(sorted(rating_dist.items(), key=lambda x: x[0], reverse=True)),
        "option_distribution": dict(sorted(option_dist.items(), key=lambda x: -x[1])),
        "keyword_frequency": kw_freq,
        "persona_signals": persona,
        "top_phrases": top_phrases,
        "top_phrases_efficacy_filtered": top_phrases_efficacy_filtered,
        "product_facts": product_facts,
    }
    if offer is not None:
        voc["offer"] = offer
    if repurchase_col is not None:
        voc["top_signals"] = {"repurchase_count": repurchase_count}
    atomic_write_json(out_path, voc)
    print("[voc] %d개 리뷰 파싱 → %s" % (len(rows), out_path))


def _scan_images(d):
    static = gif = 0
    gif_files = []
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            ext = os.path.splitext(fn)[1].lower()
            if ext == ".gif":
                gif += 1
                gif_files.append(fn)
            elif ext in (".jpg", ".jpeg", ".png", ".webp"):
                static += 1
    return {"count": static + gif, "static": static, "gif": gif, "gif_files": gif_files}


def cmd_assets(args):
    bundle_images_dir, own_dir, out_path = args[0], args[1], args[2]
    min_required = 8
    if "--min" in args:
        min_required = int(args[args.index("--min") + 1])

    # F5c: 자산 역할 사이드카(apply-intake 가 role 선언 시 own_dir 에 기록)를 읽어 매칭 자산 엔트리에만 role 을 붙인다.
    #   safe-filename → role 매핑. 사이드카 부재/비JSON/미매칭 → role 무기재 → 매니페스트 바이트 불변(골든 유지).
    asset_roles = {}
    roles_path = os.path.join(own_dir, _ASSET_ROLES_SIDECAR)
    if os.path.isfile(roles_path):
        try:
            _loaded = load_json(roles_path)
        except Exception:
            _loaded = None
        if isinstance(_loaded, dict):
            for k, v in _loaded.items():
                if isinstance(v, str) and v in _INTAKE_ASSET_ROLES:
                    asset_roles[k] = v

    own_files = []
    if os.path.isdir(own_dir):
        for fn in sorted(os.listdir(own_dir)):
            ext = os.path.splitext(fn)[1].lower()
            if ext in (".jpg", ".jpeg", ".png", ".webp", ".svg"):
                entry = {"path": os.path.join("inputs/assets", fn), "ext": ext.lstrip(".")}
                if fn in asset_roles:
                    entry["role"] = asset_roles[fn]   # 역할이 선언된 자산에만 추가(그 외 엔트리는 바이트 불변)
                own_files.append(entry)

    manifest = {
        "own_assets": {
            "count": len(own_files),
            "min_required": min_required,
            "sufficient": len(own_files) >= min_required,
            "files": own_files,
        },
        "bundle_images": {
            "detail": _scan_images(os.path.join(bundle_images_dir, "detail")),
            "main": _scan_images(os.path.join(bundle_images_dir, "main")),
        },
    }
    atomic_write_json(out_path, manifest)
    print("[assets] 자사 %d장 / 번들 detail %d·main %d → %s" % (
        len(own_files), manifest["bundle_images"]["detail"]["count"],
        manifest["bundle_images"]["main"]["count"], out_path))


# ─────────────── best-practices (크롤 베스트프랙티스 텍스트 분석, no-pixel) ───────────────
# 크롤 상세컷을 '블록타입별 구도/컷유형 텍스트'로만 분석한다(디자인 src 아님 — 저작권).
#   composition_note 는 tone substage 에서 kcia scan_text 를 통과해야 하므로 효능/질환/권위/절대어 0.
# bp_block_order·bp_hints 값은 팩 ingest-profile.json 소유(도메인별; 비화장품은 현 화장품 상속분 명시 착지).
#   미정의=공집합(빈 best-practices). bp_hints 값은 JSON 2원소 배열 → `shot, comp = BP_HINTS[t]` 동일 언패킹.
#   lazy 액세서(옛 모듈 상수 대체): cmd_best_practices 안에서 지역 변수로 읽는다(값 불변, 로드 시점만 지연;
#   외부 노출은 __getattr__ 가 BP_BLOCK_ORDER 로 유지).
def _bp_block_order():
    return _profile().get("bp_block_order", [])


def _bp_hints():
    return _profile().get("bp_hints", {})


def cmd_best_practices(args):
    images_dir, out_path = args[0], args[1]
    detail = os.path.join(images_dir, "detail")
    files = []
    if os.path.isdir(detail):
        files = [fn for fn in sorted(os.listdir(detail))
                 if os.path.splitext(fn)[1].lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif")]
    BP_BLOCK_ORDER = _bp_block_order()
    BP_HINTS = _bp_hints()
    # 결정적 분배: 정렬된 크롤컷을 블록타입에 round-robin 배정(분석 '대상' 텍스트로만 기록).
    buckets = {t: [] for t in BP_BLOCK_ORDER}
    for i, fn in enumerate(files):
        buckets[BP_BLOCK_ORDER[i % len(BP_BLOCK_ORDER)]].append(
            os.path.join("inputs/bundle/images/detail", fn))
    blocks = []
    for t in BP_BLOCK_ORDER:
        shot, comp = BP_HINTS[t]
        sf = buckets[t]
        blocks.append({
            "block_type": t, "shot_type": shot, "composition_note": comp,
            "motion": any(f.lower().endswith(".gif") for f in sf),
            "source_files": sf,
        })
    out = {
        "analyzed_dir": "inputs/bundle/images/detail",
        "total_images": len(files),
        "blocks": blocks,
        "source": {"from": "inputs/bundle/images", "extracted_by": "ingest.py (deterministic, no-pixel)"},
    }
    atomic_write_json(out_path, out)
    print("[best-practices] %d개 크롤컷 → %d 블록타입 텍스트 분석(no-pixel) → %s" % (len(files), len(blocks), out_path))


# ─────────────── claim-basis 결정적 추출 (fail-closed) ───────────────
# 워킹백워드 마크다운에서 '근거 있는 항목만' 채운다. 근거 표지가 없으면 unknown/[].
def _func_labels():   # 값은 팩 ingest-profile.json 소유(도메인 기능성 라벨→어휘). 미정의=공집합. lazy 액세서(옛 모듈 상수 대체; 외부 노출은 __getattr__ 가 FUNC_LABELS 로 유지).
    return _profile().get("functional_labels", {})
# 기능성 'approved' 는 **제품-수준 심사·보고·통지** 근거가 같은 절(clause)에 명시될 때만 인정.
#   noun '기능성 표시' 단독·'고시성분'·'식약처' 만으로는 승인 불가(오추출/leak 방지).
APPROVAL_STRONG = ["심사필", "심사·보고", "심사를 받", "심사 완료", "심사받", "보고된", "보고한",
                   "보고를 완료", "보고 완료", "통지", "승인받", "승인된"]
# 실증 표지: '보유/완료/결과/성적서' 등 '확보' 의미가 함께 있어야 evidence_on_file 인정(예정/계획 제외).
EVIDENCE_MARKERS = ["인체적용시험", "인체외시험", "임상시험", "시험성적", "유효성 평가", "시험 결과"]
POSSESSION_MARKERS = ["보유", "확보", "결과", "성적서", "완료", "입수", "n="]
PLANNED_MARKERS = ["예정", "계획", "준비중", "준비 중", "진행중", "진행 중", "추진", "예정입니다", "계획 단계"]
# 부정 표지(확장): 근거 표지가 있어도 같은 절에 이게 있으면 approved/evidence 불인정.
NEG_MARKERS = ["없음", "없다", "없는", "없슴", "불가", "불가능", "아님", "아니라", "아니", "미해당", "비대상",
               "대상이 아", "대상 아", "대상 외", "제외", "미보유", "미신청", "미확보", "않", "못 ",
               "표시하지", "해당하지", "해당 없"]
GOSI_INGREDIENT = ["고시성분", "고시 성분"]


def _negated(clause):
    return any(neg in clause for neg in NEG_MARKERS)


def _split_clauses(text):
    # 절(clause) 단위 분리: 줄/콤마/콜론/화살표/세미콜론/문장부호.
    #   라벨·근거·부정을 '같은 절' 안에서만 결합 → 무관 라벨 간 근거 전이(leak) 차단.
    return [c for c in re.split(r"[\n,，:：;；→.。．]+", text) if c.strip()]


def cmd_claim_basis(args):
    wb_path, out_path = args[0], args[1]
    # M-2: 선택적 3번째 인수 = 선언 제품명(state.product.name; 스크립트만 state 읽음 — 규칙). 빈 값이면 폴백(레거시).
    declared_name = _clean_decl_str(args[2]) if len(args) > 2 else None
    # provenance: run 내부 WB 사본을 'run 루트 기준 상대경로'로 가리킨다(run-id 미포함 → 결정성 유지·추적 가능).
    #   out_path = runs/<id>/00-ingest/claim-basis.json → run 루트 = 두 단계 위. 기본 파일명 하드코딩(거짓 provenance) 정정.
    _run_root = os.path.dirname(os.path.dirname(os.path.abspath(out_path)))
    try:
        _src_from = os.path.relpath(os.path.abspath(wb_path), _run_root)
    except ValueError:
        _src_from = os.path.basename(wb_path)
    text = ""
    if os.path.exists(wb_path):
        with open(wb_path, "r", encoding="utf-8") as f:
            text = f.read()
    # 마크다운 강조(**·*·_·`) 제거 — 'A 보고**된' 처럼 표지가 쪼개지는 것 방지.
    text = re.sub(r"[*_`]", "", text)

    # M-1·M-2: 선언제품 섹션 스코핑(fail-open) — 다제품 WB 에서 타제품의 product_type·evidence·certs·func·
    #   notified·unsupported 혼입을 차단한다. 단제품/모호/미발견이면 전체-WB 그대로(폴백) → 모호/미발견은 감사 1줄.
    text, _scope_audit, _scope_status = _scope_wb_to_product(text, declared_name)
    if _scope_audit:
        sys.stderr.write(_scope_audit + "\n")

    clauses = _split_clauses(text)

    FUNC_LABELS = _func_labels()   # lazy 액세서 경유(값 불변; 여기서 처음 프로파일이 필요하면 로드)
    func = {}
    for key, labels in FUNC_LABELS.items():
        status, ref = "unknown", None
        for cl in clauses:
            if not any(lbl in cl for lbl in labels):
                continue
            if _negated(cl):
                continue
            if any(g in cl for g in GOSI_INGREDIENT):     # 고시성분(성분 언어) 절은 기능성 승인 근거 아님
                continue
            if any(mk in cl for mk in APPROVAL_STRONG):    # 제품-수준 심사·보고·통지 강한 표지 필수
                status, ref = "approved", _make_ref(key, cl)
                break
        func[key] = {"status": status, "evidence_ref": ref}

    # 보유 실증(evidence_on_file): 실증 표지 + 확보/완료 표지 + 비부정 + 비계획(예정/진행중 제외).
    evidence = []
    # WS1 인접 임상 measure 어휘는 **도메인 팩**에서 로드(제품/도메인 고유 어휘 비하드코딩).
    #   미설정 도메인 = 빈 리스트 → 인접 evidence 승격 자체를 안 함(fail-closed).
    _clinical_metrics = _load_clinical_metrics()
    for i, cl in enumerate(clauses):
        if _negated(cl) or any(p in cl for p in PLANNED_MARKERS):
            continue
        if any(mk in cl for mk in EVIDENCE_MARKERS) and any(p in cl for p in POSSESSION_MARKERS):
            ev_id = "ev-%02d" % (len(evidence) + 1)
            evidence.append({
                "id": ev_id, "kind": _evidence_kind(cl),
                "grade": _evidence_grade(cl), "source": _src_from,
                "summary": cl.strip()[:120],
            })
            # WS1: 직후 3절 이내에 임상 개선 표지가 있으면 추가 evidence 1건 추출(fail-closed).
            #   본 루프와 동일하게 부정(_negated)·계획(PLANNED_MARKERS) 절은 제외 —
            #   "개선은 진행 중"(계획)·"개선은 확인되지 않음"(부정)이 유효 근거로 승격되는 것 차단.
            for j in range(i + 1, min(i + 4, len(clauses))):
                next_cl = clauses[j]
                if _negated(next_cl) or any(p in next_cl for p in PLANNED_MARKERS):
                    continue
                # 측정대상 표지(도메인 팩) + 결과 표지(generic) 동시 충족 시에만 승격(단순 언급 차단).
                if any(mk in next_cl for mk in _clinical_metrics) and \
                   any(rm in next_cl for rm in _CLINICAL_RESULT_MARKERS):
                    extra_id = "ev-%02d" % (len(evidence) + 1)
                    # kind 는 트리거(시험) 절의 실제 종류 보존 — in_vitro/시험성적을
                    #   clinical_trial 로 오표기해 임상 블록을 무근거 해금하는 것 차단(외부리뷰 P2).
                    evidence.append({
                        "id": extra_id, "kind": _evidence_kind(cl),
                        "grade": _evidence_grade(cl), "source": _src_from,
                        "summary": next_cl.strip()[:120],
                    })
                    break  # 트리거당 1건

    # 고시성분: '고시'/'성분' 표지가 붙은 성분명 추출은 보수적으로 비움(근거 표시 없으면 채우지 않음)
    notified = []
    for m in re.finditer(r"고시성분[:\s]*([^\n,.;]+)", text):
        notified.append({"name": m.group(1).strip(), "evidence_ref": None})

    # 인증: '보유/획득' 등 확보 표지가 있고 부정되지 않은 절에서만 인정(fail-closed).
    certs = []
    CERT_KWS = _profile().get("cert_keywords", [])  # 인증 키워드 = 팩 ingest-profile.json 소유(도메인별). 미정의=공집합.
    for cl in clauses:
        if _negated(cl) or any(p in cl for p in PLANNED_MARKERS):
            continue
        if not any(p in cl for p in ["보유", "획득", "인증받", "인증을 받", "취득"]):
            continue
        for kw in CERT_KWS:
            if kw in cl and kw not in certs:
                certs.append(kw)

    product_type = _profile().get("product_type_default", "")  # 기본 제품유형 = 팩 ingest-profile.json 소유(도메인별).
    m = re.search(r"제품유형[:\s]*([^\n,，]+)", text)   # 콤마 앞 유형만(구성/용량 텍스트 제외)
    if m:
        product_type = m.group(1).strip().strip("|").strip()   # D-2: md 테이블 셀 파이프 잔존("| 화장품 |") 제거

    # unsupported: 워킹백워드에 등장하지만 approved/evidence 근거 없는 효능어
    unsupported = []
    EFFICACY_WORDS = _profile().get("efficacy_words", [])  # 효능 어휘 = 팩 ingest-profile.json 소유(도메인별). 미정의=공집합.
    approved_terms = set()
    for key, v in func.items():
        if v["status"] == "approved":
            approved_terms.update(FUNC_LABELS[key])
    for w in EFFICACY_WORDS:
        if w in text and w not in approved_terms and not any(w in e["summary"] for e in evidence):
            if w not in unsupported:
                unsupported.append(w)

    claim_basis = {
        "functional_status": func,
        "notified_ingredients": notified,
        "certifications": certs,
        "product_type": product_type,
        "evidence_on_file": evidence,
        "unsupported_claims": unsupported,
        "source": {"from": _src_from, "extracted_by": "ingest.py (deterministic, fail-closed)"},
    }
    # A-DEF-2 커밋③: 다제품 WB 스코핑 상태를 문서-레벨 태그로 가시화(하류 build_context·RA). declared=국소화 성공,
    #   unscoped=다제품인데 국소화 실패해 전체-WB 추출(사람 확인 권장). scope 미발동(단제품/마커전무/선언명 미지정,
    #   _scope_status=None)이면 키를 아예 넣지 않는다 → 단제품 골든 claim-basis.json 바이트 불변(후방호환).
    if _scope_status:
        claim_basis["product_scope"] = _scope_status
    atomic_write_json(out_path, claim_basis)
    approved = [k for k, v in func.items() if v["status"] == "approved"]
    print("[claim-basis] approved=%s · evidence=%d · unsupported=%s → %s" % (
        approved or "없음", len(evidence), unsupported or "없음", out_path))


def _make_ref(key, sent):
    return "func-%s-1" % key


def _evidence_kind(sent):
    if "인체적용시험" in sent or "임상" in sent:
        return "clinical_trial"
    if "인체외시험" in sent:
        return "in_vitro"
    if any(mk in sent for mk in ["통지", "심사", "보고", "고시"]):
        return "notification"
    return "other"


def _evidence_grade(sent):
    if "인체적용시험" in sent:
        return "인체적용시험"
    if "인체외시험" in sent:
        return "인체외시험"
    return "기타"


def _clean_decl_str(x):
    """반영 선언 텍스트 정규화: 문자열이면 앞뒤 공백 제거(그 외 타입/None 은 그대로).
    공백-only(' ') 선언이 완전성 게이트를 truthy 로 통과해 빈 내용이 승격되는 것 차단(외부리뷰 P2)."""
    return x.strip() if isinstance(x, str) else x


# ─────────────── evidence-docs (근거 문서 첨부 스냅샷+매니페스트, 링크 B) ───────────────
# 성격(불변): '첨부 전송(attachment transport)'이지 '주장 실증(claim substantiation)'이 아니다.
#   linked_claim_ids 는 claim-basis 의 evidence_on_file[].id 와 '대조만' 하고(F5), 심의엔진이 실증으로
#   읽는 어떤 곳에도 기록하지 않는다(kcia_engine 은 claim-basis/results 만 읽음). 전부 결정적·fail-closed.
_EVIDENCE_EXTS = frozenset(["pdf", "hwp", "hwpx", "doc", "docx", "xls", "xlsx",
                            "png", "jpg", "jpeg", "webp"])   # 화이트리스트(추후 화이트리스트만 확장)
_EVIDENCE_SIDECAR = "index.json"                 # 예약 사이드카(문서목록 제외, 메타로만). 유일 허용 .json.
_EVIDENCE_CHANNELS = frozenset(["HARNESS_EVIDENCE_DIR", "bundle"])
_EVIDENCE_DEFAULT_MAX_FILE = 20 * 1024 * 1024    # 파일당 20MB(F6, env override)
_EVIDENCE_DEFAULT_MAX_TOTAL = 50 * 1024 * 1024   # 총량 50MB(F6, env override)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)       # FIFO open 이 writer 대기로 블록되지 않게(정규파일엔 무영향)


def _evidence_env_int(name, default):
    """양의 정수 env override. 미설정/빈값/비정상 → 안전 기본값(fail-safe, 무음 폴백)."""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        v = int(str(raw).strip())
    except (ValueError, TypeError):
        return default
    return v if v > 0 else default


def _evidence_safe_name(name):
    """파일명 안전토큰 + NFC 정규화. 위반(경로구분자/'..'/traversal/NUL)이면 None → 호출부 fail-closed.
    원본과 NFC 정규화본 둘 다 검사(정규화가 구분자/traversal 을 도입하는 경우 차단)."""
    def _bad(s):
        return (not s or s in (".", "..") or ".." in s or "/" in s or "\\" in s
                or "\x00" in s or os.sep in s or (os.altsep and os.altsep in s))
    if _bad(name):
        return None
    nfc = unicodedata.normalize("NFC", name)
    if _bad(nfc) or os.path.basename(nfc) != nfc:
        return None
    return nfc


def _read_fd_bounded(fd, size):
    """이미 연 fd 에서 최대 size+1 바이트만 읽는다(reopen-by-path 창 없음). size+1 상한은 경쟁 append/치환으로
    파일이 fstat 크기보다 커졌는지 감지하기 위함(반환 길이 != size 면 호출부가 fail-closed). 상한 자체가
    size(<= 파일당 cap)+1 이라 bounded — cap 초과 바이트를 절대 읽지 않는다."""
    limit = size + 1
    chunks = []
    got = 0
    while got < limit:
        chunk = os.read(fd, min(1 << 20, limit - got))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


# ─────────────── G-B 시험 이미지 추출(참고문서 → 자사 자산) ───────────────
# 사람이 test_report.test_items[].image_ref.pages 로 '초반에 명시 선언'한 시험 이미지를 실제로 뽑는다.
#   PDF → pdftoppm 로 해당 페이지 렌더 · 래스터 문서(png/jpg/webp) → 원본 자체 복사 · 그 외 → fail-closed.
#   저장 위치 = runs/<rid>/inputs/assets/evidence/(inputs/assets 하위라 img_lint 화이트리스트 containment 로 자동 허용).
#   범용성: 제품/도메인/페이지 하드코딩 없음 — 전부 사이드카 선언 구동.
_EVIDENCE_IMAGE_EXTS = frozenset(["png", "jpg", "jpeg", "webp"])   # 페이지 개념 없는 래스터 근거(원본 복사)
_SAFE_PATH_TOKEN = re.compile(r"^[A-Za-z0-9._-]+$")               # 경로 토큰(구분자·.. 불가)


def _safe_path_token(value, what):
    """run_id·doc-id 등 경로 토큰이 안전한지(경로탈출 차단). 위반 시 SystemExit(fail-closed)."""
    s = str(value)
    if not _SAFE_PATH_TOKEN.match(s) or s in (".", ".."):
        raise SystemExit("[evidence-docs] 안전하지 않은 %s: %r (영숫자·._- 만 허용)" % (what, value))
    return s


def _assert_under_root(path, root, what):
    """path realpath 가 root 아래인지 강제(심볼릭·.. 탈출 최후방어). 위반 시 SystemExit."""
    rp = os.path.realpath(path)
    rr = os.path.realpath(root)
    if rp != rr and not rp.startswith(rr + os.sep):
        raise SystemExit("[evidence-docs] %s 가 허용 루트 밖입니다: %r" % (what, path))
    return rp


def _extract_test_images(docs, dest_dir, evidence_assets_dir, rdir):
    """reflect:true·kind=test_report 문서의 test_report.test_items[].image_ref.pages 를 실제 이미지로 추출.
    반환 {(doc_id, item_index): [런상대경로,...]}. 선언했는데 못 뽑으면(poppler 부재/렌더 실패/범위 밖) SystemExit
    (무음 누락 금지). 재-인입 결정성: evidence 자산 디렉터리를 매번 초기화 후 재추출(stale 사본 잔존 차단)."""
    def _needs(d):
        if not (isinstance(d, dict) and d.get("reflect", True) and d.get("kind") == "test_report"):
            return False
        items = (d.get("test_report") or {}).get("test_items") or []
        return any(isinstance(it, dict) and isinstance(it.get("image_ref"), dict) for it in items)

    targets = [d for d in docs if _needs(d)]

    # poppler 부재 fail-closed 는 '파괴적 정리(rmtree)보다 먼저' — 도구 회귀가 이전 유효 추출물을 지우지 않게.
    pdftoppm = shutil.which("pdftoppm")
    needs_pdf = any(d.get("ext") == "pdf" for d in targets)
    if needs_pdf and not pdftoppm:
        raise SystemExit("[evidence-docs] 시험 이미지 추출을 선언했으나 poppler(pdftoppm)가 없습니다 "
                         "(설치: brew install poppler / apt-get install poppler-utils). "
                         "선언한 근거를 조용히 누락하지 않고 멈춥니다.")

    # stale 초기화: 근거 이미지 디렉터리 재설정(요구 없으면 제거만; 부재면 no-op → 골든 불변).
    # stale 초기화 + 원자성(외부리뷰 3R-3): no-targets 면 기존 자산 제거만(실패 위험 없음). has-targets 면 '임시 디렉터리'로
    #   추출한 뒤 전부 성공해야 기존 자산과 원자 교체 — 추출이 실패하면(범위밖 페이지·손상 래스터 등) real 디렉터리를 건드리지
    #   않아 이전 유효 추출물(다른 이미 승인된 시험성적서 이미지)이 보존된다. 실패 시 _outdir 는 다음 실행 _rm_dir 가 정리(멱등).
    def _rm_dir(p):
        if os.path.islink(p) or (os.path.exists(p) and not os.path.isdir(p)):
            os.remove(p)
        elif os.path.isdir(p):
            shutil.rmtree(p)
    # ★ 임시 추출 대상은 allowlist 자산트리(inputs/assets) '밖'(rdir 루트 아래 dotdir)에 둔다(외부리뷰 3R-4) — 추출 실패로
    #   temp 가 남아도 img_lint allowlist(inputs/assets/evidence) 밖이라 미승인 파일이 자산으로 새지 않는다. 매 호출 시작에
    #   정리하므로(no-target 경로 포함) 이전 실패 잔여도 남지 않는다.
    _outdir = os.path.join(rdir, ".evidence-extract.tmp")
    _rm_dir(_outdir)
    if not targets:
        _rm_dir(evidence_assets_dir)   # 요구 없음 → 기존 stale 제거만(부재면 no-op → 골든 불변)
        return {}

    assets_root = os.path.join(rdir, "inputs", "assets")
    os.makedirs(assets_root, exist_ok=True)
    _assert_under_root(evidence_assets_dir, assets_root, "근거 이미지 디렉터리")
    os.makedirs(_outdir)
    _assert_under_root(_outdir, rdir, "근거 이미지 임시 디렉터리")
    dpi = _evidence_env_int("HARNESS_EVIDENCE_DPI", 150)
    timeout_s = _evidence_env_int("HARNESS_EVIDENCE_IMAGE_TIMEOUT", 120)

    extracted = {}
    for d in targets:
        doc_id = _safe_path_token(d["id"], "doc id")   # doc-NN (안전 토큰)
        src_doc = os.path.join(dest_dir, d["nfc"])      # 스냅샷된 원본(런 로컬)
        ext = d.get("ext")
        for k, it in enumerate((d.get("test_report") or {}).get("test_items") or [], start=1):
            if not (isinstance(it, dict) and isinstance(it.get("image_ref"), dict)):
                continue
            pages = it["image_ref"].get("pages") or []
            # P2-4(외부리뷰): image_path 는 단일 슬롯이라 한 시험항목의 매칭 이미지는 '한 페이지(전후 합성 컷)'만 허용한다.
            #   다중 페이지를 조용히 첫 장만 쓰면 나머지가 하류에서 유실되므로 fail-closed(무음 데이터 손실 금지).
            #   여러 이미지가 필요하면 시험항목을 나눠 선언하라(각 항목=한 페이지).
            if len(pages) > 1:
                raise SystemExit("[evidence-docs] %s test_items[%d].image_ref.pages 는 한 페이지만 허용합니다(현재 %d개) — "
                                 "한 시험항목의 매칭 이미지는 전후 합성 한 페이지로 선언하고, 더 필요하면 시험항목을 나누세요."
                                 % (doc_id, k, len(pages)))
            rels = []
            if ext == "pdf":
                for pg in pages:
                    if not (isinstance(pg, int) and not isinstance(pg, bool) and pg >= 1):
                        raise SystemExit("[evidence-docs] %s test_items[%d].image_ref.pages 가 올바른 페이지 번호가 아닙니다: %r"
                                         % (doc_id, k, pg))
                    out_base = os.path.join(_outdir, "%s-p%d" % (doc_id, pg))
                    out_png = out_base + ".png"
                    _assert_under_root(out_png, _outdir, "추출 이미지")
                    try:
                        subprocess.run([pdftoppm, "-png", "-singlefile", "-r", str(dpi),
                                        "-f", str(pg), "-l", str(pg), src_doc, out_base],
                                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                       timeout=timeout_s)
                    except Exception as e:
                        raise SystemExit("[evidence-docs] %s %d쪽 이미지 추출 실패(pdftoppm): %s" % (doc_id, pg, e))
                    if not (os.path.isfile(out_png) and os.path.getsize(out_png) > 0):
                        raise SystemExit("[evidence-docs] %s %d쪽 추출 결과가 비어있습니다(선언 페이지가 문서 범위 밖일 수 있음): %s"
                                         % (doc_id, pg, out_png))
                    rels.append("inputs/assets/evidence/%s-p%d.png" % (doc_id, pg))
            elif ext in _EVIDENCE_IMAGE_EXTS:
                # 래스터 근거 문서 — 페이지 개념 없음(원본 이미지 자체가 시험 이미지). 1회 복사.
                out_img = os.path.join(_outdir, "%s.%s" % (doc_id, ext))
                _assert_under_root(out_img, _outdir, "추출 이미지")
                shutil.copyfile(src_doc, out_img)
                if not (os.path.isfile(out_img) and os.path.getsize(out_img) > 0):
                    raise SystemExit("[evidence-docs] %s 이미지 자산 복사 실패: %s" % (doc_id, out_img))
                # P2-6(외부리뷰): 확장자·크기만으론 손상/위장 파일이 깨진 <img> 로 유출된다(img_lint 는 경로만 봄) —
                #   매직바이트로 실제 이미지인지 확인(fail-closed). 페이지 추출(pdftoppm)은 png 를 직접 생성하므로 이 검증은 원본 복사 경로에만 필요.
                with open(out_img, "rb") as _f:
                    _magic = _f.read(16)
                _ext = ext.lower()
                _ok = ((_ext == "png" and _magic.startswith(b"\x89PNG\r\n\x1a\n"))
                       or (_ext in ("jpg", "jpeg") and _magic.startswith(b"\xff\xd8\xff"))
                       or (_ext == "webp" and _magic[:4] == b"RIFF" and _magic[8:12] == b"WEBP"))
                if not _ok:
                    raise SystemExit("[evidence-docs] %s 근거 이미지가 유효한 %s 파일이 아닙니다(손상/위장 의심) — 실제 이미지로 첨부하세요: %s"
                                     % (doc_id, _ext, out_img))
                rels.append("inputs/assets/evidence/%s.%s" % (doc_id, ext))
            else:
                raise SystemExit("[evidence-docs] %s(.%s)에 image_ref 가 선언됐으나 PDF/이미지가 아니라 페이지 추출 불가 — "
                                 "PDF 또는 이미지(png/jpg/webp)로 첨부하세요." % (doc_id, ext))
            if rels:
                extracted[(doc_id, k)] = rels
    # 전부 성공(위 루프에서 raise 없이 완주) → real 디렉터리와 원자 교체. 도중 실패면 여기 도달 못해 real 이 보존된다(외부리뷰 3R-3).
    _rm_dir(evidence_assets_dir)
    os.rename(_outdir, evidence_assets_dir)
    # sha256 감사 로그(스왑 후 최종 경로에서 — 동결 스키마에 저장 슬롯 없음, 로그로만 노출).
    for (doc_id, _k), rels in extracted.items():
        for rp in rels:
            try:
                with open(os.path.join(rdir, rp), "rb") as f:
                    h = hashlib.sha256(f.read()).hexdigest()
                print("[evidence-docs] 시험이미지 추출: %s (%s, sha256=%s)" % (rp, doc_id, h))
            except OSError:
                pass
    return extracted


def _register_evidence_assets(rdir, extracted):
    """추출 근거 이미지가 assets-manifest own_assets.files 에 **남지 않도록 보장**(멱등 정리). P2-2(외부리뷰):
    own_assets 에 넣으면 스토리보드/키비주얼 폴백 자산 로테이션이 임상 전후사진을 무관 섹션에 재사용해 오염시킨다.
    근거 이미지는 경로(inputs/assets/evidence/)로 img_lint 화이트리스트가 허용하고 결박은 claim-basis image_path 가
    담당하므로 own_assets 등록이 불필요·유해하다. `extracted` 인자는 하위호환 시그니처 보존용(미사용)."""
    del extracted   # 미사용(시그니처 보존) — 정리는 경로 prefix 로 한다
    am_path = os.path.join(rdir, "00-ingest", "assets-manifest.json")
    if not os.path.exists(am_path):
        return
    try:
        am = load_json(am_path)
    except Exception:
        return
    oa = am.get("own_assets")
    if not isinstance(oa, dict):
        return
    # P2-2(외부리뷰): 추출 근거 이미지를 own_assets.files 에 **넣지 않는다** — 넣으면 스토리보드/키비주얼 폴백 자산
    #   로테이션이 임상 전후사진을 무관 섹션에 재사용해 오염시킨다. 근거 이미지는 경로(inputs/assets/evidence/)로
    #   img_lint 화이트리스트가 이미 허용하고, 결박은 claim-basis evidence_on_file[].image_path 가 담당하므로
    #   own_assets 등록이 불필요·유해하다. 여기선 '혹시 등록돼 있으면 걷어내기'만 한다(멱등 정리; 변화 없으면 무기록 → 골든 불변).
    files = [f for f in (oa.get("files") or [])
             if isinstance(f, dict) and not str(f.get("path", "")).startswith("inputs/assets/evidence/")]
    new_oa = dict(oa)
    new_oa["files"] = files
    new_oa["count"] = len(files)
    new_am = dict(am)
    new_am["own_assets"] = new_oa
    if new_am == am:
        return   # 근거 이미지가 애초에 own_assets 에 없음(정상) → 무변경(골든 바이트 불변)
    harness_root = os.environ.get("HARNESS_ROOT") or _ROOT
    am_schema = load_json(os.path.join(harness_root, "harness", "assets-manifest.schema.json"))
    v = Validator(am_schema)
    v.validate(new_am, am_schema)
    if v.errors:
        raise SystemExit("[evidence-docs] assets-manifest 정리 후 스키마 위반: %s" % "; ".join(v.errors))
    atomic_write_json(am_path, new_am)
    print("[evidence-docs] 근거 이미지를 own_assets 로테이션에서 제외(정리)")


def _round_half_away(x):
    """관행 반올림(round half away from zero) — 보고서 표기 관행(-40.5→-41, 40.5→41)에 맞춘 정수 반올림.
    파이썬 내장 round()의 banker's rounding(-40.5→-40)이 .5 타이에서 관행과 어긋나는 것을 피한다(외부리뷰 5R)."""
    import math
    return math.floor(x + 0.5) if x >= 0 else math.ceil(x - 0.5)


def _normalize_change_pct(tr, doc_label):
    """P-2: 시험성적서(test_report) 선언 change_pct 정규화 — 보고서 관행상 정수(예 -41)로 적힌 변화율을,
    series/before-after 로 결정적으로 도출한 소수1자리(clinical_chart.ROUND_PREC=1 단일 출처)와 대조해 조정한다.
    tr(test_report 형상 dict)의 measured_values(dict)와 test_items[](각 항목)를 제자리 정규화하고 tr 을 반환한다.
    각 레코드(mv 또는 항목)에 대해:
      · 도출 불가(포인트<2·before/after 미비·첫값 0·series↔before/after 불일치) → 손대지 않음.
      · 선언 change_pct 가 도출값과 정확 일치(<=1e-9) → 선언 원문 그대로 둔다(골든 바이트 불변 — -41 을 -41.0 으로
        다시 쓰지 않는다). 이 통과-경로가 기존 exact-equal 픽스처 바이트 동일성을 보장한다.
      · 선언 정수 반올림이 도출값과 일치(|선언 − round(도출,0)| < 0.5) → 도출값(소수1)으로 덮어쓰고 stdout 한 줄.
      · 그 밖(진짜 모순) → fail-closed(도출값을 에러 메시지에 제시 — 사람이 선언을 고친다).
      · 선언 없고 도출 가능 → 도출값 자동 기입(편의).
    ⚠ tr 을 제자리 변형하면 매니페스트(11)와 claim-basis 승격(12)이 같은 객체를 읽으므로 split-brain 이 없다.
       S6/W-3(apply-proposal)가 이 헬퍼를 그대로 재사용한다 — 그래서 test_report 형상 dict + 라벨만 받는 독립 함수다."""
    if not isinstance(tr, dict):
        return tr

    # _num: harness.is_number 를 모듈-레벨 import (_num 별칭, K-1 일원화)
    def _normalize_record(rec, label):
        if not isinstance(rec, dict):
            return
        # change_pct 를 뺀 도출-형상 레코드 구성. series {label,value} → {timepoint,value}(승격 코드와 동일 매핑,
        #   clinical_chart.derive_chart 계약). ⚠ 선언 change_pct 는 반드시 뺀다 — 넣으면 derive_chart 교차검증이
        #   소수 차이(정수 선언 vs 소수1 도출)로 null 을 돌려주기 때문(이게 P-2 가 처방하는 바로 그 충돌).
        derive_rec = {}
        ser = rec.get("series")
        if isinstance(ser, list):
            mapped = [{"timepoint": str(s["label"]), "value": s["value"]}
                      for s in ser
                      if isinstance(s, dict) and s.get("label") is not None and _num(s.get("value"))]
            if mapped:
                derive_rec["series"] = mapped
        if _num(rec.get("before")):
            derive_rec["before"] = rec["before"]
        if _num(rec.get("after")):
            derive_rec["after"] = rec["after"]
        # 도출 가능 조건: series ≥2 포인트 또는 before·after 둘 다 숫자(그 밖은 차트화 불가 → 손대지 않음).
        derivable = (len(derive_rec.get("series") or []) >= 2) or \
                    (_num(derive_rec.get("before")) and _num(derive_rec.get("after")))
        if not derivable:
            return
        derived = clinical_chart.derive_chart(derive_rec)
        if not derived:
            return   # 첫값 0·series↔before/after 불일치 등 → 손대지 않음(하류 검증이 잡는다)
        computed = derived["signed_change_pct"]
        declared = rec.get("change_pct")
        if declared is None:
            rec["change_pct"] = computed   # 선언 없음 → 도출값 자동 기입(편의)
            return
        if not _num(declared):
            return
        declared_f = float(declared)
        if abs(declared_f - computed) <= 1e-9:
            return   # 정확 일치 → 선언 원문 그대로(골든 바이트 불변 — 핵심)
        # 근사 일치 → 도출값(소수1)으로 '정규화'한다. ★ 원문 보존이 아니라 정규화여야 하는 이유(외부리뷰 10R): build_context 가
        #   EVIDENCE_DOCS 로 이 값을 생성기에 주입하는데, validator(clinical_chart.numbers_consistent)는 도출값
        #   (signed_change_pct=소수1)으로 검증한다. 원문(-59.86)을 주입하고 -59.9 로 검증하면 스토리보드/차트가 self-inconsistent
        #   → 검증 실패. 그래서 주입·검증 둘 다 도출값(-59.9)으로 맞춘다. 인정하는 근사 2유형:
        #   ① 소수1자리 반올림 일치(정밀 2소수 표기, 예 -59.86→-59.9 · derive_chart 교차검증 허용오차와 동일).
        #   ② 정수(보고서 관행) 표기가 '관행 반올림'(half-away-from-zero)과 일치(예 -41→-40.9).
        #      ⚠ 파이썬 round()는 banker's(-40.5→-40)라 .5 타이에서 관행(-40.5→-41)을 거부하므로 _round_half_away 를 쓴다(외부리뷰 5R).
        #   ⚠ 그 밖(예 -40.6 vs -40.9)은 진짜 모순 → fail-closed(정밀 선언의 실제 오차를 숨기지 않음).
        if round(declared_f, clinical_chart.ROUND_PREC) == computed \
                or (declared_f == round(declared_f) and declared_f == _round_half_away(computed)):
            rec["change_pct"] = computed
            print("[ingest] %s: 선언 change_pct %s → 도출 %s 로 정규화(하류 주입·검증 일관성)"
                  % (label, declared, computed))
            return
        raise SystemExit("[ingest] %s: 선언 change_pct %s 가 도출값 %s 와 모순됩니다(정수 반올림 허용범위 밖) — "
                         "선언을 %s 로 고치거나 series/before-after 를 확인하세요." % (label, declared, computed, computed))

    mv = tr.get("measured_values")
    if isinstance(mv, dict):
        _normalize_record(mv, "%s measured_values" % doc_label)
    items = tr.get("test_items")
    if isinstance(items, list):
        for k, it in enumerate(items, start=1):
            _normalize_record(it, "%s 시험항목 %d" % (doc_label, k))
    return tr


def cmd_evidence_docs(args):
    """근거 문서 스냅샷(정확복제) + 매니페스트(마지막 원자적 기록). 첨부 전송(≠실증).
    사용법: evidence-docs <run_id> --src <evidence_src_dir> --channel <HARNESS_EVIDENCE_DIR|bundle>
    유효 문서 0건이면 inputs/evidence/ 와 매니페스트를 '제거'(생성 안 함) → 골든 불변."""
    if not args:
        raise SystemExit("[evidence-docs] 사용법: evidence-docs <run_id> --src <dir> --channel <HARNESS_EVIDENCE_DIR|bundle>")
    run_id = args[0]
    src = args[args.index("--src") + 1] if "--src" in args else None
    channel = args[args.index("--channel") + 1] if "--channel" in args else None
    if channel not in _EVIDENCE_CHANNELS:
        raise SystemExit("[evidence-docs] 잘못된 채널: %r (허용: HARNESS_EVIDENCE_DIR|bundle)" % (channel,))

    # run 경로: common.sh 가 export 하는 HARNESS_ROOT 를 따른다(셸 run_dir 과 동일; 미설정 시 모듈 _ROOT).
    harness_root = os.environ.get("HARNESS_ROOT") or _ROOT
    rdir = os.path.join(harness_root, "runs", run_id)
    dest_dir = os.path.join(rdir, "inputs", "evidence")
    manifest_path = os.path.join(rdir, "00-ingest", "evidence-documents.json")
    claim_basis_path = os.path.join(rdir, "00-ingest", "claim-basis.json")

    # G5 재-인입 무결성(외부리뷰 P1): (재)인입 시 이전 00e 반영 제안(reflection-proposal.json)을 항상 무효화한다.
    #   같은 파일명이라도 내용(sha256)이 바뀌면 옛 제안의 reflection_points 가 현재 문서 원문과 어긋나(stale) 비-verbatim
    #   발췌가 규제 산출물로 새어들 수 있다 → 스냅샷/매니페스트 재기록 전에 제안을 지워 run-stage evidence 재생성을 강제한다.
    #   (정상 최초 인입엔 제안이 아직 없어 no-op; no-evidence 골든 바이트 불변 — 존재 시에만 제거.)
    _stale_proposal = os.path.join(rdir, "00e-evidence", "reflection-proposal.json")
    if os.path.exists(_stale_proposal):
        os.remove(_stale_proposal)

    def _cleanup_no_evidence():
        # exact-replacement 의 0건 경로: stale 스냅샷/매니페스트 제거(부재면 no-op → 골든 불변).
        if os.path.islink(dest_dir):
            os.remove(dest_dir)
        elif os.path.isdir(dest_dir):
            shutil.rmtree(dest_dir)
        elif os.path.exists(dest_dir):
            os.remove(dest_dir)
        if os.path.exists(manifest_path):
            os.remove(manifest_path)
        # 반영 승격 잔재(doc-*) 정리: 이전 인입이 승격했던 doc-* 를 claim-basis 에서 벗긴다(있을 때만 재기록).
        #   doc-* 가 없으면 claim-basis 를 아예 다시 쓰지 않는다 → no-evidence 골든 바이트 불변(DoD ①).
        if os.path.exists(claim_basis_path):
            try:
                cb_obj = load_json(claim_basis_path)
            except Exception:
                cb_obj = None
            if isinstance(cb_obj, dict):
                existing = cb_obj.get("evidence_on_file") or []
                base = [e for e in existing
                        if not (isinstance(e, dict) and str(e.get("id", "")).startswith("doc-"))]
                if base != existing:
                    new_cb = dict(cb_obj)
                    new_cb["evidence_on_file"] = base
                    atomic_write_json(claim_basis_path, new_cb)
        # G-B: 추출 근거 이미지 자산 정리(재-인입 결정성) + assets-manifest own_assets 에서 evidence 엔트리 제거.
        #   부재/없음이면 no-op(디렉터리 미존재·evidence 엔트리 없음 → 재기록 안 함) → no-evidence 골든 바이트 불변.
        _ev_assets = os.path.join(rdir, "inputs", "assets", "evidence")
        if os.path.islink(_ev_assets):
            os.remove(_ev_assets)
        elif os.path.isdir(_ev_assets):
            shutil.rmtree(_ev_assets)
        _register_evidence_assets(rdir, {})
        print("[evidence-docs] 근거 문서 없음 — 정리 완료(EVIDENCE_DOCS=0)")

    # 1a) 소스 루트가 '바로가기(심볼릭 링크)'면 거부 — 번들 채널 한정(외부 신뢰경계).
    #   isdir/listdir 은 링크를 따라가므로, 번들이 evidence 를 링크로 심으면 번들 '밖' 파일이 런으로 끌려온다
    #   (O_NOFOLLOW 는 최종 문서 파일만 보호하고 디렉터리 루트는 보호 못 함). 그래서 목록화 '전에' 루트를 막는다.
    #   반면 사람이 직접 지정한 HARNESS_EVIDENCE_DIR 채널은 링크된 폴더도 사람 의도로 허용한다(그 안의 파일은
    #   여전히 O_NOFOLLOW 로 안전하게 읽힘). 부재 경로는 islink=False 라 골든 '근거 없음' 경로에 영향 없음.
    if channel == "bundle" and src and os.path.islink(src):
        raise SystemExit("[evidence-docs] 번들의 근거 폴더가 바로가기(링크)로 연결돼 있어 받아들일 수 없습니다"
                         "(번들 안에 실제 폴더로 넣어 주세요): %s" % (src,))
    # 1b) 소스 부재/비-디렉터리 → 채널로 분기.
    #   EXPLICIT(HARNESS_EVIDENCE_DIR): 사람이 근거 위치를 명시했는데 경로가 없거나 폴더가 아니면 '근거 없음'
    #     정리로 흘리면 선언한 근거가 조용히 소실 + 유효 이전 스냅샷을 잘못 prune → fail-closed(정리 금지).
    #     정리(rmtree/manifest 제거)보다 '앞'이라 기존 유효 스냅샷·매니페스트는 손대지 않는다. (ingest-bundle.sh
    #     가 먼저 막지만, 직접 호출 경로에서도 '명시+무효=정리 금지'가 성립하도록 여기서도 fail-closed.)
    #   bundle(AUTO): <번들>/evidence 는 대개 부재가 정상(근거 미동봉) → 정리(no-op/prune, 골든 불변).
    if not src or not os.path.isdir(src):
        if channel == "HARNESS_EVIDENCE_DIR":
            raise SystemExit("[evidence-docs] 근거 자료 폴더로 지정한 경로가 없거나 폴더가 아닙니다"
                             "(빈 근거로 넘어가지 않고 멈춥니다 — 선언 조용한 소실 차단): %s" % (src,))
        _cleanup_no_evidence()
        return

    max_file = _evidence_env_int("HARNESS_EVIDENCE_MAX_FILE_BYTES", _EVIDENCE_DEFAULT_MAX_FILE)
    max_total = _evidence_env_int("HARNESS_EVIDENCE_MAX_TOTAL_BYTES", _EVIDENCE_DEFAULT_MAX_TOTAL)

    # 3) 최상위 엔트리만 단층 순회(결정적 정렬). 위반은 조용한 무시 없이 전부 fail-closed.
    docs = []
    seen_nfc = {}
    total = 0
    for name in sorted(os.listdir(src)):
        if name == _EVIDENCE_SIDECAR:            # 예약 사이드카 — 문서 아님(뒤에서 메타로만 반영)
            continue
        # OS 잡파일(.DS_Store·AppleDouble ._*·Thumbs.db·desktop.ini)은 제출 근거가 아니다 → 건너뛴다.
        #   ingest-bundle.sh 가 번들/자산/사례 스냅샷에서 .DS_Store 를 지우는 것과 동일 취지(macOS 폴더엔 흔함).
        #   건너뛰지 않으면 확장자 화이트리스트가 이들을 거부해 유효 PDF/이미지가 있어도 인입이 멈춘다.
        if name in (".DS_Store", "Thumbs.db", "desktop.ini") or name.startswith("._"):
            continue
        # 열기 전(값싼) 이름/확장자/충돌 게이트 — 거부될 파일을 굳이 열지 않는다(정규성·크기는 열린 fd 로 확정).
        nfc = _evidence_safe_name(name)
        if nfc is None:
            raise SystemExit("[evidence-docs] 안전하지 않은 파일명(경로구분자/'..'/정규화 위반): %r" % (name,))
        ext = os.path.splitext(nfc)[1].lower().lstrip(".")
        if ext not in _EVIDENCE_EXTS:
            raise SystemExit("[evidence-docs] 허용되지 않은 확장자 '.%s'(화이트리스트 밖): %s" % (ext, nfc))
        # 5) NFC 충돌(서로 다른 원본이 같은 NFC 로) 거부 — 제출물 파일명 모호성 차단.
        if nfc in seen_nfc:
            raise SystemExit("[evidence-docs] NFC 정규화 후 파일명 충돌: %r / %r → %r" % (seen_nfc[nfc], name, nfc))
        seen_nfc[nfc] = name
        full = os.path.join(src, name)
        # TOCTOU-안전 단일 fd 읽기(외부 파일이 run 으로 들어오는 신뢰 경계 — export F3 의 인입쪽 대응):
        #   O_NOFOLLOW → 최종 컴포넌트가 심볼릭이면 open 자체가 ELOOP 실패(경로 재열기 창 없음).
        #   fstat(연 fd) → 정규성·크기를 '실제로 읽는 그 inode' 기준으로 확정(check≠read 스왑 차단).
        #   bounded read(fstat 크기+1) → 경쟁 append/치환으로 커졌으면 감지·fail-closed. sha256·복사바이트·
        #   기록 bytes 가 전부 이 fd 한 곳에서 파생(경로 재열기 없음).
        try:
            fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | _O_NONBLOCK)
        except OSError as e:
            if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                raise SystemExit("[evidence-docs] 심볼릭 링크는 첨부 근거로 허용되지 않습니다: %s" % name)
            raise SystemExit("[evidence-docs] 근거 파일을 열 수 없습니다(%s): %s" % (e.strerror or e.errno, name))
        try:
            fst = os.fstat(fd)
            if not stat.S_ISREG(fst.st_mode):
                raise SystemExit("[evidence-docs] 정규 파일만 허용됩니다(디렉터리/특수파일 거부): %s" % name)
            size = fst.st_size
            if size == 0:
                raise SystemExit("[evidence-docs] 0바이트(빈/손상) 근거는 허용되지 않습니다: %s" % nfc)
            if size > max_file:
                raise SystemExit("[evidence-docs] 파일당 상한 초과: %s (%d > %d bytes)" % (nfc, size, max_file))
            data = _read_fd_bounded(fd, size)
        finally:
            os.close(fd)
        if len(data) != size:
            raise SystemExit("[evidence-docs] 읽는 중 파일 크기 변동 감지(경쟁 수정): %s" % nfc)
        total += size
        if total > max_total:
            raise SystemExit("[evidence-docs] 총량 상한 초과: 누적 %d > %d bytes" % (total, max_total))
        docs.append({"nfc": nfc, "ext": ext, "bytes": size,
                     "sha256": hashlib.sha256(data).hexdigest(),
                     "grade": None, "linked_claim_ids": [],
                     # 반영 선언(신설). reflect 기본 True = 반영 의무 → 사이드카 미선언 문서는
                     #   아래 완전성 게이트가 fail-closed(첨부-전용이면 reflect:false 명시 필요).
                     "reflect": True, "claim": None, "verdict_text": None, "test_report": None,
                     # 일반화(G2): kind(추론/선언)·reflection_points(일반 문서 반영 원문)·spec_origin(감사).
                     "kind": None, "reflection_points": [], "spec_origin": "human",
                     "_data": data})

    # 사이드카 index.json 파싱+스키마검증 — 문서 유무 판정(BUG1)·decl 사용(BUG2)보다 반드시 '먼저'.
    #   스키마(evidence-index.schema.json, additionalProperties:false)로 값 구조를 강제 → 오타 키(linked_claim_id 등)·
    #   미지 필드가 조용히 드롭되지 않게 fail-closed(BUG2). N4 의 파일명 키 1:1 매칭과 상보(스키마=값 구조, N4=키 매칭 — 둘 다 유지).
    sidecar_path = os.path.join(src, _EVIDENCE_SIDECAR)
    sidecar = None
    # lexists(exists 아님): 대상 없는 dangling 심볼릭도 감지해야 아래 islink 가드가 fail-closed 로 잡는다.
    #   exists 면 dangling 링크가 False→블록 skip→사이드카 부재로 오판(선언 조용한 소실).
    if os.path.lexists(sidecar_path):
        if os.path.islink(sidecar_path) or not os.path.isfile(sidecar_path):
            raise SystemExit("[evidence-docs] index.json 은 정규 파일이어야 합니다(심볼릭/특수 파일 불가).")
        try:
            sidecar = load_json(sidecar_path)
        except Exception as e:
            raise SystemExit("[evidence-docs] index.json 파싱 실패: %s" % e)
        if not isinstance(sidecar, dict):
            raise SystemExit("[evidence-docs] index.json 은 객체(파일명→선언)여야 합니다.")
        schema_path = os.path.join(harness_root, "harness", "evidence-index.schema.json")
        try:
            schema = load_json(schema_path)
        except Exception as e:
            raise SystemExit("[evidence-docs] evidence-index.schema.json 로드 실패: %s" % e)
        vld = Validator(schema)
        vld.validate(sidecar, schema)
        if vld.errors:
            raise SystemExit("[evidence-docs] index.json 스키마 위반(오타/미지 필드 조용한 드롭 차단): %s"
                             % "; ".join(vld.errors))

    # 후보 0건 분기: 사이드카가 '없거나 빈 {}'이면 no-evidence 정리(prune, 골든 불변). 하지만 사이드카에 '선언이
    #   있는데'(>=1 키) 매칭 문서가 0건이면 = 사람이 선언한 근거가 조용히 소실 + 유효 이전 스냅샷을 잘못 prune →
    #   fail-closed(BUG1/N4). 이 fail 은 아래 스냅샷(rmtree/copy)보다 '앞'이라 이전 유효 스냅샷·매니페스트는 손대지 않는다.
    if not docs:
        if sidecar:   # 비어있지 않은 dict 만 truthy — 빈 {} 는 정당한 no-evidence(정리)로 통과.
            raise SystemExit("[evidence-docs] index.json 에 선언된 근거 파일이 소스에 없습니다"
                             "(선언 소실·prune 금지, 재-인입 필요): %s" % ", ".join(sorted(sidecar.keys())))
        _cleanup_no_evidence()
        return

    # 7) 결정적 정렬(NFC 파일명 바이트순) → doc-NN 부여(2자리 zero-pad, 100+ 는 자연히 3자리).
    docs.sort(key=lambda d: d["nfc"].encode("utf-8"))
    for i, d in enumerate(docs, start=1):
        d["id"] = "doc-%02d" % i
    by_nfc = {d["nfc"]: d for d in docs}

    # 8) 사이드카 양방향 참조 무결성(N4): 모든 키가 복사 대상 문서와 정확히 1:1(값 구조는 위 스키마가 이미 보증).
    if sidecar is not None:
        seen_key = {}
        for key, decl in sidecar.items():
            key_nfc = unicodedata.normalize("NFC", key)
            if key_nfc in seen_key:
                raise SystemExit("[evidence-docs] index.json 키 충돌(NFC): %r / %r" % (seen_key[key_nfc], key))
            seen_key[key_nfc] = key
            if key_nfc not in by_nfc:
                raise SystemExit("[evidence-docs] index.json 키가 복사 대상 문서에 없습니다(선언 소실 차단): %r" % (key,))
            d = by_nfc[key_nfc]
            d["grade"] = _clean_decl_str(decl.get("grade", None))
            d["linked_claim_ids"] = list(decl.get("linked_claim_ids", []))
            # 반영 선언(신설): reflect 기본 True(미선언=반영 의무). claim/verdict_text/test_report 는
            #   선언 시에만 덮어씀(미선언은 None 유지 → 완전성 게이트가 잡음). 텍스트는 앞뒤 공백 제거
            #   (공백-only 선언이 truthy 로 게이트를 통과해 빈 내용이 승격되는 것 차단 — 외부리뷰 P2).
            d["reflect"] = bool(decl.get("reflect", True))
            if "claim" in decl:
                d["claim"] = _clean_decl_str(decl["claim"])
            if "verdict_text" in decl:
                d["verdict_text"] = _clean_decl_str(decl["verdict_text"])
            if "test_report" in decl:
                tr = decl["test_report"]
                if isinstance(tr, dict):
                    tr = dict(tr)
                    for _k in ("institution", "duration", "method"):
                        if isinstance(tr.get(_k), str):
                            tr[_k] = tr[_k].strip()
                d["test_report"] = tr
            # 일반화(G2): kind·reflection_points·spec_origin.
            if "kind" in decl:
                d["kind"] = decl["kind"]
            if "reflection_points" in decl:
                d["reflection_points"] = [p for p in (_clean_decl_str(x) for x in decl["reflection_points"]) if p]
            if "spec_origin" in decl:
                d["spec_origin"] = decl["spec_origin"]

    # 8b) 반영 완전성 게이트(신설 — 첨부=반영 강제, 계획 3·4단계). 로컬 검증기가 '조건부 required' 를
    #   지원하지 않으므로 스키마가 아니라 여기서 코드로 fail-closed 한다. reflect:true(미선언 기본 포함)인데
    #   claim/verdict_text/grade/test_report(기관·n·기간) 결손이면 인입 중단(첨부만 되고 내용 반영 못 하는 상태
    #   자체를 차단). 첨부-전용이면 사이드카에 reflect:false 를 명시.
    for d in docs:
        if not d.get("reflect", True):
            continue
        # declared_kind = 사람이 사이드카에 '명시'한 kind(없으면 None). W-3: 명시 test_report intent 판별 기준.
        declared_kind = d.get("kind")
        # kind 추론(미선언 시): test_report 객체 있으면 test_report, 없으면 general(일반 참조 문서).
        kind = declared_kind or ("test_report" if d.get("test_report") is not None else "general")
        d["kind"] = kind
        missing = []
        if kind == "test_report":
            # 시험성적서: 판정문 원문 + 시험성적서 5요소 재료(현행 — claim-basis 실증 승격 대상).
            tr = d.get("test_report") or {}
            if not d.get("claim"):
                missing.append("claim")
            if not d.get("verdict_text"):
                missing.append("verdict_text")
            if not d.get("grade"):
                missing.append("grade")
            if not tr.get("institution"):
                missing.append("test_report.institution")
            if not tr.get("sample_size"):
                missing.append("test_report.sample_size")
            if not tr.get("duration"):
                missing.append("test_report.duration")
            if missing:
                # W-3(00e 스펙 2차 관문): 사람이 kind:test_report 를 '명시 선언'(intent-only, 상세 생략)한 경우엔
                #   hard-fail 대신 spec_status="pending" 으로 기록 → 00e-evidence 에서 세션 에이전트가 PDF 에서
                #   스펙 초안(기관·n·기간·판정문·test_items)을 제안 → 사람 승인(apply-proposal)으로 해소한다.
                #   ⚠ 안전 불변식: '명시 선언'이 없는데 test_report 객체만 불완전(추론 kind)이면 기존대로 hard-fail —
                #   효능 실증 재료를 에이전트가 지어내 우회하는 것을 차단(규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람).
                if declared_kind == "test_report":
                    d["spec_status"] = "pending"
                else:
                    raise SystemExit("[evidence-docs] 시험성적서(reflect:true, kind=test_report) 선언이 불완전합니다 — "
                                     "claim/verdict_text/grade/test_report(기관·n·기간)를 채우거나, "
                                     "상세를 00e 에서 제안·승인받으려면 사이드카에 kind:test_report 를 명시(intent)하거나, "
                                     "reflect:false 로 첨부-전용을 명시하세요: %s (결손: %s)"
                                     % (d["nfc"], ", ".join(missing)))
        else:
            # 일반 참조 문서: claim + reflection_points(반영할 원문 포인트) 1개 이상 필요(사람 지정/승인).
            #   결손(문서만 첨부·반영점 미정)이면 hard-fail 대신 spec_status="pending" 으로 기록(G5) →
            #   00e-evidence 에서 in-session 에이전트가 추출·제안 → 사람 승인으로 결손을 해소한다.
            #   pending 동안: 승격(kind=test_report 한정이라 일반문서는 애초 무관)·REFERENCE_DOCS 라벨(common.sh)·
            #   반영 의무는 보류되고, advance 초크 게이트(advance-phase)와 done 백스톱(check_evidence_reflection)이
            #   00e 외 전이·완료를 막는다(3중). ⚠ test_report(위 분기)는 pending 경로가 없다 — 효능 실증 재료를
            #   에이전트가 지어내면 안 되므로 결손이면 그대로 hard-fail(안전 불변식 §9-2·환각 안전).
            if not d.get("claim"):
                missing.append("claim")
            if not (d.get("reflection_points") or []):
                missing.append("reflection_points(반영할 원문 포인트 1개 이상)")
            if missing:
                d["spec_status"] = "pending"

    # 8c) P-2: 선언 change_pct 정규화(보고서 정수 표기 허용). test_report 로 소비되는 doc(reflect:true·
    #   kind=test_report)의 test_report 객체를 여기서 한 번 정규화하면, 아래 매니페스트(11)와 승격(12)이
    #   같은 d["test_report"] 객체를 읽으므로 매니페스트·claim-basis 가 split-brain 없이 정규화값을 상속한다.
    for d in docs:
        if d.get("reflect", True) and d.get("kind") == "test_report" and isinstance(d.get("test_report"), dict):
            _normalize_change_pct(d["test_report"], d["id"])

    # 9) linked_claim_ids ↔ claim-basis.json evidence_on_file[].id 대조(F5). 대조만; 실증셋 미편입.
    declared = set()
    for d in docs:
        declared.update(d["linked_claim_ids"])
    if declared:
        # 승격 id(doc-*)는 사용자 linked_claim_ids 대상이 아니다(내부 승격 네임스페이스) — 명시 거부.
        bad_doc_links = sorted(x for x in declared if x.startswith("doc-"))
        if bad_doc_links:
            raise SystemExit("[evidence-docs] linked_claim_ids 는 승격 id(doc-*)를 가리킬 수 없습니다"
                             "(WB-스캔 ev-* 만 연결 대상): %s" % ", ".join(bad_doc_links))
        valid_ids = set()
        if os.path.exists(claim_basis_path):
            try:
                cb = load_json(claim_basis_path)
            except Exception as e:
                raise SystemExit("[evidence-docs] claim-basis.json 파싱 실패(F5 대조 불가): %s" % e)
            for ev in (cb.get("evidence_on_file") or []):
                # 이전 인입이 승격한 doc-* 는 대조 대상에서 제외(사용자 링크는 ev-* 만).
                if isinstance(ev, dict) and isinstance(ev.get("id"), str) and not ev["id"].startswith("doc-"):
                    valid_ids.add(ev["id"])
        missing = sorted(declared - valid_ids)
        if missing:
            raise SystemExit("[evidence-docs] 연결 근거 id 가 claim-basis.json evidence_on_file 에 없습니다(F5): %s"
                             % ", ".join(missing))

    # 6) 유일성 최종 가드(N5 — 스키마 uniqueItems 미지원이라 코드로 강제): id·filename 중복 차단.
    ids = [d["id"] for d in docs]
    fns = [d["nfc"] for d in docs]
    if len(set(ids)) != len(ids) or len(set(fns)) != len(fns):
        raise SystemExit("[evidence-docs] 문서 id/파일명 유일성 위반(N5)")

    # 10) 정확복제 스냅샷(F2/N6): dest 초기화 후 검증된 바이트만 재적재(부분축소 시 stale 사본 잔존 차단).
    if os.path.islink(dest_dir) or (os.path.exists(dest_dir) and not os.path.isdir(dest_dir)):
        os.remove(dest_dir)
    elif os.path.isdir(dest_dir):
        shutil.rmtree(dest_dir)
    os.makedirs(dest_dir)
    for d in docs:
        with open(os.path.join(dest_dir, d["nfc"]), "wb") as f:
            f.write(d["_data"])
            f.flush()
            os.fsync(f.fileno())

    # 11) 매니페스트는 스냅샷이 전부 끝난 뒤 마지막에 원자적 기록(N7) — 미완 스냅샷 미반영.
    #   reflect 는 항상 기록(런내 반영 선언의 유일한 출처 — 사이드카는 스냅샷 안 됨). reflect:true 면
    #   claim/verdict_text/test_report 도 선언 원문 그대로 기록(하류 build_context·validate·gate·export 가 읽음).
    def _doc_manifest_entry(d):
        e = {"id": d["id"], "filename": d["nfc"], "ext": d["ext"], "bytes": d["bytes"],
             "sha256": d["sha256"], "grade": d["grade"], "linked_claim_ids": d["linked_claim_ids"],
             "reflect": bool(d.get("reflect", True))}
        if d.get("reflect", True):
            kind = d.get("kind") or ("test_report" if d.get("test_report") is not None else "general")
            e["kind"] = kind
            # claim 은 있을 때만 기록(원위치 보존 — 완전 문서는 게이트가 claim 을 보장하므로 기존 바이트 불변;
            #   pending 문서는 미확정이라 claim 이 없을 수 있고 스키마상 claim 은 minLength 1 이라 null 금지).
            if d.get("claim"):
                e["claim"] = d.get("claim")
            e["spec_origin"] = d.get("spec_origin") or "human"
            if kind == "test_report":
                # 완전 선언: verdict_text·test_report 원문 기록(기존 바이트 불변 — 게이트가 둘을 보장하므로 항상 truthy).
                #   W-3 pending(intent-only): 상세 미확정 → null 을 기록하지 않고(스키마 minLength 문자열·object 위반 차단)
                #   spec_status:pending 만 남긴다(00e 제안·승인 apply-proposal 이 상세를 채우고 pending 을 해소).
                if d.get("verdict_text"):
                    e["verdict_text"] = d.get("verdict_text")
                if d.get("test_report") is not None:
                    e["test_report"] = d.get("test_report")
                if d.get("spec_status") == "pending":
                    e["spec_status"] = "pending"
            else:   # 일반 참조 문서 — 반영 원문 포인트(각주 인용 채널로 반영)
                e["reflection_points"] = list(d.get("reflection_points") or [])
                # G5: 문서만 첨부(반영 스펙 미정) → pending 표식(00e 제안·승인 전까지 반영 의무·라벨 보류; 없으면 미기록=바이트 불변).
                if d.get("spec_status") == "pending":
                    e["spec_status"] = "pending"
        return e
    manifest = {
        "documents": [_doc_manifest_entry(d) for d in docs],
        "source": {"count": len(docs), "channel": channel},
    }
    atomic_write_json(manifest_path, manifest)
    print("[evidence-docs] %d개 근거 문서 스냅샷+매니페스트 → %s (EVIDENCE_DOCS=%d)"
          % (len(docs), manifest_path, len(docs)))

    # 11b) 시험 이미지 추출(G-B) + assets-manifest own_assets 등록. reflect:true·test_report 의 test_items image_ref
    #   선언 페이지를 실제 자산(inputs/assets/evidence/)으로 뽑아 아래 승격에서 image_path 로 결박한다.
    evidence_assets_dir = os.path.join(rdir, "inputs", "assets", "evidence")
    extracted = _extract_test_images(docs, dest_dir, evidence_assets_dir, rdir)
    _register_evidence_assets(rdir, extracted)

    # 12) 반영 승격(G1 — 첨부=반영). reflect:true·kind=test_report 문서를 claim-basis 로 승격(공통 헬퍼 — S6/W-3
    #   apply-proposal 이 그대로 재사용). 반환 cb_obj 로 blank-claim 가시화(ev-* 표지-only 경고).
    cb_obj = _promote_evidence_docs(docs, extracted, claim_basis_path, harness_root)
    if cb_obj is not None:
        # blank-claim 가시화(경고만·동작 무변경·stdout 골든 비대상): WB-스캔 ev-* 중 summary 가 표지-only 인
        #   항목(claim 빈 인체적용시험 마커 오염 — 메모리 four-issue ev-03). 승격은 doc-* 만 하므로 오염 미편입.
        _markers = EVIDENCE_MARKERS + POSSESSION_MARKERS
        for e in (cb_obj.get("evidence_on_file") or []):
            if not (isinstance(e, dict) and str(e.get("id", "")).startswith("ev-")):
                continue
            s = (e.get("summary") or "")
            residue = s
            for mk in _markers:
                residue = residue.replace(mk, "")
            if s.strip() and not re.sub(r"[\s\W_]+", "", residue):
                print("[evidence-docs] 경고: %s summary 가 표지-only(내용 없는 blank-claim 의심, 승격 대상 아님): %r"
                      % (e.get("id"), s.strip()[:60]))


def _promote_evidence_docs(docs, extracted, claim_basis_path, harness_root):
    """반영 승격(G1 — 첨부=반영). reflect:true·kind=test_report 문서 선언을 claim-basis.evidence_on_file 에 doc-NN
    '문서-유래 실증 엔트리'(+항목별 doc-NN-tKK)로 편입 → check_canon_coverage 의 evidence_gated 게이트가 실제 문서
    근거로 당겨지고 심의 5요소 재료가 공급된다. claim-basis 스키마는 동결이라 claim→summary·grade→kind 로 매핑하고
    verdict_text/reflect 는 매니페스트에만 둔다.
      멱등: 기존 doc-* 를 벗기고(base=ev-* 만) reflect:true 문서만 다시 append. doc-* 는 항상 ev-* '뒤'.
      바이트 불변: 추가할 reflect:true 도 없고 벗길 stale doc-* 도 없으면 claim-basis 를 다시 쓰지 않는다.
      ⚠ 일반화(G2): kind=test_report 만 승격한다(효능 실증). 일반 참조 문서는 claim-basis 에 넣지 않는다 —
        넣으면 clinicalEvidence 강제(check_canon_coverage)·강주장이 실증 근거로 오용(kcia evidence_ids). 대신
        매니페스트+REFERENCE_DOCS 라벨(G3)+각주 인용+반영 게이트로만 흐른다(안전 불변식, 계획 §9-2).
    docs = docs-형상 리스트(각 항목 id·nfc·ext·reflect·kind·test_report·grade·claim·spec_status). extracted = _extract_test_images 반환.
    반환: (재기록됐거나 무변경) 로드된 cb_obj(claim-basis 부재면 None). cmd_evidence_docs(인입 직접선언)·
    cmd_apply_proposal(00e 스펙 관문)이 공유 — 그래서 docs-형상 리스트만 받는 독립 함수다.
    ⚠ spec_status=pending(W-3 intent-only, 상세 미확정) 문서는 승격에서 제외한다 — 상세(claim·판정문·기관·n·기간)가
      아직 없어 승격하면 null summary 등으로 claim-basis 스키마를 깬다(00e 승인 apply-proposal 이 해소 후 승격)."""
    reflect_docs = [d for d in docs
                    if d.get("reflect", True) and d.get("kind") == "test_report" and d.get("spec_status") != "pending"]
    cb_obj = None
    if os.path.exists(claim_basis_path):
        try:
            cb_obj = load_json(claim_basis_path)
        except Exception as e:
            raise SystemExit("[evidence-docs] claim-basis.json 파싱 실패(반영 승격 불가): %s" % e)
    if reflect_docs and cb_obj is None:
        raise SystemExit("[evidence-docs] 반영 대상(reflect:true) 근거가 있으나 claim-basis.json 이 없습니다(승격 불가).")
    if cb_obj is not None:
        existing = cb_obj.get("evidence_on_file") or []
        base = [e for e in existing
                if not (isinstance(e, dict) and str(e.get("id", "")).startswith("doc-"))]
        promoted = []
        for d in reflect_docs:
            tr = d.get("test_report") or {}
            # 시험성적서 공통 메타(기관·n·기간) — 항목별 레코드에 공유(삽입 순서 = 기존 승격과 동일 → 바이트 불변).
            _meta = {}
            if tr.get("institution") is not None:
                _meta["institution"] = tr["institution"]
            if tr.get("sample_size") is not None:
                _meta["sample_size"] = tr["sample_size"]
            if tr.get("duration") is not None:
                _meta["duration"] = tr["duration"]
            # 부모 문서 레코드(doc-NN) — **항상 승격**(정성/measured_values 경로와 동일; 바이트 불변). P2-3(외부리뷰):
            #   정성 판정문 claim 의 evidence_ref=doc-NN 및 check_claim 실재성(evidence_ids)이 이 레코드에 의존한다.
            #   test_items 가 있어도 이 부모 레코드는 그대로 두고, 항목별 레코드(doc-NN-tKK)를 그 위에 추가한다.
            ent = {
                "id": d["id"],
                "kind": _evidence_kind(d.get("grade") or ""),
                "grade": d.get("grade") or "기타",
                "source": "inputs/evidence/%s" % d["nfc"],
                "summary": d.get("claim"),
            }
            ent.update(_meta)
            mv = tr.get("measured_values")
            if isinstance(mv, dict):   # 정량(측정값 쌍) — claim-basis 정량필드로 편입(차트 경로)
                for k in ("metric", "unit", "before", "after", "timepoint", "change_pct"):
                    if mv.get(k) is not None:
                        ent[k] = mv[k]
            promoted.append(ent)
            items = tr.get("test_items")
            if isinstance(items, list) and items:
                # G-B: 시험 항목마다 1 evidence 레코드(항목별 차트 1개 + 매칭 추출 이미지). 부모 doc-NN 위에 얹는다.
                for k, it in enumerate(items, start=1):
                    if not isinstance(it, dict):
                        continue
                    ient = {
                        "id": "%s-t%02d" % (d["id"], k),
                        "kind": "clinical_trial",
                        "grade": d.get("grade") or "기타",
                        "source": d["id"],   # doc-NN 결박(항목 승격 provenance)
                        "summary": d.get("claim") or it.get("metric") or "",
                    }
                    ient.update(_meta)
                    for kk in ("metric", "unit", "before", "after", "change_pct"):
                        if it.get(kk) is not None:
                            ient[kk] = it[kk]
                    # series {label,value} → claim-basis {timepoint,value}(clinical_chart.derive_chart 계약)
                    ser = it.get("series")
                    if isinstance(ser, list):
                        mapped = [{"timepoint": str(s["label"]), "value": s["value"]}
                                  for s in ser
                                  if isinstance(s, dict) and s.get("label") is not None and s.get("value") is not None]
                        if mapped:
                            ient["series"] = mapped
                    img = (extracted or {}).get((d["id"], k))
                    if img:
                        ient["image_path"] = img[0]   # 매칭 시험이미지(단일 페이지 — P2-4 로 다중 페이지는 인입서 거부)
                    promoted.append(ient)
        new_evidence = base + promoted
        if new_evidence != existing:
            new_cb = dict(cb_obj)
            new_cb["evidence_on_file"] = new_evidence
            # 승격 후 claim-basis 스키마 재검증(fail-closed) — 매핑이 계약을 깨지 않음을 보증.
            cb_schema_path = os.path.join(harness_root, "harness", "claim-basis.schema.json")
            cb_schema = load_json(cb_schema_path)
            v = Validator(cb_schema)
            v.validate(new_cb, cb_schema)
            if v.errors:
                raise SystemExit("[evidence-docs] 반영 승격 후 claim-basis 스키마 위반: %s" % "; ".join(v.errors))
            atomic_write_json(claim_basis_path, new_cb)
            print("[evidence-docs] 반영 승격: doc-* %d개 → claim-basis.evidence_on_file (base ev=%d)"
                  % (len(promoted), len(base)))
            return new_cb
    return cb_obj


def cmd_apply_proposal(args):
    """00e-evidence 반영 제안(사람 승인 후) → evidence-documents.json 매니페스트 재기록(pending 해소).
    사용법: apply-proposal <run_id>. gate.sh review-pass(00e finalize)가 호출한다(state 는 셸만; 여기선 매니페스트·claim-basis).
    두 유형의 pending 문서를 해소한다:
      · 일반 참조 문서(각주 인용 채널) — kind·claim·reflection_points 병합(claim-basis 미편입).
      · 시험성적서(kind=test_report) — **W-3(00e 스펙 2차 관문)**: 사람이 인입 시 kind:test_report 를 '선언'한(intent) pending
        문서에만, 에이전트 제안의 상세(claim·verdict_text·grade·기관·n·기간·test_items)를 채운다. 안전 불변식(intent-match):
        bare/일반 문서를 제안이 test_report 로 승격하는 것은 금지(규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람 승인).
        완전 선언된(인입 즉시 처리) test_report 는 이 경로를 애초 타지 않는다(pending 아님).
    각 제안 doc 을 pending 매니페스트 문서에 1:1 병합 + spec_origin=agent_proposed_human_approved + spec_status 제거.
    매니페스트 재기록 뒤, test_report 해소분은 **인입과 동일 함수 재사용**(_extract_test_images + _promote_evidence_docs)으로
    이미지 추출(inputs/assets/evidence/)+claim-basis 승격(doc-NN + doc-NN-tKK + image_path)을 실행한다.
    실패 시(중간 die) → 매니페스트가 이미 기록됐으면 gate=review 유지 → 재-kcia-check 재진입 시 no-pend 회복 경로가
    추출·승격만 멱등 재수행한다(원자성). change_pct 정규화(_normalize_change_pct)·5요소 완전성이 결정적 백스톱."""
    if not args:
        raise SystemExit("[apply-proposal] 사용법: apply-proposal <run_id>")
    run_id = args[0]
    harness_root = os.environ.get("HARNESS_ROOT") or _ROOT
    rdir = os.path.join(harness_root, "runs", run_id)
    prop_path = os.path.join(rdir, "00e-evidence", "reflection-proposal.json")
    manifest_path = os.path.join(rdir, "00-ingest", "evidence-documents.json")
    dest_dir = os.path.join(rdir, "inputs", "evidence")
    evidence_assets_dir = os.path.join(rdir, "inputs", "assets", "evidence")
    claim_basis_path = os.path.join(rdir, "00-ingest", "claim-basis.json")
    if not os.path.exists(prop_path):
        raise SystemExit("[apply-proposal] 반영 제안(reflection-proposal.json)이 없습니다: %s" % prop_path)
    if not os.path.exists(manifest_path):
        raise SystemExit("[apply-proposal] 근거 매니페스트가 없습니다: %s" % manifest_path)
    prop = load_json(prop_path)
    man = load_json(manifest_path)
    docs = man.get("documents") or []
    by_id = {d.get("id"): d for d in docs if isinstance(d, dict)}

    def _nfc(s):
        return unicodedata.normalize("NFC", s or "")

    pdocs = prop.get("docs") or []
    pset = {(d.get("id"), _nfc(d.get("filename"))) for d in pdocs if isinstance(d, dict)}
    pend = {(d.get("id"), _nfc(d.get("filename"))) for d in docs
            if isinstance(d, dict) and d.get("spec_status") == "pending"}
    GEN_KINDS = {"certification", "paper", "patent", "ingredient_dossier", "brand_story", "guide", "general"}
    if not pend:
        # 멱등(부분 finalize 회복): pending 이 이미 해소됐고 제안 doc 들이 매니페스트에 승인반영(spec_origin=
        #   agent_proposed_human_approved)돼 있으면 병합은 건너뛰되 아래 추출·승격은 재수행(멱등) — gate.sh 가 매니페스트
        #   재기록 뒤·추출/승격/advance 전에 중단됐다가 재-kcia-check 로 재진입하는 회복 경로(04 export-finalize 와 동형).
        applied = {(d.get("id"), _nfc(d.get("filename"))) for d in docs
                   if isinstance(d, dict) and d.get("spec_origin") == "agent_proposed_human_approved"}
        if not (pset and pset <= applied):
            raise SystemExit("[apply-proposal] 해소할 pending 문서가 없습니다(이미 해소됐거나 대상 아님).")
        print("[apply-proposal] 이미 반영됨(pending 없음·제안=승인반영 일치) — 멱등 재추출·재승격만 수행.")
    else:
        if pend != pset:
            raise SystemExit("[apply-proposal] 제안이 pending 문서와 1:1 대응하지 않습니다(누락/초과) — pending=%s 제안=%s"
                             % (sorted(pend), sorted(pset)))
        for pd in pdocs:
            tgt = by_id.get(pd.get("id"))
            if tgt is None:
                raise SystemExit("[apply-proposal] 제안 문서 id 가 매니페스트에 없습니다: %r" % pd.get("id"))
            kind = pd.get("kind")
            claim = _clean_decl_str(pd.get("claim"))
            pts = [p for p in (_clean_decl_str(x) for x in (pd.get("reflection_points") or [])) if p]
            if not claim:
                raise SystemExit("[apply-proposal] %s: claim 이 비어있습니다." % pd.get("id"))
            if not pts:
                raise SystemExit("[apply-proposal] %s: reflection_points 가 비어있습니다(원문 발췌 ≥1)." % pd.get("id"))
            if kind == "test_report":
                # 안전 불변식(intent-match): 사람이 이미 kind:test_report 로 '선언'(intent)한 pending 문서만 상세를 채울 수 있다.
                #   bare/일반 문서를 제안이 test_report 로 자동 승격하는 것은 금지 — 규제 성격 선언은 사람의 몫.
                if not (tgt.get("kind") == "test_report" and tgt.get("spec_status") == "pending"):
                    raise SystemExit("[apply-proposal] %s: 시험성적서(kind=test_report) 제안은 사람이 인입 시 kind:test_report 로 "
                                     "intent 선언 필요 — bare/일반 문서를 자동 승격할 수 없습니다. 인입 사이드카에 "
                                     "kind:test_report 를 선언하고 다시 인입하세요." % pd.get("id"))
                vtext = _clean_decl_str(pd.get("verdict_text"))
                grade = _clean_decl_str(pd.get("grade"))
                tr_norm = dict(pd.get("test_report") if isinstance(pd.get("test_report"), dict) else {})
                for _k in ("institution", "duration", "method"):
                    if isinstance(tr_norm.get(_k), str):
                        tr_norm[_k] = tr_norm[_k].strip()
                sample_size = tr_norm.get("sample_size")
                missing = []
                if not vtext:
                    missing.append("verdict_text")
                if not grade:
                    missing.append("grade")
                if not tr_norm.get("institution"):
                    missing.append("test_report.institution")
                if not (isinstance(sample_size, int) and not isinstance(sample_size, bool) and sample_size >= 1):
                    missing.append("test_report.sample_size(정수≥1)")
                if not tr_norm.get("duration"):
                    missing.append("test_report.duration")
                if missing:
                    raise SystemExit("[apply-proposal] %s: 시험성적서 제안이 불완전합니다 — claim/verdict_text/grade/"
                                     "test_report(기관·n·기간)를 채우세요 (결손: %s)." % (pd.get("id"), ", ".join(missing)))
                # P-2 재사용: 선언 change_pct 정규화(보고서 정수 표기 허용, 진짜 모순은 fail-closed). 매니페스트에 정규화값 저장.
                _normalize_change_pct(tr_norm, pd.get("id"))
                tgt["kind"] = "test_report"
                tgt["claim"] = claim
                tgt["verdict_text"] = vtext
                tgt["grade"] = grade
                tgt["test_report"] = tr_norm
                tgt["spec_origin"] = "agent_proposed_human_approved"
                tgt.pop("spec_status", None)        # pending 해소
                tgt.pop("reflection_points", None)  # test_report 는 verdict_text/test_report 채널(각주 reflection_points 아님)
            elif kind in GEN_KINDS:
                # 안전 불변식(외부리뷰 3R P1): 사람이 kind:test_report 로 선언한 pending 문서를 general 제안으로 '강등'할 수 없다.
                #   general 제안을 그대로 수용하면 규제 성격(시험성적서)이 조용히 일반 참조로 바뀌고 verdict_text/승격이 사라진다.
                #   → test_report intent 문서엔 test_report 제안만 허용. 성격을 바꾸려면 사람이 사이드카 선언을 고쳐 재인입해야 한다.
                if tgt.get("kind") == "test_report" and tgt.get("spec_status") == "pending":
                    raise SystemExit("[apply-proposal] %s: 사람이 kind:test_report 로 선언한 문서를 일반 문서(kind=%s) 제안으로 "
                                     "강등할 수 없습니다 — 시험성적서 상세(verdict_text·grade·기관·n·기간)를 채운 test_report 제안이어야 "
                                     "합니다. 성격을 바꾸려면 인입 사이드카 선언을 고쳐 다시 인입하세요." % (pd.get("id"), kind))
                tgt["kind"] = kind
                tgt["claim"] = claim
                tgt["reflection_points"] = pts
                tgt["spec_origin"] = "agent_proposed_human_approved"
                tgt.pop("spec_status", None)   # pending 해소
                tgt.pop("verdict_text", None)  # 일반 문서 — 판정문/시험요소 없음(각주 채널)
                tgt.pop("test_report", None)
            else:
                raise SystemExit("[apply-proposal] %s: 잘못된 kind: %r" % (pd.get("id"), kind))
        # 재기록 매니페스트를 스키마로 재검증 후 원자적 기록(계약 위반 fail-closed).
        ev_schema = load_json(os.path.join(harness_root, "harness", "evidence-documents.schema.json"))
        v = Validator(ev_schema)
        v.validate(man, ev_schema)
        if v.errors:
            raise SystemExit("[apply-proposal] 재기록 매니페스트 스키마 위반: %s" % "; ".join(v.errors))
        # ⚠ 외부리뷰 3R P2: 디스크 기록은 아래 추출(_extract_test_images) '성공 뒤'로 미룬다 — 추출이 실패하면
        #   pending 을 디스크에 보존해야, 재시도가 (잘못된 image_ref 를 고친) 제안을 다시 읽어 재병합할 수 있다(wedge 방지).

    # W-3: test_report 해소분 이미지 추출(G-B) + claim-basis 승격 — **인입과 동일 함수 재사용**(멱등).
    #   docs-형상 리스트로 변환(filename→nfc). general-only 면 test_report 문서 0 → 추출·승격·자산정리 모두 no-op
    #   (claim-basis·assets 바이트 불변). 추출 실패 = fail-closed(매니페스트는 이미 기록 → gate=review 유지 →
    #   재-kcia-check no-pend 회복 경로가 추출·승격만 멱등 재수행). state 재동기화는 셸(gate.sh)이 한다(ingest 는 state 미기록).
    docs_shaped = [{
        "id": md.get("id"),
        "nfc": _nfc(md.get("filename")),
        "ext": md.get("ext"),
        "reflect": bool(md.get("reflect", True)),
        "kind": md.get("kind"),
        "test_report": md.get("test_report"),
        "grade": md.get("grade"),
        "claim": md.get("claim"),
        "spec_status": md.get("spec_status"),   # 아직 미해소 pending 문서는 승격 제외(방어; 정상 경로는 해소 완료)
    } for md in docs if isinstance(md, dict)]
    # ⚠ 외부리뷰 3R P2: 추출을 매니페스트 기록 '앞'에 둬 게이트로 삼는다 — 추출 실패면 (else-path) 매니페스트 미기록 →
    #   pending 이 디스크에 남아 재시도가 고친 제안을 재병합. 회복 경로(pend 없음)는 이미 기록돼 있어 멱등 재추출만 한다.
    extracted = _extract_test_images(docs_shaped, dest_dir, evidence_assets_dir, rdir)
    if pend:   # else-path(신규 해소): 추출 성공 뒤에만 pending 해소 매니페스트를 디스크에 기록
        atomic_write_json(manifest_path, man)
        print("[apply-proposal] %d개 참조 문서 반영 스펙 확정(pending 해소) → %s" % (len(pdocs), manifest_path))
    _register_evidence_assets(rdir, extracted)
    _promote_evidence_docs(docs_shaped, extracted, claim_basis_path, harness_root)


# ─────────────── apply-intake (00a 첨부 분류 발효 = 승인된 분류 → 기존 채널 라우팅) ───────────────
# 카테고리(evidence_*) → evidence-index kind. 사이드카는 intent-only(reflect:true) — 상세는 00e(W-3)가 채운다.
_INTAKE_CATEGORY_KIND = {
    "evidence_test_report": "test_report",
    "evidence_certification": "certification",
    "evidence_paper": "paper",
    "evidence_patent": "patent",
    "evidence_ingredient_dossier": "ingredient_dossier",
    "evidence_brand_story": "brand_story",
    "evidence_guide": "guide",
    "evidence_general": "general",
}
_INTAKE_IMG_EXTS = frozenset(["png", "jpg", "jpeg", "webp", "gif", "svg"])
# F5c: 사람이 승인한 자사 이미지 세부역할(intake-proposal role enum 미러). apply-intake 가 자산 사이드카로 전파하고
#   cmd_assets 가 assets-manifest 로 반영한다 → 하류 master_reference 가 package_front 를 우선 선택(soft 힌트).
_INTAKE_ASSET_ROLES = frozenset(["package_front", "usage_shot", "logo", "ingredient_panel", "other"])
_ASSET_ROLES_SIDECAR = "asset-roles.json"        # routed/assets/ 자산 역할 사이드카(래스터 아님 → cmd_assets 자산 풀에서 자동 제외).


def _intake_rm(p):
    if os.path.islink(p) or (os.path.exists(p) and not os.path.isdir(p)):
        os.remove(p)
    elif os.path.isdir(p):
        shutil.rmtree(p)


def _intake_sanitize_example_name(fn):
    """참고 크롤 사례 디렉터리명(경로탈출 차단·NFC). 확장자 제거·불안전 문자 치환."""
    stem = unicodedata.normalize("NFC", os.path.splitext(os.path.basename(fn))[0])
    stem = re.sub(r"[^\w.\-가-힣]+", "_", stem).strip("._")
    if not stem or stem in (".", "..") or "/" in stem or "\\" in stem:
        stem = "ref"
    return stem


def _intake_find_first(base, target):
    """base 트리에서 파일명이 target 인 첫 파일(정렬 결정적). 없으면 None."""
    for root, dirs, files in os.walk(base):
        dirs.sort()
        for fn in sorted(files):
            if fn == target:
                return os.path.join(root, fn)
    return None


def _intake_find_first_dir(base, target):
    for root, dirs, files in os.walk(base):
        dirs.sort()
        for dn in sorted(dirs):
            if dn == target:
                return os.path.join(root, dn)
    return None


def _intake_route_crawl_into(src, is_zip, unpacked, fn, dst):
    """크롤 산출(자사=bundle / 참고=examples 사례)을 목적지로: zip=해체본에서 product.json·reviews.csv·images 수집,
    단일 파일=성격별 직접 복사. dst 구조는 ingest-bundle 이 기대하는 번들 형상(product.json·reviews.csv·images/)."""
    os.makedirs(dst, exist_ok=True)
    if is_zip:
        # ★ 외부리뷰 W4-R3: intake.sh 가 스냅샷 시 만든 _unpacked/ 트리(재검증 안 됨)가 아니라, '해시검증된 zip(src)'을
        #   apply 시점에 fresh 재추출한다 → routed 내용이 사람이 승인한 zip(sha256)과 반드시 일치(중간 _unpacked 변조·stale
        #   미탐지 차단). zip-slip(경로 이탈) 가드 포함. (unpacked 인자는 하위호환 시그니처 보존용·미사용.)
        import zipfile, tempfile
        base = tempfile.mkdtemp(prefix=".intake-unzip-", dir=os.path.dirname(os.path.abspath(dst)))
        try:
            try:
                with zipfile.ZipFile(src) as zf:
                    _broot = os.path.realpath(base)
                    for _m in zf.namelist():
                        _d = os.path.realpath(os.path.join(base, _m))
                        if _d != _broot and not _d.startswith(_broot + os.sep):
                            raise SystemExit("[apply-intake] zip 경로 이탈(zip-slip) 차단: %r in %s" % (_m, fn))
                    zf.extractall(base)
            except zipfile.BadZipFile:
                raise SystemExit("[apply-intake] 손상된 zip(재-인입 필요): %s" % fn)
            prod = _intake_find_first(base, "product.json")
            revs = _intake_find_first(base, "reviews.csv")
            if prod:
                shutil.copy2(prod, os.path.join(dst, "product.json"))
            if revs:
                shutil.copy2(revs, os.path.join(dst, "reviews.csv"))
            imgdir = _intake_find_first_dir(base, "images")
            if imgdir:
                dst_img = os.path.join(dst, "images")
                _intake_rm(dst_img)
                shutil.copytree(imgdir, dst_img)
        finally:
            _intake_rm(base)
        return
    low = fn.lower()
    bn = os.path.basename(fn)
    ext = os.path.splitext(low)[1].lstrip(".")
    if low.endswith("product.json"):
        shutil.copy2(src, os.path.join(dst, "product.json"))
    elif low.endswith("reviews.csv"):
        shutil.copy2(src, os.path.join(dst, "reviews.csv"))
    elif ext in _INTAKE_IMG_EXTS:
        imgdst = os.path.join(dst, "images", "detail")
        os.makedirs(imgdst, exist_ok=True)
        shutil.copy2(src, os.path.join(imgdst, bn))
    else:
        shutil.copy2(src, os.path.join(dst, bn))   # 기타 크롤 파일(범용)


def cmd_apply_intake(args):
    """00a-intake 승인 후(gate.sh review-pass) 승인된 분류대로 '기존 채널'로 결정적 라우팅(발효).
    사용법: apply-intake <run_id>. 스테이징 루트 runs/<id>/00a-intake/routed/ 를 매번 초기화·재구성(멱등):
      · own_product_crawl → routed/bundle/            (없으면 최소 합성 번들: product.json{선언 제품명}+reviews.csv 헤더)
      · reference_crawl   → routed/examples/<도메인>/<이름>/
      · product_image     → routed/assets/
      · evidence_*        → routed/evidence/ (+ index.json 사이드카: intent-only {kind, reflect:true} — 상세는 00e/W-3)
      · working_backwards → routed/working-backwards.md (00a-intake/converted/ 의 에이전트 변환본; 없으면 fail-closed)
    새 반영 경로를 만들지 않는다 — 이어서 gate.sh 가 ingest-bundle.sh 를 routed/ 채널로 호출하면 기존 00-ingest
    내부·조건부 라우팅(00e/00g/01-brief)이 그대로 흐른다. sha256 불변 대조(위변조 fail-closed). state.json 미기록(셸만 쓴다)."""
    if not args:
        raise SystemExit("[apply-intake] 사용법: apply-intake <run_id>")
    run_id = _safe_path_token(args[0], "run id")
    harness_root = os.environ.get("HARNESS_ROOT") or _ROOT
    rdir = os.path.join(harness_root, "runs", run_id)
    prop_path = os.path.join(rdir, "00a-intake", "intake-proposal.json")
    adir = os.path.join(rdir, "inputs", "attachments")
    unpacked = os.path.join(adir, "_unpacked")
    converted_wb = os.path.join(rdir, "00a-intake", "converted", "working-backwards.md")
    routed = os.path.join(rdir, "00a-intake", "routed")
    # ★ 사람 선언(intake.sh --domain/--product)은 state.json 이 진실 — env(HARNESS_DOMAIN)·에이전트 제안 아님(외부리뷰 W4·AGENTS §8).
    #   examples/<도메인> 라우팅과 합성 번들 제품명 모두 state.product 에서 읽어, gate.sh 가 도메인 미export 해도(그리고
    #   ingest-bundle 이 state 도메인으로 examples 를 찾아도) 일관되게 맞춘다.
    _st = load_json(os.path.join(rdir, "state.json"))
    _sp = _st.get("product") or {}
    domain = _sp.get("regulatory_domain") or _active_domain()   # (2부 1단계) state 미기재 시 cosmetic 폴백 대신 선언 도메인(HARNESS_DOMAIN) fail-closed
    if not os.path.exists(prop_path):
        raise SystemExit("[apply-intake] 분류 제안(intake-proposal.json)이 없습니다: %s" % prop_path)
    prop = load_json(prop_path)
    files = prop.get("files") or []

    # 1) sha256 불변 대조 + 스냅샷 1:1 커버리지(심층방어 — approve/validate 가 front-line, apply 도 재확인).
    snap = {}
    if os.path.isdir(adir):
        for fn in os.listdir(adir):
            if fn.startswith("."):
                continue
            p = os.path.join(adir, fn)
            if os.path.isfile(p):
                snap[unicodedata.normalize("NFC", fn)] = p
    seen = set()
    for f in files:
        fn = unicodedata.normalize("NFC", f.get("filename") or "")
        if fn in seen:
            raise SystemExit("[apply-intake] 제안 파일명 중복: %s" % fn)
        seen.add(fn)
        p = snap.get(fn)
        if not p:
            raise SystemExit("[apply-intake] 제안 파일이 스냅샷에 없습니다: %s" % fn)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if h != f.get("sha256"):
            raise SystemExit("[apply-intake] 스냅샷 위변조 감지(sha256 불일치): %s" % fn)
        if f.get("category") == "unknown":
            raise SystemExit("[apply-intake] 미분류(unknown) 첨부가 남아 있습니다: %s (approve 전 분류 필요)" % fn)
    if seen != set(snap.keys()):
        raise SystemExit("[apply-intake] 제안이 스냅샷 첨부와 1:1 아님(누락/초과) — 재-인입 필요.")

    # 2) 스테이징 초기화(멱등 — 매 실행 wipe+rebuild → 재-인테이크 결정성). routed/ 하위만 만든다.
    #    ★ 외부리뷰 W4-R5: 파괴적 작업(rm/mkdir/copy) '전에' routed 의 실경로가 런 안인지 검증 — 00a-intake 가 심볼릭이면
    #      _intake_rm(routed)가 링크를 따라 런 밖을 지울 수 있다. assert 를 rm 앞으로 옮겨 escape 를 먼저 차단한다.
    _assert_under_root(routed, rdir, "라우팅 스테이징")
    _intake_rm(routed)
    bundle_dst = os.path.join(routed, "bundle")
    examples_dst = os.path.join(routed, "examples", domain)
    assets_dst = os.path.join(routed, "assets")
    evidence_dst = os.path.join(routed, "evidence")
    for p in (bundle_dst, assets_dst, evidence_dst):
        os.makedirs(p, exist_ok=True)

    # 3) 승인 분류대로 결정적 라우팅.
    own_count = 0
    ref_count = 0
    evidence_docs = []   # [(dest_nfc, kind)] → index.json 사이드카(intent-only)
    asset_roles = []     # [(safe, role)] → asset-roles.json 사이드카(F5c; role 이 하나라도 있을 때만 생성)
    for f in files:
        fn = f.get("filename")
        cat = f.get("category")
        src = snap[unicodedata.normalize("NFC", fn)]
        is_zip = str(fn).lower().endswith(".zip")
        if cat == "working_backwards":
            continue   # WB 는 아래 converted/ 에서 라우팅(에이전트 변환본)
        elif cat == "own_product_crawl":
            _intake_route_crawl_into(src, is_zip, unpacked, fn, bundle_dst)
            own_count += 1
        elif cat == "reference_crawl":
            os.makedirs(examples_dst, exist_ok=True)
            # ★ 외부리뷰 W4-R6: zip 은 자기완결 사례라 개별 디렉터리, '느슨한 파일'(product.json+reviews.csv 등)은 한 참고
            #   크롤이 파일로 쪼개진 것이라 단일 디렉터리로 병합(own 크롤이 bundle 하나로 합쳐지는 것과 동형) — 안 그러면
            #   product/·reviews/ 로 분리돼 00g 가 불완전 사례를 보고 후기/제품 쌍이 유실된다. 병합명 `_reference` 는
            #   sanitizer 가 leading `_` 를 strip 하므로 zip 파생명과 충돌 불가.
            if is_zip:
                # ★ 외부리뷰 W4-R8: sanitize 충돌(예 'brand a.zip'↔'brand_a.zip' → 둘 다 'brand_a')이면 뒤 것이 앞 것을
                #   덮어써 참고 사례가 조용히 사라진다 → 충돌 시 안정 접미사로 분리(routed 는 매 apply wipe+rebuild 라 결정적).
                _stem = _intake_sanitize_example_name(fn)
                ex_dir = os.path.join(examples_dst, _stem)
                _sfx = 2
                while os.path.exists(ex_dir):
                    ex_dir = os.path.join(examples_dst, "%s-%d" % (_stem, _sfx)); _sfx += 1
            else:
                ex_dir = os.path.join(examples_dst, "_reference")
            os.makedirs(ex_dir, exist_ok=True)
            _intake_route_crawl_into(src, is_zip, unpacked, fn, ex_dir)
            ref_count += 1
        elif cat == "product_image":
            safe = _evidence_safe_name(os.path.basename(fn))
            if safe is None:
                raise SystemExit("[apply-intake] 안전하지 않은 자산 파일명: %r" % fn)
            shutil.copy2(src, os.path.join(assets_dst, safe))
            # F5c: 사람이 승인에서 선언한 세부역할(role)을 자산 사이드카로 전파(선택 필드 — 미기재면 무구분).
            #   category==product_image 브랜치이므로 여기 도달한 role 만 정당(validate-stage 가 타 category 의 role 을 선차단).
            _role = f.get("role")
            if _role is not None:
                if _role not in _INTAKE_ASSET_ROLES:
                    raise SystemExit("[apply-intake] %s: 알 수 없는 자산 역할(role=%r) — 재분류/재-인입 필요." % (fn, _role))
                asset_roles.append((safe, _role))
        elif cat and cat.startswith("evidence_"):
            safe = _evidence_safe_name(os.path.basename(fn))
            if safe is None:
                raise SystemExit("[apply-intake] 안전하지 않은 근거 파일명: %r" % fn)
            shutil.copy2(src, os.path.join(evidence_dst, safe))
            # ★ 외부리뷰 W4-R3: 근거 성격(kind)의 단일 출처는 '분류(category)'다 — 제안의 별도 kind 필드를 신뢰하면
            #   category:evidence_test_report + kind:general 불일치로 시험성적서가 general 사이드카로 강등돼 test_report
            #   pending 흐름(00e verdict/grade/시험요소 요구)을 우회한다. category 에서 도출하고, 제안 kind 가 불일치면 fail-closed.
            _cat_kind = _INTAKE_CATEGORY_KIND.get(cat)
            _prop_kind = f.get("kind")
            if _prop_kind and _cat_kind and _prop_kind != _cat_kind:
                raise SystemExit("[apply-intake] %s: 분류(category=%s)와 kind(%s) 불일치 — 근거 성격의 단일 출처는 category 입니다(재분류/재-인입 필요)." % (fn, cat, _prop_kind))
            kind = _cat_kind or "general"
            evidence_docs.append((safe, kind))
        else:
            raise SystemExit("[apply-intake] 알 수 없는 분류(category=%r) — 재-인입 필요: %s" % (cat, fn))

    # 4) 번들 필수 파일(product.json·reviews.csv) 보장 — ingest-bundle 이 둘 다 요구한다. ★ 외부리뷰 W4-R4: own_count 로
    #    분기하면 '부분 크롤'(product.json 만 있고 reviews.csv 없는 크롤·zip)에서 폴백이 억제돼 ingest-bundle 이 hard-fail →
    #    00a 훅 무한 재시도. 그래서 own 유무가 아니라 '없는 파일만' 채운다(크롤이 준 파일은 보존).
    _bp = os.path.join(bundle_dst, "product.json")
    _br = os.path.join(bundle_dst, "reviews.csv")
    if not os.path.isfile(_bp):
        # 합성 제품명 = 사람 선언(state.product.name, intake.sh --product) — 에이전트 제안 아님(AGENTS §8·외부리뷰 W4).
        pname = (_sp.get("name") or "").strip()
        if not pname:
            raise SystemExit("[apply-intake] state.product.name 이 비어있습니다 — 인입 시 --product 로 제품명을 선언하세요(번들 제품명의 단일 출처).")
        atomic_write_json(_bp, {"name": pname})
    if not os.path.isfile(_br):
        with open(_br, "w", encoding="utf-8") as fh:
            fh.write("content,score,option\n")   # 리뷰 0(부분 크롤/신제품 관행)

    # 5) 근거 사이드카 index.json 자동 생성(intent-only). test_report=상세 생략(00e/W-3 가 채움) · 그 외 evidence_*
    #    도 claim/reflection_points 미기재 → evidence-docs 완전성 게이트가 spec_status:pending 으로 남겨 00e 로 보낸다.
    if evidence_docs:
        sidecar = {}
        for (safe, kind) in sorted(evidence_docs):
            sidecar[safe] = {"kind": kind, "reflect": True}
        atomic_write_json(os.path.join(evidence_dst, _EVIDENCE_SIDECAR), sidecar)

    # 5b) 자산 역할 사이드카 asset-roles.json(F5c) — 역할이 하나라도 선언됐을 때만 생성한다(전무하면 미생성 →
    #     기존/골든 런의 routed/assets·assets-manifest 바이트 불변). evidence index.json 사이드카 선례를 미러.
    #     .json 확장자라 cmd_assets 자사-스캔(래스터 확장자만)에서 자동 제외돼 자산 풀을 오염시키지 않는다.
    if asset_roles:
        roles_sidecar = {}
        for (safe, role) in sorted(asset_roles):
            roles_sidecar[safe] = role
        atomic_write_json(os.path.join(assets_dst, _ASSET_ROLES_SIDECAR), roles_sidecar)

    # 6) 워킹백워드 채널 — 에이전트 변환본(00a-intake/converted/working-backwards.md) 을 라우팅. 분류됐는데 변환본이
    #    없거나 애초 분류가 없으면 fail-closed(브리프 전 단계의 사실 원천은 필수 — 조용한 all-unknown claim-basis 차단).
    wb_files = [f for f in files if f.get("category") == "working_backwards"]
    if not wb_files:
        raise SystemExit("[apply-intake] 워킹백워드로 분류된 첨부가 없습니다 — 제품 기획/브리프 문서를 "
                         "working_backwards 로 분류해 다시 승인하세요.")
    if not (os.path.isfile(converted_wb) and os.path.getsize(converted_wb) > 0):
        raise SystemExit("[apply-intake] 변환된 워킹백워드(00a-intake/converted/working-backwards.md)가 없습니다 — "
                         "/intake 세션 에이전트가 docx→md 변환본을 작성해야 합니다(승인 표의 '변환됨').")
    shutil.copy2(converted_wb, os.path.join(routed, "working-backwards.md"))

    print("[apply-intake] 라우팅 완료 → %s (자사 크롤 %d · 참고 크롤 %d · 근거 %d · 합성번들=%s)"
          % (routed, own_count, ref_count, len(evidence_docs), "예" if own_count == 0 else "아니오"))


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: ingest.py <voc|assets|claim-basis|best-practices|evidence-docs|apply-proposal|apply-intake> ...")
    cmd, rest = sys.argv[1], sys.argv[2:]
    {"voc": cmd_voc, "assets": cmd_assets, "claim-basis": cmd_claim_basis,
     "best-practices": cmd_best_practices, "evidence-docs": cmd_evidence_docs,
     "apply-proposal": cmd_apply_proposal, "apply-intake": cmd_apply_intake}[cmd](rest)


if __name__ == "__main__":
    main()
