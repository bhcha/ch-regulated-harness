#!/usr/bin/env bash
# gen-images.sh — 이미지 시안 생성 (1급 셸). 04-keyvisual 에서 '수동' 실행(결정 #4).
#   기획안(plan)의 visual.concept 를 입력으로 슬롯별 이미지를 생성한다.
#   엔진: HARNESS_IMAGE_CLI=stub|nanobanana (기본 stub). 삼중가드 미충족 시 결정적 stub SVG.
#   산출물: 04-keyvisual/generated/ (자사 생성물 = allowlist 통과) + 04-keyvisual/image-manifest.json
#   state.json 미수정 — 산출물·매니페스트만 쓴다(절대규칙 #1). 멱등: 이미 생성된 파일은 skip.
# 사용법: bash scripts/gen-images.sh <run_id>
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

RID="${1:-}"; require_run "$RID"
RDIR="$(run_dir "$RID")"
# 가드: 기획안 심의·승인 후(=04-keyvisual 진입)에만 생성 — 미심의 컨셉/픽셀 레퍼런스의 외부 전송 차단(Codex #7).
CUR_PHASE="$(jget "$(state_file "$RID")" phase)"
case "$CUR_PHASE" in
  04-keyvisual|done) ;;
  *) die "이미지 생성은 기획안(plan) 승인 후 04-keyvisual 에서 실행하세요(미심의 컨셉 외부전송 차단). 현재 페이즈=$CUR_PHASE." ;;
esac
[ -d "$RDIR/03-storyboard/plan" ] || die "기획안(plan)이 없습니다. 먼저 03-storyboard 까지 완료하세요."

acquire_lock "$RID"; export HARNESS_LOCK_HELD=1
ENG="$(resolve_image_engine)"
DOM="$(resolve_domain "$(state_file "$RID")")"   # F1(C): 선언 규제도메인 — 규제도메인은 그래픽 블록(html_only) 미생성
info "[gen-images] 엔진=$ENG (HARNESS_IMAGE_CLI=${HARNESS_IMAGE_CLI:-stub}, 키=$([ -n "${NANOBANANA_API_KEY:-}" ] && echo 있음 || echo 없음))"
"$PY" "$HARNESS_ROOT/scripts/lib/image_engine.py" "$RID" "$RDIR" --engine "$ENG" --domain "$DOM"
unset HARNESS_LOCK_HELD; release_lock
ok "[gen-images] 시안 생성 완료 → 04-keyvisual/generated/ (manifest: 04-keyvisual/image-manifest.json)"
