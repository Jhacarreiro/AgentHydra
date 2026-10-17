// The routines MCP tool (server/src/mcp-routines.ts): the agent may read, run, pause, propose, approve, move and meta, and nothing else. The
// owner's rules are in the description the agent reads, so these tests pin the arguments and the words, not a live Desk.

import { describe, expect, test } from 'bun:test'
import { ROUTINES_TOOLS } from '../server/src/mcp-routines'

const tool = ROUTINES_TOOLS.find((t) => t.name === 'routines')
const schema = tool?.inputSchema as {
  properties: Record<string, { description?: string }>
  additionalProperties: boolean
}

describe('the routines tool arguments', () => {
  test('the tool is named routines, and takes only fresh, run, pause, propose, approve, move and meta', () => {
    expect(tool).toBeDefined()
    expect(Object.keys(schema.properties).sort()).toEqual([
      'approve',
      'fresh',
      'meta',
      'move',
      'pause',
      'propose',
      'run',
    ])
    expect(schema.additionalProperties).toBe(false)
  })

  test('the owner-only actions are not arguments of the agent tool', () => {
    for (const name of ['enabled', 'resume', 'discard', 'edit'])
      expect(schema.properties[name]).toBeUndefined()
  })

  test('each mutating argument is marked MUTATES, and fresh is not', () => {
    expect(schema.properties.run.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.pause.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.propose.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.approve.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.move.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.meta.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.fresh.description).not.toContain('MUTATES')
  })

  test('the meta argument names the group, the campaigns and null for removing either', () => {
    const d = schema.properties.meta.description ?? ''
    expect(d).toContain('group')
    expect(d).toContain('campaigns')
    expect(d).toContain('null')
  })

  test('the propose argument asks for id, why and the contract', () => {
    const d = schema.properties.propose.description ?? ''
    expect(d).toContain('id')
    expect(d).toContain('why')
    expect(d).toContain('windowsTask')
    expect(d).toContain('askedBy')
  })
})

describe('the routines tool description', () => {
  test("carries the owner's standing notes: nothing an agent schedules on its own, and what he asks for it approves itself", () => {
    const d = tool?.description ?? ''
    expect(d).toContain('never schedule anything the owner did not ask for')
    expect(d).toContain('propose')
    expect(d).toContain('temporary background task')
    expect(d).toContain('never hand the click in Settings > Managers > Routines back to him')
    expect(d).toContain('Approve or move only what he asked for in his own words')
    expect(d).toContain("`meta` (sets a routine's group")
  })

  test("says that resume and discard are the owner's alone", () => {
    expect(tool?.description).toContain("Resume and discard are the owner's alone")
  })
})
