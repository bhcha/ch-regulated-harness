/**
 * keyvisual-reader.test.ts — 다안 이미지(04-keyvisual) 미리보기 경로 읽기 검증.
 *   핵심 회귀(Codex P2 HIGH): kvDir 밖 임의 로컬 파일이 미리보기로 새어 Slack 에 업로드되는 것을 막는다.
 *     · 심링크 탈출(파일/상위 디렉터리) → realpath 봉쇄로 배제(대상이 유효 PNG 라도 kvDir 밖이면 배제).
 *     · 하드링크·위조 콘텐츠(비밀 파일을 full.png 로 하드링크) → PNG 시그니처 불일치로 배제.
 *   정상 PNG(진짜 이미지 · kvDir 안)는 그대로 돌려준다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeyvisualOptions } from "../../src/kernel/keyvisual-reader.js";

let root: string;
let secretDir: string;
const RID = "kv-reader-test";

/** 유효한 최소 PNG(시그니처 8바이트 + 약간의 필러). looksLikePng 통과용. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
function writePng(path: string): void {
  writeFileSync(path, PNG_BYTES);
}

function kvDir(): string {
  return join(root, "runs", RID, "04-keyvisual");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kv-reader-root-"));
  secretDir = mkdtempSync(join(tmpdir(), "kv-reader-secret-"));
  process.env.HARNESS_ROOT = root;
});
afterEach(() => {
  delete process.env.HARNESS_ROOT;
  rmSync(root, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
});

describe("readKeyvisualOptions — 경로 해석 + 유출 봉쇄", () => {
  it("options/<key>/shots/full.png 실 PNG 이면 그 경로를 돌려준다(추천 매핑)", async () => {
    for (const k of ["A", "B"]) {
      const shots = join(kvDir(), "options", k, "shots");
      mkdirSync(shots, { recursive: true });
      writePng(join(shots, "full.png"));
    }
    const opts = await readKeyvisualOptions(RID, ["A", "B"], "B");
    expect(opts.map((o) => o.key)).toEqual(["A", "B"]);
    expect(opts[0]!.imagePaths).toHaveLength(1);
    expect(opts[0]!.imagePaths[0]).toContain("04-keyvisual");
    expect(opts.find((o) => o.key === "B")!.recommended).toBe(true);
    expect(opts.find((o) => o.key === "A")!.recommended).toBe(false);
  });

  it("심링크 탈출: full.png 가 kvDir 밖 파일(유효 PNG여도)을 가리키면 배제(realpath 봉쇄)", async () => {
    const outsidePng = join(secretDir, "outside.png");
    writePng(outsidePng); // 대상은 유효 PNG — 그래도 kvDir 밖이라 봉쇄되어야 함(containment 단독 증명).
    const shots = join(kvDir(), "options", "A", "shots");
    mkdirSync(shots, { recursive: true });
    symlinkSync(outsidePng, join(shots, "full.png"));
    const opts = await readKeyvisualOptions(RID, ["A"], "A");
    expect(opts[0]!.imagePaths).toEqual([]);
    expect(opts[0]!.caption).toContain("미리보기 없음");
  });

  it("심링크 탈출: shots 디렉터리 자체가 밖을 가리켜도 봉쇄(상위 경로 심링크)", async () => {
    const outside = join(secretDir, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writePng(join(outside, "full.png"));
    const optDir = join(kvDir(), "options", "A");
    mkdirSync(optDir, { recursive: true });
    symlinkSync(outside, join(optDir, "shots"));
    const opts = await readKeyvisualOptions(RID, ["A"], "A");
    expect(opts[0]!.imagePaths).toEqual([]);
  });

  it("하드링크 유출: full.png 를 kvDir 밖 비밀(비-PNG)에 하드링크하면 배제(PNG 시그니처 불일치)", async () => {
    const secret = join(secretDir, "secret.env");
    writeFileSync(secret, "SLACK_BOT_TOKEN=xoxb-secret\n"); // 비-PNG 콘텐츠.
    const shots = join(kvDir(), "options", "A", "shots");
    mkdirSync(shots, { recursive: true });
    linkSync(secret, join(shots, "full.png")); // 하드링크 — realpath 는 kvDir 안 그대로(봉쇄 통과)지만 PNG 아님.
    const opts = await readKeyvisualOptions(RID, ["A"], "A");
    expect(opts[0]!.imagePaths).toEqual([]); // 시그니처 검사로 배제 → 비밀 미업로드
  });

  it("위조 콘텐츠: kvDir 안 실파일이라도 PNG 가 아니면 배제", async () => {
    const shots = join(kvDir(), "options", "A", "shots");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "full.png"), "not a png, just text"); // 실파일·kvDir 안이지만 비-PNG.
    const opts = await readKeyvisualOptions(RID, ["A"], "A");
    expect(opts[0]!.imagePaths).toEqual([]);
  });

  it("generated/*.png 폴백: full.png 부재 시 kvDir 안 실 PNG 만(심링크·비-PNG 제외·정렬)", async () => {
    const gdir = join(kvDir(), "generated");
    mkdirSync(gdir, { recursive: true });
    writePng(join(gdir, "01-hero.png"));
    writePng(join(gdir, "02-solution.png"));
    writeFileSync(join(gdir, "03-notpng.png"), "text"); // 비-PNG → 배제.
    const outsidePng = join(secretDir, "leak.png");
    writePng(outsidePng);
    symlinkSync(outsidePng, join(gdir, "99-evil.png")); // 탈출 심링크 → 배제.
    const opts = await readKeyvisualOptions(RID, ["A"], null);
    expect(opts[0]!.imagePaths.map((p) => p.split("/").pop())).toEqual(["01-hero.png", "02-solution.png"]);
  });

  it("rid 가 안전하지 않으면 빈 경로(경로 탈출 차단)", async () => {
    const opts = await readKeyvisualOptions("../evil", ["A"], null);
    expect(opts[0]!.imagePaths).toEqual([]);
  });
});

describe("readKeyvisualOptions — 데모(촬영) 이미지 소스(CHAT_DEMO_KV_IMAGES)", () => {
  let demoDir: string;
  beforeEach(() => {
    demoDir = mkdtempSync(join(tmpdir(), "kv-demo-"));
  });
  afterEach(() => {
    delete process.env.CHAT_DEMO_KV_IMAGES;
    rmSync(demoDir, { recursive: true, force: true });
  });

  /** 데모 소스에 options/<k>/shots/full.png 실 PNG 를 만든다. */
  function writeDemoOption(k: string): void {
    const shots = join(demoDir, "options", k, "shots");
    mkdirSync(shots, { recursive: true });
    writePng(join(shots, "full.png"));
  }

  it("데모 소스 설정 시 run 산출물 대신 데모 dir 의 실 PNG 를 옵션별로 배정(run kvDir 빈 상태여도)", async () => {
    for (const k of ["A", "B", "C"]) writeDemoOption(k);
    process.env.CHAT_DEMO_KV_IMAGES = demoDir; // run 의 04-keyvisual 는 비어 있음(stub svg 상황 모사)
    const opts = await readKeyvisualOptions(RID, ["A", "B", "C"], "A");
    expect(opts.map((o) => o.key)).toEqual(["A", "B", "C"]);
    for (const o of opts) {
      expect(o.imagePaths).toHaveLength(1);
      expect(o.imagePaths[0]).toContain(demoDir); // run 산출물이 아니라 데모 소스에서 온다
      expect(o.caption).toContain("이미지 1장");
    }
    expect(opts.find((o) => o.key === "A")!.recommended).toBe(true);
  });

  it("옵션 키 이름이 데모 소스와 달라도 인덱스 순환 배정으로 모든 옵션이 실 이미지를 얻는다", async () => {
    for (const k of ["X1", "X2"]) writeDemoOption(k); // 데모엔 2장, run 옵션 키는 A/B/C(이름 무관)
    process.env.CHAT_DEMO_KV_IMAGES = demoDir;
    const opts = await readKeyvisualOptions(RID, ["A", "B", "C"], null);
    expect(opts.every((o) => o.imagePaths.length === 1)).toBe(true); // 3안 모두 이미지 있음
    // 순환: A→img0, B→img1, C→img0(2장 순환)
    expect(opts[0]!.imagePaths[0]).toBe(opts[2]!.imagePaths[0]);
    expect(opts[0]!.imagePaths[0]).not.toBe(opts[1]!.imagePaths[0]);
  });

  it("데모 소스라도 비-PNG·심링크 탈출은 배제(검증 불변) → 그 옵션 이미지 없음", async () => {
    const shots = join(demoDir, "options", "A", "shots");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "full.png"), "not-a-png"); // 비-PNG
    process.env.CHAT_DEMO_KV_IMAGES = demoDir;
    const opts = await readKeyvisualOptions(RID, ["A"], null);
    expect(opts[0]!.imagePaths).toEqual([]); // PNG 시그니처 불일치로 배제
    expect(opts[0]!.caption).toContain("미리보기 없음");
  });

  it("데모 env 미설정이면 기존 run 산출물 경로(회귀 불변)", async () => {
    // 데모 dir 은 만들되 env 는 설정하지 않음 → run 의 kvDir 를 읽어야 한다.
    const shots = join(kvDir(), "options", "A", "shots");
    mkdirSync(shots, { recursive: true });
    writePng(join(shots, "full.png"));
    const opts = await readKeyvisualOptions(RID, ["A"], "A");
    expect(opts[0]!.imagePaths[0]).toContain("04-keyvisual"); // run 산출물(데모 소스 아님)
  });
});
