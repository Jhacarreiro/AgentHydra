#!/usr/bin/env python
"""dredd/lib/ask.py - the resident worker behind every Dredd model call: tool-free asks through HSwarm.

The Boardroom of critics (dredd/boardroom.mjs) needs a model per seat per turn, the resolution loop a
drafter and a Humanizer, rung two a vision score. HSwarm's `ask` is the right door (AUTO at the published profile's evaluated effort,
priced fallbacks, every call in the ledger), but its CLI takes the prompt as an ARGUMENT, and a seat's material -
brief, playbook, the meeting so far - runs past the 32k-character command line Windows allows. So the material
comes in on stdin.

One worker per Node process (lib/brain.mjs starts it on the first call): a process per call paid ~1.6 s of
interpreter start and zswarm import for a call whose model time was ~0.4 s, which was 45% of a hearing's wall
clock (measured 2026-09-22, 49 calls in a 2 min 53 s hearing). Each stdin line is one JSON spec
{"rid", "prompt", "system"?, "schema"?, "model"?, "reasoning_effort"?, "max_tokens"?, "timeout_s"?, "images"?};
each stdout line is HSwarm's own result object (answer, data, model, cost_usd, seconds, error) with the
caller's "rid" beside it. Specs run concurrently, so answers can come back out of order. The worker exits when
stdin closes, after the calls in flight have answered; exit 3 when the installed hswarm package cannot be imported.

`ask.py --capacity [profile]` answers one line and exits instead: whether every route the room's profile walks is
resting on a rate limit, from HSwarm's own plan and key pools (no model call). A sitting reads it before the room
starts its clock and after a room that could not finish (lib/collect.mjs sit, board #7040).
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading


def write(obj: dict) -> None:
    # ASCII-only bytes out: on Windows a cp1252 console cannot encode a curly quote or a narrow space,
    # and the crash that caused (2026-09-21) read to the caller as "the seat passed". stdin is UTF-8 too.
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=True).encode("ascii") + b"\n")
    sys.stdout.flush()


def kwargs_for(spec: dict) -> dict:
    kwargs = {"prompt": str(spec.get("prompt") or ""), "model": spec.get("model") or "auto"}
    if spec.get("system"):
        kwargs["system"] = str(spec["system"])
    if spec.get("schema"):
        kwargs["schema"] = spec["schema"]
    if spec.get("profile") and kwargs["model"] == "auto":
        # The published-profile effort: only AUTO resolves through a profile; an explicit model pin wins.
        kwargs["profile"] = str(spec["profile"])
    if spec.get("reasoning_effort"):
        kwargs["reasoning_effort"] = spec["reasoning_effort"]
    if spec.get("max_tokens"):
        kwargs["max_tokens"] = int(spec["max_tokens"])
    if spec.get("images"):
        # Screenshot paths (rung two's vision score): HSwarm reads and encodes them, and routes AUTO to a model with eyes.
        kwargs["images"] = [str(p) for p in spec["images"]]
    if spec.get("timeout_s"):
        # HSwarm splits this over every route it walks; without it the walk kept its own 120 s, so the board
        # secretary's 300 s never reached it and two Lift boards sat for nothing (2026-09-29). Five seconds short of
        # the wait below, so HSwarm's own answer (which routes it tried) arrives instead of a bare TimeoutError.
        # A short wait (10 s or less) keeps half of it for HSwarm instead, so the inner budget is always the shorter.
        outer = float(spec["timeout_s"])
        kwargs["timeout_s"] = outer - 5 if outer > 10 else outer / 2
    return kwargs


async def answer(ask, spec: dict) -> None:
    rid = spec.get("rid")
    try:
        out = await asyncio.wait_for(ask(**kwargs_for(spec)), timeout=float(spec.get("timeout_s", 120)))
    except Exception as e:  # noqa: BLE001 - the failure goes back to the caller as this call's answer
        write({"status": "error", "error": f"ask failed: {type(e).__name__}: {e}"[:300], "rid": rid})
        return
    if hasattr(out, "__dict__") and not isinstance(out, dict):
        out = dict(out.__dict__)
    # The caller's id goes on last: HSwarm's result carries an "id" of its own, which must not answer for it.
    write({**(out if isinstance(out, dict) else {"status": "ok", "answer": str(out)}), "rid": rid})


def capacity(profile: str) -> dict:
    """How soon each provider the room's plan walks can take a call: the candidates and the routes kept out of
    hswarm_select's plan, each provider's pool read through soonest_wake (0 ready, N s resting, inf all disabled).
    `all_resting` only when no provider is ready and at least one is resting: disabled keys and no key at all are
    not a rate limit, and waiting does not bring them back."""
    from hswarm import config, keys
    from hswarm.mcp_server import hswarm_select

    plan = asyncio.run(hswarm_select(profile=profile, verbose=True))
    if plan.get("error"):
        return {"status": "error", "error": str(plan["error"])[:300]}
    wakes: dict[str, float] = {}
    candidates = plan.get("candidates") or []
    for c in [*candidates, *(plan.get("unavailable") or [])]:
        provider = c.get("provider")
        pool = keys.pool_for(provider) if provider else None
        if pool is None:
            # A planned route with no key pool (a keyless or local route) has no rest to read: it counts as ready, so
            # the room is never held for a rate limit that route does not have.
            if c in candidates:
                wakes[provider or str(c.get("model") or "?")] = 0.0
            continue
        wake = pool.soonest_wake(free=str(config.api_model_id(c.get("model") or "")).endswith(":free"))
        wakes[provider] = min(wake, wakes.get(provider, wake))
    ready = sorted(p for p, w in wakes.items() if w == 0)
    resting = {p: round(w, 1) for p, w in sorted(wakes.items()) if 0 < w < float("inf")}
    return {"status": "ok", "profile": profile, "ready": ready, "resting": resting,
            "disabled": sorted(p for p, w in wakes.items() if w == float("inf")),
            "all_resting": bool(resting) and not ready, "soonest_s": min(resting.values()) if resting else None}


def main() -> None:
    # HSwarm is an installed package (ZSwarm's checkout and ZSWARM_DIR retired 2026-10-03); PYTHONPATH can point
    # at another copy.
    logging.disable(logging.CRITICAL)
    if "--capacity" in sys.argv:
        at = sys.argv.index("--capacity") + 1
        try:
            write(capacity(sys.argv[at] if at < len(sys.argv) else "routine"))
        except Exception as e:  # noqa: BLE001 - an unreadable pool is "unknown" to the caller, never a crash
            write({"status": "error", "error": f"capacity failed: {type(e).__name__}: {e}"[:300]})
        return
    try:
        from hswarm.mcp_server import hswarm_ask
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"cannot import hswarm (pip install -e <AgentHydra>/hswarm): {type(e).__name__}: {e}\n")
        raise SystemExit(3)
    sys.stdin.reconfigure(encoding="utf-8")
    loop = asyncio.new_event_loop()
    closed = asyncio.Event()
    tasks: set[asyncio.Task] = set()

    def start(line: str) -> None:
        try:
            spec = json.loads(line)
        except ValueError as e:
            write({"status": "error", "error": f"bad spec on stdin: {e}"[:300], "rid": None})
            return
        task = loop.create_task(answer(hswarm_ask, spec))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def read() -> None:
        # stdin is read on a thread: a pipe cannot be awaited on Windows' event loop.
        for line in sys.stdin:
            if line.strip():
                loop.call_soon_threadsafe(start, line)
        loop.call_soon_threadsafe(closed.set)

    async def serve() -> None:
        threading.Thread(target=read, daemon=True).start()
        await closed.wait()
        while tasks:
            await asyncio.gather(*list(tasks))

    loop.run_until_complete(serve())


if __name__ == "__main__":
    main()
