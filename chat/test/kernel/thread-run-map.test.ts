import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FileStateAdapter } from "../../src/kernel/file-state-adapter.js";
import { ThreadRunMap } from "../../src/kernel/thread-run-map.js";

let dir: string;
let adapter: FileStateAdapter;
let map: ThreadRunMap;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-map-"));
  adapter = new FileStateAdapter(dir);
  await adapter.connect();
  map = new ThreadRunMap(adapter);
});
afterEach(async () => {
  await adapter.disconnect();
  await rm(dir, { recursive: true, force: true });
});

test("bind 후 양방향 왕복 일치", async () => {
  await map.bindThreadToRun("slack:C1:169", "run-42");
  expect(await map.runForThread("slack:C1:169")).toBe("run-42");
  expect(await map.threadForRun("run-42")).toBe("slack:C1:169");
});

test("미존재 조회는 null", async () => {
  expect(await map.runForThread("nope")).toBeNull();
  expect(await map.threadForRun("nope")).toBeNull();
});

test("재바인딩은 최신 run 으로 덮어씀 + 옛 run→스레드 고아 매핑 제거", async () => {
  await map.bindThreadToRun("th-x", "run-1");
  await map.bindThreadToRun("th-x", "run-2");
  expect(await map.runForThread("th-x")).toBe("run-2");
  expect(await map.threadForRun("run-2")).toBe("th-x");
  // 옛 run-1 의 역매핑이 남으면 옛 키 조회가 새 run 의 스레드로 오라우팅됨 → null 이어야 함
  expect(await map.threadForRun("run-1")).toBeNull();
});

test("run 을 새 스레드로 재바인딩 시 옛 스레드→run 고아 매핑 제거(대칭)", async () => {
  await map.bindThreadToRun("th-a", "run-9");
  await map.bindThreadToRun("th-b", "run-9");
  expect(await map.threadForRun("run-9")).toBe("th-b");
  expect(await map.runForThread("th-b")).toBe("run-9");
  expect(await map.runForThread("th-a")).toBeNull();
});
