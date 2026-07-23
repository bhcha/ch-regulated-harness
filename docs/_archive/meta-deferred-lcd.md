# 메타프롬프트 (나중에) — 반-병렬 · 병렬불가 항목

> 이 문서는 **Track B(K-1~K-5)와 파일이 겹쳐서 지금 병렬로 돌리면 안 되는 항목**의 실행 메타프롬프트다.
> 병렬 가능분(C-1·L-2·D-1)은 `meta-parallel-lcd.md` 에 따로 있다.
> 규칙 정본 = `core/AGENTS.md` · 조사 원문 = `core/docs/maintainability-refactor-plan.md`.
> 공통 규율(값 불변·골든 4종·선재 CI 4건·커밋 분리·단위 Codex 리뷰·workflow-ssot 동반 갱신)은 Track B 와 동일.

---

## 파트 1 — 반-병렬 (파일 소폭 겹침 → 순서/조율 필요, main 통합 후가 안전)

### L-1. 실행 기록(provenance) 신설 — `.logs/provenance.jsonl`
> 출처: maintainability-plan 4장 L5 판정 · 6장 L-1. **채택(이득/비용 최고)** — 규제 감사 추적과 정합.

- **왜 반-병렬**: `obs.sh` 를 확장하는데, **Track B K-2 가 같은 `obs.sh` 의 watchdog(obs_watch_pid) 을 통합**한다 → 같은 파일 충돌.
- **착수 조건**: Track B 의 **K-2(4단계)가 kernel-track 에 병합된 뒤**(또는 최소한 K-2 가 obs.sh 를 확정한 뒤). 그 전엔 별 브랜치로 만들어 두더라도 머지 시 obs.sh 충돌을 각오.
- **할 일**: `obs.sh` 확장 — 런 시작·생성·심의 시점에 `.logs/provenance.jsonl` 1줄 append:
  `{ts, step, engine, model(확인 가능 시), git_sha, prompts_sha256(테스트 골든 해시 재사용), effective:{GEN_TIMEOUT,CRITIC_TIMEOUT,CLAUDE_FLAGS,IMAGE_CLI,...}}`.
  - `.logs` 는 골든 제외 경로(baseline.py SKIP_PREFIX) → **골든 바이트 무영향**. run.md/현업 표면 **비노출**(내부 진단 전용).
- **검증·DoD**: `test-observability.sh` 확장 · 실런 1회에서 provenance.jsonl 에 git_sha·엔진·유효 플래그 기록 확인 · 골든 2종 바이트 불변 · 선재 4건.

### D-2. 문서 동기 최소 기계화 (env 정합 테스트)
> 출처: maintainability-plan 6장 D-2(선택·저우선). **M-1 확정 후 재평가**.

- **왜 반-병렬**: 신규 소형 테스트라 **K-5(테스트 위생)와 소폭 겹침** + D-1(M-1) 확정에 종속.
- **착수 조건**: D-1(M-1) 확정 후 + K-5 완료 후(테스트 재배치와 충돌 회피).
- **할 일**: env 노브가 `AGENTS.md 2번 절`·`.env.example` 에 존재하는지 grep 하는 소형 정합 테스트(S4 "전부 사람 기억"의 부분 기계화). 예: `.env.example` 에 `HARNESS_GEN_TIMEOUT` 부재 같은 비일관 검출.
- **검증·DoD**: 신규 테스트 그린 · 기존 CI 무영향 · 선재 4건. 비용 대비 효과 낮으면 보류 기록 후 스킵.

---

## 파트 2 — 병렬불가 (Track B 핵심 파일 정면 충돌 → 반드시 Track B 완료·main 통합 후)

### A-DEF-1 · A-DEF-2 — intake 정문 결함 수정
> **상세 실행계획은 이미 작성됨: `fix-plan-intake-defects.md`(레포 루트).** 이 파트는 그 문서를 가리키는 포인터다.

- **왜 병렬불가**: `scripts/gate.sh`(K-2) · `scripts/lib/ingest.py`(K-1·K-3) 를 수정해야 하는데, **Track B 의 K-1·K-2·K-3 이 정확히 그 파일들을 이동·배선** 중 → 겹친 채 진행하면 "회귀 원인 판별 가능"(커밋 분리 규율)이 깨진다.
- **착수 조건(그 문서 0단계와 동일)**: 트랙 A(E2E) 완료 + **Track B(cleanup/kernel-track)가 main 병합된 뒤**, 최신 main 위에서. 결함별 독립 브랜치(`fix/intake-domain-plumbing` → `fix/wb-multi-sku-scoping`).
- **요약**(상세는 fix-plan 참조):
  - **A-DEF-1(High)**: 온라인 intake 정문의 `gate.sh` apply 훅이 `ingest.py` 전에 `HARNESS_DOMAIN` 미export → 모듈로드 die. 수정 = gate.sh 훅 배관(resolve_domain→export) + ingest.py `_PROFILE` lazy화 + env 없는 테스트.
  - **A-DEF-2(Med-High)**: 다품목 WB 스코핑 정규식이 `제품명:/제품유형:` 마커만 인식 → 헤딩+표 문서에서 조용한 전체-WB 폴백 → 상류 오염. 수정 = 조용한 폴백 제거·가시화 + 헤딩 경계 인식 + claim-basis SKU 태깅.

---

## 실행 순서 (전체 조망)

```
[지금 병렬 가능]  meta-parallel-lcd.md : C-1 ∥ [M-2]L-2 ∥ [M-1]D-1     (Track B 와 동시)
        ↓
[Track B K-2 병합 후]  L-1(obs.sh)                                   (이 문서 파트1)
[Track B 완료·main 통합 후]  A-DEF-1 → A-DEF-2                         (fix-plan-intake-defects.md)
[D-1(M-1)·K-5 후]  D-2                                               (이 문서 파트1)
```

## 하지 않는 것
- 위 착수 조건(Track B 관련 파일 확정/병합) 전에 이 문서 항목 착수 · Track B 브랜치에 섞어 커밋 ·
  골든 재캡처(값 불변 유지) · hooks/MCP 도입 · state.json 손편집.
