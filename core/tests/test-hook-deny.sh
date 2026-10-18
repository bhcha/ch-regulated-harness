#!/usr/bin/env bash
# test-hook-deny.sh — PreToolUse 경화 훅 회귀 가드(결정적·오프라인·no-LLM·no-network).
#   대상 = scripts/hooks/deny-state-writes.sh + 배선(레포 루트 .claude/settings.json). 게이트 경화 계획 3단계.
#   무엇을 단정하는가:
#     (A) 좁은 deny — 런 `state.json`(Write·Edit · 절대·상대·cwd상대·`..` 되돌아옴) · 런 `.logs/` 하위.
#     (B) 허용 — 평범한 산출물 · 보호구역 **밖**의 같은 이름 파일(`state.json`) · `..` 로 밖으로 나간 경로 ·
#         깨진 JSON · `file_path` 부재 · Write/Edit 아닌 도구(= Bash 명령 파싱을 하지 않는다는 설계 단정).
#     (C) 사유 문구 — 교정 안내(무엇을 대신 할지)가 평이 한국어로 나오고 내부 용어가 새지 않는다.
#     (D) **비-load-bearing 증명** — 어떤 게이트 스크립트도 이 훅을 참조하지 않는다(훅을 지워도 판정 불변).
#         배선은 오직 프로젝트 settings.json 한 곳(그래서 훅은 '있으면 더 막는' 계층일 뿐이다).
#   런을 만들지 않는다: 훅은 경로만 보고 판정하므로 파일시스템 부작용 0(runs/ 미생성).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## PreToolUse 경화 훅 — 좁은 deny 판정 · 교정 문구 · 비-load-bearing 증명"

HOOK="$ROOT/scripts/hooks/deny-state-writes.sh"
REPO="$(cd "$ROOT/.." && pwd)"          # ROOT=core → 레포 루트(형제)
SETTINGS="$REPO/.claude/settings.json"
RID=ci-sample                           # 실재하지 않아도 된다(경로 판정만).
                                        #   ⚠ 런 이름은 사유 문구에 그대로 실린다 → (C3) 용어 스캔과
                                        #     겹치지 않는 중립 이름을 쓴다(자기 픽스처 오탐 방지).
RC=0; ERR=""

check "훅 스크립트 존재" "[ -f \"$HOOK\" ]"
check "훅 스크립트 문법 정상" "bash -n \"$HOOK\""
check "프로젝트 settings.json 존재(배선)" "[ -f \"$SETTINGS\" ]"

# ── 이벤트 JSON 픽스처 조립(python3 json.dumps — 경로에 특수문자가 있어도 안전) ──
ev() {  # ev <tool_name> <file_path> [cwd]
  python3 - "$@" <<'PY'
import json, sys
e = {"hook_event_name": "PreToolUse", "session_id": "ci", "tool_name": sys.argv[1],
     "tool_input": {"file_path": sys.argv[2]}}
if len(sys.argv) > 3:
    e["cwd"] = sys.argv[3]
print(json.dumps(e))
PY
}

# 훅 1회 실행(stdin=이벤트 JSON) → RC·ERR 전역.
#   CLAUDE_PROJECT_DIR 를 **지우고** 돌린다: 보호구역 루트가 '스크립트 자기위치' 기준으로 계산돼
#   클론 위치·세션 env 와 무관하게 옳다는 것까지 함께 검증한다.
run_hook() {  # run_hook <event-json>
  ERR="$(printf '%s' "$1" | env -u CLAUDE_PROJECT_DIR bash "$HOOK" 2>&1 >/dev/null)"
  RC=$?
}
deny_case() {  # deny_case <라벨> <event-json>
  run_hook "$2"
  if [ "$RC" = "2" ] && [ -n "$ERR" ]; then pass "$1 — 거부(종료 2 + 사유 되먹임)"
  else fail "$1 — 거부 기대인데 RC=$RC · 사유='${ERR:-<없음>}'"; fi
}
allow_case() {  # allow_case <라벨> <event-json>
  run_hook "$2"
  if [ "$RC" = "0" ] && [ -z "$ERR" ]; then pass "$1 — 허용(종료 0)"
  else fail "$1 — 허용 기대인데 RC=$RC · 사유='${ERR:-<없음>}'"; fi
}

# ── (A) 좁은 deny ────────────────────────────────────────────────────────────
deny_case "(A1) 런 state.json · Write · 절대경로"  "$(ev Write "$REPO/core/runs/$RID/state.json")"
deny_case "(A2) 런 state.json · Edit · 절대경로"   "$(ev Edit  "$REPO/core/runs/$RID/state.json")"
deny_case "(A3) 런 state.json · Write · 상대경로"  "$(ev Write "core/runs/$RID/state.json")"
deny_case "(A4) 런 state.json · Edit · 상대경로"   "$(ev Edit  "core/runs/$RID/state.json")"
deny_case "(A5) 런 state.json · cwd(core) 기준 상대경로" "$(ev Write "runs/$RID/state.json" "$REPO/core")"
deny_case "(A6) 런 .logs/ 하위 진단파일"           "$(ev Write "$REPO/core/runs/$RID/.logs/timing.jsonl")"
deny_case "(A7) '..' 로 보호구역에 되돌아온 경로"  "$(ev Write "$REPO/core/runs/$RID/../$RID/state.json")"

# ── (B) 허용(오탐 방지 + fail-open) ──────────────────────────────────────────
allow_case "(B1) 평범한 런 산출물(01-brief)"        "$(ev Write "$REPO/core/runs/$RID/01-brief/brief.json")"
allow_case "(B2) 보호구역 밖의 같은 이름 state.json" "$(ev Write "$REPO/chat/test/fixtures/state.json")"
allow_case "(B3) '..' 로 레포 밖으로 나간 경로"      "$(ev Write "$REPO/core/runs/../../state.json")"
allow_case "(B4) 깨진 이벤트 JSON(fail-open)"        '{not json'
allow_case "(B5) file_path 부재(fail-open)"          '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{}}'
# Bash 명령 문자열 파싱은 **하지 않는다**(계획 3단계 1번: 오탐이 이득보다 크고, Bash 우회는
#   사후 게이트[verdict 해시 바인딩·advance 마커]가 잡는 것이 원설계다). 이 단정이 그 결정의 고정핀이다.
allow_case "(B6) Write/Edit 아닌 도구(Bash 명령 파싱 안 함)" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo x > core/runs/ci/state.json"}}'

# ── (C) 사유 문구 = 현업 화법(교정 안내 · 내부 용어 비노출) ──────────────────
run_hook "$(ev Write "$REPO/core/runs/$RID/state.json")"
STATE_ERR="$ERR"
if printf '%s' "$STATE_ERR" | grep -q '스크립트만 씁니다'; then
  pass "(C1) 사유에 '스크립트만 씁니다' 원칙 명시"
else fail "(C1) 사유에 원칙 문구 없음: '$STATE_ERR'"; fi
if printf '%s' "$STATE_ERR" | grep -q 'scripts/approve.sh'; then
  pass "(C2) 사유가 대신 할 일(승인 명령)을 알려줌"
else fail "(C2) 사유에 대안 명령 없음: '$STATE_ERR'"; fi
# 현업/모델에 노출되는 문장에 내부·개발 용어가 새지 않는다(prompts/operator-voice.md 화법).
JARGON='PreToolUse|fail-closed|fail-open|deny|hook|exit 2|state\.json 은'
if printf '%s' "$STATE_ERR" | grep -qE "$JARGON"; then
  fail "(C3) 사유에 내부 용어 누수: $(printf '%s' "$STATE_ERR" | grep -oE "$JARGON" | sort -u | paste -sd',' -)"
else pass "(C3) 사유에 내부 용어 없음(평이 한국어)"; fi
run_hook "$(ev Write "$REPO/core/runs/$RID/.logs/timing.jsonl")"
if printf '%s' "$ERR" | grep -q 'scripts/timing.sh'; then
  pass "(C4) 기록 폴더 사유가 확인 명령(timing)을 알려줌"
else fail "(C4) 기록 폴더 사유에 대안 명령 없음: '$ERR'"; fi

# ── (D) 비-load-bearing 증명 ────────────────────────────────────────────────
# 게이트/전이/심의 스크립트 어디에도 이 훅을 향한 참조가 없다 → 훅 파일을 지워도 게이트 판정과
#   기존 fail-closed 는 한 줄도 달라지지 않는다(훅 없는 표면 = CI stub subprocess 와 동일).
#   (훅 자신은 스캔 제외 — 검사 대상은 '게이트가 훅을 아는가'다.)
HOOKREF="$(cd "$ROOT" && grep -rnE --exclude-dir=hooks --exclude-dir=__pycache__ \
            'deny-state-writes|scripts/hooks|PreToolUse' scripts/ 2>/dev/null || true)"
if [ -z "$HOOKREF" ]; then
  pass "(D1) 어떤 게이트 스크립트도 훅을 참조하지 않음(비-load-bearing)"
else
  fail "(D1) 게이트 스크립트가 훅에 의존하는 참조 발견(게이트는 훅 없이도 성립해야 함):
$HOOKREF"
fi

# 배선은 오직 프로젝트 settings.json 한 곳 — 그리고 그 배선이 실제로 이 훅을 가리키는지(리네임 시
#   조용히 무배선이 되는 것 방지) + 파일이 최소인지(무관한 설정 끼워넣기 금지) 확인.
SET_OUT="$(python3 - "$SETTINGS" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("PARSE_FAIL\t%s" % e); sys.exit(0)
print("PARSE_OK")
print("TOPKEYS\t%s" % ",".join(sorted(d.keys())))
for ent in ((d.get("hooks") or {}).get("PreToolUse") or []):
    print("MATCHER\t%s" % ent.get("matcher", ""))
    for hk in (ent.get("hooks") or []):
        print("CMD\t%s\t%s" % (hk.get("type", ""), hk.get("command", "")))
PY
)"
printf '%s\n' "$SET_OUT" | grep -q '^PARSE_OK$' \
  && pass "(D2) settings.json 파싱 정상" || fail "(D2) settings.json 파싱 실패: $SET_OUT"
[ "$(printf '%s\n' "$SET_OUT" | sed -n 's/^TOPKEYS\t//p')" = "hooks" ] \
  && pass "(D3) settings.json 최소 — 최상위 키가 hooks 하나뿐" \
  || fail "(D3) settings.json 에 무관한 설정 존재(hooks 만 두세요): $(printf '%s\n' "$SET_OUT" | sed -n 's/^TOPKEYS\t//p')"
printf '%s\n' "$SET_OUT" | grep -qx 'MATCHER	Write|Edit' \
  && pass "(D4) PreToolUse matcher = Write|Edit" \
  || fail "(D4) matcher 가 Write|Edit 아님: $(printf '%s\n' "$SET_OUT" | grep '^MATCHER' | paste -sd' ' -)"
printf '%s\n' "$SET_OUT" | grep '^CMD' | grep -q 'core/scripts/hooks/deny-state-writes.sh' \
  && pass "(D5) 배선이 실제 훅 경로를 가리킴(리네임 시 무배선 포착)" \
  || fail "(D5) settings.json 이 훅을 가리키지 않음: $(printf '%s\n' "$SET_OUT" | grep '^CMD' | paste -sd' ' -)"
# 배선 커맨드는 클론 위치에 무관해야 한다(절대경로 하드코딩 금지 → $CLAUDE_PROJECT_DIR 기준).
printf '%s\n' "$SET_OUT" | grep '^CMD' | grep -q 'CLAUDE_PROJECT_DIR' \
  && pass '(D6) 배선 경로가 클론 위치 무관(CLAUDE_PROJECT_DIR 기준)' \
  || fail "(D6) 배선에 클론-종속 경로가 하드코딩됨: $(printf '%s\n' "$SET_OUT" | grep '^CMD' | paste -sd' ' -)"

# fail-open 이 '의도'라는 근거 주석이 스크립트에 남아 있는지 — 미래에 fail-closed 로 '경화'되는
#   퇴행(파싱 한 번 실패로 세션 전체 편집이 막히는 자해 장애)을 막는 고정핀.
grep -q 'fail-open 이 \*\*의도된 설계\*\*' "$HOOK" \
  && pass "(D7) fail-open 이 의도임을 밝힌 근거 주석 보존" \
  || fail "(D7) fail-open 근거 주석 소실 — 훅이 fail-closed 로 퇴행하지 않도록 근거를 남기세요"

echo "hook-deny: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
