#!/usr/bin/env python3
"""a2ui_action.py — A2UI ClientEvent(named action) 검증 + 현업 4동작 스크립트로 위임(기계 브리지).

사용: a2ui_action.py <run_id> <run_dir> <event>
  <event> = action.json 파일 경로 또는 인라인 JSON 문자열. 예:
    {"action":"select","value":"A-efficacy","comment":"..."}
    {"action":"approve","ra_ok":true,"comment":"..."}
    {"action":"revise","direction":"이 표현 빼줘","target":"..."}
    {"action":"raise-limit"}

절대 규칙: state.json 을 직접 쓰지 않는다. 현재 surface(a2ui_surface.derive)의 허용 action 을
검증한 뒤, 유효하면 select.sh/approve.sh/revise.sh/run-stage.sh(raise-limit) 로 위임한다
(상태 변이는 그 스크립트가 lock 잡고 수행 — 여기선 검증·라우팅만).

기계 브리지 계약: 성공·거부 모두 stdout 에 '단일 JSON envelope' 한 줄을 방출한다(json.loads 가능) —
  {"ok":bool, "action":str|null, "delegate":str|null, "exit":int, "message":str, "error":str|null}.
  · exit 충실성: 위임이 정상 종료하면 envelope["exit"] == a2ui-action.sh 프로세스 rc == 위임 exit code(0..255).
    위임이 신호로 죽으면(subprocess returncode 음수) 셸 규약 128+signal 로 매핑해 envelope["exit"] 와 프로세스
    rc 를 '일치'시킨다(둘이 어긋나지 않는다). 브리지 자체 오류(거부 rc2/내부 rc3)는 error="bridge" 로 표식 →
    위임이 우연히 같은 코드(2/3)로 종료한 경우(error=null·delegate!=null)와 구분된다(내부코드↔위임코드 충돌 방지).
  · 디코드 안전: 위임 출력은 bytes 로 캡처 후 errors="replace" 로 디코드한다 — 비-UTF8 바이트 1개가 있어도
    디코드 예외로 위임의 실제 exit/성공을 '잃지 않는다'(옛 text=True 는 그 바이트에서 크래시→rc3·delegate=None 오보).
  · 출력 상한: 극단 대용량 출력 위임이 브리지를 OOM 시키지 못하게 캡처를 _READ_CAP 로 상한(초과분은 드레인만).
  (위임 스크립트는 사람용 TEXT 를 찍으므로 그대로 흘리면 기계 파싱이 깨진다 → 캡처해서 message 로 감싼다. 사람
  대상 평이화는 Stage 4 의 몫, 이 브리지는 기계용.)

보안: 사용자 텍스트 필드(comment/value/optionKey/direction/target/by)는 위임 스크립트의 옵션('--...')으로
  오인될 수 없어야 한다. 위임 스크립트(select/approve/revise)는 '--' end-of-options 를 존중하지 않으므로
  '--' 로 시작하는 값은 리터럴로 넘길 방법이 없다 → 거부한다(예: comment='--ra-ok' → RA_OK 승격,
  '--by=forged' → 감사 행위자 위조 차단). ra_ok·by 는 오직 구조화 필드(ev['ra_ok'] is True, ev['by'])에서만
  유래하며 free-text 에서 파생되지 않는다.
"""
import sys, os, json, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a2ui_surface as A          # 표면 파생 재사용(허용 action/options 를 표면과 동일 소스로 판정)
from harness import load_json     # noqa: E402

_MSG_LIMIT = 4000                 # 위임 출력 message 트림 상한(기계 envelope).
_READ_CAP = 1 << 20               # 위임 출력 캡처 하드 상한(1MiB) — 극단 출력 OOM 방지. message 는 다시 _MSG_LIMIT 로 트림.


def _emit(ok, action, delegate, exit_code, message, error=None):
    """단일 JSON envelope 한 줄을 stdout 으로 방출(성공·거부 공통 → 기계 파서용).

    error: "bridge" = 브리지 자체 거부/내부오류(위임 미실행 또는 실행 실패) · None = 위임 결과(위임 exit 그대로).
      위임이 우연히 브리지 내부코드(2/3)와 같은 exit 로 끝나도 error(+delegate!=null)로 출처를 구분한다.
    """
    obj = {
        "ok": bool(ok),
        "action": action if isinstance(action, str) else None,
        "delegate": delegate,
        "exit": exit_code,
        "message": (message or "").strip()[:_MSG_LIMIT],
        "error": error,
    }
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _reject(msg, action=None, code=2):
    """검증 실패 = JSON envelope(ok=false, error="bridge")+비-0 rc(기본 2). stderr 에도 사람용 진단 1줄."""
    sys.stderr.write("a2ui-action: %s\n" % msg)
    _emit(False, action, None, code, "a2ui-action: " + msg, error="bridge")
    sys.exit(code)


def _run_delegate(argv):
    """위임 실행 → (returncode:int, text:str). subprocess 로 stdout(+stderr 병합)을 캡처한다.

    · bytes 로 읽어(text=False) errors="replace" 로 디코드 → 비-UTF8 바이트가 있어도 디코드 예외가 나지 않아
      위임의 실제 exit/성공을 잃지 않는다(HIGH — 옛 text=True 는 나쁜 바이트에서 크래시).
    · 캡처는 _READ_CAP 로 상한(대용량 출력 OOM 방지). 상한 초과분은 버리되 파이프는 계속 드레인 → 위임이
      write 블록으로 멈추지 않는다(데드락 방지). returncode 는 신호사망 시 음수(-signum)일 수 있다(호출부 매핑).
    · stdin=DEVNULL: 위임이 stdin 을 읽으려다 무한 대기하는 것 방지(브리지는 비대화형).
    """
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    buf = bytearray()
    truncated = False
    try:
        out = proc.stdout
        while True:
            chunk = out.read(65536)
            if not chunk:
                break
            if len(buf) < _READ_CAP:
                room = _READ_CAP - len(buf)
                buf.extend(chunk[:room])
                if len(chunk) > room:
                    truncated = True
            else:
                truncated = True            # 상한 초과분은 버리되 계속 읽어 파이프를 비운다(write 블록 방지).
    finally:
        proc.stdout.close()
        rc = proc.wait()
    text = buf.decode("utf-8", errors="replace")
    if truncated:
        text += "\n…(위임 출력 상한 %d바이트 초과 — 이하 생략)" % _READ_CAP
    return rc, text


def _delegate_result(argv):
    """위임 실행 결과를 envelope 재료로 정규화 → (ok:bool, delegate_name:str, exit_code:int, message:str).

    exit_code 충실성: 정상 종료(returncode>=0)는 위임 코드 그대로. 신호사망(returncode<0)은 128+signal 로 매핑(셸
      규약) → 이 값을 envelope["exit"] 와 프로세스 rc 양쪽에 써 '둘이 일치'시킨다. 순수 seam(테스트가 직접 호출).
    """
    rc, text = _run_delegate(argv)
    exit_code = (128 - rc) if rc < 0 else rc     # rc=-signum ⇒ 128+signum. 정상은 그대로(0..255).
    return (rc == 0), os.path.basename(argv[1]), exit_code, text


def _load_event(arg):
    """<event> 인자 = 파일 경로면 읽고, 아니면 인라인 JSON 으로 파싱."""
    raw = arg
    if arg and os.path.isfile(arg):
        try:
            raw = open(arg, "r", encoding="utf-8").read()
        except Exception as e:
            _reject("action 파일을 읽지 못했습니다: %s (%s)" % (arg, e))
    try:
        ev = json.loads(raw)
    except Exception as e:
        _reject("action JSON 파싱 실패: %s" % e)
    if not isinstance(ev, dict):
        _reject("action 은 JSON 객체여야 합니다(예: {\"action\":\"select\",\"value\":\"A\"}).")
    return ev


def _scripts_dir():
    return os.path.join(A._harness_root(), "scripts")


def _resolve_option(value, options):
    """select.sh 와 동일한 정확·유일접두 매칭. 매칭 실패 시 None."""
    if value in options:
        return value
    matches = [k for k in options if k.split("-", 1)[0] == value]
    if len(matches) == 1:
        return matches[0]
    return None


def _reject_if_flaglike(field, value, action):
    """위임 스크립트 옵션('--...')으로 오인될 수 있는 사용자 텍스트 거부(CRITICAL).

    위임 스크립트(select/approve/revise)의 인자 파싱 루프엔 '--' end-of-options 케이스가 없어 '--' 로 시작하는
    값을 리터럴 데이터로 넘길 방법이 없다. 그래서 '--' 로 시작하는 값은 거부한다 → comment='--ra-ok' 가
    approve.sh 에서 RA_OK=1 로, '--by=forged' 가 감사 행위자로, '--reason=' 이 멈춤사유로 오인되는 주입을 차단.
    (단일 '-' 로 시작하는 코멘트/불릿은 위임 스크립트가 위치인자로 받으므로 안전 — 막지 않는다.)
    """
    if isinstance(value, str) and value.startswith("--"):
        _reject("'%s' 값은 '--' 로 시작할 수 없습니다(위임 스크립트 옵션으로 오인 방지): %r"
                % (field, value), action=action)


def main():
    if len(sys.argv) < 4:
        _reject("사용법: a2ui_action.py <run_id> <run_dir> <event(json 파일|문자열)>")
    rid, rdir, event_arg = sys.argv[1], sys.argv[2], sys.argv[3]

    ev = _load_event(event_arg)
    action = ev.get("action")

    # LOW: action 은 반드시 문자열. dict/list 면 아래 set 멤버십에서 TypeError(traceback 누수) → 깔끔 거부로 전환.
    if not isinstance(action, str) or not action:
        _reject("action 필드가 문자열이어야 합니다(select|approve|revise|raise-limit).")

    st = load_json(os.path.join(rdir, "state.json"))
    surf = A.derive(rid, rdir, st)
    allowed = surf.get("actions") or []           # ← 카탈로그∩런타임(MED): 허용 action 은 카탈로그가 구동
    surface = surf.get("surface")
    surf_action = surf.get("action")              # decide() action(resume-* 포함)

    # 1) 미지/현재 게이트에 유효하지 않은 action 거부.
    KNOWN = {"select", "approve", "revise", "raise-limit"}
    if action not in KNOWN:
        _reject("알 수 없는 action '%s' — 허용: select|approve|revise|raise-limit." % action, action=action)
    if action not in allowed:
        _reject("지금 화면(surface=%s, gate=%s/%s)에서는 '%s' 를 할 수 없습니다. 가능한 동작: %s"
                % (surface, surf.get("gate"), surf.get("status"), action, allowed or "(없음)"), action=action)

    # 2) CRITICAL: 사용자 텍스트 필드가 위임 옵션으로 오인되지 않게 검증(--ra-ok/--by=/--reason= 주입 차단).
    for _f in ("comment", "value", "optionKey", "direction", "target", "by"):
        _reject_if_flaglike(_f, ev.get(_f), action)

    scripts = _scripts_dir()
    argv = None

    if action == "select":
        value = ev.get("value") or ev.get("optionKey")
        argv = ["bash", os.path.join(scripts, "select.sh"), rid]
        if value:
            resolved = _resolve_option(value, surf.get("options") or [])
            if resolved is None:
                _reject("옵션키 '%s' 가 없습니다. 가능한 값: %s"
                        % (value, surf.get("options") or []), action=action)
            argv.append(resolved)
        elif surf_action != "resume-select":
            # 정상 select 는 옵션키 필수. resume-select(중단 복구)는 select.sh 가 옵션 없이 전이만 재개하므로 허용.
            _reject("select 에는 value(옵션키)가 필요합니다. 예: {\"action\":\"select\",\"value\":\"A-efficacy\"}",
                    action=action)
        if ev.get("comment"):
            argv.append(str(ev["comment"]))

    elif action == "approve":
        argv = ["bash", os.path.join(scripts, "approve.sh"), rid]
        if ev.get("comment"):
            argv.append(str(ev["comment"]))
        if ev.get("ra_ok") is True:               # ra_ok 는 오직 구조화 bool True 에서만 — free-text 파생 불가
            argv.append("--ra-ok")

    elif action == "revise":
        direction = ev.get("direction") or ev.get("value")
        if not direction:
            _reject("revise 에는 direction(보완 방향)이 필요합니다. 예: {\"action\":\"revise\",\"direction\":\"이 표현 빼줘\"}",
                    action=action)
        argv = ["bash", os.path.join(scripts, "revise.sh"), rid, str(direction)]
        if ev.get("target"):
            argv.append(str(ev["target"]))

    elif action == "raise-limit":
        argv = ["bash", os.path.join(scripts, "run-stage.sh"), "raise-limit", rid]

    # by(행위자) 감사 전달(선택) — 오직 구조화 ev['by'] 에서만(위 flaglike 검증 통과분). 4동작 공통 --by 계약.
    if ev.get("by") and action in ("select", "approve", "revise"):
        argv += ["--by", str(ev["by"])]

    # 3) 위임 실행: exec 대신 subprocess 로 캡처 → 단일 JSON envelope 방출(기계 파서 계약). 위임 exit code 를
    #   충실히 보존한다 — 정상 종료=위임 코드 그대로 · 신호사망=128+signal 로 envelope["exit"] 와 프로세스 rc 를
    #   일치시킴. 디코드는 errors="replace"(비-UTF8 바이트가 위임 exit 을 잃게 하지 않음), 출력은 _READ_CAP 상한(OOM).
    try:
        ok, delegate_name, exit_code, message = _delegate_result(argv)
    except Exception as e:
        _reject("위임 실행 실패: %s (%s)" % (argv, e), action=action, code=3)
    _emit(ok, action, delegate_name, exit_code, message, error=None)   # error=None: 위임 결과(브리지 오류 아님)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
