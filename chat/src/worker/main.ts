/**
 * main.ts — 무인 생성 소비자 **데몬 진입점**(W4). 봇과는 **별도 프로세스**로 상주하며 `jobs/pending/` 을 소비한다.
 *
 * 실행(README '데몬 운영 규약' 참조):
 *   HARNESS_ROOT=/path/to/core CHAT_SDK_STAGES=intake,brief \
 *   CLAUDE_CODE_OAUTH_TOKEN=... pnpm worker      (= tsx src/worker/main.ts)
 *
 * ⚠ 이 파일은 실 상주 진입점이라 **단위 테스트 대상이 아니다**(index.ts 와 같은 지위 — 배선 glue). 소비·리퍼·클레임의
 *   로직은 cli-consumer.ts 의 ConsumerDaemon(전부 주입 seam)이 결정론 단위 테스트로 검증한다. 여기서는 기동 fail-fast,
 *   런타임 seam 배선(온라인 supervisor spawn), 우아한 종료(supervisor SIGTERM 먼저)만 한다.
 *
 * kernel-neutral: 어떤 챗 플랫폼도 import 하지 않는다(잡큐 파일이 유일 이음새 · kernel-neutral 가드가 src/worker/ 를 스캔).
 */
import {
  harnessRoot,
  isOffline,
  sdkStages,
  validateWorkerTimeouts,
} from "../config.js";
import {
  ConsumerDaemon,
  makeStubRunJob,
  makeSupervisorSpawnRunJob,
  type RunJobFn,
} from "./cli-consumer.js";

async function main(): Promise<void> {
  // ① 하네스(core) 경로 주입 확인 — 소비 전 fail-fast(미주입이면 어떤 잡도 못 돌린다).
  try {
    harnessRoot();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ② 시간 설정 정합 검사(sdkGenTimeout + 기동 여유 ≤ bridgeTimeout). 어기면 완주한 잡이 만료로 버려진다.
  //    env 자체 오설정(30m·5O 등)은 getter 예외가 여기서 그대로 드러난다(fail-fast).
  let timeoutCheck: ReturnType<typeof validateWorkerTimeouts>;
  try {
    timeoutCheck = validateWorkerTimeouts();
  } catch (err) {
    console.error(`설정 오류: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  if (!timeoutCheck.ok) {
    console.error(`설정 오류: ${timeoutCheck.reason}`);
    process.exit(1);
  }

  // ③ enablement 안내(비어 있으면 유휴 폴링만 — 잡을 안 집는다 · 기본 off = fail-closed).
  let stages: string[];
  try {
    stages = sdkStages();
  } catch (err) {
    console.error(`설정 오류: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const offline = isOffline();
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!offline && stages.length > 0 && (oauthToken === undefined || oauthToken === "")) {
    // 온라인·무인 켠 단계 있음인데 구독 토큰 부재 → 세션이 인증 실패로 죽는다(부록A-8). 경고만(폴링은 계속 — 잡을
    //   집으면 실패 카드로 드러난다). 기동을 막지 않는 이유: 토큰은 잡을 실제로 집을 때만 필요하고, 그전엔 유휴다.
    console.warn(
      "경고: 온라인이며 무인 단계가 켜져 있으나 CLAUDE_CODE_OAUTH_TOKEN 이 없습니다 — 세션이 인증 실패로 죽습니다(구독 토큰을 주입하세요).",
    );
  }

  // ④ 런타임 seam 배선 — 살아있는 supervisor pid 를 추적해 우아한 종료 때 SIGTERM 먼저 보낸다(잠긴 결정 4 회수 계약).
  let liveSupervisorPid: number | null = null;
  const runJob: RunJobFn = offline
    ? makeStubRunJob()
    : makeSupervisorSpawnRunJob({
        oauthToken,
        onSpawn: (pid) => {
          liveSupervisorPid = pid;
        },
        onExit: (pid) => {
          if (liveSupervisorPid === pid) liveSupervisorPid = null;
        },
      });

  const daemon = new ConsumerDaemon({ runJob });

  // ⑤ 우아한 종료 — SIGTERM/SIGINT 시: 루프 정지 → 살아있는 supervisor 에 **SIGTERM 먼저**(종료 전파가 세션 그룹을
  //    SIGKILL) → **진행 중 잡의 처분을 유예 안에서 기다린다**(claimed 고아 방지 · P1) → 소유권 리퍼 백스톱(급사로 남은
  //    그룹 nonce 검증 회수) → 종료. 맨몸 supervisor SIGKILL 은 쓰지 않는다(SIGKILL 은 트랩 불가라 종료 전파가 안 돌고
  //    세션 그룹은 별개 PGID — supervisor.ts 헤더 회수 계약).
  const SHUTDOWN_DRAIN_GRACE_MS = 20_000;
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[무인소비] ${sig} 수신 — 우아한 종료 시작.`);
    daemon.stop();
    const pid = liveSupervisorPid;
    if (pid !== null) {
      // supervisor 에 SIGTERM → 그 종료 전파가 세션 그룹을 SIGKILL 하고 supervisor 가 종료 → 자식 close 로 runJob 이
      //   resolve → runClaimed 이 잡을 처분(complete/fail)한다. 그 처분을 아래 drainInFlight 가 기다린다.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // 이미 종료됨 — 무해.
      }
    }
    try {
      // 진행 중 잡의 처분이 끝나길 유예 안에서 기다린다 — SIGTERM 을 받은 supervisor 가 곧 종료하므로 대개 즉시 끝난다.
      //   유예 초과면(supervisor 도 행) 백스톱에 맡기고 진행한다(부모 watchdog·다음 데몬 리퍼가 회수).
      const drained = await daemon.drainInFlight(SHUTDOWN_DRAIN_GRACE_MS);
      if (!drained) console.error("[무인소비] 종료: 진행 중 잡 처분을 유예 안에 마치지 못함 — 백스톱에 위임하고 종료.");
    } catch (err) {
      console.error(`[무인소비] 종료 drain 오류(무시): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      daemon.reapOwnership(); // 백스톱: supervisor 급사로 남은 leaked 그룹을 nonce 검증하 회수.
    } catch (err) {
      console.error(`[무인소비] 종료 소유권 리퍼 오류(무시): ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await daemon.start();
}

main().catch((err) => {
  console.error("[무인소비] 기동 오류:", err);
  process.exit(1);
});
