#!/usr/bin/env python3
"""render_options_md.py — 다안(select) 페이즈의 옵션 JSON → 사람용 파생 MD (개선계획 이슈3b).

문제: concept·storyboard-outline 의 안(옵션)은 JSON(rtb/key-message/storyline)으로만 산출되고, 사람이
선택 시점에 보는 건 raw JSON 경로뿐이었다(안별 본문 비교 문서 부재). storyboard-plan 은 이미 plan/NN.md 를
파생하는데(비대칭) 다안엔 그 패턴이 없었다.

해법: 'JSON=진실원천, MD=순수 파생 비교뷰'. 이 스크립트가 옵션 JSON 을 읽어
  - 옵션별 사람용 요약 `options/<key>/summary.md` (plan/NN.md 와 같은 '산출물 옆 파생' 관례)
  - 페이즈 단일 비교 인덱스 `options-compare.md` (모든 안 나란히 — 사용자 '나란히 비교' 요구)
를 만든다. **역방향(MD 손편집→JSON) 없음** — MD 는 읽기전용 뷰일 뿐 선택 입력원은 decision.json(select.sh).

안전: 모든 자유텍스트는 operator_labels.scrub 를 통과(내부 잭곤 노출 차단). 파생 실패는 fail-soft(파이프라인 비차단).
사용: render_options_md.py <run_id> <run_dir> <stage>   # stage = concept | storyboard-outline
"""
import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json  # noqa: E402
from operator_labels import scrub  # noqa: E402


def _txt(s):
    """자유텍스트를 현업 화면용으로 정리(내부 잭곤이면 빈 문자열 — 노출 안 함)."""
    s = (s or "").strip().replace("\n", " ")
    return scrub(s)


def _write(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ── 02-concept: 축별 옵션(key-message + rtb) ──────────────────────────
def _concept_option_summary(odir):
    """한 컨셉안(축 디렉터리)의 사람용 요약 라인들. (headline, body_lines) 반환."""
    km_p = os.path.join(odir, "key-message.json")
    rtb_p = os.path.join(odir, "rtb.json")
    heads, rtbs = [], []
    if os.path.exists(km_p):
        try:
            for m in (load_json(km_p).get("key_messages") or []):
                h = _txt(m.get("headline"))
                if h:
                    heads.append(h)
        except Exception:
            pass
    if os.path.exists(rtb_p):
        try:
            for r in (load_json(rtb_p).get("rtb") or []):
                c = _txt(r.get("claim"))
                if c:
                    rtbs.append(c)
        except Exception:
            pass
    return heads, rtbs


def _gen_concept(rdir):
    odir_root = os.path.join(rdir, "02-concept", "options")
    if not os.path.isdir(odir_root):
        return
    keys = sorted(d for d in os.listdir(odir_root) if os.path.isdir(os.path.join(odir_root, d)))
    compare = ["# 컨셉 안 비교 (눈으로 나란히 — 고르기 전 참고)", "",
               "> JSON 이 원본이고 이 문서는 읽기용 요약이에요. 고르기는 `select.sh` 로 합니다.", ""]
    for k in keys:
        odir = os.path.join(odir_root, k)
        heads, rtbs = _concept_option_summary(odir)
        # 옵션별 summary.md
        L = ["# 컨셉안 — %s" % k, ""]
        if heads:
            L += ["## 내세울 메시지"] + ["- %s" % h for h in heads] + [""]
        if rtbs:
            L += ["## 뒷받침 근거"] + ["- %s" % r for r in rtbs] + [""]
        if not heads and not rtbs:
            L += ["(요약할 내용이 아직 없어요)", ""]
        _write(os.path.join(odir, "summary.md"), L)
        # 비교 인덱스 한 섹션
        compare.append("## %s" % k)
        if heads:
            compare.append("- **메시지**: " + " · ".join(heads[:3]))
        if rtbs:
            compare.append("- **근거**: " + " · ".join(rtbs[:3]))
        compare.append("")
    _write(os.path.join(rdir, "02-concept", "options-compare.md"), compare)


# ── 03-storyboard outline: 옵션별 스토리라인(블록 전개 순서) ──────────
def _gen_storyboard_outline(rdir):
    odir_root = os.path.join(rdir, "03-storyboard", "outline", "options")
    if not os.path.isdir(odir_root):
        return
    keys = sorted(d for d in os.listdir(odir_root) if os.path.isdir(os.path.join(odir_root, d)))
    compare = ["# 스토리라인 안 비교 (전개 순서를 눈으로 나란히)", "",
               "> JSON 이 원본이고 이 문서는 읽기용 요약이에요. 고르기는 `select.sh` 로 합니다.", ""]
    for k in keys:
        sl_p = os.path.join(odir_root, k, "storyline.json")
        steps = []
        if os.path.exists(sl_p):
            try:
                for b in (load_json(sl_p).get("blocks") or []):
                    intent = _txt(b.get("intent"))
                    steps.append((b.get("order"), b.get("type"), intent))
            except Exception:
                pass
        L = ["# 스토리라인 — %s" % k, "", "## 전개 순서", ""]
        for (o, t, intent) in steps:
            L.append("%s. **%s**%s" % (o, t, (" — %s" % intent) if intent else ""))
        if not steps:
            L.append("(블록이 아직 없어요)")
        L.append("")
        _write(os.path.join(odir_root, k, "summary.md"), L)
        compare.append("## %s — 전개 순서" % k)
        compare.append(" → ".join(str(t) for (_o, t, _i) in steps) or "(없음)")
        compare.append("")
    _write(os.path.join(rdir, "03-storyboard", "outline", "options-compare.md"), compare)


def main():
    if len(sys.argv) < 4:
        sys.exit("사용법: render_options_md.py <run_id> <run_dir> <stage:concept|storyboard-outline>")
    _rid, rdir, stage = sys.argv[1], sys.argv[2], sys.argv[3]
    if stage == "concept":
        _gen_concept(rdir)
    elif stage == "storyboard-outline":
        _gen_storyboard_outline(rdir)
    # 그 외 stage 는 파생 대상 아님(keyvisual=HTML 로 이미 viewable). no-op.


if __name__ == "__main__":
    main()
