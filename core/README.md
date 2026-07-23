# 홍보/상세 자료 생성 자동화 하네스 — 5분 시작 가이드

> 규제 대상 제품(**화장품·의약외품·건기식·의약품**)의 홍보/상세 자료를 **파일 기반 단계 게이트**로 생성합니다.
> 제품·규제도메인·포맷은 사람이 선언합니다. (아래 예시는 화장품 PoC 샘플 — 이지듀 쿠션 번들 — 을 사용합니다.)
> 비개발 현업은 **4동작**(본다·생성·승인/보완·선택)만 사용합니다. JSON 손편집은 하지 않습니다.
> 본 산출물은 **법적 통과 보증이 아니며 자율·비법적 사전 점검**입니다.

## 0. 준비 (1회)
```bash
bash scripts/sync-skills.sh            # 슬래시 편의 래퍼 배포(선택)
# 엔진 선택: 기본 stub(오프라인·결정적). 실 LLM 사용 시(헤드리스 파일쓰기 권한 플래그 포함):
#   export HARNESS_CLI=claude           # 생성 (claude -p --permission-mode acceptEdits 자동)
#   심의 = 원격 ADK(adk-http) 단일 — packs/<도메인>/domain.json 의 adk_critic 블록이 가리키는 env(예 화장품 ADK_COSMETICS_CRITIC_URL) 설정(.env). 로컬 헤드리스 크리틱(KCIA_CRITIC_CMD)은 폐기.
```
> **서버/타인 배포**: 환경변수·의존성·네트워크·심의 경로는 [`../docs/reference/deployment.md`](../docs/reference/deployment.md) 참조. 키는 `.env`(`cp .env.example .env`)로 주입하며 **절대 커밋하지 않습니다**.

## 1. 브리프 — ⓪ 유형 선언(가장 먼저) → 번들 인입
```bash
# ⓪ 산출물 유형을 가장 먼저 선언한다(필수): 규제도메인 + 포맷.
bash scripts/new-run.sh my-product-2026 --domain 화장품 --format 여러장
#   --domain 화장품|의약외품|건기식|의약품   --format 한장|여러장|홈페이지  (홈페이지=의약품 등 정보성 brandstory)
bash scripts/ingest-bundle.sh <크롤번들폴더> my-product-2026   # 예(테스트): tests/fixtures/bundle-cosmetic
```
→ `runs/my-product-2026/inputs/`(원시 입력 스냅샷: `bundle/`·`assets/`·`working-backwards.md`·`examples/`) + `runs/my-product-2026/00-ingest/`(가공물: voc·claim-basis·assets-manifest·best-practices·bundle-report) 생성. 공유 `inputs/`(씨앗 소스)는 그대로 두고 ingest 가 런으로 스냅샷한다.
유형 미선언 시 ingest 가 친절히 중단한다(cosmetic 자동 적용 없음).
유사사례를 `inputs/examples/<도메인>/<...>/` (동일 도메인만)에 모으면 인입 후 **유사점 3안**(`00g-guideline`) 단계가 자동 삽입된다.

## 2. 진행 루틴 (반복)
```bash
cat runs/my-product-2026/run.md        # ① 본다: "지금 할 일"
# ② 안내된 명령 1개 실행 (예시):
bash scripts/run-stage.sh brief my-product-2026     # 생성
bash scripts/kcia-check.sh my-product-2026          # 심의
# ③ 산출물 파일을 연다 (예: 01-brief/brief.md)
# ④ 승인/보완/선택 (JSON 손대지 않음):
bash scripts/approve.sh my-product-2026             # 승인
bash scripts/approve.sh my-product-2026 --ra-ok    # 기능성 '승인' 표시 브리프는 RA 확인 후 승인
bash scripts/revise.sh  my-product-2026 "이 표현 빼줘"  # 보완
bash scripts/select.sh  my-product-2026 B            # 선택(다안)
```
`run.md` 가 항상 **다음에 칠 명령 1개**(필요 시 `--ra-ok` 포함)를 알려줍니다.
> 디자인(04) 단계는 `run-stage.sh keyvisual` 가 로컬 Playwright 렌더·섹션 캡처를 자동 수행하고, 선택→승인의 **2중 게이트**를 거칩니다.

## 3. 단계 흐름
`브리프[⓪유형선언 · ①인입 · ②유사사례 · ③유사점3안 · 정리] → 컨셉 → 스토리보드 → 키비주얼 → 완료`
- **브리프**: 유형 선언(도메인+포맷) → 워킹백워드·번들 인입 → (사례 있으면)유사점 3안 현업 확정 → PR/FAQ 정리(확정 느낌 반영).
- 각 단계: 생성 → 심의 → (다안이면 선택) → 사람 승인. 유사점/컨셉/스토리·톤/디자인은 **다안 선택**.

## 4. 막혔을 때
- **escalated 배너**가 뜨면: 표현을 직접 고치거나, 심의 예외 판단, 또는 상한 상향
  `bash scripts/run-stage.sh raise-limit <id>`.
- 잘못된 명령/선택값은 친절한 한국어로 반려됩니다.
- 다른 PC/CLI 에서 같은 `runs/<id>` 로 **이어서** 진행할 수 있습니다(완료 단계 재생성 안 함).

## 5. 협회 자문 패키지
완료 시 `runs/<id>/04-keyvisual/export/kcia-package/` 에 시안 PNG + 근거 목록 + 매체 구분이 생성됩니다.
실증 근거는 OpenAlex 직접 HTTP 실연동으로 모읍니다(온라인=실검색 · 오프라인 CI[`HARNESS_OFFLINE=1`]=결정적 stub). 온라인에서 네트워크/엔진 오류는 조용한 stub 강등 없이 fail-closed 로 멈춥니다(무음 강등 금지). OpenAlex 결과는 검증 전 발견 후보라 자동 인용되지 않고, grade/출처 표기와 함께 제출하되 채택 여부는 사람(현업/RA)이 판단합니다.

## 고급 (개발)
- **문서·구조 총지도(어디에 무엇이 있는지)**: [`../docs/README.md`](../docs/README.md) — 기능·팩·프롬프트·인터페이스·테스트·문서·설정 축별 조회 정본으로 안내.
- 계약 스키마: `harness/*.schema.json`, 매핑 `harness/registry.json`.
- 결정적 CI: `bash tests/run-ci.sh` (스키마·이식성·재개·동시성·골든셋·추출정확도).
- 상세 설계: `../docs/reference/harness-design.md` · 사용가이드: `../docs/reference/user-guide.md`.
