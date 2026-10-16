"""Offline query-key authentication: invented provider, isolated homes and MockTransport only."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from hswarm import config, keys, service
from hswarm.client import KeyPool
from hswarm.provider_auth import auth_query, request_headers
from hswarm.service import ServiceClient


PROVIDER = "example_query_auth"
KEY = "unit-query-key-0001"


@pytest.fixture
def provider(monkeypatch):
    spec = {
        "base_url": "https://query.example.test",
        "auth_query": "apikey",
        "headers": {"X-Attribution": "invented-fixture"},
        "key_env": [], "key_files": [],
        "capabilities": ["lookup"],
        "operations": {
            "lookup": {"method": "GET", "path": "/lookup", "capability": "lookup"},
            "submit": {"method": "POST", "path": "/submit", "capability": "lookup"},
        },
    }
    monkeypatch.setitem(config.PROVIDERS, PROVIDER, spec)
    return spec


@pytest.mark.parametrize("value", [None, "", False, 7, [], {}, b"apikey"])
def test_invalid_or_empty_query_field_preserves_default_header_auth(value):
    spec = {"auth_query": value}
    assert auth_query(spec) is None
    assert request_headers(spec, KEY) == {"Authorization": "Bearer " + KEY}


@pytest.mark.parametrize("spec,expected", [
    ({}, {"Authorization": "Bearer " + KEY}),
    ({"auth_header": "X-Api-Key", "auth_prefix": ""}, {"X-Api-Key": KEY}),
    ({"auth_query": "apikey", "headers": {"X-Attribution": "fixture"}}, {"X-Attribution": "fixture"}),
    ({"keyless": True, "headers": {"X-Attribution": "fixture"}}, {"X-Attribution": "fixture"}),
    ({"keyless": True, "auth_query": "apikey", "headers": {"X-Attribution": "fixture"}}, {"X-Attribution": "fixture"}),
])
def test_default_header_only_query_and_keyless_header_selection(spec, expected):
    before = dict(spec)
    assert request_headers(spec, KEY) == expected
    assert spec == before
    assert auth_query({}) is None
    assert auth_query({"auth_query": "apikey"}) == "apikey"


@pytest.mark.parametrize("operation", ["lookup", "submit"])
def test_service_query_auth_preserves_fields_and_overrides_forged_credentials(provider, operation):
    requests = []
    payload = {"query": "invented request", "units": "metric"}
    params = {"apikey": "forged-parameter", "format": "json", "tags": ["one", "two"]}
    if operation == "lookup":
        payload["apikey"] = "forged-payload"

    def reply(request):
        requests.append(request)
        assert request.url.host == "query.example.test"
        assert request.url.params["apikey"] == KEY
        assert request.url.params.get_list("tags") == ["one", "two"]
        assert request.url.params["format"] == "json"
        assert "Authorization" not in request.headers
        assert request.headers["X-Attribution"] == "invented-fixture"
        if operation == "lookup":
            assert request.method == "GET" and not request.content
            assert request.url.params["query"] == payload["query"]
            assert request.url.params["units"] == "metric"
        else:
            assert request.method == "POST" and json.loads(request.content) == payload
        return httpx.Response(200, json={"ok": True})

    async def go():
        async with ServiceClient(PROVIDER, api_keys=[KEY], transport=httpx.MockTransport(reply)) as client:
            return await client.call(operation, payload, params=params)

    assert asyncio.run(go()) == {"ok": True}
    assert len(requests) == 1
    assert params["apikey"] == "forged-parameter"
    if operation == "lookup":
        assert payload["apikey"] == "forged-payload"


def test_401_rotation_replaces_the_query_key_without_losing_request_fields(provider, monkeypatch):
    rejected, accepted = "unit-query-rejected-0001", "unit-query-accepted-0002"
    monkeypatch.setattr(service.random, "randrange", lambda _: 0)
    seen = []

    def reply(request):
        key = request.url.params["apikey"]
        seen.append(key)
        assert request.url.params["query"] == "invented request"
        assert request.url.params["format"] == "json"
        assert "Authorization" not in request.headers
        return httpx.Response(401, json={"error": "invalid key"}) if key == rejected else httpx.Response(200, json={"ok": True})

    async def go():
        async with ServiceClient(PROVIDER, api_keys=[rejected, accepted], transport=httpx.MockTransport(reply)) as client:
            result = await client.call("lookup", {"query": "invented request"}, params={"apikey": "forged", "format": "json"})
            return result, client.key_fingerprint

    assert asyncio.run(go()) == ({"ok": True}, config.fingerprint(accepted))
    assert seen == [rejected, accepted]


def test_free_get_key_check_uses_query_auth_without_authorization(provider, monkeypatch):
    requests = []

    def reply(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.url.host == "query.example.test" and request.url.path == "/api/check"
        assert dict(request.url.params) == {"apikey": KEY}
        assert "Authorization" not in request.headers
        assert request.headers["X-Attribution"] == "invented-fixture"
        return httpx.Response(200, json={"accepted": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: real(*args, transport=httpx.MockTransport(reply), **kwargs))
    pool = KeyPool([KEY], PROVIDER)
    asyncio.run(keys._check_by_get(PROVIDER, provider, KEY, "/api/check", pool))
    assert len(requests) == 1


@pytest.mark.parametrize("keyless", [False, True])
def test_service_header_only_or_keyless_does_not_inject_query_credentials(provider, keyless, monkeypatch):
    spec = {**provider, "auth_header": "X-Api-Key", "auth_prefix": "", "keyless": keyless}
    spec.pop("auth_query")
    monkeypatch.setitem(config.PROVIDERS, PROVIDER, spec)
    seen = []

    def reply(request):
        seen.append(request)
        assert dict(request.url.params) == {"query": "invented request"}
        assert "Authorization" not in request.headers
        if keyless:
            assert "X-Api-Key" not in request.headers
        else:
            assert request.headers["X-Api-Key"] == KEY
        return httpx.Response(200, json={"ok": True})

    async def go():
        async with ServiceClient(PROVIDER, api_keys=["keyless" if keyless else KEY], transport=httpx.MockTransport(reply)) as client:
            return await client.call("lookup", {"query": "invented request"})

    assert asyncio.run(go()) == {"ok": True}
    assert len(seen) == 1
