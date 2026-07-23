#!/usr/bin/env bash
# test-prompt-assembly.sh — 0단계 D: 프롬프트-조립 골든(stage 2/5 도메인 어휘 이전의 유일 안전망).
#   스냅샷 3종:
#     (a) stage별 --emit-context (brief·guideline·concept·storyboard-outline·storyboard-plan·keyvisual, cosmetic)
#     (b) prompts/*.md sha256 목록(8파일) — 프롬프트 본문 동결
#     (c) 원격 ADK Pass-A/B 조립 instruction(cosmetic·drug 각 2건) — 도메인 어휘/축/grounding 만 다름
#   이후 단계(2·5)가 도메인 어휘를 core→packs 로 옮겨도 이 스냅샷은 바이트 불변이어야 한다(= LLM/ADK 가 실제로 보는 것 불변).
#   생성 로직 단일 출처(gen_all): GOLDEN_RECAPTURE=1 이면 골든 재캡처(갱신), 아니면 재생성본을 골든과 바이트 비교(+2회 결정성).
#   프롬프트 수정 후 골든 재베이크는 GOLDEN_RECAPTURE=1 로 자동화한다 — 임시 폴더에 먼저 생성(fail-fast·전부-또는-무),
#     '무엇이 바뀌었는지' diff --stat 식으로 보여준 뒤 골든에 덮어쓴다(가드=비교 모드는 바이트 불변; 사람이 diff 를 검토해 프롬프트 변경과 같은 커밋에 포함).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## prompt-assembly golden (0단계 D)"

REPO="$(cd "$ROOT/.." && pwd)"                       # core 의 부모(=레포 루트) — HARNESS_ROOT 와 형제 packs/ 를 함께 덮는 정규화 기준
GOLDEN="$ROOT/tests/golden/prompt-assembly"
BUNDLE_COS="$ROOT/tests/fixtures/bundle-cosmetic"    # 합성 화장품 번들(hermetic)
COS_RS="$PACKS_DIR/cosmetic/ruleset.json"
DRUG_RS="$PACKS_DIR/drug/ruleset.json"
WB="$PACKS_DIR/cosmetic/golden/working-backwards.md"
HERM="$ROOT/tests/golden/_no-examples"; mkdir -p "$HERM"

# 고정 RID(결정성) + 고정 copy/candidate placeholder(도메인 어휘만 달라지게).
RID_BRIEF="pa-ctx-brief"; RID_GL="pa-ctx-guideline"; RID_CONCEPT="pa-ctx-concept"
RID_OUT="pa-ctx-sb-outline"; RID_PLAN="pa-ctx-sb-plan"; RID_KV="pa-ctx-keyvisual"
COPY_PH="FIXED_COPY_PLACEHOLDER"; CAND_PH="FIXED_CANDIDATE_PLACEHOLDER"

FILES="ctx-brief.txt ctx-guideline.txt ctx-concept.txt ctx-storyboard-outline.txt ctx-storyboard-plan.txt ctx-keyvisual.txt prompts.sha256 instr-cosmetic-passA.txt instr-cosmetic-passB.txt instr-drug-passA.txt instr-drug-passB.txt"

cleanup_runs() { rm -rf "$ROOT/runs/$RID_BRIEF" "$ROOT/runs/$RID_GL" "$ROOT/runs/$RID_CONCEPT" "$ROOT/runs/$RID_OUT" "$ROOT/runs/$RID_PLAN" "$ROOT/runs/$RID_KV"; }
trap 'cleanup_runs' EXIT

# _norm <rid|""> : stdin→stdout, 레포 루트 절대경로 → <REPO>, (rid 주어지면) run_id → <RID> (리터럴 치환).
_norm() { REPO="$REPO" NRID="$1" python3 -c '
import os, sys
t = sys.stdin.read()
t = t.replace(os.environ["REPO"], "<REPO>")
r = os.environ.get("NRID", "")
if r:
    t = t.replace(r, "<RID>")
sys.stdout.write(t)'; }

# gen_all <outdir> : 11개 스냅샷을 <outdir> 에 생성(regen·compare 공용 = 단일 진실). 오프라인 결정적.
gen_all() {
  local out="$1"; mkdir -p "$out"; cleanup_runs
  local EXROOT; EXROOT="$(mktemp -d)"

  # ── (a) stage별 --emit-context ──────────────────────────────────────
  # brief: 합성 번들 인입(hermetic examples → 사례 없음 → 01-brief 직행) 후 컨텍스트 방출.
  ( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      HARNESS_WB="$WB" HARNESS_EXAMPLES_DIR="$HERM" \
      bash scripts/ingest-bundle.sh "$BUNDLE_COS" "$RID_BRIEF" ) >/dev/null 2>&1
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh brief "$RID_BRIEF" --emit-context ) \
      | _norm "$RID_BRIEF" > "$out/ctx-brief.txt"

  # guideline: 사례corpus(번들 복사 = test-b1g 패턴) 를 HARNESS_EXAMPLES_DIR 로 → ingest 가 00g 로 라우팅.
  mkdir -p "$EXROOT/cosmetic"; cp -r "$BUNDLE_COS" "$EXROOT/cosmetic/ex1"
  ( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      HARNESS_WB="$WB" HARNESS_EXAMPLES_DIR="$EXROOT" \
      bash scripts/ingest-bundle.sh "$BUNDLE_COS" "$RID_GL" ) >/dev/null 2>&1
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh guideline "$RID_GL" --emit-context ) \
      | _norm "$RID_GL" > "$out/ctx-guideline.txt"

  # concept: 동결 핸드오프 픽스처 seed 후 방출.
  rm -rf "$ROOT/runs/$RID_CONCEPT"; cp -R "$PACKS_DIR/cosmetic/fixtures/concept-in" "$ROOT/runs/$RID_CONCEPT"
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh concept "$RID_CONCEPT" --emit-context ) \
      | _norm "$RID_CONCEPT" > "$out/ctx-concept.txt"

  # storyboard-outline: conti 픽스처(substage=outline) seed 후 방출.
  rm -rf "$ROOT/runs/$RID_OUT"; cp -R "$PACKS_DIR/cosmetic/fixtures/conti-in" "$ROOT/runs/$RID_OUT"
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh storyboard-outline "$RID_OUT" --emit-context ) \
      | _norm "$RID_OUT" > "$out/ctx-storyboard-outline.txt"

  # storyboard-plan: conti seed → outline 생성 → select A → 심의(오프라인 룰엔진) → plan 경계 도달 후 방출(STORYLINE 라벨 포함).
  rm -rf "$ROOT/runs/$RID_PLAN"; cp -R "$PACKS_DIR/cosmetic/fixtures/conti-in" "$ROOT/runs/$RID_PLAN"
  ( cd "$ROOT" && export HARNESS_CLI=stub HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$HERM" &&
      bash scripts/run-stage.sh storyboard-outline "$RID_PLAN" &&
      bash scripts/select.sh "$RID_PLAN" A &&
      bash scripts/kcia-check.sh "$RID_PLAN" ) >/dev/null 2>&1
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh storyboard-plan "$RID_PLAN" --emit-context ) \
      | _norm "$RID_PLAN" > "$out/ctx-storyboard-plan.txt"

  # keyvisual: 동결 핸드오프 픽스처 seed 후 방출(ART_DIRECTION·IMAGE_MANIFEST 포함).
  rm -rf "$ROOT/runs/$RID_KV"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$ROOT/runs/$RID_KV"
  ( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/run-stage.sh keyvisual "$RID_KV" --emit-context ) \
      | _norm "$RID_KV" > "$out/ctx-keyvisual.txt"

  # ── (b) prompts/*.md sha256(8파일, 파일명 정렬) ─────────────────────
  python3 - "$ROOT" > "$out/prompts.sha256" <<'PY'
import sys, os, hashlib, glob
root = sys.argv[1]
for f in sorted(glob.glob(os.path.join(root, "prompts", "*.md"))):
    h = hashlib.sha256(open(f, "rb").read()).hexdigest()
    print("%s  prompts/%s" % (h, os.path.basename(f)))
PY

  # ── (c) 원격 ADK Pass-A/B 조립 instruction(cosmetic·drug) — 고정 placeholder → 도메인 어휘/축/grounding 만 다름 ──
  #   emit-instruction 은 엔드포인트 resolve·네트워크 없이 순수 함수로 조립(온라인 심의와 동일 문자열).
  ( cd "$ROOT" && python3 scripts/lib/adk_critic.py emit-instruction --domain cosmetic --pass a --ruleset "$COS_RS"  --copy-text "$COPY_PH" ) | _norm "" > "$out/instr-cosmetic-passA.txt"
  ( cd "$ROOT" && python3 scripts/lib/adk_critic.py emit-instruction --domain cosmetic --pass b --ruleset "$COS_RS"  --candidate "$CAND_PH" ) | _norm "" > "$out/instr-cosmetic-passB.txt"
  ( cd "$ROOT" && python3 scripts/lib/adk_critic.py emit-instruction --domain drug     --pass a --ruleset "$DRUG_RS" --copy-text "$COPY_PH" ) | _norm "" > "$out/instr-drug-passA.txt"
  ( cd "$ROOT" && python3 scripts/lib/adk_critic.py emit-instruction --domain drug     --pass b --ruleset "$DRUG_RS" --candidate "$CAND_PH" ) | _norm "" > "$out/instr-drug-passB.txt"

  rm -rf "$EXROOT"; cleanup_runs
}

# ── RECAPTURE 모드(GOLDEN_RECAPTURE=1): 프롬프트 수정 후 골든 자동 재베이크(비교 대신 복사+요약) ──
#   REGEN 과 같은 gen_all(생성 로직 단일 출처)을 쓰되, 임시 폴더에 먼저 생성해 골든과 대조 → '무엇이 바뀌었는지'
#   요약(diff --stat 식)을 보여준 뒤 골든에 덮어쓴다. 가드(아래 비교 모드)는 손대지 않으므로 바이트 불변이다.
if [ "${GOLDEN_RECAPTURE:-0}" = "1" ]; then
  # (Fix 2) 인터럽트 안전망(EXIT/HUP/INT/TERM): RCAP 생성 '전'에 등록해 생성(gen_all)~검증~요약~스왑 전
  #   구간의 시그널에도 임시 폴더가 새지 않게 한다. 존재-가드 멱등 핸들러 — (i) GOLDEN 부재+퇴피본 존재 시
  #   원위치 복구 (ii) 교체 성공 직후(둘 다 존재)의 잔존 퇴피본 제거 (iii) 임시(RCAP/STAGE) 잔존 시 제거.
  #   핸들러는 set -e 시맨틱을 가정하지 않는다(전 단계 가드). 시그널은 핸들러 실행 후 종료 → EXIT 트랩과
  #   이중 실행돼도 가드 덕에 no-op(멱등). 성공 시 스왑 뒤에서 트랩 해제 + 상단 EXIT 트랩(cleanup_runs) 복원.
  OLD_GOLD=""   # 퇴피 경로는 스왑 직전에 확정 — 그 전 시그널에서 set -u 가 안 걸리게 빈 값으로 초기화
  recap_cleanup() {
    if [ -n "$OLD_GOLD" ] && [ ! -d "$GOLDEN" ] && [ -d "$OLD_GOLD" ]; then mv "$OLD_GOLD" "$GOLDEN" 2>/dev/null; fi
    if [ -n "$OLD_GOLD" ] && [ -d "$GOLDEN" ] && [ -d "$OLD_GOLD" ]; then rm -rf "$OLD_GOLD"; fi
    if [ -n "${RCAP:-}" ] && [ -d "$RCAP" ]; then rm -rf "$RCAP"; fi
    if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
    cleanup_runs
  }
  trap 'recap_cleanup' EXIT
  trap 'recap_cleanup; exit 130' HUP INT TERM
  RCAP="$(mktemp -d)"
  # (Fix 2) 생성 fail-fast: gen_all 을 set -e 서브셸로 돌려 중간 단계 실패 시 즉시 중단한다.
  #   그대로 두면 부분/빈 산출물이 골든을 덮어써 골든이 조용히 망가진다 → 실패는 골든 미변경으로 fail-closed.
  #   ⚠ 서브셸은 반드시 '평문'으로 실행한다 — `if ! ( … )`/`( … ) || …` 같은 종료코드-검사 문맥에선 bash 가
  #   내부 set -e 를 통째로 무력화한다(서브셸·함수 안까지 전파 = fail-fast 사망). 평문 실행 후 $? 로 분기
  #   (외부 셸은 lib.sh 의 set -uo pipefail 뿐 errexit 없음 → 비-0 이어도 여기서 스크립트가 죽지 않는다).
  ( set -e; gen_all "$RCAP" )
  gen_rc=$?
  if [ "$gen_rc" -ne 0 ]; then
    echo "  [재캡처 중단] 골든 생성 실패(중간 단계 오류, rc=$gen_rc) — 골든 미변경." >&2
    rm -rf "$RCAP"; exit 1
  fi
  # (Fix 2) 전부-또는-무(all-or-nothing): 복사 전 $FILES(11개 = 비교 모드 골든 목록과 동일 출처)가 전부
  #   존재+비어있지 않은지 단정. 하나라도 결손/빈파일이면 아무것도 복사하지 않고 중단(골든 무손상).
  cap_missing=""
  for f in $FILES; do
    [ -s "$RCAP/$f" ] || cap_missing="$cap_missing $f"
  done
  if [ -n "$cap_missing" ]; then
    echo "  [재캡처 중단] 생성 산출물 누락/빈파일:$cap_missing — 골든 미변경." >&2
    rm -rf "$RCAP"; exit 1
  fi
  echo "## prompt-assembly 골든 재캡처 (GOLDEN_RECAPTURE=1)"
  changed=0; added=0; same=0
  for f in $FILES; do
    if [ ! -f "$GOLDEN/$f" ]; then
      printf '  신규  %s\n' "$f"; added=$((added+1))
    elif diff -q "$GOLDEN/$f" "$RCAP/$f" >/dev/null 2>&1; then
      same=$((same+1))
    else
      plus="$(diff "$GOLDEN/$f" "$RCAP/$f" 2>/dev/null | grep -c '^>')"
      minus="$(diff "$GOLDEN/$f" "$RCAP/$f" 2>/dev/null | grep -c '^<')"
      printf '  변경  %s (+%s / -%s)\n' "$f" "$plus" "$minus"; changed=$((changed+1))
    fi
  done
  # (Fix 2) 스테이징 원자 교체(staged atomic swap): 골든 폴더에 파일을 하나씩 직접 cp 하지 않는다 —
  #   중간 cp 실패(디스크/권한)가 골든을 '반쯤 갱신' 상태로 남기고 exit 0 하는 것을 차단한다.
  #   같은 부모 폴더(같은 파일시스템 → mv 원자적)에 스테이징을 만들어 [현 골든 전체(11개 외 부수 파일 보존)
  #   + 신선한 11개 overlay]를 완성·재검증한 뒤 mv 로 통째 교체한다. 실패 시 골든 원본은 손대지 않거나 롤백.
  GOLD_PARENT="$(dirname "$GOLDEN")"
  OLD_GOLD="$GOLDEN.old.$$"   # 퇴피 경로 확정(핸들러는 위(RCAP 생성 전)에서 이미 등록 — 그간 빈 값 가드로 no-op)
  STAGE="$(mktemp -d "$GOLD_PARENT/.prompt-assembly-stage.XXXXXX")" \
    || { echo "  [재캡처 중단] 스테이징 폴더 생성 실패 — 골든 미변경." >&2; rm -rf "$RCAP"; exit 1; }
  if [ -d "$GOLDEN" ]; then
    cp -R "$GOLDEN/." "$STAGE/" \
      || { echo "  [재캡처 중단] 현 골든의 스테이징 복사 실패 — 골든 미변경." >&2; rm -rf "$RCAP" "$STAGE"; exit 1; }
  fi
  for f in $FILES; do
    cp "$RCAP/$f" "$STAGE/$f" \
      || { echo "  [재캡처 중단] 스테이징 복사 실패: $f — 골든 미변경." >&2; rm -rf "$RCAP" "$STAGE"; exit 1; }
  done
  for f in $FILES; do
    [ -s "$STAGE/$f" ] \
      || { echo "  [재캡처 중단] 스테이징 재검증 실패(누락/빈파일): $f — 골든 미변경." >&2; rm -rf "$RCAP" "$STAGE"; exit 1; }
  done
  if [ -d "$GOLDEN" ]; then
    mv "$GOLDEN" "$OLD_GOLD" \
      || { echo "  [재캡처 중단] 골든 퇴피(mv) 실패 — 골든 미변경." >&2; rm -rf "$RCAP" "$STAGE"; exit 1; }
  fi
  if ! mv "$STAGE" "$GOLDEN"; then
    # 롤백 mv 도 rc 를 검사한다 — 미검사 mv 로 '원상복구함'을 거짓 보고하지 않는다(실패 시 수동 복구 경로 안내).
    if [ -d "$OLD_GOLD" ]; then
      if mv "$OLD_GOLD" "$GOLDEN"; then
        echo "  [재캡처 중단] 골든 교체(mv) 실패 — 퇴피본으로 원상복구함." >&2
      else
        echo "  [재캡처 중단] 골든 교체(mv) 실패 + 자동 원상복구(mv)도 실패 — 수동 복구 필요: 퇴피본 위치 = $OLD_GOLD (이 폴더를 $GOLDEN 로 mv 하세요)." >&2
      fi
    else
      echo "  [재캡처 중단] 골든 교체(mv) 실패(퇴피본 없음 — 최초 캡처라 복구할 원본 없음)." >&2
    fi
    rm -rf "$RCAP" "$STAGE"; exit 1
  fi
  rm -rf "$OLD_GOLD" "$RCAP"
  # 성공: 시그널 트랩 해제 + 파일 상단 EXIT 트랩(cleanup_runs) 복원 — 정상 종료가 갓 교체된 골든을 건드리지
  #   않게 한다(핸들러 가드상 어차피 no-op 이지만 명시적으로 원상 복귀).
  trap - HUP INT TERM
  trap 'cleanup_runs' EXIT
  echo "  요약: 변경 $changed · 신규 $added · 동일 $same (총 $((changed+added+same)))"
  echo "  재캡처됨 — diff 를 사람이 검토하고 프롬프트 변경과 같은 커밋에 포함하라."
  exit 0
fi

# ── 비교 모드: 2회 재생성(결정성) + 골든 바이트 비교 ──
TMP1="$(mktemp -d)"; TMP2="$(mktemp -d)"
gen_all "$TMP1"
gen_all "$TMP2"

det_ok=1
for f in $FILES; do
  if ! diff -u "$TMP1/$f" "$TMP2/$f" >/dev/null 2>&1; then
    det_ok=0; echo "  [결정성] $f 불일치:"; diff -u "$TMP1/$f" "$TMP2/$f" | head -30
  fi
done
[ "$det_ok" = 1 ] && pass "결정성: --emit-context·emit-instruction 2회 재생성 바이트 동일(11파일)" || fail "결정성 위반(2회 재생성 불일치)"

for f in $FILES; do
  if [ ! -f "$GOLDEN/$f" ]; then
    fail "골든 누락: $f (GOLDEN_RECAPTURE=1 로 최초 생성 필요)"; continue
  fi
  if diff -u "$GOLDEN/$f" "$TMP1/$f" >/dev/null 2>&1; then
    pass "골든 바이트 일치: $f"
  else
    fail "골든 불일치: $f"; diff -u "$GOLDEN/$f" "$TMP1/$f" | head -50
  fi
done

rm -rf "$TMP1" "$TMP2"
echo "prompt-assembly: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
