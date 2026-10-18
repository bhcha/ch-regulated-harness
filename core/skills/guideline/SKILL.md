---
name: guideline
description: 크롤 참조 노트 생성 (사례별 분석 → 참조 메모)
disable-model-invocation: true
---
# /guideline — 크롤 참조 노트 생성 · 세션 내 직접 생성(in-session)

> 🛠 **이 명령은 운영자·생성 에이전트용입니다. 현업은 직접 쓰지 않아요** — 현업의 "생성"은 운영자가 대신 `bash scripts/run-stage.sh` 로 실행합니다.

이 스킬은 **지금 이 세션의 에이전트가 직접** 00g-가이드라인(크롤 참조 노트)을 생성한다(헤드리스 `claude -p` 미사용).
산출물만 쓰고 **상태 전이는 스크립트에 위임**한다(state.json 은 절대 건드리지 않는다).

크롤 참조 노트는 **광고 카피가 아니라 다운스트림(컨셉·스토리라인·아웃라인·이미지) 참조 입력**이다(심의 면제, review:false).
정량/구조는 결정적 스크립트가 만들고, **감각 레이어(구도·무드·왜 보기 좋은가)만 세션 내**에서 보강한다(하이브리드).

`<RUN>` = 현재 run_id(대화/인자에서 확인). **사례별 fan-out(한 건씩) + 체크포인트**로 순서대로 수행한다:

1. **입력·지침 로드(읽기전용):**
   ```bash
   bash scripts/run-stage.sh guideline <RUN> --emit-context
   ```
   출력의 `PROMPT_FILE`(= `prompts/guideline.md`)·`EXAMPLE_DIRS`(분석할 동일 도메인 사례 폴더 목록)·
   `build_context` 가 가리키는 입력(VOC · RULESET · REGULATORY_DOMAIN 등)을 **모두 읽는다**.
   `RUN_DIR` 의 `00g-guideline/`(= `<GDIR>`)가 산출물 위치다.

2. **정량 레이어(결정적, 먼저):** 사례별 측정 신호·VOC·구조 베이스라인 + 참조노트 골격을 결정적 스크립트로 **먼저** 만든다.
   ```bash
   python3 scripts/lib/examples_analysis.py <RUN_DIR>/00g-guideline <REGULATORY_DOMAIN> <EXAMPLE_DIRS...>
   ```
   (리뷰 csv·product.json 파싱이 필요한 `signals`/`voc_themes`/`structure` 는 스크립트가 정확히 만든다 — 직접 손계산하지 말 것.)
   결과: `00g-guideline/examples/<example_id>/example-analysis.json`(사례별) + `00g-guideline/reference-notes.json`(종합 골격).

3. **감각 레이어(세션 내, 사례별 한 건씩 — fan-out + 체크포인트):**
   `EXAMPLE_DIRS` 의 각 사례 폴더를 **한 번에 하나씩** 처리한다(원하면 사례당 Task 서브에이전트로 병렬 — 둘 다 세션 내, 헤드리스 아님):
   - 그 사례의 상세 이미지(`images/detail/*`)와 리뷰를 **직접 보고**, `00g-guideline/examples/<example_id>/example-analysis.json` 의
     감각 필드를 스키마(`harness/example-analysis.schema.json`)대로 **보강해 덮어쓴다**:
     - `reference_images[]`: 실제 이미지의 구도/무드를 반영한 `composition_tags`·`mood_tags`(화이트리스트 어휘만) + `why`(감각적 '왜 보기 좋은가').
       `id` 는 `<example_id>#NN`(유일), `src` 는 크롤 사례 경로(`images/detail/...`), `rights` 유지. **디자인 `<img src>`·자사컷으로 재사용 금지**(저작권).
     - `why_good[].grounded_in` 은 반드시 **실재 `signals`/`voc_themes`/`structure` 키만** 인용(fail-closed; 근거 없는 칭찬 금지).
   - **체크포인트/idempotent:** 이미 있고 valid 한 사례(스키마 통과 + 감각 보강 완료)는 **skip**. 중간에 끊겨도 앞 사례는 파일로 보존 →
     재실행 = 진짜 증분 재개(헤드리스 0바이트 전체 재실행과 대비).
   - **어휘 제약(필수):** 효능·기능성·절대/최상급·속효(단 N일만에)·랭킹(N위)·실증/정량 표현을 `composition_tags`/`mood_tags`/`why` 에 **쓰지 마라**
     (`composition_tags`/`mood_tags` 는 순수 구도·무드 화이트리스트 어휘만). 위반 시 validate-stage 가 fail-closed 로 막는다.

4. **종합 최종화:** 사례별 보강이 끝나면 `00g-guideline/reference-notes.json` 을 최종화한다 —
   `flow_refs`(전체 전개 플로우 참조)·`composition_notes`(좋았던 구도/무드)·`notes`(자유 메모). `regulatory_domain` 은 state 와 일치.
   **법(심의 룰셋) > 참조노트:** banned/미승인 기능성·효능·절대 표현을 어떤 필드에도 넣지 마라. **state.json 은 건드리지 않는다. 산출물 파일만 쓴다.**

5. **검증·전이(스크립트가 상태를 쓴다):**
   ```bash
   HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh guideline <RUN>
   ```
   필수 집합(reference-notes + 사례별 example-analysis 전부)의 완전성을 검증하고 다음 게이트로 전이한다(생성 엔진은 신뢰 마커로 자동 감지·기록).
   00g 는 **심의 면제**(review:false)라 승인 뒤 `kcia-check` 가 실제 심의 대신 자동 통과시킨다(승인 직전 금지표현·형식은 재검증).

6. **다음:** `runs/<RUN>/run.md` 의 "다음 명령" 한 줄을 따른다(승인 → 점검은 게이트가 정한다).

> 금지: 이 단계에서 `select.sh`/`approve.sh`/`revise.sh`/`advance-phase.sh` 를 직접 부르지 않는다(게이트 전제 깨짐).
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하라(1급 경로).
