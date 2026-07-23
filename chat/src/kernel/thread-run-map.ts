/**
 * thread-run-map.ts — 플랫폼 스레드ID ↔ 하네스 run_id 양방향 매핑(ThreadRunMap).
 *
 * chat SDK 는 플랫폼 threadId(예 `slack:C123:169…`)로 대화를 식별하고, 하네스는 run_id 로
 * 실행을 식별한다. 봇이 버튼/모달/메시지를 받으면 "이 스레드가 어느 run 인가"(그 반대도)를 알아야
 * core scripts 를 올바른 run 에 대해 spawn 할 수 있다.
 *
 * 구현: 별도 파일 포맷을 만들지 않고 주어진 StateAdapter 의 get/set 를 재사용한다.
 *   예약 키 `map:thread:<threadId>` → run_id · `map:run:<rid>` → threadId (양방향 저장).
 */
import type { Lock, StateAdapter } from "chat";

/** 예약 키 접두어(다른 캐시 키와 충돌 방지). */
const THREAD_KEY = (threadId: string): string => `map:thread:${threadId}`;
const RUN_KEY = (rid: string): string => `map:run:${rid}`;
/**
 * rebind 직렬화용 **전역** 락 키(SDK 의 스레드 동시성 락과 네임스페이스 분리).
 * 스레드별이 아니라 전역인 이유: 같은 스레드뿐 아니라 **서로 다른 스레드가 같은 run 에 동시 bind** 하는 경우도
 * 직렬화해야 양방향 불변식이 깨지지 않는다(스레드·run 두 키를 잡으면 교착 위험 → 전역 단일 락이 안전).
 * rebind 는 run 생성 시 1회라 저빈도 — 전역 직렬화 비용 무시 가능.
 */
const REBIND_LOCK = "rebind:__global__";

export class ThreadRunMap {
  constructor(private readonly state: StateAdapter) {}

  /**
   * 스레드 ↔ run 을 양방향으로 묶는다(멱등: 재호출 시 최신 값으로 덮어씀).
   * 재바인딩 시 **양방향 고아 매핑을 먼저 제거**한다 — 안 그러면 옛 run→스레드(또는 옛 스레드→run)가 남아
   * 나중에 옛 키로 조회하면 엉뚱한 run 의 스레드로 라우팅/edit 될 수 있다.
   * 전체 재바인딩(읽기-삭제-쓰기)을 스레드 키 락으로 **직렬화**한다 — 동시 bind 가 forward/inverse 를
   * 반쪽만 갱신해 고아 forward 키가 남는 것을 막는다(양방향 불변식 보존).
   */
  async bindThreadToRun(threadId: string, rid: string): Promise<void> {
    const lock = await this.acquireRebindLock(REBIND_LOCK);
    try {
      const prevRid = await this.state.get<string>(THREAD_KEY(threadId));
      if (prevRid && prevRid !== rid) await this.state.delete(RUN_KEY(prevRid));
      const prevThread = await this.state.get<string>(RUN_KEY(rid));
      if (prevThread && prevThread !== threadId) await this.state.delete(THREAD_KEY(prevThread));
      await this.state.set(THREAD_KEY(threadId), rid);
      await this.state.set(RUN_KEY(rid), threadId);
    } finally {
      if (lock) await this.state.releaseLock(lock);
    }
  }

  /** rebind 락 획득(짧은 재시도 후 best-effort). 못 얻어도 진행 — 교착보다 드문 레이스 퇴행이 안전. */
  private async acquireRebindLock(key: string): Promise<Lock | null> {
    for (let i = 0; i < 100; i++) {
      const l = await this.state.acquireLock(key, 5000);
      if (l) return l;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }

  /** 스레드가 가리키는 run_id(없으면 null). */
  async runForThread(threadId: string): Promise<string | null> {
    return this.state.get<string>(THREAD_KEY(threadId));
  }

  /** run 이 열려 있는 스레드ID(없으면 null). */
  async threadForRun(rid: string): Promise<string | null> {
    return this.state.get<string>(RUN_KEY(rid));
  }
}
