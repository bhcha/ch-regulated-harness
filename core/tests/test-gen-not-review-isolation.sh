#!/usr/bin/env bash
# test-gen-not-review-isolation.sh — 생성≠심의 격리 불변식(AGENTS.md 1-4) — 개편 후 계약.
#   개편: 운영 심의 = 원격 ADK(adk-http) 단일(다른 벤더 Gemini·원격 세션). 로컬 헤드리스 크리틱
#         (claude -p/codex exec)·KCIA_CRITIC_CMD·self-grading substring 가드는 폐기됐다 — 같은 스레드
#         자가비판이 구조적으로 불가능하므로(다른 벤더 원격) 불필요. 격리는 '벤더 분리 + 작업영역-밖 scratch'로 충족.
#   따라서 이 가드의 새 계약은 '폐기된 로컬 critic 엔진을 거부'다:
#     (1) KCIA_CRITIC_ENGINE=codex|claude-subagent → die(화이트리스트: 비움/adk-http 만).
#     (2) 임의 미지원 값(gpt 등) → die.
#     (3) 차단은 verdict 작성 전(누수 없음).
#     (4) 비움(미설정) → 허용(도메인 resolve 로 결정). offline 이면 룰엔진-단독으로 정상 완료.
#   ⚠ 옛 same-CLI/래퍼/eval 우회 단정(self-grading substring 가드 의존)은 가드 폐기로 obsolete → 제거.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 생성≠심의 격리 — 원격 ADK 단일(로컬 헤드리스 크리틱 폐기)"

cleanup() { rm -rf "$ROOT/runs/ci-gnr" "$ROOT/runs/ci-gnr-s1" "$ROOT/runs/ci-gnr-s2"; }
trap cleanup EXIT

# brief 생성(엔진=claude, history 에 generate 토큰 기록) → 승인 → review 게이트(가드 발동 지점).
#   HARNESS_OFFLINE 은 lib.sh 기본=1(stub 생성, 엔진 라벨=claude). review 게이트 진입 후 KCIA_CRITIC_ENGINE 검증이 돈다.
seed_review() {  # seed_review <rid>
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && HARNESS_CLI=claude bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" \
      && HARNESS_CLI=claude bash scripts/run-stage.sh brief "$rid" \
      && bash scripts/approve.sh "$rid" --ra-ok ) >/dev/null 2>&1
}

RID=ci-gnr
seed_review "$RID"
check "전제: brief 생성 → 승인 → review 게이트 도달" "[ \"$(jq_phase "$RID" gate)\" = 'review' ]"
VP="$ROOT/runs/$RID/01-brief/brief-verdict.json"
check "전제: 아직 verdict 미생성(클린 시작)" "[ ! -f \"$VP\" ]"

# (1) 폐기된 로컬 critic 엔진 명시 → die(화이트리스트). verdict 작성 전 차단.
for badeng in codex claude-subagent; do
  OUT="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE KCIA_CRITIC_ENGINE="$badeng" bash scripts/kcia-check.sh "$RID" ) 2>&1 )"; RC=$?
  check "(1/$badeng) 폐기 로컬 critic 엔진 → die(adk-http/미설정만)" "[ $RC -ne 0 ] && echo \"$OUT\" | grep -q 'KCIA_CRITIC_ENGINE'"
  check "(1/$badeng) 차단은 verdict 작성 전 — 누수 없음" "[ ! -f \"$VP\" ]"
done

# (2) 임의 미지원 KCIA_CRITIC_ENGINE 값 → die.
OUT2="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE KCIA_CRITIC_ENGINE=gpt bash scripts/kcia-check.sh "$RID" ) 2>&1 )"; RC2=$?
check "(2) 미지원 KCIA_CRITIC_ENGINE 값(gpt) → die(화이트리스트)" "[ $RC2 -ne 0 ] && echo \"$OUT2\" | grep -q 'KCIA_CRITIC_ENGINE'"
check "(2) 차단은 verdict 작성 전 — 누수 없음" "[ ! -f \"$VP\" ]"

# (3) 비움(미설정) — 화이트리스트 통과. offline(lib.sh 기본) 이라 룰엔진-단독으로 정상 완료(crit 미실행).
#     critic 엔진이 충돌하지 않음을 '실제 심의 경로가 돌았다'(심의 완료 마커)로 확인.
seed_review ci-gnr-s1
OUT3="$( ( cd "$ROOT" && bash scripts/kcia-check.sh ci-gnr-s1 ) 2>&1 )"; RC3=$?
check "(3) KCIA_CRITIC_ENGINE 비움 → 허용(rc=0, 차단 안 함)" "[ $RC3 -eq 0 ]"
check "(3) 실제 심의 경로 실행됨(심의 완료, 재심의 생략 아님)" "echo \"$OUT3\" | grep -q '심의 완료' && ! echo \"$OUT3\" | grep -q '재심의 생략'"
check "(3) 통과 시 verdict.json 생성" "[ -f \"$ROOT/runs/ci-gnr-s1/01-brief/brief-verdict.json\" ]"

# (4) KCIA_CRITIC_ENGINE=adk-http 명시 — 화이트리스트 통과. offline 이라 resolve 건너뛰고 룰엔진-단독 정상 완료.
seed_review ci-gnr-s2
OUT4="$( ( cd "$ROOT" && KCIA_CRITIC_ENGINE=adk-http bash scripts/kcia-check.sh ci-gnr-s2 ) 2>&1 )"; RC4=$?
check "(4) KCIA_CRITIC_ENGINE=adk-http 명시 → 허용(rc=0)" "[ $RC4 -eq 0 ] && echo \"$OUT4\" | grep -q '심의 완료'"

printf '\n[gen-not-review-isolation] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
