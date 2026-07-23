#!/usr/bin/env bash
# test-b1e.sh — 00e-evidence 조건부 페이즈(G5: 문서만 첨부 → 자동 제안 → 승인 → pending 해소) 라우팅·게이트 E2E.
#   test-b1g(00g) 미러. 검증: (route) pending 참조 문서 → 00e 진입 · (propose) run-stage evidence 제안 생성 ·
#   (resolve) approve→kcia autopass→apply-proposal 로 pending 해소 후 01-brief 전진 · (chain) pending+examples →
#   00e→00g 연쇄 · (skip) 근거 없음 → 00e 미출현(backward-compat). 헤르메틱·번들 비의존·HARNESS_OFFLINE=1.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 00e-evidence 조건부 페이즈 — 문서만 주면 자동 제안·승인·해소(G5)"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-b1e-* 2>/dev/null || true; }
trap cleanup EXIT

# ── 헤르메틱 픽스처(번들 비의존) ──
BUNDLE_MIN="$SCRATCH/bundle"; mkdir -p "$BUNDLE_MIN" "$SCRATCH/assets"
cat > "$BUNDLE_MIN/product.json" <<'JSON'
{"name":"[브랜드] 테스트 릴리프","collectedReviewCount":2,"totalReviewCount":2,"rating":4.5,"price":{"current":12000}}
JSON
cat > "$BUNDLE_MIN/reviews.csv" <<'CSV'
content,score,option
"커버 좋고 촉촉해요",5,"기본"
"밀착 잘되고 커버력 좋아요",5,"기본"
"촉촉하고 화사해요",4,"기본"
"매일 쓰기 좋고 촉촉함",5,"기본"
"커버 자연스럽고 밀착 좋음",4,"기본"
"촉촉 커버 밀착 다 좋아요",5,"기본"
CSV
cat > "$SCRATCH/wb.md" <<'MD'
# 워킹백워드 — 00e E2E 픽스처
## 제품 개요
- 제품유형: 색조화장품(쿠션)
- 핵심 사용 가치: 순한 사용감, 데일리
MD
# 문서만 첨부(반영점 미정, kind=general) → 인입이 spec_status:pending 으로 기록해야 한다.
EVDIR="$SCRATCH/ev"; mkdir -p "$EVDIR"; printf 'ref doc bytes' > "$EVDIR/ref.png"
printf '{"ref.png":{"reflect":true,"kind":"general","claim":"참조 문서 내용"}}' > "$EVDIR/index.json"

_ENV=(HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm
      HARNESS_WB="$SCRATCH/wb.md" HARNESS_ASSETS_DIR="$SCRATCH/assets")

ingest_pending() {  # <rid> [examples_dir] — 문서만 첨부 인입(→ pending → 00e)
  local rid="$1" exdir="${2:-$HERMETIC_EXAMPLES}"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$exdir" HARNESS_EVIDENCE_DIR="$EVDIR" &&
    bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$rid" ) >/dev/null 2>&1
}
resolve_00e() {  # <rid> — 00e 제안 생성 → 승인 → 규정점검(autopass→apply-proposal→advance)
  local rid="$1"
  ( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$EVDIR" &&
    bash scripts/run-stage.sh evidence "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid"
  ) >/dev/null 2>&1
}

# ── (route) 문서만 첨부 → pending → 00e-evidence 진입 ──
echo "# (route) 문서만 첨부 → 00e-evidence 진입"
ingest_pending ci-b1e-r; RC=$?
check "(route) 인입 성공(rc=0)" "[ $RC -eq 0 ]"
check "(route) pending → phase=00e-evidence(01-brief/00g 아님)" "[ \"\$(jq_phase ci-b1e-r phase)\" = '00e-evidence' ]"
R="$ROOT/runs/ci-b1e-r"
python3 -c "import json,sys;d=json.load(open('$R/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if d.get('spec_status')=='pending' else 1)"; RC=$?
check "(route) 매니페스트 doc spec_status=pending" "[ $RC -eq 0 ]"

# ── (propose) run-stage evidence → 제안 생성 + gate=user(단안 승인) ──
echo "# (propose) 제안 생성(stub) + 단안 승인 게이트"
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$EVDIR" && bash scripts/run-stage.sh evidence ci-b1e-r ) >/dev/null 2>&1; RC=$?
check "(propose) run-stage evidence 성공" "[ $RC -eq 0 ]"
check "(propose) reflection-proposal.json 생성" "[ -f '$R/00e-evidence/reflection-proposal.json' ]"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/harness.py validate "$R/00e-evidence/reflection-proposal.json" ) >/dev/null 2>&1; RC=$?
check "(propose) 제안이 reflection-proposal 스키마 통과" "[ $RC -eq 0 ]"
check "(propose) 생성 후 단안 승인 게이트(gate=user)" "[ \"\$(jq_phase ci-b1e-r gate)\" = 'user' ]"

# ── (resolve) 승인 → 규정점검(면제 autopass → apply-proposal) → pending 해소 + 01-brief 전진 ──
echo "# (resolve) 승인·규정점검 → pending 해소 → 01-brief"
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$EVDIR" &&
  bash scripts/approve.sh ci-b1e-r && bash scripts/kcia-check.sh ci-b1e-r ) >/dev/null 2>&1; RC=$?
check "(resolve) 승인+규정점검 성공(rc=0)" "[ $RC -eq 0 ]"
check "(resolve) 00e 통과 후 phase=01-brief(examples 없음)" "[ \"\$(jq_phase ci-b1e-r phase)\" = '01-brief' ]"
python3 - "$R" <<'PY' && pass "(resolve) pending 해소·spec_origin=agent_proposed_human_approved·reflection_points 채움" || fail "(resolve) pending 미해소/스펙 오류"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if "spec_status" not in d and d.get("spec_origin") == "agent_proposed_human_approved"
        and d.get("kind") != "test_report" and len(d.get("reflection_points") or []) >= 1 else 1)
PY
# 일반 문서는 claim-basis 미승격(안전 불변식) — 해소 후에도 doc-* 부재
python3 -c "import json,sys;cb=json.load(open('$R/00-ingest/claim-basis.json'));sys.exit(0 if not any(str(e.get('id','')).startswith('doc-') for e in cb['evidence_on_file']) else 1)"; RC=$?
check "(resolve) 해소된 일반 문서 claim-basis 미승격(각주 채널)" "[ $RC -eq 0 ]"

# ── (chain) pending + 동일 도메인 사례 → 00e 해소 후 00g-guideline 로 연쇄 ──
echo "# (chain) pending + examples → 00e → 00g-guideline"
EXDIR="$SCRATCH/examples/cosmetic/ex1"; mkdir -p "$EXDIR"; printf 'example bundle marker' > "$EXDIR/marker.txt"
ingest_pending ci-b1e-c "$SCRATCH/examples"; RC=$?
check "(chain) 인입 성공" "[ $RC -eq 0 ]"
check "(chain) pending 우선 → 먼저 00e-evidence(examples 있어도)" "[ \"\$(jq_phase ci-b1e-c phase)\" = '00e-evidence' ]"
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$SCRATCH/examples" HARNESS_EVIDENCE_DIR="$EVDIR" &&
  bash scripts/run-stage.sh evidence ci-b1e-c && bash scripts/approve.sh ci-b1e-c && bash scripts/kcia-check.sh ci-b1e-c ) >/dev/null 2>&1; RC=$?
check "(chain) 00e 해소 성공(rc=0)" "[ $RC -eq 0 ]"
check "(chain) 00e 다음 = 00g-guideline(examples 존재 → 연쇄)" "[ \"\$(jq_phase ci-b1e-c phase)\" = '00g-guideline' ]"

# ── (skip) 근거 문서 없음 → 00e 미출현(backward-compat) ──
echo "# (skip) 근거 없음 → 00e 미출현"
rm -rf "$ROOT/runs/ci-b1e-s"
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" &&
  bash scripts/ingest-bundle.sh "$BUNDLE_MIN" ci-b1e-s ) >/dev/null 2>&1; RC=$?
check "(skip) no-evidence 인입 성공" "[ $RC -eq 0 ]"
check "(skip) 근거 없음 → 곧장 01-brief(00e 건너뜀)" "[ \"\$(jq_phase ci-b1e-s phase)\" = '01-brief' ]"
check "(skip) run.md 에 00e 미출현(backward-compat)" "! grep -q '00e-evidence' '$ROOT/runs/ci-b1e-s/run.md'"

# ── (stale) 재-인입 시 이전 00e 제안 무효화(내용 변경·같은 파일명 stale 방지 — Codex P1) ──
#   evidence-docs (재)인입은 이전 reflection-proposal.json 을 항상 지워 run-stage evidence 재생성을 강제한다
#   → 같은 파일명이라도 내용(sha256)이 바뀌면 옛 발췌가 규제 산출물로 새지 않는다.
echo "# (stale) 재-인입 → 이전 제안 무효화"
STR="$ROOT/runs/ci-b1e-st"; rm -rf "$STR"; mkdir -p "$STR/00e-evidence"
printf '{"docs":[{"id":"doc-01","filename":"ref.png","kind":"general","claim":"OLD","reflection_points":["OLD STALE POINT"]}]}' > "$STR/00e-evidence/reflection-proposal.json"
SSRC="$SCRATCH/evstale"; rm -rf "$SSRC"; mkdir -p "$SSRC"; printf 'changed content v2 bytes' > "$SSRC/ref.png"
printf '{"ref.png":{"reflect":true,"kind":"general","claim":"참조"}}' > "$SSRC/index.json"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py evidence-docs ci-b1e-st --src "$SSRC" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1
check "(stale) 재-인입(evidence-docs) → 이전 제안 무효화(재생성 강제)" "[ ! -f '$STR/00e-evidence/reflection-proposal.json' ]"
check "(stale) 재-인입 후 매니페스트는 다시 pending(재제안 대상)" "python3 -c \"import json,sys;d=json.load(open('$STR/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if d.get('spec_status')=='pending' else 1)\""

# ═══════════════════════════════════════════════════════════════════════════════════════════
# W-3 (00e 스펙 2차 관문 = 구 P-6): 시험성적서 intent-only 선언 → 00e 스펙 초안 제안 → 승인 → 추출·승격.
#   안전 불변식: 규제 성격 선언=사람 · 상세 추출=에이전트 · 확정=사람 승인.
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "# ── W-3: 시험성적서 스펙 2차 관문 ──"

# 유효 PNG(추출 raster 복사 경로의 매직바이트 검증 통과 — 89 50 4E 47 0D 0A 1A 0A) + 패딩(비-0바이트).
TRDIR="$SCRATCH/evtr"; mkdir -p "$TRDIR"
printf '\x89PNG\r\n\x1a\n valid-png-padding-for-test' > "$TRDIR/report.png"
# intent-only: 사람은 'kind:test_report' 만 선언(상세 생략) → 인입이 spec_status:pending 으로 기록해야 한다.
printf '{"report.png":{"reflect":true,"kind":"test_report"}}' > "$TRDIR/index.json"

ingest_tr() {  # <rid> <evdir> — intent-only(또는 완전선언) test_report 인입
  local rid="$1" evdir="$2"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$evdir" &&
    bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$rid" ) >/dev/null 2>&1
}

# ── (a) intent-only test_report → pending → 00e 스펙 초안(stub) → 승인 → 추출·승격(doc-01 + doc-01-t01) ──
echo "# (a) intent-only 시험성적서 → pending → 00e 초안 → 승인 → 추출·승격"
ingest_tr ci-b1e-tr "$TRDIR"; RC=$?
check "(a) intent-only 인입 성공(rc=0)" "[ $RC -eq 0 ]"
check "(a) pending → phase=00e-evidence" "[ \"\$(jq_phase ci-b1e-tr phase)\" = '00e-evidence' ]"
TR="$ROOT/runs/ci-b1e-tr"
python3 - "$TR" <<'PY' && pass "(a) 매니페스트 doc-01 kind=test_report·spec_status=pending·verdict_text/test_report 미기록" || fail "(a) intent pending 매니페스트 오류"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
ok = d.get("kind") == "test_report" and d.get("spec_status") == "pending"
ok = ok and "verdict_text" not in d and "test_report" not in d  # 스키마 null 금지 → 미기록
sys.exit(0 if ok else 1)
PY

# (d) 승인 전 하류 진출 차단(pending choke 재확인) — advance-phase 로 01-brief 점프 시도 → 거부·phase 불변.
echo "# (d) 승인 전 하류 진출 차단(pending choke)"
python3 -c "import json,sys;print('1' if __import__('subprocess').run(['bash','$ROOT/scripts/advance-phase.sh','ci-b1e-tr','--to','01-brief'],cwd='$ROOT',capture_output=True).returncode!=0 else '0')" | grep -q 1 && pass "(d) pending 중 01-brief 점프 거부" || fail "(d) pending 중 하류 진출이 막히지 않음"
check "(d) 거부 후에도 phase=00e-evidence 불변" "[ \"\$(jq_phase ci-b1e-tr phase)\" = '00e-evidence' ]"

# 00e 스펙 초안 생성(stub) → test_report 제안(kind=test_report + test_report 객체) 확인.
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$TRDIR" && bash scripts/run-stage.sh evidence ci-b1e-tr ) >/dev/null 2>&1; RC=$?
check "(a) run-stage evidence 성공(test_report 초안)" "[ $RC -eq 0 ]"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/harness.py validate "$TR/00e-evidence/reflection-proposal.json" ) >/dev/null 2>&1
check "(a) 초안이 reflection-proposal 스키마 통과" "[ $? -eq 0 ]"
python3 - "$TR" <<'PY' && pass "(a) 초안 doc kind=test_report + verdict_text/grade/기관·n·기간·test_items" || fail "(a) test_report 초안 필드 누락"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00e-evidence/reflection-proposal.json")))["docs"][0]
tr = d.get("test_report") or {}
ok = d.get("kind") == "test_report" and (d.get("verdict_text") or "").strip() and (d.get("grade") or "").strip()
ok = ok and tr.get("institution") and isinstance(tr.get("sample_size"), int) and tr.get("duration")
ok = ok and len(tr.get("test_items") or []) >= 1
sys.exit(0 if ok else 1)
PY

# 승인 → 규정점검(면제 autopass → apply-proposal → 추출·승격 → state 재동기화 → 01-brief 전진).
( cd "$ROOT" && export "${_ENV[@]}" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" HARNESS_EVIDENCE_DIR="$TRDIR" &&
  bash scripts/approve.sh ci-b1e-tr && bash scripts/kcia-check.sh ci-b1e-tr ) >/dev/null 2>&1; RC=$?
check "(a) 승인+규정점검 성공(rc=0)" "[ $RC -eq 0 ]"
check "(a) 해소 후 phase=01-brief(00e 통과)" "[ \"\$(jq_phase ci-b1e-tr phase)\" = '01-brief' ]"
python3 - "$TR" <<'PY' && pass "(a) 매니페스트 pending 해소·kind=test_report·verdict_text/test_report 확정·spec_origin=agent_proposed_human_approved" || fail "(a) 해소 매니페스트 오류"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
tr = d.get("test_report") or {}
ok = "spec_status" not in d and d.get("kind") == "test_report"
ok = ok and d.get("spec_origin") == "agent_proposed_human_approved"
ok = ok and (d.get("verdict_text") or "").strip() and tr.get("institution") and tr.get("sample_size") and tr.get("duration")
sys.exit(0 if ok else 1)
PY
python3 - "$TR" <<'PY' && pass "(a) claim-basis 승격: doc-01(부모) + doc-01-t01(항목)" || fail "(a) claim-basis 승격 누락"
import sys, json, os
cb = json.load(open(os.path.join(sys.argv[1], "00-ingest/claim-basis.json")))
ids = [e.get("id") for e in cb.get("evidence_on_file") or []]
sys.exit(0 if "doc-01" in ids and "doc-01-t01" in ids else 1)
PY
# (e) raster(png) test_report + image_ref → 추출 경로(poppler 불요) → doc-01-t01.image_path 결박.
echo "# (e) raster png test_report image_ref → 추출·image_path 결박"
python3 - "$TR" <<'PY' && pass "(e) 추출 이미지 자산 존재 + doc-01-t01.image_path 결박(inputs/assets/evidence/)" || fail "(e) 추출/결박 실패"
import sys, json, os
r = sys.argv[1]
cb = json.load(open(os.path.join(r, "00-ingest/claim-basis.json")))
t01 = next((e for e in cb.get("evidence_on_file") or [] if e.get("id") == "doc-01-t01"), None)
ip = (t01 or {}).get("image_path")
ok = bool(ip) and ip.startswith("inputs/assets/evidence/") and os.path.isfile(os.path.join(r, ip))
sys.exit(0 if ok else 1)
PY
# state.product.evidence_on_file 가 claim-basis 와 재동기화(doc-01·doc-01-t01 포함) — gate.sh(셸)가 기록.
python3 - "$TR" <<'PY' && pass "(a) state.product.evidence_on_file 재동기화(doc-01·doc-01-t01)" || fail "(a) state evidence_on_file 미동기화"
import sys, json, os
st = json.load(open(os.path.join(sys.argv[1], "state.json")))
eof = st.get("product", {}).get("evidence_on_file") or []
sys.exit(0 if "doc-01" in eof and "doc-01-t01" in eof else 1)
PY

# ── (b) bare 일반 문서의 제안이 kind=test_report 로 승격 시도 → fail-closed(intent 선언 필요) ──
echo "# (b) bare 일반 문서 → test_report 승격 시도 → fail-closed(intent 선언 필요)"
ingest_pending ci-b1e-b; RC=$?   # EVDIR = 일반 문서(kind=general) → pending
check "(b) bare 일반 문서 인입 성공(pending)" "[ $RC -eq 0 ]"
BB="$ROOT/runs/ci-b1e-b"; mkdir -p "$BB/00e-evidence"
# 악의적 제안: general pending 문서(doc-01)를 kind=test_report 로 승격 시도(스펙 완전).
printf '{"docs":[{"id":"doc-01","filename":"ref.png","kind":"test_report","claim":"승격 시도","verdict_text":"적합함","grade":"인체적용시험","reflection_points":["원문 발췌"],"test_report":{"institution":"기관","sample_size":10,"duration":"1주"}}],"spec_origin":"agent_proposed_human_approved"}' > "$BB/00e-evidence/reflection-proposal.json"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-b1e-b 00e-evidence ) >/dev/null 2>&1
check "(b) validate-stage 00e 거부(intent-match 위반)" "[ $? -ne 0 ]"
BOUT="$( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-proposal ci-b1e-b 2>&1 )"; RC=$?
check "(b) apply-proposal 거부(rc≠0)" "[ $RC -ne 0 ]"
check "(b) 거부 메시지에 'intent 선언 필요'" "printf '%s' \"\$BOUT\" | grep -q 'intent 선언 필요'"
python3 -c "import json,sys;d=json.load(open('$BB/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if d.get('spec_status')=='pending' and d.get('kind')!='test_report' else 1)"; RC=$?
check "(b) 거부 후 매니페스트 불변(여전히 pending·kind≠test_report)" "[ $RC -eq 0 ]"

# ── (c) 완전 선언 test_report(explicit kind 없음·상세 완비) → 00e 미경유(기존 즉시 승격 경로 불변) ──
echo "# (c) 완전 선언 test_report → 00e 미경유(즉시 승격)"
CTRDIR="$SCRATCH/evctr"; mkdir -p "$CTRDIR"; printf 'complete test report bytes' > "$CTRDIR/suit.png"
printf '{"suit.png":{"grade":"인체적용시험","reflect":true,"claim":"피부 사용 적합","verdict_text":"피부 사용에 적합함","test_report":{"institution":"P&K","sample_size":22,"duration":"1주","measured_values":null}}}' > "$CTRDIR/index.json"
ingest_tr ci-b1e-fc "$CTRDIR"; RC=$?
check "(c) 완전 선언 인입 성공(rc=0)" "[ $RC -eq 0 ]"
check "(c) 완전 선언 → 곧장 01-brief(00e 건너뜀)" "[ \"\$(jq_phase ci-b1e-fc phase)\" = '01-brief' ]"
check "(c) run.md 에 00e 미출현(즉시 경로)" "! grep -q '00e-evidence' '$ROOT/runs/ci-b1e-fc/run.md'"
python3 - "$ROOT/runs/ci-b1e-fc" <<'PY' && pass "(c) 인입 즉시 claim-basis doc-01 승격(spec_status 없음)" || fail "(c) 즉시 승격 경로 깨짐"
import sys, json, os
r = sys.argv[1]
d = json.load(open(os.path.join(r, "00-ingest/evidence-documents.json")))["documents"][0]
cb = json.load(open(os.path.join(r, "00-ingest/claim-basis.json")))
ids = [e.get("id") for e in cb.get("evidence_on_file") or []]
sys.exit(0 if "spec_status" not in d and d.get("kind") == "test_report" and "doc-01" in ids else 1)
PY

# ── (P1·Codex 3R) 사람이 kind:test_report 로 선언한 pending 문서를 general 제안으로 '강등' 시도 → fail-closed ──
#   case (b) 의 역방향(그건 general→test_report 승격 차단). 규제 성격을 조용히 일반 참조로 바꿔 verdict_text/승격을 잃는 것 방지.
echo "# (P1) test_report intent → general 제안 강등 시도 → 거부"
ingest_tr ci-b1e-p1 "$TRDIR" >/dev/null 2>&1
P1R="$ROOT/runs/ci-b1e-p1"; mkdir -p "$P1R/00e-evidence"
printf '{"docs":[{"id":"doc-01","filename":"report.png","kind":"general","claim":"일반 참조로 강등 시도","reflection_points":["원문 발췌"]}],"spec_origin":"agent_proposed_human_approved"}' > "$P1R/00e-evidence/reflection-proposal.json"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-b1e-p1 00e-evidence ) >/dev/null 2>&1
check "(P1) validate-stage 00e 강등 거부(승인 전 차단, wedge 방지)" "[ $? -ne 0 ]"
P1OUT="$( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-proposal ci-b1e-p1 2>&1 )"; RC=$?
check "(P1) general 제안 강등 → apply-proposal 거부(rc≠0)" "[ $RC -ne 0 ]"
check "(P1) 거부 메시지에 '강등할 수 없습니다'" "printf '%s' \"\$P1OUT\" | grep -q '강등할 수 없습니다'"
python3 -c "import json,sys;d=json.load(open('$P1R/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if d.get('spec_status')=='pending' and d.get('kind')=='test_report' else 1)"; RC=$?
check "(P1) 거부 후 매니페스트 불변(pending·kind=test_report 유지)" "[ $RC -eq 0 ]"

# ── (P2·Codex 3R) 잘못된 image_ref(다중 페이지)로 추출 실패 → pending 디스크 보존(wedge 방지) → 고친 제안 재적용 성공 ──
#   추출을 매니페스트 기록 '앞'에 둬, 실패 시 pending 이 디스크에 남아 재시도가 고친 image_ref 를 재병합할 수 있다.
echo "# (P2) 추출 실패 시 pending 보존 → 고친 제안 재적용"
ingest_tr ci-b1e-p2 "$TRDIR" >/dev/null 2>&1
P2R="$ROOT/runs/ci-b1e-p2"; mkdir -p "$P2R/00e-evidence"
# ⚠ JSON 에 '%'("unit":"%") 가 있으므로 printf 금지(포맷 지시자 오해석으로 잘림) — heredoc 로 원문 그대로 기록.
cat > "$P2R/00e-evidence/reflection-proposal.json" <<'JSON'
{"docs":[{"id":"doc-01","filename":"report.png","kind":"test_report","claim":"수분 개선","verdict_text":"수분 개선에 도움을 줌","grade":"인체적용시험","reflection_points":["수분 개선에 도움을 줌"],"test_report":{"institution":"P&K","sample_size":10,"duration":"1주","test_items":[{"metric":"수분","unit":"%","image_ref":{"pages":[1,2]}}]}}],"spec_origin":"agent_proposed_human_approved"}
JSON
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-b1e-p2 00e-evidence ) >/dev/null 2>&1
check "(P2) validate-stage 00e 다중페이지 거부(승인 전 차단, wedge 방지)" "[ $? -ne 0 ]"
P2OUT="$( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-proposal ci-b1e-p2 2>&1 )"; RC=$?
check "(P2) 다중 페이지 image_ref → apply-proposal 실패(rc≠0)" "[ $RC -ne 0 ]"
check "(P2) 실패 사유=다중 페이지(추출 게이트, JSON 오류 아님)" "printf '%s' \"\$P2OUT\" | grep -q '한 페이지만 허용'"
python3 -c "import json,sys;d=json.load(open('$P2R/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if d.get('spec_status')=='pending' else 1)"; RC=$?
check "(P2) 추출 실패 후 pending 디스크 보존(wedge 아님)" "[ $RC -eq 0 ]"
cat > "$P2R/00e-evidence/reflection-proposal.json" <<'JSON'
{"docs":[{"id":"doc-01","filename":"report.png","kind":"test_report","claim":"수분 개선","verdict_text":"수분 개선에 도움을 줌","grade":"인체적용시험","reflection_points":["수분 개선에 도움을 줌"],"test_report":{"institution":"P&K","sample_size":10,"duration":"1주","test_items":[{"metric":"수분","unit":"%","image_ref":{"pages":[1]}}]}}],"spec_origin":"agent_proposed_human_approved"}
JSON
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-proposal ci-b1e-p2 ) >/dev/null 2>&1; RC=$?
check "(P2) 고친 제안(단일 페이지) 재적용 성공(rc=0)" "[ $RC -eq 0 ]"
python3 -c "import json,sys;d=json.load(open('$P2R/00-ingest/evidence-documents.json'))['documents'][0];sys.exit(0 if 'spec_status' not in d and d.get('kind')=='test_report' else 1)"; RC=$?
check "(P2) 재적용 후 pending 해소·kind=test_report 확정" "[ $RC -eq 0 ]"

# ── (P2b·Codex 3R-3) 추출 실패가 '기존(다른 승인) 근거 자산'을 삭제하지 않는다(temp-swap 원자성) ──
echo "# (P2b) 추출 실패 시 기존 근거 자산 보존(원자성)"
python3 - "$ROOT" <<'PY' && pass "(P2b) 추출 실패해도 기존 evidence 자산 보존(temp-swap 원자성)" || fail "(P2b) 추출 실패가 기존 자산 삭제(비원자)"
import sys, os, tempfile, shutil
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import ingest
rdir = tempfile.mkdtemp()
ev = os.path.join(rdir, "inputs/assets/evidence"); os.makedirs(ev)
sentinel = os.path.join(ev, "doc-99-p1.png")
with open(sentinel, "wb") as f: f.write(b"\x89PNG\r\n\x1a\nPRIOR-APPROVED-ASSET")   # 이미 승인된 다른 시험성적서 추출물
dest = os.path.join(rdir, "inputs/evidence"); os.makedirs(dest)
with open(os.path.join(dest, "r.png"), "wb") as f: f.write(b"\x89PNG\r\n\x1a\nSRC")
# 다중 페이지 image_ref → _extract_test_images 가 SystemExit(항목당 1페이지). temp-swap 이면 real 디렉터리 미변경.
docs = [{"id": "doc-01", "nfc": "r.png", "ext": "png", "reflect": True, "kind": "test_report",
         "test_report": {"test_items": [{"metric": "x", "image_ref": {"pages": [1, 2]}}]}}]
raised = False
try:
    ingest._extract_test_images(docs, dest, ev, rdir)
except SystemExit:
    raised = True
# 실패 후: 기존 자산 보존 + temp 는 allowlist(inputs/assets) '밖'(rdir dotdir)이라 자산트리 미오염.
tmp = os.path.join(rdir, ".evidence-extract.tmp")
ok = raised and os.path.isfile(sentinel)
ok = ok and not os.path.exists(os.path.join(ev, ".tmp")) and not os.path.exists(ev + ".tmp")  # inputs/assets 안에 temp 없음
# 후속 no-target 호출(image_ref 제거) → temp 정리 + sentinel 은 no-target 이 evidence_assets_dir 제거하므로 별도 확인 생략.
ingest._extract_test_images([], dest, ev, rdir)
ok = ok and not os.path.exists(tmp)   # 후속 호출이 leaked temp 정리
shutil.rmtree(rdir, ignore_errors=True)
sys.exit(0 if ok else 1)
PY

printf '\n[b1e] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
