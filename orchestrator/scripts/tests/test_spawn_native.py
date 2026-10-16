#!/usr/bin/env python3
"""spawn_chat.spawn on a profile with native control: the chat starts through the app's own start
call (POST /api/instances/:dir/native-new) and never through the deeplink or the window actuator,
on the pinned model and effort. Daemon, window and ledger are mocked: nothing starts an app."""

from __future__ import annotations

import sys
import unittest
import unittest.mock as mock
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import hydralib  # noqa: E402
import spawn_chat  # noqa: E402

# The real check, kept before setUp swaps it for a mock.
NATIVE_CONFIGURED = spawn_chat.native_configured

FOLDER = str(Path(__file__).resolve().parent)
INST_DIR = "C:\\Users\\example\\.claude-instances\\instance-1"
INST = {"name": "alice", "num": 1, "dir": INST_DIR, "isRunning": True}
CLI = "0b6f2b0e-1111-4c4c-9a9a-123456789abc"
# What the daemon's native-new route answers (server/src/claude-native-new.ts NativeNewOutcome).
STARTED = {"ok": True, "unavailable": False, "desktopSessionId": "local_new_1",
           "cliSessionId": CLI, "started": True, "modelPinned": True, "effortPinned": True,
           "isRunning": True, "model": "claude-opus-5-5", "effort": "xhigh",
           "permissionMode": "bypassPermissions"}
ROUTE = "/api/instances/" + urllib.parse.quote(INST_DIR, safe="") + "/native-new"


class NativeConfiguredTest(unittest.TestCase):
    def test_a_profile_is_native_only_when_its_setting_starts_the_debugger(self):
        settings = {INST_DIR: {"launchDebugger": True, "port": 19311},
                    "C:\\Users\\example\\.claude-instances\\instance-2": {"launchDebugger": False}}
        with mock.patch.object(spawn_chat.hydralib, "api_get", return_value=settings):
            self.assertTrue(NATIVE_CONFIGURED(INST))
            self.assertFalse(NATIVE_CONFIGURED({"dir": "C:\\other\\instance-9"}))
            self.assertFalse(NATIVE_CONFIGURED({"dir": "C:\\Users\\example\\.claude-instances\\instance-2"}))

    def test_an_unreadable_settings_route_refuses_rather_than_taking_the_window_path(self):
        err = hydralib.DaemonError("/api/claude-native/settings", None, "timed out")
        with mock.patch.object(spawn_chat.hydralib, "api_get", side_effect=err):
            with self.assertRaises(hydralib.DaemonError):
                NATIVE_CONFIGURED(INST)


class NativeSpawnTest(unittest.TestCase):
    def setUp(self):
        self.refuse_dup = self.start(mock.patch.object(spawn_chat, "_refuse_if_duplicate",
                                                       return_value=None))
        self.resolve = self.start(mock.patch.object(spawn_chat, "_resolve_target",
                                                    return_value=(INST, None)))
        self.native = self.start(mock.patch.object(spawn_chat, "native_configured",
                                                   return_value=True))
        self.binary = self.start(mock.patch.object(spawn_chat, "_binary",
                                                   return_value="C:/x/claude.exe"))
        self.once = self.start(mock.patch.object(spawn_chat, "_spawn_once"))
        self.trust = self.start(mock.patch("trust_workspace.apply_trust",
                                           return_value={"trusted": []}))
        self.post = self.start(mock.patch.object(spawn_chat.hydralib, "api_post",
                                                 return_value=dict(STARTED)))
        self.note = self.start(mock.patch("lib.ledgerlib.note"))
        self.mark = self.start(mock.patch("lib.stamplib.mark_automation"))

    def start(self, patch):
        started = patch.start()
        self.addCleanup(patch.stop)
        return started

    def test_a_native_profile_starts_the_chat_through_the_app_and_never_the_deeplink(self):
        got = spawn_chat.spawn(FOLDER, "Survey the repo", "1")
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["route"], "native")
        self.assertEqual((got["model"], got["effort"]), ("claude-opus-5-5", "xhigh"))
        # The CLI session id: the one fan_out_status, receipts and fan_out_delete read.
        self.assertEqual(got["sessionId"], CLI)
        self.assertEqual(got["desktopSessionId"], "local_new_1")
        self.assertTrue(got["started"].startswith("running"), got["started"])
        self.assertTrue(got["window"].startswith("not-touched"), got["window"])
        self.once.assert_not_called()
        self.binary.assert_not_called()
        path, body = self.post.call_args.args[0], self.post.call_args.args[1]
        self.assertEqual(path, ROUTE)
        self.assertEqual(body, {"cwd": FOLDER, "prompt": "Survey the repo",
                                "model": "claude-opus-5-5", "effort": "xhigh", "bypass": True})
        self.note.assert_called_once()
        self.assertEqual(self.note.call_args.args[:2], ("spawned", CLI))
        self.mark.assert_called_once_with(CLI, "spawn_chat")

    def test_a_named_model_and_effort_are_the_ones_pinned(self):
        got = spawn_chat.spawn(FOLDER, "Survey", "1", model="claude-sonnet-5-5", effort="high")
        self.assertEqual((got["model"], got["effort"]), ("claude-sonnet-5-5", "high"))
        self.assertEqual(self.post.call_args.args[1]["model"], "claude-sonnet-5-5")
        self.assertEqual(self.post.call_args.args[1]["effort"], "high")

    def test_a_refused_native_start_is_not_retried_down_the_deeplink(self):
        self.post.return_value = {"ok": False, "unavailable": True, "reason": "app not running"}
        got = spawn_chat.spawn(FOLDER, "Survey", "1")
        self.assertFalse(got["ok"])
        self.assertIn("nothing started", got["why"])
        self.assertEqual(self.post.call_count, 1)
        self.once.assert_not_called()
        self.binary.assert_not_called()

    def test_a_native_start_lost_after_it_was_sent_is_never_retried(self):
        self.post.side_effect = hydralib.DaemonError(ROUTE, None, "reply lost")
        got = spawn_chat.spawn(FOLDER, "Survey", "1")
        self.assertFalse(got["ok"])
        self.assertIn("check the app before retrying", got["why"])
        self.assertEqual(self.post.call_count, 1)
        self.once.assert_not_called()

    def test_a_sent_start_that_reads_back_no_chat_says_to_check_the_app(self):
        self.post.return_value = {"ok": False, "unavailable": False,
                                  "desktopSessionId": "local_new_1", "reason": "no CLI session"}
        got = spawn_chat.spawn(FOLDER, "Survey", "1")
        self.assertFalse(got["ok"])
        self.assertIn("check the app before retrying", got["why"])
        self.assertIn("local_new_1", got["why"])
        self.assertEqual(self.post.call_count, 1)
        self.once.assert_not_called()

    def test_a_chat_started_on_another_model_is_tracked_but_not_claimed_running(self):
        self.post.return_value = dict(STARTED, ok=False, modelPinned=False,
                                      model="claude-sonnet-5-5")
        got = spawn_chat.spawn(FOLDER, "Survey", "1")
        self.assertTrue(got["ok"])
        self.assertEqual(got["sessionId"], CLI)
        self.assertEqual(got["modelKept"], "claude-sonnet-5-5")
        self.assertTrue(got["started"].startswith("not-pinned"), got["started"])
        self.assertIn("claude-sonnet-5-5", got["started"])
        self.assertEqual(self.post.call_count, 1)
        self.once.assert_not_called()

    def test_a_profile_without_native_control_keeps_the_deeplink_path(self):
        self.native.return_value = False
        self.once.return_value = {"ok": True, "url": "claude://code/new?x", "dialog": "none",
                                  "submitted": "sent", "submitNote": "", "landedIn": FOLDER, "modeSet": "ok",
                                  "sessionId": "sid-1", "unboundSessionId": None,
                                  "skippedForeign": [], "started": "running (composer submitted)",
                                  "window": "raised"}
        got = spawn_chat.spawn(FOLDER, "Survey", "1")
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["route"], "deeplink")
        self.assertEqual((got["model"], got["effort"]), (None, None))
        self.once.assert_called_once()
        self.post.assert_not_called()

    def test_a_bad_model_is_refused_before_anything_runs(self):
        got = spawn_chat.spawn(FOLDER, "Survey", "1", model="Fable")
        self.assertFalse(got["ok"])
        self.assertIn("claude-", got["why"])
        self.resolve.assert_not_called()
        self.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
