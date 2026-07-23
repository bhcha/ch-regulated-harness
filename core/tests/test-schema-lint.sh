#!/usr/bin/env bash
# test-schema-lint.sh — K-4: 스키마 간 패턴/enum 문자열 정합 lint(드리프트 감시).
#   스키마 무수정. 같은 의미의 정규식/enum 이 여러 harness/*.schema.json 에 중복 정의돼 있을 때
#   서로 어긋나면(드리프트) 실패한다. 현재 스키마가 이미 정합이면 통과한다.
#   대상 3키:
#     - functional_status : status 값 enum(state.schema 인라인 enum ≡ claim-basis funcEntry.status.enum)
#     - reference_image_id : join 키 정규식(plan-block ≡ tone-direction)
#     - regulatory_domain  : 구조 정규식(pattern 을 가진 스키마들끼리 — state·brief·golden-set).
#         정직화: claim-basis·reference-notes·example-analysis 는 도메인을 '참조'만 하는 문서라 의도적 loose(엄격 미강제)
#         → 비교 대상 아님. 단 그 허용목록 '밖'의 스키마가 pattern 없이 regulatory_domain 을 선언하면 DRIFT(누락 포착).
#   ⚠ 파일 간 $ref 미사용(검증기 지원 확인 전 금지) — 순수 '문자열 일치' 단정만.
#   ⚠ 각 파일 내부의 지역 $ref(#/$defs/…)는 그 파일 안 JSON 탐색일 뿐(스키마 무수정).
#   ⚠ phase enum 3곳(state·pipeline-routes·phase-descriptors)은 의도된 동결 계약 → 비대상(건드리지 않음).
#   결정적(offline·no-LLM). harness/*.schema.json 을 읽기만 한다.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## K-4 — 스키마 정합 lint(패턴/enum 드리프트 감시)"

LINT_OUT="$(python3 - "$ROOT/harness" <<'PY'
import glob, json, os, sys

hdir = sys.argv[1]
schemas = {}
for p in sorted(glob.glob(os.path.join(hdir, "*.schema.json"))):
    with open(p, encoding="utf-8") as f:
        schemas[os.path.basename(p)] = json.load(f)

def find_nodes(obj, key):
    """트리 전체에서 key 에 배정된 값을 모두 yield(중첩 dict/list 재귀)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from find_nodes(v, key)
    elif isinstance(obj, list):
        for it in obj:
            yield from find_nodes(it, key)

def resolve_local_ref(doc, ref):
    """같은 파일 내부 포인터(#/…)만 해석. 파일 간 $ref 아님(순수 JSON 탐색)."""
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    node = doc
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node

results = []  # (key, ok, detail)

def check_pattern(key, loose_ok=None):
    """key 노드 중 pattern 을 가진 것들의 정규식을 파일별로 모아 정합 검사.
       loose_ok 지정 시 정직화 + 가드: pattern-없는 schema-형 노드(type/enum/$ref 가진 dict)를 '의도적 loose'로
       세되, 허용목록(loose_ok) 밖의 스키마가 그렇게 나타나면 DRIFT(새 스키마가 pattern 을 빠뜨린 경우 포착)."""
    seen = {}       # pattern -> [files]
    loose_bad = []  # 허용목록 밖에서 pattern 없이 나타난 schema-형(엄격 미강제) 파일
    for fname, doc in schemas.items():
        for node in find_nodes(doc, key):
            if not isinstance(node, dict):
                continue
            if "pattern" in node:
                seen.setdefault(node["pattern"], []).append(fname)
            elif loose_ok is not None and any(k in node for k in ("type", "enum", "$ref")):
                # schema-형(type/enum/$ref)인데 pattern 없음 = loose. 허용목록 밖이면 드리프트(허위양성 방지: schema-형만 셈).
                if fname not in loose_ok:
                    loose_bad.append(fname)
    nfiles = sum(len(v) for v in seen.values())
    if nfiles < 2:
        results.append((key, False, "SETUP: pattern 을 가진 스키마가 %d 곳뿐 — 정합 감시 대상 소실" % nfiles))
        return
    if len(seen) > 1:
        detail = "; ".join("%r in %s" % (p, ",".join(sorted(fs))) for p, fs in sorted(seen.items()))
        results.append((key, False, "DRIFT: " + detail))
        return
    if loose_bad:
        results.append((key, False, "DRIFT(loose): pattern 없는 schema 노드가 허용목록 밖 — %s (새 스키마가 pattern 누락?)"
                        % ",".join(sorted(set(loose_bad)))))
        return
    pat = next(iter(seen))
    files = ",".join(sorted(next(iter(seen.values()))))
    note = ""
    if loose_ok is not None:
        # 정직화: pattern-bearing 스키마만 비교한다. 아래 목록은 의도적 loose(엄격 미강제)라 비교 대상 아님.
        note = " · pattern-bearing 스키마만 비교; %s 는 의도적 loose(엄격 미강제)" % ",".join(sorted(loose_ok))
    results.append((key, True, "pattern=%r across %s%s" % (pat, files, note)))

check_pattern("reference_image_id")
# regulatory_domain 은 pattern-없는 참조-문서 스키마가 의도적으로 loose(도메인을 enum-강제하지 않음).
#   허용목록 = claim-basis · reference-notes · example-analysis(모두 도메인을 '참조'만 하는 문서). 이 밖의 스키마가
#   pattern 없이 regulatory_domain 을 선언하면 = 새 스키마의 pattern 누락 드리프트로 실패한다.
LOOSE_REGDOMAIN_OK = {"claim-basis.schema.json", "reference-notes.schema.json", "example-analysis.schema.json"}
check_pattern("regulatory_domain", loose_ok=LOOSE_REGDOMAIN_OK)

def status_enum(doc, node):
    """functional_status 노드에서 status 값 enum 을 뽑는다.
       state = additionalProperties.enum(인라인) · claim-basis = additionalProperties.$ref→funcEntry.properties.status.enum."""
    if not isinstance(node, dict):
        return None
    ap = node.get("additionalProperties")
    if isinstance(ap, dict):
        if isinstance(ap.get("enum"), list):
            return ap["enum"]
        if "$ref" in ap:
            tgt = resolve_local_ref(doc, ap["$ref"])
            if isinstance(tgt, dict):
                st = tgt.get("properties", {}).get("status", {})
                if isinstance(st, dict) and isinstance(st.get("enum"), list):
                    return st["enum"]
    return None

fs_seen = {}  # frozenset(enum) -> [files]  — JSON enum 순서는 무의미하므로 순서-불변 비교(순서민감 tuple 지양).
for fname, doc in schemas.items():
    for node in find_nodes(doc, "functional_status"):
        e = status_enum(doc, node)
        if e is not None:
            fs_seen.setdefault(frozenset(e), []).append(fname)
nfs = sum(len(v) for v in fs_seen.values())
if nfs < 2:
    results.append(("functional_status", False, "SETUP: status enum 을 가진 스키마가 %d 곳뿐 — 정합 감시 대상 소실" % nfs))
elif len(fs_seen) > 1:
    detail = "; ".join("%s in %s" % (sorted(e), ",".join(sorted(fs))) for e, fs in fs_seen.items())
    results.append(("functional_status", False, "DRIFT: " + detail))
else:
    e = sorted(next(iter(fs_seen)))  # 결정적 출력(정렬)
    files = ",".join(sorted(next(iter(fs_seen.values()))))
    results.append(("functional_status", True, "status enum=%s across %s" % (e, files)))

for key, ok, detail in results:
    print("%s\t%s\t%s" % ("OK" if ok else "DRIFT", key, detail))
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
PY
)"
LINT_RC=$?   # 러너 종료코드 즉시 캡처(다음 문장이 덮어쓰기 전에). 정상 완주면 0(all OK) 또는 1(drift)만 나온다.

# fail-closed: 러너가 못 돌아 빈 출력/비정상 종료여도 '공허 통과'하지 않는다.
#   ① 종료코드가 0/1(정상 완주) 아니면 실패  ② 출력이 비어있지 않아야 함  ③ 처리된 결과 줄이 정확히 3개여야 함.
check "lint 러너 정상 완료(rc∈{0,1}, 크래시 아님)" '[ "$LINT_RC" = "0" ] || [ "$LINT_RC" = "1" ]'
check "lint 출력 비어있지 않음(fail-closed)" '[ -n "$LINT_OUT" ]'

NLINES=0
while IFS=$'\t' read -r status key detail; do
  [ -z "${key:-}" ] && continue
  NLINES=$((NLINES+1))
  if [ "$status" = "OK" ]; then
    pass "$key 정합 — $detail"
  else
    fail "$key — $detail"
  fi
done <<< "$LINT_OUT"

# 대상 3키(reference_image_id·regulatory_domain·functional_status)가 모두 처리됐는지 단정(부분출력 방어).
check "처리된 결과 줄 = 정확히 3(reference_image_id·regulatory_domain·functional_status)" '[ "$NLINES" -eq 3 ]'

printf '\n[schema-lint] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
