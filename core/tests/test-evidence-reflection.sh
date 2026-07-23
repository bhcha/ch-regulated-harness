#!/usr/bin/env bash
# test-evidence-reflection.sh — 근거 문서 내용 반영(첨부=반영) 오프라인 E2E (evidence-content-integration).
#   reflect:true 선언을 인입 → 오프라인 파이프라인 완주(done) → 반영이 최종 산출물에 실렸는지 결정적으로 증명.
#   DoD: ① 승격(claim-basis doc-01) ② done 도달(반영 강제 게이트 통과) ③ 반영 블록이 선택 HTML 에 존재
#        ④ export reflected_in 기록 + README 반영 표기 ⑤ 반영 없으면 done 차단(HTML-drop 백스톱).
#   ⚠ hermetic·번들 비의존: 시드 번들(naver_*) 없이 최소 합성 번들/WB/근거를 스스로 만들고 HARNESS_OFFLINE=1 로 돈다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 근거 문서 내용 반영 — 오프라인 E2E(첨부=반영 강제)"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-refl-* 2>/dev/null || true; }
trap cleanup EXIT

# ── hermetic 픽스처 ──
BUNDLE_MIN="$SCRATCH/bundle"; mkdir -p "$BUNDLE_MIN" "$SCRATCH/assets"
cat > "$BUNDLE_MIN/product.json" <<'JSON'
{"name":"[브랜드] 테스트 릴리프","collectedReviewCount":2,"totalReviewCount":2,"rating":4.5,"price":{"current":12000}}
JSON
# VOC 키워드(커버/촉촉/밀착/화사 — 안전 감각어; 효능어 아님)를 담아 stub 컨셉 key_messages 가 비지 않게 한다.
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
# 워킹백워드 — 반영 E2E 픽스처
## 제품 개요
- 제품유형: 색조화장품(쿠션)
- 핵심 사용 가치: 순한 사용감, 데일리
MD
# reflect:true 정성 선언(중립 판정문 — 오프라인 규제 deny-list 무저촉).
EVDIR="$SCRATCH/ev"; mkdir -p "$EVDIR"; printf '%%PDF-1.4\nsuit\n' > "$EVDIR/suit.pdf"
cat > "$EVDIR/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"피부 사용 적합","verdict_text":"피부 사용에 적합함","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"1주","measured_values":null}}}
JSON

# reflect:true 근거로 오프라인 파이프라인 완주(done). drive_to_done 형태 + HARNESS_EVIDENCE_DIR.
drive_refl() {
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      HARNESS_WB="$SCRATCH/wb.md" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" \
      HARNESS_EVIDENCE_DIR="$EVDIR" &&
    bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" B && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-outline "$rid" && bash scripts/select.sh "$rid" A && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-plan "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh keyvisual "$rid" && bash scripts/select.sh "$rid" A && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid"
  ) >/dev/null 2>&1
}

# ── (pos) 완주(done) + 반영 증명 ──
echo "# (pos) reflect:true 선언 런 완주 + 반영"
drive_refl ci-refl-pos; RC=$?
R="$ROOT/runs/ci-refl-pos"
check "(pos) 파이프라인 완주(rc=0)" "[ $RC -eq 0 ]"
check "(pos) done 도달" "[ \"\$(jq_phase ci-refl-pos phase)\" = 'done' ]"
# ① claim-basis 승격(doc-01)
python3 -c "import json,sys;cb=json.load(open('$R/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if 'doc-01' in ids else 1)"; RC=$?
check "(pos·①) claim-basis 에 doc-01 승격" "[ $RC -eq 0 ]"
# ③ 선택 HTML 의 clinicalEvidence 섹션에 판정문 원문/doc-id 존재(반영 블록 실림)
SEL="$(python3 -c "import json;print(json.load(open('$R/04-keyvisual/decision.json'))['selected'])" 2>/dev/null || echo A)"
HTML="$R/04-keyvisual/options/$SEL/index.html"
check "(pos·③) 선택 HTML 에 판정문 원문(피부 사용에 적합함) 존재" "grep -q '피부 사용에 적합함' '$HTML'"
check "(pos·③) 선택 HTML 에 doc-01 인용 존재" "grep -q 'doc-01' '$HTML'"
# ④ export reflected_in + README 반영 표기
python3 - "$R" <<'PY' && pass "(pos·④) package evidence_documents doc-01 reflect:true + reflected_in 비어있지 않음" || fail "(pos·④) reflected_in 누락"
import sys, json, os
pkg = json.load(open(os.path.join(sys.argv[1], "04-keyvisual/export/kcia-package/package.json")))
d = next((e for e in pkg.get("evidence_documents", []) if e.get("id") == "doc-01"), None)
sys.exit(0 if d and d.get("reflect") is True and d.get("reflected_in") else 1)
PY
check "(pos·④) README 반영 블록 열 존재" "grep -q '반영 블록' '$R/04-keyvisual/export/kcia-package/README.md'"
# doc-01 이 실증 근거 목록(evidence_list)에도 편입(첨부=실증 일관, 모순 없는 패키지)
python3 -c "import json,sys;pkg=json.load(open('$R/04-keyvisual/export/kcia-package/package.json'));ids=[e['id'] for e in pkg.get('evidence_list',[])];sys.exit(0 if 'doc-01' in ids else 1)"; RC=$?
check "(pos) doc-01 이 실증 근거 목록에도 편입(일관)" "[ $RC -eq 0 ]"

# ── (neg) 반영이 최종 HTML 에서 사라지면 done 게이트가 차단(백스톱) ──
echo "# (neg) 반영 HTML-drop → done 게이트 차단"
# 선택 HTML 의 clinicalEvidence 섹션 내용을 비워 반영을 제거(판정문·doc-id 삭제) → 게이트 재평가
python3 - "$HTML" <<'PY'
import sys, re
p = sys.argv[1]; html = open(p, encoding="utf-8").read()
# clinicalEvidence 섹션을 빈 섹션으로 치환(다른 섹션은 보존)
html = re.sub(r'<section data-block="clinicalEvidence"[^>]*>.*?</section>',
              '<section data-block="clinicalEvidence"></section>', html, flags=re.S)
open(p, "w", encoding="utf-8").write(html)
PY
NEG_OUT="$( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/check_evidence_reflection.py "runs/ci-refl-pos" 2>&1 )"; RC=$?
check "(neg) 반영 블록 내용 제거 → 반영 강제 게이트 차단(exit 1)" "[ $RC -ne 0 ]"
# O-6: 강화된 실패 메시지 — 어긋난 쌍(doc-id · plan 인용 블록 · 근거 문장 발췌) + '기획안도 함께 고쳐' 동반갱신 안내.
check "(O-6) 실패 메시지에 doc-01 명시" "echo \"\$NEG_OUT\" | grep -q 'doc-01'"
check "(O-6) 실패 메시지에 plan 인용 블록(clinicalEvidence) 명시" "echo \"\$NEG_OUT\" | grep -q 'clinicalEvidence'"
check "(O-6) 실패 메시지에 근거 문장 발췌(판정문 원문)" "echo \"\$NEG_OUT\" | grep -q '피부 사용에 적합함'"
check "(O-6) 실패 메시지에 '함께 고쳐' 동반갱신 안내" "echo \"\$NEG_OUT\" | grep -q '함께 고쳐'"

# ── (early) 반영 실패가 done 게이트가 아니라 validate-stage 04-keyvisual(조기 게이트)에서 차단됨을 증명 ──
#   defect fix: 반영 검사를 done 이전(approve 선택안 렌더·gate.sh:51 export 직전)에도 돌려, 반영 실패를
#   render+review+export 뒤 done 에서야 발견하던 것을 재렌더 가능한 시점(approve/export 前)에서 잡는다.
echo "# (early) 반영 실패 → validate-stage 04-keyvisual 조기 차단(done 게이트 이전)"
drive_refl ci-refl-early; RCE2=$?; ER="$ROOT/runs/ci-refl-early"
check "(early) 사전조건: reflect 런 완주(rc=0)" "[ $RCE2 -eq 0 ]"
# (before) 반영이 온전하면 validate-stage 04-keyvisual 통과 — 게이트가 무근거로 실패하지 않음을 먼저 확인.
( cd "$ROOT" && bash scripts/validate-stage.sh ci-refl-early 04-keyvisual ) >/dev/null 2>&1; RCB=$?
check "(early·before) 반영 온전 → validate-stage 04-keyvisual 통과" "[ $RCB -eq 0 ]"
# 선택 HTML 의 clinicalEvidence 섹션을 비워 반영 제거(판정문·doc-id 삭제) — 이 런은 이미 done 을 지났다.
SELE="$(python3 -c "import json;print(json.load(open('$ER/04-keyvisual/decision.json'))['selected'])" 2>/dev/null || echo A)"
HTMLE="$ER/04-keyvisual/options/$SELE/index.html"
python3 - "$HTMLE" <<'PY'
import sys, re
p = sys.argv[1]; html = open(p, encoding="utf-8").read()
html = re.sub(r'<section data-block="clinicalEvidence"[^>]*>.*?</section>',
              '<section data-block="clinicalEvidence"></section>', html, flags=re.S)
open(p, "w", encoding="utf-8").write(html)
PY
# (after) 조기 게이트(validate-stage 04-keyvisual)가 반영 실패를 잡는다(exit≠0) — done 게이트가 아니라 여기서.
EARLY_OUT="$( cd "$ROOT" && bash scripts/validate-stage.sh ci-refl-early 04-keyvisual 2>&1 )"; RCA=$?
check "(early·after) 반영 제거 → validate-stage 04-keyvisual 차단(exit≠0, done 게이트 이전)" "[ $RCA -ne 0 ]"
# 차단 사유가 반영 실패(doc-01)임을 확인 — 다른 04 검사(min3·canon 등)가 아닌 반영 게이트가 잡았음을 고정.
check "(early·after) 차단 사유가 반영 실패(doc-01 명시)" "echo \"\$EARLY_OUT\" | grep -q 'doc-01'"

# ── (gen) 일반 참조 문서(kind=brand_story) E2E — 각주 채널·brandBanner 반영·claim-basis 미승격 ──
echo "# (gen) 일반 참조 문서(brand_story) 오프라인 E2E"
GDIR="$SCRATCH/evg"; mkdir -p "$GDIR"; printf 'brand story bytes' > "$GDIR/brand.png"
cat > "$GDIR/index.json" <<'JSON'
{"brand.png":{"reflect":true,"kind":"brand_story","claim":"브랜드 개발 스토리","reflection_points":["피부과학 연구 15년의 노하우"]}}
JSON
drive_refl_g() {
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      HARNESS_WB="$SCRATCH/wb.md" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" \
      HARNESS_EVIDENCE_DIR="$GDIR" &&
    bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" B && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-outline "$rid" && bash scripts/select.sh "$rid" A && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-plan "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh keyvisual "$rid" && bash scripts/select.sh "$rid" A && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid"
  ) >/dev/null 2>&1
}
drive_refl_g ci-refl-gen; RCG=$?; G="$ROOT/runs/ci-refl-gen"
check "(gen) 파이프라인 완주(rc=0)" "[ $RCG -eq 0 ]"
check "(gen) done 도달" "[ \"\$(jq_phase ci-refl-gen phase)\" = 'done' ]"
python3 -c "import json,sys;cb=json.load(open('$G/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if not any(i.startswith('doc-') for i in ids) else 1)"; RC=$?
check "(gen) 일반 문서 claim-basis 미승격(각주 채널·안전 불변식)" "[ $RC -eq 0 ]"
SELG="$(python3 -c "import json;print(json.load(open('$G/04-keyvisual/decision.json'))['selected'])" 2>/dev/null || echo A)"
HG="$G/04-keyvisual/options/$SELG/index.html"
check "(gen) 선택 HTML 에 반영 포인트 원문(피부과학 연구 15년의 노하우) 존재" "grep -q '피부과학 연구 15년의 노하우' '$HG'"
check "(gen) 선택 HTML 에 doc-01 각주 인용 존재" "grep -q 'doc-01' '$HG'"
python3 - "$G" <<'PY' && pass "(gen) package evidence_documents doc-01 reflect:true + reflected_in 비어있지 않음" || fail "(gen) reflected_in 누락"
import sys, json, os
pkg = json.load(open(os.path.join(sys.argv[1], "04-keyvisual/export/kcia-package/package.json")))
d = next((e for e in pkg.get("evidence_documents", []) if e.get("id") == "doc-01"), None)
sys.exit(0 if d and d.get("reflect") is True and d.get("reflected_in") else 1)
PY
# (gen-neg) 반영 포인트 원문이 최종 HTML 에서 사라지면(doc-id 각주만 남아도) 게이트 차단 — 내용 생존 필수(Codex)
python3 - "$HG" <<'PY'
import sys
p = sys.argv[1]; html = open(p, encoding="utf-8").read()
open(p, "w", encoding="utf-8").write(html.replace("피부과학 연구 15년의 노하우", "믿을 수 있는 브랜드"))
PY
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/check_evidence_reflection.py "runs/ci-refl-gen" ) >/dev/null 2>&1; RC=$?
check "(gen-neg) 반영 포인트 원문 제거(doc-id 각주만) → 게이트 차단(내용 생존 필수)" "[ $RC -ne 0 ]"
# (gen-neg2) doc-id 각주 표식이 사라지면(내용만 남아도) 게이트 차단 — 추적성(인용) 생존 필수
drive_refl_g ci-refl-gen2; G2R="$ROOT/runs/ci-refl-gen2"
SELG2="$(python3 -c "import json;print(json.load(open('$G2R/04-keyvisual/decision.json'))['selected'])" 2>/dev/null || echo A)"
HG2="$G2R/04-keyvisual/options/$SELG2/index.html"
python3 - "$HG2" <<'PY'
import sys, re
p = sys.argv[1]; html = open(p, encoding="utf-8").read()
open(p, "w", encoding="utf-8").write(re.sub(r'doc-0*1', 'ref', html))   # doc-id 표식만 제거(반영 포인트 텍스트는 유지)
PY
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/check_evidence_reflection.py "runs/ci-refl-gen2" ) >/dev/null 2>&1; RC=$?
check "(gen-neg2) doc-id 각주 제거(내용만) → 게이트 차단(추적성 인용 생존 필수)" "[ $RC -ne 0 ]"

# ── (00e) 문서만 첨부(반영점 미정) → pending → 00e 자동 제안·승인·해소 → 완주(done) + 반영 ──
#   G5: 사람이 반영점을 안 적고 문서만 줘도 in-session 에이전트(stub)가 제안 → 승인 → 반영 포인트가 최종 산출물에 실린다.
echo "# (00e) 문서만 첨부 → 00e 자동 제안·승인·해소 → 완주"
EPDIR="$SCRATCH/evp"; mkdir -p "$EPDIR"; printf 'ref doc bytes' > "$EPDIR/ref.png"
printf '{"ref.png":{"reflect":true,"kind":"general","claim":"참조 문서 내용"}}' > "$EPDIR/index.json"
drive_00e_done() {
  local rid="$1"; rm -rf "$ROOT/runs/$rid"
  ( cd "$ROOT" && export HARNESS_CLI=claude HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm \
      HARNESS_WB="$SCRATCH/wb.md" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" \
      HARNESS_EVIDENCE_DIR="$EPDIR" &&
    bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$rid" &&
    bash scripts/run-stage.sh evidence "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" B && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-outline "$rid" && bash scripts/select.sh "$rid" A && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-plan "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh keyvisual "$rid" && bash scripts/select.sh "$rid" A && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid"
  ) >/dev/null 2>&1
}
drive_00e_done ci-refl-00e; RCE=$?; E="$ROOT/runs/ci-refl-00e"
check "(00e) 문서만 첨부 → 00e 자동 해소 → 완주(rc=0)" "[ $RCE -eq 0 ]"
check "(00e) done 도달" "[ \"\$(jq_phase ci-refl-00e phase)\" = 'done' ]"
python3 - "$E" <<'PY' && pass "(00e) 매니페스트 pending 해소·spec_origin=agent_proposed_human_approved" || fail "(00e) pending 미해소"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if "spec_status" not in d and d.get("spec_origin") == "agent_proposed_human_approved" else 1)
PY
python3 -c "import json,sys;cb=json.load(open('$E/00-ingest/claim-basis.json'));sys.exit(0 if not any(str(e.get('id','')).startswith('doc-') for e in cb['evidence_on_file']) else 1)"; RC=$?
check "(00e) 해소된 일반 문서 claim-basis 미승격(각주 채널)" "[ $RC -eq 0 ]"
python3 - "$E" <<'PY' && pass "(00e) package doc-01 reflect:true + reflected_in 비어있지 않음(제안 포인트가 최종 산출물에 반영)" || fail "(00e) reflected_in 누락 — 자동 제안 반영 실패"
import sys, json, os
pkg = json.load(open(os.path.join(sys.argv[1], "04-keyvisual/export/kcia-package/package.json")))
d = next((e for e in pkg.get("evidence_documents", []) if e.get("id") == "doc-01"), None)
sys.exit(0 if d and d.get("reflect") is True and d.get("reflected_in") else 1)
PY

printf '\n[evidence-reflection] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
