/**
 * presentation.ts — 중립 표현 모델(Presentation) · 게이트웨이 커널이 소유하는 SSoT.
 *
 * 헥사고날 재정렬(chat-hexagonal-gateway-plan 2-2): 커널(flow)은 플랫폼(Block Kit/Cards) 개념을 0으로
 *   유지한 채 "무엇을 보여줄지"를 이 중립 모델로만 표현한다. 플랫폼 어댑터(adapters/slack/render.ts 등)가
 *   이 모델을 자기 네이티브 UI 로 번역한다 — 커널은 어떤 플랫폼도 모른다.
 *
 * ⚠ 라벨 passthrough: header(=phase_label)·gateLabel·hint 는 core 산출을 **그대로** 싣는다(번역/트림 금지).
 *   여기 실린 문자열은 viewmodel.toViewModel 이 정규화한 passthrough 라벨이다.
 *
 * additive-only(포트 동결): 새 변이는 union 에 '추가'만 한다(기존 변이 필드 제거·의미 변경 금지).
 *   P1 = OptionSet · P2 = ImageOptionSet · P3 = NlProposal 이 이 union 에 더해질 자리다.
 */

/** 심의 verdict 3상태(커널 파생 — core status → 신호등). */
export type VerdictOutcome = "pass" | "revise" | "human";

/** 새 작업 설정(도메인/포맷 수집 + 제품명). 아직 run 이 없어 rid/header 없음. */
export interface SetupPresentation {
  type: "Setup";
  product?: string;
  domain?: string;
  format?: string;
}

/** 자료 요청(워킹백워드 붙여넣기 안내 + 스테이징 진행). */
export interface IngestPromptPresentation {
  type: "IngestPrompt";
  rid: string;
  header: string;
  gateLabel: string;
  hint: string;
}

/** 진행/안내 한 줄(자동 단계·상태·평이 안내). 버튼 없음. */
export interface ProgressPresentation {
  type: "Progress";
  rid: string;
  header: string;
  message: string;
}

/**
 * 실패 안내 + [상태 다시 확인](화해 버튼). 잡이 실패했을 때의 카드다.
 *   버튼이 필요한 이유(잡 큐 프로토콜 v2 · 보증 3분법의 봇 몫): 생성이 봇의 대기 상한을 넘겨 실패 카드가 뜬 뒤에도
 *   이미 잡을 집어 간 소비자는 **늦게 성공**할 수 있다. 그러면 스레드만 실패 카드로 굳는다 — 사람이 지금 상태를
 *   다시 물어 카드를 맞출 수 있게 한다. **읽기 전용**(상태 변이 0)이라 어떤 게이트도 우회하지 않는다.
 */
export interface FailurePresentation {
  type: "Failure";
  rid: string;
  /** header = phase_label passthrough(변형 금지). */
  header: string;
  /** 실패 사유(평이 한국어 — 내부 코드·경로 비노출. worker 의 회신 문구). */
  message: string;
}

/**
 * 생성 재요청 + [다시 만들기] — 회수된 생성의 **출구**(프로토콜 v2 화해의 나머지 절반).
 *   봇이 대기 상한에 포기하면 아직 아무도 안 집은 요청은 큐에서 거둬들여진다. 그런데 core 는 그대로 그 단계
 *   생성 차례에 서 있으므로, 사람이 [상태 다시 확인]을 눌러도 버튼 없는 "만드는 중이에요…"만 뜬다 —
 *   사실도 아니고(아무도 안 만든다) 출구도 없다(어떤 챗 동작으로도 요청을 되살릴 수 없다). 이 표현이 그 출구다.
 *   ⚠ 옛 요청을 되살리는 게 아니라 **새 요청(새 마감)** 을 만든다(v2: stale 부활 금지). 그래서 이 카드는
 *     **상태를 다시 읽어 여전히 그 단계 생성 차례임이 확인됐을 때만** 나온다(늦은 성공을 덮어쓰지 않는다).
 */
export interface GenerateRetryPresentation {
  type: "GenerateRetry";
  rid: string;
  /** header = phase_label passthrough(변형 금지). */
  header: string;
  /** 평이 안내 한 줄(현재 상태 서술). */
  message: string;
  /** 다시 만들 단계 — 버튼에 실려 옛 카드 클릭(그 사이 단계가 바뀜)을 가른다. */
  stage: string;
}

/** 단안 승인/보완 게이트. */
export interface ApproveGatePresentation {
  type: "ApproveGate";
  rid: string;
  header: string;
  gateLabel: string;
  hint: string;
  /** 보완(변경 요청) 버튼 노출. */
  reviseAvailable: boolean;
  /** 기능성 표시 → RA(담당자) 사후검수 필요. */
  raOkRequired: boolean;
}

/** 2단계 확정(비가역·RA). 현재 kind="ra"(기능성 표시 담당자 확인). */
export interface ConfirmGatePresentation {
  type: "ConfirmGate";
  rid: string;
  kind: "ra";
}

/** 심의 결과(🟢/🟠/🔴 + 재생성/담당자 버튼). stage = revise 시 재생성 대상. */
export interface VerdictPresentation {
  type: "Verdict";
  rid: string;
  header: string;
  outcome: VerdictOutcome;
  stage: string | null;
}

/** 에스컬레이션(하드스톱) 복구 — [한 번 더 시도](raise-limit). */
export interface EscalationPresentation {
  type: "Escalation";
  rid: string;
  header: string;
  gateLabel: string;
  hint: string;
}

/** 다안(md) 중 한 안 — 안별 카드 1장에 실린다(P1). */
export interface OptionSetOption {
  /** 옵션 키(core options[] · select.sh 인자 · 감사에 그대로). */
  key: string;
  /** 대표 한 줄(컨셉=메시지 라인 · 스토리라인=전개 라인 · 없으면 키). */
  title: string;
  /** 이 안의 마크다운 전문(options-compare.md 의 `## <key>` 섹션 전체). */
  body: string;
  /** 추천 top-1 여부(key === next.recommended). */
  recommended: boolean;
}

/**
 * 다안 md 선택(P1) — 02-concept · 03-storyboard(outline) 선택 게이트. 안별 `{key,제목,본문 md,추천}` +
 *   비교 md 전문. 어댑터가 안별 카드 + [이걸로] 버튼(+ [다시 제안])으로 렌더한다.
 */
export interface OptionSetPresentation {
  type: "OptionSet";
  rid: string;
  /** header = phase_label passthrough(변형 금지). */
  header: string;
  /**
   * 이 다안을 낸 단계 식별(phase)·보완 회차(iteration) — [이걸로] 버튼에 실려 stale 클릭을 막는 도장(stamp).
   *   같은 옵션 키(A/B/C)가 재생성·다음 단계에서 재사용되므로, 클릭이 '지금 그' 다안을 가리키는지 대조한다.
   */
  phase: string;
  iteration: number | null;
  /** 안 목록(next.options 순서). */
  options: OptionSetOption[];
  /** options-compare.md 전문(참고용 · 안별 body 로 나눠 싣기 전 원본). */
  compareMd: string;
  /** 전부 거절→재제안(revise) 가용 여부 — [다시 제안] 버튼 신호. */
  reviseAvailable: boolean;
}

/** 다안 이미지(P2) 중 한 안 — 안별 카드 1장 + 미리보기 이미지(어댑터가 별도 게시). */
export interface ImageOptionSetOption {
  /** 옵션 키(core options[] · select.sh 인자 · 감사에 그대로). */
  key: string;
  /**
   * 이 안의 미리보기 이미지 로컬 파일 경로(어댑터가 자기 방식으로 게시 — Slack=네이티브 파일 첨부).
   *   커널은 '무엇을 보여줄지(경로)'만 정하고 '어떻게 보내는지'는 어댑터가 결정한다(플랫폼 무지).
   *   미리보기 산출물이 없으면 빈 배열(디자인 HTML 만 준비된 경우 — caption 이 그 사정을 밝힌다).
   */
  imagePaths: string[];
  /** 대표 한 줄(평이 · 예 "A안 · 이미지 3장"). 옵션 md 본문이 없는 이미지 다안의 사람용 라벨. */
  caption: string;
  /** 추천 top-1 여부(key === next.recommended). */
  recommended: boolean;
}

/**
 * 다안 이미지 선택(P2) — 04-keyvisual 선택 게이트. 안별 `{key, 이미지 경로[], 캡션, 추천}`.
 *   OptionSet(md 다안)과 동일한 도장(stamp: phase·iteration)을 실어 stale 클릭을 막는다([이걸로] 버튼에 실림 —
 *   커널 onChoice 가 그대로 검증). 어댑터가 이미지를 자기 네이티브 방식(Slack=파일 첨부)으로 게시하고
 *   안별 [이걸로] 버튼 카드(+ [다시 제안])를 렌더한다.
 */
export interface ImageOptionSetPresentation {
  type: "ImageOptionSet";
  rid: string;
  /** header = phase_label passthrough(변형 금지). */
  header: string;
  /** 이 다안을 낸 단계(phase)·보완 회차(iteration) — OptionSet 과 동일한 stale 도장(stamp). */
  phase: string;
  iteration: number | null;
  /** 안 목록(next.options 순서). */
  options: ImageOptionSetOption[];
  /** 전부 거절→재제안(revise) 가용 여부 — [다시 제안] 버튼 신호. */
  reviseAvailable: boolean;
}

/**
 * 자연어 이해 확인(NlProposal · P3) — "이해는 자연어, 방아쇠는 버튼". 파서가 뽑은 결과 요약 + 미확신 질문 +
 *   (확정 시) 방아쇠 버튼. 버튼 클릭은 **기존 버튼→잡 경로**로 들어간다(설정=[시작] SETUP_ACTION_IDS.start ·
 *   인입=NL_INTAKE_CONFIRM_ACTION_ID). NL 자체는 상태를 바꾸지 않는다(잠긴 결정 6) — 이 표현은 확인 카드일 뿐이다.
 */
export interface NlProposalPresentation {
  type: "NlProposal";
  /** setup(새 작업 시작) · intake(파일 인입 · P3-2). */
  kind: "setup" | "intake";
  /** 파싱 결과 요약(평이 한국어 · 사람이 확인). */
  summary: string;
  /** 미확신 필드 되물음(없으면 빈 배열). */
  questions: string[];
  /** 방아쇠 버튼(확정 가능할 때만). actionId 는 기존 잡 경로의 것(setup 시작·인입 확정). payload 는 필요 시만. */
  confirm?: { actionId: string; label: string; payload?: string };
}

/**
 * 완료(Done) — 마지막 단계(done)에 도달했을 때의 마무리 안내. 추가 상호작용(버튼) 없음.
 *   최종 산출물 경로(있으면)를 곁들여 "다 됐어요"를 평이하게 알린다.
 */
export interface DonePresentation {
  type: "Done";
  rid: string;
  /** header = phase_label passthrough(변형 금지). */
  header: string;
  /** 완료 안내 한 줄(평이 한국어). */
  message: string;
  /** 최종 산출물 경로 목록(없으면 빈 배열). */
  files: string[];
}

/**
 * 중립 표현 모델 — 플랫폼 어댑터가 render() 로 소비한다.
 */
export type Presentation =
  | SetupPresentation
  | IngestPromptPresentation
  | ProgressPresentation
  | FailurePresentation
  | GenerateRetryPresentation
  | ApproveGatePresentation
  | ConfirmGatePresentation
  | VerdictPresentation
  | EscalationPresentation
  | OptionSetPresentation
  | ImageOptionSetPresentation
  | NlProposalPresentation
  | DonePresentation;
