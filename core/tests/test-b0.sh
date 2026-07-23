#!/usr/bin/env bash
# test-b0.sh — B0 워킹 스켈레톤 + 이식성 게이트 Exit 기준 (결정적, no-LLM).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## B0 — 워킹 스켈레톤 + 이식성 게이트"

# (c) 셸 경로만으로 전 단계 완주 (슬래시 비의존)
drive_pipeline "ci-claude" "claude"; RC1=$?
check "(c) HARNESS_CLI=claude 오프라인 셸 경로 전 단계 완주" "[ $RC1 -eq 0 ]"
drive_pipeline "ci-codex" "codex"; RC2=$?
check "(c) HARNESS_CLI=codex 오프라인 셸 경로 전 단계 완주" "[ $RC2 -eq 0 ]"

# (a1) 이식성 '스키마 동일': 두 CLI 산출물의 키 집합·타입 동일(jq 구조 비교, 값 무시)
struct_ok=1
for rel in 00-ingest/voc.json 00-ingest/claim-basis.json 00-ingest/assets-manifest.json \
           01-brief/brief.json 02-concept/concept-axes.json 02-concept/recommendation.json \
           02-concept/options/B-emotional/key-message.json 02-concept/review/concept-verdict.json \
           03-storyboard/outline/options/A/storyline.json 03-storyboard/plan/01-hero.json; do
  if [ -f "$ROOT/runs/ci-claude/$rel" ] && [ -f "$ROOT/runs/ci-codex/$rel" ]; then
    python3 "$ROOT/scripts/lib/harness.py" structdiff "$ROOT/runs/ci-claude/$rel" "$ROOT/runs/ci-codex/$rel" >/dev/null 2>&1 \
      || { echo "    구조 불일치: $rel" >&2; struct_ok=0; }
  else
    echo "    누락: $rel" >&2; struct_ok=0
  fi
done
check "(a1) 두 CLI 산출물 키 집합·타입 동일(structdiff)" "[ $struct_ok -eq 1 ]"

# 두 CLI 산출물 각각 validate-stage 통과
check "(a1) ci-claude 전 산출물 스키마 유효" "validate_all_artifacts ci-claude"
check "(a1) ci-codex 전 산출물 스키마 유효" "validate_all_artifacts ci-codex"

# (e) claim-basis: 근거 없는 효능 = unknown / 빈 배열
WB="$(python3 -c "import json;d=json.load(open('$ROOT/runs/ci-claude/00-ingest/claim-basis.json'));print(d['functional_status']['whitening']['status'],d['functional_status']['wrinkle']['status'],len(d['evidence_on_file']))")"
check "(e) 근거 없는 미백/주름 = unknown, evidence 빈 배열" "[ \"$WB\" = 'unknown unknown 0' ]"

# (f) reviews.csv BOM + RFC4180 VOC 회귀 (실측 고정값)
KF="$(python3 -c "import json;d=json.load(open('$ROOT/runs/ci-claude/00-ingest/voc.json'))['keyword_frequency'];print(d['커버'],d['기미'],d['촉촉'],d['밀착'],d['화사'],d['미백'],d['주름'],d['여드름'])")"
check "(f) VOC 실측 회귀 6/0/5/4/3/0/0/0(bundle-cosmetic)" "[ \"$KF\" = '6 0 5 4 3 0 0 0' ]"

# enabled_if: evidence 없음 → clinicalEvidence/beforeAfter 블록 자동 제외 (환각 차단)
HASCLIN="$(grep -l clinicalEvidence "$ROOT"/runs/ci-claude/03-storyboard/plan/*.json 2>/dev/null | wc -l | tr -d ' ')"
check "(환각) 실증 미등록 → clinicalEvidence 기획안 블록 0개" "[ \"$HASCLIN\" = '0' ]"

# (h) state.json 쓰기 주체 단일화: LLM/stub/프롬프트는 state 를 쓰지 않는다
check "(h) stub_stage.py 가 state.json 을 쓰지 않음" "! grep -q 'state.json' '$ROOT/scripts/lib/stub_stage.py'"
check "(h) 프롬프트가 state 쓰기를 지시하지 않음(건드리지 마라 명시)" "grep -rq '건드리지 마라' '$ROOT/prompts'"

# (b) 재개 idempotent (2부)
mt() { python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$1"; }   # 이식성(BSD/GNU stat 무관)
rm -rf "$ROOT/runs/ci-resume"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
# 1부: 같은 페이즈 내 재실행 idempotent — brief 생성(→review) 후 같은 단계 재호출 시 mtime 불변
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-resume && bash scripts/run-stage.sh brief ci-resume ) >/dev/null 2>&1
BRIEF_MT1="$(mt "$ROOT/runs/ci-resume/01-brief/brief.json")"; sleep 1
( cd "$ROOT" && bash scripts/run-stage.sh brief ci-resume ) >/dev/null 2>&1   # idempotent skip (review 유지)
BRIEF_MT2="$(mt "$ROOT/runs/ci-resume/01-brief/brief.json")"
check "(b) 같은 페이즈 재호출 idempotent: brief.json mtime 불변" "[ \"$BRIEF_MT1\" = \"$BRIEF_MT2\" ]"
# M4: 생성 직후 brief(단안)는 user 게이트(승인 대기). 심의는 승인 뒤로 이동.
check "(b) 재호출 후 게이트 보존(user/pending)" "[ \"$(jq_phase ci-resume gate)\" = 'user' ]"

# 2부: 절반 진행(claude) 후 종료 → 다른 CLI(codex)로 이후 단계 재개, 이전 산출물 mtime 불변
# M4: brief 단안 = approve → kcia-check(통과) → advance(02-concept).
( cd "$ROOT" && bash scripts/approve.sh ci-resume --ra-ok && bash scripts/kcia-check.sh ci-resume ) >/dev/null 2>&1  # →02-concept
VOC_BEFORE="$(mt "$ROOT/runs/ci-resume/00-ingest/voc.json")"
BRIEF_BEFORE="$(mt "$ROOT/runs/ci-resume/01-brief/brief.json")"; sleep 1
export HARNESS_CLI=codex
# M4: 다안 = select → kcia-check(통과) → advance.
( cd "$ROOT" && bash scripts/run-stage.sh concept ci-resume && bash scripts/select.sh ci-resume B && bash scripts/kcia-check.sh ci-resume &&
  bash scripts/run-stage.sh storyboard-outline ci-resume && bash scripts/select.sh ci-resume A && bash scripts/kcia-check.sh ci-resume ) >/dev/null 2>&1
RC_RES=$?
unset HARNESS_CLI HARNESS_OFFLINE
check "(b) 재개: voc.json mtime 불변(완료 단계 비재생성)" "[ \"$VOC_BEFORE\" = \"$(mt "$ROOT/runs/ci-resume/00-ingest/voc.json")\" ]"
check "(b) 재개: brief.json mtime 불변" "[ \"$BRIEF_BEFORE\" = \"$(mt "$ROOT/runs/ci-resume/01-brief/brief.json")\" ]"
check "(b) 재개: 다른 CLI 로 미완료 단계 이어서 진행 성공(03-storyboard 도달)" "[ $RC_RES -eq 0 ] && [ \"$(jq_phase ci-resume phase)\" = '03-storyboard' ]"

# (g) 동시성 lock: 락 보유 중 두 번째 프로세스 친절 종료, state 손상 0
hold_lock "$ROOT/runs/ci-claude"   # 살아있는 점유자
OUT="$( ( cd "$ROOT" && bash scripts/approve.sh ci-claude ) 2>&1 )"; RC_LOCK=$?
release_held "$ROOT/runs/ci-claude"
check "(g) 동시 실행 시 두 번째 친절 종료(비정상 종료코드)" "[ $RC_LOCK -ne 0 ]"
check "(g) 친절한 한국어 반려 메시지" "echo \"\$OUT\" | grep -q '다른 작업이 진행 중'"
check "(g) state.json 무손상(스키마 유효)" "python3 '$ROOT/scripts/lib/harness.py' validate '$ROOT/runs/ci-claude/state.json' >/dev/null 2>&1"

# (g+) stale lock 회수: 죽은 PID 가 남긴 lock 은 비정상종료로 보고 회수(crash 후 재개 UX)
mkdir -p "$ROOT/runs/ci-claude/.lock"; echo 999999 > "$ROOT/runs/ci-claude/.lock/pid"   # 죽은 PID
( cd "$ROOT" && bash scripts/run-stage.sh brief ci-claude ) >/dev/null 2>&1   # 회수 후 진행(현재 done 이라 idempotent)
check "(g+) 죽은 PID stale lock 회수(수동 삭제 불필요)" "[ ! -d '$ROOT/runs/ci-claude/.lock' ]"

# (loop) loop guard: revise 가 max 초과 → escalated + run.md 배너
rm -rf "$ROOT/runs/ci-loop"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-loop &&
  bash scripts/run-stage.sh brief ci-loop && bash scripts/kcia-check.sh ci-loop ) >/dev/null 2>&1
# brief 가 user 게이트 → revise 를 max+1 까지 반복
SF="$ROOT/runs/ci-loop/state.json"
python3 "$ROOT/scripts/lib/harness.py" jset "$SF" max_iterations 2 >/dev/null
python3 "$ROOT/scripts/lib/harness.py" jset "$SF" iteration 2 >/dev/null
( cd "$ROOT" && bash scripts/revise.sh ci-loop "표현 수정" ) >/dev/null 2>&1   # iter 2>=max2 → escalated
unset HARNESS_CLI HARNESS_OFFLINE
ST_LOOP="$(jq_phase ci-loop status)"
check "(loop) revise max 초과 → status=escalated" "[ \"$ST_LOOP\" = 'escalated' ]"
check "(loop) run.md 에 '사람 개입 필요' 배너" "grep -q '사람 개입 필요' '$ROOT/runs/ci-loop/run.md'"

# [Codex 리뷰 수용] M4 중단-복구: approve(→gate=review)까지 커밋되고 심의 직전 중단된 경우 재개
# M4 에선 approve 가 한 atomic 전이(approved+user 중단 상태 없음) → 중단점은 'approve 후 / kcia-check 전'.
rm -rf "$ROOT/runs/ci-heal"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-heal &&
  bash scripts/run-stage.sh brief ci-heal ) >/dev/null 2>&1
# brief 의 기능성 승인 표시 → 승인에 RA 확인 필요(B1 #5). --ra-ok 로 승인(→ gate=review).
( cd "$ROOT" && bash scripts/approve.sh ci-heal --ra-ok ) >/dev/null 2>&1
# 중단 시뮬레이션: 승인은 gate=review 까지 커밋됐으나 심의(kcia-check) 전에 죽음 → 재개 = kcia-check.
check "(복구·중단점) 승인 후 심의 대기(gate=review)에서 중단" "[ \"$(jq_phase ci-heal gate)\" = 'review' ]"
( cd "$ROOT" && bash scripts/kcia-check.sh ci-heal ) >/dev/null 2>&1   # 통과 시 02-concept 로 advance
check "(복구) 중단된 승인(gate=review)에서 심의 통과 후 페이즈 전이 재개" "[ \"$(jq_phase ci-heal phase)\" = '02-concept' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# [Codex 리뷰 수용] stale verdict: revise 재생성 시 직전 verdict 폐기 → stale pass 재사용 금지
# M4: 심의는 승인 뒤. 위법 표현을 주입해 심의 fail(brief 페이즈 유지) → verdict 존재 → revise 재생성이 폐기하는지 검증.
rm -rf "$ROOT/runs/ci-stale"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-stale &&
  bash scripts/run-stage.sh brief ci-stale ) >/dev/null 2>&1
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-stale/01-brief/brief.json" pr.headline '"여드름 치료 단 1일 만에 개선"' >/dev/null
# 심의 fail → 자동 revise(status=revise, gate=null). verdict 파일은 남는다(직전 라운드 산출).
( cd "$ROOT" && bash scripts/approve.sh ci-stale --ra-ok && bash scripts/kcia-check.sh ci-stale ) >/dev/null 2>&1
check "(stale) 심의 후 brief-verdict.json 존재" "[ -f '$ROOT/runs/ci-stale/01-brief/brief-verdict.json' ]"
# revise 재생성(run-stage)이 직전(stale) verdict 를 폐기 → stale pass 재사용·재심의 우회 차단.
( cd "$ROOT" && bash scripts/run-stage.sh brief ci-stale ) >/dev/null 2>&1
check "(stale) revise 재생성 후 직전 verdict 폐기됨(재심의 강제)" "[ ! -f '$ROOT/runs/ci-stale/01-brief/brief-verdict.json' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# [Codex 리뷰 수용] substage 가드: 아웃라인 확정 후 storyboard-outline 재실행 거부
rm -rf "$ROOT/runs/ci-sub"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-sub &&
  bash scripts/run-stage.sh brief ci-sub && bash scripts/approve.sh ci-sub --ra-ok && bash scripts/kcia-check.sh ci-sub &&
  bash scripts/run-stage.sh concept ci-sub && bash scripts/select.sh ci-sub B && bash scripts/kcia-check.sh ci-sub &&
  bash scripts/run-stage.sh storyboard-outline ci-sub && bash scripts/select.sh ci-sub A && bash scripts/kcia-check.sh ci-sub ) >/dev/null 2>&1
OUT_SUB="$( ( cd "$ROOT" && bash scripts/run-stage.sh storyboard-outline ci-sub ) 2>&1 )"; RC_SUB=$?
check "(substage) 스토리라인 확정 후 storyboard-outline 재실행 거부(비정상 종료)" "[ $RC_SUB -ne 0 ]"
# M3 2-cycle: 스토리라인(outline) 확정 직후엔 plan 이 허용되는 다음 단계(tone 서브스테이지 없음)
OUT_SUB2="$( ( cd "$ROOT" && bash scripts/run-stage.sh storyboard-plan ci-sub ) 2>&1 )"; RC_SUB2=$?
check "(substage) 스토리라인 확정 후 storyboard-plan 허용(정상 진행)" "[ $RC_SUB2 -eq 0 ]"
unset HARNESS_CLI HARNESS_OFFLINE

# [Codex 리뷰 수용] raise-limit 가 유효 enum 만 쓴다(스키마 무손상)
rm -rf "$ROOT/runs/ci-raise"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-raise && bash scripts/run-stage.sh brief ci-raise ) >/dev/null 2>&1
python3 "$ROOT/scripts/lib/harness.py" jset "$ROOT/runs/ci-raise/state.json" status '"escalated"' >/dev/null
( cd "$ROOT" && bash scripts/run-stage.sh raise-limit ci-raise ) >/dev/null 2>&1
check "(raise-limit) state.json 스키마 무손상" "python3 '$ROOT/scripts/lib/harness.py' validate '$ROOT/runs/ci-raise/state.json' >/dev/null 2>&1"
check "(raise-limit) max_iterations 상향됨" "[ \"\$(jq_phase ci-raise max_iterations)\" -gt 3 ]"
unset HARNESS_CLI HARNESS_OFFLINE

# 개편(critic=adk-http 단일): 로컬 헤드리스 크리틱(KCIA_CRITIC_CMD·claude-subagent/codex)·self-grading 가드는 폐기.
#   이식성 스모크 = 폐기된 critic 엔진 선언은 거부(화이트리스트: 비움/adk-http 만). 상세 ADK 분기는 test-critic-fanout.
rm -rf "$ROOT/runs/ci-sg"
export HARNESS_CLI=claude HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-sg && bash scripts/run-stage.sh brief ci-sg && bash scripts/approve.sh ci-sg --ra-ok ) >/dev/null 2>&1
OUT_SG="$( ( cd "$ROOT" && env -u HARNESS_OFFLINE KCIA_CRITIC_ENGINE=claude-subagent bash scripts/kcia-check.sh ci-sg ) 2>&1 )"; RC_SG=$?
check "(critic-engine) 폐기된 로컬 크리틱 엔진 선언 거부(비정상 종료)" "[ $RC_SG -ne 0 ]"
check "(critic-engine) 화이트리스트 메시지(KCIA_CRITIC_ENGINE)" "echo \"\$OUT_SG\" | grep -q 'KCIA_CRITIC_ENGINE'"
unset HARNESS_CLI HARNESS_OFFLINE

# (d) 드리프트 가드(비변조 내용 비교 — 워킹트리를 건드리지 않는다):
#   sync-skills.sh 의 매핑(skills/<name>/SKILL.md → .claude/commands/<name>.md)을 임시 폴더에 그대로 재현해
#   커밋된 .claude/commands/ 와 대조한다. git status 대신 '내용' 비교라 커밋 여부와 무관하고(미커밋이라도
#   내용만 맞으면 통과 — 인-싱크 미커밋 오탐 없음), CI 가 실제 커맨드 폴더를 mutate 하지 않는다.
#   아래 배포 스모크(sync-skills.sh 실행)가 커맨드 폴더를 덮기 전에 두어 '실제 커밋 상태'를 본다.
#   명령(mktemp/cp/cmp/ls) 실패는 공허 통과 없이 실패로 잡는다(fail-closed). 개수 일치는 파일명 집합 동등성이 함의한다.
CMDS_DIR="$ROOT/.claude/commands"
EXP_DIR="$(mktemp -d)"
if [ ! -d "$EXP_DIR" ]; then
  fail "(d) 드리프트 가드: mktemp 실패(임시 폴더 생성 불가)"
else
  drift_ok=1; drift_msg=""
  # skills/<name>/SKILL.md → <name>.md 로 임시 폴더에 재현(sync-skills.sh 복사 루프 등가; 실제 폴더 미변조).
  for d in "$ROOT"/skills/*/; do
    [ -d "$d" ] || { drift_ok=0; drift_msg="$drift_msg
    skills/ 가 비어있음(스킬 원본 소실?)"; break; }
    name="$(basename "$d")"; src="${d%/}/SKILL.md"
    [ -f "$src" ] || continue
    cp "$src" "$EXP_DIR/$name.md" || { drift_ok=0; drift_msg="$drift_msg
    복사 실패: skills/$name/SKILL.md"; }
  done
  exp_names="$( ( cd "$EXP_DIR" && ls -1 *.md 2>/dev/null ) | sort )"
  act_names="$( ( cd "$CMDS_DIR" && ls -1 *.md 2>/dev/null ) | sort )"
  [ -n "$exp_names" ] || { drift_ok=0; drift_msg="$drift_msg
    기대 커맨드 목록이 비어있음(skills/ 소실 또는 임시 폴더 채우기 실패)"; }
  # 파일명 집합 동등성(양방향: 결손 + 고아).
  only_exp="$(comm -23 <(printf '%s\n' "$exp_names") <(printf '%s\n' "$act_names") | sed '/^$/d')"
  only_act="$(comm -13 <(printf '%s\n' "$exp_names") <(printf '%s\n' "$act_names") | sed '/^$/d')"
  [ -z "$only_exp" ] || { drift_ok=0; drift_msg="$drift_msg
    결손(커밋 필요, .claude/commands 에 없음): $(printf '%s' "$only_exp" | tr '\n' ' ')"; }
  [ -z "$only_act" ] || { drift_ok=0; drift_msg="$drift_msg
    고아(삭제 필요, skills/ 원본 없음): $(printf '%s' "$only_act" | tr '\n' ' ')"; }
  # 이름이 겹치는 파일은 내용 동등성(cmp -s: 0=동일·1=다름·≥2=오류 — 다름/오류 모두 드리프트로 실패).
  common="$(comm -12 <(printf '%s\n' "$exp_names") <(printf '%s\n' "$act_names") | sed '/^$/d')"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    cmp -s "$EXP_DIR/$f" "$CMDS_DIR/$f" || { drift_ok=0; drift_msg="$drift_msg
    내용 불일치: $f"; }
  done <<< "$common"
  rm -rf "$EXP_DIR"
  if [ "$drift_ok" = 1 ]; then
    pass "(d) skills↔commands 동기화(내용 일치 · 커밋 여부 무관 · 워킹트리 무변조)"
  else
    fail "(d) skills/ 와 .claude/commands/ 불일치 — bash scripts/sync-skills.sh 실행 결과를 같은 변경에 커밋하라:$drift_msg"
  fi
fi

# (d) sync-skills 배포 스모크: Claude 커맨드 + Codex 전역 스킬 배포(임시 HOME). 위 드리프트 가드 뒤에 둔다.
TMPCODEX="$(mktemp -d)"
( cd "$ROOT" && CODEX_SKILLS_DIR="$TMPCODEX" bash scripts/sync-skills.sh ) >/dev/null 2>&1
check "(d) .claude/commands/brief.md 배포" "[ -f '$ROOT/.claude/commands/brief.md' ]"
check "(d) Codex 전역 ~/.codex/skills/brief/SKILL.md 배포" "[ -f '$TMPCODEX/brief/SKILL.md' ]"
rm -rf "$TMPCODEX"

# (M4 부록A-9) advance 는 오직 review-pass 에서만 — 승인·심의 우회 차단(코덱스 CRITICAL 회귀)
rm -rf "$ROOT/runs/ci-bypass"
export HARNESS_CLI=stub HARNESS_OFFLINE=1
( cd "$ROOT" && bash scripts/ingest-bundle.sh "$BUNDLE" ci-bypass && bash scripts/run-stage.sh brief ci-bypass ) >/dev/null 2>&1
check "(M4) brief 생성 직후 user 게이트(심의 전, 사람 승인 대기)" "[ \"$(jq_phase ci-bypass gate)\" = 'user' ]"
# 우회1: 승인 없이 advance-phase 직접 호출 → 차단(토큰 부재)
OUT_BP1="$( ( cd "$ROOT" && bash scripts/advance-phase.sh ci-bypass ) 2>&1 )"; RC_BP1=$?
check "(M4) 승인 없이 advance-phase 직접 → 거부(심의 통과 후에만)" "[ $RC_BP1 -ne 0 ] && echo \"\$OUT_BP1\" | grep -q '심의 통과' && echo \"\$OUT_BP1\" | grep -q '부록A-9'"
check "(M4) 우회 시도 후 페이즈 유지(01-brief)" "[ \"$(jq_phase ci-bypass phase)\" = '01-brief' ]"
# 우회2: 승인 없이(gate=user) 가짜 pass verdict + gate.sh review 직접 → 차단(review 게이트 아님)
echo '{"verdict":"pass","engine":"x","confidence":1.0,"violations":[]}' > "$ROOT/runs/ci-bypass/01-brief/brief-verdict.json"
OUT_BP2="$( ( cd "$ROOT" && bash scripts/gate.sh ci-bypass review ) 2>&1 )"; RC_BP2=$?
check "(M4) 승인 없이 gate.sh review 직접 → 거부(승인 우회 차단)" "[ $RC_BP2 -ne 0 ] && [ \"$(jq_phase ci-bypass phase)\" = '01-brief' ]"
# 우회3(코덱스 CRITICAL): 비-ingest 게이트(01-brief user)에서 --to <유효페이즈> 점프 → 차단(--to 는 00-ingest 입력단계만)
OUT_BP3="$( ( cd "$ROOT" && bash scripts/advance-phase.sh ci-bypass --to 03-storyboard ) 2>&1 )"; RC_BP3=$?
check "(M4) 비-ingest 에서 --to 유효페이즈 점프 → 거부(00-ingest 만)" "[ $RC_BP3 -ne 0 ] && echo \"\$OUT_BP3\" | grep -q '00-ingest'"
check "(M4) --to 우회 시도 후 페이즈 유지(01-brief)" "[ \"$(jq_phase ci-bypass phase)\" = '01-brief' ]"
unset HARNESS_CLI HARNESS_OFFLINE

# 정리
rm -rf "$ROOT"/runs/ci-* 2>/dev/null; true

echo "B0: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
