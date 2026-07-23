/**
 * keyvisual-flow.e2e.test.ts — 게이트웨이 레벨 stub E2E(다안 이미지 선택 · P2).
 *
 * select-flow 를 이어받아 **storyboard-plan 승인 이후**를 몬다: keyvisual 자동 생성 → 이미지 다안 선택 게이트 →
 *   안별 미리보기 이미지(옵션 파일 실재) → 선택 → 확정 승인(2중) → 심의 → done. Slack 표면 없이
 *   JobQueue+Worker+실 harness-cli+StubDirectGenExecutor 로 core stub 을 실제 구동한다(HARNESS_OFFLINE=1).
 *   keyvisual 감사를 assert 한다: state.json history 의 select actor + 04-keyvisual/decision.json{selected}.
 *   + keyvisual-reader(ImageOptionSet 산출)가 실제 옵션 이미지를 해석하는지 회귀 검증.
 *
 * 통합(integration) 계층: select-flow 와 동일하게 core 경로는 env HARNESS_ROOT 로 주입, 미주입이면 스위트 생략
 *   (console.warn + describe.skipIf). vitest.e2e.config.ts(=pnpm test:integration)로만 돈다.
 *   ⚠ 함정 회피(grounding 4·5): HARNESS_FORMAT=multipage_bm + mktemp HARNESS_EXAMPLES_DIR(00g stall·examples 오염 회피).
 *   전용 rid(chat-e2e-keyvisual) + afterAll 정리.
 *
 * ⚠ 오프라인 도달 범위(실측): 오프라인 stub 은 keyvisual generate 시 Playwright 렌더까지 돌아
 *   options/<key>/shots/full.png 를 만든다 → 이미지 다안 select 게이트에 도달하고, 선택→승인→심의→done 까지
 *   완주한다(이 환경 실측). generated/*.png 는 오프라인에서 .svg 라 reader 폴백은 full.png 를 택한다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobQueue } from "../../src/kernel/job-queue.js";
import { Worker } from "../../src/kernel/worker.js";
import { StubDirectGenExecutor } from "../../src/kernel/gen-executor.js";
import { ingestBundle } from "../../src/kernel/harness-cli.js";
import { readNextAction } from "../../src/kernel/contract-client.js";
import { readKeyvisualOptions } from "../../src/kernel/keyvisual-reader.js";
import type { Job } from "../../src/types/jobs.js";
import type { WorkerOutcome } from "../../src/kernel/worker.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 통합 E2E(keyvisual) 생략");

const RID = "chat-e2e-keyvisual";
const ACTOR = "chat:slack:U-e2e-kv";
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");

let examplesDir: string;
let queue: JobQueue;
const outcomes: WorkerOutcome[] = [];

/** 잡 1건을 큐로 흘리고 처리 완료까지 대기(ack-후-비동기 실제 경로). */
async function run(job: Job): Promise<WorkerOutcome | undefined> {
  const before = outcomes.length;
  await queue.submit(job);
  await queue.drain();
  return outcomes[before];
}

describe.skipIf(SKIP)("다안 이미지 선택 stub E2E(게이트웨이 → core · 04-keyvisual)", () => {
  beforeAll(() => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "multipage_bm";
    examplesDir = mkdtempSync(join(tmpdir(), "chat-e2e-kv-ex-"));
    cpSync(BUNDLE, join(examplesDir, "cosmetic", "ex1"), { recursive: true });
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });

    const worker = new Worker({
      gen: new StubDirectGenExecutor({ offline: () => true }),
      isApprover: () => true, // 승인자 게이트는 flow/worker 단위 테스트가 검증; E2E 는 파이프라인·감사에 집중
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
    "인입→…→plan 승인→키비주얼 자동생성→이미지 다안 선택→확정 승인→심의→done · 이미지 실재 + 감사",
    async () => {
      // 0) 부트스트랩 + 브리프~스토리보드 통과(select-flow 경로 압축).
      expect((await ingestBundle(BUNDLE, RID)).code).toBe(0);
      await run({ kind: "generate", run_id: RID, payload: { stage: "guideline" }, actor: ACTOR });
      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "generate", run_id: RID, payload: { stage: "brief" }, actor: ACTOR });
      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "generate", run_id: RID, payload: { stage: "concept" }, actor: ACTOR });
      let na = await readNextAction(RID);
      await run({ kind: "select", run_id: RID, payload: { option: na.recommended as string }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "generate", run_id: RID, payload: { stage: "storyboard-outline" }, actor: ACTOR });
      na = await readNextAction(RID);
      await run({ kind: "select", run_id: RID, payload: { option: na.recommended as string }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "generate", run_id: RID, payload: { stage: "storyboard-plan" }, actor: ACTOR });
      await run({ kind: "approve", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("04-keyvisual");
      expect(na.action).toBe("generate");
      expect(na.stage).toBe("keyvisual");

      // 1) 키비주얼 생성(오프라인 stub — HTML + 이미지 bake + Playwright 렌더) → 이미지 다안 선택 게이트.
      const gen = await run({ kind: "generate", run_id: RID, payload: { stage: "keyvisual" }, actor: ACTOR });
      expect(gen?.ok).toBe(true);
      na = await readNextAction(RID);
      expect(na.phase).toBe("04-keyvisual");
      expect(na.action).toBe("select"); // 디자인 A/B/C 선택 차례
      expect(na.options.length).toBeGreaterThanOrEqual(2);
      expect(na.recommended).not.toBeNull();
      const kvKey = na.recommended as string;

      // 1′) 옵션 이미지가 디스크에 실재하는지(모의 이미지 만들지 않음 — 실제 산출물). full.png 우선.
      for (const key of na.options) {
        const full = join(CORE, "runs", RID, "04-keyvisual", "options", key, "shots", "full.png");
        expect(existsSync(full)).toBe(true);
      }

      // 1″) keyvisual-reader(ImageOptionSet 산출)가 실제 옵션 이미지를 해석하는지(reader 회귀 · 오프라인).
      const kvOpts = await readKeyvisualOptions(RID, na.options, na.recommended);
      expect(kvOpts.map((o) => o.key)).toEqual(na.options);
      expect(kvOpts.every((o) => o.imagePaths.length >= 1)).toBe(true); // full.png 해석
      expect(kvOpts.every((o) => o.imagePaths.every((p) => existsSync(p)))).toBe(true);
      expect(kvOpts.find((o) => o.key === kvKey)?.recommended).toBe(true);

      // 2) 추천 디자인 선택 → select.sh(--by ACTOR) → 확정 승인 차례(select→approve 순서, 2중 확인 1단계).
      const sel = await run({ kind: "select", run_id: RID, payload: { option: kvKey }, actor: ACTOR });
      expect(sel?.ok).toBe(true);
      na = await readNextAction(RID);
      expect(na.action).toBe("approve"); // 키비주얼은 선택 후 확정 승인(2중 확인)

      // 2′) 감사 겹2: 04-keyvisual/decision.json 에 선택 키.
      const decision = JSON.parse(
        readFileSync(join(CORE, "runs", RID, "04-keyvisual", "decision.json"), "utf8"),
      ) as { selected?: string };
      expect(decision.selected).toBe(kvKey);

      // 3) 확정 승인 → 심의(design-verdict) → done.
      await run({ kind: "approve", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.action).toBe("review");
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("done");
      expect(na.action).toBe("done");

      // 4) 감사 겹1: state.json history 에 키비주얼 선택 행위자(chat:slack:U-e2e-kv) + select 이벤트.
      const state = JSON.parse(readFileSync(join(CORE, "runs", RID, "state.json"), "utf8")) as {
        history: Array<{ actor?: string; event?: string; phase?: string }>;
      };
      expect(
        state.history.some((h) => h.phase === "04-keyvisual" && (h.event ?? "").startsWith("select") && h.actor === ACTOR),
      ).toBe(true);
    },
    360_000,
  );
});
