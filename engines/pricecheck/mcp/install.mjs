// `pricecheck install`: registers the MCP server with Claude Code (user scope) and installs the price-tag hook.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultSettingsPath, install as installHook, status as hookStatus } from '../hook/install.mjs'

const NAME = 'pricecheck'
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pricecheck.mjs')
const EXTENSIONS = ['.exe', '.cmd', '.bat', '']
export const REGISTRATION_LINE = `claude mcp add --scope user ${NAME} -- node "${BIN}" mcp`

function findClaude(env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of EXTENSIONS) {
      const file = join(dir, `claude${ext}`)
      if (existsSync(file)) return file
    }
  }
  return null
}

function claude(file, args) {
  if (!/\.(cmd|bat)$/i.test(file)) return spawnSync(file, args, { encoding: 'utf8', windowsHide: true })
  const line = [file, ...args].map((part) => `"${part}"`).join(' ')
  return spawnSync(line, { encoding: 'utf8', windowsHide: true, shell: true })
}

export function install(argv, { env = process.env, out = (line) => console.log(line) } = {}) {
  const settingsPath = defaultSettingsPath(env)
  if (argv.includes('--dry-run')) {
    out(REGISTRATION_LINE)
    const { installed } = hookStatus({ settingsPath })
    out(`price tag hook: ${installed ? 'already installed' : 'would be installed'} (${settingsPath})`)
    return 0
  }

  const file = findClaude(env)
  if (!file) {
    out(`claude is not on PATH. Run this line yourself, then run pricecheck install again:\n${REGISTRATION_LINE}`)
  } else {
    const have = claude(file, ['mcp', 'get', NAME])
    if (have.status === 0 && String(have.stdout).includes(BIN)) {
      out('pricecheck is already registered with claude (user scope)')
    } else if (have.status === 0) {
      out(
        `pricecheck is registered with claude, but for another command. Remove it with \`claude mcp remove --scope user ${NAME}\`, then run pricecheck install again.`,
      )
      return 1
    } else {
      const added = claude(file, ['mcp', 'add', '--scope', 'user', NAME, '--', 'node', BIN, 'mcp'])
      if (added.status !== 0) {
        out(`claude mcp add failed: ${(added.stderr || added.stdout).trim()}\nRun this line yourself:\n${REGISTRATION_LINE}`)
        return 1
      }
      out(`registered pricecheck with claude (user scope): ${REGISTRATION_LINE}`)
    }
  }

  const hook = installHook({ settingsPath })
  out(`price tag hook: ${hook.changed ? 'installed' : 'already up to date'} (${hook.settingsPath})`)
  return 0
}
