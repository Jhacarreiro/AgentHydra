#!/usr/bin/env node
// pricecheck - put a price on every page of a web app. Each command lives with the measurer that answers it:
// lib/static/cli.mjs reads the code, lib/live/cli.mjs reads the rendered page. Each exports run(argv) -> exit code.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { recordCall } from '../lib/advice/log.mjs'

const COMMANDS = {
  scan: 'static',
  page: 'static',
  diff: 'static',
  check: 'static',
  freeze: 'static',
  next: 'static',
  live: 'live',
  advice: 'advice',
  feedback: 'advice',
}

const HELP = `pricecheck <command> [--root <repo>] [options]

  scan            every page, most expensive first
  page <file>     one page's price and the file each point comes from
  diff            what the working tree's changes cost, page by page and file by file
  check           exit 1 when a page got dearer without a written reason, or a page has no frozen price
  freeze          write .pricecheck/baseline.json (prices only fall; --reason "<why>" lets a page rise)
  next            the page or shared file to trim next, with a brief a worker can run as it is
  live <url>      render the page in a real browser and price what is actually on screen
  advice          the advice pricecheck gave for this repo, and whether it held up (--all, --json, --shared for every PC's lessons)
  feedback        say advice was wrong (--verdict wrong|undone|right --claim "<what>" [--advice <id>])
  mcp             serve the price_check tools over MCP on stdio (what Claude Code runs)
  install         register that server with Claude Code and install the price-tag hook (--dry-run)

See pricecheck/README.md for the price list.`

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'mcp') {
  const { serve } = await import('../mcp/server.mjs')
  const { priceCheckTools } = await import('../mcp/tools.mjs')
  await serve({ tools: priceCheckTools() })
} else if (cmd === 'install') {
  const { install } = await import('../mcp/install.mjs')
  process.exitCode = install(rest)
} else {
  if (!cmd || cmd === '--help' || cmd === '-h' || !COMMANDS[cmd]) {
    console.log(HELP)
    process.exit(cmd && !COMMANDS[cmd] && cmd !== '--help' && cmd !== '-h' ? 2 : 0)
  }
  const cli = path.join(import.meta.dirname, '..', 'lib', COMMANDS[cmd], 'cli.mjs')
  const { run } = await import(pathToFileURL(cli).href)
  const started = performance.now()
  const exit = await run([cmd, ...rest])
  recordCall({ cmd, args: rest, ms: Math.round(performance.now() - started), exit })
  process.exitCode = exit
}
