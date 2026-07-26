#!/usr/bin/env bash
# run-stage.sh — ★ 단계 실행기 (1급 경로, 슬래시 비의존). 설계 §11.2.
#   엔진 선택: HARNESS_CLI=claude|stub  (기본 stub: 결정적 CI/오프라인)
#   HARNESS_OFFLINE=1 이면 claude 선택이어도 stub 생성기로 폴백(엔진명은 보존).
#   재개: 산출물 파일 존재 + validate 통과 = 완료 → 재생성 생략(idempotent).
# 사용법: bash scripts/run-stage.sh <stage> <run_id>
#   stage: brief | concept | storyboard-outline | storyboard-plan | keyvisual | evidence | raise-limit
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

STAGE="${1:-}"; RID="${2:-}"
[ -n "$STAGE" ] || die "stage 가 필요합니다 (brief|concept|storyboard-outline|storyboard-plan|keyvisual|evidence)."
require_run "$RID"
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 stage(emit-context·raise-limit 포함)든 fail-closed

# ── WS-2: 읽기전용 컨텍스트 방출 (in-session 스킬 본문이 정확한 입력·프롬프트 경로를 재유도 없이 받는다) ──
#   state.json 을 쓰지 않는다(락 없음). build_context 는 subprocess 가 LLM 에 주는 것과 '동일' → 두 모드 간 입력 드리프트 차단.
if [ "${3:-}" = "--emit-context" ]; then
  RDIR="$(run_dir "$RID")"
  printf '# === in-session 생성 컨텍스트 (stage=%s) ===\n' "$STAGE"
  printf 'RUN_ID=%s\n' "$RID"
  printf 'RUN_DIR=%s\n' "$RDIR"
  printf 'PROMPT_FILE=%s/prompts/%s.md   # 생성 지침·Outputs·스키마(SSoT) — 반드시 먼저 읽어라\n' "$HARNESS_ROOT" "$STAGE"
  build_context "$RID" "$STAGE"
  # 00g 가이드라인: 세션 내 에이전트가 한 건씩 순회할 동일 도메인 사례 폴더 방출(단일 출처 헬퍼 — 본 디스패치와 동일 목록).
  #   run_llm 프롬프트(EXAMPLE_DIRS=${EXDIRS[*]})와 동일 포맷으로 한 줄 방출 → 두 모드 입력 드리프트 차단(15행 사상).
  if [ "$STAGE" = "guideline" ]; then
    _eds=(); while IFS= read -r _ed; do [ -n "$_ed" ] && _eds+=("$_ed"); done < <(guideline_example_dirs "$RID")
    printf 'EXAMPLE_DIRS=%s\n' "${_eds[*]}"
  fi
  # 00e evidence: 세션 내 에이전트가 읽을 첨부 참조 문서 원본 위치 + 반영 스펙 미정(spec_status=pending) 문서 목록 방출.
  #   guideline 의 EXAMPLE_DIRS 와 동일 사상(run_llm 이 보는 것과 동일 입력 경계 → 두 모드 드리프트 차단).
  if [ "$STAGE" = "evidence" ]; then
    printf 'EVIDENCE_DIR=%s/inputs/evidence   # 첨부된 참조 문서 원본 — 이 폴더의 모든 파일을 직접 읽어라\n' "$RDIR"
    printf 'PENDING_DOCS (반영 스펙 미정 — 이 문서들에 대해서만 제안을 작성):\n'
    "$PY" - "$RDIR/00-ingest/evidence-documents.json" <<'PYEOF' 2>/dev/null || true
import sys, json
try:
    m = json.load(open(sys.argv[1]))
    for d in (m.get("documents") or []):
        if isinstance(d, dict) and d.get("spec_status") == "pending":
            print("- %s  %s" % (d.get("id"), d.get("filename")))
except Exception:
    pass
PYEOF
  fi
  # 00a intake: 세션 내 에이전트가 읽을 첨부 스냅샷 위치 + 사람 선언 유형(제품/도메인/포맷) 방출.
  if [ "$STAGE" = "intake" ]; then
    _ISF="$(state_file "$RID")"
    printf 'ATTACHMENTS_DIR=%s/inputs/attachments   # 스냅샷된 첨부 원본 — 이 폴더의 파일을 직접 읽어 분류하라(_unpacked/=zip 해체본)\n' "$RDIR"
    printf 'PRODUCT_NAME_DECLARED=%s   # 사람 선언 제품명(자사/타사 크롤 구분 대조 기준)\n' "$(jget "$_ISF" product.name 2>/dev/null || true)"
    printf 'DECLARED_DOMAIN=%s · DECLARED_FORMAT=%s   # 사람 선언(도메인=심의, 포맷=구조; AGENTS 8절)\n' \
      "$(jget "$_ISF" product.regulatory_domain 2>/dev/null || true)" "$(jget "$_ISF" product.deliverable_format 2>/dev/null || true)"
  fi
  printf '# --- 필수 산출물(이 단계 완료 조건; validate-stage 가 강제) ---\n'
  case "$STAGE" in
    intake)     printf 'OUT: 00a-intake/intake-proposal.json (harness/intake-proposal.schema.json — 첨부별 category/route/kind·reflect_preview·confidence·actions + aggregate_preview)\n' ;;
    brief)      printf 'OUT: 01-brief/brief.json (harness/brief.schema.json) + 사람용 01-brief/brief.md\n' ;;
    guideline)  printf 'OUT: 00g-guideline/examples/<id>/example-analysis.json + 00g-guideline/reference-notes.json (크롤 참조 노트 — 자유텍스트)\n' ;;
    evidence)   printf 'OUT: 00e-evidence/reflection-proposal.json (harness/reflection-proposal.schema.json — pending 문서별 kind 추정 + 원문 발췌 반영 포인트)\n' ;;
    concept)
      printf 'OUT: 02-concept/concept-axes.json(먼저) → 각 축마다 options/<axis-id>/{rtb.json,key-message.json}(독립 생성) → recommendation.json(ranked=실재 축 id)\n'
      [ -f "$RDIR/02-concept/concept-axes.json" ] && printf '#   정의된 축: %s\n' "$("$PY" -c "import json;print(' '.join(a['id'] for a in json.load(open('$RDIR/02-concept/concept-axes.json'))['axes']))" 2>/dev/null || true)" ;;
    storyboard-outline) printf 'OUT: 03-storyboard/sources/results.json + outline/options/{A,B,C}/storyline.json (최소 3안) + outline/recommendation.json (ranked 3개 이상)\n' ;;
    storyboard-plan)    printf 'OUT: 03-storyboard/art-direction.json (전역 아트디렉션 — 먼저; master_palette·color_temp·lighting·typography·master_reference) + 03-storyboard/plan/NN-<type>.json (선택 스토리라인의 모든 블록; visual.concept 가 아트디렉션 상속, 블록 palette ⊆ master_palette)\n' ;;
    keyvisual)          printf 'OUT: 04-keyvisual/options/{A,B,C}/index.html (최소 3안 — 서로 구별되는 디자인) + 04-keyvisual/recommendation.json (ranked 3개 이상) (HTML 만 작성; design-manifest·섹션PNG·canon-coverage 는 전이 단계의 Playwright 렌더가 생성)\n' ;;
  esac
  printf '# --- 위 산출물을 RUN_DIR 하위에 직접 작성한다(state.json 금지). 작성 후:\n'
  printf '#     HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh %s %s  (검증·전이는 스크립트가 한다)\n' "$STAGE" "$RID"
  exit 0
fi

# raise-limit: 에스컬레이션 시 상한 상향
if [ "$STAGE" = "raise-limit" ]; then
  lock_acquire "$RID"; SF="$(state_file "$RID")"
  # 가드: escalated 상태에서만 상한 상향 허용(임의 페이즈/상태 변조 차단, 외부리뷰 B7#5)
  if [ "$(jget "$SF" status)" != "escalated" ]; then
    die "raise-limit 은 escalated(사람 개입 필요) 상태에서만 사용합니다. 현재 상태=$(jget "$SF" status)."
  fi
  cur="$(jget "$SF" max_iterations)"; new=$((cur + 2))
  # escalated 해제 후 재생성 단계로 복귀 — 한 번의 원자적 쓰기(공용 transition: field 병합 + history 1건), 유효 enum 만 사용.
  transition max_iterations="$new" step='"generate"' gate=null status='"revise"' awaiting='"none"' \
             "@history=$(jget "$SF" phase)|limit:raised:${new}→generate|run-stage.sh"
  agui_emit "$RID"   # AG-UI 투영: 한도 상향 해소 → 재생성 시작(StepStarted) + StateDelta
  bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
  unset HARNESS_LOCK_HELD; ok "max_iterations 상향: $cur → $new (escalated 해제, 재생성 단계로)"; exit 0
fi

# HARNESS_CLI 기본값은 환경에 따른다(개편계획 ③): 오프라인(CI/골든)=stub, 온라인(운영)=claude.
#   stub 생성은 결정성용이므로 CI(HARNESS_OFFLINE=1) 전용 — 운영에서 stub 가 새면 실엔진 강제 정책이 무너진다.
if [ "${HARNESS_OFFLINE:-0}" = "1" ]; then
  CLI="${HARNESS_CLI:-stub}"
else
  CLI="${HARNESS_CLI:-claude}"
fi
case "$CLI" in claude|stub) ;; *) die "HARNESS_CLI 는 claude|stub 중 하나여야 합니다 (현재: $CLI)";; esac
# 비오프라인(운영/온라인)에서 stub 생성은 금지(③ stub=CI 전용). 명시 HARNESS_CLI=stub 도 여기서 막힌다.
if [ "${HARNESS_OFFLINE:-0}" != "1" ] && [ "$CLI" = "stub" ]; then
  die "stub 생성은 CI(HARNESS_OFFLINE=1) 전용입니다. 운영은 HARNESS_CLI=claude(insession) 를 쓰세요."
fi

lock_acquire "$RID"
SF="$(state_file "$RID")"
RDIR="$(run_dir "$RID")"

# 생성기(stub)에 도메인/제품명을 env 로 주입 — stub 은 state.json 을 직접 읽지 않는다(쓰기주체 단일화 가드와 정합).
#   stub 은 이 값으로 도메인 분기·제품명/브랜드 파생(하드코딩 브랜드/제품명 제거)을 수행한다.
HARNESS_DOMAIN="$(resolve_domain "$SF")"; export HARNESS_DOMAIN   # 누수아닌 DRY: 산재 폴백 일원화(common.sh resolve_domain)
HARNESS_FORMAT="$(jget "$SF" product.deliverable_format 2>/dev/null || true)"; [ -n "$HARNESS_FORMAT" ] || HARNESS_FORMAT="multipage_bm"; export HARNESS_FORMAT
HARNESS_PRODUCT_NAME="$(jget "$SF" product.name 2>/dev/null || true)"; export HARNESS_PRODUCT_NAME

# 단계가 현재 페이즈와 일치하는지 확인(생성은 해당 페이즈에서만)
# H-3 fail-safe(K-2 #7 후속, 외부리뷰 Low): 페이즈맵(committed harness 파일)이 부재/손상이면 stage_phase 가
#   빈값을 내고 아래 [-n] 가드가 조용히 skip 돼 잘못된 stage 명령이 페이즈 가드를 우회한다(옛 하드코딩 맵엔
#   없던 fail-open) → 여기 메인 셸에서 fail-closed(서브셸 die 는 전파 안 되므로 여기서 막는다).
"$PY" -c 'import json,sys; json.load(open(sys.argv[1]))["phase_to_stage"]' "$STAGE_PHASE_MAP" 2>/dev/null \
  || die "페이즈 맵($STAGE_PHASE_MAP)이 없거나 손상됐습니다 — 페이즈 가드 우회 방지(fail-closed). harness/stage-phase-map.json 을 확인하세요."
EXP_PHASE="$(stage_phase "$STAGE")"
CUR_PHASE="$(jget "$SF" phase)"
if [ -n "$EXP_PHASE" ] && [ "$EXP_PHASE" != "$CUR_PHASE" ]; then
  die "지금 단계는 '$STAGE'(=$EXP_PHASE) 가 아닙니다. 현재 페이즈=$CUR_PHASE. run.md 의 '다음 명령'을 확인하세요."
fi
# 포맷-특화 단계(키비주얼)인데 산출물 포맷이 미완성(status!=active)이면 깨진 산출 대신 친절히 중단.
if [ "$STAGE" = "keyvisual" ]; then
  FMT_NOW="$(jget "$SF" product.deliverable_format 2>/dev/null || true)"
  if [ -n "$FMT_NOW" ]; then
    FMT_STATUS="$(jget "$FORMATS_DIR/format-profiles.json" "formats.$FMT_NOW.status" 2>/dev/null || true)"
    [ -z "$FMT_STATUS" ] || [ "$FMT_STATUS" = "active" ] || \
      die "산출물 포맷 '$FMT_NOW' 의 status 가 active 가 아닙니다(format-profiles.json 의 formats.$FMT_NOW.status). 해당 포맷을 active 로 전환 후 진행하세요."
  fi
fi
# 레거시 마이그레이션(외부리뷰 P1 H3): 00g 가 단안(승인)으로 전환되기 전 생성된 런이 select 게이트에 갇혀(step=select) 있으면,
#   guideline 재생성으로 복구할 수 있도록 step=generate 로 정규화한다 — 끝의 전이 python 이 step==generate 에서만 발동하므로
#   이 정규화 없이는 재생성해도 gate=select 에 갇혀 dead-end 루프가 된다. 신규 00g 는 select 에 도달하지 않으므로 무해(STAGE=guideline 한정).
if [ "$STAGE" = "guideline" ] && [ "$(jget "$SF" gate)" = "select" ]; then
  # phase==00g-guideline 은 위 stage_phase 검증(EXP_PHASE==CUR_PHASE)으로 이미 보장됨 → 공용 transition(단일 원자 쓰기).
  transition step='"generate"' gate=null status='"revise"' awaiting='"none"' \
             "@history=$(jget "$SF" phase)|migrate:00g-select→generate(단안전환 복구)|run-stage.sh"
fi
# 생성 단계 가드(외부리뷰 2차 B): 사람-액션 게이트(select/user) 중에는 생성 금지(위 00g 레거시 정규화 후엔 gate≠select).
CUR_GATE_RS="$(jget "$SF" gate)"
case "$CUR_GATE_RS" in
  select) die "지금은 만들 차례가 아니라 고를 차례예요. bash scripts/select.sh $RID <옵션> 을 실행하세요." ;;
  user)   die "지금은 만들 차례가 아니라 승인할 차례예요. bash scripts/approve.sh $RID (고칠 게 있으면 revise.sh) 를 실행하세요." ;;
esac
# 03-storyboard 서브스테이지 가드 (M3: outline→plan 2-cycle 순서 강제)
SUB="$(storyboard_substage "$RID")"
if [ "$STAGE" = "storyboard-outline" ] && [ "$SUB" != "outline" ]; then
  die "아웃라인(스토리라인)은 이미 확정되었습니다. 다음: bash scripts/run-stage.sh storyboard-plan $RID"
fi
if [ "$STAGE" = "storyboard-plan" ] && [ "$SUB" != "plan" ]; then
  die "기획안 전에 스토리라인을 먼저 선택해야 합니다. (현재 단계=$SUB)"
fi

# stage → 1차 산출물 경로 / 다안 여부
primary=""; multi=0
case "$STAGE" in
  intake)             primary="00a-intake/intake-proposal.json"; multi=0 ;;  # 첨부 자료 보편 분류 제안 → 승인 (review-exempt, 라우팅 결정 입력)
  guideline)          primary="00g-guideline/reference-notes.json"; multi=0 ;;  # 크롤 참조 노트(자유텍스트) → 승인 (구 3안 select 파기)
  evidence)           primary="00e-evidence/reflection-proposal.json"; multi=0 ;;  # 반영 제안 초안(pending 참조 문서) → 승인 (review-exempt)
  brief)              primary="01-brief/brief.json"; multi=0 ;;
  concept)            primary="02-concept/recommendation.json"; multi=1 ;;  # 마지막 산출물=완료표지(부분생성 재개)
  storyboard-outline) primary="03-storyboard/outline/recommendation.json"; multi=1 ;;
  storyboard-plan)    # M7: 1차 산출물 = 선택 스토리라인의 '첫 블록' 파일(포맷별 — multipage/one_pager=01-hero).
                      #   하드코딩 01-hero 제거(hero 비선두 포맷 die 차단). multipage 는 항상 hero 선두 → 01-hero(불변).
                      primary="$("$PY" -c 'import json,os,sys
b=os.path.join(sys.argv[1],"03-storyboard","outline")
d=os.path.join(b,"decision.json"); sel=json.load(open(d))["selected"] if os.path.exists(d) else "A"
sl=os.path.join(b,"options",sel,"storyline.json")
bl=json.load(open(sl))["blocks"] if os.path.exists(sl) else []
print("03-storyboard/plan/%02d-%s.json"%(bl[0]["order"],bl[0]["type"]) if bl else "03-storyboard/plan/01-hero.json")' "$(run_dir "$RID")" 2>/dev/null || echo "03-storyboard/plan/01-hero.json")"
                      multi=0 ;;
  keyvisual)          primary="04-keyvisual/options/A/index.html"; multi=1 ;;
  *) die "알 수 없는 stage: $STAGE" ;;
esac

# 재개 판정: 산출물 존재 + 검증 통과 + 현재 revise 루프가 아님 → 생략.
#   concept/storyboard-plan 은 '항목 단위'로 생성·재개하므로 단일 primary 단락 평가를 건너뛰고
#   각 브랜치가 항목별 idempotent skip 을 수행한다(부분 생성 중단→재개 안전, 외부리뷰 B4 #7).
cur_status="$(jget "$SF" status)"
# primary 산출물 존재+유효: JSON 은 schema 검증, 비-JSON(html 등)은 존재로 충분(외부리뷰 4차: HTML 에 JSON validate 쓰던 버그).
primary_ok() {
  [ -f "$RDIR/$primary" ] || return 1
  case "$primary" in *.json) validate_artifact "$RDIR/$primary" >/dev/null 2>&1 || return 1 ;; esac
  # keyvisual 은 렌더 산출물(design-manifest.json)까지 유효해야 '완료'(partial 렌더 후 skip→manifest 없이 전이 차단, 외부리뷰 5차).
  if [ "$STAGE" = "keyvisual" ]; then
    { [ -f "$RDIR/04-keyvisual/design-manifest.json" ] && validate_artifact "$RDIR/04-keyvisual/design-manifest.json" >/dev/null 2>&1; } || return 1
  fi
  # intake 완료조건 = 00a '전체 검증'(스키마+시맨틱: WB 분류·변환본·category/kind 일관성·sha256·1:1) 통과. ★ 외부리뷰 W4-R7:
  #   스키마만 보면 시맨틱 실패 제안(WB 행 없음·category/kind 불일치 등)을 '완료'로 오인해 재생성을 skip → validate 가 반복
  #   실패하는 wedge 가 된다. validate-stage 를 완료조건으로 삼아 이 부류(개별 체크별 skip 불일치)를 통째로 닫는다.
  if [ "$STAGE" = "intake" ]; then
    bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" 00a-intake >/dev/null 2>&1 || return 1
  fi
  return 0
}
# in-session 1차 산출물(에이전트가 '먼저 쓴' 것) 존재 확인 — 렌더 후처리(design-manifest)는 제외한다(PR2-E).
#   keyvisual 은 에이전트가 HTML(A/B)+recommendation 만 쓰고, design-manifest·섹션PNG·coverage 는 전이 단계의 렌더가 만든다 →
#   여기서 manifest 를 요구하면 세션 내 keyvisual 이 영원히 die. 그 외 단계는 완료기준(primary_ok)과 동일(에이전트 산출물=완료 산출물).
insession_primary_ok() {
  if [ "$STAGE" = "keyvisual" ]; then
    # 이슈3a: 키비주얼은 최소 3안(A·B·C) HTML — 세션 내 에이전트가 3안을 먼저 써야 전이(완전성은 validate-stage 가 재강제).
    [ -f "$RDIR/04-keyvisual/options/A/index.html" ] && [ -f "$RDIR/04-keyvisual/options/B/index.html" ] \
      && [ -f "$RDIR/04-keyvisual/options/C/index.html" ] \
      && [ -f "$RDIR/04-keyvisual/recommendation.json" ] \
      && validate_artifact "$RDIR/04-keyvisual/recommendation.json" >/dev/null 2>&1
  else
    primary_ok
  fi
}
if [ "$STAGE" != "concept" ] && [ "$STAGE" != "storyboard-plan" ] \
   && [ "$cur_status" != "revise" ] && [ "$cur_status" != "changes_requested" ] && primary_ok; then
  info "[$STAGE] 이미 완료·검증된 산출물 존재 — 재생성 생략(idempotent)."
  NEED_GENERATE=0
fi
# review 게이트 재진입(idempotent): primary 가 유효하면 stage 종류 무관하게 재생성 없이 전이만(verdict 보존, 외부리뷰 3·4차).
#   concept/tone/plan/keyvisual 모두 review 재진입은 no-op 이어야 한다.
if [ "${NEED_GENERATE:-1}" != "0" ] && [ "$CUR_GATE_RS" = "review" ] && [ "$cur_status" = "pending" ] && primary_ok; then
  info "[$STAGE] review 게이트 재진입 — 재생성 생략(idempotent, verdict 보존)."
  NEED_GENERATE=0
fi
NEED_GENERATE="${NEED_GENERATE:-1}"

# loop guard: revise 재생성인데 iteration > max → escalated
iter="$(jget "$SF" iteration)"; maxit="$(jget "$SF" max_iterations)"
if { [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; } && [ "$iter" -gt "$maxit" ]; then
  jset "$SF" status '"escalated"' >/dev/null
  jset "$SF" awaiting '"user"' >/dev/null
  append_history "$SF" "$(jget "$SF" phase)" "loop-guard:escalated:$iter/$maxit" "run-stage.sh"
  # AG-UI 투영: 에스컬레이션(status=escalated)을 exit 前에 방출 — compute_interrupt 가 raise-limit 개입으로
  #   합성한다. 이 emit 이 없으면 raise-limit 실행 시엔 이미 escalated 를 벗어나 raise-limit 개입이 영영 안 나온다(HIGH-2).
  agui_emit "$RID"
  bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
  die "여러 번 고쳤지만 규정 점검을 통과하지 못해 멈췄어요 → 사람 개입 필요. run.md 의 ⚠ 주의를 확인하세요."
fi

PROMPT_FILE="$HARNESS_ROOT/prompts/$STAGE.md"
ENGINE_LABEL="$CLI"
GEN_SOURCE="subprocess"   # 생성 표면: subprocess(헤드리스 run_llm) | insession(세션 내 직접). 기본 subprocess.
_GEN_T0="$(date +%s)"     # 개선0(측정): 생성 시작 시각 — 끝에서 소요시간 기록.

# ── 엔진 디스패치 (재생성이 필요할 때만; 재개 시 생성 생략하고 전이만 보정) ──
if [ "$NEED_GENERATE" = "0" ]; then
  info "[$STAGE] 재개: 생성 생략, 게이트 전이만 보정."
else
  # 재생성(특히 revise) 시 직전 verdict 를 폐기 → 산출물이 바뀌었으므로 stale verdict 재사용 금지.
  VP_STALE="$(verdict_path "$RID")"
  [ -n "$VP_STALE" ] && rm -f "$VP_STALE" 2>/dev/null || true
  # O-3(진행 신호): 생성 시작 레코드 — insession/subprocess 생성이 도는 동안 무이벤트로 '정체' 오인 방지. duration 없음 = in-flight.
  obs_timing "$RID" phase="$CUR_PHASE" stage="$STAGE" step=generate engine="$ENGINE_LABEL" outcome=start
fi
STUB_MODE=0
{ [ "$CLI" = "stub" ] || [ "${HARNESS_OFFLINE:-0}" = "1" ]; } && STUB_MODE=1
# 이미지 직전 점검 override: 비대화형 플래그(파일-게이트 결정론 유지 — 대화형 입력 없음). env HARNESS_ACK_GAPS=1 과 동치.
PROCEED_WITH_GAPS=0
case " $* " in *" --proceed-with-gaps "*) PROCEED_WITH_GAPS=1 ;; esac

# ── GEN_MODE: in-session(세션 내 직접 생성) vs subprocess(헤드리스 run_llm). ──
#   제어흐름 역전(docs/_archive/in-session-generation-proposal.md §2): in-session 은 run_llm 을 절대 호출하지 않고,
#   '세션 안 에이전트가 이미 쓴 산출물'을 검증·전이만 한다(셸=자식).
#   기본값 자동선택(in-session 전환 — 단계 A): HARNESS_GEN_MODE 미지정 시,
#     STUB_MODE 가 아니고(=실엔진 claude + 온라인) Claude Code 세션이 신뢰 마커로 감지되면 insession,
#     아니면(세션밖·cron·CI) subprocess 로 폴백. → 인터랙티브 세션에서 헤드리스 600초 행/0바이트 재발 차단.
#   ★ STUB_MODE(=HARNESS_CLI=stub 또는 HARNESS_OFFLINE=1)는 '항상' subprocess+stub 으로 남겨 CI/골든 결정성을
#     불변으로 지킨다(안전 불변식 §7 / 설계원칙 #2). 계획 단계 A 의 'stub 무영향'은 이 STUB_MODE 게이트로 충족한다
#     — 실엔진(claude) 미선언 stub 기본 호출(테스트·오프라인)이 우발적으로 insession 으로 새지 않게(헤드리스는 명시 opt-in).
if [ -n "${HARNESS_GEN_MODE:-}" ]; then
  GEN_MODE="$HARNESS_GEN_MODE"
elif [ "$STUB_MODE" != "1" ] && [ -n "$(detect_insession_engine 2>/dev/null || true)" ]; then
  # 실엔진(claude) + Claude 세션 마커 + 온라인 → 세션 내 직접 생성. keyvisual 도 포함(PR2-E: 렌더를 전이 단계로 분리해 세션 내 지원).
  GEN_MODE="insession"
else
  GEN_MODE="subprocess"
fi
case "$GEN_MODE" in subprocess|insession) ;; *) die "HARNESS_GEN_MODE 는 subprocess|insession 이어야 합니다 (현재: $GEN_MODE)";; esac
# 명시 HARNESS_GEN_MODE=insession 라도 STUB_MODE(=HARNESS_CLI=stub 또는 HARNESS_OFFLINE=1)면 subprocess 로 강제한다.
#   결정적 stub 경로가 insession 으로 우회되어(세션 안 산출물 없이) stub 으로 덮이거나 비결정적이 되지 않게 — CI/골든 결정성 불변(외부리뷰 PR1 R2 HIGH).
#   세션 내 SKILL 은 transition 명령에 HARNESS_CLI=claude 를 명시한다(STUB_MODE=0 → insession 보존). offline 은 STUB_MODE 에 이미 포함.
[ "$STUB_MODE" = "1" ] && GEN_MODE="subprocess"
# ②b: 헤드리스 subprocess 실엔진 생성(run_llm 의 claude -p)은 제거됐다(개편계획 ②b③).
#   도달 가능한 모드는 insession(실엔진, 세션 내 직접 생성) 또는 subprocess+STUB_MODE(CI/오프라인 stub)뿐이다.
#   실엔진(STUB_MODE!=1)인데 subprocess 로 귀결되면(세션 밖·insession 미감지) fail-closed — run_llm 실엔진 경로 차단.
#   ★ 단 NEED_GENERATE=0(재개: 산출물 이미 존재·검증 통과, 생성할 것 없음)이면 발동하지 않는다 —
#     크래시 후 idempotent 재개(파일 작성↔전이 사이)는 세션/엔진 무관하게 전이만 보정해야 한다(외부리뷰 P2).
if [ "$GEN_MODE" = "subprocess" ] && [ "$STUB_MODE" != "1" ] && [ "${NEED_GENERATE:-1}" != "0" ]; then
  die "세션 밖 실엔진 생성은 제거되었습니다(헤드리스 subprocess 금지). 세션 안(insession) 생성 또는 CI(HARNESS_OFFLINE=1, stub)만 허용됩니다."
fi
if [ "$GEN_MODE" = "insession" ]; then
  # PR2-E: 키비주얼도 세션 내 지원 — 에이전트는 HTML 만 쓰고, 렌더(Playwright 캡처+manifest+lint)는 아래 전이 단계가 돌린다(생성과 분리).
  # ⓪ in-session 생성은 'generate' 단계에서만 — review 재진입 등 step!=generate 에서는 fail-closed(외부리뷰 CRITICAL #1).
  #    step!=generate 에서 재실행하면 전이 python 이 no-op 라 generate:insession 이벤트가 안 남고, 직전 stub/구토큰이
  #    살아 kcia 자가심의 가드가 무력화된다(stub 생성 → review → insession 재진입 → claude critic 통과 우회).
  CUR_STEP_RS="$(jget "$SF" step)"
  [ "$CUR_STEP_RS" = "generate" ] || die "in-session 생성은 'generate' 단계에서만 가능합니다(현재 step=$CUR_STEP_RS). 이미 심의/이후 단계라면 run.md 의 '다음 명령'을 따르세요."
  # ① 신뢰 CLI 마커로 생성 엔진 감지(미상 → fail-closed). 가드(kcia-check)의 생명줄.
  ENGINE_LABEL="$(detect_insession_engine || true)"
  [ -n "$ENGINE_LABEL" ] || die "in-session 생성 엔진을 신뢰 마커로 확인할 수 없습니다(fail-closed). Claude Code 세션 안에서 실행하세요 — 세션 밖 헤드리스 실엔진 생성은 폐기됐고, CI/오프라인은 HARNESS_OFFLINE=1(stub)만 허용됩니다."
  # ② 세션 안 에이전트가 산출물을 '먼저' 썼어야 한다 — 없으면 run_llm 으로 떨어지지 않고 친절히 중단(중첩 생성 금지).
  #    완전성(fan-out 전체)은 아래 validate-stage.sh 가 강제하므로 여기선 1차 산출물 존재·유효만 빠르게 확인.
  insession_primary_ok || die "in-session 모드: 1차 산출물('$primary')이 없거나 무효입니다. 세션 안 에이전트가 먼저 산출물(+fan-out 전체)을 작성한 뒤 이 명령을 실행하세요(키비주얼은 design-manifest 제외 — 렌더는 전이 단계가 한다)."
  # ③ 신선 산출물 → 직전 verdict 폐기(stale pass 가 review 로 생존 방지; 재생성 경로와 동일 사상).
  VP_STALE="$(verdict_path "$RID")"; [ -n "$VP_STALE" ] && rm -f "$VP_STALE" 2>/dev/null || true
  NEED_GENERATE=0; GEN_SOURCE="insession"   # run_llm 전부 skip(아래 디스패치 no-op), 전이 이벤트=generate:insession:<stage>:<engine>
fi

# ── P0-①(생성 이미지 선행): 키비주얼은 HTML 생성 '전'에 블록별 이미지를 만들어 둔다 ──
#   plan 의 visual.concept → 04-keyvisual/generated/NN-type.{svg,png}. 키비주얼 HTML(stub·실LLM·세션내 동일)이
#   이 자사 생성물을 블록 <img> 로 참조(없으면 자사컷→도형박스). 엔진=resolve_image_engine(삼중가드: 키 없음/오프라인/CI 는 결정적 stub SVG → 골든 불변).
#   ★ image_engine.py 를 '직접' 호출한다(gen-images.sh 는 자체 acquire_lock 으로 보유 락과 데드락) — 락은 이미 보유 중. 멱등(유효하면 skip).
if [ "$STAGE" = "keyvisual" ] && [ -d "$RDIR/03-storyboard/plan" ] && [ -n "$(ls -A "$RDIR/03-storyboard/plan" 2>/dev/null)" ]; then
  # ── 이미지 생성 직전 '최종 점검'(읽기전용 권고 + 임계 결손 시 멈춤) ──
  #   비용·비가역(Nano Banana REST)인 image_engine 호출 '앞'에서 결손→결과를 종합해 보여주고, 임계 결손
  #   (임상 측정치 등록됐는데 시험성적서 요소 빠짐 = must_fill)이면 멈춘다. override = HARNESS_ACK_GAPS=1 또는 --proceed-with-gaps.
  #   ★ stub/오프라인(STUB_MODE=1)은 면제 — CI/골든 결정성 불변(생성 입력·stub 바이트 동일). 점검은 읽기전용(state 미기록).
  #   ★ '실엔진(비-stub) 이미지 매니페스트'가 이미 있을 때만(=비용 큰 실생성 완료, 멱등 재진입·resume·review 재진입)
  #     preflight 를 건너뛴다: 생성할 게 없는데 멈추면 no-op 재개가 깨진다(외부리뷰). 핵심 근거 — 비-stub 매니페스트가
  #     존재한다는 것은 '이전에 온라인 실생성이 이미 한 번 일어났다 = 그때 이 게이트를 통과(무결손)했거나 ack 로 진행했다'는
  #     뜻이다(임계 결손은 run 전역 claim-basis 라 블록/에셋 변화로 새로 생기지 않는다). 따라서 에셋 일부가 지워졌거나
  #     플랜이 바뀌어 image_engine 이 일부를 재생성하더라도, 그건 '이미 게이트를 거친 run' 의 재생성이라 재멈춤이 불필요하다.
  #     반대로 매니페스트가 없거나 stub/오프라인 산출(engine=stub)이면 '게이트가 아직 한 번도 적용되지 않은 실생성 전'이므로
  #     — 예: stub 런이 SVG 매니페스트를 남긴 뒤 온라인 재실행 — preflight 가 반드시 돌아야 한다(stub→online 우회 차단, 외부리뷰).
  #   ★ P-1 강화: '완료' = 실엔진 매니페스트 존재 && engine != stub && incomplete 아님(부분 매니페스트는 재생성 트리거).
  #     증분 매니페스트(부분성공, incomplete:true)를 '완료'로 오인하면 preflight 면제가 새므로 image_manifest_complete 로 판정.
  _KV_REAL_DONE=0
  image_manifest_complete "$RDIR" && _KV_REAL_DONE=1
  if [ "$STUB_MODE" != "1" ] && [ "$_KV_REAL_DONE" != "1" ]; then
    # set -euo 안전: 명령치환 실패(preflight exit 3=임계 결손)가 errexit 로 스크립트를 끊지 않게 &&/|| 로 rc 만 포착.
    PF_OUT="$("$PY" "$HARNESS_ROOT/scripts/lib/image_preflight.py" "$RID" "$RDIR" 2>/dev/null)" && PF_RC=0 || PF_RC=$?
    if [ "$PF_RC" -ne 0 ] && [ "${HARNESS_ACK_GAPS:-0}" != "1" ] && [ "$PROCEED_WITH_GAPS" != "1" ]; then
      _PF_SH="$("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" preimage stopped_header)"
      _PF_FR="$("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" preimage fill_retry)"
      _PF_PA="$("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" preimage proceed_anyway)"
      die "$PF_OUT

$_PF_SH
- $_PF_FR  bash scripts/run-stage.sh keyvisual $RID
- $_PF_PA HARNESS_ACK_GAPS=1 bash scripts/run-stage.sh keyvisual $RID"
    fi
    # 결손 없음(rc=0) 또는 override 진행: 점검 결과를 투명하게 보여주고 계속한다.
    [ -n "$PF_OUT" ] && printf '%s\n' "$PF_OUT"
    if [ "$PF_RC" -ne 0 ]; then
      info "$("$PY" "$HARNESS_ROOT/scripts/lib/operator_labels.py" preimage proceed_ack)"   # override 감사 한 줄
    fi
  fi
  _KV_IMG_ENG="$(resolve_image_engine)"
  # stdout(>/dev/null): image_engine 진단 print('[image-engine] engine=…')이 현업 4동작 화면에 'engine=' 잭곤으로 새지 않게(진단은 image-manifest.json 에 보존). stderr 는 유지(실패 추적).
  # ★ P-1/외부리뷰 W1c(c)/8R fail-closed: 실엔진(비-STUB) 이미지 생성이 '비-0 종료'면 여기서 멈춘다 — 어떤 실패 경로든
  #   (429 소진·fallback 호출 실패[잘못된 모델·네트워크·5xx]·첫 자산 전 크래시 등) 미완결 이미지가 검증(validate)·전이
  #   (advance)로 새지 않게(부분/무 이미지로 done 진행 차단). 재실행=멱등 재개(지금까지 만든 자산은 skip, 남은 블록만 생성).
  #   비-0 종료를 마커 유무로 판정하지 않는다(마커 미기록 실패 경로도 있음 — 외부리뷰 8R) → 종료코드로 직접 fail-closed.
  #   STUB_MODE(오프라인/CI)는 stub 이 결정적으로 성공하므로 die 없음(골든 바이트 불변); stub 이상종료 시엔 info 로 계속.
  # F1(C): --domain 으로 선언 규제도메인 전달 — 규제도메인(drug/quasi_drug/health_food)은 그래픽 블록(html_only)
  #   미생성(1급 keyvisual 경로도 gen-images.sh·render-design.sh 와 동일 술어. 누락 시 규제도메인에서 그래픽 baked 누수).
  # O-3(진행 신호): 이미지 bake 시작/완료 레코드 — 실엔진 bake(Pro 10~14장·분 단위)가 도는 동안 무이벤트 정체 오인 방지.
  #   자산별 세밀 진행은 image_engine stderr(.logs) + 증분 매니페스트가 담당. 여기선 bake 전체의 시작·소요·결과.
  obs_timing "$RID" phase="$CUR_PHASE" stage=keyvisual step=bake gen_source=image outcome=start
  _BAKE_T0="$(date +%s)"
  if "$PY" "$HARNESS_ROOT/scripts/lib/image_engine.py" "$RID" "$RDIR" --engine "$_KV_IMG_ENG" --domain "$(resolve_domain "$(state_file "$RID")")" >/dev/null; then
    obs_timing "$RID" phase="$CUR_PHASE" stage=keyvisual step=bake gen_source=image outcome=ok rc=0 duration_s="$(( $(date +%s) - _BAKE_T0 ))"
  else
    _IE_RC=$?
    obs_timing "$RID" phase="$CUR_PHASE" stage=keyvisual step=bake gen_source=image outcome=fail rc="$_IE_RC" duration_s="$(( $(date +%s) - _BAKE_T0 ))"
    if [ "$STUB_MODE" != "1" ]; then
      die "[keyvisual] 이미지 생성이 완결되지 않았습니다(쿼터/429·모델·네트워크 등으로 일부/전체 블록 미생성 — 코드 $_IE_RC). 지금까지 만든 것은 저장돼 있으니, 다시 실행하면 남은 블록만 이어서 만듭니다: bash scripts/run-stage.sh keyvisual $RID"
    fi
    info "[keyvisual] 블록 이미지 선행 생성 일부 실패(stub) — 계속."
  fi
  # 추가 방어: 성공(exit 0)했더라도 실엔진 '부분(incomplete) 매니페스트'면 fail-closed(위 종료코드 커버 밖의 잔여 경로).
  if [ "$STUB_MODE" != "1" ] && image_manifest_incomplete "$RDIR"; then
    die "[keyvisual] 이미지 생성이 완결되지 않았습니다(부분 매니페스트). 다시 실행하면 남은 블록만 이어서 만듭니다: bash scripts/run-stage.sh keyvisual $RID"
  fi
fi

if [ "$NEED_GENERATE" = "0" ]; then
  : # 위에서 처리
elif [ "$STAGE" = "intake" ]; then
  # ── 00a 첨부 자료 보편 분류 제안: 스냅샷 첨부(inputs/attachments/*)를 파일별로 분류·라우팅·반영 예고 제안. ──
  #   실 LLM(/intake, insession)은 파일 원문·구조·제품명 대조로 정밀 분류하고 docx→md 변환본을 쓴다.
  #   00e/00g 와 동일한 review-exempt 참조 입력 단계(광고 카피 아님) — 승인 뒤 kcia-check autopass, gate.sh 마무리 훅이
  #   승인된 분류대로 라우팅(apply-intake)+인입(ingest-bundle)을 잇는다.
  ADIR="$RDIR/00a-intake"
  # 보완(revise) 재생성: 직전 제안·변환본을 history/iter-N 으로 보존 후 새로 생성(감사추적). 00e reflection-proposal 와 동일 사상.
  if [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; then
    archive_multi_round "$ADIR" "$iter" intake-proposal.json converted
  fi
  info "[intake] 첨부 자료를 분류해 제안을 만드는 중"
  if [ "$STUB_MODE" = "1" ]; then
    "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" intake "$RID" "$RDIR"
  else
    # 실엔진(비-STUB)에서 여기 도달 = 세션 밖 subprocess(위에서 fail-closed) — 형식 대칭(00e 와 동일)으로만 유지.
    #   실제 실엔진 경로는 insession(NEED_GENERATE=0 로 이 디스패치를 건너뜀) 전용이다.
    [ -f "$PROMPT_FILE" ] || die "프롬프트가 없습니다: prompts/intake.md"
    _ISF="$(state_file "$RID")"
    run_llm "$CLI" "$(cat "$PROMPT_FILE")

## 실행 컨텍스트 (이 run 전용)
RUN_ID=$RID
RUN_DIR=$RDIR
ATTACHMENTS_DIR=$RDIR/inputs/attachments
PRODUCT_NAME_DECLARED=$(jget "$_ISF" product.name 2>/dev/null || true)
DECLARED_DOMAIN=$(jget "$_ISF" product.regulatory_domain 2>/dev/null || true)
DECLARED_FORMAT=$(jget "$_ISF" product.deliverable_format 2>/dev/null || true)

inputs/attachments/ 의 첨부 파일을 모두 직접 읽고(zip 해체본은 _unpacked/), 파일별로 분류해 스키마대로 작성하라:
 - 00a-intake/intake-proposal.json (harness/intake-proposal.schema.json)
 - working_backwards 문서는 00a-intake/converted/working-backwards.md 로 변환(docx→md)하고 그 파일 항목 actions 에 converted 를 넣어라.
분류는 제안일 뿐 사람이 승인한다(환각 안전 — 규제 성격 선언은 사람 몫). state.json 은 건드리지 마라(스크립트만 쓴다). 결정적 stand-in 은 scripts/lib/stub_stage.py intake 와 동일 계약이다." \
      "$ADIR/intake-proposal.json"
  fi
  append_history "$SF" "$(jget "$SF" phase)" "generate:intake:$ENGINE_LABEL" "run-stage.sh"
elif [ "$STAGE" = "guideline" ]; then
  # ── 00g 가이드라인: 동일 도메인 사례 분석(example-analysis) + 크롤 참조 노트(reference-notes) 캡처. ──
  #   구 '유사점 3안 추출 + select' 파기 → 현업이 '크롤 중 무엇이 좋았는지' 자유텍스트로 입력, 다운스트림(스토리라인·아웃라인·이미지)이 참조.
  #   사례 폴더가 없으면 단일 번들(runs/<id>/inputs/bundle)을 1개 사례로 폴백(기존 흐름 호환).
  GDIR="$RDIR/00g-guideline"
  # 보완(revise) 재생성: 직전 참조노트를 history/iter-N 으로 보존 후 새로 생성(감사추적). examples/(입력-안정)는 보존.
  if [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; then
    archive_multi_round "$GDIR" "$iter" reference-notes.json
  fi
  GDOMAIN="$(resolve_domain "$SF")"
  # 동일 도메인 사례만 분석(inputs/examples/<도메인>/*). 단일 출처 헬퍼(emit-context 와 공유 → 입력 드리프트 차단; 혼합 도메인 오라벨 fail-closed).
  EXDIRS=()
  while IFS= read -r d; do [ -n "$d" ] && EXDIRS+=("$d"); done < <(guideline_example_dirs "$RID")
  info "[guideline] 비슷한 사례 ${#EXDIRS[@]}개 분석 → 참고 메모 만드는 중"
  if [ "$STUB_MODE" = "1" ]; then
    "$PY" "$HARNESS_ROOT/scripts/lib/examples_analysis.py" "$GDIR" "$GDOMAIN" "${EXDIRS[@]}"
  else
    [ -f "$PROMPT_FILE" ] || die "프롬프트가 없습니다: prompts/guideline.md"
    CTX="$(build_context "$RID" guideline)"
    # 완료감지 watch(H5): 참조노트 + 사례별 example-analysis 전부(부분 산출물 조기중단 금지 — validate-stage 필수 집합과 일치).
    GLWATCH=("$GDIR/reference-notes.json")
    for _ed in "${EXDIRS[@]}"; do GLWATCH+=("$GDIR/examples/$(basename "$_ed")/example-analysis.json"); done
    run_llm "$CLI" "$(cat "$PROMPT_FILE")

## 실행 컨텍스트 (이 run 전용)
RUN_ID=$RID
RUN_DIR=$RDIR
REGULATORY_DOMAIN=$GDOMAIN
EXAMPLE_DIRS=${EXDIRS[*]}
$CTX

동일 도메인 사례를 분석해 스키마대로 작성하라:
 - 사례별 00g-guideline/examples/<example_id>/example-analysis.json (harness/example-analysis.schema.json)
 - 크롤 참조 노트 00g-guideline/reference-notes.json (harness/reference-notes.schema.json):
   '크롤한 사례 중 무엇이 왜 좋았는지'를 담는다 — flow_refs(전체 상세페이지 전개 플로우 참조)·composition_notes(좋았던 구도/무드)·notes(자유). regulatory_domain 은 '$GDOMAIN'.
why_good 의 grounded_in 은 반드시 실재 signals/voc_themes/structure 키만 인용(fail-closed; 근거 없는 칭찬 금지).
법(심의 룰셋) > 참조노트: banned/미승인 기능성·효능·절대 표현을 flow_refs/composition_notes/notes 에 넣지 마라. state.json 은 건드리지 마라." \
      "${GLWATCH[@]}"
  fi
  append_history "$SF" "$(jget "$SF" phase)" "generate:guideline:$ENGINE_LABEL" "run-stage.sh"
elif [ "$STAGE" = "evidence" ]; then
  # ── 00e 반영 제안 초안: 첨부된 참조 문서(inputs/evidence/*)에 대해 kind 추정 + 원문 발췌 반영 포인트를 제안한다. ──
  #   문서만 첨부(반영 스펙 미정)돼 ingest 가 spec_status=pending 으로 기록한 문서를 세션 내 에이전트가 읽고
  #   초안(reflection-proposal.json)을 쓴다. 00g 와 동일한 review-exempt 참조 입력 단계(광고 카피 아님) —
  #   승인 뒤 kcia-check 가 자동 통과, gate 마무리 훅이 매니페스트에 재기록(spec_origin=agent_proposed_human_approved).
  EDIR="$RDIR/00e-evidence"
  # 보완(revise) 재생성: 직전 제안을 history/iter-N 으로 보존 후 새로 생성(감사추적). 00g reference-notes 와 동일 사상.
  if [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; then
    archive_multi_round "$EDIR" "$iter" reflection-proposal.json
  fi
  info "[evidence] 첨부한 참조 문서를 읽고 반영 제안 초안을 만드는 중"
  if [ "$STUB_MODE" = "1" ]; then
    "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" evidence "$RID" "$RDIR"
  else
    # 실엔진(비-STUB)에서 여기 도달 = 세션 밖 subprocess(위에서 fail-closed) — 형식 대칭(00g 와 동일)으로만 유지.
    #   실제 실엔진 경로는 insession(NEED_GENERATE=0 로 이 디스패치를 건너뜀) 전용이다.
    [ -f "$PROMPT_FILE" ] || die "프롬프트가 없습니다: prompts/evidence.md"
    CTX="$(build_context "$RID" evidence)"
    run_llm "$CLI" "$(cat "$PROMPT_FILE")

## 실행 컨텍스트 (이 run 전용)
RUN_ID=$RID
RUN_DIR=$RDIR
EVIDENCE_DIR=$RDIR/inputs/evidence
$CTX

inputs/evidence/ 의 첨부 문서를 모두 직접 읽고, 00-ingest/evidence-documents.json 의 spec_status=pending 문서에 대해
반영 제안 초안을 스키마대로 작성하라:
 - 00e-evidence/reflection-proposal.json (harness/reflection-proposal.schema.json)
반영 포인트(reflection_points)는 반드시 문서 원문에서 그대로 발췌한다(창작·의역 금지 — 환각 안전). 사람이 이후 승인한다.
state.json 은 건드리지 마라(스크립트만 쓴다). 결정적 stand-in 은 scripts/lib/stub_stage.py evidence 와 동일 계약이다." \
      "$EDIR/reflection-proposal.json"
  fi
  append_history "$SF" "$(jget "$SF" phase)" "generate:evidence:$ENGINE_LABEL" "run-stage.sh"
elif [ "$STAGE" = "concept" ]; then
  # ── 컨셉: 축별 '독립 생성' 강제(mode collapse 방지). 축마다 별도 호출 + 축별 idempotent skip. ──
  info "[concept] 내세울 메시지 후보를 축별로 만드는 중"
  CDIR="$RDIR/02-concept"
  # M5(G2): 컨셉 전부거절→재생성 일관화 — 거절된 라운드(옵션/추천/결정)를 history/iter-N 으로 보존 후 active 비움.
  #   concept-axes.json(구조 프레임)은 보존(아카이브 대상 아님) → 같은 축으로 옵션만 새 라운드 생성. 00g 와 동일 사상.
  if [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; then
    archive_multi_round "$CDIR" "$iter" options recommendation.json decision.json
  fi
  CTX="$(build_context "$RID" concept)"; CPROMPT="$(cat "$HARNESS_ROOT/prompts/concept.md")"
  # ① 축 정의
  if [ ! -f "$CDIR/concept-axes.json" ]; then
    if [ "$STUB_MODE" = "1" ]; then "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" concept-axes "$RID" "$RDIR"
    else run_llm "$CLI" "$CPROMPT
[STEP: 축 정의만] concept-axes.json 만 작성하라. RUN_DIR=$RDIR. $CTX" "$CDIR/concept-axes.json"; fi
    append_history "$SF" "$(jget "$SF" phase)" "generate:concept-axes:$ENGINE_LABEL" "run-stage.sh"
  fi
  # ② 축별 독립 생성 (이미 있고 검증되면 skip)
  while IFS= read -r AX; do
    [ -n "$AX" ] || continue
    if [ -f "$CDIR/options/$AX/rtb.json" ] && [ -f "$CDIR/options/$AX/key-message.json" ] \
       && validate_artifact "$CDIR/options/$AX/rtb.json" >/dev/null 2>&1 \
       && validate_artifact "$CDIR/options/$AX/key-message.json" >/dev/null 2>&1 \
       && [ "$cur_status" != "revise" ] && [ "$cur_status" != "changes_requested" ]; then
      info "  - 축 $AX 이미 생성됨 — skip(idempotent)"
      continue
    fi
    if [ "$STUB_MODE" = "1" ]; then "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" concept-option "$RID" "$RDIR" "$AX"
    else run_llm "$CLI" "$CPROMPT
[STEP: 이 축만 단독 생성] axis=$AX. options/$AX/{rtb.json,key-message.json} 만 작성. 다른 축 보지 말 것(독립 생성). RUN_DIR=$RDIR. $CTX" "$CDIR/options/$AX/rtb.json" "$CDIR/options/$AX/key-message.json"; fi
    info "  - 축 $AX 생성"
    append_history "$SF" "$(jget "$SF" phase)" "generate:concept-axis:$AX:$ENGINE_LABEL" "run-stage.sh"
  done < <("$PY" -c "import json;[print(a['id']) for a in json.load(open('$CDIR/concept-axes.json'))['axes']]")
  # ③ 추천
  if [ "$STUB_MODE" = "1" ]; then "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" concept-reco "$RID" "$RDIR"
  else run_llm "$CLI" "$CPROMPT
[STEP: 추천] recommendation.json(ranked=실재 옵션 id, rationale) 만 작성. RUN_DIR=$RDIR." "$CDIR/recommendation.json"; fi
elif [ "$STAGE" = "storyboard-plan" ]; then
  # ── 기획안: 블록 단위 생성/재개/부분 재생성 (외부리뷰 B4 #6/#7). ──
  info "[storyboard-plan] 페이지 구성안을 블록별로 만드는 중"
  PDIR="$RDIR/03-storyboard/plan"; mkdir -p "$PDIR"
  PPROMPT="$(cat "$HARNESS_ROOT/prompts/storyboard-plan.md")"; PCTX="$(build_context "$RID" storyboard-plan)"
  # P0-ⓠ(전역 아트디렉션): 블록보다 '먼저' 03-storyboard/art-direction.json 을 1회 정의 — 모든 블록 visual.concept 가
  #   이 master_palette/color_temp/lighting/typography/master_reference 를 상속(블록마다 다른 경쟁사 스타일 앵커 = 톤 분열 제거).
  #   revise 시 갱신(결정적·idempotent). 블록 palette ⊆ master_palette 는 validate-stage 가 fail-closed 강제.
  #   ⚠ revise 시엔 기본 '보존'한다(재생성 금지) — 아트디렉션은 전 블록 공통 '안정' 브랜드킷이라, revise 마다 master_palette 가
  #     바뀌면 부분 재생성으로 보존된 블록 palette 가 새 master 밖으로 떨어져 검증 dead-end(외부리뷰 HIGH). 최초 1회만 정의.
  #   예외(외부리뷰 2R HIGH 'inverse dead-end'): 보완 요청(feedback)이 '전역 톤/팔레트/마스터 reference 자체'를 겨냥하면
  #     아트디렉션을 재생성하고 **전 블록 강제 재생성**(부분 보존이 새 master 와 어긋나는 dead-end 회피). 정상 4동작(revise)으로 전역 톤 교정 경로 제공.
  ADF="$RDIR/03-storyboard/art-direction.json"
  AD_REVISE=0
  if { [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; } && [ -f "$RDIR/03-storyboard/feedback.json" ] \
     && grep -Eiq '아트디렉션|art[- ]?direction|팔레트|palette|마스터|master|톤앤매너|색감|색상|color|lighting|라이팅' "$RDIR/03-storyboard/feedback.json"; then
    AD_REVISE=1
  fi
  if [ ! -f "$ADF" ] || [ "$AD_REVISE" = "1" ]; then
    [ "$AD_REVISE" = "1" ] && rm -f "$ADF"   # 겨냥 보완 → 아트디렉션 재생성(아래 전 블록 재생성과 짝)
    if [ "$STUB_MODE" = "1" ]; then "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" art-direction "$RID" "$RDIR"
    else run_llm "$CLI" "$PPROMPT
[STEP: 전역 아트디렉션만] 03-storyboard/art-direction.json 만 작성(harness/art-direction.schema.json). master_palette·color_temp·lighting·typography + master_reference(자사 자산 inputs/assets/). 모든 블록 visual.concept 가 이를 상속하므로 블록 palette 는 master_palette 의 부분집합이어야 한다. RUN_DIR=$RDIR. $PCTX" "$ADF"; fi
    append_history "$SF" "$(jget "$SF" phase)" "generate:art-direction:$ENGINE_LABEL" "run-stage.sh"
    # ★ PCTX 재계산: 이제 art-direction.json 이 존재 → build_context 가 ART_DIRECTION 라벨을 포함한다.
    #   블록 생성(아래 run_llm $PCTX)이 master_palette/톤을 실제로 상속받게 한다(외부리뷰 HIGH: stale PCTX 우회 차단).
    PCTX="$(build_context "$RID" storyboard-plan)"
  fi
  # M3: tone 서브스테이지 흡수 — 기획안 블록이 구도/무드/참조(visual.concept)를 직접 산출(tone 선택 불필요).
  # revise 라면 직전 verdict 의 위반 블록만 재생성 대상으로(나머지 보존). 직전 버전은 history 라운드로 보존.
  REVISE_TARGETS=""
  if { [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; } && [ -f "$RDIR/03-storyboard/plan-verdict.json" ]; then
    REVISE_TARGETS="$("$PY" -c "
import json,re
vs=json.load(open('$RDIR/03-storyboard/plan-verdict.json')).get('violations',[])
ts=set()
for v in vs:
    m=re.search(r'\[(\w+)\]', v.get('target_text','')+v.get('suggested_rewrite',''))
    if m: ts.add(m.group(1))
print(' '.join(sorted(ts)))" 2>/dev/null || true)"
    RND="$PDIR/history/iter-$iter"; mkdir -p "$RND"; cp -f "$PDIR"/*.json "$RND"/ 2>/dev/null || true
  fi
  # 아트디렉션이 재생성됐으면(AD_REVISE) 전 블록을 강제 재생성한다 — 보존 블록의 옛 palette 가 새 master 밖으로
  #   떨어지는 inverse dead-end 차단(외부리뷰 2R HIGH). REVISE_TARGETS 를 비워 아래 루프의 '빈 타겟=전체 재생성' 경로를 탄다.
  [ "$AD_REVISE" = "1" ] && REVISE_TARGETS=""
  # 선택 스토리라인의 블록 목록을 순회하며 개별 생성(이미 유효하고 revise 대상 아니면 skip).
  while IFS='|' read -r ORD TYP; do
    [ -n "$ORD" ] || continue
    BF="$PDIR/$(printf '%02d' "$ORD")-$TYP.json"
    regen=1
    if [ -f "$BF" ] && validate_artifact "$BF" >/dev/null 2>&1; then
      if [ "$cur_status" = "revise" ] || [ "$cur_status" = "changes_requested" ]; then
        # revise: 매핑된 위반 블록만 재생성. 단 매핑 실패(빈 타겟)면 전체 재생성(no-op 방지, 외부리뷰 5차).
        if [ -z "$REVISE_TARGETS" ]; then regen=1
        else case " $REVISE_TARGETS " in *" $TYP "*) regen=1;; *) regen=0;; esac; fi
      else
        regen=0   # 비-revise 재개: 유효 산출물 보존(idempotent)
      fi
    fi
    if [ "$regen" = "0" ]; then info "  - 블록 $ORD-$TYP 보존(skip)"; continue; fi
    if [ "$STUB_MODE" = "1" ]; then "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" plan-block "$RID" "$RDIR" "$ORD" "$TYP"
    else run_llm "$CLI" "$PPROMPT
[STEP: 이 블록만 생성/수정] order=$ORD type=$TYP. plan/$(printf '%02d' "$ORD")-$TYP.json 만 작성(다른 블록 보존). RUN_DIR=$RDIR. $PCTX" "$BF"; fi
    info "  - 블록 $ORD-$TYP 생성"
    append_history "$SF" "$(jget "$SF" phase)" "generate:plan-block:$ORD-$TYP:$ENGINE_LABEL" "run-stage.sh"
  done < <("$PY" -c "
import json,os
d=os.path.join('$RDIR','03-storyboard','outline','decision.json')
sel=json.load(open(d))['selected'] if os.path.exists(d) else 'A'
sl=json.load(open(os.path.join('$RDIR','03-storyboard','outline','options',sel,'storyline.json')))
[print('%s|%s'%(b['order'],b['type'])) for b in sl['blocks']]")
elif [ "$STUB_MODE" = "1" ]; then
  info "[$STAGE] 만드는 중"
  # 결정적 stub 생성기 (실입력 voc/claim-basis 기반). 산출물 파일을 직접 생성.
  "$PY" "$HARNESS_ROOT/scripts/lib/stub_stage.py" "$STAGE" "$RID" "$RDIR"
else
  # 1급 LLM 경로: 프롬프트 + 컨텍스트를 비대화 실행에 전달. 모델이 산출물 파일을 직접 write.
  [ -f "$PROMPT_FILE" ] || die "프롬프트가 없습니다: prompts/$STAGE.md"
  CTX="$(build_context "$RID" "$STAGE")"
  FULL_PROMPT="$(cat "$PROMPT_FILE")

## 실행 컨텍스트 (이 run 전용)
RUN_ID=$RID
RUN_DIR=$RDIR
$CTX

위 스키마·규약을 지켜 산출물 파일을 RUN_DIR 하위에 직접 작성하라. state.json 은 건드리지 마라."
  # 완료감지 watch = 이 단계의 '필수 산출물 전부'(validate-stage 와 동일 집합). 부분 산출물에 조기중단 금지(외부리뷰 HIGH).
  #   keyvisual: A·B HTML + recommendation(없으면 validate 실패) / storyboard-outline: A·B storyline + recommendation + sources/results.
  # 이슈3a(최소 3안): 다안 페이즈는 A·B·C 3안을 완료감지·검증 대상으로(2안 하드코딩 제거 → 실 LLM 이 3안을 내야 완료).
  case "$STAGE" in
    keyvisual)          GEN_WATCH=("$RDIR/04-keyvisual/options/A/index.html" "$RDIR/04-keyvisual/options/B/index.html" "$RDIR/04-keyvisual/options/C/index.html" "$RDIR/04-keyvisual/recommendation.json") ;;
    storyboard-outline) GEN_WATCH=("$RDIR/03-storyboard/outline/options/A/storyline.json" "$RDIR/03-storyboard/outline/options/B/storyline.json" "$RDIR/03-storyboard/outline/options/C/storyline.json" "$RDIR/03-storyboard/outline/recommendation.json" "$RDIR/03-storyboard/sources/results.json") ;;
    *)                  GEN_WATCH=("$RDIR/$primary") ;;
  esac
  run_llm "$CLI" "$FULL_PROMPT" "${GEN_WATCH[@]}"
fi

# ── 산출물 검증 ──
if [ ! -f "$RDIR/$primary" ]; then
  die "[$STAGE] 1차 산출물이 생성되지 않았습니다: $primary"
fi

# ── B-4: 온라인 실증 근거 검색(OpenAlex) — storyboard-outline 전용 · 오프라인 골든 무접촉 ──
#   ★ STUB_MODE(오프라인/CI)면 절대 실행 안 함(offline stub 골든 경로 무접촉; resolve_evidence_engine 자체가 온라인만 실엔진).
#   온라인일 때만: evidence_search.py 가 **스크립트-측에서 실증 트리거를 직접 감지**(에이전트 query.json 존재에 의존 안 함 —
#   에이전트가 트리거 있는데 query.json 을 빠뜨려도 스스로 (재)작성·검색 → fail-open 우회 불가)하고, 트리거가 있으면
#   실 OpenAlex 로 sources/{query,results}.json 을 결정적으로 (재)작성한다(에이전트 mock 은 placeholder — 프롬프트 무수정).
#   ⚠ 엔진 자체 실패(네트워크/타임아웃/파싱)는 fail-closed(die) — 무음 stub 강등 금지. "결과 0건"은 정상(주장 불가, no-op).
#   덮어쓴 뒤 아래 validate-stage 가 results.schema 로 재검증(비정상 응답도 fail-closed). state.json 미접촉(sources 만 씀).
#   ★ '생성이 일어난 시점'에만 호출(NEED_GENERATE!=0 또는 insession) — 그래야 에이전트 mock 을 실검색으로 덮어쓴다.
#   순수 재개/no-op(NEED_GENERATE=0·비-insession)은 호출 안 함(직전 생성 때 이미 스크립트-검색된 sources 유지 → 안정·중복검색 방지).
#   evidence_search 는 기존 파일의 engine 마커를 신뢰하지 않고 항상 재검색하므로, 이 생성-게이트가 우회·재검색 폭주를 함께 막는다(외부리뷰).
if [ "$STAGE" = "storyboard-outline" ] && [ "$STUB_MODE" != "1" ] && { [ "$NEED_GENERATE" != "0" ] || [ "$GEN_SOURCE" = "insession" ]; }; then
  EVIDENCE_ENGINE="$(resolve_evidence_engine)"   # 온라인 → openalex(오프라인은 위 STUB_MODE 가드로 진입 안 함)
  "$PY" "$HARNESS_ROOT/scripts/lib/evidence_search.py" "$RID" "$RDIR" "$EVIDENCE_ENGINE" \
    || die "[storyboard-outline] 실증 근거 검색(OpenAlex)이 실패했습니다 — 네트워크/엔진 오류는 fail-closed(무음 stub 강등 금지). '결과 0건'은 정상이며 이건 엔진 오류입니다."
fi

# 키비주얼 렌더(Playwright 결정적 후처리: 저작권 lint + 섹션 캡처 + design-manifest)는 '무슨 일이 있었나'로 돈다(PR2-E 렌더 디커플링):
#   · subprocess 생성/보완(NEED_GENERATE!=0) → 기존과 동일하게 항상 렌더(보완 시 stale-skip 회귀 없음 — 외부리뷰 PR2 R1 HIGH).
#   · 세션 내 생성(GEN_SOURCE=insession; 에이전트가 HTML 만 씀) → 전이 단계에서 렌더가 manifest 를 만든다(claude 불필요).
#   · 재개(NEED_GENERATE=0 · subprocess: 완성·manifest 보유) → 둘 다 거짓 → 렌더 생략(멱등, 기존 동작 보존).
#   mtime/해시 staleness 비교를 쓰지 않는다(CSS-only 변경·동초 mtime 우회 불가 — 외부리뷰 PR2 R1 HIGH). 렌더는 항상 현재 HTML/CSS 로 manifest 를 재산출한다.
if [ "$STAGE" = "keyvisual" ] && [ -f "$RDIR/04-keyvisual/options/A/index.html" ] \
   && { [ "$NEED_GENERATE" != "0" ] || [ "$GEN_SOURCE" = "insession" ]; }; then
  bash "$HARNESS_ROOT/scripts/render-design.sh" "$RID"
fi

bash "$HARNESS_ROOT/scripts/validate-stage.sh" "$RID" "$(stage_phase "$STAGE")" >/dev/null

# ── 이슈3b: 다안(select) 페이즈 → 옵션 JSON 을 사람용 비교 MD 로 파생(검증 통과 후·전이 전) ──
#   안별 summary.md + 페이즈 options-compare.md(나란히 비교). JSON=진실원천, MD=읽기전용 파생(역방향 없음 — 4동작/JSON손편집금지 정합).
#   concept·storyboard-outline 만(keyvisual 은 index.html 로 이미 viewable). 자유텍스트는 operator_labels.scrub 통과. 실패는 fail-soft(비차단).
if [ "$multi" = "1" ] && { [ "$STAGE" = "concept" ] || [ "$STAGE" = "storyboard-outline" ]; }; then
  "$PY" "$HARNESS_ROOT/scripts/lib/render_options_md.py" "$RID" "$RDIR" "$STAGE" 2>/dev/null \
    || info "[$STAGE] 옵션 비교 MD 파생 일부 생략(원본 JSON 으로 진행)."
fi

# 개선0(측정 로그): 이 생성 단계의 소요시간·결과를 .logs/timing.jsonl 에 기록(stub/insession/subprocess 통일).
#   NEED_GENERATE=0(재개)면 생성 생략이라 outcome=skipped. gen_source 가 subprocess|insession|stub 을 구분.
{ [ "$STUB_MODE" = "1" ] && _GS="stub"; } || _GS="$GEN_SOURCE"
obs_timing "$RID" phase="$CUR_PHASE" stage="$STAGE" step=generate engine="$ENGINE_LABEL" gen_source="$_GS" \
  outcome="$([ "$NEED_GENERATE" = "0" ] && echo skipped || echo ok)" rc=0 duration_s="$(( $(date +%s) - _GEN_T0 ))"
# L-1: 실행 기록(git_sha·엔진·유효플래그·프롬프트 지문) — 실제 생성이 일어난 경우만 기록(순수 재개/no-op 제외).
#   ⚠ insession(온라인 primary 모드, 298행)은 NEED_GENERATE=0 **이면서** GEN_SOURCE=insession 이다 → NEED_GENERATE 만
#   보면 insession 생성이 감사 로그에서 빠진다(외부리뷰 P2). 그래서 'insession 이거나 subprocess/stub 실생성(NEED_GENERATE=1)'
#   일 때 기록하고, 순수 재개(NEED_GENERATE=0 · GEN_SOURCE=subprocess)만 제외한다. .logs 골든제외·best-effort.
{ [ "$NEED_GENERATE" != "0" ] || [ "$GEN_SOURCE" = "insession" ]; } && obs_provenance "$RID" generate "$ENGINE_LABEL" "$_GS"

# ── M4: 생성 완료 → **사람 게이트**로 전이(다안=select / 단안=user). 심의는 사람 승인/선택 뒤. ──
#   (step==generate 일 때만; 재개 중복 방지. 토큰 형식·resume 접두 보존 — kcia-check 격리 정규식 의존.)
if [ "$(jget "$SF" step)" = "generate" ]; then   # step==generate 일 때만(재개 중복 방지). 락 보유 중이라 read→write 원자.
  if [ "$multi" = "1" ]; then   # 다안(00g/concept/storyboard-outline/keyvisual) → 선택 게이트
    _ST='"select"'; _GT='"select"'; _AW='"select"'
  else                          # 단안(brief/storyboard-plan) → 승인 게이트
    _ST='"human"'; _GT='"user"'; _AW='"user"'
  fi
  # 끝 토큰은 항상 엔진 패밀리(claude/stub) — kcia-check 의 GEN_CLI 파스(split(':')[-1])가 두 모드 모두에서 발동.
  if [ "$GEN_SOURCE" = "insession" ]; then _EV="generate:insession:$STAGE:$ENGINE_LABEL"   # WS-1(in-session): 세션 내 직접 생성
  elif [ "$NEED_GENERATE" = "1" ];   then _EV="generate:ok:$STAGE:$ENGINE_LABEL"           # subprocess(헤드리스 run_llm) — 기존 그대로
  else                                    _EV="resume:transition:$STAGE"; fi               # 재개(생성 생략 전이) — 기존 그대로
  transition step="$_ST" gate="$_GT" status='"pending"' awaiting="$_AW" \
             "@history=$(jget "$SF" phase)|$_EV|run-stage.sh"
  # AG-UI 투영(첫 sync 면 StateSnapshot+RunStarted 포함): 생성 스텝(StepStarted/StepFinished) + StateDelta +
  #   사람 게이트 도달 시 RunFinished{interrupt:select|approve}. state 는 안 쓴다(파생 뷰만).
  agui_emit "$RID"
fi

bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --render-only >/dev/null 2>&1 || true
if [ "$multi" = "1" ]; then
  ok "[$STAGE] 다 만들고 확인했어요 → 고를 차례"
  info "다음: bash scripts/select.sh $RID <옵션>"
else
  ok "[$STAGE] 다 만들고 확인했어요 → 승인할 차례"
  info "다음: bash scripts/approve.sh $RID"
fi
