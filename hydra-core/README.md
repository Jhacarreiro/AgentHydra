# Hydra Core per-message hook

The hook that runs Hydra Core in a Claude Code chat. It replaces the Manager Hydra router (`managers/router.mjs`) in `settings.json`.

## TL;DR

- Three hook events: `UserPromptSubmit` on every message, `SessionStart` after a compact or resume, `Stop` for the president rule below.
- Core mode is on only while `<core dir>/ON` exists. Without it the hook prints nothing.
- No output for CliMayte workers, for prompts starting with `/`, or for a fresh session.
- Each message is written to `chats/<key>/prompt.txt` and the working folder to `chats/<key>/cwd.txt`. The injected line is one short block that names `hydra.md`, its lead and its tier.
- Node 22 or newer, no dependencies. Runs in well under 300 ms.
- `node hydra-core/install.mjs` registers it and removes the router entry (the router entry is saved, so `--uninstall` puts it back exactly).

## Files

- `hook.mjs`: the hook. Reads the hook JSON on stdin. Exports `run`, `handle`, `chatKey`, `parseHydraMd`, `coreDir`, `isWorker`.
- `install.mjs`: registers the hook in a `settings.json`. Idempotent. Writes a `.bak-<ms>` backup before any change.
- `test/*.test.mjs`: `node:test` suites. Run `node --test hydra-core/test/`.

## Where things live

- Core folder: `AGENTHYDRA_CORE_DIR`, default `~/.agenthydra/core`. The `ON` flag, the `chats/` folder and `router-entry.json` (the saved router entry, keyed by settings path) live there.
- Chat key: `HYDRA_DESK_CHAT_ID` when set, else the Claude `session_id`. Characters outside `A-Za-z0-9_.-` become `_`.

## President rule (Stop)

When a chat's last message asks a question and the turn made no owner consult, the `Stop` hook blocks the stop once. The reason tells Claude to ask the owner tier first: `core_use { mode: "consult", id: "person:creaitor" }` or `creaitor.py ask`. Jacob is asked only when that answer says it needs him. An owner consult is a `core_use` consult of an owner-tier person in `catalog/`, or a Bash/PowerShell `creaitor.py ask`. Each block is appended to `log.jsonl` as `president-block`. The hook allows the stop when `stop_hook_active` is set, for CliMayte workers, when the final paragraph has no question (code blocks are ignored), and on any error.

## Install

```
node hydra-core/install.mjs                       # ~/.claude/settings.json
node hydra-core/install.mjs --settings <path>     # any settings file
node hydra-core/install.mjs --status
node hydra-core/install.mjs --uninstall
```

The installer writes these entries (the command path is the absolute path of `hook.mjs`):

```json
"UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \"<repo>/hydra-core/hook.mjs\"" } ] } ],
"SessionStart":     [ { "hooks": [ { "type": "command", "command": "node \"<repo>/hydra-core/hook.mjs\"" } ] } ],
"Stop":             [ { "hooks": [ { "type": "command", "command": "node \"<repo>/hydra-core/hook.mjs\"" } ] } ]
```

Other hooks are left alone. A Manager Hydra router entry (any command ending in `managers/router.mjs`) is removed, and its group is saved in `router-entry.json`. `--uninstall` removes only the core entries and puts the router back where it was.

## Failures

A hook error is written into the injected context as `Hydra Core hook error: ...`. An unknown event or unreadable stdin exits 1 with the message on stderr.
