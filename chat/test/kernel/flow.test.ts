/**
 * flow.test.ts — 커널 오케스트레이션 검증(fake ChatPort · 네트워크/셸 0).
 *   구 adapter/slack/bot.test.ts 를 헥사고날 재정렬에 맞춰 이관: 봇/카드 대신 **중립 이벤트 → 중립 표현**을 본다.
 *   흐름: 멘션→Setup · Select 수집→[시작]→new-run+바인딩+IngestPrompt · 답글=WB/보완사유 · RA=ConfirmGate.
 *
 * ⚠ 플랫폼 무지 회귀: 이 테스트는 Slack/Block Kit 을 전혀 import 하지 않는다 — flow 가 ChatPort(fake)로
 *   Presentation 만 내보내는지 검증한다(구조 분리 증명). 렌더(카드) 검증은 adapters/slack/render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveVerdict,
  enqueueReviewIfDue,
  makeRunId,
  onAction,
  onChoice,
  onMention,
  onOutcome,
  onReply,
  parseActionValue,
  presentationForNext,
  presentationForOutcome,
  renderProgress,
  type Gateway,
} from "../../src/kernel/flow.js";
import type { OptionsDoc } from "../../src/kernel/option-reader.js";
import type { KeyvisualOption } from "../../src/kernel/keyvisual-reader.js";
import type { A2uiSurface } from "../../src/types/a2ui.js";
import {
  GENERATE_RETRY_ACTION_ID,
  NL_INTAKE_CONFIRM_ACTION_ID,
  RA_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
} from "../../src/kernel/interaction.js";
import { StubNlParser } from "../../src/kernel/nl/index.js";
import { isSafeRunId } from "../../src/config.js";
import type { ButtonPressed, MentionReceived, TextReply } from "../../src/kernel/events.js";
import type { Presentation } from "../../src/kernel/presentation.js";
import type { ChatPort } from "../../src/kernel/ports.js";
import type { PendingInput } from "../../src/kernel/pending-input.js";
import type { Job } from "../../src/types/jobs.js";
import type { NextAction } from "../../src/types/contract.js";
import type { WorkerOutcome } from "../../src/kernel/worker.js";

/** 최소 NextAction(테스트 관심 필드만 세팅). */
function na(over: Partial<NextAction> = {}): NextAction {
  return {
    rid: "r",
    phase: "01-brief",
    phase_label: "핵심 정리",
    step: "human",
    gate: "user",
    status: "pending",
    awaiting: null,
    iteration: null,
    max_iterations: null,
    action: "approve",
    stage: null,
    needs: null,
    options: [],
    recommended: null,
    ra_ok_required: false,
    revise_available: false,
    gate_type: null,
    stop_reason: null,
    advisory: null,
    cmd: "",
    gate_label: "승인할 차례",
    hint: "",
    files: [],
    ...over,
  } as NextAction;
}

/** 이벤트 팩토리(중립). actor 는 어댑터가 태그한 형태(`chat:slack:<user>`)를 흉내낸다. */
const mention = (threadId: string, uid = "U1"): MentionReceived => ({ type: "mention", threadId, actor: `chat:slack:${uid}` });
const button = (actionId: string, over: Partial<ButtonPressed> = {}): ButtonPressed => ({
  type: "button",
  actionId,
  actor: "chat:slack:U1",
  threadId: "th-1",
  ...over,
});
const reply = (threadId: string | null, text: string, over: Partial<TextReply> = {}): TextReply => ({
  type: "text",
  threadId,
  text,
  actor: "chat:slack:U1",
  hasAttachments: false,
  ...over,
});

/** 인메모리 PendingInputStore 대역(같은 시그니처). */
function fakePending(): { store: Map<string, PendingInput>; pending: Gateway["pending"] } {
  const store = new Map<string, PendingInput>();
  const pending = {
    get: async (t: string) => store.get(t) ?? null,
    set: async (t: string, v: PendingInput) => void store.set(t, v),
    clear: async (t: string) => void store.delete(t),
    mergeSetup: async (t: string, patch: { product?: string; domain?: string; format?: string }) => {
      const cur = store.get(t) ?? null;
      if (cur !== null && cur.kind !== "setup") return cur; // 실물과 동일: setup 밖 전이 뒤엔 no-op
      const base = cur?.kind === "setup" ? cur : ({ kind: "setup" } as PendingInput);
      const next = { ...base, ...patch, kind: "setup" } as PendingInput;
      store.set(t, next);
      return next;
    },
  } as unknown as Gateway["pending"];
  return { store, pending };
}

interface Harness {
  gw: Gateway;
  jobs: Job[];
  renders: Array<{ threadId: string; p: Presentation }>;
  bound: Array<[string, string]>;
  subscribed: string[];
  store: Map<string, PendingInput>;
}
function fakeGateway(over: Partial<Gateway> = {}): Harness {
  const jobs: Job[] = [];
  const renders: Array<{ threadId: string; p: Presentation }> = [];
  const bound: Array<[string, string]> = [];
  const subscribed: string[] = [];
  const { store, pending } = fakePending();
  const chat: ChatPort = {
    render: async (threadId, p) => void renders.push({ threadId, p }),
    subscribe: async (threadId) => void subscribed.push(threadId),
    capabilities: () => ({ imageDelivery: "upload" }),
  };
  const gw: Gateway = {
    queue: { submit: async (j: Job) => void jobs.push(j) } as unknown as Gateway["queue"],
    map: {
      bindThreadToRun: async (t: string, r: string) => void bound.push([t, r]),
      runForThread: async () => null, // 기본 = 신규 스레드. 재멘션 가드 테스트는 오버라이드.
      threadForRun: async () => "thread-1",
    } as unknown as Gateway["map"],
    pending,
    newRun: (async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as Gateway["newRun"],
    readNext: async () => na({ action: "ingest" }),
    // 기본 = null-object 오버레이(실 spawn 0 · na 기반 폴백) → 기존 테스트는 surface 를 읽지 않아 관측 동등·결정성 보존.
    //   개별 오버레이 테스트만 fake surface 를 주입해 소싱/폴백/drift 를 검증한다.
    readSurface: async () => null,
    isApprover: () => true,
    bundleDir: () => "/staged/bundle",
    stagedWbPath: () => "/staged/wb.md",
    nl: new StubNlParser(),
    nlFileRoots: () => [],
    chat,
    ...over,
  };
  return { gw, jobs, renders, bound, subscribed, store };
}

/** 렌더된 표현들의 type 시퀀스(구조 assert 편의). */
const types = (h: Harness): string[] => h.renders.map((r) => r.p.type);

describe("parseActionValue / makeRunId", () => {
  it("정상 JSON → {run_id, action, stage?, ra_required?} · 깨짐 → null", () => {
    expect(parseActionValue(JSON.stringify({ run_id: "r1", action: "approve" }))).toEqual({
      run_id: "r1",
      action: "approve",
      stage: undefined,
      ra_required: false,
    });
    expect(parseActionValue(JSON.stringify({ run_id: "r1", action: "generate", stage: "brief" }))?.stage).toBe("brief");
    expect(parseActionValue(undefined)).toBeNull();
    expect(parseActionValue("{not json")).toBeNull();
    expect(parseActionValue(JSON.stringify({ action: "approve" }))).toBeNull();
  });
  it("makeRunId: threadId seed → 경로-안전 rid", () => {
    const rid = makeRunId("slack:C123:1699999999.000200");
    expect(isSafeRunId(rid)).toBe(true);
    expect(rid.startsWith("chat-")).toBe(true);
  });
});

describe("enqueueReviewIfDue(라이브 attach 재적재 헬퍼)", () => {
  it("review 차례 → onOutcome 자동 이어가기와 같은 형태(kind/actor/payload)의 심의 잡 1건 재적재", async () => {
    const { gw, jobs } = fakeGateway({ readNext: async () => na({ action: "review", stage: "02-concept" }) });
    const job = await enqueueReviewIfDue(gw, "r9");
    expect(job).toEqual({ kind: "review", run_id: "r9", actor: "chat:auto", payload: {} });
    expect(jobs).toEqual([{ kind: "review", run_id: "r9", actor: "chat:auto", payload: {} }]);
  });

  it("review 아닌 차례(approve) → 재적재 안 함(null · 잡 0)", async () => {
    const { gw, jobs } = fakeGateway({ readNext: async () => na({ action: "approve" }) });
    expect(await enqueueReviewIfDue(gw, "r9")).toBeNull();
    expect(jobs).toHaveLength(0);
  });

  it("generate 차례 → 재적재 안 함(유료 생성 자동 적재 금지 · null · 잡 0)", async () => {
    const { gw, jobs } = fakeGateway({ readNext: async () => na({ action: "generate", stage: "02-concept" }) });
    expect(await enqueueReviewIfDue(gw, "r9")).toBeNull();
    expect(jobs).toHaveLength(0);
  });

  it("readNext 실패(reject) → 재적재 안 함(null · 잡 0)", async () => {
    const { gw, jobs } = fakeGateway({
      readNext: async () => {
        throw new Error("read fail");
      },
    });
    expect(await enqueueReviewIfDue(gw, "r9")).toBeNull();
    expect(jobs).toHaveLength(0);
  });
});

describe("onMention(진입)", () => {
  it("멘션 → pending=setup + Setup 표현 + 스레드 구독", async () => {
    const { gw, renders, subscribed, store } = fakeGateway();
    await onMention(mention("th-1"), gw);
    expect(store.get("th-1")).toEqual({ kind: "setup" });
    expect(subscribed).toEqual(["th-1"]);
    expect(types({ renders } as Harness)).toEqual(["Setup"]);
  });

  it("이미 run 이 있는 스레드의 재멘션은 setup 으로 리셋하지 않는다(Progress 안내만)", async () => {
    const { gw, renders, store } = fakeGateway({
      map: { runForThread: async () => "r-live", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
    });
    store.set("th-1", { kind: "feedback", rid: "r-live" });
    await onMention(mention("th-1"), gw);
    expect(store.get("th-1")).toEqual({ kind: "feedback", rid: "r-live" }); // 보존
    expect(types({ renders } as Harness)).toEqual(["Progress"]);
  });
});

describe("onAction — 설정(Select 수집 → 시작)", () => {
  it("Select 변경(도메인/포맷)이 pending setup 에 수집된다(value=선택 토큰)", async () => {
    const { gw, store } = fakeGateway();
    await onAction(button(SETUP_ACTION_IDS.domain, { value: "화장품" }), gw);
    await onAction(button(SETUP_ACTION_IDS.format, { value: "여러장" }), gw);
    expect(store.get("th-1")).toEqual({ kind: "setup", domain: "화장품", format: "여러장" });
  });

  it("stale Select 클릭은 wb/feedback 대기를 setup 으로 리셋하지 않는다", async () => {
    const { gw, store } = fakeGateway();
    store.set("th-1", { kind: "wb", rid: "r9" });
    await onAction(button(SETUP_ACTION_IDS.domain, { value: "화장품" }), gw);
    expect(store.get("th-1")).toEqual({ kind: "wb", rid: "r9" });
  });

  it("run 바인딩 후 pending 이 비어도 stale Select 는 setup 을 재생성하지 않는다", async () => {
    const { gw, store } = fakeGateway({
      map: { runForThread: async () => "r-live", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
    });
    await onAction(button(SETUP_ACTION_IDS.domain, { value: "화장품" }), gw);
    expect(store.has("th-1")).toBe(false);
  });

  it("[시작] — 제품명·선택 완료면 new-run(name 동봉)→바인딩→pending=wb→IngestPrompt", async () => {
    const newRunArgs: unknown[] = [];
    const { gw, store, bound, renders } = fakeGateway({
      newRun: (async (rid: string, opts: unknown) => {
        newRunArgs.push([rid, opts]);
        return { code: 0, stdout: "", stderr: "" };
      }) as unknown as Gateway["newRun"],
    });
    store.set("th-1", { kind: "setup", product: "이지듀 쿠션", domain: "화장품", format: "여러장" });
    await onAction(button(SETUP_ACTION_IDS.start), gw);
    expect(bound).toHaveLength(1);
    expect(bound[0]![0]).toBe("th-1");
    expect(isSafeRunId(bound[0]![1])).toBe(true);
    expect((newRunArgs[0] as [string, { name?: string }])[1].name).toBe("이지듀 쿠션");
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
    expect(types({ renders } as Harness)).toEqual(["IngestPrompt"]);
  });

  it("[시작] — 미선택이면 new-run 하지 않고 Setup 재게시", async () => {
    const { gw, store, bound, renders } = fakeGateway();
    store.set("th-1", { kind: "setup", product: "P", domain: "화장품" }); // format 없음
    await onAction(button(SETUP_ACTION_IDS.start), gw);
    expect(bound).toHaveLength(0);
    expect(types({ renders } as Harness)).toEqual(["Setup"]);
  });

  it("[시작] — 제품명 없으면 new-run 하지 않는다(placeholder 진행 차단)", async () => {
    const { gw, store, bound, renders } = fakeGateway();
    store.set("th-1", { kind: "setup", domain: "화장품", format: "여러장" }); // product 없음
    await onAction(button(SETUP_ACTION_IDS.start), gw);
    expect(bound).toHaveLength(0);
    expect(types({ renders } as Harness)).toEqual(["Setup"]);
  });

  it("[시작] 재클릭 — 이미 run 바인딩된 스레드면 new-run 안 하고 Progress 안내(wb 리셋 방지)", async () => {
    const { gw, bound, store, renders } = fakeGateway({
      map: { runForThread: async () => "r-live", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
    });
    store.set("th-1", { kind: "feedback", rid: "r-live" });
    await onAction(button(SETUP_ACTION_IDS.start), gw);
    expect(bound).toHaveLength(0);
    expect(store.get("th-1")).toEqual({ kind: "feedback", rid: "r-live" });
    expect(types({ renders } as Harness)).toEqual(["Progress"]);
  });

  it("[시작] — new-run 실패(비-0)면 바인딩 없이 Progress 안내", async () => {
    const { gw, store, bound, renders } = fakeGateway({
      newRun: (async () => ({ code: 1, stdout: "", stderr: "dup" })) as unknown as Gateway["newRun"],
    });
    store.set("th-1", { kind: "setup", domain: "화장품", format: "한장", product: "P" });
    await onAction(button(SETUP_ACTION_IDS.start), gw);
    expect(bound).toHaveLength(0);
    expect(types({ renders } as Harness)).toEqual(["Progress"]);
  });
});

describe("onAction — 잡 버튼", () => {
  it("승인 버튼(ra_required 아님) → approve 잡(actor 그대로 전달)", async () => {
    const { gw, jobs } = fakeGateway();
    const r = await onAction(button("approve", { value: JSON.stringify({ run_id: "r9", action: "approve" }), actor: "chat:slack:U1" }), gw);
    expect(jobs[0]).toMatchObject({ kind: "approve", run_id: "r9", actor: "chat:slack:U1" });
    expect(r?.enqueued).toBeDefined();
  });

  it("재생성 버튼 → generate 잡 + payload.stage", async () => {
    const { gw, jobs } = fakeGateway();
    await onAction(button("regenerate", { value: JSON.stringify({ run_id: "r9", action: "generate", stage: "brief" }) }), gw);
    expect(jobs[0]).toMatchObject({ kind: "generate", run_id: "r9", payload: { stage: "brief" } });
  });

  it("RA 필수 승인 → 잡 대신 ConfirmGate 표현(직접 승인 금지)", async () => {
    const { gw, jobs, renders } = fakeGateway();
    await onAction(button("approve", { value: JSON.stringify({ run_id: "r9", action: "approve", ra_required: true }) }), gw);
    expect(jobs).toHaveLength(0);
    expect(types({ renders } as Harness)).toEqual(["ConfirmGate"]);
  });

  it("RA 확인 버튼 — 승인자면 approve(ra_ok=true) 잡 · 비승인자면 잡 미적재(우회 차단)", async () => {
    const okH = fakeGateway({ isApprover: () => true });
    await onAction(button(RA_CONFIRM_ACTION_ID, { value: JSON.stringify({ run_id: "r9", action: "approve" }) }), okH.gw);
    expect(okH.jobs[0]).toMatchObject({ kind: "approve", run_id: "r9", payload: { ra_ok: true } });

    const denyH = fakeGateway({ isApprover: () => false });
    await onAction(button(RA_CONFIRM_ACTION_ID, { value: JSON.stringify({ run_id: "r9", action: "approve" }), actor: "chat:slack:U9" }), denyH.gw);
    expect(denyH.jobs).toHaveLength(0);
  });

  it("[보완] 버튼 → 잡 대신 pending=feedback + 답글 안내(Progress)", async () => {
    const { gw, jobs, renders, store } = fakeGateway();
    await onAction(button("revise", { value: JSON.stringify({ run_id: "r9", action: "revise" }) }), gw);
    expect(jobs).toHaveLength(0);
    expect(store.get("th-1")).toEqual({ kind: "feedback", rid: "r9" });
    expect(types({ renders } as Harness)).toEqual(["Progress"]);
  });

  it("비승인자의 [보완] 클릭은 feedback 대기를 만들지 않는다(대기 선점 차단)", async () => {
    const { gw, store } = fakeGateway({ isApprover: () => false });
    await onAction(button("revise", { value: JSON.stringify({ run_id: "r9", action: "revise" }), actor: "chat:slack:U9" }), gw);
    expect(store.has("th-1")).toBe(false);
  });

  it("[붙여넣기 없이 진행] — 번들+WB 둘 다 스테이징돼야 ingest 잡(wb_path 동봉) · 대기 유지", async () => {
    const { gw, jobs, store } = fakeGateway();
    store.set("th-1", { kind: "wb", rid: "r9" });
    await onAction(button("ingest-staged", { value: JSON.stringify({ run_id: "r9", action: "ingest" }) }), gw);
    expect(jobs[0]).toMatchObject({
      kind: "ingest",
      run_id: "r9",
      payload: { bundle_dir: "/staged/bundle", wb_path: "/staged/wb.md" },
    });
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("[붙여넣기 없이 진행] — WB 스테이징 없으면 잡 미적재 + 붙여넣기 재안내", async () => {
    const { gw, jobs, renders, store } = fakeGateway({ stagedWbPath: () => undefined });
    store.set("th-1", { kind: "wb", rid: "r9" });
    await onAction(button("ingest-staged", { value: JSON.stringify({ run_id: "r9", action: "ingest" }) }), gw);
    expect(jobs).toHaveLength(0);
    expect(renders.length).toBeGreaterThan(0);
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("stale [붙여넣기 없이 진행] 클릭은 다른 대기(feedback)를 지우지 않는다", async () => {
    const { gw, store } = fakeGateway();
    store.set("th-1", { kind: "feedback", rid: "r9" });
    await onAction(button("ingest-staged", { value: JSON.stringify({ run_id: "r9", action: "ingest" }) }), gw);
    expect(store.get("th-1")).toEqual({ kind: "feedback", rid: "r9" });
  });
});

describe("onReply — 답글 자유 입력", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "chat-flow-"));
    process.env.CHAT_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    delete process.env.CHAT_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("pending=setup: 답글 = 제품명 수집 → Setup 재게시(수집 상태 반영)", async () => {
    const { gw, renders, store } = fakeGateway();
    store.set("th-1", { kind: "setup", domain: "화장품" });
    await onReply(reply("th-1", "이지듀 쿠션"), gw);
    expect(store.get("th-1")).toEqual({ kind: "setup", product: "이지듀 쿠션", domain: "화장품" });
    expect(types({ renders } as Harness)).toEqual(["Setup"]);
  });

  it("pending=wb: 답글 본문 → working-backwards.md 저장 + ingest 잡(bundle+wb_path) · 대기 유지", async () => {
    const { gw, jobs, store } = fakeGateway();
    store.set("th-1", { kind: "wb", rid: "r-att" });
    await onReply(reply("th-1", "# 핵심\n제품 소개 본문"), gw);
    const job = jobs.find((j) => j.kind === "ingest");
    expect(job).toBeDefined();
    expect(job!.run_id).toBe("r-att");
    expect(job!.payload.bundle_dir).toBe("/staged/bundle");
    expect(String(job!.payload.wb_path)).toContain("working-backwards-");
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("pending=wb: 파일 첨부(텍스트 없음) → 붙여넣기 안내만(잡 없음 · pending 유지)", async () => {
    const { gw, jobs, renders, store } = fakeGateway();
    store.set("th-1", { kind: "wb", rid: "r-att" });
    await onReply(reply("th-1", "", { hasAttachments: true }), gw);
    expect(jobs).toHaveLength(0);
    expect(renders.length).toBeGreaterThan(0);
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("pending=wb: 첨부 + 짧은 코멘트도 통째로 거절", async () => {
    const { gw, jobs, store } = fakeGateway();
    store.set("th-1", { kind: "wb", rid: "r-att" });
    await onReply(reply("th-1", "여기 파일이요", { hasAttachments: true }), gw);
    expect(jobs).toHaveLength(0);
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("pending=wb: 번들 미설정이면 안내만(잡 없음 · pending 유지)", async () => {
    const { gw, jobs, renders, store } = fakeGateway({ bundleDir: () => undefined });
    store.set("th-1", { kind: "wb", rid: "r-att" });
    await onReply(reply("th-1", "본문"), gw);
    expect(jobs).toHaveLength(0);
    expect(renders.length).toBeGreaterThan(0);
    expect(store.get("th-1")).toMatchObject({ kind: "wb" });
  });

  it("pending=feedback: 승인자 답글 → revise 잡(payload.feedback) + pending 해제", async () => {
    const { gw, jobs, store } = fakeGateway();
    store.set("th-1", { kind: "feedback", rid: "r9" });
    await onReply(reply("th-1", "이 표현 빼주세요"), gw);
    expect(jobs[0]).toMatchObject({ kind: "revise", run_id: "r9", payload: { feedback: "이 표현 빼주세요" } });
    expect(store.has("th-1")).toBe(false);
  });

  it("pending=feedback: 비승인자 답글 → 잡 미적재 + pending 유지", async () => {
    const { gw, jobs, store } = fakeGateway({ isApprover: () => false });
    store.set("th-1", { kind: "feedback", rid: "r9" });
    await onReply(reply("th-1", "빼주세요", { actor: "chat:slack:U9" }), gw);
    expect(jobs).toHaveLength(0);
    expect(store.get("th-1")).toMatchObject({ kind: "feedback" });
  });

  it("pending 없음 답글은 무시", async () => {
    const { gw, jobs, renders } = fakeGateway();
    await onReply(reply("th-x", "그냥 대화"), gw);
    expect(jobs).toHaveLength(0);
    expect(renders).toHaveLength(0);
  });
});

describe("onOutcome — wb/feedback 대기 수명", () => {
  it("ingest 성공 → 해당 run 의 wb 대기 해제", async () => {
    const { gw, store } = fakeGateway();
    store.set("thread-1", { kind: "wb", rid: "r" });
    const out = { kind: "ingest", run_id: "r", ok: true, message: "", next: na({ action: "generate", stage: "guideline" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(store.has("thread-1")).toBe(false);
  });

  it("ingest 실패 → wb 대기 유지(재붙여넣기 복구)", async () => {
    const { gw, store } = fakeGateway();
    store.set("thread-1", { kind: "wb", rid: "r" });
    const out = { kind: "ingest", run_id: "r", ok: false, message: "인입 실패", next: null } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(store.get("thread-1")).toMatchObject({ kind: "wb" });
  });

  it("다른 성공 동작(승인)으로 run 이 전진하면 stale feedback 대기 무효화", async () => {
    const { gw, store } = fakeGateway();
    store.set("thread-1", { kind: "feedback", rid: "r" });
    const out = { kind: "approve", run_id: "r", ok: true, message: "", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(store.has("thread-1")).toBe(false);
  });

  it("성공해도 다른 run 의 feedback 대기는 건드리지 않는다", async () => {
    const { gw, store } = fakeGateway();
    store.set("thread-1", { kind: "feedback", rid: "other-run" });
    const out = { kind: "approve", run_id: "r", ok: true, message: "", next: na() } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(store.get("thread-1")).toMatchObject({ kind: "feedback", rid: "other-run" });
  });
});

describe("onOutcome 자동 진행/실패", () => {
  it("성공 + next=generate(브리프 구간 stage=brief) → generate 잡 자동 적재", async () => {
    const { gw, jobs } = fakeGateway();
    const out = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "generate", stage: "brief" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(jobs.some((j) => j.kind === "generate" && j.payload.stage === "brief")).toBe(true);
  });

  it("P1: 브리프 너머 concept 생성도 자동 적재(구 '브리프 경계'에서 인계하던 것 해제)", async () => {
    const { gw, jobs } = fakeGateway();
    const out = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "generate", stage: "concept" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(jobs.some((j) => j.kind === "generate" && j.payload.stage === "concept")).toBe(true);
  });

  it("P1: storyboard-outline·storyboard-plan 생성도 자동 적재", async () => {
    for (const stage of ["storyboard-outline", "storyboard-plan"]) {
      const { gw, jobs } = fakeGateway();
      const out = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "generate", stage }) } as WorkerOutcome;
      await onOutcome(out, gw);
      expect(jobs.some((j) => j.kind === "generate" && j.payload.stage === stage)).toBe(true);
    }
  });

  it("P2: keyvisual 생성도 자동 적재(구 '담당자 인계' 해제 — 디자인까지 자동 생성)", async () => {
    const { gw, jobs } = fakeGateway();
    const out = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "generate", stage: "keyvisual" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(jobs.some((j) => j.kind === "generate" && j.payload.stage === "keyvisual")).toBe(true);
  });

  it("select next(다안)는 생성/심의 자동 잇지 않고 OptionSet 만 게시(사람 선택 대기)", async () => {
    const { gw, jobs, renders } = fakeGateway({
      readNext: async () => na({ action: "select", options: ["A", "B"], recommended: "A" }),
    });
    const out = { kind: "generate", run_id: "r", ok: true, message: "", next: na({ phase: "02-concept", action: "select", options: ["A", "B"], recommended: "A" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(jobs).toHaveLength(0); // 자동 잡 없음
    expect(renders.map((r) => r.p.type)).toContain("OptionSet");
  });

  it("실패 → 자동 재큐하지 않고 사유만 게시(무한 재시도 방지)", async () => {
    const { gw, jobs, renders } = fakeGateway();
    const out = { kind: "generate", run_id: "r", ok: false, message: "만들지 못했어요", next: na({ action: "generate", stage: "brief" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(jobs).toHaveLength(0);
    expect(renders.length).toBeGreaterThan(0);
  });

  it("실패 카드는 Failure 표현(사유 + [상태 다시 확인] 화해) — 늦은 성공에 스레드가 굳지 않게(프로토콜 v2)", async () => {
    const { gw, renders } = fakeGateway();
    const out = { kind: "generate", run_id: "r", ok: false, message: "생성을 마치지 못했습니다.", next: na({ action: "generate", stage: "brief" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
    expect(renders[0]!.p).toMatchObject({ type: "Failure", rid: "r", message: "생성을 마치지 못했습니다." });
  });

  it("next 를 못 읽은 실패도 Failure 표현(화해 버튼이 붙는다 — 그때가 가장 필요한 순간)", async () => {
    const { gw, renders } = fakeGateway();
    const out = { kind: "generate", run_id: "r", ok: false, message: "실패", next: null } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(renders[0]!.p.type).toBe("Failure");
  });
});

describe("[상태 다시 확인](RECONCILE) — 늦은 성공 화해 · 읽기 전용", () => {
  it("현재 게이트 카드를 다시 그린다(잡 0 · 상태 변이 0)", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: {
        runForThread: async () => "r-late",
        threadForRun: async () => "th-1",
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
      // 봇이 포기한 뒤 소비자가 늦게 성공 → 지금은 승인 차례다.
      readNext: async () => na({ action: "approve", gate_label: "승인할 차례" }),
    });
    await onAction(button(RECONCILE_ACTION_ID, { value: JSON.stringify({ run_id: "r-late", action: "reconcile" }) }), gw);
    expect(jobs).toHaveLength(0); // 읽기 전용 — 어떤 게이트도 우회하지 않는다
    expect(renders.map((r) => r.p.type)).toEqual(["ApproveGate"]);
  });

  it("비승인자도 누를 수 있다(상태를 바꾸지 않는 '본다' 동작)", async () => {
    const { gw, renders } = fakeGateway({
      isApprover: () => false,
      map: {
        runForThread: async () => "r-late",
        threadForRun: async () => "th-1",
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
      readNext: async () => na({ action: "approve" }),
    });
    await onAction(button(RECONCILE_ACTION_ID), gw);
    expect(renders.map((r) => r.p.type)).toEqual(["ApproveGate"]);
  });

  it("run_id 는 스레드 매핑으로만 해석 — 버튼 value 의 남의 run_id 를 따르지 않는다(변조 방어)", async () => {
    const asked: string[] = [];
    const { gw } = fakeGateway({
      map: {
        runForThread: async () => "r-mine",
        threadForRun: async () => "th-1",
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
      readNext: async (rid: string) => {
        asked.push(rid);
        return na({ action: "approve" });
      },
    });
    await onAction(button(RECONCILE_ACTION_ID, { value: JSON.stringify({ run_id: "r-남의런", action: "reconcile" }) }), gw);
    expect(asked).toEqual(["r-mine"]);
  });

  it("스레드에 run 이 없으면 no-op(확인할 대상 없음)", async () => {
    const { gw, jobs, renders } = fakeGateway(); // runForThread → null
    await onAction(button(RECONCILE_ACTION_ID), gw);
    expect(jobs).toHaveLength(0);
    expect(renders).toHaveLength(0);
  });

  it("상태 조회 실패 → 평이 안내(카드 없이 침묵하지 않는다)", async () => {
    const { gw, renders } = fakeGateway({
      map: {
        runForThread: async () => "r-late",
        threadForRun: async () => "th-1",
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
      readNext: async () => {
        throw new Error("셸 실패");
      },
    });
    await onAction(button(RECONCILE_ACTION_ID), gw);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.p).toMatchObject({ type: "Progress" });
    expect((renders[0]!.p as { message: string }).message).toMatch(/확인하지 못했/);
  });
});

describe("[다시 만들기](GENERATE_RETRY) — 회수된 생성의 출구(프로토콜 v2 · 새 요청)", () => {
  /** 스레드 th-1 ↔ run r-1 이 바인딩된 게이트웨이. */
  const boundGw = (over: Partial<Gateway> = {}): Harness =>
    fakeGateway({
      map: {
        runForThread: async () => "r-1",
        threadForRun: async () => "th-1",
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
      ...over,
    });

  it("★ [상태 다시 확인] 인데 아직 생성 차례 → GenerateRetry 카드(버튼 없는 '만드는 중' 으로 굳지 않는다)", async () => {
    // 봇이 대기 상한에 포기하며 요청을 회수했다 → 아무도 안 만드는데 core 는 그대로 생성 차례.
    const { gw, jobs, renders } = boundGw({
      readNext: async () => na({ rid: "r-1", action: "generate", stage: "brief", phase_label: "핵심 정리" }),
    });
    await onAction(button(RECONCILE_ACTION_ID), gw);
    expect(jobs).toHaveLength(0); // [상태 다시 확인] 자체는 여전히 읽기 전용
    expect(renders.map((r) => r.p.type)).toEqual(["GenerateRetry"]);
    // rid·header 는 core 산출(next-action) passthrough — 카드가 지금 상태를 그대로 옮긴다.
    expect(renders[0]!.p).toMatchObject({ type: "GenerateRetry", rid: "r-1", header: "핵심 정리", stage: "brief" });
  });

  it("자연어 실행 요청(진행해줘)에도 같은 출구를 준다(NL 은 실행하지 않음 — 카드만)", async () => {
    const { gw, jobs, renders } = boundGw({ readNext: async () => na({ action: "generate", stage: "brief" }) });
    await onReply(reply("th-1", "진행해줘"), gw); // pending 없음 → handleNoPendingReply
    expect(jobs).toHaveLength(0); // 방아쇠는 버튼(잠긴 결정 6)
    expect(renders.map((r) => r.p.type)).toEqual(["GenerateRetry"]);
  });

  it("★ 클릭 → 생성 잡 재적재(새 요청) · run_id 는 스레드 매핑 · stage 는 지금 차례의 것", async () => {
    const asked: string[] = [];
    const { gw, jobs, renders } = boundGw({
      readNext: async (rid: string) => {
        asked.push(rid);
        return na({ action: "generate", stage: "brief" });
      },
    });
    await onAction(
      button(GENERATE_RETRY_ACTION_ID, { value: JSON.stringify({ run_id: "r-남의런", action: "generate", stage: "brief" }) }),
      gw,
    );
    expect(asked).toEqual(["r-1"]); // 버튼 value 의 run_id 불신(reconcile 과 동일)
    expect(jobs).toEqual([{ kind: "generate", run_id: "r-1", actor: "chat:slack:U1", payload: { stage: "brief" } }]);
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]); // 재요청 접수 안내
  });

  it("★ 그새 늦게 성공했으면(생성 차례 아님) 만들지 않는다 — 지금 게이트 카드만(끝난 일 재실행 금지)", async () => {
    const { gw, jobs, renders } = boundGw({ readNext: async () => na({ action: "approve", gate_label: "승인할 차례" }) });
    await onAction(
      button(GENERATE_RETRY_ACTION_ID, { value: JSON.stringify({ run_id: "r-1", action: "generate", stage: "brief" }) }),
      gw,
    );
    expect(jobs).toHaveLength(0);
    expect(renders.map((r) => r.p.type)).toEqual(["ApproveGate"]);
  });

  it("★ 옛 카드 클릭(도장 stage ≠ 지금 stage) → 만들지 않고 지금 단계의 재요청 카드만", async () => {
    const { gw, jobs, renders } = boundGw({ readNext: async () => na({ action: "generate", stage: "concept" }) });
    await onAction(
      button(GENERATE_RETRY_ACTION_ID, { value: JSON.stringify({ run_id: "r-1", action: "generate", stage: "brief" }) }),
      gw,
    );
    expect(jobs).toHaveLength(0);
    expect(renders[0]!.p).toMatchObject({ type: "GenerateRetry", stage: "concept" });
  });

  it("스레드에 run 이 없으면 no-op · 상태 조회 실패면 평이 안내(잡 0)", async () => {
    const none = fakeGateway(); // runForThread → null
    await onAction(button(GENERATE_RETRY_ACTION_ID), none.gw);
    expect(none.jobs).toHaveLength(0);
    expect(none.renders).toHaveLength(0);

    const broken = boundGw({
      readNext: async () => {
        throw new Error("셸 실패");
      },
    });
    await onAction(button(GENERATE_RETRY_ACTION_ID), broken.gw);
    expect(broken.jobs).toHaveLength(0);
    expect((broken.renders[0]!.p as { message: string }).message).toMatch(/확인하지 못했/);
  });

  it("자동 이어가기(onOutcome)의 생성 카드에는 재요청 버튼이 붙지 않는다 — 그때는 정말 만드는 중이다", async () => {
    const { gw, jobs, renders } = boundGw({ readNext: async () => na({ action: "generate", stage: "concept" }) });
    const out = { kind: "select", run_id: "r-1", ok: true, message: "", next: na({ action: "generate", stage: "concept" }) } as WorkerOutcome;
    await onOutcome(out, gw);
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]); // GenerateRetry 아님
    expect(jobs.map((j) => j.kind)).toEqual(["generate"]); // 카드 직후 실제로 생성 잡을 넣는다
  });
});

describe("deriveVerdict / presentationForOutcome", () => {
  it("deriveVerdict: escalated→human · (revise|changes_requested)→revise · 그 외→pass(step 무관)", () => {
    expect(deriveVerdict(na({ status: "escalated" }))).toBe("human");
    expect(deriveVerdict(na({ status: "revise" }))).toBe("revise");
    expect(deriveVerdict(na({ status: "changes_requested" }))).toBe("revise");
    expect(deriveVerdict(na({ step: "generate", status: "pending" }))).toBe("pass");
    expect(deriveVerdict(na({ step: "human", status: "pending" }))).toBe("pass");
  });

  it("presentationForOutcome(review) → Verdict · approve → ApproveGate · next 없으면 null", async () => {
    const reviewOutcome = { kind: "review", run_id: "r", ok: true, message: "", next: na({ status: "pending", step: "human" }) } as WorkerOutcome;
    expect((await presentationForOutcome(reviewOutcome))?.type).toBe("Verdict");
    const approveNext = { kind: "generate", run_id: "r", ok: true, message: "", next: na({ action: "approve" }) } as WorkerOutcome;
    expect((await presentationForOutcome(approveNext))?.type).toBe("ApproveGate");
    const noNext = { kind: "approve", run_id: "r", ok: true, message: "", next: null } as WorkerOutcome;
    expect(await presentationForOutcome(noNext)).toBeNull();
  });

  it("presentationForOutcome: raise-limit(에스컬레이션)은 review 아웃컴이어도 Escalation(verdict 가로채기 방지)", async () => {
    const escReview = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "raise-limit", status: "escalated" }) } as WorkerOutcome;
    const escGen = { kind: "raise-limit", run_id: "r", ok: true, message: "", next: na({ action: "raise-limit", status: "escalated" }) } as WorkerOutcome;
    expect((await presentationForOutcome(escReview))?.type).toBe("Escalation");
    expect((await presentationForOutcome(escGen))?.type).toBe("Escalation");
  });

  it("presentationForOutcome(select) → OptionSet(안 키·추천 매핑·제목/본문은 주입 reader 에서)", async () => {
    const fakeDoc: OptionsDoc = {
      compareMd: "# 컨셉 안 비교\n\n## A-efficacy\n- **메시지**: 효능 메시지\n- **근거**: 근거 A\n\n## B-safety\n- **메시지**: 안전 메시지\n- **근거**: 근거 B\n",
      sections: [
        { header: "A-efficacy", title: "효능 메시지", body: "## A-efficacy\n- **메시지**: 효능 메시지\n- **근거**: 근거 A" },
        { header: "B-safety", title: "안전 메시지", body: "## B-safety\n- **메시지**: 안전 메시지\n- **근거**: 근거 B" },
      ],
    };
    const reader = async (_rid: string, _phase: string): Promise<OptionsDoc> => fakeDoc;
    const out = {
      kind: "generate",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "02-concept", phase_label: "메시지 방향", action: "select", options: ["A-efficacy", "B-safety"], recommended: "B-safety", revise_available: true }),
    } as WorkerOutcome;
    const p = await presentationForOutcome(out, reader);
    expect(p?.type).toBe("OptionSet");
    const os = p as Extract<Presentation, { type: "OptionSet" }>;
    expect(os.header).toBe("메시지 방향"); // phase_label passthrough
    expect(os.options.map((o) => o.key)).toEqual(["A-efficacy", "B-safety"]);
    expect(os.options.map((o) => o.recommended)).toEqual([false, true]); // recommended=B-safety
    expect(os.options[0]!.title).toBe("효능 메시지");
    expect(os.options[0]!.body).toContain("근거 A");
    expect(os.reviseAvailable).toBe(true);
  });

  it("presentationForOutcome(select): 섹션 부재 안은 body 빈 문자열·title=키로 우아하게 폴백(throw 없음)", async () => {
    const reader = async (): Promise<OptionsDoc> => ({ compareMd: "", sections: [] });
    const out = {
      kind: "generate",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "02-concept", action: "select", options: ["A-efficacy", "B-safety"], recommended: "A-efficacy" }),
    } as WorkerOutcome;
    const os = (await presentationForOutcome(out, reader)) as Extract<Presentation, { type: "OptionSet" }>;
    expect(os.options.map((o) => o.title)).toEqual(["A-efficacy", "B-safety"]);
    expect(os.options.every((o) => o.body === "")).toBe(true);
    expect(os.options[0]!.recommended).toBe(true);
  });

  // ── P2: 04-keyvisual select → ImageOptionSet(이미지 다안) · 그 외 select → OptionSet(md 다안) ──
  it("presentationForOutcome(select, 04-keyvisual) → ImageOptionSet(안 키·추천·이미지경로·캡션 + phase/iteration 도장)", async () => {
    const readKv = async (rid: string, keys: string[], rec: string | null): Promise<KeyvisualOption[]> =>
      keys.map((key) => ({
        key,
        imagePaths: [`/runs/${rid}/04-keyvisual/options/${key}/shots/full.png`],
        caption: `${key}안 · 이미지 1장`,
        recommended: key === rec,
      }));
    const out = {
      kind: "generate",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "04-keyvisual", phase_label: "디자인", action: "select", iteration: 1, options: ["A", "B", "C"], recommended: "B", revise_available: true }),
    } as WorkerOutcome;
    const p = await presentationForOutcome(out, undefined, readKv);
    expect(p?.type).toBe("ImageOptionSet");
    const ios = p as Extract<Presentation, { type: "ImageOptionSet" }>;
    expect(ios.header).toBe("디자인"); // phase_label passthrough
    expect(ios.phase).toBe("04-keyvisual"); // stale 도장
    expect(ios.iteration).toBe(1); // stale 도장
    expect(ios.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(ios.options.map((o) => o.recommended)).toEqual([false, true, false]); // recommended=B
    expect(ios.options[1]!.imagePaths[0]).toContain("options/B/shots/full.png");
    expect(ios.options[0]!.caption).toContain("A안");
    expect(ios.reviseAvailable).toBe(true);
  });

  it("presentationForOutcome(select, 02-concept)는 여전히 md OptionSet(이미지 리더 무시)", async () => {
    const readOptions = async (): Promise<OptionsDoc> => ({ compareMd: "", sections: [] });
    let kvCalled = false;
    const readKv = async (): Promise<KeyvisualOption[]> => {
      kvCalled = true;
      return [];
    };
    const out = {
      kind: "generate",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "02-concept", action: "select", options: ["A-efficacy"], recommended: "A-efficacy" }),
    } as WorkerOutcome;
    const p = await presentationForOutcome(out, readOptions, readKv);
    expect(p?.type).toBe("OptionSet");
    expect(kvCalled).toBe(false); // 이미지 리더는 호출되지 않는다(md 경로)
  });

  it("presentationForOutcome(done) → Done(최종 산출물 경로 + 완료 안내) · review 아웃컴이 done 이어도 Verdict 아님", async () => {
    const doneReview = {
      kind: "review",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "done", phase_label: "완료", action: "done", status: "approved", files: ["04-keyvisual/export/kcia-package"] }),
    } as WorkerOutcome;
    const p = await presentationForOutcome(doneReview);
    expect(p?.type).toBe("Done"); // done 은 pass verdict 를 가로채 마지막 화면으로
    const d = p as Extract<Presentation, { type: "Done" }>;
    expect(d.header).toBe("완료");
    expect(d.files).toEqual(["04-keyvisual/export/kcia-package"]);
    expect(d.message.length).toBeGreaterThan(0);
  });

  it("presentationForOutcome(done): files 없으면 빈 배열 + 평이 완료 한 줄(throw 없음)", async () => {
    const out = {
      kind: "generate",
      run_id: "r",
      ok: true,
      message: "",
      next: na({ phase: "done", phase_label: "", action: "done", status: "approved", files: [] }),
    } as WorkerOutcome;
    const d = (await presentationForOutcome(out)) as Extract<Presentation, { type: "Done" }>;
    expect(d.type).toBe("Done");
    expect(d.files).toEqual([]);
    expect(d.header).toBe("완료"); // header 폴백
  });
});

describe("A2UI surface 오버레이(관측 동등 · drift 보호 · 폴백)", () => {
  /** derive() 반환 dict 형태의 A2uiSurface(합리적 기본 + 오버라이드). */
  const surfaceOf = (over: Partial<A2uiSurface> = {}): A2uiSurface => ({
    rid: "r",
    phase: "01-brief",
    // gate·status 는 실제 a2ui-surface.sh 가 싣는 필드(게이트 스냅샷 일치 가드가 대조) — na() 기본(gate:user·status:pending)과
    //   일치시켜 정상 경로에서 surface 가 소비되게 한다(불일치 케이스는 별도 테스트).
    gate: "user",
    status: "pending",
    surface: "approve",
    step: null,
    needs_approve_after_select: false,
    action: "approve",
    actions: ["approve", "revise"],
    options: [],
    recommended: null,
    revise_available: true,
    ra_ok_required: false,
    ...over,
  });
  const readSurfaceOf = (s: A2uiSurface | null) => async (): Promise<A2uiSurface | null> => s;
  const NULL_SURFACE = async (): Promise<A2uiSurface | null> => null;
  const conceptDoc: OptionsDoc = {
    compareMd: "# 비교\n\n## A-efficacy\n- **메시지**: 효능\n\n## B-safety\n- **메시지**: 안전\n",
    sections: [
      { header: "A-efficacy", title: "효능", body: "## A-efficacy\n- **메시지**: 효능" },
      { header: "B-safety", title: "안전", body: "## B-safety\n- **메시지**: 안전" },
    ],
  };
  const readConcept = async (): Promise<OptionsDoc> => conceptDoc;

  // ── 관측 동등: surface(actions 가 na 와 일치) 경로 출력이 null 경로와 '완전히 동일'해야 한다 ──
  it("관측 동등 — brief approve: null vs surface(actions 일치) → 동일 ApproveGate", async () => {
    const naApprove = na({ action: "approve", revise_available: true, ra_ok_required: false });
    const withNull = await presentationForNext(naApprove, undefined, undefined, NULL_SURFACE);
    const withSurface = await presentationForNext(
      naApprove,
      undefined,
      undefined,
      readSurfaceOf(surfaceOf({ actions: ["approve", "revise"], revise_available: true, ra_ok_required: false })),
    );
    expect(withSurface).toEqual(withNull); // 오늘 출력 동일(관측 동등 고정)
    expect((withNull as { reviseAvailable: boolean }).reviseAvailable).toBe(true);
  });

  it("관측 동등 — concept select: null vs surface(actions 일치) → 동일 OptionSet", async () => {
    const naSelect = na({
      phase: "02-concept",
      phase_label: "메시지 방향",
      action: "select",
      options: ["A-efficacy", "B-safety"],
      recommended: "B-safety",
      revise_available: true,
    });
    const withNull = await presentationForNext(naSelect, readConcept, undefined, NULL_SURFACE);
    const withSurface = await presentationForNext(
      naSelect,
      readConcept,
      undefined,
      readSurfaceOf(surfaceOf({ phase: "02-concept", surface: "select", action: "select", actions: ["select", "revise"] })),
    );
    expect(withSurface).toEqual(withNull); // options/본문/reviseAvailable 전부 동일
    expect((withNull as { reviseAvailable: boolean }).reviseAvailable).toBe(true);
  });

  it("관측 동등 — escalated: null vs surface → 동일 Escalation(surface 는 소싱할 필드 없음)", async () => {
    const naEsc = na({ action: "raise-limit", status: "escalated" });
    const withNull = await presentationForNext(naEsc, undefined, undefined, NULL_SURFACE);
    const withSurface = await presentationForNext(
      naEsc,
      undefined,
      undefined,
      readSurfaceOf(surfaceOf({ surface: "escalated", action: "raise-limit", actions: ["raise-limit"], revise_available: false })),
    );
    expect(withSurface).toEqual(withNull);
    expect((withNull as { type: string }).type).toBe("Escalation");
  });

  // ── drift 보호: surface.actions 에서 revise 가 빠지면 chat 버튼이 따라 사라진다(surface 우선) ──
  it("drift — approve: surface.actions 에 revise 없음(na=revise_available:true) → reviseAvailable=false(surface 우선)", async () => {
    const naApprove = na({ action: "approve", revise_available: true });
    const p = await presentationForNext(
      naApprove,
      undefined,
      undefined,
      readSurfaceOf(surfaceOf({ actions: ["approve"], revise_available: true })),
    );
    expect((p as { reviseAvailable: boolean }).reviseAvailable).toBe(false); // na 였으면 true — surface 가 이긴다
  });

  it("drift — approve: raOkRequired 는 surface.ra_ok_required 로 소싱(na 와 달라도 surface 우선)", async () => {
    const naApprove = na({ action: "approve", ra_ok_required: false });
    const p = await presentationForNext(
      naApprove,
      undefined,
      undefined,
      readSurfaceOf(surfaceOf({ actions: ["approve", "revise"], ra_ok_required: true })),
    );
    expect((p as { raOkRequired: boolean }).raOkRequired).toBe(true); // surface 가 이긴다
  });

  it("drift — concept select: surface.actions 에 revise 없음 → reviseAvailable=false", async () => {
    const naSelect = na({ phase: "02-concept", action: "select", options: ["A-efficacy"], recommended: "A-efficacy", revise_available: true });
    const p = await presentationForNext(
      naSelect,
      readConcept,
      undefined,
      readSurfaceOf(surfaceOf({ phase: "02-concept", surface: "select", action: "select", actions: ["select"] })),
    );
    expect((p as { reviseAvailable: boolean }).reviseAvailable).toBe(false);
  });

  // ── 폴백: readSurface 가 null 반환(실패 시뮬)이면 na 기반 현행 동작 ──
  it("폴백 — readSurface=null(실패 시뮬) → na 기반(revise_available·ra_ok_required)", async () => {
    const naApprove = na({ action: "approve", revise_available: true, ra_ok_required: true });
    const p = await presentationForNext(naApprove, undefined, undefined, NULL_SURFACE);
    expect((p as { reviseAvailable: boolean }).reviseAvailable).toBe(true); // na.revise_available
    expect((p as { raOkRequired: boolean }).raOkRequired).toBe(true); // na.ra_ok_required
  });

  // ── 게이트 스냅샷 일치 가드(TOCTOU): na 읽은 뒤 surface 읽기 사이 core 가 전이하면 surface 가 다른 게이트를
  //    가리킬 수 있다 → 그 surface 의 플래그를 옛 게이트 카드에 섞지 않는다(phase/gate/status 불일치 시 na 폴백).
  it("게이트 불일치 — surface.phase 가 na 와 다르면 무시하고 na 폴백(옛 게이트 카드에 새 게이트 플래그 안 섞음)", async () => {
    const naApprove = na({ action: "approve", revise_available: true, ra_ok_required: false });
    // 전이 후 다른 phase 를 가리키는 surface(revise 없음·ra_ok true) — 가드가 나면 na(revise:true·ra_ok:false)로 폴백.
    const staleSurface = surfaceOf({ phase: "02-concept", actions: ["approve"], ra_ok_required: true });
    const p = await presentationForNext(naApprove, undefined, undefined, readSurfaceOf(staleSurface));
    expect((p as { reviseAvailable: boolean }).reviseAvailable).toBe(true); // surface(false) 무시 → na.revise_available
    expect((p as { raOkRequired: boolean }).raOkRequired).toBe(false); // surface(true) 무시 → na.ra_ok_required
  });

  it("게이트 불일치 — surface.status 가 na 와 다르면(전이) 무시하고 na 폴백", async () => {
    const naApprove = na({ action: "approve", revise_available: true, status: "pending" });
    const staleSurface = surfaceOf({ status: "revise", actions: ["approve"] }); // 같은 phase/gate 이나 status 전이
    const p = await presentationForNext(naApprove, undefined, undefined, readSurfaceOf(staleSurface));
    expect((p as { reviseAvailable: boolean }).reviseAvailable).toBe(true); // status 불일치 → na 폴백(surface 무시)
  });

  // ── 불필요 spawn 회피: 비-인터랙티브(generate/review/ingest/done)·escalation 은 surface 를 읽지 않는다 ──
  it("비-인터랙티브/escalation 은 readSurface 를 호출하지 않는다(불필요 spawn 회피)", async () => {
    let calls = 0;
    const spy = async (): Promise<A2uiSurface | null> => {
      calls += 1;
      return null;
    };
    await presentationForNext(na({ action: "generate", stage: "brief" }), undefined, undefined, spy);
    await presentationForNext(na({ action: "review" }), undefined, undefined, spy);
    await presentationForNext(na({ action: "ingest" }), undefined, undefined, spy);
    await presentationForNext(na({ phase: "done", action: "done", status: "approved", files: [] }), undefined, undefined, spy);
    await presentationForNext(na({ action: "raise-limit", status: "escalated" }), undefined, undefined, spy);
    expect(calls).toBe(0); // 소싱할 boolean 이 없는 표현들 — surface 를 읽지 않는다

    // 대조군: approve/select 는 정확히 1회씩 읽는다.
    await presentationForNext(na({ action: "approve" }), undefined, undefined, spy);
    expect(calls).toBe(1);
    await presentationForNext(na({ phase: "02-concept", action: "select", options: ["A"], recommended: "A" }), readConcept, undefined, spy);
    expect(calls).toBe(2);
  });
});

describe("onChoice — 다안 선택([이걸로])", () => {
  it("승인자 + 선택 차례 → select 잡(payload.option) 적재", async () => {
    const { gw, jobs } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ action: "select", options: ["A-efficacy", "B-safety"], recommended: "A-efficacy" }),
    });
    const r = await onChoice({ type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U1", threadId: "th-1" }, gw);
    expect(jobs[0]).toMatchObject({ kind: "select", run_id: "r-sel", actor: "chat:slack:U1", payload: { option: "A-efficacy" } });
    expect(r?.enqueued).toBeDefined();
  });

  it("비승인자 → 잡 미적재(선택은 상태변이 · revise 와 동일 게이트)", async () => {
    const { gw, jobs } = fakeGateway({
      isApprover: () => false,
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ action: "select", options: ["A-efficacy"], recommended: "A-efficacy" }),
    });
    await onChoice({ type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U9", threadId: "th-1" }, gw);
    expect(jobs).toHaveLength(0);
  });

  it("지금 선택 차례가 아니면(stale) 잡 미적재 + 평이 안내(no-op)", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ action: "approve" }), // 선택 차례 아님
    });
    await onChoice({ type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U1", threadId: "th-1" }, gw);
    expect(jobs).toHaveLength(0);
    expect(renders.length).toBeGreaterThan(0);
  });

  it("스레드에 바인딩된 run 이 없으면 무시(잡·렌더 없음)", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: { runForThread: async () => null, threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
    });
    await onChoice({ type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U1", threadId: "th-1" }, gw);
    expect(jobs).toHaveLength(0);
    expect(renders).toHaveLength(0);
  });

  it("onAction([이걸로] 버튼) → onChoice 경유 select 잡(value {run_id, action:select, option})", async () => {
    const { gw, jobs } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ action: "select", options: ["A-efficacy", "B-safety"], recommended: "B-safety" }),
    });
    await onAction(button("select-A-efficacy", { value: JSON.stringify({ run_id: "r-sel", action: "select", option: "A-efficacy" }) }), gw);
    expect(jobs[0]).toMatchObject({ kind: "select", run_id: "r-sel", payload: { option: "A-efficacy" } });
  });

  // ── stale 다안 가드: 도장(phase·iteration) 불일치 = 옛 카드 클릭 → 선택 안 함 ──
  it("stale 가드: 도장(phase·iteration) 일치면 select 잡 적재", async () => {
    const { gw, jobs } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ phase: "02-concept", iteration: 2, action: "select", options: ["A-efficacy"], recommended: "A-efficacy" }),
    });
    const r = await onChoice(
      { type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U1", threadId: "th-1", expectedPhase: "02-concept", expectedIteration: 2 },
      gw,
    );
    expect(jobs[0]).toMatchObject({ kind: "select", payload: { option: "A-efficacy" } });
    expect(r?.enqueued).toBeDefined();
  });

  it("stale 가드: phase 불일치(다음 단계 옛 카드) → 잡 미적재 + '새로운 안' 안내", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      // 현재는 스토리라인 선택인데, 클릭은 옛 컨셉(02-concept) 카드에서 옴.
      readNext: async () => na({ phase: "03-storyboard", iteration: 1, action: "select", options: ["A"], recommended: "A" }),
    });
    await onChoice(
      { type: "choice", optionKey: "A", actor: "chat:slack:U1", threadId: "th-1", expectedPhase: "02-concept", expectedIteration: 1 },
      gw,
    );
    expect(jobs).toHaveLength(0); // 옛 카드로 새 단계를 선택하지 않는다(감사 정합)
    expect(renders.length).toBeGreaterThan(0);
  });

  it("stale 가드: iteration 불일치(재생성 전 옛 카드) → 잡 미적재 + '새로운 안' 안내", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: { runForThread: async () => "r-sel", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      // [다시 제안]으로 재생성돼 iteration 이 2로 올랐는데, 클릭은 iteration 1 옛 카드에서 옴.
      readNext: async () => na({ phase: "02-concept", iteration: 2, action: "select", options: ["A-efficacy"], recommended: "A-efficacy" }),
    });
    await onChoice(
      { type: "choice", optionKey: "A-efficacy", actor: "chat:slack:U1", threadId: "th-1", expectedPhase: "02-concept", expectedIteration: 1 },
      gw,
    );
    expect(jobs).toHaveLength(0); // 재생성 전 안을 보고 고른 것 → 최신 안에서 다시 고르게
    expect(renders.length).toBeGreaterThan(0);
  });
});

// ── 구조 분리 회귀 가드: fake ChatPort 로 커널을 설정→인입까지 완주(플랫폼 0) ──
describe("fake ChatPort 전 구간(구조 분리 회귀 가드)", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "chat-flow-seq-"));
    process.env.CHAT_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    delete process.env.CHAT_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("멘션→도메인/포맷 선택→제품명 답글→[시작]→WB 붙여넣기: 표현 시퀀스 + ingest 잡", async () => {
    const { gw, jobs, renders, bound, subscribed } = fakeGateway();
    await onMention(mention("th-seq"), gw);
    await onAction(button(SETUP_ACTION_IDS.domain, { value: "화장품", threadId: "th-seq" }), gw);
    await onAction(button(SETUP_ACTION_IDS.format, { value: "여러장", threadId: "th-seq" }), gw);
    await onReply(reply("th-seq", "이지듀 쿠션"), gw); // 제품명(pending=setup)
    await onAction(button(SETUP_ACTION_IDS.start, { threadId: "th-seq" }), gw);
    await onReply(reply("th-seq", "# 워킹백워드\n핵심 본문"), gw); // pending=wb

    // 표현 시퀀스: Setup(멘션) · Setup(제품명 반영) · IngestPrompt([시작])
    expect(renders.map((r) => r.p.type)).toEqual(["Setup", "Setup", "IngestPrompt"]);
    expect(subscribed).toEqual(["th-seq"]);
    expect(bound).toHaveLength(1);
    expect(jobs.filter((j) => j.kind === "ingest")).toHaveLength(1);
    // 모든 렌더는 같은 스레드로(라우팅 정합).
    expect(new Set(renders.map((r) => r.threadId))).toEqual(new Set(["th-seq"]));
  });
});

// ── P3: 자연어 이해(이해는 자연어, 방아쇠는 버튼) ─────────────────────────────
type NlProposal = Extract<Presentation, { type: "NlProposal" }>;

describe("onMention — P3-1 설정 NL", () => {
  it("완결 NL → NlProposal(setup, [시작] 확정) · pending 채움 · 자동 시작 없음", async () => {
    const { gw, renders, store, jobs, bound } = fakeGateway();
    await onMention(
      { type: "mention", threadId: "th-nl", actor: "chat:slack:U1", text: '화장품이고 여러장이야, 제품명은 "릴리프쿠션"' },
      gw,
    );
    expect(renders.map((r) => r.p.type)).toEqual(["NlProposal"]); // 완결이면 설정 카드 없이 확인 카드만
    const p = renders[0]!.p as NlProposal;
    expect(p.kind).toBe("setup");
    expect(p.confirm?.actionId).toBe(SETUP_ACTION_IDS.start); // 방아쇠 = 기존 [시작] 경로
    expect(p.questions).toEqual([]);
    expect(store.get("th-nl")).toEqual({ kind: "setup", domain: "화장품", format: "여러장", product: "릴리프쿠션" });
    expect(jobs).toHaveLength(0); // 자동 시작 없음(잠긴 결정 6)
    expect(bound).toHaveLength(0);
  });

  it("부분 NL(미확신) → NlProposal(질문, 확정 없음) + Setup 카드 · 자동 시작 없음", async () => {
    const { gw, renders, store, jobs, bound } = fakeGateway();
    await onMention({ type: "mention", threadId: "th-nl2", actor: "chat:slack:U1", text: "화장품이야" }, gw);
    expect(renders.map((r) => r.p.type)).toEqual(["NlProposal", "Setup"]);
    const p = renders[0]!.p as NlProposal;
    expect(p.questions.length).toBeGreaterThan(0);
    expect(p.confirm).toBeUndefined();
    expect(store.get("th-nl2")).toMatchObject({ kind: "setup", domain: "화장품" });
    expect(jobs).toHaveLength(0);
    expect(bound).toHaveLength(0);
  });

  it("텍스트 없는 멘션은 기존대로 빈 Setup 카드", async () => {
    const { gw, renders, store } = fakeGateway();
    await onMention({ type: "mention", threadId: "th-plain", actor: "chat:slack:U1" }, gw);
    expect(renders.map((r) => r.p.type)).toEqual(["Setup"]);
    expect(store.get("th-plain")).toEqual({ kind: "setup" });
  });
});

describe("onMention — P3-2 파일 인입 NL", () => {
  it("허용 루트 밖 경로 → 거부(인입 잡·대기·NlProposal 없음 · 안내만)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "flow-nl-out-"));
    const root = mkdtempSync(join(tmpdir(), "flow-nl-root-"));
    const bad = join(outside, "x.pdf");
    writeFileSync(bad, "x");
    try {
      const { gw, jobs, store, renders } = fakeGateway({ nlFileRoots: () => [root] });
      await onMention(
        { type: "mention", threadId: "th-in", actor: "chat:slack:U1", text: `워킹백워드는 여기: ${bad}, 화장품이고 여러장, 제품명은 "P"` },
        gw,
      );
      expect(jobs).toHaveLength(0);
      expect(store.has("th-in")).toBe(false); // intake 대기 안 생김
      expect(renders.some((r) => r.p.type === "NlProposal")).toBe(false);
      expect(renders.length).toBeGreaterThan(0); // 거부 안내는 나감
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("허용 루트 안 + 완결 선언 → NlProposal(intake, 확정) + pending=intake", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-root2-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      const { gw, jobs, store, renders } = fakeGateway({ nlFileRoots: () => [root] });
      await onMention(
        { type: "mention", threadId: "th-in2", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장, 제품명은 "P"` },
        gw,
      );
      const p = renders.find((r) => r.p.type === "NlProposal")!.p as NlProposal;
      expect(p.kind).toBe("intake");
      expect(p.confirm?.actionId).toBe(NL_INTAKE_CONFIRM_ACTION_ID);
      expect(store.get("th-in2")).toMatchObject({ kind: "intake", domain: "화장품", format: "여러장", product: "P" });
      expect(jobs).toHaveLength(0); // NL 은 실행 안 함 — 버튼이 방아쇠
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("부분 거부 fail-closed: 일부 파일이 허용 폴더 밖이면 확정 버튼 없이 거부 안내(부분 반입 금지)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-r-"));
    const outside = mkdtempSync(join(tmpdir(), "flow-nl-out-"));
    const wb = join(root, "wb.md");
    const report = join(outside, "report.pdf"); // 허용 폴더 밖.
    writeFileSync(wb, "hi");
    writeFileSync(report, "pdf");
    try {
      const { gw, jobs, store, renders } = fakeGateway({ nlFileRoots: () => [root] });
      await onMention(
        { type: "mention", threadId: "th-mix", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 시험성적서는 ${report}, 화장품이고 여러장, 제품명은 "P"` },
        gw,
      );
      const p = renders.find((r) => r.p.type === "NlProposal")?.p as NlProposal | undefined;
      // 하나라도 거부되면 확정 제안을 내지 않는다(pending 없음 · 잡 없음 · 거부 안내만).
      expect(p?.confirm).toBeUndefined();
      expect(store.has("th-mix")).toBe(false);
      expect(jobs).toHaveLength(0);
      const rejectMsg = renders.some(
        (r) => r.p.type === "Progress" && (r.p as { message?: string }).message?.includes("확인하지 못했") === true,
      );
      const proposalReject = p !== undefined && !p.confirm; // NlProposal 로 왔어도 confirm 없음이면 fail-closed 충족
      expect(rejectMsg || proposalReject).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("거부된 재선언은 이전 인입 대기를 무효화 → 옛 카드 클릭도 확정 안 함", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-r-"));
    const outside = mkdtempSync(join(tmpdir(), "flow-nl-out-"));
    const wb = join(root, "wb.md");
    const bad = join(outside, "x.pdf");
    writeFileSync(wb, "hi");
    writeFileSync(bad, "p");
    try {
      const { gw, jobs, store } = fakeGateway({ nlFileRoots: () => [root] });
      // 제안 A(유효·완비) → 인입 대기 설정.
      await onMention({ type: "mention", threadId: "th-seq", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장, 제품명은 "P"` }, gw);
      expect(store.get("th-seq")).toMatchObject({ kind: "intake" });
      // 재선언 B(허용 폴더 밖 파일 포함 → 거부) → 이전 인입 대기 무효화(fail-closed).
      await onMention({ type: "mention", threadId: "th-seq", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 시험성적서는 ${bad}, 화장품이고 여러장, 제품명은 "P"` }, gw);
      expect(store.get("th-seq")?.kind === "intake").toBe(false); // 인입 대기 사라짐
      // 옛 카드 A 클릭(어떤 nonce든) → pending 부재 → no-op.
      await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { threadId: "th-seq", value: JSON.stringify({ nonce: "whatever" }) }), gw);
      expect(jobs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("intake_draft — 제품명만 미정 → 답글로 완성(P3-2 보완)", () => {
  it("제품명 미정(파일·도메인·포맷만) → NlProposal(질문·확정없음) + pending=intake_draft 보존", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draft-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      const { gw, store, renders } = fakeGateway({ nlFileRoots: () => [root] });
      // 제품명 선언 없음(따옴표·"제품명은" 없음) → stub 이 product 미추출 → 제품명만 미정.
      await onMention({ type: "mention", threadId: "th-d", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
      const p = renders.find((r) => r.p.type === "NlProposal")!.p as NlProposal;
      expect(p.kind).toBe("intake");
      expect(p.confirm).toBeUndefined(); // 미완성 → 확정 버튼 없음
      expect((p.questions ?? []).length).toBeGreaterThan(0); // 제품명 되물음
      const draft = store.get("th-d") as { kind: string; domain: string; format: string; files: unknown[] };
      expect(draft).toMatchObject({ kind: "intake_draft", domain: "화장품", format: "여러장" });
      expect(draft.files.length).toBe(1); // 파싱된 파일 보존
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("그 뒤 제품명 답글 → 완성 제안(intake · [이 자료로 시작]) + pending=intake(제품명 반영) · 자동 실행 없음", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draft2-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      const { gw, store, renders, jobs } = fakeGateway({ nlFileRoots: () => [root] });
      await onMention({ type: "mention", threadId: "th-d2", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
      await onReply(reply("th-d2", "이지덤"), gw);
      const proposals = renders.filter((r) => r.p.type === "NlProposal").map((r) => r.p as NlProposal);
      const last = proposals[proposals.length - 1]!;
      expect(last.kind).toBe("intake");
      expect(last.confirm?.actionId).toBe(NL_INTAKE_CONFIRM_ACTION_ID); // 완성 → 확정 버튼 등장
      expect(store.get("th-d2")).toMatchObject({ kind: "intake", domain: "화장품", format: "여러장", product: "이지덤" });
      expect(jobs).toHaveLength(0); // NL 은 실행 안 함 — 버튼이 방아쇠(잠긴 결정 6)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("재멘션 형태 답글(선두 @멘션 토큰)도 제품명만 채택(멘션 제거)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draft3-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      const { gw, store } = fakeGateway({ nlFileRoots: () => [root] });
      await onMention({ type: "mention", threadId: "th-d3", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
      await onReply(reply("th-d3", "@U0BH97M7D6V 이지덤"), gw);
      expect(store.get("th-d3")).toMatchObject({ kind: "intake", product: "이지덤" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("거부된 재선언은 옛 intake_draft 도 무효화 → 뒤이은 제품명 답글이 옛 자료를 완성 못 함(fail-closed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draftR-"));
    const outside = mkdtempSync(join(tmpdir(), "flow-nl-draftO-"));
    const wb = join(root, "wb.md");
    const bad = join(outside, "x.pdf"); // 허용 폴더 밖.
    writeFileSync(wb, "hi");
    writeFileSync(bad, "p");
    try {
      const { gw, store, jobs } = fakeGateway({ nlFileRoots: () => [root] });
      // A: 유효하지만 제품명만 미정 → intake_draft.
      await onMention({ type: "mention", threadId: "th-dR", actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
      expect(store.get("th-dR")).toMatchObject({ kind: "intake_draft" });
      // B: 재선언(허용 폴더 밖 파일 포함 → 거부)이 **구독 스레드라 onReply 로 온다**(production 경로).
      //   답글이 무조건 제품명이 되면 안 되고, 재파싱해 새 선언(B)으로 다뤄 거부 → 옛 A 자료 확정 불가여야 한다.
      await onReply(reply("th-dR", `워킹백워드는 ${wb}, 시험성적서는 ${bad}, 화장품이고 여러장`), gw);
      expect(store.get("th-dR")?.kind === "intake").toBe(false); // A 도 B 도 확정 대기 없음(B 거부 · A draft 폐기)
      // 뒤이은 제품명 답글 → 완성할 대기 없음 → 옛 A 자료 확정 불가(no-op).
      await onReply(reply("th-dR", "이지덤"), gw);
      expect(store.get("th-dR")?.kind === "intake").toBe(false);
      expect(jobs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("★ 설정만 고치는 답글(제품명 없음) → 미확신 재산정 → 제품명 되물음 + draft 보존(대화가 막히지 않는다)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draftU-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      // 답글이 포맷만 고치면 제품명은 여전히 미정 — uncertain 을 [] 로 굳히면 질문도 확정 버튼도 없는 카드가 된다.
      for (const refine of ["한장", "한장으로 바꿔줘"]) {
        const { gw, store, renders, jobs } = fakeGateway({ nlFileRoots: () => [root] });
        const th = `th-refine-${refine.length}`;
        await onMention({ type: "mention", threadId: th, actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
        await onReply(reply(th, refine), gw);
        const proposals = renders.filter((r) => r.p.type === "NlProposal").map((r) => r.p as NlProposal);
        const last = proposals[proposals.length - 1]!;
        expect(last.questions.some((q) => q.includes("제품 이름"))).toBe(true); // 되물음 있음
        expect(last.confirm).toBeUndefined(); // 미완성 → 확정 버튼 없음
        // 고친 설정이 반영된 draft 가 살아 있어야 다음 답글(제품명)이 완성한다.
        expect(store.get(th)).toMatchObject({ kind: "intake_draft", domain: "화장품", format: "한장" });
        expect(jobs).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("파일/자료 변경 의도 답글은 fail-closed(옛 draft 파일로 완성 금지) — 경로·확장자밖·확장자없음·제거의도", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-draftF-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const badReplies = [
      "워킹백워드는 /Users/x/공백 있는 이름.pdf 로 바꿔줘", // 공백 포함 경로(파서 미인식) + '바꿔'
      "/allowed/new.rtf 로 교체", // 확장자 목록 밖 경로 + '교체'
      "/allowed/newfile 로 해줘", // 확장자 없는 경로 토큰
      "파일 없이 진행해줘", // 경로 없는 제거 의도('파일'·'없이')
      "기존 파일은 빼줘", // 경로 없는 제거 의도('파일'·'빼')
      "제품명은 이지덤. delete the old report", // 명시 제품명 + 영어 제거 지시(단어경계 delete/report) → 안전 우선 fail-closed
      "그거 빼줘", // 파일 맥락 없는 변경 지시인데 설정·제품명으로도 이해 못 함 → 무엇을 빼라는지 불명(fail-closed)
      "두 번째 거 교체", // 위와 같음(대명사 지시)
    ];
    try {
      for (const [i, bad] of badReplies.entries()) {
        const { gw, store, jobs } = fakeGateway({ nlFileRoots: () => [root] });
        const th = `th-badf-${i}`;
        await onMention({ type: "mention", threadId: th, actor: "chat:slack:U1", text: `워킹백워드는 ${wb}, 화장품이고 여러장` }, gw);
        expect(store.get(th)).toMatchObject({ kind: "intake_draft" });
        await onReply(reply(th, bad), gw);
        // 옛 A 파일로 조용히 완성 금지: intake 확정 대기 안 생김 · draft 도 안 되살아남 · 잡 없음.
        expect(store.get(th)?.kind === "intake").toBe(false);
        expect(store.get(th)?.kind === "intake_draft").toBe(false);
        expect(jobs).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("onAction — P3-2 인입 확정(스테이징 + intake 잡)", () => {
  let dataDir: string;
  let root: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "flow-nl-data-"));
    process.env.CHAT_DATA_DIR = dataDir;
    root = mkdtempSync(join(tmpdir(), "flow-nl-r-"));
  });
  afterEach(() => {
    delete process.env.CHAT_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("승인자 확정 → intake 잡(folder·product·domain·format) + 바인딩 + 대기 해제", async () => {
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const { gw, jobs, bound, store } = fakeGateway({ nlFileRoots: () => [root] });
    store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P", nonce: "n1" });
    // 버튼 도장(nonce)이 대기와 일치 → 확정 진행.
    const r = await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { value: JSON.stringify({ nonce: "n1" }) }), gw);
    expect(jobs[0]).toMatchObject({ kind: "intake", payload: { product: "P", domain: "화장품", format: "여러장" } });
    expect(String(jobs[0]!.payload.folder)).toContain(dataDir); // 불변 스냅샷 폴더로 스테이징
    expect(bound).toHaveLength(1);
    expect(r?.enqueued).toBeDefined();
    expect(store.has("th-1")).toBe(false);
  });

  it("stale 제안 가드: 버튼 도장(nonce)이 대기와 다르면 확정 안 함(옛 카드 클릭) + 안내", async () => {
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const { gw, jobs, bound, store, renders } = fakeGateway({ nlFileRoots: () => [root] });
    // 대기 제안은 nonce=n2(새 제안), 클릭은 옛 카드 n1.
    store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P", nonce: "n2" });
    await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { value: JSON.stringify({ nonce: "n1" }) }), gw);
    expect(jobs).toHaveLength(0); // 옛 카드로 새 제안을 확정하지 않는다
    expect(bound).toHaveLength(0);
    expect(store.get("th-1")).toMatchObject({ kind: "intake", nonce: "n2" }); // 대기 보존
    expect(renders.length).toBeGreaterThan(0);
  });

  it("stale 가드: 도장 없는(옛 포맷/변조) 버튼은 확정 안 함(정확 일치 요구)", async () => {
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const { gw, jobs, store } = fakeGateway({ nlFileRoots: () => [root] });
    store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P", nonce: "n1" });
    await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID), gw); // 버튼에 value 없음 → nonce undefined → 거부
    expect(jobs).toHaveLength(0);
    expect(store.get("th-1")).toMatchObject({ kind: "intake", nonce: "n1" }); // 대기 보존
  });

  it("stale 가드: 옛 포맷 대기(nonce 필드 없음) + 도장 없는 버튼도 확정 안 함(둘 다 비지 않아야)", async () => {
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const { gw, jobs, store } = fakeGateway({ nlFileRoots: () => [root] });
    // 옛 포맷 pending(nonce 필드 자체 없음) 모사 — undefined===undefined 통과 구멍 방지.
    store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P" } as unknown as PendingInput);
    await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID), gw);
    expect(jobs).toHaveLength(0);
  });

  it("비승인자 확정 → 잡 미적재(상태변이 게이트)", async () => {
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    const { gw, jobs } = fakeGateway({ isApprover: () => false, nlFileRoots: () => [root] });
    // store 는 fakeGateway 내부 Map — 직접 세팅
    // (pending intake 가 있어도 비승인자면 잡을 만들지 않는다)
    await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { actor: "chat:slack:U9" }), gw);
    expect(jobs).toHaveLength(0);
  });
});

describe("onReply — P3 자연어 실행 요청(대기 없음)", () => {
  it("'승인해줘'(게이트 진행중) → 게이트 버튼 카드 재게시 · 잡 없음", async () => {
    const { gw, jobs, renders } = fakeGateway({
      map: { runForThread: async () => "r-gate", threadForRun: async () => "th-1", bindThreadToRun: async () => {} } as unknown as Gateway["map"],
      readNext: async () => na({ action: "approve" }),
    });
    await onReply(reply("th-1", "승인해줘"), gw);
    expect(jobs).toHaveLength(0); // NL 은 실행하지 않음
    expect(renders.map((r) => r.p.type)).toContain("ApproveGate");
  });

  it("run 없는 스레드의 실행 요청 답글은 무시(잡·렌더 없음)", async () => {
    const { gw, jobs, renders } = fakeGateway(); // 기본 map.runForThread → null
    await onReply(reply("th-x", "승인해줘"), gw);
    expect(jobs).toHaveLength(0);
    expect(renders).toHaveLength(0);
  });

  it("intake 대기 중 재선언(거부 파일 포함)이 onReply(구독 경로)로 와도 이전 대기 무효화 → 옛 카드 no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-r-"));
    const outside = mkdtempSync(join(tmpdir(), "flow-nl-out-"));
    const wb = join(root, "wb.md");
    const bad = join(outside, "x.pdf");
    writeFileSync(wb, "hi");
    writeFileSync(bad, "p");
    try {
      const { gw, jobs, store } = fakeGateway({ nlFileRoots: () => [root] });
      // 제안 A 대기(구독됨) — 실 Slack 에선 이후 재멘션/재선언이 onReply 로 라우팅된다.
      store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P", nonce: "nA" });
      // 재선언 B(허용 폴더 밖 파일 포함 → 거부)가 onReply 로 도착 → handleNlIntake 가 이전 대기 무효화.
      await onReply(reply("th-1", `워킹백워드는 ${wb}, 시험성적서는 ${bad}, 화장품이고 여러장, 제품명은 "P"`), gw);
      expect(store.get("th-1")?.kind === "intake").toBe(false); // 이전 인입 대기 사라짐
      // 옛 카드 A(nonce nA) 클릭 → pending 부재 → no-op(부분·stale 확정 차단).
      await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { value: JSON.stringify({ nonce: "nA" }) }), gw);
      expect(jobs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("intake 대기 중 비-선언(잡담) 메시지도 파싱 전에 대기를 비운다(레이스 차단·fail-closed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-nl-r-"));
    const wb = join(root, "wb.md");
    writeFileSync(wb, "hi");
    try {
      const { gw, jobs, store } = fakeGateway({ nlFileRoots: () => [root] });
      store.set("th-1", { kind: "intake", files: [{ role: "working_backwards", path: wb }], domain: "화장품", format: "여러장", product: "P", nonce: "nA" });
      await onReply(reply("th-1", "고마워요"), gw); // 비-선언(잡담)
      expect(store.get("th-1")?.kind === "intake").toBe(false); // 파싱(비동기) 전에 무효화됨
      // 옛 카드 확정 시도 → pending 부재 → no-op(파싱 대기 중 동시 확정도 같은 이유로 차단됨).
      await onAction(button(NL_INTAKE_CONFIRM_ACTION_ID, { value: JSON.stringify({ nonce: "nA" }) }), gw);
      expect(jobs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * renderProgress(진행 표시 배선 · dev-loop Stage 3) — gen-executor(브리지) onProgress 의 몸통.
 *   rid→threadId(ThreadRunMap)→render(ProgressPresentation) 로 이어지되, **best-effort**: 어떤 실패도 조용히
 *   흡수해 생성 완주를 방해하지 않는다(표시 전용 · 전이/마감 판정과 무관).
 */
describe("renderProgress(진행 표시 side-channel 배선)", () => {
  it("rid→threadId 해석되면 ProgressPresentation 을 render(message 실림 · 기존 변이 재사용)", async () => {
    const { gw, renders } = fakeGateway(); // threadForRun 기본 = "thread-1"
    await renderProgress(gw, "r-live", "계속 진행하고 있어요 — 조금만 기다려 주세요.");
    expect(renders).toHaveLength(1);
    expect(renders[0]!.threadId).toBe("thread-1");
    expect(renders[0]!.p.type).toBe("Progress"); // 새 변이 없이 기존 ProgressPresentation 재사용
    expect((renders[0]!.p as { message: string }).message).toBe("계속 진행하고 있어요 — 조금만 기다려 주세요.");
  });

  it("threadId 미해석(null)이면 render 스킵(best-effort · 표시할 곳 없음)", async () => {
    const { gw, renders } = fakeGateway({
      map: { runForThread: async () => null, threadForRun: async () => null, bindThreadToRun: async () => {} } as unknown as Gateway["map"],
    });
    await renderProgress(gw, "r-x", "진행 중");
    expect(renders).toHaveLength(0);
  });

  it("threadForRun 이 throw 해도 흡수(진행 표시가 생성 완주를 깨지 않는다)", async () => {
    const { gw, renders } = fakeGateway({
      map: {
        runForThread: async () => null,
        threadForRun: async () => {
          throw new Error("map boom");
        },
        bindThreadToRun: async () => {},
      } as unknown as Gateway["map"],
    });
    await expect(renderProgress(gw, "r-x", "진행 중")).resolves.toBeUndefined();
    expect(renders).toHaveLength(0);
  });

  it("render 가 throw 해도 흡수(예외가 밖으로 새지 않는다)", async () => {
    const { gw } = fakeGateway({
      chat: {
        render: async () => {
          throw new Error("render boom");
        },
        subscribe: async () => {},
        capabilities: () => ({ imageDelivery: "upload" }),
      },
    });
    await expect(renderProgress(gw, "r-live", "진행 중")).resolves.toBeUndefined();
  });
});

describe("onOutcome — 잡-레벨 리뷰 재적재(chat-review-retry-plan 2-3/2-6)", () => {
  /** fire-and-forget 재적재 IIFE 를 정착시키는 매크로태스크 1회(주입 delay 는 즉시-resolve — 실 타이머 0). */
  const settle = () => new Promise<void>((r) => setImmediate(r));
  /** 리뷰 잡(회차 원장은 payload.attempt — 별도 상태 없음). attempt 미지정=최초(0 취급). */
  const reviewJob = (attempt?: number): Job => ({
    kind: "review",
    run_id: "r",
    actor: "chat:auto",
    payload: attempt === undefined ? {} : { attempt },
  });
  /** 즉시-resolve 가짜 시계 + 재시도 예산(기본 max 2). 재적재 직전 재확인 readNext 는 기본 review 게이트(불변). */
  const retryGw = (over: Partial<Gateway> = {}) =>
    fakeGateway({
      delay: async () => {},
      reviewRetry: { max: 2, backoffMs: [1000, 2000] },
      readNext: async () => na({ action: "review" }),
      ...over,
    });

  it("1) 리뷰 실패 + next=review + attempt<max → Progress(재점검 안내) + attempt+1 리뷰 잡 재적재", async () => {
    const { gw, jobs, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "심의를 끝내지 못했어요", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]);
    const reviewJobs = jobs.filter((j) => j.kind === "review");
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]!.payload.attempt).toBe(1);
    expect(reviewJobs[0]!.actor).toBe("chat:auto"); // 자동 재적재(사람 아님)
  });

  it("2) 재적재 직전 재확인이 review 아님(대기 중 전진) → 재적재 포기(리뷰 잡 0 · 카드는 이미 Progress)", async () => {
    const { gw, jobs, renders } = retryGw({ readNext: async () => na({ action: "approve" }) });
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // abandon(로그만)
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]); // 대상 판별은 outcome.next 기준이라 카드는 이미 떴다
  });

  it("3) attempt=max 소진 → Failure(소진 문구) + 재적재 0(fail-closed)", async () => {
    const { gw, jobs, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(2)); // attempt === max
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0);
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
    expect((renders[0]!.p as { message: string }).message).toMatch(/여러 번 다시 점검했지만/); // 1회 실패와 구분
  });

  it("4) ★ deny 회귀 잠금: 위반 판정(ok:true · verdict=revise)은 재시도 경로 미진입 — Verdict · 재적재 0", async () => {
    const { gw, jobs, renders } = retryGw();
    // 위반 판정(deny)은 kcia-check 정상 종료(exit 0) → `ok:true` 리뷰 아웃컴으로 도착(status=revise → deriveVerdict "revise").
    //   `!outcome.ok` 재시도 분기에 애초에 들어오지 않는다 → 진짜 deny 를 flaky 로 가릴 구조적 여지가 없다.
    const out = { kind: "review", run_id: "r", ok: true, message: "", next: na({ action: "approve", status: "revise" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // flaky 로 가리지 않는다
    expect(renders.map((r) => r.p.type)).toEqual(["Verdict"]);
    expect(deriveVerdict(out.next!)).toBe("revise"); // 도착한 아웃컴이 실제로 deny 판정임을 못박는다
  });

  it("5) 리뷰 실패 + next=null(읽기 실패) → 즉시 Failure · 재시도 없음 · 잡 0(오늘과 동일)", async () => {
    const { gw, jobs, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "상태를 읽지 못했어요", next: null } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(jobs).toHaveLength(0);
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
    expect((renders[0]!.p as { message: string }).message).toBe("상태를 읽지 못했어요"); // attempt=0 → 소진 문구 아님(불변)
  });

  it("6) 리뷰 아닌 실패(generate)는 기존 Failure 그대로 · 재시도 분기 미진입 · 리뷰 잡 0", async () => {
    const { gw, jobs, renders } = retryGw();
    const genJob: Job = { kind: "generate", run_id: "r", actor: "chat:auto", payload: { stage: "brief" } };
    const out = { kind: "generate", run_id: "r", ok: false, message: "만들지 못했어요", next: na({ action: "generate", stage: "brief" }) } as WorkerOutcome;
    await onOutcome(out, gw, genJob);
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // 생성 실패는 재시도 특례 밖
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
    expect((renders[0]!.p as { message: string }).message).toBe("만들지 못했어요"); // 기존 사유 그대로
  });

  it("추가 잠금: 재시도 Progress 문구에 규정 판정(통과/합격/실패 판정) 주장이 없다(P1 위험 잠금)", async () => {
    const { gw, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    const msg = (renders[0]!.p as { message: string }).message;
    expect(msg).not.toMatch(/통과|합격|실패 판정/); // 비권위 채널의 근거 없는 규정 통과/불통과 주장 금지
    expect(msg).toContain("다시 점검"); // "다시 점검합니다" 만 말한다
  });

  it("max=0(재시도 끔)이면 리뷰 실패도 즉시 Failure(기존 시나리오 0-재시도 재현)", async () => {
    const { gw, jobs, renders } = retryGw({ reviewRetry: { max: 0, backoffMs: [] } });
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(jobs).toHaveLength(0);
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
    expect((renders[0]!.p as { message: string }).message).toBe("심의 미완"); // max=0 → 소진 문구 아님(비대상)
  });

  it("7) ★ 재적재 직전 재확인 readNext 실패(reject) → 조용한 포기 금지 · 보이는 Failure(fail-closed) · 리뷰 잡 0", async () => {
    // Codex P2: readNext().catch(()=>null) 은 '읽기 실패'와 '게이트 전진'을 뭉갠다. 읽기가 reject 하면 na=null →
    //   옛 else 분기가 "abandon(gate advanced)" 로그만 찍고 아무것도 안 했다 — 재적재도 없고 카드도 없어, 마지막 카드가
    //   "잠시 뒤 자동으로 다시 점검합니다"(거짓 약속)로 남고 런이 review 에 조용히 고착된다(계획 2-4 · STALL-LOG).
    //   이제 읽기 실패는 보이는 fail-closed(Failure)로 끊는다. eligibility 는 outcome.next 기준이라 재확인 readNext 만 throw.
    const { gw, jobs, renders } = retryGw({
      readNext: async () => {
        throw new Error("셸 실패");
      },
    });
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    // (a) 재적재 없음 — 조용히 포기하지 않는다.
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0);
    // (b) 보이는 Failure(fail-closed) — 최초 Progress(재점검 약속) 뒤에 Failure 로 자리를 덮는다.
    expect(renders.map((r) => r.p.type)).toEqual(["Progress", "Failure"]);
    const failure = renders[renders.length - 1]!.p;
    expect(failure).toMatchObject({ type: "Failure", rid: "r" });
    expect((failure as { message: string }).message).toMatch(/다시 시작하지 못했어요/);
  });

  it("8) ★ TOCTOU 결박: 서명 동봉 잡이 다음 페이즈 review 게이트의 next 로 돌아오면 재적재/소진 Failure 아님 · 현재 게이트 카드", async () => {
    // 워커 stale 가드(서명 불일치 스킵)를 통과한 ok:false 가 next=**다음 페이즈의 review**(action 은 여전히 review)로
    //   도착하는 좁은 경합: action 만 보면 (attempt<max) 재적재가 새 게이트로 승계되거나 (attempt>=max) 거짓 소진
    //   Failure 가 뜬다. 잡의 원 게이트 서명(phase)과 next 불일치 = 지난 게이트의 메아리 → 진실은 현재 게이트 카드.
    const { gw, jobs, renders } = retryGw();
    const staleJob: Job = {
      kind: "review",
      run_id: "r",
      actor: "chat:auto",
      payload: { attempt: 1, phase: "01-brief", stage: null, iteration: null }, // 원 게이트 = 01-brief
    };
    const out = {
      kind: "review",
      run_id: "r",
      ok: false,
      message: "이미 점검이 끝났어요 — 지금은 점검 차례가 아니에요.",
      next: na({ action: "review", phase: "02-concept" }), // 그 사이 다음 페이즈 review 로 전진
    } as WorkerOutcome;
    await onOutcome(out, gw, staleJob);
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // 새 게이트로 재적재 승계 금지(중복 리뷰 차단)
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]); // Failure 아님 — 현재 게이트(review 진행) 재파생 카드
    expect((renders[0]!.p as { message?: string }).message ?? "").not.toMatch(/여러 번 다시 점검했지만/); // 거짓 소진 문구 금지
  });

  it("8b) 서명 일치 잡은 기존 재시도 동작 그대로(attempt<max → 재적재 1건 · 후방호환)", async () => {
    const { gw, jobs } = retryGw();
    const signedJob: Job = {
      kind: "review",
      run_id: "r",
      actor: "chat:auto",
      payload: { attempt: 1, phase: "01-brief", stage: null, iteration: null },
    };
    const out = {
      kind: "review",
      run_id: "r",
      ok: false,
      message: "심의 미완",
      next: na({ action: "review", phase: "01-brief" }), // 같은 게이트 그대로 — 정당한 재시도 대상
    } as WorkerOutcome;
    await onOutcome(out, gw, signedJob);
    await settle();
    const reviewJobs = jobs.filter((j) => j.kind === "review");
    expect(reviewJobs).toHaveLength(1); // 결박이 정당한 재시도를 막지 않는다
    expect(reviewJobs[0]!.payload.attempt).toBe(2);
  });

  // ── P1: 무해한 stale/경합 실패는 Failure 가 아니라 현재 게이트 카드로 그린다 ──
  it("A) ★ P1: 리뷰 실패지만 게이트가 이미 전진(next.action=approve) → Failure 아님 · 현재 게이트 카드(ApproveGate) 재파생", async () => {
    // 워커 stale-review 스킵/경합 실패가 ok:false 로 도착하지만 런은 다른 프로세스가 이미 approve 게이트로 전진시켰다.
    //   Failure 로 그리면 거짓 신호 + 집계 리포트 failure-zero 영구 오염 → 현재 게이트 카드로 재파생한다(reconcile 과 동일).
    const { gw, jobs, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "approve", gate_label: "승인할 차례" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(renders.map((r) => r.p.type)).toEqual(["ApproveGate"]); // Failure 0
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // 재시도 없음(이미 지난 얘기)
  });

  it("A') P1: 리뷰 실패지만 게이트가 생성 차례(next.action=generate) → GenerateRetry 카드(그 함수 규약) · Failure 아님", async () => {
    const { gw, jobs, renders } = retryGw();
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ action: "generate", stage: "brief" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(renders.map((r) => r.p.type)).toEqual(["GenerateRetry"]);
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0);
  });

  // ── P2: 지연 재시도가 원 게이트 서명(phase/stage/iteration)에 결박된다 ──
  it("E) ★ P2: 백오프 중 다음 페이즈 review 로 전진(action=review 지만 phase 다름) → 재적재 0 · abandon(서명 결박)", async () => {
    // 원 게이트 = 01-brief review. 재확인 시 02-concept review 로 전진 → action 은 여전히 review 라 옛 action-만 검사는 승계했다.
    //   서명(phase) 결박으로 '다른 게이트'임을 알아채고 재적재하지 않는다(옛 재시도 예산이 나중 게이트로 새는 것 차단).
    const { gw, jobs, renders } = retryGw({ readNext: async () => na({ phase: "02-concept", action: "review" }) });
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ phase: "01-brief", action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    expect(jobs.filter((j) => j.kind === "review")).toHaveLength(0); // 서명 불일치 → abandon(submit 0)
    expect(renders.map((r) => r.p.type)).toEqual(["Progress"]); // 최초 재점검 안내만(서명 판별은 재확인 시점)
  });

  it("F) ★ P2: 서명 일치(phase/stage/iteration 동일) → 재적재 1(기존 재시도 동작 불변) · payload 에 원 게이트 서명 동봉", async () => {
    const { gw, jobs } = retryGw({ readNext: async () => na({ phase: "01-brief", iteration: 1, action: "review" }) });
    const out = { kind: "review", run_id: "r", ok: false, message: "심의 미완", next: na({ phase: "01-brief", iteration: 1, action: "review" }) } as WorkerOutcome;
    await onOutcome(out, gw, reviewJob(0));
    await settle();
    const reviewJobs = jobs.filter((j) => j.kind === "review");
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]!.payload).toMatchObject({ attempt: 1, phase: "01-brief", iteration: 1 }); // 서명 동봉
    expect(reviewJobs[0]!.payload.stage).toBeNull(); // review 게이트 stage=null 로 실린다
  });
});

describe("onOutcome — 사람-결정(approve/select) 실패의 게이트-전진 진실 검사(진 클릭 ≠ Failure)", () => {
  // 큐 FIFO 중재에서 진 둘째 잡(드라이버 fire vs 사람 클릭 · 스테일 카드 재클릭)은 core 멱등 거부로 ok:false 가
  //   되는데, 게이트가 이미 전진했으면 그건 오류가 아니라 '이미 처리된 결정'이다 — Failure 로 그리면 개입한 사람이
  //   실패로 오독하고 전 세션 집계 리포트의 failure-zero 를 영구 오염시킨다(Codex W2R3 P1).
  it("approve 실패 + 게이트는 이미 select 차례로 전진 → Failure 아님 · 현재 게이트 카드(OptionSet 계열) 재파생", async () => {
    const { gw, renders } = fakeGateway();
    const out = {
      kind: "approve",
      run_id: "r",
      ok: false,
      message: "지금은 승인 차례가 아닙니다",
      next: na({ action: "select", options: ["A", "B"], recommended: "A" }),
    } as WorkerOutcome;
    await onOutcome(out, gw, { kind: "approve", run_id: "r", actor: "U1", payload: {} });
    expect(renders.map((r) => r.p.type)).not.toContain("Failure"); // 진 클릭은 실패가 아니다
    expect(renders.length).toBeGreaterThan(0); // 현재 게이트 카드가 자리를 덮는다
  });

  it("select 실패 + 게이트가 여전히 select 차례(진짜 그 게이트의 실패) → 기존 Failure 유지(fail-closed 불변)", async () => {
    const { gw, renders } = fakeGateway();
    const out = {
      kind: "select",
      run_id: "r",
      ok: false,
      message: "안을 저장하지 못했어요",
      next: na({ action: "select", options: ["A", "B"], recommended: "A" }),
    } as WorkerOutcome;
    await onOutcome(out, gw, { kind: "select", run_id: "r", actor: "U1", payload: { option: "A" } });
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]); // 같은 차례의 실패는 진짜 실패 — 숨기지 않는다
    expect((renders[0]!.p as { message: string }).message).toBe("안을 저장하지 못했어요");
  });

  it("approve 실패 + next=null(읽기 실패) → 기존 Failure 유지(fail-closed 불변)", async () => {
    const { gw, renders } = fakeGateway();
    const out = { kind: "approve", run_id: "r", ok: false, message: "상태를 읽지 못했어요", next: null } as WorkerOutcome;
    await onOutcome(out, gw, { kind: "approve", run_id: "r", actor: "U1", payload: {} });
    expect(renders.map((r) => r.p.type)).toEqual(["Failure"]);
  });
});
