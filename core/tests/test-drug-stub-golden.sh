#!/usr/bin/env bash
# test-drug-stub-golden.sh — 의약품(drug) 오프라인 stub 파이프라인 '2차 골든'(done 동결).
#   목적: 현재 drug 오프라인 동작을 커밋 가능한 골든으로 동결한다. 현재 동작 = **done 완주**.
#     1차 골든은 escalate 동결이었다(화장품형 포맷 캐논의 brandTrust '수상·기술력' 이 drug
#     substantiation_required 를 매 생성마다 발동 → revise 소진 → escalated). 캐논 도메인 축
#     (packs/drug/canon-overlay.json = 교육콘텐츠 캐논: hero→problem→mechanism→ingredientTech→
#     ingredientDetail→rtbSummary→[clinicalEvidence]→targetAudience→faq→precautions→footer)이
#     그 원인 블록을 시퀀스에서 제거해 1차가 미뤄뒀던 done-골든(2차)에 도달했다.
#     footer 블록(stub)이 필수기재 신호(정확한 제품명·주의문구·광고심의필·회사명)를 결정적으로 기재해
#     최종 페이지 mandatory_inclusion 게이트를 통과한다.
#   2축 검증: (1) 파이프라인이 결정적으로 done 까지 완주하는가(escalate/revise 잔존 없음)
#            (2) 산출물 의미 바이트가 골든 매니페스트(baseline-manifest-drug.json)와 동일한가(동작 동결).
#   ※ drive 루프는 이 파일 안에 둔다 — lib.sh 의 cosmetic 드라이버(drive_to_done)는 'B/A/A→done' 하드코딩
#     경로가 keyvisual 승인 시퀀스까지 동일하지만, drug 는 도메인·입력 재정의가 필요해 자체 드라이버를 유지한다
#     (lib.sh 미오염 원칙: cosmetic 골든 보존).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## DRUG-STUB-GOLDEN — 의약품 오프라인 stub 파이프라인 done 동결(2차 · 교육콘텐츠 캐논)"

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

# drug 오프라인 stub 완주(done 까지). 교육콘텐츠 캐논이라 심의 통과가 결정적(재시도 루프 불필요).
drive_drug_done() {
  rm -rf "$ROOT/runs/$RID"
  export HARNESS_CLI=stub HARNESS_OFFLINE=1
  ( cd "$ROOT" &&
    bash scripts/ingest-bundle.sh "$DBUNDLE" "$RID" &&
    bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh concept "$RID" && bash scripts/select.sh "$RID" B && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh storyboard-outline "$RID" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh storyboard-plan "$RID" && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" &&
    bash scripts/run-stage.sh keyvisual "$RID" && bash scripts/select.sh "$RID" A && bash scripts/approve.sh "$RID" &&
    bash scripts/kcia-check.sh "$RID"
  ) >/dev/null 2>&1
}

drive_drug_done
FINAL_STATUS="$(status_of)"
FINAL_PHASE="$(field_of phase)"

# (1) 종단 = done 완주(교육콘텐츠 캐논 — escalate 원인 소멸의 동결점).
check "(1) drug 파이프라인 종단 페이즈 = done" "[ \"$FINAL_PHASE\" = 'done' ]"
check "(1) 종단 상태 = approved (심의·승인 전부 통과)" "[ \"$FINAL_STATUS\" = 'approved' ]"

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
