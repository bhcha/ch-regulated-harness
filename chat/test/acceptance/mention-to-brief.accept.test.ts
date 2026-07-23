/**
 * mention-to-brief.accept.test.ts — 첫 인수 시나리오(nl-flow 확장 · 멘션 → 브리프 승인).
 *
 * 실 게이트웨이(SurfaceDriver → createGateway)에 기록형 포트를 물려 실 core stub 을 구동한다(HARNESS_OFFLINE=1):
 *   자연어 멘션 → NlProposal([시작]) → new-run → 인입 게이트 → 스테이징 인입 → **자동 이어가기**로 브리프 생성 →
 *   브리프 승인(+RA 확인) → 심의 통과 → 02-concept 다안 도달. nl-flow(IngestPrompt 에서 멈춤)의 빠진 구간을 완주한다.
 *
 * 통합 계층 규약(nl-flow/brief-flow 미러): core 경로는 env HARNESS_ROOT 로 주입, 미주입이면 '보이게' 생략
 *   (console.warn + describe.skipIf — 조용한 통과 금지). vitest.accept.config.ts(=pnpm test:accept)로만 돈다.
 *
 * 격리·함정 회피(계획 6 · 리포 메모리):
 *   · 전용 CHAT_STATE_DIR/CHAT_DATA_DIR(mktemp) + 전용 rid(chat-e2e-accept-brief) + afterAll 정리.
 *   · **빈** HARNESS_EXAMPLES_DIR(cosmetic 하위 없음) → 00g-guideline 생략 → 곧장 01-brief(00g 금지토큰 stall 회피 ·
 *     ci-examples 오염 함정 회피). bundle-cosmetic = brief 를 통과시키는 sanctioned 픽스처(brief-flow 선례).
 *   · WB = packs/cosmetic/samples/working-backwards.md(ingest-bundle 의 기본 WB · 빈 템플릿) 를 임시로 스테이징 —
 *     게이트웨이 인입은 stagedWbPath 가 있어야 fail-closed 를 통과한다. 내용은 brief-flow 의 기본 WB 와 동일.
 *   · CHAT_APPROVERS = actor user id — 워커(createGateway 내부 · config.isApprover)가 approve 잡을 거부하지 않게.
 *   · env 는 게이트웨이 생성 **전에** set(config 게터는 호출 시 env 를 읽는다 — 계획 함정 5).
 *
 * oracle 순환 금지(계획 2-1): 기대 화면을 production presentationForNext 재실행으로 계산하지 않는다 —
 *   폐쇄 속성 + core 자신의 next-action(phase/action) 웨이포인트만 assert 한다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SurfaceDriver } from "../../src/acceptance/driver.js";
import { analyze } from "../../src/acceptance/analyzer.js";
import { makeRunId } from "../../src/kernel/flow.js";
import { writeTranscriptArtifact } from "./support.js";

const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
const SKIP = CORE === "";
if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(mention→brief) 생략");

const THREAD = "e2e-accept-brief";
const RID = makeRunId(THREAD); // "chat-e2e-accept-brief"
const ACTOR = "chat:accept:U-accept-brief";
const APPROVER_UID = "U-accept-brief"; // actorUserId(ACTOR) — CHAT_APPROVERS 매칭
// 완결 자연어 선언(nl-flow 미러: 화장품·여러장·따옴표 제품명) → NlProposal(setup) + [시작] 확정.
const MENTION = '화장품이고 여러장이야, 제품명은 "인수브리프테스트"';
const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");
// ingest-bundle 의 기본 WB(빈 템플릿 · packs) — 게이트웨이 인입에 스테이징한다.
const SAMPLE_WB = SKIP ? "" : resolve(CORE, "..", "packs/cosmetic/samples/working-backwards.md");

let stateDir: string;
let dataDir: string;
let examplesDir: string;
let wbDir: string;
let stagedWb: string;
let driver: SurfaceDriver;

describe.skipIf(SKIP)("인수 시나리오: 멘션 → 브리프 승인 → 02-concept(게이트웨이 → core stub)", () => {
  beforeAll(() => {
    // ⚠ 게이트웨이/드라이버 생성 전에 env 를 모두 set(config 게터는 호출 시 env 를 읽는다 — 계획 함정 5).
    process.env.HARNESS_OFFLINE = "1";
    process.env.HARNESS_ROOT = CORE;
    process.env.CHAT_APPROVERS = APPROVER_UID;
    stateDir = mkdtempSync(join(tmpdir(), "chat-accept-brief-state-"));
    dataDir = mkdtempSync(join(tmpdir(), "chat-accept-brief-data-"));
    examplesDir = mkdtempSync(join(tmpdir(), "chat-accept-brief-ex-")); // 빈 = 00g 생략
    wbDir = mkdtempSync(join(tmpdir(), "chat-accept-brief-wb-"));
    process.env.CHAT_STATE_DIR = stateDir;
    process.env.CHAT_DATA_DIR = dataDir;
    process.env.HARNESS_EXAMPLES_DIR = examplesDir;
    // WB 스테이징 — ingest-bundle 의 기본 WB(빈 템플릿) 복사. 없으면 동등한 최소 빈 템플릿 작성
    //   (claim-basis 는 근거 없음 → unknown = 환각 안전 · brief-flow 의 기본 WB 와 동일 거동).
    stagedWb = join(wbDir, "working-backwards.md");
    if (existsSync(SAMPLE_WB)) cpSync(SAMPLE_WB, stagedWb);
    else writeFileSync(stagedWb, "# 워킹백워드\n\n제품유형:\n타깃:\n핵심 효능(+근거):\n차별점:\n사용법:\n");
    rmSync(join(CORE, "runs", RID), { recursive: true, force: true });

    driver = new SurfaceDriver({ bundleDir: BUNDLE, stagedWbPath: stagedWb, actor: ACTOR, stateDir });
  });

  afterAll(() => {
    // 트랜스크립트 아티팩트(opt-in · CHAT_ACCEPT_ARTIFACT_DIR 있을 때만 — verify.sh 가 set). 정리 전에 떨군다.
    writeTranscriptArtifact("mention-to-brief", driver.transcript.toJSONL());
    // macOS ENOTEMPTY 내성: 실패하면 한 번 재시도(다른 e2e 패턴).
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
    rm(stateDir);
    rm(dataDir);
    rm(examplesDir);
    rm(wbDir);
    delete process.env.HARNESS_OFFLINE;
    delete process.env.CHAT_STATE_DIR;
    delete process.env.CHAT_DATA_DIR;
    delete process.env.HARNESS_EXAMPLES_DIR;
    delete process.env.CHAT_APPROVERS;
  });

  it(
    "멘션 → NlProposal → 인입 → 자동 브리프 생성 → 브리프 승인 → 02-concept · 폐쇄 속성 assert",
    async () => {
      // 1) 자연어 멘션(완결 선언).
      await driver.mention(THREAD, MENTION);
      const proposal = driver.presentations().find((p) => p.type === "NlProposal");
      expect(proposal).toBeDefined();

      // 2) auto-happy 로 브리프 승인 게이트까지 구동(NlProposal 확정 → 인입 → 자동 브리프 생성).
      const briefGate = await driver.runToGate(
        (p, na) => p?.type === "ApproveGate" && na?.phase === "01-brief",
      );
      // (c) 브리프 승인 게이트에 스텝 예산 안에서 도달.
      expect(briefGate.reached).toBe(true);
      expect(driver.budgetExhausted).toBe(false);

      // 웨이포인트(core 자신의 산출물): 인입 게이트를 지나왔고, run 이 실제로 생겼다.
      expect(driver.presentations().some((p) => p.type === "IngestPrompt")).toBe(true);
      expect(existsSync(join(CORE, "runs", RID, "state.json"))).toBe(true);
      expect(await driver.runId()).toBe(RID);

      // 웨이포인트: 브리프 승인 차례임을 core next-action 이 직접 말한다(매퍼 재실행 아님).
      const naAtGate = await driver.readNa();
      expect(naAtGate?.phase).toBe("01-brief");
      expect(naAtGate?.action).toBe("approve");

      // 3) 승인(+RA 확인) 후 02-concept 로 전진할 때까지 auto-happy 구동.
      const conceptGate = await driver.runToGate((_p, na) => na?.phase === "02-concept");
      // (b) 발화가 na 를 전진시켰다(01-brief → 02-concept).
      expect(conceptGate.reached).toBe(true);
      const finalNa = await driver.readNa();
      expect(finalNa?.phase).toBe("02-concept");

      // 심의가 실제로 돌아 통과했다(Verdict pass 렌더).
      expect(
        driver.presentations().some((p) => p.type === "Verdict" && p.outcome === "pass"),
      ).toBe(true);

      // 4) 정지.
      await driver.quiesce();

      // (e) Failure/막다른 화면 0 — Failure 화면이 하나도 없다.
      expect(driver.presentations().some((p) => p.type === "Failure")).toBe(false);

      // (f) 정지 후 잡 잔존 0.
      expect(driver.activeRuns).toBe(0);

      // (d) 분석기 발견 0(failure·dead-end·stuck·job-residue·unknown 모두 없음).
      const findings = analyze({
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa,
      });
      expect(findings).toEqual([]);

      // (a) 렌더된 인터랙티브 화면들이 커널에 수용됐다(드라이버가 발화하며 완주 · 예외 0). runToGate 가
      //     예외 없이 도달했다는 사실이 그 증거다(위 briefGate/conceptGate.reached).

      // (g) 감사 체인: state.json history 에 드라이버 actor 가 기록됐다(--by 로 승인).
      const state = JSON.parse(readFileSync(join(CORE, "runs", RID, "state.json"), "utf8")) as {
        history: Array<{ actor?: string }>;
      };
      expect(state.history.some((h) => h.actor === ACTOR)).toBe(true);
    },
    180_000,
  );
});
