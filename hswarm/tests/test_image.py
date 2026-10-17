"""`hswarm image`: AUTO serves the cheapest funded image route, skips a provider whose keys are all spent, and moves a
request the provider's content filter refused to the next route. Offline: mocked transport, throwaway key files."""
from __future__ import annotations

import asyncio
import base64
import json

import httpx

from hswarm import config, image
from hswarm.client import KeyPool

PNG = b"\x89PNG\r\n\x1a\n" + b"unit-png"


def _keys(provider: str, *keys: str) -> None:
    config.SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    (config.SECRETS_DIR / f"{provider}_api_keys").write_text("\n".join(keys) + "\n", encoding="utf-8")


def test_auto_serves_the_cheapest_funded_route_and_skips_a_spent_pool():
    _keys("runpod", "unit-rp")
    _keys("replicate", "unit-rep-a", "unit-rep-b")
    t2i = image.Request(prompt="p", width=1024, height=1024)
    # runpod schnell at 0.0024/MP (about 0.0025 here) beats replicate schnell's flat 0.003; unpriced and moderated
    # routes come after every priced one; stabilityai has no keys at all and is not offered.
    order = [r.id for r in image.candidates(t2i)]
    assert order[:3] == ["runpod/flux-1-schnell", "replicate/flux-schnell", "runpod/flux-1-dev"]
    assert not any(r.startswith("stabilityai/") for r in order)
    pool = KeyPool(config.load_api_keys("replicate"), "replicate")
    for k in pool.keys:
        pool.broke(k, status=402)
    pool.flush()
    edit = image.Request(prompt="p", mode="edit", image=PNG, width=704, height=1536)
    assert [r.id for r in image.candidates(edit)] == ["runpod/flux-1-kontext-dev"]


def test_a_content_filter_refusal_moves_the_edit_to_the_next_route(user_toml, monkeypatch):
    _keys("runpod", "unit-rp")
    _keys("stabilityai", "unit-stab")
    user_toml("stabilityai", '[images.unit-edit]\nadapter = "stability"\nmodel = "/v2beta/unit/edit"\nmodes = ["edit"]\n'
                             'price = 0.001\nmoderated = true\n')
    monkeypatch.setattr(image, "POLL_S", 0)
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        url = str(req.url)
        if url == "https://api.stability.ai/v2beta/unit/edit":
            return httpx.Response(403, json={"errors": ["Your request was flagged by our content moderation system"]})
        if url.endswith("/v2/black-forest-labs-flux-1-kontext-dev/runsync"):
            return httpx.Response(200, json={"id": "job-1", "status": "IN_QUEUE"})
        if url.endswith("/v2/black-forest-labs-flux-1-kontext-dev/status/job-1"):
            return httpx.Response(200, json={"id": "job-1", "status": "COMPLETED",
                                             "output": {"cost": 0.025, "result": "https://cdn.unit.example/out.png"}})
        if url == "https://cdn.unit.example/out.png":
            return httpx.Response(200, content=PNG)
        return httpx.Response(404)

    req = image.Request(prompt="restyle as a woodcut", mode="edit", image=PNG, width=704, height=1536, seed=7)
    res = asyncio.run(image.generate(req, transport=httpx.MockTransport(handler)))

    assert res["route"] == "runpod/flux-1-kontext-dev" and res["image"] == PNG
    assert (res["cost_usd"], res["cost_source"]) == (0.025, "reported")
    assert res["attempts"][0]["route"] == "stabilityai/unit-edit" and "content filter" in res["attempts"][0]["error"]
    sent = json.loads(next(r for r in seen if r.url.path.endswith("/runsync")).content)["input"]
    assert sent["image"] == "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert (sent["size"], sent["seed"], sent["enable_safety_checker"]) == ("704*1536", 7, False)
    assert sent["prompt"] == "restyle as a woodcut"
    # The delivery CDN is another host: the provider key never travels there.
    cdn = next(r for r in seen if r.url.host == "cdn.unit.example")
    assert "authorization" not in {k.lower() for k in cdn.headers}
