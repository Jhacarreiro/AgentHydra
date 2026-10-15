# The SUE course

A folder of small web pages, each hard for a visitor in one way, some with exactly one planted
product bug. SUE is otherwise graded on one fixture events app and live sites; here every page's
answer is known, so a wave says what SUE can and cannot do. Every page has a deterministic twin
that does the task with plain Playwright locators: a page the twin finishes is a page a Sue can
finish, so a Sue failing there is SUE's failure, not the page's.

## The page contract

Each page is a folder `site/<slug>/` holding:

- `index.html`: plain HTML, CSS and JS. No build step, no framework, no network.
- `page.json`:
  `{ slug, title, surface, task, success: { text }, plantedBug, credit }`
  - `surface`: one line, what is hard here.
  - `task`: one plain sentence, what a visitor came to do.
  - `success.text`: words on screen once the task is done; `null` only on a bug page with no success state.
  - `plantedBug`: `null`, or `{ what, keywords }`: one sentence, and the words a visitor's complaint about it would contain.
  - `credit`: `adapted from tester-army/e2e apps/web-benchmark/app/src/Examples/<File>.tsx (Apache-2.0, Copyright TesterArmy)`.
- `twin.mjs`: `export async function solve(page, url)` does the task with playwright-core locators;
  a bug page also exports `async function showsBug(page, url)`, true when the bug is on screen.
  The spec looks for `success.text` in the page's visible words, its painted CSS `content`, and alt,
  aria-label and title; a page that paints it in pixels only (an image, a canvas) also exports
  `async function paintedSuccess(page)`, true when that painted success is on screen.

A planted bug is never fixed, and never named on the page, in the scenario or on the home page.

## Running it

```
node sue/course/serve.mjs                    # http://127.0.0.1:4620/ lists every page folder found
node sue/course/course.mjs scenarios         # .sue/scenarios/<slug>.json for every page
node sue/course/course.mjs list              # each page folder and what is wrong with it
node --test sue/tests/course.spec.mjs        # page.json valid, solve() and showsBug() pass (node, never bun)
```

A wave on one page, with the server up (the target is `.sue/target.json`, the scenario id is the
page's slug, and the scenario's `startPath` opens her on that page):

```
node sue/sue.mjs run --json '{"target":"sue/course/.sue/target.json","scenario":"cart-totals","count":4}'
node sue/course/course.mjs score <run id>
```

`score` reads `sue/runs/<run id>/` and prints, then writes `course-score.json` there: per
page **reached** (a Sue saw `success.text` on that page, or, with none, called done there),
**gave-up** (visited, never reached) or **never-visited**; per planted bug **found** (a line she
wrote on that page contains one of its keywords) or **missed**.

A new page needs no shared edit: add the folder, run `course.mjs scenarios`, and the home page,
the spec and the scorer find it.

## Credit

The pages are re-implemented from [tester-army/e2e](https://github.com/tester-army/e2e)
`apps/web-benchmark` (Apache-2.0, Copyright TesterArmy): each page keeps that scenario's task, trap
and planted bug; no code was copied. Each `page.json` names the file it was adapted from.
