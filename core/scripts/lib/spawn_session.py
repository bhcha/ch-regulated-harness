#!/usr/bin/env python3
# spawn_session.py — 인자(argv[1:])를 '새 세션/프로세스 그룹'(os.setsid)에서 exec 한다.
#   목적: 생성 CLI(claude -p / codex exec)와 그 하위(node 등 손자/재부모화 프로세스)를 하나의 프로세스 그룹으로 묶어,
#         watchdog 가 `kill -- -<pgid>` 로 **그룹 전체**를 회수하게 한다(pgrep -P 의 PPID 트리만으론 reparent/별 그룹 누수).
#   이식성: macOS·Linux 모두 os.setsid 지원(맥 기본 부재인 setsid(1) 바이너리 비의존). python3 는 본 하네스 공용 의존.
#   setsid 후 이 프로세스가 그룹 리더가 되어 pgid == pid → 호출부가 잡은 $! 를 음수로 주면 그룹 전체 시그널.
#   fds(stdout/stderr)는 상속 유지(스트리밍 보존). 제어터미널만 분리.
import os, sys

if len(sys.argv) < 2:
    sys.stderr.write("spawn_session.py: 실행할 명령이 필요합니다\n")
    sys.exit(2)
try:
    os.setsid()
except OSError:
    pass  # 이미 세션 리더 등 — exec 는 계속 진행(폴백: pgrep -P 트리 종료가 받쳐준다)
os.execvp(sys.argv[1], sys.argv[1:])
