# 통합 실행 계획 — 1부 운영 신뢰성 개선(O-1~O-9) · 2부 팩 분리 1차 · 3부 온보딩 2차

> **이 문서의 지위:** E2E 운영 결함 개선(O-1~O-9)과 팩 분리 리팩토링(1차·2차)을 하나로 묶은 **실행 계획 정본(SSoT)** 이다.
> 선행 두 문서를 통합·승계한다 — [`_archive/e2e-operational-findings.md`](../_archive/e2e-operational-findings.md)(E2E 실측 관찰 기록 원본) · [`_archive/pack-refactor-plan.md`](../_archive/pack-refactor-plan.md)(팩 분리 원계획 — 0단계 완료 시점까지의 이력 보존). 실행 중 각 항목/단계가 끝나면 이 문서의 해당 자리에 완료 표시와 실측 메모를 남긴다.
> **관계:** 규칙 SSoT = [`../AGENTS.md`](../../core/AGENTS.md). 워크플로우 정본 = [`workflow-ssot.md`](../canonical/workflow-ssot.md)(파이프라인·팩·환경변수가 바뀌는 단계마다 **같은 변경에서** 동반 갱신). 다중 도메인 1차 일반화 이력 = [`multi-domain-build-plan.md`](multi-domain-build-plan.md).
> **근거:** 1부의 파일:줄 인용 = 2026-07-07 실측 재확인. 2부의 파일:줄 인용 = 2026-07-02 레포 실물 조사(원계획 승계 — 이후 커밋으로 줄번호가 흘렀을 수 있으니 **각 단계 착수 시 심볼(함수·상수명) 기준으로 재확인**한다).
> 작성 2026-07-07 · 상태: **계획 수립 완료 — 부록D 열린 결정 4건 사람 확정 대기 · 1부부터 착수**

---

## 0. 실행 순서와 선결 확인

### 실행 순서 (사람 확정 2026-07-07)

1. **1부 — 운영 신뢰성 개선**: E2E 실런 2건(릴리프 화장품 intake · 우루사 의약품, 둘 다 done 완주)에서 드러난 재발성 운영 문제 O-1~O-9 의 처방. **팩 분리보다 먼저** 끝낸다.
2. **2부 — 팩 분리 1차(1~9단계)**: 0단계(증명 도구)는 완료·main 병합됨. **한 단계 = 분리 → 테스트 → 검증 → 병합의 독립 완결 단위**(사람 지시 2026-07-07) — 이전 단계가 병합·그린이기 전에 다음 단계에 착수하지 않는다.
3. **3부 — 온보딩 2차**: 1차 완료 후. 준비 완화 묶음(이월분) → 온보딩 본체.

### 선결 확인 (1부 착수 전)

- [x] `fix/keyvisual-image-safety` 브랜치(커밋 `7c7f49a` — F1·F2·F3) **main 병합**(ff, 2026-07-07). 근거: E2E 양 런에서 정상 작동 실측(1부 끝 "정상 확인" 절).
- [x] 잡파일 정리: 미추적 `core/.kcia_out.log` 삭제(계획 승계 docs 커밋에 동반).
- [x] 0단계 완료 상태 재확인: **⚠ 발견 — verify-baseline 이 main 에서 이미 RED**. 골든 매니페스트가 `2d26e02`(번들 스왑 전)에서 멈춰 있었고, c822d2a 가 커밋 메시지엔 "베이스라인 재캡처"라 적었지만 실제로 `baseline-manifest.json` 을 갱신하지 않았다(git stat 부재 = 0단계 재캡처 누락). **1부 완료 후(2부 선결) 재캡처로 완결**(사람 확정 "지금 재캡처" · 2026-07-07): `capture-baseline.sh` → 골든 190항목(현 bundle-cosmetic: 2자리 이미지 + ezderm webp), `verify-baseline.sh` 그린 확인 → 별도 커밋. 부록C 결정1 참조.

---

## 1부 — 운영 신뢰성 개선 (O-1~O-9)

> 출처: E2E 실런 2건의 관찰 기록(원본 = `_archive/e2e-operational-findings.md`). O-1~O-9 는 **코드 결함이 아니라 운영 UX·설정·구동 표면의 재발성 문제**다. 아래는 그 처방의 실행 계획이며, 우선순위는 관찰 기록의 후속 조치 권고를 따른다(O-1·O-2 → O-3·O-4 → O-5·O-6 → O-7·O-8·O-9).

### 공통 규율 (1부)

1. **항목별 독립 커밋**(수정 + 테스트 동반). 반복 중엔 타겟 테스트만 돌리고, **항목 커밋 시 전체 CI**(`bash tests/run-ci.sh`) — CI 반복 방침.
2. `prompts/*.md` 를 건드리는 항목(1-5·1-6)은 **프롬프트 조립 골든 재캡처를 같은 커밋에서 동반**(`tests/test-prompt-assembly.sh` 의 prompts.sha256 가 깨지므로).
3. 스킬(`skills/*/SKILL.md`) 수정 시 `bash scripts/sync-skills.sh` 재생성 — `.claude/commands` 는 생성물이다(CI test-b0 이 동기화 검증).
4. **부록D 열린 결정 4건(D-1~D-4)은 실행 전 사람 확정.** 권고안 채택 시 그대로 진행한다.
5. 이식성 원칙 유지(AGENTS 1번 절): 스킬은 편의 래퍼일 뿐 — 스킬에 넣는 백그라운드+폴링 패턴은 **셸 1급 경로 명령을 그대로 병기**한다.

### 1-1. O-1 — 장시간 심의·이미지 호출의 백그라운드+폴링 표준화 (HIGH·운영차단)

**문제(실측)**: plan·keyvisual 심의는 원격 ADK 다중 패스(Pass-A + 블록별 Pass-B)라 정상적으로 `KCIA_CRITIC_TIMEOUT`(기본 600초, `scripts/lib/obs.sh:76`)에 근접한다. insession 구동자(세션 에이전트)가 이를 **포그라운드 단일 툴콜**로 돌리면 Claude Code 스트림 watchdog(600초 무진행)이 구동자를 죽인다 — 두 상한이 같은 값이라 경합. 키비주얼 전이(`run-stage.sh keyvisual` 3번 스텝)의 이미지 실생성(Pro 10~14장 + 429 백오프, 수 분~십수 분)도 같은 구조로 **매 실런 재발**.

**처방 채택/비채택**:
- 채택 = **(a) 4동작 스킬에 백그라운드+폴링 기본 내장**(E2E 에서 수동으로 쓴 우회의 표준화).
- 비채택 = (b) 하트비트 stdout 단독 — `obs_watch_pid`(`obs.sh:80-96`)가 이미 30초 간격 "진행 중… Ns 경과"를 찍고 있으나, **블로킹 툴콜의 출력은 완료 시점까지 버퍼에 갇혀 스트림에 도달하지 않는다**(실측: 하트비트가 있는데도 watchdog 사망). 폴링의 보조 신호로만 유효.
- 비채택 = (c) 스트림 watchdog 상한 조정 — Claude Code 측 설정이라 하네스 밖(이식성 원칙 위배).

**작업**:
- [x] `skills/kcia-check/SKILL.md`: 현행 포그라운드 1줄 → 표준 패턴으로 교체. 패턴:
  ```bash
  nohup bash scripts/kcia-check.sh <RUN> </dev/null >"runs/<RUN>/.logs/kcia-bg-$(date +%s).log" 2>&1 &
  ```
  이후 **30~45초 간격 폴링**(툴콜 1회 = 스트림 진행): ① 프로세스 생존(`kill -0`) ② 백그라운드 로그 tail(하트비트·Pass 진행) ③ 완료 마커(`verdict.json` 갱신 → `run.md` "다음 명령"). Claude Code Bash 의 `run_in_background` 사용도 동등 경로로 병기. ⚠ `</dev/null` 필수(수동 백그라운드 stdin 무한 행 처방) + 중단 시 그룹 kill 안내.
- [x] `skills/keyvisual/SKILL.md` 3번 스텝(렌더·검증·전이 = 이미지 bake 포함)과 `skills/gen-images/SKILL.md`: 같은 패턴 적용. 이미지 진행 폴링 소스 = **증분 image-manifest**(자산별 원자 기록, `incomplete` 마커 — P-1 기존 기능)와 `.logs` 캡처.
- [x] `bash scripts/sync-skills.sh` 재생성 + `docs/reference/user-guide.md` 운영 절에 같은 패턴 1문단(스킬 없이 셸로 돌리는 운영자용).

> ✅ 완료(2026-07-07 · ops/o-items). kcia-check·keyvisual(3번 스텝)·gen-images 스킬에 백그라운드+폴링 표준 패턴 내장(`</dev/null`·mkdir .logs·`run_in_background` 병기·`pkill -P` 중단), `.claude/commands` 3종 재동기화, user-guide 6장에 운영자 메모 추가. 스크립트 무변경 = 골든 무영향. 실런 watchdog 사망 0건은 1부 완료 판정 실런 스모크에서 확인.

**검증**: 스킬 동기화(test-b0 포함 전체 CI) + **다음 실런 스모크에서 watchdog 사망 0건**(1부 완료 판정의 실런 확인 항목). 스크립트(`kcia-check.sh`·`run-stage.sh`) 자체는 무변경이라 골든 무영향.

### 1-2. O-2 — `ADK_CRITIC_RETRY` 기본 상향 + 도메인별 오버라이드 (HIGH·설정)

**문제(실측·우루사)**: pharma ADK 엔드포인트가 plan·keyvisual 심의에서 "빈 모델 텍스트(첫 턴 flaky)"를 지속 반환 → 기본 재시도 3회(`scripts/lib/adk_critic.py:170`) 소진 → 구현 도메인은 `KCIA_CRITIC_REQUIRED=1` 자동이라 fail-closed 반복. `ADK_CRITIC_RETRY=8` 로 올리니 안정 통과. 하네스의 fail-closed 동작 자체는 정상(조용한 강등 없음·안내 정확) — **문제는 기본값**.

**작업**:
- [x] `adk_critic.py:170` 기본값 3 → **8**(D-1 확정값). 성공 시 조기 종료 루프라 정상 경로 비용 0.
- [x] **도메인별 오버라이드**: `packs/<도메인>/domain.json` 의 `adk_critic` 블록에 선택 키 `retry` 허용(팩이 자기 엔드포인트의 flakiness 프로파일을 선언 — `adk_critic` env 간접 선언 패턴과 정합). 우선순위 = **명시 env `ADK_CRITIC_RETRY` > 팩 `adk_critic.retry` > 코드 기본 8**.
- [x] `scripts/lib/pack_lint.py` 스키마에 선택 키 `retry` 허용 추가 + `.env.example` 주석(기본 8·의미).
- [ ] 근본 원인(엔드포인트 첫 턴 빈응답 — Gemini/Cloud Run 측) 확인은 별도 트랙으로 기록만(하네스 밖).

**검증**: 타겟 = `tests/test-critic-fanout.sh`(또는 test-observability)에 기본값·우선순위 단정 추가 + `tests/test-pack-lint.sh`. 커밋 시 전체 CI. 온라인 실효는 다음 실런 스모크(pharma 심의가 기본 재시도 안에서 통과).

> ✅ 완료(2026-07-07 · ops/o-items). `_run_agent` 를 `retries` 파라미터화 + `_resolve_retries(cfg)` 헬퍼(env > 팩 `adk_critic.retry` > 기본 8) 신설, Pass-A/B 호출부 2곳 배선. pack_lint 에 `adk_critic.retry` 비음정수 검증(양성 C2 + 음성 3). `.env.example` 주석. 테스트: test-critic-fanout (2g) retry 우선순위 단정 + test-pack-lint 4건 추가 — 둘 다 그린. **선재 실패 3건**(test-critic-fanout (4) drug ADK-미구현 온라인 심의)은 clean main 에서도 동일(stash 대조: clean 38p/3f → 본 변경 39p/3f) = 환경 아티팩트, 본 변경과 무관(drug 는 `_resolve_retries` 미호출). drug 근본원인은 O-2 범위 밖.

### 1-3. O-3 — 진행 중(in-flight) 신호 — 정체 오인 방지 (MEDIUM·관측)

**문제(실측)**: `timing.jsonl`(`obs.sh` obs_timing)과 run.md 는 **단계 완료 시점에만** 기록된다(`run-stage.sh:648` 생성 완료·kcia-check Pass 완료). insession 생성(plan 12블록)·이미지 생성(분 단위)이 도는 동안 무이벤트 → 코디네이터가 "1시간 정체"로 오판(실측).

**작업**:
- [x] `obs_timing` 에 **시작 레코드** 추가(`outcome=start` 필드, duration 없음 — 소비처 `scripts/timing.sh` 하위호환: 시작+완료 페어링). 생성 시작(run-stage)·심의 시작(review/Pass-A/Pass-B, kcia-check)·이미지 bake 시작·완료(run-stage) 기록.
- [x] `scripts/lib/image_engine.py`: **자산별 성공 stderr 1줄**(`[image] N/total NN-type status`, nanobanana 경로 전용) 추가. `.logs` 캡처로 폴링 가시화. 증분 매니페스트(자산별 원자 기록)가 **이미지 진행 폴링의 정본**.
- [x] `scripts/timing.sh`(시작/완료 페어링 → 완료 단계는 종전과 동일·미완료는 "⏳ 진행 중")와 run.md digest(`render_runmd.py` `_inflight_label` — 진행 중 렌더 시 "지금 …만드는 중" 1줄) 표시.

**검증**: `tests/test-observability.sh` 확장(시작 레코드 3종·페어링·in-flight 표시 6단정). 커밋 시 전체 CI.

> ✅ 완료(2026-07-07 · ops/o-items). 시작 레코드(generate·review·review-passA·review-passB·bake) + bake 완료 레코드 + 자산별 stderr(nanobanana). timing.sh 는 (stage,step) 페어링으로 완료 단계 출력을 종전과 100% 동일 유지(하위호환)하고 미완료만 "⏳ 진행 중"으로 표시. render_runmd `_inflight_label`(best-effort, 완료 렌더 시 no-op → run.md 바이트 불변). 검증: test-observability 22/0(신규 6) · test-operator-language 25/0(run.md 누수 없음) · **test-drug-stub-golden 3/0(골든 106항목 바이트 동일)** — `.logs` 골든 제외·stderr 나노바나나 전용이라 스텁 산출물 바이트 무영향 실증.

### 1-4. O-4 — Nano Banana Pro 쿼터 운영 정책 (MEDIUM·자원)

**문제(실측·양 런)**: bake-all(전 사진 블록) × Pro(`gemini-3-pro-image`) 쿼터로 429 다회 → P-1 백오프가 구제해 완주했으나 매번 수 분 지연. 동시 2런은 공유 쿼터라 압박 2배.

**현상 유지 확인**: 코드 기본은 이미 flash(`image_engine.py:27` `_NB_MODEL` 기본 `gemini-2.5-flash-image` · `:756` fallback 동일) — Pro 는 `.env` opt-in. **코드 기본값 변경 없음.**

**작업**(D-2 확정 전제 — 권고: Pro 유지 + 순차 규율):
- [x] 운영 정책 문서화(`docs/reference/deployment.md` 2-1 절): ① 실런 Pro(bake-all)는 **동시 2런 금지·순차 실행**(run_id 격리와 별개로 쿼터는 공유) ② 백오프 다이얼(`HARNESS_NANOBANANA_RETRY_429`·`HARNESS_NANOBANANA_BACKOFF`)과 강등 다이얼(`HARNESS_NANOBANANA_FALLBACK_MODEL`) 튜닝 가이드 ③ 쿼터 상향 요청은 사람 트랙.
- [x] `.env.example` 에 운영 스탠자(Pro opt-in 시 주의 주석 + 백오프·강등 다이얼).

**검증**: 문서·주석 변경뿐 — 전체 CI 통과 확인만. 실효는 실런 관찰.

> ✅ 완료(2026-07-07 · ops/o-items). `docs/reference/deployment.md` 2-1 절 신설(Pro=opt-in·코드 기본 flash·순차 규율·P-1 다이얼·O-3 진행 가시화·쿼터 상향=사람 트랙) + `.env.example` 이미지 스탠자(Pro opt-in 주의 + RETRY_429·BACKOFF·FALLBACK_MODEL 다이얼). 코드 무변경(기본값 불변). 문서에 인용한 env 변수명은 image_engine.py 실물과 대조 확인.

### 1-5. O-5 — 키비주얼 저작 규칙: 번호·라벨 = 실 DOM 텍스트 (MEDIUM·저작)

**문제(실측·우루사)**: 번호 뱃지를 CSS `::before{content:"01".."12"}` 로 넣자 제품명 glue-risk 가드(`kcia_engine.py:742` `_has_gluing_generated_content` → `:1226-1244` 에서 `_name_present` 검증을 차단)가 fail-closed. 실 DOM `<span>` 텍스트로 교체 후 통과. CSS 카운터/`::before` 번호는 흔한 저작 패턴이라 **반복 저촉 확실**.

**작업**(D-3 확정 전제 — 권고: 가드 예외 없음):
- [x] `prompts/keyvisual.md` 에 저작 규칙 1항 추가: "번호·뱃지·라벨 등 **모든 보이는 텍스트는 실 DOM 텍스트로** 작성한다(CSS `content`/`::before`/`::after` 생성 텍스트 금지 — 필수기재 제품명 검증이 CSS 생성 콘텐츠를 신뢰 불가로 처리해 규정 점검이 멈춘다)."
- [x] 가드 예외(필수기재 영역 밖 장식 번호 허용)는 **만들지 않는다** — 우회 악용 여지 검토 비용 대비 저작 규칙으로 충분(D-3).

**검증**: 프롬프트 조립 골든 재캡처(`tests/test-prompt-assembly.sh`) **같은 커밋 동반** + 전체 CI. 실효는 다음 실런(키비주얼 fail-closed 재발 0).

> ✅ 완료(2026-07-07 · ops/o-items · O-6 과 같은 커밋 = 프롬프트 골든 1회 재캡처). keyvisual.md 규칙(공통)에 "모든 보이는 텍스트 = 실 DOM 텍스트, CSS `content`/`::before`/`::after`/카운터 금지" 1항 추가. 가드 예외 미신설(D-3). 프롬프트 조립 골든 재캡처 = `prompts.sha256` 의 keyvisual.md 해시 1줄만 변경(ctx build_context 불변 실측) → test-prompt-assembly 12/0.

### 1-6. O-6 — revise 시 plan↔HTML 동반 갱신 유도 (MEDIUM·게이트 상호작용)

**문제(실측·화장품)**: ADK 통과 목적으로 키비주얼 HTML 카피를 revise 하면, done 전이의 반영강제 게이트(`scripts/advance-phase.sh:143` → `scripts/lib/check_evidence_reflection.py`)가 보는 plan 블록 claim `target_text`·각주 probe(판정문 원문)와 어긋나 막힌다. 두 게이트(심의·반영강제)가 서로 다른 문자열을 본다.

**작업**(D-4 확정 전제 — 권고: 게이트 완화 안 함):
- [x] `check_evidence_reflection.py` **실패 메시지 강화**: 어긋난 쌍을 명시(doc-id · plan 블록 id · claim `target_text`·각주 probe 발췌) + "카피를 고쳤다면 plan 블록의 claim·각주도 같은 표현으로 갱신" 안내(평이 문구). 진단 함수 `_citation_attempts`(게이트 판정 불변 — reflected_map 무수정)로 '인용됨·미반영'(A)과 '미인용'(B)을 구별.
- [x] `prompts/keyvisual.md`(revise 맥락)·`skills/revise/SKILL.md` 에 동반 갱신 규칙 명시: **근거-연결 카피(각주 달린 문장)를 수정할 때는 storyboard plan 의 해당 claim/각주를 함께 갱신**한다(심의 게이트와 반영강제 게이트를 동시 충족).
- [x] 게이트 완화(판정문 부분문자열 → doc-id 존재성)는 **하지 않는다** — 반영 실효성 약화(evidence-content 원칙 훼손, D-4). reflected_map(판정 로직) 무수정 = 동작 불변.

**검증**: `tests/test-evidence-reflection.sh` 확장(실패 메시지에 쌍 정보 단정) + 프롬프트 조립 골든 재캡처(1-5 와 같은 커밋으로 묶어 재캡처 1회) + 전체 CI.

> ✅ 완료(2026-07-07 · ops/o-items · O-5 와 한 커밋). check_evidence_reflection 실패 메시지를 두 갈래(A: plan 인용됨·HTML 미반영=revise 어긋남 → '그 문장' 짚고 기획안 동반 갱신 안내 / B: 미인용 → 반영 블록 추가·reflect:false)로 강화(진단 `_citation_attempts` 추가, 판정 로직 reflected_map 은 무수정 = 게이트 완화 없음). keyvisual.md·skills/revise 에 동반 갱신 규칙. 검증: test-evidence-reflection (neg) 에 쌍 정보 4단정 추가.

### 1-7. O-7 · O-8 · O-9 — 검증 백로그·운영 규율 (LOW)

- [x] **O-7(F2 Pro 400→fallback 라이브 미발동)**: 능동 작업 없음(확인) — 실런에서 Pro 400(INVALID_ARGUMENT) 발생 시 `.logs` 확보·경로 확인은 1부 완료 판정 실런 스모크 체크(4번)에 이미 상비. 단위 검증은 `tests/test-image-engine.sh` 6e 로 존재.
- [x] **O-8(F3 Pillow 규격화(c) 실효 미확인)**: `tests/test-image-engine.sh` (7) 에 **(7g) 목표와 크게 어긋난 세로 픽스처(0.25→16:9)** 추가 — 폭 대폭 패드(w > 3×원폭)·크롭 0(높이 불변)·비율 일치로 **패드 실효 수행(no-op 아님) 단정**. 코드 무변경, 테스트만. 검증: 34/0.
- [x] **O-9(서브에이전트 수명주기 취약)**: 하네스 밖(Claude Code 측) 이슈 — `docs/reference/user-guide.md` 7장에 운영자 메모(에이전트 수명주기): ① 경량 컨텍스트 유지(대용량 원문 재읽기 금지) ② `state.json`·run.md 지점부터 재개(E2E 세션 교체 완주 실증).

### 1부 완료 판정

1. O-1~O-6 반영 커밋 전건 + 전체 CI(`bash tests/run-ci.sh`) 그린.
2. 프롬프트 조립 골든 재캡처 정합(1-5·1-6 커밋에 동반).
3. O-8 테스트 추가 그린 · O-9 문서 반영.
4. **실런 스모크 1회(권장)** — 체크: ① 심의·키비주얼 전이 중 스트림 watchdog 사망 0건(백그라운드+폴링 경로) ② pharma ADK 빈응답이 기본 재시도 안에서 해소 ③ 진행 신호(시작 레코드·자산별 stderr)가 timing/run.md 에 보임 ④ (발동 시) Pro 400 경로 로그 확보.

### 정상 확인 (재발 문제 아님 — E2E 기준선, 재작업 금지 목록)

F1(C) 규제 게이팅(양 도메인 검증) · P-1 부분실패 내성(429 다회에도 완주) · 실 심의 실질성(ADK 실이슈 반복 발견, placeholder 아님) · fail-closed 정직성(조용한 강등 없음) · PNK 근거 경로(00a 분류→00e 스펙→doc-01 승격→임상 TEST 반영·원본 PDF 첨부). — 이 5건은 정상 작동 실측이므로 1부에서 손대지 않는다.

---

## 2부 — 팩 분리 1차 (단계별 분리·검증)

### 목표와 확정 사항 (원계획 승계)

**최종 그림**:
- **커널(core)** = 큰틀만: 페이즈 라우트 + 4박자 게이트 상태기계 + 엔진 골격(검증기·심의 전송·렌더러·인입 파서). 도메인·포맷·블록 이름을 하나도 모르고, 팩이 준 카탈로그를 읽기만 한다.
- **팩(packs)** = 적용되는 기준 전부: 룰셋·어휘·실증 정책, 캐논 블록 카탈로그(**도메인×포맷 조합 단위 통째 교체**), 생성 재료(프롬프트 조각·예시·톤·디자인 토큰), 입력 계약(WB 템플릿·VOC 소스·ingest 프로파일), 외부 연동 선언(env 간접 — `adk_critic` 패턴 일반화), 검증 동반물(테스트·골든·fixtures·stub 템플릿).

**사람 확정(2026-07-02)**: ① 미선언·미등록 도메인 = fail-closed + "등록 팩 목록 + 온보딩 제안"(cosmetic 암묵 기본값 전부 폐지) ② 1차 목표 = **팩 분리 후 현재와 동일 동작(바이트 단위)** — 테스트·골든·fixtures 는 1차 필수(각 팩이 자기 것을 선언) ③ 캐논 = 도메인×포맷 교차 산물(15블록은 화장품×상세페이지의 값일 뿐) ④ 멀티테넌시 = 팩별 API·외부 서비스의 .env/설정 격리(`adk_critic` 패턴).

### 공통 원칙 (전 단계 적용)

1. **각 단계의 6박자**: 어댑터 계약 정의 → 팩에 현행 값 **그대로** 착지 → core 배선 교체 → core 상수/폴백 제거 → 골든·테스트 증명 → 문서 동반 갱신. **값은 옮기기만 하고 절대 바꾸지 않는다**(내용 교정은 "2차 이월 목록"에).
2. **커밋 분리 규율**: "순수 이동(값 불변)" 커밋과 "메커니즘 변경(배선 교체·스키마 완화)" 커밋을 분리 — 회귀 원인 판별 가능해야 한다.
3. **증명 도구 4종**(0단계 산출물 — 전부 가동 중):
   - ① 스텁 바이트 골든: `bash tests/verify-baseline.sh`(cosmetic, 매니페스트 `tests/golden/baseline-manifest.json`) + `bash tests/test-drug-stub-golden.sh`(drug 부분 골든, `baseline-manifest-drug.json`)
   - ② 프롬프트 조립 골든: `bash tests/test-prompt-assembly.sh`(`--emit-context` + prompts.sha256 + ADK Pass-A/B 지시문 조립)
   - ③ 심의 골든셋: `golden_runner.py` 검출률·오탐률(cosmetic + drug, run-ci 포함)
   - ④ 누출 grep: `bash tests/test-core-domain-leak.sh`(allowlist 단계마다 점감 → 9단계에 0)
4. **온라인 카나리**: 원격 ADK 지시문·author 등 온라인 전용 경로(오프라인은 ADK resolve 자체를 건너뜀)는 골든의 사각지대 — 해당 변경이 있는 단계(2단계 등)는 실 ADK 1회 호출 확인을 절차화.
5. **`workflow-ssot.md` 동반 갱신은 단계마다** 같은 변경 단위에서(AGENTS 4번 절 의무).
6. **stub 렌더 환경 고정**: 베이스라인 골든에 Playwright 렌더 PNG 포함 — 1차 진행 중 머신·브라우저 버전 불변(거짓 알람 방지).
7. **단계 완결 규율(신설 — 사람 지시 2026-07-07)**: 한 단계 = 독립 브랜치/병합 단위. 단계 안 순서 = 분리(이동 커밋 → 배선 커밋 → 소거 커밋) → **타겟 테스트**(반복 중) → **골든 증명**(위 4종 중 해당분) → **전체 CI**(`bash tests/run-ci.sh`) → 문서 동반 갱신 → 병합. **이전 단계 병합·그린 전 다음 단계 착수 금지.** 실패는 그 단계 안에서 수습(다음 단계로 이월 금지).

> **단계 순서의 근거**: 사람 예시("ingest 만 먼저 분리하고 테스트하고 검증하고")의 취지 = **한 조각씩 분리·검증** — 이 규율은 전 단계 동일 적용한다. 순서 자체는 의존성이 정한다: 1·2단계(폴백 소거·어휘 퇴거)가 이후 전 단계의 fail-closed 기반, 3단계(인입)는 0단계 drug 골든이 전제(역방향 함정 — drug 산출 바이트가 변할 수 있는 단계), 5단계는 0단계 프롬프트 조립 골든이 유일 안전망(stub 은 build_context 미사용), 7·8단계는 증명 앵커 분리를 위해 서로 떨어뜨린다.

### 목표 팩 레이아웃 (1차 완료 시점)

```
packs/
  <도메인>/                  # 규제도메인 팩 (cosmetic, drug, quasi_drug, health_food)
    domain.json              # 레지스트리 엔트리: 라벨·법·aliases(1단계 신설)·status·adk_critic(env 간접 선언·retry[1부 1-2]·author)
    ruleset.json             # 심의: 축 내용·lexicon(누락 키 2단계 보강)·실증 정책(임상 5요소·정본 디스클레이머)·필수기재
    ingest-profile.json      # 인입: VOC/페르소나 키워드·옵션 정규식·기능성 라벨·승인/실증/인증 마커·bp 힌트 (3단계)
    bundle-profile.json      # 크롤 번들 필드 매핑·자사 호스트 정책 (3단계)
    prompt-fragments/        # 생성 프롬프트 도메인 조각(예시·축 프리셋·금지어 예문) (5단계)
    critic-fragment.md       # 심의 프롬프트 도메인 조각(축 판정 예시) (5단계)
    canon/<포맷>.json        # (선택) 캐논 도메인 변형 — 조합 단위 전체 교체. 1차엔 규약만, 실사용은 2차
    labels.json              # 운영 라벨 오버레이 (6단계)
    stub-templates/          # 결정적 stub 콘텐츠(카피·축 세트) (5단계)
    samples/                 # WB 샘플·자사 자산 시드 (7단계)
    examples/                # 유사사례 (7단계)
    golden/                  # 심의 골든셋·추출 기대표 (8단계)
    fixtures/                # 단계 핸드오프 픽스처 (8단계)
    sources/                 # 규제 원문 (기존 유지)
  _format/                   # 산출물 포맷 팩 (규제도메인과 직교)
    format-profiles.json     # 포맷 레지스트리: id·aliases·채널 규격·active_phases·default (기존)
    <포맷>/
      canon.json             # 블록 카탈로그: id·포맷별 intent·risk_tier·evidence_required + 블록 속성
                             #   (evidence_gated/brand_gated/emits_image/필수 고지문/구도 힌트/root/차트 규칙)
                             #   + 구성요소 커버리지 (4단계 — canon-components*.json 흡수, 정본 1개)
      canon.md               # 사람용 문서 = canon.json 파생 — docs/reference/canon-blocks.md 대체
      design-tokens.json     # 톤 팔레트·accent·타이포 (6단계)
      prompt-fragments/      # 레이아웃·포맷 힌트 조각 (5·6단계)
```

core 에 남는 것: `scripts/`(게이트 상태기계·엔진 골격·로더), `harness/`(동결 계약 스키마 — 패턴+카탈로그 대조로 완화), `prompts/`(단계 골격 — 도메인 조각은 라벨 주입), `assets/fonts/`(공용 로케일 인프라 잔류), 합성 테스트 번들 fixture.

### 0단계 — 증명 도구 복구·보강 ✅ 완료 (2026-07-06 · main 병합)

산출물 요약(상세 이력 = `_archive/pack-refactor-plan.md` 0단계):
- **합성 번들 기본화 + 베이스라인 재캡처**(S1·S8, 커밋 `c822d2a`): 기본 테스트 번들 = 커밋 가능한 `tests/fixtures/bundle-cosmetic`(value-replica — 구 크롤 실번들과 동일 집계값), 구 `naver_*/` 심링크 제거. b0/b1/b2/b3/b1e/b5 green.
- **drug 부분 골든**(S5): `build-fixtures.sh` 파라미터화 + 합성 drug 번들·WB + `fixtures/drug/{concept,conti}-in` + `baseline-manifest-drug.json` + `tests/test-drug-stub-golden.sh`(storyboard-plan iter4/4 escalated 동결).
- **프롬프트 조립 골든**(S6): Pass-A/B 지시문 순수함수 추출 + `emit-instruction` + `tests/test-prompt-assembly.sh`(골든 11항목).
- **누출 grep**(`tests/test-core-domain-leak.sh`): 초기 allowlist 14파일 — 단계마다 점감, 9단계에 0.
- **pack-lint**(S3): `scripts/pack-lint.sh` + `pack_lint.py` + `tests/test-pack-lint.sh`, run-ci 배선.
- 골든셋 `regulatory_domain: "cosmetic"` 명기(S2) · examples 헤르메틱(S4) · `ezderm-relief-provided.webp` 시드 동결(부록C 결정 2).

### 1단계 — 레지스트리 일원화 · cosmetic 폴백 소거

**분리 대상**: 도메인·포맷 별칭 해석의 레지스트리 일원화 + cosmetic 암묵 기본값 전수 소거. **정정된 사실**: 진입점(new-run.sh:46-49, ingest-bundle.sh:20-23)은 이미 fail-closed — 본체는 잔여 폴백 소거다.

**전제**: 0단계 완료(충족) + 1부 완료.

**작업**:
- [x] `normalize_format`(new-run.sh) → `format-profiles.json` 의 기존 aliases 필드 질의로 통일(별칭 집합 동일 실측 = 바이트 불변). [Commit A c43b8e3]
- [x] 도메인 한국어 별칭(new-run.sh case) → `domain.json` `aliases` 필드 신설·이관, normalize_domain 은 레지스트리 역탐색 질의로(`common.sh domain_alias_resolve`). [Commit A]
- [x] **cosmetic 폴백 전수 소거(11지점 + 추가 3곳)**: `kcia_engine.py`(default 플래그·레거시 브랜치·load_ruleset None tail), `common.sh`(resolve_domain·build_context else·이미지도메인·domain_sources_dir), `kcia-check.sh`(빈 룰셋 은닉 폴백), `ingest.py`(+1997), `stub_stage.py`, `validate-stage.sh` 5곳, `golden_runner.py`, `new-run.sh` 시드([]). **env(`HARNESS_DOMAIN`) 선언 인정 유지**(tests/lib.sh 가 선언 → 테스트 수정 0건). [Commit B a08f9c0]
- [x] `domain.json` `default: true` 의미 제거(default 플래그 read 삭제·registry default=None) + 미등록 안내문 = "등록된 팩 목록 + 온보딩 제안"(`operator_labels.py registered_domains_hint` 경유, new-run 미등록 die 에 배선). [Commit B + 후속]
- [x] 레거시 일괄 철거: `harness/regulatory-domains.json` 삭제 + docs/regulation 레거시 3종(registry.json 사문 매칭 2건·`LEGACY_RULESET`·common.sh sources 폴백) + `ingest-profiles.json` 사문 `default` 키. 폴백 코드 블록 제거. **"packs 없는 core 단독 체크아웃" 폐기를 AGENTS 3·8번 절·workflow-ssot 에 반영.** [Commit B]
- [x] `test-drug-golden.sh` default 단정군 → "default 부재 = fail-closed" 재작성(reg default=None·load_ruleset(None) 미완). `docs/reference/user-guide.md` 깨진 new-run 예시 수정(--domain/--format). [Commit B]

**검증**: 타겟 = `tests/test-drug-golden.sh`·`tests/test-routes.sh`·`tests/test-gates.sh` → 골든 = 스텁 2종 + 심의 골든셋 + 누출 grep(allowlist 점감) → 전체 CI. **함정**: kcia-check.sh:276 과 build_context else 는 registry default 와 별개 지점이라 누락되기 쉽다.

**동반 문서**: workflow-ssot(도메인 선언·fail-closed 서술) · AGENTS 8번 절 · user-guide.

**완료 기준**: 미선언·미등록 = fail-closed + 등록 팩 목록·온보딩 제안 안내 실물 확인 + 전체 그린 병합.

> ✅ 완료(2026-07-07 · refactor/pack-stage-1, 4커밋: c43b8e3 별칭 이동 · a08f9c0 폴백소거·배선 · c734af6 미등록안내 · e33dc56 B3 골든셋 도메인명시). **바이트 불변 실증**: verify-baseline 190항목 동일(선언 런 무변경). **fail-closed 실증**: new-run 미선언 die 가 등록 도메인 목록+온보딩 안내 표시. **함정 3곳 전부 처리**(kcia-check 은닉폴백·build_context else·registry default — 별개 지점). 델타 1건(B3 인라인 골든셋 도메인 미선언 → load_ruleset(None) fail-close 로 축검출 0)은 CI 가 잡아 e33dc56 로 해소. 검증: verify-baseline·drug-golden 88/0·pack-lint 19/0·routes 23/0·gates 17/0·operator-language 25/0·b3 18/0·core-domain-leak 2/0(14파일). **잔여 CI 실패 = 선재 4건뿐**(critic-fanout drug ADK 3·b4 1, clean main 동일).

### 2단계 — 심의 어휘·실증 정책 퇴거 (스키마 무변경)

**분리 대상**: kcia_engine 의 도메인 어휘 상수·실증 정책 → 팩 ruleset. **깨진 전제(실측)**: "core 상수 = 팩 lexicon 완전 일치"는 거짓 — `CONSUMER_DECEPTION_SEVERITY_HIGH` 19항목(kcia_engine.py:281-283)은 cosmetic ruleset 에 대응 키가 없다. 폴백을 그냥 공집합화하면 화장품 consumer_deception 위반이 high→medium 강등되어 verdict 바이트·confidence(:1197)가 변한다.

**전제**: 1단계 병합.

**작업**:
- [x] **커밋 a(이동)**: `consumer_deception_severity_high`(18항목·상수 실측)를 `packs/cosmetic/ruleset.json` axes.lexicon 에 값 그대로 추가 → 골든 그린. [345ab2a] (FUNC_EFFICACY·CONDITION_TARGET·PHARMA_AUTHORITY·zero_voc_exclude 는 이미 존재)
- [x] **커밋 b(배선·소거)**: kcia_engine 상수(FUNC_EFFICACY·CONDITION_TARGET·PHARMA_AUTHORITY·CONSUMER_DECEPTION_SEVERITY_HIGH) + zero_voc_exclude 인라인 리터럴 공집합화. `examples_analysis` 상수 직접 import(00g deny-list 우회로) 제거. `_MI_SIG_LEGACY` 공집합화(활성 도메인 signals 선언 → 도달 불가). [59b1556] 검증: verify-baseline 190·b3 18/0·examples-analysis 12/0·leak 2/0.
- [x] **잔여 완료(최고 위험 클리어)**: 임상 실증 disclaimer("개인에 따라 차이가 있을 수 있습니다")·표기 정규식 → `packs/cosmetic/ruleset.json` `axes.clinical_substantiation`(신규 축, additionalProperties:true) 착지(커밋 a' `ef19880`) → kcia_engine `_block_has_disclaimer`/`_block_shows_context` 시그니처 스레딩 + `Engine.clinical_subst=_clinical_subst(self.rs)` 팩 우선 조립(호출부 5곳; 커밋 b' `728b2d2`). ⚠ **설계 판단**: disclaimer 는 '빈 값=`"" in blob`=항상참' 위험이라 a+b 어휘의 공집합화와 달리 **레거시 기본값을 유지**(도메인-중립 machinery, core-domain-leak 면제 대상 — 어휘 상수 소거는 a+b 로 이미 달성). 팩이 선언을 소유해 오버라이드 가능 = 팩 소유화 달성. **byte-frozen 함정 전부 보존**: adk_critic 지시문·stub_stage 리터럴·operator_labels 라벨·completeness_advisor 스펠링 무변경. 추가 발견: adk_critic `_AXIS_CONFIG_KEYS` 에 clinical_substantiation 추가(신규 축이 위반 축으로 오인돼 Pass-A 지시문에 새는 것 차단). 검증: verify-baseline 190·drug-stub 106(3/0)·b3 18/0·clinical-engine 26/0·clinical-chart 56/0·completeness-advisory 15/0·prompt-assembly 12/0.
- [x] **잔여 완료**: author 슈퍼셋 → `domain.json` 이관. 무주지 `guideline_review_agent` 를 cosmetic `adk_critic.author_aliases` 로 홈 지정(커밋 c' `c21208b`) → 하드코딩 3-슈퍼셋 폐기 `known = {author} | _known_authors()`(등록 전 도메인 author+author_aliases 합집합; 커밋 d' `a1a8fa2`). `_known_authors()==옛 하드코딩 집합` 실증(집합 동일). pack_lint author_aliases 선택 배열 검증(21/0). **온라인 카나리(실 cosmetic ADK)**: exit 0·provenance 통과(author cosmetics_review_agent)·실 verdict 수신(substantiation 2건).

**검증**: 타겟 = 심의 골든셋(검출률·오탐률 불변)·`tests/test-examples-analysis.sh`·`tests/test-completeness-advisory.sh` → 골든 = 스텁 2종 + 프롬프트 조립 골든(ADK 지시문 부분) → **온라인 카나리 1회**(실 ADK 호출 — author 이관 확인) → 전체 CI.

**동반 문서**: workflow-ssot(심의 정책의 팩 소유 서술).

**완료 기준**: core 에 화장품 심의 어휘 상수 0(누출 grep 해당분 소거) + 골든 4종 그린 + 카나리 통과 병합.

> ✅ 완료(2026-07-07 · refactor/pack-stage-2, 6커밋: a 345ab2a·b 59b1556 어휘 lexicon 이동[선행] + a' ef19880 clinical_substantiation 착지 · b' 728b2d2 kcia_engine 배선+adk_critic 축제외 · c' c21208b author_aliases 착지+pack_lint · d' a1a8fa2 adk_critic provenance 배선 · e'(문서)). **어휘 상수 소거는 a+b 로 달성**(core-domain-leak 14파일 불변 — disclaimer/regex 는 도메인-중립 machinery 라 애초 미저촉). **팩 소유화 잔여 완결**: 임상 실증 표기 정책·author 슈퍼셋을 팩 선언으로 이관. **바이트 불변 실증(개별)**: verify-baseline 190·drug-stub 106(3/0)·b3 18/0·clinical-engine 26/0·clinical-chart 56/0·completeness-advisory 15/0·prompt-assembly 12/0·examples-analysis 12/0·pack-lint 21/0·core-domain-leak 2/0(14파일). **온라인 카나리**: 실 cosmetic ADK provenance 통과·verdict 수신. **회귀 함정 처리**: (1) 신규 config 축이 adk_critic Pass-A 지시문 axes_list 에 누수 → `_AXIS_CONFIG_KEYS` 제외로 복원(prompt-assembly 골든). (2) 내부 함수 직접호출 유닛테스트(test-clinical-engine)를 새 시그니처로 래핑(동작 불변). **설계 판단(문서화)**: disclaimer 는 공집합화 시 `"" in blob`=항상참라 안전하지 않아 레거시 기본값 유지(a+b 의 컬렉션 공집합화와 구별). 전체 CI: 선재 4건(critic-fanout drug ADK 3·b4 1) 외 신규 델타 0.

### 3단계 — 인입 팩화

**분리 대상**: ingest 프로파일·번들 매핑 → 팩. **확정 사실**: `harness/ingest-profiles.json` 에 cosmetic 항목이 없다(ingest.py:32-33 이 cosmetic 이면 빈 dict 단락 → 모듈 상수 사용). **역방향 함정**: 비화장품 3도메인 프로파일에 `bp_block_order`·`bp_hints` 키가 없어 화장품 기본값(:394-397)을 상속 중 — 폴백 제거 시 **drug 런 산출 바이트가 변한다** → 0단계 drug 골든이 전제조건.

**전제**: 2단계 병합 + drug 부분 골든 가동(충족).

**작업**:
- [x] `harness/ingest-profiles.json` → `packs/<도메인>/ingest-profile.json` 이동. **cosmetic 프로파일 신설**(모듈 상수 값 프로그램 생성 착지: VOC_KEYWORDS·PERSONA_KEYWORDS·OPTION_REGEX(현 :48-50), FUNC_LABELS(현 :690)·CERT_KWS(현 :799)·EFFICACY_WORDS(현 :816)·product_type(현 :809), BP_BLOCK_ORDER·BP_HINTS(현 :651-654)). 비화장품 3도메인 프로파일에 현행 유효값(화장품 BP 상속분 포함) **명시 착지**. `ingest.py._ingest_profile` 가 `_PACKS_DIR` 로 전 도메인 읽고 인라인 기본값 안전-공집합화. [커밋 a 334a8bc·b 2ed05bf] APPROVAL/EVIDENCE/POSSESSION 등 마커는 도메인-무관 모듈상수라 이동 대상 아님(정찰 정정).
- [ ] ⏭ **이월(설계 판단)**: 번들 스키마 매핑(naver product.json 필드·reviews.csv 컬럼, `cmd_voc`·`examples_analysis._signals`·`img_lint` mainImage) → `bundle-profile.json`. 정찰 결과 이 매핑은 **크롤-소스 포맷(naver)이라 도메인-독립**(전 도메인 동일)·누출 grep 무관 — per-도메인 팩에 4중 복제는 오설계. **소스/포맷 프로파일** 설계(비-naver 소스 온보딩 시 실익)로 이월.

**검증**: 타겟 = `tests/test-b0.sh`·`test-b1.sh`·`test-b1e.sh`·`test-b5.sh`·`test-multiproduct-extraction.sh`(추출 정확도·claim-basis 기대표) → 골든 = 스텁 2종(**특히 drug best-practices.json 바이트**) → 전체 CI.

**동반 문서**: workflow-ssot(인입 계약의 팩 소유).

**완료 기준**: `harness/ingest-profiles.json` 소멸 + ingest.py 도메인 상수 소거(누출 grep 점감) + voc/claim-basis 산출 바이트 불변 병합.

> ✅ 완료(2026-07-07 · refactor/pack-stage-3, 2커밋: a 334a8bc 프로파일 착지(4팩) · b 2ed05bf ingest.py 배선+harness 파일 폐지 · 문서 동반). **`harness/ingest-profiles.json` 소멸** ✓. **ingest.py 도메인 추출 상수 소거** ✓(VOC/FUNC/EFFICACY 인라인 화장품 기본값 → 안전-공집합; 값은 팩 소유). **voc/claim-basis/best-practices 바이트 불변** ✓. **역방향 함정 실증**: drug best-practices.json 은 화장품 BP 상속분을 drug 팩에 명시 착지 → drug-stub-golden 106 바이트 동일(3/0). 검증: b0 39/0·b1 37/0·b1e 54/0·b5 25/0·multiproduct 60/0·examples 12/0·verify-baseline 190·drug-stub 106(3/0)·leak 2/0(14). 전체 CI 선재 4건 외 신규 델타 0. **누출 grep allowlist 미점감(14 유지)**: ingest.py 는 도메인 추출 상수는 소거됐으나 multiproduct WB-스코핑 docstring 브랜드 예시(우루사/이지듀/대웅, :180-220)+기능성화장품 주석(:692)이 잔류 — kcia_engine 이 1·2단계 후 disclaimer 로 allowlist 잔류한 것과 동형. 문서 예시 genericize 는 멀티프로덕트 문서 traceability 손상이라 **9단계(잔여 소탕)로 이월**(allowlist 위생검사는 통과 — 잔류가 사문 아닌 실매치). **2차 이월**: bundle-profile(도메인-독립 크롤 스키마). **secondary docs stale**(harness-architecture.md:61·pipeline-stage-definitions.md:105/117/119 가 폐지된 ingest-profiles.json 참조) → 9단계 정합 검수 목록에 편입.

### 4단계 — 캐논 단일화 (최대 작업)

**분리 대상**: 3곳으로 갈라진 캐논 정본(생성 측 stub_stage.py:293-323 CANON · 검증 측 validate_storyboard.py + storyline.schema.json enum · 커버리지 측 packs/_format/canon-components*.json) + 문서(docs/reference/canon-blocks.md, 15블록)를 `packs/_format/<포맷>/canon.json` **정본 1개**로.

**전제**: 3단계 병합.

**작업**:
- [x] **canon.json 정의**: 포맷별 정본 `packs/_format/<포맷>/canon.json` — blocks(type·intent·risk_tier·evidence_required, 스텁이 storyline.json 방출)·types(전역 23 카탈로그)·evidence_gated·brand_gated·required_root·components(canon-components 흡수). stub CANON·스키마 enum·canon-components 에서 프로그램 생성(바이트 정확). [커밋 a 7175c2a]
- [x] **커밋 a(배선)**: 소비처 재지향 — stub_stage(_load_canon; [b 9240471])·validate_storyboard(_canon(fmt)/_required_root(fmt), **무음 `_CANON_FALLBACK` → fail-closed**)·check_canon_coverage(components)·format-profiles(canon 재지향·coverage_path 제거·canon-components 삭제) [c 44cd4fe]. **정찰 정정**: kcia_engine/image_engine/check_beforeafter 블록명 리터럴은 카탈로그가 아니라 per-block 심의/이미지 **로직 선택자**(behavior, 유지)·examples_analysis 의 BP_BLOCK_ORDER 는 **도메인 팩(ingest-profile) 소유**라 format 캐논과 직교(미이동)·completeness_advisor 는 canon-coverage.json 경유 **transitive**(무변경).
- [x] **커밋 b(스키마 완화)**: storyline/plan-block type enum(23) → 패턴(카탈로그 대조는 canon.json.types + validate._canon 강제). state.schema deliverable_format enum → 패턴 + new-run normalize_format 레지스트리 강제(regulatory_domain 전례). test-components 스키마 grep 단정 2곳 → canon.json types 대조. [d 0394217]
- [x] `docs/reference/canon-blocks.md` → canon.json 파생 문서로 대체 · format-profiles `canon` 참조 갱신 · AGENTS 12블록 표기 갱신.
- [x] **도메인 변형 규약**: 1차엔 아무 도메인도 canon 변형을 만들지 않음(동작 불변) — canon.json 로더가 포맷별로 읽으므로 도메인 오버레이는 2차에서 규약만 추가하면 됨.

**검증**: 타겟 = `tests/test-components.sh`·스토리보드 검증 테스트·`tests/test-render-existence-depth.sh` → 골든 = 스텁 2종(**storyline.json 의 intent/risk_tier 바이트 불변이 핵심**) + 심의 골든셋 → 전체 CI.

**동반 문서**: workflow-ssot + AGENTS("12블록" 낡은 표기 → 캐논 카탈로그 참조로) + canon-blocks.md 대체.

**완료 기준**: 캐논 정본 1개(canon.json) + 소비처 전건 재지향 + 스텁 골든 바이트 불변 병합.

> ✅ 완료(2026-07-07 · refactor/pack-stage-4, 5커밋: a 7175c2a canon.json 착지 · b 9240471 stub 배선 · c 44cd4fe 검증·커버리지 배선+canon-components 흡수 · d 0394217 스키마 완화 · e 문서). **정본 1개 달성**: `packs/_format/<포맷>/canon.json` 이 생성(stub)·검증(_canon types·required_root)·커버리지(components) 전부의 SSoT. canon-components*.json 삭제·스키마 type/deliverable_format enum→패턴. **바이트 불변 실증(개별·단계별)**: storyline A/B/C + plan 13 골든(verify-baseline 190·drug-stub 3/0 — intent/risk_tier 바이트)·components 39/0·b3 심의 골든셋 18/0·b9 11/0(one_pager format-aware)·b0 39/0(deliverable_format 패턴)·routes 23/0·gates 17/0·render-existence-depth 14/0. 전체 CI 선재 4건 외 신규 델타 0. **정찰 정정(계획 대비)**: '소비처 8곳' 중 kcia_engine/image_engine/check_beforeafter 는 per-block 심의/이미지 **로직 선택자**(카탈로그 아님)·examples_analysis 는 **도메인 팩 BP**(format 캐논 직교)·completeness_advisor 는 **transitive** — 실제 format-캐논 카탈로그 소비처 = stub_stage·validate_storyboard·check_canon_coverage 3곳(전건 재지향 완료). **9단계 이월**: workflow-ssot 캐논 상세절(127-193 15블록 서술·canon-components 경로·coverage_path)·secondary docs(stage-contracts·pipeline-stage-definitions) 문서 정합.

### 5단계 — 생성 표면 팩화 (프롬프트 · stub 콘텐츠)

**분리 대상**: 생성 프롬프트의 도메인 조각과 stub 콘텐츠. **증명 한계(실측)**: stub 은 build_context 를 쓰지 않아(common.sh:350·370 주석) 프롬프트 변경이 스텁 골든에 안 나타난다 — **프롬프트 조립 골든이 유일 안전망**.

**전제**: 4단계 병합.

**작업**:
- [x] 프롬프트 도메인 어휘 소거: `prompts/{brief,guideline,storyboard-plan,kcia-critic}.md` 의 도메인 고유 어휘(미백/주름/피지/EGF/이지덤/아누아·모친선물·여드름)를 제거 → 금지어·정량지표는 전달된 도메인 `RULESET`(축별 banned/triggers) 참조로 일반화, 브랜드/시나리오 예시는 도메인-중립화. **정찰 정정**: build_context ctx 골든은 프롬프트 본문 미포함(경로만)이라 신규 라벨 주입·prompt-fragments 디렉터리 없이 RULESET 참조만으로 도메인-중립 달성 — ctx-*.txt 불변, prompts.sha256 만 재캡처. keyvisual.md 는 애초 누출 없음(O-5/O-6 저작 규칙 = 커널 골격, 미이동 확인). [커밋 2d2f549]
- [x] `kcia-critic.md` 화장품 4축 예시 → `packs/cosmetic/critic-fragment.md`(팩 소유). 깨진 `docs/regulation/` PDF 참조 → `packs/<도메인>/sources` 로 정정. **`critic_prompt` 실배선 = 하지 않기로 결정(정찰 후, 5단계-B)**: ADK 지시문은 `adk_critic.py:_build_pass*_instruction`(:582/602)이 **ruleset 단일 출처**(`_valid_axes`:445+`_ruleset_grounding`:467, banned/triggers)로 조립하며 순수 함수가 HARNESS_ROOT·레지스트리·파일 I/O 와 **의도적 격리**(:650-651)다. fragment 예시는 그 grounding 과 **내용 중복**이라 배선해도 새 정보 0 이고, 배선은 경로해석·로더·두 함수 스레딩·fragment 없는 도메인 fail-soft 신설 + 온라인 동작 변경 + 골든 재캡처를 요구하는 **설계 후퇴**. kcia-critic.md·critic-fragment.md 는 **참조/설계 문서로 유지, 미배선**(fragment 헤더에 명기). 계획서 초안의 "실배선"은 정찰 전 판단이었음. **Codex 적대 검증 = SOUND**(미배선 타당). 정밀화 2건: (a) '소비처 0' 은 **프롬프트-소비처 0**을 뜻함 — 파일은 `kcia-check.sh:247` 무결성 해시 + prompt-assembly `prompts.sha256` 로는 살아있음(죽은 파일 아님, 지시문 미주입). (b) **진짜 개선 여지(마크다운 배선 아님)**: `_ruleset_grounding()`(adk_critic.py:467)이 `conditional`·`lexicon.functional_efficacy` 를 누락해 ADK 지시문에 기능성-오인 힌트(미백/주름/자외선=approved 필요)가 없음 → 필요 시 **ruleset-파생 grounding 확장**으로 개선(단일 출처 유지). 단 룰엔진(kcia_engine.py:345)이 이미 기능성 lexicon 을 결정론 검사 → belt-and-suspenders. ⏭ **후속(심의 품질 개선·온라인 동작 변경, refactor 범위 밖)**: grounding 확장은 온라인 카나리 + RA 판단(ADK 제약 추가 실익) 필요.
- [x] **stub 콘텐츠 템플릿(10/12 군, byte-frozen)**: stub_stage.py `_is_cosmetic` 화장품-전용 콘텐츠 → `packs/cosmetic/stub-templates/content.json`(누출 리터럴 3[c788a4a] + 명사·brief diff/alt·plan body 3·reco pref·B-emotional rtb/km·B-emotional 축정의 9[de565e4·c6effc9·7ee9459]). **설계: cosmetic→팩, else(비화장품 generic 폴백)→core 잔류**(도메인-중립·누출 무매치). stub_stage.py allowlist 소거는 누출 리터럴 단계(9단계)에서 이미 완료. verify-baseline 190·drug-stub 3/0 전 배치 byte-frozen. **A-efficacy fallback 화장품 카피(_claim·_head)도 이관** — 골든 미발화 경로라 **직접 발화 검증**(monkeypatch 로 경로 강제 → 축자 일치)으로 byte-correct 확인[76adeff]. ⏭ **잔여 1군(재캡처 human-gate)**: faq_external "본품 15g"(무조건 분기 교차오염 latent → 분기 시 drug 골든 변경 = D절 6 재캡처).
- [ ] ⏭ **이월(5단계-B)**: `run-stage.sh` 죽은 히어독(비-STUB else 분기, 정찰상 도달불가 확정) 제거 — 골든 무영향이나 실엔진 경로라 안전 확인 필요.

**검증**: 타겟 = `tests/test-prompt-assembly.sh`(조립 결과 문구 동일) → 골든 = 스텁 2종 → 전체 CI + 누출 grep allowlist 점감(14→10).

**동반 문서**: workflow-ssot(생성 재료의 팩 소유).

**완료 기준**: prompts/*.md 에 도메인 고유 어휘 0(누출 grep 점감) + 스텁 골든 바이트 불변 + 프롬프트 조립 골든 문구 동일 병합.

> ✅ 완료(2026-07-08 · refactor/pack-stage-5, 1커밋 2d2f549 + 문서). **완료 기준 3건 충족**: (1) prompts/*.md 도메인 어휘 0 — brief/guideline/storyboard-plan/kcia-critic 4파일 소거(RULESET 참조로 일반화; keyvisual/concept 는 애초 누출 없음), (2) 스텁 골든 바이트 불변(stub_stage 미접촉 — verify-baseline 190·drug-stub 3/0), (3) 프롬프트 조립 골든 문구 동일(ctx-*.txt·instr-*.txt 불변, prompts.sha256 만 재캡처). **누출 grep allowlist 14→10**(위생검사 통과). critic-fragment.md 팩 소유. **이월(5단계-B)**: 최엄격 stub 콘텐츠 템플릿 이동(stub_stage.py allowlist 잔류)·죽은 히어독 제거·critic_prompt 실배선 — byte-freeze 리스크로 별도. 전체 CI 선재 4건 외 신규 델타 0.

### 6단계 — 디자인·이미지·export·운영 라벨

**전제**: 5단계 병합.

**작업**:
- [x] **6단계-B**: 디자인 토큰 stub_stage ACCENT_DEFAULT(#c0392b)·TONE_DIRECTIONS → **신규** `packs/_format/design-tokens.json`(공유·도메인 무관·포맷 축; 모듈-레벨 `_DESIGN_TOKENS` 읽기). create-then-wire(팩소스 신설, 값 축자 복사). **최광역 byte-freeze 통과**: verify-baseline 190·drug-stub 3/0·b9 11/0·b5 25/0·image-engine 34/0(TONE[0] 이 art-direction·전 plan·svg·options html 착지). 토큰 clean(누출 무매치) → allowlist 0 불변. [커밋 878748c] 폰트는 core 로케일 잔류.
- [x] 이미지 생성 프롬프트 골격 브랜드-오염 주석(image_engine.py `build_prompt` easydew/이지듀 예시, 현 :159) → 도메인-중립 일반화(온라인 전용·골든 무영향). [커밋 84f4a66]
- [x] **export 경로(`export/kcia-package`)는 1차 불변**. `export_package` 필드(소비처 0건 실측 확인) = "무시됨" 문서화만(누출 regex 무매치). 도메인별 패키지명 = 2차 이월.
- [x] `operator_labels.py`·`prompts/operator-voice.md` 도메인 어휘 소거(FILL_LABEL metric 예시 피지량·말하기 예시 미백 → 도메인-중립). 누수 차단 장치(_FORBIDDEN_RE/scrub)는 커널 잔류. ⏭ **팩 오버레이(labels.json merge)는 이월** — 현재는 genericize 로 누출만 소거(오버레이 machinery 신설은 6단계-B). [커밋 84f4a66]

**검증**: 타겟 = `tests/test-operator-language.sh`·`tests/test-image-engine.sh` → 골든 = 스텁 골든(키비주얼 HTML 바이트) → 전체 CI + 누출 grep allowlist 점감(10→7).

**완료 기준**: 라벨·이미지 도메인 어휘의 core 잔존 0(디자인 토큰=clean 값·6단계-B) + 키비주얼 HTML 바이트 불변 병합.

> ✅ 완료(2026-07-08 · refactor/pack-stage-6, 1커밋 84f4a66 + 문서). **누출 grep allowlist 10→7**: image_engine.py(easydew 주석)·operator_labels.py(피지량 예시)·operator-voice.md(미백 예시) 3파일 도메인 어휘 소거(위생검사 통과). 검증(바이트 안전): operator-language 25/0·image-engine 34/0·verify-baseline 190·drug-stub 3/0·prompt-assembly 12/0(operator-voice 재캡처). **이월(6단계-B)**: 디자인 토큰(ACCENT_DEFAULT/TONE_DIRECTIONS → 신규 design-tokens.json — clean 값이라 누출 무관·양 매니페스트 byte-frozen·팩소스 부재로 create-then-wire, 최엄격 구간)·operator_labels labels.json 팩 오버레이 machinery. 전체 CI 선재 4건 외 신규 델타 0.

### 7단계 — 샘플·자산·examples 퇴거 (독립 단계)

**분리 이유(적대 검증)**: 8단계와 합치면 베이스라인 재생성이 "무엇 때문에 해시가 변했는지"를 가려 증명 앵커를 잃는다. assets-manifest 기록 경로는 런-상대(ingest.py:371)라 시드 원위치와 무관하지만, own_assets = 시드 디렉터리 전수 수집이라 **내용 집합이 바뀌면 전부 변한다**.

**전제**: 6단계 병합.

**작업**:
- [x] **커밋 a(경로만, 내용 집합 동결)**: `core/inputs/{assets,working-backwards.md,wb-ezderm-relief.md}` (추적 시드) → `packs/cosmetic/samples/` git mv(바이트 동일). 기본 경로 4곳 재지정(**정찰 정정**: ingest-bundle.sh:67 ASSETS_DIR·:69 WB·:99 EXAMPLES_SRC · common.sh:752 예시폴백 → `$PACKS_DIR/cosmetic/samples/*`) + test-relief-facts RELIEF_WB. **자산은 도메인-flat union 1경로로 이동**(:67 도메인-flat 유지 — 양 baseline 이 24파일 union 스냅샷; 도메인별 split 은 커밋 b). examples(gitignored 크롤)·generated(폐기)는 물리 이동 + 루트 .gitignore `samples/{examples,assets/generated}` 추가. **구 매니페스트 그대로 verify 통과**(집합·바이트 동결). [커밋 7단계-a]
- [x] **7단계-B(사람 승인 "지금 재캡처" 하 실행 · Codex 리뷰 반영)**: 자산 flat union 을 도메인별 분리 — seam `ingest-bundle.sh:67` → `$PACKS_DIR/$HARNESS_DOMAIN/samples/assets`(도메인은 :38 state). packs/drug/samples/assets 신설(ursa/daewoong+중립). **양 baseline 재캡처**(사전 diff 로 자산 범위 확인 → 결정적 2런 intersect): cosmetic 190→180·drug 106→100. **Codex 리뷰 반영**: High#1(product-main.jpg=실제 화장품 사진→drug 에서 제거·ursa-product-main 승격)·Medium#4(cosmetic 픽스처 ursa 재생성)·Low#6(빈 도메인 fail-closed)·mkdir 강화(런→팩 변조 방지). drug 자산 화장품 0. verify-baseline 180·drug-stub 3/0·drug-golden 88/0·픽스처 소비처 전건·leak 0. [커밋 254d1d7·4764bbd·98b944b·7d3740a·9e198ab] ⏭ **잔여(비-차단)**: High#2(TBD 도메인 무이미지 미보장=stub SVG 생성, 오염 아님)·Low#7(WB 기본값 cosmetic — 자산 seam 과 동형, 도메인 WB samples 필요).

**검증**: 커밋 a = `bash tests/verify-baseline.sh` **구 매니페스트로 그린**(불변 증명) → 커밋 b = 재캡처(`bash tests/capture-baseline.sh`) 후 그린 + 재캡처 사유 커밋 메시지 명기 → 전체 CI.

**완료 기준**: core/inputs 에 도메인 시드 0(추적) + 재캡처 1회로 격리 병합.

> ✅ 커밋 a 완료(2026-07-08 · refactor/pack-stage-7). **core/inputs 추적 시드 0**: 자사 자산 24 + WB 2 → packs/cosmetic/samples/(git mv 바이트 동일, stat=Bin 0-change). 시드 기본경로 4곳 재지정. **바이트 동결 실증(구 매니페스트)**: verify-baseline 190·drug-stub 106(3/0) — 자산 flat union 1경로 유지로 양 baseline 스냅샷 불변. test-relief-facts 17/0·b0 39/0·b1 37/0·leak allowlist 7(불변). 전체 CI 선재 4건 외 신규 델타 0. **7단계-B 이월(사람 확정 필요)**: 커밋 b 교차오염 교정 = 양 baseline 재캡처(결과 큰 행위, D절 6). 완료 기준의 '재캡처 1회로 격리'는 이 사람-게이트 통과 후.

### 8단계 — 팩별 테스트·골든·fixtures 선언 (사람 확정 항목)

**전제**: 7단계 병합.

**작업**:
- [x] `packs/cosmetic/{fixtures,golden}/` 규약 디렉터리 확립(stub-templates 는 5단계-B).
- [x] `core/fixtures/` 3종(concept-in·conti-in·keyvisual-in cosmetic) → `packs/cosmetic/fixtures/` git mv 바이트 동일. **소비처 전수 재지정(~30, 정찰 정정 — 7곳 아님)**: seed_fixture(lib.sh:40 — 간접 소비처 ~10 커버) + 하드코딩 16곳(stage-brief·test-prompt-assembly:62/67/72/81·test-gen-image:47/182/243/325·test-image-engine:364/421/470/570/617/664) + run-stages 가드 + build-fixtures SNAP_ROOT. [커밋 8단계-a 01be7aa]
- [x] `tests/golden/` 화장품 소유물(working-backwards.md·kcia-golden-set.json·claim-basis-expected.json·wb-with-evidence.md) → `packs/cosmetic/golden/`. WB 는 baseline-manifest+prompt-assembly **이중 byte-pin** — 바이트 동일 + 소비처(lib.sh HARNESS_WB 기본·build-fixtures·test-b1/b2/b3/b4·components·multiproduct) 재지정.
- [ ] ⏭ **이월(8단계-B, 우선순위 낮음)**: 테스트 단정 문자열(대웅배너·제조판매원·광고심의필) → 팩 fixture 기대값. **정찰 정정**: 이들은 단순 단정이 아니라 **다행 도메인 시나리오 HTML mock**(drug 필수기재 페이지·cosmetic 배너 시나리오 = 심의엔진 테스트 스캐폴딩). 추출은 fiddly·**누출-grep 미스캔이라 allowlist 무관**·byte-frozen 위험 대비 이득 낮음 → 신선 컨텍스트 이월.
- [x] **팩 적합성 스위트**(8단계-B): `tests/pack-conformance.sh` 신설 — 전 팩 순회로 (0)레지스트리 불변식(pack-lint) (1)각 팩 선언물 존재 (2)검증 도메인 골든셋 회귀(golden_runner 게이트)를 실행. run-ci 등록. 스텁 베이스라인은 도메인별 골든이 담당(중복 회피). 검증: pack-conformance 13/0(cosmetic·drug active 회귀 통과·health_food·quasi_drug TBD 면제). [커밋 9c8f49c]
- [x] **drug 경계 픽스처** → packs/drug/fixtures(git mv 바이트 동일 34파일, SNAP_ROOT 균일화). **core/fixtures 소멸**(전 도메인 픽스처=팩 소유). [커밋 8180528] ⚠발견: 커밋된 drug 픽스처가 현행 재생성분과 stale-drift(잠복, 테스트 미소비 — 재프리즈는 사람-게이트).
- [x] **drug 골든셋·WB** → packs/drug/golden(kcia-golden-set·working-backwards, git mv 바이트 동일·-drug 접미 제거=cosmetic 대칭; baseline-manifest-drug 는 해시매니페스트라 core 잔류). 소비처 재지정(test-drug-golden·test-drug-stub·pack-conformance). drug-golden 88/0·drug-stub 3/0·pack-conformance 13/0. **core/tests/golden 도메인 입력 골든 0.** [커밋 ce82c65]
- [ ] ⏭ **이월(8단계-B)**: `tests/lib.sh` cosmetic env '기본값 의미 제거'(semantic·바이트 무영향, env 기본값 변경은 테스트 파손 위험 → 신선 컨텍스트).

**검증**: 팩 적합성 스위트 신설 그린(4팩) → 스텁 골든 2종(경로 이동 후 불변) → 전체 CI.

**완료 기준**: 각 팩이 자기 테스트·골든·fixtures 선언 보유 + core/fixtures·tests/golden 의 도메인 소유물 0 병합.

> ✅ 커밋 a 완료(2026-07-08 · refactor/pack-stage-8). **core/fixtures·tests/golden 의 cosmetic 소유물 → packs/cosmetic/{fixtures,golden}** git mv 바이트 동일. 소비처 ~30 전수 재지정(리팩토링 최대 소비처 이동). **바이트 동결 실증(WB 이중 pin)**: verify-baseline 190·drug-stub 3/0·prompt-assembly 12/0·b3 18/0·b1 37/0·b2 30/0·components 39/0·multiproduct 60/0·render-depth 14/0·image-engine 34/0·gen-image 36/0·stages 전건·leak 7(불변). 전체 CI 선재 4건 외 신규 델타 0. **8단계-B 이월(사람 확정)**: 팩 적합성 스위트(신규 per-pack 러너 machinery)·단정문자열→팩fixture·lib.sh env·drug 픽스처. 완료 기준의 '각 팩이 자기 테스트 선언 보유'는 스위트 신설(8-B) 후.

### 9단계 — 마무리 검수

**전제**: 8단계 병합.

**작업**:
- [x] 누출 grep allowlist **0 달성** (14→0). **경로**: 5·6단계(14→7) + 5단계-B 부분(stub 누출 리터럴 → packs/cosmetic/stub-templates, byte-frozen, 7→6) + 잔여 6파일 주석/docstring 예시 도메인-중립화(6→0). 주석/docstring 의 예시(브랜드·효능어)만 플레이스홀더로 바꿨고 **코드 산출·로직·disclaimer machinery 불변**(byte-safe). core 는 이제 도메인 데이터 0(전부 packs 소유). [커밋 5b c788a4a·9 05cffc8]
- [x] 문서 최종 정합 검수(**완료**): harness-architecture.md 표·pipeline-stage-definitions.md(ingest-profiles·canon-components)·workflow-ssot 헤더+캐논 상세절(canon-components*.json·coverage_path → canon.json 정본)·stage-contracts.md(canon-components → canon.json)·README(폐기 `KCIA_CRITIC_CMD` → 원격 ADK)·`.env.example`(drug adk_critic 구현됨 → 미구현 예를 건기식·의약외품으로 정정). 활성 문서 broken 참조 0.
- [ ] ⏭ 죽은 코드 정리(잔여): adk_critic dangling docstring 등.

**검증**: `bash tests/test-core-domain-leak.sh`(allowlist 소진) → 전체 CI → 아래 DoD 8건 전건 확인.

> ⏳ 진행 중(2026-07-08 · refactor/pack-stage-9): 문서 정합 **부분** 착수(broken deleted-file 참조 소거 — harness-architecture·pipeline-stage-definitions·workflow-ssot debt). **allowlist 0 미달(7 유지)**: 잔여 소탕이 5단계-B(최엄격 스텁 byte-freeze)·2단계 disclaimer 폴백 설계판단·3단계 multiproduct docstring 추적성 판단에 의존 → 신선 컨텍스트·사람 확정 필요. DoD 8건 중 1~6·8은 각 단계에서 실증(스텁 골든 2종·프롬프트 조립·심의 골든셋·미등록 fail-closed·온라인 카나리·문서 동반)했고, **4(allowlist 0)·5(4팩 적합성 스위트=8단계-B)·7 재캡처(7단계-B)** 가 잔여.

### 1차 완료 판정 (Definition of Done)

1. [x] 스텁 바이트 골든 2종 그린 — cosmetic done 전 구간 + drug 현행 동작(escalated까지). (전 단계 verify-baseline 190·drug-stub 3/0)
2. [x] 프롬프트 조립 골든 그린(생성 지시문 + ADK 지시문, 문구 단위 동일). (prompt-assembly 12/0)
3. [x] 심의 골든셋 검출률·오탐률 불변(cosmetic + drug). (b3 18/0·test-drug-golden)
4. [x] 누출 grep: core/ 에서 도메인 어휘·브랜드·블록명 0건(allowlist 소진). **14→0 달성**(9단계).
5. [x] 4팩 적합성 스위트 그린 — 각 팩이 자기 테스트·골든·fixtures 선언 보유. (`tests/pack-conformance.sh` 13/0, 8단계-B)
6. [x] 미선언·미등록 = fail-closed + 등록 팩 목록·온보딩 제안 안내. (1단계)
7. [x] 온라인 카나리 1회 통과(원격 ADK 지시문·author 이관 확인). (2단계 잔여, 실 cosmetic ADK)
8. [x] workflow-ssot 등 문서 정합 — 활성 문서 broken 참조 0(harness-architecture·pipeline-stage-definitions·workflow-ssot 헤더+캐논 상세절·stage-contracts·README·.env.example 전건 canon.json/ADK 정본). 9단계 완료.

> **DoD 요약(2026-07-08)**: **8건 전건 충족** — 스텁 골든·프롬프트 조립·심의 골든셋·**allowlist 0**·**4팩 스위트**·fail-closed·온라인 카나리·문서 정합. **1차 완료.** **추가 완료(비-DoD 이월분 중 자율-안전)**: **6단계-B 디자인 토큰 팩화 완료**(878748c, byte-frozen). **잔여(비-DoD)**: 7단계-B(자산 교차오염 교정 + 양 baseline 재캡처 = D절 6 **사람 확정 필수**·human-gate — 유일한 자율 불가)·5단계-B 잔여(스텁 비-누출 콘텐츠[톤/축/카피] 템플릿화 — **allowlist 무관**·byte-frozen 대작업)·8단계-B 잔여(단정문자열→팩fixture[테스트 파일, allowlist 무관·plan '우선순위 낮음']·drug 픽스처[소비처 0]·lib.sh env[semantic])·bundle-profile(3단계, 도메인-독립). 전부 DoD·allowlist 무영향.

### 2차 이월 목록 (1차에서 의도적으로 하지 않는 것)

| 항목 | 1차에서 못/안 하는 이유(실측 근거) |
|---|---|
| kcia 명명 중립화 | 108파일·263회 참조 + baseline 골든 계약(kcia-package 16항목) — "바이트 동일"과 양립 불가. 별도 배치로 격리 |
| 도메인별 export 패키지명(export-profile 실배선) | 경로가 골든 계약·advance-phase 게이트에 고정. 골든 재캡처 전제 |
| drug done-골든 | 스텁 도메인-인지(팩별 stub 템플릿의 drug 콘텐츠)가 신규 동작 |
| drug 캐논 변형(의약품 상세페이지 블록 세트) | 콘텐츠 제작 — "값 이동만" 원칙 밖 |
| 심의 축 카탈로그 선언화(축-일반 루프) | ruleset.schema 런타임 비강제(검증 호출 0건) — 실행 경로는 scan_text 축별 하드코딩 디스패치, 일반화는 동작 추가 |
| golden-set axis enum 완화 | 새 축 라벨용 — 기존 골든(4축)은 enum 통과 중이라 1차 불필요 |
| 페이즈 팩 기여(route-union) | phase-descriptors.schema 주석이 "단계5/6 연기" 명시 |
| 폰트 팩/브랜드 자산화 | 상대경로 규약+골든 HTML 3중 결박 — 실익 대비 파손 범위 큼(열린 항목) |

---

## 3부 — 2차 계획: 온보딩 (1차 완료 후)

### 준비 완화 묶음 (온보딩 선결 — 1차 이월분 처리)

- **2차 1단계 — 심의 축 카탈로그 선언화**: 팩이 축(id·라벨·검사방식 type: banned|conditional|trigger-evidence|hard-stop|mandatory-inclusion)을 선언, `scan_text` 를 축-일반 루프로, golden-set.schema axis enum 완화(패턴+카탈로그 대조), drug 5축째(prescription_otc_distinction) 1급 승격 + mandatory_inclusion root 승격. `_AXES_GUIDE`(adk_critic)를 룰셋에서 생성.
- **2차 2단계 — 콘텐츠 교정 패스**: 팩별 stub 템플릿에 drug 콘텐츠(done 도달 가능) + drug done-골든 신설. **drug 캐논 변형 첫 실사용**(의약품×상세페이지 블록 세트 — 현재 의약품 런이 화장품 캐논 required 를 우회 충족하는 왜곡 해소). export-profile 실배선(도메인별 패키지명 + 골든 재캡처).
- **2차 3단계(선택) — kcia 명명 중립화 배치**: review-check 등 개명 + 구명 별칭·env 별칭 유예. 골든 재캡처 동반.

### 온보딩 본체

- **2차 4단계 — 팩 계약의 자기술화**: `packs/_template/` + 팩 파일별 스키마(`harness/pack-*.schema.json`) + 각 표면에 "온보딩 질문" 메타. 1차 확정 어댑터 표면 = 질문지:
  - "무슨 제품이고, 법적으로 무엇을 말할 수 있나요?" → domain.json + ruleset.json
  - "산출물은 무엇을 만드실 건가요?" → 포맷 선택/신설 + 채널 규격 + active_phases
  - "캐논은 무엇을 주실 건가요?" → canon 변형(조합 단위) + 커버리지 오버레이
  - "브리프 단계에서는 무엇을 주실 건가요?" → WB 템플릿 + ingest/bundle 프로파일 + VOC 소스 + examples + 자산 슬롯
  - "심의에서 무엇이 걸리나요? 무엇으로 증명하나요?" → 축·금지어·실증 정책·필수기재·critic-fragment
  - "외부 연동은 무엇인가요?" → adk_critic 식 env 간접 선언(멀티테넌시 표면)
- **2차 5단계 — 결정적 스캐폴더**: `scripts/new-pack.sh` — 빈 팩 생성. 규약: **전 lexicon 키를 공집합으로라도 명시 생성**(키 부재 폴백 누출 원천 차단), status=tbd, **.env 스탠자를 domain.json 선언에서 기계 생성**(.env.example 드리프트 방지).
- **2차 6단계 — 온보딩 대화**: `/onboard-pack` 스킬(셸 1급 경로의 편의 래퍼). 진행 상태는 **pack-lint 결손 리포트가 "다음 질문"을 결정**. LLM 은 팩 파일만 쓰고 검증은 스크립트(생성≠검증 격리).
- **2차 7단계 — 점진 활성화 공식화**: tbd(빈 팩 체험 — placeholder-autopass) → ready(룰엔진-단독) → active(원격 ADK 실심의). 각 전환 최소 요건 = pack-lint 레벨, 전환은 사람 승인.
- **2차 8단계 — 검증 동반물 온보딩**: 위반/통과 예문 인터뷰 → 골든셋 생성, 샘플 WB → fixtures(`build-fixtures --pack`), stub 템플릿 채움 → **팩 적합성 스위트 그린 = "온보딩 완료 = CI 가능"**.
- **2차 9단계 — 실전 검증(인수 테스트)**: health_food(또는 quasi_drug)를 온보딩 플로우만으로 ready 까지.

---

## 부록A. 검증으로 확정된 관통 사실 (계획 근거 요약)

**2부 근거(2026-07-02 조사 — 원계획 승계)**:
- 진입 게이트는 이미 fail-closed(new-run.sh:46-49) — 1단계 본체는 잔여 폴백 11지점 소거.
- `--emit-context` 는 픽스처 기준 결정적(2회 diff 동일) — 프롬프트 조립 골든 실현 가능. run-stage 실엔진 히어독은 도달 불가 죽은 코드.
- drug 오프라인 스텁 현행 동작 = storyboard-plan 에서 escalated(결정적 재현). ursa 런은 insession 실엔진 산출.
- baseline 매니페스트 키 = run-상대경로(소스 이동 자체론 안 깨짐). 깨지는 조건 = 시드 바이트 변화·스냅샷 집합 변화·기본 경로 배선 변경.
- cosmetic 상수 5종 중 `CONSUMER_DECEPTION_SEVERITY_HIGH` 만 팩 lexicon 부재(2단계 커밋 a 근거). `_lex()` 는 키 부재(None)일 때만 폴백 — 빈 배열/맵 명시는 비누출.
- `critic_prompt`·`export_package` 소비처 0건(사문). `regulatory-domains.json` 기능 소비 1경로(레거시 폴백). registry.json:28-29 는 사문 규칙.
- 블록 type 카탈로그 대조 로직은 validate_storyboard.check_blocks 에 기존재 — 완화 = 출처 교체(+무음 폴백 fail-closed 화). 깨지는 곳 = test-components.sh 스키마 grep 단정 2곳뿐.
- verdict.schema engine enum·phase-descriptors/routes 닫힘은 1차 불변이 맞다.

**1부 근거(2026-07-07 실측 추가)**:
- `obs_watch_pid`(obs.sh:80-96)는 이미 30초 하트비트를 찍는다 — O-1 의 본질은 하트비트 부재가 아니라 **블로킹 단일 툴콜**(출력이 완료까지 버퍼에 갇힘). 처방은 호출 표면(스킬)의 백그라운드+폴링.
- `ADK_CRITIC_RETRY` 기본 3(adk_critic.py:170) — 성공 시 조기 종료 루프라 상향의 정상 경로 비용 0.
- 이미지 기본 모델은 이미 flash(image_engine.py:27·:756) — Pro 는 opt-in. O-4 는 코드가 아니라 운영 정책.
- timing.jsonl 은 완료 이벤트 전용(obs_timing 소비 지점 = run-stage.sh:648·kcia-check.sh Pass 완료) — 시작 레코드가 없다.
- image-manifest 증분 기록(자산별 원자, incomplete 마커)은 이미 존재 — 이미지 진행 폴링의 정본으로 쓸 수 있다.

## 부록B. 선행 문서·계획 승계 관계

1. **본 문서가 `pack-refactor-plan.md`(원계획)와 `e2e-operational-findings.md`(관찰 기록)를 승계·대체한다**(2026-07-07 통합, 사람 지시). 두 원본은 `_archive/` 보관 — 0단계 상세 이력과 E2E 증상 원문은 그쪽 참조.
2. `_archive/cleanup-plan.md` 의 "regulatory-domains.json 절대 보존" 판정 승계·해제: 보존 근거 = kcia_engine.py:223 기능 로드(폴백). 2부 1단계가 그 폴백 코드를 같은 커밋에서 제거하므로 근거 소멸 — 순서 의존(코드 제거 선행)만 지키면 모순 없음.
3. cleanup-plan Tier 3 의 "kcia-critic.md + critic_prompt = 별도 정책 리팩터" 판정 승계: 2부 5단계가 그 지정 후속(critic_prompt 실배선 + 화장품 예시 팩 이관 + dangling docs/regulation 참조 해소).
4. `multi-domain-build-plan.md` 관계: 그 계획의 "C 메커니즘"(enum→패턴+레지스트리 대조)을 2부 4단계가 블록 type·deliverable_format 에 복제. 발명이 아니라 반복.
5. `keyvisual-image-safety-fixes-plan.md`(F1·F2·F3) 관계: 코드 완료·E2E 정상 확인 — 본 계획 선결 확인(main 병합)으로 종결. 미검증 잔여 경로(F2 라이브·F3(c) 실효)는 1부 1-7(O-7·O-8)이 승계.

## 부록C. 확정된 결정 (2026-07-02·03 사람 확정 — 승계)

| # | 결정 | 확정 내용 |
|---|---|---|
| 1 | 0단계 번들 전략 | **(a) 합성 번들 커밋 + 베이스라인 재캡처** — 번들 커밋은 c822d2a. **⚠ 재캡처는 c822d2a 에서 누락**(커밋 메시지만 있고 `baseline-manifest.json` 미갱신 → verify-baseline 이 59커밋 stale RED)되어, 2부 선결로 2026-07-07 실제 재캡처 완결(골든 190항목·verify-baseline 그린). |
| 2 | 미추적 `ezderm-relief-provided.webp` | **화장품 시드로 유지·동결**(main 커밋 완료) |
| 3 | 자산 교차 오염 교정 시기 | **1차 7단계 커밋 b**(골든 재캡처 1회 동반) |
| 4 | drug 골든 범위 | **1차 = 현행 escalated 동결** — done-골든은 2차 이월 |

## 부록D. 열린 결정 (1부 — 사람 확정 대기)

> 실행 전 확정 필요. 권고안 채택 시 그대로 진행한다.

| # | 결정 | 선택지 | 권고 | 확정 |
|---|---|---|---|---|
| D-1 | `ADK_CRITIC_RETRY` 기본값(현행 3) | 6 / 8 | **8** — E2E 실측 안정값(우루사 pharma 통과), 성공 시 조기 종료라 정상 경로 비용 0 | 대기 |
| D-2 | 실런 이미지 표준 모델 정책 | Pro 유지 + 순차 1런 규율 / 기본 flash 로 회귀 | **Pro 유지 + 순차 규율** — BM 디자이너 핸드오프 품질 전제. 코드 기본은 이미 flash(불변) | 대기 |
| D-3 | glue-risk 가드에 장식 번호 예외 | 예외 신설 / **예외 없음**(저작 규칙만) | **예외 없음** — 우회 악용 여지, 프롬프트 저작 규칙으로 충분 | 대기 |
| D-4 | 반영강제 done 게이트 완화 | doc-id 존재성으로 완화 / **현행 유지** + 동반 갱신 유도 | **현행 유지** — 판정문 원문주의(반영 실효성) 훼손 방지 | 대기 |

## 고지

본 산출물 계획은 법적 통과 보증이 아니라 자율·비법적 사전 점검 체계의 개선 계획이다. 최종 책임은 사람(현업/RA)에게 있다.
