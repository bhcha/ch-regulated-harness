/**
 * tee-port.test.ts — TeeRecordingPort 단위(기록 + FAKE delegate 로 tee + JSONL 지속). 실 Slack 0(fake delegate).
 *   recording-port.test.ts 의 tee assertion 을 미러한다(기록 후 위임 순서 · 방어적 복사 · 능력 위임).
 */
import { describe, expect, it } from "vitest";
import { rendersToJSONL, TeeRecordingPort } from "../../src/live/tee-port.js";
import type { ChatPort } from "../../src/kernel/ports.js";
import type { Presentation } from "../../src/kernel/presentation.js";

const ingest = (rid: string): Presentation => ({
  type: "IngestPrompt",
  rid,
  header: "자료 요청",
  gateLabel: "자료 붙여넣기",
  hint: "워킹백워드를 붙여주세요",
});
const progress = (rid: string, message: string): Presentation => ({
  type: "Progress",
  rid,
  header: "진행 중",
  message,
});

describe("TeeRecordingPort", () => {
  it("기록 '후' delegate(실 Slack 대역)로 render/subscribe 를 tee 한다(상대 순서)", async () => {
    const order: string[] = [];
    let port: TeeRecordingPort;
    const delegate: ChatPort = {
      render: async (threadId) => {
        // tee 시점엔 로컬 기록이 이미 반영돼 있어야 한다(기록 → tee 순서).
        order.push(`delegate.render:${threadId}:localCount=${port.renders().length}`);
      },
      subscribe: async (threadId) => {
        order.push(`delegate.subscribe:${threadId}:localHas=${port.subscriptions().includes(threadId)}`);
      },
      capabilities: () => ({ imageDelivery: "hostedUrl" }),
    };
    port = new TeeRecordingPort({ delegate });

    await port.render("t1", ingest("r1"));
    await port.subscribe("t1");

    expect(order).toEqual([
      "delegate.render:t1:localCount=1", // 로컬 1건 기록 후 tee
      "delegate.subscribe:t1:localHas=true", // 로컬 구독 후 tee
    ]);
    // 로컬 기록도 남아 있다(둘 다 = 기록 AND tee).
    expect(port.renders().length).toBe(1);
    expect(port.renders()[0]!.presentation.type).toBe("IngestPrompt");
    expect(port.subscriptions()).toEqual(["t1"]);
    // 능력은 delegate(실 Slack) 것으로 위임된다.
    expect(port.capabilities()).toEqual({ imageDelivery: "hostedUrl" });
  });

  it("render 를 순서대로 기록한다(seq 0-based · threadId·Presentation)", async () => {
    const delegate: ChatPort = {
      render: async () => {},
      subscribe: async () => {},
      capabilities: () => ({ imageDelivery: "upload" }),
    };
    const port = new TeeRecordingPort({ delegate });
    await port.render("t1", ingest("r1"));
    await port.render("t2", progress("r1", "만드는 중이에요"));
    const recs = port.renders();
    expect(recs.map((r) => [r.seq, r.threadId, r.presentation.type])).toEqual([
      [0, "t1", "IngestPrompt"],
      [1, "t2", "Progress"],
    ]);
  });

  it("JSONL 지속: render 마다 주입 writeFile 로 전체 트랜스크립트를 스냅샷한다", async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const delegate: ChatPort = {
      render: async () => {},
      subscribe: async () => {},
      capabilities: () => ({ imageDelivery: "upload" }),
    };
    const port = new TeeRecordingPort({
      delegate,
      jsonlPath: "/artifacts/live.jsonl",
      writeFile: (path, data) => writes.push({ path, data }),
    });
    await port.render("t1", ingest("r1"));
    await port.render("t1", progress("r1", "진행"));

    // render 2회 → 지속 2회, 마지막은 누적 2줄.
    expect(writes.length).toBe(2);
    expect(writes[0]!.path).toBe("/artifacts/live.jsonl");
    const lastLines = writes[1]!.data.trimEnd().split("\n");
    expect(lastLines.length).toBe(2);
    // 각 줄은 {seq, threadId, presentation} JSON.
    const first = JSON.parse(lastLines[0]!) as { seq: number; threadId: string; presentation: { type: string } };
    expect(first).toMatchObject({ seq: 0, threadId: "t1", presentation: { type: "IngestPrompt" } });
    // toJSONL() 도 같은 결과.
    expect(port.toJSONL()).toBe(writes[1]!.data);
  });

  it("jsonlPath 미설정이면 지속하지 않는다(인메모리만 · writeFile 미호출)", async () => {
    let called = 0;
    const delegate: ChatPort = {
      render: async () => {},
      subscribe: async () => {},
      capabilities: () => ({ imageDelivery: "upload" }),
    };
    const port = new TeeRecordingPort({
      delegate,
      writeFile: () => {
        called += 1;
      },
    });
    await port.render("t1", ingest("r1"));
    expect(called).toBe(0);
    expect(port.renders().length).toBe(1);
  });

  it("JSONL 지속 실패는 흡수한다(tee/기록/렌더를 막지 않음 · best-effort)", async () => {
    const rendered: string[] = [];
    const delegate: ChatPort = {
      render: async (t) => {
        rendered.push(t);
      },
      subscribe: async () => {},
      capabilities: () => ({ imageDelivery: "upload" }),
    };
    const port = new TeeRecordingPort({
      delegate,
      jsonlPath: "/artifacts/live.jsonl",
      writeFile: () => {
        throw new Error("disk full");
      },
      log: () => {},
    });
    // 지속이 던져도 render 는 완료되고 delegate tee 도 일어난다.
    await expect(port.render("t1", ingest("r1"))).resolves.toBeUndefined();
    expect(rendered).toEqual(["t1"]);
    expect(port.renders().length).toBe(1);
  });

  it("rendersToJSONL: 빈 목록=빈 문자열 · 매 줄 개행 종료", () => {
    expect(rendersToJSONL([])).toBe("");
    const jsonl = rendersToJSONL([{ seq: 0, threadId: "t", presentation: ingest("r") }]);
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.split("\n").filter((l) => l !== "").length).toBe(1);
  });
});
