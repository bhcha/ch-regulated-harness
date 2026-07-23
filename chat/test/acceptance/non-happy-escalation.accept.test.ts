/**
 * non-happy-escalation.accept.test.ts — 인수 시나리오 ③-에스컬레이션: **보완 반복이 상한에 닿으면 Escalation → [한 번 더]**.
 *
 * 실 게이트웨이 + core stub 로 브리프 승인 게이트에서 [보완]+답글을 **반복**해 core 의 보완 상한(max_iterations)을
 *   실측으로 소진시킨다 → core next-action 이 action:"raise-limit" 로 전환 → 게이트웨이가 Escalation 화면을 낸다 →
 *   affordancesOf 로 [한 번 더 시도](raise-limit) affordance 를 골라 fire → 상한 상향 후 재생성으로 게이트 복귀.
 *   상한은 **하드코딩하지 않고** 매 루프 core na 에서 읽어 도달할 때까지 돈다(계획: 경험적 발견). keyvisual 전이라 빠르다.
 *
 * 분석기 기대(계획 "발견은 기대와 일치"): 이 시나리오는 **의도적으로 같은 게이트를 반복**하므로 분석기가 그걸 stuck 으로
 *   잡는 것이 **정답**이다 — 그래서 발견은 stuck 종류만 허용하고(실패·막다른·미지·잔존 0), Escalation 도달·복구를 assert 한다.
 *
 * oracle 순환 금지: 상한 도달·복구는 core na(readNa)에서 읽는다. 격리: 전용 rid(chat-e2e-accept-esc) + 빈 examples + afterAll 정리.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurfaceDriver } from "../../src/acceptance/driver.js";
import { analyze } from "../../src/acceptance/analyzer.js";
import { affordancesOf } from "../../src/acceptance/affordances.js";
import { makeRunId } from "../../src/kernel/flow.js";
import type { ButtonPressed } from "../../src/kernel/events.js";
import { BUNDLE, setupDriverHarness, SKIP, writeTranscriptArtifact, type TempHarness } from "./support.js";

if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(에스컬레이션) 생략");

const THREAD = "e2e-accept-esc";
const RID = makeRunId(THREAD); // "chat-e2e-accept-esc"
const ACTOR = "chat:accept:U-esc";
const APPROVER_UID = "U-esc";
const MENTION = '화장품이고 여러장이야, 제품명은 "인수한도테스트"';
/** 보완 반복 상한(경험적 — core max_iterations 는 그보다 작아 그 안에 에스컬레이션에 닿는다). */
const REVISE_BUDGET = 8;

let h: TempHarness;
let driver: SurfaceDriver;

describe.skipIf(SKIP)("인수 시나리오 ③: 에스컬레이션(보완 상한 소진 → Escalation → [한 번 더] fire → 복구)", () => {
  beforeAll(() => {
    h = setupDriverHarness("chat-accept-esc", APPROVER_UID);
    driver = new SurfaceDriver({ bundleDir: BUNDLE, stagedWbPath: h.stagedWb, actor: ACTOR, stateDir: h.stateDir });
  });

  afterAll(() => {
    // 트랜스크립트 아티팩트(opt-in · verify.sh 가 CHAT_ACCEPT_ARTIFACT_DIR set 했을 때만; 그 외 no-op).
    writeTranscriptArtifact("non-happy-escalation", driver.transcript.toJSONL());
    h.cleanup(RID);
  });

  it(
    "브리프 보완을 상한까지 반복 → action=raise-limit(Escalation) → [한 번 더] fire → 게이트 복구 · 분석기 발견=stuck 뿐",
    async () => {
      // 1) 멘션 → 브리프 승인 게이트.
      await driver.mention(THREAD, MENTION);
      const gate = await driver.runToGate((p, na) => p?.type === "ApproveGate" && na?.phase === "01-brief");
      expect(gate.reached).toBe(true);

      // 2) 상한을 경험적으로 소진 — na.action 이 raise-limit 가 될 때까지 [보완]+답글 반복(하드코딩 아님).
      let escalated = false;
      for (let i = 0; i < REVISE_BUDGET; i++) {
        const na = await driver.readNa();
        if (na?.action === "raise-limit") {
          escalated = true;
          break;
        }
        const latest = driver.latestPresentation();
        if (latest?.type !== "ApproveGate") break; // 예상 밖(진단용 조기 종료)
        const revise = (affordancesOf(latest, driver.affordanceContext()) as ButtonPressed[]).find(
          (a) => a.actionId === "revise",
        );
        if (!revise) break;
        await driver.fire(revise);
        await driver.reply(THREAD, `보완 ${i + 1}회: 표현을 더 다듬어 주세요.`);
      }
      expect(escalated).toBe(true);

      // 3) Escalation 화면이 떴다(상한 초과 → 사람 개입 필요 안내 + [한 번 더]).
      const escPres = driver.latestPresentation();
      expect(escPres?.type).toBe("Escalation");
      const naEsc = await driver.readNa();
      expect(naEsc?.action).toBe("raise-limit");

      // 4) [한 번 더 시도](raise-limit) affordance 를 추출기에서 골라 fire → 상한 상향 후 재생성.
      const raise = (affordancesOf(escPres!, driver.affordanceContext()) as ButtonPressed[]).find(
        (a) => a.actionId === "raise-limit",
      );
      expect(raise).toBeDefined();
      await driver.fire(raise!);
      await driver.quiesce();

      // 5) 복구: 상한이 오르고 재생성돼 다시 사람이 볼 게이트로 돌아왔다(고립되지 않음). run 은 미완이지만 출구가 있다.
      const naAfter = await driver.readNa();
      expect(naAfter?.action).not.toBe("raise-limit"); // 에스컬레이션 해소
      const recovered = driver.latestPresentation();
      expect(["ApproveGate", "OptionSet", "ImageOptionSet"]).toContain(recovered?.type);
      expect(affordancesOf(recovered!, driver.affordanceContext()).length).toBeGreaterThan(0); // 출구 있음
      expect(driver.activeRuns).toBe(0);

      // 6) 분석기: 반복 게이트를 stuck 으로 잡는 것이 정답(이 시나리오의 본질). 그 외 종류(실패·막다른·미지·잔존)는 0.
      const findings = analyze({
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa: naAfter,
      });
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.kind === "stuck")).toBe(true);
      expect(findings.some((f) => f.kind === "failure" || f.kind === "dead-end")).toBe(false);
    },
    240_000,
  );
});
