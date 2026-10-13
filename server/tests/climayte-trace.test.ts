// The From label of a process that dispatched a CliMayte worker (climayte-trace.ts): the script's folder and
// file, never the command line's flags or the interpreter.
import { describe, expect, test } from 'bun:test'
import { scriptLabel } from '../src/climayte-trace'

describe('scriptLabel names a dispatching process by its script', () => {
  test.each([
    ['python C:\\Users\\me\\tools\\michaiel\\act.py --dry-run --key=abc', 'michaiel/act.py'],
    ['"C:\\Program Files\\nodejs\\node.exe" "D:/work/creaitor/arbiter.py"', 'creaitor/arbiter.py'],
    ['bun /srv/tools/sweep/run.mjs', 'sweep/run.mjs'],
    ['claude.exe --output-format json', null],
    [null, null],
  ])('%s -> %s', (commandLine, label) => {
    expect(scriptLabel(commandLine)).toBe(label)
  })
})
