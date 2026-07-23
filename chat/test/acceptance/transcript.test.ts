/**
 * transcript.test.ts — Transcript 직렬화 단위(결정성·안정 키순서·왕복·빈/다중·na 유무).
 *
 * 순수(디스크·시계 0). 벽시계 assert 없음 — 같은 입력이면 바이트 동일임을 못박는다.
 */
import { describe, expect, it } from "vitest";
import { Transcript, entriesToJSONL, parseJSONL } from "../../src/acceptance/transcript.js";
import type { ChatEvent } from "../../src/kernel/events.js";
import type { Presentation } from "../../src/kernel/presentation.js";
import type { NextAction } from "../../src/types/contract.js";

const mention = (threadId: string): ChatEvent => ({
  type: "mention",
  threadId,
  actor: "chat:test:U1",
});
const ingestScreen = (rid: string): Presentation => ({
  type: "IngestPrompt",
  rid,
  header: "자료 요청",
  gateLabel: "자료 붙여넣기",
  hint: "워킹백워드",
});
// 직렬화 대상으로만 쓰이는 최소 na(구조 무관 직렬화 — 완전 유효 계약일 필요 없음).
const fakeNa = (): NextAction =>
  ({ rid: "r1", phase: "00-ingest", action: "ingest", stage: null, step: "generate" } as unknown as NextAction);

/** 같은 논리 입력을 매번 새로 쌓는 빌더(결정성 검증용). */
const build = (): string => {
  const t = new Transcript();
  t.append(mention("t1"), [ingestScreen("r1")]);
  t.append(
    { type: "button", actionId: "start", actor: "chat:test:U1", threadId: "t1" },
    [ingestScreen("r1")],
    fakeNa(),
  );
  return t.toJSONL();
};

describe("Transcript 직렬화", () => {
  it("결정성 — 같은 입력이면 두 빌드가 바이트 동일하다", () => {
    expect(build()).toBe(build());
  });

  it("안정 키 순서 — 키 삽입 순서가 달라도 직렬화가 동일하다", () => {
    const a: ChatEvent = {
      type: "button",
      actionId: "x",
      value: "v",
      actor: "A",
      threadId: "t",
    };
    // 같은 값, 키 삽입 순서만 뒤섞음.
    const b = { threadId: "t", actor: "A", value: "v", actionId: "x", type: "button" } as ChatEvent;
    const ja = entriesToJSONL([{ utterance: a, screens: [] }]);
    const jb = entriesToJSONL([{ utterance: b, screens: [] }]);
    expect(ja).toBe(jb);
  });

  it("왕복 — parseJSONL 후 재직렬화가 원본 JSONL 과 바이트 동일하다", () => {
    const jsonl = build();
    expect(entriesToJSONL(parseJSONL(jsonl))).toBe(jsonl);
  });

  it("빈 트랜스크립트 → 빈 문자열", () => {
    expect(new Transcript().toJSONL()).toBe("");
    expect(entriesToJSONL([])).toBe("");
  });

  it("다중 엔트리 — 순서 보존 · 매 줄 개행 종료", () => {
    const t = new Transcript();
    t.append(mention("t1"), []);
    t.append({ type: "text", threadId: "t1", text: "wb", actor: "A", hasAttachments: false }, []);
    t.append({ type: "choice", optionKey: "A", actor: "A", threadId: "t1" }, []);

    const jsonl = t.toJSONL();
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(3);
    expect(jsonl.endsWith("\n")).toBe(true);

    const parsed = parseJSONL(jsonl);
    expect(parsed.map((e) => e.utterance.type)).toEqual(["mention", "text", "choice"]);
  });

  it("불변 스냅샷 — append 이후 입력(화면·발화·na)을 변형해도 쌓인 엔트리는 소급 변경되지 않는다 (W-A P2 락)", () => {
    const t = new Transcript();
    const screen = ingestScreen("r1");
    const utter: ChatEvent = { type: "button", actionId: "start", actor: "A", threadId: "t1" };
    const na = fakeNa();
    t.append(utter, [screen], na);
    const before = t.toJSONL();
    // 호출자가 append 이후 같은 객체들을 변형한다(드라이버의 mutable 재사용 시나리오).
    (screen as { header: string }).header = "변형됨";
    (utter as { actionId: string }).actionId = "mutated";
    (na as unknown as { phase: string }).phase = "99-mutated";
    // 시점 스냅샷이라 이미 쌓인 엔트리·직렬화 결과는 그대로여야 한다(얕은 복사면 실패).
    expect(t.toJSONL()).toBe(before);
    expect(before.includes("변형됨")).toBe(false);
    expect(before.includes("mutated")).toBe(false);
  });

  it("entries 게터 불변 — 반환된 엔트리(화면·발화)를 변형해도 toJSONL 은 바뀌지 않는다 (Codex S2 P2 락)", () => {
    const t = new Transcript();
    t.append(mention("t1"), [ingestScreen("r1")], fakeNa());
    const before = t.toJSONL();
    // 소비자가 게터로 받은 엔트리 내부를 변형(주석/편집 시나리오).
    const got = t.entries;
    (got[0].screens[0] as { header: string }).header = "변형됨";
    (got[0].utterance as { type: string }).type = "mutated";
    // 내부 스냅샷은 격리돼 있어야 한다 — 직렬화 결과 불변.
    expect(t.toJSONL()).toBe(before);
    expect(before.includes("변형됨")).toBe(false);
  });

  it("na 생략 vs 존재 — 둘 다 깔끔히 직렬화되고 왕복에서 유무가 보존된다", () => {
    const jsonl = entriesToJSONL([
      { utterance: mention("t1"), screens: [] }, // na 없음
      { utterance: mention("t2"), screens: [], na: fakeNa() }, // na 있음
    ]);
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).na).toBeUndefined();
    expect(JSON.parse(lines[1]).na).toBeDefined();
    expect(JSON.parse(lines[1]).na.rid).toBe("r1");

    const rp = parseJSONL(jsonl);
    expect(rp[0].na).toBeUndefined();
    expect(rp[1].na).toBeDefined();
  });
});
