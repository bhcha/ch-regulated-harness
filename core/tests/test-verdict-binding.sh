#!/usr/bin/env bash
# test-verdict-binding.sh — P0: 심의 verdict 유효성을 '리뷰된 산출물 내용'에 묶는다(재개-스킵 구멍 차단).
#   결함(실증): kcia-check 의 재개(idempotent) 스킵이 state.history 의 'review:produced' 마커만 보고 재심의를
#   생략했다 → verdict 가 통과한 '뒤' 리뷰된 산출물(키비주얼 선택안 index.html)을 수정해도 재심의 없이 done 까지 샜다.
#   처방(kcia-check.sh): 마커 생산 시 '리뷰된 1차 산출물 sha256'을 .logs/review-binding.json(골든제외)에 함께 적고,
#   재개-스킵 직전 현재 해시를 재계산해 대조 — 불일치(수정됨)·사이드카 부재면 스킵하지 않고 정식 재심의로 떨어진다.
#   기존 위조방어(마커 부재 → 재심의, 외부리뷰 5R)는 그대로 1차 게이트로 유지되고 이 해시 대조는 그 위의 추가 방어다.
#
#   이 회귀: 통과 keyvisual verdict 뒤 (A) 산출물 미수정 → 재심의 생략(mtime 불변, 오버-트리거 없음)
#            (B) 선택안 index.html 수정 → 재심의(mtime 변경) ← 결함이 났던 구멍. offline/hermetic.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## verdict-binding — 심의 통과 뒤 리뷰된 산출물 수정 시 재심의(재개-스킵 구멍 차단)"

H="$ROOT/scripts/lib/harness.py"
mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }

RID=ci-vbind
# 오프라인 전 파이프라인 완주(키비주얼 select A→승인→심의→done). 통과 keyvisual verdict + 생산 마커 + 바인딩 사이드카 생성.
drive_to_done "$RID" claude || { echo "  ✗ 드라이브 done 미도달(테스트 환경 확인 — 공유 run 이름 충돌/중단 프로세스)"; rm -rf "$ROOT/runs/$RID"; echo "verdict-binding: PASS=$PASS FAIL=$((FAIL+1))"; exit 1; }

SF="$ROOT/runs/$RID/state.json"
VP="$ROOT/runs/$RID/04-keyvisual/design-verdict.json"
SEL="$(python3 "$H" jget "$ROOT/runs/$RID/04-keyvisual/decision.json" selected 2>/dev/null || true)"
IDX="$ROOT/runs/$RID/04-keyvisual/options/$SEL/index.html"
BIND="$ROOT/runs/$RID/.logs/review-binding.json"

# ── 사전조건: 통과 verdict + 리뷰된 1차 산출물 + 바인딩 사이드카(키비주얼) ──
VVERD="$(python3 "$H" jget "$VP" verdict 2>/dev/null || true)"
check "통과 keyvisual verdict 존재" "[ -f '$VP' ] && [ \"$VVERD\" = 'pass' ]"
check "선택 keyvisual 옵션 index.html 존재(리뷰된 1차 산출물)" "[ -n '$SEL' ] && [ -f '$IDX' ]"
BIND_KV="$(python3 -c "import json;print(json.load(open('$BIND')).get('keyvisual',{}).get('artifact_sha256',''))" 2>/dev/null || true)"
check "심의 바인딩 사이드카에 keyvisual 해시 기록(.logs, 골든제외)" "[ -n \"$BIND_KV\" ]"

# 재개(크래시 복구) 모사: 키비주얼 review-pass 직후 상태로 되돌림(verdict·생산 마커·바인딩 보존). 재실행 시 idempotent 판정.
rewind_to_kv_review() {
  python3 "$H" jset "$SF" phase '"04-keyvisual"' >/dev/null
  python3 "$H" jset "$SF" gate '"review"' >/dev/null
  python3 "$H" jset "$SF" step '"review"' >/dev/null
  python3 "$H" jset "$SF" status '"pending"' >/dev/null
}

# ── (A) 산출물 미수정 → 재심의 생략(mtime 불변) ── 바인딩 일치 = 스킵 보존(오버-트리거 없음 = 정당한 재개 idempotent).
rewind_to_kv_review
A1="$(mt "$VP")"; sleep 1
( cd "$ROOT" && HARNESS_CLI=claude HARNESS_OFFLINE=1 bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
A2="$(mt "$VP")"
check "(A) 산출물 미수정 → 재심의 생략(verdict mtime 불변)" "[ \"$A1\" = \"$A2\" ]"
check "(A) 스킵 후 게이트 전이됨(review 아님 = advance)" "[ \"\$(python3 '$H' jget '$SF' gate 2>/dev/null)\" != 'review' ]"

# ── (B) 통과 verdict '뒤' 선택안 옵션 디렉터리 내 index.html 수정 → 재심의(mtime 변경) ── 결함이 났던 정확한 구멍.
rewind_to_kv_review
printf '\n<!-- post-verdict edit %s -->\n' "$(date +%s)" >> "$IDX"
B1="$(mt "$VP")"; sleep 1
( cd "$ROOT" && HARNESS_CLI=claude HARNESS_OFFLINE=1 bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
B2="$(mt "$VP")"
check "(B) 심의 통과 뒤 선택안 index.html 수정 → 재심의(verdict mtime 변경)" "[ \"$B1\" != \"$B2\" ]"
# 자가치유: 재심의가 바인딩(선택안 옵션 디렉터리 해시)을 갱신했는가 — 이전 사이드카 해시와 달라야(수정 반영·다음 재개-스킵 정확).
NEW_STORED="$(python3 -c "import json;print(json.load(open('$BIND')).get('keyvisual',{}).get('artifact_sha256',''))" 2>/dev/null || true)"
check "(B) 재심의가 바인딩을 수정본으로 갱신(자가치유·이전 해시와 다름)" "[ -n \"$NEW_STORED\" ] && [ \"$NEW_STORED\" != \"$BIND_KV\" ]"

# ── (C) 통과 verdict '뒤' 선택안 shots/*.png 수정 → 재심의 ── 결박이 옵션 디렉터리(index.html·styles.css·shots)를 덮는지(외부리뷰 P0: index.html-only 결박이면 CSS/샷 편집이 스킵으로 샜다).
SHOT="$(ls "$ROOT/runs/$RID/04-keyvisual/options/$SEL/shots/"*.png 2>/dev/null | head -1)"
check "선택 옵션 shots/*.png 존재(리뷰·export 되는 산출물 일부)" "[ -n \"$SHOT\" ] && [ -f \"$SHOT\" ]"
rewind_to_kv_review
printf 'post-verdict-shot-edit-%s' "$(date +%s)" >> "$SHOT"
C1="$(mt "$VP")"; sleep 1
( cd "$ROOT" && HARNESS_CLI=claude HARNESS_OFFLINE=1 bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
C2="$(mt "$VP")"
check "(C) 심의 통과 뒤 선택안 shots PNG 수정 → 재심의(verdict mtime 변경 = 디렉터리 결박)" "[ \"$C1\" != \"$C2\" ]"
STORED_AFTER_C="$(python3 -c "import json;print(json.load(open('$BIND')).get('keyvisual',{}).get('artifact_sha256',''))" 2>/dev/null || true)"
check "(C) shots 수정이 바인딩 해시를 바꿈(index.html-only 결박이면 불변이라 실패)" "[ -n \"$STORED_AFTER_C\" ] && [ \"$STORED_AFTER_C\" != \"$NEW_STORED\" ]"

rm -rf "$ROOT/runs/$RID"
echo "verdict-binding: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
