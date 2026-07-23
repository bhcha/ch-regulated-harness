/**
 * worker.test.ts — Worker.process 매핑·가드·메시지 검증(셸·네트워크 없이 fake 주입).
 *   1) kind→harness-cli/GenExecutor 인자 매핑(approve/select/revise/ingest/review/raise-limit/generate)
 *   2) 상태변이 잡(approve/select/revise)의 비승인 actor 거부(셸 미호출)
 *   3) harness 비-0 종료 → 실패 + 평이 메시지(내부 stderr/코드 비노출)
 *   4) 완료 후 readNextAction 결과를 outcome.next 에 담아 반환(읽기 실패는 next=null)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Worker, type HarnessCli } from "../../src/kernel/worker.js";
import { GenerationInProgressError } from "../../src/kernel/gen-executor.js";
import type { HarnessResult } from "../../src/kernel/harness-cli.js";
import type { NextAction } from "../../src/types/contract.js";
import type { GenExecutor, Job, JobKind } from "../../src/types/jobs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXT = JSON.parse(
  readFileSync(resolve(HERE, "../fixtures/next-action/01-guideline-approve.json"), "utf8"),
) as NextAction;

const ok = (): HarnessResult => ({ code: 0, stdout: "", stderr: "" });

/** 호출을 기록하는 fake harness-cli(모든 함수 동일 결과 반환). */
function recCli(result: HarnessResult = ok()): {
  cli: HarnessCli;
  calls: Array<{ fn: string; args: unknown[] }>;
} {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const push = (fn: string, args: unknown[]): Promise<HarnessResult> => {
    calls.push({ fn, args });
    return Promise.resolve(result); // 비동기 spawn 계약에 맞춰 Promise 반환
  };
  const cli: HarnessCli = {
    approve: (rid, opts) => push("approve", [rid, opts]),
    select: (rid, key, opts) => push("select", [rid, key, opts]),
    revise: (rid, reason, opts) => push("revise", [rid, reason, opts]),
    raiseLimit: (rid) => push("raiseLimit", [rid]),
    ingestBundle: (bundleDir, rid, opts) => push("ingestBundle", [bundleDir, rid, opts]),
    intake: (attachDir, rid, opts) => push("intake", [attachDir, rid, opts]),
    runStage: (stage, rid) => push("runStage", [stage, rid]),
    kciaCheck: (rid) => push("kciaCheck", [rid]),
  };
  return { cli, calls };
}

/** 호출을 기록하는 fake GenExecutor. */
function recGen(impl?: (rid: string, stage: string) => Promise<void>): {
  gen: GenExecutor;
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  const gen: GenExecutor = {
    execute: async (rid, stage) => {
      calls.push([rid, stage]);
      if (impl) await impl(rid, stage);
    },
  };
  return { gen, calls };
}

/** 다음 할 일 fake(고정 NextAction 반환). */
const readNextOk = async (): Promise<NextAction> => NEXT;

/** 항상 승인자로 보는 워커 조립 헬퍼. */
function makeWorker(over: {
  cli?: HarnessCli;
  gen?: GenExecutor;
  readNext?: () => Promise<NextAction>;
  isApprover?: (a: string) => boolean;
}): Worker {
  return new Worker({
    gen: over.gen ?? recGen().gen,
    cli: over.cli ?? recCli().cli,
    readNext: over.readNext ?? readNextOk,
    isApprover: over.isApprover ?? ((): boolean => true),
  });
}

describe("Worker generate 위임", () => {
  it("generate 는 GenExecutor.execute(run_id, stage) 로 위임하고 다음 할 일을 담아 반환", async () => {
    const { gen, calls } = recGen();
    const w = makeWorker({ gen });
    const out = await w.process({
      kind: "generate",
      run_id: "run-A",
      payload: { stage: "brief" },
      actor: "chat:slack:U1",
    });
    expect(calls).toEqual([["run-A", "brief"]]);
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("generate");
    expect(out.next).toEqual(NEXT);
  });

  it("generate 실패(gen 예외) → 실패 아웃컴 + 평이 메시지(내부 예외 문구 비노출)", async () => {
    const gen: GenExecutor = {
      execute: async () => {
        throw new Error("STACKTRACE /secret/x 폭발");
      },
    };
    const w = makeWorker({ gen });
    const out = await w.process({
      kind: "generate",
      run_id: "r",
      payload: { stage: "brief" },
      actor: "x",
    });
    expect(out.ok).toBe(false);
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message).not.toContain("STACKTRACE");
    expect(out.message).not.toContain("/secret/x");
    expect(out.detail).toContain("STACKTRACE"); // 원문은 진단용 detail 에만
  });

  it("★ '이미 만들고 있다'(GenerationInProgressError)는 문구를 **그대로** 싣는다 — 평이 문구로 덮으면 거짓말이 된다", async () => {
    // 이중 소비 차단으로 적재를 건너뛴 경우다. 기본 실패 문구("생성을 마치지 못했습니다")로 치환하면
    //   못 만든 게 아니라 지금 만들고 있는 상황을 현업에게 반대로 알리게 된다.
    const gen: GenExecutor = {
      execute: async () => {
        throw new GenerationInProgressError("이미 만들고 있어요 — 잠시 후 다시 확인해 주세요.");
      },
    };
    const out = await makeWorker({ gen }).process({
      kind: "generate",
      run_id: "r",
      payload: { stage: "brief" },
      actor: "x",
    });
    expect(out.ok).toBe(false); // 성공으로 두면 자동 이어가기가 같은 단계를 또 적재한다(막은 중복을 스스로 만든다)
    expect(out.message).toBe("이미 만들고 있어요 — 잠시 후 다시 확인해 주세요.");
    expect(out.message).not.toContain("생성을 마치지 못했습니다");
  });

  it("generate 인데 stage 누락 → 크래시 없이 실패 아웃컴", async () => {
    const { gen, calls } = recGen();
    const w = makeWorker({ gen });
    const out = await w.process({ kind: "generate", run_id: "r", payload: {}, actor: "x" });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("generate 로 위장한 제어 verb(stage=raise-limit)는 거부(승인 가드 우회 스머글링 차단)", async () => {
    const { gen, calls } = recGen();
    const w = makeWorker({ gen, isApprover: () => false });
    const out = await w.process({ kind: "generate", run_id: "r", payload: { stage: "raise-limit" }, actor: "x" });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0); // gen.execute 미호출
  });
});

describe("Worker harness-cli 인자 매핑", () => {
  it("approve 는 comment·ra_ok·actor 를 그대로 전달", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli });
    await w.process({
      kind: "approve",
      run_id: "run-A",
      payload: { comment: "좋습니다", ra_ok: true },
      actor: "chat:slack:U7",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("approve");
    expect(calls[0]!.args[0]).toBe("run-A");
    expect(calls[0]!.args[1]).toEqual({ comment: "좋습니다", raOk: true, by: "chat:slack:U7" });
  });

  it("approve 의 ra_ok 는 엄격 boolean — truthy 비-boolean('false'·1·'true')은 --ra-ok 로 새지 않음(RA 게이트 보존)", async () => {
    for (const bad of ["false", "0", 1, "true"] as unknown[]) {
      const { cli, calls } = recCli();
      const w = makeWorker({ cli });
      await w.process({
        kind: "approve",
        run_id: "r",
        payload: { ra_ok: bad } as never,
        actor: "chat:slack:U1",
      });
      expect((calls[0]!.args[1] as { raOk: boolean }).raOk).toBe(false);
    }
  });

  it("select 는 option 키를, revise 는 feedback 을 by(actor)와 함께 전달", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli });
    await w.process({
      kind: "select",
      run_id: "r",
      payload: { option: "B" },
      actor: "chat:slack:U2",
    });
    expect(calls[0]).toEqual({ fn: "select", args: ["r", "B", { by: "chat:slack:U2" }] });
    await w.process({
      kind: "revise",
      run_id: "r",
      payload: { feedback: "이 표현 빼주세요" },
      actor: "chat:slack:U2",
    });
    expect(calls[1]).toEqual({
      fn: "revise",
      args: ["r", "이 표현 빼주세요", { by: "chat:slack:U2" }],
    });
  });

  it("ingest 는 bundle_dir·wb_path 를 ingestBundle(bundle,rid,{wbPath}) 로 전달", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "ingest" }) }); // 현재 인입 차례
    await w.process({
      kind: "ingest",
      run_id: "r",
      payload: { bundle_dir: "/abs/bundle", wb_path: "/abs/wb.md" },
      actor: "x",
    });
    expect(calls[0]).toEqual({
      fn: "ingestBundle",
      args: ["/abs/bundle", "r", { wbPath: "/abs/wb.md" }],
    });
  });

  it("review→kciaCheck(rid) · raise-limit→raiseLimit(rid)(a2ui-action.sh 브리지)", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli });
    await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    await w.process({ kind: "raise-limit", run_id: "r", payload: {}, actor: "x" });
    expect(calls[0]).toEqual({ fn: "kciaCheck", args: ["r"] });
    expect(calls[1]).toEqual({ fn: "raiseLimit", args: ["r"] });
  });

  it("필수 인자 누락(select option 없음)은 크래시 없이 실패 아웃컴(셸 미호출)", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli });
    const out = await w.process({ kind: "select", run_id: "r", payload: {}, actor: "chat:slack:U1" });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("Worker 승인자 가드", () => {
  it("비승인 actor 의 상태변이 잡(approve/select/revise/raise-limit)은 실행 전 거부(셸 미호출)", async () => {
    for (const kind of ["approve", "select", "revise", "raise-limit"] as JobKind[]) {
      const { cli, calls } = recCli();
      const w = makeWorker({ cli, isApprover: () => false });
      const payload =
        kind === "select"
          ? { option: "A" }
          : kind === "revise"
            ? { feedback: "빼주세요" }
            : { comment: "ok" };
      const out = await w.process({ kind, run_id: "run-A", payload, actor: "chat:slack:U9" });
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/권한/);
      expect(calls).toHaveLength(0); // 셸 미호출로 거부
    }
  });

  it("생성·인입·심의는 승인자 아니어도 진행(상태변이·한도상향만 승인 게이트)", async () => {
    const { cli, calls } = recCli();
    const { gen, calls: genCalls } = recGen();
    // 인입은 '현재 인입 차례'일 때만 진행(stale 가드) → readNext 를 action=ingest 로.
    const w = makeWorker({
      cli,
      gen,
      isApprover: () => false,
      readNext: async () => ({ ...NEXT, action: "ingest" }),
    });
    await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    await w.process({ kind: "ingest", run_id: "r", payload: { bundle_dir: "/b" }, actor: "x" });
    await w.process({ kind: "generate", run_id: "r", payload: { stage: "brief" }, actor: "x" });
    expect(calls.map((c) => c.fn)).toEqual(["kciaCheck", "ingestBundle"]);
    expect(genCalls).toEqual([["r", "brief"]]);
  });

  it("stale ingest — 현재 인입 차례가 아니면(action!=ingest) ingest-bundle 미실행(진행 폐기 방지)", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "approve" }) });
    const out = await w.process({ kind: "ingest", run_id: "r", payload: { bundle_dir: "/b" }, actor: "x" });
    expect(out.ok).toBe(false);
    expect(calls.some((c) => c.fn === "ingestBundle")).toBe(false); // 셸 미호출(리셋 차단)
  });

  it("stale ingest — 다음 할 일 읽기 실패(throw→null)면 fail-CLOSED 로 차단(ingest-bundle 미실행)", async () => {
    // HIGH #2 회귀 방어: 읽기 실패를 진행으로 흘리면 stale 인입이 하류 런을 리셋한다. 확인 실패=차단이어야 한다.
    //   (S1 이 readNextAction 을 throw 시키게 바꾼 뒤 .catch(()=>null)→null→'진행'으로 뒤집혔던 구멍.)
    const { cli, calls } = recCli();
    const w = makeWorker({
      cli,
      readNext: async () => {
        throw new Error("next-action spawn 실패");
      },
    });
    const out = await w.process({ kind: "ingest", run_id: "r", payload: { bundle_dir: "/b" }, actor: "x" });
    expect(out.ok).toBe(false);
    expect(calls.some((c) => c.fn === "ingestBundle")).toBe(false); // 셸 미호출(리셋 차단 · 재시도로 복구)
  });

  it("raise-limit 은 승인자만(비승인 거부 · 승인자면 raiseLimit 브리지 진행)", async () => {
    // 비승인: 거부(셸 미호출)
    const denied = recCli();
    const wDeny = makeWorker({ cli: denied.cli, isApprover: () => false });
    const outDeny = await wDeny.process({ kind: "raise-limit", run_id: "r", payload: {}, actor: "x" });
    expect(outDeny.ok).toBe(false);
    expect(outDeny.message).toMatch(/권한/);
    expect(denied.calls).toHaveLength(0);
    // 승인자: raiseLimit(rid) 진행(a2ui-action.sh 브리지 → run-stage raise-limit)
    const ok = recCli();
    const wOk = makeWorker({ cli: ok.cli, isApprover: () => true });
    await wOk.process({ kind: "raise-limit", run_id: "r", payload: {}, actor: "chat:slack:U1" });
    expect(ok.calls.map((c) => c.fn)).toEqual(["raiseLimit"]);
  });
});

describe("Worker stale-review 가드", () => {
  it("재적재된 리뷰(attempt>0)인데 심의 차례가 아니면(action!=review) kciaCheck 미호출 벤인 no-op", async () => {
    for (const staleAction of ["approve", "done"] as const) {
      const { cli, calls } = recCli();
      const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: staleAction }) });
      const out = await w.process({
        kind: "review",
        run_id: "r",
        payload: { attempt: 1 },
        actor: "x",
      });
      expect(out.ok).toBe(false); // ok:true 면 verdict 표시 경로로 새어 없는 판정을 지어낼 수 있음
      expect(out.message).toBe("이미 점검이 끝났어요 — 지금은 점검 차례가 아니에요.");
      expect(calls.some((c) => c.fn === "kciaCheck")).toBe(false); // 셸 미호출(엉뚱한 단계 심의 차단)
    }
  });

  it("재적재된 리뷰(attempt>0)라도 여전히 심의 차례면(action=review) kciaCheck 로 진행(정상 재시도 비차단)", async () => {
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "review" }) });
    const out = await w.process({
      kind: "review",
      run_id: "r",
      payload: { attempt: 2 },
      actor: "x",
    });
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["kciaCheck"]); // 가드가 정당한 still-review 재시도를 막지 않음
  });

  it("최초 리뷰(attempt 부재)는 가드가 발화하지 않고 곧장 kciaCheck(기존 동작 불변)", async () => {
    // readNext 가 심의-아닌 action 을 내도 attempt 부재면 가드가 건너뛰어져 기존과 동일하게 진행한다.
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "approve" }) });
    const out = await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["kciaCheck"]);
  });

  it("G) ★ P2: 서명 불일치 재적재 잡(phase 다름)은 action=review 여도 kciaCheck 미호출 벤인 스킵", async () => {
    // NEXT.phase="00g-guideline". payload 서명 phase 를 다른 값(01-brief)으로 → 다음 페이즈 review 로 승계된 옛 타이머.
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "review" }) });
    const out = await w.process({
      kind: "review",
      run_id: "r",
      payload: { attempt: 1, phase: "01-brief" },
      actor: "x",
    });
    expect(out.ok).toBe(false);
    expect(out.message).toBe("이미 점검이 끝났어요 — 지금은 점검 차례가 아니에요.");
    expect(calls.some((c) => c.fn === "kciaCheck")).toBe(false); // 셸 미호출(승계된 나중 게이트 심의 차단)
  });

  it("P2: 서명 일치 재적재 잡(phase/stage/iteration 동일)은 kciaCheck 로 진행(정당한 결박 재시도 비차단)", async () => {
    // NEXT: phase=00g-guideline · stage=null · iteration=1. 같은 서명을 실어 재적재 → 진행.
    const { cli, calls } = recCli();
    const w = makeWorker({ cli, readNext: async () => ({ ...NEXT, action: "review" }) });
    const out = await w.process({
      kind: "review",
      run_id: "r",
      payload: { attempt: 1, phase: "00g-guideline", stage: null, iteration: 1 },
      actor: "x",
    });
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["kciaCheck"]); // 서명 결박이 정당한 재시도를 막지 않음
  });
});

describe("Worker 실패/회신 계약", () => {
  it("harness 비-0 종료 → 실패 + 평이 메시지(내부 stderr/코드 비노출) + 다음 할 일 보존", async () => {
    const { cli } = recCli({ code: 2, stdout: "", stderr: "TRACE /secret/path fail exit=2" });
    const w = makeWorker({ cli });
    const out = await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    expect(out.ok).toBe(false);
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message).not.toContain("/secret/path");
    expect(out.message).not.toContain("exit=2");
    expect(out.message).not.toContain("2"); // 종료코드 숫자 비노출
    expect(out.next).toEqual(NEXT); // 실패해도 다음 할 일은 담아 반환
  });

  it("성공 시 outcome.next = readNextAction 결과", async () => {
    const w = makeWorker({});
    const out = await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    expect(out.ok).toBe(true);
    expect(out.next).toEqual(NEXT);
    expect(out.detail).toBeUndefined(); // 성공 시 진단 원문 없음
  });

  it("다음 할 일 읽기 실패는 잡 결과를 뒤엎지 않는다(next=null)", async () => {
    const w = makeWorker({
      readNext: async () => {
        throw new Error("spawn 실패");
      },
    });
    const out = await w.process({ kind: "review", run_id: "r", payload: {}, actor: "x" });
    expect(out.ok).toBe(true);
    expect(out.next).toBeNull();
  });
});
