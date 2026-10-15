#!/usr/bin/env node
// pricecheck - put a price on every page of a web app. Each command lives with the measurer that answers it:
// lib/static/cli.mjs reads the code, lib/live/cli.mjs reads the rendered page. Each exports run(argv) -> exit code.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const COMMANDS = {
  scan: 'static',
  page: 'static',
  diff: 'static',
  check: 'static',
  freeze: 'static',
  live: 'live',
}

const HELP = `pricecheck <command> [--root <repo>] [options]

  scan            every page, most expensive first
  page <file>     one page's price and the file each point comes from
  diff            what the working tree's changes cost, page by page and file by file
  check           exit 1 when a page got dearer without a written reason, or a page has no frozen price
  freeze          write .pricecheck/baseline.json (prices only fall; --reason "<why>" lets a page rise)
  live <url>      render the page in a real browser and price what is actually on screen

See pricecheck/README.md for the price list.`

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === '--help' || cmd === '-h' || !COMMANDS[cmd]) {
  console.log(HELP)
  process.exit(cmd && !COMMANDS[cmd] && cmd !== '--help' && cmd !== '-h' ? 2 : 0)
}
const cli = path.join(import.meta.dirname, '..', 'lib', COMMANDS[cmd], 'cli.mjs')
const { run } = await import(pathToFileURL(cli).href)
process.exitCode = await run([cmd, ...rest])
