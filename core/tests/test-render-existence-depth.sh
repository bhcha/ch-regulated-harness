#!/usr/bin/env bash
# test-render-existence-depth.sh — 강화된 '생성 이미지 존재성 검사' 회귀 잠금(RXD).
#   render-design.sh 가 부르는 scripts/lib/check_render_refs.py 가 ref 의 상대깊이(../ 개수)를
#   렌더(file://)와 똑같이 'ref 가 든 파일의 디렉터리 기준'으로 풀어 디스크 존재를 확인하는지 검증한다.
#   옛 검사는 ../ 를 버리고 파일명(tail)만 봐서 깊이 오류(../×4 vs 정답 ../×5)를 거짓 통과시켰다
#   (실런 ezderm-acne-bm-2026 사고 = 깨진 이미지가 done 까지 샘). 이 테스트가 그 회귀를 잠근다.
#
# 결정성: 핵심은 check_render_refs.py 직접 단위 테스트(임시 디렉터리만 사용 — Playwright/번들 불필요).
#   시드 번들(naver_*)이 없는 체크아웃에서도 번들 없이 결정적으로 green 이다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## RXD — 생성 이미지 존재성 검사(깊이 인식) 회귀"

# stub 게이트(오프라인). lib.sh 가 이미 1로 두지만 명시해 격리.
export HARNESS_OFFLINE=1

CHK="$ROOT/scripts/lib/check_render_refs.py"

# 단위 케이스 헬퍼: 임시 옵션 디렉터리를 만들고 check_render_refs.py 를 돌린 뒤
#   종료코드(RC)와 합쳐진 출력(OUT)을 전역에 채운다. harness_root 는 실제 $ROOT 여야
#   img_lint._refs import 가 된다(resolved 경로는 임시 base 하위라 실제 트리를 안 건드린다).
run_chk() {  # run_chk <options_상위_임시디렉터리>
  OUT="$( python3 "$CHK" "$1/options" "$ROOT" 2>&1 )"; RC=$?
}

# ─────────── (A) 깊이/누락 오류 → fail-closed ───────────
# 생성이미지 ref 를 그 파일 기준으로 풀었을 때 존재하지 않는 경로 → exit 1 + 메시지에 ref·'없습니다' 노출.
TA="$(mktemp -d)"; mkdir -p "$TA/options/A"
printf '%s' '<img src="../inputs/assets/generated/x/01-hero.png">' > "$TA/options/A/index.html"
run_chk "$TA"
check "(A) 깊이 틀린 생성이미지 ref → 비0 종료(fail-closed)" "[ $RC -ne 0 ]"
check "(A) 실패 메시지에 해당 ref 문자열 노출" "echo \"\$OUT\" | grep -q '../inputs/assets/generated/x/01-hero.png'"
check "(A) 실패 메시지에 '없습니다' 노출(평이 한국어)" "echo \"\$OUT\" | grep -q '없습니다'"
rm -rf "$TA"

# ─────────── (B) 정상 → pass (거짓 양성 0) ───────────
# ref 가 그 파일 기준으로 풀린 위치에 실제 파일을 만들어 두면 통과.
TB="$(mktemp -d)"; mkdir -p "$TB/options/A/inputs/assets/generated/x"
: > "$TB/options/A/inputs/assets/generated/x/01-hero.png"
printf '%s' '<img src="inputs/assets/generated/x/01-hero.png">' > "$TB/options/A/index.html"
run_chk "$TB"
check "(B) ref 가 풀린 위치에 실파일 있으면 → 0 종료(거짓 양성 0)" "[ $RC -eq 0 ]"
rm -rf "$TB"

# ─────────── (Anew) 현행 주경로 04-keyvisual/generated/ 깊이 오류 → fail-closed ───────────
# per-run 계약의 새 생성물 위치(04-keyvisual/generated/). 부모 basename='generated' 마커로 생성물 참조로
#   판정되고, ref 가 그 파일 기준으로 풀린 위치에 파일이 없으면 비0 종료(현행 주경로 커버).
TAN="$(mktemp -d)"; mkdir -p "$TAN/options/A"
printf '%s' '<img src="../../generated/01-hero.png">' > "$TAN/options/A/index.html"
run_chk "$TAN"
check "(Anew) 04-keyvisual/generated 깊이 틀린 ref → 비0 종료(fail-closed)" "[ $RC -ne 0 ]"
check "(Anew) 실패 메시지에 generated ref 문자열 노출" "echo \"\$OUT\" | grep -q 'generated/01-hero.png'"
rm -rf "$TAN"

# ─────────── (Bnew) 04-keyvisual/generated/ 정상깊이 실파일 존재 → pass ───────────
TBN="$(mktemp -d)"; mkdir -p "$TBN/options/A/generated"
: > "$TBN/options/A/generated/01-hero.png"
printf '%s' '<img src="generated/01-hero.png">' > "$TBN/options/A/index.html"
run_chk "$TBN"
check "(Bnew) 04-keyvisual/generated 정상깊이 실파일 존재 → 0 종료(거짓 양성 0)" "[ $RC -eq 0 ]"
rm -rf "$TBN"

# ─────────── (C) data:/http/외부 스킵 → pass ───────────
# data URI·외부 http(s)·protocol-relative(//) 는 로컬 존재성 대상이 아니다 → 통과.
TC="$(mktemp -d)"; mkdir -p "$TC/options/A"
printf '%s' '<img src="data:image/png;base64,iVBORw0KGgo"><img src="https://example.com/x.png"><img src="//cdn/x.png">' > "$TC/options/A/index.html"
run_chk "$TC"
check "(C) data:/http/외부 URL → 존재성 대상 아님 → 0 종료" "[ $RC -eq 0 ]"
rm -rf "$TC"

# ─────────── (E) 저작권 케이스와 순서 독립(단계 A 비회귀 핵심) ───────────
# 크롤 원본(inputs/bundle/images/, generated 아님, 미존재)을 가리키는 ref → generated 범위 밖이라
#   존재성 게이트가 스킵(exit 0). 즉 존재성 게이트가 저작권 케이스를 가로채지 않는다(test-b5 (d) 비회귀)를
#   단위 수준에서 증명 — 저작권 위반은 하류 img_lint(저작권 lint)가 잡아야지 존재성 게이트가 먼저 가로채면 안 된다.
TE="$(mktemp -d)"; mkdir -p "$TE/options/A"
printf '%s' '<img src="../../../../inputs/bundle/images/detail/001.jpg">' > "$TE/options/A/index.html"
run_chk "$TE"
check "(E) 크롤원본(generated 아님) ref → 존재성 게이트 스킵(0 종료)" "[ $RC -eq 0 ]"
rm -rf "$TE"

# ─────────── (CSS) .css 의 url() 도 동일 적용 ───────────
# 별도 .css 파일의 url(미존재 생성이미지) → 0 종료가 아니라 1(.css 도 스캔 대상이며 base=그 CSS 디렉터리).
TCSS="$(mktemp -d)"; mkdir -p "$TCSS/options/A"
printf '%s' '.x{background-image:url(../inputs/assets/generated/x/02.png);}' > "$TCSS/options/A/styles.css"
run_chk "$TCSS"
check "(CSS) .css url(미존재 생성이미지) → 비0 종료(.css 도 검사 대상)" "[ $RC -ne 0 ]"
check "(CSS) 실패 메시지에 .css 의 url() ref 노출" "echo \"\$OUT\" | grep -q '../inputs/assets/generated/x/02.png'"
rm -rf "$TCSS"

# ─────────── (통합) render-design.sh 가 실제로 존재성 게이트를 건다는 증명 ───────────
# 픽스처(fixtures/keyvisual-in, 번들 불필요)로 keyvisual 입력 상태 run 을 만들고,
#   03-storyboard/plan 을 제거해 render-design.sh:17 의 image_engine 선행 생성을 건너뛰게 한 뒤
#   (실제 inputs/assets/generated/ 오염 방지), 04-keyvisual/options/A/index.html 에 깊이 틀린
#   generated ref 를 넣는다. render-design.sh 의 존재성 게이트(:29)는 저작권·beforeAfter·render(Playwright)
#   '앞'에서 돌므로, Playwright 도달 전에 비0 종료 + 메시지에 ref 가 노출되어야 한다.
#   (resolved 경로는 run 의 options 디렉터리 하위로 풀려 실제 트리를 건드리지 않는다 — 위 (A) 와 동일 원리.)
RID=ci-rxd-int
rm -rf "$ROOT/runs/$RID"
seed_fixture keyvisual "$RID"
rm -rf "$ROOT/runs/$RID/03-storyboard/plan"   # image_engine 선행 생성 스킵(실 트리 오염 방지)
mkdir -p "$ROOT/runs/$RID/04-keyvisual/options/A"
# per-run 계약: 정상 참조는 ../../generated/NN.png. 여기선 깊이를 틀리게(../generated) 넣어 존재성 게이트가
#   현행 주경로(04-keyvisual/generated/)에서도 깨진 이미지를 잡는지 검증한다.
printf '%s' '<!doctype html><html><body><main class="detail" style="width:860px"><img src="../generated/01-hero.png"></main></body></html>' \
  > "$ROOT/runs/$RID/04-keyvisual/options/A/index.html"
OUT_INT="$( ( cd "$ROOT" && bash scripts/render-design.sh "$RID" ) 2>&1 )"; RC_INT=$?
check "(통합) 깊이 틀린 generated ref → render-design.sh 비0 종료(존재성 게이트)" "[ $RC_INT -ne 0 ]"
check "(통합) 종료 메시지에 해당 ref 노출" "echo \"\$OUT_INT\" | grep -q '01-hero.png'"
# Playwright 도달 전(존재성 단계)에서 멈췄는지 — '렌더·검증 완료'(성공 종료문) 가 없어야 한다.
check "(통합) Playwright 도달 전(존재성 단계)에서 차단(성공 종료문 없음)" "! echo \"\$OUT_INT\" | grep -q '렌더·검증 완료'"
rm -rf "$ROOT/runs/$RID"

# 마무리 정리(다른 테스트와 동일 규약).
rm -rf "$ROOT"/runs/ci-rxd-* 2>/dev/null; true
echo "RXD: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
