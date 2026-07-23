/**
 * socket-resilience.test.ts — 라이브 견고성 가드 단위 검증(순수 판별 + 설치 seam · 실 process/Slack 무접촉).
 */
import { describe, expect, it } from "vitest";
import { installLiveResilience, isTransientSocketError } from "../../src/live/socket-resilience.js";

describe("isTransientSocketError — 알려진 일시-소켓 오류만 true(그 외 fail-closed)", () => {
  it("code=slack_socket_mode_no_reply_received_error → true", () => {
    expect(isTransientSocketError({ code: "slack_socket_mode_no_reply_received_error", message: "x" })).toBe(true);
  });
  it("name=NoReplyReceivedError → true", () => {
    const e = new Error("whatever");
    e.name = "NoReplyReceivedError";
    expect(isTransientSocketError(e)).toBe(true);
  });
  it("메시지 'client is not ready' → true(실측 메시지)", () => {
    expect(isTransientSocketError(new Error("Failed to send a WebSocket message as the client is not ready"))).toBe(true);
  });
  it("메시지 'no active connection' → true(실측 메시지)", () => {
    expect(isTransientSocketError(new Error("Failed to send a message as the client has no active connection"))).toBe(true);
  });
  it("임의 Error → false(치명적 취급)", () => {
    expect(isTransientSocketError(new Error("something broke"))).toBe(false);
  });
  it("null·undefined·무관 객체 → false", () => {
    expect(isTransientSocketError(null)).toBe(false);
    expect(isTransientSocketError(undefined)).toBe(false);
    expect(isTransientSocketError({ code: "ENOENT", message: "file not found" })).toBe(false);
  });
});

describe("installLiveResilience — 일시 오류=생존, 그 외=fail-closed 종료", () => {
  /** 주입 fake: 등록된 핸들러를 붙잡아 직접 발화한다(실 process 무접촉). */
  function harness() {
    const handlers: Record<string, (err: unknown) => void> = {};
    const warns: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    installLiveResilience({
      on: (e, h) => {
        handlers[e] = h;
      },
      warn: (l) => warns.push(l),
      error: (l) => errors.push(l),
      fatalExit: (c) => exits.push(c),
    });
    return { handlers, warns, errors, exits };
  }

  it("unhandledRejection 이 일시-소켓 오류 → warn 로그 + 종료 안 함(생존)", () => {
    const h = harness();
    h.handlers.unhandledRejection!({ code: "slack_socket_mode_no_reply_received_error", message: "not ready" });
    expect(h.exits).toEqual([]); // 죽지 않는다
    expect(h.warns.some((l) => l.includes("프로세스 유지"))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("unhandledRejection 이 임의 오류 → error 로그 + exit(1)(fail-closed)", () => {
    const h = harness();
    h.handlers.unhandledRejection!(new Error("real bug"));
    expect(h.exits).toEqual([1]);
    expect(h.errors.some((l) => l.includes("치명적"))).toBe(true);
    expect(h.warns).toEqual([]);
  });

  it("uncaughtException 도 같은 규칙 — 일시=생존 · 그 외=exit(1)", () => {
    const h = harness();
    const transient = new Error("the client has no active connection");
    transient.name = "NoReplyReceivedError";
    h.handlers.uncaughtException!(transient);
    expect(h.exits).toEqual([]);
    h.handlers.uncaughtException!(new Error("fatal"));
    expect(h.exits).toEqual([1]);
  });

  it("두 이벤트(unhandledRejection·uncaughtException) 모두 등록된다", () => {
    const h = harness();
    expect(typeof h.handlers.unhandledRejection).toBe("function");
    expect(typeof h.handlers.uncaughtException).toBe("function");
  });
});
