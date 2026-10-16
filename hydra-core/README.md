# Hydra Core per-message hook

The hook that runs Hydra Core in a Claude Code chat. It registers the core hooks in `settings.json`; an add-on may add hooks of its own.

## TL;DR

- Three hook events: `UserPromptSubmit` on every message, `SessionStart` after a compact or resume, `Stop` for the add-on rule below.
- Core mode is on only while `<core dir>/ON` exists. Without it the hook prints nothing.
- No output for CliMayte workers, for prompts starting with `/`, or for a fresh session.
- Each message is written to `chats/<key>/prompt.txt` and the working folder to `chats/<key>/cwd.txt`. The injected line is one short block that names `hydra.md`, its lead and its tier.
- Node 22 or newer, no dependencies. Runs in well under 300 ms.
- `node hydra-core/install.mjs` registers it and takes out any entry an add-on asks it to take out (the entry is saved, so `--uninstall` puts it back exactly).

## Files

- `hook.mjs`: the hook. Reads the hook JSON on stdin. Exports `run`, `handle`, `chatKey`, `parseHydraMd`, `coreDir`, `isWorker`, `skipOf`. Seats (`AGENTHYDRA_ROLE=seat` or a Desk chat in `seat-chats.json`), drones and worker shells get nothing; each skip writes one `hook-skip` line to `log.jsonl` with its reason.
- `install.mjs`: registers the hook in a `settings.json`. Idempotent. Writes a `.bak-<ms>` backup before any change.
- `addon.mjs`: finds an add-on checkout (`SUE_DREDD_HOME`, else the `sue-dredd` folder beside this repo) and loads one of its modules. Without one, nothing from an add-on runs.
- `test/*.test.mjs`: `node:test` suites. Run `node --test hydra-core/test/`.

## Where things live

- Core folder: `AGENTHYDRA_CORE_DIR`, default `~/.agenthydra/core`. The `ON`, `INJECT`, `PLACEMENT` and `ASK` flag files, the `chats/` folder and the saved-entry file an add-on names (keyed by settings path) live there.
- Chat key: `HYDRA_DESK_CHAT_ID` when set, else the Claude `session_id`. Characters outside `A-Za-z0-9_.-` become `_`.

## Stop and add-ons

On `Stop` the hook hands the decision to an add-on module when its checkout is present, and any failure to load or run it lets the stop through. The hook also allows the stop when `stop_hook_active` is set and for CliMayte workers.

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

Other hooks are left alone. An add-on may ask install to take out one of its entries; the group is saved in the core folder, and `--uninstall` removes only the core entries and puts the saved entry back where it was.

## Placement

`<core dir>/PLACEMENT` says where a chat's pack (the folder's rules and what the chat needs) reaches the model. Absent means off: with no `PLACEMENT` and no `INJECT` flag the hook injects nothing into a message.

- `slot`: the pack goes into a Prime chat's appended system prompt, at most 24,000 characters (the slot's own cap; the hook's 10,000-character limit does not apply there). The lead's full brief goes in first; when the folder rules do not fit beside it they are cut to their head plus a pointer to the full file. The whole appended prompt (Desk's own text plus the slot) stays within 32,000 characters: a slot that would pass it is built again to the room left, and a `placement` line with `phase: "cut"` is logged.
- The pack is rebuilt on every launch and resume from what the chat keeps in `chats/<key>/placement.json`: its lead and its first owner message, both stored at its first launch. `slot.md` is rewritten only when the rebuilt text differs, and the stored hash is the hash of that text, so the prompt cache holds while nothing changed. A pack-code change, an edited rule or brief, or a rebuilt catalog reaches every chat on its next launch; `hydra.md`'s scope log does not touch it, and only its `## Lead` line does. A new session in the same chat (a handoff) keeps the chat's lead instead of ranking its first message again. Every launch, fresh or resumed, counts its session as one with the pack in its prompt, so no such session is sent the full pack again with a message.
- `file`: the pack is written to `chats/<key>/pack.md` (same rebuild rule, at most 9,500 characters). The appended prompt gets one line that names the file's absolute path and asks the chat to read it before it acts.
- `attach`: the pack is attached to each message, at most 9,500 characters. An `INJECT` file holding `ON` does the same with `PLACEMENT` absent.
- `<core dir>/ASK`: absent, or anything but `off`, means ask is on. Under `slot` and `file` each owner message's injection then starts with the core_scope line (call `core_scope`, answer with `core_answer` until it says go). The chat answers the difficulty question and picks its own persona; the pick lands in `hydra.md` and the next launch's slot carries that brief. No model picks a lead at launch and no lead shift runs. `off` turns the line off and brings back the model pick and lead shift (see Lead). Slash commands and pings that are not the owner's (task notifications, "Not from the user") get nothing.
- Under `slot` and `file` the per-message hook sends no full pack. After the scope line (when asking) it attaches only strong matches not already placed, at most 2,000 characters, else nothing. They are scored on the owner's own words: the hook drops the Send now and urgent prefaces, a handoff's note and document (keeping the messages the earlier session missed), and task notifications or reminders queued with the message, and records the same text in `prompt.txt`. After a compaction (SessionStart `compact`) the hook clears the session's list in `sent.json`, so additions the compaction dropped can be sent again. The SessionStart re-injection of `hydra.md` is off under every placement.
- A non-Desk chat's slot is keyed by the session being launched, the key the hook uses, so a handoff's new session finds it.
- Logged to `log.jsonl`: `placement` at each Prime launch or resume, the hook's per-message placement with the match ids and characters added, and under `file` a `pack_read` on the first Stop of a session, recording whether the chat read `pack.md` and whether that was its first tool call. `track` shows counts, mean characters, reuse rate and read rate per placement.

There is no switch script in this repo. Write the flag files by hand (see Continue the manager bench for what each holds).

## Continue the manager bench

For a contributor or a new PC. People and persona text live in your own `~/.agenthydra/`, never in this repo. The folder format is in [docs/PEOPLE.md](../docs/PEOPLE.md).

**Flags.** Each is a one-word file in the core folder.

- `ON`: core mode. The hook does nothing unless this file exists.
- `PLACEMENT`: `slot`, `attach` or `file` (see Placement). Anything else, or no file, is off.
- `ASK`: `off` turns the scope question off; absent or anything else keeps it on.
- `INJECT`: holds `ON` to attach the pack to each message with no `PLACEMENT`.

**How a lead is picked.** With ASK on, the chat answers the scope question tree (`server/src/hydra-core/tree.ts`) and picks its own lead. With ASK off, one small model call picks the lead from the managers' one-liners, and the word ranker is the fallback (`server/src/hydra-core/lead.ts`). See Lead.

**Add a manager.**

1. Make `~/.agenthydra/people/manager/<slug>/` with `persona.json`, `brief.md` and optionally `playbook/*.md` and `avatar.jpg`. The older layout `~/.agenthydra/managers/<slug>/` still works; a slug in both is one manager and the people copy wins (docs/PEOPLE.md).
2. Run `node hydra-core/catalog/build.mjs`, then `node hydra-core/catalog/build.mjs --check`.

**Edit a manager.** Edit `persona.json` or `brief.md` by hand and rebuild. There is no editor yet. Settings > Your people only adds people.

**Hire or consult.** `core_use` with `mode: "hire"` or `"consult"` runs the person as a seat. A `climayte_run` task with `role: 'seat'` and a `persona` only tags the worker. Its prompt must point at the person's brief, or the worker does not read it.

**On a new PC.**

1. `bun install` and `bun install --cwd desk2`.
2. Start the daemon (port 7787).
3. Get your people: the Your people first run, or copy the folders into `~/.agenthydra/people/`. An owner with the private sue-dredd checkout and SSH to the persona server picks CrAInium in Settings → Your people instead, and the managers are pulled down. To put managers into CrAInium the first time, run `node store/import-managers.mjs --from <folder of manager folders>` in the sue-dredd checkout (a dry run), then again with `--write`; the rows are stored under that PC's owner.
4. Build the catalog (above).
5. Write `ON` and `PLACEMENT` (for example `slot`) in the core folder.

Desk and CliMayte chats wire the hook themselves. `install.mjs` is for plain CLI sessions.

## What the log records

- `miss`: each id on a page the chat passed over (`more`, `why: "more"`) or rejected (`none`, `why: "none"`, with the `better` text it gave). A `more` with no page in memory, after a restart, counts the first page.
- `find`: every `core_find` call, with its `ids` and `total`.
- Each step answer carries `kw` and `defaulted` (the answer was the step's default). Every finished run's reply asks once for `core_report`; a report needs an outcome of `done`, `partial` or `failed`, and one with no open run is stored with a warning.
- A bad catalog entry is logged as `skip` once per file, id and reason until its file changes.
- `log.jsonl` moves to `log-YYYY-MM.jsonl` when a new month starts or it passes 20 MB. `core_stats` (last 31 days, or `days`) and `track` (last 30 days) read only the months they need. A move that fails (another process holds the file on Windows) is skipped and tried again on the next line.
- hydra.md keeps its last 20 scope-log lines; `sent.json` drops a session not seen (no pack or per-message answer for it) in 7 days, and keeps `(lead owed)`.

## What the log teaches

- The daemon folds the last 90 days of the log into `catalog/feedback.json` 30 s after it starts, then whenever the file passes a day old (checked hourly). Per entry: `offered` (pointer lines in packs and per-message additions, `core_find` results, a run's shown list once: places where taking it, by loading or picking it, is logged), `pasted` (a pack or per-message addition that pasted its full text, from each line's `pasted` list: reading it is the use and no take follows, so a paste is not an offer and moves neither the prior, the base rate nor `learned`; a line from before `pasted` was logged counts its knowledge and person ids as pasted), `taken` (a pick answer, a `core_use`), `rejected` (`more` and `none` misses) and `reported` (score - 3 over reports whose run took it, minus 1 per `overruled`). No pack, find or hook request folds; they only read the small file, cached by its mtime.
- Every ranking (packs, per-message additions, `core_find`, the scope tree, the word lead ranker) multiplies an entry's word score by `1 + 0.5 * clamp((taken + 1) / (offered + 2) - base, -0.5, 0.5)`, `base` being the catalog-wide take rate, once the entry has been offered 10 times; a newer entry keeps a fair start.
- Where an entry would go as a pointer, packs and per-message additions leave out knowledge offered 50 or more times and never taken, and need a score of 5 instead of 4 for an entry rejected more often than taken. Text pasted in full is never dropped or held to the higher bar.
- The owner's pinned rulings (entries from `catalog/generated-pinned.json`, marked `pinned` when the catalog loads) and folder rules (knowledge with `folders`) are exempt from all of it: never dropped, never held to the higher bar, prior fixed at 1, never in `learned`.
- `catalog/feedback-needs.md` lists, newest first and deduped, the `better` text of each `none` and the `missing` text of each report, for whoever rebuilds the catalog.
- `core_stats` shows the prior's top movers under `learned` (`up` and `down`, with each entry's counts).

## Lead

- By default (ASK absent or on) a slot or file chat picks its own lead: core_scope asks the difficulty question, `no 1` loads nothing, 2 or more shows the persona list, and the pick is written to `hydra.md`'s `## Lead`, which the next launch's slot carries. A chat whose `placement.json` already stores a lead keeps it until `hydra.md` names one. The model pick and lead shift below run only with `<core dir>/ASK` set to `off` (write `off` into `<core dir>/ASK`).
- With ASK off, a chat's lead is picked once, at its first pack, by the people add-on's `lead` seam (one model call; the question, the model and the decide door are the add-on's, and `AGENTHYDRA_LEAD_MODEL=off` skips the call). A launch waits at most 5 s for it and the hook path 1 s. With no add-on, no manager in the catalog, or when its call fails or runs out of time, the word ranker picks among whoever can be become.
- The call never blocks an event loop: it is an async fetch with its own timer. The daemon's `/api/core/pack` awaits the pick before it builds the pack, a CliMayte Prime launch is held a scheduler tick while its pick runs (`leadPickPending`), keeping the launch slot it took so later-ranked work does not start in its place (with no model to ask, `AGENTHYDRA_LEAD_MODEL=off`, it is not held), and the Desk server runs the slot build in a child process it awaits. The pack and placement builders themselves never call the model; they take the finished pick.
- When the call fails or runs out of time the word ranker picks (content words only, the shared `how` text not scored, managers not sorted above stronger experts). Each pick logs `lead-pick` with its path (`model` or `words`) and ms.
- The lead follows the work (ASK off only): on a substantive owner message (not "keep going" or a chore) that the current lead barely matches, or that the word ranker gives to another lead, the hook asks the model whether the lead still fits. When the work moved, the message gets a short lead-change note with the new lead's brief (whole under 9,500 characters, else its first two sections and the become line), `hydra.md`'s `## Lead` is rewritten so the next launch's slot carries it, and `lead-shift` is logged. On a timeout the current lead stays.
- A lead picked through the question tree logs a `use` line with `mode: "become"`, as `core_use` does.
- Per-message additions need at least three content words in the message and, per entry, a name or title hit or a strong score, with at least two distinct words matched, at most three items, never an entry already in the slot and never one tied to other folders.
- The slot lists the chat's seats: `Seats in this chat: <name> (<person id>)`, with how to resume one through `core_use` consult.
- A consult or hire whose seat is still working registers a completion wait (`server/src/completions.ts`): the chat is told once, through CliMayte, when the seat's turn ends.

## Failures

A hook error is written into the injected context as `Hydra Core hook error: ...`. An unknown event or unreadable stdin exits 1 with the message on stderr.
