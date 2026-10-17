// The daemon that starts a run under a runner and then exits (orchestrator-move-outlives-daemon.test.ts):
// it starts an operation on a stub toolbox, prints the operation id, waits until the script is
// running, and exits the way a restarting daemon does.
//
// Usage: bun orchestrator-move-daemon.ts <toolbox dir> <marker path> [script] [extra args JSON] [then]
// The script defaults to migrate_chat; the extra args are a JSON array. `then` is what this daemon
// does last:
//   exit     exits once the script runs (the default);
//   cancel   asks the operation to stop, then exits in the same tick, before its watch reads the end;
//   preempt  first starts a holder run of the same script and args, then the operation with
//            --terminate-live added, which takes the route from it; it prints the operation's id and
//            then the holder's, and exits once the operation's script runs.
import { existsSync } from 'node:fs'
import { cancelOrchestratorOperation, startOrchestratorOperation } from '../../src/orchestrator'

const [dir, marker, script = 'migrate_chat', extra = '[]', then = 'exit'] = process.argv.slice(
  2,
) as [string, string, string?, string?, string?]
const args: string[] = JSON.parse(extra)

async function startedBy(path: string): Promise<boolean> {
  const until = Date.now() + 60_000
  while (!existsSync(`${path}.started`) && Date.now() < until) await Bun.sleep(100)
  return existsSync(`${path}.started`)
}

const start = (more: string[], path: string) =>
  startOrchestratorOperation(
    { script, args: [...args, ...more, '--marker', path], timeoutMs: 120_000 },
    { deps: { dir } },
  ).op

let holder: string | null = null
if (then === 'preempt') {
  holder = start([], `${marker}.holder`).id
  if (!(await startedBy(`${marker}.holder`))) process.exit(4)
}
const op = start(then === 'preempt' ? ['--terminate-live'] : [], marker)
console.log(op.id)
if (holder) console.log(holder)
if (!(await startedBy(marker))) process.exit(3)
if (then === 'cancel') cancelOrchestratorOperation(op.id)
process.exit(0)
