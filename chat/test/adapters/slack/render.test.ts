/**
 * render.test.ts — Slack 렌더러 검증(중립 Presentation → Block Kit 카드).
 *   구 adapter/slack/cards.test.ts 이관: 카드가 이제 ViewModel 이 아니라 **중립 Presentation** 으로 렌더된다.
 *   · 버튼 value 에 run_id·action(JSON.stringify) · 라벨 passthrough(트림 없음) · 버튼 style primary|danger|미지정.
 *   · 모달/슬래시/파일첨부 요소는 방출하지 않는다(공통분모 회귀 — Slack·GChat 교집합).
 */
import type { ButtonElement } from "chat";
import { expect, test } from "vitest";
import {
  renderApproveGate,
  renderConfirmGate,
  renderDone,
  renderEscalation,
  renderFailure,
  renderGenerateRetry,
  renderImageOptionSet,
  renderIngestPrompt,
  renderNlProposal,
  renderOptionSet,
  renderSetup,
  renderVerdict,
  toCard,
  toCards,
  GENERATE_RETRY_ACTION_ID,
  INGEST_STAGED_ACTION_ID,
  NL_INTAKE_CONFIRM_ACTION_ID,
  RA_CONFIRM_ACTION_ID,
  RECONCILE_ACTION_ID,
  SETUP_ACTION_IDS,
} from "../../../src/adapters/slack/render.js";
import type {
  ApproveGatePresentation,
  DonePresentation,
  FailurePresentation,
  GenerateRetryPresentation,
  ImageOptionSetPresentation,
  IngestPromptPresentation,
  NlProposalPresentation,
  OptionSetPresentation,
  SetupPresentation,
  VerdictPresentation,
} from "../../../src/kernel/presentation.js";

// ── 표현 팩토리(기본값 + 일부 덮어쓰기) ─────────────────────────────────────
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

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function walkTexts(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === "text" && typeof n.content === "string") out.push(n.content);
    if (Array.isArray(n.children)) for (const k of n.children) walkTexts(k, out);
  }
  return out;
}
function walkType<T>(node: unknown, type: string, out: T[] = []): T[] {
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === type) out.push(n as unknown as T);
    if (Array.isArray(n.children)) for (const k of n.children) walkType(k, type, out);
  }
  return out;
}
const walkButtons = (node: unknown): ButtonElement[] => walkType<ButtonElement>(node, "button");
function parseValue(b: ButtonElement): Record<string, unknown> {
  return JSON.parse(b.value ?? "{}") as Record<string, unknown>;
}
const OK_STYLES = new Set([undefined, "primary", "danger"]);

// ── 1. 새 작업 설정 카드 ─────────────────────────────────────────────────────
test("renderSetup: 카드 + Select 2개(도메인/포맷, placeholder 필수) + [시작] 버튼", () => {
  const card = renderSetup(setupP());
  expect((card as { type?: string }).type).toBe("card");
  const selects = walkType<{ id: string; options: { value: string }[]; placeholder?: string }>(card, "select");
  expect(selects.map((s) => s.id)).toEqual([SETUP_ACTION_IDS.domain, SETUP_ACTION_IDS.format]);
  for (const s of selects) expect((s.placeholder ?? "").length).toBeGreaterThan(0);
  expect(selects[0]!.options.map((o) => o.value)).toEqual(["화장품", "의약외품", "건기식", "의약품"]);
  expect(selects[1]!.options.map((o) => o.value)).toEqual(["한장", "여러장"]);
  const start = walkButtons(card).find((b) => b.id === SETUP_ACTION_IDS.start);
  expect(start).toBeDefined();
  expect(start!.style).toBe("primary");
});

test("renderSetup: 기존 선택은 initialOption(문자열 value)으로 반영", () => {
  const card = renderSetup(setupP({ domain: "화장품", format: "여러장" }));
  const selects = walkType<{ id: string; initialOption?: string }>(card, "select");
  expect(selects.find((s) => s.id === SETUP_ACTION_IDS.domain)?.initialOption).toBe("화장품");
  expect(selects.find((s) => s.id === SETUP_ACTION_IDS.format)?.initialOption).toBe("여러장");
});

test("renderSetup: 제품명 텍스트 입력 위젯이 없다(입력은 답글 — 공통분모)", () => {
  expect(walkType(renderSetup(setupP()), "text_input")).toHaveLength(0);
});

test("renderSetup: 제품명이 있으면 카드에 표시", () => {
  expect(walkTexts(renderSetup(setupP({ product: "이지듀 쿠션" }))).some((t) => t.includes("이지듀 쿠션"))).toBe(true);
});

// ── 2. RA 확인 카드 ──────────────────────────────────────────────────────────
test("renderConfirmGate: [확인 완료·승인](RA_CONFIRM_ACTION_ID) 버튼에 run_id · ra_ok 는 value 에 없음", () => {
  const card = renderConfirmGate({ type: "ConfirmGate", rid: "r-ra", kind: "ra" });
  const btn = walkButtons(card).find((b) => b.id === RA_CONFIRM_ACTION_ID);
  expect(btn).toBeDefined();
  expect(btn!.style).toBe("primary");
  const v = parseValue(btn!);
  expect(v).toEqual({ run_id: "r-ra", action: "approve" });
  expect(v.ra_ok).toBeUndefined();
});

// ── 3. 인입 카드 ─────────────────────────────────────────────────────────────
test("renderIngestPrompt: 붙여넣기 안내 + [붙여넣기 없이 진행](ingest) · 라벨 passthrough", () => {
  const card = renderIngestPrompt(ingestP({ rid: "r-in", gateLabel: "자료 차례", hint: "힌트!" }));
  const texts = walkTexts(card);
  expect(texts.some((t) => t.includes("답글로 붙여넣어"))).toBe(true);
  expect(texts).toContain("자료 차례");
  expect(texts).toContain("힌트!");
  const btn = walkButtons(card).find((b) => b.id === INGEST_STAGED_ACTION_ID);
  expect(btn).toBeDefined();
  expect(parseValue(btn!)).toEqual({ run_id: "r-in", action: "ingest" });
});

// ── 4. 승인/보완 카드 ────────────────────────────────────────────────────────
test("renderApproveGate: 헤더=header, 본문=gateLabel/hint passthrough(트림 없음)", () => {
  const card = renderApproveGate(approveP({ header: "  원문 그대로  ", gateLabel: "게이트 라벨 원문", hint: "힌트 원문" }));
  expect((card as { title?: string }).title).toBe("  원문 그대로  ");
  const texts = walkTexts(card);
  expect(texts).toContain("게이트 라벨 원문");
  expect(texts).toContain("힌트 원문");
});

test("renderApproveGate: [승인] 항상 노출 + value 에 run_id·action", () => {
  const approve = walkButtons(renderApproveGate(approveP({ rid: "ezderm-2026" }))).find((b) => b.id === "approve");
  expect(approve).toBeDefined();
  expect(approve!.style).toBe("primary");
  expect(parseValue(approve!)).toEqual({ run_id: "ezderm-2026", action: "approve" });
});

test("renderApproveGate: [보완]은 reviseAvailable 일 때만 노출", () => {
  expect(walkButtons(renderApproveGate(approveP({ reviseAvailable: false }))).some((b) => b.id === "revise")).toBe(false);
  const revise = walkButtons(renderApproveGate(approveP({ rid: "r7", reviseAvailable: true }))).find((b) => b.id === "revise");
  expect(revise).toBeDefined();
  expect(parseValue(revise!)).toEqual({ run_id: "r7", action: "revise" });
});

test("renderApproveGate: raOkRequired 면 RA 표시 + 승인 버튼에 ra_required 신호(ra_ok 직접 안 실음)", () => {
  expect(walkTexts(renderApproveGate(approveP({ raOkRequired: true }))).some((t) => t.includes("RA"))).toBe(true);
  expect(walkTexts(renderApproveGate(approveP({ raOkRequired: false }))).some((t) => t.includes("RA"))).toBe(false);
  const btn = walkButtons(renderApproveGate(approveP({ rid: "r-ra", raOkRequired: true }))).find((b) => b.id === "approve");
  const v = parseValue(btn!);
  expect(v).toEqual({ run_id: "r-ra", action: "approve", ra_required: true });
  expect(v.ra_ok).toBeUndefined();
});

// ── 5. 심의 verdict 카드 ─────────────────────────────────────────────────────
test("renderVerdict(pass): 🟢 통과 · 액션 버튼 없음", () => {
  const card = renderVerdict(verdictP({ outcome: "pass" }));
  expect(walkTexts(card).some((t) => t.includes("🟢"))).toBe(true);
  expect(walkButtons(card)).toHaveLength(0);
});

test("renderVerdict(revise): 🟠 + [보완 반영 재생성](primary) · 재생성(generate)+stage 트리거", () => {
  const card = renderVerdict(verdictP({ rid: "r-rev", outcome: "revise", stage: "brief" }));
  expect(walkTexts(card).some((t) => t.includes("🟠"))).toBe(true);
  const buttons = walkButtons(card);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.style).toBe("primary");
  expect(parseValue(buttons[0]!)).toEqual({ run_id: "r-rev", action: "generate", stage: "brief" });
});

test("renderVerdict(human): 🔴 + [담당자 호출](danger)", () => {
  const card = renderVerdict(verdictP({ rid: "r-esc", outcome: "human" }));
  expect(walkTexts(card).some((t) => t.includes("🔴"))).toBe(true);
  const buttons = walkButtons(card);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.style).toBe("danger");
});

// ── 6. 에스컬레이션 복구 카드 ────────────────────────────────────────────────
test("renderEscalation: [한 번 더 시도](raise-limit) 버튼 + 라벨 passthrough", () => {
  const card = renderEscalation({ type: "Escalation", rid: "r-lim", header: "라벨헤더", gateLabel: "라벨", hint: "힌트" });
  const btn = walkButtons(card).find((b) => b.id === "raise-limit");
  expect(btn).toBeDefined();
  expect(parseValue(btn!)).toEqual({ run_id: "r-lim", action: "raise-limit" });
});

// ── 6′. 실패 카드(Failure · 화해 버튼) ───────────────────────────────────────
function failureP(over: Partial<FailurePresentation> = {}): FailurePresentation {
  return { type: "Failure", rid: "r-fail", header: "핵심 정리", message: "생성을 마치지 못했습니다.", ...over };
}

test("renderFailure: 사유(passthrough) + [상태 다시 확인](reconcile) 버튼 1개", () => {
  const card = renderFailure(failureP());
  const texts = walkTexts(card);
  expect(texts).toContain("생성을 마치지 못했습니다."); // 워커 회신 그대로
  expect(texts.some((t) => t.includes("상태 다시 확인"))).toBe(true); // 왜 눌러야 하는지 안내
  const btns = walkButtons(card);
  expect(btns).toHaveLength(1);
  expect(btns[0]!.id).toBe(RECONCILE_ACTION_ID);
  expect(btns[0]!.label).toBe("상태 다시 확인");
  expect(parseValue(btns[0]!)).toEqual({ run_id: "r-fail", action: "reconcile" });
});

test("renderFailure: 승인/선택 같은 상태변이 버튼을 곁들이지 않는다(화해는 읽기 전용)", () => {
  const ids = walkButtons(renderFailure(failureP())).map((b) => b.id);
  expect(ids).not.toContain("approve");
  expect(ids).not.toContain("revise");
});

// ── 6″. 생성 재요청 카드(GenerateRetry · 회수된 요청의 출구) ─────────────────
function generateRetryP(over: Partial<GenerateRetryPresentation> = {}): GenerateRetryPresentation {
  return { type: "GenerateRetry", rid: "r-1", header: "핵심 정리", message: "아직 만들어지지 않았어요 — 다시 요청할 수 있어요.", stage: "brief", ...over };
}

test("renderGenerateRetry: 안내(passthrough) + [다시 만들기] 버튼 1개(stage 도장 동봉)", () => {
  const card = renderGenerateRetry(generateRetryP());
  const texts = walkTexts(card);
  expect(texts).toContain("아직 만들어지지 않았어요 — 다시 요청할 수 있어요."); // 커널 문구 그대로
  expect(texts.some((t) => t.includes("다시 만들기"))).toBe(true); // 왜 눌러야 하는지 안내
  const btns = walkButtons(card);
  expect(btns).toHaveLength(1);
  expect(btns[0]!.id).toBe(GENERATE_RETRY_ACTION_ID);
  expect(btns[0]!.label).toBe("다시 만들기");
  // 도장(stage) — 커널이 지금 단계와 대조해 옛 카드 클릭을 거른다.
  expect(parseValue(btns[0]!)).toEqual({ run_id: "r-1", action: "generate", stage: "brief" });
});

test("renderGenerateRetry: 승인/선택 같은 결정 버튼을 곁들이지 않는다(재요청은 생성뿐)", () => {
  const ids = walkButtons(renderGenerateRetry(generateRetryP())).map((b) => b.id);
  expect(ids).not.toContain("approve");
  expect(ids).not.toContain("revise");
});

test("toCard(GenerateRetry): 단일 카드", () => {
  expect(toCards(generateRetryP())).toHaveLength(1);
  expect(walkButtons(toCard(generateRetryP()))[0]!.id).toBe(GENERATE_RETRY_ACTION_ID);
});

test("toCard(Failure): 단일 카드", () => {
  expect((toCard(failureP()) as { type?: string }).type).toBe("card");
  expect(toCards(failureP())).toHaveLength(1);
});

// ── 7. 다안 md 선택 카드(OptionSet · P1) ─────────────────────────────────────
test("renderOptionSet: 안별 카드 1장 + 트레일링 카드 · [이걸로] 버튼이 안마다 {run_id, action, option}", () => {
  const cards = renderOptionSet(optionSetP());
  // 안 3개 → 안 카드 3 + 트레일링 액션 카드 1 = 4장.
  expect(cards).toHaveLength(4);
  for (const c of cards) expect((c as { type?: string }).type).toBe("card");
  // 안 카드마다 [이걸로] 버튼 1개, value 에 해당 옵션 키.
  const selectBtns = cards.flatMap((c) => walkButtons(c)).filter((b) => (b.id ?? "").startsWith("select-"));
  expect(selectBtns).toHaveLength(3);
  // stale 가드 도장(phase·iteration)이 안 버튼 value 마다 실린다.
  expect(selectBtns.map((b) => parseValue(b))).toEqual([
    { run_id: "run-1", action: "select", option: "A-efficacy", phase: "02-concept", iteration: 1 },
    { run_id: "run-1", action: "select", option: "B-safety", phase: "02-concept", iteration: 1 },
    { run_id: "run-1", action: "select", option: "C-science", phase: "02-concept", iteration: 1 },
  ]);
});

test("renderOptionSet: 추천 안 제목에만 추천 배지(⭐/추천)", () => {
  const cards = renderOptionSet(optionSetP());
  // 추천은 B-safety(2번째 안 카드). 배지가 그 카드 제목에만.
  const titles = cards.map((c) => (c as { title?: string }).title ?? "");
  const badged = titles.filter((t) => t.includes("추천") || t.includes("⭐"));
  expect(badged).toHaveLength(1);
  expect(badged[0]).toContain("안전 메시지");
});

test("renderOptionSet: [다시 제안]은 reviseAvailable 일 때만 · value={run_id, action:revise}", () => {
  const withRevise = renderOptionSet(optionSetP({ reviseAvailable: true }));
  const revise = withRevise.flatMap((c) => walkButtons(c)).find((b) => b.id === "revise");
  expect(revise).toBeDefined();
  expect(parseValue(revise!)).toEqual({ run_id: "run-1", action: "revise" });

  const noRevise = renderOptionSet(optionSetP({ reviseAvailable: false }));
  expect(noRevise.flatMap((c) => walkButtons(c)).some((b) => b.id === "revise")).toBe(false);
});

test("renderOptionSet: 안 body md 전문이 카드에 실린다(passthrough)", () => {
  const cards = renderOptionSet(optionSetP());
  const texts = cards.flatMap((c) => walkTexts(c));
  expect(texts.some((t) => t.includes("## A-efficacy"))).toBe(true);
  expect(texts.some((t) => t.includes("## B-safety"))).toBe(true);
});

test("toCards(OptionSet): 여러 카드 · 그 외 표현: 1장", () => {
  expect(toCards(optionSetP())).toHaveLength(4);
  expect(toCards(setupP())).toHaveLength(1);
});

// ── 7′. 다안 이미지 선택 카드(ImageOptionSet · P2) ───────────────────────────
test("renderImageOptionSet: 안별 선택 카드 + 트레일링 · [이걸로] value 에 {run_id, action, option, phase, iteration}(도장)", () => {
  const cards = renderImageOptionSet(imageOptionSetP());
  // 안 3개 → 안 카드 3 + 트레일링 액션 카드 1 = 4장.
  expect(cards).toHaveLength(4);
  for (const c of cards) expect((c as { type?: string }).type).toBe("card");
  const selectBtns = cards.flatMap((c) => walkButtons(c)).filter((b) => (b.id ?? "").startsWith("select-"));
  expect(selectBtns).toHaveLength(3);
  // stale 가드 도장(phase·iteration)이 안 버튼 value 마다 실린다(OptionSet 과 동일).
  expect(selectBtns.map((b) => parseValue(b))).toEqual([
    { run_id: "run-1", action: "select", option: "A", phase: "04-keyvisual", iteration: 1 },
    { run_id: "run-1", action: "select", option: "B", phase: "04-keyvisual", iteration: 1 },
    { run_id: "run-1", action: "select", option: "C", phase: "04-keyvisual", iteration: 1 },
  ]);
  for (const b of selectBtns) expect(b.style).toBe("primary");
});

test("renderImageOptionSet: 추천 안 제목에만 추천 배지 · 캡션이 카드에 실린다", () => {
  const cards = renderImageOptionSet(imageOptionSetP());
  const titles = cards.map((c) => (c as { title?: string }).title ?? "");
  const badged = titles.filter((t) => t.includes("추천") || t.includes("⭐"));
  expect(badged).toHaveLength(1); // 추천은 B
  expect(badged[0]).toContain("B안");
  const texts = cards.flatMap((c) => walkTexts(c));
  expect(texts.some((t) => t.includes("A안 · 이미지 1장"))).toBe(true);
  expect(texts.some((t) => t.includes("미리보기 없음"))).toBe(true); // C안(HTML만)
});

test("renderImageOptionSet: [다시 제안]은 reviseAvailable 일 때만 · value={run_id, action:revise}", () => {
  const revise = renderImageOptionSet(imageOptionSetP({ reviseAvailable: true }))
    .flatMap((c) => walkButtons(c))
    .find((b) => b.id === "revise");
  expect(revise).toBeDefined();
  expect(parseValue(revise!)).toEqual({ run_id: "run-1", action: "revise" });
  const noRevise = renderImageOptionSet(imageOptionSetP({ reviseAvailable: false }));
  expect(noRevise.flatMap((c) => walkButtons(c)).some((b) => b.id === "revise")).toBe(false);
});

test("renderImageOptionSet: 카드에 이미지 바이트/모달/파일입력 요소를 방출하지 않는다(순수 렌더 — 업로드는 transport)", () => {
  for (const c of renderImageOptionSet(imageOptionSetP())) {
    expect(walkType(c, "image")).toHaveLength(0); // 이미지 첨부는 transport 부수효과(렌더는 순수)
    expect(walkType(c, "text_input")).toHaveLength(0);
    expect(walkType(c, "file_input")).toHaveLength(0);
  }
});

test("toCards(ImageOptionSet): 여러 카드", () => {
  expect(toCards(imageOptionSetP())).toHaveLength(4);
});

// ── 7″. 완료(Done) 카드 ──────────────────────────────────────────────────────
test("renderDone: 완료 안내 + 산출물 경로(있으면) · 버튼 없음", () => {
  const card = renderDone(doneP({ files: ["04-keyvisual/export/kcia-package"] }));
  expect((card as { title?: string }).title).toBe("완료");
  const texts = walkTexts(card);
  expect(texts.some((t) => t.includes("마쳤"))).toBe(true);
  expect(texts).toContain("04-keyvisual/export/kcia-package");
  expect(walkButtons(card)).toHaveLength(0);
});

test("toCard(Done): 단일 카드", () => {
  expect((toCard(doneP()) as { type?: string }).type).toBe("card");
});

// ── 8. 공통분모 회귀 — 어떤 카드도 모달/파일입력 요소를 방출하지 않는다 ─────────
test("공통분모: 전 카드에 modal/text_input/file_input 요소 0 + 버튼 스타일 허용값만", () => {
  const cards = [
    toCard(setupP({ domain: "화장품" })),
    toCard({ type: "ConfirmGate", rid: "r", kind: "ra" }),
    toCard(ingestP()),
    toCard(approveP({ reviseAvailable: true, raOkRequired: true })),
    toCard({ type: "Progress", rid: "r", header: "h", message: "진행 중" }),
    toCard(failureP()),
    toCard(verdictP({ outcome: "revise", stage: "brief" })),
    toCard(verdictP({ outcome: "human" })),
    toCard({ type: "Escalation", rid: "r", header: "h", gateLabel: "g", hint: "" }),
    toCard(doneP({ files: ["a/b"] })),
    ...renderOptionSet(optionSetP()),
    ...renderImageOptionSet(imageOptionSetP()),
  ];
  for (const card of cards) {
    expect((card as { type?: string }).type).toBe("card");
    expect(walkType(card, "text_input")).toHaveLength(0);
    expect(walkType(card, "file_input")).toHaveLength(0);
    for (const b of walkButtons(card)) expect(OK_STYLES.has(b.style)).toBe(true);
  }
});

// ── P3. NL 이해 확인 카드(NlProposal) ────────────────────────────────────────
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

test("renderNlProposal(setup, 확정): 요약 + [시작] 버튼(setup_start·primary·value 없음)", () => {
  const card = renderNlProposal(nlSetupProposal());
  expect((card as { type?: string }).type).toBe("card");
  expect(walkTexts(card).some((t) => t.includes("화장품"))).toBe(true);
  const btns = walkButtons(card);
  expect(btns).toHaveLength(1);
  expect(btns[0]!.id).toBe(SETUP_ACTION_IDS.start);
  expect(btns[0]!.style).toBe("primary");
  expect(btns[0]!.value).toBeUndefined(); // 설정 [시작]은 pending 을 읽으므로 value 없음
});

test("renderNlProposal(미확신): 질문 텍스트 노출 + 방아쇠 버튼 없음", () => {
  const card = renderNlProposal(
    nlSetupProposal({ confirm: undefined, questions: ["결과물을 한 장으로 만들까요, 여러 장으로 만들까요?"] }),
  );
  expect(walkTexts(card).some((t) => t.includes("한 장"))).toBe(true);
  expect(walkButtons(card)).toHaveLength(0);
});

test("renderNlProposal(intake, 확정): [이 자료로 시작] 버튼 = NL_INTAKE_CONFIRM_ACTION_ID", () => {
  const card = renderNlProposal(
    nlSetupProposal({ kind: "intake", confirm: { actionId: NL_INTAKE_CONFIRM_ACTION_ID, label: "이 자료로 시작" } }),
  );
  const btn = walkButtons(card).find((b) => b.id === NL_INTAKE_CONFIRM_ACTION_ID);
  expect(btn).toBeDefined();
  expect(btn!.style).toBe("primary");
});

test("renderNlProposal: 모달/텍스트입력/파일입력 요소 0 + 버튼 스타일 허용값(NL 은 실행 안 함)", () => {
  for (const p of [nlSetupProposal(), nlSetupProposal({ confirm: undefined, questions: ["Q"] })]) {
    const card = renderNlProposal(p);
    expect(walkType(card, "text_input")).toHaveLength(0);
    expect(walkType(card, "file_input")).toHaveLength(0);
    for (const b of walkButtons(card)) expect(OK_STYLES.has(b.style)).toBe(true);
  }
});

test("toCard(NlProposal): 단일 카드", () => {
  expect((toCard(nlSetupProposal()) as { type?: string }).type).toBe("card");
  expect(toCards(nlSetupProposal())).toHaveLength(1);
});

// ── 9. Slack header 하드리밋(150자) clamp — 라이브 실측 회귀 ─────────────────────
//   카드 title 은 Slack header 블록(plain_text 최대 150자)으로 게시되며 SDK 전송 경로는 절단하지 않는다 —
//   151자 이상이면 Slack 이 invalid_blocks 로 post 전체를 거부한다(2026-07 데모 라이브: 03-storyboard 다안
//   제목 173자 → 안 카드 3장+트레일링 카드 소실 · WebClient "must be less than 151 characters").
const titleOf = (c: unknown): string => (c as { title?: string }).title ?? "";
// 라이브 실측 그대로의 173자 storyboard 전개 순서 제목(추천 배지 +7자 = 180자).
const STORYBOARD_TITLE =
  "hero → problem → socialProof → solution → rtbSummary → ingredientTech → clinicalEvidence → colorSwatch → reviewCapture → howToUse → targetAudience → brandTrust → buyingGuide";

test("renderOptionSet: 실측 173자 storyboard 제목 → 전 카드 title ≤150(clamp) · […] 말줄임 · body 전문 보존", () => {
  const body = `## A — 전개 순서\n${STORYBOARD_TITLE}`;
  const cards = renderOptionSet(
    optionSetP({
      options: [
        { key: "A", title: STORYBOARD_TITLE, body, recommended: true }, // 배지 포함 180자
        { key: "B", title: STORYBOARD_TITLE, body, recommended: false }, // 173자
      ],
    }),
  );
  for (const c of cards) expect(Array.from(titleOf(c)).length).toBeLessThanOrEqual(150);
  // clamp 된 안 제목은 말줄임으로 끝나고, 추천 배지는 살아남는다(앞에서 자른다).
  expect(titleOf(cards[0])).toMatch(/…$/);
  expect(titleOf(cards[0]).startsWith("⭐ 추천 · ")).toBe(true);
  // 정보 손실 0: body 가 전개 순서 전문을 그대로 담는다(전송 실패로 카드 소실되던 회귀의 반대 방향 잠금).
  const texts = cards.flatMap((c) => walkTexts(c));
  expect(texts.some((t) => t.includes(STORYBOARD_TITLE))).toBe(true);
});

test("renderOptionSet: clamp 됐는데 body 에 전문이 없으면 전문을 본문 첫 줄로 보존한다", () => {
  const longTitle = "가".repeat(200);
  const cards = renderOptionSet(
    optionSetP({ options: [{ key: "A", title: longTitle, body: "## A\n짧은 본문", recommended: false }] }),
  );
  expect(Array.from(titleOf(cards[0])).length).toBeLessThanOrEqual(150);
  expect(walkTexts(cards[0]!)).toContain(longTitle); // 전문 CardText 로 보존
});

test("전 렌더러: header 300자 passthrough 라도 카드 title 은 150자 이하(post 거부 방지)", () => {
  const long = "규제 상세페이지 단계 라벨 ".repeat(30); // 300자+
  const cards = [
    toCard(ingestP({ header: long })),
    toCard(approveP({ header: long })),
    toCard({ type: "Progress", rid: "r", header: long, message: "진행 중" }),
    toCard(failureP({ header: long })),
    toCard(generateRetryP({ header: long })),
    toCard(verdictP({ header: long })),
    toCard({ type: "Escalation", rid: "r", header: long, gateLabel: "g", hint: "" }),
    toCard(doneP({ header: long })),
    ...renderOptionSet(optionSetP({ header: long })),
    ...renderImageOptionSet(imageOptionSetP({ header: long })),
  ];
  for (const c of cards) expect(Array.from(titleOf(c)).length).toBeLessThanOrEqual(150);
});

test("150자 이하 title 은 바이트 불변(passthrough 유지 — clamp 는 한도 초과에만 개입)", () => {
  const exactly150 = "라".repeat(150);
  expect(titleOf(toCard(approveP({ header: exactly150 })))).toBe(exactly150);
  expect(titleOf(toCard(approveP({ header: "  원문 그대로  " })))).toBe("  원문 그대로  ");
});
