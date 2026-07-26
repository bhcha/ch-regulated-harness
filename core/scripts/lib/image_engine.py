#!/usr/bin/env python3
"""image_engine.py — 이미지 시안 생성 어댑터 (Nano Banana / 결정적 stub).

입력: 03-storyboard/plan/NN-*.json 의 visual.concept (선택 톤에서 전개됨).
출력: 04-keyvisual/generated/NN-type.{svg,png} + 04-keyvisual/image-manifest.json (모두 런-로컬)

엔진(--engine):
  stub        결정적 SVG(좌표·색 고정, 무작위·시각 없음) — CI/오프라인/키부재 폴백.
  nanobanana  Gemini 2.5 Flash Image (Nano Banana) 어댑터. 입력=concept + 자사컷(픽셀
              레퍼런스), 출력=로컬 PNG. Vertex AI express mode REST(generateContent)를
              stdlib(urllib)로만 호출한다(외부 import 0개).
              삼중가드(common.sh:resolve_image_engine)가 키 없으면 이 경로를 선택하지 않는다.

저작권: 산출물은 항상 04-keyvisual/generated/ (자사 생성물 = allowlist 통과). 크롤 픽셀 미사용.
state.json 미수정(절대규칙 #1) — 산출물·매니페스트만 쓴다.
키 비노출: NANOBANANA_API_KEY 는 URL 쿼리에만 쓰고 로그·예외·매니페스트에 남기지 않는다.
"""
import sys, os, json, re, base64, time, hashlib
import urllib.request, urllib.error, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json, ROOT, html_escape, atomic_write_bytes as _atomic_write_bytes, PACKS_DIR  # noqa: E402
from form_factor import resolve_form_factor  # noqa: E402  (F2: 제형 고정 앵커 — COMPUTED, 저장 안 함)

# ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)

# ── Nano Banana(Gemini 2.5 Flash Image) 실호출 상수 (환경변수 오버라이드) ──
_NB_DEFAULT_MODEL = "gemini-2.5-flash-image"   # H-4: 기본 모델명 단일 출처(_NB_MODEL·fallback_model 공용)
_NB_RETRY_DEFAULT = 4        # H-4: 일시차단 재시도 기본(env 미설정/비정상 폴백 단일 출처)
_NB_RETRY_429_DEFAULT = 3    # H-4: 429 백오프 재시도 기본(env 미설정/비정상 폴백 단일 출처)
_NB_MODEL = os.environ.get("HARNESS_NANOBANANA_MODEL", _NB_DEFAULT_MODEL)
# 모델명은 URL 경로 세그먼트에 들어간다 → 안전 토큰만 허용(제어문자·경로구분자·콜론 금지).
#   비정상 모델명이 그대로 URL 에 들어가면 urllib 가 키 포함 URL 을 담은 예외를 던질 수 있어(키 유출) 사전 차단.
_NB_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# 후방호환 상수(테스트·문서용): 모듈 기본 모델의 엔드포인트. ⚠ 더는 '유일 출처'가 아니다 — 실호출은
#   _call_nanobanana(model=…) 이 넘긴 '이번 호출 모델'로 엔드포인트를 매-호출 조립한다(_nb_endpoint). 자동 강등
#   (429 쿼터 소진 → fallback 모델)이 같은 함수를 다른 모델로 재호출할 수 있어야 하므로.
_NB_ENDPOINT = (
    "https://aiplatform.googleapis.com/v1"
    "/publishers/google/models/%s:generateContent" % _NB_MODEL
)
_NB_TIMEOUT_DEFAULT = 120


def _nb_endpoint(model):
    """모델명 → generateContent 엔드포인트(순수, 네트워크 없음). 매-호출 조립 → 자동 강등 시 fallback 모델로
       다른 엔드포인트를 만든다. 모델명 안전성(_NB_MODEL_RE)은 호출부(_call_nanobanana)가 URL 구성 전에 검증한다."""
    return (
        "https://aiplatform.googleapis.com/v1"
        "/publishers/google/models/%s:generateContent" % model
    )


class NanoBananaQuotaExhausted(RuntimeError):
    """429(RESOURCE_EXHAUSTED) 지수 백오프 재시도를 소진했다는 타입 마커(RuntimeError 하위 —
       기존 `except RuntimeError` 경로 호환). generate_all 이 이걸 '구체적으로' 잡아 모델 자동 강등
       (HARNESS_NANOBANANA_FALLBACK_MODEL)으로 넘어간다. 다른 HTTP/네트워크 오류(즉시 raise)와 구분된다."""
    status = 429


class NanoBananaModelRejected(RuntimeError):
    """400(INVALID_ARGUMENT)로 '이 모델이 이 요청을 거부' 했다는 타입 마커(NanoBananaQuotaExhausted 형제 —
       RuntimeError 하위라 기존 `except RuntimeError` 호환). F2: Pro(gemini-3-pro-image)가 특정 입력을
       400 으로 거부하는 모델-특유 실패를 generate_all 이 429 와 동일하게 잡아 fallback 모델로 자동 강등한다.
       ⚠ 안전: fallback 모델도 400 이면 진짜 잘못된 요청이므로 그대로 fail-closed(강등이 '더 나빠지지 않음' —
       모델-특유 거부만 구제하고 요청 버그는 여전히 잡힌다). 다른 4xx/5xx·네트워크 오류(즉시 raise)와 구분된다."""
    status = 400


def _nb_backoff():
    """429 지수 백오프 대기열(초) = HARNESS_NANOBANANA_BACKOFF 콤마목록(기본 '15,30,60').
       비정상 토큰/음수는 버리고, 전부 비면 기본값으로 폴백. 테스트는 '0' 또는 '0,0,0' 으로 무-수면."""
    raw = os.environ.get("HARNESS_NANOBANANA_BACKOFF", "15,30,60")
    out = []
    for tok in (raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except (ValueError, TypeError):
            continue
        if v >= 0:
            out.append(v)
    return out or [15.0, 30.0, 60.0]


def _nb_retry_429():
    """429 백오프 재시도 횟수 = HARNESS_NANOBANANA_RETRY_429(기본 3, 음수/비정상 → 3). 이 횟수만큼 대기·재시도
       후에도 429 면 NanoBananaQuotaExhausted 를 던진다."""
    try:
        v = int(os.environ.get("HARNESS_NANOBANANA_RETRY_429", str(_NB_RETRY_429_DEFAULT)))
        return v if v >= 0 else _NB_RETRY_429_DEFAULT
    except (ValueError, TypeError):
        return _NB_RETRY_429_DEFAULT

# ⚠ 폐기된 티어 라우팅(전제 전환 2026-07-05, docs/bm-designer-handoff-plan.md): 과거에는 Pro 티어에서만
#   html_only 그래픽 블록을 이미지로 되살렸으나, 이제 **실엔진(온라인)이면 티어 무관** 전 블록을 이미지로 생성한다
#   (_block_emits_image 의 discriminator = bool(model)). _is_pro_model/_PRO_MODEL_PREFIX 는 _block_emits_image
#   에서 더는 쓰지 않는다 — 순수 유틸로만 남겨둔다(test-gen-image-completeness 가 아직 참조; 향후 티어별
#   프롬프트 튜닝 여지). 판정은 '명시 모델명 prefix' 단일 기준(암묵 env 미참조).
_PRO_MODEL_PREFIX = "gemini-3-pro"


def _is_pro_model(model):
    """모델명이 Pro 티어인지(prefix 'gemini-3-pro'). **명시 인자만** 본다 — 암묵 env 를 읽지 않는다
       (술어 결정성). 빈값/None/비문자 → False. ⚠ _block_emits_image 는 더는 이 함수를 쓰지 않는다(위 폐기 주석)."""
    return bool(model) and isinstance(model, str) and model.startswith(_PRO_MODEL_PREFIX)


def _nb_timeout():
    """HARNESS_IMAGE_TIMEOUT(초). 비정상 값이어도 import/stub 를 깨지 않고 기본값으로 폴백(양수만 채택)."""
    try:
        v = int(os.environ.get("HARNESS_IMAGE_TIMEOUT", str(_NB_TIMEOUT_DEFAULT)))
        return v if v > 0 else _NB_TIMEOUT_DEFAULT
    except (ValueError, TypeError):
        return _NB_TIMEOUT_DEFAULT


# 후방호환 상수(테스트·문서용): import 시 1회 평가. 비정상 env 여도 stub 가 안 깨지도록 폴백.
_NB_TIMEOUT = _nb_timeout()
# 자사컷 레퍼런스로 허용하는 래스터 확장자 → MIME (SVG 등 벡터/비래스터 제외)
_RASTER_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{3,8}$|^[a-zA-Z]{3,20}$")   # hex 또는 색상명만(SVG 속성 안전)


def _safe_color(c, fallback):
    return c if isinstance(c, str) and _COLOR_RE.match(c) else fallback


def _esc(s):
    # K-1: 코어는 harness.html_escape. 's or ""' 선처리로 기존 바이트 보존(0/False/""→"").
    return html_escape(s or "")

# aspect_ratio → (w,h). 채널 폭 CHANNEL_WIDTH_PX 고정.
CHANNEL_WIDTH_PX = 860   # H-5: 채널 렌더 폭(고정)
_DIMS = {"1:1": (CHANNEL_WIDTH_PX, CHANNEL_WIDTH_PX), "4:5": (CHANNEL_WIDTH_PX, 1075), "16:9": (CHANNEL_WIDTH_PX, 484), "3:4": (CHANNEL_WIDTH_PX, 1147)}


def _dims(concept):
    return _DIMS.get((concept or {}).get("aspect_ratio", "1:1"), (CHANNEL_WIDTH_PX, 640))


def build_prompt(concept, graphic=False, brand_name=None, form_factor=None):
    """visual.concept → Nano Banana 프롬프트 dict.
    픽셀 레퍼런스 = concept.reference.own_asset_path (자사컷 = '선택한 제품'의 실제 사진). 텍스트 방향 = mood/composition/direction/handoff.
    pixel_reference_allowed=false 이면 크롤 픽셀은 전송하지 않는다(기본).

    graphic (= visual.render_mode=="html_only" 그래픽/인포그래픽 블록): **디자이너 핸드오프 전제**로 subject·핸드오프에
      기술된 **디자인 한글 카피·헤드라인·뱃지·배너·말풍선·아이콘을 이미지에 직접 렌더 허용**(무텍스트 계약 해제, 한글
      자형이 다소 깨져도 무방 — 디자이너가 재조판. docs/bm-designer-handoff-plan.md). 참조 제품이 포함되면 그 라벨은 보존.
    graphic=False (사진형 블록): 기존 계약 유지 — 무텍스트 제품 사진 + 브랜드 오염 차단.

    brand_name (P-4 브랜드 환각 차단): **그래픽 분기 전용** 실제 제품/브랜드명. truthy 면 그래픽 프롬프트에
      "브랜드 표기가 필요하면 '<brand_name>'만 사용하라 — 다른 브랜드/로고 발명 금지" 문구를 덧붙여, 픽셀 레퍼런스가
      없는 그래픽 블록이 가짜 브랜드(예: GREEN ESSENCE)를 구워내는 것을 막는다. None/빈값이면 문구 생략(무변경).
      사진형(graphic=False)은 이 인자를 쓰지 않는다(무텍스트 계약이 이미 오브랜드 글자를 금지).

    ★ 브랜드 오염 차단(사진형 필수): 텍스트-only 생성은 모델이 '아는 유명 실존 브랜드'(자사 제품명과 비슷한 실존 브랜드)로 치환·환각한다.
      두 가지로 막는다 — (a) 참조 제품 사진을 image-to-image 로 보내 **그 제품을 보존**(새 제품/브랜드 생성 금지),
      (b) **참조에 이미 인쇄된 라벨/로고/한글 텍스트는 그대로 보존**하되 **참조에 없는 새 텍스트·카피·로고는 추가 생성 금지**.
      한글 on-image 신규 렌더는 정확도가 낮으므로 사진형은 새 문구/카피를 HTML 레이어가 담당(그래픽 블록은 위 graphic 분기로 예외).

    form_factor (F2 제형 고정): truthy 면 정규화된 제품 형태 명사구를 프롬프트에 **한 줄 덧붙여**, 확산모델이 참조/생성
      제품의 제형·용기(펌프/보틀/튜브 등)를 임의 치환하는 것을 막는다(제형 앵커). None/빈값이면 문구 생략 →
      **프롬프트 바이트 불변**(기존 동작 보존). ⚠ 텍스트-렌더 허용 문구는 절대 추가하지 않는다(사진형 무텍스트 계약 유지)."""
    c = concept or {}
    mood = c.get("mood") or {}
    ref = c.get("reference") or {}
    has_ref = bool(ref.get("pixel_reference_allowed")) and bool(ref.get("own_asset_path"))
    parts = []
    if has_ref:
        # 제품 보존(relighting/product-preservation): 참조의 '그 제품'만 유지하고 구도·배경·조명만 재구성.
        parts.append("아래 참조 이미지에 있는 '바로 그 제품'(브랜드 패키지·형태·색·로고)을 그대로 유지하라. 다른 제품이나 다른 브랜드를 새로 만들지 마라.")
    parts += [
        c.get("subject", "제품 제품컷"),
        "구도: " + c.get("composition", ""),
        "색온도: %s, 라이팅: %s, 질감: %s" % (mood.get("color_temp", ""), mood.get("lighting", ""), mood.get("texture", "")),
        "팔레트: " + ", ".join(c.get("palette", [])),
        "방향: " + ref.get("direction", ""),
        "핸드오프: " + c.get("handoff_note", ""),
    ]
    if form_factor:
        # F2 제형 고정(사진형·그래픽 공통): 제형·용기 치환 차단. 텍스트-렌더 허용은 여기서 절대 부여하지 않는다.
        parts.append("제품 형태: %s — 참조/생성 제품을 이 형태 그대로 유지하고 다른 제형·용기(펌프/보틀/튜브 등)로 치환하지 마라." % form_factor)
    if graphic:
        # 그래픽/인포그래픽 블록(디자이너 핸드오프): 디자인된 한글 카피·뱃지·배너를 이미지에 직접 렌더 허용(무텍스트 계약 해제).
        parts.append("이 블록은 그래픽·인포그래픽 디자인 시안이다 — subject·핸드오프에 기술된 한글 카피·헤드라인·뱃지·배너·말풍선·아이콘을 디자인 요소로 이미지에 직접 렌더하라(디자이너 핸드오프용, 한글 자형이 다소 깨져도 무방).")
        if has_ref:
            # ★ (P-4) 참조 제품이 있으면 그 라벨/로고를 보존하되, 참조 제품 브랜드 외 타 브랜드는 발명 금지(픽셀-락 강화).
            parts.append("참조 제품이 포함되면 그 제품에 인쇄된 라벨·로고는 보존하라(변형·삭제 금지). 참조 제품 브랜드 외 타 브랜드/로고를 발명하지 마라(no other brand, no other logo).")
        # ★ (P-4) 브랜드 환각 차단: 픽셀 레퍼런스 없이 텍스트만으로 그래픽을 생성하면 모델이 가짜 브랜드/로고(예: GREEN ESSENCE)를 구워낸다.
        #   실제 제품/브랜드명을 알려주고 그 외 브랜드 발명을 금지한다(한글 깨짐 허용 전제라 인-이미지 브랜드명 OK).
        if brand_name:
            parts.append("브랜드 표기가 필요하면 '%s'만 사용하라 — 다른 브랜드/로고를 발명하지 말 것(no fictional brand, no other logos)." % brand_name)
    else:
        # ★ (라벨 보존, 긍정) 참조 제품에 이미 인쇄된 라벨/로고/한글 텍스트는 그대로 보존(변형·삭제·재배치 금지).
        parts.append("참조 제품에 이미 인쇄된 라벨·로고·한글 텍스트는 있는 그대로 보존하라(변형·삭제·재배치 금지).")
        # ★ (신규 텍스트 환각만 차단, 긍정) 기존 라벨은 살리되, 참조에 없는 '새' 글자·카피·로고만 만들어 넣지 마라.
        parts.append("참조에 없는 새로운 텍스트·카피·문구·로고·엠블럼을 추가로 만들어 넣지 마라(no new text, no new lettering, no new logo). 새 문구·카피는 HTML 레이어가 담당.")
    return {
        "prompt": " / ".join(p for p in parts if p and not p.endswith(": ")),
        "pixel_reference": ref.get("own_asset_path"),       # 자사컷(로컬, 선택 제품). 크롤 아님.
        "pixel_reference_allowed": bool(ref.get("pixel_reference_allowed", False)),
        "aspect_ratio": c.get("aspect_ratio", "1:1"),
    }


def _stub_svg(concept, out_path):
    """결정적 SVG 시안(바이트 고정). 무작위/시각 사용 안 함."""
    c = concept or {}
    w, h = _dims(c)
    pal = c.get("palette") or ["#EDE7E0", "#C9A27A", "#6B5444"]
    bg = _safe_color(pal[0] if pal else None, "#EDE7E0")
    fg = _safe_color(pal[-1] if len(pal) > 1 else None, "#6B5444")
    mood = c.get("mood") or {}
    subject = _esc(c.get("subject", "제품 제품컷"))
    direction = _esc((c.get("reference") or {}).get("direction", ""))
    swatches = "".join(
        '<rect x="%d" y="%d" width="40" height="40" rx="6" fill="%s"/>' % (40 + i * 50, h - 70, _safe_color(col, "#CCCCCC"))
        for i, col in enumerate(pal[:5]))
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">\n' % (w, h, w, h) +
        '<rect width="%d" height="%d" fill="%s"/>\n' % (w, h, bg) +
        '<text x="50%%" y="44%%" text-anchor="middle" font-family="Pretendard,sans-serif" font-size="34" fill="%s">%s</text>\n' % (fg, subject) +
        '<text x="50%%" y="52%%" text-anchor="middle" font-family="Pretendard,sans-serif" font-size="18" fill="%s">%s</text>\n' % (fg, direction) +
        '<text x="50%%" y="60%%" text-anchor="middle" font-family="Pretendard,sans-serif" font-size="14" fill="%s">[stub 시안 — Nano Banana 키 연결 시 실사 생성]</text>\n' % fg +
        '<text x="50%%" y="66%%" text-anchor="middle" font-family="Pretendard,sans-serif" font-size="13" fill="%s">라이팅: %s · 질감: %s</text>\n' % (fg, _esc(mood.get("lighting", "")), _esc(mood.get("texture", ""))) +
        swatches + "\n</svg>\n")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(svg)


# 레퍼런스로 외부 API 에 전송 가능한 자사 자산 루트(allowlist) = 런-로컬 run_dir/inputs/assets/.
#   AGENTS.md 6번 절: 디자인 자산은 자사 자산(inputs/assets/)만. 레퍼런스 전송도 동일 경계.
#   per-run 계약: 해석 기준 base 는 ROOT 가 아니라 run_dir(호출자가 rdir 전달) — 모듈상수 대신 호출시 산출.


def _load_reference_bytes(pixel_reference, rdir):
    """자사컷(픽셀 레퍼런스) 경로 → (raw_bytes, content_mime) 또는 None. 네트워크 없음(순수).

    pixel_reference = concept.reference.own_asset_path (자사컷, 런 상대경로 inputs/assets/<fn>).
    존재 + 래스터(png/jpg/jpeg/webp) + **run_dir/inputs/assets/ 안** + **실제 내용이 래스터**(매직바이트)면
    (원바이트, 내용 MIME) 튜플을 반환. SVG·부재·비래스터·빈값·작업영역밖(절대경로/../심볼릭 탈출)·
    확장자위장(.png 인데 내용은 SVG/텍스트)이면 None.
    크롤 픽셀은 build_prompt 가 애초에 넣지 않지만, 승인후 plan 변조로 임의 로컬 파일이 외부 API 로
    유출되는 것을 막기 위해 여기서 자사자산 경계 + 내용검증을 강제한다(fail-closed).
    해석 기준 base = run_dir(rdir) — per-run 계약(ROOT 기준 폐기).
    ⚠ 단일 로더: _reference_part(전송용 inlineData)와 _reference_sha256(F8 input_hash 성분)가
      **정확히 같은 바이트**를 보도록 이 함수 하나로 로드·경계·매직 검증을 공유한다(드리프트 방지)."""
    if not pixel_reference or not isinstance(pixel_reference, str):
        return None
    ext = os.path.splitext(pixel_reference)[1].lower()
    ext_mime = _RASTER_MIME.get(ext)
    if not ext_mime:
        return None  # SVG·비래스터 확장자는 레퍼런스로 첨부하지 않음
    asset_root = os.path.realpath(os.path.join(rdir, "inputs", "assets"))
    # 절대경로면 os.path.join 이 rdir 을 버리고 그대로 사용(그 뒤 경계검사에서 거부됨).
    abs_path = os.path.join(rdir, pixel_reference)
    real = os.path.realpath(abs_path)
    # 자사 자산 루트(run_dir/inputs/assets/) 안에 있어야만 전송 — 그 밖(절대경로·../·심볼릭 탈출)이면 거부(전송 안 함).
    if real != asset_root and not real.startswith(asset_root + os.sep):
        return None
    if not os.path.isfile(real):
        return None
    with open(real, "rb") as f:
        raw = f.read()
    # 확장자가 아니라 '실제 내용'으로 MIME 판정 — 위장(.png 인데 SVG/텍스트)·비이미지는 전송 안 함.
    content_mime = _magic_mime(raw)
    if content_mime is None or content_mime not in _RASTER_MIME.values():
        return None
    return raw, content_mime


def _reference_part(pixel_reference, rdir):
    """자사컷(픽셀 레퍼런스) 경로 → inlineData 파트(image-to-image). 네트워크 없음(순수).
    _load_reference_bytes 가 로드·경계·매직 검증을 담당하고, 여기서는 통과 바이트를 base64 inlineData 로 포장만 한다.
    유효 레퍼런스가 없으면(부재·경계밖·비래스터·위장) None(텍스트 프롬프트만 전송)."""
    loaded = _load_reference_bytes(pixel_reference, rdir)
    if loaded is None:
        return None
    raw, content_mime = loaded
    return {"inlineData": {"mimeType": content_mime, "data": base64.b64encode(raw).decode("ascii")}}


def _reference_sha256(pixel_reference, rdir):
    """F8 input_hash 의 ref_sha256 성분 — _reference_part 와 **동일 경계/매직 경로**(_load_reference_bytes)로 로드한
       레퍼런스 바이트의 sha256(hex). 유효 레퍼런스가 없으면 None → 참조 자산 교체(바이트 변경)가 해시에 반영돼 재굽기된다."""
    loaded = _load_reference_bytes(pixel_reference, rdir)
    if loaded is None:
        return None
    return hashlib.sha256(loaded[0]).hexdigest()


def _compute_input_hash(prompt_obj, rdir):
    """F8 재굽기 트리거: 이 블록의 '생성 입력'(프롬프트 텍스트 + 비율 + 픽셀레퍼런스 경로/허용 + 레퍼런스 바이트 sha256)의
       정준 JSON sha256(hex). prompt_obj = build_prompt 산출(이미 form_factor 주입 반영). 다음 런에서 이 해시가
       바뀐 블록만 다시 굽는다(참조 자산 교체·프롬프트 변경 감지).
       ⚠ **모델명은 해시에서 제외** — 429/400 자동 강등이 active_model 을 런 중간에 바꾸므로, 모델을 넣으면 다음
         런에서 전면 재굽기를 헛되이 강제한다(강등은 재굽기 트리거가 아니다)."""
    payload = {
        "prompt": prompt_obj.get("prompt", "") or "",
        "aspect_ratio": prompt_obj.get("aspect_ratio"),
        "pixel_reference": prompt_obj.get("pixel_reference"),
        "pixel_reference_allowed": bool(prompt_obj.get("pixel_reference_allowed", False)),
        "ref_sha256": _reference_sha256(prompt_obj.get("pixel_reference"), rdir),
    }
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _build_body(prompt_obj, rdir):
    """prompt dict → generateContent 요청 바디(순수, 네트워크 없음).

    parts = [텍스트 프롬프트(+비율 소프트힌트)] + (자사컷 레퍼런스가 있으면 inlineData 파트).
    responseModalities=["TEXT","IMAGE"] (텍스트+이미지 동시 요청).
    rdir = 픽셀 레퍼런스 해석 기준(run_dir) — _reference_part 로 전달(per-run 계약)."""
    po = prompt_obj or {}
    text = po.get("prompt", "") or ""
    aspect = po.get("aspect_ratio")
    if aspect:
        text = "%s / 화면 비율(aspect ratio) 권장: %s" % (text, aspect)
    parts = [{"text": text}]
    ref_part = _reference_part(po.get("pixel_reference"), rdir)
    if ref_part is not None:
        parts.append(ref_part)
    return {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }


_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _magic_mime(b):
    """디코드 바이트 → 매직 시그니처 기반 MIME (모르면 None). 확장자가 아니라 '내용'으로 판정."""
    if not b or len(b) < 12:
        return None
    if b[:8] == _PNG_MAGIC:
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:4] == b"GIF8":
        return "image/gif"
    return None


def _is_png(b):
    """디코드 바이트가 PNG 매직으로 시작하는지(빠른 1차 판정). 구조 무결성은 _is_valid_png 가 본다."""
    return bool(b) and len(b) >= 8 and b[:8] == _PNG_MAGIC


def _is_valid_png(b):
    """PNG 구조 검증 — 매직 + 첫 청크 IHDR(len=13) + IDAT(픽셀데이터) ≥1 + 종결 IEND(len=0, 파일 끝). 8바이트 매직만 보는 것보다 강함:
       매직만/헤더만/IDAT없는 '잘린·부분·비렌더 PNG' 와 IEND 뒤 잡바이트를 fail-closed 로 거부(외부 최종리뷰 MEDIUM — 빈/부분 산출 금지).
       CRC 는 검사하지 않는다(구조 무결성만; 전송 잘림은 청크 길이 경계·IEND 종결로 포착). 실 PNG(IHDR…[ancillary]…IDAT…IEND)는 통과."""
    if not isinstance(b, (bytes, bytearray)) or len(b) < 8 or bytes(b[:8]) != _PNG_MAGIC:
        return False
    off, n, first, saw_idat = 8, len(b), True, False
    while off + 12 <= n:                        # 청크 최소 = length(4)+type(4)+crc(4)
        length = int.from_bytes(b[off:off + 4], "big")
        ctype = bytes(b[off + 4:off + 8])
        if first:
            if ctype != b"IHDR" or length != 13:   # 첫 청크 = IHDR(데이터 13바이트)
                return False
            first = False
        if ctype == b"IDAT":
            saw_idat = True
        end = off + 12 + length                 # 다음 청크 시작(length+type+data+crc)
        if end > n:                             # 선언 길이가 버퍼를 넘음 = 손상/잘림
            return False
        if ctype == b"IEND":                    # IEND = 길이 0 + 파일의 마지막 청크(뒤 잡바이트 거부) + IDAT 선행
            return length == 0 and end == n and saw_idat
        off = end
    return False                                # IEND 미도달(잘림)


def _parse_image(data):
    """generateContent 응답 → 첫 이미지 바이트(순수, 네트워크 없음).

    candidates[].content.parts[] 에서 첫 inlineData/inline_data(camel·snake 병행)를 base64 디코드.
    실제 래스터(매직 시그니처) 검증 후 반환. 이미지가 없거나 비이미지면
    promptFeedback.blockReason·candidates[].finishReason 사유를 담아 RuntimeError(빈/손상 산출 금지 — fail-closed)."""
    # 모든 노드를 형변환-안전하게 접근(비정상 JSON 도 통제된 RuntimeError 로 — AttributeError 방지).
    d = data if isinstance(data, dict) else {}
    candidates = d.get("candidates")
    candidates = candidates if isinstance(candidates, list) else []
    for cand in candidates:
        if not isinstance(cand, dict):
            continue
        content = cand.get("content")
        content = content if isinstance(content, dict) else {}
        parts = content.get("parts")
        parts = parts if isinstance(parts, list) else []
        for part in parts:
            if not isinstance(part, dict):
                continue
            inline = part.get("inlineData") or part.get("inline_data")
            if not isinstance(inline, dict):
                continue
            data_field = inline.get("data")
            if not isinstance(data_field, str) or not data_field:
                continue
            try:
                img = base64.b64decode(data_field, validate=True)
            except (ValueError, TypeError) as e:
                raise RuntimeError(
                    "Nano Banana 응답 이미지 base64 디코드 실패: %s" % e) from None
            if not img:
                raise RuntimeError("Nano Banana 응답 이미지가 빈 바이트입니다(빈 산출 금지)")
            # generate_all 이 .png 로 기록하므로 응답은 PNG 여야 한다(확장자-내용 불일치 차단) + 구조 무결성(잘린 PNG 거부).
            if not _is_valid_png(img):
                raise RuntimeError(
                    "Nano Banana 응답이 유효한 PNG 가 아닙니다(매직/IHDR/IEND 구조 위반 — .png 산출 보증·부분파일 금지)")
            return img
    # 이미지 없음 → 사유를 모아 fail-closed (키·URL 은 절대 포함하지 않는다)
    reasons = []
    feedback = d.get("promptFeedback")
    if isinstance(feedback, dict):
        block = feedback.get("blockReason") or feedback.get("block_reason")
        if block:
            reasons.append("promptFeedback.blockReason=%s" % block)
    for cand in candidates:
        if isinstance(cand, dict):
            fin = cand.get("finishReason") or cand.get("finish_reason")
            if fin:
                reasons.append("finishReason=%s" % fin)
    detail = ("; ".join(reasons)) if reasons else "응답에 이미지 파트(inlineData)가 없습니다"
    raise RuntimeError("Nano Banana 응답에 이미지가 없습니다 (%s)" % detail)


def _call_nanobanana(prompt_obj, out_path, rdir, model=None):
    """Nano Banana(Gemini 2.5 Flash Image) 호출 → 첫 이미지 파트를 out_path 로 기록.

    Vertex AI express mode REST(generateContent)를 stdlib urllib 로만 호출한다.
    삼중가드(common.sh:resolve_image_engine)가 키 존재+온라인일 때만 이 경로를 선택하므로,
    여기서의 키 부재 체크는 방어용(직접 호출 대비)이다.
    키(NANOBANANA_API_KEY)는 URL 쿼리에만 쓰고 로그·예외 메시지·매니페스트에 절대 남기지 않는다.
    rdir = 자사컷 레퍼런스 해석 기준(run_dir) — _build_body 로 전달(per-run 계약).
    model = 이번 호출에 쓸 모델명(None → 모듈 기본 _NB_MODEL). 엔드포인트를 매-호출 이 모델로 조립한다
      → generate_all 이 429 쿼터 소진 시 fallback 모델로 이 함수를 재호출해 자동 강등할 수 있다."""
    # 오프라인 방어 — 셸 삼중가드를 우회한 직접 호출(python3 image_engine.py --engine nanobanana)에서도
    #   HARNESS_OFFLINE=1 이면 네트워크 진입 금지(삼중가드의 '오프라인' 축을 코드에서도 강제, 결정성 보장).
    if os.environ.get("HARNESS_OFFLINE") == "1":
        raise RuntimeError("HARNESS_OFFLINE=1 — 오프라인 모드에서는 실엔진 호출이 금지됩니다(stub 사용).")
    api_key = os.environ.get("NANOBANANA_API_KEY")
    if not api_key:
        raise RuntimeError(
            "NANOBANANA_API_KEY 가 없습니다 — 실엔진 호출 불가(삼중가드가 보통 차단). "
            "키를 설정하거나 HARNESS_IMAGE_CLI=stub 를 쓰세요.")
    mdl = model or _NB_MODEL   # None/빈값 → 모듈 기본. 강등 시 generate_all 이 fallback 모델명을 넘긴다.
    # 모델명 사전검증 — 비정상 모델명(제어문자 등)이 URL 에 들어가면 urllib 가 '키 포함 URL' 을
    #   담은 InvalidURL 을 던져 키가 유출될 수 있다. URL 구성 전에 차단한다(키 미언급). 매-호출 모델을 검증.
    if not _NB_MODEL_RE.match(mdl):
        raise RuntimeError(
            "Nano Banana 모델명이 안전하지 않습니다(영숫자·._- 만 허용). 모델명을 확인하세요.")
    # 키는 URL 쿼리에만. 아래 url 변수는 로그·예외에 절대 노출하지 않는다. 엔드포인트는 이번 호출 모델로 조립.
    url = _nb_endpoint(mdl) + "?key=" + urllib.parse.quote(api_key, safe="")
    body = json.dumps(_build_body(prompt_obj, rdir)).encode("utf-8")
    # URL/Request 구성 단계의 예외(InvalidURL 등)도 키 포함 URL 을 담을 수 있으므로 마스킹해 재던진다.
    try:
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json"})
    except Exception as e:  # ValueError/InvalidURL 등 — 키 마스킹 후 중단
        raise RuntimeError(
            "Nano Banana 요청 구성 실패: %s" % (_redact_key(str(e), api_key),)) from None
    # ── 429(RESOURCE_EXHAUSTED) 지수 백오프 재시도 ──
    #   run-stage.sh 는 image_engine 을 '직접' 호출하며 상위 어디에도 429 백오프가 없다(옛 주석 '상위 gen-images
    #   백오프가 처리'는 거짓 — gen-images.sh 는 락 데드락으로 우회, 폐기). 따라서 여기서 429 를 흡수한다:
    #   HARNESS_NANOBANANA_BACKOFF(기본 15,30,60초) 만큼 최대 HARNESS_NANOBANANA_RETRY_429(기본 3)회 대기·재시도 후에도
    #   429 면 NanoBananaQuotaExhausted 를 던진다 → generate_all 이 잡아 모델 자동 강등으로 넘어간다.
    _backoff = _nb_backoff()
    _retry_429 = _nb_retry_429()
    # ── 일시적 차단(IMAGE_RECITATION·빈 응답·안전차단) 재시도(429 와 직교한 별개 카운터) ──
    #   Gemini 이미지 차단은 확률적 — 같은 요청을 N회(HARNESS_NANOBANANA_RETRY, 기본 4) 재시도하면 대개 통과한다.
    #   HTTP 4xx/5xx(429 제외)·네트워크·JSON 깨짐·구조 오류는 즉시 raise.
    try:
        _retries = max(0, int(os.environ.get("HARNESS_NANOBANANA_RETRY", str(_NB_RETRY_DEFAULT))))
    except (ValueError, TypeError):
        _retries = _NB_RETRY_DEFAULT
    recite_attempt = 0   # RECITATION/빈응답 재시도 소비 카운터
    q429_attempt = 0     # 429 백오프 재시도 소비 카운터(직교)
    while True:
        try:
            with urllib.request.urlopen(req, timeout=_nb_timeout()) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if q429_attempt < _retry_429:
                    delay = _backoff[min(q429_attempt, len(_backoff) - 1)]
                    sys.stderr.write(
                        "[image] 429 quota exhausted response on %s; backoff %.0fs (retry %d/%d)\n"
                        % (mdl, delay, q429_attempt + 1, _retry_429))
                    sys.stderr.flush()
                    q429_attempt += 1
                    time.sleep(delay)
                    continue
                # 백오프 소진 → 타입 마커(키/본문 미노출) → generate_all 이 강등으로 처리
                raise NanoBananaQuotaExhausted(
                    "Nano Banana 429 쿼터 소진(model=%s, 백오프 %d회 재시도 후)" % (mdl, _retry_429)) from None
            # 상태코드 + 본문(최대 2000자)만 노출. 키/URL 은 절대 echo 하지 않는다(마스킹 먼저, 자르기 나중).
            try:
                err_body = e.read().decode("utf-8", "replace")
            except Exception:
                err_body = "(본문 읽기 실패)"
            if e.code == 400:
                # 400(INVALID_ARGUMENT): 모델-특유 거부일 수 있다(F2 — Pro 가 특정 입력 거부). 타입 마커로 던져
                #   generate_all 이 429 와 동일하게 fallback 모델로 자동 강등하게 한다. 진짜 요청 버그면 fallback
                #   도 400 → 거기서 fail-closed(강등이 '더 나빠지지 않음'). 본문은 _redact_key 로 키 마스킹.
                raise NanoBananaModelRejected(
                    "Nano Banana 400 모델 거부(model=%s): %s"
                    % (mdl, _redact_key(err_body, api_key)[:2000])) from None
            raise RuntimeError(
                "Nano Banana HTTP 오류 (status=%s): %s"
                % (e.code, _redact_key(err_body, api_key)[:2000])) from None
        except urllib.error.URLError as e:
            raise RuntimeError(
                "Nano Banana 네트워크 오류: %s" % (_redact_key(str(e.reason), api_key),)) from None
        try:
            data = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise RuntimeError("Nano Banana 응답 파싱 실패(비정상 JSON): %s" % e) from None
        try:
            image_bytes = _parse_image(data)  # 이미지 없으면 RuntimeError
        except RuntimeError as e:
            _m = str(e)
            # 일시 차단(표절/빈응답)만 재시도. 잘린 PNG 등 구조 오류는 즉시 raise(재시도 무의미).
            if recite_attempt < _retries and ("RECITATION" in _m or "이미지가 없습니다" in _m or "빈 바이트" in _m):
                recite_attempt += 1
                time.sleep(2)
                continue
            raise
        _atomic_write_bytes(out_path, image_bytes)
        return


def _redact_key(text, api_key):
    """예외/로그로 나가는 문자열에서 API 키(raw·URL인코딩)를 마스킹. 키 유출 최후방어(외부리뷰 HIGH)."""
    if not text or not api_key:
        return text
    masked = text.replace(api_key, "***REDACTED***")
    enc = urllib.parse.quote(api_key, safe="")
    if enc and enc != api_key:
        masked = masked.replace(enc, "***REDACTED***")
    return masked


# _atomic_write_bytes: harness.atomic_write_bytes 를 import (K-1 일원화 — atomic_write 계열 공용화)


_MIN_ASPECT_RATIO, _MAX_ASPECT_RATIO = 0.1, 10.0   # H-5: aspect 파싱 허용 범위(DoS 방어)
_ASPECT_NOOP_TOL = 0.01                              # H-5: 목표 비율 근사 no-op 허용오차(비율 대비)
_LETTERBOX_BG = (250, 247, 244)                      # H-5: 레터박스 패드 배경색


def _parse_aspect(aspect):
    """'16:9'|'4:3'|'1:1' 같은 aspect 문자열 → 목표 비율 float(w/h) 또는 None(파싱 불가·비양수).
       순수 함수(네트워크·IO 없음). F3(c) 규격화의 목표 비율 파서."""
    if not isinstance(aspect, str) or ":" not in aspect:
        return None
    try:
        w_s, h_s = aspect.split(":", 1)
        w, h = float(w_s), float(h_s)
    except (ValueError, TypeError):
        return None
    if w > 0 and h > 0:
        ratio = w / h
        # DoS 방지(외부리뷰): plan-block.schema 는 aspect_ratio 를 문자열로만 요구하므로 스키마상 유효한 극단값
        #   (예 "100000:1")이 _normalize_png_aspect 에서 거대 캔버스(h*target 폭) 할당 → OOM/행을 유발할 수 있다.
        #   현실적 상세페이지 aspect 범위(1:10 ~ 10:1) 밖이면 규격화를 생략(None) — 표시 크롭 제거는 CSS 자연비율(F3-a)이
        #   이미 담당하므로 안전하게 no-op 한다.
        if _MIN_ASPECT_RATIO <= ratio <= _MAX_ASPECT_RATIO:
            return ratio
    return None


def _normalize_png_aspect(png_path, aspect, bg=_LETTERBOX_BG):
    """F3(c): 생성 PNG 를 목표 aspect(w:h)로 **패드(레터박스, 크롭 0)** 해 규격화한다. Pro/flash 가 서로 다른
       크기·비율을 내도 블록 선언 aspect 로 맞춰, 표시 박스(자연비율 height:auto, F3-a)에서 섹션 높이가 블록별
       선언 비율로 일관되게 한다. **자르지 않고 여백만 추가**하므로 내용 손실 0(제품컷 가장자리 유실 없음).
       - Pillow 미가용 / aspect 미파싱 / 이미 허용오차 내 일치 → no-op(원본 바이트 보존, 불필요 재인코딩 방지).
       - 결정적(무작위·시각 없음). 원자적 재기록(임시파일 → os.replace, 부분파일 방지).
       - **실패는 삼켜 원본을 남긴다** — 규격화는 폴리시(정렬 폴리시)이지 안전 게이트가 아니다(크롭 제거의 정본은
         CSS 자연비율(F3-a). image_engine 은 stub(SVG)에서 이 함수를 호출하지 않으므로 **오프라인 골든 불변**)."""
    target = _parse_aspect(aspect)
    if not target:
        return
    try:
        from PIL import Image
    except Exception:
        return   # Pillow 미설치 — 규격화 생략(CSS 자연비율이 크롭을 이미 제거)
    tmp = png_path + ".norm.tmp"
    try:
        with Image.open(png_path) as im:
            im.load()
            base = im.copy()   # 원본 모드 보존(알파 포함) — with 밖에서 쓰려면 복사
        w, h = base.size
        if w <= 0 or h <= 0:
            return
        cur = w / h
        if abs(cur - target) <= _ASPECT_NOOP_TOL * target:
            return   # 이미 목표 비율 근사 → 원본 보존(바이트 불변)
        if cur > target:
            # 가로가 더 넓다 → 세로(높이)에 위아래 여백 추가(레터박스)
            new_w, new_h = w, int(round(w / target))
        else:
            # 세로가 더 길다 → 가로(폭)에 좌우 여백 추가(필러박스)
            new_w, new_h = int(round(h * target)), h
        new_w, new_h = max(new_w, w), max(new_h, h)   # 절대 축소(크롭)하지 않는다
        canvas = Image.new("RGB", (new_w, new_h), bg)
        off = ((new_w - w) // 2, (new_h - h) // 2)
        # 알파 보존(외부리뷰): 투명/반투명 PNG(누끼 등)를 그냥 convert("RGB")하면 알파가 버려져 저장된 RGB 로 구워지며
        #   검은/색 halo·배경이 생긴다. 알파가 있으면 RGBA 로 변환해 **알파를 마스크로** bg 위에 합성한다(투명 픽셀=bg,
        #   halo 없음). 알파 없으면 RGB 로 직접 붙인다. 최종은 RGB(불투명 레터박스) — 상세페이지 자산 규격에 적합.
        _has_alpha = ("A" in base.mode) or (base.mode == "P" and "transparency" in base.info)
        if _has_alpha:
            rgba = base.convert("RGBA")
            canvas.paste(rgba, off, rgba)   # 3번째 인자(mask)=알파 → 투명 픽셀은 canvas(bg) 유지
        else:
            canvas.paste(base if base.mode == "RGB" else base.convert("RGB"), off)
        canvas.save(tmp, "PNG")
        os.replace(tmp, png_path)
    except Exception:
        # 규격화 실패 → 원본 PNG 보존(CSS 자연비율이 크롭 제거를 담당). 임시파일 정리.
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def _read_brand_name(rdir):
    """런-로컬 스냅샷 inputs/bundle/product.json 의 .name(제품/브랜드명) → str|None. 순수(네트워크 없음).
       ⚠ state.json 은 스크립트 소유(절대규칙 #1)라 읽지 않는다 — 인입이 떠놓은 런-로컬 product.json 스냅샷만 본다.
       파일 부재·JSON 깨짐·비-dict·name 부재/비문자/공백 → None(그래픽 프롬프트에서 브랜드 문구 생략, 무변경).
       P-4: build_prompt graphic 분기에 이 이름을 넘겨 가짜 브랜드(GREEN ESSENCE 등) 환각을 차단한다."""
    p = os.path.join(rdir, "inputs", "bundle", "product.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return None


def _plan_blocks_with_concept(rdir):
    pdir = os.path.join(rdir, "03-storyboard", "plan")
    out = []
    if os.path.isdir(pdir):
        for fn in sorted(os.listdir(pdir)):
            if fn.endswith(".json"):
                b = load_json(os.path.join(pdir, fn))
                if (b.get("visual") or {}).get("concept"):
                    out.append(b)
    return out


# F1(C) 규제도메인 게이팅: 아래 도메인은 그래픽 블록(render_mode=html_only)을 이미지로 '굽지 않는다'. 확산모델이
#   그래픽/인포그래픽에 없는 인증(FDA)·수상·순위(1위)·수치를 창작(환각)해 굽는 규제 리스크가 특히 크기 때문
#   (약사법·표시광고법). 화장품(cosmetic)·미선언(None)은 기존대로 굽되(디자이너 참고 시안). 어느 도메인이든 그
#   baked 그래픽 PNG 는 옵션 HTML/export deliverable 에서 참조 금지(check_render_refs 가 전 도메인 균일 차단) →
#   그래픽 블록의 표시·심의·게재는 HTML/SVG 텍스트 레이어로만(docs/keyvisual-image-safety-fixes-plan.md F1).
# H-2: '그래픽 자동생성 억제' 정책은 팩 소유 — packs/<domain>/domain.json 의 no_graphic_generation.
#   하드코딩 집합(_REGULATED_NO_GRAPHIC) 폐기 → 새 도메인은 팩 선언만으로 정책 반영(core 무수정).
#   도메인당 1회만 domain.json 을 읽어 캐시(블록마다 파일 IO 회피 · _block_emits_image 유사-순수 유지).
_no_graphic_cache = {}
# H-2 폴백(방어심층 · common.sh _no_graphic 과 동일 스탠스): domain.json 이 1차 권위지만, 로드 실패
#   (PACKS_DIR 오류·파일 부재/손상)로 규제도메인이 조용히 fail-open(그래픽 생성)되면 규제(약사법·표시광고법)
#   회귀다. 옛 하드코딩셋을 '로드 실패 바닥값'으로만 유지 → 정상 경로는 팩 소유(도메인 선언), 에러 경로는
#   기존 fail-safe 억제 보존(옛 'domain in {drug,quasi_drug,health_food}' 와 동치).
_NO_GRAPHIC_FALLBACK = frozenset({"drug", "quasi_drug", "health_food"})


def _domain_no_graphic(domain):
    """규제도메인의 no_graphic_generation 정책(packs/<domain>/domain.json, 1차 권위). 빈 도메인=False.
    명시 선언(true/false)이면 그 값. 로드 실패(PACKS_DIR 오류·부재/손상) 또는 필드 미선언(None) 시
    → 보수 폴백셋(_NO_GRAPHIC_FALLBACK)으로 판정 — 규제도메인은 억제 유지(옛 하드코딩 fail-safe 보존,
    fail-open 금지). 등록 4도메인은 필드 보유라 정상경로 값-동치."""
    if not domain:
        return False
    if domain not in _no_graphic_cache:
        try:
            val = load_json(os.path.join(PACKS_DIR, domain, "domain.json")).get("no_graphic_generation")
        except Exception:
            val = None
        _no_graphic_cache[domain] = bool(val) if val is not None else (domain in _NO_GRAPHIC_FALLBACK)
    return _no_graphic_cache[domain]


def _block_emits_image(b, model=None, domain=None):
    """이 블록이 생성 이미지(PNG/SVG) 대상인지 — **유효 술어(effective predicate)**. 제외 규칙(단일 출처 —
       planned_image_summary 카운트와 generate_all 의 skip 술어가 이 함수만 읽으므로 자동 동기화·드리프트 방지):
         1) chart_data 보유 임상/전후 블록(clinicalEvidence/beforeAfter)은 keyvisual 인라인 차트로 렌더되므로
            **모델·엔진과 무관하게 항상 제외**(차트는 확산모델로 데이터를 날조하지 않고 언제나 HTML/SVG 인라인 렌더 — 규제 장치).
         2) visual.render_mode == "html_only" 그래픽 블록(F1(C) 도메인 게이팅):
            - **규제도메인(domain.json no_graphic_generation=true; 현재 drug/quasi_drug/health_food)은 온라인에서도 제외** — 허위 인증·
              순위·수치 환각 리스크가 큰 도메인은 아예 굽지 않고 HTML/SVG 레이어로만 렌더한다.
            - **화장품(cosmetic)·미선언(None)은 실엔진(온라인)에서 이미지로 생성**(디자이너 참고 시안). stub(None model)은
              도메인 무관 제외 유지 → 골든 바이트 불변(결정성). 판정 discriminator = `model is not None`.
            - ⚠ 어느 도메인이든 baked 그래픽 PNG 를 옵션 HTML/export 가 참조하는 것은 금지(check_render_refs 균일 차단).
       render_mode 가 없으면(부재) 기존대로 이미지 생성 대상(후방호환 default).
       ⚠ domain 은 **명시 인자**(암묵 참조 없음): generate_all 이 셸에서 선언 도메인(--domain)을 받아 넘긴다. 미지정
          (None)이면 화장품처럼 굽는다(후방호환 — 기존 2-인자 호출·테스트 불변). model 도 명시 인자(nanobanana=_NB_MODEL,
          stub=None). 네트워크 IO 없음(그래픽 억제 정책만 팩 domain.json 을 도메인당 1회 캐시 조회)."""
    typ = b.get("type")
    vis = b.get("visual") or {}
    if typ in ("clinicalEvidence", "beforeAfter") and vis.get("chart_data"):
        return False
    if vis.get("render_mode") == "html_only":
        if _domain_no_graphic(domain):
            return False       # F1(C): 규제도메인 그래픽 블록은 온라인에서도 미생성(HTML/SVG 로만)
        return bool(model)     # 화장품/미선언: 실엔진(온라인)=생성, stub(None)=제외(골든 불변)
    return True


def planned_image_summary(rdir, model=None, domain=None):
    """읽기전용 블록 walk → {"total","image","chart","html_only"} 카운트. 이미지-직전 preflight·run.md
       digest 가 공유(드리프트 방지). visual.concept 보유 블록(=실제 생성 후보)만 센다.
       image=실제 생성, chart=임상 차트(chart_data, 표로 렌더), html_only=그래픽(HTML/SVG 로 렌더).
       html_only 를 chart 로 접어 세지 않는다(운영 화면 정확도) — image+chart+html_only==total.

       model: _block_emits_image 유효 술어에 넘길 운영 모델(discriminator=bool(model)). **미지정(None)이면 모듈 상수
       _NB_MODEL(운영 설정 모델)로 폴백** → preflight(image_preflight.py)·run.md digest(render_runmd.py)가
       호출부 무수정으로 '온라인이면 그래픽 블록도 생성' 예정 장수를 자동 반영한다.
       domain(F1(C)): 선언 규제도메인. 규제도메인(drug/quasi_drug/health_food)이면 그래픽 블록이 image 가 아니라
       html_only 로 집계된다(온라인에서도 미생성 — _block_emits_image 와 동일 술어라 카운트/생성 자동 일치). 화장품·
       미선언(None)은 실엔진이면 그래픽 블록이 image 로 집계. stub(model None)이면 도메인 무관 그래픽=html_only(골든 불변).
       ⚠ 테스트가 직접 호출 시 결정성 위해 env -u HARNESS_NANOBANANA_MODEL 로 격리하거나 model 을 명시 전달
       한다(test-image-engine.sh:46 전례)."""
    effective_model = model if model is not None else _NB_MODEL
    blocks = _plan_blocks_with_concept(rdir)
    total = len(blocks)
    image = sum(1 for b in blocks if _block_emits_image(b, effective_model, domain))
    chart = sum(1 for b in blocks
                if b.get("type") in ("clinicalEvidence", "beforeAfter")
                and (b.get("visual") or {}).get("chart_data"))
    html_only = total - image - chart   # 나머지 비-생성 블록(render_mode html_only)
    return {"total": total, "image": image, "chart": chart, "html_only": html_only}


_VALID_ENGINES = ("stub", "nanobanana")
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._-]+$")   # 파일·디렉터리 토큰(경로구분자·.. 불가)


def _safe_token(value, what):
    """run_id·block type 가 파일명 안전 토큰인지(경로탈출 차단). 위반 시 ValueError(fail-closed)."""
    s = str(value)
    if not _SAFE_TOKEN.match(s) or s in (".", ".."):
        raise ValueError("안전하지 않은 %s: %r (영숫자·._- 만 허용)" % (what, value))
    return s


def _assert_under(path, root, what):
    """path 의 realpath 가 root 아래인지 강제(심볼릭·.. 탈출 최후방어). 위반 시 ValueError."""
    rp = os.path.realpath(path)
    rr = os.path.realpath(root)
    if rp != rr and not rp.startswith(rr + os.sep):
        raise ValueError("%s 가 허용 루트 밖입니다: %r" % (what, path))
    return rp


def _existing_is_valid(abs_out, engine):
    """기존 산출물이 '유효'(skip 가능)한지. 0바이트·손상은 False → 재생성(부분파일 복구·fail-closed).
    nanobanana(.png): PNG 구조 검증(매직+IHDR+IEND — 매직만 있는 부분파일도 거부, 외부리뷰 최종 MEDIUM). stub(.svg): 비어있지 않고 SVG/XML 헤더로 시작."""
    if not os.path.isfile(abs_out) or os.path.getsize(abs_out) <= 0:
        return False
    if engine == "nanobanana":
        # 구조 검증은 IEND(파일 끝)까지 봐야 하므로 전체를 읽는다(64바이트 head 로는 IEND 판정 불가).
        try:
            with open(abs_out, "rb") as f:
                return _is_valid_png(f.read())
        except OSError:
            return False
    try:
        with open(abs_out, "rb") as f:
            head = f.read(64)
    except OSError:
        return False
    # stub SVG — 텍스트 시작(공백 무시) 이 '<svg' 또는 '<?xml'
    stripped = head.lstrip()
    return stripped.startswith(b"<svg") or stripped.startswith(b"<?xml")


def generate_all(rid, rdir, engine, domain=None):
    """domain(F1(C)): 셸(gen-images.sh·render-design.sh)이 --domain 으로 넘기는 선언 규제도메인. 규제도메인
       (drug/quasi_drug/health_food)이면 그래픽 블록(html_only)을 굽지 않는다(_block_emits_image). 미지정(None)이면
       화장품처럼 굽는다(후방호환). stub 은 domain 무관(model None → html_only 제외 → 골든 불변)."""
    if engine not in _VALID_ENGINES:
        raise ValueError("알 수 없는 엔진: %r (stub|nanobanana 만 허용)" % (engine,))
    _safe_token(rid, "run_id")   # 경로탈출 차단(절대경로·../ 거부)
    # per-run 계약: 생성 이미지는 런-로컬 04-keyvisual/generated/ 하위(rid 하위폴더 없음 — rdir 이 이미 런).
    kv_dir = os.path.join(rdir, "04-keyvisual")
    gen_dir = os.path.join(kv_dir, "generated")
    _assert_under(gen_dir, kv_dir, "생성 디렉터리")
    os.makedirs(gen_dir, exist_ok=True)
    # 유효 술어 discriminator(전제 전환): 실엔진(nanobanana)일 때만 _NB_MODEL(=not None)을 넘겨 그래픽 블록도
    #   이미지로 생성한다(디자이너 핸드오프). stub 은 None → html_only 제외 → 골든 바이트 불변 보장.
    model = _NB_MODEL if engine == "nanobanana" else None
    # ── P-1 모델 자동 강등 다이얼(429 부분실패 내성) ──
    #   active_model = 지금 이 시점에 쓰는 모델(강등되면 fallback 으로 갈아탄 뒤 이후 블록까지 유지).
    #   fallback = HARNESS_NANOBANANA_FALLBACK_MODEL(기본 gemini-2.5-flash-image; 빈 문자열이면 강등 비활성).
    active_model = _NB_MODEL if engine == "nanobanana" else None
    fallback_model = os.environ.get("HARNESS_NANOBANANA_FALLBACK_MODEL", _NB_DEFAULT_MODEL)
    # P-4 브랜드 환각 차단: 그래픽 프롬프트에 넣을 실제 제품/브랜드명(런-로컬 product.json 스냅샷). 실엔진 경로 전용
    #   — stub 은 build_prompt 를 호출하지 않으므로(아래 nanobanana 분기에서만 호출) None 이면 충분(골든 불변).
    brand_name = _read_brand_name(rdir) if engine == "nanobanana" else None
    # F2 제형 고정: 정규화된 제품 형태 명사구(claim-basis product_type[사람 선언] + voc components → 팩 form_factors 표).
    #   brand_name 과 동일하게 실엔진 경로 전용 — stub 은 build_prompt 미호출이라 None 이면 충분(이미지 골든 불변).
    #   state.json 미열람: 도메인은 셸 --domain(generate_all domain 인자)에서만 온다.
    form_factor = resolve_form_factor(rdir, domain) if engine == "nanobanana" else None
    out_path = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # F8 재굽기 트리거: 기존 매니페스트(완전본 또는 incomplete 증분본)의 {path: input_hash} 를 로드한다.
    #   skip 판정이 '유효 산출물 && 입력해시 불변'이 되도록 이전 해시를 참조한다(참조 자산 교체·프롬프트 변경 감지).
    #   ⚠ 손상/부재/레거시(input_hash 미기록)는 조용히 흡수 — 값이 None 이면 '레거시'로 취급해 기존 멱등 skip 보존.
    prev_hashes = {}
    if os.path.isfile(out_path):
        try:
            for a in (load_json(out_path).get("assets") or []):
                if isinstance(a, dict) and isinstance(a.get("path"), str):
                    prev_hashes[a["path"]] = a.get("input_hash")   # None = 레거시(필드 부재)
        except Exception:
            prev_hashes = {}

    def _persist(assets_so_far, incomplete):
        """매니페스트 원자 기록. incomplete=True 는 증분(부분성공) 마커 — run-stage 완료판정이 재생성 트리거로 취급.
           최종(incomplete=False)본은 incomplete 키를 아예 넣지 않는다.
           ★ 골든 불변: atomic_write_json 은 sort_keys 없음(삽입순서 보존)이므로 최종본 키순서를 기존과 정확히
             맞춘다 — stub={engine,assets} · nanobanana={engine,assets,model}(기존 generate_all 과 동일 삽입순서).
             → 완전성공 매니페스트 바이트는 기존과 100% 동일(incomplete 키만 없을 뿐). stub 은 증분 미호출(최종 1회)."""
        if incomplete:
            # 증분(부분성공) — 계획 형상 {"engine",[ "model"],"incomplete":true,"assets"}. 골든 아님(부분 매니페스트).
            m = {"engine": engine}
            if engine == "nanobanana":
                m["model"] = _NB_MODEL
            m["incomplete"] = True
            m["assets"] = assets_so_far
        else:
            # 최종본 — 기존 삽입순서(engine·assets·[model]) 그대로 = 완전성공 바이트 불변.
            m = {"engine": engine, "assets": assets_so_far}
            # 관측성(RCA 7-0 발견②): 실엔진(nanobanana)일 때만 사용 모델명 기록(산출물만으로 Pro/Flash 판별).
            #   ⚠ stub 은 미기록 — {"engine":"stub","assets":[…]} 바이트 결정성 유지. 모델은 '이번 호출 설정 모델'
            #   (강등 사용여부는 stderr 감사 로그로만 — 동결 스키마 존중).
            if engine == "nanobanana":
                m["model"] = _NB_MODEL
        atomic_write_json(out_path, m)
        return m

    blocks = [b for b in _plan_blocks_with_concept(rdir) if _block_emits_image(b, model, domain)]
    #   (차트/stub-html_only 블록은 위에서 제외 — image_engine 생략, keyvisual 인라인 SVG/HTML 로 렌더)
    assets = []
    for _idx, b in enumerate(blocks):
        order, typ = b["order"], b["type"]
        _safe_token(typ, "block type")   # 파일명 경로탈출 차단
        concept = b["visual"]["concept"]
        ext = "png" if engine == "nanobanana" else "svg"
        fn = "%02d-%s.%s" % (order, typ, ext)
        abs_out = os.path.join(gen_dir, fn)
        _assert_under(abs_out, gen_dir, "산출물 경로")
        rel_out = "04-keyvisual/generated/%s" % fn   # 런 상대 정규경로 = 매니페스트 assets[].path
        # F8: nanobanana 경로는 skip 판정 '전에' 프롬프트+입력해시를 산출한다(참조 자산 교체·프롬프트 변경 감지 → 해당 블록만 재굽기).
        #   프롬프트는 이미 form_factor 주입이 반영된 최종본이므로, 해시가 최종 프롬프트를 덮는다. stub 은 build_prompt 미호출(골든 불변) → cur_hash None.
        cur_hash = None
        _prompt = None
        # 그래픽 블록(html_only)은 디자인 카피 인-이미지 렌더 허용(build_prompt graphic 분기 — 디자이너 핸드오프).
        _graphic = (b["visual"].get("render_mode") == "html_only")
        if engine == "nanobanana":
            # brand_name(P-4)은 build_prompt 의 graphic 분기에서만 소비된다(사진형은 무시) — 그래픽 블록 가짜 브랜드 차단.
            # form_factor(F2)는 사진형·그래픽 공통으로 제형 고정 문구를 덧붙인다(None 이면 무변경).
            _prompt = build_prompt(concept, graphic=_graphic, brand_name=brand_name, form_factor=form_factor)
            cur_hash = _compute_input_hash(_prompt, rdir)
        # F8 skip 판정: 유효 산출물 && (stub || 레거시[prev_hash None] || 입력해시 불변). 입력해시가 바뀐 블록만 재굽기.
        #   레거시(input_hash 미기록) 매니페스트는 값-부재만으로 재굽기하지 않는다 — 유효 산출물이면 그대로 skip(싸구려 재진입 보존)하되 이번 런에 해시를 기록.
        prev_hash = prev_hashes.get(rel_out)
        if _existing_is_valid(abs_out, engine) and (engine != "nanobanana" or prev_hash is None or prev_hash == cur_hash):
            status = "skipped"
        elif engine == "nanobanana":
            # ── 429 쿼터 소진 시 모델 자동 강등 재시도(그 블록부터 이후 전 블록에 유지) ──
            while True:
                try:
                    # ⚠ active_model == _NB_MODEL 인 정상 경로는 3-인자 호출 유지(기존 3-인자 monkeypatch 계약
                    #    — test-gen-image-completeness HO-e — 후방호환). 강등 뒤에만 fallback 모델을 4번째 인자로 넘긴다.
                    if active_model == _NB_MODEL:
                        _call_nanobanana(_prompt, abs_out, rdir)          # 실호출(삼중가드 통과 시에만)
                    else:
                        _call_nanobanana(_prompt, abs_out, rdir, active_model)
                    break
                except NanoBananaQuotaExhausted:
                    if fallback_model and fallback_model != active_model:
                        # 감사 한 줄(stderr — run-stage 가 image_engine stdout 을 >/dev/null 로 버리므로 stderr 가 생존 채널).
                        sys.stderr.write(
                            "[image] 429 quota exhausted on %s; downgrading to %s from block %d\n"
                            % (active_model, fallback_model, order))
                        sys.stderr.flush()
                        active_model = fallback_model
                        continue   # 같은 블록을 강등 모델로 재시도
                    # 강등 불가(비활성 또는 이미 fallback) → 부분 매니페스트 확정(incomplete) 후 fail-closed.
                    _persist(assets, incomplete=True)
                    remaining = ["%02d-%s" % (bb["order"], bb["type"]) for bb in blocks[_idx:]]
                    raise RuntimeError(
                        "이미지 생성 실패(429 쿼터 소진·모델 강등 불가): 블록 %02d-%s. "
                        "미생성 %d개: %s. 부분 매니페스트(incomplete)는 저장됨 — 재실행(멱등)으로 이어서 생성하세요."
                        % (order, typ, len(remaining), ", ".join(remaining))) from None
                except NanoBananaModelRejected:
                    # F2: 400(모델-특유 거부) → 429 와 동일한 강등 다이얼로 fallback 모델 재시도(active_model 전환은
                    #   이후 전 블록에 유지). fallback 이 없거나 이미 fallback 인데도 400 이면 진짜 요청 버그로 보고
                    #   부분 매니페스트(incomplete) 저장 후 fail-closed(강등이 '더 나빠지지 않음').
                    if fallback_model and fallback_model != active_model:
                        sys.stderr.write(
                            "[image] 400 model-rejected on %s; downgrading to %s from block %d\n"
                            % (active_model, fallback_model, order))
                        sys.stderr.flush()
                        active_model = fallback_model
                        continue   # 같은 블록을 강등 모델로 재시도
                    _persist(assets, incomplete=True)
                    remaining = ["%02d-%s" % (bb["order"], bb["type"]) for bb in blocks[_idx:]]
                    raise RuntimeError(
                        "이미지 생성 실패(400 모델 거부·강등 불가): 블록 %02d-%s. "
                        "미생성 %d개: %s. 부분 매니페스트(incomplete)는 저장됨 — 재실행(멱등)으로 이어서 생성하세요."
                        % (order, typ, len(remaining), ", ".join(remaining))) from None
            status = "generated"
            # F3(c): 생성 직후 목표 aspect 로 규격화(패드, 크롭 0) — Pro/flash 크기·비율 드리프트 흡수·표시 정렬.
            #   nanobanana 분기 안이라 online 전용(stub 무관 → 골든 불변). 멱등: 재실행 시 유효 PNG 는 위에서 skip.
            _normalize_png_aspect(abs_out, concept.get("aspect_ratio"))
        else:
            _stub_svg(concept, abs_out)
            status = "fallback_stub"
        asset = {
            "path": rel_out, "type": typ, "order": order, "seed": None,
            "status": status, "source_concept_ref": "plan/%02d-%s.json" % (order, typ),
            "aspect_ratio": concept.get("aspect_ratio", "1:1"),
        }
        # F8: 입력해시는 **nanobanana 경로 전용** 기록(model 키 선례와 동일) → stub 매니페스트 바이트 불변(골든 결정성).
        #   skipped 블록도 이번 런의 해시를 기록해, 레거시 매니페스트가 다음 런부터 해시-비교로 자연 마이그레이션된다.
        if engine == "nanobanana":
            asset["input_hash"] = cur_hash
        assets.append(asset)
        # 증분 매니페스트(실엔진 경로 전용): 자산 1개 성공할 때마다 incomplete=True 로 기록 →
        #   중간 크래시(429 등)에도 성공분이 등재되어 check_render_refs 가 그 자산을 <img> 로 허용(all-or-nothing 해소).
        #   ⚠ stub 은 증분하지 않는다(아래 최종 1회 기록만) → 골든 바이트 불변.
        if engine == "nanobanana":
            # O-3(진행 신호): 자산별 성공 stderr 1줄(.logs 캡처로 폴링 가시화 — bake 정체 오인 방지). 증분 매니페스트가 진행 정본.
            sys.stderr.write("[image] %d/%d %02d-%s %s\n" % (_idx + 1, len(blocks), order, typ, status))
            sys.stderr.flush()
            _persist(assets, incomplete=True)
    # 전 블록 완료 → incomplete 없는 '최종본' 기록(완전성공 바이트는 기존과 동일). stub 은 여기서 유일 1회 기록.
    return _persist(assets, incomplete=False)


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit("사용법: image_engine.py <run_id> <run_dir> [--engine stub|nanobanana] [--domain <도메인>]")
    rid, rdir = args[0], args[1]
    engine = "stub"
    if "--engine" in args:
        i = args.index("--engine") + 1
        if i >= len(args):
            sys.exit("--engine 뒤에 값이 필요합니다 (stub|nanobanana)")
        engine = args[i]
    if engine not in _VALID_ENGINES:
        sys.exit("알 수 없는 엔진: %r (stub|nanobanana 만 허용)" % (engine,))
    # F1(C): --domain <규제도메인>(선택). 셸이 선언 도메인을 넘긴다. 미지정이면 None(화장품처럼 굽기 — 후방호환).
    domain = None
    if "--domain" in args:
        j = args.index("--domain") + 1
        if j >= len(args):
            sys.exit("--domain 뒤에 값이 필요합니다 (예: cosmetic|drug|quasi_drug|health_food)")
        domain = args[j] or None
    m = generate_all(rid, rdir, engine, domain)
    print("[image-engine] engine=%s · assets=%d → 04-keyvisual/generated/" % (engine, len(m["assets"])))


if __name__ == "__main__":
    main()
