import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadCatalog, loadText } from './catalog'
import { appendLog } from './log'
import { packFor, readPlaced } from './pack'
import { chatPaths } from './paths'
import { folderKnowledgeOf, mainRules } from './tree'

export type Placement = 'slot' | 'attach' | 'file' | 'off'

/** The `<core>/PLACEMENT` setting; absent or unknown means today's behaviour ('off'). */
export function placementOf(dir: string): Placement {
  const file = resolve(dir, 'PLACEMENT')
  if (!existsSync(file)) return 'off'
  const raw = readFileSync(file, 'utf8').trim()
  return raw === 'slot' || raw === 'file' || raw === 'attach' ? raw : 'off'
}

export interface PlacedChat {
  text: string
  ids: string[]
  chars: number
  hash: string
  reused: boolean
}

function inputsHash(dir: string, cwd: string, hydraMd: string): string {
  const entries = [...loadCatalog(dir).entries.values()]
  const folder = mainRules(folderKnowledgeOf(entries, cwd)).map((e) => ({
    id: e.id,
    text: loadText(e),
  }))
  const lead = existsSync(hydraMd) ? readFileSync(hydraMd, 'utf8') : ''
  return createHash('sha256').update(JSON.stringify({ folder, lead })).digest('hex')
}

/** The prompt line a file chat is given: where its pack is. */
export function packLine(file: string): string {
  return `Before you act on any message, read ${file}: it holds this folder's rules and what you need for this chat.`
}

/** Writes a chat's slot.md or pack.md (reusing it while the folder rules and the hydra.md lead are unchanged) and returns what the prompt gets. */
export function placeChat(
  dir: string,
  req: { chat: string; session: string; cwd: string; prompt: string; placement: 'slot' | 'file' },
  now = new Date(),
): PlacedChat {
  const files = chatPaths(dir, req.chat)
  const target = req.placement === 'slot' ? files.slot : files.pack
  const hash = inputsHash(dir, req.cwd, files.hydraMd)
  const old = readPlaced(files.placed)
  const reused = !!old && old.placement === req.placement && old.hash === hash && existsSync(target)

  let body: string
  let ids: string[]
  if (reused) {
    body = readFileSync(target, 'utf8')
    ids = old ? old.ids : []
  } else {
    const pack = packFor(
      dir,
      {
        chat: req.chat,
        session: `placed:${req.placement}:${req.chat}`,
        cwd: req.cwd,
        prompt: req.prompt,
        full: true,
      },
      now,
    )
    body = pack.text
    ids = pack.ids
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    writeFileSync(
      files.placed,
      JSON.stringify({ placement: req.placement, hash, ids, chars: body.length }, null, 2),
    )
  }

  const text = req.placement === 'slot' ? body : packLine(resolve(target))
  appendLog(
    dir,
    {
      event: 'placement',
      phase: 'launch',
      chat: req.chat,
      session: req.session,
      placement: req.placement,
      chars: text.length,
      ids,
      hash,
      reused,
    },
    now,
  )
  return { text, ids, chars: text.length, hash, reused }
}
