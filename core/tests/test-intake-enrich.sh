#!/usr/bin/env bash
# test-intake-enrich.sh — S1(F5a) intake 계약 확장 회귀 가드. 결정적·오프라인(stub), 헤르메틱 픽스처.
#   추가된 선택 필드 role(product_image 세부역할 enum)·provenance(출처 자유텍스트, 사람 확정 전용)를 검증한다.
#   (1) role(product_image)+provenance 부착 제안 → intake-proposal 스키마 + validate_stage.intake_proposal 통과.
#   (2) role 이 비-product_image 파일에 붙으면 → validate_stage 가 새 exit code 24 로 거부.
#   (3) 새 필드 없는 레거시 제안(stub 원본) → 여전히 통과(후방호환; stub 골든 바이트 불변 전제).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## S1(F5a) intake 계약 확장 — role·provenance(선택·사람 확정 전용)"

export HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-enrich-* 2>/dev/null || true; }
trap cleanup EXIT

# 표준 최소 첨부: wb.docx(working_backwards→converted) + product.webp(product_image→assets).
ATTACH="$SCRATCH/attach"; rm -rf "$ATTACH"; mkdir -p "$ATTACH"
printf 'DOCX-bytes-working-backwards\n' > "$ATTACH/wb.docx"
printf 'RIFFWEBP-image-bytes\n'         > "$ATTACH/product.webp"

RID="ci-enrich-1"
( cd "$ROOT" && bash scripts/intake.sh "$ATTACH" "$RID" --product "[브랜드] 릴리프" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/run-stage.sh intake "$RID" ) >/dev/null 2>&1
RDIR="$ROOT/runs/$RID"
PROP="$RDIR/00a-intake/intake-proposal.json"

# validate_stage 직접 호출 헬퍼(원 exit code 관측 — validate-stage.sh 래퍼는 rc 를 뭉갠다).
vstage() { ( cd "$ROOT" && python3 scripts/lib/validate_stage.py intake-proposal "$RDIR" ); }
schema_ok() { python3 "$ROOT/scripts/lib/harness.py" validate "$PROP" >/dev/null 2>&1; }
# 특정 category 를 가진 파일명 한 개(제안에서) — 주입 대상 선택용.
name_of_cat() { python3 -c "import json,sys;p=json.load(open('$PROP'));print(next((f['filename'] for f in p['files'] if f.get('category')==sys.argv[1]),''))" "$1"; }
# 지정 파일명에 role/provenance 주입(sha256·category 불변 → 다른 게이트 영향 없음).
inject() {  # inject <filename> <role|""> <provenance|"">
  python3 -c "
import json,sys
p='$PROP'; fn,role,prov=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p))
for f in d['files']:
    if f['filename']==fn:
        if role: f['role']=role
        else: f.pop('role',None)
        if prov: f['provenance']=prov
        else: f.pop('provenance',None)
json.dump(d,open(p,'w'),ensure_ascii=False)
" "$1" "$2" "$3"
}

# ─────────────────────────────────────────────────────────────────────────────
# (0) 셋업 온전성 + 레거시(필드 없음) 후방호환
# ─────────────────────────────────────────────────────────────────────────────
echo "# (0) 레거시(role/provenance 없는 stub 원본) 후방호환"
check "(0) stub 제안 생성됨" "[ -f '$PROP' ]"
IMG="$(name_of_cat product_image)"
WB="$(name_of_cat working_backwards)"
check "(0) product_image 파일 존재(product.webp)" "[ '$IMG' = 'product.webp' ]"
check "(0) working_backwards 파일 존재(wb.docx)" "[ '$WB' = 'wb.docx' ]"
check "(0) 레거시 제안 스키마 통과(새 필드 부재)" "schema_ok"
vstage >/dev/null 2>&1; check "(0) 레거시 제안 validate_stage 통과(rc=0)" "[ $? -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (1) role(product_image)+provenance → 스키마 + validate_stage 통과
# ─────────────────────────────────────────────────────────────────────────────
echo "# (1) role(product_image)+provenance 부착 → 통과"
inject "$IMG" "package_front" "브랜드 제공 원본"
check "(1) 스키마 통과(role enum + provenance string)" "schema_ok"
vstage >/dev/null 2>&1; check "(1) validate_stage 통과(product_image 에 role 허용, rc=0)" "[ $? -eq 0 ]"
# 잘못된 enum 값은 스키마가 거부(enum 방어 확인)
inject "$IMG" "not_a_role" "브랜드 제공 원본"
check "(1) role enum 밖 값 → 스키마 거부" "! schema_ok"
inject "$IMG" "usage_shot" "촬영본"   # 유효 값으로 복원

# ─────────────────────────────────────────────────────────────────────────────
# (2) role 이 비-product_image 파일에 → validate_stage 가 exit 24 로 거부
# ─────────────────────────────────────────────────────────────────────────────
echo "# (2) role 이 working_backwards 파일에 → validate_stage exit 24 거부"
inject "$WB" "package_front" ""
check "(2) 스키마 자체는 통과(닫힘/enum 위반 아님)" "schema_ok"
vstage >/dev/null 2>&1; RC=$?
check "(2) validate_stage 거부(rc≠0)" "[ $RC -ne 0 ]"
check "(2) 새 전용 exit code = 24" "[ $RC -eq 24 ]"
inject "$WB" "" ""   # role 제거 → 다시 통과 확인
vstage >/dev/null 2>&1; check "(2) role 제거 후 validate_stage 재통과(rc=0)" "[ $? -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (3) provenance 단독(role 없음)은 어느 category 든 허용(role 검사만 category 결속)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (3) provenance 단독은 비-product_image 에도 허용(role 없음)"
inject "$WB" "" "기획팀 초안 문서"
check "(3) provenance 단독 스키마 통과" "schema_ok"
vstage >/dev/null 2>&1; check "(3) provenance 단독 validate_stage 통과(role 없음 → 24 미발동)" "[ $? -eq 0 ]"

echo "intake-enrich: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
