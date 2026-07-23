#!/usr/bin/env python3
"""check_asset_paths.py — 자산 경로 안전성 검사 (저작권 traversal 우회 차단).

스키마의 `^inputs/assets/` prefix 정규식만으로는 `inputs/assets/../bundle/images/...` 같은
경로 traversal 을 막지 못한다. 이 검사는 realpath 기준으로 run_dir/inputs/assets(자사) 또는
run_dir/04-keyvisual/generated(생성물) 하위인지 확인하고, `..`·절대경로·percent-encoding·
역슬래시를 거부한다(fail-closed). 해석 기준 base = run_dir(per-run 계약; ROOT 기준 폐기).

대상(M3: tone 서브스테이지 흡수 — plan visual.concept 만):
  03-storyboard/plan/*.json               → visual.concept.reference.own_asset_path (inputs/assets/ 하위)
  04-keyvisual/image-manifest.json        → assets[].path  (04-keyvisual/generated/ 하위)

사용: check_asset_paths.py <run_dir>   (위반 있으면 exit 1 + 사유 출력)
"""
import sys, os, json, glob


def _unsafe_reason(p, rdir):
    if not isinstance(p, str) or not p:
        return "비어있거나 문자열 아님"
    if p.startswith("/") or (len(p) > 1 and p[1] == ":"):
        return "절대경로 금지"
    if ".." in p:
        return "상위경로(..) 금지"
    if "%" in p:
        return "percent-encoding 금지"
    if "\\" in p:
        return "역슬래시 금지"
    if any(ch in p for ch in '"\'<>'):
        return "따옴표/꺾쇠 금지(HTML 속성 인젝션)"
    if any(ord(ch) < 0x20 for ch in p):
        return "제어문자 금지"
    # per-run 계약: 허용 정규경로 prefix = 자사 자산(inputs/assets/) 또는 생성물(04-keyvisual/generated/).
    if not (p.startswith("inputs/assets/") or p.startswith("04-keyvisual/generated/")):
        return "inputs/assets/(자사) 또는 04-keyvisual/generated/(생성물) 하위만 허용"
    assets_root = os.path.realpath(os.path.join(rdir, "inputs", "assets"))
    gen_root = os.path.realpath(os.path.join(rdir, "04-keyvisual", "generated"))
    real = os.path.realpath(os.path.join(rdir, p))
    under_assets = real == assets_root or real.startswith(assets_root + os.sep)
    under_gen = real == gen_root or real.startswith(gen_root + os.sep)
    if not (under_assets or under_gen):
        return "realpath 가 자사 자산/생성물 밖(크롤원본/외부 의심): %s" % real
    return None


def _collect(rdir):
    paths = []   # (source_file, path)
    for pf in sorted(glob.glob(os.path.join(rdir, "03-storyboard/plan/*.json"))):
        try:
            b = json.load(open(pf, encoding="utf-8"))
        except Exception:
            continue
        r = ((b.get("visual") or {}).get("concept") or {}).get("reference") or {}
        if r.get("own_asset_path") is not None:
            paths.append((pf, r["own_asset_path"]))
    im = os.path.join(rdir, "04-keyvisual/image-manifest.json")
    if os.path.exists(im):
        try:
            for a in json.load(open(im, encoding="utf-8")).get("assets", []):
                if a.get("path") is not None:
                    paths.append((im, a["path"]))
        except Exception:
            pass
    return paths


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: check_asset_paths.py <run_dir>")
    rdir = sys.argv[1]
    bad = []
    for src, p in _collect(rdir):
        reason = _unsafe_reason(p, rdir)
        if reason:
            bad.append((os.path.relpath(src, rdir), p, reason))
    if bad:
        sys.stderr.write("[자산경로 검사 실패] 안전하지 않은 경로(저작권/traversal):\n")
        for src, p, reason in bad:
            sys.stderr.write("  - %s :: '%s' → %s\n" % (src, p, reason))
        sys.exit(1)
    print("[자산경로 검사 통과] 모든 own_asset_path/생성물 경로가 inputs/assets 또는 04-keyvisual/generated 하위(안전).")


if __name__ == "__main__":
    main()
