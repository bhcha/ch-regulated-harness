/**
 * non-happy-stale-select.accept.test.ts — 인수 시나리오 ③-stale 선택 거부: **도장(stamp) 어긋난 [이걸로] 클릭은 거부**.
 *
 * 실 게이트웨이 + core stub 로 다안(concept) 선택 게이트에 도달한 뒤, 실제 affordance 의 value 에서 **도장(phase)만
 *   낡게 변조**한 select 이벤트를 fire 한다 → onChoice 가 phase/iteration 불일치를 잡아 "새로운 안이 준비돼 있어요"
 *   진행 안내만 렌더하고 **select 잡을 만들지 않는다**(run 미전진). 이어서 **올바른 도장**으로 다시 고르면 정상 전진 —
 *   stale 거부가 흐름을 막지 않음을 함께 증명한다(계획 폐쇄 속성: stale 거부 · 발화하면 전진).
 *
 * oracle 순환 금지: 전진/미전진은 core next-action(readNa)에서 읽는다. 격리: 전용 rid(chat-e2e-accept-stale) + 빈
 *   examples + afterAll 정리. keyvisual 전이라 빠르다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurfaceDriver } from "../../src/acceptance/driver.js";
import { analyze } from "../../src/acceptance/analyzer.js";
import { affordancesOf } from "../../src/acceptance/affordances.js";
import { makeRunId, parseActionValue } from "../../src/kernel/flow.js";
import type { ButtonPressed } from "../../src/kernel/events.js";
import { BUNDLE, setupDriverHarness, SKIP, writeTranscriptArtifact, type TempHarness } from "./support.js";

if (SKIP) console.warn("하네스 미지정(HARNESS_ROOT) — 인수 시나리오(stale 선택 거부) 생략");

const THREAD = "e2e-accept-stale";
const RID = makeRunId(THREAD); // "chat-e2e-accept-stale"
const ACTOR = "chat:accept:U-stale";
const APPROVER_UID = "U-stale";
const MENTION = '화장품이고 여러장이야, 제품명은 "인수스테일테스트"';

let h: TempHarness;
let driver: SurfaceDriver;

describe.skipIf(SKIP)("인수 시나리오 ③: stale 선택 거부(도장 어긋난 [이걸로]는 전진 없음, 최신 안은 정상 전진)", () => {
  beforeAll(() => {
    h = setupDriverHarness("chat-accept-stale", APPROVER_UID);
    driver = new SurfaceDriver({ bundleDir: BUNDLE, stagedWbPath: h.stagedWb, actor: ACTOR, stateDir: h.stateDir });
  });

  afterAll(() => {
    // 트랜스크립트 아티팩트(opt-in · verify.sh 가 CHAT_ACCEPT_ARTIFACT_DIR set 했을 때만; 그 외 no-op).
    writeTranscriptArtifact("non-happy-stale-select", driver.transcript.toJSONL());
    h.cleanup(RID);
  });

  it(
    "concept OptionSet 에서 stale 도장 select fire → 거부(미전진), 올바른 도장 select → 정상 전진",
    async () => {
      // 1) 멘션 → auto-happy 로 concept 다안(select) 게이트 도달(자동-happy 는 다안에서 멈추지 않고 선택하므로
      //    predicate 로 그 시점을 잡는다 — runToGate 는 발화 전에 predicate 를 본다).
      await driver.mention(THREAD, MENTION);
      const gate = await driver.runToGate((p, na) => p?.type === "OptionSet" && na?.phase === "02-concept");
      expect(gate.reached).toBe(true);
      const conceptOpt = gate.final!;

      const na0 = await driver.readNa();
      expect(na0?.phase).toBe("02-concept");
      expect(na0?.action).toBe("select");
      const iter0 = na0?.iteration ?? null;

      // 2) 실제 [이걸로] affordance 의 value 에서 **도장(phase)만 낡게 변조**해 stale 클릭을 만든다(지어낸 버튼 아님 —
      //    실제 것에서 도장만 바꾼다). onChoice 가 phase 불일치를 잡아 거부해야 한다.
      const affs = affordancesOf(conceptOpt, driver.affordanceContext()) as ButtonPressed[];
      const realSelect = affs.find((a) => a.actionId.startsWith("select-"));
      expect(realSelect).toBeDefined();
      const parsed = parseActionValue(realSelect!.value);
      expect(parsed?.phase).toBe("02-concept"); // 원본 도장은 현재 게이트와 일치
      const staleValue = JSON.stringify({
        run_id: parsed!.run_id,
        action: "select",
        option: parsed!.option,
        phase: "01-brief", // ← 낡은 도장(다른 페이즈) = stale
        iteration: parsed!.iteration,
      });
      const staleEvent: ButtonPressed = {
        type: "button",
        actionId: realSelect!.actionId,
        value: staleValue,
        actor: driver.affordanceContext().actor,
        threadId: THREAD,
      };
      await driver.fire(staleEvent);

      // 3) 거부됨: "새로운 안이 준비돼 있어요" 안내만 렌더 · run 미전진(readNa 여전히 concept select · 같은 회차).
      expect(
        driver.presentations().some((p) => p.type === "Progress" && p.message.includes("새로운 안이 준비돼")),
      ).toBe(true);
      const naStale = await driver.readNa();
      expect(naStale?.phase).toBe("02-concept");
      expect(naStale?.action).toBe("select");
      expect(naStale?.iteration ?? null).toEqual(iter0);
      expect(driver.activeRuns).toBe(0); // select 잡 미생성

      // 4) 올바른 도장으로 다시 고른다(추출기가 낸 recommended 안 — decide). 정상 전진해야 한다.
      const correct = driver.decide(conceptOpt);
      expect(correct).not.toBeNull();
      await driver.fire(correct!);
      await driver.quiesce();

      // 5) 전진 확인 — concept 를 벗어나 다음 페이즈(03-storyboard) 선택 차례로 넘어갔다(core na 가 진실).
      const naAfter = await driver.readNa();
      expect(naAfter?.phase).toBe("03-storyboard");
      expect(driver.activeRuns).toBe(0);

      // 6) 분석기 clean — stale 거부 안내(Progress)는 최종 화면이 아니고(최종 = storyboard OptionSet, 출구 있음),
      //    실패/막다른/미지/잔존 0. 같은 게이트 반복도 임계 미만.
      const findings = analyze({
        presentations: driver.presentations(),
        activeRuns: driver.activeRuns,
        ctx: driver.affordanceContext(),
        finalNa: naAfter,
      });
      expect(findings).toEqual([]);
    },
    180_000,
  );
});
