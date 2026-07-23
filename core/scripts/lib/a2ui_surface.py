#!/usr/bin/env python3
"""a2ui_surface.py — state.json → A2UI(선언형 UI) surface 메시지 파생 (읽기전용).

Stage 3(A2UI surface + action bridge)의 파생 단일 출처. a2ui-surface.sh(출력)와
a2ui-action.sh(현재 surface 의 허용 action 검증) '둘 다' 이 모듈을 호출한다 → 표면과
액션 검증이 절대 어긋나지 않는다(single source).

핵심 계약(Stage 5 가 검증): options/recommended/revise_available/action(-set) 은
next-action.sh 와 '동일'해야 한다. 그래서 여기서는 독자 재구현이 아니라 next-action.sh 가
쓰는 것과 '똑같은 render_runmd 헬퍼'(_option_keys/_recommendation/next_command)와 '똑같은
분기 규칙'으로 파생한다(drift 구조적 불가). state.json 은 절대 쓰지 않는다(파생만).
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_runmd as R          # next-action.sh 와 동일 재사용: _option_keys/_recommendation/next_command/phase_label/gate_type
from harness import load_json     # noqa: E402


def _harness_root():
    return os.environ.get("HARNESS_ROOT") or R._ROOT


def _catalog():
    """A2UI 카탈로그(surface/component 정의 SSoT)."""
    return load_json(os.path.join(_harness_root(), "harness", "a2ui-catalog.json"))


def _stage_phase_map():
    p = os.path.join(_harness_root(), "harness", "stage-phase-map.json")
    return json.load(open(p))["phase_to_stage"]


# ── 카탈로그 조회(surface 별 허용 action/component = SSoT, MED) ──────────────────────
#   런타임(next-action.sh)은 '어느 surface 냐'를 정하지만, 그 surface 가 '무슨 action/component 를 허용하냐'는
#   a2ui-catalog.json 이 정한다(카탈로그가 구동 — 하드코딩 아님). derive() 는 카탈로그 선언을 상한으로 삼아
#   런타임 가용성과 '안전 교집합'한다(카탈로그 비우면 그 surface 에서 해당 action 이 실제로 사라진다).
def _surface_block(cat, name, step=None):
    """카탈로그 surfaces[name] 블록. keyvisual+step 이면 그 step 하위블록(actions/components 가 step 별)."""
    s = (cat.get("surfaces") or {}).get(name) or {}
    if step and isinstance(s.get("steps"), list):
        for stp in s["steps"]:
            if isinstance(stp, dict) and stp.get("step") == step:
                return stp
    return s


def _catalog_actions(cat, name, step=None):
    return list(_surface_block(cat, name, step).get("actions") or [])


def _catalog_components(cat, name, step=None):
    return list(_surface_block(cat, name, step).get("components") or [])


def _allowed_actions(cat, name, step, primary, revise_available):
    """이 surface 에서 사람이 되돌려보낼 수 있는 named event 집합 — 카탈로그가 '엄격한 상한'(strict upper bound).

    방출 action 집합 ⊆ 카탈로그가 그 surface 에 선언한 actions (카탈로그에 없는 action 은 절대 방출하지 않는다).
    - primary(select|approve|raise-limit): 카탈로그가 이 surface 에 선언했을 때만 포함(MED — 카탈로그의 해당
      surface actions 를 비우면 primary 가 실제로 사라지고 a2ui-action 도 그 이벤트를 거부한다).
    - revise: revise_available '그리고' 카탈로그가 그 surface 에 revise 를 선언했을 때만 포함.
      정상 surface(select/approve/keyvisual)는 카탈로그 actions 에 revise 가 있어 revise_available 과 함께 노출된다.
      escalated surface 는 카탈로그가 [raise-limit] 만 선언(ReviseButton 컴포넌트 없음)하므로, revise_available 이
      True 여도(레거시 gate=user·status=escalated 합성 상태) revise 를 '방출하지 않는다' — 그래야 (a) 카탈로그가
      엄격한 상한이고 (b) 렌더할 컴포넌트(ReviseButton)가 없는 action 을 내보내지 않는다(action↔component 정합).
      실 런타임 escalated(gate=review·status=escalated)는 애초에 revise_available=False 라 영향 없음 — 즉 '실제'
      상태에서 action set 은 여전히 revise_available 과 정합하고(Stage 1 escalated 고정 불변), 카탈로그 상한도 지킨다.
      (레거시 gate=user·status=escalated 는 gate.sh 가 만들지 않는 합성/엣지 상태다. revise 가 정말 필요하면
       revise.sh 직접 경로는 여전히 수락하지만, 그 surface 카탈로그에 없는 버튼을 A2UI 로 노출하지는 않는다.)
    """
    cat_acts = set(_catalog_actions(cat, name, step))
    out = []
    if primary in cat_acts:
        out.append(primary)
    if revise_available and "revise" in cat_acts:
        out.append("revise")
    return out


def _brief_ra_ok_required(rdir):
    """01-brief 에 '승인'으로 표시된 기능성(민감) 항목이 있으면 RA 사후검수(--ra-ok)가 필요한지(True).

    소스는 approve.sh 의 APPROVED_SENS 와 동일(brief.json.sensitive_labels[*].status=="approved").
    이 신호를 정상 승인 게이트(gate=user·status=pending)와 중단복구 승인(resume-approve·gate=user·status=approved)이
    '함께' 쓴다 — approve.sh 는 두 경로 모두 기능성 '승인' 표시가 있으면 --ra-ok(또는 기존 RA 확인기록)를 요구한다
    (정상 승인=approve.sh:95 · 중단복구 재개=approve.sh:37). 따라서 표면도 두 경로에서 동일하게 ra_ok_required 를
    내보내야 한다. 옛 코드는 resume-approve 분기에서 이 파생을 건너뛰어 항상 false 를 냈고, 그러면 운영자가
    operator-voice 규칙(ra_ok_required=false → 빈 {"action":"approve"})대로 빈 승인을 보내 approve.sh 가 거부했다.
    """
    bp = os.path.join(rdir, "01-brief/brief.json")
    if not os.path.exists(bp):
        return False
    try:
        return any(s.get("status") == "approved"
                   for s in load_json(bp).get("sensitive_labels", []))
    except Exception:
        return False


def decide(rid, rdir, st):
    """next-action.sh 와 '동일 규칙'으로 (action, stage, options, recommended, revise_available, ra_ok_required) 파생.

    분기 순서·helper 호출은 next-action.sh(scripts/next-action.sh 35~72행)와 1:1 동일.
    단 ra_ok_required 는 정상 승인뿐 아니라 중단복구 승인(resume-approve)에서도 파생한다 — approve.sh 의
    중단복구 분기(approve.sh:37)도 기능성 '승인' 표시가 있으면 --ra-ok 를 요구하므로 표면이 그 진실을 알려야
    운영자가 {"action":"approve","ra_ok":true} 로 재개할 수 있다(빈 승인 거부 회피). ra_ok_required 는 동치
    비교 4필드(action/options/recommended/revise_available)에 들지 않아 surface≡next-action 동치는 불변.
    """
    phase, step, status, gate = st["phase"], st["step"], st["status"], st["gate"]
    recommended = R._recommendation(rdir, st)
    options = R._option_keys(rdir, phase)
    stage_for_phase = _stage_phase_map()

    action = None
    stage = None
    ra_ok_required = False
    if status == "escalated":
        action = "raise-limit"
    elif phase == "done":
        action = "done"
    elif phase == "00-ingest":
        action = "ingest"
    elif gate == "user" and status == "approved":
        action = "resume-approve"
        # 중단복구 승인도 정상 승인과 같은 RA 신호를 쓴다(approve.sh:37 이 --ra-ok 재요구) — 옛 코드는 여기서
        #   파생을 건너뛰어 항상 false 였고, 그 탓에 운영자가 빈 승인을 보내 approve.sh 가 거부했다(HIGH).
        if phase == "01-brief":
            ra_ok_required = _brief_ra_ok_required(rdir)
    elif gate == "select" and status == "selected":
        action = "resume-select"     # select 는 ra_ok 개념이 없다(정상·중단복구 모두 ra_ok_required=false 유지)
    elif step == "generate":
        action = "generate"
        if phase == "03-storyboard":
            stage = "storyboard-%s" % R.storyboard_substage(rdir)
        else:
            stage = stage_for_phase.get(phase, phase)
    elif gate == "review" and status == "pending":
        action = "review"
    elif gate == "select" and status == "pending":
        action = "select"
    elif gate == "user" and status == "pending":
        action = "approve"
        if phase == "01-brief":
            ra_ok_required = _brief_ra_ok_required(rdir)   # 정상 승인(approve.sh:95) — 중단복구와 동일 소스
    else:
        action = "generate"
        stage = stage_for_phase.get(phase, phase)

    # M5(G2): revise 가용 — next-action.sh 와 동일 규칙(revise.sh 게이트 가드와 정합).
    revise_available = (gate == "select" and status == "pending") \
        or (gate == "user" and status in ("pending", "escalated"))

    return action, stage, options, recommended, revise_available, ra_ok_required


# ── A2UI 컴포넌트 빌더(카탈로그 components 계약 그대로) ──────────────────────────────
def _card(key, recommended, selected=False, body=None):
    return {"component": "Card", "props": {
        "title": key, "body": body, "optionKey": key,
        "selected": selected, "badge": ("recommended" if key == recommended else None)}}


def _badge(key):
    return {"component": "Badge", "props": {"label": key, "variant": "recommended"}}


def _choice(key):
    return {"component": "ChoiceButton", "props": {"label": key, "optionKey": key, "action": "select"}}


def _approve(label, action):
    return {"component": "ApproveButton", "props": {"label": label, "action": action}}


def _revise():
    return {"component": "ReviseButton", "props": {"label": "revise", "action": "revise", "reason": None}}


def _text(content, variant="body"):
    return {"component": "Text", "props": {"content": content, "variant": variant}}


def _filelink(rdir, rel):
    return {"component": "FileLink", "props": {
        "label": rel, "path": os.path.join(rdir, rel), "href": None}}


def _file_components(rdir, files):
    return [_filelink(rdir, rel) for rel in (files or [])]


def _select_components(rdir, options, recommended, actions, cat_comps, files):
    """component 유형은 카탈로그(cat_comps)가 선언한 것만, 버튼은 최종 actions 와 일치하게 방출."""
    comps = []
    if "Card" in cat_comps:
        comps.extend(_card(k, recommended) for k in options)
    if recommended and "Badge" in cat_comps:
        comps.append(_badge(recommended))
    if "select" in actions and "ChoiceButton" in cat_comps:
        comps.extend(_choice(k) for k in options)
    if "revise" in actions and "ReviseButton" in cat_comps:
        comps.append(_revise())
    if "FileLink" in cat_comps:
        comps.extend(_file_components(rdir, files))
    return comps


def _approve_components(rdir, gate_label, actions, cat_comps, files):
    comps = []
    if "Text" in cat_comps:
        comps.append(_text(gate_label, "body"))
    if "approve" in actions and "ApproveButton" in cat_comps:
        comps.append(_approve("approve", "approve"))
    if "revise" in actions and "ReviseButton" in cat_comps:
        comps.append(_revise())
    if "FileLink" in cat_comps:
        comps.extend(_file_components(rdir, files))
    return comps


def _escalated_components(gate_label, actions, cat_comps):
    comps = []
    if "Text" in cat_comps:
        comps.append(_text(gate_label, "advisory"))
    if "raise-limit" in actions and "ApproveButton" in cat_comps:
        comps.append(_approve("raise-limit", "raise-limit"))
    if "revise" in actions and "ReviseButton" in cat_comps:
        comps.append(_revise())
    return comps


def derive(rid, rdir, st):
    """현재 state → A2UI 선언형 UI 메시지(dict). 읽기전용.

    반환 dict 의 options/recommended/revise_available/action 은 next-action.sh 와 동치,
    actions 는 그 state 에서 사람이 되돌려보낼 수 있는 named event 집합(카탈로그 surface 와 정합).
    """
    cat = _catalog()
    phase, status, gate = st["phase"], st["status"], st["gate"]
    action, stage, options, recommended, revise_available, ra_ok_required = decide(rid, rdir, st)

    # next-action.sh 와 동일 소스로 검토 파일·게이트 라벨(FileLink/Text 재료).
    _cmd, gate_label, files, hint = R.next_command(rid, st, rdir)

    is_kv = (phase == "04-keyvisual")
    surface = None
    step = None
    actions = []
    components = []

    # resume-* (중단 복구)는 하부 select/approve 와 '같은 surface'로 매핑한다 — 그래야 브리지로도 직접 스크립트와
    #   동일하게 복구된다(select.sh/approve.sh 의 중단복구 분기가 전이를 재개). action 필드 자체는 next-action.sh 와
    #   동치(resume-select/resume-approve)로 유지하되, surface/actions 는 select/approve 로 노출한다.
    if action == "raise-limit":
        # 런타임 escalated = gate=review·status=escalated (gate.sh) → revise_available=False → actions=[raise-limit].
        #   레거시(합성) gate=user·status=escalated 면 revise_available=True 이지만, escalated 카탈로그 surface 가
        #   revise/ReviseButton 을 선언하지 않으므로 _allowed_actions 가 revise 를 '방출하지 않는다'(카탈로그=엄격 상한,
        #   렌더 컴포넌트 없는 action 금지). 어느 쪽이든 actions ⊆ 카탈로그 escalated actions.
        surface = "escalated"
        actions = _allowed_actions(cat, surface, None, "raise-limit", revise_available)
        components = _escalated_components(gate_label, actions, _catalog_components(cat, surface))
    elif action in ("select", "resume-select"):
        surface = "keyvisual" if is_kv else "select"
        step = "select" if is_kv else None
        actions = _allowed_actions(cat, surface, step, "select", revise_available)
        components = _select_components(rdir, options, recommended, actions,
                                        _catalog_components(cat, surface, step), files)
    elif action in ("approve", "resume-approve"):
        surface = "keyvisual" if is_kv else "approve"
        step = "approve" if is_kv else None
        actions = _allowed_actions(cat, surface, step, "approve", revise_available)
        components = _approve_components(rdir, gate_label, actions,
                                        _catalog_components(cat, surface, step), files)
    else:
        # 비-대화형(generate/review/ingest/done) — A2UI 게이트 아님(사람 입력 없음).
        surface = None
        actions = []
        components = [_text(gate_label, "body")] if gate_label else []

    out = {
        "a2ui_version": cat.get("a2ui_version"),
        "catalogId": cat.get("catalogId"),
        "rid": rid,
        "phase": phase,
        "phase_label": R.phase_label(phase),
        "gate": gate,
        "status": status,
        "surface": surface,                              # select|approve|keyvisual|escalated|None
        "step": step,                                    # keyvisual 2단계의 현재 스텝(select|approve) 또는 None
        "needs_approve_after_select": bool(surface == "keyvisual"),
        "action": action,                                # ≡ next-action.sh action (동치)
        "actions": actions,                              # 현재 surface 의 허용 named event 집합
        "options": options,                              # ≡ next-action.sh options
        "recommended": recommended,                      # ≡ next-action.sh recommended
        "revise_available": revise_available,            # ≡ next-action.sh revise_available
        "ra_ok_required": ra_ok_required,                # 01-brief 승인 시 RA 사후검수 필요 여부
        "components": components,                         # A2UI 선언형 UI 트리(카탈로그 components)
    }
    return out


if __name__ == "__main__":
    _rid, _rdir = sys.argv[1], sys.argv[2]
    _st = load_json(os.path.join(_rdir, "state.json"))
    print(json.dumps(derive(_rid, _rdir, _st), ensure_ascii=False))
