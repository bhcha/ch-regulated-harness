/**
 * stuck-detector.test.ts — 시간 기반 stuck 디텍터 단위(순수 · 주입 시계). 임계 전후를 못 박는다.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUCK_THRESHOLD_MS,
  detectStuck,
  nextActionSignature,
  StuckDetector,
  type StuckSnapshot,
} from "../../src/live/stuck-detector.js";
import type { NextAction } from "../../src/types/contract.js";

const T0 = 1_000_000;
const min = (n: number): number => n * 60 * 1000;

describe("detectStuck(순수)", () => {
  it("스냅샷 없음 → stuck 아님", () => {
    expect(detectStuck([], T0)).toEqual({ stuck: false, signature: null, sinceMs: null, elapsedMs: null });
  });

  it("같은 서명이 임계 '미만' 유지 → stuck 아님(경계 직전)", () => {
    const snaps: StuckSnapshot[] = [
      { atMs: T0, signature: "brief-approve" },
      { atMs: T0 + min(5), signature: "brief-approve" },
    ];
    const now = T0 + DEFAULT_STUCK_THRESHOLD_MS - 1; // 임계 1ms 전
    const v = detectStuck(snaps, now);
    expect(v.stuck).toBe(false);
    expect(v.signature).toBe("brief-approve");
    expect(v.sinceMs).toBe(T0); // 연속 구간의 시작(가장 이른)
    expect(v.elapsedMs).toBe(now - T0);
  });

  it("같은 서명이 임계 '이상' 유지 → stuck(경계 포함)", () => {
    const snaps: StuckSnapshot[] = [{ atMs: T0, signature: "brief-approve" }];
    expect(detectStuck(snaps, T0 + DEFAULT_STUCK_THRESHOLD_MS).stuck).toBe(true); // 정확히 임계 = stuck
    expect(detectStuck(snaps, T0 + DEFAULT_STUCK_THRESHOLD_MS + min(10)).stuck).toBe(true);
  });

  it("서명이 최근에 바뀜 → sinceMs 는 바뀐 시점, 임계 전이라 stuck 아님", () => {
    const snaps: StuckSnapshot[] = [
      { atMs: T0, signature: "ingest" }, // 오래된 다른 서명
      { atMs: T0 + min(100), signature: "concept-select" }, // 최근 전환
    ];
    const now = T0 + min(100) + min(3); // 전환 후 3분
    const v = detectStuck(snaps, now, min(15));
    expect(v.signature).toBe("concept-select");
    expect(v.sinceMs).toBe(T0 + min(100)); // 옛 서명 시각(T0)이 아니라 전환 시각
    expect(v.stuck).toBe(false);
  });

  it("전환 후 그 서명으로 임계 이상 정체 → stuck", () => {
    const snaps: StuckSnapshot[] = [
      { atMs: T0, signature: "ingest" },
      { atMs: T0 + min(2), signature: "brief-approve" },
    ];
    const now = T0 + min(2) + min(20);
    expect(detectStuck(snaps, now, min(15)).stuck).toBe(true);
  });

  it("커스텀 임계를 존중한다", () => {
    const snaps: StuckSnapshot[] = [{ atMs: T0, signature: "s" }];
    expect(detectStuck(snaps, T0 + min(1), min(2)).stuck).toBe(false);
    expect(detectStuck(snaps, T0 + min(2), min(2)).stuck).toBe(true);
  });
});

describe("nextActionSignature", () => {
  const base: NextAction = {
    rid: "r1",
    phase: "01-brief",
    phase_label: "브리프",
    step: "human",
    gate: "user",
    status: "pending",
    awaiting: "user",
    iteration: 0,
    action: "approve",
  } as NextAction;

  it("같은 게이트 = 같은 서명 · 전진하면 서명 변화", () => {
    const sig = nextActionSignature(base);
    expect(nextActionSignature({ ...base })).toBe(sig);
    // 페이즈 전진 → 다른 서명.
    expect(nextActionSignature({ ...base, phase: "02-concept" } as NextAction)).not.toBe(sig);
    // 보완 회차 증가 → 다른 서명(같은 게이트라도 iteration 이 다르면 전진 신호).
    expect(nextActionSignature({ ...base, iteration: 1 } as NextAction)).not.toBe(sig);
  });
});

describe("StuckDetector(상태기)", () => {
  it("observe 로 쌓고 evaluate(now) 로 판정한다", () => {
    const d = new StuckDetector(min(15));
    d.observe(T0, "brief-approve");
    d.observe(T0 + min(5), "brief-approve");
    expect(d.evaluate(T0 + min(10)).stuck).toBe(false);
    expect(d.evaluate(T0 + min(20)).stuck).toBe(true);
    expect(d.history().length).toBe(2);
  });
});
