#!/usr/bin/env bash
# test-gen-image-completeness.sh — '이미지 생성 직전 최종 경고'(방식 B) 회귀 가드.
#   비용·비가역 단계(대표 이미지 실생성, Nano Banana REST) '직전'에 결손→결과를 종합해 보여주고,
#   임계 결손(임상 측정치는 등록됐는데 시험성적서 요소가 빠짐 = must_fill)이면 멈춘다(생성≠심의; 멈춤은 셸만).
#   구성: scripts/lib/image_preflight.py(읽기전용 digest, 임계 시 exit 3·fail-open exit 0) +
#         scripts/run-stage.sh(keyvisual 이미지 생성 직전 게이트) + render_runmd(run.md digest/투영).
#
#   유닛(image_preflight.py 직접):
#     (1) 임계 결손 → exit 3 + digest 문구  (2) 임계 없음 → exit 0  (3) 디렉터리 부재 fail-open → exit 0
#     (4) 누수/가짜% 가드(stdout 에 내부코드·[0-9]+% 0건)
#   통합(run-stage.sh keyvisual 게이트):
#     (5) 오프라인/stub 면제(멈춤 없음)  (6) 온라인 임계 → 멈춤 + 비용 앞 차단(이미지엔진 미도달)
#     (7) 온라인 임계 + HARNESS_ACK_GAPS=1 → 멈춤 없음 + 감사 한 줄  (8) --proceed-with-gaps 플래그 → 7과 동일
#     (9) image-manifest 존재(멱등 재진입) → 멈춤 없음(점검 건너뜀)
#   run.md(render_runmd):
#     (10) manifest 부재 → '최종 점검' digest + 투영  (11) manifest 존재 → '보완하면 더 좋아요'(사후노출 차단)
#
#   결정적: 유닛/render 는 무네트워크. 통합 온라인 케이스는 HARNESS_NO_DOTENV=1 로 라이브 키 차단(REST 미호출) +
#   resolve_image_engine 이 키 없어 별도 사유로 die 해도 정상(핵심 단정 = 멈춤 문구 유무 / 비용 앞 차단).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 이미지 생성 직전 최종 경고(image_preflight + run-stage 게이트 + run.md digest)"

# 주변 codex 활성 마커(CODEX_THREAD_ID 등)가 있으면 detect_insession_engine 이 '신뢰 마커' die 로 빠져
#   온라인 insession 케이스가 환경 때문에 깨진다 → 활성 마커만 제거(test-insession-genmode 와 동일 화이트리스트).
for _v in $(env | grep -E '^CODEX_' | grep -vE '^CODEX_(COMPANION|HOME|MANAGED_BY_NPM|BIN|CONFIG|NPM|VERSION)' | cut -d= -f1); do
  unset "$_v" 2>/dev/null || true
done

RIDS="ci-gic-u1 ci-gic-u2 ci-gic-i5 ci-gic-i6 ci-gic-i7 ci-gic-i8 ci-gic-i9 ci-gic-i9b ci-gic-r10 ci-gic-r11 ci-gic-ho1 ci-gic-ho2 ci-gic-ho3 ci-gic-ho4"
cleanup() {
  # per-run 계약: 생성물은 런-로컬 04-keyvisual/generated/ → runs/<id> 제거로 함께 정리(옛 공유 generated 폐기).
  for r in $RIDS; do rm -rf "$ROOT/runs/$r" 2>/dev/null || true; done
}
trap cleanup EXIT

# 임계 결손 evidence(측정쌍만 — 시험기관·참여자수·기간 빠짐 = kcia_engine 4요소 게이트와 동일 어휘의 must_fill).
CRIT_CB='{"evidence_on_file":[{"id":"e","kind":"clinical_trial","before":50.0,"after":40.0}]}'
# 임상 근거 0건(must_fill 없음 — 측정 차트 자체가 대상 아님).
NOEV_CB='{"evidence_on_file":[]}'
# 충실한 HTML(빈 <html>시안</html> 은 insession_primary_ok 의 validate 가 무효처리할 수 있어 회피).
KV_HTML='<!doctype html><html><head><meta charset="utf-8"></head><body><h1>시안</h1></body></html>'

# 04-keyvisual·step generate·plan 13블록 픽스처 시드 + claim-basis 주입.
seed_kv() {  # seed_kv <rid> <claim-basis-json>
  local rid="$1" cb="$2"
  rm -rf "$ROOT/runs/$rid"
  cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$ROOT/runs/$rid"
  printf '%s' "$cb" > "$ROOT/runs/$rid/00-ingest/claim-basis.json"
}
# 통합용: insession 1차 검증 통과에 필요한 options A/B/C + recommendation.json 추가.
seed_kv_primary() {  # seed_kv_primary <rid> <claim-basis-json>
  local rid="$1"
  seed_kv "$1" "$2"
  mkdir -p "$ROOT/runs/$rid/04-keyvisual/options/A" "$ROOT/runs/$rid/04-keyvisual/options/B" "$ROOT/runs/$rid/04-keyvisual/options/C"
  printf '%s' "$KV_HTML" > "$ROOT/runs/$rid/04-keyvisual/options/A/index.html"
  printf '%s' "$KV_HTML" > "$ROOT/runs/$rid/04-keyvisual/options/B/index.html"
  printf '%s' "$KV_HTML" > "$ROOT/runs/$rid/04-keyvisual/options/C/index.html"
  printf '%s' '{"ranked":["A","B","C"],"rationale":"테스트용 추천 사유"}' > "$ROOT/runs/$rid/04-keyvisual/recommendation.json"
}
# 온라인 insession 호출(레시피 고정): 라이브 키 차단 + codex 마커 언셋 + Claude 세션 모사.
#   ⚠ 라이브 키 차단은 HARNESS_NO_DOTENV=1(.env 미로드)만으로는 부족하다 — 이미 export 된 NANOBANANA_API_KEY 가
#     override(ACK) 경로에서 실제 유료 Nano Banana REST 를 호출할 수 있다(외부리뷰). 그래서 env -u 로 키 자체를 제거한다.
run_online() {  # run_online <args...>  (예: bash scripts/run-stage.sh keyvisual <id>)
  ( cd "$ROOT" && env -u HARNESS_OFFLINE -u CODEX_THREAD_ID -u CODEX_SANDBOX -u NANOBANANA_API_KEY \
      HARNESS_NO_DOTENV=1 CLAUDECODE=1 HARNESS_GEN_MODE=insession HARNESS_CLI=claude "$@" ) 2>&1
}
# 주변 세션 신뢰 마커로 die 했으면(거짓 실패 금지) 환경 제약으로 스킵 처리. 스킵이면 0 반환.
trust_skip() {  # trust_skip <label> <output>
  if printf '%s' "$2" | grep -q '신뢰 마커'; then
    pass "$1 — 환경 제약(주변 세션 신뢰 마커)으로 스킵"
    return 0
  fi
  return 1
}

# 누수/가짜% 금지 토큰(유닛 stdout·run.md 공통). 실제 카운트만 허용 → [0-9]+% 는 0건이어야.
FORBID='human-verify|hard-stop|scope=|escalated|must_fill|nice_to_have|institution|sample_size|change_pct|p_value|claim[-_]basis|verdict|VOC|RTB'

# ── (1) 유닛: 임계 결손 → exit 3 + digest 문구 ──
seed_kv ci-gic-u1 "$CRIT_CB"
PF1="$(python3 "$ROOT/scripts/lib/image_preflight.py" ci-gic-u1 "$ROOT/runs/ci-gic-u1" 2>/dev/null)"; RC1=$?
check "(1) 임계 결손 → exit 3" "[ $RC1 -eq 3 ]"
check "(1) digest 제목 노출" "printf '%s' \"\$PF1\" | grep -q '대표 이미지 만들기 전 마지막 점검'"
check "(1) '꼭 채우는 게 좋아요' 헤더" "printf '%s' \"\$PF1\" | grep -q '꼭 채우는 게 좋아요'"
check "(1) '이대로 진행하면' 투영" "printf '%s' \"\$PF1\" | grep -q '이대로 진행하면'"

# ── (2) 유닛: 임계 없음(evidence 0) → exit 0 ──
seed_kv ci-gic-u2 "$NOEV_CB"
python3 "$ROOT/scripts/lib/image_preflight.py" ci-gic-u2 "$ROOT/runs/ci-gic-u2" >/dev/null 2>&1; RC2=$?
check "(2) 임계 없음(evidence 0) → exit 0" "[ $RC2 -eq 0 ]"

# ── (3) 유닛: 디렉터리 부재 → fail-open exit 0 ──
python3 "$ROOT/scripts/lib/image_preflight.py" ci-gic-none "$ROOT/runs/ci-gic-does-not-exist" >/dev/null 2>&1; RC3=$?
check "(3) 디렉터리 부재 → fail-open exit 0" "[ $RC3 -eq 0 ]"

# ── (4) 유닛: 누수/가짜% 가드 — (1) stdout 에 내부코드·[0-9]+% 0건 ──
HIT4="$(printf '%s' "$PF1" | grep -nE "$FORBID" || true)"
check "(4) digest 에 내부 코드/필드명 누수 0" "[ -z \"\$HIT4\" ]"
PCT4="$(printf '%s' "$PF1" | grep -nE '[0-9]+%' || true)"
check "(4) digest 에 가짜 정량([0-9]+%) 0건" "[ -z \"\$PCT4\" ]"

# ── (5) 통합: 오프라인/stub 면제 → 멈춤 없음(STUB_MODE 면제, CI/골든 결정성 불변) ──
seed_kv_primary ci-gic-i5 "$CRIT_CB"
OUT5="$( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub bash scripts/run-stage.sh keyvisual ci-gic-i5 2>&1 )"
check "(5) 오프라인/stub 면제 — 멈춤 문구 없음" "! printf '%s' \"\$OUT5\" | grep -q '지금은 멈췄어요'"

# ── (6) 통합: 온라인 임계 → 멈춤 + 비용 앞 차단(이미지엔진 미도달) ──
seed_kv_primary ci-gic-i6 "$CRIT_CB"
OUT6="$(run_online bash scripts/run-stage.sh keyvisual ci-gic-i6)"; RC6=$?
if trust_skip "(6) 온라인 임계 → 멈춤" "$OUT6"; then :; else
  check "(6) 온라인 임계 → 멈춤 문구 노출" "printf '%s' \"\$OUT6\" | grep -q '지금은 멈췄어요'"
  check "(6) 멈춤 시 rc≠0" "[ $RC6 -ne 0 ]"
  # 비용 앞 차단: 이미지 엔진 미도달(resolve_image_engine 진단·생성물·manifest 없음).
  check "(6) 이미지엔진 미도달(엔진 진단줄 없음)" "! printf '%s' \"\$OUT6\" | grep -qiE 'nanobanana|이미지 엔진='"
  check "(6) image-manifest 미생성(비용 앞 차단)" "[ ! -f \"$ROOT/runs/ci-gic-i6/04-keyvisual/image-manifest.json\" ]"
  check "(6) 생성물 디렉터리 미생성(비용 앞 차단)" "[ ! -d \"$ROOT/runs/ci-gic-i6/04-keyvisual/generated\" ]"
fi

# ── (7) 통합: 온라인 임계 + HARNESS_ACK_GAPS=1 → 멈춤 없음 + 감사 한 줄(그대로 진행) ──
seed_kv_primary ci-gic-i7 "$CRIT_CB"
OUT7="$(HARNESS_ACK_GAPS=1 run_online bash scripts/run-stage.sh keyvisual ci-gic-i7)"
if trust_skip "(7) ACK_GAPS override" "$OUT7"; then :; else
  check "(7) ACK_GAPS → 멈춤 문구 없음" "! printf '%s' \"\$OUT7\" | grep -q '지금은 멈췄어요'"
  check "(7) ACK_GAPS → 감사 한 줄('그대로' 진행)" "printf '%s' \"\$OUT7\" | grep -q '그대로'"
fi

# ── (8) 통합: 온라인 임계 + --proceed-with-gaps 플래그 → 7과 동일(멈춤 없음 + 감사 한 줄) ──
seed_kv_primary ci-gic-i8 "$CRIT_CB"
OUT8="$(run_online bash scripts/run-stage.sh keyvisual ci-gic-i8 --proceed-with-gaps)"
if trust_skip "(8) --proceed-with-gaps override" "$OUT8"; then :; else
  check "(8) 플래그 override → 멈춤 문구 없음" "! printf '%s' \"\$OUT8\" | grep -q '지금은 멈췄어요'"
  check "(8) 플래그 override → 감사 한 줄('그대로' 진행)" "printf '%s' \"\$OUT8\" | grep -q '그대로'"
fi

# ── (9) 통합: '실엔진(nanobanana)' 매니페스트 존재(실생성 완료 모사) + 온라인 임계 → 멈춤 없음(멱등 재진입 보존) ──
seed_kv_primary ci-gic-i9 "$CRIT_CB"
echo '{"engine":"nanobanana","assets":[]}' > "$ROOT/runs/ci-gic-i9/04-keyvisual/image-manifest.json"
OUT9="$(run_online bash scripts/run-stage.sh keyvisual ci-gic-i9)"
if trust_skip "(9) 실엔진 manifest 재진입" "$OUT9"; then :; else
  check "(9) 실엔진(nanobanana) manifest 존재 → 멈춤 문구 없음(점검 건너뜀)" "! printf '%s' \"\$OUT9\" | grep -q '지금은 멈췄어요'"
fi

# ── (9b) 통합: 'stub' 매니페스트(오프라인 산출, 실생성 전) + 온라인 임계 → preflight 가 돌아 멈춤(stub→online 우회 차단, 외부리뷰) ──
seed_kv_primary ci-gic-i9b "$CRIT_CB"
echo '{"engine":"stub","assets":[]}' > "$ROOT/runs/ci-gic-i9b/04-keyvisual/image-manifest.json"
OUT9B="$(run_online bash scripts/run-stage.sh keyvisual ci-gic-i9b)"
if trust_skip "(9b) stub manifest + 온라인" "$OUT9B"; then :; else
  check "(9b) stub manifest → preflight 작동(멈춤 문구 있음 — stub→online 우회 차단)" "printf '%s' \"\$OUT9B\" | grep -q '지금은 멈췄어요'"
fi

# ── (10) run.md: manifest 부재 → '최종 점검' digest + 예정 장수 + 투영 ──
seed_kv ci-gic-r10 "$CRIT_CB"
HARNESS_ROOT="$ROOT" python3 "$ROOT/scripts/lib/render_runmd.py" ci-gic-r10 "$ROOT/runs/ci-gic-r10" >/dev/null 2>&1
RM10="$ROOT/runs/ci-gic-r10/run.md"
check "(10) run.md '이미지 생성 전 최종 점검' 노출" "grep -q '이미지 생성 전 최종 점검' '$RM10'"
check "(10) run.md 예정 생성 장수('장을 새로 만들 예정')" "grep -q '장을 새로 만들 예정' '$RM10'"
check "(10) run.md '이대로 진행하면' 투영" "grep -q '이대로 진행하면' '$RM10'"
check "(10) run.md 내부코드/필드명 누수 0" "! grep -Eq \"$FORBID\" '$RM10'"
check "(10) run.md 가짜 정량([0-9]+%) 0건" "! grep -Eq '[0-9]+%' '$RM10'"

# ── (11) run.md: manifest 존재 후 재렌더 → '최종 점검' 사라지고 '보완하면 더 좋아요'(생성 후 사후노출 차단) ──
seed_kv ci-gic-r11 "$CRIT_CB"
mkdir -p "$ROOT/runs/ci-gic-r11/04-keyvisual"
echo '{"engine":"stub","assets":[]}' > "$ROOT/runs/ci-gic-r11/04-keyvisual/image-manifest.json"
HARNESS_ROOT="$ROOT" python3 "$ROOT/scripts/lib/render_runmd.py" ci-gic-r11 "$ROOT/runs/ci-gic-r11" >/dev/null 2>&1
RM11="$ROOT/runs/ci-gic-r11/run.md"
check "(11) manifest 존재 → '이미지 생성 전 최종 점검' 미노출(사후노출 차단)" "! grep -q '이미지 생성 전 최종 점검' '$RM11'"
check "(11) manifest 존재 → '보완하면 더 좋아요' 노출" "grep -q '보완하면 더 좋아요' '$RM11'"

# ══════════════════════════════════════════════════════════════════════════════
#   render_mode == "html_only" 생성 제외(공유 계약) — html-only 렌더 블록은 생성 이미지를
#   만들지 않고 HTML 레이어로만 렌더한다. 단일 술어 _block_emits_image 가 (a) 판정 (b) 카운트
#   (c) 실제 생성(generate_all) 모두를 통제한다(드리프트 방지). render_mode 부재 = 후방호환(이미지 생성).
# ══════════════════════════════════════════════════════════════════════════════
echo "## render_mode=html_only 생성 제외(공유 계약) + 후방호환 + 골든 불변"

# fixtures/keyvisual-in 을 scratch run 으로 복사하고 한 블록(05-rtbSummary)을 html_only 로 표시.
#   원본 fixture(13블록 전부 이미지 생성 대상)는 건드리지 않고 복사본만 패치한다.
seed_kv_htmlonly() {  # seed_kv_htmlonly <rid> <NN-type>
  local rid="$1" stem="$2"
  rm -rf "$ROOT/runs/$rid"
  cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$ROOT/runs/$rid"
  python3 - "$ROOT/runs/$rid/03-storyboard/plan/$stem.json" <<'PY'
import json, sys
p = sys.argv[1]
b = json.load(open(p, encoding="utf-8"))
b.setdefault("visual", {})["render_mode"] = "html_only"
json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False)
PY
}

# ── (HO-a) _block_emits_image: render_mode=html_only → False · chart_data 규칙 유지 · 부재=True(후방호환) ──
HOA="$( cd "$ROOT" && python3 - <<'PY'
import sys, os
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
errs = []
def ok(c, l):
    if not c: errs.append(l)
# render_mode=html_only → False
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"kind": "graph", "render_mode": "html_only"}}) is False, "html_only not False")
# render_mode 부재 → True(후방호환)
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"kind": "photo"}}) is True, "absent not True(backcompat)")
# render_mode=image(명시) → True
ok(ie._block_emits_image({"type": "hero", "visual": {"kind": "nukki", "render_mode": "image"}}) is True, "image not True")
# chart_data 규칙 유지: clinicalEvidence + chart_data → False(render_mode 무관)
ok(ie._block_emits_image({"type": "clinicalEvidence", "visual": {"kind": "graph", "chart_data": {"x": 1}}}) is False, "chart_data clinical not False")
ok(ie._block_emits_image({"type": "beforeAfter", "visual": {"kind": "graph", "chart_data": {"x": 1}}}) is False, "chart_data beforeAfter not False")
# chart_data 없는 clinical 은 여전히 이미지 대상(chart_data 가 핵심 술어)
ok(ie._block_emits_image({"type": "clinicalEvidence", "visual": {"kind": "graph"}}) is True, "clinical no chart_data not True")
# ── 전제 전환(디자이너 핸드오프, docs/bm-designer-handoff-plan.md): 실엔진(온라인, 모델명 전달)이면 html_only
#   그래픽 블록도 이미지로 생성한다 — **티어 무관**(Pro·Flash 모두). stub(""/None)이면 제외(골든 불변).
#   discriminator = bool(model). ⚠ model 은 명시 인자만 — 술어는 ambient env 를 읽지 않는다(HO-a 는 common.sh 미경유 직접 호출).
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"render_mode": "html_only"}}, "gemini-3-pro-image") is True, "html_only+Pro not True(온라인 생성)")
# Flash(실엔진)도 이제 생성 대상 — 티어 무관(과거 제외 → 전제 전환으로 생성)
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"render_mode": "html_only"}}, "gemini-2.5-flash-image") is True, "html_only+Flash not True(티어무관 생성)")
# 빈 문자열/None 모델(stub) → 제외 유지(골든 불변)
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"render_mode": "html_only"}}, "") is False, "html_only+empty not False(stub 제외)")
ok(ie._block_emits_image({"type": "rtbSummary", "visual": {"render_mode": "html_only"}}, None) is False, "html_only+None not False(stub 제외)")
# chart_data 규칙은 모델 무관 — Pro 여도 chart 블록은 이미지 생성 안 함(항상 인라인 차트)
ok(ie._block_emits_image({"type": "clinicalEvidence", "visual": {"render_mode": "html_only", "chart_data": {"x": 1}}}, "gemini-3-pro-image") is False, "chart_data overrides Pro")
# render_mode 부재는 모델 무관 True(후방호환·골든 불변 — Pro 여도 자동 재분류 없음)
ok(ie._block_emits_image({"type": "hero", "visual": {"kind": "photo"}}, "gemini-3-pro-image") is True, "absent+Pro must stay True(골든 불변)")
# _is_pro_model 헬퍼 단위(명시 인자만·빈값/None 안전)
ok(ie._is_pro_model("gemini-3-pro-image") is True, "_is_pro_model Pro")
ok(ie._is_pro_model("gemini-2.5-flash-image") is False, "_is_pro_model Flash")
ok(ie._is_pro_model("") is False and ie._is_pro_model(None) is False, "_is_pro_model empty/None")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(HO-a) _block_emits_image: html_only→False·chart_data 유지·부재→True(후방호환) + Pro 복귀·chart 우선" "echo \"\$HOA\" | grep -q PYOK"
[ "${HOA##*PYOK}" = "$HOA" ] || true   # (HOA 가 PYFAIL 이면 위 check 가 그 라벨을 못 보이므로 진단 출력)
echo "$HOA" | grep -q PYFAIL && echo "    └ (HO-a 진단) $HOA"

# ── (HO-b) planned_image_summary: stub 회계(html_only 제외) vs 온라인 회계(html_only→image) · 합 불변 ──
seed_kv_htmlonly ci-gic-ho1 "05-rtbSummary"
# ⚠ 전제 전환: discriminator=bool(model). stub 회계는 model="" 를 **명시**해야 한다(model 미지정/None 은 _NB_MODEL
#   폴백인데 그 기본값[flash]도 이제 truthy → 온라인 취급이라 html_only 를 생성으로 집계). 실엔진 회계는 모델명 전달.
HOB="$( cd "$ROOT" && python3 - <<'PY'
import sys, os, json
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
from image_engine import planned_image_summary
base = planned_image_summary("../packs/cosmetic/fixtures/keyvisual-in", model="")   # 원본(전부 이미지) — stub 회계
stub = planned_image_summary("runs/ci-gic-ho1", model="")         # 1블록 html_only — stub 이면 제외
online = planned_image_summary("runs/ci-gic-ho1", model="gemini-2.5-flash-image")  # 실엔진 → 티어무관 생성
errs = []
def ok(c, l):
    if not c: errs.append(l)
# 원본: 13 image, 0 chart, 0 html_only (후방호환 baseline 불변)
ok(base == {"total": 13, "image": 13, "chart": 0, "html_only": 0}, "base summary drift: %r" % base)
# stub 회계: total 13, image 12(1 제외), html_only 1, chart 0
ok(stub["total"] == 13, "stub total != 13: %r" % stub)
ok(stub["image"] == 12, "stub image != 12 (stub html_only 미제외): %r" % stub)
ok(stub["html_only"] == 1, "stub html_only != 1: %r" % stub)
ok(stub["chart"] == 0, "stub chart != 0: %r" % stub)
ok(stub["image"] + stub["chart"] + stub["html_only"] == stub["total"], "stub sum invariant broken: %r" % stub)
# 온라인 회계(실엔진, 티어무관): html_only 블록이 image 로 집계되고 html_only 카운트에서 빠진다(예정 장수 정확도)
ok(online["total"] == 13, "online total != 13: %r" % online)
ok(online["image"] == 13, "online image != 13 (html_only 온라인 생성 미반영): %r" % online)
ok(online["html_only"] == 0, "online html_only != 0 (온라인이라 전부 image): %r" % online)
ok(online["chart"] == 0, "online chart != 0: %r" % online)
ok(online["image"] + online["chart"] + online["html_only"] == online["total"], "online sum invariant broken: %r" % online)
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(HO-b) planned_image_summary: stub 회계(html_only 제외) vs 온라인(html_only→image) + 합 불변" "echo \"\$HOB\" | grep -q PYOK"
echo "$HOB" | grep -q PYFAIL && echo "    └ (HO-b 진단) $HOB"

# ── (HO-c) generate_all: html_only 블록 PNG/SVG 미생성 + 매니페스트에 미포함 (stub 엔진, 오프라인) ──
seed_kv_htmlonly ci-gic-ho2 "05-rtbSummary"
( cd "$ROOT" && python3 scripts/lib/image_engine.py ci-gic-ho2 "$ROOT/runs/ci-gic-ho2" --engine stub ) >/dev/null 2>&1
GEN2="$ROOT/runs/ci-gic-ho2/04-keyvisual/generated"
MAN2="$ROOT/runs/ci-gic-ho2/04-keyvisual/image-manifest.json"
check "(HO-c) 매니페스트 생성됨" "[ -f \"$MAN2\" ]"
# html_only 블록(05-rtbSummary)의 생성물(svg/png)이 디스크에 없어야 한다.
check "(HO-c) html_only 블록 생성물 미생성(05-rtbSummary.svg/png 부재)" \
  "[ ! -e \"$GEN2/05-rtbSummary.svg\" ] && [ ! -e \"$GEN2/05-rtbSummary.png\" ]"
# 매니페스트 자산에 05-rtbSummary 가 없고, 나머지 12개는 들어있어야 한다(html_only 1개 제외).
HOC="$( python3 - "$MAN2" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assets = m.get("assets", [])
types = [a.get("type") for a in assets]
errs = []
def ok(c, l):
    if not c: errs.append(l)
ok("rtbSummary" not in types, "html_only block leaked into manifest: %r" % types)
ok(len(assets) == 12, "manifest asset count != 12 (13-1 html_only): %d" % len(assets))
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(HO-c) 매니페스트에 html_only 블록 미포함 + 자산 12개(13-1)" "echo \"\$HOC\" | grep -q PYOK"
echo "$HOC" | grep -q PYFAIL && echo "    └ (HO-c 진단) $HOC"
# 생성된 매니페스트는 스키마(image-asset.schema)를 통과해야 한다(계약 무결).
if ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$MAN2" ) >/dev/null 2>&1; then
  pass "(HO-c) html_only 제외 매니페스트 image-asset.schema 통과"
else
  fail "(HO-c) html_only 제외 매니페스트 스키마 검증 실패"
fi

# ── (HO-d) 후방호환·골든 불변: render_mode 없는 원본 fixture 는 13개 전부 생성(카운트·생성 불변) ──
#   optional render_mode 추가가 default=image(후방호환)라 기존 stub 산출이 안 변하는지 단언.
#   ⚠ 원본 fixture 무오염: generate_all 은 rdir 의 04-keyvisual 에 매니페스트를 쓰므로 절대 원본을 rdir 로 주지
#     않는다. 반드시 복사본(runs/ci-gic-ho3, render_mode 없는 13블록 그대로)을 rdir 로 준다.
seed_kv ci-gic-ho3 "$NOEV_CB"   # 원본 13블록 그대로(render_mode 없음) — 위 NOEV_CB 는 claim-basis 일 뿐, plan 은 13블록 불변
( cd "$ROOT" && python3 scripts/lib/image_engine.py ci-gic-ho3 "$ROOT/runs/ci-gic-ho3" --engine stub ) >/dev/null 2>&1
MAN3="$ROOT/runs/ci-gic-ho3/04-keyvisual/image-manifest.json"
HOD="$( python3 - "$MAN3" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assets = m.get("assets", [])
errs = []
def ok(c, l):
    if not c: errs.append(l)
# render_mode 없는 원본 → 13개 전부 생성(후방호환: 카운트 불변)
ok(len(assets) == 13, "backcompat asset count != 13: %d" % len(assets))
ok(all(a.get("status") == "fallback_stub" for a in assets), "backcompat status not all fallback_stub")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(HO-d) 후방호환: render_mode 없는 fixture 는 13개 전부 생성(골든 불변)" "echo \"\$HOD\" | grep -q PYOK"
echo "$HOD" | grep -q PYFAIL && echo "    └ (HO-d 진단) $HOD"
# 골든 불변 확인: optional render_mode 스키마 추가가 후방호환이라 원본 fixture 13블록이 그대로 스키마 통과.
GEN_GOLDEN_OK=1
for bf in "$PACKS_DIR/cosmetic/fixtures/keyvisual-in/03-storyboard/plan/"*.json; do
  ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$bf" ) >/dev/null 2>&1 || GEN_GOLDEN_OK=0
done
check "(HO-d) 골든 불변: 원본 plan 13블록 전부 plan-block.schema 통과(스키마 후방호환)" "[ $GEN_GOLDEN_OK -eq 1 ]"

# ── (HO-e) generate_all Pro 라우팅(RCA 7-2 방식 a): html_only 블록도 실제 생성됨 ──
#   결정성·무네트워크: 실 Nano Banana 대신 유효 PNG 를 쓰는 스텁으로 _call_nanobanana 를 대체(라우팅 결정만 검증).
#   _NB_MODEL 은 import-time 상수라 HARNESS_NANOBANANA_MODEL 를 Pro 로 설정해 별 프로세스로 import → generate_all(nanobanana)이
#   model=_NB_MODEL(Pro)로 html_only 블록을 되살린다. 매니페스트에 model 기록(Wave1)도 함께 단언.
seed_kv_htmlonly ci-gic-ho4 "05-rtbSummary"
HOE="$( cd "$ROOT" && HARNESS_NANOBANANA_MODEL=gemini-3-pro-image python3 - "$ROOT/runs/ci-gic-ho4" <<'PY'
import sys, os
rdir = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
# 구조 유효 PNG(매직+IHDR+IDAT+IEND) — _existing_is_valid 재진입 검증 통과용. 네트워크 0회.
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
def _fake_call(prompt_obj, out_path, rdir):
    ie._atomic_write_bytes(out_path, VALID_PNG)   # 실호출 대체(무네트워크)
ie._call_nanobanana = _fake_call
errs = []
def ok(c, l):
    if not c: errs.append(l)
ok(ie._NB_MODEL == "gemini-3-pro-image", "NB_MODEL not Pro: %r" % ie._NB_MODEL)
m = ie.generate_all("ci-gic-ho4", rdir, "nanobanana")
assets = m.get("assets", [])
types = [a.get("type") for a in assets]
# Pro 라 html_only 블록(05-rtbSummary)도 생성 → 13개 전부 + rtbSummary 포함(비-Pro 였다면 12개·미포함)
ok("rtbSummary" in types, "Pro html_only not generated: %r" % types)
ok(len(assets) == 13, "Pro asset count != 13 (html_only 복귀 미반영): %d" % len(assets))
ok(m.get("model") == "gemini-3-pro-image", "manifest model not recorded: %r" % m.get("model"))
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
check "(HO-e) generate_all Pro → html_only 블록 이미지 생성 복귀(13개·rtbSummary 포함·model 기록)" "echo \"\$HOE\" | grep -q PYOK"
echo "$HOE" | grep -q PYFAIL && echo "    └ (HO-e 진단) $HOE"

printf '\n[gen-image-completeness] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
