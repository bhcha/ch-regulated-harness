#!/usr/bin/env python3
"""validate_stage.py — validate-stage.sh 의 인라인 검증 python 14블록 이관 (값 불변).

각 check 는 옛 인라인 python(`"$PY" -c "..."`) 본문의 로직·stdout·종료코드를
**그대로** 재현한다. 셸 래퍼(`>/dev/null 2>&1 || {...}` · `2>/dev/null` ·
`|| true` · `|| echo 0` · `$(...)` 캡처)는 validate-stage.sh 가 그대로 유지하므로,
이 모듈은 옛 `-c` 본문과 동일한 stdout·rc(미포착 예외 전파·sys.exit 코드 포함)만
내면 셸 동작(rc·출력·set -e 트립 지점)이 불변이다.

이전에 셸 문자열 보간($RDIR/$rec/$optdir/$marker/$valid_opts)되던 값은 argv 로 받는다.
인터페이스: `validate_stage.py <check> [args...]`.
  rec-check <rec> <optdir>                → stdout: 실재하지 않는 옵션 id(콤마 결합)
  min3-valid-opts <optdir> <marker>       → stdout: 유효 옵션(공백 결합) 또는 ''
  min3-ndistinct <rec> <valid_opts>       → stdout: 서로 다른 유효 옵션 수
  brief-output-type <rdir>                → rc only
  intake-proposal <rdir>                  → rc only
  evidence-reflection <rdir>              → rc only
  guideline-refnotes-nonempty <rdir>      → rc only
  guideline-refnotes-deny <rdir>          → rc only
  guideline-whygood-grounded <rdir>       → rc only
  guideline-reference-images <rdir>       → rc only
  guideline-example-analysis <rdir>       → rc only
  guideline-domain-match <rdir>           → rc only
  plan-visual-concept <rdir>              → rc only
  plan-art-direction <rdir>               → rc only
"""
import sys
import os
import json
import glob
import re
import hashlib
import unicodedata as U

# 모듈이 scripts/lib/ 에 동거하므로 examples_analysis 를 같은 디렉터리에서 import.
# (옛 인라인은 sys.path.insert(0, $HARNESS_ROOT/scripts/lib) 로 동일 디렉터리를 넣었음 — 등가.)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ── 다안 공용(rec_check / min3_check) ────────────────────────────────────────
def rec_check(rec, optdir):
    # 옛 인라인: recommendation.ranked 중 실재하지 않는(디렉터리 아닌) 옵션을 콤마결합 출력.
    r = json.load(open(rec)).get('ranked', [])
    opts = set(n for n in os.listdir(optdir) if os.path.isdir(os.path.join(optdir, n)))  # 디렉터리 옵션만(phantom 파일 우회 차단)
    print(','.join(x for x in r if x not in opts))


def min3_valid_opts(d, m):
    # 옛 인라인: 표지 파일(m)을 실제로 가진 디렉터리 옵션만 공백결합 출력. 디렉터리 없으면 '' + SystemExit(rc0).
    if not os.path.isdir(d):
        print('')
        raise SystemExit
    ok = [n for n in sorted(os.listdir(d)) if os.path.isdir(os.path.join(d, n)) and os.path.exists(os.path.join(d, n, m))]
    print(' '.join(ok))


def min3_ndistinct(rec, valid_arg):
    # 옛 인라인: ranked 중 valid 교집합의 서로 다른 개수 출력.
    valid = set(valid_arg.split())
    r = json.load(open(rec)).get('ranked', [])
    print(len(set(x for x in r if x in valid)))


# ── 01-brief ────────────────────────────────────────────────────────────────
def brief_output_type(rdir):
    b = json.load(open(os.path.join(rdir, '01-brief', 'brief.json')))
    ot = b.get('output_type')
    if not isinstance(ot, dict):
        sys.exit(2)
    st = (json.load(open(os.path.join(rdir, 'state.json'))).get('product') or {})
    dom = st.get('regulatory_domain')
    fmt = st.get('deliverable_format') or 'multipage_bm'
    if ot.get('regulatory_domain') != dom or ot.get('deliverable_format') != fmt:
        sys.exit(3)
    sys.exit(0)


# ── 00a-intake ────────────────────────────────────────────────────────────────
def intake_proposal(rdir):
    prop = json.load(open(os.path.join(rdir, '00a-intake', 'intake-proposal.json')))
    adir = os.path.join(rdir, 'inputs', 'attachments')
    CATS = {'working_backwards', 'own_product_crawl', 'reference_crawl', 'product_image', 'evidence_test_report', 'evidence_certification', 'evidence_paper', 'evidence_patent', 'evidence_ingredient_dossier', 'evidence_brand_story', 'evidence_guide', 'evidence_general', 'unknown'}
    ROUTES = {'working_backwards', 'bundle', 'examples', 'assets', 'evidence', 'hold'}
    KINDS = {'test_report', 'certification', 'paper', 'patent', 'ingredient_dossier', 'brand_story', 'guide', 'general'}

    def nfc(s):
        return U.normalize('NFC', s or '')
    snap = set()
    if os.path.isdir(adir):
        for fn in os.listdir(adir):
            if fn.startswith('.'):
                continue
            if os.path.isfile(os.path.join(adir, fn)):
                snap.add(nfc(fn))
    files = prop.get('files') or []
    pset = {nfc(f.get('filename')) for f in files}
    if len(pset) != len(files):
        sys.exit(11)   # 파일명 중복
    if pset != snap:
        sys.exit(12)              # 1:1 전수 커버리지 위반(누락/초과)
    CATK = {'evidence_test_report': 'test_report', 'evidence_certification': 'certification', 'evidence_paper': 'paper', 'evidence_patent': 'patent', 'evidence_ingredient_dossier': 'ingredient_dossier', 'evidence_brand_story': 'brand_story', 'evidence_guide': 'guide', 'evidence_general': 'general'}
    CATROUTE = {'working_backwards': 'working_backwards', 'own_product_crawl': 'bundle', 'reference_crawl': 'examples', 'product_image': 'assets', 'unknown': 'hold'}  # evidence_*→evidence(아래 분기)
    EVEXTS = {'pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'webp'}  # ingest _EVIDENCE_EXTS 미러(화이트리스트)
    ASSETEXTS = {'jpg', 'jpeg', 'png', 'webp', 'svg'}  # cmd_assets 자사-스캔 확장자 미러(gif 제외 — 스캔 밖이면 manifest 누락)
    for f in files:
        if f.get('category') not in CATS:
            sys.exit(13)
        if f.get('route') not in ROUTES:
            sys.exit(14)
        if 'kind' in f and f.get('kind') not in KINDS:
            sys.exit(15)
        # W-2(외부리뷰 W4-R3) category↔kind 일관성: 근거 성격의 단일 출처는 category — 불일치(예 evidence_test_report+kind:general)
        #   면 승인 전 차단(apply 에서 시험성적서가 general 로 강등돼 test_report pending 흐름을 우회하는 것 방지).
        _c = f.get('category')
        _k = f.get('kind')
        if _c and _c.startswith('evidence_') and _k and CATK.get(_c) and _k != CATK[_c]:
            sys.exit(20)
        # W-2(외부리뷰 W4-R8) category↔route 일관성: apply-intake 는 category 로 라우팅하므로, route 가 category 의 정본 채널과
        #   다르면(예 evidence_test_report+route:hold, product_image+route:evidence) 승인된 route 가 무시돼 held 파일이 흘러간다 → fail-closed.
        _exp = 'evidence' if (_c or '').startswith('evidence_') else CATROUTE.get(_c)
        if _exp and f.get('route') != _exp:
            sys.exit(21)
        # W-2(외부리뷰 W4-R9) evidence 확장자 화이트리스트 미러(ingest _EVIDENCE_EXTS 와 동일): evidence_* 로 분류된 파일이
        #   화이트리스트 밖 확장자면 downstream evidence-docs 가 거부해 post-approval 훅에서만 실패(review wedge) → 승인 전 차단.
        if _c and _c.startswith('evidence_'):
            _ext = os.path.splitext(f.get('filename') or '')[1].lstrip('.').lower()
            if _ext not in EVEXTS:
                sys.exit(22)
        # W-2(외부리뷰 W4-R10) product_image 확장자는 cmd_assets 자사-스캔(jpg/jpeg/png/webp/svg)과 일치해야 한다 — gif 등
        #   스캔 밖 확장자는 routed 로 복사돼도 assets-manifest 에서 누락돼 자사컷 0(스토리보드/키비주얼 폴백) → 승인 전 차단.
        if _c == 'product_image':
            _ext = os.path.splitext(f.get('filename') or '')[1].lstrip('.').lower()
            if _ext not in ASSETEXTS:
                sys.exit(23)
        # S1(F5a) role 세부역할은 자사 이미지(product_image)에만 허용 — 다른 category 에 role 이 붙으면
        #   (사람 미확인 오분류·오적용) 승인 전 차단. role/provenance 는 선택 필드라 부재는 통과(후방호환).
        if 'role' in f and _c != 'product_image':
            sys.exit(24)
        fp = os.path.join(adir, f.get('filename') or '')
        if not os.path.isfile(fp):
            sys.exit(16)
        h = hashlib.sha256(open(fp, 'rb').read()).hexdigest()
        if h != f.get('sha256'):
            sys.exit(17)  # 위변조/스냅샷 불일치
    # W-2(외부리뷰 W4) 워킹백워드 shift-left: 발효(apply-intake)가 요구하는 전제를 '승인 전(validate)'에 검증 —
    #   승인 후 apply 에서 fail 하면 gate=review wedge(revise 불가)라, 여기서 막아 gate=user 에서 revise 가능하게 한다.
    #   ① 모든 런은 워킹백워드 필요(사실 원천) → working_backwards 분류 ≥1. ② 그 변환본(에이전트 docx→md)이 실재해야 한다.
    wb_files = [f for f in files if f.get('category') == 'working_backwards']
    if not wb_files:
        sys.exit(18)   # 워킹백워드 미분류(모든 런의 사실 원천 필요)
    cw = os.path.join(rdir, '00a-intake', 'converted', 'working-backwards.md')
    if not (os.path.isfile(cw) and os.path.getsize(cw) > 0):
        sys.exit(19)  # 워킹백워드 분류됐으나 변환본(converted/working-backwards.md) 없음
    sys.exit(0)


# ── 00e-evidence ────────────────────────────────────────────────────────────────
def evidence_reflection(rdir):
    prop = json.load(open(os.path.join(rdir, '00e-evidence', 'reflection-proposal.json')))
    man = json.load(open(os.path.join(rdir, '00-ingest', 'evidence-documents.json')))

    def nfc(s):
        return U.normalize('NFC', s or '')
    mdocs = man.get('documents') or []
    mbyid = {d.get('id'): d for d in mdocs}
    pend = {(d.get('id'), nfc(d.get('filename'))) for d in mdocs if d.get('spec_status') == 'pending'}
    pdocs = prop.get('docs') or []
    pset = {(d.get('id'), nfc(d.get('filename'))) for d in pdocs}
    applied = {(d.get('id'), nfc(d.get('filename'))) for d in mdocs if d.get('spec_origin') == 'agent_proposed_human_approved'}
    if not pend:
        sys.exit(0 if (pset and pset <= applied) else 10)   # 멱등: pending 없어도 이미 승인반영이면 통과(부분 finalize 회복 재검증)
    if pend != pset:
        sys.exit(11)      # 1:1 전수 커버리지 위반(누락/초과/불일치)
    GEN_KINDS = {'certification', 'paper', 'patent', 'ingredient_dossier', 'brand_story', 'guide', 'general'}

    def isposint(x):
        return isinstance(x, int) and not isinstance(x, bool) and x >= 1
    for d in pdocs:
        kind = d.get('kind')
        m = mbyid.get(d.get('id')) or {}
        if kind == 'test_report':
            if not (m.get('kind') == 'test_report' and m.get('spec_status') == 'pending'):
                sys.exit(12)  # intent-match 위반(사람 선언 없이 승격 시도)
            if not (d.get('verdict_text') or '').strip():
                sys.exit(16)
            if not (d.get('grade') or '').strip():
                sys.exit(17)
            tr = d.get('test_report') or {}
            if not (tr.get('institution') or '').strip():
                sys.exit(18)
            if not isposint(tr.get('sample_size')):
                sys.exit(19)
            if not (tr.get('duration') or '').strip():
                sys.exit(20)
            # 외부리뷰 3R-2: 다중 페이지 image_ref 는 apply 단계 추출에서 hard-fail(항목당 image_path 1슬롯) → 승인 전 여기서 차단.
            for it in (tr.get('test_items') or []):
                ir = it.get('image_ref') if isinstance(it, dict) else None
                if isinstance(ir, dict) and len(ir.get('pages') or []) > 1:
                    sys.exit(22)
        elif kind in GEN_KINDS:
            # 외부리뷰 3R-2: 사람이 kind:test_report 로 선언한 pending 문서를 일반 kind 제안으로 '강등' 금지 — 승인 전 차단(apply 는 백스톱).
            if m.get('kind') == 'test_report' and m.get('spec_status') == 'pending':
                sys.exit(21)
        else:
            sys.exit(13)
        if not (d.get('claim') or '').strip():
            sys.exit(14)
        if len([p for p in (d.get('reflection_points') or []) if (p or '').strip()]) < 1:
            sys.exit(15)
    sys.exit(0)


# ── 00g-guideline ────────────────────────────────────────────────────────────────
def guideline_refnotes_nonempty(rdir):
    n = json.load(open(os.path.join(rdir, '00g-guideline', 'reference-notes.json')))
    has = bool(n.get('flow_refs') or n.get('composition_notes') or (n.get('notes') or '').strip())
    sys.exit(0 if has else 1)


def guideline_refnotes_deny(rdir):
    from examples_analysis import why_violations
    dom = (json.load(open(os.path.join(rdir, 'state.json'))).get('product') or {}).get('regulatory_domain')
    n = json.load(open(os.path.join(rdir, '00g-guideline', 'reference-notes.json')))
    texts = list(n.get('flow_refs') or []) + list(n.get('composition_notes') or []) + ([n['notes']] if (n.get('notes') or '').strip() else [])
    sys.exit(1 if any(why_violations(t, dom) for t in texts) else 0)


def guideline_whygood_grounded(rdir):
    allowed = {'voc_themes', 'structure', 'block_sequence', 'pacing'}
    bad = []
    for fp in glob.glob(os.path.join(rdir, '00g-guideline', 'examples', '*', 'example-analysis.json')):
        a = json.load(open(fp))
        keys = set(a.get('signals', {}).keys()) | allowed
        for w in a.get('why_good', []):
            for g in w.get('grounded_in', []):
                if g not in keys:
                    bad.append(g)
    sys.exit(1 if bad else 0)


def guideline_reference_images(rdir):
    from examples_analysis import ALLOWED_COMPOSITION_TAGS, ALLOWED_MOOD_TAGS, why_violations
    NN = re.compile(r'^.+#[0-9]{2,}$')
    dom = (json.load(open(os.path.join(rdir, 'state.json'))).get('product') or {}).get('regulatory_domain')
    files = sorted(glob.glob(os.path.join(rdir, '00g-guideline', 'examples', '*', 'example-analysis.json')))
    seen = set()
    for fp in files:
        a = json.load(open(fp))
        eid = a.get('example_id') or ''
        ri = a.get('reference_images') or []
        if not ri:
            sys.exit(2)                                   # ⓐ 무조건 비어있지 않음
        for r in ri:
            comp = r.get('composition_tags') or []
            mood = r.get('mood_tags') or []
            why = (r.get('why') or '').strip()
            if not comp or not mood or not why:
                sys.exit(3)
            if any(t not in ALLOWED_COMPOSITION_TAGS for t in comp):
                sys.exit(4)   # ⓑ 구도 화이트리스트
            if any(t not in ALLOWED_MOOD_TAGS for t in mood):
                sys.exit(4)          # ⓑ 무드 화이트리스트
            # ⓑ why 효능·절대·속효어 deny(active 룰셋 banned + 큐레이션, 정규화 매칭)
            if why_violations(' '.join(comp) + ' ' + ' '.join(mood) + ' ' + why, dom):
                sys.exit(5)
            if not any(t in why for t in comp) or not any(t in why for t in mood):
                sys.exit(6)  # ⓑ why 가 자기 태그 인용(grounded)
            rid = r.get('id') or ''
            if not NN.match(rid) or not rid.startswith(eid + '#'):
                sys.exit(7)       # ⓒ '<example_id>#NN'
            if rid in seen:
                sys.exit(8)                          # ⓒ 전(全) 사례 전역 유일
            seen.add(rid)
            src = r.get('src') or ''
            if not src or src.startswith('inputs/assets/'):
                sys.exit(9)            # ⓓ 디자인 자산 아님(저작권)
    sys.exit(0)


def guideline_example_analysis(rdir):
    exroot = os.path.realpath(os.path.join(rdir, '00g-guideline', 'examples'))
    files = glob.glob(os.path.join(exroot, '*', 'example-analysis.json'))
    if not files:
        sys.exit(2)
    for fp in files:
        d = os.path.basename(os.path.dirname(fp))
        if json.load(open(fp)).get('example_id') != d:
            sys.exit(3)
    sys.exit(0)


def guideline_domain_match(rdir):
    dom = (json.load(open(os.path.join(rdir, 'state.json'))).get('product') or {}).get('regulatory_domain')
    fps = glob.glob(os.path.join(rdir, '00g-guideline', 'examples', '*', 'example-analysis.json')) + [os.path.join(rdir, '00g-guideline', 'reference-notes.json')]
    for fp in fps:
        if not os.path.exists(fp):
            continue
        if (json.load(open(fp)).get('regulatory_domain')) != dom:
            sys.exit(1)
    sys.exit(0)


# ── 03-storyboard (plan) ────────────────────────────────────────────────────────────────
def plan_visual_concept(rdir):
    pdir = os.path.join(rdir, '03-storyboard', 'plan')
    files = sorted(glob.glob(os.path.join(pdir, '*.json')))
    if not files:
        sys.exit(0)
    for fp in files:
        b = json.load(open(fp))
        con = ((b.get('visual') or {}).get('concept')) or {}
        ref = con.get('reference') or {}
        # 구도/무드/참조 흡수 강제: composition 또는 mood 중 하나 + reference.own_asset_path 필수
        if not (con.get('composition') or con.get('mood')):
            sys.exit(2)
        if not (ref.get('own_asset_path') or '').strip():
            sys.exit(3)
    sys.exit(0)


def plan_art_direction(rdir):
    ad_fp = os.path.join(rdir, '03-storyboard', 'art-direction.json')
    if not os.path.exists(ad_fp):
        sys.exit(2)
    ad = json.load(open(ad_fp))
    # 공백/빈문자열 색은 무효(외부리뷰 2R HIGH: ['']·[' '] 우회 차단) — strip 후 비어있지 않은 것만 유효 색으로.
    master = set(c.strip() for c in (ad.get('master_palette') or []) if isinstance(c, str) and c.strip())
    if not master:
        sys.exit(3)
    pdir = os.path.join(rdir, '03-storyboard', 'plan')
    for fp in sorted(glob.glob(os.path.join(pdir, '*.json'))):
        con = ((json.load(open(fp)).get('visual') or {}).get('concept')) or {}
        if not con:
            continue   # visual.concept 자체 누락은 위 (sys.exit 2/3) 게이트가 이미 차단
        pal = [c.strip() for c in (con.get('palette') or []) if isinstance(c, str) and c.strip()]
        if not pal:
            sys.exit(5)   # 블록 palette 누락/빈/공백뿐 = 전역 상속 안 함(빈 palette 우회 차단, 외부리뷰 HIGH)
        extra = [c for c in pal if c not in master]
        if extra:
            sys.exit(4)     # 블록이 전역 팔레트 밖 색 사용 = 분열
    sys.exit(0)


# ── dispatch ────────────────────────────────────────────────────────────────
def main(argv):
    check = argv[1]
    a = argv[2:]
    if check == 'rec-check':
        rec_check(a[0], a[1])
    elif check == 'min3-valid-opts':
        min3_valid_opts(a[0], a[1])
    elif check == 'min3-ndistinct':
        min3_ndistinct(a[0], a[1])
    elif check == 'brief-output-type':
        brief_output_type(a[0])
    elif check == 'intake-proposal':
        intake_proposal(a[0])
    elif check == 'evidence-reflection':
        evidence_reflection(a[0])
    elif check == 'guideline-refnotes-nonempty':
        guideline_refnotes_nonempty(a[0])
    elif check == 'guideline-refnotes-deny':
        guideline_refnotes_deny(a[0])
    elif check == 'guideline-whygood-grounded':
        guideline_whygood_grounded(a[0])
    elif check == 'guideline-reference-images':
        guideline_reference_images(a[0])
    elif check == 'guideline-example-analysis':
        guideline_example_analysis(a[0])
    elif check == 'guideline-domain-match':
        guideline_domain_match(a[0])
    elif check == 'plan-visual-concept':
        plan_visual_concept(a[0])
    elif check == 'plan-art-direction':
        plan_art_direction(a[0])
    else:
        sys.stderr.write('unknown check: %s\n' % check)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv)
