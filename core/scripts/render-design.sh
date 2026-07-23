#!/usr/bin/env bash
# render-design.sh — 로컬 Playwright 렌더 + 섹션 PNG 분할 + design-manifest + 저작권 lint + export.
#   설계 §7.4/§9. 좌표 슬라이싱 금지(DOM 요소 단위). 셀프호스팅 폰트 재현성.
# 사용법: bash scripts/render-design.sh <run_id> [--option X]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
LOCK_OWN=0
if [ -z "${HARNESS_LOCK_HELD:-}" ]; then acquire_lock "$RID"; LOCK_OWN=1; export HARNESS_LOCK_HELD=1; fi
RDIR="$(run_dir "$RID")"
KV="$RDIR/04-keyvisual"
[ -d "$KV/options" ] || die "디자인 옵션이 없습니다. 먼저 bash scripts/run-stage.sh keyvisual $RID 를 실행하세요."

# ── P0-①(생성 이미지 선행): 렌더 '전'에 블록별 이미지를 보장한다(멱등). 키비주얼 HTML 이 참조하는
#   04-keyvisual/generated/NN-type.{svg,png} 가 lint·캡처 시점에 존재하도록. 엔진=resolve_image_engine
#   (삼중가드: 키 없음/오프라인/CI → 결정적 stub SVG, 골든 불변). 보유 락 재사용(image_engine.py 직접 호출 = gen-images.sh 재락 데드락 회피).
if [ -d "$RDIR/03-storyboard/plan" ] && [ -n "$(ls -A "$RDIR/03-storyboard/plan" 2>/dev/null)" ]; then
  # stdout(>/dev/null): image_engine 진단 print 의 'engine=' 잭곤이 현업 화면에 새지 않게(진단은 image-manifest.json 에 보존).
  # F1(C): --domain 으로 선언 규제도메인 전달 — 규제도메인은 그래픽 블록(html_only) 미생성(gen-images.sh 와 동일 술어).
  "$PY" "$HARNESS_ROOT/scripts/lib/image_engine.py" "$RID" "$RDIR" --engine "$(resolve_image_engine)" --domain "$(resolve_domain "$(state_file "$RID")")" >/dev/null \
    || info "[render-design] 블록 이미지 생성 일부 실패(기존 산출물/폴백으로 진행)."
fi

# ── P0-① 존재성 fail-closed: HTML/CSS 가 참조하는 '04-keyvisual/generated/' 이미지가 실제로 존재하는지 확인 ──
#   실엔진(nanobanana) 실패로 .png 미생성인데 HTML 이 .png 를 참조하는 등 '깨진 <img>'를 렌더가 조용히 통과시키지 않게(Codex HIGH).
#   ★ 옛 검사는 ref 의 ../ 깊이를 버리고 파일명(tail)만 고정 베이스에 붙여 봐서, 깊이가 틀린 경로(../×4 vs 정답 ../×5)도
#     거짓 통과시켰다(실런 사고 = 깨진 이미지가 done 까지 샘). 이제 렌더(file://)와 똑같이 'ref 가 든
#     파일의 디렉터리 기준'으로 절대경로를 풀어 디스크 존재를 확인한다 → 깊이 오류로 깨질 이미지를 렌더 전에 fail-closed 로 잡는다.
#   단계 A 범위는 generated/ 로 유지(폰트·자사컷 확장은 단계 B). 디코드는 check_render_refs.py 가 img_lint._refs 공용 SSoT 재사용.
"$PY" "$HARNESS_ROOT/scripts/lib/check_render_refs.py" "$KV/options" "$HARNESS_ROOT" || die "키비주얼이 참조하는 생성 이미지(04-keyvisual/generated/...)가 디스크에 없거나 경로(상대깊이)가 틀려 깨진 이미지로 렌더됩니다 — 렌더 차단(fail-closed). 위에 표시된 HTML의 이미지 경로를 확인하거나 이미지 생성(엔진/키)을 다시 시도하세요."

# ── 저작권 lint(allowlist): src/srcset/CSS url() 의 모든 리소스를 디코드·해석해 허용 출처만 통과 ──
"$PY" "$HARNESS_ROOT/scripts/lib/img_lint.py" "$KV/options" "$RDIR/inputs/bundle/product.json" \
  || die "저작권 위반: 디자인이 허용되지 않은 이미지 출처를 참조합니다(자사 자산/생성물/자사 제품 URL만 허용)."

# ── beforeAfter 디스클레이머: 해당 섹션 '안에' '개인차' + ('연출' 또는 '측정')이 있어야 한다(B-3 Seam C) ──
"$PY" "$HARNESS_ROOT/scripts/lib/check_beforeafter.py" "$KV/options" \
  || die "beforeAfter 섹션 안에 개인차 디스클레이머(연출 이미지=연출·개인차 / 측정 실사진=측정·개인차)가 필요합니다."

# ── 포맷 금지 블록(구매/가격 CTA 등) HTML 전수 스캔 — 렌더 전 fail-closed(비선택 옵션 포함, RCA 8-1.4) ──
"$PY" "$HARNESS_ROOT/scripts/lib/check_html_blocks.py" "$KV/options" "$RDIR" \
  || die "이 포맷에서 허용되지 않는 블록(예: 구매/가격 CTA)이 키비주얼 옵션 HTML 에 있습니다 — 렌더 차단(fail-closed)."

# ── 렌더 + 섹션 캡처 + manifest ──
"$PY" "$HARNESS_ROOT/scripts/lib/render.py" "$RDIR" "${@:2}"
validate_artifact "$KV/design-manifest.json" >/dev/null

# ── self-review.md (사람 검토용 요약; clean 판정은 다른 세션/사람) ──
"$PY" - "$KV" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json
kv = sys.argv[1]
m = load_json(os.path.join(kv, "design-manifest.json"))
L = ["# 디자인 자기검증 요약 (결정적 휴리스틱)\n",
     "> 최종 'clean' 판정은 **다른 세션 심의(kcia-check) 또는 사람 승인**이 내린다(self-grading 차단).\n\n",
     "| 섹션 | 높이 | layout_ok | overflow | contrast_ok |\n|---|---|---|---|---|\n"]
issues = 0
for s in m["sections"]:
    sr = s["self_review"]
    if (not sr["layout_ok"]) or sr["overflow"]:
        issues += 1
    L.append("| %s | %dpx | %s | %s | %s |\n" % (s["block"], s["height"], sr["layout_ok"], sr["overflow"], sr["contrast_ok"]))
L.append("\n총 섹션 %d · 잠재 이슈 %d (overflow/layout). 폭 %dpx·%ddpi.\n" % (len(m["sections"]), issues, m["width_px"], m["dpi"]))
open(os.path.join(kv, "self-review.md"), "w", encoding="utf-8").write("".join(L))
print("[self-review] 섹션 %d · 잠재 이슈 %d" % (len(m["sections"]), issues))
PYEOF

[ "$LOCK_OWN" = "1" ] && { unset HARNESS_LOCK_HELD; release_lock; }
ok "디자인 렌더·검증 완료: $RID (저작권 lint 통과, design-manifest 생성)"
exit 0
