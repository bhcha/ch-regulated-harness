/**
 * setup.ts — vitest 셋업(standalone 단위 계층 전용).
 *
 * standalone 단위 계층은 실제 하네스(core) 없이 순수 로직만 검증한다. 다만 일부 단위 테스트가 설정을
 *   조립하다 부수적으로 harnessRoot()/harnessEnv() 를 호출하는데, HARNESS_ROOT 미주입이면 이제 fail-fast 로
 *   throw 한다(config.ts). 그래서 미설정일 때만 '주입된 더미' 절대경로를 넣어 그 부수 호출이 깨지지 않게 한다.
 *
 *   단위 테스트는 하네스를 절대 spawn 하지 않으므로 이 더미 경로가 실제로 열리는 일은 없다(존재하지 않아도 무해).
 *   실제로 하네스를 spawn 하는 테스트(계약-클라이언트 spawn 배선)나 통합 E2E 는 자기 HARNESS_ROOT 를 직접
 *   설정해 이 더미를 덮어쓴다. 통합 계층(vitest.e2e.config.ts)은 이 셋업을 로드하지 않는다 — 더미를 주입하면
 *   E2E 의 '미지정 시 생략' 판정이 무력화되기 때문.
 *
 *   이미 설정돼 있으면(운영자/CI 가 실제 core 를 주입) 건드리지 않는다.
 */
if (!process.env.HARNESS_ROOT) {
  process.env.HARNESS_ROOT = "/nonexistent/harness-root-for-standalone-unit-tests";
}
