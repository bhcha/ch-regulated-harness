/**
 * transcript.ts — 인수 하네스용 시간순 트랜스크립트 직렬화기(순수·결정론).
 *
 * ATDD 인수 계층(chat-atdd-acceptance-plan 2-2 "Transcript"): 시간순 로그로 각 스텝을
 *   `{발화 이벤트, 이후 렌더 화면들, na 스냅샷}` 으로 모아 **결정론 JSONL** 로 직렬화한다. 이 JSONL 은
 *   ①CI 구조 assert 재료이자 ②사람/AI 판독 아티팩트(라이브 공유)다 — 그래서 같은 입력이면 매 실행
 *   **바이트 동일**해야 한다.
 *
 * 결정론 규약:
 *   · 벽시계 금지 — Date.now()/new Date()/Math.random() 을 쓰지 않는다(입력만으로 출력이 결정된다).
 *   · 키 순서 안정 — 중첩 객체 키를 재귀적으로 정렬해 직렬화한다(입력 객체의 키 삽입 순서와 무관하게 동일 바이트).
 *   · 한 줄 = 한 JSON 객체, 매 줄 개행 종료. 빈 트랜스크립트 = 빈 문자열.
 *
 * 커널-중립: src/kernel/** · src/types/** 만 import(어댑터 무지 — kernel-neutral 가드 정신).
 */
import type { ChatEvent } from "../kernel/events.js";
import type { Presentation } from "../kernel/presentation.js";
import type { NextAction } from "../types/contract.js";

/** 트랜스크립트 1엔트리 — 발화 이벤트 + 그 뒤 렌더된 화면들 + (선택) na 스냅샷. */
export interface TranscriptEntry {
  /** 이 스텝을 촉발한 발화(fire 한 ChatEvent). */
  utterance: ChatEvent;
  /** 발화 이후 렌더된 화면들(순서 보존). */
  screens: Presentation[];
  /** 그 시점 next-action 스냅샷(선택). */
  na?: NextAction;
}

/**
 * 결정론 JSON 직렬화기 — 객체 키를 재귀 정렬해 삽입 순서와 무관하게 바이트 동일 출력을 낸다.
 *   undefined 값의 키는 생략(JSON.stringify 규약과 동치), 비유한 숫자(NaN/Infinity)는 null(JSON 규약).
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
      "}"
    );
  }
  // undefined/function/symbol 등 JSON 비직렬화 값 — 우리 데이터엔 없다(방어적 null).
  return "null";
}

/** 엔트리 배열 → 결정론 JSONL(한 줄=한 객체, 매 줄 개행 종료). 빈 배열 = 빈 문자열. */
export function entriesToJSONL(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    // na 는 있을 때만 키를 싣는다(없으면 stableStringify 가 어차피 생략하지만 명시적으로 가른다).
    const obj: Record<string, unknown> =
      e.na === undefined
        ? { utterance: e.utterance, screens: e.screens }
        : { utterance: e.utterance, screens: e.screens, na: e.na };
    lines.push(stableStringify(obj));
  }
  return lines.join("\n") + "\n";
}

/** JSONL → 엔트리 배열(왕복 헬퍼). 빈 줄은 건너뛴다. */
export function parseJSONL(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as TranscriptEntry);
  }
  return out;
}

/** 시간순 append 빌더 — 발화·화면들·(선택)na 를 순서대로 쌓고 toJSONL() 로 결정론 직렬화한다. */
export class Transcript {
  private readonly _entries: TranscriptEntry[] = [];

  /**
   * 스텝 하나 추가(발화 + 이후 화면들 + 선택 na). 입력을 **깊은 복사**해 이후 호출자 변형과 격리한다 —
   *   트랜스크립트는 시점(point-in-time) 스냅샷이라, append 이후 드라이버가 같은 Presentation/ChatEvent/
   *   NextAction 객체를 재사용·변형해도 이미 쌓인 엔트리는 불변이어야 한다(그래야 JSONL 아티팩트가 정확하다).
   *   recording-port.ts 의 structuredClone 격리와 같은 규율(Codex W-A 리뷰 P2). 얕은 `[...screens]` 는 배열만
   *   격리하고 원소·utterance·na 참조는 공유해 소급 변경을 허용했었다 — 전체 엔트리 깊은 복사로 봉인.
   */
  append(utterance: ChatEvent, screens: Presentation[], na?: NextAction): this {
    const entry: TranscriptEntry =
      na === undefined
        ? { utterance: structuredClone(utterance), screens: structuredClone(screens) }
        : { utterance: structuredClone(utterance), screens: structuredClone(screens), na: structuredClone(na) };
    this._entries.push(entry);
    return this;
  }

  /**
   * 쌓인 엔트리(읽기 전용 시점 스냅샷). 내부 객체를 그대로 노출하면 소비자가 반환된 엔트리의 screens/utterance/na 를
   *   변형해 이후 toJSONL() 출력을 오염시킬 수 있다(readonly 는 바깥 배열만 얼린다) — append 의 깊은복사 격리와 같은
   *   규율로 **깊은 복사**를 돌려준다(Codex S2 리뷰 P2). toJSONL() 은 내부 _entries 를 직접 읽으므로 이 복사에 무관하다.
   */
  get entries(): readonly TranscriptEntry[] {
    return structuredClone(this._entries);
  }

  /** 결정론 JSONL 직렬화. */
  toJSONL(): string {
    return entriesToJSONL(this._entries);
  }
}
