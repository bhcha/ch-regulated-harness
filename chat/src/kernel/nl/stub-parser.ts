/**
 * stub-parser.ts — 결정적 키워드 규칙 파서(오프라인/CI 기본 · 순수 · 네트워크 0).
 *
 * chat-hexagonal-gateway-plan P3: 오프라인/CI 는 결정적 stub 파서를 쓴다(LLM 없이 파싱 회귀를 픽스처로 검증).
 *   명시 선언만 추출한다(잠긴 결정 7 — 내용 기반 추론 금지). 못 뽑은 필드는 uncertain 으로 남긴다.
 */
import { fieldsUncertain, type NlFileRef, type NlIntent, type NlKind, type NlParseContext, type NlParser } from "./parser.js";

/** 규제도메인 명시 선언 → CLI 토큰. 더 구체적인 것부터(의약외품 ⊃ '의약' 오탐 방지). 없으면 undefined. */
function extractDomain(t: string): string | undefined {
  if (/의약\s*외품|quasi[- ]?drug/i.test(t)) return "의약외품";
  if (/건기식|건강\s*기능\s*식품|health\s*food/i.test(t)) return "건기식";
  if (/의약품|전문\s*의약품|일반\s*의약품|\bdrug\b|medicine/i.test(t)) return "의약품";
  if (/화장품|코스메틱|cosmetic/i.test(t)) return "화장품";
  return undefined;
}

/** 산출물 포맷 명시 선언 → CLI 토큰. '여러 장' 을 먼저(둘 다 '장' 포함). 없으면 undefined. */
function extractFormat(t: string): string | undefined {
  if (/여러\s*장|멀티|multi[- ]?page|multipage/i.test(t)) return "여러장";
  if (/한\s*장|단일|one[- ]?page|한\s*장짜리/i.test(t)) return "한장";
  return undefined;
}

/** 제품명 휴리스틱: 따옴표 인용 우선, 그다음 "제품명은 X". 없으면 undefined. */
function extractProduct(t: string): string | undefined {
  const q = t.match(/["'“”「『]([^"'“”」』\n]{1,60})["'“”」』]/);
  if (q && q[1] && q[1].trim()) return q[1].trim();
  const m = t.match(/제품(?:명|\s*이름)?\s*(?:은|는|이|:)?\s*([^\n,.]{1,40})/);
  if (m && m[1]) {
    const v = m[1].trim().replace(/(이에요|예요|이야|야|입니다|이다|이고|으로|로)\s*$/u, "").trim();
    if (v) return v;
  }
  return undefined;
}

/** 게이트 실행 의도(승인/시작/선택/보완). NL 은 실행 안 함 — flow 가 버튼 카드를 재게시하는 신호. */
function extractExecute(t: string): NlIntent["execute"] | undefined {
  if (/승인|approve|허가|오케이|\bok\b|진행\s*해/i.test(t)) return "approve";
  if (/시작\s*해|start\b/i.test(t)) return "start";
  if (/선택|골라|이걸로|이거로|choose|select/i.test(t)) return "select";
  if (/보완|고쳐|다시\s*(?:해|제안|만들)|수정/i.test(t)) return "revise";
  return undefined;
}

/** 경로 앞 문맥에서 역할 판정(키워드 없으면 reference 기본). */
function roleFor(context: string): NlFileRef["role"] {
  if (/워킹\s*백워드|working\s*backwards|제품\s*자료|제품\s*소개/i.test(context)) return "working_backwards";
  if (/시험\s*성적서|성적서|test\s*report/i.test(context)) return "test_report";
  return "reference";
}

/** 절대경로(POSIX '/…') + 알려진 확장자 토큰을 뽑고, 직전 문맥으로 역할을 붙인다. */
function extractFiles(t: string): NlFileRef[] {
  const re = /(\/[^\s"'<>,]+?\.(?:pdf|md|docx|doc|txt|png|jpe?g|csv|xlsx))/gi;
  const out: NlFileRef[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const context = t.slice(lastIndex, m.index);
    out.push({ role: roleFor(context), path: m[1]! });
    lastIndex = re.lastIndex;
  }
  return out;
}

/** 결정적 키워드 파서 — 순수(네트워크·디스크·상태 0). */
export class StubNlParser implements NlParser {
  async parse(text: string, _ctx?: NlParseContext): Promise<NlIntent> {
    const t = text ?? "";
    const domain = extractDomain(t);
    const format = extractFormat(t);
    const product = extractProduct(t);
    const files = extractFiles(t);
    const execute = extractExecute(t);

    // 우선순위: 파일 참조 있으면 intake(도메인/포맷/제품명을 함께 실어 보냄) → 설정 필드 있으면 setup →
    //   실행 의도면 execute → 그 외 unknown. (설정/인입이 실행보다 앞 — 신규 시작 문장에 '진행' 같은 말이 섞여도 시작으로.)
    let kind: NlKind;
    if (files.length > 0) kind = "intake";
    else if (domain || format || product) kind = "setup";
    else if (execute) kind = "execute";
    else kind = "unknown";

    const uncertain = kind === "setup" || kind === "intake" ? fieldsUncertain({ domain, format, product }) : [];
    const confidence = kind === "unknown" ? 0 : 0.6;

    const intent: NlIntent = { kind, files, uncertain, confidence };
    if (domain) intent.domain = domain;
    if (format) intent.format = format;
    if (product) intent.product = product;
    if (execute) intent.execute = execute;
    return intent;
  }
}
