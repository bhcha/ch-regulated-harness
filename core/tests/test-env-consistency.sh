#!/usr/bin/env bash
# test-env-consistency.sh — D-2(maintainability 6장): env 노브 최소 정합 기계화.
#   목적: .env.example 의 모든 env 변수가 AGENTS.md 2번 절(환경변수 규약)에 문서화돼 있는지 검사한다
#     → 미문서 env 노브가 .env.example 로 shipping 되거나, AGENTS 에서 변수명이 바뀌었는데 .env.example 이
#       따라오지 못한 드리프트를 자동 포착한다(S4 "전부 사람 기억"의 부분 기계화).
#   ⚠ 역방향(AGENTS 문서 → .env.example 에 존재)은 검사하지 않는다: 대부분 HARNESS_* 튜닝 노브는 코드가
#     안전 기본값을 주입하므로(예 HARNESS_GEN_TIMEOUT=600·HARNESS_CLAUDE_FLAGS) .env.example 에 둘 필요가 없다.
#     .env.example 은 사용자가 '반드시 제공'해야 하는 크레덴셜·엔드포인트만 담는다 → 문서→example 강제는 false-positive.
#   결정적·오프라인(파일 텍스트 검사만, 네트워크·상태 없음).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## D-2 — env 노브 정합(.env.example ⊆ AGENTS 2번 절 문서화)"

ENV_EXAMPLE="$ROOT/../.env.example"   # ROOT=core → .env.example 은 레포 루트(형제)
AGENTS="$ROOT/AGENTS.md"              # 운영 SSoT(2번 절 = 환경변수 규약)

check "D-2: .env.example 존재" "[ -f \"$ENV_EXAMPLE\" ]"
check "D-2: AGENTS.md 존재" "[ -f \"$AGENTS\" ]"

# AGENTS 2번 절(환경변수 규약) 텍스트만 추출 — 다른 절의 우연한 언급으로 통과하지 않게 범위를 한정한다.
SECTION="$(awk '/^## 2\. 환경변수/{f=1} /^## 3\./{f=0} f' "$AGENTS")"
check "D-2: AGENTS 2번 절(환경변수 규약) 추출" "[ -n \"\$(awk '/^## 2\\. 환경변수/{f=1} /^## 3\\./{f=0} f' \"$AGENTS\")\" ]"

# .env.example 의 env 변수명 전수(대문자로 시작, '=' 앞. 주석/빈 줄 무시).
VARS="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$ENV_EXAMPLE" | sed 's/=$//' | sort -u)"
NVARS="$(printf '%s\n' "$VARS" | grep -c . || true)"
check "D-2: .env.example 에서 env 변수 추출(>0)" "[ \"$NVARS\" -gt 0 ]"

# 각 변수가 2번 절에 '문서화'(문자열 등장)됐는지 검사. 미문서 = 드리프트(fail-closed).
MISSING=""
while IFS= read -r v; do
  [ -z "$v" ] && continue
  printf '%s' "$SECTION" | grep -qF -- "$v" || MISSING="$MISSING $v"
done <<EOF
$VARS
EOF
if [ -z "$MISSING" ]; then
  pass "D-2: .env.example 모든 env 변수(${NVARS}건)가 AGENTS 2번 절에 문서화됨"
else
  fail "D-2: AGENTS 2번 절에 미문서인 .env.example 변수(문서화하거나 변수명 정정):$MISSING"
fi

printf '\n[env-consistency] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
