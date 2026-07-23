/**
 * affordance-convention.test.ts — 규약 결박(the linchpin: "지어낸 버튼 없음").
 *
 * 무엇을 증명하나: affordance 추출기(src/acceptance/affordances.ts) 출력이 실렌더(adapters/slack/render.ts
 *   toCards) 가 낸 상호작용 요소(버튼 + Select 선택지)와 **전수 일치**한다(빠짐 0·초과 0). 이것이 "커널 이벤트
 *   발화 = 정직한 클릭 동치"의 CI 증명이자 추출기↔렌더 드리프트 봉인이다.
 *
 * ⚠ 예외 허용: 인수 계층 파일 중 **유일하게** 이 결박 테스트만 슬랙 렌더러를 import 한다(결박 목적 · 테스트라
 *   허용). 프로덕션 src/acceptance/ 는 어댑터를 import 하지 않는다(kernel-neutral).
 *
 * ⚠ 전수성(exhaustiveness)의 진짜 가드는 컴파일 시 `never` arm 이다: 런타임 테스트는 union 에서 '빠진 변이'를
 *   증명할 수 없다(존재하지 않는 변이는 인스턴스화할 수 없으므로). affordances.ts 의 switch default `never` 가
 *   union 변이 추가 시 컴파일을 깨뜨려 전수성을 강제한다 — 이 테스트는 '있는 변이의 규약 일치'만 결박한다.
 *
 * Select 도 affordance: 설정 도메인/포맷 Select 변경은 onAction(actionId=setup_domain/setup_format·value=선택 토큰)
 *   으로 커널에 도달하므로, 렌더 walk 에서 Select 를 선택지별 (actionId, value) 로 펼쳐 버튼과 함께 비교한다.
 */
import type { ButtonElement } from "chat";
import { expect, test } from "vitest";
import { affordancesOf } from "../../src/acceptance/affordances.js";
import {
  toCards,
  NL_INTAKE_CONFIRM_ACTION_ID,
  SETUP_ACTION_IDS,
} from "../../src/adapters/slack/render.js";
import type { ChatEvent } from "../../src/kernel/events.js";
import type {
  ApproveGatePresentation,
  DonePresentation,
  FailurePresentation,
  GenerateRetryPresentation,
  ImageOptionSetPresentation,
  IngestPromptPresentation,
  NlProposalPresentation,
  OptionSetPresentation,
  Presentation,
  SetupPresentation,
  VerdictPresentation,
} from "../../src/kernel/presentation.js";

const CTX = { actor: "chat:test:U1", threadId: "T-accept-1" } as const;

// ── 표현 팩토리(render.test.ts 값·스타일 재사용) ─────────────────────────────
function setupP(over: Partial<SetupPresentation> = {}): SetupPresentation {
  return { type: "Setup", ...over };
}
function ingestP(over: Partial<IngestPromptPresentation> = {}): IngestPromptPresentation {
  return { type: "IngestPrompt", rid: "run-1", header: "브리프 라벨", gateLabel: "승인할 차례예요", hint: "힌트 원문", ...over };
}
function approveP(over: Partial<ApproveGatePresentation> = {}): ApproveGatePresentation {
  return {
    type: "ApproveGate",
    rid: "run-1",
    header: "브리프 라벨",
    gateLabel: "승인할 차례예요",
    hint: "힌트 원문",
    reviseAvailable: false,
    raOkRequired: false,
    ...over,
  };
}
function verdictP(over: Partial<VerdictPresentation> = {}): VerdictPresentation {
  return { type: "Verdict", rid: "run-1", header: "브리프 라벨", outcome: "pass", stage: null, ...over };
}
function optionSetP(over: Partial<OptionSetPresentation> = {}): OptionSetPresentation {
  return {
    type: "OptionSet",
    rid: "run-1",
    header: "메시지 방향",
    phase: "02-concept",
    iteration: 1,
    options: [
      { key: "A-efficacy", title: "효능 메시지", body: "## A-efficacy\n- **메시지**: 효능 메시지", recommended: false },
      { key: "B-safety", title: "안전 메시지", body: "## B-safety\n- **메시지**: 안전 메시지", recommended: true },
      { key: "C-science", title: "성분 메시지", body: "## C-science\n- **메시지**: 성분 메시지", recommended: false },
    ],
    compareMd: "# 컨셉 안 비교",
    reviseAvailable: true,
    ...over,
  };
}
function imageOptionSetP(over: Partial<ImageOptionSetPresentation> = {}): ImageOptionSetPresentation {
  return {
    type: "ImageOptionSet",
    rid: "run-1",
    header: "디자인",
    phase: "04-keyvisual",
    iteration: 1,
    options: [
      { key: "A", imagePaths: ["/runs/run-1/04-keyvisual/options/A/shots/full.png"], caption: "A안 · 이미지 1장", recommended: false },
      { key: "B", imagePaths: ["/runs/run-1/04-keyvisual/options/B/shots/full.png"], caption: "B안 · 이미지 1장", recommended: true },
      { key: "C", imagePaths: [], caption: "C안 · 미리보기 없음(디자인만 준비됨)", recommended: false },
    ],
    reviseAvailable: true,
    ...over,
  };
}
function doneP(over: Partial<DonePresentation> = {}): DonePresentation {
  return { type: "Done", rid: "run-1", header: "완료", message: "모든 단계를 마쳤어요.", files: [], ...over };
}
function failureP(over: Partial<FailurePresentation> = {}): FailurePresentation {
  return { type: "Failure", rid: "r-fail", header: "핵심 정리", message: "생성을 마치지 못했습니다.", ...over };
}
function generateRetryP(over: Partial<GenerateRetryPresentation> = {}): GenerateRetryPresentation {
  return { type: "GenerateRetry", rid: "r-1", header: "핵심 정리", message: "다시 요청할 수 있어요.", stage: "brief", ...over };
}
function nlSetupProposal(over: Partial<NlProposalPresentation> = {}): NlProposalPresentation {
  return {
    type: "NlProposal",
    kind: "setup",
    summary: "규제도메인: 화장품 · 산출물: 여러장 · 제품명: 릴리프쿠션",
    questions: [],
    confirm: { actionId: SETUP_ACTION_IDS.start, label: "시작" },
    ...over,
  };
}

// ── 렌더 walk 헬퍼(render.test.ts 스타일 재사용) ─────────────────────────────
function walkType<T>(node: unknown, type: string, out: T[] = []): T[] {
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === type) out.push(n as unknown as T);
    if (Array.isArray(n.children)) for (const k of n.children) walkType(k, type, out);
  }
  return out;
}
type RenderedSelect = { id: string; options: { value: string }[] };

/** (actionId, value) 쌍을 안정 문자열로 정규화(value 부재 → null). */
function canon(actionId: string, value: string | null | undefined): string {
  return JSON.stringify([actionId, value ?? null]);
}

/** 실렌더(toCards)의 모든 상호작용 요소 → {actionId, value} 집합(버튼 + Select 선택지 펼침). */
function renderedInteractiveSet(p: Presentation): Set<string> {
  const pairs: string[] = [];
  for (const card of toCards(p)) {
    for (const b of walkType<ButtonElement>(card, "button")) pairs.push(canon(b.id, b.value));
    for (const s of walkType<RenderedSelect>(card, "select"))
      for (const o of s.options) pairs.push(canon(s.id, o.value));
  }
  return new Set(pairs);
}

/** 추출기 출력 → {actionId, value} 집합(모두 ButtonPressed 여야 한다 — ChoiceMade 선변환 금지). */
function extractorInteractiveSet(p: Presentation): Set<string> {
  const events: ChatEvent[] = affordancesOf(p, CTX);
  const pairs: string[] = [];
  for (const e of events) {
    // 정직한 클릭 동치: 추출기는 버튼도 Select 선택지도 모두 ButtonPressed 로 낸다(선변환 없음).
    expect(e.type).toBe("button");
    if (e.type !== "button") continue; // 타입 좁힘(위 expect 가 실질 가드)
    expect(e.actor).toBe(CTX.actor);
    expect(e.threadId).toBe(CTX.threadId);
    pairs.push(canon(e.actionId, e.value));
  }
  return new Set(pairs);
}

function sorted(s: Set<string>): string[] {
  return [...s].sort();
}

/** 결박: 추출기 집합 ≡ 실렌더 집합(전수 · 빠짐 0 · 초과 0). */
function expectBinding(p: Presentation): { rendered: Set<string>; extracted: Set<string> } {
  const rendered = renderedInteractiveSet(p);
  const extracted = extractorInteractiveSet(p);
  expect(sorted(extracted)).toEqual(sorted(rendered));
  return { rendered, extracted };
}

// ── 전 변이(13종) 결박 — 각 변이 대표 인스턴스로 추출기 ≡ 실렌더 ─────────────
// (컴파일 시 never arm 이 '빠진 변이'를 잡는다 — 이 목록은 '있는 변이의 규약 일치'를 결박한다.)
test("결박: 13개 Presentation 변이 전부 추출기 ≡ 실렌더 상호작용 집합", () => {
  const variants: Presentation[] = [
    setupP({ domain: "화장품", format: "여러장", product: "이지듀 쿠션" }),
    ingestP(),
    { type: "Progress", rid: "r", header: "h", message: "진행 중" },
    failureP(),
    generateRetryP(),
    approveP({ reviseAvailable: true, raOkRequired: true }),
    { type: "ConfirmGate", rid: "r-ra", kind: "ra" },
    verdictP({ outcome: "revise", stage: "brief" }),
    { type: "Escalation", rid: "r-lim", header: "라벨헤더", gateLabel: "라벨", hint: "힌트" },
    optionSetP(),
    imageOptionSetP(),
    nlSetupProposal(),
    doneP({ files: ["04-keyvisual/export/kcia-package"] }),
  ];
  for (const p of variants) expectBinding(p);
});

// ── 상호작용 없는 화면: 추출기·실렌더 모두 공집합 ────────────────────────────
test("상호작용 없는 화면(Progress · Verdict pass · Done): 양쪽 공집합", () => {
  for (const p of [
    { type: "Progress", rid: "r", header: "h", message: "진행 중" } as Presentation,
    verdictP({ outcome: "pass" }),
    doneP(),
  ]) {
    const { rendered, extracted } = expectBinding(p);
    expect(rendered.size).toBe(0);
    expect(extracted.size).toBe(0);
  }
});

// ── Setup: Select 2개 선택지(4+2) + [시작] 버튼(value 없음) = 7건 ─────────────
test("Setup: 도메인 4 + 포맷 2 Select 선택지 + [시작] 버튼(value 없음) 전수 결박", () => {
  const p = setupP({ domain: "화장품" });
  const { extracted } = expectBinding(p);
  expect(extracted.size).toBe(7);
  // 도메인 Select 선택지 4건.
  for (const v of ["화장품", "의약외품", "건기식", "의약품"])
    expect(extracted.has(JSON.stringify([SETUP_ACTION_IDS.domain, v]))).toBe(true);
  // 포맷 Select 선택지 2건.
  for (const v of ["한장", "여러장"])
    expect(extracted.has(JSON.stringify([SETUP_ACTION_IDS.format, v]))).toBe(true);
  // [시작] 버튼 — value 없음(null 로 정규화).
  expect(extracted.has(JSON.stringify([SETUP_ACTION_IDS.start, null]))).toBe(true);
});

// ── ApproveGate: raOkRequired × reviseAvailable 4조합 전부 결박 ───────────────
test("ApproveGate: raOkRequired × reviseAvailable 4조합 결박", () => {
  for (const raOkRequired of [false, true]) {
    for (const reviseAvailable of [false, true]) {
      const p = approveP({ rid: "r-ag", raOkRequired, reviseAvailable });
      const { extracted } = expectBinding(p);
      // 승인은 항상 · 보완은 reviseAvailable 일 때만.
      expect(extracted.size).toBe(reviseAvailable ? 2 : 1);
      const approveVal = raOkRequired
        ? JSON.stringify(["approve", JSON.stringify({ run_id: "r-ag", action: "approve", ra_required: true })])
        : JSON.stringify(["approve", JSON.stringify({ run_id: "r-ag", action: "approve" })]);
      expect(extracted.has(approveVal)).toBe(true);
      expect(extracted.has(JSON.stringify(["revise", JSON.stringify({ run_id: "r-ag", action: "revise" })]))).toBe(
        reviseAvailable,
      );
    }
  }
});

// ── Verdict: 3결과 전부 결박(pass=0 · revise=재생성 · human=담당자 호출) ──────
test("Verdict: pass/revise/human 3결과 결박", () => {
  expect(extractorSize(verdictP({ outcome: "pass" }))).toBe(0);
  const rev = expectBinding(verdictP({ rid: "r-rev", outcome: "revise", stage: "brief" })).extracted;
  expect(rev.has(JSON.stringify(["regenerate", JSON.stringify({ run_id: "r-rev", action: "generate", stage: "brief" })]))).toBe(true);
  const hum = expectBinding(verdictP({ rid: "r-esc", outcome: "human" })).extracted;
  expect(hum.has(JSON.stringify(["escalate", JSON.stringify({ run_id: "r-esc", action: "escalate" })]))).toBe(true);
});

// ── OptionSet / ImageOptionSet: 다안 select-<key> + 트레일링 revise 결박 ──────
test("OptionSet: select-<key> 3건 + [다시 제안](reviseAvailable) 결박 · iteration null 포함", () => {
  for (const reviseAvailable of [false, true]) {
    const { extracted } = expectBinding(optionSetP({ reviseAvailable }));
    expect(extracted.size).toBe(reviseAvailable ? 4 : 3);
  }
  // iteration null 도 payload 바이트 동치(JSON null) — 별도 결박.
  expectBinding(optionSetP({ iteration: null }));
});

test("ImageOptionSet: select-<key> 3건 + [다시 제안](reviseAvailable) 결박", () => {
  for (const reviseAvailable of [false, true]) {
    const { extracted } = expectBinding(imageOptionSetP({ reviseAvailable }));
    expect(extracted.size).toBe(reviseAvailable ? 4 : 3);
  }
});

// ── NlProposal: confirm 유/무 + payload 유/무 결박 ───────────────────────────
test("NlProposal: confirm 있음(setup·value 없음) / 없음(공집합) / intake payload 있음 결박", () => {
  // (a) setup 확정 — [시작] 버튼(value 없음).
  const setup = expectBinding(nlSetupProposal()).extracted;
  expect(setup.has(JSON.stringify([SETUP_ACTION_IDS.start, null]))).toBe(true);
  expect(setup.size).toBe(1);
  // (b) 미확신(confirm 없음) — 버튼 없음(공집합).
  const none = expectBinding(nlSetupProposal({ confirm: undefined, questions: ["한 장? 여러 장?"] })).extracted;
  expect(none.size).toBe(0);
  // (c) intake 확정 + payload 실림 — value passthrough 결박.
  const pay = JSON.stringify({ run_id: "r-in", action: "intake" });
  const intake = expectBinding(
    nlSetupProposal({ kind: "intake", confirm: { actionId: NL_INTAKE_CONFIRM_ACTION_ID, label: "이 자료로 시작", payload: pay } }),
  ).extracted;
  expect(intake.has(JSON.stringify([NL_INTAKE_CONFIRM_ACTION_ID, pay]))).toBe(true);
});

// ── 단안·복구 화면 개별 결박 ─────────────────────────────────────────────────
test("ConfirmGate · IngestPrompt · Failure · GenerateRetry · Escalation 개별 결박", () => {
  expect(extractorSize({ type: "ConfirmGate", rid: "r-ra", kind: "ra" })).toBe(1);
  expect(extractorSize(ingestP({ rid: "r-in" }))).toBe(1);
  expect(extractorSize(failureP())).toBe(1);
  expect(extractorSize(generateRetryP())).toBe(1);
  expect(
    extractorSize({ type: "Escalation", rid: "r-lim", header: "h", gateLabel: "g", hint: "" }),
  ).toBe(1);
});

/** 추출기 집합을 실렌더와 결박한 뒤 크기 반환(개별 카운트 assert 편의). */
function extractorSize(p: Presentation): number {
  return expectBinding(p).extracted.size;
}
