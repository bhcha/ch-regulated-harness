/**
 * bridge-daemon-handoff.accept.test.ts — 인수 시나리오 ②: **Bridge 적재 ↔ 데몬 클레임·소비 핸드오프**(계획 점 4).
 *
 * 무엇을 덮나(오늘 빈 조합): 봇의 **BridgeGenExecutor 가 생성 잡을 적재**하고(손 적재 아님), **ConsumerDaemon 이
 *   그 잡을 클레임·소비**해 실 core stub 으로 전이시키며, 브리지가 **전이를 감지**해 resolve 한다 — 온라인 무인
 *   소비자 핸드오프의 정직한 오프라인 프록시.
 *
 * ── 정직한 경계(과대주장 금지 · 계획 함정 3·8) ─────────────────────────────────────
 *   · 오프라인 `createGateway` 는 `selectGenExecutor`=StubDirect 로 강제된다(pending 잡·브리지·데몬 없음) → **게이트웨이
 *     전 자동 루프(onOutcome)가 브리지를 굴리는 경로는 오프라인에서 재현 불가**(라이브/S5 관심사). 그래서 이 테스트는
 *     이음새(seam)에서 직접 Bridge+데몬을 붙여 핸드오프 **기전**만 결정론으로 못 박는다(consumer-daemon.e2e 결).
 *   · **실 `claude` 세션·실 supervisor spawn·실 신호는 뜨지 않는다**(오프라인 = stub 직접 · 라이브는 S5). 실 과금·
 *     세션 위생·nonce/ps 카나리는 이 프록시가 덮지 않는다.
 *   · enablement = **핸드오프하는 그 한 단계만** CHAT_SDK_STAGES 에 켠다(전 단계로 넓히지 않음 — "CI 에서만 되는 무인"
 *     금지 · 함정 8). 라이브 계약(intake·brief 는 데몬, 그 너머는 드라이버 운영자-동등)을 미러한다: 빈 examples →
 *     00g 생략 → 첫 생성 차례 = **brief**(= 라이브에서 데몬에 넘기는 단계).
 *
 * 격리: 전용 rid(chat-e2e-accept-bridge) + 전용 mktemp CHAT_JOBS_DIR/examples + afterAll 정리(consumer-daemon.e2e 미러).
 *   시계는 주입(벽시계 assert 없음 · 함정 6): **브리지 시계는 폴링마다 전진**해 데몬이 전이를 못 내면 유한 fake-time 에
 *   자기 마감(deadline)에 도달, 무한 폴링 대신 명확히 실패한다(Codex S4 리뷰 P2). 해피패스는 전이 감지가 마감보다
 *   훨씬 앞서라 영향 없다. **데몬 예산 검사는 별도 상수 시계 + 명시 budgetMs/startupMarginMs** 로 못 박아 ambient
 *   CHAT_SDK_GEN_TIMEOUT 에 의존하지 않는다(잡 만료 ~900s ≫ 예산 130s → 결정론 통과 · Codex S4 리뷰 P2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BridgeGenExecutor } from "../../src/kernel/gen-executor.js";
import { ConsumerDaemon } from "../../src/worker/cli-consumer.js";
import { ingestBundle } from "../../src/kernel/harness-cli.js";
import { readNextAction } from "../../src/kernel/contract-client.js";
import { isGenerateTurn } from "../../src/kernel/job-protocol.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(Bridge↔데몬 핸드오프) 생략");

const RID = "chat-e2e-accept-bridge";
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");
/** 주입 상수 시각(벽시계 assert 없음). 마감 = CLOCK + timeoutMs 라 전이 감지 전엔 만료되지 않는다. */
const CLOCK = 1_700_000_000_000;

let examplesDir: string;
let jobsDir: string;
const ls = (d: string): Promise<string[]> => readdir(d).then((n) => n.sort(), () => []);

/** pending 잡 파일이 적재될 때까지 대기(적재는 브리지 async 라 파일 등장을 폴링 · 실 타이머는 바운드용, assert 아님). */
async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pending 잡이 적재되지 않았습니다: ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(SKIP)("인수 시나리오 ②: Bridge 적재 → 데몬 클레임·소비 → 브리지 전이 감지", () => {
  beforeAll(async () => {
    // ⚠ env 는 데몬 생성 전에 모두 set(config 게터는 호출 시 env 를 읽는다 — 함정 5).
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    // 유형 선언 = env(ingest-bundle 부트스트랩 경로 · consumer-daemon.e2e 선례).
    process.env.HARNESS_DOMAIN = "cosmetic";
    process.env.HARNESS_FORMAT = "여러장"; // → multipage_bm(packs/_format)
    examplesDir = mkdtempSync(join(tmpdir(), "chat-accept-bridge-ex-")); // 빈 = 00g 생략 → 첫 생성 = brief
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    jobsDir = mkdtempSync(join(tmpdir(), "chat-accept-bridge-jobs-"));
    process.env.CHAT_JOBS_DIR = jobsDir;
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
    delete process.env.HARNESS_OFFLINE;
    delete process.env.HARNESS_DOMAIN;
    delete process.env.HARNESS_FORMAT;
    delete process.env.HARNESS_EXAMPLES_DIR;
    delete process.env.CHAT_JOBS_DIR;
    delete process.env.CHAT_SDK_STAGES;
  });

  it(
    "브리지가 적재한 생성 잡을 데몬이 클레임·소비 → core 전이 → 브리지 resolve · 잡 파일 정리",
    async () => {
      // 0) 부트스트랩: ingest-bundle 직접(run 생성 · consumer-daemon.e2e 경로) → 첫 생성 차례.
      const ing = await ingestBundle(BUNDLE, RID);
      expect(ing.code).toBe(0);

      // 1) 지금 무슨 단계 생성 차례인가(하드코딩 대신 next-action 이 진실). 빈 examples → brief(라이브 데몬 enablement).
      const na0 = await readNextAction(RID);
      expect(na0.step).toBe("generate");
      const stage = na0.stage as string;
      expect(typeof stage).toBe("string");
      expect(stage).toBe("brief"); // 00g 생략 → 첫 생성 = brief(intake·brief 라이브 계약 미러)

      // 2) 그 **한 단계만** 무인으로 켠다(전 단계로 넓히지 않음 — 함정 8). ⚠ 데몬 생성 전에 set.
      process.env.CHAT_SDK_STAGES = stage;

      // 브리지 시계는 폴링마다 전진 → 데몬이 전이를 못 내면 브리지가 유한 fake-time 에 자기 마감에 도달해 무한
      //   폴링 대신 명확히 실패한다(Codex S4 P2). 전진폭(200ms)×마감(900s) = ~4500 콜이라 해피패스(전이 감지가
      //   훨씬 앞섬)엔 큰 여유. 데몬 예산 검사는 별도 상수 시계로 안정(전진 시계와 무관).
      let clock = CLOCK;
      const bridgeNow = (): number => (clock += 200);
      const daemonNow = (): number => CLOCK;
      const pendingDir = join(jobsDir, "pending");
      const claimedDir = join(jobsDir, "claimed");

      // 3) 봇의 BridgeGenExecutor — pending 에 잡을 적재하고 전이를 폴링한다(주입 seam: fast sleep · 전진 now ·
      //    실 readNext · 임시 잡 디렉터리). 실 셸/세션 spawn 0(파일 큐 + next-action 폴링만).
      const bridge = new BridgeGenExecutor({
        readNext: readNextAction,
        jobsPendingDir: pendingDir,
        jobsClaimedDir: claimedDir,
        pollIntervalMs: 100,
        timeoutMs: 900_000, // 마감 = 첫 now + 900_000 → 데몬 예산 검사 통과 + 전이 전 미만료(실패 시 유한 콜 후 마감)
        sleep: (): Promise<void> => new Promise((r) => setTimeout(r, 15)),
        now: bridgeNow,
      });

      // 4) 무인 데몬(오프라인 = makeStubRunJob 자동 선택 · 실 CLI 0). 상수 now + **명시 예산**으로 예산 검사를 못 박는다
      //    → ambient CHAT_SDK_GEN_TIMEOUT 에 의존하지 않는다(잡 만료 ~900s ≫ 130s → 결정론 통과 · Codex S4 P2).
      const daemon = new ConsumerDaemon({ now: daemonNow, log: () => {}, budgetMs: 120_000, startupMarginMs: 10_000 });

      // 5) 동시 구동: 브리지 execute(적재 → 폴링) ∥ 데몬 consumeOne(클레임 → stub 소비 → 전이).
      const bridgePromise = bridge.execute(RID, stage);
      // 실패/teardown 경합 시 브리지의 늦은 rejection 이 unhandled 로 새지 않게 흡수(성공 감지는 아래 race 로 await).
      void bridgePromise.catch(() => {});
      await waitForFile(join(pendingDir, `${RID}-${stage}.json`)); // 브리지가 적재할 때까지
      const outcome = await daemon.consumeOne();

      // 6) 데몬 소비 검증 — 클레임하고 stub 로 완주했다.
      expect(outcome?.action).toBe("claimed");
      expect(outcome?.ok).toBe(true);

      // 7) 브리지가 전이를 감지해 resolve(무한대기 방지 안전 바운드 — 실패면 명확한 에러).
      await Promise.race([
        bridgePromise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("브리지가 전이를 감지하지 못했습니다(핸드오프 실패)")), 60_000),
        ),
      ]);

      // 8) 잡 파일 정리: 성공 → pending·claimed 모두 비었다(데몬 completeJob + 브리지 cleanupPendingJob).
      expect(await ls(pendingDir)).toEqual([]);
      expect(await ls(join(claimedDir, "daemon"))).toEqual([]);

      // 9) core 가 전이했다 — 그 단계 생성 차례가 더는 아니다(브리지·데몬이 같은 판정을 공유).
      const na1 = await readNextAction(RID);
      expect(isGenerateTurn(na1, stage)).toBe(false);
    },
    120_000,
  );
});
