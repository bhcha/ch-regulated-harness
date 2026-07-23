---
name: kcia-check
description: 심의 게이트 실행(별세션)
---
# /kcia-check

심의 게이트 실행(별세션). 원격 ADK 다중 패스(plan·keyvisual 은 Pass-A + 블록별 Pass-B)라 **정상적으로 수 분~십수 분** 걸린다.

## 백그라운드 + 폴링 (세션 구동자용 · 권장)

포그라운드 단일 툴콜로 돌리면 완료까지 출력이 버퍼에 갇혀 세션 무진행 상한에 걸려 구동자가 죽는다. **띄워두고 짧게 폴링**한다.

```bash
mkdir -p "runs/$RUN/.logs"
nohup bash scripts/kcia-check.sh "$RUN" </dev/null \
  >"runs/$RUN/.logs/kcia-bg-$(date +%s).log" 2>&1 &
echo "PID=$!"        # </dev/null 필수(백그라운드 stdin 무한 행 방지)
```

이후 **30~45초 간격으로 툴콜 1회씩**(각 툴콜이 스트림을 진행시켜 무진행 상한을 리셋):

```bash
kill -0 <PID> 2>/dev/null && echo "진행 중" || echo "끝남"   # ① 생존
tail -n 5 "runs/$RUN/.logs/"kcia-bg-*.log                      # ② 진행(하트비트·Pass)
```

**완료 판정** = 프로세스 종료 + `runs/$RUN/verdict.json` 갱신 → `runs/$RUN/run.md` 의 "다음 명령" 확인. 중단은 자식까지: `pkill -P <PID>`(또는 `kill <PID>`).

> Claude Code Bash 툴이면 `run_in_background: true` 로 같은 경로(백그라운드 실행 → 완료 통지 → 위 tail 로 폴링).

## 포그라운드 (짧을 때만 · 1급 경로)

```bash
bash scripts/kcia-check.sh $RUN
```
> 슬래시가 동작하지 않으면 위 셸 명령을 직접 실행하세요(1급 경로).
