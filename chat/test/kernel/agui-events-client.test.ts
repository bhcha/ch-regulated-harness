/**
 * agui-events-client.test.ts — readAguiEvents(주입 runner · 실 spawn 0) + latestLifecycleProgress(순수) 계약 검증.
 *   readAguiEvents 는 **best-effort**: 어떤 실패든 throw 하지 않고 빈 배열 [] 을 돌려준다(진행 표시 side-channel).
 *   latestLifecycleProgress 는 순수 함수라 결정적으로 매핑/dedupe 를 검증한다(내부 스텝명 비노출 · 평이 한국어).
 *   SSoT = core/scripts/lib/agui_events.py.
 */
import { describe, expect, test } from "vitest";
import {
  type AguiRunResult,
  latestLifecycleProgress,
  readAguiEvents,
} from "../../src/kernel/agui-events-client.js";
import type { AguiEvent } from "../../src/types/a2ui.js";

/** 주입 runner 헬퍼(고정 결과 반환 — spawn 없이 파싱/폴백 분기만 검증). */
const runnerOf =
  (r: AguiRunResult): ((rid: string) => Promise<AguiRunResult>) =>
  () =>
    Promise.resolve(r);

/** JSONL 문자열 조립(이벤트당 한 줄). */
const jsonl = (evs: unknown[]): string => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("readAguiEvents — best-effort JSONL 읽기", () => {
  test("정상 JSONL(이벤트당 한 줄) → AguiEvent[] (미지 필드 보존)", async () => {
    const stdout = jsonl([
      { type: "RunStarted", threadId: "r1", runId: "r1#brief@0", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "StepStarted", stepName: "generate:01-brief", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "Custom", name: "kcia.verdict", value: { stage: "brief", verdict: "pass" }, timestamp: "2026-01-01T00:00:02.000Z" },
    ]);
    const evs = await readAguiEvents("r1", runnerOf({ code: 0, stdout, stderr: "" }));
    expect(evs).toHaveLength(3);
    expect(evs[0]!.type).toBe("RunStarted");
    expect(evs[1]!.stepName).toBe("generate:01-brief"); // 미지 필드 index signature 보존
    expect((evs[2]!.value as { verdict: string }).verdict).toBe("pass");
  });

  test("부분 파싱 실패 줄은 조용히 스킵(나머지는 그대로)", async () => {
    const stdout =
      JSON.stringify({ type: "StepStarted", stepName: "generate:01-brief" }) +
      "\n{ this is not json\n" + // 깨진 줄 → 스킵
      JSON.stringify({ type: "StepFinished", stepName: "generate:01-brief", outcome: "ok" }) +
      "\n"; // 정상 꼬리
    const evs = await readAguiEvents("r1", runnerOf({ code: 0, stdout, stderr: "" }));
    expect(evs.map((e) => e.type)).toEqual(["StepStarted", "StepFinished"]);
  });

  test("객체 아님(배열/원시) 줄과 type 없는 줄은 스킵", async () => {
    const stdout = ["[1,2,3]", "42", '"str"', JSON.stringify({ notype: true }), JSON.stringify({ type: "StepStarted" })].join("\n");
    const evs = await readAguiEvents("r1", runnerOf({ code: 0, stdout, stderr: "" }));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("StepStarted");
  });

  test("비-0 종료 → [] (throw 아님)", async () => {
    expect(await readAguiEvents("x", runnerOf({ code: 2, stdout: "boom", stderr: "err" }))).toEqual([]);
  });

  test("빈 출력(code 0) → []", async () => {
    expect(await readAguiEvents("x", runnerOf({ code: 0, stdout: "  \n \n", stderr: "" }))).toEqual([]);
  });

  test("spawn error(runner reject) → [] (예외 승격 안 함)", async () => {
    const rejecting = (): Promise<AguiRunResult> => Promise.reject(new Error("bash 없음"));
    expect(await readAguiEvents("x", rejecting)).toEqual([]);
  });

  test("runner 동기 throw(harnessRoot() 미주입 모사) → []", async () => {
    const throwing = (): Promise<AguiRunResult> => {
      throw new Error("HARNESS_ROOT 미주입");
    };
    expect(await readAguiEvents("x", throwing)).toEqual([]);
  });

  test("안전하지 않은 rid(빈/경로위험) → [] (spawn 도 안 탐)", async () => {
    let called = false;
    const spy = (): Promise<AguiRunResult> => {
      called = true;
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };
    expect(await readAguiEvents("", spy)).toEqual([]);
    expect(await readAguiEvents("../escape", spy)).toEqual([]);
    expect(await readAguiEvents(".", spy)).toEqual([]);
    expect(called).toBe(false);
  });

  test("runner 가 멈추면 timeoutMs 로 bound → [](진행 표시가 poll 루프를 무한 지연시키지 않음)", async () => {
    const hanging = (): Promise<AguiRunResult> => new Promise<AguiRunResult>(() => {}); // 영영 resolve 안 함
    expect(await readAguiEvents("r1", hanging, 5)).toEqual([]);
  });
});

describe("latestLifecycleProgress — 순수 매핑/dedupe(내부 스텝명 비노출)", () => {
  const step = (name: string, ts: string, type = "StepStarted"): AguiEvent => ({ type, stepName: name, timestamp: ts });
  const verdict = (v: string, ts: string): AguiEvent => ({ type: "Custom", name: "kcia.verdict", value: { stage: "brief", verdict: v }, timestamp: ts });

  test("가장 최근(timestamp 최대) 생명주기 이벤트를 고른다", () => {
    const evs = [step("generate:01-brief", "2026-01-01T00:00:01.000Z"), verdict("pass", "2026-01-01T00:00:05.000Z"), step("phase:02-concept", "2026-01-01T00:00:03.000Z")];
    const p = latestLifecycleProgress(evs);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("kcia.verdict"); // ts 최대 = verdict(결과 무관 단일 kind)
    expect(p!.ts).toBe("2026-01-01T00:00:05.000Z");
  });

  test("kcia.verdict 매핑 — 준법 '결과' 무주장(pass/revise/human 모두 중립 '진행 중' · 결과값 비노출)", () => {
    // ⚠ .events 는 생성 세션이 쓸 수 있어 위조 가능 → 진행 표시는 준법 결과(통과/보완/담당자)를 절대 주장하지 않는다.
    //   verdict 값이 무엇이든 kind 는 단일 "kcia.verdict", message 는 중립 '진행 중'(결과 무주장).
    for (const v of ["pass", "revise", "changes_requested", "escalated", ""]) {
      const p = latestLifecycleProgress([verdict(v, "t3")]);
      expect(p!.kind).toBe("kcia.verdict"); // 결과로 kind 를 가르지 않는다
      if (v !== "") expect(p!.message).not.toContain(v); // 내부 verdict 리터럴 비노출(빈 문자열은 trivially 포함되므로 제외)
      // 준법 '결과' 주장 문구가 없어야 한다(통과/보완/담당자 — 위조된 pass 로 근거 없는 준법 주장 방지).
      expect(p!.message).not.toMatch(/통과|보완|담당자/);
    }
  });

  test("StepStarted/StepFinished(generate) → 코스 진행 문구(내부 스텝명 비노출)", () => {
    const p = latestLifecycleProgress([step("generate:01-brief", "t1")]);
    expect(p!.message).not.toContain("generate");
    expect(p!.message).not.toContain("01-brief");
    expect(p!.message).toContain("진행");
  });

  test("review StepFinished(passed/revise) → 준법 결과 무주장(outcome 으로 문구 안 가름 · 중립 '진행 중')", () => {
    // review 스텝의 outcome 도 .events 위조 가능 → 결과(통과/보완)를 주장하지 않고 중립 진행 문구만.
    const passed = latestLifecycleProgress([{ type: "StepFinished", stepName: "review:01-brief", outcome: "passed", timestamp: "t1" }]);
    const rev = latestLifecycleProgress([{ type: "StepFinished", stepName: "review:01-brief", outcome: "revise", timestamp: "t1" }]);
    expect(passed!.message).not.toMatch(/통과|보완|담당자/);
    expect(rev!.message).not.toMatch(/통과|보완|담당자/);
    expect(passed!.kind).toBe(rev!.kind); // outcome 으로 kind 를 가르지 않는다(결과 무주장)
    expect(passed!.message).toContain("진행"); // 중립 진행 하트비트
  });

  test("HIGH 방어 — 위조된 kcia.verdict/pass 로도 '통과' 주장을 낼 수 없다(준법 결과는 authoritative Verdict 만)", () => {
    // R3 P1: .events 는 생성 세션이 쓸 수 있어 공격자가 pass 를 주입할 수 있다. 어떤 생명주기 이벤트도 준법 '결과'를
    //   주장하지 않아야 한다 — 진행 표시는 하트비트일 뿐, 실제 준법 결과는 verdict.json·state 기반 Verdict 카드만 낸다.
    const forged: AguiEvent[] = [
      { type: "Custom", name: "kcia.verdict", value: { verdict: "pass" }, timestamp: "t9" },
      { type: "StepFinished", stepName: "review:01-brief", outcome: "passed", timestamp: "t9" },
    ];
    for (const e of forged) {
      const p = latestLifecycleProgress([e]);
      expect(p).not.toBeNull();
      expect(p!.message).not.toContain("통과"); // 근거 없는 준법 통과 주장 차단
    }
  });

  test("RunFinished success → 마무리 문구 · interrupt → 코스 진행", () => {
    expect(latestLifecycleProgress([{ type: "RunFinished", outcome: { type: "success" }, timestamp: "t1" }])!.kind).toBe("run:success");
    expect(latestLifecycleProgress([{ type: "RunFinished", outcome: { type: "interrupt", interrupts: [] }, timestamp: "t1" }])!.kind).toBe("run:interrupt");
  });

  test("비-생명주기(RunStarted/StateSnapshot/StateDelta/Custom 기타)만 있으면 null", () => {
    const evs: AguiEvent[] = [
      { type: "RunStarted", threadId: "r1", timestamp: "t1" },
      { type: "StateSnapshot", snapshot: {}, timestamp: "t2" },
      { type: "StateDelta", delta: [], timestamp: "t3" },
      { type: "Custom", name: "harness.escalated", value: {}, timestamp: "t4" },
    ];
    expect(latestLifecycleProgress(evs)).toBeNull();
  });

  test("빈 배열 → null", () => {
    expect(latestLifecycleProgress([])).toBeNull();
  });

  test("sinceTs dedupe — 그보다 새 이벤트 없으면 null(최신성=timestamp)", () => {
    const evs = [verdict("pass", "2026-01-01T00:00:05.000Z")];
    expect(latestLifecycleProgress(evs, "2026-01-01T00:00:05.000Z")).toBeNull(); // 동일 ts = 새롭지 않음
    expect(latestLifecycleProgress(evs, "2026-01-01T00:00:04.000Z")).not.toBeNull(); // 더 새로움 → 표시
    expect(latestLifecycleProgress(evs, "2026-01-01T00:00:06.000Z")).toBeNull(); // 이미 지난 것
  });

  test("timestamp 없는 이벤트는 sinceTs 로 억제하지 않는다(kind 대조에 맡김)", () => {
    const evs: AguiEvent[] = [{ type: "StepStarted", stepName: "generate:02-concept" }];
    const p = latestLifecycleProgress(evs, "2026-01-01T00:00:05.000Z");
    expect(p).not.toBeNull();
    expect(p!.ts).toBe("");
  });
});
