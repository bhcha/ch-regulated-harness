/**
 * cli-consumer.ts — 무인 생성 소비자 **데몬**(W4). 봇(BridgeGenExecutor)이 `jobs/pending/` 에 적재한 생성 잡을,
 *   사람 운영자 대신 소비한다: pending 폴링 → 2중 검사 → 클레임 → 잡 세션(W3 러너) → 성공 삭제 / 실패 failed/.
 *   **사람 관점 무인, core 관점 insession** — core 게이트·승인·심의는 전부 불변이고 무인화 범위는 '생성'뿐이다.
 *
 * 이 모듈이 소유하는 것(계획 W4):
 *   ① **데몬 루프** — 기동 리퍼(2종) → 폴링 → enablement 필터 → 잡 수 상한 → 클레임·소비(동시성 1) → 관측 로그.
 *   ② **큐 리퍼 배선**(`reapClaimedJobs`) — 기동 시 지난 생의 stale 클레임을 마감(리스)만 보고 정리(생사추정 없음 ·
 *      job-protocol 이 이미 마감-리스 기반으로 재작성됨 — 재큐하지 않는다).
 *   ③ **프로세스 소유권 리퍼**(`evaluateReap` 의 **첫 소비자**) — supervisor 급사로 고아가 된 세션 그룹을 nonce
 *      소유권 원장(ownership.ts)으로 회수한다. raw-PID/하트비트 생사추정이 아니라 **exec-env nonce 검증-후-kill**
 *      로만 신호하고, 미지 원장 버전은 거부한다. killAt-바운드 에스컬레이션은 **잠긴 결정 4 개정**(사람 승인 대상 —
 *      계획 3-1 절 S34-R2 · 아래 escalate 주석).
 *   ④ **잡 세션 seam**(`RunJobFn`) — 온라인 = detached supervisor(`supervisor.ts` main)를 잡마다 띄워
 *      runJobSession 이 그 안에서 돌게 한다(잠긴 결정 4 · 데몬은 supervisor 를 SIGTERM 으로 우아하게 회수) ·
 *      오프라인 = `run-stage.sh` 직접(결정적 stub · CI/E2E). 선택은 `HARNESS_OFFLINE` 로 갈린다(selectGenExecutor 대칭).
 *
 * 불변식(계획·AGENTS):
 *   · **core 무수정** — state.json 직접 쓰기 0. 잡큐 파일(chat/jobs/**)과 소유권 원장(chat/jobs/ledgers/**)만 만지고,
 *     상태 변이는 오직 core 스크립트(run-stage.sh)가 세션 안에서 한다.
 *   · **kernel-neutral** — 어떤 챗 플랫폼도 모른다(adapters/slack 를 import 하지 않는다 · 잡큐 파일이 유일 이음새).
 *   · **동시성 1** — 한 번에 잡 1건(consumeOne 이 완주해야 다음을 집는다).
 *   · **enablement** — CHAT_SDK_STAGES 미등재 단계의 잡은 **집지 않는다**(비우면 어느 단계도 무인 아님 = 기본 off).
 *   · **무한대기·좀비 금지** — 마감(expires_at) 없는 v1 잡은 집지 않는다(takePendingJob 사전 필터) · 세션 상한은
 *     supervisor 의 kill_at 스케줄이 강제(W3).
 *
 * ⚠ **오프라인 유지(W4 DoD)**: 폴링·클레임·리퍼·잡세션은 전부 주입 seam 뒤에 있다. 단위 테스트는 가짜 fs/스폰·주입
 *   시계·가짜 procView 로 돈다 — **실 `claude` 세션도 실 신호도 여기 검증에서 뜨지 않는다**(라이브 스모크는 W5). 실
 *   supervisor spawn(온라인)·실 `ps`/`pgrep` ProcView 는 **라이브 전용 · unit/e2e 미검증**(아래 default* 주석).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PACKAGE_ROOT,
  harnessRoot,
  isOffline,
  sdkConsumerId,
  sdkDailyJobCap,
  sdkGenTimeout,
  sdkPollIntervalMs,
  sdkStages,
  storagePaths,
  WORKER_STARTUP_MARGIN_MS,
} from "../config.js";
import { readNextAction } from "../kernel/contract-client.js";
import { runStage as defaultRunStage, type HarnessResult } from "../kernel/harness-cli.js";
import {
  completeJob,
  failJob,
  jobDirsOf,
  listPendingJobs,
  parseDeadline,
  reapClaimedJobs,
  takePendingJob,
  type JobDirs,
  type ReapResult,
  type TakeAction,
} from "../kernel/job-protocol.js";
import type { GenerateJobFile } from "../types/jobs.js";
import type { NextAction } from "../types/contract.js";
import type { RunJobFailReason, RunJobResult } from "./cli-session-runner.js";
import {
  evaluateReap,
  LedgerParseError,
  parse as parseLedger,
  REGISTER_LAG_MARGIN_MS,
  SESSION_NONCE_ENV,
  type ProcView,
  type SessionEntry,
} from "./ownership.js";
import { realGroupAlive, realSignalGroup } from "./supervisor.js";

// ══════════════════════════════════════════════════════════════════════════════════
// 잡 세션 seam(RunJobFn) — 온라인 supervisor spawn · 오프라인 run-stage 직접
// ══════════════════════════════════════════════════════════════════════════════════

/** 잡 1건을 실제로 돌리는 데 필요한 입력(데몬이 클레임 직후 조립). */
export interface RunJobInput {
  /** core(하네스) 체크아웃 절대경로. */
  coreRoot: string;
  /** 이 잡의 run_id. */
  rid: string;
  /** run-stage 인자(intake·brief · 잡의 stage). */
  stage: string;
  /** 세션 기동(클레임) 시각 ms — supervisor kill_at 예산의 기준. */
  claimedAtMs: number;
  /** 잡 절대 마감 ms(잡 파일 expires_at → ms). */
  deadlineMs: number;
  /** 이 잡 전용 격리 CLAUDE_CONFIG_DIR(절대경로 · 데몬이 만들고 정리). */
  configDir: string;
  /** 이 잡의 소유권 원장 경로(절대경로 · supervisor 가 CHAT_SESSION_LEDGER 로 받아 쓴다). */
  ledgerPath: string;
}

/** 잡 세션 실행 seam — RunJobResult(W3 계약)를 돌려준다. 큐 처분(complete/fail)은 데몬 몫. */
export type RunJobFn = (input: RunJobInput) => Promise<RunJobResult>;

/**
 * **오프라인 stub 잡 실행**(결정적 · CI/E2E) — `run-stage.sh <stage> <rid>` 를 직접 돌린다(HARNESS_OFFLINE=1
 *   전제). StubDirectGenExecutor 와 같은 경로다: 세션을 띄우지 않고 core stub 이 산출물을 결정론적으로 만든다.
 *   ⚠ 이 경로는 **오프라인 전용**이다 — 온라인에서 부르면 core 가 fail-closed(헤드리스 실엔진 금지). 그 방어는
 *     runStage 아래 harness-cli/common.sh 가 한다. 여기서는 stub 완주/실패를 RunJobResult 로 환원만 한다.
 */
export function makeStubRunJob(
  runStage: (stage: string, rid: string) => HarnessResult | Promise<HarnessResult> = defaultRunStage,
): RunJobFn {
  return async (input: RunJobInput): Promise<RunJobResult> => {
    const res = await runStage(input.stage, input.rid);
    if (res.code === 0) {
      return { ok: true, via: "main", detail: "stub 직접 생성(run-stage.sh) 완주" };
    }
    const tail = res.stderr.trim() || res.stdout.trim() || "(출력 없음)";
    // stub 은 세션이 없어 세부 실패 분류가 없다 — still_not_transitioned 로 환원(전이 안 됨 = 실패).
    return { ok: false, reason: "still_not_transitioned", detail: `stub 생성 실패(code=${res.code}): ${tail}` };
  };
}

/**
 * supervisor.ts 의 절대경로(형제 모듈). 데몬은 이 파일을 tsx 로 **detached** spawn 한다(supervisor.ts main() 진입점).
 */
const SUPERVISOR_MODULE = join(dirname(fileURLToPath(import.meta.url)), "supervisor.ts");

/** tsx 실행기 경로(chat 패키지의 devDependency). 온라인 세션 spawn 에만 쓰인다(라이브 전용). */
const TSX_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");

/**
 * 부모(데몬) watchdog 유예 = 60초. supervisor 는 자기 kill_at 스케줄로 스스로 마감을 강제하지만(1급), 그 supervisor
 *   **자신이** 행(이벤트루프 정지·타이머 실패)이면 stdout close 가 영영 안 와 데몬이 `await runJob` 에서 무한 대기한다.
 *   그래서 데몬은 잡 마감(deadlineMs)에 이 유예를 더한 시점에 **독립 백스톱**으로 supervisor 를 회수한다(SIGTERM→
 *   유예→SIGKILL). supervisor 의 kill_at(마감 이전) 이후라 정상 종료엔 절대 안 걸리고, supervisor 급사·행에만 문다.
 */
export const PARENT_WATCHDOG_GRACE_MS = 60_000;
/** watchdog 발화 후 supervisor 정상 종료(우아한 SIGTERM)를 기다리는 유예. 초과 시 그룹 SIGKILL. */
const PARENT_WATCHDOG_KILL_GRACE_MS = 10_000;

/**
 * **온라인 supervisor spawn 잡 실행**(⚠ **라이브 전용 · unit/e2e 미검증 — W5 카나리**). 잡마다 `supervisor.ts` 를
 *   **detached** 로 띄워(자기 프로세스그룹 리더 · 잠긴 결정 4) 그 안에서 runJobSession 이 주/복구 세션을 돌리게 하고,
 *   supervisor 가 stdout 한 줄로 내보내는 RunJobResult 를 읽는다.
 *
 * 왜 in-process runJobSession 이 아니라 별도 프로세스인가(supervisor.ts 헤더 · 계획 잠긴 결정 4):
 *   · supervisor 가 **자기 프로세스그룹 리더**여야 데몬이 `SIGTERM` 먼저 보내 종료 전파(installSupervisorTermination
 *     Handlers)를 돌릴 수 있다(우아한 회수의 1경로).
 *   · 데몬이 죽어도 supervisor 는 kill_at 스케줄로 세션을 계속 강제한다(데몬↔supervisor 독립 급사 내성).
 *   · supervisor 급사 시의 2급 백스톱 = **소유권 원장**(reapOwnershipLedgers 가 nonce 검증하 회수).
 *
 * ⚠ 회수 계약(supervisor.ts 헤더): 이 spawn 은 detached 세션을 **유지**하므로, 데몬이 잡을 중도 회수하려면
 *   **supervisor 에 SIGTERM 을 먼저**(종료 전파) 보내거나 원장의 세션 pgid 를 nonce 검증하 직접 kill 해야 한다 —
 *   맨몸 `kill(-supervisorPID, SIGKILL)` 하나로는 부족하다.
 */
export function makeSupervisorSpawnRunJob(opts: {
  oauthToken?: string;
  /** 이 데몬이 돌려받는 살아있는 supervisor pid 를 등록/해제하는 훅(우아한 종료 시 SIGTERM 대상). */
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}): RunJobFn {
  return (input: RunJobInput): Promise<RunJobResult> =>
    new Promise<RunJobResult>((resolve) => {
      // 잡 스펙(RunJobSessionInput 부분집합) — 비밀(oauthToken)은 파일에 남기지 않는다(supervisor 가 env 에서 읽는다).
      const spec = {
        coreRoot: input.coreRoot,
        rid: input.rid,
        stage: input.stage,
        claimedAtMs: input.claimedAtMs,
        deadlineMs: input.deadlineMs,
        configDir: input.configDir,
      };
      const specPath = join(input.configDir, "job-spec.json");
      try {
        mkdirSync(input.configDir, { recursive: true });
        writeFileSync(specPath, `${JSON.stringify(spec)}\n`, "utf8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resolve({ ok: false, reason: "config_error", detail: `잡 스펙 기록 실패: ${msg}` });
        return;
      }
      // supervisor env — 원장 경로·인증·HARNESS_ROOT 를 실어 준다. 세션 위생 재구성은 supervisor 안 cli-session 이
      //   process.env 를 base 로 한 번 더 한다(비밀 스크럽·화이트리스트). 여기서는 필요한 것만 명시 전달.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HARNESS_ROOT: input.coreRoot,
        CHAT_SESSION_LEDGER: input.ledgerPath,
      };
      if (opts.oauthToken !== undefined && opts.oauthToken !== "") {
        env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
      }
      const child = spawn(TSX_BIN, [SUPERVISOR_MODULE, specPath], {
        cwd: input.coreRoot,
        env,
        // detached: supervisor 를 자기 그룹 리더로(잠긴 결정 4). stdin ignore(무인이라 답할 주체 없음)·stdout/stderr pipe.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid !== undefined) opts.onSpawn?.(pid);
      let stdout = "";
      let stderr = "";
      let over = false;
      const CAP = 8 * 1024 * 1024;
      const capAppend = (cur: string, d: Buffer): string => {
        if (over) return cur;
        const s = d.toString("utf8");
        if (cur.length + s.length <= CAP) return cur + s;
        over = true;
        return cur + s.slice(0, Math.max(0, CAP - cur.length));
      };
      child.stdout?.on("data", (d: Buffer) => (stdout = capAppend(stdout, d)));
      child.stderr?.on("data", (d: Buffer) => (stderr = capAppend(stderr, d)));
      // ── 부모 watchdog(P1) — supervisor 자신이 행이면 close 가 영영 안 온다. 마감+유예에 독립 백스톱으로 회수한다. ──
      let settled = false;
      let watchdog: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const clearTimers = (): void => {
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (killTimer !== undefined) clearTimeout(killTimer);
      };
      const done = (r: RunJobResult): void => {
        if (settled) return; // watchdog 와 close 가 겹쳐도 한 번만 처분(중복 onExit·resolve 방지).
        settled = true;
        clearTimers();
        if (pid !== undefined) opts.onExit?.(pid);
        resolve(r);
      };
      // 발화 시각 = 잡 마감 + 유예(supervisor 자기 kill_at 이후라 정상 종료엔 안 걸린다). 음수/과거면 즉시 유예로 클램프.
      if (pid !== undefined) {
        const watchdogDelay = Math.max(1000, input.deadlineMs - Date.now() + PARENT_WATCHDOG_GRACE_MS);
        watchdog = setTimeout(() => {
          // supervisor 무응답 — SIGTERM 먼저(종료 전파가 세션 그룹 회수), 유예 후에도 살아있으면 그룹 SIGKILL.
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* 이미 종료 — 무해 */
          }
          killTimer = setTimeout(() => {
            realSignalGroup(pid, "SIGKILL"); // pgid≤1 방어 내장. detached supervisor = 자기 그룹 리더.
            done({
              ok: false,
              reason: "reap_failed",
              detail: `supervisor 무응답(부모 watchdog · 마감+${PARENT_WATCHDOG_GRACE_MS}ms 초과) — 회수함`,
            });
          }, PARENT_WATCHDOG_KILL_GRACE_MS);
        }, watchdogDelay);
      }
      child.on("error", (err) => {
        done({ ok: false, reason: "spawn_failed", detail: `supervisor spawn 실패: ${err.message}` });
      });
      child.on("close", () => {
        // supervisor 는 결과 JSON 을 stdout **마지막 줄**로 내보낸다(MEDIUM#5 flush 규약). 마지막 비어있지 않은 줄만 판다.
        const line = stdout.trim().split("\n").filter((l) => l.trim() !== "").pop();
        if (line === undefined) {
          done({
            ok: false,
            reason: "config_error",
            detail: `supervisor 가 결과를 내보내지 않았습니다(stderr tail: ${stderr.trim().slice(-300) || "없음"})`,
          });
          return;
        }
        try {
          done(JSON.parse(line) as RunJobResult);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          done({ ok: false, reason: "config_error", detail: `supervisor 결과 JSON 파싱 실패: ${msg} — 원문: ${line.slice(0, 200)}` });
        }
      });
    });
}

// ══════════════════════════════════════════════════════════════════════════════════
// 프로세스 소유권 리퍼(evaluateReap 의 첫 소비자) — 고아 세션 그룹 nonce 검증-후-kill
// ══════════════════════════════════════════════════════════════════════════════════

/** supervisor 프로세스 관측 결과(evaluateReap SupervisorState.observed). */
export interface SupervisorObservation {
  alive: boolean;
  /** `ps -o lstart` → ms 환산(초 단위 커널 값이라 원장 ms 근사와 허용오차로 대조 · ownership 헤더). 못 읽으면 null. */
  startedAtMs: number | null;
}

/** 소유권 리퍼 주입 seam(전부 주입 — 실 ps/pgrep/신호는 default* 에만 · 테스트는 가짜). */
export interface ReapOwnershipDeps {
  /** 원장 파일이 사는 디렉터리(`jobs/ledgers/`). */
  ledgerDir: string;
  now: () => number;
  /** 원장 파일 경로 목록(기본 = ledgerDir 의 *.json). */
  listLedgers?: () => string[];
  /** 원장 파일 텍스트 읽기(기본 = readFileSync). */
  readLedger?: (path: string) => string;
  /** 원장 파일 삭제(고아 회수 완료 시 · 기본 = rmSync). */
  deleteLedger?: (path: string) => void;
  /** 프로세스 세계 관측(기본 = 실 ps/pgrep · defaultProcView). */
  procView: ProcView;
  /** supervisor pid 관측(기본 = kill(pid,0) + ps lstart). */
  observeSupervisor: (pid: number) => SupervisorObservation;
  /** 세션 그룹 신호(기본 = realSignalGroup — pgid≤1 방어 내장). */
  signalGroup?: (pgid: number, sig: "SIGTERM" | "SIGKILL") => void;
  /** 그룹 생존 확인(기본 = realGroupAlive). */
  groupAlive?: (pgid: number) => boolean;
  /** 진단 로그(기본 = stderr). */
  log?: (line: string) => void;
}

/** 소유권 원장 1건 회수 결과(진단·테스트). */
export interface ReapOwnershipResult {
  ledger: string;
  /** nonce 검증 통과로 실제 SIGKILL 한 pgid 들. */
  killed: number[];
  /** killAt-바운드 에스컬레이션(잠긴 결정 4 개정)으로 kill 한 pgid 들(killed 의 부분집합 아님 — 별도 집계). */
  escalated: number[];
  /** nonce 불일치(PID 재사용)로 신호를 **거부**한 pgid 들(맨몸 kill 하지 않는다 — 안전의 핵심). */
  refused: number[];
  /** 살아있는 owner supervisor 소유라 손대지 않은 세션이 하나라도 있었나(원장 유지). */
  waited: boolean;
  /** 원장 파일을 삭제했나(모든 세션이 회수·소멸 확인됨). */
  deleted: boolean;
  /** 파싱 실패(미지 버전·손상) — 거부하고 파일 유지. */
  parseError?: string;
  /** 프로세스 관측 실패(ProcInspectError · pgrep/ps 조작 실패) — 불확실이라 회수·삭제 보류, 파일 유지(P2). */
  inspectError?: string;
}

function defaultListLedgers(ledgerDir: string): string[] {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .sort()
    .map((n) => join(ledgerDir, n));
}

/**
 * 프로세스 관측 실패(조작 실패 · P2) — pgrep/ps 가 **없거나·타임아웃·비정상 종료**했다. **검증된 무매칭과 다르다**:
 *   무매칭은 '그룹 없음'(안전한 회수 근거)이지만, 관측 실패는 '알 수 없음'이다. 이 둘을 뭉개면(실패=빈 그룹) 리퍼가
 *   살아있는 세션의 원장을 조기 삭제한다. 그래서 관측 실패는 **던지고**, 리퍼가 그 원장을 **유지**한다(불확실→보류).
 */
export class ProcInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcInspectError";
  }
}

/** spawnSync 결과가 '조작 실패'인가(spawn 자체 실패 · 타임아웃 · null status). 무매칭(exit 1 등)은 실패가 아니다. */
function spawnFailed(r: ReturnType<typeof spawnSync>): boolean {
  return r.error !== undefined || r.signal !== null || r.status === null;
}

/**
 * 실 프로세스 세계 관측 ProcView(⚠ 라이브 전용 · unit/e2e 미검증 — W5 카나리). 이식성이 어려운 부분이다
 *   (STALL-LOG 2026-07-18: 포터블 PID 식별은 적대적으로 open-ended — 완전 폐쇄는 cgroup v2 뿐). Darwin/Linux
 *   최선을 다하되, verify→signal TOCTOU·PID 재사용은 좁혀질 뿐 완전히 닫히지 않는다(ownership.ts 헤더 '정직한 경계').
 *   - groupMembers: pgrep -g pgid 로 구성원 pid. exit 1(무매칭)=빈 배열 · **조작 실패=ProcInspectError throw**.
 *   - execEnvHas:   Darwin 은 ps -Eww 가 env 를 command 뒤에 노출 · Linux 는 proc/pid/environ. 읽기 실패=throw.
 *   - scanByEnv:    Darwin 은 ps -Eaxww 스캔 · Linux 는 proc 스캔 → 매칭 프로세스의 pgid. 조작 실패=throw.
 *   ⚠ **무매칭(빈 배열·false)과 조작 실패(throw)를 반드시 가른다**(P2 처방): 리퍼는 전자만 '회수 근거'로 쓰고,
 *     후자엔 원장을 유지한다(살아있는 세션을 조작 실패 한 번에 조기 삭제하지 않는다).
 */
export const defaultProcView: ProcView = {
  groupMembers(pgid: number): number[] {
    if (!Number.isInteger(pgid) || pgid <= 1) return [];
    const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 5000 });
    // pgrep: exit 0=매칭 · exit 1=무매칭(정상 · 빈 그룹) · 그 외/spawn 실패/타임아웃=조작 실패.
    if (r.status === 1 && !spawnFailed(r)) return [];
    if (r.status !== 0 || spawnFailed(r) || typeof r.stdout !== "string") {
      throw new ProcInspectError(`pgrep -g ${pgid} 실패(status=${r.status}, signal=${r.signal ?? "-"}, err=${r.error?.message ?? "-"})`);
    }
    return r.stdout
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  },
  execEnvHas(pid: number, name: string, value: string): boolean {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    const needle = `${name}=${value}`;
    // Linux: /proc/<pid>/environ 은 NUL 구분. 있으면 여기서 결정(더 정확). 읽기 실패=조작 실패(throw).
    const procEnviron = `/proc/${pid}/environ`;
    if (existsSync(procEnviron)) {
      try {
        return readFileSync(procEnviron, "utf8").split("\0").includes(needle);
      } catch (e) {
        throw new ProcInspectError(`${procEnviron} 읽기 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Darwin: ps -E 가 환경변수를 command 뒤에 노출. 공백 구분이라 정확 토큰(name=value)으로 본다.
    const r = spawnSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
    // ps -p <pid>: 프로세스가 없으면 exit 1 + 빈 stdout(정상 무매칭) · spawn 실패/타임아웃=조작 실패.
    if (spawnFailed(r)) throw new ProcInspectError(`ps -p ${pid} 실패(signal=${r.signal ?? "-"}, err=${r.error?.message ?? "-"})`);
    if (typeof r.stdout !== "string") return false;
    return r.stdout.split(/\s+/).includes(needle);
  },
  scanByEnv(name: string, value: string): number[] {
    const needle = `${name}=${value}`;
    const out = new Set<number>();
    // Linux: /proc/*/environ 스캔(가장 정확). 최상위 readdir 실패=조작 실패(throw) · per-pid 소멸/권한=건너뛴다.
    if (existsSync("/proc")) {
      let entries: string[];
      try {
        entries = readdirSync("/proc");
      } catch (e) {
        throw new ProcInspectError(`/proc 스캔 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const ent of entries) {
        const pid = Number(ent);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        try {
          if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(needle)) continue;
          const st = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ");
          const pgid = Number(st[4]); // stat 필드 5 = pgrp
          if (Number.isInteger(pgid) && pgid > 1) out.add(pgid);
        } catch {
          // 그 사이 프로세스 소멸·권한 — 그 pid 만 건너뛴다(전역 스캔은 계속). 최상위 실패와 달리 부분 누락은 무해.
        }
      }
      return [...out].sort((a, b) => a - b);
    }
    // Darwin: ps -E 로 pgid+env 를 함께 뽑아 env 에 needle 이 있는 행의 pgid 를 모은다. 조작 실패=throw.
    const r = spawnSync("ps", ["-Eaxww", "-o", "pgid=,command="], { encoding: "utf8", timeout: 8000 });
    if (r.status !== 0 || spawnFailed(r) || typeof r.stdout !== "string") {
      throw new ProcInspectError(`ps -Eaxww 스캔 실패(status=${r.status}, signal=${r.signal ?? "-"}, err=${r.error?.message ?? "-"})`);
    }
    for (const line of r.stdout.split("\n")) {
      const t = line.trim();
      if (t === "" || !t.split(/\s+/).includes(needle)) continue;
      const pgid = Number(t.split(/\s+/)[0]);
      if (Number.isInteger(pgid) && pgid > 1) out.add(pgid);
    }
    return [...out].sort((a, b) => a - b);
  },
};

/**
 * **실 supervisor 관측**(⚠ 라이브 전용) — alive=`kill(pid,0)`(ESRCH=false·EPERM=존재), startedAtMs=`ps -o lstart`.
 *   startedAtMs 는 초 단위 커널 값이라 원장 ms 근사와 **허용오차로 대조**된다(evaluateReap · ownership 헤더).
 */
export function defaultObserveSupervisor(pid: number): SupervisorObservation {
  if (!Number.isInteger(pid) || pid <= 1) return { alive: false, startedAtMs: null };
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM"; // 존재하나 권한 없음 = 생존.
  }
  let startedAtMs: number | null = null;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (r.status === 0 && typeof r.stdout === "string") {
    const ms = Date.parse(r.stdout.trim());
    if (Number.isFinite(ms)) startedAtMs = ms;
  }
  return { alive, startedAtMs };
}

/**
 * pgid 그룹을 **신호 직전 nonce 재검증** 후에만 SIGKILL 한다(decision ≠ signal · verify→signal 창 최소화 —
 *   ownership.ts daemon-MUST). 재검증 실패(nonce 불일치)면 **거부**한다: 커널이 이 pgid 를 무관한 그룹에 재배정
 *   했다는 뜻이라 맨몸 신호는 엉뚱한 프로세스를 죽인다(옛 raw-PID 하트비트가 못 막던 재앙 · 이 한 줄이 그걸 닫는다).
 * @returns "killed"(소멸 확인) · "still-alive"(신호했으나 생존 = leaked) · "refused"(nonce 불일치 · 신호 안 함) · "gone"(이미 없음).
 */
function nonceVerifiedKill(
  pgid: number,
  nonce: string,
  procView: ProcView,
  signalGroup: (pgid: number, sig: "SIGTERM" | "SIGKILL") => void,
  groupAlive: (pgid: number) => boolean,
): "killed" | "still-alive" | "refused" | "gone" {
  const members = procView.groupMembers(pgid);
  if (members.length === 0) return "gone"; // 이미 소멸(회수할 것 없음).
  // 신호 직전 재검증 — 구성원 중 하나라도 우리 nonce 를 지녔거나, scanByEnv 가 이 pgid 를 돌려주면 우리 그룹.
  const verified =
    members.some((pid) => procView.execEnvHas(pid, SESSION_NONCE_ENV, nonce)) ||
    procView.scanByEnv(SESSION_NONCE_ENV, nonce).includes(pgid);
  if (!verified) return "refused"; // PID 재사용 — 맨몸 pgid 절대 신호 금지.
  signalGroup(pgid, "SIGKILL");
  return groupAlive(pgid) ? "still-alive" : "killed";
}

/**
 * 소유권 원장을 훑어 **고아 세션 그룹**(supervisor 급사로 kill_at 주인을 잃은 세션)을 nonce 검증하 회수한다.
 *   evaluateReap(순수 판정)의 **첫 소비자**다 — 데몬은 그 결정을 신호 직전 nonce 재검증과 함께 집행한다.
 *
 * 언제 도는가: **데몬 기동 시**(지난 생의 고아) + **잡마다 그 세션 종료 후**(방금 supervisor 가 남긴 leaked/미소멸
 *   그룹). 정상 종료한 supervisor 는 owner dead 로 관측돼 그 원장이 통째로 정리·삭제된다.
 *
 * 처분(evaluateReap 결정별):
 *   · kill / scan-then-kill → **신호 직전 nonce 재검증** 후 SIGKILL(nonceVerifiedKill).
 *   · refuse → PID 재사용(우리 그룹은 이미 소멸) → 신호하지 않는다(맨몸 kill 금지). 회수 대상 아님(clean).
 *   · gc → 회수할 그룹 없음(소멸·미발생·reaped) → clean.
 *   · wait → 살아있는 owner supervisor 소유 → **원장을 남긴다**(그 supervisor 가 자기 세션을 관리 중). ★단
 *     killAt+여유를 넘긴 wait 는 **에스컬레이션**한다(아래).
 *
 * ★ **killAt-바운드 에스컬레이션(잠긴 결정 4 개정 · 사람 승인 대상 · 계획 3-1 절 S34-R2 폐쇄)**: evaluateReap 이
 *   `wait`(owner 살아있음/신원 확인 불가)를 돌려도, 세션이 자기 **killAt + REGISTER_LAG_MARGIN 을 넘겼는데도 살아있다면**,
 *   그건 owner 의 kill_at 기계가 실패했다는 뜻이므로 데몬이 백스톱으로 **nonce 검증하** 회수한다. 이는 "살아있는
 *   owner 세션을 뺏지 않는다"는 W3 의 안전 기본값을 **의도적으로 넘어서는** 정책이라, ①오직 마감을 넘긴 세션에만
 *   ②오직 nonce 검증-후-kill(맨몸 신호 절대 없음)로만 적용한다. 잠긴 결정 4 의 개정이므로 **사람 승인 대상**이고
 *   계획 문서에 개정 노트로 남긴다. 미지 원장 버전은 파싱 단계에서 **거부**한다(오회수 방지).
 *
 * ⚠ **원장에 쓰지 않는다(clobber 회피)**: 이 리퍼는 원장을 **읽기·회수·삭제**만 한다(settle 은 supervisor 몫).
 *   createLedger 로 열면 빈 sessions 로 덮어써 supervisor 기록을 지우므로, 모든 세션이 회수·소멸 확인되면 파일을
 *   통째로 삭제하고, 하나라도 살아있는 owner 소유(wait)거나 회수 실패(still-alive)면 파일을 남겨 다음 pass 가 잇는다.
 */
export function reapOwnershipLedgers(deps: ReapOwnershipDeps): ReapOwnershipResult[] {
  const now = deps.now();
  const listLedgers = deps.listLedgers ?? (() => defaultListLedgers(deps.ledgerDir));
  const readLedger = deps.readLedger ?? ((p) => readFileSync(p, "utf8"));
  const deleteLedger = deps.deleteLedger ?? ((p) => rmSync(p, { force: true }));
  const signalGroup = deps.signalGroup ?? realSignalGroup;
  const groupAlive = deps.groupAlive ?? realGroupAlive;
  const log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
  const procView = deps.procView;

  const results: ReapOwnershipResult[] = [];
  for (const path of listLedgers()) {
    const res: ReapOwnershipResult = { ledger: path, killed: [], escalated: [], refused: [], waited: false, deleted: false };
    let text: string;
    try {
      text = readLedger(path);
    } catch (e) {
      res.parseError = `읽기 실패: ${e instanceof Error ? e.message : String(e)}`;
      log(`[소유권리퍼] ${path} 읽기 실패 — 스킵(파일 유지): ${res.parseError}`);
      results.push(res);
      continue;
    }
    let ledger;
    try {
      ledger = parseLedger(text); // 미지 버전·손상 = LedgerParseError → 거부(오회수 방지).
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.parseError = e instanceof LedgerParseError ? `원장 거부(미지 버전/손상): ${msg}` : msg;
      log(`[소유권리퍼] ${path} ${res.parseError} — 파일 유지(회수 안 함)`);
      results.push(res);
      continue;
    }
    const obs = deps.observeSupervisor(ledger.supervisor.pid);
    const supervisorState = {
      ledger: { pid: ledger.supervisor.pid, startedAtMs: ledger.supervisor.startedAtMs },
      observed: obs,
      nowMs: now,
    };

    let allClean = true; // 모든 세션이 회수·소멸 확인됐나(파일 삭제 조건).
    // owner supervisor 가 살아있는가(wait·escalate 둘 다) — 살아있으면 **원장을 삭제하지 않는다**. 살아있는 owner 가
    //   settle 로 원장을 쓰는 것과 데몬의 삭제가 경합하면 원장이 되살아나거나 찢긴다(clobber 회피의 연장). owner 가
    //   실제로 죽은 뒤의 pass 가 정리한다. 에스컬레이션은 그 사이에도 **kill 은 한다**(고아 회수) — 삭제만 미룬다.
    let ownerActive = false;

    /** 한 pgid 를 nonce 검증하 회수하고 집계에 반영(에스컬레이션 여부 라벨). */
    const reapPgid = (pgid: number, nonce: string, viaEscalation: boolean): void => {
      const r = nonceVerifiedKill(pgid, nonce, procView, signalGroup, groupAlive);
      if (r === "killed") {
        res.killed.push(pgid);
        if (viaEscalation) res.escalated.push(pgid);
      } else if (r === "refused") {
        res.refused.push(pgid);
      } else if (r === "still-alive") {
        allClean = false; // 신호했으나 생존(leaked) — 파일 유지, 다음 pass 재시도.
        log(`[소유권리퍼] pgid=${pgid} SIGKILL 후에도 생존(leaked) — 원장 유지(다음 pass 재시도)`);
      }
      // "gone" = 이미 소멸(clean · 별도 집계 없음).
    };

    /** killAt+여유 초과 세션의 nonce 검증 회수(에스컬레이션 · 잠긴 결정 4 개정). pgid 있으면 그것, 없으면 nonce 스캔. */
    const escalate = (entry: SessionEntry): void => {
      const pgids = entry.pgid !== undefined ? [entry.pgid] : procView.scanByEnv(SESSION_NONCE_ENV, entry.nonce);
      if (pgids.length === 0) return; // 그룹을 못 찾음 = 이미 소멸(clean).
      log(
        `[소유권리퍼] killAt-바운드 에스컬레이션(잠긴 결정 4 개정 · 사람 승인 대상): 세션 nonce=${entry.nonce} 가 ` +
          `killAt+여유를 넘겨 생존 — nonce 검증하 회수 시도(pgids=${pgids.join(",")})`,
      );
      for (const pgid of pgids) reapPgid(pgid, entry.nonce, true);
    };

    // 프로세스 관측(procView)은 **조작 실패 시 던진다**(ProcInspectError) — 그걸 '그룹 없음'으로 오독해 살아있는
    //   세션의 원장을 조기 삭제하지 않도록, 세션 처리 전체를 감싸 **불확실이면 원장을 유지**한다(P2 · 안전 방향).
    try {
      for (const entry of ledger.sessions) {
        const decision = evaluateReap(entry, supervisorState, procView);
        if (decision.action === "wait") {
          // owner supervisor 가 살아있다(또는 신원 확인 불가) — 어느 쪽이든 원장은 삭제하지 않는다(ownerActive).
          ownerActive = true;
          // 단 killAt+여유를 넘긴 세션은 owner 의 kill 기계가 실패한 것이라 백스톱으로 **회수는 한다**(에스컬레이션 · kill 만).
          if (now >= entry.killAtMs + REGISTER_LAG_MARGIN_MS && entry.state !== "reaped") {
            escalate(entry);
          } else {
            res.waited = true; // 손대지 않고 owner 에게 양보(에스컬레이션은 손댔으므로 waited 아님).
          }
          continue;
        }
        if (decision.action === "kill") {
          reapPgid(decision.pgid, decision.nonce, false);
        } else if (decision.action === "scan-then-kill") {
          for (const pgid of decision.pgids) reapPgid(pgid, decision.nonce, false);
        } else if (decision.action === "refuse") {
          // PID 재사용(nonce 불일치) = 그 pgid 는 재배정된 무관 그룹이라 신호하지 않는다(우리 그룹은 이미 소멸 · clean).
          //   ReapDecision.refuse 는 pgid 를 싣지 않으므로 live/leaked 엔트리의 pgid 를 refused 집계에 남긴다(관측·회귀).
          if (entry.pgid !== undefined) res.refused.push(entry.pgid);
          log(`[소유권리퍼] ${path} 세션 nonce=${entry.nonce}: ${decision.reason}`);
        }
        // "gc" = 회수할 그룹 없음(clean).
      }
    } catch (e) {
      // 조작 실패(pgrep/ps 부재·타임아웃·비정상) — '알 수 없음'이라 회수·삭제를 보류하고 원장을 유지한다(다음 pass 재시도).
      res.inspectError = e instanceof Error ? e.message : String(e);
      log(`[소유권리퍼] ${path} 프로세스 관측 실패 — 원장 유지(불확실→보류): ${res.inspectError}`);
      results.push(res);
      continue;
    }

    // 원장 삭제 = 모든 세션이 clean(회수·소멸 확인) **그리고** owner 가 살아있지 않을 때만(살아있으면 그 owner 가
    //   자기 원장을 settle 로 관리하므로 데몬이 지우지 않는다 — 위 ownerActive 주석). 에스컬레이션은 kill 은 했어도
    //   owner 생존 중이라 삭제는 owner 사망 후 pass 로 미룬다. 관측 실패(inspectError)면 위 catch 에서 이미 continue.
    if (allClean && !ownerActive) {
      try {
        deleteLedger(path);
        res.deleted = true;
      } catch (e) {
        log(`[소유권리퍼] ${path} 삭제 실패(다음 pass 재시도): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (res.killed.length > 0 || res.refused.length > 0) {
      log(
        `[소유권리퍼] ${path} 회수: killed=[${res.killed.join(",")}] escalated=[${res.escalated.join(",")}] ` +
          `refused(PID재사용)=[${res.refused.join(",")}] deleted=${res.deleted}`,
      );
    }
    results.push(res);
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════════
// 데몬(ConsumerDaemon)
// ══════════════════════════════════════════════════════════════════════════════════

/** 잡 1건 소비 결과(관측 로그·테스트). */
export interface ConsumeOutcome {
  rid: string;
  stage: string;
  /** takePendingJob 처분(claimed=우리가 돌림 · lost/failed/dropped/skipped=takePendingJob 이 처분) 또는 enablement/cap 스킵. */
  action: TakeAction | "skipped_enablement" | "skipped_cap";
  /** action=claimed 일 때 잡 세션 성공 여부. */
  ok?: boolean;
  via?: "main" | "recovery";
  failReason?: RunJobFailReason;
  /** 적재→클레임 대기(ms · enqueued_at 부재면 null). */
  waitMs: number | null;
  /** 잡 세션 소요(ms · action=claimed 일 때만 의미). */
  durationMs: number;
  detail?: string;
}

export interface ConsumerDaemonDeps {
  /** 현재 시각 ms(주입 — 테스트 결정성). 기본 Date.now. */
  now?: () => number;
  /** 잡 세션 실행 seam(기본 = HARNESS_OFFLINE 이면 stub · 아니면 supervisor spawn). */
  runJob?: RunJobFn;
  /** next-action 조회(2중 검사 · 기본 readNextAction). */
  readNext?: (rid: string) => Promise<NextAction>;
  /** pending 잡 목록(기본 listPendingJobs). */
  listPending?: (pendingDir: string) => Promise<Array<{ path: string; job: GenerateJobFile }>>;
  /** 소유권 리퍼 주입(기본 = 실 ps/pgrep). listLedgers/procView/observeSupervisor 등을 테스트가 가짜로 넣는다. */
  reapOwnership?: (deps: ReapOwnershipDeps) => ReapOwnershipResult[];
  /** 소유권 리퍼가 쓸 procView(기본 defaultProcView). */
  procView?: ProcView;
  /** 소유권 리퍼가 쓸 supervisor 관측(기본 defaultObserveSupervisor). */
  observeSupervisor?: (pid: number) => SupervisorObservation;
  /** 무인 켠 단계 목록(기본 config.sdkStages). */
  stages?: string[];
  /** 잡 예산 ms(기본 sdkGenTimeout · 2중 검사 시간 축). */
  budgetMs?: number;
  /** 기동 여유 ms(기본 WORKER_STARTUP_MARGIN_MS). */
  startupMarginMs?: number;
  /** 잡 수 상한(기본 sdkDailyJobCap). */
  dailyJobCap?: number;
  /** 소비자 id(기본 sdkConsumerId · claimed/<id>/). */
  consumerId?: string;
  /** 폴링 간격 ms(기본 sdkPollIntervalMs). */
  pollIntervalMs?: number;
  /** core(하네스) 절대경로(기본 harnessRoot). */
  coreRoot?: string;
  /** 잡큐/원장 저장 경로(기본 storagePaths). */
  paths?: { jobsPending: string; jobsClaimed: string; jobsFailed: string; jobs: string };
  /** sleep(기본 setTimeout · 테스트 주입). */
  sleep?: (ms: number) => Promise<void>;
  /** 관측 로그(기본 stderr). */
  log?: (line: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 초 표기(관측 로그 · 소수 1자리). null 은 '-'. */
function secs(ms: number | null): string {
  return ms === null ? "-" : (ms / 1000).toFixed(1);
}

/**
 * 무인 생성 소비자 데몬. 동시성 1로 pending 잡을 소비하고, 기동 시 두 리퍼(큐·소유권)를 먼저 돌린다.
 *   전부 주입 seam 뒤라 단위 테스트가 실 CLI·실 신호 없이 수명주기를 결정론으로 못 박는다.
 */
export class ConsumerDaemon {
  private readonly now: () => number;
  private readonly runJob: RunJobFn;
  private readonly readNext: (rid: string) => Promise<NextAction>;
  private readonly listPending: (pendingDir: string) => Promise<Array<{ path: string; job: GenerateJobFile }>>;
  private readonly reapOwnershipFn: (deps: ReapOwnershipDeps) => ReapOwnershipResult[];
  private readonly procView: ProcView;
  private readonly observeSupervisor: (pid: number) => SupervisorObservation;
  private readonly stages: string[];
  private readonly budgetMs: number;
  private readonly startupMarginMs: number;
  private readonly dailyJobCap: number;
  private readonly consumerId: string;
  private readonly pollIntervalMs: number;
  private readonly coreRoot: string;
  private readonly dirs: JobDirs;
  private readonly jobsRoot: string;
  private readonly ledgerDir: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  /** trailing 24h 잡 수 상한을 위한 소비 시각 링(주입 시계로 결정적). */
  private readonly consumedAt: number[] = [];
  private stopped = false;
  /** 지금 처리 중인 잡의 처분 promise(우아한 종료가 await 해 claimed 고아를 남기지 않게 한다 · P1). */
  private inFlight: Promise<ConsumeOutcome> | null = null;
  /**
   * enablement 미등재 스킵 로그 dedup 키집합(`${run_id}#${stage}`) — 미등재 잡은 클레임 없이 대기줄에 남아 **매 폴마다
   *   다시 보이므로**(consumeOne 이 pending 을 통째로 훑는다) 로그를 안 막으면 데몬 로그가 도배된다(실측 live-daemon.log
   *   6~138행). 같은 잡(rid+stage)당 첫 관측에만 로그하고 이후엔 조용히 스킵한다 — **스킵 동작 자체는 불변**(로그만 억제).
   *   상한 없음: 키 수는 대기 중 미등재 잡 수(수십 건 규모)에 비례할 뿐 무한 증가하지 않는다(잡이 소비/등재되면 다시 안 온다).
   *   데몬 수명 동안 유지 — 재기동 시 1회 재로그는 **의도**다(새 프로세스의 관측 기준선을 한 번 남긴다).
   */
  private readonly enablementSkipLogged = new Set<string>();

  constructor(deps: ConsumerDaemonDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.readNext = deps.readNext ?? readNextAction;
    this.listPending = deps.listPending ?? listPendingJobs;
    this.reapOwnershipFn = deps.reapOwnership ?? reapOwnershipLedgers;
    this.procView = deps.procView ?? defaultProcView;
    this.observeSupervisor = deps.observeSupervisor ?? defaultObserveSupervisor;
    this.stages = deps.stages ?? sdkStages();
    this.budgetMs = deps.budgetMs ?? sdkGenTimeout();
    this.startupMarginMs = deps.startupMarginMs ?? WORKER_STARTUP_MARGIN_MS;
    this.dailyJobCap = deps.dailyJobCap ?? sdkDailyJobCap();
    this.consumerId = deps.consumerId ?? sdkConsumerId();
    // 폴링 간격은 setTimeout 상한(2^31-1ms ≈ 24.8일)으로 클램프한다(P2): config 는 30일까지 허용하는데 그 사이
    //   값을 setTimeout 에 그대로 주면 즉시발화로 뭉개져 데몬이 핫루프에 빠진다(24.8~30일 오설정 방어).
    this.pollIntervalMs = Math.min(deps.pollIntervalMs ?? sdkPollIntervalMs(), 2_147_483_647);
    this.coreRoot = deps.coreRoot ?? harnessRoot();
    const paths = deps.paths ?? storagePaths();
    this.dirs = jobDirsOf(paths);
    this.jobsRoot = paths.jobs;
    this.ledgerDir = join(paths.jobs, "ledgers");
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
    // runJob: 오프라인이면 stub 직접(결정적) · 온라인이면 supervisor spawn(라이브 전용). 주입이 있으면 그것.
    this.runJob =
      deps.runJob ??
      (isOffline()
        ? makeStubRunJob()
        : makeSupervisorSpawnRunJob({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }));
  }

  /** trailing 24h 창의 소비 잡 수가 상한에 이르렀나(과금 폭주의 성긴 백스톱 · 사용량 게이지의 폴백). */
  private capReached(nowMs: number): boolean {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    while (this.consumedAt.length > 0 && this.consumedAt[0] < cutoff) this.consumedAt.shift();
    return this.consumedAt.length >= this.dailyJobCap;
  }

  /** 소유권 리퍼(기동·잡 종료 후) — 고아 세션 그룹 nonce 검증 회수. */
  reapOwnership(): ReapOwnershipResult[] {
    return this.reapOwnershipFn({
      ledgerDir: this.ledgerDir,
      now: this.now,
      procView: this.procView,
      observeSupervisor: this.observeSupervisor,
      log: this.log,
    });
  }

  /** 큐 리퍼(기동) — 마감 지난 stale 클레임 정리(마감 리스 · 재큐 없음). */
  async reapClaimed(): Promise<ReapResult[]> {
    return reapClaimedJobs({ dirs: this.dirs, now: this.now, readNext: this.readNext });
  }

  /**
   * pending 잡 1건을 집어 소비한다(동시성 1 — 완주해야 반환). 집을 게 없으면 null.
   *   enablement 미등재·잡 수 상한 초과·takePendingJob 비-claimed 는 그대로 넘어가 다음 후보를 본다.
   */
  async consumeOne(): Promise<ConsumeOutcome | null> {
    const pending = await this.listPending(this.dirs.pending);
    for (const { job } of pending) {
      // enablement: 미등재 단계 잡은 **집지 않는다**(사람 소비자 몫). 클레임 전 필터(대기줄에 남긴다).
      //   미등재 잡은 소비되지 않고 pending 에 남아 매 폴마다 재관측되므로, 로그는 같은 잡(rid#stage)당 **1회만**
      //   남긴다(도배 방지 · 스킵 동작 자체는 불변). skipped_cap 은 회차 종료 신호라 여기 dedup 대상 아님(불변).
      if (!this.stages.includes(job.stage)) {
        const skipKey = `${job.run_id}#${job.stage}`;
        if (!this.enablementSkipLogged.has(skipKey)) {
          this.enablementSkipLogged.add(skipKey);
          this.log(`[무인소비] rid=${job.run_id} stage=${job.stage} 스킵(enablement 미등재)`);
        }
        continue;
      }
      // 잡 수 상한: 초과면 더 집지 않는다(대기줄에 남긴다 · 성긴 과금 백스톱).
      if (this.capReached(this.now())) {
        this.log(`[무인소비] rid=${job.run_id} stage=${job.stage} 스킵(잡 수 상한 ${this.dailyJobCap} 도달)`);
        return { rid: job.run_id, stage: job.stage, action: "skipped_cap", waitMs: null, durationMs: 0 };
      }
      const claimedAt = this.now();
      const take = await takePendingJob(job, {
        dirs: this.dirs,
        consumerId: this.consumerId,
        now: this.now,
        budgetMs: this.budgetMs,
        startupMarginMs: this.startupMarginMs,
        readNext: this.readNext,
      });
      if (take.action !== "claimed" || take.path === undefined) {
        // lost/failed/dropped/skipped — takePendingJob 이 이미 처분(failed//삭제/복귀)했다. 로그만 남기고 다음 후보.
        this.log(`[무인소비] rid=${job.run_id} stage=${job.stage} ${take.action}(${take.reason})`);
        continue;
      }
      // in-flight 추적 — 우아한 종료가 이 처분을 await 해 claimed 고아를 남기지 않는다(P1 · drainInFlight).
      const p = this.runClaimed(job, take.path, claimedAt);
      this.inFlight = p;
      try {
        return await p;
      } finally {
        if (this.inFlight === p) this.inFlight = null;
      }
    }
    return null;
  }

  /**
   * 진행 중인 잡의 처분이 끝나길 **유예 안에서** 기다린다(우아한 종료용 · P1). 없으면 즉시 true. 유예 초과면 false
   *   (진행 중이나 못 기다림 — 호출부가 백스톱[부모 watchdog·다음 데몬 리퍼]에 맡긴다). 실 타이머라 라이브 경로용.
   * @returns 처분 완료(또는 애초에 없음)=true · 유예 초과=false.
   */
  async drainInFlight(graceMs: number): Promise<boolean> {
    const p = this.inFlight;
    if (p === null) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), Math.max(0, graceMs));
    });
    try {
      const res = await Promise.race([p.then(() => "done" as const, () => "done" as const), timeout]);
      return res === "done";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 클레임한 잡을 돌리고 처분(성공 삭제 · 실패 failed/)한다. 관측 로그 1줄. */
  private async runClaimed(job: GenerateJobFile, claimedPath: string, claimedAt: number): Promise<ConsumeOutcome> {
    const deadlineMs = parseDeadline(job);
    const enqAt = typeof job.enqueued_at === "string" ? Date.parse(job.enqueued_at) : NaN;
    const waitMs = Number.isFinite(enqAt) ? claimedAt - enqAt : null;
    // 클레임을 통과했다는 건 takePendingJob 이 마감(≠null)을 확인했다는 뜻 — 방어적으로 한 번 더 본다(계약 보존).
    if (deadlineMs === null) {
      await failJob(this.dirs, claimedPath, "클레임 후 마감 파싱 실패(프로토콜 위반)");
      const outcome: ConsumeOutcome = { rid: job.run_id, stage: job.stage, action: "failed", ok: false, waitMs, durationMs: 0, detail: "no_deadline" };
      this.logOutcome(outcome);
      return outcome;
    }
    // **잡별 유니크 경로(P1 — 원장 clobber 방지)**: 미해결 원장(회수 실패·파싱 거부·삭제 실패)이 남았을 때, 같은
    //   run·stage 재시도가 **같은 파일을 재사용**하면 supervisor 의 createLedger 가 빈 sessions 로 원자 대체해 옛
    //   nonce/pgid 기록을 파괴한다 → 그 고아가 회수 불능이 된다. job_id(적재 1건의 재사용불가 도장)를 붙여 매 시도가
    //   자기 원장을 갖게 한다(리퍼는 디렉터리 전체를 스캔하므로 이름이 유니크해도 전부 찾는다). v2 잡은 job_id 를
    //   반드시 가지며(v1 은 애초에 클레임되지 않는다), 만일을 위해 claimedAt 로 폴백한다.
    const attemptTag = typeof job.job_id === "string" && job.job_id !== "" ? job.job_id : String(claimedAt);
    const jobKey = `${job.run_id}-${job.stage}-${attemptTag}`;
    const configDir = join(this.jobsRoot, "cfg", jobKey);
    const ledgerPath = join(this.ledgerDir, `${jobKey}.json`);
    try {
      mkdirSync(this.ledgerDir, { recursive: true });
    } catch {
      // 원장 디렉터리 생성 실패는 online seam 이 다시 잡는다(offline stub 은 원장을 안 쓴다).
    }
    const t0 = this.now();
    let result: RunJobResult;
    try {
      result = await this.runJob({
        coreRoot: this.coreRoot,
        rid: job.run_id,
        stage: job.stage,
        claimedAtMs: claimedAt,
        deadlineMs,
        configDir,
        ledgerPath,
      });
    } catch (e) {
      // runJob 은 계약상 던지지 않지만(RunJobResult), 주입 seam 이 던지면 실패로 환원한다(늘 처분한다).
      result = { ok: false, reason: "config_error", detail: `잡 세션 seam 예외: ${e instanceof Error ? e.message : String(e)}` };
    }
    const durationMs = this.now() - t0;
    // 잡 수 상한 집계 — **성공·실패 무관**하게 센다. 클레임돼 runJob(세션)까지 간 잡은 성공이든 실패든 **구독 과금이
    //   발생**하므로(claude 세션이 실제로 돌았다), 과금 백스톱은 결과가 아니라 '세션이 몇 번 돌았나'를 세야 한다.
    //   (takePendingJob 이 만료/전이로 처분한 잡은 여기 오지 않는다 = 세션 미실행 = 미과금 = 미집계.)
    this.consumedAt.push(this.now());
    // 온라인이 남긴 leaked/미소멸 세션 그룹을 잡 종료 후 즉시 회수(백스톱). 오프라인 stub 은 원장이 없어 no-op.
    try {
      this.reapOwnership();
    } catch (e) {
      this.log(`[무인소비] 소유권 리퍼(잡 종료 후) 오류(무시): ${e instanceof Error ? e.message : String(e)}`);
    }
    // 잡별 configDir(spec·격리 settings·세션 잔재) 정리 — supervisor 가 끝난 뒤(runJob 반환 후) 데몬이 소유대로
    //   치운다(P2 · 성공·실패 공통). 안 치우면 오래 도는 데몬에 cfg 디렉터리가 무한 누적된다. 오프라인 stub 은
    //   configDir 를 안 만들어 no-op(force:true). 원장은 별개(리퍼가 관리)라 여기서 건드리지 않는다.
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch (e) {
      this.log(`[무인소비] configDir 정리 실패(무시): ${e instanceof Error ? e.message : String(e)}`);
    }
    let outcome: ConsumeOutcome;
    if (result.ok) {
      await completeJob(claimedPath); // 성공 → 잡 삭제(전이는 봇이 next-action 폴링으로 감지).
      outcome = { rid: job.run_id, stage: job.stage, action: "claimed", ok: true, via: result.via, waitMs, durationMs, detail: result.detail };
    } else {
      await failJob(this.dirs, claimedPath, `${result.reason}: ${result.detail}`);
      outcome = { rid: job.run_id, stage: job.stage, action: "claimed", ok: false, failReason: result.reason, waitMs, durationMs, detail: result.detail };
    }
    this.logOutcome(outcome);
    return outcome;
  }

  /** 잡당 1줄 관측 로그(rid·stage·대기·소요·턴·비용·결과). 턴·비용은 세션 봉투 필드라 RunJobResult(W3 계약)에 없다 → '-'(라이브 로그만 보유). */
  private logOutcome(o: ConsumeOutcome): void {
    const result = o.ok === undefined ? o.action : o.ok ? `성공(${o.via ?? "main"})` : `실패(${o.failReason ?? "?"})`;
    this.log(
      `[무인소비] rid=${o.rid} stage=${o.stage} 대기=${secs(o.waitMs)}s 소요=${secs(o.durationMs)}s 턴=- 비용=- 결과=${result}`,
    );
  }

  /** 지금 집을 수 있는 잡을 **하나씩 순차** 모두 소비한다(동시성 1 유지). 반환 = 이번 회차 소비 결과들. */
  async consumeAvailable(): Promise<ConsumeOutcome[]> {
    const out: ConsumeOutcome[] = [];
    for (;;) {
      if (this.stopped) break;
      const o = await this.consumeOne();
      if (o === null) break; // 집을 게 없음.
      out.push(o);
      if (o.action === "skipped_cap") break; // 상한 도달 — 이번 회차 종료.
    }
    return out;
  }

  /** 데몬 루프 정지 요청(우아한 종료 · start 루프가 다음 경계에서 빠져나간다). */
  stop(): void {
    this.stopped = true;
  }

  /**
   * 리퍼 2종 한 pass(소유권 → 큐) — **기동뿐 아니라 매 폴링 주기에도 돈다**(P2). 기동-only 면, 데몬이 오래
   *   떠 있는 동안 만료된 stale 클레임이 다음 재시작까지 청소되지 않는다(리스 지난 고아 방치). 소유권(프로세스) 먼저,
   *   큐(파일) 뒤. 어느 것이 던져도 삼켜 루프를 깨지 않는다(리퍼 실패로 소비가 멈추면 안 된다).
   */
  private async runReapers(label: string): Promise<void> {
    try {
      this.reapOwnership();
    } catch (e) {
      this.log(`[무인소비] ${label} 소유권 리퍼 오류(무시): ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const reaped = await this.reapClaimed();
      const acted = reaped.filter((r) => r.action !== "leased" && r.action !== "skipped");
      if (acted.length > 0) this.log(`[무인소비] ${label} 큐 리퍼: ${acted.length}건 정리(${acted.map((r) => r.action).join(",")})`);
    } catch (e) {
      this.log(`[무인소비] ${label} 큐 리퍼 오류(무시): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 데몬 루프 — 기동 리퍼 → { 리퍼 → 소비 → sleep } 반복. stop() 이 불릴 때까지.
   *   enablement 가 비어 있으면(어느 단계도 무인 아님) 경고 1줄만 남기고 그대로 유휴 폴링한다(잡을 안 집는다).
   */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.stages.length === 0) {
      this.log("[무인소비] CHAT_SDK_STAGES 가 비어 있습니다 — 어느 단계도 무인이 아닙니다(기본 off · fail-closed). 유휴 폴링만 합니다.");
    } else {
      this.log(`[무인소비] 무인 단계: ${this.stages.join(", ")} · 소비자=${this.consumerId} · 폴링=${secs(this.pollIntervalMs)}s`);
    }
    await this.runReapers("기동"); // 기동 시 지난 생의 고아·stale 클레임 정리.
    while (!this.stopped) {
      await this.consumeAvailable();
      if (this.stopped) break;
      // 매 주기 리퍼 — 데몬이 오래 떠 있어도 만료된 클레임·leaked 그룹을 다음 재시작 기다리지 않고 청소한다(P2).
      await this.runReapers("주기");
      if (this.stopped) break;
      await this.sleep(this.pollIntervalMs);
    }
    this.log("[무인소비] 루프 종료.");
  }
}
