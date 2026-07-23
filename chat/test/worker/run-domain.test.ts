/**
 * run-domain.test.ts — 게이트웨이의 유일한 직접 state.json 읽기(도메인 한 필드)의 fail-closed 가드.
 *
 * 이 스위트가 지키는 것:
 *   1. **정상 경로** — `product.regulatory_domain` 을 그대로 돌려준다(그 한 필드만).
 *   2. **fail-closed** — 파일 부재·읽기 실패·JSON 손상·product 부재·도메인 부재/비문자열/형식 위반 = 전부 throw.
 *      이 값은 곧 `packs/<도메인>` 경로와 권한 규칙 문자열에 박히므로, 검증 안 된 값은 스폰 전에 끊는다.
 *   3. **조용한 cosmetic 폴백 없음** — 도메인이 없으면 던진다(AGENTS 8번 절 자세와 일치).
 *
 * 실 파일을 쓴다(임시 core 픽스처) — readDeclaredDomain 의 실제 읽기 경로를 그대로 탄다(seam 주입 아님).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DECLARED_DOMAIN_PATTERN, readDeclaredDomain } from "../../src/worker/run-domain.js";

let coreRoot: string;

/** 임시 core 아래 `runs/<rid>/state.json` 을 주어진 내용으로 만든다. content 가 undefined 면 파일을 안 만든다(부재 재현). */
function writeState(rid: string, content: string | undefined): void {
  const dir = join(coreRoot, "runs", rid);
  mkdirSync(dir, { recursive: true });
  if (content !== undefined) writeFileSync(join(dir, "state.json"), content, "utf8");
}

beforeAll(() => {
  coreRoot = mkdtempSync(join(tmpdir(), "chat-run-domain-"));
});
afterAll(() => {
  rmSync(coreRoot, { recursive: true, force: true });
});

describe("readDeclaredDomain — state.json 도메인 한 필드 읽기(읽기 전용 · fail-closed)", () => {
  test("정상: product.regulatory_domain 을 그대로 돌려준다(4종 형식)", async () => {
    for (const domain of ["cosmetic", "quasi_drug", "health_food", "drug"]) {
      const rid = `ok-${domain}`;
      writeState(rid, JSON.stringify({ product: { name: "x", regulatory_domain: domain } }));
      await expect(readDeclaredDomain(coreRoot, rid)).resolves.toBe(domain);
    }
  });

  test("state.json 이 다른 필드를 가져도 도메인만 소비한다(두 번째 진실을 만들지 않는다)", async () => {
    const rid = "ok-extra-fields";
    writeState(
      rid,
      JSON.stringify({
        workflow_id: rid,
        phase: "01-brief",
        gate: "user",
        product: { name: "x", regulatory_domain: "cosmetic", deliverable_format: "multipage_bm" },
      }),
    );
    await expect(readDeclaredDomain(coreRoot, rid)).resolves.toBe("cosmetic");
  });

  test("파일 부재 → throw(fail-closed · 조용한 기본값 없음)", async () => {
    writeState("no-state", undefined); // 디렉터리만 있고 state.json 없음
    await expect(readDeclaredDomain(coreRoot, "no-state")).rejects.toThrow(/읽을 수 없습니다/);
  });

  test("런 디렉터리 자체가 없어도 → throw", async () => {
    await expect(readDeclaredDomain(coreRoot, "nonexistent-run-xyz")).rejects.toThrow(/읽을 수 없습니다/);
  });

  test("JSON 손상 → throw", async () => {
    writeState("corrupt", "{ this is not json ");
    await expect(readDeclaredDomain(coreRoot, "corrupt")).rejects.toThrow(/JSON 파싱 실패/);
  });

  test("product 객체 부재 → throw", async () => {
    writeState("no-product", JSON.stringify({ workflow_id: "no-product" }));
    await expect(readDeclaredDomain(coreRoot, "no-product")).rejects.toThrow(/product 객체가 없습니다/);
  });

  test("도메인 미선언(부재) → throw(cosmetic 으로 조용히 폴백하지 않는다)", async () => {
    writeState("no-domain", JSON.stringify({ product: { name: "x" } }));
    await expect(readDeclaredDomain(coreRoot, "no-domain")).rejects.toThrow(/선언되지 않았거나/);
  });

  test("불안전 도메인 값(대문자·경로탈출·공백·비문자열) → throw", async () => {
    const bads: Array<unknown> = ["Cosmetic", "../packs/drug", "1drug", "quasi drug", "drug)", "", 42, null];
    for (const [i, bad] of bads.entries()) {
      const rid = `bad-domain-${i}`;
      writeState(rid, JSON.stringify({ product: { name: "x", regulatory_domain: bad } }));
      await expect(readDeclaredDomain(coreRoot, rid)).rejects.toThrow(/선언되지 않았거나/);
    }
  });

  test("불안전 rid → 파일 접촉 전에 throw(경로 탈출 차단)", async () => {
    for (const bad of ["", "../other", "rid with space", "rid;sh", ".."]) {
      await expect(readDeclaredDomain(coreRoot, bad)).rejects.toThrow(/run_id/);
    }
  });

  test("도메인 형식 패턴은 state.schema.json 과 같은 규칙의 미러다", () => {
    // 정상 4종 통과 · 대표 위반 거부(cli-session 의 DOMAIN_PATTERN 과도 같아야 한다 — 어긋나면 여기서 깨운다).
    for (const ok of ["cosmetic", "quasi_drug", "health_food", "drug"]) {
      expect(DECLARED_DOMAIN_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["Cosmetic", "1drug", "cosmetic-x", "../x", ""]) {
      expect(DECLARED_DOMAIN_PATTERN.test(bad)).toBe(false);
    }
  });
});
