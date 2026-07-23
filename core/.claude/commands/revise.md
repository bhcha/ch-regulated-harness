---
name: revise
description: 현업 보완 요청
---
# /revise

현업 보완 요청

```bash
bash scripts/revise.sh $RUN "$ARGS"
```
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로).

> 💬 **대화 중 보완 방향을 받을 때**: 고르기·승인 화면에서 "다시 만들기"를 고른 현업의 보완 방향을 받아 `bash scripts/a2ui-action.sh $RUN '{"action":"revise","direction":"<고칠 방향>"}'` 로 넘길 수 있습니다(위 `revise.sh` 직접 실행과 결과 동일 — 상태는 스크립트만 바꿈). 화법은 `prompts/operator-voice.md` 를 따릅니다.

> ⚠ **근거-연결 카피는 기획안과 함께 고친다(O-6)**: 키비주얼 단계에서 각주(`doc-NN`)가 달린 근거-연결 문장(판정문·인증-표시·전후 수치)을 보완할 때는, 03-storyboard 기획안(plan)의 해당 블록 근거 문장(claim `target_text`)·각주도 **같은 표현으로** 함께 고쳐야 한다. 심의 통과용으로 HTML 카피만 바꾸면 완료(done) 전이의 반영강제 게이트에서 막힌다(두 게이트가 같은 문자열을 봐야 통과 — 게이트를 완화하지 않는다).
