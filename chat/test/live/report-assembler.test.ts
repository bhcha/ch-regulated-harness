/**
 * report-assembler.test.ts — 판정 리포트 조립 단위(픽스처 파일 → 구조 판정). 게이트웨이·core 0(파일만 읽음).
 *   주입 reader(인메모리 픽스처)로 통과/미충족 순열을 못 박고, 실 fs 픽스처로 defaultReader 도 한 번 태운다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleJudgmentReport,
  extractPresentations,
  listRunTranscripts,
  renderReportMarkdown,
  type ReportReader,
} from "../../src/live/report-assembler.js";

/** 인메모리 fs 이음새 — 경로→내용 맵. listEntries 는 경로 접두어로 하위 구조를 유도한다. */
function makeReader(files: Record<string, string>): ReportReader {
  const paths = Object.keys(files);
  return {
    readText: (p) => (p in files ? files[p]! : null),
    exists: (p) => p in files || paths.some((f) => f.startsWith(p + "/")),
    listEntries: (dir) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Map<string, boolean>();
      for (const f of paths) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const seg = rest.split("/")[0]!;
        const isDir = rest.includes("/");
        names.set(seg, (names.get(seg) ?? false) || isDir);
      }
      return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
    },
  };
}

const goodState = JSON.stringify({
  workflow_id: "chat-live-x",
  product: { name: "테스트제품" },
  phase: "done",
  step: "done",
  gate: null,
  status: "passed",
  artifacts: { brief: "01-brief/brief.json", keyvisual: "04-keyvisual/options" },
  history: [
    { ts: "t", phase: "00-ingest", event: "ingest:ok", by: "run-stage.sh" },
    { ts: "t", phase: "01-brief", event: "approve", by: "approve.sh", actor: "chat:live:U-driver" },
    { ts: "t", phase: "02-concept", event: "select", by: "select.sh", actor: "chat:live:U-driver" },
    { ts: "t", phase: "04-keyvisual", event: "approve", by: "approve.sh", actor: "chat:live:U-driver" },
    { ts: "t", phase: "done", event: "done", by: "advance-phase.sh" },
  ],
  updated_at: "t",
});
const goodManifest = JSON.stringify({ engine: "nanobanana", assets: [{ file: "01.png" }] });
const goodVerdict = JSON.stringify({
  verdict: "pass",
  engine: "ruleset+model",
  confidence: 0.9,
  critic_ran: true,
  critic_outcome: "ok",
  review_depth: "rule_engine+critic",
  critic_engine: "adk-http",
  violations: [],
  escalate: false,
});
const goodTimingJsonl = [
  JSON.stringify({ ts: "t", phase: "01-brief", stage: "brief", step: "generate", outcome: "ok", duration_s: 12 }),
  JSON.stringify({ ts: "t", phase: "02-concept", stage: "concept", step: "generate", outcome: "ok", duration_s: 30 }),
].join("\n") + "\n";
/** Failure 없는 정상 트랜스크립트(tee render-line 형식). */
const goodTranscript = [
  { seq: 0, threadId: "t", presentation: { type: "IngestPrompt", rid: "r" } },
  { seq: 1, threadId: "t", presentation: { type: "ApproveGate", rid: "r", phase: "01-brief" } },
  { seq: 2, threadId: "t", presentation: { type: "OptionSet", rid: "r", phase: "02-concept" } },
  { seq: 3, threadId: "t", presentation: { type: "Verdict", rid: "r", outcome: "pass" } },
  { seq: 4, threadId: "t", presentation: { type: "ImageOptionSet", rid: "r", phase: "04-keyvisual" } },
  { seq: 5, threadId: "t", presentation: { type: "Done", rid: "r" } },
]
  .map((r) => JSON.stringify(r))
  .join("\n") + "\n";

function goodFiles(): Record<string, string> {
  return {
    "/run/state.json": goodState,
    "/run/04-keyvisual/image-manifest.json": goodManifest,
    "/run/01-brief/brief-verdict.json": goodVerdict,
    "/run/.logs/timing.jsonl": goodTimingJsonl,
    "/tx.jsonl": goodTranscript,
  };
}

const baseInput = { runDir: "/run", transcriptPath: "/tx.jsonl", jobsFailedDir: "/jobs/failed" };

describe("assembleJudgmentReport — 통과", () => {
  it("완결 라이브 런 픽스처 → pass=true · 전 기준 ok · 증거 채움", () => {
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(goodFiles()) });
    expect(r.pass).toBe(true);
    for (const c of r.criteria) expect(c.ok, `${c.id}: ${c.detail}`).toBe(true);
    expect(r.rid).toBe("chat-live-x");
    // 심의 증거(채점 아님) — critic 필드가 실린다.
    expect(r.evidence.verdicts).toHaveLength(1);
    expect(r.evidence.verdicts[0]).toMatchObject({
      verdict: "pass",
      critic_ran: true,
      critic_outcome: "ok",
      review_depth: "rule_engine+critic",
    });
    // 화면 히스토그램·페이즈 순서·timing.
    expect(r.evidence.presentationTypes.Done).toBe(1);
    expect(r.evidence.phaseSequence).toEqual(["00-ingest", "01-brief", "02-concept", "04-keyvisual", "done"]);
    expect(r.evidence.timing).toHaveLength(2);
    expect(r.evidence.failedJobs).toEqual([]);
  });
});

describe("assembleJudgmentReport — 미충족(각 기준)", () => {
  const idOk = (r: ReturnType<typeof assembleJudgmentReport>, id: string): boolean =>
    r.criteria.find((c) => c.id === id)!.ok;

  it("done 미도달 → done-reached ok=false · pass=false", () => {
    const f = goodFiles();
    f["/run/state.json"] = goodState.replace('"phase":"done"', '"phase":"04-keyvisual"');
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "done-reached")).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("페이즈 역행 → gate-order ok=false", () => {
    const bad = JSON.parse(goodState) as { history: Array<Record<string, unknown>> };
    bad.history = [
      { ts: "t", phase: "02-concept", event: "e", by: "b" },
      { ts: "t", phase: "01-brief", event: "e", by: "b" }, // 뒤로 점프
      { ts: "t", phase: "done", event: "e", by: "b", actor: "chat:live:U-driver" },
    ];
    const f = goodFiles();
    f["/run/state.json"] = JSON.stringify(bad);
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "gate-order")).toBe(false);
  });

  it("사람 actor 없음 → audit-actor ok=false", () => {
    const bad = JSON.parse(goodState) as { history: Array<Record<string, unknown>> };
    for (const h of bad.history) delete h.actor;
    const f = goodFiles();
    f["/run/state.json"] = JSON.stringify(bad);
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "audit-actor")).toBe(false);
  });

  it("image-manifest incomplete → image-manifest ok=false", () => {
    const f = goodFiles();
    f["/run/04-keyvisual/image-manifest.json"] = JSON.stringify({ engine: "nanobanana", incomplete: true });
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "image-manifest")).toBe(false);
  });

  it("image-manifest engine=stub → 미완결로 본다(라이브에서 stub 누수)", () => {
    const f = goodFiles();
    f["/run/04-keyvisual/image-manifest.json"] = JSON.stringify({ engine: "stub" });
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "image-manifest")).toBe(false);
  });

  it("image-manifest 부재 → image-manifest ok=false(absent)", () => {
    const f = goodFiles();
    delete f["/run/04-keyvisual/image-manifest.json"];
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    const c = r.criteria.find((x) => x.id === "image-manifest")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("부재");
  });

  it("트랜스크립트에 Failure → failure-zero ok=false", () => {
    const f = goodFiles();
    f["/tx.jsonl"] =
      goodTranscript + JSON.stringify({ seq: 6, threadId: "t", presentation: { type: "Failure", rid: "r", message: "생성 실패" } }) + "\n";
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(idOk(r, "failure-zero")).toBe(false);
  });

  it("실패 잡 .reason 존재 → job-lifecycle ok=false", () => {
    const f = goodFiles();
    f["/jobs/failed/chat-live-x-brief.json.reason"] = "브리지 생성 대기 시간 초과\n";
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    const c = r.criteria.find((x) => x.id === "job-lifecycle")!;
    expect(c.ok).toBe(false);
    expect(r.evidence.failedJobs).toContain("chat-live-x-brief.json.reason");
  });

  it("트랜스크립트·jobsFailed 미제공 → 두 기준 '미확인'(ok=false) + notes", () => {
    const r = assembleJudgmentReport({ runDir: "/run", reader: makeReader(goodFiles()) });
    expect(r.criteria.find((c) => c.id === "failure-zero")!.ok).toBe(false);
    expect(r.criteria.find((c) => c.id === "job-lifecycle")!.ok).toBe(false);
    expect(r.notes.length).toBeGreaterThanOrEqual(2);
  });

  it("state.json 부재 → done-reached·artifacts-schema ok=false(안전 폴백)", () => {
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader({ "/tx.jsonl": goodTranscript }) });
    expect(r.criteria.find((c) => c.id === "done-reached")!.ok).toBe(false);
    expect(r.criteria.find((c) => c.id === "artifacts-schema")!.ok).toBe(false);
  });
});

describe("assembleJudgmentReport — 감사 actor 사람/서비스 구분(S-6 · 표기 보강, 채점 불변)", () => {
  const auditDetail = (r: ReturnType<typeof assembleJudgmentReport>): string =>
    r.criteria.find((c) => c.id === "audit-actor")!.detail;
  const auditOk = (r: ReturnType<typeof assembleJudgmentReport>): boolean =>
    r.criteria.find((c) => c.id === "audit-actor")!.ok;

  it("(a) 사람 actor 만 → 사람 그룹만 · 서비스 그룹/자동주행 문구 없음", () => {
    // goodState 의 actor 는 chat:live:U-driver(끝 세그먼트 U-driver, svc- 아님) = 사람.
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(goodFiles()) });
    expect(auditOk(r)).toBe(true);
    expect(auditDetail(r)).toBe("사람 actor: U-driver");
    expect(auditDetail(r)).not.toContain("서비스(드라이버)");
    expect(auditDetail(r)).not.toContain("자동 주행");
  });

  it("(b) 서비스(svc-) actor 만 → 서비스 그룹 + '사람 결정 0건' 문구 · ok=true(채점 불변)", () => {
    const bad = JSON.parse(goodState) as { history: Array<Record<string, unknown>> };
    for (const h of bad.history) if (typeof h.actor === "string") h.actor = "chat:live:svc-UBOT";
    const f = goodFiles();
    f["/run/state.json"] = JSON.stringify(bad);
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(auditOk(r)).toBe(true); // 서비스만 있어도 합계>0 → 통과(auto-happy 자동 주행 승인 설계).
    expect(r.pass).toBe(true); // 전 구간 svc- 로 주행해도 구조 판정은 그대로 pass.
    expect(auditDetail(r)).toBe(
      "서비스(드라이버) actor: svc-UBOT · 사람 결정 0건(전 구간 드라이버 자동 주행).",
    );
    expect(auditDetail(r)).not.toContain("사람 actor:");
  });

  it("(c) 사람+서비스 혼재 → 두 그룹 구분 표기 · '사람 결정 0건' 문구 없음", () => {
    const bad = JSON.parse(goodState) as { history: Array<Record<string, unknown>> };
    const withActor = bad.history.filter((h) => typeof h.actor === "string");
    withActor[0]!.actor = "chat:live:svc-UBOT"; // 첫 승인은 드라이버(서비스)
    for (let i = 1; i < withActor.length; i++) withActor[i]!.actor = "chat:live:U-alice"; // 이후는 사람
    const f = goodFiles();
    f["/run/state.json"] = JSON.stringify(bad);
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(auditOk(r)).toBe(true);
    expect(auditDetail(r)).toBe("사람 actor: U-alice · 서비스(드라이버) actor: svc-UBOT");
    expect(auditDetail(r)).not.toContain("사람 결정 0건");
  });

  it("actor 전무 → ok=false · '감사 actor 가 없습니다' (안전 폴백 유지)", () => {
    const bad = JSON.parse(goodState) as { history: Array<Record<string, unknown>> };
    for (const h of bad.history) delete h.actor;
    const f = goodFiles();
    f["/run/state.json"] = JSON.stringify(bad);
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(f) });
    expect(auditOk(r)).toBe(false);
    expect(auditDetail(r)).toBe("history 에 감사 actor 가 없습니다.");
  });
});

/** 세션1(죽은 세션) — Failure 화면을 남겼다. */
const sessionOneTranscript = [
  { seq: 0, threadId: "t", presentation: { type: "IngestPrompt", rid: "r" } },
  { seq: 1, threadId: "t", presentation: { type: "Failure", rid: "r", message: "세션1 생성 실패" } },
]
  .map((r) => JSON.stringify(r))
  .join("\n") + "\n";
/** 세션2(attach 세션) — Failure 없이 done 에 닿았다. */
const sessionTwoTranscript = [
  { seq: 0, threadId: "t", presentation: { type: "ApproveGate", rid: "r", phase: "01-brief" } },
  { seq: 1, threadId: "t", presentation: { type: "Done", rid: "r" } },
]
  .map((r) => JSON.stringify(r))
  .join("\n") + "\n";

describe("assembleJudgmentReport — 전 세션 집계(transcriptPaths · P1: final 거짓 통과 처방)", () => {
  const failureZero = (r: ReturnType<typeof assembleJudgmentReport>): (typeof r.criteria)[number] =>
    r.criteria.find((c) => c.id === "failure-zero")!;

  it("(a) 세션 여럿 합산 → 이전 세션 Failure 를 잡아 failure-zero 불통과 + presentationTypes 전 세션 합산", () => {
    const f = goodFiles();
    f["/run/tx.1000.jsonl"] = sessionOneTranscript; // 죽은 세션(Failure 1)
    f["/run/tx.2000.jsonl"] = sessionTwoTranscript; // done 세션(Failure 0)
    // baseInput.transcriptPath = "/tx.jsonl"(Failure 없음)도 같이 넘겨 transcriptPaths 우선순위를 함께 검증한다.
    const r = assembleJudgmentReport({
      ...baseInput,
      transcriptPaths: ["/run/tx.1000.jsonl", "/run/tx.2000.jsonl"],
      reader: makeReader(f),
    });
    const fz = failureZero(r);
    expect(fz.ok).toBe(false); // transcriptPaths 가 transcriptPath(무결)를 이겨 이전 세션 Failure 를 본다.
    expect(fz.detail).toContain("1건");
    // presentationTypes 합산: 세션1(IngestPrompt+Failure) + 세션2(ApproveGate+Done).
    expect(r.evidence.presentationTypes.Failure).toBe(1);
    expect(r.evidence.presentationTypes.IngestPrompt).toBe(1);
    expect(r.evidence.presentationTypes.ApproveGate).toBe(1);
    expect(r.evidence.presentationTypes.Done).toBe(1);
    expect(r.pass).toBe(false);
  });

  it("(b) transcriptPaths 미지정/빈 배열 → 기존 transcriptPath 동작 불변", () => {
    const without = assembleJudgmentReport({ ...baseInput, reader: makeReader(goodFiles()) });
    const withEmpty = assembleJudgmentReport({ ...baseInput, transcriptPaths: [], reader: makeReader(goodFiles()) });
    expect(withEmpty.pass).toBe(without.pass); // 빈 배열 = transcriptPath 폴백(동작 동일).
    expect(failureZero(withEmpty).ok).toBe(true);
    expect(failureZero(without).ok).toBe(true);
    // 단일 경로 폴백은 합산 경고를 남기지 않는다(합산 모드 전용 note).
    expect(withEmpty.notes.some((n) => n.includes("합산에서 제외"))).toBe(false);
  });

  it("(c) listRunTranscripts: 세션형+레거시 무접미 포함 · 무관 파일 제외 · 이름 오름차순 결정적 정렬", () => {
    const reader = makeReader({
      "/art/chat-live-x-transcript.jsonl": "", // 레거시 무접미
      "/art/chat-live-x-transcript.2000.jsonl": "", // 세션형
      "/art/chat-live-x-transcript.1000.jsonl": "", // 세션형
      "/art/chat-live-x-report.final.json": "", // 무관(리포트 json)
      "/art/chat-live-x-report.1000.md": "", // 무관(리포트 md)
      "/art/chat-live-y-transcript.1000.jsonl": "", // 무관(다른 rid — 접두 -transcript 로 배제)
      "/art/chat-live-x-transcript.3000.txt": "", // 무관(.jsonl 아님)
    });
    expect(listRunTranscripts(reader, "/art", "chat-live-x")).toEqual([
      "/art/chat-live-x-transcript.1000.jsonl",
      "/art/chat-live-x-transcript.2000.jsonl",
      "/art/chat-live-x-transcript.jsonl",
    ]);
  });

  it("(d) 목록 중 못 읽는 파일 → notes 경고 + 나머지로 판정", () => {
    const f = goodFiles();
    f["/run/tx.1000.jsonl"] = sessionOneTranscript; // 읽힘(Failure 포함)
    // "/run/tx.MISSING.jsonl" 은 맵에 없음 → readText null(못 읽음).
    const r = assembleJudgmentReport({
      runDir: "/run",
      transcriptPaths: ["/run/tx.1000.jsonl", "/run/tx.MISSING.jsonl"],
      jobsFailedDir: "/jobs/failed",
      reader: makeReader(f),
    });
    expect(r.notes.some((n) => n.includes("/run/tx.MISSING.jsonl"))).toBe(true); // 경고 남김
    expect(failureZero(r).ok).toBe(false); // 나머지(세션1)로 판정 → Failure 1 검출.
  });
});

describe("extractPresentations", () => {
  it("tee render-line({presentation})·transcript entry({screens[]}) 둘 다 수용 · 깨진 줄 무시", () => {
    const jsonl =
      JSON.stringify({ seq: 0, threadId: "t", presentation: { type: "Progress" } }) +
      "\n" +
      "{깨진 줄}\n" +
      JSON.stringify({ utterance: { type: "button" }, screens: [{ type: "ApproveGate" }, { type: "Verdict" }] }) +
      "\n";
    const ps = extractPresentations(jsonl);
    expect(ps.map((p) => (p as { type: string }).type)).toEqual(["Progress", "ApproveGate", "Verdict"]);
  });
  it("빈/널 → 빈 배열", () => {
    expect(extractPresentations(null)).toEqual([]);
    expect(extractPresentations("")).toEqual([]);
  });
});

describe("renderReportMarkdown", () => {
  it("통과 리포트 → 종합 판정·기준표·심의 증거를 담은 마크다운", () => {
    const r = assembleJudgmentReport({ ...baseInput, reader: makeReader(goodFiles()) });
    const md = renderReportMarkdown(r);
    expect(md).toContain("통과(PASS)");
    expect(md).toContain("| 게이트 순서 |");
    expect(md).toContain("심의 증거");
    expect(md).toContain("rule_engine+critic");
  });
});

describe("defaultReader(실 fs 픽스처)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it("실제 파일 트리에서도 통과 판정을 낸다", () => {
    dir = mkdtempSync(join(tmpdir(), "live-report-"));
    const runDir = join(dir, "run");
    mkdirSync(join(runDir, "04-keyvisual"), { recursive: true });
    mkdirSync(join(runDir, "01-brief"), { recursive: true });
    mkdirSync(join(runDir, ".logs"), { recursive: true });
    mkdirSync(join(dir, "jobs", "failed"), { recursive: true });
    writeFileSync(join(runDir, "state.json"), goodState);
    writeFileSync(join(runDir, "04-keyvisual", "image-manifest.json"), goodManifest);
    writeFileSync(join(runDir, "01-brief", "brief-verdict.json"), goodVerdict);
    writeFileSync(join(runDir, ".logs", "timing.jsonl"), goodTimingJsonl);
    const tx = join(dir, "tx.jsonl");
    writeFileSync(tx, goodTranscript);
    const r = assembleJudgmentReport({ runDir, transcriptPath: tx, jobsFailedDir: join(dir, "jobs", "failed") });
    expect(r.pass).toBe(true);
    expect(r.evidence.verdicts).toHaveLength(1);
  });
});
