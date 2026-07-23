#!/usr/bin/env bash
# test-b7.sh — B7 현업 파일럿·핸드오프. run.md '다음 명령'을 그대로 실행해 완주(JSON 손편집 0).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B7 — 현업 파일럿·핸드오프 (run.md 단독 완주)"

# run.md '다음 명령:' 백틱 안의 명령을 '그대로' 추출(가공 금지 — Codex B7#8)
op_next_cmd() {
  python3 - "$ROOT/runs/$1/run.md" <<'PYEOF'
import re, sys
md = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"다음 명령:\s*`([^`]+)`", md)
print(m.group(1).strip() if m else "")
PYEOF
}

# run.md 만 보고 완주하는 현업 시뮬레이터. 반환(전역): OP_DONE, OP_INTERV, OP_STEPS
run_operator_loop() {
  local rid="$1" maxn="${2:-26}"
  OP_DONE=0; OP_INTERV=0; OP_STEPS=0
  for _ in $(seq 1 "$maxn"); do
    local ph; ph="$(jq_phase "$rid" phase)"
    [ "$ph" = "done" ] && { OP_DONE=1; break; }
    local cmd; cmd="$(op_next_cmd "$rid")"
    # run.md 는 항상 '그대로 실행 가능한' 명령을 제시해야 한다(플레이스홀더/빈값/비스크립트 = 막힘)
    if [ -z "$cmd" ] || printf '%s' "$cmd" | grep -q '<' || ! printf '%s' "$cmd" | grep -qE '^bash scripts/'; then
      OP_INTERV=$((OP_INTERV+1)); break
    fi
    OP_STEPS=$((OP_STEPS+1))
    ( cd "$ROOT" && eval "$cmd" ) >/dev/null 2>&1 || { OP_INTERV=$((OP_INTERV+1)); break; }
  done
}

RID=ci-b7; rm -rf "$ROOT/runs/$RID" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" ) >/dev/null 2>&1
run_operator_loop "$RID" 28
check "(a) run.md '다음 명령' 그대로 실행만으로 end-to-end 완주(done)" "[ $OP_DONE -eq 1 ]"
check "(a) 개발자 개입(막힘) 0건" "[ $OP_INTERV -eq 0 ]"
check "(a) 모든 단계에서 run.md 가 실행 가능한 명령 제시(STEPS>0)" "[ $OP_STEPS -gt 0 ]"
check "(b) JSON 손편집 없이 완주(시뮬레이터는 run.md 명령만 실행)" "[ $OP_DONE -eq 1 ]"

# (c) 협회 자문 패키지 즉시 제출 가능
check "(c) export/kcia-package 제출 가능" "[ -f '$ROOT/runs/$RID/04-keyvisual/export/kcia-package/README.md' ]"
check "(c+) 실증 mock 상태여도 grade/출처 표기 포함" "grep -qi 'grade' '$ROOT/runs/$RID/04-keyvisual/export/kcia-package/README.md'"

# (d) 비법적 고지 노출 (run.md + export + README)
check "(d) run.md 에 비법적 고지" "grep -q '법적 통과 보증이 아니' '$ROOT/runs/$RID/run.md'"
check "(d) export 에 비법적 고지" "grep -q '법적 통과 보증이 아니' '$ROOT/runs/$RID/04-keyvisual/export/kcia-package/README.md'"
check "(d) README 5분 가이드에 비법적 고지" "grep -q '법적 통과 보증이 아니' '$ROOT/README.md'"

# (R2) 현업 오입력 친절 반려
OUT_BAD="$( ( cd "$ROOT" && bash scripts/run-stage.sh nonsense $RID ) 2>&1 )"; RC_BAD=$?
check "(R2) 오입력(잘못된 stage) 친절 반려" "[ $RC_BAD -ne 0 ]"
unset HARNESS_CLI HARNESS_OFFLINE

# (R1) 중단→재개를 현업이 run.md 만 보고 다른 CLI 로 직접 수행
RID2=ci-b7r; rm -rf "$ROOT/runs/$RID2" "$ROOT/inputs/bundle"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" ) >/dev/null 2>&1
# claude 로 run.md 따라 몇 단계만 진행(절반 중단)
run_operator_loop "$RID2" 6
PH_MID="$(jq_phase $RID2 phase)"
check "(R1) 절반 진행 후 중간 상태(아직 미완료)" "[ \"$PH_MID\" != 'done' ]"
export HARNESS_CLI=codex   # 다른 PC/CLI 로 재개 — 동일 run.md 루프로 완주
run_operator_loop "$RID2" 28
check "(R1) 다른 CLI 로 run.md 따라 재개·완주(done)" "[ $OP_DONE -eq 1 ] && [ $OP_INTERV -eq 0 ]"
unset HARNESS_CLI HARNESS_OFFLINE

rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B7: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
