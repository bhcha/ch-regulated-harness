/**
 * analyzer.test.ts — 문제 분석기 순수 단위(standalone `pnpm test`). core spawn 0 · 합성 화면 시퀀스만 먹인다.
 *
 * 5개 디텍터가 각각 (양성)에서 발화하고 (음성=깨끗한 happy 시퀀스)에서 발화하지 않음을 전수 assert 한다.
 *   .test.ts(=.accept.test.ts 아님)라 표준 standalone 계층에서 돈다(core 불필요 · setup.ts 더미 HARNESS_ROOT).
 */
import { describe, expect, it } from "vitest";
import { analyze, type AnalyzerInput } from "../../src/acceptance/analyzer.js";
import type { AffordanceContext } from "../../src/acceptance/affordances.js";
import type { Presentation } from "../../src/kernel/presentation.js";
import type { NextAction } from "../../src/types/contract.js";

const CTX: AffordanceContext = { actor: "chat:test:U1", threadId: "t1" };

// ── 화면 빌더(최소 유효 Presentation) ────────────────────────────────────────
const nlProposal = (): Presentation => ({
  type: "NlProposal",
  kind: "setup",
  summary: "설정",
  questions: [],
  confirm: { actionId: "setup_start", label: "시작" },
});
const ingest = (rid = "r1"): Presentation => ({
  type: "IngestPrompt",
  rid,
  header: "자료 요청",
  gateLabel: "붙여넣기",
  hint: "",
});
const progress = (rid = "r1", message = "만드는 중이에요…"): Presentation => ({
  type: "Progress",
  rid,
  header: "진행",
  message,
});
const approveGate = (phase = "01-brief", rid = "r1"): Presentation => ({
  type: "ApproveGate",
  rid,
  header: phase,
  gateLabel: "승인",
  hint: "",
  reviseAvailable: true,
  raOkRequired: true,
});
const confirmGate = (rid = "r1"): Presentation => ({ type: "ConfirmGate", rid, kind: "ra" });
const verdictPass = (rid = "r1"): Presentation => ({
  type: "Verdict",
  rid,
  header: "심의",
  outcome: "pass",
  stage: "brief",
});
const optionSet = (phase = "02-concept", rid = "r1"): Presentation => ({
  type: "OptionSet",
  rid,
  header: phase,
  phase,
  iteration: null,
  options: [
    { key: "A", title: "A안", body: "", recommended: true },
    { key: "B", title: "B안", body: "", recommended: false },
  ],
  compareMd: "",
  reviseAvailable: true,
});
const failure = (rid = "r1"): Presentation => ({
  type: "Failure",
  rid,
  header: "실패",
  message: "생성을 마치지 못했습니다.",
});

const na = (action: NextAction["action"], phase = "02-concept"): NextAction =>
  ({ rid: "r1", phase, action, stage: null, step: "generate" } as unknown as NextAction);

/** 깨끗한 happy 시퀀스 — 멘션→인입→brief 승인→심의 pass→02-concept 다안(최종 OptionSet, 출구 있음). */
const cleanSequence = (): Presentation[] => [
  nlProposal(),
  ingest(),
  progress(),
  approveGate("01-brief"),
  confirmGate(),
  progress("r1", "규정 점검 중이에요…"),
  verdictPass(),
  optionSet("02-concept"),
];

const cleanInput = (): AnalyzerInput => ({
  presentations: cleanSequence(),
  activeRuns: 0,
  ctx: CTX,
  finalNa: na("select", "02-concept"),
});

describe("문제 분석기(analyzer) — 5개 디텍터", () => {
  it("음성 — 깨끗한 happy 시퀀스는 발견 0", () => {
    expect(analyze(cleanInput())).toEqual([]);
  });

  it("failure — Failure 화면이 있으면 발화", () => {
    const input = cleanInput();
    const found = analyze({ ...input, presentations: [...cleanSequence(), failure()] });
    expect(found.some((f) => f.kind === "failure")).toBe(true);
  });

  it("failure — 깨끗한 시퀀스엔 failure 발견 없음", () => {
    expect(analyze(cleanInput()).some((f) => f.kind === "failure")).toBe(false);
  });

  it("dead-end — 최종이 출구 없는 Progress 이고 run 미완이면 발화", () => {
    const found = analyze({
      presentations: [nlProposal(), ingest(), progress()],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("generate", "01-brief"), // 아직 생성 차례 = 미완
    });
    expect(found.some((f) => f.kind === "dead-end")).toBe(true);
  });

  it("dead-end — 답글 대기(awaitingReply)면 출구 없는 Progress 라도 발화 안 함(외부리뷰 S3 P2)", () => {
    // 보완 사유 요청/WB 붙여넣기 안내처럼 버튼 없이 '답글'이 출구인 Progress — 막다른 화면 아님.
    const input = {
      presentations: [nlProposal(), ingest(), progress("r1", "빼거나 고칠 내용을 이 스레드에 답글로 적어 주세요.")],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("approve", "01-brief"), // 미완(승인 차례) — 그러나 답글 대기 중
    };
    // awaitingReply 미전달이면 오탐(버튼 출구 0 + 미완) — 그 오탐을 awaitingReply=true 가 억제함을 대조 증명.
    expect(analyze(input).some((f) => f.kind === "dead-end")).toBe(true);
    expect(analyze({ ...input, awaitingReply: true }).some((f) => f.kind === "dead-end")).toBe(false);
  });

  it("dead-end — 최종이 출구 있는 OptionSet 이면 발화 안 함(음성)", () => {
    expect(analyze(cleanInput()).some((f) => f.kind === "dead-end")).toBe(false);
  });

  it("dead-end — 최종이 Done 이면 발화 안 함", () => {
    const done: Presentation = { type: "Done", rid: "r1", header: "완료", message: "끝", files: [] };
    const found = analyze({
      presentations: [ingest(), progress(), done],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("done", "done"),
    });
    expect(found.some((f) => f.kind === "dead-end")).toBe(false);
  });

  it("dead-end — 화면이 하나도 없는데 run 이 미완이면 발화(표면 누락 · 외부리뷰 S2 P2)", () => {
    const found = analyze({
      presentations: [],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("generate", "01-brief"), // 미완인데 렌더된 화면 0
    });
    const de = found.find((f) => f.kind === "dead-end");
    expect(de).toBeDefined();
    expect(de?.phase).toBe("01-brief");
  });

  it("dead-end — 화면 0 이라도 run 이 done 이면 발화 안 함(음성)", () => {
    const found = analyze({ presentations: [], activeRuns: 0, ctx: CTX, finalNa: na("done", "done") });
    expect(found.some((f) => f.kind === "dead-end")).toBe(false);
  });

  it("stuck — 같은 게이트(type/phase)가 임계(3) 이상 반복되면 발화", () => {
    const found = analyze({
      presentations: [approveGate("01-brief"), progress(), approveGate("01-brief"), progress(), approveGate("01-brief")],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("approve", "01-brief"),
    });
    const stuck = found.find((f) => f.kind === "stuck");
    expect(stuck).toBeDefined();
    expect(stuck?.count).toBe(3);
  });

  it("stuck — 서로 다른 게이트가 한 번씩이면 발화 안 함(음성)", () => {
    expect(analyze(cleanInput()).some((f) => f.kind === "stuck")).toBe(false);
  });

  it("stuck — Progress 반복은 stuck 로 세지 않는다(진행 표시는 정당한 반복)", () => {
    const found = analyze({
      presentations: [progress(), progress(), progress(), progress(), optionSet("02-concept")],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("select", "02-concept"),
    });
    expect(found.some((f) => f.kind === "stuck")).toBe(false);
  });

  it("job-residue — 정지 후 activeRuns>0 이면 발화", () => {
    const found = analyze({ ...cleanInput(), activeRuns: 2 });
    const residue = found.find((f) => f.kind === "job-residue");
    expect(residue).toBeDefined();
    expect(residue?.activeRuns).toBe(2);
  });

  it("job-residue — activeRuns=0 이면 발화 안 함(음성)", () => {
    expect(analyze(cleanInput()).some((f) => f.kind === "job-residue")).toBe(false);
  });

  it("unknown Presentation — union 밖 type 이면 발화(affordancesOf throw 없이)", () => {
    const bogus = { type: "Bogus", rid: "r1" } as unknown as Presentation;
    const found = analyze({
      presentations: [ingest(), bogus],
      activeRuns: 0,
      ctx: CTX,
      finalNa: na("generate", "01-brief"),
    });
    expect(found.some((f) => f.kind === "unknown-presentation")).toBe(true);
  });

  it("unknown Presentation — 깨끗한 시퀀스엔 unknown 발견 없음(음성)", () => {
    expect(analyze(cleanInput()).some((f) => f.kind === "unknown-presentation")).toBe(false);
  });
});
