#!/usr/bin/env bash
# test-intake.sh — 00a-intake 관문(W-1) + 분석·발효(W-2) 회귀 가드. 결정적·오프라인(stub), 헤르메틱 픽스처.
#   W-1(관문 골격): 스테이징·sha256 사이드카·stub 제안·approve 초크(unknown/변조)·디스크립터 변조 가드·no-intake 격리.
#   W-2(분석·발효): approve → kcia autopass(review-exempt) → gate.sh 가 apply-intake(라우팅)+ingest-bundle(인입)을 잇는다.
#     (a) 자사 크롤 있는 클린 런 → 00-ingest 실산출물(voc/claim-basis/assets-manifest) + 조건부 라우팅 전이
#     (b) 자사 크롤 없음 → 최소 합성 번들(선언 제품명+리뷰0) → 00-ingest 성공
#     (c) 시험성적서(evidence_test_report) → inputs/evidence/ + intent-only 사이드카 → spec_status:pending → 00e-evidence 연쇄(W-3)
#     (d) 참고 크롤(reference_crawl) 이미지는 inputs/assets 로 새지 않는다(examples 로만)
#     (e) 락 재진입: gate.sh→ingest-bundle 이 보유 락에서 데드락 없이 완주(E2E 완주 자체가 증명)
#     (f) no-intake 런(new-run) 골든 바이트 불변(스모크; 본증명은 verify-baseline)
#     (g) 재-인테이크 멱등(apply-intake 재실행 → 동일 staging)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 00a-intake 관문(W-1) + 분석·발효(W-2) — 첨부 분류 제안·승인 → 라우팅·인입"

export HARNESS_OFFLINE=1 HARNESS_DOMAIN=cosmetic HARNESS_FORMAT=multipage_bm

SCRATCH="$(mktemp -d)"
PDBAK="$SCRATCH/phase-descriptors.bak"
PD="$ROOT/harness/phase-descriptors.json"
cp "$PD" "$PDBAK"
cleanup() { cp "$PDBAK" "$PD" 2>/dev/null || true; rm -rf "$SCRATCH" "$ROOT"/runs/ci-intake-* 2>/dev/null || true; }
trap cleanup EXIT

# 표준 픽스처: wb.docx(워킹백워드)·product.webp(자사 이미지). 옵션 인자로 크롤/근거를 더한다.
mk_fixture() {  # mk_fixture <dir> [crawl] [pdf] [unknown]
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  printf 'DOCX-bytes-working-backwards\n' > "$d/wb.docx"
  printf 'RIFFWEBP-image-bytes\n'         > "$d/product.webp"
  case " ${*:2} " in *" crawl "*)
    printf 'content,score,option\n"커버 좋아요",5,"21호"\n' > "$d/reviews.csv"
    printf '{"name":"[브랜드] 릴리프"}\n'                     > "$d/product.json" ;;
  esac
  case " ${*:2} " in *" pdf "*) printf '%%PDF-1.4\nPNK test report\n' > "$d/report.pdf" ;; esac
  case " ${*:2} " in *" unknown "*) printf 'mystery-bytes\n' > "$d/mystery.xyz" ;; esac
}
intake_run() {  # intake_run <dir> <rid>
  ( cd "$ROOT" && bash scripts/intake.sh "$1" "$2" --product "[브랜드] 릴리프" --domain 화장품 --format 여러장 ) >/dev/null 2>&1
}
prop_has_unknown() {  # <rid> → exit 0 if any file category==unknown
  python3 -c "import json,sys;p=json.load(open('$ROOT/runs/$1/00a-intake/intake-proposal.json'));sys.exit(0 if any(f.get('category')=='unknown' for f in p.get('files',[])) else 1)"
}
drive_to_ingest() {  # <rid> — run-stage → approve → kcia(발효+인입). rc 는 kcia 로.
  ( cd "$ROOT" && bash scripts/run-stage.sh intake "$1" ) >/dev/null 2>&1
  ( cd "$ROOT" && bash scripts/approve.sh "$1" )         >/dev/null 2>&1
  ( cd "$ROOT" && bash scripts/kcia-check.sh "$1" )      >/dev/null 2>&1
}

# ─────────────────────────────────────────────────────────────────────────────
# W-1 (A) 스테이징 + stub 제안 + approve 초크(unknown/변조)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (A) W-1 관문: 스테이징 · 제안 · unknown/변조 초크"
mk_fixture "$SCRATCH/attach_u" crawl unknown
intake_run "$SCRATCH/attach_u" ci-intake-u
U="$ROOT/runs/ci-intake-u"
check "(A) intake.sh → phase=00a-intake" "[ \"\$(jq_phase ci-intake-u phase)\" = '00a-intake' ]"
check "(A) 첨부 스냅샷(원본 바이트 복사)" "[ -f '$U/inputs/attachments/wb.docx' ] && [ -f '$U/inputs/attachments/mystery.xyz' ]"
check "(A) sha256 사이드카 생성" "[ -f '$U/inputs/attachments/.sha256sums' ]"
check "(A) state 스키마 유효" "python3 '$ROOT/scripts/lib/harness.py' validate '$U/state.json' >/dev/null 2>&1"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-u ) >/dev/null 2>&1; RC=$?
check "(A) run-stage intake stub 제안 생성" "[ $RC -eq 0 ] && [ -f '$U/00a-intake/intake-proposal.json' ]"
check "(A) 제안 스키마 유효(registry intake-proposal)" "python3 '$ROOT/scripts/lib/harness.py' validate '$U/00a-intake/intake-proposal.json' >/dev/null 2>&1"
check "(A) 생성 직후 gate=user(승인 대기)" "[ \"\$(jq_phase ci-intake-u gate)\" = 'user' ]"
check "(A) 제안에 unknown 행 존재(mystery.xyz)" "prop_has_unknown ci-intake-u"
( cd "$ROOT" && bash scripts/approve.sh ci-intake-u ) >/dev/null 2>&1; RC=$?
check "(A) unknown 잔존 → approve 거부(fail-closed)" "[ $RC -ne 0 ]"
check "(A) 거부 후 gate 유지(user)" "[ \"\$(jq_phase ci-intake-u gate)\" = 'user' ]"

# 변조 가드: 클린 픽스처로 sha256 불일치 시 approve 거부
mk_fixture "$SCRATCH/attach_t" crawl
intake_run "$SCRATCH/attach_t" ci-intake-t
T="$ROOT/runs/ci-intake-t"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-t ) >/dev/null 2>&1
printf 'TAMPERED-different-bytes\n' > "$T/inputs/attachments/product.webp"
( cd "$ROOT" && bash scripts/approve.sh ci-intake-t ) >/dev/null 2>&1; RC=$?
check "(A) 스냅샷 변조 → approve 거부(sha256 불일치)" "[ $RC -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (a) 자사 크롤 클린 런 — approve → kcia autopass → apply-intake + ingest-bundle
# ─────────────────────────────────────────────────────────────────────────────
echo "# (a) W-2 전체 체인: 자사 크롤 → 라우팅 → 00-ingest 실산출물 → 조건부 전이"
mk_fixture "$SCRATCH/attach_a" crawl
intake_run "$SCRATCH/attach_a" ci-intake-a
A="$ROOT/runs/ci-intake-a"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-a ) >/dev/null 2>&1
check "(a) 변환된 워킹백워드 존재(converted/working-backwards.md)" "[ -s '$A/00a-intake/converted/working-backwards.md' ]"
( cd "$ROOT" && bash scripts/approve.sh ci-intake-a ) >/dev/null 2>&1; RC=$?
check "(a) 클린 분류·무결 → approve 성공(gate=review)" "[ $RC -eq 0 ] && [ \"\$(jq_phase ci-intake-a gate)\" = 'review' ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-intake-a ) >/dev/null 2>&1; RC=$?
check "(a) kcia autopass → apply-intake+ingest 연쇄 성공(rc=0, 데드락 없음)" "[ $RC -eq 0 ]"
check "(a) verdict engine=review-exempt-autopass(심의 면제)" "[ \"\$(python3 '$ROOT/scripts/lib/harness.py' jget '$A/00a-intake/intake-verdict.json' engine)\" = 'review-exempt-autopass' ]"
check "(a) 00-ingest 실산출물 present(voc/claim-basis/assets-manifest)" "[ -f '$A/00-ingest/voc.json' ] && [ -f '$A/00-ingest/claim-basis.json' ] && [ -f '$A/00-ingest/assets-manifest.json' ]"
check "(a) 라우팅: bundle=reviews+product · assets=product.webp · WB 격리" "[ -f '$A/inputs/bundle/reviews.csv' ] && [ -f '$A/inputs/bundle/product.json' ] && [ -f '$A/inputs/assets/product.webp' ] && [ -s '$A/inputs/working-backwards.md' ]"
check "(a) 근거·참고 없음 → 조건부 라우팅 = 01-brief" "[ \"\$(jq_phase ci-intake-a phase)\" = '01-brief' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (b) 자사 크롤 없음 — 최소 합성 번들(선언 제품명 + 리뷰0)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (b) 합성 번들: 자사 크롤 부재 → product.json{선언 제품명}+reviews.csv 헤더"
mk_fixture "$SCRATCH/attach_b"    # crawl 없음
intake_run "$SCRATCH/attach_b" ci-intake-b
B="$ROOT/runs/ci-intake-b"
drive_to_ingest ci-intake-b
check "(b) 합성 번들 product.json 이름 = 선언 제품명" "[ \"\$(python3 -c \"import json;print(json.load(open('$B/00a-intake/routed/bundle/product.json'))['name'])\")\" = '[브랜드] 릴리프' ]"
check "(b) 합성 reviews.csv 헤더만(리뷰0)" "[ -f '$B/00a-intake/routed/bundle/reviews.csv' ]"
check "(b) 00-ingest 성공(voc.json present)" "[ -f '$B/00-ingest/voc.json' ]"
check "(b) 조건부 라우팅 = 01-brief" "[ \"\$(jq_phase ci-intake-b phase)\" = '01-brief' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (c) 시험성적서 intent → evidence/ + 사이드카 → spec_status:pending → 00e-evidence
# ─────────────────────────────────────────────────────────────────────────────
echo "# (c) 시험성적서 intent → 00e-evidence 연쇄(W-3)"
mk_fixture "$SCRATCH/attach_c" crawl pdf
intake_run "$SCRATCH/attach_c" ci-intake-c
C="$ROOT/runs/ci-intake-c"
drive_to_ingest ci-intake-c
check "(c) report.pdf → inputs/evidence/ 로 라우팅" "[ -f '$C/inputs/evidence/report.pdf' ]"
check "(c) intent-only 사이드카 → 매니페스트 kind=test_report + spec_status=pending" "python3 -c \"import json;m=json.load(open('$C/00-ingest/evidence-documents.json'));d=[x for x in m['documents'] if x['filename']=='report.pdf'][0];import sys;sys.exit(0 if d.get('kind')=='test_report' and d.get('spec_status')=='pending' else 1)\""
check "(c) 조건부 라우팅 = 00e-evidence(pending 참조 문서)" "[ \"\$(jq_phase ci-intake-c phase)\" = '00e-evidence' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (d) 참고 크롤(zip) → examples 로만(inputs/assets 로 새지 않음)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (d) 참고 크롤 이미지는 assets 로 새지 않는다"
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  D="$SCRATCH/attach_d"; mk_fixture "$D"    # wb + product.webp(자사)
  ZS="$SCRATCH/zsrc"; rm -rf "$ZS"; mkdir -p "$ZS/images/detail"
  printf 'REFIMG-bytes\n' > "$ZS/images/detail/ref1.webp"
  printf '{"name":"타사제품"}\n' > "$ZS/product.json"
  ( cd "$ZS" && zip -q -r "$D/competitor.zip" . )
  intake_run "$D" ci-intake-d
  DD="$ROOT/runs/ci-intake-d"
  ( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-d ) >/dev/null 2>&1
  check "(d) competitor.zip → reference_crawl 분류(제품명 대조)" "[ \"\$(python3 -c \"import json;print([f['category'] for f in json.load(open('$DD/00a-intake/intake-proposal.json'))['files'] if f['filename']=='competitor.zip'][0])\")\" = 'reference_crawl' ]"
  ( cd "$ROOT" && bash scripts/approve.sh ci-intake-d )    >/dev/null 2>&1
  ( cd "$ROOT" && bash scripts/kcia-check.sh ci-intake-d ) >/dev/null 2>&1; RC=$?
  check "(d) 체인 완주(rc=0)" "[ $RC -eq 0 ]"
  check "(d) 참고 이미지는 examples 로만(inputs/examples 존재)" "[ -d '$DD/inputs/examples/cosmetic' ] && [ -n \"\$(find '$DD/inputs/examples/cosmetic' -name 'ref1.webp' 2>/dev/null)\" ]"
  check "(d) 참고 이미지(ref1.webp)가 inputs/assets 로 새지 않음" "[ -z \"\$(find '$DD/inputs/assets' -name 'ref1.webp' 2>/dev/null)\" ]"
  check "(d) 자사 이미지(product.webp)는 inputs/assets 에 있음" "[ -n \"\$(find '$DD/inputs/assets' -name 'product.webp' 2>/dev/null)\" ]"
  check "(d) 참고 사례 존재 → 조건부 라우팅 = 00g-guideline" "[ \"\$(jq_phase ci-intake-d phase)\" = '00g-guideline' ]"
else
  echo "  - (d) zip/unzip 부재 — 참고 크롤 zip 케이스 건너뜀(환경)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (g) 재-인테이크 멱등 — apply-intake 재실행 → 동일 staging(routed/)
# ─────────────────────────────────────────────────────────────────────────────
echo "# (g) 재-인테이크 멱등(apply-intake 재실행 → 동일 routed/)"
routed_manifest() {  # <rid> → 정렬된 'sha  상대경로'
  ( cd "$ROOT/runs/$1/00a-intake/routed" && find . -type f | sort \
    | while read -r f; do printf '%s  %s\n' "$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$f")" "$f"; done )
}
BEF="$(routed_manifest ci-intake-a)"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-intake ci-intake-a ) >/dev/null 2>&1; RC=$?
AFT="$(routed_manifest ci-intake-a)"
check "(g) apply-intake 재실행 성공(rc=0)" "[ $RC -eq 0 ]"
check "(g) routed/ staging 재실행 후 동일(멱등)" "[ \"\$BEF\" = \"\$AFT\" ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-1 (e) 디스크립터 변조 가드 — 비면제 페이즈에 review:false 심으면 route_assert_valid fail-closed
# ─────────────────────────────────────────────────────────────────────────────
echo "# (e-desc) phase-descriptors 변조 가드"
( cd "$ROOT" && bash scripts/new-run.sh ci-intake-e --domain 화장품 --format 여러장 ) >/dev/null 2>&1
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-intake-e/state.json" gate '"review"' >/dev/null
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-intake-e/state.json" status '"pending"' >/dev/null
python3 - "$PD" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["phases"]["02-concept"]["review"] = False   # 닫힌 leaf($def)엔 review 없음 → 스키마 무효
json.dump(d, open(p, "w"), ensure_ascii=False)
PY
( cd "$ROOT" && bash scripts/kcia-check.sh ci-intake-e ) >/dev/null 2>&1; RC=$?
cp "$PDBAK" "$PD"   # 즉시 원복(후속 테스트 격리)
check "(e-desc) 02-concept review:false 변조 → kcia-check die(route_assert_valid)" "[ $RC -ne 0 ]"
check "(e-desc) 원복 후 phase-descriptors 스키마 유효(정상 복구)" "( cd '$ROOT' && HARNESS_ROOT='$ROOT' bash -c 'source scripts/lib/common.sh; route_assert_valid' ) >/dev/null 2>&1"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (f) no-intake 격리 — new-run 은 00a 미등장(opt-in). 골든 바이트 본증명은 verify-baseline.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (f) no-intake 격리(opt-in)"
( cd "$ROOT" && bash scripts/new-run.sh ci-intake-f --domain 화장품 --format 여러장 ) >/dev/null 2>&1
F="$ROOT/runs/ci-intake-f"
check "(f) new-run → phase=00-ingest(00a-intake 미등장)" "[ \"\$(jq_phase ci-intake-f phase)\" = '00-ingest' ]"
check "(f) new-run → 00a-intake·attachments 디렉터리 부재(첨부 채널 미개입)" "[ ! -d '$F/00a-intake' ] && [ ! -d '$F/inputs/attachments' ]"

# (H-1) intake 초기 state 파생 = new-run 과 동일 규칙(별칭 레지스트리 질의 + 기능범주 폴백 []). 재분기 방지 가드.
#   소스: 인라인 case 재구현·화장품 트리플 폐지 확인. 런타임: 같은 도메인(화장품)에 대해 ci-intake-u(intake 초기,
#   00a-intake·ingest 전)·ci-intake-e(new-run 초기) 의 product.functional_status 가 동일(둘 다 레지스트리 파생).
check "(H-1) intake 별칭 = 레지스트리 질의(인라인 case 재구현 아님)" \
  "grep -q 'domain_alias_resolve' '$ROOT/scripts/intake.sh' && grep -q 'format_alias_resolve' '$ROOT/scripts/intake.sh' && ! grep -qE '화장품[|]cosmetic[)] cand' '$ROOT/scripts/intake.sh'"
check "(H-1) intake 기능범주 폴백 = [](화장품 트리플 재현 폐지, new-run 동일)" \
  "! grep -qE 'cats = \\[\"whitening\"' '$ROOT/scripts/intake.sh'"
check "(H-1) intake≡new-run 초기 functional_status(화장품 실측 동일)" \
  "[ \"\$(python3 '$ROOT/scripts/lib/harness.py' jget '$U/state.json' product.functional_status 2>/dev/null)\" = \"\$(python3 '$ROOT/scripts/lib/harness.py' jget '$ROOT/runs/ci-intake-e/state.json' product.functional_status 2>/dev/null)\" ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (g·외부리뷰 W4) 사람 선언(state.json)이 진실: 합성 번들 제품명은 에이전트 제안 변조를 무시하고 state.product.name 을 쓴다.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (g) 합성 번들 제품명 = state 선언(에이전트 제안 변조 무시)"
mk_fixture "$SCRATCH/attach_g"    # crawl 없음 → 합성 번들
intake_run "$SCRATCH/attach_g" ci-intake-g
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-g ) >/dev/null 2>&1
# 에이전트 제안의 product_name_declared 를 엉뚱한 값으로 변조(오류·조작 모사). approve/apply 는 이를 무시해야 한다.
python3 -c "import json;p='$ROOT/runs/ci-intake-g/00a-intake/intake-proposal.json';d=json.load(open(p));d['product_name_declared']='WRONG타사제품';json.dump(d,open(p,'w'),ensure_ascii=False)"
( cd "$ROOT" && bash scripts/approve.sh ci-intake-g && bash scripts/kcia-check.sh ci-intake-g ) >/dev/null 2>&1
G="$ROOT/runs/ci-intake-g"
check "(g) 합성 번들 제품명 = state 선언(제안 변조 무시)" "[ \"\$(python3 -c \"import json;print(json.load(open('$G/00a-intake/routed/bundle/product.json'))['name'])\")\" = '[브랜드] 릴리프' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (h·외부리뷰 W4) 비화장품 도메인: reference_crawl 이 state 도메인 폴더(examples/drug)로 라우팅(cosmetic 기본값 아님).
# ─────────────────────────────────────────────────────────────────────────────
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  echo "# (h) 비화장품(의약품) reference_crawl → examples/drug 라우팅(도메인=state)"
  H="$SCRATCH/attach_h"; mk_fixture "$H"    # wb + product.webp(자사)
  HZ="$SCRATCH/hzsrc"; rm -rf "$HZ"; mkdir -p "$HZ/images/detail"
  printf 'REFIMG-bytes\n' > "$HZ/images/detail/ref1.webp"
  printf '{"name":"타사약품"}\n' > "$HZ/product.json"
  ( cd "$HZ" && zip -q -r "$H/competitor.zip" . )
  ( cd "$ROOT" && bash scripts/intake.sh "$H" ci-intake-h --product "대웅 릴리프" --domain 의약품 --format 여러장 ) >/dev/null 2>&1
  HH="$ROOT/runs/ci-intake-h"
  check "(h) 도메인 선언 = drug(state.json)" "[ \"\$(python3 -c \"import json;print((json.load(open('$HH/state.json')).get('product') or {}).get('regulatory_domain'))\")\" = 'drug' ]"
  drive_to_ingest ci-intake-h
  check "(h) reference_crawl → routed/examples/drug 로 라우팅(cosmetic 아님)" "[ -d '$HH/00a-intake/routed/examples/drug' ] && [ ! -d '$HH/00a-intake/routed/examples/cosmetic' ]"
  check "(h) 참고 이미지가 examples/drug 아래 존재(도메인 미스매치로 유실되지 않음)" "[ -n \"\$(find '$HH/00a-intake/routed/examples/drug' -name 'ref1.webp' 2>/dev/null)\" ]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (i·외부리뷰 W4-R2) WB shift-left: 변환본 없으면 '승인 전' validate 거부(apply 단계 wedge 방지).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (i) 워킹백워드 변환본 없음 → validate-stage 00a 승인 전 거부"
mk_fixture "$SCRATCH/attach_i"
intake_run "$SCRATCH/attach_i" ci-intake-i
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-i ) >/dev/null 2>&1
II="$ROOT/runs/ci-intake-i"
# 정상(변환본 존재) 시 validate 통과
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-i 00a-intake ) >/dev/null 2>&1
check "(i) 변환본 존재 → validate-stage 00a 통과" "[ $? -eq 0 ]"
# 변환본 제거 → 승인 전 validate 거부(gate=user 에서 revise 가능; apply 후 wedge 아님)
rm -f "$II/00a-intake/converted/working-backwards.md"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-i 00a-intake ) >/dev/null 2>&1
check "(i) 변환본 없음 → validate-stage 00a 거부(승인 전 wedge 방지)" "[ $? -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (j·외부리뷰 W4-R3) category↔kind 불일치(evidence_test_report+kind:general) → 승인 전 validate 거부(근거 강등 우회 차단).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (j) category↔kind 불일치 → validate-stage 00a 승인 전 거부"
mk_fixture "$SCRATCH/attach_j" pdf    # PDF 포함 → evidence_test_report 분류
intake_run "$SCRATCH/attach_j" ci-intake-j
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-j ) >/dev/null 2>&1
JJ="$ROOT/runs/ci-intake-j"
# 정상 제안(불일치 없음) → validate 통과
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-j 00a-intake ) >/dev/null 2>&1
check "(j) 정상 제안 → validate-stage 00a 통과" "[ $? -eq 0 ]"
# evidence_test_report 행에 kind:general 주입(불일치) → validate 거부(sha256 은 첨부 기준이라 영향 없음)
python3 -c "
import json,sys
p='$JJ/00a-intake/intake-proposal.json'; d=json.load(open(p))
hit=[f for f in d['files'] if f.get('category')=='evidence_test_report']
for f in hit: f['kind']='general'
json.dump(d,open(p,'w'),ensure_ascii=False)
sys.exit(0 if hit else 3)" || fail "(j) 픽스처에 evidence_test_report 행 없음(픽스처 오류)"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-j 00a-intake ) >/dev/null 2>&1
check "(j) category↔kind 불일치 → validate-stage 00a 거부(근거 강등 우회 차단)" "[ $? -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (k·외부리뷰 W4-R4) 부분 크롤(product.json 만·reviews.csv 없음) → apply 가 reviews.csv 합성 → ingest 성공(hard-fail wedge 방지).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (k) 부분 크롤(reviews.csv 없음) → reviews.csv 합성 → 인입 성공"
K="$SCRATCH/attach_k"; rm -rf "$K"; mkdir -p "$K"
printf 'DOCX-bytes-working-backwards\n' > "$K/wb.docx"      # working_backwards
printf '{"name":"[브랜드] 릴리프"}\n'   > "$K/product.json"  # own_product_crawl 이지만 reviews.csv 없음(부분)
intake_run "$K" ci-intake-k
KK="$ROOT/runs/ci-intake-k"
drive_to_ingest ci-intake-k
check "(k) 부분 크롤: reviews.csv 합성됨(누락 파일만 채움)" "[ -f '$KK/00a-intake/routed/bundle/reviews.csv' ]"
check "(k) 부분 크롤: 크롤 product.json 보존(합성 아님)" "[ -f '$KK/00a-intake/routed/bundle/product.json' ]"
check "(k) 부분 크롤 → 00-ingest 성공(voc.json)" "[ -f '$KK/00-ingest/voc.json' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (l·외부리뷰 W4-R5) 변환본 결손 시 run-stage 재생성(skip wedge 방지) — proposal 만 보고 skip 하지 않는다.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (l) 변환본 결손 → revise 재생성으로 복구(wedge 아님) + primary_ok 완료조건에 변환본 포함"
mk_fixture "$SCRATCH/attach_l"
intake_run "$SCRATCH/attach_l" ci-intake-l
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-l ) >/dev/null 2>&1
L="$ROOT/runs/ci-intake-l"
check "(l) 최초 생성: 변환본 존재" "[ -s '$L/00a-intake/converted/working-backwards.md' ]"
rm -f "$L/00a-intake/converted/working-backwards.md"    # 생성기 크래시로 변환본만 결손된 상태 모사
# 변환본 결손 시 승인 전 validate 거부(shift-left, 케이스 i 와 동일 성질) → 그대로 승인 못 함
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-l 00a-intake ) >/dev/null 2>&1
check "(l) 변환본 결손 → validate 거부(승인 전)" "[ $? -ne 0 ]"
# 운영 복구: revise → run-stage 재생성(status=revise 는 idempotent skip 우회) → 변환본 복원
( cd "$ROOT" && bash scripts/revise.sh ci-intake-l "변환본 결손 — 재생성" ) >/dev/null 2>&1
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-l ) >/dev/null 2>&1
check "(l) revise→run-stage: 변환본 재생성됨(복구 가능·wedge 아님)" "[ -s '$L/00a-intake/converted/working-backwards.md' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (m·외부리뷰 W4-R6) 다중 워킹백워드 문서 → 변환본이 전부 결합(첫 파일만 쓰지 않음, 사실 유실 방지).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (m) 다중 WB 문서 → 변환본 전부 결합"
M="$SCRATCH/attach_m"; rm -rf "$M"; mkdir -p "$M"
printf 'WB-DOC-ONE-uniquealpha\n' > "$M/wb.docx"
printf 'WB-DOC-TWO-uniquebeta\n'  > "$M/plan.md"
printf 'RIFFWEBP\n' > "$M/product.webp"
intake_run "$M" ci-intake-m
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-m ) >/dev/null 2>&1
MM="$ROOT/runs/ci-intake-m"
check "(m) 다중 WB → 변환본에 두 문서 내용 모두 결합" \
  "grep -q uniquealpha '$MM/00a-intake/converted/working-backwards.md' && grep -q uniquebeta '$MM/00a-intake/converted/working-backwards.md'"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (n·외부리뷰 W4-R6) 느슨한(zip 아님) reference 크롤 → 단일 _reference/ 디렉터리로 병합(product/review 쌍 보존).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (n) 느슨한 reference 2파일 → 단일 _reference/ 병합"
N="$SCRATCH/attach_n"; rm -rf "$N"; mkdir -p "$N"
printf 'DOCX\n' > "$N/wb.docx"
printf '{"name":"타사경쟁"}\n' > "$N/product.json"
printf 'content,score,option\n"경쟁 후기",5,"x"\n' > "$N/reviews.csv"
intake_run "$N" ci-intake-n
NN="$ROOT/runs/ci-intake-n"
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-n ) >/dev/null 2>&1
# 에이전트가 타사로 판정한 상황: product.json+reviews.csv 를 reference_crawl(route=examples)로 재분류(sha256 불변)
python3 -c "
import json
p='$NN/00a-intake/intake-proposal.json'; d=json.load(open(p))
for f in d['files']:
    if f['filename'] in ('product.json','reviews.csv'):
        f['category']='reference_crawl'; f['route']='examples'; f.pop('kind',None)
json.dump(d,open(p,'w'),ensure_ascii=False)"
( cd "$ROOT" && bash scripts/approve.sh ci-intake-n && bash scripts/kcia-check.sh ci-intake-n ) >/dev/null 2>&1
RD="$NN/00a-intake/routed/examples/cosmetic/_reference"
check "(n) 느슨한 reference 2파일이 단일 _reference/ 에 병합(product+review 쌍 보존)" \
  "[ -f '$RD/product.json' ] && [ -f '$RD/reviews.csv' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (o·외부리뷰 W4-R7) 비ASCII run_id → intake.sh 생성단계 fail-closed(apply-intake 에서만 실패하는 wedge 방지·토큰 일관).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (o) 한글 run_id → intake.sh 거부"
mk_fixture "$SCRATCH/attach_o"
( cd "$ROOT" && bash scripts/intake.sh "$SCRATCH/attach_o" "한글런아이디" --product "릴리프" --domain 화장품 --format 여러장 ) >/dev/null 2>&1; RC=$?
check "(o) 한글 run_id → intake.sh fail-closed(rc≠0)" "[ $RC -ne 0 ]"
check "(o) 거부된 run_id 로 런 디렉터리 미생성" "[ ! -d '$ROOT/runs/한글런아이디' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (p·외부리뷰 W4-R8) 승인 직전 전체 00a 검증: 생성 후 gate=user 에서 변환본 삭제 → approve 거부(review 게이트 wedge 방지).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (p) 생성 후 변환본 삭제 → approve 거부(전체 00a 재검증)"
mk_fixture "$SCRATCH/attach_p"
intake_run "$SCRATCH/attach_p" ci-intake-p
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-p ) >/dev/null 2>&1
PP="$ROOT/runs/ci-intake-p"
rm -f "$PP/00a-intake/converted/working-backwards.md"   # gate=user 에서 전제 깨짐
( cd "$ROOT" && bash scripts/approve.sh ci-intake-p ) >/dev/null 2>&1; RC=$?
check "(p) 변환본 삭제 후 approve 거부(rc≠0, review 게이트로 안 넘어감)" "[ $RC -ne 0 ]"
check "(p) 거부 후 phase=00a-intake 불변(gate=user 유지)" "[ \"\$(jq_phase ci-intake-p phase)\" = '00a-intake' ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (q·외부리뷰 W4-R8) category↔route 일관성: product_image+route:evidence 불일치 → 승인 전 validate 거부.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (q) category↔route 불일치 → validate-stage 00a 거부"
mk_fixture "$SCRATCH/attach_q"
intake_run "$SCRATCH/attach_q" ci-intake-q
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-q ) >/dev/null 2>&1
QQ="$ROOT/runs/ci-intake-q"
python3 -c "
import json
p='$QQ/00a-intake/intake-proposal.json'; d=json.load(open(p))
for f in d['files']:
    if f.get('category')=='product_image': f['route']='evidence'   # 정본은 assets — 불일치 주입
json.dump(d,open(p,'w'),ensure_ascii=False)"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-q 00a-intake ) >/dev/null 2>&1
check "(q) category↔route 불일치 → validate-stage 00a 거부" "[ $? -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (r·외부리뷰 W4-R8) sanitize 충돌 reference zip → 접미사로 분리(덮어쓰기·유실 방지).
# ─────────────────────────────────────────────────────────────────────────────
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  echo "# (r) sanitize 충돌 reference zip 2개 → 둘 다 보존(접미사)"
  R="$SCRATCH/attach_r"; mk_fixture "$R"
  for pair in "brand a" "brand_a"; do
    ZS="$SCRATCH/zr_$RANDOM"; rm -rf "$ZS"; mkdir -p "$ZS"
    printf '{"name":"타사경쟁"}\n' > "$ZS/product.json"
    printf 'content,score,option\nx,5,y\n' > "$ZS/reviews.csv"
    ( cd "$ZS" && zip -q -r "$R/$pair.zip" . )
  done
  intake_run "$R" ci-intake-r
  RR="$ROOT/runs/ci-intake-r"
  drive_to_ingest ci-intake-r
  _NDIRS="$(find "$RR/00a-intake/routed/examples/cosmetic" -maxdepth 1 -type d ! -path "$RR/00a-intake/routed/examples/cosmetic" 2>/dev/null | wc -l | tr -d ' ')"
  check "(r) 충돌 zip 2개 → examples 하위 디렉터리 2개(덮어쓰기 아님)" "[ \"\$_NDIRS\" = '2' ]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (s·외부리뷰 W4-R9) evidence 확장자 화이트리스트 미러: evidence_* 로 분류된 화이트리스트-밖 확장자 → 승인 전 validate 거부.
# ─────────────────────────────────────────────────────────────────────────────
echo "# (s) evidence_* 화이트리스트-밖 확장자 → validate-stage 00a 거부"
mk_fixture "$SCRATCH/attach_s" unknown    # mystery.xyz 포함
intake_run "$SCRATCH/attach_s" ci-intake-s
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-s ) >/dev/null 2>&1
SS="$ROOT/runs/ci-intake-s"
# mystery.xyz 를 evidence_general(route:evidence)로 재분류(확장자 .xyz 는 화이트리스트 밖)
python3 -c "
import json
p='$SS/00a-intake/intake-proposal.json'; d=json.load(open(p))
for f in d['files']:
    if f['filename']=='mystery.xyz':
        f['category']='evidence_general'; f['route']='evidence'; f['kind']='general'
json.dump(d,open(p,'w'),ensure_ascii=False)"
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-s 00a-intake ) >/dev/null 2>&1
check "(s) evidence_* .xyz(화이트리스트 밖) → validate-stage 00a 거부(승인 전)" "[ $? -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (t·외부리뷰 W4-R10) product_image 확장자 미러: gif(자사 스캔 밖) → 승인 전 validate 거부(자사컷 유실 방지).
# ─────────────────────────────────────────────────────────────────────────────
echo "# (t) product_image gif(자사 스캔 밖) → validate-stage 00a 거부"
T="$SCRATCH/attach_t"; rm -rf "$T"; mkdir -p "$T"
printf 'DOCX\n' > "$T/wb.docx"
printf 'GIF89a-bytes\n' > "$T/product.gif"    # stub 이 product_image 로 분류하지만 gif 는 cmd_assets 스캔 밖
intake_run "$T" ci-intake-t
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-t ) >/dev/null 2>&1
( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash scripts/validate-stage.sh ci-intake-t 00a-intake ) >/dev/null 2>&1
check "(t) product_image gif → validate-stage 00a 거부(자사 스캔 밖·자사컷 유실 방지)" "[ $? -ne 0 ]"

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (u·A-DEF-1) 도메인 배관 회귀 가드: env(HARNESS_DOMAIN) 없이 state 선언만으로 발효·인입 완주.
#   결함(A-DEF-1): 첨부폴더 정문(intake)으로 시작한 런이 사람 승인 뒤 발효(apply-intake)+인입(ingest-bundle)
#   단계에서 HARNESS_DOMAIN 미설정으로 죽었다 — gate.sh 의 apply 훅이 도메인을 주입하지 않았고, ingest.py 는
#   모듈 로드 시점에 도메인을 요구했다. 수정: gate.sh 의 00a apply-intake 훅이 state 선언 도메인을 주입
#   (resolve_domain → export HARNESS_DOMAIN, ingest-bundle.sh 와 동형) + ingest.py 의 프로파일 지연 로드(_profile()).
#   기존 케이스들이 도메인 env 를 상시 export 해서(15행) 이 갭을 마스킹했다 — 이 케이스가 그 마스킹을 걷어낸다.
#   ⚠ 15행이 HARNESS_DOMAIN=cosmetic 을 전역 export 하므로, '발효를 트리거하는 kcia-check 호출만'
#     env -u HARNESS_DOMAIN 서브셸로 도메인을 벗겨 gate.sh 의 state-주입 배관을 실증한다(셋업 단계는 전역 env 유지).
echo "# (u) env 없이 state 선언만으로 발효·인입 완주(A-DEF-1 회귀 가드)"
mk_fixture "$SCRATCH/attach_ne" crawl        # 클린 자사 크롤(케이스 a 와 동일 셋업)
intake_run "$SCRATCH/attach_ne" ci-intake-noenv   # --domain 화장품 → state.product.regulatory_domain=cosmetic
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-noenv ) >/dev/null 2>&1   # 제안 생성, gate=user
( cd "$ROOT" && bash scripts/approve.sh ci-intake-noenv )          >/dev/null 2>&1   # gate=review
# 발효(apply-intake + ingest-bundle) 트리거 = kcia-check. 이 호출만 도메인 env 를 벗긴다 → gate.sh 가 state 에서 스스로 주입해야 완주.
( cd "$ROOT" && env -u HARNESS_DOMAIN bash scripts/kcia-check.sh ci-intake-noenv ) >/dev/null 2>&1; RC=$?
check "(u) env -u HARNESS_DOMAIN 로도 발효·인입 완주(rc=0 — gate.sh 가 state 도메인 주입)" "[ $RC -eq 0 ]"
check "(u) 라우팅 완료: phase 가 00a-intake 를 벗어남(클린 크롤 → 01-brief)" "[ \"\$(jq_phase ci-intake-noenv phase)\" = '01-brief' ]"
# apply-proposal 경로(gate.sh 의 00e-evidence 훅)도 00a apply-intake 훅과 '동일한' 한 줄
#   (HARNESS_DOMAIN=\$(resolve_domain \$SF); export HARNESS_DOMAIN)로 도메인을 주입한다 — 같은 A-DEF-1 수정이다.
#   따라서 위 apply-intake 양성이 그 배관을 대표 커버한다. 00e 반영 제안의 무-env 완주는 PNG 근거 자산 + run-stage
#   evidence 제안 생성이 필요해(가짜 PDF 는 추출 실패) 여기서 재현하기 과하며, test-b1e 가 00e 반영·해소를 별도로 다룬다.

# ─────────────────────────────────────────────────────────────────────────────
# W-2 (v·A-DEF-1) 음성: 규제도메인 완전 부재(state=null + env 없음) → cosmetic 조용 폴백이 아니라 fail-closed.
#   프로덕션 no-fallback 보장(2부 1단계: 미선언=fail-closed) 회귀 가드. fixture 조작으로 도메인 부재 상태를 만든다
#   (68~75행 sha256 변조 음성 케이스와 동일 패턴 — 테스트 조작이지 프로덕션 규칙 위반 아님).
echo "# (v) 도메인 완전 부재(state null + env 없음) → fail-closed(cosmetic 조용 폴백 금지)"
mk_fixture "$SCRATCH/attach_nd" crawl
intake_run "$SCRATCH/attach_nd" ci-intake-nodom
( cd "$ROOT" && bash scripts/run-stage.sh intake ci-intake-nodom ) >/dev/null 2>&1   # 정상 셋업(제안 존재)까지 진행
# fixture 조작: 사람이 선언한 도메인을 state 에서 제거(null) → '아무도 도메인을 선언 안 한' 상태 모사.
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-intake-nodom/state.json" product.regulatory_domain 'null' >/dev/null
# apply 경로를 env 없이 실행: state=null + env 없음 → ingest.py 가 도메인 필요 시점에 fail-closed(조용한 cosmetic 진행 금지).
VOUT="$( cd "$ROOT" && env -u HARNESS_DOMAIN HARNESS_ROOT="$ROOT" python3 scripts/lib/ingest.py apply-intake ci-intake-nodom 2>&1 )"; RC=$?
check "(v) 도메인 부재 + env 없음 → apply-intake fail-closed(rc≠0, cosmetic 조용 진행 아님)" "[ $RC -ne 0 ]"
check "(v) fail-closed 안내에 규제도메인 미선언 메시지(조용한 폴백이 아님을 사람이 확인)" "printf '%s' \"\$VOUT\" | grep -q '규제도메인'"

rm -rf "$ROOT"/runs/ci-intake-* "$ROOT/runs/한글런아이디" 2>/dev/null || true
echo "intake: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
