/**
 * run-domain.ts — 런의 선언 규제도메인을 state.json 에서 **읽기만** 하는 게이트웨이의 유일한 직접 state 읽기.
 *
 * 무인 세션 조립(`cli-session.buildAddDirs`)은 `packs/<도메인>` 을 열려면 그 런에 **사람이 선언한 규제도메인**을
 *   알아야 한다. 그 값의 단일 출처는 core 의 `runs/<rid>/state.json`(사람이 `new-run.sh` 로 선언 → normalize_domain
 *   이 레지스트리로 강제 · state 의 유일한 쓰기 주체). next-action 계약에는 그 필드가 노출되지 않으므로, 도메인만은
 *   state.json 을 **직접** 읽는다.
 *
 * ⚠ **AGENTS 1번 규칙과 충돌하지 않는다** — 규칙은 "state.json 은 오직 `scripts/*.sh` 만 **쓴다**"이고, 여기서 하는
 *   일은 **읽기뿐**이다(파일을 열어 한 필드만 뽑고 닫는다 · 쓰기·잠금·이동 없음). 그럼에도 이건 게이트웨이가
 *   state.json 을 직접 만지는 **처음이자 유일한** 자리라, 다음 두 규율을 못 박는다:
 *     ① **정확히 한 필드만 소비한다**(`product.regulatory_domain`). 여기서 state 의 다른 필드(phase·gate·status…)를
 *        읽기 시작하면 next-action(그 모든 것의 단일 채널)과 갈라진 두 번째 진실이 생긴다 — 도메인 하나만 예외다.
 *     ② **읽기 실패·부재·불안전값은 전부 throw**(fail-closed). 이 값은 곧 `packs/<도메인>` **경로**와 add-dir 권한
 *        규칙 문자열에 박히므로, 검증 안 된 값이 새면 세션이 엉뚱한 팩을 열거나(경로 주입) 규칙이 조용히 깨진다.
 *        조용히 cosmetic 으로 폴백하지 않는 것은 core 자신의 자세이기도 하다(AGENTS 8번 절: "미선언·미등록 도메인은
 *        cosmetic 으로 조용히 폴백하지 않고 fail-closed"). 스폰 **전에** 실패해야 잘못된 팩으로 세션이 뜨지 않는다.
 *
 * 순수하진 않지만(파일을 읽는다) **읽기 전용**이라 상태를 변이하지 않는다 — contract-client(next-action 읽기)와 동급이다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeRunId } from "../config.js";

/**
 * 규제도메인 형식 — `core/harness/state.schema.json` 의 `regulatory_domain` 패턴과 **같은 규칙**의 의도적 미러다
 *   (`cli-session.ts` 의 `DOMAIN_PATTERN` 과도 같다 — worker 는 형제 모듈을 서로 import 하지 않으므로 규칙 리터럴을
 *   공유하는 대신 복제하고, 어긋나면 회귀 테스트가 깨운다). 여기서 검사하는 건 '형식'이지 '등록 여부'가 아니다
 *   (등록 강제는 core 의 new-run 이 팩 레지스트리로 한다). 검사하는 이유는 하나 — 검증 안 된 문자열이 팩 경로와
 *   권한 규칙에 그대로 박히는 것을 스폰 전에 끊기 위해서다.
 */
export const DECLARED_DOMAIN_PATTERN = /^[a-z][a-z0-9_]*$/;

/** state.json 의 상대 위치(런 디렉터리 기준) 및 도메인이 사는 자리. 경로·필드 이름을 한 곳에 못 박는다. */
const STATE_FILENAME = "state.json";

/**
 * `<coreRoot>/runs/<rid>/state.json` 에서 사람이 선언한 규제도메인 한 필드만 읽어 돌려준다(읽기 전용).
 *
 * @param coreRoot core(하네스) 체크아웃 절대경로(config.harnessRoot()).
 * @param rid      런 id. 경로 세그먼트가 되므로 안전 토큰만 허용(그 외 = throw).
 * @returns `product.regulatory_domain`(형식 검증 통과분).
 * @throws rid 불안전 · 파일 없음/읽기 실패 · JSON 손상 · 도메인 부재/비문자열/형식 위반 — 전부 fail-closed(스폰 전에 멈춘다).
 */
export async function readDeclaredDomain(coreRoot: string, rid: string): Promise<string> {
  if (!isSafeRunId(rid)) {
    throw new Error(
      `run-domain: run_id 가 안전한 토큰이 아닙니다: '${rid}' — 이 값은 state.json 경로 세그먼트가 되므로, ` +
        "검증 전에 파일을 열지 않습니다(경로 탈출 차단).",
    );
  }
  const statePath = join(coreRoot, "runs", rid, STATE_FILENAME);

  // 읽기 실패(부재·권한·IO)는 삼키지 않고 그대로 올린다 — '도메인을 못 읽었다'를 조용한 기본값으로 덮으면
  //   세션이 엉뚱한 팩(또는 아무 팩도)으로 뜬다. 스폰 전에 시끄럽게 실패하는 편이 안전하다.
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`run-domain: state.json 을 읽을 수 없습니다(rid=${rid}, 경로=${statePath}): ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`run-domain: state.json JSON 파싱 실패(rid=${rid}): ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`run-domain: state.json 이 객체가 아닙니다(rid=${rid}).`);
  }

  // 도메인은 `product.regulatory_domain` 에 있다(state.schema.json 실측). product 부재·비객체도 fail-closed.
  const product = (parsed as Record<string, unknown>).product;
  if (product === null || typeof product !== "object" || Array.isArray(product)) {
    throw new Error(`run-domain: state.json 에 product 객체가 없습니다(rid=${rid}) — 규제도메인을 읽을 수 없습니다.`);
  }
  const domain = (product as Record<string, unknown>).regulatory_domain;

  // 부재·비문자열·형식 위반은 전부 throw — 조용한 cosmetic 폴백 금지(AGENTS 8번 절 · 위 모듈 주석 ②).
  if (typeof domain !== "string" || !DECLARED_DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `run-domain: 규제도메인이 선언되지 않았거나 형식이 올바르지 않습니다(rid=${rid}, 값=${JSON.stringify(domain)}). ` +
        "무인 세션은 사람이 선언한 도메인으로만 팩을 엽니다 — 미선언은 조용히 cosmetic 으로 폴백하지 않고 멈춥니다.",
    );
  }
  return domain;
}
