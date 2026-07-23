#!/usr/bin/env bash
# select.sh — multi-option 선택 기록 (decision.json 고정포맷). 설계 §10.3.
# 사용법: bash scripts/select.sh <run_id> <옵션키> ["코멘트"] [--by <행위자id>]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"; shift || true
assert_ingest_complete "$RID"   # N10: 00-ingest 미완(중단) 표식 있으면 어느 phase 든 선택 전 fail-closed(썩은 인입 위 상태변이 차단)
# 플래그(--by) 먼저 분리, 위치인자(옵션키·코멘트) 계약 보존. --by = 사람 행위자 → 감사 history.actor.
CHOICE=""; COMMENT=""; BY=""; _pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --by)   BY="${2:-}"; shift 2 ;;
    --by=*) BY="${1#--by=}"; shift ;;
    *)      if [ "$_pos" -eq 0 ]; then CHOICE="$1"; else COMMENT="$1"; fi; _pos=$((_pos + 1)); shift ;;
  esac
done
if [ -n "$BY" ]; then export HARNESS_ACTOR="$BY"; fi
acquire_lock "$RID"; export HARNESS_LOCK_HELD=1
SF="$(state_file "$RID")"

GATE="$(jget "$SF" gate)"; STATUS="$(jget "$SF" status)"; PHASE="$(jget "$SF" phase)"
# 중단 복구: decision 은 기록(status=selected)됐으나 후속 전이(M4: select→review) 전 중단된 경우 → 전이만 재개.
#   M4: select 는 substage 를 전진시키지 않으므로(전진=review-pass), 별도 storyboard 재개 분기 불필요.
if [ "$STATUS" = "selected" ] && [ "$GATE" = "select" ]; then
  info "직전 선택이 중단되었습니다 — 게이트 전이를 재개합니다."
  bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" select
  unset HARNESS_LOCK_HELD; release_lock; ok "선택 전이 재개 완료: $RID"; exit 0
fi
if [ "$GATE" != "select" ] || [ "$STATUS" != "pending" ]; then
  die "지금은 고를 차례가 아니에요. run.md 의 '다음 명령'을 확인하세요."
fi
[ -n "$CHOICE" ] || die "선택할 옵션을 지정하세요. 예: bash scripts/select.sh $RID B"

PHASE="$(jget "$SF" phase)"
# 00g 단안 전환(구 유사점 3안 select 파기): 레거시 select 상태에 갇힌 00g 면 dead-end 대신 복구 경로 안내.
[ "$PHASE" = "00g-guideline" ] && die "00g(크롤 참조 노트)는 이제 선택이 아니라 '승인' 단계입니다. 재생성으로 복구하세요: bash scripts/run-stage.sh guideline $RID (그 뒤 approve.sh)."
# 유효 옵션 키 목록
OPTS_DIR=""
case "$PHASE" in
  # 00g-guideline 은 더 이상 다안(select) 아님 — 크롤 참조 노트 단안(승인). 게이트 가드가 select 진입 자체를 막는다.
  02-concept) OPTS_DIR="$(run_dir "$RID")/02-concept/options" ;;
  03-storyboard) OPTS_DIR="$(run_dir "$RID")/03-storyboard/outline/options" ;;  # M3: select 는 스토리라인(outline)만
  04-keyvisual) OPTS_DIR="$(run_dir "$RID")/04-keyvisual/options" ;;
esac
VALID=""
if [ -n "$OPTS_DIR" ] && [ -d "$OPTS_DIR" ]; then
  VALID="$(cd "$OPTS_DIR" && ls -d */ 2>/dev/null | sed 's#/##' | tr '\n' ' ')"
fi
# 부분 매칭 허용("B"→"B-emotional")하되 **유일**해야 한다(모호하면 거부). Codex #7.
MATCH=""; NMATCH=0; MATCHES=""
for k in $VALID; do
  if [ "$k" = "$CHOICE" ]; then MATCH="$k"; NMATCH=1; MATCHES="$k"; break; fi   # 정확 일치 우선
  if [ "${k%%-*}" = "$CHOICE" ]; then MATCH="$k"; NMATCH=$((NMATCH + 1)); MATCHES="$MATCHES $k"; fi
done
if [ "$NMATCH" -eq 0 ]; then
  die "선택값 '$CHOICE' 이(가) 올바르지 않습니다. 가능한 값: ${VALID:-A B C}"
elif [ "$NMATCH" -gt 1 ]; then
  die "선택값 '$CHOICE' 이(가) 모호합니다(여러 옵션과 매칭:${MATCHES}). 정확한 옵션 id 를 입력하세요: ${VALID}"
fi

DEC="$(run_dir "$RID")/$(sel_decision_rel "$RID")"
mkdir -p "$(dirname "$DEC")"
"$PY" "$LIB" jset "$DEC" selected "\"$MATCH\"" >/dev/null
"$PY" "$LIB" jset "$DEC" comment "$(printf '%s' "$COMMENT" | "$PY" -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" >/dev/null
validate_artifact "$DEC" >/dev/null

bash "$HARNESS_ROOT/scripts/gate.sh" "$RID" select
unset HARNESS_LOCK_HELD; release_lock
ok "선택 기록: $RID → $MATCH"
