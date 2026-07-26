#!/usr/bin/env bash
# ingest-bundle.sh — 임의 번들 폴더를 결정적으로 정규화 (설계 §6.0).
#   1) 번들 폴더 → runs/<id>/inputs/bundle/ (폴더명 무관 어댑터, run별 격리 — 동시/순차 다른 run 클로버 방지)
#   2) 자사 자산 seed·동일 도메인 사례를 runs/<id>/inputs/{assets,examples}/ 로 스냅샷(공유 inputs/ 를 이후 직접 안 읽음)
#   3) reviews.csv(BOM+RFC4180) → voc.json · 런-로컬 assets + bundle images → assets-manifest.json
#   4) working-backwards.md(HARNESS_WB 로 run별 지정 가능) → claim-basis.json (fail-closed)
#   5) bundle-report.md 생성 + state 전이(00-ingest 완료). 가공물은 00-ingest/, 원시 입력은 inputs/.
# 사용법: bash scripts/ingest-bundle.sh <번들폴더> [run_id] [--min N]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/common.sh"

BUNDLE_SRC="${1:-}"
RID="${2:-}"
MIN_ASSETS=8
[ "${3:-}" = "--min" ] && MIN_ASSETS="${4:-8}"
[ -n "$BUNDLE_SRC" ] || die "번들 폴더 경로가 필요합니다. 예: bash scripts/ingest-bundle.sh <크롤번들폴더> my-product-2026"
[ -d "$BUNDLE_SRC" ] || die "번들 폴더가 없습니다: $BUNDLE_SRC"
[ -n "$RID" ] || die "run_id 가 필요합니다. 예: bash scripts/ingest-bundle.sh $BUNDLE_SRC my-product-2026"

# run 없으면 생성 — ⓪ 유형 선언 강제(브리프 1단계). cosmetic 자동폴백 제거.
if [ ! -f "$(state_file "$RID")" ]; then
  if [ -z "${HARNESS_DOMAIN:-}" ] || [ -z "${HARNESS_FORMAT:-}" ]; then
    die "⓪ 먼저 유형을 선언하세요: bash scripts/new-run.sh $RID --domain <화장품|의약외품|건기식|의약품> --format <한장|여러장>  (또는 HARNESS_DOMAIN·HARNESS_FORMAT 환경변수로 지정)"
  fi
  # 제품명은 번들 product.json 에서 유래(하드코딩 제거). '[브랜드 …]' 접두가 있으면 브랜드 배너 활성.
  PNAME=""
  [ -f "$BUNDLE_SRC/product.json" ] && PNAME="$("$PY" -c "import json,sys;print((json.load(open(sys.argv[1])).get('name') or '').strip())" "$BUNDLE_SRC/product.json" 2>/dev/null || true)"
  if [ -n "$PNAME" ]; then
    bash "$HARNESS_ROOT/scripts/new-run.sh" "$RID" --name "$PNAME" >/dev/null
  else
    bash "$HARNESS_ROOT/scripts/new-run.sh" "$RID" >/dev/null
  fi
fi
# 재진입 가드(gen-images.sh 선례, run-stage.sh:301 주석 참조): 호출자가 락을 이미 보유(HARNESS_LOCK_HELD)하면
#   재획득하지 않는다 — gate.sh(00a-intake apply-intake→ingest-bundle 연쇄)가 보유 락으로 이 스크립트를 호출할 때
#   무조건 재획득하면 데드락(mkdir "$lock" 실패 → 살아있는 자기 PID 로 die). 미보유(직접 호출)면 정상 획득·해제.
if [ -z "${HARNESS_LOCK_HELD:-}" ]; then acquire_lock "$RID"; export HARNESS_LOCK_HELD=1; fi
# 규제도메인을 ingest.py 서브프로세스에 주입(도메인별 추출 프로파일 선택; cosmetic=모듈 기본값).
HARNESS_DOMAIN="$(resolve_domain "$(state_file "$RID")")"; export HARNESS_DOMAIN   # DRY: common.sh resolve_domain
# 도메인-aware 자산/프로파일 seam(67행 등)이 빈 도메인이면 packs//samples/... 로 조용히 실패한다 →
#   미선언/레거시 state 는 명시 fail-closed(정상 new-run 은 도메인 필수라 도달 불가; 외부리뷰 Low#6).
[ -n "$HARNESS_DOMAIN" ] || die "규제 도메인이 선언되지 않았습니다(state.product.regulatory_domain 없음) — new-run.sh 로 도메인을 선언하세요(fail-closed)."
# M-2: 선언 제품명(state.product.name)을 읽어 claim-basis·voc 추출에 전달 — 다제품 WB 를 그 제품 섹션으로
#   스코핑(타제품 근거·유형 혼입 차단). 스크립트만 state 를 읽는다(AGENTS 절대규칙 1). 비었으면(레거시) 폴백.
DECL_NAME="$(jget "$(state_file "$RID")" product.name 2>/dev/null || true)"
[ "$DECL_NAME" = "null" ] && DECL_NAME=""
# new-run.sh 기본 placeholder('제품')는 '미선언'이지만, `new-run --domain --format`(이름 미지정)을 먼저 돌린 뒤
#   ingest 하는 흔한 경로에서는 state 가 이미 존재해 위 번들-이름 주입(20~32행)이 스킵된다. 이때 번들 product.json
#   에 실제 이름이 있으면 그걸로 폴백해야 다제품 스코핑이 동작한다(외부리뷰 R12 P1: 그냥 블랭크하면 오염 잔존).
#   번들에도 이름이 없으면(또 placeholder) 블랭크 → fail-open 전체-WB(외부리뷰 R6 P2: '## 제품 개요' 오매칭 방지).
if [ "$DECL_NAME" = "제품" ]; then
  DECL_NAME=""
  [ -f "${BUNDLE_SRC:-}/product.json" ] && DECL_NAME="$("$PY" -c "import json,sys;print((json.load(open(sys.argv[1])).get('name') or '').strip())" "$BUNDLE_SRC/product.json" 2>/dev/null || true)"
  [ "$DECL_NAME" = "제품" ] && DECL_NAME=""
fi

OUT="$(run_dir "$RID")/00-ingest"
mkdir -p "$OUT"
# N10: write-ahead 미완 표식(producer) — 어떤 run-input 변경(번들·자산·사례·4종 regen·근거 스냅샷)보다 '먼저'
#   원자적으로 남긴다. 터미널 상태-기록(status=passed+artifacts)·report·history 가 다 성공한 '뒤에만'(advance 직전)
#   제거한다. 어느 창에서 중단돼도 표식이 남아 하류(run-stage/validate/advance/…)가 fail-closed → 재-인입(멱등
#   exact-replacement 가 치유) 강제. 완료 런엔 부재 → 골든/baseline 불변. 경로/문구는 common.sh 가 단일 소유(pin).
#   `: >` = 존재-표식의 원자적 생성(consumer 는 -f 존재만 확인). 재실행 시 스테일 표식을 덮어씀(멱등).
: > "$(run_dir "$RID")/$INGEST_SENTINEL_REL"
# 경로 계약: 모든 원시 입력은 runs/<id>/inputs/ 아래로 모은다(00-ingest 는 가공물만).
#   번들(크롤 원본)은 run별 격리 + inputs/bundle 로 정규화 — render/validate 가 runs/<id>/inputs/bundle/product.json 을
#   읽고, common.sh guideline 폴백도 runs/<id>/inputs/bundle 를 본다(과도기 결함 봉합).
BUNDLE_DST="$(run_dir "$RID")/inputs/bundle"
# 자사 자산 seed·워킹백워드·사례는 읽기전용 공유 소스. 봇/멀티제품용으로 env 오버라이드 가능(기본=전역 seed).
#   ingest 가 이들을 run 안으로 스냅샷하고, 이후 단계는 공유 inputs/ 를 직접 읽지 않는다(런-로컬 진실).
ASSETS_DIR="${HARNESS_ASSETS_DIR:-$PACKS_DIR/$HARNESS_DOMAIN/samples/assets}"
ASSETS_RUN="$(run_dir "$RID")/inputs/assets"
WB="${HARNESS_WB:-$PACKS_DIR/cosmetic/samples/working-backwards.md}"
# WB(가변 1:1 입력)는 bundle 과 동일하게 run 안으로 격리한다 — run별 사본을 진실로 읽어
#   동시/순차 다른 run 이 같은 공유 WB 를 라이브 재독하는 클로버를 막고, provenance 도 run 사본을 가리키게 한다.
WB_RUN="$(run_dir "$RID")/inputs/working-backwards.md"
mkdir -p "$BUNDLE_DST" "$ASSETS_RUN" "$(run_dir "$RID")/inputs/examples"   # 자산 seed($ASSETS_DIR)는 mkdir 안 함 — 도메인-aware 후 미시드 도메인(TBD) 런이 packs/<도메인>/samples/assets 를 생성(런→팩 변조) 방지. seed 부재는 아래 `[ -d $ASSETS_DIR ]` 가드가 처리(빈 자산=도형 폴백).

# 1) 정규화 복사 (폴더명 무관). product.json/reviews.csv/images 만 수용.
info "번들 정규화: $(basename "$BUNDLE_SRC") → ${BUNDLE_DST#"$HARNESS_ROOT"/} (run별 격리)"
for f in product.json reviews.csv; do
  [ -f "$BUNDLE_SRC/$f" ] && cp -f "$BUNDLE_SRC/$f" "$BUNDLE_DST/$f"
done
if [ -d "$BUNDLE_SRC/images" ]; then
  rm -rf "$BUNDLE_DST/images"; mkdir -p "$BUNDLE_DST/images"
  cp -R "$BUNDLE_SRC/images/." "$BUNDLE_DST/images/"
fi
# 잡파일 정리(.DS_Store)
find "$BUNDLE_DST" -name '.DS_Store' -delete 2>/dev/null || true

# 2) 자사 자산·사례 스냅샷 — 공유 소스를 run 안으로 복사(cp -R, 멱등: 대상 있으면 갱신).
#   assets: 공유 seed → runs/<id>/inputs/assets/ (매니페스트 own_files=런 상대 inputs/assets/<fn>).
if [ -d "$ASSETS_DIR" ]; then
  cp -R "$ASSETS_DIR/." "$ASSETS_RUN/"
  # 자사 seed = 루트 제품컷·로고만. 공유 inputs/assets/generated/ 는 리팩터 전 생성이미지의 '폐기된 위치'
  #   (진실은 이제 런-로컬 04-keyvisual/generated/) → 런 스냅샷에 딸려오지 않게 제외한다:
  #   ① 런당 수백 장 stale 복사(bloat) 방지 ② 폐기 위치를 런 안에 부활시켜 구경로 stale 참조가
  #   존재검사를 거짓 통과(fail-closed 무력화)하는 것 차단.
  rm -rf "$ASSETS_RUN/generated"
  find "$ASSETS_RUN" -name '.DS_Store' -delete 2>/dev/null || true
fi
# examples: 동일 도메인 사례 → runs/<id>/inputs/examples/<도메인>/ (있을 때만). guideline_example_dirs 가 런-로컬 우선 조회.
EXAMPLES_SRC="${HARNESS_EXAMPLES_DIR:-$PACKS_DIR/cosmetic/samples/examples}/$HARNESS_DOMAIN"
EXAMPLES_RUN="$(run_dir "$RID")/inputs/examples/$HARNESS_DOMAIN"
if [ -d "$EXAMPLES_SRC" ] && [ -n "$(find "$EXAMPLES_SRC" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]; then
  mkdir -p "$EXAMPLES_RUN"
  cp -R "$EXAMPLES_SRC/." "$EXAMPLES_RUN/"
  find "$EXAMPLES_RUN" -name '.DS_Store' -delete 2>/dev/null || true
fi

REVIEWS="$BUNDLE_DST/reviews.csv"
PRODUCT="$BUNDLE_DST/product.json"
[ -f "$REVIEWS" ] || die "reviews.csv 를 번들에서 찾지 못했습니다."
# 워킹백워드 fail-closed(멱등-skip 보다 앞): 누락/빈 파일이면 all-unknown claim-basis 로 조용히 통과하지 않게 하드중단.
[ -s "$WB" ] || die "워킹백워드 누락/빈 파일: ${WB#"$HARNESS_ROOT"/} — claim-basis 추출 불가. 파일을 두거나 HARNESS_WB 로 지정하세요."

# 재개(idempotent): 산출물이 이미 있고 검증 통과면 재생성 생략
regen=1
if [ -f "$OUT/voc.json" ] && [ -f "$OUT/claim-basis.json" ] && [ -f "$OUT/assets-manifest.json" ] && [ -f "$OUT/best-practices.json" ]; then
  if validate_artifact "$OUT/voc.json" >/dev/null 2>&1 \
     && validate_artifact "$OUT/claim-basis.json" >/dev/null 2>&1 \
     && validate_artifact "$OUT/assets-manifest.json" >/dev/null 2>&1 \
     && validate_artifact "$OUT/best-practices.json" >/dev/null 2>&1; then
    regen=0
    info "이미 인입·검증된 산출물 존재 — 재생성 생략(idempotent)."
  fi
fi

if [ "$regen" -eq 1 ]; then
  # WB 를 run 사본으로 먼저 격리한 뒤, voc(product_facts)·claim-basis 가 둘 다 같은 run 사본에서
  # 추출하도록 한다(provenance=run 사본 일치 + 공유 WB 변동 시 두 산출물 WB 불일치 차단).
  # HARNESS_WB 가 이미 run 사본을 가리키면 자기복사 생략.
  [ "$WB" -ef "$WB_RUN" ] || cp -f "$WB" "$WB_RUN"
  "$PY" "$INGEST_LIB" voc "$REVIEWS" "$PRODUCT" "$(basename "$BUNDLE_SRC")" "$OUT/voc.json" "$WB_RUN" "$DECL_NAME"
  "$PY" "$INGEST_LIB" assets "$BUNDLE_DST/images" "$ASSETS_RUN" "$OUT/assets-manifest.json" --min "$MIN_ASSETS"
  "$PY" "$INGEST_LIB" claim-basis "$WB_RUN" "$OUT/claim-basis.json" "$DECL_NAME"
  # 크롤 베스트프랙티스 텍스트 분석(no-pixel) — tone substage 의 #4 종합 입력
  "$PY" "$INGEST_LIB" best-practices "$BUNDLE_DST/images" "$OUT/best-practices.json"
fi

# 검증 (4종 모두)
validate_artifact "$OUT/voc.json"
validate_artifact "$OUT/claim-basis.json"
validate_artifact "$OUT/assets-manifest.json"
validate_artifact "$OUT/best-practices.json"

# 링크 A + 링크 B: 근거 문서 첨부(첨부 전송 ≠ 실증). regen-skip 과 '독립'으로 매 인입마다 재평가(F7) —
#   claim-basis(위에서 검증 완료) 이후라 F5 대조 데이터가 준비돼 있다. 소스 우선순위: HARNESS_EVIDENCE_DIR →
#   <bundle>/evidence/ → 없음. 소스가 없거나 유효 문서 0건이면 ingest.py 가 stale inputs/evidence·매니페스트를
#   '정리'(exact-replacement 의 0건 경로)한다 → 상태 append/prune(아래)은 매니페스트 존재로 분기(N1). 실패=fail-closed
#   (set -e → 스크립트 중단, 표식 미제거 → 재-인입 강제).
if [ -n "${HARNESS_EVIDENCE_DIR:-}" ]; then
  # 사람이 근거 자료 폴더를 직접 지정한 경우. 그 경로가 없거나 폴더가 아니면 '근거 없음'으로 조용히 넘기면
  #   붙인 근거가 소리 없이 사라진다(선언 조용한 소실) → 오타·경로착오는 정리로 흘리지 않고 즉시 멈춘다.
  #   (실제 정리/스냅샷 이전에 걸리므로 기존 스냅샷·매니페스트는 손대지 않는다. 빈 폴더는 정당한 '근거 없음'이라 통과.)
  [ -d "$HARNESS_EVIDENCE_DIR" ] || die "근거 자료 폴더로 지정한 경로가 없거나 폴더가 아닙니다: $HARNESS_EVIDENCE_DIR — 경로를 다시 확인하세요(빈 근거로 넘어가지 않고 멈춥니다)."
  EVIDENCE_SRC="$HARNESS_EVIDENCE_DIR"; EVIDENCE_CHANNEL="HARNESS_EVIDENCE_DIR"
else
  # 번들 채널: 근거는 '원본' 번들의 evidence/ 에 동봉된다(정규화 복사는 product.json·reviews.csv·images 만
  #   가져오므로 $BUNDLE_DST 엔 없다). ingest.py 가 여기서 runs/<id>/inputs/evidence/ 로 스냅샷한다. 부재면 정리.
  EVIDENCE_SRC="$BUNDLE_SRC/evidence"; EVIDENCE_CHANNEL="bundle"
fi
"$PY" "$INGEST_LIB" evidence-docs "$RID" --src "$EVIDENCE_SRC" --channel "$EVIDENCE_CHANNEL"

# claim-basis 의 functional_status / evidence_on_file 를 state 에 반영 (scripts 만 state 쓴다)
"$PY" - "$(state_file "$RID")" "$OUT/claim-basis.json" "$OUT/evidence-documents.json" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json, atomic_write_json, now_iso
sf, cb_path, ev_manifest = sys.argv[1], sys.argv[2], sys.argv[3]
st = load_json(sf); cb = load_json(cb_path)
st["product"]["functional_status"] = {k: v["status"] for k, v in cb["functional_status"].items()}
st["product"]["evidence_on_file"] = [e["id"] for e in cb["evidence_on_file"]]
arts = ["00-ingest/voc.json", "00-ingest/claim-basis.json", "00-ingest/assets-manifest.json", "00-ingest/best-practices.json", "00-ingest/bundle-report.md"]
for a in arts:
    if a not in st["artifacts"]:
        st["artifacts"].append(a)
# N1: 근거 매니페스트는 '존재 시에만' artifacts 에 추가, '부재 시 제거(prune)' — 같은 원자 상태-기록 안에서.
#   근거 없는 런은 이 항목이 안 붙고(부재+prune=no-op) → state.artifacts 가 기존 5종과 byte-동일(골든 불변).
EV_ART = "00-ingest/evidence-documents.json"
if os.path.exists(ev_manifest):
    if EV_ART not in st["artifacts"]:
        st["artifacts"].append(EV_ART)
elif EV_ART in st["artifacts"]:
    st["artifacts"] = [a for a in st["artifacts"] if a != EV_ART]
st["phase"] = "00-ingest"; st["step"] = "generate"; st["gate"] = None
st["status"] = "passed"; st["awaiting"] = "none"
st["history"].append({"ts": now_iso(), "phase": "00-ingest", "event": "ingest:ok", "by": "ingest-bundle.sh"})
st["updated_at"] = now_iso()
atomic_write_json(sf, st)
PYEOF

# bundle-report.md 생성
"$PY" - "$OUT" "$REVIEWS" "$PRODUCT" "$(basename "$BUNDLE_SRC")" <<'PYEOF'
import sys, os, json
sys.path.insert(0, os.path.join(os.environ["HARNESS_ROOT"], "scripts", "lib"))
from harness import load_json
out, reviews, product, bundle = sys.argv[1:5]
voc = load_json(os.path.join(out, "voc.json"))
cb = load_json(os.path.join(out, "claim-basis.json"))
am = load_json(os.path.join(out, "assets-manifest.json"))
kf = voc["keyword_frequency"]; ps = voc["persona_signals"]
lines = []
lines.append("# 번들 인입 리포트 — %s\n" % bundle)
lines.append("> 모든 정량의 단일 출처는 `voc.json`. 본문 수치 하드코딩 금지.\n")
lines.append("## 리뷰 VOC (RFC4180 파서, BOM 제거)\n")
lines.append("- 수집 리뷰: %s건 / 사이트 표시 총 %s건\n" % (voc["review_count"]["collected"], voc["review_count"]["site_total"]))
lines.append("- 평점 분포: %s\n" % voc["rating_distribution"])
lines.append("- 옵션 분포: %s\n" % voc["option_distribution"])
lines.append("- 키워드 빈도: %s\n" % ", ".join("%s %d" % (k, v) for k, v in kf.items()))
lines.append("- 페르소나 신호(가설): %s\n" % ", ".join("%s %d" % (k, v) for k, v in ps.items()))
zero = [k for k, v in kf.items() if v == 0]
lines.append("\n## 함의 (환각 방지)\n")
lines.append("- 소비자 효능 언어 상위: %s → 감성 헤드라인 = 소비자 언어.\n" % ", ".join("%s(%d)" % (k, kf[k]) for k in sorted(kf, key=lambda x: -kf[x])[:4]))
lines.append("- 리뷰 0건 개념: %s → **컨셉 주축 금지**(소비자 수요 근거 없음).\n" % (", ".join(zero) or "없음"))
lines.append("\n## claim-basis (워킹백워드 추출, fail-closed)\n")
for k, v in cb["functional_status"].items():
    lines.append("- 기능성 %s: **%s**%s\n" % (k, v["status"], (" (근거 %s)" % v["evidence_ref"]) if v["evidence_ref"] else ""))
lines.append("- 보유 실증: %d건\n" % len(cb["evidence_on_file"]))
lines.append("- 주장 불가(unsupported): %s\n" % (", ".join(cb["unsupported_claims"]) or "없음"))
lines.append("\n## 이미지 자산\n")
lines.append("- 자사 자산(inputs/assets): %d장 (디자인 데모 최소 %d장, 충분=%s)\n" % (am["own_assets"]["count"], am["own_assets"]["min_required"], am["own_assets"]["sufficient"]))
lines.append("- 번들 detail %d장(gif %d)·main %d장 — 크롤 원본은 디자인 src 금지(레퍼런스 전용)\n" % (am["bundle_images"]["detail"]["count"], am["bundle_images"]["detail"]["gif"], am["bundle_images"]["main"]["count"]))
with open(os.path.join(out, "bundle-report.md"), "w", encoding="utf-8") as f:
    f.write("".join(lines))
print("[report] %s/bundle-report.md" % out)
PYEOF

append_history "$(state_file "$RID")" "00-ingest" "report:ok" "ingest-bundle.sh" 2>/dev/null || true
# 인입 후 다음 페이즈 = 두 조건부 페이즈(00e-evidence·00g-guideline)의 단일 라우터(common.sh compute_next_conditional).
#   순서 00e→00g→01-brief: (a) 문서만 첨부(pending 참조 문서)면 00e-evidence(반영 내용 제안·승인),
#   (b) 없고 동일 도메인 사례 스냅샷이 있으면 00g-guideline, (c) 둘 다 없으면 01-brief.
#   00g 술어(examples+active_phases)는 종전과 동일(no-evidence 라우팅 바이트 불변) — 라우터가 그 로직을 흡수했다.
NEXT_PHASE="$(compute_next_conditional "$RID" 00-ingest)"
# N10: 인입 완주(터미널 상태-기록 + bundle-report + history 모두 성공) — advance '직전'에 미완 표식 제거.
#   이 지점 이전 어느 창에서 중단돼도 표식이 남아 하류 fail-closed·재-인입 강제. 성공 런엔 부재(골든 불변).
#   advance-phase 자체가 assert_ingest_complete 를 도므로 반드시 그 호출 '전'에 지운다. 생성/regen-skip 양 경로가
#   이 지점을 지나므로(위 상태-기록·report·routing 은 regen 여부와 무관) 전체 본문이 표식으로 브래킷된다.
rm -f "$(run_dir "$RID")/$INGEST_SENTINEL_REL"
bash "$HARNESS_ROOT/scripts/advance-phase.sh" "$RID" --to "$NEXT_PHASE" >/dev/null
ok "인입 완료: $RID"
case "$NEXT_PHASE" in
  00e-evidence)  info "다음: bash scripts/run-stage.sh evidence $RID  (첨부한 참고 문서에서 반영할 내용 제안 → 승인)" ;;
  00g-guideline) info "다음: bash scripts/run-stage.sh guideline $RID  (inputs/examples 사례 분석 → 프로젝트 가이드라인)" ;;
  *)             info "다음: bash scripts/run-stage.sh brief $RID" ;;
esac
