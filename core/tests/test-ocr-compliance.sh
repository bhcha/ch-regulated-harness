#!/usr/bin/env bash
# test-ocr-compliance.sh — F4 생성 이미지 픽셀 금지어(OCR) 좁은 점검 회귀.
#   image_ocr_scan.scan 을 직접 구동(가짜 tesseract·픽스처 매니페스트)해 3 시나리오를 hermetic 검증:
#     (1) 실엔진(nanobanana) 매니페스트 + PATH 의 가짜 tesseract → 금지어 위반 산출(axis/path/term).
#     (2) stub 매니페스트 → 스캔 건너뜀(위반 0 · verdict 불변).
#     (3) 실엔진 매니페스트인데 tesseract 부재 → fail-closed(비0 종료).
#   러너 자체 실엔진/네트워크 불요(가짜 tesseract 로 결정적) — runs/ 미오염(픽스처는 임시 디렉터리).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## F4 OCR 픽셀 금지어 점검 (test-ocr-compliance)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PYBIN="$(command -v python3)"
LIB="$ROOT/scripts/lib"

# 가짜 tesseract: --list-langs 엔 kor 포함해 응답(언어 preflight 통과), 그 외엔 금지어 2건을 '이미지에서
#   읽은 것처럼' 출력(공백 포함).
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/tesseract" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "--list-langs" ]; then
  printf '%s\n' 'List of available languages (3):' 'eng' 'kor' 'osd'; exit 0
fi
printf '%s\n' '여드름 치료' '국내 최초'
FAKE
chmod +x "$FAKEBIN/tesseract"

# 구동 드라이버: scan(rdir, axes) 결과를 JSON 한 줄로 출력. axes 는 금지 3계열만(NARROW).
DRIVER="$WORK/run_scan.py"
cat > "$DRIVER" <<PYEOF
import sys, json
sys.path.insert(0, "$LIB")
import image_ocr_scan
axes = {
    "drug_misperception": {"banned": ["여드름 치료"], "ref": "R-DM"},
    "consumer_deception": {"banned": ["최초(근거 없을 시)"], "ref": "R-CD"},
    "prescription_otc_distinction": {"banned": ["처방받으세요"], "ref": "R-POD"},
}
print(json.dumps(image_ocr_scan.scan(sys.argv[1], axes), ensure_ascii=False))
PYEOF

# 픽스처 run 디렉터리(임시): 선택안 HTML 이 생성 png 를 참조, 실재 png + 매니페스트 engine 지정.
mk_run() {  # mk_run <engine> -> stdout: run 디렉터리 절대경로
    local eng="$1"; local rd="$WORK/runs/$eng"
    rm -rf "$rd"; mkdir -p "$rd/04-keyvisual/options/A" "$rd/04-keyvisual/generated"
    printf '{"engine":"%s","assets":[]}\n' "$eng" > "$rd/04-keyvisual/image-manifest.json"
    printf '{"selected":"A"}\n' > "$rd/04-keyvisual/decision.json"
    printf '<html><body><img src="../../generated/01-hero.png" alt="x"></body></html>\n' \
        > "$rd/04-keyvisual/options/A/index.html"
    printf 'FAKEPNGBYTES' > "$rd/04-keyvisual/generated/01-hero.png"
    printf '%s' "$rd"
}

# (1) 실엔진 매니페스트 + 가짜 tesseract → 금지어 위반 산출.
RD_NB="$(mk_run nanobanana)"
OUT1="$(PATH="$FAKEBIN:$PATH" "$PYBIN" "$DRIVER" "$RD_NB" 2>/dev/null)"
echo "$OUT1" | grep -q '"axis": *"drug_misperception"' && pass "실엔진 OCR — drug_misperception 축 적발" || fail "drug_misperception 미적발 :: $OUT1"
echo "$OUT1" | grep -q '여드름 치료' && pass "실엔진 OCR — hit_term(여드름 치료)" || fail "hit_term 누락 :: $OUT1"
echo "$OUT1" | grep -q '04-keyvisual/generated/01-hero.png' && pass "실엔진 OCR — image_path(생성 png 런상대경로)" || fail "image_path 누락 :: $OUT1"
echo "$OUT1" | grep -q '"axis": *"consumer_deception"' && echo "$OUT1" | grep -q '"hit_term": *"최초"' \
    && pass "실엔진 OCR — consumer_deception core 토큰('('앞='최초')" || fail "consumer_deception core 미적발 :: $OUT1"
# prescription 금지어는 OCR 출력에 없으므로 미적발이어야(오탐 없음).
echo "$OUT1" | grep -q '처방받으세요' && fail "미노출 금지어 오탐(처방받으세요) :: $OUT1" || pass "미노출 금지어는 미적발(오탐 없음)"

# (2) stub 매니페스트 → 스캔 건너뜀(빈 결과).
RD_STUB="$(mk_run stub)"
OUT2="$(PATH="$FAKEBIN:$PATH" "$PYBIN" "$DRIVER" "$RD_STUB" 2>/dev/null)"
[ "$OUT2" = "[]" ] && pass "stub 매니페스트 → 스캔 건너뜀(위반 0)" || fail "stub 인데 스캔 실행됨 :: $OUT2"

# (3) 실엔진 매니페스트인데 tesseract 부재 → fail-closed(비0 종료).
EMPTYBIN="$WORK/emptybin"; mkdir -p "$EMPTYBIN"
if PATH="$EMPTYBIN" "$PYBIN" "$DRIVER" "$RD_NB" >/dev/null 2>&1; then
    fail "tesseract 부재인데 통과(fail-closed 아님)"
else
    pass "tesseract 부재 → fail-closed(비0 종료)"
fi

# (4) tesseract 는 있으나 kor 언어팩 부재 → fail-closed(한글 픽셀 금지어 조용한 통과 방지).
NOKORBIN="$WORK/nokorbin"; mkdir -p "$NOKORBIN"
cat > "$NOKORBIN/tesseract" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "--list-langs" ]; then
  printf '%s\n' 'List of available languages (2):' 'eng' 'osd'; exit 0
fi
printf '%s\n' '여드름 치료'
FAKE
chmod +x "$NOKORBIN/tesseract"
if PATH="$NOKORBIN" "$PYBIN" "$DRIVER" "$RD_NB" >/dev/null 2>&1; then
    fail "kor 언어팩 부재인데 통과(fail-closed 아님)"
else
    pass "kor 언어팩 부재 → fail-closed(비0 종료)"
fi

# (5) tesseract·kor 는 있으나 eng 언어팩 부재 → fail-closed(OCR 은 -l kor+eng 이므로 둘 다 필요).
NOENGBIN="$WORK/noengbin"; mkdir -p "$NOENGBIN"
cat > "$NOENGBIN/tesseract" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "--list-langs" ]; then
  printf '%s\n' 'List of available languages (2):' 'kor' 'osd'; exit 0
fi
printf '%s\n' '여드름 치료'
FAKE
chmod +x "$NOENGBIN/tesseract"
if PATH="$NOENGBIN" "$PYBIN" "$DRIVER" "$RD_NB" >/dev/null 2>&1; then
    fail "eng 언어팩 부재인데 통과(fail-closed 아님)"
else
    pass "eng 언어팩 부재 → fail-closed(비0 종료)"
fi

echo "TEST-OCR-COMPLIANCE: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
