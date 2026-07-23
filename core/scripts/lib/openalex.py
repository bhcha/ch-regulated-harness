#!/usr/bin/env python3
"""openalex.py — OpenAlex 직접 HTTP 근거 검색 클라이언트(MCP 아님, stdlib urllib 전용).

규제 주장 뒷받침용 학술 근거표(harness/results.schema.json 정합)를 OpenAlex REST 에서 직접 조립한다.
설계 8.4 의 MCP 노선은 폐기 — 여기선 `api.openalex.org/works` 를 urllib GET 으로만 호출한다(외부 import 0).

엔진(패턴은 image_engine.py 에서 따옴):
  search       실 OpenAlex 호출(온라인). urllib.request GET → JSON 파싱 → results.schema 형태로 정규화.
  search_stub  네트워크 없는 **결정적** stub(무작위·실시각 미사용). 기본 = 트리거는 있으나 근거 0건
               (환각 안전 — 지어내지 않음). B-4/B-7 이 오프라인 골든 조립에 쓴다(주입 가능).

image_engine.py 에서 그대로 따온 규율:
  - stdlib(urllib.request/error/parse)만 사용, 외부 패키지 import 0.
  - 폴리시/타임아웃/재시도 횟수는 env 오버라이드(HARNESS_OPENALEX_*), 비정상 값은 안전 폴백.
  - 429/5xx 는 지수 백오프 재시도, 소진 시 명확한 RuntimeError 하위 예외(무음 stub 강등 금지 — 호출부가 fail-closed).
  - 오프라인(HARNESS_OFFLINE=1) 방어: 실호출 경로에 진입하면 raise(결정성 보장; stub 은 search_stub 로 명시).
  - 키 비노출 규율의 동형: OpenAlex 는 API 키가 없고 mailto(이메일)만 있다 — mailto 는 URL 쿼리에만 쓰고
    로그·예외·반환 dict 에 절대 남기지 않는다(예외 문자열은 _redact 로 마스킹).

★ 환각 안전(핵심): `grade` 는 인용수·최신성으로 **논문 자체의 강도만** 라벨한다. "이 논문이 그 효능을
  증명한다"는 자동 단정이 **절대 아니다** — 실제 주장-근거 매칭·채택은 사람/RA 의 몫이다. 결과가 0건이면
  evidence_sufficient=false(주장 불가). 부작용·네트워크는 import 시점에 전혀 없다(순수 함수 라이브러리).

state.json 미수정(절대규칙 1번) — 이 모듈은 어떤 파일도 쓰지 않고 dict 만 반환한다.
"""
import sys
import os
import json
import time
import datetime
import urllib.request
import urllib.error
import urllib.parse

# ── 엔드포인트·기본값(환경변수 오버라이드) ──
_OPENALEX_WORKS = "https://api.openalex.org/works"
# UA 에는 이메일을 넣지 않는다(mailto 는 URL 쿼리에만) — polite pool 은 mailto 쿼리로 충족.
_USER_AGENT = "ch-regulated-harness/openalex (stdlib-urllib)"
_DEFAULT_PER_PAGE = 5
_MAX_PER_PAGE = 200          # OpenAlex per_page 상한(초과 클램프 — 400 방지)
_DEFAULT_TIMEOUT = 30
_RETRY_DEFAULT = 3           # 429/5xx 백오프 재시도 기본(env 미설정/비정상 폴백 단일 출처)
_BACKOFF_DEFAULT = (2.0, 5.0, 10.0)

# ── grade(강도 라벨) 임계 — cited_by_count·최신성 기준(순수 상수) ──
_GRADE_HIGH_CITED = 100      # 인용수 ≥ 이면 high
_GRADE_MODERATE_CITED = 20   # 인용수 ≥ 이면 moderate
_GRADE_RECENT_YEARS = 3      # 최근 N년 이내면 최신성 보정 대상(누적 인용시간 짧음 → 과소평가 완충)
_GRADE_RECENT_MIN_CITED = 5  # 최신 보정을 받으려면 최소 이만큼은 인용돼야(0인용 신간까지 끌어올리지 않음)


class OpenAlexError(RuntimeError):
    """OpenAlex 클라이언트 오류의 베이스(RuntimeError 하위 — 기존 `except RuntimeError` 경로 호환).
       네트워크·타임아웃·파싱·비정상 응답을 이 계열로 던진다. 호출부(B-3/B-4)가 잡아 fail-closed 판단."""


class OpenAlexQuotaExhausted(OpenAlexError):
    """429(요청 한도) 백오프 재시도를 소진했다는 타입 마커. 호출부가 '한도 초과'를 구체적으로 구분해 처리할 수 있게 한다."""
    status = 429


class OpenAlexHTTPError(OpenAlexError):
    """비-429 HTTP 오류(4xx 즉시 / 5xx 재시도 소진). 상태코드는 담되 URL/mailto 는 절대 담지 않는다(마스킹)."""


# ── env 파서(비정상 값은 안전 폴백 — import/stub 를 깨지 않는다) ──

def _retry_count():
    """429/5xx 백오프 재시도 횟수 = HARNESS_OPENALEX_RETRY(기본 3, 음수/비정상 → 3)."""
    try:
        v = int(os.environ.get("HARNESS_OPENALEX_RETRY", str(_RETRY_DEFAULT)))
        return v if v >= 0 else _RETRY_DEFAULT
    except (ValueError, TypeError):
        return _RETRY_DEFAULT


def _backoff():
    """백오프 대기열(초) = HARNESS_OPENALEX_BACKOFF 콤마목록(기본 '2,5,10'). 비정상/음수 토큰은 버리고,
       전부 비면 기본값으로 폴백. 테스트는 '0' 또는 '0,0,0' 으로 무-수면."""
    raw = os.environ.get("HARNESS_OPENALEX_BACKOFF", "2,5,10")
    out = []
    for tok in (raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except (ValueError, TypeError):
            continue
        if v >= 0:
            out.append(v)
    return out or list(_BACKOFF_DEFAULT)


def _resolve_retry(retry):
    """retry 인자(None → env/_retry_count · 정수 → 그 값 · 비정상 → 기본)."""
    if retry is None:
        return _retry_count()
    try:
        v = int(retry)
        return v if v >= 0 else _RETRY_DEFAULT
    except (ValueError, TypeError):
        return _RETRY_DEFAULT


def _resolve_timeout(timeout):
    """소켓 타임아웃 초 해석(image_engine 형태 안전 파싱).
       timeout None(미지정) → env HARNESS_OPENALEX_TIMEOUT(없으면 30) · 명시값 → 그 값 우선(env 무시).
       어느 경로든 양수(0 초과) 실수가 아니면 기본 30 으로 폴백(0·음수·비정수·비정상 문자열 모두)."""
    if timeout is None:
        raw = os.environ.get("HARNESS_OPENALEX_TIMEOUT", str(_DEFAULT_TIMEOUT))
        try:
            v = float(raw)
        except (ValueError, TypeError):
            return _DEFAULT_TIMEOUT
        return v if v > 0 else _DEFAULT_TIMEOUT
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0:
        return timeout
    return _DEFAULT_TIMEOUT


def _resolve_mailto(mailto):
    """polite pool 이메일 해석. mailto None(미지정) → env OPENALEX_MAILTO(없으면 None) · 명시값 → 그 값 우선.
       ★ 반환값은 오직 URL 쿼리(polite pool)에만 쓰이고, 로그·예외·반환 dict 엔 절대 넣지 않는다(_redact 규율
         유지 — env 에서 읽어도 노출 규율은 동일). 빈 문자열/비문자열은 None 취급."""
    if mailto is None:
        v = os.environ.get("OPENALEX_MAILTO")
        return v if isinstance(v, str) and v else None
    return mailto


def _min_relevance():
    """opt-in 관련도 문턱 = HARNESS_OPENALEX_MIN_RELEVANCE(float). 미설정/빈값/비정상(비-float) → None(문턱 미적용).
       ⚠ 안전 파싱 — 파싱 실패 시 문턱을 '무한대(항상 충분)'로 오해석하지 않고 None(문턱 미적용=기본 false)으로 폴백."""
    raw = os.environ.get("HARNESS_OPENALEX_MIN_RELEVANCE")
    if raw is None or not str(raw).strip():
        return None
    try:
        return float(raw)
    except (ValueError, TypeError):
        return None


def _evidence_sufficient(results):
    """★★★ 환각 안전 핵심 — OpenAlex 결과는 **미검증 발견 후보**다. 채택(효능 입증) 게이트가 아니다.
       기본(문턱 env 미설정) = **false**: 0건이든 다건이든, 관련도 문턱·주장↔논문 1:1 매칭 검증 전이므로
         느슨/노이즈 질의가 sufficient 로 오표기되지 않게 항상 불충분으로 둔다. results[] 배열이 후보를 담아
         사람/RA 가 검토(1:1 매칭 후 기존 근거첨부 흐름으로 승격)한다.
       opt-in 문턱 = HARNESS_OPENALEX_MIN_RELEVANCE(float): 설정 시, relevance_score ≥ 문턱 인 결과가 ≥1건이면 true.
       ★ true 여도 '사람이 검토할 관련 후보가 문턱 이상 있음'이지 '주장 입증됨'이 아니다(채택은 여전히 사람 게이트).
         게다가 grade(high/moderate/low)는 룰셋 evidence_grade 허용목록과 안 맞아 kcia_engine 이 자동 인용하지
         않는다 — evidence_sufficient=true 여도 자동 근거편입 0(이중 안전)."""
    thr = _min_relevance()
    if thr is None:
        return False
    for r in results:
        rel = r.get("relevance") if isinstance(r, dict) else None
        if isinstance(rel, (int, float)) and not isinstance(rel, bool) and rel >= thr:
            return True
    return False


def _now_iso():
    """현재 UTC 시각(ISO8601, 'Z' 접미). ⚠ search(실호출) 경로에서만 호출 — import·stub 는 시각을 만들지 않는다(결정성)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _year_from_iso(iso):
    """ISO8601 앞 4자리 → 연도 int(파싱 불가 → None). grade 최신성 보정용."""
    if isinstance(iso, str) and len(iso) >= 4 and iso[:4].isdigit():
        return int(iso[:4])
    return None


def _redact(text, mailto):
    """예외/로그로 나가는 문자열에서 mailto(raw·URL인코딩)를 마스킹(PII·비노출 최후방어, image_engine._redact_key 동형).
       mailto 가 비었으면 원문 그대로. 정규식이 아니라 str.replace 라 특수문자 안전."""
    if not text or not mailto:
        return text
    masked = text.replace(mailto, "***REDACTED***")
    enc = urllib.parse.quote(mailto, safe="")
    if enc and enc != mailto:
        masked = masked.replace(enc, "***REDACTED***")
    return masked


def _reconstruct_abstract(inverted_index):
    """abstract_inverted_index(단어 → 위치리스트) → 위치순 정렬로 초록 텍스트 복원(순수, 네트워크 없음).
       OpenAlex 는 초록을 역인덱스로만 제공한다. 각 (위치, 단어) 쌍을 모아 위치로 정렬 후 공백 결합한다.
       위치 gap(빠진 인덱스)은 존재하는 단어만 이어붙여 자연 처리(빈 토큰 미생성). 없거나 비정상이면 빈 문자열."""
    if not isinstance(inverted_index, dict) or not inverted_index:
        return ""
    pairs = []
    for word, positions in inverted_index.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            continue
        for pos in positions:
            # bool 은 int 하위라 배제(True/False 가 위치로 새는 것 방지)
            if isinstance(pos, int) and not isinstance(pos, bool) and pos >= 0:
                pairs.append((pos, word))
    if not pairs:
        return ""
    pairs.sort(key=lambda p: p[0])
    return " ".join(word for _, word in pairs)


def _grade(cited_by_count, year=None, relevance=None, now_year=None):
    """근거 **강도 라벨**만 반환(high/moderate/low).

    ★★★ 환각 안전 — 절대 오해 금지: 이 값은 "이 논문이 그 효능/주장을 뒷받침(증명)한다"는 자동 단정이
        **아니다**. 인용수(cited_by_count)와 최신성(publication_year)으로 **논문 자체의 강도**만 표기할 뿐이다.
        실제 주장-근거 매칭(이 논문이 우리 카피의 그 효능을 실제로 뒷받침하는가)은 **사람/RA 가 확인**한다.
        효능 채택을 이 함수가 자동으로 결정하지 않는다(설계 5·6번 규칙, results.schema 설명과 일치).

    ★★★ grade ≠ ruleset.evidence_grade(핵심 구분 — 반드시 이해): 여기 grade(high/moderate/low)는 인용수·연도로
        매긴 **발견 강도** 표기일 뿐, 룰셋의 '허용 근거유형'(ruleset.evidence_grade — 예: SCI/SCIE·전문학회지·
        인체적용시험)이 **아니다**. 그래서 OpenAlex 결과는 **자동으로 근거(evidence_ids)에 편입되지 않는다** —
        kcia_engine 은 sources 를 evidence_sufficient==True 이면서 grade 가 룰셋의 evidence_grade 허용목록과
        부분문자열 매칭될 때만 신뢰하는데, **현행 모든 룰셋(cosmetic/drug/quasi_drug)의 evidence_grade 가
        비어 있어** OpenAlex 의 high/moderate/low 는 그 목록과 매칭될 수 없다(= 자동 신뢰 0, 발견-전용). 이는
        **버그가 아니라 환각 안전 게이트**다(발견은 되지만 채택은 사람 게이트를 거친다). OpenAlex 결과는
        **발견 후보**이며, 실제 근거 채택은 **사람/RA** 가 논문↔주장 1:1 매칭을 확인하고(설계 6번 규칙) 기존
        근거첨부 흐름으로 승격(재-grade)할 때 이뤄진다. grade 는 그 사람 검토용 **강도 힌트**일 뿐이다.

    규칙: 인용수 ≥100 → high · ≥20 → moderate · 그 밖 → low.
      최신성 보정 — 최근 N년(_GRADE_RECENT_YEARS) 이내 신간은 인용 누적시간이 짧아 과소평가되기 쉬우므로,
      low 이면서 최소 인용(_GRADE_RECENT_MIN_CITED) 이상이면 moderate 로 한 단계만 완충한다(0인용 신간은 안 끌어올림).

    relevance(OpenAlex relevance_score)는 **grade 티어에 쓰지 않는다** — 질의별 상대점수라 정규화 경계(0~1)가
      없어 임계가 임의적이기 때문이다. 강도 참고용으로 결과 dict 에 별도 필드(relevance)로 보존만 한다(사람 판단용)."""
    c = cited_by_count if isinstance(cited_by_count, int) and not isinstance(cited_by_count, bool) and cited_by_count >= 0 else 0
    if c >= _GRADE_HIGH_CITED:
        g = "high"
    elif c >= _GRADE_MODERATE_CITED:
        g = "moderate"
    else:
        g = "low"
    if (g == "low" and isinstance(year, int) and not isinstance(year, bool)
            and isinstance(now_year, int) and 0 <= (now_year - year) <= _GRADE_RECENT_YEARS
            and c >= _GRADE_RECENT_MIN_CITED):
        g = "moderate"
    return g


def _normalize_work(work, query, retrieved_at, now_year):
    """OpenAlex works[] 항목 하나 → results.schema.json items 정합 dict(순수, 네트워크 없음).
       모든 노드를 형변환-안전하게 접근(비정상 JSON 도 통제 — AttributeError 방지). venue 는 스키마상 문자열(널 불가)이라 '' 폴백.
       abstract_ko 는 **초록 원문**을 담는다(번역은 여기서 하지 않는다 — 생성-측 다른 곳에서; 필드명이 _ko 지만 원문 저장)."""
    w = work if isinstance(work, dict) else {}
    wid = w.get("id")
    wid = wid if isinstance(wid, str) else ""
    title = w.get("title")
    if not isinstance(title, str) or not title:
        dn = w.get("display_name")
        title = dn if isinstance(dn, str) else ""
    primary = w.get("primary_location")
    primary = primary if isinstance(primary, dict) else {}
    src = primary.get("source")
    src = src if isinstance(src, dict) else {}
    venue = src.get("display_name")
    venue = venue if isinstance(venue, str) else ""
    year = w.get("publication_year")
    year = year if isinstance(year, int) and not isinstance(year, bool) else None
    doi = w.get("doi")
    doi = doi if isinstance(doi, str) else None
    cited = w.get("cited_by_count")
    cited = cited if isinstance(cited, int) and not isinstance(cited, bool) else None
    relevance = w.get("relevance_score")
    relevance = relevance if isinstance(relevance, (int, float)) and not isinstance(relevance, bool) else None
    abstract = _reconstruct_abstract(w.get("abstract_inverted_index"))
    return {
        "id": wid,
        "title": title,
        "venue": venue,
        "year": year,
        "grade": _grade(cited, year, relevance, now_year),
        "doi": doi,
        "abstract_ko": abstract,           # 초록 원문(번역 안 함). 없으면 빈 문자열.
        "source": "openalex",
        "query": query,
        "retrieved_at": retrieved_at,       # ISO8601(호출 시각). 스키마상 문자열|널.
        "relevance": relevance,             # 강도 참고용 원점수(grade 티어엔 미사용). 없으면 널.
        "cited_by_count": cited,            # 강도 근거(널 허용).
    }


def _build_url(query, per_page, mailto):
    """검색 URL 구성(순수). mailto 는 여기(URL 쿼리)에만 들어간다 — 반환·로그·예외엔 절대 넣지 않는다.
       ⚠ OpenAlex 페이지크기 파라미터는 **하이픈** `per-page` 다(언더스코어 `per_page` 는 무시돼 기본 25 로 떨어진다)."""
    params = [("search", query), ("per-page", str(per_page)), ("filter", "type:article")]
    if mailto:
        params.append(("mailto", mailto))
    return _OPENALEX_WORKS + "?" + urllib.parse.urlencode(params)


def _http_get_json(url, timeout, retry, mailto):
    """urllib GET → JSON dict. 429/5xx 지수 백오프 재시도(HARNESS_OPENALEX_BACKOFF/RETRY), 소진 시 명확한 예외.
       비-429 4xx·네트워크·타임아웃·파싱 실패는 즉시 raise. 예외 문자열엔 상태코드/본문만(URL·mailto 는 마스킹)."""
    backoff = _backoff()
    attempt = 0
    while True:
        try:
            req = urllib.request.Request(
                url, method="GET",
                headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as e:                 # HTTPError 는 URLError 하위 → 먼저 잡는다
            code = e.code
            if code == 429 or 500 <= code < 600:
                if attempt < retry:
                    delay = backoff[min(attempt, len(backoff) - 1)]
                    sys.stderr.write(
                        "[openalex] HTTP %d; backoff %.0fs (retry %d/%d)\n"
                        % (code, delay, attempt + 1, retry))
                    sys.stderr.flush()
                    attempt += 1
                    time.sleep(delay)
                    continue
                if code == 429:
                    raise OpenAlexQuotaExhausted(
                        "OpenAlex 429 요청 한도 초과(재시도 %d회 소진)" % retry) from None
                raise OpenAlexHTTPError(
                    "OpenAlex 서버 오류(status=%d, 재시도 %d회 소진)" % (code, retry)) from None
            # 비-429 4xx: 즉시 중단. 본문(최대 1000자)만 노출하되 mailto 마스킹.
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                body = "(본문 읽기 실패)"
            raise OpenAlexHTTPError(
                "OpenAlex HTTP 오류(status=%s): %s"
                % (code, _redact(body, mailto)[:1000])) from None
        except (urllib.error.URLError, TimeoutError) as e:  # 네트워크/타임아웃 → 즉시 중단(재시도 안 함)
            reason = getattr(e, "reason", e)
            raise OpenAlexError(
                "OpenAlex 네트워크 오류: %s" % (_redact(str(reason), mailto),)) from None
        try:
            return json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise OpenAlexError("OpenAlex 응답 파싱 실패(비정상 JSON): %s" % e) from None


def search(query, per_page=_DEFAULT_PER_PAGE, mailto=None, timeout=None,
           retry=None, stub=False, now=None):
    """OpenAlex 실 검색 → results.schema.json 정합 dict {results, evidence_sufficient, engine:"openalex"}.

    query    검색 질의(주장 키워드). 빈 문자열이면 ValueError.
    per_page 결과 수(1~200 클램프, 기본 5).
    mailto   polite pool 이메일(선택, 권장). None(미지정)이면 env OPENALEX_MAILTO(없으면 미사용).
             ★ URL 쿼리에만 — 반환/로그/예외에 미노출(마스킹). env 에서 읽어도 노출 규율은 동일.
    timeout  소켓 타임아웃 초. None(미지정)이면 env HARNESS_OPENALEX_TIMEOUT(없으면 30). 명시값 우선(비정상/음수 → 30 폴백).
    retry    429/5xx 백오프 재시도 횟수(None → env HARNESS_OPENALEX_RETRY 또는 3).
    stub     True 면 네트워크 없이 search_stub 로 위임(온라인 코드에서 오프라인 강제 스위치).
    now      retrieved_at 로 쓸 ISO8601 시각(테스트 결정성용 주입; None → 실 UTC 시각).

    ⚠ HARNESS_OFFLINE=1 인데 stub=False 로 실호출을 시도하면 raise(무음 stub 강등 금지 — 결정성/명시성).
       오프라인 결정적 결과가 필요하면 search_stub 을 명시 호출한다.
    ★ 환각 안전: OpenAlex 결과는 **미검증 발견 후보**다. evidence_sufficient 는 **기본 false**(문턱 env 미설정 시
      0건이든 다건이든 false — 채택은 사람/RA 게이트). HARNESS_OPENALEX_MIN_RELEVANCE(float) 를 명시로 넘기면
      relevance_score ≥ 문턱 결과가 ≥1건일 때만 true. true 여도 '검토할 관련 후보가 문턱 이상 있음'이지
      '주장 입증됨'이 아니다. grade 는 강도 라벨일 뿐 주장 뒷받침의 자동 단정이 아니다(evidence_grade 불일치로 자동인용 0)."""
    if stub:
        return search_stub(query)
    if os.environ.get("HARNESS_OFFLINE") == "1":
        raise OpenAlexError(
            "HARNESS_OFFLINE=1 — 오프라인에서는 OpenAlex 실호출이 금지됩니다(search_stub 를 명시 사용).")
    q = query if isinstance(query, str) else str(query or "")
    if not q.strip():
        raise ValueError("query 가 비어 있습니다 — 검색 질의(주장 키워드)가 필요합니다.")
    pp = per_page if isinstance(per_page, int) and not isinstance(per_page, bool) and per_page > 0 else _DEFAULT_PER_PAGE
    pp = max(1, min(pp, _MAX_PER_PAGE))
    to = _resolve_timeout(timeout)      # None → env HARNESS_OPENALEX_TIMEOUT(없으면 30) · 명시값 우선
    mailto = _resolve_mailto(mailto)    # None → env OPENALEX_MAILTO(없으면 None) · URL 쿼리에만(비노출 규율 유지)
    r = _resolve_retry(retry)
    retrieved_at = now if (isinstance(now, str) and now) else _now_iso()
    now_year = _year_from_iso(retrieved_at)
    data = _http_get_json(_build_url(q, pp, mailto), to, r, mailto)
    raw = data.get("results") if isinstance(data, dict) else None
    raw = raw if isinstance(raw, list) else []
    results = [_normalize_work(w, q, retrieved_at, now_year) for w in raw]
    return {
        "results": results,
        # ★ 환각 안전: 기본 false(미검증 발견 후보 — 0건이든 다건이든). opt-in HARNESS_OPENALEX_MIN_RELEVANCE
        #   문턱을 명시로 넘겨야만, relevance_score ≥ 문턱 결과가 ≥1건일 때 true(그래도 채택은 사람 게이트).
        "evidence_sufficient": _evidence_sufficient(results),
        "engine": "openalex",
    }


def search_stub(query, results=None, evidence_sufficient=None, engine="stub"):
    """네트워크 없는 **결정적** stub → results.schema.json 정합 dict. 무작위·실시각 미사용(두 번 호출 동일 출력).

    기본(인자 미주입) = **트리거는 있으나 근거 0건** 시나리오: {"results": [], "evidence_sufficient": false, ...}.
      → 환각 안전(지어내지 않음)이자 오프라인 골든의 안정 기본값.
    주입(유연성) — B-4/B-7 이 오프라인 골든을 조립할 때:
      results             results.schema items 형태의 리스트(그대로 통과 — 캐너가 결정적으로 넘긴다).
      evidence_sufficient None 이면 **기본 false**(search 실호출과 동일 규율 — OpenAlex 결과는 미검증 발견 후보라
                          다건 주입돼도 자동 true 로 올리지 않는다; 골든/mock evidence_sufficient:False 와 일관).
                          골든이 true 를 원하면 명시 주입(그 값을 그대로 씀).
      engine              결과 dict 의 engine 값(기본 'stub'; 골든이 다른 마커를 원하면 주입).

    ⚠ 결정성: 이 함수 자체는 Date/random 을 쓰지 않는다. 주입 results 의 결정성은 호출부 책임(고정 데이터)."""
    q = query if isinstance(query, str) else str(query or "")
    items = list(results) if isinstance(results, list) else []
    suff = False if evidence_sufficient is None else bool(evidence_sufficient)
    # q 는 시그니처 계약(감사·재현)상 받되, 빈결과 기본에서는 결과 항목이 없어 부수효과 없음.
    _ = q
    return {"results": items, "evidence_sufficient": suff, "engine": engine}


def _main(argv):
    """선택 CLI(필수 아님): python3 openalex.py search "<질의>" [--per-page N] [--mailto x] [--stub].
       import 부작용 0 유지를 위해 argparse 는 여기서만 import 한다."""
    import argparse
    ap = argparse.ArgumentParser(description="OpenAlex 직접 HTTP 근거 검색 클라이언트")
    sub = ap.add_subparsers(dest="cmd")
    sp = sub.add_parser("search", help="works 검색")
    sp.add_argument("query")
    sp.add_argument("--per-page", type=int, default=_DEFAULT_PER_PAGE)
    sp.add_argument("--mailto", default=None)
    sp.add_argument("--stub", action="store_true", help="네트워크 없이 결정적 stub")
    args = ap.parse_args(argv)
    if args.cmd == "search":
        res = search(args.query, per_page=args.per_page, mailto=args.mailto, stub=args.stub)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
