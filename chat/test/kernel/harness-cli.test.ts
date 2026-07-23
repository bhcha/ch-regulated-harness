/**
 * harness-cli.test.ts — 결정 4동작(approve/select/revise/raiseLimit)의 a2ui-action.sh 브리지 위임 검증.
 *
 * 계약 변화(dev-loop Stage 1): 예전엔 approve.sh/select.sh/revise.sh 를 위치인자로 직접 spawn 했고, 클라이언트가
 *   '--' 로 시작하는 자유텍스트를 throw 로 막았다. 이제는 이벤트를 **JSON 값**으로 a2ui-action.sh 에 넘기므로
 *   위치인자 스머글링이 원리적으로 불가하고, '--' 오인 차단은 서버(a2ui_action.py._reject_if_flaglike)가 한다.
 *   따라서 여기선 (1) 각 동작이 올바른 이벤트 JSON 으로 a2ui-action.sh 를 spawn 하는지, (2) envelope 정규화가
 *   위임 실패 진단을 보존하는지, (3) 계약 위반(rid/빈 by 등)은 여전히 spawn 전 throw 하는지를 fake spawn 으로 못 박는다.
 *
 * 결정성: node:child_process.spawn 을 mock 해 셸·네트워크 없이 인자·결과를 통제한다(실제 core spawn 없음).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 호이스트: mock 팩토리가 참조할 수 있도록 vi.hoisted 로 캡처 버퍼·통제 결과를 만든다(임포트보다 위로 끌어올려짐).
const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  result: { code: 0, stdout: "", stderr: "" } as { code: number; stdout: string; stderr: string },
}));

vi.mock("node:child_process", () => {
  const mkEmitter = (): { on: (ev: string, fn: (...a: unknown[]) => void) => void; emit: (ev: string, ...a: unknown[]) => void } => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    return {
      on(ev, fn) {
        (listeners[ev] ??= []).push(fn);
      },
      emit(ev, ...a) {
        for (const f of listeners[ev] ?? []) f(...a);
      },
    };
  };
  return {
    spawn: (cmd: string, args: string[]) => {
      h.calls.push({ cmd, args });
      const stdout = mkEmitter();
      const stderr = mkEmitter();
      const child = { ...mkEmitter(), stdout, stderr, kill: (): void => {} };
      // 리스너는 run() 이 동기로 붙인다(Promise executor 안) → 방출은 microtask 로 미뤄 그 뒤에 흐른다.
      queueMicrotask(() => {
        const r = h.result;
        if (r.stdout) stdout.emit("data", Buffer.from(r.stdout));
        if (r.stderr) stderr.emit("data", Buffer.from(r.stderr));
        child.emit("close", r.code);
      });
      return child;
    },
  };
});

import { approve, raiseLimit, revise, select } from "../../src/kernel/harness-cli.js";

const lastCall = (): { cmd: string; args: string[] } => h.calls[h.calls.length - 1]!;
const scriptOf = (c: { args: string[] }): string | undefined => c.args[0]!.split("/").pop();
const ridOf = (c: { args: string[] }): string => c.args[1]!;
const eventOf = (c: { args: string[] }): Record<string, unknown> => JSON.parse(c.args[2]!) as Record<string, unknown>;

beforeEach(() => {
  h.calls.length = 0;
  h.result = { code: 0, stdout: "", stderr: "" };
});
afterEach(() => {
  h.calls.length = 0;
});

describe("harness-cli — a2ui-action.sh 브리지 이벤트 매핑", () => {
  it("approve 는 a2ui-action.sh 를 {action,comment?,ra_ok,by} 이벤트로 spawn", async () => {
    await approve("run-1", { comment: "좋습니다", raOk: true, by: "chat:slack:U1" });
    const c = lastCall();
    expect(scriptOf(c)).toBe("a2ui-action.sh");
    expect(ridOf(c)).toBe("run-1");
    expect(eventOf(c)).toEqual({ action: "approve", comment: "좋습니다", ra_ok: true, by: "chat:slack:U1" });
  });

  it("approve comment 미지정이면 이벤트에 comment 키가 없다(ra_ok:false 는 항상 있고 서버가 is True 만 인정)", async () => {
    await approve("run-1", { by: "chat:slack:U1" });
    expect(eventOf(lastCall())).toEqual({ action: "approve", ra_ok: false, by: "chat:slack:U1" });
  });

  it("approve raOk 는 엄격 boolean — truthy 비-boolean 은 ra_ok:false 로 실린다(RA 게이트 보존)", async () => {
    for (const bad of ["true", "1", 1] as unknown[]) {
      h.calls.length = 0;
      await approve("run-1", { raOk: bad as never, by: "chat:slack:U1" });
      expect(eventOf(lastCall()).ra_ok).toBe(false);
    }
  });

  it("select 는 {action:select, value, by} 로 spawn", async () => {
    await select("run-1", "A-efficacy", { by: "chat:slack:U2" });
    const c = lastCall();
    expect(scriptOf(c)).toBe("a2ui-action.sh");
    expect(ridOf(c)).toBe("run-1");
    expect(eventOf(c)).toEqual({ action: "select", value: "A-efficacy", by: "chat:slack:U2" });
  });

  it("revise 는 {action:revise, direction, target?, by}", async () => {
    await revise("run-1", "이 표현 빼줘", { by: "chat:slack:U2", extra: "미백" });
    expect(eventOf(lastCall())).toEqual({
      action: "revise",
      direction: "이 표현 빼줘",
      target: "미백",
      by: "chat:slack:U2",
    });
  });

  it("revise extra 미지정이면 이벤트에 target 키 없음", async () => {
    await revise("run-1", "이 표현 빼줘", { by: "chat:slack:U2" });
    expect(eventOf(lastCall())).toEqual({ action: "revise", direction: "이 표현 빼줘", by: "chat:slack:U2" });
  });

  it("raiseLimit 는 {action:raise-limit} 이벤트로 spawn(by 없음)", async () => {
    await raiseLimit("run-1");
    const c = lastCall();
    expect(scriptOf(c)).toBe("a2ui-action.sh");
    expect(ridOf(c)).toBe("run-1");
    expect(eventOf(c)).toEqual({ action: "raise-limit" });
  });
});

describe("harness-cli — envelope 정규화(위임 실패 진단 보존)", () => {
  it("code!==0 이고 stderr 가 비었으면 envelope.message 를 stderr 에 채운다(worker tail(stderr) 진단 보존)", async () => {
    h.result = {
      code: 2,
      stdout: JSON.stringify({
        ok: false,
        action: "approve",
        delegate: "approve.sh",
        exit: 2,
        message: "지금은 승인 차례가 아닙니다",
        error: null,
      }),
      stderr: "",
    };
    const res = await approve("run-1", { by: "chat:slack:U1" });
    expect(res.code).toBe(2);
    expect(res.stderr).toBe("지금은 승인 차례가 아닙니다");
  });

  it("code 0(성공)은 stderr 를 손대지 않는다", async () => {
    h.result = {
      code: 0,
      stdout: JSON.stringify({ ok: true, action: "approve", delegate: "approve.sh", exit: 0, message: "ok", error: null }),
      stderr: "",
    };
    const res = await approve("run-1", { by: "chat:slack:U1" });
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("code!==0 이지만 stderr 가 이미 있으면(브리지 거부) 그대로 둔다(덮어쓰지 않음)", async () => {
    h.result = {
      code: 2,
      stdout: JSON.stringify({ ok: false, action: null, delegate: null, exit: 2, message: "m", error: "bridge" }),
      stderr: "a2ui-action: 알 수 없는 action",
    };
    const res = await approve("run-1", { by: "chat:slack:U1" });
    expect(res.stderr).toBe("a2ui-action: 알 수 없는 action");
  });

  it("envelope 파싱 불가(비-JSON stdout)면 원본 그대로(throw 없음)", async () => {
    h.result = { code: 2, stdout: "총체적 난국\n", stderr: "" };
    const res = await approve("run-1", { by: "chat:slack:U1" });
    expect(res.code).toBe(2);
    expect(res.stderr).toBe(""); // 채울 message 가 없으면 원본 유지
  });
});

describe("harness-cli — '--' 텍스트는 클라이언트 throw 대신 이벤트 값으로 spawn(서버가 거부 · 여전히 fail-closed)", () => {
  it("approve 코멘트 '--ra-ok' 는 throw 하지 않고 comment 값으로 실린다(위치인자 스머글링 불가 · 서버 _reject_if_flaglike)", async () => {
    // 서버 거부를 시뮬레이트(code=2) → 관측은 여전히 fail-closed.
    h.result = { code: 2, stdout: "", stderr: "a2ui-action: '--' 로 시작할 수 없습니다" };
    const res = await approve("run-1", { comment: "--ra-ok", by: "chat:slack:U1" });
    expect(eventOf(lastCall())).toEqual({ action: "approve", comment: "--ra-ok", ra_ok: false, by: "chat:slack:U1" });
    expect(res.code).not.toBe(0); // fail-closed 보존
  });

  it("select 옵션 키 '--by' 도 value 로 실려 spawn(서버 거부)", async () => {
    h.result = { code: 2, stdout: "", stderr: "reject" };
    await select("run-1", "--by", { by: "chat:slack:U1" });
    expect(eventOf(lastCall())).toEqual({ action: "select", value: "--by", by: "chat:slack:U1" });
  });

  it("revise 사유 '--ra-ok' 도 direction 으로 실려 spawn(서버 거부)", async () => {
    h.result = { code: 2, stdout: "", stderr: "reject" };
    await revise("run-1", "--ra-ok", { by: "chat:slack:U1" });
    expect(eventOf(lastCall())).toEqual({ action: "revise", direction: "--ra-ok", by: "chat:slack:U1" });
  });
});

describe("harness-cli — 호출부 계약 위반은 여전히 spawn 전 throw", () => {
  it("경로 탈출 rid(../x)는 spawn 전 거부(셸 미호출)", () => {
    expect(() => approve("../x", { by: "chat:slack:U1" })).toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("슬래시 포함 rid 도 거부", () => {
    expect(() => select("a/b", "A", { by: "chat:slack:U1" })).toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("빈 by 는 거부(감사 추적 필수)", () => {
    expect(() => approve("run-1", { by: "" })).toThrow(/행위자/);
    expect(h.calls).toHaveLength(0);
  });
  it("select 빈 옵션 키는 거부", () => {
    expect(() => select("run-1", "", { by: "chat:slack:U1" })).toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("revise 빈 사유는 거부", () => {
    expect(() => revise("run-1", "  ", { by: "chat:slack:U1" })).toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("raiseLimit 도 rid 안전성 검증(../x throw · 셸 미호출)", () => {
    expect(() => raiseLimit("../x")).toThrow();
    expect(h.calls).toHaveLength(0);
  });
});
