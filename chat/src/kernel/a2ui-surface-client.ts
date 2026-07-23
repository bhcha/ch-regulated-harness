/**
 * a2ui-surface-client.ts — core `scripts/a2ui-surface.sh <rid>` 읽기 클라이언트(읽기 전용 · **best-effort**).
 *
 * 역할: 현재 게이트의 A2UI 읽기 표면(A2uiSurface)을 '읽어' 오버레이/교차검증 재료로 돌려준다.
 *   · `bash <harnessRoot>/scripts/a2ui-surface.sh <rid>` 를 spawn(cwd=harnessRoot, env=harnessEnv 병합).
 *   · stdout 한 줄 JSON 을 파싱해 A2uiSurface 로 반환(미지 top-level 필드는 index signature 로 보존).
 *
 * ⚠ contract-client(next-action.sh)와의 결정적 차이 = **파생 뷰라 실패해도 throw 하지 않는다**. next-action 은 읽기
 *   SSoT 라 안전 해석 불가 시 예외로 승격하지만, surface 는 na(주계약)의 오버레이일 뿐이라(SSoT 아님) 어떤 실패든
 *   렌더를 깨지 않고 **null 을 돌려준다** → 호출부가 na.* 기반으로 폴백한다. null 반환 케이스:
 *     · isSafeRunId 실패(빈/경로위험 rid) · harnessRoot() throw(HARNESS_ROOT 미주입) · spawn error
 *     · 비-0 종료 · 빈 출력 · JSON 파싱 실패 · JSON 이 객체 아님(배열/원시값) · rid 불일치(봉투가 다른 rid echo).
 *     · 소비 필드 형태 불일치(actions 가 string[] 아님 · ra_ok_required 가 boolean 아님 — chat/core 버전 스큐·응답 손상).
 *   형태검증 = 객체 && rid===요청rid && **소비부가 가드 없이 좁은 타입으로 읽는 필드**(actions·ra_ok_required)의 런타임 형태.
 *   비-null 을 돌려주면 소비부(approveP/optionSetP/imageOptionSetP)가 그 필드를 가드 없이 읽으므로, 형태를 여기서 보장
 *   못 하면 그 접근이 throw 해 카드가 사라진다(na 폴백이 아니라 렌더 유실 = best-effort 위반) → 그래서 null 로 환원한다.
 *   미소비 passthrough 필드는 계속 index signature 로 보존(over-tighten 금지).
 *
 * 불변식: state.json 은 core scripts 만 쓴다 — 이 모듈은 **읽기 전용**(a2ui-surface.sh 자체가 파생만, state 미접촉).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { harnessEnv, harnessRoot, isSafeRunId } from "../config.js";
import type { A2uiSurface } from "../types/a2ui.js";

/** spawn 1회 결과(종료코드·stdout·stderr). */
export interface SurfaceRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 자식 출력 스트림 상한(스트림당) — OOM/폭주 방지(contract-client 와 동일 방어). */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * 읽기 하드 상한(ms). a2ui-surface.sh 가 멈추면(디스크 스톨·좀비) `await runner` 가 영영 안 돌아와 best-effort
 *   'null 폴백'이 발동하지 못하고 승인/선택 카드 렌더가 통째로 막힌다(문서화한 '렌더 안 깸' 계약 위반). 그래서 읽기를
 *   이 시간으로 bound 하고(reader race → null), 실제 runner(defaultRunner)는 만료 시 자식을 kill 한다(프로세스 누수 방지).
 *   파생 뷰라 상한 초과 = 그냥 null(폴백) — na 주계약엔 영향 0.
 */
const SURFACE_READ_TIMEOUT_MS = 10_000;
/** 읽기 타임아웃 sentinel(race 승자 판별용 — SurfaceRunResult 와 구분되는 고유 값). */
const READ_TIMEOUT = Symbol("a2ui-surface-read-timeout");

/**
 * a2ui-surface.sh 실행기. 기본은 실제 **비동기** spawn(defaultRunner). 테스트는 fake 를 주입해
 * spawn 없이 파싱/폴백 분기를 결정적으로 검증한다(실 core spawn 금지).
 */
export type SurfaceRunner = (rid: string) => Promise<SurfaceRunResult>;

/** 실제 비동기 spawn: `bash <harnessRoot>/scripts/a2ui-surface.sh <rid>` (이벤트 루프 블로킹 금지 — spawnSync 아님). */
function defaultRunner(rid: string): Promise<SurfaceRunResult> {
  // harnessRoot() 는 HARNESS_ROOT 미주입 시 throw 한다 — 동기 throw 는 readA2uiSurface 의 try 가 흡수해 null 로 폴백한다.
  const root = harnessRoot();
  const script = join(root, "scripts", "a2ui-surface.sh");
  return new Promise<SurfaceRunResult>((resolve, reject) => {
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
    // 자식 하드 상한: a2ui-surface.sh 가 멈추면 kill 해 프로세스 누수를 막는다(만료 시 close(code=null)→code:-1 → null 폴백).
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 이미 종료 */
      }
    }, SURFACE_READ_TIMEOUT_MS);
    // spawn 자체 실패(bash 부재 등)는 reject → readA2uiSurface 가 null 로 흡수(best-effort · 렌더 안 깸).
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(new Error(`a2ui-surface.sh 실행 실패(rid=${rid}): ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 현재 게이트의 A2UI 읽기 표면을 읽는다(읽기 전용 · best-effort). **어떤 실패에서도 throw 하지 않고 null 을 반환**한다
 *   (파생 뷰 — na 오버레이일 뿐이라 렌더를 깨지 않는다).
 * @param rid    run_id.
 * @param runner 실행기(기본 defaultRunner — 실제 a2ui-surface.sh spawn). 테스트가 fake 주입.
 */
export async function readA2uiSurface(
  rid: string,
  runner: SurfaceRunner = defaultRunner,
  timeoutMs: number = SURFACE_READ_TIMEOUT_MS,
): Promise<A2uiSurface | null> {
  // rid 는 a2ui-surface.sh 가 $HARNESS_ROOT/runs/$rid 경로를 만들므로 경로-안전 값만 통과(디렉터리 탈출 차단).
  if (!rid || !isSafeRunId(rid)) return null;
  let res: SurfaceRunResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 읽기를 timeoutMs 로 bound(reader race) — runner 가 멈춰도(하드 상한 넘겨 kill 되기 전까지의 창·주입 runner 의
    //   무한대기) best-effort 'null 폴백'이 반드시 발동해 렌더가 막히지 않는다. runner 동기 throw(harnessRoot 미주입)·
    //   비동기 reject(spawn error)·타임아웃 모두 여기서 null 로 흡수.
    const timeout = new Promise<typeof READ_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
    });
    const raced = await Promise.race([runner(rid), timeout]);
    if (raced === READ_TIMEOUT) return null; // 상한 초과 → null(파생 뷰 폴백 · defaultRunner 가 자식 kill).
    res = raced;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.code !== 0) return null;
  const text = res.stdout.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // 형태검증: 객체(배열/원시값 아님) && rid 가 요청과 일치.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.rid !== rid) return null;
  // 소비 필드 형태 보장(best-effort 계약의 핵심): 비-null 을 돌려주면 소비부가 surface.actions.includes(...)·
  //   surface.ra_ok_required 를 가드 없이 좁은 타입으로 읽는다. 이 필드들의 런타임 형태가 어긋나면(chat/core 버전
  //   스큐·응답 손상) 그 접근이 throw 해 카드가 사라진다(na 폴백이 아니라 렌더 유실 = best-effort 위반). 그러니
  //   여기서 형태를 보장 못 하면 null 로 환원해 소비부가 na.* 로 폴백하게 한다(검증은 이 단일 경계에서).
  //   actions = 문자열 배열(includes/iterate 대상) · ra_ok_required = boolean. 미소비 passthrough 필드는 미검증(보존).
  if (!Array.isArray(obj.actions) || obj.actions.some((a) => typeof a !== "string")) return null;
  if (typeof obj.ra_ok_required !== "boolean") return null;
  return obj as A2uiSurface;
}
