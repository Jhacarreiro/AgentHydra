# Command packs

A command pack is a git repository of Claude Code slash commands and skills that a team keeps together.
Add its URL in **Settings → Command packs**, and AgentHydra copies its commands and skills into every
Claude and Codex account it runs on this PC, then pulls the repo again every 10 minutes so each account
keeps the current version.

**TL;DR**

- Settings takes a list of packs: a git URL (https, ssh, or a folder on this PC) and an optional branch.
- Each pack's `commands/*.md` and `skills/<name>/` (any folder holding a `SKILL.md`) reach every account.
- A copy someone edited in an account is kept and listed under **Kept as they are**, never overwritten.
- A file of your own under a pack's name is never replaced.
- A command or skill the pack drops is removed from every account, unless someone edited that copy.
- A pack that cannot be pulled keeps the copies it already wrote.

<details><summary>What a pack looks like</summary>

```
my-team-pack/
  commands/
    ship.md              ->  /ship
    review/security.md   ->  /security (Claude Code shows it under "review")
  skills/
    release-notes/
      SKILL.md
      template.md
  README.md              (not copied: only commands/ and skills/ are)
```

Commands and skills are the files Claude Code itself reads, so a command written for one person's
`~/.claude/commands` works unchanged in a pack. Everything else in the repo stays in the repo.

</details>

<details><summary>Which accounts get it</summary>

| Account | Folder | What lands there |
| --- | --- | --- |
| The default Claude login, and every Claude Desktop instance (their Code tab uses it too) | `<home>/.claude` | `commands/`, `skills/` |
| Each CLI instance | its config dir, `~/.agenthydra/cli-instances/<id>` | `commands/`, `skills/` |
| The default Codex install and each Codex instance | its `CODEX_HOME` (`~/.codex`, `~/.agenthydra/codex-instances/<id>`) | top-level commands as `prompts/` (Codex's `/prompts:<name>`), `skills/` |

Only a folder that already exists is written, so a PC without Codex gets no `~/.codex`. Codex reads
prompts from one folder, so a command in a subfolder of `commands/` reaches Claude accounts only.
An account added later gets the packs on the next sync. [CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md)
says what else lives in these folders.

</details>

<details><summary>The copy rules: whose file is whose</summary>

Each account folder keeps a record of what AgentHydra wrote there, `.agenthydra-command-packs.json`: every
file's path, the pack it came from, and the SHA-256 of what was written. A sync compares the file on disk
with that record and the pack:

| On disk | Then |
| --- | --- |
| Nothing there | The pack's file is written. |
| The pack's current content | Nothing to do (a file that already matched is recorded as the pack's). |
| What AgentHydra wrote last time, and the pack has moved on | The new version is written. |
| Different from what AgentHydra wrote | Someone edited it here: kept, and listed as **Edited here, not updated**. |
| A file with no record | It is yours: kept, and listed as **Its own file, not replaced**. A skill folder whose `SKILL.md` is yours is yours whole. |
| A folder reached through a link (a junction on Windows) | Never written or removed through. CliMayte links the owner's own skills into CLI accounts ([CLIMAYTE.md](CLIMAYTE.md)); a pack file written through one would land in that skill. |

When the pack drops a file, the copy is removed if it still holds what AgentHydra wrote, and an edited
copy stays as yours. Folders left empty under `commands/`, `prompts/` or `skills/` go with it.

When two packs give the same command or skill, the one higher in the list wins, and the other one's row
says so. A pack whose pull fails keeps working from the copy already pulled; a pack that has never been
pulled on this PC (or whose cache was deleted) leaves every copy it wrote exactly as it is until it can be
read again or is removed from the list.

</details>

<details><summary>Pulling</summary>

The checkouts are a cache in `<DATA_DIR>/command-packs/<key>/` (`~/.agenthydra/data` by default), one per
URL and branch: a shallow clone, then `git fetch --depth 1` and a hard reset to what was fetched. Deleting
the cache is safe. The pull uses this PC's own git and its saved credentials, so a private repo works when
`git clone <url>` works for you in a terminal. It never asks for a password (`GIT_TERMINAL_PROMPT=0`): a
pull that would ask fails, and the pack's row shows why. The `ext::` transport is refused.

A pack's commands and skills run with the account's permissions like any command you write yourself, so
add only repos you trust.

</details>

<details><summary>Where it lives</summary>

- The list: `<CONFIG_DIR>/command-packs.json` (`~/.agenthydra/command-packs.json`), `{ "packs": [{ "url", "branch" }] }`.
- Copying and the rules above: `server/src/core/command-packs.ts`, held by `server/tests/command-packs.test.ts`.
- The daemon's side (the list, the accounts, the 10-minute pull): `server/src/command-packs.ts`.
- The API: `GET /api/command-packs` (the list, the last run, `busy`), `PUT /api/command-packs` with
  `{ packs }` (saves and starts a sync), `POST /api/command-packs/sync` (starts one). Both answer at once,
  already saying `busy: true`, so Settings polls until the sync it started is done; add `?wait=1` to answer
  when the sync is done. Held by `server/tests/command-packs-route.test.ts`.
- Settings: `desk2/web/src/components/panes/CommandPacksSettings.vue`.

</details>
