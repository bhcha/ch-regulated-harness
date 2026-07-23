#!/usr/bin/env bash
# test-clinical-engine.sh — Phase 2 규칙엔진 단위 테스트(레코드 레벨).
#   (1) _evidence_satisfies 하드닝(Codex FIX 2): 완전 레코드 충족 / series=[{}] 거부 / 누락요소 거부 +
#       금지 표현("여드름 치료") drug_misperception 여전히 검출
#   (3) ADK Pass-A 지시문에 경계 문장 포함 확인
#   (4) _ruleset_grounding(cosmetic) 출력에 허용 형태 라인 포함 확인
# (교차블록 억제·디스클레이머 누락 통합 회귀는 실제 evaluate() 로 test-clinical-chart.sh 에서 검증)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## clinical-engine — 수치 차트 룰엔진 + ADK 지시문 단위 테스트"

# ── 1. _evidence_satisfies 레코드 충족 검사(하드닝) + drug 축 비억제 ──────
OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json

root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import Engine

# 화장품 룰셋 로드
packs = os.path.join(os.path.dirname(root), "packs")
with open(os.path.join(packs, "cosmetic/ruleset.json"), encoding="utf-8") as fh:
    ruleset = json.load(fh)

func_status = {"whitening": "unknown", "wrinkle": "unknown", "uv_protection": "unknown"}

def _eng(details):
    return Engine(ruleset, func_status, list(details.keys()), evidence_details=details)

# (a) 완전 레코드(before/after 쌍 + 기관 + n + 기간) → 충족
full = {"id": "ev-full", "kind": "clinical_trial", "grade": "인체적용시험", "source": "기관",
        "before": 48.2, "after": 31.5, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}
eng = _eng({"ev-full": full})
assert eng._evidence_satisfies("ev-full"), "full record must satisfy"
assert not eng._evidence_satisfies("no-such"), "missing id must not satisfy"

# (b) series 에 숫자 value 있는 항목 1개 이상 → measured_value_pair 충족
ser_ok = {"id": "ev-ser", "kind": "clinical_trial", "grade": "인체적용시험", "source": "기관",
          "series": [{"timepoint": "0주", "value": 48.0}, {"timepoint": "4주", "value": 31.0}],
          "institution": "가나다 연구소", "sample_size": 30, "duration": "4주"}
assert _eng({"ev-ser": ser_ok})._evidence_satisfies("ev-ser"), "series with numeric value must satisfy"

# (c) 하드닝: series=[{}] (숫자 value 없음) → 거부
ser_empty = {"id": "ev-ser0", "kind": "clinical_trial", "grade": "인체적용시험", "source": "기관",
             "series": [{}], "institution": "가나다 연구소", "sample_size": 30, "duration": "4주"}
assert not _eng({"ev-ser0": ser_empty})._evidence_satisfies("ev-ser0"), "series=[{}] must NOT satisfy (hardened)"

# (c2) 하드닝(Codex FIX J): 단일 포인트 series 는 '쌍'이 아님 → 거부(정확 재현).
ser_one = {"id": "ev-ser1", "kind": "clinical_trial", "grade": "인체적용시험", "source": "기관",
           "series": [{"timepoint": "4주", "value": 40}],
           "institution": "가나다 연구소", "sample_size": 30, "duration": "4주"}
assert not _eng({"ev-ser1": ser_one})._evidence_satisfies("ev-ser1"), "single-point series must NOT satisfy (FIX J)"

# (d) 측정쌍 없음(before 만) → 거부
no_pair = {"id": "ev-np", "kind": "clinical_trial", "grade": "인체적용시험", "source": "기관",
           "before": 48.2, "institution": "가나다 연구소", "sample_size": 30, "duration": "4주"}
assert not _eng({"ev-np": no_pair})._evidence_satisfies("ev-np"), "before without after must NOT satisfy"

# (e) 기관/n수/기간 누락 각각 → 거부
for missing in ("institution", "sample_size", "duration"):
    rec = dict(full); rec.pop(missing)
    assert not _eng({"ev-m": rec})._evidence_satisfies("ev-m"), "%s 누락 must NOT satisfy" % missing

# (f) sample_size 가 bool/문자열 → 숫자 아님으로 거부
rec_bool = dict(full); rec_bool["sample_size"] = True
assert not _eng({"ev-b": rec_bool})._evidence_satisfies("ev-b"), "sample_size=True(bool) must NOT satisfy"

# (g) 금지 표현("여드름 치료") → drug_misperception 검출(억제는 substantiation_required 만)
drug_vios = eng.scan_text("여드름 치료에 효과적인 제품", set())
dm = [v for v in drug_vios if v["axis"] == "drug_misperception"]
assert len(dm) > 0, "drug_misperception must still be raised for '여드름 치료' text"

print("ok")
PYEOF
)
check "(1) _evidence_satisfies 하드닝(완전충족·2점series·series[{}]·단일포인트(FIX J)·누락·bool 거부) + drug 축 검출" \
  "[ '$OUT' = 'ok' ]"

# ── 2. ADK Pass-A 지시문 경계 문장 포함 확인 ──────────────────────────────
BOUNDARY_OK=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, re, inspect
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import adk_critic
# Pass-A instruction 조립부 소스에서 경계 문장 확인(완전 실행 없이 소스 검사).
#   0단계 S6a 리팩터로 지시문 조립이 _do_passa → 순수함수 _build_passa_instruction 로 이동(온라인 바이트 동일).
src = inspect.getsource(adk_critic._build_passa_instruction)
ok = ("substantiation_required" in src
      and "충족" in src
      and "여드름이 낫는다" in src
      and "위반이 아닙니다" in src)
print("ok" if ok else "FAIL: boundary sentence missing")
PYEOF
)
check "(3) ADK Pass-A 지시문에 경계 문장 포함(substantiation_required 충족/위반아님/여드름이낫는다)" \
  "[ '$BOUNDARY_OK' = 'ok' ]"

# ── 3. _ruleset_grounding 허용 형태 라인 포함 ─────────────────────────────
GROUNDING_OK=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
packs = os.path.join(os.path.dirname(root), "packs")
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import adk_critic
ruleset_path = os.path.join(packs, "cosmetic/ruleset.json")
out = adk_critic._ruleset_grounding(ruleset_path)
ok = ("허용 형태" in out and "measured_value_pair" in out and "substantiation_required" in out)
print("ok" if ok else "FAIL: allowance line missing from grounding: " + repr(out[:200]))
PYEOF
)
check "(4) _ruleset_grounding(cosmetic) 에 허용 형태(measured_value_pair) 라인 포함" \
  "[ '$GROUNDING_OK' = 'ok' ]"

# ── 5. 정본 디스클레이머: _block_has_disclaimer = 정확 문자열 포함 여부(아키텍처 재설계) ──
DISC_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import _block_has_disclaimer as _D, CLINICAL_DISCLAIMER
def D(b): return _D(b, CLINICAL_DISCLAIMER)   # 팩 소유화: disclaimer 를 호출부가 주입(정본 상수 == 팩 clinical_substantiation.disclaimer)

assert CLINICAL_DISCLAIMER == "개인에 따라 차이가 있을 수 있습니다", "정본 문자열 상수 확인"

def blk(*texts):
    return {"headline": texts[0] if texts else "", "subcopy": "",
            "bodyText": list(texts[1:]), "footnotes": []}

# 정본 문자열이 그대로 들어있으면 True(헤드/서브/본문/각주 어디든).
assert D(blk("", "개인에 따라 차이가 있을 수 있습니다")), "본문 정본 문자열 인정"
assert D({"headline": "", "subcopy": "가나다 인체적용시험. 개인에 따라 차이가 있을 수 있습니다", "bodyText": [], "footnotes": []}), "subcopy 정본 인정"
assert D({"headline": "", "subcopy": "", "bodyText": [],
          "footnotes": [{"id": "f", "text": "인체적용시험. 개인에 따라 차이가 있을 수 있습니다."}]}), "각주 정본 인정"
# 정본이 아닌 변형/유사 표현은 모두 거부(정확 일치만 — 퍼지 NLP 폐기).
assert not D(blk("", "개인차가 있을 수 있습니다")), "비정본 변형 거부"
assert not D(blk("", "결과는 개인마다 다를 수 있습니다")), "비정본 변형 거부"
assert not D(blk("", "개인차 없이 동일한 결과")), "부정문 거부"
assert not D(blk("", "임상으로 입증된 결과입니다")), "디스클레이머 없음 거부"
print("ok")
PYEOF
)
check "(5) 정본 디스클레이머: 정확 문자열만 인정, 변형/부정 거부(퍼지 NLP 폐기)" \
  "[ '$DISC_OUT' = 'ok' ]"

# ── 6. FIX I: _block_shows_context 숫자/기간 경계 매칭(n=152·14주 오매칭 거부) ──
CTX_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import _block_shows_context as _C, _CLINICAL_SUBSTANTIATION_DEFAULT
def C(b, detail): return _C(b, detail, _CLINICAL_SUBSTANTIATION_DEFAULT)   # 팩 소유화: 표기 어휘(n수·피험자·기간)를 호출부가 주입

detail = {"institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}
def blk(subcopy):
    return {"headline": "", "subcopy": subcopy, "bodyText": [], "footnotes": []}

# 긍정: 기관 + n=52 + 4주 노출 → True
assert C(blk("가나다 피부과학연구소 인체적용시험, n=52, 4주"), detail), "정상 맥락 노출 인정"
assert C(blk("가나다 피부과학연구소 / 52명 / 4주"), detail), "'52명'·'4주' 형태 인정"
assert C(blk("가나다 피부과학연구소 피험자 52명, 4주"), detail), "'피험자 52명, 4주' 인정"
# 정확 재현 거부(Codex FIX I): n=152 는 52 를 만족시키지 못함
assert not C(blk("가나다 피부과학연구소 인체적용시험, n=152, 4주"), detail), "'n=152' → sample_size 52 미충족"
assert not C(blk("가나다 피부과학연구소 152명 4주"), detail), "'152명' → sample_size 52 미충족"
# 정확 재현 거부(Codex FIX I): 14주 는 4주 를 만족시키지 못함
assert not C(blk("가나다 피부과학연구소 n=52 14주"), detail), "'14주' → duration 4주 미충족"
# 정확 재현 거부(Codex FIX N): 단위 불일치 — 4개월 은 duration '4주' 를 만족시키지 못함
assert not C(blk("가나다 피부과학연구소 n=52, 4개월"), detail), "'4개월' → duration '4주' 미충족(단위 별칭 한정)"
# 정확 재현 거부(Codex FIX N): '52%' + 떨어진 '참여' 토큰만으로는 sample_size 52 미충족
assert not C(blk("가나다 피부과학연구소 52% 감소, 임상 참여, 4주"), detail), "'52% … 참여' → sample_size 52 미충족(인접 마커 필요)"
# 기관 미노출 → 거부
assert not C(blk("인체적용시험 n=52 4주"), detail), "기관 미노출 거부"
# detail 없음 → 거부
assert not C(blk("아무거나"), None), "detail 없음 거부"
print("ok")
PYEOF
)
check "(6) FIX I/N: _block_shows_context 경계매칭 — 'n=152'·'152명'·'14주'·'4개월'·'52%+참여' 거부, 정상('피험자 52명/4주') 인정" \
  "[ '$CTX_OUT' = 'ok' ]"

# ── 7. FIX J 스키마: claim-basis evidence series 2점 통과 / value 누락 항목 거부 ──
SERIES_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from harness import Validator, load_json
schema = load_json(os.path.join(root, "harness/claim-basis.schema.json"))
def cb(series):
    return {"functional_status": {}, "notified_ingredients": [], "certifications": [],
            "product_type": "x", "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"},
            "evidence_on_file": [{"id": "ev", "kind": "clinical_trial", "grade": "인체적용시험",
                "source": "기관", "series": series}]}
def is_valid(series):
    v = Validator(schema); v.validate(cb(series), schema); return len(v.errors) == 0
two_pt = is_valid([{"timepoint": "0주", "value": 48.0}, {"timepoint": "4주", "value": 31.0}])
missing_value = is_valid([{"timepoint": "4주"}])
print("ok" if (two_pt and not missing_value) else "FAIL two_pt=%s missing_value=%s" % (two_pt, missing_value))
PYEOF
)
check "(7) FIX J 스키마: 2점 series 통과 / value 누락 series 항목 거부" \
  "[ '$SERIES_OUT' = 'ok' ]"

# ── 8. derive_chart 결정적 도출 — 차트 결박/청구 결박의 단일 출처(부호 포함) ──
DERIVE_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart
# before/after → values=[before,after], signed_change_pct 부호 보존(-20.0), direction -1.
d = derive_chart({"before": 50.0, "after": 40.0})
assert d["values"] == [50.0, 40.0], "values 순서"
assert d["signed_change_pct"] == -20.0, "감소 -20.0 부호 보존"
assert d["direction"] == -1, "direction -1"
assert d["allowed_values"] == {50.0, 40.0}, "allowed_values"
# 증가 케이스 → +25.0(부호 보존).
assert derive_chart({"before": 40.0, "after": 50.0})["signed_change_pct"] == 25.0, "증가 +25.0"
# change_pct 우선 + 소수 1자리 반올림.
assert derive_chart({"before": 48.2, "after": 31.3, "change_pct": -35.1})["signed_change_pct"] == -35.1, "change_pct 우선"
assert derive_chart({"before": 48.2, "after": 31.3})["signed_change_pct"] == -35.1, "도출 변화율 -35.1(반올림)"
# series(2점) → values/순서 + 첫→끝 변화율.
ds = derive_chart({"series": [{"timepoint": "0주", "value": 50}, {"timepoint": "4주", "value": 40}]})
assert ds["values"] == [50.0, 40.0] and ds["signed_change_pct"] == -20.0, "series 도출"
# 차트화 불가(값·변화율 없음) → None.
assert derive_chart({"institution": "x"}) is None, "차트화 불가 None"
print("ok")
PYEOF
)
check "(8) derive_chart 결정적 도출: values·순서 + 부호 있는 변화율(소수1자리) + 차트화불가 None" \
  "[ '$DERIVE_OUT' = 'ok' ]"

# ── 9. FIX AA: 단일 원자 소스 + 상호 일관성 — 혼합/불일치 소스는 None(차트화 불가) ──
ATOMIC_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart
# 정확 재현(Codex FIX AA): series=[100,90] + before=10/after=20/change_pct=100(혼합·불일치) → None.
assert derive_chart({"series": [{"timepoint": "0", "value": 100}, {"timepoint": "1", "value": 90}],
                     "before": 10, "after": 20, "change_pct": 100}) is None, "혼합 불일치 소스 → None"
# change_pct 가 before/after 도출 변화율과 불일치 → None.
assert derive_chart({"before": 50, "after": 40, "change_pct": -99}) is None, "change_pct 불일치 → None"
# before/after 와 series 가 일치 → 도출(before/after 기준).
d = derive_chart({"before": 50, "after": 40,
                  "series": [{"timepoint": "0", "value": 50}, {"timepoint": "4", "value": 40}]})
assert d and d["values"] == [50.0, 40.0] and d["signed_change_pct"] == -20.0, "일치 소스 → 도출"
print("ok")
PYEOF
)
check "(9) FIX AA: 혼합/불일치 소스(series≠before/after, change_pct 불일치) → derive_chart None(fail-closed)" \
  "[ '$ATOMIC_OUT' = 'ok' ]"

# ── 10. FIX EE: numbers_consistent 단일 규칙 — '%'는 변화율(부호 포함), 맨숫자는 값. claim·콜아웃 공통 호출. ──
NMATCH_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart, numbers_consistent
d = derive_chart({"before": 50.0, "after": 40.0})   # signed_change_pct = -20, allowed_values {50,40}
def ok(t): return numbers_consistent(t, d)[0]
# 정확 재현(Codex FIX EE):
assert not ok("수분 +20% 개선"), "'+20%'(명시 +) vs 변화 -20 → 불일치"
assert not ok("수분 40% 개선"), "'40%'(변화율) vs |−20| → 불일치(after=40 raw value 와 매칭 금지)"
assert ok("수분 20% 감소"), "'20% 감소'(−20) == −20 → 일치"
assert ok("측정값 40"), "맨숫자 40 = after(값) → 일치"
assert not ok("측정값 30"), "맨숫자 30 ∉ {50,40} → 불일치"
assert ok("탄력 개선 20% 확인"), "'20%' 변화율 크기 20 == |−20| → 일치(방향 미명시)"
# '%'는 값(allowed_values=40)이 아니라 변화율과 비교됨을 명시 확인: '40%' 는 불일치, '40'(맨숫자)는 일치.
assert ok("측정값 40") and not ok("개선 40%"), "'40' 값 일치 / '40%' 변화율 불일치 — % ≠ 값"
print("ok")
PYEOF
)
check "(10) FIX EE: numbers_consistent — '%'=변화율(부호)·맨숫자=값 단일규칙('+20%'·'40%' 불일치, '20% 감소'·'40' 일치)" \
  "[ '$NMATCH_OUT' = 'ok' ]"

# ── 11. FIX MM: 끝점-범위·unit=='%' 원시값을 CHANGE 로 오분류하지 않음(실제 fixture 형식) ──
MM_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart, numbers_consistent
def ok(t, d): return numbers_consistent(t, d)[0]
# unit=='%' + 끝점-범위("48.2%에서 31.3%로 감소") → 48.2,31.3 은 원시 endpoint → 일치(과거 오탐 회귀).
d = derive_chart({"metric": "피지량", "unit": "%", "before": 48.2, "after": 31.3, "change_pct": -35.1})
assert ok("피지량 48.2%에서 31.3%로 감소", d), "끝점-범위(48.2%→31.3%) endpoint 일치"
# unit=='%' 단일 원시값("피지량 31.3%") → allowed_values 멤버 → 일치.
assert ok("피지량 31.3%", d), "unit==% 단일 원시값 31.3% 일치"
# 명시 변화는 여전히 부호까지 검사: "+99% 증가"(근거 -35.1) → 불일치.
assert not ok("수분 +99% 증가", d), "'+99% 증가'(명시 변화) vs -35.1 → 불일치"
# 조작 끝점("99에서 80으로") → endpoint 불일치.
assert not ok("피지량 99에서 80으로 감소", d), "조작 끝점 99/80 ∉ {48.2,31.3} → 불일치"
# 실제 fixture 미러: 리얼카밍 피지량 102.538→41.154 (change_pct -59.86 → 도출 -59.9).
dr = derive_chart({"metric": "피지량", "before": 102.538, "after": 41.154, "change_pct": -59.86})
assert dr is not None and dr["signed_change_pct"] == -59.9, "도출 변화율 -59.9"
assert ok("피지량 102.538에서 41.154로 감소", dr), "실제 fixture 끝점-범위 일치"
# 화살표 형태도 끝점-범위로 인정.
assert ok("피지량 48.2 → 31.3", d), "화살표 끝점-범위 48.2→31.3 일치"
# 정확 재현(Codex FIX NN): 끝점 순서·방향 검증.
assert not ok("피지량 31.3%에서 48.2%로 감소", d), "역순(31.3→48.2) → 불일치"
assert not ok("피지량 48.2%에서 31.3%로 증가", d), "방향어 '증가' vs 실제 감소 → 불일치"
print("ok")
PYEOF
)
check "(11) FIX MM/NN: 끝점-범위 원시값 인정 + 순서·방향 검증(역순·역방향 거부)" \
  "[ '$MM_OUT' = 'ok' ]"

# ── 12. FIX PP: 숫자 없는 단독 방향어도 evidence 방향에 결박(숫자 0개여도 모순이면 거부) ──
PP_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart, numbers_consistent
dinc = derive_chart({"metric": "수분", "before": 40, "after": 50, "change_pct": 25})   # +25 증가
ddec = derive_chart({"metric": "수분", "before": 50, "after": 40, "change_pct": -20})  # -20 감소
def ok(t, d): return numbers_consistent(t, d)[0]
# 정확 재현(Codex FIX PP):
assert not ok("수분 감소 확인", dinc), "'감소'(숫자0) vs +25 → 불일치"
assert not ok("수분 증가 확인", ddec), "'증가'(숫자0) vs -20 → 불일치"
assert ok("수분 감소 확인", ddec), "'감소'(숫자0) vs -20 → 방향 일치"
assert ok("수분 측정 완료", ddec), "방향어·숫자 없음 → 제약 없음(통과)"
# 끝점-범위 방향어는 이중 처벌 안 함(FIX NN 담당) — 정상 통과 유지.
dpc = derive_chart({"metric": "피지량", "unit": "%", "before": 48.2, "after": 31.3, "change_pct": -35.1})
assert ok("피지량 48.2%에서 31.3%로 감소", dpc), "끝점-범위 '감소' 이중처벌 없이 통과"
# '개선' 은 모호 → 방향 제약 없음.
assert ok("수분 개선 확인 20%", ddec), "'개선'(모호) → 방향 무제약"
print("ok")
PYEOF
)
check "(12) FIX PP: 숫자 없는 단독 방향어 결박('감소' vs +25 거부, '증가' vs -20 거부, 일치/무방향/끝점범위 통과)" \
  "[ '$PP_OUT' = 'ok' ]"

# ── 13. FIX QQ: metric_matches_claim 접미 '량' stem 정규화(단일 출처) — '수분량' vs '수분 개선' 인정 ──
QQ_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import metric_matches_claim as M
# 정확 재현(Codex FIX QQ):
assert M("수분량", "수분 20% 개선"), "'수분량' stem '수분' ∈ '수분 20% 개선' → 일치"
assert M("피지량", "피지 46% 감소"), "'피지량' stem '피지' → 일치"
assert M("수분량", "수분량 20% 개선"), "정확 부분문자열도 일치"
assert M("유분량", "유분 감소 확인"), "'유분량' stem '유분' → 일치"
# 과확장 금지: 다른 지표는 불일치.
assert not M("수분량", "피지량 20% 감소"), "'수분량' vs '피지량…' → 불일치(다른 지표)"
assert not M("피지량", "탄력 개선"), "'피지량' vs '탄력…' → 불일치"
# alias(같은 root)만 인정 — 다른 root alias 는 무시.
assert M("수분", "수분량 측정", aliases=["수분량"]), "alias 같은 root 인정"
assert not M("수분", "피지 감소", aliases=["피지량"]), "다른 root alias 무시"
print("ok")
PYEOF
)
check "(13) FIX QQ: metric_matches_claim 접미 '량' stem 정규화('수분량'↔'수분' 인정, 다른 지표 거부) — 단일 출처" \
  "[ '$QQ_OUT' = 'ok' ]"

# ── 14. FIX RR: p값 숫자는 측정/변화 아님 → 스킵(n_matched 미증가). 측정 수치는 그대로 결박. ──
RR_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import derive_chart, numbers_consistent as N
d = derive_chart({"metric": "수분", "before": 50, "after": 40, "change_pct": -20, "p_value": 0.05})
# 정확 재현(Codex FIX RR):
assert N("수분 20% 개선 확인(p<0.05)", d) == (True, 1), "p<0.05 스킵, 20% 변화 매칭"
assert N("20% 감소 (p<0.05)", d) == (True, 1), "콜아웃 20% 매칭 + p 스킵"
assert N("p<0.05", d) == (True, 0), "p값 단독 → 측정 수치 0개(콜아웃 바인딩은 FIX HH 가 거부)"
assert N("수분 20% 개선 (p = 0.05)", d)[0], "공백 'p = 0.05' 스킵"
assert N("수분 20% 개선 유의확률 0.05", d)[0], "'유의확률 0.05' 스킵"
assert N("수분 20% 개선 (p≤0.01)", d)[0], "'p≤0.01' 스킵"
# 비-p 일반 숫자는 여전히 결박: 0.07 은 값/변화 아님 → 불일치.
assert not N("수분 20% 개선 (0.07)", d)[0], "비-p 숫자 0.07 → 불일치(스킵 아님)"
# 실 fixture 미러(끝점-범위 + p<0.025).
dr = derive_chart({"metric": "피지량", "unit": "%", "before": 102.538, "after": 41.154, "change_pct": -59.86})
assert N("피지량 102.538에서 41.154로 감소 (p<0.025)", dr) == (True, 2), "실 fixture 끝점+p<0.025"
print("ok")
PYEOF
)
check "(14) FIX RR: p값(p<0.05·유의확률…) 스킵 + 측정 수치 결박 유지(비-p 숫자는 여전히 불일치)" \
  "[ '$RR_OUT' = 'ok' ]"

# ── 15. P-3(a안): 판정문 원문 결박 카피 zero_voc 면제(결박=면제 · 비결박/헤드라인/컨셉주축=억제 유지) ──
#   헤르메틱 런(evidence-documents.json test_report+verdict_text · claim-basis bound/unbound claims)으로
#   evaluate() 전체 경로(매니페스트→verdict_texts→claims→exempt→Engine→scan_text ⑤)를 실제로 태운다.
P3_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
BOUND            = "여드름성 피부 사용에 적합"   # VERDICT 의 부분문자열 + evidence_ref=doc-01(test_report) → 면제
UNBOUND_NOREF    = "여드름 흔적 없이 매끈"       # evidence_ref 없음 → 억제 유지
UNBOUND_NOTREPORT= "여드름 자국 관리"            # evidence_ref=doc-02(general, 비 test_report) → 억제 유지
UNBOUND_NOTSUB   = "여드름 없는 자신감"          # evidence_ref=doc-01 이나 VERDICT 부분문자열 아님 → 억제 유지
HEADLINE         = "여드름 걱정 없는 하루"        # 헤드라인(컨셉 주축) → 억제 유지
CONCEPT_AXIS     = "여드름 진정 무드 컨셉"        # visual.concept.subject(컨셉 주축) → 억제 유지

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"},
                        {"id": "doc-02", "kind": "other", "grade": "기타", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}},
      {"id": "doc-02", "filename": "g.pdf", "ext": "pdf", "bytes": 10, "sha256": "1" * 64,
       "grade": None, "linked_claim_ids": [], "reflect": True, "kind": "general",
       "reflection_points": ["일반 참조"]}],
   "source": {"channel": "bundle", "count": 2}})
W("03-storyboard/plan/01-mainPositioning.json",
  {"type": "mainPositioning", "order": 1, "headline": HEADLINE, "subcopy": "", "bodyText": [],
   "visual": {"kind": "image", "concept": {"composition": "제품 정면", "subject": CONCEPT_AXIS,
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [
       {"target_text": BOUND,             "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"},
       {"target_text": UNBOUND_NOREF,     "claim_strength": "factual", "evidence_ref": None,     "footnote_id": None},
       {"target_text": UNBOUND_NOTREPORT, "claim_strength": "factual", "evidence_ref": "doc-02", "footnote_id": None},
       {"target_text": UNBOUND_NOTSUB,    "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})

v = evaluate("p3-test", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)

errs = []
# (a) 결박 판정 카피 → zero_voc 면제(없어야 함)
if BOUND in zt:
    errs.append("(a) bound verdict-substring copy must be EXEMPT")
# (b) 비결박 3종(무ref·비 test_report·비 부분문자열) → 여전히 억제
for t, why in [(UNBOUND_NOREF, "no-ref"), (UNBOUND_NOTREPORT, "ref-not-test_report"), (UNBOUND_NOTSUB, "not-substring")]:
    if t not in zt:
        errs.append("(b) unbound[%s] must STILL be flagged" % why)
# (c) 헤드라인 · 컨셉 주축 → 여전히 억제
if HEADLINE not in zt:
    errs.append("(c) headline must STILL be flagged")
if CONCEPT_AXIS not in zt:
    errs.append("(c) concept-axis must STILL be flagged")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(15) P-3(a안): 판정문 결박 카피 zero_voc 면제 · 비결박(무ref/비test_report/비부분문자열)·헤드라인·컨셉주축 억제 유지" \
  "[ '$P3_OUT' = 'ok' ]"

# ── 16. P-3(a안 · Codex W1 누수 차단): 결박 문자열이 '동시에' 헤드라인/컨셉주축으로도 등장하면 면제에서 제외(억제 유지) ──
#   같은 target_text 가 결박 claim 이자 다른 블록의 headline/subject 로도 쓰이면(occurrence 누수 위험) → field_texts 차감으로
#   면제가 무효화돼 그 문자열은 flagged 되어야 한다(면제는 '판정 카피 1점'뿐이라는 a안 의도 정밀화).
P3LEAK_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
LEAK    = "여드름성 피부 사용에 적합"   # 결박 claim target_text 이면서 '동시에' 다른 블록 headline 으로도 사용

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
# 블록1: LEAK 을 결박 claim 으로 사용. 블록2: 같은 LEAK 을 headline(컨셉 주축)으로 사용 → 면제 누수 시도.
W("03-storyboard/plan/01-mainPositioning.json",
  {"type": "mainPositioning", "order": 1, "headline": "무난한 헤드라인", "subcopy": "", "bodyText": [],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": LEAK, "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})
W("03-storyboard/plan/02-socialProof.json",
  {"type": "socialProof", "order": 2, "headline": LEAK, "subcopy": "", "bodyText": [],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/y.jpg"}}},
   "claims": [], "footnotes": [], "approval_state": "draft"})

v = evaluate("p3-leak", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
# LEAK 이 headline 으로도 등장했으므로 면제 무효 → flagged 되어야 한다.
print("ok" if LEAK in zt else "FAIL: bound text reused as headline must NOT be exempt (leak)")
PYEOF
)
check "(16) P-3 누수 차단: 결박 문자열이 헤드라인으로도 등장 시 면제 제외(억제) — occurrence 누수 방지" \
  "[ '$P3LEAK_OUT' = 'ok' ]"

# ── 17. P-3(a안 · Codex W1b P1): 판정문이 '본문(bodyText) + 맥락'으로 렌더된 실제 형태도 면제(판정문 ⊆ 본문) ──
#   실 렌더는 claim target_text(판정문 부분문자열)가 아니라 '판정문 원문 + 기관·n·기간·디스클레이머'가 bodyText 로 나간다.
#   이 긴 본문은 target_text 와 정확일치하지 않으므로 exact-match 면제로는 놓쳐 zero_voc(여드름)에 걸렸다(P1). 겹침 면제로 해소.
P3BODY_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
# 본문 = 판정문 원문 + 맥락(판정문 ⊆ 본문). 헤드라인은 판정문과 무관한 훅.
BODY    = VERDICT + " (가나다연구소, n=30, 4주) 개인에 따라 차이가 있을 수 있습니다"
HOOKHEAD= "산뜻한 매일의 피부 케어"

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("03-storyboard/plan/01-clinicalEvidence.json",
  {"type": "clinicalEvidence", "order": 1, "headline": HOOKHEAD, "subcopy": "",
   "bodyText": [BODY],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": "여드름성 피부 사용에 적합", "claim_strength": "factual",
               "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01] 가나다연구소 n=30 4주"}], "approval_state": "draft"})

v = evaluate("p3-body", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
# 본문(판정문+맥락)은 면제되어야 함(zero_voc 미발동). 훅 헤드라인엔 여드름 없음 → 무관.
print("ok" if BODY not in zt else "FAIL: verdict rendered as bodyText+context must be EXEMPT (Codex W1b P1)")
PYEOF
)
check "(17) P-3(a안 W1b): 판정문+맥락 본문 렌더도 면제(판정문 ⊆ 본문) — 실 렌더 형태 P1 해소" \
  "[ '$P3BODY_OUT' = 'ok' ]"

# ── 18. P-3(a안 · Codex W1c a): 결박 요구 — evidence_ref 없는(결박 없는) 블록의 판정문-부분문자열 카피는 면제 안 함(억제) ──
#   판정문 텍스트가 매니페스트에 존재해도, 그 카피가 든 블록에 'evidence_ref→그 판정문 결박 claim'이 없으면 면제 불가.
P3BIND_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
UNBOUND = "여드름성 피부 사용에 적합"   # 판정문 부분문자열이지만 이 블록엔 결박 claim 없음(evidence_ref=None)

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
# 블록에 결박 claim 이 전혀 없음(claim evidence_ref=None) → 판정문 부분문자열 카피여도 면제 불가.
W("03-storyboard/plan/01-mainPositioning.json",
  {"type": "mainPositioning", "order": 1, "headline": "무난한 헤드라인", "subcopy": "", "bodyText": [UNBOUND],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": UNBOUND, "claim_strength": "factual", "evidence_ref": None, "footnote_id": None}],
   "footnotes": [], "approval_state": "draft"})

v = evaluate("p3-bind", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
print("ok" if UNBOUND in zt else "FAIL: unbound verdict-substring (no evidence_ref) must NOT be exempt (binding required)")
PYEOF
)
check "(18) P-3(a안 W1c a): 결박(evidence_ref) 없는 판정문 부분문자열 카피 → 면제 안 함(억제)" \
  "[ '$P3BIND_OUT' = 'ok' ]"

# ── 19. P-3(a안 · Codex W1c b): 04-keyvisual — heading(h1)=훅=억제 · 비-heading 본문(런-결박 판정문 겹침)=면제 ──
P3KV_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
HEAD    = "여드름성 피부 사용에 적합"           # <h1> → 훅 → 억제
BODY    = VERDICT + " (가나다연구소 n=30 4주)"  # <p> 비-heading, 판정문 ⊆ 본문 → 면제

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "04-keyvisual", "options", "A"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "04-keyvisual",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("04-keyvisual/decision.json", {"selected": "A"})
with open(os.path.join(rdir, "04-keyvisual/options/A/index.html"), "w", encoding="utf-8") as fh:
    fh.write("<html><body><h1>%s</h1><p>%s</p></body></html>" % (HEAD, BODY))

v = evaluate("p3-kv", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
errs = []
if HEAD not in zt:
    errs.append("keyvisual <h1> verdict heading must be FLAGGED (hook, not exempt)")
if BODY in zt:
    errs.append("keyvisual <p> verdict body (run-bound overlap) must be EXEMPT")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(19) P-3(a안 W1c b): 키비주얼 heading=훅 억제 · 비-heading 본문=런-결박 판정문 겹침 면제" \
  "[ '$P3KV_OUT' = 'ok' ]"

# ── 20. P-3(a안 · Codex 4R b): 판정문 문자열이 '결박 없는 다른 블록'의 본문에도 등장하면 면제 제외(블록-스코프 보수화) ──
#   블록1은 결박(evidence_ref→판정문)으로 그 카피를 실었지만, 블록2가 같은 문자열을 결박 없이 본문에 반복 → 면제 무효화(억제).
P3UB_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
PHRASE  = "여드름성 피부 사용에 적합"   # 블록1=결박 claim target · 블록2=비결박 본문 반복

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
# 블록1: 결박(evidence_ref=doc-01) claim 으로 PHRASE 를 실음.
W("03-storyboard/plan/01-clinicalEvidence.json",
  {"type": "clinicalEvidence", "order": 1, "headline": "임상 결과", "subcopy": "", "bodyText": [],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": PHRASE, "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})
# 블록2: 결박 없이 같은 PHRASE 를 본문에 반복(누수 시도).
W("03-storyboard/plan/02-socialProof.json",
  {"type": "socialProof", "order": 2, "headline": "후기", "subcopy": "", "bodyText": [PHRASE],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/y.jpg"}}},
   "claims": [], "footnotes": [], "approval_state": "draft"})

v = evaluate("p3-ub", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
# PHRASE 가 결박 없는 블록2 본문에도 있으므로 면제 무효 → flagged 되어야 한다(per-string 누수 차단).
print("ok" if PHRASE in zt else "FAIL: phrase repeated in an unbound block must NOT be exempt (Codex 4R b)")
PYEOF
)
check "(20) P-3(a안 4R b): 비결박 블록의 판정문 반복 → 면제 제외(블록-스코프 누수 차단)" \
  "[ '$P3UB_OUT' = 'ok' ]"

# ── 21. P-3(a안 · Codex 5R): 판정문 문단에 효능어 끼워넣기(판정문+여드름 완치) → 그 본문은 면제 안 함(스머글링 차단) ──
#   순수 판정문 부분문자열 카피(claim target)는 면제, 하지만 '판정문 뺀 나머지'에 zero_voc 효능어가 붙은 본문은 면제 제외.
P3SMUG_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
PURE    = "여드름성 피부 사용에 적합"        # claim target ⊆ 판정문 → 면제
SMUGGLE = VERDICT + " 여드름 완치"           # 판정문 ⊆ 본문 이지만 나머지에 효능어('여드름')→ 면제 안 함

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("03-storyboard/plan/01-clinicalEvidence.json",
  {"type": "clinicalEvidence", "order": 1, "headline": "임상 결과", "subcopy": "",
   "bodyText": [SMUGGLE],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": PURE, "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})

v = evaluate("p3-smug", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
errs = []
if SMUGGLE not in zt:
    errs.append("verdict paragraph with appended efficacy word must be FLAGGED (no smuggle)")
if PURE in zt:
    errs.append("pure verdict substring claim must be EXEMPT")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(21) P-3(a안 5R): 판정문+효능어 본문=면제 제외(스머글링 차단) · 순수 판정문 카피=면제" \
  "[ '$P3SMUG_OUT' = 'ok' ]"

# ── 22. P-3(a안 · Codex 6R): 난독화 효능어(공백 삽입 '여 드름')도 면제 나머지 검사에서 _match 로 잡아 면제 제외 ──
#   remainder 검사가 scan_text 와 같은 정규화(_match: spaceless)를 써야 '판정문 + 여 드름 완치' 난독화가 면제로 새지 않는다.
P3OBF_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
OBF     = VERDICT + " 여 드름 완치"   # 판정문 + 공백 난독화 효능어 → 면제 제외되어야(억제)

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("03-storyboard/plan/01-clinicalEvidence.json",
  {"type": "clinicalEvidence", "order": 1, "headline": "임상 결과", "subcopy": "",
   "bodyText": [OBF],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": "여드름성 피부 사용에 적합", "claim_strength": "factual",
               "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})

v = evaluate("p3-obf", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
print("ok" if OBF in zt else "FAIL: obfuscated efficacy in verdict paragraph must be FLAGGED (Codex 6R)")
PYEOF
)
check "(22) P-3(a안 6R): 난독화 효능어(여 드름) 판정문 문단 → 면제 제외(_match 정규화 일치)" \
  "[ '$P3OBF_OUT' = 'ok' ]"

# ── 23. P-3(a안 · Codex 7R): 키비주얼 비-heading prominent 서브카피(<p class="sub">)의 '짧은 판정문 조각'도 면제 제외 ──
#   클래스명 비결정적 → require_full(판정문 전문+맥락 본문만 면제)로 짧은 판정문 훅 조각을 클래스 무관하게 억제.
#   대조: 같은 옵션의 <p class="body">판정문 전문+맥락</p> 은 면제(정상 임상 캡션).
P3KVSUB_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
SUBHOOK = "여드름성 피부 사용에 적합"           # <p class="sub"> 짧은 판정문 조각(prominent 훅) → 면제 제외
BODYCAP = VERDICT + " (가나다연구소 n=30 4주)"  # <p class="body"> 판정문 전문+맥락 → 면제

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "04-keyvisual", "options", "A"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "04-keyvisual",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("04-keyvisual/decision.json", {"selected": "A"})
with open(os.path.join(rdir, "04-keyvisual/options/A/index.html"), "w", encoding="utf-8") as fh:
    fh.write('<html><body><p class="sub">%s</p><p class="body">%s</p></body></html>' % (SUBHOOK, BODYCAP))

v = evaluate("p3-kvsub", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
errs = []
if SUBHOOK not in zt:
    errs.append("keyvisual prominent subcopy short verdict phrase must be FLAGGED (Codex 7R)")
if BODYCAP in zt:
    errs.append("keyvisual body verdict+context must be EXEMPT")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(23) P-3(a안 7R): 키비주얼 서브카피 짧은 판정문 조각=면제 제외 · 본문 전문+맥락=면제(require_full)" \
  "[ '$P3KVSUB_OUT' = 'ok' ]"

# ── 24. P-3(a안 · Codex 8R): 키비주얼 heading 의 '속성'(aria-label/title/alt/data-*)에 실린 판정문+맥락도 hook → 면제 제외 ──
#   heading 안(자신의 속성 포함) 노출 텍스트는 require_full 을 만족(판정문 ⊆ 속성)해도 hook 이라 억제(속성 우회 차단).
P3KVATTR_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
HEADATTR= VERDICT + " (가나다연구소 n=30 4주)"  # <h1 aria-label="..."> — 판정문 전문+맥락(require_full 만족)이나 heading 속성=hook
BODYCAP = VERDICT + " (임상 캡션 n=30 4주)"       # <p class="body"> — 정상 본문 면제(대조)

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "04-keyvisual", "options", "A"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "04-keyvisual",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("04-keyvisual/decision.json", {"selected": "A"})
with open(os.path.join(rdir, "04-keyvisual/options/A/index.html"), "w", encoding="utf-8") as fh:
    fh.write('<html><body><h1 aria-label="%s">타이틀</h1><p class="body">%s</p></body></html>' % (HEADATTR, BODYCAP))

v = evaluate("p3-kvattr", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
errs = []
if HEADATTR not in zt:
    errs.append("heading aria-label verdict must be FLAGGED (heading attr = hook, Codex 8R)")
if BODYCAP in zt:
    errs.append("body verdict+context must be EXEMPT")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(24) P-3(a안 8R): 키비주얼 heading 속성(aria-label) 판정문=hook 억제 · 본문=면제(속성 우회 차단)" \
  "[ '$P3KVATTR_OUT' = 'ok' ]"

# ── 25. P-3(a안 · Codex 9R): 키비주얼 본문 판정문이 인라인 마크업(<strong>)으로 쪼개져도 문단 집계로 면제(오차단 방지) ──
#   <p>여드름성 피부 <strong>사용에 적합하며…</strong></p> → 노드가 나뉘어도 문단 집계가 판정문 전문을 포함 → 구성 노드 전부 면제.
P3KVINL_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
N1 = "여드름성 피부 "                                       # 인라인 분할 앞 노드(여드름 포함) — 단독으론 판정문 미완
N2 = "사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨 (가나다연구소 n=30 4주)"  # 뒷 노드(strong)

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "04-keyvisual", "options", "A"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "04-keyvisual",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("04-keyvisual/decision.json", {"selected": "A"})
with open(os.path.join(rdir, "04-keyvisual/options/A/index.html"), "w", encoding="utf-8") as fh:
    fh.write('<html><body><p>%s<strong>%s</strong></p></body></html>' % (N1, N2))

v = evaluate("p3-kvinl", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
# 인라인 분할 앞 노드('여드름성 피부')가 문단 집계 면제로 억제되지 않아야(오차단 방지). zero_voc 위반 0.
print("ok" if not zt else "FAIL: inline-split body verdict must be EXEMPT at paragraph level (Codex 9R); flagged=%r" % zt)
PYEOF
)
check "(25) P-3(a안 9R): 인라인 마크업 분할 본문 판정문 → 문단 집계 면제(오차단 방지)" \
  "[ '$P3KVINL_OUT' = 'ok' ]"

# ── 26. P-3(a안 · Codex 11R): bare 효능어 토큰(target_text:"여드름")만 결박 → 면제 안 함(부분문자열이라도 문맥 부족) ──
#   판정 카피 전체가 아니라 효능어 하나만 결박해 그 bare 어휘를 통과시키는 우회 차단. 실제 판정 문구는 여전히 면제(대조).
P3BARE_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
BARE    = "여드름"                       # 효능어 토큰(판정문 부분문자열) — 결박해도 면제 안 됨(문맥 부족)
PHRASE  = "여드름성 피부 사용에 적합"    # 실제 판정 카피(문맥 충분) — 면제(대조)

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "03-storyboard", "plan"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "03-storyboard", "storyboard_substage": "plan",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
# 블록1: bare 효능어만 결박(우회 시도). 블록2: 실제 판정 문구 결박(정상 면제 대조).
W("03-storyboard/plan/01-a.json",
  {"type": "mainPositioning", "order": 1, "headline": "무난", "subcopy": "", "bodyText": [BARE],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/x.jpg"}}},
   "claims": [{"target_text": BARE, "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f1"}],
   "footnotes": [{"id": "f1", "text": "[doc-01]"}], "approval_state": "draft"})
W("03-storyboard/plan/02-b.json",
  {"type": "clinicalEvidence", "order": 2, "headline": "임상", "subcopy": "", "bodyText": [PHRASE],
   "visual": {"kind": "image", "concept": {"composition": "정면", "subject": "무드",
                                           "reference": {"own_asset_path": "inputs/assets/y.jpg"}}},
   "claims": [{"target_text": PHRASE, "claim_strength": "factual", "evidence_ref": "doc-01", "footnote_id": "f2"}],
   "footnotes": [{"id": "f2", "text": "[doc-01]"}], "approval_state": "draft"})

v = evaluate("p3-bare", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
errs = []
if BARE not in zt:
    errs.append("bare efficacy token binding must NOT be exempt (Codex 11R)")
if PHRASE in zt:
    errs.append("real verdict phrase must still be EXEMPT")
print("ok" if not errs else "FAIL: " + " | ".join(errs))
PYEOF
)
check "(26) P-3(a안 11R): bare 효능어 토큰 결박=면제 제외(문맥 부족) · 실제 판정 문구=면제" \
  "[ '$P3BARE_OUT' = 'ok' ]"

# ── 27. P-3(a안 · Codex 12R): 키비주얼 짧은 훅 문단에도 등장하는 문자열은 면제 취소(occurrence 누수 대칭 차단) ──
#   <p class="sub">짧은판정문구</p> (면제 미자격 훅) + <p>짧은판정문구<strong>…맥락</strong></p> (인라인 본문) →
#   같은 문자열이 훅 문단에도 있으므로 면제 취소 → 훅의 짧은 판정 조각이 리뷰0 우회로 새지 않음.
P3KVOCC_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os, json, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

VERDICT = "여드름성 피부 사용에 적합하며 피부 진정에 도움을 주는 것으로 판단됨"
SHORT   = "여드름성 피부 사용에 적합"   # 훅 문단 + 인라인 본문 앞노드 양쪽에 등장
TAIL    = "하며 피부 진정에 도움을 주는 것으로 판단됨 (가나다연구소 n=30 4주)"

rdir = tempfile.mkdtemp()
os.makedirs(os.path.join(rdir, "00-ingest"))
os.makedirs(os.path.join(rdir, "04-keyvisual", "options", "A"))
def W(rel, obj):
    with open(os.path.join(rdir, rel), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)

W("state.json", {"phase": "04-keyvisual",
                 "product": {"regulatory_domain": "cosmetic", "name": "테스트제품",
                             "deliverable_format": "multipage_bm"}})
W("00-ingest/claim-basis.json",
  {"functional_status": {}, "notified_ingredients": [], "certifications": [],
   "product_type": "cosmetic", "unsupported_claims": [],
   "source": {"from": "wb", "extracted_by": "stub"},
   "evidence_on_file": [{"id": "doc-01", "kind": "clinical_trial", "grade": "인체적용시험", "source": "x"}]})
W("00-ingest/voc.json", {"keyword_frequency": {"여드름": 0}})
W("00-ingest/evidence-documents.json",
  {"documents": [
      {"id": "doc-01", "filename": "r.pdf", "ext": "pdf", "bytes": 10, "sha256": "0" * 64,
       "grade": "인체적용시험", "linked_claim_ids": [], "reflect": True, "kind": "test_report",
       "claim": "적합", "verdict_text": VERDICT,
       "test_report": {"institution": "가나다연구소", "sample_size": 30, "duration": "4주"}}],
   "source": {"channel": "bundle", "count": 1}})
W("04-keyvisual/decision.json", {"selected": "A"})
with open(os.path.join(rdir, "04-keyvisual/options/A/index.html"), "w", encoding="utf-8") as fh:
    # 훅 문단(짧은 판정 조각) + 인라인 분할 본문(앞노드가 동일 SHORT 문자열)
    fh.write('<html><body><p class="sub">%s</p><p>%s<strong>%s</strong></p></body></html>' % (SHORT, SHORT, TAIL))

v = evaluate("p3-kvocc", rdir, None, "ruleset")
ZRULE = "리뷰 0건 개념(소비자 수요 근거 없음) — 컨셉 주축 금지"
zt = {vio["target_text"] for vio in v["violations"]
      if vio["axis"] == "consumer_deception" and vio["rule"] == ZRULE}
shutil.rmtree(rdir, ignore_errors=True)
# SHORT 가 훅 문단에도 있으므로 면제 취소 → flagged 되어야(누수 차단).
print("ok" if SHORT in zt else "FAIL: string appearing in a short hook paragraph must NOT be exempt (Codex 12R)")
PYEOF
)
check "(27) P-3(a안 12R): 키비주얼 짧은 훅 문단 동일 문자열=면제 취소(occurrence 누수 대칭 차단)" \
  "[ '$P3KVOCC_OUT' = 'ok' ]"

echo "test-clinical-engine: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
