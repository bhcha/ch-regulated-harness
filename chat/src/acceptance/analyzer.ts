/**
 * analyzer.ts — 인수 하네스용 순수 문제 분석기(계획 2-2 "문제 분석기").
 *
 * 입력 = 구동된 트랜스크립트에서 뽑은 기록 화면들(+ 정지 후 activeRuns · 최종 na) → 출력 = 구조화된 발견 목록.
 *   게이트웨이/core 를 부르지 않는 순수 함수다(커널-중립). 구조 assert 가 못 잡는 질적 문제(안내 문구 등)는
 *   사람/AI 가 transcript 로 판독한다 — 이 분석기는 계획의 **5개 문제 부류**만 기계적으로 잡는다:
 *     · failure               — Failure 화면이 하나라도 렌더됨.
 *     · dead-end(막다른 화면)  — 최종 resting 화면이 Done 이 아니고, 인터랙티브 게이트도 아니며, affordance 가 0
 *                                (미완 run 인데 출구 없음). 캐스케이드 중의 Progress 와 구분하려고 **정지 후 최종 상태**에 건다.
 *     · stuck                 — 같은 게이트(type/phase)가 N회 이상 재현(전진 없는 루프).
 *     · job residue           — drain 뒤에도 activeRuns > 0(누수/미정착 잡).
 *     · unknown Presentation  — type 이 알려진 union 밖(방어적 — 알려진 집합으로 판정).
 *
 * 커널-중립: kernel/·types/·acceptance/(추출기) 만 import.
 */
import type { Presentation } from "../kernel/presentation.js";
import type { NextAction } from "../types/contract.js";
import { affordancesOf, type AffordanceContext } from "./affordances.js";

/** 발견 부류. */
export type FindingKind = "failure" | "dead-end" | "stuck" | "job-residue" | "unknown-presentation";

/** 구조화된 발견 1건. */
export interface Finding {
  kind: FindingKind;
  /** 사람/AI 판독용 평이 설명. */
  detail: string;
  /** 관련 화면 type(있으면). */
  presentationType?: string;
  /** 관련 phase(있으면). */
  phase?: string;
  /** stuck 재현 횟수(있으면). */
  count?: number;
  /** job-residue 의 activeRuns(있으면). */
  activeRuns?: number;
}

/** 분석기 입력. */
export interface AnalyzerInput {
  /** 순서 보존된 기록 화면들(RecordChatPort.renders 의 presentation). */
  presentations: readonly Presentation[];
  /** drain(정지) 뒤 진행 중 run 수. */
  activeRuns: number;
  /** affordancesOf 호출용 런타임 바인딩(비어있음 판정만 쓰므로 값 무관). */
  ctx: AffordanceContext;
  /** 최종 next-action(있으면 dead-end 의 '미완 run' 게이트에 쓴다). */
  finalNa?: NextAction | null;
  /**
   * 게이트웨이가 사람의 **답글/입력**을 기다리는 상태인가(pending 설정됨 · driver.awaitingReply()로 조회).
   *   true 면 dead-end 를 내지 않는다 — 보완([보완]) 뒤 "고칠 내용을 답글로" Progress 나 WB 붙여넣기 안내처럼,
   *   버튼 affordance 는 0 이어도 **출구가 '답글 타이핑'** 인 정당한 대기 상태이기 때문(외부리뷰 S3 P2 회귀).
   *   미지정(기본)이면 종전대로 버튼-출구 없음만 본다.
   */
  awaitingReply?: boolean;
  /** stuck 임계 재현 횟수(기본 3). */
  stuckThreshold?: number;
}

/** 알려진 Presentation type 집합(presentation.ts union 미러 — unknown 판정 SSoT). */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "Setup",
  "IngestPrompt",
  "Progress",
  "Failure",
  "GenerateRetry",
  "ApproveGate",
  "ConfirmGate",
  "Verdict",
  "Escalation",
  "OptionSet",
  "ImageOptionSet",
  "NlProposal",
  "Done",
]);

/**
 * stuck 판정 대상 = 사람이 상호작용하는 '게이트' 화면 type. Progress(진행 표시)·Setup(설정)·IngestPrompt(인입 안내)·
 *   NlProposal(확인)·Done 은 제외한다 — 이들은 정당하게 반복되거나(진행 표시) 루프의 지표가 아니다.
 */
const GATE_TYPES: ReadonlySet<string> = new Set([
  "ApproveGate",
  "ConfirmGate",
  "OptionSet",
  "ImageOptionSet",
  "Verdict",
  "Escalation",
  "GenerateRetry",
  "Failure",
]);

const DEFAULT_STUCK_THRESHOLD = 3;

/** type 안전 접근(정확 필드는 좁은 타입, 임의 키는 unknown). */
function fieldStr(p: Presentation, key: string): string {
  const v = (p as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/** 게이트 재현 서명 — type + phase(있으면) + header. 같은 게이트의 반복을 식별한다. */
function gateSignature(p: Presentation): string {
  const type = (p as { type: string }).type;
  const phase = fieldStr(p, "phase");
  const header = fieldStr(p, "header");
  const outcome = fieldStr(p, "outcome"); // Verdict 구분(pass/revise/human)
  return `${type}#${phase}#${header}#${outcome}`;
}

/** 알려진 type 인가. */
function isKnown(p: Presentation): boolean {
  return KNOWN_TYPES.has((p as { type: string }).type);
}

/**
 * 문제 분석(순수). 5개 부류의 발견을 concat 해 돌려준다. 깨끗한 happy 시퀀스면 빈 배열.
 */
export function analyze(input: AnalyzerInput): Finding[] {
  const findings: Finding[] = [];
  const { presentations, ctx } = input;
  const threshold = input.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD;

  // ── ① failure — Failure 화면(있으면 각 1건) ──
  for (const p of presentations) {
    if ((p as { type: string }).type === "Failure") {
      findings.push({
        kind: "failure",
        detail: `실패 화면이 렌더됨: ${fieldStr(p, "message") || "(사유 없음)"}`,
        presentationType: "Failure",
      });
    }
  }

  // ── ② unknown Presentation — 알려진 union 밖 type(각 1건) ──
  for (const p of presentations) {
    if (!isKnown(p)) {
      findings.push({
        kind: "unknown-presentation",
        detail: `알 수 없는 화면 type: ${String((p as { type?: unknown }).type)}`,
        presentationType: String((p as { type?: unknown }).type),
      });
    }
  }

  // ── ③ stuck — 같은 게이트(type/phase)가 임계 이상 재현 ──
  const sigCount = new Map<string, { count: number; sample: Presentation }>();
  for (const p of presentations) {
    if (!isKnown(p)) continue; // unknown 은 위에서 잡음(서명 시도 안 함)
    if (!GATE_TYPES.has((p as { type: string }).type)) continue;
    const sig = gateSignature(p);
    const cur = sigCount.get(sig);
    if (cur) cur.count += 1;
    else sigCount.set(sig, { count: 1, sample: p });
  }
  for (const { count, sample } of sigCount.values()) {
    if (count >= threshold) {
      findings.push({
        kind: "stuck",
        detail: `같은 게이트가 ${count}회 반복됨(전진 없는 루프 의심).`,
        presentationType: (sample as { type: string }).type,
        phase: fieldStr(sample, "phase") || undefined,
        count,
      });
    }
  }

  // ── ④ job residue — 정지 뒤에도 잡이 남음 ──
  if (input.activeRuns > 0) {
    findings.push({
      kind: "job-residue",
      detail: `정지(drain) 후에도 진행 중 run 이 ${input.activeRuns}건 남아 있음.`,
      activeRuns: input.activeRuns,
    });
  }

  // ── ⑤ dead-end — 미완 run 인데 출구(affordance) 0 ──
  //   미완 판정: 최종 na 가 있고 done 이 아니면 '아직 갈 길이 남음'.
  //   ⚠ 단, 게이트웨이가 사람의 답글을 기다리는 중(awaitingReply)이면 dead-end 가 아니다 — 출구는 '버튼'이 아니라
  //     '답글 타이핑'이다(보완 사유 요청·WB 붙여넣기 안내 Progress 등). 이 억제가 없으면 정당한 답글-대기를 막다른
  //     화면으로 오탐한다(외부리뷰 S3 P2). 답글-대기 여부는 gateway pending 에서 오며 driver.awaitingReply()가 낸다.
  const runUnfinished = input.finalNa != null && input.finalNa.action !== "done";
  if (runUnfinished && input.awaitingReply !== true) {
    if (presentations.length === 0) {
      // 표면 누락(외부리뷰 S2 P2): 화면을 하나도 렌더하지 않았는데 run 은 미완 — 사람이 진행할 어떤 출구도 없다.
      //   final=null 로 아래 분기를 건너뛰면 이 '출구 없는 미완'이 clean 으로 새어 나간다 → 여기서 명시 검출.
      findings.push({
        kind: "dead-end",
        detail: "렌더된 화면이 하나도 없는데 run 이 아직 끝나지 않았음(출구 없는 미완 — 표면 누락).",
        phase: input.finalNa?.phase || undefined,
      });
    } else {
      const final = presentations[presentations.length - 1]!;
      if (isKnown(final) && (final as { type: string }).type !== "Done") {
        const affs = affordancesOf(final, ctx); // isKnown 확인 후라 never-throw 안전
        if (affs.length === 0) {
          findings.push({
            kind: "dead-end",
            detail: "최종 화면에 출구(affordance)가 없는데 run 이 아직 끝나지 않았음(막다른 화면).",
            presentationType: (final as { type: string }).type,
            phase: fieldStr(final, "phase") || undefined,
          });
        }
      }
    }
  }

  return findings;
}
