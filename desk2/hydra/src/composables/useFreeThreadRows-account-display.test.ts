import { expect, test } from 'bun:test'
import { computed, ref, shallowRef } from 'vue'
import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import { useFreeThreadRows } from './useFreeThreadRows'

const account = (id: string, num = 1, name = 'Example account'): FreeInstance => ({
  id,
  num,
  name,
  provider: 'claude',
  autoName: false,
  loggedIn: true,
  checkedAt: 1,
  lastSignedInAt: 1,
  lastActiveAt: null,
  usage: null,
})
const thread = (instanceId: string, chatId: string): FreeThread => ({
  id: `${instanceId}/${chatId}`,
  instanceId,
  chatId,
  provider: 'claude',
  title: 'Synthetic private chat',
  status: 'done',
  createdAt: 1,
  updatedAt: 2,
  error: null,
})

test('30 whole-array quota refreshes retain all 37,595 history display rows', () => {
  const count = 37_595
  let projections = 0
  const instances = ref(Array.from({ length: 110 }, (_, i) => account(`account-${i}`, i + 1)))
  const history = shallowRef(
    Array.from({ length: count }, (_, i) => ({
      ...thread(`account-${i % 110}`, `chat-${i}`),
      get title() {
        projections++
        return `Synthetic private chat ${i}`
      },
    })),
  )
  const rows = useFreeThreadRows(history, instances)
  const original = rows.value
  const first = original[0]!
  const last = original.at(-1)!
  const selected = computed(() => rows.value.find((row) => row.id === last.id))
  const merged = computed(() => [{ id: 'local-task' }, ...rows.value])
  const originalMerged = merged.value
  expect(projections).toBe(count)
  for (let update = 1; update <= 30; update++) {
    // This is production snapshot's boundary: a changed account replaces the list.
    instances.value = instances.value.map((instance, i) => ({
      ...instance,
      checkedAt: update + 1,
      loggedIn: update % 2 === 0,
      plan: update % 2 ? 'free' : 'pro',
      usage: {
        available: true,
        is_snapshot: false,
        observed_at: null,
        note: `Synthetic quota reading ${update}/${i}`,
        windows: [],
      },
    }))
    expect(rows.value).toBe(original)
    expect(merged.value).toBe(originalMerged)
    expect(rows.value[0]).toBe(first)
    expect(rows.value.at(-1)).toBe(last)
    expect(selected.value).toBe(last)
    expect(first.free).toBe(history.value[0]!)
    expect(last.free).toBe(history.value.at(-1)!)
  }
  expect(projections).toBe(count)
  expect(first.account).toBe('#1 Example account')
  instances.value[0]!.name = 'Renamed example account'
  const renamed = rows.value
  expect(renamed).not.toBe(original)
  expect(renamed[0]!.account).toBe('#1 Renamed example account')
  expect(projections).toBe(count * 2)
  expect(renamed[0]!.free).toBe(history.value[0]!)
}, 15_000)

test('display changes and membership follow current values after metadata-only replacement', () => {
  const instances = ref([
    account('first', 1, 'First account'),
    account('second', 2, 'Second account'),
  ])
  const history = shallowRef([thread('first', 'a'), thread('second', 'b')])
  const rows = useFreeThreadRows(history, instances)
  const original = rows.value
  instances.value = [account('second', 2, 'Second account'), account('first', 1, 'First account')]
  expect(rows.value).toBe(original)
  expect(rows.value.map((row) => row.free)).toEqual(history.value)
  instances.value[1]!.num = 7
  expect(rows.value[0]!.account).toBe('#7 First account')
  instances.value[1]!.name = 'Renamed first account'
  expect(rows.value[0]!.account).toBe('#7 Renamed first account')
  instances.value = [account('second', 2, 'Second account')]
  expect(rows.value.map((row) => row.account)).toEqual([null, '#2 Second account'])
  instances.value.push(account('first', 8, 'Returned first account'))
  expect(rows.value.map((row) => row.account)).toEqual([
    '#8 Returned first account',
    '#2 Second account',
  ])
})

test('duplicate account IDs keep the last winner while history edits retain their own dependencies', () => {
  let projections = 0
  const first = account('same', 1, 'Shadowed account')
  const last = account('same', 9, 'Winning account')
  const instances = ref([first, last])
  const history = ref([thread('same', 'a'), thread('missing', 'b')])
  const watched = computed(() => {
    projections++
    return history.value
  })
  const rows = useFreeThreadRows(watched, instances)
  const original = rows.value
  expect(rows.value[0]!.account).toBe('#9 Winning account')
  instances.value = [
    { ...first, name: 'Changed shadowed account' },
    { ...last, checkedAt: 99 },
  ]
  expect(rows.value).toBe(original)
  instances.value.reverse()
  expect(rows.value[0]!.account).toBe('#1 Changed shadowed account')
  history.value[0]!.title = 'Changed synthetic title'
  history.value[0]!.status = 'failed'
  history.value[0]!.error = 'Synthetic failure'
  history.value[0]!.updatedAt = 10
  expect(rows.value[0]).toMatchObject({
    title: 'Changed synthetic title',
    status: 'failed',
    error: 'Synthetic failure',
    updatedAt: 10,
    account: '#1 Changed shadowed account',
  })
  const current = history.value[0]!
  history.value = [history.value[1]!, current]
  expect(rows.value.map((row) => row.free)).toEqual(history.value)
  expect(rows.value[1]!.free).toBe(current)
  expect(rows.value[0]!.account).toBeNull()
  expect(projections).toBe(2)
})
