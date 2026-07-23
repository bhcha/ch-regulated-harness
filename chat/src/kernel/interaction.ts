/**
 * interaction.ts — 중립 상호작용 식별자(actionId) 어휘.
 *
 * 커널 flow 의 분기와 플랫폼 어댑터의 렌더가 **공유하는 프로토콜 어휘**다(플랫폼 무관 상수 — Slack/GChat 무지).
 *   어댑터가 이 id 로 버튼/Select 를 만들고, flow 가 같은 id 로 들어온 ButtonPressed 를 분기한다.
 */

/** 새 작업 설정 카드 — 도메인/포맷 Select 변경·[시작] 클릭의 actionId. */
export const SETUP_ACTION_IDS = {
  domain: "setup_domain",
  format: "setup_format",
  start: "setup_start",
} as const;

/** RA(담당자) 확인 카드의 확인 버튼 actionId — 이 클릭만이 ra_ok=true 승인을 만든다. */
export const RA_CONFIRM_ACTION_ID = "ra-confirm";

/** 인입 카드의 '붙여넣기 없이 진행' 버튼 actionId(운영자 스테이징 자료만으로 인입). */
export const INGEST_STAGED_ACTION_ID = "ingest-staged";

/**
 * NL 파일 인입 제안(NlProposal kind=intake)의 확정 버튼 actionId(P3-2).
 *   이 클릭만이 스테이징 스냅샷 + intake 잡을 만든다(NL 은 실행하지 않음 — 잠긴 결정 6). run_id 는 스레드↔대기(intake)로 해석.
 */
export const NL_INTAKE_CONFIRM_ACTION_ID = "nl-intake-confirm";

/**
 * 실패 카드의 [상태 다시 확인] 버튼 actionId — **늦은 성공 화해**(잡 큐 프로토콜 v2 보증 3분법의 봇 몫).
 *   생성 잡이 봇의 대기 상한을 넘겨 실패 카드가 뜬 뒤에도, 이미 잡을 집어 간 소비자는 **늦게 성공**할 수 있다
 *   (봇은 남의 프로세스를 죽일 수 없다). 그때 스레드가 실패 카드로 굳어 고아가 되지 않도록, 사람이 지금 상태를
 *   다시 물어볼 수 있게 한다 — 상태를 바꾸지 않는 **읽기 전용** 동작이라 JSON 손편집 없이 화해가 끝난다.
 */
export const RECONCILE_ACTION_ID = "reconcile";

/**
 * 생성 재요청 카드의 [다시 만들기] 버튼 actionId — **회수된 생성의 출구**([상태 다시 확인]의 나머지 절반).
 *   봇이 대기 상한에 포기하면 아직 안 집힌 요청은 큐에서 거둬들여지는데, core 는 여전히 그 단계 생성 차례라
 *   스레드가 "만드는 중이에요…"(버튼 없음)로 굳어 아무 챗 동작으로도 요청을 되살릴 수 없다. 이 클릭이 그 길이다.
 *   ⚠ 옛 요청 부활이 아니라 **새 요청(새 마감)** 이다 — 커널이 core 에 되물어 지금도 그 단계 생성 차례일 때만
 *     기존 생성 잡 경로로 다시 넣는다(늦게 성공한 생성을 덮어쓰지 않는다 · 잡 큐 프로토콜 v2).
 */
export const GENERATE_RETRY_ACTION_ID = "generate-retry";
