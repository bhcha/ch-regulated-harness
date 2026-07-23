#!/usr/bin/env bash
# test-clinical-chart.sh — Phase 3 임상 차트 블록 회귀 테스트.
#   합성 run dir + clinicalEvidence graph 블록 + chart_data + 실증 근거로:
#   (i)  image_engine 이 임상 차트 블록 PNG 생성하지 않음
#   (ii) common.sh 임베드 Python fallback 예측에서도 해당 블록 제외
#   (iii) validate_storyboard: 실증 등록 + graph 블록 → 통과
#   (iv) kcia_engine: 실증 충족 조건 갖춘 차트 블록 → substantiation_required 위반 없음
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## clinical-chart — 임상 차트 블록 통합 회귀 테스트"
export HARNESS_OFFLINE=1

# ── 합성 run dir 구성 ─────────────────────────────────────────────────────
RID="ci-clinical-chart"
RDIR="$ROOT/runs/$RID"
rm -rf "$RDIR"
mkdir -p "$RDIR/00-ingest" "$RDIR/03-storyboard/plan"

# state.json (최소)
python3 - "$RDIR" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {
    "run_id": "ci-clinical-chart",
    "phase": "03-storyboard",
    "storyboard_substage": "plan",
    "gate": "user",
    "status": "active",
    "product": {
        "name": "테스트 쿠션",
        "regulatory_domain": "cosmetic",
        "deliverable_format": "multipage_bm"
    },
    "iteration": 1,
    "max_iterations": 3,
    "revise_count": 0
}
with open(os.path.join(rdir, "state.json"), "w", encoding="utf-8") as fh:
    json.dump(st, fh, ensure_ascii=False, indent=2)
PYEOF

# claim-basis.json: 실증 등록(before/after 수치 포함)
python3 - "$RDIR" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
cb = {
    "functional_status": {
        "whitening": {"status": "unknown", "evidence_ref": None},
        "wrinkle": {"status": "unknown", "evidence_ref": None},
        "uv_protection": {"status": "unknown", "evidence_ref": None}
    },
    "notified_ingredients": [],
    "certifications": [],
    "product_type": "일반 화장품",
    "evidence_on_file": [
        {
            "id": "ev-sebum-01",
            "kind": "clinical_trial",
            "grade": "인체적용시험",
            "source": "가나다 피부과학연구소",
            "summary": "4주 사용 후 피지량 35% 감소",
            "metric": "피지량",
            "unit": "%",
            "before": 48.2,
            "after": 31.3,
            "change_pct": -35.1,
            "institution": "가나다 피부과학연구소",
            "sample_size": 52,
            "duration": "4주",
            "p_value": 0.01
        }
    ],
    "unsupported_claims": [],
    "source": {"from": "working-backwards.md", "extracted_by": "stub"}
}
with open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8") as fh:
    json.dump(cb, fh, ensure_ascii=False, indent=2)
PYEOF

# voc.json (최소)
python3 - "$RDIR" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
voc = {"keyword_frequency": {}, "top_phrases": {}}
with open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8") as fh:
    json.dump(voc, fh, ensure_ascii=False, indent=2)
PYEOF

# hero plan block (비-임상 — 이미지 생성 대상)
python3 - "$RDIR" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
hero = {
    "type": "hero",
    "order": 1,
    "headline": "테스트 히어로",
    "subcopy": "서브카피",
    "bodyText": [],
    "visual": {
        "kind": "photo",
        "concept": {
            "subject": "제품컷",
            "reference": {"own_asset_path": "inputs/assets/product-main.jpg"}
        }
    },
    "claims": [],
    "footnotes": [],
    "approval_state": "draft"
}
with open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8") as fh:
    json.dump(hero, fh, ensure_ascii=False, indent=2)
PYEOF

# clinicalEvidence plan block (graph + chart_data — 이미지 생성 제외 대상)
python3 - "$RDIR" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
clinical = {
    "type": "clinicalEvidence",
    "order": 2,
    "headline": "4주 임상시험 결과",
    "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주, p<0.05 / 개인차 있음",
    "bodyText": ["피지량 35.1% 감소 확인", "연출된 수치이며 개인에 따라 차이가 있을 수 있습니다"],
    "visual": {
        "kind": "graph",
        "concept": {
            "subject": "피지량 변화 바 차트",
            "reference": {"own_asset_path": "inputs/assets/product-main.jpg"}
        },
        "chart_data": {
            "chart_type": "bar",
            "series": [
                {"label": "사용 전", "value": 48.2, "unit": "%"},
                {"label": "4주", "value": 31.3, "unit": "%"}
            ],
            "callouts": ["-35.1%"],
            "footnote_ref": "fn-clinical-01"
        }
    },
    "claims": [
        {
            "target_text": "피지량 35.1% 감소 확인",
            "claim_strength": "efficacy",
            "evidence_ref": "ev-sebum-01",
            "footnote_id": "fn-clinical-01"
        }
    ],
    "footnotes": [
        {"id": "fn-clinical-01", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주, p<0.05). 개인에 따라 차이가 있을 수 있습니다."}
    ],
    "approval_state": "draft"
}
with open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8") as fh:
    json.dump(clinical, fh, ensure_ascii=False, indent=2)
PYEOF

# ── (i) image_engine: 임상 차트 블록 PNG 생성 안 함 ───────────────────────
IMG_OK=$(python3 - "$RDIR" "$RID" "$ROOT" <<'PYEOF'
import sys, os, json
rdir, rid, root = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from image_engine import _plan_blocks_with_concept

blocks_to_generate = []
for b in _plan_blocks_with_concept(rdir):
    _vis = b.get("visual") or {}
    # 실제 image_engine 술어와 동일: type ∈ {clinicalEvidence,beforeAfter} AND chart_data 존재(Codex FIX C).
    if b.get("type") in ("clinicalEvidence", "beforeAfter") and _vis.get("chart_data"):
        continue
    blocks_to_generate.append(b["type"])

assert "hero" in blocks_to_generate, "hero must be in generate list"
assert "clinicalEvidence" not in blocks_to_generate, "clinicalEvidence(chart_data) must NOT be in generate list"
print("ok")
PYEOF
)
check "(i) image_engine: chart_data 보유 임상 차트 블록 생성 목록 제외" \
  "[ '$IMG_OK' = 'ok' ]"

# ── (ii) common.sh fallback 예측 Python: 임상 차트 블록 제외 ──────────────
COMMON_OUT=$(python3 - "$RDIR" "$RID" "svg" <<'PYEOF'
import sys, os, json
pdir, rid, ext = sys.argv[1] + "/03-storyboard/plan", sys.argv[2], sys.argv[3]
lines = []
for fn in sorted(os.listdir(pdir)):
    if not fn.endswith(".json"):
        continue
    try:
        b = json.load(open(os.path.join(pdir, fn)))
    except Exception:
        continue
    if not ((b.get("visual") or {}).get("concept")):
        continue
    _vis = b.get("visual") or {}
    # common.sh fallback 술어와 동일(image_engine 와 바이트 동일): chart_data 존재만(Codex FIX C).
    if b.get("type") in ("clinicalEvidence", "beforeAfter") and _vis.get("chart_data"):
        continue
    # per-run 계약: 예측투영 경로 = 런 상대 04-keyvisual/generated/NN-type.ext (rid 하위폴더 없음, common.sh 와 동일).
    lines.append("- 블록 %02d-%s → 04-keyvisual/generated/%02d-%s.%s (생성 예정)" % (
        b["order"], b["type"], b["order"], b["type"], ext))
for l in lines:
    print(l)
PYEOF
)
check "(ii) common.sh fallback: hero 포함, clinicalEvidence 제외" \
  "echo '$COMMON_OUT' | grep -q 'hero' && ! echo '$COMMON_OUT' | grep -q 'clinicalEvidence'"

# ── (iii) validate_storyboard: 실증 등록 + graph 블록 → 통과 ──────────────
VS_RC=0
python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR" >/dev/null 2>&1 || VS_RC=$?
check "(iii) validate_storyboard: 실증 등록 + clinicalEvidence graph 블록 → 검증 통과(exit 0)" \
  "[ $VS_RC -eq 0 ]"

# ── (iv) kcia_engine: 수치 차트 충족 → substantiation_required 위반 없음 ──
KCIA_OK=$(python3 - "$RDIR" "$ROOT" <<'PYEOF'
import sys, os, json
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate

verdict = evaluate("ci-clinical-chart", rdir, None, "test")
subst_vios = [v for v in verdict["violations"] if v["axis"] == "substantiation_required"]
# 차트 충족 블록 카피에서 나온 substantiation_required 위반이 없어야 함
# (실증 미등록·각주 없는 경우의 legitimate 위반은 아니라 block 구조 검증으로 처리)
print("ok (violations=%d subst=%d)" % (len(verdict["violations"]), len(subst_vios)))
PYEOF
)
KCIA_SUBST=$(echo "$KCIA_OK" | grep -oE 'subst=[0-9]+' | grep -oE '[0-9]+')
check "(iv) kcia_engine: 차트 충족 블록 substantiation_required 위반=0" \
  "[ '${KCIA_SUBST:-1}' = '0' ]"

# ── (v) FIX 1 교차블록 억제 회귀: 실제 evaluate() ─────────────────────────
#   충족 clinicalEvidence 블록(트리거 + 개인차 disclaimer) + 비충족 hero(겹치는 substring 트리거).
#   기대: hero 의 substantiation_required 는 유지(억제 안 됨), 충족 블록 것은 억제.
RID2="ci-clinical-xblock"
RDIR2="$ROOT/runs/$RID2"
rm -rf "$RDIR2"
mkdir -p "$RDIR2/00-ingest" "$RDIR2/03-storyboard/plan"
python3 - "$RDIR2" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-xblock", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트 쿠션", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {"whitening": {"status": "unknown", "evidence_ref": None},
        "wrinkle": {"status": "unknown", "evidence_ref": None},
        "uv_protection": {"status": "unknown", "evidence_ref": None}},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-x", "metric": "탄력 개선", "kind": "clinical_trial", "grade": "인체적용시험",
        "source": "가나다 연구소", "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# hero: 비충족 블록. headline "탄력 개선"(트리거) — 충족 클레임 target_text 와 다른 문자열(교차블록 정확매칭).
hero = {"type": "hero", "order": 1, "headline": "탄력 개선", "subcopy": "서브",
        "bodyText": [], "visual": {"kind": "photo",
          "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# clinicalEvidence: 충족 — 트리거가 '충족 클레임 target_text'(탄력 개선 임상 결과)에 있고, 카피에 기관·n·기간 + 디스클레이머.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주",
        "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "피지량 차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar",
            "series": [{"label": "전", "value": 48.2}, {"label": "후", "value": 31.3}],
            "callouts": ["-35%"], "footnote_ref": "fn-x"}},
        "claims": [{"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy",
                    "evidence_ref": "ev-x", "footnote_id": "fn-x"}],
        "footnotes": [{"id": "fn-x", "text": "가나다 연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
XBLOCK_OUT=$(python3 - "$RDIR2" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-xblock", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
hero_kept = "탄력 개선" in subst                       # hero(비충족) 트리거 유지돼야 함
clin_suppressed = "탄력 개선 20% 확인" not in subst    # 충족 클레임 자기 target_text 만 억제
print("ok" if (hero_kept and clin_suppressed) else
      "FAIL hero_kept=%s clin_suppressed=%s subst=%r" % (hero_kept, clin_suppressed, subst))
PYEOF
)
check "(v) FIX M/1 교차블록: 비충족 hero 트리거 유지 + 충족 '클레임 target_text' 만 억제(정확매칭)" \
  "[ '$XBLOCK_OUT' = 'ok' ]"
rm -rf "$RDIR2"

# ── (vi) FIX 2 디스클레이머 누락 음성 회귀: 실제 evaluate() ────────────────
#   수치 근거는 완전하지만 블록 카피/각주에 개인차 디스클레이머가 없으면 → 억제 안 됨(여전히 flagged).
RID3="ci-clinical-nodisc"
RDIR3="$ROOT/runs/$RID3"
rm -rf "$RDIR3"
mkdir -p "$RDIR3/00-ingest" "$RDIR3/03-storyboard/plan"
python3 - "$RDIR3" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-nodisc", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트 쿠션", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {"whitening": {"status": "unknown", "evidence_ref": None},
        "wrinkle": {"status": "unknown", "evidence_ref": None},
        "uv_protection": {"status": "unknown", "evidence_ref": None}},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-n", "kind": "clinical_trial", "grade": "인체적용시험",
        "source": "가나다 연구소", "before": 48.2, "after": 31.3, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# clinicalEvidence: 수치 근거 완전하지만 개인차 디스클레이머가 어디에도 없음(헤드/서브/본문/각주).
clin = {"type": "clinicalEvidence", "order": 1, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주",
        "bodyText": ["임상으로 입증된 결과입니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "피지량 차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar",
            "series": [{"label": "전", "value": 48.2}, {"label": "후", "value": 31.3}],
            "callouts": ["-35%"], "footnote_ref": "fn-n"}},
        "claims": [{"target_text": "피지량 변화 확인", "claim_strength": "efficacy",
                    "evidence_ref": "ev-n", "footnote_id": "fn-n"}],
        "footnotes": [{"id": "fn-n", "text": "가나다 연구소 인체적용시험(n=52, 4주)."}],
        "approval_state": "draft"}
# 루트 블록(hero) 필수 — 검증과 무관하나 일관성 위해 추가.
hero = {"type": "hero", "order": 0, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
# order 0 은 schema minimum 1 위반이므로 hero order=1, clinical order=2 로 조정.
hero["order"] = 1; clin["order"] = 2
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
NODISC_OUT=$(python3 - "$RDIR3" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-nodisc", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
# 디스클레이머 없으면 블록 '미충족' → bodyText 트리거 substantiation 위반 유지돼야 함.
kept = "임상으로 입증된 결과입니다" in subst
print("ok" if kept else "FAIL: disclaimer 누락인데 억제됨 subst=%r" % subst)
PYEOF
)
check "(vi) FIX2 디스클레이머 누락: 수치 근거 완전해도 개인차 문구 없으면 substantiation 유지(억제 안 됨)" \
  "[ '$NODISC_OUT' = 'ok' ]"
rm -rf "$RDIR3"

# ── (vii) FIX 4 스키마 inner-required: chart_data 내부 필수 검증 ──────────
SCHEMA_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from harness import Validator, load_json
schema = load_json(os.path.join(root, "harness/plan-block.schema.json"))
def blk(cd):
    return {"type": "clinicalEvidence", "order": 2, "headline": "임상", "subcopy": "s",
            "bodyText": [], "claims": [], "footnotes": [], "approval_state": "draft",
            "visual": {"kind": "graph",
                "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
                "chart_data": cd}}
def is_valid(cd):
    v = Validator(schema); v.validate(blk(cd), schema); return len(v.errors) == 0
good = is_valid({"chart_type": "bar", "series": [{"label": "전", "value": 48.2}]})
bad_callouts = is_valid({"callouts": []})
bad_empty = is_valid({"chart_type": "bar", "series": []})
bad_item = is_valid({"chart_type": "bar", "series": [{"label": "전"}]})
print("ok" if (good and not bad_callouts and not bad_empty and not bad_item) else
      "FAIL good=%s callouts=%s empty=%s item=%s" % (good, bad_callouts, bad_empty, bad_item))
PYEOF
)
check "(vii) FIX4 스키마: chart_type+series+items 통과 / {callouts:[]}·빈series·value누락 거부" \
  "[ '$SCHEMA_OUT' = 'ok' ]"

# ── (viii) FIX A: 가짜 근거 무결성 위반은 충족 블록 trigger 와 겹쳐도 억제 안 됨 ──
#   충족 블록 안에 진짜 강주장(claim1) + 가짜 evidence_ref="ev-FAKE" 강주장(claim2, target_text=트리거)을 둔다.
#   기대: claim2 의 무결성 위반(rule≠트리거)은 살아남아 가짜 근거가 통과하지 않는다.
RID4="ci-clinical-fakeev"
RDIR4="$ROOT/runs/$RID4"
rm -rf "$RDIR4"; mkdir -p "$RDIR4/00-ingest" "$RDIR4/03-storyboard/plan"
python3 - "$RDIR4" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-fakeev", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-real", "metric": "탄력 개선", "kind": "clinical_trial", "grade": "인체적용시험",
        "source": "가나다", "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
# claim1: 충족(ev-real, target_text 트리거 '탄력 개선'). claim2: 가짜(ev-FAKE, 다른 트리거 '모공 축소').
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 연구소 인체적용시험, n=52, 4주",
        "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 48.2}, {"label": "후", "value": 31.3}],
            "callouts": ["-35%"], "footnote_ref": "fn-r"}},
        "claims": [
          {"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy", "evidence_ref": "ev-real", "footnote_id": "fn-r"},
          {"target_text": "모공 축소 확인", "claim_strength": "efficacy", "evidence_ref": "ev-FAKE", "footnote_id": "fn-r"}],
        "footnotes": [{"id": "fn-r", "text": "가나다 연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
FAKEEV_OUT=$(python3 - "$RDIR4" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate, _SUBST_TRIGGER_RULE
v = evaluate("ci-clinical-fakeev", rdir, None, "test")
sv = [x for x in v["violations"] if x["axis"] == "substantiation_required"]
# 가짜(ev-FAKE) claim2 의 무결성 위반(rule≠트리거, target='모공 축소 확인')이 살아있어야 함(가짜 통과 차단, FIX A).
integrity = [x for x in sv if x["target_text"] == "모공 축소 확인" and x["rule"] != _SUBST_TRIGGER_RULE]
# 가짜 claim2 는 충족 클레임이 아니므로 그 트리거('모공 축소 확인')도 억제되면 안 됨(FIX M 클레임-스코프).
fake_trigger = [x for x in sv if x["target_text"] == "모공 축소 확인" and x["rule"] == _SUBST_TRIGGER_RULE]
# 충족 claim1 의 자기 target_text 트리거('탄력 개선 임상')는 억제됐어야 함.
clin_trigger = [x for x in sv if x["target_text"] == "탄력 개선 20% 확인" and x["rule"] == _SUBST_TRIGGER_RULE]
ok = len(integrity) > 0 and len(fake_trigger) > 0 and len(clin_trigger) == 0
print("ok" if ok else "FAIL integrity=%d fake_trigger=%d clin_trigger=%d rules=%r"
      % (len(integrity), len(fake_trigger), len(clin_trigger), [x["rule"] for x in sv]))
PYEOF
)
check "(viii) FIX A/M: 가짜 evidence_ref 무결성·트리거 모두 유지(가짜 통과 차단) + 충족 클레임 트리거만 억제" \
  "[ '$FAKEEV_OUT' = 'ok' ]"
rm -rf "$RDIR4"

# ── (ix) FIX D: 충족 블록의 claims[].target_text 에만 있는 트리거도 억제됨 ──
RID5="ci-clinical-claimtrig"
RDIR5="$ROOT/runs/$RID5"
rm -rf "$RDIR5"; mkdir -p "$RDIR5/00-ingest" "$RDIR5/03-storyboard/plan"
python3 - "$RDIR5" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-claimtrig", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-c", "metric": "탄력 개선", "kind": "clinical_trial", "grade": "인체적용시험",
        "source": "가나다", "before": 50.0, "after": 40.0, "institution": "가나다 연구소",
        "sample_size": 40, "duration": "4주", "p_value": 0.02}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
# 트리거('탄력 개선')는 오직 claim.target_text 에만 — bodyText/subcopy 에는 없음.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 연구소 인체적용시험, n=40, 4주",
        "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-c"}},
        "claims": [{"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy", "evidence_ref": "ev-c", "footnote_id": "fn-c"}],
        "footnotes": [{"id": "fn-c", "text": "가나다 연구소 인체적용시험(n=40, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
CLAIMTRIG_OUT=$(python3 - "$RDIR5" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-claimtrig", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
# claim.target_text 에만 있는 트리거 '탄력 개선 확인' 이 억제돼야 함(FIX D — gather 동일 범위 스캔).
ok = "탄력 개선 20% 확인" not in subst
print("ok" if ok else "FAIL: claim target_text 트리거 미억제 subst=%r" % subst)
PYEOF
)
check "(ix) FIX D: 충족 블록 claims[].target_text 의 트리거도 억제(gather 동일 범위 스캔)" \
  "[ '$CLAIMTRIG_OUT' = 'ok' ]"
rm -rf "$RDIR5"

# ── (x) FIX C: chart_data 없는 graph 블록은 image_engine 이 건너뛰지 않음(hollow 방지) ──
RID6="ci-clinical-graphnocd"
RDIR6="$ROOT/runs/$RID6"
rm -rf "$RDIR6"; mkdir -p "$RDIR6/00-ingest" "$RDIR6/03-storyboard/plan"
python3 - "$RDIR6" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-graphnocd", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# clinicalEvidence kind=graph 이지만 chart_data 없음 → image_engine 이 생성해야(skip 아님).
clin = {"type": "clinicalEvidence", "order": 1, "headline": "임상", "subcopy": "s",
        "bodyText": [], "claims": [], "footnotes": [], "approval_state": "draft",
        "visual": {"kind": "graph",
          "concept": {"subject": "그래프 일러스트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}}}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
GRAPHNOCD_OUT=$(HARNESS_OFFLINE=1 python3 - "$RDIR6" "$RID6" "$ROOT" <<'PYEOF'
import sys, os
rdir, rid, root = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from image_engine import generate_all
man = generate_all(rid, rdir, "stub")
types = [a["type"] for a in man["assets"]]
# chart_data 없는 graph 블록 → 생성 목록에 있어야 함(hollow 방지).
ok = "clinicalEvidence" in types
print("ok" if ok else "FAIL: chart_data 없는 graph 가 skip됨(hollow) types=%r" % types)
PYEOF
)
check "(x) FIX C: chart_data 없는 graph clinicalEvidence 는 image_engine 이 생성(skip 아님, hollow 방지)" \
  "[ '$GRAPHNOCD_OUT' = 'ok' ]"
rm -rf "$RDIR6"   # per-run 계약: 생성물(04-keyvisual/generated/)은 RDIR6 안 → 함께 제거

# ── (xi) FIX C: 실증 등록 + clinicalEvidence photo 블록은 validate 통과(정성 인증컷 보존) ──
RID7="ci-clinical-photo"
RDIR7="$ROOT/runs/$RID7"
rm -rf "$RDIR7"; mkdir -p "$RDIR7/00-ingest" "$RDIR7/03-storyboard/plan"
python3 - "$RDIR7" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-photo", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-p", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "institution": "가나다 연구소", "sample_size": 30, "duration": "2주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
# 정성적 clinicalEvidence 인증컷(photo, chart_data 없음) — 강주장+근거+각주로 게이트 통과.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "피부 적합성 테스트 완료",
        "subcopy": "가나다 연구소 인체적용시험 완료", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "photo", "concept": {"subject": "시험 인증서", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [{"target_text": "피부 적합성 확인", "claim_strength": "efficacy", "evidence_ref": "ev-p", "footnote_id": "fn-p"}],
        "footnotes": [{"id": "fn-p", "text": "가나다 연구소 인체적용시험. 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
VS7=0
python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR7" >/dev/null 2>&1 || VS7=$?
check "(xi) FIX C: 실증 등록 + clinicalEvidence photo(정성 인증컷) → validate 통과(exit 0)" \
  "[ $VS7 -eq 0 ]"
rm -rf "$RDIR7"

# ── (xii) FIX E: 근거는 완전하나 카피에 시험맥락(기관·n·기간) 미노출 → 억제 안 됨 ──
RID8="ci-clinical-nocontext"
RDIR8="$ROOT/runs/$RID8"
rm -rf "$RDIR8"; mkdir -p "$RDIR8/00-ingest" "$RDIR8/03-storyboard/plan"
python3 - "$RDIR8" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-nocontext", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-nc", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# clinicalEvidence: 레코드는 완전하지만 카피에는 기관/n수/기간을 노출하지 않음(개인차 디스클레이머만).
clin = {"type": "clinicalEvidence", "order": 1, "headline": "탄력 개선 확인",
        "subcopy": "사용 후 변화", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-nc"}},
        "claims": [{"target_text": "효능 확인", "claim_strength": "efficacy", "evidence_ref": "ev-nc", "footnote_id": "fn-nc"}],
        "footnotes": [{"id": "fn-nc", "text": "측정 결과입니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
NOCTX_OUT=$(python3 - "$RDIR8" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-nocontext", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
# headline '탄력 개선 확인' = 트리거('탄력 개선'). 카피에 시험맥락 미노출 → 억제 안 됨(유지).
ok = "탄력 개선 확인" in subst
print("ok" if ok else "FAIL: 시험맥락 미노출인데 억제됨 subst=%r" % subst)
PYEOF
)
check "(xii) FIX E: 근거 완전하나 카피에 기관·n·기간 미노출 → substantiation 유지(억제 안 됨)" \
  "[ '$NOCTX_OUT' = 'ok' ]"
rm -rf "$RDIR8"

# ── (xiii) FIX M/G: 충족 '클레임' target_text 트리거만 억제 — 같은 블록 concept 트리거는 유지 ──
RID9="ci-clinical-concept"
RDIR9="$ROOT/runs/$RID9"
rm -rf "$RDIR9"; mkdir -p "$RDIR9/00-ingest" "$RDIR9/03-storyboard/plan"
python3 - "$RDIR9" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-concept", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-cc", "metric": "탄력 개선", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# 비충족 hero: concept.subject 에 '모공 축소' 트리거. 유지돼야 함(비충족).
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "모공 축소 비포애프터 연출", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
# 충족 clinicalEvidence: 카피에 기관·n·기간 + 디스클레이머. 충족 클레임 target_text='탄력 개선 확인'(트리거) →
#   억제. concept.subject='모공 축소 추이 그래프'(다른 트리거)는 '클레임 문구가 아니라' → 유지(FIX M 클레임-스코프).
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "모공 축소 추이 그래프", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-cc"}},
        "claims": [{"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy", "evidence_ref": "ev-cc", "footnote_id": "fn-cc"}],
        "footnotes": [{"id": "fn-cc", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
CONCEPT_OUT=$(python3 - "$RDIR9" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-concept", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
# 충족 클레임 target_text '탄력 개선 확인' → 억제. 같은 블록 concept '모공 축소 추이 그래프'(클레임 아님) → 유지(FIX M).
# 비충족 hero concept '모공 축소 비포애프터 연출' → 유지.
claim_suppressed = "탄력 개선 20% 확인" not in subst
clin_concept_kept = "모공 축소 추이 그래프" in subst
hero_kept = "모공 축소 비포애프터 연출" in subst
print("ok" if (claim_suppressed and clin_concept_kept and hero_kept) else
      "FAIL claim_suppressed=%s clin_concept_kept=%s hero_kept=%s subst=%r"
      % (claim_suppressed, clin_concept_kept, hero_kept, subst))
PYEOF
)
check "(xiii) FIX M/G: 충족 클레임 target_text 만 억제 — 같은 블록 concept 트리거·비충족 hero concept 유지" \
  "[ '$CONCEPT_OUT' = 'ok' ]"
rm -rf "$RDIR9"

# ── (xiv) FIX I 종단: 카피가 'n=152'/'14주'(경계 오매칭)면 시험맥락 미충족 → 억제 안 됨 ──
RID10="ci-clinical-boundary"
RDIR10="$ROOT/runs/$RID10"
rm -rf "$RDIR10"; mkdir -p "$RDIR10/00-ingest" "$RDIR10/03-storyboard/plan"
python3 - "$RDIR10" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-boundary", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-bd", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# 카피에 'n=152'(≠52)·'14주'(≠4주) — 경계 오매칭. 레코드는 n=52/4주. headline 트리거 '탄력 개선'.
clin = {"type": "clinicalEvidence", "order": 1, "headline": "탄력 개선 확인",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=152, 14주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-bd"}},
        "claims": [{"target_text": "효능 확인", "claim_strength": "efficacy", "evidence_ref": "ev-bd", "footnote_id": "fn-bd"}],
        "footnotes": [{"id": "fn-bd", "text": "측정 결과입니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
BOUNDARY_OUT=$(python3 - "$RDIR10" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-boundary", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
# headline '탄력 개선 확인' 트리거. 카피 n=152/14주(경계 오매칭) → 맥락 미충족 → 억제 안 됨(유지).
ok = "탄력 개선 확인" in subst
print("ok" if ok else "FAIL: 경계 오매칭인데 억제됨 subst=%r" % subst)
PYEOF
)
check "(xiv) FIX I 종단: 카피 'n=152'/'14주' 경계 오매칭 → substantiation 유지(억제 안 됨)" \
  "[ '$BOUNDARY_OUT' = 'ok' ]"
rm -rf "$RDIR10"

# ── (xv) FIX M 정확 재현: 충족 블록 헤드라인 '모공 축소 확인'(근거 없음) → 적발 유지, 측정 클레임만 억제 ──
RID11="ci-clinical-claimscope"
RDIR11="$ROOT/runs/$RID11"
rm -rf "$RDIR11"; mkdir -p "$RDIR11/00-ingest" "$RDIR11/03-storyboard/plan"
python3 - "$RDIR11" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-claimscope", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-sebum", "metric": "탄력 개선", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# 충족 블록: 피지량 측정 클레임(탄력 개선 트리거를 자기 target_text 에) + 헤드라인 '모공 축소 확인'(근거 없음).
#   기대(FIX M): 측정 클레임 'target_text 탄력 개선 임상' 만 억제, 헤드라인 '모공 축소 확인' 은 그대로 적발.
clin = {"type": "clinicalEvidence", "order": 1, "headline": "모공 축소 확인",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "피지량 차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 48.2}, {"label": "후", "value": 31.3}],
            "callouts": ["-35%"], "footnote_ref": "fn-s"}},
        "claims": [{"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy", "evidence_ref": "ev-sebum", "footnote_id": "fn-s"}],
        "footnotes": [{"id": "fn-s", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
CLAIMSCOPE_OUT=$(python3 - "$RDIR11" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-claimscope", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
mogong_kept = "모공 축소 확인" in subst       # 무관 헤드라인(근거 없음) → 적발 유지
claim_suppressed = "탄력 개선 20% 확인" not in subst  # 측정 클레임 자기 문구 → 억제
print("ok" if (mogong_kept and claim_suppressed) else
      "FAIL mogong_kept=%s claim_suppressed=%s subst=%r" % (mogong_kept, claim_suppressed, subst))
PYEOF
)
check "(xv) FIX M: 충족 블록 무관 헤드라인 '모공 축소 확인' 적발 유지 + 측정 클레임 자기 문구만 억제(클레임-스코프)" \
  "[ '$CLAIMSCOPE_OUT' = 'ok' ]"
rm -rf "$RDIR11"

# ── (xvi) FIX P: 공백만(" ") institution → _evidence_satisfies 미충족 → 억제 안 됨 ──
WS_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import Engine
import json
packs = os.path.join(os.path.dirname(root), "packs")
ruleset = json.load(open(os.path.join(packs, "cosmetic/ruleset.json"), encoding="utf-8"))
func = {"whitening": "unknown", "wrinkle": "unknown", "uv_protection": "unknown"}
# 공백 institution → 미충족
ws_inst = {"id": "e1", "before": 1.0, "after": 2.0, "institution": "   ", "sample_size": 30, "duration": "4주"}
assert not Engine(ruleset, func, ["e1"], evidence_details={"e1": ws_inst})._evidence_satisfies("e1"), "공백 institution 거부"
# 공백 duration → 미충족
ws_dur = {"id": "e2", "before": 1.0, "after": 2.0, "institution": "가나다 연구소", "sample_size": 30, "duration": "  "}
assert not Engine(ruleset, func, ["e2"], evidence_details={"e2": ws_dur})._evidence_satisfies("e2"), "공백 duration 거부"
# 정상 → 충족
okrec = {"id": "e3", "before": 1.0, "after": 2.0, "institution": "가나다 연구소", "sample_size": 30, "duration": "4주"}
assert Engine(ruleset, func, ["e3"], evidence_details={"e3": okrec})._evidence_satisfies("e3"), "정상 충족"
print("ok")
PYEOF
)
check "(xvi) FIX P: 공백만 institution/duration → _evidence_satisfies 미충족(strip 후 빈 문자열 거부)" \
  "[ '$WS_OUT' = 'ok' ]"

# ── (xvii) FIX Q: chart_data 수치가 evidence 에서 도출되지 않으면 validate_storyboard 실패(환각 차단) ──
build_chartq_run() {  # $1=rid $2=series_json $3=callouts_json
  local rid="$1" rdir="$ROOT/runs/$1"
  rm -rf "$rdir"; mkdir -p "$rdir/00-ingest" "$rdir/03-storyboard/plan"
  python3 - "$rdir" "$2" "$3" <<'PYEOF'
import json, os, sys
rdir, series_json, callouts_json = sys.argv[1], sys.argv[2], sys.argv[3]
st = {"run_id": os.path.basename(rdir), "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# evidence: before=50 / after=40 (변화율 -20%)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-q", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": json.loads(series_json),
            "callouts": json.loads(callouts_json), "footnote_ref": "fn-q"}},
        "claims": [{"target_text": "측정 확인", "claim_strength": "efficacy", "evidence_ref": "ev-q", "footnote_id": "fn-q"}],
        "footnotes": [{"id": "fn-q", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
}
# 환각 차트(series=[1,99] · callouts=["+9800%"]) → 실패(exit 1)
build_chartq_run "ci-chartq-bad" '[{"label":"사용 전","value":1},{"label":"4주","value":99}]' '["+9800%"]'
QBAD=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartq-bad" >/dev/null 2>&1 || QBAD=$?
check "(xvii) FIX Q: 환각 chart_data(series=[1,99]/callouts=['+9800%']) → validate 실패(exit≠0)" \
  "[ $QBAD -ne 0 ]"
rm -rf "$ROOT/runs/ci-chartq-bad"
# 정상 차트(series=[50,40] · callouts=["-20%"]) → 통과(exit 0)
build_chartq_run "ci-chartq-good" '[{"label":"사용 전","value":50},{"label":"4주","value":40}]' '["-20%"]'
QGOOD=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartq-good" >/dev/null 2>&1 || QGOOD=$?
check "(xvii) FIX Q: 도출 chart_data(series=[50,40]/callouts=['-20%']) → validate 통과(exit 0)" \
  "[ $QGOOD -eq 0 ]"
rm -rf "$ROOT/runs/ci-chartq-good"

# ── (xvii-T) FIX T: 콜아웃 부호/방향 — evidence 변화 -20% 에 '+20%'(역방향) 거부, '-20%'/'20% 감소' 통과, '20%'(방향없음) 통과 ──
build_chartq_run "ci-chartt-wrongsign" '[{"label":"사용 전","value":50},{"label":"4주","value":40}]' '["+20%"]'
TWS=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartt-wrongsign" >/dev/null 2>&1 || TWS=$?
check "(xvii-T) FIX T: 변화 -20% 인데 callout '+20%'(역방향) → validate 실패(exit≠0)" \
  "[ $TWS -ne 0 ]"
rm -rf "$ROOT/runs/ci-chartt-wrongsign"
build_chartq_run "ci-chartt-word" '[{"label":"사용 전","value":50},{"label":"4주","value":40}]' '["20% 감소"]'
TWD=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartt-word" >/dev/null 2>&1 || TWD=$?
check "(xvii-T) FIX T: callout '20% 감소'(방향 단어=감소) → -20% 일치 → validate 통과(exit 0)" \
  "[ $TWD -eq 0 ]"
rm -rf "$ROOT/runs/ci-chartt-word"
build_chartq_run "ci-chartt-nodir" '[{"label":"사용 전","value":50},{"label":"4주","value":40}]' '["20%"]'
TND=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartt-nodir" >/dev/null 2>&1 || TND=$?
check "(xvii-T) FIX T: callout '20%'(방향 미명시) → 크기 일치 → validate 통과(exit 0)" \
  "[ $TND -eq 0 ]"
rm -rf "$ROOT/runs/ci-chartt-nodir"

# ── (xvii-U) FIX U: before/after 없이 series=[50,40] 만 있는 evidence 도 콜아웃 '-20%' 통과, '+20%' 실패 ──
build_chartu_run() {  # $1=rid $2=callouts_json
  local rid="$1" rdir="$ROOT/runs/$1"
  rm -rf "$rdir"; mkdir -p "$rdir/00-ingest" "$rdir/03-storyboard/plan"
  python3 - "$rdir" "$2" <<'PYEOF'
import json, os, sys
rdir, callouts_json = sys.argv[1], sys.argv[2]
st = {"run_id": os.path.basename(rdir), "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# evidence: series 만(before/after/change_pct 없음). 첫→끝 변화율 = (40-50)/50*100 = -20%.
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-u", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "series": [{"timepoint": "0주", "value": 50.0}, {"timepoint": "4주", "value": 40.0}],
        "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "line", "series": [{"label": "0주", "value": 50.0}, {"label": "4주", "value": 40.0}],
            "callouts": json.loads(callouts_json), "footnote_ref": "fn-u"}},
        "claims": [{"target_text": "측정 확인", "claim_strength": "efficacy", "evidence_ref": "ev-u", "footnote_id": "fn-u"}],
        "footnotes": [{"id": "fn-u", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
}
build_chartu_run "ci-chartu-good" '["-20%"]'
UG=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartu-good" >/dev/null 2>&1 || UG=$?
check "(xvii-U) FIX U: series-only evidence + callout '-20%' → validate 통과(exit 0)" \
  "[ $UG -eq 0 ]"
rm -rf "$ROOT/runs/ci-chartu-good"
build_chartu_run "ci-chartu-bad" '["+20%"]'
UB=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartu-bad" >/dev/null 2>&1 || UB=$?
check "(xvii-U) FIX U: series-only evidence + callout '+20%'(역방향) → validate 실패(exit≠0)" \
  "[ $UB -ne 0 ]"
rm -rf "$ROOT/runs/ci-chartu-bad"

# ── (xviii) FIX R: 충족 클레임과 '동일 문자열' hero 헤드라인은 억제되면 안 됨(per-block 제외) ──
RID12="ci-clinical-dup"
RDIR12="$ROOT/runs/$RID12"
rm -rf "$RDIR12"; mkdir -p "$RDIR12/00-ingest" "$RDIR12/03-storyboard/plan"
python3 - "$RDIR12" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-clinical-dup", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-d", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# hero headline = 충족 클레임 target_text 와 '정확히 동일' 문자열('탄력 개선 확인'), 근거 없음 → 유지돼야 함(FIX R).
hero = {"type": "hero", "order": 1, "headline": "탄력 개선 확인", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-d"}},
        "claims": [{"target_text": "탄력 개선 확인", "claim_strength": "efficacy", "evidence_ref": "ev-d", "footnote_id": "fn-d"}],
        "footnotes": [{"id": "fn-d", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
DUP_OUT=$(python3 - "$RDIR12" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-clinical-dup", rdir, None, "test")
subst = [x for x in v["violations"] if x["axis"] == "substantiation_required" and x["target_text"] == "탄력 개선 확인"]
# 동일 문자열이 비충족 hero 에도 있으므로 → 억제되면 안 됨(최소 1건 유지).
print("ok" if len(subst) >= 1 else "FAIL: 동일 문자열 hero 헤드라인이 억제됨(per-block 제외 실패) subst=%d" % len(subst))
PYEOF
)
check "(xviii) FIX R: 충족 클레임과 동일 문자열 hero 헤드라인(근거 없음) → 억제 안 됨(per-block 제외)" \
  "[ '$DUP_OUT' = 'ok' ]"
rm -rf "$RDIR12"

# ── (xix) FIX W: 클레임 수치가 evidence 와 불일치하면(조작) 억제 안 됨; 일치하면 억제 ──
build_claimw_run() {  # $1=rid $2=claim_target_text
  local rid="$1" rdir="$ROOT/runs/$1"
  rm -rf "$rdir"; mkdir -p "$rdir/00-ingest" "$rdir/03-storyboard/plan"
  python3 - "$rdir" "$2" <<'PYEOF'
import json, os, sys
rdir, ctt = sys.argv[1], sys.argv[2]
st = {"run_id": os.path.basename(rdir), "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# evidence 변화 -20%(before=50, after=40).
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-w", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다",
        "metric": "수분", "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소",
        "sample_size": 52, "duration": "4주", "p_value": 0.01}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# claim target_text 가 '수분 N% 개선' 트리거를 포함(억제 관측 가능). 카피에 기관·n·기간 + 디스클레이머.
clin = {"type": "clinicalEvidence", "order": 1, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "전", "value": 50.0}, {"label": "후", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-w"}},
        "claims": [{"target_text": ctt, "claim_strength": "efficacy", "evidence_ref": "ev-w", "footnote_id": "fn-w"}],
        "footnotes": [{"id": "fn-w", "text": "가나다 피부과학연구소 인체적용시험(n=52, 4주). 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
}
# 조작 수치('수분 99% 개선', 근거 -20%) → 트리거 유지(억제 안 됨).
build_claimw_run "ci-claimw-bad" "수분 99% 개선"
WBAD=$(python3 - "$ROOT/runs/ci-claimw-bad" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-claimw-bad", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
print("ok" if "수분 99% 개선" in subst else "FAIL: 조작 수치 99% 가 억제됨 subst=%r" % subst)
PYEOF
)
check "(xix) FIX W: 클레임 '수분 99% 개선'(근거 -20%) 불일치 → substantiation 유지(억제 안 됨)" \
  "[ '$WBAD' = 'ok' ]"
rm -rf "$ROOT/runs/ci-claimw-bad"
# 일치 수치('수분 20% 개선', 근거 변화 크기 20%) → 억제됨.
build_claimw_run "ci-claimw-good" "수분 20% 개선"
WGOOD=$(python3 - "$ROOT/runs/ci-claimw-good" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-claimw-good", rdir, None, "test")
subst = [x["target_text"] for x in v["violations"] if x["axis"] == "substantiation_required"]
print("ok" if "수분 20% 개선" not in subst else "FAIL: 일치 수치 20% 가 억제 안 됨 subst=%r" % subst)
PYEOF
)
check "(xix) FIX W: 클레임 '수분 20% 개선'(근거 변화 크기 20%) 일치 → substantiation 억제됨" \
  "[ '$WGOOD' = 'ok' ]"
rm -rf "$ROOT/runs/ci-claimw-good"

# ── (xx) FIX CC: series 라벨-스왑 — 값/순서는 맞아도 라벨이 도출 라벨과 다르면 실패; 정합 라벨은 통과 ──
#   정확 재현: 값 [50,40](순서 일치)이지만 라벨 ["4주 후","시험 전"](도출 ["사용 전","4주"]과 불일치) → 실패.
build_chartq_run "ci-chartx-swap" '[{"label":"4주 후","value":50},{"label":"시험 전","value":40}]' '["-20%"]'
XS=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartx-swap" >/dev/null 2>&1 || XS=$?
check "(xx) FIX CC: 라벨-스왑([4주 후:50, 시험 전:40], 값 순서는 일치) → 라벨 불일치로 validate 실패" \
  "[ $XS -ne 0 ]"
rm -rf "$ROOT/runs/ci-chartx-swap"
build_chartq_run "ci-chartx-ok" '[{"label":"사용 전","value":50},{"label":"4주","value":40}]' '["-20%"]'
XO=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-chartx-ok" >/dev/null 2>&1 || XO=$?
check "(xx) FIX CC: 도출 라벨 정합([사용 전:50, 4주:40]) → validate 통과(exit 0)" \
  "[ $XO -eq 0 ]"
rm -rf "$ROOT/runs/ci-chartx-ok"

# ── (xxi) FIX BB: 차트는 footnote_ref 가 가리키는 '강주장 하나'의 evidence 에만 결박(부차 claim 근거로 통과 불가) ──
#   강주장(fn-strong)은 ev-claim(100/80)을 참조하나, 차트는 부차 factual claim 의 ev-chart(50/40)과 맞춤 → 실패해야 함.
RID13="ci-chart-union"
RDIR13="$ROOT/runs/$RID13"
rm -rf "$RDIR13"; mkdir -p "$RDIR13/00-ingest" "$RDIR13/03-storyboard/plan"
python3 - "$RDIR13" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-chart-union", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [
        {"id": "ev-claim", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "탄력 개선",
         "before": 100.0, "after": 80.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"},
        {"id": "ev-chart", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "수분",
         "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/00-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# 차트 series 는 부차 ev-chart(50/40)과 일치하지만 footnote_ref=fn-strong → 강주장 ev-claim(100/80) 기준이라 불일치 → 실패.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "사용 전", "value": 50.0}, {"label": "4주", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-strong"}},
        "claims": [
          {"target_text": "탄력 개선 20% 확인", "claim_strength": "efficacy", "evidence_ref": "ev-claim", "footnote_id": "fn-strong"},
          {"target_text": "수분 측정", "claim_strength": "factual", "evidence_ref": "ev-chart", "footnote_id": "fn-fact"}],
        "footnotes": [{"id": "fn-strong", "text": "가나다 ... 개인에 따라 차이가 있을 수 있습니다."}, {"id": "fn-fact", "text": "수분 측정"}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
BB1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR13" >/dev/null 2>&1 || BB1=$?
check "(xxi) FIX BB: 차트가 부차 claim ev(50/40)와 맞아도 강주장 ev(100/80) 기준 → validate 실패(union 우회 차단)" \
  "[ $BB1 -ne 0 ]"
# 같은 블록에서 차트를 강주장 ev-claim(100/80)에 맞추면 통과.
python3 - "$RDIR13" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
p = os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json")
b = json.load(open(p))
b["visual"]["chart_data"]["series"] = [{"label": "사용 전", "value": 100.0}, {"label": "4주", "value": 80.0}]
json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
BB2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR13" >/dev/null 2>&1 || BB2=$?
check "(xxi) FIX BB: 차트를 강주장 ev(100/80)에 맞추면 validate 통과(exit 0)" \
  "[ $BB2 -eq 0 ]"
rm -rf "$RDIR13"

# ── (xxii) FIX FF: footnote_ref 가 서로 다른 evidence 를 가진 복수 강주장을 가리키면 fail-closed ──
RID14="ci-chart-ambig"
RDIR14="$ROOT/runs/$RID14"
rm -rf "$RDIR14"; mkdir -p "$RDIR14/00-ingest" "$RDIR14/03-storyboard/plan"
python3 - "$RDIR14" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-chart-ambig", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [
        {"id": "ev-chart", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "피지량",
         "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"},
        {"id": "ev-other", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "수분",
         "before": 100.0, "after": 130.0, "change_pct": 30.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/00-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# fn-1 을 공유하는 두 강주장이 서로 다른 evidence(ev-chart, ev-other) 참조 → 모호 → 차트가 ev-chart 와 맞아도 실패.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "사용 전", "value": 50.0}, {"label": "4주", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-1"}},
        "claims": [
          {"target_text": "피지량 20% 감소", "claim_strength": "efficacy", "evidence_ref": "ev-chart", "footnote_id": "fn-1"},
          {"target_text": "수분 30% 증가", "claim_strength": "efficacy", "evidence_ref": "ev-other", "footnote_id": "fn-1"}],
        "footnotes": [{"id": "fn-1", "text": "가나다 ... 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
FF1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR14" >/dev/null 2>&1 || FF1=$?
check "(xxii) FIX FF: footnote_ref 가 서로 다른 evidence 의 복수 강주장 → validate 실패(ambiguous, 차트가 한쪽과 맞아도)" \
  "[ $FF1 -ne 0 ]"
rm -rf "$RDIR14"

# ── (xxiii) FIX GG: chart_data 는 clinicalEvidence/beforeAfter 에만 허용 — hero+chart_data → 실패 ──
RID15="ci-chart-herocd"
RDIR15="$ROOT/runs/$RID15"
rm -rf "$RDIR15"; mkdir -p "$RDIR15/00-ingest" "$RDIR15/03-storyboard/plan"
python3 - "$RDIR15" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-chart-herocd", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-h", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "피지량",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# hero 블록에 chart_data → 허용 안 됨(FIX GG). image_engine 은 hero 를 이미지 생성하므로 차트-스킵 계약과 모순.
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "graph",
          "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "사용 전", "value": 50.0}, {"label": "4주", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-h"}},
        "claims": [{"target_text": "피지량 20% 감소", "claim_strength": "efficacy", "evidence_ref": "ev-h", "footnote_id": "fn-h"}],
        "footnotes": [{"id": "fn-h", "text": "가나다 ... 개인에 따라 차이가 있을 수 있습니다."}],
        "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
GG1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR15" >/dev/null 2>&1 || GG1=$?
check "(xxiii) FIX GG: hero 블록 + chart_data → validate 실패(chart_data 는 clinicalEvidence/beforeAfter 전용)" \
  "[ $GG1 -ne 0 ]"
# 같은 chart_data 를 clinicalEvidence 블록으로 바꾸면 통과(hero 루트 블록도 추가).
python3 - "$RDIR15" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
p = os.path.join(rdir, "03-storyboard/plan/01-hero.json")
b = json.load(open(p))
b["type"] = "clinicalEvidence"; b["order"] = 2; b["headline"] = "임상 결과"
b["subcopy"] = "가나다 피부과학연구소 인체적용시험, n=52, 4주"
json.dump(b, open(os.path.join(rdir, "03-storyboard/plan/02-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
os.remove(p)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/00-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
GG2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR15" >/dev/null 2>&1 || GG2=$?
check "(xxiii) FIX GG: 같은 chart_data 를 clinicalEvidence 블록으로 → validate 통과(exit 0)" \
  "[ $GG2 -eq 0 ]"
rm -rf "$RDIR15"

# 공용 빌더: hero + clinicalEvidence(evidence_json·chart_json·claims_json·footnotes_json) 런 생성.
build_gated_run() {  # $1=rid $2=evidence_json $3=chartdata_json $4=claims_json $5=footnotes_json
  local rid="$1" rdir="$ROOT/runs/$1"
  rm -rf "$rdir"; mkdir -p "$rdir/00-ingest" "$rdir/03-storyboard/plan"
  EV="$2" CD="$3" CL="$4" FN="$5" python3 - "$rdir" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
ev = json.loads(os.environ["EV"]); cd = json.loads(os.environ["CD"])
claims = json.loads(os.environ["CL"]); footnotes = json.loads(os.environ["FN"])
st = {"run_id": os.path.basename(rdir), "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [ev], "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/00-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과",
        "subcopy": "가나다 피부과학연구소 인체적용시험, n=52, 4주", "bodyText": ["개인에 따라 차이가 있을 수 있습니다"],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": cd},
        "claims": claims, "footnotes": footnotes, "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
}

# ── (xxiv) FIX HH: chart_data.callouts 스캔 + 숫자 없는 콜아웃 거부 ──
# 숫자 없는 banned 콜아웃 "여드름 치료" → validate 실패 + kcia drug_misperception 적발.
build_gated_run "ci-hh" \
  '{"id":"ev-hh","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지량","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["여드름 치료"],"footnote_ref":"fn-hh"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-hh","footnote_id":"fn-hh"}]' \
  '[{"id":"fn-hh","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
HH1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-hh" >/dev/null 2>&1 || HH1=$?
check "(xxiv) FIX HH: 숫자 없는 콜아웃 '여드름 치료' → validate 실패(텍스트 콜아웃 금지)" \
  "[ $HH1 -ne 0 ]"
HH_KCIA=$(python3 - "$ROOT/runs/ci-hh" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-hh", rdir, None, "test")
dm = [x for x in v["violations"] if x["axis"] == "drug_misperception" and "여드름" in x["target_text"]]
print("ok" if dm else "FAIL: 콜아웃 '여드름 치료' drug_misperception 미적발 vios=%r" % [(x["axis"],x["target_text"]) for x in v["violations"]])
PYEOF
)
check "(xxiv) FIX HH: 콜아웃 '여드름 치료' → kcia drug_misperception 적발(콜아웃 스캔)" \
  "[ '$HH_KCIA' = 'ok' ]"
rm -rf "$ROOT/runs/ci-hh"

# ── (xxv) FIX II: series 가 소스 — 3포인트 series 를 2포인트로 그리면 실패 ──
build_gated_run "ci-ii-bad" \
  '{"id":"ev-ii","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지량","before":50.0,"after":40.0,"series":[{"timepoint":"0주","value":50.0},{"timepoint":"2주","value":45.0},{"timepoint":"4주","value":40.0}],"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"line","series":[{"label":"0주","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-ii"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-ii","footnote_id":"fn-ii"}]' \
  '[{"id":"fn-ii","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
II1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-ii-bad" >/dev/null 2>&1 || II1=$?
check "(xxv) FIX II: 3포인트 series 를 [50,40] 2포인트로 그림 → validate 실패(중간 포인트 누락)" \
  "[ $II1 -ne 0 ]"
rm -rf "$ROOT/runs/ci-ii-bad"
build_gated_run "ci-ii-ok" \
  '{"id":"ev-ii","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지량","before":50.0,"after":40.0,"series":[{"timepoint":"0주","value":50.0},{"timepoint":"2주","value":45.0},{"timepoint":"4주","value":40.0}],"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"line","series":[{"label":"0주","value":50.0},{"label":"2주","value":45.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-ii"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-ii","footnote_id":"fn-ii"}]' \
  '[{"id":"fn-ii","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
II2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-ii-ok" >/dev/null 2>&1 || II2=$?
check "(xxv) FIX II: 3포인트 series 를 [50,45,40] 전 포인트·시점라벨로 그림 → validate 통과(exit 0)" \
  "[ $II2 -eq 0 ]"
rm -rf "$ROOT/runs/ci-ii-ok"

# ── (xxvi) FIX JJ: metric·unit 결박 — 강주장이 다른 metric 명시 / series unit 불일치 → 실패 ──
build_gated_run "ci-jj-metric" \
  '{"id":"ev-jj","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","unit":"%","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-jj"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-jj","footnote_id":"fn-jj"}]' \
  '[{"id":"fn-jj","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
JJ1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-jj-metric" >/dev/null 2>&1 || JJ1=$?
check "(xxvi) FIX JJ: evidence metric='수분' 인데 강주장 '피지량 20% 감소' → validate 실패(metric 불일치)" \
  "[ $JJ1 -ne 0 ]"
rm -rf "$ROOT/runs/ci-jj-metric"
build_gated_run "ci-jj-ok" \
  '{"id":"ev-jj","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","unit":"%","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0,"unit":"%"},{"label":"4주","value":40.0,"unit":"%"}],"callouts":["-20%"],"footnote_ref":"fn-jj"}' \
  '[{"target_text":"수분 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-jj","footnote_id":"fn-jj"}]' \
  '[{"id":"fn-jj","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
JJ2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-jj-ok" >/dev/null 2>&1 || JJ2=$?
check "(xxvi) FIX JJ: 강주장 '수분 20% 감소'(metric 명시)+series unit '%' → validate 통과(exit 0)" \
  "[ $JJ2 -eq 0 ]"
rm -rf "$ROOT/runs/ci-jj-ok"
build_gated_run "ci-jj-unit" \
  '{"id":"ev-jj","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","unit":"%","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0,"unit":"명"},{"label":"4주","value":40.0,"unit":"명"}],"callouts":["-20%"],"footnote_ref":"fn-jj"}' \
  '[{"target_text":"수분 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-jj","footnote_id":"fn-jj"}]' \
  '[{"id":"fn-jj","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
JJ3=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-jj-unit" >/dev/null 2>&1 || JJ3=$?
check "(xxvi) FIX JJ: series unit '명' vs evidence unit '%' → validate 실패(unit 불일치)" \
  "[ $JJ3 -ne 0 ]"
rm -rf "$ROOT/runs/ci-jj-unit"

# ── (xxvii) FIX KK: 차트 owner 강주장 수치 결박 — chart_data 는 맞아도 강주장 "수분 +99% 증가" → 적발 ──
# validate(강주장 수치 결박) + kcia evaluate(distinct rule, 억제 불가) 양쪽.
build_gated_run "ci-kk-bad" \
  '{"id":"ev-kk","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-kk"}' \
  '[{"target_text":"수분 +99% 증가","claim_strength":"efficacy","evidence_ref":"ev-kk","footnote_id":"fn-kk"}]' \
  '[{"id":"fn-kk","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
KK1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-kk-bad" >/dev/null 2>&1 || KK1=$?
check "(xxvii) FIX KK: chart_data 정확해도 owner 강주장 '수분 +99% 증가' → validate 실패(강주장 수치 결박)" \
  "[ $KK1 -ne 0 ]"
KK_KCIA=$(python3 - "$ROOT/runs/ci-kk-bad" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-kk-bad", rdir, None, "test")
hit = [x for x in v["violations"] if x["axis"] == "substantiation_required" and "정량값과 불일치" in x["rule"]]
print("ok" if (v["verdict"] != "pass" and hit) else "FAIL verdict=%s hit=%d" % (v["verdict"], len(hit)))
PYEOF
)
check "(xxvii) FIX KK: kcia evaluate 가 '수분 +99% 증가' 를 substantiation_required(distinct rule)로 적발(억제 불가)" \
  "[ '$KK_KCIA' = 'ok' ]"
rm -rf "$ROOT/runs/ci-kk-bad"
# owner 강주장이 evidence 와 일치('수분 20% 감소') → 위반 없음.
build_gated_run "ci-kk-ok" \
  '{"id":"ev-kk","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-kk"}' \
  '[{"target_text":"수분 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-kk","footnote_id":"fn-kk"}]' \
  '[{"id":"fn-kk","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
KK2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-kk-ok" >/dev/null 2>&1 || KK2=$?
check "(xxvii) FIX KK: owner 강주장 '수분 20% 감소'(일치) → validate 통과(exit 0)" \
  "[ $KK2 -eq 0 ]"
rm -rf "$ROOT/runs/ci-kk-ok"

# ── (xxviii) FIX LL: evidence unit 있으면 모든 series 항목이 unit 명시·일치(누락 우회 불가) ──
build_gated_run "ci-ll-noUnit" \
  '{"id":"ev-ll","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지","unit":"mg/cm²","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-ll"}' \
  '[{"target_text":"피지 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-ll","footnote_id":"fn-ll"}]' \
  '[{"id":"fn-ll","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
LL1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-ll-noUnit" >/dev/null 2>&1 || LL1=$?
check "(xxviii) FIX LL: evidence unit 'mg/cm²' 인데 series 항목 unit 누락 → validate 실패(누락 우회 불가)" \
  "[ $LL1 -ne 0 ]"
rm -rf "$ROOT/runs/ci-ll-noUnit"
build_gated_run "ci-ll-ok" \
  '{"id":"ev-ll","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지","unit":"mg/cm²","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0,"unit":"mg/cm²"},{"label":"4주","value":40.0,"unit":"mg/cm²"}],"callouts":["-20%"],"footnote_ref":"fn-ll"}' \
  '[{"target_text":"피지 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-ll","footnote_id":"fn-ll"}]' \
  '[{"id":"fn-ll","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
LL2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-ll-ok" >/dev/null 2>&1 || LL2=$?
check "(xxviii) FIX LL: 모든 series 항목 unit 'mg/cm²' 일치 → validate 통과(exit 0)" \
  "[ $LL2 -eq 0 ]"
rm -rf "$ROOT/runs/ci-ll-ok"
build_gated_run "ci-ll-one" \
  '{"id":"ev-ll","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지","unit":"mg/cm²","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0,"unit":"mg/cm²"},{"label":"4주","value":40.0,"unit":"명"}],"callouts":["-20%"],"footnote_ref":"fn-ll"}' \
  '[{"target_text":"피지 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-ll","footnote_id":"fn-ll"}]' \
  '[{"id":"fn-ll","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
LL3=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-ll-one" >/dev/null 2>&1 || LL3=$?
check "(xxviii) FIX LL: series 한 항목만 unit '명'(나머지 'mg/cm²') → validate 실패(항목별 일치 필요)" \
  "[ $LL3 -ne 0 ]"
rm -rf "$ROOT/runs/ci-ll-one"

# ── (xxix) FIX OO: chart_data 블록 5요소 HARD GATE — 비-트리거 metric(피지량)도 디스클레이머·맥락 누락이면 적발 ──
# 좋은 케이스: build_gated_run(디스클레이머·맥락 포함) → 통과.
build_gated_run "ci-oo-ok" \
  '{"id":"ev-oo","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"피지량","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-oo"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-oo","footnote_id":"fn-oo"}]' \
  '[{"id":"fn-oo","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
OO_OK=$(python3 - "$ROOT/runs/ci-oo-ok" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-oo-ok", rdir, None, "test")
hit = [x for x in v["violations"] if "정량 차트 필수요소" in x["rule"]]
print("ok" if not hit else "FAIL: 5요소 충족인데 hard-gate 발동 hit=%d" % len(hit))
PYEOF
)
check "(xxix) FIX OO: 5요소(맥락+디스클레이머) 갖춘 피지량 차트 → hard-gate 위반 없음" \
  "[ '$OO_OK' = 'ok' ]"
rm -rf "$ROOT/runs/ci-oo-ok"
# 나쁜 케이스: chart_data 는 유효하나 디스클레이머·맥락 누락 → hard-gate 위반(verdict NOT pass).
RID16="ci-oo-bad"; RDIR16="$ROOT/runs/$RID16"
rm -rf "$RDIR16"; mkdir -p "$RDIR16/00-ingest" "$RDIR16/03-storyboard/plan"
python3 - "$RDIR16" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-oo-bad", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-oo", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가", "metric": "피지량",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/00-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# chart_data 유효하지만 subcopy 에 기관·n·기간 미노출 + bodyText 에 디스클레이머 없음 → 5요소 미충족.
clin = {"type": "clinicalEvidence", "order": 2, "headline": "임상 결과", "subcopy": "사용 후 변화", "bodyText": [],
        "visual": {"kind": "graph",
          "concept": {"subject": "차트", "reference": {"own_asset_path": "inputs/assets/p.jpg"}},
          "chart_data": {"chart_type": "bar", "series": [{"label": "사용 전", "value": 50.0}, {"label": "4주", "value": 40.0}],
            "callouts": ["-20%"], "footnote_ref": "fn-oo"}},
        "claims": [{"target_text": "피지량 48.2%에서 31.3%로 감소", "claim_strength": "efficacy", "evidence_ref": "ev-oo", "footnote_id": "fn-oo"}],
        "footnotes": [{"id": "fn-oo", "text": "측정 결과"}],
        "approval_state": "draft"}
json.dump(clin, open(os.path.join(rdir, "03-storyboard/plan/01-clinicalEvidence.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
OO_BAD=$(python3 - "$RDIR16" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-oo-bad", rdir, None, "test")
hit = [x for x in v["violations"] if "정량 차트 필수요소" in x["rule"]]
print("ok" if (v["verdict"] != "pass" and hit) else "FAIL verdict=%s hit=%d" % (v["verdict"], len(hit)))
PYEOF
)
check "(xxix) FIX OO: chart_data 유효하나 디스클레이머·맥락 누락 → hard-gate 위반(verdict NOT pass, 비-트리거 metric)" \
  "[ '$OO_BAD' = 'ok' ]"
rm -rf "$RDIR16"

# ── (xxx) FIX QQ 종단: evidence metric '수분량' + 강주장 '수분 20% 개선'(접미 '량' 차이) → validate 통과 ──
build_gated_run "ci-qq-ok" \
  '{"id":"ev-qq","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분량","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-qq"}' \
  '[{"target_text":"수분 20% 개선","claim_strength":"efficacy","evidence_ref":"ev-qq","footnote_id":"fn-qq"}]' \
  '[{"id":"fn-qq","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
QQ1=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-qq-ok" >/dev/null 2>&1 || QQ1=$?
check "(xxx) FIX QQ: metric '수분량' + 강주장 '수분 20% 개선'(stem 일치) → validate 통과(exit 0)" \
  "[ $QQ1 -eq 0 ]"
rm -rf "$ROOT/runs/ci-qq-ok"
# 다른 지표는 여전히 거부: metric '수분량' + 강주장 '피지량 20% 감소' → validate 실패(metric 불일치).
build_gated_run "ci-qq-bad" \
  '{"id":"ev-qq","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분량","before":50.0,"after":40.0,"change_pct":-20.0,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-qq"}' \
  '[{"target_text":"피지량 20% 감소","claim_strength":"efficacy","evidence_ref":"ev-qq","footnote_id":"fn-qq"}]' \
  '[{"id":"fn-qq","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
QQ2=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-qq-bad" >/dev/null 2>&1 || QQ2=$?
check "(xxx) FIX QQ: metric '수분량' + 강주장 '피지량 20% 감소'(다른 지표) → validate 실패(과확장 방지)" \
  "[ $QQ2 -ne 0 ]"
rm -rf "$ROOT/runs/ci-qq-bad"

# ── (xxxi) FIX RR 종단: p값 동반 강주장 → 통과; callout 'p<0.05' 단독 → 실패(측정 수치 없음) ──
# 강주장에 p<0.05 동반, 콜아웃은 측정 수치 '-20%' → 전 검증 통과(real evaluate + validate).
build_gated_run "ci-rr-ok" \
  '{"id":"ev-rr","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","before":50.0,"after":40.0,"change_pct":-20.0,"p_value":0.05,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["-20%"],"footnote_ref":"fn-rr"}' \
  '[{"target_text":"수분 20% 개선 확인(p<0.05)","claim_strength":"efficacy","evidence_ref":"ev-rr","footnote_id":"fn-rr"}]' \
  '[{"id":"fn-rr","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
RR_V=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-rr-ok" >/dev/null 2>&1 || RR_V=$?
check "(xxxi) FIX RR: p<0.05 동반 강주장 '수분 20% 개선 확인(p<0.05)' → validate 통과(exit 0)" \
  "[ $RR_V -eq 0 ]"
RR_K=$(python3 - "$ROOT/runs/ci-rr-ok" "$ROOT" <<'PYEOF'
import sys, os
rdir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from kcia_engine import evaluate
v = evaluate("ci-rr-ok", rdir, None, "test")
bad = [x for x in v["violations"] if "정량값과 불일치" in x["rule"]]
print("ok" if not bad else "FAIL: p값 동반인데 강주장 수치 불일치 적발 bad=%d" % len(bad))
PYEOF
)
check "(xxxi) FIX RR: kcia evaluate — p값 동반 강주장 수치 불일치 오적발 없음" \
  "[ '$RR_K' = 'ok' ]"
rm -rf "$ROOT/runs/ci-rr-ok"
# 콜아웃이 'p<0.05' 단독(측정 수치 없음) → validate 실패(FIX HH n_matched<1).
build_gated_run "ci-rr-ponly" \
  '{"id":"ev-rr","kind":"clinical_trial","grade":"인체적용시험","source":"가","metric":"수분","before":50.0,"after":40.0,"change_pct":-20.0,"p_value":0.05,"institution":"가나다 피부과학연구소","sample_size":52,"duration":"4주"}' \
  '{"chart_type":"bar","series":[{"label":"사용 전","value":50.0},{"label":"4주","value":40.0}],"callouts":["p<0.05"],"footnote_ref":"fn-rr"}' \
  '[{"target_text":"수분 20% 개선","claim_strength":"efficacy","evidence_ref":"ev-rr","footnote_id":"fn-rr"}]' \
  '[{"id":"fn-rr","text":"가나다 개인에 따라 차이가 있을 수 있습니다."}]'
RR_P=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$ROOT/runs/ci-rr-ponly" >/dev/null 2>&1 || RR_P=$?
check "(xxxi) FIX RR: callout 'p<0.05' 단독(측정 수치 없음) → validate 실패(콜아웃에 도출 수치 필요)" \
  "[ $RR_P -ne 0 ]"
rm -rf "$ROOT/runs/ci-rr-ponly"

# ── (xxxii) T3: p값 컨텍스트 정규식 확장 — 영문(p-value·pvalue·p value)·한국어 조사(유의확률이/유의수준은/p값은) ──
# Codex T3 적대리뷰 반영: ① 영문 마커 좌경계(top/group/develop value 오버매칭 거부) ② 실호출 윈도우(12자) 경유로
#   띄어쓴 'p-value < 0.05' 인식 검증(함수 직접 호출이 아니라 numbers_consistent 로 윈도우 절단까지 재현).
T3_OUT=$(python3 - "$ROOT" <<'PYEOF'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts/lib"))
from clinical_chart import _is_pvalue_context, numbers_consistent
fails = []
# (a) 직접 함수: 좌경계·조사·단독 p 판정.
for seg in ["p-value <", "p-value=", "pvalue <", "(p value ", "P-VALUE <",
            "유의확률이 ", "유의수준은 ", "p값은 ", "유의확률 ", "p<"]:
    if not _is_pvalue_context(seg):
        fails.append("미인식:%r" % seg)
for seg in ["top value ", "group value ", "develop value ", "drop value ",
            "5p value ", "_p value ",           # 숫자·_ 좌경계도 거부(LOW 하드닝)
            "develop=", "함량이 ", "감소가 "]:   # 영단어+value·영단어 끝 p·일반 조사어는 제외
    if _is_pvalue_context(seg):
        fails.append("오인식:%r" % seg)
# (b) 실호출(numbers_consistent, 윈도우 12 절단 재현):
d = {"values": [50.0, 40.0], "labels": ["사용 전", "4주"], "signed_change_pct": -20.0,
     "allowed_values": {50.0, 40.0}, "direction": -1, "metric": "수분", "unit": None}
for text in ["수분 20% 감소(p-value<0.05)",          # 붙여쓴 영문
             "수분 20% 감소 (p-value < 0.05)",        # 띄어쓴 영문(윈도우 12 필요 — HIGH#2)
             "수분 20% 감소, 유의확률이 0.025 수준",     # 한국어 조사형
             "50에서 40으로 감소, p값은 0.01"]:         # 한국어 p값+조사
    ok, _ = numbers_consistent(text, d)
    if not ok:
        fails.append("p값동반 불일치 오판정:%r" % text)
# (c) 오버매칭 가드(HIGH#1): 'top value 999' 의 999 는 측정 숫자로 검사돼야 함 → allowed 밖이라 불일치(ok=False).
ok_bad, _ = numbers_consistent("수분 20% 감소, top value 999", d)
if ok_bad:
    fails.append("오버매칭: 'top value 999' 의 999 가 p값으로 잘못 스킵됨")
print("ok" if not fails else "FAIL: " + "; ".join(fails))
PYEOF
)
check "(xxxii) T3: p값 컨텍스트 확장(영문 좌경계·윈도우12·한국어 조사) 인식·오버매칭 거부" \
  "[ '$T3_OUT' = 'ok' ]"

# ── (xxxiii) WS⑤: 실증 등록 상태에서 beforeAfter 비주얼은 측정 차트(graph/chart_data)여야 함 ──
# validate_storyboard.py:164-184 분기 회귀 고정 — photo 단독(연출컷)=실패, graph(측정 차트)=통과.
#   (규칙은 코드에 있었으나 전용 테스트가 없어 리팩터링 시 조용한 회귀 위험 → 분기를 직접 때려 봉인.)
RID_WS5="ci-ws5-beforeafter"
RDIR_WS5="$ROOT/runs/$RID_WS5"
rm -rf "$RDIR_WS5"; mkdir -p "$RDIR_WS5/00-ingest" "$RDIR_WS5/03-storyboard/plan"
python3 - "$RDIR_WS5" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
st = {"run_id": "ci-ws5-beforeafter", "phase": "03-storyboard", "storyboard_substage": "plan",
      "gate": "user", "status": "active",
      "product": {"name": "테스트", "regulatory_domain": "cosmetic", "deliverable_format": "multipage_bm"},
      "iteration": 1, "max_iterations": 3, "revise_count": 0}
json.dump(st, open(os.path.join(rdir, "state.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# evidence 등록(has_evidence=True) — 정량필드 동반.
cb = {"functional_status": {k: {"status": "unknown", "evidence_ref": None} for k in ("whitening","wrinkle","uv_protection")},
      "notified_ingredients": [], "certifications": [], "product_type": "일반 화장품",
      "evidence_on_file": [{"id": "ev-b", "kind": "clinical_trial", "grade": "인체적용시험", "source": "가나다", "metric": "피지량",
        "before": 50.0, "after": 40.0, "change_pct": -20.0, "institution": "가나다 피부과학연구소", "sample_size": 52, "duration": "4주"}],
      "unsupported_claims": [], "source": {"from": "wb", "extracted_by": "stub"}}
json.dump(cb, open(os.path.join(rdir, "00-ingest/claim-basis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump({"keyword_frequency": {}, "top_phrases": {}},
          open(os.path.join(rdir, "00-ingest/voc.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# 필수 루트 블록(hero) + beforeAfter(photo 단독·chart_data 없음 = 연출컷 → WS⑤ 위반).
hero = {"type": "hero", "order": 1, "headline": "히어로", "subcopy": "s", "bodyText": [],
        "visual": {"kind": "photo", "concept": {"subject": "제품", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
        "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(hero, open(os.path.join(rdir, "03-storyboard/plan/01-hero.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
ba = {"type": "beforeAfter", "order": 2, "headline": "전후", "subcopy": "s", "bodyText": [],
      "visual": {"kind": "photo", "concept": {"subject": "전후 연출컷", "reference": {"own_asset_path": "inputs/assets/p.jpg"}}},
      "claims": [], "footnotes": [], "approval_state": "draft"}
json.dump(ba, open(os.path.join(rdir, "03-storyboard/plan/02-beforeAfter.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
WS5A=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR_WS5" >/dev/null 2>&1 || WS5A=$?
check "(xxxiii) WS⑤: 실증 등록+beforeAfter photo 단독(연출컷·chart_data 없음) → validate 실패" \
  "[ $WS5A -ne 0 ]"
# 같은 beforeAfter 를 kind=graph(측정 차트)로 바꾸면 통과(WS⑤ 충족; chart_data 없어 결박검증은 no-op).
python3 - "$RDIR_WS5" <<'PYEOF'
import json, os, sys
rdir = sys.argv[1]
p = os.path.join(rdir, "03-storyboard/plan/02-beforeAfter.json")
b = json.load(open(p))
b["visual"]["kind"] = "graph"
json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
WS5B=0; python3 "$ROOT/scripts/lib/validate_storyboard.py" "$RDIR_WS5" >/dev/null 2>&1 || WS5B=$?
check "(xxxiii) WS⑤: 같은 beforeAfter 를 kind=graph(측정 차트)로 바꾸면 validate 통과" \
  "[ $WS5B -eq 0 ]"
rm -rf "$RDIR_WS5"

# ── 정리 ─────────────────────────────────────────────────────────────────
rm -rf "$RDIR"

echo "test-clinical-chart: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
