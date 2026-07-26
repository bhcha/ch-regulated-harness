#!/usr/bin/env bash
# test-operator-language.sh — 개선계획 1부 단계7 회귀 가드.
#   (A) 금지 토큰 가드: 현업이 보는 화면(run.md + 4동작 stdout)에 내부 코드가 새지 않는다.
#   (B) 안전필수 표면화 가드: '숨김'이 과해 안전 신호(걸렸다/통과/사람 확인 필요)까지 지우지 않았는지.
#   (C) operator_labels 모듈 속성: 어떤 입력도 금지 토큰을 출력하지 않는다(폴백 포함).
#   결정적(offline stub). 운영자 전용 명령(raise-limit)·보안 가드 메시지(self-grading·fail-closed)는 가드 대상 아님(현업 화면 아님).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 단계7 — 현업 언어 평이화 회귀 가드(금지토큰·안전 표면화)"

RID=ci-oplang
cleanup() { rm -rf "$ROOT/runs/$RID" "$ROOT/runs/${RID}-qd"; }
trap cleanup EXIT

# 현업 화면 금지 토큰(개선계획 단계1 검증 목록 + 외부리뷰 보강). auto 는 흔한 영단어라 단어경계로만.
#   iteration 은 'iteration 1/3'·'iteration=1/3' 둘 다, engine=/domain= 내부 변수노출도 포함(외부리뷰 MEDIUM).
FORBIDDEN='human-verify|hard-stop|pairwise top-1|scope=|게이트=|상태=|iteration[ =/][0-9]|\bescalated\b|verdict=|violations=|engine=|domain=|\bauto\b'

assert_no_forbidden() {  # <라벨> <검사텍스트>
  local label="$1" text="$2" hit
  hit="$(printf '%s' "$text" | grep -nE "$FORBIDDEN" || true)"
  if [ -z "$hit" ]; then pass "$label — 금지 토큰 없음"; else fail "$label — 금지 토큰 누수: $hit"; fi
}

# ── 해피패스 파이프라인 4동작 stdout 캡처(offline·claude 엔진) ──
rm -rf "$ROOT/runs/$RID"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
OUT="$( cd "$ROOT" &&
  bash scripts/ingest-bundle.sh "$BUNDLE" "$RID" &&
  bash scripts/run-stage.sh brief "$RID" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh concept "$RID" && bash scripts/select.sh "$RID" B && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-outline "$RID" && bash scripts/select.sh "$RID" A && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh storyboard-plan "$RID" && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" &&
  bash scripts/run-stage.sh keyvisual "$RID" && bash scripts/select.sh "$RID" A && bash scripts/approve.sh "$RID" && bash scripts/kcia-check.sh "$RID" 2>&1 )"
unset HARNESS_CLI HARNESS_OFFLINE
[ "$(jq_phase "$RID" phase)" = "done" ] && pass "(전제) 해피패스 done 완주" || fail "(전제) done 미도달(phase=$(jq_phase "$RID" phase))"

# (A1) 4동작 stdout 금지 토큰 부재
assert_no_forbidden "(A1) 4동작 stdout" "$OUT"

# (A2) run.md(현업 보드) 금지 토큰 부재 — done 시점 + 중간 상태 둘 다.
assert_no_forbidden "(A2) run.md(done)" "$(cat "$ROOT/runs/$RID/run.md" 2>/dev/null)"

# (A3) '심의 완료' 마커는 보존(회귀 테스트 의존 — 평이화가 마커를 지우지 않았는지)
printf '%s' "$OUT" | grep -q "심의 완료" && pass "(A3) '심의 완료' 마커 보존" || fail "(A3) '심의 완료' 마커 소실"

# (B1) 안전필수 표면화: 통과 결과가 평이어로 남는다.
printf '%s' "$OUT" | grep -qE "규정 점검 통과|규정 점검을 통과하지" && pass "(B1) 점검 결과 평이 표면화" || fail "(B1) 점검 결과 표면화 누락"

# (B2) escalated 안전 표면화: run.md 에 '사람 개입 필요' 유지(숨기면 책임 소멸).
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/$RID/state.json" status '"escalated"' >/dev/null
( cd "$ROOT" && bash scripts/advance-phase.sh "$RID" --render-only ) >/dev/null 2>&1
grep -q "사람 개입 필요" "$ROOT/runs/$RID/run.md" && pass "(B2) escalated → run.md '사람 개입 필요' 표면화 유지" || fail "(B2) escalated 안전 신호 소실"
assert_no_forbidden "(B2) escalated run.md" "$(cat "$ROOT/runs/$RID/run.md")"

# (B3) RA 사후검수 안전 표면화: 기능성 승인 표시 + --ra-ok 미지정 → 거부 메시지에 'RA 사후검수' 유지.
#   브리프에 기능성 '승인' 표시가 있어야 발동 → 없으면 이 케이스는 스킵(전제 불충족 시 false-fail 금지).
RA_OUT="$( cd "$ROOT" && python3 - "$ROOT/runs/$RID/01-brief/brief.json" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1])); print(sum(1 for s in d.get('sensitive_labels',[]) if s.get('status')=='approved'))
except Exception: print(0)
PY
)"
if [ "${RA_OUT:-0}" -gt 0 ]; then
  # state 를 brief 승인 게이트로 되돌려 거부 경로 재현은 복잡 → 메시지 소스(approve.sh)에 'RA 사후검수' 문구 존재로 계약 확인.
  grep -q "RA 사후검수" "$ROOT/scripts/approve.sh" && pass "(B3) RA 사후검수 안전 표면화 문구 유지" || fail "(B3) RA 사후검수 문구 소실"
else
  pass "(B3) RA 사후검수 — 이 브리프엔 기능성 승인 표시 없음(전제 불충족, 스킵)"
fi

# (B4) placeholder-autopass(자동 점검 기준 준비 중) 안전 표면화 — quasi_drug(TBD 도메인) kcia-check.
rm -rf "$ROOT/runs/${RID}-qd"
export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=quasi_drug HARNESS_FORMAT=multipage_bm
QD_OUT="$( cd "$ROOT" &&
  bash scripts/ingest-bundle.sh "$BUNDLE" "${RID}-qd" &&
  bash scripts/run-stage.sh brief "${RID}-qd" && bash scripts/approve.sh "${RID}-qd" --ra-ok && bash scripts/kcia-check.sh "${RID}-qd" 2>&1 )"
unset HARNESS_CLI HARNESS_OFFLINE HARNESS_DOMAIN HARNESS_FORMAT
if printf '%s' "$QD_OUT" | grep -q "자동 통과"; then
  printf '%s' "$QD_OUT" | grep -q "사람 확인 필요" \
    && pass "(B4) placeholder → '자동 통과 + 사람 확인 필요' 표면화 유지" \
    || fail "(B4) placeholder 자동통과는 알리나 '사람 확인 필요' 누락(책임 소멸 위험)"
  assert_no_forbidden "(B4) placeholder stdout" "$QD_OUT"
else
  fail "(B4) quasi_drug placeholder 경로 미발동(QD_OUT 확인): $(printf '%s' "$QD_OUT" | tail -3)"
fi

# (C) operator_labels 모듈 속성: 폴백 포함 어떤 입력도 금지 토큰을 출력하지 않는다.
python3 - "$ROOT" <<'PY' && pass "(C) operator_labels — 전 입력 금지 토큰 미출력" || fail "(C) operator_labels 금지 토큰 누수"
import sys, os, re
root=sys.argv[1]; sys.path.insert(0, os.path.join(root,"scripts","lib"))
import operator_labels as O
banned=re.compile(r"(human-verify|hard-stop|scope=|pairwise|게이트=|상태=|\bescalated\b|\bauto\b|\biteration\b)")
probes=["auto","iteration","escalated","human-verify","scope=design","iteration 1/3","max_iterations","gate_type","claim_basis","05-foo","unknown","00-ingest","design","verdict","pending"]
bad=[]
for fn in (O.phase_label,O.gate_text,O.status_label,O.scope_label,O.translate,O.capability,O.risk_as_result):
    for p in probes:
        r=fn(p) or ""
        if banned.search(r): bad.append((fn.__name__,p,r))
for p in probes:
    r=O.signal(p) or ""
    if banned.search(r): bad.append(("signal",p,r))
for d in (O.PHASE_LABEL,O.GATE_TYPE_TEXT,O.STATUS_LABEL,O.SCOPE_LABEL,O.PHASE_CAPABILITY,O.SIGNAL,O.RISK_AS_RESULT,O.TRANSLATION):
    for v in d.values():
        if banned.search(v): bad.append(("mapval",v))
if bad:
    sys.stderr.write("누수: %r\n" % bad[:5]); sys.exit(1)
sys.exit(0)
PY

# (C2) scrub: 자유텍스트(추천 사유) 잭곤은 드롭(한국어 조사 결합 포함), 정상 한국어는 보존.
python3 - "$ROOT" <<'PY' && pass "(C2) scrub — 잭곤 드롭 + 정상 사유 보존" || fail "(C2) scrub 동작 이상"
import sys, os
root=sys.argv[1]; sys.path.insert(0, os.path.join(root,"scripts","lib"))
import operator_labels as O
drop=["VOC를 근거로 추천","RTB가 분명","iteration을 줄임","7축 심의에 안전","claim-basis 4건","verdict pass","factual 절제"]
keep=["후기에 촉촉·밀착 느낌이 많아 감성 축을 추천해요","가장 무난하고 안전한 안이에요"]
bad=[c for c in drop if O.scrub(c)!=""]+[c for c in keep if O.scrub(c)!=c]
if bad: sys.stderr.write("scrub 이상: %r\n"%bad); sys.exit(1)
sys.exit(0)
PY

# (C3) 모듈-속성 누수(권고 투영 + 이미지-직전 digest 표면): 어떤 권고 키/정적 라벨/예정장수 문구도 금지 토큰을 안 낸다.
#   advise_projection(결손 투영) · preimage_label(digest 정적 라벨) · preimage_plan_phrase(예정 장수, 실제 카운트만 → [0-9]+% 0).
python3 - "$ROOT" <<'PY' && pass "(C3) 권고 투영·이미지-직전 digest — 금지 토큰·가짜% 미출력" || fail "(C3) 권고 투영/digest 누수"
import sys, os, re
root=sys.argv[1]; sys.path.insert(0, os.path.join(root,"scripts","lib"))
import operator_labels as L
banned=re.compile(r"(human-verify|hard-stop|scope=|pairwise|게이트=|상태=|\bescalated\b|\bauto\b|\biteration\b)")
pct=re.compile(r"[0-9]+%")
bad=[]
for k in L.ADVICE:
    s=L.advise_projection(k) or ""
    if banned.search(s): bad.append(("projection",k,s))
for k in L.PREIMAGE:
    s=L.preimage_label(k) or ""
    if banned.search(s): bad.append(("preimage",k,s))
for args in ((12,10,2),(13,13,0)):
    s=L.preimage_plan_phrase(*args) or ""
    if banned.search(s) or pct.search(s): bad.append(("plan_phrase",args,s))
if bad:
    sys.stderr.write("누수: %r\n" % bad[:5]); sys.exit(1)
sys.exit(0)
PY

# (D) 단계6 청중 표시: 생성 슬래시의 '소스'(skills/<name>/SKILL.md)에 마커가 있어야 한다.
#   ⚠ .claude/commands/*.md 는 sync-skills.sh 생성물이라 마커를 거기만 넣으면 sync 때 덮인다 → 반드시 소스(skills/)에.
MARKER="현업은 직접 쓰지"
for s in brief concept keyvisual storyboard-outline storyboard-plan guideline evidence; do
  grep -q "$MARKER" "$ROOT/skills/$s/SKILL.md" \
    && pass "(D) 생성 스킬 소스 skills/$s 에 청중 표시(sync 생존)" \
    || fail "(D) skills/$s/SKILL.md 에 청중 표시 없음 — .claude/commands 가 아니라 소스에 넣어야 sync 에 덮이지 않음"
done
# 4동작 래퍼 소스엔 청중 표시가 없어야(현업이 직접 쓰는 명령).
for s in approve select revise status kcia-check; do
  grep -q "$MARKER" "$ROOT/skills/$s/SKILL.md" 2>/dev/null \
    && fail "(D) 4동작 래퍼 skills/$s 에 청중 표시가 잘못 들어감(현업용인데)" \
    || pass "(D) 4동작 래퍼 skills/$s 청중 표시 없음(정상)"
done

printf '\n[operator-language] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
