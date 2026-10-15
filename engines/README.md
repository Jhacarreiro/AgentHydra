# Engines: Sue, Dredd and the price check

The three engines that ship with AgentHydra. They are code only: no person lives here.

- `sue/`: Sue, simulated visitors that walk a real page and say what they met. `node engines/sue/sue.mjs <action> --json-file <args.json>`.
- `dredd/`: Dredd, the judge that picks the review instruments for an ask and seats the people who judge it.
  `node engines/dredd/dredd.mjs --root <repo> "<ask>"` (`--doctor` checks the setup, `--help` lists the flags).
- `pricecheck/`: the price check (`node engines/pricecheck/bin/pricecheck.mjs`).
- `mcp/`: a stdio MCP server for Sue and Dredd (`node engines/mcp/server.mjs`).
- `lib/`: the target loader, the people reader (`lib/people-home.mjs`) and `lib/shared/`, small generic helpers.

AgentHydra's own MCP servers (`server/src/mcp-sue-dredd.ts`, `server/src/mcp-pricecheck.ts`) load this folder.
`SUE_DREDD_HOME` and `PRICECHECK_DIR` still override it.

## Install

```
cd engines && bun install     # playwright-core, jsdom, sharp, pdf-lib, pdfjs-dist, undici
node scripts/check.mjs        # syntax and wiring
node scripts/test.mjs         # the engines' own tests
```

## People

Every person is read from the people store's folders (`docs/PEOPLE.md`), `~/.agenthydra/people/<family>/<slug>/`,
or `AGENTHYDRA_PEOPLE_HOME`. The Connections home syncs into the same folders.

| Who | Family | Slug | `persona.json` | `brief.md` |
| --- | --- | --- | --- | --- |
| A Sue (visitor or critic) | `expert` | `sue-<id>` | `name`, `oneLiner`, `sue`: the Sue document | the critic's mind |
| A Dredd seat | `dredd-seat` | any | the seat: `id`, `name`, `rooms`, `jev`, `keywords`, `seatTitle`, `playbook` | what the seat says |
| A Boardroom member | `board` | any | as in `docs/PEOPLE.md` | its brief |

No person ships: a fresh install runs with an empty roster until you add yours.

## Local settings (outside the repo)

`~/.agenthydra/engines/` (`AGENTHYDRA_ENGINES_CONFIG` moves it), every file optional:

- `targets/<name>.json`: read over `engines/targets/<name>.json` key by key. `SUE_DREDD_TARGET` picks the target
  (default `default`). It names the project under test and the product's own hooks and helpers; a key left empty
  turns that extra off.
- `blind-projects.json`: `{ "<Project>": "<folder>" }` for blind rounds.

Paid brains need `SUE_AI_DOOR_URL` (an Anthropic-compatible endpoint) and `SUE_AI_DOOR_TOKEN`.
