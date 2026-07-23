#!/usr/bin/env bash
# obs.sh — 생성·심의 관측성 공용 헬퍼 (개선계획 2부 개선0·1). common.sh 가 source 한다(그 스코프에서 run_dir·$PY 사용).
#   목적: 하네스가 생성·심의 서브프로세스와 '파일'로만 소통하며 그들의 진단(stderr)·소요시간을 버리던 문제 처방.
#   - 측정 로그(개선0): runs/<id>/.logs/timing.jsonl (append-only). 언제 시작·종료·얼마 걸렸나 + 결과.
#   - 출력 캡처(개선1): runs/<id>/.logs/<tag>.log 로 stdout/stderr 보존. 실패 시 에러에 tail 첨부.
# 신뢰등급(Codex 리뷰): .logs 는 '진단용(비신뢰)' 로그다. 보통 스크립트가 쓰지만, critic 은 작업영역 쓰기 권한이라 .logs 를
#   변조할 수도 있다 → verdict 경로로는 들어가지 않으므로(merge 는 scratch 만 읽음) 안전 영향은 없으나 '감사 신뢰 로그'는 아니다.
#   best-effort — 관측 실패가 본 파이프라인을 막지 않는다. .logs 는 *.json 이 아니므로(jsonl/log) kcia _manifest(*.json 글롭)·validate_all_artifacts 와 충돌 없음.
#   골든 제외: baseline.py SKIP_PREFIX 에 '.logs' 포함(휘발성 타임스탬프 비결정 — 골든 바이트 불변).

# runs/<id>/.logs 디렉터리 보장 + 경로 출력(실패 시 비0 → 호출부가 폴백).
obs_logdir() {
  local d; d="$(run_dir "$1")/.logs"
  mkdir -p "$d" 2>/dev/null || return 1
  printf '%s' "$d"
}

# 측정 로그 1줄 append. 사용: obs_timing <rid> key=val ...
#   필드(개선0): phase stage step engine gen_source outcome watch_ready rc duration_s (+ ts=완료시각 자동).
#   step: generate|review|review-passA|review-passB|transition. outcome: ok|fail|timeout|degraded.
#   값에 공백/특수문자가 와도 안전하도록 python 으로 직렬화(append 는 state.json 단일쓰기 불변식과 무관 — 진단 파일).
obs_timing() {
  local rid="$1"; shift || true
  local ld; ld="$(obs_logdir "$rid")" || return 0
  "$PY" - "$ld/timing.jsonl" "$@" <<'PYEOF' 2>/dev/null || true
import sys, json
from datetime import datetime, timezone
path = sys.argv[1]
rec = {"ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
for kv in sys.argv[2:]:
    k, sep, v = kv.partition("=")
    if not sep:
        continue
    if k in ("duration_s", "rc"):
        try:
            v = int(v)
        except ValueError:
            try:
                v = float(v)
            except ValueError:
                pass
    elif k == "watch_ready":
        v = v in ("true", "1", "yes")
    rec[k] = v
try:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
except Exception:
    pass
PYEOF
}

# 실행 기록(provenance) 1줄 append — 감사 추적(어느 git_sha·엔진·유효플래그·프롬프트 지문이 이 런 산출물을
#   만들었나). 사용: obs_provenance <rid> <step> [engine]. step: generate|review(생성·심의 시점).
#   runs/<id>/.logs/provenance.jsonl (obs_timing 과 동형 append; '환경 스냅샷' 성격). L-1(maintainability 6장).
#   .logs 는 골든 제외(baseline.py SKIP_PREFIX '.logs')·run.md 비노출·best-effort(관측 실패가 본 파이프라인 미차단).
#   prompts_sha256 = prompts/*.md 정렬 내용 해시(test-prompt-assembly 동결 지문과 동형 로직 재사용).
obs_provenance() {
  local rid="$1" step="${2:-}" engine="${3:-}" gen_source="${4:-}"
  local ld; ld="$(obs_logdir "$rid")" || return 0
  local gitsha; gitsha="$(git -C "$HARNESS_ROOT" rev-parse --short HEAD 2>/dev/null || printf '')"
  # effective 유효값은 '셸 변수'(common.sh:325·332 등이 export 아닌 셸 var 로 기본값 설정 — HARNESS_GEN_TIMEOUT=600·
  #   HARNESS_CLAUDE_FLAGS=--permission-mode acceptEdits · KCIA_CRITIC_TIMEOUT=600[obs.sh:76])에서 읽어 인자로 넘긴다.
  #   python 이 os.environ 만 보면 미-export 기본값이 빈 값으로 기록돼 감사 기록이 오해된다(Codex P3).
  # ⚠ CLI/GEN_MODE/IMAGE_CLI 같은 '사용-시점 해석' 노브는 여기 넣지 않는다 — 자동선택 런에선 env 가 비어 오해를 준다.
  #   해석된 생성 표면은 상위 필드 engine(해석된 엔진 라벨)·gen_source(stub|insession|subprocess)가 정확히 담는다(Codex P3).
  "$PY" - "$ld/provenance.jsonl" "$HARNESS_ROOT" "$step" "$engine" "$gen_source" "$gitsha" \
    "${HARNESS_GEN_TIMEOUT:-}" "${KCIA_CRITIC_TIMEOUT:-}" "${HARNESS_CLAUDE_FLAGS:-}" \
    "${HARNESS_OFFLINE:-}" "${HARNESS_MODEL:-}" <<'PYEOF' 2>/dev/null || true
import sys, os, json, hashlib, glob
from datetime import datetime, timezone
(path, root, step, engine, gen_source, gitsha,
 gen_timeout, critic_timeout, claude_flags, offline, model) = sys.argv[1:12]
psha = ""
try:  # prompts/*.md 정렬·내용 sha256(동결 프롬프트 지문; test-prompt-assembly 와 동형)
    h = hashlib.sha256()
    for p in sorted(glob.glob(os.path.join(root, "prompts", "*.md"))):
        with open(p, "rb") as f:
            h.update(f.read())
    psha = h.hexdigest()
except Exception:
    psha = ""
rec = {
    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "step": step,
    "engine": engine,
    "gen_source": gen_source,
    "model": model,   # 확인 가능 시(대개 미설정 → 빈 값)
    "git_sha": gitsha,
    "prompts_sha256": psha,
    "effective": {
        "GEN_TIMEOUT": gen_timeout,
        "CRITIC_TIMEOUT": critic_timeout,
        "CLAUDE_FLAGS": claude_flags,
        "OFFLINE": offline,
    },
}
try:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
except Exception:
    pass
PYEOF
}

# 캡처 로그 파일 경로 생성: runs/<id>/.logs/<tag>-<ts>.log. tag 예: brief-claude-generate / critic-passA.
#   .logs 불가(쓰기 실패) 시 /dev/null(캡처 포기, 본 흐름 유지).
obs_logfile() {
  local rid="$1" tag="$2" ld
  ld="$(obs_logdir "$rid")" || { printf '/dev/null'; return 0; }
  # 파일명 안전화(영숫자·-_. 외 → _). ts 로 호출 간 충돌 회피.
  local safe; safe="$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/%s-%s.log' "$ld" "$safe" "$(date +%Y%m%d-%H%M%S 2>/dev/null || echo ts)"
}

# 로그 파일 끝 N줄(기본 15) — 실패 에러 메시지에 '왜 실패했는지' 첨부용. 없으면 빈 출력.
obs_tail() {
  local f="$1" n="${2:-15}"
  [ -f "$f" ] && tail -n "$n" "$f" 2>/dev/null || true
}

# ── 크리틱 watchdog (개선계획 2부 개선2) ──
#   크리틱 eval 엔 상한·하트비트·kill 이 없어 `claude -p` 권한 대기 시 무한 행 → 가장 큰 '느림' 원인.
#   run_llm 의 폴링 watchdog 과 동일 형태(상한·하트비트·kill_proc_tree)를 '이미 백그라운드로 띄운 pid' 에 적용한다.
#   호출 규약: 호출부가 `<cmd> >>"$LOG" 2>&1 & pid=$!` 로 띄운 뒤 obs_watch_pid "$pid" "$timeout" "<라벨>".
#     (호출부가 직접 백그라운드 → eval 가 호출부 스코프의 PROMPT 등 변수를 보게 함. 헬퍼는 pid 만 감시 → 스코프 결합 없음.)
#   반환: 정상종료=자식 rc / 상한초과=124(timeout 센티넬). kill_proc_tree 는 common.sh 공용(run_llm 과 공유).
#   ⚠ 크리틱은 spawn_session(setsid) 미경유 → 그룹킬은 best-effort, pgrep -P 트리 회수로 받친다(상한 백스톱이 핵심 안전망).
KCIA_CRITIC_TIMEOUT="${KCIA_CRITIC_TIMEOUT:-600}"   # 크리틱 1회(Pass-A 또는 Pass-B 1건) 하드 상한(초).
obs_watch_pid() {
  local pid="$1" timeout="$2" label="${3:-크리틱}" waited=0 last_hb=0 rc=0
  # H-4: 기본값 단일 출처 = common.sh(HARNESS_GEN_POLL/HEARTBEAT 을 source 시점에 설정). obs.sh 는
  #   common.sh 만 source 하므로(common.sh:20) 이 함수 호출 시 이미 설정됨 → 여기 중복 기본값 제거.
  local poll="$HARNESS_GEN_POLL" hb="$HARNESS_GEN_HEARTBEAT"
  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null && rc=0 || rc=$?
      # (Codex MEDIUM) 자연종료 후에도 잔여 자식(reparent/detach)을 best-effort 회수 — run_llm 자연종료 경로와 동일.
      _reap_exited "$pid"
      return "$rc"
    fi
    if [ "$waited" -ge "$timeout" ]; then
      _reap_running "$pid"
      return 124   # timeout 센티넬(호출부가 outcome=timeout 으로 분류)
    fi
    if watchdog_heartbeat "$waited" "$last_hb" "$hb" "[$label] 진행 중… ${waited}s 경과 (상한 ${timeout}s)"; then
      last_hb="$waited"
    fi
    sleep "$poll"; waited=$((waited + poll))
  done
}
