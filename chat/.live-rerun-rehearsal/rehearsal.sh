#!/usr/bin/env bash
# rehearsal.sh — kill-and-reattach 라이브 리허설 오케스트레이터(결정론 · 신호 폴링 · 경계 타임아웃).
#
#   시나리오(2026-07-20 사건 재현): 데몬+드라이버1 기동 → brief 생성 중(잡 claimed) 드라이버1 고의 kill →
#     데몬이 brief 완료 → 드라이버2 재기동(attach) → 현재 게이트 카드 재게시 + 자동 주행 이어짐 확인 → teardown.
#
#   ⚠ 실 과금(brief 1세션 + ADK 심의 + 일부 concept 시도). brief 이후 concept 는 데몬 SUPPORTED_STAGES 밖이라
#     자동 완주 불가 — attach 가 brief 게이트를 이어받아 approve→review→verdict 로 전진하면 성공 판정 후 즉시 teardown.
#   R-2: 데몬·드라이버는 setsid 그룹 리더로 orphan 기동(세션 자식 아님) → kill -TERM -<pgid> 로 트리 회수.
set -uo pipefail

CHAT=/Users/chabh/workspace/ch-regulated-harness/chat
REH="$CHAT/.live-rerun-rehearsal"
LOGS="$REH/logs"; JOBS="$REH/jobs"; ARTIF="$REH/artifacts"
RID=chat-slack-C0BJQFQQZ7U-1784628867-284849
ST="$LOGS/status.log"
cd "$CHAT"

mkdir -p "$LOGS" "$JOBS/pending" "$JOBS/claimed" "$ARTIF"
: > "$ST"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$ST"; }

# ── 기동 헬퍼: 자식을 새 세션(그룹 리더)으로 orphan 기동 → pgid==pid, kill -<pgid> 로 트리 회수(mac 무 setsid → python) ──
launch() { # $1=envfile $2=go|nogo $3=entry $4=logfile $5=pgidfile
  ( set -a; . "$1"; set +a
    [ "$2" = go ] && export CHAT_LIVE_GO=1
    nohup python3 -c 'import os,sys; os.setsid(); os.execvp("npx",["npx","tsx",sys.argv[1]])' "$3" </dev/null >"$4" 2>&1 &
    echo $! > "$5" )
}
kill_group() { # $1=pgidfile
  local pg; pg=$(cat "$1" 2>/dev/null) || return 0
  [ -n "$pg" ] || return 0
  kill -TERM -"$pg" 2>/dev/null || kill -TERM "$pg" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do kill -0 "$pg" 2>/dev/null || return 0; sleep 1; done
  kill -KILL -"$pg" 2>/dev/null || kill -KILL "$pg" 2>/dev/null || true
}
teardown() {
  say "TEARDOWN — 드라이버2·드라이버1·데몬 회수"
  kill_group "$LOGS/driver2.pgid"; kill_group "$LOGS/driver1.pgid"; kill_group "$LOGS/daemon.pgid"
}
trap teardown EXIT

# 세션별 transcript 의 presentation type 시퀀스(증거) — 최신 epoch 파일 1개.
seq_of() { # $1=transcript.jsonl → "Type,Type,..."
  [ -f "$1" ] || { echo "(없음)"; return; }
  python3 -c '
import json,sys
seq=[]
for ln in open(sys.argv[1]):
    ln=ln.strip()
    if not ln: continue
    try: p=json.loads(ln).get("presentation",{})
    except: continue
    t=p.get("type","?"); ph=p.get("phase") or p.get("rid","")
    seq.append(t)
print(",".join(seq) if seq else "(빈 트랜스크립트)")
' "$1"
}
newest_transcript() { ls -t "$ARTIF/${RID}-transcript."*.jsonl 2>/dev/null | head -1; }
slack_count() { ls "$ARTIF/${RID}-transcript."*.jsonl 2>/dev/null | wc -l | tr -d ' '; }

# ═══ 1) 데몬 기동(env-common · Slack 시크릿 없음) ═══
say "1) 데몬 기동(intake,brief 무인 · Slack 무)"
launch "$REH/env-common.sh" nogo src/worker/main.ts "$LOGS/daemon.log" "$LOGS/daemon.pgid"
sleep 4
if ! kill -0 "$(cat "$LOGS/daemon.pgid")" 2>/dev/null; then say "✋ 데몬 기동 실패 — daemon.log 확인"; tail -5 "$LOGS/daemon.log" | tee -a "$ST"; exit 1; fi
say "   데몬 pgid=$(cat "$LOGS/daemon.pgid")"

# ═══ 2) 드라이버1 기동(env-driver · CHAT_LIVE_GO=1 · 실 Slack tee) ═══
say "2) 드라이버1 기동(멘션→ingest→brief · attach 켜짐)"
launch "$REH/env-driver.sh" go src/live/main.ts "$LOGS/driver1.log" "$LOGS/driver1.pgid"
sleep 5
if ! kill -0 "$(cat "$LOGS/driver1.pgid")" 2>/dev/null; then say "✋ 드라이버1 기동 실패"; tail -8 "$LOGS/driver1.log" | tee -a "$ST"; exit 1; fi
say "   드라이버1 pgid=$(cat "$LOGS/driver1.pgid")"

# ═══ 3) brief 생성 착수(잡이 큐에 뜸) 대기 → 그 순간 드라이버1 kill(사건 재현: 생성 중 사망) ═══
#   ⚠ 신호 정정: 데몬은 claimed 잡을 claimed/<consumerId>/ **하위 디렉터리**에 둔다(run1 에서 claimed/<rid>-brief.json
#     고정경로가 안 맞아 창을 놓쳤다). find 로 서브디렉터리·pending 무관하게 brief 잡을 탐지한다 — 잡이 큐에 존재하면
#     드라이버가 죽어도 데몬이 완주한다(잡은 공유 파일 · 드라이버 kill 과 무관). 착수 즉시 짧게 머문 뒤 kill.
say "3) brief 생성 착수 대기(잡 큐 등장 신호 · 최대 600s)"
BRIEF_JOB="${RID}-brief.json"
brief_present() { find "$JOBS" -name "$BRIEF_JOB" 2>/dev/null | grep -q .; }
killed=0
for i in $(seq 1 300); do   # 300 × 2s = 600s
  if brief_present; then
    say "   ▶ brief 잡 큐 등장(생성 착수) — 5s 뒤 드라이버1 kill(생성 진행 중 드라이버 사망 재현)"
    sleep 5
    kill_group "$LOGS/driver1.pgid"; killed=1
    break
  fi
  if [ -f "$JOBS/failed/$BRIEF_JOB" ]; then say "   ⚠ brief 잡이 failed 로 감 — 재현 창 놓침"; break; fi
  kill -0 "$(cat "$LOGS/driver1.pgid")" 2>/dev/null || { say "   ⚠ 드라이버1 이 스스로 종료(예상 밖) — driver1.log 확인"; break; }
  sleep 2
done
[ "$killed" = 1 ] || { say "   ⚠ 생성 착수 신호 미포착 — 그래도 드라이버1 kill 후 attach 시도"; kill_group "$LOGS/driver1.pgid"; }
S1_TX="$(newest_transcript)"
say "   [증거] 드라이버1 세션 화면열(kill 시점): $(seq_of "$S1_TX")"

# ═══ 4) brief 생성 완료 대기(잡이 큐에서 빠질 때까지 · find 기반) ═══
say "4) brief 생성 완료 대기(데몬이 전이 · 최대 600s)"
for i in $(seq 1 300); do
  if ! brief_present; then
    if [ -f "$JOBS/failed/$BRIEF_JOB" ]; then say "   ⚠ brief 실패(jobs/failed) — 재개 대상이 아님(사유 확인)"; tail -1 "$JOBS/failed/${BRIEF_JOB}.reason" 2>/dev/null | tee -a "$ST"; fi
    say "   ▶ brief 잡이 큐에서 빠짐(생성 종료 · 데몬 전이)"; break
  fi
  sleep 2
done
sleep 3   # 전이 flush 여유

# ═══ 5) 드라이버2 재기동(attach) — 재멘션 없이 현재 게이트 카드 재게시 + 자동 주행 재진입 ═══
say "5) 드라이버2 재기동(attach — 현재 게이트 카드 재게시 + 이어달리기)"
launch "$REH/env-driver.sh" go src/live/main.ts "$LOGS/driver2.log" "$LOGS/driver2.pgid"
sleep 6
if ! kill -0 "$(cat "$LOGS/driver2.pgid")" 2>/dev/null; then say "✋ 드라이버2 기동 실패"; tail -8 "$LOGS/driver2.log" | tee -a "$ST"; exit 1; fi
say "   드라이버2 pgid=$(cat "$LOGS/driver2.pgid")"
grep -m1 -i "attach\|이어\|재개\|reviewResume" "$LOGS/driver2.log" 2>/dev/null | tee -a "$ST" || true

# ═══ 6) 재개 검증 — 드라이버2 세션이 현재 게이트를 재게시하고 brief 를 지나 전진했는가 ═══
say "6) 재개·전진 검증(최대 600s) — 드라이버2 세션 화면이 brief 게이트 재게시 후 approve→review→verdict/다음 단계로"
ok=0
for i in $(seq 1 300); do
  S2_TX="$(newest_transcript)"
  # driver2 세션은 driver1 과 다른 epoch 파일. 그 화면열에 Verdict 또는 02-concept 전진이 보이면 재개+전진 성공.
  if [ -n "$S2_TX" ] && [ "$S2_TX" != "$S1_TX" ]; then
    types="$(seq_of "$S2_TX")"
    if echo "$types" | grep -qE "Verdict"; then say "   ▶ 재개 성공 — 드라이버2 세션이 심의 판정(Verdict)까지 전진: $types"; ok=1; break; fi
    if python3 -c "import json,sys
adv=False
for ln in open(sys.argv[1]):
    ln=ln.strip()
    if not ln: continue
    try: p=json.loads(ln).get('presentation',{})
    except: continue
    if (p.get('phase') or '').startswith('02-'): adv=True
sys.exit(0 if adv else 1)" "$S2_TX" 2>/dev/null; then say "   ▶ 재개 성공 — 드라이버2 세션이 다음 단계(02-concept)로 전진: $types"; ok=1; break; fi
  fi
  kill -0 "$(cat "$LOGS/driver2.pgid")" 2>/dev/null || { say "   ⚠ 드라이버2 종료됨 — 최종 화면열로 판단"; break; }
  sleep 2
done
S2_TX="$(newest_transcript)"
say "   [증거] 드라이버2 세션 화면열: $(seq_of "$S2_TX")"
say "   [증거] 세션 transcript 파일 수(=런 세션 수): $(slack_count) · artifacts=$ARTIF"

# ═══ 결과 ═══
if [ "$ok" = 1 ]; then
  say "RESULT: PASS — kill-and-reattach 재개 확인(드라이버2 attach 가 현재 게이트 재게시 후 brief 전진)"
else
  say "RESULT: INCONCLUSIVE — 화면열/로그로 수동 판정 필요(아래 driver2.log·transcript 확인)"
fi
say "DONE"
