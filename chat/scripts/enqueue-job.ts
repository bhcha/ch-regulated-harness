/**
 * enqueue-job.ts — 무인 소비자 데몬(W4) **사람 검증용** 최소 적재 도구.
 *
 * 봇(Slack) 전체를 띄우지 않고도 데몬에 실 생성 잡 1건을 넣어 라이브 검증할 수 있게 한다. 봇의 1급 적재
 *   경로(`enqueueJob` = 원자 대체)를 **그대로** 쓰므로, 사람 검증이 실제 운영 경로와 갈라지지 않는다.
 *
 * 실행:
 *   HARNESS_ROOT=/path/to/core pnpm enqueue-job <run_id> <stage> [대기상한초]
 *   예) HARNESS_ROOT=… pnpm enqueue-job my-run-0719 intake
 *
 * ⚠ 이건 **검증 보조 도구**다(운영 봇 아님). 데몬이 이 잡을 집으려면 그 run 이 **지금 그 stage 생성 차례**여야
 *   한다(데몬의 2중 검사). 런북: docs/reference/daemon-live-verification-runbook.md.
 *   ⚠ 적재만 한다 — state.json 을 건드리지 않는다(잡 파일만 만든다).
 */
import { enqueueJob } from "../src/kernel/job-protocol.js";
import { bridgeTimeout, storagePaths } from "../src/config.js";

async function main(): Promise<void> {
  const [rid, stage, timeoutArg] = process.argv.slice(2);
  if (rid === undefined || stage === undefined) {
    process.stderr.write(
      "사용법: pnpm enqueue-job <run_id> <stage> [대기상한초]\n" +
        "  예) pnpm enqueue-job my-run-0719 intake\n" +
        "  stage 는 run-stage 인자(intake·brief …)이지 페이즈 이름(00a-intake)이 아닙니다.\n",
    );
    process.exit(2);
    return;
  }
  const timeoutMs = timeoutArg !== undefined ? Math.round(Number(timeoutArg) * 1000) : bridgeTimeout();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(`대기상한초 값이 올바르지 않습니다: "${timeoutArg}" — 초 단위 양수여야 합니다.\n`);
    process.exit(2);
    return;
  }

  const paths = storagePaths();
  const res = await enqueueJob(
    { pending: paths.jobsPending, claimed: paths.jobsClaimed },
    { run_id: rid, stage, timeoutMs },
    { now: () => Date.now() },
  );

  if (res.ok) {
    process.stdout.write(
      `적재됨: ${res.path}\n` +
        `  run_id=${res.job.run_id} stage=${res.job.stage} job_id=${res.job.job_id}\n` +
        `  expires_at=${res.job.expires_at}(적재+${Math.round(timeoutMs / 1000)}초)\n` +
        `이제 데몬을 기동하세요: CHAT_SDK_STAGES=${stage} pnpm worker\n`,
    );
    process.exit(0);
  } else {
    // in_progress = 이미 마감 남은 소비자가 집고 있음 · unknown = 판정 불가(fail-closed)
    process.stderr.write(
      `적재하지 않았습니다(사유=${res.reason}).\n` +
        (res.reason === "in_progress"
          ? "  같은 run·stage 를 이미 누가 집어 작업 중입니다(마감 남음). 그 소비가 끝난 뒤 다시 시도하세요.\n"
          : "  산 클레임 여부를 판정하지 못했습니다(권한·IO). jobs/ 경로·권한을 확인하세요.\n"),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`적재 오류: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
