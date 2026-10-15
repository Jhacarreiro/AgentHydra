// The one loader for in-process add-ons: absent means null and quiet; a module that throws is logged once and is null.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callAddon, loadAddon } from '../src/addon-loader'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'addon-loader-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function addonFile(name: string, source: string): string {
  const file = join(root, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, source)
  return file
}

test('a missing add-on file is null, quietly', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {})
  expect(await callAddon(join(root, 'nope.mjs'), 'answer', {})).toBeNull()
  expect(err).not.toHaveBeenCalled()
  err.mockRestore()
})

test('the named export is called with the host and its answer returned', async () => {
  const file = addonFile('ok.mjs', 'export function answer(host) { return { seen: host.name } }')
  expect(await callAddon<{ seen: string }>(file, 'answer', { name: 'host' })).toEqual({
    seen: 'host',
  })
})

test('a module without the named export is logged once and is null', async () => {
  const file = addonFile('no-export.mjs', 'export const other = 1')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  expect(await callAddon(file, 'answer', {})).toBeNull()
  expect(await callAddon(file, 'answer', {})).toBeNull()
  expect(err).toHaveBeenCalledTimes(1)
  err.mockRestore()
})

test('a factory that throws is logged and is null', async () => {
  const file = addonFile('throws.mjs', "export function answer() { throw new Error('boom') }")
  const err = spyOn(console, 'error').mockImplementation(() => {})
  expect(await callAddon(file, 'answer', {})).toBeNull()
  expect(err).toHaveBeenCalledTimes(1)
  err.mockRestore()
})

test('loadAddon finds the entry in the checkout named by SUE_DREDD_HOME', async () => {
  const checkout = join(root, 'checkout')
  addonFile(
    join('checkout', 'people', 'agenthydra.mjs'),
    'export function peopleAddon() { return 7 }',
  )
  const env = { SUE_DREDD_HOME: checkout }
  expect(await loadAddon<number>('people/agenthydra.mjs', 'peopleAddon', {}, { env })).toBe(7)
  expect(
    await loadAddon(
      'people/agenthydra.mjs',
      'peopleAddon',
      {},
      { env: {}, appRoot: join(root, 'AgentHydra') },
    ),
  ).toBeNull()
})
