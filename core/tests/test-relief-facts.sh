#!/usr/bin/env bash
# test-relief-facts.sh — 이지덤 뷰티 릴리프 WB 사실 추출 검증 (WS1·WS2·WS3·WS4).
#   - offer(가격·할인율): product.json price 객체 추출
#   - product_facts(key_ingredients·components): WB 텍스트 결정적 추출
#   - WS1: 임상 개선 표지(유분량/피지량/논코메도제닉) → 인접 evidence 추가 추출
#   - 결정적: 동일 입력 2회 = 동일 출력
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## test-relief-facts — 이지덤 릴리프 WB 사실 추출"

RELIEF_WB="$ROOT/../packs/cosmetic/samples/wb-ezderm-relief.md"
if [ ! -f "$RELIEF_WB" ]; then
  echo "  (skip) 릴리프 WB 없음: $RELIEF_WB"
  echo "test-relief-facts: PASS=$PASS FAIL=$FAIL"
  exit 0
fi

TMPDIR_RF="$(mktemp -d)"
# 임시 릴리프 product.json (가격 픽스처)
cat > "$TMPDIR_RF/product.json" <<'JSON'
{"name":"이지덤 뷰티 릴리프","price":{"current":9900,"discountRate":23.26,"currency":"KRW"}}
JSON
# reviews.csv 는 골든 번들(상위 N 형태소가 필요하므로 충분한 리뷰 수)
cp "$BUNDLE/reviews.csv" "$TMPDIR_RF/reviews.csv"

OUT_VOC="$TMPDIR_RF/voc.json"
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" \
  "$TMPDIR_RF/product.json" \
  "relief-test" \
  "$OUT_VOC" \
  "$RELIEF_WB" >/dev/null 2>&1

# (rf-schema) 스키마 검증
mkdir -p "$TMPDIR_RF/00-ingest"
cp "$OUT_VOC" "$TMPDIR_RF/00-ingest/voc.json"
check "(rf-schema) 릴리프 voc.json 스키마 검증 통과" \
  "( cd '$ROOT' && python3 scripts/lib/harness.py validate '$TMPDIR_RF/00-ingest/voc.json' >/dev/null 2>&1 )"

# (rf-offer) 가격·할인율 추출
OFFER_P="$(python3 -c "import json;print(json.load(open('$OUT_VOC')).get('offer',{}).get('price',''))")"
check "(rf-offer) offer.price = 9900" "[ \"$OFFER_P\" = '9900' ]"
OFFER_D="$(python3 -c "import json;v=json.load(open('$OUT_VOC')).get('offer',{}).get('discount');print('' if v is None else v)")"
check "(rf-offer) offer.discount 존재(비null)" "[ -n \"$OFFER_D\" ]"

# (rf-pf) product_facts 키 존재
PF_EXISTS="$(python3 -c "import json;print('product_facts' in json.load(open('$OUT_VOC')))")"
check "(rf-pf) product_facts 키 존재" "[ \"$PF_EXISTS\" = 'True' ]"

# (rf-pf) 티트리잎 오일 함량(10000ppm) 추출
KI_OK="$(python3 -c "
import json
ki = json.load(open('$OUT_VOC'))['product_facts']['key_ingredients']
print(any(x['name']=='티트리잎 오일' for x in ki))
")"
check "(rf-pf) key_ingredients에 티트리잎 오일 추출" "[ \"$KI_OK\" = 'True' ]"

KI_AMT="$(python3 -c "
import json
ki = json.load(open('$OUT_VOC'))['product_facts']['key_ingredients']
items = [x for x in ki if x['name']=='티트리잎 오일']
print(items[0]['amount'] if items else '')
")"
check "(rf-pf) 티트리잎 오일 amount에 ppm 포함" "echo \"$KI_AMT\" | grep -qi 'ppm'"

# (rf-pf) components: generic 구조 추출(제품 어휘 비의존) — '동봉' 단서 앞 명사구 '위생 핀셋' 추출.
#   '지퍼파우치 형태로'는 동봉형 단서가 아니라 fail-closed 로 비추출(범용 하네스: 제품 어휘 하드코딩 금지).
COMP_OK="$(python3 -c "
import json
c = json.load(open('$OUT_VOC'))['product_facts']['components']
print('위생 핀셋' in c)
")"
check "(rf-pf) components: generic 단서('동봉')로 '위생 핀셋' 추출(제품 어휘 비하드코딩)" \
  "[ \"$COMP_OK\" = 'True' ]"

# (WS1) 릴리프 WB claim-basis: 인체적용시험 결과 + 임상 개선 표지 → evidence 2건(ev-01 + ev-02)
OUT_CB="$TMPDIR_RF/claim-basis.json"
python3 "$ROOT/scripts/lib/ingest.py" claim-basis "$RELIEF_WB" "$OUT_CB" >/dev/null 2>&1
EV_CNT="$(python3 -c "import json;print(len(json.load(open('$OUT_CB'))['evidence_on_file']))")"
check "(WS1) 임상 개선 표지 인접 추출 → evidence ≥2건(ev-01+ev-02)" "[ \"$EV_CNT\" -ge 2 ]"
EV_KIND="$(python3 -c "
import json
ev = json.load(open('$OUT_CB'))['evidence_on_file']
kinds = [e['kind'] for e in ev]
print('clinical_trial' in kinds)
")"
check "(WS1) ev-02 kind=clinical_trial" "[ \"$EV_KIND\" = 'True' ]"

# (rf-det) 결정적: 동일 입력 2회 실행 → 동일 출력
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" "$TMPDIR_RF/product.json" \
  "relief-test" "$TMPDIR_RF/voc2.json" "$RELIEF_WB" >/dev/null 2>&1
DET_OK="$(python3 -c "
import json
a = json.dumps(json.load(open('$OUT_VOC')), sort_keys=True, ensure_ascii=False)
b = json.dumps(json.load(open('$TMPDIR_RF/voc2.json')), sort_keys=True, ensure_ascii=False)
print(a == b)
")"
check "(rf-det) 릴리프 voc.json 결정적(2회 동일)" "[ \"$DET_OK\" = 'True' ]"

# (rf-pct) 함량 % 포맷 추출(Codex P2 회귀 — '\b' 가 '%' 뒤에서 매칭 안 되던 문제)
PCT_WB="$TMPDIR_RF/wb-pct.md"
cat > "$PCT_WB" <<'MD'
유효성분으로 나이아신아마이드 5% 함유되어 있습니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" "$TMPDIR_RF/product.json" "pct-test" \
  "$TMPDIR_RF/voc-pct.json" "$PCT_WB" >/dev/null 2>&1
PCT_OK="$(python3 -c "
import json
ki = json.load(open('$TMPDIR_RF/voc-pct.json'))['product_facts']['key_ingredients']
print(any(x['name']=='나이아신아마이드' and x['amount']=='5%' for x in ki))
")"
check "(rf-pct) % 함량 포맷 추출(나이아신아마이드 5%)" "[ \"$PCT_OK\" = 'True' ]"

# (rf-edge) generic 구조 추출 엣지케이스(Codex P2 회귀) — 소수 함량·라벨 뒤 성분명·부정/계획 매수.
EDGE_WB="$TMPDIR_RF/wb-edge.md"
cat > "$EDGE_WB" <<'MD'
유효성분: 티트리잎 오일 10000ppm 함유
살리실산 0.5% 함유되어 있습니다.
30매가 아니라 60매로 구성됩니다.
케어 솔루션을 제공합니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" "$TMPDIR_RF/product.json" "edge-test" \
  "$TMPDIR_RF/voc-edge.json" "$EDGE_WB" >/dev/null 2>&1
EDGE="$(python3 -c "
import json
pf = json.load(open('$TMPDIR_RF/voc-edge.json'))['product_facts']
ki = {x['name']: x['amount'] for x in pf['key_ingredients']}
ok = (ki.get('티트리잎 오일')=='10000ppm'           # 라벨 뒤 전체 성분명(마지막 토큰 '오일' 아님)
      and ki.get('살리실산')=='0.5%'                 # 소수 함량(0.5%, '5%' 아님)
      and pf['pack_count'] in (None, 60)             # 부정 매수 누출 차단(30 금지)
      and pf['pack_count'] != 30
      and '케어 솔루션' not in pf['components'])      # 마케팅어 '제공' 오추출 차단
print(ok, ki, pf['pack_count'], pf['components'])
")"
check "(rf-edge) 소수·라벨성분명·부정매수·마케팅어 generic 추출 정확" "echo \"$EDGE\" | grep -q '^True'"

# (WS1-adv) 적대: 임상시험 절 직후 인접 절이 '계획(진행 중)'·'부정(확인되지 않음)'이면
#   개선 표지가 있어도 evidence 로 승격하지 말 것(fail-closed; Codex P1 회귀).
ADV_WB="$TMPDIR_RF/wb-adv.md"
cat > "$ADV_WB" <<'MD'
제품은 인체적용시험 결과 적합한 것으로 확인되었습니다. 피지량 개선은 진행 중입니다. 유분량 개선은 확인되지 않았습니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" claim-basis "$ADV_WB" "$TMPDIR_RF/cb-adv.json" >/dev/null 2>&1
ADV_EV="$(python3 -c "import json;print(len(json.load(open('$TMPDIR_RF/cb-adv.json'))['evidence_on_file']))")"
check "(WS1-adv) 계획·부정 인접 개선절은 evidence 미승격(evidence=1)" "[ \"$ADV_EV\" = '1' ]"

# (WS1-adv2) 적대: 측정대상(유분량) 단순 언급(결과 표지 없음)은 evidence 미승격(Codex P2 회귀).
ADV2_WB="$TMPDIR_RF/wb-adv2.md"
cat > "$ADV2_WB" <<'MD'
제품은 인체적용시험 결과 적합한 것으로 확인되었습니다. 유분량이 많은 지성 피부에 추천합니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" claim-basis "$ADV2_WB" "$TMPDIR_RF/cb-adv2.json" >/dev/null 2>&1
ADV2_EV="$(python3 -c "import json;print(len(json.load(open('$TMPDIR_RF/cb-adv2.json'))['evidence_on_file']))")"
check "(WS1-adv2) 결과 표지 없는 단순 언급은 evidence 미승격(evidence=1)" "[ \"$ADV2_EV\" = '1' ]"

# (rf-neg) 적대: 부정된 성분 함량은 product_facts 에 적재 안 함(Codex P2 회귀).
NEG_WB="$TMPDIR_RF/wb-neg.md"
cat > "$NEG_WB" <<'MD'
나이아신아마이드 5%는 함유하지 않습니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" "$TMPDIR_RF/product.json" "neg-test" \
  "$TMPDIR_RF/voc-neg.json" "$NEG_WB" >/dev/null 2>&1
NEG_KI="$(python3 -c "import json;print(len(json.load(open('$TMPDIR_RF/voc-neg.json'))['product_facts']['key_ingredients']))")"
check "(rf-neg) 부정된 성분 함량 미적재(key_ingredients=0)" "[ \"$NEG_KI\" = '0' ]"

# (rf-comp-neg) 적대: 배제/예정 구성품은 components 에 노출 안 함(Codex P2 회귀).
#   단 무관한 부정("닿지 않도록 … 핀셋 동봉")은 정상 구성품을 떨구지 않아야 함.
COMP_WB="$TMPDIR_RF/wb-comp.md"
cat > "$COMP_WB" <<'MD'
손이 직접 닿지 않도록 위생 핀셋을 동봉합니다. 지퍼파우치는 미포함입니다.
MD
python3 "$ROOT/scripts/lib/ingest.py" voc \
  "$TMPDIR_RF/reviews.csv" "$TMPDIR_RF/product.json" "comp-test" \
  "$TMPDIR_RF/voc-comp.json" "$COMP_WB" >/dev/null 2>&1
COMP_RES="$(python3 -c "
import json
c = json.load(open('$TMPDIR_RF/voc-comp.json'))['product_facts']['components']
print('위생 핀셋' in c and '지퍼파우치' not in c)
")"
check "(rf-comp-neg) 무관 부정엔 핀셋 유지·미포함 파우치는 제외" "[ \"$COMP_RES\" = 'True' ]"

# (WS1-kind) 인체외시험 트리거의 인접 evidence 는 clinical_trial 로 오표기 안 함(Codex P2 회귀).
VITRO_WB="$TMPDIR_RF/wb-vitro.md"
cat > "$VITRO_WB" <<'MD'
제품은 인체외시험 결과 보유. 피지량 개선 확인.
MD
python3 "$ROOT/scripts/lib/ingest.py" claim-basis "$VITRO_WB" "$TMPDIR_RF/cb-vitro.json" >/dev/null 2>&1
VITRO_KINDS="$(python3 -c "import json;print(','.join(e['kind'] for e in json.load(open('$TMPDIR_RF/cb-vitro.json'))['evidence_on_file']))")"
check "(WS1-kind) 인체외시험 인접 evidence kind=in_vitro(클리니컬 오표기 금지)" \
  "[ \"$VITRO_KINDS\" = 'in_vitro,in_vitro' ]"

rm -rf "$TMPDIR_RF"
echo "test-relief-facts: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
