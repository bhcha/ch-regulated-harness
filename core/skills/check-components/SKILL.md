---
name: check-components
description: 상세페이지 주요 구성요소 커버리지 체크
---
# /check-components

상세페이지 주요 구성요소(키비주얼·판매/수상·문제·VOC·RTB 요약/세부·과학근거·사용법·추천타겟·브랜드배너)가
산출물에 모두 들어있는지 점검하고 canon-coverage.json 리포트를 남깁니다.

```bash
bash scripts/check-components.sh $RUN
```
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로). 과학/임상은 실증 미등록 시 자동 면제됩니다.
