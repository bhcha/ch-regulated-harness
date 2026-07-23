#!/usr/bin/env python3
"""pack_lint.py — packs/<도메인>/ 팩 무결성 린트 (0단계 F).

파이프라인 산출물 바이트 무영향(검증 전용 — 팩 파일을 읽기만 하고 쓰지 않는다).
목적: registry.json:32 의 packs/*/ruleset.json → ruleset.schema.json 매핑이 실제로는 아무 테스트에도
안 걸려 있던 공백을 메운다. 팩이 '로더-동결 불변식'과 스키마를 지키는지 결정적으로 검사한다.

검사(팩 폴더별 — PACKS_DIR 아래 domain.json 을 가진 디렉터리):
  1. domain.json 구조 (로더 kcia_engine.load_domain_registry 의 broken 판정식을 그대로 미러):
       - JSON 파싱 가능 + 최상위가 객체(dict)               (kcia_engine.py:208 isinstance(raw, dict))
       - domain 키가 문자열이고 == 디렉터리명               (kcia_engine.py:209 e.get("domain") == name)
       - status 키가 문자열이고 ∈ 허용 enum                 (kcia_engine.py:208-209 + _VALID_STATUS:179)
     ↳ 필수 키 집합(domain·status)은 '로더가 실제로 읽어 검증하는 것'에서만 도출(발명 금지).
       label/law/critic_prompt 등은 로더 broken 판정에 안 들어가므로 필수화하지 않는다.
  2. ruleset.json (있으면) → registry.json 매핑 스키마(ruleset.schema.json)로 검증.
  3. status/ruleset 정합: status=='active' ⇒ ruleset.json 존재 + 스키마 통과.
     (tbd/ready-only 는 ruleset 부재가 정당 — placeholder-autopass. 예: health_food=ready-only 룰셋 없음.)
  4. adk_critic(있으면) 은 객체(dict) 여야 한다 — 존재-시 타입 가드뿐(필수화·구조강제 아님, 발명 회피).
  + 레지스트리 전역: default:true 를 선언한 팩은 최대 1개(둘 이상 = 로더 default 모호).

로더가 '손상 팩을 조용히 미완으로 강등'(status=""·incomplete)하는 것과 달리, 이 린트는 같은 판정식을
'실패(nonzero exit)'로 승격시킨다 — 팩 회귀를 머지 게이트에서 잡기 위함.

사용법: python3 scripts/lib/pack_lint.py            # PACKS_DIR(env) 또는 core/ 형제 packs/ 기본
종속성 없음(표준 라이브러리 + harness.py/ kcia_engine.py 재사용).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))            # core/scripts/lib
# CORE_ROOT(=core/) 은 harness.ROOT 와 동치 — PACKS_DIR 은 harness 에서 import(K-1 일원화)
sys.path.insert(0, HERE)

import harness  # load_json · Validator · schema_for_path · HARNESS_DIR

# 로더-동결 status enum 은 단일 출처(kcia_engine._VALID_STATUS)를 그대로 재사용 → 표류·재발명 방지.
try:
    import kcia_engine
    VALID_STATUS = set(kcia_engine._VALID_STATUS)
except Exception:  # pragma: no cover — 로더 import 실패 시 동결값으로 폴백(로더 kcia_engine.py:179 와 동일)
    VALID_STATUS = {"active", "tbd", "ready-only"}

# PACKS_DIR: harness 에서 import (K-1 일원화 — core/ 형제 packs/ 해석 단일 출처. PACKS_DIR env 재정의는 harness 가 존중).
PACKS_DIR = harness.PACKS_DIR


def _validate_ruleset(path, rel_for_schema):
    """ruleset.json 을 registry.json 매핑 스키마로 검증. (ok: bool, detail: str)."""
    schema_name = harness.schema_for_path(rel_for_schema)
    if schema_name is None:
        return False, "registry.json 에 매칭되는 스키마 없음 (%s)" % rel_for_schema
    try:
        data = harness.load_json(path)
    except Exception as e:
        return False, "JSON 파싱 오류: %s" % e
    schema = harness.load_json(os.path.join(harness.HARNESS_DIR, schema_name))
    v = harness.Validator(schema)
    v.validate(data, schema)
    if v.errors:
        return False, "스키마 위반(%s): %s" % (schema_name, "; ".join(v.errors[:4]))
    return True, "스키마 통과(%s)" % schema_name


def lint_pack(name, pdir, failures):
    """팩 하나 검사 → (checks: list[(ok, label)], declares_default: bool)."""
    checks = []
    declares_default = False

    def add(ok, label):
        checks.append((ok, label))
        if not ok:
            failures.append("%s: %s" % (name, label))

    dj = os.path.join(pdir, "domain.json")

    # 1a. 파싱 + 최상위 dict (loader:208 isinstance(raw, dict))
    raw = None
    parse_ok = True
    try:
        raw = harness.load_json(dj)
    except Exception as e:
        parse_ok = False
        add(False, "domain.json JSON 파싱 실패: %s" % e)
    if not parse_ok:
        return checks, declares_default
    is_dict = isinstance(raw, dict)
    add(is_dict, "domain.json 최상위가 객체(dict)")
    if not is_dict:
        return checks, declares_default  # 아래 키 검사는 dict 전제

    declares_default = bool(raw.get("default"))

    # 1b. domain == 디렉터리명 (loader:209 e.get("domain") == name)
    dom = raw.get("domain")
    add(isinstance(dom, str) and dom == name,
        "domain 필드가 문자열이고 디렉터리명과 일치 (domain=%r, dir=%r)" % (dom, name))

    # 1c. status 문자열 ∈ enum (loader:208-209 + _VALID_STATUS:179)
    st = raw.get("status")
    st_ok = isinstance(st, str) and st in VALID_STATUS
    add(st_ok, "status 가 문자열이고 허용 enum %s 에 속함 (status=%r)"
        % (sorted(VALID_STATUS), st))

    # 4. adk_critic 존재-시 타입 가드(dict) — 필수화·구조강제 아님
    if "adk_critic" in raw:
        ac = raw.get("adk_critic")
        add(isinstance(ac, dict), "adk_critic(존재 시)가 객체(dict)")
        # 선택 키 retry(있으면) = 비음 정수(빈응답 flaky 흡수 횟수; 미지정=코드 기본 8). 팩이 자기 엔드포인트
        #   flakiness 프로파일을 선언 — 우선순위: env ADK_CRITIC_RETRY > 팩 retry > 기본 8(O-2/D-1).
        if isinstance(ac, dict) and "retry" in ac:
            rv = ac.get("retry")
            add(isinstance(rv, int) and not isinstance(rv, bool) and rv >= 0,
                "adk_critic.retry(있으면)가 비음 정수 (retry=%r)" % (rv,))
        # 선택 키 author_aliases(있으면) = 비어있지 않은 문자열 배열. adk_critic 이 응답 provenance(author)
        #   안전 슈퍼셋을 하드코딩 대신 전 팩 선언(author + author_aliases)에서 조립한다 — 무주지 author
        #   (예: guideline_review_agent)의 홈. 우선순위/의미는 adk_critic._known_authors 참조.
        if isinstance(ac, dict) and "author_aliases" in ac:
            av = ac.get("author_aliases")
            add(isinstance(av, list) and all(isinstance(x, str) and x.strip() for x in av),
                "adk_critic.author_aliases(있으면)가 비어있지 않은 문자열 배열 (author_aliases=%r)" % (av,))

    # 2·3. ruleset.json — registry 매핑 스키마 검증 + status=active 정합
    rp = os.path.join(pdir, "ruleset.json")
    rel_for_schema = "packs/%s/ruleset.json" % name  # registry.json:32 매칭 경로(정본 상대형)
    ruleset_present = os.path.exists(rp)
    if ruleset_present:
        ok, detail = _validate_ruleset(rp, rel_for_schema)
        add(ok, "ruleset.json %s" % detail)
    if st_ok and st == "active":
        # status=active ⇒ 실심의 → ruleset 반드시 존재하고 스키마 통과여야 함(빈 폴백 오심의 방지).
        if not ruleset_present:
            add(False, "status=active 인데 ruleset.json 부재(실심의 룰셋 필수)")
        # (존재 시 스키마 통과 여부는 위 2번 검사가 이미 add — 중복 add 회피)
    return checks, declares_default


def main():
    if not os.path.isdir(PACKS_DIR):
        sys.stderr.write("[pack-lint] PACKS_DIR 이 디렉터리가 아닙니다: %s\n" % PACKS_DIR)
        return 2

    failures = []
    default_decls = []
    scanned = 0
    print("# pack-lint — %s" % PACKS_DIR)
    for name in sorted(os.listdir(PACKS_DIR)):
        pdir = os.path.join(PACKS_DIR, name)
        if not os.path.isdir(pdir):
            continue
        dj = os.path.join(pdir, "domain.json")
        if not os.path.exists(dj):
            continue  # domain.json 없는 비-도메인 팩(_format 등)은 대상 아님
        scanned += 1
        checks, declares_default = lint_pack(name, pdir, failures)
        if declares_default:
            default_decls.append(name)
        allok = all(ok for ok, _ in checks)
        print("\n[%s] %s" % (name, "OK" if allok else "FAIL"))
        for ok, label in checks:
            print("  %s %s" % ("✓" if ok else "✗", label))

    # 전역: default:true 는 최대 1개 (loader:210-211 — 둘 이상이면 default 모호)
    print("\n[registry] default 선언 팩: %s" % (default_decls or "(없음)"))
    if len(default_decls) > 1:
        failures.append("registry: default:true 를 선언한 팩이 2개 이상 (%s)" % default_decls)
        print("  ✗ default:true 팩은 최대 1개여야 함")
    else:
        print("  ✓ default:true 팩 %d개(≤1)" % len(default_decls))

    print("\n검사한 팩 수: %d" % scanned)
    if scanned == 0:
        sys.stderr.write("[pack-lint] domain.json 을 가진 팩이 하나도 없습니다: %s\n" % PACKS_DIR)
        return 2
    if failures:
        print("\n== pack-lint: 실패 %d건 ==" % len(failures))
        for f in failures:
            print("  - " + f)
        return 1
    print("\n== pack-lint: 전체 통과 ✓ ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
