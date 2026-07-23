/**
 * support.ts — 인수 시나리오(W-C) 공용 격리·env 헬퍼. **테스트 파일이 아니다**(`.accept.test.ts` 접미어 없음 →
 *   accept 러너 include 밖 · standalone `test/**\/*.test.ts` 밖 · e2e `test/e2e/**` 밖 → 수집되지 않고 import 만 된다).
 *
 * mention-to-brief.accept.test.ts(S2)의 격리·env 셋업을 **정확히 미러**해 W-C 드라이버 시나리오(①/보완/stale/에스컬레이션)가
 *   같은 함정 회피를 공유한다(계획 6 · 리포 메모리):
 *   · 전용 CHAT_STATE_DIR/CHAT_DATA_DIR/HARNESS_EXAMPLES_DIR(mktemp) — 시나리오 간·기존 e2e 와 격리.
 *   · **빈** HARNESS_EXAMPLES_DIR → 00g-guideline 생략(00g 금지토큰 stall · ci-examples 오염 회피 · 함정 4).
 *   · WB 스테이징 = packs/cosmetic/samples/working-backwards.md(없으면 동등한 빈 템플릿) — 게이트웨이 인입 fail-closed 통과.
 *   · env 는 드라이버/게이트웨이 생성 **전에** set(config 게터는 호출 시 env 를 읽는다 — 함정 5). CHAT_APPROVERS =
 *     actor 끝 user id(워커 config.isApprover 가 approve/select 잡을 거부하지 않게 — S2 핵심 발견).
 *   · afterAll rmSync(temp + core run dir · macOS ENOTEMPTY 1회 재시도).
 *
 * oracle 순환 금지(계획 2-1): 이 헬퍼는 격리·입력만 준비한다 — 기대 화면은 시나리오가 core next-action(readNa)에서 읽는다.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 주입된 core 체크아웃(HARNESS_ROOT). 미주입이면 시나리오가 '보이게' 생략한다(조용한 통과 금지). */
export const CORE = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : "";
export const SKIP = CORE === "";

/** sanctioned 인입 픽스처(brief 를 통과시키는 번들 · brief-flow 선례). */
export const BUNDLE = SKIP ? "" : join(CORE, "tests/fixtures/bundle-cosmetic");
/** ingest-bundle 기본 WB(빈 템플릿 · packs). 게이트웨이 인입에 스테이징한다. */
const SAMPLE_WB = SKIP ? "" : resolve(CORE, "..", "packs/cosmetic/samples/working-backwards.md");

/**
 * 트랜스크립트 아티팩트 기록기(opt-in · no-leak). `CHAT_ACCEPT_ARTIFACT_DIR` 이 **설정됐을 때만**
 *   `${CHAT_ACCEPT_ARTIFACT_DIR}/<name>.jsonl` 에 결정론 JSONL(Transcript.toJSONL())을 쓴다(mkdir -p).
 *   env 미설정이면 **no-op** — 그래서 standalone `pnpm test`(이 파일들은 애초에 제외)나 env 없는 `pnpm test:accept`
 *   실행은 아무 파일도 남기지 않는다(결정론·골든/CI diff 불변·부수 파일 0). env 를 set 하는 건 verify.sh 하나뿐이고,
 *   그 디렉터리(`.acceptance-artifacts/`)는 .gitignore 로 제외돼 core 무수정 증명·작업트리를 더럽히지 않는다.
 *   이 JSONL 은 ①CI 구조 assert 재료이자 ②사람/AI 판독 아티팩트다(계획 2-2 · 4).
 * @param name 아티팩트 파일 basename(시나리오별 유일 · 확장자 제외).
 * @param jsonl `driver.transcript.toJSONL()` 결과(결정론 직렬화).
 */
export function writeTranscriptArtifact(name: string, jsonl: string): void {
  const dir = process.env.CHAT_ACCEPT_ARTIFACT_DIR;
  if (!dir) return; // opt-in — env 없으면 아무것도 안 쓴다(no-op).
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), jsonl);
}

/** rmSync 내성 래퍼(macOS ENOTEMPTY 1회 재시도 · 다른 e2e 패턴). */
export function rmBestEffort(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** 격리 핸들 — 시나리오가 stagedWb/stateDir 를 드라이버에 넘기고 cleanup 으로 정리한다. */
export interface TempHarness {
  stateDir: string;
  dataDir: string;
  examplesDir: string;
  wbDir: string;
  /** 스테이징된 워킹백워드 .md 절대경로(SurfaceDriver.stagedWbPath). */
  stagedWb: string;
  /** temp 디렉터리 + (rid 주면) core run dir 정리 + 이 헬퍼가 set 한 env 삭제. */
  cleanup(rid?: string): void;
}

/**
 * 드라이버 시나리오용 격리·env 셋업(S2 미러). **드라이버/게이트웨이 생성 전에** 호출한다(함정 5).
 * @param prefix mktemp 접두어(시나리오별 유일).
 * @param approverUid CHAT_APPROVERS 에 넣을 actor 끝 user id(=actorUserId(actor)).
 */
export function setupDriverHarness(prefix: string, approverUid: string): TempHarness {
  process.env.HARNESS_OFFLINE = "1";
  process.env.HARNESS_ROOT = CORE;
  process.env.CHAT_APPROVERS = approverUid;
  const stateDir = mkdtempSync(join(tmpdir(), `${prefix}-state-`));
  const dataDir = mkdtempSync(join(tmpdir(), `${prefix}-data-`));
  const examplesDir = mkdtempSync(join(tmpdir(), `${prefix}-ex-`)); // 빈 = 00g 생략
  const wbDir = mkdtempSync(join(tmpdir(), `${prefix}-wb-`));
  process.env.CHAT_STATE_DIR = stateDir;
  process.env.CHAT_DATA_DIR = dataDir;
  process.env.HARNESS_EXAMPLES_DIR = examplesDir;
  const stagedWb = join(wbDir, "working-backwards.md");
  if (existsSync(SAMPLE_WB)) cpSync(SAMPLE_WB, stagedWb);
  else writeFileSync(stagedWb, "# 워킹백워드\n\n제품유형:\n타깃:\n핵심 효능(+근거):\n차별점:\n사용법:\n");
  return {
    stateDir,
    dataDir,
    examplesDir,
    wbDir,
    stagedWb,
    cleanup(rid?: string): void {
      if (rid) rmBestEffort(join(CORE, "runs", rid));
      rmBestEffort(stateDir);
      rmBestEffort(dataDir);
      rmBestEffort(examplesDir);
      rmBestEffort(wbDir);
      delete process.env.HARNESS_OFFLINE;
      delete process.env.CHAT_STATE_DIR;
      delete process.env.CHAT_DATA_DIR;
      delete process.env.HARNESS_EXAMPLES_DIR;
      delete process.env.CHAT_APPROVERS;
    },
  };
}
