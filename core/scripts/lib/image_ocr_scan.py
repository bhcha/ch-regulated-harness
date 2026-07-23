#!/usr/bin/env python3
"""image_ocr_scan.py — 생성 이미지 픽셀-텍스트 금지어 스캔 (F4, NARROW).

이것은 **좁은 deny-list 픽셀 점검**이지 OCR 품질 게이트가 아니다.
  - 스타일화된 글리프(장식체·왜곡·저대비)로 OCR 이 놓치는 금지어(miss)와, 근거 스크린샷(시험성적서
    이미지 등)에 찍힌 금지어 문자열이 오탐(false-hit)으로 잡히는 것은 **설계상 수용**한다.
  - 목적은 확산모델이 이미지에 '구워낸' 명백한 금지 표현을, 화면에 실려 나가는(deliverable-visible)
    선택안 이미지에서 값싸게 한 번 훑어 잡아 심의(다른 세션 원격 ADK)와 별개의 결정적 룰엔진 신호를
    추가하는 것뿐이다. **범위를 넓히지 말 것**(triggers/zero_voc/functional_efficacy 등 절대 미포함).

매칭 범위(하드 요구):
  - 오직 기존 금지 3계열만 — drug_misperception.banned · consumer_deception.banned(core 토큰 = "(" 앞)
    · prescription_otc_distinction.banned. (triggers/zero_voc/func_efficacy 는 절대 포함 금지.)
  - 매칭은 `_spaceless` 정확-부분문자열만(OCR 공백 잡음 흡수). 숫자 placeholder `_match` 는 쓰지 않는다
    (오탐 최소화).

대상 이미지:
  - 선택안(decision.selected) HTML(+ 같은 폴더 styles.css)이 참조하는 04-keyvisual/generated/*.png 와
    직접 참조된 inputs/assets/** 래스터(png/jpg/jpeg/webp)만. 비-래스터(svg)·원격(data:/http)은 무시.
  - ref 추출은 img_lint._refs 공용 SSoT 를 재사용한다(HTML 파싱 재구현 금지).

골든 바이트 불변 게이트:
  - 04-keyvisual/image-manifest.json 이 존재하고 engine 이 실엔진 'nanobanana' 일 때만 스캔한다.
  - stub/오프라인(engine=stub, SVG 자산)이면 스캔 자체를 건너뛴다 → 오프라인 verdict 바이트 불변,
    CI 에 tesseract 불필요.

tesseract 부재 정책(fail-closed):
  - 스캔이 돌아야 하는데(실엔진 PNG 참조 존재) tesseract 가 없으면 조용한 강등이 아니라 SystemExit 로
    멈춘다(설치 힌트 동반). 선례: ingest.py poppler·intake.sh unzip.
"""
import os
import sys
import shutil
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 래스터 확장자(대상). generated 는 png 만, inputs/assets 는 아래 래스터 전부.
_RASTER_EXT = (".png", ".jpg", ".jpeg", ".webp")

_REAL_ENGINE = "nanobanana"

# 매칭 대상 금지 3계열(축 이름). NARROW: 여기에 축을 늘리지 말 것.
_AXES = ("drug_misperception", "consumer_deception", "prescription_otc_distinction")


def _manifest_engine(rdir):
    """04-keyvisual/image-manifest.json 의 engine 값. 부재/파싱실패 → None."""
    p = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
    if not os.path.isfile(p):
        return None
    try:
        import json
        with open(p, encoding="utf-8") as f:
            return json.load(f).get("engine")
    except (ValueError, OSError):
        return None


def _selected_option_dir(rdir):
    """decision.selected 로 지목된 선택안 옵션 디렉터리(존재 시). 부재/손상 → None.
       (심의는 선택 뒤라 04-keyvisual 심의 시점엔 decision 이 있다 — 부재면 스캔 대상 없음.)"""
    import json
    dec = os.path.join(rdir, "04-keyvisual", "decision.json")
    if not os.path.isfile(dec):
        return None
    try:
        with open(dec, encoding="utf-8") as f:
            sel = json.load(f).get("selected")
    except (ValueError, OSError):
        return None
    if not sel:
        return None
    odir = os.path.join(rdir, "04-keyvisual", "options", str(sel))
    return odir if os.path.isdir(odir) else None


def _collect_targets(rdir, opt_dir):
    """선택안 HTML(+ styles.css)이 참조하는 래스터 대상(디스크에 실재하는 것만)을 절대경로 리스트로.
       ref 디코드는 img_lint._refs 재사용(디코드 이원화 금지). 경계 판정은 check_render_refs 와 동일한
       '경로 containment'(generated/ 하위, 또는 inputs/assets/ 하위)."""
    from img_lint import _refs  # src/srcset/url() 추출 + 엔티티/percent/CSS-escape 디코드(공용 SSoT)

    gen_root = os.path.realpath(os.path.join(rdir, "04-keyvisual", "generated"))
    assets_root = os.path.realpath(os.path.join(rdir, "inputs", "assets"))

    targets = []       # 절대경로(정규), 순서 보존
    seen = set()
    for fn in ("index.html", "styles.css"):
        fpath = os.path.join(opt_dir, fn)
        if not os.path.isfile(fpath):
            continue
        try:
            text = open(fpath, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        base = os.path.dirname(os.path.abspath(fpath))   # 렌더와 동일 base(파일이 든 디렉터리)
        for ref in _refs(text):
            if ref.startswith(("data:", "http://", "https://", "//")):
                continue   # 원격/data URI 는 로컬 스캔 대상 아님
            clean = ref.split("?", 1)[0].split("#", 1)[0]   # query/fragment 제거
            if not clean:
                continue
            resolved = os.path.realpath(os.path.normpath(os.path.join(base, clean)))
            ext = os.path.splitext(resolved)[1].lower()
            under_gen = resolved == gen_root or resolved.startswith(gen_root + os.sep)
            under_assets = resolved == assets_root or resolved.startswith(assets_root + os.sep)
            if under_gen and ext == ".png":
                pass                      # 생성 이미지 = png 만
            elif under_assets and ext in _RASTER_EXT:
                pass                      # 자사 자산 = 래스터 전부
            else:
                continue                  # 비-래스터(svg)·폰트·크롤원본·경계 밖 무시
            if not os.path.isfile(resolved):
                continue                  # 디스크에 없으면 OCR 대상 아님(존재성은 check_render_refs 소관)
            if resolved not in seen:
                seen.add(resolved)
                targets.append(resolved)
    return targets


def _ocr(path, tess, cache):
    """이미지 1장 OCR(경로별 1회 캐시). tesseract <png> stdout -l kor+eng --psm 6.
       도구 자체가 아니라 개별 이미지 처리 실패(손상 래스터 등)는 빈 텍스트로 관대 처리(스타일 miss 와 동급 —
       설계상 수용). 도구 부재(tess=None)는 호출부에서 이미 fail-closed."""
    if path in cache:
        return cache[path]
    text = ""
    try:
        r = subprocess.run([tess, path, "stdout", "-l", "kor+eng", "--psm", "6"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if r.returncode == 0 and r.stdout:
            text = r.stdout.decode("utf-8", errors="ignore")
    except OSError:
        text = ""
    cache[path] = text
    return text


def _tesseract_has_lang(tess, lang):
    """tesseract 가 <lang> 언어팩을 보유하면 True. `tesseract --list-langs` 는 버전에 따라
       stdout/stderr 로 갈리므로 합쳐 판정한다. 실행 실패(OSError)면 False(= 없음 취급 → fail-closed)."""
    try:
        r = subprocess.run([tess, "--list-langs"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = r.stdout.decode("utf-8", errors="ignore") if r.stdout else ""
    except OSError:
        return False
    return lang in out.split()


def _banned_needles(axes):
    """금지 3계열 → [(hit_term, needle_spaceless, axis)]. consumer_deception 만 "(" 앞 core 토큰
       (scan_text 와 동일 파생). 빈 needle 은 제외."""
    from kcia_engine import _spaceless   # 정규화 SSoT(공백/마크다운 제거) 재사용
    out = []
    for axis in _AXES:
        for b in (axes.get(axis, {}) or {}).get("banned", []) or []:
            term = b.split("(")[0] if axis == "consumer_deception" else b
            ns = _spaceless(term)
            if ns:
                out.append((term, ns, axis))
    return out


def scan(rdir, axes):
    """선택안 이미지의 픽셀 텍스트에서 금지 3계열을 훑어 findings 반환.
       각 finding = {"image_path": <런상대경로>, "hit_term": <매칭어>, "axis": <축>}.
       게이트/부재/미대상이면 빈 리스트(오프라인·stub 골든 바이트 불변)."""
    # (게이트) 실엔진 매니페스트일 때만 — stub/오프라인은 스캔 자체 건너뜀.
    if _manifest_engine(rdir) != _REAL_ENGINE:
        return []
    opt_dir = _selected_option_dir(rdir)
    if not opt_dir:
        return []
    targets = _collect_targets(rdir, opt_dir)
    if not targets:
        return []   # 스캔할 실엔진 래스터 참조 없음 → tesseract 불요

    # (fail-closed) 스캔이 돌아야 하는데 tesseract 부재 = 조용한 강등 금지.
    tess = shutil.which("tesseract")
    if not tess:
        raise SystemExit(
            "[image-ocr] 생성 이미지 픽셀 금지어 점검을 해야 하는데 tesseract(OCR)가 설치돼 있지 않습니다 "
            "(설치: brew install tesseract tesseract-lang / apt-get install tesseract-ocr tesseract-ocr-kor). "
            "선언한 점검을 조용히 누락하지 않고 멈춥니다.")
    # (fail-closed) 언어팩 결손 = 픽셀 금지어를 통째로 못 읽는 '점검 불능'이므로 도구 부재와 동급으로 멈춘다.
    #   OCR 은 `-l kor+eng` 로 돌리므로 kor·eng '둘 다' 있어야 한다 — 하나라도 없으면 해당 언어 텍스트가 조용히 새거나
    #   OCR 이 비-0 종료 후 _ocr 가 빈 텍스트로 흡수해 조용히 통과한다. 개별 이미지 처리 실패(관대 처리)와 달리
    #   언어팩 결손은 '설정 불능'이므로 여기서 preflight 로 막는다.
    _missing = [lg for lg in ("kor", "eng") if not _tesseract_has_lang(tess, lg)]
    if _missing:
        raise SystemExit(
            "[image-ocr] tesseract 는 있으나 OCR 언어 데이터(%s)가 없어 픽셀 금지어를 점검할 수 없습니다 "
            "(OCR 은 -l kor+eng 로 동작). 설치: brew install tesseract-lang / "
            "apt-get install tesseract-ocr-kor tesseract-ocr-eng. "
            "언어팩 결손으로 점검을 조용히 누락하지 않고 멈춥니다." % "+".join(_missing))

    needles = _banned_needles(axes)
    if not needles:
        return []

    from kcia_engine import _spaceless
    rroot = os.path.realpath(rdir)
    cache = {}
    findings = []
    fseen = set()
    for path in targets:
        sless = _spaceless(_ocr(path, tess, cache))
        if not sless:
            continue
        try:
            rel = os.path.relpath(path, rroot)
        except ValueError:
            rel = path
        for hit_term, ns, axis in needles:
            if ns in sless:
                key = (rel, hit_term, axis)
                if key not in fseen:
                    fseen.add(key)
                    findings.append({"image_path": rel, "hit_term": hit_term, "axis": axis})
    return findings
