/**
 * ownership.ts — 무인 세션의 **소유권 원장(ownership ledger)**: 스키마 + 내구 기록기 + 순수 회수판정 함수.
 *
 * ── 왜 이 모듈이 존재하는가(raw-PID 하트비트를 대체하는 소유권 계약) ────────────────────────────────
 * 옛 `{supervisorPid, sessionPgids[]}` 하트비트(supervisor.ts 의 createHeartbeatWriter)는 세션을 **안전하게
 *   식별하지 못한다**(5라운드 리뷰가 증명). 이유 둘:
 *     ① **register-lag** — 자식이 spawn 된 시점과 그 pgid 가 하트비트에 기록되는 시점 사이에 창이 있다. 그 창에
 *        supervisor 가 죽으면 데몬은 pgid 없는 세션을 못 보고 마감을 넘겨 살아남는다.
 *     ② **PID 재사용** — 커널이 죽은 세션의 pgid 숫자를 **무관한 다른 그룹**에 재배정하면, 하트비트의 stale pgid 를
 *        믿은 데몬이 `kill(-그pgid)` 로 **엉뚱한 그룹을 죽인다**(재앙).
 * 이 모듈은 raw pgid 를 **재사용 불가능한 암호학적 nonce**로 대체한다: nonce 는 세션의 **exec-time
 *   환경변수**(`CHAT_SESSION_NONCE`)로 주입되고, 데몬은 신호를 보내기 **전에** 대상 그룹의 exec-env 가 그 nonce 를
 *   지녔는지 확인한다 → pgid 가 재사용됐어도 nonce 가 안 맞으면 신호를 **거부**한다.
 *   ⚠ **정직한 경계(①과 ②의 처방 강도가 다르다 — "둘 다 닫았다"고 주장하지 않는다)**: ①register-lag 는 '의도 먼저'
 *     내구 단계 + nonce 스캔으로 **닫힌다**. 그러나 ②PID 재사용은 **완전히 닫히지 않고 좁혀질 뿐**이다 — nonce 검증은
 *     **판정(decision) 시점**에 성립하지만 실제 신호(kill)는 그 뒤에 온다. 그 사이에 원 그룹이 죽고 커널이 같은 pgid
 *     숫자를 무관한 그룹에 재배정하는 짧은 비원자 창(verify→signal TOCTOU · 프로세스 조회·스케줄링을 거치면 ms급도
 *     가능)이 **이식 가능한 경로에선 원리상 남는다**
 *     (Darwin 에선 '환경변수 확인과 그룹 신호'를 원자적으로 묶을 방법이 없다 — 잔여 TOCTOU 불가피). 이 창은 데몬이
 *     **신호 직전에 nonce 를 다시 검증**해 **가능한 한 좁힐 뿐** 없애지 못한다. 유일하게 완전히 닫는 길은
 *     **cgroup v2(`cgroup.kill`, 그룹 멤버십이 커널 진실)** — 거기서만 검증·신호가 원자적이다. 그러니 정직한 서술은
 *     "PID 재사용을 **닫았다**"가 아니라 "**좁혔다(narrowed)** + Darwin 잔여 TOCTOU 불가피, Linux cgroup 에서만 닫힘"이다.
 *
 * ── W3↔W4 계약(이 헤더가 부재의 W4 데몬이 코딩할 스펙이다) ──────────────────────────────────────────
 * **supervisor(W3/W5 기록측)가 원장에 쓰는 것·시점**:
 *   1. `intent(role, killAt)` — 자식을 spawn 하기 **직전**에 nonce 를 생성하고 `state:"spawning"` 엔트리를 내구 기록한다.
 *      이 '의도 먼저' 단계가 register-lag 를 닫는다: pgid 가 아직 없어도 nonce 는 이미 디스크에 있으니, 데몬은
 *      **nonce 로 스캔**(`scanByEnv`)해 아직 미등록인 그룹까지 찾아낸다. supervisor 는 반드시 intent 가 내구화된
 *      **뒤에만** 자식을 spawn 하고, 그 자식의 env 에 이 nonce 를 심는다(happens-before 는 supervisor 가 강제; 이
 *      모듈은 intent 를 독립적 내구 단계로 만들 뿐).
 *   2. `register(nonce, pgid)` — 자식이 뜨고 pgid 가 확정되면 엔트리를 `state:"live"` + pgid 로 승격한다.
 *   3. `settle(nonce, "reaped"|"leaked")` — supervisor 가 회수를 확인하면 처분을 기록한다. `reaped`=그룹 소멸 확인
 *      (pgid 는 이제 무의미·재사용 위험이라 **버린다**) · `leaked`=회수 실패(그룹 생존 — 데몬이 계속 겨냥해야 하므로
 *      pgid 를 **유지**하고 엔트리는 **삭제하지 않고 남긴다**).
 *
 * **데몬(W4 소비측)이 신호 전에 반드시 검증할 것**(evaluateReap 이 순수 판정으로 인코딩한다):
 *   · **nonce 일치(판정 시점 게이트)** — live/leaked 엔트리의 pgid 그룹은 그 구성원의 exec-env 가 원장의 nonce 와
 *     **일치할 때만** 신호 대상이 된다. 불일치 = PID 재사용 = **신호 거부**(맨몸 pgid 를 절대 신호하지 않는다).
 *   · **신호 직전 nonce 재검증(가장 중요 — decision ≠ signal)** — evaluateReap 이 돌려주는 kill/scan-then-kill 결정은
 *     **판정 시점**의 nonce 검증만 담는다. 데몬은 실제 `kill(-pgid)` 를 **쏘기 바로 직전에**, 그 pgid 구성원의 exec-env 가
 *     결정에 **동봉된 nonce**(그래서 kill·scan-then-kill 결정 둘 다에 nonce 를 실어 보낸다)를 여전히 지녔는지 **다시
 *     확인**해야 한다. 이는 판정→신호 사이 PID 재사용 창(verify→signal TOCTOU)을 **최대한 좁히기 위함**이며, 결정이
 *     '검증 완료·nonce-free kill 허가'를 뜻하지 **않는다**. 특히 **scan-then-kill 의 스캔은 발견(discovery) 전용**이다:
 *     스캔이 pgid 를 찾았다는 사실이 nonce-free kill 을 허락하지 않는다 — 데몬은 발견된 **각 pgid 마다** 신호 직전
 *     nonce 를 재검증한다. (완전 원자성은 cgroup v2 경로에서만 — 위 '정직한 경계' 참조.)
 *   · **supervisor 기동시각 근접(허용오차 비교 — `===` 아님)** — 원장이 기록한 supervisor 가 **같은 프로세스**인지
 *     `kill(pid,0)` 만이 아니라 **기동시각(start-time)** 으로 확인한다(PID 재사용된 supervisor 를 원 supervisor 로
 *     오인하지 않는다). **생산측↔소비측 계약(해상도가 다르므로 반드시 허용오차로 비교한다)**:
 *       - 생산측(supervisor.ts) = `Date.now() - process.uptime()*1000` → **ms 근사**(프로세스가 자기 기동시각을
 *         이식적으로 자기-읽기 하는 최선). 원장 `supervisor.startedAtMs` 에 그 값을 그대로 기록한다.
 *       - 소비측(W4 데몬) = 그 pid 의 **`ps -o lstart`** 를 읽어 **ms 로 환산**해 `observed.startedAtMs` 에 싣는다.
 *         `lstart` 는 **초 단위** 커널 값이라 생산측 ms 근사와 **절대 같아지지 않는다**.
 *       - 비교 = `Math.abs(observed − ledger) ≤ START_TIME_TOLERANCE_MS`(허용오차가 이 해상도 격차를 흡수한다).
 *         엄격 일치로 두면 **정상 supervisor 가 매번 PID 재사용으로 오판**돼 제 세션이 회수된다(그 상수 주석 참조).
 *     살아있고 오차 안 → 그 owner 가 자기 세션을 관리 중이니 데몬은 **비켜선다(wait)**. 죽었거나 오차 밖(PID 재사용)
 *     → 세션은 고아 → 데몬이 nonce 검증하 회수한다. 기동시각을 **못 읽으면(null) → wait**('못 읽음 ≠ 불일치').
 *     ⚠ 이 근접 판정은 이식 경로의 **강한 휴리스틱**일 뿐 커널 보증 신원이 아니다(그건 cgroup 이야기). **1급 방어는
 *       nonce** 이고, 이 검사는 '살아있는 owner 에게 양보할지'만 정한다 — **혼자서는 어떤 kill 도 만들지 않는다**.
 *   · **알 수 없는 `v` 거부** — 원장 스키마 버전이 이 모듈이 아는 값(현재 1)이 아니면 파싱을 거부한다(전방 비호환
 *     포맷을 잘못 해석해 오회수하지 않는다).
 *
 * ⚠ **W5 카나리(실 `ps -E`/`pgrep` 없이는 이 모듈이 못 박지 못하는 것)**: exec-env 에 nonce 가 실제로 실리는지,
 *   `groupMembers`/`scanByEnv` 가 실 프로세스 트리에서 그룹·nonce 를 정확히 되읽는지는 실세션에서만 확증된다. W3
 *   단위 테스트는 procView 를 가짜로 넣어 **'무엇을 근거로 무엇을 결정하는가'** 만 고정한다(실 신호는 W5).
 *
 * ⚠ **이 모듈은 순수하다**: 실 spawn·실 `ps`/`pgrep`·실 신호가 없다. io(내구 기록)·now(시계)·nonceGen·procView 는
 *   전부 주입 seam 이라 테스트가 결정적이다. **데몬을 여기서 만들지 않는다** — 계약(이 모듈 + 파일 스키마)만 고정한다.
 */
import { randomUUID } from "node:crypto";

// ── 스키마 v1 ────────────────────────────────────────────────────────────────────

/**
 * 원장 스키마 버전. 데몬은 아는 버전만 파싱한다 — 미래에 포맷이 바뀌면 이 숫자를 올리고, 옛 데몬은 새 `v` 를
 *   **거부**(파싱 실패)해 잘못 해석한 채 오회수하는 사고를 막는다(전방 비호환 fail-closed).
 */
export const LEDGER_VERSION = 1 as const;

/** 세션이 exec-time 환경변수로 지니는 nonce 의 변수명. 데몬은 이 이름으로 그룹의 exec-env 를 조회해 소유를 확인한다. */
export const SESSION_NONCE_ENV = "CHAT_SESSION_NONCE";

/**
 * spawning(register-lag) 창의 GC 여유 = 5초. nonce 스캔으로 아무 그룹도 못 찾은 spawning 엔트리는, killAt 을 이만큼
 *   넘겼을 때에만 GC 한다. 왜 여유가 필요한가: register-lag 는 서브초 규모지만 스캔이 일시적으로(콜드스타트·경합)
 *   놓칠 수 있다 — 곧바로 GC 하면 아직 뜨는 중인 진짜 그룹을 원장에서 지워 추적을 잃는다. killAt+여유까지 기다려도
 *   못 찾으면 그 의도는 결국 아무 그룹도 낳지 못했다고 보고 정리한다.
 */
export const REGISTER_LAG_MARGIN_MS = 5_000;

/**
 * supervisor 기동시각 대조 허용오차 = 2초. **엄격 일치(`===`)를 쓰면 안 되는 이유가 계약에 박혀 있다**:
 *   · **생산측**(supervisor.ts `supervisorStartedAtMs`)은 `Date.now() - process.uptime()*1000` 이라 **ms 근사**다
 *     (프로세스가 자기 기동시각을 서브프로세스 없이 읽는 이식적 방법 — 이보다 정밀할 수 없다).
 *   · **소비측**(W4 데몬)은 같은 값을 `ps -o lstart` 로 읽는데 그건 **초 단위 커널 값**이다.
 *   두 값은 소스도 해상도도 달라 **원리상 절대 같을 수 없다**. `===` 로 비교하면 **살아있는 정상 supervisor 가
 *   매번 'PID 재사용'으로 오판**되고, 그 세션의 nonce 는 (당연히) 일치하므로 데몬이 **살아있는 owner 의 건강한
 *   세션을 죽인다**. 그래서 "같은 프로세스인가"는 허용오차 안의 근접으로 판정한다.
 *
 * **왜 2초인가**(이 검사가 갈라야 하는 두 세계의 간격):
 *   · 같은 프로세스 — 자기-읽기(ms 근사)와 `ps`(초 절삭) 사이 지터는 **초 절삭 1초 + 근사·반올림 오차**라 실질 1초대다.
 *     2초는 그보다 **넉넉히 위**라 정상 supervisor 를 오판하지 않는다.
 *   · 다른 프로세스(PID 재사용) — 옛 프로세스가 **죽고** 커널이 그 pid 를 **한 바퀴 돌아** 새 프로세스에 재배정해야
 *     성립한다. 그 간격은 현실적으로 **수 초~수 분** 이상이다. 2초는 그보다 **한참 아래**라 진짜 재사용을 놓치지 않는다.
 *   즉 2초는 '지터 위 · 재사용 간격 아래'의 넓은 골짜기에 놓인 값이다(양쪽 경계와 모두 여유가 크다).
 *
 * ⚠ **정직한 경계**: 허용오차 안의 기동시각 일치는 이식 가능 경로의 **강한 휴리스틱**이지 커널이 보증하는 신원이
 *   아니다(그건 Linux cgroup 이야기). **1급 방어는 여전히 nonce** 다 — 이 신원검사는 '살아있는 owner 에게 양보할지'
 *   만 정하고, 그 실패 방향은 늘 안전(kill 보다 wait/refuse)이어야 한다. 이 검사 **혼자서는 어떤 kill 도 만들지 않는다**.
 *
 * ⚠ **알려진 잔여 — 허용오차의 '아래쪽' 경계는 커널 보증이 아니다(S34-R2 high · 인지·수용된 설계 잔여)**: 위 '왜 2초인가'
 *   의 하단 전제("PID 재사용 간격은 수 초~수 분")는 **경험칙이지 커널 보증이 아니다**. Linux 는 `pid_max` 도달 시
 *   순환하므로 이론상 supervisor 급사 후 **허용오차(2초) 안에** 같은 pid 가 장수 프로세스에 재배정될 수 있다. 그러면
 *   ⓐ 분기가 그 재사용 pid 를 '살아있는 우리 owner'로 오인해 **wait 로 조기 반환** → 진짜 고아가 된 세션(+ register
 *   실패의 spawning fallback)이 nonce 스캔·회수에 **도달하지 못하고 재사용 프로세스가 사는 동안 보류**된다. 이는
 *   위 원칙대로 **실패 방향이 안전(wait — 무관 그룹 오kill 아님)** 이지만, '마감 넘긴 고아를 영구 보류'라는 잔여를
 *   남긴다. **닫는 길은 둘뿐이고 둘 다 W3 범위 밖이다**: ① W4 데몬의 **killAt-바운드 에스컬레이션**('owner 살아있으나
 *   마감+유예 초과 → wait 를 풀고 nonce 검증하 회수' — evaluateReap 판정 순서 1의 카베아트가 명시한 **계약 밖·사람
 *   승인 대상** 정책) · ② cgroup v2(커널 진실 멤버십). 오늘은 evaluateReap 소비자(W4)가 **아직 0개**라 도달 불가한
 *   휴면 잔여다. **엄격 `===` 로 되돌리면 이 잔여는 사라지지만 그 대가가 '정상 supervisor 매번 오살'(위)이라 훨씬
 *   나쁘다** — 그래서 허용오차가 옳고, 이 잔여는 W4/cgroup 로 넘긴다.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

/** 세션 역할 — 주 세션(main) 또는 전이 전용 복구 세션(recovery). */
export type SessionRole = "main" | "recovery";

/**
 * 세션 상태 기계:
 *   spawning → live → (reaped | leaked)
 *   · spawning = intent 기록됨, 아직 자식 미확정(pgid 없음).
 *   · live     = 자식 확정(pgid 있음).
 *   · reaped   = 그룹 소멸 확인(terminal · pgid 버림).
 *   · leaked   = 회수 실패, 그룹 생존(terminal · pgid 유지 — 데몬이 계속 겨냥).
 */
export type SessionState = "spawning" | "live" | "reaped" | "leaked";

/** 원장을 쓴 supervisor 의 신원. 데몬은 pid+startedAtMs 로 '같은 프로세스인가'를 확인한다(PID 재사용 방어). */
export interface SupervisorMeta {
  /** supervisor 프로세스 pid. */
  pid: number;
  /** supervisor 기동 절대 시각 ms — PID 재사용을 가려내는 축(kill(pid,0) 만으론 부족). */
  startedAtMs: number;
  /** 이 supervisor 가 처리 중인 잡의 run_id. */
  rid: string;
  /** run-stage 단계(intake·brief …). */
  stage: string;
}

/**
 * 세션 1건 엔트리. pgid 는 **live/leaked 에만** 존재한다(spawning=아직 없음 · reaped=소멸 후 버림). 이 불변식은
 *   parse 가 강제한다 — 데몬이 pgid 없는 상태를 신호하려 들지 못하게(맨몸 신호 금지의 스키마 층).
 */
export interface SessionEntry {
  /** 재사용 불가능한 소유 토큰. 세션 exec-env(CHAT_SESSION_NONCE)에 실린 값과 대조된다. */
  nonce: string;
  role: SessionRole;
  state: SessionState;
  /** 프로세스그룹 id — live/leaked 에만 present(spawning/reaped 엔 부재). parse·register 가 **1 초과 정수**만 허용. */
  pgid?: number;
  /** intent 기록 시각 ms(감사·진단용). */
  intentAtMs: number;
  /** register(자식 확정) 시각 ms — live 승격 시 기록(감사용). spawning 엔 부재. */
  spawnedAtMs?: number;
  /** 이 세션의 마감 절대 시각 ms(supervisor 가 intent 시 박는다). spawning GC 판정의 기준. */
  killAtMs: number;
}

/** 원장 전체. v 는 스키마 버전(데몬이 미지 버전을 거부하는 근거). */
export interface Ledger {
  v: typeof LEDGER_VERSION;
  supervisor: SupervisorMeta;
  sessions: SessionEntry[];
}

// ── 타입드 에러(호출부가 surface 할 수 있게) ──────────────────────────────────────

/**
 * parse 실패 에러 — **throw 로** 신호한다(타입드 에러라 호출부가 `instanceof LedgerParseError` 로 구분·surface 가능).
 *   던지는 경우: ① torn/invalid JSON, ② 알 수 없는 `v`, ③ 구조 위반(필드 누락·타입 불일치·pgid 불변식 위반).
 */
export class LedgerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerParseError";
  }
}

/** 불법 상태전이 에러 — register/settle 이 계약 밖 전이를 만나면 던진다(호출부가 명확히 실패 처리). */
export class LedgerTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerTransitionError";
  }
}

/**
 * 내구 기록 실패 에러 — io(writeFileSync/renameSync)가 던지면 **삼키지 않고** 이걸로 감싸 surface 한다. supervisor 가
 *   intent/register 에서 이걸 받아 fail-closed 할지(치명 여부)는 supervisor 가 정한다 — 이 모듈은 보고만 한다.
 */
export class LedgerWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerWriteError";
  }
}

// ── serialize / parse ────────────────────────────────────────────────────────────

/**
 * 원장을 내구 문자열로 직렬화. supervisor.ts 하트비트와 같은 관례로 끝에 `\n` 을 붙인다(POSIX 텍스트 파일). parse 는
 *   JSON.parse 가 트레일링 공백을 무시하므로 round-trip 한다.
 */
export function serialize(ledger: Ledger): string {
  return `${JSON.stringify(ledger)}\n`;
}

function asFiniteNumber(label: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new LedgerParseError(`원장 필드 '${label}' 가 유한한 숫자가 아닙니다: ${JSON.stringify(v)}`);
  }
  return v;
}

function asString(label: string, v: unknown): string {
  if (typeof v !== "string") throw new LedgerParseError(`원장 필드 '${label}' 가 문자열이 아닙니다: ${JSON.stringify(v)}`);
  return v;
}

/**
 * pgid 불변식 검증 — **register 와 동일한 조건**(1 초과 정수). parse 가 "유한 숫자"만 봐 넘기면 `pgid:1`·`-1`·`1.5`
 *   같은 값이 live/leaked 엔트리로 파싱돼 '구조적으로 유효한 v1 원장'이라는 스키마 계약이 깨진다(evaluateReap 이
 *   나중에 refuse 하더라도 계약 자체는 이미 거짓). init/launchd·광역 신호로 번질 값을 스키마 층에서부터 막는다.
 */
function asPgid(label: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 1) {
    throw new LedgerParseError(`원장 필드 '${label}' 가 유효한 pgid 가 아닙니다(1 초과 정수여야 함): ${JSON.stringify(v)}`);
  }
  return v;
}

function parseRole(v: unknown): SessionRole {
  if (v === "main" || v === "recovery") return v;
  throw new LedgerParseError(`알 수 없는 role: ${JSON.stringify(v)}`);
}

function parseState(v: unknown): SessionState {
  if (v === "spawning" || v === "live" || v === "reaped" || v === "leaked") return v;
  throw new LedgerParseError(`알 수 없는 state: ${JSON.stringify(v)}`);
}

/** live/leaked 만 pgid 를 갖는다(스키마 불변식). */
function stateHasPgid(state: SessionState): boolean {
  return state === "live" || state === "leaked";
}

function parseEntry(raw: unknown, i: number): SessionEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LedgerParseError(`sessions[${i}] 가 객체가 아닙니다`);
  }
  const o = raw as Record<string, unknown>;
  const state = parseState(o.state);
  const entry: SessionEntry = {
    nonce: asString(`sessions[${i}].nonce`, o.nonce),
    role: parseRole(o.role),
    state,
    intentAtMs: asFiniteNumber(`sessions[${i}].intentAtMs`, o.intentAtMs),
    killAtMs: asFiniteNumber(`sessions[${i}].killAtMs`, o.killAtMs),
  };
  // pgid 불변식: live/leaked 는 반드시 있어야 하고(그리고 register 와 같은 '1 초과 정수'여야 한다 — asPgid), spawning/
  //   reaped 는 있으면 안 된다(맨몸 신호 금지의 스키마 층).
  const hasPgid = o.pgid !== undefined;
  if (stateHasPgid(state)) {
    if (!hasPgid) throw new LedgerParseError(`sessions[${i}] state=${state} 인데 pgid 가 없습니다(불변식 위반)`);
    entry.pgid = asPgid(`sessions[${i}].pgid`, o.pgid);
  } else if (hasPgid) {
    throw new LedgerParseError(`sessions[${i}] state=${state} 인데 pgid 가 있습니다(불변식 위반)`);
  }
  if (o.spawnedAtMs !== undefined) entry.spawnedAtMs = asFiniteNumber(`sessions[${i}].spawnedAtMs`, o.spawnedAtMs);
  return entry;
}

/**
 * 내구 문자열을 원장으로 파싱(round-trip). **거부하는 것**(전부 LedgerParseError throw): torn/invalid JSON · 알 수
 *   없는 `v`(전방 비호환) · 구조 위반. 반환은 **정규화된** 원장(알 수 없는 잉여 필드는 버린다 — round-trip 결정론).
 */
export function parse(text: string): Ledger {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new LedgerParseError(`원장 JSON 파싱 실패(torn/invalid): ${msg}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LedgerParseError("원장 최상위가 객체가 아닙니다");
  }
  const o = raw as Record<string, unknown>;
  // 알 수 없는 v 거부 — 데몬이 미지 포맷을 잘못 해석하지 않게(전방 비호환 fail-closed).
  if (o.v !== LEDGER_VERSION) {
    throw new LedgerParseError(`알 수 없는 원장 버전 v=${JSON.stringify(o.v)}(지원 v=${LEDGER_VERSION})`);
  }
  const sup = o.supervisor;
  if (typeof sup !== "object" || sup === null || Array.isArray(sup)) {
    throw new LedgerParseError("supervisor 블록이 객체가 아닙니다");
  }
  const s = sup as Record<string, unknown>;
  const supervisor: SupervisorMeta = {
    pid: asFiniteNumber("supervisor.pid", s.pid),
    startedAtMs: asFiniteNumber("supervisor.startedAtMs", s.startedAtMs),
    rid: asString("supervisor.rid", s.rid),
    stage: asString("supervisor.stage", s.stage),
  };
  if (!Array.isArray(o.sessions)) throw new LedgerParseError("sessions 가 배열이 아닙니다");
  const sessions = o.sessions.map((e, i) => parseEntry(e, i));
  return { v: LEDGER_VERSION, supervisor, sessions };
}

// ── nonce 생성 seam ───────────────────────────────────────────────────────────────

/** nonce 생성기 — 주입 seam(테스트 결정성). 기본은 crypto.randomUUID(재사용 불가·정상 앱 코드라 허용). */
export type NonceGen = () => string;

/** 프로덕션 기본 nonce 생성기. */
export const defaultNonceGen: NonceGen = () => randomUUID();

// ── 내구 기록기(createLedger) ─────────────────────────────────────────────────────

/**
 * io seam — supervisor.ts 의 `HeartbeatIo` 와 **같은 모양**(동기 + tmp→rename 원자 스왑)을 재사용한다. 동기라
 *   호출 반환 시점엔 이미 디스크에 있어(대기 중 비동기 쓰기 없음) `process.exit()` 이 앞질러도 마지막 상태가 유실되지
 *   않고, tmp→rename 이라 데몬이 반쯤 쓰인 파일을 절대 읽지 않는다(찢김 없음).
 */
export interface LedgerIo {
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

/** createLedger 의 추가 주입 seam(시계·nonce). io 는 필수 위치인자, 이건 선택(기본=실시계/실 nonce). */
export interface LedgerSeams {
  /** 현재 절대 시각 ms(intentAtMs·spawnedAtMs 기록용). 기본 Date.now — 테스트는 가짜 시계를 넣는다. */
  now?: () => number;
  nonceGen?: NonceGen;
}

/** createLedger 가 돌려주는 핸들. supervisor 가 이걸로 원장을 몬다. */
export interface LedgerHandle {
  /** nonce 생성 + `spawning` 엔트리 내구 기록 후 nonce 반환. **자식 spawn 직전**에 호출(register-lag 해소). */
  intent: (role: SessionRole, killAtMs: number) => string;
  /** 자식 확정 시 그 엔트리를 `live` + pgid 로 승격(내구 기록). */
  register: (nonce: string, pgid: number) => void;
  /** 회수 확인 시 처분 기록: reaped(소멸·pgid 버림) 또는 leaked(생존·pgid 유지·엔트리 존치). */
  settle: (nonce: string, disposition: "reaped" | "leaked") => void;
  /** 현재 원장 스냅샷(읽기 전용 복사 — 종료 전파가 live pgid 를 읽거나 테스트가 관측). */
  snapshot: () => Ledger;
}

/**
 * 내구 원장 기록기를 만든다. **모든 변이는 tmp→rename 원자 스왑으로 내구 기록되고, io 가 던지면 삼키지 않고
 *   LedgerWriteError 로 surface** 한다(변이는 내구 성공 후에만 in-memory 에 커밋 → io 실패 시 in-memory 는
 *   디스크와 어긋나지 않는다). 불법 전이는 LedgerTransitionError 로 거부한다.
 *
 * @param path 원장 파일 경로.
 * @param supervisorMeta 이 supervisor 의 신원(데몬의 start-time 대조용).
 * @param io 동기 원자 쓰기 seam(HeartbeatIo 와 동형).
 * @param seams 선택 주입(now·nonceGen · 기본=실시계/실 nonce).
 */
export function createLedger(
  path: string,
  supervisorMeta: SupervisorMeta,
  io: LedgerIo,
  seams: LedgerSeams = {},
): LedgerHandle {
  const now = seams.now ?? (() => Date.now());
  const nonceGen = seams.nonceGen ?? defaultNonceGen;
  const tmp = `${path}.tmp`;
  // in-memory 는 **내구화된 디스크 상태의 거울**이다. 변이는 persist 성공 후에만 여기에 반영한다.
  let sessions: SessionEntry[] = [];

  /**
   * 다음 세션 배열을 내구 기록한다 — **성공한 뒤에만** in-memory 에 커밋한다. io 가 던지면 커밋 없이 LedgerWriteError
   *   를 던진다 → in-memory(sessions)는 이전 내구 상태 그대로라, 실패한 변이가 핸들에 새지 않는다(롤백 불필요·자동).
   */
  const persist = (next: SessionEntry[]): void => {
    const data = serialize({ v: LEDGER_VERSION, supervisor: supervisorMeta, sessions: next });
    try {
      io.writeFileSync(tmp, data);
      io.renameSync(tmp, path); // 원자 교체 — 소비자(데몬)는 완결본만 본다.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LedgerWriteError(`원장 내구 기록 실패(path=${path}): ${msg}`);
    }
    sessions = next; // 내구 성공 후에만 커밋.
  };

  const findIndex = (nonce: string): number => sessions.findIndex((e) => e.nonce === nonce);

  return {
    intent: (role: SessionRole, killAtMs: number): string => {
      // role·killAt 정합성 fail-closed(잘못된 잡 스펙이 원장에 새지 않게).
      if (role !== "main" && role !== "recovery") {
        throw new LedgerTransitionError(`intent: 알 수 없는 role: ${JSON.stringify(role)}`);
      }
      if (!Number.isFinite(killAtMs)) {
        throw new LedgerTransitionError(`intent: killAtMs 가 유한하지 않습니다: ${killAtMs}`);
      }
      const nonce = nonceGen();
      // nonce 충돌 방어 — 실 crypto nonce 는 충돌하지 않지만, 주입 테스트 seam 이 같은 값을 두 번 낼 수 있다. 같은
      //   nonce 두 엔트리는 register/settle 을 모호하게 만들므로 fail-closed(소유 토큰의 유일성이 계약의 근간).
      if (findIndex(nonce) >= 0) {
        throw new LedgerTransitionError(`intent: nonce 충돌(${nonce}) — 소유 토큰 유일성 위반`);
      }
      const entry: SessionEntry = { nonce, role, state: "spawning", intentAtMs: now(), killAtMs };
      persist([...sessions, entry]);
      return nonce;
    },

    register: (nonce: string, pgid: number): void => {
      const idx = findIndex(nonce);
      if (idx < 0) throw new LedgerTransitionError(`register: intent 되지 않은 nonce(${nonce}) — 소유권 없음`);
      const cur = sessions[idx];
      if (cur.state !== "spawning") {
        throw new LedgerTransitionError(`register: state=${cur.state} 는 spawning 이 아닙니다(재register·settle 후 register 금지)`);
      }
      // pgid 정합성 — supervisor 의 pgid ≤ 1 가드와 같은 이유(방어심층). pgid ≤ 1 이 원장에 들어가면 데몬의 회수가
      //   kill(1)=init/launchd·kill(-1)=광역·kill(0)=호출자그룹 으로 번질 위험이 있다. 유효 그룹만 live 로 승격한다.
      if (!Number.isInteger(pgid) || pgid <= 1) {
        throw new LedgerTransitionError(`register: 유효하지 않은 pgid(${pgid}) — init/launchd·광역 오신호 방지(1 초과 정수만)`);
      }
      const next = sessions.slice();
      next[idx] = { ...cur, state: "live", pgid, spawnedAtMs: now() };
      persist(next);
    },

    settle: (nonce: string, disposition: "reaped" | "leaked"): void => {
      const idx = findIndex(nonce);
      if (idx < 0) throw new LedgerTransitionError(`settle: 알 수 없는 nonce(${nonce})`);
      const cur = sessions[idx];
      if (cur.state === "reaped" || cur.state === "leaked") {
        throw new LedgerTransitionError(`settle: 이미 settle 됨(state=${cur.state}) — double-settle 금지`);
      }
      const next = sessions.slice();
      if (disposition === "reaped") {
        // reaped = 그룹 소멸 확인. pgid 는 이제 무의미하고 재사용 위험이라 **버린다**(스키마: reaped 엔 pgid 부재).
        //   live(있던 pgid) 든 spawning(원래 없음)이든 결과적으로 pgid 없는 reaped. spawn 실패로 register 못 한
        //   spawning 을 '아무것도 안 남고 확인됨'으로 정리하는 경로이기도 하다.
        const { pgid: _dropped, ...rest } = cur;
        void _dropped;
        next[idx] = { ...rest, state: "reaped" };
      } else {
        // leaked = 회수 실패, 그룹 생존. 데몬이 계속 겨냥해야 하므로 pgid 를 **유지**하고 엔트리를 **삭제하지 않는다**.
        //   pgid 없는 spawning 은 leaked 로 갈 수 없다(유지할 pgid 가 없다 — settle 시그니처가 pgid 를 안 받는다).
        if (cur.state !== "live") {
          throw new LedgerTransitionError(`settle leaked: state=${cur.state} 에는 유지할 pgid 가 없습니다(live 만 leaked 가능)`);
        }
        next[idx] = { ...cur, state: "leaked" };
      }
      persist(next);
    },

    snapshot: (): Ledger => ({
      v: LEDGER_VERSION,
      supervisor: { ...supervisorMeta },
      sessions: sessions.map((e) => ({ ...e })),
    }),
  };
}

// ── 순수 회수판정 함수(evaluateReap) — 계약의 심장 ────────────────────────────────

/**
 * 데몬이 프로세스 세계를 관측하는 seam(주입). **evaluateReap 은 이 안에서 실 ps/pgrep 를 부르지 않는다** — W3
 *   테스트는 가짜, W4 가 실 `ps -E`/`pgrep` 를 배선한다.
 */
export interface ProcView {
  /** pgid 그룹의 구성원 pid 목록. 그룹이 없으면(ESRCH) 빈 배열. */
  groupMembers: (pgid: number) => number[];
  /** pid 의 exec-env 에 name=value 가 있는가(예: `ps -E` 로 그 프로세스의 환경변수 조회). */
  execEnvHas: (pid: number, name: string, value: string) => boolean;
  /** exec-env 에 name=value 를 지닌 프로세스들의 pgid 목록(예: `pgrep`+env 필터). register-lag 창에서 pgid 발견용. */
  scanByEnv: (name: string, value: string) => number[];
}

/** 데몬이 판정 시점에 보는 세계 상태(owner supervisor 신원 + 관측 + 현재 시각). */
export interface SupervisorState {
  /** 원장이 기록한 owner supervisor 신원(우리가 이 잡을 띄웠다고 주장하는 그 프로세스). */
  ledger: { pid: number; startedAtMs: number };
  /** 데몬이 지금 그 pid 를 관측한 결과 — alive(kill(pid,0)) + 실제 startedAtMs(없으면 null). */
  observed: { alive: boolean; startedAtMs: number | null };
  /** 데몬의 현재 절대 시각 ms(spawning GC 의 killAt+여유 판정용). */
  nowMs: number;
}

/**
 * 회수 판정(부작용 없음 — **결정만** 한다, 실행은 데몬 몫):
 *   · kill          — pgid 그룹이 신호 후보다(판정 시점 nonce 검증 통과). **nonce 를 동봉**하니, 데몬은 kill(-pgid) 를
 *                     쏘기 **직전에** 그 nonce 로 재검증한 뒤 실행한다(decision ≠ signal · verify→signal 창 최소화).
 *   · scan-then-kill — spawning(pgid 미확정)인데 nonce 스캔이 그룹(들)을 **발견(discovery)**했다. 스캔은 발견일 뿐이라
 *                     데몬은 동봉된 nonce 로 **각 pgid 를 신호 직전 재검증**한 뒤 회수한다(스캔이 nonce-free kill 을 허락 안 함).
 *   · refuse        — 신호 거부. reason 이 근거(대표=nonce 불일치=PID 재사용 → 무관 그룹 오kill 방지 · 안전의 핵심).
 *   · gc            — 회수할 그룹이 없다(이미 소멸·미발생·reaped). 원장 엔트리만 정리(신호 없음).
 *   · wait          — 지금 손대지 않는다(owner 가 살아있어 자기 세션 관리 중 · 또는 register-lag 창 안).
 */
export type ReapDecision =
  | { action: "kill"; pgid: number; nonce: string; reason: string }
  | { action: "scan-then-kill"; nonce: string; pgids: number[]; reason: string }
  | { action: "refuse"; reason: string }
  | { action: "gc"; reason: string }
  | { action: "wait"; reason: string };

/**
 * 세션 엔트리 1건에 대한 회수 판정. 순수 — procView/supervisorState 만 보고 ReapDecision 을 돌린다.
 *
 * **판정 순서**:
 *   1. owner 신원 게이트 — **세 갈래**로 가른다(2갈래로 뭉치면 '살아있으나 기동시각 못 읽음'이 오회수로 샌다):
 *      ⓐ alive && |기동시각 − ledger| ≤ START_TIME_TOLERANCE_MS → 우리 owner, 아직 관리 중 → **wait**(비켜섬).
 *         `kill(pid,0)` 만으론 부족, **기동시각 근접**까지 봐야 PID 재사용된 supervisor 를 원 supervisor 로 오인하지
 *         않는다. **엄격 `===` 는 쓸 수 없다** — 생산측 ms 근사 vs 소비측 `ps` 초 단위라 원리상 불일치(그 주석 참조).
 *      ⓑ alive && 기동시각을 **읽었고 허용오차 밖으로 다름** → PID 재사용(무관 프로세스) → not-our-supervisor(회수 진행).
 *      ⓒ alive && 기동시각 == **null(못 읽음: 권한/파싱 실패)** → **다르다고 단정 금지** → **wait**(안전 방향: 살아있는
 *         owner 가 사라졌음을 증명 못 하니 그 세션을 뺏지 않는다). '못 읽음'을 '불일치'로 흘리면 살아있는 supervisor 의
 *         제 세션을 죽인다 — reap-progress 는 **DIFFERENT 임을 적극 확인**했을 때만 정당하다.
 *      ⓓ !alive → owner 사망 → 고아 회수 진행.
 *   2. terminal 정리 — reaped 는 이미 끝났으니 gc(엔트리 정리).
 *   3. live/leaked(pgid 있음) — 그룹이 없으면 gc(이미 소멸). 있으면 **nonce 일치할 때만 kill**, 불일치면 refuse
 *      (PID 재사용 안전 케이스).
 *   4. spawning(pgid 미확정) — nonce 로 스캔해 그룹을 찾으면 scan-then-kill, 못 찾고 killAt+여유를 넘겼으면 gc,
 *      아직 창 안이면 wait.
 */
export function evaluateReap(
  entry: SessionEntry,
  supervisorState: SupervisorState,
  procView: ProcView,
): ReapDecision {
  // 1. owner 신원 게이트 — 세 갈래(ⓐ 우리 owner 살아있음 · ⓑ PID 재사용 · ⓒ 기동시각 못 읽음 · ⓓ 사망). reap-progress
  //   는 owner 가 **DIFFERENT 프로세스임을 적극 확인**했을 때만 정당하다 — '살아있으나 신원 확인 불가'는 회수 금지.
  const obs = supervisorState.observed;
  if (obs.alive === true) {
    if (obs.startedAtMs !== null && Math.abs(obs.startedAtMs - supervisorState.ledger.startedAtMs) <= START_TIME_TOLERANCE_MS) {
      // ⓐ 살아있고 기동시각이 **허용오차 안** = 진짜 우리 owner, 아직 관리 중. 데몬은 밑에서 뺏지 않는다(owner 가 자기
      //   마감을 강제하고, 데몬은 owner 사망 시의 백스톱). W4/W5 카베아트: 'owner 살아있으나 마감+유예 초과'
      //   에스컬레이션은 계약 밖.
      //   ⚠ **엄격 `===` 가 아니라 허용오차인 이유**: 생산측은 ms 근사(`Date.now()-uptime`), 소비측은 `ps -o lstart`
      //     의 **초 단위** 커널 값이라 두 값은 원리상 같아질 수 없다. `===` 로 두면 정상 supervisor 가 매번
      //     'PID 재사용'으로 오판돼 **자기 세션이 죽는다**(nonce 는 당연히 일치하므로 kill 로 직행). 상세 근거·2초
      //     선택 이유는 START_TIME_TOLERANCE_MS 주석.
      return {
        action: "wait",
        reason: `owner supervisor 살아있고 신원 일치(기동시각 오차 ≤ ${START_TIME_TOLERANCE_MS}ms) — 자기 세션 관리 중이니 회수 보류(defer)`,
      };
    }
    if (obs.startedAtMs === null) {
      // ⓒ 살아있으나 기동시각을 **못 읽음**(권한/파싱) → '다른 프로세스'라고 단정할 수 없다. 여기서 회수로 내려가면
      //   살아있는 supervisor 의 제 세션을 죽인다 — 그래서 **wait**(safe direction: 못 읽음 ≠ 불일치). PID 재사용 판정은
      //   기동시각이 **읽혔고 실제로 달랐을 때만** 성립한다(아래 ⓑ). 이게 HIGH 결함의 처방(옛 2갈래는 이 경우를 흘렸다).
      return {
        action: "wait",
        reason: "owner pid 살아있으나 기동시각 못 읽음(권한/파싱) — 신원 확인 불가라 회수 보류(safe direction: 살아있는 owner 세션을 뺏지 않는다)",
      };
    }
    // ⓑ 기동시각이 읽혔고 **허용오차를 넘겨** 다르다 = PID 재사용(무관 프로세스). 아래 고아 회수로 내려간다.
    //   허용오차 밖이라는 건 두 값이 초 단위 해상도 차이로는 설명되지 않는다는 뜻이다(재사용은 수 초~수 분 간격).
  }
  // not-our-supervisor(ⓑ PID 재사용 또는 ⓓ 관측 dead): 원 supervisor 는 사라졌고 세션은 고아 → nonce 검증하 회수로
  //   진행한다. ⓑ 의 살아있는 그 pid 는 무관한 프로세스라 절대 신호하지 않는다(evaluateReap 은 세션 pgid 만 다룬다 —
  //   supervisor pid 신호는 데몬의 별개 경로). 여기 도달 = alive===false 이거나 (alive && 기동시각 읽힘 && 불일치).
  const ownerNote = obs.alive === false
    ? "owner dead"
    : "owner PID 재사용(기동시각 불일치) — not-our-supervisor";

  // 2. terminal 정리.
  if (entry.state === "reaped") {
    return { action: "gc", reason: `이미 reaped — 엔트리 정리(${ownerNote})` };
  }

  // 3. live/leaked — pgid 알려짐.
  if (entry.state === "live" || entry.state === "leaked") {
    const pgid = entry.pgid;
    if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) {
      // 스키마상 도달 불가(parse/register 가 막는다)지만, 손상 원장 방어 — 유효 pgid 없이는 신호하지 않는다.
      return { action: "refuse", reason: `state=${entry.state} 인데 유효 pgid 부재(손상 엔트리) — 신호 거부(${ownerNote})` };
    }
    const members = procView.groupMembers(pgid);
    if (members.length === 0) {
      // ESRCH — 그룹이 이미 소멸했다. 회수할 게 없으니 정리(gc). (pgid 재사용 위험은 여기 없다 — 없는 그룹이다.)
      return { action: "gc", reason: `pgid=${pgid} 그룹 부재(ESRCH·이미 소멸) — 정리(${ownerNote})` };
    }
    // nonce 검증 — 구성원 중 하나라도 exec-env 에 우리 nonce 를 지녔거나, scanByEnv 가 이 pgid 를 돌려주면 우리 그룹.
    const verified =
      members.some((pid) => procView.execEnvHas(pid, SESSION_NONCE_ENV, entry.nonce)) ||
      procView.scanByEnv(SESSION_NONCE_ENV, entry.nonce).includes(pgid);
    if (verified) {
      // nonce 를 **동봉**한다 — 데몬이 kill(-pgid) 직전에 이 값으로 재검증해 판정→신호 사이 PID 재사용 창을 좁힌다
      //   (여기 verified 는 '판정 시점' 검증일 뿐, '신호해도 됨'의 최종 보증이 아니다 · 헤더 daemon-MUST 참조).
      return { action: "kill", pgid, nonce: entry.nonce, reason: `nonce 일치 확인 — 그룹(${pgid}) 회수(${ownerNote})` };
    }
    // ★ PID 재사용 안전 케이스 ★ — pgid 는 살아있으나 그 그룹의 exec-env 에 우리 nonce 가 **없다**. 커널이 이 pgid
    //   숫자를 무관한 다른 그룹에 재배정했다는 뜻이다. 맨몸 pgid 를 믿고 신호하면 **엉뚱한 프로세스를 죽인다** —
    //   그래서 **거부**한다. 이 한 줄이 옛 raw-PID 하트비트가 못 막던 재앙을 닫는다.
    return {
      action: "refuse",
      reason: `nonce 불일치 — pgid=${pgid} 는 재사용된 무관 그룹(exec-env 에 우리 nonce 없음) → 신호 거부(무관 프로세스 오kill 방지)`,
    };
  }

  // 4. spawning — pgid 미확정(register-lag 창). nonce 로 스캔해 그룹을 찾는다.
  const found = procView.scanByEnv(SESSION_NONCE_ENV, entry.nonce);
  if (found.length > 0) {
    // 스캔은 **발견(discovery) 전용**이다 — 우리 nonce 를 지닌 그룹을 '찾았다'는 사실이 nonce-free kill 을 허락하지
    //   않는다. 데몬은 동봉된 nonce 로 **발견된 각 pgid 를 신호 직전 재검증**한 뒤에만 회수한다(판정≠신호 · 재사용 창
    //   최소화 · 헤더 daemon-MUST 참조). 스캔 결과를 '검증 완료'로 오독하지 말 것.
    return {
      action: "scan-then-kill",
      nonce: entry.nonce,
      pgids: found,
      reason: `spawning: nonce 스캔이 그룹(${found.join(",")}) 발견(discovery) — 신호 직전 pgid별 nonce 재검증 후 회수(${ownerNote})`,
    };
  }
  // 못 찾음 — killAt+여유를 넘겼으면 그 의도는 결국 아무 그룹도 안 낳았다고 보고 정리(gc). 아직 창 안이면 대기(wait).
  if (supervisorState.nowMs >= entry.killAtMs + REGISTER_LAG_MARGIN_MS) {
    return {
      action: "gc",
      reason: `spawning: nonce 스캔 무발견 + killAt+${REGISTER_LAG_MARGIN_MS}ms 초과 — 미발생 의도 정리(${ownerNote})`,
    };
  }
  return {
    action: "wait",
    reason: `spawning: nonce 스캔 무발견이나 아직 register-lag 창 안(killAt+여유 이전) — 대기(${ownerNote})`,
  };
}
