# DREDD - the judge

> Owner ask (the Chair, 2026-09-21): "Combine Odin, Architect, SUE, Boardroom, AWS Atlas etc. into a
> single platform that Jev (or a similar model) orchestrates ... sometimes the AI may not know which
> tool to call. Build me out that judge now. Call it Dredd." Same night: the message board, "which
> memories it needs", and "whether we should be using the zswarm and which model" fold in. Later that
> night: "run the entirety of Dredd against itself, and Sue, and everything ... tear itself apart, and
> then you put it back together" - which is where the code gate, the tooling room, the doctor, the
> second sitting, the eval and the SUE brain ladder came from.

Dredd is one door for any ask. Give it a complaint, a review, a decision or "which tool do we have
for this" and it returns a **docket**: which of the fleet's instruments to convene and in what
order, the exact command for each, which memories the memory lane holds about it, which tier should
do the work, and who else is on the team board. With `--convene` it runs them: facts first, then the
Boardroom of critics argues over the facts, then the slow field instruments launch hidden with logs.
With `--collect`, later, the field evidence comes home and the board sits again.

```
node dredd/dredd.mjs "the pricing page copy sucks, way too wordy and nobody gets what Pass is"
node dredd/dredd.mjs "<ask>" --url https://app.example.com/pricing --convene
node dredd/dredd.mjs --collect --docket tmp/dredd/<stamp>       # SUE's report, the capture, the flow walk, then the board again
node dredd/dredd.mjs --convene --docket tmp/dredd/<stamp>       # run a docket the hook already decided
node dredd/dredd.mjs --resolve --docket tmp/dredd/<stamp>       # only the resolution loop again (drafter, claims check, Humanizer, the room) - cents, no SUE
node dredd/dredd.mjs --root D:/NEWProjects/shared/odin "<ask>"   # judge ANOTHER repository (its .dredd/bench.json and .dredd/seats/ when it has them)
node dredd/dredd.mjs --doctor [--root <repo>]                   # can this machine (and that repo) hold a hearing?
node dredd/eval.mjs                                             # does the judge judge right? (the gold asks AND the gold seat briefs, both arms)
node dredd/eval.mjs --routing-only                              # do two instruments' own lines collide, and does each gold ask read closest to its owner? (free)
bun  dredd/boardroom.mjs "<ask>" [--room tooling] [--sitting 2] # just the critics arguing (sitting 2 = over landed evidence)
node dredd/charters.mjs [--since origin/main] [--out <folder>]   # SUE wave files for what a branch changed: one route x one posture each (lib/charters.mjs)
bun run dredd -- "<ask>"    ·    bun run dredd:boardroom -- "<ask>"
```

Through AgentHydra's MCP, its `dredd` tool runs `node dredd/dredd.mjs` with the flags above, from any folder:
`dredd { action: "docket" | "plan" | "convene" | "hearing" | "resolve" | "collect" | "status" | "stop" | "dockets" | "doctor" | "bench" | "boardroom", params: { ask, url?, docket?, root?, ... }, cwd? }`
(`collect`, `resolve`, `status` and `stop` need `params.docket`; the long actions run on detached and are read back with `status`).

And automatically: the prompt hook (`dredd/hooks/dredd-docket.mjs`, wired into a project by its settings) files a docket on every
grievance-shaped prompt ("sucks", "bloated", "confusing", "review this", "which tool ...") before
the model picks how to work, as a `<dredd-docket>` block. Its gate is `promptWantsDredd` in
`lib/docket.mjs` (one copy; the hook's own drifted copy never fired on "which tools do we have").
It works to a 7.5-second budget from process start, inside the harness's 9: Jev gets at most 4.5 s
and recall stops at the deadline, so a slow Jev still prints the keyword docket (measured 4.1 s with
a Jev that never answered). It stays silent on slash commands, on machine text (task notifications,
system notices) and on a message from another AI session. It runs the judge with `DREDD_FROM_HOOK=1`
set, so a run can tell it was filed by the hook rather than asked for by hand.

## As an MCP tool

`dredd` (and `dredd_hook`) are on this checkout's own MCP server, beside `sue`: `claude mcp add sue-dredd -- node
<checkout>/mcp/server.mjs`. `dredd { action, ask?, url?, root?, docket?, announce?, rounds?, seats?, fromLine?, limit?,
session? }`, with action one of docket, plan, convene, hearing, resolve, status, stop, dockets, collect, boardroom, bench,
doctor, unrated. More in [sue/README.md](../sue/README.md#the-mcp-server-sue-and-dredd-in-any-chat).

## The bench - `bench.json`

Every instrument the fleet can convene, in one file: what it judges, when it is convened, the one
typed question Jev is asked about it, the keywords that answer when Jev is unreachable, how it runs,
what it costs, where its evidence lands, whose lane the findings are in. **Adding an instrument here
is how the fleet learns it exists**; every instrument's own README names this file back, so they all
know each other exist.

| id                | plane     | judges                                                                           | mode     | phase |
| ----------------- | --------- | -------------------------------------------------------------------------------- | -------- | ----- |
| page-pulse        | architect | rung one: does the named page load, how fast, how many words, which errors       | now      | 1     |
| grid              | architect | the whole backend as squares, read from what the lanes already wrote             | now      | 1     |
| subtract          | architect | should this exist at all - the Architect's could-be-smaller checks, ranked       | detached | 1     |
| architect-board   | architect | one page over every instrument's latest numbers                                  | now      | 1     |
| 4man              | architect | what work is waiting, in what order, and who should do it: the foreman's board   | now      | 1     |
| almanac           | architect | what the product already has for the ask, from the Almanac's maintained record   | now      | 1     |
| quota             | shared    | what every Claude and Codex account has left (AgentHydra)                        | agent    | 1     |
| deep-audit        | dredd     | the nine-lens semantic codebase sweep (saved workflow)                           | agent    | 4     |
| code-review       | dredd     | one change, by the reviewers its paths call; Standards and Spec never merged     | now      | 2     |
| price             | architect | page cost to read: the dearest files, for busy, too long or cut-the-page asks    | now      | 1     |
| boardroom         | dredd     | the ask, argued by the house critics; a silent ballot decides the verdict        | now      | 2     |
| copy-audit        | architect | the copy checks + the rendered word count of a named page                        | now      | 1     |
| code-gate         | architect | lint, format and the named tests over the paths the ask names                    | now      | 1     |
| delivery-ledgers  | architect | the operator's own rows in the send ledgers, for a wrong-channel delivery report | now      | 1     |
| judge-hunt        | architect | Dredd's own measured failures (the hunt), for an ask about the judge itself      | now      | 1     |
| chat-audit        | architect | the operator's own chats: what he typed, repeats, and where the hours go         | agent    | 1     |
| rust-build        | architect | why a Rust build or test is slow: test programs per crate, toolchain lag         | agent    | 1     |
| humanizer         | dredd     | AI tells in prose (skill)                                                        | agent    | 4     |
| design-critic     | dredd     | every declared surface photographed by the wave and scored against Material 3    | detached | 3     |
| lilgranny         | architect | first-timer findability over the capture                                         | now      | 3     |
| flow-walk         | architect | every declared flow driven end to end                                            | detached | 3     |
| sue               | dredd     | real simulated visitors through the page, in their own words                     | now      | 3     |
| focus-group       | dredd     | the ONE problem a room of simulated visitors agrees on, argued out loud          | now      | 3     |
| ape               | dredd     | power users push the product the fast way and log every place it fails           | now      | 3     |
| art               | dredd     | pro designers walk it on a phone and a computer, ranked polish list, keep list   | now      | 3     |
| arkitect          | architect | the guardrail catalog, narrowed to the domain's check family                     | now      | 1     |
| marketing-council | dredd     | positioning, offer, pitch (skill + the minds)                                    | agent    | 4     |
| legal-room        | dredd     | is it legal and what must it say: the Legal room's counsel (skill legal-room)    | agent    | 4     |
| odin              | architect | the cross-repo database and the Codex                                            | now      | 1     |
| bill              | architect | the org-wide AWS bill and AI token spend, from the payer (vault credentials)     | now      | 1     |
| perf-rsi          | architect | backend functions ranked by measured handler time, and the budgets to bank       | now      | 1     |
| access            | architect | which AWS identity reaches what an ask touches (account, vault instance, db)     | now      | 1     |
| atlas             | architect | every AWS account, resource and published hostname                               | detached | 3     |
| pulse             | architect | live product health (skill)                                                      | agent    | 4     |
| security-audit    | dredd     | auth, tokens, exposure, permissions (skill)                                      | agent    | 4     |
| codegraph         | architect | where a symbol lives and who calls it                                            | agent    | 1     |
| script-vault      | architect | a saved enumerator for the sweep you are about to hand-run                       | agent    | 1     |
| memory-lane       | shared    | which memories this ask needs (pgvector, every docket)                           | always   | 0     |
| memory-ledger     | architect | which memories to improve, from who read and who changed each one (the ledger)   | now      | 1     |
| peers             | shared    | the team board and this folder's mail on it (every convened docket)              | always   | 0     |
| cranium           | shared    | is the AI message board used the way the owner intends, from its throughput      | now      | 0     |
| hswarm            | shared    | which tier does the work (every docket)                                          | always   | 0     |

Modes: **now** - Dredd runs it and captures the log. **detached** - launched hidden with a log
(heavy ones under fairjob), the pid recorded, never a visible console; on Windows the hop is a
synchronous hidden Start-Process, because a node child launched `detached` has no console and every
shim's grandchild then writes to a console of its own (four self-hearings' subtract.log held only its
header before this was measured, 2026-09-22). **agent** - a skill or an
in-session step only the agent can take; the docket names the exact call. **always** - part of every
docket. Phases: 1 facts, 2 the board argues over them, 3 the field (browsers, people, accounts),
4 the agent's own follow-through.

Planes: **architect** - a script could decide the answer (same input, same answer), so it belongs
behind the Architect's door; **dredd** - a model's, persona's or critic's judgment; **shared** - the
plumbing every docket uses. See [Two front doors](#two-front-doors---the-architect-measures-dredd-judges).

**Credentials: `instance`.** An instrument that declares one (the bill and SUE, both `Root/Connections`)
runs through ONE route, `runInstrument` in `lib/convene.mjs`: the local MCP's `shell` with AWS
credentials minted from the vault for that instance, value-blind, the repository as its cwd, and the
same `--- exit N` footer a bare run writes. With no MCP handle it runs bare and the log's second line
says it had no vault credentials. `--convene` opens that handle whenever a convened instrument declares
an instance (`vaultInstanceFor`), so a `--hook` or `--no-recall --no-peers` run still gets the vault;
until 2026-09-23 only SUE opened it. `DREDD_<ID>_AWS_INSTANCE` names another connected account and
`DREDD_<ID>_VIA_VAULT=0` opts that one instrument out (`DREDD_BILL_AWS_INSTANCE`, `DREDD_BILL_VIA_VAULT`,
and SUE's two below). `loadBench` refuses an `instance` on anything but a `now` instrument: the shell
will not carry credentials into a detached run.

**Money goes to the bill, first** (Owner, 2026-09-23: "all I should tell you to do is go check the
account spend"). The bench's `money` domain holds the words people use for what we spend (spend,
the AWS bill, credits, a budget, a forecast or month-end projection, cost, AI tokens, burning); an ask
that reads as money seats the bill first on any scope, and on a quick look the one slot is the bill's.
The words stay off the Atlas and the infra domain so they never compete, and bare `bill`, `billing`,
`invoice`, `spent`, `tokens` and `how much` are left out on purpose: they fire on Pay's own customer
billing, on time spent, on auth tokens and on "how much of our weekly quota is left".

## How it decides - Jev, then the keywords

Typed questions about the ask go to **Jev**, TypeSafe's typed-decision model, through HSwarm's
`hswarm_decide` (`lib/jev.mjs`, a POST to the shared HSwarm server's `/api/decide`): four standing ones - what KIND of ask (complaint / review / decision /
build / question), which DOMAIN (copy / visual / flow / code / infra / cross_repo / product / data / money /
security), how big a HEARING (quick look / focused review / full tribunal), which TIER does the work
(hswarm / opus_lean / flagship / mixed) - and one yes/no per bench instrument with a `jev` line (the
run prints the count). Jev answers all of them in about a second for well under a tenth of a cent, with
a calibrated confidence. The CLI re-asks an unsure CHOICE (under 0.7) on the free generative model and
that answer wins; a YES/NO is never escalated - Jev's own probability decides it. Measured 2026-09-22
on the 39 gold asks, one run graded both ways: with the fallback's yes/no answers deciding, 19 dockets
convened exactly the right instruments; with Jev's probabilities, 39 (until then the cascade
escalated about a dozen yes/no items per ask and the docket quietly ignored the answers). The hook
trusts Jev alone for speed. Jev runs on Cloudflare Workers AI (`typesafe/jev`), billed to the Connections Global LLC account, through the `connections-jev` Worker (`cloudflare/jev-proxy.js`, host `connections-jev.connections-global.workers.dev`, secret header): `lib/jev.mjs` hands HSwarm the route line `<host>:<secret>` from `~/.connections/jev-route` (outside the repo) with every call, so Connections' calls never use TypeSafe's own keys and other projects' HSwarm use is untouched. The bill labels the pick `cloudflare-jev`. A 402 (empty AI Gateway balance) retires the route like a dead key and the Clef and keyword fallbacks answer. Without a route file HSwarm's `~/.hswarm/secrets/typesafe_api_keys` pool answers; nothing in
Dredd reads or prints a key. `DREDD_JEV_MODEL` swaps the typed model for an A/B only: 2026-09-24,
`featherless-ai/Qwen3.8-27B-classifier` (Featherless's open-model Simple Jev) convened 54 of the 58 gold
asks exactly right against Jev's 56, so Jev stays (zswarm `docs/BENCH-2026-09-24-simple-jev.md`); and
2026-10-02, Cloudflare's `clef` on Workers AI convened 76 of 87 against Jev's 72 at the threshold that
escalates Jev's share of choices (`--escalate 0.415`; 10-6, p = 0.45, no detectable difference) and `clef-flash`'s
classifier was clearly behind (38 perfect against 56), so Jev stays again at 9x less spend (zswarm
`docs/BENCH-2026-10-02-clef.md`). 2026-10-03, AWS's open-weights Strands Decider 2B (a Jev wire clone) was
never given a docket A/B: on the swarm's frozen decision items it scored 69.0% against Jev's 84.8% over the
same 448 (McNemar p < 0.0001), its request validator refused all 17 `hard_choice` items Jev answers, and it
runs only self-hosted, which the Chair ruled out that day ("I have no interest in self-hosted, as it'll never be
cost-effective"). So a candidate for `DREDD_JEV_MODEL` must be a HOSTED model (memory
`strands-decider-2b-evaluated-2026-10-03`). Another typed model's confidence runs on its own scale: run its A/B at its
matched `--escalate`, never Jev's 0.7 (Clef at 0.7 read 70). A Clef run needs a Cloudflare token, which ZSwarm's
`bench/with_cloudflare_login.py` lent from the machine's `wrangler login` (ZSwarm retired 2026-10-03 and its bench
harnesses with it; the script is in its archive). Move
such a run's `tmp/dredd/eval-*` folder aside afterwards, or the hunt reads it as the newest Jev run.

When Jev is unreachable (no key, no network, out of credit) the bench's `keywords` answer the same questions and
the docket says `decided by heuristic`; an id Jev left unanswered is filled from the keywords and
named (`decided by jev+heuristic`, `JEV LEFT n UNANSWERED`). Out of credit counts since 2026-10-08: until then
HSwarm sent every yes/no Jev failed on to its paid fallback even at escalate 0, and the docket used that answer
(every ask from TypeSafe's first HTTP 402 on 2026-10-06). Also since 2026-10-08, when no TypeSafe key works
HSwarm asks Cloudflare's free `clef` first, its confidence held to Clef's own scale (0.415 for Jev's 0.7); its rows
come back as `jev:clef` and count as Jev's, so the keywords answer only when Clef is down too. HSwarm reaches Clef
through the `hswarm-clef` Worker on the Lunawerx account (AgentHydra `hswarm/cloudflare/clef-proxy.js`, its AI binding
needs no API token), listed in HSwarm's `cloudflare_api_keys` as `<worker host>:<secret>`, a line the vault carries to every PC. A keyword matches a whole word and its
plain inflections (s, es, d, ed, ing, er, ers) - "copy" no longer fires on "copyright" - a keyword
ending in punctuation (`tools/`) is a prefix, and a trailing `*` marks a deliberate stem (`confus*`).
The decision itself is pure code (`lib/docket.mjs`) and is unit-tested without the network
(`tests/docket.spec.mjs`, `tests/door.spec.mjs`).

Every instrument passes two stages (`lib/pipeline.mjs`, the shape of the Kubernetes scheduler's
filter and score plugins): the FILTERS, the named rules that keep an instrument home whatever its p
(`code-matter-no-visit`, `decision-without-page`, ...), then the SCORE stage, the scope's bar. The
docket's `home` lists every scored instrument it left home with the stage that kept it there (`filter`
with every rule that fired, `bar`, the focused `cap`, or a money matter's `bill`) and who scored its p
(`jev`, or `heuristic` where Jev left it unanswered); the full render prints them as `KEPT HOME:` (every
filtered or capped one, and any bar miss at p 0.4 or more). A new veto is a new entry in `FILTERS`.

Convening rules, in `decideDocket`: the bars an instrument's yes must clear live in one object,
`BARS` - a full tribunal, a focused review (with a higher bar for the slow field instruments and a cap
of four) and a quick look (one instrument, the likeliest first, a session skill allowed). They were set
by a sweep over the gold asks on 2026-09-22 that kept every setting convening nothing the gold forbids
(exactly-right dockets 25 -> 30 of 39 on Jev) and re-swept on 2026-09-23 (below); change them only
against `eval.mjs`. A build or a question sends no page visitor (the Design Critic, LilGranny, the flow
walk, SUE - the Atlas reads AWS, not a page, so "is example.com down" may send it) and no board
unless the board is near-certain. A decision is at least a focused review, so the room sits beside
subtract instead of losing the one quick slot; a quick look may name a session skill beside its one
instrument (it costs nothing); and a docket that would seat nothing seats the specialist for the ask's
domain when Jev leans yes at all (p >= 0.5) - never the room alone. A complaint word
in the text makes it a hearing even when the classifier read "fix all of it" as a build. A repository
path in the ask (`dredd`, a `.mjs`, a `.md`) that exists on disk is lifted into `docket.paths`
and hands the code gate something to run on. **Some rungs are fixed, past the bars and the cap:** a
page grievance at a focused review or more always gets the pulse (rung one) and, when the matter is
about the page itself (copy, visual, flow, product - not a certificate or a DNS record), the Design
Critic and SUE (rungs two and four), and a code matter that names a path always gets the code gate and the Architect's
code family. Order is by phase (the facts before the room that argues over them), then by confidence.

**Signed votes, and signals on trial** (the idea is PyTorch's target determination, BSD-3-Clause;
written fresh). Every signal about an instrument is a vote in -1..1 (a yes p is the vote 2p - 1:
negative keeps it home, 0 is no idea), and `tallyVotes` sums the live ones in one place into the p
every bar and veto reads. The live vote is the door's answer: Jev, or the keywords where Jev was
silent or unreachable. A NEW signal enters `TRIAL_SIGNALS` with `votes: false`: its vote is written
into every docket (`docket.votes.instruments[].votes`, `trial: true`) and the docket records what it
WOULD convene if it voted (`docket.votes.trial.<signal>`: `convene`, `added`, `dropped`; the full
render prints `TRIAL <signal> (no vote yet): if it voted, +x -y`, the hook's compact docket does not).
A trial never moves a docket. `eval.mjs` grades each trial's shadow convene against the gold in its
own table (`trial signals, convened AS IF they voted`); a signal graduates by flipping `votes: true`,
which is a decision change and goes through `ab.mjs` like any other. The first trial is the keyword
heuristic as a second voter beside Jev (live, it only fills an id Jev left unanswered).

`--url` is checked once at the door: a bare host gets `https://` (`http://` for localhost), anything
that is not http or https is refused before anything runs. **A complaint or review about a page that
names no page is refused at `--convene`, `--hearing`, `--collect` and `--resolve` (exit 2)**: every
page rung needs a page, so the room would judge the ask's words and the Design Critic could not sit
(a peer's hearing, 2026-09-23). The refusal names the roster pages the ask's words point at; pass
`--url`, also accepted with `--docket <dir>`, where it re-decides the hook's page-less docket from its
saved answers, or `--no-page` when the page does not exist yet. Every value a bench `run` line carries is
one shell argument (`shellArg`: plain tokens bare, anything else quoted for cmd or sh, `%` kept
literal), so a URL with `&` or `?` reaches the instrument whole. Unknown flags are refused (exit 2).

## Is the judge right? - `eval.mjs`

`eval/asks.json` is the gold set: asks in the owners' own register, each with what the judge must
convene, what it must not, the class and the domain it should read, and where it matters the tier.
`node dredd/eval.mjs` runs every ask through Jev (the cascade) and the keyword heuristic and
scores both arms against the gold, naming every miss so the bench's question or keyword can be fixed.
The first run, the night Dredd was told to tear itself apart, read 90% on class, 79% on domain, 94%
on must-convene and 92% on must-not, and its misses rewrote five bench questions; the second run, after
those rewrites, read 87% / 96% / 100% / 98% with 25 of 32 asks perfect (the remaining misses are
question-versus-complaint readings of asks that are genuinely both); on 2026-09-22, over 39 asks,
Jev read 94% / 97% / 100% / 96% with 32 perfect against the keyword arm's 69% / 79% / 86% / 96% and 18
(the keyword arm still reads some complaints as questions - `positioning-mush`, `pass-page-people` -
which is the gap Jev exists to close). Later that day the Atlas's question was told what it is not (a
page that answers but shows nothing is the page pulse's; a red test lane is the code gate's) after it
said yes at 0.62 to a flaky lambda lane and 0.56 to a blank landing page, and the Architect's question
now names "does a check, a rule or a tool EXIST for something" after the em-dash ask convened nothing;
that run read 91% / 97% / 100% / 99% with 34 perfect, and the keyword arm 20 once the Atlas's keywords
stopped matching `account` and `lambda` on their own; with the data domain naming the memory lane
("which memories do we have about the team board" had read as copy) the next run read 91% / 100% /
100% / 99% with 35 perfect - the four left are three asks that are genuinely both a question and a
complaint or review, and the Boardroom at 0.57 on a where-is-it ask. A change to the gold is a new benchmark; say so in
the commit.

**Every ask is graded twice (the Opus 5.5 review, 2026-09-22):** once on the classifier's raw yes
(p >= 0.5, what a bench question or keyword is tuned against) and once on what `decideDocket` actually
CONVENES - the bars, the focused cap, the boardroom's code veto and the fixed rungs - because the first
number graded something Dredd never does. That second tally is what exposed the bars: Jev had the
instruments right (39 of 39 by p) while the docket convened exactly the right set for only 25 (a quick
look at "ugly button" called nothing); after the sweep in `BARS`, 30 on Jev and 25 on the keywords.
On 2026-09-23 the docket still dropped 10 of Jev's 44 right musts. `--replay <results.json>` re-scores
the asks from a run's saved Jev answers (free, and the same answers, so only the rules move the
number) and `--bars focused=0.55,...` tries a bar setting without editing `BARS`; the rule fixes
above plus focused 0.6 -> 0.55 and the focused field bar 0.75 -> 0.7 took Jev from 30 to 40 of 41
exactly right (must-convene 34 -> 42 of 44, any-of 4 -> 6 of 6, must-not 94 -> 96 of 96), the
keywords 27 -> 28 with must-not unchanged. A person who could not do the thing ("grandma couldn't find the sign
in button") is then floored at a focused review too: 43 of 44 musts on two independent Jev answer sets
(the one left is LilGranny, cut by the focused cap of four).

**The seat pick has its own gold** (`eval/seats.json`, 2026-09-22, after the first unattended hearing seated
all six product critics on one brief): ten evidence briefs in the shape `evidenceBrief()` writes, each with
the seats that must sit, the seats that must not, and the `always` seat the hearing forces. The same command
scores it (`--seats-only` / `--asks-only` split the halves, and two `-only` flags together run just those two; every ask and brief goes to Jev at once, 32 in
flight, `DREDD_EVAL_CONCURRENCY` to change it) and prints must-sit recall, must-not precision,
the count of extra seats and exact rosters, per arm; every seat's probability is kept in `results.json` so
`SIT` (`lib/seats.mjs`) can be re-chosen from the data without another paid run. The first run: Jev 95%
must-sit, 81% must-not, 18 extras over ten briefs - the extras were Grandma Sue on visual and breakage
briefs and the Marketing Minds on evidence sittings, so both seats' questions were sharpened to name the
contrast (a fix a builder verifies alone; a proposal on the table) and the rerun read 95% / 87% / 13
extras / 2 exact rosters against the keyword arm's 86% / 53% / 23 / 0. What was left of the extras was the
minimum of three topping up a two-seat brief, not Jev: six seats Jev had scored 0.09 to 0.26 were dragged
in beside a real yes, and seven of the ten gold rosters could never be exact. So the minimum is two, a
seat under `FLOOR` (0.4) is never topped up beside a yes, a room of one is a room when Jev was firm about
everyone else, and five seat questions now name what they are NOT (the Copy Editor edits prose, not
whether a card should exist; the Marketer decides positioning, not length; the Product Engineer asks
whether a thing should exist, not how an existing one reads; Grandma Sue keys on what visitors said, not
on taste; the Design Critic covers a missing control, not the words). Two gold rows changed in the same
commit, for consistency with rows already there: the Architect sits on the cramped-cards brief (a card
breakpoint and a button height are kit primitives, the dark-mode brief's shape) and the Copy Editor on
the events-hero brief (a line to rewrite, the headline briefs' shape). Then seven more briefs were written
as a **holdout** (`holdout: true`), never used to change a keyword, so the keyword arm has an honest number
and Jev a second look; the eval prints both tallies. Over all seventeen: Jev 97% must-sit (37/38), 100%
must-not (27/27), 4 extras, 12 exact; on the seven held out 93% / 100% / 3 / 3. The keyword arm 87% /
100% / 0 / 13, and on the held-out seven 67% / 100% / 0 / 3 - it is tuned on the first ten (keyed on the
ladder's states, `up to snuff? fail`, `broken? fail`, and the complaint's own phrases instead of words the
ladder prints in every brief), so its ten-brief number is a floor check and its holdout number is the
measurement. Every remaining Jev extra is Grandma Sue on a copy or positioning complaint with no visitor
report, where the gold neither wants nor forbids her; the one miss is the Product Engineer at 0.46 on the
identical-plans brief. `SIT` stays at 0.5: a missing seat cannot speak, an extra one passes.
Since the Opus 5.5 review the seat gold also holds eleven **tooling-room** briefs (a code matter's
evidence brief: the complaint, a first sitting, a ladder of not-convened rungs) and the tally prints
per room; a seat the hearing forces (`always`) is left out of must-sit, and a must-sit seat that is on
the roster only because the minimum topped it up is counted apart (`topped`), never as a judgment.
Over all 28 briefs, once a seat's yes/no stopped being escalated to the fallback model: Jev 98% must-sit
(46/47), 98% must-not (56/57), 18 extras, 14 exact rosters - against 94% / 91% / 26 / 8 with the
fallback's answers deciding. The extras left are the Adversary, the Architect and the Operator sitting on
code complaints the gold neither needs nor forbids them on; an extra seat passes.
The **minds room** has its own eight held-out briefs (2026-09-23), each a product question with one clear owner
(stalled signups to Hormozi, no word of mouth to Godin, a marketplace cold start to Chen, "we look like everyone" to
Dunford, a leaking funnel to Sabri, an expensive fix to Rory, an avoided shutdown to Manson, a price and guarantee to
Hormozi): Jev 100% must-sit (8/8) and 100% must-not (8/8) with 15 extras (Rory most often, as the second opinion),
the keyword fallback 75% and 75% - it misses a brief that never uses the skill's own words.

**Two rules the explainer sitting taught the room (2026-09-22).** Sat over `DREDD-EXPLAINED.html` with only
its text as evidence, the Design Critic measured a hero headline "48 px from the top", a diagram "under 3:1
contrast" and a teal button, none of which the page has, and the Copy Editor critiqued the Chair's ask as if
it were the page's opening paragraph - because the room was handed the LAST forty lines of a 152-line page
and asked about its first screen. So: a seat file's `needs: "render"` benches that seat, named in the
minutes and on the verdict line, whenever nothing in the docket was rendered (`renderedEvidence`: no page
pulse that loaded, no critic capture, no screenshot; a pulse whose verdict is broken rendered nothing), and
every evidence log reaches the room as its first lines, a gap marker, then its last lines (`logExcerpt`).
Re-sat under both rules, the same room read the real first screen and argued about the real words.

**The ballot has its own gold, and a split or all-void room is never happy (2026-09-22).**
`eval/ballots.json` holds quotes against four materials - real ballots from the explainer sittings,
trimmed edges, curly quotes and apostrophes both ways, dropped full stops, paraphrases, invented
numbers, another page's line, a fellow critic's words - each with the answer a person gives;
`node dredd/eval.mjs --ballots-only` scores the void rule against it for nothing (it is pure) and
exits 1 on a miss. Its first run found a quote stitched from another seat's spoken line counting as
evidence, so a ballot may now quote only the ask, the evidence and the house laws, never the meeting;
and a quote under three words ("the", "HTTP 200") is not a quote of anything. In the resolution loop a
SPLIT room (ballots four or more apart) is never happy whatever its median - three 9s and a 3 is a
fight, not a ruling - and neither is a room where EVERY ballot was void (its number is kept and
labelled, but nobody quoted the evidence), nor one with fewer than two valid ballots (not conclusive,
2026-09-24), nor one grounded only in principle: one rule, `roomHappy` in `lib/resolve.mjs`, used by the
stop rule and the verdict alike, so another proposal round runs while there is one.

**Do two instruments' own lines compete for the same asks? - the routing pass (2026-09-24).**
Jev and the keywords are graded above; nothing graded the lines they read. `lib/routing.mjs` turns every
routable instrument's name (twice), `when`, `jev` line and keywords into one stemmed TF-IDF vector, with no
model. `node dredd/eval.mjs --routing-only` (free, and part of every full eval) fails on any two
instruments at 0.75 cosine or more (a collision: Jev's answer between them is a coin), ranks each gold ask
against every instrument, and counts rank-1, top-3 and the mustNot pairs: a mustNot must be strictly
OUTRANKED by an owner, so an ask no line mentions scores a miss, never a vacuous pass. `--min-rank1 0.8` is
the ratchet the training rank-1 ratio may not fall below. About a quarter of the gold is held out, each ask by
its own hash of domain and id (so `--only`, `--limit` or a new gold ask never moves another in or out): the
run names and tallies only the training asks, and saves nothing else, `--routing-brief` prints the
training asks each instrument lost or stole and nothing of the holdout, and `--routing-against
<candidate-bench.json>` judges a rewritten bench on the held-out asks alone, printing KEEP or DISCARD with
the training numbers only (a tie or a new collision is DISCARD, exit 1). The loop is: read the brief,
reword one `when` or `jev` line in a copy of the bench, judge it, keep it only on KEEP; then the A/B and,
for a `jev` line, the full Jev eval, as any bench change owes. On landing: 0 collisions (the nearest pair,
bill ~ atlas, at 0.40), rank-1 44/53, top-3 51/53, mustNot pairs 189/190. After the upstream ideas in
addyosmani/agent-skills (MIT) and anthropics/skills (Apache-2.0); written fresh.

## What a hearing costs, and how it degrades when the field cannot think (measured 2026-09-22)

Three unattended hearings on the explainer, served on localhost (never a production page - the owner runs
those himself), with the zswarm's DeepSeek balance negative and its keys gone, so every model call rode
the free legs: the room, the ballots and the secretary on `groq-gpt-oss-120b`, the drafter and the vision
score on `gemini-3.8-flash`, Jev on TypeSafe. **The room, the drafter and Jev cost five cents of booked
list price per hearing** (58 and 52 calls, about 70 model-seconds) **and nothing of the subscription.** The
only real money is SUE: her visitors think in a sealed `claude -p` under an API key, never a CLI login,
which needs an Anthropic-shaped endpoint the free legs do not have, so with no DeepSeek key the ladder
stepped to **OpenRouter's DeepSeek at about fifty-four cents a visitor - $2.72 for five**, and that is why
a paid brain sends three (`DREDD_SUE_COUNT_PAID`) and why a rung that refused is remembered for six hours
instead of costing a launch and a ninety-second poll on every hearing. The afternoon's hearing, the first
after that memo expired, climbed to OpenRouter again unasked and spent **$3.49 on three visitors** (about
$1.16 each). Neither happens unasked any more. the Chair, 2026-09-23: "I never want you to use, like, the
Claude code or the GPT code CLI... you're not allowed to use CLI logins", and then: "I don't think they
should need api keys or something else, unless the desktop instance (aka here) has deemed say, a...
zswarm necessary". So an unattended hearing climbs NO key pool by default and SUE sits it out;
`DREDD_SUE_BRAINS` is how the chat that runs Dredd decides a pool is worth paying for, and a pin naming
`claude` is refused by name (that rung is retired, not deprioritized).

**How it degrades, rung by rung, when the field cannot come:**

- **No visitors** (every brain refused, or the ask read as a review before rung four was fixed): rung four
  is `-`, Grandma Sue is not forced in, the ballot's ceiling cannot bite from rung four, and the room
  sits over the pulse, the copy checks and whatever the critic captured. The hearing on the free legs
  with no visitors still finished (verdict 6 → 5 → 7, happy at 7, nine minutes, five of them waiting).
- **Visitors on a paid brain:** the ladder measured rung four honestly (1.2 stars over 5, 5 of 5 had no
  idea, never coming back 100%), the ceiling capped the room at 5, the ballots went 2 → 4 → 5 and the loop
  ended unhappy after two rounds - eight minutes, $2.77 all in, $2.72 of it SUE.
- **No capture** (an off-roster host: localhost, another product's site): the capture lane is not
  launched and the field wait does not spend its five minutes on a capture that cannot come; rung two is
  scored from page-pulse's own photographs instead (above), and says `NOT CHECKED` with the reason when
  the score cannot come. LilGranny judges the page too (the Chair, 2026-09-25: every tool on any site):
  page-pulse scans its controls with the capture lane's own scanner, at desktop from its load and at phone
  width from a second load, and the convene runs the granny rules over that scan with the check's own
  standards (`lilgranny.log`, rule, control and why; `lilgranny.json`, which rung three grades the way it
  grades her run over the roster capture). The rule for a hidden important action is not judged, since a
  page outside the roster declares none, and the log says so rather than calling it clean. A pulse with
  no scan (a bot check that never cleared, a page that did not load) leaves rung three `NOT CHECKED` with
  the scan's own reason. A route of ours shot ad hoc still skips her (she reads the roster capture), and
  rung three says so instead of grading the fleet.
- **A broken page:** rung one fails, the field is not sent, and the ceiling is 2.
- **Nothing can think at all** (the ladder pinned to the refused subscription rung): SUE refuses on her
  first rung, the refusal is written to `tmp/dredd/sue-brains.json`, and the hearing goes on without her -
  four minutes, verdict 3 → 6 → 7 in a split room, five cents. The next hearing does not launch that
  rung at all: SUE is "refused - every rung refused within the last 6 h" in the convene, the critic and the
  repository copy checks are skipped for the off-roster host in the same breath, and the evidence sitting
  is reached in ninety seconds - two minutes fifty in all, against nine for the first hearing of the night.
  That fourth hearing also showed the last gap: with no visitors' words in the docket, every ballot in
  the evidence sitting was void (the seats had nothing of the page to quote), so the pulse now writes the
  page's own words as `page-words.log`, first screen first, and the room and the seat-pick brief read them.

**Where the wall-clock goes:** the field wait (`--wait`, 25 minutes at most by default, and only when
something is coming - a critic whose launch failed is not waited on), SUE (about two minutes a visitor,
in parallel), the critic's wave (minutes, and it boots plane dev servers), the copy audit's Architect
run (a minute), the room (seconds a sitting, three to four sittings). The rest is seconds. **Every model
call goes through ONE resident worker per process** (`lib/brain.mjs` starts `lib/ask.py` on the first
call and keeps it): a process per call paid ~1.6 s of interpreter start and zswarm import for ~0.4 s of
model time, which was 45% of the 2 min 53 s hearing (49 calls); resident, a call is ~0.45 s wall, and
the room's ballots are asked at once (four structured calls answered in 0.56 s). Every entry point
calls `closeBrain()` when it is done - node lets an idle worker go by itself, bun waits on it. The same
no-visitor hearing on the explainer afterwards: the evidence sitting in 11 s (about 27 before), 55 calls,
3 min 4 s wall - of which ONE free Gemini drafter call stalled 101 s (the same call took 1.8 s a round
earlier); without that stall, about a minute and a half. The free leg's tail latency, not Dredd's code,
was then the largest single cost of a hearing's wall-clock: over the day's 28 single Gemini asks the
median was 2.2 s and two stalled (49 s, 101 s) on Gemini's own side. So the drafter's call is **hedged**
(`askBrainHedged`): no answer in 12 s and it is asked once more, and whichever answers first is taken; the
vision score the same at 20 s. The second call happens only on the slow tail.

**Rung two gets a number with nobody in the loop, labelled (D39, done 2026-09-22).** `lib/vision.mjs`
scores the docket's own surfaces - by id when the docket names them, else by the page's route and plane
out of the critic's fleet-wide worklist - through HSwarm's single ask with `images` (a door added the
same day: paths ride as content parts, AUTO with images routes to `gemini-3.8-flash`, role `vision`),
with the SAME brief and sixteen dimensions the session scores against, so the two are comparable by
construction. The rung's state stays `yours`; its evidence reads `7/10 by gemini-3.8-flash (vision, a
labelled second opinion ...) · yours to confirm`; the room reads `design-critic-vision.log` (score, rung,
issues with their law ids) as evidence; nothing is ever ingested, so the session's score alone moves the
ratchet (owner directive 2026-08-08). The first live probe had a resting Gemini key fail the ask over to
a DeepSeek leg with no eyes (nothing structured after 46 seconds); since the zswarm's e802845 an ask with
screenshots fails over only to legs that can see (`vision: true` in its registry) and answers
`NoVisionLeg: ...` when none has credit, so Dredd takes the score as it comes, names the model that gave
it on the row, and the brain's ledger row names every failover. Live on the demo surface (eleven screenshots, the 120k-character brief): "7:
Industry-standard SaaS", overall 7, four seconds, three cents. `DREDD_VISION=off` turns it off,
`DREDD_VISION_MODEL` names another model. Compared with the session's own read of the same eleven
screenshots (overnight, 2026-09-22) the raw score drifted three ways - motion scored 8 from stills, a
dimension scored 8 beside an issue the model itself listed against it, and the same input scored 6 then 7
on two runs - so the prompt now says what the settle step enforces (`settleScores`): a screenshot's
motion is null, overall is the calibration rung the model named, a dimension with an issue against it is
held to 7, and every issue names its dimension and law. Settled, the two reads sit within a point on every
dimension and match on eleven of sixteen; the brief (the critic's canon) was not touched.

## The Boardroom of critics - `boardroom.mjs`

**There is one Boardroom, and it is Connections'** (Owner, 2026-09-22: delete the boardroom Dredd
uses; the Connections Boardroom runs a member's own model natively, and "just like Sue, you store all
of your personalities always in connections, but can use your local models"). Until then this file
held its own meeting in memory with the plane's round functions. Now every sitting is a **real
meeting on app.example.com**, in the account this machine's MCP is signed in as
(`lib/connections-board.mjs`, reached through `lib/mcp.mjs`'s `api`):

- the **seats** (`seats/*.json`) are the workspace's **board members**, FOUND there every sitting
  (Owner, 2026-09-26): each create is sent with `reuse: true`, so the plane hands back the workspace's
  person of that name, and only a person nobody has made yet is made (one Connections credit). Until
  then ids lived in a file on each PC, and every PC that missed made the critics again (256 rows for 28
  people, 18 product rooms). ⛔ A seat file holds no words (Owner, 2026-09-28: "There should not be a
  single local personality in the workspace"): its brief, playbook, seat title, one-liner and "modeled
  on" are the seat's tier "seat" row in the **persona store** (`store/store.mjs`, sue_personas on the SSH
  server; slug `seat-<seat id>`, `sue.seat` the seat id), read with `store.list` (tier seat) and `store.get` per seat, without Connections, from the
  store's cache with its age when the host is out of reach (Owner, 2026-10-15: every persona's text on the
  SSH server). `store/import-seats.mjs` copied them once, read-only, off the board members of the Connections
  workspace (`SEATS_HOME`, read through the engine checkout's binding when that workspace refuses this one); a
  seat the store lacks stops by name. The meeting is still the plane's, so the workspace's board member of that
  name is made from the store's words, or brought up to them as a free update when this PC has not pushed exactly
  them.
  What a sitting derives is pushed as a free update: a mind's KB, and SUE's person at the table (her
  voice, then her `atTheTable` and `atTheTablePlaybook` fields, on her own Sue record);
  `tmp/dredd/connections-board.json` only remembers what this PC last pushed;
- the room is one of its **boardrooms**, found the same way by name and exact seating (named
  `Dredd <room>: <who sits>`); the plane seats five, so a sixth pick is benched and named;
- a mind seat's playbook is a whole verified KB (up to 400,000 characters) and the plane echoes what it makes,
  so a new member, a room and a meeting can answer past the MCP's 200,000-character cap: a member is made with an
  empty playbook and filled by an update, and a cut 2xx answer is read as a success whose id comes from the head
  of the answer (`madeId`), never retried into a duplicate (found by the first live minds sitting, 2026-09-23). In
  the minds room a ballot may quote the seat's own playbook, since a bare advice question carries no evidence log;
- each turn goes through the plane's own-brain doors: `meetings/prompt` hands out exactly what the
  adviser is asked, Dredd's **brain** (`lib/brain.mjs`: HSwarm's free default, or Opus on this
  machine's login) answers, and `meetings/answer` records it under the plane's turn ledger, PASS rule
  and length cap. No Connections AI credit is spent on thinking.

The docket's facts open the meeting as the member's own first lines (the plane caps a line at 20,000
characters, so long evidence takes two), then the ask, so the speaking order is the ask's. A board
that cannot be reached (no sign-in, no Pass, no credit for a new seat) is a sitting that could not
sit: a failure record naming why, exit 1. `minutes.connections` names the meeting and room, and the
transcript's first line links them.

**Three rooms.** The product room hears pages, copy, flows and product calls: the Design Critic, the
Copy Editor, Grandma Sue (her voice is SUE's own built-in person, read from Connections when the room sits - one source), the
Architect, the Product Engineer, the Marketer, and the Marketing Minds (Rory, Hormozi and Dunford in one
seat, which sits over every drafted proposal and over the evidence only when Jev asks; its playbook is
the three minds' verified knowledge bases, each entry naming whose it is). The **minds room** hears a
product call with no page in front of it (what to build, how to price it, why growth stalled, how a
game should play): one seat per mind skill on disk (`mindSeats` - every `.claude/skills/<name>/` with
a KB.md, the same roster rule as the Architect's `operator-skill-integrity`), each seat's brief read
off the skill's SPINE.md and its playbook the skill's whole KB, converted by
`scripts/boardroom/skill-playbook.mjs` (the one converter the Boardroom plane's built-in Alex and Rory
use too, the Chair 2026-09-23: "make sure those are combined together"). A new mind skill is a board
member the day it ships; there is no seat file to write. The plane seats five, so Jev picks which
minds sit from each skill's own "use whenever" line (`pickMinds`; the skill's topical words when Jev
is unreachable), fills all five chairs across fields (`fillMinds`, below), and the pick is written beside the minutes as
`seats-pick.json`. `--board design` or `--board educators` draws the five from that board's fields. The tooling room hears code, data, infra and security:
the Architect, the Copy Editor (for the docs), the Adversary (refutes every claim without evidence in
the room), the Operator (will anyone reach for it, what does each use cost), the Security Seat
(follows every byte to its sink) and the Quota Keeper (which tier should have paid). The room is
picked from the docket's domain (`--room` overrides); a seat file's `rooms` says where it sits. This
split came from Dredd's first hearing on itself, when six product critics argued about a headline
for a CLI. One seat can sit in every room: **the Chair**, the owner's own voice (the "the Chair" board member, routed by `seats/13-chair.json`,
the Chair 2026-09-25), built from the 12,524 messages he typed or dictated into the chats on his PC,
AI-written and pasted text left out and the swearing stripped. Jev seats it where the call is his on
sight (how a screen looks and feels, whether a feature is for the mainstream, the AI product, how the
agents working for him behave); on held-out decisions it matched his real call 73% of the time against
55% for a generic owner. How it was built, measured and checked: [persona/README.md](persona/README.md).

Round one answers the ask in seat order (or only the seats the ask names). Round two is a fixed
member line: rebut the person before you, name what you would change first. A seat with nothing to
add passes, counted into the minutes and kept out of the transcript. A seat whose model call **fails**
is not a pass: it is named in `minutes.failedSeats` and on stderr whatever `--quiet` says. A room
where nobody spoke, or whose secretary failed, exits 1 with a failure record (`minutes.json` carries
`failed` and the reason) and the hearing reads that as no minutes - never empty minutes that read as a
sitting that sat. The room's own previous sittings and the hearing's diary are never fed back to it
as evidence. (All four from Dredd's review of its own room, 2026-09-22.) A seat's or the secretary's
call is tried twice before it counts as failed (the free leg drops a structured answer now and then).
Then **the ballot** (`lib/ballot.mjs`, the Chair, 2026-09-22: "more black and white ... a way to decide
who's right"): every seat votes in silence over the whole meeting - a score out of ten, the one fix,
and the evidence that decides it, quoted word for word from the material. A ballot whose quote is not
really in the material is VOID, named, and does not count; the verdict is the lower median of the
grounded scores, the spread is on the verdict line, a spread of four or more is a SPLIT room and is
said as such, and the ladder caps the number (`ladderCeiling`: a broken page cannot score above two, a
page whose visitors did not understand it above five, a page that failed the first-timer lens or the
copy checks above six, a wobbly one above eight - the cap and its rung are on the verdict line; the
hearing writes `ladder.json` into the docket for this). A verdict takes two valid ballots (`MIN_BALLOTS`):
a sitting with fewer, every-ballot-void included, is NOT CONCLUSIVE - no score, its cast scores still on
the line so the number is not lost, and never happy (2026-09-24: the founders and home pages' final
sittings were each "scored" on one ballot after the Copy Editor's was voided). A ballot whose quote is
not in the material is asked for once more, with the complaint named as quotable, and the second answer
counts only when its quote is real (`requoted` in the minutes; 2026-09-25: on a bare sitting six of six
ballots had quoted the meeting or a playbook and no sitting reached a verdict). A page heard before reads
the last three rulings on the same url (`lib/earlier.mjs`: each score and fix, and what a scored
proposal changed), and every ballot answers `reverses_earlier` and `earlier_was_wrong`: a fix that
reverses an earlier one without a reason is void, named apart from a quote void (2026-09-24: the
founders page was told to drop its repeated button label, did, and was then scored 3/10 by a room
asking for one label again). A missing score is no vote (never a 1/10), a seat whose ballot call failed is named and left
out of "N of M ballots cast", and a sitting where no ballot was cast at all exits 1 with a failure
record like a room where nobody spoke. The ballots are asked at once (they are silent and read the same
meeting). Every sitting's material leads with the complaint, so a proposal sitting still knows what the
page is being judged against. The secretary then writes minutes, a plan
and a closing line from the closer the plane's own rule picks (required, as the plane requires it),
clusters the ballots' fixes and names the one the most ballots backed, and WHICH seats' ballots named it
(`fix_first_seats`) - the secretary never scores and never counts: the verdict is the ballots' arithmetic,
and the backing (`fix_first_backed_by`) is code counting those names against the ballots really cast
(`countBacking` in `lib/ballot.mjs`; a name with no cast ballot is dropped into `backingErrors`, and every
other seat's own fix rides next to the verdict as `other_fixes`). Every ballot is in `minutes.json` and
`transcript.md` so the count can be checked. The first vote, over the
explainer: 3, 4, 4, spread 1, every quote grounded, the fix backed by two of three. The write-up is
stamped: a file it cites that does not exist in the repository is named as UNFOUNDED on
the verdict line and in `minutes.unfoundedCitations`, never taken as a finding (a clean tooling room
once cited `src/auth/cognito.ts:42`). The same stamp runs earlier: a file a seat names in the meeting
that the repository judged does not have is marked `[not in the repository]` before the line is
recorded (`minutes.unfoundedTurnPaths`), a ballot whose fix names one keeps its score but its fix can
never lead, and a ruling whose fix names one is set aside for a real ballot's fix
(`minutes.fixFirstInvented`); the drafter is told the ruling's invented files by name. A room judging
another repository (`--root`, or the docket's own `root`) reads that repository's stack and file list
as its house (`houseFor`, `lib/repo-facts.mjs`), never Connections' Vue brief: on a plain static site
the room proposed `src/components/SharedCTA.vue` (2026-09-24). On a **code** docket that names paths the room is told the
checks ran, not that visitors spoke, and it reads the code gate and the Architect's findings on those
paths (`arkitect-named-paths.log`), never the repo-wide grid or summary. With
`--docket`, the room argues over the docket's facts: the tails of the phase-1 logs and the recalled
memories ride in as `advisorFindings`, so the Copy Editor argues from the measured word count, not
from memory. Output: `<docket>/boardroom/transcript.md`, `minutes.json`, `calls.jsonl`.

## The code review - `review.mjs`

One CHANGE reviewed as a gate (2026-09-24, harvested from react-native's `.expo-code-review` and mattpocock's
code-review skill, both MIT, ideas only): who reviews it is decided by the paths it touches, the Standards and Spec
axes are reported side by side and never merged, and the verdict is computed in code (`lib/review.mjs`), so nothing in
the diff can talk its way to an approval.

```
node dredd/review.mjs --roster [--base origin/main]   who would review this change, and why (no model)
node dredd/review.mjs --ask "<what it was meant to do>"   the review; --spec <file> instead of --ask
node dredd/review.mjs --commit <sha>                  one landed commit as itself (<sha>~1..<sha>)
node dredd/review.mjs --docket <dir>                  as the bench's code-review instrument (the docket's ask is the spec, and the Spec judge is told it may only ask for a review); a post-land checkpoint docket names its commit and is reviewed as that commit
node dredd/review.mjs --gate                          exit 3 on request_changes, an incomplete review or a refused dismissal, for a hook or CI to hold on
node dredd/review.mjs --dismiss <id>=<kind>:<citation> [note]   dismiss a finding with its disproof, checked before any model is asked
node dredd/review.mjs --previous <dir|review.json>    chain on the last run: a third round of edge cases on one function is residue
```

- **The roster is a folder.** `reviewers/*.md`, one reviewer per file, or the judged repository's own
  `.dredd/reviewers/` when it keeps one. Frontmatter: `description`, `axis` (`standards` or `spec`), `alwaysRun`, and
  `security: true` for a seat whose every finding is a security finding (the seat decides, never the category word
  the model writes); a body line `@ref glob: <glob>` routes a specialist to the paths it matches, and it is shown only
  those files (a finding on any other file is graded down).
  `shared.md` is every reviewer's preamble. A file that is neither alwaysRun nor routed is refused by name.
- **Two axes, never merged.** The Standards judge reads the repository's own `.claude/rules/*.md` whose `paths:` match
  the change, then a twelve-smell baseline (every smell a judgement call, never above minor). The Spec judge grades
  missing / scope creep / wrongly built, quoting the spec; a finding that quotes no spec line is graded down, and with
  no spec the axis is reported as not judged, never as clean. The report opens with the worst finding on each axis.
- **The coordinator, in code.** Dedupes within an axis (one id, or one file within three lines in one category: the
  highest severity wins, every reviewer who saw it is named), grades a finding on a file the change does not touch one
  level down, and never grades a security finding down. Verdict per axis: a critical, or an important security
  finding, is `request_changes`; any other finding `approve_with_comments`; none `approve`. Overall: the stricter
  axis. A reviewer that did not answer makes the review incomplete and can never leave it at `approve` (and
  under `--gate` exits 3); all of them silent exits 1.
- **Untrusted input.** The diff, the spec and the rules reach each reviewer inside a fence keyed to their own hash.
  Only an inline `dredd-review-ignore: <kind>:<citation>` on the flagged line (or the one above) suppresses a finding,
  never a critical or an escalating one, and a marker whose disproof does not check out suppresses nothing (the
  finding stays, with the reason). Every finding carries `id:<fingerprint>` (axis, file, category, title: it survives
  a rebase), which is what `--dismiss` cites.
- **Dismissals, escalation, rounds** (2026-10-07, harvested from tester-army/e2e's review triage, Apache-2.0, ideas
  only). A dismissal names its disproof, `<kind>:<citation> [note]`, in one of five kinds:
  - `pre-existing:<sha>`: the commit `git blame` names for the flagged line, at or before the reviewed range;
  - `misread-semantics:<link>`: the library's https:// doc, or its installed source under `node_modules/`;
  - `guaranteed:<path>:<symbol>`: the helper, type or closed schema that makes the failure impossible;
  - `trade-off:<link, path or sha>`: where the choice is recorded;
  - `repo-rule:<path>`: the `AGENTS.md`, `CLAUDE.md` or `.claude/rules/` file the reviewer's generic rule contradicts.

  A citation that does not check out is refused before any model is asked (exit 2); a dismissal that holds takes the
  finding out of the verdict into `## Dismissed with a disproof`. A finding on auth, a public contract or a wire
  schema escalates (`reviewers/escalate.json`, or the judged repository's own): its dismissal is refused with the
  owner and a Boardroom line, never silently, and `--gate` exits 3 on any refused dismissal. With `--previous`, a run
  counts the rounds of new findings on each function (`<file>#<function>`, named by a scan of the file); after two, a
  third round's new findings there are residue, listed under `## Out of scope` and out of the verdict, never a
  critical or escalating one. The gold is `eval/dismissals.json`, graded free by `--dismissals-only` in eval.mjs.

- **What counts as the change:** `git diff --merge-base <base>`, so committed work and tracked edits in the working
  tree; a file git does not track yet is not reviewed until it is added. A landed commit is `git diff <sha>~1 <sha>`
  (`--commit`, or the commit a checkpoint docket's ask names): after a land origin/main already holds the commit, and
  the merge-base diff is empty (32abc5cefa, 2026-10-01: a post-land review approved a diff that held none of 32
  landed paths). An empty diff files `nothing_reviewed`, never `approve`, and a diff holding none of the paths a
  checkpoint docket names is refused (exit 2).
- **Writes** `review.md`, `review.json` and `review-calls.jsonl` into the docket, `--out`, or `tmp/dredd/review-<stamp>/`.

## The hearing - `--hearing`

The whole thing, unattended (the Chair, 2026-09-22: "Dredd will run Sue, Sue will give her complaint,
then the boardroom, which will determine who in the boardroom should be in this conversation using
Jev, will run a boardroom session over the findings of Sue ... and then we review changes with the
boardroom until we're happy").

```
node dredd/dredd.mjs "<the complaint>" --url https://example.com/ --hearing
node dredd/dredd.mjs --hearing --docket tmp/dredd/<stamp>          # resume one already convened
flags: --wait 25 (minutes for the field)  --until-happy 2 (proposal rounds)  --happy-at 7 (the room's score that ends it)
node dredd/dredd.mjs "<the complaint>" --url <page> --run <runId>[,<runId>...] --hearing [--detach]
```

**`--run <runId>[,<runId>...]`** makes a new docket whose field is finished SUE, APE or ART runs in
`sue/runs/<runId>/`, so the room rules on findings already on disk and nothing launches a visitor. Each run is
collected by its own kind (read from its folder; an entry may name it, `art:<runId>`) into `sue.log`, `ape.log` or
`art.log`, the same collector a launched run uses. A run with no folder is refused by name. With `--root`, the runs
are still read from this checkout's `sue/runs/`, where SUE files every run whatever repository is judged.
Example, over the APE run
`20261009-111111-bbbb` and the ART run `20261009-121212-cccc`:

```
node dredd/dredd.mjs "checkout feels broken" --url https://example.com/checkout --run 20261009-111111-bbbb,art:20261009-121212-cccc --hearing --detach
```

A SUE run a hearing starts is headless, as every wave an AI starts is (sue/sue.mjs): no Sue Manager, tray icon
or window opens. A person looks with `node sue/sue.mjs watch`.

In order, every step logged to `<docket>/hearing.log`:

1. **Convene** as `--convene` does: the pulse and the facts, the room's first sitting, the field
   launched hidden (SUE with vault-leased credentials, the critic's wave).
2. **Wait** - polls SUE's status (`lib/sue-status.mjs`, the one reader: a run is over when it
   finished, was refused, stopped or failed, or every expected Sue finished) and the critic's capture
   (it must cover this docket's surfaces since the docket opened, never merely be newer); a critic whose
   launch failed is not waited on; bounded by `--wait`.
3. **Collect** - SUE's report, the capture and LilGranny, the flow walk, into the docket as logs.
4. **The ladder** - the five rungs read from the evidence (below).
5. **Jev picks the seats** - `lib/seats.mjs`: every seat file carries one typed yes/no question and a
   few keywords; Jev reads the evidence brief (`evidence-brief.md`: the complaint, the pulse, the page's
   first words, what the Sues said in their words - one visitor at a time, in turn, so one talkative Sue
   is never the whole block - the first sitting, the ladder; budgeted by part under its 6,000-character
   ceiling, so the short summing-up lines always survive and the long ones share the rest) and says who sits. Yes
   at `SIT` (0.5), at least two (a room of one when Jev was firm about everyone else: a seat under
   `FLOOR` is never topped up beside a yes), never more than six, the `always` seats placed before the
   cap (Grandma Sue whenever SUE's report is in), a seat that `needs` a rendered page benched when
   nothing was rendered, keywords when Jev is unreachable. Written to `seats.json`; the Boardroom reads it
   whenever `--seats` is not given. Jev's cost for the pick is booked in `jev-calls.jsonl`.
6. **The sitting over the evidence** - those seats only. Every sitting numbers itself from what the
   docket holds (`sit()` in `lib/collect.mjs`): the live `boardroom/` is archived as the sitting it was, so
   a second hearing or a second collect on the same docket never writes over one. Verdict, fix first.
   6b. **The rulings** - `lib/claim-rulings.mjs`, the owner's rule (2026-10-09): SUE, APE and ART only find errors, and
   none of their claims is repaired until the room has ruled on it. Every finding the field reported is collected
   into one numbered list: each SUE/APE problem note, each ART fix-first item and design-debt line, the same thing
   said twice merged into one claim. Each claim carries its evidence: who said it, on which screen, their words.
   The ruling panel answers per claim, whatever the question seated: the Design Critic, the Product Engineer, the
   Adversary, Grandma Sue and the Chair (`RULING_PANEL`; a repository judged with its own seats fills a missing chair
   from the hearing's picks). Each says REAL, NOT REAL or CAN'T TELL, with one line of why, without reading the others'
   rulings: `RULING_INSTRUCTION` asks "each of you, independently", which the plane runs as a blind panel
   (`wantsBlindPanel`; its rebuttal pass is never asked for). Heard in order, the seats copied the first: the
   2026-10-10 calibration ruled 40 of 40 claims unanimously. The
   claims go through the same Connections Boardroom door as every sitting (`rule-claims.mjs`, the plane's turn ledger
   and length cap), in batches that fit it. A claim is REAL only on a majority of at least three replies; otherwise
   NOT REAL, or UNPROVEN when neither side has the majority. The docket gets `rulings.json` and `rulings.md` (every claim, its
   votes and reasons), and the hearing log, `--status` and the verdict print the counts. Only REAL claims reach the
   drafter. A hearing with no REAL claim drafts nothing and says so. A room that cannot be reached stops the hearing
   with that said, and nothing is drafted: there is no fallback that rules without the room. ART's fix-first lines
   print as "claimed fix first (the room has not ruled):" and are never handed on as instructions.
   6c. **The experts' homework and the burn-down** - `lib/claim-diagnosis.mjs` (owner, 2026-10-10): the REAL claims
   are cut into units (one screen, one likely cause), Jev routes each unit to the bench seats whose field bears on it
   (a yes at `ROUTE_SIT`, at most `ROUTE_MAX`, a SUE visitor's voice after the experts; `routing.json`), each routed expert answers its homework on the Connections Boardroom with the screenshots (right or
   a misread, the problem, the fix, done when, what to keep; `homework.json`), and one synthesis writes the ordered
   burn-down, one standalone brief per item (`burndown.json`, `burndown.md`). The experts and the synthesis think on
   GPT-6.1 Sol (`rank:gpt-6-1-sol:openai`, failing over to the `critical` profile); `DREDD_EXPERT_MODEL` names another
   model. With the product's git checkout (the
   docket's `root` on a `--root` hearing, or `diagnose-claims.mjs --repo <checkout>`), every homework and the synthesis
   also read the commits it landed after the newest run the claims cite, under CHANGED SINCE THE VISITS, and an item a
   listed commit plausibly addresses is marked ALREADY CHANGED with that commit, never dropped: on Packing Buddy
   (2026-10-10) three items described print problems a commit had reworked after the visits. A builder reads today's
   code before building a marked item. `bun dredd/diagnose-claims.mjs --docket <dir> [--repo <checkout>]` reruns
   the stage, keeping the homework that answered; `--review --docket <dir> --item B3 --after <png>` asks B3's experts
   whether a repair solved it. The sittings run breadth first (every unit's first expert before any unit's second,
   the units the room ruled most firmly first), stop opening meetings at the Boardroom's first "allowance is used up"
   and at `--max-usd`, and the next run sits only what is left. Each expert sees the visitors' pictures (THEN) beside
   the screen as it renders today (NOW, captured headless at 390x844 and 1280x800 by `scripts/ui/phone-render.mjs`) and
   may answer ALREADY FIXED. A claim the experts split on goes back to them once, with every reason, before the
   synthesis, which never settles a split itself. The routing (`lib/claim-routing.mjs`, a decision file) is measured
   by `eval.mjs --experts-only` over `eval/experts.json`, gold complaint units with the experts each wants.
   **A fix subtracts before it adds** (owner, 2026-10-11: "you add more shit to the screen ... to make the SUE people
   happier, but it's not helpful"). Of 479 burn-down items from the 26 hearings of 2026-10-10 and 11, 203 put more on
   the screen before any tap, 58 took anything off, 6 folded anything behind a tap and 6 named any motion: every
   complaint became one more line, built alone, and the screens grew. So every expert chooses its remedy in a fixed
   order (take away, reorder for hierarchy, fold behind a tap, and only then add, naming what leaves) and writes its
   SCREEN COST; the synthesis carries `screen_cost` on each item and opens a screen with three or more items with a
   SCREEN PASS that sets the screen's order of importance; the builder's brief says so; and the repair review calls a
   screen busier than its screen cost allows BROKE, reading `scripts/ui/first-screen.js`'s counts (words, text blocks,
   boxes and their nesting, controls, type styles before any tap) from every capture.
   **The owner's picks outlive a hearing.** The product keeps its standing decisions in `.dredd/decisions.md` (the
   owner's dated picks for its screens, in his words), read as landed on the checkout's `origin/main`: Raise Buddy's
   hearing checkout sat 23 commits behind on 2026-10-12. Every homework and the synthesis read them under RECORDED
   DECISIONS beside the docket's own `decisions.md`, `burndown.json` carries them, and the repair review calls an AFTER
   screen that undoes one BROKE. Raise Buddy's matches header, the owner's pick A on 2026-10-12, was undone within ten
   hours by visitor rounds whose dockets recorded no decision.
7. **The resolution loop** - `lib/resolve.mjs`: a drafter (Gemini 3.8 flash by default,
   `DREDD_DRAFTER_MODEL` overrides - measured on the real draft: 3 s and a third of a cent, where
   DeepSeek flash through OpenRouter took 90 s and answered empty; a call that brings back no proposal
   is asked of the next model in `DREDD_DRAFTER_FALLBACK`, else `auto`, HSwarm's tool-free default,
   and the proposal names the model that really drafted it (four hearings on futurethatworks.org,
   2026-09-24, ended at the evidence score when Gemini's spent pool routed the drafter to that same
   DeepSeek leg); the house laws and the marketing laws in its system prompt, the
   page's rendered text in front of it, and the screens SUE's visitors saw past it, from the SUE report's
   `screensSeen`, since a complaint about a flow inside the product is about words the front door does not
   carry: a Lift hearing on its lesson player drafted against 65 words of front door and quoted screens
   that do not exist, 2026-09-29) writes the exact change - where, before, after, why, what to cut. It
   reads the text of every file the ruling names, from the judged repository's root (size-capped, the cap
   said in its prompt, never a path that resolves outside the root), and a draft with an empty after or
   one that asks to read a file first is no draft (`draftGaveUp`): it is asked once more on HSwarm's
   `code` profile, and a second give-up ends the loop with the reason in the verdict (Lift's round 23,
   2026-10-02, sent such a stub to the room, which scored it 1/10); the **claims check** (`lib/claims.mjs`, pure) refuses any offer word, number or capability the
   page does not already carry, any capability no plane declares in `plane-capabilities.json`, and
   anything the page's own recorded rulings rule out (`lib/rulings.mjs`: a name an `@ruling-retires` line
   retires, a cut or change that removes what an `@ruling-keeps` line keeps; the drafter reads the route
   component's `⛔` header paragraphs, gold in `eval/claims.json`) (a
   change's `before` counts as the page's words only when the page or a screen a visitor saw really
   carries it; figures match
   across currency sign and case), with one redraft allowed - then the stamp cuts, by place, what the
   redraft still filled with (the drafter re-inserted "no credit card" twice running, measured
   2026-09-22) and the surviving changes go to the room with the cuts named at the top of the file; a
   proposal with nothing left is filed as REJECTED and the room never sees it. Only a draft that passed
   goes to the **Humanizer**, which may change the afters and the headline and nothing else (the rest is
   kept from the draft), and its text is checked again - a Humanizer that added a claim loses to the
   checked draft. The room sits again over the proposal (`--proposal <file>`, the secretary scores THE
   PROPOSAL) with the Marketing Minds seated for it, until the score reaches `--happy-at` in a room that
   is neither split nor all-void, or the rounds run out. `proposal-<n>.md` per round. **Nothing is
   applied to the repository** - the front door's words are the owner's to land, with the room's score
   next to them.
8. **File** - `hearing.json`, `verdict.md` (the ladder, who sat and why, the bill, every sitting's score,
   the proposals the claims check refused, the resolution, **the change** - the last proposal the room
   scored, its where/before/after inline beside that score - **in their words** - up to five visitors'
   own lines copied verbatim from SUE's report, the never-coming-back ones first - and the last
   proposal's file), so the owner can decide from verdict.md alone, and the docket's
   `RESOLUTION:` line. The bill counts every model call (the sittings, the drafter, the vision score,
   Jev's seat pick), SUE's spend ("so far (still running)" when she outlasted the wait) and the wall
   from the docket's opening, or from a `--resolve`'s own start.

`--resolve --docket <dir>` re-enters at step 7 on a docket that already holds its evidence and
`seats.json`: the drafter, the check and the room are cents, SUE is a dollar, so the loop is tuned
without re-sending people. It drafts only against a real ruling: when the last sitting left a failure
record or no minutes, it says so and drafts nothing. Measured on a copy of the first unattended docket (2026-09-22): the stamp
refused "no credit card" twice and cut it, the room scored what was left 4/10, the second proposal
passed the check clean and scored 6/10 - the page's best so far, with nothing invented reaching the
room (the night before: 3, 4, 5, and a free trial the room had to catch itself). The MCP door runs the same thing as `dredd { action:"hearing", ask, url }`
(and `action:"resolve"`), detached: it returns the docket directory in seconds, and `action:"status"` with that
`docket` reads it (step n of 8, the log from `fromLine`, SUE's progress, the sittings and the bill so far,
`verdict.md` once it exists); `action:"stop"` ends it and `action:"dockets"` lists past ones. The door used to hold
its caller for up to an hour and kill the tree at its ceiling, verdict and all.

**Durable, one at a time (the MiroFish review, 2026-09-23).** `hearing.json` is rewritten after every step (the
step, `stepsDone`, pid, host, `startedAt`), so `--status --docket <dir>` answers from any process and `--dockets`
lists every docket newest first with its next command. A second `--hearing`, `--resolve`, `--collect` or
`--convene` on a docket whose recorded pid is alive on this host is refused (exit 2, the lock named); a dead record
is taken over and said once. A hearing that throws still files: `hearing.json` says `failed` and where, and
`verdict.md` is a labelled partial record with the one command that resumes. A resumed `--hearing` whose field had
landed and whose room had sat goes straight to the resolution loop, with no second Jev pick or evidence sitting.
`--detach` runs a `--hearing` or `--resolve` hidden in the background (its output in `detached.out`, never a `.log`,
so the room never reads its own run; the ask travels in `ask.txt`, because cmd cannot carry a quote). A
`--hearing` that will send SUE first asks one model for a structured answer (tried twice, free): when none answers it
exits 2 before a visitor is paid for, because the room would fail after she had spent (`DREDD_PREFLIGHT=0` sends
her anyway).

**Durable convene, not only a durable hearing (proposal P5, the MiroFish review, 2026-09-23).** Convening is step 1
of the hearing above, and it is durable the same way: `<docket>/convene.jsonl` gets one row the moment each
instrument's result is decided, not only once the whole loop returns - so a process killed mid-convene (SUE's own
refusal poll runs up to ~90 s) leaves a record of what had already landed instead of nothing. A resumed convene
keeps every instrument that already has a row (`lib/convene.mjs`'s `resumePlan`, pure, tested with no I/O), except
a row that says a backend outage stopped it ("try again", a timeout, no connection slots, a 502/503/504): that
instrument never ran, so it is sent again, and the resume line names it. Any other refused or failed row is final
for the docket, and the resume line says which ones and that a fresh docket sends them again. A SUE
launch whose `"launching"` marker has since gained a runId in its log is re-attached by that runId rather than
sending a second Sue over the same visit, and one with no runId yet but still inside its own ~2-minute window is
left alone rather than guessed at - only past that window, with nothing in the log, does it count as never launched
and run again. A docket convened before `convene.jsonl` existed still counts from its own `docket.json` `results`,
so nothing already-finished is re-sent. `--hearing`'s own resume decision reads this same plan, never
`docket.results.length`, so a docket that only finished converging on a _later_ attempt is not mistaken for one
that never started. The docket's RESULTS section then carries a line such as
`convene resumed: 4 kept, sue re-attached to run <id>, 2 launched`.

## The page ladder

the Chair's five questions about a page, in his order (2026-09-22), each answered by one instrument:

```
1. Is the page broken?          page-pulse   one headless load: status, ms, words, console and page errors,
                                             failed requests, broken images, overflow on a desktop and a phone
2. Does the design look good?   design-critic (the capture lands unattended; the PNGs are scored by the session,
                                             never a subprocess - owner directive 2026-08-08)
3. Does it make sense?          lilgranny    the first-timer lens over the capture
4. Can people understand it?    sue          stars, "no idea" share, never-coming-back share
5. Is the copy up to snuff?     copy-audit + the Humanizer
```

A named page always gets its pulse taken first (`page-pulse` joins any docket with a URL at any scope
above a quick look), and **rung two is fixed the same way**: on any grievance that names a page, the
Design Critic is convened whatever Jev's yes said about the complaint's words (the first unattended
hearing left rung two dark because a copy-shaped complaint sat the critic under the bar). The capture
lands unattended; the PNGs stay the session's to score, so rung two reads `yours` and `verdict.md` names
the worklist. **A broken page stops the ladder:** `convene.mjs` does not send the field after
`page-pulse` says `broken`, and the room sits over the breakage instead (`DREDD_LADDER_STOP=0` to
override). `wobbly` (a console error, a failed request, overflow, a redirect that landed on another
page) continues and is a fact the room hears; the pulse records the final URL and the redirect hops.
`unmeasured` (the page answered but its text could not be read) names the cause and skips rung one -
not a pass, not a break - and the ladder goes on. `lib/ladder.mjs` is pure and tested; `verdict.md`
prints the ladder first.

**A page behind a host's bot check (2026-09-25).** Hostinger answered the pulse's first load of
sullivanfantastic.com with a 403 "Checking your browser" page that lets a browser through seconds later. The
pulse called the site broken, the ladder stopped at rung one, and the room scored the check page 1/10 and
proposed a Connections component for a performer's site. Now the pulse waits the check out (`CHALLENGE_WAIT_MS`)
and measures only the page behind it; a check that never clears is `unmeasured`, never `broken`, and its ruling
is never read by a later hearing (`lib/earlier.mjs`). A page on a public host that is not ours, with no `--root`,
is judged as that site (`foreignHouse` in `lib/seats.mjs`), never as Connections.

**Rung two for any page (2026-09-24).** Twelve hearings on futurethatworks.org passed a site the owner found
bland, because rungs two to four printed a quiet `-` beside a board score: the Design Critic and SUE were off
another repository's bench, and the capture lane skipped any host that is not ours. Now `page-pulse` scrolls
the page with real wheel events (scroll reveals fire), photographs the whole page at 1440x900 and 390x844
as an overview (`page-desk.png`, `page-phone.png`), then viewport slices of each from top to bottom
(`page-desk-01.png`, `page-phone-01.png`, ...: `sliceOffsets`, each overlapping the last by a tenth so no px goes
unseen and no heading is cut at an edge, up to thirty per width; a page longer than that is never spread thinner -
the rung says `page longer than 30 screens: N px not scored`), and records its h1-h3 and its buttons (`page-headlines.log`, which the
Speech Coach reads as headlines). A page the lane cannot shoot - a host that is not ours, or any page when
`--root` judges another repository - convenes the critic as `awaiting scoring` (`pageShotRung`,
`lib/convene.mjs`), and collect scores EVERY SLICE on its own with the vision model against the Design Critic's
brief and the canon (`collectPageShots`, `lib/collect.mjs`; `pageShotBrief`, `lib/vision.mjs`). The rung is the
WORST slice's score - a page is as good as its weakest section, and a 14,000 px page shrunk into one image showed
the model a layout and scored a bland section 8/10 - and the three lowest are named with their issues. It writes
`design-critic-vision.log` / `.json` where the room and the seat pick read rung two. When the score cannot
come (vision off, no photographs, no model answered) the row says `NOT SCORED` and why. **On a page hearing
a rung that did not run prints `NOT CHECKED: <question> - <why>`**, and the line under the ladder says what
the board's score covers (`THE SCORE COVERS the copy ... ONLY`), so a number over a half-checked ladder is
never read as a pass. A code matter's dark rungs keep their quiet `-`.

## A round, its target, and the design board (2026-10-01)

the Chair, 2026-10-01: "The synthetic process is the answer, not real people ... Students and teachers say what they need;
the boardroom's experts ... decide how, in a way the users didn't know they needed ... The stars are the target, and it
should improve as it goes, every round." Lift's class unit sat at 3 stars for nine rounds: its rounds ran outside Dredd
with no table after round 9, the minds room seated two educators of thirty minds, nothing knew a target, and every
hearing that did sit ended in the drafter's "exact copy change and nothing else". Four changes, so the tools do this
without being told:

- **SUE rounds** (`sue/round.mjs`, [SUE README](../sue/README.md#rounds-users-critics-and-a-target)): users plus
  critics, the users' stars and who finished against the plan's target, kept as a series, and the trend (met,
  improving, STALLED, early stop). `report` starts this door by itself once the round is in.
- **`--round-file <round.json> --hearing`** (`lib/round.mjs`): a hearing over that round with nobody re-sent. The round's
  report is `sue-report.json`, its numbers and the critics' drops are `round.log` (evidence the room reads), only the
  page's pulse convenes (`ROUND_KEEPS`), and the target line leads the evidence brief and `verdict.md`.
- **The design board.** After the review table sits, `designCall` asks whether the problem is design: a round whose
  trend says so (two rounds within `STALL_BAND` with no new best, or under half finishing), or a page whose SUE
  scoreboard stalled build over build. Then five minds sit as the design board (`pickMinds({ board: "design" })`: games,
  product design, attention, psychology, each lead field with a chair), and the resolution is `draftRedesign`: one
  redesign of how the thing works and plays, as where / now / after / why and what the next round must show, scored by
  that board (`DESIGN_PROPOSAL_SITTING`). No claims check and no Humanizer: a redesign is a brief for the builder, not
  copy for strangers; the owners' recorded rulings still bind it. The review table's own fix stays beside it.
- **A minds sitting fills five chairs.** `fillMinds` seats Jev's yeses, then a chair for each of a board's lead fields,
  then the strongest of the rest, never more than `FIELD_CAP` (2) of one field and never a mind under `MINDS_FILL_FLOOR`
  (0.2). Every mind skill names its `field:` in its SKILL.md front matter (play, product, attention, psychology,
  learning, growth, story, humor, life); `BOARDS` (design, educators) are sets of fields, never lists of names.
  `boardroom.mjs --board design|educators` seats a named board on any ask. The seat eval grades the minds room by the
  same rule (it graded six chairs the plane cannot seat).

## Code matters and opinion matters

The same message drew the line: "the architect is the architect - code is fucked, fix the code; files
are too big, make them smaller. When it comes to things that are not specifically code-related, run
through Jev." Every docket now says which it is (`MATTER:` on line two). A **code** matter (domain
code, data, infra, security) is the Architect's: a check's finding is a fact to fix, the room sits only
when asked. An **opinion** matter (copy, visual, flow, product) is Jev's end to end: which instruments,
which seats, and the visitors' words and the room's verdict decide - never a check's exit code.

A code matter that **names a path** always runs two instruments whatever Jev's yes said, the way a
named page always gets its pulse: the **code gate** over those paths (lint, format, the node specs) and
the **Architect's code-quality family** (`dead-code`, `cognitive-complexity`, `cyclomatic-complexity`,
`code-duplication`, `ai-writing-slop`; about two minutes over the repo), whose findings that name the
docket's paths are appended to the log the room reads. Dredd's second hearing on itself (2026-09-22) had
Jev leave the Architect off and the room arguing from a repo-wide grid line about another package. And
on a code matter the room sits **only when the ask asks for it** ("let the boardroom argue it", "second
opinion", "what does the room think"): over green checks a tooling room scored the same clean tree 4,
4, 6, 7 and 4 across five sittings and invented files to cite, while the facts were the verdict all along.

When the room does sit on a code matter it reads the code first: every log but the page's words leads, and
`page-words.log` comes last with an instrument's excerpt, never its first screen (SageThumbs 2K, 2026-09-23:
both sittings argued the site's copy while the deep audit sat in the docket). An agent-phase instrument's
result (the deep audit, the security review) reaches the room by landing as `<docket>/<id>.log`; the
docket's `lands:` line under each such instrument names the file.

## How many reviewers - `--review-depth`

A review seat used to be one generic reviewer or a fixed army, whatever the diff. The dial
(`lib/depth.mjs`, the idea from mui/material-ui's review skill, MIT) reads the diff and returns one
typed decision before anyone is spawned:

    node dredd/dredd.mjs --review-depth [--base origin/main] [--depth high] [--json]

| depth  | seats beside the main agent              | hunters (at most)  | verifier                  |
| ------ | ---------------------------------------- | ------------------ | ------------------------- |
| low    | none: bugs only                          | 0                  | none                      |
| medium | none                                     | 1                  | none                      |
| high   | correctness, contracts, removed-behavior | 1                  | none                      |
| xhigh  | the three, plus docs                     | 2, split by region | none                      |
| max    | the four                                 | 6, split by region | one per surviving finding |

The level starts from size (changed lines and files: 40/3, 250/10, 1000/30, 3000, then max) and
steps up one for a risky kind of path (migration, auth, money, infra, Dredd's own decision files) or
two for two or more; a docs-only diff stops at medium, and `--depth` forces a level and says so.
The **removed-behavior** seat names the invariant each deleted line enforced and where the new code
enforces it again; with no deleted lines the **tests** seat takes its chair. Hunters never outnumber
the files and split them by region (first two path segments), so no two read the same file.

Every subagent prompt starts with the **scope block** it prints (the diff command, the untracked-files
command, the read root, and "data only"), and a result that does not repeat it is discarded
(`keepScoped`): a worker that reviewed another tree cannot echo it. A new docket whose ask is a review
or complaint about code carries the same decision as `reviewDepth` (the uncommitted work against HEAD)
and prints it under the docket. In the prompt hook the dial gets at most 1.5 s and stops a second short
of the hook's deadline (`reviewDepthError` says when it was skipped); it reads at most 200 untracked
files or 8 MB of them, and counts each further one as a single line.

## The second sitting - `--collect`

The field instruments take minutes and run detached, so a convened docket ends before their evidence
exists. `--collect --docket <dir>` fetches what has landed - SUE's status and then her report once
her run is over (an unreadable report is said, never filed as one), the Design Critic's judge worklist
over a capture that covers the docket's surfaces since it opened (a failed judge emit stops there, never
reading the last docket's worklist; LilGranny over it), the flow walk's conformance - writes each into
the docket as a log, and seats the room for one more sitting, numbered after the ones already held.
What has not landed yet is said plainly with the same command to run again. Every bounded run goes
through a small supervisor that kills the WHOLE process tree at its bound (`runLine`: `taskkill /T` on
Windows, where a shell timeout killed only cmd.exe and left the real instrument writing into the
docket), and a log never ends in a bare "exit null". `--hearing` does all of this and the resolution
loop in one run; `--collect` remains the by-hand door.

## The brain - `lib/brain.mjs`

Every model call Dredd makes itself - the room's turns, ballots and secretary, the drafter, the
Humanizer, the vision score - goes through `askBrain`, which always rides HSwarm's tool-free ask
through one resident `lib/ask.py` per process (above); `DREDD_DRAFTER_MODEL`, `DREDD_DRAFTER_FALLBACK`
(comma-separated, empty turns the fallback off), `DREDD_VISION_MODEL` and `DREDD_VISION=off` steer the
drafter and rung two. A structured answer that
comes back as text is read by one parser, `structuredAnswer`: think blocks, a BOM and a fence are
stripped, one object (or copies of one) is the answer, two different objects are refused rather than
guessed between, and an object missing a key the schema requires is refused by name. An object opened
and never closed is the output cap, not a refusal: that call is asked once more with twice the room
(never past `RETRY_CAP`, 16,000), and the ledger row says `retried`.

**The `DREDD_BRAIN=opus` door - a sealed `claude -p` on Opus 5.5 under a CLI login - is retired.**
the Chair, 2026-09-23: "I never want you to use, like, the Claude code or the GPT code CLI. You can use
API keys I've given you or things like in the Z Swarm, but you're not allowed to use CLI logins."
`askBrain` itself never looks at `DREDD_BRAIN` at all, and Jev's typed items are always answered by
Jev, never a brain call.

## SUE, and the brain ladder

SUE declares `instance: Root/Connections` on the bench, so every launch takes the one instance route
(`runInstrument` in `lib/convene.mjs`, the same one the bill takes): the local MCP's `shell` with
vault-minted org credentials (value-blind, an hour at a time) when a hearing has the MCP open - so the
mailroom reads inboxes without a human's AWS SSO session on this PC. SUE itself learned to accept a
lease in the env (2026-09-22): the SDK prefers a named profile, so the cannon no longer names "main" on
top of one. `DREDD_SUE_AWS_INSTANCE` picks another connected account; `DREDD_SUE_VIA_VAULT=0` falls back
to the bare spawn and the profile, and the log's second line says it ran with no vault credentials.

**Which brain SUE's visitors think with:** Dredd decides it, and SUE is the elevated tier (the owner,
2026-10-05, replacing the 2026-09-23 Opus 5.5 ruling: "spin up the Sues moving forward as Sonnet 5.5, not Opus"; bench `tier`,
`INSTRUMENT_TIERS` in `lib/docket.mjs`). Convened from a chat (`--convene`), every Sue thinks on that
chat's own Sonnet 5.5 agents, one per Sue: the run starts on `--brain chat`, and the docket's `MODEL:` line
and the SUE row's note tell the chat to start them on model `sonnet`. When the account is short, the chat
drives fewer Sues, never Haiku or a pool model. There is no hourly cap on those agents any more, on any machine
(the routing gate lost it the same day), and the gate lets a Sonnet agent whose prompt names a SUE brief
through as `sue-elevated`. **A hearing a chat launches with `--chat` keeps her** (the Chair, 2026-09-25:
"Dredd should also pretty much always work with Sue and the Boardroom"): SUE and the focus group start on
`--brain chat`, `--status` prints `WAITING ON THIS CHAT - ...` with the brief list, the chat starts one Sonnet 5.5
agent per brief, and the hearing's field wait takes their reports to the room. A docket that sends visitors
names `--chat --detach` on its `Full hearing:` line. An unattended hearing without `--chat` has no chat to
start agents, so SUE sits it out unless
the chat that ran it pinned a key pool (below); a machine whose `~/.connections/sue-brains.json` excludes
the pools (the owner's PC) refuses even that pin. There is no CLI login anymore - the ruling above applies
here too, and `--doctor` counts the keys it finds.

The cannon refuses to start when its brain cannot think - the exact case Dredd hit
the first time it sent people through the landing page. Its two key-pool tiers are `--brain deepseek`
and `--brain openrouter`, and an unattended hearing uses them ONLY when `DREDD_SUE_BRAINS` names them
(comma-separated, in the order to climb): unpinned, the ladder is empty and the SUE row says to convene
from the chat or pin a pool on purpose. On a pinned ladder Dredd polls the run for that refusal and steps
down; a pin naming `claude` is refused by name, with the ruling. When nothing can think, the docket says so
in the first line and names the fix, never a runId that quietly did nothing. `DREDD_SUE_COUNT_PAID`
overrides the three Sues a hearing sends (capped at `DREDD_SUE_COUNT`, default five); a rung that refused
is remembered six hours in `tmp/dredd/sue-brains.json`. `DREDD_DEBUG` prints every refusal poll.

Four settings shape what the Sues are told (2026-09-25, the Deal Flow invite hearing). `DREDD_SUE_INTENT` is the
visitor's errand in their own words when the ask is the owner's complaint: without it SUE's intent is the ask cut to
300 characters, so "it feels AI-made" would prime the very people sent to test that. `DREDD_SUE_CREATE_ACCOUNTS=0`
keeps every Sue signed out, for a Connections page whose button spends a real, capped thing - a minted trial code
has `max_redemptions`, and each claim starts a live Stripe trial. `DREDD_SUE_LEGS` (2 to 5) is how many jobs the
errand holds, each on the visitor's own patience: a lesson a teacher set runs several parts, and a kid's one leg of two
minutes never reached the second (Lift, 2026-09-29). `DREDD_SUE_EXPECT` (or the docket's own `expect`) is what the
page is meant to be, told to every visitor so a page that is something else gets noted; it is never made up from the
ask, so with neither set the visitors are told nothing (2026-10-03). All four land in `sue-args.json` (`writeSueArgs`
in `lib/convene.mjs`), so the args file shows what they were told.

## Other codebases - `--root <repo>`

the Chair (2026-09-22): "I'll be able to run this on multiple code bases." `--root <repo>` judges another
checkout: its own `<repo>/.dredd/bench.json` and `<repo>/.dredd/seats/` when it has them, otherwise this
bench minus every instrument that repository cannot run - `runnableIn()` in `lib/docket.mjs` decides
mechanically (a runner under `{dredd}` is the engine's and travels, and so does one under `{connections}`,
which runs from the engine's checkout - page-pulse, and SUE, who needs a URL and nothing of the repository;
an instrument with `anyPage` stays while the engine carries its runner - the Design Critic, which scores
page-pulse's photographs of a page its wave cannot shoot; `bun run <script>` needs the script
in that repo's `package.json`; any other repo-relative file must exist there; an absolute or home path is
the machine's; agent and always instruments name a call, not a file) and `bench.filtered` records what
was dropped and why, which the docket prints on its `ROOT:` line. The docket lands in `<repo>/tmp/dredd/`;
the engine, Jev, the room, the seats, the local MCP loader and the claims inventory stay in this
checkout. `--doctor --root <repo>` says per instrument whether that repo can run it (`note`, never
`MISSING`). Proven on the zswarm checkout: ten Connections-only instruments off the bench, the docket
filed there. The MCP door takes `root` for the same thing.

A desktop app's UI (egui, Qt, WPF, SwiftUI, "desktop app": `NATIVE_UI_RX`) is not a page: no browser opens
it, so the `native-ui-no-visit` filter keeps the page field and the pulse home, no `--url` is demanded, and
the docket prints `DESKTOP UI:` - render the screens headless, list every string in
`<docket>/ui-strings.txt`, and run `strings-copy.mjs` over it into the docket (VectorMagik, 2026-09-23). The
deep audit there orients on that repository's own AGENTS.md, CLAUDE.md and README and grounds on its own
records (`scripts/deep-codebase-audit/deep-audit.mjs seed --root <repo>`), never on Connections' `.arkitect`.

## Improving the judge - `--hunt` and `ab.mjs`

The Architect's recursive self-improvement discipline, pointed at Dredd (the Chair, 2026-09-23); the rule is
[dredd-self-improvement.md](../../.claude/rules/dredd-self-improvement.md). `--hunt` reads the doctor, the last 60
dockets' `convene.jsonl`, the newest eval run (Jev's arm first), `eval/ab-ledger.jsonl` against `git log` over the
decision files, and the gold set against the bench, and ranks what to fix: a doctor MISSING, an instrument that failed,
one that exited 0 without the evidence its bench entry promises (the `{docket}/...` files and the repository files it
names), a decision change that landed unmeasured (one item for all of them, from the policy's first day), a gold ask
convened wrong, a room seating more than one extra critic per brief, an instrument no gold ask names, and one never
convened in 20+ dockets. `rankHunt` is pure (tests/rsi.spec.mjs).

`ab.mjs` materializes the base commit's `dredd` plus every file its own `eval.mjs` reaches by import (git
cat-file, no worktree), lends it this checkout's `.claude/skills` through a junction (the minds seat reads them), copies
the current gold over its own, and runs each tree's eval: the keyword arm always, and the replayed Jev arm when a saved
run exists and the base's eval knows `--replay` (an older one would ask Jev for real, so that arm is skipped and said).
The asks decide on every metric and every gold ask that flips; the seats decide per room, and a room the base never
seated in is its first measurement, not a slide. `--record` appends the row, `--accept "<why>"` records a regression on
purpose; exit 1 on an unaccepted regression. The first row (2026-09-23, base `828b322c6d~1`): 11 gold asks fixed, none
broken, domain 30 -> 37, exact dockets 27 -> 38 on the keyword arm.

Under each arm's verdict, `gold read` bootstraps the per-ask change over the asks both trees graded, against a dead
zone of one ask (`pairedVerdict` in `lib/regularizers.mjs`, ported from tester-army/e2e and shared with SUE's A/B). It
is shown and never decides: both arms are deterministic, so the exact rule above stays the gate, and an unresolved gold
read means the gold set is too small to say more, which only more gold asks of that kind narrow. Two lines follow it:
`full Jev eval: owed` when a bench or seat `jev` question changed (the replayed arm cannot see that; run
`node dredd/eval.mjs` and read it through the noise band), and `another full Jev eval: yes` only when an ask that
moved is on `eval/noise.json`'s unstable list. For a seat question the owed line also names the seat pick's and the
routing's bands (`seats`, per room and over all briefs: exact, sit, mustNot; `experts`, per unit: exact, lead, want,
extra), since the question seats the hearings and routes the homework: two rewrites of Grandma Sue's moved the seat
pick's exact 18 -> 14 and 18 -> 15 on 2026-10-10 with no band to read them through. `eval.mjs --noise 3` measures all
three halves (`partBand`), and every Jev run that graded the seats or the routing prints their moves through them.

## Did the build do what was asked - `--converge`

An agent's "done" is a claim, not evidence, so after a build step
`node dredd/dredd.mjs --converge --ask-file spec.md --tasks tasks.md --append` rules on the work itself. It lists
every requirement the ask states (explicit ids like `FR-001`, `SC-002`, `US1` win; otherwise each list item is `R1`,
`R2`...), reads `git diff <base>` (`--base`, default `HEAD`) plus every untracked file (never the ask file or the
tasks file themselves: they repeat the requirements word for word), and classifies each gap:
`missing` (no changed line carries the requirement's terms), `partial` (some, under 60%), `contradicts` (an added line
does what a "must not" forbids) and `unrequested` (a changed file no requirement's terms reach). A requirement the tasks
file ticks off with no evidence is named so. Each gap is one task line citing its requirement id or file; `--append`
adds them under a dated `## Convergence` heading and never twice for a gap still open. Exit 0 is converged, 1 is not:
build, rule again, until 0. The evidence test is lexical, so a finding is a lead to confirm, never a proof. The idea is
github/spec-kit's converge step (MIT), written fresh; `lib/converge.mjs` is pure (tests/converge.spec.mjs).

## The doctor - `--doctor`

Every prerequisite, named: node, bun, python, the hswarm package and its imports, the Jev key pool
(counted, never printed), the local MCP loader, the shared RPC client, the live word
counter, fairjob, Odin, playwright-core, SUE, the wave, the Architect, the seats, the bench, the hook
wiring, the SUE brain pools, and every bench runner (a file that exists, or a package script that
does). Non-zero exit when anything a hearing needs is missing, so a machine that cannot hold a
hearing says so before it pretends to.

## Recall - the memory lane

"Which memories does the AI need for this?" is a query, not a build: the agent memory lane is the
notes plane's **pgvector** store (Titan Text Embeddings v2, 1024-dim, HNSW, cosine -
`services/notes/lambda/src/agent-lane-memory-store.ts`), and since 2026-09-21 it holds every file of
`Lunarwerx/claude-memory` by (repo, slug), losslessly (the memory cloud cutover's last file check,
2026-10-03, found every file there or superseded by a newer store edit). Dredd calls `memory_search` for every docket and lists the strongest matches with their
cosine score, repo and last-written date. Search deliberately returns superseded memories too (a belief
that changed is the interesting part), so each row says `SUPERSEDED by <slug>` when it was replaced, and
the room hears those under "once believed, since replaced", never as something the fleet still holds. Recall
asks one question per facet (the ask's sentences, the page, each named path; `docketFacets`, `recallFacets`) and
merges on (repo, slug); a hearing asks again once the field lands (`fieldFacets`: where the Sues stopped, the rung
that failed, a broken page), so the room reads memories about where visitors actually died, not only the complaint.
The prompt hook cannot afford the local MCP's five-second spawn, so the MCP the chat is already running
recalls for it: a second UserPromptSubmit hook (`mcp_tool` -> `dredd_hook`, `lib/hook-recall.mjs`) runs
`memory_search` in-process and prints a `<dredd-memories>` block beside the docket; a recall that could
not run says why ("recall could not run (...)"), never "none matched".
A local MCP loader that dies at start fails in about 50 ms with its stderr, not after the full timeout.

**Which recall path finds the answer, for how many tokens** - `bun run dredd:recall-bench` (`recall-bench.mjs`,
`lib/recall-bench.mjs`) runs a hand-written set of known-answer questions (`eval/recall-bench/questions.json`)
through each recall path: a session's `memory_search`, the docket's facet recall, the prompt hook's `hookRecall` and
the `<dredd-memories>` block it prints (`hookMemoriesBlock`), and a grep baseline (`memory_search { contains }`). One
row per path: answer slug in the top 5, absent-answer questions left empty, median and worst-case tokens (characters
/ 4 of what the path hands its reader), median ms, failed runs (never graded). By default it runs against a SYNTHETIC
fixture (`eval/recall-bench/memories.json`) through a lexical stand-in for the lane, so the numbers reproduce and no
real memory enters the repo. `--live` runs the same set through this machine's local MCP, read-only: only the grep
baseline runs, because `memory_search { contains }` records no read, while every `query` hit RECORDS a read (it ages
`memory_prune`'s staleness and can ratify a tentative memory). The query paths (`memory_search`, docket, hook) run live
only with a second opt-in, `--live --record-reads`, and the header then says it writes to your store. With no MCP
configured, `--live` skips every path with its reason. Live, absent->none means nothing: the real lane always returns
its top-k rows. The questions are worded unlike the memory titles and some have no
answer at all (Leviathan's benchmark is a best case because every question names its entity), but the set is small
and hand-written: read it as a comparison between paths. `--verbose` lists each question's top slugs, `--json` the
numbers. Slugs and numbers only, never a memory body. An instrument, not a gate: it exits 0 whatever the scores, until
the owner sets a floor.

**The lane is the master copy** (Owner, 2026-09-22, relayed by the Chair: "the online memory store is
the master copy that we continue to update and manage", with the online team board beside it). A
memory is written to the lane first (`memory_search`, then `memory_save`); the files are the export
until the shared agent brain plan's P5 retires them, and the plan's owner call 4 carries the ruling
([SHARED_AGENT_BRAIN_PLAN.md](../../docs/architecture/ai/SHARED_AGENT_BRAIN_PLAN.md)). Recall already
reads the lane, so nothing in Dredd changed.

## Peers - the board and the mail

the owner's team board (every AI on the project, on every machine; claims, private threads; schemas
0056-0057) and this folder's mail, which since P2 lives on the same board (a post addressed to one
folder; the two-party message board of schema 0037 folded into it). Dredd reads `board_who`,
`board_read` and `board_read { box: "all" }` for every convened docket so a hearing
names the peer already on it, and `--announce` posts the convened docket back as an FYI. It also asks
`board_who { q }` with the docket's own ask, which searches every board of the account: when a live
agent's list or claims match, the PEERS line names that ONE agent and the `board_ask` that reaches it
alone, on its own project's board. the owner's own
AIs are heard on the Chair's board only after the Chair accepts them in Studio - a human click, which the
docket says plainly when it is missing.

## What Connections has - the catalog

Owner, 2026-09-23: Dredd is Connections' orchestration layer, so a docket names what Connections already
has for the ask, not only the bench. Every docket run from a chat (never the prompt hook, which cannot afford
the MCP) asks `connections_search_catalog` once with the ask and prints `CONNECTIONS HAS`:

- the local tools;
- the Script Vault instruments;
- the API endpoints this company reaches;
- the connectors. A connected one is named as live. One not connected prints the page a person connects it on,
  because the AI suggests a connector and never connects one (rail 2).

The search always answers something, so `lib/catalog.mjs` keeps only what the ask's own words fit: a whole-word
hit in the item's name, or three distinct ask words in its description, and a connector only on a name hit. An
ask nothing fits says so. `--no-catalog` skips it. The hosted follow-up (the docket as `connections_help { ask }`
for every Connections member, the bench derived from catalog metadata) is
[DREDD_ORCHESTRATION_LAYER.md](../../docs/strategy/DREDD_ORCHESTRATION_LAYER.md).

## Every docket, recorded and rated

Owner, 2026-09-23: "every single call with Dredd tracked and analyzed ... the same way we rate the prompts ...
was this the right tool used in Dredd afterwards, so we can learn and progress recursive improvements."

**Recorded.** Every new docket, through every door (the plain call, the prompt hook, `--convene`, a hearing), is
one `run` in the Connections scoring lane (`lib/lane-record.mjs`). The lane already scores the prompts injected
into a chat; a Dredd instrument is the same kind of thing, so each instrument is its own lane row
(`<connections workspace>|dredd|docket|<id>`) beside one row for the docket as a whole (`the docket`). That is
one row per instrument, not one per docket, so Studio lists the bench beside the hooks and the lane's own rule
quotes a badly rated instrument to the next chats of this workspace. The events go to
`~/.connections/lane/outbox.jsonl`, which the Connections MCP ships on its pulse, so the prompt hook records
inside its budget. They carry the decision (class, domain, scope, who decided, what was convened with its p,
the tier) and never the ask, which stays in `docket.json` on the machine that ran it. `docket.laneRecord` says
what happened: `queued`, `no lane on this machine`, or `not recorded: <why>` (a `node --test` run records only
into a lane the test names, `CONNECTIONS_LANE_DIR`, and so does a `bun test` run, which sets `NODE_ENV=test`;
`DREDD_NO_RECORD=1` records nothing). A docket is recorded the moment it exists, before any convene or hearing, so
one that throws or is stopped still counts. The session a docket belongs to comes from `DREDD_SESSION` (the prompt
hook passes it) or the chat's own `CLAUDE_CODE_SESSION_ID`, which a sub-agent shares with its parent chat, so a
sub-agent's docket is the parent's to rate; `~/.connections/lane/dredd/<session>.json` lists that session's
dockets, which is how the reflection finds them. A docket with no session is filed as its own chat. `DREDD_DOOR`
names a door that is not one of the four (the MCP door sets it).

**Rated.** The lane's Stop hook lists the dockets a chat received and has not rated: a new one once at the end
of the turn it arrived in (its work may still be running, so it may be skipped), and whatever is still unrated
once more at the chat's scoring turn or reflection. The chat answers one line each, naming the docket by the
folder the hook prints (an id works too when the docket lives under this checkout):

```
node dredd/dredd.mjs --rate <folder> --score 1-5 --right a,b --unneeded c --wrong d --not-run e
     --missed f [--missing-tool "<what>"] [--class <c>] [--domain <d>] --note "<why>" [--gold "<the ask, reworded>"]
```

Every convened instrument gets exactly one choice: **right** (the correct call), **unneeded** (it fit but added
nothing), **wrong** (it did not fit the ask), **not-run** (skipped; says the docket was not followed, never that it
chose badly). `--missed` names bench instruments it should have convened, `--missing-tool` what no instrument
does. `--score` is the docket as a whole: 5 = exactly the right instruments, 3 = a mix, 1 = the wrong tools
altogether (1 and 2 are "hurt", 3 "harmless", 4 and 5 "helped"; never "na", which the lane leaves out of every
mean). A note is required at 3 or lower and on anything wrong, unneeded or missed (`lib/verdict.mjs`). The lane
gets the chat's score on the docket row and a score per instrument (right 4, or 5 on a 5 docket; unneeded 3;
wrong 2; not-run none), one per chat per row, the latest winning. A re-rate that finds nothing wrong takes back
the verdict row an earlier rating wrote.

Trying `--rate` by hand on a real docket writes a real rating, and a sub-agent's is its parent chat's: a review's
skeptics checking the re-rate path on 2026-09-24 left three test votes on the boardroom and marketing-council rows as
the chat that ran them. Try it with `CONNECTIONS_LANE_DIR` and `DREDD_VERDICTS_DIR` set to a scratch folder, as
`tests/verdict.spec.mjs` does.

**Learned.** A docket that convened something wrong, missed an instrument or misread the class or domain
becomes `eval/verdicts/v-<id>.json` in the gold asks' shape (`DREDD_VERDICTS_DIR` moves it, for the specs). Its
ask is `--gold`, the chat's own rewording: required, and refused when it repeats eight words of the ask in a row,
because a dictated ask can hold private detail and a paraphrase is what tests the judge rather than one sentence.
Chat-labelled rows are a column of their own, never merged into `eval/asks.json`, whose rule is that no model
writes a label. `node dredd/eval.mjs --verdicts` grades Dredd against them, so a change to a bench question
or a bar is measured on the mistakes real chats reported. `node dredd/eval.mjs --ratings` is the look back
(`lib/ratings.mjs`): every docket this machine filed, how many were rated, per instrument right / unneeded / wrong
/ not-run / missed, the missing tools, and what to fix (called wrong twice: it over-fires; missed twice: it
under-fires).

## A bug docket: the repro, and a fix ruled verified, partial or failed

An agent calls a fix done because the tests are green while the symptom the person reported was never run again.
A docket that reads as a bug complaint (a bug word - crashes, throws, broken, fails, not working, a regression -
on anything but a decision, and on a build only when it asks to fix something; `lib/bug.mjs`) carries `bug`: the
repro it heard in the ask (a command in backticks, or the "when I click save" clause) and a `BUG:` block that
says how its fix will be ruled. When the ask states no repro, the block says to write the steps down before the
fix. The fix is then ruled on three rungs, never in free text:

```
node dredd/dredd.mjs --rule-fix <folder or id> --repro "<what you re-ran, what it showed>"
     --repro-result gone|still|not-run --tests pass|fail|none
```

**verified** only when the original repro was re-run and the symptom is gone (and no test is red); **failed**
when the repro still shows it or a test is red; **partial** otherwise - and green tests with the repro not re-run
are always partial, said as a downgrade. `--repro-result gone|still` without a `--repro` of three words or more is
refused (exit 2): a repro claimed as run must say what ran. The ruling is kept in `docket.json` as `fix` (a
re-rule overwrites it and keeps the earlier verdicts in `fix.history`), and the docket prints it as `FIX:`. It
changes nothing the docket convenes. The idea is github/spec-kit's bug extension (MIT), written fresh.

A typed repro is still a claim about what ran. The executable form runs it instead, and sets `--repro` and
`--repro-result` from the run (giving either beside it is refused):

```
node dredd/dredd.mjs --rule-fix <folder or id> --repro-file <repro.mjs> --tests pass|fail|none
node dredd/dredd.mjs --rule-fix <folder or id> --repro-check "<command>" --tests pass|fail|none
```

`--repro-file` is a script that asserts the RIGHT behaviour, run through `sue/repro.mjs run` under node: its
assertion failing is `still`, a pass is `gone`, and any other error (a missing control, a timeout, a crash) is a
broken repro, which re-ran nothing and rules as `not-run`. `--repro-check` is any command, run in the current folder:
exit 0 is `gone`, anything else `still`. What ran is kept beside the ruling as `fix.executed` { form, target,
result, why }. The claim-to-bug rule is tester-army/e2e's bug-bash reference (Apache-2.0), written fresh; SUE's
side of it is [sue/README.md](../sue/README.md) § Repros.

## Delegation - the HSwarm verdict

Every docket carries the tier Jev picked: **hswarm** for mechanical, per-item, checkable work;
**opus_lean** (an Opus 5.5 lean sub-agent) for a task that needs this repository's own harness; **flagship** for architecture,
subtle code, synthesis and owner-facing judgment; **mixed** when the flagship judges while the swarm
sweeps. It is advice to the session; the `agent_routing_gate` hook remains the enforcer.

## What it writes

`tmp/dredd/<stamp>/docket.json` (everything: answers, confidences, paths, memories, peers, results,
what was collected and when), `docket.md`, one `<instrument>.log` per convened instrument (and
`arkitect-named-paths.log` on a code matter that names paths; the copy checks and LilGranny also write their
Architect manifest into `copy-audit/` and `lilgranny/`, which is what rungs three and five are graded from), `boardroom/` when
the room sat with its `transcript.md`, `minutes.json` and `calls.jsonl` (and `boardroom-<n>/` plus
`boardroom-<n>.log` for every sitting a later one archived).
The field adds `page-pulse.json` and `page-words.log` (the page's own words, first screen first),
`page-headlines.log` (its h1-h3 and calls to action), `page-desk.png` and `page-phone.png` (the whole page),
`page-desk-NN.png` and `page-phone-NN.png` (the viewport slices rung two scores),
`sue-args.json`, `sue-<brain>.log` per brain rung tried, `sue-report.json` and `sue.log`, `adhoc.txt`
for an off-roster capture, `design-critic.log`, `design-critic-vision.log`, `design-critic-vision.json`
and `vision-calls.jsonl` (rung two's labelled score), `lilgranny.log`, `flow-walk.log`.
A hearing adds `hearing.log`, `hearing.json`, `verdict.md`, `ladder.json`, `evidence-brief.md`,
`seats.json`, `jev-calls.jsonl` (the seat pick's spend), `proposal-<n>.md` and `resolve-calls.jsonl`; a detached one
also `detached.out` and `ask.txt`.
`--json` prints the docket object; `--out <dir>` chooses the directory; `--skip a,b` leaves an
instrument on the docket but does not run it this time.

## Files

```
dredd/
  dredd.mjs          the judge (node): decide → recall → peers → convene → collect → file the docket
  boardroom.mjs      the Boardroom of critics (bun): a real meeting on the Connections Boardroom, our seats as its board members, our brain answering, then the silent ballot; two rooms
  eval.mjs           the judge measured: the gold asks (classifier p and what is convened), the gold seat briefs, the ballot's void rule, the routing pass
  ab.mjs             the A/B every decision change owes: the base's decision code (from git, no worktree) against the working tree's, same gold, same saved Jev answers
  review.mjs         the code review: one change, the reviewers its paths call, the Standards and Spec axes side by side, one verdict
  strings-copy.mjs   the copy checks over a desktop app's strings file (a docket's DESKTOP UI path): the AI-writing tells and the word-economy loop, imported from the Architect's engines
  recall-parity.mjs  does the prompt hook's recall answer inside its budget: ten recorded asks through hookRecall over one MCP, timed against DREDD_HOOK_BUDGET_MS (3.5 s, in 26c-tools-dredd.mjs); exit 1 on a miss
  recall-bench.mjs   which recall path finds the answer, for how many tokens: known-answer questions through every recall path, hit@5, median and worst tokens, median ms; synthetic by default, --live read-only (grep only; --record-reads adds the query paths); never fails on a score
  follow-burndown.mjs  the burn-down follow-through: a docket item reopened by a later hearing goes back to its builder with its NEXT lines (4man instrument)
  bench.json         the roster - add an instrument here
  eval/asks.json     the gold asks
  eval/seats.json    the gold seat briefs (who should sit on each), product and tooling rooms, some held out
  eval/ballots.json  the gold quotes for the ballot's void rule
  eval/dismissals.json  the gold dismissals: a review finding, what the person dismissing it said, and whether a checker keeps or refuses it (eval.mjs --dismissals-only, free)
  eval/ab-ledger.jsonl  every A/B verdict, one row each (ab.mjs --record); the hunt reads it against git
  eval/recall-bench/  the recall bench's hand-written questions and the synthetic memories they run against
  seats/*.json       who sits where: each critic's name, rooms, Jev question and keywords (their words are Connections board members)
  reviewers/*.md     the code-review roster: reviewers/shared.md (every reviewer's preamble), standards.md, spec.md, security.md, judge-and-checks.md
  reviewers/escalate.json  the findings a dismissal never takes alone (auth, a public contract, a wire schema), each with the owner who decides
  lib/review.mjs     the roster pick (`@ref glob:`), the diff split per reviewer, the coordinator and its rubric, the report (pure, tested)
  lib/docket.mjs     the pure decision (questions, heuristic, BARS, paths, convening rules, shellArg and fillRun, the bench for a --root, rendering)
  lib/pipeline.mjs   the filter and score stages an instrument passes: each veto a named FILTER with its reason, the scope's bar (pure, tested)
  lib/claims.mjs     the claims check over a proposal: offer words, numbers, capabilities against the page and the inventory, and the page's recorded rulings (pure)
  lib/rulings.mjs    a page's recorded rulings: host -> plane router -> route component -> its ⛔ header paragraphs (the drafter reads them) and @ruling-retires / @ruling-keeps lines (the claims check enforces them)
  lib/jev.mjs        the Node door to Jev: hswarm_decide on the shared HSwarm server (ledgered), no Python process
  lib/jev-retry.mjs  the eval's retry for Jev calls that timed out (asked again at 4, twice; still unanswered = not graded)
  lib/brain.mjs      every model call: the resident hswarm worker; closeBrain. Every call goes through HSwarm
  lib/ask.py         the resident worker: one JSON spec per stdin line, answers tagged by id, concurrent (no command-line length limit)
  lib/connections-board.mjs  the seats as Connections board members (found by name, words from the persona store, derived words pushed free) and the room they sit in
  lib/ballot.mjs     the silent ballot: groundedIn, the lower median of two or more valid ballots, the split, the ladder's ceiling, an earlier fix reversed (pure)
  lib/vision.mjs     rung two's labelled vision score over the docket's surfaces, settled
  lib/mcp.mjs        one local-MCP process per docket (memory_search, board_*)
  lib/recall.mjs     the lane (pgvector) and the local full-text fallback (the judged repo's own memories included)
  lib/recall-bench.mjs  the recall bench's paths, the synthetic lane over the fixture, the grading and the report (pure)
  lib/peers.mjs      the team board and this folder's mail on it
  lib/convene.mjs    now / detached / agent execution, logs, fairjob (the line travels as DREDD_DETACHED_ARGS / DREDD_DETACHED_CWD), the SUE brain ladder, the wave's adhoc spec
  lib/collect.mjs    runLine (bounded, the whole tree), sit() and nextSitting(), collecting the field's evidence; a room whose every
                     hswarm route rests on a rate limit (ask.py --capacity) waits for the soonest key, at most DREDD_CAPACITY_WAIT_S
                     (default 1800 s) on its own clock, and otherwise files "capacity: ..." in place of a score
  lib/sue-status.mjs the one reader of a SUE run's status and the one rule for "over"
  lib/visitors.mjs   who SUE sends: the visitors cast from the ask and the page before anything convenes (the HSwarm brain, else the visitor the ask names)
  lib/dockets.mjs    the docket history door: find, reopen and resume past hearings from each docket's own records only
  lib/earlier.mjs    what the last hearings of the same page ruled, for the room hearing it again (a leaf: fs and path only)
  lib/hearing.mjs    the whole hearing unattended: wait → collect → ladder → seats → sit → resolve → verdict.md, and the bill
  lib/burndown-follow.mjs  the follow lock and hold for one page: commands keep each other's builds, a built record refuses one older than the item's recorded build, twin-claim items keep their own status
  lib/seats.mjs      the rooms, the house brief (houseFor), the seat roster, loadSeats, Jev's seat pick (pure, tested)
  lib/repo-facts.mjs another repository's stack and real files, the house its room reads (tested)
  lib/ladder.mjs     the page ladder and the code-or-opinion split (pure, tested)
  lib/depth.mjs      the review depth dial (--review-depth): seats, hunter cap, verifier policy, and the scope block (pure but its one git read, tested)
  lib/resolve.mjs    the drafter (Gemini 3.8 flash by default, the next model when one answers nothing), the Humanizer pass (afters and headline only), roomHappy and the stop rule, the proposal render; draftRedesign and renderRedesign, the design board's redesign
  lib/round.mjs      a hearing over a SUE round that already happened (--round-file): applyRound, the round's target line and log, designCall (a stalled or early-stop round, or a stalled page, goes to the design board) and the design board's question
  lib/doctor.mjs     every prerequisite, named
  lib/hunt.mjs       Dredd's own ranked self-improvement queue (--hunt) and DECISION_PATHS, the files that owe the A/B
  lib/hillclimb.mjs  what a hillclimb on the eval needs: grader stability, the model ladder, the headroom rule and the stall mode (pure; eval.mjs and the hunt read it)
  lib/converge.mjs   the convergence ruling (--converge): the ask's requirements against the diff, gaps as traced tasks (pure, tested)
  lib/lane-record.mjs  every docket and every rating of one, queued to the Connections lane's outbox (one row per instrument)
  lib/verdict.mjs    a chat's rating of one docket, checked, and the verdict row a wrong docket becomes (pure)
  lib/price.mjs      the Price check's pricecheck CLI path and the claim a wrong price rating sends to pricecheck's feedback, best effort: a failure is noted and the rating stands (tested)
  lib/bug.mjs        a bug docket's repro and its fix ruled verified, partial or failed (--rule-fix; pure)
  lib/ratings.mjs    the look back: coverage, per-instrument right / unneeded / wrong / missed, what to fix
  lib/routing.mjs    the zero-token routing pass: the bench's own lines as TF-IDF vectors, collisions, each gold ask ranked, the blinded rewrite brief and holdout verdict
  lib/regularizers.mjs  RRSI's screens: lines lifted from the gold (the A/B's overfit screen), the noise band (eval.mjs --noise) for the asks, the seat pick per room and the routing per unit (partBand), a run read against the last and the best through it; pairedVerdict, a seeded bootstrap read against a dead zone (better, worse, same or unresolved), shared with SUE's A/B
  eval/verdicts/*.json  the dockets chats rated wrong, as test cases (`eval.mjs --verdicts`)
  lib/shared-root.mjs  where the shared checkouts (Odin) live: this checkout's sibling, then D:/NEWProjects/shared (HSwarm is an installed package; ask.py imports it)
  tests/*.spec.mjs   node --test, no network: docket, door (the command line, quoting, the hook, recall, keywords), hearing,
                     sitting, resolve, collect, room, eval-gate, brain, docs (this README against the code), rsi (the hunt, the A/B, the hooks' gates),
                     earlier (a page heard again, and a sitting too thin to rule), verdict (record and rate),
                     converge (the convergence ruling and its door), review (the roster and the coordinator),
                     bug (the repro a bug docket heard, and --rule-fix's three verdicts)
dredd/hooks/dredd-docket.mjs                 the prompt hook (a project wires it; Connections through .claude/hooks/sue-dredd-hook.mjs)
dredd/hooks/dredd-checkpoint.mjs             the checkpoint hook: a landing people will see, sampled (DREDD_CHECKPOINT_MINUTES, DREDD_CHECKPOINT_MAX)
.claude/rules/dredd-self-improvement.md      the RSI rule: the loop, the hunt, the A/B policy
services/studio/local-mcp/src-impl/26c-tools-dredd.mjs   the MCP door (`dredd`)
docs/how-to/DREDD.md                          the canonical doc
.arkitect/runners/page-pulse.mjs              rung one, the Architect's: one headless load of the named page, sound | wobbly | broken | unmeasured
.arkitect/runners/code-gate.mjs               the Architect's: lint + format + the node:test specs over the named paths, in the working directory's repo
.arkitect/runners/delivery-ledgers.mjs        the Architect's: the operator's own rows in four send ledgers, under the Studio host instance
```

## Two front doors - the Architect measures, Dredd judges

the Chair, 2026-09-22: "My goal is to start consolidating these tools into roughly two planes, DREDD and
the Architect ... if it's pretty much deterministic, does it go to the Architect or does it go to
DREDD? Because if it has opinions and stuff being asked, it should go to DREDD."

So every instrument carries a `plane` in `bench.json`, and the test is one question: could a script
decide the answer? **architect** - yes: same input, same answer (a check, a runner that loads a page
or walks a flow, a lookup). **dredd** - no: it needs a model's, persona's or critic's judgment (SUE's
visitors, the Design Critic's score, the room). **shared** - the plumbing every docket uses (recall,
the board, HSwarm, quota). A code matter goes to the Architect without the room ([Code matters and opinion matters](#code-matters-and-opinion-matters)).

Dredd stays the front door for any complaint: it hands the measuring to the Architect and keeps the
judging. It is a catalog and a router, never a merge of codebases: Odin and HSwarm stay their own
repositories, SUE and the critic stay where their owners keep them, and a tool that is not on the bench
is the only kind that is scattered.

## Adding an instrument

One entry in `bench.json`: `id`, `name`, `plane` (architect when a script could decide the answer,
dredd when it needs a judgment, shared for plumbing), `judges`, `when`, a `jev` question that ends in `?`,
`keywords` (a whole word matches with its plain inflections; end one in `*` for a stem), `domains`,
`phase`, `mode`, `run` (templates `{dredd}` `{connections}` `{sue}` `{pagePulseRunner}` `{arkitectCli}` `{codeGateRunner}` `{docket}` `{url}` `{ask}` `{checks}` `{surfaces}` `{planes}` `{term}` `{repo}` `{pricecheckCli}`
`{sueArgsFile}` `{paths}` `{adhocFile}` `{adhocName}` - each filled in as ONE shell argument; `{connections}` is the
configured target checkout, not this tool's code. `{repo}` is the repository the docket judges, and `{pricecheckCli}` is the pricecheck CLI (`PRICECHECK_CLI`, else this repo's own `pricecheck/`). `{dredd}` and `{sue}` name this repository's own runners; the other runner placeholders come from `targets/<name>.json`), optional
`then` / `needs` / `checks` / `checksByDomain` / `runAdhoc` / `instance`, `cost`, `evidence`, `doc`,
`owner`. A new deterministic instrument is built where the Architect's runners live (`.arkitect/runners/`), never
in `dredd/lib/`. Then add one
paragraph to the instrument's own README naming the bench, and an ask to `eval/asks.json` that
should convene it. `node --test dredd/tests/docket.spec.mjs` checks the shape;
`node dredd/eval.mjs` checks the judgment.

**Adding a seat** is one file in `seats/`: `id`, `name`, `seatTitle`, `brief` (or `briefFrom`), `playbook`,
`rooms`, a `jev` question that ends in `?`, and `keywords` for the day Jev is unreachable.
`tests/hearing.spec.mjs` checks the shape.
