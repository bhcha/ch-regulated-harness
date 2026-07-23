# 배포 가이드 — private 서버

> 신뢰된 내부(private) 서버 배포 기준. 인터넷 공개 배포가 아니므로 공개용 정리(히스토리 재작성·번들/저작권 제거·개인경로 스크럽)는 불필요하다.
> 핵심: **서버에 시크릿을 런타임으로 주고, 의존성을 깔고, 심의 경로를 하나로 정한다.** 코드 수정은 없다.

## 한 줄 요약
`.env`에 키 넣고 → `python3`/`bash`(+키비주얼이면 Playwright) 깔고 → Google·ADK egress 열고 → 심의 경로 하나 확정. 끝.

## 1. 반드시 (안 하면 동작 안 함 / fail-closed 중단)

### 1-1. 시크릿 주입 — repo-root `.env`
`.env`는 `.gitignore`로 추적 제외라 클론본에 없다. 서버에서 새로 만든다(`cp .env.example .env` 후 값 채움). 코드는 키를 `os.environ`으로만 읽는다.

| 변수 | 용도 | 비고 |
|---|---|---|
| `NANOBANANA_API_KEY` | 이미지 실생성(Gemini/Vertex) | `image_engine.py` |
| `HARNESS_IMAGE_CLI=nanobanana` | 실생성 활성(기본값) | 온라인+키 없으면 fail-closed; stub 은 오프라인(`HARNESS_OFFLINE=1`) 전용 (`common.sh:resolve_image_engine`) |
| `ADK_COSMETICS_CRITIC_URL` | 화장품 원격 심의 엔드포인트(https, 공인 host) | 화장품 `domain.json` 의 `adk_critic.url_env` 가 가리킴 → 있으면 심의가 `adk-http`로 자동 채택+필수화 (`kcia-check.sh`) |
| `ADK_COSMETICS_CRITIC_ALLOWED_HOST` | 위 URL host와 정확히 일치 | 화장품 `adk_critic.host_env` → **구현된 도메인인데 미설정이면 fail-closed 중단** (`adk_critic.py:_resolve_endpoint`) |

> **심의 엔드포인트는 도메인별이다.** 단일 `ADK_CRITIC_URL`/`ADK_CRITIC_ALLOWED_HOST`/`ADK_CRITIC_APP` 은 폐기됐다. 각 도메인의 `packs/<도메인>/domain.json` 의 **`adk_critic` 블록**(`url_env`/`host_env`/`app`/`author`)이 가리키는 env 를 채운다. 현재 화장품만 블록이 있어 위 두 env 가 필요하고, 의약품 등은 블록 미제공이라 룰엔진-단독으로 가시화된다(아래 1-2). 새 도메인 ADK = `domain.json` 에 `adk_critic` 블록 추가 + `.env` 에 그 `url_env`/`host_env`(예 `ADK_<도메인>_CRITIC_URL`/`_ALLOWED_HOST`) 추가만(core 코드 무수정).

로드 규약: `common.sh`가 repo-root `.env`를 자동 로드(set-if-unset — 이미 설정된 환경변수가 우선). `HARNESS_NO_DOTENV=1`은 테스트 전용.

### 1-2. 심의 경로 = 도메인별 원격 ADK 단일
- **운영 심의 = 원격 ADK(`adk-http`) 단일이다.** 로컬 헤드리스 CLI 심의(`claude-subagent`/`codex`/`KCIA_CRITIC_CMD`)는 폐기됐다 — `KCIA_CRITIC_ENGINE` 은 비우거나 `adk-http` 만 쓴다.
- **`adk_critic` 블록이 있는 도메인**(현재 화장품): `.env` 에 그 블록이 가리키는 URL/host env(화장품 = `ADK_COSMETICS_CRITIC_URL` + `ADK_COSMETICS_CRITIC_ALLOWED_HOST`)를 채운다 → 자동으로 `adk-http` + `KCIA_CRITIC_REQUIRED=1`(조용한 강등 금지). 블록은 있는데 URL env 가 비면 **설정오류 fail-closed**(중단).
- **`adk_critic` 블록이 없는 도메인**(현재 의약품 등 미제공): ADK 를 생략하고 **룰엔진-단독**으로 진행하되 "사람 확인 권장"을 화면·`verdict.json`(`review_depth=rule_engine_only`)에 가시화한다. 추후 엔드포인트를 받으면 `domain.json` 블록 + `.env` env 만 추가하면 자동 활성.
- ⚠ ADK 엔드포인트는 **공인(글로벌 라우팅 가능) host**여야 한다. 사내 사설 IP(10.x·172.16-31.x·192.168.x·CGNAT·loopback)는 SSRF 가드(`adk_critic.py:_resolve_endpoint`)가 거부한다(테스트만 `ADK_CRITIC_ALLOW_LOCAL=1`). 사내 사설망 ADK를 쓰려면 그 가드를 완화해야 한다(운영 결정 필요).

### 1-3. 런타임 의존성
- `python3` (순수 stdlib — **pip 불필요**) + `bash`.
- 키비주얼 렌더를 쓰면 **Playwright + Chromium**(폴백 없음, 없으면 hard-fail — `render.py:107`).
- `core/`·`packs/` 형제 배치를 보존(아니면 `PACKS_DIR` 명시 — `kcia_engine.py:246`).

### 1-4. 네트워크 egress 허용
- `aiplatform.googleapis.com:443` — 이미지 생성(API 키는 URL 쿼리로만, gcloud/OIDC 불필요).
- ADK Cloud Run host:443 — 원격 심의.

## 2. 권장 (운영 품질)
- `.env`는 `chmod 600`. `.env`에 시크릿/엔드포인트만 — 동작 토글(`HARNESS_CLI` 등)은 `export`로(`common.sh:22-26` 정책).
- `adk_critic` 구현+설정된 도메인(현재 화장품)은 `kcia-check.sh` 가 `KCIA_CRITIC_REQUIRED=1` 을 자동 설정해 원격 심의 실패/타임아웃 시 fail-closed 한다(조용한 강등 금지). 무인 운영이면 그대로 두면 된다.
- 배포 전 스모크: `HARNESS_CLI=stub HARNESS_OFFLINE=1`로 한 파이프라인 완주시켜 경로 확인.
- 이미지/심의 호출 상한: `HARNESS_IMAGE_TIMEOUT`·`KCIA_CRITIC_TIMEOUT` 환경에 맞게.

### 2-1. 이미지 생성 쿼터 운영 정책 (O-4 — Nano Banana Pro)
키비주얼은 전 사진 블록을 굽는다(bake-all, 10~14장). **코드 기본 모델은 이미 flash**(`gemini-2.5-flash-image` — `image_engine.py` `_NB_MODEL`/fallback 동일)라 Pro 는 `.env` 의 `HARNESS_NANOBANANA_MODEL=gemini-3-pro-image` **opt-in** 이다. Pro 는 핸드오프 품질이 높지만 쿼터가 빡빡하다:
- **동시 2런 금지 · 순차 실행**: run_id 는 격리돼도 **쿼터는 계정 공유**라 동시 2런이면 429 압박이 2배가 된다. Pro(bake-all) 실런은 한 번에 하나씩 돌린다(D-2 확정: Pro 유지 + 순차 규율).
- **부분실패 내성은 이미 있다(P-1)**: 429 수신 시 지수 백오프 후 자동 강등으로 완주한다. 다이얼:
  - 백오프: `HARNESS_NANOBANANA_RETRY_429`(기본 3) · `HARNESS_NANOBANANA_BACKOFF`(기본 `15,30,60`초).
  - 강등: `HARNESS_NANOBANANA_FALLBACK_MODEL`(기본 `gemini-2.5-flash-image` · 빈 값=강등 끄기). 429/400 이면 그 블록부터 이후 전 블록을 fallback 모델로 자동 전환.
  - 진행 가시화(O-3): bake 중 `.logs/keyvisual-bg-*.log` 에 자산별 `[image] N/total …` + 강등 감사 1줄, `image-manifest.json` 의 `incomplete` 부재로 완료 판정.
- **쿼터 상향**은 사람 트랙(GCP 콘솔 할당량 요청) — 하네스 밖.

## 3. 테스트 입력 번들
크롤 번들(`naver_*/`)은 git 추적 제외(테스트 데이터 — 고객 리뷰·사진 URL·3rd-party 이미지). 클론본엔 없다.
- 일반 단계 테스트(`stage-*.sh`)는 추적된 골든 픽스처(`fixtures/`)로 동작 — 번들 불필요.
- 골든 재캡처/풀파이프라인 테스트(`capture-baseline`·`verify-baseline`·`test-b0`·`test-b9`)는 raw 번들을 ingest하므로 본인 번들을 `TEST_BUNDLE=/abs/path`로 지정해야 한다.

## 4. private라서 안 해도 되는 것
- **히스토리 재작성** — 애초에 시크릿 0건(추적·히스토리 전수 확인).
- **번들/브랜드 이미지 제거** — 내부 비노출 + 디자인엔 미사용(레퍼런스 전용). 통삭하면 ingest가 깨진다.
- **개인경로(`/Users/...`) 스크럽** — 문서에만 있고 런타임 무관.
- **키 마스킹·SSRF 완화** — 이미 구현됨.
