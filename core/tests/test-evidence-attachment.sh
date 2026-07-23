#!/usr/bin/env bash
# test-evidence-attachment.sh — 근거 문서 첨부 기능(계획 evidence-attachment-plan.md) 회귀 가드.
#   링크 A(입력 채널)·링크 B(ingest 매니페스트)·링크 C(export 반영)의 F1~F7·N1~N12 를 결정적으로 검증한다.
#   최우선 = (a) 근거 없음 strict(F1) 골든 불변 증명. baseline.py 는 extra 파일을 '경고만' 하므로
#   no-evidence 불변은 이 전용 strict 테스트가 본증명이다(계획 1장 제약1).
#
#   ⚠ hermetic·번들 비의존: 이 박스엔 시드 번들(naver_*)이 없다 → 최소 합성 번들/WB/사례를 스스로 만들고
#     HARNESS_OFFLINE=1 + 빈 examples 로 돈다(로컬 inputs/examples 오염 무관). export 는 전 파이프라인 대신
#     최소 04-keyvisual 스캐폴드 + export_package.py 직접 호출로 링크 C 를 격리 검증한다(결정적·빠름).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 근거 문서 첨부 — 링크 A/B/C (F1~F7·N1~N12)"

# ── hermetic 픽스처(최소 합성 번들·WB·근거) ──
SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH" "$ROOT"/runs/ci-ev-* 2>/dev/null || true; }
trap cleanup EXIT

BUNDLE_MIN="$SCRATCH/bundle"
mkdir -p "$BUNDLE_MIN" "$SCRATCH/assets" "$SCRATCH/examples"
cat > "$BUNDLE_MIN/product.json" <<'JSON'
{"name":"테스트 제품","collectedReviewCount":2,"totalReviewCount":2,"rating":4.5,"price":{"current":10000}}
JSON
printf 'content,score,option\n"커버 좋아요",5,"21호"\n"촉촉합니다",4,"21호"\n' > "$BUNDLE_MIN/reviews.csv"
# WB: 근거 절 1개 → claim-basis.evidence_on_file=[ev-01] (case (f) linked_claim_ids 대조용).
cat > "$SCRATCH/wb.md" <<'MD'
# 워킹백워드 — 테스트 픽스처(근거 첨부 회귀)

## 제품 개요
- 제품유형: 색조화장품(쿠션)
- 핵심 사용 가치: 커버력, 촉촉

## 보유 실증 자료
- 인체적용시험 결과 보유(시험성적서 확보).
MD

# 테스트 환경 hermetic 고정(개발/CI 셸의 HARNESS_EVIDENCE_* 오염 차단 + 최소 WB/자산/사례).
unset HARNESS_EVIDENCE_DIR HARNESS_EVIDENCE_MAX_FILE_BYTES HARNESS_EVIDENCE_MAX_TOTAL_BYTES 2>/dev/null || true
export HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm
export HARNESS_WB="$SCRATCH/wb.md" HARNESS_ASSETS_DIR="$SCRATCH/assets" HARNESS_EXAMPLES_DIR="$SCRATCH/examples"

# ── 헬퍼 ──
# reflect:false(첨부-전용) 사이드카 — 반영 강제 게이트를 attach-only 로 통과(첨부-전송 케이스 마이그레이션).
#   반영 기본값이 true(미선언=fail-closed)이므로, '첨부만' 하는 기존 케이스는 각 파일에 reflect:false 를 명시한다.
mk_side_attachonly() {  # <dir> <file...> : <dir>/index.json 에 각 파일을 {"reflect":false} 로 선언
  local d="$1"; shift
  python3 - "$d/index.json" "$@" <<'PY'
import json, sys
out = sys.argv[1]; files = sys.argv[2:]
json.dump({f: {"reflect": False} for f in files}, open(out, "w"), ensure_ascii=False)
PY
}
mk_ev() {  # mk_ev <dir> — 유효 pdf/png 근거 3종 + reflect:false 사이드카(내용 바이트는 임의; ingest 는 미파싱)
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  printf '%%PDF-1.4\nreport-a\n' > "$d/report-a.pdf"
  printf '%%PDF-1.4\nreport-b\n' > "$d/report-b.pdf"
  printf 'PNGCERT-bytes-xyz'    > "$d/cert-c.png"
  mk_side_attachonly "$d" report-a.pdf report-b.pdf cert-c.png
}
ingest_ev()   { ( cd "$ROOT" && HARNESS_EVIDENCE_DIR="$2" bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$1" ) >/dev/null 2>&1; }
ingest_noev() { ( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$1" ) >/dev/null 2>&1; }
scaffold_kv() {  # 최소 04-keyvisual(선택안 A + shots PNG 1장) — export_package 직접 호출용
  local kv="$ROOT/runs/$1/04-keyvisual"; mkdir -p "$kv/options/A/shots"
  printf '{"selected":"A"}' > "$kv/decision.json"; printf 'PNGSHOT-bytes' > "$kv/options/A/shots/01-hero.png"
}
run_export()  { ( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/export_package.py "runs/$1" ) >/dev/null 2>&1; }
evdocs_bad()  {  # evidence-docs 직접 호출(격리된 fail-closed 가드 프로브) — <rid> <bad_src>
  ( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py evidence-docs "$1" --src "$2" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1
}
manifest_valid() {  # 매니페스트를 evidence-documents.schema.json 으로 직접 검증(registry 배선 비의존)
  python3 - "$ROOT" "$1" "$ROOT/harness/evidence-documents.schema.json" <<'PY'
import sys, os
root, data_p, sch_p = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from harness import load_json, Validator
sch = load_json(sch_p); data = load_json(data_p)
v = Validator(sch, sch); v.validate(data, sch)
sys.exit(0 if not v.errors else 1)
PY
}
list_dir() { ls "$1" 2>/dev/null | LC_ALL=C sort | tr '\n' '|'; }
SENTINEL_REL="00-ingest/.ingest-incomplete"

# ─────────────────────────────────────────────────────────────────────────────
# (a) 근거 없음 strict(F1) — 골든 불변 최우선 증명(신규 산출물·필드·복사물·state 항목 전부 부재)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (a) 근거 없음 strict(F1)"
ingest_noev ci-ev-a; scaffold_kv ci-ev-a; run_export ci-ev-a
A="$ROOT/runs/ci-ev-a"
check "(a) inputs/evidence/ 부재" "[ ! -e '$A/inputs/evidence' ]"
check "(a) 00-ingest/evidence-documents.json 부재" "[ ! -e '$A/00-ingest/evidence-documents.json' ]"
check "(a) kcia-package/evidence/ 부재" "[ ! -e '$A/04-keyvisual/export/kcia-package/evidence' ]"
python3 -c "import json;d=json.load(open('$A/04-keyvisual/export/kcia-package/package.json'));import sys;sys.exit(0 if 'evidence_documents' not in d else 1)"; RC=$?
check "(a) package.json 에 evidence_documents 키 부재" "[ $RC -eq 0 ]"
if grep -q '첨부 근거 문서' "$A/04-keyvisual/export/kcia-package/README.md" 2>/dev/null; then RC=1; else RC=0; fi
check "(a) README '첨부 근거 문서' 절 부재" "[ $RC -eq 0 ]"
python3 -c "import json;a=json.load(open('$A/state.json'))['artifacts'];import sys;sys.exit(0 if '00-ingest/evidence-documents.json' not in a else 1)"; RC=$?
check "(a) state.artifacts 에 근거 항목 부재" "[ $RC -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (b) 근거 3건 — 생성·스키마·export 복사+목록+sha256/bytes
# ─────────────────────────────────────────────────────────────────────────────
echo "# (b) 근거 3건"
mk_ev "$SCRATCH/ev3"; ingest_ev ci-ev-b "$SCRATCH/ev3"
B="$ROOT/runs/ci-ev-b"
check "(b) evidence-documents.json 생성" "[ -f '$B/00-ingest/evidence-documents.json' ]"
manifest_valid "$B/00-ingest/evidence-documents.json"; RC=$?
check "(b) 매니페스트 스키마 유효" "[ $RC -eq 0 ]"
python3 -c "import json;d=json.load(open('$B/00-ingest/evidence-documents.json'));import sys;sys.exit(0 if (len(d['documents'])==3 and d['source']['count']==3 and all(len(x['sha256'])==64 and x['bytes']>=1 for x in d['documents'])) else 1)"; RC=$?
check "(b) 문서 3건·source.count=3·sha256(64)/bytes 정합" "[ $RC -eq 0 ]"
scaffold_kv ci-ev-b; run_export ci-ev-b
check "(b) kcia-package/evidence/ 3개 파일 복사" "[ \"\$(list_dir '$B/04-keyvisual/export/kcia-package/evidence')\" = 'cert-c.png|report-a.pdf|report-b.pdf|' ]"
python3 -c "import json;d=json.load(open('$B/04-keyvisual/export/kcia-package/package.json'));import sys;sys.exit(0 if len(d.get('evidence_documents',[]))==3 else 1)"; RC=$?
check "(b) package.json.evidence_documents 3건" "[ $RC -eq 0 ]"
# 복사본 sha256 == 매니페스트 sha256(export 재해시 무결성)
python3 - "$B" <<'PY' && pass "(b) 복사본 sha256 = 매니페스트 sha256" || fail "(b) 복사본 sha 불일치"
import sys, os, json, hashlib
b = sys.argv[1]
man = json.load(open(os.path.join(b, "00-ingest/evidence-documents.json")))
evdir = os.path.join(b, "04-keyvisual/export/kcia-package/evidence")
ok = True
for d in man["documents"]:
    h = hashlib.sha256(open(os.path.join(evdir, d["filename"]), "rb").read()).hexdigest()
    if h != d["sha256"]:
        ok = False
sys.exit(0 if ok else 1)
PY

# ─────────────────────────────────────────────────────────────────────────────
# (c) stale 정리(F2·N1) — 근거 제거 재실행 → 매니페스트·kcia-package/evidence·state 항목 제거
# ─────────────────────────────────────────────────────────────────────────────
echo "# (c) stale 정리(F2·N1)"
mk_ev "$SCRATCH/evc"; ingest_ev ci-ev-c "$SCRATCH/evc"; scaffold_kv ci-ev-c; run_export ci-ev-c
C="$ROOT/runs/ci-ev-c"
check "(c) 사전: 매니페스트·evdir·kcia-ev·state 항목 존재" \
  "[ -f '$C/00-ingest/evidence-documents.json' ] && [ -d '$C/inputs/evidence' ] && [ -d '$C/04-keyvisual/export/kcia-package/evidence' ] && python3 -c \"import json,sys;sys.exit(0 if '00-ingest/evidence-documents.json' in json.load(open('$C/state.json'))['artifacts'] else 1)\""
mkdir -p "$SCRATCH/empty"; ingest_ev ci-ev-c "$SCRATCH/empty"; run_export ci-ev-c
check "(c) 재실행 후: evidence-documents.json 제거" "[ ! -e '$C/00-ingest/evidence-documents.json' ]"
check "(c) 재실행 후: inputs/evidence 제거" "[ ! -e '$C/inputs/evidence' ]"
check "(c) 재실행 후: kcia-package/evidence 제거" "[ ! -e '$C/04-keyvisual/export/kcia-package/evidence' ]"
python3 -c "import json,sys;sys.exit(0 if '00-ingest/evidence-documents.json' not in json.load(open('$C/state.json'))['artifacts'] else 1)"; RC=$?
check "(c) 재실행 후: state.artifacts 항목 prune" "[ $RC -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (d) 무결성 불일치(F3) — ingest 후 스냅샷 원본 변조(동일 크기·다른 내용) → export fail-closed
# ─────────────────────────────────────────────────────────────────────────────
echo "# (d) 무결성 불일치(F3)"
mk_ev "$SCRATCH/evd"; ingest_ev ci-ev-d "$SCRATCH/evd"; scaffold_kv ci-ev-d
D="$ROOT/runs/ci-ev-d"
python3 -c "import os;p='$D/inputs/evidence/report-a.pdf';n=os.path.getsize(p);open(p,'wb').write(b'X'*n)"   # 같은 바이트수, 다른 sha
run_export ci-ev-d; RC=$?
check "(d) 변조된 스냅샷 → export fail-closed" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (e) traversal/심볼릭/디렉터리/확장자밖/초과크기(F4·F6) — 각 fail-closed(격리 프로브)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (e) 안전 스냅샷 가드(F4·F6)"
ingest_noev ci-ev-guard   # 매니페스트 없는 clean 런 — 가드는 rmtree 이전에 걸리므로 런 상태 불변
G="$SCRATCH/g"; rm -rf "$G"
mkdir -p "$G/sym"; printf '%%PDF-1.4x' > "$G/sym/real.pdf"; ln -s real.pdf "$G/sym/link.pdf"
evdocs_bad ci-ev-guard "$G/sym"; RC=$?;  check "(e) 심볼릭 링크 → fail-closed" "[ $RC -ne 0 ]"
mkdir -p "$G/dir/sub"; printf '%%PDF-1.4x' > "$G/dir/a.pdf"
evdocs_bad ci-ev-guard "$G/dir"; RC=$?;  check "(e) 하위 디렉터리 → fail-closed" "[ $RC -ne 0 ]"
mkdir -p "$G/ext"; printf 'x' > "$G/ext/notes.txt"
evdocs_bad ci-ev-guard "$G/ext"; RC=$?;  check "(e) 화이트리스트 밖 확장자(.txt) → fail-closed" "[ $RC -ne 0 ]"
mkdir -p "$G/json"; printf '{}' > "$G/json/data.json"
evdocs_bad ci-ev-guard "$G/json"; RC=$?; check "(e) 예약 아닌 .json → fail-closed" "[ $RC -ne 0 ]"
mkdir -p "$G/big"; printf '%%PDF-1.4-toolong' > "$G/big/b.pdf"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" HARNESS_EVIDENCE_MAX_FILE_BYTES=5 python3 scripts/lib/ingest.py evidence-docs ci-ev-guard --src "$G/big" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1; RC=$?
check "(e) 파일당 상한 초과 → fail-closed" "[ $RC -ne 0 ]"
mkdir -p "$G/tot"; printf 'aaaaaaaaaa' > "$G/tot/a.pdf"; printf 'bbbbbbbbbb' > "$G/tot/b.pdf"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" HARNESS_EVIDENCE_MAX_TOTAL_BYTES=12 python3 scripts/lib/ingest.py evidence-docs ci-ev-guard --src "$G/tot" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1; RC=$?
check "(e) 총량 상한 초과 → fail-closed" "[ $RC -ne 0 ]"
# traversal: 실제 dirent 는 경로구분자를 못 담으므로(심층방어) 안전토큰 함수를 직접 프로브
python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');import ingest;sys.exit(0 if (ingest._evidence_safe_name('../evil') is None and ingest._evidence_safe_name('a/b') is None and ingest._evidence_safe_name('..') is None and ingest._evidence_safe_name('good.pdf')=='good.pdf') else 1)"; RC=$?
check "(e) traversal 안전토큰 가드(_evidence_safe_name 심층방어)" "[ $RC -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (f) 사이드카(F5·N4) — grade/link 반영·미존재 claim id fail·미존재 파일명 키 fail·index.json 제외
# ─────────────────────────────────────────────────────────────────────────────
echo "# (f) 사이드카(F5·N4)"
FS="$SCRATCH/fside"; rm -rf "$FS"; mkdir -p "$FS"
printf '%%PDF-1.4\nrep\n' > "$FS/report.pdf"
printf '{"report.pdf":{"grade":"인체적용시험","linked_claim_ids":["ev-01"],"reflect":false}}' > "$FS/index.json"
ingest_ev ci-ev-f "$FS"; F="$ROOT/runs/ci-ev-f"
check "(f) ingest 완료(정상 반영)" "[ -f '$F/00-ingest/evidence-documents.json' ]"
python3 -c "import json,sys;d=json.load(open('$F/00-ingest/evidence-documents.json'))['documents'];sys.exit(0 if (len(d)==1 and d[0]['grade']=='인체적용시험' and d[0]['linked_claim_ids']==['ev-01'] and all(x['filename']!='index.json' for x in d)) else 1)"; RC=$?
check "(f) grade/link 반영 + index.json 문서제외" "[ $RC -eq 0 ]"
printf '{"report.pdf":{"grade":null,"linked_claim_ids":["ev-99"],"reflect":false}}' > "$FS/index.json"
evdocs_bad ci-ev-f "$FS"; RC=$?; check "(f) 미존재 claim id(ev-99) → fail-closed(F5)" "[ $RC -ne 0 ]"
printf '{"nonexistent.pdf":{"grade":null,"linked_claim_ids":[]}}' > "$FS/index.json"
evdocs_bad ci-ev-f "$FS"; RC=$?; check "(f) 미존재 파일명 키 → fail-closed(N4)" "[ $RC -ne 0 ]"
printf '{"report.pdf":{"linked_claim_id":["ev-01"]}}' > "$FS/index.json"   # 오타 키(additionalProperties:false)
evdocs_bad ci-ev-f "$FS"; RC=$?; check "(f) 오타 서브필드 → 스키마 fail-closed" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (g) 0바이트(N3)·NFC 충돌(N2)·중복 id/filename(N5) — 각 fail-closed
# ─────────────────────────────────────────────────────────────────────────────
echo "# (g) 0바이트·NFC 충돌·중복(N3·N2·N5)"
mkdir -p "$G/zero"; : > "$G/zero/empty.pdf"
evdocs_bad ci-ev-guard "$G/zero"; RC=$?; check "(g) 0바이트 근거 → fail-closed(N3)" "[ $RC -ne 0 ]"
# N2 NFC 충돌: macOS APFS 는 파일명을 정규화-병합해 두 충돌 파일이 물리적으로 공존 불가 → Linux 로 게이트.
case "$(uname)" in
  Linux)
    NFCDIR="$G/nfc"; mkdir -p "$NFCDIR"
    NFCDIR="$NFCDIR" python3 -c "import unicodedata,os;d=os.environ['NFCDIR'];open(os.path.join(d,unicodedata.normalize('NFC','café')+'.pdf'),'wb').write(b'%PDF-1');open(os.path.join(d,unicodedata.normalize('NFD','café')+'.pdf'),'wb').write(b'%PDF-2')"
    evdocs_bad ci-ev-guard "$NFCDIR"; RC=$?; check "(g) NFC 정규화 충돌 → fail-closed(N2)" "[ $RC -ne 0 ]"
    ;;
  *)
    pass "(g) NFC 충돌(N2): $(uname) APFS 는 파일명 정규화-병합 → 물리적 충돌 생성 불가 → note-skip(CI Linux 에서 실행됨)"
    ;;
esac
# N5 중복 id/filename: id 는 순차 부여·filename 은 dirent(고유) → 복사경로에서 자연발생 불가(심층방어).
#   현실적 dup-filename 경로(NFC 충돌)는 위 N2 가 커버. 가드 존재를 소스 프로브로 확인.
grep -q '유일성 위반(N5)' "$ROOT/scripts/lib/ingest.py"; RC=$?
check "(g) 중복 id/filename 가드(N5) 존재(심층방어; 실경로는 N2 가 커버)" "[ $RC -eq 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (h) 부분 축소 정확복제(N6) — 3건 → 1건 삭제·1건 개명 후 재실행 → 정확히 현재 유효분만
# ─────────────────────────────────────────────────────────────────────────────
echo "# (h) 부분 축소 정확복제(N6)"
HS="$SCRATCH/evh"; rm -rf "$HS"; mkdir -p "$HS"
printf '%%PDF-1\n' > "$HS/a.pdf"; printf '%%PDF-2\n' > "$HS/b.pdf"; printf '%%PDF-3\n' > "$HS/c.pdf"
mk_side_attachonly "$HS" a.pdf b.pdf c.pdf
ingest_ev ci-ev-h "$HS"; scaffold_kv ci-ev-h; run_export ci-ev-h
H="$ROOT/runs/ci-ev-h"
check "(h) 사전: inputs/evidence 3건" "[ \"\$(list_dir '$H/inputs/evidence')\" = 'a.pdf|b.pdf|c.pdf|' ]"
rm "$HS/c.pdf"; mv "$HS/b.pdf" "$HS/b2.pdf"   # 1건 삭제 + 1건 개명 → 유효분 = a.pdf, b2.pdf
mk_side_attachonly "$HS" a.pdf b2.pdf         # 사이드카도 현재 유효분에 맞춘다(N4 1:1)
ingest_ev ci-ev-h "$HS"; run_export ci-ev-h
check "(h) 재실행 후 inputs/evidence = {a.pdf,b2.pdf} (삭제·구명 stale 부재)" "[ \"\$(list_dir '$H/inputs/evidence')\" = 'a.pdf|b2.pdf|' ]"
python3 -c "import json,sys;fns=sorted(x['filename'] for x in json.load(open('$H/00-ingest/evidence-documents.json'))['documents']);sys.exit(0 if fns==['a.pdf','b2.pdf'] else 1)"; RC=$?
check "(h) 매니페스트 filename = {a.pdf,b2.pdf}" "[ $RC -eq 0 ]"
check "(h) kcia-package/evidence = {a.pdf,b2.pdf} (stale 사본 부재)" "[ \"\$(list_dir '$H/04-keyvisual/export/kcia-package/evidence')\" = 'a.pdf|b2.pdf|' ]"

# ─────────────────────────────────────────────────────────────────────────────
# (i) export 안전순서(F3) — 스냅샷 파일을 심볼릭/run-밖 링크로 치환 → 바이트 읽기 전 거부
# ─────────────────────────────────────────────────────────────────────────────
echo "# (i) export 안전순서(F3)"
mk_ev "$SCRATCH/evi"; ingest_ev ci-ev-i "$SCRATCH/evi"; scaffold_kv ci-ev-i
I="$ROOT/runs/ci-ev-i"
rm "$I/inputs/evidence/report-a.pdf"; ln -s /etc/hosts "$I/inputs/evidence/report-a.pdf"   # run-밖 심볼릭
run_export ci-ev-i; RC=$?; check "(i) run-밖 심볼릭 치환 → export fail-closed(바이트 읽기 전)" "[ $RC -ne 0 ]"
mk_ev "$SCRATCH/evi2"; ingest_ev ci-ev-i "$SCRATCH/evi2"; scaffold_kv ci-ev-i
rm "$I/inputs/evidence/report-a.pdf"; mkdir -p "$I/inputs/evidence/nested"
printf '%%PDF-1.4\nreport-a\n' > "$I/inputs/evidence/nested/report-a.pdf"; ln -s nested/report-a.pdf "$I/inputs/evidence/report-a.pdf"
run_export ci-ev-i; RC=$?; check "(i) inputs/evidence 밖(nested) 심볼릭 → export fail-closed(realpath 경계)" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (j) 정합성 창(N7) — 디스크 extra / 매니페스트-only / sha 불일치 → export 정확집합 대조 fail-closed
# ─────────────────────────────────────────────────────────────────────────────
echo "# (j) 정합성 창(N7)"
mk_ev "$SCRATCH/evj"; ingest_ev ci-ev-j1 "$SCRATCH/evj"; scaffold_kv ci-ev-j1
printf 'extra-not-in-manifest' > "$ROOT/runs/ci-ev-j1/inputs/evidence/extra.pdf"
run_export ci-ev-j1; RC=$?; check "(j1) 디스크 extra 파일 → export fail-closed" "[ $RC -ne 0 ]"
mk_ev "$SCRATCH/evj2"; ingest_ev ci-ev-j2 "$SCRATCH/evj2"; scaffold_kv ci-ev-j2
rm "$ROOT/runs/ci-ev-j2/inputs/evidence/report-a.pdf"
run_export ci-ev-j2; RC=$?; check "(j2) 매니페스트-only(디스크 누락) → export fail-closed" "[ $RC -ne 0 ]"
mk_ev "$SCRATCH/evj3"; ingest_ev ci-ev-j3 "$SCRATCH/evj3"; scaffold_kv ci-ev-j3
python3 -c "import os;p='$ROOT/runs/ci-ev-j3/inputs/evidence/cert-c.png';n=os.path.getsize(p);open(p,'wb').write(b'Z'*n)"
run_export ci-ev-j3; RC=$?; check "(j3) sha 불일치(동일 크기 변조) → export fail-closed" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (k) orphan(N8) — inputs/evidence 실파일 있으나 매니페스트 부재 → export fail-closed(조용한 '근거 없음' 금지)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (k) orphan(N8)"
ingest_noev ci-ev-k; scaffold_kv ci-ev-k
mkdir -p "$ROOT/runs/ci-ev-k/inputs/evidence"; printf 'orphan-file' > "$ROOT/runs/ci-ev-k/inputs/evidence/loose.pdf"
check "(k) 사전: 매니페스트 부재 + inputs/evidence 실파일 존재" \
  "[ ! -e '$ROOT/runs/ci-ev-k/00-ingest/evidence-documents.json' ] && [ -f '$ROOT/runs/ci-ev-k/inputs/evidence/loose.pdf' ]"
run_export ci-ev-k; RC=$?; check "(k) orphan → export fail-closed" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# (l) 빈-창 중단(N9) — 스냅샷 중도 중단(sentinel + 빈 inputs/evidence) 모사 → 00-ingest 미완·재-ingest 치유
#   ⚠ 방법: ingest-bundle 을 결정적으로 중도 kill 할 수 없어, write-ahead sentinel + 빈 evidence 창을 직접 심는다.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (l) 빈-창 중단(N9)"
ingest_noev ci-ev-l   # 완료 런(01-brief) → 그 위에 '중단된 빈-창' 모사
L="$ROOT/runs/ci-ev-l"
: > "$L/$SENTINEL_REL"; mkdir -p "$L/inputs/evidence"   # rmtree 직후·첫 복사 전(빈 창) + write-ahead sentinel
( cd "$ROOT" && bash scripts/run-stage.sh brief ci-ev-l ) >/dev/null 2>&1; RC=$?; check "(l) 부분-커밋 중 run-stage → fail-closed" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/validate-stage.sh ci-ev-l ) >/dev/null 2>&1; RC=$?; check "(l) 부분-커밋 중 validate(run 모드) → fail-closed" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-l --render-only ) >/dev/null 2>&1; RC=$?; check "(l) 부분-커밋 중 advance → fail-closed(04/export 도달 불가)" "[ $RC -ne 0 ]"
ingest_noev ci-ev-l; RC=$?   # 재-ingest(멱등 exact-replacement 가 치유)
check "(l) 재-ingest 정상 완주 → sentinel 해소·phase=01-brief" \
  "[ $RC -eq 0 ] && [ ! -e '$L/$SENTINEL_REL' ] && [ \"\$(jq_phase ci-ev-l phase)\" = '01-brief' ]"

# ─────────────────────────────────────────────────────────────────────────────
# (m) sentinel 근본 종결(N10) — 9 진입점 fail-closed + validate --file 우회 + 완료 런 부재 + --to 거부
# ─────────────────────────────────────────────────────────────────────────────
echo "# (m) sentinel 근본 종결(N10)"
ingest_noev ci-ev-m; M="$ROOT/runs/ci-ev-m"
check "(m·ii) 완료 런엔 sentinel 부재(골든/baseline 불변)" "[ ! -e '$M/$SENTINEL_REL' ]"
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-m --render-only ) >/dev/null 2>&1; RC=$?
check "(m·ii) sentinel 부재 시 가드 no-op(advance --render-only 통과)" "[ $RC -eq 0 ]"
# 이미 01-brief 로 진행된 런에 sentinel 잔존(중단된 재-ingest 모사)
: > "$M/$SENTINEL_REL"
( cd "$ROOT" && bash scripts/run-stage.sh brief ci-ev-m ) >/dev/null 2>&1; RC=$?; check "(m·i) run-stage → fail-closed" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/validate-stage.sh ci-ev-m ) >/dev/null 2>&1; RC=$?; check "(m·i) validate-stage(run 모드) → fail-closed" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-m --render-only ) >/dev/null 2>&1; RC=$?; check "(m·i) advance-phase → fail-closed" "[ $RC -ne 0 ]"
# 확장 소비자 ≥2 도 fail-closed(9 진입점 스코프 확장 고정) — approve.sh + kcia-check.sh
( cd "$ROOT" && bash scripts/approve.sh ci-ev-m --ra-ok ) >/dev/null 2>&1; RC=$?; check "(m·i) approve.sh → fail-closed(확장 소비자)" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-ev-m ) >/dev/null 2>&1; RC=$?; check "(m·i) kcia-check.sh → fail-closed(확장 소비자)" "[ $RC -ne 0 ]"
# validate-stage --file 은 가드 우회(위에서 이미 반환)
( cd "$ROOT" && bash scripts/validate-stage.sh --file "$M/00-ingest/voc.json" ) >/dev/null 2>&1; RC=$?; check "(m) validate-stage --file 은 sentinel 우회(통과)" "[ $RC -eq 0 ]"
# --to 도 sentinel 있으면 거부
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-m --to 01-brief ) >/dev/null 2>&1; RC=$?; check "(m·iii) advance-phase --to + sentinel → 거부" "[ $RC -ne 0 ]"
# 재-ingest 로만 해소
ingest_noev ci-ev-m; check "(m) 재-ingest 로 sentinel 해소" "[ ! -e '$M/$SENTINEL_REL' ]"

# ─────────────────────────────────────────────────────────────────────────────
# (n) advance-gate positive completion(N11·N12) — fresh 런에서 양쪽 후속 --to 거부, ingest 후 통과
# ─────────────────────────────────────────────────────────────────────────────
echo "# (n) advance-gate positive completion(N11·N12)"
rm -rf "$ROOT/runs/ci-ev-n"
( cd "$ROOT" && bash scripts/new-run.sh ci-ev-n --domain 화장품 --format 여러장 ) >/dev/null 2>&1
N="$ROOT/runs/ci-ev-n"
check "(n) 사전: fresh 런 phase=00-ingest·status≠passed·sentinel 부재" \
  "[ \"\$(jq_phase ci-ev-n phase)\" = '00-ingest' ] && [ \"\$(jq_phase ci-ev-n status)\" != 'passed' ] && [ ! -e '$N/$SENTINEL_REL' ]"
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-n --to 01-brief ) >/dev/null 2>&1; RC=$?; check "(n) fresh + --to 01-brief → 거부(status≠passed)" "[ $RC -ne 0 ]"
( cd "$ROOT" && bash scripts/advance-phase.sh ci-ev-n --to 00g-guideline ) >/dev/null 2>&1; RC=$?; check "(n) fresh + --to 00g-guideline → 거부(우회 차단)" "[ $RC -ne 0 ]"
check "(n·noop) 거부 후 phase 유지(00-ingest)" "[ \"\$(jq_phase ci-ev-n phase)\" = '00-ingest' ]"
ingest_noev ci-ev-n; RC=$?   # 진짜 ingest → 필수4종 검증(status=passed) 뒤 정당 후속(01-brief) 전이
check "(n) 진짜 ingest 완주 후에만 통과(phase=01-brief)" "[ $RC -eq 0 ] && [ \"\$(jq_phase ci-ev-n phase)\" = '01-brief' ]"

# ═════════════════════════════════════════════════════════════════════════════
# 반영 강제(첨부=반영, evidence-content-integration 커밋 b) — (o)~(u)
#   reflect 기본 true(미선언=fail-closed)·완전성 게이트·doc-NN 승격·바이트 불변.
# ═════════════════════════════════════════════════════════════════════════════
cb_sha() { python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }

# (o) 사이드카 없는 첨부(reflect 미선언=기본 true, kind 추론=general) → G5: fail-closed 아닌 pending(문서만 주면 자동 제안 대상)
echo "# (o) 사이드카 없는 첨부 → pending(문서만 첨부=일반 kind, 반영점 미정)"
rm -rf "$ROOT/runs/ci-ev-o"
OO="$SCRATCH/evo"; rm -rf "$OO"; mkdir -p "$OO"; printf '%%PDF-1.4\nrep\n' > "$OO/report.pdf"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py evidence-docs ci-ev-o --src "$OO" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1; RC=$?
check "(o) 사이드카 없는 첨부 → 인입 성공(pending; fail-closed 아님)" "[ $RC -eq 0 ]"
python3 - "$ROOT/runs/ci-ev-o" <<'PY' && pass "(o) bare 첨부 → spec_status=pending·kind=general·claim 없음" || fail "(o) pending 미기록"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if d.get("reflect") is True and d.get("kind") == "general" and d.get("spec_status") == "pending" and "claim" not in d else 1)
PY

# (p) reflect:true + claim 만(kind 추론 general, 반영점 미정) → G5: fail-closed 아닌 pending
echo "# (p) reflect:true + claim만(일반) → pending"
rm -rf "$ROOT/runs/ci-ev-p"
PP="$SCRATCH/evp"; rm -rf "$PP"; mkdir -p "$PP"; printf '%%PDF-1.4\nrep\n' > "$PP/report.pdf"
printf '{"report.pdf":{"reflect":true,"claim":"여드름 피부 사용 적합"}}' > "$PP/index.json"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py evidence-docs ci-ev-p --src "$PP" --channel HARNESS_EVIDENCE_DIR ) >/dev/null 2>&1; RC=$?
check "(p) reflect:true+claim만(일반) → 인입 성공(pending)" "[ $RC -eq 0 ]"
python3 - "$ROOT/runs/ci-ev-p" <<'PY' && pass "(p) claim만 일반 → spec_status=pending·claim 보존" || fail "(p) pending 미기록"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if d.get("reflect") is True and d.get("kind") == "general" and d.get("spec_status") == "pending" and d.get("claim") == "여드름 피부 사용 적합" else 1)
PY
# (p2) test_report 는 pending 경로 없음 — 결손이면 hard-fail 유지(효능 실증 재료 지어내기 금지). 공백-only 도 strip 후 결손(Codex P2).
printf '{"report.pdf":{"reflect":true,"grade":"인체적용시험","claim":"  ","verdict_text":"적합","test_report":{"institution":" ","sample_size":10,"duration":"1주"}}}' > "$PP/index.json"
evdocs_bad ci-ev-p "$PP"; RC=$?; check "(p2) 공백-only claim/institution(kind=test_report) → fail-closed(pending 아님·strip 후 결손)" "[ $RC -ne 0 ]"

# (u) linked_claim_ids 가 승격 네임스페이스(doc-*) 지시 → fail-closed
echo "# (u) linked_claim_ids=doc-* → fail-closed"
UU="$SCRATCH/evu"; rm -rf "$UU"; mkdir -p "$UU"; printf '%%PDF-1.4\nrep\n' > "$UU/report.pdf"
printf '{"report.pdf":{"reflect":false,"linked_claim_ids":["doc-01"]}}' > "$UU/index.json"
evdocs_bad ci-ev-u "$UU"; RC=$?; check "(u) linked_claim_ids=doc-01 → fail-closed" "[ $RC -ne 0 ]"

# (q) 첨부-전용(reflect:false) → claim-basis 승격 없음·바이트 불변
echo "# (q) 첨부-전용(reflect:false) → 승격 없음(claim-basis 바이트 불변)"
mk_ev "$SCRATCH/evq"; ingest_ev ci-ev-q "$SCRATCH/evq"; Q="$ROOT/runs/ci-ev-q"
python3 -c "import json,sys;cb=json.load(open('$Q/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if not any(i.startswith('doc-') for i in ids) else 1)"; RC=$?
check "(q) reflect:false → claim-basis 에 doc-* 미편입" "[ $RC -eq 0 ]"
ingest_noev ci-ev-q0   # 동일 WB no-evidence 런과 claim-basis 바이트 동일
check "(q) claim-basis 바이트 = no-evidence 런과 동일(reflect:false 무영향)" \
  "[ \"\$(cb_sha '$Q/00-ingest/claim-basis.json')\" = \"\$(cb_sha '$ROOT/runs/ci-ev-q0/00-ingest/claim-basis.json')\" ]"

# (r) 완전 선언(정성) → claim-basis doc-01 승격(ev-* 뒤) + 매니페스트 반영 필드
echo "# (r) 완전 선언(정성) → doc-01 승격 + 매니페스트 반영 필드"
RR="$SCRATCH/evr"; rm -rf "$RR"; mkdir -p "$RR"; printf '%%PDF-1.4\nrep\n' > "$RR/suit.pdf"
cat > "$RR/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"여드름 피부 사용 적합","verdict_text":"여드름 피부 사용에 적합함","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"1주","method":"첩포시험","measured_values":null}}}
JSON
ingest_ev ci-ev-r "$RR"; R="$ROOT/runs/ci-ev-r"
python3 - "$R" <<'PY' && pass "(r) claim-basis doc-01 승격(ev-* 뒤·kind/summary/기관·n·기간)" || fail "(r) 승격 불충분"
import sys, json, os
cb = json.load(open(os.path.join(sys.argv[1], "00-ingest/claim-basis.json")))
ev = cb["evidence_on_file"]; ids = [e["id"] for e in ev]
docpos = [i for i, x in enumerate(ids) if x.startswith("doc-")]
evpos  = [i for i, x in enumerate(ids) if x.startswith("ev-")]
ok = "doc-01" in ids and docpos and (not evpos or min(docpos) > max(evpos))
d = next(e for e in ev if e["id"] == "doc-01")
ok = ok and d["kind"] == "clinical_trial" and d.get("summary") == "여드름 피부 사용 적합" \
     and d["grade"] == "인체적용시험" and d.get("institution") == "P&K피부임상연구센타" \
     and d.get("sample_size") == 22 and d.get("duration") == "1주" and d["source"].endswith("suit.pdf")
sys.exit(0 if ok else 1)
PY
manifest_valid "$R/00-ingest/evidence-documents.json"; RC=$?
check "(r) 매니페스트 스키마 유효(반영 필드 포함)" "[ $RC -eq 0 ]"
python3 - "$R" <<'PY' && pass "(r) 매니페스트 doc[0] reflect:true+claim+verdict_text+test_report" || fail "(r) 매니페스트 반영 필드 누락"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
tr = d.get("test_report") or {}
ok = d.get("reflect") is True and d.get("claim") == "여드름 피부 사용 적합" \
     and d.get("verdict_text") == "여드름 피부 사용에 적합함" \
     and tr.get("institution") == "P&K피부임상연구센타" and tr.get("sample_size") == 22
sys.exit(0 if ok else 1)
PY

# (v) 판정문 원문 결박(validate_storyboard) — doc-NN 인용 카피는 verdict_text 부분문자열이어야
echo "# (v) 판정문 원문 결박(validate_storyboard)"
val_sb() { ( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/validate_storyboard.py "runs/$1" ) >/dev/null 2>&1; }
mkdir -p "$R/03-storyboard/plan"
printf '{"order":1,"type":"hero","claims":[]}' > "$R/03-storyboard/plan/01-hero.json"
# verdict_text 원문 = "여드름 피부 사용에 적합함"; target_text = 그 부분문자열 → 통과
printf '{"order":2,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"여드름 피부 사용에 적합","evidence_ref":"doc-01"}]}' > "$R/03-storyboard/plan/02-clin.json"
val_sb ci-ev-r; RC=$?; check "(v) target_text ⊆ verdict_text 원문 → validate 통과" "[ $RC -eq 0 ]"
# 문서 밖 단정어(무자극) → 부분문자열 아님 → fail-closed
printf '{"order":2,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"무자극","evidence_ref":"doc-01"}]}' > "$R/03-storyboard/plan/02-clin.json"
val_sb ci-ev-r; RC=$?; check "(v) 문서 밖 단정어(무자극) 확장 → validate fail-closed(원문 결박)" "[ $RC -ne 0 ]"
# 알 수 없는 doc-id 인용 → fail-closed
printf '{"order":2,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"여드름 피부 사용에 적합","evidence_ref":"doc-09"}]}' > "$R/03-storyboard/plan/02-clin.json"
val_sb ci-ev-r; RC=$?; check "(v) 미존재 doc-id(doc-09) 인용 → fail-closed" "[ $RC -ne 0 ]"
# (v2) reflect:true 문서를 plan 이 전혀 인용 안 함 → validate 03 반영 강제 실패(correctable 지점)
printf '{"order":1,"type":"hero","claims":[]}' > "$R/03-storyboard/plan/01-hero.json"
rm -f "$R/03-storyboard/plan/02-clin.json"
val_sb ci-ev-r; RC=$?; check "(v2) reflect:true 미반영 plan → validate 실패(03 반영 강제)" "[ $RC -ne 0 ]"
rm -rf "$R/03-storyboard"   # (s) 재-인입 전 정리(evidence-docs 는 03-storyboard 미접촉이나 깔끔히)

# (s) 재-인입(근거 제거) → claim-basis 에서 doc-* 벗김(승격 잔재 정리) + 매니페스트 제거
echo "# (s) 근거 제거 재-인입 → doc-* 정리"
mkdir -p "$SCRATCH/empty_s"; ingest_ev ci-ev-r "$SCRATCH/empty_s"
python3 -c "import json,sys;cb=json.load(open('$R/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if not any(i.startswith('doc-') for i in ids) else 1)"; RC=$?
check "(s) 근거 제거 재-인입 후 claim-basis 에 doc-* 부재" "[ $RC -eq 0 ]"
check "(s) 매니페스트도 제거" "[ ! -e '$R/00-ingest/evidence-documents.json' ]"

# (t) no-evidence 런 claim-basis 바이트 불변(2회 인입 동일) — DoD ①
echo "# (t) no-evidence 바이트 불변(strict)"
ingest_noev ci-ev-t; T1="$(cb_sha "$ROOT/runs/ci-ev-t/00-ingest/claim-basis.json")"
ingest_noev ci-ev-t; T2="$(cb_sha "$ROOT/runs/ci-ev-t/00-ingest/claim-basis.json")"
check "(t) 2회 no-evidence 인입 claim-basis sha256 동일" "[ -n \"$T1\" ] && [ \"$T1\" = \"$T2\" ]"

# ═════════════════════════════════════════════════════════════════════════════
# 반영 강제 done 게이트 + export reflected_in (커밋 c+d) — (w)(x)
# ═════════════════════════════════════════════════════════════════════════════
chk_refl() { ( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/check_evidence_reflection.py "runs/$1" ) >/dev/null 2>&1; }
mk_reflect_run() {  # <rid> <srcdir> — 완전 정성 선언 근거 1건(reflect:true) ingest
  local rid="$1" d="$2"; rm -rf "$d"; mkdir -p "$d"; printf '%%PDF-1.4\nrep\n' > "$d/suit.pdf"
  cat > "$d/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"여드름 피부 사용 적합","verdict_text":"여드름 피부 사용에 적합함","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"1주","measured_values":null}}}
JSON
  ingest_ev "$rid" "$d"
}
mk_plan_cite() {  # <rid> — doc-01 을 인용(claims.evidence_ref + 각주)하는 최소 plan
  local pd="$ROOT/runs/$1/03-storyboard/plan"; mkdir -p "$pd"
  printf '{"order":1,"type":"hero","claims":[]}' > "$pd/01-hero.json"
  printf '{"order":9,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"여드름 피부 사용에 적합","evidence_ref":"doc-01"}],"footnotes":[{"id":"f1","text":"doc-01 인용"}]}' > "$pd/09-clin.json"
}

# (w) 반영 강제 done 게이트
echo "# (w) 반영 강제 done 게이트(check_evidence_reflection)"
mk_reflect_run ci-ev-w "$SCRATCH/evw"
chk_refl ci-ev-w; RC=$?; check "(w) reflect:true 인데 반영 블록 0 → 게이트 차단(exit 1)" "[ $RC -ne 0 ]"
mk_plan_cite ci-ev-w
chk_refl ci-ev-w; RC=$?; check "(w) doc-01 인용 반영 블록 추가 → 게이트 통과(exit 0)" "[ $RC -eq 0 ]"
# (w2) 빈 target_text claim(각주 없음) = 실질 반영 아님 → 차단(Codex P2)
WP="$ROOT/runs/ci-ev-w/03-storyboard/plan"; rm -f "$WP"/*.json
printf '{"order":9,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"","evidence_ref":"doc-01"}]}' > "$WP/09-clin.json"
chk_refl ci-ev-w; RC=$?; check "(w2) 빈 target_text claim(각주 없음) → 반영 불인정(차단)" "[ $RC -ne 0 ]"
# (w3) 부분문자열 오탐 방지: 각주 'doc-010' 은 doc-01 을 만족시키지 않음(Codex P3)
printf '{"order":9,"type":"clinicalEvidence","claims":[],"footnotes":[{"id":"f1","text":"doc-010 인용"}]}' > "$WP/09-clin.json"
chk_refl ci-ev-w; RC=$?; check "(w3) 각주 doc-010 은 doc-01 반영 아님(정확 토큰 매칭)" "[ $RC -ne 0 ]"
# (w4) 각주 정확 인용(doc-01)은 반영 인정
printf '{"order":9,"type":"clinicalEvidence","claims":[],"footnotes":[{"id":"f1","text":"근거 doc-01 인용"}]}' > "$WP/09-clin.json"
chk_refl ci-ev-w; RC=$?; check "(w4) 각주 doc-01 정확 인용 → 반영 인정(통과)" "[ $RC -eq 0 ]"
chk_refl ci-ev-q; RC=$?; check "(w) 첨부-전용(reflect:false) 런 → 게이트 통과" "[ $RC -eq 0 ]"
chk_refl ci-ev-t; RC=$?; check "(w) no-evidence 런 → 게이트 통과(no-op)" "[ $RC -eq 0 ]"
# (w5) 선택 스토리라인 밖(스테일/미선택) plan 블록의 인용은 반영 아님(Codex P2 — 선택 산출물만)
mk_reflect_run ci-ev-w5 "$SCRATCH/evw5"
W5="$ROOT/runs/ci-ev-w5"; mkdir -p "$W5/03-storyboard/outline/options/A" "$W5/03-storyboard/plan"
printf '{"selected":"A"}' > "$W5/03-storyboard/outline/decision.json"
printf '{"blocks":[{"order":1,"type":"hero"},{"order":9,"type":"clinicalEvidence"}]}' > "$W5/03-storyboard/outline/options/A/storyline.json"
printf '{"order":1,"type":"hero","claims":[]}' > "$W5/03-storyboard/plan/01-hero.json"
printf '{"order":5,"type":"problem","claims":[{"claim_strength":"none","target_text":"여드름 피부 사용에 적합","evidence_ref":"doc-01"}]}' > "$W5/03-storyboard/plan/05-problem.json"
chk_refl ci-ev-w5; RC=$?; check "(w5) 선택 스토리라인 밖 스테일 블록 인용 → 반영 불인정(차단)" "[ $RC -ne 0 ]"
printf '{"order":9,"type":"clinicalEvidence","claims":[{"claim_strength":"none","target_text":"여드름 피부 사용에 적합","evidence_ref":"doc-01"}]}' > "$W5/03-storyboard/plan/09-clin.json"
chk_refl ci-ev-w5; RC=$?; check "(w5) 선택 스토리라인 블록(order=9) 인용 → 반영 인정(통과)" "[ $RC -eq 0 ]"
# (w6) plan 에 반영 블록이 있어도 선택 키비주얼 HTML 에서 누락되면 반영 아님(Codex P1 — 최종 산출물 확인)
mk_reflect_run ci-ev-w6 "$SCRATCH/evw6"; mk_plan_cite ci-ev-w6   # plan: 09-clinicalEvidence 가 doc-01 인용
W6="$ROOT/runs/ci-ev-w6"; mkdir -p "$W6/04-keyvisual/options/A"
printf '{"selected":"A"}' > "$W6/04-keyvisual/decision.json"
printf '<section data-block="hero">x</section>' > "$W6/04-keyvisual/options/A/index.html"
chk_refl ci-ev-w6; RC=$?; check "(w6) 반영 블록이 선택 HTML 에서 누락(hero 만) → 반영 불인정(차단)" "[ $RC -ne 0 ]"
printf '<section data-block="clinicalEvidence">여드름 피부 사용에 적합 <span class="footnote">doc-01</span></section>' > "$W6/04-keyvisual/options/A/index.html"
chk_refl ci-ev-w6; RC=$?; check "(w6) 선택 HTML 섹션에 doc-01 인용 + 판정 카피 존재 → 반영 인정(통과)" "[ $RC -eq 0 ]"
printf '<section data-block="clinicalEvidence">여드름 피부 사용에 적합 doc-010</section>' > "$W6/04-keyvisual/options/A/index.html"
chk_refl ci-ev-w6; RC=$?; check "(w6b) 섹션이 doc-010(다른 토큰) 인용(내용 있음) → doc-01 반영 아님(정확 토큰)" "[ $RC -ne 0 ]"
# (w7) 판정 카피가 반영 블록 밖(hero)에 있고 반영 블록(clinicalEvidence)은 빈 섹션 → 반영 아님(Codex P1 섹션 결박)
printf '<section data-block="hero">여드름 피부 사용에 적합</section><section data-block="clinicalEvidence"></section>' > "$W6/04-keyvisual/options/A/index.html"
chk_refl ci-ev-w6; RC=$?; check "(w7) 판정 카피가 반영 블록 밖·반영 블록 빈 섹션 → 반영 불인정(차단)" "[ $RC -ne 0 ]"

# (x) export reflected_in 기록 + README 반영 표기(P2-2 모순 해소)
echo "# (x) export reflected_in + README 반영 표기"
mk_reflect_run ci-ev-x "$SCRATCH/evx"; mk_plan_cite ci-ev-x; scaffold_kv ci-ev-x; run_export ci-ev-x
X="$ROOT/runs/ci-ev-x"
python3 - "$X" <<'PY' && pass "(x) package.json evidence_documents[0] reflect:true + reflected_in 비어있지 않음" || fail "(x) reflected_in 누락"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "04-keyvisual/export/kcia-package/package.json")))["evidence_documents"][0]
sys.exit(0 if d.get("reflect") is True and d.get("reflected_in") else 1)
PY
grep -q '반영 블록' "$X/04-keyvisual/export/kcia-package/README.md"; RC=$?
check "(x) README 에 '반영 블록' 열 존재" "[ $RC -eq 0 ]"
# 반영 문서는 실증 근거 목록(evidence_list)에도 doc-01 로 편입(P2-2: 모순 없는 패키지)
python3 -c "import json,sys;d=json.load(open('$X/04-keyvisual/export/kcia-package/package.json'));ids=[e['id'] for e in d.get('evidence_list',[])];sys.exit(0 if 'doc-01' in ids else 1)"; RC=$?
check "(x) 반영 문서(doc-01)가 실증 근거 목록에도 편입(첨부=실증 일관)" "[ $RC -eq 0 ]"

# ═════════════════════════════════════════════════════════════════════════════
# 범용 참조 문서 일반화(G2) — (y)(z)(aa): kind 분기·일반 문서 각주 채널·승격 test_report 한정
# ═════════════════════════════════════════════════════════════════════════════
# (y) 일반 참조 문서(kind=brand_story) 선언 → 인입 OK, claim-basis 미승격(안전 불변식), 매니페스트 일반 필드
echo "# (y) 일반 참조 문서(kind=general) — 선언 OK·claim-basis 미승격"
YY="$SCRATCH/evy"; rm -rf "$YY"; mkdir -p "$YY"; printf 'brand story bytes' > "$YY/brand.png"
cat > "$YY/index.json" <<'JSON'
{"brand.png":{"reflect":true,"kind":"brand_story","claim":"브랜드 개발 스토리","reflection_points":["피부과학 연구 15년","자체 연구소 개발"]}}
JSON
ingest_ev ci-ev-y "$YY"; Y="$ROOT/runs/ci-ev-y"
check "(y) 일반 문서 인입 완료" "[ -f '$Y/00-ingest/evidence-documents.json' ]"
python3 -c "import json,sys;cb=json.load(open('$Y/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if not any(i.startswith('doc-') for i in ids) else 1)"; RC=$?
check "(y) 일반 문서 claim-basis 미승격(doc-* 부재 — 안전 불변식)" "[ $RC -eq 0 ]"
python3 - "$Y" <<'PY' && pass "(y) 매니페스트 kind=brand_story + reflection_points 기록·verdict_text 없음" || fail "(y) 매니페스트 일반 필드 누락"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if d.get("reflect") is True and d.get("kind") == "brand_story" and d.get("claim") == "브랜드 개발 스토리"
        and len(d.get("reflection_points") or []) == 2 and "verdict_text" not in d else 1)
PY

# (z) 일반 문서 reflect:true 인데 반영점 미정(문서만 첨부) → G5: fail-closed 아닌 pending → 00e 라우팅·미승격·done 백스톱
echo "# (z) 일반 문서 반영점 미정 → pending(00e 라우팅·claim-basis 미승격·done 백스톱)"
rm -rf "$ROOT/runs/ci-ev-z"
ZZ="$SCRATCH/evz"; rm -rf "$ZZ"; mkdir -p "$ZZ"; printf 'doc bytes' > "$ZZ/ref.png"
printf '{"ref.png":{"reflect":true,"kind":"general","claim":"참조 내용"}}' > "$ZZ/index.json"
ingest_ev ci-ev-z "$ZZ"; RC=$?; ZR="$ROOT/runs/ci-ev-z"
check "(z) 문서만 첨부(반영점 미정) → 인입 성공(fail-closed 아님)" "[ $RC -eq 0 ] && [ -f '$ZR/00-ingest/evidence-documents.json' ]"
check "(z) pending 이면 00e-evidence 로 라우팅(01-brief/00g 아님)" "[ \"\$(jq_phase ci-ev-z phase)\" = '00e-evidence' ]"
python3 - "$ZR" <<'PY' && pass "(z) 매니페스트 spec_status=pending·kind=general·verdict_text 없음" || fail "(z) pending 매니페스트 필드 오류"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if d.get("reflect") is True and d.get("kind") == "general" and d.get("spec_status") == "pending" and "verdict_text" not in d else 1)
PY
python3 -c "import json,sys;cb=json.load(open('$ZR/00-ingest/claim-basis.json'));ids=[e['id'] for e in cb['evidence_on_file']];sys.exit(0 if not any(i.startswith('doc-') for i in ids) else 1)"; RC=$?
check "(z) pending 일반 문서 claim-basis 미승격(doc-* 부재 — 안전 불변식)" "[ $RC -eq 0 ]"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/check_evidence_reflection.py "$ZR" ) >/dev/null 2>&1; RC=$?
check "(z) pending 백스톱: check_evidence_reflection → 완료 차단(exit 1)" "[ $RC -ne 0 ]"

# (z2) 반영점 완전 지정된 일반 문서(kind=general)는 pending 아님(정상 경로 유지 — 회귀 가드)
echo "# (z2) 완전 지정 일반 문서 → pending 아님"
ZZ2="$SCRATCH/evz2"; rm -rf "$ZZ2"; mkdir -p "$ZZ2"; printf 'doc bytes' > "$ZZ2/ref.png"
printf '{"ref.png":{"reflect":true,"kind":"general","claim":"참조 내용","reflection_points":["원문 포인트 하나"]}}' > "$ZZ2/index.json"
rm -rf "$ROOT/runs/ci-ev-z2"; ingest_ev ci-ev-z2 "$ZZ2"; ZR2="$ROOT/runs/ci-ev-z2"
python3 - "$ZR2" <<'PY' && pass "(z2) 완전 지정 → spec_status 없음(pending 아님)" || fail "(z2) 완전 지정이 pending 으로 오분류"
import sys, json, os
d = json.load(open(os.path.join(sys.argv[1], "00-ingest/evidence-documents.json")))["documents"][0]
sys.exit(0 if d.get("reflect") is True and "spec_status" not in d and len(d.get("reflection_points") or []) == 1 else 1)
PY

# (aa) 혼합(test_report + general) → test_report 만 승격
echo "# (aa) 혼합 — test_report 만 claim-basis 승격"
AA="$SCRATCH/evaa"; rm -rf "$AA"; mkdir -p "$AA"; printf '%%PDF-1.4\nsuit\n' > "$AA/suit.pdf"; printf 'brand bytes' > "$AA/brand.png"
cat > "$AA/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"피부 사용 적합","verdict_text":"피부 사용에 적합함","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"1주","measured_values":null}},"brand.png":{"reflect":true,"kind":"brand_story","claim":"브랜드 스토리","reflection_points":["연구 15년"]}}
JSON
ingest_ev ci-ev-aa "$AA"; AAR="$ROOT/runs/ci-ev-aa"
python3 - "$AAR" <<'PY' && pass "(aa) claim-basis doc-* = test_report 1건만(general 미승격)" || fail "(aa) 혼합 승격 오류"
import sys, json, os
cb = json.load(open(os.path.join(sys.argv[1], "00-ingest/claim-basis.json")))
docids = [e["id"] for e in cb["evidence_on_file"] if e["id"].startswith("doc-")]
sys.exit(0 if len(docids) == 1 else 1)   # test_report(suit.pdf)만 승격, general(brand.png) 미승격
PY

# (bb) 일반 참조 문서 결박(validate_storyboard) — 각주 인용 블록에 reflection_point 원문 필요·evidence_ref 인용 불가
echo "# (bb) 일반 참조 문서 결박(reflection_point ⊆ 블록 카피 · 각주 채널)"
BB="$ROOT/runs/ci-ev-y"; mkdir -p "$BB/03-storyboard/plan"   # ci-ev-y = 일반 문서(brand.png=doc-01) 런
printf '{"order":1,"type":"hero","claims":[]}' > "$BB/03-storyboard/plan/01-hero.json"
printf '{"order":8,"type":"brandBanner","bodyText":["피부과학 연구 15년의 브랜드"],"claims":[],"footnotes":[{"id":"f1","text":"doc-01 참조"}]}' > "$BB/03-storyboard/plan/08-brand.json"
val_sb ci-ev-y; RC=$?; check "(bb) 각주 doc-01 인용 + 반영 포인트 원문 포함 → validate 통과" "[ $RC -eq 0 ]"
printf '{"order":8,"type":"brandBanner","bodyText":["믿을 수 있는 브랜드"],"claims":[],"footnotes":[{"id":"f1","text":"doc-01 참조"}]}' > "$BB/03-storyboard/plan/08-brand.json"
val_sb ci-ev-y; RC=$?; check "(bb) 각주만 인용·반영 포인트 원문 없음 → validate fail-closed" "[ $RC -ne 0 ]"
printf '{"order":8,"type":"brandBanner","claims":[{"claim_strength":"factual","target_text":"피부과학 연구 15년","evidence_ref":"doc-01"}],"footnotes":[]}' > "$BB/03-storyboard/plan/08-brand.json"
val_sb ci-ev-y; RC=$?; check "(bb) 일반 문서 evidence_ref 인용 → fail-closed(각주 채널만)" "[ $RC -ne 0 ]"
rm -rf "$BB/03-storyboard"

# ═════════════════════════════════════════════════════════════════════════════
# change_pct 정규화(P-2) — (cc)(dd)(ee): 정수표기 정규화·진짜 모순 fail-closed·미선언 자동기입
#   시험성적서(test_report.test_items[].series)로 도출한 소수1자리(clinical_chart.ROUND_PREC=1)와 사람 선언
#   (보고서 관행 = 정수)을 대조. 정규화값이 매니페스트(evidence-documents.json)와 claim-basis(doc-NN-tKK)
#   양쪽에 split-brain 없이 상속되는지 확인. 기존 exact-equal 경로는 정규화가 손대지 않는다(골든 바이트 불변).
# ═════════════════════════════════════════════════════════════════════════════
ingest_ev_cap() { ( cd "$ROOT" && HARNESS_EVIDENCE_DIR="$2" bash scripts/ingest-bundle.sh "$BUNDLE_MIN" "$1" ) 2>&1; }
man_ti_cp() {  # 매니페스트 documents[0].test_report.test_items[0].change_pct == 인자값(±1e-9)
  python3 - "$1" "$2" <<'PY'
import sys, json
d = json.load(open(sys.argv[1]))["documents"][0]
cp = d["test_report"]["test_items"][0].get("change_pct")
sys.exit(0 if cp is not None and abs(float(cp) - float(sys.argv[2])) < 1e-9 else 1)
PY
}
cb_ti_cp() {  # claim-basis 의 doc-01-t01 레코드 change_pct == 인자값(±1e-9)
  python3 - "$1" "$2" <<'PY'
import sys, json
cb = json.load(open(sys.argv[1]))["evidence_on_file"]
rec = next((e for e in cb if e.get("id") == "doc-01-t01"), None)
cp = rec.get("change_pct") if rec else None
sys.exit(0 if cp is not None and abs(float(cp) - float(sys.argv[2])) < 1e-9 else 1)
PY
}

# (cc) 정수 선언(-41) vs series 도출(-40.9) → 정규화(매니페스트·claim-basis 모두 -40.9)·stdout 한 줄
echo "# (cc) change_pct 정수 정규화(-41 → -40.9)"
rm -rf "$ROOT/runs/ci-ev-cc"
CC="$SCRATCH/evcc"; rm -rf "$CC"; mkdir -p "$CC"; printf '%%PDF-1.4\nsuit\n' > "$CC/suit.pdf"
cat > "$CC/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"수분 개선 확인","verdict_text":"수분 개선에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"수분량","unit":"%","series":[{"label":"사용 전","value":100},{"label":"4주 후","value":59.1}],"change_pct":-41}]}}}
JSON
OUT_CC="$(ingest_ev_cap ci-ev-cc "$CC")"; RC=$?
CCR="$ROOT/runs/ci-ev-cc"
check "(cc) 인입 성공(정수 선언 통과)" "[ $RC -eq 0 ]"
echo "$OUT_CC" | grep -q "→ 도출 -40.9 로 정규화"; RC=$?
check "(cc) stdout 정규화 안내 한 줄 출력" "[ $RC -eq 0 ]"
man_ti_cp "$CCR/00-ingest/evidence-documents.json" -40.9; RC=$?
check "(cc) 매니페스트 test_items[0].change_pct = -40.9(정규화)" "[ $RC -eq 0 ]"
cb_ti_cp "$CCR/00-ingest/claim-basis.json" -40.9; RC=$?
check "(cc) claim-basis doc-01-t01.change_pct = -40.9(승격 상속·split-brain 없음)" "[ $RC -eq 0 ]"

# (dd) 진짜 모순: 선언(-41) vs series 도출(~-33.3) → fail-closed, 도출값이 에러 메시지에
echo "# (dd) change_pct 진짜 모순 → fail-closed"
rm -rf "$ROOT/runs/ci-ev-dd"
DD="$SCRATCH/evdd"; rm -rf "$DD"; mkdir -p "$DD"; printf '%%PDF-1.4\nsuit\n' > "$DD/suit.pdf"
cat > "$DD/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"수분 개선 확인","verdict_text":"수분 개선에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"수분량","unit":"%","series":[{"label":"전","value":60},{"label":"후","value":40}],"change_pct":-41}]}}}
JSON
OUT_DD="$(ingest_ev_cap ci-ev-dd "$DD")"; RC=$?
check "(dd) 진짜 모순 선언 → 인입 fail-closed(exit≠0)" "[ $RC -ne 0 ]"
echo "$OUT_DD" | grep -qF -- "-33.3"; RC=$?
check "(dd) 에러 메시지에 도출값(-33.3) 노출" "[ $RC -eq 0 ]"

# (ee) 미선언 change_pct + series → 도출값 자동기입(매니페스트·claim-basis 모두 -40.9)
echo "# (ee) change_pct 미선언 → 자동기입"
rm -rf "$ROOT/runs/ci-ev-ee"
EE="$SCRATCH/evee"; rm -rf "$EE"; mkdir -p "$EE"; printf '%%PDF-1.4\nsuit\n' > "$EE/suit.pdf"
cat > "$EE/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"수분 개선 확인","verdict_text":"수분 개선에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"수분량","unit":"%","series":[{"label":"사용 전","value":100},{"label":"4주 후","value":59.1}]}]}}}
JSON
ingest_ev ci-ev-ee "$EE"; RC=$?
EER="$ROOT/runs/ci-ev-ee"
check "(ee) 미선언 인입 성공" "[ $RC -eq 0 ]"
man_ti_cp "$EER/00-ingest/evidence-documents.json" -40.9; RC=$?
check "(ee) 매니페스트 test_items[0].change_pct 자동기입 = -40.9" "[ $RC -eq 0 ]"
cb_ti_cp "$EER/00-ingest/claim-basis.json" -40.9; RC=$?
check "(ee) claim-basis doc-01-t01.change_pct 자동기입 = -40.9" "[ $RC -eq 0 ]"

# (ff) 비정수 선언(-40.6) vs series 도출(-40.9): |선언−round(도출)|=0.4<0.5 지만 선언이 '정수 아님' →
#   정규화 금지·진짜 모순으로 fail-closed(Codex W1: 정밀 선언의 실제 오차를 '정수표기 허용'으로 숨기지 않음).
echo "# (ff) 비정수 선언 근사 → 정규화 안 함, fail-closed"
rm -rf "$ROOT/runs/ci-ev-ff"
FF="$SCRATCH/evff"; rm -rf "$FF"; mkdir -p "$FF"; printf '%%PDF-1.4\nsuit\n' > "$FF/suit.pdf"
cat > "$FF/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"수분 개선 확인","verdict_text":"수분 개선에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"수분량","unit":"%","series":[{"label":"사용 전","value":100},{"label":"4주 후","value":59.1}],"change_pct":-40.6}]}}}
JSON
OUT_FF="$(ingest_ev_cap ci-ev-ff "$FF")"; RC=$?
check "(ff) 비정수 선언 근사(-40.6) → 인입 fail-closed(exit≠0)" "[ $RC -ne 0 ]"
echo "$OUT_FF" | grep -q -- "-40.9"; RC=$?
check "(ff) 에러 메시지에 도출값(-40.9) 노출" "[ $RC -eq 0 ]"

# (gg) 정밀 2소수 선언(-59.86) vs before/after 도출(-59.9): round(-59.86,1)=-59.9 근사일치 → 인입 성공 +
#   도출값(-59.9)으로 '정규화'(원문 보존 아님). Codex 10R: 하류 주입(build_context)·검증(numbers_consistent) 일관성 위해 정규화.
echo "# (gg) 정밀 2소수 선언 근사일치 → 도출값 정규화·인입 성공"
rm -rf "$ROOT/runs/ci-ev-gg"
GG="$SCRATCH/evgg"; rm -rf "$GG"; mkdir -p "$GG"; printf '%%PDF-1.4\nsuit\n' > "$GG/suit.pdf"
cat > "$GG/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"피지 감소 확인","verdict_text":"피지 감소에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"피지량","unit":"%","before":102.538,"after":41.154,"change_pct":-59.86}]}}}
JSON
OUT_GG="$(ingest_ev_cap ci-ev-gg "$GG")"; RC=$?
GGR="$ROOT/runs/ci-ev-gg"
check "(gg) 정밀 2소수 선언 인입 성공(fail-closed 아님)" "[ $RC -eq 0 ]"
man_ti_cp "$GGR/00-ingest/evidence-documents.json" -59.9; RC=$?
check "(gg) 매니페스트 test_items[0].change_pct = -59.9(도출값 정규화·하류 일관성)" "[ $RC -eq 0 ]"
cb_ti_cp "$GGR/00-ingest/claim-basis.json" -59.9; RC=$?
check "(gg) claim-basis doc-01-t01.change_pct = -59.9(승격 상속)" "[ $RC -eq 0 ]"

# (hh) .5 타이 관행 반올림: before=100 after=59.5 도출 -40.5, 선언 정수 -41(관행 -40.5→-41) → 정규화 수용.
#   파이썬 round(-40.5)=−40(banker's)이라 예전이면 거부했을 케이스 — round-half-away 로 관행 표기 수용(Codex 5R).
echo "# (hh) .5 타이 정수 선언 → 관행 반올림 수용"
rm -rf "$ROOT/runs/ci-ev-hh"
HH="$SCRATCH/evhh"; rm -rf "$HH"; mkdir -p "$HH"; printf '%%PDF-1.4\nsuit\n' > "$HH/suit.pdf"
cat > "$HH/index.json" <<'JSON'
{"suit.pdf":{"grade":"인체적용시험","reflect":true,"claim":"피지 감소 확인","verdict_text":"피지 감소에 도움을 줌","test_report":{"institution":"P&K피부임상연구센타","sample_size":22,"duration":"4주","measured_values":null,"test_items":[{"metric":"피지량","unit":"%","before":100,"after":59.5,"change_pct":-41}]}}}
JSON
OUT_HH="$(ingest_ev_cap ci-ev-hh "$HH")"; RC=$?
HHR="$ROOT/runs/ci-ev-hh"
check "(hh) .5 타이 정수 선언(-41 vs 도출 -40.5) → 인입 성공(관행 반올림 수용)" "[ $RC -eq 0 ]"
man_ti_cp "$HHR/00-ingest/evidence-documents.json" -40.5; RC=$?
check "(hh) 매니페스트 test_items[0].change_pct = -40.5(도출값 정규화)" "[ $RC -eq 0 ]"

printf '\n[evidence] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
