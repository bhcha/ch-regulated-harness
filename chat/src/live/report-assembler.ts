/**
 * report-assembler.ts — 라이브 런 1회 → **AI 심판이 읽을 구조적 판정 리포트**(잠긴 결정 2).
 *
 * ── 무엇을 판정하나(구조만 · LLM 본문 일치 아님) ─────────────────────────────────
 *   라이브 인수 판정은 **구조적**이다(잠긴 결정 2): done 도달·산출물+스키마·게이트 순서·감사 actor·image-manifest
 *   완결·Failure 0·잡 수명주기 위반 0. LLM 이 쓴 카피 내용이 맞는지는 assert 하지 않는다(실엔진 비결정).
 *   ── 감사 actor 표기: history actor 를 **끝 세그먼트가 `svc-` 접두면 서비스(드라이버)·아니면 사람**으로 갈라
 *   정직하게 보여준다(라이브 auto-happy 는 서비스 identity 로 자동 주행 — 드라이버 결정을 '사람 승인'으로
 *   위장하지 않는다). 채점(ok)은 사람+서비스 **합계>0** 로 불변 — 표기만 보강한 것이지 의미론은 안 바뀐다.
 *   심의가 revise/escalation 으로 끝난 것은 **실패가 아니라 적대적 심의가 일한 유효 결과**다 — 리포트는 그것을
 *   증거(verdict critic_ran/critic_outcome/review_depth)로 **보여줄** 뿐 실패로 채점하지 않는다.
 *
 * ── 입력 = 파일들(읽기 전용) ─────────────────────────────────────────────────────
 *   ① 라이브 tee JSONL 트랜스크립트(TeeRecordingPort 산출) · ② chat `jobs/failed/*.reason`(잡 수명주기 위반) ·
 *   ③ core `runs/<rid>/state.json`(history·artifacts·phase) · ④ `.logs/timing.jsonl` · ⑤ `*-verdict.json`
 *   (critic_ran·critic_outcome·review_depth) · ⑥ (선택) tee 대화 덤프(사람 참관 사후검토).
 *   파일만 읽는다(게이트웨이·core 를 부르지 않는다). fs 이음새를 주입해 픽스처로 오프라인 검증한다.
 *
 * 플랫폼 무지: Slack 을 import 하지 않는다(어떤 챗 플랫폼 파일도 안 읽는다 — 경로만 받는다).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Presentation } from "../kernel/presentation.js";

/** 파이프라인 페이즈 정순(게이트 순서 판정 SSoT — state.schema.json phase.enum 미러). */
export const PIPELINE_ORDER: readonly string[] = [
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

/** fs 이음새(주입 · 기본 = node fs). 없으면 null/[]/false 로 안전 폴백(파일 부재 = 관측 불가). */
export interface ReportReader {
  readText(path: string): string | null;
  exists(path: string): boolean;
  listEntries(dir: string): Array<{ name: string; isDir: boolean }>;
}

export const defaultReader: ReportReader = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists(path) {
    return existsSync(path);
  },
  listEntries(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return [];
    }
  },
};

/** 판정 리포트 1개 기준(criterion). ok=구조 통과. */
export interface Criterion {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** verdict.json 요약(증거 · 채점 대상 아님). */
export interface VerdictSummary {
  file: string;
  verdict: string | null;
  engine: string | null;
  critic_ran: boolean | null;
  critic_outcome: string | null;
  review_depth: string | null;
  critic_engine: string | null;
  violations: number | null;
}

/** timing.jsonl 한 줄 요약(증거). */
export interface TimingSummary {
  phase: string | null;
  stage: string | null;
  step: string | null;
  outcome: string | null;
  duration_s: number | null;
}

/** 판정 리포트 전체. */
export interface JudgmentReport {
  /** 모든 구조 기준 통과 여부(= criteria 전부 ok). */
  pass: boolean;
  rid: string | null;
  criteria: Criterion[];
  evidence: {
    verdicts: VerdictSummary[];
    timing: TimingSummary[];
    /** 트랜스크립트 화면 type 히스토그램(트랜스크립트 제공 시). */
    presentationTypes: Record<string, number>;
    /** 관측된 페이즈 순서(history 유래). */
    phaseSequence: string[];
    /** tee 대화 덤프가 제공·존재하는가(사람 참관 사후검토). */
    conversationDump: boolean;
    /** 실패 잡 사유 파일들(있으면 위반). */
    failedJobs: string[];
  };
  /** 리포트 생성 중 만난 경고(입력 부재·파싱 실패 등 · 채점과 별개). */
  notes: string[];
}

export interface JudgmentReportInput {
  /** core 런 디렉터리 절대경로(runs/<rid>). */
  runDir: string;
  /** 라이브 tee JSONL 트랜스크립트 경로(선택 — 없으면 Failure/화면 판정 '미확인'). */
  transcriptPath?: string;
  /**
   * **여러 세션 트랜스크립트**(선택 · additive). 지정(비어있지 않으면)되면 transcriptPath 보다 **우선**한다 —
   *   나열된 JSONL 을 전부 읽어 presentation 을 이어붙여 판정하므로 failure-zero·presentationTypes 가 **전 세션
   *   합산**이 된다(run-수준 final 리포트가 옛 세션의 Failure 를 놓쳐 거짓 통과하던 P1 처방). 못 읽는 파일은
   *   채점과 별개로 notes 경고만 남기고 나머지로 판정한다. **빈 배열 = transcriptPath 폴백**(기존 단일 경로
   *   시그니처·동작 불변 — 세션 리포트는 여전히 단일 경로로 그 세션만 관측). listRunTranscripts 로 목록을 만든다.
   */
  transcriptPaths?: string[];
  /** chat jobs/failed 디렉터리(선택 — 없으면 잡 수명주기 위반 '미확인'). */
  jobsFailedDir?: string;
  /** tee 대화 덤프 경로(선택 · 증거만). */
  conversationDumpPath?: string;
  /** fs 이음새(기본 node fs). */
  reader?: ReportReader;
  /** 페이즈 정순 오버라이드(기본 PIPELINE_ORDER). */
  pipelineOrder?: readonly string[];
}

/** JSON 안전 파싱(실패 null). */
function tryJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSONL 텍스트 → Presentation 배열. tee render-line({seq,threadId,presentation})·transcript entry({screens[]}) 둘 다 수용. */
export function extractPresentations(jsonlText: string | null): Presentation[] {
  if (!jsonlText) return [];
  const out: Presentation[] = [];
  for (const line of jsonlText.split("\n")) {
    if (line.trim() === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 깨진 줄은 건너뛴다(부분 아티팩트 내성).
    }
    if (obj.presentation && typeof obj.presentation === "object") {
      out.push(obj.presentation as Presentation);
    } else if (Array.isArray(obj.screens)) {
      for (const s of obj.screens) if (s && typeof s === "object") out.push(s as Presentation);
    }
  }
  return out;
}

/**
 * artifactDir 에서 이 rid 의 **모든 세션 트랜스크립트**를 결정적으로 나열한다(run-수준 final 집계 입력).
 *   채택 규칙: 이름이 `${rid}-transcript` 로 시작 && `.jsonl` 로 끝나는 파일 — 세션형(`${rid}-transcript.<epoch>.jsonl`)과
 *   레거시 무접미(`${rid}-transcript.jsonl`)를 모두 포함한다. `-transcript` 를 접두에 붙여 rid 접두 충돌(예 rid=`x`
 *   일 때 `x2-transcript…`)을 배제하고, `.jsonl` 종결로 리포트(`${rid}-report.*`) 등 무관 파일을 배제한다.
 *   정렬은 **이름 오름차순**(결정성 위해 고정 — 합산 판정은 개수 기반이라 순서에 무관하지만 출력 안정화). 반환은
 *   join 절대경로. 디렉터리 엔트리는 제외한다.
 */
export function listRunTranscripts(reader: ReportReader, artifactDir: string, rid: string): string[] {
  const prefix = `${rid}-transcript`;
  return reader
    .listEntries(artifactDir)
    .filter((e) => !e.isDir && e.name.startsWith(prefix) && e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort()
    .map((name) => join(artifactDir, name));
}

/** runDir 하위에서 `*-verdict.json` 을 얕게(최대 depth 3) 모은다(core: runs/<rid>/<phase>/[sub/]*-verdict.json). */
function collectVerdictFiles(reader: ReportReader, runDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const e of reader.listEntries(dir)) {
      const p = join(dir, e.name);
      if (e.isDir) walk(p, depth + 1);
      else if (e.name.endsWith("-verdict.json") || e.name === "verdict.json") found.push(p);
    }
  };
  walk(runDir, 0);
  return found.sort();
}

function summarizeVerdict(reader: ReportReader, file: string, runDir: string): VerdictSummary {
  const rel = file.startsWith(runDir) ? file.slice(runDir.length).replace(/^\/+/, "") : file;
  const v = tryJson(reader.readText(file)) as Record<string, unknown> | null;
  const s = (k: string): string | null => (v && typeof v[k] === "string" ? (v[k] as string) : null);
  const b = (k: string): boolean | null => (v && typeof v[k] === "boolean" ? (v[k] as boolean) : null);
  return {
    file: rel,
    verdict: s("verdict"),
    engine: s("engine"),
    critic_ran: b("critic_ran"),
    critic_outcome: s("critic_outcome"),
    review_depth: s("review_depth"),
    critic_engine: s("critic_engine"),
    violations: v && Array.isArray(v.violations) ? (v.violations as unknown[]).length : null,
  };
}

function parseTiming(text: string | null): TimingSummary[] {
  if (!text) return [];
  const out: TimingSummary[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const o = tryJson(line) as Record<string, unknown> | null;
    if (!o) continue;
    out.push({
      phase: typeof o.phase === "string" ? o.phase : null,
      stage: typeof o.stage === "string" ? o.stage : null,
      step: typeof o.step === "string" ? o.step : null,
      outcome: typeof o.outcome === "string" ? o.outcome : null,
      duration_s: typeof o.duration_s === "number" ? o.duration_s : null,
    });
  }
  return out;
}

/** image-manifest 판정(common.sh image_manifest_complete 미러): complete | incomplete | absent | malformed. */
function imageManifestClass(reader: ReportReader, runDir: string): {
  cls: "complete" | "incomplete" | "absent" | "malformed";
  engine: string | null;
} {
  const path = join(runDir, "04-keyvisual", "image-manifest.json");
  if (!reader.exists(path)) return { cls: "absent", engine: null };
  const m = tryJson(reader.readText(path)) as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return { cls: "malformed", engine: null };
  const engine = typeof m.engine === "string" ? m.engine : null;
  // complete = 매니페스트 dict + engine 비어있지 않음 + engine!=stub + incomplete 부재(AGENTS common.sh).
  if (m.incomplete) return { cls: "incomplete", engine };
  if (!engine || engine === "stub") return { cls: "incomplete", engine };
  return { cls: "complete", engine };
}

/**
 * actor 문자열의 끝 세그먼트(마지막 ':' 뒤)만 취한다 — config.actorUserId 와 **같은 규약**이나,
 * 리포트 조립기는 게이트웨이 config 와 결합하지 않으므로(파일만 읽는 순수 판정기) 로컬로 재현한다.
 *   `chat:live:svc-U999`→`svc-U999` · `chat:live:U123`→`U123` · `U123`→`U123`.
 * 끝 세그먼트가 빈 문자열(예 후행 ':')이면 원문을 그대로 돌려 판별 불능을 삼키지 않는다.
 */
function actorEndSegment(actor: string): string {
  const parts = actor.split(":");
  return parts[parts.length - 1] || actor;
}

/**
 * 라이브 런 1회의 구조적 판정 리포트를 조립한다. 파일만 읽고(주입 reader), 기준별 ok 를 채점한 뒤 증거를 싣는다.
 *   pass = 모든 기준 ok. LLM 본문·심의 revise/escalation 은 채점하지 않는다(증거로 보여줄 뿐 · 잠긴 결정 2).
 */
export function assembleJudgmentReport(input: JudgmentReportInput): JudgmentReport {
  const reader = input.reader ?? defaultReader;
  const order = input.pipelineOrder ?? PIPELINE_ORDER;
  const notes: string[] = [];
  const criteria: Criterion[] = [];

  // ── state.json ──
  const statePath = join(input.runDir, "state.json");
  const state = tryJson(reader.readText(statePath)) as Record<string, unknown> | null;
  const rid = state && typeof state.workflow_id === "string" ? (state.workflow_id as string) : null;
  const history = state && Array.isArray(state.history) ? (state.history as Array<Record<string, unknown>>) : [];
  const artifacts = state && typeof state.artifacts === "object" && state.artifacts !== null ? (state.artifacts as Record<string, unknown>) : null;

  // ① done 도달 — state.phase === "done".
  const phase = state && typeof state.phase === "string" ? (state.phase as string) : null;
  criteria.push({
    id: "done-reached",
    label: "done 도달",
    ok: phase === "done",
    detail: state === null ? "state.json 을 읽지 못했습니다(런 디렉터리 확인)." : `현재 페이즈: ${phase ?? "(없음)"}`,
  });

  // ② 산출물 + 스키마 — state.json 이 필수 키를 갖춘 well-formed JSON 이고 artifacts 가 비어 있지 않다.
  const requiredKeys = ["workflow_id", "product", "phase", "history", "artifacts"];
  const missingKeys = state === null ? requiredKeys : requiredKeys.filter((k) => !(k in state));
  const artifactCount = artifacts ? Object.keys(artifacts).length : 0;
  criteria.push({
    id: "artifacts-schema",
    label: "산출물·스키마",
    ok: state !== null && missingKeys.length === 0 && artifactCount > 0,
    detail:
      state === null
        ? "state.json 파싱 실패."
        : missingKeys.length > 0
          ? `state.json 필수 키 누락: ${missingKeys.join(", ")}`
          : `artifacts ${artifactCount}건 기록됨.`,
  });

  // ③ 게이트 순서 — history 의 페이즈가 정순 인덱스로 **비감소**(뒤로 점프 없음).
  const phaseSeq: string[] = [];
  for (const h of history) {
    const ph = typeof h.phase === "string" ? h.phase : null;
    if (ph && (phaseSeq.length === 0 || phaseSeq[phaseSeq.length - 1] !== ph)) phaseSeq.push(ph);
  }
  let orderOk = true;
  let orderDetail = "게이트 순서 정상(정순 비감소).";
  let prevIdx = -1;
  for (const ph of phaseSeq) {
    const idx = order.indexOf(ph);
    if (idx === -1) continue; // 알 수 없는 페이즈는 순서 판정에서 건너뛴다(관측만).
    if (idx < prevIdx) {
      orderOk = false;
      orderDetail = `페이즈가 뒤로 점프했습니다: ${ph} (앞 인덱스 ${prevIdx} → ${idx}).`;
      break;
    }
    prevIdx = idx;
  }
  if (phaseSeq.length === 0) {
    orderOk = false;
    orderDetail = "history 에 페이즈 기록이 없습니다.";
  }
  criteria.push({ id: "gate-order", label: "게이트 순서", ok: orderOk, detail: orderDetail });

  // ④ 감사 actor — history 에 감사 actor 가 하나라도 --by 로 기록됐다(승인/선택). ok=합계(사람+서비스)>0 로
  //    **채점 불변**(라이브 auto-happy 는 서비스 identity `svc-` 로 자동 주행하므로 서비스만 있어도 통과).
  //    다만 표기는 끝 세그먼트가 `svc-` 접두면 서비스(드라이버)·아니면 사람으로 갈라 정직화한다 — 드라이버
  //    자동 결정을 '사람 승인'으로 위장하지 않기 위함(계획 수정 6 / S-6). 각 그룹은 dedup·정렬, 빈 그룹은 생략.
  const actors = history
    .map((h) => (typeof h.actor === "string" ? h.actor : ""))
    .filter((a) => a.length > 0);
  const segs = actors.map(actorEndSegment);
  const humanActors = [...new Set(segs.filter((s) => !s.startsWith("svc-")))].sort();
  const serviceActors = [...new Set(segs.filter((s) => s.startsWith("svc-")))].sort();
  const actorGroups: string[] = [];
  if (humanActors.length > 0) actorGroups.push(`사람 actor: ${humanActors.join(", ")}`);
  if (serviceActors.length > 0) actorGroups.push(`서비스(드라이버) actor: ${serviceActors.join(", ")}`);
  let actorDetail: string;
  if (actors.length === 0) {
    actorDetail = "history 에 감사 actor 가 없습니다.";
  } else {
    actorDetail = actorGroups.join(" · ");
    // 서비스만 있고 사람 결정이 0건이면 '전 구간 드라이버 자동 주행'을 한 줄로 정직 표기(ok 는 불변).
    if (humanActors.length === 0 && serviceActors.length > 0) {
      actorDetail += " · 사람 결정 0건(전 구간 드라이버 자동 주행).";
    }
  }
  criteria.push({
    id: "audit-actor",
    label: "감사 actor",
    ok: actors.length > 0,
    detail: actorDetail,
  });

  // ⑤ image-manifest 완결.
  const im = imageManifestClass(reader, input.runDir);
  criteria.push({
    id: "image-manifest",
    label: "이미지 매니페스트 완결",
    ok: im.cls === "complete",
    detail:
      im.cls === "complete"
        ? `완결(engine=${im.engine}).`
        : im.cls === "absent"
          ? "04-keyvisual/image-manifest.json 부재(키비주얼 미도달 또는 이미지 미생성)."
          : im.cls === "incomplete"
            ? `미완결(incomplete 또는 engine=${im.engine ?? "없음"}) — 부분 생성/중단.`
            : "매니페스트 형식 오류.",
  });

  // ⑥ Failure 0 — 트랜스크립트에 Failure 화면이 없다(트랜스크립트 제공 시에만 확정).
  //    입력 우선순위: transcriptPaths(비어있지 않으면) > transcriptPath. 합산 모드(usingMulti)는 여러 세션
  //    JSONL 을 이어붙여 판정하므로 failure-zero·presentationTypes 가 **전 세션 합산**이 된다(옛 세션 Failure 를
  //    현재 세션만 보던 리포트가 놓쳐 거짓 통과하던 P1 처방). 단일 경로 폴백(빈 배열/미지정)은 기존 동작 불변 —
  //    파일 부재 시 note 없이 조용히 빈 관측(원래 단일 경로 동작을 그대로 보존; 못 읽는 세션 경고는 합산 모드 전용).
  const usingMulti = Boolean(input.transcriptPaths && input.transcriptPaths.length > 0);
  const transcriptPaths = usingMulti
    ? input.transcriptPaths!
    : input.transcriptPath
      ? [input.transcriptPath]
      : [];
  let presentations: Presentation[] = [];
  const presentationTypes: Record<string, number> = {};
  if (transcriptPaths.length > 0) {
    for (const tp of transcriptPaths) {
      const text = reader.readText(tp);
      if (text === null) {
        // 합산 모드에서만: 못 읽는 세션 파일을 경고로 남기고 나머지로 판정한다(채점과 별개).
        if (usingMulti) notes.push(`트랜스크립트 파일을 읽지 못해 합산에서 제외했습니다: ${tp}`);
        continue;
      }
      for (const p of extractPresentations(text)) presentations.push(p);
    }
    for (const p of presentations) {
      const t = (p as { type?: unknown }).type;
      const key = typeof t === "string" ? t : "(unknown)";
      presentationTypes[key] = (presentationTypes[key] ?? 0) + 1;
    }
    const failures = presentations.filter((p) => (p as { type?: unknown }).type === "Failure").length;
    criteria.push({
      id: "failure-zero",
      label: "Failure 화면 0",
      ok: failures === 0,
      detail: failures === 0 ? "Failure 화면 없음." : `Failure 화면 ${failures}건.`,
    });
  } else {
    notes.push("트랜스크립트 경로 미제공 — Failure/화면 판정을 확인하지 못했습니다(실 tee JSONL 을 넘기세요).");
    criteria.push({
      id: "failure-zero",
      label: "Failure 화면 0",
      ok: false,
      detail: "트랜스크립트 미제공 — 확인 불가(transcriptPath 를 주세요).",
    });
  }

  // ⑦ 잡 수명주기 위반 0 — jobs/failed/*.reason 이 없다(실패·만료 격리 잡 0).
  let failedJobs: string[] = [];
  if (input.jobsFailedDir) {
    failedJobs = reader
      .listEntries(input.jobsFailedDir)
      .filter((e) => !e.isDir && e.name.endsWith(".reason"))
      .map((e) => e.name)
      .sort();
    criteria.push({
      id: "job-lifecycle",
      label: "잡 수명주기 위반 0",
      ok: failedJobs.length === 0,
      detail: failedJobs.length === 0 ? "실패 잡 없음." : `실패 잡 ${failedJobs.length}건: ${failedJobs.join(", ")}`,
    });
  } else {
    notes.push("jobs/failed 디렉터리 미제공 — 잡 수명주기 위반을 확인하지 못했습니다.");
    criteria.push({
      id: "job-lifecycle",
      label: "잡 수명주기 위반 0",
      ok: false,
      detail: "jobs/failed 경로 미제공 — 확인 불가(jobsFailedDir 를 주세요).",
    });
  }

  // ── 증거(채점 아님) ──
  const verdicts = collectVerdictFiles(reader, input.runDir).map((f) => summarizeVerdict(reader, f, input.runDir));
  const timing = parseTiming(reader.readText(join(input.runDir, ".logs", "timing.jsonl")));
  const conversationDump = Boolean(input.conversationDumpPath && reader.exists(input.conversationDumpPath));
  if (input.conversationDumpPath && !conversationDump) {
    notes.push("대화 덤프 경로가 주어졌으나 파일이 없습니다(사람 참관 사후검토 증거 누락).");
  }

  return {
    pass: criteria.every((c) => c.ok),
    rid,
    criteria,
    evidence: { verdicts, timing, presentationTypes, phaseSequence: phaseSeq, conversationDump, failedJobs },
    notes,
  };
}

/** 판정 리포트 → 사람/AI 판독용 마크다운(평이 한국어). */
export function renderReportMarkdown(r: JudgmentReport): string {
  const lines: string[] = [];
  lines.push(`# 라이브 인수 판정 리포트${r.rid ? ` — ${r.rid}` : ""}`);
  lines.push("");
  lines.push(`**종합 판정(구조): ${r.pass ? "통과(PASS)" : "미충족(REVIEW)"}**`);
  lines.push("");
  lines.push("> 구조 판정만 한다(잠긴 결정 2). LLM 카피 내용·심의 revise/escalation 은 채점 대상이 아니라 증거다 —");
  lines.push("> 심의가 revise/escalation 으로 끝난 것은 적대적 심의가 **일한** 유효 결과다(실패 아님).");
  lines.push("");
  lines.push("## 구조 기준");
  lines.push("");
  lines.push("| 기준 | 판정 | 상세 |");
  lines.push("|---|---|---|");
  for (const c of r.criteria) {
    lines.push(`| ${c.label} | ${c.ok ? "✅" : "⚠️"} | ${c.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  if (r.evidence.verdicts.length > 0) {
    lines.push("## 심의 증거(verdict — 채점 아님)");
    lines.push("");
    lines.push("| 파일 | verdict | engine | critic_ran | critic_outcome | review_depth | 위반수 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const v of r.evidence.verdicts) {
      lines.push(
        `| ${v.file} | ${v.verdict ?? "-"} | ${v.engine ?? "-"} | ${v.critic_ran ?? "-"} | ${v.critic_outcome ?? "-"} | ${v.review_depth ?? "-"} | ${v.violations ?? "-"} |`,
      );
    }
    lines.push("");
  }
  if (Object.keys(r.evidence.presentationTypes).length > 0) {
    lines.push("## 화면 히스토그램(트랜스크립트)");
    lines.push("");
    for (const [t, n] of Object.entries(r.evidence.presentationTypes).sort()) lines.push(`- ${t}: ${n}`);
    lines.push("");
  }
  if (r.evidence.phaseSequence.length > 0) {
    lines.push(`## 페이즈 순서`);
    lines.push("");
    lines.push(r.evidence.phaseSequence.join(" → "));
    lines.push("");
  }
  lines.push(`## 관측`);
  lines.push("");
  lines.push(`- tee 대화 덤프: ${r.evidence.conversationDump ? "있음" : "없음"}`);
  lines.push(`- 실패 잡: ${r.evidence.failedJobs.length === 0 ? "없음" : r.evidence.failedJobs.join(", ")}`);
  lines.push(`- timing 기록: ${r.evidence.timing.length}줄`);
  if (r.notes.length > 0) {
    lines.push("");
    lines.push("## 주의");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n") + "\n";
}
