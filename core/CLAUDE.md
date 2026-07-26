@AGENTS.md

## Claude Code 전용 보충
- 위 `AGENTS.md` 가 단일 진실 지침이다. 아래는 Claude 환경 보충 메모일 뿐 규칙을 덮어쓰지 않는다.
- 슬래시 커맨드(`.claude/commands/*`)는 `scripts/run-stage.sh` 등을 호출하는 **편의 래퍼**다. 동작하지 않으면 셸 1급 경로를 쓴다.
- 생성 1급 경로 = Claude Code 세션 안(insession)에서 산출물을 먼저 쓰고(`HARNESS_CLI=claude`) 스크립트가 검증·전이만 한다(세션 밖 헤드리스 실엔진 생성은 폐기). 심의는 다른 벤더·원격 세션이어야 한다 — **본 하네스 심의 = 도메인별 원격 ADK(`adk-http`)**: 엔드포인트는 `packs/<도메인>/domain.json` 의 `adk_critic` 블록이 가리키는 env(예 화장품 = `ADK_COSMETICS_CRITIC_URL`). `KCIA_CRITIC_ENGINE` 은 비우거나 `adk-http` 만 쓴다. 로컬 헤드리스 크리틱(`claude-subagent`/`KCIA_CRITIC_CMD`)·self-grading 가드는 폐기됐다(원격 ADK 는 다른 벤더라 충돌 불가). 미구현 도메인(`adk_critic` 블록 없음)은 룰엔진-단독으로 가시화(상세 = `AGENTS.md` 2번 절).
- hooks / `~/.claude/agents` subagent 자동발견에 **의존하지 않는다**(이식성). 루프 제어는 `state.json` + scripts 로만.
