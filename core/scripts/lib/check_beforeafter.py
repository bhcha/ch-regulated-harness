#!/usr/bin/env python3
"""check_beforeafter.py — beforeAfter 섹션 내부에 개인차 디스클레이머 강제 (Codex B5 #2 · B-3 Seam C).

파일 어디에나 있는 게 아니라 해당 <section data-block="beforeAfter"> ... </section> 내부에 있어야 한다.
디스클레이머 = '개인차' + ('연출'[연출 이미지] 또는 '측정'[인체적용시험 측정 실사진]). B-3(Seam C): 측정
실사진(연출 아님)이 '연출'을 거짓 표기하지 않도록 측정용 고지를 허용(additive) — 종전 '연출' 리터럴 강제는
측정 실사진에 의미가 어긋났다. 기존 연출 경로는 보존(골든 불변).
사용: check_beforeafter.py <options_dir>  (exit 1 = 위반)
"""
import sys, os, re

SEC = re.compile(r'<section\b[^>]*\bdata-block\s*=\s*["\']?\s*beforeAfter\s*["\']?[^>]*>(.*?)</section>',
                 re.I | re.S)


def _ba_disclaimer_ok(s):
    """beforeAfter 개인차 디스클레이머 충족: '개인차' + ('연출'[연출컷] 또는 '측정'[측정 실사진])."""
    return ("개인차" in s) and ("연출" in s or "측정" in s)


def main():
    odir = sys.argv[1]
    bad = []
    if os.path.isdir(odir):
        for root, _, fnames in os.walk(odir):
            for fn in fnames:
                if not fn.endswith(".html"):
                    continue
                text = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read()
                # data-block 속성에 공백이 있어도 매칭(data-block = "beforeAfter")
                for m in SEC.finditer(text):
                    body = m.group(1)
                    if not _ba_disclaimer_ok(body):
                        bad.append("%s: beforeAfter 섹션 내 디스클레이머(개인차 + 연출/측정) 누락" % fn)
                # 섹션 정규식이 못 잡는 변형(공백 다수)도 보수적으로: beforeAfter 가 있는데 디스클레이머 전무
                if re.search(r'data-block\s*=\s*["\']?\s*beforeAfter', text, re.I) and not SEC.search(text):
                    if not _ba_disclaimer_ok(text):
                        bad.append("%s: beforeAfter 블록에 디스클레이머 누락" % fn)
    if bad:
        sys.stderr.write("[beforeAfter 검증 실패]\n" + "\n".join("  - " + b for b in bad) + "\n")
        sys.exit(1)
    print("[beforeAfter 검증 통과]")


if __name__ == "__main__":
    main()
