#!/usr/bin/env python3
"""evidence_search.py — 온라인 실증 근거 검색 배선(스크립트-측, 생성 단계 전용).

storyboard-outline 에서 실증 트리거(claim)를 **스크립트가 직접 감지**해 실 OpenAlex 검색을 돌리고,
03-storyboard/sources/{query.json,results.json} 을 결정적으로 (재)작성한다. run-stage.sh 가 **온라인
(STUB_MODE!=1)** 에서만 호출한다 — 오프라인(STUB_MODE=1) 골든 경로는 여기 도달하지 않는다(stub_stage.py 가
결정적 mock 을 쓰고, run-stage.sh 의 STUB_MODE 가드가 이 헬퍼 호출을 막는다).

설계 근거:
  · 트리거 스크립트-측 권위(fail-open 우회 제거): 에이전트가 쓴 query.json 존재에 **의존하지 않고**
    stub_stage._detect_triggers(rdir) 로 스스로 트리거를 감지한다. 에이전트가 트리거가 있는데 query.json 을
    빠뜨려도 스크립트가 (재)작성·검색하므로 실검색을 조용히 건너뛸 수 없다(규제상 fail-closed).
  · 항상 재검색(mock 신뢰 안 함·stale 제거): 기존 results.json 의 engine:"openalex" 마커를 신뢰해 스킵하지 않는다 —
    스키마가 provenance 를 증명 못 해 insession 에이전트가 그 마커를 위조하면 mock 근거 우회가 된다(외부리뷰 규제 지적).
    run-stage.sh 가 '생성이 일어난 시점'(NEED_GENERATE!=0 또는 insession)에만 이 헬퍼를 호출하고, 여기서 매번 실검색으로
    덮어써 에이전트 mock 을 신뢰하지 않는다. 재개/no-op 은 run-stage 가드가 호출을 막아 안정적이고, claim 이 바뀌면
    항상 현재 claim 으로 재검색하므로 옛-claim stale 논문도 자연히 제거된다. claim 이 None(무-트리거)면 빈 sources 로 정리.
  · 결정론(스크립트-측): state.json 미접촉 — 오직 03-storyboard/sources/ 만 쓴다(AGENTS 절대규칙 1번).
  · 환각 안전: OpenAlex 결과는 **미검증 발견 후보**다. evidence_sufficient 기본 false·grade 자동인용 0 은
    openalex.py 가 처리하고, 이 헬퍼는 검색 결과를 기록만 한다(자동 근거채택 없음 — 채택은 사람/RA 게이트).
  · fail-closed: 엔진 자체 실패(네트워크/타임아웃/파싱)는 예외로 전파 → run-stage.sh 가 die(무음 stub 강등 금지).
    "결과 0건"은 예외가 아니라 정상(results:[], evidence_sufficient:false — 주장 불가)이며 정상 종료한다.
  · 프롬프트 무수정: 에이전트가 insession 에 쓴 sources mock 은 placeholder 이며, 이 헬퍼가 결정적으로 덮어쓴다.

사용법: evidence_search.py <run_id> <run_dir> <engine>
  engine = resolve_evidence_engine 결과(온라인=openalex). engine!=openalex 면 no-op(오프라인 stub 은 호출 안 됨).
"""
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json, regulatory_domain  # noqa: E402
import openalex  # noqa: E402
import stub_stage  # noqa: E402  # _detect_triggers 재사용(스크립트-측 트리거 권위). import 부작용 = design-tokens 로드만(네트워크 0).

# stub_stage.run_stub(378-380)과 **동일 포맷·키순서**의 query.json 을 결정적으로 (재)작성하기 위한 상수.
_QUERY_FILTERS = {"grade": ["SCI/SCIE", "전문학회지"], "lang": ["ko", "en"]}

# 라틴 토큰 폴백이 훑는 '카피 본문' 필드. 키가 아니라 값만 본다 — 스키마 키(claim_strength 등)가
# 질의어로 새지 않게 한다.
# ⚠ `intent` 는 뺀다: 아웃라인 storyline.json 의 intent 는 사람이 쓴 제품 카피가 아니라 포맷 팩 캐논
#   (packs/_format/*/canon.json)이 소유한 블록 목적 문구("핵심 RTB 요약 3-4개")이고, A·B·C 3안에 그대로
#   복제돼 'RTB'·'VOC' 같은 하네스 용어가 빈도로 제품 성분어를 눌렀다(실측: 질의 대부분이 RTB →
#   "Real-Time Bidding" 무관 논문). 질의어는 제품 카피에서만 뽑는다(스키마상 intent 는 이 캐논 필드뿐).
_COPY_FIELDS = ("claim", "headline", "subcopy", "bodyText")
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9-]+")
# 카피 값에 섞여도 검색 질의로는 무의미한 토큰(스키마 enum·옵션키 잔재).
_TOKEN_STOP = frozenset((
    "factual", "efficacy", "superlative", "speed", "pending", "legal",
    "mechanism", "safety", "research", "true", "false", "null", "none",
))


def _query_doc(claim, triggers, derived_from=None):
    """오프라인 stub 의 query.json 과 동일 스키마·키순서(claim/triggers/filters/limit).
    온라인 경로만 `derived_from` 을 덧붙인다(감사용 — 질의어가 어디서 나왔는지. query.json 은
    스키마·validate 대상이 아니고 오프라인 stub 은 이 키를 쓰지 않아 골든 바이트 불변)."""
    doc = {"claim": claim, "triggers": triggers, "filters": _QUERY_FILTERS, "limit": 5}
    if derived_from is not None:
        doc["derived_from"] = derived_from
    return doc


def _pack_triggers(rdir):
    """선언 도메인 팩의 검색 주제 어휘.

    출처 3축의 합집합(순서 = 아래 순, 중복 제거):
      · `axes.substantiation_required.triggers` — 실증이 필요한 주장 표현
      · `axes.lexicon.condition_target` · `axes.lexicon.clinical_metrics` — 질환·측정지표 **주제어**
    ★ 실증 트리거만 쓰면 검색이 거의 안 돈다. 그 목록은 '과장 주장'을 잡으려고 **구(句)**로 적혀
      있어서(예 "모공 축소"·"수분 개선") 절제해 쓴 카피의 낱말("모공"·"수분")과 어긋난다. 실측:
      실증 트리거만 = 29건 중 5건, 주제어 합집합 = 16건(변경 전 커널 상수 13건보다도 높다).
      주제어 축은 낱말이라 카피와 맞고 질의도 'RTB'·'CS' 같은 잡토큰 대신 '여드름'·'모공'이 된다.
    미선언(state.json 부재·도메인 없음)이면 (None, None) → 호출부가 커널 상수로 폴백한다(후방호환).
    ★ 도메인은 선언됐는데 어휘를 못 얻으면(룰셋 부재·손상·로더 실패) None 이 아니라 **빈 어휘 []** 를
      돌려준다 — None 은 _detect_triggers 기본값을 타고 화장품 커널 상수(RULE_TRIGGERS)로 조용히
      치환돼 비-화장품 런에 화장품 어휘가 적용된다(AGENTS 8절 '조용한 cosmetic 폴백 금지' 위반).
      빈 어휘면 그 경로가 원천 차단되고, 감사 한 줄로 '어휘를 못 얻음'이 '어휘 무일치'와 구분된다."""
    try:
        domain = regulatory_domain(load_json(os.path.join(rdir, "state.json")))
    except Exception:
        domain = None
    if not domain:
        return None, None
    try:
        import kcia_engine   # 지연 import(모듈 로드 비용을 실검색 경로에만)
        rs = kcia_engine.load_ruleset(domain)
    except Exception:
        rs = {}
    axes = rs.get("axes") or {}
    lex = axes.get("lexicon") or {}
    vocab = []
    for src in ((axes.get("substantiation_required") or {}).get("triggers"),
                lex.get("condition_target"), lex.get("clinical_metrics")):
        for t in (src or []):
            if isinstance(t, str) and t and t not in vocab:
                vocab.append(t)
    if not vocab:
        # 룰셋 부재·손상·로더 실패뿐 아니라 '어휘 축이 아직 안 채워진 도메인'(quasi_drug 등)도 여기 온다.
        sys.stderr.write(
            "[evidence-search] 도메인 '%s' 팩 검색 어휘가 비어 있습니다(룰셋 부재·손상·로더 실패 또는 "
            "어휘 축 미작성) — 화장품 커널 어휘로 폴백하지 않고 빈 어휘로 진행합니다.\n" % domain)
        return domain, []
    return domain, vocab


def _copy_strings(node, out):
    """카피 본문 필드의 문자열 값만 수집(키 이름은 수집하지 않는다)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k in _COPY_FIELDS:
                if isinstance(v, str):
                    out.append(v)
                elif isinstance(v, list):
                    out.extend(x for x in v if isinstance(x, str))
            _copy_strings(v, out)
    elif isinstance(node, list):
        for v in node:
            _copy_strings(v, out)


def _latin_query(paths):
    """카피 본문의 라틴 문자 토큰에서 검색 질의를 고른다(트리거 어휘 무일치 시 폴백).

    성분·물질명은 한국어 카피 안에서도 라틴 문자 약어로 남는다. OpenAlex 는 영문
    학술 색인이라 이런 토큰이 한국어 주제어보다 훨씬 나은 질의다. 대문자 약어를 우선하고,
    없으면 가장 자주 나온 토큰을 쓴다. 지어내지 않고 카피에 실재하는 토큰만 쓴다."""
    strings = []
    for p in paths:
        try:
            _copy_strings(load_json(p), strings)
        except Exception:
            continue
    counts, order = {}, []
    for s in strings:
        for tok in _TOKEN_RE.findall(s):
            if tok.lower() in _TOKEN_STOP or len(tok) < 2:
                continue
            if tok not in counts:
                counts[tok] = 0
                order.append(tok)
            counts[tok] += 1
    if not order:
        return None
    acronyms = [t for t in order if t.upper() == t and 2 <= len(t) <= 10]
    pool = acronyms or order
    return max(pool, key=lambda t: (counts[t], -order.index(t)))


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: evidence_search.py <run_id> <run_dir> <engine>\n")
        return 2
    _rid, rdir, engine = argv[0], argv[1], argv[2]
    # 실검색은 openalex 엔진일 때만(오프라인 stub 은 run-stage.sh 의 STUB_MODE 가드로 여기 도달 안 함 — 방어적 no-op).
    if engine != "openalex":
        return 0
    sdir = os.path.join(rdir, "03-storyboard", "sources")
    qpath = os.path.join(sdir, "query.json")
    rpath = os.path.join(sdir, "results.json")

    # ── 스크립트-측 트리거 권위(fail-open 우회 제거) ──
    #   에이전트의 query.json 존재/내용에 의존하지 않고 스스로 트리거를 감지한다(stub 오프라인과 동일 감지기).
    #   query.json 은 스크립트가 결정적으로 (재)작성한다 — 에이전트 mock 을 무시(트리거 권위는 스크립트).
    #   ★ 어휘는 **선언 도메인 팩**이 소유한다(실증 트리거 + 질환·측정지표 주제어의 합집합).
    #     커널 상수(RULE_TRIGGERS)는 화장품 전용이라 그것만 보면 의약품·건기식 런은 트리거가
    #     영영 안 걸려 실검색이 상시 꺼진다. **도메인 미선언일 때만** 종전 상수로 폴백한다 —
    #     선언됐는데 어휘를 못 얻으면 빈 어휘라 커널 상수 경로가 차단된다(AGENTS 8절).
    domain, vocab = _pack_triggers(rdir)
    #   vocab = 팩 어휘 | [] 도메인은 선언됐으나 어휘 확보 실패(커널 상수 폴백 원천 차단) | None 미선언(후방호환).
    triggers = stub_stage._detect_triggers(rdir, vocab=vocab, include_outline=True)
    claim = triggers[0] if triggers else None
    derived_from = "vocab" if claim else None

    # ── 어휘 무일치 폴백: 카피의 라틴 토큰(성분·물질 약어)을 질의로 ──
    #   실증 트리거 어휘는 '과장 주장'을 잡는 목록이라, 절제해 쓴 정보성 카피(전부 factual)에는
    #   하나도 안 걸린다. 그래도 검색은 돌아야 하므로 카피에 실재하는 라틴 토큰으로 질의를 만든다.
    if not claim:
        claim = _latin_query(stub_stage.trigger_scan_paths(rdir, include_outline=True))
        if claim:
            derived_from = "latin-token"
            sys.stderr.write(
                "[evidence-search] 도메인 '%s' 트리거 어휘 무일치 — 카피의 라틴 토큰 '%s' 로 검색합니다.\n"
                % (domain or "미선언", claim))

    os.makedirs(sdir, exist_ok=True)
    atomic_write_json(qpath, _query_doc(claim, triggers, derived_from))

    # ── 질의어를 못 만듦: 실검색 안 함 + stale 정리 ──
    #   옛 openalex/에이전트 mock 이 남아 있으면 결정적 빈 sources 로 정리
    #   (오프라인 무-트리거 의미와 일관: {"results":[],"evidence_sufficient":false,"engine":"manual"}).
    #   ⚠ results.schema 의 engine 은 닫힌 enum 이라 '검색 못 함'을 값으로 남길 수 없다 — 그래서
    #     조용히 지나가지 않도록 stderr 에 감사 한 줄을 남긴다('검색할 게 없어서 0건'과 '검색을
    #     못 해서 0건'이 구분되지 않던 문제).
    if not (isinstance(claim, str) and claim.strip()):
        sys.stderr.write(
            "[evidence-search] 도메인 '%s': 트리거 어휘·라틴 토큰 모두 무일치로 실증 근거 검색을 "
            "수행하지 못했습니다(빈 sources 기록). 검색어를 사람이 지정하는 경로가 필요합니다.\n"
            % (domain or "미선언",))
        atomic_write_json(rpath, openalex.search_stub(claim, engine="manual"))
        return 0

    # ── 트리거 있음: 실 OpenAlex 검색을 '항상' 수행해 sources 를 스크립트-측 결과로 덮어쓴다 ──
    #   ★ 규제 안전(외부리뷰): 기존 results.json 의 engine:"openalex" 마커를 신뢰해 스킵하지 않는다 — 스키마가
    #     provenance 를 증명하지 못하므로 insession 에이전트가 그 마커를 위조해 mock 근거를 심으면 우회가 된다.
    #     run-stage.sh 가 '생성이 일어난 시점'(NEED_GENERATE!=0 또는 insession)에만 이 헬퍼를 호출하고, 여기서
    #     매번 실검색으로 덮어써 에이전트 mock 을 신뢰하지 않는다(재개/no-op 은 run-stage 가드가 호출을 막아 안정).
    #     이렇게 하면 claim 변경 시 stale 옛-논문도 자연히 제거된다(항상 현재 claim 으로 재검색).
    #   실 OpenAlex 검색 — 엔진 실패(네트워크/타임아웃/파싱)는 예외 전파 → 비-0 종료 → run-stage.sh fail-closed.
    #     "결과 0건"은 예외가 아니라 정상 반환(results:[], evidence_sufficient:false — 주장 불가).
    res = openalex.search(claim)   # {"results":[...], "evidence_sufficient":bool, "engine":"openalex"}
    atomic_write_json(rpath, res)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
