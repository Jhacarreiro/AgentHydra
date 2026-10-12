"""The window-placement guard around a move's import follows the target's native mode.

A `native-only` profile lands the chat through the app's own call over its debugger: no window is
touched, so capture and restore (about 3.5s a chat, measured 2026-10-12) are skipped. A
`prefer-native` profile may still take the deep link, which reshows the window, so it keeps the guard.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import hydralib, windowlib  # noqa: E402

DIR = r"C:\Users\example\.claude-instances\moarz"


def _settings(mode):
    return {DIR.lower(): {"port": 19311, "mode": mode, "launchDebugger": True}}


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("native-only", True), ("prefer-native", False)],
)
def test_guard_is_skipped_only_for_native_only(monkeypatch, mode, expected):
    monkeypatch.setattr(hydralib, "api_get", lambda path: _settings(mode))
    assert migrate_chat._native_only_target({"dir": DIR}) is expected


def test_native_only_import_never_enters_the_window_guard(monkeypatch):
    monkeypatch.setattr(hydralib, "api_get", lambda path: _settings("native-only"))
    guarded = []

    def guard(instance):
        guarded.append(instance)
        raise AssertionError("the window guard must not run for a native-only target")

    monkeypatch.setattr(windowlib, "keep_placement", guard)
    posted = {}

    def post(path, body=None, timeout=None):
        posted["path"] = path
        return {"ok": True, "titled": True}

    monkeypatch.setattr(hydralib, "api_post", post)
    result = migrate_chat._post_import_or_raise("sid-1", {"dir": DIR, "name": "moarz"}, {})
    assert result == {"ok": True, "titled": True}
    assert guarded == []
    assert posted["path"] == "/api/sessions/sid-1/import-desktop"
