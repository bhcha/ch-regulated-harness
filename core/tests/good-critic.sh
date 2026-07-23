#!/usr/bin/env bash
# good-critic.sh — 테스트용 '정상 크리틱'. 프롬프트(인자)에서 .passa 출력 경로를 찾아 유효 verdict(빈 위반)를 쓰고 rc 0.
#   개선3 ok 경로 검증용: 유효 $PASSA → CRITIC_OUTCOME=ok → critic_ran=true · review_depth=rule_engine+critic.
#   메타문자 없는 '경로' 크리틱이라 self-grading 메타문자 가드를 통과하고, 'claude'/'codex' 미포함이라 격리 가드도 통과.
out="$(printf '%s\n' "$@" | grep -oE "/[^ '\"]+\.passa" | head -1)"
[ -n "$out" ] && printf '%s' '{"verdict":"pass","engine":"subagent","confidence":0.9,"violations":[],"escalate":false}' > "$out"
exit 0
