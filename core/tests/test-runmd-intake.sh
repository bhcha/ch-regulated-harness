#!/usr/bin/env bash
# test-runmd-intake.sh — 00a-intake 분류표 강화(F5-b) 회귀 가드.
#   render_runmd._intake_section 이 role/provenance/썸네일을 'render-if-present' 로 더한다:
#     (1) role+provenance+이미지 파일 → run.md 에 썸네일 링크 + '출처:' + 한국어 role 라벨.
#     (2) 새 필드 없음(비이미지 파일) → intake 표 슬라이스가 변경 전(HEAD)과 바이트 동일.
#     (3) no-intake 런(phase != 00a-intake) → intake 표 자체가 없음(early-return 보존).
#   결정적·오프라인·헤르메틱. run.md 는 골든 아님 — 이 테스트가 강화분의 유일 회귀 가드다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 00a-intake 분류표 강화(F5-b): 썸네일 + 출처 + 역할 라벨"

REPO="$(cd "$ROOT/.." && pwd)"
BASELINE="$ROOT/scripts/lib/_runmd_baseline_tmp.py"   # HEAD 버전 임시 복사(lib 디렉터리 내 — 형제 모듈 import 보존)
cleanup() { rm -rf "$ROOT"/runs/ci-runmd-* 2>/dev/null || true; rm -f "$BASELINE" 2>/dev/null || true; }
trap cleanup EXIT

HEX64="0000000000000000000000000000000000000000000000000000000000000000"

render() {  # render <rid> <rdir> [module_path]
  local rid="$1" rdir="$2" mod="${3:-$ROOT/scripts/lib/render_runmd.py}"
  HARNESS_ROOT="$ROOT" python3 "$mod" "$rid" "$rdir" >/dev/null 2>&1
}

# intake 섹션 슬라이스 추출('## 첨부 자료 분류' 헤더 ~ '## 진행 현황' 직전, 후행 공백 라인 제거).
intake_slice() {  # intake_slice <run.md 경로>
  python3 - "$1" <<'PY'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
out, grab = [], False
for ln in lines:
    if ln.startswith("## 첨부 자료 분류"):
        grab = True
    elif grab and ln.startswith("## 진행 현황"):
        break
    if grab:
        out.append(ln)
while out and out[-1].strip() == "":
    out.pop()
print("\n".join(out))
PY
}

mk_state() {  # mk_state <rdir> <phase>
  mkdir -p "$1"
  cat > "$1/state.json" <<J
{"run_id":"r","phase":"$2","step":"generate","status":"generate","gate":"generate","awaiting":null,
 "storyboard_substage":"plan","iteration":1,"max_iterations":4,"revise_count":0,"history":[],
 "product":{"name":"t","regulatory_domain":"cosmetic","deliverable_format":"multipage_bm"}}
J
}

# ─────────────────────────────────────────────────────────────────────────────
# (1) role + provenance + 이미지 파일 → 썸네일 링크 + '출처:' + 한국어 role 라벨
# ─────────────────────────────────────────────────────────────────────────────
echo "# (1) role+provenance+이미지 → 강화 렌더"
R1="$ROOT/runs/ci-runmd-rich"; rm -rf "$R1"; mk_state "$R1" 00a-intake
mkdir -p "$R1/00a-intake"
cat > "$R1/00a-intake/intake-proposal.json" <<J
{"product_name_declared":"테스트 제품","aggregate_preview":"이미지 1건 → 자사 컷",
 "files":[
   {"filename":"product-front.png","sha256":"$HEX64","category":"product_image","route":"assets",
    "reflect_preview":"메인 비주얼","rationale":"png 확장자","confidence":"high","actions":["none"],
    "role":"package_front","provenance":"브랜드 공식몰"}
 ]}
J
render ci-runmd-rich "$R1"
check "(1) run.md 생성됨" "[ -f '$R1/run.md' ]"
check "(1) 썸네일 상대경로 링크(inputs/attachments/)" \
  "grep -qF '![](inputs/attachments/product-front.png)' '$R1/run.md'"
check "(1) provenance → '출처:' 노출" "grep -qF '출처: 브랜드 공식몰' '$R1/run.md'"
check "(1) role 한국어 라벨(package_front → 제품 정면컷)" "grep -qF '제품 정면컷' '$R1/run.md'"
check "(1) role 내부 코드(package_front) 미노출" "! grep -qF 'package_front' '$R1/run.md'"

# ─────────────────────────────────────────────────────────────────────────────
# (2) 새 필드 없음(비이미지) → intake 슬라이스가 변경 전(HEAD)과 바이트 동일
# ─────────────────────────────────────────────────────────────────────────────
echo "# (2) 새 필드/이미지 없음 → HEAD 렌더와 바이트 동일"
R2="$ROOT/runs/ci-runmd-plain"; rm -rf "$R2"; mk_state "$R2" 00a-intake
mkdir -p "$R2/00a-intake"
cat > "$R2/00a-intake/intake-proposal.json" <<J
{"product_name_declared":"테스트 제품","aggregate_preview":"문서 1건 → 참고",
 "files":[
   {"filename":"wb.docx","sha256":"$HEX64","category":"working_backwards","route":"working_backwards",
    "reflect_preview":"제품 기획","rationale":"docx 확장자","confidence":"high","actions":["converted"]}
 ]}
J
# HEAD(변경 전) render_runmd 를 lib 디렉터리 내 임시 파일로 복원(형제 모듈 import 경로 보존).
if git -C "$REPO" show HEAD:core/scripts/lib/render_runmd.py > "$BASELINE" 2>/dev/null && [ -s "$BASELINE" ]; then
  render ci-runmd-plain "$R2" "$BASELINE"; BASE_SLICE="$(intake_slice "$R2/run.md")"
  render ci-runmd-plain "$R2";            CUR_SLICE="$(intake_slice "$R2/run.md")"
  check "(2) HEAD 버전에서도 intake 표 존재(비교 유효)" "[ -n \"\$BASE_SLICE\" ]"
  check "(2) 새 필드 없는 행 = 변경 전과 바이트 동일" "[ \"\$BASE_SLICE\" = \"\$CUR_SLICE\" ]"
  check "(2) 썸네일/출처/role 라벨 누수 0(비이미지·무필드)" \
    "! grep -qE '!\\[\\]\\(inputs/attachments|출처:|제품 정면컷|사용 장면|성분 설명 패널' '$R2/run.md'"
else
  fail "(2) HEAD 렌더 베이스라인 확보 실패(git show)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (3) no-intake 런(phase != 00a-intake) → intake 표 자체가 없음(early-return 보존)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (3) no-intake 런 → intake 표 미등장"
R3="$ROOT/runs/ci-runmd-noin"; rm -rf "$R3"; mk_state "$R3" 01-brief
render ci-runmd-noin "$R3"
check "(3) run.md 생성됨(진행 보드 존재)" "grep -q '## 진행 현황' '$R3/run.md'"
check "(3) intake 표 미등장(early-return 보존)" "! grep -q '## 첨부 자료 분류' '$R3/run.md'"

printf '\n[runmd-intake] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
