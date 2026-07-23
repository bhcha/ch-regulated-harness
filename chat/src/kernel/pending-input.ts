/**
 * pending-input.ts — 스레드별 '다음 입력 대기' 상태(PendingInputStore).
 *
 * 배경(UI 공통분모 원칙): 모달·슬래시·파일첨부는 Slack 전용이라 쓰지 않는다(Google Chat 미지원).
 *   자유 입력은 전부 **스레드 답글**로 받는다 — 그러려면 "이 스레드가 지금 무엇을 기다리는가"를 알아야 한다.
 *   그 대기 상태의 단일 저장소가 이 모듈이다(스레드당 최대 1개, 순차 흐름).
 *
 * 종류:
 *   · setup    — 새 작업 설정 중(도메인/포맷 Select 선택값 수집, [시작] 전)
 *   · wb       — 워킹백워드 본문 붙여넣기 대기(답글 텍스트 → working-backwards.md)
 *   · feedback — 보완 사유 대기(답글 텍스트 → revise 잡)
 *   · intake_draft — NL 파일 인입 제안이 **제품명만 미정**일 때의 대기(P3-2 보완). 파싱된 파일·도메인·포맷을 담아,
 *                    다음 답글(제품명)을 받으면 완성해 [이 자료로 시작] 버튼 제안으로 승격한다. 확정 버튼 없음(미완성).
 *   · intake   — NL 파일 인입 제안 확정 대기(P3-2 · 확정 버튼 클릭 시 스테이징 + intake 잡). 확정 시점에 경로를 재검증한다.
 *
 * 저장: 주어진 StateAdapter(get/set/delete) 위에 예약 키 `input:<threadId>` 로. TTL 기본 24h(방치 정리).
 */
import type { Lock, StateAdapter } from "chat";
import type { NlFileRef } from "./nl/parser.js";

export type PendingInput =
  | { kind: "setup"; product?: string; domain?: string; format?: string }
  | { kind: "wb"; rid: string }
  | { kind: "feedback"; rid: string }
  | { kind: "intake_draft"; files: NlFileRef[]; domain: string; format: string }
  | { kind: "intake"; files: NlFileRef[]; domain: string; format: string; product: string; nonce: string };

const KEY = (threadId: string): string => `input:${threadId}`;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class PendingInputStore {
  constructor(
    private readonly state: StateAdapter,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async get(threadId: string): Promise<PendingInput | null> {
    return this.state.get<PendingInput>(KEY(threadId));
  }

  async set(threadId: string, input: PendingInput): Promise<void> {
    await this.state.set(KEY(threadId), input, this.ttlMs);
  }

  async clear(threadId: string): Promise<void> {
    await this.state.delete(KEY(threadId));
  }

  /**
   * setup 상태의 부분 갱신(제품명 답글·Select 선택 수집).
   * ⚠ 락 안에서 read-modify-write + **재검증**:
   *   · 동시 Select 이벤트가 서로를 덮어써 필드가 유실되지 않게 직렬화(도메인/포맷 동시 수집).
   *   · 현재 상태가 setup(또는 없음)일 때만 병합 — [시작]이 pending 을 wb 로 전이한 '뒤' 도착한 늦은 Select 가
   *     setup 을 되살리면 다음 답글(WB 붙여넣기)이 제품명으로 오소비된다(TOCTOU). 그 경우 no-op 로 현재 상태를 반환.
   */
  async mergeSetup(
    threadId: string,
    patch: { product?: string; domain?: string; format?: string },
  ): Promise<PendingInput | null> {
    const lock = await this.acquireMergeLock(`input-merge:${threadId}`);
    try {
      const cur = await this.get(threadId);
      if (cur !== null && cur.kind !== "setup") return cur; // 락 안 재검증 — setup 밖 전이 뒤엔 병합 금지(no-op)
      const base: PendingInput = cur?.kind === "setup" ? cur : { kind: "setup" };
      const next: PendingInput = { ...base, ...patch, kind: "setup" };
      await this.set(threadId, next);
      return next;
    } finally {
      if (lock) await this.state.releaseLock(lock);
    }
  }

  /** merge 락 획득(짧은 재시도 후 best-effort — 교착보다 드문 레이스 퇴행이 안전). */
  private async acquireMergeLock(key: string): Promise<Lock | null> {
    for (let i = 0; i < 100; i++) {
      const l = await this.state.acquireLock(key, 5000);
      if (l) return l;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }
}
