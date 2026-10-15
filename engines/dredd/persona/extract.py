"""Every message a person typed into a chat on this PC, as the raw material for an owner seat (seats/13-chair.json).

Reads Claude Code transcripts (~/.claude/projects, and AgentHydra's CLI instances under ~/.agenthydra) and Codex
sessions (~/.codex/sessions and archived_sessions). Drops what no person typed: hook and system text, tool results,
task notifications, peer messages between sessions, compaction summaries, headless runs (sdk-cli, codex exec) and
Codex's IDE wrapper (its open tabs are the editor's, the request under them is the person's). Exact repeats fold
into one row with a count. A message an earlier run found stays when its transcript has since been deleted (on
2026-10-08 a re-run read 10,798 messages where the last had 13,470). Each row gets a band:

  human   plainly typed or dictated (short, no structure, no AI tells) - 117 of 120 audited were his (2026-09-25)
  ai      unmistakably written by a model (headings plus bold labels, briefs, handoff prompts)
  review  needs a model to decide (the swarm's classify pass, dredd/persona/README.md)

    python dredd/persona/extract.py            writes tmp/dredd/persona/messages.jsonl and prints the counts

The output is private chat text: it lives under tmp/ (ignored by git) and never leaves this machine.
"""
import collections, glob, json, os, re

HOME = os.path.expanduser("~")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "tmp", "dredd", "persona")

STRIP = [
    "system-reminder", "command-message", "command-name", "local-command-stdout", "local-command-stderr",
    "local-command-caveat", "ide_selection", "ide_opened_file", "ide_diagnostics", "task-notification",
    "ci-monitor-event", "user-prompt-submit-hook", "environment_context", "user_instructions", "turn_aborted",
]
TAG_RES = [re.compile(r"<%s\b[^>]*>.*?</%s>" % (t, t), re.S) for t in STRIP]
PASTE_RE = re.compile(r"<pasted_content\b[^>]*>(.*?)</pasted_content>", re.S)
CMD_NAME = re.compile(r"<command-name>(.*?)</command-name>", re.S)
CMD_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
SKIP_PREFIX = (
    "This session is being continued from a previous conversation", "[Request interrupted by user",
    "Caveat: The messages below were generated", "[SYSTEM NOTIFICATION", "This chat was MOVED from account",
    "Continue from where you left off", "<task-notification", "Base directory for this skill", "Unknown skill:",
    "<local-command",
)
INTERACTIVE = {"claude-desktop", "cli", "claude-vscode", "codex:vscode", "codex:cli", None}
NOT_A_PERSON = {"task-notification", "peer", "channel", "coordinator"}

AI_RES = [re.compile(p, re.M) for p in [
    r"^\s*TL;?DR\b", r"\bYou are (a|an|the) ", r"\bYour (task|job|role) (is|:)", r"\bAcceptance criteria\b",
    r"\bDeliverables?:", r"\bOUTPUT CONTRACT\b", r"\bwhy-not-[hz]swarm\b", r"\bResume \w+ at [A-Z]:\\", r"HANDOFF",
    r"DO NOT ASK THE OWNER", r"\bOwner (directive|ask)\b", r"\((the Chair|the owner), 20\d\d-\d\d-\d\d", r"[⛔★✅\U0001f534]",
    r"\bBudget ≤", r"\bAnswer in ≤", r"\bReturn (only|ONLY) ", r"^Context:", r"^Goal:", r"\bStep \d+[:.]",
    r"\bRespond with\b", r"\bin priority order\b",
]]
HUMAN_RES = [re.compile(p, re.I) for p in [
    r"\b(dont|doesnt|cant|wont|isnt|im|ive|youre|thats|whats|theres|didnt)\b", r"\blol\b", r"\bidk\b", r"\?\?",
    r"\blike, ", r"\bum+\b", r"\buh\b", r"\bya\b", r"\bu\b", r"\bpls\b", r"\bplz\b", r"\bgonna\b", r"\bwanna\b",
    r"\.\.\.", r"\bok+\b", r"\byeah\b", r"\bhmm+\b",
]]


def clean(raw):
    """(text, slash command, pasted blocks): tags stripped, pastes replaced by a marker, a command's args kept."""
    cmd = (CMD_NAME.search(raw).group(1).strip() if CMD_NAME.search(raw) else None)
    args = (CMD_ARGS.search(raw).group(1).strip() if CMD_ARGS.search(raw) else "")
    pastes = PASTE_RE.findall(raw)
    s = PASTE_RE.sub(" [PASTED] ", raw)
    for r in TAG_RES:
        s = r.sub("", s)
    s = re.sub(r"\n{3,}", "\n\n", CMD_ARGS.sub("", s)).strip()
    if cmd and args and args not in s:
        s = (s + "\n" + args).strip()
    return s, cmd, pastes


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "tool_result":
            return None
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts)


def claude_rows():
    roots = [os.path.join(HOME, ".claude", "projects")] + glob.glob(os.path.join(HOME, ".agenthydra", "**", "projects"), recursive=True)
    seen = set()
    for root in roots:
        for fp in glob.glob(os.path.join(root, "*", "*.jsonl")):
            with open(fp, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if '"type":"user"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    if o.get("type") != "user" or o.get("isSidechain") or o.get("isMeta") or o.get("isCompactSummary") or o.get("isVisibleInTranscriptOnly"):
                        continue
                    if o.get("uuid") in seen:
                        continue
                    seen.add(o.get("uuid"))
                    origin = o.get("origin") if isinstance(o.get("origin"), dict) else {}
                    if origin.get("kind") in NOT_A_PERSON:
                        continue
                    raw = text_of((o.get("message") or {}).get("content"))
                    if raw is None:
                        continue
                    yield {"src": "claude", "project": os.path.basename(os.path.dirname(fp)), "session": o.get("sessionId"),
                           "ts": o.get("timestamp"), "entrypoint": o.get("entrypoint"), "raw": raw}


def codex_rows():
    for sub in ("sessions", "archived_sessions"):
        for fp in glob.glob(os.path.join(HOME, ".codex", sub, "**", "*.jsonl"), recursive=True):
            meta = {}
            with open(fp, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if '"session_meta"' in line and not meta:
                        try:
                            meta = json.loads(line).get("payload") or {}
                        except ValueError:
                            meta = {}
                        continue
                    if '"user_message"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    p = o.get("payload") or {}
                    if o.get("type") == "event_msg" and p.get("type") == "user_message":
                        yield {"src": "codex", "project": os.path.basename(str(meta.get("cwd") or "")), "session": meta.get("id"),
                               "ts": o.get("timestamp"), "entrypoint": "codex:" + str(meta.get("source") or meta.get("originator")),
                               "raw": p.get("message") or ""}


def band(t):
    lines = t.splitlines()
    heads = sum(1 for line in lines if re.match(r"^\s{0,3}#{1,4} \S", line))
    bullets = sum(1 for line in lines if re.match(r"^\s*([-*+]|\d+[.)]) \S", line))
    bold = len(re.findall(r"\*\*[^*\n]+\*\*", t))
    structure = heads + bold + (bullets >= 3) * 2 + t.count("```") + (3 if re.search(r"^\s*\|.*\|\s*$", t, re.M) and "---" in t else 0)
    ai = sum(1 for r in AI_RES if r.search(t))
    human = sum(1 for r in HUMAN_RES if r.search(t))
    if ai >= 2 or (structure >= 6 and human == 0) or (heads >= 2 and bold >= 2):
        return "ai"
    if (len(t) <= 400 and structure == 0 and ai == 0) or (len(t) <= 1200 and structure <= 1 and ai == 0 and human >= 1):
        return "human"
    return "review"


def main():
    groups, dropped = collections.OrderedDict(), collections.Counter()
    for r in list(claude_rows()) + list(codex_rows()):
        if r["entrypoint"] not in INTERACTIVE:
            dropped["headless"] += 1
            continue
        t, cmd, _ = clean(r["raw"])
        m = re.search(r"^#+ My request for Codex:\s*", t, re.M)
        if m:
            t = t[m.end():].strip()
        elif t.startswith("# Context from my IDE setup"):
            dropped["ide_context_only"] += 1
            continue
        if not t or t.startswith(SKIP_PREFIX) or (cmd and not re.sub(r"\s+", "", t.replace(cmd, ""))):
            dropped["not_a_message"] += 1
            continue
        key = re.sub(r"\s+", " ", t).lower()
        if key in groups:
            groups[key]["count"] += 1
            continue
        groups[key] = {"text": t, "count": 1, "first_ts": r["ts"], "src": r["src"], "project": r["project"], "session": r["session"]}
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "messages.jsonl")
    kept = 0
    if os.path.exists(path):  # transcripts age out of ~/.claude/projects; a message an earlier run found stays
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                old = json.loads(line)
                key = re.sub(r"\s+", " ", old["text"]).lower()
                g = groups.get(key)
                if g is None:
                    groups[key] = {k: old.get(k) for k in ("text", "count", "first_ts", "src", "project", "session")}
                    kept += 1
                else:
                    g["count"] = max(g["count"], old.get("count") or 1)
                    g["first_ts"] = min(filter(None, (g["first_ts"], old.get("first_ts"))), default=None)
    bands = collections.Counter()
    with open(path, "w", encoding="utf-8") as fh:
        for i, g in enumerate(sorted(groups.values(), key=lambda g: g["first_ts"] or "")):
            g.update(id=f"m{i:06d}", band=band(g["text"]), chars=len(g["text"]))
            bands[g["band"]] += 1
            fh.write(json.dumps(g, ensure_ascii=False) + "\n")
    print(f"{sum(bands.values())} messages {dict(bands)}; {kept} kept from the last run; dropped {dict(dropped)} -> {path}")


if __name__ == "__main__":
    main()
