#!/usr/bin/env bash
# validate-stage.sh — 산출물 JSON 스키마/포맷 검증 (친절한 한국어 반려).
# 사용법:
#   bash scripts/validate-stage.sh <run_id> [phase]   # 페이즈 산출물 일괄 검증
#   bash scripts/validate-stage.sh --file <path>       # 단일 파일 검증
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

if [ "${1:-}" = "--file" ]; then
  shift; validate_artifact "$1"; exit $?
fi

RID="${1:-}"; require_run "$RID"
assert_ingest_complete "$RID"   # N10: run 모드만 — 단일파일(--file)은 위에서 이미 반환(미적용). 00-ingest 미완 표식이면 fail-closed
PHASE="${2:-$(jget "$(state_file "$RID")" phase)}"
RDIR="$(run_dir "$RID")"
VS="$HARNESS_ROOT/scripts/lib/validate_stage.py"   # 검증 본문(인라인 python 14블록) 이관 모듈

declare -a TARGETS
case "$PHASE" in
  00a-intake)
    # 첨부 자료 분류 제안(에이전트 제안 → 사람 승인 대상). 스키마는 registry(위 phase-dir 루프)가 검증하고,
    # 1:1 스냅샷 커버리지·sha256 대조·enum 은 아래 코드가 강제. unknown 은 유효 enum(사람이 approve/revise 로 해소).
    TARGETS=("00a-intake/intake-proposal.json") ;;
  00-ingest)  TARGETS=("00-ingest/voc.json" "00-ingest/claim-basis.json" "00-ingest/assets-manifest.json" "00-ingest/best-practices.json") ;;
  00e-evidence)
    # 반영 제안 초안(에이전트 추출 → 사람 승인 대상). 스키마는 registry 로 검증되고, 조건부 완전성은 아래 코드가 강제.
    TARGETS=("00e-evidence/reflection-proposal.json") ;;
  00g-guideline)
    # 크롤 참조 노트(자유텍스트) 필수 — 구 '유사점 3안 + recommendation' 파기. 사례별 example-analysis 는 아래 fail-closed 가 강제.
    TARGETS=("00g-guideline/reference-notes.json") ;;
  01-brief)   TARGETS=("01-brief/brief.json") ;;
  02-concept)
    TARGETS=("02-concept/concept-axes.json" "02-concept/recommendation.json")
    # concept-axes 에 정의된 모든 축은 rtb.json + key-message.json 을 가져야 한다(부분 생성 차단).
    if [ -f "$RDIR/02-concept/concept-axes.json" ]; then
      while IFS= read -r ax; do
        [ -n "$ax" ] || continue
        TARGETS+=("02-concept/options/$ax/rtb.json" "02-concept/options/$ax/key-message.json")
      done < <("$PY" -c "import json,sys;[print(a['id']) for a in json.load(open('$RDIR/02-concept/concept-axes.json'))['axes']]" 2>/dev/null)
    fi ;;
  03-storyboard)
    SB_SUB="$(storyboard_substage "$RID")"
    if [ "$SB_SUB" = "plan" ]; then
      # M3: tone 서브스테이지 제거 — 기획안은 스토리라인(outline) 확정만 선행(tone/decision.json 불필요).
      SEL="$("$PY" "$LIB" jget "$RDIR/03-storyboard/outline/decision.json" selected 2>/dev/null || echo A)"
      # 코덱스 4R Medium: 선택 스토리라인 자체를 **필수 target**으로(삭제/손상·selected 가 비실재 option 이면 fail-closed).
      #   이게 존재해야 아래 plan 블록 목록 도출이 신뢰된다(없으면 plan 커버리지가 '0블록=통과'로 오판될 수 있음).
      #   P0-ⓠ: 전역 아트디렉션(art-direction.json)도 plan 단계 필수 산출물(블록 톤 상속의 단일 출처).
      TARGETS=("03-storyboard/outline/decision.json" "03-storyboard/outline/options/$SEL/storyline.json" "03-storyboard/art-direction.json")
      # 선택된 아웃라인의 모든 블록이 plan/NN-type.json 으로 존재해야 한다.
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        TARGETS+=("03-storyboard/plan/$line")
      done < <("$PY" -c "import json;sl=json.load(open('$RDIR/03-storyboard/outline/options/$SEL/storyline.json'));[print('%02d-%s.json'%(b['order'],b['type'])) for b in sl['blocks']]" 2>/dev/null)
    else
      # 이슈3a: 스토리라인 최소 3안(A·B·C) 필수.
      TARGETS=("03-storyboard/outline/options/A/storyline.json" "03-storyboard/outline/options/B/storyline.json" \
               "03-storyboard/outline/options/C/storyline.json" \
               "03-storyboard/outline/recommendation.json" "03-storyboard/sources/results.json")
    fi ;;
  04-keyvisual)
    # 이슈3a: 디자인 최소 3안(A·B·C) 필수.
    TARGETS=("04-keyvisual/options/A/index.html" "04-keyvisual/options/B/index.html" "04-keyvisual/options/C/index.html" "04-keyvisual/recommendation.json")
    # design-manifest 는 렌더 후 존재 — 렌더가 끝난 경우에만 필수
    [ -f "$RDIR/04-keyvisual/design-manifest.json" ] && TARGETS+=("04-keyvisual/design-manifest.json") ;;
  *) TARGETS=() ;;
esac

# 추가로 해당 페이즈 폴더의 알려진 JSON 산출물(options/review/decision/verdict)도 검증
fail=0
shopt -s nullglob
phase_dir="$RDIR/$PHASE"
if [ -d "$phase_dir" ]; then
  while IFS= read -r f; do
    rel="${f#"$RDIR"/}"
    # registry 매칭되는 것만 검증 (.md 등은 스킵)
    if "$PY" "$LIB" validate "$f" >/dev/null 2>&1; then
      :
    else
      # registry 미매칭이면 조용히 스킵, 매칭인데 실패면 보고
      sname="$($PY -c "import sys,os;sys.path.insert(0,'$HARNESS_ROOT/scripts/lib');from harness import schema_for_path;print(schema_for_path('$rel') or '')")"
      if [ -n "$sname" ]; then
        err "검증 실패: $rel"; validate_artifact "$f" || true; fail=1
      fi
    fi
  done < <(find "$phase_dir" -name '*.json' ! -name '.tmp.*')
fi

if [ "${#TARGETS[@]}" -gt 0 ]; then
  for t in "${TARGETS[@]}"; do
    if [ ! -f "$RDIR/$t" ]; then
      err "필수 산출물 누락: $t"; fail=1
    fi
  done
fi

# 추천 정합성: recommendation.ranked 가 실재 옵션 id 의 부분집합이어야 한다(Codex #8).
rec_check() {
  local rec="$1" optdir="$2"
  [ -f "$rec" ] && [ -d "$optdir" ] || return 0
  local bad; bad="$("$PY" "$VS" rec-check "$rec" "$optdir" 2>/dev/null)"
  if [ -n "$bad" ]; then err "recommendation.ranked 에 실재하지 않는 옵션: $bad"; fail=1; fi
}

# 이슈3a(최소 3안): 다안 페이즈는 '유효 옵션' ≥3 + recommendation.ranked 의 '서로 다른 유효 옵션' ≥3 이어야 한다(2안 약함 차단).
#   프롬프트·스키마·게이트 3중 강제 중 '게이트' 축. 옵션 개수 자체를 제약하는 결정적 fail-closed.
#   ★ 유효 옵션 = '표지 파일($3)을 실제로 가진 디렉터리'만(빈 phantom 디렉터리 우회 차단, Codex 3a HIGH). ranked 는 중복 제거 후 유효 옵션 교집합 ≥3(["A","A","A"] 우회 차단).
min3_check() {
  local optdir="$1" rec="$2" marker="$3"
  local valid_opts
  valid_opts="$("$PY" "$VS" min3-valid-opts "$optdir" "$marker" 2>/dev/null || true)"
  local nopt; nopt="$(echo "$valid_opts" | wc -w | tr -d ' ')"
  if [ "${nopt:-0}" -lt 3 ]; then err "다안 유효 옵션이 3개 미만(${nopt:-0}) — 최소 3안 필요(이슈3a; 표지=$marker). $optdir"; fail=1; fi
  if [ -f "$rec" ]; then
    local ndistinct; ndistinct="$("$PY" "$VS" min3-ndistinct "$rec" "$valid_opts" 2>/dev/null || echo 0)"
    if [ "${ndistinct:-0}" -lt 3 ]; then err "recommendation.ranked 의 서로 다른 유효 옵션이 3개 미만(${ndistinct:-0}) — 중복·phantom 추천 차단(이슈3a). $rec"; fail=1; fi
  fi
}
case "$PHASE" in
  01-brief)
    # M1(G4): 갓 생성된 brief 는 ⓪ 선언 2축을 output_type 에 담아야 한다(존재+state 일치 강제).
    #   스키마는 optional(디스크 골든 후방호환)이라 이 fail-closed 게이트가 실 LLM 누락·오라벨을 차단한다.
    "$PY" "$VS" brief-output-type "$RDIR" >/dev/null 2>&1 || { err 'brief.output_type 누락 또는 state 2축(도메인/포맷)과 불일치(M1 G4 fail-closed)'; fail=1; }
    ;;
  00a-intake)
    # 첨부 분류 제안 fail-closed(코드 강제 — 스키마는 구조·enum 만):
    #   ① files 가 스냅샷 첨부(inputs/attachments/ 최상위, _unpacked·닷파일 제외)와 1:1 전수 커버리지(정렬)
    #   ② 파일별 sha256 == 실제 스냅샷 파일 해시(불변 보존·위변조 감지 — 심층방어; approve 가드가 front-line)
    #   ③ category/route/kind enum 멤버십(스키마와 이중). unknown 은 유효 enum(사람이 approve 게이트에서 해소; validate 단독으론 막지 않음 —
    #      run-stage 가 gate 전에 validate 를 돌리므로 여기서 unknown 을 막으면 분류표가 사람 확인 전에 죽어 approve 게이트에 도달 못 함. unknown 차단은 approve.sh 의 fail-closed 가드 소관).
    "$PY" "$VS" intake-proposal "$RDIR" >/dev/null 2>&1 || { err '첨부 분류 제안 검증 실패 — 스냅샷 첨부와 1:1 커버리지 + 파일별 sha256 정합 + category/route/kind enum + 워킹백워드 분류≥1·변환본 존재 필요(fail-closed)'; fail=1; }
    ;;
  00e-evidence)
    # 반영 제안(reflection-proposal) fail-closed(코드 강제 — 로컬 검증기 조건부-required 미지원):
    #   ① pending 매니페스트 문서와 1:1(id+NFC 파일명, 전수 커버리지) ② 문서별 claim 비어있지 않음 + reflection_points≥1(원문 발췌)
    #   ③ kind=test_report(W-3, 00e 스펙 2차 관문) 은 **intent-match 일 때만** 허용 — 매니페스트의 그 문서가 사람 선언
    #      kind=test_report + spec_status=pending 이어야 한다(bare/일반 문서를 제안이 test_report 로 승격 금지·안전 불변식).
    #      허용된 test_report 제안은 verdict_text/grade/기관/n(정수≥1)/기간 완전성을 코드로 강제(효능 실증 5요소).
    #   ⚠ reflection_points 원문에는 효능 deny-list 를 걸지 않는다 — 문서 발췌를 verbatim 결박해 하류(03/04)에서 심의된다.
    "$PY" "$VS" evidence-reflection "$RDIR" >/dev/null 2>&1 || { err '반영 제안(reflection-proposal) 검증 실패 — pending 문서와 1:1 대응 + 문서별 claim·reflection_points(≥1, 원문 발췌) 필요; 시험성적서(test_report) 제안은 사람이 kind:test_report 로 intent 선언한 문서에만 + verdict_text·grade·기관·n·기간 완전성 필요. fail-closed'; fail=1; }
    ;;
  00g-guideline)
    # 크롤 참조 노트: 적어도 하나의 참조(flow_refs/composition_notes/notes)가 있어야 한다(빈 no-op 차단).
    "$PY" "$VS" guideline-refnotes-nonempty "$RDIR" >/dev/null 2>&1 || { err '크롤 참조 노트(reference-notes)가 비어있음(flow_refs/composition_notes/notes 중 ≥1 필요)'; fail=1; }
    # fail-closed(Codex P1 HIGH): 참조 노트 자유텍스트에 효능·절대·속효어(한/영 + 우회) 금지 — why_violations deny-list 재사용.
    #   룰엔진 단독 경로가 한국어 banned 만 잡는 갭(예: 'whitening effect', 'No.1 anti-aging')을 결정적으로 봉인.
    "$PY" "$VS" guideline-refnotes-deny "$RDIR" >/dev/null 2>&1 || { err '크롤 참조 노트에 효능·절대·속효 표현(한/영) 감지 — 시각·구조 어휘만 허용(법=룰셋 우선, fail-closed)'; fail=1; }
    # fail-closed: why_good[].grounded_in 은 실재 signals 키 또는 voc_themes/structure/block_sequence/pacing 만 인용
    "$PY" "$VS" guideline-whygood-grounded "$RDIR" >/dev/null 2>&1 || { err 'example-analysis why_good.grounded_in 에 비실재 키(fail-closed 위반)'; fail=1; }
    # M2(G3): 감각 reference_images fail-closed (코덱스 M2 리뷰 HIGH 3건 반영) —
    #   ⓐ 모든 example-analysis 에 reference_images 비어있지 않음(무조건; self-report detail_image_count 의존 제거 → 우회 차단)
    #   ⓑ composition_tags/mood_tags 는 화이트리스트(ALLOWED_*) 어휘만(효능·절대어 0) + why 는 deny-list(효능/절대) 무관 + 자기 태그 인용(grounded)
    #   ⓒ id 는 '<example_id>#NN' 형식 + 전(全) 사례 관통 전역 유일(M6 조인 모호성 차단)
    #   ⓓ src 는 크롤 분석/추적용 경로(디자인 자산 inputs/assets/ 금지=저작권 부록A-4)
    "$PY" "$VS" guideline-reference-images "$RDIR" >/dev/null 2>&1 || { err 'reference_images fail-closed 위반: 누락/비화이트리스트 태그/효능·절대어/why 미인용/id 형식·전역중복/src 디자인자산(M2 G3·저작권 부록A-4)'; fail=1; }
    # 사례 분석 ≥1(실파일) + 내부 example_id==디렉터리명 (LLM 누락·오기 차단)
    "$PY" "$VS" guideline-example-analysis "$RDIR" >/dev/null 2>&1 || { err 'example-analysis 누락(≥1) 또는 내부 example_id≠디렉터리명(fail-closed)'; fail=1; }
    # 00g 산출물(example-analysis + reference-notes)의 regulatory_domain 이 run 의 state 도메인과 일치(LLM 오라벨 차단, fail-closed)
    "$PY" "$VS" guideline-domain-match "$RDIR" >/dev/null 2>&1 || { err '00g 산출물 regulatory_domain 이 state 도메인과 불일치(오라벨)'; fail=1; }
    ;;
  02-concept)
    rec_check "$RDIR/02-concept/recommendation.json" "$RDIR/02-concept/options"
    min3_check "$RDIR/02-concept/options" "$RDIR/02-concept/recommendation.json" "key-message.json" ;;   # 이슈3a: 유효 컨셉 축(key-message 보유) ≥3
  03-storyboard)
    rec_check "$RDIR/03-storyboard/outline/recommendation.json" "$RDIR/03-storyboard/outline/options"
    # 이슈3a: 스토리라인(outline) 다안만 ≥3 강제(plan 은 단안 — 제외).
    [ "$(storyboard_substage "$RID")" = "outline" ] && min3_check "$RDIR/03-storyboard/outline/options" "$RDIR/03-storyboard/outline/recommendation.json" "storyline.json"
    # M3 fail-closed(코덱스 M3 HIGH): tone 흡수 후 기획안(plan) 모든 블록은 visual.concept(구도/무드/참조)를
    #   가져야 한다 — 스키마상 concept 는 optional 이라 실 LLM 이 빼면 구도/무드/참조가 사라져도 통과하므로 여기서 강제.
    if [ "$(storyboard_substage "$RID")" = "plan" ]; then
      "$PY" "$VS" plan-visual-concept "$RDIR" >/dev/null 2>&1 || { err '기획안 블록에 visual.concept(구도/무드 + reference.own_asset_path) 누락(M3 tone 흡수 fail-closed)'; fail=1; }
      # P0-ⓠ fail-closed: 전역 아트디렉션 존재 + 모든 블록 palette ⊆ master_palette(톤 분열 차단).
      #   스키마는 art_direction 을 강제하지 못하므로(블록은 palette optional) 여기서 '블록이 전역 팔레트 밖 색을 쓰지 않음'을 결정적으로 봉인.
      "$PY" "$VS" plan-art-direction "$RDIR" >/dev/null 2>&1 || { err '전역 아트디렉션 누락 또는 블록 palette 누락/빈/공백/비부분집합(P0-ⓠ 톤 일관성 fail-closed)'; fail=1; }
    fi
    # 자산 경로 안전(저작권 traversal 차단): plan 의 own_asset_path 가 inputs/assets 하위인지 realpath 검사
    "$PY" "$HARNESS_ROOT/scripts/lib/check_asset_paths.py" "$RDIR" >/dev/null 2>&1 || {
      "$PY" "$HARNESS_ROOT/scripts/lib/check_asset_paths.py" "$RDIR" >&2 || true; fail=1; }
    # enabled_if/캐논 의미 검증 (스키마로 못 막는 환각 게이트 블록 차단)
    "$PY" "$HARNESS_ROOT/scripts/lib/validate_storyboard.py" "$RDIR" >/dev/null 2>&1 || {
      "$PY" "$HARNESS_ROOT/scripts/lib/validate_storyboard.py" "$RDIR" || true; fail=1; }
    # 주요 구성요소 커버리지 게이트 — 아웃라인(조기 검출)·기획안(확정) 둘 다 하드 게이트
    COV_SCOPE="$([ "$(storyboard_substage "$RID")" = "plan" ] && echo plan || echo outline)"
    "$PY" "$HARNESS_ROOT/scripts/lib/check_canon_coverage.py" "$RDIR" --scope "$COV_SCOPE" >/dev/null 2>&1 || {
      "$PY" "$HARNESS_ROOT/scripts/lib/check_canon_coverage.py" "$RDIR" --scope "$COV_SCOPE" || true; fail=1; }
    # 가격 단일출처 가드(AGENTS 6번 절) — plan 카피 필드에 voc offer.price 와 다른 하드코딩 가격 차단(RCA 8-1.5).
    #   plan 서브스테이지만(outline 엔 plan/*.json 부재). HTML 가시 텍스트는 04 의 check_html_blocks 가 담당(이중스캔 없음).
    if [ "$(storyboard_substage "$RID")" = "plan" ]; then
      "$PY" "$HARNESS_ROOT/scripts/lib/check_html_blocks.py" --plan-price "$RDIR" >/dev/null 2>&1 \
        || { "$PY" "$HARNESS_ROOT/scripts/lib/check_html_blocks.py" --plan-price "$RDIR" >&2 || true; fail=1; }
    fi
    ;;
  04-keyvisual)
    rec_check "$RDIR/04-keyvisual/recommendation.json" "$RDIR/04-keyvisual/options"
    min3_check "$RDIR/04-keyvisual/options" "$RDIR/04-keyvisual/recommendation.json" "index.html"   # 이슈3a: 유효 디자인(index.html 보유) ≥3안
    # 생성물 매니페스트 경로 안전(traversal 차단)
    "$PY" "$HARNESS_ROOT/scripts/lib/check_asset_paths.py" "$RDIR" >/dev/null 2>&1 || {
      "$PY" "$HARNESS_ROOT/scripts/lib/check_asset_paths.py" "$RDIR" >&2 || true; fail=1; }
    # 저작권 lint(allowlist): 렌더 외에도 검증 단계에서 강제
    if [ -d "$RDIR/04-keyvisual/options" ]; then
      "$PY" "$HARNESS_ROOT/scripts/lib/img_lint.py" "$RDIR/04-keyvisual/options" "$RDIR/inputs/bundle/product.json" >/dev/null 2>&1 \
        || { "$PY" "$HARNESS_ROOT/scripts/lib/img_lint.py" "$RDIR/04-keyvisual/options" "$RDIR/inputs/bundle/product.json" >&2 || true; fail=1; }
    fi
    # 포맷 금지 블록 HTML 전수 스캔(비선택 B/C 옵션 포함) — design-manifest 선택안-only 사각 보완(RCA 8-1.4)
    if [ -d "$RDIR/04-keyvisual/options" ]; then
      "$PY" "$HARNESS_ROOT/scripts/lib/check_html_blocks.py" "$RDIR/04-keyvisual/options" "$RDIR" >/dev/null 2>&1 \
        || { "$PY" "$HARNESS_ROOT/scripts/lib/check_html_blocks.py" "$RDIR/04-keyvisual/options" "$RDIR" >&2 || true; fail=1; }
    fi
    # 디자인 렌더 후 구성요소 커버리지 게이트(design-manifest 섹션 기준)
    if [ -f "$RDIR/04-keyvisual/design-manifest.json" ]; then
      "$PY" "$HARNESS_ROOT/scripts/lib/check_canon_coverage.py" "$RDIR" --scope design >/dev/null 2>&1 || {
        "$PY" "$HARNESS_ROOT/scripts/lib/check_canon_coverage.py" "$RDIR" --scope design || true; fail=1; }
    fi
    # 반영 강제(조기 게이트): reflect:true 근거 문서가 최종 산출물(선택 HTML)에 반영됐는지를 done 게이트보다
    #   먼저 여기서 잡는다. validate-stage 04-keyvisual 은 (a)approve.sh 의 선택안 재렌더 직후와 (b)gate.sh:51
    #   export 직전에 돌므로, 반영 실패가 심의·export 前에 차단된다 → 선택 HTML 을 재렌더할 수 있는 시점에서
    #   고칠 수 있어(HTML-only 수정으로 섹션 PNG·design-manifest 가 스테일 되는 것 방지) 조기 검출된다.
    #   선택 전(첫 pre-select validate)엔 plan-only 폴백, 근거 없음/첨부-전용이면 no-op 통과(no-evidence·골든 불변).
    #   done 게이트(advance-phase.sh)는 최종 백스톱으로 유지(다중 방어). 읽기 전용(state 미기록).
    "$PY" "$HARNESS_ROOT/scripts/lib/check_evidence_reflection.py" "$RDIR" >/dev/null 2>&1 || {
      "$PY" "$HARNESS_ROOT/scripts/lib/check_evidence_reflection.py" "$RDIR" >&2 || true; fail=1; } ;;
esac

if [ "$fail" -ne 0 ]; then
  die "[$PHASE] 검증 실패 — 위 항목을 확인하세요."
fi
ok "[$PHASE] 산출물 검증 통과"
