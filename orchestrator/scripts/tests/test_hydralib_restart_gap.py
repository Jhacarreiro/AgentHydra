"""hydralib: a chat move's daemon call waits out a daemon restart (2026-10-17).

A move runs under a runner and outlives a restart (server/src/orchestrator.ts MOVE_SCRIPTS), but
each of its steps is a call into the daemon. While the daemon hands over, the outgoing one answers
503 with x-agenthydra-restarting (the call did not run; server/src/toolbox-calls.ts), then the port
refuses until the next daemon binds it. A run with an operation id (AGENTHYDRA_OPERATION) sends the
call again through both, so it lands once, on the next daemon, mutation or not.
"""

import json
import socket
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import hydralib  # noqa: E402

_GLOBALS = ("BASE", "_POINTER_BASE", "OPERATION", "RESTART_WAIT_SECS", "TIMEOUT_SECS")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RestartGapTest(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(hydralib, name) for name in _GLOBALS}
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for name, value in self.saved.items():
            setattr(hydralib, name, value)

    def _serve(self, port, handler):
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def test_a_move_mutation_lands_once_on_the_next_daemon_after_the_handover(self):
        port = _free_port()
        hydralib.BASE = f"http://127.0.0.1:{port}"
        hydralib._POINTER_BASE = ""
        hydralib.OPERATION = "op-example"
        hydralib.RESTART_WAIT_SECS = 30
        hydralib.TIMEOUT_SECS = 5
        turned_away, landed = [], []
        outgoing = None

        class Outgoing(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length") or 0))
                turned_away.append(self.path)
                body = b'{"ok": false, "restarting": true}'
                self.send_response(503)
                self.send_header("x-agenthydra-restarting", "1")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                # The handover: this daemon exits, the port is shut, the next one binds it later.
                threading.Thread(target=hand_over, daemon=True).start()

        class Next(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                sent = self.rfile.read(int(self.headers.get("content-length") or 0))
                landed.append((self.path, self.headers.get("x-agenthydra-operation"), json.loads(sent)))
                body = b'{"ok": true}'
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def hand_over():
            outgoing.shutdown()
            outgoing.server_close()
            time.sleep(1.5)
            self._serve(port, Next)

        outgoing = self._serve(port, Outgoing)
        got = hydralib.api_post_once("/api/claude-native/ultracode", {"id": "chat-1"})

        self.assertEqual(got, {"ok": True})
        self.assertEqual(turned_away, ["/api/claude-native/ultracode"])
        self.assertEqual(landed, [("/api/claude-native/ultracode", "op-example", {"id": "chat-1"})])


if __name__ == "__main__":
    unittest.main()
