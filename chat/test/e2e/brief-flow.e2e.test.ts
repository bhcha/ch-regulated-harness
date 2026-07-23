/**
 * brief-flow.e2e.test.ts — 게이트웨이 레벨 stub E2E(브리프 구간).
 *
 * Slack 표면 없이 JobQueue+Worker+실제 harness-cli+StubDirectGenExecutor 로 core stub 을 실제 구동한다
 *   (HARNESS_OFFLINE=1). test-b8 의 sanctioned 경로를 따른다: ingest-bundle 직접(부트스트랩) → 생성/승인/심의
 *   잡을 큐로 흘려 01-brief 통과까지. 실 셸을 spawn 하므로 testTimeout 을 넉넉히 둔다.
 *
 * 통합(integration) 계층: 하네스(core) 경로는 env HARNESS_ROOT 로 **주입**받는다(형제 ../../../core 유도 폐기 —
 *   리포지토리 분리[chat·core 별도 레포] 대비). HARNESS_ROOT 미주입이면 이 스위트 전체를 '보이게' 생략한다
 *   (조용한 통과 금지 — console.warn + describe.skipIf). 이 파일은 vitest.e2e.config.ts(=pnpm test:integration)로만 돈다.
 *
 * ⚠ 함정 회피(grounding 4·5): new-run --format 여러장 로 00g 를 태우지 않는다(금지토큰 stall). 추적 안 되는
 *   inputs/examples 오염을 막으려 mktemp HARNESS_EXAMPLES_DIR 를 쓴다. 전용 rid + afterAll 정리.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobQueue } from "../../src/kernel/job-queue.js";
import { Worker } from "../../src/kernel/worker.js";
import { StubDirectGenExecutor } from "../../src/kernel/gen-executor.js";
import { ingestBundle } from "../../src/kernel/harness-cli.js";
import { readNextAction } from "../../src/kernel/contract-client.js";
import type { Job } from "../../src/types/jobs.js";
import type { WorkerOutcome } from "../../src/kernel/worker.js";

// 하네스(core)는 env 로 주입(머신 고정경로·형제경로 유도 금지 — 리포지토리 분리 대비). 미주입 = 통합 E2E 생략.
//   ⚠ 절대경로화한다(config.ts harnessRoot() 와 동일): core 스크립트는 cwd=정규화된 core 로 spawn 되므로
//     BUNDLE 이 상대경로면 그 cwd 기준으로 어긋나 풀린다. 상대 HARNESS_ROOT(예 ../x/core)도 견디도록 resolve.
const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 통합 E2E 생략");

const RID = "chat-e2e-brief";
const ACTOR = "chat:slack:U-e2e";
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");

let examplesDir: string;
let queue: JobQueue;
const outcomes: WorkerOutcome[] = [];

/** 잡 1건을 큐로 흘리고 처리 완료까지 대기(ack-후-비동기 실제 경로). */
async function run(job: Job): Promise<WorkerOutcome | undefined> {
  const before = outcomes.length;
  await queue.submit(job);
  await queue.drain();
  return outcomes[before]; // 이 잡의 아웃컴(onOutcome 순서 보장)
}

// beforeAll/afterAll 는 describe 안에 둔다 — skipIf 로 스위트를 생략하면 훅도 함께 생략되도록(하네스 미주입 시 no-op).
describe.skipIf(SKIP)("브리프 구간 stub E2E(게이트웨이 → core)", () => {
  beforeAll(() => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    // 유형 선언 = env(test-b8/lib.sh 경로) — ingest-bundle 이 new-run 없이 부트스트랩(00g 금지토큰 stall 회피).
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "multipage_bm";
    examplesDir = mkdtempSync(join(tmpdir(), "chat-e2e-ex-"));
    cpSync(BUNDLE, join(examplesDir, "cosmetic", "ex1"), { recursive: true });
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });

    const worker = new Worker({
      gen: new StubDirectGenExecutor({ offline: () => true }),
      isApprover: () => true, // 승인자 게이트는 worker 단위 테스트가 검증; E2E 는 파이프라인 흐름에 집중
    });
    queue = new JobQueue({ worker, onOutcome: (o) => void outcomes.push(o) });
  });

  afterAll(() => {
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
    rmSync(examplesDir, { recursive: true, force: true });
    delete process.env.HARNESS_OFFLINE;
    delete process.env.HARNESS_EXAMPLES_DIR;
    delete process.env.HARNESS_DOMAIN;
    delete process.env.HARNESS_FORMAT;
  });

  it(
    "인입 → 가이드라인 생성·승인·심의 → 01-brief → 브리프 생성·승인·심의 → 다음 단계 · 감사·멱등",
    async () => {
      // 0) 부트스트랩: ingest-bundle 직접(run 을 만든다 — test-b8 경로, new-run 없이)
      const ing = ingestBundle(BUNDLE, RID);
      expect((await ing).code).toBe(0);

      // 1) 00g 가이드라인 생성(StubDirect) → 승인 게이트
      await run({ kind: "generate", run_id: RID, payload: { stage: "guideline" }, actor: ACTOR });
      let na = await readNextAction(RID);
      expect(na.phase).toBe("00g-guideline");
      expect(na.action).toBe("approve");

      // 2) 승인(--ra-ok) → 심의 → 01-brief 전진
      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("01-brief");

      // 3) 01-brief 생성 → 승인 → 심의 → 다음 단계
      await run({ kind: "generate", run_id: RID, payload: { stage: "brief" }, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("01-brief");
      expect(na.action).toBe("approve");

      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      // 브리프 구간 통과 → 다음 단계(02-concept)로 전진
      expect(na.phase).toBe("02-concept");

      // 4) 감사: history.actor 에 chat:slack:U-e2e 기록
      const state = JSON.parse(readFileSync(join(CORE, "runs", RID, "state.json"), "utf8")) as {
        history: Array<{ actor?: string }>;
      };
      expect(state.history.some((h) => h.actor === ACTOR)).toBe(true);

      // 5) 멱등: 지금은 승인 차례가 아니므로(생성 단계) 다시 approve 잡 → core 가 거부(outcome.ok=false)
      const dup = await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      expect(dup?.ok).toBe(false);
    },
    120_000,
  );
});
