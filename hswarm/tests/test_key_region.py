"""Offline: a region-locked key finds its own region. DashScope, StepFun, Moonshot and Z.ai sell keys that work only on
the region that issued them: a China key answers 401 on the international endpoint the provider file names (measured
2026-10-16: all 30 DashScope keys and the StepFun key on one machine). The provider file lists its regions
(`region_base_urls`); a key's first 401 asks the others' free model list once, the region that answers is kept on the
key's shared state by fingerprint, and every later request with that key goes there."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, keystate  # noqa: E402  floor-ok: sys.path above must run first, as in every hswarm test
from hswarm.client import ChatClient, KeyPool  # noqa: E402  floor-ok: same

INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
CN = "https://dashscope.aliyuncs.com/compatible-mode/v1"
CN_KEY, INTL_KEY, DEAD_KEY = "sk-region-cn-0001", "sk-region-intl-0002", "sk-region-dead-0003"
HOME = {CN_KEY: CN, INTL_KEY: INTL}  # the one region each key's account was issued in; DEAD_KEY has none


def _dashscope(sent: list):
    """DashScope as its regions behave: a key is served on its own region and refused with 401 everywhere else."""
    def handler(req: httpx.Request) -> httpx.Response:
        key = req.headers["Authorization"].removeprefix("Bearer ")
        sent.append((req.method, str(req.url), key, req.content))
        if not str(req.url).startswith(HOME.get(key, "-") + "/"):
            return httpx.Response(401, json={"error": {"code": "invalid_api_key", "message": "Incorrect API key provided."}})
        if req.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "qwen-plus"}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                          "usage": {"prompt_tokens": 1, "completion_tokens": 1}, "model": "qwen-plus"})
    return httpx.MockTransport(handler)


def _listed() -> set[str]:
    spec = config.PROVIDERS["dashscope"]
    return {spec["base_url"], *spec.get("region_base_urls", ())}


# Contract: keys from two regions share one pool, each served on its own region; the wrong-region key costs one refused
# chat and one free model list, once, and never a strike. Regression: before region_base_urls the China key struck out on
# the international endpoint (every China key looked revoked until a hand-written per-machine base_url overlay).
def test_keys_from_two_regions_share_a_pool_and_each_is_served_on_its_own():
    sent: list = []
    c = ChatClient(api_keys=[CN_KEY, INTL_KEY], provider="dashscope")
    c._http = httpx.AsyncClient(base_url=c.spec["base_url"], transport=_dashscope(sent), headers={"Content-Type": "application/json"})

    async def go():
        async with c:
            return [await c.chat([{"role": "user", "content": f"task {i}"}], model="dashscope:qwen-plus") for i in range(4)]

    assert all(r.content == "OK" for r in asyncio.run(go()))
    assert len(set(sent)) == len(sent), "a request went out twice"
    assert {url.removesuffix("/chat/completions").removesuffix("/models") for _, url, _, _ in sent} <= _listed(), \
        "a key went to a host the provider does not list"
    cn = [(m, url) for m, url, key, _ in sent if key == CN_KEY]
    assert cn == [("POST", INTL + "/chat/completions"), ("GET", CN + "/models"),
                  ("POST", CN + "/chat/completions"), ("POST", CN + "/chat/completions")]
    assert {(m, url) for m, url, key, _ in sent if key == INTL_KEY} == {("POST", INTL + "/chat/completions")}
    rows = {r["fingerprint"]: r for r in KeyPool([CN_KEY, INTL_KEY], "dashscope").status()}
    assert rows[config.fingerprint(CN_KEY)]["region"] == CN and rows[config.fingerprint(CN_KEY)]["strikes"] == 0
    assert rows[config.fingerprint(INTL_KEY)]["region"] is None
    # Kept by fingerprint: the shared state another process (or this one's model watch) reads never holds the key.
    assert keystate.read_all()[config.fingerprint(CN_KEY)]["base_url"] == CN
    assert CN_KEY not in json.dumps(keystate.read_all())


# Contract: a key every listed region refuses is dead exactly as before (a strike, no region), after one free model-list
# ask per other region. Regression: a relocation that loops, records a region that never answered, or spares the strike.
def test_a_key_every_region_refuses_stays_dead():
    sent: list = []
    c = ChatClient(api_keys=[DEAD_KEY], provider="dashscope")
    c._http = httpx.AsyncClient(base_url=c.spec["base_url"], transport=_dashscope(sent), headers={"Content-Type": "application/json"})

    async def go():
        async with c:
            try:
                await c.chat([{"role": "user", "content": "x"}], model="dashscope:qwen-plus")
            except Exception as e:  # noqa: BLE001 - the leg's own error, whichever shape it takes
                return e

    assert asyncio.run(go()) is not None
    others = sorted(_listed() - {INTL})
    assert sorted(url.removesuffix("/models") for m, url, _, _ in sent if m == "GET") == others
    assert [url for m, url, _, _ in sent if m == "POST"] == [INTL + "/chat/completions"]
    row = KeyPool([DEAD_KEY], "dashscope").status()[0]
    assert row["strikes"] == 1 and row["region"] is None


# Contract: a cc run's key reaches its own region through the Anthropic facade too, which builds its own HTTP client.
# Regression: the facade posting every key to base_url, so a China key failed every cc turn on DashScope.
async def test_the_facade_sends_a_run_key_to_its_own_region():
    from hswarm import anthropic_facade as af

    sent: list = []
    async with af.Facade("dashscope", transport=_dashscope(sent)) as f, httpx.AsyncClient(base_url=f.url) as client:
        for turn in ("first", "second"):
            r = await client.post("/v1/messages", headers={"x-api-key": CN_KEY},
                                  json={"model": "qwen-plus", "max_tokens": 10, "messages": [{"role": "user", "content": turn}]})
            assert r.status_code == 200
    assert [(m, url) for m, url, _, _ in sent] == [("POST", INTL + "/chat/completions"), ("GET", CN + "/models"),
                                                   ("POST", CN + "/chat/completions"), ("POST", CN + "/chat/completions")]


# Contract: `hswarm keys` (keys.check) finds the region too, so a China key reads "ok" and its first chat goes straight to
# China. Regression: the check marked every China key rejected and disabled it.
def test_the_key_check_finds_the_region(monkeypatch):
    from hswarm import keys

    monkeypatch.setenv("DASHSCOPE_API_KEYS", CN_KEY)
    sent: list = []
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: real(*a, transport=_dashscope(sent), **kw))
    r = asyncio.run(keys.check("dashscope", config.fingerprint(CN_KEY)))
    assert r["result"] == "ok" and CN_KEY not in json.dumps(r)
    assert [(m, url) for m, url, _, _ in sent] == [("GET", INTL + "/models"), ("GET", CN + "/models")]
    row = KeyPool([CN_KEY], "dashscope").status()[0]
    assert row["region"] == CN and not row["disabled"]
