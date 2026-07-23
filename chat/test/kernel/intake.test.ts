import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  buildIngestJob,
  saveWorkingBackwards,
  saveWorkingBackwardsText,
  stageIntakeFolder,
  submitIngest,
  type Attachment,
} from "../../src/kernel/intake.js";
import type { AcceptedIntakeFile } from "../../src/kernel/nl/intake-files.js";
import type { Job } from "../../src/types/jobs.js";

let dataDir: string;
const prevDataDir = process.env.CHAT_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "chat-intake-"));
  process.env.CHAT_DATA_DIR = dataDir; // storagePaths() 가 이 루트를 쓴다(격리)
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.CHAT_DATA_DIR;
  else process.env.CHAT_DATA_DIR = prevDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function att(filename: string, body: string): Attachment {
  return { filename, mimeType: "text/plain", data: Buffer.from(body, "utf8") };
}

describe("saveWorkingBackwards", () => {
  it(".md 첨부를 <data>/<rid>/working-backwards.md 로 원자 저장", async () => {
    const r = await saveWorkingBackwards("run-1", att("wb.md", "# 핵심\n내용"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(join(dataDir, "run-1", "working-backwards.md"));
      expect(await readFile(r.path, "utf8")).toBe("# 핵심\n내용");
    }
  });

  it("대문자 확장자(.MD)도 허용", async () => {
    const r = await saveWorkingBackwards("run-2", att("WB.MD", "x"));
    expect(r.ok).toBe(true);
  });

  it(".docx 는 pandoc 부재/실패 시 거부 사유 반환(throw 아님)", async () => {
    // 존재하지 않는 pandoc 바이너리 주입 → ENOENT → 결정적 실패(설치 여부 무관).
    const r = await saveWorkingBackwards("run-3", att("wb.docx", "PK..."), {
      pandocBin: `pandoc-missing-${randomUUID()}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(".docx 변환 실패");
  });

  it("지원하지 않는 확장자(.txt)는 거부 사유 반환", async () => {
    const r = await saveWorkingBackwards("run-4", att("wb.txt", "x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("지원하지 않는 형식");
  });

  it("경로 탈출 rid(../other)는 거부(남의 run 입력 덮어쓰기 차단)", async () => {
    const r = await saveWorkingBackwards("../other", att("wb.md", "탈취"));
    expect(r.ok).toBe(false);
  });

  it("슬래시 포함 rid 도 거부", async () => {
    const r = await saveWorkingBackwards("a/b", att("wb.md", "x"));
    expect(r.ok).toBe(false);
  });
});

describe("saveWorkingBackwardsText (답글 붙여넣기 — 공통분모 정경로)", () => {
  it("본문 텍스트를 <data>/<rid>/working-backwards-<uuid>.md 제출별 불변 파일로 저장", async () => {
    const r = await saveWorkingBackwardsText("run-t1", "# 핵심\n본문");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path.startsWith(join(dataDir, "run-t1", "working-backwards-"))).toBe(true);
      expect(r.path.endsWith(".md")).toBe(true);
      expect(await readFile(r.path, "utf8")).toBe("# 핵심\n본문\n");
    }
  });

  it("제출마다 새 파일(불변) — 나중 답글이 앞 제출을 덮어쓰지 못한다(큐 잡 오인입 차단)", async () => {
    const a = await saveWorkingBackwardsText("run-t1", "첫 제출 본문");
    const b = await saveWorkingBackwardsText("run-t1", "나중 답글");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.path).not.toBe(b.path);
      expect(await readFile(a.path, "utf8")).toBe("첫 제출 본문\n"); // 앞 제출 내용 보존
    }
  });

  it("빈/공백 본문은 거부 사유 반환(throw 아님)", async () => {
    const r = await saveWorkingBackwardsText("run-t2", "   \n ");
    expect(r.ok).toBe(false);
  });

  it("경로 탈출 rid 는 거부", async () => {
    const r = await saveWorkingBackwardsText("../other", "본문");
    expect(r.ok).toBe(false);
  });
});

describe("buildIngestJob", () => {
  it("kind=ingest · run_id · actor · payload(bundle_dir·wb_path) 형태", () => {
    const job = buildIngestJob("run-5", {
      wbPath: "/abs/data/run-5/working-backwards.md",
      bundleDir: "/abs/operator/bundle",
      actor: "chat:slack:U123",
    });
    expect(job.kind).toBe("ingest");
    expect(job.run_id).toBe("run-5");
    expect(job.actor).toBe("chat:slack:U123");
    expect(job.payload.bundle_dir).toBe("/abs/operator/bundle");
    expect(job.payload.wb_path).toBe("/abs/data/run-5/working-backwards.md");
  });

  it("옵션 미지정 필드는 payload 에 넣지 않는다", () => {
    const job = buildIngestJob("run-6", { actor: "chat:slack:U9" });
    expect(job.payload.bundle_dir).toBeUndefined();
    expect(job.payload.wb_path).toBeUndefined();
  });
});

describe("submitIngest", () => {
  it("JobSubmitter.submit 를 구성된 잡으로 정확히 1회 호출(ack-후-비동기)", async () => {
    const submitted: Job[] = [];
    const fake = {
      submit: async (job: Job): Promise<void> => {
        submitted.push(job);
      },
    };
    await submitIngest("run-7", { bundleDir: "/b", actor: "chat:slack:U1" }, fake);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("ingest");
    expect(submitted[0]!.run_id).toBe("run-7");
    expect(submitted[0]!.payload.bundle_dir).toBe("/b");
  });
});

describe("stageIntakeFolder (O_NOFOLLOW 불변 스냅샷 — TOCTOU 봉쇄)", () => {
  let srcDir: string;
  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), "chat-intake-src-"));
  });
  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
  });

  it("일반 파일들 → 불변 스냅샷 폴더로 복사(ok)", async () => {
    const a = join(srcDir, "wb.md");
    const b = join(srcDir, "note.txt");
    writeFileSync(a, "WB");
    writeFileSync(b, "N");
    const files: AcceptedIntakeFile[] = [
      { role: "working_backwards", path: a, realPath: a },
      { role: "reference", path: b, realPath: b },
    ];
    const res = await stageIntakeFolder("rid-stage", files);
    expect(res.ok).toBe(true);
    if (res.ok) expect(readdirSync(res.folder).sort()).toEqual(["note.txt", "wb.md"]);
  });

  it("realPath 가 심링크면(검증 후 스왑 모사) O_NOFOLLOW 로 거부 → 스테이징 실패(비밀 미복사)", async () => {
    const secret = join(srcDir, "secret.env");
    const link = join(srcDir, "wb.md");
    writeFileSync(secret, "TOKEN=xoxb-secret");
    symlinkSync(secret, link); // 검증 후 realPath 가 심링크로 바뀐 상태를 모사.
    const files: AcceptedIntakeFile[] = [{ role: "working_backwards", path: link, realPath: link }];
    const res = await stageIntakeFolder("rid-stage2", files);
    expect(res.ok).toBe(false); // 심링크 최종 경로 → 복사 안 함.
  });

  it("불안전 rid → 거부(ok:false)", async () => {
    const res = await stageIntakeFolder("../evil", []);
    expect(res.ok).toBe(false);
  });
});
