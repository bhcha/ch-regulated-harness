#!/usr/bin/env bash
# capture-fixtures.sh — next-action 계약 픽스처(대표 상태별 JSON) 재생성.
#
#   core `scripts/next-action.sh <rid>` 가 내보내는 한 줄 JSON = 챗 어댑터 버튼/카드의 단일 SSoT다.
#   그 계약을 '대표 상태'별로 결정적으로 캡처해 contract.test.ts 가 스냅샷 검증하도록 한다.
#
# 경로: test-b8 sanctioned stub 경로를 그대로 따른다(브리프 구간 known-good).
#   ingest-bundle.sh <bundle> <rid> → run-stage guideline → approve → kcia-check → run-stage brief → ...
#   ⚠ new-run --format 여러장 으로 00g 를 '태우지' 않는다(그 stub 산출물이 validate-stage 금지토큰에 걸려 review 정지 —
#     dev-loop-grounding 5). ingest-bundle 직접 경로만 쓴다. (new-run 은 phase=00-ingest '자료 불러오기' 상태 캡처에만.)
#
# 불변식:
#   · core 무수정 — 읽기 + `bash core/scripts/*.sh` spawn 만(state.json 직접 쓰기 0).
#   · HARNESS_OFFLINE=1(결정적 stub, 유일 게이트) + HARNESS_NO_DOTENV=1(운영 .env·키·ADK 미로드, hermetic).
#   · 추적 안 되는 inputs/examples 오염 회피(test-b8:9 기법): mktemp HARNESS_EXAMPLES_DIR 에 bundle 을
#     cosmetic/ex1 로 복사 → ingest 가 00g-guideline 으로 라우팅. 공유 inputs/examples 를 건드리지 않는다.
#   · 전용 rid chatfx-* + trap 정리(runs/chatfx-* 는 잔존시키지 않는다).
#
# 멱등: 결정적 stub + `python3 -m json.tool` 정렬 → 재실행해도 diff 0.
#   01-guideline-approve.json 은 Wave2 산출 — write-if-absent(존재하면 절대 덮어쓰지 않음). 나머지는 매번 재작성(동일 바이트).
#
# 사용법: HARNESS_ROOT=/path/to/core bash chat/test/fixtures/capture-fixtures.sh
#   ⚠ 하네스(core) 경로는 env HARNESS_ROOT 로 **주입**받는다(형제 경로 유도 폐기 — 리포지토리 분리 대비).
#     이 스크립트는 통합(integration) 계층에서만 호출되며 그때 HARNESS_ROOT 가 설정돼 있다(verify.sh 통합 구간).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # chat/test/fixtures
if [ -z "${HARNESS_ROOT:-}" ]; then
  echo "HARNESS_ROOT 가 필요합니다 — 이 픽스처 캡처는 하네스(core) 체크아웃 경로를 주입받아야 합니다." >&2
  echo "  예: HARNESS_ROOT=/path/to/core bash ${BASH_SOURCE[0]}" >&2
  exit 1
fi
# 절대경로화(+ 존재 검증): core 스크립트를 상대 BUNDLE 로 spawn 하면 그 cwd 기준으로 어긋나 풀린다.
#   상대 HARNESS_ROOT(예 ../x/core)도 견디도록 cd && pwd 로 정규화한다.
CORE="$(cd "$HARNESS_ROOT" 2>/dev/null && pwd)" || {
  echo "HARNESS_ROOT 경로가 없습니다: $HARNESS_ROOT" >&2; exit 1; }
OUT="$HERE/next-action"                               # 픽스처 출력 폴더
BUNDLE="$CORE/tests/fixtures/bundle-cosmetic"         # 결정적 화장품 번들(lib.sh 기준 픽스처)

[ -d "$CORE/scripts" ] || { echo "core scripts 를 찾을 수 없습니다: $CORE" >&2; exit 1; }
[ -d "$BUNDLE" ] || { echo "번들 픽스처가 없습니다: $BUNDLE" >&2; exit 1; }

# ── hermetic 결정적 stub 환경 ──
export HARNESS_ROOT="$CORE"
export HARNESS_OFFLINE=1        # stub 게이트(유일) — 결정적, 골든 바이트 불변
export HARNESS_NO_DOTENV=1      # 운영 .env(키·ADK 엔드포인트) 미로드 — CI 결정성
export HARNESS_DOMAIN=cosmetic  # ⓪ 유형 선언: 화장품
export HARNESS_FORMAT=multipage_bm  # 여러장 BM(상세페이지) — test 기준 프로젝트
unset HARNESS_CLI 2>/dev/null || true   # 오프라인이면 stub 자동선택(온라인 명시 stub 거부 게이트 회피)

# 추적 안 되는 inputs/examples 오염 회피(test-b8:9): mktemp examples 에 bundle 을 cosmetic/ex1 로 복사.
EXROOT="$(mktemp -d)"; mkdir -p "$EXROOT/cosmetic"; cp -r "$BUNDLE" "$EXROOT/cosmetic/ex1"
export HARNESS_EXAMPLES_DIR="$EXROOT"

RIDS=(chatfx-brief chatfx-esc chatfx-ingest)
cleanup() { local r; for r in "${RIDS[@]}"; do rm -rf "$CORE/runs/$r"; done; rm -rf "$EXROOT"; }
trap cleanup EXIT
for r in "${RIDS[@]}"; do rm -rf "$CORE/runs/$r"; done

mkdir -p "$OUT"

core()  { bash "$CORE/scripts/$1" "${@:2}"; }                                   # core script spawn(읽기/전이만)
jget()  { python3 "$CORE/scripts/lib/harness.py" jget "$CORE/runs/$1/state.json" "$2"; }  # state 읽기(스크립트 전용)
# next-action.sh stdout(한 줄 raw UTF-8 JSON) → json.tool 정렬(4-space·ensure_ascii=기존 escape 스타일) → 파일.
capture() {  # capture <rid> <outfile>
  core next-action.sh "$1" | python3 -m json.tool > "$OUT/$2"
  echo "  captured: $2  (rid=$1)"
}
# write-if-absent — Wave2 산출(01-guideline-approve.json) 보존: 존재하면 절대 덮어쓰지 않는다(클린 체크아웃엔 재생성).
capture_if_absent() {  # capture_if_absent <rid> <outfile>
  if [ -f "$OUT/$2" ]; then echo "  kept   : $2  (Wave2 산출 — 덮어쓰기 안 함)"; return 0; fi
  capture "$1" "$2"
}

echo "== next-action 픽스처 캡처 (HARNESS_ROOT=$CORE) =="

# ── (00) ingest 상태: new-run 직후(phase=00-ingest · action=ingest · needs=bundle_dir) ──
#     '자료 불러오기' 안내 카드가 렌더할 상태. 00g 를 태우지 않으므로 여러장 포맷 함정과 무관(new-run 후 즉시 캡처).
core new-run.sh chatfx-ingest --domain cosmetic --format multipage_bm >/dev/null
capture chatfx-ingest 00-ingest.json

# ── (01~04) 브리프 파이프라인(chatfx-brief): test-b8 sanctioned 경로 ──
core ingest-bundle.sh "$BUNDLE" chatfx-brief >/dev/null   # → 00g-guideline(examples 라우팅)
core run-stage.sh guideline chatfx-brief >/dev/null        # → gate=user(승인 대기)
capture_if_absent chatfx-brief 01-guideline-approve.json   # phase=00g-guideline · action=approve (Wave2 산출)
core approve.sh chatfx-brief --ra-ok --by chat:slack:U-fx >/dev/null
core kcia-check.sh chatfx-brief >/dev/null                 # 00g review-exempt autopass → 01-brief
core run-stage.sh brief chatfx-brief >/dev/null            # → gate=user(승인 대기)
capture chatfx-brief 02-brief-approve.json                 # phase=01-brief · action=approve
core approve.sh chatfx-brief --by chat:slack:U-fx >/dev/null
capture chatfx-brief 03-brief-review.json                  # gate=review · action=review(규정 점검 대기)
core kcia-check.sh chatfx-brief >/dev/null                 # 심의 통과 → 02-concept 전진
capture chatfx-brief 04-post-brief.json                    # phase=02-concept · action=generate(다음 단계)

# ── (05) 에스컬레이션(chatfx-esc): 보완 상한까지 → escalated → action=raise-limit(복구 안내) ──
core ingest-bundle.sh "$BUNDLE" chatfx-esc >/dev/null
core run-stage.sh guideline chatfx-esc >/dev/null
n=0
while [ "$(jget chatfx-esc status)" != "escalated" ] && [ "$n" -lt 8 ]; do
  core revise.sh chatfx-esc "또 다른 참조로 다시" >/dev/null 2>&1 || true      # 보완(자유텍스트) — iteration 증가
  if [ "$(jget chatfx-esc status)" = "changes_requested" ]; then
    core run-stage.sh guideline chatfx-esc >/dev/null 2>&1 || true            # 재생성 → 다시 승인 대기
  fi
  n=$((n + 1))
done
[ "$(jget chatfx-esc status)" = "escalated" ] || { echo "ERROR: escalated 미도달(status=$(jget chatfx-esc status))" >&2; exit 1; }
capture chatfx-esc 05-raise-limit.json                     # status=escalated · action=raise-limit

echo "== 캡처 완료 — 상태 요약 =="
for f in "$OUT"/*.json; do
  python3 - "$f" <<'PY'
import json, os, sys
f = sys.argv[1]
d = json.load(open(f))
print("  %-28s action=%-12s phase=%-14s gate=%-6s status=%s"
      % (os.path.basename(f), d["action"], d["phase"], d["gate"], d["status"]))
PY
done
