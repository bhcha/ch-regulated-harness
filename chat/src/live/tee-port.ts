/**
 * tee-port.ts — 라이브(온라인) 백엔드의 관측 포트(잠긴 결정 3: 실 Slack tee + JSONL).
 *
 * ── 무엇인가 ─────────────────────────────────────────────────────────────────────
 *   TeeRecordingPort 는 게이트웨이(createGateway)에 물리는 ChatPort 다. 커널이 render() 로 내보내는 모든
 *   중립 Presentation 을 ①**로컬 기록**(순서 보존)하고 ②**실 Slack 포트로 tee**(사람 참관·사후검토)하며,
 *   ③선택적으로 그 기록을 **JSONL 아티팩트**로 디스크에 남긴다(AI 심판·사람 판독 입력).
 *
 * ── 동결 모듈을 '합성'한다(재작성 아님) ─────────────────────────────────────────────
 *   tee 는 새로 만들지 않는다 — 인수 하네스의 동결 `RecordChatPort` 가 이미 지원하는 **delegate 이음새**를 쓴다:
 *     `new RecordChatPort(slackPort)` = render/subscribe/capabilities 를 **로컬 기록 후** slackPort(실 Slack)에
 *     위임한다(recording-port.ts 의 "FUTURE-LIVE TEE" 규약). 이 클래스는 그 위에 JSONL 지속만 얹는다.
 *   그래서 CI 백엔드(delegate 없는 순수 기록)와 라이브 백엔드(이 tee)는 **같은 기록 포트, 다른 배선**이다.
 *
 * ── 플랫폼 무지 ──────────────────────────────────────────────────────────────────
 *   이 파일은 Slack 을 **import 하지 않는다** — delegate 는 생성자 인자로 받는다(테스트는 fake, 라이브는
 *   live-assembly 가 buildSlackChatPort 로 만든 실 포트). 그래서 오프라인 단위 테스트가 실 Slack 없이 tee 계약을
 *   검증한다. (src/live/ 는 kernel-neutral 가드 스캔 밖이지만, 이 파일 자체는 플랫폼 토큰이 없다.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RecordChatPort, type RecordedRender } from "../acceptance/recording-port.js";
import type { CapabilityManifest, ChatPort } from "../kernel/ports.js";
import type { Presentation } from "../kernel/presentation.js";

/** 파일 쓰기 이음새(테스트 주입 · 기본 = node fs). */
export type WriteFileFn = (path: string, data: string) => void;

const defaultWriteFile: WriteFileFn = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, "utf8");
};

export interface TeeRecordingPortOptions {
  /** 실 렌더 포트(라이브 = Slack ChatPort · 테스트 = fake). 로컬 기록 '후' 이 포트로 tee 된다. */
  delegate: ChatPort;
  /** 설정 시 render 마다 JSONL 트랜스크립트를 이 절대경로에 스냅샷한다(관측 아티팩트). 미설정=지속 안 함(인메모리만). */
  jsonlPath?: string;
  /** 파일 쓰기 주입(테스트). 기본 = mkdir -p + writeFile. */
  writeFile?: WriteFileFn;
  /** 지속 실패 로그(기본 = stderr). 지속 실패는 tee/기록/렌더를 막지 않는다(관측은 best-effort). */
  log?: (line: string) => void;
}

/** 기록 1건 → 결정론적 한 줄(seq·threadId·presentation 순 · 사람/AI 판독 아티팩트). */
function renderLine(r: RecordedRender): string {
  return JSON.stringify({ seq: r.seq, threadId: r.threadId, presentation: r.presentation });
}

/** 기록 목록 → JSONL(한 줄=한 render, 매 줄 개행 종료). 빈 목록=빈 문자열. */
export function rendersToJSONL(renders: readonly RecordedRender[]): string {
  if (renders.length === 0) return "";
  return renders.map(renderLine).join("\n") + "\n";
}

/**
 * ChatPort 구현 — 동결 RecordChatPort(delegate=실 Slack)를 감싸 기록+tee 하고, render 마다 JSONL 을 지속한다.
 *   게이트웨이는 이걸 자기 chat 포트로 쓴다(커널은 tee/지속을 모른다 — 관측은 어댑터 계층의 부수효과).
 */
export class TeeRecordingPort implements ChatPort {
  /** 동결 기록 포트(delegate=실 Slack) — 기록 후 tee 는 이 인스턴스의 delegate 이음새가 수행한다. */
  private readonly recorder: RecordChatPort;
  private readonly jsonlPath?: string;
  private readonly writeFile: WriteFileFn;
  private readonly log: (line: string) => void;

  constructor(opts: TeeRecordingPortOptions) {
    // ★ delegate 이음새로 tee: RecordChatPort 가 로컬 기록 '후' delegate(실 Slack)에 render/subscribe 위임.
    this.recorder = new RecordChatPort(opts.delegate);
    if (opts.jsonlPath !== undefined) this.jsonlPath = opts.jsonlPath;
    this.writeFile = opts.writeFile ?? defaultWriteFile;
    this.log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  }

  async render(threadId: string, p: Presentation): Promise<void> {
    // 기록 + tee(recorder 가 delegate 로 위임) → 그 다음 JSONL 스냅샷(best-effort · tee 를 막지 않음).
    await this.recorder.render(threadId, p);
    this.persist();
  }

  async subscribe(threadId: string): Promise<void> {
    await this.recorder.subscribe(threadId);
  }

  capabilities(): CapabilityManifest {
    // delegate(실 Slack)의 능력 선언을 그대로 노출한다(RecordChatPort 위임).
    return this.recorder.capabilities();
  }

  /** 기록된 render 목록(방어적 스냅샷 — RecordChatPort.renders 위임). */
  renders(): RecordedRender[] {
    return this.recorder.renders();
  }

  /** 구독한 threadId 목록(스냅샷). */
  subscriptions(): string[] {
    return this.recorder.subscriptions();
  }

  /** 현재까지 기록의 결정론 JSONL(디스크 지속과 무관하게 언제든 얻는다). */
  toJSONL(): string {
    return rendersToJSONL(this.recorder.renders());
  }

  /** 현재 기록을 JSONL 파일로 스냅샷(jsonlPath 미설정이면 no-op). 실패는 흡수(관측 best-effort). */
  persist(): void {
    if (this.jsonlPath === undefined) return;
    try {
      this.writeFile(this.jsonlPath, this.toJSONL());
    } catch (e) {
      this.log(`[라이브tee] JSONL 지속 실패(무시): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
