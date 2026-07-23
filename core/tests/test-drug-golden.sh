#!/usr/bin/env bash
# test-drug-golden.sh — 의약품(drug) 회귀 안전망 (test-first).
#   목적: 누수 제거(단계2 — consumer_deception severity 하드코딩→lexicon · _mi_sig→ruleset signals · subst_ref 폴백)
#         전에 **의약품 심의 검출을 동결**한다. 단계2 이후 이 테스트로 의약품 회귀를 측정한다.
#   3축 검증: (A) scan_text 축(golden_runner) · (B) 필수기재 evaluate(누수#3) · (C) 전문/일반 하드스톱.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## DRUG-GOLDEN — 의약품 5축 + 필수기재 + 전문/일반 하드스톱 회귀(단계2-pre)"

# ── (A) scan_text 축 검출 골든 (golden_runner; drug_misperception·consumer_deception·substantiation_required) ──
#   누수#1(consumer_deception severity 하드코딩)이 검출/severity 를 바꾸면 여기서 잡힌다(golden_runner 는 axis + severity≥기대 검사).
#   (주의) 누수#4(subst_ref)는 _vio() 가 ref 를 출력에 안 넣어 verdict 로는 관측 불가 → (D)에서 Engine.subst_ref attribute 로 직접 동결(코덱스 단계2-pre High).
GR="$(python3 "$ROOT/scripts/lib/golden_runner.py" "$PACKS_DIR/drug/golden/kcia-golden-set.json" --json 2>/dev/null)"
check "(A) drug 골든셋 게이트 통과(검출≥0.8·오탐≤0.15·balance·라벨품질)" \
  "echo '$GR' | python3 -c 'import sys,json;sys.exit(0 if json.load(sys.stdin)[\"gate_pass\"] else 1)'"
DET="$(echo "$GR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["detection_rate"])')"
FP="$(echo "$GR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["false_positive_rate"])')"
check "(A) drug scan_text 검출률 1.0(실측 $DET)" "[ \"$DET\" = '1.0' ]"
check "(A) drug 오탐률 0.0(준법 카피 false-fail 0, 실측 $FP)" "[ \"$FP\" = '0.0' ]"

# ── (B)+(C) evaluate 레벨(필수기재·하드스톱) — 최소 drug 04-keyvisual run 구성 후 kcia_engine.evaluate 직접 호출 ──
RES=/tmp/drug-golden-eval.$$.txt
python3 - "$ROOT" > "$RES" <<'PY'
import sys, os, json
ROOT = sys.argv[1]
sys.path.insert(0, os.path.join(ROOT, "scripts", "lib"))
from kcia_engine import evaluate, load_ruleset, Engine

def mkrun(rid, page_html, prod_extra=None, css=None):
    rdir = os.path.join(ROOT, "runs", rid)
    od = os.path.join(rdir, "04-keyvisual", "options", "A")
    os.makedirs(od, exist_ok=True)
    os.makedirs(os.path.join(rdir, "00-ingest"), exist_ok=True)
    prod = {"regulatory_domain": "drug", "deliverable_format": "multipage_bm", "name": "우루사정"}
    if prod_extra:
        prod.update(prod_extra)
    json.dump({"phase": "04-keyvisual", "product": prod}, open(os.path.join(rdir, "state.json"), "w"), ensure_ascii=False)
    json.dump({"functional_status": {}, "evidence_on_file": [], "notified_ingredients": [],
               "certifications": [], "product_type": "drug", "unsupported_claims": [], "source": "drug-golden"},
              open(os.path.join(rdir, "00-ingest", "claim-basis.json"), "w"), ensure_ascii=False)
    json.dump({"selected": "A"}, open(os.path.join(rdir, "04-keyvisual", "decision.json"), "w"), ensure_ascii=False)
    open(os.path.join(od, "index.html"), "w", encoding="utf-8").write(page_html)
    if css is not None:
        open(os.path.join(od, "styles.css"), "w", encoding="utf-8").write(css)
    return rdir

def name_flagged(rid, html, name=None, css=None):
    extra = {"name": name} if name else None
    v = evaluate(rid, mkrun(rid, html, extra, css), None, "drug-golden")
    return int(any(x.get("axis") == "mandatory_inclusion" and "제품명" in x.get("rule", "") for x in v.get("violations", [])))

def mi_rules(v):
    return [x.get("rule", "") for x in v.get("violations", []) if x.get("axis") == "mandatory_inclusion"]

# (B) 필수기재: 누락 페이지(의약품 효능만) → MI 위반 / 완비 페이지 → 0
v_miss = evaluate("drug-mi-miss", mkrun("drug-mi-miss", "<html><body><h1>우루사</h1><p>간기능 개선을 돕습니다</p></body></html>"), None, "drug-golden")
miss = mi_rules(v_miss)
print("MI_MISS_COUNT=%d" % len(miss))
print("MI_MISS_CONSUMER_CAUTION=%d" % int(any("주의문구" in r for r in miss)))
print("MI_MISS_REVIEW_MARK=%d" % int(any("광고심의필" in r for r in miss)))
print("MI_MISS_COMPANY=%d" % int(any("회사명" in r for r in miss)))
print("MI_MISS_SNS=%d" % int(any("경제적 이해관계" in r for r in miss)))
# 누수#3 표지: product-name-full(정확한 제품명)은 현재 _mi_sig 미수록 → 미검출. 단계2(signals 외부화)가 검출하게 만든다.
print("MI_MISS_PRODUCT_NAME=%d" % int(any("제품명" in r for r in miss)))

page_ok = ("<html><body><h1>우루사정</h1><p>간기능 개선. 부작용이 있을 수 있으니 첨부된 사용상의 주의사항을 "
           "잘 읽고 의사·약사와 상의하십시오.</p><footer>광고심의필 : 1234-5678-901234 | 제조판매원 대웅제약 | "
           "[광고] 원고료를 지급받아 작성한 경제적 이해관계 표시</footer></body></html>")
v_ok = evaluate("drug-mi-ok", mkrun("drug-mi-ok", page_ok), None, "drug-golden")
print("MI_OK_COUNT=%d" % len(mi_rules(v_ok)))

# (B·fail-closed) 제품명이 일반 플레이스홀더('제품', new-run 기본)면 — 다른 4항목 다 있어도 '정확한 제품명' 미충족(false-negative 차단).
#   page_generic 은 4항목 신호 + generic '제품' 단어를 담지만 정확 제품명은 없음. name='제품'(일반) → product-name-full flag 만 떠야 함.
page_generic = ("<html><body><h1>우리 제품</h1><p>부작용이 있을 수 있으니 첨부된 사용상의 주의사항을 잘 읽고 의사·약사와 "
                "상의하십시오.</p><footer>광고심의필 : 1234-5678-901234 | 제조판매원 대웅제약 | "
                "[광고] 원고료 경제적 이해관계 표시</footer></body></html>")
v_gen = evaluate("drug-mi-generic", mkrun("drug-mi-generic", page_generic, {"name": "제품"}), None, "drug-golden")
gen_mi = mi_rules(v_gen)
print("MI_GENERIC_NAME_FLAGGED=%d" % int(any("제품명" in r for r in gen_mi)))
print("MI_GENERIC_OTHER_OK=%d" % int(sum(1 for r in gen_mi if "제품명" not in r) == 0))

# (B·코덱스 단계2 R2 High/Medium) 정확 제품명 매칭의 경계성 — 다른 4항목 공통 푸터(_REST) 위에 제품명 영역만 변형.
_REST = ("<p>부작용이 있을 수 있으니 첨부된 사용상의 주의사항을 잘 읽고 의사·약사와 상의하십시오.</p>"
         "<footer>광고심의필 : 1234-5678-901234 | 제조판매원 대웅제약 | [광고] 원고료 경제적 이해관계 표시</footer>")
# High(부분문자열 fail-open): 면허명 '우루사정'이 더 긴 토큰 '우루사정플러스'에만 있음 → 독립 노출 아님 → product-name-full flag.
page_substr = "<html><body><h1>우루사정플러스</h1>" + _REST + "</body></html>"
sub_mi = mi_rules(evaluate("drug-mi-substr", mkrun("drug-mi-substr", page_substr), None, "drug-golden"))
print("MI_SUBSTR_NAME_FLAGGED=%d" % int(any("제품명" in r for r in sub_mi)))
# Medium(마크업/공백 분할 fail-positive): '우루사<span>정</span>' → 충실렌더 '우루사정'(인라인 연결) → 충족(필수기재 0).
page_split = "<html><body><h1>우루사<span>정</span></h1>" + _REST + "</body></html>"
split_mi = mi_rules(evaluate("drug-mi-split", mkrun("drug-mi-split", page_split), None, "drug-golden"))
print("MI_SPLIT_NAME_OK=%d" % int(not any("제품명" in r for r in split_mi)))
print("MI_SPLIT_TOTAL=%d" % len(split_mi))

# (B·코덱스 단계2 3R High) 충실 렌더 경계 — gather 일괄 공백결합 fail-open 차단(노드/ZWJ/전각으로 경계 split).
#   prefix split: '<h1>신<span>우루사정</span></h1>' → 충실렌더 '신우루사정'(인라인 연결) → 면허명 '우루사정' 묻힘 → flag.
page_pre = "<html><body><h1>신<span>우루사정</span></h1>" + _REST + "</body></html>"
pre_mi = mi_rules(evaluate("drug-mi-pre", mkrun("drug-mi-pre", page_pre), None, "drug-golden"))
print("MI_R3_PREFIX_FLAGGED=%d" % int(any("제품명" in r for r in pre_mi)))
#   suffix 노드 split: '<span>우루사정</span><span>플러스</span>' → '우루사정플러스'(글루) → flag(실 노출 토큰이 더 긴 제품).
page_suf = "<html><body><h1><span>우루사정</span><span>플러스</span></h1>" + _REST + "</body></html>"
suf_mi = mi_rules(evaluate("drug-mi-suf", mkrun("drug-mi-suf", page_suf), None, "drug-golden"))
print("MI_R3_SUFFIX_FLAGGED=%d" % int(any("제품명" in r for r in suf_mi)))
#   zero-width(ZWJ U+200D) 우회: '우루사정[ZWJ]플러스' → 비가시 제거 → '우루사정플러스' → flag.
page_zwj = "<html><body><h1>우루사정\u200d플러스</h1>" + _REST + "</body></html>"
zwj_mi = mi_rules(evaluate("drug-mi-zwj", mkrun("drug-mi-zwj", page_zwj), None, "drug-golden"))
print("MI_R3_ZWJ_FLAGGED=%d" % int(any("제품명" in r for r in zwj_mi)))
#   전각 우회: name 'EZdew', 페이지 전각 'ＥＺｄｅｗＰｌｕｓ' → NFKC 'EZdewPlus' → 묻힘 → flag.
page_fw = "<html><body><h1>ＥＺｄｅｗＰｌｕｓ</h1>" + _REST + "</body></html>"
fw_mi = mi_rules(evaluate("drug-mi-fw", mkrun("drug-mi-fw", page_fw, {"name": "EZdew"}), None, "drug-golden"))
print("MI_R3_FULLWIDTH_FLAGGED=%d" % int(any("제품명" in r for r in fw_mi)))
#   전각 정상: name 'EZdew', 페이지 전각 'ＥＺｄｅｗ' 단독 → NFKC 'EZdew' → 충족(flag 없음, false-positive 아님).
page_fwok = "<html><body><h1>ＥＺｄｅｗ</h1>" + _REST + "</body></html>"
fwok_mi = mi_rules(evaluate("drug-mi-fwok", mkrun("drug-mi-fwok", page_fwok, {"name": "EZdew"}), None, "drug-golden"))
print("MI_R3_FULLWIDTH_OK=%d" % int(not any("제품명" in r for r in fwok_mi)))

# (B·코덱스 단계2 4R High) 더 깊은 fail-open — CSS 생성콘텐츠 글루 / 비가시 카테고리 / 비라틴 경계.
H = "<html><head><style>%s</style></head><body><h1%s>우루사정</h1>" + _REST + "</body></html>"
#   High1: CSS ::after/::before 단어콘텐츠·attr() → 화면상 더 긴 토큰('우루사정플러스') → 정적검증 불가 fail-closed flag.
print("MI_R4_CSS_AFTER=%d"  % name_flagged("drug-mi-css-a", H % ('h1::after{content:"플러스"}', "")))
print("MI_R4_CSS_BEFORE=%d" % name_flagged("drug-mi-css-b", H % ('h1::before{content:"신"}', "")))
print("MI_R4_CSS_ATTR=%d"   % name_flagged("drug-mi-css-attr", H % ('h1::after{content:attr(data-x)}', ' data-x="플러스"')))
print("MI_R4_CSS_EXTCSS=%d" % name_flagged("drug-mi-css-ext", "<html><body><h1>우루사정</h1>" + _REST + "</body></html>", css='h1::after{content:"플러스"}'))
#   정상(false-positive 아님): ::after 기호/아이콘 content('›')는 단어경계라 무위험 → 충족(flag 없음).
print("MI_R4_CSS_SYMBOL_OK=%d" % (1 - name_flagged("drug-mi-css-sym", H % ('h1::after{content:"›"}', ""))))
#   High2: 비가시 카테고리(CGJ U+034F · ALM U+061C · Mongol-sep U+180E · variation selector U+FE0F·U+E0100) → 제거 → '우루사정플러스' → flag.
for tag, ch in [("CGJ", "\u034f"), ("ALM", "\u061c"), ("MVS", "\u180e"), ("VS16", "\ufe0f"), ("VS17", "\U000e0100")]:
    pg = "<html><body><h1>우루사정" + ch + "플러스</h1>" + _REST + "</body></html>"
    print("MI_R4_INVIS_%s=%d" % (tag, name_flagged("drug-mi-invis-" + tag, pg)))
#   High3: 비라틴 suffix(CJK '丸' · Greek 'α')도 토큰 연속 → 더 긴 제품 → flag.
print("MI_R4_CJK_SUFFIX=%d"   % name_flagged("drug-mi-cjk", "<html><body><h1>우루사정丸</h1>" + _REST + "</body></html>"))
print("MI_R4_GREEK_SUFFIX=%d" % name_flagged("drug-mi-grk", "<html><body><h1>EZdewα</h1>" + _REST + "</body></html>", name="EZdew"))

# (B·코덱스 단계2 5R) CSS 글루 default-deny(추가 텍스트생성 경로) · 블록횡단 합성 차단 · decode 크래시.
#   High1: var()/open-quote/counters()/따옴표안 ';'/env() 등 무한한 CSS 텍스트생성 → 열거 대신 default-deny(무해 아니면 글루 위험 flag).
for tag, css in [("VAR", 'h1::after{content:var(--x)}'), ("OPENQUOTE", 'h1::before{content:open-quote}'),
                 ("COUNTERS", 'h1::after{content:counters(c,".")}'), ("SEMICOLON", 'h1::after{content:"플;러스"}'),
                 ("ENV", 'h1::after{content:env(x)}')]:
    print("MI_R5_GLUE_%s=%d" % (tag, name_flagged("drug-mi-glue-" + tag, "<html><body><h1>우루사정</h1>" + _REST + "</body></html>", css=css)))
#   정상(false-positive 아님): none/PUA 아이콘 content 는 무해 → 충족(flag 없음).
print("MI_R5_GLUE_NONE_OK=%d" % (1 - name_flagged("drug-mi-glue-none", "<html><body><h1>우루사정</h1>" + _REST + "</body></html>", css='h1::after{content:none}')))
print("MI_R5_GLUE_PUA_OK=%d"  % (1 - name_flagged("drug-mi-glue-pua", "<html><body><h1>우루사정</h1>" + _REST + "</body></html>", css='h1::after{content:"\\f001"}')))
#   High2: 블록횡단 글자 합성 차단 — '<h1>우</h1><section>루</section><p>사</p><footer>정</footer>'는 '우\n루\n사\n정' → 불일치 → flag.
print("MI_R5_BLOCK_SCATTER=%d" % name_flagged("drug-mi-scatter", "<html><body><h1>우</h1><section>루</section><p>사</p><footer>정</footer>" + _REST + "</body></html>"))
#   정상: 같은 블록 내 소스 letter-spacing('우 루 사 정')은 충족(false-positive 아님).
print("MI_R5_LETTERSPACE_OK=%d" % (1 - name_flagged("drug-mi-lsp", "<html><body><h1>우 루 사 정</h1>" + _REST + "</body></html>")))
#   Medium: CSS escape 범위초과(\\110000)에도 엔진 안 죽음(verdict 생성 완료) — 위반 리스트가 list 면 통과.
print("MI_R5_DECODE_NOCRASH=%d" % int(isinstance(evaluate("drug-mi-decode", mkrun("drug-mi-decode", '<html><head><style>h1::after{content:"\\110000"}</style></head><body><h1>우루사정</h1>' + _REST + "</body></html>"), None, "drug-golden").get("violations"), list)))

# (B·코덱스 단계2 6R High1) 가시 노출만 인정 — 숨김/비렌더 DOM(title/template/hidden/display:none/aria-hidden/noscript)으로 충족되던 fail-open 차단.
#   필수기재는 '가시 노출' 기준. 제품명이 본문에 안 보이고 비렌더 영역에만 있으면 누락 flag.
_BODY_NONAME = "<body><h2>제품 소개</h2>" + _REST + "</body></html>"
print("MI_R6_HIDDEN_TITLE=%d"   % name_flagged("drug-mi-h-title", "<html><head><title>우루사정</title></head>" + _BODY_NONAME))
print("MI_R6_HIDDEN_TEMPLATE=%d"% name_flagged("drug-mi-h-tmpl", "<html><body><template><h1>우루사정</h1></template><h2>제품 소개</h2>" + _REST + "</body></html>"))
print("MI_R6_HIDDEN_ATTR=%d"    % name_flagged("drug-mi-h-hid", "<html><body><h1 hidden>우루사정</h1>" + _BODY_NONAME[6:]))
print("MI_R6_HIDDEN_DISPNONE=%d"% name_flagged("drug-mi-h-dn", '<html><body><h1 style="display:none">우루사정</h1>' + _BODY_NONAME[6:]))
print("MI_R6_HIDDEN_ARIA=%d"    % name_flagged("drug-mi-h-aria", '<html><body><h1 aria-hidden="true">우루사정</h1>' + _BODY_NONAME[6:]))
print("MI_R6_HIDDEN_NOSCRIPT=%d"% name_flagged("drug-mi-h-ns", "<html><body><noscript>우루사정</noscript>" + _BODY_NONAME[6:]))
#   정상(false-positive 아님): title+body 둘 다 노출 / 숨김 형제 무관 / 이름 내부 숨김 span 제거 후 연결 → 충족.
print("MI_R6_VISIBLE_OK=%d"     % (1 - name_flagged("drug-mi-v-ok", "<html><head><title>우루사정</title></head><body><h1>우루사정</h1>" + _REST + "</body></html>")))
print("MI_R6_HIDDEN_SIBLING_OK=%d" % (1 - name_flagged("drug-mi-v-sib", "<html><body><h1>우루사정</h1><div hidden>플러스</div>" + _REST + "</body></html>")))
print("MI_R6_INNER_HIDDEN_OK=%d"   % (1 - name_flagged("drug-mi-v-inhid", "<html><body><h1>우루사<span hidden>XXX</span>정</h1>" + _REST + "</body></html>")))

# (B·코덱스 단계2 7R Medium 일부) 인라인 판정 가능한 추가 비노출(datalist · open 없는 dialog/details · visibility:collapse · opacity:0).
#   (computed-CSS/class 의존 sr-only·clip·off-screen·font-size:0·color:transparent 은 정적 한계로 수용 잔여 — _is_hidden 주석 명시.)
_NN = "<h2>제품 소개</h2>" + _REST + "</body></html>"
print("MI_R7_DATALIST=%d"   % name_flagged("drug-mi-7dl", "<html><body><datalist><option>우루사정</option></datalist>" + _NN))
print("MI_R7_DIALOG=%d"     % name_flagged("drug-mi-7dlg", "<html><body><dialog><h1>우루사정</h1></dialog>" + _NN))
print("MI_R7_DETAILS=%d"    % name_flagged("drug-mi-7det", "<html><body><details><p>우루사정</p></details>" + _NN))
print("MI_R7_VISCOLLAPSE=%d"% name_flagged("drug-mi-7vc", '<html><body><h1 style="visibility:collapse">우루사정</h1>' + _NN))
print("MI_R7_OPACITY0=%d"   % name_flagged("drug-mi-7op", '<html><body><h1 style="opacity:0">우루사정</h1>' + _NN))
#   정상(false-positive 아님): dialog open / details open / opacity:0.5(반투명 표시)은 충족.
print("MI_R7_DIALOG_OPEN_OK=%d"  % (1 - name_flagged("drug-mi-7dlgo", "<html><body><dialog open><h1>우루사정</h1></dialog>" + _REST + "</body></html>")))
print("MI_R7_DETAILS_OPEN_OK=%d" % (1 - name_flagged("drug-mi-7deto", "<html><body><details open><p>우루사정</p></details>" + _REST + "</body></html>")))
print("MI_R7_OPACITY_HALF_OK=%d" % (1 - name_flagged("drug-mi-7oph", '<html><body><h1 style="opacity:0.5">우루사정</h1>' + _REST + "</body></html>")))

# (B·M8) one_pager final_page_phase=04 → 의약품 필수기재가 '그 포맷의 04'에서도 발동(포맷-무관 phase==final_page_phase).
#   누락 페이지(footer 무) → MI 위반 / 완비 페이지(page_ok, 우루사정+주의문구+광고심의필+회사명+SNS) → MI 0(over-flag 아님).
v_op_miss = evaluate("drug-mi-op", mkrun("drug-mi-op", "<html><body><h1>우루사</h1><p>간기능 개선</p></body></html>", {"deliverable_format": "one_pager"}), None, "drug-golden")
print("MI_ONEPAGER_FIRES=%d" % int(len(mi_rules(v_op_miss)) > 0))

# (C) 전문/일반 하드스톱: prescription×public → escalate / otc → 면제 / prescription×professional → 면제
def rx_vio(v):
    return [x for x in v.get("violations", []) if x.get("axis") == "prescription_otc_distinction"
            and "하드스톱" in x.get("rule", "")]
v_rx = evaluate("drug-rx-pub", mkrun("drug-rx-pub", "<html><body><p>우루사정 안내</p></body></html>",
                                     {"rx_classification": "prescription", "ad_audience": "public"}), None, "drug-golden")
print("RX_PUB_HARDSTOP=%d" % int(len(rx_vio(v_rx)) > 0))
print("RX_PUB_ESCALATE=%d" % int(v_rx.get("escalate") is True))
v_otc = evaluate("drug-rx-otc", mkrun("drug-rx-otc", "<html><body><p>우루사정 안내</p></body></html>",
                                      {"rx_classification": "otc", "ad_audience": "public"}), None, "drug-golden")
print("RX_OTC_HARDSTOP=%d" % int(len(rx_vio(v_otc)) > 0))
v_prof = evaluate("drug-rx-prof", mkrun("drug-rx-prof", "<html><body><p>우루사정 안내</p></body></html>",
                                        {"rx_classification": "prescription", "ad_audience": "professional"}), None, "drug-golden")
print("RX_PROF_HARDSTOP=%d" % int(len(rx_vio(v_prof)) > 0))

# (D) 누수#4 표지: drug substantiation_required ref(Engine.subst_ref)가 약사법 인용이고 '화장품법' 폴백이 아니다.
#   _vio() 가 ref 를 verdict 에 안 싣으므로 attribute 로 직접 동결. 단계2 leak#4(화장품법 폴백 도메인중립화) 후에도 drug=약사법 유지·화장품법 부재여야 함.
_subst_drug = Engine(load_ruleset("drug"), {}, set()).subst_ref or ""
print("SUBST_REF_DRUG_YAKSA=%d" % int("약사법" in _subst_drug))
print("SUBST_REF_DRUG_NOT_COSMETIC=%d" % int("화장품법" not in _subst_drug))

# (E) 단계3 팩 로더 fail-closed (코덱스 단계3 R2·R3 High/Medium) — 손상/누락/변형 domain.json 이 cosmetic 으로 조용히 폴백되면 의약품 오심의.
#   유효 팩 = JSON 파싱 + status(문자열) + domain==디렉터리명. 변형은 전부 미완(axes 0·incomplete) fail-closed. (2부 1단계) default→cosmetic 메커니즘 폐지 → reg default=None.
import kcia_engine as _k
_orig = _k.load_json
_DRUG_DJ = os.path.join(_k.PACKS_DIR, "drug", "domain.json")   # 정확 경로(quasi_drug/domain.json 오매칭 금지 — 코덱스 R3 Low)
def _inject(payload):
    # payload: Exception(파싱실패) 또는 dict(반환값). drug/domain.json 만 가로채고 나머지는 원본.
    def f(p):
        if os.path.normpath(p) == _DRUG_DJ:
            if isinstance(payload, Exception): raise payload
            return payload
        return _orig(p)
    return f
def _drug_failclosed(payload):
    _k.load_json = _inject(payload)
    try:
        reg = _k.load_domain_registry(); rs = _k.load_ruleset("drug")
        # 손상 drug 팩 → drug 룰셋 axes 0·incomplete(fail-closed). (2부 1단계) default 메커니즘 폐지 →
        #   reg default=None(cosmetic 탈취 불가), domain=None 도 cosmetic 폴백 없이 미완 룰셋(axes 0).
        return int(len(rs.get("axes", {})) == 0 and rs.get("meta", {}).get("incomplete") is True
                   and reg.get("default") is None and len(_k.load_ruleset(None).get("axes", {})) == 0)
    finally:
        _k.load_json = _orig
print("PACK_FC_PARSE_EXC=%d"   % _drug_failclosed(ValueError("corrupt")))                       # 파싱 실패
print("PACK_FC_NO_DOMAIN=%d"   % _drug_failclosed({"label": "의약품", "status": "active"}))      # domain 키 없음(R3 Medium)
print("PACK_FC_DOMAIN_MISMATCH=%d" % _drug_failclosed({"domain": "cosmetic", "status": "active"}))   # domain≠디렉터리
print("PACK_FC_NO_STATUS=%d"   % _drug_failclosed({"domain": "drug", "label": "x"}))             # status 없음
print("PACK_FC_DEFAULT_HIJACK=%d" % _drug_failclosed({"label": "의약품", "status": "active", "default": True}))  # default 탈취 시도
# (코덱스 R5) status enum 검증: 오타/공백/대소문자 = 유효 아님 → fail-closed(autopass 우회 차단).
print("PACK_FC_STATUS_TRAILSPACE=%d" % _drug_failclosed({"domain": "drug", "status": "active "}))   # 'active ' 공백
print("PACK_FC_STATUS_UPPER=%d"  % _drug_failclosed({"domain": "drug", "status": "ACTIVE"}))         # 대소문자
print("PACK_FC_STATUS_UNKNOWN=%d" % _drug_failclosed({"domain": "drug", "status": "foo"}))           # 미정의 enum
# (코덱스 R5) domain.json 최상위 타입: 객체(dict) 아니면 손상(pair-list 배열의 dict 승격 차단).
print("PACK_FC_ARRAY_TYPE=%d"    % _drug_failclosed([["domain", "drug"], ["status", "tbd"]]))        # pair-list 배열
print("PACK_FC_NONDICT=%d"       % _drug_failclosed("drug"))                                          # 비-dict(문자열)
# (코덱스 R6) status 가 배열/객체 → 'x in set' TypeError 로 레지스트리 전체 크래시 금지(나쁜 팩 1개는 자신만 fail-closed, 타 도메인 유지).
print("PACK_FC_STATUS_ARRAY=%d"  % _drug_failclosed({"domain": "drug", "status": ["active"]}))        # status 배열
print("PACK_FC_STATUS_OBJECT=%d" % _drug_failclosed({"domain": "drug", "status": {"v": "active"}}))   # status 객체
# 정상 회귀: drug=7축, 명시 미등록 도메인 fail-closed, domain=None → fail-closed(2부 1단계: cosmetic 폴백 폐지).
print("PACK_DRUG_NORMAL_7AXES=%d" % int(len(load_ruleset("drug").get("axes", {})) == 7))
print("PACK_UNREG_FAILCLOSED=%d" % int(len(load_ruleset("medical_device").get("axes", {})) == 0))
print("PACK_NONE_FAILCLOSED=%d" % int(len(load_ruleset(None).get("axes", {})) == 0))
PY
# shellcheck disable=SC1090
. "$RES"

# (B) 필수기재 — 누락 페이지가 현재 _mi_sig 수록 4항목을 검출(누수 제거 후에도 불변이어야 함)
check "(B) 필수기재 누락 → 소비자 주의문구 검출" "[ \"${MI_MISS_CONSUMER_CAUTION:-0}\" = '1' ]"
check "(B) 필수기재 누락 → 광고심의필 검출"     "[ \"${MI_MISS_REVIEW_MARK:-0}\" = '1' ]"
check "(B) 필수기재 누락 → 회사명 검출"         "[ \"${MI_MISS_COMPANY:-0}\" = '1' ]"
check "(B) 필수기재 누락 → SNS 경제적이해관계 검출" "[ \"${MI_MISS_SNS:-0}\" = '1' ]"
# (B·M8) one_pager 도 final_page_phase=04 → 의약품 필수기재가 그 포맷의 04 에서 발동(포맷-무관 게이팅)
check "(B·M8) one_pager final_page_phase=04 → 필수기재 발동" "[ \"${MI_ONEPAGER_FIRES:-0}\" = '1' ]"
check "(B) 필수기재 완비 페이지 → MI 위반 0"    "[ \"${MI_OK_COUNT:-99}\" = '0' ]"
# 누수#3 수정 완료: signals 외부화({product_name} 토큰)로 정확한 제품명(state.product.name)도 검사한다.
#   누락 페이지가 정확 제품명('우루사정')을 안 담으면 검출 → _mi_sig 하드코딩 시절 누락이던 product-name-full 이 이제 커버됨.
check "(B·누수#3) 정확한 제품명 누락 검출(signals {product_name} 외부화로 커버)" "[ \"${MI_MISS_PRODUCT_NAME:-9}\" = '1' ]"
# (B·fail-closed 코덱스 단계2 High) 일반 플레이스홀더('제품') 제품명 → 정확한 제품명 미충족(다른 4항목은 충족이라 product-name-full 만 flag)
check "(B·fail-closed) 일반 제품명('제품') → 정확한 제품명 필수기재 미충족 flag" "[ \"${MI_GENERIC_NAME_FLAGGED:-0}\" = '1' ]"
check "(B·fail-closed) 일반 제품명 케이스 — 다른 4항목은 충족(product-name-full 만 누락)" "[ \"${MI_GENERIC_OTHER_OK:-0}\" = '1' ]"
# (B·코덱스 R2 High) 부분문자열 fail-open 차단: '우루사정'이 '우루사정플러스'에만 묻히면 → 미충족 flag
check "(B·R2 High) 부분문자열 fail-open 차단(우루사정 ⊄ 우루사정플러스 → 제품명 누락 flag)" "[ \"${MI_SUBSTR_NAME_FLAGGED:-0}\" = '1' ]"
# (B·코덱스 R2 Medium) 마크업/공백 분할 정상 페이지는 통과: '우루사<span>정</span>' → 충족(필수기재 0)
check "(B·R2 Medium) 마크업 분할 제품명 정상 충족(우루사<span>정</span> → 제품명 flag 없음)" "[ \"${MI_SPLIT_NAME_OK:-0}\" = '1' ]"
check "(B·R2 Medium) 마크업 분할 정상 페이지 → 필수기재 위반 0(4항목+제품명 전부 충족)" "[ \"${MI_SPLIT_TOTAL:-9}\" = '0' ]"
# (B·코덱스 3R High) 충실 렌더 경계 — 노드/ZWJ/전각 경계 split fail-open 차단(gather 일괄 공백결합 우회)
check "(B·3R High) prefix 노드 split fail-open 차단(신<span>우루사정 → 신우루사정 → flag)" "[ \"${MI_R3_PREFIX_FLAGGED:-0}\" = '1' ]"
check "(B·3R High) suffix 노드 split fail-open 차단(우루사정|플러스 → 우루사정플러스 → flag)" "[ \"${MI_R3_SUFFIX_FLAGGED:-0}\" = '1' ]"
check "(B·3R High) zero-width(ZWJ) 우회 차단(우루사정<ZWJ>플러스 → flag)" "[ \"${MI_R3_ZWJ_FLAGGED:-0}\" = '1' ]"
check "(B·3R High) 전각 우회 차단(ＥＺｄｅｗＰｌｕｓ ⊃ EZdew → NFKC → flag)" "[ \"${MI_R3_FULLWIDTH_FLAGGED:-0}\" = '1' ]"
check "(B·3R Medium) 전각 정상 제품명 충족(ＥＺｄｅｗ=EZdew → flag 없음, false-positive 아님)" "[ \"${MI_R3_FULLWIDTH_OK:-0}\" = '1' ]"
# (B·코덱스 4R High1) CSS ::before/::after 생성콘텐츠 글루 — 정적검증 불가 → fail-closed flag
check "(B·4R High1) CSS ::after 단어콘텐츠 글루 차단(content:플러스 → flag)" "[ \"${MI_R4_CSS_AFTER:-0}\" = '1' ]"
check "(B·4R High1) CSS ::before 단어콘텐츠 글루 차단(content:신 → flag)" "[ \"${MI_R4_CSS_BEFORE:-0}\" = '1' ]"
check "(B·4R High1) CSS content:attr() 동적콘텐츠 글루 차단 → flag" "[ \"${MI_R4_CSS_ATTR:-0}\" = '1' ]"
check "(B·4R High1) 외부 styles.css ::after 글루 차단 → flag" "[ \"${MI_R4_CSS_EXTCSS:-0}\" = '1' ]"
check "(B·4R Medium) ::after 기호/아이콘 content는 무위험 → 충족(false-positive 아님)" "[ \"${MI_R4_CSS_SYMBOL_OK:-0}\" = '1' ]"
# (B·코덱스 4R High2) 비가시 카테고리(Cf/VS/CGJ) 제거 → 경계우회 차단
check "(B·4R High2) CGJ(U+034F) 우회 차단 → flag" "[ \"${MI_R4_INVIS_CGJ:-0}\" = '1' ]"
check "(B·4R High2) Arabic letter mark(U+061C) 우회 차단 → flag" "[ \"${MI_R4_INVIS_ALM:-0}\" = '1' ]"
check "(B·4R High2) Mongolian vowel sep(U+180E) 우회 차단 → flag" "[ \"${MI_R4_INVIS_MVS:-0}\" = '1' ]"
check "(B·4R High2) variation selector VS16(U+FE0F) 우회 차단 → flag" "[ \"${MI_R4_INVIS_VS16:-0}\" = '1' ]"
check "(B·4R High2) variation selector VS17(U+E0100) 우회 차단 → flag" "[ \"${MI_R4_INVIS_VS17:-0}\" = '1' ]"
# (B·코덱스 4R High3) 비라틴 경계(유니코드 카테고리 L*/N*/M*) — 비라틴 suffix 도 토큰 연속
check "(B·4R High3) CJK suffix(우루사정丸) 경계우회 차단 → flag" "[ \"${MI_R4_CJK_SUFFIX:-0}\" = '1' ]"
check "(B·4R High3) Greek suffix(EZdewα) 경계우회 차단 → flag" "[ \"${MI_R4_GREEK_SUFFIX:-0}\" = '1' ]"
# (B·코덱스 5R High1) CSS 글루 default-deny — 무한한 텍스트생성 경로를 열거 대신 보수적 차단
check "(B·5R High1) CSS content:var() 글루 차단 → flag" "[ \"${MI_R5_GLUE_VAR:-0}\" = '1' ]"
check "(B·5R High1) CSS open-quote 글루 차단 → flag" "[ \"${MI_R5_GLUE_OPENQUOTE:-0}\" = '1' ]"
check "(B·5R High1) CSS counters() 글루 차단 → flag" "[ \"${MI_R5_GLUE_COUNTERS:-0}\" = '1' ]"
check "(B·5R High1) CSS 따옴표안 세미콜론(플;러스) 파싱 → flag" "[ \"${MI_R5_GLUE_SEMICOLON:-0}\" = '1' ]"
check "(B·5R High1) CSS content:env() 글루 차단 → flag" "[ \"${MI_R5_GLUE_ENV:-0}\" = '1' ]"
check "(B·5R Medium) CSS content:none 무해 → 충족(false-positive 아님)" "[ \"${MI_R5_GLUE_NONE_OK:-0}\" = '1' ]"
check "(B·5R Medium) CSS PUA 아이콘 content 무해 → 충족(false-positive 아님)" "[ \"${MI_R5_GLUE_PUA_OK:-0}\" = '1' ]"
# (B·코덱스 5R High2) 블록횡단 글자 합성 차단(\\n 블록경계)
check "(B·5R High2) 블록횡단 흩뿌림(우/루/사/정 별도 블록) 합성 차단 → flag" "[ \"${MI_R5_BLOCK_SCATTER:-0}\" = '1' ]"
check "(B·5R Medium) 같은 블록 letter-spacing(우 루 사 정) 충족(false-positive 아님)" "[ \"${MI_R5_LETTERSPACE_OK:-0}\" = '1' ]"
# (B·코덱스 5R Medium) CSS escape 범위초과(\\110000) 엔진 크래시 방지
check "(B·5R Medium) CSS escape 범위초과 → ValueError 크래시 없음(verdict 생성)" "[ \"${MI_R5_DECODE_NOCRASH:-0}\" = '1' ]"
# (B·코덱스 6R High1) 가시 노출만 인정 — 숨김/비렌더 DOM 으로 충족되던 fail-open 차단
check "(B·6R High1) <title> 만(본문 미노출) → 가시 미충족 flag" "[ \"${MI_R6_HIDDEN_TITLE:-0}\" = '1' ]"
check "(B·6R High1) <template> 안 제품명 → 비렌더 미충족 flag" "[ \"${MI_R6_HIDDEN_TEMPLATE:-0}\" = '1' ]"
check "(B·6R High1) hidden 속성 → 미충족 flag" "[ \"${MI_R6_HIDDEN_ATTR:-0}\" = '1' ]"
check "(B·6R High1) display:none → 미충족 flag" "[ \"${MI_R6_HIDDEN_DISPNONE:-0}\" = '1' ]"
check "(B·6R High1) aria-hidden=true → 미충족 flag" "[ \"${MI_R6_HIDDEN_ARIA:-0}\" = '1' ]"
check "(B·6R High1) noscript 안 → 미충족 flag" "[ \"${MI_R6_HIDDEN_NOSCRIPT:-0}\" = '1' ]"
check "(B·6R Medium) title+body 둘 다 노출 → 충족(false-positive 아님)" "[ \"${MI_R6_VISIBLE_OK:-0}\" = '1' ]"
check "(B·6R Medium) 숨김 형제는 무관(이름 가시) → 충족" "[ \"${MI_R6_HIDDEN_SIBLING_OK:-0}\" = '1' ]"
check "(B·6R Medium) 이름 내부 숨김 span 제거→연결 → 충족" "[ \"${MI_R6_INNER_HIDDEN_OK:-0}\" = '1' ]"
# (B·코덱스 7R Medium) 인라인 판정 가능한 추가 비노출 폐쇄
check "(B·7R) <datalist> 안 → 비노출 미충족 flag" "[ \"${MI_R7_DATALIST:-0}\" = '1' ]"
check "(B·7R) open 없는 <dialog> → 비표시 미충족 flag" "[ \"${MI_R7_DIALOG:-0}\" = '1' ]"
check "(B·7R) open 없는 <details> 본문 → 비표시 미충족 flag" "[ \"${MI_R7_DETAILS:-0}\" = '1' ]"
check "(B·7R) visibility:collapse → 미충족 flag" "[ \"${MI_R7_VISCOLLAPSE:-0}\" = '1' ]"
check "(B·7R) opacity:0 → 미충족 flag" "[ \"${MI_R7_OPACITY0:-0}\" = '1' ]"
check "(B·7R) <dialog open> → 표시 충족(false-positive 아님)" "[ \"${MI_R7_DIALOG_OPEN_OK:-0}\" = '1' ]"
check "(B·7R) <details open> → 표시 충족(false-positive 아님)" "[ \"${MI_R7_DETAILS_OPEN_OK:-0}\" = '1' ]"
check "(B·7R) opacity:0.5(반투명) → 표시 충족(false-positive 아님)" "[ \"${MI_R7_OPACITY_HALF_OK:-0}\" = '1' ]"

# (C) 전문/일반 하드스톱
check "(C) 전문의약품×대중매체 → 하드스톱 발동" "[ \"${RX_PUB_HARDSTOP:-0}\" = '1' ]"
check "(C) 전문의약품×대중매체 → escalate(사람 개입)" "[ \"${RX_PUB_ESCALATE:-0}\" = '1' ]"
check "(C) 일반의약품(otc) → 하드스톱 미발동" "[ \"${RX_OTC_HARDSTOP:-1}\" = '0' ]"
check "(C) 전문의약품×전문가매체 → 하드스톱 면제" "[ \"${RX_PROF_HARDSTOP:-1}\" = '0' ]"

# (D) 누수#4 — drug 실증 인용이 약사법이고 화장품법 폴백이 아님(단계2 leak#4 제거 후에도 불변)
check "(D·누수#4) drug substantiation ref = 약사법 인용" "[ \"${SUBST_REF_DRUG_YAKSA:-0}\" = '1' ]"
check "(D·누수#4) drug substantiation ref ≠ 화장품법 폴백" "[ \"${SUBST_REF_DRUG_NOT_COSMETIC:-0}\" = '1' ]"

# (E) 단계3 팩 로더 fail-closed (코덱스 단계3 R2·R3 High/Medium) — 손상 domain.json 변형 전수 → cosmetic 오폴백 차단(2부 1단계: default 메커니즘 자체 폐지)
check "(E·3R) 파싱 실패 domain.json → fail-closed(미완·default 메커니즘 폐지)" "[ \"${PACK_FC_PARSE_EXC:-0}\" = '1' ]"
check "(E·3R) domain 키 없음 → fail-closed(R3 Medium)" "[ \"${PACK_FC_NO_DOMAIN:-0}\" = '1' ]"
check "(E·3R) domain≠디렉터리명 → fail-closed" "[ \"${PACK_FC_DOMAIN_MISMATCH:-0}\" = '1' ]"
check "(E·3R) status 없음 → fail-closed" "[ \"${PACK_FC_NO_STATUS:-0}\" = '1' ]"
check "(E·3R) default:true 탈취 시도 → default 메커니즘 폐지(무시·reg default=None)" "[ \"${PACK_FC_DEFAULT_HIJACK:-0}\" = '1' ]"
check "(E·3R) 정상 drug = 7축(회귀 없음)" "[ \"${PACK_DRUG_NORMAL_7AXES:-0}\" = '1' ]"
check "(E·3R) 명시 미등록 도메인 → cosmetic 폴백 금지(fail-closed)" "[ \"${PACK_UNREG_FAILCLOSED:-0}\" = '1' ]"
check "(E·3R) domain=None → fail-closed(cosmetic 폴백 폐지)" "[ \"${PACK_NONE_FAILCLOSED:-0}\" = '1' ]"
# (E·5R) status enum + dict 타입 검증 (코덱스 단계3 R5 High)
check "(E·5R) status 'active '(공백) → fail-closed" "[ \"${PACK_FC_STATUS_TRAILSPACE:-0}\" = '1' ]"
check "(E·5R) status 'ACTIVE'(대소문자) → fail-closed" "[ \"${PACK_FC_STATUS_UPPER:-0}\" = '1' ]"
check "(E·5R) status 'foo'(미정의 enum) → fail-closed" "[ \"${PACK_FC_STATUS_UNKNOWN:-0}\" = '1' ]"
check "(E·5R) domain.json 배열(pair-list) → fail-closed" "[ \"${PACK_FC_ARRAY_TYPE:-0}\" = '1' ]"
check "(E·5R) domain.json 비-dict(문자열) → fail-closed" "[ \"${PACK_FC_NONDICT:-0}\" = '1' ]"
# (E·6R) status 배열/객체 → 레지스트리 전체 크래시 없이 해당 팩만 fail-closed(타 도메인 유지)
check "(E·6R) status 배열 → fail-closed(레지스트리 크래시 없음)" "[ \"${PACK_FC_STATUS_ARRAY:-0}\" = '1' ]"
check "(E·6R) status 객체 → fail-closed(레지스트리 크래시 없음)" "[ \"${PACK_FC_STATUS_OBJECT:-0}\" = '1' ]"

# (F) 단계3 shell autopass 게이트 (코덱스 단계3 R4 High/Low) — domain_field 가 Python 검증 레지스트리를 질의(단일 출처).
#   손상/변형 domain.json → status 빈값(autopass 우회 차단; kcia-check 가 active 기본→엔진 fail-closed). 유효 tbd 만 autopass.
_FTMP="$(mktemp -d "${TMPDIR:-/tmp}/packfield.XXXXXX")"
mkdir -p "$_FTMP/drug" "$_FTMP/quasi_drug" "$_FTMP/cosmetic"
printf '{"domain":"cosmetic","status":"active"}' > "$_FTMP/cosmetic/domain.json"
printf '{"domain":"quasi_drug","status":"tbd"}' > "$_FTMP/quasi_drug/domain.json"
_df() { PACKS_DIR="$_FTMP" HARNESS_ROOT="$ROOT" bash -c '. "$1"/scripts/lib/common.sh; domain_field "$2" status' _ "$ROOT" "$1"; }
for _pair in 'no-domain:{"status":"tbd"}' 'mismatch:{"domain":"cosmetic","status":"tbd"}' 'numeric:{"domain":"drug","status":1}' 'broken:{ broken' 'enum-foo:{"domain":"drug","status":"foo"}' 'enum-space:{"domain":"drug","status":"active "}'; do
  printf '%s' "${_pair#*:}" > "$_FTMP/drug/domain.json"
  _s="$(_df drug)"
  check "(F·3R) 손상 drug(${_pair%%:*}) → status 빈값(autopass 우회 차단)" "[ -z \"$_s\" ]"
done
printf '{"domain":"drug","status":"active"}' > "$_FTMP/drug/domain.json"
check "(F·3R) 유효 drug active → status=active(회귀)" "[ \"$(_df drug)\" = 'active' ]"
check "(F·3R) 유효 quasi_drug tbd → status=tbd(의도된 autopass 보존)" "[ \"$(_df quasi_drug)\" = 'tbd' ]"
rm -rf "$_FTMP" 2>/dev/null

rm -f "$RES" 2>/dev/null
rm -rf "$ROOT"/runs/drug-mi-* "$ROOT"/runs/drug-rx-* "$ROOT"/runs/drug-full-probe "$ROOT"/runs/drug-probe 2>/dev/null; true
echo "DRUG-GOLDEN: PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
