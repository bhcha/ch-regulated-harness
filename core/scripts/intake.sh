#!/usr/bin/env bash
# intake.sh — 첨부 폴더 하나를 받아 런 생성 + 첨부 스냅샷(불변 보존·sha256) + zip 읽기전용 해체 (00a-intake 정문).
#   opt-in 새 채널: 이 채널로 시작한 런만 00a-intake 페이즈로 진입한다(기존 new-run/ingest-bundle 은 무영향 →
#   no-intake 런 골든 바이트 불변). 분류·라우팅 발효는 하류(run-stage intake 제안 → approve → W-2 apply-intake).
# 사용법: bash scripts/intake.sh <첨부폴더> <run_id> --product "제품명" --domain <화장품|의약외품|건기식|의약품> --format <한장|여러장>
#   제품명·도메인·포맷은 사람 선언 인자(AGENTS 8절 — AI 자동분류 없음). 제품명은 자사/타사 크롤 구분의 대조 기준.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

ATTACH_SRC="${1:-}"; shift || true
RID="${1:-}"; shift || true
[ -n "$ATTACH_SRC" ] || die "첨부 폴더 경로가 필요합니다. 예: bash scripts/intake.sh <첨부폴더> my-product-2026 --product \"[브랜드] 제품명\" --domain 화장품 --format 여러장"
[ -d "$ATTACH_SRC" ] || die "첨부 폴더가 없거나 폴더가 아닙니다: $ATTACH_SRC"
[ -n "$RID" ] || die "run_id 가 필요합니다. 예: bash scripts/intake.sh $ATTACH_SRC my-product-2026 --product \"제품명\" --domain 화장품 --format 여러장"
# ★ 외부리뷰 W4-R7: run_id 는 apply-intake 의 안전 토큰(_safe_path_token: [A-Za-z0-9._-])과 '동일 규칙'으로 생성단계에서
#   강제한다 — 안 그러면 한글·비ASCII id 런이 스테이징·생성·승인·autopass 까지 통과한 뒤 gate.sh 의 apply-intake 에서만
#   실패해 승인된 인입이 인입 불가(wedge)가 된다. 생성 앞에서 fail-closed 하는 게 일관·안전하다.
case "$RID" in
  *[!A-Za-z0-9._-]*|""|.|..) die "run_id 는 영문/숫자/._- 만 쓸 수 있습니다(한글·공백·특수문자 불가): '$RID'. 예: relief-cushion-2026" ;;
esac

PRODUCT_NAME="제품"; PRODUCT_TYPE="general"; ARG_DOMAIN=""; ARG_FORMAT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --product) PRODUCT_NAME="${2:-$PRODUCT_NAME}"; shift 2 ;;
    --name)    PRODUCT_NAME="${2:-$PRODUCT_NAME}"; shift 2 ;;
    --domain)  ARG_DOMAIN="${2:-}"; shift 2 ;;
    --format)  ARG_FORMAT="${2:-}"; shift 2 ;;
    --type)    PRODUCT_TYPE="${2:-$PRODUCT_TYPE}"; shift 2 ;;
    *) shift ;;
  esac
done

# 별칭 정규화 + 레지스트리 검증(new-run.sh 와 동일 규칙; domain_field 는 common.sh). 미등록/미지정 → 빈 문자열(die).
normalize_domain() {
  local resolved; resolved="$(domain_alias_resolve "$1")"
  { [ -n "$resolved" ] && [ -n "$(domain_field "$resolved" domain)" ]; } && printf '%s' "$resolved" || printf ''
}
normalize_format() { format_alias_resolve "$1"; }

REG_DOMAIN="$(normalize_domain "${ARG_DOMAIN:-${HARNESS_DOMAIN:-}}")"
DELIV_FORMAT="$(normalize_format "${ARG_FORMAT:-${HARNESS_FORMAT:-}}")"
[ -n "$REG_DOMAIN" ] || die "⓪ 유형 선언이 필요합니다 — 규제도메인: --domain <화장품|의약외품|건기식|의약품> (지정값: '${ARG_DOMAIN:-${HARNESS_DOMAIN:-(없음)}}')"
[ -n "$DELIV_FORMAT" ] || die "⓪ 유형 선언이 필요합니다 — 산출물 포맷: --format <한장|여러장> (지정값: '${ARG_FORMAT:-${HARNESS_FORMAT:-(없음)}}')"

RDIR="$(run_dir "$RID")"
SF="$(state_file "$RID")"
if [ -f "$SF" ]; then
  info "이미 존재합니다: $SF (재사용 — 첨부 스냅샷/상태를 덮지 않습니다)"; exit 0
fi

# per-run 계약: 00-ingest(하류 가공물)·inputs(원시 입력)·00a-intake(제안) 표준 디렉터리.
mkdir -p "$RDIR/00-ingest" "$RDIR/inputs" "$RDIR/00a-intake"

# ── 첨부 스냅샷(불변 보존): 원본을 runs/<id>/inputs/attachments/ 로 바이트 복사(.DS_Store 제외) ──
#   최상위 파일이 분류 대상(스냅샷 파일). 최상위 디렉터리는 원본 보존용으로 함께 복사하되 분류 열거에선 제외한다
#   (디렉터리 기반 크롤 라우팅 발효는 W-2). zip 은 아래에서 _unpacked/ 로 읽기전용 전개(분석 편의).
ADST="$RDIR/inputs/attachments"
mkdir -p "$ADST"
have_unzip=0; command -v unzip >/dev/null 2>&1 && have_unzip=1
zip_present=0
while IFS= read -r -d '' src; do
  bn="$(basename "$src")"
  [ "$bn" = ".DS_Store" ] && continue
  [ "$bn" = "_unpacked" ] && continue   # 예약 이름 충돌 회피
  if [ -d "$src" ]; then
    cp -R "$src" "$ADST/"
  else
    cp -f "$src" "$ADST/$bn"
    case "$bn" in *.zip|*.ZIP) zip_present=1 ;; esac
  fi
done < <(find "$ATTACH_SRC" -mindepth 1 -maxdepth 1 \( -type f -o -type d \) -print0)
find "$ADST" -name '.DS_Store' -delete 2>/dev/null || true

# zip 도구 부재 + zip 존재 = fail-closed(포터블 선례: ingest-bundle poppler). 조용한 누락 금지.
if [ "$zip_present" = "1" ] && [ "$have_unzip" != "1" ]; then
  die "첨부에 zip 이 있는데 'unzip' 이 설치돼 있지 않아 해체할 수 없습니다(fail-closed) — unzip 을 설치하거나 압축을 미리 풀어 다시 시도하세요."
fi
# zip 읽기전용 전개(_unpacked/<zipname>/) — 분석 편의(라우팅은 스냅샷 원본 기준).
if [ "$zip_present" = "1" ]; then
  UNP="$ADST/_unpacked"; mkdir -p "$UNP"
  while IFS= read -r -d '' z; do
    zn="$(basename "$z")"; zdir="$UNP/$zn"; mkdir -p "$zdir"
    unzip -o -q "$z" -d "$zdir" >/dev/null 2>&1 || die "zip 해체 실패: $zn — 손상된 압축이거나 지원되지 않는 형식입니다."
  done < <(find "$ADST" -maxdepth 1 -type f \( -iname '*.zip' \) -print0)
  find "$UNP" -name '.DS_Store' -delete 2>/dev/null || true
fi

# sha256 사이드카(감사·불변 대조): 최상위 스냅샷 파일별 해시. validate/approve 가 실제 파일과 재대조(위변조 fail-closed).
"$PY" - "$ADST" <<'PYEOF'
import sys, os, hashlib
adir = sys.argv[1]
lines = []
for fn in sorted(os.listdir(adir)):
    if fn.startswith("."):
        continue
    p = os.path.join(adir, fn)
    if not os.path.isfile(p):
        continue
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    lines.append("%s  %s" % (h, fn))
with open(os.path.join(adir, ".sha256sums"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + ("\n" if lines else ""))
PYEOF

# WS-ROUTES/WS-DESC 무결성부터 검증(닫힌 스키마+체인) — state 를 쓰기 전에.
route_assert_valid

TS="$(now)"
# 00a-intake 는 조건부 페이즈(off-mainline) — 자체 max_iterations 를 라우트 테이블에서. 스캐폴딩은 common.sh scaffold_state 공용(new-run 과 1곳화).
INTAKE_MAX="$(route_max_iter "00a-intake")"
scaffold_state "$SF" "$RID" "$PRODUCT_NAME" "$PRODUCT_TYPE" "$TS" "$REG_DOMAIN" "$DELIV_FORMAT" "00a-intake" "$INTAKE_MAX" "intake:staged" "intake.sh"

validate_artifact "$SF" >/dev/null
ok "첨부 인입 스테이징: $RID (도메인=$REG_DOMAIN · 포맷=$DELIV_FORMAT · 첨부 스냅샷 완료)"
bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
info "다음: bash scripts/run-stage.sh intake $RID  (첨부를 분류해 제안 → 승인)"
