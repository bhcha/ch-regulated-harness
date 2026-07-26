#!/usr/bin/env python3
"""clinical_chart.py — 인체적용시험 차트의 '결정적 도출(derivation)' 단일 출처.

설계(아키텍처 재설계): 차트 수치·방향·허용값은 모두 evidence 레코드에서 '결정적으로 도출'되고,
검증·억제는 그 도출값에 대한 '정확 일치(exact equality)'로만 판정한다. 퍼지 정규식/허용오차/부호추정/
절분리/부정어 휴리스틱은 폐기한다 — kcia_engine·validate_storyboard 가 이 모듈을 함께 import 한다.

derive_chart(ev) 계약:
  values            : 라벨 동반 순서 있는 수치 리스트(없으면 None)
                        - series 가 숫자 value 2개 이상 → series 값/시점
                        - elif before·after 둘 다 숫자 → [before, after] / ["사용 전", duration|"사용 후"]
                        - else None(차트화 불가)
  labels            : values 와 같은 순서의 라벨(없으면 None)
  signed_change_pct : 부호 있는 변화율(소수 1자리 반올림). change_pct → before/after → series(첫→끝) 순.
  allowed_values    : set(values)
  direction         : sign(signed_change_pct)  (None 이면 0)
값도 변화율도 없으면 None 반환(차트화 불가).
"""

ROUND_PREC = 1   # 변화율 반올림 자릿수(단일 정밀도 — 도출·검증 공통)


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def derive_chart(ev):
    if not isinstance(ev, dict):
        return None
    before, after = ev.get("before"), ev.get("after")
    series = [s for s in (ev.get("series") or [])
              if isinstance(s, dict) and _is_num(s.get("value"))]
    series_vals = [float(s["value"]) for s in series]
    cp = ev.get("change_pct")
    metric = str(ev.get("metric") or "").strip() or None   # FIX JJ: metric/unit 결박용
    unit = str(ev.get("unit") or "").strip() or None

    # ⚠ 외부리뷰 FIX II: series 가 ≥2 포인트면 'series 가 소스'(모든 포인트·순서·시점 라벨). 중간 포인트 누락 차단.
    #   before/after 가 함께 있으면 series 첫=before·끝=after 교차검증(불일치 → None). series 없을 때만 before/after.
    if len(series_vals) >= 2:
        if series_vals[0] == 0:
            return None
        values = list(series_vals)
        labels = [str(s.get("timepoint") or "") for s in series]
        change = round((series_vals[-1] - series_vals[0]) / series_vals[0] * 100, ROUND_PREC)
        if _is_num(before) and abs(float(before) - series_vals[0]) > _NUM_EPS:
            return None
        if _is_num(after) and abs(float(after) - series_vals[-1]) > _NUM_EPS:
            return None
    elif _is_num(before) and _is_num(after):
        b, a = float(before), float(after)
        if b == 0:
            return None
        values = [b, a]
        labels = ["사용 전", str(ev.get("duration") or "사용 후")]
        change = round((a - b) / b * 100, ROUND_PREC)
    else:
        return None

    # 교차검증: change_pct 가 명시돼 있으면 계산 변화율과 정확히 일치해야 함(혼합 소스 차단).
    if _is_num(cp) and abs(round(float(cp), ROUND_PREC) - change) > _NUM_EPS:
        return None

    direction = (change > 0) - (change < 0)
    return {
        "values": values,
        "labels": labels,
        "signed_change_pct": change,
        "allowed_values": set(values),
        "direction": direction,
        "metric": metric,
        "unit": unit,
    }


# ── 숫자 토큰 ↔ 도출값 정합 판정(단일 출처) — chart 콜아웃 검증과 claim 수치 검증이 함께 호출(외부리뷰 FIX EE) ──
#   토큰 분류(외부리뷰 FIX MM, 정밀):
#     ① 끝점-범위("A에서 B로", "A→B", "A->B", "A~B") → A·B 는 원시 VALUE(allowed_values 멤버).
#     ② 명시 변화맥락(명시 +/- 부호, 'N% 감소/증가/개선', '감소율/증가율/개선율/변화율 N%') → CHANGE(signed_change_pct).
#     ③ 그 외 '%' 숫자: unit=='%' 면 원시 VALUE 또는 변화율 크기(둘 중 하나 일치) · unit!='%' 면 변화율 크기.
#     ④ 그 외 맨숫자 → VALUE(allowed_values).
#   비-측정 단위(n=/명/주/...) 숫자는 면제. '%' 가 항상 변화율인 것은 아니다(unit=='%' 면 48.2% 같은 원시값일 수 있음).
import re as _re

_TOKEN_NUM_RE = _re.compile(r"[-+]?\d+(?:\.\d+)?")
_RANGE_RE = _re.compile(r"([-+]?\d+(?:\.\d+)?)\s*%?\s*(?:에서|→|->|~)\s*([-+]?\d+(?:\.\d+)?)\s*%?\s*(?:으로|로)?")
_DIR_INC_WORDS = ("증가", "상승")
_DIR_DEC_WORDS = ("감소", "축소", "완화", "줄어", "하락")
_CHANGE_AFTER_WORDS = _DIR_INC_WORDS + _DIR_DEC_WORDS + ("개선",)
_RATE_BEFORE_WORDS = ("감소율", "증가율", "개선율", "변화율")
_NONMEASURE_UNITS = ("명", "주", "일", "개월", "회", "차", "년", "세", "번", "위", "건")
_NUM_EPS = 1e-6
_CTX_WIN = 7   # 토큰 뒤 변화어 근접 탐지 창(문자)
_PVAL_COMPARATORS = "<≤=>"
_PVAL_JOSA = ("은", "는", "이", "가")                 # 유의확률/유의수준/p값 뒤 한국어 조사(T3)
_PVAL_EN_MARKERS = ("p-value", "pvalue", "p value")  # 영문 p값 표기(T3, 대소문자 무관)


def _is_pvalue_context(before_seg):
    """⚠ 외부리뷰 FIX RR(+T3 확장): 숫자 토큰 바로 앞이 p값 마커면 True — p값은 측정값도 변화율도 아니므로
    정합 검사·n_matched 에서 제외한다.
    인식 마커(비교연산자·공백을 먼저 제거한 뒤 판정):
      · 한국어: p값 / 유의확률 / 유의수준 (+ 뒤 조사 은·는·이·가 1자 허용, T3)
      · 영문: 단독 p / p< / p = / p≤ · p-value / pvalue / p value (대소문자 무관, T3)
    'top'·'develop' 같은 영단어 끝 p 는 제외(단독 p 는 앞 글자가 비-영문일 때만 인정)."""
    s = before_seg.rstrip()
    while s and (s[-1] in _PVAL_COMPARATORS or s[-1].isspace()):
        s = s[:-1]
    sk = s[:-1] if (s and s[-1] in _PVAL_JOSA) else s   # 한국어 마커 뒤 조사 1자 흡수(T3)
    if sk.endswith("p값") or sk.endswith("유의확률") or sk.endswith("유의수준"):
        return True
    low = s.lower()
    for m in _PVAL_EN_MARKERS:                          # p-value·pvalue·p value(T3)
        if low.endswith(m):
            j = len(low) - len(m)                       # ⚠ 좌경계 검사(외부리뷰 T3-HIGH#1·LOW 하드닝): 마커 앞이
            if j == 0 or not (low[j - 1].isalnum() or low[j - 1] == "_"):  # 영문·숫자·_ 면 거부('top value'·'5p value'·'_p value')
                return True
    if s and s[-1] in ("p", "P") and (len(s) == 1 or not s[-2].isalpha()):
        return True
    return False


def metric_matches_claim(metric, text, aliases=None):
    """⚠ 외부리뷰 FIX QQ: 차트/claim 의 지표명 결박 단일 출처(validate·kcia 공통). 정확 부분문자열 OR '량' 접미 stem.
    - metric(예 '수분량')이 text 에 그대로 있거나, 그 stem(접미 '량' 제거 → '수분')이 text 에 있으면 True.
    - aliases(룰셋 clinical_metrics 등)가 주어지면, '같은 stem 을 공유하는' alias(또는 그 stem)도 인정.
    퍼지 매칭 아님 — 유한·결정적 정규화(접미 '량' stem)만. 서로 다른 측정명(stem 상이)은 매칭 안 됨."""
    if not metric:
        return True   # 지표 없음 → 결박 요구 없음(호출부에서 보통 metric 유무로 분기)
    text = text or ""

    def _stems(m):
        out = {m}
        if m.endswith("량") and len(m) > 1:
            out.add(m[:-1])
        return out

    cands = set(_stems(metric))
    base = metric[:-1] if (metric.endswith("량") and len(metric) > 1) else metric
    for a in (aliases or []):
        if not a:
            continue
        a_base = a[:-1] if (a.endswith("량") and len(a) > 1) else a
        if a_base == base:               # 같은 root 만 alias 로 인정(과확장 금지)
            cands |= _stems(a)
    return any(c and c in text for c in cands)


def numbers_consistent(text, derived):
    """text 의 모든 '측정 관련' 숫자 토큰이 derived(차트 도출)와 정확히 일치하는지 판정.
    반환 (ok, n_matched): ok=불일치 토큰 없음, n_matched=측정 토큰(범위/변화/값) 일치 개수(비-측정 단위 제외).
    derived 가 None 이면 (False, 0). 단일 출처 — validate 콜아웃·kcia claim 수치가 동일 규칙으로 호출."""
    if not derived:
        return (False, 0)
    scp = derived.get("signed_change_pct")
    allowed = set(derived.get("allowed_values") or set())
    unit = derived.get("unit") or ""
    text = text or ""
    n_matched = 0

    def _in_allowed(x):
        return any(abs(x - v) <= _NUM_EPS for v in allowed)

    # ① 끝점-범위: "A에서 B로" 는 A=도출 첫값, B=도출 끝값 '순서까지' 일치해야 함(외부리뷰 FIX NN — 역순 거부).
    #   범위에 방향어(감소/…→음수, 증가/…→양수)가 동반되면 sign(signed_change_pct)와 '반드시' 일치해야 함.
    vals = derived.get("values") or []
    first_v = abs(vals[0]) if vals else None
    last_v = abs(vals[-1]) if vals else None
    consumed = set()
    for rm in _RANGE_RE.finditer(text):
        a, b = abs(float(rm.group(1))), abs(float(rm.group(2)))
        if first_v is None or abs(a - first_v) > _NUM_EPS or abs(b - last_v) > _NUM_EPS:
            return (False, n_matched)   # 끝점 순서 불일치(역순 포함)
        # 범위 주변(앞/뒤 창)의 방향어가 있으면 부호 일치 강제.
        around = text[max(0, rm.start(1) - _CTX_WIN):rm.start(1)] + text[rm.end():rm.end() + _CTX_WIN]
        has_dec = any(w in around for w in _DIR_DEC_WORDS)
        has_inc = any(w in around for w in _DIR_INC_WORDS)
        if (has_dec or has_inc) and scp is not None:
            want = -1 if (has_dec and not has_inc) else (1 if (has_inc and not has_dec) else 0)
            if want != 0 and ((scp > 0) - (scp < 0)) != want:
                return (False, n_matched)   # 방향어 ≠ 실제 변화 방향
        n_matched += 2
        consumed.add(rm.start(1)); consumed.add(rm.start(2))

    for m in _TOKEN_NUM_RE.finditer(text):
        if m.start() in consumed:
            continue
        tok = m.group()
        mag = abs(float(tok))
        explicit = tok[:1] in ("+", "-")
        is_pct = text[m.end():m.end() + 1] == "%"
        after_ch = text[m.end():m.end() + 3]
        before_ch = text[max(0, m.start() - 2):m.start()]
        ctx = text[m.end():m.end() + _CTX_WIN]               # 토큰 뒤 근접 문맥
        before_wide = text[max(0, m.start() - 6):m.start()]  # 토큰 앞 근접 문맥(rate 단어)
        # ⚠ 외부리뷰 FIX RR(+T3): p값(p<0.05·p≤0.025·유의확률·p-value < 0.05 …) 숫자는 측정/변화 아님 → 스킵(n_matched 미증가).
        #   윈도우=12(외부리뷰 T3-HIGH#2): 띄어쓴 영문 'p-value < ' 같은 10자 마커가 8자에 잘려 미인식되던 문제 해소.
        if _is_pvalue_context(text[max(0, m.start() - 12):m.start()]):
            continue
        # 비-측정 맥락(n=52·52명·4주 등)은 검사 면제.
        if "=" in before_ch or before_ch.strip().lower().endswith("n"):
            continue
        if any(after_ch.startswith(u) for u in _NONMEASURE_UNITS):
            continue
        # ② 명시 변화맥락: 명시 부호 / 'N% (감소|증가|개선)' / '(감소율|증가율|개선율|변화율) N%'.
        dir_after = any(w in ctx for w in _CHANGE_AFTER_WORDS)
        rate_before = any(w in before_wide for w in _RATE_BEFORE_WORDS)
        explicit_change = explicit or (is_pct and dir_after) or rate_before
        if explicit_change:
            if scp is None:
                return (False, n_matched)
            if explicit:
                sign = 1 if tok[0] == "+" else -1
            elif any(w in ctx for w in _DIR_INC_WORDS):
                sign = 1
            elif any(w in ctx for w in _DIR_DEC_WORDS):
                sign = -1
            else:
                sign = 0   # 방향 미명시(예 '개선') → 크기만 비교
            if sign != 0:
                if abs(sign * mag - scp) > _NUM_EPS:
                    return (False, n_matched)
            elif abs(mag - abs(scp)) > _NUM_EPS:
                return (False, n_matched)
            n_matched += 1
        elif is_pct:
            # ③ 명시 변화맥락 없는 '%' 숫자.
            if unit == "%":
                # unit=='%' → 원시 값(48.2%) 또는 변화율 크기 둘 중 하나면 OK.
                if _in_allowed(mag) or (scp is not None and abs(mag - abs(scp)) <= _NUM_EPS):
                    n_matched += 1
                else:
                    return (False, n_matched)
            else:
                # unit!='%' → '%' 는 변화율(방향 미명시 → 크기).
                if scp is not None and abs(mag - abs(scp)) <= _NUM_EPS:
                    n_matched += 1
                else:
                    return (False, n_matched)
        else:
            # ④ 맨숫자 → VALUE.
            if not _in_allowed(mag):
                return (False, n_matched)
            n_matched += 1

    # ⚠ 외부리뷰 FIX PP: 숫자 토큰 수와 무관하게, '단독' 방향어(감소/…→음수, 증가/…→양수)는 sign(scp)와 일치해야 한다.
    #   끝점-범위가 소비한 방향어(FIX NN 이 이미 검증)는 제외하기 위해 범위 주변 창을 covered 로 본다.
    #   → "수분 감소 확인"(숫자 0개)도 evidence 방향에 결박. ('개선' 은 모호 → 제약 없음.)
    if scp is not None:
        sgn = (scp > 0) - (scp < 0)
        range_spans = [(rm.start(1) - _CTX_WIN, rm.end() + _CTX_WIN) for rm in _RANGE_RE.finditer(text)]

        def _standalone(words):
            for w in words:
                start = 0
                while True:
                    i = text.find(w, start)
                    if i == -1:
                        break
                    if not any(s <= i < e for (s, e) in range_spans):
                        return True   # 범위 밖(단독) 방향어 발견
                    start = i + 1
            return False
        if _standalone(_DIR_DEC_WORDS) and sgn != -1:
            return (False, n_matched)
        if _standalone(_DIR_INC_WORDS) and sgn != 1:
            return (False, n_matched)
    return (True, n_matched)
