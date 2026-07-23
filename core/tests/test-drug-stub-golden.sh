#!/usr/bin/env bash
# test-drug-stub-golden.sh — 의약품(drug) 오프라인 stub 파이프라인 '1차 골든'(escalate 동결).
#   목적: 현재 drug 오프라인 동작을 커밋 가능한 골든으로 동결한다. 현재 동작 = storyboard-plan 에서 심의를
#     반복 미통과(stub CANON 의 brandTrust '수상·기술력' 이 drug substantiation_required 를 계속 발동)해
#     revise 반복이 소진되면 **escalated**(사람 개입) 로 종단한다. 1차는 이 escalate 동작을 동결(사용자 합의).
#     done-골든(escalate 없이 끝까지)은 2차로 미룬다.
#   2축 검증: (1) 파이프라인이 결정적으로 storyboard-plan 에서 escalate 하는가
#            (2) 산출물 의미 바이트가 골든 매니페스트(baseline-manifest-drug.json)와 동일한가(동작 동결).
#   ※ drive 루프는 이 파일 안에 둔다 — lib.sh 의 cosmetic 드라이버(drive_to_done)는 'B/A/A→done' 하드코딩이라
#     escalate 로 종단하는 drug 를 표현하지 못한다(lib.sh 미오염이 원칙: 골든 보존).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## DRUG-STUB-GOLDEN — 의약품 오프라인 stub 파이프라인 escalate 동결(1차)"

# drug 도메인·합성 입력으로 hermetic 재정의(lib.sh 의 cosmetic 기본값 override).
export HARNESS_DOMAIN=drug HARNESS_FORMAT=multipage_bm
export HARNESS_WB="$PACKS_DIR/drug/golden/working-backwards.md"
export HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"   # 빈 사례 → 00g 미라우팅(직행 ingest→brief)
DBUNDLE="$ROOT/tests/fixtures/bundle-drug"
MANIFEST="$ROOT/tests/golden/baseline-manifest-drug.json"
RID="drug-stub-golden"

status_of() {
  local sf="$ROOT/runs/$RID/state.json"
  [ -f "$sf" ] || { echo "no-state"; return; }
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['status'])" "$sf"
}
field_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$ROOT/runs/$RID/state.json" "$1"; }

# drug 오프라인 stub 완주(escalate 까지). storyboard-plan 은 심의 미통과가 반복돼 iteration 소진 → escalate.
#   결정적(stub): CANON 의 brandTrust '수상·기술력' 이 매 생성마다 동일하게 substantiation_required 를 발동한다.
drive_drug_escalate() {
  rm -rf "$ROOT/runs/$RID"
  export HARNESS_CLI=stub HARNESS_OFFLINE=1
  ( cd "$ROOT" &&
    bash scripts/ingest-bundle.sh "$DBUNDLE" "$RID" &&
    bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh concept "$RID" && bash scripts/select.sh "$RID" B && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh storyboard-outline "$RID" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID"
  ) >/dev/null 2>&1
  # storyboard-plan 재시도(revise) 루프: 심의 미통과가 반복돼 iteration 소진 → escalate. 안전 캡으로 무한루프 방지.
  local n=0
  while [ "$(status_of)" != "escalated" ]; do
    n=$((n + 1)); [ "$n" -gt 12 ] && break
    ( cd "$ROOT" &&
      bash scripts/run-stage.sh storyboard-plan "$RID" &&
      bash scripts/approve.sh "$RID" &&
      bash scripts/kcia-check.sh "$RID"
    ) >/dev/null 2>&1
  done
  echo "$n"   # 사용한 plan revise-cycle 수(가시화)
}

CYCLES="$(drive_drug_escalate)"
FINAL_STATUS="$(status_of)"
FINAL_PHASE="$(field_of phase)"

# (1) 종단 상태 = escalated (현재 drug 오프라인 동작의 동결점 — 실패가 아니라 기대 상태).
check "(1) drug 파이프라인 종단 상태 = escalated (plan revise-cycle ${CYCLES}회 소진)" \
  "[ \"$FINAL_STATUS\" = 'escalated' ]"
check "(1) escalate 발생 페이즈 = 03-storyboard(plan)" "[ \"$FINAL_PHASE\" = '03-storyboard' ]"

# (2) 의미 바이트 골든 대조(휘발성 키 strip 후 sha256). 미변경 = 동작 동결 확인(0순위 알람).
if [ ! -f "$MANIFEST" ]; then
  fail "(2) 골든 매니페스트 없음: ${MANIFEST#"$ROOT"/} (먼저 baseline.py intersect 로 캡처)"
elif python3 "$ROOT/scripts/lib/baseline.py" verify "$ROOT/runs/$RID" "$MANIFEST"; then
  pass "(2) 산출물 의미 바이트 = 골든(baseline-manifest-drug.json) 동일(동작 동결)"
else
  fail "(2) 산출물 의미 바이트가 골든과 다름 — 회귀 또는 의도된 골든 갱신(그러면 매니페스트 재캡처)"
fi

rm -rf "$ROOT/runs/$RID"
echo "DRUG-STUB-GOLDEN: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
