// Import first in any test that prices a fixture: it points PRICECHECK_HOME at a fresh temp dir so the reach cache,
// history and advice logs never land in the real ~/.agenthydra/pricecheck. Importing it twice in one process is a no-op.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const testHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-testhome-'))

process.env.PRICECHECK_HOME = testHome()
