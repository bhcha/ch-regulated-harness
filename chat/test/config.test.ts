/**
 * config.test.ts — config.ts 순수 헬퍼 검증(결정적 · env 조작만).
 *
 * 여기서 고정하는 규약은 둘이다.
 *   ① '초 단위 env → ms 상한' 세 함수(nlCliTimeout·bridgeTimeout·sdkGenTimeout)의 **미설정=기본 / 명시 오설정=예외**:
 *      아무 것도 안 정했으면 안전한 기본을 주되, `30m` 같은 오타가 조용히 기본값(= 운영자가 정한 적 없는 예산)으로
 *      읽히면 안 된다. 유효한 양수인데 서브초면 하한 1000ms 로 clamp 한다 — 멈춘 CLI 를 항상 kill 할 수 있고
 *      (nlCliTimeout), 적재된 잡을 누군가는 집을 수 있어야(bridgeTimeout) 하기 때문.
 *   ② 턴 상한(sdkMaxTurns)은 clamp 가 아니라 **예외**(이산량이라 바닥 아래에 '진짜 값'이 없다).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  demoKeyvisualDir,
  stubSlackDemo,
  WORKER_STARTUP_MARGIN_MS,
  bridgeTimeout,
  nlCliTimeout,
  reviewRetryBackoffMs,
  reviewRetryMax,
  sdkConsumerId,
  sdkDailyJobCap,
  sdkGenTimeout,
  sdkMaxTurns,
  sdkPollIntervalMs,
  sdkStages,
  storagePaths,
  validateWorkerTimeouts,
} from "../src/config.js";

const ENV = "CHAT_NL_CLI_TIMEOUT";
const BRIDGE_ENV = "CHAT_BRIDGE_TIMEOUT";
const GEN_ENV = "CHAT_SDK_GEN_TIMEOUT";
const TURNS_ENV = "CHAT_SDK_MAX_TURNS";
const STAGES_ENV = "CHAT_SDK_STAGES";

/** env 를 세팅(undefined 면 삭제)하고 nlCliTimeout() 을 부른다. */
function withTimeoutEnv(value: string | undefined): number {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  return nlCliTimeout();
}

/** env 를 세팅(undefined 면 삭제)하고 bridgeTimeout() 을 부른다. */
function withBridgeEnv(value: string | undefined): number {
  if (value === undefined) delete process.env[BRIDGE_ENV];
  else process.env[BRIDGE_ENV] = value;
  return bridgeTimeout();
}

describe("nlCliTimeout — 초→ms 변환 + 하한 1초 clamp(미설정=기본 120000 · 명시 오설정=예외)", () => {
  afterEach(() => {
    delete process.env[ENV]; // 다른 테스트에 새지 않게 정리
  });

  it('서브초("0.0001")는 0 으로 반올림되지 않고 하한 1000ms 로 clamp(유효한 양수라 예외 아님)', () => {
    expect(withTimeoutEnv("0.0001")).toBe(1000);
  });

  it("미설정(unset) → 기본 120000ms", () => {
    expect(withTimeoutEnv(undefined)).toBe(120000);
  });

  it('빈 문자열("") → 미설정과 동일 취급 → 기본 120000ms', () => {
    expect(withTimeoutEnv("")).toBe(120000);
  });

  it('정상값("300"초) → 300000ms', () => {
    expect(withTimeoutEnv("300")).toBe(300000);
  });

  it('명시 오설정("0"·"-5"·"abc") → 예외(조용한 기본값 폴백 아님)', () => {
    expect(() => withTimeoutEnv("0")).toThrow(/CHAT_NL_CLI_TIMEOUT/);
    expect(() => withTimeoutEnv("-5")).toThrow(/CHAT_NL_CLI_TIMEOUT/);
    expect(() => withTimeoutEnv("abc")).toThrow(/초 단위 양수/);
  });
});

describe("bridgeTimeout — 하드코딩 600초의 env 승격(기본 900초 · 잡 expires_at 의 원천)", () => {
  afterEach(() => {
    delete process.env[BRIDGE_ENV];
  });

  it("미설정(unset) → 기본 900000ms(=900초) — 구 하드코딩 600000ms 아님", () => {
    expect(withBridgeEnv(undefined)).toBe(900_000);
  });

  it('정상값("600"초) → 600000ms', () => {
    expect(withBridgeEnv("600")).toBe(600_000);
  });

  it('명시 오설정(숫자 아님·0·음수·단위 접미사) → 예외 — 봇·소비자가 "운영자가 정한 적 없는 마감"을 공유하지 않게', () => {
    expect(() => withBridgeEnv("abc")).toThrow(/CHAT_BRIDGE_TIMEOUT/);
    expect(() => withBridgeEnv("0")).toThrow(/CHAT_BRIDGE_TIMEOUT/);
    expect(() => withBridgeEnv("-5")).toThrow(/CHAT_BRIDGE_TIMEOUT/);
    expect(() => withBridgeEnv("15m")).toThrow(/초 단위 양수/);
  });

  it('서브초("0.0001")는 하한 1000ms 로 clamp(적재되자마자 만료돼 아무도 못 집는 상황 방지)', () => {
    expect(withBridgeEnv("0.0001")).toBe(1000);
  });
});

describe("sdkGenTimeout — 잡 1건 wall-clock 예산(초→ms · 기본 480초)", () => {
  afterEach(() => {
    delete process.env[GEN_ENV];
  });

  it("미설정(unset) → 기본 480000ms(=480초)", () => {
    delete process.env[GEN_ENV];
    expect(sdkGenTimeout()).toBe(480_000);
  });

  it('정상값("600"초) → 600000ms — 초 단위 env 를 ms 로 돌려준다', () => {
    process.env[GEN_ENV] = "600";
    expect(sdkGenTimeout()).toBe(600_000);
  });

  it('빈 문자열("") → 미설정과 동일 취급 → 기본 480000ms', () => {
    process.env[GEN_ENV] = "";
    expect(sdkGenTimeout()).toBe(480_000);
  });

  it('명시 오설정("30m") → 예외 — 오타가 조용히 8분 예산을 승인해주던 자리(무인·과금 경로)', () => {
    process.env[GEN_ENV] = "30m";
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
    expect(() => sdkGenTimeout()).toThrow(/초 단위 양수/);
  });

  // ★ 입력은 유한한데 **환산 결과**가 Infinity 인 자리(1e308 × 1000). 예전엔 여기서 안 끊겨 기동이 성공하고
  //   첫 잡 적재의 `new Date(now + Infinity).toISOString()` 이 RangeError 로 터졌다 — '명시 오설정은 기동 시
  //   중단'의 정반대(운영자는 봇이 뜬 걸 보고 설정이 맞다고 믿는다). 그래서 환산 후를 본다.
  it("유한 입력이지만 환산 결과가 Date 범위 밖 → 기동 시 예외(첫 적재 때 RangeError 로 미루지 않는다)", () => {
    process.env[GEN_ENV] = "1e308"; // ×1000 = Infinity
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
    expect(() => sdkGenTimeout()).toThrow(/너무 큽니다/);
    process.env[GEN_ENV] = String(60 * 60 * 24 * 31); // 31일 — 2^31−1ms(≈24.8일) 상한 초과
    expect(() => sdkGenTimeout()).toThrow(/너무 큽니다/);
    // 2^31−1ms 초과 ~ 옛 30일 상한 사이(예 25일): Node setTimeout 이 1ms 로 clamp 하는 구간 — 통과시키면
    //   몇 주 백오프가 즉시 재시도로 붕괴하므로 여기서 끊는다(타이머로 못 그리는 상한은 상한이 아니다).
    process.env[GEN_ENV] = String(60 * 60 * 24 * 25); // 25일 > 2^31−1ms
    expect(() => sdkGenTimeout()).toThrow(/너무 큽니다/);
  });

  it("상한(2^31−1ms ≈ 24.8일) 이내의 큰 값은 정상 통과 — 상한은 표현 가드지 업무 정책이 아니다", () => {
    process.env[GEN_ENV] = String(60 * 60 * 24 * 24); // 24일 < 2^31−1ms
    expect(sdkGenTimeout()).toBe(24 * 24 * 60 * 60 * 1000);
  });

  it('명시 오설정(숫자 아님·0·음수·공백뿐) → 예외(기본값 폴백 아님)', () => {
    process.env[GEN_ENV] = "abc";
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
    process.env[GEN_ENV] = "0";
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
    process.env[GEN_ENV] = "-5";
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
    process.env[GEN_ENV] = "   "; // 공백뿐 = 빈값이 아니라 오타로 본다(Number("   ")===0 이라 조용히 통과하던 값)
    expect(() => sdkGenTimeout()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
  });

  it('서브초("0.0001")는 하한 1000ms 로 clamp(예산 0=즉시 kill 방지) — 유효한 양수는 예외 아님', () => {
    process.env[GEN_ENV] = "0.0001";
    expect(sdkGenTimeout()).toBe(1000);
  });

  it('소수 초("1.5") → 1500ms — 시간은 이산량이 아니라 소수도 진짜 값이다(턴 상한과 대비)', () => {
    process.env[GEN_ENV] = "1.5";
    expect(sdkGenTimeout()).toBe(1500);
  });
});

describe("sdkMaxTurns — 폭주 세션 턴 천장(미설정=기본 50 · 명시 오설정=예외 · clamp/반올림 없음)", () => {
  afterEach(() => {
    delete process.env[TURNS_ENV];
  });

  it("미설정(unset) → 기본 50", () => {
    delete process.env[TURNS_ENV];
    expect(sdkMaxTurns()).toBe(50);
  });

  it('빈 문자열("") → 미설정과 동일 취급 → 기본 50', () => {
    process.env[TURNS_ENV] = "";
    expect(sdkMaxTurns()).toBe(50);
  });

  it('정상값("10") → 10', () => {
    process.env[TURNS_ENV] = "10";
    expect(sdkMaxTurns()).toBe(10);
  });

  it('숫자로 위장한 오타("5O" — 알파벳 O) → 예외(조용히 50 이 되던 자리)', () => {
    process.env[TURNS_ENV] = "5O";
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
    expect(() => sdkMaxTurns()).toThrow(/1 이상의 정수/);
  });

  it('숫자 아님("abc")·공백뿐("   ") → 예외', () => {
    process.env[TURNS_ENV] = "abc";
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
    process.env[TURNS_ENV] = "   "; // Number("   ")===0 → 0 턴이 아니라 오타로 본다
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
  });

  it('하한 미만("0"·"-3") → 예외 — 0 턴은 "빡빡한 예산"이 아니라 오타다(1 로 clamp 하지 않는다)', () => {
    process.env[TURNS_ENV] = "0";
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
    process.env[TURNS_ENV] = "-3";
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
  });

  // isInteger 는 참인데 Number 로 읽으며 …992 로 깎이는 값. 지어내지 않는다는 같은 규칙이라 예외로 끊는다.
  it("안전 정수 밖(9007199254740993) → 예외 — 정밀도가 깎인 '다른 값'을 턴 상한으로 돌려주지 않는다", () => {
    process.env.CHAT_SDK_MAX_TURNS = "9007199254740993";
    expect(() => sdkMaxTurns()).toThrow(/CHAT_SDK_MAX_TURNS/);
  });

  it('정수 아님("7.6") → 예외 — 턴은 이산량이라 8 로 반올림해 지어내지 않는다', () => {
    process.env[TURNS_ENV] = "7.6";
    expect(() => sdkMaxTurns()).toThrow(/1 이상의 정수/);
  });
});

describe("sdkStages — 무인 enablement 목록(기본 off · 안전하지 않은 단계명은 fail-fast)", () => {
  afterEach(() => {
    delete process.env[STAGES_ENV];
  });

  it("미설정(unset) → 빈 배열 = 어느 단계도 무인 아님(fail-closed 기본)", () => {
    delete process.env[STAGES_ENV];
    expect(sdkStages()).toEqual([]);
  });

  it("빈 문자열 → 빈 배열", () => {
    process.env[STAGES_ENV] = "";
    expect(sdkStages()).toEqual([]);
  });

  it("콤마분리 파싱 + 공백 trim + 빈 항목 드롭 — 값은 잡의 stage 네임스페이스(run-stage 인자)", () => {
    process.env[STAGES_ENV] = " intake , brief ,, concept ";
    expect(sdkStages()).toEqual(["intake", "brief", "concept"]);
  });

  it("무인 지원 단계(intake·brief)를 그대로 낸다 — 데몬이 잡의 stage 문자열과 직접 비교하는 값", () => {
    process.env[STAGES_ENV] = "intake,brief";
    expect(sdkStages()).toEqual(["intake", "brief"]);
  });

  it("경로 탈출 토큰(../evil) → 예외(조용히 드롭하지 않는다 — 단계명은 파일경로 세그먼트)", () => {
    process.env[STAGES_ENV] = "brief,../evil";
    expect(() => sdkStages()).toThrow(/CHAT_SDK_STAGES/);
  });

  it("페이즈 이름(00a-intake)은 문법상 통과 — 문법 검사는 '파일명 안전'일 뿐 '무인 지원' 판정이 아니다", () => {
    // 경계 명시: config 는 바닥 계층이라 SUPPORTED_STAGES 를 import 하지 않는다(순환 회피).
    //   페이즈 이름을 적는 오설정은 여기서 못 막으므로, 안내 문구가 올바른 네임스페이스(intake·brief)를 예시로 든다.
    process.env[STAGES_ENV] = "00a-intake";
    expect(sdkStages()).toEqual(["00a-intake"]);
  });

  it("안내 문구는 잡 stage 네임스페이스를 예시로 든다(페이즈 이름 00a-intake·01-brief 아님)", () => {
    process.env[STAGES_ENV] = "a/b";
    expect(() => sdkStages()).toThrow(/예: intake,brief/);
  });

  it("슬래시 포함(a/b) → 예외", () => {
    process.env[STAGES_ENV] = "a/b";
    expect(() => sdkStages()).toThrow(/안전하지 않은 단계명/);
  });

  it("대문자(UPPER) → 예외(job-protocol 의 SAFE_STAGE 와 동일 규칙 — 영소문자·숫자·하이픈만)", () => {
    process.env[STAGES_ENV] = "UPPER";
    expect(() => sdkStages()).toThrow(/CHAT_SDK_STAGES/);
  });
});

describe("validateWorkerTimeouts — 세션 예산 + 기동 여유 ≤ 봇 대기 상한", () => {
  afterEach(() => {
    delete process.env[GEN_ENV];
    delete process.env[BRIDGE_ENV];
  });

  it("기본값(480초 + 여유 ≤ 900초) → ok(사유 없음)", () => {
    delete process.env[GEN_ENV];
    delete process.env[BRIDGE_ENV];
    expect(validateWorkerTimeouts()).toEqual({ ok: true });
  });

  it("세션 예산을 봇 대기 상한 이상으로 올리면 → ok=false + 평이한 한국어 사유", () => {
    process.env[BRIDGE_ENV] = "900";
    process.env[GEN_ENV] = "900";
    const r = validateWorkerTimeouts();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CHAT_SDK_GEN_TIMEOUT/);
    expect(r.reason).toMatch(/CHAT_BRIDGE_TIMEOUT/);
  });

  it("상한에 '근접'해도(여유만큼 못 남기면) 위반 — 딱 붙여 잡는 설정을 잡아낸다", () => {
    process.env[BRIDGE_ENV] = "900";
    process.env[GEN_ENV] = "880"; // 880 + 60 = 940 > 900
    expect(validateWorkerTimeouts().ok).toBe(false);
  });

  it("경계: 여유를 정확히 남기면 ok, 1초라도 더 쓰면 위반", () => {
    process.env[BRIDGE_ENV] = "900";
    const marginSec = WORKER_STARTUP_MARGIN_MS / 1000;
    process.env[GEN_ENV] = String(900 - marginSec);
    expect(validateWorkerTimeouts().ok).toBe(true);
    process.env[GEN_ENV] = String(900 - marginSec + 1);
    expect(validateWorkerTimeouts().ok).toBe(false);
  });

  it("env 오설정은 {ok:false} 로 삼키지 않고 getter 예외를 그대로 올린다(관계 위반과 구별)", () => {
    // 이 검사기의 판정 대상은 '잘 읽힌 두 값의 관계'다. 못 읽는 값은 관계 위반이 아니라 설정 오류라,
    //   fail-fast 를 드러내야 할 자리에서 되레 삼키지 않도록 예외를 통과시킨다.
    process.env[BRIDGE_ENV] = "900";
    process.env[GEN_ENV] = "30m";
    expect(() => validateWorkerTimeouts()).toThrow(/CHAT_SDK_GEN_TIMEOUT/);
  });
});

describe("storagePaths — 잡 큐 3면(pending/claimed/failed)", () => {
  it("jobs 루트 아래 pending·claimed·failed 절대경로를 낸다(프로토콜 v2 수명주기 디렉터리)", () => {
    const p = storagePaths();
    expect(p.jobsPending).toBe(`${p.jobs}/pending`);
    expect(p.jobsClaimed).toBe(`${p.jobs}/claimed`);
    expect(p.jobsFailed).toBe(`${p.jobs}/failed`);
  });
});

describe("sdkPollIntervalMs — 데몬 폴링 간격(초→ms · 기본 5000 · 하한 1초 clamp)", () => {
  afterEach(() => {
    delete process.env.CHAT_SDK_POLL_INTERVAL;
  });

  it("미설정 → 기본 5000ms", () => {
    delete process.env.CHAT_SDK_POLL_INTERVAL;
    expect(sdkPollIntervalMs()).toBe(5000);
  });

  it("초 → ms 변환", () => {
    process.env.CHAT_SDK_POLL_INTERVAL = "10";
    expect(sdkPollIntervalMs()).toBe(10_000);
  });

  it("서브초 → 하한 1000ms clamp(0 간격 타이트루프 방지)", () => {
    process.env.CHAT_SDK_POLL_INTERVAL = "0.1";
    expect(sdkPollIntervalMs()).toBe(1000);
  });

  it("명시 오설정(30m) → 예외", () => {
    process.env.CHAT_SDK_POLL_INTERVAL = "30m";
    expect(() => sdkPollIntervalMs()).toThrow(/CHAT_SDK_POLL_INTERVAL/);
  });
});

describe("sdkDailyJobCap — 잡 수 상한(기본 20 · 정수 · 명시 오설정=예외)", () => {
  afterEach(() => {
    delete process.env.CHAT_SDK_DAILY_JOB_CAP;
  });

  it("미설정 → 기본 20", () => {
    delete process.env.CHAT_SDK_DAILY_JOB_CAP;
    expect(sdkDailyJobCap()).toBe(20);
  });

  it("정수 → 그대로", () => {
    process.env.CHAT_SDK_DAILY_JOB_CAP = "5";
    expect(sdkDailyJobCap()).toBe(5);
  });

  it("0·소수·오타 → 예외(clamp·반올림 없음 — sdkMaxTurns 와 같은 규칙)", () => {
    process.env.CHAT_SDK_DAILY_JOB_CAP = "0";
    expect(() => sdkDailyJobCap()).toThrow(/CHAT_SDK_DAILY_JOB_CAP/);
    process.env.CHAT_SDK_DAILY_JOB_CAP = "2.5";
    expect(() => sdkDailyJobCap()).toThrow(/1 이상의 정수/);
    process.env.CHAT_SDK_DAILY_JOB_CAP = "2O";
    expect(() => sdkDailyJobCap()).toThrow(/CHAT_SDK_DAILY_JOB_CAP/);
  });
});

describe("sdkConsumerId — 무인 소비자 id(기본 daemon · 안전 토큰 · 점 세그먼트 거부)", () => {
  afterEach(() => {
    delete process.env.CHAT_SDK_CONSUMER_ID;
  });

  it("미설정 → 안정 기본 'daemon'(pid 무관 — 재기동 간 자기 지난 클레임을 찾기 위함)", () => {
    delete process.env.CHAT_SDK_CONSUMER_ID;
    expect(sdkConsumerId()).toBe("daemon");
  });

  it("안전 토큰 → 그대로", () => {
    process.env.CHAT_SDK_CONSUMER_ID = "op-chabh_2";
    expect(sdkConsumerId()).toBe("op-chabh_2");
  });

  it("빈 문자열 → 미설정 취급 → 기본 'daemon'(readEnv 규약)", () => {
    process.env.CHAT_SDK_CONSUMER_ID = "";
    expect(sdkConsumerId()).toBe("daemon");
  });

  it("점 세그먼트('.'·'..')·경로문자(/)·64자 초과 → 예외(claimed/<id>/ 디렉터리명 안전)", () => {
    for (const bad of [".", "..", "a/b", "x".repeat(65)]) {
      process.env.CHAT_SDK_CONSUMER_ID = bad;
      expect(() => sdkConsumerId()).toThrow(/CHAT_SDK_CONSUMER_ID/);
    }
  });
});

describe("reviewRetryMax — 자동 리뷰 재적재 최대 횟수(기본 2 · 0 허용 · 명시 오설정=예외)", () => {
  afterEach(() => {
    delete process.env.CHAT_REVIEW_RETRY;
  });

  it("미설정(unset) → 기본 2(= 총 3회 시도)", () => {
    delete process.env.CHAT_REVIEW_RETRY;
    expect(reviewRetryMax()).toBe(2);
  });

  it('빈 문자열("") → 미설정과 동일 취급 → 기본 2', () => {
    process.env.CHAT_REVIEW_RETRY = "";
    expect(reviewRetryMax()).toBe(2);
  });

  it('정상값("5") → 5', () => {
    process.env.CHAT_REVIEW_RETRY = "5";
    expect(reviewRetryMax()).toBe(5);
  });

  it('0 은 유효값 — 자동 재시도 끔(기존 시나리오를 0 회 재시도로 재현, sdkMaxTurns 와 달리 하한 0)', () => {
    process.env.CHAT_REVIEW_RETRY = "0";
    expect(reviewRetryMax()).toBe(0);
  });

  it('음수("-1") → 예외(0=끔은 되지만 음수는 오타)', () => {
    process.env.CHAT_REVIEW_RETRY = "-1";
    expect(() => reviewRetryMax()).toThrow(/CHAT_REVIEW_RETRY/);
    expect(() => reviewRetryMax()).toThrow(/0 이상의 정수/);
  });

  it('공백뿐("   ") → 예외 — Number("   ")===0 을 "명시적 끔(0)"으로 조용히 수용하면 복구 동작이 말없이 꺼진다', () => {
    process.env.CHAT_REVIEW_RETRY = "   ";
    expect(() => reviewRetryMax()).toThrow(/CHAT_REVIEW_RETRY/);
    expect(() => reviewRetryMax()).toThrow(/0 이상의 정수/);
  });

  it('정수 아님("2.5") → 예외(반올림해 지어내지 않는다)', () => {
    process.env.CHAT_REVIEW_RETRY = "2.5";
    expect(() => reviewRetryMax()).toThrow(/0 이상의 정수/);
  });

  it('숫자 아님("x")·숫자 위장("2O") → 예외', () => {
    process.env.CHAT_REVIEW_RETRY = "x";
    expect(() => reviewRetryMax()).toThrow(/CHAT_REVIEW_RETRY/);
    process.env.CHAT_REVIEW_RETRY = "2O"; // 알파벳 O
    expect(() => reviewRetryMax()).toThrow(/CHAT_REVIEW_RETRY/);
  });
});

describe("reviewRetryBackoffMs — 재적재 백오프(초 콤마목록→ms 배열 · 기본 [60000,300000] · 원소 규칙=timeoutEnvMs)", () => {
  afterEach(() => {
    delete process.env.CHAT_REVIEW_RETRY_BACKOFF;
  });

  it("미설정(unset) → 기본 [60000, 300000](= '60,300')", () => {
    delete process.env.CHAT_REVIEW_RETRY_BACKOFF;
    expect(reviewRetryBackoffMs()).toEqual([60_000, 300_000]);
  });

  it('빈 문자열("") → 미설정과 동일 취급 → 기본 [60000, 300000]', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "";
    expect(reviewRetryBackoffMs()).toEqual([60_000, 300_000]);
  });

  it('정상값("30,90") → [30000, 90000] — 각 원소 초→ms', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "30,90";
    expect(reviewRetryBackoffMs()).toEqual([30_000, 90_000]);
  });

  it("단일 원소도 배열로 낸다", () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "120";
    expect(reviewRetryBackoffMs()).toEqual([120_000]);
  });

  it('서브초 원소("0.5,90")는 하한 1000ms 로 clamp(0ms 백오프면 대기가 사라진다)', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "0.5,90";
    expect(reviewRetryBackoffMs()).toEqual([1000, 90_000]);
  });

  it('빈 원소("60,,300") → 예외(조용히 드롭하지 않는다)', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "60,,300";
    expect(() => reviewRetryBackoffMs()).toThrow(/CHAT_REVIEW_RETRY_BACKOFF/);
  });

  it('음수 원소("60,-5") → 예외', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "60,-5";
    expect(() => reviewRetryBackoffMs()).toThrow(/CHAT_REVIEW_RETRY_BACKOFF/);
    expect(() => reviewRetryBackoffMs()).toThrow(/초 단위 양수/);
  });

  it('비수치 원소("60,abc") → 예외', () => {
    process.env.CHAT_REVIEW_RETRY_BACKOFF = "60,abc";
    expect(() => reviewRetryBackoffMs()).toThrow(/CHAT_REVIEW_RETRY_BACKOFF/);
  });
});

describe("stubSlackDemo — 데모(촬영) 모드 플래그(CHAT_STUB_SLACK=1 만 true)", () => {
  afterEach(() => {
    delete process.env.CHAT_STUB_SLACK;
  });
  it("미설정 → false(기본 · 프로덕션 offline 거부 유지)", () => {
    delete process.env.CHAT_STUB_SLACK;
    expect(stubSlackDemo()).toBe(false);
  });
  it('"1" → true(데모 허용)', () => {
    process.env.CHAT_STUB_SLACK = "1";
    expect(stubSlackDemo()).toBe(true);
  });
  it('"0"·"true"·빈 값 → false(오직 "1" 만 켠다)', () => {
    for (const v of ["0", "true", ""]) {
      process.env.CHAT_STUB_SLACK = v;
      expect(stubSlackDemo()).toBe(false);
    }
  });
});

describe("demoKeyvisualDir — 데모 키비주얼 이미지 소스 경로(CHAT_DEMO_KV_IMAGES)", () => {
  afterEach(() => {
    delete process.env.CHAT_DEMO_KV_IMAGES;
  });
  it("미설정/빈 값 → undefined(기존 run 산출물 경로 사용)", () => {
    delete process.env.CHAT_DEMO_KV_IMAGES;
    expect(demoKeyvisualDir()).toBeUndefined();
    process.env.CHAT_DEMO_KV_IMAGES = "";
    expect(demoKeyvisualDir()).toBeUndefined();
  });
  it("설정 시 그 경로를 그대로 반환", () => {
    process.env.CHAT_DEMO_KV_IMAGES = "/abs/relief-acne-e2e/04-keyvisual";
    expect(demoKeyvisualDir()).toBe("/abs/relief-acne-e2e/04-keyvisual");
  });
});
