#!/usr/bin/env python3
"""operator_labels.py — 현업 화면용 평이 라벨의 **단일 출처**(개선계획 1부 단계1).

문제(근본): 번역표(`prompts/operator-voice.md`)와 렌더 코드(`render_runmd.py`·`next-action.sh`·
4동작 스크립트)가 이원화돼, 표는 살아있어도 산출물에서는 사문화됐다. 이 모듈이 그 둘의 **공유 사전**이다.

설계 원칙(GSD·gstack 차용):
  - 무엇을 하는지로 말한다(함수명·내부 코드·구현 디테일 금지).
  - 16살 규칙: 이 라벨을 이해하려고 코드/스키마를 다시 봐야 하면 너무 어려운 것.
  - 안전필수 결과는 평이어로라도 반드시 남긴다(걸렸다/통과/사람 확인 필요).

쓰임:
  - Python: `from operator_labels import PHASE_LABEL, gate_text, ...`
    (render_runmd.py 가 import → next-action.sh 의 `R.PHASE_LABEL` 재사용도 그대로 동작).
  - bash: `python3 .../operator_labels.py <fn> <args...>` → 평이 라벨 1줄 stdout
    (4동작 스크립트가 같은 사전을 조회 — 문자열 이원화 제거).

⚠️ 순수 표현 계층이다. state.json 을 쓰지 않고 점검 로직과 무관하다(개선계획 안전 불변식).
   이 모듈의 출력 문자열에는 내부 코드(auto/human-verify/escalated/scope=/iteration N/M/게이트=/상태=)를
   넣지 않는다 — 그것이 현업 화면 누수의 원천이며, 회귀 가드(tests)가 grep 으로 막는다.
"""
import os
import re
import sys


# ── 페이즈: '무엇을 하는 단계인지' 평이하게(내부 약어 워킹백워드/VOC/인입 제거) ──
PHASE_LABEL = {
    "00a-intake":    "첨부 자료 분류 확인",
    "00-ingest":     "자료 불러오기 (제품 정보·고객 후기)",
    "00e-evidence":  "참고 문서 반영 제안",
    "00g-guideline": "비슷한 제품 참고 메모",
    "01-brief":      "핵심 정리 (누구에게·무엇을·왜)",
    "02-concept":    "내세울 메시지 정하기",
    "03-storyboard": "페이지 구성안 만들기",
    "04-keyvisual":  "대표 이미지 시안",
    "done":          "완료",
}

# ── 게이트 '종류'를 사람에게 닥칠 일로 번역(영어 코드 auto/human-verify/setup/hard-stop 미노출) ──
#   코드 자체는 기계(next-action.sh JSON)용으로 남고, 현업 run.md 에는 이 한국어 문장만 보인다.
GATE_TYPE_TEXT = {
    "auto":         "바로 다음으로 진행돼요 (사람이 확인할 필요 없이 진행)",
    "human-verify": "사람이 직접 확인하고 결정할 차례예요",
    "setup":        "먼저 담당자(RA) 확인이 필요해요 (승인 전에 거쳐야 해요)",
    "hard-stop":    "🛑 사람이 직접 봐야 해요 (자동 진행을 멈췄어요)",
}

# ── 진행 상태(내부 enum)를 평이어로. 'escalated' 같은 단어를 그대로 내뱉지 않는다 ──
STATUS_LABEL = {
    "pending":            "진행 중",
    "generate":           "만드는 중",
    "revise":             "고치는 중",
    "changes_requested":  "고치는 중",
    "selected":           "고른 안 반영 중",
    "approved":           "승인 반영 중",
    "passed":             "통과",
    "escalated":          "사람 손길 필요",
    "done":               "완료",
}

# ── 커버리지 등에서 쓰는 scope 코드 → 평이 라벨('scope=' 노출 금지) ──
SCOPE_LABEL = {
    "design":  "디자인 기준",
    "content": "내용 기준",
    "brief":   "정리 기준",
}

# ── GSD 'After this:' — 각 페이즈가 산출물을 낸 뒤 현업이 '이제 할 수 있게 된 일' 한 줄 ──
PHASE_CAPABILITY = {
    "00-ingest":     "이제 불러온 제품 정보와 고객 후기를 확인할 수 있어요.",
    "00e-evidence":  "이제 첨부한 참고 문서에서 반영할 내용을 뽑아 제안한 것을 확인할 수 있어요.",
    "00g-guideline": "이제 비슷한 제품에서 좋았던 점을 정리한 참고 메모를 확인할 수 있어요.",
    "01-brief":      "이제 제품 핵심 정리(누구에게·무엇을·왜)를 눈으로 확인·보완할 수 있어요.",
    "02-concept":    "이제 내세울 메시지 후보를 눈으로 비교하고 고를 수 있어요.",
    "03-storyboard": "이제 상세페이지 구성안 초안을 눈으로 확인·수정할 수 있어요.",
    "04-keyvisual":  "이제 대표 이미지 시안을 눈으로 확인·수정할 수 있어요.",
    "done":          "이제 협회 자문용 패키지를 검토·제출할 수 있어요.",
}

# ── 신호등(소수의 평이 라벨): 됐어요 / 주의사항 / 막혔어요 / 정보 더 필요. 안전필수 결과의 표면화 ──
SIGNAL = {
    "ok":          "✅ 문제없이 됐어요",
    "review":      "⚠ 검토 권고",          # n 건은 signal_review(n) 으로 덧붙임
    "blocked":     "🚫 규정 점검을 통과하지 못했어요",
    "stuck":       "🛑 막혔어요 — 사람이 직접 봐야 해요",
    "need-info":   "ℹ 정보가 더 필요해요",
    "placeholder": "ℹ 자동 점검 기준이 아직 준비 중이에요 (사람 확인 필요)",
}

# ── placeholder-autopass(미제공 도메인) 표면화: 동작은 통과지만 진실은 '점검 안 함' → 반드시 알린다 ──
PLACEHOLDER_NOTE = ("아직 자동 점검 기준이 준비 중인 제품군이라, 이번엔 자동 통과로 처리했어요. "
                    "사람이 한 번 확인해 주세요.")

# ── 위험을 '결과'로 번역(gstack careful): 명령 이름이 아니라 사람에게 닥칠 일로 ──
RISK_AS_RESULT = {
    "unsupported":     "근거가 없어서 자동으로 뺐어요.",
    "ra-gate":         "담당자(RA) 확인을 거쳐야 승인돼요. 확인되면 운영자가 처리할게요.",
    "review-skip":     "지금 그냥 넘기면 근거 없는 효능 문구가 그대로 남아요.",
    "escalated":       "여러 번 고쳐도 통과가 안 돼 멈췄어요 — 사람이 봐야 합니다.",
}

# ── operator-voice 번역표(내부/개발어 → 현업어). 사람-설명용 SSoT. operator-voice.md 가 이 표를 인용 ──
TRANSLATION = {
    "working-backwards": "제품 핵심 정리(누구에게·무엇을·왜)",
    "ingest":            "자료 불러오기",
    "voc":               "고객 후기에서 뽑은 수치",
    "claim-basis":       "효능을 뒷받침하는 근거",
    "unsupported":       "근거가 없어서 자동으로 뺀 것",
    "reference-notes":   "비슷한 제품에서 좋았던 점을 적어둔 참고 메모",
    "concept-axes":      "광고에서 내세울 핵심 메시지",
    "storyboard":        "페이지 구성안(어떤 순서로 보여줄지)",
    "keyvisual":         "대표 이미지 시안",
    "review":            "규정에 맞는지 점검",
    "verdict":           "점검 결과",
    "violations":        "걸린 부분",
    "escalated":         "점검에서 막혀 사람이 봐야 하는 상태",
    "revise":            "표현 고치기·다시 만들기",
    "select":            "고르기",
    "recommendation":    "추천안",
    "approve":           "승인",
    "ra-ok":             "기능성 표시는 담당자 확인 후 승인",
    "placeholder":       "자동 점검 기준 준비 중 — 사람 확인 필요",
}


# ── 보완 제안/품질 경고(권고 계층) 단일 사전 ──────────────────────────────────
#   "없어도 막진 않지만 있으면 BM(상세페이지) 품질이 오르는 값"을 평이어로 제안/경고한다.
#   강제(fail-closed 게이트)와 분리된 '읽기전용 권고'이며 — 거짓 정량(예 "신뢰도 +30%")은 쓰지 않는다.
#   정직한 정성 문구 + '핵심 정보 N/M개' 카운트만 쓴다(근거 없는 단정 금지 = 환각 안전).
#   키 = completeness_advisor 가 검출하는 결손 항목. 값 = {propose: 채우면 좋은 이유, warn: 없을 때 영향,
#   projection: '이대로 진행하면' 뒤에 붙는 결과 절(결정적 렌더 결과만; 거짓 정량 금지)}.
ADVICE = {
    "clinical_change_pct": {
        "propose": "임상 측정값에 '전후 변화율(몇 % 변했는지)'을 함께 넣으면 결과가 한눈에 들어와요.",
        "warn":    "변화율이 없으면 임상 차트가 숫자 나열에 그쳐 설득력이 약해져요.",
        "projection": "차트가 전후 숫자만 나열돼, 얼마나 좋아졌는지 한눈에 안 들어와요.",
    },
    "clinical_p_value": {
        "propose": "임상 근거에 '통계적 유의성(p값)'을 넣으면 근거가 더 탄탄해 보여요.",
        "warn":    "p값이 없으면 임상 결과의 신뢰도를 보여주기 어려워요.",
        "projection": "결과가 우연이 아니라는 표시가 없어 '그냥 수치'로 보여요.",
    },
    "product_facts": {
        "propose": "가격·구성·성분 정보를 채우면 대표 이미지·본문 문구가 더 풍부해져요.",
        "warn":    "제품 사실 정보가 없으면 본문이 일반적인 문구에 머물러요.",
        "projection": "대표 이미지·본문이 일반적인 문구에 머물러, 경쟁 상세페이지와의 차별점이 잘 안 드러나요.",
    },
    "voc_keywords": {
        "propose": "고객 후기에서 자주 나온 표현을 넣으면 후기 기반 문구가 강해져요.",
        "warn":    "후기 표현이 없으면 후기 인용·공감 문구를 만들기 어려워요.",
        "projection": "고객 후기 공감 문구를 만들지 못해, 회사 자체 설명 위주로 남아요.",
    },
    "recommended_component": {
        "propose": "선택 구성요소(예: 구매 가이드·컬러칩)를 더하면 페이지가 더 충실해져요.",
        "warn":    "권장 구성요소가 빠지면 경쟁 상세페이지 대비 정보가 적어 보일 수 있어요.",
        "projection": "선택 구성요소가 빠져, 경쟁 상세페이지보다 정보가 적어 보일 수 있어요.",
    },
    "clinical_required": {
        "propose": "임상 시험 결과의 '시험기관·참여자수·시험기간·전후 측정값'을 채우면 측정 차트를 만들 수 있어요.",
        "warn":    "이 항목이 빠지면 측정 차트를 만들 수 없어요.",
        "projection": "측정 차트를 만들지 못해 '근거' 부분이 비거나 빠져요.",
    },
    "evidence_absent": {
        "propose": "임상 시험 결과(전·후 측정값과 시험기관·기간)를 등록하면 숫자로 뒷받침하는 '근거' 부분을 만들 수 있어요.",
        "warn":    "등록된 임상 근거가 없으면 측정 차트를 만들 수 없어요.",
        "projection": "측정 차트 없이 페이지가 만들어져, 숫자로 뒷받침하는 '근거' 부분이 없어요.",
    },
    "art_direction": {
        "propose": "전체 색감·톤을 먼저 정해두면 모든 블록 이미지가 한 분위기로 통일돼요.",
        "warn":    "전체 톤이 정해지지 않으면 블록마다 색감이 제각각이 될 수 있어요.",
        "projection": "블록마다 색감이 제각각이라, 페이지 전체 분위기가 흐트러져 보여요.",
    },
    "reference_composition": {
        "propose": "좋았던 참고 사례의 이미지 구도 메모를 남기면 대표 이미지 구도가 더 또렷해져요.",
        "warn":    "구도 메모가 없으면 이미지 구도가 일반적인 형태에 머물러요.",
        "projection": "이미지 구도가 일반적이라, 경쟁사 페이지와 비슷해 보일 수 있어요.",
    },
    "evidence_clinical_signal": {
        "propose": "인체적용시험·사용적합 같은 시험 결과 문서는 '시험성적서'로 선언하면 판정문·시험기관을 담은 전용 근거 블록으로 눈에 띄게 보여줄 수 있어요.",
        "warn":    "시험 결과 문서를 일반 참고자료로 두면 작은 각주로만 들어가 잘 안 보여요.",
        "projection": "시험 결과가 본문이 아니라 하단 각주 한 줄로만 들어가, 참고자료가 어떻게 반영됐는지 잘 안 보여요.",
    },
}

# ── 임상 차트 등 '필수값'이 빠졌을 때 무엇을 채울지 콕 집어주는 평이 라벨(강제 게이트 보완 안내) ──
#   강제 게이트는 그대로 막되, 운영자가 '무엇을' 채워야 하는지 코드(institution 등)가 아니라 평이어로 보여준다.
FILL_LABEL = {
    "institution":  "시험기관 이름",
    "sample_size":  "참여자 수(몇 명인지)",
    "duration":     "시험 기간(예: 4주)",
    "measured_pair": "측정 전·후 값",
    "metric":       "측정 항목 이름(예: 특정 측정 지표)",
    "disclaimer":   "개인차 안내 문구",
}

# ── 권고 섹션의 공통 경고(없으면 품질 저하 — 단, 진행은 가능) ──
QUALITY_GAP_NOTE = "이 정보들이 없어도 진행은 되지만, 채우면 상세페이지 품질이 올라가요."


# ── 이미지 생성 직전 '최종 점검' digest 정적 라벨(image_preflight·render_runmd·run-stage 공유) ──
#   비용·비가역 단계(이미지 실생성) 앞에서 결손→결과를 한 번 종합해 보여주는 화면의 단일 문구.
PREIMAGE = {
    "title":          "[대표 이미지 만들기 전 마지막 점검]",
    "runmd_header":   "이미지 생성 전 최종 점검 (예정 결과 미리보기)",
    "cost_note":      "(비용이 드는 작업이라 시작 전에 한 번 확인할게요.)",
    "intro":          "이대로 가면 결과가 어떻게 나올지 미리 알려드려요.",
    "must_header":    "■ 꼭 채우는 게 좋아요",
    "nice_header":    "■ 채우면 더 좋아요",
    "proj_prefix":    "→ 이대로 진행하면",
    "stopped_header": "■ 지금은 멈췄어요.",
    "fill_retry":     "정보를 채우고 다시 만들려면:",
    "proceed_anyway": "그래도 지금 이대로 진행하려면:",
    "ok":             "확인했어요. 이대로 대표 이미지 만들기를 진행할게요.",
    "proceed_ack":    "결손이 있지만 그대로 대표 이미지 만들기를 진행해요(확인 표시됨).",
}


# ── 누수 차단 안전망(외부리뷰 HIGH): 미등록 키 폴백이 내부 코드를 '그대로' 흘리지 않게 한다 ──
#   이 모듈의 존재 이유 = 현업 화면에 내부 코드를 안 보이게 하기. 따라서 어떤 입력이 와도
#   반환값에 금지 토큰이 섞이면 안 된다. 매핑된 값은 모두 금지 토큰이 없음(설계 + 테스트로 보장).
#   폴백(미등록 키)만 위험 → raw 대신 '누수 없는 일반 문구'로 치환한다.
#   ⚠ 'auto'·'iteration' 은 흔한 영단어라 substring 매칭은 오탐 위험 → 단어경계(\b)로만 잡는다.
#   회귀 가드(tests, 단계7)가 grep 하는 토큰 목록과 정렬돼야 한다.
_FORBIDDEN_RE = re.compile(
    r"(human-verify|hard-stop|scope=|pairwise|게이트=|상태=|escalated|\bauto\b|\biteration\b)")


def _safe(value, generic):
    """value 가 비었거나 금지 토큰을 포함하면 generic 으로 대체(누수 차단). 그 외엔 그대로."""
    if not value:
        return generic
    if _FORBIDDEN_RE.search(value):
        return generic
    return value


# 자유 텍스트(LLM 산출 rationale 등) 노출 전 검사용 — run.md 금지토큰 + 현업이 모를 흔한 내부 잭곤(영문 약어/심의 코드).
#   run.md 금지토큰만으론 claim-basis·verdict·VOC·N축 같은 잭곤을 못 거른다(외부리뷰 MEDIUM) → 자유텍스트는 더 넓게 본다.
#   ⚠ 단어경계(\b)를 쓰지 않는다: 한국어 조사 결합('VOC를'·'RTB가'·'iteration을')은 \w 경계가 안 생겨 \b 가 놓친다(외부 재리뷰).
#   자유텍스트 스크럽은 '과삭제'가 안전(사유 미노출 = 추천키만 표시)이므로, 잭곤은 부분일치로 공격적으로 잡는다.
#   영문 잭곤은 정상 한국어 사유(전부 한글)엔 안 나타나므로 오탐 위험이 낮다.
_FREETEXT_JARGON_RE = re.compile(
    r"(human-verify|hard-stop|scope=|pairwise|게이트=|상태=|escalat|auto|iteration"
    r"|claim[-_]?basis|verdict|violation|evidence[-_]?ref|VOC|RTB|mode\s*collapse|fail-closed"
    r"|[0-9]+\s*축|factual|restricted|substantiation)", re.I)


def scrub(text):
    """자유 텍스트(LLM rationale 등)를 현업 화면에 노출하기 전 안전 검사. 내부 잭곤이 섞였으면 ""(노출 안 함).
       run.md 추천 사유처럼 '모델이 쓴 문장'을 그대로 띄울 때, 금지어 가드를 우회하지 못하게 한다(외부리뷰 MEDIUM)."""
    return text if text and not _FREETEXT_JARGON_RE.search(text) else ""


# ── Python API ──
def phase_label(p):
    """페이즈 코드 → 평이 라벨. 미등록(동결 enum 밖 = 손상)은 raw 누수 대신 일반 문구."""
    return _safe(PHASE_LABEL.get(p), "현재 단계")


def gate_text(t):
    """게이트 종류 코드 → 현업 문장(없으면 빈 문자열 = 게이트 아님)."""
    return GATE_TYPE_TEXT.get(t, "") if t else ""


def status_label(s):
    return _safe(STATUS_LABEL.get(s), "진행 중")


def iteration_phrase(i, m):
    """'iteration N/M' 의 평이 대체. 1회차(여유 있음)는 굳이 횟수 강조 안 함."""
    try:
        i, m = int(i), int(m)
    except (TypeError, ValueError):
        return ""
    if i <= 1:
        return "처음 만드는 중"
    return "%d번째 다듬는 중 (최대 %d번까지)" % (i, m)


def scope_label(s):
    # 미등록 scope 는 표시 생략(""): 'scope=' 누수보다 안전. 알려진 코드만 평이 라벨.
    return _safe(SCOPE_LABEL.get(s), "")


def capability(p):
    return PHASE_CAPABILITY.get(p, "")


def signal(kind, n=None):
    """신호등 한 줄. review 는 건수(n)를 붙인다."""
    base = SIGNAL.get(kind, "")
    if kind == "review" and n is not None:
        try:
            if int(n) > 0:
                return "%s %d건" % (base, int(n))
        except (TypeError, ValueError):
            pass
    return base


def placeholder_note():
    return PLACEHOLDER_NOTE


def risk_as_result(kind):
    return RISK_AS_RESULT.get(kind, "")


def translate(term):
    """내부 용어(키) → 현업어. **미등록 키는 그대로 흘리지 않는다**(외부리뷰 HIGH): pass-through 하면
       max_iterations·gate_type·claim_basis 같은 내부 식별자가 누수된다. 미등록 → 빈 문자열(호출부가 판단).
       다른 reference 헬퍼(gate_text·capability·signal·risk_as_result)와 동일한 'miss=빈문자열' 계약."""
    return _safe(TRANSLATION.get(term, ""), "")


# ── 권고 계층 API(읽기전용) — completeness_advisor·render_runmd·next-action 공유 ──
def advise_fill(key):
    """권고 항목 키 → '채우면 좋은 이유' 한 줄. 미등록/금지토큰이면 빈 문자열(누수 차단)."""
    return _safe((ADVICE.get(key) or {}).get("propose"), "")


def quality_warn(key):
    """권고 항목 키 → '없을 때 품질 영향' 한 줄. 미등록/금지토큰이면 빈 문자열."""
    return _safe((ADVICE.get(key) or {}).get("warn"), "")


def advise_projection(key):
    """권고 항목 키 → '이대로 진행하면' 뒤에 붙는 결과 투영 한 줄(결정적 렌더 결과; 거짓 정량 없음).
       미등록/금지토큰이면 빈 문자열(누수 차단)."""
    return _safe((ADVICE.get(key) or {}).get("projection"), "")


def fill_label(key):
    """필수 결손 필드 코드(institution 등) → 무엇을 채울지 평이 라벨. 미등록은 빈 문자열(코드 누수 금지)."""
    return _safe(FILL_LABEL.get(key), "")


def quality_gap_note():
    return QUALITY_GAP_NOTE


def completeness_phrase(filled, total):
    """'핵심 정보 N/M개를 채웠어요' — 거짓 % 금지, 실제 카운트만. 유효하지 않으면 빈 문자열."""
    try:
        filled, total = int(filled), int(total)
    except (TypeError, ValueError):
        return ""
    if total <= 0 or filled < 0 or filled > total:
        return ""
    return "핵심 정보 %d/%d개를 채웠어요" % (filled, total)


def preimage_label(key):
    """이미지-직전 digest 정적 라벨 조회. 미등록/금지토큰이면 빈 문자열(누수 차단)."""
    return _safe(PREIMAGE.get(key), "")


def preimage_plan_phrase(total, image, chart, html_only=0):
    """예정 생성 장수 — 실제 카운트만(거짓 % 금지). 차트(표)·그래픽(HTML) 절은 0이면 생략.
       유효하지 않은 카운트는 빈 문자열. html_only=그림 대신 글·아이콘으로 HTML 에서 직접 만드는 블록."""
    try:
        total, image, chart, html_only = int(total), int(image), int(chart), int(html_only)
    except (TypeError, ValueError):
        return ""
    if min(total, image, chart, html_only) < 0:
        return ""
    extra = []
    if chart > 0:
        extra.append("측정 차트 %d개는 그림 대신 표로" % chart)
    if html_only > 0:
        extra.append("그래픽 %d개는 글·아이콘으로 HTML 에서 직접" % html_only)
    if extra:
        return "구성안 블록 %d개 중 %s 만들고, 그림 %d장을 새로 만들 예정이에요." % (total, ", ".join(extra), image)
    return "구성안 블록 %d개로 그림 %d장을 새로 만들 예정이에요." % (total, image)


# ── bash CLI: `operator_labels.py <fn> <args...>` → 평이 라벨 1줄 stdout ──
#   4동작 스크립트가 같은 사전을 조회한다(문자열 이원화 제거). 미지원 fn/키는 빈 줄(호출부 폴백).
def registered_domains_hint():
    """미선언·미등록 규제도메인 안내(평이) — 등록된 팩 목록 + 온보딩 제안(2부 1단계: cosmetic 폴백 폐지 대체).
    레지스트리(packs/*/domain.json)를 질의해 실제 등록 도메인 라벨을 나열한다(하드코딩 아님). fail-closed 안내에 붙인다.
    lazy import(로드시 kcia_engine 결합 회피)."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from kcia_engine import load_domain_registry
        doms = (load_domain_registry().get("domains", {}) or {})
        labels = ["%s(%s)" % ((doms[d] or {}).get("label") or d, d) for d in sorted(doms)]
        listed = ", ".join(labels) if labels else "(등록된 규제도메인 없음)"
    except Exception:
        listed = "(등록 목록 조회 실패)"
    return "지금 만들 수 있는 규제도메인: %s. 새 규제도메인은 packs 폴더에 팩을 추가해 온보딩하세요." % listed


def main(argv):
    if not argv:
        return 2
    fn, rest = argv[0], argv[1:]
    out = ""
    if fn == "phase":
        out = phase_label(rest[0]) if rest else ""
    elif fn == "gate":
        out = gate_text(rest[0] if rest else "")
    elif fn == "status":
        out = status_label(rest[0]) if rest else ""
    elif fn == "iter":
        out = iteration_phrase(rest[0], rest[1]) if len(rest) >= 2 else ""
    elif fn == "scope":
        out = scope_label(rest[0]) if rest else ""
    elif fn == "capability":
        out = capability(rest[0]) if rest else ""
    elif fn == "signal":
        out = signal(rest[0], rest[1] if len(rest) >= 2 else None) if rest else ""
    elif fn == "placeholder":
        out = placeholder_note()
    elif fn == "risk":
        out = risk_as_result(rest[0]) if rest else ""
    elif fn == "translate":
        out = translate(rest[0]) if rest else ""
    elif fn == "advise":
        out = advise_fill(rest[0]) if rest else ""
    elif fn == "warn":
        out = quality_warn(rest[0]) if rest else ""
    elif fn == "projection":
        out = advise_projection(rest[0]) if rest else ""
    elif fn == "fill":
        out = fill_label(rest[0]) if rest else ""
    elif fn == "completeness":
        out = completeness_phrase(rest[0], rest[1]) if len(rest) >= 2 else ""
    elif fn == "preimage":
        out = preimage_label(rest[0]) if rest else ""
    elif fn == "plan-line":
        out = preimage_plan_phrase(rest[0], rest[1], rest[2], rest[3] if len(rest) >= 4 else 0) if len(rest) >= 3 else ""
    elif fn == "registered-domains":
        out = registered_domains_hint()
    else:
        sys.stderr.write("operator_labels.py: 알 수 없는 fn '%s'\n" % fn)
        return 2
    sys.stdout.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
