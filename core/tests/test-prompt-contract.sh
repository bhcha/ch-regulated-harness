#!/usr/bin/env bash
# test-prompt-contract.sh — WS-PROMPTS: 프롬프트 ICM 계약 헤더의 Inputs 가 build_context 방출 라벨과 일치하는지.
#   build_context(common.sh) 가 방출하는 라벨 어휘를 '소스에서' 추출 → 각 프롬프트 '**Inputs**' 줄의
#   대문자 토큰이 전부 그 어휘에 속하는지 검증(프롬프트가 실 LLM 에게 잘못된 입력 경계를 가르치는 드리프트 차단).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## WS-PROMPTS — 프롬프트 Inputs ⊆ build_context 라벨"

# build_context.py(K-3① 이관 후 라벨 방출 위치)에서 방출 라벨 어휘 추출(코드 변경에 자동 동기화)
KNOWN="$(grep -oE 'print\("[A-Z][A-Z_]+' "$ROOT/scripts/lib/build_context.py" | sed 's/print("//' | sort -u)"
check "build_context 라벨 어휘 추출됨(비어있지 않음)" "[ -n \"$KNOWN\" ]"

PROMPTS="brief concept storyboard-outline storyboard-plan keyvisual guideline evidence"
for p in $PROMPTS; do
  f="$ROOT/prompts/$p.md"
  line="$(grep -m1 -F '**Inputs**' "$f" 2>/dev/null || true)"
  if [ -z "$line" ]; then fail "($p) ICM '**Inputs**' 헤더 존재"; continue; fi
  pass "($p) ICM '**Inputs**' 헤더 존재"
  toks="$(printf '%s' "$line" | grep -oE '[A-Z][A-Z_]{2,}')"
  check "($p) Inputs 줄에 라벨 토큰 존재(빈 줄 거짓통과 방지)" "[ -n \"$toks\" ]"
  bad=""
  for tok in $toks; do
    printf '%s\n' "$KNOWN" | grep -qx "$tok" || bad="$bad $tok"
  done
  check "($p) Inputs 토큰 전부 build_context 라벨" "[ -z \"$bad\" ]"
  [ -n "$bad" ] && echo "      ✗ 알 수 없는 토큰:$bad  (허용:$(echo $KNOWN))"
done

# M6(G8) 양방향 단언: 키비주얼은 상위 종합 입력(STORYBOARD_PLAN·REFERENCE_IMAGES)을 '반드시' Inputs 에 선언해야 한다.
#   단방향(Inputs ⊆ KNOWN)만으론 build_context 에 라벨을 추가하고 keyvisual.md 동기화를 빠뜨려도 미탐 → 필수 포함을 별도 단언.
#   G6: DELIVERABLE_FORMAT 도 필수 — 키비주얼 레이아웃이 포맷별(BM 860 세로 / one_pager 1매)로
#   분기하려면 프롬프트가 포맷 라벨을 입력 경계로 받아야 한다(BM-860 하드코딩 회귀 차단).
# 파일을 '직접' grep 한다(Inputs 줄을 변수로 캡처해 eval 에 넘기면 줄 안의 백틱 `build_context` 가 실행됨 — Codex 단계5 Low).
for req in STORYBOARD_PLAN REFERENCE_IMAGES STORYLINE DELIVERABLE_FORMAT; do
  check "(keyvisual) Inputs 에 $req 필수 포함(누적 종합 입력 — M6 / 포맷 분기 — G6)" \
    "grep -m1 -F '**Inputs**' '$ROOT/prompts/keyvisual.md' | grep -q '$req'"
done
# G6: Inputs 토큰만으론 본문이 BM-860 단일로 회귀해도 미탐 → 본문이 '포맷별 레이아웃 분기'를 담는지 직접 단언
#   (one_pager 분기 마커). BM-860 하드코딩 회귀 시 이 마커가 사라져 fail.
check "(keyvisual) 본문에 포맷별 레이아웃 분기(포맷별 레이아웃·BM 860·one_pager) 존재" \
  "grep -q '포맷별 레이아웃' '$ROOT/prompts/keyvisual.md' && grep -q '860' '$ROOT/prompts/keyvisual.md' && grep -q 'one_pager' '$ROOT/prompts/keyvisual.md'"
# storyboard-plan 도 STORYLINE 을 명시 입력으로 받는다(확정 스토리라인 블록별 기획).
check "(storyboard-plan) Inputs 에 STORYLINE 필수 포함(M6)" \
  "grep -m1 -F '**Inputs**' '$ROOT/prompts/storyboard-plan.md' | grep -q 'STORYLINE'"

printf '\n[prompt-contract] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
