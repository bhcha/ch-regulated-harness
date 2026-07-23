import { defineConfig } from "vitest/config";

/**
 * 통합(integration) 계층 — 실제 하네스(core)를 spawn 하는 stub E2E. `pnpm test:integration` 이 사용.
 *   · include 는 test/e2e/** 만.
 *   · setupFiles 를 두지 않는다(중요): standalone 셋업(test/setup.ts)이 HARNESS_ROOT 더미를 주입하면
 *     E2E 의 '미지정 시 생략(skipIf)' 판정이 무력화되기 때문. HARNESS_ROOT 미주입이면 E2E 스위트가
 *     스스로 경고를 찍고 생략한다(조용한 통과 금지). 주입 시에만 실제 core 를 구동한다.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
  },
});
