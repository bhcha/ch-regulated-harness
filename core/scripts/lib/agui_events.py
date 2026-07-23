#!/usr/bin/env python3
"""agui_events.py — state.json 을 AG-UI 이벤트 스트림으로 '투영'하는 유일한 방출 모듈.

절대 규칙(core/AGENTS.md 1-1): state.json 은 scripts/*.sh(common.sh transition/scaffold)만 쓴다.
이 모듈은 state 를 **읽기만** 하고, 파생 이벤트를 append-only `runs/<id>/.events/agui.jsonl` 에만 쓴다.
state.json 은 절대 쓰지 않는다. `.events/` 는 골든 제외(baseline.py SKIP_PREFIX '.events') — 타임스탬프
비결정만 있고 골든 바이트에 무영향.

설계 = **재구성(reconcile) 투영 — 로그가 진실의 출처**(헤드리스 훅·이중적재 없이 멱등):
  - sync 는 먼저 기존 로그(`.events/agui.jsonl`)를 읽어 **이미 방출된 것**을 파악한다(안정 시맨틱 키·스냅샷/델타
    재구성). state.json history[] + 현재 상태에서 도출한 후보 중 **로그에 아직 없는 것만** append 한다 →
    커서 상태와 무관하게 멱등(커서는 체크포인트/최적화일 뿐 유일 진실이 아니다).
  - 첫 투영: `StateSnapshot`(현재 state 전체) 1건 → 이후 sync 마다 `StateDelta`(RFC6902 patch, 로그로
    재구성한 '마지막 투영 state' → 현재 state). replay 가 snapshot 에 delta 를 순차 적용하면 state.json 재구성.
  - history 문자열 prefix → 생명주기 이벤트(RunStarted/StepStarted/StepFinished/Custom/RunFinished)는
    스키마 x-history-event-map 을 따른다. **위치 기반 투영(history-index 프리픽스)**: 각 history 위치가 정확히
    한 번 방출되도록, 로그의 생명주기 이벤트 개수(=이미 투영된 위치 프리픽스 길이)를 세어 그 이후만 append 한다.
    로그가 진실의 출처이므로 커서 손상/소실과 무관하고(위치는 로그에서 재계산), **같은-초(same-second) ts 를
    공유하는 서로 다른 두 실행이 둘 다 방출된다**(옛 전체-행 해시 dedup 의 false-collapse 폐기 — Finding A).
    단 crash-재진입으로 '동일 내용'이 **새 위치**에 재적재되는 마커(review:produced=verdict-id·select=선택)는
    위치 투영만으론 다시 나오므로 **안정 시맨틱 키**로 접어(collapse) 중복 방출을 막는다(round-1 HIGH-3 보존).
  - 사람 게이트 도달(gate=select/user pending·status=escalated)은 `RunFinished{outcome:interrupt}` 로
    합성하되 로그의 interruptId 로 dedup(같은 개입 재방출 안 함). 에스컬레이션(raise-limit) 개입은 현재-상태가
    아니라 **history 영구 마커(loop-guard:escalated 등)**에서도 복구한다 — 라이브 관측을 놓쳐도(락 경쟁)
    이후 sync 가 마커에서 정확히 한 번 방출(HIGH-1: 현재-상태가 raise-limit 으로 escalated 를 벗어나도 영구 유실 안 됨).

동시성·원자성: sync 는 실행 락으로 직렬화한다 — 1차 `.events/.lock`(flock, fcntl 가용 플랫폼). flock 이
  **지원되지만 경쟁 중**이면 유한 대기 후 초과 시 무락 진행하고(기전을 섞으면 상호배제가 깨지므로 mkdir 로 갈아타지
  않는다), fcntl **부재** 또는 flock **미지원**(ENOTSUP·NFS)일 때만 2차 `.events/.lockdir`(os.mkdir 원자 뮤텍스,
  fcntl 불요·이식성)로 폴백한다(그 플랫폼의 모든 sync 가 동일하게 mkdir 를 쓰므로 read-then-append TOCTOU 를 실제로
  직렬화한다 — Finding B). mkdir lockdir 은 보유 PID 사망/노후 시 stale 회수해 크래시 홀더가 영구 데드락되지 않는다.
  둘 다 못 얻어도 **건너뛰지 않고 무락 진행**(조용한 skip-all 금지, HIGH-1) — 이 경우 위치 기반 dedup 이 무한 중복은
  막지만 동시 초기화 이벤트 1중복은 no-lock 플랫폼의 잔여 best-effort 한계다. 락 획득 뒤 state.json 을 재로드해 항상
  현재 상태로 투영한다. append 는 record-atomic(유효 이벤트 전체를 단일 write) — 중단돼도 기존 라인은 불변, 꼬리 부분
  라인은 다음 로드가 복구한다. 무효(스키마 위반) 이벤트는 그 1건만 stderr 로 표면화·건너뛰고 배치는 계속한다(HIGH-2:
  영구 halt 금지 — 다음 sync 가 로그로 재정합).

멱등성 보장(핵심): 방출량은 오직 '기대 생명주기 시퀀스의 미투영 접미(위치 프리픽스) + 마지막 투영 state→현재 실제
  델타 + 새 게이트'뿐이므로, 같은 상태에서 sync 를 몇 번 부르든(커서가 손상/소실/앞서 있어도) 두 번째부터는 새 이벤트가 0 이다.

CLI:
  agui_events.py sync   <run_id>|--run <id>     상태에서 새 이벤트를 투영해 append(멱등). 셸 4지점이 부른다.
  agui_events.py replay <run_id>|--run <id>     읽기 전용: .events/agui.jsonl 을 stdout 스트림(없으면 즉석 파생).
  agui_events.py emit   --run <id> --event <T> [--field k=v ...]   저수준 단일 이벤트 append(검증 후). 도구/테스트용.
"""
import sys
import os
import json
import re

# ROOT 해석(harness.py 와 동형): HARNESS_ROOT env 우선, 없으면 파일 위치에서 core 루트 유추.
ROOT = os.environ.get("HARNESS_ROOT") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_LIB = os.path.join(ROOT, "scripts", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

from harness import load_json, atomic_write_json, now_iso, Validator  # 표준 라이브러리 전용(레포 스타일 재사용)

SCHEMA_PATH = os.path.join(ROOT, "harness", "agui-projection.schema.json")
_GEN_ENGINES = ("claude", "codex", "stub")
# 실행 락(블로킹 획득) 다이얼 — 하드코딩(새 env 미도입: 계약/조회표 무영향). 경쟁 시 유한 대기 상한을 두고,
#   초과하면 무락 진행(위치 기반 dedup 이 무한 중복 방지). ⚠ None 반환 금지 = 조용한 skip-all 금지(HIGH-1).
_LOCK_TIMEOUT = 5.0    # 초. 경쟁 시 블로킹 획득 상한(flock·mkdir 공통) — 초과하면 무락 진행.
_LOCK_POLL = 0.05      # 초. 블로킹 대기 폴 간격.
_LOCKDIR_STALE = 60.0  # 초. mkdir 폴백 lockdir 이 이보다 노후(또는 보유 PID 사망)면 stale 로 회수(크래시 홀더 데드락 방지).


# ───────────────────────── 경로 ─────────────────────────
def run_dir(rid):
    return os.path.join(ROOT, "runs", rid)


def events_dir(rid):
    return os.path.join(run_dir(rid), ".events")


def events_file(rid):
    return os.path.join(events_dir(rid), "agui.jsonl")


def cursor_file(rid):
    return os.path.join(events_dir(rid), ".cursor.json")


def state_file(rid):
    return os.path.join(run_dir(rid), "state.json")


def _rid_ok(rid):
    """CLI run-id 경로탈출 가드: 해석된 run 디렉터리가 반드시 runs/ '아래'여야 한다.
    (emit --run /tmp/victim · --run ../outside 처럼 runs/ 를 벗어나는 절대/상대 경로를 거부.)
    셸 agui_emit 경로는 이미 검증된 RID(폴더명)를 넘기므로 무해 — 저수준 CLI 방어용."""
    if not rid or not isinstance(rid, str):
        return False
    runs_root = os.path.realpath(os.path.join(ROOT, "runs"))
    rd = os.path.realpath(os.path.join(ROOT, "runs", rid))
    return rd.startswith(runs_root + os.sep)


# ───────────────────────── 스키마 검증(캐시) ─────────────────────────
_SCHEMA = None


def _schema():
    global _SCHEMA
    if _SCHEMA is None:
        _SCHEMA = load_json(SCHEMA_PATH)
    return _SCHEMA


def validate_event(ev):
    """이벤트 1건을 projection 스키마로 검증 → 오류 목록(빈 목록=통과)."""
    try:
        v = Validator(_schema())
        v.validate(ev, _schema())
        return v.errors
    except Exception as e:      # 스키마 로드 실패 등 → 검증 불가(방어적으로 '오류 있음' 취급)
        return ["schema-load: %s" % e]


# ───────────────────── RFC6902 JSON Patch (diff/apply, stdlib) ─────────────────────
def _esc(tok):
    return tok.replace("~", "~0").replace("/", "~1")


def _unesc(tok):
    return tok.replace("~1", "/").replace("~0", "~")


def _json_diff(prev, cur, path, ops):
    """prev→cur 의 최소 RFC6902 연산(add/remove/replace)만 생성. 배열은 '접미 append' 면
    /- add 로, 그 외엔 전체 replace(인덱스 시프트 복잡성 회피 — 정확·단순)."""
    if isinstance(prev, dict) and isinstance(cur, dict):
        for k in prev:
            if k not in cur:
                ops.append({"op": "remove", "path": path + "/" + _esc(k)})
        for k in cur:
            p = path + "/" + _esc(k)
            if k not in prev:
                ops.append({"op": "add", "path": p, "value": cur[k]})
            elif prev[k] != cur[k]:
                _json_diff(prev[k], cur[k], p, ops)
    elif isinstance(prev, list) and isinstance(cur, list):
        if prev != cur:
            if len(cur) >= len(prev) and cur[:len(prev)] == prev:
                for elem in cur[len(prev):]:
                    ops.append({"op": "add", "path": path + "/-", "value": elem})
            else:
                ops.append({"op": "replace", "path": path, "value": cur})
    else:
        if prev != cur:
            ops.append({"op": "replace", "path": path, "value": cur})


def compute_patch(prev, cur):
    ops = []
    _json_diff(prev, cur, "", ops)
    return ops


def apply_patch(doc, ops):
    """RFC6902 연산을 문서에 적용(replay 재구성용). add/remove/replace + move/copy 지원."""
    doc = json.loads(json.dumps(doc))   # deep copy

    def parts_of(pointer):
        return [_unesc(t) for t in pointer.split("/")[1:]] if pointer else []

    def container_and_key(parts):
        cur = doc
        for part in parts[:-1]:
            cur = cur[int(part)] if isinstance(cur, list) else cur[part]
        return cur, (parts[-1] if parts else None)

    def get_at(parts):
        cur = doc
        for part in parts:
            cur = cur[int(part)] if isinstance(cur, list) else cur[part]
        return cur

    for op in ops:
        typ = op.get("op")
        parts = parts_of(op.get("path", ""))
        if typ in ("add", "replace", "test"):
            val = op.get("value")
            if typ == "test":
                # RFC6902 test: 값 일치 검증(불일치=오류). compute_patch 는 test 를 방출하지 않으므로 이는
                #   방어 경로(외부/손상 patch) — 조용한 통과 대신 명시적 오류로 표면화(MED). 호출부 try 가 처리.
                actual = doc if not parts else get_at(parts)
                if actual != val:
                    raise ValueError("RFC6902 test 불일치: path=%s" % op.get("path"))
                continue
            if not parts:
                doc = val
                continue
            cont, key = container_and_key(parts)
            if isinstance(cont, list):
                if key == "-":
                    cont.append(val)
                elif typ == "add":
                    cont.insert(int(key), val)
                else:
                    cont[int(key)] = val
            else:
                cont[key] = val
        elif typ == "remove":
            cont, key = container_and_key(parts)
            if isinstance(cont, list):
                del cont[int(key)]
            else:
                cont.pop(key, None)
        elif typ in ("move", "copy"):
            src = get_at(parts_of(op.get("from", "")))
            if typ == "copy":
                src = json.loads(json.dumps(src))   # MED: copy 는 값을 깊은 복사 — 같은 가변 객체가 여러 배열에 앨리어싱되지 않게.
            else:                                    # move: 원본 제거(별칭 무해 — 원본은 사라짐).
                fcont, fkey = container_and_key(parts_of(op.get("from", "")))
                if isinstance(fcont, list):
                    del fcont[int(fkey)]
                else:
                    fcont.pop(fkey, None)
            cont, key = container_and_key(parts)
            if isinstance(cont, list):
                cont.append(src) if key == "-" else cont.insert(int(key), src)
            else:
                cont[key] = src
    return doc


# ───────────────────────── 이벤트 빌더 ─────────────────────────
def ev_run_started(rid, phase, idx, ts):
    return {"type": "RunStarted", "threadId": rid,
            "runId": "%s#%s@%d" % (rid, phase or "run", idx), "timestamp": ts}


def ev_step_started(name, ts):
    return {"type": "StepStarted", "stepName": name, "timestamp": ts}


def ev_step_finished(name, ts, outcome=None):
    e = {"type": "StepFinished", "stepName": name, "timestamp": ts}
    if outcome:
        e["outcome"] = outcome
    return e


def ev_state_snapshot(st, ts):
    return {"type": "StateSnapshot", "snapshot": st, "timestamp": ts}


def ev_state_delta(patch, ts):
    return {"type": "StateDelta", "delta": patch, "timestamp": ts}


def ev_run_finished_success(ts):
    return {"type": "RunFinished", "outcome": {"type": "success"}, "timestamp": ts}


def ev_run_finished_interrupt(interrupts, ts):
    return {"type": "RunFinished",
            "outcome": {"type": "interrupt", "interrupts": interrupts}, "timestamp": ts}


def ev_custom(name, value, ts):
    return {"type": "Custom", "name": name, "value": value, "timestamp": ts}


# ───────────────────── render_runmd 재사용(선택지·추천 — next-action.sh 와 동일 소스) ─────────────────────
def _option_keys(rdir, phase):
    try:
        import render_runmd as R
        return list(R._option_keys(rdir, phase) or [])
    except Exception:
        return []


def _recommendation(rdir, st):
    try:
        import render_runmd as R
        return R._recommendation(rdir, st)
    except Exception:
        return None


# ───────────────────── history 문자열 → 생명주기 이벤트(스키마 x-history-event-map) ─────────────────────
def _gen_stepname(ev):
    """generate:* 이벤트에서 엔진 접미(:claude|:codex|:stub)를 떼어낸 스텝명."""
    parts = ev.split(":")
    if parts and parts[-1] in _GEN_ENGINES:
        parts = parts[:-1]
    return ":".join(parts)


def _find_verdict(rdir, vid, stage):
    """review:produced:<stage>:<vid> 의 verdict.json 을 찾는다 — id 정확일치 우선, 없으면 파일명에 stage 포함."""
    best = None
    for root, _dirs, files in os.walk(rdir):
        if os.path.basename(root) == ".events":
            continue
        for fn in files:
            if not fn.endswith("-verdict.json"):
                continue
            p = os.path.join(root, fn)
            try:
                d = load_json(p)
            except Exception:
                continue
            if vid and d.get("id") == vid:
                return p                      # id 정확일치 = 결정적
            if stage and stage in fn and best is None:
                best = p
    return best


def _kcia_verdict_event(ev, rdir, ts):
    parts = ev.split(":")                     # ["review","produced",<stage>,<vid...>]
    stage = parts[2] if len(parts) > 2 else ""
    vid = ":".join(parts[3:]) if len(parts) > 3 else ""
    value = {"stage": stage}
    if vid:
        value["id"] = vid
    vf = _find_verdict(rdir, vid, stage)
    if vf:
        try:
            v = load_json(vf)
            for k in ("verdict", "engine", "escalate", "review_depth",
                      "critic_ran", "critic_outcome", "critic_engine", "confidence"):
                if k in v:
                    value[k] = v[k]
            value["violations"] = len(v.get("violations") or [])
        except Exception:
            pass
    return ev_custom("kcia.verdict", value, ts)


def map_history_entry(entry, rdir, idx, rid):
    """history 항목 1건 → AG-UI 이벤트 목록(0개 이상). 미지 문자열은 무시(빈 목록) — 절대 예외 안 냄."""
    ev = entry.get("event", "") or ""
    phase = entry.get("phase", "") or ""
    # HIGH(F2): 방출 이벤트의 timestamp 는 항상 방출시각(now_iso, 구성상 유효). state.json history[].ts 는
    #   무제약 문자열(state.schema)이라 그대로 AG-UI strict timestamp 로 넣으면 패턴 위반 → 배치 halt/영구 starve.
    #   .events 는 골든 제외라 벽시계 비결정 무해. (원본 ts 를 보존하려면 검증 안 되는 payload 필드에 둘 것 — timestamp 금지.)
    ts = now_iso()
    out = []

    if ev.startswith("run:created"):
        out.append(ev_run_started(rid, phase, idx, ts))
    elif ev.startswith("intake:staged"):
        out.append(ev_step_started("intake:" + phase, ts))
    elif ev.startswith("phase:enter"):
        out.append(ev_step_started("phase:" + phase, ts))
    elif ev.startswith("generate:ok:"):                 # subprocess(헤드리스) 생성 완료 마커
        name = _gen_stepname(ev)
        out.append(ev_step_started(name, ts))
        out.append(ev_step_finished(name, ts, "ok"))
    elif ev.startswith("generate:"):                    # insession/concept-axes/axis/art/plan/guideline/evidence/intake
        name = _gen_stepname(ev)
        out.append(ev_step_started(name, ts))
        out.append(ev_step_finished(name, ts, "ok"))
    elif ev.startswith("resume:transition:") or ev.startswith("migrate:") or ev.startswith("sensitive:confirmed:"):
        pass                                            # 멱등 재개·내부 복구·승인접힘 — 독립 생명주기 이벤트 없음
    elif ev.startswith("review:produced:"):
        out.append(_kcia_verdict_event(ev, rdir, ts))   # Custom(kcia.verdict)
    elif ev.startswith("review:passed"):
        out.append(ev_step_finished("review:" + phase, ts, "passed"))
    elif "escalated" in ev:                             # review:revise→escalated / human:revise→escalated / loop-guard:escalated
        out.append(ev_custom("harness.escalated", {"phase": phase, "event": ev}, ts))
    elif ev.startswith("review:revise→generate") or ev.startswith("human:changes_requested→generate"):
        out.append(ev_step_finished("review:" + phase, ts, "revise"))
        out.append(ev_step_started("generate:" + phase, ts))
    elif ev.startswith("human:approved→review") or ev.startswith("select:"):
        out.append(ev_step_started("review:" + phase, ts))   # 사람 결정 해소 → 심의 스텝 시작
    elif ev.startswith("limit:raised:"):
        out.append(ev_step_started("generate:" + phase, ts))  # 한도 상향 해소 → 재생성 시작
    elif ev.startswith("ingest:ok"):
        out.append(ev_step_finished("ingest", ts, "ok"))
    elif ev.startswith("report:ok"):
        out.append(ev_step_finished("report", ts, "ok"))
    elif ev.startswith("workflow:complete"):
        out.append(ev_run_finished_success(ts))
    return out


# ───────────────────── 사람 게이트(interrupt) 합성 ─────────────────────
def compute_interrupt(st, rdir):
    """현재 상태가 '사람 개입 대기'면 (interrupts[], dedup-key) 반환. 아니면 (None, None).
    kind: status=escalated→raise-limit · gate=select&pending→select · gate=user&pending→approve.
    next-action.sh 의 분기 규칙과 동일 소스(선택지/추천은 render_runmd 재사용)."""
    phase = st.get("phase")
    gate = st.get("gate")
    status = st.get("status")
    it = st.get("iteration")

    if status == "escalated":
        kind = "raise-limit"
    elif gate == "select" and status == "pending":
        kind = "select"
    elif gate == "user" and status == "pending":
        kind = "approve"
    else:
        return None, None

    # 엣지 트리거 키(같은 게이트 재진입은 중복 방출 안 함). 반복(iteration)·선택안까지 포함해 새 진입만 구분.
    key = "%s|%s|%s|%s|%s" % (phase, gate, status, it, st.get("selected_option"))
    interrupt_id = "%s:%s:%s" % (phase, kind, it)

    if kind == "select":
        options = _option_keys(rdir, phase)
        if not options:
            return None, None                 # 선택지 미도출 → 무효(minItems 1) 이벤트 회피(best-effort)
        item = {"interruptId": interrupt_id, "kind": "select", "phase": phase,
                "options": options, "recommended": _recommendation(rdir, st)}
    else:
        item = {"interruptId": interrupt_id, "kind": kind, "phase": phase}
    return [item], key


# escalation(raise-limit) 개입을 history 영구 마커에서 복구(HIGH-1) — 현재-상태가 escalated 를 이미 벗어났어도
#   (raise-limit 이 status 를 revise 로 되돌림 → compute_interrupt 는 None) 로그가 마커에서 개입을 정확히 한 번 되살린다.
def _iter_from_marker(ev):
    """escalation 마커(loop-guard:escalated:5/3 · review:revise→escalated:5/3 등)에서 iteration 숫자 추출.
    raise-limit 은 iteration 을 바꾸지 않으므로 이 값 = 에스컬레이션 시점 st.iteration = compute_interrupt 가 쓰는
    값 → 같은 interruptId 로 dedup(라이브 관측과 겹쳐도 이중 방출 안 함)."""
    m = re.search(r"(\d+)\s*/\s*\d+", ev)
    return m.group(1) if m else "?"           # 형식 미상이면 안정 고정값(같은 마커 → 같은 id)


def _history_interrupts(hist):
    """history 의 영구 escalation 마커 → [(interruptId, interrupt-item)]. interruptId 규칙은 compute_interrupt
    와 동일(<phase>:raise-limit:<iter>)이라 현재-상태 유도와 겹쳐도 dedup 된다. 마커가 여럿이어도 같은 iter/phase 는
    한 번만(같은 id)."""
    out = []
    seen = set()
    for entry in hist:
        ev = entry.get("event", "") or ""
        if "escalated" not in ev:
            continue
        phase = entry.get("phase", "") or ""
        iid = "%s:%s:%s" % (phase, "raise-limit", _iter_from_marker(ev))
        if iid in seen:
            continue
        seen.add(iid)
        out.append((iid, {"interruptId": iid, "kind": "raise-limit", "phase": phase}))
    return out


# ───────────────────────── 로그 = 진실의 출처(load·repair·reconstruct) ─────────────────────────
def _atomic_rewrite_lines(path, texts):
    """유효 라인만으로 로그를 원자적으로 재작성(부분/손상 라인 복구용). tmp+fsync+os.replace."""
    d = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(d, ".tmp.%d.%s" % (os.getpid(), os.path.basename(path)))
    with open(tmp, "w", encoding="utf-8") as f:
        for t in texts:
            f.write(t + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _load_log(rid):
    """.events/agui.jsonl 을 파싱한 이벤트 목록(로그=진실의 출처). 필요 시 파일을 복구한다:
      - 끝의 '부분 라인'(개행 없이 중단된 쓰기): 완전한 JSON 이면 유지(개행만 보정)·아니면 폐기(잘림).
      - 중간 손상 라인: 건너뛰고 stderr 경고(record-atomic append 이후엔 발생 안 함, 방어적).
    복구가 필요할 때만 재작성(그 외엔 읽기만). 이 쓰기는 .events(투영 파생 뷰)뿐 — state.json 은 불변."""
    path = events_file(rid)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception:
        return []
    if not raw:
        return []
    complete = raw.split("\n")
    trailing = complete[-1]              # 개행종료면 '' · 아니면 마지막(부분) 라인
    complete = complete[:-1]
    events = []
    valid_texts = []
    need_repair = False
    for t in complete:
        if t.strip() == "":
            continue
        try:
            events.append(json.loads(t)); valid_texts.append(t)
        except Exception:
            need_repair = True
            sys.stderr.write("[agui] 로그 중간 손상 라인 건너뜀(복구)\n")
    if trailing.strip() != "":
        try:
            events.append(json.loads(trailing)); valid_texts.append(trailing)
            need_repair = True           # 완전 JSON 인데 개행 누락 → 보정
        except Exception:
            need_repair = True           # 잘린 부분 라인 → 폐기(복구)
    if need_repair:
        try:
            _atomic_rewrite_lines(path, valid_texts)
        except Exception:
            pass
    return events


def _reconstruct_state(logged):
    """로그의 StateSnapshot + 순차 StateDelta 로 '마지막으로 투영된 state' 재구성.
    반환 (proj_state or None, has_snapshot)."""
    proj = None
    has_snapshot = False
    for ev in logged:
        t = ev.get("type")
        if t == "StateSnapshot":
            proj = json.loads(json.dumps(ev.get("snapshot")))
            has_snapshot = True
        elif t == "StateDelta" and proj is not None:
            try:
                proj = apply_patch(proj, ev.get("delta") or [])
            except Exception:
                sys.stderr.write("[agui] 로그 델타 적용 실패 — state 재구성 부분중단(재스냅샷 안 함)\n")
                return proj, has_snapshot
    return proj, has_snapshot


def _logged_interrupt_ids(logged):
    """로그에 이미 방출된 interruptId 집합(개입 dedup 용, 로그 재파생 안정)."""
    ids = set()
    for ev in logged:
        if ev.get("type") != "RunFinished":
            continue
        oc = ev.get("outcome") or {}
        if oc.get("type") == "interrupt":
            for it in (oc.get("interrupts") or []):
                if it.get("interruptId"):
                    ids.add(it["interruptId"])
    return ids


# ───────────────────── 위치 기반 투영(history-index 프리픽스) + crash 마커 시맨틱 키 dedup ─────────────────────
def _dedup_key(entry):
    """crash-재진입으로 '동일 내용'이 재적재되는 생명주기 마커의 안정 키(불변 내용 기반).
    None = dedup 대상 아님(정상 반복 허용). review:produced=stage+verdict-id · select=phase+선택.
    (verdict id 는 실 심의=병합된 위반의 sha 접미 · autopass=stage-결정적 → 재리뷰가 내용을 바꾸면 id 가
     달라져 접히지 않고, crash-재적재는 동일 id 라 접힌다.)"""
    ev = entry.get("event", "") or ""
    if ev.startswith("review:produced:"):
        parts = ev.split(":")
        stage = parts[2] if len(parts) > 2 else ""
        vid = ":".join(parts[3:]) if len(parts) > 3 else ""
        return ("review:produced", stage, vid)
    if ev.startswith("select:"):
        return ("select", entry.get("phase", "") or "", ev[len("select:"):])
    return None


def _logged_lifecycle_count(logged):
    """로그의 생명주기 이벤트 개수 = 이미 투영된 history 위치 프리픽스 길이. StateSnapshot/StateDelta 와
    interrupt(RunFinished:interrupt)는 제외한다 — 이들은 위치 투영이 아니라 각각 has_snapshot·실델타·interruptId
    로 dedup 되기 때문. 로그가 기대 시퀀스의 in-order 프리픽스이므로(history append-only + 락 직렬 append),
    이 개수 이후(expected[count:])만 방출하면 각 위치가 정확히 한 번 방출된다. ★ 옛 전체-행 해시(seen_rows)를
    폐기 — 같은-초 ts 를 공유하는 서로 다른 두 실행이 false-collapse 되던 결함을 없앤다(Finding A)."""
    n = 0
    for ev in logged:
        t = ev.get("type")
        if t in ("StateSnapshot", "StateDelta"):
            continue
        if t == "RunFinished" and (ev.get("outcome") or {}).get("type") == "interrupt":
            continue
        n += 1
    return n


def _expected_lifecycle(hist, rdir, rid):
    """history 전체 → 기대 생명주기 이벤트 시퀀스(in-order). history 위치마다 map_history_entry 로 0개 이상
    이벤트를 방출한다(위치 1:1). crash-재진입으로 '동일 내용'이 **새 위치**에 재적재되는 마커(review:produced=
    stage+verdict-id · select=phase+선택)만 안정 시맨틱 키(_dedup_key)로 접어 재방출을 막는다(round-1 HIGH-3
    보존 — 위치 투영만으론 새 위치라 다시 나오므로 시맨틱 오버레이 필요). 그 외 항목(generate:ok 등)은 접지
    않는다 — 같은-초 ts 를 공유해도 서로 다른 실행이면 둘 다 방출(Finding A). 로그는 이 시퀀스의 프리픽스이므로
    sync 는 _logged_lifecycle_count 이후만 append 한다(위치 기반 투영 — 커서·내용해시 무의존)."""
    seen_dedup = set()
    seq = []
    for i, entry in enumerate(hist):
        dk = _dedup_key(entry)
        if dk is not None:
            if dk in seen_dedup:
                continue             # 시맨틱 동일 재적재(crash 재진입) → 접음(review:produced/select)
            seen_dedup.add(dk)
        seq.extend(map_history_entry(entry, rdir, i, rid))
    # RunStarted 선두 보장(intake 기원 런은 run:created 부재 → intake:staged 로 시작; MED). 위치 0 결정적 → 재sync 안정.
    if hist and not any(e.get("type") == "RunStarted" for e in seq):
        seq.insert(0, ev_run_started(rid, hist[0].get("phase") or "", 0, now_iso()))
    return seq


# ───────────────────────── 실행 락(동시 sync 이중적재 차단, best-effort) ─────────────────────────
def _acquire_lock(rid):
    """반환: ("flock", fd, fcntl)=flock 획득 · ("mkdir", ld)=mkdir 원자 뮤텍스 획득 · "nolock"=끝내 실패(무락 진행).
    1차=flock(fcntl 가용 시). ★ flock 이 '지원되지만 경쟁 중'(EAGAIN/EWOULDBLOCK/EACCES)이면 유한 대기 후 초과 시
    무락 진행한다 — mkdir 로 갈아타지 않는다(같은 플랫폼의 다른 sync 도 flock 을 쓰므로 기전을 섞으면 상호배제가
    깨진다). fcntl **부재** 또는 flock **미지원**(ENOTSUP·EOPNOTSUPP·NFS 등 held 집합 밖 errno)일 때만 2차=mkdir
    원자 뮤텍스로 폴백한다(그 플랫폼의 모든 sync 가 동일하게 mkdir 를 쓰므로 read-then-append TOCTOU 를 실제로
    직렬화 — Finding B). 둘 다 못 얻으면 무락 진행(best-effort; 위치 기반 dedup 이 무한 중복은 막지만 동시 초기화
    이벤트 1중복은 no-lock 플랫폼 잔여 한계). ★ 절대 None 반환 금지(HIGH-1: 조용한 skip-all 금지). flock=프로세스
    종료 시 자동 해제 · lockdir=stale 회수 — 어느 쪽도 크래시로 영구잠금 안 됨."""
    try:
        import fcntl
    except Exception:
        return _mkdir_lock_or_nolock(rid)          # fcntl 부재 → mkdir 폴백.
    try:
        os.makedirs(events_dir(rid), exist_ok=True)
        fd = open(os.path.join(events_dir(rid), ".lock"), "w")
    except Exception:
        return _mkdir_lock_or_nolock(rid)
    import time
    import errno
    held = {getattr(errno, n) for n in ("EAGAIN", "EWOULDBLOCK", "EACCES") if hasattr(errno, n)}
    deadline = time.time() + _LOCK_TIMEOUT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return ("flock", fd, fcntl)
        except (OSError, IOError) as e:
            if getattr(e, "errno", None) in held:      # 지원됨·경쟁 중 → 타임아웃까지 대기 후 재시도.
                if time.time() >= deadline:
                    try:
                        fd.close()
                    except Exception:
                        pass
                    return "nolock"                    # 타임아웃 → 무락 진행(mkdir 로 안 갈아탐: 상호배제 유지, HIGH-1).
                time.sleep(_LOCK_POLL)
                continue
            try:                                       # flock 미지원(ENOTSUP/EOPNOTSUPP/NFS 등) → mkdir 폴백.
                fd.close()
            except Exception:
                pass
            return _mkdir_lock_or_nolock(rid)


def _mkdir_lock_or_nolock(rid):
    """flock 불가 플랫폼용 2차 뮤텍스 진입점. mkdir 획득이면 ("mkdir", ld), 끝내 실패면 "nolock"(무락 진행)."""
    ld = _acquire_mkdir_lock(rid)
    return ("mkdir", ld) if ld is not None else "nolock"


def _acquire_mkdir_lock(rid):
    """`.events/.lockdir` 원자 획득(os.mkdir=POSIX atomic, fcntl 불요·NFS 이식). 유한 대기(_LOCK_TIMEOUT).
    stale 회수: 보유 PID 사망 또는 lockdir 나이 > _LOCKDIR_STALE 면 회수(rename→삭제)해 크래시 홀더의 영구 데드락을
    막는다. 반환: lockdir 경로(획득) · None(끝내 실패 → 무락 진행)."""
    import time
    try:
        os.makedirs(events_dir(rid), exist_ok=True)
    except Exception:
        return None
    ld = os.path.join(events_dir(rid), ".lockdir")
    deadline = time.time() + _LOCK_TIMEOUT
    while True:
        try:
            os.mkdir(ld)                       # 원자적 — 성공 = 단독 획득.
            _write_lock_pid(ld)
            return ld
        except FileExistsError:
            if _lockdir_is_stale(ld):
                _reclaim_lockdir(ld)           # stale(크래시/노후) → 회수 후 재시도.
                continue
            if time.time() >= deadline:
                return None                    # 유한 대기 초과 → 무락 진행(best-effort).
            time.sleep(_LOCK_POLL)
        except Exception:
            return None                        # mkdir 불가(권한 등) → 무락 진행.


def _write_lock_pid(ld):
    """lockdir 보유 PID 기록(stale 판정용, best-effort)."""
    try:
        with open(os.path.join(ld, "pid"), "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError as e:
        import errno
        return getattr(e, "errno", None) == errno.EPERM   # 존재하나 시그널 권한 없음 → 살아있음으로 간주.
    except Exception:
        return False


def _lockdir_is_stale(ld):
    """lockdir 이 stale(회수 대상)인가 — 보유 PID 사망 OR 나이 > _LOCKDIR_STALE. 신선한 lock(나이~0·PID 생존)은
    절대 stale 로 오판하지 않는다(정상 경쟁 홀더 보호 → 이중 회수로 신선 lock 을 지우는 사고 방지). pid 파일
    부재/손상이면 나이로만 판정."""
    import time
    try:
        with open(os.path.join(ld, "pid"), encoding="utf-8") as f:
            pid = int((f.read() or "").strip() or "0")
        if pid > 0 and not _pid_alive(pid):
            return True
    except Exception:
        pass
    try:
        if time.time() - os.path.getmtime(ld) > _LOCKDIR_STALE:
            return True
    except Exception:
        pass
    return False


def _reclaim_lockdir(ld):
    """stale lockdir 원자 회수: rename 으로 먼저 치운다(단독 회수자만 성공 — 나머지는 예외=무해). _lockdir_is_stale
    판정을 통과한 것만 넘어오고 신선 lock(나이~0·PID 생존)은 stale 로 안 뜨므로, rename 원자성과 함께 신선 lock 을
    지우는 사고를 사실상 배제한다(잔여 sub-ms 경계 경합은 no-lock 로 degrade — best-effort)."""
    import time
    victim = "%s.stale.%d.%d" % (ld, os.getpid(), int(time.time() * 1000))
    try:
        os.rename(ld, victim)                  # 원자적 hand-off — 이미 치워졌으면 예외(무해).
    except Exception:
        return
    try:
        pf = os.path.join(victim, "pid")
        if os.path.exists(pf):
            os.remove(pf)
    except Exception:
        pass
    try:
        os.rmdir(victim)
    except Exception:
        pass


def _release_lock(lock):
    if not lock or lock == "nolock":
        return
    kind = lock[0]
    if kind == "flock":
        _, fd, fcntl = lock
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            fd.close()
        except Exception:
            pass
    elif kind == "mkdir":
        ld = lock[1]
        try:
            pf = os.path.join(ld, "pid")
            if os.path.exists(pf):
                os.remove(pf)
        except Exception:
            pass
        try:
            os.rmdir(ld)
        except Exception:
            pass


# ───────────────────────── record-atomic append (검증 + 단일 write) ─────────────────────────
def _append_events(rid, events):
    """검증 통과 이벤트를 agui.jsonl 에 record-atomic 하게 append(유효 이벤트 전체를 단일 write). 무효
    이벤트는 stderr 로 '표면화'하되 그 1건만 건너뛰고 배치는 계속한다(HIGH-2: 영구 halt 금지 — 한 개의 악성
    이벤트가 이후 모든 델타/개입을 영영 막지 못하게. timestamp 가 구성상 유효(now_iso)하므로 검증 실패는 드물고
    진짜 버그를 뜻한다). 로그를 desync 하지 않는다 — 건너뛴 이벤트는 로그에 없어 다음 sync 가 후보로 재산출하고,
    뒤 이벤트는 로그에 있어 dedup 된다. 반환 = append 된 이벤트 수."""
    if not events:
        return 0
    valid = []
    for ev in events:
        errs = validate_event(ev)
        if errs:
            sys.stderr.write("[agui] 이벤트 스키마 검증 실패(건너뜀·배치 계속 — 버그 표면화): %s %s\n"
                             % (ev.get("type"), errs))
            continue                     # 그 1건만 skip; 배치의 나머지는 계속(최선노력 골든-제외 파생 뷰)
        valid.append(ev)
    if not valid:
        return 0
    os.makedirs(events_dir(rid), exist_ok=True)
    text = "".join(json.dumps(ev, ensure_ascii=False) + "\n" for ev in valid)  # 전체를 한 번에
    with open(events_file(rid), "a", encoding="utf-8") as f:
        f.write(text)                    # 단일 write — 중단돼도 기존 라인 불변(꼬리 부분 라인은 다음 _load_log 가 복구)
        f.flush()
        os.fsync(f.fileno())
    return len(valid)


# ───────────────────────── sync (로그=진실 재구성 투영) ─────────────────────────
def sync(rid):
    """state.json 에서 아직 투영 안 한 이벤트만 append(멱등). 로그가 진실의 출처(커서는 체크포인트일 뿐).
    state.json 은 절대 쓰지 않는다."""
    sf = state_file(rid)
    if not os.path.exists(sf):
        return 0

    lock = _acquire_lock(rid)            # flock→mkdir 폴백·never None — 둘 다 불가/타임아웃이면 무락 진행(HIGH-1: skip-all 금지).
    try:
        try:
            st = load_json(sf)           # ★ 락 획득 뒤 state 재로드 → 항상 현재 상태로 투영(경쟁 sync 가 라이브 상태를 놓치지 않음).
        except Exception:
            return 0
        logged = _load_log(rid)          # 진실의 출처(부분/손상 라인 복구 포함)
        proj_state, has_snapshot = _reconstruct_state(logged)
        logged_iids = _logged_interrupt_ids(logged)
        # 이미 투영된 생명주기 이벤트 개수 = 위치 프리픽스 길이(로그는 기대 시퀀스의 in-order 프리픽스). 스냅샷/델타/
        #   interrupt 는 제외(has_snapshot·실델타·interruptId 로 별도 dedup). ★ Finding A: 전체-행 내용해시가 아니라
        #   위치로 세므로 같은-초 ts 를 공유하는 서로 다른 두 실행이 false-collapse 되지 않고 둘 다 산다.
        projected = _logged_lifecycle_count(logged)

        hist = st.get("history") or []
        rdir = run_dir(rid)

        # (기대 생명주기 시퀀스) history 위치 1:1 투영 + crash 재적재 마커만 시맨틱 키로 접음(round-1 HIGH-3 보존).
        expected = _expected_lifecycle(hist, rdir, rid)

        new_events = []
        # (0) 첫 투영 → 현재 state 전체 스냅샷(재개/재연결 기점). proj_state=현재 state 로 두어 델타 없음.
        if not has_snapshot:
            new_events.append(ev_state_snapshot(st, now_iso()))
            proj_state = json.loads(json.dumps(st))

        # (1) 위치 기반: 기대 시퀀스에서 아직 투영 안 된 접미(expected[projected:])만 방출. 각 위치는 정확히 한 번
        #     방출되고(내용해시 dedup 없음 → 같은-초 dup false-collapse 없음), 재적재 crash 마커는 expected 생성 시
        #     시맨틱 키로 접혀 재방출 안 됨. 멱등 재sync 는 projected==len(expected) 라 0건.
        new_events.extend(expected[projected:])

        # (2) StateDelta — '마지막 투영 state' 대비 현재 state 의 실제 변화만(없으면 방출 안 함=멱등).
        if proj_state is not None:
            patch = compute_patch(proj_state, st)
            if patch:
                new_events.append(ev_state_delta(patch, now_iso()))

        # (3) 사람 게이트(interrupt) — interruptId 로 dedup(로그 재파생 안정, 재진입 중복 방출 안 함).
        #     현재-상태 개입(select/approve/raise-limit) + history 영구 마커에서 복구한 개입(HIGH-1). 라이브 관측을
        #     놓쳐도(락 경쟁으로 escalated 를 못 본 사이 raise-limit 이 상태를 옮겨도) history 마커가 남아 이후 sync 가
        #     정확히 한 번 방출한다. interruptId 규칙이 동일해(<phase>:raise-limit:<iter>) 두 경로가 겹쳐도 dedup.
        seen_iids = set(logged_iids)
        pending = []
        cur_interrupts, _ikey = compute_interrupt(st, rdir)
        if cur_interrupts:
            item = cur_interrupts[0]
            iid = item.get("interruptId")
            if iid and iid not in seen_iids:
                pending.append(item)
                seen_iids.add(iid)
        for iid, item in _history_interrupts(hist):
            if iid and iid not in seen_iids:
                pending.append(item)
                seen_iids.add(iid)
        for item in pending:
            new_events.append(ev_run_finished_interrupt([item], now_iso()))

        appended = _append_events(rid, new_events)   # write → (성공 후) 커서 체크포인트

        # 커서 = 체크포인트/최적화일 뿐(진실 아님 — append 결정은 로그로만 한다). append 뒤에 로그 정합으로 재구축.
        try:
            atomic_write_json(cursor_file(rid),
                              {"history_len": len(hist),
                               "events_len": len(logged) + appended,
                               "has_snapshot": True})
        except Exception:
            pass
        return appended
    finally:
        _release_lock(lock)


# ───────────────────────── replay (읽기 전용) ─────────────────────────
def replay(rid):
    """읽기 전용: 방출된 로그(.events/agui.jsonl)를 stdout JSONL 스트림. 없으면 현재 state 에서 즉석 파생.
    어느 경로도 state.json·.events 를 쓰지 않는다(파생-전용, next-action.sh 사상)."""
    ef = events_file(rid)
    if os.path.exists(ef):
        with open(ef, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                try:
                    json.loads(line)     # 파싱 가능한 완전 라인만 스트림(꼬리 부분 라인은 조용히 생략 — 읽기 전용, 복구/쓰기 없음).
                except Exception:
                    continue
                print(line)
        return 0
    # fallback: 로그 부재 → 현재 state 에서 스냅샷+생명주기(델타 없음) 즉석 파생.
    sf = state_file(rid)
    if not os.path.exists(sf):
        return 0
    st = load_json(sf)
    rdir = run_dir(rid)
    evs = [ev_state_snapshot(st, now_iso())]
    for i, entry in enumerate(st.get("history") or []):
        evs.extend(map_history_entry(entry, rdir, i, rid))
    interrupts, _ = compute_interrupt(st, rdir)
    if interrupts is not None:
        evs.append(ev_run_finished_interrupt(interrupts, now_iso()))
    for ev in evs:
        print(json.dumps(ev, ensure_ascii=False))
    return 0


# ───────────────────────── emit (저수준 단일 이벤트 — 도구/테스트용) ─────────────────────────
def emit(rid, etype, fields):
    """단일 이벤트를 조립·검증 후 append(멱등 dedup 없음 — 셸 4지점은 sync 를 쓴다).
    fields: {"k": <json-or-str>} — value/snapshot/delta/outcome 등 이벤트별 필드. timestamp 미지정 시 now_iso()."""
    ev = {"type": etype}
    for k, v in fields.items():
        ev[k] = v
    ev.setdefault("timestamp", now_iso())
    errs = validate_event(ev)
    if errs:
        sys.stderr.write("[agui] emit 거부(무효 이벤트): %s\n" % errs)
        return 1
    lock = _acquire_lock(rid)            # append 는 sync 와 같은 락으로 직렬화(flock→mkdir 폴백·record-atomic). never None(둘 다 불가면 무락 진행).
    try:
        return 0 if _append_events(rid, [ev]) else 1
    finally:
        _release_lock(lock)


# ───────────────────────── CLI ─────────────────────────
def _rid_from(rest):
    if not rest:
        return None
    if rest[0] == "--run":
        return rest[1] if len(rest) > 1 else None
    return rest[0]


def main(argv):
    if not argv:
        sys.stderr.write(__doc__)
        return 2
    cmd = argv[0]
    rest = argv[1:]
    if cmd in ("sync", "replay"):
        rid = _rid_from(rest)
        if not rid:
            sys.stderr.write("사용법: agui_events.py %s <run_id>\n" % cmd)
            return 2
        if not _rid_ok(rid):
            sys.stderr.write("[agui] run-id 경로 거부(runs/ 밖): %s\n" % rid)
            return 2
        if cmd == "sync":
            sync(rid)            # 방출량은 stdout 오염 없이 조용히(best-effort). 진단은 stderr.
        else:
            replay(rid)
        return 0
    if cmd == "emit":
        rid = None
        etype = None
        fields = {}
        i = 0
        while i < len(rest):
            a = rest[i]
            if a == "--run":
                rid = rest[i + 1]; i += 2
            elif a == "--event":
                etype = rest[i + 1]; i += 2
            elif a == "--field":
                kv = rest[i + 1]; i += 2
                k, _sep, raw = kv.partition("=")
                try:
                    fields[k] = json.loads(raw)
                except Exception:
                    fields[k] = raw
            else:
                i += 1
        if not rid or not etype:
            sys.stderr.write("사용법: agui_events.py emit --run <id> --event <Type> [--field k=v ...]\n")
            return 2
        if not _rid_ok(rid):
            sys.stderr.write("[agui] run-id 경로 거부(runs/ 밖): %s\n" % rid)
            return 2
        return emit(rid, etype, fields)
    sys.stderr.write("알 수 없는 서브커맨드: %s (sync|replay|emit)\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
