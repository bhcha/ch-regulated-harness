/**
 * option-reader.ts — 다안(select) 게이트의 안별 내용 읽기(플랫폼-중립 · 읽기 전용).
 *
 * 역할: core 산출물 `HARNESS_ROOT/runs/<rid>/<phase-dir>/options-compare.md` 를 읽어 `## <key>` 섹션으로
 *   쪼갠다. 커널 flow 가 select 아웃컴을 OptionSet 표현으로 만들 때 안별 제목/본문을 여기서 얻는다.
 *
 * 불변식(dev-loop-grounding 3): 이 모듈은 core **출력 산출물만 읽는다**(next-action 읽기와 동급 — 허용).
 *   state.json·산출물을 **쓰지 않는다**. 렌더 경로에 예외를 던지지 않는다 — 파일 부재/손상/경로 위험이면
 *   빈 문서로 우아하게 폴백(안 키만 남는다).
 *
 * 경로 안전: rid 는 isSafeRunId 로 검증(디렉터리 탈출 차단). phase→dir 매핑에 없는 phase 는 무시(null).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessRoot, isSafeRunId } from "../config.js";

/** 다안 한 섹션(options-compare.md 의 `## <header>` 블록). */
export interface OptionSection {
  /** `## ` 뒤 원본 헤더 텍스트(예 "A-efficacy" · "A — 전개 순서"). */
  header: string;
  /** 대표 한 줄(컨셉=메시지 라인 · 스토리라인=전개 라인 · 없으면 헤더). */
  title: string;
  /** 이 안의 마크다운 전문(`## <header>` 헤더 라인 포함). */
  body: string;
}

/** options-compare.md 파싱 결과. */
export interface OptionsDoc {
  /** 원본 전문(참고용). 부재/손상 시 "". */
  compareMd: string;
  /** 문서 순서의 섹션들. 부재/손상 시 []. */
  sections: OptionSection[];
}

/**
 * phase → 선택 게이트 산출 디렉터리(HARNESS_ROOT/runs/<rid>/ 하위).
 *   · 02-concept       → 02-concept              (컨셉 다안)
 *   · 03-storyboard    → 03-storyboard/outline    (스토리라인 outline 이 select 서브스테이지; plan 은 단안 승인)
 */
const PHASE_DIR: Record<string, string> = {
  "02-concept": "02-concept",
  "03-storyboard": "03-storyboard/outline",
};

/** rid+phase → options-compare.md 절대경로. 안전하지 않거나 매핑 밖이면 null(렌더 폴백). */
export function optionsComparePath(rid: string, phase: string): string | null {
  if (!isSafeRunId(rid)) return null;
  const dir = PHASE_DIR[phase];
  if (!dir) return null;
  let root: string;
  try {
    root = harnessRoot();
  } catch {
    return null; // HARNESS_ROOT 미주입 등 — 렌더를 깨지 않고 빈 문서로 폴백.
  }
  return join(root, "runs", rid, dir, "options-compare.md");
}

/** 메시지 라인·첫 본문 라인·헤더 순으로 대표 제목을 고른다. */
function deriveTitle(bodyLines: string[], header: string): string {
  // ① 메시지 라인 우선(컨셉: `- **메시지**: …`).
  for (const line of bodyLines) {
    const idx = line.indexOf("**메시지**");
    if (idx >= 0) {
      const t = line.slice(idx + "**메시지**".length).replace(/^[:：*\s-]+/, "").trim();
      if (t) return t;
    }
  }
  // ② 없으면 헤더 다음 첫 비어있지 않은 본문 라인(스토리라인: 전개 순서 라인 등).
  for (const line of bodyLines.slice(1)) {
    const t = line.replace(/^[-*>\s]+/, "").trim();
    if (t) return t;
  }
  // ③ 그래도 없으면 헤더 원문.
  return header;
}

/** options-compare.md 본문을 `## <header>` 섹션 배열로 파싱(문서 순서 보존). */
export function parseSections(md: string): OptionSection[] {
  const lines = md.split("\n");
  const out: OptionSection[] = [];
  let cur: { header: string; lines: string[] } | null = null;
  const finish = (c: { header: string; lines: string[] }): OptionSection => ({
    header: c.header,
    title: deriveTitle(c.lines, c.header),
    body: c.lines.join("\n").trim(),
  });
  for (const line of lines) {
    // `# ` 최상위 제목은 섹션이 아니다 — `## ` 이상(옵션 헤더)만 잡는다.
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(finish(cur));
      cur = { header: m[1]!, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push(finish(cur));
  return out;
}

/**
 * 옵션 키에 해당하는 섹션을 찾는다. 정확 일치 우선(컨셉: 헤더==키 "A-efficacy"),
 *   없으면 경계 있는 접두 일치(스토리라인: 헤더 "A — 전개 순서" 의 키 "A" — 키 뒤 첫 문자가 비-영숫자).
 */
export function findSection(sections: OptionSection[], key: string): OptionSection | undefined {
  const exact = sections.find((s) => s.header === key);
  if (exact) return exact;
  return sections.find((s) => {
    if (!s.header.startsWith(key)) return false;
    const rest = s.header.slice(key.length);
    return rest === "" || /^[^A-Za-z0-9]/.test(rest);
  });
}

/** rid+phase 의 options-compare.md 를 읽어 파싱. 부재/손상/경로위험이면 빈 문서(폴백 · 예외 없음). */
export async function readOptionsDoc(rid: string, phase: string): Promise<OptionsDoc> {
  const path = optionsComparePath(rid, phase);
  if (!path) return { compareMd: "", sections: [] };
  let md: string;
  try {
    md = await readFile(path, "utf8");
  } catch {
    return { compareMd: "", sections: [] };
  }
  return { compareMd: md, sections: parseSections(md) };
}
