"""`hswarm backfill-free-misses`: one `free_miss` ledger row for each Free try the finished jobs' results.jsonl name in a
route note (`fallback`: free account failed | the free reply was unusable | free account timed out | ...) that the ledger
does not hold yet. Idempotent: a row is keyed on (job, task, the note's ts); a note written before notes carried a `ts`
takes the result's `started`. Reads job folders and zips alike (archive.read_text); writes only the ledger."""
from __future__ import annotations

import datetime as dt
import json

from . import archive
from .ledger import append_row, free_miss_row, ledger_rows
from .free_route import CLAUDE_MODELS, GPT_MODEL, HAIKU_PROFILES

FALLBACKS = {
    "free account failed": ("error", "unavailable"),
    "the free reply was unusable": ("error", "model"),
    "free account timed out": ("timeout", "timeout"),
    "free send failed": ("error", "unavailable"),
    "free chat refused": ("error", "unavailable"),
    "free results unavailable": ("error", "unavailable"),
}


def _model(note: dict, profile: str | None) -> str:
    """free:<model> from what an old note still says: its model, else its account's name, else `free:unknown`."""
    if note.get("free_model"):
        return note["free_model"]
    account = str(note.get("account") or "").lower()
    if "gpt" in account or "openai" in account:
        return "free:" + GPT_MODEL
    if "claude" in account or "anthropic" in account:
        return "free:" + CLAUDE_MODELS["haiku" if profile in HAIKU_PROFILES else "sonnet"]
    return "free:unknown"


def _notes(job_id: str):
    text = archive.read_text(job_id, "results.jsonl") or ""
    for line in text.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        note = ((r.get("selection") or {}).get("route") or {}) if isinstance(r, dict) else {}
        if note.get("fallback") in FALLBACKS and note.get("via") == "api":
            yield r, note


def backfill(days: float = 30.0, dry_run: bool = False) -> dict:
    """Append the missing rows; returns {"rows": n, "existing": n, "by_model": {model: n}, "dry_run": bool}."""
    have = {(r.get("job"), r.get("task"), r.get("ts")) for r in ledger_rows(days + 2) if r.get("free_miss")}
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    out = {"rows": 0, "existing": 0, "by_model": {}, "dry_run": dry_run}
    for job_id in archive.job_ids():
        for r, note in _notes(job_id):
            ts = note.get("ts") or r.get("started") or r.get("finished")
            try:
                if not ts or dt.datetime.fromisoformat(ts) < since:
                    continue
            except ValueError:
                continue
            key = (job_id, r.get("id"), ts)
            if key in have:
                out["existing"] += 1
                continue
            status, kind = FALLBACKS[note["fallback"]]
            profile = (r.get("selection") or {}).get("profile")
            row = free_miss_row({**note, "ts": ts, "free_model": _model(note, profile), "free_status": note.get("free_status") or status,
                                 "free_kind": note.get("free_kind") or kind, "free_miss": True}, job_id, r.get("id"))
            have.add(key)
            out["rows"] += 1
            out["by_model"][row["model"]] = out["by_model"].get(row["model"], 0) + 1
            if not dry_run:
                append_row(row)
    return out
