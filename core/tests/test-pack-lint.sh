#!/usr/bin/env bash
# test-pack-lint.sh — 0단계 F 회귀 가드: 팩 무결성 린트(scripts/pack-lint.sh / lib/pack_lint.py).
#   registry.json:32 의 packs/*/ruleset.json → ruleset.schema.json 매핑을 '실제로 검증하는 첫 테스트'.
#   (A) 실제 4팩(cosmetic·drug·quasi_drug·health_food) → 전부 통과(green).
#   (B) 손상 팩(status enum 밖·domain 불일치·필수키 누락·비-dict·JSON 깨짐·ruleset 스키마 위반·
#       active 인데 ruleset 부재) → pack-lint 가 nonzero 로 잡아낸다(임시 PACKS_DIR, test-drug-golden:351-364 패턴).
#   (C) 양성 대조: 임시 PACKS_DIR 의 유효 팩 → 통과(임시-디렉터리 기전이 구조상 false-fail 이 아님을 증명).
#   결정적(offline·no-LLM). 바이트 무영향: 팩 파일은 읽기만(검증), 파이프라인 코드 무수정.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 0단계 F — 팩 무결성 린트 회귀 가드(pack-lint)"

LINT="$ROOT/scripts/pack-lint.sh"

# ── (A) 실제 4팩 전부 통과 ──
A_OUT="$(bash "$LINT" 2>&1)"; A_RC=$?
[ "$A_RC" -eq 0 ] && pass "(A) 실제 packs 전체 통과(rc=0)" \
  || fail "(A) 실제 packs 린트 실패(rc=$A_RC):
$A_OUT"
for d in cosmetic drug quasi_drug health_food; do
  printf '%s' "$A_OUT" | grep -qE "^\[$d\] OK$" \
    && pass "(A) $d 팩 OK 보고" \
    || fail "(A) $d 팩 OK 미보고:
$A_OUT"
done

# ── (C) 양성 대조: 임시 PACKS_DIR 의 유효 active 팩(실제 cosmetic ruleset 복사) → 통과 ──
CTL="$(mktemp -d "${TMPDIR:-/tmp}/packlint-ctl.XXXXXX")"
mkdir -p "$CTL/cosmetic"
printf '{"domain":"cosmetic","status":"active","default":true}' > "$CTL/cosmetic/domain.json"
cp "$PACKS_DIR/cosmetic/ruleset.json" "$CTL/cosmetic/ruleset.json"
C_OUT="$(PACKS_DIR="$CTL" bash "$LINT" 2>&1)"; C_RC=$?
[ "$C_RC" -eq 0 ] && pass "(C) 양성대조 유효 임시 팩 → 통과(rc=0)" \
  || fail "(C) 양성대조 유효 임시 팩이 실패(임시 PACKS_DIR 기전 오류?rc=$C_RC):
$C_OUT"
rm -rf "$CTL"

# ── (C2) 양성 대조: adk_critic.retry 유효 정수(O-2 선택 키) → 통과 ──
CTL2="$(mktemp -d "${TMPDIR:-/tmp}/packlint-ctl2.XXXXXX")"
mkdir -p "$CTL2/cosmetic"
printf '{"domain":"cosmetic","status":"active","default":true,"adk_critic":{"url_env":"X","host_env":"Y","app":"a","author":"b","retry":10,"author_aliases":["guideline_review_agent"]}}' > "$CTL2/cosmetic/domain.json"
cp "$PACKS_DIR/cosmetic/ruleset.json" "$CTL2/cosmetic/ruleset.json"
C2_OUT="$(PACKS_DIR="$CTL2" bash "$LINT" 2>&1)"; C2_RC=$?
[ "$C2_RC" -eq 0 ] && pass "(C) adk_critic.retry(10)+author_aliases(배열) 유효 → 통과" \
  || fail "(C) adk_critic.retry 유효 정수인데 실패(rc=$C2_RC):
$C2_OUT"
rm -rf "$CTL2"

# ── (B) 손상 팩 → nonzero (각 케이스 독립 임시 PACKS_DIR) ──
neg_case() {  # neg_case <label> <dirname> <domain.json 내용> [ruleset.json 내용|생략]
  local label="$1" dname="$2" dj="$3"
  local has_rs=0 rs=""
  if [ "$#" -ge 4 ]; then has_rs=1; rs="$4"; fi
  local td; td="$(mktemp -d "${TMPDIR:-/tmp}/packlint.XXXXXX")"
  mkdir -p "$td/$dname"
  printf '%s' "$dj" > "$td/$dname/domain.json"
  [ "$has_rs" -eq 1 ] && printf '%s' "$rs" > "$td/$dname/ruleset.json"
  local out rc
  out="$(PACKS_DIR="$td" bash "$LINT" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "(B) 손상 탐지: $label (rc=$rc)"
  else
    fail "(B) 손상 미탐지: $label — pack-lint 가 통과시킴:
$out"
  fi
  rm -rf "$td"
}

neg_case "status enum 밖('foo')"        drug   '{"domain":"drug","status":"foo"}'
neg_case "status 대소문자('ACTIVE')"    drug   '{"domain":"drug","status":"ACTIVE"}'
neg_case "필수키 domain 누락"           drug   '{"status":"tbd"}'
neg_case "status 누락"                  drug   '{"domain":"drug"}'
neg_case "domain≠디렉터리명"            drug   '{"domain":"cosmetic","status":"tbd"}'
neg_case "최상위 비-dict(pair-list)"    drug   '[["domain","drug"],["status","tbd"]]'
neg_case "JSON 파싱 깨짐"               drug   '{ broken'
neg_case "status=active 인데 ruleset 부재" cosmetic '{"domain":"cosmetic","status":"active"}'
neg_case "ruleset 스키마 위반(필수키 누락)" cosmetic '{"domain":"cosmetic","status":"active"}' '{}'
neg_case "adk_critic.retry 문자열('8')"   drug '{"domain":"drug","status":"tbd","adk_critic":{"retry":"8"}}'
neg_case "adk_critic.retry 음수(-1)"      drug '{"domain":"drug","status":"tbd","adk_critic":{"retry":-1}}'
neg_case "adk_critic.retry 불리언(true)"   drug '{"domain":"drug","status":"tbd","adk_critic":{"retry":true}}'
neg_case "adk_critic.author_aliases 비배열(문자열)" drug '{"domain":"drug","status":"tbd","adk_critic":{"author_aliases":"guideline_review_agent"}}'
neg_case "adk_critic.author_aliases 빈문자열 원소"   drug '{"domain":"drug","status":"tbd","adk_critic":{"author_aliases":["ok",""]}}'

printf '\n[pack-lint] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
