#!/usr/bin/env bash
# test-render-mode-gate.sh — html_only 역참조 게이트(P0-5) 회귀 잠금.
#   keyvisual 개선계획(keyvisual-label-corruption): plan 블록의 visual.render_mode == "html_only" 인
#   블록은 '그 블록의 생성 이미지'를 만들지도/참조하지도 않는다(공유 계약 — 인라인 SVG/HTML 로만 구성).
#   그런데도 HTML/CSS 가 그 블록의 생성 PNG/SVG 를 <img> 등으로 참조하면 라벨/텍스트 변질 위험이 있어
#   scripts/lib/check_render_refs.py 가 fail-closed(exit 1)로 렌더를 막는다. render_mode 가 없는 블록은
#   기존대로 이미지 생성 대상(후방호환)이라 역참조 검사에서 제외하고 기존 '존재성(깊이)' 검사만 돈다.
#
#   케이스:
#     (1) html_only 블록 + 그 생성 PNG 를 <img> 로 참조      → exit 1(역참조 위반, 파일 존재 무관)
#     (2) html_only 블록 + 미참조(인라인 SVG/HTML 만)        → exit 0
#     (3) render_mode 없는 일반 블록 + 생성 PNG <img>(존재)  → exit 0(후방호환 — 역참조 면제)
#     (4) 기존 깊이검사 회귀(파일 부재 생성이미지 참조)       → exit 1(존재성 위반)
#
# 결정성: 핵심은 check_render_refs.py 직접 단위 테스트(임시 디렉터리만 사용 — Playwright/번들 불필요).
#   임시 run 트리(04-keyvisual + 03-storyboard/plan)를 그때그때 만들어 _find_run_dir·_html_only_stems 가
#   동작하게 한다. 실제 작업트리(runs/·inputs/assets/)는 일절 건드리지 않는다(temp 디렉터리만, 정리).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## render-mode 게이트(P0-5) — html_only 블록 생성이미지 역참조 금지 회귀"

# stub 게이트(오프라인). lib.sh 가 이미 1로 두지만 명시해 격리.
export HARNESS_OFFLINE=1

CHK="$ROOT/scripts/lib/check_render_refs.py"

# ── 헬퍼: 임시 run 트리를 만든다 ──
#   <run>/04-keyvisual/options/A/index.html(+선택 .css) + <run>/03-storyboard/plan/<NN-type>.json.
#   check_render_refs.py <options_dir> <harness_root> 를 돌려 RC·OUT 전역을 채운다.
#   options_dir 의 경로에 '04-keyvisual' 세그먼트가 있어야 _find_run_dir 이 run·plan 을 유도한다.
ROOT_FOR_LINT="$ROOT"   # img_lint._refs import 가 가능한 실제 harness_root(resolved 경로는 temp 하위라 트리 무오염)

# plan 블록 JSON 한 개 기록. $1=plan_dir $2=order $3=type $4=render_mode("" 면 필드 생략)
write_block() {
  local pdir="$1" order="$2" typ="$3" rm="$4"
  mkdir -p "$pdir"
  if [ -n "$rm" ]; then
    printf '{"type":"%s","order":%s,"visual":{"kind":"graph","render_mode":"%s"}}\n' "$typ" "$order" "$rm" \
      > "$pdir/$(printf '%02d' "$order")-$typ.json"
  else
    printf '{"type":"%s","order":%s,"visual":{"kind":"photo"}}\n' "$typ" "$order" \
      > "$pdir/$(printf '%02d' "$order")-$typ.json"
  fi
}

run_chk() {  # run_chk <options_dir>
  OUT="$( python3 "$CHK" "$1" "$ROOT_FOR_LINT" 2>&1 )"; RC=$?
}

# ─────────── (1) html_only 블록 + 그 생성 PNG 를 <img> 참조 → exit 1 ───────────
# 역참조 금지: 블록 stem(05-rtbSummary)이 html_only 인데 HTML 이 그 생성 PNG 를 참조 → 차단.
#   파일 존재 여부와 무관하게(애초에 참조 자체가 금지) 거부되는지: 실제 파일을 '존재'시켜도 1이어야 한다.
T1="$(mktemp -d)"; RUN1="$T1/runs/r1"
OPT1="$RUN1/04-keyvisual/options"; mkdir -p "$OPT1/A"
write_block "$RUN1/03-storyboard/plan" 5 rtbSummary html_only
# 그 생성 PNG 가 실제로 존재하도록(존재성 검사는 통과하지만 역참조 검사가 잡아야 함을 분리 검증).
mkdir -p "$OPT1/A/inputs/assets/generated/r1"
: > "$OPT1/A/inputs/assets/generated/r1/05-rtbSummary.png"
printf '%s' '<!doctype html><html><body><img src="inputs/assets/generated/r1/05-rtbSummary.png"></body></html>' \
  > "$OPT1/A/index.html"
run_chk "$OPT1"
check "(1) html_only 블록 생성PNG 역참조 → 비0 종료(fail-closed)" "[ $RC -ne 0 ]"
check "(1) 실패 메시지에 그래픽 전용 블록 stem(05-rtbSummary) 노출" "echo \"\$OUT\" | grep -q '05-rtbSummary'"
check "(1) 실패 메시지에 평이 한국어('인라인 SVG/HTML') 안내" "echo \"\$OUT\" | grep -q '인라인 SVG/HTML'"
rm -rf "$T1"

# ─────────── (2) html_only 블록 + 미참조(인라인 SVG/HTML 만) → exit 0 ───────────
# 그 블록을 <img> 로 참조하지 않고 인라인 SVG·HTML 로만 구성 → 위반 없음(거짓 양성 0).
T2="$(mktemp -d)"; RUN2="$T2/runs/r2"
OPT2="$RUN2/04-keyvisual/options"; mkdir -p "$OPT2/A"
write_block "$RUN2/03-storyboard/plan" 5 rtbSummary html_only
printf '%s' '<!doctype html><html><body><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg><div class="card">텍스트</div></body></html>' \
  > "$OPT2/A/index.html"
run_chk "$OPT2"
check "(2) html_only 블록 미참조(인라인 SVG/HTML) → 0 종료(거짓 양성 0)" "[ $RC -eq 0 ]"
rm -rf "$T2"

# ─────────── (3) render_mode 없는 일반 블록 + 생성 PNG <img>(존재) → exit 0(후방호환) ───────────
# render_mode 필드가 없으면 그 블록은 이미지 생성 대상(후방호환) → 그 생성 PNG 참조는 정상.
#   (파일이 실제로 존재하므로 존재성 검사도 통과 — 역참조 면제 + 존재성 통과 둘 다.)
T3="$(mktemp -d)"; RUN3="$T3/runs/r3"
OPT3="$RUN3/04-keyvisual/options"; mkdir -p "$OPT3/A"
write_block "$RUN3/03-storyboard/plan" 1 hero ""     # render_mode 없음(일반 이미지 블록)
mkdir -p "$OPT3/A/inputs/assets/generated/r3"
: > "$OPT3/A/inputs/assets/generated/r3/01-hero.png"
printf '%s' '<!doctype html><html><body><img src="inputs/assets/generated/r3/01-hero.png"></body></html>' \
  > "$OPT3/A/index.html"
run_chk "$OPT3"
check "(3) render_mode 없는 일반 블록 생성PNG 참조(존재) → 0 종료(후방호환)" "[ $RC -eq 0 ]"
rm -rf "$T3"

# ─────────── (4) 기존 깊이검사 회귀 — 파일 부재 생성이미지 참조 → exit 1 ───────────
# render_mode 무관(일반 블록)이라도 그 생성 이미지가 디스크에 없으면(깊이오류/미생성) 존재성 검사가 잡는다.
#   P0-5(역참조)를 추가해도 기존 '존재성(깊이)' 게이트가 그대로 사는지(비회귀) 확인.
T4="$(mktemp -d)"; RUN4="$T4/runs/r4"
OPT4="$RUN4/04-keyvisual/options"; mkdir -p "$OPT4/A"
write_block "$RUN4/03-storyboard/plan" 1 hero ""     # 일반 블록(역참조 면제) — 존재성만 본다
# 그 파일을 만들지 않는다 → ref 가 풀린 위치에 파일 부재 → 존재성 위반.
printf '%s' '<!doctype html><html><body><img src="inputs/assets/generated/r4/01-hero.png"></body></html>' \
  > "$OPT4/A/index.html"
run_chk "$OPT4"
check "(4) 부재 생성이미지 참조 → 비0 종료(존재성 검사 비회귀)" "[ $RC -ne 0 ]"
check "(4) 실패 메시지에 '없습니다' 노출(평이 한국어)" "echo \"\$OUT\" | grep -q '없습니다'"
rm -rf "$T4"

# ─────────── (4b) html_only 블록의 생성이미지 참조는 '존재 여부와 무관'하게 차단(우선순위) ───────────
# 케이스1 의 핵심 보강: html_only 블록 생성PNG 가 디스크에 '없어도' 역참조 위반이 먼저 잡힌다
#   (존재성으로 가려지지 않고 역참조 메시지가 나오는지 — 둘이 모두 차단이지만 사유가 명확해야).
T4B="$(mktemp -d)"; RUN4B="$T4B/runs/r4b"
OPT4B="$RUN4B/04-keyvisual/options"; mkdir -p "$OPT4B/A"
write_block "$RUN4B/03-storyboard/plan" 5 rtbSummary html_only
printf '%s' '<!doctype html><html><body><img src="inputs/assets/generated/r4b/05-rtbSummary.png"></body></html>' \
  > "$OPT4B/A/index.html"   # 파일은 만들지 않음(부재) — 그래도 역참조 위반이 잡혀야
run_chk "$OPT4B"
check "(4b) html_only 생성PNG 부재여도 역참조 위반으로 차단(비0)" "[ $RC -ne 0 ]"
check "(4b) 사유=역참조('라벨/텍스트 변질' 또는 그래픽 전용 안내)" \
  "echo \"\$OUT\" | grep -qE '라벨/텍스트 변질|그래픽 전용'"
rm -rf "$T4B"

# ─────────── (5) html_only 블록이 매니페스트에 '실제 생성'돼도 → 역참조 금지(F1(C), exit 1) ───────────
# F1(C) 규제안전(2026-07-06, docs/keyvisual-image-safety-fixes-plan.md): 2026-07-05 핸드오프의 '매니페스트 실재
#   html_only PNG 참조 예외'를 회수했다. 그래픽 블록의 baked PNG 는 매니페스트에 실재해도(화장품 디자이너 참고
#   시안) 옵션 HTML 이 <img> 로 참조하면 허위 인증·순위·수치가 shots→협회 패키지로 새므로 전 도메인 금지 →
#   그래픽 블록은 인라인 SVG/HTML 로만. 유효 PNG·매니페스트 등재라도 exit 1(역참조 위반).
T5="$(mktemp -d)"; RUN5="$T5/runs/r5"
OPT5="$RUN5/04-keyvisual/options"; mkdir -p "$OPT5/A"
write_block "$RUN5/03-storyboard/plan" 5 rtbSummary html_only
mkdir -p "$RUN5/04-keyvisual/generated"
# 구조적으로 유효한 최소 PNG(매직+IHDR+IDAT+IEND) — 유효해도 금지됨을 보이기 위해 함께 둔다.
python3 -c "import struct; open('$RUN5/04-keyvisual/generated/05-rtbSummary.png','wb').write(b'\x89PNG\r\n\x1a\n'+struct.pack('>I',13)+b'IHDR'+b'\x00'*17+struct.pack('>I',1)+b'IDAT'+b'\x00'*5+struct.pack('>I',0)+b'IEND'+b'\x00'*4)"
printf '%s' '{"engine":"nanobanana","model":"gemini-3-pro-image","assets":[{"path":"04-keyvisual/generated/05-rtbSummary.png","type":"rtbSummary","order":5}]}' \
  > "$RUN5/04-keyvisual/image-manifest.json"
printf '%s' '<!doctype html><html><body><img src="../../generated/05-rtbSummary.png"></body></html>' \
  > "$OPT5/A/index.html"
run_chk "$OPT5"
check "(5) html_only 매니페스트 실재(유효 PNG)라도 → 역참조 금지(F1(C), exit 1)" "[ $RC -ne 0 ]"
check "(5) 사유=역참조(그래픽 전용/라벨 변질)" "echo \"\$OUT\" | grep -qE '라벨/텍스트 변질|그래픽 전용'"
rm -rf "$T5"

# ─────────── (5b) html_only 블록 + 매니페스트에 미등재 → 여전히 금지(exit 1) ───────────
# 매니페스트가 있어도 그 stem 이 없으면(=생성 안 됨) 금지 유지 — 제외 기준은 '실재 자산'이지 '매니페스트 존재' 아님.
T5B="$(mktemp -d)"; RUN5B="$T5B/runs/r5b"
OPT5B="$RUN5B/04-keyvisual/options"; mkdir -p "$OPT5B/A"
write_block "$RUN5B/03-storyboard/plan" 5 rtbSummary html_only
mkdir -p "$RUN5B/04-keyvisual/generated"
: > "$RUN5B/04-keyvisual/generated/01-hero.png"
printf '%s' '{"engine":"nanobanana","assets":[{"path":"04-keyvisual/generated/01-hero.png","type":"hero","order":1}]}' \
  > "$RUN5B/04-keyvisual/image-manifest.json"
printf '%s' '<!doctype html><html><body><img src="../../generated/05-rtbSummary.png"></body></html>' \
  > "$OPT5B/A/index.html"
run_chk "$OPT5B"
check "(5b) 매니페스트 있어도 html_only stem 미등재 → 금지 유지(비0)" "[ $RC -ne 0 ]"
check "(5b) 사유=역참조(그래픽 전용/라벨 변질)" "echo \"\$OUT\" | grep -qE '라벨/텍스트 변질|그래픽 전용'"
rm -rf "$T5B"

# ─────────── (5c) html_only + 매니페스트 등재·PNG 0바이트/손상 → 여전히 금지(비0) ───────────
# F1(C): 그래픽 블록의 생성 PNG 참조는 매니페스트 등재·PNG 유효성과 무관하게 무조건 금지(위 (5) 와 동일 결과;
#   0바이트 케이스도 역참조로 차단). 어떤 상태의 baked 그래픽 PNG 도 옵션 HTML <img> 로 새지 않는다.
T5C="$(mktemp -d)"; RUN5C="$T5C/runs/r5c"
OPT5C="$RUN5C/04-keyvisual/options"; mkdir -p "$OPT5C/A"
write_block "$RUN5C/03-storyboard/plan" 5 rtbSummary html_only
mkdir -p "$RUN5C/04-keyvisual/generated"
: > "$RUN5C/04-keyvisual/generated/05-rtbSummary.png"       # 0바이트(손상/미완) — 예외 신뢰 금지
printf '%s' '{"engine":"nanobanana","model":"gemini-3-pro-image","assets":[{"path":"04-keyvisual/generated/05-rtbSummary.png","type":"rtbSummary","order":5}]}' \
  > "$RUN5C/04-keyvisual/image-manifest.json"
printf '%s' '<!doctype html><html><body><img src="../../generated/05-rtbSummary.png"></body></html>' \
  > "$OPT5C/A/index.html"
run_chk "$OPT5C"
check "(5c) 매니페스트 등재라도 0바이트/손상 PNG → fail-closed(비0)" "[ $RC -ne 0 ]"
rm -rf "$T5C"

# 마무리 정리(다른 테스트와 동일 규약 — temp 디렉터리만 썼으므로 작업트리 무오염).
echo "render-mode-gate: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
