/**
 * job-queue.test.ts — run별 FIFO 잡큐 검증(fake 워커 · 셸/네트워크 없음).
 *   1) submit 은 처리 완료를 기다리지 않고 즉시 resolve(ack-후-비동기)
 *   2) 같은 run_id → 순차(FIFO): 앞 잡이 끝나야 다음 잡이 시작
 *   3) 다른 run_id → 병렬: 서로를 기다리지 않고 동시에 시작
 *   4) 완료 시 onOutcome 이 잡별·완료순서대로 호출
 *   5) 앞 잡이 예외로 끝나도 같은 run 의 다음 잡은 실행(체인 격리) + onError 노출
 */
import { describe, expect, it } from "vitest";
import { JobQueue, type WorkerLike } from "../../src/kernel/job-queue.js";
import type { WorkerOutcome } from "../../src/kernel/worker.js";
import type { Job } from "../../src/types/jobs.js";

/** 마이크로태스크 전부 배수(매크로태스크 경계). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** generate 잡 헬퍼(stage 로 잡을 유일 식별). */
function genJob(run: string, stage: string): Job {
  return { kind: "generate", run_id: run, payload: { stage }, actor: "chat:slack:U1" };
}

function outcomeOf(job: Job): WorkerOutcome {
  return { ok: true, kind: job.kind, run_id: job.run_id, message: "done", next: null };
}

const tagOf = (j: Job): string => `${j.run_id}:${String(j.payload.stage)}`;

/** 각 잡의 완료 시점을 수동 release 할 수 있는 워커(시작·완료 순서 관찰용). */
function controllableWorker(): {
  worker: WorkerLike;
  started: string[];
  release: (tag: string) => void;
} {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const worker: WorkerLike = {
    process(job: Job): Promise<WorkerOutcome> {
      const tag = tagOf(job);
      started.push(tag);
      return new Promise<WorkerOutcome>((resolve) => {
        releases.set(tag, () => resolve(outcomeOf(job)));
      });
    },
  };
  const release = (tag: string): void => {
    const r = releases.get(tag);
    if (!r) throw new Error(`no pending job to release: ${tag}`);
    r();
  };
  return { worker, started, release };
}

describe("JobQueue ack-후-비동기", () => {
  it("submit 은 처리 완료를 기다리지 않고 즉시 resolve", async () => {
    let started = false;
    let delivered = false;
    const worker: WorkerLike = {
      process(): Promise<WorkerOutcome> {
        started = true; // process 진입(동기) 표시
        return new Promise<WorkerOutcome>(() => {}); // 절대 resolve 안 함 → 완료 회신도 없음
      },
    };
    const q = new JobQueue({
      worker,
      onOutcome: () => {
        delivered = true; // process 가 resolve 돼야만 호출된다(여기선 영원히 미호출)
      },
    });
    await q.submit(genJob("run-A", "s1")); // 완료를 기다리면 여기서 영원히 블록됨
    expect(delivered).toBe(false); // submit 이 처리 완료를 기다리지 않았다
    await flush();
    expect(started).toBe(true); // 처리는 비동기로 시작됨
    expect(delivered).toBe(false); // 그러나 완료 회신은 아직(작업이 끝나지 않았으므로)
  });
});

describe("JobQueue 순서 보장", () => {
  it("같은 run 은 순차(FIFO) — 앞 잡이 끝나야 다음 잡이 시작", async () => {
    const { worker, started, release } = controllableWorker();
    const q = new JobQueue({ worker });
    await q.submit(genJob("run-A", "s1"));
    await q.submit(genJob("run-A", "s2"));
    await q.submit(genJob("run-A", "s3"));

    await flush();
    expect(started).toEqual(["run-A:s1"]); // 첫 잡만 시작(뒤는 대기)

    release("run-A:s1");
    await flush();
    expect(started).toEqual(["run-A:s1", "run-A:s2"]);

    release("run-A:s2");
    await flush();
    expect(started).toEqual(["run-A:s1", "run-A:s2", "run-A:s3"]);

    release("run-A:s3");
    await flush();
  });

  it("다른 run 은 병렬 — 서로를 기다리지 않고 동시에 시작", async () => {
    const { worker, started, release } = controllableWorker();
    const q = new JobQueue({ worker });
    await q.submit(genJob("run-A", "s1"));
    await q.submit(genJob("run-B", "s1"));

    await flush();
    expect([...started].sort()).toEqual(["run-A:s1", "run-B:s1"]); // 둘 다 시작(병렬)

    release("run-A:s1");
    release("run-B:s1");
    await flush();
  });
});

describe("JobQueue 완료 회신(onOutcome)", () => {
  it("완료 시 onOutcome 이 잡별로, 같은 run 은 완료(=제출) 순서대로 호출", async () => {
    const delivered: string[] = [];
    const { worker, release } = controllableWorker();
    const q = new JobQueue({
      worker,
      onOutcome: (_o, job) => {
        delivered.push(tagOf(job));
      },
    });
    await q.submit(genJob("run-A", "s1"));
    await q.submit(genJob("run-A", "s2"));

    await flush();
    release("run-A:s1");
    await flush();
    expect(delivered).toEqual(["run-A:s1"]);

    release("run-A:s2");
    await flush();
    expect(delivered).toEqual(["run-A:s1", "run-A:s2"]);
  });

  it("outcome 이 submit 한 잡 그대로 전달된다", async () => {
    const seen: WorkerOutcome[] = [];
    const worker: WorkerLike = { process: async (job) => outcomeOf(job) };
    const q = new JobQueue({
      worker,
      onOutcome: (o) => {
        seen.push(o);
      },
    });
    await q.submit(genJob("run-A", "s1"));
    await q.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.run_id).toBe("run-A");
    expect(seen[0]!.ok).toBe(true);
  });
});

describe("JobQueue 견고성", () => {
  it("앞 잡 처리가 예외로 끝나도 같은 run 의 다음 잡은 실행(체인 격리) + onError 노출", async () => {
    const seen: string[] = [];
    const worker: WorkerLike = {
      process: async (job) => {
        seen.push(String(job.payload.stage));
        if (job.payload.stage === "boom") throw new Error("의도된 실패");
        return outcomeOf(job);
      },
    };
    const errs: unknown[] = [];
    const q = new JobQueue({
      worker,
      onError: (e) => {
        errs.push(e);
      },
    });
    await q.submit(genJob("run-A", "boom"));
    await q.submit(genJob("run-A", "after"));
    await q.drain();
    expect(seen).toEqual(["boom", "after"]); // 앞 잡 실패에도 다음 잡 실행됨
    expect(errs).toHaveLength(1);
  });

  it("drain 은 대기 중인 모든 잡이 끝날 때까지 기다리고 activeRuns 를 0 으로 되돌린다", async () => {
    const done: string[] = [];
    const worker: WorkerLike = {
      process: async (job) => {
        await flush();
        done.push(job.run_id);
        return outcomeOf(job);
      },
    };
    const q = new JobQueue({ worker });
    await q.submit(genJob("run-A", "s1"));
    await q.submit(genJob("run-B", "s1"));
    expect(q.activeRuns).toBe(2);
    await q.drain();
    expect([...done].sort()).toEqual(["run-A", "run-B"]);
    expect(q.activeRuns).toBe(0);
  });
});
