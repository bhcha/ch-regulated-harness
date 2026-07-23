/**
 * recording-port.test.ts — RecordChatPort 단위(순서·능력·구독·Tee 위임·방어적 복사).
 *
 * 순수 인메모리(디스크·네트워크·시계 0). 실 게이트웨이는 붙이지 않는다 — 기록 포트 자체의 계약만 본다.
 */
import { describe, expect, it } from "vitest";
import { RecordChatPort } from "../../src/acceptance/recording-port.js";
import type { CapabilityManifest, ChatPort } from "../../src/kernel/ports.js";
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

describe("RecordChatPort", () => {
  it("render 를 순서대로 기록한다(seq 0-based · threadId·Presentation 보존)", async () => {
    const port = new RecordChatPort();
    await port.render("t1", ingest("r1"));
    await port.render("t2", progress("r1", "만드는 중이에요"));

    const recs = port.renders();
    expect(recs.length).toBe(2);
    expect(recs[0].seq).toBe(0);
    expect(recs[0].threadId).toBe("t1");
    expect(recs[0].presentation.type).toBe("IngestPrompt");
    expect(recs[1].seq).toBe(1);
    expect(recs[1].threadId).toBe("t2");
    expect(recs[1].presentation.type).toBe("Progress");
  });

  it("capabilities() = { imageDelivery: 'upload' } (Slack 어댑터 미러)", () => {
    const port = new RecordChatPort();
    expect(port.capabilities()).toEqual({ imageDelivery: "upload" });
  });

  it("subscribe 가 threadId 를 Set 으로 기록한다(중복 제거)", async () => {
    const port = new RecordChatPort();
    await port.subscribe("t1");
    await port.subscribe("t2");
    await port.subscribe("t1"); // 중복
    expect(port.subscriptions().sort()).toEqual(["t1", "t2"]);
  });

  it("Tee: delegate 가 있으면 로컬 기록 '후' render/subscribe 를 위임한다(상대 순서)", async () => {
    const order: string[] = [];
    let port: RecordChatPort;
    const delegate: ChatPort = {
      render: async (threadId) => {
        // 위임 시점엔 로컬 기록이 이미 반영돼 있어야 한다(기록 → 위임 순서).
        order.push(`delegate.render:${threadId}:localCount=${port.renders().length}`);
      },
      subscribe: async (threadId) => {
        order.push(`delegate.subscribe:${threadId}:localHas=${port.subscriptions().includes(threadId)}`);
      },
      capabilities: () => ({ imageDelivery: "hostedUrl" }),
    };
    port = new RecordChatPort(delegate);

    await port.render("t1", ingest("r1"));
    await port.subscribe("t1");

    expect(order).toEqual([
      "delegate.render:t1:localCount=1", // 로컬 1건 기록 후 위임
      "delegate.subscribe:t1:localHas=true", // 로컬 구독 후 위임
    ]);
    // 로컬 기록도 남아 있다.
    expect(port.renders().length).toBe(1);
    expect(port.subscriptions()).toEqual(["t1"]);
    // capabilities 는 delegate(실 포트) 것으로 위임된다.
    expect(port.capabilities()).toEqual({ imageDelivery: "hostedUrl" });
  });

  it("renders() 스냅샷은 방어적 복사다(반환 배열/객체 변형이 내부를 오염시키지 않는다)", async () => {
    const port = new RecordChatPort();
    await port.render("t1", progress("r1", "orig"));

    const snap = port.renders();
    // 배열 변형
    snap.push({ seq: 99, threadId: "hacked", presentation: progress("x", "junk") });
    // 객체·중첩 Presentation 변형
    (snap[0] as { threadId: string }).threadId = "MUTATED";
    (snap[0].presentation as Extract<Presentation, { type: "Progress" }>).message = "MUTATED";

    const fresh = port.renders();
    expect(fresh.length).toBe(1);
    expect(fresh[0].threadId).toBe("t1");
    expect((fresh[0].presentation as Extract<Presentation, { type: "Progress" }>).message).toBe("orig");
  });

  it("delegate 없이 순수 인메모리로 동작한다(위임 부작용 0)", async () => {
    const cap: CapabilityManifest = new RecordChatPort().capabilities();
    expect(cap.imageDelivery).toBe("upload");
  });
});
