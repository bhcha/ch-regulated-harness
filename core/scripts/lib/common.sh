#!/usr/bin/env bash
# common.sh — 모든 scripts/*.sh 공용 (경로·락·검증·친절 반려).
# state.json 의 유일한 쓰기 주체는 scripts/*.sh 이며, 이 파일의 헬퍼를 거친다.
set -euo pipefail

# 레포 루트 (이 파일 = scripts/lib/common.sh). 환경변수로 재정의 가능(봇/워크트리가 데이터 경로를 고정).
HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HARNESS_ROOT
# 모노레포: core(HARNESS_ROOT) 의 형제 packs/. 규제도메인 팩 SSoT(domain.json/ruleset.json/sources). 재정의 가능.
PACKS_DIR="${PACKS_DIR:-$(cd "$HARNESS_ROOT/.." 2>/dev/null && pwd)/packs}"
export PACKS_DIR
# 단계4: format 다이얼은 전용 비-도메인 팩 packs/_format/ 소유(domain↔format 완전 분리 — 직교 보존). format-profiles.json + <format>/canon.json(정본 1개) co-located. 재정의 가능.
FORMATS_DIR="${FORMATS_DIR:-$PACKS_DIR/_format}"
export FORMATS_DIR
PY="python3"
LIB="$HARNESS_ROOT/scripts/lib/harness.py"
INGEST_LIB="$HARNESS_ROOT/scripts/lib/ingest.py"
# 생성·심의 관측성 헬퍼(개선계획 2부): obs_logdir·obs_timing·obs_logfile·obs_tail·obs_watch_pid.
#   함수만 정의(호출 시 run_dir/$PY/info/kill_proc_tree 를 동적 스코프로 사용) → 소스 순서 무관.
source "$HARNESS_ROOT/scripts/lib/obs.sh"

# ── .env 자동 로드(운영 영속 설정): 시크릿·엔드포인트(NANOBANANA_API_KEY·ADK_CRITIC_URL·ADK_CRITIC_ALLOWED_HOST 등)를
#   매번 export 하지 않아도 .env 에서 읽는다. 우선순위 = 호출자 환경 > .env(set-if-unset). 이미 설정된 변수는 보존 →
#   CI/테스트가 명시한 HARNESS_OFFLINE·KCIA_CRITIC_*·HARNESS_IMAGE_CLI 를 .env 가 덮어쓰지 않는다(결정성·테스트 격리 불변).
#   ⚠ 동작 플래그(엔진 선택·REQUIRED)는 .env 에 넣지 않는다 — 미설정 테스트를 오염시킨다. 시크릿/엔드포인트만.
#   ⚠ 테스트 hermetic: HARNESS_NO_DOTENV=1 이면 .env 를 읽지 않는다(tests/lib.sh 가 설정 — CI 결정성·키 격리). 운영은 미설정이라 .env 로드.
_ENV_FILE="$HARNESS_ROOT/../.env"; [ -f "$_ENV_FILE" ] || _ENV_FILE="$HARNESS_ROOT/.env"
if [ "${HARNESS_NO_DOTENV:-0}" != "1" ] && [ -f "$_ENV_FILE" ]; then
  while IFS= read -r _eln || [ -n "$_eln" ]; do
    case "$_eln" in ''|'#'*) continue;; esac
    _eln="${_eln#export }"; _ek="${_eln%%=*}"; _ev="${_eln#*=}"
    case "$_ek" in *[!A-Za-z0-9_]*|'') continue;; esac      # 유효 변수명만
    _ev="${_ev%\"}"; _ev="${_ev#\"}"; _ev="${_ev%\'}"; _ev="${_ev#\'}"   # 양끝 따옴표 제거
    [ -z "${!_ek+x}" ] && export "$_ek=$_ev"                # '진짜 미설정'만 채움(호출자가 빈값으로 명시 설정한 건 보존 → 테스트 격리)
  done < "$_ENV_FILE"
  unset _eln _ek _ev
fi

# ── 출력 헬퍼 (친절한 한국어) ──
err()  { printf '✋ %s\n' "$*" >&2; }
info() { printf '· %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }

die() { err "$@"; exit 1; }

# ── run 경로 ──
run_dir()   { printf '%s/runs/%s' "$HARNESS_ROOT" "$1"; }
state_file(){ printf '%s/runs/%s/state.json' "$HARNESS_ROOT" "$1"; }

require_run() {
  local rid="$1"
  [ -n "$rid" ] || die "run_id 가 필요합니다. 예: bash scripts/$(basename "$0") my-product-2026"
  [ -d "$(run_dir "$rid")" ] || die "실행 '$rid' 이(가) 없습니다. 먼저 'bash scripts/new-run.sh $rid' 또는 ingest 를 실행하세요."
}

# ── N10: 00-ingest 미완(중단) 표식 존중 — 하류 소비자 공용 fail-closed 가드 ──
#   ingest-bundle.sh(producer)가 어떤 run-input 을 건드리기 '전에' 원자적으로 쓰고, 터미널 상태-기록
#   (status=passed + artifacts)이 성공한 '뒤에만' 지우는 이진 표식이다(부분상태 없음). 남아있으면
#   = ingest 가 어느 창(빈-창·복사 중·매니페스트 쓰기 전)에서 중단됨 → 어느 phase 에서든 하류 진행을 막고
#   재-ingest(멱등 exact-replacement 가 치유)를 강제한다. 표식 쓰기는 producer 몫이며 여기선 '소비'만 한다:
#   부재 = no-op(정상 완료 런엔 부재 → 골든/baseline 불변; 미시작 런에도 무해). 경로는 런 디렉터리 기준 고정.
INGEST_SENTINEL_REL="00-ingest/.ingest-incomplete"       # 런 디렉터리 기준 고정 경로(pin) — producer/consumer 단일 문자열
assert_ingest_complete() {
  local rid="$1"
  [ -f "$(run_dir "$rid")/$INGEST_SENTINEL_REL" ] || return 0
  die "00-ingest 가 완료되지 않았습니다 — bash scripts/ingest-bundle.sh <번들> $rid 로 인입을 다시 실행하세요."
}

# ── 동시성 락 (flock 부재 환경 대응: mkdir 원자성) ──
LOCK_HELD=""
acquire_lock() {
  local rid="$1"
  local lock; lock="$(run_dir "$rid")/.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    local owner=""
    [ -f "$lock/pid" ] && owner="$(cat "$lock/pid" 2>/dev/null || true)"
    # 보유 PID 가 살아있으면 친절 종료, 죽었으면(비정상 종료 잔류) lock 회수.
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      die "다른 작업이 진행 중입니다 (lock 보유 PID=$owner). 잠시 후 다시 시도하세요."
    fi
    info "이전 작업의 비정상 종료로 남은 lock(PID=${owner:-?})을 회수합니다."
    rm -rf "$lock" 2>/dev/null || true
    mkdir "$lock" 2>/dev/null || die "lock 회수 실패. 'rm -rf $lock' 후 재시도하세요."
  fi
  echo "$$" > "$lock/pid"
  LOCK_HELD="$lock"
  trap 'release_lock' EXIT INT TERM
}
release_lock() {
  [ -n "$LOCK_HELD" ] && rm -rf "$LOCK_HELD" 2>/dev/null || true
  LOCK_HELD=""
}

# ── 락 진입/해제 공용 래퍼(K-2 #5: 획득+자식신호 / 해제+신호정리 댄스 일원화) ──
#   HARNESS_LOCK_HELD = 자식 bash 스크립트에 '조상이 락 보유'를 알리는 재진입 신호(env; 내부 LOCK_HELD 와 별개).
# 무조건 획득(진입/리프 스크립트): 락 잡고 자식신호 세팅.
lock_acquire() { acquire_lock "$1"; export HARNESS_LOCK_HELD=1; }
# 해제(무조건 보유 스크립트): 자식신호 정리 후 락 해제.
lock_release() { unset HARNESS_LOCK_HELD; release_lock; }
# 재진입 인지 획득(조상이 보유하면 재획득 생략) — 소유 시 호출부 LOCK_OWN=1 세팅(동적 스코프; bash3.2 이식성상 nameref 미사용).
#   ⚠ return 0 필수: 인라인 `if` 는 조건 거짓 시 rc0 이지만, 함수로 감싸면 마지막 명령(테스트) rc1 이 set -e 를
#     호출부에서 트립(재진입=조건거짓 경로가 상시라 미지정 시 즉시 종료). 획득/생략 둘 다 성공으로 반환.
lock_acquire_own() {  # <rid>
  LOCK_OWN=0
  if [ -z "${HARNESS_LOCK_HELD:-}" ]; then acquire_lock "$1"; LOCK_OWN=1; export HARNESS_LOCK_HELD=1; fi
  return 0
}
# 재진입 인지 해제(내가 획득했을 때만 — 조상의 락을 해제하지 않음). return 0: 위와 동형(미소유 경로 rc1 → set -e 트립 방지).
lock_release_own() { [ "${LOCK_OWN:-0}" = "1" ] && { unset HARNESS_LOCK_HELD; release_lock; }; return 0; }

# ── 검증/구조비교 위임 ──
validate_artifact() { "$PY" "$LIB" validate "$@"; }
jget() { "$PY" "$LIB" jget "$@"; }
jset() { "$PY" "$LIB" jset "$@"; }   # 원자적 쓰기 (state.json 단일 쓰기 주체)
now()  { "$PY" "$LIB" now; }

# sha256 헥사 다이제스트(셸 인라인 통합). 인자 <path> 있으면 그 파일, 없으면 stdin 을 해시한다.
#   kcia-check 의 baseline 파일 해시·작업영역 매니페스트 스트림 해시가 공유(중복 python 원라이너 1곳화).
sha256_hex() {
  if [ "$#" -ge 1 ]; then
    "$PY" -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"
  else
    "$PY" -c "import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
  fi
}

# state.json 스캐폴딩 공용화(new-run·intake 공유). 안전 기본값: 근거 없는 효능 = unknown/[].
#   인자: <sf> <rid> <name> <ptype> <ts> <domain> <fmt> <phase> <max_iterations> <event> <by>
#   phase·max_iterations 는 호출부가 라우트 테이블(route helpers)에서 읽어 넘긴다(new-run=entry·intake=00a-intake).
#   도메인 기능범주(functional_categories)는 팩 레지스트리(packs/*/domain.json)에서 시드(미정의/실패 → []).
scaffold_state() {
  "$PY" - "$@" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import atomic_write_json
sf, rid, name, ptype, ts, domain, fmt, phase, max_it, event, by = sys.argv[1:12]
max_it = int(max_it)
try:
    from kcia_engine import load_domain_registry
    cats = (load_domain_registry().get("domains", {}).get(domain) or {}).get("functional_categories")
    if cats is None:
        cats = []
except Exception:
    cats = []
state = {
    "$schema": "harness/state.schema.json",
    "workflow_id": rid,
    "product": {
        "name": name,
        "type": ptype,
        "regulatory_domain": domain,
        "deliverable_format": fmt,
        "functional_status": {c: "unknown" for c in cats},
        "evidence_on_file": [],
    },
    "phase": phase,
    "step": "generate",
    "gate": None,
    "status": "pending",
    "iteration": 1,
    "max_iterations": max_it,
    "awaiting": "none",
    "selected_option": None,
    "artifacts": [],
    "history": [{"ts": ts, "phase": phase, "event": event, "by": by}],
    "updated_at": ts,
}
atomic_write_json(sf, state)
PYEOF
}

# state.json 병합-전이 공용 프리미티브(K-2 #1: gate.sh 에서 승격, new-run/intake·gate·advance-phase·run-stage 공유).
#   scaffold_state 는 '초기 생성(전체 덮어쓰기)', transition 은 '이후 갱신(기존 키 병합)' — 역할 분리.
#   호출부는 반드시 $SF(state 파일 경로)를 스코프에 두어야 한다(gate/advance-phase/run-stage 모두 설정).
#   인자 = key=val ...  (원자적 일괄 병합; 값은 JSON 파싱 시도, 실패 시 원문 문자열)
#     · key=__UNSET__            → 그 키를 제거(st.pop) — storyboard_substage 커서 정리 등 pop 표현.
#     · @history=<phase>|<event>|<by> → 같은 원자 쓰기에서 history 1건 append(단일-write 원자성 보존).
#       ⚠ append_history 와 달리 env(HARNESS_ACTOR/HARNESS_VERDICT_ID)를 읽지 않는다 — 자동(비-사람) 전이의
#         '순수' history(actor/verdict_id 미부착) 를 그대로 재현하기 위함(gate.sh 는 종전대로 append_history 사용).
transition() {  # key=val ... (원자적 일괄 적용)
  "$PY" - "$SF" "$@" <<'PYEOF'
import sys, os, json
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
sf = sys.argv[1]; st = load_json(sf); hist = None
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1)
    if k == "@history":                     # 단일-write 인라인 history(순수 — env 미참조)
        p = v.split("|"); hist = (p[0], "|".join(p[1:-1]), p[-1]); continue
    if v == "__UNSET__":                     # 키 제거(pop) — null 세팅과 달리 키 자체를 없앰
        st.pop(k, None); continue
    try: v = json.loads(v)
    except Exception: pass
    st[k] = v
if hist is not None:
    st.setdefault("history", []).append({"ts": now_iso(), "phase": hist[0], "event": hist[1], "by": hist[2]})
st["updated_at"] = now_iso()
atomic_write_json(sf, st)
PYEOF
}

# 규제도메인 해석 단일화(DRY). 인자=state 파일 경로.
#   state.product.regulatory_domain 을 읽고, 미선언이면 빈 값 방출(2부 1단계: cosmetic 폴백 폐지 → fail-closed).
resolve_domain() {
  local _rd; _rd="$(jget "$1" product.regulatory_domain 2>/dev/null || true)"
  # 사람이 선언한 product.regulatory_domain 을 읽는다. 비어있거나 JSON null 이면 cosmetic 으로 조용히
  #   폴백하지 않고 '빈 값'을 방출한다(2부 1단계: 미선언 = fail-closed, 호출부가 미등록/미선언으로 처리).
  { [ -n "$_rd" ] && [ "$_rd" != "null" ]; } && printf '%s' "$_rd" || printf ''
}

# ── 규제도메인 레지스트리 조회(마이크로커널) — packs/<도메인>/domain.json 이 유일 SSoT(2부 1단계: 레거시 regulatory-domains.json 폴백 폐지) ──
# 기존 도메인의 규제 '데이터'(룰셋/가이드/엔트리)는 전적으로 packs 소유 → core 코드 무수정으로 교체·갱신.
# ⚠️ 단, '새 도메인 타입' 자체를 추가하려면(예: medical_device) 레지스트리 조립(여기·load_domain_registry)은 자동 인식하나,
#    진입 게이트는 통제 동결이라 함께 추가해야 한다: new-run.sh normalize_domain + state.schema.json regulatory_domain enum
#    (phase enum 과 동일한 'core-base 동결 + 검증된 확장' 철학 — 단계4 enum 완화 작업과 함께. 코덱스 단계3 Medium).
# kcia_engine.load_domain_registry 와 동일 의미.
# ★ 단일 출처: bash 로 검증을 재구현하지 않고 Python load_domain_registry(검증된 레지스트리)를 질의한다(코덱스 단계3 R4·R5).
#   손상 팩(status enum 밖·domain≠디렉터리·비-dict·미파싱)은 Python 에서 incomplete·status=""·ruleset_path=None 로 정규화돼 반환 →
#   autopass 게이트/critic 컨텍스트가 stale/malformed 값으로 우회되지 않는다(빈 status → 상위 active 기본 → 엔진 fail-closed).
#   heredoc(임시파일 필요 — read-only tmp 환경서 실패) 대신 -c 사용(이식성, 코덱스 R5 Medium).
_reg_query() {  # $1=domain $2=field → 검증 레지스트리 값(없으면 빈문자열)
  "$PY" -c 'import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
try:
    from kcia_engine import load_domain_registry
    e = (load_domain_registry().get("domains", {}) or {}).get(sys.argv[1]) or {}
    v = e.get(sys.argv[2], "")
    sys.stdout.write("" if v is None else str(v))
except Exception:
    pass' "$1" "$2" 2>/dev/null || true
}
domain_field() { _reg_query "$1" "$2"; }                  # 라벨/status 등(검증된 값)
domain_ruleset_abs() { _reg_query "$1" ruleset_path; }    # 룰셋 절대경로(손상/미등록 → 빈값, critic 에 손상 룰셋 비노출)
# 별칭 역탐색(입력 별칭/id → 등록 표준 도메인 id). new-run normalize_domain 단일 출처 —
#   한국어 별칭 하드코딩 case 대신 packs/<도메인>/domain.json 의 aliases 필드를 질의(팩이 자기 별칭 소유).
domain_alias_resolve() {  # $1=입력 → 등록된 표준 도메인 id(없으면 빈문자열)
  "$PY" -c 'import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
try:
    from kcia_engine import load_domain_registry
    raw = sys.argv[1]
    doms = (load_domain_registry().get("domains", {}) or {})
    if raw in doms:                       # 이미 표준 id(손상 팩 포함 — 기존 동작 보존)
        sys.stdout.write(raw); sys.exit(0)
    for did, e in doms.items():
        if raw in (e.get("aliases") or []):
            sys.stdout.write(did); sys.exit(0)
except Exception:
    pass' "$1" 2>/dev/null || true
}
# 포맷 별칭 역탐색(입력 별칭/id → 표준 산출물 포맷 id). packs/_format/format-profiles.json 의 aliases 질의.
format_alias_resolve() {  # $1=입력 → 표준 포맷 id(없으면 빈문자열)
  "$PY" -c 'import sys, os, json
raw = sys.argv[1]
fp = os.path.join(os.environ["FORMATS_DIR"], "format-profiles.json")
try:
    formats = (json.load(open(fp)).get("formats", {}) or {})
    if raw in formats:
        sys.stdout.write(raw); sys.exit(0)
    for fid, e in formats.items():
        if raw in (e.get("aliases") or []):
            sys.stdout.write(fid); sys.exit(0)
except Exception:
    pass' "$1" 2>/dev/null || true
}

# ── WS-ROUTES: 선언적 라우트 테이블 조회 (harness/pipeline-routes.json 단일 출처) ──
#   순수 상수성 분기(다음 페이즈 + max_iterations)만 데이터에서 읽는다. 미정의 페이즈 = hard-fail
#   (silent 폴백 금지 — 라우트가 미니 프레임워크로 표류하지 않게 하는 가드레일).
ROUTES_FILE="$HARNESS_ROOT/harness/pipeline-routes.json"
route_end()  { jget "$ROUTES_FILE" end; }
route_next() {
  local p="$1" n
  n="$(jget "$ROUTES_FILE" "phases.$p.next" 2>/dev/null || true)"
  [ -n "$n" ] && [ "$n" != "null" ] || die "라우트 미정의 페이즈: '$p' (harness/pipeline-routes.json)"
  printf '%s' "$n"
}
route_max_iter() {
  local p="$1" m
  m="$(jget "$ROUTES_FILE" "phases.$p.max_iterations" 2>/dev/null || true)"
  [ -n "$m" ] && [ "$m" != "null" ] || die "라우트 max_iterations 미정의: '$p' (harness/pipeline-routes.json)"
  printf '%s' "$m"
}
# 라우트 테이블 무결성 게이트 — state 를 쓰기 전에 호출한다(advance-phase·new-run).
#   ① 닫힌 스키마(pipeline-routes.schema.json: 페이즈 집합이 동결 phase enum 과 일치) 검증으로
#      비동결 라우트가 '동결 외 페이즈'를 도입하지 못하게 막고(typo/registry 표류 차단),
#   ② entry→next 체인이 사이클 없이 end 로 종료하는지 확인한다. 둘 중 하나라도 깨지면 hard-fail.
route_assert_valid() {
  "$PY" - "$ROUTES_FILE" "$HARNESS_ROOT/harness/pipeline-routes.schema.json" \
        "$PHASE_DESC_FILE" "$HARNESS_ROOT/harness/phase-descriptors.schema.json" <<'PYEOF' || die "라우트/디스크립터 테이블 무효 (harness/pipeline-routes.json·phase-descriptors.json) — 위 오류 참조"
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, Validator
data = load_json(sys.argv[1]); sch = load_json(sys.argv[2])
v = Validator(sch, sch); v.validate(data, sch)
if v.errors:
    sys.stderr.write("✋ 라우트 스키마 위반: " + "; ".join(v.errors) + "\n"); sys.exit(1)
# WS-DESC: 페이즈 동작 디스크립터도 같은 전이 게이트에서 닫힌 스키마로 검증한다(게이트 흐름 좌우 데이터 → fail-closed).
dd = load_json(sys.argv[3]); dsch = load_json(sys.argv[4])
dv = Validator(dsch, dsch); dv.validate(dd, dsch)
if dv.errors:
    sys.stderr.write("✋ 페이즈 디스크립터 스키마 위반: " + "; ".join(dv.errors) + "\n"); sys.exit(1)
# 체인 무결성: entry 본선뿐 아니라 '모든' 페이즈(off-mainline 00g-guideline 포함 — --to 로 진입 가능)에서
# 출발해 사이클 없이 end 로 종료해야 한다. 본선만 보면 00g 의 self-cycle 같은 깨진 행을 놓친다.
end, phases = data["end"], data["phases"]
for start in phases:
    cur, seen = start, set()
    while cur != end:
        if cur in seen:
            sys.stderr.write("✋ 라우트 사이클 감지(%s 에서 출발): %s\n" % (start, cur)); sys.exit(1)
        seen.add(cur)
        row = phases.get(cur)
        nxt = row.get("next") if isinstance(row, dict) else None
        if nxt is None:
            sys.stderr.write("✋ 라우트 체인 단절(%s 의 next 미정의)\n" % cur); sys.exit(1)
        cur = nxt
PYEOF
}

# 실 LLM 비대화 실행 디스패처 (1급 경로). 오프라인/stub 에서는 호출되지 않는다.
#   비대화(headless)에서 모델이 산출물 파일을 직접 쓰려면 권한 플래그가 필요하다:
#     claude -p : --permission-mode acceptEdits (파일 쓰기 자동 수락)
#     codex exec: --skip-git-repo-check --sandbox workspace-write (git 미사용·작업영역 쓰기·비대화). codex 0.141+ 는 -a/--ask-for-approval 제거됨(있으면 'unexpected argument -a' 오류).
#   환경변수로 재정의 가능: HARNESS_CLAUDE_FLAGS / HARNESS_CODEX_FLAGS.
HARNESS_CLAUDE_FLAGS="${HARNESS_CLAUDE_FLAGS:---permission-mode acceptEdits}"
HARNESS_CODEX_FLAGS="${HARNESS_CODEX_FLAGS:---skip-git-repo-check --sandbox workspace-write}"
# ── 생성 watchdog 설정 (행/좀비 방지) ──
#   문제: claude -p / codex exec 가 산출물을 다 쓰고도 종료하지 않으면(좀비/행) 포그라운드 대기가 무한 →
#         마무리 전이가 멈춰 "오래 걸린다"고 체감(실측: 생성 18:52 시작, 19:12 산출물 완성 후에도 미종료).
#   해법(3중): ⓐ 하드 상한(GEN_TIMEOUT) ⓑ 출력 완료감지(watch 파일 존재+유효 → 더 안 기다림) ⓒ 미종료 자식 트리 종료.
#   이식성: timeout/gtimeout 비의존(맥 기본 부재) — 순수 bash 백그라운드+주기 점검. 루프 제어는 state.json 외부(여기), state 미작성.
HARNESS_GEN_TIMEOUT="${HARNESS_GEN_TIMEOUT:-600}"     # 생성 1회 하드 상한(초). 산출물 없는 진짜 행의 백스톱.
HARNESS_GEN_POLL="${HARNESS_GEN_POLL:-5}"             # 상태 점검 간격(초): 출력 완료 / 자식 종료 / 상한 초과를 주기 확인.
HARNESS_GEN_HEARTBEAT="${HARNESS_GEN_HEARTBEAT:-30}"  # 진행 하트비트 출력 간격(초). 0=끄기(체감 정체 완화·정기 상태표시).

# 프로세스 그룹/트리 종료(포터블): 생성 자식은 spawn_session.py(os.setsid)로 띄워 그룹 리더(pgid==pid)다 →
#   `kill -- -pid` 로 **그룹 전체**(claude/codex 가 띄운 node 등 손자·재부모화 포함)를 회수한다.
#   추가로 pgrep -P 재귀를 폴백으로 둔다(setsid 실패·비-그룹 자식 대비). 둘 다 best-effort(2>/dev/null·||true).
kill_proc_tree() {
  local pid="$1" sig="${2:-TERM}" c
  kill -"$sig" -- "-$pid" 2>/dev/null || true   # ① 프로세스 그룹 전체(setsid 리더 기준)
  for c in $(pgrep -P "$pid" 2>/dev/null || true); do kill_proc_tree "$c" "$sig"; done   # ② PPID 트리 폴백
  kill -"$sig" "$pid" 2>/dev/null || true       # ③ 리더 자신
}

# ── watchdog 회수·하트비트 공용(K-2 #4: run_llm[common.sh]·obs_watch_pid[obs.sh] 공유) ──
#   _reap_running: 자식이 아직 살아있을 때 강제 회수(TERM→유예→KILL→wait). 상한초과·'산출물완료-미종료' 처방.
_reap_running() { kill_proc_tree "$1" TERM; sleep 1; kill_proc_tree "$1" KILL; wait "$1" 2>/dev/null || true; }
#   _reap_exited: 자식이 이미 종료·wait 된 뒤 잔여 트리(reparent/detach) best-effort 청소(유예/wait 없음).
_reap_exited()  { kill_proc_tree "$1" TERM; kill_proc_tree "$1" KILL; }
# watchdog 하트비트 판정 — 조건(hb>0 && waited>0 && waited-last_hb>=hb) 충족 시 info 출력 + rc0.
#   by-ref 회피(bash3.2 이식성): 호출부가 rc0 이면 last_hb 를 waited 로 갱신한다. 메시지는 문맥이 상이해 호출부가 조립.
watchdog_heartbeat() {  # <waited> <last_hb> <hb> <message>
  local _w="$1" _lh="$2" _hb="$3" _msg="$4"
  { [ "$_hb" -gt 0 ] && [ "$_w" -gt 0 ] && [ $((_w - _lh)) -ge "$_hb" ]; } || return 1
  info "$_msg"; return 0
}

# 생성 산출물 완료 판정: 인자로 받은 watch 파일이 모두 존재 + (JSON 이면) 스키마 유효해야 완료.
#   watch 미지정(인자 0개) → 완료감지 불가 → false(타임아웃/자식 자연종료에만 의존).
gen_outputs_ready() {
  [ "$#" -gt 0 ] || return 1
  local f
  for f in "$@"; do
    [ -f "$f" ] || return 1
    case "$f" in *.json) "$PY" "$LIB" validate "$f" >/dev/null 2>&1 || return 1 ;; esac
  done
  return 0
}

# 실 LLM 비대화 실행 디스패처 (1급 경로). 오프라인/stub 에서는 호출되지 않는다.
#   사용법: run_llm <cli> <prompt> [watch_file...]
#     watch_file = 이 호출이 만들 1차 산출물 경로(들). 지정 시 '출력 완료감지'로 좀비 자식을 기다리지 않고 진행.
#     (fan-out 단계는 호출마다 그 호출이 만드는 항목 파일을 넘긴다 — 루프 중간 완료 오판 방지.)
run_llm() {
  local cli="$1" prompt="$2"; shift 2
  local -a watch=("$@")
  # spawn_session.py 로 새 세션/프로세스 그룹에서 exec → 종료 시 그룹 전체 회수 가능(손자/재부모화 누수 방지).
  local launcher="$HARNESS_ROOT/scripts/lib/spawn_session.py"
  local -a cmd
  case "$cli" in
    claude) cmd=("$PY" "$launcher" claude -p $HARNESS_CLAUDE_FLAGS "$prompt") ;;
    codex)  cmd=("$PY" "$launcher" codex exec $HARNESS_CODEX_FLAGS "$prompt") ;;
    *) die "run_llm: 알 수 없는 CLI '$cli'";;
  esac
  # 개선1(출력 캡처): 생성 stdout/stderr 를 버리지 않고 per-attempt 로그로 보존(왜 실패했는지 추적).
  #   RID/STAGE 는 호출부(run-stage) 스코프에서 동적으로 본다. 미설정(테스트 등 직접 호출) → /dev/null(기존 동작).
  local _genlog="/dev/null"
  [ -n "${RID:-}" ] && _genlog="$(obs_logfile "$RID" "${STAGE:-gen}-${cli}-generate")"
  # 백그라운드 생성 후 주기 상태 점검(set -e 안전: 종료/완료/상한을 if·||true 로 감싸 비0 가 스크립트를 끊지 않게).
  "${cmd[@]}" >>"$_genlog" 2>&1 &
  local pid=$! waited=0 last_hb=0 rc=0
  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      # 자식 자연 종료 → 종료코드 수거. 산출물이 완성됐으면 비0 종료라도 성공으로 본다(완료 우선).
      wait "$pid" 2>/dev/null && rc=0 || rc=$?
      local _done=1; { [ "${#watch[@]}" -gt 0 ] && gen_outputs_ready "${watch[@]}"; } || _done=0
      # H6(Codex 재검토): 리더가 죽어도 워커/손자가 그룹에 남아 lock 해제 후 파일을 계속 쓸 수 있다 → 그룹 best-effort 회수.
      _reap_exited "$pid"
      [ "$_done" = 1 ] && return 0
      return "$rc"
    fi
    if [ "${#watch[@]}" -gt 0 ] && gen_outputs_ready "${watch[@]}"; then
      # 산출물 완료인데 자식 미종료(좀비/행) → 트리 종료 후 진행(★ hang 의 핵심 처방).
      _reap_running "$pid"
      info "[생성] 산출물 완료 감지 — 미종료 생성 프로세스 정리 후 진행(${waited}s 경과)."
      return 0
    fi
    if [ "$waited" -ge "$HARNESS_GEN_TIMEOUT" ]; then
      _reap_running "$pid"
      local _tail; _tail="$(obs_tail "$_genlog" 8 | tr '\n' ' ')"
      die "[생성] 상한(${HARNESS_GEN_TIMEOUT}s) 초과 — 생성 프로세스를 종료했습니다(산출물 미완성). 재실행하면 idempotent 재개됩니다. 상한 조정: HARNESS_GEN_TIMEOUT.${_tail:+ 마지막 출력: $_tail (전체: ${_genlog#"$HARNESS_ROOT"/})}"
    fi
    if watchdog_heartbeat "$waited" "$last_hb" "$HARNESS_GEN_HEARTBEAT" \
         "[생성] 진행 중… ${waited}s 경과 (상한 ${HARNESS_GEN_TIMEOUT}s · 점검 ${HARNESS_GEN_POLL}s 간격)"; then
      last_hb="$waited"
    fi
    sleep "$HARNESS_GEN_POLL"; waited=$((waited + HARNESS_GEN_POLL))
  done
}

# in-session 생성 엔진 감지 (HARNESS_GEN_MODE=insession 전용).
#   '누가 생성했나'를 스크립트가 박는 단일 출처다. 이 토큰이 kcia-check 자가심의 가드의 생명줄이다:
#   토큰이 패밀리(claude/codex)여야 substring 가드가 '동일 패밀리 크리틱'과 충돌해 self-grading 을 막는다.
#   stub/빈값으로 새면 가드가 무력화되므로(Snorkel 패러독스 재유입), 신뢰 CLI 주입 마커로만 판정하고 미상이면 빈 문자열 반환 → 호출부 fail-closed.
#   신뢰 근거: Claude Code 는 모든 Bash 서브프로세스에 CLAUDECODE/CLAUDE_CODE_* 를 주입한다(실측 2026-06-21).
#   ⚠️ CODEX_COMPANION_* 는 'Claude Code 안의 codex 플러그인'이 설정하는 값 → Codex 인터랙티브로 오탐 금지(제외).
#   Codex 인터랙티브 마커는 부록-A 실증 후 추가(WS-4). 그전까지 in-session 은 Claude 전용.
detect_insession_engine() {
  # 활성 Codex 세션 마커가 보이면(중첩/모호) Claude-only 정책상 fail-closed (Codex 리뷰 CRITICAL #2).
  #   codex exec 는 CODEX_THREAD_ID 등을 세팅한다 → CLAUDECODE 가 동시에 보여도 'claude' 로 오분류하면
  #   Codex self-review 우회가 된다(생성=codex 인데 토큰=claude → codex critic 이 substring 가드 통과).
  #   단 CODEX_COMPANION_* 는 'Claude Code 안의 codex 플러그인'이 설정하는 값 → 그건 Claude 세션이므로 제외.
  #   deny-by-default: CODEX_ 중 '설치/설정용'(COMPANION 플러그인·HOME·패키지 매니저)만 양성으로 제외하고,
  #   그 외(THREAD_ID·SANDBOX·SESSION 등 활성 세션 마커)면 차단. safe 방향 유지하되 알려진 양성 env 오탐만 제거(Codex 2차 MINOR).
  local _codex_active
  _codex_active="$(env | grep -E '^CODEX_' | grep -vE '^CODEX_(COMPANION|HOME|MANAGED_BY_NPM|BIN|CONFIG|NPM|VERSION)' | head -1 || true)"
  [ -z "$_codex_active" ] || { echo ""; return 1; }
  if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]; then echo "claude"; return 0; fi
  echo ""; return 1
}

# 이미지 생성 엔진(텍스트 엔진 HARNESS_CLI 와 직교): nanobanana | stub. 기본 stub.
#   삼중가드: 엔진=nanobanana AND NANOBANANA_API_KEY 존재 AND 오프라인 아님 → 실엔진, 그 외 결정적 stub.
HARNESS_NANOBANANA_FLAGS="${HARNESS_NANOBANANA_FLAGS:-}"
resolve_image_engine() {
  # 운영 기본 = 실엔진 nanobanana(.env 키). stub 은 **오직 오프라인(CI/골든)** 일 때만 허용한다(개편계획 ③ stub=CI 전용).
  #   이미지는 도메인 무관하게 '구현됨' 이므로 미구현 예외가 없다 — 온라인이면 항상 실엔진, 키 없으면 fail-closed(무음 stub 강등 금지).
  local explicit="${HARNESS_IMAGE_CLI:-}"          # 사용자가 '명시'했는지 구분(미명시면 빈값)
  local cli="${explicit:-nanobanana}"               # 기본 nanobanana
  case "$cli" in nanobanana|stub) ;; *) die "HARNESS_IMAGE_CLI 는 nanobanana|stub 중 하나여야 합니다 (현재: $cli)";; esac
  if [ "${HARNESS_OFFLINE:-0}" = "1" ]; then echo "stub"; return; fi   # 오프라인 = 결정적 stub(CI/골든 불변, 절대규칙) — stub 허용은 여기뿐
  # 이하 온라인(운영): stub 는 금지, 실엔진(nanobanana) 강제.
  if [ "$cli" = "stub" ]; then
    die "stub 이미지는 CI(HARNESS_OFFLINE=1) 전용입니다."   # 명시 HARNESS_IMAGE_CLI=stub + 온라인 → fail-closed
  fi
  if [ -n "${NANOBANANA_API_KEY:-}" ]; then echo "nanobanana"; return; fi
  # 온라인 + 키 없음 → fail-closed(graceful stub 제거; 운영은 .env 에 NANOBANANA_API_KEY 필수).
  die "이미지 엔진=nanobanana 인데 NANOBANANA_API_KEY 가 없습니다(.env 확인) — 온라인 stub 강등 금지(fail-closed). CI 는 HARNESS_OFFLINE=1 을 쓰세요."
}

# 실증 근거 검색 엔진(텍스트 HARNESS_CLI·이미지 HARNESS_IMAGE_CLI 와 직교): openalex | stub. 기본 openalex.
#   이중가드: 오프라인 → 결정적 stub, 온라인 → 실엔진(openalex) 강제. resolve_image_engine 의 미러이되 API 키 게이트가 없다(OpenAlex 무료).
resolve_evidence_engine() {
  # 운영 기본 = 실엔진 openalex(무료 API — 키 없이 동작). stub 은 **오직 오프라인(CI/골든)** 일 때만 허용한다(개편계획 ③ stub=CI 전용).
  #   OpenAlex 는 도메인 무관하게 '구현됨' 이므로 미구현 예외가 없다 — 온라인이면 항상 실엔진. NanoBanana 와 달리 키가 필요 없으므로 '키 없음 fail-closed' 분기는 없다(무료).
  #   온라인 실검색은 네트워크가 필요하지만(네트워크 실패는 호출부가 fail-closed 처리), 이 함수는 엔진 선택만 한다.
  local explicit="${HARNESS_EVIDENCE_CLI:-}"        # 사용자가 '명시'했는지 구분(미명시면 빈값)
  local cli="${explicit:-openalex}"                  # 기본 openalex
  case "$cli" in openalex|stub) ;; *) die "HARNESS_EVIDENCE_CLI 는 openalex|stub 중 하나여야 합니다 (현재: $cli)";; esac
  if [ "${HARNESS_OFFLINE:-0}" = "1" ]; then echo "stub"; return; fi   # 오프라인 = 결정적 stub(CI/골든 불변, 절대규칙) — stub 허용은 여기뿐
  # 이하 온라인(운영): stub 는 금지, 실엔진(openalex) 강제.
  if [ "$cli" = "stub" ]; then
    die "stub 근거는 CI(HARNESS_OFFLINE=1) 전용입니다."   # 명시 HARNESS_EVIDENCE_CLI=stub + 온라인 → fail-closed
  fi
  echo "openalex"   # 온라인 = 실엔진(키 불필요; OpenAlex 무료). 네트워크 실패는 호출부(B-4)가 fail-closed 처리.
}

# ── 페이즈↔스테이지 이름 맵 SSoT(H-3, K-2 #7) — harness/stage-phase-map.json(base 맵) 단일 출처 ──
#   03-storyboard 는 base('storyboard') 라 맵에 없음 → 소비자(여기·kcia-check·next-action)가 outline/plan substage 부착.
STAGE_PHASE_MAP="$HARNESS_ROOT/harness/stage-phase-map.json"
# phase → stage(base). 미등록(03-storyboard 포함) → "". 셸에서 맵을 읽는 단일 리더(kcia-check 공유).
phase_stage() {
  "$PY" -c 'import sys, json
try:
    m = json.load(open(sys.argv[1]))["phase_to_stage"]; sys.stdout.write(m.get(sys.argv[2], ""))
except Exception: pass' "$STAGE_PHASE_MAP" "$1" 2>/dev/null || true
}
# stage → phase(역탐색). storyboard 서브스테이지 별칭 우선, 그 외는 맵 역탐색. 미등록 → "".
stage_phase() {
  case "$1" in storyboard-outline|storyboard-plan) echo "03-storyboard"; return ;; esac
  "$PY" -c 'import sys, json
try:
    m = json.load(open(sys.argv[1]))["phase_to_stage"]; print(next((p for p, st in m.items() if st == sys.argv[2]), ""))
except Exception: print("")' "$STAGE_PHASE_MAP" "$1"
}

# G5: 미해소(spec_status:pending) 참조 문서가 있는가 — evidence-documents 매니페스트 스캔. "1"=있음, "0"=없음.
#   문서만 첨부(반영 스펙 미정)된 일반 참조 문서는 ingest 가 pending 으로 기록 → 00e-evidence 제안·승인 전까지
#   00e 외 전이를 막는 초크 게이트(advance-phase)와 done 백스톱(check_evidence_reflection)이 이 함수를 읽는다.
#   읽기 전용(state 미기록). 매니페스트 없음/pending 없음=0(no-evidence 골든 불변).
evidence_pending() {  # $1=rid → "1"|"0"
  local rid="$1" man
  man="$(run_dir "$rid")/00-ingest/evidence-documents.json"
  [ -f "$man" ] || { echo "0"; return; }
  "$PY" -c 'import sys, json
try:
    m = json.load(open(sys.argv[1]))
    print("1" if any(isinstance(d, dict) and d.get("spec_status") == "pending" for d in (m.get("documents") or [])) else "0")
except Exception:
    print("0")' "$man" 2>/dev/null || echo "0"
}

# G5: 두 조건부 off-mainline 페이즈(00e-evidence·00g-guideline)의 단일 조건부 라우터.
#   순서 00e→00g→01-brief, 각 술어는 run-level:
#     00e-evidence = 미해소 pending 참조 문서 존재(evidence_pending). from=00-ingest 에서만 평가한다
#                    (00e 진입 후 gate.sh apply-proposal 이 pending 을 해소하므로 from=00e-evidence 면 재평가 안 함).
#     00g-guideline = 동일 도메인 사례 스냅샷 존재(run-local inputs/examples/<도메인>) AND 포맷 active_phases 에 00g 포함
#                     — ingest-bundle.sh 진입 술어와 '동일'(examples 없으면 통과, 00g 미적용 포맷은 스킵).
#   반환: 다음 진입 페이즈 1개(개행). ingest-bundle(from=00-ingest, --to)·advance-phase(from=00e-evidence, no-arg override)가 쓴다.
compute_next_conditional() {  # $1=rid  $2=from(00-ingest|00e-evidence) → 다음 페이즈
  local rid="$1" from="$2" rdir dom fmt act
  rdir="$(run_dir "$rid")"
  # 1) pending 참조 문서 → 00e-evidence (00-ingest 에서만; 00e 를 이미 지났으면 스킵)
  if [ "$from" = "00-ingest" ] && [ "$(evidence_pending "$rid")" = "1" ]; then
    fmt="$(jget "$(state_file "$rid")" product.deliverable_format 2>/dev/null || true)"; [ -n "$fmt" ] || fmt="multipage_bm"
    act="$(jget "$FORMATS_DIR/format-profiles.json" "formats.$fmt.active_phases" 2>/dev/null || true)"
    if [ -z "$act" ] || printf '%s' "$act" | grep -q '"00e-evidence"'; then
      printf '00e-evidence\n'; return
    fi
    die "미확정 참조 문서(pending)가 있으나 포맷 '$fmt' 에 00e-evidence 페이즈가 없습니다(설정오류) — active_phases 에 00e-evidence 를 추가하거나 반영 스펙을 직접 지정하세요."
  fi
  # 2) 동일 도메인 사례 → 00g-guideline (ingest-bundle 진입 술어와 바이트 동일)
  dom="$(resolve_domain "$(state_file "$rid")")"
  if [ -d "$rdir/inputs/examples/$dom" ] && [ -n "$(find "$rdir/inputs/examples/$dom" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]; then
    fmt="$(jget "$(state_file "$rid")" product.deliverable_format 2>/dev/null || true)"; [ -n "$fmt" ] || fmt="multipage_bm"
    act="$(jget "$FORMATS_DIR/format-profiles.json" "formats.$fmt.active_phases" 2>/dev/null || true)"
    if [ -z "$act" ] || printf '%s' "$act" | grep -q '"00g-guideline"'; then
      printf '00g-guideline\n'; return
    fi
  fi
  # 3) 기본
  printf '01-brief\n'
}

# LLM 1급 경로용 컨텍스트(입력 파일 경로 + 핵심 근거 요약). state 는 포함하지 않는다.
#   K-3①: 조립 본체(라벨·인라인 python 조각·결손 안내)는 scripts/lib/build_context.py 로 이관됨.
#   이 함수는 얇은 래퍼(호출부 인터페이스 보존) — 출력은 build_context.py 가 stdout 으로 낸다(바이트 동일).
build_context() {
  "$PY" "$HARNESS_ROOT/scripts/lib/build_context.py" "$1" "$2"
}

# 00g 가이드라인 사례 폴더 열거 — 단일 출처(emit-context 와 본 디스패치가 공유 → 두 모드 입력 드리프트 차단).
#   per-run 계약: 사례는 ingest 가 runs/<id>/inputs/examples/<도메인>/ 로 스냅샷한다 → 런-로컬 우선(정렬).
#   런-로컬이 없으면(마이그레이션·미스냅샷) 공유 소스(${HARNESS_EXAMPLES_DIR:-core/inputs/examples})로 폴백.
#   하나도 없으면 단일 번들(runs/<id>/inputs/bundle)로 폴백(기존 단일-번들 흐름 호환).
#   한 줄에 한 폴더씩 출력 → 호출부가 배열로 읽는다. (process substitution 으로 while 이 현재 셸에서 돌아 set -e 안전.)
guideline_example_dirs() {  # $1=rid → 사례 폴더 경로(개행 구분)
  local rid="$1" dom rdir exdir d found=0
  dom="$(resolve_domain "$(state_file "$rid")")"
  rdir="$(run_dir "$rid")"
  # 런-로컬(ingest 스냅샷) 우선 → 없으면 공유 소스 폴백(HARNESS_EXAMPLES_DIR 은 ingest 소스 지정용, 마이그레이션 호환).
  exdir="$rdir/inputs/examples/$dom"
  [ -d "$exdir" ] || exdir="${HARNESS_EXAMPLES_DIR:-$PACKS_DIR/cosmetic/samples/examples}/$dom"
  if [ -d "$exdir" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      printf '%s\n' "$d"; found=1
    done < <(find "$exdir" -mindepth 1 -maxdepth 1 -type d | sort)
  fi
  [ "$found" = "1" ] || printf '%s\n' "$rdir/inputs/bundle"
}

# M5(G2): 다안 재생성('전부거절→재제안') 시 거절된 옛 라운드(active 산출물)를 history/iter-N 으로 스냅샷 보존 후
#   active 슬롯을 비운다(실엔진이 옵션키를 바꿔도 orphan/오염 방지 + select VALID·build_context 오염 차단).
#   rm-only(감사추적 소실) 대신 부록A 감사추적 보존 — storyboard-plan(history/iter-N cp) 패턴의 일반화.
#   active SSoT 위치(options/·recommendation.json·decision.json)는 불변 → state 외부 포인터 신설 없음, stale decision 재심의 혼입 없음(R8).
archive_multi_round() {  # $1=phase_dir  $2=iter  $rest...=active 산출물(상대명)
  local pdir="$1" it="$2"; shift 2
  local rnd="$pdir/history/iter-$it" any=0 item
  for item in "$@"; do [ -e "$pdir/$item" ] && any=1; done
  [ "$any" = "1" ] || return 0
  # 멱등: 이 iter 라운드가 이미 보존됐으면 '덮어쓰지 않는다' — 최초 거절 스냅샷 보존(재생성 중간 실패 후 재시도가
  #   기존 감사본을 partial active 로 교체하지 못하게; Codex 단계5 Medium). 동일 iter 재진입 = 이미 보존됨.
  if [ -d "$rnd" ]; then info "  - 라운드 이미 보존됨(중복 아카이브 생략): ${rnd#"$HARNESS_ROOT"/}"; return 0; fi
  mkdir -p "$rnd"
  local cp_ok=1
  for item in "$@"; do
    [ -e "$pdir/$item" ] || continue
    cp -R "$pdir/$item" "$rnd/" 2>/dev/null || cp_ok=0   # 스냅샷(감사추적)
  done
  if [ "$cp_ok" = "0" ]; then
    # 스냅샷 일부 실패 → active 를 '비우지 않는다'(데이터 손실 방지). 감사 실패가 생성을 막지 않음(재생성이 active 덮어씀).
    err "  - 라운드 스냅샷 일부 실패 → active 보존(데이터 손실 방지). 감사본 불완전: ${rnd#"$HARNESS_ROOT"/}"
    return 0
  fi
  for item in "$@"; do rm -rf "$pdir/$item" 2>/dev/null || true; done   # 스냅샷 성공 후에만 active 비움(orphan/오염 방지)
  info "  - 거절된 라운드 보존: ${rnd#"$HARNESS_ROOT"/}"
}

# 03-storyboard 서브스테이지: outline(스토리라인) → plan(기획안).
#   M4(C2): state.storyboard_substage 명시 커서가 단일 진실(gate.sh review-pass 만 전진).
#   harness.py:storyboard_substage 와 동일 규칙(셸·파이썬 공유). 필드 부재(레거시)면 verdict 기반 재구성.
storyboard_substage() {
  local rid="$1" cur
  cur="$(jget "$(state_file "$rid")" storyboard_substage 2>/dev/null || true)"
  if [ "$cur" = "outline" ] || [ "$cur" = "plan" ]; then echo "$cur"; return; fi
  # 재구성: outline-verdict 가 pass 면 plan, 아니면 outline('_verdict pass 아닌 첫 substage_').
  local ov; ov="$(run_dir "$rid")/03-storyboard/outline-verdict.json"
  if [ -f "$ov" ] && [ "$(jget "$ov" verdict 2>/dev/null || true)" = "pass" ]; then echo "plan"; else echo "outline"; fi
}

# M4(C2·코덱스 HIGH): 03-storyboard 에서 substage 커서 필드가 부재(레거시/직접 seed)면 lock 안에서 1회 재구성·기록.
#   verdict_path 를 읽는 kcia-check/gate/validate 가 'verdict 작성 후 재파생'으로 outline→plan flip 하지 않게(R3) —
#   review 진행 중엔 필드만 신뢰. NEW run 은 advance-phase 가 03 진입 시 이미 기록하므로 이 함수는 no-op.
ensure_storyboard_substage() {
  local rid="$1" sf; sf="$(state_file "$rid")"
  [ "$(jget "$sf" phase 2>/dev/null || true)" = "03-storyboard" ] || return 0
  local cur; cur="$(jget "$sf" storyboard_substage 2>/dev/null || true)"
  { [ "$cur" = "outline" ] || [ "$cur" = "plan" ]; } && return 0
  local sub; sub="$(storyboard_substage "$rid")"   # 재구성값(verdict 작성 전 시점이라 안정)
  jset "$sf" storyboard_substage "\"$sub\""
}

# ── WS-DESC: 페이즈 동작 디스크립터(harness/phase-descriptors.json 단일 출처) ──
#   verdict_path·phase_is_multi·sel_decision_rel·phase_needs_approve_after_select 의 phase 하드코딩 case 를
#   데이터로 외부화한다(셸 코드 0줄로 새 단계가 게이트 흐름에 참여 — ADR 8-5의 1번). 03-storyboard 는
#   substage(outline/plan)별 미니워크플로우라 substages 분기. 무결성은 route_assert_valid 가 전이 전 검증(닫힌 스키마).
PHASE_DESC_FILE="$HARNESS_ROOT/harness/phase-descriptors.json"
# 현재 phase(+03 substage)의 디스크립터 jget 베이스 경로. phase 가 비거나 미정의면 'phases.' 류로 → 조회 실패 → 호출부 기본값.
_phase_desc_base() {
  local rid="$1" phase; phase="$(jget "$(state_file "$rid")" phase 2>/dev/null || true)"
  if [ "$phase" = "03-storyboard" ]; then
    printf 'phases.%s.substages.%s' "$phase" "$(storyboard_substage "$rid")"
  else
    printf 'phases.%s' "$phase"
  fi
}
# 디스크립터 leaf 필드 1개 조회(없거나 null 이면 빈 문자열). phase 명에 '.' 이 없어 jget 점-경로와 충돌 없음.
_phase_desc_field() {
  local v; v="$(jget "$PHASE_DESC_FILE" "$(_phase_desc_base "$1").$2" 2>/dev/null || true)"
  { [ -n "$v" ] && [ "$v" != "null" ]; } && printf '%s' "$v" || printf ''
}

# 현재 페이즈/서브스테이지의 verdict.json 경로 (디스크립터 verdict_file, 없으면 "" — 기존 *) 동치)
verdict_path() {
  local rel; rel="$(_phase_desc_field "$1" verdict_file)"
  [ -n "$rel" ] && echo "$(run_dir "$1")/$rel" || echo ""
}

# 현재 페이즈가 다안(select 게이트)인가 (디스크립터 is_multi=true→1, 그 외→0 — 기존 *) 동치)
phase_is_multi() {
  [ "$(_phase_desc_field "$1" is_multi)" = "true" ] && echo 1 || echo 0
}

# 현재 페이즈/서브스테이지의 decision.json 상대경로 (디스크립터 decision_rel, 없으면 "decision.json" — 기존 *) 동치)
sel_decision_rel() {
  local rel; rel="$(_phase_desc_field "$1" decision_rel)"
  [ -n "$rel" ] && echo "$rel" || echo "decision.json"
}

# 선택 후 별도 approve(2중 승인)가 필요한 페이즈 (디스크립터 needs_approve_after_select=true→1)
phase_needs_approve_after_select() {
  [ "$(_phase_desc_field "$1" needs_approve_after_select)" = "true" ] && echo 1 || echo 0
}

# 현재 페이즈가 실제 심의(룰엔진+critic) 대상인가 (디스크립터 review=false → 0=면제, 그 외/없음 → 1=심의). 기본 심의.
#   면제 페이즈(예 00g-guideline)는 kcia-check 가 verdict=pass(engine=review-exempt-autopass)로 자동 통과시킨다.
#   금지표현은 생성 시 validate-stage 룰엔진이 이미 차단하고, 실제 광고 카피는 컨셉·스토리보드·키비주얼에서 심의되므로 중복 심의 제거.
phase_has_review() {
  [ "$(_phase_desc_field "$1" review)" = "false" ] && echo 0 || echo 1
}

# state.json history 에 이벤트 누적 (원자적)
append_history() {
  local sf="$1" phase="$2" event="$3" by="$4"
  "$PY" - "$sf" "$phase" "$event" "$by" "${HARNESS_ACTOR:-}" "${HARNESS_VERDICT_ID:-}" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
sf, phase, event, by, actor, verdict_id = sys.argv[1:7]
st = load_json(sf)
entry = {"ts": now_iso(), "phase": phase, "event": event, "by": by}
if actor:                       # 사람 행위자(--by → HARNESS_ACTOR). by(쓴 스크립트)와 별개; 자동 이벤트엔 없음.
    entry["actor"] = actor
if verdict_id and event.startswith("review:"):   # WS-TRACE: verdict_id 는 'review:*'(verdict 가 일으킨) 전이에만 기록.
    entry["verdict_id"] = verdict_id              #   비-review 이벤트나 상속된 env 누출에 오귀속되지 않게 event 로 한정.
st.setdefault("history", []).append(entry)
st["updated_at"] = now_iso()
atomic_write_json(sf, st)
PYEOF
}

# AG-UI 이벤트 투영(방출) — best-effort. state.json 파생 뷰를 runs/<id>/.events/agui.jsonl 에만 append(멱등 재구성).
#   ⚠ state.json 은 절대 쓰지 않는다(방출 모듈 agui_events.py 가 읽기만). 실패해도 본 파이프라인을 막지 않는다(|| true).
#   .events 는 골든 제외(baseline.py SKIP_PREFIX '.events'). 전이/생성 직후(transition·obs_timing 곁)에서 한 줄로 호출.
agui_emit() {
  "$PY" "$HARNESS_ROOT/scripts/lib/agui_events.py" sync "$1" >/dev/null 2>&1 || true
}

# 이미지 매니페스트 분류(읽기전용, state 미수정). 인자 = run_dir(rdir). 출력(stdout):
#   "complete"   = 04-keyvisual/image-manifest.json 존재 + JSON dict + engine 비어있지 않음 + engine!=stub + incomplete 아님.
#   "incomplete" = 위 실엔진 조건 충족 + incomplete:true(P-1 증분 매니페스트 = 부분성공).
#   ""(빈값)     = 부재 · 파싱실패 · 비-dict · engine 없음/stub. → 아래 두 반전 술어가 이 단일 판정을 공유(중복 python 블록 1곳화).
_image_manifest_class() {
  local mf="$1/04-keyvisual/image-manifest.json"
  [ -f "$mf" ] || { printf ''; return 0; }
  "$PY" -c 'import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
if not isinstance(d, dict):
    print(""); sys.exit(0)
eng = d.get("engine") or ""
if not eng or eng == "stub":
    print(""); sys.exit(0)
print("incomplete" if d.get("incomplete") is True else "complete")' "$mf"
}

# 이미지 매니페스트가 '실엔진·완결'인지 (읽기전용). 성공(0) = class=="complete".
#   run-stage 키비주얼 완료판정(preflight 면제·멱등 재진입)이 이 단일 술어를 쓴다(기존 engine!=stub 로직 보존 + incomplete 강화).
image_manifest_complete() { [ "$(_image_manifest_class "$1")" = "complete" ]; }

# P-1/Codex W1c: '실엔진 부분(incomplete) 매니페스트'인가 — 성공(0) = class=="incomplete".
#   run-stage 가 이걸로 이미지 생성 미완결을 fail-closed 판정(부분 성공이 validate·advance 로 새지 않게). stub/오프라인은 항상 실패(1) → 골든 불변.
image_manifest_incomplete() { [ "$(_image_manifest_class "$1")" = "incomplete" ]; }
