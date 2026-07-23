import { configDefaults, defineConfig } from "vitest/config";

/**
 * 기본(standalone 단위) 계층. globals 미사용(테스트는 vitest 에서 test/expect 를 명시 import).
 *   · setup.ts 가 HARNESS_ROOT 더미를 주입 → 순수 로직 단위 테스트가 실제 하네스(core) 없이 돈다.
 *   · test/e2e/** (통합 E2E)는 제외 — 실제 core spawn 이 필요하므로 `pnpm test:integration`
 *     (vitest.e2e.config.ts)로 분리 실행한다.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // test/e2e/** = 통합 E2E(실 core spawn) · test/acceptance/**/*.accept.test.ts = 인수 시나리오(실 core spawn ·
    //   gated). 둘 다 standalone 에서 제외한다. 단 순수 인수 단위(analyzer.test.ts 등 .test.ts)는 여기 포함된다.
    exclude: [...configDefaults.exclude, "test/e2e/**", "test/acceptance/**/*.accept.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
