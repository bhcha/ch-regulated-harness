#!/usr/bin/env python3
"""render_runmd.py — 진행 보드 run.md 자동 생성 (설계 §10.2).

현업이 외울 필요 없이 '지금 할 일 + 다음 명령 1개'를 보여준다.
사용법: render_runmd.py <run_id> <run_dir>
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, now_iso, storyboard_substage, ROOT as _ROOT, regulatory_domain  # noqa: E402
# 현업 화면 평이 라벨의 단일 출처(개선계획 1부 단계1). PHASE_LABEL·헬퍼를 여기서 재노출 →
#   next-action.sh 의 R.PHASE_LABEL / R.phase_label 재사용이 그대로 동작(불일치 차단).
from operator_labels import (  # noqa: E402
    PHASE_LABEL, phase_label, gate_text, status_label,
    iteration_phrase, scope_label, capability, signal, risk_as_result, scrub,
    completeness_phrase, quality_gap_note,
    preimage_label, preimage_plan_phrase,
)
import completeness_advisor  # noqa: E402  (결손값 권고 계산 — 읽기전용)
# _ROOT: harness.ROOT 를 import (K-1 일원화 — 3단 dirname 재계산 제거)


def _base_order():
    """진행 보드의 선형 페이즈 순서를 라우트 테이블(entry→next 체인)에서 도출한다(WS-ROUTES 단일 출처).
    조건부 00g-guideline 은 본선(entry→next) 밖이라 자연히 빠지고, _effective_order 가 술어로 끼워넣는다.
    advance-phase.sh 와 같은 harness/pipeline-routes.json 을 읽어 run.md ↔ next-action ↔ 전이가 한 출처를 공유."""
    routes = load_json(os.path.join(_ROOT, "harness", "pipeline-routes.json"))
    end = routes["end"]
    order, cur, seen = [], routes["entry"], set()
    while cur != end:
        if cur in seen:                       # 사이클 = 깨진 라우트 데이터: fail-soft 금지(부분 순서 반환 안 함)
            raise ValueError("pipeline-routes 사이클 감지: %s" % cur)
        seen.add(cur)
        nxt = (routes.get("phases", {}).get(cur) or {}).get("next")
        if nxt is None:                       # 체인 단절 = 깨진 데이터
            raise ValueError("pipeline-routes 체인 단절(미정의 next): %s" % cur)
        order.append(cur)
        cur = nxt
    return order


ORDER = _base_order()


def _effective_order(st, rdir):
    """진행 보드 순서. 00a-intake(첨부 분류)·00e-evidence(참고 문서 반영)·00g-guideline(가이드라인) 페이즈는
    '실제 사용된 run'에만 표시 — 조건부 페이즈라 미사용 run(기존 화장품 단일번들)에서는 보드를 기존과 동일하게 유지
    (테스트·UX 안정). 순서 불변식: 00a-intake → 00-ingest → 00e-evidence → 00g-guideline → 01-brief(00a 가 인입 앞)."""
    uses_intake = (
        st.get("phase") == "00a-intake"
        or os.path.isdir(os.path.join(rdir, "00a-intake"))
        or any(h.get("phase") == "00a-intake" for h in st.get("history", []))
    )
    uses_guideline = (
        st.get("phase") == "00g-guideline"
        or os.path.isdir(os.path.join(rdir, "00g-guideline"))
        or any(h.get("phase") == "00g-guideline" for h in st.get("history", []))
    )
    uses_evidence = (
        st.get("phase") == "00e-evidence"
        or os.path.isdir(os.path.join(rdir, "00e-evidence"))
        or any(h.get("phase") == "00e-evidence" for h in st.get("history", []))
    )
    if not uses_intake and not uses_guideline and not uses_evidence:
        return list(ORDER)
    o = list(ORDER)
    # 같은 앵커(00-ingest 다음)에 삽입 — 나중 삽입이 앵커 바로 뒤로 밀려오므로, 00g 를 먼저 넣고
    #   00e 를 뒤에 넣어 최종순서 00-ingest → 00e-evidence → 00g-guideline 을 보장한다(00e 가 00g 앞).
    if uses_guideline:
        o.insert(o.index("00-ingest") + 1, "00g-guideline")
    if uses_evidence:
        o.insert(o.index("00-ingest") + 1, "00e-evidence")
    # 00a-intake 는 인입(00-ingest) '앞'이다 → 보드 맨 앞에 삽입.
    if uses_intake and "00a-intake" not in o:
        o.insert(o.index("00-ingest"), "00a-intake")
    return o


# ── 00a-intake 분류표 평이 라벨(현업 화면 — 내부 category/route 코드 미노출) ──
_INTAKE_CATEGORY_LABEL = {
    "working_backwards": "제품 기획 문서",
    "own_product_crawl": "자사 상품 크롤",
    "reference_crawl": "참고 상품 크롤",
    "product_image": "자사 제품 이미지",
    "evidence_test_report": "시험성적서",
    "evidence_certification": "인증서",
    "evidence_paper": "논문",
    "evidence_patent": "특허",
    "evidence_ingredient_dossier": "성분 자료",
    "evidence_brand_story": "브랜드 스토리",
    "evidence_guide": "가이드 문서",
    "evidence_general": "일반 참고 문서",
    "unknown": "판단 불가 — 직접 지정이 필요해요",
}
_INTAKE_CONF_LABEL = {"high": "확실", "low": "확인 권장"}
# 자사 이미지의 '쓰임새' 평이 라벨(현업 화면 — 내부 role 코드 미노출). _INTAKE_CATEGORY_LABEL 패턴 미러.
_INTAKE_ROLE_LABEL = {
    "package_front": "제품 정면컷",
    "usage_shot": "사용 장면",
    "logo": "로고",
    "ingredient_panel": "성분 설명 패널",
    "other": "기타",
}
# 썸네일 렌더 대상 래스터 이미지 확장자(대소문자 무시). 벡터(svg 등)는 제외.
_RASTER_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
                      ".tif", ".tiff", ".heic", ".heif", ".avif")


def _is_raster_image(filename):
    """파일명이 래스터 이미지 확장자로 끝나면 True(대소문자 무시)."""
    return str(filename or "").lower().endswith(_RASTER_IMAGE_EXTS)


def _intake_section(rid, st, rdir):
    """00a-intake 분류표(현업 확인용) 마크다운 라인. phase!=00a-intake 이거나 제안 부재면 []."""
    if st.get("phase") != "00a-intake":
        return []
    pp = os.path.join(rdir, "00a-intake", "intake-proposal.json")
    if not os.path.exists(pp):
        return []
    try:
        prop = load_json(pp)
    except Exception:
        return []
    files = prop.get("files") or []
    L = ["## 첨부 자료 분류 (확인해 주세요)"]
    has_unknown = False
    for fl in files:
        cat = fl.get("category") or "unknown"
        if cat == "unknown":
            has_unknown = True
        cat_label = _INTAKE_CATEGORY_LABEL.get(cat, "분류")
        fn = fl.get("filename", "")
        parts = ["**%s** → %s" % (fn, cat_label)]
        # role(선택 — 있을 때만): 자사 이미지의 쓰임새 평이 라벨. 없으면 no-op(라인 바이트 불변).
        role_label = _INTAKE_ROLE_LABEL.get(fl.get("role"))
        if role_label:
            parts.append(role_label)
        rp = (fl.get("reflect_preview") or "").strip()
        if rp:
            parts.append("반영: %s" % rp)
        conf = _INTAKE_CONF_LABEL.get(fl.get("confidence"), "")
        if conf:
            parts.append("신뢰도: %s" % conf)
        if "converted" in (fl.get("actions") or []):
            parts.append("변환됨")
        if "unpacked" in (fl.get("actions") or []):
            parts.append("압축 해제됨")
        # provenance(선택 — 있을 때만): 자료 출처. 없으면 no-op(라인 바이트 불변).
        prov = (fl.get("provenance") or "").strip()
        if prov:
            parts.append("출처: %s" % prov)
        L.append("- " + " · ".join(parts))
        # 썸네일(이미지 파일일 때만): product_image 카테고리이거나 래스터 확장자면 상대경로 미리보기.
        #   run.md 는 런 루트라 첨부는 run-상대 경로(inputs/attachments/<파일>)로 가리킨다(표의 기존 관례).
        #   비이미지 파일은 미표시(no-op) → 새 필드/이미지 없는 행은 변경 전과 바이트 동일.
        if cat == "product_image" or _is_raster_image(fn):
            L.append("  ![](inputs/attachments/%s)" % fn)
    ap = (prop.get("aggregate_preview") or "").strip()
    if ap:
        L.append("")
        L.append("- 정리하면: %s" % ap)
    L.append("")
    if has_unknown:
        L.append("- ⚠ '판단 불가'가 있어요 — 그대로는 승인할 수 없어요. "
                 "고칠 방향을 적어 다시 분류하세요: `bash scripts/revise.sh %s \"어느 파일을 무엇으로\"`" % rid)
    else:
        L.append("- 모두 분류됐어요 → 이대로 진행: `bash scripts/approve.sh %s`  ·  "
                 "고칠 게 있으면: `bash scripts/revise.sh %s \"고칠 방향\"`" % (rid, rid))
    return L


def _evidence_section(rid, st, rdir):
    """00e-evidence 시험성적서 스펙 초안 표(현업 확인용 — 지표/수치/페이지/판정문). W-3(00e 스펙 2차 관문):
       제안에 kind=test_report 문서가 있을 때만 노출한다(일반 참조 문서만 있으면 [] — 별도 표 없음).
       phase!=00e-evidence 이거나 제안 부재/test_report 없음이면 []. run.md 는 골든 제외라 바이트 불변 무관."""
    if st.get("phase") != "00e-evidence":
        return []
    pp = os.path.join(rdir, "00e-evidence", "reflection-proposal.json")
    if not os.path.exists(pp):
        return []
    try:
        prop = load_json(pp)
    except Exception:
        return []
    trs = [d for d in (prop.get("docs") or []) if isinstance(d, dict) and d.get("kind") == "test_report"]
    if not trs:
        return []
    L = ["## 시험성적서 스펙 초안 (확인해 주세요)"]
    for d in trs:
        tr = d.get("test_report") or {}
        meta = []
        if tr.get("institution"):
            meta.append("기관 %s" % tr["institution"])
        if tr.get("sample_size") is not None:
            meta.append("참여자수 %s명" % tr["sample_size"])
        if tr.get("duration"):
            meta.append("기간 %s" % tr["duration"])
        verdict = (d.get("verdict_text") or "").strip() or "-"
        L.append("")
        L.append("**%s** — %s" % (d.get("filename", ""), " · ".join(meta) or "(요소 미상)"))
        L.append("")
        L.append("| 지표 | 수치 | 페이지 | 판정문 |")
        L.append("|---|---|---|---|")
        items = tr.get("test_items") or []
        if not items:
            L.append("| (측정 항목 없음) | - | - | %s |" % verdict)
        for it in items:
            if not isinstance(it, dict):
                continue
            metric = it.get("metric") or "-"
            ser = it.get("series") or []
            if ser:
                num = " → ".join("%s %s" % (s.get("label"), s.get("value")) for s in ser if isinstance(s, dict))
            elif it.get("before") is not None and it.get("after") is not None:
                num = "전 %s → 후 %s" % (it.get("before"), it.get("after"))
            else:
                num = "-"
            if it.get("change_pct") is not None:
                num = ("%s " % num if num != "-" else "") + "(%s%%)" % it.get("change_pct")
            pages = (it.get("image_ref") or {}).get("pages") or []
            pg = ", ".join(str(p) for p in pages) if pages else "-"
            L.append("| %s | %s | %s | %s |" % (metric, num, pg, verdict))
    L.append("")
    L.append("- 스펙이 맞으면 이대로 승인: `bash scripts/approve.sh %s`  ·  "
             "고칠 게 있으면: `bash scripts/revise.sh %s \"고칠 방향\"`" % (rid, rid))
    return L


def next_command(rid, st, rdir):
    """현재 상태 → 현업이 칠 다음 명령 1개 + 검토 파일 목록."""
    phase, step, status = st["phase"], st["step"], st["status"]
    gate, awaiting = st["gate"], st["awaiting"]
    files = []
    # 반환: (cmd, gate_label, files, hint). cmd 은 '그대로 실행 가능한' 단일 명령(백틱 안에 들어감).
    if status == "escalated":
        # cmd(raise-limit)은 '운영자 조치'라 현업 '다음 명령'에서 분리한다(main 이 ⚠ 주의에 별도 표기).
        #   gate_label·hint 는 현업용 평이어(내부 코드 'escalated' 미노출).
        return ("bash scripts/run-stage.sh raise-limit %s" % rid,
                signal("stuck"), files, "표현을 직접 고치거나, 운영자·담당자에게 알려 주세요.")
    if phase == "done":
        return ("ls runs/%s/04-keyvisual/export/kcia-package" % rid,
                "모든 단계 완료", files, "협회 자문 패키지를 검토·제출하세요.")
    if phase == "00-ingest":
        return ("bash scripts/ingest-bundle.sh <자료폴더> %s" % rid, "자료 불러오기 대기", files,
                "<자료폴더>를 실제 자료 폴더 경로로 바꾸세요.")

    # ── 중단 복구 상태: 게이트 액션 자체를 재실행하도록 안내(잘못된 run-stage 로 빠지지 않게) ──
    if gate == "user" and status == "approved":
        return ("bash scripts/approve.sh %s" % rid, "이어서 승인하기", files, "중단된 승인을 이어서 마무리해요.")
    if gate == "select" and status == "selected":
        return ("bash scripts/select.sh %s %s" % (rid, st.get("selected_option") or _top_option(rdir, st)),
                "이어서 고르기", files, "중단된 선택을 이어서 마무리해요.")

    stage_for_phase = {"00a-intake": "intake", "00e-evidence": "evidence", "00g-guideline": "guideline", "01-brief": "brief", "02-concept": "concept", "04-keyvisual": "keyvisual"}
    # 생성 대기
    if step == "generate":
        if phase == "03-storyboard":
            stage = "storyboard-%s" % storyboard_substage(rdir)   # outline | tone | plan (단일 SSoT)
        else:
            stage = stage_for_phase.get(phase, phase)
        # in-session 전환(단계 D): 생성은 '세션 안에서' 직접 한다 —
        #   슬래시 /<stage>(= 세션 내 스킬)가 1급 경로(산출물을 먼저 쓰고 전이까지 도는 헤드리스 600초 행 회피).
        #   cmd 토큰은 'run-stage.sh <stage>'(전이·결정적 폴백 + next-action 의 stage 파싱 SSoT) 그대로 두고, 세션 내 권고는 hint 로.
        #   세션 내 스킬이 있는 단계만 권고한다. keyvisual 도 PR2-E 로 세션 내 지원(렌더는 전이 단계가 돌림)이라 포함.
        insession_hint = ("세션 안에서 만들려면 /%s 를 쓰세요(운영자가 대신 실행해요)." % stage
                          if stage in ("evidence", "guideline", "brief", "concept", "storyboard-outline", "storyboard-plan", "keyvisual")
                          else "")
        return ("bash scripts/run-stage.sh %s %s" % (stage, rid), "만들기 대기", files, insession_hint)
    # 심의(=규정 점검) 대기
    if gate == "review" and status == "pending":
        return ("bash scripts/kcia-check.sh %s" % rid, "규정 점검 대기", files, "")
    # 선택 대기 — 추천 top-1(실재 옵션)을 그대로 채워 실행 가능하게
    if gate == "select" and status == "pending":
        files = _list_options(rdir, phase)
        top = _top_option(rdir, st)
        alts = [k for k in _option_keys(rdir, phase) if k != top]
        alt_hint = ("다른 안 고르기: " + ", ".join("bash scripts/select.sh %s %s" % (rid, a) for a in alts)) if alts else ""
        # M5(G2): 전부거절→재제안(자유텍스트 refine)도 1급 선택지로 노출 — 마음에 드는 안이 없으면 새 라운드 생성.
        revise_hint = "마음에 드는 안이 없으면 다시 만들기: bash scripts/revise.sh %s \"다시 만들 방향\"" % rid
        hint = " · ".join(h for h in (alt_hint, revise_hint) if h)
        return ("bash scripts/select.sh %s %s" % (rid, top), "다 만들었어요 · 고를 차례예요 (고른 뒤 규정 점검)", files, hint)
    # 승인 대기 (approve) — revise 는 hint 로 분리
    if gate == "user" and status == "pending":
        ra = ""
        if phase == "01-brief":
            bp = os.path.join(rdir, "01-brief/brief.json")
            if os.path.exists(bp):
                try:
                    if any(s["status"] == "approved" for s in load_json(bp).get("sensitive_labels", [])):
                        ra = " --ra-ok"
                except Exception:
                    pass
        hint = "고칠 게 있으면: bash scripts/revise.sh %s \"빼거나 고칠 표현\"" % rid
        if ra:
            hint = "기능성 표시가 있어요 → 담당자(RA) 확인을 거쳐야 승인돼요. " + hint
        return ("bash scripts/approve.sh %s%s" % (rid, ra), "다 만들었어요 · 승인할 차례예요 (승인 뒤 규정 점검)",
                _list_options(rdir, phase), hint)
    # 폴백: 내부 step 코드를 라벨로 흘리지 않고 평이어(status_label)로.
    return ("bash scripts/run-stage.sh %s %s" % (stage_for_phase.get(phase, phase), rid),
            status_label(status), files, "")


# WS-GATES(TWEAK-2): 게이트의 인간-상호작용 종류(GSD 4종). state.json 에 저장하지 않고
#   (gate,status,phase)+민감표시에서 '파생'한다 → 단일 진실(이 함수), staleness/세터누락 구조적 불가.
#   사람-노출 문장은 operator_labels.gate_text(코드 미노출). 이 함수는 코드(기계용 next-action)만 반환.
def gate_type(st, rdir):
    """현재 게이트의 종류(auto|human-verify|setup|hard-stop) 또는 None(게이트 아님).
       status=approved/selected 는 '중단 복구'(결정은 기록됐으나 전이 미커밋) — 여전히 사람이
       같은 명령을 재실행해야 하므로 underlying 게이트(user/select)의 종류로 분류(null 금지)."""
    status, gate, phase = st.get("status"), st.get("gate"), st.get("phase")
    if status == "escalated":
        return "hard-stop"
    if gate == "review" and status == "pending":
        return "auto"
    if gate == "select" and status in ("pending", "selected"):     # selected=중단 복구
        return "human-verify"
    if gate == "user" and status in ("pending", "approved"):        # approved=중단 복구
        if phase == "01-brief":                       # 민감 기능성 '승인' 표시 → RA 사후검수 선행(setup)
            bp = os.path.join(rdir, "01-brief", "brief.json")
            if os.path.exists(bp):
                try:
                    if any(s.get("status") == "approved" for s in load_json(bp).get("sensitive_labels", [])):
                        return "setup"
                except Exception:
                    pass
        return "human-verify"
    return None


def _feedback_sr(rdir, st):
    """현재 페이즈 feedback.json 의 stop_reason(dict) 또는 None."""
    fp = os.path.join(rdir, st.get("phase", ""), "feedback.json")
    if os.path.exists(fp):
        try:
            sr = load_json(fp).get("stop_reason")
            if isinstance(sr, dict):
                return sr
        except Exception:
            pass
    return None


_VERDICT_GUIDE = {"summary": "규정 점검을 통과하지 못했어요 — 표현을 고치거나 사람이 판단해야 해요",
                  "required_fields": ["걸린 부분을 확인해 표현을 고치거나, 예외로 둘지 판단"]}


def _stop_origin(st):
    """가장 최근 '중단을 일으킨' 이벤트의 기인: 'human' | 'machine' | None.
       history 를 뒤에서부터 스캔해 첫 stop 이벤트를 찾는다(중간의 limit:raised/phase:enter 등은 건너뜀).
       이로써 revise/escalated 의 기인을 통일 판별 — 사람 revise→escalated→raise-limit(=status revise 복구)
       체인에서도 사람 기인을 올바로 추적한다."""
    for e in reversed(st.get("history") or []):
        ev = e.get("event", "")
        if ev.startswith("human:"):
            return "human"
        if ev.startswith("review:revise") or ev.startswith("loop-guard:"):
            return "machine"
    return None


def _stop_reason(rdir, st):
    """WS-GATES(TWEAK-3): 멈춤 사유 — 기인별로 분기(옛 사유의 오귀속/stale 방지).
       · changes_requested(사람 revise 직후) → feedback.stop_reason.
       · revise/escalated → 최근 stop 기인이 사람이면 feedback.stop_reason(없으면 human generic),
         기계(review/loop-guard)면 verdict 확인 안내.
       · 그 외(통과·재생성 등) → None(stale 미노출)."""
    status = st.get("status")
    if status == "changes_requested":
        return _feedback_sr(rdir, st)
    if status in ("revise", "escalated"):
        if _stop_origin(st) == "human":               # 사람 기인(상한초과·raise-limit 복구 포함) → 그 사유
            return _feedback_sr(rdir, st) or {"code": status,
                "summary": "보완 반복 상한 초과 → 사람 개입 필요", "required_fields": ["표현 직접 수정 또는 예외 판단"]}
        return dict(_VERDICT_GUIDE, code=status)       # 기계 기인 → verdict 확인 안내
    return None


def _top_option(rdir, st):
    """선택용 추천 옵션(실재) — recommendation top-1, 없으면 첫 옵션."""
    rec = _recommendation(rdir, st)
    if rec:
        return rec
    keys = _option_keys(rdir, st["phase"])
    return keys[0] if keys else "A"


def _option_keys(rdir, phase):
    # 00g-guideline 은 단안(크롤 참조 노트) — 더 이상 다안(select) 아님(구 유사점 3안 파기) → 옵션 키 없음.
    if phase == "02-concept":
        d = os.path.join(rdir, "02-concept/options")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []
    if phase == "03-storyboard":   # M3: 2-cycle — select 다안은 스토리라인(outline)만
        d = os.path.join(rdir, "03-storyboard/outline/options")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []
    if phase == "04-keyvisual":
        d = os.path.join(rdir, "04-keyvisual/options")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []
    return []


def _list_options(rdir, phase):
    keys = _option_keys(rdir, phase)
    # 이슈3b: concept·storyboard-outline 은 사람용 파생 MD(summary.md)를 우선 가리킨다(raw JSON 대신 — 안별 본문을 눈으로).
    #   summary.md 가 아직 없으면(레거시/파생 실패) 원본 JSON 으로 폴백. keyvisual 은 index.html 로 이미 viewable.
    md_rel = {"02-concept": "02-concept/options/%s/summary.md",
              "03-storyboard": "03-storyboard/outline/options/%s/summary.md"}.get(phase)
    json_rel = {"02-concept": "02-concept/options/%s/key-message.json",   # 00g 는 단안(참조노트) — 옵션 목록 없음
                "03-storyboard": "03-storyboard/outline/options/%s/storyline.json",   # M3: 스토리라인 A/B 비교
                "04-keyvisual": "04-keyvisual/options/%s/index.html"}.get(phase)
    if not json_rel:
        return []
    out = []
    # 단일 비교 인덱스(있으면) 맨 앞에 — '나란히 비교' 진입점.
    compare = {"02-concept": "02-concept/options-compare.md",
               "03-storyboard": "03-storyboard/outline/options-compare.md"}.get(phase)
    if compare and os.path.exists(os.path.join(rdir, compare)):
        out.append(compare)
    for k in keys:
        if md_rel and os.path.exists(os.path.join(rdir, md_rel % k)):
            out.append(md_rel % k)
        else:
            out.append(json_rel % k)
    return out


def progress_rows(st, rdir):
    rows = []
    order = _effective_order(st, rdir)
    cur = st["phase"]
    cur_idx = order.index(cur) if cur in order else len(order)
    for i, p in enumerate(order):
        label = phase_label(p)
        if i < cur_idx or cur == "done":
            rows.append("- [x] %s" % label)
        elif i == cur_idx:
            # 현재 단계: 내부 enum(status/iteration) 대신 평이어. 횟수는 2회차부터만 강조.
            bits = [status_label(st["status"])]
            itp = iteration_phrase(st["iteration"], st["max_iterations"])
            if itp and st["status"] in ("revise", "changes_requested"):
                bits.append(itp)
            rows.append("- [~] %s (%s)" % (label, " · ".join(b for b in bits if b)))
        else:
            rows.append("- [ ] %s" % label)
    return rows


_INFLIGHT_STEP = {
    "generate": "만드는 중", "review": "규정 점검 중", "review-passA": "규정 점검 중(꼼꼼히)",
    "review-passB": "규정 점검 중(건별 확인)", "bake": "이미지 만드는 중",
}
_INFLIGHT_STAGE_PHASE = {
    "guideline": "00g-guideline", "brief": "01-brief", "concept": "02-concept",
    "storyboard-outline": "03-storyboard", "storyboard-plan": "03-storyboard", "keyvisual": "04-keyvisual",
}


def _inflight_label(rdir):
    """O-3(진행 신호): .logs/timing.jsonl 에 '시작만 있고 완료 미도달'(진행 중) 단계가 있으면 평이 라벨 반환(없으면 None).
    run.md 가 진행 중에 다시 렌더되면 '지금 만드는 중'을 보여 정체 오인을 막는다. best-effort — 파일 부재/파싱오류 무시."""
    tj = os.path.join(rdir, ".logs", "timing.jsonl")
    if not os.path.isfile(tj):
        return None
    inflight = {}
    try:
        with open(tj, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                key = (r.get("stage") or "", r.get("step", ""))
                if r.get("outcome") == "start":
                    inflight[key] = True
                else:
                    inflight.pop(key, None)
    except OSError:
        return None
    if not inflight:
        return None
    stage, step = list(inflight.keys())[-1]
    ph = _INFLIGHT_STAGE_PHASE.get(stage, stage)
    what = phase_label(ph) if ph else ""
    return ((what + " ") if what else "") + _INFLIGHT_STEP.get(step, "진행 중")


def main():
    rid, rdir = sys.argv[1], sys.argv[2]
    st = load_json(os.path.join(rdir, "state.json"))
    cmd, gate_label, files, hint = next_command(rid, st, rdir)
    rec = _recommendation(rdir, st)
    sel = _selected_for_phase(rdir, st)   # 이슈2: 선택 이후 '고른 안'을 1급으로(추천≠선택 혼동 제거)

    L = []
    L.append("# 진행 보드 — %s" % rid)
    L.append("업데이트: %s" % now_iso())
    L.append("")
    L.append("## 지금 할 일  ⏳")
    L.append("- 지금 단계: %s  ·  %s" % (phase_label(st["phase"]), gate_label))
    gtext = gate_text(gate_type(st, rdir))   # 게이트 '종류'를 사람에게 닥칠 일로(영어 코드 미노출)
    if gtext and st["status"] != "escalated":   # escalated 는 gate_label 이 이미 같은 메시지 → 중복 생략
        L.append("- %s" % gtext)
    # GSD '능력 문장': 산출물이 나와 사람이 볼 차례면 '이제 할 수 있는 일' 1줄.
    if st["gate"] in ("select", "user") and st["status"] in ("pending", "selected", "approved"):
        cap = capability(st["phase"])
        if cap:
            L.append("- %s" % cap)
    # O-3(진행 신호): 시작만 있고 완료 미도달인 작업이 있으면 '지금 만드는 중'을 보여 정체 오인을 막는다(있을 때만).
    _inflight = _inflight_label(rdir)
    if _inflight:
        L.append("- ⏳ 지금 %s… (조금 걸려요 — 끝나면 아래 '다음 명령'이 바뀝니다)" % _inflight)
    # escalated(막힘)는 '다음 명령'이 운영자 조치(raise-limit)라 현업 화면에서 분리 → ⚠ 주의에만 표기.
    if st["status"] != "escalated":
        L.append("- 다음 명령:  `%s`" % cmd)
    if hint:
        L.append("- 참고: %s" % hint)
    sr = _stop_reason(rdir, st)
    if sr:
        line = "- 멈춤 사유: %s" % sr.get("summary", "")
        rf = sr.get("required_fields") or []
        if rf:
            line += " · 확인·보완할 점: %s" % ", ".join(rf)
        L.append(line)
    # 이슈2(표시 일원화): 선택 이후엔 '고른 안'을 1급으로 표기한다(현업이 고른 안과 시스템 추천을 혼동하지 않게).
    #   추천≠선택일 때만 추천을 한 줄에 '참고용'으로 병기 — 점검(심의)은 언제나 '고른 안'에 대해 돈다.
    #   선택 전(추천만 있을 때)엔 추천을 '고르기 도움'으로 강조(기존 동작 — 다안 선택 보조).
    if sel:
        line = "- 고른 안: **%s**" % sel
        if rec and rec != sel:
            line += "  (시스템 추천은 %s — 참고용이며, 점검은 고른 안에 대해 진행돼요)" % rec
        L.append(line)
    elif rec:
        reason = _reco_reason(rdir, st)
        line = "- 추천 시안: **%s**" % rec
        if reason:
            line += " — %s" % reason
        L.append(line)
    if files:
        L.append("- 검토할 파일:")
        for f in files:
            if sel and ("/%s/" % sel in f):
                tag = "  ← 고른 안"
            elif (not sel) and rec and ("/%s/" % rec in f):
                tag = "  ← 추천"
            else:
                tag = ""
            L.append("  - %s%s" % (f, tag))
    # 00a-intake: 첨부 자료 분류표(파일 → 분류 → 반영 예고 → 신뢰도 → 처리) — 사람 확인용.
    intake_lines = _intake_section(rid, st, rdir)
    if intake_lines:
        L.append("")
        L.extend(intake_lines)
    # 00e-evidence: 시험성적서 스펙 초안 표(지표/수치/페이지/판정문) — W-3(제안에 test_report 있을 때만).
    evidence_lines = _evidence_section(rid, st, rdir)
    if evidence_lines:
        L.append("")
        L.extend(evidence_lines)
    L.append("")
    L.append("## 진행 현황")
    L.extend(progress_rows(st, rdir))
    # 주요 구성요소 커버리지 (있으면 노출)
    cov = _coverage_summary(rdir)
    if cov:
        L.append("")
        L.append("## 주요 구성요소 커버리지")
        L.append(cov)
    # 보완 권고(읽기전용·비강제) — 매 렌더마다 산출물에서 재파생(값 채우면 다음 렌더에 자동 소멸).
    #   강제 게이트는 그대로 두고 '제안+품질경고'만 표면화. run.md 는 골든 제외(baseline SKIP_PREFIX)라 바이트 불변.
    try:
        adv = completeness_advisor.advise(rdir, st)
    except Exception:
        adv = None
    if adv and (adv.get("must_fill") or adv.get("nice_to_have")):
        L.append("")
        _proj_prefix = preimage_label("proj_prefix")   # '→ 이대로 진행하면' (단일 출처)
        # 04-keyvisual '이고 아직 이미지 생성 전'(image-manifest.json 부재)일 때만 '최종 점검' digest 로:
        #   예정 생성 장수까지 종합해 보여준다. 생성 후(manifest 존재 = gate=select/review)에는 digest 가
        #   '생성 전' 문구로 사후 노출되면 오해를 주므로(Codex P3) 기존 '보완하면 더 좋아요' 섹션으로 돌아간다.
        _pre_image = (st.get("phase") == "04-keyvisual"
                      and not os.path.exists(os.path.join(rdir, "04-keyvisual", "image-manifest.json")))
        if _pre_image:
            L.append("## %s" % (preimage_label("runmd_header") or "보완하면 더 좋아요 (선택 — 안 채워도 진행돼요)"))
            try:
                from image_engine import planned_image_summary   # 예정 장수 = image_engine 단일 술어(드리프트 방지)
                # F1(C): 선언 규제도메인 전달 — 규제도메인은 그래픽 블록 미생성이라 예정 장수도 실제 술어와 일치(st 는 위에서 로드).
                _s = planned_image_summary(rdir, domain=regulatory_domain(st))
                _pl = preimage_plan_phrase(_s.get("total"), _s.get("image"), _s.get("chart"), _s.get("html_only", 0))
                if _pl:
                    L.append("- %s" % _pl)
            except Exception:
                pass
        else:
            L.append("## 보완하면 더 좋아요 (선택 — 안 채워도 진행돼요)")
        cp = completeness_phrase(*(adv.get("completeness") or [0, 0]))
        if cp:
            L.append("- %s" % cp)
        for mf in adv.get("must_fill") or []:
            labs = [x for x in (mf.get("labels") or []) if x]
            if labs:
                L.append("- ⚠ 임상 차트를 만들려면 %s가 더 필요해요 (지금 빠져 있어요)." % "·".join(labs))
                _pj = mf.get("projection")
                if _pj:
                    L.append("  %s %s" % (_proj_prefix, _pj))
        nice = adv.get("nice_to_have") or []
        if nice:
            L.append("- %s" % quality_gap_note())
            for n in nice:
                if n.get("propose"):
                    L.append("- ℹ %s" % n["propose"])
                    _pj = n.get("projection")
                    if _pj:
                        L.append("  %s %s" % (_proj_prefix, _pj))
    L.append("")
    L.append("## ⚠ 주의")
    if st["status"] == "escalated":
        # 안전필수 표면화: '사람 개입 필요'는 유지(고지 책임). 운영자 조치(raise-limit)는 (운영자 조치)로 분리 표기.
        L.append("- **사람 개입 필요** — %s" % risk_as_result("escalated"))
        L.append("  - (a) 표현을 직접 고치기  (b) 점검 예외 판단")
        L.append("  - (c) (운영자 조치) 다시 시도 횟수 늘리기: `bash scripts/run-stage.sh raise-limit %s`" % rid)
    else:
        L.append("- 없음")
    L.append("")
    L.append("> 본 산출물은 법적 통과 보증이 아니며 자율·비법적 사전 점검입니다.")
    with open(os.path.join(rdir, "run.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def _coverage_summary(rdir):
    """canon-coverage.json(있으면)을 한 줄 요약. 누락 구성요소는 명시."""
    for p in ("04-keyvisual/canon-coverage.json", "03-storyboard/canon-coverage.json"):
        fp = os.path.join(rdir, p)
        if os.path.exists(fp):
            try:
                r = load_json(fp)
            except Exception:
                return None
            comps = r["components"]
            cov = sum(1 for c in comps if c["status"] == "covered")
            req = sum(1 for c in comps if c["required"] and not c["status"].startswith("exempt"))
            miss = [c["label"] for c in comps if c["status"] == "missing"]
            scope_txt = scope_label(r["scope"]) or "기준"     # 'scope=' 코드 미노출
            line = "- (%s) 꼭 들어갈 %d개 중 %d개 충족" % (scope_txt, req, cov)
            if miss:
                line += " · **아직 빠진 것: %s**" % ", ".join(miss)
            else:
                line += " · ✓ 전부 들어갔어요"
            return line
    return None


def _reco_reason(rdir, st):
    """추천 사유 — recommendation.json rationale 의 첫 문장만 짧게(현업용). 잭곤 라벨/파일 포인터 미노출."""
    sb_rec = "03-storyboard/outline/recommendation.json"
    paths = {"02-concept": "02-concept/recommendation.json", "03-storyboard": sb_rec,
             "04-keyvisual": "04-keyvisual/recommendation.json"}
    p = paths.get(st.get("phase"))
    if not p:
        return ""
    fp = os.path.join(rdir, p)
    if not os.path.exists(fp):
        return ""
    try:
        rationale = (load_json(fp).get("rationale") or "").strip()
    except Exception:
        return ""
    if not rationale:
        return ""
    # 첫 문장만(한국어 '다.'/'. ' 경계). 길면 60자 + … 로 자른다.
    for sep in ("다. ", ". "):
        idx = rationale.find(sep)
        if 0 < idx <= 80:
            rationale = rationale[:idx + 1]
            break
    rationale = rationale.replace("\n", " ").strip()
    rationale = rationale[:60] + ("…" if len(rationale) > 60 else "")
    # 모델이 쓴 문장이라 내부어(pairwise·claim-basis·verdict 등)가 섞일 수 있다 → 금지어 있으면 사유 미노출(Codex MEDIUM).
    return scrub(rationale)


def _selected_for_phase(rdir, st):
    """현재 페이즈의 '고른 안'(decision.json 의 selected) — 실재 옵션과 교차검증. 선택 전이면 None.
       이슈2(표시 일원화): 선택 이후 run.md 가 '시스템 추천'이 아니라 '현업이 고른 안'을 1급으로 보여주게 하는 단일 출처.
       decision.json(=select.sh 가 쓰는 권위 출처)을 읽는다 — 심의 대상도 항상 이 고른 안이다(kcia-check REVIEW_TARGET 과 동일 사상)."""
    paths = {"02-concept": "02-concept/decision.json",
             "03-storyboard": "03-storyboard/outline/decision.json",
             "04-keyvisual": "04-keyvisual/decision.json"}
    optdirs = {"02-concept": "02-concept/options",
               "03-storyboard": "03-storyboard/outline/options",
               "04-keyvisual": "04-keyvisual/options"}
    p = paths.get(st.get("phase"))
    if not p:
        return None
    fp = os.path.join(rdir, p)
    if not os.path.exists(fp):
        return None
    try:
        sel = load_json(fp).get("selected")
    except Exception:
        return None
    if not sel:
        return None
    od = os.path.join(rdir, optdirs.get(st.get("phase"), ""))
    if os.path.isdir(od) and sel in os.listdir(od):   # phantom 선택 노출 방지
        return sel
    return None


def _recommendation(rdir, st):
    sb_rec, sb_opt = "03-storyboard/outline/recommendation.json", "03-storyboard/outline/options"  # M3: 스토리라인만 다안 추천
    paths = {   # 00g 는 단안(참조노트) — 다안 추천(recommendation) 없음
        "02-concept": "02-concept/recommendation.json",
        "03-storyboard": sb_rec,
        "04-keyvisual": "04-keyvisual/recommendation.json",
    }
    optdirs = {
        "02-concept": "02-concept/options",
        "03-storyboard": sb_opt,
        "04-keyvisual": "04-keyvisual/options",
    }
    p = paths.get(st["phase"])
    if p and os.path.exists(os.path.join(rdir, p)):
        try:
            top = load_json(os.path.join(rdir, p))["ranked"][0]
            # 실재 옵션과 교차검증 — phantom 추천 노출 방지(Codex #8)
            od = os.path.join(rdir, optdirs.get(st["phase"], ""))
            if os.path.isdir(od) and top in os.listdir(od):
                return top
        except Exception:
            return None
    return None


if __name__ == "__main__":
    main()
