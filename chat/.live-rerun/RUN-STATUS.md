# 라이브 재런 추적 (W4) — chat-live-driver-fix 검증

- **rid**: chat-slack-C0BJ7FJ4A8M · 채널 C0BJ7FJ4A8M · 제품 이지덤 뷰티 릴리프(cosmetic·multipage_bm)
- **목적**: dev-loop 수정(decideLive/runToDone) 검증 — 드라이버가 Verdict/Progress/Failure에서 유휴정지 없이 3안 카드 3종→done.

## 프로세스 (background)
- 데몬(worker): task bi1jf7hcj — intake,brief 무인.
- 드라이버(live GO=1): task b2zsahxz7 — Slack tee + auto-happy.
- 운영자(subagent): guideline=ad7f6d38d8ed1f959. 이후 concept/storyboard-outline/storyboard-plan/keyvisual 은 잡 뜨면 위임.

## env
- source chat/.live-rerun/env.sh (HARNESS_DOMAIN=cosmetic · HARNESS_EXAMPLES_DIR=examples · CHAT_JOBS_DIR=.live-rerun/jobs · CHAT_BRIDGE_TIMEOUT=3600 · CHAT_LIVE_ACTOR=chat:live:U0BHAUPSQ84 · CHAT_LIVE_THREAD=slack:C0BJ7FJ4A8M).
- 운영자 생성: cd core && HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> chat-slack-C0BJ7FJ4A8M (emit-context→artifact→transition).

## 파이프라인 진행 (operator=운영자, daemon=데몬, driver=드라이버 auto)
- [x] 00-ingest (완료)
- [ ] 00g-guideline (operator, 진행 중) — review-exempt autopass
- [ ] 01-brief (daemon) → driver approve → review
- [ ] 02-concept (operator) → **① OptionSet 3안** → driver select → review
- [ ] 03-storyboard-outline (operator) → **② OptionSet 3안** → driver select → review
- [ ] 03-storyboard-plan (operator) → driver approve → review
- [ ] 04-keyvisual (operator, 최장·이미지 bake) → **③ ImageOptionSet 3안** → driver select → confirm → review
- [ ] done

## 검증 포인트 (DoD)
- 3안 카드 3종이 실제로 Slack 채널에 게시되는가.
- 드라이버가 Verdict/Progress에서 멈추지 않고 이어가는가(P1 수정: GenerateRetry는 사람게이트=stop).
- reached=true(done) + 판정 리포트 통과(revise는 실패 아님).
- 아티팩트: .live-rerun/artifacts/chat-slack-C0BJ7FJ4A8M-{transcript.jsonl,report.md,report.json}
