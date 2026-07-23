/**
 * job-queue.ts — run별 FIFO 잡큐(ack-후-비동기).
 *
 * 역할: JobSubmitter 를 구현한다. 버튼/모달 핸들러가 submit(job) 으로 잡을 넘기면
 *   큐에 적재하고 '즉시 resolve' 한다(Slack 3초 ack 예산 안). 실제 셸 실행은 이 큐가 비동기로,
 *   run_id별 프로미스 체인 위에서 주입된 Worker.process 로 위임한다.
 *
 * 순서 보장:
 *   · 같은 run_id → 순차(FIFO): 한 run 의 잡들은 이전 잡이 '완료+회신'된 뒤에야 다음이 시작된다
 *     (한 run 의 상태를 두 잡이 동시에 밟지 않게 — state 경합 방지).
 *   · 다른 run_id → 병렬: run마다 독립 체인이라 서로를 기다리지 않는다.
 *
 * 견고성: 한 잡의 처리·회신이 예외로 끝나도 체인을 오염시키지 않는다(catch 흡수) → 같은 run 의 다음 잡은
 *   반드시 실행된다. 정착한 체인은 맵에서 스스로 제거해 run_id 무한 성장 없이 유지한다.
 *
 * 불변식(dev-loop-grounding 3): state.json 직접 쓰기 0 — 큐는 순서만 관장하고, 상태 변이는 Worker(→core scripts)만.
 */
import type { Job, JobSubmitter } from "../types/jobs.js";
import type { WorkerOutcome } from "./worker.js";

/** 다음 매크로태스크까지 양보 — 동기 블로킹 워커 시작 전에 submit()·ack 가 현재 틱에서 먼저 끝나게 한다. */
const nextMacrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 큐가 위임하는 워커 계약(Worker.process 만 의존 — 테스트 fake 교체 가능). */
export interface WorkerLike {
  process(job: Job): Promise<WorkerOutcome>;
}

/** 잡 완료 회신 싱크(F2 어댑터의 카드 edit). 잡별로 완료 순서대로 호출된다. */
export type OutcomeSink = (outcome: WorkerOutcome, job: Job) => void | Promise<void>;

/** 예기치 못한 처리 예외 싱크(진단/알림). Worker.process 는 보통 예외를 흡수하지만 방어적으로 노출. */
export type ErrorSink = (err: unknown, job: Job) => void | Promise<void>;

/** 큐 의존성. worker 만 필수, 회신/오류 싱크는 선택. */
export interface JobQueueDeps {
  worker: WorkerLike;
  onOutcome?: OutcomeSink;
  onError?: ErrorSink;
}

/**
 * JobQueue — run별 FIFO 잡큐(JobSubmitter 구현).
 * submit 은 체인 적재만 하고 즉시 resolve 한다(처리를 기다리지 않음). 처리는 주입된 worker 에 위임한다.
 */
export class JobQueue implements JobSubmitter {
  private readonly worker: WorkerLike;
  private readonly onOutcome?: OutcomeSink;
  private readonly onError?: ErrorSink;
  /** run_id → 그 run 의 '마지막 잡까지 이어진' 체인 프로미스(정착 시 스스로 제거). */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: JobQueueDeps) {
    this.worker = deps.worker;
    this.onOutcome = deps.onOutcome;
    this.onError = deps.onError;
  }

  /**
   * 잡을 run별 FIFO 체인 끝에 적재하고 즉시 resolve(ack-후-비동기 · 셸 실행 안 함).
   * 같은 run 은 이전 잡 완료 뒤 순차 처리, 다른 run 은 독립 체인이라 병렬 처리된다.
   */
  async submit(job: Job): Promise<void> {
    // 이전 체인은 항상 '정상 정착'(아래 catch 로 rejection 미전파)이라 then 이 반드시 다음 잡을 실행한다.
    const prev = this.chains.get(job.run_id) ?? Promise.resolve();
    // 자기참조(정착 시 자기 항목만 정리)를 위해 먼저 선언 후 할당.
    let done: Promise<void>;
    done = prev
      // ★ 매크로태스크 경계: worker.process 는 첫 await 전에 spawnSync(동기 셸)를 돌 수 있다. 빈 큐면 prev 가
      //   이미 resolved 라 then 콜백이 같은 틱 마이크로태스크로 실행돼 submit()·ack 가 끝나기 전 이벤트루프를
      //   블로킹한다 → Slack 3초 ack 창을 놓친다. setImmediate 로 한 틱 미뤄 submit·ack 를 먼저 끝낸다(FIFO 불변).
      .then(nextMacrotask)
      .then(() => this.worker.process(job))
      .then(
        (outcome) => this.deliver(outcome, job),
        (err) => this.deliverError(err, job),
      )
      .catch(() => {
        // 회신 싱크(onOutcome/onError) 자체가 던져도 체인을 오염시키지 않는다(다음 잡 실행 보장).
      })
      .finally(() => {
        // 이 잡이 이 run 의 마지막이면 맵에서 제거(무한 성장 방지). 뒤에 새 잡이 붙었으면 그대로 둔다.
        if (this.chains.get(job.run_id) === done) this.chains.delete(job.run_id);
      });
    this.chains.set(job.run_id, done);
    // 여기서 즉시 반환 — worker.process 는 위 체인(마이크로태스크)에서 비동기로 시작된다.
  }

  /** 진행 중(대기 포함)인 run 수 — 진단/테스트용. */
  get activeRuns(): number {
    return this.chains.size;
  }

  /** 현재 적재된 모든 잡이 처리·회신 완료될 때까지 대기(그레이스풀 셧다운·테스트용). */
  async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }

  private async deliver(outcome: WorkerOutcome, job: Job): Promise<void> {
    if (this.onOutcome) await this.onOutcome(outcome, job);
  }

  private async deliverError(err: unknown, job: Job): Promise<void> {
    if (this.onError) await this.onError(err, job);
  }
}
