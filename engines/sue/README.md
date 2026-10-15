# SUE - Simulated User Experience

> Owner ask (Owner, 2026-09-21): "I'm going to have a cannon shooting little people out, and they're
> going to be hitting the wall and splatting nonstop. My goal is to be like: whoops, apparently this
> login flow or the home page of my website is so confusing they don't know what we sell."

SUE is a separate tool from the design critic and from LilGranny. Those read the DOM with rules and
never leave the machine. SUE sends PEOPLE: each Sue is a real AI session, by default an agent of whichever AI asked for the run
(Claude, Codex, ChatGPT, anything with a shell), given a real browser, a real persona and a real email address we
own. She knows nothing about our code. She reads the page the way her persona would, tries to do what
a real visitor would do, makes a real account if the scenario calls for one, reads her sign-in code
out of her own real inbox, and answers an exit interview in her own words. The design critic tells you
a button is the wrong shade of grey. SUE tells you nobody understood what the button was for. Full
contract and reasoning: [SPEC.md](SPEC.md) - read that first if you are changing any of the pinned
signatures this README only summarizes.

**SUE sits on Dredd's bench.** Dredd (`dredd/dredd.mjs`, manual [dredd/README.md](../dredd/README.md)) is the
judge that decides, for any complaint or review, which of the fleet's instruments to convene - SUE, the Design Critic,
LilGranny, the flow walk, the copy checks, the Boardroom of critics, the Architect, Odin, the Atlas - and in what order.
The roster is `dredd/bench.json`; SUE's entry there says when she is sent and how. Grandma Sue also sits in the
Boardroom of critics (`dredd/seats/03-grandma-sue.json` names her `briefFrom: { sue: "grandma" }`, and the room reads
her voice from Connections when it sits, one source).

**Two doors added 2026-09-22 (both additive).** `node sue/sue.mjs run --json-file <path>` takes the same
object from a file, because cmd, PowerShell 5.1 and sh each quote JSON on a command line differently and two of them
broke it. And the mailroom accepts a vault lease in the env (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, minted
value-blind by the local MCP's `shell { instance }`) as an alternative to `AWS_PROFILE=main`; the cannon no longer
names `main` on top of a lease, because the AWS SDK prefers a named profile even when it does not exist on the machine.
Dredd uses both, so a hearing sends Sues with no human SSO login on the box. Since 2026-10-15 the engine takes that
lease itself: a wave started with no `AWS_PROFILE` and no keys leases `Root/Connections` from the Connections vault
through the local MCP it opens for its people (`lib/mailroom-lease.mjs`), and the answer's `mailroomCredentials`
says which credentials the mailroom got.

## The MCP server: Sue and Dredd in any chat

`mcp/server.mjs` is this checkout's own stdio MCP server: no Connections, no AgentHydra, no install. Register it once
per machine with the checkout's real path:

```
claude mcp add sue-dredd -- node <checkout>/mcp/server.mjs
```

or in `~/.claude.json`: `"mcpServers": { "sue-dredd": { "command": "node", "args": ["<checkout>/mcp/server.mjs"] } }`.

| tool | input |
| --- | --- |
| `sue` | `{ action, ... }`: `move` (`runId`, `sue`, `move`, `args`), `run` / `focus_group` / `ape` / `art` (`url` or `file` or `idea`, `intent`, `count`, `personas`, ...), `status` / `report` / `stop` (`runId`), `personas`, `presue`, `save_persona`, `edit_persona`, `journal`, `scoreboard`, `profiles`, `room`, `room_say`, `watch`, `inbox_test`, `inbox_test_report`, `analytics`, `blind_round` |
| `dredd` | `{ action, ask?, url?, root?, docket?, ... }`: `docket`, `plan`, `convene`, `hearing`, `resolve`, `status`, `stop`, `dockets`, `collect`, `boardroom`, `bench`, `doctor`, `unrated` |
| `dredd_hook` | `{ prompt }`: the `<dredd-memories>` block for a UserPromptSubmit `mcp_tool` hook (this server has no memory lane, so it says recall could not run) |

They are the tool names and input shapes the Connections door used, so a chat's calls keep working once its MCP config
points here. `sue` runs `node sue/sue.mjs <action> --workspace <the chat's folder> --json ...` (a `move` goes to the run's
relay in-process); `dredd` runs `node dredd/dredd.mjs ...`. Each tool's full description is in `tools/list`.

## The persona store

`store/store.mjs` is the door to the personas (cranium's `sue_personas`) and CreAItor's rulings on store-host, over
`ssh store-host docker exec -i people-db psql` (`SUE_DREDD_STORE_HOST` overrides the host). `node store/store.mjs status`
prints the counts and is the check that a PC can reach it; `list`, `get`, `rulings-pull` read every owner's rows into
`%USERPROFILE%/.sue-dredd/store/` and answer from there, with its age, when the server is out of reach. `put` and
`rulings-push` write only this PC's owner's rows (CreAItor's owner.local.txt), compare-and-set on `updated_at`.
Dredd's seat words are tier `seat` rows (`list --tier seat`), slug `seat-<seat id>`; `node store/import-seats.mjs
--write` copied them once off the Connections Boardroom and skips any seat the store already holds.

### Migrations (`store/schema`, `store/migrate.mjs`)

The personas database is its own Postgres database `personas` in `people-db`, with roles `personas_owner` (owns the
objects, no login), `personas_app` (reads and writes, never deletes) and `personas_ro` (reads). `node store/store.mjs
migrate --dry` lists what is pending from the ledger and applies nothing; `node store/store.mjs migrate` applies it.
Files run in name order, each once, and are recorded in `schema_ledger` with their sha256; an applied file that was
edited refuses the run, so a change is a new numbered file. `0001` runs as postgres outside a transaction (it creates
the database); `0002` and `0003` each run as `personas_owner` in one transaction with their ledger row. Every UPDATE or
DELETE on `personas` and `creaitor_rulings` keeps the old row in `persona_versions` or `creaitor_ruling_versions`.
The nightly backup and restore drill are in `store/ops/` (see its README; not installed yet). The store still reads
cranium's tables until the retarget task.

## The short way: point it at a page and say why they came

> Owner ask (Owner, 2026-09-21): "all you have to do is point it at the page and say run Sue." And
> the product ruling: "No AI. We provide no AI for Sue. Sue is entirely on you to run. However, we
> provide you the tooling."

From any agent with AgentHydra's MCP, its `sue` tool starts a run and returns its id in a second (`cwd` is the
folder the run belongs to, omitted inside a Desk chat):

```
sue { action: "run", params: {
  url: "https://app.example.com/trial/<code>",
  intent: "a friend posted this link in his WhatsApp deal group; you want to post your deals there",
  count: 5 } }
```

Then `action: "status"` for progress and `action: "report"` for the verdict: stars, who is never coming
back and why, their own words, where each one stopped and why (`whyTheyStopped`), the screens they saw
(`screensSeen`: each once and whole, without her eyesight notes, so a Dredd hearing's drafter can quote a screen
past the front door), support messages sent, what they thought of your emails. The same tool answers `personas`, `save_persona`, `journal`, `scoreboard` and `stop`.
Without AgentHydra it is the engine directly, which is all the tool runs:

```
node sue/sue.mjs <action> --workspace <folder> --json-file <args.json>     # or --json '{...}'
```

The engine does what the old Connections MCP door did before a wave (`doorDuties` in `sue.mjs`): it fetches the
workspace's people from Connections, sends a Boardroom person named in `personas` as a cast visitor
(`lib/boardroom-cast.mjs`, answered in `fromBoardroom`), defaults `project` to the workspace's
(`lib/workspaces.mjs` `workspaceProject`: a target in `targets/*.json` that declares the folder's `projectId`, else
the folder's Connections binding), leases the mailroom's credentials (above), and saves a person `save_persona`,
`edit_persona` or a pre-sue made to Connections, answering `{ ok: false, error }` when Connections did not keep her.

- **⛔ NO CLI LOGINS (the Chair, 2026-09-23, verbatim): "I never want you to use, like, the Claude code or the
  GPT code CLI ... you're not allowed to use CLI logins."** The ban is the LOGIN - a Claude Code subscription
  session, a `CLAUDE_CONFIG_DIR` pointed at somebody's account. Three brain tiers, none of them one:
  - **`chat` (the default)** - the caller's own agents (Claude, Codex, ChatGPT, anything with a shell) drive
    every Sue through `hand.mjs`, so the run spends that AI's usage and no login of the tool's. She can see
    screenshots, because her agent can. Owner, 2026-09-22: Sue must be "not CLI dependent nor even CLI
    preferred".
  - **`openrouter`** - the real Claude Code CLI, driven by an OpenRouter API key (never a login), and only when
    the chat that runs SUE (or Dredd, through `DREDD_SUE_BRAINS`) names it: the Chair, 2026-09-23, "I don't think
    they should need api keys ... unless the desktop instance (aka here) has deemed say, a... zswarm necessary".
    Nothing picks a key pool by itself - not the cannon, not a Dredd hearing, not the reaper. She can see
    screenshots too.
  - **`deepseek`** - the same CLI, driven by a DeepSeek API key instead. Measured 2026-09-23: the pool has no
    balance today, so its preflight refuses; `openrouter` is the working unattended tier until that changes.
    `--brain <tier>` (or `SUE_BRAIN`, how DREDD's unattended hearings pin it) picks one; `assertBrain` refuses
    anything else and names the fix, including for anyone who still types the retired `claude` tier.
- **`model` picks who thinks for every Sue on the CLI-backed tiers** (handed to the cannon's `--model`; a
  Haiku name is refused). Unset keeps the default, `SUE_DEFAULT_MODEL` in `lib/claude-cli.mjs`:
  `claude-sonnet-5-5` (Owner, 2026-10-05, replacing Opus 5.5) for `chat`'s own fallback and the preflight probe (`deepseek`/`openrouter` always pin
  their own model instead). Owner, 2026-09-22: "Every use of Sue should be using our local model with the
  brain, as in the brain should be local Claude Opus 5 models". `deepseek`/`openrouter` still spawn the
  newest Claude Code CLI on the machine by itself (the PATH one or a copy the desktop app keeps under
  `~/.claude-instances/<name>/claude-code/<version>/`), because the PATH one is often too old for a new
  model; `SUE_CLAUDE_BIN` overrides. Its startup log names the path and the version.
- **On `chat`, the cannon starts no CLI**; it opens a relay (`lib/body-relay.mjs`) and writes one `brief.md`
  per Sue, listed in the run's `chat-brains.json` (the door returns its path). Each entry carries `sealed`
  (`systemPromptFile` = her `sealed-system.md`, brief and brain-system as one system prompt; `mcpConfig` = her
  `sealed-mcp.json`, the `sue-hands` server alone, bound to this run and Sue; `allowedTools`; a one-line `prompt`).
  **Every Sue runs SEALED by default (Owner, 2026-10-06: "no chat ever runs one the expensive way again"):** ONE
  CliMayte task per Sue, `climayte_run { group: "sue-<runId>", tasks: [{ title, prompt: sealed.prompt, cwd: her
folder, sealed: { systemPromptFile, mcpConfig, allowedTools }, model: "claude-sonnet-5-5", modelWhy }] }`, which
  starts her CLI with nothing else in its context. AgentHydra holds the model a sealed task names; before it did
  (2026-10-07), CliMayte scored every Sue as a code task and ran her on that kind's pick (469 of 624 visits that day
  at Sonnet low, 155 on a Haiku) while her summary said Sonnet 5.5. Sonnet 5.5 at its default effort is the cheapest
  that holds: every cheaper arm lost its A/B on radiologistbuddy (2026-10-07, `eval/ab-ledger.jsonl`). Sonnet low
  finished less, Sonnet medium and Haiku 5.5 max saved no quota, and Haiku 5.5 high, about a quarter of the quota,
  rated the same site 0.33 stars lower and lost one visit's exit interview in 12. Measured 2026-10-06 (run 20261006-041030-f5fb): 6,000 tokens before her
  first move (38,700 as an ordinary worker), median context 22,800 (72,000), 1.34M re-read tokens a visit (6.84M),
  59 requests (98), the full exit interview. SUE sends them itself when asked (`lib/climayte-dispatch.mjs`): `run`
  with `dispatch: "climayte"` (the cannon's `--dispatch climayte`, round's `start --dispatch climayte`; Dredd's chat
  hearings ask whenever AgentHydra answers) POSTs each Sue to AgentHydra's `POST /api/corch/workers`
  (`SUE_CLIMAYTE_URL`, default `http://127.0.0.1:7787`, 1.11.0 or newer) as she registers, marks her entry
  `climayte: { worker, group, model, effort }` (what CliMayte runs her on) or `dispatchError`, cancels at once a
  Sue it put on any other model or effort than hers (an AgentHydra too old to hold them; a failed cancel is asked
  again), and cancels a worker whose Sue was let go unfinished;
  `node sue/dispatch.mjs <runId>` hands a run already going over the same way (`--print` only prints the
  `climayte_run` arguments). The run's `next` says which, with the exact call. Only when CliMayte is unavailable
  does the chat start one agent per Sue the old way, each told only to read its brief, at most five at a time on
  the flagship, with the `why-not-hswarm:` line the door names in the prompt (the routing gate refuses a bare
  brief). Her hands are
  `node sue/hand.mjs <runId> <sueId> <move> [name=value ...]`, and every move still goes through her
  body, so the rails refuse a subagent's "Send" exactly as they refuse a CLI brain's. A `sue-driver` agent
  also gets the same hands as an MCP tool (`hands-mcp.mjs`, `mcp__sue-hands__move`): one call a move instead
  of a Bash command, through the same `lib/hand-move.mjs`. Since 2026-10-05 a move that shows the page answers its
  words and her newest picture from her own `eyes/` folder (MCP image content) in ONE result, writing the same
  `sees.jsonl` row a `see` does (`answered: "move"`), so the driver needs no `see` turn; `see` still answers (one
  visit on 2026-10-05 spent about half its 98 requests on `see` and screenshot Reads). The brief says a lone `note`
  costs a turn and rides in the next `do`, the counter to what folding the picture in cost before. Measured 2026-10-03 on Lift's class unit, one build, the same personas, per
  visit: the old door (Bash move, then Read; 16 visits) wrote 13.6 notes, 1823 characters and raised 1.31
  problems; the picture folded into the move's answer (24 visits) wrote 12.2, 1691 and 1.00 (the driver lost the
  turn in which it looks before it writes); `see` (three rounds, 22 visits) wrote 13.2, 1791 and 1.41, at the
  move tool's speed (a student's visit about 80 to 115 s, a round about 4 minutes against about 9 with the old
  door). Stars and finishing matched the old door's per persona in two of the three `see` rounds; the third's two
  different visits were the students' own choices on the page. Her body opens on her
  first move; a Sue nobody drives within an hour, whose agent goes quiet for fifteen minutes, or whose one
  move waits on her hands that long (a browser stuck under a dialog), is let go, her waiting move answered
  with why, and one that made no move is a brain-error row the report does not count. A chat run lives only as long
  as the chat driving it, and takes no `--forever` or `--stampede`.
- **The intent is the whole brief.** One sentence, 30+ characters, in their terms. Every Sue in the run
  is there for that reason; the prompt never tells her the shortcut. She makes her own account, reads her
  own inbox and, when something breaks and she is annoyed enough, finds the company's support and tells
  them (`contactSupport: false` turns that off, `createAccounts: false` keeps her signed out).
- **`expect` says what the page is meant to be (optional).** One short line, 300 characters at most, on a run's spec
  (`run`, `focus_group`) beside `intent`: `"expect": "a five-question lesson on using AI safely, for grades 6-8"`. Every Sue
  reads two more sentences in her scenario, `You were told this is <expect>.` and `If what you find is not that, say so in
a note.`, so a page that is not what it should be (a math quiz where that lesson belongs) is noticed by every Sue, with
  no steering. A run without one reads exactly as before, and a changed `expect` is a new scenario and a new identity.
- **On Connections' own sites support is OPT-IN (Owner, 2026-09-30, the flat $200 AWS bill).** Our
  support bubble and the account assistant answer on a paid model (GLM 5) at our cost, and SUE runs were
  nearly all of that bill (2026-09-28: 632 model steps, about $3 in one day; 2026-09-29, with no SUE
  run on our sites, $0). So on any `example.com`, `example.org` or `api.example.com` page
  a run's Sues are told NOT to contact us (no contact form, no support email, no chat bubble or AI
  chat, even one a search box opens) unless the run says `contactSupport: true`. Pass it when the run
  is testing support or the assistant; leave it off otherwise. A material run was already opt-in, and
  every other owned site keeps the old default (on unless `contactSupport: false`). A persona's own
  `complains` (save_persona) still wins over the run for HER, so a saved persona that always complains
  still does. The bubble also has a monthly dollar ceiling on the chat side
  (`services/chat/lambda/src/first-party-support-ceiling.ts`): past it, turns answer on a cheaper model.
- **Who goes follows the intent and the page, never a pool written for another product.** In order:
  the people you name (`personas`); a `cast` (whole persona documents with their own voice and errands
  on a roster body; Dredd casts one from the ask and the page, `lib/cast.mjs`); the visitor the intent
  names ("I'm a party planner looking for..." sends party planners, in the intent's own words); this
  workspace's saved people written for the page's site (`for`); else one of each roster kind. A cast
  rides inline on the page's target file, never in `personas/`.
- **Pre-sue: Jev checks SUE has the right people before a run goes, and onboards the missing ones**
  (the Chair, 2026-10-05: "Sue/Dredd need a Jev. Pre-sue."). A link run (`run`, `focus_group`) that names
  nobody and carries no cast, scenario, file or idea is pre-sued first (`lib/presue.mjs`). Jev reads the
  page's title and first words with the errand, once, and answers for each person who may go there (the
  built-in roster and this workspace's people written for this site or for none; never a critic; children
  only on a kids' ask) whether she is one of the page's real visitors. The ones at 0.5 or above go,
  strongest first. When fewer than three fit, the HSwarm brain is told who is already going and drafts the
  missing kinds (`lib/cast.mjs`); Jev re-checks every draft and drops any under the bar, and the kept ones
  are saved to the workspace written for this site, so the next run finds them fitting and drafts nobody.
  With no Jev only the people saved for this site fit, and the answer says why. `presue: false` skips it.
  `sue presue` (the `sue` tool's `presue` action) runs only the check and says who would go; `save: false`
  leaves Connections alone. The answer carries `ms` per stage (page, Jev, drafting). First run, on
  OperatorLink (a crane operator and ground crew signalling app): only `machine-operator` fit, a rigger
  signalman and a site superintendent were drafted and saved, and the next run sent all three, drafting
  nobody. Why a yes/no per person and not a ranking from a model (measured 2026-10-05, three pages, five
  arms): Jev's yes-probability already is the ranking, and it held still (average drift 0.01 over five
  repeats, the same top three every run, unchanged when the people were shuffled); a cheap model that
  categorised the page and scored everyone drifted five to ten times as much, moved one to four people
  across the bar per page and took about 30 s against Jev's 3 to 6 s. Jev's graded `score` type was as
  steady but no better at the top. What does move Jev is the question's wording (up to 0.15), which is why
  `FIT_QUESTION` is fixed in code.
- **Somebody else's live website gets no account and no message.** On a link run, a page that is not
  a local dev host, not a Connections host, not on this workspace's websites and not declared yours
  (`owned: true` on the run, kept on the page's target file) is somebody else's, unless a human lent
  the run a login (`profile`, `as`), which keeps the borrowed rails. This workspace's websites are one
  list in Connections: its website list (the workspace's domain, its verified custom domains and every
  site a member added), its verified email domains and its cookie banners' domains, read once by the
  planner for the whole run (`lib/owned-sites.mjs`), and a page on one of them, or under one, is yours
  (a public suffix on it, such as `co.uk` or `vercel.app`, owns nothing);
  a source that cannot be read is named in the answer's `ownedSitesNote`. `owned: true` on a site not
  on the list adds it there (`registeredSite`), so every later run knows. The planner writes `liveSite: true` on the page's target; a
  hand-written target keeps its own rules. Every Sue there is told it is a real, live website, judges every
  form up to the Send button and stops, and her exit interview asks what she would have sent
  (`stoppedAtSend`). Her hands refuse any press that submits a form there, whatever it says
  (`lib/rails.mjs`, `lib/site-owner.mjs`); `createAccounts: true` or `contactSupport: true` on such a
  page is refused. Only the owners' own sites are "development websites" where accounts are the point.
- **A run always starts cold**: a fresh empty browser at the link she was sent (`start: "link"`), at
  the site's front door (`start: "home"`, she has to find the page), or in her own inbox on the message
  that sent her (`start: "inbox"` with `arrival: {from, subject, html or text}`, the campaign email or the
  friend's post, written by YOU; SUE writes no copy). The arrival is tagged `seeded` in her mail folder, so
  nothing that measures the product's own mail counts it (her sign-in code, its latency, the sign-up door
  check, the phone buzz), and the report's "The message that sent her" says who clicked through and what
  each thought of it. A hand-written target takes the same `arrival` field. Nothing is borrowed or pre-filled.
- **Sampled visitors** (`sampled: N`, the cannon's `--sampled N`): N more people DRAWN beside the named
  personas, each with her own reading grade, tech prowess, device, network, patience, age, occupation,
  errands and a few quirks, all from word lists in `lib/personas.mjs` (`synthesizePersona`), seeded by
  the run id so a rerun meets the same people. They are validated like a built-in, their voice
  describes the dials in words (never the numbers), and a scenario or intent errand replaces theirs.
  Their ids read `sampled-<6 letters>` (never digits: a six-digit run in her address reads as a sign-in code). The idea is adapted from dair-ai/Prompt-Engineering-Guide (MIT):
  sample attributes into each generation so the output does not collapse into sameness.
- **The workspace keeps its runs' records** in `<workspace>/.sue/`: `target.<page>.json` (derived from the URL the first
  time; it inherits the ground truth and exits of any hand-written target for the same page, and a hand
  edit to it survives), `scenarios/intent-<hash>.json`, `journal/<persona>.jsonl` (every visit she made,
  in her words) and `scoreboard.json` (every page, every run, a Sue-weighted all-time average, and the
  same totals split by the build the page served - the harness reads `<origin>/build-stamp.json` once
  per run, never a Sue; a page with no stamp buckets under "unknown build", never a guess). Sue run
  logs (`sue/runs/*`) and `.sue/journal` entries stay on the PC that ran them; only personas
  sync to the Boardroom (see "Every person lives in Connections" below).
- **Every person lives in Connections, and nowhere else** (Owner, 2026-09-28: "There should not be a single
  local personality in the workspace. They all should be stored in Connections ... because Connections is
  obviously superior"). A Sue's person is a Boardroom persona: the built-in roster is the Boardroom's built-in
  rows, and the workspace's own people are its Sue people. One free call to the Boardroom's Sue list
  (`builtIns: true`) answers both, and a critic's mind comes from its sue/mind door (`lib/people.mjs`). Dredd
  fetches them on the member's key and hands them to the engine in its args; any other start (AgentHydra's `sue`
  tool, a terminal) fetches them itself through a local MCP; the engine holds them in memory (`lib/personas.mjs`
  `installPeople`) and hands a run's own people to its cannon in a file the runner deletes when the run ends.
  `save_persona` makes a person, checks her with the loader a run uses, and saves her to Connections; nothing
  is written in the folder. So a person made in Studio, at a board or on another computer is the one a run
  sends, and there is no copy to fall out of step. `edit_persona` changes one in one call: her `id` plus only
  the fields that change, or ANY field by name in `set` (null removes one), and every other field stays as
  Connections has it; the next run sends her as changed. A field the engine learns later needs no change
  anywhere else: the Boardroom keeps every field a person carries except the ones it holds in columns (id,
  name, voice, form, mind). Changing a built-in gives the workspace a copy that holds only the change
  (`extends` is her own id), so every later improvement to the built-in still reaches her. A run's `personas` may also name ANY person in the workspace's Boardroom, a board member included:
  she goes for that run only, her brief as her voice, a roster body (`like`, default bob) and the run's
  intent as her errand (`lib/boardroom-cast.mjs`), never copied into the folder.
- **It refuses before it spends.** The cannon proves the brain answers and, for a run that makes
  accounts, that the mailroom can open both mail doors (`node sue/mailroom.mjs --probe`), before a
  single Sue number is reserved. A refused run reads `state: "refused"` with the reason.

## Focus groups

> Owner ask (Owner, 2026-09-23): "focus group is tons of Sues go into a room and they are presented
> with something, your website, something, and they all give their opinions. They talk to each other
> ... the Sues can see and talk to each other. And the goal is for the Sues to tell you what feels
> off ... Then they all agree and they give you literally what their biggest problem is. Then you fix
> that. Then you send in the next focus group. And the AI can make suggestions to Sues ... imagine
> the AI is managing the group ... we think this is the problem, okay, what do you think about this?"

One call sends a whole focus group at once:

```
sue { action: "focus_group", params: {
  url: "https://app.example.com/pricing",
  intent: "you are shopping for a plan and want the cheapest one that covers your team",
  count: 6, suggestions: ["we think the annual toggle is easy to miss"] } }
```

`focus_group` is `run` with a room already open (`focusGroup: true`, count default `FOCUS_GROUP_DEFAULT`
= 4, capped at `FOCUS_GROUP_MAX` = 12); a plain `run` opens the same room when you pass `focusGroup: true`
yourself. Every Sue in it is still a whole Sue: her own browser, her own account, her own rails - the
room is what she does BETWEEN and AFTER her moves on the page, never instead of them.

**What happens:** they all go in at once. Every diary line a Sue writes is heard by the others as she
writes it, and she can talk to them directly. Once she is done or gives up she comes to the table; once
everyone is at the table (or the moderator calls the rest in) the moderator asks the room what felt off,
puts your `suggestions` to them only after they have looked for themselves, and the room proposes and
votes for problems until most of them back one. The moderator concludes in words, or, if it never does,
a vote watchdog closes the room once every present Sue has voted and the last vote has sat a few minutes.
Either way there is exactly ONE verdict: the single biggest problem, who agreed, who did not, and their
own quotes. It is booked to `.sue/focus-groups.jsonl` in the workspace, keyed by page, so the fix loop is
"read the verdict, fix that one thing, send the next focus group at the same page" - and that next room's
moderator is briefed with the last group's problem and asked whether it is still there.

**On disk (`<runId>/room/`):** `room.json` (the page, why they came, your suggestions, the last verdict
on this page), `roster.json` (every seat: id, name, persona), one `<speaker>.jsonl` per speaker (each
Sue, `moderator`, `host`, append-only) and `verdict.json` (written once). Full shapes: [SPEC.md § Focus
group](SPEC.md#focus-group).

**The hands:** a focus-group Sue is served three extra moves, no page needed - `room` (hear what she has
missed), `say` (talk to whoever is still there) and `vote` (back a problem already on the table, or put
a new one down in her own words). The moderator gets its own five: `room`, `ask` ("we think X is the
problem, what do you think?"), `propose` (put a problem on the table in the room's own words), `gather`
(call the website in) and `conclude` (close it once most of them agree). Neither ever reaches the page:
the moderator never sees the site, only what the Sues say about it, and the vote is counted, never judged.

**Where to watch it:** the Sue Manager's run page shows the room live, same as any other run, and the
Manager and `sue room`/`sue room_say` let the human host read it and speak into it. The Boardroom's own
Focus Group gives every seat a face and a voice, so you hear them journaling aloud and can talk to the
group yourself.

**How an AI finds it:** Dredd's bench carries it as the `focus-group` instrument, and an ask that orders
one by name convenes it: `node dredd/dredd.mjs "run a focus group on https://app.example.com/pricing"`
names it with its `sue focus_group` run line and `--collect` reads the room's verdict home
([DREDD.md](../../docs/how-to/DREDD.md)). A catalog search for "focus group" finds this `sue` tool first.

## APE

APE (Adversarial Product Evaluation) is the fourth SUE-family instrument, beside a plain Sue, the Focus Group and the
Boardroom. It asks a different question. A plain Sue is a stranger who gives her opinion of the place. An APE Sue is a
familiar power user: she uses this product, or the best one like it, every day, tries to get her job done the fast way,
uses the shortcuts a power user uses, and gets annoyed at anything that does not work the way it should. Her output is
what broke her expectations, not what she thinks of the place.

**How it differs from a plain Sue**

- **Who she is.** Only comfortable users are seated: `techProwess` 4 or 5 out of 5 (the comfort-with-computers dial).
  A run that names someone below 4 is refused, and the refusal names them. A run that names nobody casts only the 4s and
  5s, and the picker is told the visit is for power users.
- **Her brief.** She is told she came to get the job done the fast way she always does. She is not reviewing the site.
  She works the way a power user does (Enter to send, Tab between fields, back and reload, an address typed straight in,
  undo, a second click), writes each annoyance or broken thing down the moment it happens (what she did, what she
  expected, what happened instead), then works around it and keeps going until it is not worth it any more.
- **Her first line.** "Open it and get done what you came for, the fast way you always do: you know how this kind of
  thing should work." A plain run opens with the stranger's "Open the page and try to do what you came here for."
- **Her scenario.** An APE scenario carries `ape: true` and its own id (the id includes `|ape`), so it never shares an
  id with a plain run of the same intent. `ape` is only `true` or not set; any other value is refused in plain words.

**How to run it**

```
node sue/sue.mjs ape --json-file f.json
```

`f.json` holds what a `run` takes (`url`, `intent`, and optionally `personas`, `count`, `presue`). `ape` is exactly `run`
with `ape: true` set, the way `focus_group` is `run` with a room, and it gives the same answer. AgentHydra's `sue` tool
has the same action, `ape`, and Dredd convenes it as instrument `ape` (`docs/how-to/DREDD.md`).

```json
{
  "url": "https://example.com/renew",
  "intent": "you renew your team's subscription every month and want to do it in one go, the fast way you always do",
  "personas": ["dev-dan"]
}
```

**What her exit interview asks** (`APE_QUESTIONS` in `lib/findings.mjs`, in this order)

- `brokeExpectations`: every place it did not work the way it should: what you did, what you expected, what happened instead.
- `shortcutsThatFailed`: every shortcut you tried (a key, Enter, Tab, back, reload, an address typed straight in, undo, a
  second click) that did nothing or the wrong thing, word for word.
- `slowestPath`: the job that took the most steps or the longest, how many it took, and how many it should have taken.
- `lostWork`: did it ever lose something you typed or did? `{yes, what}`.
- `annoyanceScore`: 1 to 10, how annoyed you were by the end (10 = you are done with it).
- `fixFirst`: the one thing they should fix first so you would stop being annoyed.
- `wouldUseInstead`: the product you would use instead for this job, and what it does better or worse.
- `wouldUseDaily`: would you use this every day for this job? `{yes, why}`.
- `starsOutOfFive`: 1 to 5, the rating you would really leave.
- `threeWords`: three words for the whole experience.

**What the report shows.** A section headed "APE: power users" in the report text, and an `ape` key in the report JSON: how
many power users answered, their average annoyance and stars, how many would use it daily, how many lost work, a tally of
the fixes they named first, and every broken expectation and failed shortcut, verbatim with the Sue who said it. A run with
no APE Sue has no such section.

## ART

ART (Aesthetic Review Team) is a design review. Three professional UI and UX designers walk a product on a phone and on a
computer and return a polish list: what to change, why, the exact fix, and how badly it hurts. They are critics (the same
machinery as the critics in "The critics" above), marked with `studio: "art"`. Their people live in Connections with the
others, and the engine knows them by that mark.

**The team.** `art-mobile` (a phone in one hand), `art-ux` (the errand and the flow) and `art-visual` (the layout, type and
colour). A run with `art: true` seats all three by default, one visit each. Name designers in `personas` to seat fewer; a
name that is not a designer is refused by name, and so is a count above the number of designers seated.

**How to run one.** `node sue/sue.mjs art --json-file <path>` runs the design review, or pass `art: true` on a run
with a url and an intent, or a target and a scenario. An art run cannot be combined with `ape: true` (a power user's visit)
or with `watches: "ad"` (an ad viewer): each is a different instrument. There is no pre-sue cast: nobody is chosen from the
ask, the designers are the seats.

**What a designer writes.** Her diary is the deliverable, and it has two kinds beside the usual ones:

- `polish`: a design flaw. `text` is what is on the screen now. `why` is the principle, with its id from her knowledge (such
  as [G2]), or the word `judgement`. `fix` is the exact change, concrete enough to make without asking. `severity` is 1
  (polish: a professional notices it), 2 (friction: people slow down or mis-tap) or 3 (broken: people fail, give up or are
  misled). Anything outside 1 to 3 is refused, and so is a polish line with no fix.
- `keep`: a design choice that works and must survive the polish. `text` is the choice and `why` says why it works. A keep
  line has no severity.

Every line carries how far into the visit it was written (`visitSeconds`). A dark pattern, such as fake urgency or a
reward held in front of a paywall, is a severity 3 polish line whose fix is the humane replacement.

**What a designer answers.** Eight shared questions, asked of every designer on top of her own: `designGrade` (a whole
number from 1 to 10, anything else reads as no grade; 7 or above means it holds its own beside Google's and Apple's best
apps, and a tidy stack of plain boxes, tables and text blocks is a 4 at most), `topFixes` (her five biggest changes, ranked),
`progressiveDisclosure` (what shows too early, what hides too deep, and every block of text a visitor would skip),
`colourMeaning` (whether each colour that carries meaning says what a person expects: green yes, red a problem, amber a
warning, blue information or an action), `appeal` (whether people would want to open it again or it reads as a dull form,
and what would make it look made with care), `screenFit` (what crowds or breaks on the screen she used), `keep` and
`wouldShip` (yes or no, with the one change that must come first). The anchor and the two colour and appeal questions came
from the owner's 2026-10-12 review of Benefit Buddy, whose blue "You qualify", grey boxes and unread text block the team
had passed.

**What the report shows.** A section headed "ART: design review" before "The verdict", only when a designer ran. It lists
the designers and their devices, the average grade out of 10, who would ship it as it is, every severity 3 polish line
across the team as "screen: what - fix [principle] (who)" to fix first, the screens by design debt (their severities added
up, with the polish and keep counts), each designer's top fixes and answers, and then every polish and keep line in the
order it was written. The report JSON carries the same as an `art` key: `designers`, `devices`, `grade`,
`wouldShip: { yes, no }`, `fixFirst`, `debtByScreen`, and `answers`. It is `null` when no designer ran.

**What does not change.** A designer's stars are rated the way a critic's stars already are in the verdict, so the verdict
treats her like any other critic. A plain Sue's note kinds, her note description and a non-designer critic's brief stay as
they were.

## Field

A field run is the owner's review pipeline, front half, through one door (the Chair, 2026-10-10): "We use a JEV-type model to
determine what the... project scope is ... Then that determines which... persona we should be using. Then we generally would
s- send Sue after it. If she had design issues, we would run Art. Then occasionally, we'll throw Ape through it ... Then their
findings would be... noted." The Boardroom's half (Jev routes the REAL claims to experts, who write the burn-down list) is
Dredd's.

    node sue/sue.mjs field --json-file errand.json                         run it (hidden; answers in seconds)
    node sue/sue.mjs field --json-file errand.json --json '{"dryRun":true}'   every decision, nobody launched
    node sue/sue.mjs field --json '{"fieldId":"<id>"}'                      read a field run back

The errand is a run's: `url`, `intent`, and optionally `expect`, `count` (SUE's visitors, default 3), `createAccounts`
(`false` when the visitors need no account, such as a demo: every wave then runs without the mailroom), `contactSupport`
and `owned`; the last three ride to every wave as the caller gave them. The decisions, each
recorded with its reason in `field.json` (under SUE's state folder, `field/<id>/`) and in the docket:

1. **Scope.** Jev picks one of `medical`, `education`, `kids`, `finance`, `business-tool`, `developer-tool`,
   `general-consumer` or `entertainment` from the page and the errand. The scope goes into pre-sue's fit question and its
   cast prompt, so a medical page is judged by its patients and carers rather than by whoever the roster holds. A scope Jev
   does not name is recorded as unread, never guessed.
2. **Who goes.** Pre-sue, with that scope, picks SUE's visitors and drafts any kinds still missing. Visitors are never
   hand-named unless the caller names them (`personas`), and then the record says "named by the caller".
3. **SUE first.** Her wave runs alone and is waited on.
4. **ART on design trouble.** Every claim SUE filed (the same claims the room will rule on) is one yes/no for Jev: is it
   about how the screen looks or is laid out, rather than a bug, a missing feature, the data, the wording or speed? ART
   runs on the same page and errand when at least one claim reads design at 0.5 or above. With no Jev, the claim's own
   words decide, and the record says so.
5. **APE now and then.** The caller's `ape: true` or `ape: false` wins and is recorded as the caller's. Otherwise APE
   goes once the site has had enough field runs without it: one for a product its visitors come back to again and again
   (Jev's yes/no), three for anything else. So a site's first field run is SUE's (and ART's), a daily-use tool gets APE on
   every other field run, and anything else on every fourth. Only field runs count (SUE's state folder,
   `field/ledger.jsonl`); a wave started by hand does not.
6. **One docket.** ART and APE run together once SUE has finished. When every wave has ended, the finished ones go to the
   room in ONE docket, once: `dredd.mjs --run sue:<id>,art:<id>,ape:<id> --hearing --detach --field <field.json>`. The
   docket keeps the field's record (`field`) and prints its decisions under FIELD in `docket.md`. No wave hands itself to
   the room (`hearing: false`). The hand waits for the room: one cheap meeting-open first, and while the Boardroom refuses
   (its allowance or credit spent) it asks again every 10 minutes for up to 6 hours, recording the wait. A room that never
   opens keeps the waves unhanded rather than filing a verdict with no rulings in it.

The waves are ordinary AI-started waves: headless, the chat brain on CliMayte sealed unless `brain` or `dispatch` says
otherwise, and a field run that cannot reach CliMayte is refused before anything is booked. `dryRun` reads the page and
asks Jev and pre-sue for real, but saves nobody and launches nothing. `sueRun` (dry runs only) reads an earlier SUE run's
claims, so the ART decision shows too. The rules are in `lib/field.mjs`; the spec is `tests/field.spec.mjs`.

## Rounds: users, critics and a target

> Owner, the Chair, 2026-10-01: "The synthetic process is the answer, not real people ... Students and teachers say what
> they need; the boardroom's experts ... decide how ... The stars are the target, and it should improve as it goes,
> every round."

A ROUND is several runs at one product at once (a class of students on their own demo seats, a panel of teachers),
scored against a target and kept as a series, so each round is read against the ones before it:

```
node sue/round.mjs start  --plan <plan.json> [--focus [--room <key>] | --teachers] [--no-critics] [--fresh]
node sue/round.mjs report --plan <plan.json> [--no-table]
node sue/round.mjs trend  --plan <plan.json>
node sue/round.mjs times  --plan <plan.json>
node sue/round.mjs table  --plan <plan.json>
```

- **The plan** is the product's own JSON file (Lift's `docs/kids/class-cast.json`): `series`, `demo` and `reset` (a POST
  that resets the demo), `url` (the page the table hears), `root` (the repository judged), `target` (`stars`,
  `finished` of `of`, `inARow`; 4.5 stars, 5 of 6 and two rounds running by default), `doneWhen` (texts a finished
  person's screen shows), `progress` (a regex whose two numbers say how far a person got), `intent`, `expect` (optional, `{en, es}` or one
  string, as `intent`: what the page is meant to be, handed to every run's spec; `reference` and `teachers` may carry their own), `students`,
  `critics`, `rooms`, `teachers`, `suggestions`, `createAccounts` (optional: `false` when the visitors make no account, so
  the runs need no mailroom), and `pageMotion` (optional: the names of animations that are the page's own
  progress, such as a voice note's playback fill; a look taken while only those moved is what a person meets half-way too, so
  the hunt does not rank it as SUE's fault).
- **Critics walk beside the users.** A plain round also sends the plan's `critics` (`retention-doctor` and
  `game-designer`, below), each on a seat of its own, and says loudly when a plan has none. Their drops are evidence;
  their stars never count.
- **`report`** prints each run, then the round: each user's stars, FINISHED or the part they stopped in, the critics'
  worst drops, and the target, the trend and the next work (`lib/rounds.mjs`): `done` (the target held `inARow` rounds),
  `met` (confirm it), `stalled` (two rounds within 0.3 stars and no new best: design), `early` (under half finished:
  design), `improving` or `first` (fix the biggest problem). The round is kept in
  `<workspace>/.sue/rounds/<series>.jsonl` (plain, `.focus` and `.teachers` apart).
- **The series ends at its ceiling.** After the ceiling check, three complete rounds with no new best and the target
  unmet make the series `ceiling`: `start` refuses until the live build id or the plan changes (`--despite-ceiling
"<reason>"` overrides). The owner's words, 2026-10-03: "a reasonable cutoff, so we don't end up running till infinity
  attempting to achieve a score that is potentially technically impossible."
- **The table starts by itself.** Once every user has given stars, `report` starts Dredd's round hearing detached
  (`dredd.mjs --round-file`, [Dredd README](../dredd/README.md#a-round-its-target-and-the-design-board)): the review table
  sits over the round, and when the trend says design the design board drafts a redesign. `--no-table` holds it.
- **Identity reuse (opt-in: a plan with a `reuse` block).** A student whose visit is decided by exactly what decided her
  last fresh visit is not sent again. Five parts, each a hash kept in the visit's `reuse.json` (`parts`): the engine id,
  the `sue-driver` definition (`reuse.driver`, default `~/.claude/agents/sue-driver.md`), the hands MCP's files (a
  staged engine's own on an `--engine-ref` round, since those are the hands she runs), her
  persona docs (the one she `extends`, and for a critic her mind, the playbook), and the run's own args; plus every live
  build id the plan names (`reuse.builds: [{ url, header }]`, read from a HEAD). All must be byte-equal, or she is sent
  fresh. The cheap parts are compared first, with the build HEADs already in flight; the people are fetched once, in
  process (one Sue list, the critics' minds side by side), and only when someone's cheap parts and the builds still match.
  A round where something already changed says which part (`NO REUSE: the engine changed; ...`) and fetches no people; a
  build that cannot be read says why in one line. Both that line and `NOTHING CHANGED` end with the elapsed time and where
  it went, e.g. `(612 ms: builds 401, people 0, engine 180, hands 7)`. A reuse.json without `parts` never matches. A
  reused student's state row points at the fresh visit, `report` labels her `(reused from round N)` and the row lists her
  in `reused`; when every student is reusable `start` prints `NOTHING CHANGED` and starts nothing (no demo reset, no
  row). `report` writes `reuse.json` only into fresh visits, and only if the builds did not change during the round (a
  round that fetched no people at start gets its docs part from one fetch there). A reused round can break a streak but
  never extend one: "target held N rounds running" is only earned by fresh measurements. `--fresh` turns reuse off for
  one start. The people are asked through a warm holder (`people-door.mjs`: one open local-MCP door, 127.0.0.1 plus a
  token, gone after 30 idle minutes) when one answers within ~100 ms; `report` and a `start` that had to open a door
  itself leave one running, detached and hidden. The timing line says `people N warm` or `people N cold`. Every part is
  still checked live at the start (the holder keeps the door and the HEAD connections open, never an answer). A holder
  that offers it answers the builds, the engine id (a stat of the engine's files, hashed only when one changed, so a
  same-size rewrite still counts), the list and the critics' minds in ONE local call, side by side; it re-warms its HEAD
  connections at most once a minute without resetting its idle exit, and a holder whose own code changed answers no
  engine (this process hashes) and exits.
- Drivers: every Sue is ONE sealed CliMayte task. `start --dispatch climayte` has SUE send them itself (start no
  agent; it refuses, starting nothing, when CliMayte is unavailable). Without it, `start` prints
  `node sue/dispatch.mjs <runId>` per run and the `climayte_run` call; only when CliMayte is unavailable (or a
  run's engine wrote no sealed launch) does it print one brief per Sue for one `sue-driver` agent each, all in one
  message, with the Agent tool, never a Workflow.

### Reference rounds: measuring against a known product

A series can measure its students' rating against a reference product (a product the panel is known to like),
rather than a fixed star count. Send the same students to visit both, and judge the series by whether it closes
the gap:

```
node sue/round.mjs start  --plan <plan.json> --reference
node sue/round.mjs report --plan <plan.json> --reference
node sue/round.mjs trend  --plan <plan.json> --reference
```

A reference round uses `plan.reference: { url, intent, expect?, series, doneWhen? }` (the plan's students only, no
critics, no demo reset). Its stars are recorded under `plan.reference.series` (e.g. `calibration-reference`).
The main series then reads the reference's latest stars and compares against it: when the plan carries
`target.starsVs: { series: '<ref-series>', within: 0.2 }`, the bar becomes `reference_stars - within`.
If no reference round exists, it falls back to `target.stars`. The measured numbers (Lift, 2026-10-03):
the same six students rated Wordle 3.83 and Lift 3.67 on the standard question; with zero 5s on either,
a one-visit panel's 4.5 target is unreachable, so judge on finishing, drops and critics' findings instead.
Once a reference round exists, a series that goes three rounds with no new best is AT CEILING and no longer starts
(see above): the reference is what says the score may be out of reach.

## Improving SUE itself (the hunt)

> Owner, 2026-10-04: "RSI needs to always be implemented during sue, dredd, et cetera." Every round is also a run on SUE.

`node sue/round.mjs hunt --plan <plan.json>` (`--json` for every item) ranks SUE's own faults, heaviest first, each with
its evidence and one action that names the file to fix; `report` prints the top 5 right after its STATE/NEXT block. It reads
only what is on disk for the series' last three rounds, writes nothing, and calls no model (`lib/sue-hunt.mjs`, the same shape as
Dredd's `--hunt`): a round short of runs or a run that ended as a brain error (`no-start`); findings triaged `sue-side` in
`repro.json`; looks noted `look-mid-motion` (a picture taken while an animation still ran); the SUE-side suspects `report.mjs`
already computes (`tired-driver`, `door-refused`, `frozen-screen`, `browser-lost`); a driver that never made a `see` move
(`off-protocol`, read from her `sees.jsonl`, where `hands-mcp.mjs` writes one row per `see` since 2026-10-04; rounds from before it
have none, and the hunt says so once instead); timing outliers as `times` reads them (`slow`); a
persona whose stars or finishing flipped between two visits on the same engine, driver, hands and builds (`unstable`); and
decision changes with no A/B ledger row (`unmeasured`: commits since `SUE_AB_POLICY_SINCE` touching a `SUE_DECISION_PATHS`
file, or a new driver or hands hash on the same builds, against `eval/ab-ledger.jsonl`, `lib/sue-rsi.mjs`).

Take the top item and fix SUE in the same session, then measure the change with the A/B (`node sue/ab.mjs`, which writes the
ledger row the hunt reads back). "Nothing SUE can see wrong with itself in the last N rounds" is a result to say, not to skip.

**The people hunt** (`node sue/round.mjs people-hunt --plan <plan.json> [--json]`, `lib/people-hunt.mjs`) is the same signals
filtered to personas: each row has the persona id, a score, its evidence and one rewrite direction. Rewriting one is
`rewritePersona` in `lib/people-rewrite.mjs`: the engine's brain writes the new doc, it is saved through the door, and the prior
version stays in cranium's `sue_persona_versions` (a trigger on `sue_personas`). It is kept only if its verdict reads `better`:
the verdict comes from a `comparison` (`comparePersonaDocs` in `lib/sue-ab.mjs`, her newest docs against her previous ones on the same builds, read by `node tools/sue/ab.mjs --series <name> --persona <id>`) or, without one, from the `verdict` its caller passes in (default `unmeasured`). Otherwise the prior doc is saved back and the ledger gets a
`persona-rewrite` row either way, carrying the comparison's own reason.

**The A/B** (`node sue/ab.mjs --series <name>[,<name>...] [--record]`, `lib/sue-ab.mjs`) groups a series' visits into arms by
the `parts` hashes in each visit's `reuse.json` (engine, driver, hands), compares the newest arm with the newest older one on the
personas and builds both share, and answers better, worse, same or unresolved (the read is tester-army/e2e's paired bench A/B,
ported in `dredd/lib/regularizers.mjs`):

- **Behaviour first.** A Sue's path is her ordered routes from `trace.jsonl` (host, path and hash, a repeat counted once). One
  whose path differs between the arms, or between two rounds of one arm, did different work: she is printed before any number
  (a Sue who stopped finishing first) and left out of notes, problems, stars and characters. `finished` still counts everyone,
  since stopping short is itself a change of path.
- **Then the numbers.** Per metric, each persona's mean per visit in the head minus in the base; a seeded bootstrap of the mean of
  those gives a 95% interval, read against a fixed dead zone per visit (notes 2, problems 0.75, stars 0.25: two thirds of one
  persona's spread between two rounds of one arm, measured 2026-10-07; finished 0.1: finishing never moved between rounds, so
  its zone sits under one person in eight and three of eight stopping read worse). Wholly past it is better or worse, wholly
  inside is same, straddling an edge is unresolved. Characters is shown with its interval, never judged. A metric left with
  fewer than two people (every Sue but one took another path) is `not read`: no mean, no interval, no round owed for it, and
  the verdict stays unresolved, so the behaviour block is the result.
- **The stop line.** One round of either arm is unresolved whatever its interval: arms run hours apart, so one round's weather
  rides with the arm. `another round:` says whether a round is owed and of which arm (the one with fewer rounds), only while
  the verdict is unresolved, up to three rounds of each; at the budget it says the change is smaller than an 8-person panel can
  see. Most A/Bs of a change that does nothing end there, and that is the panel's limit, not a pass.

`--record` writes the ledger row and exits 1 on worse unless `--accept "<why>"`; unresolved exits 0. A change measured and thrown
away is `--reject --note "<why>"`. Only visits since round 8 of lift-v2 (2026-10-04) carry `parts`, so older rounds are no arm.
`--base <hash prefix>` (and `--head`) picks an arm by its engine, driver or hands hash instead of the newest; the row
names the decision-file commits the head has and the base has not (`git log base..head` when both arms ran on Sue's
code at a git ref, else those between the two arms' newest visits), so it says what was measured. A series lives in its
plan's workspace (`<workspace>/.sue/rounds`); for a plan whose workspace is not this repo, pass `--rounds-dir` with that
folder, or every visit reads as carrying no identity.

**An old-engine arm.** A change to SUE itself needs an arm on her code from before it, over today's builds and people:
`node sue/round.mjs start --plan <plan.json> --engine-ref <ref> --fresh` (any git ref: a sha, `HEAD~5`). The round
stages Sue's code at that commit once (`lib/engine-store.mjs` `stageEngineAt`, from git, never touching the checkout's
files; `node sue/lib/engine-store.mjs stage --ref <ref>` does only that and prints the id and commit), prints
`ENGINE <ref> = <commit>: <id>`, and hands every run to that snapshot's own `sue.mjs`, which plans and runs it. Its visits
carry that engine's id and its rows go to `<series>-engine`, so it never moves the live trend. Two arms on two engines can
share that series (each from its own plan folder): each one's report reads its trend from its own engine's rounds only.
Report it with the same `--engine-ref <ref>`, run a current round beside it, then
`node sue/ab.mjs --series <series>,<series>-engine`. A ref naming no commit, or an engine too old for today's run
protocol, is refused with what it lacks; nothing falls back to the current engine.

## The critics: where attention breaks, second by second

> Owner ask (Owner, 2026-09-27): "a Sue personality ... whose only job is to go through our platforms and
> be like a user would drop off here. There's not enough retention here. This is a boring step ... if
> you're watching a video and you look away for a second and look back, that part of the video needs
> edited because it lost the user's attention."

Three of this workspace's Sue people are critics, not visitors:

- `retention-doctor`: a behavioural scientist of attention and retention. Her mind, the attention
  clinic, is the science: the first seconds on a page, attention lapses, what the
  eye takes in, thinking load, attention in video, reward and dopamine (and what the "social media is
  cocaine" story gets right and wrong), open loops, motivation, habit, social pull and interruption,
  onboarding, dark patterns and the myths.
- `game-designer`: a free-to-play designer of first sessions, core loops and game feel. Her mind,
  the game design studio, is the craft: games measured, what the top games documented, and the
  field guides of Hodent, Sakurai, Koster, Schell, Kim, Eyal, Chen, Norman, MrBeast, Kallaway and Murch.
- `ads-readiness` (Owner, 2026-09-30: "if a human ran through this, would they stay? Would they leave?
  Would they purchase?"): a consumer psychologist and conversion researcher who arrives from a paid ad and
  says, screen by screen, stay, leave or buy. Her mind, the buying clinic, is the science of the paid click,
  offer clarity, trust for an unknown brand, the plan page, checkout friction, how a small-business owner
  decides, what running ads needs first, and where persuasion becomes manipulation. Her `drop` is the moment a
  buyer leaves or decides not to pay, her `hook` the moment they lean toward paying, and her exit interview
  ends in `readyForAds`.

Every entry in a mind is one mechanism with its evidence and grade (every citation was checked at its
source by a second agent before it was kept), what it looks like on a screen, the question to ask and the
fix. Each chapter ends with the myths in its area, so a critic says where the popular story is wrong too.

**Where a mind lives.** In Connections, never in the repo or the folder (Owner, 2026-09-28: "Why would any of
these knowledge files be in GitHub?"). A critic is one of the workspace's Sue people and her mind is her
Boardroom row's playbook. The process that starts a run fetches the minds of its critics with its people, and a
run pins them at its start; a critic with no mind is refused before a Sue number is spent. To edit a mind, pull
it, edit it and push it:

```
node sue/mind.mjs pull retention-doctor mind.md
node sue/mind.mjs push retention-doctor mind.md
```

A push reads her copy from Connections first, so it never rolls back a newer edit of her, and it is done only
when Connections answers holding exactly that many characters.

**What she does.** She walks the ordinary visitor's path with the visitor's hands and rails, and writes a
diary line on every screen: a `drop` (the moment a person would look away or leave) or a `hook` (the moment
something held them), each with why (the entry id in her mind, like `[B4]`), the fix and a severity
(1 attention dips, 2 some leave, 3 most leave). Every line carries two clocks: in her words, how long a
first-time visitor would have taken to get there, and beside it her body's stopwatch, which counts only
reading, taps and waits. Compulsion mechanics are logged as harms, with the humane
version that keeps the retention.

**Running them.** Send them with a visitor, on the same page, so one shows what a person did and the other
says why:

```
sue { action: "run", params: {
  url: "https://example.com",
  intent: "a friend sent you this link and said it replaces all his event apps",
  personas: ["tiktok", "retention-doctor", "game-designer"] } }
```

A game, from the Connections folder: `node sue/sue.mjs run --json '{"target":"../NexusCode-2D/.sue/target.json","scenario":"first-match","personas":["tiktok","game-designer","retention-doctor"]}'`
(any product's `.sue/target.json` and its own scenarios work the same way, see "Pointing SUE at another
product" below).

Dredd sends them by itself (`criticsFor` in `dredd/lib/convene.mjs`): an ask about drop-off, boredom,
attention, engagement or people coming back adds `retention-doctor` and `game-designer`; an ask about ads,
buying, paying, checkout, pricing or whether people stay or leave adds `ads-readiness` and `retention-doctor`.

**Reading it.** The report's "Where attention broke, moment by moment" section lists the severity-3 drops
first ("fix these first"), then the pages ranked by attention lost, then each Sue's timeline as
`0:07 DROP 3 on <page>: "<what she saw>" - why: ... - fix: ...`. Her journal keeps the timeline and her
answers to her own exit questions (time to first value, the reward map, the reason to come back tomorrow,
harms, top fixes), so the journal is the running list of what to fix on each page.

## The four processes

```
sue/
  sue.mjs           THE ONE DOOR: `sue run` (the MCP `sue` tool, the Manager's New wave) plans a run, writes its record, starts the cannon
  cannon.mjs        the launcher: N Sues, M at a time, --forever if asked; owns the run dir and the ledger; starts only from `sue run`
  body.mjs          ONE MCP stdio server PER SUE: her eyes, hands, inbox and diary (Playwright inside)
  mailroom.mjs      ONE per run: holds the AWS creds, polls our inbound mail for every Sue address
  report.mjs        aggregates a run (or every run) into report.md / report.json / runs/ledger.jsonl
  reap.mjs          sends a janitor Sue back into every account a run created, to delete it
  lib/              perception, readability, clock, mime-text, personas, run-dir, claude-cli, findings, mcp-stdio, rails, sessions, profiles, door, workspace, workspaces, inbox-page, signup-door, watch-window, body-relay, delivery-failures, mailroom-core, mailroom-window, engine-lease, engine-store, manager-refresh
  personas/portraits the built-ins' painted cards (the people themselves are in Connections)
  targets/*.json    what site, what hosts she may visit, the declared ground truth, mailbox adapter
  scenarios/*.json  the task she is handed
  runs/             gitignored: runs/<runId>/... (relocate both this and state/ with SUE_HOME)
  state/            gitignored: counter.json (the Sue number), accounts-ledger.jsonl (every account ever made)
```

Every process is plain `node` v22 ESM, never bun: bun hangs Playwright's chromium launch on this box.

## An update never stops a running Sue: the engine store

> Owner ask (Owner, 2026-09-25): "someone starts a Sue on 1.14, you push 1.15, all the Sues keep
> running on 1.14, all new Sues start on 1.15, we never stop the current Sues."

Sue runs from source only, and about twenty chats land into this checkout every few minutes, while a
wave loads its code lazily (each Sue's body, the mailroom, the report). So `sue run` pins every wave to
a snapshot of the code it was started with (`lib/engine-store.mjs`):

- **The snapshot.** `<store>/<id>/` mirrors the repo: `sue` less `state`, `runs`, `tmp`,
  `tests`, scratch `*.tmp.mjs` and what `.gitignore` ignores, plus every repo file the engine imports
  or reads by a path built from its own folder, found by reading the code (never a list), and
  junctions to the checkout's `node_modules` folders for bare imports. The store is
  `SUE_ENGINE_STORE`, else `sue/state/engines`. The id is a hash of every path and byte, so
  identical code is one snapshot; staging is atomic (a staging folder renamed onto the id, its
  `.sue-engine.json` written last) and the run's log says how long it took.
- **Every wave is pinned.** The runner is the snapshot's own `sue.mjs` on the same node, and
  everything it starts runs from beside it; the run's spec and status name `engine: { id, root, exe }`.
  A snapshot keeps its state, runs and default workspace in the checkout, never beside its code.
  Another tool SUE starts as a job of its own (Dredd's round hearing, from `round.mjs`) is no part of
  the wave: it is the checkout's file on the current code, named `path.join(checkoutRoot(), ...)`, which
  the store does not carry. Named from SUE's own folder it would be copied into every snapshot with
  everything it imports, and whatever that reaches by a package name would be the checkout's live copy
  (`unpinned`, which the spec holds at none).
- **Leases and collection.** A process running a snapshot writes `<snapshot>/.leases/<pid>.json`
  with its real start time (`lib/engine-lease.mjs`) and removes it on exit. After each `sue run`, and
  hourly in the Manager, the store deletes a snapshot that is not the checkout's current code, has no
  live lease (the pid is alive and Windows created it within 10 s of the lease's start) and was not
  staged or reused in the last ten minutes. It never follows a junction and skips what Windows holds.
- **A live run is acted on by its own snapshot.** `stop` and `room_say` (the CLI, the MCP door, and the
  Manager's Stop and room) re-run through the run's snapshot when it is live and not this code
  (`routeLiveRun` in `sue.mjs`); a move is sent by the run's own `lib/hand-move.mjs`, imported from its
  snapshot. A run on this code, a dead one, or one from before snapshots is handled here, and a routed
  command is never routed again.
- **The Manager refreshes itself** (`lib/manager-refresh.mjs`): it stays this checkout's `manager.mjs`,
  notices within about a minute that the checkout's code changed, and hands its port to a fresh Manager
  once the change has settled and no sign-in window or file-serving wave needs it. It never stops a
  run; a successor that never answers leaves the old one serving, and the same code is not tried twice.
- **Shared files keep what they do not know.** Settings, the Sue counter, saved logins, a saved
  persona and scenario, and the scoreboard are written over the file as it stands, so an older snapshot
  still running never drops a field a newer one added. The brain's seeded Claude config lives in the
  state folder (`SUE_HOME`), never in a snapshot the store deletes.
- **The shared browser holds its snapshot too.** The machine's one Sue browser is owned by
  `browser-host.mjs`, started from the snapshot of whichever wave needed a browser first and outside
  every run's tree, and it leases that snapshot. Every later wave joins it, so the first snapshot stays
  in the store until no wave has used the browser for its idle time (about 90 s), then goes.

### Proving it on real processes

`e2e-live-update.mjs` runs the whole thing on real processes, in one temp folder (`SUE_HOME`,
`SUE_ENGINE_STORE`, `TEMP`, a workspace and a fake checkout copied from the engine's closure, with
junctions to the real `node_modules`), against a two-page site on loopback, so Chrome runs headless:

```bash
~/.claude/tools/fairjob.cmd -Weight 3 -Run "node sue/e2e-live-update.mjs"
```

It starts a one-Sue chat-brain wave (A) and moves it once, changes a file, starts wave B on a new
snapshot, moves A again through the changed checkout's `hand.mjs` (sent by A's own snapshot), checks
that every process of wave A loaded only A's code, starts a Manager that must hand its port to a fresh
one when the code changes again, stops A through the checkout's CLI (carried out by A's snapshot), and
collects: A goes once nothing leases it, the current code stays, the real `node_modules` are
untouched. Which code each process ran comes from a module-load hook it passes in `NODE_OPTIONS`. It
kills only processes whose command line names its temp folder, prints one JSON verdict
`{ ok, root, steps }` and exits 1 when a step failed. It is in no test lane: it launches Chrome and
takes about seven minutes (the Manager moves on its second look at the code, a minute apart, and the
shared browser closes after its idle time).

## Which SUE ran it, and how often a page has been hit

> Owner ask (Owner, 2026-09-23): "we need to add version numbers to sue ... so we know when sue has
> been updated ... also we need a counter as to how many times sue runs ... we dont want sue running
> 57 times on the same page making changes in circles but its fine we just need to track it".

- **The version counts itself** (`lib/version.mjs`): `1.N`, where N is every commit since versions
  began that changed `sue`, so each change to SUE that lands is the next version with nobody
  bumping anything. Raise `SUE_MAJOR` (and move `SUE_MAJOR_FROM` to that commit) only for a change so
  big that old scores should not be compared with new ones. Files on this disk that are not landed
  yet are named beside it ("SUE 1.4 + 3 unlanded files"), never folded into the number.
- **Source only, so git always answers** (the Chair, 2026-09-25: "We use the source code only ever"): Sue runs
  from this checkout, never from a compiled app. The compiled Sue desktop app and its installer were removed
  that day; a `sue-version.json` stamp is only ever read if an old build left one, and `sue.app` stays null.
  A wave's snapshot (`lib/engine-store.mjs`) is the one exception: `sue run` bakes the version it read
  into the snapshot's `sue-version.json`, so the wave reports the SUE it started on, not the checkout's.
- **Every wave carries it**: `sue run` returns it as `sue`, and it is kept on the run record, the
  wave's line in `.sue/runs.jsonl`, and each scoreboard row, so a move in the stars can be told apart
  from a change to SUE. `status`, `report`, the Manager's run list, its header and the toolbar icon's
  hover text all show it.
- **Every wave sent at a page is counted**, finished or not: `sue run` returns `pageRuns` (`total`,
  `last24h`, `last7d`, and a plain `said` line), `status` returns the same, and the Manager's Pages
  tab shows the total with how many went today. The scoreboard's own `runs` still counts only the
  waves that finished and were scored. It is tracked, never capped.

## Every wave starts through `sue run` (the one door)

`sue run` is the only way a Sue starts: AgentHydra's `sue` tool (action `run`), the Sue
Manager's New wave, DREDD's hearings, or `node sue/sue.mjs run --json-file <args.json>`. The
cannon refuses (exit 2) any wave `sue run` did not start: its runner hands the cannon the run id in
`SUE_DOOR` beside the run record it already wrote (`lib/door.mjs`), and a hand-started cannon has
neither. That is what puts every wave on the Manager's wall and in `status`, `report` and `stop`, and
books every Sue into her journal and the page's scoreboard (Owner, 2026-09-23: "no ai can/wants to not
use the carefully crafted sue manager"). `cannon.mjs --dry-run` still prints a plan by hand. A
`--json-file` beats `--json` from a shell you do not control: cmd, PowerShell 5.1 and sh each quote
JSON differently.

## Running one Sue

A roster errand runs a hand-written target and one of its scenarios as written (`url` + `intent` is
the short way above):

```
node sue/sue.mjs run --json '{"target":"connections","scenario":"first-visit","personas":["grandma"],"count":1}'
```

Watch her live by tailing `runs/<runId>/sue-<n>-grandma/brain.jsonl` (the raw stream-json from her
Claude CLI session) or `trace.jsonl` (one line per tool call, with the clock reading and the page URL
at that moment; `result` keeps 200 characters of what she was told, and a look also records the page's own
text as `pageText`, up to 4000 characters, which never reaches her). When she finishes, her directory holds `interview.json` (her own words),
`findings.jsonl` (what she or her body noticed), `body.json` (the mechanical summary: outcome, OTP
timing, the clock) and `summary.json` (cost, turns, duration, whether she made an account).

A visit that ended without an exit interview (her CLI died, or her turns ran out) still finishes the round: `round.mjs`
reads `endedAt` from her `summary.json`, counts her as `noInterview`, and never waits on her or reuses her visit. A Sue
whose body failed to start has the reason in her own `body.stderr.log`; the relay only says "her body failed to start".

## Running a wave

```
node sue/sue.mjs run --json-file wave.json
# wave.json: {"target":"connections","scenario":"first-visit","personas":["grandma","tiktok","child","low-attention","bob","elaine"],"count":12}
```

Three scenarios are POSTURES - how hard she checks, on any target, not why she came: `careful-buyer` (every price,
total, date and count must agree with the page and the pages before it), `comes-back-later` (she reloads, goes back
and returns mid-task and expects her work to be there) and `slips-up` (typos, empty fields, a wrong code; she judges
each error message). A roster errand may name `startUrl` (a whole address on a host the target allows) to start
somewhere other than the target's front page; Dredd's charters (`node dredd/charters.mjs`) write such wave files.

Personas round-robin across the count; Sue numbers come from the global counter in `state/counter.json`
(starting at 1117, the owner's own example - "Grandma Sue 1117").

Each Sue arrives with an **errand** - her own reason for being there, rotated across the persona's
list by Sue number, printed as the first line of what she is told. That is what makes her try to do
something rather than review the page. A persona without one fails to load.

She is also told to **journal as she goes**, not at the end, and her hands help her: every six things
she does without writing anything down they ask her to (on the chat brain a note costs her none of her
moves, so journalling never sends her home early), and any click that throws her into a different
area of the site tells her so in words ("You were on notes a moment ago; this is accounts now.") and
files a `sent-to-another-area` finding. She rates us out of five stars and says whether she is ever
coming back; the report leads on both. Details: [SPEC.md](SPEC.md) § the exit interview and § her diary.

A running `--forever` cannon picks up changes to `body.mjs` and `lib/` with the next Sue: her body
is a fresh `node` process, and so is the render of her system prompt (`node lib/personas.mjs
--brain-prompt`), so the two never disagree.

If the cannon says `REFUSING to start: the brain cannot talk`, the `deepseek`/`openrouter` key pool behind
the Sues has no key with balance or credit, or hit a limit; the run spends nothing and exits 2. Check
`DEEPSEEK_API_KEY(S)`/`OPENROUTER_API_KEY(S)` (or HSwarm's key files in `~/.hswarm/secrets`) and run it again - there is no
CLI login to sign back into. The line also names the CLI it ran and its version (the startup log names
both too). If that CLI is too old for the model, it says so: set `SUE_CLAUDE_BIN` to a newer `claude.exe`
and run it again.

**You do not pick a wave size - the cannon does.** `concurrency` (the cannon's `--concurrency`) defaults to `auto`, which is the
smallest of 8, `cores - 2`, and what free memory allows after reserving 6 GB for the machine and 1 GB
for the run's single browser (a Sue costs about 400 MB). It logs the number with the free memory and
core count behind it. Pass `--concurrency N` to override; above 8 it re-executes under `fairjob`
unless `--no-fairjob` (shared box, owner rule).

The whole run shares ONE browser (a `launchServer` the cannon starts; each Sue gets her own context,
which is as isolated as a profile for cookies and storage). That is the fix for the 2026-09-21 run
that ran the owner's PC out of memory: 25 Sues used to mean 25 browsers, and the browser tree is a
fixed ~1 GB however many attach to it.

- `forever: true` (the cannon's `--forever`) loops waves until `sue stop` or `maxAccounts` is hit, re-writing `report.md` every 60
  seconds so you can watch the numbers move without stopping the cannon.
- `maxMinutes` (the cannon's `--max-minutes`) is the run's wall-clock cap: after it no new Sue starts,
  the ones in flight finish inside their own deadlines, and the report is written as usual. A counted
  run gets 45 minutes unless you name more; a `forever` run has none unless you name one; `0` lifts it.
  Runs are detached on purpose, so this is what ends a run whose chat is gone.
- `--stampede` holds every Sue in a wave at the door (her browser is up, her `look` call is blocked)
  until all of them are ready, then releases the whole wave in the same second. Use it when the
  question is "what happens to load, not to any one Sue".
- `--dry-run` prints the exact plan and the exact `claude` command lines for every Sue and spawns
  nothing - the fastest way to check a persona/scenario/target combination before it touches a real
  account.

## Pointing SUE at another product (never copy SUE into it)

`--target` also takes a PATH: `--target "../Example App Next/.sue/target.json"`. The product keeps
its own description beside that file and SUE stays here (Owner, 2026-09-21: "you will not copy Sue
to this workspace, you will merely use Sue"):

- `<dir>/scenarios/*.json` win over the roster's. A product's people are Sue people in its workspace in
  Connections like everyone's, and `"people": ["<id>", ...]` on the target names the ones it was written
  for. A person may `"extends": "tiktok"` to borrow a built-in's dials and identity ranges; her voice and
  errands must be her own, because the built-ins' are about an events site.
- `errands: { "<persona id>": [...] }` on the target gives a roster persona the product's reasons to
  visit; `errands` on a scenario (per persona, `*` for all) wins over both.
- `"extends": "./target.json"` on a target file: the live site and the dev server share one ground
  truth, one errand list and one exit list; only the address differs.
- `exits: [{ id, name, match, says?, finishes? }]`: an off-site URL that IS the product's next step
  (Sign in with Discord, a checkout). Still never followed, but recorded as `reached-exit`, counted in
  the report's funnel as "handed off", and she is told how far she got instead of "that is a different
  website". `finishes: true` also tells her the visit ends at that door, so she calls done instead of
  circling a page she has finished with.
- `blockRequests: ["https://analytics.example/**"]`: never loaded, so a Sue is never counted as a
  visitor on a live site.
- `canvas: true`: the product is PLAYED on a canvas (a game, a map), so she gets `point` (click,
  right-click, drag, zoom at a spot in her picture) and the whole keyboard on `press`. A spot over a
  numbered button is refused and named, so every button still goes through `click` and its rails.
  Her desktop is 1280x800 with CSS-pixel shots, so the spot she names is the spot she hits.
  Example: NexusCode-2D's `.sue/target.json`, and Project Switchback's (a Godot tower defense: its
  `.sue/build-web.ps1` exports a web build from a throwaway copy of the project and serves it; the
  roster's seven players and the `playtest` scenario play it, 2026-09-23).
- Files a Sue brings with her: `<dir>/files/<scenario id>/` (or a folder path in `files` on the
  scenario) is her folder. She is told the file names, and her `attach` hand puts one into a Choose File button or a
  drop zone on the page. She can never reach a file outside that folder.
- `knownAddresses: ["https://..."]` on a target or a scenario: addresses she already knows the way
  to (her server's dashboard, a channel), so she can go straight there instead of hunting through
  menus a real owner would skip.
- `interview: { "<key>": "<question>" }` on a scenario: extra questions she answers at the end.
  Each one gets its own section in report.md, next to the usual stars and review.

## The course: pages whose answer is known

`sue/course/` is a practice course: small pages, each hard for a visitor in one way, some with one
planted product bug, re-implemented from tester-army/e2e's web-benchmark (Apache-2.0). Every page has a
deterministic twin that does its task, so a Sue failing there is SUE's failure. Serve it with
`node sue/course/serve.mjs` (port 4620), point a wave at `sue/course/.sue/target.json` with a
page's slug as the scenario, and score the run with `node sue/course/course.mjs score <run id>`
(reached / gave up / never visited per page, found / missed per planted bug). The contract and the rest
are in [course/README.md](course/README.md).

## Signed-in Sues: borrowing a human's session

A Sue can never make an account on a product that signs in only through a third party (Discord,
Google). A human signs in once instead. Only there: on a site whose sign-up mail the mailroom reads
(every Connections target) each Sue makes her own real account, so the cannon refuses `--as` and both
login helpers refuse to save a session (`mustSignUpForReal` in `lib/sessions.mjs`; owner, 2026-09-22):

```
node sue/login.mjs --target <target> --as owner     # opens a window; sign in; it saves and closes
node sue/login-chrome.mjs --target <target> --as sandbox --free-hands   # the same, in real Chrome
node sue/sue.mjs run --json '{"target":"<target>","scenario":"dashboard","as":"owner","concurrency":2}'
```

Use `login-chrome.mjs` when the identity provider refuses the automated browser: Discord will not
sign anyone in from a Playwright-launched window, so Example App Next can only be captured this way.
It starts the machine's real Chrome with a profile of its own (his everyday Chrome and its accounts
are untouched), watches from outside over Chrome's debugging port, and saves the same cookies.

`login.mjs` keeps ONLY cookies set for exactly the target's host (never the identity provider's,
never a parent-domain one) in `state/sessions/<target>/<name>.json`, and prints names, hosts and
expiry, never a value. The target's `signIn: { url, probe, signedInField }` says where to sign in
and how to tell a real session from a stranger's 200. A product whose login cookie is scoped to its
parent domain names it, `signIn.cookieDomains: ["tickettool.xyz"]`, and then cookies set for exactly
`.tickettool.xyz` are kept too; a domain the start host is not under is ignored. Example App's review
host is the case: his API sets the session on the parent, so without it the saved sign-in is empty.
A run lends the saved session to every Sue with `as: "<name>"` (the cannon's `--as`).

Discord itself can be the product: a Sue in the Discord web app, using a bot the way a member does.
Discord keeps its sign-in in page storage, not a cookie, so such a target names the items
(`signIn: { localStorage: ["token"], authorizationFrom: "token", accountField: "username" }`):
`login-chrome.mjs` saves exactly those items (read over the debugging port, since Discord hides the
store from its own page), says which account it saved, each Sue gets them back before Discord's code
runs, and the probe sends the token as its `authorization`. An `allowedHosts` entry with a path
(`discord.com/channels/<server id>`) fences her into one server: the rest of Discord is another
website to her. Example: Example App Next's `.sue/target.discord.json`.

The cannon probes the saved session before it
spends a Sue number and refuses (exit 2) when it no longer signs in. A scenario's `startPath` (e.g.
`/dashboard`) is where she starts. Two hands-level rails (`lib/rails.mjs`) guard a borrowed account.
The target's `refuseClicks` regex names what deletes or removes (recorded as `refused-destructive`).
SUE's own borrowed-account rail, on every signed-in Sue whatever the target says, refuses any button
that would change something real: post, publish, send, save, create or generate, invite, pay,
subscribe, confirm, copy (recorded as `refused-real-change`). It reads buttons (and a page's own
options, menu items and switches), never links, tabs or check boxes, and Enter or Space is read for
what it would press, so a key cannot walk past it. A signed-in
Sue therefore looks and tries but never commits: she reports whether she would have pressed it. A
THROWAWAY account made for Sues is saved with `login.mjs ... --as sandbox --free-hands`: the flag is
stored with that account's session, and Sues run `--as sandbox` press anything (post, save, create,
delete). One rail stays on every signed-in Sue, free hands or not: signing out or deleting the
account (by its words, or a link to a logout route) is refused as `refused-session`, because every
other Sue in the run shares that session. Keep signed-in waves narrow (`--concurrency 2`): every Sue
is the same person.

A target that says `noCommit: true` puts that real-change rail on every Sue it launches, signed in or
not: an anonymous Sue on a public page can still write into somebody else's product (an RSVP on a
real host's event puts a Sue address on a real guest list). `targets/connections-events.json`, the
public events list, is one.

One Sue can carry her sign-in to two sites at once, for example a product's dashboard and the
Discord server it runs in: the target names `sessionParts: [{ id, target: "./target.discord.json" }]`
and each Sue gets every part's saved session for the same `--as` name. Sign in to each part through
that part's own target file, because `login.mjs` and `login-chrome.mjs` refuse a target made of
parts. Free hands apply only when every part was saved with `--free-hands` AND the combined target
says `freeHands: true` itself, and even then its own `refuseClicks` still hold on every site she
visits. Example: Example App Next's `.sue/target.ai.json`.

## Saved logins: any site, from the Manager's Logins tab

A per-target session above needs a target file with a `signIn` probe. A SAVED LOGIN needs only a name
and a site (Owner, 2026-09-23: "if I need to login to lets say discord for app testing using sue ...
save login cookies and such"). On the Sue Manager's Logins tab, Add a login: a name
(`discord-owner`), the site (`https://discord.com/login`) and, only for a throwaway account, "Sues may
press anything". His own Chrome opens on the site with a profile of its own; he signs in and closes
the window. The last look at that site's own cookies and its tabs' page storage is saved as
`state/profiles/<name>.json` (gitignored, 0600, `lib/profiles.mjs`); an identity provider's cookies on
another domain are dropped. From a shell it is the same window:

```
node sue/login-chrome.mjs --profile discord-owner --site https://discord.com/login [--free-hands]
```

A wave names it with `profile` (the MCP `sue` tool, the New wave's "Signed in as", the cannon's
`--profile`), and every Sue arrives signed in to that site, for example Discord for an app whose
"Sign in with Discord" should just work. `sue` action `profiles` lists them: names, sites, counts,
dates, never a value. The rails are the borrowed session's: guarded (look and try, never commit)
unless it was saved free-handed, and never on a Connections site, where every Sue makes her own
account. No probe can tell whether an arbitrary site is still signed in, so a login is refused only
once nothing in it is alive; when Sues arrive signed out, Sign in again on the Logins tab. Forget
deletes the login and the Chrome profile it was made in.

## Watching them: the Sue Manager

Nobody opens it (Owner, 2026-09-22: "Sue shouldn't ever really be a page a human goes to"). SUE run by an
AI is headless (the owner, 2026-10-09): a wave an AI starts, through the CLI or the MCP, starts no
Manager, no toolbar icon and no window. It only records itself as the latest wave, so the window lands
on it when a person looks. `sue watch` is how a person looks: it opens Sue's window in your own Chrome
(else Edge) as an app window, with no tabs and no address bar, on the latest wave, or finds the one
already open (`lib/watch-window.mjs`). On Windows her icon then sits in the toolbar (Owner, 2026-09-23:
"it should be able to stay collapsed to the toolbar", `lib/tray.mjs`), and a click on it brings the
window back. Closing the window leaves her in the toolbar and she says so. Right-click the icon for her
menu: dark and rounded, with the AI gradient along its top, it lists the waves running now like live
sessions (the site and how many of its Sues are done), and choosing one opens her window at that run.
The page's **Settings** tab changes whether closing the window quits her instead, for this computer
only (`lib/settings.mjs`, in the state folder). A file or an idea is the one thing an AI's run starts
a Manager for: it runs with no window and no icon (`startHeadlessManager`). Each Sue still browses in her
own throwaway browser; the window only watches.

```
node sue/sue.mjs watch                 # open the window now: how a person looks at Sue
node sue/manager.mjs                   # by hand, for a developer: the server, the icon and the window
```

A small server on this computer (`127.0.0.1:47470`) and a Studio page that talks to it
(`app.example.com/sue`; `app.example.com` is its short address and lands there). The
page follows Studio's workspace switcher: every project folder with a `.sue/` is its own Sue
workspace, and the one the Connections MCP bound to the Studio workspace in the header is the one
you see (`lib/workspaces.mjs`; a Folder menu picks another, and picking one bound to a different
Studio workspace switches the header too). Per workspace it shows **Runs** (each Sue's latest screen
in a phone or desktop browser frame, her journal, her inbox as text only, her exit interview, the
run's report, and Stop while Sues are out), **People** (this workspace's own people first, then
Sue's, each with how their visits here went) and **Pages** (the scoreboard, run over run). New wave
takes a page, why these people are there and who goes, and runs `sue run` in that folder, so it
lands in the same journals and scoreboard as a run from the MCP or a terminal.

The page is Sue's door: Enterprise (Pay's `sue` row). Chrome asks once to let it
reach "apps on this device": choose Allow. The server answers only Studio's own pages on this
computer (it checks the request's Host and Origin; `--dev` also admits the Studio dev server on
`:4382`), names workspaces by an id rather than a path, serves only what the Sues wrote, and never
sends anything anywhere. The page records which sites you point Sue at and how you use it, never
what Sue sees. Flags: `--port`, `--no-open` (start in the toolbar), `--no-tray`, `--dev`, `--page <url>`.

## Reading a report

```
node sue/report.mjs --run <runId>      # or: bun run sue:report -- --run <runId>
node sue/report.mjs --all              # every run under runs/, plus a combined aggregate
```

`report.md` is written in plain prose and short lists, dictation-friendly on purpose - read it out
loud and it should still make sense. When SUE itself caused something, **SUE-side suspects** comes
first: Sues our own sign-up door refused (she asked for a code, the page said "Unable to process this
request" and no code reached her inbox) and Sues whose screen stayed the same, byte for byte, through
several clicks or scrolls; what they wrote about it is kept out of the diary, the findings count and
the email-code numbers, so a SUE fault never reads as a site defect. Then comes **the verdict** (average stars out of five, the
histogram, and how many Sues are never coming back with their own reasons quoted) and then **what
confused them, in their own words** - every diary line she wrote, verbatim, because that is the part
worth reading. After that: did she understand what we sell
(comprehension buckets - got-it / partly / no-idea / wrong-idea, mechanical keyword hits against the
target's `groundTruth`, plus the worst three Sues quoted in their own words); **understood it at first
look** (the same buckets over her answer to the first-look probe - one line, asked once, the moment her
first look lands, then she is sent back to her errand - so "the home page lost her" reads apart from "she
worked it out 20 clicks later"; a Sue who never answered it is missing, never "no idea", a game target is
skipped unless its scenario names its own `probes`, and the scoreboard carries `firstLookGotItShare` run to
run); the funnel (who reached
signup, requested a code, read it, signed in, ended up where the scenario expected, and where each
Sue who did not finish actually died); the email code (OTP latency p50/p95/max, how many checked their
inbox before the mail arrived, how many never found it); the clock (median seconds to her first click,
how often boredom or exhausted patience showed up); findings grouped by kind (with the URL and the Sue
who hit each one). `report.json` is the same data structured
for a script; every run also records one line in `runs/ledger.jsonl` (upserted by run id, so
re-reporting a run never adds a duplicate) so a trend across every run ever run is one `jq` away. `sue/tests/fixtures/runs/sample-run/` is a small, committed, hand-assembled
run (four Sues, one of every comprehension bucket) that exists so `report.mjs`'s scoring rules have a
fixture with a known right answer - read it before changing how a bucket or a funnel step is decided.

**Problems they filed, worst first** comes after the verdict (and after the room, in a focus group) on a run
where a Sue typed a problem. A confusion, annoyance or broken line about something wrong on the site may carry
`problem`: a title, issue or warning, a severity from 1 (trivial) to 5 (what she came to do is impossible, her
data is lost, or money or security is wrong), what she expected, what the screen showed instead and the steps
that reach it, while her `text` stays her own words. The body stamps the look she decided on, whether `actual`
quotes words from her screen, and the problem's number in the run's ledger, `<run>/filed.jsonl`. A later Sue
whose look lists that problem on her page writes her own line with `same:` its number and no problem, so the
report names everyone who hit it (seen by) without the facts being filed twice. A problem she sends again (a `do`
resent after a later note in it was refused) keeps its first number, and one filed while SUE itself was at fault
(her browser lost under her, or our sign-up door refusing her) stays on the ledger marked `sueSide` but is never
listed to another Sue. Her trace keeps each list she was shown as `filedHere`. The section lists each
problem worst first (severity, an issue before a warning, more sightings first), with its finding
`<sue folder>:<line>`, and says how many problem lines carry only her words. `report.json` carries the same as
`filed`, and SUE's summary hands Dredd the compact list as `problemsFiled`. A run where nobody typed a problem
reports exactly as before.

## Repros: a finding is a claim until a test that asserts the right behaviour fails

A Sue's finding is a model's claim. It becomes a bug only when a **repro** - an ESM node script that drives
the page with playwright-core and asserts the CORRECT behaviour with `node:assert` - fails on the assertion
that encodes the bug. Any other failure (a missing control, a timeout, a crash) means the repro is wrong;
a pass means the bug did not reproduce. Once the bug is fixed the same repro passes, and it stays as the
check that proves the fix. Before a repro is worth writing, a finding is sorted into a reject bucket or
left a candidate: **environment** (a key or service only production has), **design** (the code or copy
says it is intended), **fixture** (seed data), **sue-side** (SUE itself caused it). The rule and the
buckets are tester-army/e2e's bug-bash reference (Apache-2.0), steps 5 and 6, written fresh.

```
node sue/repro.mjs run <file> [--timeout <s>] [--json]
node sue/repro.mjs check <file> [--timeout <s>]
node sue/repro.mjs confirm <run id> --finding <sue folder>:<line> --repro <file>
node sue/repro.mjs triage <run id> --finding <sue folder>:<line> --bucket environment|design|fixture|sue-side --why "<what settled it>"
```

- `run` classifies one run of the repro: exit **0 gone** (it passed), **1 still** (an `AssertionError`:
  the bug reproduces), **3 broken-test** (any other error, a timeout - 120 s by default - or the repro
  ending the process itself), 2 usage. It prints `<result>: <why>`; `--json` prints one line
  `{ result, why, file, ms, exitCode }`.
- `check` is the command that proves a fix: exit 0 only when the repro passes.
- `confirm` runs the repro and records the ruling in `runs/<run id>/repro.json`: `confirmed` only on
  still, else `rejected` with reason `not-reproduced` or `broken-test`. Exit 0 confirmed, 1 rejected
  (recorded either way), 2 usage or no such finding. `<line>` is the 1-based line of that Sue's
  `findings.jsonl`, the same as the tail of her 4man task's source `sue:<run>:<sue folder>:<line>`.
- `triage` records a reject bucket before any repro is written. Exit 0 recorded, 2 usage.

A repro's contract: top-level await is the whole test; it throws, never catches its own failure or calls
`process.exit`; setup steps wait with playwright (their timeout is a broken test, as it should be) and only
the assertions that encode the bug use `node:assert`; it closes its browser in a `finally`. It runs under
node, never bun (Chromium). A re-ruling of the same finding replaces it in `repro.json` and keeps the
earlier one in its `history`.

What reads `repro.json`: the report shows **Confirmed by a repro** first (finding, page, repro path), then
**Rejected findings** grouped by bucket and by not-reproduced / broken-test, apart from the SUE-side
suspects; a run with no `repro.json` reports exactly as before. 4man's SUE scout files a confirmed finding
whatever its severity with `node sue/repro.mjs check "<repro>"` as its check, so `4man done` closes
it only when the repro passes, and holds a rejected or bucketed one back (its tick line says how many and
why). Dredd rules a bug docket's fix on the same file: `dredd.mjs --rule-fix <docket> --repro-file <repro>`.

A typed problem (see Reading a report) keeps its claim through a ruling: `confirm` and `triage` copy its
title, rubric, expected, actual, steps and look into the `repro.json` entry, and the report's repro line names
it by `[severity defect] title`. Dredd's SUE log routes each typed problem: a 4 or 5 issue goes straight to a
repro, with the exact `confirm` command for its finding; a warning goes to the Design Critic, with the path
of her look; a 1 to 3 issue stays with the room (`dredd/lib/bug.mjs` routeFiled).

## Deleting an account when you are done with it

```
node sue/reap.mjs --run <runId>     # every not-yet-deleted account this run's manifest lists
node sue/reap.mjs --all             # every not-yet-deleted account in the whole ledger
node sue/reap.mjs --run <runId> --dry-run   # who would be reaped, nothing spawned
```

A cannon run does not delete its own accounts - `state/accounts-ledger.jsonl` is a real identity
store, and the only thing that keeps a stampede of real sign-ups from becoming pollution is the caps
below plus actually cleaning up afterward. `reap.mjs` never calls a delete endpoint directly: it sends
a real `dev-dan` Sue back through the product's own delete-account flow, reusing the original Sue's
signed-in browser profile. The janitor thinks in the chat that runs the reap (`--brain chat`, the default):
run it in the background, and when the log names her brief, start one agent (model `sonnet`) told only to
read that brief. `--brain openrouter|deepseek` is the chat choosing a key pool instead. Her word never closes a row: a janitor's exit interview is a claim, and on
2026-09-22 every claim we could check was wrong (the account was still there). So `reap.mjs` asks the
identity store itself through `node sue/mailroom.mjs --probe-account <email>` (the reaper holds no
AWS credential by design; the mailroom does, and it refuses any address that is not a Sue's), and only
when the store says `exists:false` or a deletion was requested does it close the row, by APPENDING
`{ closes: { address, sueId, runId }, deletedAt }` - the ledger is never rewritten, so a cannon
appending at the same moment loses nothing. It prints VERIFIED only when that close actually landed.
A gone-claim the probe does not confirm prints UNVERIFIED with the probe's answer, a confirmed deletion
with no open row to close prints that instead, and the row stays open in every non-VERIFIED case. `--all` re-sends a
janitor to every account the ledger has not yet proven closed.

## Inbox test

Before a bulk email goes out, put it in simulated inboxes and count who presses Report spam. The bar:
zero Sues may report it as spam up to 100 Sues, and above 100, at most 1 in 1000. Gmail's bulk-sender
rule caps the real spam-report rate at 0.3% and wants it under 0.1%, so the old 1-in-100 and 1-in-300
bars were looser than Gmail itself. The rest who want out should use the unsubscribe.

Each Sue gets her own inbox (the page at https://inbox.sue.invalid) with the email under test among
6-8 ordinary decoys: a receipt, a friend, a bank statement, a newsletter, a promo. She triages as she
would on her phone and is never told which one is under test. The inbox has Gmail-like controls:
Report spam, Delete, Archive, and a native Unsubscribe link beside the sender that appears only when
the email carries a `List-Unsubscribe` header. Links in the body that point at the unsubscribe URL
count as unsubscribing. Replying is recorded, and a reply that says no counts as an opt-out.

Each Sue ends with exactly one disposition: ignored, read-and-left, clicked-through, unsubscribed (by
native link, body link or reply), reported-spam, or deleted, plus her own words for why. `audience`
shapes how she meets the email: `cold` (never signed up, never heard of us) or `known` (signed up or
bought). Sues run on Sonnet 5.5 and stay in the inbox unless a link takes her away; that is enforced
by the intent sentence, not by a hard rail.

The report gives count, spam rate, unsubscribe rate by control, ignored rate, a one-sided 95% upper
bound on the spam rate, and every spam reporter's quote. `PASS` only with zero spam reports up to 100
Sues, and at most 1 per 300 above 100. Verdicts book to `.sue/inbox-tests.jsonl`, keyed by a hash of the email's from, subject,
body and headers.

```
sue { action: "inbox_test", params: {
  audience: "cold", count: 100,
  email: { from: "Acme <news@acme.example>", subject: "New in: autumn range",
    html: "<p>Our autumn range is in. <a href=\"https://acme.example/autumn\">See it</a></p>" +
      "<p><a href=\"https://acme.example/unsubscribe?u=123\">Unsubscribe</a></p>",
    headers: { "List-Unsubscribe": "<https://acme.example/unsubscribe?u=123>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } } }
```

Then `action: "inbox_test_report"` with the same `email` and `audience` gives the verdict. Pass
`personas` as the other runs do.

**Merge fields.** `{first_name}` is each Sue's own minted name. Any other `{token}` (`{event_name}`, `{where_found}`)
is filled from that Sue's own true facts in `lib/inbox-facts.mjs`, each noted with the line of her persona it comes
from, never shared across Sues. A token with no fact for a Sue is an error, never a generic word: the run is refused
before any Sue starts, naming her and the token, and an unnamed audience is only the personas that have every fact
(a cleaned list). The booked line carries `mergeComplete: true` only when no Sue's seeded copy kept a token. The
door's action list is stale on some machines (4Man `3bf509d6`); `node sue/sue.mjs inbox_test
--json-file <args.json>` (add `"dispatch": "climayte"`) is the same call from a terminal.

## Blind round

Lets an analyst guess, from the blind analytics alone, each simulated visitor's rating, why they stopped, three words, and their complaints about the website; the draft score then maps each guessed visitor to a Sue by engaged time.
`node sue/sue.mjs blind-round --url <url> --intent <text> --personas a,b,c,d --letter <L>`
(`--letter` is one or two capitals, e.g. `Q` or `QA`) starts a run (or reuses a finished one with `--run <id>`), waits for the interviews, writes the blind
analytics view to `<out>/blind-<id4>/run-<L>.json`, and refuses unless it passes the leak check (no
persona id or first name, ASCII only, `visitorCount` as expected). It then fills the frozen analyst prompt
into `analyst-prompt.txt`: `--prompt v1|v2` picks `sue/blind/analyst-prompt-v1.txt` or `-v2.txt`
(default `v2`), each pinned by its own sha256, and any other value is refused before a run starts. The
version and its sha256 are written beside it as `analyst-prompt.version.json` and in the result JSON's
`prompt` field. Unless `--dry`, it launches the analyst as a CliMayte worker in that folder. When guess.md lands it writes `draft-score.md`
mapping each guessed visitor to the Sue who engaged for the same time, and flags a tie when two visitors
sit within 2 s. guess.md is never edited. `--project` (default `ExampleApp`) picks the workspace folder
from `PROJECT_FOLDERS` in `blind-round.mjs`, so the personas resolve from any calling folder; `--workspace`
overrides it. `--no-wait` prints `{ runId, blindDir, waiting: true }` as soon as a fresh run is dispatched,
and the analyst is started by re-running with `--run <id>` once its interviews are in. `--dry` stops after the files are written:
`node sue/sue.mjs blind-round --run 20261011-214742-90d1 --letter QA --personas bot-manager-jordan,community-admin-maya,discord-owner-alex --project ExampleApp --dry --out <tmp>`.
Tests: `node --test sue/tests/blind-round.spec.mjs`.

## The rails (enforced by the body, never trusted to the brain)

Never a CAPTCHA solved. Never a payment field filled. Never a hidden field. Never a click off the
target's allowed hosts. Never SMS (every persona's phone is the same reserved fictional NANP number).
Never a real person's address. Never a code printed to any log, anywhere. Never a Haiku brain.

## The caps

`--max-accounts` per run (default 25): past it, the cannon refuses to start another signup-class
scenario and says so on stderr instead of silently skipping it. There is NO daily cap on Sues,
on this machine or on the server's Sue door in
[`turnstile-gate.ts`](../../services/accounts/lambda/src/auth-request-otp/turnstile-gate.ts): both
were deleted on 2026-09-23 (the owner: "Sue is a feature we sell to people ... it just costs them
Connections account tokens"). If the door refuses a Sue (a wrong or missing key), the run stops and
says so.

## Staff never hear about a Sue

A Sue's signup, her Pass trial, and any other staff alert about her are held back on production
(owner, Owner, 2026-09-22: "add an exception so I stop seeing sign up notifications, et cetera, for
Sue"). The fleet knows her by her address alone, through one rule in
[`infra/shared/auth/sue-address.mjs`](../../infra/shared/auth/sue-address.mjs), and
`tests/sue-address.spec.mjs` keeps `sueAddress()` and that rule in step. Everything SHE receives still
sends (her code, her welcome, her Pass email), and a support request she makes through our chat
bubble reaches no inbox and spends none of the bot's shared daily cap.

Analytics keeps her as her OWN dataset (Owner, 2026-09-28: Sues are a separate dataset, kept and
never deleted, and human analytics show everything except them). `sessions.dataset` and
`identified_users.dataset` say `human` or `sue`; every member read counts `human` only, and the
admin-only Atlas door `GET /v1/atlas/datasets?site=&from=&to=` reads the two side by side, with
`sue_usable_as_proxy` true while that site's human visits per day are under 100. Her browser says
who she is before any page code runs (`lib/sue-marker.mjs`: `window.__CONNECTIONS_SUE__` and
`localStorage["connections.sue.run"]`, the run id and her Sue id, never her email or her persona's
name; the names live in `infra/shared/auth/sue-browser-marker.mjs`), and a Sue page starts no
CloudWatch RUM, so her JS errors never reach /pulse as frontend errors.

## AWS prerequisite

The mailroom is the only SUE process that ever touches an AWS credential (so a compromised or
misbehaving brain/body pair can never reach the co-tenancy database or the inbound mail bucket). It
needs credentials before you start a cannon run against any target whose mailbox is `ses-inbound` -
the mailroom polls `chat.email_provider_events` and reads a Sue's OTP out of S3. Either set a named
profile (`AWS_PROFILE=main`, or `--profile <name>`) or hand it a vault lease (`AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` in the env, minted by the local MCP). `main` is the default profile name when
the env names neither. With neither a profile nor a lease, the mailroom exits 2 at once with a
message instead of polling blind. A lease outlives nothing (about 60 minutes, shorter than a
`--forever` run), so a named profile on disk is preferred and is used automatically when one exists;
if the lease expires with no profile there to fall back to, the mailroom exits 3 rather than leaving
every inbox silently empty.

`node sue/mailroom.mjs --probe` opens both mail doors and is what the cannon runs before it
reserves a single Sue number: a run it cannot read mail for is refused (`state: "refused"`, with the
reason), instead of Sues sitting at their inboxes forever.
