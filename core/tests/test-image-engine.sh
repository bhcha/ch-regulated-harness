#!/usr/bin/env bash
# test-image-engine.sh — 이미지 실생성(Nano Banana) 어댑터 회귀 가드 (오프라인·무네트워크).
#   1) 키 없으면 resolve_image_engine=stub (삼중가드 회귀).
#   2) _reference_part: png→inlineData / svg·부재→None (순수, 네트워크 없음).
#   3) _build_body: text 파트 + 레퍼런스 유무 분기 + responseModalities (순수).
#   4) _parse_image: base64 픽스처→bytes / 안전차단 픽스처→예외 (순수, fail-closed).
#   5) (회귀) stub 경로 generate_all 2회 멱등 + 매니페스트 스키마 통과.
#   ⚠ 실호출(_call_nanobanana 네트워크 경로)은 절대 타지 않는다 — 라이브 실증(플랜 7단계, 실키)으로만 확인.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## 이미지 실생성(Nano Banana) 어댑터 — 오프라인 단위·회귀"

# 동시작업 충돌 방지: 고유 scratch run id(+PID). 키는 절대 설정하지 않는다(무네트워크 보장).
RID="ci-imgeng-$$"
# per-run 계약: 모든 원시 입력·생성물이 run_dir(rdir) 아래로 모인다. 레퍼런스 경계 = rdir/inputs/assets.
RDIR="$ROOT/runs/$RID"
SCRATCH="$RDIR/scratch"
# 자사자산 경계 안(run_dir/inputs/assets/) 임시 레퍼런스 픽스처. _reference_part 는 rdir/inputs/assets/ 안만
#   전송하므로 허용-경로 케이스는 반드시 여기에 둔다(고유 PID 접미로 동시작업 비충돌). cleanup 에서 제거.
mkdir -p "$RDIR/inputs/assets"
ASSET_FIX="$RDIR/inputs/assets/.ci-imgeng-$$.png"
unset NANOBANANA_API_KEY
# cleanup: run 디렉터리 전체(레퍼런스 픽스처·생성물 04-keyvisual/generated 포함)를 제거.
cleanup() { rm -rf "$RDIR"; }
trap cleanup EXIT

# ── 1) 이미지 엔진 해석 계약 (운영 기본=nanobanana, 무음 stub 강등 제거 — 사용자 요구) ──
#   offline→stub(CI/골든 결정성) · 명시 stub→stub · nanobanana(기본/명시)+온라인+키→nanobanana · 키 없으면 fail-closed(die, 무음 stub 아님).
#   (HARNESS_NO_DOTENV=1 은 lib.sh 가 설정 → 아래 unset/명시가 .env 키에 오염되지 않음.)
# (a) 키 없음 + nanobanana + 온라인 → fail-closed(비0 종료; stub 무음강등 금지)
#   온라인 단정: lib.sh 기본 HARNESS_OFFLINE=1 을 bash -c 안에서 unset 해 실제 온라인 경로를 탄다.
( cd "$ROOT" && HARNESS_IMAGE_CLI=nanobanana bash -c 'unset NANOBANANA_API_KEY HARNESS_OFFLINE; source scripts/lib/common.sh; resolve_image_engine' >/dev/null 2>&1 ); RC_NOKEY=$?
check "(가드1) 키 없음 + nanobanana + 온라인 → fail-closed(stub 무음강등 금지)" "[ $RC_NOKEY -ne 0 ]"
# (b) 키 있어도 OFFLINE=1 → stub (오프라인/CI 결정성)
ENG_OFFLINE="$( cd "$ROOT" && HARNESS_IMAGE_CLI=nanobanana NANOBANANA_API_KEY=dummy HARNESS_OFFLINE=1 bash -c 'source scripts/lib/common.sh; resolve_image_engine' 2>/dev/null )"
check "(가드1) 키 있어도 OFFLINE=1 → stub" "[ \"$ENG_OFFLINE\" = stub ]"
# (c) 명시 HARNESS_IMAGE_CLI=stub → stub
ENG_STUB="$( cd "$ROOT" && HARNESS_IMAGE_CLI=stub NANOBANANA_API_KEY=dummy bash -c 'source scripts/lib/common.sh; resolve_image_engine' 2>/dev/null )"
check "(가드1) 명시 stub → stub" "[ \"$ENG_STUB\" = stub ]"
# (d) 기본(엔진 미설정) + 키 + 온라인 → nanobanana (운영 기본=실엔진)
ENG_DEFAULT="$( cd "$ROOT" && NANOBANANA_API_KEY=dummy bash -c 'unset HARNESS_IMAGE_CLI HARNESS_OFFLINE; source scripts/lib/common.sh; resolve_image_engine' 2>/dev/null )"
check "(가드1) 엔진 미설정 + 키 + 온라인 → nanobanana(운영 기본)" "[ \"$ENG_DEFAULT\" = nanobanana ]"

# ── 2~4) 순수 함수 단위테스트 (Python, 네트워크 0회) ──
# 기본상수 단정은 오버라이드 env 가 없는 깨끗한 환경에서(호출자 env 로 인한 spurious fail 방지 — 외부리뷰 LOW).
mkdir -p "$SCRATCH"
PURE_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL -u HARNESS_IMAGE_TIMEOUT -u NANOBANANA_API_KEY \
  python3 - "$SCRATCH" "$ASSET_FIX" "$RDIR" <<'PY'
import sys, os, base64
scratch = sys.argv[1]
asset_fix = sys.argv[2]   # rdir/inputs/assets/ 안 허용 레퍼런스 픽스처(절대경로)
rdir = sys.argv[3]        # per-run 계약: 픽셀 레퍼런스 해석 기준(run_dir), ie.ROOT 아님
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie

errs = []
def ok(cond, label):
    if not cond:
        errs.append(label)

# 상수 정정(모델명·엔드포인트) — Gemini 2.5 Flash Image (오버라이드 env 미적용 깨끗한 기본값)
ok(ie._NB_MODEL == "gemini-2.5-flash-image", "model default != gemini-2.5-flash-image")
ok(ie._NB_MODEL in ie._NB_ENDPOINT and ie._NB_ENDPOINT.endswith(":generateContent"),
   "endpoint malformed")
ok(ie._NB_TIMEOUT == 120, "timeout default != 120")

# (1b) build_prompt 브랜드 주입(P-4) — 그래픽 분기에서만 실제 브랜드명 + 발명금지 문구, 사진형은 무변경.
BRAND = "이지덤"
gp = ie.build_prompt({"subject": "요약 카드"}, graphic=True, brand_name=BRAND)["prompt"]
ok(BRAND in gp, "graphic branch missing exact brand string")                         # 정확한 브랜드 문자열
ok("no fictional brand" in gp and "발명" in gp, "graphic branch missing brand clause")  # 발명금지 문구
# 사진형(graphic=False)은 브랜드 문구/이름을 추가하지 않는다(기존 계약 불변)
pp = ie.build_prompt({"subject": "제품컷"}, graphic=False, brand_name=BRAND)["prompt"]
ok(BRAND not in pp, "photo branch leaked brand name")
ok("no fictional brand" not in pp, "photo branch leaked brand clause")
# 그래픽인데 brand_name=None → 브랜드 문구 생략(무변경)
gn = ie.build_prompt({"subject": "요약 카드"}, graphic=True, brand_name=None)["prompt"]
ok("no fictional brand" not in gn, "graphic branch emitted brand clause without brand_name")
ok(BRAND not in gn, "graphic branch leaked brand name with brand_name=None")
# has_ref 그래픽 분기는 타 브랜드 발명 금지를 보존 지시와 함께 강화(참조 제품 있을 때)
gh = ie.build_prompt({"subject": "요약 카드",
                      "reference": {"pixel_reference_allowed": True, "own_asset_path": "inputs/assets/x.png"}},
                     graphic=True, brand_name=BRAND)["prompt"]
ok("no other brand" in gh, "graphic has_ref branch missing 'no other brand' strengthening")
# _read_brand_name — 부재 rdir → None(파일 없음, 그래픽 프롬프트에서 문구 생략)
ok(ie._read_brand_name(scratch) is None, "_read_brand_name missing product.json not None")

# (2) _reference_part — inputs/assets/ 안 png → inlineData(base64). 그 밖·svg·부재·None → None.
png_bytes = b"\x89PNG\r\n\x1a\nRASTERFIXTURE"
with open(asset_fix, "wb") as f:
    f.write(png_bytes)
png_rel = os.path.relpath(asset_fix, rdir)   # inputs/assets/.ci-imgeng-<pid>.png
rp = ie._reference_part(png_rel, rdir)
ok(rp is not None, "reference_part allowed png returned None")
if rp is not None:
    ok(rp.get("inlineData", {}).get("mimeType") == "image/png", "reference_part png mime")
    ok(base64.b64decode(rp["inlineData"]["data"]) == png_bytes, "reference_part png roundtrip")
# webp/jpg/jpeg — 실제 매직바이트 페이로드(확장자뿐 아니라 내용도 래스터여야 전송)
JPEG = b"\xff\xd8\xff" + b"\x00" * 12
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 4
for ext, mime, payload in ((".webp", "image/webp", WEBP), (".jpg", "image/jpeg", JPEG), (".jpeg", "image/jpeg", JPEG)):
    p = asset_fix + ext   # 여전히 inputs/assets/ 안(접미 확장)
    with open(p, "wb") as f:
        f.write(payload)
    try:
        rr = ie._reference_part(os.path.relpath(p, rdir), rdir)
        ok(rr is not None and rr["inlineData"]["mimeType"] == mime, "reference_part %s mime" % ext)
    finally:
        os.remove(p)
# 확장자위장(.png 인데 내용은 SVG/텍스트) → None (내용검증 — 외부리뷰 MEDIUM)
spoof = asset_fix + ".spoof.png"   # inputs/assets/ 안 + .png 확장 + 내용은 비래스터
with open(spoof, "wb") as f:
    f.write(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
ok(ie._reference_part(os.path.relpath(spoof, rdir), rdir) is None, "reference_part extension spoof leaked")
os.remove(spoof)
# svg(allowlist 안이어도) → None (벡터 제외)
svg_asset = asset_fix + ".svg"
with open(svg_asset, "w") as f:
    f.write("<svg/>")
ok(ie._reference_part(os.path.relpath(svg_asset, rdir), rdir) is None, "reference_part svg not None")
os.remove(svg_asset)
# 부재(inputs/assets/ 안이지만 없는 파일) → None
ok(ie._reference_part("inputs/assets/__nope__.png", rdir) is None, "reference_part missing not None")
# None/빈값/비문자 → None
ok(ie._reference_part(None, rdir) is None, "reference_part None not None")
ok(ie._reference_part("", rdir) is None, "reference_part empty not None")

# (2b) 경계 강제(fail-closed) — inputs/assets/ '밖' 래스터는 존재해도 절대 전송 안 함(None).
#   ★ 유효한 PNG 페이로드를 써서 '경계 검사' 단독으로 거부됨을 검증(내용검사로 가려지지 않게 — 외부리뷰 MEDIUM).
VALID_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 12
outside_png = os.path.join(scratch, "outside.png")
with open(outside_png, "wb") as f:
    f.write(VALID_PNG)
ok(ie._reference_part(os.path.relpath(outside_png, rdir), rdir) is None,
   "reference_part outside-allowlist raster leaked (runs/ scratch)")
# 절대경로(작업영역 밖) → None (유효 PNG 라도 경계 밖)
abs_outside = os.path.join(scratch, "abs.png")
with open(abs_outside, "wb") as f:
    f.write(VALID_PNG)
ok(ie._reference_part(abs_outside, rdir) is None, "reference_part absolute path leaked")
# ../ 탈출 시도(inputs/assets/../../etc 류) → None
ok(ie._reference_part("inputs/assets/../../escape.png", rdir) is None, "reference_part dotdot escape leaked")
# inputs/bundle/(크롤 원본) 래스터 경로 → None (자사자산 아님)
ok(ie._reference_part("inputs/bundle/images/crawled.png", rdir) is None, "reference_part crawl bundle leaked")

# (3) _build_body — text 파트 + responseModalities + 레퍼런스 유무 분기
body = ie._build_body({"prompt": "테스트 프롬프트", "aspect_ratio": "4:5"}, rdir)
parts = body.get("contents", [{}])[0].get("parts", [])
ok(len(parts) == 1, "build_body no-ref parts != 1")
ok("text" in parts[0] and parts[0]["text"].startswith("테스트 프롬프트"), "build_body text part")
ok("4:5" in parts[0]["text"], "build_body aspect hint missing")
ok(body.get("generationConfig", {}).get("responseModalities") == ["TEXT", "IMAGE"],
   "build_body responseModalities")
# with allowed raster reference → 2 parts, inlineData appended
body2 = ie._build_body({"prompt": "hi", "pixel_reference": png_rel}, rdir)
parts2 = body2["contents"][0]["parts"]
ok(len(parts2) == 2 and "inlineData" in parts2[1], "build_body with-ref not appended")
# with svg reference → still 1 part (svg excluded). 신규 svg 픽스처(앞서 제거된 svg_asset 재사용 금지).
svg_asset2 = asset_fix + ".body.svg"
with open(svg_asset2, "w") as f:
    f.write("<svg/>")
body3 = ie._build_body({"prompt": "hi", "pixel_reference": os.path.relpath(svg_asset2, rdir)}, rdir)
ok(len(body3["contents"][0]["parts"]) == 1, "build_body svg-ref leaked")
os.remove(svg_asset2)
# with outside-allowlist reference → still 1 part (경계 거부)
body4 = ie._build_body({"prompt": "hi", "pixel_reference": os.path.relpath(outside_png, rdir)}, rdir)
ok(len(body4["contents"][0]["parts"]) == 1, "build_body outside-ref leaked")
# empty/None prompt_obj → still well-formed
ie._build_body(None, rdir)
ie._build_body({}, rdir)

# (4) _parse_image — base64 → bytes (camel·snake) / 안전차단·비이미지 → 예외
#   구조 유효 PNG(매직+IHDR+IEND) 페이로드 — _parse_image 가 구조(_is_valid_png)를 검증한다(매직만 있는 잘린 PNG 거부).
raw = (b"\x89PNG\r\n\x1a\n"
       + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"        # IHDR 청크(len 13, 더미 CRC)
       + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"          # IDAT 청크(픽셀데이터, 더미 CRC)
       + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")                        # IEND 청크(len 0, 더미 CRC)
b64 = base64.b64encode(raw).decode()
camel = {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": b64}}]}}]}
ok(ie._parse_image(camel) == raw, "parse_image camelCase")
snake = {"candidates": [{"content": {"parts": [{"inline_data": {"data": b64}}]}}]}
ok(ie._parse_image(snake) == raw, "parse_image snake_case")
# 첫 inlineData만(텍스트 파트 선행 무시)
mixed = {"candidates": [{"content": {"parts": [{"text": "hi"}, {"inlineData": {"data": b64}}]}}]}
ok(ie._parse_image(mixed) == raw, "parse_image skips text part")
# 안전차단(blockReason) → RuntimeError + 사유 포함
try:
    ie._parse_image({"promptFeedback": {"blockReason": "SAFETY"},
                     "candidates": [{"finishReason": "SAFETY"}]})
    ok(False, "parse_image safety did not raise")
except RuntimeError as e:
    ok("SAFETY" in str(e), "parse_image safety reason missing")
# 이미지 없음(빈 candidates) → RuntimeError (빈 산출 금지)
try:
    ie._parse_image({"candidates": []})
    ok(False, "parse_image empty did not raise")
except RuntimeError:
    pass
# 잘못된 base64(검증 실패) → RuntimeError (부분/손상 산출 금지 — 외부리뷰 MEDIUM)
bad = {"candidates": [{"content": {"parts": [{"inlineData": {"data": "!!!not-base64!!!"}}]}}]}
try:
    ie._parse_image(bad)
    ok(False, "parse_image invalid base64 did not raise")
except RuntimeError:
    pass
# 빈 data("" → 빈 바이트) → RuntimeError (빈 산출 금지). b64('')='' 는 falsy → '이미지 없음'으로 fail-closed.
zero = {"candidates": [{"content": {"parts": [{"inlineData": {"data": base64.b64encode(b"").decode()}}]}}]}
try:
    ie._parse_image(zero)
    ok(False, "parse_image zero-byte did not raise")
except RuntimeError:
    pass
# 비이미지 junk(유효 b64이지만 매직 불일치) → RuntimeError (손상 산출 금지 — 외부리뷰 MEDIUM)
junk = {"candidates": [{"content": {"parts": [{"inlineData": {"data": base64.b64encode(b"NOT-AN-IMAGE-PAYLOAD").decode()}}]}}]}
try:
    ie._parse_image(junk)
    ok(False, "parse_image non-raster did not raise")
except RuntimeError:
    pass
# 매직만 있고 IHDR/IEND 구조가 없는 '잘린 PNG' → RuntimeError (구조검증 fail-closed — 외부리뷰 최종 MEDIUM)
truncpng = {"candidates": [{"content": {"parts": [{"inlineData": {"data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 12).decode()}}]}}]}
try:
    ie._parse_image(truncpng)
    ok(False, "parse_image magic-only truncated png did not raise")
except RuntimeError:
    pass
# 비정상 형태 응답(비-dict/비-list 노드) → AttributeError 가 아니라 통제된 RuntimeError(외부리뷰 LOW)
for bad_shape in (
    None, [], "string", 42,
    {"candidates": "not-a-list"},
    {"candidates": ["not-a-dict"]},
    {"candidates": [{"content": "not-a-dict"}]},
    {"candidates": [{"content": {"parts": "not-a-list"}}]},
    {"candidates": [{"content": {"parts": [{"inlineData": "not-a-dict"}]}}]},
    {"candidates": [{"content": {"parts": [{"inlineData": {"data": 123}}]}}]},  # data 비문자
    {"promptFeedback": "not-a-dict"},
):
    try:
        ie._parse_image(bad_shape)
        ok(False, "parse_image malformed shape did not raise: %r" % (bad_shape,))
    except RuntimeError:
        pass
    except Exception as e:
        ok(False, "parse_image malformed raised %s (not RuntimeError): %r" % (type(e).__name__, bad_shape))
# 응답 PNG 전용 — generate_all 이 .png 로 쓰므로 JPEG/WebP 응답은 거부(확장자-내용 일치 보증, 외부리뷰 MEDIUM)
jpg = b"\xff\xd8\xff" + b"\x00" * 12
jpg_resp = {"candidates": [{"content": {"parts": [{"inlineData": {"data": base64.b64encode(jpg).decode()}}]}}]}
try:
    ie._parse_image(jpg_resp)
    ok(False, "parse_image non-PNG response did not raise")
except RuntimeError:
    pass
# 매직 판정 헬퍼 — _is_png(PNG만 True) / _magic_mime(내용 MIME)
ok(ie._is_png(raw) and not ie._is_png(jpg), "_is_png png-only")
# 구조 검증 _is_valid_png — 완전한 PNG(IHDR+IEND) 통과 / 매직만·헤더절단 거부(외부리뷰 최종 MEDIUM)
ok(ie._is_valid_png(raw), "_is_valid_png accepts structural png")
ok(not ie._is_valid_png(b"\x89PNG\r\n\x1a\n" + b"\x00" * 12), "_is_valid_png rejects magic-only")
ok(not ie._is_valid_png(b"\x89PNG\r\n\x1a\n"), "_is_valid_png rejects bare magic")
# IDAT 없는 IHDR+IEND(비렌더) → 거부 / IEND 뒤 잡바이트 → 거부 (외부리뷰 최종 MEDIUM)
_ihdr = (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
_iend = (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00"
ok(not ie._is_valid_png(b"\x89PNG\r\n\x1a\n" + _ihdr + _iend), "_is_valid_png rejects no-IDAT")
ok(not ie._is_valid_png(raw + b"TRAILING"), "_is_valid_png rejects trailing bytes after IEND")
webp = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 4
ok(ie._magic_mime(raw) == "image/png", "_magic_mime png")
ok(ie._magic_mime(jpg) == "image/jpeg", "_magic_mime jpeg")
ok(ie._magic_mime(webp) == "image/webp", "_magic_mime webp")
ok(ie._magic_mime(b"NOT-AN-IMAGE") is None, "_magic_mime rejects junk")

# (4b) 키 마스킹(_redact_key) — raw·URL인코딩 키가 예외/로그에 절대 안 남는다(외부리뷰 HIGH).
import urllib.parse as _up
secret = "AIza-secret/with+special=chars"
echoed = "error referencing https://host/x?key=%s and raw %s" % (_up.quote(secret, safe=""), secret)
masked = ie._redact_key(echoed, secret)
ok(secret not in masked, "_redact_key leaked raw key")
ok(_up.quote(secret, safe="") not in masked, "_redact_key leaked urlencoded key")

# (방어) _call_nanobanana 키 부재 → RuntimeError (네트워크 진입 전 차단)
os.environ.pop("NANOBANANA_API_KEY", None)
os.environ.pop("HARNESS_OFFLINE", None)
try:
    ie._call_nanobanana({"prompt": "x"}, os.path.join(scratch, "out.png"), rdir)
    ok(False, "_call_nanobanana no-key did not raise")
except RuntimeError as e:
    # 키 부재 사유 + 키 문자열 미노출
    ok("NANOBANANA_API_KEY" in str(e), "_call_nanobanana no-key message")
# (방어) HARNESS_OFFLINE=1 이면 키가 있어도 네트워크 진입 금지(삼중가드 우회 직접호출 차단 — 외부리뷰 MEDIUM).
os.environ["NANOBANANA_API_KEY"] = "DUMMY-offline-guard"
os.environ["HARNESS_OFFLINE"] = "1"
try:
    ie._call_nanobanana({"prompt": "x"}, os.path.join(scratch, "off.png"), rdir)
    ok(False, "_call_nanobanana offline did not raise")
except RuntimeError as e:
    ok("HARNESS_OFFLINE" in str(e) and "DUMMY-offline-guard" not in str(e),
       "_call_nanobanana offline guard")
os.environ.pop("HARNESS_OFFLINE", None)
os.environ.pop("NANOBANANA_API_KEY", None)
# (4b+) 타임아웃 env 비정상이어도 import/stub 안 깨짐(폴백 양수) — _nb_timeout 견고성(외부리뷰 MEDIUM)
os.environ["HARNESS_IMAGE_TIMEOUT"] = "not-a-number"
ok(ie._nb_timeout() == 120, "_nb_timeout bad value fallback")
os.environ["HARNESS_IMAGE_TIMEOUT"] = "-5"
ok(ie._nb_timeout() == 120, "_nb_timeout nonpositive fallback")
os.environ["HARNESS_IMAGE_TIMEOUT"] = "45"
ok(ie._nb_timeout() == 45, "_nb_timeout valid override")
os.environ.pop("HARNESS_IMAGE_TIMEOUT", None)

# (4c) generate_all 엔진/경로 가드 — 알 수 없는 엔진·run_id 경로탈출 → 예외(fail-closed, 외부리뷰)
try:
    ie.generate_all("ci-imgeng-guard-$$", scratch, "bogus-engine")
    ok(False, "generate_all unknown engine did not raise")
except ValueError:
    pass
try:
    ie.generate_all("../escape", scratch, "stub")
    ok(False, "generate_all rid traversal did not raise")
except ValueError:
    pass

if errs:
    print("PYFAIL:" + "|".join(errs))
    sys.exit(1)
print("PYOK")
PY
)"
if echo "$PURE_OUT" | grep -q PYOK; then
  pass "(순수2-4) _reference_part·_build_body·_parse_image + 키부재 방어 — 전부 통과"
else
  # 실패 시 어떤 단정이 깨졌는지 PYFAIL 라벨을 그대로 노출한다(네트워크 0회 — 순수함수만).
  fail "(순수2-4) 순수함수 단위테스트 실패 :: ${PURE_OUT:-(출력 없음)}"
fi

# ── (4d) 비정상 모델명 키-비노출(외부리뷰 HIGH): _NB_MODEL 은 import-time 상수 → 별 프로세스로 검증.
#   더미키 + 제어문자 모델명. urllib InvalidURL 이 '키 포함 URL' 을 담더라도 키가 예외에 안 남아야 한다.
#   네트워크 0회 — 모델명 사전검증이 URL 구성 전에 차단하거나, 구성 예외도 마스킹되므로 호출이 전송에 못 감.
SECRET="DUMMYSECRET-do-not-leak-12345"
MODEL_OUT="$( cd "$ROOT" && NANOBANANA_API_KEY="$SECRET" HARNESS_NANOBANANA_MODEL="bad model" python3 - "$SCRATCH" "$RDIR" <<'PY' 2>&1
import sys, os
scratch = sys.argv[1]
rdir = sys.argv[2]        # per-run 계약: _call_nanobanana 시그니처의 run_dir 인자
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
try:
    ie._call_nanobanana({"prompt": "x"}, os.path.join(scratch, "_model.png"), rdir)
    print("NO_RAISE")
except Exception as e:
    print("RAISED:%s" % e)
PY
)"
# 반드시 예외(전송 안 함) + 키 문자열이 출력 어디에도 없어야 한다.
echo "$MODEL_OUT" | grep -q "RAISED:" && pass "(4d) 비정상 모델명 → 호출 차단(예외)" || fail "(4d) 비정상 모델명이 차단 안 됨: $MODEL_OUT"
if echo "$MODEL_OUT" | grep -q "$SECRET"; then
  fail "(4d) 키 유출! 예외/출력에 API 키가 노출됨"
else
  pass "(4d) 비정상 모델명 예외에 API 키 미노출(키-비노출 보증)"
fi

# ── (4e) 비정상 HARNESS_IMAGE_TIMEOUT 이어도 import/stub 가 안 깨진다(import-time 견고성 — 외부리뷰 MEDIUM).
IMPORT_OUT="$( cd "$ROOT" && HARNESS_IMAGE_TIMEOUT="garbage" python3 -c "import sys;sys.path.insert(0,'scripts/lib');import image_engine as ie;print('IMPORT_OK', ie._NB_TIMEOUT)" 2>&1 )"
echo "$IMPORT_OUT" | grep -q "IMPORT_OK 120" \
  && pass "(4e) 비정상 타임아웃 env 여도 import 정상 + 기본 120 폴백" \
  || fail "(4e) 비정상 타임아웃이 import 를 깨뜨림: $IMPORT_OUT"

# ── 5) (회귀) stub 경로 generate_all 2회 멱등 + 매니페스트 스키마 통과 ──
# fixtures/keyvisual-in(plan concept 13개)을 scratch run 으로 복사 → stub 엔진으로 2회.
rm -rf "$RDIR"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$RDIR"
# per-run 계약: 생성물은 런-로컬 04-keyvisual/generated/ (옛 공유 inputs/assets/generated/<id>/ 폐기).
GEN_DIR="$RDIR/04-keyvisual/generated"
rm -rf "$GEN_DIR"
MANIFEST="$RDIR/04-keyvisual/image-manifest.json"

run_stub() { ( cd "$ROOT" && python3 scripts/lib/image_engine.py "$RID" "$RDIR" --engine stub ) >/dev/null 2>&1; }
run_stub; RC1=$?
check "(회귀5) stub generate_all 1회 정상 종료" "[ $RC1 -eq 0 ]"
check "(회귀5) 매니페스트 생성" "[ -f \"$MANIFEST\" ]"
# 첫 실행 자산 status = fallback_stub(stub 경로), engine=stub
python3 -c "import json,sys;m=json.load(open('$MANIFEST'));sys.exit(0 if m.get('engine')=='stub' and m.get('assets') and all(a['status']=='fallback_stub' for a in m['assets']) else 1)" \
  && pass "(회귀5) 1회차 engine=stub · 모든 asset status=fallback_stub" \
  || fail "(회귀5) 1회차 매니페스트 status/engine 부정확"
# 매니페스트 스키마 통과(image-asset.schema.json)
if ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$MANIFEST" ) >/dev/null 2>&1; then
  pass "(회귀5) 매니페스트 image-asset.schema 통과"
else
  fail "(회귀5) 매니페스트 스키마 검증 실패"
fi
# 1회차 SVG 바이트 스냅샷(멱등 검증용). 해시는 stdlib hashlib(이식성 — shasum/sha1sum 비의존).
sha() { [ -f "$1" ] && python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }
FIRST_SVG="$(ls "$GEN_DIR"/*.svg 2>/dev/null | head -1)"
H1="$( sha "$FIRST_SVG" )"

# 2회차: 기존 파일 존재 → status=skipped (멱등), SVG 바이트 불변
run_stub; RC2=$?
check "(회귀5) stub generate_all 2회차 정상 종료(멱등)" "[ $RC2 -eq 0 ]"
python3 -c "import json,sys;m=json.load(open('$MANIFEST'));sys.exit(0 if m.get('assets') and all(a['status']=='skipped' for a in m['assets']) else 1)" \
  && pass "(회귀5) 2회차 모든 asset status=skipped (멱등)" \
  || fail "(회귀5) 2회차 멱등 실패(status!=skipped)"
H2="$( sha "$FIRST_SVG" )"
check "(회귀5) 재실행해도 SVG 바이트 불변(결정적·멱등)" "[ -n \"$H1\" ] && [ \"$H1\" = \"$H2\" ]"

# (회귀5b) 0바이트(중단된 부분파일)는 skipped 가 아니라 재생성된다(외부리뷰 MEDIUM — 부분파일 복구).
if [ -n "$FIRST_SVG" ]; then
  : > "$FIRST_SVG"   # 기존 산출물을 0바이트로 손상
  run_stub
  NB="$(python3 -c "import sys;print(len(open(sys.argv[1],'rb').read()))" "$FIRST_SVG" 2>/dev/null)"
  check "(회귀5b) 0바이트 부분파일은 재생성(skipped 아님, 크기>0)" "[ \"${NB:-0}\" -gt 0 ]"
  # (회귀5c) 비어있지 않지만 손상(SVG/XML 아닌 쓰레기) 기존 파일도 재생성(유효성 검사 — 외부리뷰 MEDIUM).
  printf 'CORRUPT-NOT-SVG' > "$FIRST_SVG"
  run_stub
  python3 -c "import sys;h=open(sys.argv[1],'rb').read().lstrip();sys.exit(0 if h.startswith(b'<svg') or h.startswith(b'<?xml') else 1)" "$FIRST_SVG" \
    && pass "(회귀5c) 손상(비-SVG) 기존 파일도 재생성(유효 SVG 로 복구)" \
    || fail "(회귀5c) 손상 파일이 skipped 처리됨(유효성 검사 누락)"
else
  fail "(회귀5b) 부분파일 케이스 준비 실패(SVG 없음)"
fi

# ── 6) (P-1) 이미지 부분실패 내성: 429 백오프 + 자동 강등 + 증분 매니페스트 ──
#    무네트워크: (6a/6b) _call_nanobanana monkeypatch · (6d) urlopen monkeypatch. 실호출 0회.
P1DIR="$ROOT/runs/ci-imgeng-p1-$$"
trap 'cleanup; rm -rf "$P1DIR"' EXIT   # section-5 trap(cleanup=RDIR) 확장
rm -rf "$P1DIR"; mkdir -p "$P1DIR"

# (6a) 부분실패(429 소진·강등 비활성) → 증분 매니페스트에 성공분 k개 + incomplete:true + 스키마 통과.
P6A="$P1DIR/run-a"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$P6A"
A_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL HARNESS_NANOBANANA_FALLBACK_MODEL="" python3 - "$P6A" <<'PY' 2>&1
import sys, os
rdir = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
from harness import load_json
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
errs = []
def ok(c, l):
    if not c: errs.append(l)
K = 3                     # 3블록 성공 후 4번째에서 429 소진 마커
CALLS = {"n": 0}
def fake_call(prompt, out, rdir, model=None):   # 3-/4-인자 모두 수용(강등 재시도 대비)
    if CALLS["n"] >= K:
        raise ie.NanoBananaQuotaExhausted("test 429 exhausted")
    ie._atomic_write_bytes(out, VALID_PNG)
    CALLS["n"] += 1
ie._call_nanobanana = fake_call
raised = False
try:
    ie.generate_all("ci-imgeng-p1", rdir, "nanobanana")   # 강등 비활성(env="") → 4번째 블록에서 fail-closed
except RuntimeError as e:
    raised = True
    ok("429" in str(e) or "쿼터" in str(e), "fail-closed message not about quota: %s" % e)
ok(raised, "generate_all did not fail-closed on exhausted 429 (fallback disabled)")
mf = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
ok(os.path.isfile(mf), "incremental manifest not persisted on failure")
m = load_json(mf)
ok(len(m.get("assets", [])) == K, "incremental manifest asset count != %d: %d" % (K, len(m.get("assets", []))))
ok(m.get("incomplete") is True, "incremental manifest missing incomplete:true: %r" % m.get("incomplete"))
ok(m.get("engine") == "nanobanana", "incremental manifest engine != nanobanana")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$A_OUT" | grep -q PYOK \
  && pass "(6a) 부분실패 → 증분 매니페스트 k개 자산 + incomplete:true 저장" \
  || fail "(6a) 부분실패 증분 매니페스트 실패 :: $A_OUT"
# (6a-schema) 위 증분(incomplete:true) 매니페스트가 image-asset.schema 를 통과해야 한다(additive optional incomplete).
if ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$P6A/04-keyvisual/image-manifest.json" ) >/dev/null 2>&1; then
  pass "(6a) 증분 매니페스트(incomplete:true) image-asset.schema 통과"
else
  fail "(6a) 증분 매니페스트가 스키마 검증 실패(incomplete additive 누락?)"
fi

# (6b) 완주(전 블록 성공) → 최종 매니페스트에 incomplete 없음 + 전 자산 + model 기록.
P6B="$P1DIR/run-b"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$P6B"
B_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL python3 - "$P6B" <<'PY' 2>&1
import sys, os
rdir = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
from harness import load_json
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
errs = []
def ok(c, l):
    if not c: errs.append(l)
def fake_call(prompt, out, rdir, model=None):
    ie._atomic_write_bytes(out, VALID_PNG)
ie._call_nanobanana = fake_call
m = ie.generate_all("ci-imgeng-p1b", rdir, "nanobanana")
ok("incomplete" not in m, "final manifest still carries incomplete key")
ok(len(m.get("assets", [])) == 13, "final manifest asset count != 13: %d" % len(m.get("assets", [])))
ok(m.get("model") == "gemini-2.5-flash-image", "final manifest model not recorded: %r" % m.get("model"))
# 디스크의 최종본도 incomplete 없음(증분 후 최종본이 덮었는지)
disk = load_json(os.path.join(rdir, "04-keyvisual", "image-manifest.json"))
ok("incomplete" not in disk, "on-disk final manifest still carries incomplete")
# 최종 키순서(engine·assets·model) = 기존 완전성공 삽입순서(골든 형상 보존)
ok(list(disk.keys()) == ["engine", "assets", "model"], "final manifest key order changed: %r" % list(disk.keys()))
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$B_OUT" | grep -q PYOK \
  && pass "(6b) 완주 → 최종 매니페스트 incomplete 부재 + 전 자산 + model + 키순서 불변" \
  || fail "(6b) 완주 최종 매니페스트 실패 :: $B_OUT"

# (6c) image_manifest_complete: 완전 nanobanana → 성공(0) / incomplete·stub → 실패(비0).
mkdir -p "$P1DIR/mc-complete/04-keyvisual" "$P1DIR/mc-incomplete/04-keyvisual" "$P1DIR/mc-stub/04-keyvisual"
printf '%s' '{"engine":"nanobanana","assets":[],"model":"gemini-2.5-flash-image"}' > "$P1DIR/mc-complete/04-keyvisual/image-manifest.json"
printf '%s' '{"engine":"nanobanana","model":"gemini-2.5-flash-image","incomplete":true,"assets":[]}' > "$P1DIR/mc-incomplete/04-keyvisual/image-manifest.json"
printf '%s' '{"engine":"stub","assets":[]}' > "$P1DIR/mc-stub/04-keyvisual/image-manifest.json"
mc_check() { ( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash -c 'source scripts/lib/common.sh >/dev/null 2>&1; image_manifest_complete "$1"' _ "$1" ) >/dev/null 2>&1; }
mc_check "$P1DIR/mc-complete";   MC_C=$?
mc_check "$P1DIR/mc-incomplete"; MC_I=$?
mc_check "$P1DIR/mc-stub";       MC_S=$?
mc_check "$P1DIR/mc-absent";     MC_A=$?
check "(6c) image_manifest_complete: 완전 nanobanana → 성공(0)" "[ $MC_C -eq 0 ]"
check "(6c) image_manifest_complete: incomplete:true → 실패(비0)" "[ $MC_I -ne 0 ]"
check "(6c) image_manifest_complete: stub → 실패(비0)" "[ $MC_S -ne 0 ]"
check "(6c) image_manifest_complete: 부재 → 실패(비0)" "[ $MC_A -ne 0 ]"

# (6c-2) image_manifest_incomplete(외부리뷰 W1c c fail-closed): 실엔진 incomplete:true 만 성공(0) — 완전·stub·부재는 실패(비0).
#   run-stage 가 이걸로 미완결 이미지를 fail-closed 하고 validate·advance 로 새지 않게 막는다.
mi_check() { ( cd "$ROOT" && HARNESS_ROOT="$ROOT" bash -c 'source scripts/lib/common.sh >/dev/null 2>&1; image_manifest_incomplete "$1"' _ "$1" ) >/dev/null 2>&1; }
mi_check "$P1DIR/mc-incomplete"; MI_I=$?
mi_check "$P1DIR/mc-complete";   MI_C=$?
mi_check "$P1DIR/mc-stub";       MI_S=$?
mi_check "$P1DIR/mc-absent";     MI_A=$?
check "(6c-2) image_manifest_incomplete: 실엔진 incomplete:true → 성공(0)" "[ $MI_I -eq 0 ]"
check "(6c-2) image_manifest_incomplete: 완전 → 실패(비0)" "[ $MI_C -ne 0 ]"
check "(6c-2) image_manifest_incomplete: stub → 실패(비0, 오프라인 골든 불변)" "[ $MI_S -ne 0 ]"
check "(6c-2) image_manifest_incomplete: 부재 → 실패(비0)" "[ $MI_A -ne 0 ]"

# (6d) 429 지수 백오프 — urlopen 을 monkeypatch(무네트워크·무수면 backoff=0).
#   part1: 429 두 번 뒤 성공 → 모델 전환 없이 성공(직접 _call_nanobanana).
#   part2: 기본모델 429 소진 → fallback 모델로 강등, fallback 모델명이 per-call 엔드포인트에 등장.
D1_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL NANOBANANA_API_KEY=dummy HARNESS_NANOBANANA_BACKOFF="0" python3 - "$P1DIR/d1.png" <<'PY' 2>&1
import sys, os
outp = sys.argv[1]
os.environ.pop("HARNESS_OFFLINE", None)   # 온라인 경로(monkeypatch 로 무네트워크)
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
import json, base64
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
RESP = json.dumps({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(VALID_PNG).decode()}}]}}]}).encode()
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return RESP
errs = []
def ok(c, l):
    if not c: errs.append(l)
CALLS = {"n": 0}; URLS = []
def fake_urlopen(req, timeout=None):
    URLS.append(req.full_url); CALLS["n"] += 1
    if CALLS["n"] <= 2:
        raise ie.urllib.error.HTTPError(req.full_url, 429, "quota", {}, None)
    return FakeResp()
ie.urllib.request.urlopen = fake_urlopen
ie._call_nanobanana({"prompt": "x", "aspect_ratio": "1:1"}, outp, os.path.dirname(outp))
ok(CALLS["n"] == 3, "429 backoff retry count != 3: %d" % CALLS["n"])
ok(os.path.isfile(outp) and ie._is_valid_png(open(outp, "rb").read()), "429 backoff did not write valid png")
ok(all(ie._NB_MODEL in u for u in URLS), "429 backoff switched model (direct call must not): %r" % URLS)
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$D1_OUT" | grep -q PYOK \
  && pass "(6d-1) 429 두 번 뒤 성공 → 백오프 재시도 성공(모델 전환 없음)" \
  || fail "(6d-1) 429 백오프 재시도 실패 :: $D1_OUT"

P6D="$P1DIR/run-d"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$P6D"
D2_OUT="$( cd "$ROOT" && NANOBANANA_API_KEY=dummy HARNESS_NANOBANANA_MODEL=gemini-3-pro-image HARNESS_NANOBANANA_FALLBACK_MODEL=gemini-2.5-flash-image HARNESS_NANOBANANA_BACKOFF="0" HARNESS_NANOBANANA_RETRY_429="1" python3 - "$P6D" <<'PY' 2>&1
import sys, os, io, contextlib
rdir = sys.argv[1]
os.environ.pop("HARNESS_OFFLINE", None)
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
import json, base64
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
RESP = json.dumps({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(VALID_PNG).decode()}}]}}]}).encode()
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return RESP
errs = []
def ok(c, l):
    if not c: errs.append(l)
PRO = "gemini-3-pro-image"; FB = "gemini-2.5-flash-image"
URLS = []
def fake_urlopen(req, timeout=None):
    URLS.append(req.full_url)
    if FB in req.full_url:      # fallback 모델 → 성공
        return FakeResp()
    raise ie.urllib.error.HTTPError(req.full_url, 429, "quota", {}, None)   # 기본(Pro) → 429
ie.urllib.request.urlopen = fake_urlopen
ok(ie._NB_MODEL == PRO, "NB_MODEL not Pro: %r" % ie._NB_MODEL)
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    m = ie.generate_all("ci-imgeng-p1d", rdir, "nanobanana")
serr = buf.getvalue()
ok(any(PRO in u for u in URLS), "Pro endpoint never called: %r" % URLS)
ok(any(FB in u for u in URLS), "fallback endpoint never appeared in per-call URL")
ok("downgrading to %s" % FB in serr, "downgrade audit line missing on stderr: %r" % serr)
ok("incomplete" not in m, "manifest carries incomplete after successful downgrade")
ok(len(m.get("assets", [])) == 13, "downgraded run asset count != 13: %d" % len(m.get("assets", [])))
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$D2_OUT" | grep -q PYOK \
  && pass "(6d-2) 429 소진 → 모델 자동 강등, fallback 모델명이 per-call 엔드포인트에 등장 + 감사 로그" \
  || fail "(6d-2) 자동 강등/엔드포인트 실패 :: $D2_OUT"

# ── (6e) F2: 400(INVALID_ARGUMENT) 모델-특유 거부 → 429 와 동일 강등 다이얼(무네트워크 monkeypatch) ──
# (6e-1) Pro 400 → fallback 모델로 자동 강등 완주 + 400 감사 로그 + 매니페스트 완결.
P6E="$P1DIR/run-e"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$P6E"
E1_OUT="$( cd "$ROOT" && NANOBANANA_API_KEY=dummy HARNESS_NANOBANANA_MODEL=gemini-3-pro-image HARNESS_NANOBANANA_FALLBACK_MODEL=gemini-2.5-flash-image python3 - "$P6E" <<'PY' 2>&1
import sys, os, io, contextlib
rdir = sys.argv[1]
os.environ.pop("HARNESS_OFFLINE", None)
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
import json, base64
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
RESP = json.dumps({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(VALID_PNG).decode()}}]}}]}).encode()
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return RESP
errs = []
def ok(c, l):
    if not c: errs.append(l)
PRO = "gemini-3-pro-image"; FB = "gemini-2.5-flash-image"
URLS = []
def fake_urlopen(req, timeout=None):
    URLS.append(req.full_url)
    if FB in req.full_url:      # fallback 모델 → 성공
        return FakeResp()
    # 기본(Pro) → 400(모델-특유 거부). body 는 읽히므로 fp 로 BytesIO 제공(키 미포함).
    raise ie.urllib.error.HTTPError(req.full_url, 400, "INVALID_ARGUMENT", {}, io.BytesIO(b'{"error":"invalid argument"}'))
ie.urllib.request.urlopen = fake_urlopen
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    m = ie.generate_all("ci-imgeng-p1e", rdir, "nanobanana")
serr = buf.getvalue()
ok(any(PRO in u for u in URLS), "Pro endpoint never called: %r" % URLS)
ok(any(FB in u for u in URLS), "fallback endpoint never appeared after 400")
ok("400 model-rejected on %s" % PRO in serr, "400 downgrade audit line missing: %r" % serr)
ok("downgrading to %s" % FB in serr, "downgrade target missing in 400 audit: %r" % serr)
ok("incomplete" not in m, "manifest carries incomplete after successful 400 downgrade")
ok(len(m.get("assets", [])) == 13, "400-downgraded run asset count != 13: %d" % len(m.get("assets", [])))
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$E1_OUT" | grep -q PYOK \
  && pass "(6e-1) 400 모델 거부 → fallback 자동 강등 완주 + 400 감사 로그" \
  || fail "(6e-1) 400 강등 실패 :: $E1_OUT"

# (6e-2) Pro·fallback 모두 400 → 진짜 요청 버그로 보고 fail-closed + 증분 매니페스트 incomplete.
P6F="$P1DIR/run-f"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$P6F"
E2_OUT="$( cd "$ROOT" && NANOBANANA_API_KEY=dummy HARNESS_NANOBANANA_MODEL=gemini-3-pro-image HARNESS_NANOBANANA_FALLBACK_MODEL=gemini-2.5-flash-image python3 - "$P6F" <<'PY' 2>&1
import sys, os, io
rdir = sys.argv[1]
os.environ.pop("HARNESS_OFFLINE", None)
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
from harness import load_json
def fake_urlopen(req, timeout=None):   # 모든 모델(Pro·fallback) 400 → 강등해도 400 → fail-closed
    raise ie.urllib.error.HTTPError(req.full_url, 400, "INVALID_ARGUMENT", {}, io.BytesIO(b'{"error":"invalid argument"}'))
ie.urllib.request.urlopen = fake_urlopen
errs = []
def ok(c, l):
    if not c: errs.append(l)
raised = False
try:
    ie.generate_all("ci-imgeng-p1f", rdir, "nanobanana")
except RuntimeError as e:
    raised = True
    ok("400" in str(e), "fail-closed message not about 400: %s" % e)
ok(raised, "generate_all did not fail-closed when both models 400")
mf = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
ok(os.path.isfile(mf), "incremental manifest not persisted on 400 fail-closed")
m = load_json(mf)
ok(m.get("incomplete") is True, "manifest missing incomplete:true on 400 fail-closed: %r" % m.get("incomplete"))
ok(m.get("engine") == "nanobanana", "manifest engine != nanobanana on 400 fail-closed")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$E2_OUT" | grep -q PYOK \
  && pass "(6e-2) Pro·fallback 모두 400 → fail-closed + incomplete 매니페스트" \
  || fail "(6e-2) 400 fail-closed 실패 :: $E2_OUT"

rm -rf "$P1DIR"

# ── 7) (F3) aspect 규격화(_normalize_png_aspect) — 패드(레터박스), 크롭 0, 결정적(무네트워크·Pillow) ──
F3DIR="$ROOT/runs/ci-imgeng-f3-$$"; rm -rf "$F3DIR"; mkdir -p "$F3DIR"
F3_OUT="$( cd "$ROOT" && python3 - "$F3DIR" <<'PY' 2>&1
import sys, os
base = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
errs = []
def ok(c, l):
    if not c: errs.append(l)
# _parse_aspect 순수 파서(Pillow 무관)
ok(abs(ie._parse_aspect("16:9") - 16/9) < 1e-6, "_parse_aspect 16:9")
ok(ie._parse_aspect("1:1") == 1.0, "_parse_aspect 1:1")
ok(ie._parse_aspect("bad") is None and ie._parse_aspect(None) is None and ie._parse_aspect("0:5") is None, "_parse_aspect invalid")
try:
    from PIL import Image
except Exception:
    print("SKIP_NO_PILLOW" if not errs else "PYFAIL:" + "|".join(errs)); sys.exit(0)
def mk(path, w, h, color=(10, 20, 30)):
    Image.new("RGB", (w, h), color).save(path, "PNG")
def dims(path):
    with Image.open(path) as im:
        return im.size
# (7a) 세로(0.81) → 16:9 목표 → 가로 패드(폭↑, 높이 불변) = 크롭 0
p = os.path.join(base, "portrait.png"); mk(p, 928, 1152); b = dims(p)
ie._normalize_png_aspect(p, "16:9"); w, h = dims(p)
ok(h == b[1], "(7a) height changed=crop %r->%r" % (b, (w, h)))
ok(w >= b[0], "(7a) width shrank=crop %r->%r" % (b, (w, h)))
ok(abs((w / h) - 16/9) <= 0.02 * (16/9), "(7a) not 16:9: %dx%d" % (w, h))
ok(ie._is_valid_png(open(p, "rb").read()), "(7a) output not valid png")
# (7b) 와이드(1.79) → 4:3 목표 → 세로 패드(높이↑, 폭 불변)
p2 = os.path.join(base, "wide.png"); mk(p2, 1376, 768); b2 = dims(p2)
ie._normalize_png_aspect(p2, "4:3"); w2, h2 = dims(p2)
ok(w2 == b2[0], "(7b) width changed=crop %r->%r" % (b2, (w2, h2)))
ok(h2 >= b2[1], "(7b) height shrank=crop %r->%r" % (b2, (w2, h2)))
ok(abs((w2 / h2) - 4/3) <= 0.02 * (4/3), "(7b) not 4:3: %dx%d" % (w2, h2))
# (7c) 이미 목표 근사(1:1) → no-op(바이트 불변)
p3 = os.path.join(base, "square.png"); mk(p3, 500, 500); mt0 = open(p3, "rb").read()
ie._normalize_png_aspect(p3, "1:1")
ok(open(p3, "rb").read() == mt0, "(7c) square 1:1 rewritten (should be no-op)")
# (7d) 미파싱 aspect → no-op(안전)
p4 = os.path.join(base, "keep.png"); mk(p4, 300, 200); k0 = open(p4, "rb").read()
ie._normalize_png_aspect(p4, None); ie._normalize_png_aspect(p4, "garbage")
ok(open(p4, "rb").read() == k0, "(7d) unparseable aspect rewrote file")
# (7e) 극단 aspect(DoS 방지 clamp) → 규격화 생략(no-op·바이트 불변, 거대 캔버스 미할당)
p5 = os.path.join(base, "extreme.png"); mk(p5, 400, 400); e0 = open(p5, "rb").read()
ie._normalize_png_aspect(p5, "100000:1"); ie._normalize_png_aspect(p5, "1:100000")
ok(open(p5, "rb").read() == e0, "(7e) extreme aspect rewrote/allocated (should be no-op)")
ok(ie._parse_aspect("100000:1") is None and ie._parse_aspect("1:50") is None, "(7e) _parse_aspect extreme not None")
ok(ie._parse_aspect("2:1") == 2.0 and abs(ie._parse_aspect("9:16") - 9/16) < 1e-9, "(7e) _parse_aspect in-range OK")
# (7f) 투명(RGBA) PNG 알파 보존 — 투명 픽셀이 bg(크림)로 합성되고 검은 halo 안 생김(convert RGB 로 알파 버리던 버그 차단)
pa = os.path.join(base, "alpha.png")
Image.new("RGBA", (800, 400), (0, 0, 0, 0)).save(pa, "PNG")   # 전면 투명(저장 RGB=검정) 와이드
ie._normalize_png_aspect(pa, "1:1")   # 2.0→1:1: 세로 패드 → 이미지 영역 y[200,600]
out = Image.open(pa).convert("RGB"); w6, h6 = out.size
ok(abs((w6 / h6) - 1.0) <= 0.02, "(7f) alpha img not normalized to 1:1: %dx%d" % (w6, h6))
cx = out.getpixel((400, 300))   # 이미지 영역 안(원래 투명 픽셀) — 알파 보존이면 bg 크림, 버그면 검정 halo
ok(cx[0] > 200 and cx[1] > 200 and cx[2] > 200 and cx != (0, 0, 0), "(7f) transparent pixel baked dark (alpha dropped): %r" % (cx,))
# (7g) O-8: 목표와 '크게' 어긋난 세로 픽스처(0.25) → 16:9 목표 → 가로 패드가 '실제로 대폭' 수행됨(no-op 아님) 단정.
#   400x1600(ratio 0.25) → 16:9(1.778): 높이 고정 시 폭 400→~2844(7배). 폭 대폭↑ + 크롭 0(높이 불변) + 비율 일치.
p7 = os.path.join(base, "tall.png"); mk(p7, 400, 1600); b7 = dims(p7)
ie._normalize_png_aspect(p7, "16:9"); w7, h7 = dims(p7)
ok(h7 == b7[1], "(7g) height changed=crop %r->%r" % (b7, (w7, h7)))
ok(w7 > 3 * b7[0], "(7g) width not substantially padded (규격화 no-op?): %r->%r" % (b7, (w7, h7)))
ok(abs((w7 / h7) - 16/9) <= 0.02 * (16/9), "(7g) not 16:9: %dx%d" % (w7, h7))
ok(ie._is_valid_png(open(p7, "rb").read()), "(7g) output not valid png")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
if echo "$F3_OUT" | grep -q SKIP_NO_PILLOW; then
  pass "(7) F3 규격화 — Pillow 미설치 스킵(_parse_aspect 순수부는 통과, no-op 폴백 회귀 안전)"
elif echo "$F3_OUT" | grep -q PYOK; then
  pass "(7) F3 aspect 규격화: 패드(크롭 0)·비율 일치·no-op·미파싱 안전 — 전부 통과"
else
  fail "(7) F3 규격화 실패 :: $F3_OUT"
fi
rm -rf "$F3DIR"

# ── 8) (F1(C)) _block_emits_image 도메인 게이팅 — 규제도메인 그래픽 미생성·화장품/미선언 생성(순수·무네트워크) ──
F1_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL python3 - <<'PY' 2>&1
import sys, os
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
errs = []
def ok(c, l):
    if not c: errs.append(l)
MODEL = "gemini-3-pro-image"   # 실엔진(온라인) 모델명(non-None discriminator)
GRAPHIC = {"type": "rtbSummary", "visual": {"render_mode": "html_only"}}
PHOTO = {"type": "hero", "visual": {"kind": "photo"}}
CHART = {"type": "clinicalEvidence", "visual": {"chart_data": {"series": [1, 2]}}}
# 규제도메인: 그래픽 블록 미생성(온라인 모델이라도 False)
for d in ("drug", "quasi_drug", "health_food"):
    ok(ie._block_emits_image(GRAPHIC, MODEL, d) is False, "graphic should be suppressed for %s" % d)
# 화장품/미선언: 온라인(모델 있음) 그래픽 생성(True), stub(None model) 제외(False, 골든 불변)
ok(ie._block_emits_image(GRAPHIC, MODEL, "cosmetic") is True, "graphic should bake for cosmetic online")
ok(ie._block_emits_image(GRAPHIC, MODEL, None) is True, "graphic should bake for None(backcompat) online")
ok(ie._block_emits_image(GRAPHIC, None, "cosmetic") is False, "graphic stub(None model) excluded (golden)")
ok(ie._block_emits_image(GRAPHIC, None, "drug") is False, "graphic stub(None model) excluded for drug too")
# 사진형: 도메인 무관 항상 생성(True) — 규제도메인 게이팅은 그래픽 블록만
for d in ("drug", "cosmetic", None):
    ok(ie._block_emits_image(PHOTO, MODEL, d) is True, "photo should always emit (domain=%r)" % d)
# 차트(chart_data): 도메인·모델 무관 항상 제외(False)
for d in ("drug", "cosmetic", None):
    ok(ie._block_emits_image(CHART, MODEL, d) is False, "chart always excluded (domain=%r)" % d)
# 2-인자 후방호환(domain 미지정=None) — 기존 호출 불변
ok(ie._block_emits_image(GRAPHIC, MODEL) is True, "2-arg backcompat graphic online = True")
print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$F1_OUT" | grep -q PYOK \
  && pass "(8) F1(C) 도메인 게이팅: 규제도메인 그래픽 미생성·화장품/미선언 생성·사진형/차트 불변·2인자 후방호환" \
  || fail "(8) F1(C) 도메인 게이팅 실패 :: $F1_OUT"

# scratch 생성물 정리(테스트 격리)
rm -rf "$GEN_DIR"

printf '\n[image-engine] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
