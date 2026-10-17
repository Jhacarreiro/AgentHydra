// server/tests/codex-owner-agents.test.ts — a Codex instance gets the owner's AGENTS.md and keeps its own.
//
// Both homes are scratch folders: the owner's stands in for the default `~/.codex`, the instance's for
// `~/.agenthydra/codex-instances/<id>`.

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncOwnerAgents } from '../src/core/codex-owner-agents'

const scratch = mkdtempSync(join(tmpdir(), 'codex-owner-agents-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function homes(name: string): { owner: string; instance: string } {
  const owner = join(scratch, name, 'owner')
  const instance = join(scratch, name, 'instance')
  mkdirSync(owner, { recursive: true })
  mkdirSync(instance, { recursive: true })
  return { owner, instance }
}

const agents = (home: string) => readFileSync(join(home, 'AGENTS.md'), 'utf8')

test("an instance gets the owner's AGENTS.md, follows the owner's edits, and never loses one of its own", () => {
  const { owner, instance } = homes('follow')
  writeFileSync(join(owner, 'AGENTS.md'), '# Rules\n\n- Never edit a deploy checkout.\n')

  expect(syncOwnerAgents(owner, instance)).toBe('copied')
  expect(agents(instance)).toBe(agents(owner))
  expect(syncOwnerAgents(owner, instance)).toBe('unchanged')

  writeFileSync(
    join(owner, 'AGENTS.md'),
    '# Rules\n\n- Never edit a deploy checkout.\n- Land with one command.\n',
  )
  expect(syncOwnerAgents(owner, instance)).toBe('copied')
  expect(agents(instance)).toContain('Land with one command.')

  // The instance's own words are not in the owner's file: they stay, whatever the owner writes next.
  writeFileSync(join(instance, 'AGENTS.md'), '# This account only\n\n- Answer in French.\n')
  writeFileSync(join(owner, 'AGENTS.md'), '# Rules\n\n- A third rule.\n')
  expect(syncOwnerAgents(owner, instance)).toBe('kept-own')
  expect(agents(instance)).toBe('# This account only\n\n- Answer in French.\n')
})

test("a block pasted into the instance that the owner's file already holds is replaced by the whole file", () => {
  const { owner, instance } = homes('subset')
  const block = '<!-- QUESTIONS:START -->\n## Questions are instructions\n<!-- QUESTIONS:END -->'
  writeFileSync(
    join(owner, 'AGENTS.md'),
    `# Rules\n\n- Never edit a deploy checkout.\n\n${block}\n`,
  )
  writeFileSync(join(instance, 'AGENTS.md'), `${block.replace(/\n/g, '\r\n')}\r\n`)

  expect(syncOwnerAgents(owner, instance)).toBe('copied')
  expect(agents(instance)).toBe(agents(owner))
})

test('the owner home itself, or an owner with no AGENTS.md, writes nothing', () => {
  const { owner, instance } = homes('none')
  expect(syncOwnerAgents(owner, instance)).toBe('no-source')
  writeFileSync(join(owner, 'AGENTS.md'), '# Rules\n')
  expect(syncOwnerAgents(owner, owner)).toBe('owner-home')
  expect(existsSync(join(instance, 'AGENTS.md'))).toBe(false)
  expect(existsSync(join(owner, '.agenthydra-owner-agents.json'))).toBe(false)
})
