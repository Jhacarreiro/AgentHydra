"""No-network checks: a Free Claude account only ever uses a temporary (Incognito) chat.

Nothing can ask for a regular chat, and a new chat sends no message until Claude's own create answer says it is
temporary (owner, 2026-10-16). Every id and model here is invented.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from claudfree import cli, http, service, state
from claudfree.api import Client
from claudfree.errors import ClaudeError
from claudfree.mcp_server import build_server
from claudfree.registry import ChatRegistry

ORG = "11111111-1111-4111-8111-111111111111"
CHAT = "44444444-4444-4444-8444-444444444444"
ANSWER = "55555555-5555-4555-8555-555555555555"
MODEL = "claude-sonnet-9"
CREATE = f"/api/organizations/{ORG}/chat_conversations"
COMPLETION = f"{CREATE}/{CHAT}/completion"


class Response:
    def __init__(self, body=None, lines=None, status=200):
        self.status_code = status
        self.headers = {"content-type": "text/event-stream" if lines is not None else "application/json"}
        self._body, self._lines = body, lines

    def json(self):
        return self._body

    def iter_lines(self, chunk_size=128):
        return iter(self._lines)

    def iter_content(self, chunk_size):
        yield json.dumps(self._body).encode()

    def close(self):
        pass


class FakeClaude:
    """claude.ai as the harness's HTTP session sees it; `created` is its answer to a new chat.

    A model in `refuse` is one the account may not use. As probed live on 2026-10-16, the create refuses it with a
    400 the fallback cannot tell from any other, and the message with a 403 model_not_available before anything
    is stored.
    """

    def __init__(self, created, refuse=()):
        self.headers, self.cookies, self.requests = {}, [], []
        self.created, self.refuse = created, set(refuse)
        self.answered = False

    def request(self, method, url, **kwargs):
        path = url.removeprefix(http.BASE)
        body = kwargs.get("json")
        self.requests.append((method, path, body))
        if path == "/api/organizations":
            return Response([{"uuid": ORG, "name": "Example"}])
        if path == "/api/account":
            offered = [{"model": "claude-sonnet-9"}, {"model": "claude-haiku-9"}]
            return Response({"memberships": [{"organization": {"uuid": ORG, "claude_ai_bootstrap_models_config": offered}}]})
        if (method, path) == ("POST", CREATE):
            if body.get("model") in self.refuse:
                return Response({"error": {"type": "invalid_request_error", "message": "Unsupported model"}}, status=400)
            return Response({"uuid": body["uuid"], "name": "", **self.created})
        if path.endswith("/completion") and body["model"] in self.refuse:
            error = {"type": "permission_error", "message": "Not available", "details": {"error_code": "model_not_available"}}
            return Response({"error": error}, status=403)
        if path.endswith("/completion"):
            self.answered = True
            return Response(lines=[
                'data: {"type":"message_start","message":{"uuid":"%s"}}' % ANSWER, "",
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}', "",
                'data: {"type":"message_stop"}', "",
            ])
        chat = path.rsplit("/", 1)[1]
        messages = [{"uuid": ANSWER, "sender": "assistant", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}]
        return Response({"uuid": chat, "model": MODEL, **self.created, "chat_messages": messages if self.answered else []})

    def paths(self):
        return [(method, path) for method, path, _ in self.requests]

    def close(self):
        pass


def client_for(claude):
    return http.ClaudeHttp({"cookies": [], "origins": []}, session_factory=lambda: claude)


def mcp_tool_arguments(name):
    server = build_server(Client())
    tool = next(t for t in asyncio.run(server.list_tools()) if t.name == name)
    return set(tool.model_dump(by_alias=True)["inputSchema"]["properties"])


@pytest.mark.parametrize(
    "ask",
    [
        pytest.param(lambda home: cli.parse_args(["chat", "--prompt", "hello", "--regular"]), id="cli"),
        pytest.param(lambda home: Client(home).create("hello", regular=True), id="python-create"),
        pytest.param(lambda home: Client(home).resume("last", "hello", regular=True), id="python-resume"),
        pytest.param(lambda home: Client(home).execute("chat", prompt="hello", regular=True), id="python-execute"),
        pytest.param(lambda home: client_for(FakeClaude({})).send(ORG, "hello", MODEL, new_chat_id=CHAT, temporary=False), id="http"),
    ],
)
def test_a_regular_chat_cannot_be_requested(ask, tmp_path):
    # Each way in refuses before any request: the CLI has no such flag, a Python call no such argument.
    with pytest.raises((ClaudeError, TypeError)) as refused:
        ask(tmp_path)
    assert refused.type is TypeError or refused.value.code == "invalid_arguments"


@pytest.mark.parametrize("tool", ["claude_create_chat", "claude_resume_chat"])
def test_the_mcp_chat_tools_offer_no_regular_switch(tool):
    assert "regular" not in mcp_tool_arguments(tool)


def test_a_new_chat_is_created_temporary_before_its_first_message():
    claude = FakeClaude({"is_temporary": True})

    result = client_for(claude).send(ORG, "hello", MODEL, new_chat_id=CHAT)

    assert claude.paths()[:2] == [("POST", CREATE), ("POST", COMPLETION)]
    created, completion = claude.requests[0][2], claude.requests[1][2]
    assert (created["uuid"], created["is_temporary"]) == (CHAT, True)
    # The chat already exists, so the message cannot create a second, differently configured one.
    assert "create_conversation_params" not in completion
    assert (result["is_temporary"], result["response"]) == (True, "ok")


@pytest.mark.parametrize("created", [{"is_temporary": False}, {}, {"is_temporary": "true"}])
def test_a_create_answer_that_is_not_temporary_sends_no_message(created):
    claude = FakeClaude(created)

    with pytest.raises(http.HttpError) as refused:
        client_for(claude).send(ORG, "hello", MODEL, new_chat_id=CHAT)

    assert refused.value.code == "privacy_not_verified"
    assert refused.value.chat_id == CHAT
    assert claude.paths() == [("POST", CREATE)]


def run_chat(tmp_path, monkeypatch, claude, argv, config=None):
    """service.execute for one 'chat' against `claude`, through the real ClaudeHttp."""
    real = http.ClaudeHttp
    monkeypatch.setattr(http, "ClaudeHttp", lambda saved, timeout=120: real(saved, timeout=timeout, session_factory=lambda: claude))
    session = {"cookies": [], "origins": []}
    api = SimpleNamespace(
        HTTP_CONFIG_FILE=tmp_path / "http-config.json", load_session=lambda: session, atomic_write=state.atomic_write
    )
    (tmp_path / "http-config.json").write_text(json.dumps(config or {}), encoding="utf-8")
    return service.execute(cli.parse_args(["chat", "--prompt", "hello", *argv, "--request-timeout", "5"]), api=api)


def test_a_refused_model_falls_back_inside_the_chat_already_created(tmp_path, monkeypatch):
    # The login's model is one claude.ai no longer lets this account use (seen 2026-10-06): the next model answers,
    # in the one Incognito chat already created and confirmed, never a second create.
    claude = FakeClaude({"is_temporary": True}, refuse={"claude-sonnet-9"})

    result = run_chat(tmp_path, monkeypatch, claude, [], config={"model": "claude-sonnet-9"})

    assert [p for m, p in claude.paths() if m == "POST" and p == CREATE] == [CREATE]
    sent = [body["model"] for _, path, body in claude.requests if path.endswith("/completion")]
    assert sent == ["claude-sonnet-9", "claude-haiku-9"]
    assert result["is_temporary"] is True


def test_the_registry_keeps_what_claude_answered_not_what_was_asked(tmp_path, monkeypatch):
    claude = FakeClaude({"is_temporary": False})

    with pytest.raises(http.HttpError) as refused:
        run_chat(tmp_path, monkeypatch, claude, ["--model", MODEL])

    assert not any(path.endswith("/completion") for _, path in claude.paths())
    registry = ChatRegistry(tmp_path / "chats.sqlite3")
    try:
        row = registry.get(refused.value.chat_id)
    finally:
        registry.close()
    assert row["is_temporary"] is False
