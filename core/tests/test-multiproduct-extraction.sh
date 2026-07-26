#!/usr/bin/env bash
# test-multiproduct-extraction.sh — M-1·M-2: 다제품 WB 추출 경계(선언제품 섹션 스코핑, fail-open).
#   검증: (scope) 다제품 WB + 선언명 → 그 제품 섹션만 추출(product_type 정확·타제품 근거 0건) ·
#         (noop) 단제품 WB → 전체-WB 폴백 = 스코핑 도입 전과 바이트 동일(골든 불변) ·
#         (ambig) 선언명이 2섹션↑ 매칭/미발견 → 폴백 + stderr 감사 1줄 ·
#         (facts) voc product_facts 도 동일 스코프 ·
#         (wire) ingest-bundle.sh 가 state.product.name 을 추출에 실제 전달(엔드투엔드).
#   헤르메틱·번들 비의존(직접 CLI) + 엔드투엔드 1건. HARNESS_OFFLINE=1 결정적.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## M-1·M-2 — 다제품 WB 추출 경계(선언제품 섹션 스코핑, fail-open)"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-mpx-* 2>/dev/null || true; }
trap cleanup EXIT

INGEST="$ROOT/scripts/lib/ingest.py"

# ── 다제품 WB 픽스처: 제품A(의약외품)·릴리프(화장품)·퀵카밍(화장품) 3섹션 + 공용 서두 ──
#   각 섹션에 제품유형·근거 절·성분/구성 라인 포함(타제품 혼입 검출용). "이지덤 뷰티"는 "이지덤 뷰티 릴리프"의
#   부분문자열 — M-1 원증상(부분일치로 첫 제품 오추출) 재현·차단 확인용.
MULTI="$SCRATCH/wb-multi.md"
cat > "$MULTI" <<'MD'
# 워킹백워드 — 다제품 테스트

## 공통 안내
- 브랜드 공통 서두(공용 preamble)

## 이지덤 뷰티
- 제품유형: 의약외품 크림
- 여드름 인체적용시험 결과 보유 n=30 완료
- 더마테스트 보유
- 센텔라 추출물 3% 함유
- 40매 구성

## 이지덤 뷰티 릴리프
- 제품유형: 색조화장품(쿠션)
- 미백 인체적용시험 결과 보유 n=20 완료
- 티트리 오일 5000ppm 함유
- 30매 구성

## 이지덤 퀵카밍
- 제품유형: 화장품
- acnes 사멸 항균 인체외시험 결과 보유 완료
- 나이아신아마이드 2% 함유
- 60매 구성
MD

cb_get() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['$2'])" "$1"; }

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (scope) 선언명='이지덤 뷰티 릴리프' → 릴리프 섹션 + 공용 서두에서만 추출
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (scope) 선언제품 섹션 스코핑 — 타제품 근거·유형 혼입 0"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-scoped.json" "이지덤 뷰티 릴리프" 2>/dev/null
# M-1: product_type = 릴리프 유형(색조화장품), 첫 제품(의약외품)이 아니어야 한다.
PT="$(cb_get "$SCRATCH/cb-scoped.json" product_type)"
check "(scope) M-1: product_type = 릴리프 유형(색조화장품 포함)" "printf '%s' \"$PT\" | grep -q '색조화장품'"
check "(scope) M-1: product_type 에 첫 제품 유형(의약외품) 미포함" "! printf '%s' \"$PT\" | grep -q '의약외품'"
# M-2: evidence 는 릴리프 근거(미백)만 — 타제품(여드름·acnes) 근거 0건.
python3 - "$SCRATCH/cb-scoped.json" <<'PY' && pass "(scope) M-2: evidence 는 릴리프 미백 1건만(타제품 여드름·acnes 근거 0)" || fail "(scope) M-2: 타제품 근거 혼입"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
ok = len(ev) == 1 and "미백" in summ and "acnes" not in summ and "여드름" not in summ
sys.exit(0 if ok else 1)
PY
# certs: 더마테스트는 이지덤 뷰티(타제품) 섹션 → 릴리프 스코프엔 미포함.
python3 -c "import json,sys;c=json.load(open('$SCRATCH/cb-scoped.json'))['certifications'];sys.exit(0 if '더마테스트' not in c else 1)"
check "(scope) M-2: certs 에 타제품(더마테스트) 인증 미혼입" "[ $? -eq 0 ]"
# A-DEF-2 커밋③(태깅-declared): 국소화 성공 → product_scope=declared 태그 방출.
check "(scope) 태깅: 국소화 성공 → product_scope=declared" \
  "[ \"\$(cb_get \"$SCRATCH/cb-scoped.json\" product_scope)\" = 'declared' ]"

# 대조: 선언명 없이(레거시) 전체-WB 추출하면 M-1·M-2 결함이 재현됨(첫 제품 유형 + 타제품 근거 다수).
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-nolabel.json" 2>/dev/null
PT0="$(cb_get "$SCRATCH/cb-nolabel.json" product_type)"
check "(scope·대조) 선언명 없으면 전체-WB → 첫 제품 유형(의약외품) 오추출 재현" "printf '%s' \"$PT0\" | grep -q '의약외품'"
EVN0="$(python3 -c "import json;print(len(json.load(open('$SCRATCH/cb-nolabel.json'))['evidence_on_file']))")"
check "(scope·대조) 선언명 없으면 evidence 3건(타제품 혼입 재현)" "[ \"$EVN0\" = '3' ]"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (facts) voc product_facts 도 동일 스코프 — 타제품 성분/구성 혼입 0
# ═══════════════════════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════════════════
# (prefix) 접두사 제품명 정확일치 — 선언 '이지덤 뷰티'(형제 '이지덤 뷰티 릴리프'의 접두사)가
#   첫 제품에 정확 국소화(부분문자열이면 두 섹션 매칭 → 전체-WB 폴백·오염; 외부리뷰 P1)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (prefix) 접두사 제품명 → 정확일치 국소화(전체-WB 폴백 아님)"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-prefix.json" "이지덤 뷰티" 2>/dev/null
PTP="$(cb_get "$SCRATCH/cb-prefix.json" product_type)"
check "(prefix) 선언 '이지덤 뷰티' → 첫 제품 유형(의약외품)으로 정확 국소화" "printf '%s' \"$PTP\" | grep -q '의약외품'"
check "(prefix) 릴리프 유형(색조화장품) 미혼입(전체-WB 폴백 아님)" "! printf '%s' \"$PTP\" | grep -q '색조화장품'"
python3 - "$SCRATCH/cb-prefix.json" <<'PY' && pass "(prefix) evidence 는 '이지덤 뷰티'(여드름) 1건만 · 타제품(미백·acnes) 0" || fail "(prefix) 접두사 오매칭 → 전체-WB 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "여드름" in summ and "미백" not in summ and "acnes" not in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (brand) 브랜드 접두사 제품명 — state.product.name '[대웅제약] 우루사' vs WB '제품명: 우루사'
#   (접두사 미제거면 미발견 → 전체-WB 오염; 외부리뷰 P2. 우루사 실런 케이스)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (brand) 브랜드 접두사 [대웅제약] 제거 후 정확 국소화"
BRANDWB="$SCRATCH/wb-brand.md"
cat > "$BRANDWB" <<'MD'
# 워킹백워드 — 브랜드 접두사

## 우루사정
- 제품명: 우루사
- 제품유형: 일반의약품
- 우르소데옥시콜산 100mg 함유

## 복합우루사연질캡슐
- 제품명: 복합우루사
- 제품유형: 일반의약품
- 타우린 500mg 함유
MD
python3 - "$ROOT" "$BRANDWB" <<'PY' && pass "(brand) '[대웅제약] 우루사' → 우루사 섹션 국소화(우르소데옥시콜산만·복합우루사 타우린 0)" || fail "(brand) 브랜드 접두사 미제거 → 전체-WB 오염"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "drug"
import ingest
f = ingest._extract_product_facts(wb, "[대웅제약] 우루사")
names = " ".join(i["name"] for i in f["key_ingredients"])
# 스코핑 성공: 우루사 섹션의 우르소데옥시콜산만 · 형제(복합우루사) 타우린 0. 접두사 미제거면 전체-WB→타우린 혼입.
sys.exit(0 if "우르소데옥시콜산" in names and "타우린" not in names else 1)
PY

# ── (bullet) Word/Docs '•' 불릿 마커 인식 (외부리뷰 R14 P2a) ──
echo "# (bullet) '•' 불릿 마커 인식"
BULLETWB="$SCRATCH/wb-bullet.md"
printf '# 워킹백워드 — 불릿\n\n## 제품 알파\n\xe2\x80\xa2 제품명: 제품 알파\n\xe2\x80\xa2 여드름 인체적용시험 결과 보유 n=30 완료\n\n## 제품 베타\n\xe2\x80\xa2 제품명: 제품 베타\n\xe2\x80\xa2 미백 인체적용시험 결과 보유 n=20 완료\n' > "$BULLETWB"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$BULLETWB" "$SCRATCH/cb-bullet.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-bullet.json" <<'PY' && pass "(bullet) '•' 마커 인식 → 알파(여드름)만 · 베타(미백) 0" || fail "(bullet) '•' 미인식 → 마커-free 폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "여드름" in summ and "미백" not in summ and len(ev) == 1 else 1)
PY

# ── (variant) 괄호 변이 태그 '(소형)/(대형)' 는 제거 안 함 — raw 정확일치로 구분 (외부리뷰 R14 P2b) ──
echo "# (variant) 괄호 변이 태그 raw 구분"
VARWB="$SCRATCH/wb-variant.md"
cat > "$VARWB" <<'MD'
# 워킹백워드 — 변이 태그

## (소형) 패치
- 제품명: (소형) 패치
- 여드름 인체적용시험 결과 보유 n=30 완료

## (대형) 패치
- 제품명: (대형) 패치
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$VARWB" "$SCRATCH/cb-var.json" "(대형) 패치" 2>/dev/null
python3 - "$SCRATCH/cb-var.json" <<'PY' && pass "(variant) '(대형) 패치' → 대형(미백)만 · (소형)(여드름) 0" || fail "(variant) 괄호 제거로 (소형)/(대형) 합쳐져 모호 폴백"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# ── (mixed-marker) 제품유형은 전 섹션·제품명은 한 섹션만 → 제품유형으로 tier 검출 (외부리뷰 R15 P2a) ──
echo "# (mixed-marker) 제품유형 전섹션·제품명 일부 → 제품유형 tier"
MIXWB="$SCRATCH/wb-mixed.md"
cat > "$MIXWB" <<'MD'
# 워킹백워드 — 혼합 마커

## 제품 알파
- 제품유형: 색조화장품
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 베타
- 제품유형: 화장품
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MIXWB" "$SCRATCH/cb-mix.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-mix.json" <<'PY' && pass "(mixed-marker) 제품유형 tier → 알파(여드름)만 · 베타(미백) 0" || fail "(mixed-marker) 제품명 불완전→제품유형 tier 미시도→폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "여드름" in summ and "미백" not in summ and len(ev) == 1 else 1)
PY

# ── (heading-ident) 제품명이 선언과 불일치(SKU 코드)라도 헤딩이 선언과 맞으면 식별 (외부리뷰 R16) ──
echo "# (heading-ident) 제품명 불일치·헤딩 일치 → 헤딩으로 식별"
HIWB="$SCRATCH/wb-headingident.md"
cat > "$HIWB" <<'MD'
# 워킹백워드 — 제품명 불일치·헤딩 일치

## 제품 베타
- 제품명: 베타 SKU-2024
- 미백 인체적용시험 결과 보유 n=20 완료

## 제품 알파
- 제품명: 알파 SKU-2024
- 여드름 인체적용시험 결과 보유 n=30 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$HIWB" "$SCRATCH/cb-hi.json" "제품 베타" 2>/dev/null
python3 - "$SCRATCH/cb-hi.json" <<'PY' && pass "(heading-ident) '제품 베타' → 헤딩 매칭 베타(미백)만 · 알파(여드름) 0" || fail "(heading-ident) 제품명 불일치로 미매칭→폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# ── (brand-bracket) '[대웅제약 이지듀] …' vs WB '이지듀 …' — 괄호 문자만 제거·토큰 부분열 매칭 (외부리뷰 R15 P2b) ──
echo "# (brand-bracket) 브랜드 괄호 안 부분명 → 토큰 부분열 매칭"
BBWB="$SCRATCH/wb-brandbracket.md"
cat > "$BBWB" <<'MD'
# 워킹백워드 — 브랜드 괄호

## 이지듀 멜라 비 토닝
- 제품명: 이지듀 멜라 비 토닝 앰플
- 미백 인체적용시험 결과 보유 n=20 완료

## 이지듀 브라이트
- 제품명: 이지듀 브라이트 세럼
- 진정 인체적용시험 결과 보유 n=25 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$BBWB" "$SCRATCH/cb-bb.json" "[대웅제약 이지듀] 멜라 비 토닝 앰플" 2>/dev/null
python3 - "$SCRATCH/cb-bb.json" <<'PY' && pass "(brand-bracket) '[대웅제약 이지듀] 멜라…' → 멜라(미백)만 · 브라이트(진정) 0" || fail "(brand-bracket) 괄호 토큰 미정규화 → 미발견 폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "진정" not in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (heading) 마커 없는 헤딩-only 다제품 WB — 헤딩 자체를 제품 경계로 스코핑
#   (제품명:/제품유형: 없이 '## 제품A'/'## 제품B' 만이면 옛 마커기반은 단제품 처리→전체-WB 오염; 외부리뷰 R4 P2)
# ═══════════════════════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════════════════
# (suffix) 번들 제품명 접미사 — state.product.name '우루사 100정' vs WB '제품명: 우루사'
#   (부분일치만이면 미발견→전체-WB 폴백; 외부리뷰 R5 P2. 접미사 tier 매칭으로 국소화)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (suffix) 번들 용량 접미사 → 접미사 tier 국소화"
python3 - "$ROOT" "$BRANDWB" <<'PY' && pass "(suffix) '우루사 100정' → 우루사 섹션(우르소데옥시콜산만·복합우루사 타우린 0)" || fail "(suffix) 접미사 → 전체-WB 폴백/오염"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "drug"
import ingest
f = ingest._extract_product_facts(wb, "우루사 100정")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "우르소데옥시콜산" in names and "타우린" not in names else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (title) 제목 + 마커블록(제품별 헤딩 없음) — 마커 위치로 재분할해 스코핑
#   (제목 헤딩 하나가 전체를 1섹션으로 만들어 마커가 경계로 안 쓰이던 문제; 외부리뷰 R5 P1)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (title) 제목+마커블록(제품 헤딩 없음) → 마커 경계 재분할"
TITLEWB="$SCRATCH/wb-title.md"
cat > "$TITLEWB" <<'MD'
# 워킹백워드 — 제목만(제품 헤딩 없음)

제품명: 우루사
제품유형: 일반의약품
우르소데옥시콜산 100mg 함유

제품명: 복합우루사
제품유형: 일반의약품
타우린 500mg 함유
MD
python3 - "$ROOT" "$TITLEWB" <<'PY' && pass "(title) 제목+마커블록 → '우루사' 마커 경계 스코핑(우르소데옥시콜산만·타우린 0)" || fail "(title) 제목 헤딩이 마커 경계 무력화 → 전체-WB 오염"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "drug"
import ingest
f = ingest._extract_product_facts(wb, "우루사")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "우르소데옥시콜산" in names and "타우린" not in names else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (marker-free) 마커(제품명/제품유형) 전무 → 스코핑 안 함(fail-open 전체-WB)
#   마커 없이 헤딩만으로는 '제품 헤딩'과 '섹션 헤딩'을 구분 못 함 → 단제품을 다제품 오판해 실증 섹션을 버리는
#   회귀 방지(외부리뷰 R8 P2). 사용자 확정 fail-open: 모호하면 전체-WB. 신뢰 스코핑은 마커 있을 때만.
# ═══════════════════════════════════════════════════════════════════════════════════════════
# ── (flat-type-name) 헤딩 없는 플랫 WB, 제품유형으로 분할되나 선택 블록에 제품명 → 제품명 후보로 매칭 (외부리뷰 R20a) ──
echo "# (flat-type-name) 플랫 제품유형 분할 + 제품명 후보 매칭"
FTNWB="$SCRATCH/wb-flattypename.md"
printf '# 워킹백워드 — 플랫\n\n제품유형: 색조화장품\n제품명: 제품 알파\n여드름 인체적용시험 결과 보유 n=30 완료\n\n제품유형: 화장품\n미백 인체적용시험 결과 보유 n=20 완료\n' > "$FTNWB"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$FTNWB" "$SCRATCH/cb-ftn.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-ftn.json" <<'PY' && pass "(flat-type-name) 제품명 후보로 알파 매칭(여드름)만 · 타블록(미백) 0" || fail "(flat-type-name) 제품유형 값만 봐서 미발견→폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]; summ = " ".join(e.get("summary","") for e in ev)
sys.exit(0 if "여드름" in summ and "미백" not in summ and len(ev) == 1 else 1)
PY

# ── (flat-preamble-leak) 첫 제품의 제품명 앞 인증이 뒤 제품에 유출 안 됨 (외부리뷰 R20b: 폴백 preamble 제거) ──
echo "# (flat-preamble-leak) 첫 제품 메타가 뒤 제품에 유출 안 됨"
FPLWB="$SCRATCH/wb-flatpre.md"
printf '# 워킹백워드 — 플랫 인증\n\n더마테스트 보유\n제품명: 제품 알파\n여드름 인체적용시험 결과 보유 n=30 완료\n제품명: 제품 베타\n미백 인체적용시험 결과 보유 n=20 완료\n' > "$FPLWB"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$FPLWB" "$SCRATCH/cb-fpl.json" "제품 베타" 2>/dev/null
python3 - "$SCRATCH/cb-fpl.json" <<'PY' && pass "(flat-preamble-leak) 베타 선택 → 미백만 · 첫제품 앞 인증(더마테스트)·알파(여드름) 유출 0" || fail "(flat-preamble-leak) 첫 제품 메타 preamble 유출"
import sys, json
d = json.load(open(sys.argv[1]))
summ = " ".join(e.get("summary","") for e in d["evidence_on_file"])
sys.exit(0 if "미백" in summ and "여드름" not in summ and "더마테스트" not in d["certifications"] and len(d["evidence_on_file"]) == 1 else 1)
PY

echo "# (marker-free) 마커 없으면 스코핑 안 함(전체-WB 폴백)"
HEADWB="$SCRATCH/wb-heading.md"
cat > "$HEADWB" <<'MD'
# 워킹백워드 — 헤딩만(마커 없음)

## 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 베타
- 미백 인체적용시험 결과 보유 n=20 완료
MD
# 마커 없으니 선언명 줘도 스코핑 안 함 → 전체-WB(두 제품 근거 모두). 선언명 유무 바이트 동일.
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$HEADWB" "$SCRATCH/cb-mf.json" "제품 베타" 2>/dev/null
python3 - "$SCRATCH/cb-mf.json" <<'PY' && pass "(marker-free) 마커 없으면 전체-WB(근거 2건 모두 보존·오탈락 없음)" || fail "(marker-free) 마커없는 WB 를 스코핑해 근거 유실"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" in summ and len(ev) == 2 else 1)
PY
python3 - "$ROOT" "$HEADWB" <<'PY' && pass "(marker-free) 선언명 유무 바이트 동일(no-op)" || fail "(marker-free) 선언명이 마커없는 WB 를 바꿈"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import ingest
t = open(wb).read()
a, _, _ = ingest._scope_wb_to_product(t, "제품 베타")
b, _, _ = ingest._scope_wb_to_product(t, "")
sys.exit(0 if a == t and b == t else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (section-headings) 마커 없는 '단제품 + 섹션 헤딩'(## 제품명 + ## 보유 실증 자료) → 전체-WB(실증 유실 없음)
#   (헤딩-only 스코핑이면 실증 섹션을 버려 오늘보다 나빠짐; 외부리뷰 R8 P2 회귀 가드)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (section-headings) 단제품+섹션헤딩 → 전체-WB(실증 보존)"
SECWB="$SCRATCH/wb-section.md"
cat > "$SECWB" <<'MD'
# 워킹백워드 — 단제품 + 섹션 헤딩

## 이지듀 토닝 앰플
- 브랜드 서사

## 보유 실증 자료
- 미백 인체적용시험 결과 보유 n=20 완료

## 사용법
- 아침저녁 사용
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$SECWB" "$SCRATCH/cb-sec.json" "이지듀 토닝 앰플" 2>/dev/null
python3 - "$SCRATCH/cb-sec.json" <<'PY' && pass "(section-headings) 실증 섹션(미백) 보존 — 섹션헤딩을 제품으로 오판 안 함" || fail "(section-headings) 실증 섹션 유실(단제품 다제품 오판)"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (nested) 제품명이 ### 하위섹션에 중첩 — 형제 ### 근거/성분(같은 제품)이 스팬에 보존
#   (마커 하위레벨에서 스팬이 조기 종료하면 같은 제품 근거 유실; 외부리뷰 R6 P2. marker_mode=다음 마커섹션 경계)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (nested) 제품명 ### 중첩 → 형제 근거/성분 보존"
NESTWB="$SCRATCH/wb-nested.md"
cat > "$NESTWB" <<'MD'
# 워킹백워드 — 중첩 마커

## 제품 알파
### 기본 정보
- 제품명: 제품 알파
### 근거
- 여드름 인체적용시험 결과 보유 n=30 완료
### 성분
- 센텔라 3% 함유

## 제품 베타
### 기본 정보
- 제품명: 제품 베타
### 근거
- 미백 인체적용시험 결과 보유 n=20 완료
### 성분
- 티트리 5000ppm 함유
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$NESTWB" "$SCRATCH/cb-nest.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-nest.json" <<'PY' && pass "(nested) ### 중첩 마커: 형제 근거(여드름) 보존 · 타제품(미백) 0" || fail "(nested) 하위레벨 조기종료 → 같은 제품 근거 유실"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "여드름" in summ and "미백" not in summ and len(ev) == 1 else 1)
PY
python3 - "$ROOT" "$NESTWB" <<'PY' && pass "(nested) ### 중첩 성분(센텔라) 보존 · 타제품(티트리) 0" || fail "(nested) 중첩 성분 유실"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "cosmetic"
import ingest
f = ingest._extract_product_facts(wb, "제품 알파")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "센텔라" in names and "티트리" not in names else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (placeholder) 기본 placeholder '제품'(번들 이름 없을 때) = 미선언 취급 → 전체-WB no-op
#   (ingest-bundle 이 블랭크; 안 하면 '## 제품 개요' 헤딩에 오매칭돼 근거 유실; 외부리뷰 R6 P2)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (placeholder) 기본 '제품' → 미선언 취급(전체-WB)"
PHWB="$SCRATCH/wb-ph.md"
cat > "$PHWB" <<'MD'
# 워킹백워드 — placeholder(마커 기반)

## 제품 알파
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 베타
- 제품명: 베타
- 미백 인체적용시험 결과 보유 n=20 완료
MD
python3 - "$ROOT" "$PHWB" <<'PY' && pass "(placeholder) 블랭크('') → 전체-WB no-op(근거 2건 모두 보존) · '제품' 그대로면 오매칭 입증" || fail "(placeholder) 블랭크 no-op 실패 or 위험 미입증"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import ingest
text = open(wb).read()
# (i) 위험 입증: '제품'(placeholder) 그대로면 제품명 '제품 알파'에 부분일치 오매칭 → 알파로 스코프(베타 근거 유실)
mis, _a, _ = ingest._scope_wb_to_product(text, "제품")
risky = (mis != text)
# (ii) ingest-bundle 이 블랭크한 '' → no-op 전체-WB(두 제품 근거 모두)
noop, _a2, _ = ingest._scope_wb_to_product(text, "")
sys.exit(0 if risky and noop == text else 1)
PY
check "(placeholder) ingest-bundle 가 '제품' placeholder 를 블랭크 처리" \
  "grep -qE '\"\\\$DECL_NAME\" = \"제품\"' '$ROOT/scripts/ingest-bundle.sh'"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (meta-order) 제품유형이 제품명 '앞'에 오는 배치 — 각 제품이 자기 유형을 갖고 타제품 유형 미혼입
#   (마커 위치 split 은 앞선 유형을 이전 청크/서두로 흘려 타제품 유형 오추출; 외부리뷰 R7 P1)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (meta-order) 제품유형→제품명 순서(제목+평문 마커블록)"
METAWB="$SCRATCH/wb-metaorder.md"
cat > "$METAWB" <<'MD'
# 워킹백워드 — 유형이 이름 앞

제품유형: 의약외품 크림
제품명: 제품 알파
여드름 인체적용시험 결과 보유 n=30 완료

제품유형: 색조화장품
제품명: 제품 베타
미백 인체적용시험 결과 보유 n=20 완료
MD
# 베타 선택 → 베타 유형(색조화장품)이어야, 알파 유형(의약외품)이 새면 안 됨.
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$METAWB" "$SCRATCH/cb-meta.json" "제품 베타" 2>/dev/null
PTM="$(cb_get "$SCRATCH/cb-meta.json" product_type)"
check "(meta-order) 베타 선택 → product_type=색조화장품(알파 의약외품 미혼입)" \
  "printf '%s' \"$PTM\" | grep -q '색조화장품' && ! printf '%s' \"$PTM\" | grep -q '의약외품'"
python3 - "$SCRATCH/cb-meta.json" <<'PY' && pass "(meta-order) evidence 베타(미백)만 · 알파(여드름) 0" || fail "(meta-order) 앞선 유형/근거가 타제품으로 샘"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (nested-meta) 헤딩과 중첩 마커 사이 메타 — 제품 tier(상위 헤딩)로 앵커링해 자기 유형 보존
#   (## A + 제품유형 + ### 기본정보 제품명; 베타 선택 시 알파 유형이 서두로 새던 문제; 외부리뷰 R7 P1)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (nested-meta) 헤딩~중첩마커 사이 메타 → tier 앵커링"
NMWB="$SCRATCH/wb-nestmeta.md"
cat > "$NMWB" <<'MD'
# 워킹백워드 — 중첩+선행메타

## 제품 알파
- 제품유형: 의약외품 크림
### 기본 정보
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 베타
- 제품유형: 색조화장품
### 기본 정보
- 제품명: 제품 베타
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$NMWB" "$SCRATCH/cb-nm.json" "제품 베타" 2>/dev/null
PTN="$(cb_get "$SCRATCH/cb-nm.json" product_type)"
check "(nested-meta) 베타 선택 → product_type=색조화장품(알파 의약외품 미혼입)" \
  "printf '%s' \"$PTN\" | grep -q '색조화장품' && ! printf '%s' \"$PTN\" | grep -q '의약외품'"
python3 - "$SCRATCH/cb-nm.json" <<'PY' && pass "(nested-meta) evidence 베타(미백)만 · 알파(여드름) 0" || fail "(nested-meta) 상위헤딩~마커 사이 메타 오귀속"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (token) 토큰-경계 부분일치 — 공백 구분 단어면 매칭, 임의 부분문자열이면 fail-open (외부리뷰 R9 P2)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (token) 공백-구분 단어 매칭 · 임의 부분문자열 거부"
# (a) '릴리프'(공백 구분 단어) → '이지덤 뷰티 릴리프' 매칭(MULTI 헤딩 정체성).
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-tok.json" "릴리프" 2>/dev/null
python3 - "$SCRATCH/cb-tok.json" <<'PY' && pass "(token-a) '릴리프' → 릴리프 제품 매칭(미백 1건·타제품 0)" || fail "(token-a) 공백-구분 단어 매칭 실패"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and "acnes" not in summ and len(ev) == 1 else 1)
PY
# (b) '우루사'(형제 '복합우루사'의 비-경계 부분문자열, 정확 '우루사' 부재) → fail-open 전체-WB.
SIBWB="$SCRATCH/wb-sibling.md"
cat > "$SIBWB" <<'MD'
# 워킹백워드 — 형제 substring

## 복합우루사
- 제품명: 복합우루사
- 타우린 500mg 함유

## 다른제품
- 제품명: 다른제품
- 센텔라 3% 함유
MD
python3 - "$ROOT" "$SIBWB" <<'PY' && pass "(token-b) '우루사' ⊄ 경계('복합우루사') → fail-open 전체-WB(오귀속 안 함)" || fail "(token-b) 형제 substring 오매칭 → 엉뚱한 제품 스코프"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import ingest
t = open(wb).read()
scoped, audit, status = ingest._scope_wb_to_product(t, "우루사")
sys.exit(0 if scoped == t and audit is not None and status == "unscoped" else 1)   # 전체-WB + 미발견 감사 + unscoped 태그
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (label) '이전 제품명:' 등 비-제품 라벨은 마커로 안 침 — 단제품을 다제품 오판 안 함 (외부리뷰 R10 P2, 앵커링)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (label) '이전 제품명:' 라벨 = 마커 아님(앵커링)"
LABELWB="$SCRATCH/wb-label.md"
cat > "$LABELWB" <<'MD'
# 워킹백워드 — 단제품 + 이전 제품명 라벨

## 이지듀 토닝 앰플
- 제품명: 이지듀 토닝 앰플
- 미백 인체적용시험 결과 보유 n=20 완료

## 개정 이력
- 이전 제품명: 이지듀 브라이트 앰플
- 리브랜딩 전 명칭이며 참고용
MD
python3 - "$ROOT" "$LABELWB" <<'PY' && pass "(label) '이전 제품명:' 무시 → 단제품(마커 1개) → 전체-WB(미백 보존)" || fail "(label) 비-제품 라벨을 제품으로 오판 → 근거 유실"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import ingest
t = open(wb).read()
# '제품명'은 1개(이전 제품명은 앵커 밖) → 단제품 → 스코핑 no-op(전체-WB). 선언명 줘도 미백 보존.
scoped, _a, status = ingest._scope_wb_to_product(t, "이지듀 토닝 앰플")
# 단제품(마커 1개) → 스코핑 no-op → status None(태그 미방출).
sys.exit(0 if scoped == t and status is None else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (category) 카테고리 그룹핑(## 라인 > ### 제품) — 카테고리가 아니라 '깊은 실제 제품' 레벨로 스코핑 (외부리뷰 R10 P2)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (category) 카테고리>제품 그룹핑 → 깊은 제품 레벨 스코핑"
CATWB="$SCRATCH/wb-category.md"
cat > "$CATWB" <<'MD'
# 워킹백워드 — 카테고리 그룹핑

## 패치 라인
### 제품 알파
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료
### 제품 베타
- 제품명: 제품 베타
- 진정 인체적용시험 결과 보유 n=25 완료

## 세럼 라인
### 제품 감마
- 제품명: 제품 감마
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$CATWB" "$SCRATCH/cb-cat.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-cat.json" <<'PY' && pass "(category) '제품 알파' → 알파만(여드름) · 같은 카테고리 형제(베타 진정) 0 · 타카테고리(감마 미백) 0" || fail "(category) 카테고리 레벨 스코프 → 형제 제품 혼입"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "여드름" in summ and "진정" not in summ and "미백" not in summ and len(ev) == 1 else 1)
PY
# 혼합 계층(단제품 2개 + 다제품 카테고리) — 깊은 tier 의 제품 선택 시 얕은 tier 에서 멈추지 않음(외부리뷰 R17 P2).
MIXCATWB="$SCRATCH/wb-mixcat.md"
cat > "$MIXCATWB" <<'MD'
# 워킹백워드 — 혼합 계층

## 제품 A
- 제품명: 제품 A
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 B
- 제품명: 제품 B
- 진정 인체적용시험 결과 보유 n=25 완료

## 세럼 라인
### 제품 C1
- 제품명: 제품 C1
- 미백 인체적용시험 결과 보유 n=20 완료
### 제품 C2
- 제품명: 제품 C2
- 보습 인체적용시험 결과 보유 n=15 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MIXCATWB" "$SCRATCH/cb-mc1.json" "제품 A" 2>/dev/null
python3 - "$SCRATCH/cb-mc1.json" <<'PY' && pass "(mixcat) 얕은 tier 제품 'A' → 여드름만 · 타제품 0" || fail "(mixcat) 얕은 tier 제품 오추출"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]; summ = " ".join(e.get("summary","") for e in ev)
sys.exit(0 if "여드름" in summ and len(ev) == 1 else 1)
PY
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MIXCATWB" "$SCRATCH/cb-mc2.json" "제품 C1" 2>/dev/null
python3 - "$SCRATCH/cb-mc2.json" <<'PY' && pass "(mixcat) 깊은 tier 제품 'C1' → 미백만 · 형제 C2(보습)·타 0 (얕은 tier 에서 안 멈춤)" || fail "(mixcat) 얕은 tier authoritative→깊은 제품 폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]; summ = " ".join(e.get("summary","") for e in ev)
sys.exit(0 if "미백" in summ and "보습" not in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# 중첩 제품의 '조상 카테고리 리드-인'(제품유형·인증) 보존 + 형제 카테고리/제품 제외(외부리뷰 R19 P2).
CATLEADWB="$SCRATCH/wb-catlead.md"
cat > "$CATLEADWB" <<'MD'
# 워킹백워드 — 카테고리 리드-인

## 패치 라인
### 제품 P1
- 제품명: 제품 P1
- 발진 인체적용시험 결과 보유 n=10 완료

## 세럼 라인
- 제품유형: 세럼
- 더마테스트 보유
### 제품 A
- 제품명: 제품 A
- 여드름 인체적용시험 결과 보유 n=30 완료
### 제품 B
- 제품명: 제품 B
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$CATLEADWB" "$SCRATCH/cb-cl.json" "제품 A" 2>/dev/null
python3 - "$SCRATCH/cb-cl.json" <<'PY' && pass "(cat-leadin) 제품 A → 조상 세럼 리드-인(유형 세럼·더마테스트) 보존 · 형제 B(미백)·타카테고리 P1(발진) 0" || fail "(cat-leadin) 조상 카테고리 메타 유실 or 형제 혼입"
import sys, json
d = json.load(open(sys.argv[1]))
summ = " ".join(e.get("summary","") for e in d["evidence_on_file"])
ok = ("세럼" in (d.get("product_type") or "")) and ("더마테스트" in d["certifications"])
ok = ok and "여드름" in summ and "미백" not in summ and "발진" not in summ
sys.exit(0 if ok else 1)
PY

# 뒷 카테고리(세럼 라인) 제품 '감마' 선택 → 앞 카테고리(패치 라인) 메타가 preamble 로 새면 안 됨(외부리뷰 R11 P2).
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$CATWB" "$SCRATCH/cb-cat2.json" "제품 감마" 2>/dev/null
python3 - "$SCRATCH/cb-cat2.json" <<'PY' && pass "(category-late) 뒷 카테고리 '감마' → 미백만 · 앞 카테고리(여드름·진정) 유입 0" || fail "(category-late) 앞 카테고리 메타가 preamble 로 유입"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "여드름" not in summ and "진정" not in summ and len(ev) == 1 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (longest-prefix) 형제가 접두사 공유(우루사 / 우루사 플러스) + 선언 접미사 → 최장 접두사가 유일 식별 (외부리뷰 R12 P2)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (longest-prefix) 최장 접두사 우선(모호 폴백 아님)"
LPWB="$SCRATCH/wb-longestprefix.md"
cat > "$LPWB" <<'MD'
# 워킹백워드 — 접두사 공유 형제

## 우루사
- 제품명: 우루사
- 우르소데옥시콜산 100mg 함유

## 우루사 플러스
- 제품명: 우루사 플러스
- 타우린 500mg 함유
MD
python3 - "$ROOT" "$LPWB" <<'PY' && pass "(longest-prefix) '우루사 플러스 100정' → '우루사 플러스'(타우린)만 · '우루사'(우르소데옥시콜산) 0" || fail "(longest-prefix) 짧은 접두사까지 세어 모호 폴백/오귀속"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "drug"
import ingest
f = ingest._extract_product_facts(wb, "우루사 플러스 100정")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "타우린" in names and "우르소데옥시콜산" not in names else 1)
PY
# 역방향(외부리뷰 R13): 선언이 짧고(우루사 플러스) 형제가 '우루사'(짧은 접두사)·'우루사 플러스 100정'(긴 SKU)이면
#   토큰 최다 매칭인 긴 SKU 를 골라야(짧은 '우루사' 오선택 금지).
LP2WB="$SCRATCH/wb-longestprefix2.md"
cat > "$LP2WB" <<'MD'
# 워킹백워드 — 짧은 선언 + 긴 SKU 형제

## 우루사
- 제품명: 우루사
- 우르소데옥시콜산 100mg 함유

## 우루사 플러스 100정
- 제품명: 우루사 플러스 100정
- 타우린 500mg 함유
MD
python3 - "$ROOT" "$LP2WB" <<'PY' && pass "(longest-prefix-rev) '우루사 플러스' → 긴 SKU '우루사 플러스 100정'(타우린)만 · 짧은 '우루사' 0" || fail "(longest-prefix-rev) 짧은 접두사 형제 오선택"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "drug"
import ingest
f = ingest._extract_product_facts(wb, "우루사 플러스")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "타우린" in names and "우르소데옥시콜산" not in names else 1)
PY

# ── (shared-section) 제품 앞 공유 섹션(## 공통 안내, 마커 없음)의 공유 인증/성분은 스코프에 보존 (외부리뷰 R18b) ──
echo "# (shared-section) 제품 앞 공유 섹션 보존"
SHWB="$SCRATCH/wb-shared.md"
cat > "$SHWB" <<'MD'
# 워킹백워드 — 공유 섹션

## 공통 안내
- 더마테스트 보유
- 티트리 오일 5000ppm 함유

## 제품 알파
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 베타
- 제품명: 제품 베타
- 미백 인체적용시험 결과 보유 n=20 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$SHWB" "$SCRATCH/cb-sh.json" "제품 알파" 2>/dev/null
python3 - "$SCRATCH/cb-sh.json" <<'PY' && pass "(shared-section) 공유 인증(더마테스트) 보존 + 알파 근거(여드름) · 베타(미백) 0" || fail "(shared-section) 제품 앞 공유 섹션 유실"
import sys, json
d = json.load(open(sys.argv[1]))
summ = " ".join(e.get("summary","") for e in d["evidence_on_file"])
sys.exit(0 if "더마테스트" in d["certifications"] and "여드름" in summ and "미백" not in summ else 1)
PY

# ── (hybrid) 상위 헤딩 제품 + flat 마커블록 카테고리 혼합; flat 블록 제품 선택 시 tier 에서 안 멈춤 (외부리뷰 R18a) ──
echo "# (hybrid) 헤딩 제품 + flat 마커블록 혼합"
HYBWB="$SCRATCH/wb-hybrid.md"
cat > "$HYBWB" <<'MD'
# 워킹백워드 — 하이브리드

## 제품 알파
- 제품명: 제품 알파
- 여드름 인체적용시험 결과 보유 n=30 완료

## 제품 베타
- 제품명: 제품 베타
- 진정 인체적용시험 결과 보유 n=25 완료

## 세트 구성
제품명: 세트 감마
미백 인체적용시험 결과 보유 n=20 완료
제품명: 세트 델타
보습 인체적용시험 결과 보유 n=15 완료
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$HYBWB" "$SCRATCH/cb-hyb.json" "세트 감마" 2>/dev/null
python3 - "$SCRATCH/cb-hyb.json" <<'PY' && pass "(hybrid) flat 블록 '세트 감마' → 미백만 · 형제(보습)·헤딩제품(여드름·진정) 0" || fail "(hybrid) 헤딩 tier 에서 멈춰 flat 제품 폴백 오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]; summ = " ".join(e.get("summary","") for e in ev)
sys.exit(0 if "미백" in summ and "보습" not in summ and "여드름" not in summ and "진정" not in summ and len(ev) == 1 else 1)
PY

echo "# (facts) product_facts(voc 경로) 동일 스코핑"
python3 - "$ROOT" "$MULTI" <<'PY' && pass "(facts) 릴리프 스코프: 티트리(릴리프)만 · 센텔라/나이아신아마이드(타제품) 0" || fail "(facts) 타제품 성분 혼입"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "cosmetic"
import ingest
f = ingest._extract_product_facts(wb, "이지덤 뷰티 릴리프")
names = " ".join(i["name"] for i in f["key_ingredients"])
ok = "티트리" in names and "센텔라" not in names and "나이아신아마이드" not in names
ok = ok and f["pack_count"] == 30   # 릴리프 30매(공용 서두엔 매 없음)
sys.exit(0 if ok else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (span) 제품 스팬 전체 보존 — 중첩 ### 하위섹션 + 제품명/제품유형 인접이 같은 제품에 귀속
#   (외부리뷰 P2: 단일 슬라이스만 반환하면 같은 제품의 근거/성분을 버려 under-extraction — '오늘보다 나빠짐')
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (span) 매칭 제품의 중첩 하위섹션·인접 유형마커 = 같은 제품 스팬(버려지지 않음)"
SPANWB="$SCRATCH/wb-span.md"
cat > "$SPANWB" <<'MD'
# 워킹백워드 — 제품 스팬(중첩 하위섹션)

## 공통 안내
- 브랜드 공통 서두

## 이지덤 뷰티 릴리프
- 제품명: 이지덤 뷰티 릴리프
- 제품유형: 색조화장품(쿠션)
### 임상 근거
- 미백 인체적용시험 결과 보유 n=20 완료
### 성분
- 티트리 오일 5000ppm 함유
- 30매 구성

## 이지덤 퀵카밍
- 제품명: 이지덤 퀵카밍
- 제품유형: 화장품
- acnes 사멸 항균 인체외시험 결과 보유 완료
- 나이아신아마이드 2% 함유
MD
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$SPANWB" "$SCRATCH/cb-span.json" "이지덤 뷰티 릴리프" 2>/dev/null
# 중첩 ### 임상 근거(미백)가 릴리프 스팬에 포함돼야 한다(옛 단일슬라이스면 0건으로 유실).
python3 - "$SCRATCH/cb-span.json" <<'PY' && pass "(span) 중첩 ### 하위섹션 근거(미백) 보존 · 타제품(acnes) 0" || fail "(span) 중첩 하위섹션 근거 유실(under-extraction)"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "미백" in summ and "acnes" not in summ and len(ev) == 1 else 1)
PY
# 중첩 ### 성분(티트리)도 product_facts 스팬에 포함(타제품 나이아신아마이드 미혼입).
python3 - "$ROOT" "$SPANWB" <<'PY' && pass "(span) 중첩 ### 성분(티트리) 보존 · pack_count=30 · 타제품 성분 0" || fail "(span) 중첩 성분/구성 유실"
import sys, os
root, wb = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
os.environ["HARNESS_DOMAIN"] = "cosmetic"
import ingest
f = ingest._extract_product_facts(wb, "이지덤 뷰티 릴리프")
names = " ".join(i["name"] for i in f["key_ingredients"])
sys.exit(0 if "티트리" in names and "나이아신아마이드" not in names and f["pack_count"] == 30 else 1)
PY

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (noop) 단제품 WB → 전체-WB 폴백 = 선언명 유무와 무관하게 바이트 동일(골든 불변)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (noop) 단제품 WB 스코핑 no-op(골든 바이트 불변)"
GOLD_WB="$PACKS_DIR/cosmetic/golden/working-backwards.md"
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$GOLD_WB" "$SCRATCH/cb-none.json" 2>/dev/null
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$GOLD_WB" "$SCRATCH/cb-empty.json" "" 2>/dev/null
HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$GOLD_WB" "$SCRATCH/cb-named.json" "이지듀 멜라 비 토닝 앰플 쿠션" 2>/dev/null
canon() { python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True,ensure_ascii=False))" "$1"; }
# canon_noscope = product_scope 문서-태그를 뺀 추출 내용만 비교(태깅 도입 전 '바이트 동일' 의도 보존; A-DEF-2 커밋③).
canon_noscope() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.pop('product_scope',None);print(json.dumps(d,sort_keys=True,ensure_ascii=False))" "$1"; }
C_NONE="$(canon "$SCRATCH/cb-none.json")"; C_EMPTY="$(canon "$SCRATCH/cb-empty.json")"; C_NAMED="$(canon "$SCRATCH/cb-named.json")"
check "(noop) 단제품: 선언명 없음 == 빈 선언명(바이트 동일)" "[ \"\$C_NONE\" = \"\$C_EMPTY\" ]"
check "(noop) 단제품: 선언명 없음 == 선언명 있음(스코핑 완전 no-op)" "[ \"\$C_NONE\" = \"\$C_NAMED\" ]"
# A-DEF-2 커밋③(태깅-omit): 단제품(스코핑 no-op) → product_scope 키 부재(단제품 골든 claim-basis 바이트 불변 대변).
python3 -c "import json,sys;d=json.load(open('$SCRATCH/cb-named.json'));sys.exit(0 if 'product_scope' not in d else 1)"
check "(noop) 태깅: 단제품(no-op) → product_scope 키 부재(골든 바이트 불변)" "[ $? -eq 0 ]"
# 골든 기대표(claim-basis-expected) 대비 정확도 불변 — 선언명 있어도 골든 추출이 그대로 통과.
python3 "$ROOT/scripts/lib/extract_accuracy.py" "$SCRATCH/cb-named.json" "$PACKS_DIR/cosmetic/golden/claim-basis-expected.json" >/dev/null 2>&1
check "(noop) 단제품+선언명: 골든 기대표 정확도 통과(누락·오추출 0)" "[ $? -eq 0 ]"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (ambig) 선언명 2섹션↑ 매칭/미발견 → 전체-WB 폴백 + stderr 감사 1줄
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (ambig) 모호/미발견 → 폴백 + 감사줄(stderr)"
# '이지덤' 은 세 섹션 모두에 등장 → 모호 → 폴백. 감사줄은 stderr, 산출물은 전체-WB 추출과 동일.
AERR="$(HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-ambig.json" "이지덤" 2>&1 1>/dev/null)"
check "(ambig) 모호 → stderr 감사줄('다제품 국소화 실패' + '전체-WB 추출')" \
  "printf '%s' \"\$AERR\" | grep -q '다제품 국소화 실패' && printf '%s' \"\$AERR\" | grep -q '전체-WB 추출'"
check "(ambig) 감사줄이 stdout 이 아니라 stderr" "printf '%s' \"\$AERR\" | grep -q '모호'"
# A-DEF-2 커밋③(태깅-unscoped): 다제품인데 국소화 실패(모호) → product_scope=unscoped 태그(전체-WB 추출 가시화).
check "(ambig) 태깅: 모호 → product_scope=unscoped" \
  "[ \"\$(cb_get \"$SCRATCH/cb-ambig.json\" product_scope)\" = 'unscoped' ]"
# 폴백 '추출 내용' == 선언명 없는 전체-WB 산출물(오늘보다 나빠지지 않음). product_scope 문서-태그만 다르므로 태그 제외 비교.
C_AMBIG="$(canon_noscope "$SCRATCH/cb-ambig.json")"; C_FULL="$(canon_noscope "$SCRATCH/cb-nolabel.json")"
check "(ambig) 모호 폴백 추출내용 == 전체-WB 추출(태그 제외 바이트 동일)" "[ \"\$C_AMBIG\" = \"\$C_FULL\" ]"
# 미발견도 동일하게 폴백 + 감사줄 + unscoped 태그.
NERR="$(HARNESS_DOMAIN=cosmetic python3 "$INGEST" claim-basis "$MULTI" "$SCRATCH/cb-nf.json" "없는제품명XYZ" 2>&1 1>/dev/null)"
check "(ambig) 미발견 → 감사줄('미발견' + '전체-WB 추출')" \
  "printf '%s' \"\$NERR\" | grep -q '미발견' && printf '%s' \"\$NERR\" | grep -q '전체-WB 추출'"
check "(ambig) 태깅: 미발견 → product_scope=unscoped" \
  "[ \"\$(cb_get \"$SCRATCH/cb-nf.json\" product_scope)\" = 'unscoped' ]"
C_NF="$(canon_noscope "$SCRATCH/cb-nf.json")"
check "(ambig) 미발견 폴백 추출내용 == 전체-WB 추출(태그 제외 바이트 동일)" "[ \"\$C_NF\" = \"\$C_FULL\" ]"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# (wire) ingest-bundle.sh 가 state.product.name 을 추출에 실제 전달(엔드투엔드)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# (wire) ingest-bundle.sh → state.product.name → 추출 스코핑(엔드투엔드)"
BMIN="$SCRATCH/bundle"; mkdir -p "$BMIN" "$SCRATCH/assets"
# product.json name → new-run 이 state.product.name 으로 주입 → ingest-bundle 이 claim-basis/voc 에 전달.
cat > "$BMIN/product.json" <<'JSON'
{"name":"이지덤 뷰티 릴리프","collectedReviewCount":3,"totalReviewCount":3,"rating":4.5,"price":{"current":12000}}
JSON
cat > "$BMIN/reviews.csv" <<'CSV'
content,score,option
"커버 좋고 촉촉해요",5,"기본"
"밀착 잘되고 화사해요",4,"기본"
"촉촉 커버 다 좋아요",5,"기본"
CSV
rm -rf "$ROOT/runs/ci-mpx-e2e"
( cd "$ROOT" && export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
    HARNESS_WB="$MULTI" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" &&
  bash scripts/ingest-bundle.sh "$BMIN" ci-mpx-e2e ) >/dev/null 2>&1; RC=$?
check "(wire) 엔드투엔드 인입 성공(rc=0)" "[ $RC -eq 0 ]"
E2E="$ROOT/runs/ci-mpx-e2e/00-ingest/claim-basis.json"
check "(wire) state.product.name 전달 → product_type 릴리프 유형(색조화장품)" \
  "printf '%s' \"\$(cb_get \"$E2E\" product_type)\" | grep -q '색조화장품'"
python3 - "$E2E" <<'PY' && pass "(wire) 엔드투엔드 evidence 는 릴리프만(타제품 acnes/여드름 0)" || fail "(wire) 엔드투엔드 타제품 근거 혼입"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "acnes" not in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

# ── (wire-newrun-first) new-run(--domain --format, 이름 미지정) 먼저 → state.name='제품' placeholder →
#    ingest-bundle 이 번들 product.json 실제 이름으로 폴백해 스코핑(외부리뷰 R12 P1: 그냥 블랭크하면 오염 잔존) ──
echo "# (wire-newrun-first) new-run 선행(placeholder) → 번들 이름 폴백 스코핑"
rm -rf "$ROOT/runs/ci-mpx-nr"
( cd "$ROOT" && bash scripts/new-run.sh ci-mpx-nr --domain 화장품 --format 여러장 ) >/dev/null 2>&1   # --name 없음 → state.name='제품'
NRNAME="$(python3 -c "import json;print((json.load(open('$ROOT/runs/ci-mpx-nr/state.json')).get('product') or {}).get('name'))" 2>/dev/null)"
check "(wire-newrun-first) new-run 이름 미지정 → state.name='제품' placeholder" "[ \"$NRNAME\" = '제품' ]"
( cd "$ROOT" && export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
    HARNESS_WB="$MULTI" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" &&
  bash scripts/ingest-bundle.sh "$BMIN" ci-mpx-nr ) >/dev/null 2>&1; RC2=$?
check "(wire-newrun-first) 인입 성공(rc=0)" "[ $RC2 -eq 0 ]"
NR="$ROOT/runs/ci-mpx-nr/00-ingest/claim-basis.json"
check "(wire-newrun-first) placeholder→번들이름 폴백 → product_type 릴리프(색조화장품)" \
  "printf '%s' \"\$(cb_get \"$NR\" product_type)\" | grep -q '색조화장품'"
python3 - "$NR" <<'PY' && pass "(wire-newrun-first) evidence 릴리프만(타제품 0) — 오염 잔존 아님" || fail "(wire-newrun-first) placeholder 블랭크로 스코핑 실패→오염"
import sys, json
ev = json.load(open(sys.argv[1]))["evidence_on_file"]
summ = " ".join(e.get("summary", "") for e in ev)
sys.exit(0 if "acnes" not in summ and "여드름" not in summ and len(ev) == 1 else 1)
PY

printf '\n[multiproduct-extraction] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
