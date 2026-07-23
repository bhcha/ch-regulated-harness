/**
 * contract.test.ts — 파서 계약 단일 모듈(contract.ts) 검증(결정적 · 네트워크 0).
 *   · intentFromToolInput: 실 LLM/CLI 응답(임의 JSON) → NlIntent 순수 매핑(허용집합 필터·kind 우선순위·uncertain 재산정).
 *   · INTENT_JSON_SCHEMA: 구조(type object · 기대 프로퍼티 · required 에 kind).
 *   · SYSTEM_PROMPT: 규칙 8 가드레일(명시 선언만·도메인 추론 금지) 문구 포함.
 *
 * ⚠ 계약은 CLI/실LLM 표면이 공유하는 단일 진실이다(잠긴 결정 5). 순수 매핑만 오프라인 단위로 덮는다(실 API 호출 금지).
 */
import { describe, expect, it } from "vitest";
import {
  DECLARE_INTENT_TOOL,
  INTENT_JSON_SCHEMA,
  INTENT_TOOL_NAME,
  SYSTEM_PROMPT,
  intentFromToolInput,
} from "../../../src/kernel/nl/contract.js";
import type { NlFileRef } from "../../../src/kernel/nl/parser.js";

describe("intentFromToolInput — 순수 매핑(허용집합·kind 우선순위·uncertain)", () => {
  it("따옴표 인용 제품명 매핑 · 허용 도메인/포맷 통과 · uncertain 재산정", () => {
    const i = intentFromToolInput({ kind: "setup", domain: "화장품", format: "여러장", product: "릴리프 세럼" });
    expect(i.kind).toBe("setup");
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
    expect(i.product).toBe("릴리프 세럼");
    expect(i.uncertain).toEqual([]); // 3필드 모두 있음
  });

  it("setup 부분 선언 → uncertain 에 빠진 필드 재산정(LLM 이 틀리게 줘도 커널 재계산)", () => {
    const i = intentFromToolInput({ kind: "setup", domain: "화장품", format: "여러장" });
    expect(i.domain).toBe("화장품");
    expect(i.format).toBe("여러장");
    expect(i.uncertain).toEqual(["product"]); // product 빠짐
  });

  it("허용 밖 도메인/포맷은 드롭 · 빈 입력 → unknown", () => {
    const bad = intentFromToolInput({ kind: "setup", domain: "식품", format: "3장" });
    expect(bad.domain).toBeUndefined();
    expect(bad.format).toBeUndefined();
    expect(intentFromToolInput({}).kind).toBe("unknown");
    expect(intentFromToolInput({}).confidence).toBe(0.3);
  });

  it("files: 잘못된 role → reference 기본 · path 없으면 드롭 · kind=intake(파일 우선)", () => {
    const i = intentFromToolInput({ files: [{ role: "bogus", path: "/x.pdf" }, { role: "test_report" }] });
    expect(i.kind).toBe("intake");
    expect(i.files).toEqual<NlFileRef[]>([{ role: "reference", path: "/x.pdf" }]);
  });

  it("files 의 유효 role 은 보존(working_backwards/test_report/reference)", () => {
    const i = intentFromToolInput({
      files: [
        { role: "working_backwards", path: "/wb.md" },
        { role: "test_report", path: "/r.pdf" },
      ],
    });
    expect(i.files).toEqual<NlFileRef[]>([
      { role: "working_backwards", path: "/wb.md" },
      { role: "test_report", path: "/r.pdf" },
    ]);
    // intake 도 setup 필드 부재 시 uncertain 재산정
    expect(i.uncertain).toEqual(["domain", "format", "product"]);
  });

  it("kind 우선순위: 파일 > 설정필드 > execute > kind 원문 > unknown", () => {
    // 설정필드만 → setup
    expect(intentFromToolInput({ kind: "unknown", product: "X" }).kind).toBe("setup");
    // execute 만 → execute
    const ex = intentFromToolInput({ kind: "unknown", execute: "approve" });
    expect(ex.kind).toBe("execute");
    expect(ex.execute).toBe("approve");
    expect(ex.uncertain).toEqual([]); // execute 는 uncertain 없음
    // 아무것도 없이 kind 원문만 신뢰
    expect(intentFromToolInput({ kind: "intake" }).kind).toBe("intake");
    // 허용 밖 execute 값은 드롭
    expect(intentFromToolInput({ kind: "execute", execute: "bogus" }).execute).toBeUndefined();
  });
});

describe("INTENT_JSON_SCHEMA — 스키마 구조 sanity", () => {
  it("type object · 기대 프로퍼티 존재 · required 에 kind", () => {
    expect(INTENT_JSON_SCHEMA.type).toBe("object");
    const props = INTENT_JSON_SCHEMA.properties;
    for (const key of ["kind", "domain", "format", "product", "execute", "files"] as const) {
      expect(props).toHaveProperty(key);
    }
    expect(INTENT_JSON_SCHEMA.required).toContain("kind");
  });

  it("DECLARE_INTENT_TOOL 은 계약 스키마를 그대로 래핑(name · input_schema 동일 참조)", () => {
    expect(DECLARE_INTENT_TOOL.name).toBe(INTENT_TOOL_NAME);
    expect(DECLARE_INTENT_TOOL.input_schema).toBe(INTENT_JSON_SCHEMA);
  });
});

describe("SYSTEM_PROMPT — 규칙 8 가드레일(명시 선언만·추론 금지)", () => {
  it("'명시적으로 선언한' + 도메인 추론 금지 문구 포함", () => {
    expect(SYSTEM_PROMPT).toContain("명시적으로 선언한");
    expect(SYSTEM_PROMPT).toContain("추론하지 마라");
    expect(SYSTEM_PROMPT).toContain("사람이 선언했을 때만");
  });
});
