import { describe as group, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { findBrowser, launchBrowser, stopBrowser } from '../../lib/live/cdp.mjs'

const hasBrowser = findBrowser() !== null

group.skipIf(!hasBrowser)('live cdp: browser lifecycle', () => {
  test('a launched browser exposes a DevTools endpoint, and stopping it removes its profile', async () => {
    const browser = await launchBrowser()
    try {
      expect(browser.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\//)
      expect(existsSync(browser.dir)).toBe(true)
    } finally {
      await stopBrowser(browser)
    }
    expect(existsSync(browser.dir)).toBe(false)
    expect(browser.proc.exitCode !== null || browser.proc.signalCode !== null).toBe(true)
  }, 60000)
})

group('live cdp: browser discovery', () => {
  test('findBrowser returns null or an existing file path', () => {
    const found = findBrowser()
    expect(found === null || existsSync(found)).toBe(true)
  })
})
