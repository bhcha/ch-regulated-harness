#!/usr/bin/env bash
# test-observability.sh — 개선계획 2부(생성·심의 관측성·성능) 회귀 가드.
#   개선0 측정로그(.logs/timing.jsonl + timing.sh) · 개선1 출력캡처 · 개선2 크리틱 watchdog(타임아웃) · 개선3 강등 가시화(verdict 필드 + REQUIRED fail-closed).
#   결정적: 생성은 offline stub(엔진 라벨=claude) → GEN_CLI=claude. 크리틱(원격 ADK)은 로컬 목 서버(tests/adk-mock-server.py, ADK_CRITIC_ALLOW_LOCAL=1)로 정상/실패/타임아웃을 모사한다. 구현 ADK 도메인은 auto-REQUIRED=1 → 실패·타임아웃이 '강등'이 아니라 fail-closed.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 2부 — 생성·심의 관측성(측정로그·로그캡처·크리틱 watchdog·강등 가시화)"

RID=ci-obs
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$ROOT/runs/$RID" "$ROOT/runs/${RID}-req" "$ROOT/runs/${RID}-to" "$ROOT/runs/${RID}-ok"; }
trap cleanup EXIT

# brief 생성(offline·claude 라벨) → 승인 → review 게이트. (history generate 토큰 engine=claude → GEN_CLI=claude)
seed_review() {  # <rid>
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && HARNESS_CLI=claude HARNESS_OFFLINE=1 bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" \
      && HARNESS_CLI=claude HARNESS_OFFLINE=1 bash scripts/run-stage.sh brief "$rid" \
      && bash scripts/approve.sh "$rid" --ra-ok ) >/dev/null 2>&1
}

# ── 개선0: 측정 로그(.logs/timing.jsonl) 가 생성·심의에서 쌓이고 timing.sh 가 평이 요약 ──
seed_review "$RID"
( cd "$ROOT" && HARNESS_OFFLINE=1 bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
TJ="$ROOT/runs/$RID/.logs/timing.jsonl"
[ -f "$TJ" ] && pass "(개선0) .logs/timing.jsonl 생성됨" || fail "(개선0) timing.jsonl 미생성"
# 생성(generate)·심의(review) step 이 기록되는가
grep -q '"step": *"generate"' "$TJ" 2>/dev/null && pass "(개선0) generate 측정 기록" || fail "(개선0) generate 측정 누락"
grep -q '"step": *"review"' "$TJ" 2>/dev/null && pass "(개선0) review 측정 기록" || fail "(개선0) review 측정 누락"
grep -q '"duration_s"' "$TJ" 2>/dev/null && pass "(개선0) duration_s 기록" || fail "(개선0) duration_s 누락"
# timing.sh 평이 요약(잭곤 없이) — '초' 단위 표
TS_OUT="$( cd "$ROOT" && bash scripts/timing.sh "$RID" 2>&1 )"
echo "$TS_OUT" | grep -q "초" && pass "(개선0) timing.sh 평이 요약(초 단위)" || fail "(개선0) timing.sh 요약 비정상: $TS_OUT"
echo "$TS_OUT" | grep -qE "engine=|violations=|step\":" && fail "(개선0) timing.sh 에 잭곤 노출" || pass "(개선0) timing.sh 잭곤 없음"

# ── O-3(진행 신호): 시작 레코드(outcome=start) + timing.sh in-flight('진행 중') 표시 ──
grep -qE '"outcome": *"start"' "$TJ" 2>/dev/null && pass "(O-3) timing.jsonl 시작 레코드(outcome=start)" || fail "(O-3) 시작 레코드 누락"
grep -qE '"step": *"generate".*"outcome": *"start"' "$TJ" 2>/dev/null && pass "(O-3) generate 시작 레코드" || fail "(O-3) generate 시작 레코드 누락"
grep -qE '"step": *"review".*"outcome": *"start"' "$TJ" 2>/dev/null && pass "(O-3) review 시작 레코드" || fail "(O-3) review 시작 레코드 누락"
# 완료된 단계는 시작이 완료와 페어링돼 timing.sh 에 '진행 중'이 뜨지 않는다(완료 출력 = 종전과 동일 = 하위호환).
echo "$TS_OUT" | grep -q "진행 중" && fail "(O-3) 완료 단계인데 timing.sh 가 '진행 중' 오표시" || pass "(O-3) 완료 단계 → 진행 중 미표시(페어링)"

# ── L-1: 실행 기록(.logs/provenance.jsonl) — git_sha·엔진·유효플래그·프롬프트 지문 감사 추적(생성·심의 시점) ──
PJ="$ROOT/runs/$RID/.logs/provenance.jsonl"
[ -f "$PJ" ] && pass "(L-1) .logs/provenance.jsonl 생성됨" || fail "(L-1) provenance.jsonl 미생성"
grep -q '"step": *"generate"' "$PJ" 2>/dev/null && pass "(L-1) generate 실행기록" || fail "(L-1) generate provenance 누락"
grep -q '"step": *"review"' "$PJ" 2>/dev/null && pass "(L-1) review 실행기록" || fail "(L-1) review provenance 누락"
grep -qE '"git_sha": *"[0-9a-f]+"' "$PJ" 2>/dev/null && pass "(L-1) git_sha 기록" || fail "(L-1) git_sha 누락(git 체크아웃 필요)"
grep -qE '"prompts_sha256": *"[0-9a-f]{16}' "$PJ" 2>/dev/null && pass "(L-1) prompts_sha256 프롬프트 지문 기록" || fail "(L-1) prompts_sha256 누락"
grep -q '"effective"' "$PJ" 2>/dev/null && pass "(L-1) effective 유효플래그 블록 기록" || fail "(L-1) effective 누락"
# Codex P3: 유효값은 미-export 셸 var(GEN_TIMEOUT=600 등)에서 읽어야 기본값이 빈 값으로 안 남는다 — 실제 값 채워짐 단정.
grep -qE '"GEN_TIMEOUT": *"[0-9]+"' "$PJ" 2>/dev/null && pass "(L-1) effective 실제값 기록(GEN_TIMEOUT 비어있지 않음)" || fail "(L-1) effective 값이 비어있음(os.environ 만 읽는 회귀)"
grep -q '"engine": *"claude"' "$PJ" 2>/dev/null && pass "(L-1) generate engine 라벨 기록(claude)" || fail "(L-1) engine 누락"
# gen_source 기록(생성표면 stub|insession|subprocess 구분 — Codex P3: insession 도 공통 지점서 남는다). 오프라인 테스트=stub.
grep -qE '"gen_source": *"(stub|insession|subprocess)"' "$PJ" 2>/dev/null && pass "(L-1) gen_source 생성표면 기록" || fail "(L-1) gen_source 누락"
# provenance.jsonl 은 .logs 경로 → 골든 제외(baseline SKIP_PREFIX '.logs'; 휘발성 ts·git_sha 로 결정성 파괴 없음). run.md 비노출.
# in-flight: 시작만 있고 완료 없는 timing.jsonl → timing.sh '진행 중' + 잭곤 없음
RIDIF="${RID}-if"; rm -rf "$ROOT/runs/$RIDIF"; mkdir -p "$ROOT/runs/$RIDIF/.logs"
printf '%s\n' '{"ts":"2026-01-01T00:00:00Z","phase":"02-concept","stage":"concept","step":"generate","outcome":"start"}' > "$ROOT/runs/$RIDIF/.logs/timing.jsonl"
IF_OUT="$( cd "$ROOT" && bash scripts/timing.sh "$RIDIF" 2>&1 )"
echo "$IF_OUT" | grep -q "진행 중" && pass "(O-3) in-flight(시작만) → timing.sh '진행 중' 표시" || fail "(O-3) in-flight 미표시: $IF_OUT"
echo "$IF_OUT" | grep -qE "engine=|violations=|step\":|start" && fail "(O-3) in-flight 표시에 잭곤 노출: $IF_OUT" || pass "(O-3) in-flight 표시 잭곤 없음"
rm -rf "$ROOT/runs/$RIDIF"

# ── 개선3: verdict 에 critic_ran/critic_outcome/review_depth 기록(offline → 크리틱 미실행=rule_engine_only) ──
VP="$ROOT/runs/$RID/01-brief/brief-verdict.json"
[ -f "$VP" ] && pass "(개선3) verdict 생성" || fail "(개선3) verdict 미생성"
python3 - "$VP" <<'PY' && pass "(개선3) verdict 에 critic_ran/critic_outcome/review_depth 기록" || fail "(개선3) verdict 가시화 필드 누락"
import json,sys
d=json.load(open(sys.argv[1]))
ok = ("critic_ran" in d and "critic_outcome" in d and "review_depth" in d
      and d["critic_ran"] is False and d["review_depth"]=="rule_engine_only")
sys.exit(0 if ok else 1)
PY

# ── 로컬 ADK 목 헬퍼(start_mock/stop_mock) 는 lib.sh 공용(K-5 승격) ──

# ── 개선2: 원격 ADK 무한 행(hang) → 크리틱 watchdog 상한 내 회수 + 구현 도메인 auto-REQUIRED → fail-closed ──
#   (개편: 구현된 ADK 도메인은 auto-REQUIRED=1 → 타임아웃은 '조용한 강등'이 아니라 fail-closed. 타임아웃 가시화는 timing.jsonl 로 확인.)
seed_review "${RID}-to"
export ADK_MOCK_HANG=1; start_mock
T0=$(date +%s)
OUT_TO="$( cd "$ROOT" && env -u HARNESS_OFFLINE HARNESS_CLI=claude \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    KCIA_CRITIC_TIMEOUT=2 HARNESS_GEN_POLL=1 HARNESS_GEN_HEARTBEAT=0 bash scripts/kcia-check.sh "${RID}-to" 2>&1 )"; RC_TO=$?
T1=$(date +%s); ELAPSED=$((T1-T0)); stop_mock; unset ADK_MOCK_HANG
[ "$ELAPSED" -lt 30 ] && pass "(개선2) 행 ADK 크리틱이 watchdog 상한 내 회수(${ELAPSED}s, hang 안 함)" || fail "(개선2) watchdog 미작동(${ELAPSED}s — hang)"
check "(개선2) 구현 ADK 타임아웃 → auto-REQUIRED fail-closed(비정상 종료)" "[ $RC_TO -ne 0 ]"
VP_TO="$ROOT/runs/${RID}-to/01-brief/brief-verdict.json"
check "(개선2) fail-closed → verdict 미생성(재실행 fail-open 차단)" "[ ! -f \"$VP_TO\" ]"
# 타임아웃 가시화: verdict 는 fail-closed 라 미생성 → timing.jsonl 의 review-passA outcome=timeout 으로 확인.
grep -q '"outcome": *"timeout"' "$ROOT/runs/${RID}-to/.logs/timing.jsonl" 2>/dev/null \
  && pass "(개선2) timing.jsonl 에 outcome=timeout 가시화" || fail "(개선2) timing.jsonl outcome=timeout 미기록"

# ── 개선3: 구현 ADK 크리틱 실패(엔드포인트 응답 불가) → auto-REQUIRED fail-closed(die, verdict 미생성) ──
#   (개편: 구현 도메인은 '조용한 강등' 금지 = auto-REQUIRED. 강등(rule_engine_only) 경로는 미구현 도메인/offline 뿐 —
#    위 offline 가시화(개선3, 34-43줄) + critic-fanout (3)(4) 에서 검증한다.)
seed_review "${RID}-req"
OUT_REQ="$( cd "$ROOT" && env -u HARNESS_OFFLINE HARNESS_CLI=claude ADK_CRITIC_RETRY=0 \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:1" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "${RID}-req" 2>&1 )"; RC_REQ=$?
VP_REQ="$ROOT/runs/${RID}-req/01-brief/brief-verdict.json"
check "(개선3) 구현 ADK 크리틱 실패 → auto-REQUIRED fail-closed(비정상 종료)" "[ $RC_REQ -ne 0 ]"
check "(개선3) fail-closed → verdict 미생성(재실행 fail-open 차단)" "[ ! -f \"$VP_REQ\" ]"
echo "$OUT_REQ" | grep -qE "KCIA_CRITIC_REQUIRED|크리틱|심의" && pass "(개선3) 크리틱 실패 메시지 명시" || fail "(개선3) 크리틱 실패 메시지 누락"

# (개선3+) 정상 ADK 크리틱(목 위반 1건, refute 안 됨) → critic_ran=true · outcome=ok · review_depth=rule_engine+critic + verdict 생성.
seed_review "${RID}-ok"
export ADK_MOCK_PASSA_TARGET="OBS_CONFIRM 문맥"; start_mock
( cd "$ROOT" && env -u HARNESS_OFFLINE HARNESS_CLI=claude \
    ADK_CRITIC_ALLOW_LOCAL=1 ADK_COSMETICS_CRITIC_URL="http://127.0.0.1:$MOCK_PORT" ADK_COSMETICS_CRITIC_ALLOWED_HOST=127.0.0.1 \
    bash scripts/kcia-check.sh "${RID}-ok" ) >/dev/null 2>&1
stop_mock; unset ADK_MOCK_PASSA_TARGET
VP_OK="$ROOT/runs/${RID}-ok/01-brief/brief-verdict.json"
if [ -f "$VP_OK" ]; then
  python3 -c "import json,sys;d=json.load(open('$VP_OK'));sys.exit(0 if d.get('critic_ran') is True and d.get('critic_outcome')=='ok' and d.get('review_depth')=='rule_engine+critic' else 1)" \
    && pass "(개선3+) 정상 ADK 크리틱 → critic_ran=true·outcome=ok·review_depth=rule_engine+critic" \
    || fail "(개선3+) 정상 크리틱 verdict 필드 부정확: $(python3 -c "import json;d=json.load(open('$VP_OK'));print({k:d.get(k) for k in ['critic_ran','critic_outcome','review_depth']})" 2>/dev/null)"
else
  fail "(개선3+) 정상 크리틱 경로 verdict 미생성"
fi

printf '\n[observability] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
