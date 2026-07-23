#!/usr/bin/env bash
# test-examples-analysis.sh — examples_analysis.py reference_images 메인이미지 폴백(M-3).
#   결함: _reference_images 가 images/detail 만 매핑 → detail 없는 크롤(images/main 만)은 빈 리스트를
#         산출 → validate-stage:304 무조건-비어있지않음 가드에 스스로 거부(stand-in 자기검증 실패).
#   수정: detail 부재 시 images/main 으로 폴백해 ≥1건 생성(크롤 실이미지 기반, 우회 아님).
#   - detail 보유 크롤 → 기존 경로(src=images/detail/…) 무변경(골든 불변).
#   - detail·main 둘 다 없는 크롤 → 여전히 빈 리스트(정당 — 불완전 크롤, validate 가 거부하는 게 맞음).
#   오프라인 결정적(Date/random 미사용).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## test-examples-analysis — reference_images 메인이미지 폴백(M-3)"

FX="$(mktemp -d)"
trap 'rm -rf "$FX"' EXIT

# ── 공용 크롤 부속(product.json·reviews.csv) 생성 ──
mk_common() {  # mk_common <dir>
  local d="$1"; mkdir -p "$d"
  cat > "$d/product.json" <<'JSON'
{"site":"coupang","productId":"6484363424","name":"테스트 스팟패치","rating":5,"collectedReviewCount":2,"price":{"current":9900,"original":13200,"discountRate":25}}
JSON
  cat > "$d/reviews.csv" <<'CSV'
reviewId,date,score,content,hasPhoto,repurchase
1,2026-01-01,5,촉촉하고 발림성 좋아요 재구매 의사 있어요,Y,Y
2,2026-01-02,5,흡수 빠르고 자극 없이 순해요,N,N
CSV
}

# 1) detail 없는 크롤(images/main 만)
MAIN_ONLY="$FX/main-only-crawl"; mk_common "$MAIN_ONLY"
mkdir -p "$MAIN_ONLY/images/main"
for f in 001.jpg 002.jpg 003.jpg; do : > "$MAIN_ONLY/images/main/$f"; done

# 2) detail 보유 크롤(detail + main 둘 다) → 폴백 미발동, 기존(detail) 형식 유지
DETAIL="$FX/detail-crawl"; mk_common "$DETAIL"
mkdir -p "$DETAIL/images/detail" "$DETAIL/images/main"
for f in 001.jpg 002.jpg; do : > "$DETAIL/images/detail/$f"; done
: > "$DETAIL/images/main/001.jpg"

# 3) detail·main 둘 다 없는 크롤(images/ 만) → 빈 리스트(정당)
EMPTY="$FX/empty-crawl"; mk_common "$EMPTY"
mkdir -p "$EMPTY/images"

# ── validate-stage.sh ⓐ~ⓓ 를 실제 examples_analysis import 로 재현하는 헬퍼 ──
HELP="$FX/check_example.py"
cat > "$HELP" <<'PY'
import sys, os, re, json
root, ex_dir, domain, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from examples_analysis import analyze_example, ALLOWED_COMPOSITION_TAGS, ALLOWED_MOOD_TAGS, why_violations

a = analyze_example(ex_dir, domain)
ri = a.get("reference_images") or []
eid = a.get("example_id") or ""

def validate_ri(ri, eid, domain):
    """validate-stage.sh:292-319 ⓐ~ⓓ 를 그대로 재현(실제 심의 가드 형식 검증)."""
    NN = re.compile(r"^.+#[0-9]{2,}$")
    if not ri:                                                            # ⓐ 무조건 비어있지 않음
        return False
    seen = set()
    for r in ri:
        comp = r.get("composition_tags") or []
        mood = r.get("mood_tags") or []
        why = (r.get("why") or "").strip()
        if not comp or not mood or not why:
            return False
        if any(t not in ALLOWED_COMPOSITION_TAGS for t in comp):          # ⓑ 구도 화이트리스트
            return False
        if any(t not in ALLOWED_MOOD_TAGS for t in mood):                 # ⓑ 무드 화이트리스트
            return False
        if why_violations(" ".join(comp) + " " + " ".join(mood) + " " + why, domain):   # ⓑ 효능·절대·랭킹어 0
            return False
        if not any(t in why for t in comp) or not any(t in why for t in mood):          # ⓑ why 자기 태그 인용
            return False
        rid = r.get("id") or ""
        if not NN.match(rid) or not rid.startswith(eid + "#"):            # ⓒ '<eid>#NN'
            return False
        if rid in seen:                                                   # ⓒ 전역 유일
            return False
        seen.add(rid)
        src = r.get("src") or ""
        if not src or src.startswith("inputs/assets/"):                   # ⓓ 디자인 자산 아님(저작권)
            return False
    return True

if mode == "empty":
    # 빈 리스트 여야 하고, validate 가드가 '거부'(정당)해야 한다.
    sys.exit(0 if (ri == [] and not validate_ri(ri, eid, domain)) else 1)
if not validate_ri(ri, eid, domain):
    sys.exit(1)
if mode == "main-src":
    sys.exit(0 if all((r.get("src") or "").startswith("images/main/") for r in ri) else 1)
if mode == "detail-src":
    sys.exit(0 if all((r.get("src") or "").startswith("images/detail/") for r in ri) else 1)
sys.exit(0)
PY

# ── 카운트/스키마 검사 헬퍼 ──
ri_count() {  # ri_count <ex_dir> <domain>
  python3 -c "
import sys,os; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import analyze_example
print(len(analyze_example('$1','$2').get('reference_images') or []))"
}
schema_ok() {  # schema_ok <ex_dir> <domain>
  local out="$FX/_ea.json"
  python3 -c "
import sys,os; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import analyze_example
from harness import atomic_write_json
atomic_write_json('$out', analyze_example('$1','$2'))" >/dev/null 2>&1 || return 1
  python3 "$ROOT/scripts/lib/harness.py" validate "$out" --schema example-analysis.schema.json >/dev/null 2>&1
}

# ────────── 1) detail 없는 크롤 → main 폴백 ──────────
MO_CNT="$(ri_count "$MAIN_ONLY" cosmetic)"
check "(mo-1) detail 없는 크롤 → reference_images ≥1 (실측 $MO_CNT)" "[ \"$MO_CNT\" -ge 1 ]"
check "(mo-2) main 폴백 항목이 validate ⓐ~ⓓ 통과 + src=images/main/" \
  "python3 '$HELP' '$ROOT' '$MAIN_ONLY' cosmetic main-src"
check "(mo-3) main 폴백 산출물 example-analysis 스키마 통과" "schema_ok '$MAIN_ONLY' cosmetic"
# main 3장 → 캐논 블록 앞 3개(hero/problem/solution)로 1:1 매핑
check "(mo-4) main 장수만큼 매핑(3장 → 3항목)" "[ \"$MO_CNT\" = '3' ]"
# 도메인 무관 안전(drug 도메인에서도 폴백 문구가 최상급·효능어 0)
check "(mo-5) drug 도메인에서도 폴백 항목 validate 통과(문구 최상급·효능어 0)" \
  "python3 '$HELP' '$ROOT' '$MAIN_ONLY' drug main-src"

# ────────── 2) detail 보유 크롤 → 폴백 미발동(기존 형식 유지) ──────────
DT_CNT="$(ri_count "$DETAIL" cosmetic)"
check "(dt-1) detail 보유 크롤 → reference_images ≥1 (실측 $DT_CNT)" "[ \"$DT_CNT\" -ge 1 ]"
check "(dt-2) detail 경로 유지(src=images/detail/) — main 폴백 미발동" \
  "python3 '$HELP' '$ROOT' '$DETAIL' cosmetic detail-src"
check "(dt-3) detail 2장 → 2항목(detail_image_count 기준)" "[ \"$DT_CNT\" = '2' ]"
# main 이미지가 함께 있어도 detail 우선(폴백은 detail 이 빌 때만) — src 에 images/main 미등장
MAIN_LEAK="$(python3 -c "
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import analyze_example
ri=analyze_example('$DETAIL','cosmetic').get('reference_images') or []
print(any((r.get('src') or '').startswith('images/main/') for r in ri))")"
check "(dt-4) main 이미지 존재해도 detail 우선(src 에 images/main 미등장)" "[ \"$MAIN_LEAK\" = 'False' ]"

# ────────── 3) detail·main 둘 다 없는 크롤 → 빈 리스트(정당) ──────────
EM_CNT="$(ri_count "$EMPTY" cosmetic)"
check "(em-1) detail·main 둘 다 없는 크롤 → 빈 리스트(폴백 안 함)" "[ \"$EM_CNT\" = '0' ]"
check "(em-2) 빈 리스트는 validate 가드가 거부(정당 — 불완전 크롤)" \
  "python3 '$HELP' '$ROOT' '$EMPTY' cosmetic empty"

# ────────── 4) 결정성(오프라인, 2회 동일) ──────────
DET_OK="$(python3 -c "
import json,sys; sys.path.insert(0,'$ROOT/scripts/lib')
from examples_analysis import analyze_example
a=json.dumps(analyze_example('$MAIN_ONLY','cosmetic'),sort_keys=True,ensure_ascii=False)
b=json.dumps(analyze_example('$MAIN_ONLY','cosmetic'),sort_keys=True,ensure_ascii=False)
print(a==b)")"
check "(det) main 폴백 결정적(2회 동일 산출)" "[ \"$DET_OK\" = 'True' ]"

echo "test-examples-analysis: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
