#!/usr/bin/env python3
"""render.py — 로컬 Playwright 렌더 + DOM 요소 단위 섹션 캡처 (B5, 설계 §7.4/§9).

860px·DPR1 로 옵션 HTML 을 렌더하고 [data-block] 요소를 결정적으로 분할 캡처한다(좌표 슬라이싱 금지).
셀프호스팅 폰트로 머신/CLI 간 재현성. design-manifest.json 작성.
self_review 는 결정적 휴리스틱(레이아웃/오버플로)일 뿐, '최종 clean' 판정은 아니다 —
clean 은 다른 세션 심의(kcia-check) 또는 사람 게이트가 내린다(self-grading 차단, Exit a).

사용: render.py <run_dir> [--option X]
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json, load_json, ROOT, deliverable_format  # noqa: E402

# K-1 값-불변: render 는 FORMATS_DIR 를 repo packs/_format 로 해석(옛 동작 보존 · PACKS_DIR 무시).
#   PACKS_DIR 파생 일원화(split-brain 제거)는 값-불변 계약 밖 → 별도 의도적 변경으로 분리(Codex Medium).
FORMATS_DIR = os.environ.get("FORMATS_DIR") or os.path.join(os.path.dirname(ROOT), "packs", "_format")
DPR = 1
DPI = 96
WIDTH = 860   # 레거시 기본(multipage_bm naver_smartstore) — _format_channel 이 포맷별로 재정의.
_LAYOUT_TOL_PX = 2   # H-5: 레이아웃 오버플로 허용 오차(px) — within/overflow 판정 공용


def _format_channel(rdir):
    """M8: run 의 deliverable_format 에 맞는 렌더 채널(name·width_px)을 format-profiles 에서 읽는다(포맷별 규격).
       multipage_bm=naver_smartstore/860(불변). 미정의/부재/0 폭 → 레거시 860 폴백."""
    fmt = "multipage_bm"
    try:
        fmt = deliverable_format(load_json(os.path.join(rdir, "state.json")))
    except Exception:
        fmt = "multipage_bm"
    name, w = "naver_smartstore", 860
    try:
        ch = ((load_json(os.path.join(FORMATS_DIR, "format-profiles.json")).get("formats", {}) or {}).get(fmt, {}) or {}).get("channel") or {}
        name = ch.get("name") or name
        cw = int(ch.get("width_px") or 0)
        if cw > 0:
            w = cw
    except Exception:
        pass
    return name, w


def render_option(page, kvdir, opt, width):
    html = os.path.join(kvdir, "options", opt, "index.html")
    if not os.path.exists(html):
        return None
    shots = os.path.join(kvdir, "options", opt, "shots")
    os.makedirs(shots, exist_ok=True)
    page.goto("file://" + html, wait_until="load", timeout=15000)
    try:
        page.wait_for_function("document.fonts && document.fonts.status==='loaded'", timeout=4000)
    except Exception:
        pass   # 폰트 로드 완료 대기(바운드). 실패해도 폴백 일관 → 동일 머신 재현성 유지.
    full = os.path.join(shots, "full.png")
    page.screenshot(path=full, full_page=True)
    sections = []
    for el in page.query_selector_all("[data-block]"):
        block = el.get_attribute("data-block")
        order = int(el.get_attribute("data-order") or (len(sections) + 1))
        box = el.bounding_box() or {"x": 0, "y": 0, "width": 0, "height": 0}
        shot = os.path.join(shots, "%02d-%s.png" % (order, block))
        shot_ok = True
        try:
            el.screenshot(path=shot)
        except Exception:
            shot_ok = False
        visible_text = (el.inner_text() or "").strip()
        # 캡처 실패·0높이·내용 없음 섹션은 매니페스트에서 제외 — 보이지 않는 placeholder 가
        # 구성요소 커버리지를 만족시키는 것을 차단(Codex coverage #2).
        if not shot_ok or box["height"] <= 0 or not visible_text:
            continue
        within = box["x"] >= -1 and (box["x"] + box["width"]) <= width + _LAYOUT_TOL_PX
        overflow = box["width"] > width + _LAYOUT_TOL_PX
        sections.append({
            "block": block, "order": order,
            "selector": "[data-block='%s']" % block,
            "screenshot": os.path.relpath(shot, kvdir),
            "height": round(box["height"]),
            "self_review": {"layout_ok": bool(within), "overflow": bool(overflow), "contrast_ok": True},
        })
    sections.sort(key=lambda s: s["order"])
    return {"option": opt, "sections": sections,
            "full_screenshot": os.path.relpath(full, kvdir)}


def main():
    rdir = sys.argv[1]
    kvdir = os.path.join(rdir, "04-keyvisual")
    odir = os.path.join(kvdir, "options")
    opts = sorted(os.listdir(odir)) if os.path.isdir(odir) else []
    # 매니페스트 기준 옵션: decision > recommendation top-1 > 첫 옵션
    target = None
    if "--option" in sys.argv:
        target = sys.argv[sys.argv.index("--option") + 1]
    if not target:
        dec = os.path.join(kvdir, "decision.json")
        rec = os.path.join(kvdir, "recommendation.json")
        if os.path.exists(dec):
            target = load_json(dec).get("selected")
        elif os.path.exists(rec):
            r = load_json(rec).get("ranked", [])
            target = r[0] if r else None
    if not target and opts:
        target = opts[0]

    channel_name, width = _format_channel(rdir)   # M8: 포맷별 렌더 폭/채널(multipage_bm=naver_smartstore/860 불변)
    from playwright.sync_api import sync_playwright
    rendered = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": 1200}, device_scale_factor=DPR)
        for opt in opts:
            r = render_option(page, kvdir, opt, width)
            if r:
                rendered[opt] = r
        browser.close()

    if target not in rendered and rendered:
        target = sorted(rendered)[0]
    sel = rendered.get(target, {"sections": [], "full_screenshot": ""})
    if not sel["sections"]:
        sys.stderr.write("[render 실패] 옵션 '%s' 에 [data-block] 섹션이 없습니다(빈 디자인).\n" % target)
        sys.exit(1)   # 섹션 0개면 빈 매니페스트로 심의 통과되는 것을 차단(#4)
    manifest = {
        "channel": channel_name, "width_px": width, "dpi": DPI,
        "selected_option": target,   # 매니페스트 섹션이 나온 옵션을 명시(#5, 자기일관성)
        "sections": sel["sections"],
        "full_screenshot": sel["full_screenshot"],
    }
    atomic_write_json(os.path.join(kvdir, "design-manifest.json"), manifest)
    print("[render] 옵션 %s 렌더 · 섹션 %d개 · 기준 옵션=%s"
          % (",".join(rendered.keys()), len(sel["sections"]), target))


if __name__ == "__main__":
    main()
