# 설정 레퍼런스 — 운영 환경변수 조회표(정본)

> **이 문서의 지위:** "어떤 환경변수가 있고 기본값·역할이 무엇인가"의 사람용 조회 정본(현업 4동작 바깥의 운영자 설정).
> **관계:** 동작 규칙·의미(fail-closed·게이트)의 SSoT = [`../AGENTS.md`](../../core/AGENTS.md) 2번 절. 이 문서는 그 규칙에서 변수 사실만 평평하게 뽑은 조회표다. 워크플로우 정본 = [`workflow-ssot.md`](workflow-ssot.md).
> **본문 원칙:** 현재 존재하는 변수만 담는다(변경 이력 서술 금지). 이력은 git.
> 작성 2026-07-10 · 최신 갱신 2026-07-10
> **유지보수(keep-in-sync):** 이 문서는 AGENTS.md 4번 절 D-1 동반갱신 대상이다 — 환경변수를 추가하거나 기본값을 바꾸면 같은 변경에서 AGENTS.md 2번 절(규칙)과 이 표(사실) 둘 다 갱신한다.

---

> ⚠️ **stub 게이트 = `HARNESS_OFFLINE=1`(유일)** — stub(생성·이미지·근거)은 CI/골든 결정성 전용이며, 온라인에선 fail-closed 로 새지 않는다(실엔진 강제). stub 은 오직 이 하나의 조건으로만 켜진다.

이 문서는 운영자가 설정하는 환경변수를 논리 그룹별로 정리한 조회표다. 각 변수의 **왜**(fail-closed 의 의미·게이트 동작)는 [`../AGENTS.md`](../../core/AGENTS.md) 2번 절이 SSoT 이고, 규칙과 어긋나면 AGENTS.md 가 우선한다.

## 생성 엔진

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_OFFLINE` | (미설정 = 온라인) | **stub 게이트(유일 진입조건)**. `1` 이면 생성·이미지·근거가 결정적 stub(CI/골든 전용). 미설정 = 온라인 = 실엔진 강제. 생성·이미지·근거 엔진의 stub 강등은 전부 이 변수 하나로만 결정된다 |
| `HARNESS_CLI` | 오프라인=`stub` / 온라인=`claude` | 생성 엔진(`claude`\|`stub`) — **Claude 단일**(그 외 값은 중단). **기본값은 환경 의존**(오프라인=stub · 온라인=claude, `run-stage.sh`). **온라인에서 `stub` 명시 = 거부**(중단, CI 전용) |
| `HARNESS_GEN_MODE` | (미지정 = 자동: 실엔진+세션 감지면 `insession`, 아니면 `subprocess`) | 생성 표면(`subprocess`\|`insession`). **세션 밖 실엔진 헤드리스 생성(`subprocess`+실엔진)은 폐기 → fail-closed**. 도달 가능 = insession(실엔진, 세션 내 직접 생성) 또는 subprocess+STUB_MODE(CI stub). STUB_MODE 는 명시 `insession` 이라도 항상 subprocess+stub 로 강제(골든 결정성 불변) |

## 이미지(NanoBanana)

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_IMAGE_CLI` | `nanobanana` | 이미지 엔진(`nanobanana`\|`stub`, 텍스트 엔진과 직교). `common.sh:resolve_image_engine` = **오프라인(`HARNESS_OFFLINE=1`)만 stub SVG**(골든 바이트 불변), 온라인+키없음/명시 stub = fail-closed(무음 stub 강등 금지) |
| `NANOBANANA_API_KEY` | (없음) | **온라인 이미지 실생성 필수 키**. 존재 시 Gemini 2.5 Flash Image (Nano Banana) REST 실호출. **온라인인데 키 없음 = fail-closed**(무음 stub 강등 금지). 키는 URL 쿼리에만 — 로그·예외·매니페스트 비노출 |
| `HARNESS_NANOBANANA_MODEL` | `gemini-2.5-flash-image` | 이미지 모델명. 실생성 시 `image-manifest.json` 최상위 `model` 기록. **그래픽 블록(`render_mode==html_only`) 생성 판정 = 실엔진 여부(`bool(model)`)이지 모델 티어가 아니다** — 온라인 실엔진이면 티어 무관(Flash 포함) 그래픽 블록을 이미지로 생성하되, **규제도메인(`domain.json` `no_graphic_generation=true` — drug/quasi_drug/health_food)은 온라인에서도 제외**(HTML/SVG 로만), 화장품·미선언은 생성, stub(오프라인)은 제외(골든 불변). `chart_data`(clinicalEvidence/beforeAfter) 는 모델·엔진 무관 항상 제외(차트는 HTML/SVG 인라인 렌더). ※ 옛 `gemini-3-pro*` Pro 티어 게이팅은 폐기(`_block_emits_image` 는 `_is_pro_model` 을 더는 쓰지 않음) |
| `HARNESS_NANOBANANA_FALLBACK_MODEL` | `gemini-2.5-flash-image` | **429(쿼터) 자동 강등 모델**(P-1). 429 백오프 소진 시 이 모델로 해당 블록부터 강등 재시도. 강등 시 stderr 감사 한 줄. **빈 값 = 강등 끄기**. bake-all(10~14장)로 Pro 기본은 429 빈발 → 강등 다이얼 기본 flash |
| `HARNESS_NANOBANANA_BACKOFF` / `HARNESS_NANOBANANA_RETRY_429` | `15,30,60` / `3` | 429 지수 백오프 대기(초, 콤마목록) / 최대 재시도(P-1). 소진 시 강등 → 그래도 실패면 fail-closed. **증분 매니페스트**: 자산 성공 직후 `incomplete:true` 원자 기록, 전 블록 완료 시 `incomplete` 제거 최종본. 완료 판정(preflight 면제·멱등)=매니페스트 존재 && `incomplete` 부재. stub 은 최종본만 → 골든 불변 |
| `HARNESS_NANOBANANA_RETRY` | 4 | 금지콘텐츠/일시차단(IMAGE_RECITATION·빈 응답·안전차단) 재시도 횟수(비정상 값은 안전 폴백). **429 쿼터 백오프(`HARNESS_NANOBANANA_RETRY_429`)와 직교한 별개 다이얼** — 이쪽은 확률적 차단 재시도, 저쪽은 쿼터 소진 백오프 |
| `HARNESS_IMAGE_TIMEOUT` | 120초 | 이미지 실생성 1회 HTTP 하드 타임아웃(초). 비정상 값은 안전 폴백 |
| `HARNESS_ACK_GAPS`(또는 `--proceed-with-gaps`) | (미설정) | 이미지 생성 직전 '최종 점검'이 **임계 결손**(임상 측정치 등록됐는데 시험성적서 요소 결손=`must_fill`)으로 멈출 때 그래도 진행하는 비대화형 override(진행 시 감사 한 줄). **stub/오프라인 또는 `04-keyvisual/image-manifest.json` 존재 시 점검 면제.** 점검기=읽기전용 `image_preflight.py`, 멈춤은 `run-stage.sh`. 심의(원격 ADK)와 무관 |

## 근거검색(OpenAlex)

> ⚠️ **OpenAlex 는 무료라 키가 필요 없다** — NanoBanana 의 "키 없으면 fail-closed" 게이트는 여기 없다. 엔진 선택은 오프라인/온라인만으로 결정된다(직접 HTTP, MCP 아님). 온라인 검색 실패=근거 없음(주장 불가)으로 처리하되, 엔진 자체 실패는 fail-closed(무음 stub 강등 금지).

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_EVIDENCE_CLI` | `openalex` | 근거검색 엔진(`openalex`\|`stub`, 텍스트·이미지 엔진과 직교). `common.sh:resolve_evidence_engine` = **오프라인(`HARNESS_OFFLINE=1`)만 stub**(결정적 → 골든 바이트 불변), 온라인은 실엔진(`openalex`) 강제. **온라인인데 명시 `stub` = fail-closed** |
| `OPENALEX_MAILTO` | (미설정) | 선택 — polite pool 이메일. URL 쿼리에만 실려 로그·예외 비노출 |
| `HARNESS_OPENALEX_TIMEOUT` | 30초 | OpenAlex 1회 HTTP 타임아웃(초) |
| `HARNESS_OPENALEX_RETRY` | (기본 재시도) | 429/5xx 백오프 재시도 횟수 |
| `HARNESS_OPENALEX_BACKOFF` | `2,5,10` | 429/5xx 지수 백오프 대기열(초, 콤마목록; 비정상·음수 토큰은 버림) |
| `HARNESS_OPENALEX_MIN_RELEVANCE` | (미설정=문턱 미적용) | **opt-in 관련도 문턱**(float). 설정 시 `relevance_score ≥ 문턱` 결과가 1건 이상이면 `evidence_sufficient=true`(미설정이면 기본 false — 미검증 발견 후보라 자동 인용 안 함) |

## 심의(ADK)

> 심의 엔진 = **원격 ADK(`adk-http`) 단일 · 도메인별 엔드포인트**. 로컬 헤드리스 크리틱(`claude-subagent`/`KCIA_CRITIC_CMD`·self-grading 가드)은 폐기. 엔드포인트는 `packs/<도메인>/domain.json` 의 `adk_critic` 블록이 가리키는 env 로 잡는다.

| 변수 | 기본값 | 역할 |
|---|---|---|
| `KCIA_CRITIC_ENGINE` | (미설정) | 심의 엔진 선언 — **비우거나 `adk-http` 만** 허용(그 외 값은 중단). 로컬 `claude-subagent` 등은 폐기 |
| `ADK_<도메인>_CRITIC_URL` / `ADK_<도메인>_CRITIC_ALLOWED_HOST` | (없음) | 도메인별 원격 ADK 심의 엔드포인트(https·공인 host). 화장품=`ADK_COSMETICS_CRITIC_URL`/`ADK_COSMETICS_CRITIC_ALLOWED_HOST`(app `cosmetics_agent` · author `cosmetics_review_agent`). `domain.json` 의 `adk_critic` 블록(`url_env`/`host_env`)이 가리키는 env. **단일 `ADK_CRITIC_URL`/`ADK_CRITIC_ALLOWED_HOST`/`ADK_CRITIC_APP` 은 폐기** |
| `ADK_CRITIC_AUTH` | `none` | (선택, `adk_critic.py` 가 읽음) `none`\|`oidc`. `oidc` 면 `ADK_CRITIC_ID_TOKEN` 함께 |
| `ADK_CRITIC_ID_TOKEN` | (없음) | (선택) `ADK_CRITIC_AUTH=oidc` 일 때 사용할 ID 토큰 |
| `ADK_CRITIC_HTTP_TIMEOUT` | 300초 | (선택) 원격 ADK HTTP 타임아웃(초) |
| `ADK_CRITIC_RETRY` | (기본 재시도) | (선택) 빈응답 재시도 횟수 |
| `ADK_CRITIC_RETRY_BACKOFF` | `2,5,10` | (선택) 재시도 간 지수 백오프 대기(초, 콤마목록; 소진 시 마지막 값 유지). 콜드스타트 빈응답을 즉시 두드리지 않음(Seam E C-1). 온라인 전용 |
| `ADK_CRITIC_ALLOW_LOCAL` | (미설정) | (선택, **테스트 전용**) `1` 이면 http/localhost·SSRF 가드 면제 |
| `ADK_CRITIC_SID_SEED` | (미설정) | (선택, `adk_critic.py` 가 읽음) 세션 id 시드 — 설정 시 원격 ADK 세션 id 를 `kcia-<시드>-<시도>` 로 고정(미설정=id 미지정) |
| `KCIA_CRITIC_FANOUT_CAP` | 8 | 원격 ADK Pass-B(건별 적대검증) 항목별 fan-out 상한(`kcia-check.sh`) |

## 권한 플래그

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_CLAUDE_FLAGS` | `--permission-mode acceptEdits` | 세션 내(insession) 실 Claude **생성**이 산출물 파일을 쓰도록 하는 권한 플래그(생성 전용; 심의는 원격 ADK 라 무관) |

## 근거 첨부

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_EVIDENCE_DIR` | (미설정 → `<번들>/evidence/`) | 근거 문서 첨부 소스 폴더(1순위). 미설정 시 크롤 번들 안 `<번들>/evidence/` 폴백, 둘 다 없으면 전면 no-op(골든 불변) |
| `HARNESS_EVIDENCE_MAX_FILE_BYTES` / `HARNESS_EVIDENCE_MAX_TOTAL_BYTES` | 20MB / 50MB | 근거 첨부 파일당/총량 상한(초과 fail-closed) |
| `HARNESS_EVIDENCE_DPI` | 150 | 근거 문서(시험성적서 등) PDF→이미지 렌더 DPI(전후사진 페이지 추출; `ingest.py`) |
| `HARNESS_EVIDENCE_IMAGE_TIMEOUT` | 120초 | 근거 문서 PDF→이미지 렌더 1회 하드 타임아웃(초; `ingest.py`) |

## 생성 watchdog

> 헤드리스 생성 CLI 가 산출물을 다 쓰고도 종료 안 해 마무리 전이가 멈추는 행/좀비를 방지한다.

| 변수 | 기본값 | 역할 |
|---|---|---|
| `HARNESS_GEN_TIMEOUT` | 600초 | 생성 1회 하드 상한(산출물 없는 진짜 행 백스톱; 초과 시 자식 그룹 종료 후 중단, 재실행=idempotent 재개) |
| `HARNESS_GEN_POLL` | 5초 | 상태 점검 간격(출력 완료 / 자식 종료 / 상한 초과를 주기 확인) |
| `HARNESS_GEN_HEARTBEAT` | 30초(0=끄기) | 진행 하트비트 출력 간격(체감 정체 완화). 산출물이 완성되면 좀비 자식을 더 기다리지 않고 곧장 검증·전이로 진행 |

## 심의(원격 ADK) watchdog·관측성

> 원격 ADK 호출이 응답 없이 늘어지면 무한 행이 되므로 상한이 필요하다.

| 변수 | 기본값 | 역할 |
|---|---|---|
| `KCIA_CRITIC_TIMEOUT` | 600초 | 원격 ADK 심의 1회(Pass-A 또는 Pass-B 1건) 하드 상한. 초과 시 프로세스그룹 종료 + `outcome=timeout` |
| `KCIA_CRITIC_REQUIRED` | (미설정=0; 단 `adk_critic` 구현+설정된 도메인은 `kcia-check.sh` 가 자동 `1`) | `1` 이면 원격 ADK 심의 실패/타임아웃 시 **조용한 강등 대신 fail-closed**(중단). 미구현 도메인은 애초에 ADK 를 안 돌리고 룰엔진-단독으로 가시화 |
| `HARNESS_MODEL` | (미설정) | 관측 로그(`.logs/timing.jsonl`) 라벨 전용 — 소요·결과 측정 로그에 기록만 하며 **동작에는 영향 없다**(`obs.sh`) |
