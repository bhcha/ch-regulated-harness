import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, QueueEntry } from "chat";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FileStateAdapter } from "../../src/kernel/file-state-adapter.js";

let dir: string;
let adapter: FileStateAdapter;

beforeEach(async () => {
  // 임시 .state 디렉터리로 격리(afterEach 정리).
  dir = await mkdtemp(join(tmpdir(), "chat-state-"));
  adapter = new FileStateAdapter(dir);
  await adapter.connect();
});
afterEach(async () => {
  await adapter.disconnect();
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 테스트용 QueueEntry — message 는 최소 형태를 Message 로 캐스팅(직렬화 왕복만 검증). */
const entry = (text: string, ttlMs = 60_000): QueueEntry => ({
  enqueuedAt: Date.now(),
  expiresAt: Date.now() + ttlMs,
  message: { id: text, text } as unknown as Message,
});

test("get/set/delete 왕복", async () => {
  expect(await adapter.get("k")).toBeNull();
  await adapter.set("k", { n: 1 });
  expect(await adapter.get<{ n: number }>("k")).toEqual({ n: 1 });
  await adapter.delete("k");
  expect(await adapter.get("k")).toBeNull();
});

test("키는 슬래시·콜론 포함해도 안전 인코딩되어 왕복", async () => {
  const key = "map:thread:slack:C1/2:99";
  await adapter.set(key, "v");
  expect(await adapter.get(key)).toBe("v");
});

test("setIfNotExists: 최초만 true, 이후 false", async () => {
  expect(await adapter.setIfNotExists("s", "a")).toBe(true);
  expect(await adapter.setIfNotExists("s", "b")).toBe(false);
  expect(await adapter.get("s")).toBe("a"); // 첫 값 유지
  await adapter.delete("s");
  expect(await adapter.setIfNotExists("s", "c")).toBe(true); // 삭제 후 재설정
});

test("TTL 만료 시 get 은 null", async () => {
  await adapter.set("t", "v", 30);
  expect(await adapter.get("t")).toBe("v");
  await sleep(90);
  expect(await adapter.get("t")).toBeNull();
});

test("동시 acquireLock — 정확히 1개만 성공(원자 생성)", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () => adapter.acquireLock("thread-1", 1000)),
  );
  expect(results.filter((r) => r !== null).length).toBe(1);
});

test("만료 후 재획득 허용", async () => {
  const first = await adapter.acquireLock("thread-2", 40);
  expect(first).not.toBeNull();
  expect(await adapter.acquireLock("thread-2", 1000)).toBeNull(); // 아직 유효 → 거부
  await sleep(90);
  const second = await adapter.acquireLock("thread-2", 1000);
  expect(second).not.toBeNull();
  expect(second?.token).not.toBe(first?.token); // 새 토큰
});

test("releaseLock 토큰 검증 — 틀린 토큰 무효, 맞으면 해제", async () => {
  const lock = await adapter.acquireLock("thread-3", 1000);
  expect(lock).not.toBeNull();
  await adapter.releaseLock({ ...lock!, token: "bogus" });
  expect(await adapter.acquireLock("thread-3", 1000)).toBeNull(); // 여전히 잠김
  await adapter.releaseLock(lock!);
  expect(await adapter.acquireLock("thread-3", 1000)).not.toBeNull(); // 정상 해제
});

test("extendLock / forceReleaseLock", async () => {
  const lock = await adapter.acquireLock("thread-4", 1000);
  expect(await adapter.extendLock(lock!, 2000)).toBe(true);
  expect(await adapter.extendLock({ ...lock!, token: "x" }, 2000)).toBe(false); // 토큰 불일치
  await adapter.forceReleaseLock("thread-4");
  expect(await adapter.acquireLock("thread-4", 1000)).not.toBeNull(); // 강제 해제됨
});

test("enqueue / dequeue FIFO", async () => {
  expect(await adapter.enqueue("q", entry("a"), 10)).toBe(1);
  expect(await adapter.enqueue("q", entry("b"), 10)).toBe(2);
  expect(await adapter.enqueue("q", entry("c"), 10)).toBe(3);
  expect(await adapter.queueDepth("q")).toBe(3);
  expect((await adapter.dequeue("q"))?.message.text).toBe("a");
  expect((await adapter.dequeue("q"))?.message.text).toBe("b");
  expect((await adapter.dequeue("q"))?.message.text).toBe("c");
  expect(await adapter.dequeue("q")).toBeNull(); // 비었음
  expect(await adapter.queueDepth("q")).toBe(0);
});

test("enqueue maxSize 초과 시 오래된 것부터 폐기", async () => {
  await adapter.enqueue("q2", entry("a"), 2);
  await adapter.enqueue("q2", entry("b"), 2);
  await adapter.enqueue("q2", entry("c"), 2); // a 밀려남
  expect(await adapter.queueDepth("q2")).toBe(2);
  expect((await adapter.dequeue("q2"))?.message.text).toBe("b"); // 가장 오래된 생존자
});

test("appendToList / getList", async () => {
  expect(await adapter.getList("l")).toEqual([]); // 미존재 → 빈 배열
  await adapter.appendToList("l", "a");
  await adapter.appendToList("l", "b");
  await adapter.appendToList("l", "c");
  expect(await adapter.getList<string>("l")).toEqual(["a", "b", "c"]); // 삽입 순서
});

test("appendToList maxLength — 최신만 유지", async () => {
  await adapter.appendToList("l2", 1, { maxLength: 2 });
  await adapter.appendToList("l2", 2, { maxLength: 2 });
  await adapter.appendToList("l2", 3, { maxLength: 2 });
  expect(await adapter.getList<number>("l2")).toEqual([2, 3]);
});

test("subscribe / isSubscribed / unsubscribe", async () => {
  expect(await adapter.isSubscribed("th")).toBe(false);
  await adapter.subscribe("th");
  expect(await adapter.isSubscribed("th")).toBe(true);
  await adapter.unsubscribe("th");
  expect(await adapter.isSubscribed("th")).toBe(false);
});
