#!/usr/bin/env python3
"""evidence_search.py — 온라인 실증 근거 검색 배선(스크립트-측, 생성 단계 전용).

storyboard-outline 에서 실증 트리거(claim)를 **스크립트가 직접 감지**해 실 OpenAlex 검색을 돌리고,
03-storyboard/sources/{query.json,results.json} 을 결정적으로 (재)작성한다. run-stage.sh 가 **온라인
(STUB_MODE!=1)** 에서만 호출한다 — 오프라인(STUB_MODE=1) 골든 경로는 여기 도달하지 않는다(stub_stage.py 가
결정적 mock 을 쓰고, run-stage.sh 의 STUB_MODE 가드가 이 헬퍼 호출을 막는다).

설계 근거:
  · 트리거 스크립트-측 권위(fail-open 우회 제거): 에이전트가 쓴 query.json 존재에 **의존하지 않고**
    stub_stage._detect_triggers(rdir) 로 스스로 트리거를 감지한다. 에이전트가 트리거가 있는데 query.json 을
    빠뜨려도 스크립트가 (재)작성·검색하므로 실검색을 조용히 건너뛸 수 없다(규제상 fail-closed).
  · 항상 재검색(mock 신뢰 안 함·stale 제거): 기존 results.json 의 engine:"openalex" 마커를 신뢰해 스킵하지 않는다 —
    스키마가 provenance 를 증명 못 해 insession 에이전트가 그 마커를 위조하면 mock 근거 우회가 된다(Codex 규제 지적).
    run-stage.sh 가 '생성이 일어난 시점'(NEED_GENERATE!=0 또는 insession)에만 이 헬퍼를 호출하고, 여기서 매번 실검색으로
    덮어써 에이전트 mock 을 신뢰하지 않는다. 재개/no-op 은 run-stage 가드가 호출을 막아 안정적이고, claim 이 바뀌면
    항상 현재 claim 으로 재검색하므로 옛-claim stale 논문도 자연히 제거된다. claim 이 None(무-트리거)면 빈 sources 로 정리.
  · 결정론(스크립트-측): state.json 미접촉 — 오직 03-storyboard/sources/ 만 쓴다(AGENTS 절대규칙 1번).
  · 환각 안전: OpenAlex 결과는 **미검증 발견 후보**다. evidence_sufficient 기본 false·grade 자동인용 0 은
    openalex.py 가 처리하고, 이 헬퍼는 검색 결과를 기록만 한다(자동 근거채택 없음 — 채택은 사람/RA 게이트).
  · fail-closed: 엔진 자체 실패(네트워크/타임아웃/파싱)는 예외로 전파 → run-stage.sh 가 die(무음 stub 강등 금지).
    "결과 0건"은 예외가 아니라 정상(results:[], evidence_sufficient:false — 주장 불가)이며 정상 종료한다.
  · 프롬프트 무수정: 에이전트가 insession 에 쓴 sources mock 은 placeholder 이며, 이 헬퍼가 결정적으로 덮어쓴다.

사용법: evidence_search.py <run_id> <run_dir> <engine>
  engine = resolve_evidence_engine 결과(온라인=openalex). engine!=openalex 면 no-op(오프라인 stub 은 호출 안 됨).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import atomic_write_json  # noqa: E402
import openalex  # noqa: E402
import stub_stage  # noqa: E402  # _detect_triggers 재사용(스크립트-측 트리거 권위). import 부작용 = design-tokens 로드만(네트워크 0).

# stub_stage.run_stub(378-380)과 **동일 포맷·키순서**의 query.json 을 결정적으로 (재)작성하기 위한 상수.
_QUERY_FILTERS = {"grade": ["SCI/SCIE", "전문학회지"], "lang": ["ko", "en"]}


def _query_doc(claim, triggers):
    """오프라인 stub 의 query.json 과 동일 스키마·키순서(claim/triggers/filters/limit)."""
    return {"claim": claim, "triggers": triggers, "filters": _QUERY_FILTERS, "limit": 5}


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: evidence_search.py <run_id> <run_dir> <engine>\n")
        return 2
    _rid, rdir, engine = argv[0], argv[1], argv[2]
    # 실검색은 openalex 엔진일 때만(오프라인 stub 은 run-stage.sh 의 STUB_MODE 가드로 여기 도달 안 함 — 방어적 no-op).
    if engine != "openalex":
        return 0
    sdir = os.path.join(rdir, "03-storyboard", "sources")
    qpath = os.path.join(sdir, "query.json")
    rpath = os.path.join(sdir, "results.json")

    # ── 스크립트-측 트리거 권위(fail-open 우회 제거) ──
    #   에이전트의 query.json 존재/내용에 의존하지 않고 스스로 트리거를 감지한다(stub 오프라인과 동일 감지기).
    #   query.json 은 스크립트가 결정적으로 (재)작성한다 — 에이전트 mock 을 무시(트리거 권위는 스크립트).
    triggers = stub_stage._detect_triggers(rdir)
    claim = triggers[0] if triggers else None
    os.makedirs(sdir, exist_ok=True)
    atomic_write_json(qpath, _query_doc(claim, triggers))

    # ── 무-트리거(안전 카피): 실검색 안 함 + stale 정리 ──
    #   claim=None 이면 검색할 게 없다. 옛 openalex/에이전트 mock 이 남아 있으면 결정적 빈 sources 로 정리
    #   (오프라인 무-트리거 의미와 일관: {"results":[],"evidence_sufficient":false,"engine":"manual"}).
    if not (isinstance(claim, str) and claim.strip()):
        atomic_write_json(rpath, openalex.search_stub(claim, engine="manual"))
        return 0

    # ── 트리거 있음: 실 OpenAlex 검색을 '항상' 수행해 sources 를 스크립트-측 결과로 덮어쓴다 ──
    #   ★ 규제 안전(Codex): 기존 results.json 의 engine:"openalex" 마커를 신뢰해 스킵하지 않는다 — 스키마가
    #     provenance 를 증명하지 못하므로 insession 에이전트가 그 마커를 위조해 mock 근거를 심으면 우회가 된다.
    #     run-stage.sh 가 '생성이 일어난 시점'(NEED_GENERATE!=0 또는 insession)에만 이 헬퍼를 호출하고, 여기서
    #     매번 실검색으로 덮어써 에이전트 mock 을 신뢰하지 않는다(재개/no-op 은 run-stage 가드가 호출을 막아 안정).
    #     이렇게 하면 claim 변경 시 stale 옛-논문도 자연히 제거된다(항상 현재 claim 으로 재검색).
    #   실 OpenAlex 검색 — 엔진 실패(네트워크/타임아웃/파싱)는 예외 전파 → 비-0 종료 → run-stage.sh fail-closed.
    #     "결과 0건"은 예외가 아니라 정상 반환(results:[], evidence_sufficient:false — 주장 불가).
    res = openalex.search(claim)   # {"results":[...], "evidence_sufficient":bool, "engine":"openalex"}
    atomic_write_json(rpath, res)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
