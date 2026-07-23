/**
 * live-assembly.test.ts — 순수 라이브 구동 루프(driveLoop) 단위. 실 Slack/게이트웨이 없이 **오프라인 결정론**으로
 *   루프 골격을 검증한다(계획 2-3 · 리스크 1 "모든 대기 유한"을 테스트로 못 박음).
 *
 * ── 검증 방식(stuck-detector·policy 의 "순수 함수 + 주입 시계" 패턴 미러) ─────────────
 *   driveLoop 은 게이트웨이·플랫폼·벽시계를 모르는 순수 함수라, 스크립트 fake(프리젠테이션 큐 + 가짜 clock/sleep)를
 *   deps 로 주입해 구동한다. decide 는 **실 decideLive** 를 감아 넣어(통합) 화면→결정 매핑까지 함께 검증한다.
 *   fake 세계: quiesce 마다 화면 포인터를 1 전진(마지막에서 sticky) — 자동 캐스케이드가 다음 화면을 낸다는 모델.
 *
 * ⚠ assembleLiveBackend/LiveDriver 는 실 서비스를 몰기 때문에 여기서 실행하지 않는다(오프라인 조립 거부).
 *   루프 로직만 driveLoop 순수 함수로 떼어내 검증한다(런북 수동 게이트는 불변).
 */
import { describe, expect, it } from "vitest";
import {
  driveLoop,
  LiveDriver,
  liveArtifactPaths,
  type DriveLoopDeps,
  type DriveLoopOptions,
} from "../../src/live/live-assembly.js";
import { decideLive } from "../../src/live/policy.js";
import { TeeRecordingPort } from "../../src/live/tee-port.js";
import type { AffordanceContext } from "../../src/acceptance/affordances.js";
import type { Gateway } from "../../src/kernel/flow.js";
import type { ChatPort, CapabilityManifest } from "../../src/kernel/ports.js";
import type { Presentation } from "../../src/kernel/presentation.js";
import type { ButtonPressed } from "../../src/kernel/events.js";
import type { NextAction } from "../../src/types/contract.js";
import type { Job } from "../../src/types/jobs.js";
import { StuckDetector } from "../../src/live/stuck-detector.js";

const ctx: AffordanceContext = { actor: "chat:live:U-driver", threadId: "t1" };

const BASE_OPTS: DriveLoopOptions = {
  stepBudget: 40,
  runBudgetMs: 4 * 60 * 60 * 1000,
  waitPollMs: 5000,
  recoverBudget: 3,
};

// ── 화면 빌더(유효한 Presentation 최소형) ──────────────────────────────────────────
const progress = (): Presentation => ({ type: "Progress", rid: "r", header: "h", message: "만드는 중" });
const verdict = (outcome: "pass" | "revise" | "human", stage: string | null): Presentation => ({ type: "Verdict", rid: "r", header: "h", outcome, stage });
const failure = (): Presentation => ({ type: "Failure", rid: "r", header: "h", message: "실패" });
const generateRetry = (stage: string): Presentation => ({ type: "GenerateRetry", rid: "r", header: "h", message: "다시", stage });
const escalation = (): Presentation => ({ type: "Escalation", rid: "r", header: "h", gateLabel: "g", hint: "" });
const done = (): Presentation => ({ type: "Done", rid: "r", header: "h", message: "완료", files: [] });
const optionSet = (): Presentation => ({
  type: "OptionSet",
  rid: "r",
  header: "h",
  phase: "02-concept",
  iteration: 0,
  options: [
    { key: "A", title: "A안", body: "", recommended: true },
    { key: "B", title: "B안", body: "", recommended: false },
  ],
  compareMd: "",
  reviseAvailable: false,
});

/**
 * 스크립트 fake — 화면 큐 + 가짜 clock/sleep. quiesce 마다 포인터 1 전진(끝에서 sticky), decide=실 decideLive.
 *   readNaSignature 는 현재 화면 타입으로 안정 서명을 만든다(같은 화면 지속 = 같은 서명 → recover 예산·stuck 판정).
 */
function makeWorld(screens: Presentation[], stuckThresholdMs = 60_000) {
  const fired: ButtonPressed[] = [];
  const clock = { ms: 0 };
  const stuck = new StuckDetector(stuckThresholdMs);
  let idx = -1;
  const current = (): Presentation | null => {
    if (idx < 0 || screens.length === 0) return null;
    return screens[Math.min(idx, screens.length - 1)] ?? null;
  };
  const deps: DriveLoopDeps = {
    quiesce: async () => {
      idx++; // 자동 캐스케이드가 다음 화면을 낸다(끝에서 sticky).
    },
    latestPresentation: () => current(),
    decide: (p) => decideLive(p, ctx),
    fire: async (event) => {
      fired.push(event);
    },
    readNaSignature: async () => {
      const c = current();
      return c ? `na-${c.type}` : null;
    },
    observeStuck: (atMs, sig) => stuck.observe(atMs, sig),
    evaluateStuck: (atMs) => stuck.evaluate(atMs),
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms; // 가짜 sleep = clock 전진(벽시계 미접촉).
    },
  };
  return { deps, fired, clock };
}

describe("driveLoop(순수 라이브 구동 루프)", () => {
  it("① Verdict(pass)→캐스케이드→OptionSet→fire→Done: reached=true, Verdict 에서 발화 안 함", async () => {
    const w = makeWorld([progress(), verdict("pass", "brief"), optionSet(), done()]);
    const res = await driveLoop(w.deps, BASE_OPTS);
    expect(res.reached).toBe(true);
    expect(res.reason).toBe("predicate");
    expect(res.final?.type).toBe("Done");
    // Progress·Verdict(pass)는 wait — 발화는 OptionSet select 딱 1건(Verdict 카드 [다시 만들기] 안 누름).
    expect(w.fired).toHaveLength(1);
    expect(w.fired[0]!.actionId).toBe("select-A");
  });

  it("②a Failure→reconcile(recover)→[생성 완료 확인]→OptionSet→Done: 읽기전용 회복만으로 reached=true(유료 재발화 0)", async () => {
    // Failure→[상태 다시 확인](읽기전용 reconcile)이 상태를 다시 읽으니 생성이 이미 완료(다음 게이트=OptionSet)여서
    //   흐름이 자동으로 이어진다 — 유료 재생성(generate-retry) 발화 없이 select 만 발화한다(늦은 성공 자동 회복).
    const w = makeWorld([failure(), optionSet(), done()]);
    const res = await driveLoop(w.deps, BASE_OPTS);
    expect(res.reached).toBe(true);
    expect(res.reason).toBe("predicate");
    expect(w.fired.map((e) => e.actionId)).toEqual(["reconcile", "select-A"]);
    // 유료 재생성(generate-retry)은 한 번도 발화되지 않는다.
    expect(w.fired.some((e) => e.actionId === "generate-retry")).toBe(false);
  });

  it("②b Failure→reconcile(recover)→GenerateRetry(생성 미완료)→stop:human-input: 자동 유료 재생성 없음(중복 과금 차단)", async () => {
    // 상태 재확인 후에도 '생성 차례'로 남으면(=생성 미완료) 드라이버는 [다시 만들기]를 자동 발화하지 않고 멈춘다 —
    //   모호한 Bridge 타임아웃 창에서의 두 번째 유료 생성·run 경합을 사람 판단으로 게이트한다(Codex P1 수정).
    const w = makeWorld([failure(), generateRetry("02-concept")]); // sticky GenerateRetry.
    const res = await driveLoop(w.deps, BASE_OPTS);
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("human-input");
    expect(res.final?.type).toBe("GenerateRetry");
    // 읽기전용 reconcile 딱 1건만 발화 — generate-retry(유료)는 발화 안 함.
    expect(w.fired.map((e) => e.actionId)).toEqual(["reconcile"]);
    expect(w.fired.some((e) => e.actionId === "generate-retry")).toBe(false);
  });

  it("③ 같은 Failure 서명 무한 → recoverBudget 소진 후 stalled(무한 핑퐁 아님)", async () => {
    const w = makeWorld([failure()]); // sticky Failure 무한.
    const res = await driveLoop(w.deps, { ...BASE_OPTS, recoverBudget: 3 });
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    // 예산(3)만큼만 회복 발화하고 멈춘다.
    expect(w.fired).toHaveLength(3);
  });

  it("④ Escalation → stop:escalation, 발화 없음", async () => {
    const w = makeWorld([escalation()]);
    const res = await driveLoop(w.deps, BASE_OPTS);
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("escalation");
    expect(w.fired).toHaveLength(0);
  });

  it("⑤ Progress 무한 → wait stuck 임계 초과 시 stalled(유한 · 행 아님)", async () => {
    // 임계 20s · poll 5s → 5회 관측(0,5,10,15,20s)만에 stuck(20>=20).
    const w = makeWorld([progress()], 20_000);
    const res = await driveLoop(w.deps, { ...BASE_OPTS, waitPollMs: 5000, runBudgetMs: 600_000 });
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    expect(w.fired).toHaveLength(0);
    // 유한 종료 — clock 이 임계 지점에서 멈췄다(무한 sleep 아님).
    expect(w.clock.ms).toBe(20_000);
  });

  it("⑥ 계속 fire 되는 화면 + 작은 stepBudget → budget 소진(budgetExhausted)", async () => {
    const w = makeWorld([optionSet()]); // sticky OptionSet → 매 반복 fire.
    const res = await driveLoop(w.deps, { ...BASE_OPTS, stepBudget: 3 });
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("budget");
    expect(res.budgetExhausted).toBe(true);
    expect(res.steps).toBe(3);
    expect(w.fired).toHaveLength(3);
  });

  it("⑦ 렌더 전무(null) → 방어적 stop:human-input(행 아님)", async () => {
    const w = makeWorld([]); // 화면 없음.
    const res = await driveLoop(w.deps, BASE_OPTS);
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("human-input");
    expect(res.final).toBeNull();
  });

  it("⑧ readNaSignature 항상 null + Progress 지속 → runBudget(4h) 아닌 stuck 임계에서 stalled(문서화 폴백 구현 · 수정 2)", async () => {
    // na 읽기 반복 실패(contract 파일 미기록·attach 직후 빈 디텍터) 재현: readNaSignature 가 늘 null 이어도 wait 분기가
    //   화면 타입(`screen:` 접두)으로 **항상 관측**해야 stuck 이 뜬다. 옛 버그는 null 을 건너뛰어(if sig!==null) 스냅샷이
    //   하나도 안 쌓여 stuck 이 영영 안 뜨고 4시간 runBudget 까지 대기했다. 임계 20s·poll 5s 로 결정론 못 박음.
    const w = makeWorld([progress()], 20_000);
    w.deps.readNaSignature = async () => null; // 항상 읽기 실패(문서화된 폴백을 강제 발동).
    const res = await driveLoop(w.deps, { ...BASE_OPTS, waitPollMs: 5000, runBudgetMs: 4 * 60 * 60 * 1000 });
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    expect(w.fired).toHaveLength(0);
    // 4시간 runBudget(14_400_000)이 아니라 stuck 임계(20_000)에서 멈춘다 — 폴백이 매 반복 관측을 쌓았다는 증거.
    expect(w.clock.ms).toBe(20_000);
  });
});

// ── (a) liveArtifactPaths — 아티팩트 세션화(S-4) 순수 검증 ─────────────────────────────
describe("liveArtifactPaths(아티팩트 세션화 순수 함수)", () => {
  it("서로 다른 세션 epoch → 서로 다른 transcript/report 경로(덮어쓰기 제거) · final 은 epoch 무관 고정", () => {
    const a = liveArtifactPaths("/art", "chat-x", 111);
    const b = liveArtifactPaths("/art", "chat-x", 222);
    // 세션 경로엔 epoch 가 박힌다(경로 join 포함).
    expect(a.transcript).toBe("/art/chat-x-transcript.111.jsonl");
    expect(a.reportMd).toBe("/art/chat-x-report.111.md");
    expect(a.reportJson).toBe("/art/chat-x-report.111.json");
    // 두 세션이 같은 rid 라도 세션 경로는 겹치지 않는다(재기동이 옛 세션을 덮어쓰지 않음).
    expect(a.transcript).not.toBe(b.transcript);
    expect(a.reportMd).not.toBe(b.reportMd);
    expect(a.reportJson).not.toBe(b.reportJson);
    // final 은 세션 무관 고정 이름 — done 세션이 여기 terminal 리포트를 쓰면 그게 최종 진실.
    expect(a.finalReportMd).toBe("/art/chat-x-report.final.md");
    expect(a.finalReportJson).toBe("/art/chat-x-report.final.json");
    expect(a.finalReportMd).toBe(b.finalReportMd);
    expect(a.finalReportJson).toBe(b.finalReportJson);
  });
});

// ── (b~f) LiveDriver.attach — 중간-재개(S-2) fake 인프라 ─────────────────────────────
// 실 Slack/워커 없이 attach(중간-재개)와 그 뒤 runToDone 이어달리기를 오프라인 결정론으로 검증한다.
//   핵심 배선(실 조립과 동형): gw.chat 과 LiveDriver.teePort 는 **같은 TeeRecordingPort** — reconcile(재게시)·
//   onOutcome(전이 카드)가 teePort 로 렌더되고 latestPresentation 이 그걸 읽는다. fire 는 실 onAction 을 타므로
//   approve 발화가 진짜 잡 경로(gw.queue.submit)로 흐른다 — 워커만 fake(승인 잡을 받으면 다음 화면을 렌더 +
//   next-action 전이). 시계/sleep 은 주입(벽시계 미접촉).

/** TeeRecordingPort 는 delegate(실 Slack)가 필수 — 테스트는 아무것도 안 하는 no-op 포트로 대체(기록은 teePort 가 함). */
const noopDelegate: ChatPort = {
  async render() {},
  async subscribe() {},
  capabilities(): CapabilityManifest {
    return { imageDelivery: "upload" };
  },
};

/** 유효한 NextAction 최소형(over 로 필드 덮어씀). core next-action.sh 한 줄 JSON 의 구조를 미러. */
function naFixture(over: Partial<NextAction>): NextAction {
  return {
    rid: "chat-t1",
    phase: "01-brief",
    phase_label: "브리프",
    step: "human",
    gate: "user",
    status: "pending",
    awaiting: "user",
    iteration: null,
    max_iterations: null,
    action: "approve",
    stage: null,
    needs: null,
    options: [],
    recommended: null,
    ra_ok_required: false,
    revise_available: false,
    gate_type: "human-verify",
    stop_reason: null,
    advisory: null,
    cmd: "",
    gate_label: "승인",
    hint: "",
    files: [],
    ...over,
  } as NextAction;
}

const APPROVE_NA = (): NextAction => naFixture({ action: "approve", phase: "01-brief" });
const GENERATE_NA = (): NextAction => naFixture({ action: "generate", phase: "02-concept", stage: "02-concept", step: "generate", gate: "review", awaiting: "review" });
const REVIEW_NA = (): NextAction => naFixture({ action: "review", phase: "02-concept", stage: "02-concept", step: "review", gate: "review", awaiting: "review" });
const DONE_NA = (): NextAction => naFixture({ action: "done", phase: "done", step: "done", gate: null, awaiting: "none" });
const doneP = (): Presentation => ({ type: "Done", rid: "r", header: "h", message: "완료", files: [] });

interface FakeLive {
  gw: Gateway;
  teePort: TeeRecordingPort;
  submitted: Job[];
  newDriver(): LiveDriver;
}

/**
 * fake 라이브 백엔드 — 실 게이트웨이 대신 최소 표면만 구현한다. naRef.current 가 core next-action 을 흉내내고,
 *   fake 워커(queue.submit)가 handleJob 으로 '잡 처리 후 다음 화면 렌더 + na 전이'를 수행한다(늦은 성공/자동
 *   이어가기 캐스케이드의 오프라인 대역). rid=null 이면 스레드↔run 매핑 없음(attach 폴백 경로).
 */
function makeFakeLive(opts: {
  rid: string | null;
  naRef: { current: NextAction | null };
  handleJob?: (
    job: Job,
    ctx: { render: (p: Presentation) => Promise<void>; setNa: (na: NextAction | null) => void },
  ) => Promise<void> | void;
}): FakeLive {
  const teePort = new TeeRecordingPort({ delegate: noopDelegate });
  const submitted: Job[] = [];
  const clock = { ms: 0 };
  const gw = {
    chat: teePort,
    map: {
      runForThread: async () => opts.rid,
      threadForRun: async () => (opts.rid ? "t1" : null),
    },
    // reconcile/readNa 가 읽는다. null 이면 throw → flow 가 catch(()=>null) 로 흡수(읽기 실패 = 관측 불가).
    readNext: async () => {
      if (!opts.naRef.current) throw new Error("no next-action");
      return opts.naRef.current;
    },
    readSurface: async () => null, // 오버레이 없음(na 기반 폴백 — 기존 테스트 관용구).
    isApprover: () => true,
    queue: {
      activeRuns: 0,
      drain: async () => {}, // fake 캐스케이드는 submit 에서 즉시 렌더하므로 drain 은 no-op.
      submit: async (job: Job) => {
        submitted.push(job);
        await opts.handleJob?.(job, {
          render: (p) => teePort.render("t1", p),
          setNa: (na) => {
            opts.naRef.current = na;
          },
        });
      },
    },
  } as unknown as Gateway;
  return {
    gw,
    teePort,
    submitted,
    newDriver: () =>
      new LiveDriver(gw, teePort, {
        now: () => clock.ms,
        sleep: async (ms) => {
          clock.ms += ms;
        },
        stuckThresholdMs: 60_000,
      }),
  };
}

describe("LiveDriver.attach(중간-재개 · S-2)", () => {
  it("(b) 기존 run + approve 게이트 → attach 가 현재 게이트 카드 1회 재게시 + attached:true(멘션 없음)", async () => {
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();

    const res = await driver.attach("t1");

    expect(res.attached).toBe(true);
    expect(res.rid).toBe("chat-t1");
    // reconcile 이 readNext(approve)를 재파생해 ApproveGate 를 딱 1회 재게시(teePort=gw.chat).
    const renders = fake.teePort.renders();
    expect(renders).toHaveLength(1);
    expect(renders[0]!.presentation.type).toBe("ApproveGate");
    // 멘션은 다시 쏘지 않는다 — attach 는 잡을 만들지 않는다(읽기 전용 화해).
    expect(fake.submitted).toHaveLength(0);
  });

  it("(c) attach 후 runToDone 이어달리기: 재게시 ApproveGate → fire(approve) → Done → predicate 종료", async () => {
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({
      rid: "chat-t1",
      naRef,
      // 승인 잡을 받으면 fake 워커가 done 으로 전이 + Done 화면 렌더(늦은 성공/캐스케이드 대역).
      handleJob: async (job, { render, setNa }) => {
        if (job.kind === "approve") {
          setNa(DONE_NA());
          await render(doneP());
        }
      },
    });
    const driver = fake.newDriver();

    const attached = await driver.attach("t1"); // 현재 게이트(ApproveGate) 재게시.
    expect(attached.attached).toBe(true);

    const res = await driver.runToDone(); // 재게시된 ApproveGate 를 latest 로 이어 몬다.

    expect(res.reached).toBe(true);
    expect(res.reason).toBe("predicate");
    expect(res.final?.type).toBe("Done");
    // approve 딱 1건 발화(직전 렌더 affordance 에서 도출 · 지어낸 버튼 0).
    expect(fake.submitted.map((j) => j.kind)).toEqual(["approve"]);
    // 화면 순서: 재게시 ApproveGate → Done.
    expect(fake.teePort.renders().map((r) => r.presentation.type)).toEqual(["ApproveGate", "Done"]);
  });

  it("(d) 매핑 없는 스레드 → attach 는 attached:false·rid:null(호출부 mention 폴백) · 재게시 0", async () => {
    const naRef = { current: null };
    const fake = makeFakeLive({ rid: null, naRef });
    const driver = fake.newDriver();

    const res = await driver.attach("t-new");

    expect(res.attached).toBe(false);
    expect(res.rid).toBeNull();
    // 재개할 run 이 없으니 아무것도 재게시하지 않는다(reconcile 미진입).
    expect(fake.teePort.renders()).toHaveLength(0);
  });

  it("(e) 생성 차례면 재게시가 GenerateRetry + runToDone 은 stop:human-input(자동 유료 재생성 금지 불변)", async () => {
    const naRef = { current: GENERATE_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();

    const attached = await driver.attach("t1");
    expect(attached.attached).toBe(true);
    // 생성 차례 = presentationForStatusCheck 이 GenerateRetry 카드를 낸다(만들어지지 않음 신호).
    const renders = fake.teePort.renders();
    expect(renders).toHaveLength(1);
    expect(renders[0]!.presentation.type).toBe("GenerateRetry");

    const res = await driver.runToDone();

    // GenerateRetry 는 stop:human-input — [다시 만들기]를 자동 발화하지 않는다(중복 과금 차단).
    expect(res.reached).toBe(false);
    expect(res.reason).toBe("human-input");
    expect(res.final?.type).toBe("GenerateRetry");
    expect(fake.submitted).toHaveLength(0); // 유료 재생성 잡 0.
  });

  it("(f) 드라이버 kill → 재기동(새 인스턴스 attach) → 계속 → done(죽은 드라이버 재개 시나리오)", async () => {
    // 드라이버1 이 게이트 카드를 재게시한 직후 프로세스가 죽었다(runToDone 미수행 = SIGTERM 재현). 재기동한
    //   **새 LiveDriver 인스턴스**(fresh StuckDetector)가 같은 gw+teePort 상태를 이어받아 done 까지 몬다 — 옛 세션의
    //   stuck 관측을 물려받지 않고, 재멘션 없이 attach 로만 재개한다(계획 DoD 2).
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({
      rid: "chat-t1",
      naRef,
      handleJob: async (job, { render, setNa }) => {
        if (job.kind === "approve") {
          setNa(DONE_NA());
          await render(doneP());
        }
      },
    });

    // 드라이버1: 재기동 attach 로 현재 게이트 재게시 후 죽음(이어달리기 없음).
    const driver1 = fake.newDriver();
    const r1 = await driver1.attach("t1");
    expect(r1.attached).toBe(true);
    expect(fake.teePort.renders()).toHaveLength(1); // 게이트 1회 재게시하고 사망.
    expect(fake.submitted).toHaveLength(0); // 죽은 드라이버는 아무 잡도 못 냈다.

    // 재기동: 완전히 새 인스턴스가 같은 상태를 이어받는다.
    const driver2 = fake.newDriver();
    const r2 = await driver2.attach("t1");
    expect(r2.attached).toBe(true);
    expect(r2.rid).toBe("chat-t1");
    expect(fake.teePort.renders()).toHaveLength(2); // 재기동이 현재 게이트를 다시 게시(사람이 다시 볼 수 있게).

    const res = await driver2.runToDone();
    expect(res.reached).toBe(true);
    expect(res.reason).toBe("predicate");
    expect(res.final?.type).toBe("Done");
    // 재기동 드라이버가 approve 를 딱 1건 발화해 done 도달(드라이버1 은 0건).
    expect(fake.submitted.map((j) => j.kind)).toEqual(["approve"]);
  });

  it("(g) 리뷰 게이트 attach → 규정 점검 Progress 재게시 + 심의 잡 1건 재적재(kind/actor/payload 형태 고정)", async () => {
    // 죽은 프로세스의 소실된 in-memory 리뷰 잡을 attach 가 화해하는 유일한 경로(수정 1). reconcile 은 Progress 만
    //   재게시하므로, 리뷰 차례면 enqueueReviewIfDue 가 심의 잡을 딱 1건 재적재해 stuck→stalled 죽음을 막는다.
    const naRef = { current: REVIEW_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();

    const res = await driver.attach("t1");

    expect(res.attached).toBe(true);
    expect(res.reviewResumed).toBe(true);
    // reconcile 이 review na 를 "규정 점검 중" Progress 로 딱 1회 재게시.
    const renders = fake.teePort.renders();
    expect(renders).toHaveLength(1);
    expect(renders[0]!.presentation.type).toBe("Progress");
    // 심의 재적재 1건 — onOutcome 자동 이어가기(flow.ts 1077행)와 정확히 같은 형태(actor=chat:auto·payload={}).
    expect(fake.submitted).toEqual([{ kind: "review", run_id: "chat-t1", actor: "chat:auto", payload: {} }]);
  });

  it("(h) 비-review(approve) attach → reviewResumed:false · 심의 잡 0(리뷰 아닌 게이트는 재적재 안 함)", async () => {
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();

    const res = await driver.attach("t1");

    expect(res.attached).toBe(true);
    expect(res.reviewResumed).toBe(false);
    expect(fake.submitted).toHaveLength(0); // 승인 게이트는 사람 몫 — 자동 재적재 없음.
  });

  it("(i) 생성 차례 attach → reviewResumed:false · 잡 0(유료 생성 자동 적재 금지 잠금) · 재게시는 GenerateRetry", async () => {
    // 잠긴 결정: attach 는 리뷰만 재적재하고 generate(유료 생성)는 절대 자동 적재하지 않는다(중복 과금은 사람 몫).
    const naRef = { current: GENERATE_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();

    const res = await driver.attach("t1");

    expect(res.attached).toBe(true);
    expect(res.reviewResumed).toBe(false);
    expect(fake.submitted).toHaveLength(0); // 유료 생성 자동 적재 0.
    // 재게시 카드는 GenerateRetry(생성 미완료 신호 · 기존 (e) 와 정합).
    const renders = fake.teePort.renders();
    expect(renders).toHaveLength(1);
    expect(renders[0]!.presentation.type).toBe("GenerateRetry");
  });
});

// ── (j) LiveDriver stuck 서명(렌더 마커 · 수정 2) ────────────────────────────────────
describe("LiveDriver stuck 서명(렌더 마커 · 수정 2)", () => {
  it("(j) 같은 na 서명 wait 루프 + 중간 새 렌더 1건 → 첫 렌더 임계 지나도 stalled 아님, 마지막 렌더 임계에서 stalled", async () => {
    // 잡-레벨 리뷰 재시도는 전 구간 같은 na 서명(review)이지만 시도마다 새 Progress 카드를 렌더한다 → 새 렌더가
    //   stuck 창을 리셋해야 15분 임계를 조기 stalled 로 넘기지 않는다. threshold=20s·poll=5s 로 결정론 못 박음.
    const naRef = { current: REVIEW_NA() }; // decideLive(Progress)=wait 유발.
    const clock = { ms: 0 };
    const teePort = new TeeRecordingPort({ delegate: noopDelegate });
    let drainCount = 0;
    const gw = {
      chat: teePort,
      map: { runForThread: async () => "chat-t1", threadForRun: async () => "t1" },
      readNext: async () => naRef.current,
      readSurface: async () => null,
      isApprover: () => true,
      queue: {
        activeRuns: 0,
        // 세 번째 quiesce 때 새 Progress 카드 1건(리뷰 재시도가 새 카드를 낸 것 = 활동 신호 → stuck 창 리셋).
        drain: async () => {
          drainCount++;
          if (drainCount === 3) await teePort.render("t1", { type: "Progress", rid: "r", header: "h", message: "다시 점검 중" });
        },
        submit: async () => {}, // attach 리뷰 재적재는 no-op(렌더 유발 안 함).
      },
    } as unknown as Gateway;
    const driver = new LiveDriver(gw, teePort, {
      now: () => clock.ms,
      sleep: async (ms) => {
        clock.ms += ms;
      },
      stuckThresholdMs: 20_000,
      waitPollMs: 5000,
      runBudgetMs: 10 * 60_000,
    });

    // attach 로 _threadId 바인딩 + 최초 Progress 카드(r1) 재게시(readNa 가 스레드 바인딩을 요구).
    const at = await driver.attach("t1");
    expect(at.attached).toBe(true);
    expect(teePort.renders()).toHaveLength(1);

    const res = await driver.runToDone();

    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    // 첫 렌더(r1) 기준 임계는 now=20000 이지만, iteration 3 의 새 렌더(r2)가 창을 리셋해 now=30000 에서 stalled.
    //   즉 첫 관측 기준 임계(20000)를 지나도 stalled 아니었고, 마지막 렌더 기준 임계(30000)에서 발화(리셋 실증).
    expect(clock.ms).toBe(30_000);
  });

  it("(k) 렌더 없음(종단 화면) → 기존대로 임계에 stalled(마커가 종단 발화를 막지 않음)", async () => {
    // 새 렌더가 없으면 서명이 고정(#r 마커 불변)돼 기존 stuck 임계에서 그대로 stalled — 종단 백스톱 불변 확인.
    const naRef = { current: REVIEW_NA() };
    const clock = { ms: 0 };
    const teePort = new TeeRecordingPort({ delegate: noopDelegate });
    const gw = {
      chat: teePort,
      map: { runForThread: async () => "chat-t1", threadForRun: async () => "t1" },
      readNext: async () => naRef.current,
      readSurface: async () => null,
      isApprover: () => true,
      queue: { activeRuns: 0, drain: async () => {}, submit: async () => {} }, // 새 렌더 없음.
    } as unknown as Gateway;
    const driver = new LiveDriver(gw, teePort, {
      now: () => clock.ms,
      sleep: async (ms) => {
        clock.ms += ms;
      },
      stuckThresholdMs: 20_000,
      waitPollMs: 5000,
      runBudgetMs: 10 * 60_000,
    });

    await driver.attach("t1"); // r1 재게시 후 더는 렌더 없음.
    const res = await driver.runToDone();

    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    // 첫 관측(now=0)부터 서명 불변 → 임계 20000 에서 그대로 stalled(리셋 없음).
    expect(clock.ms).toBe(20_000);
  });
});

// ── (l~n) LiveDriver 스레드 격리(교차-스레드 오염 차단 · 수정 1) ────────────────────────
// 라이브 드라이버는 프로덕션과 **같은 게이트웨이·같은 TeeRecordingPort** 를 공유한다(배선 동등). 그래서 같은 워크스페이스의
//   다른 스레드(프로덕션 봇이 응대하는 남의 런) 렌더가 이 teePort 로 흘러들 수 있다 — 드라이버 뷰가 threadId 필터 없이
//   렌더를 집으면 (a) 남의 카드에서 결정을 도출해 오발화하고 (b) 트랜스크립트·stuck 마커를 오염시킨다. 아래는 소비 지점
//   전부(latestPresentation·presentations·recordStep·stuckSignature)가 **자기 스레드로 필터**됨을 못 박는다.
describe("LiveDriver 스레드 격리(교차-스레드 오염 차단 · 수정 1)", () => {
  it("(l) 혼합 스레드 렌더 → latestPresentation/presentations 는 내 스레드(A)만(남의 스레드 B 가 더 나중이어도)", async () => {
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({ rid: "chat-t1", naRef });
    const driver = fake.newDriver();
    await driver.attach("t1"); // _threadId="t1"(A) 바인딩 + ApproveGate@t1 재게시.
    // 남의 스레드 B 활동이 같은 teePort 로 새어든다(스코프 없는 배선이 흘린 상황 재현). B 를 A 보다 **나중에** 렌더.
    await fake.teePort.render("t1", { type: "Progress", rid: "r", header: "h", message: "A 진행" }); // A 마지막 카드.
    await fake.teePort.render("tB", { type: "Failure", rid: "rB", header: "hB", message: "B 실패" }); // 시점상 최신(남의 것).
    // latest 는 시점상 마지막인 B(Failure)가 아니라 A 의 마지막(Progress)이어야 한다(스레드 격리).
    expect(driver.latestPresentation()?.type).toBe("Progress");
    // presentations()도 A 렌더만(ApproveGate + Progress) — B(Failure)는 안 보인다.
    expect(driver.presentations().map((p) => p.type)).toEqual(["ApproveGate", "Progress"]);
  });

  it("(m) recordStep/transcript 는 내 스레드(A) 렌더만 소비 — 남의 스레드(B) 카드는 트랜스크립트에 안 샌다", async () => {
    const naRef = { current: APPROVE_NA() };
    const fake = makeFakeLive({
      rid: "chat-t1",
      naRef,
      handleJob: async (job, { render, setNa }) => {
        if (job.kind === "approve") {
          setNa(DONE_NA());
          await render(doneP()); // Done@t1.
        }
      },
    });
    const driver = fake.newDriver();
    await driver.attach("t1"); // ApproveGate@t1 재게시, _threadId="t1".
    // 남의 스레드 B 활동이 같은 teePort 로 새어든다(발화 전 주입 — 필터 없으면 recordStep 슬라이스에 삼켜진다).
    await fake.teePort.render("tB", { type: "Failure", rid: "rB", header: "hB", message: "B 실패" });

    const res = await driver.runToDone(); // ApproveGate→fire(approve)→Done.
    expect(res.reached).toBe(true);

    // 트랜스크립트 어느 스텝 화면에도 B(Failure)가 없다 — A(ApproveGate/Done)만 소비(_consumed 커서도 A 필터 기준).
    const allScreenTypes = driver.transcript.entries.flatMap((e) => e.screens.map((s) => s.type));
    expect(allScreenTypes).not.toContain("Failure");
    expect(allScreenTypes).toEqual(["ApproveGate", "Done"]);
  });

  it("(n) 남의 스레드(B) 렌더 증가는 stuck 렌더-수 마커를 리셋하지 않는다 — 같은 na 서명 + B 만 증가 → 임계에 stalled", async () => {
    // 회귀 가드: stuck 마커(#rN)가 **전체 teePort.renders()** 로 셌다면 B 렌더가 늘 때마다 마커가 흔들려 stuck 창이
    //   영영 리셋됐다(→ runBudget 까지 대기). **자기 스레드(myRenders) 길이** 기준이라, 내 렌더가 안 늘면 마커가 고정돼
    //   같은 na 서명이 임계(20s)에서 그대로 stalled 된다(종단 백스톱 불변). threshold=20s·poll=5s 로 결정론 못 박음.
    const naRef = { current: REVIEW_NA() }; // decideLive(Progress)=wait 유발.
    const clock = { ms: 0 };
    const teePort = new TeeRecordingPort({ delegate: noopDelegate });
    const gw = {
      chat: teePort,
      map: { runForThread: async () => "chat-t1", threadForRun: async () => "t1" },
      readNext: async () => naRef.current,
      readSurface: async () => null,
      isApprover: () => true,
      queue: {
        activeRuns: 0,
        // 매 quiesce 마다 **남의 스레드 B** 렌더 1건(프로덕션 봇이 남의 런을 응대 중). 내 스레드(t1) 렌더는 안 는다.
        drain: async () => {
          await teePort.render("tB", { type: "Progress", rid: "rB", header: "hB", message: "B 진행" });
        },
        submit: async () => {}, // attach 리뷰 재적재 no-op.
      },
    } as unknown as Gateway;
    const driver = new LiveDriver(gw, teePort, {
      now: () => clock.ms,
      sleep: async (ms) => {
        clock.ms += ms;
      },
      stuckThresholdMs: 20_000,
      waitPollMs: 5000,
      runBudgetMs: 10 * 60_000,
    });

    await driver.attach("t1"); // r1(t1) Progress 재게시. 이후 t1 렌더는 안 늘고 B 만 는다.
    const res = await driver.runToDone();

    expect(res.reached).toBe(false);
    expect(res.reason).toBe("stalled");
    // B 렌더가 계속 늘어도 내 스레드(t1) 렌더 수(#r1)는 고정 → stuck 창 리셋 없이 임계 20000 에서 stalled.
    //   (전체 renders 로 셌다면 B 증가가 마커를 흔들어 runBudget[600000]까지 갔을 것 = 교차-스레드 오염 회귀.)
    expect(clock.ms).toBe(20_000);
  });
});
