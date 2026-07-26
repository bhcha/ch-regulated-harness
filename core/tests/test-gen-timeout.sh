#!/usr/bin/env bash
# test-gen-timeout.sh — 생성 watchdog(run_llm) 회귀 가드: 행/좀비 방지 3중 처방을 결정론적으로 검증.
#   배경: 생성 CLI 가 산출물을 다 쓰고도 종료 안 하면(좀비/행) 포그라운드 대기가 무한 → 마무리 전이 정지.
#   처방: ⓐ 출력 완료감지(watch 파일 → 더 안 기다림) ⓑ 하드 상한(GEN_TIMEOUT) ⓒ 미종료 자식 트리 종료(kill_proc_tree).
#   실 LLM 없이 '가짜 claude'(PATH 선점)로 좀비/행을 모사한다. JSON 스키마 의존을 피하려 watch 파일은 .html(존재만 판정).
#   ⚠ 개편(세션 밖 헤드리스 subprocess 실엔진 생성 폐기) 후에도 run_llm() 함수 자체는 보존된다(in-session 미감지 경로의
#     백스톱·직접 단위테스트 대상). 본 테스트는 run-stage 의 subprocess 게이트가 아니라 run_llm() 을 '직접' 호출해 watchdog
#     불변식만 검증하므로 개편과 무관하게 유효하다(run-stage 의 세션밖 실엔진 fail-closed 는 test-insession-genmode 가 담당).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## GEN-TIMEOUT — 생성 watchdog(완료감지·상한·트리종료)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gentimeout.XXXXXX")"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$TMP/bin"
# 가짜 claude: -p/플래그/프롬프트 인자는 무시. FAKE_MODE 로 좀비/행/정상종료를 모사.
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
case "${FAKE_MODE:-}" in
  complete)      mkdir -p "$(dirname "$FAKE_OUT")"; printf 'done' > "$FAKE_OUT"; exec sleep 300 ;;  # 출력 후 미종료(좀비)
  complete_exit) mkdir -p "$(dirname "$FAKE_OUT")"; printf 'done' > "$FAKE_OUT"; exit 0 ;;          # 출력 후 정상종료
  complete_gc)   mkdir -p "$(dirname "$FAKE_OUT")"; printf 'done' > "$FAKE_OUT"
                 sleep 300 & echo $! > "$FAKE_GPID"; exec sleep 300 ;;                              # 출력 후 손자 생성 + 미종료(좀비)
  fork_exit)     mkdir -p "$(dirname "$FAKE_OUT")"; printf 'done' > "$FAKE_OUT"
                 sleep 300 & echo $! > "$FAKE_GPID"; exit 0 ;;                                      # 출력 후 손자 남기고 리더만 정상종료
  hang)          exec sleep 300 ;;                                                                  # 출력 없이 행
esac
exit 0
EOF
chmod +x "$TMP/bin/claude"

run_case() {  # run_case <FAKE_MODE> <out> <timeout> ; echoes rc on stdout, captures combined output to $LASTOUT
  local mode="$1" out="$2" to="$3"
  LASTOUT="$( ( export PATH="$TMP/bin:$PATH" FAKE_MODE="$mode" FAKE_OUT="$out" FAKE_GPID="${FAKE_GPID:-$TMP/gc.pid}" \
                       HARNESS_GEN_TIMEOUT="$to" HARNESS_GEN_POLL=1 HARNESS_GEN_HEARTBEAT=0
                source "$ROOT/scripts/lib/common.sh"
                run_llm claude "테스트 프롬프트" "$out" ) 2>&1 )"
  return $?
}

# (A) 완료감지: 산출물이 나오면 좀비 자식을 기다리지 않고 조기 복귀(rc=0).
OUTA="$TMP/a.html"; rm -f "$OUTA"; T0=$SECONDS
run_case complete "$OUTA" 30; RCA=$?; ELA=$((SECONDS - T0))
check "(A) 완료감지 → run_llm 정상복귀(rc=0)" "[ $RCA -eq 0 ]"
check "(A) 좀비 대기 안 함 — 상한(30s) 훨씬 전 복귀(<12s)" "[ $ELA -lt 12 ]"
check "(A) 산출물 존재" "[ -f \"$OUTA\" ]"

# (B) 하드 상한: 출력 없이 행 → 상한 경과 후 die(rc≠0) + 친절 메시지 + 미완성 산출물 미생성.
OUTB="$TMP/b.html"; rm -f "$OUTB"; T0=$SECONDS
run_case hang "$OUTB" 2; RCB=$?; ELB=$((SECONDS - T0))
check "(B) 상한 초과 → die(rc≠0)" "[ $RCB -ne 0 ]"
check "(B) 상한 메시지('상한' 포함)" "echo \"\$LASTOUT\" | grep -q '상한'"
check "(B) 상한 부근에서 종료(무한대기 아님, <15s)" "[ $ELB -lt 15 ]"
check "(B) 미완성 산출물 미생성" "[ ! -f \"$OUTB\" ]"

# (C) 정상 종료: 출력 후 스스로 exit 0 → run_llm rc=0.
OUTC="$TMP/c.html"; rm -f "$OUTC"
run_case complete_exit "$OUTC" 30; RCC=$?
check "(C) 자식 정상종료 + 산출물 → rc=0" "[ $RCC -eq 0 ] && [ -f \"$OUTC\" ]"

# (E) 손자(grandchild) 그룹 회수: 출력 후 자식이 또 자식(손자)을 띄우고 둘 다 미종료 → setsid 그룹킬로 손자까지 회수.
OUTE="$TMP/e.html"; GCPID="$TMP/gc.pid"; rm -f "$OUTE" "$GCPID"
FAKE_GPID="$GCPID" run_case complete_gc "$OUTE" 30; RCE=$?
sleep 2   # 리더 종료 후 손자(reparent)가 init 에 회수될 짧은 여유
GP="$(cat "$GCPID" 2>/dev/null || echo)"
check "(E) 손자 생성됨(pid 기록)" "[ -n \"$GP\" ]"
check "(E) run_llm 완료감지 복귀(rc=0)" "[ $RCE -eq 0 ]"
check "(E) 손자 프로세스까지 그룹킬로 회수됨" "[ -n \"$GP\" ] && ! kill -0 \"$GP\" 2>/dev/null"
[ -n "$GP" ] && kill -9 "$GP" 2>/dev/null || true

# (F) 자연종료 후 고아 손자 회수(H6): 리더가 스스로 exit 해도 남은 손자를 그룹 회수해야 lock 해제 후 쓰기 누수가 없다.
OUTF="$TMP/f.html"; GCPIDF="$TMP/gcf.pid"; rm -f "$OUTF" "$GCPIDF"
FAKE_GPID="$GCPIDF" run_case fork_exit "$OUTF" 30; RCF=$?
sleep 2
GPF="$(cat "$GCPIDF" 2>/dev/null || echo)"
check "(F) 리더 자연종료 + 산출물 → rc=0" "[ $RCF -eq 0 ] && [ -f \"$OUTF\" ]"
check "(F) 자연종료 분기도 고아 손자 그룹 회수" "[ -n \"$GPF\" ] && ! kill -0 \"$GPF\" 2>/dev/null"
[ -n "$GPF" ] && kill -9 "$GPF" 2>/dev/null || true

# (D) kill_proc_tree: 살아있는 프로세스 트리를 실제로 종료한다(좀비 누수 방지의 코어).
sleep 300 & KP=$!; disown "$KP" 2>/dev/null || true   # disown: 종료 시 셸 job 알림('Terminated') 억제
( source "$ROOT/scripts/lib/common.sh"; kill_proc_tree "$KP" TERM; sleep 1; kill_proc_tree "$KP" KILL ) 2>/dev/null
sleep 1
check "(D) kill_proc_tree → 대상 프로세스 종료됨" "! kill -0 $KP 2>/dev/null"
kill -9 "$KP" 2>/dev/null || true

printf '\n[gen-timeout] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
