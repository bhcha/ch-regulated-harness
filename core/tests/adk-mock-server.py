#!/usr/bin/env python3
# adk-mock-server.py — 테스트 전용 로컬 ADK(/run) 목 서버(무네트워크 hermetic).
#   개편계획(critic=adk-http 단일)의 ADK 경로를 '실 GCP 없이' 검증하기 위한 stand-in.
#   adk_critic.py 가 거는 두 엔드포인트만 흉내낸다:
#     · POST /apps/<app>/users/<user>/sessions/<sid>  → 200(세션 생성)
#     · POST /run  → ADK 이벤트 배열([{author, content:{parts:[{text}]}}]). text 안에 ```json {...}``` 블록.
#   instruction 텍스트로 Pass-A(violations) / Pass-B(refuted) 를 구분한다(passb 프롬프트는 'refuted' 단어를 담는다).
#   응답 author 는 'cosmetics_review_agent'(adk_critic provenance known-set). ADK_CRITIC_ALLOW_LOCAL=1 이면 provenance 검증은 건너뛴다.
#
# 환경변수(테스트가 주입):
#   ADK_MOCK_PORT          — 리슨 포트(기본 0=임의). 시작 시 'PORT <n>' 를 stdout 한 줄로 알린다(테스트가 캡처).
#   ADK_MOCK_PASSA_TARGET  — Pass-A 가 위반으로 잡을 target_text. 콤마(,)로 다건 가능. 없으면 위반 0건=verdict pass.
#   ADK_MOCK_PASSA_AXIS    — 위반 axis(기본 consumer_deception; 도메인 ruleset 유효 축이어야 함).
#   ADK_MOCK_REFUTE_SUBSTR — Pass-B instruction(=candidate 포함)에 이 부분문자열이 있으면 refuted=true. 미설정=항상 false(유지).
#     ⚠ 룰셋 grounding 이 instruction 에 섞이므로 도메인 banned 어와 겹치지 않는 ASCII 센티넬(예: REFUTE_ME)을 쓴다.
#   ADK_MOCK_EMPTY_FIRST   — '1' 이면 첫 /run 은 빈 이벤트([])로 응답(retry-on-empty flaky 흡수 검증).
#   ADK_MOCK_HANG          — '1' 이면 /run 에서 무한 행(sleep) → 크리틱 watchdog(KCIA_CRITIC_TIMEOUT) 타임아웃 유발 검증.
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_STATE = {"run_calls": 0}
_LOCK = threading.Lock()


def _passa_text():
    target = os.environ.get("ADK_MOCK_PASSA_TARGET", "")
    axis = os.environ.get("ADK_MOCK_PASSA_AXIS", "consumer_deception")
    vios = []
    for t in (s.strip() for s in target.split(",")):
        if t:
            vios.append({"target_text": t, "axis": axis, "severity": "medium",
                         "reason": "목 서버 위반 후보", "suggested_rewrite": "대안"})
    block = json.dumps({"violations": vios}, ensure_ascii=False)
    return "심의 결과입니다.\n```json\n%s\n```\n" % block


def _passb_text(instruction):
    sub = os.environ.get("ADK_MOCK_REFUTE_SUBSTR", "")
    refuted = bool(sub) and (sub in instruction)
    block = json.dumps({"refuted": refuted, "reason": "목 적대검증"}, ensure_ascii=False)
    return "적대 재검토.\n```json\n%s\n```\n" % block


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # 조용히

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {}
        path = self.path
        if "/sessions/" in path:
            self._send(200, {"id": "mock-session"})
            return
        if path == "/run":
            with _LOCK:
                _STATE["run_calls"] += 1
                first = _STATE["run_calls"] == 1
            if os.environ.get("ADK_MOCK_HANG") == "1":
                import time as _t
                _t.sleep(120)  # watchdog 상한 유발용 무한 행(테스트가 KCIA_CRITIC_TIMEOUT 을 낮게 둠 → kill_proc_tree 회수)
                return
            if first and os.environ.get("ADK_MOCK_EMPTY_FIRST") == "1":
                self._send(200, [])  # flaky 빈 응답 1회(retry 흡수 검증)
                return
            instruction = ""
            for p in (payload.get("newMessage") or {}).get("parts") or []:
                if isinstance(p, dict) and isinstance(p.get("text"), str):
                    instruction += p["text"]
            is_passb = "refuted" in instruction  # passb 프롬프트는 refuted 스키마를 요구
            text = _passb_text(instruction) if is_passb else _passa_text()
            author = os.environ.get("ADK_MOCK_AUTHOR", "cosmetics_review_agent")
            self._send(200, [{"author": author,
                              "content": {"parts": [{"text": text}]}}])
            return
        self._send(404, {"error": "not found"})


def main():
    port = int(os.environ.get("ADK_MOCK_PORT", "0"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    actual = httpd.server_address[1]
    sys.stdout.write("PORT %d\n" % actual)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
