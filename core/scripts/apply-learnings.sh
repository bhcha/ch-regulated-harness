#!/usr/bin/env bash
# apply-learnings.sh — learned-proposal.json 의 **사람-승인** 후보를 팩 learned/deny.json 에 기록(Seam F 승격).
#   ⚠ 1급 경로: 팩 learned/ 는 스크립트만 쓴다(LLM/스킬은 직접 쓰지 않는다 — 00e apply-proposal 과 동형).
#   자동 승격 금지 — 승인된 term 만(--approve t1,t2 또는 --approve-all) + provenance.approved_at 기록(승인 없이 무효).
#   기존 deny.json 과 term 기준 dedup 병합(멱등 재적용 안전). scope=domain(금지어). state.json 무접촉.
# 사용법: apply-learnings.sh <domain> <proposal.json> [--approve t1,t2,...] [--approve-all] [--by NAME]
set -euo pipefail
DOMAIN="${1:?사용법: apply-learnings.sh <domain> <proposal.json> [--approve t1,t2|--approve-all] [--by NAME]}"
PROPOSAL="${2:?proposal.json 경로가 필요합니다}"
shift 2 || true

APPROVE=""
APPROVE_ALL=0
BY="${LEARN_APPROVED_BY:-unknown}"
while [ $# -gt 0 ]; do
  case "$1" in
    --approve) APPROVE="$2"; shift 2 ;;
    --approve-all) APPROVE_ALL=1; shift ;;
    --by) BY="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1 ;;
  esac
done

# domain 은 영숫자·-·_ 만('.'·'..'·'/' 거부 — Codex High: '.' 가 packs/./learned 로 새는 것 차단).
case "$DOMAIN" in ""|*[!A-Za-z0-9_-]*) echo "잘못된 domain: $DOMAIN (영숫자·-·_ 만)" >&2; exit 1 ;; esac
[ -f "$PROPOSAL" ] || { echo "proposal 없음: $PROPOSAL" >&2; exit 1; }

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export HARNESS_ROOT
PACKS_DIR="${PACKS_DIR:-$(cd "$HARNESS_ROOT/.." && pwd)/packs}"
# 등록된 팩에만 쓴다(Codex High) — domain.json 이 없으면 미등록 도메인/오경로이므로 fail-closed.
[ -f "$PACKS_DIR/$DOMAIN/domain.json" ] || { echo "미등록 도메인(팩 domain.json 없음): $PACKS_DIR/$DOMAIN" >&2; exit 1; }
APPROVED_AT="${LEARN_APPROVED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

python3 - "$DOMAIN" "$PROPOSAL" "$PACKS_DIR" "$APPROVE" "$APPROVE_ALL" "$BY" "$APPROVED_AT" <<'PY'
import sys, os, json

domain, proposal_p, packs_dir, approve_csv, approve_all, by, approved_at = sys.argv[1:8]
approve_all = approve_all == "1"
approved_terms = set(t for t in approve_csv.split(",") if t) if approve_csv else set()

with open(proposal_p, encoding="utf-8") as f:
    prop = json.load(f)
if not isinstance(prop, dict) or prop.get("domain") != domain:
    sys.stderr.write("proposal 의 domain 이 인자와 다릅니다(안전 중단).\n"); sys.exit(2)

cands = [c for c in (prop.get("candidates") or []) if isinstance(c, dict) and c.get("kind") == "deny"]
if not approve_all:
    cands = [c for c in cands if c.get("term") in approved_terms]
if not cands:
    sys.stderr.write("승인된 후보가 없습니다(--approve/--approve-all 확인). 기록 안 함.\n"); sys.exit(3)

ldir = os.path.join(packs_dir, domain, "learned")
os.makedirs(ldir, exist_ok=True)
deny_p = os.path.join(ldir, "deny.json")
try:
    with open(deny_p, encoding="utf-8") as f:
        deny = json.load(f)
    if not isinstance(deny, dict):
        deny = None
except Exception:
    deny = None
if deny is None:
    deny = {"domain": domain, "scope": "domain", "entries": []}
existing = {e.get("term") for e in deny.get("entries", []) if isinstance(e, dict)}

added = 0
for c in cands:
    term = c.get("term")
    if not term or term in existing:
        continue
    deny["entries"].append({
        "term": term, "kind": "deny",
        "applies_to": c.get("applies_to") or ["all"],
        "provenance": {
            "source_run_ids": c.get("source_run_ids") or [],
            "event": c.get("event") or "consistent_rejection",
            "rule": c.get("rule") or "",
            "approved_at": approved_at,
            "review_by": by,
        },
    })
    existing.add(term); added += 1

tmp = deny_p + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(deny, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, deny_p)
print("learned/deny.json 기록: %s (신규 %d건 · 총 %d건 · 승인자 %s)" % (deny_p, added, len(deny["entries"]), by))
PY
