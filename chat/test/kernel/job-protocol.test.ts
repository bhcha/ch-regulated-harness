/**
 * job-protocol.test.ts — 잡 큐 프로토콜 v2 수명주기 검증(실 fs tmpdir · 시계 주입 · sleep 0 · 셸 0).
 *
 * 결정성 규약:
 *   · 시각은 전부 주입 상수(T0 기준)다 — 실시간·파일 mtime 에 기대는 단정은 두지 않는다(초 단위 mtime 비교는
 *     같은 초에 끝나면 간헐 오실패한다는 이 레포의 교훈).
 *   · 경합 검증은 '누가 이겼나'(OS 가 정함 = 비결정적)가 아니라 '**정확히 하나만** 이겼나'(결정적)를 본다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_PROTOCOL_VERSION,
  buildGenerateJob,
  checkBudget,
  claimJob,
  completeJob,
  computeExpiresAt,
  doubleCheckJob,
  enqueueJob,
  failJob,
  findBlockingClaimedJob,
  isGenerateTurn,
  isSafeConsumerId,
  jobDirsOf,
  jobFileName,
  listPendingJobs,
  parseDeadline,
  reapClaimedJobs,
  readJobFile,
  recallPendingJob,
  releaseJob,
  takePendingJob,
  writePendingJob,
  type EnqueueDeps,
  type EnqueueResult,
  type JobDirs,
  type ReapDeps,
  type TakeDeps,
} from "../../src/kernel/job-protocol.js";
import type { NextAction } from "../../src/types/contract.js";
import type { GenerateJobFile } from "../../src/types/jobs.js";

/** 고정 기준 시각(주입) — 실시간 미사용. */
const T0 = 1_700_000_000_000;
const BRIDGE_TIMEOUT = 900_000; // 봇 대기 상한(=expires_at 원천)
const BUDGET = 480_000; // 소비자 잡 예산
const MARGIN = 30_000; // 기동 여유

/** 최소 NextAction(관심 필드 = step·stage — 전이 판정은 둘을 함께 본다). */
function na(step: string, stage: string | null = null): NextAction {
  return {
    rid: "run-1",
    phase: "01-brief",
    phase_label: "",
    step,
    gate: "user",
    status: "pending",
    awaiting: null,
    iteration: null,
    max_iterations: null,
    action: step === "generate" ? "generate" : "approve",
    stage,
    needs: null,
    options: [],
    recommended: null,
    ra_ok_required: false,
    revise_available: false,
    gate_type: null,
    stop_reason: null,
    advisory: null,
    cmd: "",
    gate_label: "",
    hint: "",
    files: [],
  } as NextAction;
}

let root: string;
let dirs: JobDirs;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chat-jobproto-"));
  dirs = jobDirsOf({
    jobsPending: join(root, "pending"),
    jobsClaimed: join(root, "claimed"),
    jobsFailed: join(root, "failed"),
  });
  await mkdir(dirs.pending, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const ls = (d: string): Promise<string[]> => readdir(d).then((n) => n.sort(), () => []);

/** v2 잡 1건(적재시각 T0 · 마감 T0+900초). */
function newJob(over: Partial<GenerateJobFile> = {}): GenerateJobFile {
  return {
    ...buildGenerateJob({ run_id: "run-1", stage: "brief", enqueuedAtMs: T0, timeoutMs: BRIDGE_TIMEOUT }),
    ...over,
  };
}

/** 소비자 의존성(전부 주입 — 기본 = 지금이 T0 이고 brief 생성 차례). */
function deps(over: Partial<TakeDeps> = {}): TakeDeps {
  return {
    dirs,
    consumerId: "c1",
    now: () => T0,
    budgetMs: BUDGET,
    startupMarginMs: MARGIN,
    readNext: async () => na("generate", "brief"),
    ...over,
  };
}

// ── 잡 조립·마감 ──────────────────────────────────────────────────────────────
describe("expires_at — 절대 마감(적재시각 + 대기 상한)", () => {
  it("computeExpiresAt: ISO-8601 UTC 절대시각(duration 아님)", () => {
    expect(computeExpiresAt(T0, BRIDGE_TIMEOUT)).toBe(new Date(T0 + BRIDGE_TIMEOUT).toISOString());
  });

  it("buildGenerateJob: v2 필드(version·job_id·enqueued_at·expires_at) + 마감 = 적재+상한", () => {
    const job = newJob();
    expect(job.version).toBe(JOB_PROTOCOL_VERSION);
    expect(job.kind).toBe("generate");
    expect(job.enqueued_at).toBe(new Date(T0).toISOString());
    expect(parseDeadline(job)).toBe(T0 + BRIDGE_TIMEOUT);
    expect(typeof job.job_id).toBe("string");
  });

  it("buildGenerateJob: 적재마다 job_id 가 다르다(회수 대조용 도장)", () => {
    expect(newJob().job_id).not.toBe(newJob().job_id);
  });

  it("parseDeadline: 미기재·형식오류 = null(v1 레거시 · 마감 없음)", () => {
    expect(parseDeadline({ kind: "generate", run_id: "run-1", stage: "brief" })).toBeNull();
    expect(parseDeadline(newJob({ expires_at: "언젠가" }))).toBeNull();
    expect(parseDeadline(newJob({ expires_at: "" }))).toBeNull();
  });

  it("경로 탈출 run_id/stage 는 잡 조립 단계에서 거부(파일 접촉 전)", () => {
    expect(() => buildGenerateJob({ run_id: "../evil", stage: "brief", enqueuedAtMs: T0, timeoutMs: 1000 })).toThrow(/안전하지 않/);
    expect(() => buildGenerateJob({ run_id: "run-1", stage: "../x", enqueuedAtMs: T0, timeoutMs: 1000 })).toThrow(/안전하지 않/);
  });
});

// ── 파일 읽기/쓰기 ────────────────────────────────────────────────────────────
describe("잡 파일 기록·읽기", () => {
  it("writePendingJob: <rid>-<stage>.json 원자 기록 + 왕복 파싱(미지 필드 보존)", async () => {
    const job = newJob({ note: "미지 필드" });
    const p = await writePendingJob(dirs.pending, job);
    expect(p).toBe(join(dirs.pending, "run-1-brief.json"));
    const back = await readJobFile(p);
    expect(back).toMatchObject({ run_id: "run-1", stage: "brief", kind: "generate", note: "미지 필드" });
    expect(back!.expires_at).toBe(job.expires_at);
  });

  it("readJobFile: 읽기 자체가 실패(권한 등)하면 '깨진 잡'으로 뭉뚱그리지 않고 던진다(reaper 오강등 방지)", async () => {
    // 디렉터리를 파일처럼 읽으면 EISDIR — '없음'도 '깨짐'도 아닌 fs 오류의 대역.
    await mkdir(join(dirs.pending, "run-1-brief.json"), { recursive: true });
    await expect(readJobFile(join(dirs.pending, "run-1-brief.json"))).rejects.toThrow();
  });

  it("readJobFile: 없음·깨진 JSON·kind 다름·경로탈출 rid = null(모르는 파일은 일감이 아니다)", async () => {
    expect(await readJobFile(join(dirs.pending, "없음.json"))).toBeNull();
    await writeFile(join(dirs.pending, "broken.json"), "{ 반쯤", "utf8");
    expect(await readJobFile(join(dirs.pending, "broken.json"))).toBeNull();
    await writeFile(join(dirs.pending, "other.json"), JSON.stringify({ kind: "approve", run_id: "r", stage: "brief" }), "utf8");
    expect(await readJobFile(join(dirs.pending, "other.json"))).toBeNull();
    await writeFile(join(dirs.pending, "evil.json"), JSON.stringify({ kind: "generate", run_id: "../evil", stage: "brief" }), "utf8");
    expect(await readJobFile(join(dirs.pending, "evil.json"))).toBeNull();
  });

  it("listPendingJobs: 이름순 · 숨김(tmp)·비-json·깨진 파일 제외", async () => {
    await writePendingJob(dirs.pending, newJob({ run_id: "run-2", stage: "concept" }));
    await writePendingJob(dirs.pending, newJob());
    await writeFile(join(dirs.pending, ".run-9-brief.json.tmp-x"), "{}", "utf8");
    await writeFile(join(dirs.pending, "메모.txt"), "무시", "utf8");
    await writeFile(join(dirs.pending, "broken.json"), "{", "utf8");
    expect((await listPendingJobs(dirs.pending)).map((j) => j.job.run_id)).toEqual(["run-1", "run-2"]);
  });

  it("listPendingJobs: 폴더 자체가 없으면 빈 배열(잡 없음)", async () => {
    expect(await listPendingJobs(join(root, "없는폴더"))).toEqual([]);
  });

  it("listPendingJobs: 파일명이 규약(<rid>-<stage>.json)과 어긋나면 잡으로 보지 않는다(하류가 canonical 이름을 쓰므로)", async () => {
    await writeFile(join(dirs.pending, "손으로-바꾼-이름.json"), JSON.stringify(newJob()), "utf8");
    expect(await listPendingJobs(dirs.pending)).toEqual([]);
  });
});

// ── 2중 검사 ──────────────────────────────────────────────────────────────────
describe("2중 검사 ㉠ 시간(checkBudget) — '마감 안 지났나'가 아니라 '끝낼 수 있나'", () => {
  it("남은 시간 ≥ 예산+여유 → ok", () => {
    expect(checkBudget(newJob(), T0, BUDGET, MARGIN)).toMatchObject({ ok: true, reason: "ok" });
  });

  it("마감 전이어도 남은 시간이 예산+여유에 못 미치면 expired(늦은 성공 창을 시작 전에 없앤다)", () => {
    const almost = T0 + BRIDGE_TIMEOUT - (BUDGET + MARGIN) + 1; // 1ms 부족
    expect(checkBudget(newJob(), almost, BUDGET, MARGIN)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("경계: 정확히 예산+여유만 남았으면 ok", () => {
    const exact = T0 + BRIDGE_TIMEOUT - (BUDGET + MARGIN);
    expect(checkBudget(newJob(), exact, BUDGET, MARGIN).ok).toBe(true);
  });

  it("마감 넘김 → expired", () => {
    expect(checkBudget(newJob(), T0 + BRIDGE_TIMEOUT + 1, BUDGET, MARGIN)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("expires_at 부재(v1 레거시) → no_deadline(만료와 구분 — 사람 소비자 몫)", () => {
    const v1: GenerateJobFile = { kind: "generate", run_id: "run-1", stage: "brief" };
    expect(checkBudget(v1, T0, BUDGET, MARGIN)).toMatchObject({ ok: false, reason: "no_deadline" });
  });
});

describe("2중 검사 ㉡ 차례(isGenerateTurn) — 봇 전이 감지와 같은 판정", () => {
  it("step=generate + stage 일치일 때만 그 잡의 차례", () => {
    expect(isGenerateTurn(na("generate", "brief"), "brief")).toBe(true);
    expect(isGenerateTurn(na("human"), "brief")).toBe(false);
    expect(isGenerateTurn(na("generate", "concept"), "brief")).toBe(false); // 다음 단계 생성 = brief 잡은 stale
  });
});

describe("doubleCheckJob — 둘 다 통과해야 ok", () => {
  it("시간·차례 모두 통과 → ok", async () => {
    expect(await doubleCheckJob(newJob(), deps())).toMatchObject({ ok: true, reason: "ok" });
  });

  it("차례가 지났으면 transitioned", async () => {
    const r = await doubleCheckJob(newJob(), deps({ readNext: async () => na("human") }));
    expect(r).toMatchObject({ ok: false, reason: "transitioned" });
  });

  it("시간 검사가 먼저 — 만료면 next-action spawn 을 아예 안 한다(비용 절약 · 마감 후 조회 무의미)", async () => {
    let calls = 0;
    const r = await doubleCheckJob(
      newJob(),
      deps({
        now: () => T0 + BRIDGE_TIMEOUT,
        readNext: async () => {
          calls++;
          return na("generate", "brief");
        },
      }),
    );
    expect(r.reason).toBe("expired");
    expect(calls).toBe(0);
  });

  it("next-action 조회 실패 → unreadable(판단 불가 — 잡을 버리지 않는다)", async () => {
    const r = await doubleCheckJob(newJob(), deps({ readNext: async () => { throw new Error("셸 실패"); } }));
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
  });
});

// ── 수명주기(소비자 1급 경로) ──────────────────────────────────────────────────
describe("takePendingJob — 수명주기 처분", () => {
  it("통과 → claimed/<consumer>/ 로 이동(pending 에서 사라진다)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const r = await takePendingJob(job, deps());
    expect(r.action).toBe("claimed");
    expect(r.path).toBe(join(dirs.claimed, "c1", "run-1-brief.json"));
    expect(await ls(dirs.pending)).toEqual([]);
    expect(await exists(r.path!)).toBe(true);
  });

  it("★ 만료된 잡은 일감이 되지 않는다 → claimed 로 넘기지 않고 failed/ + .reason 격리", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const r = await takePendingJob(job, deps({ now: () => T0 + BRIDGE_TIMEOUT + 1 }));
    // 소비자에게 'claimed'(=일해라)로 돌아가는 일이 없다 — 처분을 위해 잠깐 소유할 뿐이다(안전한 이동의 전제).
    expect(r).toMatchObject({ action: "failed", reason: "expired" });
    expect(await ls(dirs.pending)).toEqual([]);
    expect(await exists(join(dirs.claimed, "c1", "run-1-brief.json"))).toBe(false); // 살아 있는 클레임 없음
    expect(await ls(dirs.failed)).toEqual(["run-1-brief.json", "run-1-brief.json.reason"]);
    expect(await readFile(join(dirs.failed, "run-1-brief.json.reason"), "utf8")).toMatch(/남은 시간/);
  });

  it("★ 전이 완료된 잡은 삭제된다(재실행 금지 · failed 로도 안 간다)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const r = await takePendingJob(job, deps({ readNext: async () => na("human") }));
    expect(r).toMatchObject({ action: "dropped", reason: "transitioned" });
    expect(await ls(dirs.pending)).toEqual([]);
    expect(await exists(join(dirs.claimed, "c1", "run-1-brief.json"))).toBe(false);
    expect(await ls(dirs.failed)).toEqual([]);
  });

  it("v1 레거시 잡(마감 없음)은 손대지 않는다 — pending 보존(사람 소비자 몫 · failed 로 강등 금지)", async () => {
    const v1: GenerateJobFile = { kind: "generate", run_id: "run-1", stage: "brief" };
    await writePendingJob(dirs.pending, v1);
    const r = await takePendingJob(v1, deps());
    expect(r).toMatchObject({ action: "skipped", reason: "no_deadline" });
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
    expect(await ls(dirs.failed)).toEqual([]);
  });

  it("next-action 조회 실패 → 손대지 않는다(다음 회차 재시도)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const r = await takePendingJob(job, deps({ readNext: async () => { throw new Error("셸 실패"); } }));
    expect(r).toMatchObject({ action: "skipped", reason: "unreadable" });
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
  });

  it("이미 없어진 잡(다른 소비자가 집음) → lost(예외 아님)", async () => {
    const job = newJob(); // pending 에 쓰지 않음 = 이미 사라진 상태
    expect(await takePendingJob(job, deps())).toMatchObject({ action: "lost" });
  });

  it("처분 경합에 져도(그새 누가 집어감) 잡 없는 .reason 을 남기지 않는다(실패했다는 거짓 기록 금지)", async () => {
    const job = newJob(); // pending 에 없음 = 그 사이 누가 집어감
    const r = await takePendingJob(job, deps({ now: () => T0 + BRIDGE_TIMEOUT + 1 }));
    expect(r.action).toBe("lost"); // 소유하지 못했으므로 아무것도 처분하지 않는다
    expect(await ls(dirs.failed)).toEqual([]); // 사유 파일도 남지 않았다
  });

  it("★ 판정은 '집은 실물'에 대해서만 — 목록의 잡이 만료여도 그새 들어온 새 잡이 멀쩡하면 그 새 잡으로 일한다", async () => {
    // 남의 새 요청을 옛 판정('만료')으로 failed/ 에 처박지 않는다 = 검사 대상과 처분 대상이 항상 같다.
    const listed = newJob(); // 목록에 잡힐 당시의(만료된) 잡
    const fresh = newJob({
      job_id: "그-사이-들어온-새-잡",
      expires_at: new Date(T0 + BRIDGE_TIMEOUT * 3).toISOString(), // 마감이 넉넉한 새 요청
    });
    await writePendingJob(dirs.pending, fresh);
    const r = await takePendingJob(listed, deps({ now: () => T0 + BRIDGE_TIMEOUT + 1 })); // listed 기준이면 만료
    expect(r.action).toBe("claimed"); // 집은 실물(fresh)로 판정 → 일감이다
    expect(await ls(dirs.failed)).toEqual([]); // 새 요청이 옛 판정에 처박히지 않았다
    expect((await readJobFile(r.path!))!.job_id).toBe(fresh.job_id);
  });

  it("★ 집은 뒤 처분에 실패하면(fs 오류) 대기줄로 되돌린다 — claimed/ 에 갇히면 reaper 도 못 건드린다", async () => {
    const job = newJob({ run_id: "run-2" });
    await writePendingJob(dirs.pending, job);
    // 처분(failJob) 자리를 디렉터리로 막아 rename 을 실패시킨다(IO 오류 대역).
    await mkdir(join(dirs.failed, "run-2-brief.json", "막힘"), { recursive: true });
    await expect(
      takePendingJob(job, deps({ consumerId: "c9", now: () => T0 + BRIDGE_TIMEOUT + 1 })), // 만료 → failJob → 실패
    ).rejects.toThrow();
    expect(await exists(join(dirs.claimed, "c9", "run-2-brief.json"))).toBe(false); // 갇히지 않았다
    expect(await ls(dirs.pending)).toContain("run-2-brief.json"); // 대기줄 복귀 → 다음 회차가 다시 본다
  });

  it("★ 차례 조회(next-action)가 기동 여유를 다 먹으면 일감이 아니다 — 조회 뒤 예산을 다시 본다", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    let t = T0 + BRIDGE_TIMEOUT - (BUDGET + MARGIN); // 딱 예산+여유만 남은 시점(조회 전엔 통과)
    const r = await takePendingJob(job, {
      ...deps(),
      now: () => t,
      readNext: async () => {
        t += 1; // 조회가 1ms 걸림 → 이제 예산이 모자란다
        return na("generate", "brief");
      },
    });
    expect(r).toMatchObject({ action: "failed", reason: "expired" }); // 검증한 예산이 사실이 아니면 시작하지 않는다
    expect(await exists(join(dirs.claimed, "c1", "run-1-brief.json"))).toBe(false);
  });
});

// ── 클레임 경합(rename = 원자성 원천) ──────────────────────────────────────────
describe("클레임-by-rename — 경합의 승자는 OS 가 정한다", () => {
  it("★ 두 소비자가 같은 잡을 동시에 집으면 정확히 한 승자 · 패자는 깨끗이 진다(null)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const [a, b] = await Promise.all([claimJob(dirs, job, "c1"), claimJob(dirs, job, "c2")]);
    const winners = [a, b].filter((p) => p !== null);
    expect(winners).toHaveLength(1); // 승자 정확히 1(누가 이겼는지는 OS 몫 — 단정하지 않는다)
    expect(await exists(winners[0]!)).toBe(true);
    expect(await ls(dirs.pending)).toEqual([]); // 원본은 승자에게 갔다
  });

  it("★ takePendingJob 경합도 승자 1명(나머지는 lost — 이중 소비 없음)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const rs = await Promise.all([
      takePendingJob(job, deps({ consumerId: "c1" })),
      takePendingJob(job, deps({ consumerId: "c2" })),
      takePendingJob(job, deps({ consumerId: "c3" })),
    ]);
    expect(rs.filter((r) => r.action === "claimed")).toHaveLength(1);
    expect(rs.filter((r) => r.action === "lost")).toHaveLength(2);
  });

  it("연속 클레임: 두 번째는 원본이 없어 null(같은 잡을 두 번 집을 수 없다)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    expect(await claimJob(dirs, job, "c1")).not.toBeNull();
    expect(await claimJob(dirs, job, "c2")).toBeNull();
  });

  it("경로 탈출 소비자 id 는 거부(claimed/<consumer> 디렉터리 탈출 차단)", async () => {
    await expect(claimJob(dirs, newJob(), "../evil")).rejects.toThrow(/안전하지 않/);
  });

  it("★ 점 세그먼트 소비자 id(`.`·`..`)도 거부 — 문자 클래스는 통과하지만 경로 이동이다", async () => {
    // `.` = claimed/ 바로 밑(reaper 의 소비자 폴더 스캔 밖 → 고아 회수 불능) · `..` = jobs 루트(수명주기 밖).
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    await expect(claimJob(dirs, job, ".")).rejects.toThrow(/안전하지 않/);
    await expect(claimJob(dirs, job, "..")).rejects.toThrow(/안전하지 않/);
    expect(await ls(dirs.pending)).toEqual([jobFileName(job.run_id, job.stage)]); // 잡은 대기줄에 그대로
    expect(await ls(dirs.claimed)).toEqual([]); // claimed/ 밑에 흘린 파일 없음
  });

  it("isSafeConsumerId: 안전 토큰만 통과(점 세그먼트·경로분리·길이초과·빈 문자열 거부)", () => {
    expect(isSafeConsumerId("op-chabh")).toBe(true);
    expect(isSafeConsumerId("daemon.1_a-B")).toBe(true);
    expect(isSafeConsumerId(".")).toBe(false);
    expect(isSafeConsumerId("..")).toBe(false);
    expect(isSafeConsumerId("../evil")).toBe(false);
    expect(isSafeConsumerId("a/b")).toBe(false);
    expect(isSafeConsumerId("")).toBe(false);
    expect(isSafeConsumerId("x".repeat(65))).toBe(false);
    expect(isSafeConsumerId("...")).toBe(true); // 점 3개는 실제 디렉터리명이라 안전(이동 아님)
  });
});

// ── 회수·완료·실패·해제 ───────────────────────────────────────────────────────
describe("봇 타임아웃 회수(recallPendingJob)", () => {
  it("자기 잡이면 회수(true) — pending 에서 사라진다", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    expect(await recallPendingJob(dirs.pending, job)).toBe(true);
    expect(await ls(dirs.pending)).toEqual([]);
  });

  it("같은 이름의 새 잡(job_id 다름)은 회수하지 않는다 — 남의 요청 증발 금지", async () => {
    const mine = newJob();
    const other = newJob();
    await writePendingJob(dirs.pending, other);
    expect(await recallPendingJob(dirs.pending, mine)).toBe(false);
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
  });

  it("이미 클레임돼 파일이 없으면 no-op(false) — 늦은 성공 가능성은 화해 버튼 몫", async () => {
    expect(await recallPendingJob(dirs.pending, newJob())).toBe(false);
  });

  it("job_id 없는 v1 잡은 '자기 잡' 증명이 불가라 회수하지 않는다", async () => {
    const v1: GenerateJobFile = { kind: "generate", run_id: "run-1", stage: "brief" };
    await writePendingJob(dirs.pending, v1);
    expect(await recallPendingJob(dirs.pending, v1)).toBe(false);
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
  });
});

// ── 적재 차단(이중 소비 구멍) ─────────────────────────────────────────────────
describe("findBlockingClaimedJob — 산 클레임이 있으면 새 잡을 적재하지 못하게 한다", () => {
  /** 잡 1건을 c1 이 집은 상태로 만든다(= claimed/c1/<rid>-<stage>.json). */
  async function claimed(job: GenerateJobFile = newJob(), consumer = "c1"): Promise<string> {
    await writePendingJob(dirs.pending, job);
    return (await claimJob(dirs, job, consumer))!;
  }
  const find = (nowMs = T0, run_id = "run-1", stage = "brief"): Promise<unknown> =>
    findBlockingClaimedJob(dirs.claimed, run_id, stage, nowMs);

  it("★ 마감이 남은 클레임 → 막는다(누가 집었는지·언제까지인지와 함께)", async () => {
    const job = newJob();
    await claimed(job);
    expect(await find(T0)).toMatchObject({
      consumer: "c1",
      deadlineMs: T0 + BRIDGE_TIMEOUT,
      job: { job_id: job.job_id },
    });
  });

  it("★ 마감이 지난 클레임 → 막지 않는다(죽은 클레임 하나가 런을 영영 묶으면 안 된다)", async () => {
    await claimed();
    // 규약상 아무도 마감 뒤엔 일하지 않는다(2중 검사 ㉠) → 그 클레임은 새 요청을 막을 근거가 못 된다.
    expect(await find(T0 + BRIDGE_TIMEOUT + 1)).toBeNull();
  });

  it("경계: 마감 **정각**은 이미 만료(막지 않는다 — '남았다'는 미래일 때만)", async () => {
    await claimed();
    expect(await find(T0 + BRIDGE_TIMEOUT)).toBeNull();
    expect(await find(T0 + BRIDGE_TIMEOUT - 1)).not.toBeNull();
  });

  it("★ 마감 미기재(v1 레거시) 클레임 → 막는다(fail-closed — '죽었다'를 증명할 수 없다)", async () => {
    // 사람이 손으로 소비 중일 수 있는 잡이다. 마감을 지어내 죽은 것으로 단정하지 않는다.
    await claimed({ kind: "generate", run_id: "run-1", stage: "brief" });
    expect(await find(T0)).toMatchObject({ consumer: "c1", deadlineMs: null });
    // 마감이 없으니 '아무리 시간이 흘러도' 만료로 넘어가지 않는다(시계로 풀리지 않는다).
    expect(await find(T0 + 10 * BRIDGE_TIMEOUT)).not.toBeNull();
  });

  it("★ 다른 run 의 클레임은 막지 않는다", async () => {
    await claimed(newJob({ run_id: "run-2" }));
    expect(await find(T0, "run-1", "brief")).toBeNull();
    expect(await find(T0, "run-2", "brief")).not.toBeNull();
  });

  it("★ 같은 run 이라도 다른 stage 의 클레임은 막지 않는다", async () => {
    await claimed(newJob({ stage: "concept" }));
    expect(await find(T0, "run-1", "brief")).toBeNull();
    expect(await find(T0, "run-1", "concept")).not.toBeNull();
  });

  it("claimed/ 자체가 없으면 막지 않는다(아무도 집지 않았다)", async () => {
    expect(await findBlockingClaimedJob(join(root, "없는폴더"), "run-1", "brief", T0)).toBeNull();
  });

  it("소비자 폴더는 있는데 그 잡이 없으면 막지 않는다(ENOENT = 그 소비자의 일감이 아님)", async () => {
    await claimed(newJob({ stage: "concept" })); // c1 은 concept 만 들고 있다
    expect(await find(T0, "run-1", "brief")).toBeNull();
  });

  it("소비자가 여럿이어도 산 클레임을 찾아낸다(만료 소비자를 지나쳐 계속 본다)", async () => {
    await claimed(newJob({ expires_at: new Date(T0 - 1).toISOString() }), "a-dead"); // 만료 — 근거 아님
    await claimed(newJob(), "b-live"); // 산 클레임 — 이게 막아야 한다
    expect(await find(T0)).toMatchObject({ consumer: "b-live" });
  });

  it("내용이 파일명과 어긋나는 클레임은 그 이름의 일감이 아니다(하류가 canonical 이름을 쓴다)", async () => {
    // 손으로 만든 파일: 이름은 run-1-brief 인데 내용은 다른 잡 → 이 잡을 집은 소비자는 brief 를 만들지 않는다.
    await mkdir(join(dirs.claimed, "c1"), { recursive: true });
    await writeFile(join(dirs.claimed, "c1", "run-1-brief.json"), JSON.stringify(newJob({ stage: "concept" })), "utf8");
    expect(await find(T0)).toBeNull();
  });

  it("★ 읽기 실패(권한·IO)는 '클레임 없음'으로 위장하지 않고 던진다(호출부가 fail-closed 로 막는다)", async () => {
    // 잡 파일 자리에 디렉터리 → EISDIR('없음'도 '깨짐'도 아닌 fs 오류의 대역).
    await mkdir(join(dirs.claimed, "c1", "run-1-brief.json"), { recursive: true });
    await expect(find(T0)).rejects.toThrow();
  });

  it("경로 탈출 run_id/stage 는 fs 접촉 전에 거부", async () => {
    await expect(findBlockingClaimedJob(dirs.claimed, "../evil", "brief", T0)).rejects.toThrow(/안전하지 않/);
    await expect(findBlockingClaimedJob(dirs.claimed, "run-1", "../x", T0)).rejects.toThrow(/안전하지 않/);
  });
});

// ── 적재 = 원자 대체(펜스 1) ──────────────────────────────────────────────────
/**
 * enqueueJob 은 '검사 → 적재'가 아니라 '**옛 잡 내리기(unlink) → 검사 → 배타 생성**'이다. 아래 테스트가 못 박는 것은
 *   두 가지다: ① 정책은 그대로(같은 이름의 옛 잡은 더 신선한 요청으로 **대체**) ② 기전이 바뀌어 옛 결함 ㉠
 *   ('검사 통과 → 그 직후 옛 잡이 집힘 → 새 잡 적재 → 둘 다 돎')의 **전제**가 사라졌다.
 */
describe("enqueueJob — 적재 = 원자 대체(supersede-then-create)", () => {
  const enq = (over: Partial<EnqueueDeps> = {}): Promise<EnqueueResult> =>
    enqueueJob(dirs, { run_id: "run-1", stage: "brief", timeoutMs: BRIDGE_TIMEOUT }, { now: () => T0, ...over });

  /** ok=true 로 좁힌다 — 실패면 그 자리에서 죽는다(아래 단정이 공허하게 통과하지 않게). */
  function okOf(r: EnqueueResult): Extract<EnqueueResult, { ok: true }> {
    if (!r.ok) throw new Error(`적재가 성공했어야 한다(reason=${r.reason})`);
    return r;
  }
  /** 그 잡을 소비자가 집은 상태로 만든다(= claimed/<consumer>/…). */
  async function claimedBy(j: GenerateJobFile, consumer = "c1"): Promise<void> {
    await writePendingJob(dirs.pending, j);
    await claimJob(dirs, j, consumer);
  }

  it("빈 대기줄 → 적재(v2 잡 1건 · 마감 = 적재시각 + 상한 · tmp 찌꺼기 없음)", async () => {
    const r = okOf(await enq());
    expect(r.path).toBe(join(dirs.pending, "run-1-brief.json"));
    expect(parseDeadline(r.job)).toBe(T0 + BRIDGE_TIMEOUT);
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]); // 숨김 tmp 도 안 남았다(ls 는 dotfile 도 본다)
    expect((await readJobFile(r.path))!.job_id).toBe(r.job.job_id);
  });

  it("★ 아무도 안 집은 옛 v2 잡은 **대체**한다 — 대기줄엔 새 job_id 의 잡 정확히 1건(중복 안 쌓임)", async () => {
    await writePendingJob(dirs.pending, newJob({ job_id: "옛-잡" }));
    const r = okOf(await enq());
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]); // 잡은 여전히 1건
    const left = await readJobFile(r.path);
    expect(left!.job_id).toBe(r.job.job_id);
    expect(left!.job_id).not.toBe("옛-잡"); // 옛 요청은 더 신선한 것으로 대체됐다(정책 불변)
  });

  it("★ v1 레거시 잡(마감 없음)도 대체한다 — v1→v2 승격의 정상 경로(레거시 파괴가 아니다)", async () => {
    await writePendingJob(dirs.pending, { kind: "generate", run_id: "run-1", stage: "brief" });
    const r = okOf(await enq());
    expect(parseDeadline((await readJobFile(r.path))!)).toBe(T0 + BRIDGE_TIMEOUT); // 이제 마감이 있다
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
  });

  it("★★ ㉠ 회귀 가드: 옛 잡이 **적재 전에 이미 집혔으면** in_progress + 대기줄에 아무것도 쓰지 않는다", async () => {
    // 이 순간이 옛 결함의 결말이다: 여기서 새 잡을 적재하면 옛 잡을 집은 C1 과 새 잡을 집을 C2 가 같은 런을
    //   동시에 쓴다(이중 소비·이중 과금). 원자 대체는 그 첫 걸음(집을 옛 잡)이 이미 claimed/ 에 있으므로 막는다.
    await claimedBy(newJob({ job_id: "옛-잡" })); // C1 이 옛 잡을 집고 작업 중(마감 T0+900초 · 지금 T0)
    const r = await enq();
    expect(r).toEqual({ ok: false, reason: "in_progress" });
    // ★ 핵심 단정 — 이 줄이 펜스의 존재 이유다. 잡이 하나라도 쓰였으면 C2 가 집을 것이 생긴다(= 이중 소비).
    expect(await ls(dirs.pending)).toEqual([]);
    expect((await readJobFile(join(dirs.claimed, "c1", "run-1-brief.json")))!.job_id).toBe("옛-잡"); // C1 잡은 무사
  });

  it("★ 마감이 지난 클레임은 적재를 막지 않는다(죽은 클레임 하나가 런을 영영 묶으면 안 된다)", async () => {
    await claimedBy(newJob({ expires_at: new Date(T0 - 1).toISOString() }));
    const r = okOf(await enq());
    expect((await readJobFile(r.path))!.job_id).toBe(r.job.job_id); // 새 요청이 실제로 적재됐다
  });

  it("★ 마감 미기재(v1) 클레임은 막는다 — fail-closed('죽었다'를 증명할 수 없다)", async () => {
    await claimedBy({ kind: "generate", run_id: "run-1", stage: "brief" });
    expect(await enq()).toEqual({ ok: false, reason: "in_progress" });
    expect(await ls(dirs.pending)).toEqual([]);
  });

  it("★ claimed/ 조회가 IO 오류면 unknown(fail-closed) — 적재하지 않는다", async () => {
    // 잡 파일 자리에 디렉터리 → EISDIR('없음'도 '깨짐'도 아닌 fs 오류의 대역). 모르면 적재하지 않는다.
    await mkdir(join(dirs.claimed, "c1", "run-1-brief.json"), { recursive: true });
    expect(await enq()).toEqual({ ok: false, reason: "unknown" });
    expect(await ls(dirs.pending)).toEqual([]);
  });

  it("★ 배타 생성이 한 번 지면(EEXIST) 1)로 되돌아가 그 잡까지 대체하고 성공한다", async () => {
    // 재현하는 상황: 우리 link 직전에 남이 같은 이름을 만들었다(= takePendingJob 이 일 시작 전 되돌린 자기 클레임).
    //   그 잡은 정의상 '아직 시작 안 한 같은 일'이라 대체가 옳다 — 그래서 재시도 1회로 족하다.
    let calls = 0;
    const r = okOf(
      await enq({
        createExclusive: async (_dir, dest, job) => {
          if (++calls === 1) {
            await writeFile(dest, JSON.stringify(newJob({ job_id: "끼어든-잡" })), "utf8");
            return false; // EEXIST — 목적지를 남이 잡았다
          }
          await writeFile(dest, JSON.stringify(job), "utf8");
          return true;
        },
      }),
    );
    expect(calls).toBe(2);
    expect((await readJobFile(r.path))!.job_id).toBe(r.job.job_id); // 2회차 1)의 unlink 가 끼어든 잡을 대체했다
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
  });

  it("★ 계속 EEXIST 면 2회에서 멈추고 unknown — '적재자는 봇 하나'라는 전제가 깨진 것이다(무한 재시도 금지)", async () => {
    let calls = 0;
    const r = await enq({
      createExclusive: async () => {
        calls++;
        return false;
      },
    });
    expect(r).toEqual({ ok: false, reason: "unknown" });
    expect(calls).toBe(2);
  });

  it("★ 재시도는 같은 잡(같은 job_id·같은 마감)으로 한다 — 적재 1건 = 마감 1개", async () => {
    const seen: string[] = [];
    const r = okOf(
      await enq({
        createExclusive: async (_dir, dest, job) => {
          seen.push(String(job.job_id));
          if (seen.length === 1) return false;
          await writeFile(dest, JSON.stringify(job), "utf8");
          return true;
        },
      }),
    );
    expect(seen).toEqual([r.job.job_id, r.job.job_id]); // 재시도가 마감을 새로 발행하지 않는다
  });

  it("경로 탈출 run_id/stage 는 fs 접촉 전에 거부", async () => {
    const d = { now: () => T0 };
    await expect(enqueueJob(dirs, { run_id: "../evil", stage: "brief", timeoutMs: 1000 }, d)).rejects.toThrow(/안전하지 않/);
    await expect(enqueueJob(dirs, { run_id: "run-1", stage: "../x", timeoutMs: 1000 }, d)).rejects.toThrow(/안전하지 않/);
  });
});

describe("완료·실패·해제", () => {
  it("completeJob: 삭제 · 두 번 불러도 예외 없음(멱등)", async () => {
    const job = newJob();
    const p = await writePendingJob(dirs.pending, job);
    await completeJob(p);
    expect(await exists(p)).toBe(false);
    await expect(completeJob(p)).resolves.toBeUndefined();
  });

  it("failJob: failed/ 이동 + .reason 기록(사유 없는 실패 금지)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const claimed = (await claimJob(dirs, job, "c1"))!;
    const dest = await failJob(dirs, claimed, "세션이 전이시키지 못함");
    expect(await exists(claimed)).toBe(false);
    expect(await readFile(`${dest}.reason`, "utf8")).toBe("세션이 전이시키지 못함\n");
  });

  it("releaseJob: pending 복귀(true)", async () => {
    const job = newJob();
    await writePendingJob(dirs.pending, job);
    const claimed = (await claimJob(dirs, job, "c1"))!;
    expect(await releaseJob(dirs, claimed)).toBe(true);
    expect(await ls(dirs.pending)).toEqual(["run-1-brief.json"]);
    expect(await exists(claimed)).toBe(false);
  });

  it("releaseJob: 같은 이름의 새 잡이 이미 대기 중이면 덮지 않고 고아를 버린다(no-clobber)", async () => {
    const orphan = newJob();
    await writePendingJob(dirs.pending, orphan);
    const claimed = (await claimJob(dirs, orphan, "c1"))!;
    const fresh = newJob(); // 그 사이 새로 적재된 잡(마감이 더 넉넉하다)
    await writePendingJob(dirs.pending, fresh);
    expect(await releaseJob(dirs, claimed)).toBe(false);
    expect((await readJobFile(join(dirs.pending, "run-1-brief.json")))!.job_id).toBe(fresh.job_id);
    expect(await exists(claimed)).toBe(false); // 고아는 버려졌다
  });
});

// ── reaper(마감 리스 · 펜스 2) ────────────────────────────────────────────────
/**
 * reaper 의 판정 근거는 **마감(리스)뿐**이다 — 소비자의 생사를 묻지 않는다(하트비트 개념 자체가 없다).
 *   옛 구현은 `isConsumerAlive()===false` 를 죽음으로 믿고 재큐했는데, 하트비트 정지 ≠ 죽음이라 그 추정이 틀리는
 *   순간 원 소비자와 재큐된 잡의 새 소비자가 같은 런을 동시에 썼다. 아래 '재큐 없음' 단정들이 그 회귀 가드다.
 */
describe("reapClaimedJobs — 마감 리스(생사 추정 없음)", () => {
  /** 클레임 1건을 만든다(소비자 c1 이 집은 상태 — 살았는지 죽었는지는 **묻지 않는다**). */
  async function claimedBy(job: GenerateJobFile = newJob()): Promise<string> {
    await writePendingJob(dirs.pending, job);
    return (await claimJob(dirs, job, "c1"))!;
  }
  const reapDeps = (over: Partial<ReapDeps> = {}): ReapDeps => ({
    dirs,
    now: () => T0,
    readNext: async () => na("generate", "brief"),
    ...over,
  });

  it("★ 마감이 남은 클레임은 불가침 — 하트비트를 묻지도 않는다(생사 추정은 펜스가 아니다)", async () => {
    const p = await claimedBy(); // 마감 T0+900초 · 지금 T0
    const r = await reapClaimedJobs(reapDeps());
    expect(r).toEqual([{ path: p, consumer: "c1", action: "leased", reason: "leased" }]);
    expect(await exists(p)).toBe(true); // 그 소비자는 마감까지 일할 권리가 있다
    expect(await ls(dirs.pending)).toEqual([]); // ★ 재큐 없음(옛 동작: '죽었으니 released' → 이중 소비의 원천)
  });

  it("★ 산 리스에는 next-action 을 부르지 않는다(물을 것이 없다 — 셸 비용 0)", async () => {
    await claimedBy();
    let calls = 0;
    await reapClaimedJobs(
      reapDeps({
        readNext: async () => {
          calls++;
          return na("generate", "brief");
        },
      }),
    );
    expect(calls).toBe(0);
  });

  it("★ 마감 지남 + 이미 전이됨 → 뒷정리(삭제) · 재큐도 격리도 아니다", async () => {
    const p = await claimedBy();
    const r = await reapClaimedJobs(reapDeps({ now: () => T0 + BRIDGE_TIMEOUT + 1, readNext: async () => na("human") }));
    expect(r[0]).toMatchObject({ action: "completed", reason: "transitioned" });
    expect(await exists(p)).toBe(false);
    expect(await ls(dirs.pending)).toEqual([]);
    expect(await ls(dirs.failed)).toEqual([]);
  });

  it("★ 마감 지남 + 아직 그 차례 → failed/ 격리 · **재큐하지 않는다**(옛 released 동작의 회귀 가드)", async () => {
    await claimedBy();
    const r = await reapClaimedJobs(reapDeps({ now: () => T0 + BRIDGE_TIMEOUT + 1 }));
    expect(r[0]).toMatchObject({ action: "failed", reason: "expired" });
    // ★ 핵심: 대기줄이 비어야 한다. 되돌리면 마감이 이미 지난 잡을 누가 집는다(마감을 새로 발행할 자는 봇뿐이다).
    //   복구는 새 요청 몫이고, 만료된 이 클레임은 그 적재를 막지 않는다(enqueueJob).
    expect(await ls(dirs.pending)).toEqual([]);
    expect(await ls(dirs.failed)).toEqual(["run-1-brief.json", "run-1-brief.json.reason"]);
    expect(await readFile(join(dirs.failed, "run-1-brief.json.reason"), "utf8")).toMatch(/만료/);
  });

  it("★ v1 레거시(마감 미기재) → 제자리 보고만 · 손대지 않는다(옛 released 동작의 회귀 가드)", async () => {
    // 마감이 없으면 리스가 살았는지 죽었는지 알 수 없다. 모르는 것에 손대지 않는다 — 사람이 손으로 소비 중일 수 있다.
    const p = await claimedBy({ kind: "generate", run_id: "run-1", stage: "brief" });
    const r = await reapClaimedJobs(reapDeps());
    expect(r[0]).toMatchObject({ action: "skipped", reason: "no_deadline" });
    expect(await exists(p)).toBe(true);
    expect(await ls(dirs.pending)).toEqual([]); // 되돌리지 않았다(매 pass 마다 남의 파일을 흔들지 않는다)
    expect(await ls(dirs.failed)).toEqual([]); // 강등도 하지 않았다
  });

  it("마감 지남 + next-action 조회 실패 → 손대지 않는다(조회 실패로 처분하지 않는다 · 다음 pass 재시도)", async () => {
    const p = await claimedBy();
    const r = await reapClaimedJobs(
      reapDeps({
        now: () => T0 + BRIDGE_TIMEOUT + 1,
        readNext: async () => {
          throw new Error("셸 실패");
        },
      }),
    );
    expect(r[0]).toMatchObject({ action: "skipped", reason: "unreadable" });
    expect(await exists(p)).toBe(true);
    expect(await ls(dirs.failed)).toEqual([]);
  });

  it("깨진 잡 파일(있는데 잡이 아님)은 사람이 보게 failed/ 로(마감을 못 읽으면 리스를 존중할 근거도 없다)", async () => {
    // ★ '그새 사라짐(vanished)'과 갈리는 자리: 읽기가 잡을 못 낸 건 같아도 처분은 정반대다 — 사라짐은 정상이라
    //   조용히 넘기고, 깨짐은 사람을 부른다. 이 테스트는 그 '사람 호출'이 살아 있는지 지킨다(아래 vanished 테스트와 쌍).
    await mkdir(join(dirs.claimed, "c1"), { recursive: true });
    await writeFile(join(dirs.claimed, "c1", "run-1-brief.json"), "{ 반쯤", "utf8");
    const r = await reapClaimedJobs(reapDeps());
    expect(r[0]).toMatchObject({ action: "failed", reason: "unreadable" });
    expect(await ls(dirs.failed)).toEqual(["run-1-brief.json", "run-1-brief.json.reason"]);
  });

  it("★ 목록에 잡힌 뒤 사라진 잡은 pass 를 깨지 않는다 — vanished 보고 · failed/ 오염 없음(정상 완료 ≠ 깨진 잡)", async () => {
    // 재현하는 순간: readdir 이 이름을 본 **뒤** 멀쩡한 소비자 C1 이 제 일을 끝내며(completeJob) 그 잡을 지운다.
    //   옛 구현은 그 ENOENT 를 '깨진 잡'으로 읽고 failJob → rename 이 또 ENOENT → **pass 전체가 거부**됐다. 소비자는
    //   기동 시 reaper 를 먼저 돌린 뒤 폴링하므로(호출 순서 규약), 남의 **정상 완료** 하나가 데몬 기동을 깨뜨렸다.
    // 이음새 = 앞 잡의 readNext(주입) — reaper 가 한 잡을 처분하는 동안 다른 잡이 사라지는 **실제 인터리빙과 같은
    //   await 지점**이라 sleep 없이 결정적이다(프로덕션에 테스트 전용 갈고리를 넣지 않는다).
    const first = await claimedBy(newJob({ run_id: "run-1" })); // 이름순 앞 — 이 잡을 처분하는 사이에
    const second = await claimedBy(newJob({ run_id: "run-2" })); // 뒤 잡이 사라진다(목록엔 이미 잡혔다)
    const r = await reapClaimedJobs(
      reapDeps({
        now: () => T0 + BRIDGE_TIMEOUT + 1,
        readNext: async (rid) => {
          if (rid === "run-1") await rm(second); // ← 그 찰나: C1 이 정상적으로 끝내고 잡을 지웠다
          return na("human");
        },
      }),
    );
    expect(r).toEqual([
      { path: first, consumer: "c1", action: "completed", reason: "transitioned", detail: expect.any(String) },
      { path: second, consumer: "c1", action: "skipped", reason: "vanished", detail: expect.any(String) },
    ]);
    expect(await ls(dirs.failed)).toEqual([]); // ★ 핵심: 정상 완료를 '실패한 잡'으로 기록하지 않았다
    expect(await ls(dirs.pending)).toEqual([]); // 재큐도 없다(리스 규칙 불변)
  });

  it("★ 격리 직전에 사라져도(아슬아슬한 정상 완료) pass 는 살아남는다 — vanished · 잡 없는 .reason 금지", async () => {
    // 읽기 → next-action 조회 → failJob 사이도 같은 경합이다: 그 잡의 주인은 우리가 아니라 소비자다.
    const p = await claimedBy(); // 만료 + 아직 그 차례 → 원래라면 failed/ 격리 경로
    const r = await reapClaimedJobs(
      reapDeps({
        now: () => T0 + BRIDGE_TIMEOUT + 1,
        readNext: async () => {
          await rm(p); // ← 조회하는 사이 소비자가 끝냈다(옮길 원본이 없다)
          return na("generate", "brief"); // 아직 그 차례 → failJob 경로로 들어간다
        },
      }),
    );
    expect(r).toEqual([{ path: p, consumer: "c1", action: "skipped", reason: "vanished", detail: expect.any(String) }]);
    expect(await ls(dirs.failed)).toEqual([]); // 잡도 .reason 도 남지 않았다(실패했다는 거짓 기록 금지)
  });

  it("★ 읽기의 진짜 IO 오류(권한·EISDIR)는 pass 를 거부한다 — '사라짐'으로 삼키지 않는다(거울상 결함)", async () => {
    // 잡 파일 자리에 디렉터리 → EISDIR('없음'도 '깨짐'도 아닌 fs 오류의 대역). ENOENT 만 정상으로 본다.
    await mkdir(join(dirs.claimed, "c1", "run-1-brief.json"), { recursive: true });
    await expect(reapClaimedJobs(reapDeps())).rejects.toThrow();
    expect(await ls(dirs.failed)).toEqual([]);
  });

  it("★ 격리(failJob)의 진짜 IO 오류도 올린다 — 삼키는 것은 ENOENT 하나뿐", async () => {
    // 처분 자리를 비지 않은 디렉터리로 막아 rename 을 ENOENT 아닌 오류로 실패시킨다(IO 오류 대역).
    //   여기서 조용히 넘어가면 격리돼야 할 잡이 흔적 없이 claimed/ 에 남는다(사람이 영영 못 본다).
    await claimedBy();
    await mkdir(join(dirs.failed, "run-1-brief.json", "막힘"), { recursive: true });
    await expect(reapClaimedJobs(reapDeps({ now: () => T0 + BRIDGE_TIMEOUT + 1 }))).rejects.toThrow();
  });

  it("claimed/ 가 없으면 빈 결과(클레임 없음)", async () => {
    expect(await reapClaimedJobs(reapDeps())).toEqual([]);
  });

  it("잡 파일명 규약: <rid>-<stage>.json", () => {
    expect(jobFileName("run-1", "storyboard-outline")).toBe("run-1-storyboard-outline.json");
  });
});
