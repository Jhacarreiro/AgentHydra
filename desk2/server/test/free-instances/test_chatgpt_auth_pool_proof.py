"""Synthetic auth proofs bind the expected account to the saved, rotated login."""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from claudfree.chatgpt import api, http
from claudfree.errors import ClaudeError


class ChatGPTAuthPoolProofTests(unittest.TestCase):
    def test_full_and_brief_auth_hash_rotated_bytes_after_save_under_session_lock(self):
        for brief in (False, True):
            with self.subTest(brief=brief), tempfile.TemporaryDirectory() as root:
                client = api.ChatGPTClient(root)
                directory = Path(root) / "chatgpt"
                directory.mkdir()
                session_file = directory / "session.dpapi"
                session_file.write_bytes(b"synthetic-old-sealed-login")
                rotated = b"synthetic-new-sealed-login\x00\xff"
                saved = {"cookies": [], "origins": []}
                updated = {"cookies": [{"name": "synthetic", "value": "synthetic-cookie"}], "origins": []}
                locked = False
                events = []

                @contextmanager
                def lock(path, name, *, wait):
                    nonlocal locked
                    self.assertEqual((path, name, wait), (directory / "locks", "session", 210))
                    locked = True
                    try:
                        yield
                    finally:
                        locked = False

                def save(value):
                    self.assertTrue(locked)
                    self.assertEqual(value, updated)
                    session_file.write_bytes(rotated)
                    events.append("saved")

                original_read = Path.read_bytes

                def read_bytes(path):
                    self.assertTrue(locked)
                    self.assertEqual(events, ["saved", "closed"])
                    events.append("proof")
                    return original_read(path)

                client._state = SimpleNamespace(
                    directory=directory, session_file=session_file,
                    load=Mock(return_value=saved), save=save,
                )
                transport = SimpleNamespace(
                    authenticate=Mock(), account_label="Example Owner", account_email="owner@example.test",
                    saved_state=Mock(return_value=updated), close=lambda: events.append("closed"),
                )
                with patch.object(api, "chat_lock", lock), patch.object(http, "ChatGPTHttp", return_value=transport), \
                        patch.object(Path, "read_bytes", read_bytes):
                    result = client.execute("auth", brief=brief)

                self.assertFalse(locked)
                self.assertEqual(events, ["saved", "closed", "proof"])
                self.assertEqual(result, {
                    "ok": True, "schema_version": 1, "provider": "chatgpt", "command": "auth", "transport": "http",
                    "authenticated": True, "account_label": "Example Owner", "account_email": "owner@example.test",
                    "login_fingerprint": hashlib.sha256(rotated).hexdigest(),
                })
                self.assertNotIn("synthetic-cookie", json.dumps(result))
                transport.authenticate.assert_called_once_with()

    def test_missing_persisted_login_fails_closed_after_auth(self):
        with tempfile.TemporaryDirectory() as root:
            client = api.ChatGPTClient(root)
            saved = {"cookies": [], "origins": []}
            client._state = SimpleNamespace(
                directory=Path(root), session_file=Path(root) / "missing.dpapi",
                load=Mock(return_value=saved), save=Mock(),
            )
            transport = SimpleNamespace(
                authenticate=Mock(), account_label="Example Owner", account_email="owner@example.test",
                saved_state=Mock(return_value=saved), close=Mock(),
            )
            with patch.object(http, "ChatGPTHttp", return_value=transport):
                with self.assertRaises(ClaudeError) as failed:
                    client.execute("auth", brief=True)
            self.assertEqual(failed.exception.code, "session_save_failed")
            self.assertNotIn(root, str(failed.exception))
            transport.authenticate.assert_called_once_with()
            transport.close.assert_called_once_with()
            client._state.save.assert_not_called()

    def test_usage_does_not_gain_a_login_proof_or_require_a_persisted_file(self):
        with tempfile.TemporaryDirectory() as root:
            client = api.ChatGPTClient(root)
            saved = {"cookies": [], "origins": []}
            client._state = SimpleNamespace(
                directory=Path(root), session_file=Path(root) / "missing.dpapi",
                load=Mock(return_value=saved), save=Mock(),
            )
            transport = SimpleNamespace(
                authenticate=Mock(), usage=Mock(return_value={"plan": "free", "available": True}),
                saved_state=Mock(return_value=saved), close=Mock(),
            )
            with patch.object(http, "ChatGPTHttp", return_value=transport):
                result = client.execute("usage", brief=True)
            self.assertEqual(result, {
                "ok": True, "schema_version": 1, "provider": "chatgpt", "command": "usage", "transport": "http",
                "plan": "free", "available": True,
            })
            transport.usage.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
