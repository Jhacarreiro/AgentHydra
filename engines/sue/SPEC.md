# SUE - Simulated User Experience

> Owner ask (Owner, 2026-09-21): "I'm going to have a cannon shooting little people out, and they're
> going to be hitting the wall and splatting nonstop. My goal is to be like: whoops, apparently this
> login flow or the home page of my website is so confusing they don't know what we sell."

SUE is a separate tool. It is NOT the design critic, NOT LilGranny, NOT the flow walk. Those read
DOMs with rules. SUE sends PEOPLE: each Sue is a real AI agent - by default an agent of whichever AI
asked for the run, or, named explicitly, a Claude Sonnet 5.5 session through the real Claude Code CLI
driven by a `deepseek`/`openrouter` API key, never a subscription login (the Chair, 2026-09-23: no CLI
logins) - that knows nothing about the code, sits down at a real browser, reads the
page the way her persona would, tries to do what a real visitor would do, makes a REAL account with
a REAL email address we own, reads the code out of her own real inbox, and writes down what she
thought. Many Sues at once. Forever, if asked.

Every number a persona carries CHANGES SOMETHING MECHANICAL. A persona that is only a paragraph of
prompt is theatre; TikTok Sue does not skim because the prompt says so, she skims because her eyes
(the body) only hand her the first forty words of every block and her clock runs out in eight
seconds. Grandma Sue does not "miss the icon button" because we asked her to act old; the body
literally renders it to her as `[a small picture button with no words]`.

## The four processes

```
sue/
  cannon.mjs        the launcher: N Sues, M at a time, --forever; owns the run dir and the ledger
  body.mjs          ONE MCP stdio server PER SUE: her eyes, hands, inbox and diary (Playwright inside)
  mailroom.mjs      ONE per run: holds the AWS creds, polls our inbound mail for every Sue address
  report.mjs        aggregates a run (or all runs) into report.md / report.json / ledger.jsonl
  reap.mjs          sends a janitor Sue back into each account the run created to delete it
  lib/              perception.mjs (dials -> what she sees), readability.mjs, clock.mjs,
                    mime-text.mjs (hoisted from the accounts OTP probe), personas.mjs, run-dir.mjs,
                    claude-cli.mjs (the sealed spawn), findings.mjs, mcp-stdio.mjs (hand-rolled JSON-RPC)
  (the roster)      built-in Boardroom personas in Connections, fetched per run (lib/people.mjs)
  targets/*.json    what site, what hosts she may visit, the declared ground truth, mailbox adapter
  scenarios/*.json  the task she is handed ("first visit", "make an account", "come back and sign in")
  runs/             gitignored: runs/<runId>/...
  state/            gitignored: counter.json (the Sue number), accounts-ledger.jsonl (every account ever made)
```

Runtime: plain `node` (v22), never bun - bun hangs Playwright's chromium launch on this box
(`.arkitect/runners/flow-walk.mjs` header). ESM `.mjs`. No new npm dependencies: `playwright-core`
and the AWS SDK v3 clients are already in the repo; the MCP protocol is small enough to hand-roll
over stdio (initialize / tools/list / tools/call / ping), which is also how `services/studio/local-mcp`
does it.

## The brain: three tiers, never a CLI login

⛔ **the Chair, 2026-09-23, verbatim: "I never want you to use, like, the Claude code or the GPT code CLI
... you're not allowed to use CLI logins."** The ban is the LOGIN - a Claude Code subscription session,
a `CLAUDE_CONFIG_DIR` pointed at somebody's account. `--brain chat|deepseek|openrouter` (or `SUE_BRAIN`)
picks the tier; `assertBrain` refuses anything else, and names this ruling for the retired `claude` tier
by itself.

- **`chat` (the default)** - no CLI, no login: whichever AI started the run drives every Sue, so the run
  spends that AI's usage. She can see screenshots, because her driver can. **Each Sue is ONE sealed CliMayte
  task by default (Owner, 2026-10-06):** her entry in `chat-brains.json` carries `sealed` (her system prompt
  file, her hands-only MCP config, `allowedTools`, a one-line `prompt`), and the task launches exactly that on
  Sonnet 5.5, nothing else in its context (6,000 tokens before her first move against 38,700 for a
  brief-reading agent). `dispatch: "climayte"` (`--dispatch climayte`) has SUE POST them to AgentHydra's
  CliMayte itself (`lib/climayte-dispatch.mjs`); `dispatch.mjs <runId>` hands over a run already going. Only
  when CliMayte is unavailable does the caller start a brief-reading `sue-driver` agent per Sue instead.
- **`deepseek` / `openrouter`** - the real Claude Code CLI, driven by that pool's API key (never a login).
  Used only when the chat names one (the Chair, 2026-09-23: no API keys "unless the desktop instance ... has
  deemed say, a zswarm necessary"): nothing defaults to a pool, including Dredd's unattended hearings
  (`DREDD_SUE_BRAINS`) and the reaper. Measured 2026-09-23, DeepSeek's own keys have no balance, so its
  preflight refuses until that changes.

On `deepseek`/`openrouter`, `lib/claude-cli.mjs` spawns, per Sue:

```
claude -p <the scenario prompt>
  --model claude-sonnet-5-5           (SUE_DEFAULT_MODEL; a persona or --model may override; NEVER haiku - owner rule)
  --system-prompt-file <run>/<sue>/brain-system.md
  --mcp-config <run>/<sue>/mcp.json   --strict-mcp-config
  --setting-sources ""                (no CLAUDE.md, no user settings, no project hooks: she must know NOTHING)
  --tools ""                          (no built-in tools: no Bash, Read, Write, WebFetch, Agent)
  --allowedTools "mcp__sue__*"        (her body is pre-approved; anything else is denied non-interactively)
  --permission-mode default
  --max-turns <persona.maxTurns>      (a mechanical cap on how long she will keep trying)
  --output-format stream-json --verbose
  --no-session-persistence
```

with `cwd` = a fresh temp dir (so no project file is ever in scope), env built fresh by `deepseekEnv`/
`openrouterEnv`: every `ANTHROPIC_*`/`CLAUDE_CODE_*` variable of the launching shell stripped first (so
a Sue can never bill or speak as the session that fired her), then that tier's own `ANTHROPIC_BASE_URL`/
model/key set, plus `CLAUDE_CONFIG_DIR` pinned to a throwaway seeded state dir under `sue/state`
(onboarding only - never a login). The stream-json stdout is written verbatim to `<sue>/brain.jsonl`;
the last `result` event's `total_cost_usd`, `duration_ms`, `num_turns` go in `<sue>/summary.json`.

`SUE_DEFAULT_MODEL` (`claude-sonnet-5-5` since 2026-10-05, Opus 5.5 before; exported by `lib/claude-cli.mjs`) is `chat`'s own fallback model
and every tier's preflight probe model; `deepseek`/`openrouter` always pin their own model instead.
Owner, 2026-09-22: "Every use of Sue should be using our local model with the brain, as in the brain
should be local Claude Opus 5 models". Any `--brain` outside the three tiers, `sonnet` included, is
refused with the spelling to use. The executable is the newest Claude CLI on the machine: the one on
PATH or a copy the desktop app keeps under `~/.claude-instances/<name>/claude-code/<version>/` or
`%APPDATA%/Claude/claude-code/<version>/` (`resolveClaudeBin`; `SUE_CLAUDE_BIN` overrides), because a
new model needs a new CLI: 2.1.273 answers `claude-opus-5-5` with "version 2.1.280 or newer is required".

`mcp.json` points at her body: `{"mcpServers":{"sue":{"command":"node","args":["<abs>/body.mjs","--sue","<sueDir>"]}}}`.
The CLI launches the body; the body attaches to the run's browser (or launches its own when the
cannon did not start one); when the CLI exits the body exits and closes her context. The seal is a
test, not a memory: `tests/claude-cli.spec.mjs` pins `--tools ""` and `--allowedTools mcp__sue__*` on
every spawn, and `tests/cannon.spec.mjs` asserts the same flags on each Sue's own argv - so anything
but `mcp__sue__*` fails the suite. That is the boardroom's `check_no_account_tools`
lesson: account-level connectors ride the login, and the allowlist is what keeps them inert.

The brain NEVER sees: a selector, a URL query string she did not type, our code, the persona
dials as numbers (she is told who she is in words), or anything from the mailroom's AWS side.

## The body: `body.mjs` - one MCP server, one browser, one person

Tools (all under the `sue` server; every call is appended to `<sue>/trace.jsonl` with a timestamp,
the human-clock reading, the page URL and title, and the screenshot path when one was taken). The same
file also gets a `kind: "hop"` line for every page any of her tabs passes through, on her move or on its
own (a redirect, a script, a bounce): the tab, the time, the address with no code, state or token
value, who moved her, and whether the `cx-active` login pointer and the page's login storage keys were
there, by name only (`lib/hop-trace.mjs`). A reader of her moves leaves those lines out (`isHop`).

| tool             | args                                              | what the body does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `look`           | `{}`                                              | Screenshot (JPEG, persona viewport, quality 55, returned as image content) + the page AS SHE PERCEIVES IT (text, see perception below). Charges the clock for reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `click`          | `{ target: number \| string, how?, onto? }`       | Click element `[n]` from the last `look`, or the first visible element whose text matches. `how` is `click` (default), `double-click`, `right-click`, `hover` or `drag` (onto the element `onto` names). Every variant that presses meets every click rail: CAPTCHA widgets, hidden fields, payment boxes, `refuseClicks`, the borrowed-session and free-hands rails, off-site links (records why); a drop target meets them too. `hover` presses nothing, so it meets only the CAPTCHA and hidden-field checks, as a passive `point` does. A right-click the page does not answer with a menu of its own says plainly that nothing she could see happened (the browser's menu never shows in a screenshot, and the body stops it opening). A click that opens a new tab says so and she is on that tab. Charges the clock.                                                                                                                                                                                            |
| `type`           | `{ target, text \| field }`                       | Type into `[n]`. `field` is one of `my-email`, `my-phone`, `my-first-name`, `my-last-name`, `my-birthday`, `my-full-name`, `the-code-from-my-email` - the BODY substitutes her real identity so the brain never has to remember it. Refuses hidden inputs (honeypots), payment fields (autocomplete `cc-*`, labels matching card/cvv/expiry) and file boxes (those take `attach`). A native input or textarea is filled; a box a framework editor draws (contenteditable or `role=textbox`, such as Discord's composer) is clicked, its text selected and her words typed as real keys, because such an editor ignores text that arrives without key events and Enter then sends nothing. Whenever her words go in as keys, a newline goes in as a space: Enter is its own `press`, where the rails read it.                                                                                                                                                                                                           |
| `attach`         | `{ file, target? }`                               | One of HER OWN files into the page (`<sue>/files/`, copied there by the cannon from the scenario's folder - `scenario.files` or `<target home>/files/<scenario id>/` - and named in her prompt). `file` is a name on that list and nothing else; anything else is refused by name. `target` is the numbered thing that opens a window to pick a file: a file box takes the file directly (its own, its label's, or the one hidden inside it - the hidden-field rail steps aside for a box of type `file` and for nothing else), anything else is clicked while the body waits for the window and picks her file in it. Every other rail a click meets still applies. With no `target`, the window her own last hand opened takes it. A plain `click`, `point` or key that opens such a window never hangs: the body closes it and her answer says so and points her at `attach`.                                                                                                                                       |
| `press`          | `{ key }`                                         | Any one key, on every target, with Ctrl, Shift or Alt held: `Enter`, `Tab`, `E`, `Ctrl+A`, `Shift+Tab`. Enter and Space (held or not) meet the rails for what they would press; a typed character meets the hidden-field and payment-field rails of the focused box; `Ctrl+V` is refused everywhere (her clipboard is the machine's), `Ctrl+C`/`Ctrl+X` on a borrowed account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `point`          | `{ action, x, y, toX?, toY? }`                    | Every target: click, double-click, right-click, hold (press and hold for a long-press: a finger on a phone, the left button on a computer), hold-right-click, drag, right-drag, zoom-in, zoom-out or hover at a spot in her last picture, in that picture's pixels. The body shrinks the picture itself to the size a brain is shown unshrunk (1568-pixel long edge, about 1.15 megapixels) and maps her spot back to the page, so it lands where she saw it; a `canvas: true` target's picture is already 1:1. A press over a numbered element is refused and named (`click` and its rails own every button), a press over an un-numbered thing meets the field rails by what it really lands in, down through any frame set into the page (a robot check or a different website's frame, such as a card processor's box, is refused outright, and so is a hidden box or a card box inside a frame; `press` reads a focus inside a frame the same way), and the other rails by its words; hover and zoom go anywhere. |
| `scroll`         | `{ direction: "down" \| "up" \| "top" }`          | One viewport. Low tech-prowess personas cannot scroll horizontally and the body never offers it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `go_back`        | `{}`                                              | Browser back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `go_forward`     | `{}`                                              | Browser forward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reload`         | `{}`                                              | Browser reload. A page that came from a form she sent (a POST) is not sent again: refused as `resend-form`, the answer a careful person gives the browser's question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `go_to`          | `{ address }`                                     | (`url` is read as `address`.) The address bar, railed by THE SUE LAW (a Sue never skips a step a first-time human would take): it opens only an address she has SEEN this visit (a link a look actually showed her, never one past where she stopped reading, scrolled past or hidden; an address written in words she read; a page she was on; a link in a mail she read with `check_email`) or the bare front door of a known host (an exact `allowedHosts` entry, the start page's host, a host she has seen an address on), and only inside `allowedHosts` (a declared exit is a hand-off, as for a click). Anything else is refused in her words and recorded (`refused-unknown-address`, `left-site`). The trace keeps the address without its query.                                                                                                                                                                                                                                                            |
| `tabs`           | `{ action: "list" \| "switch" \| "close", tab? }` | Her open tabs by title: list them, switch to one, close one. A new tab on an allowed host is followed when it opens; one off the allowed hosts is closed (or recorded as an exit); she cannot close her last tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rotate`         | `{}`                                              | Phone Sues only (a desktop Sue is neither served it nor told of it): turns the phone sideways or back upright. The page hears what a real phone sends: a landscape viewport, `orientationchange`, `screen.orientation` landscape-primary. A tab opened while sideways is turned as it arrives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait`           | `{ seconds }`                                     | Real wait, capped at 30s; charges patience. A wait with no seconds (or words, or 0) is refused as SUE asking back (`refused: "no-seconds"`): no time, and on the chat brain no turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `check_email`    | `{}`                                              | Her inbox as she would see it: `[{ from, subject, receivedAgo, body }]` newest first, from `<run>/mail/<address>/`. First call records `firstInboxCheckAt`; when a message arrives the body records `otpEmailLatencyMs` = delivered - requested (the request moment is the last `click` on a control whose text matched /code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | continue | send | next/ after `my-email` was typed - recorded as `otpRequestedAt`, overwritable). Opening it charges her stopwatch one tap, never the time since her last move (a chat brain's thinking); a wait for a mail is `wait`'s. |
| `note`           | `{ kind, text, problem?, same? }`                 | A diary line. `kind` in `confusion`, `annoyance`, `delight`, `broken`, `question`, `thought`. Verbatim to `<sue>/findings.jsonl`. A `confusion`, `annoyance` or `broken` line about something wrong on the site may also carry `problem` `{ title, defect, severity, expected, actual, steps }` (defect issue or warning, severity the 1-5 rubric; a malformed one is refused and nothing is written): the body stamps `look`, `quoted`, `n` and `ref` on it and appends `{ at, ref, sueId, page, title, defect, severity, sueSide? }` to the run's ledger `<run>/filed.jsonl`, whose line is `n` (her own problem sent again keeps its first `n`). `same: n` marks a sighting of a problem already filed. Her look lists the titles filed on her page that are new to her, never one marked `sueSide` (lib/findings.mjs).                                                                                                                                                                                             |
| `give_up`        | `{ why }`                                         | She leaves. Records `outcome: "gave-up"`; the body then REQUIRES `exit_interview`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `done`           | `{ what }`                                        | She thinks she finished the scenario. Same requirement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exit_interview` | the 16 answers below, plus the scenario's own     | Written to `<sue>/interview.json`; closes the browser; the tool result tells her to stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Body-side automatic findings (no brain involvement), appended to `findings.jsonl` with
`source: "body"`: `console-error`, `http-error` (status >= 400 on same-site requests),
`slow-response` (a same-site page or data call she waited on, started during one of her moves (a chat brain's thinking between moves is never the site's wait), > 3000ms past her network dial's
latency, once per endpoint per visit; pictures, sounds, fonts and scripts never; time her own browser or machine stood
still, read off a 1 s heartbeat to her browser, is taken off first and named in `stalledMs`, beside the request's timing
phases: lib/slow-waits.mjs), `slow-navigation` (load > 4000ms), `captcha-challenge`
(a Turnstile/hCaptcha/reCAPTCHA iframe became visible - NEVER solved, only recorded),
`dead-end` (a `look` with zero interactive elements above the fold), `going-in-circles` (once per
page: the same move on the page her last look showed made the 5th time in her last 20 moves, or her
last moves going back and forth through a round of 2 to 4 moves repeated whole (A B A B, A B C A B C),
nudged when the round has gone by 2, 3 and 4 times and filed as "she went back and forth between X
and Y 2 times", the same-move answer winning when both land on one move (cycle idea adapted from
tester-army/e2e's loop guards, Apache-2.0), or the
5th look in a row showing the same page although she made a move expected to change it in between
(click, point, press, go_to, reload, go_back/forward; typing, attaching and scrolling do not count,
since a typed value is not in her words) - address, element count and a short hash of its words,
`lib/circles.mjs`; carries `{ why, times, control }`, and `control` never holds her typed words or
an address's query; she is nudged at 5, 8 and 12 (a back-and-forth at 2, 3 and 4 rounds), firmer
each time, and the move is never blocked;
a refused move and a scroll never count as a repeat. Known false positive: a stepper such as a
quantity "+" pressed five times reads as the same move, and its value is not in her words either),
`left-site` (a click would have
navigated off the allowed hosts - refused), `tiny-text` (count of text nodes below her legible
floor on that page), `reading-grade-over-head` (a block whose grade exceeds hers), `bored`
(attention budget spent on one page without a click), `patience-exhausted` (total patience gone:
the body refuses every further tool but `give_up`/`done`/`exit_interview`/`note` with "You have had
enough of this visit, so you stop before doing that: nothing on the page failed, you simply did not
do it. Call give_up." until she does),
`wrong-destination` (after `outcome` the final URL does not match the scenario's `expectedLandingPattern`).

Allowed hosts come from the target file; navigation elsewhere is refused and recorded. A `blob:`
address (a transcript a page opens in a new tab) is judged by the origin written inside it
(`blob:https://site/<id>` is `site`'s); one with no real origin is refused. The body
never fills a payment field, never solves a robot check, never submits a form the brain did not
click, never leaves the target's hosts. That is the whole sandbox, and it is why her tool calls need
no permission prompt.

**Holding (action games, 2026-10-07).** A tap is keydown and keyup back to back, which moves a
real-time character for one frame, so five PixiJS games were scored 2/5 as "I pressed D and nothing
moved". `press` takes `holdMs` (clamped to 100..5000): keydown, a real wait, keyup (in reverse,
in a `finally`, so no key stays stuck). Several keys go down together as `keys: ["D", "Space"]` or
`key: "D+Space"` (a string that is not one key such as `Ctrl+A` is read as several; a modifier
attaches to the key after it). `point` takes the same `holdMs`: `hold` and `hold-right-click` keep
the press down that long (default `LONG_PRESS_MS`), and `drag`/`right-drag` keep the button, or on a
phone the finger, down on the last spot that long before letting go, which holds an on-screen
joystick in a direction. Every rail judges each held key and each held spot exactly as it judges a
tap (`refusedKey`, hidden/payment boxes, the Enter/Space press targets); a refusal presses nothing.
`lib/rails.mjs` holds `keysNamed` and `readHold`.

### Perception - `look`'s text half

`lib/perception.mjs` walks the live DOM in the page (one `page.evaluate`) and returns an inventory:
visible text blocks (heading level, words, font px, whether above the fold), visible interactive
elements (role, accessible name, whether it has visible text or is icon-only, size px, above-fold),
form fields (label/placeholder/type, hidden or not), dialogs/overlays, and any CAPTCHA frame.
A sighted visitor sees a form inside a web component or a frame like any other, so the walk enters
every OPEN shadow root and every SAME-ORIGIN iframe where it sits: their words and controls are read,
stamped and numbered in place (a frame's boxes moved to where the frame sits on her screen), every
naming rule applies inside them unchanged (only words a sighted person can see; never `aria-label`,
`title` or screen-reader-only text), and her hands reach them by number (a locator pierces an open
shadow root; an id stamped inside a frame is found through `page.frames()`). A CLOSED shadow root and
a CROSS-ORIGIN frame stay shut, as they are to any script on the page, and a robot-check frame is
handled exactly as before: recorded, never read into, never pressed.
Then `perceive(inventory, persona)` applies the dials and renders her view:

- `readingGrade`: a block long enough to grade - at least 12 words or two sentences, of any kind -
  gets a Flesch-Kincaid grade (`lib/readability.mjs`, syllable heuristic). A short heading, label,
  list item or cell is never graded: the formula is dominated by syllables-per-word there, so even
  "Notifications" scores far above every persona. A block above her grade is shown with its first
  sentence and the tag `[this is hard to read - you skim it and are not sure what it means]`; the
  body records it.
- `wordsPerLook`: after that many words on a page her view says `[... you stopped reading here]`.
  TikTok Sue: 40. Grandma: unlimited.
- `legibleMinPx`: text below it becomes `[tiny print you cannot make out]` (counted).
- `techProwess` 1-5: at 1-2 an icon-only control is `[a small picture button with no words]`
  (still clickable by number, but she has to guess); a hamburger/menu icon is `[three little lines]`;
  she is never told about keyboard shortcuts or URLs. At 4-5 she additionally sees the URL bar
  (`[address bar] ...`, which she never gets below that); an icon with no words is a picture at
  every level, `[a small picture button with no words]` at 1-2 and `[an icon button]` above that,
  never a name.
- `device` phone: a real Pixel 7 from Playwright's device registry (its Android Chrome user agent,
  412x839 viewport, 2.625 pixel density, touch, `navigator.platform` Linux armv81), and `rotate`
  turns it; desktop: 1440x900. An iPhone Sue needs WebKit, a separate browser install.
- `network` (optional, default `fast`: no throttling): `4g` or `slow-3g` throttle every page she
  opens over CDP (`body.mjs` `throttlePage`, `Network.emulateNetworkConditions`), applied before a
  page's first navigation where the body controls that ordering (her first tab, the Mail tab) - a
  tab Chrome opens on its own can still let its very first request through. The numbers are
  puppeteer-core's DevTools-aligned presets (`personas.mjs` `networkConditionsFor`): `4g` is Fast 4G
  (165ms latency, 1012500 B/s down, 168750 B/s up), `slow-3g` is Slow 3G (2000ms latency, 50000 B/s
  each way). The three phone personas (`tiktok`, `child`, `old-sue`) dial it to `4g`.
- `timezone` (optional, default this machine's own zone): an IANA zone her browser keeps
  (`timezoneId`, `personas.mjs` `timezoneFor`), so a page's clock reads where she lives. `grandma`
  (Ohio) and `old-sue` (Florida) keep `America/New_York`.
- A phone Sue has an on-screen keyboard. It comes up when her own tap or typing leaves a text box
  focused and goes down when the focus leaves it; `go_back` with it up puts it away and goes
  nowhere, as Android's back does. Modelled on Chrome for Android's default since 108 (and iPhone
  Safari's): the page keeps its size and fires no window `resize`, but `visualViewport` shrinks by
  the keyboard and moves with her view, with its `resize` and `scroll` events (top frame only), so a
  page that lifts its bottom bar above the keyboard is reachable here as it is on a phone. Her
  picture is the part of the page above the keyboard with the keyboard drawn below it, the box she
  types in is scrolled (or her view slid) above it, a numbered thing behind it is reached by
  scrolling and noted `keyboard-in-the-way`, and a `point` on the keyboard is a key, not the page. A
  page declaring `interactive-widget=resizes-content` is squeezed instead.
- Elements are numbered `[1]`, `[2]`... in reading order; the brain clicks by number. Numbers are
  re-issued on every `look`. A page's own widgets are numbered like its buttons: `[role=option]`,
  `menuitem`, `menuitemcheckbox`, `menuitemradio`, `tab`, `switch`, `checkbox`, `radio`, `link`
  (a text box keeps its own role whatever it says). The rails read an option, a menu item or a
  switch as a press, like a button; a tab, like a link, is not one. Until 2026-09-22 a settings
  search's results were never numbered and a Sue pointed at raw pixels to open one.
- A drop-down is called by the label a person can see (its printed `<label>`, or visible text
  `aria-labelledby` points at), else by what it shows, and reads `Log channel [a drop-down list showing "Pick a channel": ...]`
  with its first eight choices. Clicking it by number opens it: every choice is said, and the
  choice she names next goes into THAT list. A choice two lists share, with neither open, is
  refused with both lists named, never guessed. A choice is matched by its label, its value, then
  its label with accents and case folded (`Espanol` picks `Español`; two that fold alike are
  refused). Until 2026-09-22 a list was named by every option run together, so four look-alike
  channel pickers read as one box and a Sue's choice landed in the wrong one.
- She is told only names a SIGHTED person can see (Owner, 2026-09-22: a page must never need
  "hidden HTML element labels" for Sue, and Sue must never be handed one). A thing is called by the
  words on it, its printed label, visible text it points at, or its placeholder; never its
  `aria-label`, a `title` tooltip or a visually hidden (sr-only) word. An icon with no words reads as
  a picture at every tech level (`[an icon button]`, `[a small picture button with no words]`), a
  wordless box as `[a box to type in]`, and she finds it in her screenshot. Her hands say back the
  same name (`seenName`), and a name she TYPES matches only visible words (`seenWords`). The
  inventory keeps the page's own name for the rails and the report.
- Her eyes start at the SCREEN: blocks and elements scrolled above the viewport are out of view (a
  sticky header is still on screen, so it stays), and a look after scrolling opens with
  `[you have scrolled partway down the page]`. Until 2026-09-21 every look re-read from the
  document's first word, so a `wordsPerLook` skimmer who scrolled saw the same opening words again
  and could never reach anything below them.

### The clock - `lib/clock.mjs`

A per-Sue human clock: reading costs `words / persona.wordsPerMinute`; a click or type costs 1.5s;
real waits cost real time. Reading is charged only for blocks NEW to her on this page (a second
look is a glance, not a re-read), and one look never costs more than one attention span
(`clock.read`): charged whole, a long homepage exhausted a 300-second Sue on her second look. Two budgets: `attentionSeconds` per page (reset on navigation or a click
that changed the page) and `patienceSeconds` for the whole visit. When attention runs out without
progress the next `look` opens with `[You are getting bored / irritated ...]` in her voice
(`temperature` picks the wording: 0.2 mild, 0.8 furious); when patience runs out the body ends her
visit as above. The clock is what makes "TikTok Sue didn't read enough" a measurement.

## The mailroom - `mailroom.mjs`

Started once per run by the cannon (or by hand: `node sue/mailroom.mjs --run <runId>`), with an
org-management credential: a named profile (`AWS_PROFILE=main`, the org-management profile on this PC;
measured 2026-09-21 it can assume `OrganizationAccountAccessRole` into Main 109653023276 and the
co-tenancy host in `infra/shared/aurora-cotenants.json`) or a vault lease already in the env
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). With neither it exits 2. Every 5 seconds:

1. `chat.email_provider_events`: `select provider_message_id, recipient_email, event_timestamp,
payload->'delivery'->>'smtpResponse' where lower(recipient_email) = any(:addresses) and
event_type = 'delivery' and event_timestamp > :since` - FILTERED TO OUR ADDRESSES IN THE FIRST
   READ (customer-data rule). `:addresses` = every Sue address in `<run>/manifest.json`.
2. The SES inbound id is `250 OK <id>` in `smtpResponse`; `GetObject` on exactly
   `s3://connections-storage-content-647145109696/landing/mail/main/<id>` (`inboundLanding` in
   `lib/mailroom-core.mjs`: Main's receipt rule lands in storage's content bucket since 2026-09-24); re-check the `To:` header names
   a Sue before parsing (the accounts OTP probe's rule, kept).
3. Parse with `lib/mime-text.mjs` (hoisted VERBATIM out of
   `services/accounts/infra/scripts/probe-otp-signin-path.mjs`, which is repointed to import it - one
   canonical MIME reader, not two) into `{ from, subject, text, receivedAt, deliveredAt, messageId }`
   and write `<run>/mail/<address>/<id>.json`. Never print a code.

Sue addresses are `sue-<n>-<persona>-<run tail>@example.com` (short, human, no digit run that reads as a code) - `example.com` is the domain whose
MX is Main's SES inbound (`services/main/infra/lib/constructs/ses-inbound.ts`: the receipt rule's
recipient is the bare domain, so every local part lands). Nothing forwards those to a human
(`inbound-routing-rules.ts` admin-forwards only named addresses and the `api.example.com`
domain). SMS is never used: every persona "prefers email and does not want texts", and the phone
she gives is `+1 206-555-0100` (valid to libphonenumber, a reserved fictional NANP number, so no
real phone can ever receive a code) - the same number for every Sue, as the owner ruled.

## The cannon - `cannon.mjs`

The cannon is what `sue run` starts (`cannonArgs` in `sue.mjs`, run by its detached `_runner`); it
refuses a wave `sue run` did not start (`lib/door.mjs`), so start one with `sue run` (README § Every
wave starts through `sue run`). These are the flags the runner passes, and the run fields behind them:

```
--target connections --scenario first-visit --personas grandma,tiktok --count 12   # {target, scenario, personas, count}
--concurrency 6      # {concurrency}: override the self-sized wave (default: auto)
--forever            # {forever: true}: loops until `sue stop` or --max-accounts
--brain openrouter   # {brain}: which key pool thinks (default chat; see "The brain" above)
--as owner           # {as}: a per-target session saved by login.mjs
--profile <name>     # {profile}: a saved login from the Manager's Logins tab (lib/profiles.mjs)
--stampede           # every Sue's browser is ready, then all start in the same second
--dry-run            # by hand too: prints the plan and the exact CLI lines, spawns nothing
```

Per run: `runs/<runId>/manifest.json` (target, scenario, personas, addresses, started),
one dir per Sue, `mail/`, `report.md` written at the end (and every 60s while `--forever`). The Sue
number is a global counter in `state/counter.json` starting at 1117 (the owner's own example:
"Grandma Sue 1117"); a Sue is `sue-1117-grandma`. Every account a Sue creates is appended to
`state/accounts-ledger.jsonl` (`{ address, sueId, runId, createdAt, deletedAt: null }`), append-only: `reap.mjs`
closes one by APPENDING `{ closes: { address, sueId, runId }, deletedAt }`, which `readAccountLedger` folds onto
its row, never by rewriting the file under a cannon that may be appending to it. Caps:
`--max-accounts` per run (default 25) - past it, the cannon refuses to start another signup scenario
and says so. There is no daily cap on Sues, per machine or on the server's Sue door (both deleted
2026-09-23, the owner: credits meter Sue). `--concurrency` above 8 re-executes the cannon under
`~/.claude/tools/fairjob.cmd -Weight 3` unless `--no-fairjob` (shared box, owner rule).

**Nothing is spent until the brain proves it can talk.** Before a single Sue number, mail address or
browser, the cannon runs `preflightBrain`: one turn, no tools, no MCP, no persona. A failure REFUSES
the run (exit 2) and names the cause, and `--no-preflight` exists only for a test that must not spend
a turn. Mid-run, a whole wave of dead brains stops the run instead of looping: `brainErrorFrom` reads
the CLI's own `result` event, `summarize` records the third outcome `brain-error`, and `report.mjs`
quarantines those Sues out of every count under a `BROKEN RUN` banner. **This exists because on
2026-09-21 an expired OAuth session ran for five hours: 410 Sue numbers and 410 addresses burned, 40
waves looped, and the report rendered 400 dead sessions as "400 visitors had no idea what this page
sells" - a tool failure wearing a product finding's clothes.** The field was already in every
`summary.json`; nothing read it.

**The wave sizes itself, because a 25-wide one crushed the owner's box (Owner, 2026-09-21: "you are
killin my pc ... find a bettwr cleaner way").** `--concurrency` defaults to `auto`: `waveCeiling()`
takes the smallest of a hard ceiling of 8, `cores - 2`, and what free memory allows -
`(freemem - 6 GB reserve - 1 GB for the run's one browser) / 400 MB per Sue`. Measured on this box:
a Sue costs 0.27 GB of brain plus 0.11 GB of body, and the whole browser tree is a FIXED 0.99 GB
across 9 processes no matter how many Sues attach to it. The resolved number is logged with the
free memory and core count it came from, so a slow run says why. An explicit `--concurrency N`
always wins - the ceiling is a default, not a cap.

Chromium: **ONE browser for the machine**, not per run and never per Sue (Owner, 2026-09-25: six runs had
six Chromes open). Each run joins the shared Sue browser through `lib/shared-browser.mjs`: the first run
that needs one starts `browser-host.mjs`, which owns Chrome from outside every run's process tree (so
`sue stop` on one run cannot close it under the others), and closes it once no run has held a lease for
90 s. One browser per KEY - mode, Chrome binary and flags - so a headed wave and a headless one never
share. A run that cannot join opens a browser of its own, as every run did before; `SUE_SHARED_BROWSER=0`
skips the shared one. Either way the cannon passes one ws endpoint to every body, which does
`chromium.connect()` + `browser.newContext()`. A
context is as isolated as a profile for cookies, storage and cache, so nothing about a Sue's session
leaks; only the process tree is shared. A body given no endpoint (a hand-run body, the reaper, a
fixture in tests) launches its own `launchPersistentContext` at `<sue>/profile/`, so a single Sue
still works standalone. A body given an endpoint that fails to connect does NOT fall back: one
Chrome per Sue is exactly the ~300 MB-per-Sue load the one-browser rule exists to avoid. It logs the
error and exits 1 without writing its ready file, so a dead wave server fails that Sue loudly rather
than quietly turning a wave into a pile of private browsers. Executable from
`packages/connections-arkitect/agnostic/engines/render/browser-launch.mjs`'s `resolveChromiumPath`.
Headless is per target: Cloudflare 403s headless Chrome on every `*.example.com` host, so a live
target runs HEADED with the window parked at `--window-position=-32000,-32000` (never a visible
console, owner rule); the fixture target stays headless.

## Personas - Sue people in Connections

Every persona is a Boardroom persona in Connections, never a file (Owner, 2026-09-28: "There should not be a
single local personality in the workspace"): the built-in roster is the Boardroom's built-in rows and a
workspace's own people are its Sue people, fetched per process by `lib/people.mjs` and held in memory.

**Every persona carries ERRANDS: the REASON she is on the site at all, in her own words, and it is
as required as a dial** (owner directive, Owner, 2026-09-21: "why are you trying to use this website?
... your goal is to come here for this or for that, or your friend told you about it and you're
skeptical. These allow the AI to truly explore"). Without one a brain behaves like an assistant asked
to review a website - it explores politely, guesses, and reports - which is theatre, not a visit.

`errandFor(persona, sueNumber)` rotates the list by Sue number, so a wave of ten Karens turns up for
three different reasons and a rerun of one Sue number reproduces hers. The chosen errand leads BOTH
things she is handed: a `# Why you are here` section at the top of her system prompt, above the tool
list, and the first line of the `-p` prompt. The scenario file no longer invents a motive - it only
says how the visit ends ("open the website and try to do that... when you have had enough, stop").

```json
{
  "id": "grandma",
  "displayName": "Grandma Sue",
  "errands": [
    "Your grandson said you can find things to do near you on here. You want to find one thing happening this week that you could actually go to, and know where it is and when."
  ],
  "voice": "You are Sue, 74, retired schoolteacher in Ohio. Your grandson said this website would help you find things to do. You use Facebook and email. You read everything, slowly. You are polite but you say when something makes no sense. You do not know what 'SSO', 'OAuth', 'workspace' or 'plane' mean. If a code is supposed to come by email you will check your email, wait, and check again; you do not know about spam folders unless it is suggested.",
  "dials": {
    "readingGrade": 8,
    "wordsPerLook": 0,
    "wordsPerMinute": 150,
    "legibleMinPx": 15,
    "techProwess": 1,
    "attentionSeconds": 90,
    "patienceSeconds": 420,
    "temperature": 0.2,
    "device": "desktop",
    "maxTurns": 60
  },
  "identity": { "firstNames": ["Sue", "Margaret", "Linda"], "lastNames": ["Parker", "Hill", "Novak"], "birthYear": [1948, 1956] }
}
```

`model` is optional and no roster persona sets it: unset, she thinks with `SUE_DEFAULT_MODEL`. A persona
that names one (never a Haiku) thinks with that instead, unless the run's `--model` overrides it.

**The players (2026-09-23, the Chair: "people that we should put into Sue so I can have it help with game
design").** Seven roster personas play a game rather than visit a site, each one a player type from a
published model rather than a real person: `casual-cassie` (two-minute phone sessions, never reads a
tutorial), `veteran-vic` (has played every tower defense and judges against them by name), `spike-sam`
(Rosewater's Spike: plays to win, hunts the dominant strategy, calls randomness cheap), `timmy-tess`
(Timmy: plays for the big moment and the spectacle), `johnny-jun` (Johnny: plays to express himself, the
odd build), `kid-kai` (nine, reads a line at most, taps everything) and `lapsed-lou` (fifteen tired
minutes after the kids are asleep: can I stop and resume?). Their errands are about a game someone showed
them, so they belong on a `canvas: true` target with the `playtest` scenario, never on a website wave.

**The troll (2026-09-26, the Chair: "your average anonymous dickhead Reddit user").** `reddit-troll` (Kyle,
29, desktop, prowess 5, attention 12s, patience 120s, temperature 0.8) clicks a link someone posted in a
thread only to find the thing to mock in his reply: marketing words, a sign-up wall, a price, a wrapper
around something free, AI-written copy. He swears a little and never uses slurs. He is in no default mix;
name him with `--personas reddit-troll` on a wave for anything we are about to post on Reddit, Hacker News
or another comment-heavy place. Dredd's matching seat is `seats/14-the-reddit-troll.json`.

**The critics (2026-09-27, the owner: "build me a Sue personality ... whose only job is to go through our
platforms and be like a user would drop off here. There's not enough retention here. This is a boring
step").** Two of the Connections workspace's Sue people are the one kind of Sue who IS reviewing:
`retention-doctor` (a behavioural scientist of attention and retention, desktop, attention 30s at 238 words
a minute, patience 30 minutes) and `game-designer` (a free-to-play designer of core loops, game feel and
first sessions, phone, attention 20s). A third, `ads-readiness` (2026-09-30, the owner: "if a human ran through
this, would they stay? Would they leave? Would they purchase?"), is a consumer psychologist and conversion
researcher who arrives from a paid ad (phone, attention 30s, patience 30 minutes) and says stay, leave or buy
on every screen; her `drop` is a buyer leaving or deciding not to pay, her `hook` a lean toward paying. They
live in Connections like every other workspace person, not on the roster. Two optional persona fields make a
critic, and a mind goes with them:

- Her MIND is not a persona field and never a file in a repo (Owner, 2026-09-28, asking why two 150 KB minds
  sat in GitHub). It is her Boardroom row's playbook in Connections. The process that starts a run fetches
  its critics' minds through the Boardroom's sue/mind door with its people (`lib/people.mjs`), holding them
  in memory only, and a run pins the text inline as `target.minds[id]` when it starts (`pinCriticMinds`), so
  every Sue of one wave reads the same mind. Her brief carries it whole under `# What you know`, so it is capped at `MIND_MAX_BYTES`: a
  critic with no mind, or one over the cap, refuses the run before a Sue number is spent, and a persona
  that still names a `mind` is refused. `node sue/mind.mjs push <id> <file.md>` is the one way a mind
  goes up and `pull <id> <out.md>` brings it down to edit. The critics' minds are field guides built
  from adversarially verified research: every entry is a mechanism with its evidence and grade, what it
  looks like on a screen, the question to ask and the fix, and each chapter ends with the myths in its area.
- `critic: true` (needs an `interview`, and a mind at run time): her errand becomes
  `# The visitor you are walking for`, the reason an ordinary visitor arrives, and she walks exactly that
  path with the visitor's hands and rails; the visitor's diary rules are replaced by `CRITIC_DIARY` (every screen gets a line, the
  body's boredom is her stopwatch, a severity-3 drop is logged and walked past so the rest of the path is
  measured too, harms are named with their humane replacement), and she answers the standard exit keys as
  the visitor would.
- `interview`: her own exit questions, `{ key: question }` (camelCase, never a standard key). The cannon
  folds them under her scenario's (`withPersonaQuestions`, the scenario's wording wins a shared key)
  before it writes `sue.json`, so her tools, her prompt and the report read one list.

Pair a critic with a visitor on the same page: the visitor shows what a person did, the critic says why.
Dredd does this by itself (`dredd/lib/convene.mjs` `criticsFor`): an ask about drop-off, boredom,
attention or coming back sends the page's cast (or `tiktok`) plus `retention-doctor` and `game-designer`; an
ask about ads, buying, paying, checkout, pricing or whether people stay or leave adds `ads-readiness` and
`retention-doctor`.

Roster (all shipped): `grandma`, `old-sue` (81, phone, worse eyes, more patience, grade 6),
`tiktok` (19, phone, wordsPerLook 40, attention 8s, patience 60s, temperature 0.6, prowess 4),
`child` (11, grade 3, attention 20s, prowess 3, phone), `low-attention` (34, attention 15s,
wordsPerLook 80, prowess 3), `bob` (52, small-business owner, wants to host an event, grade 10,
prowess 3, temperature 0.5, "did they also think this is trash"), `elaine` (41, marketing
director, grade 12, prowess 4, attention 30s, temperature 0.7, judges copy), `karen` (58,
temperature 0.9, patience 90s, wants a human), `dev-dan` (29, prowess 5, spots every jank),
`esl-maria` (36, English second language: readingGrade 5, wordsPerMinute 110), and three buyers
added for the homepage wave: `office-manager` (Priya, 38, runs operations for a 25-person firm),
`shop-owner` (Dana, 35, a small home-goods shop that ships parcels daily) and `solo-consultant`
(Marcus, 44, a one-person consultancy that lives on its relationships), and `machine-operator`
(Hank, 47, a union crane and excavator operator: phone, gloves on, glare, prowess 2, attention 20s,
trusts what is simple, loud and certain). The three critics,
`retention-doctor` (44, desktop), `game-designer` (39, phone) and `ads-readiness` (45, phone), are workspace
people, not roster ones.

## Targets - `targets/connections.json`

```json
{
  "id": "connections",
  "startUrl": "https://example.com/",
  "allowedHosts": ["example.org", "*.example.org", "example.com", "*.example.com", "challenges.cloudflare.com"],
  "groundTruth": {
    "oneLiner": "Connections is an events platform: find things happening near you, host your own events, and keep the people you meet.",
    "mustGet": ["events"],
    "shouldGet": ["host", "near you", "people", "community", "tickets", "rsvp"],
    "wrongIf": ["dating app", "crypto", "bank", "email provider", "note taking app"]
  },
  "mailbox": { "kind": "ses-inbound", "domain": "example.com" },
  "identityPhone": "+12065550100",
  "knownAddresses": ["https://example.com/dashboard"],
  "expectedLandingAfterSignup": "^https://((?!accounts\\.)[a-z0-9-]+\\.)?(getconnections|connections)\\.icu/"
}
```

Optional keys a product's own target may add: `knownAddresses` (addresses she arrives already having, seeded
into what `go_to` accepts exactly as an address she read on a page is, and named in her prompt; the host fence
still applies), and `sessionParts` (`[{ id, target }]`) for a visit that crosses sites - `cannon --as <name>`
then reads one saved session per part, proves each against ITS OWN target's `signIn`, hands the body all of
them, and refuses BY NAME when one is missing or expired; free hands only when every part is a throwaway.

## Scenarios - `scenarios/<id>.json`

`first-visit`: "You have never heard of this website. A friend sent you the link. Spend a few minutes
finding out what it is and whether it is for you. If it seems worth it, make an account. Then leave."
`signup`: "You decided to make an account. Do that, all the way to being signed in. Then look around
for one minute." `return-login`: "Make an account here with your email (<address>), all the way to being signed
in. Then sign out ... Then come back and sign in again" (she makes her own account first, owner 2026-09-22). `host-event` (bob): "You want to put your Thursday networking meetup on here. Try." `delete-account`
(janitor): "Delete this account completely." `playtest` (the players): play the game for real, one full
level or round to its end, thinking out loud; its own interview asks how you win and lose, the best and
worst moment, the difficulty, whether she would open it again tomorrow and the one fix first. Each has `expectedLandingPattern` and `successWhen`. A scenario may also carry `files` (the folder her own
files come from, relative to the target file; the default is `<target home>/files/<scenario id>/`),
`knownAddresses`, its own `errands`, and `interview` (its own exit-interview questions).

## The exit interview (mandatory, verbatim keys)

The keys live in ONE place - `INTERVIEW_KEYS` in `lib/findings.mjs`, which is also what shapes the
answers - so the prompt and the shaper cannot drift. Today: `whatIsThisSite` (free text),
`whatDoTheySell`, `oneSentenceToAFriend`, `confidence` (1-5), `madeAccount` (bool), `whyStopped` (if
not), `mostConfusing`, `emailCodeExperience` (`{ waitedSeconds, wasClear, notes }`),
`endedUpWhereExpected` (bool + where), `easyToUnderstand` (1-10), `trust` (1-10), `wouldComeBack`
(1-10), **`starsOutOfFive`** (1-5), **`everComingBack`** (bool + why), `isThisTrash` (bool + why),
`threeWords`.

A scenario may ask its OWN questions on top of these (`scenario.interview`, `{ key: question }`): they join the
`exit_interview` schema as OPTIONAL answers, are asked in her prompt, are kept by `shapeInterview` into
`interview.json`, and get their own section in `report.md`. They can never take a standard key's name.

The last two bold ones are the VERDICT pair, and they are what the report leads on (owner ask, the owner,
2026-09-21): "all of the shitsus should have reported. Gosh darn it, couldn't even log in. What a
trashy website. One star, moving on. When I say moving on, I mean they're done with the website,
never gonna come back." `everComingBack: false` is exactly that - not a low score, a person gone.

`shapeInterview` is the ONE coercion seam and both real failure modes are proven there: a boolean
sent as the string `"false"` (which `Boolean(...)` read as true, reporting signups that never
happened), and a whole nested answer sent as a JSON STRING (measured on a live grandma who did it for
all four, which silently zeroed the funnel's `endedWhereExpected` and the verdict's never-coming-back
count). `report.mjs` re-shapes on the way IN as well, so every run recorded before 2026-09-21 reads
correctly too.

## Her diary is the deliverable, not a side effect

She is told to write in it mid-visit, in her own voice, with the triggers named (thrown somewhere she
did not ask to be, cannot tell what a button does, took longer than she would wait, words she had to
read twice, asked for something unexpected, anything that made her want to leave) and an example of
the voice: "I got this far and I have no clue why I am here now, I am so confused." A single sentence
asking her to "say what you think as you go" produced runs with empty diaries; the section replaced it.

Two body-side rails back it up, because the brain silently stops journalling when it gets absorbed:

- **`journalNudge`** - every `NUDGE_EVERY` (6) things she does without a diary line, her hands append
  "you have done N things since you last wrote anything down". It does not appear in the trace's
  `result` (that stays the real answer), only in what the brain reads.
- **The wrap-up line** (`wrapUpNotice`) - her last `WRAP_UP_MOVES` (5) moves of the persona's `maxTurns` are kept
  for leaving properly: every move then carries "Wrap up now: call done or give_up, then exit_interview". On the chat
  brain (`sue.json` `brain: "chat"`, a run whose turns nothing caps but this line) what SUE itself asks costs her no
  move: her diary lines, since the nudge above asks for them; the hands' which-one question ("Two things answer to
  3"); and a refusal of a move no person in her place could have made (`SUE_ASKS`: a call her hands cannot read, a
  thing she was never shown, the wrong hand for what is there). A rail on what her hand really reached (a link off
  the site, a robot check, a card box, a delete) is the world answering a move she made, and counts. A CLI brain's
  `--max-turns` counts every turn, so there every move counts. Counted on lift-v2 rounds 14 to 22, a quarter of
  Emily's and DeShawn's moves were notes, and the line sent them home with patience left every round.
- **`areaOfUrl` / `areaChange`** - she cannot see a hostname, so being thrown across the site used to
  be imperceptible to her, which is the gap the owner named: "I logged in on the notes page and it
  sent me to the accounts page. Why the heck am I on the accounts page after heading to notes?" Any
  click that lands her in a different AREA (subdomain, else first path segment, else "the front page")
  now returns "You were on notes a moment ago; this is accounts now." and files a mechanical
  `sent-to-another-area` finding carrying `{ from, to, returning }`. The word "plane" never reaches
  her: she has never heard it.

**Attention has its own two kinds** (2026-09-27, the owner: "if you're watching a video and you look away for a
second and look back, that part of the video needs edited"): `drop`, the moment she would look away or
leave, and `hook`, the moment something held her (`ATTENTION_KINDS` in `lib/findings.mjs`). Any Sue may
write them; a critic writes one per screen. `note` takes three optional fields beside the words, `why`
(the mechanism, with the id of the entry in her mind that explains it), `fix` and `severity` (1 attention
dips, 2 some leave, 3 most leave), and the body stamps a drop or hook with `visitSeconds`, the seconds into
the visit her clock has spent (`attentionNoteExtra`). Her words open with how long a first-time visitor would
have taken to reach that moment; the stopwatch counts only reading, taps and waits (not a live game she
watches), so the report labels it "on her stopwatch" beside hers. Every other kind's row is written exactly as before.

## Report - `report.mjs`

`node sue/report.mjs --run <runId>` (or `--all`) writes `report.md` + `report.json`:

- **the verdict, FIRST** - average `starsOutOfFive`, the star histogram, and how many of them are
  never coming back, each with her own reason quoted. A skipped rating is `null`, never 0: 0 is off
  the 1-5 scale and would drag the average down with a non-answer.
- **where attention broke, moment by moment** (only when a Sue wrote a `drop` or `hook`) - every one,
  per Sue in clock order as `m:ss DROP <severity> on <page>: "<what she saw>" - why: ... - fix: ...`,
  after the severity-3 drops gathered at the top ("fix these first") and the pages ranked by attention
  lost (`buildAttention`). Her journal line keeps the same timeline as `attention`, and any answers to her
  critic questions as `answers`, so a critic's journal is the running list of what to fix on each page.
- **what confused them, in their own words** - every diary line she wrote of kind confusion /
  annoyance / broken / question, verbatim and in full, never summarized, plus each Sue's
  `mostConfusing`. An empty diary is reported as a SUE defect, not a clean run.
- comprehension: for each Sue, `mustGet`/`shouldGet`/`wrongIf` keyword hits in her
  `whatIsThisSite` + `whatDoTheySell` + `oneSentenceToAFriend` -> score 0-3 (`got-it`, `partly`,
  `no-idea`, `wrong-idea`); the bucket per Sue (`perSue`) and the run's `bucketCounts`; the exact
  sentences for the worst three.
  Mechanical and transparent; a judge pass can re-grade the ambiguous ones later.
- funnel: started / reached signup / requested code / read code / signed in / ended where expected
  / gave up, per persona, with the step they died at.
- OTP: latency p50 / p95 / max, how many checked the inbox before the mail arrived, how many never
  found it.
- clock: median seconds to the first click, per-page bored events, patience exhaustions.
- body findings by kind, with page URL and the Sue who hit it; the top confusions in the Sues' own
  words; `isThisTrash` yes-rate with the whys.
  Every run records one line in `runs/ledger.jsonl`, upserted by run id (a re-report replaces the
  run's own row), so trends across runs are one `jq` away.

## Focus group

A focus group is an ordinary SUE run whose `runDir` has a `room/` (`lib/room.mjs`, spec
`tests/room.spec.mjs`; opened by `sue run` via `openRoom` before the cannon starts). Every Sue in it
is a whole Sue, unchanged - her own browser, account and rails; the room is what she does BETWEEN and
AFTER her page moves, never instead of them. NO AI lives in `room.mjs` itself: every word was written
by a Sue's brain, the moderator's brain or the human host; the module only files, orders, counts and
tells, and the vote is counted, never judged.

**On disk (`<runDir>/room/`):**

- `room.json` (written once by `openRoom`): `{ url, page, intent, suggestions: string[] (each clipped
to 400 chars, at most 10), previous: last verdict on this page or null, moderator: "ai"|"none",
openedAt }`.
- `roster.json` (written once by the cannon, before any Sue starts): `[{ id, name, persona, device? }]`
  in seat order; every `id` must match `^[a-z0-9][a-z0-9-]{0,80}$`.
- `<speaker>.jsonl` (one per speaker - each Sue's id, `moderator`, `host` - append-only, so two
  processes never race the same file except the host, whose lines are rare): one JSON object per
  line, `{ id, at, from, name, kind, text, to?, ref?, why?, url?, noteKind? }`. `id` is
  `<from>.<epoch36>.<4-hex-salt>`, unique with no coordination between writers.
- `verdict.json` (written once with an exclusive create, `wx`): `{ problem, proposal, putOnTableBy,
agreedBy: string[], against: string[], didNotVote: string[], size, summary, quotes: [{name,text}]
(at most 6), decidedBy: "moderator"|"vote", lastProblem, lastProblemStillThere:
"yes"|"no"|"unclear"|null, at }`.
- a listener's heard set lives with her, not the room: `<sueDir>/room-heard.json`.

**Line kinds:** `joined` (her first move), `journal` (every diary note, `noteKind` carried through),
`say` (talk to the room, `to?` narrows it), `vote` (`ref` = the line id of a proposal already on the
table when she backs one, else a new problem in `text`/`why`), `left-page` (done or give_up: from now
she is at the table, not the website), `left` (her exit interview is given), `ask`/`propose`/`gather`
(the moderator's three speaking moves, beyond asking to hear the room) and `verdict` (the room's or
the moderator's closing line).

**Phases:** `visiting` (default) while at least one seat is still on the website and nobody has been
gathered; `table` once every seat has left the website, or once any `gather` line exists even with
some still browsing; `closed` once `verdict.json` exists. A seat's own state is derived the same
way, never a second source: `looking` until her `left-page`, `table` until her `left`, then `gone`;
her vote is her LATEST `vote` line, so changing her mind moves her, never counts her twice.

**The exit-interview gate:** a focus-group Sue may not give her exit interview until she has left the
page (a `left-page` line) AND voted. Once both hold, she is cleared at once if the room already has a
verdict; otherwise she is held at the table (`room`/`say`/`vote`, no page needed) until the room
concludes or she has waited at the table longer than `TABLE_MAX_MS` (12 minutes) - the one timeout
that clears her even with no verdict, so a stalled room never strands an exit interview.

**The vote watchdog:** closes the room, with no AI, once every seat has gone and at least one voted,
or once every seat still present has voted (tolerating a seat still on the website only after a
`gather` has called the rest in) and the last vote is at least `VOTE_GRACE_MS` (3 minutes) old - the
grace window that gives the moderator its own chance to conclude in words first. A tie among tallied
problems goes to whichever was put on the table first.

**The builders' guesses hold the vote.** In a room with `suggestions` and an AI moderator, the vote
does not close it until every Sue at the table has said something (`say` or `vote`) after the
moderator's guesses `ask` (the one marked `guesses: true`), or `GUESSES_WAIT_MS` (3 minutes) has
passed since that ask; with no guesses ask yet, the hold is that long past the vote's own grace. The
Sues vote the moment they reach the table, so the vote clock alone closed rooms before the guesses
were put, and the verdict still read as complete (run `20260925-074931-2d5f`: the room closed 13
seconds before the moderator's guesses ask, and no Sue answered either guess). A moderator's own
`conclude` is its judgment and is not held.

**The moderator's hands** (`moderator.mjs`, one MCP stdio server per room, started
`node sue/moderator.mjs --sue <runDir>/moderator`, server name `sue`; never sees the website):

- `room { wait? }` - hear the room since she last listened, waiting up to `wait` seconds
  (`ROOM_WAIT_MAX_SECONDS` = 30).
- `ask { text, to?, guesses? }` - put a question or an idea to the table ("we think X is the problem,
  what do you think?"); `to` narrows it to one seat's name; `guesses: true` marks the ask that puts
  the builders' guesses, which holds the vote until the table answers it.
- `propose { problem, why? }` - put a problem on the table in words the room already used, so it can
  be voted for by its number.
- `gather { text? }` - call everyone still on the website to the table now.
- `conclude { proposal?, problem?, summary, lastProblemStillThere? }` - close the room: `proposal` is
  a table number or `problem` is the agreed words, `summary` is required. Refuses with the standing
  verdict once the room has already closed, and refuses when nobody has voted for anything yet.

**A focus-group Sue's own hands** (`lib/focus-hands.mjs`, served by `body.mjs` only when her
`sue.json` carries `focusGroup: true`; spec `tests/focus-hands.spec.mjs`): `room { wait? }` (hear the
others), `say { text, to? }` (talk to them) and `vote { proposal?, problem?, why? }` (back a problem
on the table by number, or put down a new one). None of the three opens or needs a page.

**The new `sue` actions and manager routes:**

- `sue.mjs run` takes `focusGroup: boolean`, `suggestions: string[]` and `moderator: "ai"|"none"`
  alongside its existing args; a truthy `focusGroup` opens the room before the cannon starts, and the
  cannon writes `roster.json` and passes `focusGroup: true` down into every Sue's own `sue.json`.
- `sue.mjs focus_group` = `run` with `focusGroup` forced true; `count` defaults to
  `FOCUS_GROUP_DEFAULT` (4) and is capped at `FOCUS_GROUP_MAX` (12).
- `sue.mjs room { runId }` -> the room's whole public picture: `{ meta, phase, seats:
[{id,name,persona,device,state,voted}], table: [{n,text,by,why,backers}], lines: [...], verdict }`;
  refuses "not a focus group" for an ordinary run.
- `sue.mjs room_say { runId, text }` -> `{ line }`, appended as `host`.
- the manager exposes `GET /api/runs/:runId/room` (the same snapshot JSON; 404 `{ error }` when the
  run is not a focus group) and `POST /api/runs/:runId/room { text }` -> `{ line }`, the human host's
  own speaking door. The waves route passes `focusGroup`/`suggestions`/`moderator`/`brain` straight
  through to `sue run`, and every run summary carries `focusGroup: true|false`.
- **the fix loop:** a closed room's verdict is booked, one row per run (upserted by `runId`), to
  `.sue/focus-groups.jsonl` in the workspace; the next room opened on the same page reads the last
  verdict for that page into its own `room.json`'s `previous`, and the moderator's brief asks it to
  find out - without telling the room what was said before - whether anything like it still bothers
  this group, and to pass `lastProblemStillThere` when it concludes.

## Tests (`sue/tests/*.spec.mjs`, `node --test`)

perception on three committed HTML fixtures (a marketing hero, a signup form with a honeypot and
an icon-only submit, a wall of legalese) under three personas - asserts the exact tags above;
readability grades on known sentences; the clock's budgets; the mailroom parser on a committed
fixture of an OTP email (code never asserted by value, only "exactly one six-digit candidate");
the cannon's `--dry-run` plan; the seal flags pinned on every Sue's argv; the live end-to-end
signup (opt-in: `SUE_LIVE=1`).

## Rails the body enforces (never the brain)

Never a CAPTCHA solved. Never a payment field. Never a hidden field. Never off the target's hosts.
Never SMS. Never a real person's address or number. Never more than the account caps. Never a code
printed to any log. Never a Haiku brain. The ONE thing a hidden box is ever reached for is `attach`
into a box of type `file` (a page's own file box is usually hidden behind the button that opens it),
and only there: `type`, `click`, `press` and `point` refuse a hidden box exactly as they did.
