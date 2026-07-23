/**
 * contract-client.test.ts — readNextAction 계약 검증.
 *   1) 픽스처 동형 JSON 파싱(전 필드 보존)
 *   2) 미지 top-level 필드 추가돼도 알려진 필드 보존 + 미지 필드 접근 가능(forward-compat)
 *   3) 비-0 종료 / 빈 출력 / 깨진 JSON = throw(종료코드·stderr 포함)
 *   4) 실제 spawn 배선(fake next-action.sh 셸 스크립트 + 기본 runner)
 * spawn 은 fake 로: (a) 주입 runner(순수 파싱), (b) 임시 core 의 fake 셸 스크립트(실 spawn).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type HarnessRunResult,
  readNextAction,
} from "../../src/kernel/contract-client.js";
import type { NextAction } from "../../src/types/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// 추적되는 픽스처(클린 체크아웃에서도 존재): test/gateway → test/fixtures/next-action
const FIXTURE_PATH = resolve(HERE, "../fixtures/next-action/01-guideline-approve.json");
const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(fixtureText) as NextAction;

/** 주입 runner 헬퍼(고정 결과 반환 — spawn 없이 파싱 로직만 검증). */
const runnerOf =
  (r: HarnessRunResult): ((rid: string) => Promise<HarnessRunResult>) =>
  () =>
    Promise.resolve(r);

test("픽스처 동형 JSON → NextAction 전 필드 보존(무손실)", async () => {
  const na = await readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: fixtureText, stderr: "" }));
  expect(na).toEqual(fixture); // 전 필드 deep-equal
  expect(na.action).toBe("approve");
  expect(na.phase_label).toBe(fixture.phase_label); // 라벨 원문 보존
  expect(na.gate_label).toBe(fixture.gate_label);
});

test("미지 top-level 필드가 추가돼도 알려진 필드 보존 + 미지 필드 접근 가능", async () => {
  const withExtra = { ...fixture, some_future_field: 42, nested_future: { a: 1 } };
  const na = await readNextAction(
    "chatfx-brief",
    runnerOf({ code: 0, stdout: JSON.stringify(withExtra), stderr: "" }),
  );
  // 알려진 필드는 그대로.
  expect(na.rid).toBe(fixture.rid);
  expect(na.action).toBe("approve");
  expect(na.gate_label).toBe(fixture.gate_label);
  expect(na.revise_available).toBe(fixture.revise_available);
  // 미지 필드도 index signature 로 보존(무시=버리지 않음).
  expect(na["some_future_field"]).toBe(42);
  expect(na["nested_future"]).toEqual({ a: 1 });
});

test("비-0 종료 → Error(종료코드·stderr 포함) throw", async () => {
  const runner = runnerOf({ code: 3, stdout: "", stderr: "run not found: bad" });
  await expect(readNextAction("bad", runner)).rejects.toThrow(/code=3/);
  await expect(readNextAction("bad", runner)).rejects.toThrow(/run not found: bad/);
});

test("빈 출력(code 0) → throw", async () => {
  await expect(readNextAction("x", runnerOf({ code: 0, stdout: "   \n ", stderr: "" }))).rejects.toThrow(
    /빈 출력/,
  );
});

test("깨진 JSON → 파싱 실패 throw", async () => {
  await expect(readNextAction("x", runnerOf({ code: 0, stdout: "{not json", stderr: "" }))).rejects.toThrow(
    /파싱 실패/,
  );
});

test("JSON 이 객체가 아니면(배열) throw", async () => {
  await expect(readNextAction("x", runnerOf({ code: 0, stdout: "[1,2,3]", stderr: "" }))).rejects.toThrow(
    /객체가 아닙니다/,
  );
});

test("빈 rid → throw", async () => {
  await expect(readNextAction("")).rejects.toThrow(/run_id/);
});

// ── 필수 계약 필드 검증(퇴화 응답이 '전이 완료'로 오독되는 구멍 차단) ──
//   '객체다'만으로는 부족 — 필드가 빠진 next-action 은 소비자에서 isGenerateTurn==false 로 읽혀
//   미전이 잡을 성공으로 삭제한다. 안전 해석 불가 = throw(fail-closed).
test("퇴화 {} → throw(안전 해석 불가 · 전이 완료로 오독 방지)", async () => {
  await expect(
    readNextAction("x", runnerOf({ code: 0, stdout: "{}", stderr: "" })),
  ).rejects.toThrow(/rid 불일치/);
});

test("rid 불일치(봉투가 다른 rid 를 echo) → throw", async () => {
  const wrongRid = { ...fixture, rid: "someone-else" };
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(wrongRid), stderr: "" })),
  ).rejects.toThrow(/rid 불일치/);
});

test("step 누락 → throw", async () => {
  const { step: _drop, ...noStep } = fixture; // step 제거
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(noStep), stderr: "" })),
  ).rejects.toThrow(/step/);
});

test("action 누락 → throw", async () => {
  const { action: _drop, ...noAction } = fixture; // action 제거
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(noAction), stderr: "" })),
  ).rejects.toThrow(/action/);
});

test("stage 가 문자열/null 이 아니면(숫자) → throw", async () => {
  const badStage = { ...fixture, stage: 42 };
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(badStage), stderr: "" })),
  ).rejects.toThrow(/stage/);
});

// ── enum 멤버십 검증(HIGH #1: 부분/오류 객체가 '전이 완료'로 오독되는 구멍 차단) ──
//   step·action 은 계약상 enum(contract.ts Step·Action)이다 — '비어있지 않은 문자열'만으론 부족하다.
//   미지 값이 통과하면 소비자 isGenerateTurn 이 generate 아님으로 읽어 미전이 잡을 성공 삭제한다.
test("step 이 enum 밖 값(unknown) → throw(오탈자/퇴화 봉투 차단)", async () => {
  const bogus = { ...fixture, step: "unknown" };
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(bogus), stderr: "" })),
  ).rejects.toThrow(/step/);
});

test("action 이 enum 밖 값(unknown) → throw(오탈자/퇴화 봉투 차단)", async () => {
  const bogus = { ...fixture, action: "unknown" };
  await expect(
    readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: JSON.stringify(bogus), stderr: "" })),
  ).rejects.toThrow(/action/);
});

// ── 교차규칙 검증(action=generate ⟹ stage 는 non-empty 문자열) ──
//   step·action 은 유효 enum 이지만 generate 인데 stage 가 없으면 어느 단계를 만들지 모르는 퇴화 봉투다.
//   느슨한 검증에선 통과 → isGenerateTurn(stage 불일치)=false → '전이 완료'로 오독(HIGH #1 핵심 구멍). fail-closed.
test("action=generate 인데 stage=null(부분 객체) → throw(전이 완료로 오독 방지)", async () => {
  const partial = { rid: "r", step: "generate", action: "generate", stage: null };
  await expect(
    readNextAction("r", runnerOf({ code: 0, stdout: JSON.stringify(partial), stderr: "" })),
  ).rejects.toThrow(/stage/);
});

test("action=generate 인데 stage='' (빈 문자열) → throw(교차규칙)", async () => {
  const partial = { rid: "r", step: "generate", action: "generate", stage: "" };
  await expect(
    readNextAction("r", runnerOf({ code: 0, stdout: JSON.stringify(partial), stderr: "" })),
  ).rejects.toThrow(/stage/);
});

test("action=generate + 실제 stage → 통과(정당한 생성 봉투 · over-tighten 아님)", async () => {
  const genFix = { ...fixture, step: "generate", action: "generate", stage: "brief" };
  const na = await readNextAction(
    "chatfx-brief",
    runnerOf({ code: 0, stdout: JSON.stringify(genFix), stderr: "" }),
  );
  expect(na.action).toBe("generate");
  expect(na.stage).toBe("brief");
});

test("stage: null → OK(계약상 nullable — over-tighten 아님)", async () => {
  // 픽스처 자체가 stage:null 이므로 그대로 통과해야 한다.
  const na = await readNextAction("chatfx-brief", runnerOf({ code: 0, stdout: fixtureText, stderr: "" }));
  expect(na.stage).toBeNull();
  expect(na.action).toBe("approve");
});

test("완전한 봉투 + 미지 top-level 필드 → 통과 & 미지 필드 보존(forward-compat 회귀 가드)", async () => {
  const withExtra = { ...fixture, brand_new_top_field: "keep-me" };
  const na = await readNextAction(
    "chatfx-brief",
    runnerOf({ code: 0, stdout: JSON.stringify(withExtra), stderr: "" }),
  );
  // 필수 필드 검증을 통과하면서도 미지 필드는 버리지 않는다.
  expect(na.action).toBe("approve");
  expect(na["brand_new_top_field"]).toBe("keep-me");
});

describe("실제 spawn 배선(기본 runner + fake next-action.sh)", () => {
  let fakeRoot: string;
  let savedRoot: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.HARNESS_ROOT;
    fakeRoot = mkdtempSync(join(tmpdir(), "chat-cc-"));
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.HARNESS_ROOT;
    else process.env.HARNESS_ROOT = savedRoot;
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  const writeScript = (body: string): void =>
    writeFileSync(join(fakeRoot, "scripts", "next-action.sh"), `#!/usr/bin/env bash\n${body}\n`);

  test("bash <root>/scripts/next-action.sh <rid> → stdout JSON 파싱(+인자 전달)", async () => {
    // rid 를 그대로 echo 로 실어 '인자 전달'까지 검증(printf %s ← $1).
    writeScript(
      `printf '{"rid":"%s","phase":"01-brief","phase_label":"L","step":"generate","gate":null,` +
        `"status":"pending","awaiting":null,"iteration":null,"max_iterations":null,"action":"generate",` +
        `"stage":"brief","needs":null,"options":[],"recommended":null,"ra_ok_required":false,` +
        `"revise_available":false,"gate_type":null,"stop_reason":null,"advisory":null,"cmd":"c",` +
        `"gate_label":"G","hint":"","files":[]}' "$1"`,
    );
    process.env.HARNESS_ROOT = fakeRoot;
    const na = await readNextAction("wired-rid");
    expect(na.rid).toBe("wired-rid"); // 인자가 스크립트에 전달됨
    expect(na.action).toBe("generate");
    expect(na.stage).toBe("brief");
  });

  test("비-0 종료 스크립트 → throw(code+stderr)", async () => {
    writeScript(`echo "boom-from-script" >&2\nexit 7`);
    process.env.HARNESS_ROOT = fakeRoot;
    await expect(readNextAction("x")).rejects.toThrow(/code=7/);
    await expect(readNextAction("x")).rejects.toThrow(/boom-from-script/);
  });
});
