#!/usr/bin/env python3
"""baseline.py — 마이그레이션 회귀 안전망("바이트 골든 + structdiff 골든").

정본 런(cosmetic·multipage_bm) 산출물의 **의미 바이트 골든**을 캡처/검증한다.
- JSON 은 휘발성 키(ts/updated_at/…)를 재귀 strip 후 정규(sorted) JSON 으로 sha256 → 타임스탬프 비결정성 제거.
- 그 외 파일(html 등)은 원본 바이트 sha256.
- `intersect`: 두 런의 매니페스트 중 **동일한 항목만** 골든으로 채택(잔여 비결정 자동 배제).
- `verify`: 한 런을 골든과 대조 — 미일치(=동작 변질)면 비0 종료(0순위 알람).

사용법:
  baseline.py manifest <run_dir> <out.json>
  baseline.py intersect <run_a> <run_b> <out_manifest.json>
  baseline.py verify <run_dir> <manifest.json>
"""
import sys
import os
import json
import hashlib

# 런마다 정당하게 달라지는 휘발성 키(값 비교 대상에서 재귀 제외).
#   타임스탬프(*_at·ts·timestamp)와 런 식별자(workflow_id·run_id·rid)는 동작과 무관하게 달라진다.
VOLATILE = {
    "ts", "timestamp", "workflow_id", "run_id", "rid",
}
# 사람용 렌더/락/캐시/관측로그 — 골든 대상 아님(상대경로 prefix 매칭).
#   .logs/(개선계획 2부: timing.jsonl·캡처로그)는 휘발성 타임스탬프·소요시간이라 골든 바이트 비결정 → 제외.
#   .events/(AG-UI 투영: agui.jsonl·.cursor.json)도 휘발성 타임스탬프(now_iso) 뿐이라 골든 바이트 비결정 → 제외
#     (.logs 와 동형 — state.json 파생 뷰이지 진실원천 아님; 제외 안 하면 kcia-check baseline-hash 무결성 게이트가 변조로 오판).
SKIP_PREFIX = ("run.md", ".lock", "__pycache__", ".logs", ".events")


def _is_volatile(key):
    return key in VOLATILE or key.endswith("_at")   # *_at = 타임스탬프 관습(created_at·confirmed_at·…)


def _strip(v):
    if isinstance(v, dict):
        return {k: _strip(v[k]) for k in v if not _is_volatile(k)}
    if isinstance(v, list):
        return [_strip(x) for x in v]
    return v


def _digest_file(path):
    if path.endswith(".json"):
        try:
            with open(path, encoding="utf-8") as fh:
                obj = json.load(fh)
        except Exception:
            with open(path, "rb") as fh:
                return "RAW:" + hashlib.sha256(fh.read()).hexdigest()
        canon = json.dumps(_strip(obj), sort_keys=True, ensure_ascii=False)
        return "JSON:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()
    with open(path, "rb") as fh:
        return "RAW:" + hashlib.sha256(fh.read()).hexdigest()


def _manifest(run_dir):
    out = {}
    for root, _dirs, files in os.walk(run_dir):
        for fn in sorted(files):
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, run_dir)
            if any(rel == s or rel.startswith(s + "/") or rel.startswith(s) for s in SKIP_PREFIX):
                continue
            out[rel] = _digest_file(p)
    return out


def cmd_manifest(run_dir, out_path):
    m = _manifest(run_dir)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(m, fh, sort_keys=True, ensure_ascii=False, indent=2)
    print("[manifest] %d files → %s" % (len(m), out_path))


def cmd_intersect(run_a, run_b, out_path):
    ma, mb = _manifest(run_a), _manifest(run_b)
    keys_a, keys_b = set(ma), set(mb)
    stable = {k: ma[k] for k in (keys_a & keys_b) if ma[k] == mb[k]}
    dropped_vol = sorted((keys_a & keys_b) - set(stable))
    only_a, only_b = sorted(keys_a - keys_b), sorted(keys_b - keys_a)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(stable, fh, sort_keys=True, ensure_ascii=False, indent=2)
    print("[intersect] 골든 %d 항목 → %s" % (len(stable), out_path))
    if dropped_vol:
        print("[intersect] 비결정(두 런 불일치)로 제외 %d: %s" % (len(dropped_vol), ", ".join(dropped_vol)))
    if only_a or only_b:
        print("[intersect] 한 런에만 존재(제외) A=%s B=%s" % (only_a, only_b))


def cmd_verify(run_dir, manifest_path):
    with open(manifest_path, encoding="utf-8") as fh:
        golden = json.load(fh)
    cur = _manifest(run_dir)
    changed, missing = [], []
    for rel, dig in sorted(golden.items()):
        if rel not in cur:
            missing.append(rel)
        elif cur[rel] != dig:
            changed.append(rel)
    extra = sorted(set(cur) - set(golden))   # 골든에 없던 신규 산출물(경고: 마이그레이션이 새 경로를 만들었나?)
    if extra:
        # 신규 파일은 회귀로 단정하지 않는다(의도된 추가일 수 있음) — 단 반드시 가시화(눈으로 확인, 외부리뷰 medium).
        sys.stderr.write("[verify] 주의: 골든에 없던 신규 산출물 %d(의도 확인 필요):\n  %s\n" % (len(extra), "\n  ".join(extra)))
    if not changed and not missing:
        print("[verify] OK — 골든 %d 항목 의미 바이트 동일(미변경 경로 보존)%s." % (
            len(golden), (" · 신규 %d건 경고" % len(extra)) if extra else ""))
        return 0
    if missing:
        sys.stderr.write("[verify] 누락(골든에 있으나 런에 없음) %d:\n  %s\n" % (len(missing), "\n  ".join(missing)))
    if changed:
        sys.stderr.write("[verify] 변경(의미 바이트 다름 — 0순위 알람) %d:\n  %s\n" % (len(changed), "\n  ".join(changed)))
    sys.stderr.write("[verify] 의도된 골든 갱신이면 capture 재실행 후 커밋에 명시; 아니면 회귀.\n")
    return 1


def main(argv):
    if not argv:
        sys.stderr.write(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "manifest" and len(argv) == 3:
        cmd_manifest(argv[1], argv[2]); return 0
    if cmd == "intersect" and len(argv) == 4:
        cmd_intersect(argv[1], argv[2], argv[3]); return 0
    if cmd == "verify" and len(argv) == 3:
        return cmd_verify(argv[1], argv[2])
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
