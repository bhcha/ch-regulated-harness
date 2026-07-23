#!/usr/bin/env bash
# hang-critic.sh — 테스트 전용 '무한 행' 크리틱 모사(개선2 watchdog 검증).
#   인자(프롬프트)를 무시하고 오래 잠든다 → kcia-check 의 obs_watch_pid 상한(KCIA_CRITIC_TIMEOUT)이 트리kill 하는지 검증.
#   ⚠ bare `sleep 999` 는 프롬프트 인자를 받으면 즉시 실패(usage)라 부적합. 또 self-grading 메타문자 가드 때문에
#     `sh -c 'sleep 999'`(따옴표) 도 못 쓴다 → 메타문자 없는 '경로' 크리틱으로 이 스크립트를 가리킨다.
exec sleep 999
