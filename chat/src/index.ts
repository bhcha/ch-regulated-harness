/**
 * index.ts — 챗 봇 기동(Slack Socket Mode).
 *
 * 실행: SLACK_BOT_TOKEN·SLACK_APP_TOKEN(·선택 SLACK_SIGNING_SECRET)·CHAT_APPROVERS 를 env 로 준 뒤 `node dist/index.js`
 *   (또는 tsx src/index.ts). Socket Mode 라 인바운드 오픈 불필요(상주 프로세스). core 는 형제 디렉터리(HARNESS_ROOT).
 *   ⚠ 이 파일은 실 Slack 연결 진입점이라 단위 테스트 대상이 아니다(수동 검증). 배선 로직은 bot.ts 의 순수 핸들러가 검증한다.
 */
import { createBot } from "./adapters/slack/transport.js";
import { harnessRoot, slackTokens } from "./config.js";

async function main(): Promise<void> {
  // 하네스(core) 경로 주입 확인 — Slack 연결 전에 빠르게 실패(fail-fast). 미주입이면 봇이 떠도 어떤
  //   생성/승인/심의도 spawn 할 수 없으므로, 기동 시점에 명확한 안내로 멈춘다(SLACK 토큰 점검과 동일 스타일).
  try {
    harnessRoot();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const tokens = slackTokens();
  if (!tokens.botToken || !tokens.appToken) {
    console.error(
      "기동 실패: SLACK_BOT_TOKEN·SLACK_APP_TOKEN 이 필요합니다(Socket Mode). .env 를 확인하세요.",
    );
    process.exit(1);
  }
  const { chat } = createBot();
  await chat.initialize();
  // Socket Mode 리스너 시작(어댑터 제공 시). 상주 프로세스가 WebSocket 으로 Slack 에 연결.
  const slack = chat.getAdapter("slack") as { startSocketModeListener?: (opts: unknown) => Promise<unknown> };
  if (typeof slack.startSocketModeListener === "function") {
    await slack.startSocketModeListener({});
  }
  console.log("규제 상세페이지 도우미 — Slack Socket Mode 연결됨. 종료: Ctrl+C");
}

main().catch((err) => {
  console.error("기동 오류:", err);
  process.exit(1);
});
