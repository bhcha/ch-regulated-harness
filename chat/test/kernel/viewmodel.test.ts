/**
 * viewmodel.test.ts — toViewModel 변환 검증.
 *   · 대표 action(approve·select·generate·raise-limit)별 필드 매핑.
 *   · 라벨 passthrough — header/gateLabel/hint/cmd 가 입력 JSON 문구 '그대로'(자체 번역/트림 없음).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { toViewModel } from "../../src/kernel/viewmodel.js";
import type { NextAction } from "../../src/types/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const approveFixture = JSON.parse(
  readFileSync(resolve(HERE, "../fixtures/next-action/01-guideline-approve.json"), "utf8"),
) as NextAction;

/** 픽스처 깊은 복사(테스트 간 격리 — 순수 JSON 이라 round-trip 안전). */
const base = (): NextAction => JSON.parse(JSON.stringify(approveFixture)) as NextAction;

test("approve: 라벨 passthrough + RA/보완 신호 노출", () => {
  const na = base(); // 픽스처가 action=approve
  const vm = toViewModel(na);
  expect(vm.action).toBe("approve");
  // 라벨 passthrough(원문 그대로).
  expect(vm.header).toBe(na.phase_label);
  expect(vm.gateLabel).toBe(na.gate_label);
  expect(vm.hint).toBe(na.hint);
  expect(vm.cmd).toBe(na.cmd);
  // approve 특성 신호.
  expect(vm.raOkRequired).toBe(na.ra_ok_required);
  expect(vm.reviseAvailable).toBe(na.revise_available);
});

test("select: options·recommended 노출 + 라벨 passthrough + 배열 복사본", () => {
  const na: NextAction = {
    ...base(),
    phase: "02-concept",
    phase_label: "컨셉 후보 라벨",
    action: "select",
    step: "select",
    gate: "select",
    status: "pending",
    options: ["A", "B", "C"],
    recommended: "B",
    gate_label: "고를 차례예요 라벨",
    hint: "힌트 원문",
    cmd: "bash scripts/select.sh rid <옵션>",
  };
  const vm = toViewModel(na);
  expect(vm.action).toBe("select");
  expect(vm.options).toEqual(["A", "B", "C"]);
  expect(vm.recommended).toBe("B");
  expect(vm.header).toBe("컨셉 후보 라벨");
  expect(vm.gateLabel).toBe("고를 차례예요 라벨");
  expect(vm.hint).toBe("힌트 원문");
  expect(vm.cmd).toBe("bash scripts/select.sh rid <옵션>");
  // 옵션은 복사본 — 뷰 변형이 원본 NextAction 을 오염시키지 않는다.
  vm.options.push("Z");
  expect(na.options).toEqual(["A", "B", "C"]);
});

test("generate: stage 노출 + 라벨 passthrough", () => {
  const na: NextAction = {
    ...base(),
    phase: "01-brief",
    phase_label: "브리프 라벨",
    action: "generate",
    step: "generate",
    gate: null,
    status: "pending",
    stage: "brief",
    options: [],
    recommended: null,
    gate_label: "만들 차례예요",
    hint: "",
    cmd: "bash scripts/run-stage.sh brief rid",
  };
  const vm = toViewModel(na);
  expect(vm.action).toBe("generate");
  expect(vm.stage).toBe("brief");
  expect(vm.header).toBe("브리프 라벨");
  expect(vm.gateLabel).toBe("만들 차례예요");
  expect(vm.hint).toBe(""); // 빈 힌트도 그대로
  expect(vm.cmd).toBe("bash scripts/run-stage.sh brief rid");
});

test("raise-limit: 반복 회차 노출 + 라벨 passthrough", () => {
  const na: NextAction = {
    ...base(),
    action: "raise-limit",
    status: "escalated",
    iteration: 3,
    max_iterations: 3,
    phase_label: "보완 한도 라벨",
    gate_label: "한도 상향 안내",
    hint: "",
    cmd: "bash scripts/run-stage.sh raise-limit rid",
  };
  const vm = toViewModel(na);
  expect(vm.action).toBe("raise-limit");
  expect(vm.iteration).toBe(3);
  expect(vm.maxIterations).toBe(3);
  expect(vm.header).toBe("보완 한도 라벨");
  expect(vm.gateLabel).toBe("한도 상향 안내");
  expect(vm.cmd).toBe("bash scripts/run-stage.sh raise-limit rid");
});

test("라벨 4종(phase_label·gate_label·hint·cmd)은 절대 변형되지 않는다(자체 번역/트림 금지)", () => {
  const na: NextAction = {
    ...base(),
    phase_label: "PL::원문 그대로 特殊문자 123",
    gate_label: "GL::原文 that must survive verbatim",
    hint: "HINT::  앞뒤 공백 포함  ", // 트림되면 실패
    cmd: "CMD::bash scripts/x.sh a b c",
  };
  const vm = toViewModel(na);
  expect(vm.header).toBe(na.phase_label);
  expect(vm.gateLabel).toBe(na.gate_label);
  expect(vm.hint).toBe(na.hint); // 공백 보존(트림 없음)
  expect(vm.cmd).toBe(na.cmd);
});
