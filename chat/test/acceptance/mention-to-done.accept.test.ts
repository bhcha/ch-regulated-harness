/**
 * mention-to-done.accept.test.ts — 인수 시나리오 ①: **멘션 → done 완주(봇의 자동 이어가기 실검증)**.
 *
 * 실 게이트웨이(SurfaceDriver → createGateway) + 실 core stub(HARNESS_OFFLINE=1)로 표면 흐름을 **끝까지** 몬다:
 *   완결 자연어 멘션 → NlProposal([시작]) → 인입 게이트 → 스테이징 인입 → **자동 이어가기**(brief 생성 →
 *   승인+RA → 심의 → concept 다안 → 선택 → storyboard outline/plan 다안·승인 → keyvisual 이미지 다안 →
 *   선택 → 최종 승인 → 심의 → done). auto-happy 드라이버가 매 게이트를 결정론으로 통과한다.
 *   계획 1단계의 빈 구간(자동 review/generate 캐스케이드가 실 core 를 끝까지 끄는 루프)을 완주로 덮는다.
 *
 * ── 시간 예산(계획 함정 7) ──────────────────────────────────────────────────────
 *   이 시나리오는 **느리다**: keyvisual generate 는 오프라인 stub 에서도 옵션 HTML 을 Playwright 로 렌더한다
 *   (기존 keyvisual-flow.e2e 실측 ~360초). 그래서 testTimeout=600_000. **통합-전용**(다른 인수 시나리오처럼
 *   빠르게 못 돈다)이라는 사실 자체가 계획이 예고한 분업이다(빠른 구조 커버 = 비-keyvisual 시나리오; 완주 = 이 1건).
 *   format="여러장"→multipage_bm(packs/_format), keyvisual-flow.e2e 와 같은 무거운 경로.
 *
 * 격리·함정 회피: 전용 rid(chat-e2e-accept-done) + 전용 mktemp dirs + 빈 examples(00g 생략) + afterAll 정리
 *   (support.setupDriverHarness = S2 미러). oracle 순환 금지: 웨이포인트는 core next-action(readNa)에서 읽고,
 *   폐쇄 속성(완주·발견 0·잡 잔존 0·감사 체인)만 assert 한다(프로덕션 매퍼 재실행 아님).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SurfaceDriver } from "../../src/acceptance/driver.js";
import { analyze } from "../../src/acceptance/analyzer.js";
import { makeRunId } from "../../src/kernel/flow.js";
import { BUNDLE, CORE, setupDriverHarness, SKIP, writeTranscriptArtifact, type TempHarness } from "./support.js";

if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(mention→done) 생략");

const THREAD = "e2e-accept-done";
const RID = makeRunId(THREAD); // "chat-e2e-accept-done"
const ACTOR = "chat:accept:U-done";
const APPROVER_UID = "U-done";
const MENTION = '화장품이고 여러장이야, 제품명은 "인수완주테스트"';

let h: TempHarness;
let driver: SurfaceDriver;

describe.skipIf(SKIP)("인수 시나리오 ①: 멘션 → done 완주(게이트웨이 자동 이어가기 → core stub)", () => {
  beforeAll(() => {
    h = setupDriverHarness("chat-accept-done", APPROVER_UID);
    driver = new SurfaceDriver({ bundleDir: BUNDLE, stagedWbPath: h.stagedWb, actor: ACTOR, stateDir: h.stateDir });
  });

  afterAll(() => {
    // 트랜스크립트 아티팩트(opt-in · verify.sh 가 CHAT_ACCEPT_ARTIFACT_DIR set 했을 때만; 그 외 no-op).
    writeTranscriptArtifact("mention-to-done", driver.transcript.toJSONL());
    h.cleanup(RID);
  });

  it(
    "완결 멘션 → 자동 이어가기로 전 파이프라인 완주(done) · 폐쇄 속성 + core next-action 웨이포인트 assert",
    async () => {
      // 1) 완결 자연어 멘션 → NlProposal(setup · [시작] 버튼).
      await driver.mention(THREAD, MENTION);
      expect(driver.presentations().some((p) => p.type === "NlProposal")).toBe(true);

      // 2) auto-happy 로 done 까지 완주(모든 게이트를 드라이버가 통과 — 자동 review/generate 캐스케이드가 실 core 구동).
      const done = await driver.runToDone();

      // (c) done 종단에 스텝 예산 안에서 도달(예산 소진 아님).
      expect(done.reached).toBe(true);
      expect(done.reason).toBe("predicate");
      expect(driver.budgetExhausted).toBe(false);
      // 마지막 화면이 Done.
      expect(done.final?.type).toBe("Done");
      expect(driver.latestPresentation()?.type).toBe("Done");

      // 웨이포인트(core 자신의 산출물): run 이 실제로 생겼고 이 스레드가 그 run 을 가리킨다.
      expect(existsSync(join(CORE, "runs", RID, "state.json"))).toBe(true);
      expect(await driver.runId()).toBe(RID);

      // 웨이포인트: core next-action 이 '완료(done)'라고 직접 말한다(매퍼 재실행 아님).
      const finalNa = await driver.readNa();
      expect(finalNa?.action).toBe("done");

      // 웨이포인트: 실제 파이프라인 페이즈들을 지나왔다 — **기록된 화면들이 가리키는 core phase 집합**으로 확인한다
      //   (화면 rid/phase 는 core na 에서 온 passthrough라 재계산이 아니다). 인입 게이트 → brief 승인 → concept/
      //   storyboard 다안 → keyvisual 이미지 다안 → 완료.
      const types = new Set(driver.presentations().map((p) => p.type));
      expect(types.has("IngestPrompt")).toBe(true); // 00-ingest 게이트
      expect(types.has("ApproveGate")).toBe(true); //   01-brief(+ keyvisual 최종) 단안 승인
      expect(types.has("OptionSet")).toBe(true); //     02-concept·03-storyboard 다안
      expect(types.has("ImageOptionSet")).toBe(true); // 04-keyvisual 이미지 다안
      expect(types.has("Done")).toBe(true);
      // 실제 심의가 돌아 통과했다(Verdict pass 렌더가 최소 1회).
      expect(driver.presentations().some((p) => p.type === "Verdict" && p.outcome === "pass")).toBe(true);
      // keyvisual 은 04-keyvisual phase 의 ImageOptionSet 으로 도달했다(core na.phase passthrough).
      expect(
        driver.presentations().some((p) => p.type === "ImageOptionSet" && p.phase === "04-keyvisual"),
      ).toBe(true);

      // 3) 정지 후 폐쇄 속성.
      await driver.quiesce();
      // (f) 잡 잔존 0.
      expect(driver.activeRuns).toBe(0);
      // (e) Failure 화면 0.
      expect(driver.presentations().some((p) => p.type === "Failure")).toBe(false);

      // (d) 분석기 발견 0(failure·dead-end·stuck·job-residue·unknown 모두 없음 — 깨끗한 happy 완주).
      const findings = analyze({
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa,
      });
      expect(findings).toEqual([]);

      // (g) 감사 체인: state.json history 에 드라이버 actor 가 기록됐다(승인/선택을 --by 로).
      const state = JSON.parse(readFileSync(join(CORE, "runs", RID, "state.json"), "utf8")) as {
        history: Array<{ actor?: string }>;
      };
      expect(state.history.some((hh) => hh.actor === ACTOR)).toBe(true);
    },
    600_000,
  );
});
