# Claude Code's config dir, as AgentHydra reads it

Claude Code keeps its state in the user's home directory on every machine, so nothing here is
specific to one machine. Below, `<home>` is that home directory (`%USERPROFILE%` on Windows,
`$HOME` elsewhere) and `<config>` is Claude Code's config dir: `<home>/.claude` by default, or
whatever `CLAUDE_CONFIG_DIR` names. The rest of the docs and the CHANGELOG cite these paths in
their usual `~` form; this page says what each one is and who owns it.

## The default login

| Path | Owner | What it holds / what AgentHydra does with it |
| --- | --- | --- |
| `<home>/.claude.json` | Claude Code | The machine's default login (`oauthAccount`), per-project history and the `mcpServers` map. AgentHydra adds or removes its own `mcpServers.agenthydra` key and nothing else, and refuses to write a copy it could not parse ([REFERENCE.md](REFERENCE.md#it-registers-itself)). Every running Claude client rewrites the whole file from its own copy. |
| `<config>/settings.json` | Claude Code (user) | User settings: permission allow rules, hooks. The opt-in agent-status hooks go here (`AGENTHYDRA_HOOKS_CONFIG` overrides it). |
| `<config>/projects/<encoded-cwd>/<session-id>.jsonl` | Claude Code | The transcript store. Claude Desktop and the `claude` CLI both write here, Desktop-instance sessions included, so a transcript's location says where a session LOGS, not which account PAYS ([AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md)). `server/src/config.ts` names it `CLAUDE_PROJECTS_ROOT`. |
| `<config>/sessions/<pid>.json` | Claude Code | The CLI's live registry of running sessions, keyed by engine pid. `whoami` and the history tools match the caller against it. |
| `<config>/skills/<name>/SKILL.md` | the user | User-level skills. The Hydra Core catalog builder (`hydra-core/catalog/build.mjs`) reads each one as a catalog entry; it never writes here. |
| `<config>/agents/<name>.md` | the user | User-level sub-agent definitions. The same catalog builder reads them as catalog entries, read-only. |
| `<config>/commands/` | the user | User-level slash commands. The canonical `/orchestrate` command lives in this repo at [`.claude/commands/orchestrate.md`](../.claude/commands/orchestrate.md) and is copied here. A command pack's commands are copied here too ([COMMAND-PACKS.md](COMMAND-PACKS.md)). |
| `<config>/skills/<name>/` | the user | User-level skills. A command pack's skills are copied here; in a CLI instance's config dir, CliMayte links the owner's own skills here ([CLIMAYTE.md](CLIMAYTE.md)). |
| `<config>/.agenthydra-command-packs.json` | AgentHydra | The record of every file a command pack wrote here and its SHA-256, so an edited copy or a file of the user's own is never replaced ([COMMAND-PACKS.md](COMMAND-PACKS.md)). The same file sits in each Codex home, whose pack commands go to `prompts/`. |
| `<home>/.claude/scheduled-tasks/<taskId>/SKILL.md` | Claude Desktop | Where the desktop app looks for a scheduled task's prompt; the path is hardcoded in the app, and the task row's own `filePath` is ignored. |

The default login belongs to no managed instance and no dispatch account. When a session sets no
`CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_CONFIG_DIR`, the usage tools fall back to it and say so.

## Other accounts: CLI instances and Desktop instances

- A **CLI instance** is a separate config dir with its own login; Claude Code uses it as
  `<config>` when `CLAUDE_CONFIG_DIR` points at it, and AgentHydra honours that everywhere.
- A **Claude Desktop instance** is an isolated user-data dir under `<home>/.claude-instances/<name>`
  (`server/src/core/shared.ts`, `INSTANCES_DIR_NAME`); the main install uses `%APPDATA%/Claude`.
  Its per-chat metadata links to the shared transcript store above by `cliSessionId`
  ([REFERENCE.md](REFERENCE.md#claude-desktop-session-mapping)). Its logins are the OAuth grants in
  `config.json` (`oauth:tokenCacheV2`, and the older `oauth:tokenCache`), encrypted under the
  profile's own key, beside `lastKnownAccountUuid`, plus the claude.ai sign-in cookies in
  `Network/Cookies`. The running app holds both and saves its own copy over them, so AgentHydra
  writes them only while the app is closed: Login sync, and the removal of revoked grants that the app
  keeps through a sign-in to the same account
  ([REFERENCE.md](REFERENCE.md#a-429-can-be-a-revoked-login)).

How a session works out which of these it is billing to is in
[AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md).
