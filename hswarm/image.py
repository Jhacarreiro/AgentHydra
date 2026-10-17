"""Image generation routed the way chat is: every provider file's `[images.<name>]` tables are the routes, and AUTO
serves the cheapest route that can do the job and whose provider still has a live key.

A route says what it can do (`modes`), what it costs (`price`), how its request and answer are shaped (`adapter`)
and whether the provider's content filter refuses some scenes (`moderated`):

    modes      "t2i" (a prompt), "edit" (a prompt and an input image whose composition the output keeps),
               "fill" (an image and a mask: inpaint or outpaint)
    price      USD per image, or {per_mp = x} per output megapixel. A route with no price on record has no `price`
               and is served after every priced one: a guessed price would route money by a guess.
    moderated  true where the provider refuses some subjects outright (Stability's 403 "flagged by our content
               moderation", OpenAI's moderation_blocked). A refusal there moves the request to the next route, as an
               out-of-credit key moves it to the next key.

"Funded" is the key pool's word, the same pool chat uses: a key that answered 402 (or a 403/429 saying the balance is
gone) is in the disabled slot and never handed out again, and `hswarm image probe` reads the free balance endpoints
(`[image_balance]`) so a spent key is parked before any request is paid for. A provider whose every key is parked is
not a candidate. Within a provider a refused key moves the request to the next key, at most REFUSED_TRIES of them.

The output is always bytes the caller saves; result URLs are fetched without credentials, because they are on another
host than the API (RunPod's and Replicate's delivery CDNs).
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import time
from collections.abc import Collection
from dataclasses import dataclass, field

import httpx

from . import config, egress, redaction
from .client import _OUT_OF_CREDIT_429, KeyPool, NoUsableKey
from .provider_auth import request_headers

MODES = ("t2i", "edit", "fill")
REFUSED_TRIES = 8
POLL_S = 3.0
_MODERATION = re.compile(r"moderat|flagged|safety system|nsfw|sensitive content|content polic|inappropriate", re.I)


class ImageError(RuntimeError):
    """Every route that could serve the request failed; `attempts` says how each one ended."""

    def __init__(self, message: str, attempts: list[dict]):
        super().__init__(message)
        self.attempts = attempts


class _Refused(Exception):
    """The provider's content filter refused this request: the next route may serve it, the next key will not."""


class _KeyRefused(Exception):
    """The provider refused the key itself before doing anything (invalid, out of balance, rate-limited)."""


@dataclass(frozen=True)
class Route:
    provider: str
    name: str
    adapter: str
    model: str
    modes: tuple[str, ...]
    price: float | None = None
    per_mp: float | None = None
    moderated: bool = False
    max_mp: float | None = None
    spec: dict = field(default_factory=dict, compare=False, hash=False)

    @property
    def id(self) -> str:
        return f"{self.provider}/{self.name}"

    def cost(self, width: int | None, height: int | None) -> float | None:
        if self.price is not None:
            return self.price
        if self.per_mp is not None and width and height:
            return round(self.per_mp * width * height / 1_000_000, 6)
        return None


@dataclass
class Request:
    prompt: str
    mode: str = "t2i"
    image: bytes | None = None
    mask: bytes | None = None
    width: int | None = None
    height: int | None = None
    seed: int | None = None
    output_format: str = "png"


def routes() -> list[Route]:
    out = []
    for provider, spec in config.PROVIDERS.items():
        for name, r in (spec.get("images") or {}).items():
            if not isinstance(r, dict) or r.get("enabled") is False:
                continue
            price = r.get("price")
            per_mp = price.get("per_mp") if isinstance(price, dict) else None
            out.append(Route(provider=provider, name=str(name), adapter=str(r["adapter"]), model=str(r["model"]),
                             modes=tuple(r.get("modes") or ("t2i",)), price=price if isinstance(price, (int, float)) else None,
                             per_mp=per_mp, moderated=bool(r.get("moderated")), max_mp=r.get("max_mp"), spec=r))
    return out


def _pool(provider: str) -> KeyPool | None:
    if not config.provider_enabled(provider):
        return None
    keys = config.load_api_keys(provider)
    return KeyPool(keys, provider) if keys else None


def live_keys(provider: str) -> int:
    pool = _pool(provider)
    return pool.live_besides(()) if pool else 0


def candidates(req: Request, *, route: str | None = None, exclude: Collection[str] = (), max_price: float | None = None,
               allow_moderated: bool = True) -> list[Route]:
    """The routes AUTO would try for `req`, in order: priced cheapest first (unmoderated before moderated at the same
    price), then the routes with no price on record. Only routes whose provider has a live key. `route` names one
    (`provider/name`, or a bare provider for its cheapest route)."""
    if req.mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    pool = [r for r in routes() if req.mode in r.modes and r.id not in exclude and r.provider not in exclude]
    if route:
        pool = [r for r in pool if route in (r.id, r.provider)]
    if not allow_moderated:
        pool = [r for r in pool if not r.moderated]
    if req.width and req.height:
        mp = req.width * req.height / 1_000_000
        pool = [r for r in pool if not r.max_mp or mp <= r.max_mp]
    if max_price is not None:
        pool = [r for r in pool if (c := r.cost(req.width, req.height)) is not None and c <= max_price]
    funded = {p: live_keys(p) > 0 for p in {r.provider for r in pool}}
    pool = [r for r in pool if funded[r.provider]]

    def order(r: Route):
        c = r.cost(req.width or 1024, req.height or 1024)
        return (c is None, c if c is not None else 0.0, r.moderated, r.id)
    return sorted(pool, key=order)


def _data_uri(data: bytes) -> str:
    kind = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg" if data[:2] == b"\xff\xd8" else "webp"
    return f"data:image/{kind};base64," + base64.b64encode(data).decode()


def _aspect(width: int | None, height: int | None, allowed: list[str]) -> str | None:
    """The allowed "W:H" ratio nearest the requested one, by log ratio (2:1 and 1:2 are equally far from 1:1)."""
    if not (width and height and allowed):
        return None
    want = math.log(width / height)

    def dist(a: str) -> float:
        w, h = (float(x) for x in re.split(r"[:x]", a))
        return abs(math.log(w / h) - want)
    return min(allowed, key=dist)


def _refusal(provider: str, pool: KeyPool, key: str, r: httpx.Response) -> None:
    """Raises for a non-success answer: _KeyRefused (another key may serve it, and the pool is told why),
    _Refused (the content filter: another route may), else RuntimeError (the request itself failed here)."""
    status, text = r.status_code, r.text or ""
    if status == 401:
        pool.rest(key, 30.0, status=401, dead=True)
        raise _KeyRefused("401")
    if status == 402 or (status in (403, 429) and _OUT_OF_CREDIT_429.search(text)) or re.search(r"insufficient (credit|balance)|credit limit|no credits remaining", text, re.I):
        pool.broke(key, status=402)
        raise _KeyRefused(f"{status} out of credit")
    if status == 429:
        try:
            wait_s = float(r.headers.get("retry-after", "30"))
        except ValueError:
            wait_s = 30.0
        pool.rest(key, max(1.0, wait_s), status=429)
        raise _KeyRefused("429")
    body = redaction.scrub_keys(text)
    for secret in pool.keys:
        body = body.replace(secret, "[REDACTED_KEY]")
    if status in (400, 403, 422, 451) and _MODERATION.search(text):
        raise _Refused(f"{status} {body[:200]}")
    raise RuntimeError(f"{provider} answered {status}: {body[:300]}")


class _Call:
    """One route's HTTP calls on one key: every request recorded in the egress ledger, the key's refusal classified."""

    def __init__(self, route: Route, pool: KeyPool, key: str, http: httpx.AsyncClient, timeout_s: float):
        self.route, self.pool, self.key, self.http, self.timeout_s = route, pool, key, http, timeout_s
        self.spec = config.PROVIDERS[route.provider]
        self.base = str(route.spec.get("base_url") or self.spec["base_url"]).rstrip("/")

    async def send(self, method: str, path: str, *, json_body=None, files=None, headers=None, poll: bool = False) -> httpx.Response:
        url = path if path.startswith("https://") else self.base + path
        hdrs = {**(self.spec.get("headers") or {}), **request_headers(self.spec, self.key), **(headers or {})}
        req = self.http.build_request(method, url, json=json_body, files=files, headers=hdrs, timeout=self.timeout_s)
        await req.aread()
        if method != "GET":
            egress.record(url, req.content, provider=self.route.provider, model=self.route.model)
        r = await self.http.send(req)
        if not r.is_success:
            if poll and r.status_code >= 500:
                return r
            _refusal(self.route.provider, self.pool, self.key, r)
        return r

    async def fetch(self, url: str) -> bytes:
        """A result URL on the provider's delivery host: fetched with no credentials."""
        r = await self.http.get(url, timeout=self.timeout_s)
        r.raise_for_status()
        return r.content


def _decode(value: str) -> bytes:
    return base64.b64decode(value.split(",", 1)[1] if value.startswith("data:") else value)


async def _runpod(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    inp = {"prompt": req.prompt, "output_format": req.output_format, **(r.spec.get("input") or {})}
    if req.image is not None:
        inp[r.spec.get("image_field", "image")] = _data_uri(req.image)
    if req.mask is not None:
        inp[r.spec.get("mask_field", "mask_image")] = _data_uri(req.mask)
    if req.width and req.height:
        if r.spec.get("size_style") == "wh":
            inp["width"], inp["height"] = req.width, req.height
        else:
            inp["size"] = f"{req.width}*{req.height}"
    if req.seed is not None:
        inp["seed"] = req.seed
    d = (await c.send("POST", f"/v2/{r.model}/runsync", json_body={"input": inp})).json()
    deadline = time.monotonic() + c.timeout_s
    while d.get("status") in ("IN_QUEUE", "IN_PROGRESS") and time.monotonic() < deadline:
        await asyncio.sleep(POLL_S)
        resp = await c.send("GET", f"/v2/{r.model}/status/{d['id']}", poll=True)
        if resp.is_success:
            d = resp.json()
    out = d.get("output") or {}
    if d.get("status") != "COMPLETED" or not isinstance(out, dict):
        why = json.dumps(d.get("error") or out or d.get("status"))[:300]
        raise (_Refused if _MODERATION.search(why) else RuntimeError)(f"runpod {d.get('status')}: {why}")
    src = out.get("result") or out.get("image_url") or (out.get("images") or [None])[0] or out.get("image")
    if not isinstance(src, str):
        raise RuntimeError(f"runpod answered no image: {json.dumps(out)[:200]}")
    data = await c.fetch(src) if src.startswith("http") else _decode(src)
    cost = out.get("cost")
    return data, float(cost) if isinstance(cost, (int, float)) else None


async def _replicate(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    inp = {"prompt": req.prompt, "output_format": req.output_format, **(r.spec.get("input") or {})}
    if req.image is not None:
        field_name = r.spec.get("image_field", "input_image")
        inp[field_name] = [_data_uri(req.image)] if r.spec.get("image_list") else _data_uri(req.image)
    if req.mask is not None:
        inp[r.spec.get("mask_field", "mask")] = _data_uri(req.mask)
    if req.width and req.height:
        if r.spec.get("size_style") == "wh":
            inp["width"], inp["height"] = req.width, req.height
            inp.setdefault("aspect_ratio", "custom")
        elif req.image is None and (ratio := _aspect(req.width, req.height, r.spec.get("aspect_ratios") or [])):
            inp["aspect_ratio"] = ratio
    if req.seed is not None:
        inp["seed"] = req.seed
    d = (await c.send("POST", f"/v1/models/{r.model}/predictions", json_body={"input": inp}, headers={"Prefer": "wait=60"})).json()
    deadline = time.monotonic() + c.timeout_s
    while d.get("status") in ("starting", "processing") and time.monotonic() < deadline:
        await asyncio.sleep(POLL_S)
        resp = await c.send("GET", f"/v1/predictions/{d['id']}", poll=True)
        if resp.is_success:
            d = resp.json()
    if d.get("status") != "succeeded":
        why = str(d.get("error") or d.get("status"))[:300]
        raise (_Refused if _MODERATION.search(why) else RuntimeError)(f"replicate {d.get('status')}: {why}")
    out = d.get("output")
    src = out[0] if isinstance(out, list) and out else out
    if not isinstance(src, str):
        raise RuntimeError("replicate answered no image")
    return await c.fetch(src), None


async def _stability(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    form = {"prompt": req.prompt, "output_format": req.output_format, **{k: str(v) for k, v in (r.spec.get("input") or {}).items()}}
    if req.image is None and (ratio := _aspect(req.width, req.height, r.spec.get("aspect_ratios") or [])):
        form["aspect_ratio"] = ratio
    if req.seed is not None:
        form["seed"] = str(req.seed)
    files = [(k, (None, v)) for k, v in form.items()]
    if req.image is not None:
        files.append(("image", ("image.png", req.image, "image/png")))
    if req.mask is not None:
        files.append(("mask", ("mask.png", req.mask, "image/png")))
    resp = await c.send("POST", r.model, files=files, headers={"Accept": "image/*"})
    return resp.content, None


async def _ideogram(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    form = {"prompt": req.prompt, **{k: str(v) for k, v in (r.spec.get("input") or {}).items()}}
    if ratio := _aspect(req.width, req.height, r.spec.get("aspect_ratios") or []):
        form["aspect_ratio"] = ratio.replace(":", "x")
    if req.seed is not None:
        form["seed"] = str(req.seed)
    files = [(k, (None, v)) for k, v in form.items()]
    if req.image is not None:
        files.append(("image", ("image.png", req.image, "image/png")))
    d = (await c.send("POST", r.model, files=files)).json()
    url = ((d.get("data") or [{}])[0]).get("url")
    if not url:
        raise RuntimeError("ideogram answered no image")
    return await c.fetch(url), None


async def _openai_images(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    body = {"model": r.model, "prompt": req.prompt, "n": 1, **(r.spec.get("input") or {})}
    sizes = r.spec.get("sizes") or []
    if sizes and req.width and req.height:
        body["size"] = _aspect(req.width, req.height, sizes)
    d = (await c.send("POST", "/images/generations", json_body=body)).json()
    item = (d.get("data") or [{}])[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"]), None
    if item.get("url"):
        return await c.fetch(item["url"]), None
    raise RuntimeError("images/generations answered no image")


async def _leonardo(c: _Call, req: Request) -> tuple[bytes, float | None]:
    r = c.route
    body = {"prompt": req.prompt, "modelId": r.model, "num_images": 1, **(r.spec.get("input") or {})}
    if req.width and req.height:
        body["width"], body["height"] = req.width, req.height
    if req.seed is not None:
        body["seed"] = req.seed
    job = ((await c.send("POST", "/v1/generations", json_body=body)).json().get("sdGenerationJob") or {})
    gid = job.get("generationId")
    if not gid:
        raise RuntimeError("leonardo answered no generation id")
    deadline = time.monotonic() + c.timeout_s
    while time.monotonic() < deadline:
        await asyncio.sleep(POLL_S)
        resp = await c.send("GET", f"/v1/generations/{gid}", poll=True)
        g = (resp.json().get("generations_by_pk") or {}) if resp.is_success else {}
        if g.get("status") == "COMPLETE" and g.get("generated_images"):
            return await c.fetch(g["generated_images"][0]["url"]), None
        if g.get("status") == "FAILED":
            raise RuntimeError("leonardo generation failed")
    raise RuntimeError("leonardo generation timed out")


ADAPTERS = {"runpod": _runpod, "replicate": _replicate, "stability": _stability, "ideogram": _ideogram,
            "openai_images": _openai_images, "leonardo": _leonardo}


async def _on_route(route: Route, req: Request, http: httpx.AsyncClient, timeout_s: float, attempts: list[dict]) -> dict | None:
    pool = _pool(route.provider)
    if pool is None:
        return None
    adapter = ADAPTERS[route.adapter]
    tried: set[str] = set()
    while len(tried) < REFUSED_TRIES:
        try:
            key = pool.pick(exclude=tried)
        except NoUsableKey:
            break
        tried.add(key)
        started = time.monotonic()
        try:
            data, reported = await adapter(_Call(route, pool, key, http, timeout_s), req)
        except _KeyRefused as exc:
            attempts.append({"route": route.id, "key_fingerprint": config.fingerprint(key), "error": f"key refused: {exc}"})
            continue
        finally:
            pool.flush()
        estimate = route.cost(req.width, req.height)
        return {"route": route.id, "provider": route.provider, "model": route.model, "key_fingerprint": config.fingerprint(key),
                "cost_usd": reported if reported is not None else estimate,
                "cost_source": "reported" if reported is not None else ("price" if estimate is not None else "unknown"),
                "seconds": round(time.monotonic() - started, 1), "image": data}
    return None


async def generate(req: Request, *, route: str | None = None, exclude: Collection[str] = (), max_price: float | None = None,
                   allow_moderated: bool = True, timeout_s: float = 300.0, transport=None) -> dict:
    """Serve `req` on the cheapest funded route, moving to the next route when a provider has no key left that will
    take it, its content filter refuses, or the request fails there. Returns the route that served it, the key's
    fingerprint, the cost (the provider's reported charge when it sends one, else the route's price) and the image
    bytes under `image`; `attempts` lists every leg that did not."""
    config.refresh()
    order = candidates(req, route=route, exclude=exclude, max_price=max_price, allow_moderated=allow_moderated)
    if not order:
        raise ImageError(f"no funded image route can do {req.mode!r}" + (f" on {route}" if route else ""), [])
    attempts: list[dict] = []
    async with httpx.AsyncClient(transport=transport, follow_redirects=False, timeout=timeout_s) as http:
        for r in order:
            try:
                served = await _on_route(r, req, http, timeout_s, attempts)
            except _Refused as exc:
                attempts.append({"route": r.id, "error": f"refused by the provider's content filter: {exc}"})
                continue
            except (RuntimeError, httpx.HTTPError, ValueError, KeyError) as exc:
                attempts.append({"route": r.id, "error": redaction.scrub_keys(str(exc))[:300]})
                continue
            if served:
                served["attempts"] = attempts
                return served
            attempts.append({"route": r.id, "error": "no key on this provider would take the request"})
    raise ImageError("every image route failed: " + "; ".join(f"{a['route']}: {a['error'][:80]}" for a in attempts[-4:]), attempts)


def _field(d, path: str | list[str]):
    """A dotted path into a JSON answer (a number indexes a list); a list of paths is their sum."""
    if isinstance(path, list):
        vals = [_field(d, p) for p in path]
        nums = [v for v in vals if isinstance(v, (int, float))]
        return sum(nums) if nums else None
    for part in path.split("."):
        if isinstance(d, list) and part.isdigit():
            d = d[int(part)] if int(part) < len(d) else None
        elif isinstance(d, dict):
            d = d.get(part)
        else:
            return None
    return d


async def probe(providers: Collection[str] | None = None, transport=None) -> dict[str, dict]:
    """One free balance read per key for every provider with an `[image_balance]` table: an empty balance parks the
    key (the pool's note_balance), a positive one clears it. Per provider: keys read, funded, total in USD where the
    unit converts (`usd_per_unit`), else in the provider's own unit."""
    config.refresh()
    out: dict[str, dict] = {}
    async with httpx.AsyncClient(transport=transport, timeout=30) as http:
        for provider, spec in config.PROVIDERS.items():
            b = spec.get("image_balance")
            if not isinstance(b, dict) or (providers and provider not in providers):
                continue
            pool = _pool(provider)
            if pool is None:
                continue
            sem = asyncio.Semaphore(8)

            async def one(key: str, b=b, spec=spec, pool=pool):
                async with sem:
                    url = b["url"] if b["url"].startswith("https://") else spec["base_url"].rstrip("/") + b["url"]
                    hdrs = {**(spec.get("headers") or {}), **request_headers(spec, key)}
                    try:
                        r = await http.request(b.get("method", "GET"), url, json=b.get("json"), headers=hdrs)
                    except httpx.HTTPError:
                        return None
                    if r.status_code == 401:
                        pool.rest(key, 30.0, status=401, dead=True)
                        return None
                    if not r.is_success:
                        return None
                    value = _field(r.json(), b["field"])
                    if not isinstance(value, (int, float)):
                        return None
                    usd = value * b["usd_per_unit"] if "usd_per_unit" in b else None
                    funded = value > float(b.get("min", 0))
                    pool.note_balance(key, usd, funded)
                    return value if funded else 0.0
            vals = await asyncio.gather(*(one(k) for k in pool.keys))
            pool.flush()
            read = [v for v in vals if v is not None]
            total = sum(read)
            out[provider] = {"keys": len(pool.keys), "read": len(read), "funded": sum(1 for v in read if v > 0),
                             "total": round(total * b["usd_per_unit"], 2) if "usd_per_unit" in b else round(total, 2),
                             "unit": "usd" if "usd_per_unit" in b else b.get("unit", "units")}
    return out


def table(mode: str | None = None) -> list[dict]:
    """Every image route with what AUTO knows about it: modes, price, moderation, live keys on its provider."""
    live = {p: live_keys(p) for p in {r.provider for r in routes()}}
    rows = []
    for r in routes():
        if mode and mode not in r.modes:
            continue
        rows.append({"route": r.id, "model": r.model, "modes": list(r.modes),
                     "price": r.price if r.price is not None else (f"{r.per_mp}/MP" if r.per_mp is not None else None),
                     "moderated": r.moderated, "live_keys": live[r.provider]})
    return sorted(rows, key=lambda x: (x["live_keys"] == 0, x["price"] is None, str(x["price"]), x["route"]))


async def cmd_image(a) -> int:
    import sys
    from pathlib import Path

    try:
        config.refresh()
        if a.action == "list":
            rows = table(a.mode)
            if a.json:
                print(json.dumps(rows, indent=2))
            else:
                for r in rows:
                    price = "-" if r["price"] is None else f"${r['price']}"
                    print(f"{r['route']:40} {','.join(r['modes']):14} {price:>12}  keys={r['live_keys']:<4} {'moderated' if r['moderated'] else ''}")
            return 0
        if a.action == "probe":
            print(json.dumps(await probe(a.provider and [a.provider]), indent=2))
            return 0
        req = Request(prompt=a.prompt or "", mode=a.mode or ("fill" if a.mask else "edit" if a.image else "t2i"),
                      image=Path(a.image).read_bytes() if a.image else None, mask=Path(a.mask).read_bytes() if a.mask else None,
                      width=a.width, height=a.height, seed=a.seed, output_format=a.format)
        if a.action == "pick":
            order = candidates(req, route=a.route, max_price=a.max_price, allow_moderated=not a.no_moderated)
            print(json.dumps([{"route": r.id, "cost_usd": r.cost(req.width, req.height), "moderated": r.moderated} for r in order], indent=2))
            return 0 if order else 1
        if not a.prompt or not a.output:
            raise ValueError("generate needs --prompt and --output")
        res = await generate(req, route=a.route, max_price=a.max_price, allow_moderated=not a.no_moderated, timeout_s=a.timeout_s)
        Path(a.output).write_bytes(res.pop("image"))
        res["output"] = str(Path(a.output).resolve())
        print(json.dumps(res, indent=2))
        return 0
    except ImageError as exc:
        print(json.dumps({"error": str(exc), "attempts": exc.attempts}, indent=2), file=sys.stderr)
        return 1
    except (ValueError, OSError) as exc:
        print(redaction.scrub_keys(str(exc)), file=sys.stderr)
        return 1
