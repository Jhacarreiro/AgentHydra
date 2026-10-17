// server/tests/orchestrator-moves-chats.test.ts: which orchestrator runs act on chats at length,
// and so run under a runner that outlives the daemon (orchestrator.ts outlivesDaemon).
//
// WHAT IT CATCHES: a run that acts on chats one after another but is missing from the predicate
// runs as the daemon's own child and dies with a restart, half-way (PR #14 for moves; 2026-10-17 for
// archiving and delivering sweeps and fan_out). The false rows catch the opposite: a plan-only or
// read-only run taken under a runner, which changes its cancel, adoption and route-lock behaviour
// for nothing. Each row matches the script's own argv handling (see the comment on outlivesDaemon).
import { expect, test } from 'bun:test'
import { outlivesDaemon } from '../src/orchestrator'

const SPAWN = ['--spec', '{"tasks": []}', '--group-id', 'fo-example', '--json']

const ACTS: Array<[string, string[]]> = [
  ['migrate_batch', ['--all-unarchived', '--from', 'example-account']],
  ['migrate_chat', ['--search', 'example chat', '--to', 'example-account']],
  ['chats', ['--move-to', 'example-account', '--yes']],
  ['groundskeeper', ['--yes']],
  ['groundskeeper', ['--yes', '--only-evacuate']],
  ['sweep', ['--yes', '--moves']],
  ['sweep', ['--yes', '--land-console']],
  ['sweep', ['--yes', '--archive']],
  ['sweep', ['--yes', '--deliver']],
  ['sweep', ['--yes', '--all']],
  ['loop', ['--live']],
  ['undo', ['mutation-1']],
  ['migrate_reconcile', ['--reverse', 'mutation-1']],
  ['fan_out', SPAWN],
  ['fan_out', ['send', 'fo-example', '--text', 'example follow-up', '--json']],
  ['fan_out', ['recover', 'fo-example', '--json']],
  ['fan_out', ['delete', 'fo-example', '--json']],
]

const PLAN_OR_READ: Array<[string, string[]]> = [
  ['chats', []],
  ['chats', ['--move-to', 'example-account']],
  ['groundskeeper', []],
  ['groundskeeper', ['--yes', '--only-archive']],
  ['sweep', ['--moves']],
  ['sweep', ['--archive']],
  ['sweep', ['--all']],
  ['sweep', ['--yes']],
  ['loop', []],
  ['migrate_reconcile', []],
  ['fan_out', [...SPAWN, '--dry-run']],
  ['fan_out', ['status', 'fo-example', '--json']],
  ['fan_out', ['list', '--json']],
  ['fan_out', ['beacon', 'fo-example', '--json']],
]

test.each(ACTS)('%s %j acts on chats at length, so it runs under a runner', (script, args) => {
  expect(outlivesDaemon(script, args)).toBe(true)
})

test.each(PLAN_OR_READ)(
  '%s %j only plans or reads, so it stays the daemon child',
  (script, args) => {
    expect(outlivesDaemon(script, args)).toBe(false)
  },
)
