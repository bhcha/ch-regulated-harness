/**
 * select-flow.e2e.test.ts — 게이트웨이 레벨 stub E2E(다안 md 선택 · P1).
 *
 * brief-flow 를 이어받아 **브리프 통과 이후**를 몬다: 02-concept 자동 생성 → 다안 선택 → 03-storyboard outline
 *   자동 생성 → 다안 선택 → storyboard-plan 자동 생성 → 승인 게이트. Slack 표면 없이 JobQueue+Worker+실 harness-cli+
 *   StubDirectGenExecutor 로 core stub 을 실제 구동한다(HARNESS_OFFLINE=1). 선택 감사 3겹을 assert 한다:
 *     · state.json history 에 actor(chat:slack:U-e2e)  · 단계 decision.json {selected}  · options-compare.md 파싱(reader).
 *
 * 통합(integration) 계층: brief-flow 와 동일하게 core 경로는 env HARNESS_ROOT 로 주입, 미주입이면 스위트 생략
 *   (console.warn + describe.skipIf). vitest.e2e.config.ts(=pnpm test:integration)로만 돈다.
 *   ⚠ 함정 회피(grounding 4·5): HARNESS_FORMAT=multipage_bm + mktemp HARNESS_EXAMPLES_DIR(00g stall·examples 오염 회피).
 *   전용 rid(chat-e2e-select) + afterAll 정리.
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
import { findSection, readOptionsDoc } from "../../src/kernel/option-reader.js";
import type { Job } from "../../src/types/jobs.js";
import type { WorkerOutcome } from "../../src/kernel/worker.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 통합 E2E(select) 생략");

const RID = "chat-e2e-select";
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
  return outcomes[before];
}

describe.skipIf(SKIP)("다안 선택 stub E2E(게이트웨이 → core)", () => {
  beforeAll(() => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "multipage_bm";
    examplesDir = mkdtempSync(join(tmpdir(), "chat-e2e-sel-ex-"));
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
    "인입→브리프→컨셉 다안 선택→스토리라인 다안 선택→plan 승인 게이트 · 감사 3겹",
    async () => {
      // 0) 부트스트랩 + 브리프 구간 통과(brief-flow 경로 압축).
      expect((await ingestBundle(BUNDLE, RID)).code).toBe(0);
      await run({ kind: "generate", run_id: RID, payload: { stage: "guideline" }, actor: ACTOR });
      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      await run({ kind: "generate", run_id: RID, payload: { stage: "brief" }, actor: ACTOR });
      await run({ kind: "approve", run_id: RID, payload: { ra_ok: true }, actor: ACTOR });
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      let na = await readNextAction(RID);
      expect(na.phase).toBe("02-concept");
      expect(na.action).toBe("generate");
      expect(na.stage).toBe("concept");

      // 1) 컨셉 생성 → 다안 선택 게이트(action=select · options·recommended).
      await run({ kind: "generate", run_id: RID, payload: { stage: "concept" }, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("02-concept");
      expect(na.action).toBe("select");
      expect(na.options.length).toBeGreaterThanOrEqual(2);
      expect(na.recommended).not.toBeNull();
      const conceptKey = na.recommended as string;

      // 1′) option-reader 가 실제 options-compare.md 를 파싱하고 추천 키 섹션을 찾는다(reader 회귀 · 오프라인).
      const conceptDoc = await readOptionsDoc(RID, "02-concept");
      expect(conceptDoc.sections.length).toBeGreaterThanOrEqual(2);
      expect(findSection(conceptDoc.sections, conceptKey)).toBeDefined();

      // 2) 추천 안 선택 → select.sh(--by ACTOR) → 심의 차례(select→review 순서).
      const sel = await run({ kind: "select", run_id: RID, payload: { option: conceptKey }, actor: ACTOR });
      expect(sel?.ok).toBe(true);
      na = await readNextAction(RID);
      expect(na.action).toBe("review");

      // 2′) 감사 겹2: 02-concept/decision.json 에 선택 키.
      const conceptDecision = JSON.parse(
        readFileSync(join(CORE, "runs", RID, "02-concept", "decision.json"), "utf8"),
      ) as { selected?: string };
      expect(conceptDecision.selected).toBe(conceptKey);

      // 3) 심의 → 03-storyboard outline 생성 차례 → outline 생성 → 다안 선택.
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("03-storyboard");
      expect(na.stage).toBe("storyboard-outline");
      await run({ kind: "generate", run_id: RID, payload: { stage: "storyboard-outline" }, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.action).toBe("select");
      expect(na.recommended).not.toBeNull();
      const outlineKey = na.recommended as string;

      // 3′) outline options-compare 파싱(헤더 "A — 전개 순서" 형식도 키로 매칭되는지).
      const outlineDoc = await readOptionsDoc(RID, "03-storyboard");
      expect(findSection(outlineDoc.sections, outlineKey)).toBeDefined();

      // 4) outline 선택 → 심의 → storyboard-plan 생성 → 승인 게이트.
      const sel2 = await run({ kind: "select", run_id: RID, payload: { option: outlineKey }, actor: ACTOR });
      expect(sel2?.ok).toBe(true);
      expect(existsSync(join(CORE, "runs", RID, "03-storyboard", "outline", "decision.json"))).toBe(true);
      await run({ kind: "review", run_id: RID, payload: {}, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.stage).toBe("storyboard-plan");
      await run({ kind: "generate", run_id: RID, payload: { stage: "storyboard-plan" }, actor: ACTOR });
      na = await readNextAction(RID);
      expect(na.phase).toBe("03-storyboard");
      expect(na.action).toBe("approve"); // plan 은 단안 승인 게이트

      // 5) 감사 겹1: state.json history 에 선택 행위자(chat:slack:U-e2e) 기록.
      const state = JSON.parse(readFileSync(join(CORE, "runs", RID, "state.json"), "utf8")) as {
        history: Array<{ actor?: string; event?: string }>;
      };
      expect(state.history.some((h) => h.actor === ACTOR)).toBe(true);
      // 선택 이벤트(select:*)가 감사에 남는지.
      expect(state.history.some((h) => (h.event ?? "").startsWith("select"))).toBe(true);
    },
    180_000,
  );
});
