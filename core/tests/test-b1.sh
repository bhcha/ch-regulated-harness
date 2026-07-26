#!/usr/bin/env bash
# test-b1.sh — B1 Ingest 심화 + claim-basis 추출 정확도 Exit 기준.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B1 — Ingest 심화 + claim-basis 추출 정확도"

RID=ci-b1
export HARNESS_CLI=claude HARNESS_OFFLINE=1
rm -rf "$ROOT/runs/$RID" "$ROOT/inputs/bundle"

# (a) 임의 폴더명 번들 정규화 — 폴더명을 바꿔도 동작
TMPB="$(mktemp -d)/weird_name_$$"
cp -R "$BUNDLE" "$TMPB"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$TMPB" "$RID" ) >/dev/null 2>&1
# per-run 계약: 크롤 번들(원시 입력)은 runs/<id>/inputs/bundle/ 로 정규화(00-ingest 는 가공물만).
check "(a) 임의 폴더명 번들 → run별 정규화(inputs/bundle)" "[ -f '$ROOT/runs/$RID/inputs/bundle/reviews.csv' ] && [ -f '$ROOT/runs/$RID/00-ingest/voc.json' ]"
rm -rf "$(dirname "$TMPB")"

# (a+) WB per-run 격리(가변 1:1 입력은 bundle 처럼 run 안으로 복사) + provenance 가 run 사본을 가리킴(run-id 미포함 → 결정적)
#   per-run 계약: WB 사본은 runs/<id>/inputs/working-backwards.md, provenance 는 run 루트 상대 = inputs/working-backwards.md.
check "(a+) WB run별 격리 사본 존재(inputs/working-backwards.md)" "[ -f '$ROOT/runs/$RID/inputs/working-backwards.md' ]"
WBFROM="$(python3 -c "import json;print(json.load(open('$ROOT/runs/$RID/00-ingest/claim-basis.json'))['source']['from'])")"
check "(a+) claim-basis provenance = run 사본 경로(inputs/working-backwards.md)" "[ \"\$WBFROM\" = 'inputs/working-backwards.md' ]"

# (b) VOC 실측 회귀 (BOM + RFC4180 고정 기대값)
KF="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'))['keyword_frequency'];print(d['커버'],d['기미'],d['촉촉'],d['밀착'],d['화사'],d['미백'],d['주름'],d['여드름'],d['EGF'],d['콜라겐'])")"
check "(b) VOC 회귀 6/0/5/4/3/0/0/0/0/0(bundle-cosmetic)" "[ \"$KF\" = '6 0 5 4 3 0 0 0 0 0' ]"
PS="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'))['persona_signals'];print(d['어머니'],d['엄마'],d['선물'])")"
check "(b) 페르소나 신호 어머니0/엄마1/선물3(bundle-cosmetic)" "[ \"$PS\" = '0 1 3' ]"
RD="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'))['rating_distribution'];print(d.get('5'),d.get('4'),d.get('3'))")"
check "(b) 평점 분포 5/4/3 = 11/7/None(bundle-cosmetic)" "[ \"$RD\" = '11 7 None' ]"

# (c)+(c+) claim-basis 추출 정확도: D11 골든 기대표 대비 누락·오추출 0건
ACC="$(python3 "$ROOT/scripts/lib/extract_accuracy.py" "$ROOT/runs/$RID/00-ingest/claim-basis.json" "$PACKS_DIR/cosmetic/golden/claim-basis-expected.json" 2>&1)"; RC_ACC=$?
check "(c+) claim-basis 추출 정확도: 누락·오추출 0건(골든 기대표)" "[ $RC_ACC -eq 0 ]"
OM="$(echo "$ACC" | python3 -c "import sys,json;print(json.load(sys.stdin)['omission_count'])" 2>/dev/null || echo X)"
FE="$(echo "$ACC" | python3 -c "import sys,json;print(json.load(sys.stdin)['false_count'])" 2>/dev/null || echo X)"
check "(c+) 누락=0" "[ \"$OM\" = '0' ]"
check "(c+) 오추출=0 (환각 1차 방어선)" "[ \"$FE\" = '0' ]"

# (c) 근거 없는 효능 = unknown / 빈 배열
check "(c) whitening/wrinkle unknown, uv approved" "[ \"\$(python3 -c \"import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/claim-basis.json'))['functional_status'];print(d['whitening']['status'],d['wrinkle']['status'],d['uv_protection']['status'])\")\" = 'unknown unknown approved' ]"

# (d) 브리프에서 근거 없는 효능이 unsupported 로 표기
( cd "$ROOT" && bash scripts/run-stage.sh brief "$RID" ) >/dev/null 2>&1
UNS="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/01-brief/brief.json'));print(any(s['label']=='미백' and s['status']=='unsupported' for s in d['sensitive_labels']))")"
check "(d) 브리프 sensitive_labels 에 미백=unsupported" "[ \"$UNS\" = 'True' ]"

# (f) 내부 FAQ 규제/실증 리스크 항목 강제 (schema minItems:2 + 내용)
FAQ="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/01-brief/brief.json'));print(len(d['faq']['internal']))")"
check "(f) 내부 FAQ 리스크 항목 ≥2" "[ \"$FAQ\" -ge 2 ]"

# (e)+(e+) 민감표시 확인 게이트 + RA 사후검수: 승인 전엔 기능성 승인 표시 주장 불가(fail-closed)
# M4: 심의는 승인 뒤. RA 미확인 승인은 그 전에(생성 직후 user 게이트) 막힌다.
OUT_NORA="$( ( cd "$ROOT" && bash scripts/approve.sh "$RID" ) 2>&1 )"; RC_NORA=$?
check "(e+) RA 미확인 시 브리프 승인 거부(기능성 approved 존재 → fail-closed)" "[ $RC_NORA -ne 0 ]"
check "(e+) 거부 메시지에 RA 사후검수 안내" "echo \"\$OUT_NORA\" | grep -q 'RA 사후검수'"
PH_BEFORE="$(jq_phase $RID phase)"
check "(e) 승인 전 페이즈 유지(주장 불가, 01-brief)" "[ \"$PH_BEFORE\" = '01-brief' ]"
# M4: 승인(--ra-ok) → 심의(kcia-check) 통과 → 02-concept 전진.
( cd "$ROOT" && bash scripts/approve.sh "$RID" --ra-ok && bash scripts/kcia-check.sh "$RID" ) >/dev/null 2>&1
check "(e+) RA 확인(--ra-ok)+심의 통과 후 전이 성공(02-concept)" "[ \"\$(jq_phase $RID phase)\" = '02-concept' ]"
check "(e+) 민감표시 확인 기록 생성(감사 추적)" "[ -f '$ROOT/runs/$RID/01-brief/sensitive-confirmation.json' ]"
RAFLAG="$(python3 -c "import json;print(json.load(open('$ROOT/runs/$RID/01-brief/sensitive-confirmation.json'))['ra_reviewed'])")"
check "(e+) 확인 기록에 ra_reviewed=true" "[ \"$RAFLAG\" = 'True' ]"

# (R1) ingest 2회 결정적 동일 (정량 동일)
rm -rf "$ROOT/runs/ci-det1" "$ROOT/runs/ci-det2"
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-det1 && bash scripts/ingest-bundle.sh "$BUNDLE" ci-det2 ) >/dev/null 2>&1
for art in voc.json claim-basis.json assets-manifest.json; do
  D1="$(python3 -c "import json;print(json.dumps(json.load(open('$ROOT/runs/ci-det1/00-ingest/$art')),sort_keys=True,ensure_ascii=False))")"
  D2="$(python3 -c "import json;print(json.dumps(json.load(open('$ROOT/runs/ci-det2/00-ingest/$art')),sort_keys=True,ensure_ascii=False))")"
  check "(R1) 결정적: $art 2회 동일" "[ \"\$D1\" = \"\$D2\" ]"
done

# (R3) 추출 정확도 N회 반복 통과 (결정적 추출 → 안정)
allok=1
for i in 1 2 3 4 5; do
  python3 "$ROOT/scripts/lib/extract_accuracy.py" "$ROOT/runs/ci-det1/00-ingest/claim-basis.json" "$PACKS_DIR/cosmetic/golden/claim-basis-expected.json" >/dev/null 2>&1 || allok=0
done
check "(R3) 추출 정확도 5회 반복 모두 통과" "[ $allok -eq 1 ]"

# (R2) ingest 중단→재개 idempotent: 이미 검증된 산출물 비재생성(mtime 불변)
mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }
M1="$(mt "$ROOT/runs/ci-det1/00-ingest/voc.json")"; sleep 1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-det1 ) >/dev/null 2>&1
M2="$(mt "$ROOT/runs/ci-det1/00-ingest/voc.json")"
check "(R2) ingest 재실행 시 voc.json 비재생성(mtime 불변)" "[ \"$M1\" = \"$M2\" ]"

unset HARNESS_CLI HARNESS_OFFLINE

# [외부리뷰 B1 수용] 추출 환각 안전성 — 적대적 입력 (fail-open 차단)
adv_func() { printf '%s' "$1" > /tmp/wb-adv-$$.md; python3 "$ROOT/scripts/lib/ingest.py" claim-basis /tmp/wb-adv-$$.md /tmp/cb-adv-$$.json >/dev/null 2>&1
  python3 -c "import json;d=json.load(open('/tmp/cb-adv-$$.json'));print(d['functional_status']['$2']['status'])"; }
adv_ev() { printf '%s' "$1" > /tmp/wb-adv-$$.md; python3 "$ROOT/scripts/lib/ingest.py" claim-basis /tmp/wb-adv-$$.md /tmp/cb-adv-$$.json >/dev/null 2>&1
  python3 -c "import json;print(len(json.load(open('/tmp/cb-adv-$$.json'))['evidence_on_file']))"; }
check "(adv#1) 동일문장 무관 라벨 누수 차단(미백 unknown)" "[ \"\$(adv_func '미백은 톤 표현으로만 사용, 자외선차단 기능성화장품으로 보고된 제품' whitening)\" = 'unknown' ]"
check "(adv#1) 같은 문장의 uv 는 정상 승인" "[ \"\$(adv_func '미백은 톤 표현으로만 사용, 자외선차단 기능성화장품으로 보고된 제품' uv_protection)\" = 'approved' ]"
check "(adv#2) '아니라' 부정 인식(주름 unknown)" "[ \"\$(adv_func '미백/주름은 기능성 심사·보고 대상이 아니라 일반 메이크업 표현으로만 사용' wrinkle)\" = 'unknown' ]"
check "(adv#3) 고시성분 누수 차단(미백 unknown)" "[ \"\$(adv_func '고시성분: 나이아신아마이드(미백 기능성화장품 고시 성분)' whitening)\" = 'unknown' ]"
check "(adv#4) '예정/계획' 시험은 evidence 0" "[ \"\$(adv_ev '미백 인체적용시험 예정입니다. 현재 미백 인체적용시험 계획 단계')\" = '0' ]"
check "(adv-pos) 정상 uv 승인 동작" "[ \"\$(adv_func '자외선차단 기능성화장품으로 식약처에 보고된 제품' uv_protection)\" = 'approved' ]"
check "(adv-pos) 정상 실증 보유는 evidence 1" "[ \"\$(adv_ev '미백 인체적용시험 결과 보유 n=30 완료')\" = '1' ]"
rm -f /tmp/wb-adv-$$.md /tmp/cb-adv-$$.json

# [외부리뷰 B1 수용] 승인 경로 RA 게이트 우회 불가 (fail-closed) + M4 중단-복구(심의 직전 중단 → kcia-check 재개)
# M4 에선 approve 가 한 atomic 전이(approved+user 중단 상태 없음) → 중단점은 'approve 후(gate=review) / kcia-check 전'.
rm -rf "$ROOT/runs/ci-healra"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-healra && bash scripts/run-stage.sh brief ci-healra ) >/dev/null 2>&1
# 기능성 '승인' 표시가 있는데 RA 확인기록(sensitive-confirmation) 없음 + --ra-ok 미지정 → 승인 거부(fail-closed).
rm -f "$ROOT/runs/ci-healra/01-brief/sensitive-confirmation.json"
OUT_HR="$( ( cd "$ROOT" && bash scripts/approve.sh ci-healra ) 2>&1 )"; RC_HR=$?
check "(adv#5) 기능성 승인 표시 → RA 미확인 시 승인 거부(fail-closed)" "[ $RC_HR -ne 0 ] && echo \"\$OUT_HR\" | grep -q 'RA 사후검수'"
# M4: --ra-ok 승인(→ gate=review) 후 심의 직전 중단을 모사 → 재개(kcia-check) → 통과 시 02-concept 전진.
( cd "$ROOT" && bash scripts/approve.sh ci-healra --ra-ok ) >/dev/null 2>&1
check "(adv#5·중단점) 승인 후 심의 대기(gate=review)에서 중단" "[ \"\$(jq_phase ci-healra gate)\" = 'review' ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-healra ) >/dev/null 2>&1
check "(adv#5) 중단된 승인(gate=review)에서 심의 통과 시 재개 성공(02-concept)" "[ \"\$(jq_phase ci-healra phase)\" = '02-concept' ]"

# [외부리뷰 B1 수용] 정확도 게이트가 거짓 승인/오추출을 잡는다 (가짜 claim-basis 주입)
python3 - <<'PYEOF'
import json
d=json.load(open('/tmp/cb-real.json')) if __import__('os').path.exists('/tmp/cb-real.json') else {}
PYEOF
python3 "$ROOT/scripts/lib/ingest.py" claim-basis "$PACKS_DIR/cosmetic/golden/working-backwards.md" /tmp/cb-good-$$.json >/dev/null 2>&1
python3 - "/tmp/cb-good-$$.json" "/tmp/cb-bad-$$.json" <<'PYEOF'
import json,sys
d=json.load(open(sys.argv[1]))
d["functional_status"]["whitening"]={"status":"approved","evidence_ref":None}  # 근거 없는 승인
d["certifications"]=["더마테스트"]                                              # 거짓 인증
json.dump(d,open(sys.argv[2],"w"),ensure_ascii=False)
PYEOF
python3 "$ROOT/scripts/lib/extract_accuracy.py" /tmp/cb-bad-$$.json "$PACKS_DIR/cosmetic/golden/claim-basis-expected.json" >/dev/null 2>&1; RC_BAD=$?
check "(adv-gate) 정확도 게이트가 거짓 승인+오추출을 탐지(실패)" "[ $RC_BAD -ne 0 ]"
rm -f /tmp/cb-good-$$.json /tmp/cb-bad-$$.json

# (WS3) offer.price · offer.discount (골든 번들 product.json 기준)
OFFER_PRICE="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'));print(d.get('offer',{}).get('price',''))")"
check "(WS3) offer.price == 32000(bundle-cosmetic)" "[ \"$OFFER_PRICE\" = '32000' ]"
OFFER_DISC="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'));print(d.get('offer',{}).get('discount',''))")"
check "(WS3) offer.discount == 20(bundle-cosmetic)" "[ \"$OFFER_DISC\" = '20' ]"

# (WS2) top_phrases 비어있지 않음(min_freq=3 이상 어휘 존재)
TP_NONEMPTY="$(python3 -c "import json;d=json.load(open('$ROOT/runs/$RID/00-ingest/voc.json'));print(bool(d.get('top_phrases')))")"
check "(WS2) top_phrases 비어있지 않음" "[ \"$TP_NONEMPTY\" = 'True' ]"

unset HARNESS_CLI HARNESS_OFFLINE
rm -rf "$ROOT"/runs/ci-* "$ROOT/inputs/bundle" 2>/dev/null; true
echo "B1: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
