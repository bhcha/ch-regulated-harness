/**
 * main.ts — 라이브 인수 런 **운영자 진입점**(수동 게이트). 런북(docs/reference/daemon-live-verification-runbook.md)이
 *   이 파일을 부른다: `... env ... pnpm live` (= tsx src/live/main.ts).
 *
 * ⚠ **실 과금·실 서비스**: 이 진입점을 CHAT_LIVE_GO=1 로 실행하면 실 Slack 연결 + 실 생성/심의(구독·GCP·Gemini)가
 *   일어난다(런당 ~$12–20 + 이미지/심의 · 1–2.5시간). 그래서 **기본은 안전**하다 — CHAT_LIVE_GO=1 이 없으면 계획·비용을
 *   보여주고 **연결·구동 없이 종료**한다(미리보기). 실 구동은 운영자가 명시 ack(CHAT_LIVE_GO=1)로만 연다.
 *
 * ⚠ 이 파일은 실 상주/구동 진입점이라 **단위 테스트 대상이 아니다**(index.ts·worker/main.ts 와 같은 지위 — 배선 glue).
 *   재사용 조립·정책은 live-assembly/policy/tee-port/report-assembler 가 결정론 단위로 검증한다.
 *
 * platform-aware(Slack) → src/live/(kernel-neutral 스캔 밖).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actorUserId,
  approvers,
  harnessRoot,
  isApprover,
  isOffline,
  slackTokens,
  stubSlackDemo,
} from "../config.js";
import { assembleLiveBackend, liveArtifactPaths, LIVE_DAEMON_STAGES, makeRunId } from "./live-assembly.js";
import { installLiveResilience } from "./socket-resilience.js";
import { assembleJudgmentReport, defaultReader, listRunTranscripts, renderReportMarkdown } from "./report-assembler.js";

/** 기본 감사 actor(끝 세그먼트 `svc-` = 리포트 분류기가 서비스로 표기 · CHAT_APPROVERS 에 `svc-driver` 필요). */
const DEFAULT_ACTOR = "chat:live:svc-driver";

function die(msg: string): never {
  console.error(`기동 실패: ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") die(`${name} 환경변수가 필요합니다.`);
  return v!;
}

async function main(): Promise<void> {
  // ── ① fail-fast 환경 점검(연결·구동 전) ──────────────────────────────────────────
  //   기본은 offline 거부(stub 누수 방지). 단 **데모(촬영) 모드**(CHAT_STUB_SLACK=1)면 offline stub 생성을 실 Slack
  //   tee 와 함께 허용한다 — 데몬·ADK·과금 0 으로 챗 흐름을 촬영하기 위함(컴플라이언스 런 아님 · config.stubSlackDemo 주석).
  if (isOffline() && !stubSlackDemo()) die("HARNESS_OFFLINE 이 설정돼 있습니다 — 라이브는 온라인 전용입니다(stub 은 CI 전용). 해제 후 다시 실행하세요.");
  if (isOffline() && stubSlackDemo()) console.log("[라이브] ⚠ 데모(촬영) 모드 — stub 생성/심의 + 실 Slack tee(정형 문구·autopass · 컴플라이언스 런 아님).");
  try {
    harnessRoot(); // HARNESS_ROOT 주입 확인.
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const tokens = slackTokens();
  if (!tokens.botToken || !tokens.appToken) die("SLACK_BOT_TOKEN·SLACK_APP_TOKEN 이 필요합니다(Socket Mode).");
  const bundleDir = requireEnv("CHAT_BUNDLE_DIR");
  const stagedWbPath = requireEnv("CHAT_STAGED_WB");
  const threadId = requireEnv("CHAT_LIVE_THREAD");
  const mention = requireEnv("CHAT_LIVE_MENTION");
  const artifactDir = requireEnv("CHAT_LIVE_ARTIFACT_DIR");
  const actor = process.env.CHAT_LIVE_ACTOR || DEFAULT_ACTOR;
  if (!isApprover(actor)) {
    die(
      `감사 actor(${actor})가 CHAT_APPROVERS 에 없습니다 — 승인/선택 잡이 워커에서 거부됩니다. ` +
        `CHAT_APPROVERS 에 '${actorUserId(actor)}' 를 넣으세요(현재: ${approvers().join(",") || "(비어있음)"}).`,
    );
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn("경고: CLAUDE_CODE_OAUTH_TOKEN 이 없습니다 — 무인/운영자 생성 세션이 인증 실패로 죽습니다(구독 토큰 주입 권장).");
  }
  if (!process.env.ADK_COSMETICS_CRITIC_URL) {
    console.warn("경고: ADK_COSMETICS_CRITIC_URL 이 없습니다 — 화장품 심의(원격 ADK)가 설정오류 fail-closed 되거나 룰엔진-단독으로 갑니다.");
  }
  if (!process.env.HARNESS_DOMAIN) {
    // 도메인 미선언이면 core 의 심의 스폰(examples_analysis→ingest.py)이 SystemExit fail-closed 로 죽는다(guideline 심의).
    //   드라이버·데몬·운영자 세션 세 프로세스 모두에 export 돼 있어야 전파된다(예: export HARNESS_DOMAIN=cosmetic).
    console.warn("경고: HARNESS_DOMAIN 이 없습니다 — 심의 스폰(guideline 등)이 도메인 미선언 fail-closed 로 죽을 수 있습니다(예: export HARNESS_DOMAIN=cosmetic).");
  }

  const rid = makeRunId(threadId);
  // 세션 epoch 를 기동 시 한 번 떠서 아티팩트를 세션화한다(S-4) — 재기동이 옛 세션 트랜스크립트/리포트를 덮어쓰지
  //   않는다. done 도달 시엔 아래에서 세션 무관 final* 에 terminal 리포트를 따로 남긴다.
  const sessionEpoch = Date.now();
  const paths = liveArtifactPaths(artifactDir, rid, sessionEpoch);

  // ── ② 안전 게이트(기본 미리보기) — CHAT_LIVE_GO=1 없으면 계획만 보여주고 종료(연결·과금 0) ──
  if (process.env.CHAT_LIVE_GO !== "1") {
    console.log("── 라이브 인수 런 미리보기(연결·구동 없음) ──");
    console.log(`  run_id           : ${rid} (thread=${threadId})`);
    console.log(`  멘션             : ${mention}`);
    console.log(`  번들             : ${bundleDir}`);
    console.log(`  워킹백워드       : ${stagedWbPath}`);
    console.log(`  감사 actor       : ${actor}`);
    console.log(`  데몬 무인 단계   : ${LIVE_DAEMON_STAGES.join(",")} (CHAT_SDK_STAGES · 브리프 너머는 운영자 세션 소비)`);
    console.log(`  트랜스크립트     : ${paths.transcript}`);
    console.log("");
    console.log("  ⚠ 실 과금: ~$12–20 + 이미지(Gemini)·심의(GCP) · 벽시계 1–2.5시간(revise 포함).");
    console.log("  실제로 구동하려면 CHAT_LIVE_GO=1 을 설정하고 다시 실행하세요(런북 참조).");
    return; // 연결·구동 없이 종료(안전 기본).
  }

  // ── ③ 실 구동(CHAT_LIVE_GO=1) — 조립 → Slack 연결 → (재개 attach | 신규 멘션) → done 까지 auto-happy 구동 ──
  console.log(`[라이브] 실 구동 시작(CHAT_LIVE_GO=1) — run_id=${rid}`);
  // 견고성 가드: 대용량 업로드 중 소켓 not-ready 로 어댑터 ack 가 던지는 일시 예외(unhandledRejection)에 상주
  //   프로세스가 통째로 죽지 않게 한다(소켓모드 자동 재연결). 알려진 일시-소켓 오류만 살려주고 그 외는 fail-closed.
  installLiveResilience();
  // threadId(CHAT_LIVE_THREAD)를 넘겨 인터랙션 배선을 이 스레드로 스코프 제한한다 — 라이브 리허설은 단일 스레드
  //   전용이라, 워크스페이스 내 다른 스레드 활동이 이 게이트웨이·드라이버 뷰를 오염시키는 것을 원천 차단한다.
  const backend = assembleLiveBackend({ bundleDir, stagedWbPath, actor, jsonlPath: paths.transcript, threadId });

  await backend.slackChat.initialize();
  const slack = backend.slackChat.getAdapter("slack") as { startSocketModeListener?: (o: unknown) => Promise<unknown> };
  if (typeof slack.startSocketModeListener === "function") await slack.startSocketModeListener({});

  await backend.gw.chat.subscribe(threadId); // tee 포트 구독(실 Slack 구독까지 위임).
  // 중간-재개(S-2): 이 스레드에 이미 run 이 있으면 **재멘션 없이** attach(현재 게이트 카드 재게시)로 이어받는다.
  //   재멘션은 커널이 "이미 진행 중"으로 거부해 재기동 드라이버가 stuck 죽는 원인이었다. CHAT_LIVE_ATTACH=0 이면 옛
  //   동작(무조건 멘션)으로 오버라이드. 신규 스레드(매핑 없음 → attached:false)면 멘션 폴백.
  const existingRid = await backend.gw.map.runForThread(threadId).catch(() => null);
  const attachEnabled = process.env.CHAT_LIVE_ATTACH !== "0";
  let attached = false;
  if (existingRid && attachEnabled) {
    const res = await backend.driver.attach(threadId);
    attached = res.attached;
    if (attached) {
      console.log(`[라이브] 기존 작업 재개(attach) — rid=${res.rid} · 재멘션 없이 현재 게이트 카드를 다시 게시했습니다.`);
      // 리뷰 게이트에서 죽었던 경우 심의 잡을 다시 적재했음을 감사 로그로 남긴다(소실된 in-memory 리뷰 잡 화해).
      if (res.reviewResumed) console.log("[라이브] 규정 점검(심의)이 진행 중이던 게이트라 심의를 다시 요청했습니다(죽은 프로세스가 소실한 심의 재개).");
    }
  }
  if (!attached) await backend.driver.mention(threadId, mention);
  const result = await backend.driver.runToDone();

  // ── ④ 관측 아티팩트 + 판정 리포트(세션화 · S-4) ────────────────────────────────────
  mkdirSync(artifactDir, { recursive: true });
  backend.teePort.persist(); // 최종 트랜스크립트 스냅샷(세션 경로 = paths.transcript).
  writeFileSync(paths.transcript, backend.teePort.toJSONL(), "utf8");
  const runDir = join(harnessRoot(), "runs", rid);
  const jobsFailedDir = process.env.CHAT_JOBS_DIR ? join(process.env.CHAT_JOBS_DIR, "failed") : undefined;

  // 세션 리포트(비-final): 이 세션의 트랜스크립트 **단일 경로**만 읽는다 — 이 세션이 관측한 것 그대로가 의도된
  //   스코프다(전 세션 집계는 아래 final 이 맡는다). 세션 epoch suffix 로 세션별 보존.
  const sessionReport = assembleJudgmentReport({ runDir, transcriptPath: paths.transcript, jobsFailedDir });
  writeFileSync(paths.reportMd, renderReportMarkdown(sessionReport), "utf8");
  writeFileSync(paths.reportJson, `${JSON.stringify(sessionReport, null, 2)}\n`, "utf8");

  // done 도달 시 terminal 리포트를 세션 무관 고정 이름에 기록 — stale 세션 리포트가 실제 done 을 가리지 않게(S-4).
  //   ⚠ final 은 run-수준을 자처하므로 **전 세션을 집계**해야 한다(P1) — 이전 세션이 Failure 를 남기고 죽었고 attach
  //   세션이 done 에 닿으면, 현재 세션만 보던 리포트는 그 Failure 를 놓쳐 거짓 통과한다. listRunTranscripts 로 이 RID
  //   의 모든 세션 트랜스크립트를 모아 transcriptPaths 로 넘겨 failure-zero·화면 히스토그램을 전 세션 합산한다.
  let summaryReport = sessionReport;
  if (result.reached) {
    const finalReport = assembleJudgmentReport({
      runDir,
      transcriptPaths: listRunTranscripts(defaultReader, artifactDir, rid),
      jobsFailedDir,
    });
    writeFileSync(paths.finalReportMd, renderReportMarkdown(finalReport), "utf8");
    writeFileSync(paths.finalReportJson, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
    summaryReport = finalReport; // 종료 요약은 run-수준 집계(final)로 정직화한다.
    console.log(`[라이브] done 도달 — terminal 리포트(전 세션 집계): ${paths.finalReportMd} · ${paths.finalReportJson}`);
  }

  const stuck = backend.driver.stuckVerdict();
  console.log(`[라이브] 구동 종료: reached=${result.reached} reason=${result.reason} steps=${result.steps}`);
  // 종료 사유 평이 안내(배선 glue · driveLoop 의 DriveStopReason 미러) — done 외는 사람이 손볼 곳을 짚는다.
  const reasonHint: Record<string, string> = {
    predicate: "done 도달 — 정상 종료.",
    budget: "스텝 예산 소진 — 전진 스텝이 상한에 닿았습니다(흐름 점검).",
    stalled: "정체 — 같은 화면에 오래 머물렀거나(운영자 세션이 생성 잡을 안 집음/심의 지연) 회복 예산이 소진됐습니다.",
    escalation: "에스컬레이션/사람 판단 필요 — 심의 하드스톱 해제는 사람·RA 결정이라 자동 진행하지 않고 멈췄습니다.",
    "human-input":
      "사람 판단 대기 — 제품명 답글이 필요하거나, 생성이 완료되지 않아(재생성은 중복 과금 우려로 자동 진행 안 함) 사람 확인이 필요한 화면에서 멈췄습니다.",
  };
  console.log(`[라이브] 종료 안내: ${reasonHint[result.reason] ?? result.reason}`);
  console.log(`[라이브] 구조 판정(리포트): ${summaryReport.pass ? "통과(PASS)" : "미충족(REVIEW — 리포트 확인)"}`);
  if (stuck.stuck) console.log(`[라이브] ⚠ stuck 감지: ${stuck.signature}(${Math.round((stuck.elapsedMs ?? 0) / 1000)}s 정체)`);
  console.log(`[라이브] 아티팩트: ${paths.transcript} · ${paths.reportMd} · ${paths.reportJson}`);
  console.log("[라이브] 실 Slack 연결은 상주합니다 — 참관 후 Ctrl+C 로 종료하세요(사후검토용 tee 채널 확인).");
}

main().catch((err) => {
  console.error("[라이브] 기동/구동 오류:", err);
  process.exit(1);
});
