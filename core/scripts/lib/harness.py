#!/usr/bin/env python3
"""harness.py — 결정적 코어 라이브러리 (no-LLM).

서브커맨드:
  validate <file> [--schema NAME]   산출물 JSON을 (registry로 자동 매칭한) 스키마로 검증
  structdiff <a.json> <b.json>      두 JSON의 '구조(키 집합·타입)'만 비교 — 이식성 a1 판정
  jget <file> <dotted.path>         JSON 값 읽기 (없으면 비어있음/exit 1)
  jset <file> <dotted.path> <val>   원자적 쓰기 (임시파일→os.replace). val은 JSON literal
  now                               UTC ISO8601 타임스탬프

종속성 없음(표준 라이브러리만). jsonschema 미설치 환경 대응.
"""
import sys, os, json, re, datetime, fnmatch, hashlib, html

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HARNESS_DIR = os.path.join(ROOT, "harness")

# 모노레포: core/ 의 형제 packs/ (PACKS_DIR env 로 재정의 — 테스트/모노레포 split-brain 방지).
# FORMATS_DIR = format 다이얼 전용 비-도메인 팩(packs/_format/, domain↔format 분리).
# K-1: 이 두 경로 해석의 단일 출처(kcia_engine·ingest·stub_stage·check_canon·pack_lint·render 산재를 흡수).
PACKS_DIR = os.environ.get("PACKS_DIR") or os.path.join(os.path.dirname(ROOT), "packs")
FORMATS_DIR = os.environ.get("FORMATS_DIR") or os.path.join(PACKS_DIR, "_format")


# ───────────────────────── 공용 ─────────────────────────
def die(msg, code=1):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(code)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def deliverable_format(state):
    """산출물 포맷 단일 리더 — state dict → product.deliverable_format (없으면 multipage_bm).
    K-1: check_canon·kcia_engine·render·validate_storyboard 산재 리더 흡수. 호출부의
    try/except(state.json 로드 오류 폴백)는 그대로 유지되도록 헬퍼는 자체 예외처리를 두지 않는다."""
    return (state.get("product") or {}).get("deliverable_format") or "multipage_bm"


def is_number(x):
    """숫자(int/float)인지 — bool 은 int 의 서브클래스이므로 명시적으로 제외.
    K-1: 산재 _is_num/_isnum/_num(kcia_engine·validate_storyboard·completeness_advisor·stub_stage·ingest) 흡수."""
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def sha256_file(path, chunk=1 << 20):
    """파일 SHA-256 hexdigest(스트리밍). K-1: export_package·stub_stage 산재 _sha256_file 흡수.
    청크 크기는 해시 결과에 무관(스트리밍) — 기존 1MiB/64KiB 두 벌을 1MiB 로 통일(hexdigest 바이트 불변)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def html_escape(s):
    """HTML 이스케이프(quote 포함). K-1: image_engine._esc·stub_stage._h 코어(html.escape(str(...),
    quote=True)) 흡수. None→빈 문자열. ⚠ 호출부가 필요로 하는 falsy 선처리(예: _esc 의 's or ""')는
    인자 쪽에서 하고 넘긴다 — 이 헬퍼는 None-guard 만 한다(0/False 는 문자열화)."""
    return html.escape(str(s if s is not None else ""), quote=True)


def regulatory_domain(state):
    """state dict → product.regulatory_domain (없으면 None).
    K-1: image_preflight·kcia_engine·render_runmd 산재 리더 흡수."""
    return (state.get("product") or {}).get("regulatory_domain")


def storyboard_substage(rdir):
    """03-storyboard 서브스테이지: outline(스토리라인) → plan(기획안).
    M4(C2): **state.storyboard_substage 명시 커서**가 단일 진실(gate.sh review-pass 만 전진).
      common.sh:storyboard_substage 와 동일 규칙(셸·파이썬 공유). 필드 부재(레거시 run)면 verdict 기반 재구성.
    """
    try:
        cur = load_json(os.path.join(rdir, "state.json")).get("storyboard_substage")
    except Exception:
        cur = None
    if cur in ("outline", "plan"):
        return cur
    return _reconstruct_storyboard_substage(rdir)


def _reconstruct_storyboard_substage(rdir):
    """필드 부재 시 결정적 재구성(verdict 기반, decision 파생 금지 — flip 회피).
       '_verdict pass 가 아닌 첫 substage_': outline-verdict pass 아님→outline, 그 외→plan."""
    base = os.path.join(rdir, "03-storyboard")

    def _vpass(name):
        p = os.path.join(base, name)
        try:
            return os.path.exists(p) and load_json(p).get("verdict") == "pass"
        except Exception:
            return False
    return "plan" if _vpass("outline-verdict.json") else "outline"


def atomic_write_json(path, obj):
    """임시파일에 쓰고 os.replace로 원자적 교체 (동시쓰기/중단 시 파손 방지)."""
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".tmp.%d.%s" % (os.getpid(), os.path.basename(path)))
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def atomic_write_bytes(out_path, payload):
    """바이트를 원자적으로 기록(tmp + fsync + os.replace). 중단 시 부분파일이 'skipped' 로
    오인되는 것을 막는다(image_engine.generate_all 의 os.path.exists 게이트와 정합).
    K-1: atomic_write 계열(json/bytes) 공용화 — image_engine._atomic_write_bytes 승격."""
    d = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".tmp.%d.%s" % (os.getpid(), os.path.basename(out_path)))
    try:
        with open(tmp, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ───────────────────── 최소 JSON Schema 검증기 (draft-07 부분집합) ─────────────────────
class Validator:
    def __init__(self, schema, root_schema=None):
        self.schema = schema
        self.root = root_schema if root_schema is not None else schema
        self.errors = []

    def err(self, path, msg):
        self.errors.append("%s: %s" % (path or "(root)", msg))

    def resolve_ref(self, ref):
        if not ref.startswith("#"):
            raise ValueError("외부 $ref 미지원: " + ref)
        node = self.root
        frag = ref[1:].lstrip("/")
        if frag:
            for part in frag.split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                node = node[part]
        return node

    def type_ok(self, value, t):
        if t == "object":
            return isinstance(value, dict)
        if t == "array":
            return isinstance(value, list)
        if t == "string":
            return isinstance(value, str)
        if t == "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        if t == "number":
            return (isinstance(value, (int, float)) and not isinstance(value, bool))
        if t == "boolean":
            return isinstance(value, bool)
        if t == "null":
            return value is None
        return False

    def validate(self, value, schema, path=""):
        if schema is True:
            return
        if schema is False:
            self.err(path, "허용되지 않는 값")
            return
        if "$ref" in schema:
            self.validate(value, self.resolve_ref(schema["$ref"]), path)
            # $ref 외 형제 키워드는 무시 (우리 스키마는 섞어쓰지 않음)
            return

        # type
        if "type" in schema:
            types = schema["type"]
            types = types if isinstance(types, list) else [types]
            if not any(self.type_ok(value, t) for t in types):
                self.err(path, "타입이 %s 이어야 합니다 (실제: %s)" % ("/".join(types), _typename(value)))
                return

        # enum / const
        if "enum" in schema and value not in schema["enum"]:
            self.err(path, "다음 중 하나여야 합니다: %s (실제: %r)" % (schema["enum"], value))
        if "const" in schema and value != schema["const"]:
            self.err(path, "값이 %r 이어야 합니다" % schema["const"])

        # oneOf / anyOf
        for key in ("anyOf", "oneOf"):
            if key in schema:
                matches = 0
                for sub in schema[key]:
                    v2 = Validator(sub, self.root)
                    v2.validate(value, sub, path)
                    if not v2.errors:
                        matches += 1
                if (key == "anyOf" and matches == 0) or (key == "oneOf" and matches != 1):
                    self.err(path, "%s 조건 불충족 (matched=%d)" % (key, matches))

        # string
        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                self.err(path, "길이가 %d 이상이어야 합니다" % schema["minLength"])
            if "pattern" in schema and not re.search(schema["pattern"], value):
                self.err(path, "패턴 %s 에 맞지 않습니다" % schema["pattern"])

        # number
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                self.err(path, "%s 이상이어야 합니다" % schema["minimum"])
            if "maximum" in schema and value > schema["maximum"]:
                self.err(path, "%s 이하여야 합니다" % schema["maximum"])

        # array
        if isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                self.err(path, "항목이 %d개 이상이어야 합니다" % schema["minItems"])
            if "items" in schema:
                for i, item in enumerate(value):
                    self.validate(item, schema["items"], "%s[%d]" % (path, i))

        # object
        if isinstance(value, dict):
            props = schema.get("properties", {})
            for req in schema.get("required", []):
                if req not in value:
                    self.err(path, "필수 키 누락: '%s'" % req)
            addl = schema.get("additionalProperties", True)
            for k, v in value.items():
                kp = "%s.%s" % (path, k) if path else k
                if k in props:
                    self.validate(v, props[k], kp)
                elif addl is False:
                    self.err(path, "허용되지 않은 키: '%s'" % k)
                elif isinstance(addl, dict):
                    self.validate(v, addl, kp)


def _typename(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, str):
        return "string"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def schema_for_path(rel_path):
    """registry.json 규칙으로 산출물 경로 → 스키마 파일명 결정."""
    reg = load_json(os.path.join(HARNESS_DIR, "registry.json"))
    rel_path = rel_path.replace("\\", "/")
    for rule in reg["rules"]:
        m = rule["match"]
        if "*" in m:
            if fnmatch.fnmatch(rel_path, m) or fnmatch.fnmatch(rel_path, "*/" + m):
                return rule["schema"]
        else:
            if rel_path == m or rel_path.endswith("/" + m):
                return rule["schema"]
    return None


# ───────────────────── 구조 비교 (이식성 a1) ─────────────────────
def struct_signature(value):
    """값을 무시하고 키 집합·타입만 남긴 정규형. 두 CLI 산출물 '스키마 동일' 판정용."""
    if isinstance(value, dict):
        return {k: struct_signature(value[k]) for k in sorted(value.keys())}
    if isinstance(value, list):
        # 배열은 원소 타입 시그니처의 정렬·중복제거 집합으로 (순서·길이 무시)
        sigs = []
        seen = set()
        for item in value:
            s = struct_signature(item)
            key = json.dumps(s, sort_keys=True, ensure_ascii=False)
            if key not in seen:
                seen.add(key)
                sigs.append(s)
        sigs.sort(key=lambda s: json.dumps(s, sort_keys=True, ensure_ascii=False))
        return {"__array__": sigs}
    return {"__type__": _typename(value)}


# ───────────────────────── 서브커맨드 ─────────────────────────
def cmd_validate(args):
    if not args:
        die("사용법: validate <file> [--schema NAME]")
    path = args[0]
    schema_name = None
    if "--schema" in args:
        schema_name = args[args.index("--schema") + 1]
    if not os.path.exists(path):
        die("[검증 실패] 파일이 없습니다: %s" % path)
    try:
        data = load_json(path)
    except Exception as e:
        die("[검증 실패] JSON 파싱 오류 (%s): %s" % (path, e))
    if schema_name is None:
        rel = os.path.relpath(os.path.abspath(path), ROOT)
        schema_name = schema_for_path(rel)
        if schema_name is None:
            die("[검증 실패] '%s' 에 매칭되는 스키마가 registry.json 에 없습니다." % rel)
    schema = load_json(os.path.join(HARNESS_DIR, schema_name))
    v = Validator(schema)
    v.validate(data, schema)
    if v.errors:
        msg = ["[검증 실패] %s (스키마: %s)" % (path, schema_name)]
        for e in v.errors:
            msg.append("  - " + e)
        die("\n".join(msg))
    print("[검증 통과] %s (스키마: %s)" % (path, schema_name))


def cmd_structdiff(args):
    if len(args) < 2:
        die("사용법: structdiff <a.json> <b.json>")
    a = struct_signature(load_json(args[0]))
    b = struct_signature(load_json(args[1]))
    sa = json.dumps(a, sort_keys=True, ensure_ascii=False)
    sb = json.dumps(b, sort_keys=True, ensure_ascii=False)
    if sa == sb:
        print("[구조 동일] 키 집합·타입 일치 (값 무시)")
        sys.exit(0)
    sys.stderr.write("[구조 불일치]\n  A: %s\n  B: %s\n" % (sa, sb))
    sys.exit(1)


def cmd_jget(args):
    if len(args) < 2:
        die("사용법: jget <file> <dotted.path>")
    data = load_json(args[0])
    node = data
    for part in args[1].split("."):
        if part == "":
            continue
        m = re.match(r"^(.+)\[(\d+)\]$", part)
        if m:
            node = node[m.group(1)][int(m.group(2))]
        else:
            if not isinstance(node, dict) or part not in node:
                sys.exit(1)
            node = node[part]
    if isinstance(node, (dict, list)):
        print(json.dumps(node, ensure_ascii=False))
    elif node is None:
        print("null")
    elif isinstance(node, bool):
        print("true" if node else "false")
    else:
        print(node)


def cmd_jset(args):
    if len(args) < 3:
        die("사용법: jset <file> <dotted.path> <json-value>")
    path, dotted, raw = args[0], args[1], args[2]
    data = load_json(path) if os.path.exists(path) else {}
    try:
        val = json.loads(raw)
    except Exception:
        val = raw
    node = data
    parts = dotted.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = val
    atomic_write_json(path, data)
    print("[기록] %s :: %s" % (path, dotted))


def cmd_now(args):
    print(now_iso())


def main():
    if len(sys.argv) < 2:
        die("사용법: harness.py <validate|structdiff|jget|jset|now> ...")
    cmd = sys.argv[1]
    rest = sys.argv[2:]
    table = {
        "validate": cmd_validate,
        "structdiff": cmd_structdiff,
        "jget": cmd_jget,
        "jset": cmd_jset,
        "now": cmd_now,
    }
    if cmd not in table:
        die("알 수 없는 서브커맨드: %s" % cmd)
    table[cmd](rest)


if __name__ == "__main__":
    main()
