"""The observe CLIs - dossier.py, list_instances.py, gate_chat.py, attempts.py - exit codes,
refusals, and output honesty, against the stub daemon."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402
import attempts as attempts_cli  # noqa: E402
import dossier as dossier_cli  # noqa: E402
import gate_chat  # noqa: E402
from lib import ledgerlib  # noqa: E402
import list_instances  # noqa: E402

SID = "cccc1111-2222-3333-4444-555566667777"


from util import run_cli  # noqa: E402


class ObserveCliTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    # ---- dossier.py

    def test_dossier_single_match_exit_0(self):
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"title": "T", "instance": "i", "archived": False, "lineageIds": []}]
        }
        code, out, _ = run_cli(dossier_cli.main, ["T"])
        self.assertEqual(code, 0)
        self.assertIn("title      T", out)

    def test_dossier_ambiguous_exit_3_and_warns(self):
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"title": "T", "lineageIds": []}, {"title": "T", "lineageIds": []}]
        }
        code, out, _ = run_cli(dossier_cli.main, ["T"])
        self.assertEqual(code, 3)
        self.assertIn("refuse this query as ambiguous", out)

    def test_dossier_daemon_down_exit_1(self):
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "x"})
        code, _, err = run_cli(dossier_cli.main, ["T"])
        self.assertEqual(code, 1)
        self.assertIn("FAILED", err)

    # ---- list_instances.py

    def test_list_instances_renders_and_counts(self):
        self.stub.routes["/api/fleet"] = {
            "instances": [
                {"num": 1, "name": "a", "isRunning": True, "signedIn": True, "dir": "d1",
                 "account": {"planLabel": "Max"}, "usage": {"weeklyPct": 42}},
                {"num": 2, "name": "b", "isRunning": False, "signedIn": False, "dir": "d2"},
            ]
        }
        code, out, _ = run_cli(list_instances.main, [])
        self.assertEqual(code, 0)
        self.assertIn("1 open of 2 listed", out)
        code, out, _ = run_cli(list_instances.main, ["--open"])
        self.assertIn("1 open of 1 listed", out)

    def test_list_instances_daemon_down_exit_1(self):
        self.stub.routes["/api/fleet"] = (503, {"error": "x"})
        self.assertEqual(run_cli(list_instances.main, [])[0], 1)

    # ---- gate_chat.py

    def test_gate_chat_renders_verdict(self):
        tmp = Path(self._state.name) / "t.jsonl"
        tmp.write_text(
            json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "## Am I 100% done?\n- Yes\nAll finished."}]}}) + "\n",
            encoding="utf-8",
        )
        old = time.time() - 300
        os.utime(tmp, (old, old))
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"title": "T", "cliSessionId": SID, "lineageIds": [SID], "live": None}]
        }
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "transcript_path": str(tmp), "archived": False}
        ]
        code, out, _ = run_cli(gate_chat.main, [SID])
        self.assertEqual(code, 0)
        self.assertIn("FINISHED", out)
        self.assertIn("archive-candidate", out)

    def test_gate_chat_no_transcript_exit_3(self):
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"title": "T", "cliSessionId": SID, "lineageIds": [SID], "live": None}]
        }
        self.stub.routes["/api/sessions"] = []
        code, _, err = run_cli(gate_chat.main, [SID])
        self.assertEqual(code, 3)
        self.assertIn("cannot be acted on", err)

    def test_gate_chat_background_counts_only_the_last_engines_jobs(self):
        # The instance manager asks this of a chat whose app died: no live engine is left, so
        # --engine-started is the only thing telling the dead engine's jobs from an older one's.
        tmp = Path(self._state.name) / "t.jsonl"
        launch = "Command running in background with ID: {id}. You will be notified when it completes."
        records = [
            {"type": "user", "timestamp": "2026-09-05T01:00:00Z",
             "message": {"content": [{"type": "tool_result", "content": launch.format(id="bold1")}]}},
            {"type": "user", "timestamp": "2026-09-05T02:00:00Z",
             "message": {"content": [{"type": "tool_result", "content": launch.format(id="bnew2")}]}},
            {"type": "assistant", "timestamp": "2026-09-05T02:00:05Z",
             "message": {"content": [{"type": "text", "text": "Waiting on the build."}]}},
        ]
        tmp.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"title": "T", "cliSessionId": SID, "lineageIds": [SID], "live": None}]
        }
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "transcript_path": str(tmp), "archived": False}
        ]
        from datetime import datetime, timezone
        engine_started_ms = str(int(datetime(2026, 9, 5, 1, 30, tzinfo=timezone.utc).timestamp() * 1000))
        code, out, _ = run_cli(gate_chat.main,
                               [SID, "--json", "--background", "--engine-started", engine_started_ms])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["background"]["outstanding"], ["bnew2"])
        code, out, _ = run_cli(gate_chat.main, [SID, "--json", "--background"])
        self.assertEqual(sorted(json.loads(out)["background"]["outstanding"]), ["bnew2", "bold1"])

    # ---- attempts.py

    def test_attempts_reports_suppressions_loudly(self):
        for _ in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1")
        code, out, _ = run_cli(attempts_cli.main, [])
        self.assertEqual(code, 0)
        self.assertIn("HELD BACK", out)
        self.assertIn("s1", out)

    def test_attempts_clear_needs_both_args(self):
        self.assertEqual(run_cli(attempts_cli.main, ["--clear", "archive"])[0], 3)

    def test_attempts_clear_forgets_history(self):
        for _ in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1")
        code, out, _ = run_cli(attempts_cli.main, ["--clear", "archive", "s1"])
        self.assertEqual(code, 0)
        self.assertFalse(ledgerlib.check("archive", "s1")["suppressed"])
        code, out, _ = run_cli(attempts_cli.main, [])
        self.assertIn("nothing is suppressed", out)


if __name__ == "__main__":
    unittest.main()
