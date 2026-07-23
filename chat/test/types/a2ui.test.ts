/**
 * a2ui.test.ts — parseActionEnvelope 계약 검증(순수 · 셸 없음).
 *   a2ui-action.sh stdout 마지막 줄의 단일 JSON envelope 를 뽑아내되, 형태 불일치/파싱 실패는 null(throw 금지).
 *   SSoT = core/scripts/lib/a2ui_action.py.
 */
import { describe, expect, it } from "vitest";
import { type A2uiSurface, type AguiEvent, parseActionEnvelope } from "../../src/types/a2ui.js";

const ENVELOPE = {
  ok: false,
  action: "approve",
  delegate: "approve.sh",
  exit: 2,
  message: "지금은 승인 차례가 아닙니다",
  error: null,
};

describe("parseActionEnvelope", () => {
  it("단일 envelope 한 줄을 파싱한다", () => {
    const env = parseActionEnvelope(JSON.stringify(ENVELOPE) + "\n");
    expect(env).toEqual(ENVELOPE);
  });

  it("앞줄에 사람용 TEXT 가 섞여도 '마지막 비어있지 않은 줄'만 파싱한다", () => {
    const stdout = "사람용 진행 로그\n또 한 줄\n" + JSON.stringify(ENVELOPE) + "\n\n  \n";
    const env = parseActionEnvelope(stdout);
    expect(env?.action).toBe("approve");
    expect(env?.exit).toBe(2);
  });

  it("forward-compat: 미지 필드가 있어도 보존한다", () => {
    const withExtra = { ...ENVELOPE, future_field: 42 };
    const env = parseActionEnvelope(JSON.stringify(withExtra));
    expect(env?.["future_field"]).toBe(42);
    expect(env?.ok).toBe(false);
  });

  it("비-JSON 마지막 줄은 null(throw 금지)", () => {
    expect(parseActionEnvelope("총체적 난국")).toBeNull();
    expect(parseActionEnvelope("{not json")).toBeNull();
  });

  it("빈/공백 stdout 은 null", () => {
    expect(parseActionEnvelope("")).toBeNull();
    expect(parseActionEnvelope("   \n \n")).toBeNull();
  });

  it("배열/원시값 JSON 은 null(객체 아님)", () => {
    expect(parseActionEnvelope("[1,2,3]")).toBeNull();
    expect(parseActionEnvelope("42")).toBeNull();
    expect(parseActionEnvelope('"str"')).toBeNull();
  });

  it("최소 필드(ok:boolean·exit:number) 결여는 null(부분 객체 오인 방지)", () => {
    expect(parseActionEnvelope(JSON.stringify({ action: "approve" }))).toBeNull();
    expect(parseActionEnvelope(JSON.stringify({ ok: true }))).toBeNull(); // exit 없음
    expect(parseActionEnvelope(JSON.stringify({ ok: "true", exit: 0 }))).toBeNull(); // ok 가 문자열
    expect(parseActionEnvelope(JSON.stringify({ ok: true, exit: "0" }))).toBeNull(); // exit 가 문자열
  });
});

describe("A2uiSurface(읽기 표면 타입 · passthrough)", () => {
  it("명시 필드는 좁은 타입 + 미지 필드는 index signature 로 흡수(컴파일·런타임 가드)", () => {
    // JSON.parse 결과를 캐스팅해 소비하는 실제 경로를 모사 — 명시 필드 접근 + 미지 필드(a2ui_version 등) 보존.
    const raw = JSON.parse(
      JSON.stringify({
        rid: "r1",
        phase: "02-concept",
        surface: "select",
        step: null,
        needs_approve_after_select: false,
        action: "select",
        actions: ["select", "revise"],
        options: ["A", "B"],
        recommended: "A",
        revise_available: true,
        ra_ok_required: false,
        // 미지 top-level(derive() 가 싣는 것) — 명시 안 해도 흡수돼야 한다.
        a2ui_version: "1",
        catalogId: "kcia-a2ui-v1",
        components: [{ type: "ChoiceButton", key: "A" }],
      }),
    ) as A2uiSurface;

    // 명시 필드 = 좁은 타입(컴파일 가드) + 값 검증.
    expect(raw.rid).toBe("r1");
    expect(raw.surface).toBe("select");
    expect(raw.actions).toContain("revise");
    expect(raw.options).toEqual(["A", "B"]);
    expect(raw.recommended).toBe("A");
    expect(raw.revise_available).toBe(true);
    // 미지 필드 = index signature(unknown) 로 보존(버리지 않음).
    expect(raw["a2ui_version"]).toBe("1");
    expect(raw["catalogId"]).toBe("kcia-a2ui-v1");
    expect(raw["components"]).toEqual([{ type: "ChoiceButton", key: "A" }]);
  });

  it("최소 오브젝트(명시 필드만) 도 유효 — surface/step null 허용", () => {
    const s: A2uiSurface = {
      rid: "r2",
      phase: "00-ingest",
      surface: null,
      step: null,
      needs_approve_after_select: false,
      action: "ingest",
      actions: [],
      options: [],
      recommended: null,
      revise_available: false,
      ra_ok_required: false,
    };
    expect(s.surface).toBeNull();
    expect(s.actions).toEqual([]);
  });
});

describe("AguiEvent(AG-UI 이벤트 타입 · passthrough)", () => {
  it("type(필수)·timestamp(선택) + 타입별 미지 필드를 index signature 로 보존", () => {
    // agui-events.sh replay JSONL 한 줄을 캐스팅해 소비하는 경로 모사 — 명시 필드 접근 + 타입별 필드 보존.
    const raw = JSON.parse(
      JSON.stringify({
        type: "Custom",
        name: "kcia.verdict",
        value: { stage: "brief", verdict: "pass", violations: 0 },
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ) as AguiEvent;
    expect(raw.type).toBe("Custom"); // 명시 필드 = 좁은 타입
    expect(raw.timestamp).toBe("2026-01-01T00:00:00.000Z");
    // 타입별 필드(name·value)는 index signature(unknown)로 보존.
    expect(raw["name"]).toBe("kcia.verdict");
    expect((raw["value"] as { verdict: string }).verdict).toBe("pass");
  });

  it("timestamp 없는 이벤트도 유효(선택 필드)", () => {
    const e: AguiEvent = { type: "StepStarted", stepName: "generate:01-brief" };
    expect(e.type).toBe("StepStarted");
    expect(e.timestamp).toBeUndefined();
  });
});
