/**
 * jobs.ts — 게이트웨이 잡큐 계약.
 *
 * 불변식(dev-loop-grounding 3): state.json 은 core scripts 만 쓴다.
 *   Job 은 '어떤 run 에 대해 누가 어떤 쓰기 동작을 요청했는지'를 기술하고,
 *   워커가 그 Job 을 `bash core/scripts/*.sh` spawn 으로 환원한다(어댑터/워커는 state 직접쓰기 금지).
 *
 * ack-후-비동기: 버튼/모달 핸들러는 즉시 ack 하고 JobSubmitter.submit 으로 잡을 넘긴 뒤 리턴한다.
 *   실제 셸 실행은 워커가 run별 FIFO 로 비동기 수행하며, 완료 시 카드를 edit 한다(Slack 3초 예산 회피).
 */

/**
 * 쓰기 동작 종류. NextAction.action 의 사람-조작 부분집합에 대응한다:
 *   generate·approve·select·ingest·review·raise-limit 는 action 과 동명,
 *   revise 는 select/approve 게이트의 '전부거절→재제안'(revise.sh)에 해당(action 에는 없는 별도 동작).
 * (resume-*·done 은 자동 복구/종료라 잡으로 만들지 않는다.)
 */
export type JobKind =
  | "generate"
  | "approve"
  | "select"
  | "revise"
  | "ingest"
  | "intake"
  | "review"
  | "raise-limit";

/**
 * 잡 payload — kind 별로 필요한 인자(모두 선택 · core scripts 인자로 환원).
 *   generate : stage(run-stage 인자)
 *   select   : option(고른 옵션 키)
 *   revise   : feedback(빼거나 고칠 표현 자유텍스트)
 *   approve  : ra_ok(민감 기능성 RA 사후검수 --ra-ok)
 *   ingest   : bundle_dir(자료 폴더 절대경로)
 * forward-compat: 미지 필드 허용(index signature).
 */
export interface JobPayload {
  /**
   * generate: run-stage 인자(guideline/brief/concept/storyboard-outline/...).
   *   리뷰 재적재(P2) 서명에도 재사용된다 — review 게이트는 stage 가 없어 null 로 실릴 수 있다(generate 경로는
   *   requireStr 가 null/빈값을 거부하므로 null stage 로 위장한 생성 스머글링은 차단된다).
   */
  stage?: string | null;
  /** select: 고른 옵션 키(A/B/C 등). */
  option?: string;
  /** revise: 빼거나 고칠 표현(자유텍스트). */
  feedback?: string;
  /** approve: 민감 기능성 RA 사후검수 승인(--ra-ok). */
  ra_ok?: boolean;
  /** ingest: 번들/자료 폴더 절대경로. */
  bundle_dir?: string;
  /** intake(P3-2 · 00a-intake 정문): 스테이징된 불변 첨부 스냅샷 폴더 절대경로. */
  folder?: string;
  /** intake: 사람이 선언한 제품명(intake.sh --product). */
  product?: string;
  /** intake: 사람이 선언한 규제도메인(intake.sh --domain). */
  domain?: string;
  /** intake: 사람이 선언한 산출물 포맷(intake.sh --format). */
  format?: string;
  /** 리뷰 재적재 회차(0 또는 없음 = 최초 시도). 이 카운터가 잡을 따라 흐른다 — 별도 상태 파일 없음(state.json 불가침). */
  attempt?: number;
  /**
   * 리뷰 재적재(P2) 원 게이트 서명 — phase. 지연 백오프 스케줄 시점의 게이트를 못박아, 대기 중 런이 **다음 페이즈의
   *   review** 로 전진해도(action 은 그대로 review) 옛 타이머가 나중 게이트 리뷰로 승계되지 않게 한다(이전 게이트
   *   재시도 예산이 새어 정규 리뷰와 중복되는 것 차단). 부재(구형 잡) = action-만 검사로 폴백(후방호환).
   */
  phase?: string;
  /**
   * 리뷰 재적재(P2) 원 게이트 서명 — iteration(보완 회차 · null 가능). phase 와 함께 게이트 스냅샷을 이룬다.
   *   (stage 는 위 `stage?` 를 재사용 — review 게이트는 stage=null 이므로 서명에선 null 로 실린다.)
   */
  iteration?: number | null;
  /** 미지 인자 허용. */
  [k: string]: unknown;
}

/**
 * 잡큐 1건. run_id 로 FIFO 라우팅, actor 는 감사(--by chat:slack:<user>)로 환원.
 */
export interface Job {
  /** 쓰기 동작 종류. */
  kind: JobKind;
  /** 대상 run_id(FIFO 큐 키). */
  run_id: string;
  /** kind 별 인자. */
  payload: JobPayload;
  /** 요청자(감사 actor · 예 "chat:slack:U123"). */
  actor: string;
}

/**
 * JobSubmitter — ack-후-비동기 계약.
 *   submit 은 '큐 적재까지'만 보장하고 빠르게 resolve 한다(Slack 3초 ack 예산 안).
 *   실제 셸 실행은 워커가 비동기로 소비한다.
 */
export interface JobSubmitter {
  submit(job: Job): Promise<void>;
}

/**
 * 생성 잡 **파일**(큐 프로토콜 v2) — 위 Job(인메모리 큐 1건)과 다른 계약이다: 이건 `jobs/` 파일 큐에 적재돼
 *   **봇·소비 데몬·사람 운영자 셋이 공유하는 유일한 규약**이다(chat/jobs/README.md · 프로세스 경계를 넘는다).
 *
 * v2 가 더한 것(chat-dual-surface-plan 잠긴 결정 2):
 *   · expires_at — 절대 마감(적재시각 + CHAT_BRIDGE_TIMEOUT). **종단 마감 단일 원천**이라 늦게 집은 소비자가
 *     스스로 '이미 늦었다'를 안다(duration 이 아니라 절대시각인 이유 — 소비자는 적재 시각을 모른다).
 *   · job_id — 적재 1건의 식별자. 봇의 회수(recall)가 '자기 잡'만 지우게 한다(같은 이름의 새 잡 오삭제 차단).
 *
 * ⚠ 읽기 후방호환: v1(구 브리지)은 `{run_id, stage, kind}` 만 썼다 → v2 필드는 전부 **선택**이다. 마감이 없는
 *   v1 잡을 어떻게 다룰지는 job-protocol 의 2중 검사가 정한다(no_deadline = 자동 소비 대상 아님 · 사람 소비자 몫).
 */
export interface GenerateJobFile {
  /** 파일 큐에 적재되는 잡은 생성뿐이다(승인·선택 등 결정은 사람이 버튼으로 — 큐를 타지 않는다). */
  kind: "generate";
  run_id: string;
  /** run-stage 인자(guideline/brief/concept/...). */
  stage: string;
  /** 프로토콜 버전(v2 부터 기재). 부재 = v1 레거시 잡. */
  version?: number;
  /** 이 적재 1건의 식별자(v2). 회수·정리가 '자기 잡'인지 대조하는 도장(stamp). */
  job_id?: string;
  /** 적재 시각(ISO-8601 UTC · v2). 소비자의 대기시간 관측용. */
  enqueued_at?: string;
  /** 절대 마감(ISO-8601 UTC · v2) = enqueued_at + CHAT_BRIDGE_TIMEOUT. 종단 마감 단일 원천. */
  expires_at?: string;
  /** 미지 필드 허용(forward-compat — 소비자가 새 필드를 더해도 파싱이 깨지지 않게). */
  [k: string]: unknown;
}

/**
 * GenExecutor — 생성(run-stage <stage>) 위임 계약.
 *   두 구현이 이 인터페이스를 만족한다:
 *     1) stub-직접: HARNESS_OFFLINE=1 로 core run-stage.sh 를 직접 spawn(결정적 · CI/골든).
 *     2) 브리지(C2): chat/jobs/ 에 생성잡을 적재 → 운영자 Claude Code 세션이 소비(insession 생성).
 *   execute 는 해당 run 의 stage 생성이 '전이까지 완료'되면 resolve 된다.
 */
export interface GenExecutor {
  execute(run_id: string, stage: string): Promise<void>;
}
