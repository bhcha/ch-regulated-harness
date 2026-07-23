#!/usr/bin/env bash
# sync-skills.sh — skills/ 원본 → Claude 슬래시(.claude/commands) + Codex 전역(~/.codex/skills) 배포.
#   슬래시는 편의 래퍼일 뿐 1급 경로(run-stage.sh)에 의존하지 않는다(이식성).
# 사용법: bash scripts/sync-skills.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

SKILLS_DIR="$HARNESS_ROOT/skills"
CLAUDE_CMD_DIR="$HARNESS_ROOT/.claude/commands"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"

mkdir -p "$CLAUDE_CMD_DIR"
deployed=0
for d in "$SKILLS_DIR"/*/; do
  name="$(basename "$d")"
  src="$d/SKILL.md"
  [ -f "$src" ] || continue
  # 1) Claude 슬래시: .claude/commands/<name>.md (그대로 복사)
  cp -f "$src" "$CLAUDE_CMD_DIR/$name.md"
  # 2) Codex 전역 스킬: ~/.codex/skills/<name>/SKILL.md (복사)
  if mkdir -p "$CODEX_SKILLS_DIR/$name" 2>/dev/null; then
    cp -f "$src" "$CODEX_SKILLS_DIR/$name/SKILL.md" 2>/dev/null || true
  fi
  deployed=$((deployed + 1))
done
ok "스킬 배포 완료: $deployed 개 → .claude/commands + $CODEX_SKILLS_DIR"
info "Codex 전역 슬래시 동작 여부는 부록 A 에 결과를 기록하세요(버전 고정 후 실증)."
