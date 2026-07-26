/**
 * non-happy-generate-retry.accept.test.ts — 인수 시나리오 ③-[다시 만들기](GenerateRetry): **브리지 회수 → 상태 재확인 → 재요청**.
 *
 * [다시 만들기] 는 브리지 회수 경로에서 태어난다: 봇이 대기 중 생성 잡의 상한을 넘겨 **아직 아무도 안 집은 잡을
 *   회수**하면, core 는 여전히 그 단계 생성 차례라 사람이 [상태 다시 확인]을 눌렀을 때 GenerateRetry 카드가 나오고,
 *   그 [다시 만들기]가 **새 마감의 새 요청**을 적재한다. 이 시나리오는 두 조각을 잇는다:
 *   ① **실 브리지 회수**: BridgeGenExecutor(작은 timeout · 주입 advancing now · fast sleep · 임시 잡 디렉터리)가
 *      execute 에서 마감 초과 → **아직 pending 인 자기 잡을 회수**(recallPendingJob)하고 timeout 에러로 종료한다.
 *   ② **재확인 → GenerateRetry 라우팅(seam)**: 회수 뒤 core 는 그대로 그 단계 생성 차례다. createGateway 로 스레드를
 *      그 run 에 묶고 [상태 다시 확인](reconcile)을 fire → GenerateRetry 렌더 → [다시 만들기](generate-retry) affordance 를
 *      추출기에서 골라 fire → **새 생성 요청 적재**(onAction 반환 enqueued.kind=generate).
 *
 * ── 정직한 경계(계획 · 과대주장 금지) ─────────────────────────────────────────────
 *   오프라인 `createGateway` 는 StubDirect 를 강제하므로 **게이트웨이 onOutcome 루프가 브리지를 굴려 Failure→[상태
 *   다시 확인]→GenerateRetry 로 잇는 전 경로는 오프라인에서 재현 불가**(라이브/S5). 그래서 브리지 회수(①)는 실제로
 *   구동하고, reconcile→GenerateRetry→generate-retry 라우팅(②)은 커널 진입점(createGateway + onAction)에서 직접
 *   검증한다 — production 과 **같은 커널 라우팅**이되 라이브 브리지 타임아웃이 같은 인스턴스에서 촉발하는 건 아니다.
 *
 * 격리: 전용 rid(chat-e2e-accept-retry) + 임시 잡/state 디렉터리 + 빈 examples + afterAll 정리. keyvisual 전이라 빠르다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BridgeGenExecutor } from "../../src/kernel/gen-executor.js";
import { ingestBundle } from "../../src/kernel/harness-cli.js";
import { readNextAction } from "../../src/kernel/contract-client.js";
import { isGenerateTurn, jobFileName } from "../../src/kernel/job-protocol.js";
import { createGateway, onAction } from "../../src/kernel/flow.js";
import { GENERATE_RETRY_ACTION_ID, RECONCILE_ACTION_ID } from "../../src/kernel/interaction.js";
import { RecordChatPort } from "../../src/acceptance/recording-port.js";
import { affordancesOf } from "../../src/acceptance/affordances.js";
import type { ButtonPressed } from "../../src/kernel/events.js";
import type { GenerateRetryPresentation } from "../../src/kernel/presentation.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오([다시 만들기]/GenerateRetry) 생략");

const RID = "chat-e2e-accept-retry";
const THREAD = "e2e-accept-retry";
const ACTOR = "chat:accept:U-retry";
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");
const CLOCK = 1_700_000_000_000;

let examplesDir: string;
let jobsDir: string;
let stateDir: string;

describe.skipIf(SKIP)("인수 시나리오 ③: 브리지 회수 → [상태 다시 확인] → GenerateRetry → [다시 만들기] 재요청", () => {
  beforeAll(async () => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "여러장";
    examplesDir = mkdtempSync(join(tmpdir(), "chat-accept-retry-ex-")); // 빈 = 00g 생략 → brief
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    jobsDir = mkdtempSync(join(tmpdir(), "chat-accept-retry-jobs-"));
    stateDir = mkdtempSync(join(tmpdir(), "chat-accept-retry-state-"));
    await mkdir(join(jobsDir, "pending"), { recursive: true });
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
  });

  afterAll(() => {
    const rm = (p: string): void => {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    };
    rm(join(CORE, "runs", RID));
    rm(examplesDir);
    rm(jobsDir);
    rm(stateDir);
    delete process.env.HARNESS_OFFLINE;
    delete process.env.HARNESS_DOMAIN;
    delete process.env.HARNESS_FORMAT;
    delete process.env.HARNESS_EXAMPLES_DIR;
  });

  it(
    "브리지가 미클레임 잡을 회수(timeout) → core 그대로 생성 차례 → reconcile=GenerateRetry → generate-retry=재적재",
    async () => {
      // 0) 부트스트랩 → 첫 생성 차례(brief).
      const ing = await ingestBundle(BUNDLE, RID);
      expect(ing.code).toBe(0);
      const na0 = await readNextAction(RID);
      expect(na0.step).toBe("generate");
      const stage = na0.stage as string;
      expect(stage).toBe("brief");

      // ── ① 실 브리지 회수 ───────────────────────────────────────────────────────
      const pendingDir = join(jobsDir, "pending");
      const claimedDir = join(jobsDir, "claimed");
      // advancing now: enqueue 시각 직후 곧장 마감 초과가 되도록(주입 시계 · 벽시계 assert 없음).
      let clock = CLOCK;
      const now = (): number => (clock += 10_000);
      const bridge = new BridgeGenExecutor({
        readNext: readNextAction,
        jobsPendingDir: pendingDir,
        jobsClaimedDir: claimedDir,
        pollIntervalMs: 10,
        timeoutMs: 1, // 적재 직후 곧장 마감 초과 → 회수
        sleep: (): Promise<void> => Promise.resolve(),
        now,
      });
      // 소비자가 없으므로 자기 잡을 회수하고 timeout 에러로 끝난다.
      await expect(bridge.execute(RID, stage)).rejects.toThrow(/대기 시간 초과/);
      // 회수됨: pending 잡 파일이 사라졌다.
      expect(existsSync(join(pendingDir, jobFileName(RID, stage)))).toBe(false);

      // 회수는 core 를 전이시키지 않는다 — 여전히 그 단계 생성 차례다(GenerateRetry 의 전제).
      const naStill = await readNextAction(RID);
      expect(isGenerateTurn(naStill, stage)).toBe(true);

      // ── ② reconcile → GenerateRetry → generate-retry 라우팅(커널 seam) ──────────
      const chat = new RecordChatPort();
      const gw = createGateway({
        chat,
        isApprover: () => true,
        readSurface: async () => null,
        stateDir,
      });
      await gw.map.bindThreadToRun(THREAD, RID);

      // [상태 다시 확인](reconcile) fire — 생성 차례라 GenerateRetry 카드가 나와야 한다(읽기 전용 · 잡 0).
      const reconcileEvent: ButtonPressed = {
        type: "button",
        actionId: RECONCILE_ACTION_ID,
        value: JSON.stringify({ run_id: RID, action: "reconcile" }),
        actor: ACTOR,
        threadId: THREAD,
      };
      await onAction(reconcileEvent, gw);
      await gw.queue.drain();

      const genRetry = chat
        .renders()
        .map((r) => r.presentation)
        .find((p): p is GenerateRetryPresentation => p.type === "GenerateRetry");
      expect(genRetry).toBeDefined();
      expect(genRetry!.stage).toBe(stage);
      expect(gw.queue.activeRuns).toBe(0); // reconcile 은 잡을 만들지 않는다(읽기 전용)

      // [다시 만들기](generate-retry) affordance 를 추출기에서 골라 fire → 새 생성 요청 적재.
      const retryBtn = (affordancesOf(genRetry!, { actor: ACTOR, threadId: THREAD }) as ButtonPressed[]).find(
        (a) => a.actionId === GENERATE_RETRY_ACTION_ID,
      );
      expect(retryBtn).toBeDefined();
      const res = await onAction(retryBtn!, gw);
      // 재요청이 적재됐다(fresh generate 잡).
      expect(res?.enqueued?.kind).toBe("generate");
      expect(res?.enqueued?.payload?.stage).toBe(stage);
      // "다시 요청했어요…" 진행 안내가 떴다.
      expect(
        chat.renders().some((r) => r.presentation.type === "Progress" && (r.presentation as { message: string }).message.includes("다시 요청했어요")),
      ).toBe(true);

      // 적재된 생성 잡을 stub 이 처리하도록 정지 대기 → 잡 잔존 0.
      await gw.queue.drain();
      expect(gw.queue.activeRuns).toBe(0);

      // 재요청이 **실행되어 run 을 전진**시켰음을 증명한다 — enqueue·activeRuns=0 만으론 부족하다(워커는 실패도
      //   outcome 으로 바꿔 drain 이 resolve 되고 activeRuns 가 0 이 되므로, 재생성이 Failure 로 끝나도 위 단언은 통과한다).
      //   그 단계 생성 차례를 벗어났고(전이 성공) 실패 카드가 없어야 재요청이 진짜 성공한 것이다(외부리뷰 S3 P2).
      const naAfter = await readNextAction(RID);
      expect(isGenerateTurn(naAfter, stage)).toBe(false); // 그 단계 생성 차례를 벗어남 = 재생성 전이 성공
      expect(chat.renders().some((r) => r.presentation.type === "Failure")).toBe(false); // 실패로 끝나지 않았다
    },
    120_000,
  );
});
