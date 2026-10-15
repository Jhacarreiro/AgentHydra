---
title: SUE tape - on-disk format (sue-tape/1)
summary: What a SUE tape holds, screen by screen, how it fills as Sues reach it (read-through), and how the student panel walks a site with no browser.
owner: sue
updated: 2026-10-07
---

# SUE tape: on-disk format `sue-tape/1`

A tape is one folder. The recorder (`sue/tape.mjs record`, code in `tape/record.mjs`) writes it; the student
panel reads it and nothing else. Every screen was read on a settled page (Chrome virtual time, see "settle"), with
the same `INVENTORY_SCRIPT` the live body runs (`sue/lib/perception.mjs`), so `perceive(screen.inventory,
persona)` gives a student exactly what a live Sue with that persona would see on that screen.
`node sue/tape.mjs selftest` proves that claim against the live body.

A tape fills as Sues reach it, never crawled up front (Lift `docs/TAPE-PANEL.md` section 1, 2026-10-03): a move the
tape has no answer for is played live and saved (see "Read-through"). `tape.mjs record` is only the selftest's recorder
and an explicit, bounded crawl.

```
<tape>/
  manifest.json        the tape: where it started, the devices, the stats, what made each screen
  edges.json           every move tried: from a screen, by a control, to a screen (or why not)
  screens/<id>.json    one screen: its inventory, controls, URL, the walk that first reached it
  screens/<id>.png     its screenshot: the viewport only, CSS pixels
  visits.jsonl         every Sue's arrivals (written while Sues run)
  changes.jsonl        every stale screen re-recorded, with the picture diff (written by the recorder)
  changes/             the diff pictures changes.jsonl names
  recorder.lock        who is the tape's recorder right now (exists only while one runs)
  recorder.json        where that recorder listens (loopback port and token; exists only while one runs)
  recorder.log         what the recorder did: started, browser-launch, play, exit
```

## Screen id

`id` = the first 16 hex characters of the sha256 of the screen's inventory as canonical JSON (keys sorted,
`undefined` dropped) with every `id` key removed. The removed keys are the `data-sue-id` stamps (`sue-<n>`), which
depend on how many looks the walk took, not on what the screen is. Two walks that end on the same screen at the
same device get the same id, so screens are deduped by it. Device is part of the inventory (`viewport`), so a phone
screen and a desktop screen never share an id.

Before hashing, the start's origin (`manifest.startUrl`'s scheme, host and port, e.g. `http://127.0.0.1:61412`) is
cut from every string in the inventory, so a URL on it hashes as its path (`/s?n=2#/play/1`). A local server that gets
a new port each run (a config's `start()` on port 0) records the same ids, and a tape is reused across rounds. URLs
off the start's origin hash as they are. `inventory` and `url` themselves are stored as read, port included.

## `screens/<id>.json`

| key         | what it is                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | the screen id above                                                                                                                                                                       |
| `device`    | `phone`, `chromebook` or `desktop` (see `manifest.devices`)                                                                                                                               |
| `url`       | the page URL when it was read                                                                                                                                                             |
| `title`     | `inventory.title`                                                                                                                                                                         |
| `depth`     | moves from the start on the walk that first reached it                                                                                                                                    |
| `steps`     | those moves, each a move object (below), in order: replaying them from `start` reaches the screen                                                                                         |
| `pathKey`   | `device@start > move > move ...` (`start` as in `manifest.starts`), the walk's name; the same walk has the same pathKey on any tape                                                       |
| `start`     | the start URL (relative to the tape's origin) the walk began from                                                                                                                         |
| `parent`    | the id of the screen the last step was taken on, `null` for a start screen                                                                                                                |
| `inventory` | exactly what `INVENTORY_SCRIPT` returned on the settled page, stamps included (`blocks`, `elements`, `url`, `title`, `viewport`, `scroll`, ...)                                           |
| `controls`  | what can be done here, one entry per control (below)                                                                                                                                      |
| `settle`    | `{ virtualMs, timedOut, stillMoving, midAnimation }`: virtual ms the page ran before the read; `midAnimation` true only if a finite animation still ran                                   |
| `stamp`     | the config's `stampOf(screen)` when the recording saved the screen: a hash of the files it was made from; omitted without a `stampOf`. The body loads `manifest.config.file` and compares |

### A control

`{ key, sueId, role, name, href?, rect, form, required, kind, inputType?, option? }`

- `key`: `role:name@href`, where `href` on the start's origin is its path relative to that origin (`/s?n=2`, any
  port gives the same key) and any other address is absolute; plus `#n` for the n-th control with the same words on the screen, plus `=choice` for one
  choice of a list. It names the same control on any tape; edges use it.
- `sueId`: the element's `data-sue-id` in `inventory.elements`.
- `form`: the index of its `<form>` on the page, `-1` for none; `required`: the box must be filled.
- `kind`: `tap` (tapped as a move), `choose` (one choice of a `<select>`, `option` is its label), `field` (typed into
  as part of a move, never a move itself), `offsite` (a link off the allowed hosts, never followed), `leaves`
  (`mailto:`, `tel:` and the like), `disabled`.

Hidden, covered and behind-a-dialog elements are not controls (a live Sue cannot reach them either); they stay in
`inventory.elements`.

### A move (in `steps`)

`{ key, sueId, kind, role, option?, typed?, variant? }`. `typed` lists what was put in the form's boxes before the
tap: `{ key, sueId, role, value }` for a box, `{ key, sueId, role: "checkbox", check: true }` for a required tick.
When the config gives a box several values (a right and a wrong answer), each value is its own move, numbered by
`variant`.

## `edges.json`

An array, one entry per move tried on a screen, in the order they were recorded:

```json
{
  "device": "phone",
  "from": "<id>",
  "move": "button:Next~1",
  "control": "button:Next",
  "variant": 1,
  "typed": [{ "key": "input:Your answer", "value": "7" }],
  "to": "<id>"
}
```

- `move`: the control's key, `~variant` when it has several. `to`: the screen it led to (may equal `from`: a tap
  that changed nothing).
- `to: null` with `error`: the move failed (the control could not be tapped); with `dropped: "max-screens"`: the tape
  was full; with `offsite` or `leaves`: a link that was never followed, its address as the value.

## `manifest.json`

| key              | what it is                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `format`         | `"sue-tape/1"`                                                                                                       |
| `recordedAt`     | ISO time                                                                                                             |
| `startUrl`       | where every walk began                                                                                               |
| `devices`        | per device: `{ as, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent? }`, the body's own context options    |
| `starts`         | per device, per start: `{ phone: { "/": id } }`, the start URL relative to the tape's origin and the screen it opens |
| `config`         | `{ file, sha256 }` of the `--config` module, or `null`                                                               |
| `settleBudgetMs` | virtual ms per settle budget                                                                                         |
| `limits`         | `{ maxScreens, maxDepth }` (max screens is per device)                                                               |
| `stats`          | `{ screens, edges, followedEdges, walks, midAnimation, settleTimedOut, wallMs }`                                     |
| `screens`        | per id: `{ device, url, depth, pathKey, settle }`                                                                    |

## Starts

A tape keeps one start screen per device **and per start URL**, because a real round seats every Sue at her own URL
(Lift's class round gives each student her own demo seat). `manifest.starts[device][relativeUrl]` is the screen that
URL opens, the URL made relative to the tape's origin, so a live site and a local copy of it share a start. A Sue begins
on the start of her own target URL (`target.startUrl`). A start the tape does not have is played live by the recorder
(the one place a URL is opened: arriving at her entry point is how every visit begins) and saved. A tape of the older
one-start-per-device shape (`starts: { phone: "<id>" }`) is refused with a message to record it again.

## How a screen was read (settle)

Each walk runs in a fresh browser context and replays the screen's steps from the start; a screen is never reached
by opening its URL, since state a walk builds in memory or localStorage (a quiz's score) is gone on a fresh load. It
runs with the body's own context options, init scripts and Sue marker for the device. Before a read, the page runs on Chrome's virtual clock (`Emulation.setVirtualTimePolicy`,
`pauseIfNetworkFetchesPending`, budget `settleBudgetMs`): every timer, transition and animation it started runs to
its end, network replies pause the clock so none is outrun, and up to three extra budgets are granted while a
finite animation still runs. Moves and navigations run on the normal clock. A looping animation (a spinner) never
ends and is not waited on, the same rule as the live body's look. After the load and after each budget the clock
is released for two real animation frames: an animation that has not yet painted its first frame never advances on
virtual time, so without them a page could be read mid-slide.

Known limit: on a phone (a mobile layout viewport) a slide that moves content past the right edge can widen the
layout viewport for good, and whether it does is a race in Chrome, not a property of the screen. The tape records
`inventory.viewport` as read; a target that slides sideways may then read wider than the device on one walk and not
another. Slide vertically or clip the overflow (`overflow-x: hidden`) to keep a phone tape stable.

## `visits.jsonl` (with running Sues)

`<tape>/visits.jsonl`: in the TAPE folder, which every Sue of a round shares (never a Sue's own folder). One JSON line per
arrival on a screen, each `{ round, sueId, runId, device, at, screen, how }`; `screen` is the screen id and `how` is:

- `tape`: she arrived on the screen from the recording (her start, a recorded tap, back or forward)
- `recorded`: she tapped, the tape had no answer (no edge, or the screen or its target was stale), and the recorder played
  it live and saved it; `screen` is the screen she reached, which she was answered from as if it had been on the tape
- `no-edge`: she tapped on `screen` and the tape has no recorded answer for that tap, and it could not be played live
  (no site, no browser, a screen the recorder could not reach); she is told off-tape
- `stale`: `screen`'s stored `stamp` no longer matches `stampOf(screen)` now, checked on arrival and again before a tap
  from it. When the move could be played live it is re-recorded (and the row that follows is `recorded`); when it could
  not, she is told off-tape

`round` is the sue.json's `round` when it is a whole number, else `null` (the round's number is assigned when it is
reported, so a running Sue usually has none). Each row is one `appendFileSync` of one line, so Sues never interleave.
`node sue/tape.mjs coverage <tape> [--round N]` folds the log: screens on the tape, screens visited, misses by
reason (`recorded` counted with them), screens never visited.

## Read-through: how the tape fills

The tape is a read-through cache. A tap the tape cannot answer (no edge for the control, a typed value no variant
matches, or a screen whose stamp changed, either the one she is on or the one the edge leads to) is played live by the
tape's recorder and saved, so the next Sue making the same move from the same screen is answered from the tape with no
browser. A move to a screen already recorded and fresh is not played again.

- **One writer, few browsers.** Several Sues share a tape, each in her own process. The first miss claims
  `recorder.lock` (created with an exclusive flag) and starts `tape/recorder.mjs`, detached and headless; the others read
  `recorder.json` and talk to it over loopback TCP. The recorder owns the tape's browsers (one per device, launched on
  its first play) and is the only writer of `screens/`, `edges.json` and `manifest.json`, each written to a temp file
  and renamed. It exits after 60 s with no request (`SUE_TAPE_RECORDER_IDLE_MS`). A lock whose owner is gone is taken over
  by the next miss, so a recorder that died does not block the next round.
- **How a move is played.** The live page is put on her screen by replaying her screen's path from the tape's start (the
  `steps` the tape already holds, named by `pathKey`), each step bound to the live control with the same `key`, never by
  opening a URL. A screen that cannot be reached exactly (a step finds no control, a step fails, or the screen reached is
  not the one she is on) is answered off-tape with the reason `unreachable`; a screen is never guessed. The path starts
  at the screen's own `start`, so two Sues on different seats who tap the same control never share an edge.
- **A failed tap is an answer.** A tap the live page would not take is saved as an edge `{ ..., to: null, error }`, as
  `record` writes it, and the next Sue making it is answered from the tape. An `unreachable` replay is not saved.
- **A play has a deadline.** One that does not finish in 120 s (`SUE_TAPE_PLAY_DEADLINE_MS`) is answered `timeout` and
  its device's browser is closed; a play whose Sue has hung up stops counting, so the recorder's idle exit always comes.
- **What is saved.** The screen reached and the edge to it, exactly as `record` writes them: the stamp from `stampOf`,
  ids and link keys relative to the start origin. A stale screen re-recorded replaces the old one (its files, its edges
  out, and the edges into it are repointed), and the old and new pictures are compared (`tape/changed.mjs`).
- **A single-variant control is lenient.** A control recorded with one variant takes any non-empty value in its boxes,
  since the recorder only ever tried one answer; a move she makes with a different value is answered by that edge.
- **When it cannot play.** With the site down, no browser that starts, or a tape full for the device, she is answered
  off-tape as before, and the trace row's `offTapeReason` names why: `no-browser`, `no-site`, `no-recorder`, `unreachable`,
  `start-failed`, `timeout`, `tape-full`. A recorder whose browser cannot start leaves no process running.

**No path replay.** The tape caches screens, never a Sue's moves. A replayed path would write the looks a round scores
(her `finished` is a `doneWhen` read off her own looks) and skip the screens under test. Measured 2026-10-07 on lift-v2
rounds 16-18 (24 visits, 917 moves): 83% of moves re-walked a screen an earlier Sue of the same persona had passed, but
none sat on a path an outside check confirmed (no `repro.json` or `course-score.json` in any run on disk), the decision
files changed between each of those rounds, and the only moves outside the test were the setup before a Sue leaves her
start route (2.2 a visit, 5.8%). The idea was tester-army/e2e's step cache (Apache-2.0); it fits a test with a means
and a check, and a Sue visit has no such split.

## `changes.jsonl`

`<tape>/changes.jsonl`: one JSON line per screen the recorder re-recorded because its stamp no longer matched, so a
screen that moved and should not have is seen. Each row is `{ at, screen, round, sueId, diff }`: `screen` is the new
screen's id, `round` and `sueId` the Sue whose move caused it, and `diff` is `{ was, changedPixels, fraction, sameSize,
picture }`: `was` the old screen's id, the pixel counts from `pictureDiff` (`tape/changed.mjs`), and `picture` the diff image
under `changes/` (`changes/<id>-<time>.png`). When the old picture could not be compared the diff is `{ was, unavailable:
true, detail }`.

## The config module (`--config`)

An ES module whose default export (or named exports) may have: `startUrl`, `start()` (resolves to `{ url, stop() }`,
for a local server), `allowedHosts`, `scope(url)` (only screens whose URL is in scope are explored further),
`routes` (`[{ url, fulfill }` or `{ url, handle(route) }]`, Playwright route patterns), `initScript` (a function or
string run before page code, e.g. a seeded `Math.random`), `prepareContext(context, { device })` (set up the browser
context; use this hook to isolate per-walk state, e.g. a cookie identifying the walk), `typed({ field,
screen, device })` (a box's value: a string, an array of strings for one move each, or `null` to leave it empty),
`skip(control, screen)`, `stampOf(screen)` (optional: sha256 of screen's dependencies, to detect staleness),
`timezoneId`, `settleMs`, `maxScreens`, `maxDepth`, `concurrency`.
