/**
 * policy.test.ts — 라이브 auto-happy 결정 정책(decideForward) 단위. 동결 SurfaceDriver.decide 와 같은 정책임을
 *   화면별로 못 박는다(발화는 affordancesOf 산출 중에서만 · 지어낸 버튼 없음). 순수(게이트웨이·플랫폼 0).
 */
import { describe, expect, it } from "vitest";
import { decideForward, decideLive } from "../../src/live/policy.js";
import { parseActionValue } from "../../src/kernel/flow.js";
import type { AffordanceContext } from "../../src/acceptance/affordances.js";
import type { Presentation } from "../../src/kernel/presentation.js";

const ctx: AffordanceContext = { actor: "chat:live:U-driver", threadId: "t1" };

describe("decideForward(auto-happy 정책)", () => {
  it("ApproveGate → approve 발화(actionId=approve · threadId/actor 실림)", () => {
    const p: Presentation = { type: "ApproveGate", rid: "r", header: "h", gateLabel: "승인", hint: "", reviseAvailable: true, raOkRequired: false };
    const ev = decideForward(p, ctx);
    expect(ev?.actionId).toBe("approve");
    expect(ev?.threadId).toBe("t1");
    expect(ev?.actor).toBe("chat:live:U-driver");
  });

  it("ApproveGate(raOkRequired) → approve 에 ra_required 실림(RA 게이트로 이어짐)", () => {
    const p: Presentation = { type: "ApproveGate", rid: "r", header: "h", gateLabel: "승인", hint: "", reviseAvailable: false, raOkRequired: true };
    const ev = decideForward(p, ctx);
    expect(ev?.actionId).toBe("approve");
    expect(parseActionValue(ev?.value)?.ra_required).toBe(true);
  });

  it("ConfirmGate → RA 확인 발화(단일 affordance)", () => {
    const p: Presentation = { type: "ConfirmGate", rid: "r", kind: "ra" };
    expect(decideForward(p, ctx)).not.toBeNull();
  });

  it("OptionSet → 추천(recommended) 안의 select-<key> 를 고른다", () => {
    const p: Presentation = {
      type: "OptionSet",
      rid: "r",
      header: "h",
      phase: "02-concept",
      iteration: 0,
      options: [
        { key: "A", title: "A안", body: "", recommended: false },
        { key: "B", title: "B안", body: "", recommended: true },
      ],
      compareMd: "",
      reviseAvailable: false,
    };
    const ev = decideForward(p, ctx);
    expect(ev?.actionId).toBe("select-B");
    expect(parseActionValue(ev?.value)?.option).toBe("B");
  });

  it("OptionSet(추천 없음) → 첫 안 select", () => {
    const p: Presentation = {
      type: "OptionSet",
      rid: "r",
      header: "h",
      phase: "02-concept",
      iteration: 0,
      options: [
        { key: "A", title: "A안", body: "", recommended: false },
        { key: "B", title: "B안", body: "", recommended: false },
      ],
      compareMd: "",
      reviseAvailable: false,
    };
    expect(decideForward(p, ctx)?.actionId).toBe("select-A");
  });

  it("IngestPrompt → 인입 발화", () => {
    const p: Presentation = { type: "IngestPrompt", rid: "r", header: "h", gateLabel: "자료", hint: "" };
    expect(decideForward(p, ctx)).not.toBeNull();
  });

  it("NlProposal(확정 버튼 있음) → 확정 발화 · (질문만) → 정지(null)", () => {
    const withConfirm: Presentation = {
      type: "NlProposal",
      kind: "setup",
      summary: "s",
      questions: [],
      confirm: { actionId: "setup_start", label: "시작" },
    } as Presentation;
    expect(decideForward(withConfirm, ctx)).not.toBeNull();
    const questionsOnly: Presentation = { type: "NlProposal", kind: "setup", summary: "s", questions: ["제품명?"] } as Presentation;
    expect(decideForward(questionsOnly, ctx)).toBeNull();
  });

  it("표시전용/사람입력/비-happy/종단 → 정지(null)", () => {
    const stops: Presentation[] = [
      { type: "Setup" } as Presentation,
      { type: "Progress", rid: "r", header: "h", message: "m" },
      { type: "Verdict", rid: "r", header: "h", outcome: "pass", stage: "brief" },
      { type: "Failure", rid: "r", header: "h", message: "m" },
      { type: "GenerateRetry", rid: "r", header: "h", message: "m", stage: "brief" },
      { type: "Escalation", rid: "r", header: "h", gateLabel: "g", hint: "" },
      { type: "Done", rid: "r", header: "h" } as Presentation,
    ];
    for (const p of stops) expect(decideForward(p, ctx), (p as { type: string }).type).toBeNull();
  });
});

describe("decideLive(라이브 4분법 정책)", () => {
  it("ApproveGate → fire(decideForward 위임 · actionId=approve)", () => {
    const p: Presentation = { type: "ApproveGate", rid: "r", header: "h", gateLabel: "승인", hint: "", reviseAvailable: true, raOkRequired: false };
    const d = decideLive(p, ctx);
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") {
      expect(d.event.actionId).toBe("approve");
      expect(d.event.threadId).toBe("t1");
      expect(d.event.actor).toBe("chat:live:U-driver");
    }
  });

  it("OptionSet → fire(추천안 select-<key>)", () => {
    const p: Presentation = {
      type: "OptionSet",
      rid: "r",
      header: "h",
      phase: "02-concept",
      iteration: 0,
      options: [
        { key: "A", title: "A안", body: "", recommended: false },
        { key: "B", title: "B안", body: "", recommended: true },
      ],
      compareMd: "",
      reviseAvailable: false,
    };
    const d = decideLive(p, ctx);
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") expect(d.event.actionId).toBe("select-B");
  });

  it("NlProposal(질문만) → stop:human-input(decideForward null)", () => {
    const p: Presentation = { type: "NlProposal", kind: "setup", summary: "s", questions: ["제품명?"] } as Presentation;
    const d = decideLive(p, ctx);
    expect(d).toEqual({ kind: "stop", reason: "human-input" });
  });

  it("NlProposal(확정 버튼) → fire", () => {
    const p: Presentation = {
      type: "NlProposal",
      kind: "setup",
      summary: "s",
      questions: [],
      confirm: { actionId: "setup_start", label: "시작" },
    } as Presentation;
    const d = decideLive(p, ctx);
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") expect(d.event.actionId).toBe("setup_start");
  });

  it("Setup → stop:human-input", () => {
    const d = decideLive({ type: "Setup" } as Presentation, ctx);
    expect(d).toEqual({ kind: "stop", reason: "human-input" });
  });

  it("Progress → wait", () => {
    const d = decideLive({ type: "Progress", rid: "r", header: "h", message: "m" }, ctx);
    expect(d).toEqual({ kind: "wait" });
  });

  it("Verdict(pass) → wait(발화 금지 — onOutcome 자동 적재)", () => {
    const d = decideLive({ type: "Verdict", rid: "r", header: "h", outcome: "pass", stage: "brief" }, ctx);
    expect(d).toEqual({ kind: "wait" });
  });

  it("Verdict(revise) → wait(재생성 카드 발화 금지 — 이중 적재 방지)", () => {
    const d = decideLive({ type: "Verdict", rid: "r", header: "h", outcome: "revise", stage: "02-concept" }, ctx);
    expect(d).toEqual({ kind: "wait" });
  });

  it("Verdict(human) → stop:escalation", () => {
    const d = decideLive({ type: "Verdict", rid: "r", header: "h", outcome: "human", stage: null }, ctx);
    expect(d).toEqual({ kind: "stop", reason: "escalation" });
  });

  it("Failure → recover([상태 다시 확인] reconcile)", () => {
    const p: Presentation = { type: "Failure", rid: "r", header: "h", message: "m" };
    const d = decideLive(p, ctx);
    expect(d.kind).toBe("recover");
    if (d.kind === "recover") {
      expect(d.event.actionId).toBe("reconcile");
      expect(parseActionValue(d.event.value)?.action).toBe("reconcile");
    }
  });

  it("GenerateRetry → stop:human-input(자동 유료 재생성 금지 — 중복 과금·run 경합 방지)", () => {
    // GenerateRetry 는 상태 재확인(Failure→reconcile) 후에도 '여전히 생성 차례'로 남은 경우에만 뜬다 = 생성 미완료 신호.
    //   여기서 [다시 만들기]를 자동 발화하면 모호한 Bridge 타임아웃 창에서 두 번째 유료 생성을 일으킬 수 있어(운영자
    //   세션 미클레임 경로) 사람 판단으로 남기고 멈춘다. 늦은 성공은 Failure→reconcile 이 다음 게이트로 회복한다.
    const p: Presentation = { type: "GenerateRetry", rid: "r", header: "h", message: "m", stage: "02-concept" };
    const d = decideLive(p, ctx);
    expect(d).toEqual({ kind: "stop", reason: "human-input" });
  });

  it("Escalation → stop:escalation", () => {
    const d = decideLive({ type: "Escalation", rid: "r", header: "h", gateLabel: "g", hint: "" }, ctx);
    expect(d).toEqual({ kind: "stop", reason: "escalation" });
  });

  it("Done → stop:done", () => {
    const d = decideLive({ type: "Done", rid: "r", header: "h", message: "완료", files: [] }, ctx);
    expect(d).toEqual({ kind: "stop", reason: "done" });
  });
});
