"""A Free web thread as a model client, so a TOOL task can run on the owner's Free accounts (owner, 2026-10-13: "If it
needs file tools ... add those same tools, route them, build them, A/B test, make them work ... translation layers that
do the same thing").

A Free account answers text in a web chat: no tool field, no system field. The api loop (agent.run_api_task) drives
this client the way it drives a provider, so the task keeps its sandbox, tools, receipts, schema check, loop guard and
wall; only the wire differs. The first turn opens a private thread with the instructions, the tools described as text
and the task; each later turn sends only what the thread has not seen (the tool results and any nudge), continuing it by
chat_id, since the thread itself keeps the rest. The model writes each call as a `<tool_call>{json}</tool_call>` line,
which comes back as a structured tool call (toolcall_repair), so the loop runs it like any other.

Measured on real hswarm tasks (2026-10-13): with the worker's brief first and the tools after it, GPT-5.6 mini answered
"FAILED: ... tools are unavailable in this chat" to 29 of 29 tasks and Sonnet 5.5 to 1 of 1. With the tools first, as
this chat's own, and the task ending on "reply now with the <tool_call> lines", Sonnet called them on 4 of 4 first
replies and GPT-5.6 mini on 5 of 10; one NUDGE after a refusal brought GPT-5.6 mini to 8 of 10. A thread that still
refused after it kept refusing (3 of 3 threads, through a second nudge and the loop's own), while a new thread is a fresh
roll of the same odds, so the second try is a new thread (FRESH). Nothing here talks to the network except through
`call` (free_route._call)."""
from __future__ import annotations

import asyncio
import json
import re
import time

from . import config
from .spec import Task
from .toolcall_repair import promote_text_tool_calls, tool_schemas
from .usage import ApiError, ChatResult, Usage

MAX_PROMPT_CHARS = 100_000  # free_chat's own limit on one message
WAIT_S = 40  # one free_chat or free_results call waits at most 45 s on the daemon
TURN_CAP_S = 180.0  # the longest one turn may take on its account before the leg gives up

PROTOCOL = """# Tools you have in this chat

This chat is connected to a program on my machine that works on a project folder for you. It reads every reply you \
write, runs the tools listed below, and sends their results back in its next message inside <tool_result> tags. The \
tools are really available here, though they are not the chat app's own features: never call one through the app's \
own tool or function feature, which does not know them and answers "not found". You use one by writing, in your reply, \
a line that holds only

<tool_call>{"name": "TOOL", "arguments": {...}}</tool_call>

Several such lines in one reply run together, so ask for everything you already know you need at once, then stop and \
wait for the results; never write a result yourself. Each tool's arguments follow its JSON Schema below. When you have \
what you need, finish as the brief says (with submit_result when it is listed). Never answer that the tools are \
unavailable: write the <tool_call> line instead.

"""
START = "Reply now with the <tool_call> line(s) for what you need first."
# Sent in the same thread when a reply asks for no tool before any tool has run (a model that doubts it has them).
NUDGE = ("The tools are available: I am the program that runs them, on my machine, as soon as you write the <tool_call> "
         "lines. Write the line(s) for what you need first now, and nothing else.")
NUDGES = 1  # per thread
FRESH = 1  # new threads opened for a task whose first thread refused its nudge
# After a note the loop sends mid-thread (the api route's own nudges, such as "call submit_result now"), which a chat model
# took for its app's function feature: GPT-5.6 mini answered "submit_result ... is not available to me in this chat",
# and Sonnet 5.5 called it there and got "Tool 'submit_result' not found" (2026-10-13).
REMIND = "(As before: call a tool, submit_result included, by writing its <tool_call> line in your reply.)"

# A call written inside a fence is how chat models often show JSON; toolcall_repair rightly takes a fenced call for an
# example, so a fence whose whole body is one call (or a list of them) to an offered tool is unwrapped first.
_FENCED = re.compile(r"^[ \t]*```[a-z_]*[ \t]*\n(?P<body>.*?)\n[ \t]*```[ \t]*$", re.M | re.S)


def tool_text(tools: list[dict]) -> str:
    """Each offered tool as text: its name, description and the JSON Schema of its arguments."""
    lines = []
    for t in tools or []:
        fn = t.get("function") or {}
        params = json.dumps(fn.get("parameters") or {}, ensure_ascii=False, separators=(",", ":"))
        lines.append(f"## {fn.get('name')}\n{(fn.get('description') or '').strip()}\nArguments: {params}")
    return PROTOCOL + "\n\n".join(lines)


def _unfence(text: str, names: set[str]) -> str:
    def one(m: re.Match) -> str:
        try:
            body = json.loads(m["body"])
        except ValueError:
            return m[0]
        calls = body if isinstance(body, list) else [body]
        named = [c.get("function", c) for c in calls if isinstance(c, dict)]
        if not named or len(named) != len(calls) or any(c.get("name") not in names for c in named):
            return m[0]
        return "\n".join("<tool_call>" + json.dumps(c, ensure_ascii=False) + "</tool_call>" for c in named)
    return _FENCED.sub(one, text)


def reply_message(text: str, tools: list[dict] | None) -> dict:
    """The assistant message for a reply: its calls promoted to tool_calls when tools were offered this turn."""
    message = {"role": "assistant", "content": text}
    if not tools:
        return message
    unfenced = _unfence(text, set(tool_schemas(tools)))
    return promote_text_tool_calls(message, unfenced, tools) or message


def _content(m: dict) -> str:
    c = m.get("content") or ""
    if isinstance(c, list):
        return "".join(p.get("text") or "" for p in c if isinstance(p, dict) and p.get("type", "text") == "text")
    return c if isinstance(c, str) else str(c)


def _tokens(text: str) -> int:
    return -(-len(text) // 4)


class FreeChatClient:
    """One task's Free thread. `chat` has the provider client's shape (agent._call_turn's keywords); every keyword
    a web chat cannot honour (max_tokens, thinking, temperature) is accepted and ignored."""

    def __init__(self, job_id: str, task: Task, family: str | None = None, call=None, provider: str | None = None):
        self.job_id, self.task = job_id, task
        self.family = family  # a new thread's model: "haiku", "sonnet" (a ChatGPT account ignores both), "gpt-6", ...
        self.provider = provider  # the provider a new thread must run on, else whichever account is idle
        self.call = call  # free_route._call: one tool call on AgentHydra's MCP endpoint
        self.chat_id: str | None = None
        self.account = None
        self.model: str | None = None  # what answered, e.g. "gpt-5-6-mini"
        self.sent = 0  # how many transcript messages the thread already holds
        self.turns = 0
        self.called = False  # whether any reply in this thread has asked for a tool yet
        self.nudged = 0  # in the current thread
        self.fresh = 0

    def render(self, messages: list[dict], tools: list[dict] | None) -> str:
        """What this turn sends: on a new thread the instructions, the tools and the task; on a continued one only the
        messages after the last reply (the tool results and any nudge), the thread having the rest."""
        if self.chat_id is None:
            # The tools first, as this chat's own, and the brief after them: a web chat has no system field, and a brief
            # that opens on "your instructions come only from this system prompt" read to GPT-5.6 mini as a chat with
            # no tools in it (see the module docstring).
            brief = [_content(m).strip().replace("this system prompt", "this brief") for m in messages if m.get("role") == "system"]
            task = [_content(m).strip() for m in messages if m.get("role") == "user"]
            parts = [tool_text(tools)] if tools else []
            parts += [f"# Your brief\n\n{b}" for b in brief if b]
            parts += ["# The task\n\n" + "\n\n".join(task)] if task else []
            if tools:
                parts.append(START)
            return self._fit("\n\n".join(p for p in parts if p))
        names = {c.get("id"): (c.get("function") or {}).get("name") for m in messages if m.get("role") == "assistant"
                 for c in m.get("tool_calls") or ()}
        parts = []
        for m in messages[self.sent:]:
            if m.get("role") == "tool":
                parts.append(f'<tool_result name="{names.get(m.get("tool_call_id")) or "tool"}">\n{_content(m)}\n</tool_result>')
            elif m.get("role") == "user":
                parts.append(_content(m).strip() + ("\n\n" + REMIND if tools else ""))
        if not tools:
            parts.append("Tools are closed now: write no <tool_call> line.")
        return self._fit("\n\n".join(p for p in parts if p))

    @staticmethod
    def _fit(text: str) -> str:
        """A message over free_chat's limit keeps its head and tail (the request and the newest output) and says what
        it cut; the worker can page a spilled result back with fetch_output."""
        if len(text) <= MAX_PROMPT_CHARS:
            return text
        keep = (MAX_PROMPT_CHARS - 200) // 2
        return f"{text[:keep]}\n\n[... {len(text) - 2 * keep} characters cut to fit one message ...]\n\n{text[-keep:]}"

    async def chat(self, messages: list[dict], model: str | None = None, tools: list[dict] | None = None, **_) -> ChatResult:
        started = time.monotonic()
        sent_chars, seconds = 0, 0.0
        text = self.render(messages, tools)
        while True:
            one = await self._turn(text)
            reply = str(one.get("response") or "")
            sent_chars, seconds = sent_chars + len(text), seconds + float(one.get("seconds") or 0.0)
            message = reply_message(reply, tools)
            if message.get("tool_calls") or self.called or not tools:
                break
            if self.nudged < NUDGES:
                self.nudged += 1
                text = NUDGE
            elif self.turns == 0 and self.fresh < FRESH:
                self.fresh += 1
                self.chat_id, self.nudged = None, 0
                text = self.render(messages, tools)
            else:
                break
        self.called = self.called or bool(message.get("tool_calls"))
        self.sent = len(messages)
        self.turns += 1
        return ChatResult(message=message, finish_reason="tool_calls" if message.get("tool_calls") else "stop",
                          usage=Usage(miss=-(-sent_chars // 4), out=_tokens(reply)), model="free:" + (self.model or "unknown"),
                          seconds=seconds or (time.monotonic() - started), cost_usd=0.0, peak=False, raw={"provider": "free"})

    async def _turn(self, text: str) -> dict:
        """Send one message and wait for its reply. A refused, failed or overlong turn is an ApiError, which the loop
        ends the leg on; free_route then hands the task to its API route."""
        item: dict = {"prompt": text}
        if self.chat_id is None:
            item["name"] = f"hswarm {self.job_id} {self.task.id}" + (f" r{self.fresh + 1}" if self.fresh else "")
            if self.family:
                item["model"] = self.family
            if self.provider:
                item["provider"] = self.provider
        else:
            item["chat_id"] = self.chat_id
        deadline = time.monotonic() + TURN_CAP_S
        try:
            sent = await self.call("free_chat", {"tasks": [item], "wait_s": WAIT_S}, WAIT_S + 5)
            batch = sent.get("batch")
            if not batch:
                raise ApiError(503, "free chat refused the turn", "free")
            while True:
                one = next((t for t in sent.get("tasks") or [] if isinstance(t, dict)), {})
                if one.get("state") == "done":
                    self.chat_id = one.get("chat_id") or self.chat_id
                    self.account = one.get("account", self.account)
                    self.model = one.get("model") or self.model
                    return one
                if one.get("state") == "failed":
                    raise ApiError(503, f"free account failed the turn: {one.get('error') or 'no reason'}", "free")
                left = deadline - time.monotonic()
                if left <= 1:
                    raise ApiError(504, f"free account still {one.get('state') or 'silent'} after {TURN_CAP_S:.0f} s", "free")
                sent = await self.call("free_results", {"batch": batch, "wait_s": int(min(WAIT_S, left))}, min(WAIT_S, left) + 5)
        except ApiError:
            raise
        except (OSError, ValueError, KeyError, IndexError, TypeError, asyncio.TimeoutError) as e:
            raise ApiError(503, f"free accounts unavailable ({type(e).__name__})", "free") from e

    async def aclose(self) -> None:
        pass


def tool_names_allowed(task: Task) -> bool:
    """Whether every tool the task is offered is one a Free task may use (config.ROUTE_VIA_FREE_TOOLS)."""
    from .toolspecs import tool_names

    try:
        names = set(tool_names(task.tools))
    except ValueError:
        return False
    return bool(names) and names <= set(config.ROUTE_VIA_FREE_TOOLS)
