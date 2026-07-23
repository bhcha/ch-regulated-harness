#!/usr/bin/env bash
# test-trace-verdict-id.sh — WS-TRACE: verdict.id ↔ history.verdict_id 역참조(추적성, ADR §5-②).
#   (A) review 전이 시 history.verdict_id == verdict.id, id 가 verdict 파일명 인코딩(03 substage 충돌 방지).
#   (B) id 없는 옛 verdict back-compat: 스키마 통과 + gate.sh review 정상 전이 + verdict_id 생략.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## WS-TRACE — verdict.id ↔ history.verdict_id"
export HARNESS_CLI=stub HARNESS_OFFLINE=1
H="$ROOT/scripts/lib/harness.py"

# ── (A) 정상: brief 승인 → 심의 → verdict.id 생성 + history 역참조 ──
#   M4: 단안(brief) 은 승인(approve) 뒤 심의(kcia-check); review-pass = advance(02-concept).
RID=ci-trace; rm -rf "$ROOT/runs/$RID"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" \
  && bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
VP="$ROOT/runs/$RID/01-brief/brief-verdict.json"
VID="$(python3 "$H" jget "$VP" id 2>/dev/null || true)"
check "(A) verdict.json 에 id 생성됨" "[ -n \"$VID\" ] && [ \"$VID\" != 'null' ]"
check "(A) id 가 verdict 파일명 인코딩(brief-verdict-…; 03 substage 충돌 방지)" "case \"$VID\" in brief-verdict-*) true;; *) false;; esac"
HVID="$(python3 -c "
import json
h=json.load(open('$ROOT/runs/$RID/state.json'))['history']
rev=[e for e in h if e['event'].startswith('review:')]
print(rev[-1].get('verdict_id','') if rev else '')
")"
check "(A) history review 엔트리 verdict_id == verdict.id" "[ -n \"$HVID\" ] && [ \"$HVID\" = \"$VID\" ]"
# M4: 단안 review-pass = advance(02-concept). 즉 심의 통과 시 다음 페이즈로 전진한다.
check "(A) 단안 review-pass = advance(02-concept)" "[ \"$(jq_phase "$RID" phase)\" = '02-concept' ]"

# ── (C) 가드: 환경에 HARNESS_VERDICT_ID 가 남아도 비-review(human:approved) 이벤트엔 안 붙는다 ──
#   M4: 별도 run 으로 생성 직후 user 게이트에서 approve(가짜 verdict_id env 주입) → human:approved 엔 미기록이어야 한다.
RIDC=ci-trace-leak; rm -rf "$ROOT/runs/$RIDC"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RIDC" && bash scripts/run-stage.sh brief "$RIDC" ) >/dev/null 2>&1
( cd "$ROOT" && HARNESS_VERDICT_ID="bogus-leak" bash scripts/approve.sh "$RIDC" --ra-ok ) >/dev/null 2>&1
LEAK="$(python3 -c "
import json
h=json.load(open('$ROOT/runs/$RIDC/state.json'))['history']
appr=[e for e in h if e['event'].startswith('human:approved')]
print('LEAK' if (appr and 'verdict_id' in appr[-1]) else 'CLEAN')
")"
check "(C) env 에 HARNESS_VERDICT_ID 누출돼도 비-review(human:approved) 미기록" "[ \"$LEAK\" = 'CLEAN' ]"
rm -rf "$ROOT/runs/$RIDC"

# ── (B1) gate.sh id-optional back-compat: id 없는 verdict 로 gate.sh review '직접' 호출 → 전이 + verdict_id 생략 ──
#   (kcia-check 의 idempotent 는 이제 완료마커(id) 를 요구하므로, 순수 gate.sh 의 id-optional back-compat 만 직접 검증.)
RID2=ci-trace-bc; rm -rf "$ROOT/runs/$RID2"
# M4: gate.sh review 는 gate=review 에서만(승인 우회 차단). brief 단안은 approve 로 review 게이트 진입 후
#   id 없는 verdict(서브에이전트가 쓴 것 모사) + gate.sh review 직접 호출의 id-optional back-compat 을 검증.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID2" && bash scripts/run-stage.sh brief "$RID2" \
  && bash scripts/approve.sh "$RID2" --ra-ok ) >/dev/null 2>&1
VP2="$ROOT/runs/$RID2/01-brief/brief-verdict.json"
python3 -c "
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import atomic_write_json
atomic_write_json('$VP2', {'verdict':'pass','engine':'subagent','confidence':0.9,'violations':[],'escalate':False})
"
check "(B1) id 없는 verdict 스키마 통과(back-compat)" "python3 '$H' validate '$VP2' >/dev/null 2>&1"
( cd "$ROOT" && bash scripts/gate.sh "$RID2" review ) >/dev/null 2>&1
# M4: 단안(brief) review-pass = advance(02-concept). id 없어도 전이가 성공함을 검증(전진 = 전이 성공).
check "(B1) gate.sh review(직접) → id 없어도 전이 성공(advance 02-concept)" "[ \"$(jq_phase "$RID2" phase)\" = '02-concept' ]"
BCVID="$(python3 -c "
import json
h=json.load(open('$ROOT/runs/$RID2/state.json'))['history']
rev=[e for e in h if e['event'].startswith('review:')]
print('HAS' if (rev and 'verdict_id' in rev[-1]) else 'NONE')
")"
check "(B1) id 없는 verdict → history.verdict_id 생략(gate.sh id-optional)" "[ \"$BCVID\" = 'NONE' ]"

# ── (B2) idempotent 완료마커: id 없는(미완성/구버전) verdict 는 재심의 생략하지 '않고' 재심의 → 완성(id 보유) verdict 생성 ──
#   (재개 fail-open 의 근본 차단 — schema-pass 라도 완료마커 없으면 신뢰하지 않는다.)
RID3=ci-trace-rev; rm -rf "$ROOT/runs/$RID3"
# M4: 단안(brief) 은 승인 뒤 심의. id 없는 verdict 를 남겨도 kcia-check 가 재심의해 완성 verdict 를 만든다.
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" "$RID3" && bash scripts/run-stage.sh brief "$RID3" && bash scripts/approve.sh "$RID3" --ra-ok ) >/dev/null 2>&1
VP3="$ROOT/runs/$RID3/01-brief/brief-verdict.json"
python3 -c "
import sys; sys.path.insert(0,'$ROOT/scripts/lib')
from harness import atomic_write_json
atomic_write_json('$VP3', {'verdict':'pass','engine':'subagent','confidence':0.9,'violations':[],'escalate':False})
"
( cd "$ROOT" && bash scripts/kcia-check.sh "$RID3" ) >/dev/null 2>&1
check "(B2) id 없는 verdict → kcia-check 재심의 → 완성 verdict(id 보유)" "[ -n \"$(python3 "$H" jget "$VP3" id 2>/dev/null || true)\" ] && [ \"$(python3 "$H" jget "$VP3" id 2>/dev/null)\" != 'null' ]"
# M4: 재심의 통과 = advance(02-concept).
check "(B2) 재심의 후 게이트 전이(advance 02-concept)" "[ \"$(jq_phase "$RID3" phase)\" = '02-concept' ]"

rm -rf "$ROOT/runs/$RID" "$ROOT/runs/$RID2" "$ROOT/runs/$RID3"
printf '\n[trace-verdict-id] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
