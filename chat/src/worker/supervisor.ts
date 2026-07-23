/**
 * supervisor.ts — 무인 세션 1건이 **마감을 넘겨 살아남지 못하도록** 강제하는 프로세스그룹 감독(잠긴 결정 4).
 *
 * 토폴로지(계획 잠긴 결정 4 · 부록A-7 4번): 데몬(W4)이 이 파일을 **detached 로** 띄운다 → supervisor 는 자기
 *   프로세스그룹의 리더가 된다(Node 엔 '기존 PGID 에 합류'하는 API 가 없어 스스로 리더가 되는 길뿐이다). 그리고
 *   이 supervisor 가 **주 세션과 복구 세션을 직접 spawn** 한다. 각 세션은 다시 **detached**(자기 하위 그룹의 리더)로
 *   띄운다 — 그래야 supervisor 가 `kill(-세션PGID)` 로 세션 + 그 Bash 손자들을 통째로 회수하면서도 **자기 자신은
 *   살아남아** kill_at 시점의 소멸을 확인·보고할 수 있다(같은 그룹이면 자기까지 죽여 확인 주체가 사라진다).
 *
 *   ⚠ **정직한 정정 + W3↔W4 회수 계약(잠긴 결정 4 의 kill 메커니즘 변경 — 사람 승인 대상)**: 계획 산문은 "세션이
 *     supervisor 의 그룹을 **상속**한다(→ `kill(-supervisorPGID)` 한 방에 트리 전체 회수)"고 적었지만 **틀렸다**.
 *     회수 검증 문구가 `kill(-pgid, 0) → ESRCH` 인 이상 검증 주체(supervisor)는 세션 그룹 **밖**에 있어야 하고
 *     (그룹 안이면 자기 때문에 영영 ESRCH 가 안 난다), 곧 **세션은 각자 detached 하위 그룹**이다(그래야 Bash 손자까지
 *     닿는 그룹 kill·회수 검증이 성립한다). 그 귀결: 음수-PID 신호인 `kill(-supervisorPID)` 는 supervisor 의 PGID
 *     **하나만** 겨냥하므로 **세션 그룹(과 그 Bash 손자)엔 닿지 않는다** — 데몬이 supervisor 만 죽이면 세션은 마감
 *     타이머 주인을 잃고 **살아남는다**(진짜 마감 구멍). "`kill(-supervisorPID)` 가 트리 전체를 회수한다"는 서술은
 *     거짓이므로 쓰지 않는다. 구멍은 두 층으로 닫는다:
 *       ① **종료 전파**: supervisor 가 SIGTERM/SIGINT/정상 exit 를 받으면, 살아있는 세션 하위 그룹을 빠져나가기
 *          **전에** 전부 `kill(-sessionPgid, SIGKILL)` 한다(installSupervisorTerminationHandlers). 데몬이 supervisor 를
 *          **우아하게(SIGTERM)** 끝낼 때 이게 돈다. 이 경로가 보는 살아있는 세션 집합은 **in-memory 레지스트리**
 *          (SessionGroupRegistry)다 — supervisor 가 살아 handler 를 돌릴 수 있을 때(SIGTERM=트랩 가능)만 유효하다.
 *       ② **소유권 원장(ownership.ts)**: supervisor 가 SIGKILL(트랩 불가)로 급사하면 ①의 in-memory 집합은 프로세스와
 *          함께 사라진다 — 그 백스톱은 **디스크에 내구 기록된 원장**이다. supervisor 는 자식 spawn **직전에**
 *          재사용 불가능한 nonce 를 원장에 `intent` 로 박고(register-lag 닫힘), pgid 확정 시 `register` 로 승격하며,
 *          회수 확인 시 `settle` 로 처분한다. W4 데몬은 그 원장을 읽어 nonce 검증하 세션 그룹을 **직접** 회수한다.
 *
 *     **W3↔W4 계약(정본은 ownership.ts 헤더 — 여기서 재유도하지 않는다)**: 신호 전 nonce 검증·의도-먼저·start-time
 *       신원검증의 전체 스펙은 `ownership.ts` 의 모듈 헤더와 `evaluateReap` 이 SSoT 다(옛 `{supervisorPid,
 *       sessionPgids[]}` 하트비트가 못 막던 register-lag TOCTOU·PID 재사용을 nonce 로 닫는다 — **정직한 경계**:
 *       Darwin 잔여 TOCTOU 는 좁혀질 뿐 완전히 닫히지 않고, 완전 원자성은 Linux cgroup v2 에서만 성립한다).
 *       이 supervisor 가 그 계약의 **기록측**이다: 원장에 무엇을 언제 쓰는가(intent/register/settle)를 이 파일이
 *       구현하고, 신호 전 검증(소비측)은 데몬이 evaluateReap 으로 한다. detached 세션은 유지된다 — 데몬은 잡을
 *       회수할 때 **(a) supervisor 에 SIGTERM 을 먼저 보내 종료 전파(①)가 돌게 하거나, (b) 원장의 세션 pgid 를
 *       nonce 검증하 직접 `kill(-sessionPgid)`** 해야 한다. **맨몸 `kill(-supervisorPID, SIGKILL)` 하나로는 부족하다**
 *       (SIGKILL 은 트랩 불가라 ①이 안 돌고, 세션 그룹은 그 신호가 닿지 않는 별개 PGID 다).
 *     ⚠ 남는 W5 카나리: 전파 SIGKILL 이 실제 detached 하위 그룹을 소멸시키는지·Bash 손자까지 닿는지, nonce 가 실제로
 *       exec-env 에 실려 데몬이 되읽는지, supervisor 기동시각이 데몬의 `ps` 읽기와 일치하는지는 실세션에서만 확증된다
 *       (단위 테스트는 '무엇을 겨냥해 무엇을 원장에 썼는가'를 고정할 뿐 '그 신호가 무엇을 죽였는가'는 아니다).
 *
 * 마감 강제 = **3단 에스컬레이션**(전부 kill_at **이전**에 끝난다 — 마감을 넘겨 신호를 보내지 않는다):
 *   ① `kill_at - TERM_MARGIN` 에 SIGTERM(우아한 종료 · 산출물 flush·전이 마무리 여유)
 *   ② `kill_at - KILL_MARGIN` 에 SIGKILL(강제 종료)
 *   ③ `kill_at` 에 **소멸 확인**(`kill(-pgid, 0)` → ESRCH). 살아 있으면 `reap_failed` — 요구는 '결국 종료'가 아니라
 *      **kill_at 시점 소멸 확인**이다(계획 7절 "결국 종료가 아님"). 결국 죽더라도 kill_at 에 살아 있으면 실패다.
 *   이 kill_at 스케줄 강제가 **1급 마감 집행자**다(원장은 supervisor 급사 시의 **2급 백스톱**일 뿐 — 격리·검증은 원장).
 *
 * ⚠ **밀린/앞당겨진 타이머 내성**: 알람은 상대 지연이 아니라 **절대 시계**로 판정하고 **자기 재무장**한다.
 *   · 늦게 깨어남(랩톱 슬립·SIGSTOP): `enforce()` 가 `now()` 로 due 페이즈를 다시 계산해 **밀린 단계를 즉시
 *     따라잡는다**(TERM 알람이 이미 kill_at 이후에 깨어나면 그 자리에서 KILL+회수확인까지 수행).
 *   · 일찍 깨어남(역행 시계·`setTimeout` 최대지연 클램프): 알람이 목표 **전에** 깨어나면 스펜트로 버리지 않고
 *     `armNext()` 가 남은 절대 지연으로 **다시 건다**(Finding 3). 남은 지연이 setTimeout 상한을 넘으면 바운드
 *     홉(ALARM_MAX_HOP_MS)으로 나눠 재무장한다 → 어떤 절대 시각도 클램프 즉시발화로 새지 않는다.
 *   상대 지연에만 기대면 슬립엔 마감이 새고, 스펜트 원샷에만 기대면 조기발화에 회수기가 통째로 소실된다.
 *
 * ⚠ **리더 종료 ≠ 그룹 사멸**(Finding 2): 세션 리더의 파이프가 닫혀 `exited` 가 떠도, `nohup … &` 류 손자가 그룹에
 *   남아있을 수 있다. 리더 종료를 그룹 사멸로 낙관해 알람을 다 취소하면 그 손자가 kill_at 을 넘겨 살아남는다. 그래서
 *   자가 종료는 **그룹 소멸을 확인해야** 성공(exited/killed)으로 settle 하고, 그룹이 살아있으면 settle 하지 않고
 *   회수 경로(TERM/KILL/kill_at reap)에 넘긴다 — kill_at 알람은 armNext 로 늘 유지되므로 행은 없다.
 *
 * 테스트 결정성: 시계·스폰·신호·생존확인·**원장**은 전부 **주입 seam**이다(SuperviseDeps). 단위 테스트는 가짜 시계
 *   (setAlarm 을 기록만 하고 테스트가 수동으로 발화)·가짜 세션(exited 를 테스트가 직접 resolve)·가짜 원장(createLedger
 *   + in-memory io)으로 **실타이머·실슬립·실 spawn·실 신호 없이** 스케줄과 소유권 기록을 못 박는다 — 회귀는 ms 안에
 *   실패해야지 매달리면 안 된다(선행 라운드 교훈). 회수 알람이 kill_at 에 항상 settle 하므로, 세션이 영영 안 끝나는
 *   가짜에서도 promise 는 kill_at 에 반드시 풀린다(행 없음).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionPlan } from "./cli-session.js";
// ⚠ **type-only import** — 컴파일 시 소거되므로 런타임 순환(supervisor ↔ runner)을 만들지 않는다. 실 runJobSession
//   은 main() 안에서 여전히 **동적 import** 한다(런타임 init 순서 무관). 이 타입은 main() 이 어떤 throw 에서도
//   구조적 RunJobResult 를 stdout 으로 내보내기 위한 형태 계약일 뿐이다(MEDIUM#2 · 결과 없는 종료 금지).
import type { RunJobResult } from "./cli-session-runner.js";
// 소유권 원장(2급 백스톱) — 옛 raw-PID 하트비트를 대체한다. 계약·순수판정(evaluateReap)의 정본은 ownership.ts 다.
//   여기서는 **기록측**만 쓴다: createLedger(내구 기록기)·SESSION_NONCE_ENV(exec-env 주입 이름)·형태 타입.
import {
  SESSION_NONCE_ENV,
  createLedger,
  type LedgerHandle,
  type LedgerIo,
  type SessionRole,
  type SupervisorMeta,
} from "./ownership.js";

/**
 * SIGTERM 유예 = 30초. kill_at 으로부터 이만큼 앞에서 우아한 종료를 시작한다.
 *   왜 30초인가: SIGTERM 을 받은 세션(claude CLI + 그 Bash 손자들 + 진행 중이던 run-stage 전이)이 산출물을 flush 하고
 *   깨끗이 빠져나올 시간이다. 실측(부록A-9)상 전이는 몇 턴 규모라 30초면 넉넉하고, 잡 기본 예산(480초)에 견줘선
 *   충분히 작다. 더 짧으면 세션이 파일을 쓰는 중에 SIGKILL 이 떨어져 산출물이 깨지고(반쯤 쓰인 파일), 더 길면
 *   아래 회수 확인 여유(KILL_MARGIN)를 갉아먹는다.
 */
export const TERM_MARGIN_MS = 30_000;

/**
 * SIGKILL 유예 = 10초. kill_at 으로부터 이만큼 앞에서 강제 종료한다 → kill_at 까지 남는 10초가 **회수 정착 창**이다.
 *   왜 10초인가: SIGKILL 도 프로세스 **트리**엔 즉발이 아니다(좀비 수확·FS flush·커널의 그룹 해체). 10초를 두면
 *   커널이 실제로 그룹을 헐어낸 **뒤에** `kill(-pgid,0)` 회수 확인을 하게 되어, kill_at 에 그룹이 살아 있으면 그건
 *   '아직 죽는 중'인 레이스가 아니라 **진짜 회수 실패**다(reap_failed 를 신뢰할 수 있게 만든다).
 *   TERM_MARGIN > KILL_MARGIN 이라 순서는 termAt < killSigAt < killAt 로 늘 마감 이전에 완결된다.
 */
export const KILL_MARGIN_MS = 10_000;

/**
 * 알람 1홉 최대 지연 = 2^31-1 ms(≈24.8일) — `setTimeout` 이 클램프 없이 받는 상한(초과하면 즉시 발화로 뭉개진다).
 *   armNext 는 다음 임계까지 남은 절대 지연이 이보다 크면 **이만큼만** 걸고, 그 알람이 깨면 다시 이어 건다(바운드 홉).
 *   그래서 어떤 절대 시각도 클램프 조기발화로 새지 않는다(Finding 3). 잡 예산은 이보다 훨씬 짧아 실무에선 1홉이면
 *   끝나지만, 잘못된 큰 예산·역행 시계·랩톱 슬립 같은 이상값에서 회수가 무한정 미뤄지지 않게 하는 안전 상한이다.
 */
export const ALARM_MAX_HOP_MS = 2_147_483_647;

/**
 * 세션 스폰 옵션 — **cli-parser.ts 의 검증된 헤드리스 spawn 패턴을 그대로 잇는다**(재발명 금지):
 *   · `detached:true`  — 세션을 자기 프로세스그룹 리더로(위 토폴로지). `kill(-child.pid)` 로 세션+손자 일괄 회수.
 *   · stdin `ignore`   — 입력 대기 행 차단(`</dev/null` 등가). 무인이라 답할 주체가 없다.
 *   · 출력 상한 32MiB   — 폭주 출력 OOM 방지(초과 시 그룹 kill + 실패).
 */
export const SUPERVISOR_SPAWN_STDIO = ["ignore", "pipe", "pipe"] as const;
export const SUPERVISOR_SPAWN_DETACHED = true;
export const SUPERVISOR_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** kill_at 스케줄 산출 입력. 전부 절대 ms(주입 — 테스트 결정성). */
export interface KillScheduleInput {
  /** 세션 기동(클레임) 시각 ms — 잡 wall-clock 예산이 흐르기 시작하는 기준. */
  claimedAtMs: number;
  /** 잡 wall-clock 예산 ms(config.sdkGenTimeout — 주/복구 세션 합산 상한). */
  genTimeoutMs: number;
  /** 잡 절대 마감 ms(잡 파일 `expires_at` → ms · 봇이 적재 순간 박은 값). */
  deadlineMs: number;
}

/** kill_at 스케줄(전부 절대 ms). termAt < killSigAt < killAt 이 늘 성립한다. */
export interface KillSchedule {
  /** 강제 종료 완결 목표 시각 = min(claimedAt + genTimeout, deadline). 예산과 마감 중 **먼저 오는 쪽**. */
  killAtMs: number;
  /** SIGTERM 시각 = killAt - TERM_MARGIN. */
  termAtMs: number;
  /** SIGKILL 시각 = killAt - KILL_MARGIN. */
  killSigAtMs: number;
}

function assertFiniteMs(label: string, v: number): void {
  if (!Number.isFinite(v)) {
    throw new Error(`supervisor: ${label} 가 유한한 ms 값이 아닙니다: ${v}`);
  }
}

/**
 * kill_at 스케줄 계산(순수).
 *
 * **핵심: kill_at = min(예산 마감, 잡 마감)**. 세션의 wall-clock 예산(기동 + genTimeout)과 잡의 절대 마감
 *   (expires_at) 중 **먼저 오는 쪽**이 상한이다 — 예산이 남아도 잡이 만료면 거기서 끊고(늦은 성공 창 제거),
 *   잡 마감이 멀어도 예산이 다하면 거기서 끊는다(폭주 세션 상한). TERM/KILL 은 그 kill_at **이전**에만 발화한다.
 */
export function computeKillSchedule(input: KillScheduleInput): KillSchedule {
  assertFiniteMs("claimedAtMs", input.claimedAtMs);
  assertFiniteMs("genTimeoutMs", input.genTimeoutMs);
  assertFiniteMs("deadlineMs", input.deadlineMs);
  const budgetKillMs = input.claimedAtMs + input.genTimeoutMs;
  const killAtMs = Math.min(budgetKillMs, input.deadlineMs);
  return {
    killAtMs,
    termAtMs: killAtMs - TERM_MARGIN_MS,
    killSigAtMs: killAtMs - KILL_MARGIN_MS,
  };
}

/** kill_at 까지 남은 시간(ms). 음수면 이미 지났다. */
export function remainingBeforeKill(schedule: KillSchedule, nowMs: number): number {
  return schedule.killAtMs - nowMs;
}

/**
 * 지금 세션을 띄울 **여유**가 있는가 — 남은 시간이 SIGTERM 유예 미만이면 false.
 *   즉시 죽여야 할 세션은 애초에 띄우지 않는다(계획: "don't start something you must instantly kill").
 */
export function hasSpawnRoom(schedule: KillSchedule, nowMs: number): boolean {
  return remainingBeforeKill(schedule, nowMs) >= TERM_MARGIN_MS;
}

/** supervisor 가 세션을 띄웠을 때 돌려받는 핸들(주입 seam 이 만든다). */
export interface SpawnedSession {
  /** 그룹 회수 대상 id = detached 세션의 프로세스그룹 id(실제 = child.pid). 스폰 실패면 pid 부재 → pgid ≤ 1(HIGH#1). */
  pgid: number;
  /**
   * (선택) cap-kill 이 **이미 일어났는지 동기 조회**(MEDIUM#1 — close 콜백보다 먼저 판정하기 위한 두 번째 채널).
   *   아래 `exited` 의 `outputCapExceeded` 는 리더 close 가 **resolve 된 뒤에야** 감독에 닿는다. cap-kill 이 kill_at
   *   **직전**에 일어나고 close 콜백이 지연되면, enforce 가 kill_at 에 그룹을 reap 할 때 `exited` 는 아직 pending →
   *   감독은 cap 사실을 모른 채 `killed`(성공 후보)로 오판한다(폭주 출력 회수가 성공으로 둔갑). 그래서 spawn seam 이
   *   cap-kill 하는 **바로 그 순간** 참이 되는 이 동기 ref 를 두어, **어떤 settle 경로**(enforce 의 kill_at reap 포함)든
   *   cap 을 즉시 보고 output_cap(실패)으로 가르게 한다. 미주입(옛/가짜 seam)이면 undefined → `exited` 플래그
   *   경로만 탄다(후방호환). */
  capKilled?: () => boolean;
  /** 세션이 **스스로** 종료하면 resolve(종료코드 · 신호 종료면 null). supervisor 가 죽이면 이건 안 풀려도 무방
   *   (회수 알람이 kill_at 에 반드시 settle 하므로 행이 없다).
   *   `outputCapExceeded` = 출력 상한(32MiB)을 넘겨 spawn seam 이 **cap-kill(SIGKILL)** 한 종료(MEDIUM#4). 감독이
   *   보낸 신호가 아니므로 termSent/killSent 로는 구분되지 않는다 — 이 플래그로 실어 output_cap(실패)으로 가른다.
   *   ⚠ 이 플래그는 close 경로라 **지연될 수 있다** — 즉시성이 필요한 판정은 위 `capKilled` 동기 ref 를 함께 본다. */
  exited: Promise<{ code: number | null; outputCapExceeded?: boolean }>;
}

/** 감독 seam(전부 주입 — 실시계/실스폰/실신호/실원장은 프로덕션 기본 seam 에만 있고 테스트는 가짜를 넣는다). */
export interface SuperviseDeps {
  /** 현재 절대 시각 ms. */
  now: () => number;
  /** 절대 시각 `atMs` 에 fn 을 1회 발화하도록 예약하고, 취소 함수를 돌려준다. 이미 지난 시각이면 즉시(다음 틱) 발화. */
  setAlarm: (atMs: number, fn: () => void) => () => void;
  /**
   * 세션 1건을 detached 로 spawn(플랜대로). supervisor 의 자식이 된다.
   *   ⚠ **nonce 를 exec-env(CHAT_SESSION_NONCE)로 주입**한다 — 데몬이 신호 전 이 값으로 그룹 소유를 검증한다
   *     (ownership.ts 계약). nonce 는 원장 intent 가 spawn **직전에** 발급한 재사용 불가 토큰이다.
   */
  spawnSession: (plan: SessionPlan, nonce: string) => SpawnedSession;
  /** 세션 그룹에 신호 전송(`process.kill(-pgid, sig)` — 이미 없으면 무해). */
  signalGroup: (pgid: number, sig: "SIGTERM" | "SIGKILL") => void;
  /** 그룹이 살아 있는가(`kill(-pgid,0)` → 살아있음=true · ESRCH=false). */
  groupAlive: (pgid: number) => boolean;
  /**
   * 소유권 원장(ownership.ts createLedger 산물) — 2급 백스톱의 기록측. intent(자식 spawn 직전) → register(pgid 확정)
   *   → settle(회수 처분)로 세션 소유를 내구 기록한다. 데몬이 이 원장을 nonce 검증하 읽어 세션을 직접 회수한다.
   *   ⚠ **타입상 선택이나 런타임 필수**: 프로덕션 main()·테스트는 반드시 주입한다(미주입은 배선 불변식 위반이라
   *     superviseSession 이 fail-closed 로 던진다). 타입을 선택으로 둔 유일한 이유는 runner 의 `defaultSuperviseDeps`
   *     (원장을 모르는 base seam 번들)가 컴파일되게 하기 위함이다(S4 가 runner 를 원장 배선으로 재정렬한다). */
  ledger?: LedgerHandle;
  /** 세션 역할(원장 감사 라벨 · evaluateReap 은 쓰지 않는다). 미주입=main(S4 가 seam 을 통해 recovery 를 실어준다). */
  role?: SessionRole;
  /** (선택) 세션 그룹이 살아나면 pgid 를 **in-memory** 레지스트리에 등록 — 종료 전파(SIGTERM)가 이 집합을 본다
   *   (Finding 1). 원장(디스크)과 별개의 SIGTERM-창 백스톱이다. 미주입=무시. */
  registerSessionGroup?: (pgid: number) => void;
  /** (선택) 세션이 **소멸 확인**되어 settle(reaped)하면 in-memory 해제. register 와 짝. **reap_failed(leaked)면 호출
   *   하지 않는다** — 그룹이 살아있어 종료 전파가 계속 겨냥해야 하므로. 미주입=무시. */
  releaseSessionGroup?: (pgid: number) => void;
}

/** 감독 결과(세션 1건). */
export type SessionOutcome =
  | "exited" /** 세션이 신호 전에 스스로 종료(정상 완주 후보 — 전이 여부는 러너가 next-action 으로 확인) */
  | "killed" /** 마감 강제(TERM/KILL 후 kill_at 시점 그룹 소멸 확인됨) */
  | "reap_failed" /** kill_at 시점에도 그룹 생존 = 마감 강제 실패('결국 종료'가 아니다 · 계획 7절) */
  | "output_cap" /** 출력 상한(32MiB) 초과로 spawn seam 이 cap-kill = 실패(exited 로 낙관 금지 · MEDIUM#4) */
  | "ledger_unwritable" /** 소유권 원장(2급 백스톱)이 **내구적으로 안 써짐** = 백스톱 미확립 = 실패. 두 지점:
      ① intent(자식 spawn **전**) 쓰기 실패 → 아직 아무 자식도 안 떴으므로 회수할 게 없다(곧장 실패 · 옛 post-spawn
         하트비트 가드보다 단순·안전). ② register(pgid 확정) 쓰기 실패 → 이미 뜬 그룹을 SIGKILL 로 회수하고 실패
      (백스톱 없이 살아있는 세션을 두지 않는다). ②는 SIGKILL 뒤 **groupAlive 로 소멸을 확인해** 처분을 가른다 —
      소멸 확인=reaped(+in-memory 해제) · 여전히 생존=leaked(+in-memory 유지 · 살아있는 그룹을 놓지 않는다 · HIGH#1).
      어느 쪽이든 세션을 백스톱 없이 돌리지 않는다(HIGH — configured backstop 미확립 fail-closed). */
  | "spawn_failed" /** 스폰이 pid 를 못 냄(claude 부재·EACCES → pgid ≤ 1) = 실행된 그룹 없음. 신호·알람·등록 0(HIGH#1) */
  | "refused"; /** 스폰 여유 부족(남은 시간 < TERM_MARGIN) → 애초에 안 띄웠다 */

export interface SuperviseResult {
  outcome: SessionOutcome;
  /** 세션이 스스로 종료했을 때의 종료코드(신호 종료·미종료·refused 면 null). */
  exitCode: number | null;
  /** 진단 한 줄(로그·failed 사유). 사람 카드 문구가 아니다. */
  detail: string;
}

/**
 * 세션 1건을 감독한다 — nonce 를 원장에 박고(의도 먼저), detached 로 띄우고, pgid 를 원장에 등록하고, kill_at
 *   스케줄로 마감을 강제하고, 결과를 돌려준다.
 *
 * **순서(잠긴 계약 — 재배열 금지)**: `hasSpawnRoom` → `ledger.intent(role, killAt)`(nonce 발급·**자식 spawn 전
 *   내구화** = register-lag 닫힘) → `spawnSession(plan, nonce)`(nonce 를 exec-env 로 주입) → pgid 검증(> 1) →
 *   `ledger.register(nonce, pgid)`(pgid 확정 승격). intent 가 던지면 **아직 자식이 없으므로** 회수 없이 실패,
 *   register 가 던지면 **이미 뜬 그룹을 SIGKILL 로 회수**하고 실패(둘 다 ledger_unwritable) — 그 회수는
 *   `groupAlive` 로 **소멸을 확인해야** reaped 로 처분하고, 살아남았으면 leaked 로 남겨 계속 겨냥한다(HIGH#1).
 *
 * settle 은 **정확히 한 번**: (a) 세션 자가 종료 · (b) kill_at 회수 확인 중 먼저 오는 쪽. 회수 알람이 kill_at 에
 *   반드시 판정하므로 세션이 영영 안 끝나도 promise 는 kill_at 에 풀린다(행 불가). settle 은 **처분-인지**다 —
 *   그룹 소멸 확인(exited/killed/output_cap)이면 `settle(nonce,"reaped")` + in-memory 해제, kill_at 시점 생존
 *   (reap_failed)이면 `settle(nonce,"leaked")`(원장 엔트리·in-memory 그룹 **유지** → 데몬·종료전파가 계속 겨냥).
 */
export function superviseSession(
  plan: SessionPlan,
  schedule: KillSchedule,
  deps: SuperviseDeps,
): Promise<SuperviseResult> {
  // 스폰 여유 사전 확인 — 즉시 죽여야 할 세션은 띄우지 않는다(신호 낭비·산출물 파손 회피). 원장 intent 이전이라
  //   여유 부족이면 nonce 조차 발급하지 않는다(존재하지 않을 세션의 의도를 원장에 남기지 않는다).
  if (!hasSpawnRoom(schedule, deps.now())) {
    return Promise.resolve({
      outcome: "refused",
      exitCode: null,
      detail: `스폰 여유 부족(남은 ${remainingBeforeKill(schedule, deps.now())}ms < TERM_MARGIN ${TERM_MARGIN_MS}ms)`,
    });
  }

  const ledger = deps.ledger;
  if (ledger === undefined) {
    // 배선 불변식 fail-closed — 프로덕션 main()·테스트는 반드시 createLedger 를 주입한다(2급 백스톱은 선택이 아니다).
    //   타입상 선택인 유일한 이유는 runner 컴파일(defaultSuperviseDeps)이며, 실행 경로는 늘 원장을 갖는다.
    throw new Error(
      "supervisor: ledger seam 미주입 — main()/테스트가 createLedger(ownership.ts)를 주입해야 합니다(소유권 백스톱은 선택이 아님).",
    );
  }
  const role = deps.role ?? "main";

  /**
   * ── 의도 먼저(intent-BEFORE-spawn) — register-lag 를 닫는다(ownership.ts 헤더 참조) ──
   *   nonce 를 자식 spawn **직전에** 내구 기록한다. pgid 가 아직 없어도 nonce 는 이미 디스크에 있으니, supervisor 가
   *   그 직후 급사해도 데몬은 nonce 스캔으로 미등록 그룹까지 찾아낸다. `intent` 가 던지면(원장 쓰기 실패) **아직 아무
   *   자식도 spawn 되지 않았으므로** 회수 대상이 없다 — 곧장 ledger_unwritable 로 끝낸다(옛 post-spawn 하트비트
   *   가드는 자식을 먼저 띄운 뒤 실패를 확인해 회수해야 했다 · 이쪽이 더 단순·안전).
   */
  let nonce: string;
  try {
    nonce = ledger.intent(role, schedule.killAtMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Promise.resolve<SuperviseResult>({
      outcome: "ledger_unwritable",
      exitCode: null,
      detail: `원장 intent(소유 의도) 기록 실패 — 자식 spawn 전이라 회수 대상 없음: ${msg}`,
    });
  }

  // nonce 를 exec-env 로 심어 세션을 spawn(nonce 는 이미 디스크에 내구화됨 = happens-before 보장).
  const session = deps.spawnSession(plan, nonce);
  const pgid = session.pgid;
  /**
   * HIGH#1 — **스폰 실패는 실행 중인 그룹이 아니다**. spawn 이 pid 를 못 내면(claude 부재·EACCES) pgid 가 ≤ 1 로
   *   온다(defaultSpawnSession 의 `child.pid ?? -1`). 이걸 회수 대상 그룹으로 착각하면 재앙이다: `process.kill(-pgid)`
   *   가 pgid=-1 일 때 `process.kill(-(-1))` = `process.kill(1)` = **init/launchd(PID 1) 를 신호**한다(pgid=0 이면
   *   `kill(-0)`=`kill(0)`=호출자 그룹 전체). PID 1 은 늘 살아 있어 groupAlive(-1)=true → 리더 종료가 영영 settle 안
   *   되고, TERM/KILL 이 init 을 겨냥. 그래서 유효 pgid 가 아니면 **즉시 spawn_failed 로 short-circuit** 한다 — 알람
   *   무장·pgid 등록·신호 전송을 전부 건너뛴다. 다만 intent 로 남긴 `spawning` 엔트리는 정리해야 하므로(아무 그룹도
   *   안 떴다) best-effort 로 `settle(reaped)` 한다 — 실패해도 데몬이 killAt+여유 후 GC 하므로 무해하다.
   */
  if (!Number.isInteger(pgid) || pgid <= 1) {
    try {
      ledger.settle(nonce, "reaped"); // 아무 그룹도 안 뜬 spawning 의도를 '확인·소멸'로 정리(best-effort).
    } catch {
      // 원장 쓰기 실패는 무시 — 실행된 그룹이 없어 위험이 없고, 데몬이 미발생 spawning 을 killAt+여유 후 GC 한다.
    }
    return Promise.resolve<SuperviseResult>({
      outcome: "spawn_failed",
      exitCode: null,
      detail: `세션 스폰 실패(유효 pgid 없음: ${pgid}) — 신호·알람·등록 없이 즉시 실패(init/launchd 오신호 차단)`,
    });
  }

  /**
   * in-memory 레지스트리 등록 — 종료 전파(SIGTERM)가 이 집합을 본다(Finding 1). 원장(디스크)과 **별개**의
   *   SIGTERM-창 백스톱이다: supervisor 가 살아 handler 를 돌릴 수 있을 때만 유효하지만, ledger.register 가 확정되기
   *   전의 짧은 창에서도 SIGTERM 이 오면 이 세션을 놓치지 않게 spawn 직후 곧바로 등록한다. 이 등록은 순수 Set 연산이라
   *   던지지 않는다(옛 하트비트 publish 가 디스크 쓰기라 던졌던 것과 다르다 — 디스크 백스톱은 이제 원장이다).
   */
  deps.registerSessionGroup?.(pgid);

  /**
   * ── 내구 소유 등록(register) — pgid 확정을 원장에 승격 ──
   *   `register` 가 던지면(원장 쓰기 실패) **방금 뜬 라이브 그룹이 디스크에 소유 기록 없이 떠 있다** = 백스톱
   *   미확립이다. 세션을 백스톱 없이 1초도 돌리지 않는다 — 이미 뜬 그룹을 즉시 SIGKILL 로 회수하고
   *   ledger_unwritable(실패)로 끝낸다. 알람 무장·자가종료 관측 전이라 부작용은 그룹 회수뿐이다. 주·복구 세션 모두
   *   이 가드를 똑같이 통과하므로(둘 다 superviseSession 을 탄다) 어느 쪽 register 가 실패해도 동일하게 fail-closed.
   *
   *   ⚠ **HIGH#1 — SIGKILL 을 쐈다고 그룹이 죽었다고 가정하지 않는다(처분-인지 register-fail)**: 옛 코드는 SIGKILL
   *     **직후 곧바로** in-memory 를 해제하고 `settle(reaped)` 했다. 그런데 `reaped` 는 스키마상 **pgid 를 버리고**
   *     (ownership.ts settle) 데몬은 그 엔트리를 gc 한다 — 즉 SIGKILL 이 실패해 그룹이 **살아남았으면** 그 살아있는
   *     그룹이 in-memory(종료 전파 대상)에서도 디스크(데몬 회수 대상)에서도 **동시에 사라져** 마감을 넘겨 살아남는다.
   *     그래서 kill_at 회수 경로와 **똑같은 회수 검증**(`deps.groupAlive(pgid)` — 별도 확인을 새로 만들지 않는다.
   *     enforce 의 kill_at 판정이 쓰는 바로 그 seam 이라 판정 근거가 한 곳이다)으로 소멸을 **확인한 뒤에** 처분한다:
   *       · 소멸 확인 → `settle(reaped)` + in-memory 해제(옛 동작 — 이제 근거를 갖춘다).
   *       · 여전히 생존 → `settle(leaked)` + in-memory **유지**. 살아있는 그룹은 절대 놓지 않는다(종료 전파가 계속
   *         겨냥하고, 데몬도 계속 겨냥한다). 이는 아래 settle 의 reap_failed(leaked) 처분과 같은 규율이다.
   *     ※ 원장 쪽 leaked 기록은 **best-effort** 다. ⓐ register 가 던진 원인이 대개 원장 쓰기 실패라 settle 도 실패하고,
   *       ⓑ 엔트리가 아직 `spawning`(register 가 커밋 전에 던졌다)이면 원장은 `leaked` 전이를 거부한다(leaked 는
   *       유지할 pgid 가 있는 live 에서만 — ownership.ts). 어느 쪽이든 엔트리는 **nonce 를 지닌 spawning 으로 남고**,
   *       데몬의 spawning 경로가 그 nonce 로 스캔해 살아있는 그룹을 찾아 scan-then-kill 한다 → 추적은 유지된다.
   *       결정적인 것은 "살아있는 그룹을 **reaped 로 지우지 않는다**"이며 그건 아래 분기가 무조건 보장한다.
   */
  try {
    ledger.register(nonce, pgid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.signalGroup(pgid, "SIGKILL"); // 백스톱 없이 살아있는 그룹을 그대로 두지 않는다(즉시 회수 **시도**).
    // 회수 검증 — kill_at 경로와 동일 seam(groupAlive). '쐈다'가 아니라 '죽었다'를 근거로 처분을 가른다.
    const survived = deps.groupAlive(pgid);
    if (survived) {
      // 그룹 생존 = leaked. in-memory 를 **해제하지 않는다**(종료 전파가 계속 SIGKILL 대상으로 삼는다).
      try {
        ledger.settle(nonce, "leaked"); // best-effort — 실패해도 엔트리는 nonce 를 지닌 spawning 으로 남아 스캔 추적된다.
      } catch {
        // 원장 unwritable 또는 spawning→leaked 거부 — 위 주석대로 nonce 스캔 경로가 회수를 이어간다.
      }
      return Promise.resolve<SuperviseResult>({
        outcome: "ledger_unwritable",
        exitCode: null,
        detail: `원장 register(pgid 확정) 기록 실패 — SIGKILL 회수 시도했으나 그룹(${pgid}) 생존(leaked · 추적 유지): ${msg}`,
      });
    }
    // 그룹 소멸 확인 = reaped. 이제서야 pgid 를 버리고 in-memory 를 놓아도 안전하다.
    try {
      deps.releaseSessionGroup?.(pgid); // in-memory 정리(멱등) — 종료 전파 대상에서 뗀다.
    } catch {
      // in-memory 정리 실패는 무시 — 그룹은 소멸 확인됐고 실패는 이미 확정이다.
    }
    try {
      ledger.settle(nonce, "reaped"); // spawning 의도 정리(best-effort — 원장이 unwritable 이면 데몬 GC 가 처리).
    } catch {
      // 원장도 unwritable — 데몬이 killAt+여유 후 미발생 spawning 을 GC 한다.
    }
    return Promise.resolve<SuperviseResult>({
      outcome: "ledger_unwritable",
      exitCode: null,
      detail: `원장 register(pgid 확정) 기록 실패 — 백스톱 미확립이라 그룹(${pgid})을 SIGKILL 로 회수(소멸 확인): ${msg}`,
    });
  }

  return new Promise<SuperviseResult>((resolve) => {
    let settled = false;
    let termSent = false;
    let killSent = false;
    /**
     * MEDIUM#1 — **출력 상한 cap-kill 사실을 조기-return 너머로 박제하는 플래그**. 리더 close 가 `outputCapExceeded`
     *   로 뜨지만 손자가 그룹을 잠깐 살려두면(`groupAlive()===true`) onSelfExit 이 cap 을 처분하기 **전에** early-return
     *   한다. 그 뒤 손자가 죽고 kill_at 이 `enforce` 로 그룹을 reap 하면 예전엔 `killed`(=러너가 전이만 보이면 성공으로
     *   오판)로 settle 됐다 → **실패(폭주 출력 회수)가 성공으로 둔갑**. 그래서 cap 사실을 여기 박아, early-return 을
     *   거친 뒤의 **어떤 settle 경로**(enforce 의 kill_at reap 포함)든 `output_cap`(실패)으로 resolve 하게 한다.
     */
    let capKillObserved = false;
    const cancels: Array<() => void> = [];
    /**
     * MEDIUM#1 — cap-kill 관측 **통합 판정**. close 경로 플래그(capKillObserved)와 spawn seam 의 **동기 ref**
     *   (session.capKilled) 둘 중 하나라도 참이면 cap 이다. close 가 지연돼 capKillObserved 가 아직 false 여도,
     *   enforce 의 kill_at reap 이 ref 로 cap 을 **즉시** 본다 → 폭주 출력 회수를 killed(성공 후보)로 오판하지
     *   않는다. onSelfExit·enforce 의 **모든 최종 settle 분기**가 이 함수를 본다(단일 진실).
     */
    const capObserved = (): boolean => capKillObserved || session.capKilled?.() === true;

    /**
     * settle — 감독 종료를 **정확히 한 번** 확정하고 **원장에 처분을 기록**한다(disposition-aware · high#1 흡수):
     *   · reap_failed(그룹 생존)  → `settle(nonce,"leaked")`. 원장 엔트리는 **디스크에 남고**(데몬이 계속 겨냥) pgid 도
     *       유지된다. in-memory 도 **해제하지 않는다** — 종료 전파가 이 살아있는 그룹을 계속 SIGKILL 대상으로 삼는다.
     *       ⚠ 옛 settle 은 무조건 releaseSessionGroup 을 불러, reap 실패로 **살아있는** 그룹을 in-memory 에서도
     *          디스크에서도 지워 데몬이 회수 대상을 잃게 했다(high#1). 이제는 살아있는 그룹을 절대 놓지 않는다.
     *   · 그 외(exited/killed/output_cap · 그룹 소멸 확인) → `settle(nonce,"reaped")` + in-memory 해제. pgid 는 이제
     *       무의미·재사용 위험이라 원장이 버린다(스키마상 reaped 엔 pgid 부재).
     *   ⚠ ledger.settle 이 던져도(원장 쓰기 실패) promise 는 **반드시 resolve** 한다(행 금지) — stderr 감사만 남기고
     *      진행한다. 1급 마감 집행(kill 스케줄)은 이미 제 몫을 했고, 원장은 2급 백스톱이라 그 쓰기 실패가 결과를
     *      바꾸지 않는다(데몬이 원장 상태로 회수를 이어간다).
     */
    const settle = (r: SuperviseResult): void => {
      if (settled) return;
      settled = true;
      for (const cancel of cancels) cancel();
      if (r.outcome === "reap_failed") {
        // 그룹 생존 = leaked. 원장 엔트리·in-memory 그룹을 **유지**(해제 금지) — 데몬·종료전파가 계속 겨냥한다.
        try {
          ledger.settle(nonce, "leaked");
        } catch (e) {
          process.stderr.write(
            `supervisor: 원장 settle(leaked) 실패 — 데몬이 원장 상태로 회수 이어감(pgid=${pgid}): ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      } else {
        // 그룹 소멸 확인 = reaped. pgid 버리고 in-memory 해제(더는 종료 전파·회수 대상이 아니다).
        try {
          ledger.settle(nonce, "reaped");
        } catch (e) {
          process.stderr.write(
            `supervisor: 원장 settle(reaped) 실패 — 그룹은 소멸 확인됨, 데몬이 원장 상태로 정리(pgid=${pgid}): ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
        deps.releaseSessionGroup?.(pgid);
      }
      resolve(r);
    };

    /**
     * 세션 리더 자가 종료 — **그룹 소멸을 확인해야** settle 한다(Finding 2). 리더의 파이프가 닫히면 `exited` 가 뜨지만
     *   `nohup … &` 류 손자는 그룹에 살아남을 수 있다: 리더 종료를 그룹 사멸로 낙관해 알람을 다 취소하면 그 손자가
     *   kill_at 을 넘겨 살아남는다. 그래서 그룹이 **정말 비었을 때만** 성공(신호 전=exited · 신호 후=killed)으로 settle
     *   하고, 아직 살아있으면 settle 하지 않고 회수 경로(TERM/KILL/kill_at reap)에 맡긴다(kill_at 알람은 armNext 로 늘
     *   유지되므로 행 없음).
     */
    const onSelfExit = (code: number | null, outputCapExceeded: boolean): void => {
      if (settled) return;
      /**
       * MEDIUM#1 — cap 사실은 **groupAlive 조기-return 보다 먼저** 박제한다. 안 그러면 손자가 그룹을 살려둔
       *   순간(groupAlive=true)에 여기서 그냥 return 해버려 cap 플래그가 유실되고, kill_at 의 enforce reap 이
       *   `killed` 로 settle → 러너가 전이만 보이면 성공으로 오판한다. 플래그를 먼저 세워 이후 모든 settle 경로가
       *   실패(output_cap)를 유지하게 한다.
       */
      if (outputCapExceeded) capKillObserved = true;
      if (deps.groupAlive(pgid)) return; // 리더는 죽었으나 그룹 생존(손자 잔존) — 조기 성공 settle 금지, reap 경로가 처리.
      /**
       * MEDIUM#4 — 출력 상한(32MiB) 초과로 cap-kill 된 종료는 **깨끗한 종료가 아니라 폭주 출력 강제 회수(실패)**다.
       *   감독이 보낸 신호가 아니라 spawn seam 이 보낸 cap-kill 이라 termSent/killSent 는 안 서 있다 — 그래서 그
       *   플래그만 보고 exited 로 낙관하면 실패가 성공으로 둔갑한다. 별도 실패 outcome(output_cap)으로 settle 해
       *   러너가 **전이 관측과 무관하게** 실패로 처분하게 한다.
       *   (그룹이 아직 살아있으면 위 가드가 reap 경로에 넘기므로 여기 도달 = 그룹 소멸 확인됨.)
       */
      if (capObserved()) {
        settle({ outcome: "output_cap", exitCode: code, detail: "출력 상한(32MiB) 초과 → 그룹 cap-kill(실패 · exited 아님)" });
        return;
      }
      settle({
        outcome: killSent || termSent ? "killed" : "exited",
        exitCode: code,
        detail: killSent || termSent ? "신호 후 세션 종료(그룹 소멸 확인)" : "세션 자가 종료(그룹 소멸 확인)",
      });
    };
    session.exited.then(
      (e) => onSelfExit(e.code, e.outputCapExceeded === true),
      () => onSelfExit(null, false), // 종료 관측 자체가 실패해도 감독은 계속(회수 알람이 백스톱).
    );

    /**
     * 다음으로 도달해야 할 절대 임계로 알람을 (재)무장한다 — 조기 발화·클램프·밀린 타이머 내성의 축(Finding 3).
     *   nextTarget = 아직 안 지난 가장 이른 임계(termAt → killSigAt → killAt). 남은 지연이 setTimeout 상한을 넘으면
     *   **상한(ALARM_MAX_HOP_MS)만큼만** 걸고(클램프 시 즉시발화 회피), 그 알람이 깨면 enforce 가 다시 armNext 로 잇는다.
     *   armAt 은 늘 미래(now < nextTarget)이므로 타이트 루프가 없다.
     */
    const armNext = (): void => {
      if (settled) return;
      const now = deps.now();
      const nextTarget =
        now < schedule.termAtMs
          ? schedule.termAtMs
          : now < schedule.killSigAtMs
            ? schedule.killSigAtMs
            : schedule.killAtMs;
      const armAt = Math.min(nextTarget, now + ALARM_MAX_HOP_MS);
      cancels.push(deps.setAlarm(armAt, enforce));
    };

    /**
     * 마감 강제 한 스텝 — **어느 알람이 깨우든 `now()` 로 due 페이즈를 재계산**해 밀린 단계를 즉시 따라잡고, 아직
     *   kill_at 전이면 `armNext()` 로 다음 임계 알람을 잇는다(조기 발화·클램프에도 회수가 새지 않는다).
     */
    const enforce = (): void => {
      if (settled) return;
      const now = deps.now();
      if (now >= schedule.killAtMs) {
        // 밀린 경우를 대비해 아직 안 보낸 신호를 지금 마저 보낸다(그 뒤 곧바로 소멸 확인).
        if (!termSent) {
          deps.signalGroup(pgid, "SIGTERM");
          termSent = true;
        }
        if (!killSent) {
          deps.signalGroup(pgid, "SIGKILL");
          killSent = true;
        }
        // kill_at 시점 판정: **지금 소멸했는가**(결국이 아니라). 살아 있으면 회수 실패.
        if (deps.groupAlive(pgid)) {
          settle({ outcome: "reap_failed", exitCode: null, detail: `kill_at 시점 그룹(${pgid}) 생존 — 회수 실패` });
        } else if (capObserved()) {
          // MEDIUM#1 — cap-kill 이 관측된 경우(리더 close 가 알렸거나 · close 는 아직인데 spawn seam 의 동기 ref 가
          //   이미 참). 그룹이 이제 소멸했어도 이건 **깨끗한 마감 강제가 아니라 폭주 출력 회수(실패)**다 → killed 가
          //   아니라 output_cap 으로 settle(전이가 관측돼도 러너가 실패로 처분하게). ref 를 보므로 close 지연에도 샌다.
          settle({ outcome: "output_cap", exitCode: null, detail: "출력 상한(32MiB) 초과 → 그룹 cap-kill 후 회수 확인(실패 · killed 아님)" });
        } else {
          settle({ outcome: "killed", exitCode: null, detail: "마감 강제(회수 확인됨)" });
        }
        return;
      }
      if (now >= schedule.killSigAtMs) {
        if (!termSent) {
          deps.signalGroup(pgid, "SIGTERM");
          termSent = true;
        }
        if (!killSent) {
          deps.signalGroup(pgid, "SIGKILL");
          killSent = true;
        }
        armNext(); // 아직 kill_at 전 — reap 확인 알람을 잇는다.
        return;
      }
      if (now >= schedule.termAtMs) {
        if (!termSent) {
          deps.signalGroup(pgid, "SIGTERM");
          termSent = true;
        }
        armNext(); // KILL·reap 알람을 잇는다.
        return;
      }
      // 조기 발화(now < termAt) — 스펜트 원샷으로 버리지 않고 다음 임계로 재무장한다(Finding 3).
      armNext();
    };

    // 첫 무장(다음 임계로). 조기 발화·클램프·밀린 타이머는 armNext 재무장 + enforce 절대시계 재판정이 흡수한다.
    armNext();
  });
}

// ── 프로덕션 기본 seam (main() 과 W4 데몬이 쓴다 · W3 테스트에선 실행되지 않는다) ──────────────────

/** 실시계 seam — setTimeout 은 arm 시점의 상대 지연이지만, 발화 콜백(enforce)이 `now()` 로 재판정하므로 슬립에 강건하다. */
export const realClock: Pick<SuperviseDeps, "now" | "setAlarm"> = {
  now: () => Date.now(),
  setAlarm: (atMs, fn) => {
    const handle = setTimeout(() => fn(), Math.max(0, atMs - Date.now()));
    return () => clearTimeout(handle);
  },
};

/**
 * 세션 그룹 신호(cli-parser 의 killGroup 패턴) — 이미 없으면 조용히 무시.
 *
 * ⚠ **pgid ≤ 1 은 process.kill 을 호출하지도 않고 즉시 반환한다**(HIGH#1 방어심층). `process.kill(-pgid,…)` 는
 *   pgid=1 이면 `kill(-1)` = **호출자가 신호할 수 있는 거의 모든 프로세스**, pgid=-1 이면 `kill(-(-1))` = `kill(1)`
 *   = **init/launchd**, pgid=0 이면 `kill(0)` = **호출자 그룹 전체**로 퍼진다. 스폰 실패 -1 등 나쁜 pgid 가 어떤
 *   경로로 새어들어도 여기서 광역·init 신호로 번지지 않게 막는다(superviseSession short-circuit 이 1차, 이건 2차).
 */
export function realSignalGroup(pgid: number, sig: "SIGTERM" | "SIGKILL"): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return; // 유효 pgid 아님 — kill(1)/kill(-1)/kill(0) 광역·init 신호 차단.
  try {
    process.kill(-pgid, sig); // 음수 pid = 프로세스그룹 전체(세션 + Bash 손자)
  } catch {
    // 이미 종료됨 — 무해.
  }
}

/**
 * 그룹 생존 확인 — ESRCH=소멸(false), EPERM=존재하나 권한없음(보수적으로 생존=true), 그 외=생존.
 *
 * ⚠ **pgid ≤ 1 은 process.kill 을 호출하지도 않고 false 를 반환한다**(HIGH#1 방어심층). 안 그러면 `kill(-(-1),0)`
 *   = `kill(1,0)` 로 늘 살아있는 PID 1(init)을 찔러 **스폰 실패한 세션이 영원히 '생존 중'으로 오판**돼 리더 종료가
 *   settle 되지 않고 회수가 새어나간다. 유효 그룹이 아니면 '생존 아님'이 옳다(회수할 게 없다).
 */
export function realGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false; // 유효 pgid 아님 — kill(1,0) 로 init 을 생존으로 오판하지 않는다.
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── 세션 그룹 레지스트리 + 종료 전파(Finding 1 — 마감 구멍 봉합) ──────────────────────────────────

/**
 * 살아있는 세션 하위 그룹 레지스트리 — 이 supervisor 가 detached 로 띄운 세션 그룹의 pgid 집합(**순수 in-memory**).
 *   종료 전파(installSupervisorTerminationHandlers)가 supervisor 가 죽기 전에 이들을 SIGKILL 한다 — supervisor 가
 *   살아 handler 를 돌릴 수 있는 **SIGTERM 경로**의 백스톱이다. supervisor 가 SIGKILL(트랩 불가)로 급사하면 이 집합은
 *   프로세스와 함께 사라지므로, 그 잔여 백스톱은 **디스크 원장(ownership.ts)**이 맡는다(모듈 헤더 구멍-닫기 ②).
 *
 * ⚠ **옛 하트비트 publish 는 폐기됐다**: 이 레지스트리는 더는 디스크에 pgid 목록을 발행하지 않는다(raw-PID 하트비트가
 *   register-lag·PID 재사용을 못 막아 nonce 원장으로 대체됨 — ownership.ts). 여기 남은 건 종료 전파용 in-memory 뷰뿐.
 */
export interface SessionGroupRegistry {
  /** 세션 그룹이 살아나면 등록. pgid ≤ 1 은 무효(스폰 실패 -1 · 그룹 1 은 회수 대상 아님)라 무시한다. */
  register: (pgid: number) => void;
  /** 세션이 소멸 확인되어 settle(reaped)하면 해제. reap_failed(leaked · 그룹 생존)면 호출하지 않는다(계속 겨냥). */
  release: (pgid: number) => void;
  /** 현재 살아있는 pgid 스냅샷(오름차순 — 결정론). 종료 전파가 읽는다. */
  live: () => number[];
}

/**
 * 세션 그룹 레지스트리 생성(**순수 in-memory** — 디스크 발행 없음). 종료 전파가 `live()` 로 살아있는 세션 그룹을 읽어
 *   supervisor 종료 전에 SIGKILL 한다. 디스크 백스톱(데몬이 신호 전 nonce 검증하 읽는 소유권)은 이 레지스트리가 아니라
 *   **소유권 원장(ownership.ts createLedger)**이 맡는다 — superviseSession 이 intent/register/settle 로 배선한다.
 *
 * ⚠ **pgid > 1 가드는 안전 필수다**: 종료 전파는 `process.kill(-pgid, SIGKILL)` 을 쓰는데, pgid 가 1 이면
 *   `kill(-1, …)` = **호출자가 신호할 수 있는 거의 모든 프로세스**로 퍼진다(재앙). 무효 pgid 는 등록 자체를 막는다.
 */
export function createSessionGroupRegistry(): SessionGroupRegistry {
  const live = new Set<number>();
  const snapshot = (): number[] => [...live].sort((a, b) => a - b);
  return {
    register: (pgid: number): void => {
      if (Number.isInteger(pgid) && pgid > 1) live.add(pgid);
    },
    release: (pgid: number): void => {
      live.delete(pgid);
    },
    live: snapshot,
  };
}

/** 종료 전파 핸들러가 붙는 호스트(기본 = process). 테스트는 가짜를 주입해 실 신호·실 exit 없이 판정한다. */
export interface SupervisorTerminationHost {
  on: (event: "SIGTERM" | "SIGINT" | "exit", listener: () => void) => void;
  removeListener: (event: "SIGTERM" | "SIGINT" | "exit", listener: () => void) => void;
  exit: (code?: number) => void;
}

/**
 * supervisor 종료 전파 핸들러 설치(Finding 1 — 마감 구멍 봉합) — 데몬(W4)이 supervisor 를 **SIGTERM/SIGINT 로
 *   우아하게** 끝내거나 supervisor 가 정상 종료(exit)할 때, 아직 살아있는 세션 하위 그룹을 supervisor 가 빠져나가기
 *   **전에** 전부 SIGKILL 해 고아를 남기지 않는다.
 *
 * 왜 필요한가: 세션은 supervisor 그룹을 **상속하지 않는다**(각자 detached 하위 그룹 — 회수 검증이 그룹 밖에서
 *   성립해야 하므로). 그래서 음수-PID 신호 `kill(-supervisorPID)` 는 supervisor PGID **하나만** 겨냥하고 세션 그룹엔
 *   닿지 않는다 — supervisor 가 죽으면 세션과 Bash 손자는 마감 타이머 주인을 잃고 살아남는다. 그 구멍을 여기서 닫는다.
 *
 * ⚠ **SIGKILL 로 supervisor 자신이 죽는 경우는 트랩 불가**(SIGKILL 은 핸들러를 못 건다). 그 잔여는 **디스크 원장**이
 *   메운다: 데몬은 원장을 읽어 nonce 검증하 세션 그룹을 직접 kill 한다(ownership.ts 계약 · 모듈 헤더 W3↔W4).
 *
 * @returns 설치 해제 함수(핸들러 제거 — 테스트 정리용).
 */
export function installSupervisorTerminationHandlers(
  registry: SessionGroupRegistry,
  deps: { signalGroup: (pgid: number, sig: "SIGKILL") => void; host?: SupervisorTerminationHost },
): () => void {
  const host: SupervisorTerminationHost = deps.host ?? {
    on: (event, listener) => {
      process.on(event, listener);
    },
    removeListener: (event, listener) => {
      process.removeListener(event, listener);
    },
    exit: (code) => process.exit(code),
  };
  // 살아있는 세션 그룹을 전부 SIGKILL(멱등 — release 로 비면 no-op). 그룹 kill 이라 detached 손자까지 회수된다.
  const reap = (): void => {
    for (const pgid of registry.live()) {
      deps.signalGroup(pgid, "SIGKILL");
      registry.release(pgid);
    }
  };
  const onSignal =
    (code: number) =>
    (): void => {
      reap();
      // SIGTERM/SIGINT 리스너를 달면 Node 의 기본 종료가 무효화되므로 **명시 종료**한다(안 그러면 데몬의 우아한 종료가 먹통).
      host.exit(code);
    };
  const onTerm = onSignal(143); // 128 + SIGTERM(15)
  const onInt = onSignal(130); // 128 + SIGINT(2)
  const onExit = (): void => reap(); // 정상 종료 백스톱(exit 이벤트 — 동기만 가능, reap 은 동기).
  host.on("SIGTERM", onTerm);
  host.on("SIGINT", onInt);
  host.on("exit", onExit);
  return () => {
    host.removeListener("SIGTERM", onTerm);
    host.removeListener("SIGINT", onInt);
    host.removeListener("exit", onExit);
  };
}

/** cli-parser 와 동일 형태의 spawn 옵션(detached · stdin ignore). 스폰 없이 형태를 단위 테스트로 못 박기 위해 분리. */
export function buildSupervisorSpawnOptions(cwd: string, env: Record<string, string>): SpawnOptions {
  // stdio 는 새 mutable 배열로(SpawnOptions 는 readonly 튜플을 받지 않는다). 상수를 스프레드해 드리프트를 막는다.
  return { cwd, env, stdio: [...SUPERVISOR_SPAWN_STDIO], detached: SUPERVISOR_SPAWN_DETACHED };
}

/**
 * 프로덕션 세션 spawn seam(main()·W4 전용) — 실제 `claude` 를 detached 로 띄운다. **W3 테스트에선 호출되지 않는다**
 *   (실세션 0 · 스폰은 주입 seam 뒤). cli-parser 의 러너 패턴(그룹 kill·stdin ignore·출력 상한)을 그대로 잇는다.
 *
 * ⚠ **nonce 주입**: `plan.env` 를 복사해 `CHAT_SESSION_NONCE=nonce` 를 덮은 env 로 spawn 한다 — 데몬이 신호 전
 *   이 값으로 그룹 소유를 검증한다(ownership.ts 계약). 원본 plan.env 는 불변(다음 세션 조립에 영향 없음).
 *   ⚠ **W5 카나리**: nonce 가 실제로 자식의 exec-env 에 실려 데몬의 `ps -E`/`pgrep` 가 되읽는지는 실세션에서만
 *     확증된다 — 단위 테스트는 seam 이 nonce 를 **받았는가**만 고정한다(env 물리 주입은 W5).
 */
export function defaultSpawnSession(plan: SessionPlan, nonce: string): SpawnedSession {
  const env = { ...plan.env, [SESSION_NONCE_ENV]: nonce }; // nonce 를 exec-env 로 심는다(소유 토큰).
  const child = spawn("claude", plan.argv, buildSupervisorSpawnOptions(plan.cwd, env));
  let total = 0;
  let outputCapExceeded = false; // cap-kill 발생 표식 — exited 에 실어 output_cap(실패)으로 가른다(MEDIUM#4).
  const capKill = (): void => {
    if (child.pid !== undefined) realSignalGroup(child.pid, "SIGKILL");
  };
  const onChunk = (chunk: Buffer): void => {
    total += chunk.length;
    if (total > SUPERVISOR_MAX_OUTPUT_BYTES && !outputCapExceeded) {
      outputCapExceeded = true; // 한 번만 표식·kill(중복 신호 방지).
      capKill(); // 폭주 출력 → 그룹 kill.
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const exited = new Promise<{ code: number | null; outputCapExceeded?: boolean }>((resolve) => {
    child.on("close", (code) => resolve({ code, outputCapExceeded }));
    child.on("error", () => resolve({ code: null, outputCapExceeded })); // 스폰 실패도 '종료'로 환원(감독은 회수 알람이 백스톱).
  });
  // child.pid 미정(스폰 즉시 실패)이면 pgid 를 -1 로 둔다 — superviseSession 이 pgid ≤ 1 을 **spawn_failed 로 즉시
  //   short-circuit** 한다(HIGH#1). kill(-(-1))=kill(1) 이라 init 을 찌르므로, -1 은 '즉시 통과할 그룹'이 아니라
  //   '스폰 실패 표식'이고, realGroupAlive/realSignalGroup 도 pgid ≤ 1 을 거부한다(방어심층).
  //   capKilled = cap-kill **동기 ref**(MEDIUM#1) — onChunk 이 상한 초과 순간 outputCapExceeded 를 동기로 세우므로,
  //   감독의 enforce 가 close 콜백을 기다리지 않고도 cap 사실을 즉시 본다(폭주 회수를 killed 로 오판하지 않는다).
  return { pgid: child.pid ?? -1, capKilled: () => outputCapExceeded, exited };
}

/**
 * 프로덕션 감독 base seam — now·setAlarm·spawnSession·signalGroup·groupAlive 만 담는다(실행 경로에 늘 있는 것).
 *   **ledger·role·register/releaseSessionGroup 은 여기 없다**: 그것들은 잡·세션·런별 문맥이라 main() 이 런별로
 *   완성한다(원장은 createLedger 로, 레지스트리 배선은 registry 로). 그래서 이 상수를 그대로 superviseSession 에
 *   넘기면 원장 미주입으로 fail-closed 된다 — main()/테스트가 반드시 원장을 얹어 완성한 뒤 넘긴다.
 */
export const defaultSuperviseDeps: SuperviseDeps = {
  now: realClock.now,
  setAlarm: realClock.setAlarm,
  spawnSession: defaultSpawnSession,
  signalGroup: realSignalGroup,
  groupAlive: realGroupAlive,
};

/** 프로덕션 원장 io — ownership.ts createLedger 에 넘길 동기·원자 쓰기 seam(tmp→rename 원자 스왑). */
const defaultLedgerIo: LedgerIo = {
  writeFileSync: (p, d) => writeFileSync(p, d, "utf8"),
  renameSync,
};

/**
 * supervisor 프로세스의 **실제 기동 절대시각(ms)** — 데몬이 `ps` 로 읽는 start-time 과 대조해 supervisor 신원을
 *   검증한다(ownership.ts evaluateReap 의 owner-state: PID 재사용된 supervisor 를 원 supervisor 로 오인하지 않는다).
 *   `process.uptime()` 은 이 프로세스가 뜬 뒤 흐른 초라 `now - uptime` 이 곧 기동 순간이다(Darwin 에서 자기 기동시각을
 *   서브프로세스 없이 읽는 이식적 방법).
 *   ⚠ **생산측↔소비측 해상도(계약 · ownership.ts 헤더가 정본)**: 이 값은 **ms 근사**이고, 데몬은 같은 것을
 *     `ps -o lstart` 의 **초 단위** 커널 값으로 읽는다 — 둘은 원리상 같아지지 않으므로 `evaluateReap` 은
 *     **엄격 일치가 아니라 허용오차**(START_TIME_TOLERANCE_MS)로 대조한다. 그러니 여기서 값을 초로 절삭·반올림해
 *     '맞춰주려' 하지 말 것(정밀도를 버리면 오차만 커진다) — 허용오차가 격차를 흡수하는 게 계약이다.
 *   ⚠ **W5 카나리**: 이 Node 계산값과 데몬의 `ps` 읽기가 실제로 허용오차 안에 드는지는 실세션에서만 확증된다
 *     (반올림·시계 소스 차이 가능). 필드는 반드시 **실제 기동 순간**을 담는다(가짜 금지) — 정합은 W5 가 검증한다.
 */
function supervisorStartedAtMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

// ── detached 진입점 (데몬이 `node supervisor.js <잡스펙.json>` 을 detached 로 띄운다 · W3 테스트 밖) ──────

/**
 * detached 진입점 — 데몬(W4)이 이 파일을 **detached 로** spawn 해 프로세스그룹 리더로 만든 뒤, 잡 스펙 JSON 파일
 *   경로를 argv[2] 로 넘긴다. 이 프로세스 안에서 `runJobSession` 이 돌며 주/복구 세션을 자식으로 띄운다. 결과 JSON 을
 *   stdout 한 줄로 내보내고 ok 면 0, 실패면 1 로 종료한다.
 *
 * ⚠ **회수 토폴로지(모듈 헤더 W3↔W4 계약)**: 주/복구 세션은 각자 **detached 하위 그룹**이라 데몬의
 *   `kill(-이 프로세스 PID)`(= `kill(-supervisorPID)`)은 supervisor PGID **하나만** 겨냥하고 **세션 그룹엔 닿지 않는다**
 *   ("트리 전체 회수"는 거짓). 그래서 여기서 ① 종료 전파 핸들러(installSupervisorTerminationHandlers)를 설치해
 *   supervisor 가 SIGTERM/정상 exit 시 살아있는 세션 그룹을 SIGKILL 하고, ② **소유권 원장**(createLedger)을 배선해
 *   각 세션의 nonce·pgid 를 내구 기록한다 → 데몬이 원장을 nonce 검증하 읽어 세션 그룹을 직접 회수한다. 데몬은
 *   **SIGTERM 을 먼저** 보내거나 원장의 세션 pgid 를 직접 kill 해야 한다(맨몸 `kill(-supervisorPID, SIGKILL)` 하나로는
 *   부족 — 계약). 원장 경로는 **데몬이 정한다**(`CHAT_SESSION_LEDGER` env). 미설정이면 원장 없이 세션을 돌리지 않는다
 *   (2급 백스톱 미확립 → superviseSession 이 fail-closed → runner 가 config_error 로 보고).
 *
 * ⚠ **W3 단위 테스트는 이 함수를 실행하지 않는다**(실 세션·실 파일 · 스폰 seam 뒤). 여기는 배선 glue 다 —
 *   `runJobSession` 은 **동적 import** 로 불러 정적 순환(supervisor ↔ runner)을 피한다(런타임 init 순서 무관).
 */
async function main(specPath: string): Promise<void> {
  /**
   * MEDIUM#5 — 결과 JSON 을 W4 데몬이 우리 stdout(파이프)으로 읽는다. `process.exit()` 은 **대기 중 비동기 stdout
   *   쓰기를 잘라먹을 수 있다**(Node 공식 경고 — 데몬이 빈/반쪽 JSON 을 볼 위험). 그래서 exitCode 만 세우고, 결과가
   *   **flush 된 뒤**(쓰기 완료 콜백)에만 종료한다 — 콜백은 데이터가 OS 로 넘어간 시점에 불리므로 절단이 없다.
   *   의도한 종료코드(성공 0 · 실패 1)는 그대로 보존한다. 정상·실패(catch) 경로가 같은 flush 규약을 타도록 공용화.
   */
  const emitAndExit = (result: RunJobResult): void => {
    const exitCode = result.ok ? 0 : 1;
    process.exitCode = exitCode;
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      process.exit(exitCode);
    });
  };

  /**
   * MEDIUM#2 — **결과 없는 종료 금지**. runJobSession 은 계약상 던지지 않지만(늘 RunJobResult), 그 **앞단**은 던질 수
   *   있다: 잡 스펙 파일 read(경로 오류)·JSON.parse(손상된 스펙)·배선(동적 import 등). 옛 `void main()` 은 catch 가
   *   없어 그 throw 가 미처리 rejection 이 되고 supervisor 가 **RunJobResult 없이** 죽어, W4 데몬이 실패를 분류하지
   *   못했다. 그래서 진입점 전체를 감싸 **어떤 throw 든 구조적 실패 결과를 stdout 으로 내보내고 1 로 종료**한다
   *   (reason=config_error: 잡을 설정대로 띄우지 못한 진입점 실패 — 데몬이 소비 가능한 분류).
   */
  try {
    const { readFile } = await import("node:fs/promises");
    const { runJobSession } = await import("./cli-session-runner.js");
    const spec = JSON.parse(await readFile(specPath, "utf8")) as Parameters<typeof runJobSession>[0];

    // ① 종료 전파용 in-memory 레지스트리(**순수 in-memory** — 하트비트 publish 폐기). SIGTERM 창의 백스톱.
    const registry = createSessionGroupRegistry();
    // ① 종료 전파 설치 — 프로세스 수명 내내 살아있어야 한다(설치 해제하지 않는다; process.exit 의 'exit' 이벤트가 백스톱).
    installSupervisorTerminationHandlers(registry, { signalGroup: realSignalGroup });

    // ② 소유권 원장(디스크 백스톱) — 데몬이 nonce 검증하 읽어 세션을 직접 회수한다. 경로는 데몬이 정한다.
    //    supervisorMeta.startedAtMs 는 **실제 기동시각**(데몬 start-time 대조용 · 가짜 금지 · W5 카나리).
    const ledgerPath = process.env.CHAT_SESSION_LEDGER;
    const supervisorMeta: SupervisorMeta = {
      pid: process.pid,
      startedAtMs: supervisorStartedAtMs(),
      rid: spec.rid,
      stage: spec.stage,
    };
    const ledger =
      ledgerPath !== undefined && ledgerPath !== ""
        ? createLedger(ledgerPath, supervisorMeta, defaultLedgerIo)
        : undefined; // 미설정이면 undefined → superviseSession 이 fail-closed(2급 백스톱 없이 세션 안 돌림).

    const result = await runJobSession(
      {
        ...spec,
        // 인증 토큰은 스펙에 안 실려도 데몬 env(chat/.env 로더)에서 가져온다(비밀을 잡 파일에 남기지 않는다).
        oauthToken: spec.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
        baseEnv: process.env,
      },
      {
        // 주/복구 세션 spawn 에 원장 + 레지스트리(등록/해제)를 배선 — 종료 전파·데몬 회수가 이 세션을 본다.
        //   role 은 러너가 seam 으로 실어준다(주=main · 복구=recovery) → 원장이 세션 역할을 정직하게 라벨링한다
        //   (evaluateReap 은 role 로 분기하지 않지만 감사 라벨은 정확해야 한다 · S4 재정렬).
        supervise: (plan, role, schedule) =>
          superviseSession(plan, schedule, {
            ...defaultSuperviseDeps,
            ledger,
            role,
            registerSessionGroup: registry.register,
            releaseSessionGroup: registry.release,
          }),
      },
    );
    emitAndExit(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitAndExit({ ok: false, reason: "config_error", detail: `supervisor 진입점 실패(잡 스펙·배선): ${msg}` });
  }
}

// 직접 실행(= 데몬이 띄운 detached 프로세스)일 때만 main. import 로 로드되면(테스트·runner) 실행되지 않는다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const specPath = process.argv[2];
  if (specPath === undefined || specPath === "") {
    process.stderr.write("supervisor: 잡 스펙 JSON 경로가 필요합니다(argv[2]).\n");
    process.exit(2);
  } else {
    void main(specPath);
  }
}
