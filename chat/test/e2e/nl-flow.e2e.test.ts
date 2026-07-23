/**
 * nl-flow.e2e.test.ts — 게이트웨이 레벨 stub E2E(자연어 시작 · P3-1).
 *
 * 자연어 멘션 → NlProposal(설정 확인) → 확정 버튼([시작]) → new-run 으로 run 생성 → 인입 게이트(IngestPrompt) 도달까지.
 *   실제 커널(createGateway)에 fake ChatPort 를 물려 실 core(new-run·next-action)를 구동한다(HARNESS_OFFLINE=1 → NL 은 결정적
 *   StubNlParser). Slack 표면 0 — 중립 이벤트/표현만 본다.
 *
 * 통합(integration) 계층: core 경로는 env HARNESS_ROOT 로 **주입**(형제경로 유도 폐기 — 리포지토리 분리 대비). 미주입이면
 *   스위트를 '보이게' 생략한다(console.warn + describe.skipIf). vitest.e2e.config.ts(=pnpm test:integration)로만 돈다.
 *   격리: 전용 CHAT_STATE_DIR/CHAT_DATA_DIR(mktemp) + 전용 rid + afterAll 정리(chat 상태·core runs 오염 없음).
 *
 * 범위: P3-1(시작)만 E2E 로 완주. P3-2(파일 인입)의 파서·allowlist·스냅샷은 단위 테스트가 덮고, 실제 intake.sh spawn +
 *   PDF 파이프라인은 오프라인 미검증(S-3 경계 — intake-files.ts 문서 참조).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGateway, makeRunId, onAction, onMention } from "../../src/kernel/flow.js";
import { SETUP_ACTION_IDS } from "../../src/kernel/interaction.js";
import { readNextAction } from "../../src/kernel/contract-client.js";
import type { ChatPort } from "../../src/kernel/ports.js";
import type { Presentation } from "../../src/kernel/presentation.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 통합 E2E(nl) 생략");

const THREAD = "nl-e2e";
const RID = makeRunId(THREAD); // "chat-nl-e2e"
const ACTOR = "chat:slack:U-e2e";

let stateDir: string;
let dataDir: string;
const renders: Array<{ threadId: string; p: Presentation }> = [];

describe.skipIf(SKIP)("자연어 시작 stub E2E(게이트웨이 → core)", () => {
  beforeAll(() => {
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    stateDir = mkdtempSync(join(tmpdir(), "chat-e2e-nl-state-"));
    dataDir = mkdtempSync(join(tmpdir(), "chat-e2e-nl-data-"));
    process.env.CHAT_STATE_DIR = stateDir;
    process.env.CHAT_DATA_DIR = dataDir;
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.HARNESS_OFFLINE;
    delete process.env.CHAT_STATE_DIR;
    delete process.env.CHAT_DATA_DIR;
  });

  it(
    "NL 멘션 → NlProposal(setup, [시작]) → 확정 → run 생성 → 인입 게이트(IngestPrompt) 도달",
    async () => {
      const chat: ChatPort = {
        render: async (threadId, p) => void renders.push({ threadId, p }),
        subscribe: async () => {},
        capabilities: () => ({ imageDelivery: "upload" }),
      };
      // 실 커널: new-run·next-action 은 실제 core spawn · NL 은 오프라인 StubNlParser(selectNlParser 자동).
      const gw = createGateway({ chat });

      // 1) 자연어 멘션(완결 선언) → NlProposal(setup) with [시작].
      await onMention(
        { type: "mention", threadId: THREAD, actor: ACTOR, text: '화장품이고 여러장이야, 제품명은 "이지듀시카세럼"' },
        gw,
      );
      const proposal = renders.find((r) => r.p.type === "NlProposal");
      expect(proposal).toBeDefined();
      const np = proposal!.p as Extract<Presentation, { type: "NlProposal" }>;
      expect(np.kind).toBe("setup");
      expect(np.confirm?.actionId).toBe(SETUP_ACTION_IDS.start);

      // 2) [시작] 버튼 → new-run(실 spawn) → 스레드 바인딩 → pending=wb → IngestPrompt.
      await onAction({ type: "button", actionId: SETUP_ACTION_IDS.start, actor: ACTOR, threadId: THREAD }, gw);

      // run 이 실제로 생겼는지(core state.json) + 스레드↔run 매핑.
      expect(existsSync(join(CORE, "runs", RID, "state.json"))).toBe(true);
      expect(await gw.map.runForThread(THREAD)).toBe(RID);

      // 인입 게이트에 도달(IngestPrompt 표현 + next-action=ingest).
      expect(renders.some((r) => r.p.type === "IngestPrompt")).toBe(true);
      const na = await readNextAction(RID);
      expect(na.action).toBe("ingest");
      expect(na.phase).toBe("00-ingest");
    },
    120_000,
  );
});
