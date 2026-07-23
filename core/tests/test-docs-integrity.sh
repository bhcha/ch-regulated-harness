#!/usr/bin/env bash
# test-docs-integrity.sh — 문서 무결성 가드(결정적·오프라인·no-LLM·골든 무영향).
#   문서 이동/리네임/링크깨짐이 조용히 새는 것을 기계로 막는다. 4가지를 본다:
#     1) 살아있는 문서(README·AGENTS·정본·계획·참조가이드)의 마크다운 링크가 전부 실제 파일/폴더로 해소되는가.
#        대상 = 루트 README.md · core/AGENTS.md · core/README.md · docs/README.md · docs/canonical/*.md · docs/plans/*.md · docs/reference/*.md.
#        (docs/snapshots·history·_archive 는 강등/스냅샷이라 링크 stale 허용 — 스캔 제외, 레포 선례.
#         docs/reference/workflow-diagram/ 는 .md 없음 — *.md glob 이 비재귀라 자동 제외.)
#     2) docs/plans/*.md 가 전부 docs/README.md(문서 지위표)에 등재됐는가(누락 계획 문서 포착).
#     3) D-1 정본 5종(README + canonical 4종)이 실존하는가.
#     4) 파이프라인이 경로-결합으로 소비하는 문서(core/docs/reference: regulation/·design-tokens·canon-blocks)가
#        실존하는가 — 이동/리네임 시 kcia-check.sh:351·prompts(keyvisual·storyboard-outline) 런타임이 깨진다.
#   결정적: 파일 텍스트·존재만 검사(네트워크·상태·런 없음).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 문서 무결성 — 링크 해소·plans 등재·정본 존재·파이프라인 소비경로 고정"

REPO="$(cd "$ROOT/.." && pwd)"   # ROOT=core → 레포 루트(형제)

# ── 1) 살아있는 문서의 마크다운 링크 해소 ──────────────────────────────────────
#   http(s)://·mailto:·순수 #앵커 는 스킵, 뒤따르는 #앵커 는 잘라 파일부만 검사, 링크가 든 파일 폴더 기준 해소.
LINK_OUT="$(python3 - "$REPO" <<'PY'
import glob, os, re, sys
repo = sys.argv[1]
live = [
    os.path.join(repo, "README.md"),
    os.path.join(repo, "core", "AGENTS.md"),
    os.path.join(repo, "core", "README.md"),
    os.path.join(repo, "docs", "README.md"),
]
live += sorted(glob.glob(os.path.join(repo, "docs", "canonical", "*.md")))
live += sorted(glob.glob(os.path.join(repo, "docs", "plans", "*.md")))
live += sorted(glob.glob(os.path.join(repo, "docs", "reference", "*.md")))   # 직속 *.md 만(workflow-diagram/ 는 .md 없음 → 비재귀)

LINK_RE = re.compile(r"\]\(([^)]+)\)")
n_files = n_links = 0
missing = []
for f in live:
    if not os.path.isfile(f):
        missing.append((os.path.relpath(f, repo), "<파일자체 부재>", ""))
        continue
    n_files += 1
    d = os.path.dirname(f)
    with open(f, encoding="utf-8") as fh:
        text = fh.read()
    for m in LINK_RE.finditer(text):
        raw = m.group(1).strip()
        if raw.startswith("<") and raw.endswith(">"):
            raw = raw[1:-1].strip()
        target = raw.split()[0] if raw else ""   # url "title" → url
        if not target or target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = target.split("#", 1)[0]          # 뒤따르는 #앵커 제거
        if not target:
            continue
        n_links += 1
        resolved = os.path.normpath(os.path.join(d, target))
        if not os.path.exists(resolved):
            missing.append((os.path.relpath(f, repo), target, os.path.relpath(resolved, repo)))

for f, t, r in missing:
    print("DANGLING\t%s\t%s\t%s" % (f, t, r))
print("SUMMARY\tfiles=%d\tlinks=%d\tmissing=%d" % (n_files, n_links, len(missing)))
sys.exit(0 if not missing else 1)
PY
)"
LINK_RC=$?   # 러너 종료코드 즉시 캡처.

# fail-closed: 러너가 못 돌아 빈 출력/비정상 종료여도 '공허 통과' 금지.
check "1) 링크검사 러너 정상 완료(rc∈{0,1}, 크래시 아님)" '[ "$LINK_RC" = "0" ] || [ "$LINK_RC" = "1" ]'
check "1) 링크검사 출력 비어있지 않음(fail-closed)" '[ -n "$LINK_OUT" ]'
LINKS_N="$(printf '%s\n' "$LINK_OUT" | sed -n 's/^SUMMARY.*links=\([0-9]*\).*/\1/p')"
check "1) 링크 타깃 추출(>0 — 검사대상 소실 방지)" "[ \"${LINKS_N:-0}\" -gt 0 ]"

DANGLING="$(printf '%s\n' "$LINK_OUT" | grep '^DANGLING' || true)"
if [ -z "$DANGLING" ]; then
  pass "1) 살아있는 문서 마크다운 링크 전부 해소(${LINKS_N:-0}건)"
else
  while IFS=$'\t' read -r _tag f t r; do
    [ -z "${f:-}" ] && continue
    fail "1) 끊어진 링크: $f → '$t' (해소경로 '$r' 없음 — 문서 이동/리네임 시 링크 동반갱신)"
  done <<< "$DANGLING"
fi

# ── 2) docs/plans/*.md 가 전부 docs/README.md(문서 지위표)에 등재 ──────────────
DOCS_README="$REPO/docs/README.md"
check "2) docs/README.md 존재" "[ -f \"$DOCS_README\" ]"
PLANS_MISSING=""
NPLANS=0
for p in "$REPO"/docs/plans/*.md; do
  [ -e "$p" ] || continue
  NPLANS=$((NPLANS+1))
  b="$(basename "$p")"
  grep -qF -- "$b" "$DOCS_README" || PLANS_MISSING="$PLANS_MISSING $b"
done
check "2) docs/plans/*.md 존재(>0 — 검사대상 소실 방지)" "[ $NPLANS -gt 0 ]"
if [ -z "$PLANS_MISSING" ]; then
  pass "2) docs/plans/*.md 전부 docs/README.md 지위표에 등재(${NPLANS}건)"
else
  fail "2) docs/README.md 지위표에 미등재 계획 문서(등재하라):$PLANS_MISSING"
fi

# ── 3) D-1 정본 5종 실존 ───────────────────────────────────────────────────────
for rel in docs/README.md \
           docs/canonical/workflow-ssot.md docs/canonical/feature-catalog.md \
           docs/canonical/pack-catalog.md docs/canonical/config-reference.md; do
  check "3) D-1 정본 존재: $rel" "[ -f \"$REPO/$rel\" ]"
done

# ── 4) 파이프라인 소비 문서(경로-결합, 이동 금지) 실존 ─────────────────────────
#   core/docs/reference/regulation → kcia-check.sh:351 해시 스캔 · design-tokens/canon-blocks → prompts 참조.
check "4) core/docs/reference/regulation/ 존재(kcia-check.sh:351 해시 스캔 결합 — 이동 금지)" \
  "[ -d \"$ROOT/docs/reference/regulation\" ]"
check "4) core/docs/reference/design-tokens.md 존재(prompts/keyvisual.md 참조 결합 — 이동 금지)" \
  "[ -f \"$ROOT/docs/reference/design-tokens.md\" ]"
check "4) core/docs/reference/canon-blocks.md 존재(prompts/storyboard-outline.md 참조 결합 — 이동 금지)" \
  "[ -f \"$ROOT/docs/reference/canon-blocks.md\" ]"

printf '\n[docs-integrity] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
