#!/usr/bin/env bash
# pack-lint.sh — packs/<도메인>/ 팩 무결성 린트 (0단계 F). 파이프라인 산출물 바이트 무영향(검증 전용).
#   packs/*/domain.json 이 로더(kcia_engine.load_domain_registry)-동결 불변식(dict·domain==디렉터리명·
#   status∈enum)을 지키고, ruleset.json(있으면)이 registry.json:32 매핑 스키마(ruleset.schema.json)를
#   만족하는지 결정적으로 검사한다. status=active ⇒ ruleset 필수·스키마 통과.
#   registry.json 에 매핑은 있으나 팩 파일을 검증하는 테스트가 없던 공백을 메운다.
# 사용법: bash scripts/pack-lint.sh            # 기본 packs (PACKS_DIR env 로 override 가능)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"
export PACKS_DIR          # 파이썬 서브프로세스로 전파(common.sh 가 이미 형제 packs/ 기본으로 해석)
exec "$PY" "$HARNESS_ROOT/scripts/lib/pack_lint.py" "$@"
