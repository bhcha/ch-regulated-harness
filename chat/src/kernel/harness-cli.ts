/**
 * harness-cli.ts — core scripts 쓰기 동작 spawn 래퍼.
 *
 * 역할: '상태를 바꾸는' 동작을 `bash <harnessRoot>/scripts/*.sh` spawn 으로 환원한다(cwd=harnessRoot,
 *   env=process.env+harnessEnv 병합). 두 경로로 갈린다:
 *   · **결정 4동작(select/approve/revise/raise-limit)** = core `a2ui-action.sh` **단일 브리지 위임**(envelope 계약).
 *     각 동작을 이벤트 JSON 으로 넘기면 서버(a2ui_action.py)가 현재 게이트 허용 여부를 검증한 뒤 select.sh/
 *     approve.sh/revise.sh/run-stage.sh(raise-limit)로 위임하고, 성공·거부 모두 stdout 마지막 줄에 단일 envelope
 *     한 줄을 방출한다(계약 SSoT = core/scripts/lib/a2ui_action.py · types/a2ui.ts).
 *   · **범위 밖(ingest/intake/generate=run-stage/review=kcia-check)** = 각 스크립트 직접 spawn(브리지 미경유).
 *
 * 불변식(dev-loop-grounding 3): **state.json 직접 쓰기 코드 0** — 모든 상태 변이는 core scripts 만 한다.
 * 감사(dev-loop-grounding 3·4): 사람 행위자는 `--by chat:<platform>:<user>` 규약으로 전달(select/approve/revise).
 *   행위자 태깅(어느 플랫폼인지)은 어댑터 책임이고, 커널은 태그된 actor 를 불투명하게 그대로 이벤트 by 로 넘겨
 *   a2ui_action.py 가 --by 로 위임한다(위조 차단은 서버 권위 — 아래 byActor 주석).
 *
 * 반환 계약: 각 함수는 `{code, stdout, stderr}` 를 **반환**한다(비-0 을 throw 하지 않음) —
 *   멱등 신호(이미 승인됨/지금은 그 차례가 아님 등)를 호출부가 평이한 회신으로 매핑할 수 있게 한다.
 *   (rid/필수 인자 누락 같은 '호출부 계약 위반'만 예외로 던진다 — 하네스 종료코드와 구분.)
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chatSecretEnvNames, harnessEnv, harnessRoot, isSafeRunId } from "../config.js";
import { parseActionEnvelope } from "../types/a2ui.js";

/** spawn 1회 결과(종료코드·stdout·stderr). 비-0 은 throw 하지 않고 이 값으로 반환한다. */
export interface HarnessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 자식 출력 스트림 상한(스트림당, 문자 기준 근사). 구 spawnSync maxBuffer(32MiB) 대체 — OOM/폭주 방지. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * core scripts 1회 실행. **비동기 spawn** — 긴 core 스크립트(예 kcia-check 수 분)가 Node 이벤트 루프를
 *   블로킹하지 않게 한다(챗 서버라 다른 인터랙션 ack 가 막히면 안 됨 — spawnSync 금지). 비-0/스폰실패 모두
 *   예외 없이 결과로 환원(스폰 실패는 code<0 + stderr=메시지).
 * envOverride: 이 spawn 에만 적용할 env(예 잡별 HARNESS_WB) — process-global harnessEnv() 위에 덮는다.
 *   워커가 잡 payload 의 per-run 값(업로드된 워킹백워드 경로)을 안전히 실어 보내는 통로.
 */
function run(script: string, args: string[], envOverride?: Record<string, string>): Promise<HarnessResult> {
  const root = harnessRoot();
  const scriptPath = join(root, "scripts", script);
  // 최소권한: 챗 레이어 비밀(config.chatSecretEnvNames)을 core 및 그 하위 생성 서브프로세스(claude/codex)로
  //   전파하지 않는다 — 하네스는 이 값을 쓰지 않는다(비밀 노출면 축소). 어느 플랫폼의 비밀인지는 config 만 안다.
  //   ⚠ delete(unset)가 아니라 **빈 문자열로 set** 한다 — core/common.sh 의 .env 로더가 'set-if-unset'이라
  //     unset 하면 자식이 .env 에서 비밀을 되읽어 스크럽이 무력화된다(빈값이면 '설정됨'으로 스킵).
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...harnessEnv(), ...(envOverride ?? {}) };
  for (const k of chatSecretEnvNames()) childEnv[k] = "";
  return new Promise<HarnessResult>((resolve) => {
    const child = spawn("bash", [scriptPath, ...args], { cwd: root, env: childEnv });
    // 출력 상한(구 spawnSync maxBuffer 대체) — 비동기 스트리밍은 무한 누적이 가능해 상한 없으면 대용량 출력이
    //   챗 프로세스를 OOM 시킨다. 상한 초과 시 잘라 담고 자식을 종료(폭주 방지).
    let stdout = "";
    let stderr = "";
    let over = false;
    const cap = (cur: string, d: Buffer): string => {
      if (over) return cur;
      const room = MAX_OUTPUT_BYTES - cur.length;
      const s = d.toString("utf8");
      if (s.length <= room) return cur + s;
      over = true;
      child.kill();
      return cur + s.slice(0, Math.max(0, room));
    };
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    // 스폰 자체 실패(bash 부재 등)는 종료코드가 없다 → code<0 + 메시지로 환원(예외 미승격, 호출부가 평이 회신).
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr || err.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** run_id 누락/불안전 = 호출부 계약 위반 → 즉시 예외(하네스 종료코드와 구분). 경로 탈출 rid 를 셸 전 차단. */
function requireRid(rid: string): void {
  if (!rid || rid.trim() === "") throw new Error("harness-cli: run_id 가 비었습니다.");
  if (!isSafeRunId(rid)) throw new Error(`harness-cli: run_id 형식이 안전하지 않습니다: ${rid}`);
}

/**
 * 감사 actor 를 이벤트 by 로 넘기기 전 검증. 어댑터가 이미 `chat:<platform>:<user>` 로 태그해 싣는다(플랫폼 태깅은
 * 어댑터 책임 — 커널 무지). 커널은 태그된 actor 를 불투명하게 그대로 넘긴다. **비면 예외**(감사 추적 필수).
 *   ⚠ 선두 '--' flaglike 검사는 여기서 **제거**됐다 — actor 는 이제 위치인자가 아니라 브리지 이벤트의 JSON 값(by)으로
 *     넘어가므로 위치인자 스머글링이 원리적으로 불가하고, `--by=forged` 오인 차단은 a2ui_action.py 의
 *     `_reject_if_flaglike`(서버 권위)가 수행한다(4번 절 위임 규칙). 커널은 빈값 검사만 남긴다.
 */
function byActor(by: string): string {
  const a = (by ?? "").trim();
  if (!a) throw new Error("harness-cli: 행위자(by) 가 비었습니다 — 감사 추적(--by)에 필요합니다.");
  return a;
}

/**
 * a2ui-action.sh 브리지 위임 — 결정 4동작(select/approve/revise/raise-limit)을 이벤트 JSON 으로 넘긴다.
 *   `run("a2ui-action.sh", [rid, JSON.stringify(event)])` → 서버가 게이트 허용을 검증 후 위임하고, 성공·거부 모두
 *   stdout 마지막 줄에 단일 envelope 한 줄을 방출한다(프로세스 종료코드 = 위임 exit code, 충실 보존).
 *
 * envelope 정규화: 위임(approve.sh 등)이 실패하면 a2ui_action.py 가 **위임 stderr 를 stdout envelope.message 로
 *   합치고**(위임 출력은 stdout+stderr 병합 캡처) a2ui-action.sh 자체 stderr 는 빈다. 그대로 두면 worker 의
 *   `tail(result.stderr)` 진단이 빈 문자열이 된다 → code!==0 이고 stderr 가 비었을 때만 envelope.message 를
 *   stderr 자리에 채워 진단을 살린다(성공[code 0]은 손대지 않음 · envelope 파싱 실패면 원본 그대로).
 */
async function bridgeAction(
  rid: string,
  event: Record<string, unknown>,
  envOverride?: Record<string, string>,
): Promise<HarnessResult> {
  const res = await run("a2ui-action.sh", [rid, JSON.stringify(event)], envOverride);
  if (res.code !== 0 && res.stderr.trim() === "") {
    const msg = parseActionEnvelope(res.stdout)?.message;
    if (msg && msg.trim() !== "") return { ...res, stderr: msg };
  }
  return res;
}

/** new-run.sh: state.json 스캐폴딩(⓪ 유형 선언 — 도메인/포맷 필수). */
export interface NewRunOpts {
  /** 규제도메인(화장품|의약외품|건기식|의약품 또는 표준 id). */
  domain: string;
  /** 산출물 포맷(한장|여러장). */
  format: string;
  /** 제품명(선택 — 없으면 번들 product.json 에서 유래). */
  name?: string;
  /** 제품유형(선택). */
  type?: string;
}
export function newRun(rid: string, opts: NewRunOpts): Promise<HarnessResult> {
  requireRid(rid);
  const args = [rid, "--domain", opts.domain, "--format", opts.format];
  if (opts.name) args.push("--name", opts.name);
  if (opts.type) args.push("--type", opts.type);
  return run("new-run.sh", args);
}

/** ingest-bundle.sh: 번들 폴더 → runs/<id> 정규화(00-ingest 완료 전이). 인자 순서 = <번들> <rid>. */
export interface IngestBundleOpts {
  /** 최소 자산 수(--min). */
  min?: number;
  /**
   * 이 run 에 업로드된 워킹백워드 .md 절대경로(잡 payload.wb_path).
   * 주면 이 spawn 에만 HARNESS_WB 로 실어 ingest 가 그 파일을 읽게 한다(process-global WB 기본/stale 회피).
   */
  wbPath?: string;
}
export function ingestBundle(
  bundleDir: string,
  rid: string,
  opts: IngestBundleOpts = {},
): Promise<HarnessResult> {
  requireRid(rid);
  if (!bundleDir || bundleDir.trim() === "") {
    throw new Error("harness-cli: 번들 폴더 경로가 비었습니다.");
  }
  const args = [bundleDir, rid];
  if (opts.min !== undefined) args.push("--min", String(opts.min));
  const envOverride = opts.wbPath ? { HARNESS_WB: opts.wbPath } : undefined;
  return run("ingest-bundle.sh", args, envOverride);
}

/**
 * intake.sh: 첨부 폴더 하나로 새 run 생성 + 불변 스냅샷(00a-intake 정문 · P3-2). 인자 순서 = <첨부폴더> <rid>.
 *   제품명·도메인·포맷은 사람 선언 인자(AGENTS 규칙 8 — AI 자동분류 없음). intake.sh 는 --by 를 받지 않는다(감사는 하류 승인 단계).
 */
export interface IntakeOpts {
  /** 규제도메인(화장품|의약외품|건기식|의약품 또는 표준 id). */
  domain: string;
  /** 산출물 포맷(한장|여러장). */
  format: string;
  /** 제품명(사람 선언 — 자사/타사 크롤 구분 기준). */
  product: string;
}
export function intake(attachDir: string, rid: string, opts: IntakeOpts): Promise<HarnessResult> {
  requireRid(rid);
  if (!attachDir || attachDir.trim() === "") {
    throw new Error("harness-cli: 첨부 폴더 경로가 비었습니다.");
  }
  if (!opts.domain || !opts.format || !opts.product) {
    throw new Error("harness-cli: intake 는 제품명·도메인·포맷(사람 선언)이 모두 필요합니다.");
  }
  return run("intake.sh", [attachDir, rid, "--product", opts.product, "--domain", opts.domain, "--format", opts.format]);
}

/** run-stage.sh: 단계 생성 실행. 인자 순서 = <stage> <rid>. */
export function runStage(stage: string, rid: string): Promise<HarnessResult> {
  requireRid(rid);
  if (!stage || stage.trim() === "") throw new Error("harness-cli: stage 가 비었습니다.");
  return run("run-stage.sh", [stage, rid]);
}

/**
 * approve: 단안 승인(+RA 사후검수 ra_ok, 선택 코멘트). by 감사 필수. → a2ui-action.sh 브리지 위임.
 *   ra_ok:false 도 안전 — 서버(a2ui_action.py)는 `ev['ra_ok'] is True` 일 때만 --ra-ok 로 승격한다.
 */
export interface ApproveOpts {
  /** 승인 코멘트(선택). */
  comment?: string;
  /** 민감 기능성 RA 사후검수 확인(ra_ok). */
  raOk?: boolean;
  /** 행위자(감사 by). */
  by: string;
}
export function approve(rid: string, opts: ApproveOpts): Promise<HarnessResult> {
  requireRid(rid);
  const event: Record<string, unknown> = {
    action: "approve",
    ...(opts.comment ? { comment: opts.comment } : {}),
    ra_ok: opts.raOk === true,
    by: byActor(opts.by),
  };
  return bridgeAction(rid, event);
}

/** revise: 보완/거절-재제안. reason=보완 방향(direction), extra=대상 표현(target, 선택). by 감사 필수. → 브리지 위임. */
export interface ReviseOpts {
  /** 행위자(감사 by). */
  by: string;
  /** 대상 표현 target(선택). */
  extra?: string;
}
export function revise(rid: string, reason: string, opts: ReviseOpts): Promise<HarnessResult> {
  requireRid(rid);
  if (!reason || reason.trim() === "") throw new Error("harness-cli: 보완 사유(reason) 가 비었습니다.");
  const event: Record<string, unknown> = {
    action: "revise",
    direction: reason,
    ...(opts.extra ? { target: opts.extra } : {}),
    by: byActor(opts.by),
  };
  return bridgeAction(rid, event);
}

/** select: 다안 선택(옵션 키). by 감사 필수. → 브리지 위임(옵션키 존재성은 서버가 현재 surface 로 검증). */
export interface SelectOpts {
  /** 행위자(감사 by). */
  by: string;
}
export function select(rid: string, key: string, opts: SelectOpts): Promise<HarnessResult> {
  requireRid(rid);
  if (!key || key.trim() === "") throw new Error("harness-cli: 선택 옵션 키(key) 가 비었습니다.");
  return bridgeAction(rid, { action: "select", value: key, by: byActor(opts.by) });
}

/**
 * raiseLimit: 에스컬레이션(보완 상한 초과) 복구 — 상한을 올린다. → a2ui-action.sh 브리지(run-stage.sh raise-limit 위임).
 *   by 를 싣지 않는다(에스컬레이션 복구는 승인자 게이트가 worker 에서 이미 걸리고, run-stage raise-limit 는 --by 미수용).
 */
export function raiseLimit(rid: string): Promise<HarnessResult> {
  requireRid(rid);
  return bridgeAction(rid, { action: "raise-limit" });
}

/** kcia-check.sh: 심의 게이트(규정 점검). */
export function kciaCheck(rid: string): Promise<HarnessResult> {
  requireRid(rid);
  return run("kcia-check.sh", [rid]);
}
