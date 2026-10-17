// server/tests/orchestrator-moves-chats.test.ts: which orchestrator runs move chats, and so run
// under a runner that outlives the daemon (orchestrator.ts movesChats).
//
// WHAT IT CATCHES: a run that moves chats but is missing from the predicate runs as the daemon's
// own child and dies with a restart, half-way (PR #14). The false rows catch the opposite: a
// plan-only or read-only run taken under a runner, which changes its cancel, adoption and
// route-lock behaviour for nothing. Each row matches the script's own argv handling (see the
// comment on movesChats).
import { expect, test } from 'bun:test'
import { movesChats } from '../src/orchestrator'

const MOVES: Array<[string, string[]]> = [
  ['migrate_batch', ['--all-unarchived', '--from', 'example-account']],
  ['migrate_chat', ['--search', 'example chat', '--to', 'example-account']],
  ['chats', ['--move-to', 'example-account', '--yes']],
  ['groundskeeper', ['--yes']],
  ['groundskeeper', ['--yes', '--only-evacuate']],
  ['sweep', ['--yes', '--moves']],
  ['sweep', ['--yes', '--land-console']],
  ['sweep', ['--yes', '--all']],
  ['loop', ['--live']],
  ['undo', ['mutation-1']],
  ['migrate_reconcile', ['--reverse', 'mutation-1']],
]

const PLAN_ONLY: Array<[string, string[]]> = [
  ['chats', []],
  ['chats', ['--move-to', 'example-account']],
  ['groundskeeper', []],
  ['groundskeeper', ['--yes', '--only-archive']],
  ['sweep', ['--moves']],
  ['sweep', ['--all']],
  ['sweep', ['--yes']],
  ['loop', []],
  ['migrate_reconcile', []],
]

test.each(MOVES)('%s %j moves chats, so it runs under a runner', (script, args) => {
  expect(movesChats(script, args)).toBe(true)
})

test.each(PLAN_ONLY)('%s %j only plans, so it stays the daemon child', (script, args) => {
  expect(movesChats(script, args)).toBe(false)
})
