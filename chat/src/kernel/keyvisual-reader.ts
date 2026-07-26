/**
 * keyvisual-reader.ts — 다안 이미지(04-keyvisual) 선택 게이트의 안별 미리보기 이미지 읽기(플랫폼-중립 · 읽기 전용).
 *
 * 역할: core 산출물 `HARNESS_ROOT/runs/<rid>/04-keyvisual/` 에서 각 옵션 키(A/B/C)의 미리보기 이미지 경로를
 *   해석한다. 커널 flow 가 keyvisual 의 select 아웃컴을 ImageOptionSet 표현으로 만들 때 안별 이미지·캡션을
 *   여기서 얻는다(option-reader 의 이미지판 — 같은 불변식).
 *
 * 해석 우선순위(옵션 키별):
 *   ① `options/<key>/shots/full.png`   — 안별 전체 페이지 렌더(있으면 이것만).
 *   ② `generated/*.png`(정렬)          — 블록 이미지 세트(full.png 부재 시 폴백; 온라인 실엔진에서 존재).
 *   ③ `[]`                             — 미리보기 산출물 없음(오프라인 stub 은 generated 가 .svg 라 여기 폴백 — caption 이 밝힌다).
 *
 * 불변식(dev-loop-grounding 3): 이 모듈은 core **출력 산출물만 읽는다**(next-action 읽기와 동급 — 허용).
 *   state.json·산출물을 **쓰지 않는다**. 렌더 경로에 예외를 던지지 않는다 — 파일 부재/손상/경로 위험이면
 *   빈 경로로 우아하게 폴백(안 키만 남는다).
 *
 * 경로 안전: rid 는 isSafeRunId 로 검증(디렉터리 탈출 차단). HARNESS_ROOT 미주입이면 null(렌더 폴백).
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { demoKeyvisualDir, harnessRoot, isSafeRunId } from "../config.js";

/** PNG 시그니처(첫 8바이트). 미리보기로 올릴 것은 '진짜 PNG'만 — 하드링크/위조 콘텐츠로 비밀 유출 차단. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 파일 앞 8바이트가 PNG 시그니처인지(예외 없음). realpath 봉쇄는 심링크 탈출을 막지만 **하드링크**(예
 *   `full.png` 를 `~/.env` 에 하드링크 — realpath 가 kvDir 안 그대로라 봉쇄를 통과)나 위조 콘텐츠는 못 막는다.
 *   업로드 대상은 이미지 미리보기이므로 '진짜 PNG 바이트'만 통과시켜 그 벡터를 닫는다. 8바이트만 로컬로 읽고
 *   (업로드 아님) 불일치면 배제한다.
 */
function looksLikePng(realPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(realPath, "r");
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return n === 8 && buf.equals(PNG_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 무시 */
      }
    }
  }
}

/** ImageOptionSet 한 안의 읽기 결과(안 키 · 미리보기 경로[] · 캡션 · 추천). */
export interface KeyvisualOption {
  key: string;
  /** 미리보기 이미지 로컬 파일 경로(없으면 빈 배열). */
  imagePaths: string[];
  /** 대표 한 줄(평이 한국어). */
  caption: string;
  /** 추천 top-1 여부(key === recommended). */
  recommended: boolean;
}

/** 04-keyvisual 산출 디렉터리(HARNESS_ROOT/runs/<rid>/ 하위). */
const KEYVISUAL_DIR = "04-keyvisual";

/** rid → 04-keyvisual 절대경로. 안전하지 않거나 HARNESS_ROOT 미주입이면 null(렌더 폴백). */
export function keyvisualDir(rid: string): string | null {
  if (!isSafeRunId(rid)) return null;
  let root: string;
  try {
    root = harnessRoot();
  } catch {
    return null; // HARNESS_ROOT 미주입 등 — 렌더를 깨지 않고 빈 문서로 폴백.
  }
  return join(root, "runs", rid, KEYVISUAL_DIR);
}

/**
 * 후보 경로가 **kvDir 안에 실재하는 일반 파일**인지 — 심볼릭 링크 탈출 차단(외부리뷰 P2 HIGH).
 *   `runs/<rid>/04-keyvisual/` 안의 파일은 core 산출물이지만, 심링크(예 `full.png -> ~/.env`)나 심링크된 상위
 *   디렉터리(`shots -> /secrets`)로 임의 로컬 파일을 가리킬 수 있다. 이 경로를 그대로 읽어 Slack 에 올리면
 *   비밀 유출이다. 그래서 **realpath 로 심링크를 모두 해소한 뒤 kvDir 실경로 하위에 있는지** 강제한다
 *   (안전한 rid 만으로는 부족 — 안쪽 심링크가 우회한다). 통과하면 해소된 실경로를 돌려준다(읽기 대상 확정).
 *   예외 없음 — 위험/부재/손상이면 null.
 */
function containedRealFile(kvDirReal: string, candidate: string): string | null {
  try {
    const real = realpathSync(candidate); // 모든 심링크 해소(중간 디렉터리 포함).
    // kvDir 실경로 자기 자신 또는 그 하위여야 한다(경계에 sep 를 붙여 형제 접두 오탐 방지) — 심링크 탈출 차단.
    if (real !== kvDirReal && !real.startsWith(kvDirReal + sep)) return null;
    if (!statSync(real).isFile()) return null;
    // 하드링크·위조 콘텐츠 차단: 실제 PNG 바이트인 것만 미리보기로 인정(비밀 파일은 시그니처 불일치로 배제).
    if (!looksLikePng(real)) return null;
    return real;
  } catch {
    return null; // 부재·broken 심링크·권한 오류 등.
  }
}

/**
 * 한 옵션 키의 미리보기 이미지 경로 해석(full.png 우선 → generated/*.png → []). 예외 없음.
 *   모든 후보는 containedRealFile 로 심링크 탈출을 걸러 kvDir 안 실파일만 돌려준다(임의 파일 유출 차단).
 */
function resolveOptionImages(kvDir: string, key: string): string[] {
  let kvDirReal: string;
  try {
    kvDirReal = realpathSync(kvDir); // 경계 기준(kvDir 자체가 심링크여도 그 실경로로 고정).
  } catch {
    return []; // kvDir 부재 — 미리보기 없음.
  }
  // ① 안별 전체 페이지 렌더.
  const full = containedRealFile(kvDirReal, join(kvDir, "options", key, "shots", "full.png"));
  if (full) return [full];
  // ② 블록 이미지 세트(정렬 — 문서 순서 안정). 각 후보를 containedRealFile 로 검증.
  try {
    const gdir = join(kvDir, "generated");
    return readdirSync(gdir)
      .filter((n) => n.toLowerCase().endsWith(".png"))
      .sort()
      .map((n) => containedRealFile(kvDirReal, join(gdir, n)))
      .filter((p): p is string => p !== null);
  } catch {
    return []; // generated 없음/접근 불가 — 미리보기 없이 진행(caption 이 밝힘).
  }
}

/** 옵션 캡션(평이) — 이미지 있으면 장수, 없으면 '미리보기 없음(디자인만)'. */
function caption(key: string, count: number): string {
  return count > 0 ? `${key}안 · 이미지 ${count}장` : `${key}안 · 미리보기 없음(디자인만 준비됨)`;
}

/**
 * 데모(촬영) 이미지 소스 — CHAT_DEMO_KV_IMAGES 디렉터리(04-keyvisual 레이아웃)의 `options/<key>/shots/full.png` 실 PNG 를
 *   옵션 키 정렬 순으로 모은다. stub 키비주얼은 svg 라 미리보기가 없어, **최근 실 런의 이미지를 촬영용으로 대체**한다
 *   (readKeyvisualOptions 가 옵션 인덱스별로 순환 배정 — run 의 실제 옵션 키 이름과 무관하게 모든 옵션이 실 이미지를 얻는다).
 *   containedRealFile 로 심링크 탈출·비-PNG 를 그대로 차단(운영자 제공 env 라도 검증은 불변). 예외 없음(빈 배열 폴백).
 */
function resolveDemoImages(demoDir: string): string[] {
  let real: string;
  try {
    real = realpathSync(demoDir);
  } catch {
    return [];
  }
  let optionKeys: string[];
  try {
    optionKeys = readdirSync(join(demoDir, "options")).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const k of optionKeys) {
    const p = containedRealFile(real, join(demoDir, "options", k, "shots", "full.png"));
    if (p) out.push(p);
  }
  return out;
}

/**
 * 옵션 키 목록의 미리보기 이미지·캡션을 해석한다(읽기 전용 · 예외 없음).
 *   flow.presentationForOutcome 이 keyvisual select 아웃컴을 ImageOptionSet 으로 만들 때 주입해 쓴다
 *   (테스트는 fake reader 로 교체 — 디스크 무관).
 */
export async function readKeyvisualOptions(
  rid: string,
  keys: string[],
  recommended: string | null,
): Promise<KeyvisualOption[]> {
  // 데모(촬영) 모드: run 산출물(stub svg) 대신 CHAT_DEMO_KV_IMAGES 의 실 PNG 를 옵션별로 순환 배정한다
  //   (모든 옵션이 실 이미지를 얻어 Slack 에 첨부 · run 옵션 키 이름과 무관). 미설정이면 아래 기존 경로.
  const demoDir = demoKeyvisualDir();
  if (demoDir) {
    const demoImages = resolveDemoImages(demoDir);
    return keys.map((key, i) => {
      const imagePaths = demoImages.length > 0 ? [demoImages[i % demoImages.length]!] : [];
      return { key, imagePaths, caption: caption(key, imagePaths.length), recommended: key === recommended };
    });
  }
  const kvDir = keyvisualDir(rid);
  return keys.map((key) => {
    const imagePaths = kvDir ? resolveOptionImages(kvDir, key) : [];
    return { key, imagePaths, caption: caption(key, imagePaths.length), recommended: key === recommended };
  });
}
