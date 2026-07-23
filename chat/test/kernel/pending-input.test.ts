import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateAdapter } from "../../src/kernel/file-state-adapter.js";
import { PendingInputStore } from "../../src/kernel/pending-input.js";

let dir: string;
let store: PendingInputStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-pending-"));
  const adapter = new FileStateAdapter(dir);
  await adapter.connect();
  store = new PendingInputStore(adapter);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("set/get/clear 왕복", async () => {
  await store.set("th-1", { kind: "wb", rid: "r1" });
  expect(await store.get("th-1")).toEqual({ kind: "wb", rid: "r1" });
  await store.clear("th-1");
  expect(await store.get("th-1")).toBeNull();
});

test("mergeSetup: 없으면 새로 시작, setup 이면 부분 갱신 — setup 밖(wb 등)이면 no-op(TOCTOU 가드)", async () => {
  const first = await store.mergeSetup("th-2", { domain: "화장품" });
  expect(first).toEqual({ kind: "setup", domain: "화장품" });
  const second = await store.mergeSetup("th-2", { format: "여러장" });
  expect(second).toEqual({ kind: "setup", domain: "화장품", format: "여러장" });
  // [시작]이 wb 로 전이한 '뒤' 도착한 늦은 Select — setup 을 되살리면 다음 답글이 제품명으로 오소비되므로 no-op.
  await store.set("th-2", { kind: "wb", rid: "r9" });
  const noop = await store.mergeSetup("th-2", { domain: "의약품" });
  expect(noop).toEqual({ kind: "wb", rid: "r9" }); // 병합 거부 · 현재 상태 반환
  expect(await store.get("th-2")).toEqual({ kind: "wb", rid: "r9" });
});

test("동시 mergeSetup — 도메인/포맷이 동시에 와도 둘 다 보존(read-modify-write 유실 없음)", async () => {
  await Promise.all([
    store.mergeSetup("th-c", { domain: "화장품" }),
    store.mergeSetup("th-c", { format: "여러장" }),
    store.mergeSetup("th-c", { product: "이지듀" }),
  ]);
  expect(await store.get("th-c")).toEqual({ kind: "setup", product: "이지듀", domain: "화장품", format: "여러장" });
});

test("스레드 간 격리", async () => {
  await store.set("th-a", { kind: "feedback", rid: "ra" });
  await store.set("th-b", { kind: "wb", rid: "rb" });
  expect(await store.get("th-a")).toEqual({ kind: "feedback", rid: "ra" });
  expect(await store.get("th-b")).toEqual({ kind: "wb", rid: "rb" });
});
