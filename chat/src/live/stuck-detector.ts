/**
 * stuck-detector.ts — 라이브 런이 **같은 next-action 에 임계 시간보다 오래 머물면** 표시하는 순수 디텍터.
 *
 * ── 왜 시간 기반인가 ─────────────────────────────────────────────────────────────
 *   analyzer.ts 의 `stuck` 는 **같은 게이트가 N회 재현**(전진 없는 루프)을 잡는다(구조·횟수 기반). 라이브는
 *   실 벽시계로 느리게 돌고(생성 45분+·심의 비결정), 재현 횟수가 아니라 "한 화면에서 **몇 분째** 안 움직이나"가
 *   문제 신호다 — 운영자 세션이 브리지 생성 잡을 안 집었거나·심의 원격 ADK 가 늘어지거나·데몬이 죽었을 때.
 *   그래서 라이브 판정 리포트는 **시간 기반** stuck 을 따로 본다(analyzer 의 횟수 기반과 상보적).
 *
 * ── 순수·주입 시계(오프라인 검증 가능) ───────────────────────────────────────────
 *   플랫폼·fs·네트워크·벽시계를 **전혀** 만지지 않는다. 입력 = {시각, next-action 서명} 스냅샷 시퀀스 + 임계(ms) +
 *   기준 시각(now). 출력 = stuck 여부·서명·머문 시간. 같은 입력이면 항상 같은 출력(단위 테스트가 임계 전후를 못 박는다).
 */
import type { NextAction } from "../types/contract.js";

/** 기본 임계 = 15분(라이브 생성/심의는 느리므로 넉넉히 · 운영자가 조정). */
export const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/** next-action 스냅샷 1건 — 관측 시각(ms) + 그 시점 next-action 서명. */
export interface StuckSnapshot {
  atMs: number;
  /** next-action 을 식별하는 안정 서명(nextActionSignature 로 만들거나, 테스트는 임의 문자열). */
  signature: string;
}

/** stuck 판정 결과. */
export interface StuckVerdict {
  /** 마지막 서명이 임계 이상 유지됐는가. */
  stuck: boolean;
  /** 현재(마지막) next-action 서명(스냅샷 없으면 null). */
  signature: string | null;
  /** 그 서명이 **처음 나타난**(마지막으로 바뀐) 시각 ms(없으면 null). */
  sinceMs: number | null;
  /** 그 시각부터 now 까지 머문 시간 ms(없으면 null). */
  elapsedMs: number | null;
}

/**
 * next-action → 안정 서명. 같은 게이트/단계/상태/보완회차면 같은 문자열(전진하면 바뀐다).
 *   phase·step·gate·status·action·stage·iteration 을 묶는다(무엇을 기다리는지가 바뀌면 서명이 바뀐다).
 */
export function nextActionSignature(na: NextAction): string {
  const stage = typeof na.stage === "string" ? na.stage : "";
  const iter = na.iteration === null || na.iteration === undefined ? "" : String(na.iteration);
  return `${na.phase}#${na.step}#${na.gate ?? ""}#${na.status}#${na.action}#${stage}#${iter}`;
}

/**
 * 순수 stuck 판정. 마지막 스냅샷의 서명이 **연속으로** 유지돼 온 시작 시각(sinceMs)을 뒤에서부터 찾아,
 *   now - sinceMs 가 임계 이상이면 stuck. 스냅샷이 없으면 stuck 아님.
 *   ⚠ '임계 이상(>=)'이 stuck 이다 — 정확히 임계 시점에 발화한다(경계 포함). 그 미만은 아직 아니다.
 */
export function detectStuck(
  snapshots: readonly StuckSnapshot[],
  nowMs: number,
  thresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS,
): StuckVerdict {
  if (snapshots.length === 0) return { stuck: false, signature: null, sinceMs: null, elapsedMs: null };
  const last = snapshots[snapshots.length - 1]!;
  // 뒤에서부터 마지막 서명과 같은 연속 구간의 시작(가장 이른) 시각을 찾는다 = 이 서명이 마지막으로 바뀐 시점.
  let sinceMs = last.atMs;
  for (let i = snapshots.length - 2; i >= 0; i--) {
    if (snapshots[i]!.signature === last.signature) sinceMs = snapshots[i]!.atMs;
    else break;
  }
  const elapsedMs = Math.max(0, nowMs - sinceMs);
  return { stuck: elapsedMs >= thresholdMs, signature: last.signature, sinceMs, elapsedMs };
}

/**
 * 라이브 루프용 얇은 상태기(선택) — 관측을 순서대로 쌓고 evaluate(now) 로 detectStuck 을 부른다. 로직은 전부
 *   순수 detectStuck 이 갖고, 이 클래스는 스냅샷 누적만 한다(주입 시계 · 벽시계 미접촉). 라이브 드라이버가
 *   매 정지 후 현재 next-action 서명을 observe 하고, 판정 리포트가 evaluate 결과를 싣는다.
 */
export class StuckDetector {
  private readonly snapshots: StuckSnapshot[] = [];
  private readonly thresholdMs: number;

  constructor(thresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS) {
    this.thresholdMs = thresholdMs;
  }

  /** 스냅샷 추가(같은 서명이 반복돼도 그대로 쌓는다 — detectStuck 이 연속 구간을 계산). */
  observe(atMs: number, signature: string): void {
    this.snapshots.push({ atMs, signature });
  }

  /** 현재까지 스냅샷으로 stuck 판정(주입 now). */
  evaluate(nowMs: number): StuckVerdict {
    return detectStuck(this.snapshots, nowMs, this.thresholdMs);
  }

  /** 쌓인 스냅샷(방어적 복사). */
  history(): StuckSnapshot[] {
    return this.snapshots.map((s) => ({ ...s }));
  }
}
