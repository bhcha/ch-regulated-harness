#!/usr/bin/env python3
"""completeness_advisor.py — 결손값 '권고(advisory)' 단일 계산(읽기전용).

강제(fail-closed 게이트: validate-stage·kcia_engine)와 분리된 '권고 계층'이다. 산출물(claim-basis·voc·
canon-coverage)을 읽어 (1) 필수값이 빠져 차트/구성을 못 만드는 경우 '무엇을 채워라'(must_fill)와,
(2) 없어도 막진 않지만 있으면 품질이 오르는 값(nice_to_have)을 평이어로 돌려준다. 완결성은 '핵심 정보 N/M개'
카운트만 쓴다(거짓 % 금지 = 환각 안전).

⚠ 순수 읽기전용: state.json 을 절대 쓰지 않고 어떤 게이트 판정도 바꾸지 않는다. render_runmd/next-action 이
매 렌더마다 호출해 '그 시점 산출물 상태'로 재파생한다(무상태·자가소멸: 값이 채워지면 다음 렌더에 사라짐).
문구 SSoT = operator_labels(평이 한국어·내부어 누수 가드). 페이즈-스코프(해당 단계가 실제 쓰는 결손만)로 노이즈 억제.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import operator_labels as L  # noqa: E402
from harness import is_number as _is_num  # noqa: E402  (K-1 일원화 — 산재 _is_num 흡수)

# 일반 참조 문서(kind!=test_report)인데 '시험 결과' 성격이면 시험성적서 경로(전용 임상 블록)가 더 적절하다는 신호.
_CLINICAL_SIGNAL_TOKENS = ("인체적용시험", "사용적합", "적합 판정", "적합함", "임상시험", "시험성적")


# _is_num: harness.is_number 를 import (K-1 일원화)


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def advise(rdir, st):
    """읽기전용 권고 계산. 반환:
       {must_fill:[{key, missing:[필드코드...], labels:[평이...]}], nice_to_have:[{key, propose}], completeness:[filled,total]}.
       파일이 없거나 손상돼도 예외를 삼키고 fail-soft(부분/빈 결과) — run.md 렌더를 막지 않는다."""
    phase = (st or {}).get("phase", "")
    must_fill, nice = [], []
    filled = total = 0

    cb = _load(os.path.join(rdir, "00-ingest", "claim-basis.json"))
    cb = cb if isinstance(cb, dict) else {}          # 손상/비-dict JSON 도 fail-soft(AttributeError 방지)
    voc = _load(os.path.join(rdir, "00-ingest", "voc.json"))
    voc = voc if isinstance(voc, dict) else {}
    evs = [e for e in (cb.get("evidence_on_file") or []) if isinstance(e, dict)]
    clinical = [e for e in evs if e.get("kind") == "clinical_trial"]

    # ── (A) 제품 사실·후기(컨셉~키비주얼에서 본문·이미지에 쓰임) — 품질 권고 ──
    if phase in ("02-concept", "03-storyboard", "04-keyvisual"):
        pf = voc.get("product_facts") or {}
        offer = voc.get("offer") or {}
        has_pf = bool(pf.get("pack_count") or pf.get("key_ingredients") or pf.get("components") or offer.get("price"))
        total += 1
        filled += 1 if has_pf else 0
        if not has_pf:
            nice.append({"key": "product_facts", "propose": L.advise_fill("product_facts"),
                         "projection": L.advise_projection("product_facts")})
        has_kw = bool(voc.get("keyword_frequency"))
        total += 1
        filled += 1 if has_kw else 0
        if not has_kw:
            nice.append({"key": "voc_keywords", "propose": L.advise_fill("voc_keywords"),
                         "projection": L.advise_projection("voc_keywords")})

    # ── (B) 임상 근거(차트가 도는 스토리보드/키비주얼에서 의미) — evidence 가 '있을 때만' 평가(없으면 권하지 않음) ──
    if phase in ("03-storyboard", "04-keyvisual") and clinical:
        # (B-1) 필수 4요소: 차트 도출에 반드시 필요 — 강제 게이트(kcia_engine._evidence_satisfies)와 동일 어휘.
        #   측정 전·후 값(before/after 둘 다 OR series≥2) · 시험기관 · 참여자수 · 시험기간.
        #   ⚠ 게이트는 '단일 evidence 레코드'가 4요소를 모두 가져야 통과한다(레코드 간 합산 아님 — 외부리뷰 정정).
        #     따라서 '가장 완성된 후보 레코드' 기준으로 평가한다: 어느 레코드도 4요소 완비가 아니면 그 후보가
        #     무엇을 더 채우면 되는지 안내한다. 품질(변화율·p값)도 동일 후보 레코드 기준(차트를 받칠 그 레코드).
        #   ⚠ 개인차 디스클레이머는 evidence 필드가 아니라 '차트 블록 본문' 요건이라 claim-basis 스코프인 여기서는 평가하지 않는다
        #     (블록 본문 디스클레이머 강제는 kcia_engine 의 chart 하드게이트가 담당).
        def _has_pair(e):
            if _is_num(e.get("before")) and _is_num(e.get("after")):
                return True
            ser = [s for s in (e.get("series") or []) if isinstance(s, dict) and _is_num(s.get("value"))]
            return len(ser) >= 2

        def _req_flags(e):
            return {"measured_pair": _has_pair(e),
                    "institution": bool(str(e.get("institution") or "").strip()),
                    "sample_size": _is_num(e.get("sample_size")),
                    "duration": bool(str(e.get("duration") or "").strip())}
        order = ["measured_pair", "institution", "sample_size", "duration"]

        def _has_measure_intent(e):
            # '측정 차트를 만들 의도'가 있는 레코드인지 — 4요소(_req_flags) 외에 정량 측정 신호까지 본다(외부리뷰 P2):
            #   보고요소(시험기관·n·기간)는 아직 비었어도 측정치(change_pct·before/after·series 1개·p값·metric)가
            #   하나라도 등록됐으면 차트 의도가 있는 것 → 불완전하면 임계. 순수 정성·출처수준(신호 전무)만 침묵(외부리뷰 P1).
            if any(_req_flags(e).values()):
                return True
            if _is_num(e.get("change_pct")) or _is_num(e.get("before")) or _is_num(e.get("after")):
                return True
            if str(e.get("p_value") or "").strip() or str(e.get("metric") or "").strip():
                return True
            return any(isinstance(s, dict) and _is_num(s.get("value")) for s in (e.get("series") or []))

        scored = [(e, _req_flags(e)) for e in clinical]
        best_e, best_f = max(scored, key=lambda t: sum(t[1].values()))   # 4요소를 가장 많이 갖춘 후보 레코드
        # 측정/차트 의도가 있는 레코드가 하나라도 있을 때만 '측정 차트' 필수·품질을 평가한다.
        #   순수 정성·출처수준 clinical_trial(측정 신호 전무 = 차트 의도 없음)은 임계(must_fill)로 올리지 않는다(외부리뷰 P1):
        #   만들 차트가 없는데 멈추면 정상 클리니컬 참조에 override 를 강요하게 된다. 이때는 권고도 침묵(노이즈 0).
        if any(_has_measure_intent(e) for e in clinical):
            for k in order:                               # 필수도 완결성 카운트에 포함(거짓 N/M 방지)
                total += 1
                filled += 1 if best_f[k] else 0
            miss = [k for k in order if not best_f[k]]
            if miss:
                must_fill.append({"key": "clinical_required", "missing": miss,
                                  "labels": [L.fill_label(m) for m in miss if L.fill_label(m)],
                                  "projection": L.advise_projection("clinical_required")})
            # (B-2) 품질: 변화율·p값 — 같은 후보 레코드 기준.
            has_change = _is_num(best_e.get("change_pct"))
            total += 1
            filled += 1 if has_change else 0
            if not has_change:
                nice.append({"key": "clinical_change_pct", "propose": L.advise_fill("clinical_change_pct"),
                             "projection": L.advise_projection("clinical_change_pct")})
            has_p = bool(str(best_e.get("p_value") or "").strip())
            total += 1
            filled += 1 if has_p else 0
            if not has_p:
                nice.append({"key": "clinical_p_value", "propose": L.advise_fill("clinical_p_value"),
                             "projection": L.advise_projection("clinical_p_value")})

    # ── (B') 임상 근거 자체가 없을 때(차트를 못 만든다는 결과 투영) — 03/04 에서만, count 불변(순수 투영) ──
    if phase in ("03-storyboard", "04-keyvisual") and not clinical:
        nice.append({"key": "evidence_absent", "propose": L.advise_fill("evidence_absent"),
                     "projection": L.advise_projection("evidence_absent")})

    # ── (D) 전역 톤(art-direction) 결손 — 이미지 직전(04)에서만 평가, count 불변(순수 투영) ──
    if phase == "04-keyvisual":
        ad = _load(os.path.join(rdir, "03-storyboard", "art-direction.json"))
        ad = ad if isinstance(ad, dict) else {}
        mp = ad.get("master_palette")
        if not (isinstance(mp, list) and any(str(x).strip() for x in mp)):
            nice.append({"key": "art_direction", "propose": L.advise_fill("art_direction"),
                         "projection": L.advise_projection("art_direction")})

    # ── (E) 구도 메모(reference-notes composition) 결손 — 파일 존재 + composition_notes 비었을 때만(노이즈 억제), count 불변 ──
    if phase in ("03-storyboard", "04-keyvisual"):
        rn = _load(os.path.join(rdir, "00g-guideline", "reference-notes.json"))
        if isinstance(rn, dict):
            cn = rn.get("composition_notes")
            if not (isinstance(cn, list) and any(str(x).strip() for x in cn)):
                nice.append({"key": "reference_composition", "propose": L.advise_fill("reference_composition"),
                             "projection": L.advise_projection("reference_composition")})

    # ── (C) 권장(선택) 구성요소 — canon-coverage 의 required=false + missing ──
    for rel in ("04-keyvisual/canon-coverage.json", "03-storyboard/canon-coverage.json"):
        cov = _load(os.path.join(rdir, rel))
        if isinstance(cov, dict):
            rec_missing = [c for c in (cov.get("components") or [])
                           if isinstance(c, dict) and not c.get("required") and c.get("status") == "missing"]
            if rec_missing:
                nice.append({"key": "recommended_component", "propose": L.advise_fill("recommended_component"),
                             "projection": L.advise_projection("recommended_component")})
            break  # 첫 발견 커버리지만(04 우선)

    # (F) '사진형 블록 html_only → 이미지 낭비' 권고는 폐기됨(2026-07-05 전제 전환, docs/bm-designer-handoff-plan.md):
    #   이제 실엔진(온라인)은 html_only 블록도 이미지로 생성하므로 '이미지가 버려진다'는 전제가 사라졌다.

    # ── (G) 일반 참조 문서인데 '시험 결과' 성격(인체적용시험·사용적합) — 시험성적서 경로 제안, count 불변(순수 투영) ──
    #   kind!=test_report + reflect=true + claim/reflection_points 에 임상 신호 → '전용 임상 블록을 원하면 시험성적서로 선언'.
    #   안전 불변식(일반=각주 채널)을 바꾸지 않는다 — 재분류를 강제하지 않고 비차단으로 제안만 한다(UX 갭 해소).
    if phase in ("01-brief", "02-concept", "03-storyboard", "04-keyvisual"):
        edocs = _load(os.path.join(rdir, "00-ingest", "evidence-documents.json"))
        docs = edocs.get("documents") if isinstance(edocs, dict) else None
        for d in (docs or []):
            if not isinstance(d, dict) or d.get("kind") == "test_report" or not d.get("reflect"):
                continue
            blob = " ".join([str(d.get("claim") or "")] + [str(x) for x in (d.get("reflection_points") or [])])
            if any(tok in blob for tok in _CLINICAL_SIGNAL_TOKENS):
                nice.append({"key": "evidence_clinical_signal", "propose": L.advise_fill("evidence_clinical_signal"),
                             "projection": L.advise_projection("evidence_clinical_signal")})
                break  # 한 건이면 충분(중복 권고 억제)

    # propose 가 빈(누수 스크럽) 항목은 제외.
    nice = [n for n in nice if n.get("propose")]
    return {"must_fill": must_fill, "nice_to_have": nice, "completeness": [filled, total]}
