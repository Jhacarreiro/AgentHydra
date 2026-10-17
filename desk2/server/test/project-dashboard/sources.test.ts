// What a section says when its MCP tool refuses: the tool's own reason, read out of a JSON failure envelope when it
// sends one, so the page never shows the envelope's braces and keys to the person.
import { expect, test } from 'bun:test'
import { feedFromToolResult } from '../../src/project-dashboard/sources'

const refusal = (text: string) => ({ isError: true, content: [{ type: 'text', text }] })

test("a refusal reads as the tool's own words, from its envelope's detail or as it came", () => {
  const envelope = JSON.stringify({ error: 'unknown_local_tool', detail: 'unknown local tool: dashboard. Search the catalog for the right name.' }, null, 2)
  expect(() => feedFromToolResult(refusal(envelope))).toThrow('the tool refused: unknown local tool: dashboard. Search the catalog for the right name.')
  expect(() => feedFromToolResult(refusal(JSON.stringify({ error: 'not_signed_in' })))).toThrow('the tool refused: not_signed_in')
  expect(() => feedFromToolResult(refusal('The service is down for maintenance.'))).toThrow('the tool refused: The service is down for maintenance.')
})
