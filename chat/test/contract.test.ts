/**
 * contract.test.ts — next-action 계약 픽스처 스냅샷 검증.
 *
 *   test/fixtures/next-action/*.json 은 core `scripts/next-action.sh <rid>` 가 대표 상태별로 내보낸
 *   한 줄 JSON 을 결정적으로 캡처한 것이다(재생성: test/fixtures/capture-fixtures.sh). 이 계약이
 *   챗 어댑터 버튼/카드의 단일 SSoT 이므로, 픽스처가 NextAction 계약(필드·enum·nullable)을 만족하고
 *   ViewModel 변환이 라벨을 '원문 그대로' 보존하는지 검증한다.
 *
 * 검증 축:
 *   1) 픽스처가 하나도 없으면 실패(회귀 방지 — 캡처 스크립트 미실행/오염 조기 발견).
 *   2) 각 픽스처: 필수 필드 존재 · action/phase/step/gate/status/awaiting/gate_type 가 enum 값 ·
 *      nullable/컬렉션 타입 규칙 위반 없음 · action 별 교차규칙(next-action.sh 로직과 정합).
 *   3) toViewModel 이 예외 없이 변환 + 라벨(phase_label·gate_label·hint·cmd) 원문 보존(passthrough).
 *
 * enum SSoT = core/harness/state.schema.json(= contract.ts 타입). 여기 배열은 그 미러이며,
 *   드리프트(core 가 enum 을 넓혔는데 픽스처가 새 값을 담음)는 '픽스처 값이 배열에 없음'으로 잡힌다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { toViewModel } from "../src/kernel/viewmodel.js";
import type {
  Action,
  Awaiting,
  Gate,
  GateType,
  NextAction,
  Phase,
  Status,
  Step,
} from "../src/types/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures/next-action");

// ── enum 미러(contract.ts / state.schema.json). 픽스처 값이 이 집합 안이어야 한다. ──
const ACTIONS: readonly Action[] = [
  "ingest",
  "generate",
  "review",
  "select",
  "approve",
  "raise-limit",
  "resume-approve",
  "resume-select",
  "done",
];
const PHASES: readonly Phase[] = [
  "00a-intake",
  "00-ingest",
  "00e-evidence",
  "00g-guideline",
  "01-brief",
  "02-concept",
  "03-storyboard",
  "04-keyvisual",
  "done",
];
const STEPS: readonly Step[] = ["generate", "review", "select", "human", "done"];
const GATES: readonly Gate[] = ["review", "user", "select", null];
const STATUSES: readonly Status[] = [
  "pending",
  "passed",
  "revise",
  "escalated",
  "approved",
  "changes_requested",
  "selected",
];
const AWAITINGS: readonly Awaiting[] = ["review", "user", "select", "none", null];
const GATE_TYPES: readonly GateType[] = ["auto", "human-verify", "setup", "hard-stop", null];

/** 픽스처 = 파일명 + 파싱된 원본(unknown — 런타임 검증 대상이라 캐스팅하지 않는다). */
interface Fixture {
  name: string;
  raw: unknown;
}

/** test/fixtures/next-action/*.json 을 이름순으로 로드(파싱 실패는 여기서 throw = 즉시 실패). */
function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      raw: JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown,
    }));
}

const fixtures = loadFixtures();

// ── 런타임 타입 가드 ──
const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === "number";
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 1) 회귀 방지: 픽스처가 최소 1개(캡처 스크립트가 실제로 산출물을 남겼는지) — 0개면 계약 검증이 무의미하다.
test("next-action 픽스처가 최소 1개 존재해야 한다(회귀 방지)", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)("계약 픽스처: $name", ({ raw }) => {
  test("최상위가 JSON 객체(배열/원시값 아님)", () => {
    expect(isPlainObject(raw)).toBe(true);
  });

  // 이후 테스트는 객체 전제 — 여기서 좁혀 NextAction 으로 다룬다(미지 필드는 index signature 로 허용).
  const na = raw as NextAction;

  test("필수 문자열/열거 필드 존재 + enum 값", () => {
    // 비-nullable 문자열: 존재 + string.
    expect(isString(na.rid) && na.rid.length > 0).toBe(true);
    expect(isString(na.phase_label) && na.phase_label.length > 0).toBe(true);
    expect(isString(na.cmd) && na.cmd.length > 0).toBe(true);
    expect(isString(na.gate_label)).toBe(true); // 라벨 — 원문(빈 문자열은 허용하되 string 이어야)
    expect(isString(na.hint)).toBe(true); // 힌트는 빈 문자열 가능
    // enum 필드(값이 계약 집합 안).
    expect(PHASES).toContain(na.phase);
    expect(STEPS).toContain(na.step);
    expect(STATUSES).toContain(na.status);
    expect(ACTIONS).toContain(na.action);
    expect(GATES).toContain(na.gate);
    expect(AWAITINGS).toContain(na.awaiting);
    expect(GATE_TYPES).toContain(na.gate_type);
  });

  test("nullable/컬렉션 타입 규칙 위반 없음", () => {
    expect(isNumberOrNull(na.iteration)).toBe(true);
    expect(isNumberOrNull(na.max_iterations)).toBe(true);
    expect(isStringOrNull(na.stage)).toBe(true);
    expect(na.needs === null || na.needs === "bundle_dir").toBe(true);
    expect(isStringArray(na.options)).toBe(true);
    expect(isStringOrNull(na.recommended)).toBe(true);
    expect(isBool(na.ra_ok_required)).toBe(true);
    expect(isBool(na.revise_available)).toBe(true);
    expect(isStringArray(na.files)).toBe(true);
    // stop_reason: null 또는 {code, summary} 최소 형태.
    expect(na.stop_reason === null || isPlainObject(na.stop_reason)).toBe(true);
    if (na.stop_reason !== null) {
      expect(isString(na.stop_reason.code)).toBe(true);
      expect(isString(na.stop_reason.summary)).toBe(true);
    }
    // advisory: null 또는 {must_fill[], nice_to_have[], completeness[]}.
    expect(na.advisory === null || isPlainObject(na.advisory)).toBe(true);
    if (na.advisory !== null) {
      expect(Array.isArray(na.advisory.must_fill)).toBe(true);
      expect(Array.isArray(na.advisory.nice_to_have)).toBe(true);
      expect(Array.isArray(na.advisory.completeness)).toBe(true);
    }
  });

  test("action 별 nullable 교차규칙(next-action.sh 분기와 정합)", () => {
    // needs 는 오직 action=ingest 일 때만 bundle_dir, 그 외 null.
    if (na.action === "ingest") {
      expect(na.needs).toBe("bundle_dir");
      expect(na.phase).toBe("00-ingest");
    } else {
      expect(na.needs).toBeNull();
    }
    // stage 는 오직 action=generate 일 때만 문자열, 그 외 null.
    if (na.action === "generate") {
      expect(isString(na.stage)).toBe(true);
    } else {
      expect(na.stage).toBeNull();
    }
    // select 는 carousel 옵션이 비어있으면 안 된다.
    if (na.action === "select") {
      expect(na.options.length).toBeGreaterThan(0);
    }
    // raise-limit 는 escalated 상태에서만.
    if (na.action === "raise-limit") {
      expect(na.status).toBe("escalated");
    }
    // done 은 done 페이즈에서만.
    if (na.action === "done") {
      expect(na.phase).toBe("done");
    }
  });

  test("toViewModel 무예외 변환 + 라벨 원문 보존(passthrough)", () => {
    const vm = toViewModel(na);
    // 기계용 분기 키/페이즈 보존.
    expect(vm.action).toBe(na.action);
    expect(vm.phase).toBe(na.phase);
    expect(vm.rid).toBe(na.rid);
    // 라벨 4종 — 원문 그대로(자체 번역/트림 금지).
    expect(vm.header).toBe(na.phase_label);
    expect(vm.gateLabel).toBe(na.gate_label);
    expect(vm.hint).toBe(na.hint);
    expect(vm.cmd).toBe(na.cmd);
    // 신호/컬렉션 매핑(값 보존).
    expect(vm.stage).toBe(na.stage);
    expect(vm.needs).toBe(na.needs);
    expect(vm.recommended).toBe(na.recommended);
    expect(vm.reviseAvailable).toBe(na.revise_available);
    expect(vm.raOkRequired).toBe(na.ra_ok_required);
    expect(vm.iteration).toBe(na.iteration);
    expect(vm.maxIterations).toBe(na.max_iterations);
    expect(vm.gateType).toBe(na.gate_type);
    expect(vm.stopReason).toEqual(na.stop_reason);
    expect(vm.advisory).toEqual(na.advisory);
    // 배열은 복사본이되 내용은 동일.
    expect(vm.options).toEqual(na.options);
    expect(vm.files).toEqual(na.files);
  });
});
