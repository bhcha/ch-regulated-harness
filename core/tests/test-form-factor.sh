#!/usr/bin/env bash
# test-form-factor.sh — F2 제형 고정(form_factor) 회귀 가드. 오프라인 hermetic(무네트워크).
#   대상: scripts/lib/form_factor.py(순수 산출) + image_engine.build_prompt(제형 문구 주입) +
#         generate_all(stub 골든 불변).
#   단정:
#     (1) resolve_form_factor 결정성(같은 입력 2회 → 동일) + 팩 표 first-match + 폴백(product_type 축자)·None
#     (2) build_prompt(form_factor) → 형태 명사구 포함 AND 무텍스트 계약("no new text") 여전히 포함
#         + form_factor=None 이면 프롬프트 바이트 불변(기존 동작 보존)
#     (3) stub generate_all → 이미지-매니페스트 바이트 불변(no-churn 골든 가드; 결정성 + 제형문구 미누출)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## F2 제형 고정(form_factor) — 산출 결정성 + 프롬프트 주입 + stub 골든 불변"

RIDS="ci-ff-b1 ci-ff-b2 ci-ff-s1 ci-ff-s2"
cleanup() { for r in $RIDS; do rm -rf "$ROOT/runs/$r" 2>/dev/null || true; done; }
trap cleanup EXIT

seed_kv() {  # seed_kv <rid>  (keyvisual-in = cosmetic, claim-basis product_type="색조화장품(쿠션 파운데이션)")
  rm -rf "$ROOT/runs/$1"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$ROOT/runs/$1"
}

# ── (1) resolve_form_factor: 결정성 + first-match + 폴백 + None ──
seed_kv ci-ff-b1
U1="$( cd "$ROOT" && python3 - ci-ff-b1 <<'PY'
import sys, os
rid = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
from form_factor import resolve_form_factor
rdir = os.path.join("runs", rid)
errs = []
def ok(c, l):
    if not c: errs.append(l)
# 결정성: 같은 입력 2회 → 동일
a = resolve_form_factor(rdir, "cosmetic")
b = resolve_form_factor(rdir, "cosmetic")
ok(a == b, "not deterministic: %r vs %r" % (a, b))
# 팩 표 first-match: product_type "…쿠션 파운데이션" → 쿠션 엔트리(우선순위상 파운데이션보다 앞)
ok(a is not None and "쿠션 콤팩트" in a, "cosmetic first-match not 쿠션: %r" % a)
# 도메인 표 미매칭(drug 표엔 쿠션 없음) → product_type 축자 폴백(사람 선언, grounded)
d = resolve_form_factor(rdir, "drug")
ok(d == "색조화장품(쿠션 파운데이션)", "drug fallback not verbatim product_type: %r" % d)
# 도메인 None → 표 없음 → product_type 축자 폴백
n = resolve_form_factor(rdir, None)
ok(n == "색조화장품(쿠션 파운데이션)", "None-domain fallback not verbatim: %r" % n)
# claim-basis/voc 둘 다 없음 → None(주입 없음, 절대 지어내지 않음)
import tempfile
empty = tempfile.mkdtemp()
ok(resolve_form_factor(empty, "cosmetic") is None, "empty rdir not None")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(1) resolve_form_factor 결정성·first-match·폴백·None" "echo \"\$U1\" | grep -q PYOK"
echo "$U1" | grep -q PYFAIL && echo "    └ (1 진단) $U1"

# ── (2) build_prompt(form_factor): 형태 명사구 + 무텍스트 계약 동시 존재 + None 바이트 불변 ──
U2="$( cd "$ROOT" && python3 - <<'PY'
import sys, os
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
from image_engine import build_prompt
concept = {"subject": "제품컷", "composition": "중앙 정렬", "palette": ["#EEE"],
           "aspect_ratio": "1:1", "mood": {}, "reference": {}}
FF = "하이드로콜로이드 패치(피부에 붙이는 얇고 둥근 반투명 시트, 개별 포장)"
CONTRACT = "no new text"   # 사진형 무텍스트 계약(~195-198)의 영문 앵커
errs = []
def ok(c, l):
    if not c: errs.append(l)
# 사진형 + form_factor: 형태 명사구 포함 AND 무텍스트 계약 여전히 포함(계약 약화 금지)
p = build_prompt(concept, form_factor=FF)["prompt"]
ok(FF in p, "form nouns absent in photo prompt")
ok(CONTRACT in p, "no-new-text contract weakened/absent in photo prompt")
ok("치환하지 마라" in p, "form-lock clause absent")
# form_factor=None → 기존 동작(바이트 불변): form_factor 미지정과 명시 None 동일 + 제형 문구 미포함
p_none = build_prompt(concept)["prompt"]
p_expl_none = build_prompt(concept, form_factor=None)["prompt"]
ok(p_none == p_expl_none, "None vs default drift")
ok("제품 형태:" not in p_none, "form line leaked when form_factor None")
ok(p_none != p, "form_factor truthy did not change prompt")
# 그래픽 분기도 form_factor 주입(공통)
pg = build_prompt(concept, graphic=True, form_factor=FF)["prompt"]
ok(FF in pg, "form nouns absent in graphic prompt")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(2) build_prompt: 형태 명사구+무텍스트 계약 동시 + None 바이트 불변" "echo \"\$U2\" | grep -q PYOK"
echo "$U2" | grep -q PYFAIL && echo "    └ (2 진단) $U2"

# ── (3) stub generate_all: 이미지-매니페스트 바이트 불변(no-churn 골든 가드) ──
#   핵심: form_factor 가 resolve 되는 fixture 라도 stub 경로는 build_prompt/build_context 미호출 → 매니페스트 불변.
seed_kv ci-ff-s1
seed_kv ci-ff-s2
( cd "$ROOT" && python3 scripts/lib/image_engine.py ci-ff-s1 "$ROOT/runs/ci-ff-s1" --engine stub ) >/dev/null 2>&1
( cd "$ROOT" && python3 scripts/lib/image_engine.py ci-ff-s2 "$ROOT/runs/ci-ff-s2" --engine stub ) >/dev/null 2>&1
MAN1="$ROOT/runs/ci-ff-s1/04-keyvisual/image-manifest.json"
MAN2="$ROOT/runs/ci-ff-s2/04-keyvisual/image-manifest.json"
check "(3) stub 매니페스트 생성됨" "[ -f \"$MAN1\" ] && [ -f \"$MAN2\" ]"
# baseline 비교: 두 독립 stub 런 바이트 동일(결정성 = 골든 불변의 필요조건).
check "(3) stub 매니페스트 바이트 동일(결정성·no-churn baseline)" "cmp -s \"$MAN1\" \"$MAN2\""
# 제형 문구가 stub 매니페스트로 누출되지 않았는지(build_prompt 미경유 증명).
check "(3) stub 매니페스트에 제형 문구 미누출" "! grep -q '제품 형태\|쿠션 콤팩트' \"$MAN1\""
# 골든 사실(pre-change baseline): engine=stub · model 키 없음 · 13자산 전부 fallback_stub.
U3="$( python3 - "$MAN1" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
errs = []
def ok(c, l):
    if not c: errs.append(l)
ok(m.get("engine") == "stub", "engine != stub: %r" % m.get("engine"))
ok("model" not in m, "stub manifest leaked model key")
assets = m.get("assets", [])
ok(len(assets) == 13, "asset count != 13 (stub golden): %d" % len(assets))
ok(all(a.get("status") == "fallback_stub" for a in assets), "not all fallback_stub")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(3) stub 매니페스트 골든 사실(engine=stub·no model·13 fallback_stub)" "echo \"\$U3\" | grep -q PYOK"
echo "$U3" | grep -q PYFAIL && echo "    └ (3 진단) $U3"
# form_factor 가 실제로 resolve 되는 fixture 임을 확인(가드가 유의미 — 그런데도 stub 은 위처럼 clean).
FFCHK="$( cd "$ROOT" && python3 -c "
import sys, os; sys.path.insert(0, os.path.join(os.getcwd(),'scripts','lib'))
from form_factor import resolve_form_factor
print('YES' if resolve_form_factor(os.path.join('runs','ci-ff-s1'),'cosmetic') else 'NO')" )"
check "(3) 가드 유의미성: 이 fixture 는 form_factor 가 resolve 됨(그럼에도 stub 불변)" "[ \"$FFCHK\" = YES ]"

printf '\n[form-factor] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
