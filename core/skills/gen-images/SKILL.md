---
name: gen-images
description: 기획안 visual.concept → 슬롯별 이미지 시안 생성(오프라인은 stub SVG)
---
# /gen-images

04-keyvisual 에서 수동 실행. 기획안의 visual.concept 를 입력으로 슬롯별 이미지를 생성한다.
엔진: `HARNESS_IMAGE_CLI=nanobanana|stub`(온라인 기본 nanobanana · 오프라인만 결정적 stub SVG). 산출물은 자사 생성물(`inputs/assets/generated/`).

실엔진(nanobanana)으로 슬롯 여러 장 + 429 백오프면 **수 분** 걸린다 — 포그라운드 단일 툴콜은 세션 무진행 상한에 걸리니 **백그라운드로 띄우고 폴링**한다:

```bash
mkdir -p "runs/$RUN/.logs"
nohup bash scripts/gen-images.sh "$RUN" </dev/null \
  >"runs/$RUN/.logs/genimg-bg-$(date +%s).log" 2>&1 &
echo "PID=$!"        # </dev/null 필수(백그라운드 stdin 무한 행 방지)
```

30~45초 간격 폴링: `kill -0 <PID>`(생존) · `tail -n 5 runs/$RUN/.logs/genimg-bg-*.log`(진행·429·강등) · 증분 매니페스트에 `incomplete` 부재(완료). 중단은 자식까지: `pkill -P <PID>`.

> 포그라운드(짧을 때만 · 1급 경로): `bash scripts/gen-images.sh $RUN`
> Claude Code Bash 툴이면 `run_in_background: true` 로 같은 경로. 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로).
