#!/usr/bin/env bash
# test-asset-role.sh — F5c 자산 역할(role) 전파 회귀 가드. 결정적·오프라인(stub)·헤르메틱.
#   S1(sibling)이 intake-proposal 계약에 사람-선언 role(product_image 전용)을 이미 추가했다. F5c(이 단계)는 그 role 을
#   승인 발효 시 자산 매니페스트까지 '전파'해 하류 master_reference 선택이 package_front 를 우선하게 한다.
#   전파 사슬: apply-intake → routed/assets/asset-roles.json(사이드카) → ingest-bundle 이 inputs/assets 로 복사 →
#             cmd_assets 가 매칭 엔트리에만 role 을 붙여 00-ingest/assets-manifest.json 에 기록.
#   골든 불변: role 이 하나도 없으면 사이드카를 만들지 않고 매니페스트 바이트도 그대로 둔다(기존/골든 런 불변).
#
#   (1) cmd_assets 단위: 사이드카 없음/미매칭 → 매니페스트 바이트 불변(골든 invariant) · 매칭 → role 부착·스키마 유효.
#   (2) apply-intake E2E: role 선언 → 사이드카·매니페스트 role 전파 · role 전무 → 사이드카 미생성·매니페스트 role 부재.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## F5c 자산 역할(role) 전파 — apply-intake 사이드카 → assets-manifest"

export HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-assetrole-* 2>/dev/null || true; }
trap cleanup EXIT

PY="python3"
INGEST="$ROOT/scripts/lib/ingest.py"
HP="$ROOT/scripts/lib/harness.py"

run_assets() {  # run_assets <bundle_images_dir> <own_dir> <out.json>
  ( cd "$ROOT" && HARNESS_ROOT="$ROOT" "$PY" "$INGEST" assets "$1" "$2" "$3" ) >/dev/null 2>&1
}
validate_manifest() {  # validate_manifest <manifest.json> — 명시 스키마(임의 경로 검증)
  "$PY" "$HP" validate "$1" --schema assets-manifest.schema.json >/dev/null 2>&1
}
manifest_role() {  # manifest_role <manifest.json> <filename> → role 문자열(또는 빈값)
  "$PY" -c "import json,sys;m=json.load(open('$1'));e=[f for f in m['own_assets']['files'] if f['path'].endswith('/$2')];print(e[0].get('role','') if e else '')"
}
manifest_has_any_role() {  # <manifest.json> → exit 0 if any own_asset entry has a role key
  "$PY" -c "import json,sys;m=json.load(open('$1'));sys.exit(0 if any('role' in f for f in m['own_assets']['files']) else 1)"
}
manifest_own_count() {  # <manifest.json> → own_assets.files 길이
  "$PY" -c "import json;m=json.load(open('$1'));print(len(m['own_assets']['files']))"
}

# ─────────────────────────────────────────────────────────────────────────────
# (1) cmd_assets 단위 — 사이드카 부재/미매칭 = 바이트 불변(골든 invariant) · 매칭 = role 부착
# ─────────────────────────────────────────────────────────────────────────────
echo "# (1) cmd_assets 단위: 사이드카 유무별 매니페스트"
NOBUNDLE="$SCRATCH/nobundle"          # 존재하지 않는 번들 이미지 경로 → detail/main 0장(_scan_images 안전)
OWN="$SCRATCH/own"; mkdir -p "$OWN"
printf 'RIFFWEBP-image-bytes\n' > "$OWN/product.webp"

# (1-a) 사이드카 없음 → 기준(pre-change 동작과 동일: role 코드가 no-op)
run_assets "$NOBUNDLE" "$OWN" "$SCRATCH/m-nosidecar.json"
check "(1a) 사이드카 없음 → 매니페스트 생성" "[ -f '$SCRATCH/m-nosidecar.json' ]"
check "(1a) 사이드카 없음 → 스키마 유효" "validate_manifest '$SCRATCH/m-nosidecar.json'"
check "(1a) 사이드카 없음 → role 키 없음(무구분)" "! manifest_has_any_role '$SCRATCH/m-nosidecar.json'"

# (1-b) 사이드카 있으나 미매칭(존재하지 않는 파일명) → 바이트 불변(golden invariant)
printf '{"nope.webp":"logo"}\n' > "$OWN/asset-roles.json"
run_assets "$NOBUNDLE" "$OWN" "$SCRATCH/m-nomatch.json"
check "(1b) 미매칭 사이드카 → 매니페스트 바이트 불변(골든 invariant)" "cmp -s '$SCRATCH/m-nosidecar.json' '$SCRATCH/m-nomatch.json'"
check "(1b) 미매칭 사이드카(.json)는 자산 풀에서 제외(count=1 불변)" "[ \"\$(manifest_own_count '$SCRATCH/m-nomatch.json')\" = '1' ]"

# (1-c) 사이드카 매칭 → 해당 엔트리에만 role 부착 + 스키마 유효
printf '{"product.webp":"package_front"}\n' > "$OWN/asset-roles.json"
run_assets "$NOBUNDLE" "$OWN" "$SCRATCH/m-role.json"
check "(1c) 매칭 사이드카 → product.webp entry role=package_front" "[ \"\$(manifest_role '$SCRATCH/m-role.json' product.webp)\" = 'package_front' ]"
check "(1c) 매칭 매니페스트 스키마 유효(role enum 허용)" "validate_manifest '$SCRATCH/m-role.json'"
check "(1c) 사이드카(.json)는 여전히 자산 풀 밖(count=1)" "[ \"\$(manifest_own_count '$SCRATCH/m-role.json')\" = '1' ]"
check "(1c) role 부착본은 기준과 다름(role 만 추가)" "! cmp -s '$SCRATCH/m-nosidecar.json' '$SCRATCH/m-role.json'"

# ─────────────────────────────────────────────────────────────────────────────
# (2) apply-intake E2E — 승인 발효로 role 이 사이드카·매니페스트까지 전파
# ─────────────────────────────────────────────────────────────────────────────
echo "# (2) apply-intake E2E: 승인 발효 → 사이드카 → assets-manifest role"
mk_fixture() {  # mk_fixture <dir> — wb.docx(워킹백워드) + product.webp(자사 이미지)
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  printf 'DOCX-bytes-working-backwards\n' > "$d/wb.docx"
  printf 'RIFFWEBP-image-bytes\n'         > "$d/product.webp"
}
intake_run() {  # intake_run <dir> <rid>
  ( cd "$ROOT" && bash scripts/intake.sh "$1" "$2" --product "[브랜드] 릴리프" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
}

# (2-a) role 선언 → 전파
echo "# (2a) role=package_front 선언 → 사이드카·매니페스트 전파"
mk_fixture "$SCRATCH/attach_role"
intake_run "$SCRATCH/attach_role" ci-assetrole-a
AR="$ROOT/runs/ci-assetrole-a"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-assetrole-a ) >/dev/null 2>&1
# 사람 승인 선언 모사: 제안의 product_image 행에 role=package_front 주입(sha256 은 첨부 바이트 기준이라 무영향).
"$PY" -c "
import json
p='$AR/00a-intake/intake-proposal.json'; d=json.load(open(p))
for f in d['files']:
    if f.get('category')=='product_image':
        f['role']='package_front'
json.dump(d,open(p,'w'),ensure_ascii=False)"
( cd "$ROOT" && bash scripts/approve.sh ci-assetrole-a ) >/dev/null 2>&1; RC=$?
check "(2a) role 주입 제안 → approve 성공(role 은 product_image 에 허용)" "[ $RC -eq 0 ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-assetrole-a ) >/dev/null 2>&1; RC=$?
check "(2a) kcia autopass → apply-intake+ingest 연쇄 성공(rc=0)" "[ $RC -eq 0 ]"
check "(2a) routed/assets/asset-roles.json 생성" "[ -f '$AR/00a-intake/routed/assets/asset-roles.json' ]"
check "(2a) 사이드카 매핑 product.webp→package_front" \
  "[ \"\$($PY -c \"import json;print(json.load(open('$AR/00a-intake/routed/assets/asset-roles.json')).get('product.webp',''))\")\" = 'package_front' ]"
check "(2a) 사이드카가 inputs/assets 로 복사됨(own_dir 로 흐름)" "[ -f '$AR/inputs/assets/asset-roles.json' ]"
check "(2a) 사이드카는 자산 풀에 안 실림(assets-manifest 에 asset-roles.json 부재)" \
  "! $PY -c \"import json,sys;m=json.load(open('$AR/00-ingest/assets-manifest.json'));sys.exit(0 if any(f['path'].endswith('asset-roles.json') for f in m['own_assets']['files']) else 1)\""
check "(2a) assets-manifest product.webp role=package_front" \
  "[ \"\$(manifest_role '$AR/00-ingest/assets-manifest.json' product.webp)\" = 'package_front' ]"
check "(2a) assets-manifest 스키마 유효" "validate_manifest '$AR/00-ingest/assets-manifest.json'"

# (2-b) role 전무 → 사이드카 미생성·매니페스트 role 부재(골든 불변)
echo "# (2b) role 전무 → 사이드카 미생성·매니페스트 role 부재(골든 불변)"
mk_fixture "$SCRATCH/attach_norole"
intake_run "$SCRATCH/attach_norole" ci-assetrole-b
NR="$ROOT/runs/ci-assetrole-b"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-assetrole-b ) >/dev/null 2>&1   # stub 제안엔 role 없음
( cd "$ROOT" && bash scripts/approve.sh ci-assetrole-b && bash scripts/kcia-check.sh ci-assetrole-b ) >/dev/null 2>&1; RC=$?
check "(2b) 체인 완주(rc=0)" "[ $RC -eq 0 ]"
check "(2b) role 전무 → routed/assets/asset-roles.json 미생성" "[ ! -f '$NR/00a-intake/routed/assets/asset-roles.json' ]"
check "(2b) role 전무 → inputs/assets/asset-roles.json 미생성" "[ ! -f '$NR/inputs/assets/asset-roles.json' ]"
check "(2b) role 전무 → assets-manifest 에 role 키 부재(골든 불변)" "! manifest_has_any_role '$NR/00-ingest/assets-manifest.json'"
check "(2b) role 전무 → assets-manifest 스키마 유효" "validate_manifest '$NR/00-ingest/assets-manifest.json'"

echo "asset-role: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
