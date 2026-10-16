# People and the Hydra Core catalog

**TL;DR.** Hydra Core finds a person or an instrument in a catalog built from folders on your machine. Put one
folder per person under `~/.agenthydra/people/<family>/<slug>/` with a `persona.json` (and an optional `brief.md`),
then run `node hydra-core/catalog/build.mjs`. `--check` validates the result. A fresh install with no folders builds
an empty, valid catalog.

<details>
<summary>Format and sources</summary>

## A person folder

`~/.agenthydra/people/<family>/<slug>/persona.json`, the same for every family: `manager`, `board`, `expert`,
`dredd-seat`, `creator`.

| Field | Meaning |
| --- | --- |
| `name`, `title` | Shown to the chat |
| `oneLiner` | One plain line (under 160 characters): when to pick this person |
| `keywords` | Search tags |
| `brief` | File beside `persona.json` loaded on "become" (default `brief.md`) |
| `tier` | `intern`, `employee`, `manager` or `owner` (default by family: manager and board are `manager`, expert and dredd-seat `employee`, creator `owner`) |
| `modes` | Any of `become`, `consult`, `hire` |
| `cost` | `free`, `low`, `medium` or `high` |

Entry ids: `person:<slug>` for managers, `person:<family>-<slug>` for the other families. Persona text stays in the
files; the catalog holds only the one-liner and the path.

## Legacy managers

`~/.agenthydra/managers/<slug>/persona.json` is still read as a manager, so existing managers need no move. When
the same slug is under `people/manager/`, that copy wins (see Managers below).

## Other sources

The builder also reads skills (`~/.claude/skills`) and sub-agents (`~/.claude/agents`), both in [CLAUDE-CONFIG-LAYOUT.md](CLAUDE-CONFIG-LAYOUT.md). Home paths always come from
`os.homedir()`. `AGENTHYDRA_CORE_DIR` overrides the core folder (default `~/.agenthydra/core`). Hand-written
`hand-*.json` files in `<core>/catalog/` are never touched and win over generated entries with the same id.

## Owner-specific sources: `<core>/catalog/sources.json`

Optional, outside the repo. Every key is optional; a missing key turns that source off.

`projectsDir`, `connectionsDir`, `extraSkillDirs`, `extraAgentDirs`, `dreddDir`, `sueDir`, `snapshotDir`, `laneDir`,
`boardroomDir` (paths, `~` allowed), `ownerName`, `companyId`, `seats` (`[{ slug, name, personaId }]`) and
`minimums` (`{ managers, employees, instruments, skills, knowledge }`, the floors `--check` enforces; none by default).

## Sue, Dredd and the price check

They are a private add-on, not part of this repo. AgentHydra's `sue`, `dredd` and price check tools start them
from their own checkout when it is on this PC (`SUE_DREDD_HOME`, else a `sue-dredd` folder beside AgentHydra),
and say they are not installed when it is not. The add-on keeps its people in its own private store, not in these
folders.

## Where people are stored

- **This PC:** the folders above. Each person is `persona.json`, an optional `brief.md`, an optional `learnings.json` (what the person has learned), and for a manager its `playbook/*.md` and `avatar.jpg|png|webp`. This is the working copy; the catalog reads it.
- **CrAInium (owners only):** the owners' private persona store on their own server, reached over SSH by the people door, a command in the private sue-dredd checkout (`store/people-door.mjs`; `crainium.command` in `~/.agenthydra/people-store.json` overrides it). AgentHydra finds the checkout as it finds Sue and Dredd. The door prints JSON for `status`, `list`, `get <family>/<slug>` and `put` (the record on stdin), refuses another owner's rows, and never deletes. Without the door, only This PC shows. Code: `server/src/people-store/crainium-home.ts`.
- **Sync:** the newer copy of a person wins. The older one is saved in `~/.agenthydra/people-backup/`, and a failed sync never deletes a file. After a pull the catalog is rebuilt.
- **Your choice** is kept in `~/.agenthydra/people-store.json`.

## Managers: two folders, one manager

Every reader of a manager's persona, brief, playbook and avatar (Desk's face and photo, seat pinning, the router, the
catalog, manager analytics) looks in `people/manager/<slug>/` first and the legacy `~/.agenthydra/managers/<slug>/`
second (`server/src/manager-folders.ts`; `managers/router.mjs` and `hydra-core/catalog/build.mjs` carry the same rule).
A slug in both is one manager and the people copy wins. Runtime state (`sessions/`, `analytics/`, `router.log`) stays
in the legacy folder.

## Commands

- `node hydra-core/catalog/build.mjs` rewrites `<core>/catalog/generated-*.json` and `skips.json`.
- `node hydra-core/catalog/build.mjs --check` validates generated and hand files; exit 1 when invalid.

</details>
