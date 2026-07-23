/**
 * intake-files.ts — NL 파일 인입(P3-2)의 경로 검증(allowlist + realpath 봉쇄 · 읽기 전용).
 *
 * chat-hexagonal-gateway-plan R-4: 임의 경로 인입 차단. 사람이 NL 로 준 경로는 신뢰하지 않는다 —
 *   ① `CHAT_NL_FILE_ROOTS`(config.nlFileRoots) allowlist 루트가 없으면 **파일 인입 자체 불가**(fail-closed).
 *   ② realpath 로 심링크를 모두 해소한 뒤 그 루트 실경로 하위에 있는지 강제(keyvisual-reader 봉쇄 패턴과 동형).
 *   ③ 일반 파일만 통과(디렉터리·특수파일 배제). 통과분은 해소된 실경로(realPath)로 확정 — 이후 스냅샷 복사 대상.
 *
 * ── S-3 스파이크(chat→intake.sh 배선 + PDF→md 변환 책임) 결론 ──────────────────────────────
 *   질문: 챗이 NL 파일 인입을 core `intake.sh` 로 어떻게 잇고, PDF→md 변환은 누구 책임인가?
 *   결론:
 *     · **배선 완료** — 이 검증 → intake.ts.stageIntakeFolder 로 불변 스냅샷 폴더에 복사 → harness-cli.intake 가
 *       `bash scripts/intake.sh <폴더> <rid> --product --domain --format` 을 spawn(00a-intake 정문). 잡 kind="intake".
 *     · **PDF→md 는 챗의 책임이 아니다(도구 의존을 core 로 유지)** — intake.sh 는 첨부 폴더의 원본 파일을 **바이트 그대로
 *       스냅샷**하고, 분류·추출은 하류 00a-intake(세션 /intake 제안) → 00e-evidence 가 한다. core 는 그 단계에서
 *       poppler(pdftoppm/pdftotext)로 PDF 를 다룬다(AGENTS 2번 절 · 메모리 bm-designer-handoff). 그래서 챗은 PDF 를
 *       변환하지 않고 **원본 그대로 통과**시킨다(.docx→md 인라인 변환은 답글-붙여넣기 WB 경로 전용 — intake.ts).
 *   범위: 파서 + allowlist + 스냅샷 + intake wrapper 는 오프라인 단위 테스트로 덮는다. 실제 intake.sh spawn + 실 PDF
 *     파이프라인은 **S-3 경계(오프라인 미검증)** — 라이브 검증 대상.
 */
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import type { NlFileRef } from "./parser.js";

/** 검증 통과한 파일 1건(원본 경로 + 해소된 실경로). */
export interface AcceptedIntakeFile {
  role: NlFileRef["role"];
  /** 사람이 준 원본 경로(감사·표시용). */
  path: string;
  /** realpath 로 심링크를 해소한 실경로(스냅샷 복사 원본). */
  realPath: string;
}

/** 거부 1건. */
export interface RejectedIntakeFile {
  ref: NlFileRef;
  reason: string;
}

export interface IntakeFileValidation {
  accepted: AcceptedIntakeFile[];
  rejected: RejectedIntakeFile[];
}

/**
 * 파일 참조 목록을 allowlist 루트 기준으로 검증한다(예외 없음).
 *   roots 가 비면 전부 거부(파일 인입 경로 미설정 = fail-closed). 통과 조건: realpath 가 어느 루트 실경로 하위의 일반 파일.
 */
export function validateIntakeFiles(files: NlFileRef[], roots: string[]): IntakeFileValidation {
  const accepted: AcceptedIntakeFile[] = [];
  const rejected: RejectedIntakeFile[] = [];

  if (roots.length === 0) {
    for (const ref of files) rejected.push({ ref, reason: "파일 인입 폴더가 설정되어 있지 않습니다." });
    return { accepted, rejected };
  }

  // 루트도 realpath 로 고정(루트 자체가 심링크여도 실경로로 경계 판정).
  const realRoots = roots
    .map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return null;
      }
    })
    .filter((r): r is string => r !== null);

  if (realRoots.length === 0) {
    for (const ref of files) rejected.push({ ref, reason: "파일 인입 폴더를 확인할 수 없습니다." });
    return { accepted, rejected };
  }

  for (const ref of files) {
    try {
      const real = realpathSync(ref.path); // 중간 디렉터리까지 모든 심링크 해소.
      const contained = realRoots.some((root) => real === root || real.startsWith(root + sep));
      if (!contained) {
        rejected.push({ ref, reason: "허용된 폴더 밖의 파일입니다." });
        continue;
      }
      if (!statSync(real).isFile()) {
        rejected.push({ ref, reason: "일반 파일이 아닙니다." });
        continue;
      }
      accepted.push({ role: ref.role, path: ref.path, realPath: real });
    } catch {
      rejected.push({ ref, reason: "파일을 찾을 수 없습니다." });
    }
  }
  return { accepted, rejected };
}
