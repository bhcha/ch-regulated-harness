#!/usr/bin/env bash
# run-ci.sh — 결정적(no-LLM) CI 머지 게이트. 페이즈별 테스트를 순차 실행.
#   스키마·이식성(a1)·재개·동시성·loop guard·골든셋(최소셋)·추출 정확도.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# A5: 운영 env(harness-env.sh) source 누수로 결정적 CI 오염 → 진입 방어. 누수 변수는 unset 하고
#   stub 게이트(HARNESS_OFFLINE)는 1로 강제(lib.sh 가 미설정 시 1로 재기본하지만, 누수로 0이 깔린 경우까지 결정적 오프라인 보장).
#   각 테스트는 sourcing/호출 시 필요한 값을 스스로 세팅한다(lib.sh 상단 + 각 호출부 inline/env -u).
#   심의(critic) env 도 스크럽한다: KCIA_CRITIC_ENGINE 은 kcia-check.sh 가 '오프라인 분기 전' 무조건 화이트리스트
#   검증하므로(폐기된 codex/claude-subagent 가 누수되면 offline CI 도 die), KCIA_CRITIC_REQUIRED 누수는 온라인 서브케이스의
#   강등 동작을 비결정화한다 → 둘 다 unset(+ 폐기된 KCIA_CRITIC_CMD 도 방어적으로). 각 테스트가 필요 시 자체 설정한다.
#   골든 재캡처 스위치(GOLDEN_RECAPTURE)도 unset: dev 셸에서 export 된 채 새면 test-prompt-assembly 가 비교(머지 게이트)
#   대신 골든 덮어쓰기 모드로 전환된다 → 머지 게이트에서 절대 금지(결정적 비교 보장).
unset HARNESS_WB HARNESS_EXAMPLES_DIR HARNESS_CLI HARNESS_GEN_MODE HARNESS_IMAGE_CLI HARNESS_EVIDENCE_CLI \
      KCIA_CRITIC_ENGINE KCIA_CRITIC_REQUIRED KCIA_CRITIC_CMD \
      HARNESS_EVIDENCE_DIR HARNESS_EVIDENCE_MAX_FILE_BYTES HARNESS_EVIDENCE_MAX_TOTAL_BYTES \
      GOLDEN_RECAPTURE
export HARNESS_OFFLINE=1

# A5: 동시 실행 가드(단일 실행 lock). macOS 기본엔 flock 이 없어 mkdir 원자성으로 lock 한다.
#   두 번째 run-ci.sh 가 runs/ci-* 를 클로버하지 못하게 막는다. lock 은 작업영역 밖 고정 경로.
LOCK="${TMPDIR:-/tmp}/ch-harness-runci.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # 죽은(stale) lock 회수: 직전 실행이 강제 종료돼 lock 만 남았는지 PID 로 판별.
  stale_pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$stale_pid" ] && ! kill -0 "$stale_pid" 2>/dev/null; then
    rm -rf "$LOCK" 2>/dev/null || true  # 점유 프로세스가 죽었으면 회수(pid 파일 포함이라 rmdir 아님)
    if ! mkdir "$LOCK" 2>/dev/null; then
      echo "다른 CI 가 이미 실행 중입니다(동시 실행 금지) — 끝나면 다시 시도하세요. (lock: $LOCK)"; exit 1
    fi
  else
    echo "다른 CI 가 이미 실행 중입니다(동시 실행 금지) — 끝나면 다시 시도하세요. (lock: $LOCK)"; exit 1
  fi
fi
echo $$ > "$LOCK/pid"
trap 'rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK" 2>/dev/null || true' EXIT

TESTS=(tests/test-b0.sh tests/test-b1.sh tests/test-b1g.sh tests/test-b1e.sh tests/test-b8.sh tests/test-b2.sh tests/test-b3.sh tests/test-drug-golden.sh tests/test-gen-not-review-isolation.sh tests/test-verdict-binding.sh tests/test-insession-genmode.sh tests/test-trace-verdict-id.sh tests/test-prompt-contract.sh tests/test-gates.sh tests/test-critic-fanout.sh tests/test-routes.sh tests/test-gen-timeout.sh tests/test-b4.sh tests/test-b5.sh tests/test-render-existence-depth.sh tests/test-render-mode-gate.sh tests/test-components.sh tests/test-b9.sh tests/test-b7.sh tests/test-operator-language.sh tests/test-observability.sh tests/test-image-engine.sh tests/test-relief-facts.sh tests/test-clinical-engine.sh tests/test-clinical-chart.sh tests/test-completeness-advisory.sh tests/test-gen-image-completeness.sh tests/test-core-domain-leak.sh tests/test-evidence-attachment.sh tests/test-evidence-reflection.sh tests/test-intake.sh tests/test-pack-lint.sh tests/test-schema-lint.sh tests/test-agui-contracts.sh tests/test-agui-projection.sh tests/test-a2ui-action.sh tests/test-a2ui-surface.sh tests/test-openalex.sh tests/test-env-consistency.sh tests/test-docs-integrity.sh tests/pack-conformance.sh tests/test-drug-stub-golden.sh tests/test-prompt-assembly.sh tests/test-multiproduct-extraction.sh tests/test-examples-analysis.sh tests/test-intake-enrich.sh tests/test-runmd-intake.sh tests/test-form-factor.sh tests/test-ocr-compliance.sh tests/test-asset-role.sh tests/test-image-rebake.sh tests/test-hook-deny.sh)
rc=0
for t in "${TESTS[@]}"; do
  # 목록에 있으나 파일이 없으면 '조용한 스킵' 금지 → 하드 실패(머지 게이트 무결성).
  if [ ! -f "$t" ]; then echo "✗ 누락된 테스트: $t (TESTS 목록에 있으나 파일 없음)"; rc=1; continue; fi
  bash "$t" || rc=1
  echo
done
if [ "$rc" -eq 0 ]; then echo "==== CI: 전체 통과 ✓ ===="; else echo "==== CI: 실패 ✗ ===="; fi
exit $rc
