import { defineConfig } from "vitest/config";

/**
 * 인수-시나리오(acceptance-scenario) 계층 — 실제 하네스(core)를 spawn 하는 표면 흐름 인수 테스트.
 *   `pnpm test:accept` 가 사용. include 는 test/acceptance/**\/*.accept.test.ts 만.
 *
 *   · setupFiles 를 두지 않는다(중요 · vitest.e2e.config.ts 와 동일 이유): standalone 셋업(test/setup.ts)이
 *     HARNESS_ROOT 더미를 주입하면 시나리오의 '미지정 시 생략(skipIf)' 판정이 무력화된다. HARNESS_ROOT 미주입이면
 *     시나리오가 스스로 경고를 찍고 생략한다(조용한 통과 금지). 주입 시에만 실제 core 를 구동한다.
 *   · 순수 인수 단위(analyzer.test.ts·affordance-convention.test.ts·recording-port.test.ts·transcript.test.ts)는
 *     .test.ts(≠.accept.test.ts)라 여기 include 되지 않고 standalone `pnpm test` 에서 돈다.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/acceptance/**/*.accept.test.ts"],
  },
});
