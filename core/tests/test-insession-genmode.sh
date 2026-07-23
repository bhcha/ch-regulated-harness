#!/usr/bin/env bash
# test-insession-genmode.sh — 생성 표면(GEN_MODE) 선택 + 토큰 무결성 가드 (개편 후 계약).
#   불변식: AGENTS.md 1-1·1-4.
#   개편(세션 밖 헤드리스 subprocess 실엔진 생성 폐기):
#     · stub 게이트 = HARNESS_OFFLINE=1(유일). 온라인이면 HARNESS_CLI 기본=claude.
#     · 온라인 + Claude 세션 마커 → insession(세션 안 에이전트가 산출물 먼저 작성, 스크립트는 검증·전이만).
#     · 온라인 + 세션 미감지 + 실엔진 → die(세션 밖 실엔진 생성 금지, run_llm 헤드리스 경로 제거).
#     · 오프라인(또는 HARNESS_CLI=stub) → subprocess+stub(결정성 불변).
#   심의 self-grading 가드(KCIA_CRITIC_CMD/로컬 critic)는 폐기 → 그 케이스는 제거. 토큰 무결성(GEN_CLI 화이트리스트)은 유지.
#   결정적(no-LLM): '세션 안 에이전트가 먼저 썼다'를 stub_stage.py 산출물로, CLAUDECODE 마커를 env 로 모사. run_llm(헤드리스)은 호출되지 않는다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## in-session(GEN_MODE) 생성 표면 선택 + 토큰 무결성 가드"

# 이 테스트는 'Claude 세션'을 모사한다 — 주변 환경에 codex 활성 마커가 있으면 detect_insession_engine 이 fail-closed 되어
#   positive 케이스가 깨진다. 활성 codex 마커를 제거(테스트 (11) 은 인라인으로 다시 세팅).
for _v in $(env | grep -E '^CODEX_' | grep -vE '^CODEX_(COMPANION|HOME|MANAGED_BY_NPM|BIN|CONFIG|NPM|VERSION)' | cut -d= -f1); do unset "$_v" 2>/dev/null || true; done

RID=ci-insession
cleanup() { rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID"-*; }
trap cleanup EXIT

# 산출물을 '세션 안 에이전트가 먼저 썼다'고 모사: ingest 후 stub 생성기로 brief.json 만 작성(상태 전이 X).
setup_at_brief_generate() {  # $1=rid : ingest → 01-brief/step=generate 상태(산출물 전이 X)
  local rid="$1"
  rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" ) >/dev/null 2>&1
}
write_brief_artifact() {  # $1=rid : stub 생성기로 산출물만 작성(state.json 전이 없음 — '에이전트가 쓴' 모사)
  local rid="$1"
  ( cd "$ROOT" && HARNESS_DOMAIN=cosmetic HARNESS_PRODUCT_NAME="테스트" \
      python3 scripts/lib/stub_stage.py brief "$rid" "$ROOT/runs/$rid" ) >/dev/null 2>&1
}

# ── (1) 정상 in-session 전이: 온라인 + CLAUDECODE 마커 → engine=claude, generate:insession 이벤트, 승인→review ──
setup_at_brief_generate "$RID"
check "(1) 전제: ingest 후 step=generate" "[ \"\$(jq_phase $RID step)\" = generate ]"
write_brief_artifact "$RID"
check "(1) 전제: 에이전트가 brief.json 작성(전이 전)" "[ -f \"$ROOT/runs/$RID/01-brief/brief.json\" ] && [ \"\$(jq_phase $RID gate)\" != review ]"
OUT1="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_GEN_MODE=insession HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID" ) 2>&1 )"; RC1=$?
check "(1) 온라인 in-session 전이 성공(rc=0)" "[ $RC1 -eq 0 ]"
# M4: 생성 직후 게이트는 user(사람 승인 대기)다. brief 는 단안이라 approve 로 review 에 도달한다(stub brief 에 민감 라벨 1건 → --ra-ok).
check "(1) 생성 직후 user 게이트(사람 승인 대기)" "[ \"\$(jq_phase $RID gate)\" = user ] && [ \"\$(jq_phase $RID status)\" = pending ]"
( cd "$ROOT" && bash scripts/approve.sh "$RID" --ra-ok ) >/dev/null 2>&1
check "(1) approve --ra-ok → review 게이트 전이" "[ \"\$(jq_phase $RID gate)\" = review ] && [ \"\$(jq_phase $RID status)\" = pending ]"
check "(1) history 에 generate:insession:brief:claude 기록" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RID/state.json'))['history'];import sys;sys.exit(0 if any(e['event']=='generate:insession:brief:claude' for e in h) else 1)\""
# L-1(Codex P2 회귀 가드): insession(온라인 primary 모드)은 NEED_GENERATE=0 이면서 GEN_SOURCE=insession 이다 —
#   순수 재개(NEED_GENERATE=0·subprocess)와 달리 provenance 에 generate 기록이 남아야 한다(감사 로그가 주경로를 빠뜨리면 안 됨).
PJ1="$ROOT/runs/$RID/.logs/provenance.jsonl"
check "(1/L-1) insession 생성이 provenance.jsonl 에 gen_source=insession 로 기록" \
  "[ -f \"$PJ1\" ] && grep -q '\"gen_source\": *\"insession\"' \"$PJ1\""

# ── (2) fail-closed: 온라인 + 신뢰 마커 없음(생터미널) + 실엔진(claude) → die, state 불변(step=generate 유지) ──
#     개편: 세션 밖 실엔진 생성은 제거 — insession 미감지면 헤드리스 run_llm 으로 안 떨어지고 fail-closed.
setup_at_brief_generate "$RID-2"
write_brief_artifact "$RID-2"
OUT2="$( ( cd "$ROOT" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u HARNESS_OFFLINE HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC2=$?
check "(2) 온라인+마커 없음(명시 insession) → die(fail-closed)" "[ $RC2 -ne 0 ] && echo \"\$OUT2\" | grep -q '신뢰 마커'"
check "(2) state 불변(step=generate, 전이 안 됨)" "[ \"\$(jq_phase $RID-2 step)\" = generate ]"

# ── (2b) 개편 핵심: 온라인 + 세션 미감지 + 실엔진 + GEN_MODE 미지정 → subprocess 귀결 → fail-closed(세션 밖 실엔진 금지) ──
#     (1)은 명시 insession 마커 없음을, 여기선 자동선택이 subprocess 로 떨어진 뒤의 헤드리스-제거 die 를 검증.
#     ⚠ 산출물을 미리 쓰지 않는다 — 쓰면 NEED_GENERATE=0(idempotent 재개)으로 fail-closed 가 면제되어 전이만 보정된다(재개는 세션/엔진 무관 허용).
setup_at_brief_generate "$RID-2b"
OUT2B="$( ( cd "$ROOT" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u HARNESS_OFFLINE -u HARNESS_GEN_MODE HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2b" ) 2>&1 )"; RC2B=$?
check "(2b) 온라인+세션밖+실엔진(자동) → die(세션 밖 헤드리스 생성 제거)" "[ $RC2B -ne 0 ] && echo \"\$OUT2B\" | grep -q '세션 밖 실엔진'"
check "(2b) state 불변(step=generate)" "[ \"\$(jq_phase $RID-2b step)\" = generate ]"

# ── (2c) 온라인 + HARNESS_CLI=stub → die(stub 은 CI 전용; 운영 stub 생성 금지) ──
setup_at_brief_generate "$RID-2c"
OUT2C="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE HARNESS_CLI=stub bash scripts/run-stage.sh brief "$RID-2c" ) 2>&1 )"; RC2C=$?
check "(2c) 온라인 + HARNESS_CLI=stub → die(stub=CI 전용)" "[ $RC2C -ne 0 ] && echo \"\$OUT2C\" | grep -q 'CI'"

# ── (3) in-session + 산출물 부재 → die(중첩 생성 금지), state 불변 ──
setup_at_brief_generate "$RID-2"   # 산출물 안 씀
OUT3="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_GEN_MODE=insession HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC3=$?
check "(3) 산출물 부재 → die(에이전트가 먼저 작성)" "[ $RC3 -ne 0 ] && echo \"\$OUT3\" | grep -q '산출물'"
check "(3) state 불변(step=generate)" "[ \"\$(jq_phase $RID-2 step)\" = generate ]"
check "(3) brief.json 미생성(run_llm 미호출 — 중첩 생성 없음)" "[ ! -f \"$ROOT/runs/$RID-2/01-brief/brief.json\" ]"

# ── (7) 오프라인 우선: HARNESS_OFFLINE=1 이면 GEN_MODE=insession 무시(CI/골든 결정성 불변) ──
setup_at_brief_generate "$RID-2"
OUT7="$( ( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC7=$?
# stub 생성 완주의 도착 게이트는 user. insession 무시 신호 = 게이트 도달(rc=0)+generate:ok:...:stub 이벤트.
check "(7) 오프라인 우선 — insession 무시하고 stub 생성 완주(rc=0)" "[ $RC7 -eq 0 ] && [ \"\$(jq_phase $RID-2 gate)\" = user ]"
check "(7) 이벤트는 generate:ok:...:stub (insession 아님)" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RID-2/state.json'))['history'];import sys;sys.exit(0 if any(e['event'].startswith('generate:ok:brief:stub') for e in h) else 1)\""

# ── (9) stub 생성 → review 도달 후 insession 재진입은 fail-closed(step!=generate) ──
#     재진입 no-op 으로 stub 토큰이 살아 가드가 무력화되는 우회 차단.
setup_at_brief_generate "$RID-2"
( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub bash scripts/run-stage.sh brief "$RID-2" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/approve.sh "$RID-2" --ra-ok ) >/dev/null 2>&1
check "(9) 전제: 생성+approve 로 review/step=review 도달" "[ \"\$(jq_phase $RID-2 gate)\" = review ] && [ \"\$(jq_phase $RID-2 step)\" = review ]"
OUT9="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_GEN_MODE=insession HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC9=$?
check "(9) review 재진입 insession → die(step!=generate, 우회 차단)" "[ $RC9 -ne 0 ] && echo \"\$OUT9\" | grep -q 'generate'"

# ── (11) Codex 활성 마커(CODEX_THREAD_ID)+CLAUDECODE 동시 → detection fail-closed(Codex→claude 오분류 차단) ──
setup_at_brief_generate "$RID-2"; write_brief_artifact "$RID-2"
OUT11="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 CODEX_THREAD_ID=test-xyz HARNESS_GEN_MODE=insession HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC11=$?
check "(11) CODEX_THREAD_ID+CLAUDECODE 동시 → die(Codex→claude 오분류 차단)" "[ $RC11 -ne 0 ] && echo \"\$OUT11\" | grep -q '신뢰 마커'"
check "(11) state 불변(step=generate)" "[ \"\$(jq_phase $RID-2 step)\" = generate ]"

# ── (12) --emit-context 가 단계별 필수 산출물(OUT)/fan-out 구조를 실제로 방출 ──
setup_at_brief_generate "$RID-2"
EMITB="$( ( cd "$ROOT" && bash scripts/run-stage.sh brief "$RID-2" --emit-context ) 2>&1 )"
check "(12/brief) emit 에 PROMPT_FILE + OUT(brief.json)" "echo \"\$EMITB\" | grep -q 'PROMPT_FILE=' && echo \"\$EMITB\" | grep -q 'OUT:.*brief.json'"
check "(12b/brief) emit 전이 명령에 HARNESS_CLI=claude HARNESS_GEN_MODE=insession" "echo \"\$EMITB\" | grep -q 'HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief'"
EMITC="$( ( cd "$ROOT" && bash scripts/run-stage.sh concept "$RID-2" --emit-context ) 2>&1 )"
check "(12/concept) emit 에 concept fan-out 구조(concept-axes→rtb→recommendation)" "echo \"\$EMITC\" | grep -q 'concept-axes.json' && echo \"\$EMITC\" | grep -q 'rtb.json' && echo \"\$EMITC\" | grep -q 'recommendation.json'"

# ── (13) 토큰 무결성: malformed in-session 토큰(엔진 빔)은 kcia 가 fail-closed(env 보정 우회 차단) ──
#     self-grading 가드는 폐기됐으나 GEN_CLI 토큰 화이트리스트/in-session raw 토큰 검증은 유지된다(손상 history fail-closed).
setup_at_brief_generate "$RID-2"; write_brief_artifact "$RID-2"
( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_GEN_MODE=insession HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/approve.sh "$RID-2" --ra-ok ) >/dev/null 2>&1
python3 -c "
import json
p='$ROOT/runs/$RID-2/state.json'
st=json.load(open(p))
for e in st['history']:
    if e['event'].startswith('generate:insession:'):
        e['event']='generate:insession:brief:'   # 엔진 토큰 빔(손상 state 모사)
json.dump(st,open(p,'w'),ensure_ascii=False,indent=2)
"
OUT13="$( ( cd "$ROOT" && bash scripts/kcia-check.sh "$RID-2" ) 2>&1 )"; RC13=$?
check "(13) malformed in-session 토큰(엔진 빔) → die(env 보정 우회 차단)" "[ $RC13 -ne 0 ] && echo \"\$OUT13\" | grep -q '비정상'"

# ── (15) malformed 'ok' 엔진 토큰(generate:ok:brief:unknown)도 fail-closed(source 무관, 손상 history) ──
setup_at_brief_generate "$RID-2"
( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub bash scripts/run-stage.sh brief "$RID-2" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/approve.sh "$RID-2" --ra-ok ) >/dev/null 2>&1
python3 -c "
import json
p='$ROOT/runs/$RID-2/state.json'
st=json.load(open(p))
for e in st['history']:
    if e['event'].startswith('generate:ok:brief:'):
        e['event']='generate:ok:brief:unknown'   # 비정상 non-empty 토큰(손상 모사)
json.dump(st,open(p,'w'),ensure_ascii=False,indent=2)
"
OUT15="$( ( cd "$ROOT" && bash scripts/kcia-check.sh "$RID-2" ) 2>&1 )"; RC15=$?
check "(15) malformed ok 엔진 토큰(unknown) → die(손상 history fail-closed)" "[ $RC15 -ne 0 ] && echo \"\$OUT15\" | grep -q '비정상'"

# ── (16) 자동 기본값: 온라인 + 실엔진(claude) + Claude 마커 + GEN_MODE 미지정 → insession 자동선택 ──
setup_at_brief_generate "$RID-2"; write_brief_artifact "$RID-2"
OUT16="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_CLI=claude bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC16=$?
check "(16) 자동 insession 선택(온라인+실엔진+마커, GEN_MODE 미지정) → rc=0" "[ $RC16 -eq 0 ]"
check "(16) generate:insession 이벤트 기록(자동선택)" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RID-2/state.json'))['history'];import sys;sys.exit(0 if any(e['event']=='generate:insession:brief:claude' for e in h) else 1)\""

# ── (17) 오프라인 + GEN_MODE/CLI 미지정(lib.sh 기본 OFFLINE=1) → subprocess+stub 유지(결정성 불변) ──
setup_at_brief_generate "$RID-2"
OUT17="$( ( cd "$ROOT" && CLAUDECODE=1 bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC17=$?   # HARNESS_OFFLINE=1 (lib.sh 기본)
check "(17) 오프라인은 자동 insession 으로 안 샌다(rc=0, 승인 게이트 도달)" "[ $RC17 -eq 0 ] && [ \"\$(jq_phase $RID-2 gate)\" = user ]"
check "(17) 이벤트는 generate:ok:...:stub (subprocess+stub, insession 아님)" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RID-2/state.json'))['history'];import sys;sys.exit(0 if any(e['event'].startswith('generate:ok:brief:stub') for e in h) else 1)\""

# ── (18) PR2-E: keyvisual 세션 내 지원 + 렌더 디커플링 — 에이전트가 HTML 만 쓰고(manifest 없음) 전이하면 렌더가 manifest 생성 + insession 기록 ──
#   개편(이미지 엔진 = 온라인이면 nanobanana 강제, 키 없으면 die): 온라인 insession 키비주얼은 렌더의 이미지 선행생성이
#   resolve_image_engine=nanobanana 를 탄다. 무네트워크 hermetic 을 지키려고 (a) 더미 키로 엔진=nanobanana 가 되게 하고,
#   (b) 키비주얼 HTML 이 참조할 .png 생성물을 미리 유효 PNG 로 심어 image_engine 의 멱등-skip 이 네트워크를 타지 않게 한다
#   (svg 참조를 png 로 치환). 더미 키는 '실제로 사용되지 않는다'(전부 skip) → 외부 호출 0회.
RIDKV="$RID-kv"; rm -rf "$ROOT/runs/$RIDKV"   # per-run 계약: 생성물(04-keyvisual/generated/)은 런 안 → 함께 정리
seed_fixture keyvisual "$RIDKV"
( cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_CLI=stub bash scripts/run-stage.sh keyvisual "$RIDKV" ) >/dev/null 2>&1
rm -f "$ROOT/runs/$RIDKV/04-keyvisual/design-manifest.json"
rm -rf "$ROOT/runs/$RIDKV/04-keyvisual/sections" 2>/dev/null || true
# (a) 유효 PNG 를 .svg 옆에 심고 (b) 옵션 HTML/CSS 의 .svg 참조를 .png 로 치환(엔진=nanobanana 가 .png 를 skip).
python3 - "$ROOT/runs/$RIDKV/04-keyvisual/generated" <<'PY'
import sys, os
gen = sys.argv[1]
raw = (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
       + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
       + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
for fn in os.listdir(gen):
    if fn.endswith(".svg"):
        open(os.path.join(gen, fn[:-4] + ".png"), "wb").write(raw)
PY
grep -rl "\.svg" "$ROOT/runs/$RIDKV/04-keyvisual/options/" 2>/dev/null | while read -r f; do
  python3 -c "import sys;p=sys.argv[1];t=open(p).read();open(p,'w').write(t.replace('.svg','.png'))" "$f"
done
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/$RIDKV/state.json" step '"generate"' >/dev/null
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/$RIDKV/state.json" gate '"review"' >/dev/null
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/$RIDKV/state.json" status '"pending"' >/dev/null
OUT18="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE CLAUDECODE=1 HARNESS_CLI=claude HARNESS_GEN_MODE=insession NANOBANANA_API_KEY=dummy-skip-only bash scripts/run-stage.sh keyvisual "$RIDKV" ) 2>&1 )"; RC18=$?
check "(18) keyvisual 세션 내 전이 성공(rc=0, die 없음)" "[ $RC18 -eq 0 ]"
check "(18) 렌더 디커플링 — 전이 단계가 design-manifest 재생성" "[ -f \"$ROOT/runs/$RIDKV/04-keyvisual/design-manifest.json\" ]"
check "(18) generate:insession:keyvisual:claude 기록(격리 토큰)" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RIDKV/state.json'))['history'];import sys;sys.exit(0 if any(e['event']=='generate:insession:keyvisual:claude' for e in h) else 1)\""
rm -rf "$ROOT/runs/$RIDKV"   # per-run 계약: 생성물(04-keyvisual/generated/)은 런 안 → 함께 정리

# ── (19) 명시 HARNESS_GEN_MODE=insession 라도 stub-CLI 면 subprocess 강제(오프라인 아니어도, 결정성 불변) ──
#     단 stub 은 온라인에서 die(2c)이므로, 여기선 stub+insession+오프라인이 subprocess 로 강제됨을 본다(명시 insession 우회 차단).
setup_at_brief_generate "$RID-2"
OUT19="$( ( cd "$ROOT" && HARNESS_OFFLINE=1 CLAUDECODE=1 HARNESS_CLI=stub HARNESS_GEN_MODE=insession bash scripts/run-stage.sh brief "$RID-2" ) 2>&1 )"; RC19=$?
check "(19) stub + 명시 insession + 오프라인 → subprocess+stub 강제(rc=0, 승인 게이트)" "[ $RC19 -eq 0 ] && [ \"\$(jq_phase $RID-2 gate)\" = user ]"
check "(19) 이벤트는 generate:ok:...:stub (insession 우회 안 됨)" \
  "python3 -c \"import json;h=json.load(open('$ROOT/runs/$RID-2/state.json'))['history'];import sys;sys.exit(0 if any(e['event'].startswith('generate:ok:brief:stub') for e in h) else 1)\""

# ── (8) 본문 격리 린트: in-session 스킬 본문이 in-session 계약(산출물만+전이 위임)을 따르는지 ──
for sk in brief concept storyboard-outline storyboard-plan guideline keyvisual evidence; do
  body="$ROOT/skills/$sk/SKILL.md"
  check "(8/$sk) in-session 전이 위임(HARNESS_GEN_MODE=insession)" "grep -q 'HARNESS_GEN_MODE=insession' \"$body\""
  check "(8/$sk) 정규 컨텍스트 사용(--emit-context)" "grep -q -- '--emit-context' \"$body\""
  check "(8/$sk) state.json 비수정 명시" "grep -q 'state.json' \"$body\" && grep -Eq '건드리|금지' \"$body\""
  check "(8/$sk) 수동전용(disable-model-invocation:true)" "grep -q 'disable-model-invocation: true' \"$body\""
done

printf '\n[insession-genmode] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
