#!/usr/bin/env bash
# new-run.sh — state.json 스캐폴딩 (안전 기본값: 근거 없는 효능 = unknown/[]).
# 사용법: bash scripts/new-run.sh <run_id> --domain <화장품|의약외품|건기식|의약품> --format <한장|여러장> ["제품명"]
#   ⓪ 유형 선언이 '가장 먼저' 강제된다(브리프 1단계). 도메인=심의 룰셋, 포맷=캐논/구조.
#   도메인/포맷 미지정 시 HARNESS_DOMAIN/HARNESS_FORMAT 환경변수로 폴백, 그래도 없으면 친절히 중단.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; shift || true
[ -n "$RID" ] || die "run_id 가 필요합니다. 예: bash scripts/new-run.sh my-product-2026 --domain 화장품 --format 여러장 --name \"[브랜드] 제품명\""

# 제품명/유형은 중립 기본값(특정 제품 하드코딩 제거). 실제 값은 --name/--type 또는 ingest-bundle 이 product.json 에서 주입.
#   제품명 앞 '[브랜드 …]' 접두가 있으면 브랜드 배너가 활성(없으면 브랜드 배너 면제 — 범용화).
PRODUCT_NAME="제품"
PRODUCT_TYPE="general"
ARG_DOMAIN=""; ARG_FORMAT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) ARG_DOMAIN="${2:-}"; shift 2 ;;
    --format) ARG_FORMAT="${2:-}"; shift 2 ;;
    --name)   PRODUCT_NAME="${2:-$PRODUCT_NAME}"; shift 2 ;;
    --type)   PRODUCT_TYPE="${2:-$PRODUCT_TYPE}"; shift 2 ;;
    *) shift ;;
  esac
done

# 별칭 정규화(한국어/영문 → 표준 id) + 레지스트리 검증. 미등록 값은 빈 문자열(상위 die).
#   ★ 단계4(C 메커니즘 — domain): 하드코딩 4개 enum → '레지스트리(packs/*/domain.json 조립, base∪pack) 등록 키' 합집합으로 완화.
#     새 도메인 = 팩 폴더 추가만으로 수용(core 무수정) — phase 와 동일 'core-base 동결 ∪ pack-기여(검증)' 철학.
#     known 한국어/영문 별칭은 인체공학상 유지(base-4); 그 외 입력은 '표준 id 후보'로 보고 레지스트리에 있을 때만 수용.
#     (손상 팩은 레지스트리에 status="" 로 남아 domain_field 가 키를 돌려주지만 → kcia-check 가 active 기본→엔진 fail-closed. 안전 방향.)
normalize_domain() {
  local resolved; resolved="$(domain_alias_resolve "$1")"
  { [ -n "$resolved" ] && [ -n "$(domain_field "$resolved" domain)" ]; } && printf '%s' "$resolved" || printf ''
}
normalize_format() { format_alias_resolve "$1"; }

REG_DOMAIN="$(normalize_domain "${ARG_DOMAIN:-${HARNESS_DOMAIN:-}}")"
DELIV_FORMAT="$(normalize_format "${ARG_FORMAT:-${HARNESS_FORMAT:-}}")"
[ -n "$REG_DOMAIN" ] || die "⓪ 유형 선언이 필요합니다 — 규제도메인: --domain <화장품|의약외품|건기식|의약품> (지정값: '${ARG_DOMAIN:-${HARNESS_DOMAIN:-(없음)}}'). $("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" registered-domains 2>/dev/null)"
[ -n "$DELIV_FORMAT" ] || die "⓪ 유형 선언이 필요합니다 — 산출물 포맷: --format <한장|여러장> (지정값: '${ARG_FORMAT:-${HARNESS_FORMAT:-(없음)}}')"

RDIR="$(run_dir "$RID")"
SF="$(state_file "$RID")"
if [ -f "$SF" ]; then
  info "이미 존재합니다: $SF (재사용)"; exit 0
fi
# per-run 계약: inputs/(모든 원시 입력 — working-backwards·assets·examples·bundle)도 런 표준 디렉터리. ingest 가 여기로 스냅샷.
mkdir -p "$RDIR/00-ingest" "$RDIR/inputs"

# WS-ROUTES: 진입 페이즈/초기 max_iterations 를 라우트 테이블에서 읽기 전에 테이블 무결성부터 검증(닫힌 스키마+체인).
route_assert_valid

TS="$(now)"
# WS-ROUTES: 진입 페이즈 + 초기 max_iterations 는 라우트 테이블에서(단일 출처). 스캐폴딩은 common.sh scaffold_state 공용.
ENTRY="$(jget "$ROUTES_FILE" entry)"; ENTRY_MAX="$(route_max_iter "$ENTRY")"
scaffold_state "$SF" "$RID" "$PRODUCT_NAME" "$PRODUCT_TYPE" "$TS" "$REG_DOMAIN" "$DELIV_FORMAT" "$ENTRY" "$ENTRY_MAX" "run:created" "new-run.sh"

validate_artifact "$SF" >/dev/null
ok "실행 생성: $RID (도메인=$REG_DOMAIN · 포맷=$DELIV_FORMAT)"
bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
info "다음: bash scripts/ingest-bundle.sh <번들폴더> $RID"
