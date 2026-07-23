#!/usr/bin/env python3
"""check_render_refs.py — 키비주얼이 참조하는 생성 이미지 검사 (렌더와 동일 해석).

두 가지를 본다(둘 중 하나라도 위반이면 비0 종료 = 렌더 차단):

(1) 생성 이미지 '존재성'(깊이) 검사 — 옛 단계 A.
   키비주얼 HTML/CSS 는 자사 생성이미지를 상대경로로 참조한다(예: ../../generated/NN-type.png
   = run_dir/04-keyvisual/generated/ 아래). 렌더(render.py)는 page.goto("file://"+<HTML 절대경로>) 로 열어,
   브라우저가 ref 를 '그 파일이 든 디렉터리 기준'으로 푼다. 따라서 ref 의 상대깊이(../ 개수)가
   틀리면 실제 파일을 못 찾아 '깨진 <img>' 가 되어도 렌더는 조용히 통과한다.
   옛 검사는 ref 의 ../ 를 통째로 버리고 파일명(tail)만 고정 베이스에 붙여 존재만 봐서, 깊이가
   틀린 경로(예: ../×1, 정답 ../×2)도 같은 tail 로 붕괴해 거짓 통과시켰다(실런 사고). 이 검사는
   렌더와 똑같이 'ref 가 든 파일의 디렉터리 기준'으로 절대경로를 풀어 디스크에 있는지 확인한다.

(2) html_only 그래픽 블록의 생성 PNG 역참조 검사 — 그래픽 블록의 생성 PNG 를 <img> 로 참조하면 **무조건** 막는다.
   ⚠ **F1(C) 규제안전(2026-07-06, docs/keyvisual-image-safety-fixes-plan.md — 2026-07-05 핸드오프 예외 회수):**
   확산모델은 그래픽/인포그래픽에 없는 인증(FDA)·수상·순위·수치를 창작(환각)해 굽는다. 그 baked PNG 를 옵션 HTML
   <img> 로 참조하면 shots 스크린샷 → 협회 제출 패키지로 허위표시가 새므로, **매니페스트 실재 여부·도메인과 무관하게
   전 도메인 균일 금지**한다(그래픽 블록은 인라인 SVG/HTML 텍스트 레이어로만 구성). 규제도메인(drug/quasi_drug/
   health_food)은 image_engine 이 애초에 미생성, 화장품은 디자이너 참고로 굽되 참조 금지. render_mode 필드가 없는
   블록(사진형)은 후방호환 제외(그 생성 PNG 참조는 정당 — 사진 위 텍스트는 HTML 오버레이).

범위(존재성): 04-keyvisual/generated/ 참조(생성물)만 검사한다(폰트·자사컷·도형박스는 보류).
디코드는 img_lint._refs 공용 SSoT 를 재사용한다(엔티티·percent·CSS-escape·역슬래시 정규화).

읽기전용: state.json·산출물·디스크에 아무것도 쓰지 않는다. 위반이 있으면 사유 출력 후 종료할 뿐이다.

사용: check_render_refs.py <options_dir> <harness_root>
exit 0 = 모든 생성이미지 참조가 디스크에 존재하고, html_only 블록의 생성이미지를 참조하지 않음(또는 검사 대상 없음).
exit 1 = (1) 깊이 오류/누락으로 디스크에 없는 생성이미지 참조가 1건 이상, 또는
         (2) html_only 블록의 생성이미지를 참조하는 곳이 1건 이상(렌더 차단 대상).
"""
import sys, os, json


def _find_run_dir(odir):
    """options_dir 에서 run 디렉터리를 유도한다. options_dir = <run>/04-keyvisual/options
    (또는 그 하위) 형태이므로, 경로를 위로 거슬러 올라가며 '04-keyvisual' 세그먼트를 찾고 그 부모를
    run 디렉터리로 본다. 못 찾으면 None(역참조 검사는 건너뛰고 존재성 검사는 계속)."""
    cur = os.path.abspath(odir)
    # 루트까지 올라가며 basename 이 '04-keyvisual' 인 디렉터리를 찾는다.
    while True:
        if os.path.basename(cur) == "04-keyvisual":
            run = os.path.dirname(cur)
            return run if run and run != cur else None
        parent = os.path.dirname(cur)
        if parent == cur:    # 파일시스템 루트 도달
            return None
        cur = parent


def _html_only_stems(run_dir):
    """plan 디렉터리를 읽어 visual.render_mode == "html_only" 인 블록의 생성이미지 파일명 stem
    집합을 반환한다. stem = image_engine 과 동일 규칙 'NN-type'(예: 04-rtbSummary). plan 부재·읽기
    실패면 빈 집합(역참조 검사 사실상 no-op → 존재성 검사만 작동)."""
    stems = set()
    if not run_dir:
        return stems
    pdir = os.path.join(run_dir, "03-storyboard", "plan")
    if not os.path.isdir(pdir):
        return stems
    for fn in sorted(os.listdir(pdir)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(pdir, fn), encoding="utf-8") as f:
                b = json.load(f)
        except (ValueError, OSError):
            continue
        if not isinstance(b, dict):
            continue
        vis = b.get("visual")
        vis = vis if isinstance(vis, dict) else {}
        # 공유 계약: render_mode == "html_only" 인 블록만 역참조 금지 대상.
        #   chart_data 블록(인라인 SVG 차트)은 image_engine 이 알아서 제외하므로 여기 대상 아님 —
        #   오직 render_mode == "html_only" 만 본다(_block_emits_image import 하지 않음).
        if vis.get("render_mode") != "html_only":
            continue
        order, typ = b.get("order"), b.get("type")
        if order is None or not typ:
            continue
        try:
            stems.add("%02d-%s" % (int(order), typ))
        except (ValueError, TypeError):
            continue
    return stems


# (F1(C) 회수) _manifest_basenames·_is_valid_png_file 는 '매니페스트 실재 html_only PNG 참조 예외'(2026-07-05
#   핸드오프) 전용 헬퍼였으나, 그 예외가 회수돼(그래픽 블록은 전 도메인 균일 참조 금지) 더는 쓰이지 않으므로 제거했다.


def _gen_stem(resolved, gen_root):
    """resolved(참조를 base 로 resolve 한 절대·정규 경로)가 생성이미지 참조면 파일명 stem('NN-type')을,
    아니면 None(확장자 png/svg 제거). 판정은 **경로기반**(substring 마커 폐기 — per-run 계약):
      (a) resolved 가 run_dir/04-keyvisual/generated(gen_root) 하위 = 정상 참조.
      (b) resolved 의 부모 디렉터리 basename == 'generated' = 깊이 틀린 참조도 같은 'generated/파일'
          tail 을 가지므로 여기서 잡아 존재성 게이트로 넘긴다(깊이 오류 fail-closed 보존 —
          test-render-existence-depth 회귀 의도). 자사컷(inputs/assets/…)·폰트(assets/fonts/…)·
          크롤원본(bundle/…)은 부모가 generated 가 아니라 제외.
      (c) 구 레이아웃(inputs/assets/generated/<id>/…) stale 참조도 생성물로 판정 → 존재성 게이트로
          fail-closed. 프롬프트/HTML 드리프트로 옛 경로가 남으면 파일이 새 위치(04-keyvisual/generated)로
          옮겨져 옛 위치엔 없다 → missing 으로 렌더 차단(조용한 깨진 <img> 통과 금지; Codex P1)."""
    rp = os.path.realpath(resolved)
    under = bool(gen_root) and (rp == gen_root or rp.startswith(gen_root + os.sep))
    parent_gen = os.path.basename(os.path.dirname(resolved)) == "generated"
    legacy = "/inputs/assets/generated/" in rp.replace(os.sep, "/")
    if not (under or parent_gen or legacy):
        return None
    return os.path.splitext(os.path.basename(resolved))[0]


def main():
    odir, root = sys.argv[1], sys.argv[2]
    # img_lint._refs 의 디코드 로직을 재사용한다(디코드 이원화 금지 — 공용 SSoT).
    sys.path.insert(0, os.path.join(root, "scripts", "lib"))
    from img_lint import _refs  # src/srcset/url() 추출 + 엔티티/percent/CSS-escape 디코드

    # (2) 역참조 검사 준비 — options_dir 에서 run·plan 을 유도해 html_only 블록 stem 집합을 만든다.
    #   유도/plan 부재면 빈 집합 → 역참조 검사는 no-op 이고 (1) 존재성 검사는 계속된다(견고하게 skip).
    run_dir = _find_run_dir(odir)
    # per-run 계약: 생성물 경계 = run_dir/04-keyvisual/generated. run_dir 못 찾으면 gen_root=None →
    #   containment 판정은 (b) 부모-basename 폴백으로만 작동(깊이 검출 보존).
    gen_root = os.path.realpath(os.path.join(run_dir, "04-keyvisual", "generated")) if run_dir else None
    # 역참조 금지집합 = plan 의 html_only 그래픽 블록 stem. **F1(C): 매니페스트 예외 회수(2026-07-05 핸드오프 부분 역전,
    #   docs/keyvisual-image-safety-fixes-plan.md).** 이제 html_only 블록의 생성 PNG 는 매니페스트 실재 여부·도메인과
    #   무관하게 **전 도메인 균일 참조 금지** — 확산모델이 그래픽에 환각한 허위 인증·순위·수치가 구워진 PNG 가 옵션 HTML
    #   <img> → shots 스크린샷 → 협회 제출 패키지로 새는 것을 차단한다. 그래픽 블록은 인라인 SVG/HTML 텍스트 레이어로만
    #   구성해야 한다(규제도메인은 애초에 미생성, 화장품은 디자이너 참고로 굽되 참조 금지).
    html_only = _html_only_stems(run_dir)

    missing = []      # (1) 존재성 위반
    forbidden = []    # (2) html_only 역참조 위반
    if os.path.isdir(odir):
        for r, _d, fs in os.walk(odir):
            for fn in fs:
                if not (fn.endswith(".html") or fn.endswith(".css")):
                    continue
                fpath = os.path.join(r, fn)
                text = open(fpath, encoding="utf-8", errors="ignore").read()
                # base = 스캔 중인 파일의 디렉터리. 렌더 base 와 동일하다 — HTML 인라인 <style>
                #   이면 HTML 디렉터리, 별도 .css 면 그 CSS 디렉터리로 자연히 정확해진다.
                base = os.path.dirname(os.path.abspath(fpath))
                for ref in _refs(text):
                    if ref.startswith(("data:", "http://", "https://", "//")):
                        continue  # data URI·외부 URL 은 로컬 검사 대상 아님
                    clean = ref.split("?", 1)[0].split("#", 1)[0]  # query/fragment 제거
                    # ref 가 든 파일의 디렉터리 기준으로 해석(렌더와 동일). clean 이 절대경로(/...)면
                    #   os.path.join 이 base 를 버리고 절대경로를 그대로 쓴다 — file:// 에서 절대 ref 가
                    #   FS 루트로 풀리는 것과 일치하므로 별도 분기 없이 그대로 둔다.
                    resolved = os.path.normpath(os.path.join(base, clean))
                    # 생성물 참조 판정 = resolved 가 run_dir/04-keyvisual/generated 하위(또는 부모가 generated)
                    #   경로기반(substring 마커 폐기). 폰트·자사컷·크롤원본은 여기서 제외된다.
                    stem = _gen_stem(resolved, gen_root)
                    if stem is None:
                        continue  # 생성물 참조만 검사(폰트·자사컷·도형박스 무관)
                    if stem in html_only:
                        # (2) F1(C): html_only 그래픽 블록의 생성이미지는 **매니페스트 실재·도메인과 무관하게 무조건 금지**.
                        #   옵션 HTML/CSS 는 그래픽 블록을 인라인 SVG/HTML 로만 구성해야 한다(허위 인증·순위·수치가 구워진
                        #   PNG 의 shots→패키지 누수 차단). 존재성도 따지지 않는다(어차피 차단) — 2026-07-05 핸드오프 예외 회수.
                        forbidden.append((fpath, ref, stem))
                        continue
                    # (1) 존재성 — resolved 가 디스크에 없으면 깊이 오류/미생성.
                    if not os.path.isfile(resolved):
                        missing.append((fpath, ref, resolved))

    fail = False
    if forbidden:
        fail = True
        sys.stderr.write(
            "[html_only 블록 이미지 참조 금지 위반] 아래 블록은 인라인 SVG·HTML 로만 구성해야 하는데 "
            "생성 이미지를 참조합니다(라벨/텍스트 변질 위험 — 렌더 차단):\n")
        for fpath, ref, stem in forbidden:
            try:
                rel = os.path.relpath(fpath, root)
            except ValueError:
                rel = fpath
            sys.stderr.write(
                "  - %s 가 그래픽 전용 블록 '%s' 의 생성 이미지 '%s' 를 참조합니다. "
                "이 블록의 <img> 참조를 빼고 인라인 SVG/HTML 로만 구성하세요.\n" % (rel, stem, ref))

    if missing:
        fail = True
        sys.stderr.write("[생성 이미지 존재성 검사 실패] 아래 참조가 디스크에 없습니다(경로 깊이 오류 또는 미생성):\n")
        for fpath, ref, resolved in missing:
            try:
                rel = os.path.relpath(fpath, root)
            except ValueError:
                rel = fpath
            sys.stderr.write(
                "  - %s 의 이미지 경로 '%s' 가 '%s' 로 풀렸는데 그 파일이 없습니다.\n" % (rel, ref, resolved)
            )

    if fail:
        sys.exit(1)

    print("[생성 이미지 참조 검사 통과] 키비주얼이 참조하는 생성 이미지가 모두 디스크에 있고, "
          "그래픽 전용(html_only) 블록의 생성 이미지를 참조하지 않습니다.")
    sys.exit(0)


if __name__ == "__main__":
    main()
