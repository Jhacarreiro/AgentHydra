import { expect, test } from 'bun:test'
import { computed, ref, shallowRef } from 'vue'
import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import { useFreeThreadRows } from './useFreeThreadRows'

const account = (fields: Partial<FreeInstance> = {}): FreeInstance => ({
  id: 'example-account', num: 2, provider: 'chatgpt', name: 'Example account', autoName: false,
  loggedIn: true, checkedAt: 1, lastSignedInAt: 1, lastActiveAt: null, usage: null, ...fields,
})
const thread = (fields: Partial<FreeThread> = {}): FreeThread => ({
  id: 'example-account/example-chat', instanceId: 'example-account', chatId: 'example-chat',
  provider: 'chatgpt', title: 'Synthetic private chat', status: 'done',
  createdAt: 1, updatedAt: 2, error: null, ...fields,
})

test('worker-only refreshes retain all Free projection objects and their arrays', () => {
  let projections = 0
  const history = shallowRef(Array.from({ length: 36_000 }, (_, index) => ({ ...thread({
    id: `example-account/synthetic-${index}`, chatId: `synthetic-${index}`,
  }), get title() { projections++; return `Synthetic private chat ${index}` } })))
  const instances = ref([account()])
  const free = useFreeThreadRows(history, instances)
  const local = shallowRef([{ id: 'local-0' }])
  const remote = shallowRef([{ id: 'remote-0' }])
  const merged = computed(() => [...local.value, ...remote.value, ...free.value])
  const original = free.value
  const first = original[0]!
  const emptyArrays = [first.pending, first.attempts, first.verdicts] as const
  expect(projections).toBe(36_000)
  for (let update = 1; update <= 30; update++) {
    local.value = [{ id: `local-${update}` }]
    remote.value = [{ id: `remote-${update}` }]
    expect(merged.value).toHaveLength(36_002)
    expect(merged.value.slice(0, 2).map(row => row.id)).toEqual([`local-${update}`, `remote-${update}`])
    expect(merged.value[2]).toBe(first)
    expect(free.value).toBe(original)
    expect(first.pending).toBe(emptyArrays[0])
    expect(first.attempts).toBe(emptyArrays[1])
    expect(first.verdicts).toBe(emptyArrays[2])
  }
  expect(projections).toBe(36_000)
  expect(first.free).toBe(history.value[0]!)
})

test('reactive in-place thread/account edits refresh status, identity and displayed fields', () => {
  const history = ref([thread()])
  const instances = ref([account()])
  const free = useFreeThreadRows(history, instances)
  const original = free.value
  history.value[0]!.title = 'Synthetic changed title'
  history.value[0]!.status = 'failed'
  history.value[0]!.error = 'Synthetic interrupted operation'
  history.value[0]!.updatedAt = 9
  history.value[0]!.provider = 'claude'
  instances.value[0]!.name = 'Renamed example account'
  instances.value[0]!.num = 7
  expect(free.value).not.toBe(original)
  expect(free.value[0]).toMatchObject({ id: 'free:example-account/example-chat',
    title: 'Synthetic changed title', status: 'failed', error: 'Synthetic interrupted operation',
    updatedAt: 9, model: 'Claude · Incognito', account: '#7 Renamed example account' })
  expect(free.value[0]!.free).toBe(history.value[0]!)
  history.value[0]!.instanceId = 'other-account'
  expect(free.value[0]!.account).toBeNull()
  instances.value.push(account({ id: 'other-account', num: 8, name: 'Other example account' }))
  expect(free.value[0]!.account).toBe('#8 Other example account')
  instances.value = []
  expect(free.value[0]!.account).toBeNull()
})

test('history replacement keeps source ordering, running filters and selected chat identity current', () => {
  const first = thread({ id: 'example-account/first', chatId: 'first', createdAt: 1 })
  const second = thread({ id: 'example-account/second', chatId: 'second', createdAt: 3, status: 'running' })
  const history = shallowRef([first, second])
  const free = useFreeThreadRows(history, ref([account()]))
  const local = shallowRef([{ ...free.value[0]!, id: 'local', createdAt: 2, free: undefined }])
  const rows = computed(() => [...local.value, ...free.value])
  const listed = computed(() => [...rows.value].sort((a, b) => b.createdAt - a.createdAt))
  const active = computed(() => rows.value.filter(row => row.status === 'running'))
  const selected = computed(() => rows.value.find(row => row.id === 'free:example-account/second'))
  expect(listed.value.map(row => row.id)).toEqual(['free:example-account/second', 'local', 'free:example-account/first'])
  expect(active.value.map(row => row.id)).toEqual(['free:example-account/second'])
  const updated = { ...second, title: 'Synthetic completed title', status: 'done' as const, updatedAt: 10 }
  history.value = [updated, first]
  expect(free.value.map(row => row.free)).toEqual([updated, first])
  expect(selected.value).toMatchObject({ id: 'free:example-account/second',
    title: 'Synthetic completed title', status: 'done', updatedAt: 10 })
  expect(selected.value!.free).toBe(updated)
  expect(active.value).toEqual([])
  expect(listed.value.map(row => row.id)).toEqual(['free:example-account/second', 'local', 'free:example-account/first'])
  expect(history.value).toEqual([updated, first])
  history.value = [first]
  expect(selected.value).toBeUndefined()
})

test('unrelated account quota/job metadata does not invalidate Free display projections', () => {
  let projections = 0
  const history = shallowRef([{ ...thread(), get title() { projections++; return 'Synthetic private chat' } }])
  const instances = ref([account()])
  const free = useFreeThreadRows(history, instances)
  const original = free.value
  instances.value[0]!.checkedAt = 5
  instances.value[0]!.loggedIn = false
  instances.value[0]!.plan = 'plus'
  instances.value[0]!.usage = { available: false, is_snapshot: false,
    observed_at: null, note: 'Synthetic quota unavailable', windows: [] }
  expect(free.value).toBe(original)
  expect(projections).toBe(1)
  instances.value[0]!.name = 'Changed example account'
  expect(free.value).not.toBe(original)
  expect(free.value[0]!.account).toBe('#2 Changed example account')
  expect(projections).toBe(2)
})
