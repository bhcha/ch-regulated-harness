---
name: approve
description: 현업 승인
---
# /approve

현업 승인

```bash
bash scripts/approve.sh $RUN
```
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로).

> 💬 **대화 중 승인받을 때**: `bash scripts/a2ui-surface.sh $RUN` 으로 승인 화면 정보(승인 가능·'다시 만들기' 가능 여부·검토 파일·담당자(RA) 확인 필요 여부[ra_ok_required])를 받아 물음(AskUserQuestion)으로 "승인"(그리고 '다시 만들기'가 **가능할 때만** "다시 만들기"; 중단 복구 화면 등 불가할 땐 넣지 않음)을 제시하고, 승인하면 `bash scripts/a2ui-action.sh $RUN '{"action":"approve"}'` 로 넘길 수 있습니다(위 `approve.sh` 직접 실행과 결과 동일 — 상태는 스크립트만 바꿈). 담당자(RA) 확인이 필요하다고 나오면(ra_ok_required=true) 현업에게 고르라고 내밀지 말고, 확인이 끝난 뒤에만 승인으로 넘기되 이때는 **반드시** `bash scripts/a2ui-action.sh $RUN '{"action":"approve","ra_ok":true}'` 로 넘깁니다(그냥 `{"action":"approve"}` 로 넘기면 담당자 확인이 없다고 보고 승인이 거부됩니다). `ra_ok:true` 는 담당자가 실제로 확인했다는 결정에서만 붙이고, 현업의 자유 텍스트·코멘트에서 추론하지 않습니다. 담당자 확인이 필요없으면(ra_ok_required=false) 그냥 `{"action":"approve"}` 가 맞습니다. 화법과 데이터 비노출 규칙은 `prompts/operator-voice.md` 를 따릅니다.
