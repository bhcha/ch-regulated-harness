#!/usr/bin/env bash
# test-image-rebake.sh — F8: 입력(프롬프트 + 레퍼런스 바이트)이 실제로 바뀐 블록만 다시 굽는다(input_hash 재굽기 트리거).
#   문제: image_engine 은 유효한 기존 산출물을 _existing_is_valid 로만 skip 했다 → 참조 자산 교체·프롬프트 변경이
#         재굽기를 유발하지 못해 낡은 이미지가 살아남았다. 처방: 블록별 입력해시(sha256)를 매니페스트에 기록하고,
#         '유효 산출물 && 해시 불변'일 때만 skip. 해시가 바뀐 블록만 재굽기.
#   ⚠ 무네트워크(hermetic): _call_nanobanana 를 결정적 PNG 라이터로 monkeypatch(실 REST 0회). 오프라인 stub 골든 불변 단언 포함.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
echo "## F8 이미지 재굽기(input_hash) — 입력 변경 블록만 재생성(오프라인·무네트워크)"

RID="ci-imgrebake-$$"
RDIR="$ROOT/runs/$RID"
STUB_RID="ci-imgrebake-stub-$$"
STUB_RDIR="$ROOT/runs/$STUB_RID"
cleanup() { rm -rf "$RDIR" "$STUB_RDIR"; }
trap cleanup EXIT

# fixtures/keyvisual-in(plan concept 13블록 + inputs/assets 자사컷) 을 scratch run 으로 복사.
rm -rf "$RDIR"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$RDIR"

# ── 1) nanobanana 경로 재굽기 시나리오(단일 프로세스로 monkeypatch·BAKED 상태 유지) ──
#   Run1: 전부 생성 + input_hash · Run2: 무변경 → 전부 skip · Run3: 레퍼런스 바이트 교체 → 그 블록만 재굽기 ·
#   Run4: 플랜 블록 프롬프트(concept.subject) 변경 → 그 블록만 재굽기 · Run5(레거시): input_hash 제거 후 재실행 → 전부 skip + 해시 재기록.
NB_OUT="$( cd "$ROOT" && env -u HARNESS_NANOBANANA_MODEL python3 - "$RDIR" <<'PY' 2>&1
import sys, os
rdir = sys.argv[1]
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
import image_engine as ie
from harness import load_json, atomic_write_json

# 구조 유효 PNG(매직+IHDR+IDAT+IEND) — _existing_is_valid 재진입 검증 통과용. 네트워크 0회.
VALID_PNG = (b"\x89PNG\r\n\x1a\n"
             + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 13 + b"\x00\x00\x00\x00"
             + (4).to_bytes(4, "big") + b"IDAT" + b"\x00" * 4 + b"\x00\x00\x00\x00"
             + (0).to_bytes(4, "big") + b"IEND" + b"\x00\x00\x00\x00")
BAKED = []
def fake_call(prompt, out, rdir_, model=None):   # 3-/4-인자 계약 유지(강등 재시도 대비)
    BAKED.append(os.path.basename(out))
    ie._atomic_write_bytes(out, VALID_PNG)
ie._call_nanobanana = fake_call

errs = []
def ok(c, l):
    if not c: errs.append(l)

MF = os.path.join(rdir, "04-keyvisual", "image-manifest.json")
def amap(m):
    return {a["type"]: a for a in m.get("assets", [])}

# ── Run 1: 전부 생성 + 각 자산에 64자 input_hash ──
BAKED.clear()
m1 = ie.generate_all("ci-imgrebake", rdir, "nanobanana")
a1 = amap(m1)
ok(len(a1) == 13, "run1 asset count != 13: %d" % len(a1))
ok(all(a["status"] == "generated" for a in a1.values()),
   "run1 not all generated: %r" % {t: a["status"] for t, a in a1.items()})
ok(all(isinstance(a.get("input_hash"), str) and len(a["input_hash"]) == 64 for a in a1.values()),
   "run1 asset missing/short input_hash")
ok(len(BAKED) == 13, "run1 baked count != 13: %d (%r)" % (len(BAKED), BAKED))

# ── Run 2: 무변경 → 전부 skip · 재굽기 0 · 해시 불변 ──
BAKED.clear()
m2 = ie.generate_all("ci-imgrebake", rdir, "nanobanana")
a2 = amap(m2)
ok(all(a["status"] == "skipped" for a in a2.values()),
   "run2 not all skipped: %r" % {t: a["status"] for t, a in a2.items()})
ok(BAKED == [], "run2 re-baked (should be 0): %r" % BAKED)
ok(all(a2[t]["input_hash"] == a1[t]["input_hash"] for t in a1), "run2 hash drift on no-op")

# ── Run 3: 레퍼런스 자산 바이트 교체 → 그 블록만 재굽기 ──
#   02-problem 은 ezderm-relief-main.webp 를 '단독' 참조(다른 블록 미참조) → 오직 problem 만 해시 변경.
ref = os.path.join(rdir, "inputs", "assets", "ezderm-relief-main.webp")
# 새 '유효 WEBP'(RIFF..WEBP 매직) — 기존과 다른 바이트라 sha256 이 달라진다(교체 감지).
# ⚠ 픽스처의 inputs/assets/ 는 git 미추적이라 clean 체크아웃엔 없을 수 있다 → 부모 디렉터리를 보장해 self-contained 하게(포터블).
NEW_WEBP = b"RIFF" + (48).to_bytes(4, "little") + b"WEBP" + b"VP8 " + (b"\x5a" * 44)
os.makedirs(os.path.dirname(ref), exist_ok=True)
with open(ref, "wb") as f:
    f.write(NEW_WEBP)
BAKED.clear()
m3 = ie.generate_all("ci-imgrebake", rdir, "nanobanana")
a3 = amap(m3)
ok(BAKED == ["02-problem.png"], "run3 rebaked set != [02-problem.png]: %r" % BAKED)
ok(a3["problem"]["status"] == "generated", "run3 problem not re-generated")
ok(sum(1 for a in a3.values() if a["status"] == "generated") == 1,
   "run3 more than 1 generated: %r" % {t: a["status"] for t, a in a3.items()})
ok(a3["problem"]["input_hash"] != a1["problem"]["input_hash"],
   "run3 problem hash unchanged after reference swap")
ok(all(a3[t]["input_hash"] == a1[t]["input_hash"] for t in a1 if t != "problem"),
   "run3 non-target hashes drifted after single-ref swap")

# ── Run 4: 플랜 블록 concept(프롬프트) 변경 → 그 블록만 재굽기 ──
#   09-howToUse 는 own-5.svg 참조(SVG→ref_sha256=None, 레퍼런스 confound 없음) → subject 변경만으로 프롬프트 해시 변경.
plan9 = os.path.join(rdir, "03-storyboard", "plan", "09-howToUse.json")
b9 = load_json(plan9)
b9["visual"]["concept"]["subject"] = (b9["visual"]["concept"].get("subject", "") + " · F8 변경 서브젝트")
atomic_write_json(plan9, b9)
BAKED.clear()
m4 = ie.generate_all("ci-imgrebake", rdir, "nanobanana")
a4 = amap(m4)
ok(BAKED == ["09-howToUse.png"], "run4 rebaked set != [09-howToUse.png]: %r" % BAKED)
ok(a4["howToUse"]["status"] == "generated", "run4 howToUse not re-generated")
ok(sum(1 for a in a4.values() if a["status"] == "generated") == 1,
   "run4 more than 1 generated: %r" % {t: a["status"] for t, a in a4.items()})
ok(a4["howToUse"]["input_hash"] != a3["howToUse"]["input_hash"],
   "run4 howToUse hash unchanged after prompt change")

# ── Run 5(레거시): 매니페스트에서 input_hash 제거 → 재실행 → 전부 skip(재굽기 0) + 해시 재기록 ──
#   레거시(구버전) 매니페스트는 해시 필드 부재만으로 전면 재굽기하면 안 된다(싸구려 재진입 보존). 값 부재 → skip 유지하되 이번 런에 해시 기록.
m = load_json(MF)
for a in m["assets"]:
    a.pop("input_hash", None)
atomic_write_json(MF, m)
BAKED.clear()
m5 = ie.generate_all("ci-imgrebake", rdir, "nanobanana")
a5 = amap(m5)
ok(BAKED == [], "legacy re-run re-baked (should be 0): %r" % BAKED)
ok(all(a["status"] == "skipped" for a in a5.values()),
   "legacy re-run not all skipped: %r" % {t: a["status"] for t, a in a5.items()})
ok(all(isinstance(a.get("input_hash"), str) for a in a5.values()),
   "legacy re-run did not re-record hashes")

print("PYFAIL:" + "|".join(errs) if errs else "PYOK")
PY
)"
echo "$NB_OUT" | grep -q PYOK \
  && pass "(1) 재굽기: 생성→skip→레퍼런스교체(단일)→프롬프트변경(단일)→레거시skip+해시재기록" \
  || fail "(1) 재굽기 시나리오 실패 :: $NB_OUT"

# ── 2) nanobanana 매니페스트가 image-asset.schema(input_hash optional) 를 통과 ──
NB_MF="$RDIR/04-keyvisual/image-manifest.json"
if ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$NB_MF" ) >/dev/null 2>&1; then
  pass "(2) nanobanana 매니페스트(input_hash 포함) image-asset.schema 통과"
else
  fail "(2) nanobanana 매니페스트 스키마 검증 실패(input_hash optional 누락?)"
fi

# ── 3) STUB 골든 불변: stub 매니페스트에는 input_hash 키가 전혀 없다(오프라인 바이트 결정성) ──
rm -rf "$STUB_RDIR"; cp -R "$PACKS_DIR/cosmetic/fixtures/keyvisual-in" "$STUB_RDIR"
( cd "$ROOT" && python3 scripts/lib/image_engine.py "$STUB_RID" "$STUB_RDIR" --engine stub ) >/dev/null 2>&1
STUB_MF="$STUB_RDIR/04-keyvisual/image-manifest.json"
check "(3) stub 매니페스트 생성" "[ -f \"$STUB_MF\" ]"
check "(3) stub 매니페스트에 input_hash 키 부재(골든 바이트 불변)" "! grep -q 'input_hash' \"$STUB_MF\""
# stub 자산 dict 키 형상이 기존과 동일(input_hash 미추가) — 스키마도 통과.
if ( cd "$ROOT" && python3 scripts/lib/harness.py validate "$STUB_MF" ) >/dev/null 2>&1; then
  pass "(3) stub 매니페스트 image-asset.schema 통과(형상 불변)"
else
  fail "(3) stub 매니페스트 스키마 검증 실패"
fi

printf '\n[image-rebake] PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
