#!/usr/bin/env bash
# test-agui-contracts.sh — AG-UI 투영 계약 게이트(결정적·오프라인·no-LLM·골든 무영향).
#   Stage 1(Contract Freeze) 산출물 2종을 검증한다:
#     1) harness/agui-projection.schema.json — 잘 형성된 JSON Schema 인가(구조 자기검증) + 실제로 이벤트를 검증/거부하는가(사용성).
#     2) harness/a2ui-catalog.json — JSON 파싱 + 필수 구조(components·surfaces·actions·a2ui_version) + surface↔런타임 정합.
#   메타검증·이벤트검증 엔트리포인트 = 레포 자체 검증기(scripts/lib/harness.py 의 Validator, 표준 라이브러리 전용).
#     ⚠ jsonschema 는 이 환경에 미설치다(harness.py 가 명시적으로 'jsonschema 미설치 환경 대응'; test-schema-lint 도
#       json 표준 라이브러리만 쓴다). 따라서 1급 검증은 레포 Validator + 순수 파이썬 구조 자기검증으로 하고,
#       jsonschema Draft7 check_schema 는 설치돼 있을 때만 도는 '보너스' 메타검증으로 둔다(미설치면 'stdlib-only' 표기하고 통과).
#     ★ anti-false-green: stdlib 구조 자기검증이 실질 게이트다 — required 를 배열→문자열로 뒤집거나 patchOp oneOf 를
#       지우거나 RunFinished.outcome oneOf 를 없애면 여기서 FAIL 난다(jsonschema 없이도). Validator 는 '인스턴스'만
#       검증하므로 스키마 구조가 깨져도 통과할 수 있는데, 그 구멍을 구조 자기검증 + 음성 표본(known-bad 거부)으로 막는다.
#   결정적: harness/ JSON 파일 텍스트만 읽는다(네트워크·상태·런·LLM 없음).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## AG-UI 계약 — projection 스키마 구조 자기검증·사용성 + a2ui 카탈로그 무결성"

# ⚠ macOS bash 3.2 는 `$(... <<'PY' ... PY)` 에서 heredoc 본문의 괄호까지 세다가 불균형이면 치환을 조기 종료한다.
#   여기서는 명령치환이 아니라 python3 의 stdin 으로 heredoc 을 넘기고 stdout 을 파일로 리다이렉트하므로 그 버그가 발동하지
#   않는다(= 괄호 균형 강제 불필요). 쓰기 가능한 작업트리에서 mktemp 로 임시파일을 만든다(read-only 샌드박스에선 mktemp/
#   here-string 이 거부되지만 그건 샌드박스 아티팩트이지 로직 실패가 아니다 — 실제 실행은 쓰기 가능한 트리에서 한다).
AGUI_TMP="$(mktemp "${TMPDIR:-/tmp}/agui-contracts.XXXXXX")"
python3 - "$ROOT" > "$AGUI_TMP" 2>&1 <<'PY'
import json, os, sys

root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from harness import Validator, load_json, now_iso  # 레포 자체 검증기 + 타임스탬프 생성기(표준 라이브러리 전용)

hdir = os.path.join(root, "harness")
schema_path = os.path.join(hdir, "agui-projection.schema.json")
catalog_path = os.path.join(hdir, "a2ui-catalog.json")

results = []  # (ok, label, detail)
def R(ok, label, detail): results.append((bool(ok), label, detail))

EVENT_DEFS = ["RunStarted", "StepStarted", "StepFinished", "StateSnapshot",
              "StateDelta", "RunFinished", "RunError", "Custom"]
SHARED_DEFS = ["timestamp", "patchOp", "interrupt"]
REAL_ACTIONS = {"select", "approve", "revise", "raise-limit"}  # 현업 4동작 스크립트에 1:1 대응

# ── 1) projection 스키마 파싱 + 기본 메타 ─────────────────────────────────────────
schema = None
try:
    schema = load_json(schema_path)
    R(True, "메타: projection 스키마 JSON 파싱", "ok")
except Exception as e:
    R(False, "메타: projection 스키마 JSON 파싱", "파싱 실패: %s" % e)

def sfield(k):
    return schema.get(k) if isinstance(schema, dict) else None

R(sfield("$schema") == "http://json-schema.org/draft-07/schema#",
  "메타: $schema=draft-07", repr(sfield("$schema")))
R(bool(sfield("$id")), "메타: $id 존재", repr(sfield("$id")))

one_of = sfield("oneOf") if isinstance(schema, dict) else None
R(isinstance(one_of, list) and len(one_of) == len(EVENT_DEFS),
  "메타: 최상위 oneOf = 이벤트 유형 %d개" % len(EVENT_DEFS),
  "len=%s" % (len(one_of) if isinstance(one_of, list) else None))

defs = sfield("$defs") if isinstance(schema, dict) else None
missing = [d for d in (EVENT_DEFS + SHARED_DEFS) if not (isinstance(defs, dict) and d in defs)] if defs is not None else (EVENT_DEFS + SHARED_DEFS)
R(isinstance(defs, dict) and not missing,
  "메타: $defs 에 이벤트 8종 + 공유(timestamp/patchOp/interrupt)",
  "누락=%s" % missing if missing else "전부 존재")

# 보너스: jsonschema 가 설치돼 있으면 Draft7 check_schema(미설치면 'stdlib-only' 로 통과 표기 — 아래 구조 자기검증이 실질 게이트).
try:
    from jsonschema import Draft7Validator
    try:
        Draft7Validator.check_schema(schema)
        R(True, "메타: jsonschema Draft7 check_schema", "통과(jsonschema 설치됨)")
    except Exception as e:
        R(False, "메타: jsonschema Draft7 check_schema", "실패: %s" % e)
except ImportError:
    R(True, "메타: jsonschema Draft7 check_schema", "skipped (stdlib-only) — jsonschema 미설치(레포 표준; 구조 자기검증이 실질 게이트)")

# ── 1b) 스키마 구조 자기검증(stdlib-only anti-false-green) ─────────────────────────
#   Validator 는 '인스턴스'만 본다 → 스키마 자체가 망가져도(required 를 문자열로 뒤집기, oneOf 삭제 등) 통과할 수 있다.
#   그 구멍을 순수 파이썬 dict/list 단언으로 막는다(jsonschema 불필요).
D = defs if isinstance(defs, dict) else {}

# (a) 모든 이벤트 def 의 required 가 '배열'인가(문자열로 뒤집힌 스키마 차단).
bad_required = []
for d in EVENT_DEFS:
    req = (D.get(d) or {}).get("required")
    if not (isinstance(req, list) and len(req) >= 1):
        bad_required.append("%s→%r" % (d, req))
R(not bad_required, "구조: 이벤트 def 의 required 가 모두 비어있지 않은 배열",
  "위반=%s" % bad_required if bad_required else "8종 전부 배열")

# (b) patchOp 가 oneOf(3분기: add/replace/test·move/copy·remove)를 가지는가.
patch_oneof = (D.get("patchOp") or {}).get("oneOf")
R(isinstance(patch_oneof, list) and len(patch_oneof) == 3,
  "구조: patchOp 에 oneOf 3분기(add/replace/test·move/copy·remove)",
  "oneOf len=%s" % (len(patch_oneof) if isinstance(patch_oneof, list) else None))

# (c) RunFinished.outcome 가 oneOf 이며 success·interrupt 두 분기를 모두 가지는가.
outcome = ((D.get("RunFinished") or {}).get("properties") or {}).get("outcome") or {}
oc_oneof = outcome.get("oneOf")
oc_consts = set()
if isinstance(oc_oneof, list):
    for br in oc_oneof:
        c = (((br or {}).get("properties") or {}).get("type") or {}).get("const")
        if c is not None:
            oc_consts.add(c)
R(isinstance(oc_oneof, list) and {"success", "interrupt"} <= oc_consts,
  "구조: RunFinished.outcome oneOf 에 success·interrupt 분기",
  "분기 type.const=%s" % sorted(oc_consts))

# (d) 최상위 oneOf 가 이벤트 8종을 유일한 type.const 로 커버하는가($ref 해소).
top_consts = []
if isinstance(one_of, list):
    for br in one_of:
        ref = (br or {}).get("$ref", "")
        tgt = D.get(ref.split("/")[-1]) if ref else None
        c = (((tgt or {}).get("properties") or {}).get("type") or {}).get("const")
        top_consts.append(c)
uniq = set(top_consts)
R(len(top_consts) == 8 and len(uniq) == 8 and uniq == set(EVENT_DEFS),
  "구조: 최상위 oneOf 8분기 = 유일한 type.const 8종",
  "consts=%s" % sorted(x for x in top_consts if x is not None))

# (e) 닫힘성(closedness) 전수 단언 — 모든 이벤트 def(8종) + RunFinished.outcome 분기 + interrupt 분기 + patchOp 분기가
#     additionalProperties 를 '키로 보유' + 값이 '정확히 boolean False(`is False`)' 인가.
#     ★ Validator 는 인스턴스만 본다 → additionalProperties 를 삭제하거나(누락 시 기본 True) 문자열 "false"(truthy)로
#       바꾸면 잉여 키가 새는데도 인스턴스 검증만으론 못 잡는다. 여기서 손으로 고른 몇 개가 아니라 '전 def 균일 순회'로
#       닫힘을 강제한다(문자열 "false" 는 `is False` 가 아니라 실패 → mutation #1/#2 belt-and-suspenders).
def _closed(sub):
    return isinstance(sub, dict) and ("additionalProperties" in sub) and (sub["additionalProperties"] is False)
closed_targets = []  # (label, subschema)
for d in EVENT_DEFS:
    closed_targets.append((d, D.get(d)))
outcome_branches = (((D.get("RunFinished") or {}).get("properties") or {}).get("outcome") or {}).get("oneOf") or []
for i, br in enumerate(outcome_branches):
    closed_targets.append(("RunFinished.outcome[%d]" % i, br))
for i, br in enumerate((D.get("interrupt") or {}).get("oneOf") or []):
    closed_targets.append(("interrupt[%d]" % i, br))
for i, br in enumerate((D.get("patchOp") or {}).get("oneOf") or []):
    closed_targets.append(("patchOp[%d]" % i, br))
not_closed = []
for label, sub in closed_targets:
    if not _closed(sub):
        val = sub.get("additionalProperties", "<없음>") if isinstance(sub, dict) else "<비객체>"
        not_closed.append("%s→%r" % (label, val))
R(len(closed_targets) >= 8 + 2 + 2 and not not_closed,
  "구조: 전 def 닫힘(이벤트 8종·outcome·interrupt·patchOp 분기 additionalProperties===False)",
  "위반=%s" % not_closed if not_closed else "%d개 subschema 전부 닫힘" % len(closed_targets))

# ── 1c) 스키마 구조 지문 잠금(structural fingerprint lock, stdlib-only) ────────────────
#   round-1~3 의 '표본 하나씩 때우기(sample whack-a-mole)'를 끝내는 결정적 장치. 지금(정답인) 스키마의 구조 지문을
#   아래 '하드코딩 기대값'과 정확 비교한다 → 어떤 약화(required 축소·additionalProperties 개방·oneOf 분기 필수필드
#   삭제·discriminant enum 축소·pattern 완화 등)든 계산 지문 ≠ 기대 지문 → FAIL. 기대값은 '지금 정답인' 파일에서
#   도출해 리터럴로 박았고, 계산측은 파일을 재파싱한다(자기비교 tautology 아님 — 기대는 상수, 계산은 재파싱).
#   ⇒ 의도적 계약 변경 시엔 이 리터럴을 명시적으로 갱신해야 통과한다(동결 계약의 올바른 동작: 계약 변경 = 명시적 테스트 갱신).

# (지문 1) 최상위 oneOf → $ref 해소 → type.const 8종이 '정확히' 기대 이름 집합인가. EXPECTED_EVENT_NAMES 는 EVENT_DEFS 와
#   독립된 리터럴이라(교차검증) EVENT_DEFS[:-1] 같은 소스 절단도 커버리지 잠금(아래)에서 잡힌다.
EXPECTED_EVENT_NAMES = ["Custom", "RunError", "RunFinished", "RunStarted",
                        "StateDelta", "StateSnapshot", "StepFinished", "StepStarted"]
fp_top_consts = sorted(x for x in top_consts if x is not None)
R(fp_top_consts == EXPECTED_EVENT_NAMES,
  "지문[1]: 최상위 oneOf 이벤트 8종 type.const = 기대 집합(정확)",
  "계산=%s" % fp_top_consts)

# (지문 2) 이벤트 8종 def 의 required 집합(정렬 튜플) + additionalProperties is False(파이썬 항등 — 문자열 'false'/키 누락은 실패).
EXPECTED_EVENT_FP = {
    "RunStarted":    (("runId", "threadId", "timestamp", "type"), True),
    "StepStarted":   (("stepName", "timestamp", "type"), True),
    "StepFinished":  (("stepName", "timestamp", "type"), True),
    "StateSnapshot": (("snapshot", "timestamp", "type"), True),
    "StateDelta":    (("delta", "timestamp", "type"), True),
    "RunFinished":   (("outcome", "timestamp", "type"), True),
    "RunError":      (("message", "timestamp", "type"), True),
    "Custom":        (("name", "timestamp", "type", "value"), True),
}
def _fp_req_closed(sub):
    req = sub.get("required") if isinstance(sub, dict) else None
    reqs = tuple(sorted(req)) if isinstance(req, list) else None
    ap_false = bool(isinstance(sub, dict) and ("additionalProperties" in sub) and (sub["additionalProperties"] is False))
    return (reqs, ap_false)
computed_event_fp = {d: _fp_req_closed(D.get(d)) for d in EXPECTED_EVENT_FP}
event_fp_diff = {k: (computed_event_fp[k], EXPECTED_EVENT_FP[k])
                 for k in EXPECTED_EVENT_FP if computed_event_fp.get(k) != EXPECTED_EVENT_FP[k]}
R(computed_event_fp == EXPECTED_EVENT_FP,
  "지문[2]: 이벤트 8종 def required 집합 + additionalProperties===False",
  "불일치=%s" % event_fp_diff if event_fp_diff else "8종 전부 일치")

# (지문 3·4) patchOp/interrupt/outcome 의 oneOf 분기를 'discriminant(const/enum 값 집합) → (required 정렬, 닫힘)' 지문으로 잠근다.
#   ★ round-3 갭: 분기 required 에서 op/path(patchOp)·interruptId/kind/phase(interrupt)·type(outcome) 를 지우거나 분기
#     additionalProperties 를 개방해도 인스턴스 표본만으론 샜다. discriminant 로 키잉해 분기별 required+닫힘을 정확 비교한다.
#     (dict 키가 discriminant frozenset 이므로 이 비교 자체가 '지문 4' — patchOp op enum / interrupt kind / outcome type
#      const·enum 집합이 기대와 정확히 일치함까지 강제한다.)
def _fp_disc(br, key):
    p = ((br or {}).get("properties") or {}).get(key) or {}
    if isinstance(p, dict) and "const" in p:
        return frozenset([p["const"]])
    if isinstance(p, dict) and isinstance(p.get("enum"), list):
        return frozenset(p["enum"])
    return frozenset()
def _fp_branches(branches, disc_key):
    out = {}
    for br in (branches or []):
        out[_fp_disc(br, disc_key)] = _fp_req_closed(br)
    return out
def _fp_show(d):  # frozenset 키를 정렬 튜플로 보기 좋게(진단 detail 전용).
    return {tuple(sorted(k)): v for k, v in d.items()}

EXPECTED_PATCHOP_FP = {
    frozenset(["add", "replace", "test"]): (("op", "path", "value"), True),
    frozenset(["move", "copy"]):           (("from", "op", "path"), True),
    frozenset(["remove"]):                 (("op", "path"), True),
}
EXPECTED_INTERRUPT_FP = {
    frozenset(["select"]):                           (("interruptId", "kind", "options", "phase"), True),
    frozenset(["approve", "revise", "raise-limit"]): (("interruptId", "kind", "phase"), True),
}
EXPECTED_OUTCOME_FP = {
    frozenset(["success"]):   (("type",), True),
    frozenset(["interrupt"]): (("interrupts", "type"), True),
}
computed_patchop_fp = _fp_branches((D.get("patchOp") or {}).get("oneOf"), "op")
computed_interrupt_fp = _fp_branches((D.get("interrupt") or {}).get("oneOf"), "kind")
computed_outcome_fp = _fp_branches(outcome_branches, "type")
R(computed_patchop_fp == EXPECTED_PATCHOP_FP,
  "지문[3a]: patchOp oneOf 3분기 discriminant(op)별 required+닫힘 정확 일치",
  "계산=%s" % _fp_show(computed_patchop_fp))
R(computed_interrupt_fp == EXPECTED_INTERRUPT_FP,
  "지문[3b]: interrupt oneOf 2분기 discriminant(kind)별 required+닫힘 정확 일치",
  "계산=%s" % _fp_show(computed_interrupt_fp))
R(computed_outcome_fp == EXPECTED_OUTCOME_FP,
  "지문[3c]: RunFinished.outcome oneOf 2분기 discriminant(type)별 required+닫힘 정확 일치",
  "계산=%s" % _fp_show(computed_outcome_fp))

# (지문 4) timestamp $def 의 pattern 이 비어있지 않고 기대 정규식과 정확 일치(완화 시 FAIL; 음성표본 bad_timestamp 와 belt-and-suspenders).
EXPECTED_TS_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
ts_pattern = (D.get("timestamp") or {}).get("pattern")
R(isinstance(ts_pattern, str) and len(ts_pattern) >= 1 and ts_pattern == EXPECTED_TS_PATTERN,
  "지문[4]: timestamp pattern 비어있지 않음 + 기대 정규식 정확 일치",
  "pattern=%r" % ts_pattern)

# (지문 5) 값 제약(load-bearing value constraint) 잠금 — 구조 지문[1]~[4](required 집합·닫힘·discriminant enum·timestamp
#   pattern)가 커버하지 못하는 '값 수준' 제약을 리터럴 기대값으로 핀한다. 완화 시 음성표본이 미처 못 잡는 구멍이 생긴다:
#   minItems 삭제→빈 배열 허용 · enum 확장/축소 · minLength 삭제→빈 문자열 허용. 기대는 상수(현 정답 스키마에서 도출한
#   리터럴), 계산은 D 재파싱(자기비교 tautology 아님). ⚠ 이 지문[5]는 스키마(projection) 값 제약이며, 아래 카탈로그
#   섹션의 지문[5]~[8](a2ui-catalog.json)과는 독립된 별도 지문 계열이다.
def _branch_by_disc(branches, key, want):  # discriminant(const==want 또는 enum 에 want 포함)로 oneOf 분기 1개 선택.
    for br in (branches or []):
        p = ((br or {}).get("properties") or {}).get(key) or {}
        if isinstance(p, dict) and (p.get("const") == want or (isinstance(p.get("enum"), list) and want in p["enum"])):
            return br
    return {}
interrupt_oneof = (D.get("interrupt") or {}).get("oneOf") or []
sel_branch = _branch_by_disc(interrupt_oneof, "kind", "select")           # kind.const == "select"
plain_branch = _branch_by_disc(interrupt_oneof, "kind", "approve")        # kind.enum ∋ "approve"(approve/revise/raise-limit)
int_out_branch = _branch_by_disc(outcome_branches, "type", "interrupt")   # outcome.type.const == "interrupt"
fp5 = []  # 위반 목록(비면 통과).

# (5a) select interrupt 분기 options.minItems == 1 — 빈 options 는 무효로 유지.
sel_opts_min = ((sel_branch.get("properties") or {}).get("options") or {}).get("minItems")
if sel_opts_min != 1:
    fp5.append("interrupt[select].options.minItems=%r(기대 1)" % sel_opts_min)

# (5b) RunFinished.outcome interrupt 분기 interrupts.minItems == 1 — 빈 interrupts 는 무효로 유지.
int_min = ((int_out_branch.get("properties") or {}).get("interrupts") or {}).get("minItems")
if int_min != 1:
    fp5.append("outcome[interrupt].interrupts.minItems=%r(기대 1)" % int_min)

# (5c) Custom.name enum == 정확 집합(frozenset 비교) — 신호 종류 확장/축소 차단.
EXPECTED_CUSTOM_NAMES = frozenset(["kcia.verdict", "harness.escalated", "harness.ingest-incomplete"])
custom_enum = ((D.get("Custom") or {}).get("properties") or {}).get("name", {}).get("enum") if isinstance(D.get("Custom"), dict) else None
if not (isinstance(custom_enum, list) and frozenset(custom_enum) == EXPECTED_CUSTOM_NAMES):
    fp5.append("Custom.name.enum=%r(기대 %s)" % (custom_enum, sorted(EXPECTED_CUSTOM_NAMES)))

# (5d) 빈 문자열 금지 필드 minLength == 1 — 삭제 시 빈 문자열이 새어 통과하므로 전 필드 균일 핀.
def _prop(defn, prop):
    return ((D.get(defn) or {}).get("properties") or {}).get(prop) or {}
minlen_targets = [
    ("RunStarted.threadId", _prop("RunStarted", "threadId")),
    ("RunStarted.runId", _prop("RunStarted", "runId")),
    ("StepStarted.stepName", _prop("StepStarted", "stepName")),
    ("StepFinished.stepName", _prop("StepFinished", "stepName")),
    ("RunError.message", _prop("RunError", "message")),
    ("timestamp($def)", D.get("timestamp") or {}),
    ("interrupt[select].interruptId", (sel_branch.get("properties") or {}).get("interruptId") or {}),
    ("interrupt[approve/revise/raise-limit].interruptId", (plain_branch.get("properties") or {}).get("interruptId") or {}),
]
for label, sub in minlen_targets:
    ml = sub.get("minLength") if isinstance(sub, dict) else None
    if ml != 1:
        fp5.append("%s.minLength=%r(기대 1)" % (label, ml))

R(not fp5,
  "지문[5]: 값 제약 잠금(select options·interrupt interrupts minItems==1 · Custom.name enum · 비어있지 않은 문자열 minLength==1)",
  "위반=%s" % fp5 if fp5 else "값 제약 11건(minItems 2·enum 1·minLength 8) 전부 일치")

# ── 2) a2ui 카탈로그 무결성 ────────────────────────────────────────────────────
catalog = None
try:
    catalog = load_json(catalog_path)
    R(True, "카탈로그: JSON 파싱", "ok")
except Exception as e:
    R(False, "카탈로그: JSON 파싱", "파싱 실패: %s" % e)

C = catalog if isinstance(catalog, dict) else {}
req_keys = ["catalogId", "a2ui_version", "components", "surfaces", "actions"]
cat_missing = [k for k in req_keys if k not in C]
R(not cat_missing,
  "카탈로그: 필수 최상위 키(catalogId·a2ui_version·components·surfaces·actions)",
  "누락=%s" % cat_missing if cat_missing else "전부 존재")

R(C.get("a2ui_version") == "0.9.1", "카탈로그: a2ui_version == 0.9.1", repr(C.get("a2ui_version")))

# components 는 비어있지 않은 리스트(삭제/공백 차단).
comps = C.get("components")
comp_names = set()
if isinstance(comps, list):
    for c in comps:
        n = c.get("component") if isinstance(c, dict) else None
        if n:
            comp_names.add(n)
R(isinstance(comps, list) and len(comps) >= 1 and comp_names,
  "카탈로그: components 비어있지 않은 리스트",
  "개수=%s 이름=%s" % (len(comps) if isinstance(comps, list) else None, sorted(comp_names)))

# surfaces 는 비어있지 않은 객체(삭제 차단).
surfaces = C.get("surfaces")
R(isinstance(surfaces, dict) and len(surfaces) >= 1,
  "카탈로그: surfaces 비어있지 않은 객체",
  "개수=%s" % (len(surfaces) if isinstance(surfaces, dict) else None))

# 최상위 actions 는 정확히 4개(현업 4동작) + 각각 실 스크립트로 매핑(script 필드 존재). _ 접두 키(_comment 등)는 주석이라 제외.
acts = C.get("actions")
act_keys = {k for k in acts if not k.startswith("_")} if isinstance(acts, dict) else set()
acts_ok = isinstance(acts, dict) and act_keys == REAL_ACTIONS \
    and all(isinstance(acts[k], dict) and acts[k].get("script") for k in act_keys)
R(acts_ok, "카탈로그: actions = 4동작(select/approve/revise/raise-limit) + 각 script 매핑",
  "keys=%s" % sorted(act_keys))

def surface_actions(s):
    out = set(s.get("actions", []) or [])
    for st in (s.get("steps", []) or []):
        out |= set(st.get("actions", []) or [])
    return out

def surface_components(s):
    out = set(s.get("components", []) or [])
    for st in (s.get("steps", []) or []):
        out |= set(st.get("components", []) or [])
    return out

# 각 surface 의 선언된 actions 가 실 스크립트로 매핑되는 이름만 참조하는가(삭제/오타/유령 action 차단).
bad_act_surfaces = []
for name, s in (surfaces or {}).items():
    if not isinstance(s, dict):
        bad_act_surfaces.append("%s(비객체)" % name); continue
    sa = surface_actions(s)
    if not sa:
        bad_act_surfaces.append("%s(actions 없음)" % name); continue
    stray = sa - REAL_ACTIONS
    if stray:
        bad_act_surfaces.append("%s→%s" % (name, sorted(stray)))
R(isinstance(surfaces, dict) and not bad_act_surfaces,
  "카탈로그: 모든 surface 의 actions ⊆ 실 스크립트(select/approve/revise/raise-limit)",
  "위반=%s" % bad_act_surfaces if bad_act_surfaces else "정합")

# HIGH-3: surface 별 action 집합이 런타임(next-action.sh · phase-descriptors.json)이 실제로 내는 것과 '정확히' 일치하는가.
#   ★ 부분집합(⊆)만 요구하면 필수 action 삭제(예 select surface 에서 select 제거 → {revise} 만 남아도 ⊆ 통과)를 놓친다.
#     set == 로 정확 일치를 강제한다. 근거(next-action.sh 실동작 · phase-descriptors.json):
#       · status=escalated → action=raise-limit(revise_available=False: gate=review 라 revise 불가)  ⇒ escalated={raise-limit}
#       · gate=select & status=pending → action=select, revise_available=True                        ⇒ select={select,revise}
#       · gate=user   & status=pending → action=approve, revise_available=True                       ⇒ approve={approve,revise}
#       · 04-keyvisual needs_approve_after_select=true → select 다음 approve, 두 단계 모두 revise 가용  ⇒ keyvisual={select,approve,revise}
#       · raise-limit surface = 한도 상향 확정 전용                                                     ⇒ raise-limit={raise-limit}
EXPECTED_SURFACE_ACTIONS = {
    "select":      {"select", "revise"},
    "approve":     {"approve", "revise"},
    "keyvisual":   {"select", "approve", "revise"},
    "raise-limit": {"raise-limit"},
    "escalated":   {"raise-limit"},
}
R(isinstance(surfaces, dict) and set(surfaces.keys()) == set(EXPECTED_SURFACE_ACTIONS.keys()),
  "카탈로그: surface 집합 = 런타임 5종(select/approve/keyvisual/raise-limit/escalated)",
  "실제=%s" % (sorted(surfaces.keys()) if isinstance(surfaces, dict) else None))
wrong_exact = []
for name, want in EXPECTED_SURFACE_ACTIONS.items():
    s = (surfaces or {}).get(name) if isinstance(surfaces, dict) else None
    got = surface_actions(s) if isinstance(s, dict) else set()
    if got != want:
        wrong_exact.append("%s→got=%s want=%s" % (name, sorted(got), sorted(want)))
R(isinstance(surfaces, dict) and not wrong_exact,
  "카탈로그: 각 surface 의 actions 가 런타임 필수 집합과 '정확히' 일치(set ==)",
  "불일치=%s" % wrong_exact if wrong_exact else "5종 전부 정확 일치")

# keyvisual 은 2단계(select→approve) 미니워크플로우 — 각 step 의 action 집합·순서도 정확 검증(step drift 차단).
kv = (surfaces or {}).get("keyvisual") if isinstance(surfaces, dict) else None
kv_steps = kv.get("steps") if isinstance(kv, dict) else None
kv_step_actions = [(st.get("step"), set(st.get("actions", []) or [])) for st in kv_steps] \
    if isinstance(kv_steps, list) else []
kv_ok = kv_step_actions == [("select", {"select", "revise"}), ("approve", {"approve", "revise"})]
R(kv_ok, "카탈로그: keyvisual steps = [select→{select,revise}, approve→{approve,revise}] (needs_approve_after_select 정합)",
  "steps=%s" % [(n, sorted(a)) for n, a in kv_step_actions])

# 각 surface 의 components 가 카탈로그 component 목록에 실재하는가(component 섹션 삭제/오타 차단).
bad_comp_surfaces = []
for name, s in (surfaces or {}).items():
    if not isinstance(s, dict):
        continue
    stray = surface_components(s) - comp_names
    if stray:
        bad_comp_surfaces.append("%s→%s" % (name, sorted(stray)))
R(isinstance(surfaces, dict) and comp_names and not bad_comp_surfaces,
  "카탈로그: 모든 surface 의 components ⊆ 카탈로그 components",
  "위반=%s" % bad_comp_surfaces if bad_comp_surfaces else "정합")

# HIGH-4 잠금: escalated surface 가 런타임(gate.sh·next-action.sh·revise.sh)과 정합해야 한다.
#   에스컬레이션 = gate="review"·status=escalated → next-action action=raise-limit(자기해결) · revise 불가.
esc = (surfaces or {}).get("escalated") if isinstance(surfaces, dict) else None
esc_ok = isinstance(esc, dict) and esc.get("gate") == "review" \
    and surface_actions(esc) == {"raise-limit"}
R(esc_ok, "카탈로그: escalated surface 런타임 정합(gate=review · actions=[raise-limit] · revise 없음)",
  "gate=%s actions=%s" % ((esc or {}).get("gate"), sorted(surface_actions(esc)) if isinstance(esc, dict) else None))

# ── 2c) a2ui 카탈로그 구조 지문 잠금 ─────────────────────────────────────────────────
#   round-3 갭 #2: effective(직접∪step) 합집합만 보면 keyvisual 처럼 step 이 있는 surface 는 DIRECT 목록 삭제가 합집합에
#   가려 샌다(예 keyvisual.actions 에서 select 를 지워도 step 이 채워 union 은 그대로). DIRECT actions·DIRECT components 를
#   surface 별로 '정확 집합'으로 잠그고, 카탈로그 component 이름·최상위 action 키·버전도 하드코딩 기대값에 핀한다.

# (지문 5) a2ui_version 핀(위 라인의 == 0.9.1 검사와 belt-and-suspenders; 지문 블록 자기완결성).
EXPECTED_A2UI_VERSION = "0.9.1"
R(C.get("a2ui_version") == EXPECTED_A2UI_VERSION,
  "지문[5]: a2ui_version 핀 == %s" % EXPECTED_A2UI_VERSION, repr(C.get("a2ui_version")))

# (지문 6) 최상위 actions 키 = 실 스크립트 4동작(정확 집합).
EXPECTED_ACTION_KEYS = {"select", "approve", "revise", "raise-limit"}
R(act_keys == EXPECTED_ACTION_KEYS,
  "지문[6]: 최상위 actions 키 = 4동작(정확 집합)", "계산=%s" % sorted(act_keys))

# (지문 7) surface 별 DIRECT actions(steps 와 합치지 않은 s['actions']) 정확 일치 — keyvisual DIRECT 삭제(round-3 갭 #2) 봉인.
#   근거(next-action.sh · phase-descriptors.json): escalated→raise-limit · select/user-pending·revise_available · keyvisual needs_approve_after_select.
EXPECTED_SURFACE_DIRECT_ACTIONS = {
    "select":      {"select", "revise"},
    "approve":     {"approve", "revise"},
    "keyvisual":   {"select", "approve", "revise"},
    "raise-limit": {"raise-limit"},
    "escalated":   {"raise-limit"},
}
direct_act_diff = []
for name, want in EXPECTED_SURFACE_DIRECT_ACTIONS.items():
    s = (surfaces or {}).get(name) if isinstance(surfaces, dict) else None
    got = set(s.get("actions", []) or []) if isinstance(s, dict) else set()
    if got != want:
        direct_act_diff.append("%s→got=%s want=%s" % (name, sorted(got), sorted(want)))
R(isinstance(surfaces, dict)
  and set((surfaces or {}).keys()) == set(EXPECTED_SURFACE_DIRECT_ACTIONS.keys())
  and not direct_act_diff,
  "지문[7]: 각 surface 의 DIRECT actions(step 미합집합) 정확 일치",
  "불일치=%s" % direct_act_diff if direct_act_diff else "5종 DIRECT actions 전부 일치")
# (지문 7b) keyvisual per-step actions 정확 — 위 kv_ok 와 동일 근거를 지문으로도 봉인(step drift 이중잠금).
EXPECTED_KV_STEP_ACTIONS = [("select", {"select", "revise"}), ("approve", {"approve", "revise"})]
R(kv_step_actions == EXPECTED_KV_STEP_ACTIONS,
  "지문[7b]: keyvisual per-step actions = [select→{select,revise}, approve→{approve,revise}] 정확",
  "계산=%s" % [(n, sorted(a)) for n, a in kv_step_actions])

# (지문 8) 카탈로그 component 이름 전수 + surface 별 DIRECT components 정확 집합.
EXPECTED_CATALOG_COMPONENTS = {"Card", "Text", "Badge", "ChoiceButton", "ApproveButton", "ReviseButton", "FileLink"}
R(comp_names == EXPECTED_CATALOG_COMPONENTS,
  "지문[8a]: 카탈로그 components 이름 = 기대 7종(정확 집합)", "계산=%s" % sorted(comp_names))
EXPECTED_SURFACE_DIRECT_COMPONENTS = {
    "select":      {"Card", "Badge", "ChoiceButton", "ReviseButton", "FileLink"},
    "approve":     {"Text", "ApproveButton", "ReviseButton", "FileLink"},
    "keyvisual":   {"Card", "Badge", "ChoiceButton", "ApproveButton", "ReviseButton", "FileLink"},
    "raise-limit": {"Text", "ApproveButton"},
    "escalated":   {"Text", "ApproveButton"},
}
direct_comp_diff = []
for name, want in EXPECTED_SURFACE_DIRECT_COMPONENTS.items():
    s = (surfaces or {}).get(name) if isinstance(surfaces, dict) else None
    got = set(s.get("components", []) or []) if isinstance(s, dict) else set()
    if got != want:
        direct_comp_diff.append("%s→got=%s want=%s" % (name, sorted(got), sorted(want)))
R(not direct_comp_diff,
  "지문[8b]: 각 surface 의 DIRECT components 정확 집합 일치",
  "불일치=%s" % direct_comp_diff if direct_comp_diff else "5종 DIRECT components 전부 일치")

# ── 3) 사용성 — 표본 이벤트가 레포 Validator 로 실제 검증/거부되는가 ──────────────
def validate_event(ev):
    """레포 Validator 로 이벤트 1건 검증 → 오류 목록 반환(빈 목록=통과)."""
    v = Validator(schema)
    v.validate(ev, schema)
    return v.errors

if isinstance(schema, dict):
    # ── 양성 표본(반드시 통과) ──
    ev_run_started = {"type": "RunStarted", "threadId": "ezderm-x",
                      "runId": "ezderm-x#01-brief@1", "timestamp": "2026-07-11T03:00:00Z"}
    ev_state_delta = {"type": "StateDelta",
                      "delta": [{"op": "replace", "path": "/phase", "value": "01-brief"},
                                {"op": "replace", "path": "/iteration", "value": 2}],
                      "timestamp": "2026-07-11T03:15:31Z"}
    ev_state_delta_allops = {"type": "StateDelta",
                             "delta": [{"op": "add", "path": "/x", "value": 1},
                                       {"op": "remove", "path": "/y"},
                                       {"op": "move", "path": "/z", "from": "/w"}],
                             "timestamp": "2026-07-11T03:15:32Z"}
    ev_run_finished_select = {"type": "RunFinished",
                       "outcome": {"type": "interrupt",
                                   "interrupts": [{"interruptId": "concept-select-1", "kind": "select",
                                                   "phase": "02-concept", "options": ["A-efficacy", "B", "C"],
                                                   "recommended": "A-efficacy"}]},
                       "timestamp": "2026-07-11T03:48:19Z"}
    ev_run_finished_success = {"type": "RunFinished", "outcome": {"type": "success"},
                               "timestamp": "2026-07-11T04:00:00Z"}
    ev_run_finished_approve = {"type": "RunFinished",
                       "outcome": {"type": "interrupt",
                                   "interrupts": [{"interruptId": "brief-approve-1", "kind": "approve",
                                                   "phase": "01-brief"}]},
                       "timestamp": "2026-07-11T03:20:00Z"}
    ev_now_iso = {"type": "RunStarted", "threadId": "ezderm-x",
                  "runId": "ezderm-x#01-brief@1", "timestamp": now_iso()}

    # ── 음성 표본(반드시 거부) ──
    bad_unknown_type = {"type": "Bogus", "timestamp": "2026-07-11T03:00:00Z"}
    bad_missing_field = {"type": "RunStarted", "threadId": "x", "timestamp": "2026-07-11T03:00:00Z"}  # runId 누락
    bad_replace_no_value = {"type": "StateDelta", "delta": [{"op": "replace", "path": "/x"}],
                            "timestamp": "2026-07-11T03:00:00Z"}                                       # HIGH-1
    bad_move_no_from = {"type": "StateDelta", "delta": [{"op": "move", "path": "/x"}],
                        "timestamp": "2026-07-11T03:00:00Z"}                                           # HIGH-1
    bad_remove_stray_value = {"type": "StateDelta", "delta": [{"op": "remove", "path": "/x", "value": 1}],
                              "timestamp": "2026-07-11T03:00:00Z"}                                     # HIGH-1(additionalProperties)
    bad_interrupt_no_interrupts = {"type": "RunFinished", "outcome": {"type": "interrupt"},
                                   "timestamp": "2026-07-11T03:00:00Z"}                                # HIGH-2
    bad_success_with_interrupts = {"type": "RunFinished",
                                   "outcome": {"type": "success",
                                               "interrupts": [{"interruptId": "x", "kind": "approve", "phase": "01-brief"}]},
                                   "timestamp": "2026-07-11T03:00:00Z"}                                # HIGH-2
    bad_select_no_options = {"type": "RunFinished",
                             "outcome": {"type": "interrupt",
                                         "interrupts": [{"interruptId": "c1", "kind": "select", "phase": "02-concept"}]},
                             "timestamp": "2026-07-11T03:00:00Z"}                                      # HIGH-2
    bad_timestamp = {"type": "RunStarted", "threadId": "x", "runId": "x#01@1",
                     "timestamp": "not-a-timestamp"}                                                   # MED-2

    def POS(ev, label):
        e = validate_event(ev)
        R(not e, label, "오류=%s" % e if e else "검증 통과")

    def NEG(ev, label):
        e = validate_event(ev)
        R(bool(e), label, "거부됨" if e else "거부 실패(통과돼 버림)")

    # ── 8종 전수 표본: 이벤트 유형마다 (a) 양성 1건 통과 + (b) 잉여키 1개면 거부(닫힘 활성 증명) ──
    #   HIGH-3: 기존 양성 표본은 3종(RunStarted/StateDelta/RunFinished)만 덮었다 → 나머지 5종의 필드타입이 깨져도
    #   양성 표본이 없어 못 잡혔다(예 RunError.message 를 number 로 뒤집기). 8종 전수 양성으로 그 구멍을 막는다.
    #   또한 8종 전수 '잉여키 거부'로 어느 이벤트 def 든 additionalProperties 삭제/문자열화 시 그 def 표본이 통과돼 FAIL 난다.
    positives_by_type = {
        "RunStarted":    {"type": "RunStarted", "threadId": "ezderm-x",
                          "runId": "ezderm-x#01-brief@1", "timestamp": "2026-07-11T03:00:00Z"},
        "StepStarted":   {"type": "StepStarted", "stepName": "phase:01-brief",
                          "timestamp": "2026-07-11T03:01:00Z"},
        "StepFinished":  {"type": "StepFinished", "stepName": "review:brief",
                          "outcome": "passed", "timestamp": "2026-07-11T03:02:00Z"},
        "StateSnapshot": {"type": "StateSnapshot",
                          "snapshot": {"phase": "01-brief", "gate": "user", "status": "pending", "iteration": 1},
                          "timestamp": "2026-07-11T03:03:00Z"},
        "StateDelta":    {"type": "StateDelta",
                          "delta": [{"op": "replace", "path": "/phase", "value": "01-brief"}],
                          "timestamp": "2026-07-11T03:15:31Z"},
        "RunFinished":   {"type": "RunFinished", "outcome": {"type": "success"},
                          "timestamp": "2026-07-11T04:00:00Z"},
        "RunError":      {"type": "RunError", "message": "fail-closed 중단(인입 미완결)",
                          "code": "E_INGEST_INCOMPLETE", "timestamp": "2026-07-11T03:30:00Z"},
        "Custom":        {"type": "Custom", "name": "kcia.verdict",
                          "value": {"verdict": "pass", "engine": "adk-http"},
                          "timestamp": "2026-07-11T03:48:00Z"},
    }
    # 닫힘-음성 표본 dict(round-3 gap #3): 각 양성 표본에 미지 잉여키 1개 → additionalProperties:false 활성 증명용. EVENT_DEFS 로부터 조립.
    closedness_neg_by_type = {}
    for etype in EVENT_DEFS:
        _bad = dict(positives_by_type[etype]); _bad["__unknown_extra__"] = "leak"
        closedness_neg_by_type[etype] = _bad

    # ── 표본 커버리지 잠금(round-3 gap #3) ──
    #   양성·닫힘음성 표본 dict 이 '정확히' 8 이벤트 유형을 덮는가. EXPECTED_EVENT_NAMES 는 EVENT_DEFS 와 독립된 리터럴이라,
    #   EVENT_DEFS[:-1] 같은 소스 절단(예 Custom 조용히 드롭)은 여기서 커버리지 불일치로 FAIL 난다(출력 절단 __COUNT__ 로는
    #   자동정합돼 못 잡던 갭). 두 dict 을 독립 검사(양성=리터럴 dict / 닫힘음성=EVENT_DEFS 조립)해 두 절단 벡터를 모두 봉인.
    R(set(positives_by_type.keys()) == set(EXPECTED_EVENT_NAMES),
      "커버리지: 양성 표본 dict 키 = 이벤트 8종(정확)", "계산=%s" % sorted(positives_by_type.keys()))
    R(set(closedness_neg_by_type.keys()) == set(EXPECTED_EVENT_NAMES),
      "커버리지: 닫힘-음성 표본 dict 키 = 이벤트 8종(정확)", "계산=%s" % sorted(closedness_neg_by_type.keys()))

    for etype in EVENT_DEFS:
        POS(positives_by_type[etype], "표본+[8종]: %s 유효 인스턴스 통과" % etype)
    for etype in closedness_neg_by_type:
        NEG(closedness_neg_by_type[etype], "표본-[닫힘 8종]: %s + 미지 잉여키 거부(additionalProperties:false 활성)" % etype)

    POS(ev_run_started, "표본+: RunStarted 통과")
    POS(ev_state_delta, "표본+: StateDelta(replace) 통과")
    POS(ev_state_delta_allops, "표본+: StateDelta(add/remove/move 전분기) 통과")
    POS(ev_run_finished_select, "표본+: RunFinished(interrupt=select+options) 통과")
    POS(ev_run_finished_success, "표본+: RunFinished(success) 통과")
    POS(ev_run_finished_approve, "표본+: RunFinished(interrupt=approve, options 없음) 통과")
    POS(ev_now_iso, "표본+: RunStarted(now_iso() 실 타임스탬프) 통과")

    NEG(bad_unknown_type, "표본-: 미지 type 거부")
    NEG(bad_missing_field, "표본-: RunStarted runId 누락 거부")
    NEG(bad_replace_no_value, "표본-: patchOp replace(value 없음) 거부")
    NEG(bad_move_no_from, "표본-: patchOp move(from 없음) 거부")
    NEG(bad_remove_stray_value, "표본-: patchOp remove(잉여 value) 거부")
    NEG(bad_interrupt_no_interrupts, "표본-: RunFinished interrupt(interrupts 없음) 거부")
    NEG(bad_success_with_interrupts, "표본-: RunFinished success(interrupts 실림) 거부")
    NEG(bad_select_no_options, "표본-: interrupt select(options 없음) 거부")
    NEG(bad_timestamp, "표본-: timestamp not-a-timestamp 거부")
else:
    R(False, "표본: 스키마 로드 실패로 검증 불가", "schema is not dict")

for ok, label, detail in results:
    print("%s\t%s\t%s" % ("OK" if ok else "FAIL", label, detail))
# 완결 마커(부분출력 방어): 러너가 끝까지 돌았으면 마지막에 결과 줄 수를 보고한다. bash 가 이 수와 실제 파싱 줄 수를 대조.
print("__COUNT__\t%d\t" % len(results))
sys.exit(0 if all(ok for ok, _, _ in results) else 1)
PY
AGUI_RC=$?   # 러너 종료코드 즉시 캡처(다음 문장이 덮어쓰기 전에).
AGUI_OUT="$(cat "$AGUI_TMP")"
rm -f "$AGUI_TMP"

# fail-closed: 러너가 못 돌아 빈 출력/비정상 종료여도 '공허 통과' 금지.
check "러너 정상 완료(rc∈{0,1}, 크래시 아님)" '[ "$AGUI_RC" = "0" ] || [ "$AGUI_RC" = "1" ]'
check "러너 출력 비어있지 않음(fail-closed)" '[ -n "$AGUI_OUT" ]'

NLINES=0
EXPECTED=""
while IFS=$'\t' read -r status label detail; do
  [ -z "${status:-}" ] && continue
  if [ "$status" = "__COUNT__" ]; then EXPECTED="$label"; continue; fi
  [ -z "${label:-}" ] && continue
  NLINES=$((NLINES+1))
  if [ "$status" = "OK" ]; then
    pass "$label — $detail"
  else
    fail "$label — $detail"
  fi
done <<< "$AGUI_OUT"

# 부분출력 방어: 완결 마커(__COUNT__)를 받았고, 그 개수와 실제 파싱된 결과 줄 수가 정확히 일치해야 한다.
#   (하드코딩 상수 대신 러너가 스스로 보고 → 표본/구조 검사 추가·삭제에도 자동 정합, 그러면서도 중간 크래시엔 fail-closed.)
check "완결 마커(__COUNT__) 수신 — 부분출력 아님" '[ -n "$EXPECTED" ]'
check "처리된 결과 줄 = 러너 보고 개수($EXPECTED)" '[ -n "$EXPECTED" ] && [ "$NLINES" = "$EXPECTED" ]'

printf '\n[agui-contracts] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
