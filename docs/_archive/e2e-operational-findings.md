# E2E 운영 신뢰성 결함 발견 (반복 운영 관점)

> **♻️ 아카이브(2026-07-07):** O-1~O-9 의 처방은 [`../ops-and-pack-refactor-plan.md`](../ops-and-pack-refactor-plan.md)(통합 실행 계획) **1부**로 승격·승계됐다. 이 문서는 E2E 증상·실측 원문의 보존용 — **현행 작업의 SSoT 아님.**

> 작성 2026-07-07. **실폴더 E2E 2건**(릴리프 `ezderm-relief-verify-0707` 화장품 intake · 우루사 `ursa-drug-verify-0707` 의약품, **둘 다 phase=done 완주**)을
> 실 엔진(Nano Banana Pro)·실 원격 ADK 심의로 끝까지 돌리며 드러난 **반복 운영 시 재발할 문제**의 기록·처방 SSoT다.
> 선행 = `keyvisual-image-safety-fixes-plan.md`(F1·F2·F3, 커밋 `7c7f49a`). 그 코드 수정은 실런에서 **정상 작동**했고(아래 "정상 확인" 절),
> 여기 담는 것은 **코드 결함이 아니라 운영 UX·설정·구동 표면의 재발성 문제**다. 처방은 후속 개선계획으로 승격 가능.

## 우선순위 요약

| # | 심각도 | 분류 | 제목 | 한 줄 |
|---|---|---|---|---|
| O-1 | **HIGH(운영차단)** | 구조 | 긴 심의 ↔ 600초 스트림 watchdog 충돌 | 정당하게 오래 걸리는 심의가 insession 구동자를 죽인다 |
| O-2 | **HIGH(설정)** | 설정 | `ADK_CRITIC_RETRY` 기본 3 = pharma 엔드포인트엔 부족 | 의약품 ADK 첫턴 빈응답이 기본 재시도를 소진 → fail-closed 반복 |
| O-3 | MEDIUM(관측) | 구조 | 긴 생성 중 진행신호 부재 → 정체 오인 | timing·run.md 가 단계 완료 시에만 갱신 |
| O-4 | MEDIUM(자원) | 설정 | Nano Banana Pro 429 쿼터 소진 잦음 | 반복·동시 운영 시 실병목 |
| O-5 | MEDIUM(저작) | 상호작용 | CSS `::before{content}` ↔ 제품명 glue-risk 가드 | 번호 뱃지를 CSS 카운터로 넣으면 fail-closed |
| O-6 | MEDIUM(게이트) | 상호작용 | ADK 강제 rewrite ↔ 반영강제 done게이트 드리프트 | 근거-연결 카피 revise 시 plan↔HTML 어긋남 |
| O-7 | LOW(미검증) | 커버리지 | F2(Pro 400→fallback) 라이브 미발동 | 이번 런은 429만 발생, 400 경로는 단위테스트로만 검증 |
| O-8 | LOW(미검증) | 커버리지 | F3 Pillow 규격화(c) 실효 미확인 | 크롭 정본은 CSS(a), Pillow(c)는 근사 일치 시 no-op |
| O-9 | LOW(수명주기) | 구동 | 서브에이전트 transcript 유실·정책차단·연결끊김 | 장시간 서브에이전트 구동의 Claude Code 측 취약 |

---

## 구조적으로 재발하는 문제 (거의 매 런)

### O-1. 긴 심의 ↔ 600초 스트림 watchdog 충돌 (HIGH)

**증상(실측)**: 화장품 서브에이전트가 03-storyboard plan 심의를 포그라운드로 돌리다 **"no progress for 600s (stream watchdog)"** 로 종료. plan·keyvisual 심의는 블록이 많고 원격 ADK 다중 패스(Pass-A + 블록별 Pass-B)라 **정상적으로 600초에 근접**한다.

**근본원인**: `KCIA_CRITIC_TIMEOUT` 기본이 600초(심의 1회 하드상한)인데, insession으로 구동하는 에이전트를 감싼 스트림 watchdog도 600초 무출력이면 stall 로 종료한다 → **"정당하게 상한 근처까지 걸리는 심의 = 구동자 사망"**. 두 상한이 같은 값이라 경합한다.

**처방**:
- 4동작 스킬(`skills/kcia-check` 등)에 **백그라운드+폴링**을 기본 내장 — `kcia-check.sh` 를 백그라운드로 띄우고 30~45초마다 상태 폴링해 스트림을 살린다(이번에 수동으로 쓴 우회를 표준화).
- 또는 `kcia-check.sh` 가 진행 하트비트를 **stdout** 으로 흘리게 한다(현재 `KCIA_CRITIC_HEARTBEAT` 는 있으나 insession 구동자에게 안 보이는 채널일 수 있음 — 확인 필요).
- 또는 스트림 watchdog 상한을 `KCIA_CRITIC_TIMEOUT` 보다 넉넉히 크게(예 심의 상한 600 + 여유).

### O-3. 긴 생성 중 진행신호 부재 → 정체 오인 (MEDIUM)

**증상(실측)**: `runs/<id>/.logs/timing.jsonl` 과 run.md 는 **단계 완료 시점에만** 갱신된다. insession 생성(스토리보드 plan 12블록 작성)·이미지 생성(Pro 10~14장, 분 단위)이 도는 동안 무이벤트라 **멈춘 것처럼 보인다**(코디네이터가 실제로 "1시간 정체"로 오판 후 프로세스 점검으로 살아있음 확인).

**근본원인**: 진행 관측이 "완료 이벤트" 단위뿐. 진행 중(in-flight) 신호가 없다.

**처방**: 생성·이미지 단계에 **진행 하트비트**(예 "plan 블록 7/12 작성", "이미지 5/10 생성")를 timing 또는 별도 진행 파일로 흘린다. run.md digest 가 그것을 표면화.

### O-4 / 키비주얼 이미지 장시간 블로킹 (MEDIUM)

**증상(실측)**: 키비주얼 이미지 생성이 `run-stage.sh keyvisual` **단일 호출**에 묶여 Pro 10~14장 + 429 백오프로 수 분~십수 분 블로킹. insession에선 스트림을 막거나(watchdog·O-1) 백그라운드로 돌리면 서브에이전트가 멈춰(재개 필요) 매끄럽지 못하다. **매 실런 키비주얼에서 재발**.

**처방**: O-1 처방(백그라운드+폴링 표준화)과 동일 계열. 이미지 생성 진행 하트비트(O-3) 병행.

---

## 설정·튜닝 갭 (그대로 두면 반복 실패)

### O-2. `ADK_CRITIC_RETRY` 기본 3 = pharma 엔드포인트엔 부족 (HIGH)

**증상(실측·우루사)**: 원격 pharma ADK(`pharma-agent-…run.app`)가 plan·keyvisual 심의에서 **"빈 모델 텍스트(첫 턴 flaky)"** 를 지속 반환. 기본 재시도 3회를 소진 → `KCIA_CRITIC_REQUIRED=1`(구현 도메인 자동설정)이라 **fail-closed 로 멈춤**. 같은 엔드포인트가 30분 전 brief·concept 는 정상 처리했으므로 **엔드포인트 첫턴 flakiness**(콘텐츠 문제 아님). `ADK_CRITIC_RETRY=8` 로 올리니 안정적으로 응답을 받아 통과.

> ⚠ 하네스 동작 자체는 **정상**이다 — 조용한 강등 없이 fail-closed 하고 "✋ … `*_CRITIC_URL` 확인 … 강등 금지" 를 안내했다(사용자가 검증하려던 "심의기관 문제 시 하네스가 알리는가" 가 정확히 작동). 문제는 **기본 재시도값**이다.

**근본원인**: `ADK_CRITIC_RETRY` 기본(빈응답 재시도)이 이 엔드포인트의 첫턴 flakiness 빈도에 비해 낮다.

**처방**: 기본 `ADK_CRITIC_RETRY` 상향(예 6~8) 또는 **도메인/엔드포인트별 재시도 프로파일**. `.env`·`domain.json adk_critic` 에 per-endpoint retry 를 두는 것도 방법. 근본은 엔드포인트(Gemini/Cloud Run) 첫턴 빈응답 자체를 확인.

### O-4. Nano Banana Pro 429 쿼터 소진 잦음 (MEDIUM)

**증상(실측·양 런)**: 두 런 모두 `gemini-3-pro-image` 429(쿼터)를 다회 발생. P-1 지수백오프가 구제해 완주(화장품 9/9·의약품 6/6, incomplete 없음)했으나 매 소진마다 백오프(기본 15·30·60초)로 수 분 지연. **동시 2런은 공유 쿼터라 압박 2배**.

**근본원인**: bake-all(전 사진 블록 Pro 생성) × 실 쿼터 한도. 계획서 P-5 도 "Pro 쿼터 소진 잦음 → 기본 flash 강등" 언급.

**처방**: 반복·동시 운영이면 기본 강등 다이얼을 flash 쪽으로(`HARNESS_NANOBANANA_FALLBACK_MODEL`) 또는 동시 런 수 제한. 쿼터 상향이 근본.

---

## 저작·게이트 상호작용 재발 패턴

### O-5. CSS `::before{content}` ↔ 제품명 glue-risk 가드 (MEDIUM)

**증상(실측·우루사)**: 키비주얼에서 번호 뱃지를 CSS `::before{content:"01".."12"}` 로 넣자, 하네스의 제품명 glue-risk 가드가 **생성 텍스트(숫자/문자)가 제품명 매칭을 가리거나 확장할 수 있다**고 판단해 fail-closed(필수기재 "정확한 제품명" 검증 불가). 실 DOM `<span>` 텍스트로 교체 후 통과.

**근본원인**: 필수기재 제품명 검증(`_name_present`/`_has_gluing_generated_content`)이 CSS 생성 콘텐츠를 신뢰 불가로 처리(정당한 방어). 하지만 CSS 카운터/`::before` 번호는 **흔한 저작 패턴**이라 반복 저촉.

**처방**: `prompts/keyvisual.md` 에 "번호·라벨은 CSS `content` 가 아니라 실 DOM 텍스트로" 명시. 또는 가드가 필수기재 영역 밖 장식 번호는 예외 처리(주의: 우회 악용 여지 검토).

### O-6. ADK 강제 rewrite ↔ 반영강제 done게이트 드리프트 (MEDIUM)

**증상(실측·화장품)**: ADK 통과를 위해 키비주얼 HTML 카피를 ADK 수용 표현으로 바꾸자, done 전이의 **반영강제 게이트**(`check_evidence_reflection`)가 doc-01 미반영으로 막힘 — plan 블록 07의 claim `target_text`·각주 probe(옛 판정문)와 최종 HTML이 어긋남. plan 블록의 claim/각주를 ADK 수용 표현으로 정렬해 두 게이트를 동시 충족.

**근본원인**: 근거-연결 카피를 심의 통과 목적으로 revise 하면, plan(claim↔각주)과 최종 HTML(reflected_in) 사이 정합이 깨질 수 있다. 두 게이트(심의 · 반영강제)가 서로 다른 문자열을 본다.

**처방**: revise 시 plan claim/각주와 옵션 HTML을 **함께** 갱신하도록 4동작/프롬프트가 유도. 또는 반영강제 게이트가 "판정문 원문 부분문자열" 대신 doc-id 참조 존재성으로 완화(주의: 반영 실효성 약화 트레이드오프).

---

## 아직 검증 안 된 채 남은 경로

### O-7. F2(Pro 400→fallback) 라이브 미발동 (LOW)

이번 런들은 Pro가 **400(INVALID_ARGUMENT)이 아니라 429(쿼터)** 를 냈다. F2의 400→`NanoBananaModelRejected`→fallback 경로는 **단위테스트(`test-image-engine` 6e)로만** 검증됐고 실런에서는 안 탔다. 실환경에서 Pro 400이 재현되면 그때 처음 라이브 검증된다.

### O-8. F3 Pillow 규격화(c) 실효 미확인 (LOW)

크롭 제거의 정본은 CSS 자연비율(a)이고, Pillow 패드(c)는 생성 aspect가 목표와 **허용오차 내 근사면 no-op**다. 이번 런에서 (c)가 실제로 패드를 수행했는지(생성 aspect가 목표와 충분히 어긋났는지)는 확인하지 못했다(서브에이전트 크롭 문제 보고 없음). 다양한 aspect가 실제로 나오는 조건에서 (c) 실효 확인 필요.

### O-9. 서브에이전트 수명주기 취약 (LOW·구동)

장시간 서브에이전트 구동에서 **transcript 유실(재개 불가)·API Usage Policy 차단(대용량 의학문서 컨텍스트 누적)·connection dropped**가 각 1회씩 발생. 하네스가 아니라 Claude Code 서브에이전트 측 이슈지만, 반복 운영 시 재발 가능 — **경량 컨텍스트 유지**(대용량 원문 재읽기 금지)와 **harness 상태 기반 이어받기**(새 에이전트가 state.json 지점부터 재개)로 완화된다(이번에 그 방식으로 둘 다 done 완주).

---

## 정상 확인 (재발 문제 아님 — 기준선 기록)

- **F1(C) 규제 게이팅**: 실런 양 도메인 검증. 화장품=그래픽 블록 굽되 옵션 HTML 미참조(격리) · 의약품=그래픽 6블록 전부 미생성(사진 6블록만), `check_render_refs` 양 렌더패스 확인. 원래 결함(그래픽 블록에 FDA·1위·오수치 환각)이 규제도메인에서 재현 안 됨.
- **P-1 부분실패 내성**: 증분 매니페스트(incomplete 마커)→최종본 전환, 429 다회에도 완주.
- **실 심의 실질성**: ADK가 스스로 실이슈 반복 발견(국내최초·근거없는주장·고지누락·기능성 오인)·suggested_rewrite 제시. placeholder-autopass 아님(`critic_engine=adk-http`).
- **fail-closed 정직성**: ADK 장애 시 조용한 강등 없이 중단·안내.
- **PNK 근거 경로**: 00a 시험성적서 분류 → 00e 스펙 → doc-01 승격 → 추출 전후사진 + 차트 → 최종 임상 TEST 섹션 반영, 협회 패키지에 원본 PDF 첨부.

## 후속 조치 권고 (우선순위)

1. **O-1 · O-2 먼저** — 운영을 실제로 막았던 둘. (a) 4동작 심의를 백그라운드+폴링/하트비트로 표준화, (b) `ADK_CRITIC_RETRY` 기본 상향 또는 도메인별 프로파일.
2. **O-3 · O-4** — 관측 하트비트 + Pro 쿼터/강등 다이얼·동시성 정책.
3. **O-5 · O-6** — 프롬프트·게이트 미세 조정(저작 가이드 + revise 시 plan↔HTML 동반 갱신).
4. **O-7 · O-8** — 라이브 커버리지 보강(400 유발 조건·다양 aspect 조건 확보).

## 고지

본 문서는 실 E2E 2건의 운영 관찰 기록이다. O-1~O-9 는 코드 결함이 아니라 **운영 UX·설정·구동 표면**의 재발성 문제이며, 처방은 후속 개선계획으로 확정·승격 대상이다(사람 확정).
