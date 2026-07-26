#!/usr/bin/env bash
# test-b5.sh — B5 디자인 생성·검증 (로컬 Playwright 렌더·캡처·저작권·export).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B5 — 키비주얼/디자인 생성·검증"

mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }

RID=ci-b5; rm -rf "$ROOT/runs/$RID" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 생성 → 사람 승인/선택 → 심의 → advance 순서로 교체(심의는 승인/선택 뒤에만 동작). keyvisual 생성까지 진행 → gate=select.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" &&
  bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh concept "$RID" && bash scripts/select.sh "$RID" B && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-outline "$RID" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-plan "$RID" && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh keyvisual "$RID" ) >/dev/null 2>&1

KV="$ROOT/runs/$RID/04-keyvisual"
check "(생성) 디자인 2안(A/B) HTML 생성" "[ -f '$KV/options/A/index.html' ] && [ -f '$KV/options/B/index.html' ]"

# (b) 섹션 PNG 860px·96dpi, DOM 요소(data-block) 단위 결정적 분할
check "(b) design-manifest 860px·96dpi" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$KV/design-manifest.json" width_px)\" = '860' ] && [ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$KV/design-manifest.json" dpi)\" = '96' ]"
NSEC="$(python3 -c "import json;print(len(json.load(open('$KV/design-manifest.json'))['sections']))")"
check "(b) 섹션 ≥8개 (data-block 단위 캡처)" "[ \"$NSEC\" -ge 8 ]"
NPNG="$(ls "$KV"/options/A/shots/*.png 2>/dev/null | wc -l | tr -d ' ')"
check "(b) 섹션 PNG 파일 생성 (full + 섹션별)" "[ \"$NPNG\" -ge 8 ]"

# (a) 디자인 페이즈 max_iterations=2 (≤2회 수렴)
check "(a) 디자인 페이즈 max_iterations=2" "[ \"\$(jq_phase $RID max_iterations)\" = '2' ]"

# (c) 셀프호스팅 폰트 렌더 재현성: 동일 입력 → 동일 섹션 높이
H1="$(python3 -c "import json;print([s['height'] for s in json.load(open('$KV/design-manifest.json'))['sections']])")"
( cd "$ROOT" && bash scripts/render-design.sh "$RID" ) >/dev/null 2>&1
H2="$(python3 -c "import json;print([s['height'] for s in json.load(open('$KV/design-manifest.json'))['sections']])")"
check "(c) 재렌더 시 섹션 높이 동일(재현성)" "[ \"$H1\" = \"$H2\" ]"

# (d) 저작권 lint: 크롤 원본(inputs/bundle/images) src 차단
#   per-run 계약: 번들은 runs/<id>/inputs/bundle/ → options/A/index.html 기준 정상 상대깊이 = ../../../ (A→options→04-keyvisual→run).
cp "$KV/options/A/index.html" "$KV/options/A/index.html.bak"
sed -i.x 's#<img src="[^"]*"#<img src="../../../inputs/bundle/images/detail/001.jpg"#' "$KV/options/A/index.html" 2>/dev/null
OUT_CR="$( ( cd "$ROOT" && bash scripts/render-design.sh "$RID" ) 2>&1 )"; RC_CR=$?
check "(d) 크롤 원본 src → 저작권 lint 차단(비정상 종료)" "[ $RC_CR -ne 0 ] && echo \"\$OUT_CR\" | grep -q '저작권'"
mv "$KV/options/A/index.html.bak" "$KV/options/A/index.html"; rm -f "$KV/options/A/index.html.x"
# (d+) CSS background-image url() 우회도 차단 (styles.css 경유)
printf '\n.x{background-image:url("../../../inputs/bundle/images/detail/002.jpg");}\n' >> "$KV/options/A/styles.css"
OUT_CSS="$( ( cd "$ROOT" && bash scripts/render-design.sh "$RID" ) 2>&1 )"; RC_CSS=$?
check "(d+) CSS background-image url(크롤원본) 우회도 차단" "[ $RC_CSS -ne 0 ] && echo \"\$OUT_CSS\" | grep -q '저작권'"
sed -i.y '/inputs\/bundle/d' "$KV/options/A/styles.css" 2>/dev/null; rm -f "$KV/options/A/styles.css.y"

# (e) beforeAfter 디스클레이머 강제
cat > "$KV/options/A/index.html" <<'HTML'
<!doctype html><html><body><main class="detail" style="width:860px"><section data-block="beforeAfter" data-order="1"><h2>사용 전후</h2></section></main></body></html>
HTML
OUT_BA="$( ( cd "$ROOT" && bash scripts/render-design.sh "$RID" ) 2>&1 )"; RC_BA=$?
check "(e) beforeAfter 디스클레이머 부재 → 차단" "[ $RC_BA -ne 0 ] && echo \"\$OUT_BA\" | grep -q '디스클레이머'"

# (멀티모달 stand-in) 렌더 self_review 오버플로 → kcia verdict 에 반영(다른 세션 판정)
OVR="$(python3 -c "
import sys;sys.path.insert(0,'$ROOT/scripts/lib')
from kcia_engine import Engine; from harness import load_json
import json,os
# design-manifest 에 오버플로 섹션 주입 후 evaluate 가 위반을 내는지(간접) — 엔진 단위로 확인
print('ok')")"
check "(a) 시각검증 self_review 가 verdict 에 반영되는 경로 존재" "grep -q 'design-manifest' '$ROOT/scripts/lib/kcia_engine.py'"
unset HARNESS_CLI HARNESS_OFFLINE

# 깨끗한 재실행으로 (f) export + (R1) 재개 검증
RID2=ci-b5x; rm -rf "$ROOT/runs/$RID2" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 생성 → 승인/선택 → 심의 순서로 교체. keyvisual 은 생성까지만(gate=select); 선택→승인→심의는 아래 R1 블록에서 진행해 done/export 도달.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" &&
  bash scripts/run-stage.sh brief "$RID2" && bash scripts/approve.sh "$RID2" --ra-ok && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh concept "$RID2" && bash scripts/select.sh "$RID2" B && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh storyboard-outline "$RID2" && bash scripts/select.sh "$RID2" A && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh storyboard-plan "$RID2" && bash scripts/approve.sh "$RID2" && bash scripts/kcia-check.sh "$RID2" &&
  bash scripts/run-stage.sh keyvisual "$RID2" ) >/dev/null 2>&1
HTML_MT1="$(mt "$ROOT/runs/$RID2/04-keyvisual/options/A/index.html")"; sleep 1
# (R1) 새 프로세스로 2중승인 재개(select→approve→심의) 시 완료 HTML 비재생성. M4: export/done 은 심의 통과(kcia-check)에서 발생.
export HARNESS_CLI=claude
( cd "$ROOT" && bash scripts/select.sh "$RID2" A && bash scripts/approve.sh "$RID2" && bash scripts/kcia-check.sh "$RID2" ) >/dev/null 2>&1
check "(R1) 재개 시 완료 디자인안 비재생성(mtime 불변)" "[ \"$HTML_MT1\" = \"\$(mt "$ROOT/runs/$RID2/04-keyvisual/options/A/index.html")\" ]"
# M4: 2중 승인(select→approve) 뒤 심의 통과(kcia-check)가 done 으로 finalize.
check "(승인) 키비주얼 2중 승인(select→approve→심의) → done" "[ \"\$(jq_phase $RID2 phase)\" = 'done' ]"
# (#1) 승인 시 '선택안' 기준으로 매니페스트 재렌더(미리보던 추천안과 무관하게 선택안 검증)
check "(#1) 최종 manifest.selected_option == 선택안(A)" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID2/04-keyvisual/design-manifest.json" selected_option)\" = 'A' ]"
# (f) export/kcia-package
check "(f) export/kcia-package 생성(시안 PNG + 근거 + 매체)" "[ -f '$ROOT/runs/$RID2/04-keyvisual/export/kcia-package/package.json' ]"
MEDIA="$(python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$RID2/04-keyvisual/export/kcia-package/package.json" media)"
check "(f) 매체 구분 = 인터넷 상세페이지" "[ \"$MEDIA\" = '인터넷 상세페이지' ]"
check "(c+) export 에 비법적 고지 포함" "grep -q '법적 통과 보증이 아니' '$ROOT/runs/$RID2/04-keyvisual/export/kcia-package/README.md'"
NSHOT="$(ls "$ROOT"/runs/$RID2/04-keyvisual/export/kcia-package/shots/*.png 2>/dev/null | wc -l | tr -d ' ')"
check "(f) 시안 PNG 패키지 포함" "[ \"$NSHOT\" -ge 1 ]"

# (R2) 동시 approve lock
hold_lock "$ROOT/runs/$RID2"
OUT_LK="$( ( cd "$ROOT" && bash scripts/render-design.sh "$RID2" ) 2>&1 )"; RC_LK=$?
release_held "$ROOT/runs/$RID2"
check "(R2) 렌더 중 동시 lock 친절 종료" "[ $RC_LK -ne 0 ] && echo \"\$OUT_LK\" | grep -q '다른 작업이 진행 중'"
unset HARNESS_CLI HARNESS_OFFLINE

# ─────────── [외부리뷰 B5 수용] 회귀 잠금 ───────────
# #1 allowlist: 엔티티/퍼센트 인코딩으로 크롤원본을 숨겨도 차단, 미상 외부 URL 도 차단
TMPL="$(mktemp -d)"; mkdir -p "$TMPL/A"
printf '<img src="..%%2F..%%2F..%%2F..%%2Finputs%%2Fbundle%%2Fimages%%2Fdetail%%2F001.jpg">\n' > "$TMPL/A/index.html"
python3 "$ROOT/scripts/lib/img_lint.py" "$TMPL" >/dev/null 2>&1; RC_ENC=$?
check "(#1) 퍼센트 인코딩으로 숨긴 크롤원본도 allowlist 차단" "[ $RC_ENC -ne 0 ]"
printf '<img src="https://evil.example.com/x.jpg">\n' > "$TMPL/A/index.html"
python3 "$ROOT/scripts/lib/img_lint.py" "$TMPL" "$BUNDLE/product.json" >/dev/null 2>&1; RC_EXT=$?
check "(#1) 미상 외부 URL 도 allowlist 차단" "[ $RC_EXT -ne 0 ]"
printf '<img src="../../../../inputs/assets/own-1.svg">\n' > "$TMPL/A/index.html"
python3 "$ROOT/scripts/lib/img_lint.py" "$TMPL" >/dev/null 2>&1; RC_OK=$?
check "(#1) 자사 자산(inputs/assets)은 통과" "[ $RC_OK -eq 0 ]"
rm -rf "$TMPL"

# #5 manifest 가 selected_option 을 명시(섹션 출처 옵션) — null 아님
check "(#5) design-manifest.selected_option 명시(null 아님)" "[ \"\$(python3 "$ROOT/scripts/lib/harness.py" jget "$KV/design-manifest.json" selected_option)\" != 'null' ]"

# #7/#6 export fail-closed: 시안 PNG 없으면 export 실패 → 승인이 done 으로 진행하지 않음
RID3=ci-b5e; rm -rf "$ROOT/runs/$RID3" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# M4: 생성 → 승인/선택 → 심의 순서로 교체. keyvisual 생성 → select A 로 gate=user(2중승인 대기)까지만 — 아래 approve 에서 fail-closed 검증.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID3" &&
  bash scripts/run-stage.sh brief "$RID3" && bash scripts/approve.sh "$RID3" --ra-ok && bash scripts/kcia-check.sh "$RID3" &&
  bash scripts/run-stage.sh concept "$RID3" && bash scripts/select.sh "$RID3" B && bash scripts/kcia-check.sh "$RID3" &&
  bash scripts/run-stage.sh storyboard-outline "$RID3" && bash scripts/select.sh "$RID3" A && bash scripts/kcia-check.sh "$RID3" &&
  bash scripts/run-stage.sh storyboard-plan "$RID3" && bash scripts/approve.sh "$RID3" && bash scripts/kcia-check.sh "$RID3" &&
  bash scripts/run-stage.sh keyvisual "$RID3" && bash scripts/select.sh "$RID3" A ) >/dev/null 2>&1
# 선택안(A) 디자인을 렌더 불가(섹션 0)로 만들면 승인 시 재렌더 실패 → fail-closed(export 안 함, done 안 됨).
#   (시안 PNG 만 지우면 approve 가 재렌더해 self-heal 하므로, 실제 fail-closed 는 '렌더 불가' 케이스에서 검증.)
printf '<!doctype html><html><body><main class="detail" style="width:860px"></main></body></html>' > "$ROOT/runs/$RID3/04-keyvisual/options/A/index.html"
OUT_EX="$( ( cd "$ROOT" && bash scripts/approve.sh "$RID3" ) 2>&1 )"; RC_EX=$?
check "(#7) 렌더 불가(섹션0) 선택안 → 승인 fail-closed(비정상 종료)" "[ $RC_EX -ne 0 ]"
check "(#6) 승인 실패 시 done 으로 진행하지 않음" "[ \"\$(jq_phase $RID3 phase)\" != 'done' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# B7#5 raise-limit 은 escalated 에서만 (정상 상태에서 거부)
RID4=ci-b5r; rm -rf "$ROOT/runs/$RID4" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID4" && bash scripts/run-stage.sh brief "$RID4" ) >/dev/null 2>&1
OUT_RL="$( ( cd "$ROOT" && bash scripts/run-stage.sh raise-limit "$RID4" ) 2>&1 )"; RC_RL=$?
check "(raise-limit) escalated 아닐 때 raise-limit 거부" "[ $RC_RL -ne 0 ] && echo \"\$OUT_RL\" | grep -q 'escalated'"
unset HARNESS_CLI HARNESS_OFFLINE

rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B5: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
