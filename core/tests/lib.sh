#!/usr/bin/env bash
# tests/lib.sh — 테스트 공용 (assert + 파이프라인 드라이버).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 모노레포: 팩(packs/) + format 다이얼 팩(packs/_format/). common.sh 와 동일 해석(단계4 format 팩 이전).
PACKS_DIR="${PACKS_DIR:-$(cd "$ROOT/.." && pwd)/packs}"
FORMATS_DIR="${FORMATS_DIR:-$PACKS_DIR/_format}"
PASS=0; FAIL=0
# 테스트 hermetic: 운영 .env(키·ADK 엔드포인트)를 읽지 않는다 — CI 결정성 + 키/엔진 격리(common.sh 가드).
export HARNESS_NO_DOTENV=1
# 개편계획 ③(stub=CI 전용): stub 게이트는 이제 HARNESS_OFFLINE=1 단 하나다(옛 'HARNESS_CLI 기본=stub' 폐기).
#   hermetic 테스트는 기본적으로 오프라인(결정적 stub)으로 돈다 → 온라인이 필요한 단정만 호출부에서 국소적으로 override(unset/0).
export HARNESS_OFFLINE="${HARNESS_OFFLINE:-1}"
BUNDLE="${TEST_BUNDLE:-$ROOT/tests/fixtures/bundle-cosmetic}"
# ⓪ 유형 선언: 테스트 기준 프로젝트 = 화장품 · 여러장 BM자료(상세페이지). ingest 자동생성이 이 env 를 읽는다.
export HARNESS_DOMAIN="${HARNESS_DOMAIN:-cosmetic}"
export HARNESS_FORMAT="${HARNESS_FORMAT:-multipage_bm}"
# WB 기본 입력 = 테스트 픽스처(이지듀 샘플). 운영 inputs/working-backwards.md(중립 템플릿)와 분리 —
#   테스트는 fixture 를 기준으로, 운영 기본값은 빈 템플릿이라 예시가 새 프로젝트로 새지 않는다. 개별 호출은 override 가능.
export HARNESS_WB="${HARNESS_WB:-$PACKS_DIR/cosmetic/golden/working-backwards.md}"
# 골든/파이프라인 드라이버(drive_pipeline·drive_to_done·drive_format_pipeline)는 '사례 없는' 직행(ingest→brief)
#   정본 경로를 하드코딩한다(00g-guideline 미처리). 로컬 사례corpus(inputs/examples/<도메인>)가 존재하면 ingest 가
#   00g 로 라우팅해 드라이버가 거기서 멈춘다(done 미도달 → 골든 캡처 불가). 아래 빈 examples 베이스를 드라이버에
#   hermetic 고정해 로컬 사례 유무와 무관하게 직행을 재현한다. 00g-guideline 을 '의도적으로' 테스트하는 곳
#   (test-b1g·test-b8·test-routes·stage-brief)은 이 드라이버를 쓰지 않고 자체 HARNESS_EXAMPLES_DIR 로 사례를 세팅한다.
HERMETIC_EXAMPLES="$ROOT/tests/golden/_no-examples"; mkdir -p "$HERMETIC_EXAMPLES"; export HERMETIC_EXAMPLES
# 직행-ingest 스위트(test-b0/b1/b3/b4/b5·test-components·stage-brief)는 드라이버를 안 쓰고 ingest-bundle.sh 를
#   직접 부르므로 로컬 사례corpus(inputs/examples/<도메인>) 존재 시 00g 로 라우팅돼 깨진다(run-ci 는 :12 에서 unset).
#   lib.sh 를 source 하는 모든 테스트에 hermetic 기본값을 걸어 로컬 corpus 와 격리한다(호출부 명시 override 는 보존).
export HARNESS_EXAMPLES_DIR="${HARNESS_EXAMPLES_DIR:-$HERMETIC_EXAMPLES}"

pass() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
check() { if eval "$2"; then pass "$1"; else fail "$1 :: ($2)"; fi; }

jq_phase() { python3 "$ROOT/scripts/lib/harness.py" jget "$ROOT/runs/$1/state.json" "$2"; }

# 단계 격리: 동결된 경계 핸드오프 픽스처(fixtures/<boundary>-in)를 run 으로 로드 → 앞 단계 없이 그 단계만 검증.
seed_fixture() {  # seed_fixture <boundary> <rid>
  rm -rf "$ROOT/runs/$2"; cp -R "$PACKS_DIR/cosmetic/fixtures/$1-in" "$ROOT/runs/$2"
}

# 라우팅/포맷 단위 테스트 전용: 현재 phase 를 '정당한 review-pass 상태'(gate=review + 해당 phase verdict=pass)로
#   구성한 뒤 no-arg advance-phase 를 호출한다(M4 부록A-9: 자동 전이는 review-pass state 에서만 허용).
#   우회가 아니라 실제 review-pass 상태를 합법적으로 만들어 정당한 전이가 허용됨을 검증하는 것이다.
#   ※ 실제 산출물 없이 phase 전이만 검증하는 라우팅/포맷 단위 테스트에서만 쓴다(산출물 게이트 테스트에 쓰지 말 것).
route_pass_advance() {  # route_pass_advance <rid>
  local rid="$1"; local sf="$ROOT/runs/$rid/state.json"
  python3 "$ROOT/scripts/lib/harness.py" jset "$sf" gate '"review"' >/dev/null
  local phase; phase="$(jq_phase "$rid" phase)"
  local vrel
  case "$phase" in
    00e-evidence)  vrel="00e-evidence/evidence-verdict.json" ;;
    00g-guideline) vrel="00g-guideline/guideline-verdict.json" ;;
    01-brief)      vrel="01-brief/brief-verdict.json" ;;
    02-concept)    vrel="02-concept/review/concept-verdict.json" ;;
    03-storyboard) # 03→04 라우트 전이는 **plan** review-pass 에서만(outline→plan 은 intra-phase) → plan substage 로 모사.
                   vrel="03-storyboard/plan-verdict.json"
                   python3 "$ROOT/scripts/lib/harness.py" jset "$sf" storyboard_substage '"plan"' >/dev/null ;;
    04-keyvisual)  vrel="04-keyvisual/design-verdict.json" ;;
    *)             vrel="" ;;
  esac
  # 00-ingest 는 심의(review) 게이트가 없는 페이즈(verdict 경로 없음) → 실제 런처럼 명시 라우팅(--to next)으로
  #   다음 페이즈로 넘긴다(ingest-bundle.sh 와 동일 경로). 그 외(심의 게이트 보유 페이즈)는 review-pass state 를 구성.
  if [ -z "$vrel" ]; then
    local nxt; nxt="$(cd "$ROOT" && HARNESS_ROOT="$ROOT" bash -c 'source scripts/lib/common.sh; route_next "'"$phase"'"' 2>/dev/null)"
    ( cd "$ROOT" && bash scripts/advance-phase.sh "$rid" --to "$nxt" )
    return $?
  fi
  python3 - "$ROOT" "$ROOT/runs/$rid/$vrel" <<'PY'
import os, sys
root, vp = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from harness import atomic_write_json
os.makedirs(os.path.dirname(vp), exist_ok=True)
atomic_write_json(vp, {"verdict": "pass", "engine": "route-test", "confidence": 1.0, "violations": [], "escalate": False})
PY
  # 04-keyvisual review-pass 는 실제로 gate.sh 가 export_package 를 만든 뒤 advance 한다 → 동일 상태 충실 모사(export 스텁).
  #   (advance-phase 의 '04→done 은 export 패키지 존재 시에만' 가드와 정합 — 코덱스 2R Critical.)
  if [ "$phase" = "04-keyvisual" ]; then
    mkdir -p "$ROOT/runs/$rid/04-keyvisual/export/kcia-package"
    [ -f "$ROOT/runs/$rid/04-keyvisual/export/kcia-package/package.json" ] \
      || echo '{"_route_test_stub":true}' > "$ROOT/runs/$rid/04-keyvisual/export/kcia-package/package.json"
  fi
  # gate.sh review-pass 가 advance 직전 남기는 전이 마커를 충실 모사(advance-phase 의 마커 가드와 정합 — 코덱스 4R High).
  python3 - "$ROOT" "$sf" <<'PY'
import os, sys
root, sf = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
d = load_json(sf)
d.setdefault("history", []).append({"ts": now_iso(), "phase": d.get("phase"), "event": "review:passed→advance", "by": "route-test"})
atomic_write_json(sf, d)
PY
  ( cd "$ROOT" && bash scripts/advance-phase.sh "$rid" )
}

# 살아있는 프로세스가 lock 을 점유한 상태를 모사(동시성 친절종료 테스트). 죽은 PID 면 회수되므로 live 여야 함.
hold_lock()    { sleep 120 & HELD_PID=$!; mkdir -p "$1/.lock"; echo "$HELD_PID" > "$1/.lock/pid"; }
release_held() { [ -n "${HELD_PID:-}" ] && kill "$HELD_PID" 2>/dev/null; rm -rf "$1/.lock" 2>/dev/null; HELD_PID=""; }

# 로컬 ADK 목 서버 헬퍼(무네트워크 hermetic; ADK_CRITIC_ALLOW_LOCAL=1) — adk_critic.py 의 /run·세션 엔드포인트 흉내.
#   시작 시 stdout 'PORT <n>' 한 줄로 포트를 알린다. 호출 전 ADK_MOCK_* env 를 export 하면 그대로 상속.
#   K-5: test-critic-fanout ↔ test-observability 의 동일 패턴 2벌을 lib.sh 공용 헬퍼로 승격(포트·기동·종료 보존).
MOCK_PY="$ROOT/tests/adk-mock-server.py"; MOCK_PID=""; MOCK_PORT=""; MOCK_OUT=""
start_mock() {  # start_mock  — 호출 전에 ADK_MOCK_* env 를 export 해 두면 그대로 상속.
  MOCK_OUT="$(mktemp)"
  python3 "$MOCK_PY" >"$MOCK_OUT" 2>&1 & MOCK_PID=$!
  local i
  for i in $(seq 1 100); do
    MOCK_PORT="$(grep -oE 'PORT [0-9]+' "$MOCK_OUT" 2>/dev/null | awk '{print $2}' | head -1)"
    [ -n "$MOCK_PORT" ] && break
    sleep 0.05
  done
}
stop_mock() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  [ -n "$MOCK_OUT" ] && rm -f "$MOCK_OUT" || true
  MOCK_PID=""; MOCK_PORT=""; MOCK_OUT=""
}

# 공용 코어: 오프라인(결정적) 파이프라인 구동(ingest→brief→concept→outline→plan + 키비주얼 꼬리 변주).
#   K-5: drive_pipeline·drive_to_done·drive_format_pipeline 3벌의 중복 시퀀스를 1곳으로 통합(동작·시그니처 보존).
#   env 는 서브셸에 가둔다(부모 오염 없음) — drive_pipeline/drive_to_done 의 부모-스코프 leak+cleanup 은 각 래퍼가 그대로 유지한다.
#   $1=rid $2=eng $3=dom("" 면 상속) $4=fmt("" 면 상속) $5=csel $6=osel $7=kvsel $8=kvmode(none|generate|full|auto)
#   kvmode: none=키비주얼 미실행 · generate=생성까지만 · full=생성→select→승인→심의 · auto=포맷 04-keyvisual active 일 때만 full.
_drive_core() {
  local rid="$1" eng="$2" dom="$3" fmt="$4" csel="$5" osel="$6" kvsel="$7" kvmode="$8"
  local has04=1
  [ "$kvmode" = "auto" ] && has04="$(python3 -c "import json,sys;f=json.load(open('$FORMATS_DIR/format-profiles.json'))['formats']['$fmt'];print('1' if '04-keyvisual' in f['active_phases'] else '0')" 2>/dev/null || echo 0)"
  # M4: 생성 → 사람 승인/선택 → 심의 → (통과)advance. (단안=approve, 다안=select, 04=select→approve)
  ( cd "$ROOT" && export HARNESS_CLI="$eng" HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES" &&
    # 빈 dom/fmt = export 스킵 → lib.sh 상단 HARNESS_DOMAIN=cosmetic·HARNESS_FORMAT=multipage_bm 상속(drive_pipeline/drive_to_done 의
    #   '빈=상속' 시맨틱 보존). drive_format_pipeline 은 항상 non-empty dom/fmt 로 호출하므로 그 경로만 export 로 덮는다
    #   — 옛 drive_format_pipeline 의 무조건 export 와 등가(빈-인자 export 경로는 애초에 미도달). 무조건 export 로 바꾸면
    #   drive_pipeline/drive_to_done 이 HARNESS_DOMAIN="" 로 상속을 덮어써 깨지므로 조건부가 옳다.
    { [ -z "$dom" ] || export HARNESS_DOMAIN="$dom"; } && { [ -z "$fmt" ] || export HARNESS_FORMAT="$fmt"; } &&
    bash scripts/ingest-bundle.sh "$BUNDLE" "$rid" &&
    bash scripts/run-stage.sh brief "$rid" && bash scripts/approve.sh "$rid" --ra-ok && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh concept "$rid" && bash scripts/select.sh "$rid" "$csel" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-outline "$rid" && bash scripts/select.sh "$rid" "$osel" && bash scripts/kcia-check.sh "$rid" &&
    bash scripts/run-stage.sh storyboard-plan "$rid" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" &&
    case "$kvmode" in
      none)     true ;;
      generate) bash scripts/run-stage.sh keyvisual "$rid" ;;
      full)     bash scripts/run-stage.sh keyvisual "$rid" && bash scripts/select.sh "$rid" "$kvsel" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid" ;;
      auto)     [ "$has04" = "0" ] || { bash scripts/run-stage.sh keyvisual "$rid" && bash scripts/select.sh "$rid" "$kvsel" && bash scripts/approve.sh "$rid" && bash scripts/kcia-check.sh "$rid"; } ;;
    esac
  ) >/dev/null 2>&1
}

# 오프라인(결정적) 전 파이프라인 완주(키비주얼 '생성'까지만). $1=run_id, $2=engine(claude|codex)
drive_pipeline() {
  local rid="$1" eng="$2"
  rm -rf "$ROOT/runs/$rid"
  export HARNESS_CLI="$eng" HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"
  _drive_core "$rid" "$eng" "" "" B A A generate
  local rc=$?
  unset HARNESS_CLI HARNESS_OFFLINE
  export HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"   # unset 아닌 '헤르메틱 복원': 드라이버 뒤 직접-ingest 스위트가 로컬 corpus 로 새지 않게(:30 기본값과 동일)
  return $rc
}

# 오프라인(결정적) 전 파이프라인을 **done 까지** 완주(키비주얼 select→승인→심의→export 포함). baseline 골든 캡처/검증용.
#   drive_pipeline 은 키비주얼 '생성'까지만 — 최종 제출 패키지(decision/design-verdict/export)를 골든이 덮도록 done 까지 간다(코덱스 HIGH).
drive_to_done() {
  local rid="$1" eng="$2"
  rm -rf "$ROOT/runs/$rid"
  export HARNESS_CLI="$eng" HARNESS_OFFLINE=1 HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"
  _drive_core "$rid" "$eng" "" "" B A A full
  local rc=$?
  unset HARNESS_CLI HARNESS_OFFLINE
  export HARNESS_EXAMPLES_DIR="$HERMETIC_EXAMPLES"   # unset 아닌 '헤르메틱 복원': 드라이버 뒤 직접-ingest 스위트가 로컬 corpus 로 새지 않게(:30 기본값과 동일)
  return $rc
}

# M7(G5): 파라미터화 파이프라인 드라이버 — 임의 (도메인×포맷) 을 done 까지 구동(format active_phases 자동 스킵 존중).
#   drive_to_done(cosmetic·multipage_bm·B/A/A 하드코딩)을 건드리지 않고(골든 보존) 별도 파라미터 드라이버로 제공.
#   04-keyvisual 이 active 인 포맷만 키비주얼 단계 구동; 아니면 plan 심의통과 시 04 스킵→done 자동.
#   env 는 _drive_core 서브셸에 갇힌다(부모 무오염 — 원 동작 보존). $1=rid $2=engine $3=domain $4=format [$5=csel=B] [$6=osel=A] [$7=kvsel=A]
drive_format_pipeline() {
  local rid="$1" eng="$2" dom="$3" fmt="$4" csel="${5:-B}" osel="${6:-A}" kvsel="${7:-A}"
  rm -rf "$ROOT/runs/$rid"
  _drive_core "$rid" "$eng" "$dom" "$fmt" "$csel" "$osel" "$kvsel" auto
}

# 모든 run 산출물 JSON 스키마 검증. $1=run_id
validate_all_artifacts() {
  local rid="$1" bad=0
  while IFS= read -r f; do
    rel="${f#"$ROOT"/}"
    sname="$(python3 -c "import sys;sys.path.insert(0,'$ROOT/scripts/lib');from harness import schema_for_path;print(schema_for_path('$rel') or '')")"
    [ -z "$sname" ] && continue
    if ! python3 "$ROOT/scripts/lib/harness.py" validate "$f" >/dev/null 2>&1; then
      echo "    검증 실패: $rel" >&2; bad=1
    fi
  done < <(find "$ROOT/runs/$rid" -name '*.json' ! -name '.tmp.*')
  return $bad
}
