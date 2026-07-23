#!/usr/bin/env python3
"""adk_critic.py — 원격 ADK(GCP guideline_agent) 심의 어댑터 (KCIA_CRITIC_ENGINE=adk-http).

kcia-check.sh 의 Pass-A/B critic 호출체(로컬 CLI claude/codex)를 '원격 HTTP 심의'로 대체한다.
로컬 critic 과 **동일한 출력 계약**을 충족한다:
  - passa: 전체(선택안) 산출물 심의 → verdict.json 스키마를 `--out`($PASSA)에 작성.
  - passb: 후보 1건 적대검증 → {"refuted": <bool>, "reason": "<한 줄>"} 를 `--out`($PBF)에 작성.

설계 근거: docs/adk-critic-build-plan.md · scratchpad adk-critic-replacement-plan.md(v6, Codex CLEAN).

도메인별 엔드포인트(개편): 단일 ADK_CRITIC_URL/ADK_CRITIC_APP 폐기 → 도메인 packs/<dom>/domain.json 의 adk_critic
블록({url_env,host_env,app,author})이 'ADK 구현됨' 마커다. URL/host 는 그 url_env/host_env 가 가리키는 환경변수에서 읽는다.
  - resolve(--domain): 네트워크 없이 ADK 가용성만 판정 — exit 0(URL stdout)=구현+설정됨, 3=설정오류, 4=미구현(블록 없음).
  - 블록이 없는 도메인(예: drug)은 호출부가 resolve 로 걸러 ADK 를 생략(룰엔진-단독)한다 — passa/passb/preflight 진입 전 차단.

격리/안전 (생성≠심의, AGENTS.md 1-4):
  - ADK = 다른 벤더(Gemini)·원격 세션 → 로컬 FS 미접근, 텍스트 심의 격리 성립.
  - OFFLINE 가드(HARNESS_OFFLINE=1 → 미동작) · 도메인 url_env 필수 + host_env allowlist + https
    (테스트만 ADK_CRITIC_ALLOW_LOCAL=1 로 http/localhost) · DNS-IP 공인성(사설/loopback/메타데이터 거부).
  - outbound allowlist: '선택안 광고 카피 텍스트'만 전송. claim-basis/VOC/거절옵션/inputs-bundle/
    작업영역-밖 경로/이미지 비전송(텍스트만 심의 — 시각물 동일벤더 self-grading 차단).
  - 응답 provenance(author/app) 검증 · retry-on-empty(첫 턴 빈응답 flaky 흡수).
  - 유효 violation-axis 는 도메인 ruleset.json 에서 런타임 로드(설정키 lexicon 제외), 미존재 축 hard-fail.
  - stdlib only · 원자적 쓰기 · 실패 시 nonzero exit(REQUIRED fail-closed 발동).
"""
import argparse
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

# 도메인 레지스트리 로더(packs/*/domain.json 우선 조립). HARNESS_ROOT 를 읽어 PACKS_DIR 을 잡으므로,
# 호출부(kcia-check.sh)가 HARNESS_ROOT 를 export 해야 한다(없으면 _adk_cfg 가 fail-closed).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kcia_engine import load_domain_registry  # noqa: E402


def _die(msg):
    sys.stderr.write("adk_critic: %s\n" % msg)
    sys.exit(2)


def _env(name, default=None):
    v = os.environ.get(name)
    return v if (v is not None and v != "") else default


# ── 도메인별 ADK 설정(domain.json 의 adk_critic 블록 = 'ADK 구현됨' 마커) ──────────
_ADK_CFG_KEYS = ("url_env", "host_env", "app", "author")


def _adk_cfg(domain):
    """도메인의 adk_critic 설정 dict 반환(load_domain_registry 경유). 블록이 없으면 None(호출부가 판정).
    블록이 있으면 4키(url_env/host_env/app/author)를 모두 가져야 한다 — 하나라도 누락이면 _die(설정 손상 fail-closed)."""
    if not os.environ.get("HARNESS_ROOT"):
        _die("HARNESS_ROOT 미설정 — 도메인 레지스트리(packs/*/domain.json)를 찾을 수 없습니다(호출부가 export 해야 함).")
    try:
        reg = load_domain_registry()
    except Exception as e:
        _die("도메인 레지스트리 로드 실패: %s" % e)
    entry = (reg.get("domains") or {}).get(domain)
    if not isinstance(entry, dict):
        _die("도메인 '%s' 가 레지스트리에 없습니다 — 알 수 없는 도메인(fail-closed)." % domain)
    cfg = entry.get("adk_critic")
    if cfg is None:
        return None
    if not isinstance(cfg, dict):
        _die("도메인 '%s' 의 adk_critic 이 객체가 아닙니다(설정 손상, fail-closed)." % domain)
    missing = [k for k in _ADK_CFG_KEYS if not (isinstance(cfg.get(k), str) and cfg.get(k).strip())]
    if missing:
        _die("도메인 '%s' 의 adk_critic 에 필수 키 누락: %s (필요: %s)" % (domain, missing, list(_ADK_CFG_KEYS)))
    return cfg


def _known_authors():
    """등록된 전 도메인의 adk_critic 선언에서 알려진 심의 author 집합(응답 provenance 안전 슈퍼셋).
    각 도메인 adk_critic.author + author_aliases(선택)의 합집합 — 하드코딩 슈퍼셋을 팩 선언에서 조립한다
    (무주지 author 는 팩 author_aliases 로 홈 지정). 레지스트리 로드 실패 시 빈 집합 → 호출부는 {author}
    만으로 판정(더 엄격, fail-closed). HARNESS_ROOT 는 _adk_cfg 경로에서 이미 강제됨."""
    known = set()
    try:
        reg = load_domain_registry()
    except Exception:
        return known
    for entry in (reg.get("domains") or {}).values():
        if not isinstance(entry, dict):
            continue
        cfg = entry.get("adk_critic")
        if not isinstance(cfg, dict):
            continue
        a = cfg.get("author")
        if isinstance(a, str) and a.strip():
            known.add(a.strip())
        for alias in (cfg.get("author_aliases") or []):
            if isinstance(alias, str) and alias.strip():
                known.add(alias.strip())
    return known


# ── 엔드포인트/격리 가드 ──────────────────────────────────────────────
_METADATA_HOSTS = {"metadata.google.internal"}


def _resolve_endpoint(domain):
    """도메인별 ADK URL 검증: domain.json adk_critic.url_env/host_env 로 URL/host 를 읽음 →
    https + host allowlist + DNS-IP 공인성. (url_base, host) 반환. adk_critic 미존재면 die(호출부가 위에서 걸러야 함)."""
    if _env("HARNESS_OFFLINE", "0") == "1":
        _die("HARNESS_OFFLINE=1 — 원격 심의 비활성(오프라인). stub/baseline 으로 강등은 kcia-check 가 처리.")
    cfg = _adk_cfg(domain)
    if cfg is None:
        _die("도메인 '%s' 에 adk_critic 설정이 없습니다(미구현) — preflight/passa 호출 전에 resolve 로 걸러야 합니다." % domain)
    url_env, host_env = cfg["url_env"], cfg["host_env"]
    url = _env(url_env)
    if not url:
        _die("%s 미설정 — 도메인 '%s' 원격 심의 엔드포인트가 필요합니다(fail-closed)." % (url_env, domain))
    allow_local = _env("ADK_CRITIC_ALLOW_LOCAL", "0") == "1"
    m = re.match(r"^(https?)://([^/:]+)(?::(\d+))?(/.*)?$", url.strip())
    if not m:
        _die("%s 형식 오류: %r" % (url_env, url))
    scheme, host, port, _path = m.group(1), m.group(2), m.group(3), m.group(4)
    if scheme != "https" and not (allow_local and scheme == "http"):
        _die("%s 은 https 여야 합니다(테스트만 ADK_CRITIC_ALLOW_LOCAL=1 + http). 현재 scheme=%s" % (url_env, scheme))
    allowed_host = _env(host_env)
    if allowed_host:
        if host != allowed_host:
            _die("%s host(%s) 가 allowlist(%s=%s)와 다릅니다 — 임의 URL 거부(fail-closed)." % (url_env, host, host_env, allowed_host))
    elif not allow_local:
        _die("%s 미설정 — 임의 엔드포인트 차단(fail-closed). 배포 host 를 명시하세요(테스트는 ADK_CRITIC_ALLOW_LOCAL=1)." % host_env)
    # DNS-IP 공인성 검사(rebinding/메타데이터/사설망 차단). 테스트(ALLOW_LOCAL)는 면제.
    if not allow_local:
        if host in _METADATA_HOSTS:
            _die("%s host 가 메타데이터 호스트입니다 — 거부(fail-closed)." % url_env)
        try:
            infos = socket.getaddrinfo(host, port or 443, proto=socket.IPPROTO_TCP)
        except socket.gaierror as e:
            _die("%s host DNS 해석 실패: %s" % (url_env, e))
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            # is_global 만 허용(Codex 9R): 사설·loopback·link-local·예약·CGNAT(100.64/10)·메타데이터 등 비-글로벌 전부 거부.
            if not ip.is_global or ip.is_multicast:
                _die("%s host 가 글로벌 라우팅 불가 IP(%s) 로 해석됩니다 — 거부(SSRF/사설/CGNAT/rebinding 방지, fail-closed)." % (url_env, ip))
    base = "%s://%s%s" % (scheme, host, (":" + port) if port else "")
    return base, host


def _auth_header():
    """ADK_CRITIC_AUTH=oidc 면 ID 토큰 헤더(현재 배포는 공개 no-auth → 기본 none)."""
    mode = _env("ADK_CRITIC_AUTH", "none")
    if mode == "none":
        return {}
    if mode == "oidc":
        tok = _env("ADK_CRITIC_ID_TOKEN")
        if not tok:
            _die("ADK_CRITIC_AUTH=oidc 인데 ADK_CRITIC_ID_TOKEN 미설정(fail-closed).")
        return {"Authorization": "Bearer %s" % tok}
    _die("ADK_CRITIC_AUTH 는 none|oidc 여야 합니다(현재: %s)." % mode)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트 거부 — 사전 검증한 allowlist host 밖으로 요청이 새지 않게(SSRF/DNS-rebinding 우회 차단).
       redirect_request 가 None → urllib 이 3xx 를 HTTPError 로 올린다(→ _run_agent 가 재시도/die).
       ⚠ 잔여(문서화): pre-check DNS 와 urllib 의 실제 connect 해석 사이 TOCTOU(rebinding)는 IP-핀으로 완전봉인하지
       않았다. 완화 = (a) host allowlist(고정 Cloud Run host) + (b) DNS-IP 공인성 검사 + (c) 리다이렉트 거부.
       고정 공개 엔드포인트 가정에서 수용 가능 — 임의 host 운용 시 IP-핀(연결 IP 고정) 후속 필요."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _post(base, path, body, headers):
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json"}
    h.update(headers)
    timeout = int(_env("ADK_CRITIC_HTTP_TIMEOUT", "300"))
    req = urllib.request.Request(base + path, data=data, headers=h, method="POST")
    with _OPENER.open(req, timeout=timeout) as r:
        return getattr(r, "status", 200), r.read().decode("utf-8", "replace")


def _resolve_retries(cfg):
    """빈응답/첫 턴 flaky 흡수 재시도 횟수. 우선순위: 명시 env ADK_CRITIC_RETRY > 팩 adk_critic.retry
    > 코드 기본 8(D-1, E2E 실측 안정값). 성공 시 조기 종료 루프라 정상 경로 비용 0.
    E2E 실측: 일부 엔드포인트가 첫 턴 빈 모델 텍스트를 지속 반환 → 기본 3 으론 소진 fail-closed 반복."""
    env_v = _env("ADK_CRITIC_RETRY")            # 미설정/빈문자열이면 None
    if env_v is not None:
        return int(env_v)
    pack_v = cfg.get("retry") if isinstance(cfg, dict) else None
    if pack_v is not None:
        return int(pack_v)
    return 8


def _retry_backoff():
    """재시도 간 지수 백오프 대기열(초, C-1) = `ADK_CRITIC_RETRY_BACKOFF` 콤마목록(기본 `2,5,10`).
    소진 시 마지막 값 유지. NanoBanana `image_engine._nb_backoff` 와 **동형**(엔진별 병렬 — adk_critic 은
    HARNESS_ROOT·레지스트리·파일 I/O 와 의도적 import 격리라 공유 헬퍼 대신 미러; 근거=E2E 실측 콜드스타트
    빈응답을 즉시 24회 두드리던 문제 처방). 빈/비정상 값은 기본으로 폴백. 도메인 무관(전 팩 공통).
    ⚠ 온라인 전용 경로 — 오프라인/stub 은 ADK 를 안 타므로 골든 바이트 무영향."""
    raw = _env("ADK_CRITIC_RETRY_BACKOFF", "2,5,10") or "2,5,10"
    out = []
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except ValueError:
            continue
        if v >= 0:
            out.append(v)
    return out or [2.0, 5.0, 10.0]


def _run_agent(base, host, app, author, instruction, parse_fn, retries=8):
    """세션 생성 → /run. 빈응답/구조화-블록 누락 flaky 를 retry 로 흡수한다(둘 다 재시도 — 메모리: 첫 턴 빈응답·
    비결정 출력이 잦음). parse_fn(text) 이 None 이면 재시도, 비-None 이면 그 결과를 반환. provenance 불일치는 즉시 die.
    app/author 는 도메인 adk_critic 블록에서 온다(app=/apps/<app>/.. 경로, author=응답 provenance 기대값).
    retries 는 호출부가 _resolve_retries(cfg) 로 계산해 넘긴다(env > 팩 > 기본 8)."""
    headers = _auth_header()
    user = "harness"
    allow_local = _env("ADK_CRITIC_ALLOW_LOCAL", "0") == "1"
    backoff = _retry_backoff()      # C-1: 재시도 간 지수 백오프(콜드스타트 빈응답을 즉시 두드리지 않음)
    last_err = None
    for attempt in range(retries + 1):
        if attempt > 0:             # 첫 시도는 즉시, 이후 재시도만 백오프 대기(소진 시 마지막 값 유지)
            time.sleep(backoff[min(attempt - 1, len(backoff) - 1)])
        sid = "kcia-%s-%d" % (_env("ADK_CRITIC_SID_SEED", ""), attempt) if _env("ADK_CRITIC_SID_SEED") else None
        if sid is None:
            # 결정성 불필요(원격) — 시도별 고유 세션. time 은 여기서만(스크립트 골든 경로 밖).
            sid = "kcia-%x-%d" % (int(time.time() * 1000) & 0xFFFFFFFF, attempt)
        try:
            _post(base, "/apps/%s/users/%s/sessions/%s" % (app, user, sid), {}, headers)
        except urllib.error.HTTPError as e:
            if e.code not in (200, 409):  # 409=이미 존재
                last_err = "세션 생성 HTTP %d" % e.code
                continue
        body = {"appName": app, "userId": user, "sessionId": sid,
                "newMessage": {"role": "user", "parts": [{"text": instruction}]}, "streaming": False}
        try:
            _status, resp = _post(base, "/run", body, headers)
        except urllib.error.HTTPError as e:
            last_err = "/run HTTP %d: %s" % (e.code, e.read().decode("utf-8", "replace")[:300])
            continue
        except (urllib.error.URLError, socket.timeout) as e:
            last_err = "/run 네트워크 오류: %s" % e
            continue
        try:
            events = json.loads(resp)
        except Exception:
            last_err = "/run 응답 JSON 파싱 실패"
            continue
        if not isinstance(events, list) or not events:
            last_err = "빈 이벤트 응답(flaky)"
            continue
        # provenance: 알려진 ADK 심의 에이전트가 응답했는지(author). 불일치 = 잘못된 엔드포인트/되프록시 → 즉시 die(재시도 무의미).
        #   도메인이 선언한 author 를 1차 기대값으로, 등록 팩 전체의 author(+author_aliases)를 안전 슈퍼셋으로(하드코딩 폐기 — 팩 선언에서 조립).
        authors = {e.get("author") for e in events if isinstance(e, dict)}
        known = {author} | _known_authors()
        if not (authors & known) and not allow_local:
            _die("응답 provenance 검증 실패 — 알려진 ADK 심의 에이전트(author)가 아닙니다(fail-closed). authors=%s" % sorted(a for a in authors if a))
        text = _final_text(events)
        if not text.strip():
            last_err = "빈 모델 텍스트(첫 턴 flaky)"
            continue
        result = parse_fn(text)
        if result is None:
            last_err = "응답에서 구조화 블록(json)을 찾지 못함(flaky)"
            continue
        # F-1(Seam D): 성공까지 소비한 재시도 수를 감사 출력(stderr) — 종전엔 24회 재시도 성공이 1회와
        #   구분 안 돼 flaky 비용이 완전 불가시였다. stdout(결과)엔 무영향(별도 채널), 온라인 전용(골든 무관).
        if attempt > 0:
            sys.stderr.write("adk_critic: 심의 성공 · 재시도 %d회 소비(flaky 흡수)\n" % attempt)
        return result
    _die("원격 심의 실패(재시도 %d회 소진): %s" % (retries, last_err))


def _final_text(events):
    """이벤트들에서 모델 텍스트를 이어붙인다."""
    out = []
    for e in events:
        if not isinstance(e, dict):
            continue
        for p in (e.get("content") or {}).get("parts") or []:
            if isinstance(p, dict) and isinstance(p.get("text"), str):
                out.append(p["text"])
    return "\n".join(out)


# ── outbound allowlist(egress 경계): 선택안 '광고 카피 텍스트'만 외부(GCP)로 보낸다 ────────────────
#   3중 방어(Codex CRITICAL): ① 내부/근거/메타 '컨테이너 키' 아래로는 내려가지 않는다(구조적 차단 — 그 아래
#   카피처럼 보이는 내부 텍스트도 비전송), ② id/경로/근거 '참조 키' 값은 건너뛴다, ③ 값 자체가 내부 출처 토큰
#   (claim-basis·voc.json·func-*·사후검수·option_distribution·inputs/ 등)을 포함하면 통째로 버린다(값 백스톱).
#   → claim-basis/VOC/근거 id/RA 메모/경로/PII 가 외부 심의기로 새지 않는다(완전성보다 안전 우선).
_DENY_KEYS = re.compile(
    r"(?i)(evidence|claim[_-]?basis|claimbasis|basis|\bvoc\b|source|sources|"
    r"\bid\b|_id$|ref$|_ref|path|file|url|href|src|handoff|schema|manifest|engine|hash)")
_SKIP_CONTAINERS = {
    "internal_faq", "external_faq", "faq", "notes", "note", "handoff_note", "handoff",
    "footnote", "footnotes", "evidence", "evidences", "claim_basis", "claimbasis",
    "sensitive_labels", "sensitive", "sensitive_confirmation", "regulatory", "regulatory_notes",
    "rationale", "recommendation", "sources", "source", "voc", "meta", "schema",
    "manifest", "provenance", "basis", "analysis", "example_analysis", "reference_notes",
}
_INTERNAL_TOKEN = re.compile(
    r"claim[- _]?basis|voc\.json|\bvoc\b|evidence|\bev-\w|option_distribution|\bfunc-[a-z0-9]|"
    r"unsupported|not_claimed|사후검수|inputs/|claim_strength|review_status", re.I)  # 대소문자 무시(Codex 2R)
_MAX_TEXT = 40000  # 텍스트 상한(대용량 덤프 금지 — 추출된 카피 단위)
# ★ positive allowlist(default-deny, Codex 6R): 문자열은 '광고 카피 키' 아래에 있을 때만 수집한다.
#   denylist 추적(visual.concept.reference.direction·voc_phrase 등 스키마-합법 비카피 필드 누수)을 근본 차단.
_COPY_KEYS = {
    "headline", "subhead", "subheadline", "sub_headline", "subheading", "subheading_copy",
    "body", "bodytext", "body_text", "copy", "subcopy", "sub_copy", "text",
    "caption", "lead", "cta", "tagline", "title", "hook", "slogan", "summary",
    "key_message", "keymessage", "message", "rtb", "claim", "label", "desc", "description",
    "point", "benefit", "headline_copy", "name",
}


def _collect_copy(obj, acc, under_copy=False, depth=0):
    if depth > 12 or sum(len(s) for s in acc) > _MAX_TEXT:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            # 내부/근거/메타/비주얼 컨테이너 — 구조적 차단(그 아래로 내려가지 않음). 정확 일치 + 패턴.
            # 'claim' 부분일치는 제외(claims[].text 는 핵심 광고 카피 — 심의 대상). claim_basis/claimbasis 는
            #   'basis' 부분일치로, claim_strength 는 positive-allowlist(비카피 키 → 값 미수집)로 각각 차단된다.
            if (kl in _SKIP_CONTAINERS or kl.endswith("_notes") or kl.endswith("_faq")
                    or "footnote" in kl or "evidence" in kl or "rationale" in kl
                    or "basis" in kl or "visual" in kl or "voc" in kl or "concept" in kl
                    or "reference" in kl or "direction" in kl or "handoff" in kl):
                continue
            if _DENY_KEYS.search(kl):
                continue  # id/경로/근거 참조 값
            # leaf-only(Codex 7R): under_copy 를 '전파'하지 않는다 — 중첩 dict 의 키마다 새로 판정.
            #   {"copy":{"internal_note":"내부 가격"}} → 'copy' 아래로 내려가도 'internal_note' 는 카피 키가 아니라 미수집.
            _collect_copy(v, acc, (kl in _COPY_KEYS), depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            _collect_copy(v, acc, under_copy, depth + 1)   # 리스트는 부모 카피키 컨텍스트 유지(copy:[..], claims[].text)
    elif isinstance(obj, str):
        if not under_copy:
            return  # default-deny: 광고 카피 키 아래의 문자열만 외부로 보낸다
        s = obj.strip()
        if len(s) < 2:
            return
        if re.match(r"^[\w./:-]+$", s) and " " not in s:
            return  # 순수 id/경로/해시 토큰은 카피가 아님
        if _INTERNAL_TOKEN.search(s):
            return  # 값 백스톱: 내부 출처(근거/VOC/경로)를 언급하는 문자열은 외부로 보내지 않는다
        acc.append(s)


_META_FILES = re.compile(  # 카피가 아닌 메타데이터/근거/심의/매니페스트 파일 — 파일 단위 차단(Codex 3R)
    r"(?i)(verdict|manifest|decision|sensitive[-_]?confirmation|\bvoc\b|claim[-_]?basis|"
    r"\bproduct\b|sources|results|canon[-_]?coverage|reference[-_]?notes|assets|recommendation|"
    r"self[-_]?review|report|\bstate\b|feedback|example[-_]?analysis|analysis|provenance)")
# ★ positive FILE allowlist(default-deny, Codex 7R): 디렉터리 모드에서 '알려진 카피 산출물 파일'만 읽는다.
#   임의로 심어진 비카피 .json(예 options/A/leak.json) 인입 차단. 페이즈 카피 파일: brief / key-message /
#   storyline / NN-<type>(스토리보드 블록) / index.html(키비주얼 렌더).
_COPY_FILES = re.compile(r"(?i)^(brief|key[-_]?message|storyline|index|\d+[-_]\w+)\.(json|html)$")


class _CopyHTMLParser(HTMLParser):
    """키비주얼 렌더 HTML 의 '가시 텍스트'(=광고 카피)만 추출. script/style/head/noscript 는 건너뛰고,
    값 백스톱(_INTERNAL_TOKEN)·순수 토큰 필터를 동일 적용한다(속성/주석 미수집 → src·data-* 등 비전송)."""
    def __init__(self):
        super().__init__()
        self.out = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head", "noscript"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head", "noscript") and self._skip > 0:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip:
            return
        s = data.strip()
        if len(s) < 2:
            return
        if re.match(r"^[\w./:-]+$", s) and " " not in s:
            return
        if _INTERNAL_TOKEN.search(s):
            return
        self.out.append(s)


def _selected_copy_text(target):
    """선택안 경로(파일 또는 디렉터리)의 JSON 산출물에서 광고 카피 텍스트만 수집(메타데이터 파일·심링크 차단)."""
    # 최상위 심링크 차단(Codex 8R HIGH): 디렉터리 심링크면 os.walk 가 그대로 따라가 작업영역 밖 파일을 egress 할 수 있다.
    if os.path.islink(target):
        _die("심의 대상 경로가 심링크입니다(거부, 작업영역 탈출 방지): %s" % target)
    root_real = os.path.realpath(target)   # realpath 봉쇄 기준(조상 심링크까지 정규화됨)
    # 신뢰 루트 봉쇄(Codex 9R HIGH): root_real(조상 심링크 정규화 후)이 작업영역(HARNESS_ROOT) 밖이면 거부 —
    #   조상 경로 심링크로 root_real 이 외부를 가리켜도 여기서 fail-closed. (kcia-check 가 HARNESS_ROOT 를 export.)
    _ws = os.environ.get("HARNESS_ROOT")
    if _ws:
        ws_real = os.path.realpath(_ws)
        if root_real != ws_real and not root_real.startswith(ws_real + os.sep):
            _die("심의 대상이 작업영역(HARNESS_ROOT) 밖입니다(거부, 조상 심링크 탈출 방지): %s" % target)
    files = []
    if os.path.isfile(target):
        if _META_FILES.search(os.path.basename(target)):
            _die("단일 심의 대상이 메타데이터 파일입니다(카피 아님, 거부): %s" % target)   # Codex 4R: 단일파일 우회 차단
        files = [target]
    elif os.path.isdir(target):
        skip_dirs = {"bundle", "images", "rejected", "shots", "export"}
        for root, _dirs, names in os.walk(target):  # followlinks=False(기본) → 디렉터리 심링크 미추적(탈출 차단)
            # 하위 descent 자체를 막는다(prune) — continue 만으론 skip 디렉터리의 '하위'가 traverse 됨(Codex 5R HIGH).
            _dirs[:] = [d for d in _dirs if d not in skip_dirs and not os.path.islink(os.path.join(root, d))]
            base = os.path.basename(root)
            if base in skip_dirs:
                continue  # target 자체가 skip 디렉터리인 최초 진입(원본 번들·거절안·렌더 PNG·export 비전송)
            for n in sorted(names):
                p = os.path.join(root, n)
                if os.path.islink(p):
                    continue
                if _META_FILES.search(n):
                    continue  # 메타데이터/근거/심의 파일 — 카피 아님(방어 1)
                if not _COPY_FILES.match(n):
                    continue  # 알려진 카피 산출물 파일만(default-deny) — 임의 .json/.html 인입 차단(Codex 7R)
                rp = os.path.realpath(p)   # realpath 봉쇄(Codex 8R): 실제 경로가 대상 루트 밖이면 제외(탈출 방지)
                if rp != root_real and not rp.startswith(root_real + os.sep):
                    continue
                files.append(p)
    else:
        _die("심의 대상 경로가 없습니다(거부): %s" % target)
    acc = []
    for f in sorted(files):
        try:
            if f.endswith(".html"):
                with open(f, "r", encoding="utf-8") as fh:
                    pr = _CopyHTMLParser()
                    pr.feed(fh.read())
                for s in pr.out:
                    if sum(len(x) for x in acc) > _MAX_TEXT:
                        break
                    acc.append(s)
            else:
                with open(f, "r", encoding="utf-8") as fh:
                    _collect_copy(json.load(fh), acc)
        except Exception:
            continue
    text = "\n".join(acc)[:_MAX_TEXT]
    if not text.strip():
        # '심의할 광고 카피 없음'은 ADK 실패가 아니라 '리뷰할 대상이 없음'이다(예: 03-storyboard outline 은
        #   블록 순서·intent 만 있는 구조 스켈레톤 — 광고 카피 필드가 없다). 이를 _die(2)=실패로 처리하면
        #   구현 도메인 auto-REQUIRED 가 fail-closed 시켜 정당한 단계가 막힌다(실 카피는 plan/keyvisual 에서 심의).
        #   → 전용 종료코드 7 로 'no-copy(benign skip)'를 알리고, kcia-check 가 룰엔진-단독으로 정상 진행한다.
        sys.stderr.write("adk_critic: 선택안 산출물에 심의할 광고 카피가 없습니다(구조 스켈레톤 — ADK 생략, 룰엔진-단독): %s\n" % target)
        sys.exit(7)
    return text


# ── 유효 violation-axis (도메인 ruleset 런타임 로드, 설정키 제외) ────────
#   lexicon(어휘 사전) · clinical_substantiation(임상 실증 표기 정책 데이터) = 위반 축이 아니라 엔진 설정 데이터.
_AXIS_CONFIG_KEYS = {"lexicon", "clinical_substantiation"}


def _valid_axes(ruleset_path):
    try:
        with open(ruleset_path, "r", encoding="utf-8") as fh:
            rs = json.load(fh)
    except Exception as e:
        _die("ruleset 로드 실패(%s): %s" % (ruleset_path, e))
    axes = rs.get("axes")
    if not isinstance(axes, dict) or not axes:
        _die("ruleset.axes 가 비었거나 형식 오류 — 미완 룰셋 fail-closed: %s" % ruleset_path)
    valid = {k for k in axes.keys() if k not in _AXIS_CONFIG_KEYS}
    if not valid:
        _die("ruleset 에 유효 violation-axis 가 없습니다: %s" % ruleset_path)
    return valid


# ── 도메인-인지 grounding (Issue 1): 룰셋의 금지표현·트리거 요약을 원격 instruction 에 주입 ──
#   원격 ADK 모델은 도메인 고유 금지어를 모르고 일반 상식에만 의존했다. 우리 쪽 규제 참조 텍스트(룰셋)는
#   egress 허용 대상이므로 instruction 문자열에 직조한다(run 산출물/claim-basis/VOC 는 _selected_copy_text 가 별도 처리).
#   fail-soft: 룰셋에 해당 필드가 없거나 비면 빈 문자열을 조용히 반환(절대 die 금지 — _valid_axes 가 axes 를 fail-closed 검증).
_GROUNDING_MAX = 1500   # instruction 비대화 방지 상한(초과 시 잘라 ' …'로 마감)


def _ruleset_grounding(ruleset_path):
    """ruleset.json 에서 도메인 대표 금지·주의·트리거 표현을 축별로 모아 한 단락(불릿)으로 요약.
    실재하는 banned/triggers 류 항목만 수집한다(가짜 키 생성 안 함). 어떤 예외든 빈 문자열로 폴백(보조 기능)."""
    try:
        with open(ruleset_path, "r", encoding="utf-8") as fh:
            rs = json.load(fh)
        axes = rs.get("axes")
        if not isinstance(axes, dict):
            return ""
        lines = []
        seen_axes = set()
        # 축별로 실재하는 deny-list 류 항목을 모은다(banned·triggers — 모델이 직접 매칭할 수 있는 표현 단서).
        for axis, spec in axes.items():
            if axis in _AXIS_CONFIG_KEYS or not isinstance(spec, dict):
                continue
            terms = []
            for key in ("banned", "triggers"):
                vals = spec.get(key)
                if isinstance(vals, list):
                    terms.extend(str(v).strip() for v in vals if isinstance(v, (str, int, float)) and str(v).strip())
            # 중복 제거(입력 순서 유지)
            uniq = list(dict.fromkeys(terms))
            if uniq:
                lines.append("- %s: %s" % (axis, ", ".join(uniq)))
                seen_axes.add(axis)
            # substantiation_required 에 satisfied_when 이 있으면 '허용 형태' 라인 추가.
            # 원격 모델이 실증 충족 수치 표현을 위반으로 오분류하지 않도록 안내한다.
            if axis == "substantiation_required":
                sw = spec.get("satisfied_when")
                if isinstance(sw, list) and sw:
                    lines.append("  허용 형태(위반 아님): %s" % ", ".join(str(s) for s in sw))
        if not lines:
            return ""
        body = "\n".join(lines)
        if len(body) > _GROUNDING_MAX:
            body = body[:_GROUNDING_MAX].rstrip() + " …"
        return ("이 도메인의 대표 금지·주의 표현(룰셋 발췌; 단어 매칭은 1차 단서일 뿐 전체 문맥으로 종합 판단):\n"
                "%s\n위 표현이나 그 변형이 보이면 위반 여부를 우선 검토하라." % body)
    except Exception:
        return ""   # fail-soft: grounding 은 보조일 뿐, 어떤 사유로도 심의를 막지 않는다


# ── ADK 응답(구조화 JSON 블록) → verdict.json 매핑 ─────────────────────
_SEV = {"low", "medium", "high"}


def _parse_json_block(text):
    """모델 텍스트에서 ```json ... ``` 펜스 블록(마지막 것)을 파싱. 없으면 None."""
    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    for b in reversed(blocks):
        try:
            return json.loads(b)
        except Exception:
            continue
    # 펜스 없이 마지막 {...} 시도(보수적).
    m = re.search(r"(\{[^{}]*\"violations\"[^{}]*\[.*\][^{}]*\})", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            return None
    return None


def _map_verdict(findings, valid_axes, engine):
    vios = []
    for f in (findings.get("violations") or []):
        if not isinstance(f, dict):
            continue
        axis = (f.get("axis") or "").strip()
        if axis not in valid_axes:
            _die("ADK 매핑 축 '%s' 가 도메인 유효 축%s 에 없습니다 — hard-fail(추측 매핑 금지)." % (axis, sorted(valid_axes)))
        sev = (f.get("severity") or "medium").strip().lower()
        if sev not in _SEV:
            sev = "medium"
        tgt = (f.get("target_text") or "").strip()
        if not tgt:
            continue
        reason = (f.get("reason") or f.get("rule") or "원격 심의 위반").strip()
        vios.append({
            "target_text": tgt[:500],
            "axis": axis,
            "rule": (reason[:300] + " (adk)") if "(adk)" not in reason else reason[:300],
            "severity": sev,
            "detected_by": "subagent",
            "suggested_rewrite": (f.get("suggested_rewrite") or "").strip()[:500],
        })
    return {
        "verdict": "fail" if vios else "pass",
        "engine": engine,
        "confidence": 0.85,
        "violations": vios,
        "escalate": False,
    }


def _atomic_write(path, obj):
    # 심의 크리틱 격리(다른 벤더·최소 의존)라 harness 를 import 하지 않고 자체 라이터를 유지한다.
    # K-1: 출력 바이트(개행 없음)는 보존하되 fsync 만 추가해 원자쓰기 fsync 유무를 일원화(값 불변).
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


# ── 서브커맨드 ────────────────────────────────────────────────────────
_AXES_GUIDE = (
    "각 위반의 axis 는 반드시 다음 중 하나여야 한다: %s. "
    "(의약품오인=drug_misperception, 기능성오인=functional_misperception, "
    "소비자기만/절대표현=consumer_deception, 실증필요=substantiation_required, "
    "전문/일반약구분=prescription_otc_distinction, 필수기재=mandatory_inclusion)")


# ── Pass-A/B instruction 조립 = 순수 함수(오프라인 골든·온라인 심의 공용 단일 출처) ──────
#   ⚠ 아래 두 함수는 원격 ADK 에 보내는 문자열을 '문자 단위로' 확정한다 — 도메인 어휘(axes·grounding)를
#   packs 로 이전하는 이후 단계에서도 이 문자열은 바이트 불변이어야 한다(회귀 가드 = tests/test-prompt-assembly.sh).
#   엔드포인트/네트워크와 무관(순수) → emit-instruction 오프라인 서브커맨드가 그대로 재사용한다.
def _build_passa_instruction(domain, ruleset, copy_text, valid_axes):
    axes_list = ", ".join(sorted(valid_axes))
    grounding = _ruleset_grounding(ruleset)   # 도메인-인지 근거(Issue 1). 비면 조용히 생략.
    grounding_block = ("\n" + grounding + "\n") if grounding else ""
    return (
        "당신은 '%s' 도메인의 광고 컴플라이언스 심의관입니다(생성 AI 와 다른 세션).\n"
        "아래는 한 광고 산출물의 카피 텍스트입니다. 해당 도메인 표시·광고 기준으로 심의하여 "
        "질병 치료·예방 암시, 의약품 오인, 기능성 오인, 소비자 기만/절대표현, 실증이 필요한 표현을 "
        "위반으로 식별하세요.\n"
        "단, 5요소(측정값 전/후 쌍 · 시험기관 · n수 · 시험기간 · 개인차 디스클레이머)를 동반한 수치 표현은 "
        "substantiation_required 의 '충족' 사례이지 위반이 아닙니다(p값은 있으면 함께 노출 권고이며 필수 조건은 아님) — "
        "단정적 효능 문장(예: '여드름이 낫는다')만 위반으로 봅니다.\n%s\n%s"
        "반드시 응답 마지막에 아래 스키마의 ```json 블록을 하나 출력하세요(이 블록만 기계 파싱됩니다):\n"
        "```json\n{\"violations\":[{\"target_text\":\"문제 문구\",\"axis\":\"<축>\","
        "\"severity\":\"low|medium|high\",\"reason\":\"왜 위반인지 한 줄\","
        "\"suggested_rewrite\":\"대안 표현(선택)\"}]}\n```\n"
        "위반이 없으면 violations 를 빈 배열로 두세요.\n\n===== 심의 대상 카피 =====\n%s"
    ) % (domain, _AXES_GUIDE % axes_list, grounding_block, copy_text)


def _build_passb_instruction(domain, ruleset, candidate):
    grounding = _ruleset_grounding(ruleset)   # 도메인 핵심 표현 힌트(Issue 1, 최소). 비면 생략.
    grounding_block = ("\n" + grounding + "\n") if grounding else ""
    return (
        "당신은 '%s' 도메인 광고 심의관입니다. 아래는 1차 심의가 '위반 후보'로 올린 단일 항목입니다. "
        "이 항목이 실제 위반인지 적대적으로 재검토하세요. 근거가 약하거나 일반 상식/허용 표현이면 반박(refute)하세요.\n%s"
        "반드시 응답 마지막에 아래 ```json 블록을 하나만 출력하세요:\n"
        "```json\n{\"refuted\": true 또는 false, \"reason\": \"한 줄 사유\"}\n```\n"
        "(refuted=true = 실제 위반이 아님/근거 부족, refuted=false = 실제 위반 확인)\n\n"
        "===== 검토 대상(단일 항목) =====\n%s"
    ) % (domain, grounding_block, candidate)


def _do_passa(args):
    cfg = _adk_cfg(args.domain)
    if cfg is None:
        _die("도메인 '%s' 에 adk_critic 설정이 없습니다(미구현) — 호출부가 resolve 로 걸러야 합니다." % args.domain)
    base, host = _resolve_endpoint(args.domain)
    valid = _valid_axes(args.ruleset)
    copy_text = _selected_copy_text(args.selected_artifact)
    instruction = _build_passa_instruction(args.domain, args.ruleset, copy_text, valid)
    def _pa_parse(text):
        b = _parse_json_block(text)
        return b if (b is not None and isinstance(b.get("violations"), list)) else None
    findings = _run_agent(base, host, cfg["app"], cfg["author"], instruction, _pa_parse, _resolve_retries(cfg))
    verdict = _map_verdict(findings, valid, _env("ADK_CRITIC_ENGINE_LABEL", "subagent"))
    _atomic_write(args.out, verdict)


def _do_passb(args):
    cfg = _adk_cfg(args.domain)
    if cfg is None:
        _die("도메인 '%s' 에 adk_critic 설정이 없습니다(미구현) — 호출부가 resolve 로 걸러야 합니다." % args.domain)
    base, host = _resolve_endpoint(args.domain)
    valid = _valid_axes(args.ruleset)  # 면제 검증(미완 룰셋이면 여기서 fail-closed)
    _ = valid
    cand = args.candidate
    instruction = _build_passb_instruction(args.domain, args.ruleset, cand)
    def _pb_parse(text):
        b = _parse_json_block(text)
        return b if (b is not None and isinstance(b.get("refuted"), bool)) else None
    block = _run_agent(base, host, cfg["app"], cfg["author"], instruction, _pb_parse, _resolve_retries(cfg))
    _atomic_write(args.out, {"refuted": bool(block["refuted"]), "reason": str(block.get("reason", ""))[:300]})


def _do_emit_instruction(args):
    """오프라인 골든용: Pass-A/B instruction 문자열만 조립해 stdout 에 출력(엔드포인트 resolve·네트워크 없음).
    온라인 심의(_do_passa/_do_passb)와 동일한 순수 함수(_build_pass*_instruction)를 쓰므로 문자열이 바이트 동일.
    axes/grounding 은 룰셋에서 직접 로드(레지스트리·HARNESS_ROOT 불요). copy_text/candidate 는 고정 placeholder 를
    받아 도메인 어휘(axes·grounding)만 달라지게 한다 — 이 스냅샷이 stage 2/5 어휘 이전의 안전망(바이트 불변)."""
    valid = _valid_axes(args.ruleset)   # 미완 룰셋이면 여기서 fail-closed(온라인과 동일 검증)
    if args.pass_ == "a":
        copy_text = args.copy_text if args.copy_text is not None else ""
        sys.stdout.write(_build_passa_instruction(args.domain, args.ruleset, copy_text, valid))
    else:  # choices=["a","b"] 로 argparse 가 이미 강제
        candidate = args.candidate if args.candidate is not None else ""
        sys.stdout.write(_build_passb_instruction(args.domain, args.ruleset, candidate))


def _do_preflight(args):
    """도메인별 엔드포인트 설정 사전검증(부모가 실심의 전 호출): offline·URL·host allowlist·https·공인IP·auth 모드.
    유효=exit0, 무효=_die(exit2). 자식 실패 후 '조용한 강등'(REQUIRED 우회)을 부모에서 선차단(Codex 2R HIGH)."""
    base, host = _resolve_endpoint(args.domain)   # adk_critic 미존재/공백/형식오류/비-allowlist/비-https/사설IP 모두 여기서 die
    _auth_header()                                # auth 모드(none|oidc) 유효성
    sys.stderr.write("adk_critic: preflight OK (%s)\n" % host)


def _do_resolve(args):
    """네트워크 없이 도메인 ADK '구현/설정' 여부만 판정(부모가 ADK 채택 분기에 사용). exit code 로 신호:
      0 = 구현 + 설정됨(adk_critic 블록 O + url_env 값 O) → URL 을 stdout 에 출력(부모가 ADK-HTTP 채택).
      3 = 설정오류(adk_critic 블록 O 인데 url_env 값 비었음) → 부모 fail-closed(구현됐는데 미설정).
      4 = 미구현(adk_critic 블록 X) → 부모는 ADK 생략, 룰엔진-단독.
    (3/4 는 2 와 겹치면 안 됨 — _die 가 hard-error 에 2 를 쓰므로.)"""
    cfg = _adk_cfg(args.domain)   # 블록은 있으나 키 손상이면 _adk_cfg 가 _die(exit2)
    if cfg is None:
        sys.stderr.write("adk_critic: 도메인 '%s' 에 adk_critic 블록이 없습니다(ADK 미구현) — 룰엔진-단독.\n" % args.domain)
        sys.exit(4)
    url = _env(cfg["url_env"])
    if not url:
        sys.stderr.write("adk_critic: 도메인 '%s' adk_critic 은 있으나 %s 값이 비었습니다(설정오류) — fail-closed.\n" % (args.domain, cfg["url_env"]))
        sys.exit(3)
    sys.stdout.write(url + "\n")
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(prog="adk_critic.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pf = sub.add_parser("preflight")
    pf.add_argument("--domain", required=True)
    rs = sub.add_parser("resolve")
    rs.add_argument("--domain", required=True)
    pa = sub.add_parser("passa")
    pa.add_argument("--selected-artifact", required=True)
    pa.add_argument("--domain", required=True)
    pa.add_argument("--ruleset", required=True)
    pa.add_argument("--phase", default="")
    pa.add_argument("--out", required=True)
    pb = sub.add_parser("passb")
    pb.add_argument("--candidate", required=True)
    pb.add_argument("--domain", required=True)
    pb.add_argument("--ruleset", required=True)
    pb.add_argument("--out", required=True)
    ei = sub.add_parser("emit-instruction")   # 오프라인 골든: instruction 문자열만 출력(네트워크 없음)
    ei.add_argument("--domain", required=True)
    ei.add_argument("--pass", dest="pass_", required=True, choices=["a", "b"])
    ei.add_argument("--ruleset", required=True)
    ei.add_argument("--copy-text", dest="copy_text", default=None)
    ei.add_argument("--candidate", default=None)
    args = ap.parse_args()
    if args.cmd == "preflight":
        _do_preflight(args)
    elif args.cmd == "resolve":
        _do_resolve(args)
    elif args.cmd == "passa":
        _do_passa(args)
    elif args.cmd == "passb":
        _do_passb(args)
    elif args.cmd == "emit-instruction":
        _do_emit_instruction(args)


if __name__ == "__main__":
    main()
