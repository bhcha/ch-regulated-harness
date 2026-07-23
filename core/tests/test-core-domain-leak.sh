#!/usr/bin/env bash
# test-core-domain-leak.sh — 팩 분리 리팩토링(0단계) 측정 도구.
#   목표: core/(커널)는 규제도메인·브랜드 어휘를 하나도 몰라야 한다(도메인 지식 = packs 소유).
#   이 테스트는 core/ 에서 화장품 도메인 어휘·브랜드/제품 실명을 grep 해, 아직 결합이 남은
#   파일(allowlist)을 '동결'하고 그 밖에서 **새 누출**이 생기면 fail 한다.
#
#   운용: 리팩토링 각 단계가 도메인 지식을 packs 로 옮길 때마다 그 파일을 아래 ALLOW 에서 제거한다.
#   9단계 마무리에 ALLOW 가 비면(0) core 는 도메인-중립이 된 것 = 1차 완료 판정 4번(DoD).
#   근거·계획: docs/plans/ops-and-pack-refactor-plan.md 2부(0단계·9단계·부록A). 값 이동만 하고 내용은 안 바꾼다(공통원칙 1).
#
#   범위: core/{scripts,prompts,harness} 만 본다(docs·tests·runs·inputs·fixtures 제외 — 그건 사람용 문서·
#   시드·산출물이라 도메인 어휘가 정당하다). 블록명(hero/cta 등 구조 토큰) 검출은 캐논 단일화(4단계) 뒤
#   allowlist 확장으로 추가한다(지금은 브랜드+도메인어휘의 명백한 누출만 — 그래야 green-now 로 시작 가능).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }

echo "## core 도메인 어휘 누출 검사 (팩 분리 0단계 — allowlist 점감→0)"

# ── 검출 패턴 ────────────────────────────────────────────────────────────────
# 브랜드/제품 실명(도메인-불문 누출) + 화장품 도메인 어휘. core 는 이 중 무엇도 알면 안 된다.
BRAND_RE='이지듀|이지덤|easydew|ezderm|EGF|대웅|daewoong|ursa|우루사|아누아|메디힐'
COSMETIC_RE='미백|주름|자외선차단|기능성화장품|피지'
LEAK_RE="${BRAND_RE}|${COSMETIC_RE}"

# 스캔 대상 루트(커널 코드·프롬프트·계약 스키마 + 슬래시 스킬·파생 커맨드). H-6: ezderm/아누아/메디힐·skills/·.claude/commands/ 사각 보강.
#   .claude/commands 는 skills/ 에서 sync-skills 로 파생되지만 추적본이라 stale 누출 가능 → 파생본도 스캔(방어).
SCAN_DIRS=(scripts prompts harness skills .claude/commands)

# ── allowlist = 현재(0단계 시점) 결합이 남은 파일(리팩토링이 단계별로 비운다) ──
#   경로는 ROOT(core/) 기준 상대. 각 파일을 비우는 예정 단계(계획 3장):
#     prompts/*        → 5단계(도메인 조각 → packs/<도메인>/prompt-fragments, critic-fragment)
#     ingest.py        → 3단계(VOC/기능성/마커 상수 → ingest-profile)
#     kcia_engine.py   → 1·2단계(cosmetic 폴백·lexicon 상수 → 팩)
#     stub_stage.py    → 5단계(_is_cosmetic 카피·기능성 라벨 → stub-templates)
#     clinical_chart.py→ 2·4단계(지표 어휘)
#     operator_labels.py, operator-voice.md → 6단계(labels.json 오버레이)
#     image_engine.py  → 6단계(easydew 주석·이미지 프롬프트 골격 → 포맷 팩 조각)
#     run-stage.sh     → 5단계(인라인 히어독 죽은코드 제거)
#     build-fixtures.sh→ 0·8단계(도메인 파라미터화)
#     claim-basis.schema.json → 4단계(예시 어휘 일반화)
#   ※ 인라인 주석 금지(bash 배열 원소 뒤 '#'+괄호는 파싱 깨짐). 주석은 위 블록으로만.
# bash 3.2 호환(연관배열 미사용) — allowlist 는 개행-구분 문자열, 멤버십은 grep -qxF.
ALLOW="$(cat <<'EOF'
EOF
)"
ALLOW_N="$(printf '%s\n' "$ALLOW" | grep -c .)"

# ── 스캔: 패턴 매칭 파일 목록(개행-구분). 빌드 아티팩트(__pycache__/*.pyc)는 소스가 아니라 제외 ──
MATCHED="$(cd "$ROOT" && grep -rlE --exclude-dir=__pycache__ --exclude='*.pyc' "$LEAK_RE" "${SCAN_DIRS[@]}" 2>/dev/null | sort -u)"
MATCHED_N="$(printf '%s\n' "$MATCHED" | grep -c .)"

# ── 판정 1: allowlist 밖 새 누출 = fail ──
leaks="$(comm -23 <(printf '%s\n' "$MATCHED" | grep . | sort -u) <(printf '%s\n' "$ALLOW" | grep . | sort -u))"
leak_n="$(printf '%s\n' "$leaks" | grep -c .)"
if [ "$leak_n" -eq 0 ]; then
  pass "core 에 allowlist 밖 도메인/브랜드 어휘 누출 없음 (매칭 ${MATCHED_N}개 전부 동결 대상)"
else
  fail "core 에 새 도메인/브랜드 누출 ${leak_n}개 (allowlist 에 없음 — packs 로 옮기거나 의도면 allowlist 갱신):"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    printf '      %s: %s\n' "$l" "$(cd "$ROOT" && grep -hoE "$LEAK_RE" "$l" 2>/dev/null | sort -u | paste -sd',' -)"
  done <<< "$leaks"
fi

# ── 판정 2: allowlist 위생 — 이미 비워진(더는 매칭 안 되는) 항목이 남아있으면 fail(점감 추적) ──
stale="$(comm -23 <(printf '%s\n' "$ALLOW" | grep . | sort -u) <(printf '%s\n' "$MATCHED" | grep . | sort -u))"
stale_n="$(printf '%s\n' "$stale" | grep -c .)"
if [ "$stale_n" -eq 0 ]; then
  pass "allowlist 위생 — 모든 항목이 실제 결합 지점(사문 없음)"
else
  fail "allowlist 에 이미 정리된(매칭 0) 항목 ${stale_n}개 — 단계 완료 후 여기서 제거하세요(점감): $(printf '%s' "$stale" | paste -sd' ' -)"
fi

# ── 진행도 표면화(정보) ──
echo "  [진행도] core 결합 파일 = ${MATCHED_N}개 (1차 완료 목표 = 0). 현재 allowlist = ${ALLOW_N}개."

echo "core-domain-leak: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
