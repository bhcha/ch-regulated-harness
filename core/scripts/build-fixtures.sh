#!/usr/bin/env bash
# build-fixtures.sh — 단계 경계 '골든 핸드오프 픽스처' 생성 (결정적 stub).
#   각 픽스처 = 앞 단계가 끝난 시점의 run 디렉터리 = 다음 단계의 '동결된 입력 계약'.
#   → 컨셉/콘티/키비주얼은 이 픽스처만으로 앞 단계 없이 단독 검증된다(tests/stage-*.sh).
#   계약을 재협의할 때만 재생성하고 커밋한다(frozen golden).
#
# 파라미터화(팩 분리 0단계 C): 규제도메인을 인자로 받는다(도메인-중립 커널). 무인자 = cosmetic 기본이며
#   그 경로는 구 동작과 '바이트 동일'(같은 명령·순서·기본값 → fixtures/{concept,conti,keyvisual}-in 그대로).
#   비-cosmetic 은 fixtures/<domain>/<boundary>-in 에 스냅샷하고, '도달한 경계'만 찍는다(예: drug 는
#   storyboard-plan 에서 심의 미통과가 반복돼 escalate → 04-keyvisual 미도달 → keyvisual 스냅 자동 생략).
#   사용: bash scripts/build-fixtures.sh [--domain <d>] [--wb <path>] [--bundle <path>]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
PACKS_DIR="${PACKS_DIR:-$(cd "$ROOT/.." && pwd)/packs}"   # 8단계: cosmetic 픽스처·골든이 packs/cosmetic/ 로 이전

# ── 인자 파싱(전부 선택; 미지정 시 cosmetic 기본으로 구 동작 재현) ──
DOMAIN="cosmetic"; ARG_WB=""; ARG_BUNDLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain 값 필요}"; shift 2 ;;
    --wb)     ARG_WB="${2:?--wb 값 필요}"; shift 2 ;;
    --bundle) ARG_BUNDLE="${2:?--bundle 값 필요}"; shift 2 ;;
    *) echo "알 수 없는 인자: $1 (사용: --domain/--wb/--bundle)" >&2; exit 2 ;;
  esac
done

RID="_fixture_build"
# 기본 번들 = 커밋 가능한 합성 픽스처(tests/fixtures/bundle-cosmetic — 실제 크롤 naver_*/ 는 저작권상 커밋불가라
#   심링크 제거·decouple). 다른 번들로 재생성하려면 --bundle(또는 TEST_BUNDLE) 지정(docs/reference/deployment.md).
BUNDLE="${ARG_BUNDLE:-${TEST_BUNDLE:-$ROOT/tests/fixtures/bundle-cosmetic}}"
# WB 는 테스트 픽스처(cosmetic 샘플)로 고정 — 운영 WB(중립 템플릿)와 분리(lib.sh 와 동일).
#   이게 없으면 재생성 시 템플릿으로 fixtures/*-in 이 만들어져 핸드오프 계약이 비게 된다(외부리뷰 medium).
export HARNESS_CLI=stub HARNESS_OFFLINE=1 HARNESS_DOMAIN="$DOMAIN" HARNESS_FORMAT=multipage_bm
export HARNESS_WB="${ARG_WB:-${HARNESS_WB:-$PACKS_DIR/cosmetic/golden/working-backwards.md}}"
# 사례 corpus 격리(재현성): 로컬 inputs/examples/<도메인> 존재 시 ingest 가 00g 로 라우팅해 핸드오프 직행이
#   깨진다(lib.sh:30 과 동일 사상). 빈 사례 베이스를 hermetic 기본값으로 걸어 머신 무관하게 직행을 재현(명시 override 보존).
export HARNESS_EXAMPLES_DIR="${HARNESS_EXAMPLES_DIR:-$ROOT/tests/golden/_no-examples}"; mkdir -p "$ROOT/tests/golden/_no-examples"
# 스냅 루트: cosmetic 은 fixtures/<boundary>-in(바이트 불변), 그 외는 fixtures/<domain>/<boundary>-in.
SNAP_ROOT="$PACKS_DIR/$DOMAIN/fixtures"   # 8단계: 전 도메인 경계 픽스처를 packs/<도메인>/fixtures 가 소유(균일)
rm -rf "runs/$RID"

snap() {  # snap <boundary> <expected_phase> — '도달한 경계'만 run-dir 스냅샷(휘발성 .lock·run.md 제외)
  local b="$1" want="$2"; local cur
  cur="$(python3 scripts/lib/harness.py jget "runs/$RID/state.json" phase)"
  if [ "$want" != "$cur" ]; then
    # 조기 종료(escalate 등)로 그 경계에 도달하지 못함 → 스냅 생략(3-경계 시퀀스 하드코딩 금지).
    #   이전 재생성에서 남은 stale 스냅샷은 제거(멱등: 이번 런에서 미도달인 경계가 옛 파일로 커밋/테스트에 새면 안 됨, 외부리뷰 P2).
    rm -rf "$SNAP_ROOT/$b-in"
    echo "  ⊘ $SNAP_ROOT/$b-in 생략 (phase=$cur ≠ 기대 $want — 조기 종료/미도달; stale 제거)"
    return 0
  fi
  local dst="$SNAP_ROOT/$b-in"
  rm -rf "$dst"; mkdir -p "$SNAP_ROOT"
  cp -R "runs/$RID" "$dst"; rm -rf "$dst/.lock" "$dst/run.md"
  echo "  ✓ $dst (phase=$cur)"
}

step() { bash "scripts/$1" "${@:2}" >/dev/null 2>&1; }

# 브리프(인입→브리프 승인) → phase 02-concept
step ingest-bundle.sh "$BUNDLE" "$RID"
step run-stage.sh brief "$RID"; step approve.sh "$RID" --ra-ok; step kcia-check.sh "$RID"
snap concept 02-concept

# 컨셉(생성→심의→선택) → phase 03-storyboard
step run-stage.sh concept "$RID"; step select.sh "$RID" B; step kcia-check.sh "$RID"
snap conti 03-storyboard

# 콘티(아웃라인→톤→기획안) → phase 04-keyvisual (도메인이 plan 에서 escalate 하면 미도달 → snap 자동 생략)
step run-stage.sh storyboard-outline "$RID"; step select.sh "$RID" A; step kcia-check.sh "$RID"
step run-stage.sh storyboard-plan "$RID"; step approve.sh "$RID"; step kcia-check.sh "$RID"
snap keyvisual 04-keyvisual

rm -rf "runs/$RID"
echo "픽스처 생성 완료: $SNAP_ROOT/{concept,conti,keyvisual}-in 중 도달분 (frozen 핸드오프 계약)"
