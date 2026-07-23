---
name: select
description: 다안 선택
---
# /select

다안 선택

```bash
bash scripts/select.sh $RUN $ARGS
```
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로).

> 💬 **대화 중 골라 드릴 때**: `bash scripts/a2ui-surface.sh $RUN` 으로 고를 안 목록·추천 안·미리보기 파일·'다시 만들기' 가능 여부를 구조화해 받아, 그대로 물음(AskUserQuestion)으로 제시합니다(**받아온 실제 안만**, 한 질문 최대 4개 — 안이 많으면 실제 안만 담아 여러 페이지로 나누고 "다음 목록" 안내는 페이지 넘김일 뿐 위임하지 않음). 고른 답을 `bash scripts/a2ui-action.sh $RUN '{"action":"select","value":"<고른 안>"}'` 로 넘길 수 있습니다(위임에는 **받아온 실제 안 키만** — 목록에 없는 이름은 거부됨). "다시 만들기"는 **가능하다고 나올 때만** 마지막 페이지 선택지로 붙입니다(중단 복구 화면 등 불가할 땐 넣지 않음). 결과는 위 `select.sh` 를 직접 부르는 것과 같습니다(상태는 스크립트만 바꿈). 화법과 "받아온 데이터를 현업에게 그대로 보여주지 않기"는 `prompts/operator-voice.md` 를 따릅니다.
