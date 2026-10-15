// Import first in any test that reconciles or records feedback: lessons would otherwise land in the real pricecheck/lessons folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PRICECHECK_LESSONS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lessons-home-'))
