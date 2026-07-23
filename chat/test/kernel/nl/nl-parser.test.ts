/**
 * nl-parser.test.ts — 자연어 이해(P3) 단위 검증(결정적 · 네트워크 0).
 *   · StubNlParser: 도메인/포맷/제품명/파일참조 추출(별칭·부분→uncertain), "승인해줘"=실행 의도(선언 아님).
 *   · intentFromToolInput: 실 LLM 응답 → NlIntent 순수 매핑(실 API 호출 없음).
 *   · selectNlParser: 오프라인/무키=Stub · 온라인+키=Llm.
 *   · validateIntakeFiles: allowlist + realpath 봉쇄(루트 밖·부재·미설정 거부).
 *
 * ⚠ 실 LLM(LlmNlParser) 호출 자체는 오프라인 미검증 — 순수 매핑만 덮는다(테스트에서 실 Anthropic API 호출 금지).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubNlParser } from "../../../src/kernel/nl/stub-parser.js";
import { intentFromToolInput, LlmNlParser } from "../../../src/kernel/nl/llm-parser.js";
import { selectNlParser } from "../../../src/kernel/nl/index.js";
import { validateIntakeFiles } from "../../../src/kernel/nl/intake-files.js";
import type { NlFileRef } from "../../../src/kernel/nl/parser.js";

const parse = (t: string) => new StubNlParser().parse(t);

describe("StubNlParser — 도메인/포맷 추출(명시 선언만)", () => {
  it("도메인 별칭: 화장품·의약외품·건기식·의약품(의약외품이 의약품보다 먼저)", async () => {
    expect((await parse("화장품이야")).domain).toBe("화장품");
    expect((await parse("cosmetic 제품")).domain).toBe("화장품");
    expect((await parse("의약외품으로 할게")).domain).toBe("의약외품");
    expect((await parse("의약품이야")).domain).toBe("의약품");
    expect((await parse("건강기능식품이에요")).domain).toBe("건기식");
    expect((await parse("건기식")).domain).toBe("건기식");
    // 도메인 선언이 없으면 추론하지 않는다(잠긴 결정 7).
    expect((await parse("여드름에 좋은 제품 만들어줘")).domain).toBeUndefined();
  });

  it("포맷 별칭: 여러장·멀티·한장(여러 장이 먼저)", async () => {
    expect((await parse("여러장으로")).format).toBe("여러장");
    expect((await parse("여러 장 만들어줘")).format).toBe("여러장");
    expect((await parse("멀티페이지")).format).toBe("여러장");
    expect((await parse("한장이면 돼")).format).toBe("한장");
    expect((await parse("한 장짜리")).format).toBe("한장");
  });
});

describe("StubNlParser — 제품명 + 완결/미확신", () => {
  it("따옴표 인용 또는 '제품명은 X' 추출", async () => {
    expect((await parse('제품명은 "이지듀 시카세럼"이야')).product).toBe("이지듀 시카세럼");
    expect((await parse("제품명은 릴리프쿠션")).product).toBe("릴리프쿠션");
  });

  it("완결(3필드): kind=setup · uncertain 없음", async () => {
    const i = await parse('화장품이고 여러장이야, 제품명은 "릴리프 세럼"');
    expect(i.kind).toBe("setup");
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
    expect(i.product).toBe("릴리프 세럼");
    expect(i.uncertain).toEqual([]);
  });

  it("부분 선언 → uncertain 에 빠진 필드(자동 시작 불가)", async () => {
    const i = await parse("화장품이야"); // 포맷·제품명 없음
    expect(i.kind).toBe("setup");
    expect(i.uncertain).toEqual(["format", "product"]);
  });
});

describe("StubNlParser — 파일 참조(P3-2)", () => {
  it("역할별 경로 추출: 워킹백워드/시험성적서/기타=참고", async () => {
    const i = await parse("워킹백워드는 이 파일이야: /docs/wb.md, 시험성적서는 /docs/report.pdf");
    expect(i.kind).toBe("intake");
    expect(i.files).toEqual<NlFileRef[]>([
      { role: "working_backwards", path: "/docs/wb.md" },
      { role: "test_report", path: "/docs/report.pdf" },
    ]);
  });

  it("역할 키워드 없는 경로는 reference", async () => {
    const i = await parse("이거 참고해줘 /a/b/c.docx");
    expect(i.files[0]).toEqual({ role: "reference", path: "/a/b/c.docx" });
  });
});

describe("StubNlParser — 실행 의도(선언 아님)", () => {
  it("'승인해줘' = execute:approve (도메인/제품 선언으로 오인 안 함)", async () => {
    const i = await parse("승인해줘");
    expect(i.kind).toBe("execute");
    expect(i.execute).toBe("approve");
    expect(i.domain).toBeUndefined();
    expect(i.product).toBeUndefined();
    expect(i.uncertain).toEqual([]);
  });

  it("'시작해줘'=start · '이걸로'=select · '다시 제안'=revise", async () => {
    expect((await parse("시작해줘")).execute).toBe("start");
    expect((await parse("이걸로 할게")).execute).toBe("select");
    expect((await parse("다시 제안해줘")).execute).toBe("revise");
  });

  it("빈/무의미 텍스트 → unknown", async () => {
    const i = await parse("음 글쎄요");
    expect(i.kind).toBe("unknown");
    expect(i.confidence).toBe(0);
  });
});

describe("intentFromToolInput — 실 LLM 응답 순수 매핑", () => {
  it("허용 도메인/포맷만 통과 · uncertain 재산정", () => {
    const i = intentFromToolInput({ kind: "setup", domain: "화장품", format: "여러장" });
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
    expect(i.uncertain).toEqual(["product"]); // product 빠짐
  });

  it("허용 밖 값은 드롭 · 빈 입력 → unknown", () => {
    const bad = intentFromToolInput({ kind: "setup", domain: "식품", format: "3장" });
    expect(bad.domain).toBeUndefined();
    expect(bad.format).toBeUndefined();
    expect(intentFromToolInput({}).kind).toBe("unknown");
  });

  it("files 정규화(잘못된 role → reference · path 없으면 드롭) → kind=intake", () => {
    const i = intentFromToolInput({ files: [{ role: "bogus", path: "/x.pdf" }, { role: "test_report" }] });
    expect(i.kind).toBe("intake");
    expect(i.files).toEqual([{ role: "reference", path: "/x.pdf" }]);
  });
});

describe("selectNlParser — 환경별 선택", () => {
  let savedOffline: string | undefined;
  let savedKey: string | undefined;
  beforeEach(() => {
    savedOffline = process.env.HARNESS_OFFLINE;
    savedKey = process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedOffline === undefined) delete process.env.HARNESS_OFFLINE;
    else process.env.HARNESS_OFFLINE = savedOffline;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("오프라인 → StubNlParser (키 있어도)", () => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(selectNlParser()).toBeInstanceOf(StubNlParser);
  });

  it("온라인·무키 → StubNlParser", () => {
    delete process.env.HARNESS_OFFLINE;
    delete process.env.ANTHROPIC_API_KEY;
    expect(selectNlParser()).toBeInstanceOf(StubNlParser);
  });

  it("온라인·키 있음 → LlmNlParser (실 호출 없음)", () => {
    delete process.env.HARNESS_OFFLINE;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(selectNlParser()).toBeInstanceOf(LlmNlParser);
  });
});

describe("LlmNlParser — 실패 시 fallback 강등(네트워크 0)", () => {
  it("fetch 예외 → fallback(Stub) 결과", async () => {
    const parser = new LlmNlParser({
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      fallback: new StubNlParser(),
      fetchImpl: (async () => {
        throw new Error("no network in test");
      }) as unknown as typeof fetch,
    });
    const i = await parser.parse("화장품이야");
    expect(i.domain).toBe("화장품"); // stub 이 처리
  });
});

describe("validateIntakeFiles — allowlist + realpath 봉쇄", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nl-root-"));
    outside = mkdtempSync(join(tmpdir(), "nl-out-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("루트 하위 실파일은 accepted(realPath 해소)", () => {
    const p = join(root, "wb.md");
    writeFileSync(p, "hi");
    const v = validateIntakeFiles([{ role: "working_backwards", path: p }], [root]);
    expect(v.accepted).toHaveLength(1);
    expect(v.accepted[0]!.role).toBe("working_backwards");
    expect(v.rejected).toHaveLength(0);
  });

  it("루트 밖 파일 → rejected(허용 폴더 밖)", () => {
    const p = join(outside, "secret.pdf");
    writeFileSync(p, "x");
    const v = validateIntakeFiles([{ role: "reference", path: p }], [root]);
    expect(v.accepted).toHaveLength(0);
    expect(v.rejected[0]!.reason).toContain("허용된 폴더 밖");
  });

  it("부재 파일 → rejected · 루트 미설정 → 전부 rejected(fail-closed)", () => {
    const v = validateIntakeFiles([{ role: "reference", path: join(root, "nope.pdf") }], [root]);
    expect(v.rejected[0]!.reason).toContain("찾을 수 없");
    const none = validateIntakeFiles([{ role: "reference", path: join(root, "x.pdf") }], []);
    expect(none.accepted).toHaveLength(0);
    expect(none.rejected[0]!.reason).toContain("설정");
  });
});
