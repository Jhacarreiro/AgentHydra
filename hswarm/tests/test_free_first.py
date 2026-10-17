"""Offline: Free first for the web and read tasks, the tool-free asks, the provider health gate, the account moves and the
doctor's warning (free_route.py, free_client.py), against the same fake AgentHydra as test_free_route.py."""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, free_client, free_route  # noqa: E402
from test_free_route import ACCOUNTS, _consult, _Fake, _task  # noqa: E402

CHATGPT = {"account": "a2", "num": 2, "provider": "chatgpt", "signedIn": True, "busy": False, "usage": "unlimited everyday text"}
SICK = {"sent": 20, "failed": 18, "okShare": 0.1, "down": False, "downUntil": None, "topReason": "not_found"}


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _routine():
    task = _task()
    task.profile = "routine"
    return task


def _status(health=None):
    return {"ready": True, "accounts": [ACCOUNTS[0], CHATGPT], "running": 0, "providerHealth": health or {}}


def test_a_routine_tool_free_task_asks_chatgpt_first(monkeypatch):
    monkeypatch.setattr(free_route, "_PROBED", {})
    assert free_route._pick(_routine(), _status(), 0) == ("", "chatgpt")


def test_a_decision_tool_free_task_asks_sonnet_on_claude_first(monkeypatch):
    monkeypatch.setattr(free_route, "_PROBED", {})
    task = _task()
    task.profile = "decision"
    assert free_route._pick(task, _status(), 0) == ("sonnet", "claude")


def test_a_provider_the_health_gate_shuts_is_passed_over_except_one_probe_per_ten_minutes(monkeypatch):
    monkeypatch.setattr(free_route, "_PROBED", {})
    status = _status({"chatgpt": SICK})
    assert free_route._pick(_routine(), status, 0) == ("", "chatgpt")  # the first task of the window is the probe
    assert free_route._pick(_routine(), status, 0) == ("haiku", "claude")  # the next one is not
    monkeypatch.setitem(free_route._PROBED, "chatgpt", time.monotonic() - free_route.PROBE_EVERY_S - 1)
    assert free_route._pick(_routine(), status, 0) == ("", "chatgpt")  # ten minutes on, one more probe


def test_a_provider_marked_down_is_passed_over(monkeypatch):
    monkeypatch.setattr(free_route, "_PROBED", {"chatgpt": time.monotonic()})
    down = {**SICK, "okShare": 0.0, "down": True}
    assert free_route._pick(_routine(), _status({"chatgpt": down}), 0) == ("haiku", "claude")


def test_a_stored_reply_answers_a_turn_the_tab_did_not_confirm(fake):
    f = fake(state="failed", error="answer_not_confirmed: the tab did not confirm the reply",
             read=[{"role": "assistant", "text": "stored answer"}])
    res, note = _consult(_task())
    assert note is None and res.answer == "stored answer" and res.selection["route"]["via"] == "free"
    assert "free_read" in f.names


def test_a_new_thread_whose_send_was_cut_is_sent_again_once_under_the_same_name(fake, monkeypatch):
    monkeypatch.setattr(free_client, "NEW_THREAD_WAIT_S", 0.2)
    f = fake(cut={1}, threads=())
    res, note = _consult(_task())
    assert note is None and res.answer == "free answer"
    assert len(f.chats) == 2 and f.chats[0]["tasks"][0]["name"] == f.chats[1]["tasks"][0]["name"]


def test_a_tool_free_task_releases_its_lease_when_it_ends(fake):
    f = fake()
    _consult(_task())
    assert "free_release" in f.names


def test_a_rate_limited_try_moves_to_another_account_and_excludes_the_first(fake):
    f = fake(accounts=[ACCOUNTS[0], {**ACCOUNTS[0], "account": "a2", "num": 2}],
             state=["failed", "done"], error="rate_limited: the account is at its limit")
    res, note = _consult(_task())
    assert res.answer == "free answer" and set(note) == {"earlier"} and len(note["earlier"]) == 1
    assert len(f.chats) == 2 and f.chats[0]["tasks"][0].get("exclude_accounts") is None
    second = f.chats[1]["tasks"][0]
    assert second["exclude_accounts"] == [1] and second["name"].endswith(" m1")


def test_a_provider_problem_is_named_for_the_doctor():
    lines = free_route.provider_problems({"chatgpt": {**SICK, "down": True, "topReason": "not_found"}, "claude": {"sent": 0}})
    assert len(lines) == 1 and "chatgpt" in lines[0] and "not_found" in lines[0]


def test_the_doctor_warns_when_the_daemon_reports_a_provider_down(fake):
    fake(health={"chatgpt": {**SICK, "down": True, "topReason": "not_found"}})
    warnings = asyncio.run(free_route.provider_warnings())
    assert len(warnings) == 1 and "chatgpt" in warnings[0] and "not_found" in warnings[0]
