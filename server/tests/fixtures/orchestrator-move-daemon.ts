// The daemon that starts a chat move and then exits (orchestrator-move-outlives-daemon.test.ts): it
// starts a migrate_chat operation on a stub toolbox, prints the operation id, waits until the script
// is running, and exits the way a restarting daemon does.
//
// Usage: bun orchestrator-move-daemon.ts <toolbox dir> <marker path>
import { existsSync } from 'node:fs'
import { startOrchestratorOperation } from '../../src/orchestrator'

const [dir, marker] = process.argv.slice(2) as [string, string]
const { op } = startOrchestratorOperation(
  { script: 'migrate_chat', args: ['--marker', marker], timeoutMs: 120_000 },
  { deps: { dir } },
)
console.log(op.id)
const until = Date.now() + 60_000
while (!existsSync(`${marker}.started`) && Date.now() < until) await Bun.sleep(100)
process.exit(existsSync(`${marker}.started`) ? 0 : 3)
