import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatPaths } from '../src/hydra-core/paths'

export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-core-'))
  process.env.AGENTHYDRA_CORE_DIR = dir
  const persona = join(dir, 'persona-iris.md')
  const notes = join(dir, 'brand-notes.md')
  writeFileSync(persona, 'Iris Example: full persona text.\n')
  writeFileSync(notes, 'Brand notes: full text.\n')
  const entries = [
    {
      id: 'person:iris-ui',
      kind: 'person',
      name: 'Iris Example',
      title: 'UI designer',
      tier: 'employee',
      when: 'Designs dashboard layouts and styling',
      tags: ['dashboard', 'layout'],
      modes: ['become', 'consult', 'hire'],
      cost: 'low',
      how: 'ask her to sketch the layout',
      load: { type: 'file', path: persona },
    },
    {
      id: 'person:ops-lead',
      kind: 'person',
      name: 'Oscar Example',
      tier: 'manager',
      when: 'Runs the release checklist',
      tags: ['release'],
      modes: ['become'],
      cost: 'medium',
      how: 'hand him the release list',
      load: { type: 'none' },
    },
    {
      id: 'instrument:screen-capture',
      kind: 'instrument',
      name: 'Screen Capture',
      when: 'Takes headless screenshots of a url',
      tags: ['screenshot'],
      cost: 'free',
      how: 'run the capture tool on a url',
      load: { type: 'tool', call: 'capture --url <url>' },
    },
    {
      id: 'knowledge:brand-notes',
      kind: 'knowledge',
      name: 'Brand Notes',
      when: 'Colours and type rules for the dashboard',
      tags: ['brand'],
      cost: 'free',
      how: 'read the brand notes',
      load: { type: 'file', path: notes },
    },
  ]
  mkdirSync(join(dir, 'catalog'), { recursive: true })
  writeFileSync(join(dir, 'catalog', 'hand-fixture.json'), JSON.stringify(entries))
  return dir
}

export function startChat(dir: string, chat: string, message: string): void {
  const files = chatPaths(dir, chat)
  mkdirSync(files.root, { recursive: true })
  writeFileSync(files.prompt, message)
}
