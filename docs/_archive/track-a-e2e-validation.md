# 트랙 A — 팩 분리 실전 검증 (메인=감독관 + 현업 게이트 대행)

> 이 파일은 **트랙 A 전문**이다. 병렬 오케스트레이션(`parallel-run.goal.md` — 7차 정리로 `core/docs/_archive/` 이동)이 이 파일을 Read 해
> 트랙 A로 띄운다. 실행 위치 = **primary 작업트리(현재 디렉터리, main 브랜치)**. 코드를 고치지 않는다.
> 서브에이전트 2개는 **둘 다 model: sonnet**. 실제 런 2건을 done 까지 실행시키며,
> (1) 팩 분리(core=도메인-중립 커널, packs/=도메인 데이터 SSoT)가 실전에서 분리 전과 동등하게 작동하는지,
> (2) 사람이 결정할 일(승인·선택·결손)과 심의기관(원격 ADK) 같은 것이 빠졌을 때 **하네스가 멈추고
> 물어보는지**(조용히 넘어가면 결함)를 검증한다.

## 준비 (검증 시작 전 필수)
1. `core/AGENTS.md` 와 `core/docs/workflow-ssot.md` 를 읽고 파이프라인·게이트 규칙을 파악한다.
2. 사전 점검(하나라도 실패 = 시작 전 보고하고 중단):
   - 이 작업트리가 main 이고 클린. **검증 내내 core/·packs/ 추적 파일을 수정하지 않는다**(발견은 기록만).
   - `.env` 자격: `python3 core/scripts/lib/adk_critic.py resolve --domain cosmetic` 와 `--domain drug` 가
     둘 다 원격 ADK 사용 가능으로 나오는지, `NANOBANANA_API_KEY` 존재하는지.
   - `HARNESS_OFFLINE`/`HARNESS_CLI=stub` 이 환경에 없어야 한다(온라인 실엔진 검증이다).
   - 입력 존재: `/Users/chabh/Documents/temp/`(워킹백워드 docx·제품이미지.webp·PNK 결과보고서 pdf·쿠팡/올영
     크롤 zip들), `/Users/chabh/Documents/temp3/우루사 최신지견 3rd edition.pdf`, `packs/drug/rtb-writing-guide.md`.
   - run id 충돌 없음(`core/runs/` 확인). 다른 Claude/Desktop 세션이 이 레포를 만지지 않게 한다.
3. 실행은 **순차**(A 완료 후 B) — NanoBanana 쿼터·ADK 동시성·환경 오염 함정 회피.
   (병렬 트랙 B의 오프라인 CI 와는 무충돌; 유일 경합 = 트랙 B 2단계 ADK 카나리 → 그건 트랙 B가 트랙 A 유휴 창에서.)

## 진행 프로토콜 (사람 게이트 검증의 핵심)
- 서브에이전트는 **사람 게이트(승인/선택/결손 멈춤)마다 반드시 멈추고 메인에게 보고**하게 한다.
  메인은 매번 ① 하네스가 실제로 멈춰서 물었는지(run.md "지금 할 일"·gate 상태) ② 물음이 평이한
  한국어인지(내부 용어 노출 = 결함 기록) 확인한 뒤, 현업 대행으로 재개를 지시한다(SendMessage).
- **게이트가 안 묻고 지나가면 그 자체가 FAIL 발견이다** — 즉시 기록.
- 다음 단계 안내는 추측하지 말고 `runs/<id>/run.md` 의 "다음 명령" 한 줄만 따른다.
- 서브에이전트 공통 규칙(프롬프트에 포함): 4동작(생성 run-stage / 심의 kcia-check / 승인·보완·선택
  approve·revise·select / 본다 run.md)만 사용, state.json·verdict.json 손편집 금지, 생성은 insession
  1급 경로(prompts/<stage>.md 지침대로 산출물 작성 →
  `HARNESS_CLI=claude HARNESS_GEN_MODE=insession bash scripts/run-stage.sh <stage> <id>`),
  core/packs 코드·골든 수정 금지, 사람 게이트에서 멈추고 보고.

## 서브에이전트 A (sonnet · 화장품 여러장 · intake 정문)
- `/Users/chabh/Documents/temp/` 폴더를 **통째로 00a-intake 정문에** 넣어 시작한다 — 운영자 수동 라우팅
  금지(분류 제안→승인 관문 검증이 목적):
  `bash scripts/intake.sh /Users/chabh/Documents/temp <run_id> --product "이지덤 뷰티 릴리프" --domain 화장품 --format 여러장`
  (run_id 는 영문/숫자/._- 만, 예: relief-acne-e2e).
- 분류 기대(제안이 이와 다르면 그대로 승인하지 말고 메인에 보고):
  '이지덤 뷰티 여드름 워킹백워드.docx' = working_backwards · '제품이미지.webp' = 자사 product_image ·
  쿠팡/올리브영 크롤 zip = reference crawl(아누아 PDRN·메디힐 마데카소사이드 등 참고 제품) ·
  'PNK-…이지덤뷰티 릴리프 여드름피부사용적합 결과보고서.pdf' = **evidence 시험성적서(test_report) intent**.
- **PNK 결과보고서 추적이 A의 핵심 관찰 포인트다**: 기대 경로 = 00a 시험성적서 분류 제안 → 사람 승인
  → 00e 에서 스펙 초안(시험기관·참여자수 n·시험기간·지표 수치·전후사진 페이지) **kind:"test_report" 제안**
  (일반 kind 로 강등 제안하면 하네스가 거부해야 정상 — 강등 시도 금지) → 승인 → 추출·승격 → 최종 임상 TEST
  섹션(차트 + 전후사진 페어)에 반영. 각 지점에서 어떻게 제안되고 쓰이는지 기록.
- 릴리프만 자사 화장품이다 — 다른 이지덤 제품은 참고 소개 수준을 넘으면 안 된다.
- done 까지. 키비주얼 직전 이미지 최종 점검(결손 digest)이 뜨면 멈추고 보고(임계 결손 멈춤 = 물어보는 동작이
  작동한 증거; HARNESS_ACK_GAPS 는 메인 지시 없이 쓰지 않는다).

## 서브에이전트 B (sonnet · 의약품 여러장)
- 워킹백워드 = `/Users/chabh/Documents/temp3/우루사 최신지견 3rd edition.pdf`. 우루사는
  **대웅우루사·복합우루사·우루사정 3품목**이다(다품목 구분 유지).
- 제품 이미지는 리서치해서 확보(대웅제약 공식 자료 우선)한 뒤, temp3 원본은 건드리지 말고 스크래치 폴더에
  [PDF + 이미지]를 모아 intake 정문으로 넣는다(--domain 의약품 --format 여러장).
- `packs/drug/rtb-writing-guide.md` 의 RTB 작성 지침(7축·좋은/나쁜 예시·금지표현)을 컨셉/스토리보드 작성 시
  준수한다. **필수기재(주의문구)는 brief 단계부터** 챙긴다(ADK 가 이른 단계부터 요구함).
- done 까지. 완료 후 최종 산출물에서 금지표현 grep = **0건**임을 스스로 증명해 보고.

## 메인 감시 체크리스트 (각 런 진행 중 + 완료 후)
[팩 분리 검증]
- **P1 심의 근거 = 팩**: verdict/피드백이 해당 도메인 ruleset 축을 인용하는가(A=화장품 4축,
  B=drug 축+mandatory_inclusion 필수기재). 반대 도메인 축 인용 = FAIL.
- **P2 교차오염 0**: A 산출물에 우루사/UDCA/간기능 없음 · B 산출물에 화장품 어휘(쿠션·미백 등)와
  화장품 이미지 유입 없음(작년 결함: 화장품 product-main.jpg 가 drug 주 이미지로 샌 것 — 회귀 확인).
- **P3 core/packs 추적 파일 무변경**(런 산출물은 runs/ 에만). 완료 후 git status 로 증명.
- **P4 이미지 규약**: 최종 HTML `<img>` 가 자사 자산·generated/ 만 참조, 크롤 원본(bundle/images) 금지,
  **상대경로 깊이가 실제로 해석되는지**(../ 갯수 함정 — 렌더된 파일 기준으로 존재 확인).
[물어보는 동작 검증]
- **Q1 intake 승인 관문**: 분류표 승인 전 진행 불가·unknown 잔존 시 approve 거부.
- **Q2 00e 스펙 승인 관문(A)**: 승인 전 하류 진행 불가(spec_status pending 해소 필수).
- **Q3 select/approve 게이트**: 생성 직후 심의가 먼저 돌지 않는다(사람 선택/승인 뒤 심의).
- **Q4 이미지 최종 점검**: 결손 digest 표출·임계 결손이면 멈춤.
- **Q5 심의기관 누락 네거티브 프로브**(A 런의 첫 심의 게이트 도달 시 1회): state.json·verdict 를 백업해
  두고, 서브셸에서 URL env 만 비워 `ADK_COSMETICS_CRITIC_URL= bash scripts/kcia-check.sh <A_run_id>` 실행
  → **설정오류로 멈추고 이유를 말하는지**(조용한 강등/통과 = FAIL) 확인 → 파일 무변조 diff 확인 →
  정상 env 로 실제 심의 재실행.
- **Q6 심의 실증**: verdict.json 의 critic_ran=true · engine=adk-http · review_depth 정상,
  `.logs/timing.jsonl` 에 Pass-A/B 기록(bash scripts/timing.sh <id> 로 요약 수집).
[운영 화면]
- **O1 운영 화면**: run.md·게이트 문구가 평이 한국어(내부 코드 미노출)인지 표본 기록.

## 실패 처리·금지
- 결함 발견 = 즉시 기록하되 런은 가능한 한 계속(막힌 경우만 해당 런 중단 후 다음으로).
- 어떤 경우에도: 코드/골든/팩 수정 금지, state.json 손편집 금지, HARNESS_ACK_GAPS·stub 강제 금지,
  temp/·temp3/ 원본 수정 금지.

## 최종 보고서 (필수 산출)
체크포인트 매트릭스(P1~P4·Q1~Q6·O1 × A/B — PASS/FAIL/해당없음 + 증거 파일 경로), PNK 결과보고서의
여정 서술(분류→스펙→승격→최종 반영), B의 RTB 7축 준수·금지표현 0 증명, 발견 결함 목록(심각도·재현 경로),
그리고 "팩 분리가 실전에서 분리 전과 동등하게 작동하는가"에 대한 종합 판정.
