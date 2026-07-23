#!/usr/bin/env python3
"""form_factor.py — 제품 형태(제형/용기) 정규화 (순수 모듈, F2).

목적: 이미지·카피 생성이 '선택한 제품의 실제 형태'(패치/쿠션/앰플/정제/파스…)를 유지하도록,
      런-로컬 근거에서 형태 명사구를 **결정적으로 산출**해 프롬프트에 실어준다. 확산모델이 참조 제품의
      제형·용기(펌프/보틀/튜브 등)를 임의로 치환하는 것을 막는 앵커.

★ COMPUTED, never stored: 결과를 voc.json/claim-basis.json 등 산출물에 저장하지 않는다(동결 스키마·
  산출물 골든 불변). build_context(프롬프트)·image_engine(이미지 프롬프트)에만 주입된다. stub 은 두 경로를
  모두 안 타므로(오프라인 결정성) 이미지-매니페스트 골든 바이트가 불변이다.

입력(런-로컬만, 네트워크·state.json 없음):
  - 00-ingest/claim-basis.json  .product_type  (사람이 선언한 제품유형 = grounded 출처)
  - 00-ingest/voc.json          .product_facts.components (구성품 텍스트)
정규화 표(도메인 소유): packs/<domain>/ingest-profile.json 의 `form_factors`
  = [{"match": ["패치", …], "nouns": "하이드로콜로이드 패치(부착형)"}, …]  (배열 순서 = 우선순위).
판정: product_type + components 합본 텍스트에 대해 **first-match**(표 우선순위 순, 부분문자열, 대소문자 무시).
폴백: 매칭 없음(또는 표/도메인 없음) → product_type 문자열 축자(사람 선언이라 grounded). 그것도 비면 None
      (주입 없음 — 절대 지어내지 않는다).
결정성: 같은 입력 → 같은 출력(무작위·시각·네트워크 없음).
"""
import os
import json

_LIB = os.path.dirname(os.path.abspath(__file__))
import sys
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
from harness import PACKS_DIR, load_json  # noqa: E402


def _read_product_type(rdir):
    """claim-basis.json .product_type (사람 선언) → str|None. 파일 부재/깨짐/비-dict/공백 → None."""
    p = os.path.join(rdir, "00-ingest", "claim-basis.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    pt = data.get("product_type")
    if isinstance(pt, str) and pt.strip():
        return pt.strip()
    return None


def _read_components(rdir):
    """voc.json .product_facts.components → list[str] (비면 []). 파일 부재/깨짐/비정상 형태 → []."""
    p = os.path.join(rdir, "00-ingest", "voc.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError):
        return []
    if not isinstance(data, dict):
        return []
    pf = data.get("product_facts")
    if not isinstance(pf, dict):
        return []
    comps = pf.get("components")
    if not isinstance(comps, list):
        return []
    return [c for c in comps if isinstance(c, str) and c.strip()]


def _load_form_factor_table(domain):
    """packs/<domain>/ingest-profile.json 의 form_factors(배열=우선순위). 도메인 없음/로드 실패/비-배열 → []
       (그럼 first-match 없이 product_type 축자 폴백으로 안전 강등)."""
    if not domain or not isinstance(domain, str):
        return []
    try:
        prof = load_json(os.path.join(PACKS_DIR, domain, "ingest-profile.json"))
    except Exception:
        return []
    table = prof.get("form_factors") if isinstance(prof, dict) else None
    return table if isinstance(table, list) else []


def resolve_form_factor(rdir, domain=None):
    """정규화된 제품 형태 명사구(str) 또는 None. COMPUTED — 저장하지 않는다.

    domain: 팩 form_factors 표를 고르는 규제도메인. 호출자가 넘긴다(state.json 미열람) — build_context 는
      _resolve_domain 결과를, generate_all 은 셸 --domain 인자를 넘긴다. None 이면 표 없이 product_type 축자 폴백.
    결정성: 같은 (claim-basis/voc/표) → 같은 출력."""
    product_type = _read_product_type(rdir)
    components = _read_components(rdir)
    # first-match haystack = product_type + 구성품(대소문자 무시 — 한글은 무영향, 전사어 안전).
    haystack = " ".join([product_type or ""] + components).lower()
    for entry in _load_form_factor_table(domain):
        if not isinstance(entry, dict):
            continue
        matches = entry.get("match")
        nouns = entry.get("nouns")
        if not isinstance(matches, list):
            continue
        if not (isinstance(nouns, str) and nouns.strip()):
            continue
        for tok in matches:
            if isinstance(tok, str) and tok and tok.lower() in haystack:
                return nouns.strip()
    # 표 미매칭(또는 표/도메인 없음) → 사람 선언 product_type 축자(grounded). 그것도 비면 None(주입 없음).
    if product_type:
        return product_type
    return None


if __name__ == "__main__":
    _args = sys.argv[1:]
    if not _args:
        sys.exit("사용법: form_factor.py <run_dir> [<domain>]")
    _rdir = _args[0]
    _dom = _args[1] if len(_args) > 1 else None
    _ff = resolve_form_factor(_rdir, _dom)
    print(_ff if _ff is not None else "(none)")
