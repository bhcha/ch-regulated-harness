import { expect, test } from "vitest";

// SDK 계약(타입) — tsc 가 실제 export 를 해석하는지 검증(빌드에서 확정). ESM 전용이라 require 금지.
import type { StateAdapter, Chat } from "chat";
// SDK 값 export — 런타임 ESM 로드 + 팩토리 존재 확인.
import { createSlackAdapter } from "@chat-adapter/slack";

// 우리 모듈 스모크.
import {
  SLACK_ENV,
  approvers,
  harnessEnv,
  harnessRoot,
  isApprover,
  isOffline,
  slackTokens,
  storagePaths,
} from "../src/config.js";
import type { Advisory, NextAction, StopReason } from "../src/types/contract.js";
import type { GenExecutor, Job, JobSubmitter } from "../src/types/jobs.js";

// tsc 가 chat 의 StateAdapter/Chat 를 실제 해석하도록 타입 위치에서 사용(런타임 무해).
const _usesStateAdapter = (a: StateAdapter): Promise<void> => a.connect();
const _usesChat = (c: Chat): unknown => c;
void _usesStateAdapter;
void _usesChat;

test("chat SDK: 값 export 가 ESM 로 로드된다(createSlackAdapter 팩토리)", () => {
  expect(typeof createSlackAdapter).toBe("function");
});

test("config.ts: harnessRoot — HARNESS_ROOT 미설정 시 fail-fast · 설정 시 오버라이드", () => {
  const saved = process.env.HARNESS_ROOT;
  try {
    // 미주입(미설정)이면 형제 경로로 조용히 폴백하지 않고 명확한 한국어 안내로 throw(fail-fast).
    delete process.env.HARNESS_ROOT;
    expect(() => harnessRoot()).toThrow(/HARNESS_ROOT 환경변수가 필요합니다/);
    // 주입되면 그 값을 절대경로로 반환.
    process.env.HARNESS_ROOT = "/tmp/x/core";
    expect(harnessRoot()).toBe("/tmp/x/core");
  } finally {
    if (saved === undefined) delete process.env.HARNESS_ROOT;
    else process.env.HARNESS_ROOT = saved;
  }
});

test("config.ts: CHAT_APPROVERS 콤마분리 · isApprover fail-closed", () => {
  const saved = process.env.CHAT_APPROVERS;
  try {
    process.env.CHAT_APPROVERS = "slack:U1, slack:U2 ,";
    expect(approvers()).toEqual(["slack:U1", "slack:U2"]);
    expect(isApprover("slack:U2")).toBe(true);
    expect(isApprover("slack:U9")).toBe(false);
    delete process.env.CHAT_APPROVERS;
    expect(approvers()).toEqual([]);
    expect(isApprover("slack:U1")).toBe(false); // 빈 allowlist = fail-closed
  } finally {
    if (saved === undefined) delete process.env.CHAT_APPROVERS;
    else process.env.CHAT_APPROVERS = saved;
  }
});

test("config.ts: Slack env 이름 상수 · 토큰/저장경로 함수", () => {
  expect(SLACK_ENV.botToken).toBe("SLACK_BOT_TOKEN");
  expect(SLACK_ENV.appToken).toBe("SLACK_APP_TOKEN");
  expect(SLACK_ENV.signingSecret).toBe("SLACK_SIGNING_SECRET");
  expect(typeof slackTokens()).toBe("object");
  expect(typeof isOffline()).toBe("boolean");
  expect(harnessEnv().HARNESS_ROOT).toBe(harnessRoot());
  const paths = storagePaths();
  expect(paths.jobsPending.endsWith("/pending")).toBe(true);
  expect(paths.jobs.endsWith("/jobs")).toBe(true);
});

test("contract.ts: 픽스처 형태로 NextAction 구성 + 미지 필드 무시", () => {
  const advisory: Advisory = { must_fill: [], nice_to_have: [], completeness: [0, 0] };
  const stop: StopReason | null = null;
  const na: NextAction = {
    rid: "chatfx-brief",
    phase: "00g-guideline",
    phase_label: "비슷한 제품 참고 메모",
    step: "human",
    gate: "user",
    status: "pending",
    awaiting: "user",
    iteration: 1,
    max_iterations: 3,
    action: "approve",
    stage: null,
    needs: null,
    options: [],
    recommended: null,
    ra_ok_required: false,
    revise_available: true,
    gate_type: "human-verify",
    stop_reason: stop,
    advisory,
    cmd: "bash scripts/approve.sh chatfx-brief",
    gate_label: "다 만들었어요 · 승인할 차례예요",
    hint: "",
    files: [],
  };
  expect(na.action).toBe("approve");
  expect(na.advisory?.completeness[0]).toBe(0);

  // forward-compat: 미지 top-level 필드가 있어도 파싱/할당이 깨지지 않는다.
  const withExtra = { ...na, some_future_field: 42 } as NextAction;
  expect(withExtra.rid).toBe("chatfx-brief");
});

test("jobs.ts: Job 구성 + JobSubmitter/GenExecutor 구조적 구현", () => {
  const job: Job = {
    kind: "approve",
    run_id: "chatfx-brief",
    payload: { ra_ok: true },
    actor: "chat:slack:U1",
  };
  expect(job.kind).toBe("approve");
  expect(job.payload.ra_ok).toBe(true);

  const submitter: JobSubmitter = { async submit() {} };
  const exec: GenExecutor = { async execute() {} };
  void submitter;
  void exec;
  expect(typeof submitter.submit).toBe("function");
  expect(typeof exec.execute).toBe("function");
});
