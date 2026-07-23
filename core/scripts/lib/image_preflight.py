#!/usr/bin/env python3
"""image_preflight.py — 대표 이미지 실생성(Nano Banana) 직전 '최종 점검 digest'(읽기전용).

비용·비가역 단계인 이미지 실생성 직전에 "무엇이 빠졌고(결손) → 결과가 어떻게 나올지(투영) →
예정 생성 장수"를 운영자에게 한 번에 종합해 보여주는 모듈이다. 강제 게이트(validate-stage·
kcia_engine)와 분리된 '권고+요약 표면화'일 뿐이며, completeness_advisor(결손 권고)와
image_engine(예정 장수)을 읽기전용으로 조합해 평이 한국어로 출력한다.

⚠ 순수 읽기전용·무상태: state.json 을 절대 쓰지 않고(읽기만), 어떤 게이트 판정도 바꾸지 않으며,
   네트워크 호출도 없다(advise·planned_image_summary 둘 다 읽기전용). 출력은 오직 stdout.
⚠ 임계 결손(임상 측정치는 등록됐는데 시험성적서 요소가 빠져 측정 차트를 못 만드는 경우)일 때만
   nonzero exit(3)로 신호한다 — 셸 게이트가 그 신호를 받아 멈춘다. 그 외에는 항상 exit 0.
   내부 오류·디렉터리 부재는 fail-open(exit 0): 읽기전용 권고이므로 깨져도 생성을 막지 않는다.
문구 SSoT = operator_labels(평이 한국어·내부어 누수 가드). 거짓 % 금지(실제 카운트만).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import completeness_advisor  # noqa: E402
import image_engine  # noqa: E402
import operator_labels as L  # noqa: E402
from harness import regulatory_domain  # noqa: E402  (K-1 일원화 — 산재 도메인 리더 흡수)


def _load_state(rdir):
    """state.json 을 읽어 dict 반환. 없거나 손상되면 fail-soft 로 {} (읽기 전용)."""
    try:
        with open(os.path.join(rdir, "state.json"), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def build_report(rid, rdir):
    """이미지-직전 digest 본문을 만든다. 반환 (lines:list[str], critical:bool).
       어떤 줄도 None 을 append 하지 않으며, 누수 가드가 빈 문자열을 돌려준 라벨 줄은 건너뛴다."""
    st = _load_state(rdir)
    try:
        adv = completeness_advisor.advise(rdir, st)
    except Exception:
        adv = {"must_fill": [], "nice_to_have": [], "completeness": [0, 0]}
    try:
        # F1(C): 선언 규제도메인을 넘겨 예정 장수를 실제 생성 술어와 일치시킨다(규제도메인은 그래픽 블록 미생성 →
        #   html_only 로 집계, image 로 과대집계 방지). st 는 위에서 이미 읽음(읽기전용).
        _dom = regulatory_domain(st)
        summary = image_engine.planned_image_summary(rdir, domain=_dom)
    except Exception:
        summary = {"total": 0, "image": 0, "chart": 0}

    lines = []

    def _add(val):
        if val:                       # 빈 문자열(누수 가드)·None 은 줄로 추가하지 않음
            lines.append(val)

    # ── 머리: 제목 · 예정 장수 · 비용 안내 ──
    _add(L.preimage_label("title"))
    _add(L.preimage_plan_phrase(summary.get("total", 0), summary.get("image", 0), summary.get("chart", 0), summary.get("html_only", 0)))
    _add(L.preimage_label("cost_note"))

    # ── 인트로: '핵심 정보 N/M개' + 결과 미리보기 안내 ──
    comp = adv.get("completeness") or [0, 0]
    f = comp[0] if len(comp) > 0 else 0
    t = comp[1] if len(comp) > 1 else 0
    cp = L.completeness_phrase(f, t)
    intro = L.preimage_label("intro")
    if cp and intro:
        lines.append("%s. %s" % (cp, intro))
    elif intro:
        lines.append(intro)
    elif cp:
        lines.append(cp)

    lines.append("")                  # 빈 줄 구분

    proj_prefix = L.preimage_label("proj_prefix")

    # ── 꼭 채우는 게 좋아요(임계 결손) ──
    must = adv.get("must_fill") or []
    if must:
        _add(L.preimage_label("must_header"))
        for mf in must:
            labs = [x for x in (mf.get("labels") or []) if x]
            if labs:
                lines.append("- 측정 차트에 '%s'이(가) 빠져 있어요." % "·".join(labs))
                proj = mf.get("projection")
                if proj and proj_prefix:
                    lines.append("  %s %s" % (proj_prefix, proj))

    # ── 채우면 더 좋아요(품질 권고) ──
    nice = adv.get("nice_to_have") or []
    if nice:
        _add(L.preimage_label("nice_header"))
        for n in nice:
            prop = n.get("propose")
            if prop:
                lines.append("- %s" % prop)
                proj = n.get("projection")
                if proj and proj_prefix:
                    lines.append("  %s %s" % (proj_prefix, proj))

    critical = bool(adv.get("must_fill"))
    return lines, critical


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: image_preflight.py <run_id> <run_dir>\n")
        return 2
    rid, rdir = argv[0], argv[1]
    if not rdir or not os.path.isdir(rdir):
        # 읽기전용 fail-open: 점검 대상이 없어도 생성을 막지 않는다.
        sys.stderr.write("image_preflight: 점검 대상 디렉터리를 찾지 못해 점검을 건너뜁니다(생성은 막지 않아요).\n")
        return 0
    try:
        lines, critical = build_report(rid, rdir)
        if lines:
            sys.stdout.write("\n".join(lines) + "\n")
        else:
            sys.stdout.write((L.preimage_label("ok") or "") + "\n")
        return 3 if critical else 0
    except Exception:
        # 읽기전용 권고 — 내부 오류로 생성을 막지 않는다(fail-open).
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
