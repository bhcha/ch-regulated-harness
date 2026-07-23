#!/usr/bin/env bash
# verify.sh — chat 레이어 검증 게이트(모노레포 · 2계층).
#
#   standalone(항상 실행, 하네스 불필요):
#     ① build(tsc --noEmit)  ② 단위 테스트(vitest run — test/e2e 제외)
#   integration(HARNESS_ROOT 주입 시만 — 형제 core 를 실제 구동):
#     ③ 계약 픽스처 재캡처 멱등  ④ stub E2E  ⑤ 인수 시나리오(표면 흐름)  ⑥ core 무수정 증명
#
#   ⚠ 순서 주의: core 무수정 증명(⑥)은 core 스크립트를 spawn 하는 ③·④·⑤ '뒤'에 둔다 —
#     어댑터가 core 를 부린 결과로 하네스 체크아웃이 더럽혀졌는지를 봐야 하므로, 부리기 전에 검사하면
#     오염을 놓친다(false-positive pass). 부린 뒤 검사가 무수정 불변식의 의미다. 인수 시나리오(⑤)도 core 를
#     offline 으로 spawn 하므로 같은 이유로 ⑥ '앞'에 둔다(뒤로 미루면 인수가 낸 오염을 놓쳐 false-pass).
#
#   HARNESS_ROOT 미주입이면 standalone 만 돌리고 통합 검증은 '보이게' 생략한다(조용한 통과 금지).
set -euo pipefail
CHAT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # chat/ (= 리포/패키지 루트)
cd "$CHAT"

echo "== 1) build (tsc --noEmit) =="
pnpm build

echo "== 2) test (vitest run — standalone 단위, 하네스 불필요) =="
pnpm test

# ── 통합 검증: HARNESS_ROOT(하네스 core 체크아웃)가 주입됐을 때만 ──
if [ -z "${HARNESS_ROOT:-}" ]; then
  echo "하네스 미지정(HARNESS_ROOT) — 통합 검증(core 무수정·픽스처 멱등·E2E) 생략"
  echo "== verify OK (standalone) =="
  exit 0
fi

export HARNESS_OFFLINE=1   # 통합 검증은 결정적 stub 로(골든 바이트 불변)

echo "== 3) 계약 픽스처 재캡처 멱등(next-action 계약 드리프트 감지) =="
bash "$CHAT/test/fixtures/capture-fixtures.sh" >/dev/null 2>&1 || {
  echo "✋ 픽스처 재캡처 실패" >&2; exit 1; }
# pathspec 은 $CHAT 기준 test/fixtures/next-action/ — '생성된 픽스처 출력물'만 본다.
#   test/fixtures/ 전체가 아니다: 그 폴더엔 생성기 스크립트(capture-fixtures.sh)도 있어, 넓게 잡으면
#   스크립트의 정당한(계약 무관) 편집까지 '계약 드리프트'로 오탐한다. 드리프트 신호 = 재캡처된 JSON 뿐.
if ! git -C "$CHAT" diff --quiet -- test/fixtures/next-action/; then
  echo "✋ 픽스처가 재캡처와 다릅니다 — core next-action 계약이 바뀌었을 수 있습니다:" >&2
  git -C "$CHAT" --no-pager diff --stat -- test/fixtures/next-action/ >&2
  exit 1
fi
echo "  픽스처 멱등 ✓"

echo "== 4) stub E2E(통합) =="
pnpm test:integration

# ⑤ 인수 시나리오(표면 흐름) — 실 게이트웨이가 core 를 offline 으로 spawn 해 멘션→…→done 등을 결정론으로 몬다.
#   core 를 부리므로 core 무수정 증명(⑥) '앞'에 둔다(④ 와 같은 순서 근거 · 위 헤더 주석).
#   트랜스크립트 아티팩트는 gitignore 된 $CHAT/.acceptance-artifacts/ 로 떨궈(opt-in env — support.ts
#   writeTranscriptArtifact) 작업트리·core 무수정 증명을 더럽히지 않는다. 실패하면 set -e 로 verify 가 즉시 중단.
echo "== 5) 인수 시나리오(표면 흐름 — core 를 offline 으로 spawn) =="
export CHAT_ACCEPT_ARTIFACT_DIR="$CHAT/.acceptance-artifacts"
mkdir -p "$CHAT_ACCEPT_ARTIFACT_DIR"
pnpm test:accept
echo "  인수 트랜스크립트 아티팩트(사람/AI 판독 · CI 구조 재료): $CHAT_ACCEPT_ARTIFACT_DIR/*.jsonl"

# ⑥ core 무수정 증명은 ③·④·⑤(core 스크립트 spawn) '뒤'에 둔다 — 부린 뒤라야 오염을 잡는다(위 헤더 주석).
echo "== 6) core 무수정 증명(chat 어댑터가 하네스 체크아웃을 더럽히지 않았는가 — 통합 실행 후) =="
# 모노레포: HARNESS_ROOT 는 이 레포의 core/ 서브트리다 → pathspec `-- .`(= HARNESS_ROOT 하위)로
#   범위를 한정하면 status --porcelain 이 core 서브트리 변경만 반영하고 형제 chat/ 변경은 오탐하지 않는다.
#   (같은 `-- .` 는 저장소 분리 레이아웃에서도 유효했다 — 그때는 `.`=별도 core 레포 전체. 분리 설계는
#    docs/_archive/chat-gateway-split-plan.md 로 아카이브. 구 경로 `git -C "$WT" status -- core/` 는 폐기 —
#    chat 워크트리 변경까지 오탐하기 때문.)
if git -C "$HARNESS_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  CORE_CHANGES="$(git -C "$HARNESS_ROOT" status --porcelain -- .)"
  if [ -n "$CORE_CHANGES" ]; then
    echo "✋ 하네스(core) 체크아웃에 변경이 있습니다 — chat 어댑터는 core 무수정이어야 합니다:" >&2
    echo "$CORE_CHANGES" >&2
    exit 1
  fi
  echo "  core diff = 0 ✓"
else
  echo "  (참고) HARNESS_ROOT 가 git 체크아웃이 아닙니다 — core 무수정 증명 생략: $HARNESS_ROOT"
fi

echo "== verify OK (standalone + integration + 인수) =="
