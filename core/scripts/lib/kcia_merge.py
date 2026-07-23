#!/usr/bin/env python3
"""kcia_merge.py — WS-CRITIC-B: 2-pass 심의 병합(건별 적대검증).

서브커맨드:
  candidates <baseline> <passa> <cap>
      Pass-A(전체 산출물 critic)가 baseline 에 '추가'한 후보 위반을 deterministic 순서로 출력(JSON 라인, 최대 cap).
      baseline 위반은 절대 후보가 아니다(불멸). 스키마 부적합 위반은 무시(최종 verdict schema-safe).
  merge <vp> <baseline> <passa> <pbdir> <critic> <cap>
      최종 verdict = baseline ∪ (Pass-A 후보 중 Pass-B 에서 'refute 되지 않은' 것).
      · critic 은 ADD-only: baseline 의 high/실증(substantiation_required)은 항상 보존(삭제 불가).
      · Pass-B default=refute(보수적): pbdir/<i>.json 의 refuted 가 '명시적 boolean false' 일 때만 후보 유지.
        파일 누락/파싱 실패/타입오류/미검증 = refute(제외) — 미검증 위반을 보고하지 않는다.
      · passa/pbdir 없으면(offline/stub/critic 미실행) merge = baseline 그대로(현행 동작 보존).
      · 잘못된 passa(invalid JSON/스키마)는 안전 무시(빈 후보) — 머지가 크래시·오염되지 않는다.

candidates 와 merge 는 동일 deterministic 후보 순서·cap 을 공유해야 index↔passb 파일 매핑이 일치한다.
"""
import sys, os, json, hashlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, atomic_write_json  # noqa: E402

_REQ = ("target_text", "axis", "rule", "severity", "detected_by", "suggested_rewrite")
_SEV = {"low", "medium", "high"}
_DET = {"ruleset", "model", "subagent"}


def _key(v):
    return (v.get("target_text"), v.get("axis"), v.get("rule"))


def _valid_vio(v):
    """verdict.schema 의 violation 계약을 만족하는가(악의/깨진 Pass-A 가 최종 verdict 를 오염시키지 못하게)."""
    return (isinstance(v, dict)
            and all(isinstance(v.get(k), str) for k in _REQ)
            and v.get("axis")                      # minLength 1
            and v.get("severity") in _SEV
            and v.get("detected_by") in _DET)


def _safe_load(p):
    """존재하지 않거나 invalid JSON 이면 빈 dict(크래시 방지)."""
    if not p or not os.path.exists(p):
        return {}
    try:
        d = load_json(p)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _parse_cap(s):
    try:
        return int(s)
    except Exception:
        return 8


def _candidates(baseline_p, passa_p, cap):
    base = load_json(baseline_p)                   # baseline 은 신뢰 입력 → strict(실패 시 예외=비0종료, fail-closed)
    base_keys = {_key(v) for v in base.get("violations", [])}
    out, seen = [], set()
    for v in _safe_load(passa_p).get("violations", []):
        if len(out) >= cap:                        # cap 검사를 append 전에(=cap<=0 → 0건, off-by-one 제거)
            break
        if not _valid_vio(v):                      # 스키마 부적합 후보 무시
            continue
        k = _key(v)
        if k in base_keys or k in seen:            # baseline 위반은 후보 아님(불멸) · 중복 제거
            continue
        seen.add(k)
        out.append({kk: v[kk] for kk in _REQ})     # 정확한 스키마 키만 투영(extra 키 제거 → 최종 verdict schema-safe)
    return out


def _do_merge(vp, baseline_p, passa_p, pbdir, critic, cap, critic_outcome="skipped", review_depth="rule_engine_only", critic_engine=""):
    base = load_json(baseline_p)                   # baseline 은 strict — malformed 면 예외(비0종료) → fail-closed(빈 baseline pass 위조 차단)
    merged = list(base.get("violations", []))      # baseline 위반은 항상 보존(불멸)
    for i, v in enumerate(_candidates(baseline_p, passa_p, cap)):
        refuted = True                             # default=refute(보수적): 미검증/실패 후보는 제외
        pbf = os.path.join(pbdir, "%d.json" % i)
        if os.path.exists(pbf):
            try:
                if load_json(pbf).get("refuted") is False:   # 명시적 boolean false 일 때만 유지
                    refuted = False
            except Exception:
                refuted = True
        if not refuted:
            merged.append(v)
    det_hard = any(v.get("severity") == "high" or v.get("axis") == "substantiation_required"
                   for v in base.get("violations", []))
    final_fail = bool(merged or det_hard)
    # pass+escalate 게이트 버그 수정(Opt-2): escalate 는 '차단' 신호다. critic(Pass-A)의 escalate 는
    #   verdict 가 fail 일 때만 전파하고, 위반 0건 통과(pass)에 달린 critic 의 escalate(계약에 없는 소프트
    #   '사람 확인 권고' = 노이즈)는 떨어뜨린다 — 그래야 깨끗한 통과가 거짓 escalated 로 막히지 않는다.
    #   베이스라인 escalate(전문약 하드스톱 등)는 항상 fail 과 동반(kcia_engine: high+fail)되므로 무조건
    #   유지 → 차단성 escalate 는 절대 누락되지 않는다.
    vid = os.path.basename(vp).rsplit(".", 1)[0] + "-" + hashlib.sha1(
        json.dumps(merged, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:8]
    out = {
        "verdict": "fail" if final_fail else "pass",
        "engine": "ruleset+subagent" if critic else "subagent",
        "confidence": base.get("confidence", 0.9),
        "violations": merged,
        "escalate": bool(base.get("escalate") or (final_fail and _safe_load(passa_p).get("escalate"))),
        "id": vid,
        # 개선3(강등 가시화): 사후 감사로 '룰엔진만 통과'를 잡는다(현재는 조용히 강등돼 흔적이 없었음).
        "critic_ran": review_depth == "rule_engine+critic",
        "critic_outcome": critic_outcome,
        "review_depth": review_depth,
    }
    # WS-ADK(M4 additive): 실제 크리틱 엔진 라벨(예 adk-http)은 비어있지 않을 때만 기록 → stub/offline(미실행)은 키 부재 = 골든 바이트 불변.
    if critic_engine:
        out["critic_engine"] = critic_engine
    atomic_write_json(vp, out)


def main():
    cmd = sys.argv[1]
    if cmd == "candidates":
        for v in _candidates(sys.argv[2], sys.argv[3], _parse_cap(sys.argv[4])):
            print(json.dumps(v, ensure_ascii=False))
    elif cmd == "merge":
        critic = sys.argv[6] if len(sys.argv) > 6 else ""
        cap = _parse_cap(sys.argv[7]) if len(sys.argv) > 7 else 8
        critic_outcome = sys.argv[8] if len(sys.argv) > 8 else "skipped"   # 개선3
        review_depth = sys.argv[9] if len(sys.argv) > 9 else "rule_engine_only"
        critic_engine = sys.argv[10] if len(sys.argv) > 10 else ""          # WS-ADK(M4): 실제 엔진 라벨(additive)
        _do_merge(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], critic, cap, critic_outcome, review_depth, critic_engine)
    else:
        sys.exit("kcia_merge.py: 알 수 없는 서브커맨드 '%s' (candidates|merge)" % cmd)


if __name__ == "__main__":
    main()
