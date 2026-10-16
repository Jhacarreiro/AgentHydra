// The native setting (native-program.ts nativeSetting) runs inside Claude Desktop's main process: a chat's model and
// effort set from AgentHydra (owner, 2026-10-15: "I want to ... change it inside Agent Hydra"). Here the shipped expression
// runs against a stand-in of that process, so what it would call in the app, and what it reports, is what is checked.
import { expect, test } from 'bun:test'
import { nativeProgram } from '../src/core/claude-native/native-program'
import { CLI, nativeApp, PROFILE_DIR } from './native-app'

/** An app whose setModel / setEffort record each call and keep what `keep` says the app would keep. */
function desktop(
  session: Record<string, unknown> = {},
  keep = (_field: string, value: string) => value,
) {
  const calls: string[][] = []
  const app = nativeApp(
    { model: 'claude-sonnet-5-5', effort: 'high', ...session },
    {
      setModel: async (id: string, model: string) => {
        calls.push(['setModel', id, model])
        app.chat.model = keep('model', model)
      },
      setEffort: async (id: string, effort: string) => {
        calls.push(['setEffort', id, effort])
        app.chat.effort = keep('effort', effort)
      },
    },
  )
  const set = (s: { model?: string; effort?: string; cliSessionId?: string }) =>
    app.run({ action: 'setting', ...s })
  return { calls, set }
}

test("a chat's model and effort go through the app's own setModel and setEffort, verified by what it keeps", async () => {
  const app = desktop()
  expect(await app.set({ model: 'claude-opus-5-5', effort: 'xhigh' })).toMatchObject({
    ok: true,
    verified: true,
    dispatch: 'sent',
    action: 'setting',
    before: { model: 'claude-sonnet-5-5', effort: 'high' },
    after: { model: 'claude-opus-5-5', effort: 'xhigh' },
  })
  expect(app.calls).toEqual([
    ['setModel', 'local_a', 'claude-opus-5-5'],
    ['setEffort', 'local_a', 'xhigh'],
  ])
})

test('a model kept with a context suffix is the same model; a change the app did not keep is reported with what it kept', async () => {
  const suffixed = desktop({}, (field, value) => (field === 'model' ? `${value}[1m]` : value))
  expect(await suffixed.set({ model: 'claude-opus-5-5' })).toMatchObject({
    ok: true,
    verified: true,
  })

  const clamped = desktop({}, (field, value) => (field === 'effort' ? 'high' : value))
  expect(await clamped.set({ effort: 'max' })).toMatchObject({
    ok: false,
    verified: false,
    dispatch: 'sent',
    reason: 'the app kept claude-sonnet-5-5 at high',
  })
  expect(clamped.calls).toHaveLength(1)
})

test('an archived chat, or a session id no chat holds, is refused before the app is called', async () => {
  const archived = desktop({ isArchived: true })
  expect(await archived.set({ model: 'claude-opus-5-5' })).toMatchObject({
    ok: false,
    refused: true,
    dispatch: 'not-sent',
  })
  expect(archived.calls).toEqual([])

  const app = desktop()
  expect(
    await app.set({ effort: 'low', cliSessionId: '11111111-2222-4333-8444-555555555555' }),
  ).toMatchObject({
    ok: false,
    refused: true,
    dispatch: 'not-sent',
    reason: expect.stringContaining('no chat in this app holds this CLI session'),
  })
  expect(app.calls).toEqual([])
})

test('a setting naming neither a model nor a known effort is never built', () => {
  const base = { action: 'setting' as const, pid: 1, profileDir: PROFILE_DIR, cliSessionId: CLI }
  expect(() => nativeProgram(base)).toThrow('Setting requires a model or an effort')
  expect(() => nativeProgram({ ...base, effort: 'extreme' })).toThrow(
    'Setting requires an effort of',
  )
})
