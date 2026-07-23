/**
 * kernel-neutral.test.ts — 헥사고날 회귀 가드: **커널과 무인 워커는 어떤 플랫폼도 모른다**.
 *
 * chat-hexagonal-gateway-plan 3장(P0 DoD): "커널에 플랫폼 단어 0 (lint 성 grep 가드: kernel/ 안
 *   slack|gchat|block kit 검출 시 실패)". 단, 설계를 '설명하는' 주석에서 플랫폼을 예시로 드는 것은
 *   허용한다(그건 결합이 아니다). 이 가드는 **비-주석 코드**에서 플랫폼 토큰을 찾는다 — 실제 결합
 *   (import·문자열 리터럴·API 호출)만 실패시킨다.
 *
 * ⚠ **src/worker/ 도 같은 규율을 진다**(W3~): 무인 세션 러너·supervisor 는 core 를 spawn 하고 next-action 을
 *   읽을 뿐 어느 챗 플랫폼도 몰라야 한다(잡큐 파일이 유일한 이음새 · 봇/데몬/사람 소비자 공용). 플랫폼이 새어들면
 *   무인 워커가 특정 어댑터에 묶여 재사용·이식성이 깨진다 → 커널과 함께 스캔한다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const KERNEL_DIR = join(SRC_DIR, "kernel");
const WORKER_DIR = join(SRC_DIR, "worker");
const ACCEPTANCE_DIR = join(SRC_DIR, "acceptance");
/**
 * 플랫폼-중립을 요구하는 디렉터리(커널 + 무인 워커 + 인수 하네스).
 *   src/acceptance/(RecordingChatPort·transcript·driver·추출기·분석기)도 어떤 챗 플랫폼도 몰라야 한다 —
 *   실행 백엔드만 스왑하는 공용 하네스라 특정 어댑터에 묶이면 라이브 재사용·이식성이 깨진다.
 */
const NEUTRAL_DIRS = [KERNEL_DIR, WORKER_DIR, ACCEPTANCE_DIR];

/** 플랫폼 결합 신호(대소문자 무시). "chat"(SDK 제네릭)·"chat:auto" 는 플랫폼 아님 — 포함하지 않는다. */
const FORBIDDEN = /slack|gchat|google ?chat|block ?kit|@chat-adapter|socket ?mode|files_upload|createSlackAdapter/i;

/** 주석 라인 판정(블록 주석 본문 ` * `·여는 `/*`·`/**`·줄 주석 `//`·빈 줄). */
function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** src/kernel/ 하위 .ts 전부(재귀). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("커널·무인워커 플랫폼-중립 가드(구조 분리 회귀)", () => {
  it("src/kernel/ · src/worker/ 코드(주석 제외)에 플랫폼 결합 토큰이 없다", () => {
    const offenders: string[] = [];
    for (const dir of NEUTRAL_DIRS) {
      for (const file of tsFiles(dir)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (isCommentOrBlank(line)) return;
          // 코드 라인의 트레일링 줄-주석(// …)은 떼고 검사(설명 주석 허용).
          const code = line.split("//")[0];
          if (FORBIDDEN.test(code)) offenders.push(`${file.split("/src/")[1]}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("커널 파일이 최소 하나 이상 스캔된다(가드 자체 sanity)", () => {
    expect(tsFiles(KERNEL_DIR).length).toBeGreaterThan(5);
  });

  it("무인 워커 파일도 스캔 대상에 실제로 잡힌다(가드가 src/worker/ 를 비껴가지 않는다)", () => {
    // supervisor·cli-session-runner·run-domain 등이 반드시 스캔된다 — 폴더 오타로 조용히 0개 스캔되는 것을 막는다.
    expect(tsFiles(WORKER_DIR).length).toBeGreaterThan(2);
  });

  it("인수 하네스(src/acceptance/) 도 스캔 대상에 실제로 잡힌다(가드가 비껴가지 않는다)", () => {
    // recording-port·transcript(+affordances) 가 반드시 스캔된다 — acceptance 하네스가 플랫폼-중립인지 상시 강제.
    expect(tsFiles(ACCEPTANCE_DIR).length).toBeGreaterThan(0);
  });
});
