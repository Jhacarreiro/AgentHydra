"""Free web accounts first: a task may be answered by one of the owner's signed-in Free claude.ai or chatgpt.com
accounts, which AgentHydra manages, before any paid API leg is used: a tool-free task in one message, and a tool task
offered only the tools its profile may use there (config.ROUTE_VIA_FREE_TOOLS, ROUTE_VIA_FREE_TOOL_PROFILES, and the edit
and shell tools for ROUTE_VIA_FREE_EDIT_PROFILES and ROUTE_VIA_FREE_SHELL_PROFILES) as a thread that runs them through a
text protocol (free_client.py). A task that may edit or run a shell works in a scratch copy of its folder (scratch.py):
its changes land in the real folder only when its answer is accepted, so a try that fails leaves nothing behind.
`consult` reads `free_status`, sends one `free_chat` task and polls `free_results` over AgentHydra's MCP endpoint
(POST /api/mcp, stateless JSON-RPC).

Never a failure of its own: the daemon down or slow, not ready, no idle signed-in account, a refused send, a failed or
timed-out task, or an answer that is not the JSON the schema asks for keeps the task on its API route, logged once per job.
The route taken is on the result (`selection["route"]`) and its ledger line (provider `free`, cost 0). A free account only
answers text: no tool field, no system-prompt field, so the system text rides in the prompt."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter

from . import config, scratch
from .climayte_route import base_url
from .free_client import FreeChatClient, TurnError, redo, tool_names_allowed, turn
from .spec import Result, Task, inline_files, now_iso

log = logging.getLogger("hswarm.free")

STATUS_TIMEOUT_S = 5.0  # 2 s sent every task to the API while the daemon stalled (39 jobs at 23:51-00:00Z, 2026-10-07)
MAX_PROMPT_CHARS = 100_000
WAIT_S = 40  # the daemon waits at most 45 s per call
WAIT_CAP_S = 240  # the longest a free account may hold a task before it goes back to its API route, whatever its timeout_s
TOOL_CAP_S = 600  # the longest a tool task may run on a Free thread before it goes back to its API route
HAIKU_PROFILES = ("routine", "general")
_LOGGED: set[str] = set()
_ACTIVE = 0  # tasks on a free account right now, across every job of this process (route_via_free_max)
# When this process sent each task still running: free_status shows a sent task's account busy once the daemon has
# started it (a status read and one POST, well under a second), so until then the task is subtracted from the idle
# count. Kept short: a sent task that free_status already shows is subtracted twice for this long, as _ACTIVE once was
# for good. A task's stamp leaves the list when the task ends.
_SENT: list[float] = []
UNSEEN_S = 2.0
SCHEMA_LINE = "Answer with only one JSON value that satisfies this JSON Schema, with no prose and no code fence:"
# A failed Free try moves its task to another account (_movable) for at most MOVES more tries, inside the task's cap.
MOVES = 2
ROOM_POLL_S = 5.0  # how often a job task waiting for a Free account with room reads free_status again (consult, wait)
PROBE_EVERY_S = 600.0  # one task per provider in this long is sent past its health gate (_pick), to learn whether it is back
SICK_SENT, SICK_SHARE = 10, 0.2  # a provider with this many sends in the last hour, mostly failed, is shut (_sick)
WEEK_FULL_PCT = 90  # a Claude account this far into its week takes no new thread (mcp-free.ts)
# A failed turn's error opens with its code (free_chat's shape, AgentHydra mcp-free.ts). MOVE_CODES and MOVE_TEXT are the
# account's or thread's own failures: the task may go to another Free account. NOT_SENT codes wrote nothing into the chat,
# so the provider is at fault and the task also skips that provider for the rest of its tries.
MOVE_CODES = ("rate_limited", "answer_not_confirmed", "generation_error", "operation_interrupted", "browser_preparation_",
              "stream_interrupted", "login_", "http_rejected")
MOVE_TEXT = ("free accounts unavailable", "No signed-in Free")
NOT_SENT = ("browser_preparation_", "browser_pool_unavailable", "browser_busy")
_PROBED: dict[str, float] = {}  # provider -> when a task was last sent past its health gate (_pick)
EDIT_TOOLS = frozenset({"write_file", "edit_file", "bash", "bash_start"})  # a task offered any of these works in a scratch copy
# Off only in the A/B (free_ab.py): an accepted scratch leg's changes go on its route note as a diff instead of landing.
LAND = True


def eligible(task: Task) -> bool:
    """A text-only, auto-routed API task of an ordinary profile that no rule keeps off a third-party chat, offered no
    tool, or only tools a Free thread may run (config.ROUTE_VIA_FREE_TOOLS) on a profile that may use them there
    (config.ROUTE_VIA_FREE_TOOL_PROFILES); a tool-free task's profile must be one of config.ROUTE_VIA_FREE_PROFILES.
    A CliMayte worker's own asks qualify: the worker guard is climayte_route's (a worker must not start another worker),
    and copied here it kept every tool-free ask a worker made off the Free accounts (5,400 in 48 h, 5 of them on Free,
    2026-10-09; owner: "why you're running nothing on there")."""
    if not config.ROUTE_VIA_FREE or not base_url():
        return False
    if getattr(task, "images", None) or task.zdr:
        return False
    if task.purpose == "evaluation" or task.backend != "api":
        return False
    # An auto task carries its profile and, once built, the plan's first concrete model (spec._resolve_backend); a
    # pinned one has no profile. So the profile, never `model == auto`, says whether HSwarm may choose the route. Each
    # kind of task has its own list: critical read work goes to Free (Luna Thinking held level with the API on it),
    # critical tool-free work was never measured there and does not.
    if task.tools != "none":
        if task.profile not in config.ROUTE_VIA_FREE_TOOL_PROFILES or not tool_names_allowed(task):
            return False
        if editing(task) and not _scratchable(task):
            return False
    elif task.profile not in config.ROUTE_VIA_FREE_PROFILES:
        return False
    return len(shape(task)) <= MAX_PROMPT_CHARS


def editing(task: Task) -> bool:
    """Whether a task is offered a tool that changes its folder (EDIT_TOOLS), so its Free legs work in a scratch copy."""
    from .toolspecs import tool_names

    try:
        return task.tools != "none" and bool(set(tool_names(task.tools)) & EDIT_TOOLS)
    except ValueError:
        return False


def _scratchable(task: Task) -> bool:
    """Whether an edit or shell task can work in a scratch copy: its tools run on this host (a runtime's run elsewhere),
    it has no shell_grants (they allow git writes, and a worktree shares its checkout's refs, so a commit there would not
    stay in the copy), no capability grant and no scripted replay (both judge the real folder), and its folder was not
    just refused a copy (scratch.refused_recently)."""
    return (task.runtime in ("", "host") and not task.shell_grants and not task.capability and not task.scripted
            and bool(task.cwd) and os.path.isabs(task.cwd) and not scratch.refused_recently(task.cwd))


def shape(task: Task) -> str:
    """The task as a chat message: system text under a heading, the prompt, inlined files, then the schema line."""
    parts = []
    if task.system and task.system.strip():
        parts.append("# Instructions\n\n" + task.system.strip())
    parts.append(inline_files(task, task.prompt.strip()))
    if task.schema:
        # Compact: the same schema without the space after every comma and colon, which every free call paid for.
        parts.append(SCHEMA_LINE + "\n" + json.dumps(task.schema, ensure_ascii=False, separators=(",", ":")))
    return "\n\n".join(parts)


def _say(job_id: str, msg: str) -> None:
    if job_id not in _LOGGED:
        _LOGGED.add(job_id)
        log.warning("job %s: %s", job_id, msg)


def _rpc(name: str, arguments: dict, timeout: float) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(base_url() + "/api/mcp", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            doc = json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise OSError(f"HTTP {e.code}") from e
    result = doc.get("result") or {}
    if result.get("isError"):
        # The daemon's words are kept: a send refused as name_conflict proves the first send landed (free_client._recover).
        text = ((result.get("content") or [{}])[0] or {}).get("text") or ""
        raise OSError(f"tool error: {text[:200]}")
    return json.loads(result["content"][0]["text"])


async def _call(name: str, arguments: dict, timeout: float) -> dict:
    # to_thread cannot stop a socket early, so the wait is bounded here as well as on the socket
    return await asyncio.wait_for(asyncio.to_thread(_rpc, name, arguments, timeout), timeout + 0.5)


_ERRORS = (OSError, ValueError, KeyError, IndexError, TypeError, asyncio.TimeoutError)


def _idle(status: dict, provider: str | None = None, exclude=()) -> int:
    """Signed-in accounts neither busy, resting after a failed send (mcp-free.ts restingFor), paced out of new chats for
    now (mcp-free.ts pacedOut), holding a lease for another thread (leased), past the week's cut or on the task's exclude
    list; with a provider, only that provider's accounts with room (_room)."""
    if not status.get("ready"):
        return 0
    return sum(1 for a in status.get("accounts") or []
               if isinstance(a, dict) and a.get("signedIn") and not a.get("busy") and not a.get("resting")
               and not a.get("paced") and not a.get("leased") and a.get("num") not in exclude and _week(a)
               and (provider is None or (a.get("provider") == provider and _room(a))))


CLAUDE_FAMILIES = ("haiku", "sonnet")  # the only model names that are Claude's; every other name is ChatGPT's
CLAUDE_FULL_PCT = 80  # a Claude account this far into its 5-hour window is not asked for a thread (mcp-free.ts roomBand 3)


def _room(account: dict) -> bool:
    """Whether a Claude account's 5-hour window has room for a thread of several messages: free_status's five_hour_pct.
    null (no reading yet) counts as room, and so does a window whose reset has passed (the daemon reads that as 0).
    ChatGPT's everyday text has no window."""
    pct = account.get("five_hour_pct")
    return account.get("provider") != "claude" or not isinstance(pct, (int, float)) or pct < CLAUDE_FULL_PCT


def _week(account: dict) -> bool:
    """Whether a Claude account's week has room. free_status gives the week only in its usage text ("5h 43%, week 19%")."""
    m = re.search(r"\bweek (\d+)%", str(account.get("usage") or ""))
    return account.get("provider") != "claude" or not m or int(m.group(1)) < WEEK_FULL_PCT


def _sick(health) -> bool:
    """Whether a provider's providerHealth (free_status) shuts it for new tasks: the daemon's rest is in force, or most of
    its sends in the last hour failed (SICK_SENT sends at an ok share under SICK_SHARE)."""
    if not isinstance(health, dict):
        return False
    share = health.get("okShare")
    return bool(health.get("down")) or (int(health.get("sent") or 0) >= SICK_SENT and share is not None and share < SICK_SHARE)


def _probe(provider: str | None) -> bool:
    """One task per provider per PROBE_EVERY_S goes past its health gate, so a provider that came back is found again."""
    now = time.monotonic()
    if provider is None or now - _PROBED.get(provider, -PROBE_EVERY_S) < PROBE_EVERY_S:
        return False
    _PROBED[provider] = now
    return True


def _ask(ask: str) -> tuple[str, str | None]:
    """A route_via_free_tool_asks entry as free_chat's (model, provider): "sonnet@claude", or "gpt-6" (ChatGPT's).
    Any model name that is not "haiku" or "sonnet" is ChatGPT's (a role name like gpt-instant, a pinned name like
    luna-thinking, or a slug); an explicit "@provider" wins."""
    model, _, provider = ask.partition("@")
    return model, provider or ("chatgpt" if model and model not in CLAUDE_FAMILIES else None)


def _pick(task: Task, status: dict, unseen: int, skip=(), exclude=()) -> tuple[str, str | None] | None:
    """The (model, provider) a task's Free thread asks for, or None when no account can take it now. A tool task takes
    config.ROUTE_VIA_FREE_TOOL_ASKS for its profile, a tool-free one config.ROUTE_VIA_FREE_ASKS: the first ask whose
    provider has an idle account with room is taken. A provider the health gate shuts (_sick) is passed over unless its
    probe is due (_probe), and so is one in `skip` (a provider a failed try named). A profile with no asks asks for its
    Claude family on whichever account is idle."""
    asks = (config.ROUTE_VIA_FREE_TOOL_ASKS if task.tools != "none" else config.ROUTE_VIA_FREE_ASKS).get(task.profile or "")
    if not asks:
        family = "haiku" if task.profile in HAIKU_PROFILES else "sonnet"
        return (family, None) if _idle(status, exclude=exclude) - unseen > 0 else None
    health = status.get("providerHealth") or {}
    for model, provider in map(_ask, asks):
        if provider in skip or _idle(status, provider, exclude) - unseen <= 0:
            continue
        if _sick(health.get(provider)) and not _probe(provider):
            continue
        return model, provider
    return None


def _short(status: dict, capped: bool) -> dict | None:
    """The note for an eligible task no Free account could take (the shortfall report counts these, shortfall.py):
    `short_why` is `capped` (route_via_free_max), `signed_out` (no account signed in), or what held most signed-in
    accounts (busy, paced or resting). None while the daemon is not ready, which says nothing about how many accounts
    it would take."""
    if not status.get("ready"):
        return None
    signed = [a for a in status.get("accounts") or [] if isinstance(a, dict) and a.get("signedIn")]
    if capped:
        why = "capped"
    elif not signed:
        why = "signed_out"
    else:
        why = Counter("paced" if a.get("paced") else "resting" if a.get("resting") else "busy" for a in signed).most_common(1)[0][0]
    return {"via": "api", "short": "free", "short_why": why}


def _tokens(text: str) -> int:
    return -(-len(text) // 4)


GPT_MODEL = "gpt-5-6-mini"
CLAUDE_MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}


def miss_model(task: Task, one: dict | None = None, accounts: list | None = None) -> str:
    """`free:<model>` for a Free try that was not accepted: the model the answering account named, else the one its
    provider gives for the family HSwarm asked for (Haiku for narrow profiles, Sonnet otherwise; a ChatGPT account
    ignores the family). The provider comes from the reply, the account's status entry, or the only provider among the
    signed-in accounts; `free:unknown` only when none of that is known."""
    one = one or {}
    if one.get("model"):
        return "free:" + str(one["model"])
    prov = str(one.get("provider") or "").lower()
    accts = [a for a in accounts or [] if isinstance(a, dict)]
    if not prov:
        name = one.get("account")
        for a in accts:
            if name is not None and name in (a.get("id"), a.get("name"), a.get("account"), a.get("num")):
                prov = str(a.get("provider") or "").lower()
    if not prov:
        seen = {str(a.get("provider") or "").lower() for a in accts if a.get("signedIn") and a.get("provider")}
        prov = seen.pop() if len(seen) == 1 else ""
    if "gpt" in prov or "openai" in prov:
        return "free:" + GPT_MODEL
    if "claude" in prov or "anthropic" in prov:
        return "free:" + CLAUDE_MODELS["haiku" if task.profile in HAIKU_PROFILES else "sonnet"]
    return "free:unknown"


def _miss(task: Task, fallback: str, status: str, kind: str, one: dict | None = None, accounts: list | None = None, error: str | None = None) -> dict:
    """The note for a Free try that did not serve the task. `free_miss` marks it for the ledger (jobs books an extra row)."""
    note = {"via": "api", "fallback": fallback, "free_miss": True, "free_model": miss_model(task, one, accounts), "free_status": status,
            "free_kind": kind, "ts": now_iso()}
    if one and one.get("account") is not None:
        note["account"] = one.get("account")
    if error:
        note["error"] = error
    return note


def _result(task: Task, one: dict, why: str, started: str, job_id: str) -> Result | None:
    from .worker import payload_in_text

    text = str(one.get("response") or "").strip()
    if not text:
        _say(job_id, "the free account's reply was empty; the task runs on its API route")
        return None
    # `seconds` is the account's own time on it (free_results), so the ledger shows how busy the Free accounts are.
    on_account = float(one.get("seconds") or 0.0)
    res = Result(id=task.id, backend=task.backend, model="free:" + str(one.get("model") or "unknown"), status="ok", turns=1,
                 answer=text, cost_usd=0.0, started=started, finished=now_iso(), seconds=on_account,
                 api_seconds=on_account)
    # A web chat reports no token counts, so the ledger gets an estimate (4 characters a token, as Desk's Free tab
    # counts them); without one every Free answer was ledgered as 0 tokens (2026-10-09).
    res.usage = {"in_hit": 0, "in_miss": _tokens(shape(task)), "out": _tokens(text), "reasoning": 0}  # ledger line: token_basis chars/4
    if task.schema:
        data = payload_in_text(text, task.schema)  # strips a code fence; the same schema check as the API route
        if data is None:
            _say(job_id, "the free account's reply did not match the task's schema; the task runs on its API route")
            return None
        res.data = data
    res.selection = {"route": {"via": "free", "account": one.get("account"), "chat_id": one.get("chat_id"), "why": why,
                               **({"recovered": 1} if one.get("recovered") else {})}}
    return res


# A tool-free turn that gave no reply, by where it stopped (free_client.TurnError.stage): its note's fallback, status and
# kind, which `hswarm` reads back from the ledger (commands.py).
_TURN_MISS = {"send": ("free send failed", "error", "unavailable"), "refused": ("free chat refused", "error", "unavailable"),
              "failed": ("free account failed", "error", "unavailable"), "timeout": ("free account timed out", "timeout", "timeout"),
              "results": ("free results unavailable", "error", "unavailable")}


def _fail_text(e: TurnError | None) -> str | None:
    """The daemon's error for a turn that gave no reply: its code leads (free_chat's shape), else the turn's own words."""
    if e is None:
        return None
    return str(e.one.get("error") or "") or str(e.body)


def _movable(error: str | None) -> bool:
    """Whether a failed Free try's error is the account's or its thread's own, so another Free account may serve the task."""
    text = (error or "").strip()
    return text.startswith(MOVE_CODES) or any(t in text for t in MOVE_TEXT)


def _provider_wide(error: str | None) -> bool:
    """Whether a failed Free try sent nothing and so names its provider, not its account (NOT_SENT)."""
    return (error or "").strip().startswith(NOT_SENT)


def _row(status: dict, label) -> dict | None:
    """The free_status row of the account a Free reply named (its label, as free_status shows it)."""
    return next((a for a in status.get("accounts") or [] if isinstance(a, dict) and label is not None and a.get("account") == label), None)


def _last(failed: list[dict], note: dict | None) -> dict | None:
    """The note a task ends on when no further Free try can serve it: its last failed try, with the earlier failed tries
    under `earlier` (jobs books each one as a Free miss row). `note` when nothing failed on an account."""
    if not failed:
        return note
    last = dict(failed[-1])
    if len(failed) > 1:
        last["earlier"] = failed[:-1]
    return last


async def _status_read() -> dict | None:
    """free_status for a task already under way (a move, or a wait for room); None when the daemon cannot say."""
    try:
        status = await _call("free_status", {}, STATUS_TIMEOUT_S)
    except _ERRORS:
        return None
    return status if isinstance(status, dict) else None


async def _release(chat_id) -> None:
    """Ends a thread's lease on its Claude account (free_release) when its task is done. A failed release is ignored: the
    lease lapses four minutes after the thread's last turn."""
    if not chat_id:
        return
    try:
        await _call("free_release", {"chat_id": str(chat_id)}, STATUS_TIMEOUT_S)
    except _ERRORS:
        pass  # floor-ok: best effort; an unreleased lease lapses four minutes after the thread's last turn


async def _serve(job_id: str, task: Task, ask: tuple[str, str | None], accounts: list | None, timeout_s: float,
                 exclude: list[int], moved: int = 0) -> tuple[Result | None, dict | None, str | None]:
    """A tool-free task in one message on a Free account. (result, None, None) when it was answered; else (None, the miss,
    the daemon's error when the account or its thread is at fault, which may move the task: _movable). A try after a move
    (`moved`) names its thread with the suffix ' m<k>', as a tool task's moved thread does (free_client)."""
    started = now_iso("milliseconds")
    model, provider = ask
    item = {"prompt": shape(task), "name": f"hswarm {job_id} {task.id}" + (f" m{moved}" if moved else "")}
    # The ask names the model (ROUTE_VIA_FREE_ASKS): narrow work asks for the lightest Claude model (Haiku 5.5) (owner,
    # 2026-10-07: low-impact Haiku 5.5 through free instances where possible); research and decision ask for Sonnet by
    # name, since "the account's usual one" is its last turn's model, which those Haiku asks made Haiku 5.5 on every
    # account (2026-10-10). A ChatGPT ask names no model: its account answers on its own.
    if model:
        item["model"] = model
    if provider:
        item["provider"] = provider
    if exclude:
        item["exclude_accounts"] = list(exclude)
    redone, last = 0, {}
    try:
        while True:
            try:
                one = last = await turn(_call, item, timeout_s)
                break
            except TurnError as e:
                last = e.one
                if redo(e, None, redone):  # ChatGPT failed to answer the new thread: another one (free_client.REDO)
                    redone += 1
                    item = {**item, "name": f"hswarm {job_id} {task.id} g{redone + 1}"}
                    continue
                fallback, status, kind = _TURN_MISS[e.stage]
                _say(job_id, f"{fallback} ({e.body}); the task runs on its API route")
                return None, _miss(task, fallback, status, kind, e.one or None, accounts, e.body[:200]), _fail_text(e)
    finally:
        await _release(last.get("chat_id"))
    why = "tool-free task on a signed-in Free account, no API cost"
    res = _result(task, one, why, started, job_id)
    if res:
        return res, None, None
    return None, _miss(task, "the free reply was unusable", "error", "model", one, accounts), None


async def _serve_tools(job_id: str, task: Task, accounts: list | None, ask: tuple[str, str | None], exclude: list[int],
                       timeout_s: float, resume: list[dict] | None, moved: int, scr: scratch.Scratch | None = None):
    """A tool task on one Free thread: the API loop itself (agent.run_api_task) with a FreeChatClient for its wire, so the
    sandbox, receipts, schema check, loop guard and wall are the API route's own. Returns (result, None, None, messages)
    when it was answered; else (None, the miss, the daemon's error when the account or its thread is at fault, the
    messages so far: the next account resumes them). An edit or shell task's thread works in the scratch copy `scr`, with
    the same sandbox and shell rules rooted there and its shell kept off the real folder (scratch.SHELL_GUARD); what it
    changed stays in the copy until consult lands it."""
    from .agent import run_api_task

    model, provider = ask
    client = FreeChatClient(job_id, task, model, call=_call, provider=provider, exclude=exclude, moved=moved)
    leg = dataclasses.replace(task, model="free:web", timeout_s=min(task.timeout_s, timeout_s),
                              **(scr.leg_fields(task) if scr is not None else {}))
    guard = scratch.SHELL_GUARD.set(scr.real_rx if scr is not None else None)
    try:
        res, msgs = await run_api_task(client, leg, user_tag=job_id, resume_messages=resume)
    finally:
        scratch.SHELL_GUARD.reset(guard)
        await client.aclose()
    one = {"account": client.account, "model": client.model, "chat_id": client.chat_id}
    if res.status != "ok":
        error = (res.error or res.status)[:200]
        _say(job_id, f"a tool task on a Free account ended {res.status} ({error}); it runs on its API route")
        kind = "timeout" if res.status == "timeout" else "unavailable" if error.startswith("free ") else "model"
        note = _miss(task, f"free tool run {res.status}", "timeout" if kind == "timeout" else "error", kind, one, accounts, error)
        return None, note, _fail_text(client.failure), msgs
    res.model = miss_model(task, one, accounts)  # the model that answered, as a Free miss would name it
    res.backend, res.cost_usd = task.backend, 0.0
    res.selection = {**(res.selection or {}), "route": {"via": "free", "account": client.account, "chat_id": client.chat_id,
                                                         "why": "tool task on a Free account through the text tool protocol, no API cost",
                                                         **({"recovered": client.recovered} if client.recovered else {})}}
    return res, None, None, msgs


def _land(task: Task, scr: scratch.Scratch, res: Result) -> None:
    """An accepted scratch leg's changes into the real folder (scratch.land: all or none), and its answer, data and paths
    written as the real folder's. With LAND off (the A/B) the changes go on its route note as a diff instead."""
    changes = scr.changes(res.files_changed)
    route = res.selection.setdefault("route", {})
    if LAND:
        route["landed"] = len(scr.land(changes))
    else:
        route["diff"] = scr.diff(changes)
    real_cwd = scr.real / scr.cwd.relative_to(scr.base)
    res.files_changed = sorted(c.real.relative_to(real_cwd).as_posix() if c.real.is_relative_to(real_cwd) else c.real.as_posix()
                               for c in changes)
    res.answer, res.data, res.error = scr.restore(res.answer), scr.restore(res.data), scr.restore(res.error)
    res.acceptance = scr.restore(res.acceptance)
    res.edit_snapshot = [{**e, "path": scr.restore(e.get("path"))} for e in res.edit_snapshot or [] if isinstance(e, dict)]


async def consult(job_id: str, task: Task, wait: bool = False) -> tuple[Result | None, dict | None]:
    """(a finished Result, notes) when a free account served the task, the notes being the earlier Free tries that failed
    (`earlier`: jobs books each one); (None, note) when the API route runs and the note says why (the last try that
    failed, or no account free to take it); (None, None) when nobody was asked or nothing is worth noting. A job task with
    `wait` whose Free accounts have no room waits up to config.ROUTE_VIA_FREE_WAIT_S for one (ROOM_POLL_S apart). An edit or
    shell task's tries share one scratch copy, made for its first try and dropped when consult ends."""
    if not eligible(task):
        return None, None
    scr: list[scratch.Scratch] = []
    try:
        return await _tries(job_id, task, wait, scr)
    finally:
        if scr:
            await asyncio.to_thread(scr[0].drop)


async def _tries(job_id: str, task: Task, wait: bool, scr: list) -> tuple[Result | None, dict | None]:
    """consult's tries: the Free accounts in turn until one serves the task or none can. `scr` holds the scratch copy."""
    global _ACTIVE
    asked = time.monotonic()
    try:
        status = await _call("free_status", {}, STATUS_TIMEOUT_S)
    except _ERRORS as e:
        _say(job_id, f"free accounts unavailable ({type(e).__name__}); tasks keep their API route")
        return None, None
    if not isinstance(status, dict):
        return None, None
    # _idle already leaves out the accounts this process's running tasks hold (comparing _ACTIVE with it counted each
    # of them twice and stopped a process at 3 of 6 accounts). What it cannot show yet is a task sent moments ago:
    # tasks that read one snapshot at once would all take its one idle account, so those are subtracted here. Unseen is
    # measured from when the snapshot was asked for: measured from its answer, a status read slower than UNSEEN_S (the
    # daemon is allowed STATUS_TIMEOUT_S) aged out a task sent while it waited, and both took the one idle account.
    read_at = asked
    cap_s = TOOL_CAP_S if task.tools != "none" else min(task.timeout_s, WAIT_CAP_S)
    deadline = None  # set when the first try starts: a job task's wait for room does not eat its tries' time
    wait_until = time.monotonic() + config.ROUTE_VIA_FREE_WAIT_S if wait else 0.0
    failed: list[dict] = []  # the notes of the tries that failed on an account, in order
    exclude: list[int] = []  # the instance numbers of the accounts those tries ran on (a new thread must not go there)
    skip: set[str] = set()  # providers a try that sent nothing named (NOT_SENT): not asked again for this task
    carried = None  # a tool task's messages so far, which the next account resumes
    while True:
        capped = config.ROUTE_VIA_FREE_MAX is not None and _ACTIVE >= config.ROUTE_VIA_FREE_MAX
        unseen = sum(1 for t in _SENT if t > read_at - UNSEEN_S)
        ask = None if capped else _pick(task, status, unseen, skip, exclude)
        if ask is None:
            if not capped and not failed and time.monotonic() < wait_until:
                await asyncio.sleep(min(ROOM_POLL_S, max(0.0, wait_until - time.monotonic())))
                read_at = time.monotonic()
                status = await _status_read()
                if status is None:
                    return None, None
                continue
            return None, _last(failed, None if failed else _short(status, capped))
        started_at = time.monotonic()
        if deadline is None:
            deadline = started_at + cap_s
        elif started_at >= deadline:  # the status read after a failed try used up the time: no try starts past the cap
            return None, _last(failed, None)
        _SENT.append(started_at)
        _ACTIVE += 1  # both taken before any await below
        try:
            left = deadline - started_at
            if task.tools == "none":
                res, miss, fail = await _serve(job_id, task, ask, status.get("accounts"), left, exclude, len(failed))
                msgs = None
            else:
                if not scr and editing(task):
                    try:
                        scr.append(await asyncio.to_thread(scratch.open_scratch, task.cwd))
                    except (scratch.ScratchRefused, OSError) as e:
                        scratch.note_refused(task.cwd, str(e))  # eligible() leaves this folder's tasks alone for a while
                        _say(job_id, f"no scratch copy of {task.cwd} for a Free edit leg ({str(e)[:160]}); the task keeps its other routes")
                        return None, _last(failed, None)
                    left = deadline - time.monotonic()
                res, miss, fail, msgs = await _serve_tools(job_id, task, status.get("accounts"), ask, exclude, left,
                                                           carried, len(failed), scr[0] if scr else None)
        finally:
            _ACTIVE -= 1
            if started_at in _SENT:  # a finished task's account is free again, however recently it was sent
                _SENT.remove(started_at)
        if res is not None and scr:
            try:
                await asyncio.to_thread(_land, task, scr[0], res)
            except (scratch.EditConflict, scratch.ScratchRefused, OSError) as e:
                # Not the account's fault: no other Free account is tried, and the task's other routes start from the
                # real folder as it is, none of this leg's changes in it.
                _say(job_id, f"a Free edit leg's changes did not land ({str(e)[:160]}); the task runs on its other routes")
                route = (res.selection or {}).get("route") or {}
                one = {"account": route.get("account"), "model": res.model.removeprefix("free:")}
                failed.append(_miss(task, "free edits did not land", "error", "conflict", one, status.get("accounts"), str(e)[:200]))
                return None, _last(failed, None)
        if res is not None:
            return res, ({"earlier": failed} if failed else None)
        failed.append(miss)
        if not _movable(fail) or len(failed) > MOVES or time.monotonic() >= deadline:
            return None, _last(failed, None)
        row = _row(status, miss.get("account")) or {}
        if isinstance(row.get("num"), int):
            exclude.append(row["num"])
        provider = ask[1] or row.get("provider")
        if provider and _provider_wide(fail):
            skip.add(provider)
        carried = msgs
        log.info("job %s: a Free try failed (%s); the task moves to another Free account", job_id, fail[:80])
        status = await _status_read()
        if status is None:
            return None, _last(failed, None)
        read_at = time.monotonic()


def provider_problems(health) -> list[str]:
    """One line per Free provider the health gate shuts (_sick), for the doctor (health.doctor)."""
    if not isinstance(health, dict):
        return []
    lines = []
    for name, h in sorted(health.items()):
        if not _sick(h):
            continue
        top = h.get("topReason") or "no reason given"
        if h.get("down"):
            lines.append(f"Free {name} sends are down (top reason: {top})")
        else:
            lines.append(f"Free {name}: {float(h['okShare']):.0%} of {h['sent']} sends ok in the last hour (top reason: {top})")
    return lines


async def provider_warnings() -> list[str]:
    """provider_problems over the daemon's free_status; none when the daemon cannot be asked."""
    status = await _status_read()
    return provider_problems((status or {}).get("providerHealth"))
