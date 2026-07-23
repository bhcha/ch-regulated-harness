#!/usr/bin/env python3
"""img_lint.py — 디자인 이미지 출처 allowlist 검증 (B5 저작권, Codex B5 #1).

denylist(grep) 대신 allowlist: 디자인 html/css 의 모든 리소스 참조(src/srcset/CSS url())를
HTML 엔티티·URL 인코딩 디코드 후 해석해, 다음만 허용한다:
  - 로컬(경로 containment, per-run): run_dir/04-keyvisual/generated/ (자사 생성물) · run_dir/inputs/assets/ (자사 자산)
  - 로컬(substring 폴백): assets/ (shared core/assets 폰트) · inputs/assets/ (자사 자산)
  - 원격: product.json 의 자사 제품 이미지 호스트(자사 URL)
  - data: URI
그 외(특히 inputs/bundle/ 크롤 원본, 미상 외부 URL)는 위반.
사용: img_lint.py <options_dir> [<product.json>]  (exit 1 = 위반)
"""
import sys, os, re, html
from urllib.parse import unquote, urlparse

ALLOW_LOCAL_PREFIX = ("assets/", "inputs/assets/")


def _find_run_dir(odir):
    """odir(= <run>/04-keyvisual/options[/...]) 에서 위로 '04-keyvisual' 세그먼트를 찾아 그 부모를 run 으로.
       못 찾으면 None(생성물/자사 자산 containment 판정은 건너뛰고 substring 폴백만 작동).
       check_render_refs._find_run_dir 와 동일 규칙(경로 containment 근거를 두 검사가 공유)."""
    cur = os.path.abspath(odir)
    while True:
        if os.path.basename(cur) == "04-keyvisual":
            run = os.path.dirname(cur)
            return run if run and run != cur else None
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def _refs(text):
    """src=, srcset=, CSS url() 의 모든 리소스 경로 추출(디코드)."""
    refs = []
    for m in re.finditer(r'src\s*=\s*["\']([^"\']+)["\']', text, re.I):
        refs.append(m.group(1))
    for m in re.finditer(r'srcset\s*=\s*["\']([^"\']+)["\']', text, re.I):
        for part in m.group(1).split(","):
            u = part.strip().split(" ")[0]
            if u:
                refs.append(u)
    for m in re.finditer(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', text, re.I):
        refs.append(m.group(1))
    # 디코드 순서 중요(Codex 5차): 엔티티 → 퍼센트 → CSS escape(\\2e 등) → 역슬래시 치환.
    #   역슬래시를 먼저 '/'로 바꾸면 '\\2e\\2e'(..) 우회를 놓친다.
    out = []
    for r in refs:
        d = unquote(html.unescape(r))
        d = re.sub(r"\\([0-9a-fA-F]{1,6})\s?", lambda x: chr(int(x.group(1), 16)), d)  # CSS escape 먼저
        d = d.replace("\\", "/")
        out.append(d)
    return out


def main():
    odir = sys.argv[1]
    product = sys.argv[2] if len(sys.argv) > 2 else None
    allow_hosts = set()
    if product and os.path.exists(product):
        try:
            import json
            mi = json.load(open(product)).get("mainImage", "")
            h = urlparse(mi).hostname
            if h:
                allow_hosts.add(h)
                # 동일 상위도메인 허용(shop-phinf/phinf.pstatic.net 등)
                parts = h.split(".")
                if len(parts) >= 2:
                    allow_hosts.add(".".join(parts[-2:]))
        except Exception:
            pass

    # per-run 계약: 생성물 = run_dir/04-keyvisual/generated · 자사 자산 = run_dir/inputs/assets.
    #   ref 를 파일 디렉터리 기준으로 resolve 해 이 두 루트 하위인지 경로 containment 로 허용(브리틀 substring 지양).
    run_dir = _find_run_dir(odir)
    gen_root = os.path.realpath(os.path.join(run_dir, "04-keyvisual", "generated")) if run_dir else None
    assets_root = os.path.realpath(os.path.join(run_dir, "inputs", "assets")) if run_dir else None

    violations = []
    if os.path.isdir(odir):
        for root, _, fnames in os.walk(odir):
            for fn in fnames:
                if not (fn.endswith(".html") or fn.endswith(".css")):
                    continue
                p = os.path.join(root, fn)
                text = open(p, encoding="utf-8", errors="ignore").read()
                for ref in _refs(text):
                    if ref.startswith("data:"):
                        continue
                    if ref.startswith(("http://", "https://", "//")):
                        host = urlparse(ref if "//" in ref[:8] else "http:" + ref).hostname or ""
                        # 정확 일치 또는 '.<도메인>' 서브도메인만 허용. endswith(a) 는 evilpstatic.net 우회라 제거(Codex 4차).
                        ok = any(host == a or host.endswith("." + a) for a in allow_hosts)
                        if not ok:
                            violations.append("%s: 허용되지 않은 외부 URL host '%s' (%s)" % (fn, host, ref[:60]))
                        continue
                    # 로컬 경로: 정규화해 inputs/assets|assets 하위인지(상대 ../ 해석)
                    norm = os.path.normpath(ref).replace("\\", "/").lstrip("./")
                    # ref 는 보통 ../../generated/... · ../../../inputs/assets/... · ../../../../assets/fonts/...
                    # 크롤 원본 denylist(먼저): 전역 시맨틱 마커(inputs/bundle/) + run별 격리 경로(00-ingest/bundle/) 둘 다 차단.
                    if ("inputs/bundle/" in ref or "inputs/bundle/" in norm
                            or "/00-ingest/bundle/" in ref or "/00-ingest/bundle/" in norm):
                        violations.append("%s: 크롤 원본 참조 금지 (%s)" % (fn, ref[:60])); continue
                    # 경로 containment(권장): ref 를 파일 디렉터리 기준으로 resolve 해 생성물/자사 자산 루트 하위면 허용.
                    clean = ref.split("?", 1)[0].split("#", 1)[0]
                    resolved = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(p)), clean))
                    under_gen = bool(gen_root) and (resolved == gen_root or resolved.startswith(gen_root + os.sep))
                    under_assets = bool(assets_root) and (resolved == assets_root or resolved.startswith(assets_root + os.sep))
                    if under_gen or under_assets:
                        continue  # 자사 생성물(04-keyvisual/generated/)·자사 자산(inputs/assets/) = 허용
                    # substring 폴백: 폰트(shared core/assets/fonts) 및 run_dir 미유도 상황 후방호환.
                    tail = ref.split("../")[-1]
                    if not (tail.startswith(ALLOW_LOCAL_PREFIX) or "/assets/" in ref or "/inputs/assets/" in ref):
                        violations.append("%s: 허용 출처(assets/ · inputs/assets/ · 04-keyvisual/generated/ · 자사 URL) 외 참조 (%s)" % (fn, ref[:60]))

    if violations:
        sys.stderr.write("[저작권 lint 실패]\n" + "\n".join("  - " + v for v in violations) + "\n")
        sys.exit(1)
    print("[저작권 lint 통과] 허용 출처만 사용")


if __name__ == "__main__":
    main()
