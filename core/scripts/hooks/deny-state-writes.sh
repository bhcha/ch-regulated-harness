#!/usr/bin/env bash
# deny-state-writes.sh — PreToolUse 경화 훅(비-load-bearing). 게이트 경화 계획 3단계.
#
# 무엇을 막는가 — 딱 두 가지. "세션 모드(운영/개발)와 무관하게 절대 금지"인 것만 담는다:
#   1) core/runs/**/state.json  → 진행 상태는 오직 `scripts/*.sh` 만 쓴다(AGENTS.md 절대 규칙 1).
#   2) core/runs/**/.logs/**    → 스크립트 전용 진단 기록(verdict 경로 아님, 골든 제외).
#   대상 도구는 Write·Edit 뿐이다. 스크립트는 **Bash 로** state 를 쓰므로 이 도구-레벨 거부는
#   정당한 작업을 하나도 막지 않는다(사람도 4동작 스크립트로만 상태를 바꾼다).
#
# 무엇을 일부러 안 막는가:
#   · **Bash 명령 문자열 파싱을 하지 않는다.** 공식 문서 스스로 그 방식이 fail-open·best-effort 임을
#     인정하고, 오탐 비용이 이득보다 크다(정당한 `bash scripts/run-stage.sh …` 호출까지 막힌다).
#     Bash 우회는 사후 게이트(verdict 해시 바인딩·advance 마커)가 잡는 것이 이 하네스의 원설계다.
#   · 개발 세션의 **본업**(core/scripts·harness 스키마 수정)은 여기서 막지 않는다 — 그건 머지 게이트
#     (`.github/workflows/ci.yml`)의 몫이다. 이 분담 덕분에 "이 세션이 운영인가 개발인가" 라는
#     판단이 훅 설계에서 사라진다.
#
# ⚠ 이 훅은 판정의 SSoT 가 아니다 — **비-load-bearing 경화 계층**이다.
#   판정의 SSoT 는 셸 게이트다. 이 파일을 지워도 기존 fail-closed 는 하나도 약해지지 않으며,
#   훅이 없는 표면(CI stub subprocess·미래의 다른 실행기)도 지금과 똑같이 안전해야 한다.
#   **어떤 게이트도 "훅이 막아준다"는 전제로 완화하지 말 것.** 회귀 가드 = `tests/test-hook-deny.sh`
#   (게이트 스크립트가 이 훅을 참조하지 않음을 기계로 증명한다).
#
# ⚠⚠ fail-open 이 **의도된 설계**다 — 나중에 "더 단단하게" 고치지 말 것:
#   이벤트 JSON 이 깨졌거나 `file_path` 가 없거나 python3 이 없으면 **허용(exit 0)** 한다.
#   이 계층은 설계상 비-load-bearing 이고 판정 권한은 게이트에 있다. 파싱 한 번 실패에 fail-closed 로
#   굴면 세션의 **모든 편집이 막히는 자해 장애**가 되고, 그 대가로 얻는 안전 이득은 0 이다
#   (같은 위반을 게이트가 이미 사후에 잡는다). 그래서 여기서는 `set -e` 도 쓰지 않는다.
#
# 계약(2026-07 확인): PreToolUse 훅은 이벤트 JSON 을 **stdin** 으로 받는다(`tool_name` ·
#   `tool_input.file_path`), **종료코드 2 + stderr** 가 모델에게 되먹임되는 차단 신호다.
#   배선 = 레포 루트 `.claude/settings.json` 의 `hooks.PreToolUse`(matcher `Write|Edit`).
set -uo pipefail

# 보호구역 루트 = 이 스크립트의 자기위치 기준(<repo>/core/scripts/hooks → <repo>).
#   CLAUDE_PROJECT_DIR 을 루트로 쓰지 않는 이유: 세션을 core/ 에서 열면 그 값이 <repo>/core 라
#   보호구역 계산이 어긋난다. 자기위치는 클론 위치가 어디든 항상 옳다(상대경로 해석 기준으로만 아래에서 쓴다).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_REPO_ROOT="$(cd "$HOOK_DIR/../../.." && pwd)"

PYSRC='
import json, os, sys

def allow():          # 판정 없음 = 허용(stdout 비움)
    sys.exit(0)

try:
    ev = json.load(sys.stdin)
except Exception:     # 깨진/빈 이벤트 JSON → fail-open(위 헤더 근거)
    allow()
if not isinstance(ev, dict):
    allow()
if ev.get("tool_name") not in ("Write", "Edit"):
    allow()           # matcher 로 이미 걸러지지만 방어적으로 한 번 더(다른 도구는 이 훅의 소관 아님)
ti = ev.get("tool_input")
if not isinstance(ti, dict):
    allow()
fp = ti.get("file_path")
if not isinstance(fp, str) or not fp.strip():
    allow()           # file_path 부재 → fail-open
fp = fp.strip()

root = os.environ.get("HOOK_REPO_ROOT") or ""
if not root:
    allow()

# 상대경로 해석 기준 후보 — 어느 기준으로 읽어도 보호구역에 닿으면 막는다(현업이 core/ 에서
#   `runs/<id>/state.json` 처럼 치는 경우까지 포함). 절대경로면 후보는 그 자신 하나뿐.
bases = []
for b in (root, os.environ.get("CLAUDE_PROJECT_DIR"), ev.get("cwd"), os.getcwd()):
    if isinstance(b, str) and b and b not in bases:
        bases.append(b)
cands = [fp] if os.path.isabs(fp) else [os.path.join(b, fp) for b in bases]

# 정규화 2종을 **함께** 본다(단순 substring 매칭 금지 — 논리적 위치로 판정):
#   · 어휘적(normpath): `..` 를 접되 심볼릭링크는 따라가지 않는다
#       → 보호구역 **안**의 심링크로 밖을 가리켜 빠져나가는 우회를 막는다.
#   · 실경로(realpath): 심볼릭링크를 따라간다
#       → 보호구역 **밖**의 심링크로 안을 가리켜 들어오는 우회를 막는다.
roots = set([os.path.normpath(os.path.abspath(root)), os.path.realpath(root)])
forms = set()
for c in cands:
    forms.add(os.path.normpath(os.path.abspath(c)))
    forms.add(os.path.realpath(c))

def verdict(rel):
    parts = rel.split(os.sep)
    # core/runs/<런>/… 아래만 본다. `core/runs/state.json`(런 폴더 없음)은 런 상태가 아니라 대상 아님.
    if parts[:2] != ["core", "runs"] or len(parts) < 4:
        return None
    if parts[-1] == "state.json":
        return "DENY_STATE"
    if ".logs" in parts[2:-1]:
        return "DENY_LOGS"
    return None

for r in roots:
    for f in forms:
        rel = os.path.relpath(f, r)
        if rel == os.pardir or rel.startswith(os.pardir + os.sep):
            continue      # 보호구역 루트 밖으로 해소됨(`..` 이탈·다른 클론) → 판정 대상 아님
        v = verdict(rel)
        if v:
            sys.stdout.write("%s\t%s\n" % (v, rel))
            sys.exit(0)
allow()
'

# python3 부재·예외 등 어떤 실패도 빈 판정(=허용)으로 떨어진다(fail-open).
DECISION="$(HOOK_REPO_ROOT="$HOOK_REPO_ROOT" python3 -c "$PYSRC" 2>/dev/null)" || DECISION=""

TARGET="${DECISION#*$'\t'}"
case "$DECISION" in
  DENY_STATE*)
    # 사유 문구는 현업 화법(prompts/operator-voice.md)을 따른다 — 내부 용어 없이, 무엇을 대신 하면
    #   되는지까지 알려준다. 이 문장이 모델에게 그대로 되먹임되는 교정 신호다.
    printf '진행 상태 파일은 스크립트만 씁니다 — 직접 고치지 말고 '"'"'bash scripts/approve.sh <런 이름>'"'"' 처럼 승인·보완·선택 명령을 쓰세요. (막힌 파일: %s)\n' "$TARGET" >&2
    exit 2 ;;
  DENY_LOGS*)
    printf '실행 기록 폴더는 스크립트만 씁니다 — 직접 고치지 말고 '"'"'bash scripts/timing.sh <런 이름>'"'"' 으로 확인하세요. (막힌 파일: %s)\n' "$TARGET" >&2
    exit 2 ;;
esac
exit 0
