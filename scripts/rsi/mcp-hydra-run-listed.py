"""How often agents call a tool they already had listed through hydra_run.

The measure behind `mcp.hydra_run.listed_share` in .rsi/rsi.yaml. Reads the Claude Code transcripts on this PC for
hydra_run tool calls made in the last --days days (default 7), and counts the ones whose input.tool is a tool the
agenthydra server lists directly (LISTED_TOOLS, loaded from server/src/mcp.ts at run time). A call routed that way
loses its caller binding. Prints one JSON line with counts and tool names only, never message text or paths.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOME = Path.home()
TOOL = "mcp__agenthydra__hydra_run"
NEEDLE = b"hydra_run"


def transcripts() -> list[Path]:
    found = list((HOME / ".agenthydra" / "cli-instances").glob("*/projects/**/*.jsonl"))
    found += (HOME / ".claude" / "projects").glob("**/*.jsonl")
    found += (HOME / ".claude-instances").glob("*/projects/**/*.jsonl")
    return found


def listed_tools() -> set[str]:
    script = "const m = await import('./server/src/mcp.ts'); console.log(JSON.stringify([...m.LISTED_TOOLS]))"
    out = subprocess.run(["bun", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return set(json.loads(out.strip().splitlines()[-1]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    days = parser.parse_args().days
    since = datetime.now(timezone.utc) - timedelta(days=days)
    listed = listed_tools()
    seen: set[str] = set()
    calls: Counter[str] = Counter()
    misrouted: Counter[str] = Counter()
    files_read = 0
    for path in transcripts():
        try:
            if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < since:
                continue
            fh = path.open("rb")
        except OSError:
            continue
        files_read += 1
        with fh:
            for line in fh:
                if NEEDLE not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                stamp = rec.get("timestamp")
                if not isinstance(stamp, str):
                    continue
                when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                if when < since:
                    continue
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "tool_use" or block.get("name") != TOOL:
                        continue
                    block_id = block.get("id")
                    if block_id is not None:
                        if block_id in seen:
                            continue
                        seen.add(block_id)
                    tool = (block.get("input") or {}).get("tool")
                    name = tool if isinstance(tool, str) else "(none)"
                    calls[name] += 1
                    if name in listed:
                        misrouted[name] += 1
    total = sum(calls.values())
    routed = sum(misrouted.values())
    print(json.dumps({
        "days": days,
        "hydra_run_calls": total,
        "misrouted_calls": routed,
        "listed_share": round(routed / total, 4) if total else None,
        "misrouted_by_tool": dict(misrouted.most_common()),
        "listed_tools": len(listed),
        "transcript_files_read": files_read,
    }))


if __name__ == "__main__":
    main()
