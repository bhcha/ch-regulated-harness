/**
 * consumer-daemon.e2e.test.ts — 무인 소비자 데몬(W4) stub E2E: **데몬이 실제 파일 큐 + core stub 으로 1잡 완주**.
 *
 * 무엇을 검증하나: Slack 표면 없이 ConsumerDaemon 이 실제 `jobs/pending/` 큐를 폴링·2중 검사·클레임하고, 오프라인
 *   stub 잡세션(run-stage.sh 직접, HARNESS_OFFLINE=1)으로 core 를 결정론 구동해 전이시킨 뒤, 성공한 잡을 삭제한다.
 *   실 `claude` 세션·실 supervisor spawn·실 프로세스 신호는 **뜨지 않는다**(오프라인 = stub 직접 · 라이브는 W5).
 *
 * 통합(integration) 계층: 하네스(core)는 env HARNESS_ROOT 로 **주입**. 미주입이면 스위트 전체를 '보이게' 생략한다
 *   (조용한 통과 금지 — console.warn + describe.skipIf). vitest.e2e.config.ts(=pnpm test:integration)로만 돈다.
 *
 * ⚠ 함정 회피(계획 · 다른 e2e 와 충돌 방지): **전용 rid**(chat-e2e-consumer) + **전용 CHAT_JOBS_DIR**(mktemp) +
 *   afterAll 정리. 큐를 임시 디렉터리로 격리해 기존 e2e 4건의 잡큐·런과 겹치지 않는다. 추적 안 되는 examples 오염을
 *   막으려 mktemp HARNESS_EXAMPLES_DIR 를 쓴다(brief-flow.e2e 와 같은 sanctioned 부트스트랩 경로).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConsumerDaemon } from "../../src/worker/cli-consumer.js";
import { buildGenerateJob, isGenerateTurn, writePendingJob } from "../../src/kernel/job-protocol.js";
import { ingestBundle } from "../../src/kernel/harness-cli.js";
import { readNextAction } from "../../src/kernel/contract-client.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 무인 소비자 데몬 stub E2E 생략");

const RID = "chat-e2e-consumer";
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");

let examplesDir: string;
let jobsDir: string;
const ls = (d: string): Promise<string[]> => readdir(d).then((n) => n.sort(), () => []);

describe.skipIf(SKIP)("무인 소비자 데몬 stub E2E(실제 큐 + core stub)", () => {
  beforeAll(async () => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    // 유형 선언 = env(test-b8/lib.sh 경로) — ingest-bundle 이 new-run 없이 부트스트랩(00g 금지토큰 stall 회피).
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "multipage_bm";
    examplesDir = mkdtempSync(join(tmpdir(), "chat-e2e-consumer-ex-"));
    cpSync(BUNDLE, join(examplesDir, "cosmetic", "ex1"), { recursive: true });
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    // 전용 잡큐(임시) — 기존 e2e 큐·런과 격리.
    jobsDir = mkdtempSync(join(tmpdir(), "chat-e2e-consumer-jobs-"));
    process.env.CHAT_JOBS_DIR = jobsDir;
    await mkdir(join(jobsDir, "pending"), { recursive: true });
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
    rmSync(examplesDir, { recursive: true, force: true });
    rmSync(jobsDir, { recursive: true, force: true });
    delete process.env.HARNESS_OFFLINE;
    delete process.env.HARNESS_EXAMPLES_DIR;
    delete process.env.HARNESS_DOMAIN;
    delete process.env.HARNESS_FORMAT;
    delete process.env.CHAT_JOBS_DIR;
    delete process.env.CHAT_SDK_STAGES;
  });

  it(
    "인입 부트스트랩 → 데몬이 생성 잡을 집어 stub 전이 → 성공 삭제 + next-action 전진",
    async () => {
      // 0) 부트스트랩: ingest-bundle 직접(run 을 만든다 · test-b8 경로) → 첫 생성 차례.
      const ing = await ingestBundle(BUNDLE, RID);
      expect(ing.code).toBe(0);

      // 1) 지금 무슨 단계 생성 차례인가(하드코딩 대신 next-action 이 진실).
      const na0 = await readNextAction(RID);
      expect(na0.step).toBe("generate");
      const stage = na0.stage;
      expect(typeof stage).toBe("string");
      const genStage = stage as string;

      // 2) 그 단계를 무인으로 켜고(enablement) 데몬을 만든다(config 게터가 env 를 읽으므로 생성 전에 set).
      process.env.CHAT_SDK_STAGES = genStage;

      // 3) v2 생성 잡을 실제 pending 에 적재(봇이 하던 일).
      const job = buildGenerateJob({
        run_id: RID,
        stage: genStage,
        enqueuedAtMs: Date.now(),
        timeoutMs: 900_000,
      });
      await writePendingJob(join(jobsDir, "pending"), job);
      expect(await ls(join(jobsDir, "pending"))).toContain(`${RID}-${genStage}.json`);

      // 4) 데몬이 1잡 소비(오프라인 = stub 직접 잡세션 · 실 CLI 0). 기본 seam 전부(config·큐·core stub).
      const daemon = new ConsumerDaemon({ log: () => {} });
      const outcome = await daemon.consumeOne();

      // 5) 완주 검증.
      expect(outcome?.action).toBe("claimed");
      expect(outcome?.ok).toBe(true);
      // 성공 → 잡 삭제(pending·claimed 모두 비어야 한다).
      expect(await ls(join(jobsDir, "pending"))).toEqual([]);
      expect(await ls(join(jobsDir, "claimed", "daemon"))).toEqual([]);
      // next-action 이 전진(그 단계 생성 차례가 더는 아니다 = 전이 완료).
      const na1 = await readNextAction(RID);
      expect(isGenerateTurn(na1, genStage)).toBe(false);
    },
    120_000,
  );
});
