/**
 * a2ui-surface-client.test.ts — readA2uiSurface 계약 검증(주입 runner · 실 spawn 0).
 *   contract-client 와 미러하되 **best-effort**: 어떤 실패든 throw 하지 않고 null 을 돌려준다(파생 뷰 폴백).
 *   검증: 정상 파싱(미지 필드 보존) · rid 불일치→null · 비-0→null · 빈출력→null · 파싱실패→null ·
 *         비-객체(배열/원시)→null · spawn error(runner reject)→null · 안전하지 않은 rid→null.
 *   SSoT = core/scripts/lib/a2ui_surface.py.
 */
import { describe, expect, test } from "vitest";
import { type SurfaceRunResult, readA2uiSurface } from "../../src/kernel/a2ui-surface-client.js";

/** 주입 runner 헬퍼(고정 결과 반환 — spawn 없이 파싱/폴백 분기만 검증). */
const runnerOf =
  (r: SurfaceRunResult): ((rid: string) => Promise<SurfaceRunResult>) =>
  () =>
    Promise.resolve(r);

/** a2ui-surface.sh 정상 표면(approve 게이트) 픽스처 — derive() 반환 dict 형태. */
const surfaceFor = (rid: string): Record<string, unknown> => ({
  a2ui_version: "1",
  catalogId: "kcia-a2ui-v1",
  rid,
  phase: "01-brief",
  phase_label: "핵심 정리",
  gate: "user",
  status: "pending",
  surface: "approve",
  step: null,
  needs_approve_after_select: false,
  action: "approve",
  actions: ["approve", "revise"],
  options: [],
  recommended: null,
  revise_available: true,
  ra_ok_required: false,
  components: [{ type: "Text" }],
});

describe("readA2uiSurface — best-effort 읽기 표면", () => {
  test("정상 한 줄 JSON → A2uiSurface(명시 필드 + 미지 필드 보존)", async () => {
    const s = surfaceFor("chat-brief");
    const surf = await readA2uiSurface("chat-brief", runnerOf({ code: 0, stdout: JSON.stringify(s) + "\n", stderr: "" }));
    expect(surf).not.toBeNull();
    expect(surf!.rid).toBe("chat-brief");
    expect(surf!.surface).toBe("approve");
    expect(surf!.actions).toEqual(["approve", "revise"]);
    expect(surf!.revise_available).toBe(true);
    expect(surf!.ra_ok_required).toBe(false);
    // forward-compat: derive() 의 미지 top-level 필드도 index signature 로 보존.
    expect(surf!["catalogId"]).toBe("kcia-a2ui-v1");
    expect(surf!["components"]).toEqual([{ type: "Text" }]);
  });

  test("rid 불일치(봉투가 다른 rid echo) → null(신뢰 불가)", async () => {
    const s = surfaceFor("someone-else");
    expect(await readA2uiSurface("chat-brief", runnerOf({ code: 0, stdout: JSON.stringify(s), stderr: "" }))).toBeNull();
  });

  test("비-0 종료 → null(throw 아님)", async () => {
    expect(await readA2uiSurface("x", runnerOf({ code: 2, stdout: "", stderr: "boom" }))).toBeNull();
  });

  test("빈 출력(code 0) → null", async () => {
    expect(await readA2uiSurface("x", runnerOf({ code: 0, stdout: "   \n ", stderr: "" }))).toBeNull();
  });

  test("깨진 JSON → null(파싱 실패 흡수)", async () => {
    expect(await readA2uiSurface("x", runnerOf({ code: 0, stdout: "{not json", stderr: "" }))).toBeNull();
  });

  test("JSON 이 객체 아님(배열/원시값) → null", async () => {
    expect(await readA2uiSurface("x", runnerOf({ code: 0, stdout: "[1,2,3]", stderr: "" }))).toBeNull();
    expect(await readA2uiSurface("x", runnerOf({ code: 0, stdout: "42", stderr: "" }))).toBeNull();
    expect(await readA2uiSurface("x", runnerOf({ code: 0, stdout: '"str"', stderr: "" }))).toBeNull();
  });

  test("spawn error(runner reject) → null(예외 승격 안 함 · 렌더 안 깸)", async () => {
    const rejecting = (): Promise<SurfaceRunResult> => Promise.reject(new Error("bash 없음"));
    expect(await readA2uiSurface("x", rejecting)).toBeNull();
  });

  test("runner 동기 throw(harnessRoot() 미주입 모사) → null", async () => {
    const throwing = (): Promise<SurfaceRunResult> => {
      throw new Error("HARNESS_ROOT 미주입");
    };
    expect(await readA2uiSurface("x", throwing)).toBeNull();
  });

  test("안전하지 않은 rid(빈/경로위험) → null(spawn 도 안 탐)", async () => {
    let called = false;
    const spy = (): Promise<SurfaceRunResult> => {
      called = true;
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };
    expect(await readA2uiSurface("", spy)).toBeNull();
    expect(await readA2uiSurface("../escape", spy)).toBeNull();
    expect(await readA2uiSurface(".", spy)).toBeNull();
    expect(called).toBe(false); // 경로-안전 검증이 runner 앞단에서 차단
  });

  test("앞줄이 없어도 정상 — a2ui-surface.sh 는 한 줄 JSON 만 방출(마지막-줄 파싱 아님)", async () => {
    // contract-client 처럼 stdout 전체를 파싱한다(a2ui-surface.sh 는 next-action.sh 처럼 순수 한 줄 JSON).
    const s = surfaceFor("r1");
    const surf = await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s), stderr: "" }));
    expect(surf!.rid).toBe("r1");
  });

  // ── 소비 필드 형태 불일치 → null(best-effort 계약 · 렌더 유실 방지) ──────────────────
  //   근거: 비-null 을 돌려주면 소비부(approveP 등)가 surface.actions.includes(...)·surface.ra_ok_required 를
  //   가드 없이 읽는다 — 형태가 어긋나면 그 접근이 throw 해 카드가 사라진다(na 폴백이 아니라 렌더 유실).
  //   그래서 소비 필드는 이 단일 경계에서 형태 보장하고, 어긋나면 null 로 환원해 소비부가 na.* 로 폴백하게 한다.
  test("rid 일치하지만 actions 누락 → null(가드 없는 .includes throw 방지)", async () => {
    const s = surfaceFor("r1");
    delete (s as Record<string, unknown>).actions;
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s), stderr: "" }))).toBeNull();
  });

  test("actions 가 배열 아님(문자열/객체) → null", async () => {
    const s1 = { ...surfaceFor("r1"), actions: "approve" };
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s1), stderr: "" }))).toBeNull();
    const s2 = { ...surfaceFor("r1"), actions: { approve: true } };
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s2), stderr: "" }))).toBeNull();
  });

  test("actions 배열이나 원소가 비-문자열(iterate/includes 오염) → null", async () => {
    const s = { ...surfaceFor("r1"), actions: ["approve", 42] };
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s), stderr: "" }))).toBeNull();
  });

  test("ra_ok_required 가 boolean 아님(누락/문자열/숫자) → null", async () => {
    const s0 = surfaceFor("r1");
    delete (s0 as Record<string, unknown>).ra_ok_required;
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s0), stderr: "" }))).toBeNull();
    const s1 = { ...surfaceFor("r1"), ra_ok_required: "false" };
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s1), stderr: "" }))).toBeNull();
    const s2 = { ...surfaceFor("r1"), ra_ok_required: 0 };
    expect(await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s2), stderr: "" }))).toBeNull();
  });

  test("빈 actions 배열 + ra_ok_required=false 는 유효(정상 통과 · over-tighten 아님)", async () => {
    const s = { ...surfaceFor("r1"), actions: [], ra_ok_required: false };
    const surf = await readA2uiSurface("r1", runnerOf({ code: 0, stdout: JSON.stringify(s), stderr: "" }));
    expect(surf).not.toBeNull();
    expect(surf!.actions).toEqual([]);
  });

  test("runner 가 멈추면 timeoutMs 로 bound → null(best-effort '렌더 안 막음' 계약이 hang 에도 성립)", async () => {
    // runner 가 영영 resolve 안 함(a2ui-surface.sh 스톨 모사) — reader race 가 null 로 환원해 승인/선택 카드가 막히지 않는다.
    const hanging = (): Promise<SurfaceRunResult> => new Promise<SurfaceRunResult>(() => {});
    expect(await readA2uiSurface("r1", hanging, 5)).toBeNull();
  });
});
