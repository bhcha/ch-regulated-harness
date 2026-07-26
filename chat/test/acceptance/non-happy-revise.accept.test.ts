/**
 * non-happy-revise.accept.test.ts — 인수 시나리오 ③-보완 루프: **브리프 승인 게이트에서 [보완] → 답글 → 재생성**.
 *
 * 실 게이트웨이 + core stub 로 보완(revise) 루프를 몬다: 멘션 → 브리프 ApproveGate 도달 → affordancesOf 에서 [보완]
 *   affordance 를 골라 fire → 게이트웨이가 pending=feedback + 안내 렌더 → reply("고칠 내용") → revise 잡 → 재생성 →
 *   다시 ApproveGate(회차 전진). 보완 루프는 **실패가 아니다** — 분석기 clean(막다른/실패/미지 0)이어야 한다.
 *
 * oracle 순환 금지(계획 2-1): 회차 전진·게이트 재현은 core next-action(readNa)에서 읽는다(매퍼 재실행 아님).
 * 격리: 전용 rid(chat-e2e-accept-revise) + 빈 examples + afterAll 정리(support = S2 미러). 비-keyvisual 구간이라 빠르다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurfaceDriver } from "../../src/acceptance/driver.js";
import { analyze } from "../../src/acceptance/analyzer.js";
import { affordancesOf } from "../../src/acceptance/affordances.js";
import { makeRunId } from "../../src/kernel/flow.js";
import type { ButtonPressed } from "../../src/kernel/events.js";
import { BUNDLE, setupDriverHarness, SKIP, writeTranscriptArtifact, type TempHarness } from "./support.js";

if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(보완 루프) 생략");

const THREAD = "e2e-accept-revise";
const RID = makeRunId(THREAD); // "chat-e2e-accept-revise"
const ACTOR = "chat:accept:U-revise";
const APPROVER_UID = "U-revise";
const MENTION = '화장품이고 여러장이야, 제품명은 "인수보완테스트"';

let h: TempHarness;
let driver: SurfaceDriver;

describe.skipIf(SKIP)("인수 시나리오 ③: 보완 루프(브리프 [보완] → 답글 → 재생성 → 다시 승인 게이트)", () => {
  beforeAll(() => {
    h = setupDriverHarness("chat-accept-revise", APPROVER_UID);
    driver = new SurfaceDriver({ bundleDir: BUNDLE, stagedWbPath: h.stagedWb, actor: ACTOR, stateDir: h.stateDir });
  });

  afterAll(() => {
    // 트랜스크립트 아티팩트(opt-in · verify.sh 가 CHAT_ACCEPT_ARTIFACT_DIR set 했을 때만; 그 외 no-op).
    writeTranscriptArtifact("non-happy-revise", driver.transcript.toJSONL());
    h.cleanup(RID);
  });

  it(
    "브리프 ApproveGate 에서 [보완] fire → 답글 소비 → 회차 전진 · 분석기 clean(보완은 실패 아님)",
    async () => {
      // 1) 멘션 → auto-happy 로 브리프 승인 게이트 도달.
      await driver.mention(THREAD, MENTION);
      const gate = await driver.runToGate((p, na) => p?.type === "ApproveGate" && na?.phase === "01-brief");
      expect(gate.reached).toBe(true);

      const na0 = await driver.readNa();
      expect(na0?.phase).toBe("01-brief");
      expect(na0?.action).toBe("approve");
      const iter0 = na0?.iteration ?? null;

      // 2) [보완] affordance 를 추출기에서 고른다(손으로 지어내지 않는다). ApproveGate 는 revise_available 이라 [보완] 있음.
      const affs = affordancesOf(gate.final!, driver.affordanceContext()) as ButtonPressed[];
      const revise = affs.find((a) => a.actionId === "revise");
      expect(revise).toBeDefined();

      // 3) fire → 게이트웨이가 보완 사유 답글을 요청한다(pending=feedback + 안내 렌더).
      await driver.fire(revise!);
      expect(
        driver.presentations().some((p) => p.type === "Progress" && p.message.includes("고칠 내용")),
      ).toBe(true);

      // 3′) 회귀(외부리뷰 S3 P2): 지금 최종 화면은 버튼 없는 Progress(답글 대기)이고 na 는 미완이다. 분석기에 답글-대기를
      //     알리지 않으면 이 정당한 대기를 dead-end 로 오탐한다 — driver.awaitingReply()로 알리면 억제됨을 못박는다.
      const naPrompt = await driver.readNa();
      const promptInput = {
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa: naPrompt,
      };
      expect(analyze(promptInput).some((f) => f.kind === "dead-end")).toBe(true); // 미알림 = 오탐
      expect(await driver.awaitingReply()).toBe(true); // 실제로 답글(보완 사유) 대기 중
      expect(analyze({ ...promptInput, awaitingReply: true }).some((f) => f.kind === "dead-end")).toBe(false);

      // 4) 보완 사유 답글 → revise 잡 → 재생성 캐스케이드(reply 가 내부에서 quiesce).
      await driver.reply(THREAD, "표현을 조금 더 부드럽게 다듬어 주세요.");

      // 5) 보완이 소비돼 run 이 재생성됐다 — 다시 브리프 승인 차례이고 회차가 전진했다(core na 가 진실).
      const na1 = await driver.readNa();
      expect(na1?.phase).toBe("01-brief");
      expect(na1?.action).toBe("approve");
      // 회차 전진(iter0 → iter0+…). null 방어(둘 다 숫자일 때 strict 비교).
      if (typeof iter0 === "number" && typeof na1?.iteration === "number") {
        expect(na1.iteration).toBeGreaterThan(iter0);
      }

      // 6) 정지 후 폐쇄 속성.
      await driver.quiesce();
      expect(driver.activeRuns).toBe(0);
      expect(driver.presentations().some((p) => p.type === "Failure")).toBe(false);

      // 7) 분석기 clean — 보완 루프는 실패/막다른/미지/잔존이 아니다(같은 게이트 2회는 stuck 임계 3 미만).
      const findings = analyze({
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa: na1,
      });
      expect(findings).toEqual([]);
    },
    180_000,
  );
});
