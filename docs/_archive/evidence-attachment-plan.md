# 근거 문서(시험성적서·결과보고서) 첨부 기능 — 작업계획

> 지위: **실행 설계 계획(DESIGN PLAN) · v3**. ⚠ 이 문서는 **설계**이며 코드는 아직 미구현이다(그게 정상) — 아래 F1~F7·N1~N5 는 "구현할 단계"의 명세다. 리뷰는 "코드가 됐나"가 아니라 **"이대로 구현하면 설계가 골든-안전·보안·결정적으로 건전한가"**를 본다.
> 개정 이력: v1 → v2(r1: F1~F7) → v3(r2: N1~N5) → v4(r3: F3·N6) → v5(r4: N7) → v6(r5: N8) → v7(r6: N9) → v8(r7: N10) → v9(r8: N11) → **v10(Codex r9: N11 조건 정확 확인 + N12 positive-completion 을 00-ingest 의 모든 --to 출구[00g-guideline·01-brief]에 적용)**.
> 근거 = 2026-07-03 Claude+Codex 공동 코드조사. 규칙 SSoT = `AGENTS.md`, 현재상태 SSoT = `pipeline-stage-definitions.md`.

## 0. 목표·범위·성격
규제 근거 문서(PDF/이미지/한글·워드 — 예: "이지덤뷰티 릴리프 여드름피부사용적합 결과보고서.pdf")를 입력으로 받아 **최종 협회 광고자문 제출 패키지**(`runs/<id>/04-keyvisual/export/kcia-package/`)에 **첨부 파일 + 목록**으로 실어 나른다. 현재는 00-ingest 에서 소실(공동 조사 확정).

- **v1 범위**: 파일 첨부(원본 바이트 보존·무결성 검증) + 패키지 목록 기재 + (선택) 사람 선언 메타(grade·연결).
- **비범위**: PDF 파싱/OCR/자동 근거추출, 자동 등급판정, 근거-주장 자동 실증매칭.
- **성격(불변 선언)**: **"첨부 전송(attachment transport)"** 이지 **"주장 실증(claim substantiation)"** 이 아니다. 첨부 문서 id 는 심의엔진 실증 evidence 집합에 **절대 편입 안 함**(F5 — `kcia_engine.py:933-955` 가 claim-basis/results 에서만 id 구성, `:303-307` 동결 확인).

## 1. 절대 제약 (위반 시 계획 무효)
1. **골든 바이트 불변(최우선)**: 근거 없을 때 신규 산출물·필드·복사물·디렉터리·state.artifacts 항목이 **절대 나타나면 안 됨**(전면 조건부). ⚠ **증명 한계(F1)**: `baseline.py:100-107` 은 extra 파일을 **경고만** 하고 실패시키지 않음 → "골든 그린"으로는 no-evidence 불변을 증명 못함 → **전용 strict 테스트**(4장)가 본증명. `HARNESS_EVIDENCE_DIR` 은 `run-ci.sh:12-14` env 스크럽에 추가 + `test-evidence-attachment.sh` 를 `run-ci.sh:34` TESTS 배열에 등록.
2. **동결 계약 불변**: `claim-basis.schema.json`·`assets-manifest.schema.json` 미변경. 근거는 **별도 신규 아티팩트**.
3. **결정성(no-LLM)**: 파일명 NFC 정규화 후 정렬·sha256 결정적. **PDF 파싱 없음**.
4. **경로·자원·저작권 안전**: `cp -R` 금지, 단층 열거, 디렉터리·심볼릭 거부, 안전토큰, 파일당·총량 상한. 첨부는 HTML/CSS 참조 안 함(img_lint 무관 — Codex 확인).
5. **생성≠심의 격리 불변**: 첨부는 생성·전이 쪽, 실증 게이트 미편입.
6. **문서 동반 갱신**: `workflow-ssot.md`·`pipeline-stage-definitions.md` 갱신(AGENTS 4번 절).
7. **로컬 검증기 한계(N5)**: `harness.py:164-170` JSON 검증기는 `minItems`/`items` 만 강제, **`uniqueItems` 미지원**. 따라서 documents 의 **id·filename·정규화명 유일성은 스키마가 아니라 `ingest.py` 코드로** fail-closed 강제한다(스키마에 의존 금지).

## 2. 설계 — 3링크 (전부 조건부; **부재 = no-op 아니라 "정리(cleanup)"**)

### 링크 A — 입력 채널 (`ingest-bundle.sh`)
- 소스 우선순위: `HARNESS_EVIDENCE_DIR` → `<bundle>/evidence/` → 없음.
- **안전 스냅샷(F6)**: `cp -R` 금지. `inputs/evidence/` 최상위 엔트리만 순회 — **디렉터리·심볼릭 링크 거부**, 파일명 NFC 정규화+안전토큰(`..`·경로구분자 금지), **정규파일만** 개별 복사. 위반·화이트리스트 밖 확장자 = **fail-closed**(조용한 무시 금지).
- **자원 상한(F6)**: 파일당 20MB·총량 50MB 기본(env override), 초과 fail-closed.
- **0바이트 거부(N3)**: `bytes == 0` 문서 = fail-closed(빈/손상 근거 첨부 차단).
- **NFC 충돌 거부(N2)**: 서로 다른 원본 파일명이 NFC 정규화 후 동일해지면 = fail-closed(제출물 파일명 모호성 차단).
- 허용 확장자: `.pdf .hwp .hwpx .doc .docx .xls .xlsx .png .jpg .jpeg .webp`. `index.json`(사이드카)은 **예약** — 문서목록 제외, 메타로만. **그 외 모든 `.json` 거부**.
- **정리·정확복제(F2·N6)**: 스냅샷은 **정확 복제(exact-replacement)** — 매 실행 `inputs/evidence/` 를 먼저 `rmtree` 한 뒤 현재 소스의 유효 문서만 재적재(bundle images 의 dest-초기화 패턴 `ingest-bundle.sh:58-60` 계승). 이래야 이전 런에서 삭제·개명된 첨부의 stale 사본이 **부분 축소(3→2건)** 시에도 남지 않는다(assets/examples 의 dest-미초기화 패턴은 답습 금지). 유효 근거 0건이면 `inputs/evidence/`·`00-ingest/evidence-documents.json` 을 제거(생성 안 함).

### 링크 B — ingest 아티팩트 (신규, regen 독립)
- `ingest.py` `cmd_evidence_docs` 신설 + `main()` 디스패치. `ingest-bundle.sh` 가 **regen-skip 블록(`:91-113`)·고정 state 아티팩트 append(`:130-133`)와 독립**으로, 소스 필터링 후 항상 (재)평가(F7): 유효 문서 있으면 생성, 없으면 정리.
- 산출물 `00-ingest/evidence-documents.json`(**유효 0건이면 생성 안 함/제거** — 골든 불변):
  ```
  { "documents": [ {"id":"doc-01","filename":"...","ext":"pdf","bytes":N,"sha256":"...",
                    "grade":null|"인체적용시험","linked_claim_ids":[]} ], "source": {...} }
  ```
  - `id` = `doc-NN`(NFC 파일명 정렬순). **유일성(N5)**: id·filename·정규화명 중복 시 `ingest.py` 가 fail-closed(스키마 아님).
  - `grade`·`linked_claim_ids` = 예약 사이드카 `inputs/evidence/index.json`(사람 선언).
    - **양방향 참조 무결성(N4)**: index.json 의 모든 키(파일명)는 **복사된 문서와 정확히 1:1** 매칭돼야 함 — 존재하지 않는 파일명 키 = fail-closed(선언 조용한 소실 차단). 사이드카 없는 문서는 grade=null·links=[] 기본(정상, false-positive 확인).
    - `linked_claim_ids` 는 `00-ingest/claim-basis.json` `evidence_on_file[].id` 와 대조, 미존재 시 fail-closed(F5). 대조해도 실증셋 미편입.
- **state 정리(N1·F2)**: `ingest-bundle.sh` 가 `state.artifacts` 에 evidence-documents 를 **존재 시에만 추가**하고 **부재 시 제거(prune)** — 근거 있던 런에서 제거 후 재실행·재개 시 stale 항목 잔존 차단.
- **원자적 마지막-기록(N7)**: `00-ingest/evidence-documents.json` 은 **스냅샷(파일 복사)이 전부 끝난 뒤 마지막에** `atomic_write_json` 으로 기록(repo 기존 헬퍼: temp+fsync+os.replace, `harness.py:62`). 매니페스트가 미완 스냅샷을 절대 반영하지 않는다.
- **write-ahead incomplete sentinel(N10 — 정합성 창 근본 종결)**: `ingest-bundle.sh` 가 **어떤 run-input 변경보다 먼저**(evidence rmtree/swap·기존 4종 regen 을 포함해 아무것도 건드리기 전) 원자적으로 sentinel `00-ingest/.ingest-incomplete`(작성 타임스탬프)을 쓰고, **터미널 상태-기록(`ingest-bundle.sh:121-139` state.artifacts·status=passed·atomic state)이 성공한 뒤에만** 제거한다.
  - **하류가 sentinel 을 존중(fail-closed)**: `run-stage.sh`·`validate-stage.sh`·`advance-phase.sh`·`next-action.sh` 는 `00-ingest/.ingest-incomplete` 가 있으면 어느 phase 에서든 중단("00-ingest 가 완료되지 않았습니다 — `bash scripts/run-stage.sh ingest <id>` 를 다시 실행하세요").
  - **advance-gate = positive completion(N11·N12)**: `advance-phase --to` 로 **00-ingest 에서 나가는 모든 출구**(합법 후속 = `00g-guideline` **및** `01-brief` 둘 다, `advance-phase.sh:32`)에 대해 sentinel 부재만으론 부족하다 — **양성 완료 증명**을 요구한다: `state.status=passed`(00-ingest) **그리고** 필수 4종(voc·claim-basis·assets-manifest·best-practices) present+valid. 근거: fresh 런은 sentinel 이 애초에 없어(ingest 미시작) "부재=완료"로 오판하면 ingest 를 건너뛴 직행 점프가 가능하다(Codex r8) — sentinel 부재는 **필요조건**이지 충분조건이 아니다. ⚠ 특정 타깃(01-brief)만이 아니라 **양쪽 후속 모두**에 적용해야 00g-guideline 우회 점프도 막힌다(Codex r9). 이로써 미시작·미완·중단 3상태 모두, 어느 후속으로도 하류 진입 차단.
  - **왜 근본 종결인가**: 이러면 **fresh 런이든, 이미 01-brief 이후로 진행된 런의 re-ingest 든**, 근거 처리 중 어떤 창(빈-창=rmtree 직후·첫 복사 전, copy 중, 매니페스트 쓰기 전)에서 중단돼도 sentinel 이 남아 **하류가 전부 막히고 재-ingest(멱등 exact-replacement 가 치유)가 강제**된다. v7 의 "state 가 뒤 phase 에 남아 재실행이 강제되지 않는다"는 구멍(Codex r7)을 sentinel 이 메운다. sentinel 자체 쓰기는 원자적(create/atomic_write)이라 sentinel 유무는 이진(부분상태 없음).
  - **골든 불변**: sentinel 은 성공 ingest 안에서 쓰였다 제거되므로 **완료 런엔 부재** → baseline 매니페스트·golden 에 안 나타남(dotfile·전이물). export 의 정확집합 대조(N7)·orphan 가드(N8)는 그 위 심층방어로 유지.
- 신규 스키마 `harness/evidence-documents.schema.json`·`harness/evidence-index.schema.json`(둘 다 `additionalProperties:false`) + `harness/registry.json` 매핑(**`TARGETS`·00-ingest 필수 4종 미변경** — Codex 확인). `validate-stage.sh` 는 존재 시에만 검증(sweep 은 phase-local 이라 `inputs/evidence/index.json` 은 sweep 대상 아님 — Codex 확인).

### 링크 C — export 반영 (`export_package.py`, 조건부 + stale rmtree + 무결성 재검증)
- **stale 정리(F2)**: export 진입 시 `kcia-package/evidence/` **항상 `rmtree`**(shots 패턴) 후 조건부 재생성. `package.json`/`README.md` 는 매번 새로 써서 근거 필드/절 자기-정리.
- **orphan 근거 가드(N8, 매니페스트 판정 전 최우선)**: `inputs/evidence/` 에 정규파일이 1개라도 있는데 `00-ingest/evidence-documents.json` 이 **부재**하면 = 중단된 '첫 근거 추가'의 orphan 상태 → **fail-closed**("근거 파일은 있는데 매니페스트가 없습니다 — ingest 를 다시 실행하세요"). 매니페스트 부재를 "근거 없음"으로 처리해 실파일을 조용히 누락하는 걸 막는다. (근거 없는 런은 `inputs/evidence/` 자체가 없어 미발동 → 골든 불변.)
- `00-ingest/evidence-documents.json` **존재 시에만**:
  - **정확집합 대조 선행(N7)**: 복사 전에 `inputs/evidence/` 의 실제 파일 집합(정규파일만)이 매니페스트 `documents` 의 filename 집합과 **정확히 일치**하고 각 sha256 도 일치하는지 검사 — 디스크에만 있는 파일(extra)·매니페스트에만 있는 파일(missing)·해시 불일치면 **fail-closed**. 중단-재실행으로 매니페스트가 stale/부분이면 여기서 걸려 **조용한 누락을 차단**한다.
  - **안전순서 무결성 복사(F3)**: 순서가 중요 — **바이트를 읽기 전에 먼저** ① `lstat` 로 정규파일 확인(심볼릭·특수파일 거부) ② realpath 경계검사(run-local `inputs/evidence/` 밖 거부) ③ 크기 상한 재확인 → 그 다음에야 ④ 원본 `bytes`·`sha256` 재계산·매니페스트 대조(불일치 fail-closed) → ⑤ 복사 → ⑥ **복사본(destination) 재해시로 사본 무결성 확인**(불일치 fail-closed). 근거: ingest↔export 사이 스냅샷 파일이 심볼릭/특수/run-밖 파일로 치환돼도 **바이트를 읽기 전에** 차단(F3 순서역전 교정).
  - `package.json` `evidence_documents:[{id,filename,grade,sha256,bytes,linked_claim_ids}]` 추가.
  - `README.md` "첨부 근거 문서" 표(기존 텍스트 근거표와 **별개 절** 병기).
- **부재 시(orphan 아님 = `inputs/evidence/` 도 없음)**: evidence/·필드·절 미생성 → 기존 패키지 바이트 불변.

## 3. 파일별 변경 (file:line — Codex 확인)
- `scripts/ingest-bundle.sh`(examples `:76-83` 인접, regen `:91-113`·state append `:130-133` 밖): 안전 스냅샷+생성+state prune+정리.
- `scripts/lib/ingest.py`: `cmd_evidence_docs` + 디스패치(유일성·양방향 무결성·0바이트·NFC충돌 코드 강제).
- `harness/evidence-documents.schema.json`·`harness/evidence-index.schema.json`(신규)·`harness/registry.json`(매핑, TARGETS 불변).
- `scripts/validate-stage.sh`(필수셋 `:16-19` 불변, 스윕 `:63-77` 존재 시 검증, + `.ingest-incomplete` sentinel 존중 N10).
- `scripts/run-stage.sh`·`scripts/advance-phase.sh`: `.ingest-incomplete` sentinel 존중(모든 phase fail-closed) + advance-phase 완료-게이트(N10).
- `scripts/lib/export_package.py`(`:36-45` shots 인접·`:63-89`): rmtree+무결성-재검증 복사+목록.
- `tests/run-ci.sh`(`:12-14` env 스크럽 `HARNESS_EVIDENCE_DIR`·`:34` TESTS 등록).
- `docs/workflow-ssot.md`·`docs/pipeline-stage-definitions.md`.

## 4. 증명 (골든 불변 최우선 · baseline extra-경고 한계 보완 · 신규 안전 케이스)
- 신규 회귀 `tests/test-evidence-attachment.sh`(run-ci 등록):
  - (a) **근거 없음 strict(F1)**: `inputs/evidence/`·`evidence-documents.json`·`kcia-package/evidence/`·`package.json.evidence_documents`·README 근거절·**state.artifacts 근거항목** 전부 부재 하드 단정 + 기존 산출물·패키지 바이트 불변.
  - (b) **근거 3건**: 생성·스키마·export 복사+목록+sha256/bytes.
  - (c) **stale 정리(F2·N1)**: 근거 제거 재실행 → evidence-documents.json·kcia-package/evidence·**state.artifacts 항목** 제거.
  - (d) **무결성 불일치(F3)**: ingest 후 원본 변조 → export fail-closed.
  - (e) **traversal/심볼릭/디렉터리/확장자밖/초과크기(F4·F6)**: 각 fail-closed.
  - (f) **사이드카(F5·N4)**: grade/link 반영 · 미존재 claim id → fail · 미존재 파일명 키 → fail · index.json 문서제외.
  - (g) **0바이트(N3)**·**NFC 충돌(N2)**·**중복 id/filename(N5)**: 각 fail-closed.
  - (h) **부분 축소 정확복제(N6)**: 근거 3건 런 → 1건 삭제·1건 개명 후 재실행 → `inputs/evidence/`·`evidence-documents.json`·`kcia-package/evidence/` 가 **현재 유효분과 정확히 일치**(삭제·구명 파일 stale 사본 부재).
  - (i) **export 안전순서(F3)**: ingest 후 스냅샷 파일을 심볼릭/run-밖 링크로 치환 → export 가 **바이트 읽기 전** 거부(fail-closed) + 복사본 재해시 불일치도 fail-closed.
  - (j) **정합성 창(N7)**: 매니페스트↔디스크 불일치 시뮬(디스크에 extra 파일 / 매니페스트에만 있는 파일 / sha 불일치) → export 정확집합 대조 fail-closed(조용한 누락 없음).
  - (k) **orphan(N8)**: `inputs/evidence/` 에 실파일 있으나 evidence-documents.json 부재(중단된 첫 추가 시뮬) → export fail-closed(조용한 "근거 없음" 처리 안 함).
  - (l) **빈-창 중단(N9)**: 근거 소스 지정 후 evidence 스냅샷을 중도 중단(rmtree 후 파일 0) → **00-ingest 미완** 단정 → 재-ingest 시 정상 완주(exact-replacement). 부분-커밋 상태로 04/export 도달 불가.
  - (m) **sentinel 근본 종결(N10)**: (i) 이미 01-brief 로 진행된 런에서 evidence 재-ingest 를 중도 중단(sentinel 잔존) → run-stage/validate/advance 가 **어느 phase 에서든 fail-closed**, 재-ingest 로만 해소. (ii) 완료 런엔 sentinel 부재 → 골든/baseline 불변. (iii) advance-phase --to 가 sentinel 있으면 거부.
  - (n) **advance-gate positive completion(N11·N12)**: fresh 런(new-run 직후, sentinel 없음·status=pending)에서 `advance-phase --to 01-brief` **및** `--to 00g-guideline` **둘 다 거부**(status≠passed·필수 4종 미검증). ingest 정상 완주 후에만 통과.

## 5. 열린 결정 (리뷰로 확정됨)
1. grade·연결 = 사이드카 `index.json`(예약·양방향 무결성). **확정.**
2. 확장자 = 초안 화이트리스트(추후 화이트리스트만 확장). **확정.**
3. linked_claim_ids = claim-basis id 대조 강제·실증셋 미편입. **확정.**
4. 상한 = 파일당 20MB·총량 50MB(env override). **확정.**

## 6. 규제·안전 노트
협회 제출 실무 부합(시안+근거자료). 첨부는 **사람 제출 실파일만**·**첨부≠실증**(미승인 주장 정당화 불가, 심의 게이트 불변). 첨부표와 기존 텍스트 evidence(WB 추출) 별개 병기. 비법적 사전점검 고지 불변.
