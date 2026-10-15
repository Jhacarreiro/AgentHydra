# Price check

Everything a person sees on a page costs them something: a word to read, a button to decide about, a banner to dismiss. Price check puts one number on every page of any web app, names the file each point comes from, and holds the line: a page may get cheaper any time, and dearer only with a written reason.

**TL;DR**

- **Any repo.** Vue, React (JSX/TSX), Svelte and plain HTML. A JSX `a ? X : Y` or `a && X` prices only its dearer arm. No setup to start; `.pricecheck.json` tunes it.
- **Two measurers, one price list.** Static reads the code (the page and every component it renders, in seconds, for gates). Live renders the page in a real browser at desktop and phone width, prices what is actually on screen, and names the component that drew each thing.
- **Every point is attributed.** A page's price is the sum of its files' shares, so "the footer costs 14 of this page's 40" is a fact, not a guess. `page <file> --tree` shows what each rendered component costs, nested.
- **Only what can show at once.** A condition known where a component is used decides what it shows: a prop the caller passes or leaves out, a name computed from props, `v-show` set to false. A page's own state named for something the person opens or picks (a selection, an open thread, a docked record, a menu) is closed on arrival, unless the script starts it with a value or a watcher or load hook sets one. Sibling `v-if`s that can never be true together count once, and a page that switches on a phone or desktop flag is priced at both widths (the dearer is its price; `byViewport` has both).
- **Pages are pages.** A component another template renders, or an app's `index.html` shell, is not counted as a page of its own.
- **A ratchet per repo.** `.pricecheck/baseline.json` freezes each page's price. Prices only fall; a rise needs `raisedTo` and a `reason`.
- **Weighted by real traffic when you have it.** `.pricecheck/views.json` (page or route to daily views) turns a price into what the page costs your users per day, which is how pages are ranked.
- **In every chat.** AgentHydra's MCP server exposes it as `price_check` tools, and a change's price shows up as it is built.

<details><summary>The price list</summary>

| Unit | Points | Free per page | What counts |
|---|---|---|---|
| word | 1 | 0 | a word the person reads |
| control | 2 | 0 | a button, link, tab or toggle |
| choice | 1 | 0 | an option in a menu, select or radio group, past the first |
| field | 3 | 0 | a form field to fill in |
| feature | 3 | 0 | a section, card or tile |
| media | 1 | 0 | an image, icon or illustration |
| product | 3 | 0 | a push toward another product |
| interruption | 15 | 0 | a dialog, banner, toast or cookie bar showing on arrival |
| motion | 5 | 0 | something moving on its own |
| screen | 10 | 1 | a screen of scrolling |
| color | 1 | 6 | a distinct text or fill color |
| type | 2 | 4 | a distinct font size |
| wait | 1 | 10 | each 100 ms before the page is usable |

Static measures word, control, choice, field, feature, media and product. Live measures all of them. The arithmetic is `lib/model.mjs` `rollup()` for both, so the two never disagree on how a count becomes points. A repo reprices a unit in `.pricecheck.json`: `{ "weights": { "control": 1 } }`.

</details>

<details><summary>Commands</summary>

```
node pricecheck/bin/pricecheck.mjs scan    [--root <repo>] [--json]   every page, most expensive first
node pricecheck/bin/pricecheck.mjs scan    [--by app] [--json]        per app: points, pages and dearest page, dearest app first
node pricecheck/bin/pricecheck.mjs page    <file> [--root <repo>]     one page and the file each point comes from
        [--tree [--depth N] [--min P]]                                  the render tree, each component with its points
node pricecheck/bin/pricecheck.mjs diff    [--root <repo>]            what the working tree's changes cost
node pricecheck/bin/pricecheck.mjs check   [--root <repo>]            exit 1 on an unreasoned rise or an unfrozen page
node pricecheck/bin/pricecheck.mjs freeze  [--root <repo>] [--reason "<why>"]
node pricecheck/bin/pricecheck.mjs live    <url> [--cdp <endpoint>]   price the rendered page
```

</details>

<details><summary>Files</summary>

- `lib/model.mjs`: the price list and the rollup. Every measurer emits items `{ unit, count, file, line?, note? }` and nothing else.
- `lib/static/`: page discovery, template reading per framework, the component graph, the static measurer and its CLI.
- `lib/static/i18n.mjs`: the English catalogs (JSON and TS/JS message modules under any `locales`, `locale`, `i18n`, `lang` or `messages` folder, with an `en`, `en-US` or `en-GB` folder or file), so a translated key counts the words a reader sees. In a monorepo a page reads the catalog nearest to it.
- `lib/static/conditions.mjs`: what a template condition is worth given the props at the call site (true, false or unknown).
- `lib/live/`: the in-page measuring script and a dependency-free Chrome DevTools Protocol client.
- `lib/ledger.mjs`: the baseline, the ratchet, views weighting.
- `bin/pricecheck.mjs`: hands each command to the measurer that answers it.

</details>

<details><summary>Tools</summary>

The MCP tools in `server/src/mcp-pricecheck.ts`. Each runs the CLI once against the calling folder's checkout, inside the call budget.

- `price_check` (listed): `mode` scan, page, diff or check. Scan appends a snapshot to the history.
- `price_check_next`: the page to trim next, with a brief a worker can run as it is, and the progress since the first snapshot.
- `price_check_live`: prices a page as a real browser renders it. Read-only; `url` must be http or https.
- `price_check_freeze` (MUTATES): freezes every page's price as the baseline in `.pricecheck/baseline.json`.
- `price_check_report` (MUTATES): writes `price/index.html` into the project's dashboard and returns its url. Nothing else is written.

History lives at `<PRICECHECK_HOME or ~/.agenthydra/pricecheck>/history.jsonl`, one line per distinct scan, appended and never rewritten.

</details>

<details><summary>Repo config (.pricecheck.json, all optional)</summary>

```json
{
  "pages": ["src/views/**/*.vue"],
  "ignore": ["**/*.stories.*"],
  "alias": { "@": "src" },
  "weights": { "control": 1 },
  "productOrigins": ["https://other-product.example.com"],
  "budgets": { "src/views/SignIn*.vue": 40 }
}
```

`pages` overrides page discovery. `alias` adds import aliases beyond those read from `tsconfig.json` / `vite.config.*`. `productOrigins` names the other products whose links count as pushes. `budgets` caps a page's price outright, on top of the ratchet.

</details>

<details><summary>Price tag hook</summary>

A Claude Code `PostToolUse` hook (`hook/price-tag.mjs`) prices each UI edit as it is made. After an `Edit`, `Write` or `MultiEdit` of a `.vue`, `.tsx`, `.jsx`, `.svelte`, `.html` or `.astro` file, or of a `.json`/`.ts`/`.js` file under a `locales`, `locale`, `i18n`, `lang` or `messages` folder, it runs `pricecheck diff --against HEAD` on that file. If a page's price moved, the model gets a note like this for a two-page change:

```
Price check: this edit makes src/views/SignIn.vue 40 -> 52 points (+12: +9 words, +2 controls in src/views/SignIn.vue).
Price check: this edit makes src/views/Home.vue 52 -> 45 points, cheaper (-7: -6 words, -1 control in src/views/Home.vue).
Every point is attention the person pays; cheaper wins. pricecheck page src/views/SignIn.vue shows the whole bill.
```

- Other files cost nothing: no git call, no CLI run. A CLI error, a timeout (6 s, the process tree is killed) or an unchanged price prints nothing. The hook never exits non-zero and never blocks an edit.
- At most three pages are named; with more, two are named and the rest are a `+N more pages` line.
- Kill switch: `PRICECHECK_HOOK=off`, or a file named `hook-off` in `PRICECHECK_HOME` (default `~/.agenthydra/pricecheck`).
- `PRICECHECK_CLI` points the hook at another CLI script (the tests use a stub).
- Install into `~/.claude/settings.json` (or `--settings <path>`); it writes a `.bak-<ms>` copy before any change and leaves every other hook alone:

```
node pricecheck/hook/install.mjs              install (idempotent)
node pricecheck/hook/install.mjs --status     installed or not
node pricecheck/hook/install.mjs --uninstall  remove only this entry
```

Tests: `bun test ./pricecheck/test/hook`.

</details>
