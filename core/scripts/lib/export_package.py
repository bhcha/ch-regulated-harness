#!/usr/bin/env python3
"""export_package.py — 협회 광고자문 제출 패키지 생성 (B5 export / B7 c+).

시안 PNG + 근거 목록(grade·출처 표기) + 매체 구분 + 비법적 고지.
실증 근거 검색은 OpenAlex 직접 HTTP 실연동(온라인=실검색 · 오프라인/무네트워크=stub 폴백)이며, grade/출처와
함께 포함한다. OpenAlex 결과는 검증 전 발견 후보라 자동 인용되지 않고 채택 여부는 사람(현업/RA)이 판단한다.

사용: export_package.py <run_dir>
"""
import sys, os, shutil, json, hashlib, stat, errno

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_json, atomic_write_json, now_iso, sha256_file as _sha256_file  # noqa: E402
from check_evidence_reflection import reflected_map  # noqa: E402  (반영 블록 라벨 단일 출처 — done 게이트와 공용)

_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)       # FIFO open 이 writer 대기로 블록되지 않게(정규파일엔 무영향)

# 근거 검색 엔진(03-storyboard/sources/results.json 의 engine) → 협회 패키지 감사 상태 라벨.
#   값 매핑일 뿐 필드·스키마는 불변. 오프라인 stub_stage 는 engine="manual"(빈 결과) 라 "manual-mock" 이
#   유지돼 CI/골든 바이트가 불변이고, 온라인 OpenAlex 직접 HTTP 실검색은 "openalex-직접HTTP" 로 표기한다.
#   ("mcp" 는 폐기된 레거시 노선 — 현재 근거 경로는 직접 HTTP.) 미지 값은 원문 그대로 노출(감사 투명성).
_SOURCE_STATUS = {
    "manual":   "manual-mock",        # 오프라인/무네트워크 stub 폴백(빈 결과 · 결정적 CI/골든)
    "openalex": "openalex-직접HTTP",   # OpenAlex REST 직접 HTTP 실검색(검증 전 발견 후보 · 채택=사람/RA)
    "stub":     "stub-오프라인",        # openalex 엔진 stub 모드(무네트워크)
    "mcp":      "mcp-레거시",           # 폐기된 MCP 노선(직접 HTTP 로 대체)
}

# claim-basis evidence_on_file 의 상태 라벨 — **레코드 실출처(kind)** 기준(위 _SOURCE_STATUS 는 sources 검색엔진
#   감사 라벨이라 별개 도메인이다; 섞지 않는다). E-3: 종전 235행이 이 등록 실증에 검색엔진 라벨 "manual-mock" 을
#   하드코드해 사람 승인 실근거(인체적용시험 등)를 mock 으로 오표기했다. 여기서는 kind 로 '무엇이 등록됐는지'만
#   말한다 — 품질 보증 뉘앙스('검증됨' 등)는 배제(등록 사실만; 채택·적정성 판단은 제출자/RA). 미지 kind → "등록 근거".
_EVIDENCE_KIND_STATUS = {
    "clinical_trial": "인체적용시험(등록 실증)",
    "in_vitro":       "인체외시험(등록 실증)",
    "notification":   "신고·고시(등록)",
    "paper":          "문헌(등록)",
    "other":          "등록 근거",
}


def _fail(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(1)


def _read_fd_bounded(fd, size):
    """이미 연 fd 에서 최대 size+1 바이트만 읽는다(reopen-by-path 창 없음). size+1 상한은 경쟁 append/치환으로
    파일이 fstat 크기보다 커졌는지 감지하기 위함(반환 길이 != size 면 호출부가 fail-closed). 인입쪽
    ingest._read_fd_bounded 와 동형(신뢰 경계 단일 fd 읽기)."""
    limit = size + 1
    chunks = []
    got = 0
    while got < limit:
        chunk = os.read(fd, min(1 << 20, limit - got))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def _md_cell(s):
    """Markdown 표 셀 안전화(README 렌더 전용 — 저장 값·package.json·디스크는 불변):
       셀 구분자 `|` 이스케이프 + CR/LF 를 공백으로(셀 안 개행은 행을 깨뜨림)."""
    return str(s).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


# _sha256_file: harness.sha256_file 를 import (K-1 일원화 — 스트리밍 파일 해시)


def _reflect_evidence_documents(ev_src_dir, manifest_path, ev_exp_dir, rdir):
    """링크 C — 근거 문서 첨부 반영(정확집합 대조 → 안전순서 무결성 복사).
       매니페스트가 존재할 때만 호출. 반환: package.json evidence_documents 배열(매니페스트 순서).
       reflect:true 문서는 reflected_in(반영 블록 라벨)을 함께 기록(추적성) — 라벨 산출은 done 게이트와
       동일한 reflected_map 단일 출처(drift 방지)."""
    manifest = load_json(manifest_path)
    docs = manifest.get("documents", [])
    # 반영 블록 라벨: reflect:true doc-id 만 조회(reflect:false 는 반영 대상 아님 → []).
    _reflect_ids = [d["id"] for d in docs if isinstance(d, dict) and d.get("reflect") is True and d.get("id")]
    _rmap = reflected_map(rdir, _reflect_ids) if _reflect_ids else {}

    # (a) 정확집합 대조 선행(N7) — 복사 전에 디스크 정규파일 집합 == 매니페스트 filename 집합 + 각 sha256 일치.
    #     예약 사이드카 index.json·비정규 엔트리(심볼릭/디렉터리/특수) 제외.
    manifest_names = [d["filename"] for d in docs]
    manifest_set = set(manifest_names)
    if len(manifest_names) != len(manifest_set):
        _fail("[export 실패] 근거 목록(manifest)에 중복 파일명이 있습니다 — 인입(ingest)을 다시 실행하세요.")
    disk_set = set()
    if os.path.isdir(ev_src_dir):
        for name in os.listdir(ev_src_dir):
            if name == "index.json":            # 예약 사이드카(문서목록 제외)
                continue
            try:
                st = os.lstat(os.path.join(ev_src_dir, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):         # 정규파일만(심볼릭·디렉터리·특수 제외)
                disk_set.add(name)
    extra = sorted(disk_set - manifest_set)
    missing = sorted(manifest_set - disk_set)
    if extra or missing:
        parts = []
        if missing:
            parts.append("목록엔 있으나 파일이 없음: " + ", ".join(missing))
        if extra:
            parts.append("파일은 있으나 목록에 없음: " + ", ".join(extra))
        _fail("[export 실패] 근거 파일과 목록(manifest)이 어긋납니다 (%s) — 인입(ingest)을 다시 실행하세요." % " / ".join(parts))

    # (b) TOCTOU-안전 무결성 복사(F3, 인입 evidence-docs 와 동형 단일 fd): 소스 원본을 '한 번' 열고(O_NOFOLLOW)
    #     그 fd 하나에서 정규성·크기·바이트·sha256 을 모두 파생한다 — lstat/realpath 후 나중에 경로로 다시 여는
    #     창(그 사이 심볼릭/FIFO/대용량으로 스왑되면 '읽기 전 검사'가 무의미)이 없다.
    ev_root_real = os.path.realpath(ev_src_dir)
    os.makedirs(ev_exp_dir, exist_ok=True)
    result = []
    for d in docs:
        fn = d["filename"]
        src = os.path.join(ev_src_dir, fn)
        # ① realpath 경계검사(방어층·열기 전) — run-local inputs/evidence/ 직속 밖(치환된 링크 등) 거부.
        #    열기 시점의 권위적 심볼릭 차단은 아래 O_NOFOLLOW 지만, 경계 보장을 유지하려 이 확인도 남긴다
        #    (dir-root 심볼릭 가드[main]와 per-file O_NOFOLLOW 가 함께 경계를 앵커).
        src_real = os.path.realpath(src)
        if os.path.dirname(src_real) != ev_root_real:
            _fail("[export 실패] 근거 파일이 작업영역(inputs/evidence) 밖을 가리킵니다: %s" % fn)
        # ② 단일 fd 열기(O_NOFOLLOW → 최종 컴포넌트가 심볼릭이면 open 자체가 ELOOP 실패 = 스왑된 링크를
        #    따라가지 않음; O_NONBLOCK → 스왑된 FIFO 에서 블록되지 않음). 실패는 fail-closed.
        try:
            fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | _O_NONBLOCK)
        except OSError as e:
            if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                _fail("[export 실패] 근거 파일이 정규파일이 아닙니다(심볼릭/특수/디렉터리 거부): %s" % fn)
            _fail("[export 실패] 근거 파일 접근 불가: %s (%s)" % (fn, e.strerror or e.errno))
        try:
            # ③ fstat(연 fd) 로 정규파일 확인 — 경로가 아니라 '실제로 읽는 그 inode' 기준(디렉터리/FIFO/특수 거부).
            fst = os.fstat(fd)
            if not stat.S_ISREG(fst.st_mode):
                _fail("[export 실패] 근거 파일이 정규파일이 아닙니다(심볼릭/특수/디렉터리 거부): %s" % fn)
            # ④ 크기 == 매니페스트 bytes (fd 권위값; 바이트 읽기 전) — 스왑된 대용량/축소 파일을 여기서 거부.
            #    env-독립: 인입이 이미 상한을 적용·기록한 값이 진실(export 가 별도 상한 재적용 = raised-cap 오탐).
            if fst.st_size != d["bytes"]:
                _fail("[export 실패] 근거 파일 크기가 목록과 다릅니다(변조/치환 의심): %s (%d≠%d)" % (fn, fst.st_size, d["bytes"]))
            # ⑤ 이 fd 에서 bounded 읽기(size+1 상한) — 경쟁 append/치환으로 커졌으면 반환 길이 불일치로 감지.
            data = _read_fd_bounded(fd, fst.st_size)
        finally:
            os.close(fd)
        if len(data) != fst.st_size:
            _fail("[export 실패] 근거 파일을 읽는 중 크기가 바뀌었습니다(경쟁 수정 의심): %s" % fn)
        # ⑥ fd 에서 읽은 바이트로 sha256 재계산·매니페스트 대조(불일치 = 변조 fail-closed).
        src_sha = hashlib.sha256(data).hexdigest()
        if src_sha != d["sha256"]:
            _fail("[export 실패] 근거 파일 해시가 목록과 다릅니다(변조 의심): %s" % fn)
        # ⑦ 복사(같은 fd 에서 읽은 검증 바이트를 그대로 기록; 대상은 export 디렉터리 안이라 일반 open 으로 충분).
        dst = os.path.join(ev_exp_dir, fn)
        with open(dst, "wb") as f:
            f.write(data)
        # ⑧ 복사본(destination) 재해시로 사본 무결성 확인(불일치 = 복사 손상 fail-closed).
        if _sha256_file(dst) != src_sha:
            _fail("[export 실패] 근거 파일 복사본이 손상됐습니다: %s" % fn)
        entry = {
            "id": d["id"], "filename": fn, "grade": d.get("grade"),
            "sha256": d["sha256"], "bytes": d["bytes"],
            "linked_claim_ids": d.get("linked_claim_ids", []),
            "reflect": bool(d.get("reflect", False)),
        }
        if d.get("reflect") is True:
            # 반영 문서(reflect:true): 실증셋 편입 + 반영 블록 추적. reflected_in 은 done 게이트가 이미 비지-않음을
            #   보장한 뒤라 정상 경로에선 비어있지 않다(export 는 기록만; 강제 멈춤은 advance 게이트).
            entry["reflected_in"] = sorted(_rmap.get(d["id"], []))
        result.append(entry)
    return result


def main():
    rdir = sys.argv[1]
    kv = os.path.join(rdir, "04-keyvisual")
    exp = os.path.join(kv, "export", "kcia-package")

    sel = None
    dec = os.path.join(kv, "decision.json")
    if os.path.exists(dec):
        sel = load_json(dec).get("selected")
    if not sel:
        rec = os.path.join(kv, "recommendation.json")
        if os.path.exists(rec):
            r = load_json(rec).get("ranked", [])
            sel = r[0] if r else None

    # 선택 옵션이 실재해야 한다(없으면 빈 패키지 대신 실패 — Codex B5#7/B7#7)
    shots = os.path.join(kv, "options", sel or "", "shots")
    if not sel or not os.path.isdir(os.path.join(kv, "options", sel)):
        sys.stderr.write("[export 실패] 선택 옵션이 없습니다(decision/recommendation 확인).\n")
        sys.exit(1)

    # 시안 PNG: 선택 옵션의 현재 shots 만, 디렉터리 초기화 후 복사(stale/외부 PNG 유입 차단)
    if os.path.isdir(os.path.join(exp, "shots")):
        shutil.rmtree(os.path.join(exp, "shots"))
    os.makedirs(os.path.join(exp, "shots"), exist_ok=True)
    copied = []
    if os.path.isdir(shots):
        for fn in sorted(os.listdir(shots)):
            if fn.endswith(".png"):
                shutil.copy2(os.path.join(shots, fn), os.path.join(exp, "shots", fn))
                copied.append("shots/" + fn)
    if not copied:
        sys.stderr.write("[export 실패] 선택 옵션 '%s' 의 시안 PNG 가 없습니다(렌더 필요).\n" % sel)
        sys.exit(1)

    # ── 근거 문서 첨부 (링크 C) — orphan 가드(최우선) → stale rmtree(항상) → 조건부 반영 ──
    ev_src_dir = os.path.join(rdir, "inputs", "evidence")
    ev_manifest_path = os.path.join(rdir, "00-ingest", "evidence-documents.json")
    ev_exp_dir = os.path.join(exp, "evidence")
    has_manifest = os.path.exists(ev_manifest_path)

    # dir-symlink 방어(경계 앵커): inputs/evidence 자체가 심볼릭/비디렉터리로 치환되면 realpath 경계가
    #   그 타깃으로 이동해 per-file 검사가 무의미해진다(런 밖 파일을 이름·해시만 맞으면 패키징). 어떤 열거
    #   (orphan 가드·정확집합·복사)보다 먼저 lstat 으로 '진짜 in-run 디렉터리'인지 확인한다. 심볼릭 추적 금지.
    #   ★ 경로가 아예 없으면(no-evidence 런) no-op → 골든 바이트 불변.
    if os.path.lexists(ev_src_dir):
        dst = os.lstat(ev_src_dir)
        if stat.S_ISLNK(dst.st_mode):
            _fail("[export 실패] 근거 폴더(inputs/evidence)가 심볼릭 링크입니다 — 인입(ingest)을 다시 실행하세요.")
        if not stat.S_ISDIR(dst.st_mode):
            _fail("[export 실패] 근거 폴더(inputs/evidence)가 정규 디렉터리가 아닙니다 — 인입(ingest)을 다시 실행하세요.")

    # orphan 가드(N8, 매니페스트 판정 전 최우선): inputs/evidence 에 정규파일이 1개라도 있는데
    #   매니페스트가 부재하면 = 중단된 '첫 근거 추가'의 orphan → fail-closed(조용한 '근거 없음' 처리 금지).
    #   ★ '정규파일 존재'로 키(빈 디렉터리는 미발동) → no-evidence 런 골든 불변.
    if not has_manifest and os.path.isdir(ev_src_dir):
        for name in os.listdir(ev_src_dir):
            if os.path.isfile(os.path.join(ev_src_dir, name)):
                _fail("[export 실패] 근거 파일은 있는데 목록(manifest)이 없습니다 — 인입(ingest)을 다시 실행하세요.")

    # stale 정리(F2): export 진입 시 kcia-package/evidence/ 를 항상 rmtree 후 조건부 재생성
    #   (이전의 더 큰 근거셋에서 남은 stale 첨부 자기-정리). 없으면 no-op → no-evidence 골든 불변.
    if os.path.isdir(ev_exp_dir):
        shutil.rmtree(ev_exp_dir)

    evidence_documents = (
        _reflect_evidence_documents(ev_src_dir, ev_manifest_path, ev_exp_dir, rdir) if has_manifest else []
    )

    # 근거 목록 (claim-basis evidence + sources results) — grade/출처 표기
    cb = load_json(os.path.join(rdir, "00-ingest/claim-basis.json"))
    evidence = []
    for e in cb.get("evidence_on_file", []):
        evidence.append({"id": e["id"], "grade": e.get("grade"), "source": e.get("source"),
                         "summary": e.get("summary", ""),
                         "status": _EVIDENCE_KIND_STATUS.get(e.get("kind"), "등록 근거")})
    # D-4: 검색 발견 후보(OpenAlex)는 '산출물 인용 근거'(claim-basis evidence)와 **별개 목록**으로 분리한다 —
    #   미채택(산출물 미인용)·실증 아님을 RA 제출물에서 명확히(종전엔 한 표에 혼입돼 오해 소지). 결과 0건(오프라인
    #   engine=manual)이면 discovery=[] → 조건부 미방출 → 골든 바이트 불변.
    res = os.path.join(rdir, "03-storyboard/sources/results.json")
    evidence_engine = None   # sources 근거 엔진(evidence_note 를 엔진에 맞춤 — 자기모순 방지).
    discovery = []
    if os.path.exists(res):
        r = load_json(res)
        eng = r.get("engine")
        evidence_engine = eng
        src_status = _SOURCE_STATUS.get(eng, eng or "unknown")   # 엔진 → 감사 상태(오프라인 manual=불변)
        for x in r.get("results", []):
            discovery.append({"id": x["id"], "grade": x.get("grade"), "source": x.get("venue") or x.get("doi"),
                              "summary": x.get("title", ""), "status": src_status})

    # evidence_note 를 sources 엔진에 맞춘다: openalex(온라인 실검색)면 OpenAlex 노트, 그 외(manual/stub/무-sources)면
    #   원문 노트 → 오프라인 골든(engine=manual)은 바이트 불변이고, 온라인 openalex 런의 '수동 mock·후속' 자기모순은 제거(Codex).
    _evidence_note = ("실증 근거 검색은 OpenAlex 직접 HTTP 실연동(온라인=실검색)이며 grade/출처를 함께 표기함. "
                      "OpenAlex 결과는 검증 전 발견 후보라 자동 인용되지 않으며 채택 여부는 제출자(현업/RA)가 판단함."
                      ) if evidence_engine == "openalex" else \
                     "실증 근거는 수동 mock 상태일 수 있으며 grade/출처를 함께 표기함(자동 OpenAlex 연동은 후속)."
    # E-2: 미주장·배제 표현 확인 대장 — 어떤 표현이 왜 빠졌는지를 RA 가 한 곳에서 보게(종전엔 brief sensitive_labels·
    #   claim-basis unsupported_claims 에 산재, export 미수록). 결정적 수집(LLM 불개입) — 비어있으면 미방출(골든 불변).
    #   배제 = 승인(approved) 아닌 모든 기능성 상태(unknown=근거없음·not_claimed=미주장) + 미실증 효능어(unsupported).
    #   sensitive_labels(brief) 가 기능성+미실증을 이미 결합하나 real 브리프 미보장이라 claim-basis 로 보강, expression dedup.
    _EXCL_REASON = {"unknown": "미승인·근거 없음(주장 불가)", "not_claimed": "미주장(제기 안 함)", "unsupported": "미실증(근거 없음)"}
    exclusion_ledger = []
    _excl_seen = set()
    _bp = os.path.join(rdir, "01-brief/brief.json")
    if os.path.exists(_bp):
        for s in (load_json(_bp).get("sensitive_labels") or []):
            if not isinstance(s, dict) or not s.get("label") or s["label"] in _excl_seen:
                continue
            # ⚠ approved(주장됨) 라벨도 _excl_seen 에 등록 → 아래 unsupported_claims 패스에서 같은 표현이 '배제됨'으로
            #   재방출되는 모순 차단(Codex High: 승인 표현을 배제로 오표기 금지). 단 대장에는 non-approved 만 적재.
            _excl_seen.add(s["label"])
            if s.get("status") != "approved":
                exclusion_ledger.append({"expression": s["label"],
                                         "reason": _EXCL_REASON.get(s.get("status"), s.get("status") or "배제"),
                                         "source": "브리프"})
    for _u in (cb.get("unsupported_claims") or []):
        if _u and _u not in _excl_seen:
            _excl_seen.add(_u)
            exclusion_ledger.append({"expression": _u, "reason": "미실증(근거 없음)", "source": "인입(claim-basis)"})
    # E-4(Seam D): VOC(소비자 후기) 0건인데 reviewCapture 블록이 있으면 = 시험대상자 설문으로 대체 → 소비자
    #   오인 회색지대(RA 판단 필요). 오인 방지 고지('후기가 아닌'/'시험대상자'류) 존재 여부 병기. VOC>0(후기 있음)
    #   이면 미방출(골든 불변). 결정적 검사(LLM 불개입) — B-4(설문 수치 결박)와 함께 이 블록 리스크를 닫는다.
    review_capture_flag = None
    _vocj = load_json(os.path.join(rdir, "00-ingest/voc.json"))
    # ⚠ review_count 는 객체 {collected, site_total}(voc.schema) — collected 로 판정(스칼라도 후방호환).
    #   Codex High: 객체를 스칼라로 검사하면 항상 truthy 라 플래그가 안 켜진다. 비-숫자/미존재 = 미확정(플래그 안 켬, 보수적).
    _rcnt = _vocj.get("review_count") if isinstance(_vocj, dict) else None
    _collected = _rcnt.get("collected") if isinstance(_rcnt, dict) else _rcnt
    if isinstance(_collected, (int, float)) and _collected == 0:
        _rc_txt = []
        _pdir = os.path.join(rdir, "03-storyboard/plan")
        if os.path.isdir(_pdir):
            for _fn in sorted(os.listdir(_pdir)):
                if not _fn.endswith(".json"):
                    continue
                _blk = load_json(os.path.join(_pdir, _fn))
                if isinstance(_blk, dict) and _blk.get("type") == "reviewCapture":
                    _rc_txt.append((_blk.get("subcopy") or "") + " " + " ".join(_blk.get("bodyText") or []))
        if _rc_txt:
            _joined = " ".join(_rc_txt)
            _notice = any(tok in _joined for tok in ("후기가 아닌", "시험대상자", "참여자"))
            review_capture_flag = {"note": "소비자 후기 없음 — 시험대상자 설문으로 대체",
                                   "misperception_notice_present": _notice, "ra_check": True}
    func = {k: v["status"] for k, v in cb["functional_status"].items()}
    pkg = {
        "media": "인터넷 상세페이지",
        "selected_option": sel,
        "screenshots": copied,
        "functional_status": func,
        "evidence_list": evidence,
        "evidence_note": _evidence_note,
        "disclaimer": "본 패키지는 법적 통과 보증이 아니며 자율·비법적 사전 점검 자료입니다. 최종 책임은 제출자(현업/RA)에게 있습니다.",
        "generated_at": now_iso(),
    }
    # F5: 첨부 근거 문서는 실증 evidence_list 와 **별개 필드**(첨부 전송 ≠ 주장 실증; 실증셋 미편입).
    #     매니페스트 부재 시 키 자체가 없어야 골든 바이트 불변(present-but-empty·null 금지).
    if has_manifest:
        pkg["evidence_documents"] = evidence_documents
    # D-4: 검색 발견 후보 — 비어있으면 키 미추가(골든 바이트 불변; evidence_documents 와 동일 패턴).
    if discovery:
        pkg["discovery_candidates"] = discovery
    # E-2: 배제 대장 — 비어있으면 키 미추가(골든 바이트 불변).
    if exclusion_ledger:
        pkg["exclusion_ledger"] = exclusion_ledger
    # E-4: reviewCapture 대체 플래그 — None 이면 키 미추가(골든 불변).
    if review_capture_flag:
        pkg["review_capture_flag"] = review_capture_flag
    atomic_write_json(os.path.join(exp, "package.json"), pkg)

    L = ["# 협회 광고자문 제출 패키지\n\n",
         "- 매체: **인터넷 상세페이지**\n- 선택 시안: **%s**\n- 시안 PNG: %d장 (shots/)\n\n" % (sel, len(copied)),
         "## 기능성 표시 상태\n"]
    for k, v in func.items():
        L.append("- %s: **%s**\n" % (k, v))
    L.append("\n## 근거 목록 (grade·출처 표기)\n")
    if evidence:
        L.append("| id | grade | 출처 | 상태 | 요약 |\n|---|---|---|---|---|\n")
        for e in evidence:
            L.append("| %s | %s | %s | %s | %s |\n" % (e["id"], e.get("grade"), e.get("source"), e["status"], (e.get("summary") or "")[:40]))
    else:
        L.append("- 등록된 실증 근거 없음 → 실증 필요 표현은 카피에서 배제됨.\n")
    # D-4: 검색 발견 후보(미채택) — 산출물에 인용되지 않은 검색 결과. 실증 아님·자동 채택 아님(채택=사람/RA).
    #   비어있으면 절 자체를 미방출(골든 바이트 불변). OpenAlex 제목·저널은 외부 문자열이라 _md_cell 이스케이프.
    if discovery:
        L.append("\n## 검색 발견 후보 (미채택 — 산출물 미인용, 실증 아님)\n")
        L.append("> 실증 근거 검색(OpenAlex 등)에서 발견된 문헌 후보입니다 — **최종 산출물에 자동 인용되지 않았으며 "
                 "그 자체로 실증이 아닙니다**. 채택 여부는 제출자(현업/RA)가 판단합니다(위 '근거 목록'과 구분).\n\n")
        L.append("| id | grade | 출처 | 상태 | 요약 |\n|---|---|---|---|---|\n")
        for e in discovery:
            L.append("| %s | %s | %s | %s | %s |\n" % (
                e["id"], _md_cell(e.get("grade") or "-"), _md_cell(e.get("source") or "-"),
                _md_cell(e["status"]), _md_cell((e.get("summary") or "")[:40])))
    # 첨부 근거 문서 표 — 기존 텍스트 근거표(WB 추출)와 **별개 절**. 매니페스트 있을 때만 렌더.
    if has_manifest:
        L.append("\n## 첨부 근거 문서\n")
        L.append("> **첨부-전용(반영 ✗)**: 파일 전송이며 주장 실증이 아닙니다(위 근거 목록과 별개). "
                 "**반영(반영 ✓)**: 최종 산출물의 '반영 블록'에 내용이 실렸습니다 — 시험성적서(test_report)는 위 "
                 "**근거 목록에 `doc-NN` 실증으로 편입**(판정문 원문으로 단정어 제한), 그 밖의 **일반 참조 문서는 근거 목록에 "
                 "편입되지 않고 해당 블록에 각주로 인용**됩니다(실증 아님, 반영 포인트 원문 반영).\n\n")
        L.append("| id | 파일명 | grade | bytes | sha256(축약) | 연결 주장 | 반영 | 반영 블록 |\n"
                 "|---|---|---|---|---|---|---|---|\n")
        for e in evidence_documents:
            # free-text 셀(파일명·grade·연결·반영블록)은 표 구분자를 담을 수 있어 렌더 시 이스케이프(저장 값은 불변).
            #   id/bytes/sha256 은 형식 제약(doc-NN·정수·hex)이라 원본 그대로.
            links = _md_cell(", ".join(e["linked_claim_ids"])) if e["linked_claim_ids"] else "-"
            grade = _md_cell(e["grade"]) if e["grade"] is not None else "-"
            reflected = e.get("reflect") is True
            refl_blocks = _md_cell(", ".join(e.get("reflected_in") or [])) if (e.get("reflected_in")) else "-"
            L.append("| %s | %s | %s | %d | %s | %s | %s | %s |\n" % (
                e["id"], _md_cell(e["filename"]), grade, e["bytes"], e["sha256"][:12], links,
                "✓" if reflected else "✗", refl_blocks))
    # E-2: 미주장·배제 표현 확인 대장 — 비어있으면 절 미방출(골든 불변). 사전 점검 기록이며 법적 판정이 아님(고지 병기).
    if exclusion_ledger:
        L.append("\n## 미주장·배제 표현 확인 대장\n")
        L.append("> 워킹백워드에 있었으나 **산출물에서 제기하지 않은/배제한** 표현과 그 사유입니다 — "
                 "사전 점검 기록이며 법적 판정이 아닙니다(최종 책임은 제출자/RA).\n\n")
        L.append("| 표현 | 배제 사유 | 출처 단계 |\n|---|---|---|\n")
        for x in exclusion_ledger:
            L.append("| %s | %s | %s |\n" % (
                _md_cell(x.get("expression") or "-"), _md_cell(x.get("reason") or "-"), _md_cell(x.get("source") or "-")))
    # E-4: reviewCapture 대체 확인 — None 이면 절 미방출(골든 불변).
    if review_capture_flag:
        _rc_notice = "포함" if review_capture_flag["misperception_notice_present"] else "미포함(확인 필요)"
        L.append("\n## reviewCapture 대체 확인 (소비자 후기 없음)\n")
        L.append("> 소비자 후기가 0건이라 후기 자리를 **인체적용시험 시험대상자 설문**으로 대체했습니다. "
                 "소비자 오인 관점의 회색지대이므로 **RA 확인을 권장**합니다. "
                 "오인 방지 고지('후기가 아닌 시험대상자 설문'류) 존재: **%s**.\n" % _rc_notice)
    L.append("\n> %s\n" % pkg["disclaimer"])
    open(os.path.join(exp, "README.md"), "w", encoding="utf-8").write("".join(L))
    print("[export] kcia-package 생성: 시안 %d장 · 근거 %d건%s · 매체=인터넷 상세페이지" % (
        len(copied), len(evidence), (" · 첨부문서 %d건" % len(evidence_documents)) if has_manifest else ""))


if __name__ == "__main__":
    main()
