#!/usr/bin/env bash
# kcia-check.sh — 심의 게이트 (설계 §8.5).
#   핵심 방어선: '생성과 다른 세션/벤더'의 원격 ADK 심의 + 결정적 룰엔진 프리필터 + evidence 존재성.
#   심의 엔진 = 원격 ADK(adk-http) 단일 — 도메인별 adk_critic 블록(packs/<도메인>/domain.json)으로 가용성을 판정한다.
#   로컬 헤드리스 크리틱(claude -p)·KCIA_CRITIC_CMD·self-grading substring 가드는 폐기(ADK 는 다른 벤더 원격 세션 = 충돌 불가).
# 사용법: bash scripts/kcia-check.sh <run_id>
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 심의 전 fail-closed(썩은 인입 위 verdict 생산 차단)
lock_acquire "$RID"
SF="$(state_file "$RID")"
RDIR="$(run_dir "$RID")"

GATE="$(jget "$SF" gate)"; STATUS="$(jget "$SF" status)"
if [ "$GATE" != "review" ] || [ "$STATUS" != "pending" ]; then
  die "지금은 규정 점검할 차례가 아니에요. run.md 의 '다음 명령'을 확인하세요."
fi

# (외부리뷰 R2 CRITICAL) 심의 면제(phase_has_review) 를 신뢰하기 '전' 디스크립터 무결성 검증 — 닫힌 스키마는 review 면제를
#   00g-guideline 에만 허용한다. 작업영역-쓰기 생성이 phase-descriptors.json 을 변조해 비-00g(예 02-concept)에 review:false
#   를 심으면 스키마-무효가 되고 route_assert_valid 가 여기서 fail-closed → 실심의 페이즈의 autopass 우회 차단(전이 게이트와 동일 검증).
route_assert_valid

# M4(C2): 03-storyboard substage 커서 필드가 부재(레거시/직접seed)면 verdict_path 읽기 전 1회 영속화(review 중 flip 차단).
ensure_storyboard_substage "$RID"
VP="$(verdict_path "$RID")"
mkdir -p "$(dirname "$VP")"

# ── 생성 엔진 토큰(GEN_SOURCE/GEN_CLI) 도출 — stub 생성 감지용 ──────────────────────────────────────────
#   심의 = 원격 ADK(다른 벤더 Gemini·원격 세션)뿐이라 로컬 CLI 충돌(self-grading)이 구조적으로 불가능 →
#   옛 'CRITIC_CMD substring 가드'는 폐기. 다만 'stub 생성(오프라인 결정성)이면 크리틱을 돌리지 않는다'는
#   결정을 위해 현재 stage 의 직전 generate 이벤트로 생성 엔진을 식별한다(형식 generate:(ok|insession):<stage>:<engine>).
#   stage-tied(외부리뷰 #4): 전역 마지막 문자열에 의존하면 다른 stage/이전 source 토큰이 살아 판단이 틀어진다.
_PHASE_NOW="$(jget "$SF" phase)"
if [ "$_PHASE_NOW" = "03-storyboard" ]; then
  _STAGE_NOW="storyboard-$(storyboard_substage "$RID")"   # 03 은 substage 부착(맵 SSoT 는 base 만)
else
  _STAGE_NOW="$(phase_stage "$_PHASE_NOW")"                # 페이즈→스테이지 맵 SSoT(harness/stage-phase-map.json)
fi
#   ⚠️ 폴백 금지(외부리뷰 2차 MAJOR): 전역/타phase 마지막 generate 로 폴백하면 cross-phase staleness 가, env(HARNESS_CLI)로
#   보정하면 malformed in-session 토큰이 가드를 통과한다. 따라서 '현재 stage 전이 이벤트'만 신뢰하고, raw 토큰으로 판정한다.
_genline="$("$PY" - "$SF" "$_STAGE_NOW" <<'PYEOF'
import sys, json, re
sf, stage = sys.argv[1], sys.argv[2]
h = json.load(open(sf)).get("history", [])
src, eng = "", ""
if stage:
    pat = re.compile(r'^generate:(ok|insession):' + re.escape(stage) + r':(.*)$')  # engine 은 raw 캡처(빈/비정상 토큰도 잡아 in-session hard-stop)
    matched = [m for e in h for m in [pat.match(e.get("event",""))] if m]
    if matched:
        src, eng = matched[-1].group(1), matched[-1].group(2)
print("%s\t%s" % (src, eng))   # eng 가 비면 '현재 stage 의 전이 generate 이벤트 없음' → 호출부에서 fail-closed/skip 판단
PYEOF
)" || true
GEN_SOURCE="${_genline%%$'\t'*}"
GEN_CLI="${_genline#*$'\t'}"     # raw (폴백·보정 전). in-session 검사는 이 raw 토큰으로 — env 보정으로 통과하는 우회 차단.
# WS-CRITIC-ENGINE: 심의 엔진 명시 선언(환경변수). 운영 심의 = 원격 ADK(adk-http) 단일 — 로컬 헤드리스 크리틱은 폐기.
#   값: ""(미설정 = 아래 도메인 resolve 가 결정) | adk-http(명시 선택). 로컬 크리틱 값(claude-subagent 등)·KCIA_CRITIC_CMD 는 더 이상 쓰지 않는다.
CRITIC_ENGINE="${KCIA_CRITIC_ENGINE:-}"
case "$CRITIC_ENGINE" in
  ""|adk-http) ;;
  *) die "KCIA_CRITIC_ENGINE 는 비워두거나 adk-http 여야 합니다(로컬 헤드리스 크리틱 폐기 — 그 외 값은 전부 거부). 현재: '$CRITIC_ENGINE'";;
esac
# 엔진 토큰 화이트리스트(source 무관; 외부리뷰 3차 MAJOR): 정상 run-stage 는 {claude,stub} 만 쓴다.
#   비어있지 않은 미상 토큰(generate:ok:brief:unknown 같은 손상 history)은 stub 판정을 왜곡하므로 hard-stop.
case "$GEN_CLI" in
  ""|claude|stub) ;;
  *) die "생성 엔진 토큰이 비정상('$GEN_CLI') — fail-closed(손상 history). state.json history 를 확인하세요.";;
esac
# in-session 이면 raw 토큰이 반드시 claude — 비면/미상이면 hard-stop(fail-closed; env 폴백으로 절대 보정하지 않는다).
if [ "$GEN_SOURCE" = "insession" ]; then
  case "$GEN_CLI" in
    claude) ;;
    *) die "in-session 생성 엔진 토큰이 비정상('$GEN_CLI') — fail-closed. 신뢰 마커로 생성 엔진을 확인할 수 없어 stub/실엔진 판정을 보장할 수 없습니다.";;
  esac
fi
# 생성 이벤트 부재(레거시·픽스처 시드·크래시 후 resume:transition 만 남은 정당한 재개).
#   심의 = 원격 ADK(다른 벤더 Gemini·원격 세션)뿐이라 생성 엔진이 무엇이든 self-grading 위험이 구조적으로 없다 →
#   생성 토큰 미상을 '하드스톱'할 이유가 없다(외부리뷰 P2: 온라인 resume 가 막혀 run 이 갇히는 문제 해소).
#   오프라인이면 stub(룰엔진-단독, 결정성), 온라인이면 빈 토큰 그대로 두고 실심의(ADK)로 진행한다(심의 여부는 GEN_CLI 가 아니라 HARNESS_OFFLINE+도메인 resolve 로 결정).
if [ -z "$GEN_CLI" ] && [ "${HARNESS_OFFLINE:-0}" = "1" ]; then
  GEN_CLI="stub"
fi

# ── (P0 결함 처방) 심의 바인딩: verdict 유효성을 '리뷰된 산출물 내용'에 묶는다 ──────────────────────────
#   문제: 재개(idempotent) 스킵이 state.history 의 'review:produced' 마커만 보고 재심의를 생략하면, verdict 가
#   통과한 '뒤' 리뷰된 산출물이 수정돼도 재심의 없이 done 까지 샌다(키비주얼 선택안 index.html 편집으로 실증).
#   처방: 마커를 남길 때 '그때 리뷰된 1차 산출물의 sha256'을 .logs 사이드카(review-binding.json)에 같이 적고,
#   재개 스킵 직전 현재 해시를 재계산해 대조한다 — 불일치(수정됨)·사이드카 부재면 스킵하지 않고 정식 재심의로 떨어진다.
#   전부 읽기전용·결정적이고 사이드카는 .logs(골든 제외)뿐이라 verdict.json·state.json 바이트는 불변. 마커-부재
#   위조방어(외부리뷰 5R)는 그대로 1차 게이트로 유지되고, 이 해시 대조는 그 '위'에 얹는 추가 방어다.
#   대상 = '바뀌면 반드시 재심의해야 하는' 리뷰된 1차 산출물(다안은 선택안; 키비주얼은 선택안 옵션 디렉터리
#     [index.html·styles.css·shots 포함 — CSS/샷 편집도 재심의 강제, 외부리뷰 P0]).
#     run-stage.sh 의 primary/ADK REVIEW_TARGET(=선택안 옵션 디렉터리) 매핑과 동일 규칙. verdict/decision 파일은 대상에서 제외.
_review_binding_target() {   # rid → 리뷰된 1차 산출물 경로(파일 또는 디렉터리) 1개, 없거나 미결정이면 빈 출력
  local rid="$1" rdir phase sel
  rdir="$(run_dir "$rid")"
  phase="$(jget "$(state_file "$rid")" phase 2>/dev/null || true)"
  case "$phase" in
    00a-intake)    printf '%s' "$rdir/00a-intake/intake-proposal.json" ;;
    00e-evidence)  printf '%s' "$rdir/00e-evidence/reflection-proposal.json" ;;
    00g-guideline) printf '%s' "$rdir/00g-guideline/reference-notes.json" ;;
    01-brief)      printf '%s' "$rdir/01-brief/brief.json" ;;
    02-concept)
      sel="$(jget "$rdir/02-concept/decision.json" selected 2>/dev/null || true)"
      if [ -n "$sel" ] && [ "$sel" != "null" ]; then printf '%s' "$rdir/02-concept/options/$sel"; fi ;;
    03-storyboard)
      if [ "$(storyboard_substage "$rid")" = "plan" ]; then
        printf '%s' "$rdir/03-storyboard/plan"
      else
        sel="$(jget "$rdir/03-storyboard/outline/decision.json" selected 2>/dev/null || true)"
        if [ -n "$sel" ] && [ "$sel" != "null" ]; then printf '%s' "$rdir/03-storyboard/outline/options/$sel"; fi
      fi ;;
    04-keyvisual)
      sel="$(jget "$rdir/04-keyvisual/decision.json" selected 2>/dev/null || true)"
      if [ -n "$sel" ] && [ "$sel" != "null" ]; then printf '%s' "$rdir/04-keyvisual/options/$sel"; fi ;;
  esac
  return 0
}
# 리뷰된 1차 산출물의 결정적 내용 해시(파일=바이트, 디렉터리=재귀 relpath+내용). 부재/미결정 → 빈 출력.
_review_binding_hash() {
  local rid="$1" target
  target="$(_review_binding_target "$rid")"
  [ -n "$target" ] || { printf ''; return 0; }
  "$PY" - "$target" <<'PYEOF' 2>/dev/null || true
import sys, os, hashlib
t = sys.argv[1]
h = hashlib.sha256()
if os.path.isfile(t):
    with open(t, "rb") as f:
        h.update(f.read())
    print(h.hexdigest())
elif os.path.isdir(t):
    files = []
    for root, _dirs, names in os.walk(t):
        for n in names:
            fp = os.path.join(root, n)
            files.append((os.path.relpath(fp, t), fp))
    for rel, fp in sorted(files):
        h.update(rel.encode("utf-8")); h.update(b"\0")
        try:
            with open(fp, "rb") as f:
                h.update(f.read())
        except OSError:
            pass
        h.update(b"\0")
    print(h.hexdigest())
else:
    print("")
PYEOF
}
# 사이드카 기록(.logs/review-binding.json = {stage:{id,artifact_sha256}}). .logs 는 골든 제외·best-effort.
_write_review_binding() {   # rid stage vid
  local rid="$1" stage="$2" vid="$3" ld hash
  ld="$(obs_logdir "$rid")" || return 0
  hash="$(_review_binding_hash "$rid")"
  [ -n "$hash" ] || return 0   # 대상 미결정/부재면 기록 안 함(스킵-검사는 '사이드카 없음 → 재심의'로 안전)
  "$PY" - "$ld/review-binding.json" "$stage" "$vid" "$hash" <<'PYEOF' 2>/dev/null || true
import sys, json, os
path, stage, vid, h = sys.argv[1:5]
try:
    d = json.load(open(path)) if os.path.exists(path) else {}
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
d[stage] = {"id": vid, "artifact_sha256": h}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF
  return 0
}
# 사이드카에서 이 stage 의 저장 해시 조회(없으면 빈 출력).
_read_review_binding() {   # rid stage → 저장 sha 또는 빈 문자열
  local rid="$1" stage="$2" f
  f="$(run_dir "$rid")/.logs/review-binding.json"
  [ -f "$f" ] || { printf ''; return 0; }
  "$PY" - "$f" "$stage" <<'PYEOF' 2>/dev/null || true
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    e = d.get(sys.argv[2]) if isinstance(d, dict) else None
    print(e.get("artifact_sha256", "") if isinstance(e, dict) else "")
except Exception:
    print("")
PYEOF
}

# 재개(idempotent): '내가(kcia-check) 이번 사이클에 실제로 생산한' verdict 만 재심의 생략한다.
#   (외부리뷰 5R CRITICAL) id 존재만 믿으면 위조 가능 — id 는 스키마상 자유 문자열이라, 외부가 *-verdict.json 에
#   {verdict:pass, id:forged} 를 미리 심으면 정상 kcia-check 명령으로도 심의가 스킵되어 advance 마커가 발행된다(생성≠심의 무력화).
#   → 완성 표지 = **state.history 의 'review:produced:<stage>:<id>' 마커(scripts 만 쓰는 비위조 state) 가 직전 generate 이후 존재**.
#   위조 verdict 는 이 마커가 없어 스킵 안 됨 → 아래 정식 심의가 위조본을 제거(line 149)하고 실제 baseline+critic 으로 재심의.
#   (정당한 idempotent 경로 = kcia-check 가 verdict 생산 후 gate.sh 호출 전 크래시한 복구뿐 — 그땐 마커가 이미 있다.)
if [ -f "$VP" ] && validate_artifact "$VP" >/dev/null 2>&1; then
  _vid="$(jget "$VP" id 2>/dev/null || true)"
  _prov="$("$PY" - "$SF" "$_STAGE_NOW" "$_vid" <<'PYEOF'
import sys, json, re
sf, stage, vid = sys.argv[1], sys.argv[2], sys.argv[3]
h = json.load(open(sf)).get("history", [])
if not stage or not vid or vid == "null":
    print("0"); raise SystemExit
genpat  = re.compile(r'^generate:(ok|insession):' + re.escape(stage) + r':')
prodpat = re.compile(r'^review:produced:' + re.escape(stage) + r':' + re.escape(vid) + r'$')
last_gen = max((i for i, e in enumerate(h) if genpat.match(e.get("event", ""))), default=-1)
# 현재 사이클(직전 generate 이후)에 이 stage·이 id 의 produced 마커가 있어야 정당(generate 이벤트 부재면 fail-closed=재심의).
produced = last_gen >= 0 and any(prodpat.match(e.get("event", "")) for e in h[last_gen + 1:])
print("1" if produced else "0")
PYEOF
)" || true
  if [ -n "$_vid" ] && [ "$_vid" != "null" ] && [ "$_prov" = "1" ]; then
    # (P0 결함 처방) 생산 증거(마커)만으론 부족 — verdict 통과 '뒤' 리뷰된 산출물이 수정됐는지도 확인한다.
    #   마커 생산 시 함께 적어둔 '리뷰된 1차 산출물 해시'(.logs 사이드카)와 현재 해시를 대조: 둘 다 있고 일치할 때만
    #   재심의 생략. 불일치(수정됨)·사이드카 부재면 스킵하지 않고 아래 정식 재심의로 떨어진다(수정본이 심의 없이 done 으로 새는 구멍 차단).
    _cur_bind="$(_review_binding_hash "$RID")"
    _stored_bind="$(_read_review_binding "$RID" "$_STAGE_NOW")"
    if [ -n "$_stored_bind" ] && [ -n "$_cur_bind" ] && [ "$_cur_bind" = "$_stored_bind" ]; then
      info "이미 심의된(생산 증거+산출물 내용 확인) verdict 존재 — 재심의 생략(idempotent)."
      bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" review
      lock_release; exit 0
    fi
    info "심의 통과 뒤 산출물이 바뀌었거나 심의 바인딩이 없어 재심의를 진행합니다(내용 해시 불일치)."
  fi
  info "기존 verdict 의 생산 증거(history 마커) 없음/불일치(미완성·구버전·위조 가능) — 재심의 진행."
fi

# autopass verdict writer (심의 면제·placeholder 공용). 인자: <vp> <engine> <id_suffix> <review_depth> <note>.
#   두 자동통과 경로(review-exempt·placeholder)가 동일한 verdict 골격(pass·conf 1.0·빈 violations·critic 미실행 가시화 필드)을
#   쓰던 python 블록 2벌을 1곳화. id·engine·review_depth·note 만 인자로 달라진다(동작·필드 불변).
_autopass_verdict() {  # vp engine id_suffix review_depth note
  "$PY" - "$@" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import atomic_write_json
vp, engine, id_suffix, review_depth, note = sys.argv[1:6]
vid = os.path.basename(vp).rsplit(".", 1)[0] + id_suffix   # WS-TRACE: 결정적 id(역참조용)
atomic_write_json(vp, {
    "verdict": "pass",
    "engine": engine,
    "confidence": 1.0,
    "violations": [],
    "escalate": False,
    "id": vid,
    "note": note,
    # 개선3(가시화): 자동 통과는 '실제 심의 안 함'이 진실 → 사후 감사로 식별 가능하게.
    "critic_ran": False,
    "critic_outcome": "skipped",
    "review_depth": review_depth,
})
PYEOF
}

# ── 심의 면제 페이즈(phase-descriptors review:false) → 실제 심의 없이 자동 통과(verdict=pass) ──
#   예: 00g-guideline(크롤 참조 노트). 참조 노트는 광고 카피가 아니라 다운스트림 '참조 입력'이며, 금지표현은 생성 시
#   validate-stage 룰엔진이 이미 차단하고, 실제 카피는 컨셉·스토리보드·키비주얼 단계에서 심의된다(중복 심의 제거).
#   ⚠ self-grading 가드·idempotent 재개(위)보다 '뒤'에 둔다 — 손상 history 는 면제 페이즈라도 그 가드들이 먼저 fail-closed 한다.
#   verdict_file 은 유지하므로(여기 autopass 가 쓴다) gate.sh review-pass·advance-phase·verdict_path 경로는 불변.
if [ "$(phase_has_review "$RID")" = "0" ]; then
  info "이 단계는 규정 점검 대상이 아니에요 — 참고용 자료라 자동 통과합니다(실제 표현 점검은 다음 단계들에서)."
  # (외부리뷰 R1 CRITICAL) 면제라도 autopass '전'에 현재 산출물을 재검증한다 — 생성 후 변조·수기편집으로 금지표현이 들어오는
  #   우회를 막는다. validate-stage 는 빠른 결정적 룰엔진(금지표현·스키마 검사)이지 크리틱이 아니므로, '중복 심의(크리틱) 제거'
  #   라는 사용자 의도를 깨지 않으면서 검증 우회만 차단한다(생성 시 동일 검사가 이미 도므로 정상 산출물엔 오탐 0). fail-closed.
  bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" "$(jget "$SF" phase)" >/dev/null \
    || die "이 단계 산출물이 자동 검증(금지표현·형식)을 통과하지 못했어요 — 표현을 고쳐 다시 만들어 주세요(면제 단계라도 금지표현은 차단합니다)."
  _autopass_verdict "$VP" "review-exempt-autopass" "-review-exempt" "exempt" \
    "페이즈 '$(jget "$SF" phase)' 는 심의 면제(phase-descriptors review:false). 크롤 참조 노트는 광고 카피가 아니라 다운스트림 참조 입력이며, 금지표현은 생성 시 validate-stage 룰엔진이 차단하고 실제 카피는 컨셉·스토리보드·키비주얼 단계에서 심의된다."
  validate_artifact "$VP" >/dev/null
  ok "규정 점검 마침 — 이 단계는 점검 대상이 아니라 자동 통과했어요"
  # 위조 방지(외부리뷰 5R): review-exempt-autopass 도 생산 증거 마커를 남긴다(idempotent-skip provenance 일관).
  append_history "$SF" "$(jget "$SF" phase)" "review:produced:${_STAGE_NOW}:$(jget "$VP" id 2>/dev/null || true)" "kcia-check.sh"
  agui_emit "$RID"   # AG-UI 투영: 심의 결과 Custom(kcia.verdict) — 면제 autopass 도 요약 방출
  _write_review_binding "$RID" "$_STAGE_NOW" "$(jget "$VP" id 2>/dev/null || true)"   # P0: 리뷰된 산출물 해시 사이드카(재개-스킵이 수정본을 놓치지 않게)
  obs_provenance "$RID" review "review-exempt-autopass"   # L-1: autopass 도 심의 시점 실행기록(감사 로그가 주경로를 빠뜨리지 않도록, 외부리뷰 P3). .logs 골든제외·best-effort.
  bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" review
  lock_release; exit 0
fi

# ── TBD/미제공 규제도메인: 심의 가이드 부재 → 무조건 통과(placeholder) ──
#   레지스트리 status!=active 인 도메인(의약외품 등)은 실제 심의기준(ruleset)이 추후 제공될 때까지
#   심의를 '무조건 통과'로 둔다(사용자 합의). verdict.note 로 '추후 제공 필요'를 남긴다. 실제 룰셋 채우면 자동 해제.
DOMAIN="$(resolve_domain "$SF")"   # DRY: common.sh resolve_domain (산재 폴백 일원화)
DOM_STATUS="$(domain_field "$DOMAIN" status)"; [ -n "$DOM_STATUS" ] || DOM_STATUS="active"   # 팩 레지스트리(packs/<도메인>/domain.json) 우선
if [ "$DOM_STATUS" != "active" ]; then
  # 안전필수 표면화(개선계획 단계4·7절 특수): 동작은 '통과'지만 진실은 '아직 점검 안 함' → 반드시 '사람 확인 필요'를 알린다.
  #   내부 경로/status 코드는 현업 화면에 노출하지 않는다(외부리뷰 MEDIUM) — verdict.note 에 운영 상세를 남긴다.
  info "$("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" placeholder)"
  _autopass_verdict "$VP" "placeholder-autopass" "-placeholder" "placeholder" \
    "규제도메인 '$DOMAIN'(status=$DOM_STATUS) 심의 가이드 미제공 → 무조건 통과(placeholder). 실제 심의기준(ruleset) 추후 제공 후 재심의 필요."
  validate_artifact "$VP" >/dev/null
  ok "규정 점검 마침 — 자동 통과로 처리했어요 (사람 확인 필요)"
  # 위조 방지(외부리뷰 5R): placeholder-autopass 도 생산 증거 마커를 남긴다(idempotent-skip provenance 일관).
  append_history "$SF" "$(jget "$SF" phase)" "review:produced:${_STAGE_NOW}:$(jget "$VP" id 2>/dev/null || true)" "kcia-check.sh"
  agui_emit "$RID"   # AG-UI 투영: 심의 결과 Custom(kcia.verdict) — placeholder autopass 도 요약 방출
  _write_review_binding "$RID" "$_STAGE_NOW" "$(jget "$VP" id 2>/dev/null || true)"   # P0: 리뷰된 산출물 해시 사이드카(재개-스킵이 수정본을 놓치지 않게)
  obs_provenance "$RID" review "placeholder-autopass"   # L-1: placeholder autopass 도 심의 시점 실행기록(감사 로그 완전성, 외부리뷰 P3). .logs 골든제외·best-effort.
  bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" review
  lock_release; exit 0
fi

# ── 데모(촬영) autopass: KCIA_DEMO_AUTOPASS=1 + HARNESS_OFFLINE=1 이중 게이트일 때만 실제 심의(크리틱/룰엔진) 생략 ──
#   ⚠ **촬영용 UX 데모 전용이지 컴플라이언스 판정이 아니다.** 실제 심의 규칙(예 화장품 질환/효능 타겟팅)을 건너뛰고
#   무조건 통과시킨다. 챗 표면 흐름(컨셉→선택→스토리보드→키비주얼)을 데모 제품으로 끝까지 촬영하기 위한 장치다.
#   **이중 게이트**로 온라인/프로덕션엔 절대 새지 않는다: HARNESS_OFFLINE=1(stub 게이트)이 아니면 이 분기는 죽어 있고,
#   KCIA_DEMO_AUTOPASS 를 명시 세팅해야만 켜진다(기본 미설정=0 → 실 심의 그대로). CI/골든은 이 env 를 안 켠다.
#   review-exempt/placeholder autopass 와 **같은 골격**(_autopass_verdict)이되 engine=demo-autopass 로 정직하게 라벨한다.
#   validate-stage(스키마·생성시 금지표현)는 유지 — 데모라도 기본 검증 우회는 없다(건너뛰는 건 적대 크리틱/심의 규칙뿐).
if [ "${KCIA_DEMO_AUTOPASS:-0}" = "1" ] && [ "${HARNESS_OFFLINE:-0}" = "1" ]; then
  info "데모(촬영) 모드 — 실제 규정 점검을 건너뛰고 자동 통과합니다(컴플라이언스 판정 아님)."
  bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" "$(jget "$SF" phase)" >/dev/null \
    || die "이 단계 산출물이 자동 검증(스키마·형식)을 통과하지 못했어요 — 표현을 고쳐 다시 만들어 주세요."
  _autopass_verdict "$VP" "demo-autopass" "-demo" "demo" \
    "촬영용 데모 모드(KCIA_DEMO_AUTOPASS=1 + HARNESS_OFFLINE=1) — 실제 심의(크리틱/룰엔진) 생략·무조건 통과. 컴플라이언스 판정이 아니라 UX 흐름 촬영 전용이다."
  validate_artifact "$VP" >/dev/null
  ok "규정 점검 마침 — 데모 모드 자동 통과(촬영용 · 컴플라이언스 판정 아님)"
  append_history "$SF" "$(jget "$SF" phase)" "review:produced:${_STAGE_NOW}:$(jget "$VP" id 2>/dev/null || true)" "kcia-check.sh"
  agui_emit "$RID"   # AG-UI 투영: 심의 결과 Custom(kcia.verdict) — 데모 autopass 도 요약 방출
  _write_review_binding "$RID" "$_STAGE_NOW" "$(jget "$VP" id 2>/dev/null || true)"
  obs_provenance "$RID" review "demo-autopass"
  bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" review
  lock_release; exit 0
fi

# ── 심의 모드 결정 = 도메인 ADK resolve (운영 심의 = 원격 ADK 단일) ──────────────────────────────────────
#   adk_critic.py resolve --domain <d> (네트워크 없음): exit 0=구현+설정됨 → ADK 강제(REQUIRED) · 3=설정오류 → fail-closed
#     · 4=미구현(adk_critic 블록 없음) → ADK 생략, 룰엔진-단독(허용, 반드시 가시화). offline(stub 게이트=HARNESS_OFFLINE=1)은 결정성상 resolve 를 건너뛴다(온라인은 GEN_CLI 무관하게 판정).
#   '구현됨' 마커 = packs/<도메인>/domain.json 의 adk_critic 블록(화장품 O · 의약품 등 미제공 → 4). KCIA_CRITIC_ENGINE=adk-http
#   명시도 같은 resolve 경로를 탄다(명시 선언은 4=미구현이면 동일하게 룰엔진-단독으로 떨어지되 가시화).
ADK_MODE=0; CRITIC_CONFIGURED=0
if [ "${HARNESS_OFFLINE:-0}" != "1" ]; then
  # 온라인이면 GEN_CLI 무관하게 ADK 가용성 판정(stub 게이트=HARNESS_OFFLINE 단 하나). 구현 도메인은 stub-생성/복사본이라도 ADK 강제 —
  #   온라인+GEN_CLI=stub 가 룰엔진-단독으로 '무음 강등'되던 구멍 차단(외부리뷰 P2). CI/오프라인은 아래 룰엔진-baseline 경로(결정성 불변).
  _adk_url=""; _adk_rc=0
  _adk_url="$("$PY" "$HARNESS_ROOT/scripts/lib/adk_critic.py" resolve --domain "$DOMAIN" 2>/dev/null)" || _adk_rc=$?
  case "$_adk_rc" in
    0)  # 구현 + 설정됨 → ADK 강제(강등 금지). preflight 로 엔드포인트 사전검증(부모에서 fail-closed).
        ADK_MODE=1; CRITIC_CONFIGURED=1; ADK_CRITIC_URL="$_adk_url"; export ADK_CRITIC_URL
        KCIA_CRITIC_REQUIRED=1; export KCIA_CRITIC_REQUIRED   # 구현+설정 도메인은 무조건 강제 — 명시 =0 이어도 조용한 강등 금지(:= 누수 차단)
        info "심의 엔진: 원격 ADK(도메인 $DOMAIN) — 강등 금지(fail-closed)."
        "$PY" "$HARNESS_ROOT/scripts/lib/adk_critic.py" preflight --domain "$DOMAIN" >/dev/null 2>&1 \
          || die "도메인 '$DOMAIN' ADK 심의 엔드포인트 설정이 유효하지 않습니다 — 원격 심의가 조용히 강등되면 안 됩니다(fail-closed). .env 의 해당 *_CRITIC_URL(https)·*_CRITIC_ALLOWED_HOST 를 확인하세요."
        ;;
    3)  # adk_critic 블록은 있으나 URL env 가 비었음 = 설정오류 → fail-closed(구현된 도메인은 조용한 강등 금지).
        die "도메인 '$DOMAIN' ADK 심의 엔드포인트 설정이 없습니다(.env 의 해당 *_CRITIC_URL 확인) — 구현된 도메인은 조용한 강등 금지(fail-closed)."
        ;;
    4)  # adk_critic 블록 없음 = ADK 미구현 → 생략하고 룰엔진-단독으로 진행(허용). 반드시 가시화한다(조용한 강등 금지).
        #   ADK_MODE/CRITIC_CONFIGURED 는 0 으로 유지 → CRITIC_WILL_RUN=0 → merge 가 critic_ran=False·outcome=skipped·review_depth=rule_engine_only 로 기록.
        info "이 제품군은 전문 심의(원격)가 아직 준비되지 않았어요 — 자동 규칙 점검만 했고 사람 확인을 권장합니다."
        ;;
    *)  die "ADK 심의 가용성 판정에 실패했습니다(adk_critic.py resolve rc=$_adk_rc) — fail-closed. 도메인 설정(packs/$DOMAIN/domain.json)을 확인하세요."
        ;;
  esac
fi

ENGINE_NAME="subagent"   # 문서 기반 서브에이전트(또는 오프라인 결정적 stand-in). 심의 = 원격 ADK 단일(로컬 헤드리스 폐기).

# ── 작업영역 '밖' 단일 scratch (불변식: verdict_path($VP) 존재 ⟺ merge 완료 = id 보유, 완성) ──────────
#   설계: 모든 중간물(baseline·후보·Pass-B결과)은 critic 쓰기범위(workspace=$HARNESS_ROOT) '밖' scratch 에 둔다.
#   - baseline 은 $VP 가 '아니라' scratch 에 쓴다 → 어떤 실패/비정상종료도 $VP 를 부분상태로 남기지 못한다(재개 fail-open 원천 차단).
#   - $VP 는 오직 merge 가 '완성 verdict 를 단 한 번 원자적으로' 쓸 때만 출현한다(merge 실패 → $VP 미작성 → 재심의).
#   - critic 출력(passa/passb)은 critic 샌드박스상 workspace 에만 쓸 수 있으므로, 성공 즉시 scratch 로 스냅샷 →
#     merge 는 scratch 만 읽는다(critic 의 사후 변조/TOCTOU 무력화). scratch 는 쓰기범위 밖이라 critic 이 못 건드린다.
#   ⚠️ 격리 전제: 심의 = 원격 ADK(adk_critic.py)뿐 — 로컬 CLI 가 아니다. adk_critic.py 가 작업영역(workspace)의 $PASSA/$PBF 에만 쓰도록
#     호출되므로(spawn_session 샌드박스 + 인자 기반), 그래도 만약 $VP 가 위조되면 → 아래 (i) merge 미완료 시 trap 이 $VP 삭제 (ii) merge 전 $VP 선출현 검출
#   ⚠️ 읽기 전제(단계3 규제 팩화·외부리뷰 단계3 High): 규제 룰셋(DOM_RULESET_REL)·도메인 가이드 원문은 이제 packs/(core 형제, cwd 밖)에 있다.
#     adk_critic.py 는 --ruleset 절대경로를 '읽고'(쓰기 아님) 도메인 가이드를 내부에서 참조한 뒤 원격 ADK 로 심의한다. 룰엔진(kcia_engine)은 무관하게 결정적 enforce.
#     (iii) baseline 해시(메모리) 검증 으로 다중 방어한다. scratch(쓰기범위 밖)는 그 위에서의 추가 격리다.
# 작업영역 무결성 매니페스트: state.json + run 의 JSON 산출물 + 규제 룰셋 의 결합 해시.
#   허용 출력($PASSA=*.passa·$PBDIR/*·$VP)은 제외 — critic 이 '그 외' 파일(state/검사 산출물/다른 verdict/룰셋)을 변조하면 검출.
_manifest() {
  { cat "$SF" 2>/dev/null
    find "$RDIR" -type f -name '*.json' ! -path "$PBDIR/*" ! -path "$RDIR/.logs/*" ! -name "$(basename "$VP")" -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 cat 2>/dev/null
    find "$PACKS_DIR" "$HARNESS_ROOT/docs/reference/regulation" -type f \( -name '*.json' -o -name '*.md' \) -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 cat 2>/dev/null
  } | sha256_hex
}
_outside_ws() { local hr rb; hr="$(cd "$HARNESS_ROOT" && pwd -P)" || return 1; rb="$(cd "$1" 2>/dev/null && pwd -P)" || return 1; case "$rb/" in "$hr/"*) return 1;; *) return 0;; esac; }
SNAP_BASE="${TMPDIR:-/tmp}"
_outside_ws "$SNAP_BASE" || die "임시 scratch 위치($SNAP_BASE)가 작업영역 밖이 아니거나 접근 불가 — 심의 격리 불가, 중단(fail-closed). TMPDIR 을 작업영역 밖으로 설정하세요."
SCRATCH="$(mktemp -d "$SNAP_BASE/kcia.XXXXXX")"
BASE="$SCRATCH/baseline.json"; PASSA_SNAP="$SCRATCH/passa.json"; PBSNAP="$SCRATCH/pb"; mkdir -p "$PBSNAP"
PASSA="$VP.passa"; PBDIR="$VP.passb.d"; rm -f "$VP" "$PASSA"; rm -rf "$PBDIR"; mkdir -p "$PBDIR"   # $VP 선제거(재심의 시 옛 id-less 잔존 제거)
MERGE_OK=0   # 완료 표지. critic 이 $VP 를 위조하고 merge 전 죽으면, trap 이 미완료 $VP 를 삭제 → 재실행 fail-open 차단.
# 정리: scratch + workspace 중간물 + (merge 미완료면) $VP 삭제 + lock.
trap 'rm -rf "${SCRATCH:-}" 2>/dev/null || true; rm -f "${PASSA:-}" 2>/dev/null || true; rm -rf "${PBDIR:-}" 2>/dev/null || true; [ "${MERGE_OK:-0}" = 1 ] || rm -f "$VP" 2>/dev/null || true; release_lock' EXIT INT TERM

# ── 1차: 결정적 룰엔진 프리필터 + evidence 존재성 → scratch baseline ($VP 가 아니다) ──
_REV_T0="$(date +%s)"   # 개선0(측정): 심의 전체 소요 시작.
# O-3(진행 신호): 심의 시작 레코드(완료 전이라도 '진행 중' 가시화 — 정체 오인 방지). duration 없음 = in-flight.
obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review gen_source=review outcome=start
# L-1 provenance(실행 기록)는 심의 엔진이 '해석된 뒤'(아래 CRITIC_ENGINE_LABEL 결정 후)에 기록한다 — 시작 시점의
#   ENGINE_NAME 은 레거시 'subagent' 라벨이라 ADK 심의가 룰단독과 구분 안 됨(외부리뷰 P3). autopass 경로는 각 분기서 기록.
"$PY" "$HARNESS_ROOT/scripts/lib/kcia_engine.py" "$RID" "$RDIR" "$BASE" --engine "$ENGINE_NAME"
BASE_HASH="$(sha256_hex "$BASE")"   # baseline(불멸) 무결성 해시 — 프로세스 메모리에 보관(critic 이 scratch 를 만져도 이 값은 못 바꾼다).

# ── 2차(선택): 원격 ADK 2-pass (WS-CRITIC-B) — ADK 구현+설정됨(resolve 0) + 비오프라인 + 비stub ──
#   Pass-A(선택안 산출물): 룰엔진이 놓친 문맥 위반 '후보'($PASSA, workspace)를 성공 시 scratch 로 스냅샷.
#   Pass-B(건별 적대검증): 후보를 '한 건씩 격리' default=틀림 반박. 성공 결과만 scratch 로 스냅샷. baseline 위반은 대상 아님(불멸).
CAP="${KCIA_CRITIC_FANOUT_CAP:-8}"
MERGE="$HARNESS_ROOT/scripts/lib/kcia_merge.py"
CRITIC_RAN=0
CRITIC_OUTCOME="skipped"   # 개선3(강등 가시화): 크리틱 미실행(offline/stub/ADK 미구현) 기본. 실행 시 ok|failed|timeout 로 갱신.
CRITIC_WILL_RUN=0; { [ "$CRITIC_CONFIGURED" = "1" ] && [ "${HARNESS_OFFLINE:-0}" != "1" ]; } && CRITIC_WILL_RUN=1
# critic 호출 '전' 작업영역 무결성 매니페스트(허용 출력 제외). 호출 후 불일치 = critic 이 다른 파일을 변조 → fail-closed.
[ "$CRITIC_WILL_RUN" = 1 ] && MANIFEST_HASH="$(_manifest)"
if [ "$CRITIC_WILL_RUN" = 1 ]; then   # 여기 도달 = ADK_MODE=1(CRITIC_CONFIGURED 는 resolve 0 일 때만 1).
  info "심의 Pass-A(원격 ADK 심의·별 세션): 도메인 $DOMAIN @ ${ADK_CRITIC_URL}"
  # 도메인별 룰셋 경로를 '$DOMAIN' 에 따라 동적으로 가리킨다(도메인-인지). ADK(원격)는 --ruleset 인자로 받아 내부에서 가이드 원문을 참조한다.
  DOM_RULESET_REL="$(domain_ruleset_abs "$DOMAIN")"   # 팩 룰셋 절대경로(packs/<도메인>/ruleset.json)
  # (2부 1단계) 룰셋 경로가 비어도 cosmetic 룰셋을 원격 심의에 조용히 전달하는 은닉 폴백 폐지 — 빈 값 유지(fail-closed).
  # M4(C4·외부리뷰 HIGH): Pass-A 도 '선택안만' 심의(거절 옵션 false-fail 차단). 다안 페이즈는 선택안 경로로 좁힌다.
  REVIEW_TARGET="$RDIR"
  case "$(jget "$SF" phase)" in
    00g-guideline) REVIEW_TARGET="$RDIR/00g-guideline/reference-notes.json" ;;   # 단안: 심의 대상=크롤 참조 노트만(룰엔진 kcia_engine 과 동일 범위 — example-analysis 의 원본 VOC 는 심의 대상 아님)
    01-brief)      REVIEW_TARGET="$RDIR/01-brief" ;;
    02-concept)    _s="$(jget "$RDIR/02-concept/decision.json" selected 2>/dev/null || true)"; [ -n "$_s" ] && REVIEW_TARGET="$RDIR/02-concept/options/$_s" ;;
    03-storyboard) case "$(storyboard_substage "$RID")" in
                     plan) REVIEW_TARGET="$RDIR/03-storyboard/plan" ;;
                     *)    _s="$(jget "$RDIR/03-storyboard/outline/decision.json" selected 2>/dev/null || true)"; [ -n "$_s" ] && REVIEW_TARGET="$RDIR/03-storyboard/outline/options/$_s" ;;
                   esac ;;
    04-keyvisual)  _s="$(jget "$RDIR/04-keyvisual/decision.json" selected 2>/dev/null || true)"; [ -n "$_s" ] && REVIEW_TARGET="$RDIR/04-keyvisual/options/$_s" ;;
  esac
  # 선택안 좁힘 fail-closed: REVIEW_TARGET 이 run 루트($RDIR)로 남았다 = 다안 페이즈인데 선택/결정이 미확정(decision 손상 등).
  #   adk-http(원격): 전체 run(이전 페이즈·거절안)이 외부 전송될 egress 위험(외부리뷰 5R HIGH). 선택안만 외부로 보낸다.
  #   단안 페이즈(01-brief=$RDIR/01-brief)·00g(=reference-notes.json)는 $RDIR 이 아니므로 영향 없음 — REVIEW_TARGET==$RDIR 은 '다안 미좁힘'에서만 발생.
  if [ "$REVIEW_TARGET" = "$RDIR" ]; then
    die "원격 심의(adk-http) 대상이 선택안으로 좁혀지지 않았습니다(선택/결정 미확정) — 전체 run 외부 전송 차단(fail-closed). select.sh 로 선택안을 확정한 뒤 다시 시도하세요."
  fi
  # 개선1(출력 캡처) + 개선2(watchdog): 크리틱 stdout/stderr 를 로그로 보존하고, 무한 행을 상한으로 끊는다.
  #   spawn_session.py(os.setsid)로 띄워 그룹 리더(pgid==pid)로 만들면 watchdog 의 kill_proc_tree(`kill -- -pid`)가 손자·재부모화까지 회수.
  PASSA_LOG="$(obs_logfile "$RID" "critic-passA")"
  _pa0="$(date +%s)"
  obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review-passA gen_source=critic outcome=start   # O-3 시작 레코드
  # adk-http: 원격 GCP 심의 — 인자로 선택안 경로·도메인·룰셋 전달(adk_critic.py 가 outbound allowlist·매핑·격리가드 수행).
  "$PY" "$HARNESS_ROOT/scripts/lib/spawn_session.py" "$PY" "$HARNESS_ROOT/scripts/lib/adk_critic.py" passa \
    --selected-artifact "$REVIEW_TARGET" --domain "$DOMAIN" --ruleset "$DOM_RULESET_REL" --phase "$(jget "$SF" phase)" --out "$PASSA" \
    >>"$PASSA_LOG" 2>&1 & _pa_pid=$!
  _pa_rc=0; obs_watch_pid "$_pa_pid" "$KCIA_CRITIC_TIMEOUT" "심의 Pass-A" || _pa_rc=$?   # || 가드: set -e 트립 방지(비0=타임아웃/실패)
  # (외부리뷰 HIGH) 유효 검토 산출물 판정: $PASSA 가 '전체 verdict.json 스키마'를 만족해야 한다(프롬프트가 그렇게 요구).
  #   rc=0 이어도 산출물이 없거나 스키마 무효면 'ok' 로 과대보고하지 않는다(critic_ran/review_depth 부풀림 + REQUIRED 우회 방지).
  #   얕은 'violations 가 list' 검사로는 깨진 violation 객체를 놓친다(외부리뷰 2R HIGH) → Validator 로 전체 검증.
  _passa_valid=0
  if [ -f "$PASSA" ]; then
    if "$PY" - "$PASSA" "$HARNESS_ROOT/harness/verdict.schema.json" <<'PYEOF' 2>/dev/null
import json, sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, Validator
d = load_json(sys.argv[1]); sch = load_json(sys.argv[2])
v = Validator(sch, sch); v.validate(d, sch)
sys.exit(0 if not v.errors else 1)
PYEOF
    then _passa_valid=1; fi
  fi
  if [ "$_pa_rc" = "124" ]; then
    CRITIC_OUTCOME="timeout"; err "심의 Pass-A 시간 초과(${KCIA_CRITIC_TIMEOUT}s) — 룰엔진 결과로 진행합니다. 로그: ${PASSA_LOG#"$HARNESS_ROOT"/}"
  elif [ "$_pa_rc" = "7" ]; then
    # adk_critic 종료코드 7 = '심의할 광고 카피 없음'(구조 스켈레톤, 예: 03-storyboard outline). ADK 실패가 아니라
    #   '리뷰 대상 없음' → 룰엔진-단독으로 정상 진행(benign skip). REQUIRED fail-closed 대상 아님(timeout/failed 만 해당).
    #   실 카피는 plan/keyvisual 단계에서 ADK 심의된다. CRITIC_RAN=0 유지 → review_depth=rule_engine_only(정직).
    CRITIC_OUTCOME="skipped"; info "심의 Pass-A: 선택안에 심의할 광고 카피가 없어 원격 ADK 생략 — 자동 규칙 점검만 진행합니다(구조 단계, 실제 표현은 다음 단계에서 점검)."
  elif [ "$_pa_rc" != 0 ]; then
    CRITIC_OUTCOME="failed"; err "심의 Pass-A 호출 실패 — 룰엔진 결과로 진행합니다. 마지막 출력: $(obs_tail "$PASSA_LOG" 5 | tr '\n' ' ')(전체: ${PASSA_LOG#"$HARNESS_ROOT"/})"
  elif [ "$_passa_valid" != 1 ]; then
    CRITIC_OUTCOME="failed"; err "심의 Pass-A 가 유효한 검토 결과를 내지 않았습니다(과대보고 방지) — 룰엔진 결과로 진행합니다. 전체: ${PASSA_LOG#"$HARNESS_ROOT"/}"
  else
    CRITIC_OUTCOME="ok"
  fi
  obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review-passA engine=critic gen_source=critic \
    outcome="$CRITIC_OUTCOME" rc="$_pa_rc" duration_s="$(( $(date +%s) - _pa0 ))"
  # CRITIC_RAN(engine 라벨·merge 입력)·스냅샷은 '유효한' $PASSA 일 때만 — 무효 산출물이 ruleset+subagent 라벨/critic 기여로 둔갑하지 않게.
  if [ "$_passa_valid" = 1 ]; then CRITIC_RAN=1; cp -f "$PASSA" "$PASSA_SNAP"; fi
  i=0; _pb_worst=""   # (외부리뷰 HIGH) Pass-B 최악 상태 집계(타임아웃>실패) → 전체 outcome 강등에 사용.
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    PBF="$PBDIR/$i.json"; rm -f "$PBF"
    # critic '성공 종료(exit 0)' + 결과 존재 시에만 그 결과를 scratch 로 스냅샷($PBSNAP/<i>.json).
    #   실패/무출력/타임아웃 → 스냅샷 없음 → merge(=scratch 만 읽음)가 그 후보를 default=refute(제외, 보수적).
    #   개선1(캡처)+개선2(watchdog): 건별 적대검증도 로그 보존 + 상한(무한 행 방지).
    PBLOG="$(obs_logfile "$RID" "critic-passB-$i")"
    _pb_t0="$(date +%s)"
    obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review-passB gen_source=critic outcome=start   # O-3 시작 레코드
    # adk-http: 원격 GCP 적대검증 — 후보 1건을 인자로 전달(adk_critic.py 가 {refuted,reason} 작성).
    "$PY" "$HARNESS_ROOT/scripts/lib/spawn_session.py" "$PY" "$HARNESS_ROOT/scripts/lib/adk_critic.py" passb \
      --candidate "$cand" --domain "$DOMAIN" --ruleset "$DOM_RULESET_REL" --out "$PBF" >>"$PBLOG" 2>&1 & _pb_pid=$!
    _pb_rc=0; obs_watch_pid "$_pb_pid" "$KCIA_CRITIC_TIMEOUT" "심의 Pass-B#$i" || _pb_rc=$?   # || 가드: set -e 트립 방지
    # (외부리뷰 2R HIGH) $PBF 유효성: 파싱가능 + boolean refuted(merge 계약). 무효면 'ok' 로 과대보고하지 않는다.
    _pbf_ok=0
    if [ -f "$PBF" ] && "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d.get("refuted"),bool) else 1)' "$PBF" 2>/dev/null; then _pbf_ok=1; fi
    _pb_oc=ok
    if [ "$_pb_rc" = "124" ]; then
      _pb_oc=timeout; _pb_worst=timeout
      err "심의 Pass-B#$i 시간 초과 — 이 후보는 기본 제외(보수적). 로그: ${PBLOG#"$HARNESS_ROOT"/}"
    elif [ "$_pb_rc" != 0 ] || [ "$_pbf_ok" != 1 ]; then
      # (외부리뷰 HIGH) Pass-B 실패/무출력/무효출력도 집계 → 후보가 조용히 빠졌는데 verdict 가 'ok/critic 포함'으로 과대보고되지 않게.
      _pb_oc=failed; [ "$_pb_worst" = "timeout" ] || _pb_worst=failed
      err "심의 Pass-B#$i 실패/무효 출력 — 이 후보는 기본 제외(보수적). 로그: ${PBLOG#"$HARNESS_ROOT"/}"
    else
      cp -f "$PBF" "$PBSNAP/$i.json"
    fi
    obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review-passB engine=critic gen_source=critic \
      outcome="$_pb_oc" rc="$_pb_rc" duration_s="$(( $(date +%s) - _pb_t0 ))"
    i=$((i + 1))
  done < <("$PY" "$MERGE" candidates "$BASE" "$PASSA_SNAP" "$CAP")
  [ "$i" -gt 0 ] && info "심의 Pass-B(건별 적대검증): 후보 $i 건(default=refuted, cap=$CAP)"
  # (외부리뷰 HIGH) Pass-B 에 실패/타임아웃이 있었으면 전체 크리틱 결과를 강등 — 후보가 default-refute 로 빠져 verdict 엔
  #   룰엔진 위반만 남으므로 review_depth=rule_engine_only 가 정확하고, REQUIRED 모드면 아래에서 fail-closed 된다.
  if [ -n "$_pb_worst" ] && [ "$CRITIC_OUTCOME" = "ok" ]; then CRITIC_OUTCOME="$_pb_worst"; fi
fi

# ── 머지 전 안전검증 (fail-closed) ──
#   (0) critic 이 '허용 출력($PASSA/$PBF) 외' 작업영역 파일(state.json·검사 산출물·다른 verdict·룰셋)을 변조했나?
[ "$CRITIC_WILL_RUN" != 1 ] || [ "$(_manifest)" = "$MANIFEST_HASH" ] || die "심의 critic 이 허용 출력 외 작업영역 파일을 변조했습니다 — 중단(fail-closed)."
#   (i) critic 은 $PASSA/$PBF 에만 쓰도록 지시받았다. $VP 가 존재하면 critic 이 verdict 를 직접 위조한 것 → 중단.
[ ! -f "$VP" ] || die "심의 critic 이 verdict_path 에 직접 썼습니다(이상/위조 시도) — 중단(fail-closed)."
#   (ii) baseline(불멸) 무결성: scratch baseline 이 변조됐으면(샌드박스 우회 등) 중단(조용한 pass 금지).
[ "$(sha256_hex "$BASE")" = "$BASE_HASH" ] || die "심의 baseline(scratch)이 변조되었습니다 — 중단(fail-closed)."
# 개선3(크리틱 강제 모드): 크리틱이 돌아야 했는데 실패/타임아웃이면 '조용한 강등' 대신 fail-closed(옵션, 기본 후방호환).
#   안전 체크(매니페스트·baseline·위조) '뒤'에 둔다(변조 탐지는 항상 수행). 기본(KCIA_CRITIC_REQUIRED 미설정)은 강등+가시화.
if [ "$CRITIC_WILL_RUN" = 1 ] && [ "${KCIA_CRITIC_REQUIRED:-0}" = "1" ] \
   && { [ "$CRITIC_OUTCOME" = "timeout" ] || [ "$CRITIC_OUTCOME" = "failed" ]; }; then
  die "심의 크리틱이 정상 완료되지 못했습니다(상태=$CRITIC_OUTCOME) — KCIA_CRITIC_REQUIRED=1 이라 중단(fail-closed). 크리틱 설정을 점검하거나, 강등 허용 시 KCIA_CRITIC_REQUIRED 를 해제하세요."
fi
# 개선3: 심의 깊이 — 크리틱이 정상 완료(ok)했을 때만 'rule_engine+critic', 그 외(미실행/실패/타임아웃)는 'rule_engine_only'.
REVIEW_DEPTH="rule_engine_only"; [ "$CRITIC_OUTCOME" = "ok" ] && REVIEW_DEPTH="rule_engine+critic"
# ── 병합: scratch(baseline ∪ Pass-A 후보 중 refute 안 된 것) → $VP 에 '단 한 번' 완성 상태(id 보유)로 원자적 작성. ──
#   $VP 는 여기서 처음 출현. 병합 실패 → $VP 미작성 → 재심의(fail-open 불가). baseline high/실증 불멸.
# MERGE_CRITIC 비어있지 않으면 merge 가 engine=ruleset+subagent 로 라벨. 심의 = 원격 ADK 단일이므로 critic 이
#   돌았으면 'adk-http' 를 라벨로 넘긴다(M3·RM2: provenance 가 critic 미실행으로 둔갑 않게).
MERGE_CRITIC=""; CRITIC_ENGINE_LABEL=""
if [ "$CRITIC_RAN" = "1" ]; then MERGE_CRITIC="adk-http"; CRITIC_ENGINE_LABEL="adk-http"; fi
# 개선3: critic_outcome·review_depth 를 verdict 에 기록(사후 감사 — '룰엔진만 통과'를 잡는다). critic_engine(M4) 은 additive(라벨 비면 미기록 → 골든 불변).
"$PY" "$MERGE" merge "$VP" "$BASE" "$PASSA_SNAP" "$PBSNAP" "$MERGE_CRITIC" "$CAP" "$CRITIC_OUTCOME" "$REVIEW_DEPTH" "$CRITIC_ENGINE_LABEL" || die "심의 병합 실패 — 중단(fail-closed)."
rm -f "$PASSA"; rm -rf "$PBDIR" "$SCRATCH"
validate_artifact "$VP" >/dev/null
MERGE_OK=1   # $VP 완성·검증 완료 → trap 이 $VP 보존(이 표지 없이 죽으면 trap 이 $VP 삭제 → 재실행 재심의)
VERD="$(jget "$VP" verdict)"; NVIO="$("$PY" "$LIB" jget "$VP" violations | "$PY" -c 'import sys,json;print(len(json.load(sys.stdin)))')"
# '심의 완료' 마커는 보존(회귀 테스트 의존) + 결과는 평이어로(verdict=/violations= 잭곤 제거).
if [ "$VERD" = "pass" ]; then
  ok "심의 완료 — 규정 점검 통과 (걸린 부분 ${NVIO}개)"
else
  ok "심의 완료 — 규정 점검을 통과하지 못했어요 (걸린 부분 ${NVIO}개) · 표현을 고쳐 다시 만들어요"
fi
# 개선0(측정): 심의 전체 소요 기록.
obs_timing "$RID" phase="$(jget "$SF" phase)" stage="$_STAGE_NOW" step=review engine="$ENGINE_NAME" gen_source=review \
  outcome="$([ "$VERD" = "pass" ] && echo ok || echo fail)" rc=0 watch_ready=true duration_s="$(( $(date +%s) - _REV_T0 ))"
# L-1: 실행 기록(심의 시점) — 해석된 심의 엔진으로 기록(외부리뷰 P3). CRITIC_ENGINE_LABEL=adk-http(원격 ADK 심의) 또는
#   비어있으면 rule_engine_only(룰엔진 단독) → ADK 심의가 룰단독/레거시 subagent 라벨과 감사 로그에서 구분된다. .logs 골든제외·best-effort.
obs_provenance "$RID" review "${CRITIC_ENGINE_LABEL:-$REVIEW_DEPTH}"
# 개선3(강등 가시화): 크리틱이 돌아야 했는데 정상 완료 못 했으면 사람에게 평이어로 알린다(룰엔진만 통과 — 사람 검토 권장).
if [ "$CRITIC_WILL_RUN" = "1" ] && [ "$CRITIC_OUTCOME" != "ok" ]; then
  info "심의가 일부만 돌았어요 — 자동 점검(룰엔진)만 됐고, 사람 검토를 권장합니다. (크리틱 상태: $CRITIC_OUTCOME)"
fi

# 위조 방지(외부리뷰 5R CRITICAL): kcia-check 가 '이 verdict(id)를 실제 생산했다'는 증거를 state.history 에 남긴다(scripts 전용 쓰기).
#   재개(크래시 복구) idempotent-skip 은 이 마커로만 정당화 — 외부가 미리 심은 위조 verdict 는 마커가 없어 재심의된다.
append_history "$SF" "$(jget "$SF" phase)" "review:produced:${_STAGE_NOW}:$(jget "$VP" id 2>/dev/null || true)" "kcia-check.sh"
agui_emit "$RID"   # AG-UI 투영: 심의 결과 Custom(kcia.verdict, verdict/engine/violations 요약) + StateDelta
_write_review_binding "$RID" "$_STAGE_NOW" "$(jget "$VP" id 2>/dev/null || true)"   # P0: 리뷰된 산출물 해시 사이드카(재개-스킵이 수정본을 놓치지 않게 — 이 verdict 를 그 시점 리뷰 내용에 묶는다)
bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" review
lock_release
