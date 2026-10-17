"""hydralib: a chat move's daemon call waits out a daemon restart (2026-10-17).

A move runs under a runner and outlives a restart (server/src/orchestrator.ts outlivesDaemon), but
each of its steps is a call into the daemon. While the daemon hands over, the outgoing one answers
503 with x-agenthydra-restarting (the call did not run; server/src/toolbox-calls.ts), then the port
refuses until the next daemon binds it. A run with an operation id (AGENTHYDRA_OPERATION) sends the
call again through both, so it lands once, on the next daemon, mutation or not, and on the port that
daemon wrote to runtime.json when it bound another one.
"""

import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import hydralib  # noqa: E402

_GLOBALS = ("BASE", "_POINTER_BASE", "OPERATION", "RESTART_WAIT_SECS", "TIMEOUT_SECS")
_PATH = "/api/claude-native/ultracode"


def _free_ports(n: int) -> list[int]:
    socks = [socket.socket() for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


def _answer(handler: BaseHTTPRequestHandler, status: int, body: bytes, **headers: str) -> None:
    handler.send_response(status)
    for name, value in headers.items():
        handler.send_header(name, value)
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _outgoing(turned_away: list, hand_over) -> type:
    """The daemon handing over: it turns the call away unrun, then exits (hand_over)."""

    class Outgoing(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length") or 0))
            turned_away.append(self.path)
            _answer(self, 503, b'{"ok": false, "restarting": true}',
                    **{"x-agenthydra-restarting": "1"})
            threading.Thread(target=hand_over, daemon=True).start()

    return Outgoing


def _next(landed: list) -> type:
    """The next daemon: it answers its health as agenthydra and runs the call."""

    class Next(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            _answer(self, 200, b'{"ok": true, "service": "agenthydra"}')

        def do_POST(self):
            sent = self.rfile.read(int(self.headers.get("content-length") or 0))
            landed.append((self.path, self.headers.get("x-agenthydra-operation"), json.loads(sent)))
            _answer(self, 200, b'{"ok": true}')

    return Next


class RestartGapTest(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(hydralib, name) for name in _GLOBALS}
        self.servers = []
        hydralib._POINTER_BASE = ""
        hydralib.OPERATION = "op-example"
        hydralib.RESTART_WAIT_SECS = 10
        hydralib.TIMEOUT_SECS = 5
        # The runtime.json pointer the next daemon writes, in a scratch config dir.
        self.home = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {"AGENTHYDRA_HOME": self.home})
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for name, value in self.saved.items():
            setattr(hydralib, name, value)
        shutil.rmtree(self.home, ignore_errors=True)

    def _serve(self, port, handler):
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def _hand_over(self, old_port: int, new_port: int):
        """Run a mutation through a handover from old_port to a next daemon on new_port, which
        writes its pointer once it serves. Returns (answer, calls turned away, calls landed)."""
        hydralib.BASE = f"http://127.0.0.1:{old_port}"
        turned_away, landed = [], []
        outgoing = None

        def hand_over():
            outgoing.shutdown()
            outgoing.server_close()
            time.sleep(1.5)
            self._serve(new_port, _next(landed))
            url = f"http://127.0.0.1:{new_port}"
            Path(self.home, "runtime.json").write_text(json.dumps({"port": new_port, "url": url}))

        outgoing = self._serve(old_port, _outgoing(turned_away, hand_over))
        got = hydralib.api_post_once(_PATH, {"id": "chat-1"})
        return got, turned_away, landed

    def test_a_move_mutation_lands_once_on_the_next_daemon_after_the_handover(self):
        [port] = _free_ports(1)
        got, turned_away, landed = self._hand_over(port, port)

        self.assertEqual(got, {"ok": True})
        self.assertEqual(turned_away, [_PATH])
        self.assertEqual(landed, [(_PATH, "op-example", {"id": "chat-1"})])

    # WHY (2026-10-17): the daemon pins its own url into a run's env, and a successor that hops to
    # another port (its predecessor still held the old one) left that url naming a port nobody binds
    # again: every call refused there until RESTART_WAIT_SECS ran out, and the step failed half-way.
    def test_a_move_mutation_follows_the_pointer_to_a_next_daemon_on_another_port(self):
        old_port, new_port = _free_ports(2)
        got, turned_away, landed = self._hand_over(old_port, new_port)

        self.assertEqual(got, {"ok": True})
        self.assertEqual(turned_away, [_PATH])
        self.assertEqual(landed, [(_PATH, "op-example", {"id": "chat-1"})])
        self.assertEqual(hydralib.BASE, f"http://127.0.0.1:{new_port}")


if __name__ == "__main__":
    unittest.main()
