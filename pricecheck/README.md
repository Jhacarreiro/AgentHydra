# Price check

Everything a person sees on a page costs them something: a word to read, a button to decide about, a banner to dismiss. Price check puts one number on every page of any web app, names the file each point comes from, and holds the line: a page may get cheaper any time, and dearer only with a written reason.

**TL;DR**

- **Any repo.** Vue, React (JSX/TSX), Svelte and plain HTML. No setup to start; `.pricecheck.json` tunes it.
- **Two measurers, one price list.** Static reads the code (the page and every component it renders, in seconds, for gates). Live renders the page in a real browser at desktop and phone width, prices what is actually on screen, and names the component that drew each thing.
- **Every point is attributed.** A page's price is the sum of its files' shares, so "the footer costs 14 of this page's 40" is a fact, not a guess.
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
node pricecheck/bin/pricecheck.mjs page    <file> [--root <repo>]     one page and the file each point comes from
node pricecheck/bin/pricecheck.mjs diff    [--root <repo>]            what the working tree's changes cost
node pricecheck/bin/pricecheck.mjs check   [--root <repo>]            exit 1 on an unreasoned rise or an unfrozen page
node pricecheck/bin/pricecheck.mjs freeze  [--root <repo>] [--reason "<why>"]
node pricecheck/bin/pricecheck.mjs live    <url> [--cdp <endpoint>]   price the rendered page
```

</details>

<details><summary>Files</summary>

- `lib/model.mjs`: the price list and the rollup. Every measurer emits items `{ unit, count, file, line?, note? }` and nothing else.
- `lib/static/`: page discovery, template reading per framework, the component graph, the static measurer and its CLI.
- `lib/live/`: the in-page measuring script and a dependency-free Chrome DevTools Protocol client.
- `lib/ledger.mjs`: the baseline, the ratchet, views weighting.
- `bin/pricecheck.mjs`: hands each command to the measurer that answers it.

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
