/**
 * intake.ts — 인입 로직(챗-중립).
 *
 * 역할: 현업이 스레드에 올린 워킹백워드 첨부(.md/.docx)를 로컬 data 로 저장하고,
 *   ingest 잡(kind="ingest")을 만들어 JobSubmitter 로 넘긴다(ack-후-비동기 — 여기서 셸 spawn 하지 않는다).
 *   번들 폴더는 운영자가 사전 준비한 절대경로를 payload 로 통과시킨다(현업 로컬경로 입력 폐기, 계획 8장).
 *
 * 불변식: state.json 직접 쓰기 0. 실제 인입 실행(ingest-bundle.sh)은 워커가 잡을 소비해 수행한다.
 *   Slack SDK 에 의존하지 않는다 — 첨부는 중립 인터페이스 Attachment 로 받는다(F2 봇이 Slack 첨부를 이 형태로 변환).
 */
import { execFile } from "node:child_process";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isSafeRunId, storagePaths } from "../config.js";
import type { AcceptedIntakeFile } from "./nl/intake-files.js";
import type { Job } from "../types/jobs.js";

const execFileAsync = promisify(execFile);

/** 챗-중립 첨부(플랫폼 어댑터가 Slack 첨부 등을 이 형태로 변환). */
export interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/** 저장 결과 — throw 대신 거부 사유를 값으로 돌린다(LLM 추측 금지 · 거부-재요청). */
export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** 워킹백워드 저장 옵션(테스트·환경 주입용). pandoc 바이너리명 오버라이드로 결정적 테스트 가능. */
export interface SaveOptions {
  /** .docx 변환에 쓸 pandoc 실행파일명(기본 env CHAT_PANDOC_BIN 또는 "pandoc"). */
  pandocBin?: string;
}

function pandocBinary(opts?: SaveOptions): string {
  return opts?.pandocBin ?? process.env.CHAT_PANDOC_BIN ?? "pandoc";
}

/** run 별 data 디렉터리(storagePaths().data/<rid>). */
function runDataDir(rid: string): string {
  return join(storagePaths().data, rid);
}

/** tmp 파일에 쓰고 rename(원자 저장). 같은 디렉터리 tmp 라 rename 이 원자적. */
async function atomicWrite(destPath: string, data: Buffer): Promise<void> {
  const tmp = `${destPath}.tmp-${randomUUID()}`;
  await writeFile(tmp, data);
  await rename(tmp, destPath);
}

/**
 * 워킹백워드 **답글 텍스트**를 storagePaths().data/<rid>/ 아래 **제출별 불변 파일**로 저장한다(UI 공통분모 경로).
 *   파일 첨부는 Google Chat 미지원이라 1차 UX 는 텍스트 붙여넣기가 정경로다. 빈/공백 텍스트는 거부 사유 반환.
 *   ⚠ 파일명에 제출 uuid 를 넣는다(고정명 금지) — 인입 잡이 큐에 있는 동안 두 번째 답글이 같은 경로를
 *   덮어쓰면 잡이 '나중 내용'을 인입한다(경로만 잡에 실리므로). 제출마다 새 파일 = 그 레이스 원천 제거.
 *   (재답글은 새 파일+새 잡이 되고, 이미 인입이 끝났으면 워커의 stale-ingest 가드가 거른다.)
 */
export async function saveWorkingBackwardsText(rid: string, text: string): Promise<SaveResult> {
  if (!isSafeRunId(rid)) {
    return { ok: false, reason: "잘못된 작업 식별자입니다(내부 오류) — 운영자에게 문의하세요." };
  }
  const body = (text ?? "").trim();
  if (!body) {
    return { ok: false, reason: "내용이 비어 있어요 — 제품 자료 본문을 답글로 붙여넣어 주세요." };
  }
  const dir = runDataDir(rid);
  const destPath = join(dir, `working-backwards-${randomUUID()}.md`);
  await mkdir(dir, { recursive: true });
  await atomicWrite(destPath, Buffer.from(body + "\n", "utf8"));
  return { ok: true, path: destPath };
}

/**
 * (미배선 보조 — Slack 전용) 워킹백워드 '파일 첨부'를 저장한다. UI 공통분모 원칙(모달·슬래시·파일첨부 금지,
 *   GChat 미지원)에 따라 1차 봇 배선에서는 쓰지 않는다 — 정경로는 위 saveWorkingBackwardsText(답글 붙여넣기).
 *   · .md  → 원자 저장 후 {ok:true,path}
 *   · .docx→ pandoc 로 .md 변환(성공 시 {ok:true,path}); pandoc 부재/실패 시 {ok:false,reason}
 *   · 그 외 확장자 → {ok:false,reason}
 * 어떤 경우에도 throw 하지 않는다(거부 사유는 값으로).
 */
export async function saveWorkingBackwards(
  rid: string,
  att: Attachment,
  opts?: SaveOptions,
): Promise<SaveResult> {
  // 경로 안전: rid 를 data/<rid> 경로로 쓰기 전 검증 — `../other` 등이 남의 run 입력을 덮어쓰는 것 차단.
  if (!isSafeRunId(rid)) {
    return { ok: false, reason: "잘못된 작업 식별자입니다(내부 오류) — 운영자에게 문의하세요." };
  }
  const ext = extname(att.filename).toLowerCase();
  const dir = runDataDir(rid);
  const destPath = join(dir, "working-backwards.md");

  if (ext === ".md") {
    await mkdir(dir, { recursive: true });
    await atomicWrite(destPath, att.data);
    return { ok: true, path: destPath };
  }

  if (ext === ".docx") {
    await mkdir(dir, { recursive: true });
    const srcTmp = join(dir, `.wb-src-${randomUUID()}.docx`);
    try {
      await writeFile(srcTmp, att.data);
      // pandoc <src.docx> -o <out.md>. 부재(ENOENT)·변환실패(비-0)는 아래 catch 로.
      await execFileAsync(pandocBinary(opts), [srcTmp, "-o", destPath]);
      return { ok: true, path: destPath };
    } catch {
      return {
        ok: false,
        reason: "워킹백워드는 .md 로 올려주세요(.docx 변환 실패).",
      };
    } finally {
      await rm(srcTmp, { force: true }).catch(() => {});
    }
  }

  return {
    ok: false,
    reason: `워킹백워드는 .md 로 올려주세요(지원하지 않는 형식: ${ext || "확장자 없음"}).`,
  };
}

/**
 * NL 파일 인입(P3-2) — 검증 통과한 파일들을 storagePaths().data/<rid>/intake-<uuid>/ 아래 **불변 스냅샷**으로 복사한다.
 *   확정 시점마다 새 uuid 폴더(불변 — 이후 답글이 덮어쓰지 못하게). intake.sh 가 이 폴더를 첨부 원본으로 스냅샷한다.
 *   ⚠ PDF→md 변환은 여기서 하지 않는다 — 원본 바이트 그대로 두고 core 00a-intake 파이프라인(poppler)에 맡긴다(S-3 결론, intake-files.ts).
 *   파일명 충돌은 인덱스 접두로 회피. throw 하지 않고 거부 사유를 값으로 돌린다.
 */
export async function stageIntakeFolder(
  rid: string,
  files: AcceptedIntakeFile[],
): Promise<{ ok: true; folder: string } | { ok: false; reason: string }> {
  if (!isSafeRunId(rid)) {
    return { ok: false, reason: "잘못된 작업 식별자입니다(내부 오류) — 운영자에게 문의하세요." };
  }
  if (files.length === 0) {
    return { ok: false, reason: "불러올 파일이 없어요." };
  }
  const dir = join(storagePaths().data, rid, `intake-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    const used = new Set<string>();
    for (const f of files) {
      let name = basename(f.realPath);
      if (used.has(name)) name = `${used.size}-${name}`; // 충돌 회피(인덱스 접두).
      used.add(name);
      // ⚠ 검증→복사 TOCTOU 봉쇄(외부리뷰 P3 HIGH): validateIntakeFiles 뒤 최종 경로가 심링크로 바뀌었을 수 있다.
      //   O_NOFOLLOW 로 열어 최종 경로가 심링크면 거부(ELOOP) → 봉쇄 밖 파일이 스냅샷에 섞이는 것 차단.
      //   일반 파일(fstat)만 스트림 복사한다.
      const fh = await open(f.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await fh.stat()).isFile()) throw new Error("일반 파일이 아닙니다.");
        await pipeline(fh.createReadStream({ autoClose: false }), createWriteStream(join(dir, name)));
      } finally {
        await fh.close();
      }
    }
    return { ok: true, folder: dir };
  } catch {
    return { ok: false, reason: "첨부 자료를 준비하지 못했어요 — 파일 위치를 확인해 주세요." };
  }
}

/** ingest 잡 구성 옵션. */
export interface IngestOptions {
  /** 저장된 워킹백워드 .md 절대경로(하류가 HARNESS_WB 로 읽음). */
  wbPath?: string;
  /** 운영자 사전준비 번들 폴더 절대경로. */
  bundleDir?: string;
  /** 요청자 감사 actor(예 "chat:slack:U123"). */
  actor: string;
}

/**
 * ingest 잡(kind="ingest")을 만든다. payload.bundle_dir=번들 절대경로,
 *   payload.wb_path=워킹백워드 저장경로(워커가 HARNESS_WB 로 실어 spawn). state 직접쓰기 없음.
 */
export function buildIngestJob(rid: string, opts: IngestOptions): Job {
  const payload: Job["payload"] = {};
  if (opts.bundleDir) payload.bundle_dir = opts.bundleDir;
  if (opts.wbPath) payload.wb_path = opts.wbPath;
  return {
    kind: "ingest",
    run_id: rid,
    payload,
    actor: opts.actor,
  };
}

/**
 * ingest 잡을 큐에 넘긴다(ack-후-비동기). 셸 spawn 은 워커가 한다 — 여기선 submit 만.
 */
export async function submitIngest(
  rid: string,
  opts: IngestOptions,
  submitter: { submit(job: Job): Promise<void> },
): Promise<void> {
  await submitter.submit(buildIngestJob(rid, opts));
}
