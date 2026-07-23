/**
 * agui-events-client.ts — core `scripts/agui-events.sh <rid>` 읽기 클라이언트(읽기 전용 · **best-effort**).
 *
 * 역할: AG-UI 이벤트 로그(replay)를 '읽어' **긴 생성 구간의 증분 진행 표시** 재료로 돌려준다.
 *   · `bash <harnessRoot>/scripts/agui-events.sh <rid>` 를 spawn(cwd=harnessRoot, env=harnessEnv 병합).
 *   · stdout 은 **JSONL**(이벤트당 한 줄) — 줄 단위로 split 해 각 줄 JSON.parse, 파싱 불가 줄은 조용히 스킵.
 *   · 어떤 실패(isSafeRunId 실패·harnessRoot() throw·spawn error·비-0 종료·빈 출력·전부 파싱 불가)든 **빈 배열 []**
 *     반환(throw 금지). 진행 표시는 side-channel 이라 실패해도 poll 루프·전이·마감을 흔들지 않는다.
 *
 * ⚠ contract-client(next-action.sh)와의 차이 = surface·events 처럼 **파생 뷰라 실패해도 throw 하지 않는다**. next-action 은
 *   전이 판정 SSoT 라 안전 해석 불가 시 예외로 승격하지만, agui-events 는 진행 표시 오버레이일 뿐이라(SSoT 아님) 어떤
 *   실패든 '진행 이벤트 없음'(빈 배열)으로 환원한다 → 호출부(gen-executor)가 진행 emit 을 생략한다.
 *
 * 불변식: state.json 은 core scripts 만 쓴다 — 이 모듈은 **읽기 전용**(agui-events.sh 자체가 replay 파생만, state·.events 미접촉).
 *
 * SSoT: core/scripts/lib/agui_events.py — replay() 출력 형식(JSONL)·이벤트 필드의 단일 진실.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { harnessEnv, harnessRoot, isSafeRunId } from "../config.js";
import type { AguiEvent } from "../types/a2ui.js";

/** spawn 1회 결과(종료코드·stdout·stderr). */
export interface AguiRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 자식 출력 스트림 상한(스트림당) — OOM/폭주 방지. replay 는 StateSnapshot(전체 state)을 실어 클 수 있으므로 방어적 캡. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * 읽기 하드 상한(ms). agui-events.sh 가 멈추면 `await runner` 가 안 돌아와 진행 표시 emit 이 poll 루프의 sleep 을
 *   지연시킨다(전이/마감은 절대시각이라 정확성 불변이나 응답성 저하 + 프로세스 누수). 읽기를 이 시간으로 bound 하고
 *   (reader race → []), 실제 runner 는 만료 시 자식을 kill 한다. 진행 표시 side-channel 이라 상한 초과 = '진행 이벤트 없음'.
 */
const EVENTS_READ_TIMEOUT_MS = 10_000;
/** 읽기 타임아웃 sentinel(race 승자 판별 — AguiRunResult 와 구분되는 고유 값). */
const READ_TIMEOUT = Symbol("agui-events-read-timeout");

/**
 * agui-events.sh 실행기. 기본은 실제 **비동기** spawn(defaultRunner). 테스트는 fake 를 주입해
 * spawn 없이 JSONL 파싱/폴백 분기를 결정적으로 검증한다(실 core spawn 금지).
 */
export type AguiRunner = (rid: string) => Promise<AguiRunResult>;

/** 실제 비동기 spawn: `bash <harnessRoot>/scripts/agui-events.sh <rid>` (이벤트 루프 블로킹 금지 — spawnSync 아님). */
function defaultRunner(rid: string): Promise<AguiRunResult> {
  // harnessRoot() 는 HARNESS_ROOT 미주입 시 throw 한다 — 동기 throw 는 readAguiEvents 의 try 가 흡수해 [] 로 폴백한다.
  const root = harnessRoot();
  const script = join(root, "scripts", "agui-events.sh");
  return new Promise<AguiRunResult>((resolve, reject) => {
    const child = spawn("bash", [script, rid], { cwd: root, env: { ...process.env, ...harnessEnv() } });
    let stdout = "";
    let stderr = "";
    let over = false;
    const cap = (cur: string, d: Buffer): string => {
      if (over) return cur;
      const room = MAX_OUTPUT_BYTES - cur.length;
      const s = d.toString("utf8");
      if (s.length <= room) return cur + s;
      over = true;
      child.kill();
      return cur + s.slice(0, Math.max(0, room));
    };
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    // 자식 하드 상한: agui-events.sh 가 멈추면 kill 해 프로세스 누수를 막는다(만료 시 close(code=null)→code:-1 → [] 폴백).
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 이미 종료 */
      }
    }, EVENTS_READ_TIMEOUT_MS);
    // spawn 자체 실패(bash 부재 등)는 reject → readAguiEvents 가 [] 로 흡수(best-effort · 진행 표시만 생략).
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(new Error(`agui-events.sh 실행 실패(rid=${rid}): ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * AG-UI 이벤트 스트림을 읽는다(읽기 전용 · best-effort). **어떤 실패에서도 throw 하지 않고 빈 배열 [] 을 반환**한다
 *   (진행 표시 side-channel — 실패는 '진행 이벤트 없음'으로 환원). JSONL 파싱 불가 줄은 조용히 스킵한다.
 * @param rid    run_id.
 * @param runner 실행기(기본 defaultRunner — 실제 agui-events.sh spawn). 테스트가 fake 주입.
 */
export async function readAguiEvents(
  rid: string,
  runner: AguiRunner = defaultRunner,
  timeoutMs: number = EVENTS_READ_TIMEOUT_MS,
): Promise<AguiEvent[]> {
  // rid 는 agui-events.sh 가 $HARNESS_ROOT/runs/$rid 경로를 만드므로 경로-안전 값만 통과(디렉터리 탈출 차단).
  if (!rid || !isSafeRunId(rid)) return [];
  let res: AguiRunResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 읽기를 timeoutMs 로 bound(reader race) — runner 가 멈춰도 진행 표시가 poll 루프를 무한 지연시키지 않는다.
    //   runner 동기 throw(harnessRoot 미주입)·비동기 reject(spawn error)·타임아웃 모두 [] 로 흡수(side-channel).
    const timeout = new Promise<typeof READ_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
    });
    const raced = await Promise.race([runner(rid), timeout]);
    if (raced === READ_TIMEOUT) return []; // 상한 초과 → [](진행 이벤트 없음 · defaultRunner 가 자식 kill).
    res = raced;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.code !== 0) return [];
  const out: AguiEvent[] = [];
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // 꼬리 부분 라인·오염 줄은 조용히 스킵(읽기 전용 · 복구 없음).
    }
    // 이벤트는 객체여야 한다(배열/원시값 스킵). type 이 문자열인 것만 이벤트로 인정(passthrough 는 그 위에서).
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string") continue;
    out.push(obj as AguiEvent);
  }
  return out;
}

/** 진행 표시 1건(순수 함수 산물) — 내부 스텝명 비노출 · message 만 사람에게 보인다. */
export interface LifecycleProgress {
  /** dedupe 식별자(내부 전용 · 사람 미노출). 같은 상태가 반복되면 같은 kind → 재emit 억제. */
  kind: string;
  /** 사람에게 보일 평이 한국어 코스 메시지(operator-voice — 내부 스텝명 노출 금지). */
  message: string;
  /** 이 이벤트의 timestamp(최신성 판단 · 부재 시 ""). */
  ts: string;
}

/** 진행 표시 대상 '생명주기' 이벤트 판정(StepStarted/StepFinished/RunFinished/Custom[kcia.verdict] 만). */
function isLifecycle(e: AguiEvent): boolean {
  if (e.type === "StepStarted" || e.type === "StepFinished" || e.type === "RunFinished") return true;
  if (e.type === "Custom" && e.name === "kcia.verdict") return true;
  return false;
}

/** 생명주기 이벤트 1건 → {kind, message} (평이 한국어 코스 매핑 · 내부 스텝명 비노출). 매핑 불가면 null.
 *
 * ⚠ **준법 결과 무주장(HIGH 방어)**: 진행 표시는 '아직 하고 있어요' 하트비트일 뿐, **규정 점검 결과(통과/보완/
 *   담당자확인)를 주장하지 않는다**. .events/agui.jsonl 는 insession 생성 세션이 쓸 수 있는 로그라(작업영역 쓰기 가능 ·
 *   deny 목록 밖 — core 가 append 해야 하므로) 위조·오기입이 가능하다. 여기서 "규정 점검을 통과했어요" 같은 준법
 *   '결과'를 노출하면, 실제 verdict/전이 없이도 근거 없는 준법 주장이 사람에게 보인다(규제 맥락 = 심각). 그래서
 *   kcia.verdict·review outcome 도 **결과로 가르지 않고 중립 '진행 중'** 으로만 매핑한다(kind 는 dedup 용 세분 유지).
 *   실제 준법 결과는 authoritative Verdict 카드(verdict.json·state 기반 onOutcome→verdictP)만 낸다 — 그 경로가 SSoT. */
function mapLifecycle(e: AguiEvent): { kind: string; message: string } | null {
  // kcia.verdict — 결과값(pass/revise/human)으로 문구를 가르지 않는다(준법 결과 무주장). 중립 '진행 중'만.
  if (e.type === "Custom" && e.name === "kcia.verdict") {
    return { kind: "kcia.verdict", message: "규정 점검을 진행하고 있어요 — 조금만 기다려 주세요." };
  }
  if (e.type === "RunFinished") {
    const outcome = (e.outcome ?? {}) as Record<string, unknown>;
    if (outcome.type === "success") return { kind: "run:success", message: "거의 다 됐어요 — 마무리하고 있어요." };
    // interrupt(사람 확인 게이트 도달 등) — 코스하게. 실제 게이트 카드는 전이 뒤 별도 경로가 낸다.
    return { kind: "run:interrupt", message: "계속 진행하고 있어요 — 조금만 기다려 주세요." };
  }
  // StepStarted/StepFinished — 내부 스텝명(generate:01-brief 등)은 절대 노출하지 않는다(operator-voice).
  //   kind 에만 stepName 을 실어(내부 dedupe 용) 단계가 바뀔 때 하트비트를 낸다 — 같은 단계의 start+finish 는 같은 kind 로 접힌다.
  const name = typeof e.stepName === "string" ? e.stepName : "";
  if (name.startsWith("review")) {
    // ⚠ review 스텝의 outcome(passed/revise)으로 문구를 가르지 않는다 — 준법 결과 무주장(위 근거). 중립 '진행 중'만.
    return { kind: "review:" + name, message: "규정 점검을 진행하고 있어요 — 조금만 기다려 주세요." };
  }
  return { kind: "step:" + name, message: "계속 진행하고 있어요 — 조금만 기다려 주세요." };
}

/**
 * 이벤트 배열에서 **가장 최근 생명주기 이벤트**를 골라 평이 한국어 진행 표시로 매핑한다(순수 함수 · 단위테스트 용이).
 *
 *   · '가장 최근' = timestamp 최대(문자열 = ISO 라 사전식=시간순), 동률이면 배열 뒤(=append 순서상 나중)가 이긴다.
 *   · sinceTs 를 주면 **그보다 새 이벤트가 없을 때 null**(dedupe 지원) — 단 최신 이벤트에 timestamp 가 없으면(빈 문자열)
 *     sinceTs 로 억제하지 않는다(호출부의 kind 대조가 그 경우의 중복을 막는다).
 *   · 생명주기 이벤트가 하나도 없거나 매핑 불가면 null.
 *
 * ⚠ 이 함수는 전이 신호가 아니다 — 진행 '표시' 재료만 만든다(전이 판정 SSoT 는 next-action.sh).
 */
export function latestLifecycleProgress(events: AguiEvent[], sinceTs?: string): LifecycleProgress | null {
  let best: AguiEvent | null = null;
  let bestTs = "";
  for (const e of events) {
    if (!isLifecycle(e)) continue;
    const ts = typeof e.timestamp === "string" ? e.timestamp : "";
    // ts >= bestTs 로 갱신 → 최대 timestamp, 동률이면 나중 index(더 최근)가 이긴다.
    if (best === null || ts >= bestTs) {
      best = e;
      bestTs = ts;
    }
  }
  if (best === null) return null;
  const mapped = mapLifecycle(best);
  if (mapped === null) return null;
  // dedupe: 최신 이벤트가 sinceTs 보다 새롭지 않으면 표시할 것이 없다(단 ts 가 비면 억제하지 않음 — kind 대조에 맡긴다).
  if (sinceTs && bestTs !== "" && bestTs <= sinceTs) return null;
  return { kind: mapped.kind, message: mapped.message, ts: bestTs };
}
