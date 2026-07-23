/**
 * socket-resilience.ts — 라이브 드라이버(상주 프로세스)가 **일시적 Slack 소켓모드 오류로 통째로 죽지 않도록** 하는
 *   프로세스-레벨 가드. 순수 판별 함수(테스트 가능) + 설치 함수로 분리한다(main.ts 는 import 시 main() 을 실행하는
 *   glue 라 직접 단위테스트 불가 — 판별 로직을 여기로 뽑아 검증한다).
 *
 * ── 왜 필요한가(실측) ──────────────────────────────────────────────────────────────
 *   대용량 키비주얼 이미지 업로드 중 소켓이 잠깐 not-ready 인 창에, `@chat-adapter/slack` 의 `routeSocketEvent` 가
 *   소켓 이벤트를 ack 하려다 `@slack/socket-mode` 가 던진 예외(code `slack_socket_mode_no_reply_received_error`,
 *   "client is not ready"/"no active connection")가 **unhandledRejection 으로 새어 Node 프로세스를 죽였다**.
 *   소켓모드는 스스로 재연결하므로 그 예외 하나로 런 전체가 죽을 이유가 없다 — 알려진 일시-소켓 오류면 로그만 남기고
 *   살아남는다(soft-survive). 그 외(진짜 치명적) 예외는 마스킹하지 않고 기존대로 fail-closed(비-0 종료).
 */

/** 알려진 일시-소켓 오류 code(소진 시 프로세스 유지). */
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set([
  "slack_socket_mode_no_reply_received_error",
]);

/** 알려진 일시-소켓 오류 이름. */
const TRANSIENT_SOCKET_NAMES: ReadonlySet<string> = new Set(["NoReplyReceivedError"]);

/** 알려진 일시-소켓 오류 메시지 조각(소문자 부분일치). 위 code/name 이 없을 때의 폴백 신호. */
const TRANSIENT_SOCKET_MESSAGE_HINTS: readonly string[] = [
  "client is not ready",
  "not ready", // "Failed to send a WebSocket message as the client is not ready"
  "no active connection", // "the client has no active connection"
];

/**
 * 이 예외가 **살려줘도 되는 일시적 Slack 소켓모드 오류**인가(순수 · 예외 없음). 판별은 좁게: 알려진 code·name
 *   또는 소켓 not-ready/no-connection 메시지에만 true. 그 외 임의 Error/값은 false(치명적으로 취급 = fail-closed).
 *   블랭킷 swallow 금지 — 진짜 버그를 은폐하지 않으려 알려진 신호만 통과시킨다.
 */
export function isTransientSocketError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const anyErr = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof anyErr.code === "string" && TRANSIENT_SOCKET_CODES.has(anyErr.code)) return true;
  if (typeof anyErr.name === "string" && TRANSIENT_SOCKET_NAMES.has(anyErr.name)) return true;
  const msg = typeof anyErr.message === "string" ? anyErr.message : typeof err === "string" ? err : "";
  const low = msg.toLowerCase();
  return TRANSIENT_SOCKET_MESSAGE_HINTS.some((h) => low.includes(h));
}

/** 주입 seam(테스트) — 프로세스 핸들러 등록·로그·치명 종료. 기본 = 실제 process/console/exit. */
export interface ResilienceDeps {
  /** 프로세스 이벤트 등록(기본 global process.on). */
  on?: (event: "unhandledRejection" | "uncaughtException", handler: (err: unknown) => void) => void;
  /** 일시 오류 생존 로그(기본 stderr). */
  warn?: (line: string) => void;
  /** 치명 오류 로그(기본 stderr). */
  error?: (line: string) => void;
  /** 치명 종료(기본 process.exit). */
  fatalExit?: (code: number) => void;
}

/**
 * 라이브 진입점용 견고성 가드 설치 — unhandledRejection·uncaughtException 에서 **알려진 일시-소켓 오류면 로그만
 *   남기고 살아남고**(소켓모드 자동 재연결이 다음 이벤트를 정상 처리), 그 외는 로그+비-0 종료(fail-closed, 기존
 *   `main().catch(exit 1)` 결과 일치). 소켓 연결 시작 전에 한 번 호출한다.
 */
export function installLiveResilience(deps: ResilienceDeps = {}): void {
  const on = deps.on ?? ((e, h) => process.on(e, h as (e: unknown) => void));
  const warn = deps.warn ?? ((l) => process.stderr.write(`${l}\n`));
  const error = deps.error ?? ((l) => process.stderr.write(`${l}\n`));
  const fatalExit = deps.fatalExit ?? ((c) => process.exit(c));

  const handle = (kind: string, err: unknown): void => {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (isTransientSocketError(err)) {
      warn(`[라이브] 일시적 Slack 소켓 오류 — 프로세스 유지(소켓 재연결 대기): ${detail}`);
      return; // soft-survive: 죽지 않는다.
    }
    error(`[라이브] 치명적 ${kind} — 종료합니다: ${detail}`);
    fatalExit(1); // fail-closed(알려지지 않은 예외는 마스킹하지 않는다).
  };

  on("unhandledRejection", (reason) => handle("unhandledRejection", reason));
  on("uncaughtException", (err) => handle("uncaughtException", err));
}
