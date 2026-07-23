---
name: learn-analyze
description: 학습 루프 — 심의 반려 분석·금지어 승격(사람 승인 필수)
---
# /learn-analyze <도메인> [--k N]

선택·심의 반려가 런을 넘어 축적된 것을 분석해, **일관 반려된 표현을 금지어 후보로 제시**하고
**사람이 승인한 것만** 팩에 기록한다(Seam F 분석+승격). ⚠ **자동 승격 없음** — 승인은 사람(현업/RA)의 몫이다
(크리틱 비결정성이 영구 규칙으로 굳는 것을 사람이 거른다). 이 스킬은 세션 안에서 아래 흐름을 진행한다.

## 흐름
1. **분석(읽기전용)** — runs/ 를 횡단해 (표현, 심의축) 일관 반려를 집계, 노이즈·보편어·핑퐁 필터 후
   일관성 임계(독립 K런, 기본 2) 통과분을 후보로. state 불가침.
   ```bash
   HARNESS_ROOT="$HARNESS_ROOT" python3 scripts/lib/analyze_learnings.py <도메인> --k 2 --out /tmp/learned-proposal-<도메인>.json
   ```
2. **제시** — `learned-proposal.json` 의 후보를 평이한 표로 보여준다: **표현 / 심의 사유 / 유래 런 수 / 적용 단계**.
   보편 단어(팩 common-terms)·크리틱 자기제안 재반려(핑퐁)·1회성 반려는 이미 자동 제외돼 있다.
3. **사람 승인** — 현업/RA 가 승격할 표현을 고른다(전체 또는 일부). **승인 없이는 아무것도 기록하지 않는다.**
   승격이 규제/브랜드에 적절한지는 사람 판단(하네스는 정보 제공까지).
4. **기록(승인분만)** — 스크립트만 팩에 쓴다(1급 경로):
   ```bash
   bash scripts/apply-learnings.sh <도메인> /tmp/learned-proposal-<도메인>.json --approve "<승인 표현들 콤마구분>" --by "<승인자>"
   # 또는 전체 승인: --approve-all
   ```
   → `packs/<도메인>/learned/deny.json` 에 기록(provenance.approved_at 포함). **이후 런부터** 생성 선차단
   (`DOMAIN_GEN_RULES`)+룰엔진 결정 집행(이중)에 반영된다.

> ⚠ 승격 즉시 그 도메인 런의 ctx 골든이 바뀐다(learned 주입) — 승격은 운영 결정이며, 골든 재캡처가 필요하면 사람 승인 게이트를 따른다.
> 슬래시가 동작하지 않으면 위 셸 명령을 순서대로 직접 실행하세요(1급 경로).
