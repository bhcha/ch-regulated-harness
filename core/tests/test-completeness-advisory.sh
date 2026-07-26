#!/usr/bin/env bash
# test-completeness-advisory.sh — 결손값 '권고(advisory)' 계층 회귀 가드(Phase A).
#   강제(fail-closed)는 그대로 두고 '제안+품질경고'를 표면화하는 읽기전용 계층이:
#   (1) 결손 시 뜨고 (2) run.md 에 노출 (3) 내부어 누수 0 (4) state/verdict 미기록(읽기전용)
#   (5) next-action 에 advisory 동봉 (6) 채우면 자가소멸 (7) 게이트(단일 레코드 5요소)와 정렬
#   (8) 이른 단계 노이즈 0 (9) operator_labels 권고 문구 내부어 누수 0.
#   결정적(offline stub). 산출물은 골든 아님.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 결손값 권고 계층(completeness_advisor + run.md + next-action)"

RID=ci-adv-reg
RDIR="$ROOT/runs/$RID"
cleanup() { rm -rf "$RDIR"; }
trap cleanup EXIT

mk() {  # mk <claim-basis-json> <voc-json> <phase>
  rm -rf "$RDIR"; mkdir -p "$RDIR/00-ingest"
  cat > "$RDIR/state.json" <<J
{"run_id":"$RID","phase":"$3","step":"generate","status":"generate","gate":"generate","awaiting":null,
 "storyboard_substage":"plan","iteration":1,"max_iterations":4,"revise_count":0,"history":[],
 "product":{"name":"t","regulatory_domain":"cosmetic","deliverable_format":"multipage_bm"}}
J
  printf '%s' "$1" > "$RDIR/00-ingest/claim-basis.json"
  printf '%s' "$2" > "$RDIR/00-ingest/voc.json"
}

adv() {  # adv <phase> → must_fill 개수/nice 개수/filled/total 를 'mf nice f t' 로 출력
  python3 - "$ROOT" "$RDIR" "$1" <<'PY'
import sys, os
root, rdir, phase = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import completeness_advisor as C
r = C.advise(rdir, {"phase": phase})
f, t = r["completeness"]
print("%d %d %d %d" % (len(r["must_fill"]), len(r["nice_to_have"]), f, t))
PY
}

# (1) 결손(임상 5요소·품질·voc 비어있음) → must_fill≥1 · nice≥1 · filled<total
mk '{"evidence_on_file":[{"id":"e","kind":"clinical_trial","before":50.0,"after":40.0}]}' '{}' '03-storyboard'
read MF NI F T <<<"$(adv 03-storyboard)"
check "(1) 결손 시 must_fill≥1·nice≥1·filled<total (mf=$MF nice=$NI $F/$T)" \
  "[ $MF -ge 1 ] && [ $NI -ge 1 ] && [ $F -lt $T ]"

# (2) run.md 권고 섹션 + 임상 필수 결손 안내
HARNESS_ROOT="$ROOT" python3 "$ROOT/scripts/lib/render_runmd.py" "$RID" "$RDIR" >/dev/null 2>&1
check "(2) run.md 권고 섹션 노출" "grep -q '보완하면 더 좋아요' '$RDIR/run.md'"
check "(2) run.md 임상 필수 결손 안내" "grep -q '임상 차트를 만들려면' '$RDIR/run.md'"

# (3) 내부어/필드코드 누수 0 (run.md 전체)
check "(3) run.md 권고에 내부 코드/필드명 누수 0" \
  "! grep -Eq 'institution|sample_size|change_pct|p_value|must_fill|nice_to_have|claim[-_]basis|evidence_ref' '$RDIR/run.md'"

# (4) 읽기전용 — state.json 불변, verdict 미생성
S1=$(shasum "$RDIR/state.json" | awk '{print $1}')
HARNESS_ROOT="$ROOT" python3 "$ROOT/scripts/lib/render_runmd.py" "$RID" "$RDIR" >/dev/null 2>&1
S2=$(shasum "$RDIR/state.json" | awk '{print $1}')
check "(4) render 가 state.json 안 바꿈(읽기전용)" "[ '$S1' = '$S2' ]"
# ⚠ 03-storyboard verdict 정본은 substage별(plan-verdict.json/outline-verdict.json) — 잘못된 경로 단언은 거짓통과(외부리뷰).
check "(4) verdict 미생성(정본 경로 plan/outline)" \
  "[ ! -f '$RDIR/03-storyboard/plan-verdict.json' ] && [ ! -f '$RDIR/03-storyboard/outline-verdict.json' ]"

# (5) next-action JSON advisory 필드(must_fill 동봉)
NA="$(cd "$ROOT" && HARNESS_OFFLINE=1 HARNESS_ROOT="$ROOT" bash scripts/next-action.sh "$RID" 2>/dev/null)"
NAOK="$(printf '%s' "$NA" | python3 -c 'import sys,json
d=json.load(sys.stdin); a=d.get("advisory")
print("OK" if a and a.get("must_fill") else "NO")')"
check "(5) next-action advisory 필드(must_fill 동봉)" "[ '$NAOK' = 'OK' ]"

# (6) 충족 → 권고 섹션 자가소멸
mk '{"evidence_on_file":[{"id":"e","kind":"clinical_trial","before":50.0,"after":40.0,"change_pct":-20.0,"p_value":"<0.05","institution":"가","sample_size":52,"duration":"4주"}]}' \
   '{"keyword_frequency":{"x":3},"product_facts":{"pack_count":30}}' '03-storyboard'
HARNESS_ROOT="$ROOT" python3 "$ROOT/scripts/lib/render_runmd.py" "$RID" "$RDIR" >/dev/null 2>&1
check "(6) 채우면 권고 섹션 자가소멸" "! grep -q '보완하면 더 좋아요' '$RDIR/run.md'"
read MF6 NI6 F6 T6 <<<"$(adv 03-storyboard)"
check "(6) 충족 시 must_fill·nice 0, filled==total" "[ $MF6 -eq 0 ] && [ $NI6 -eq 0 ] && [ $F6 -eq $T6 ]"

# (7) 게이트 정렬(레코드 단위): A=측정값만 + B=기관/n/기간만 → 단일 레코드 완비 없음 → must_fill 잔존
mk '{"evidence_on_file":[{"id":"A","kind":"clinical_trial","before":50.0,"after":40.0},{"id":"B","kind":"clinical_trial","institution":"가","sample_size":52,"duration":"4주"}]}' \
   '{"keyword_frequency":{"x":3},"product_facts":{"pack_count":1}}' '03-storyboard'
read MF7 NI7 F7 T7 <<<"$(adv 03-storyboard)"
check "(7) 다중 레코드 — 단일 완비 없으면 must_fill 잔존(게이트 정렬)" "[ $MF7 -ge 1 ]"

# (8) 이른 단계(00-ingest) 노이즈 0
mk '{"evidence_on_file":[]}' '{}' '00-ingest'
read MF8 NI8 F8 T8 <<<"$(adv 00-ingest)"
check "(8) 이른 단계(00-ingest) 노이즈 0" "[ $MF8 -eq 0 ] && [ $NI8 -eq 0 ] && [ $T8 -eq 0 ]"

# (9) operator_labels 권고 문구 내부어 누수 0
L9="$(python3 - "$ROOT" <<'PY'
import sys, os, re
sys.path.insert(0, os.path.join(sys.argv[1], "scripts/lib"))
import operator_labels as L
toks = re.compile(r"(human-verify|hard-stop|scope=|escalated|\bauto\b|\biteration\b|claim[-_]?basis|verdict|evidence[-_]?ref|VOC|RTB)")
bad = [s for k in L.ADVICE for s in (L.advise_fill(k), L.quality_warn(k)) if toks.search(s)]
bad += [L.fill_label(k) for k in L.FILL_LABEL if toks.search(L.fill_label(k))]
bad += [s for s in (L.quality_gap_note(), L.completeness_phrase(1, 4)) if toks.search(s)]
print("OK" if not bad else "NO: %r" % bad)
PY
)"
check "(9) operator_labels 권고 문구 내부어 누수 0" "[ '$L9' = 'OK' ]"

# ── (10)~(13) 사진형-html_only·임상신호 권고(회귀: 로직변경 아닌 스토리보드 오작성/문서 오분류 가시화) ──
has_key() {  # has_key <phase> <key> → 'yes'/'no' (nice_to_have 에 그 key 존재 여부)
  python3 - "$ROOT" "$RDIR" "$1" "$2" <<'PY'
import sys, os
root, rdir, phase, key = sys.argv[1:5]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
import completeness_advisor as C
r = C.advise(rdir, {"phase": phase})
print("yes" if any(n.get("key") == key for n in r["nice_to_have"]) else "no")
PY
}
mk_evdoc() {  # mk_evdoc <kind> <reflect> <claim> — 00-ingest/evidence-documents.json 작성
  mkdir -p "$RDIR/00-ingest"
  printf '{"documents":[{"id":"doc-01","kind":"%s","reflect":%s,"claim":"%s","reflection_points":["%s"]}]}' \
    "$1" "$2" "$3" "$3" > "$RDIR/00-ingest/evidence-documents.json"
}

# (10)(11) photographic_html_only 권고 케이스는 폐기됨(2026-07-05 전제 전환 — html_only 도 온라인 생성이라 낭비 전제 소멸).

# (12) 일반 참조 문서 + 임상 신호(인체적용시험) → evidence_clinical_signal 권고 뜸
mk '{"evidence_on_file":[]}' '{}' '01-brief'
mk_evdoc general true '인체적용시험 완료 사용적합'
check "(12) 일반문서+임상신호 → evidence_clinical_signal 권고" "[ \"\$(has_key 01-brief evidence_clinical_signal)\" = yes ]"

# (13a) test_report 문서 → evidence_clinical_signal 안 뜸(시험성적서는 이미 실증 경로)
mk '{"evidence_on_file":[]}' '{}' '01-brief'
mk_evdoc test_report true '인체적용시험 완료 사용적합'
check "(13a) test_report 문서 → evidence_clinical_signal 미발생" "[ \"\$(has_key 01-brief evidence_clinical_signal)\" = no ]"

# (13b) 임상 신호 없는 일반 문서 → 안 뜸(false positive 없음)
mk '{"evidence_on_file":[]}' '{}' '01-brief'
mk_evdoc general true '브랜드 스토리 자유 참고'
check "(13b) 임상신호 없는 일반문서 → evidence_clinical_signal 미발생" "[ \"\$(has_key 01-brief evidence_clinical_signal)\" = no ]"

printf '\n[completeness-advisory] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
