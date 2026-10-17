import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  createRenderer,
  defineComponent,
  effectScope,
  h,
  KeepAlive,
  nextTick,
  onActivated,
  ref,
  type App,
  type EffectScope,
} from 'vue'
import type { FreeThread } from '@desk/shared/free-instances'
import { freeApi } from '@/lib/free-instances'
import { useFreeInstances } from './useFreeInstances'

type Node = { parent: Node | null; children: Node[]; text: string }
const node = (text = ''): Node => ({ parent: null, children: [], text })
function remove(child: Node) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
  child.parent = null
}
// Actual Vue KeepAlive lifecycle, with an invented renderer and no DOM/browser.
const renderer = createRenderer<Node, Node>({
  createElement: () => node(),
  createText: node,
  createComment: node,
  patchProp: () => {},
  insert(child, parent, anchor) {
    remove(child)
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(at < 0 ? parent.children.length : at, 0, child)
    child.parent = parent
  },
  remove,
  setText: (target, text) => {
    target.text = text
  },
  setElementText: (target, text) => {
    target.text = text
    target.children = []
  },
  parentNode: (target) => target.parent,
  nextSibling: (target) =>
    target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
})

const apps: App[] = []
const scopes: EffectScope[] = []
const pending: Promise<unknown>[] = []
const releases: (() => void)[] = []
const spies: { mockRestore(): unknown }[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  for (const scope of scopes.splice(0)) scope.stop()
  for (const release of releases.splice(0)) release()
  await nextTick()
  await Promise.allSettled(pending.splice(0))
  for (const spy of spies.splice(0)) spy.mockRestore()
}, 30_000)

function fixture(count = 1) {
  let version = 1
  let hold: Promise<{ threads: FreeThread[] | null; version: string | null }> | null = null
  const current = () => ({
    version: `"synthetic-lease-${version}"`,
    threads: [
      {
        id: 'example-account/example-chat',
        instanceId: 'example-account',
        chatId: 'example-chat',
        provider: 'claude' as const,
        title: `Synthetic history ${version}`,
        status: 'done' as const,
        error: null,
        createdAt: 1,
        updatedAt: version,
      },
    ],
  })
  const status = spyOn(freeApi, 'status').mockResolvedValue({
    ready: true,
    instances: [],
    jobs: [],
    running: 0,
    threadCounts: {},
  })
  const history = spyOn(freeApi, 'changedThreads').mockImplementation(async () => hold ?? current())
  const start = spyOn(freeApi, 'start').mockRejectedValue(
    new Error('No provider operation is permitted.'),
  )
  spies.push(status, history, start)
  const visible = Array.from({ length: count }, () => ref(true))
  const free = useFreeInstances()
  const Reader = defineComponent({
    setup() {
      const page = useFreeInstances({ threads: true })
      // Matches CliMayteView: its load hook follows the composable's activation hook.
      onActivated(() => {
        pending.push(page.refreshFree({ silent: true }))
      })
      return () => h('history-reader')
    },
  })
  const Hidden = defineComponent({ setup: () => () => h('other-view') })
  const Root = defineComponent({
    setup: () => () =>
      h(
        'root',
        visible.map((shown, i) =>
          h(
            KeepAlive,
            { key: i },
            {
              default: () =>
                shown.value ? h(Reader, { key: 'reader' }) : h(Hidden, { key: 'hidden' }),
            },
          ),
        ),
      ),
  })
  const app = renderer.createApp(Root)
  apps.push(app)
  return {
    app,
    free,
    history,
    status,
    start,
    visible,
    current,
    mount: () => app.mount(node()),
    change: () => {
      version++
    },
    pause() {
      let release!: (value: ReturnType<typeof current>) => void
      hold = new Promise((resolve) => {
        release = resolve
      })
      releases.push(() => release(current()))
      return () => {
        release(current())
        hold = null
      }
    },
  }
}

async function settle() {
  await nextTick()
  await Promise.all(pending.splice(0))
  await nextTick()
}

test('a kept hidden history reader stops warm history requests and catches up once on activation', async () => {
  const f = fixture()
  f.mount()
  await settle()
  expect(f.history).toHaveBeenCalledTimes(1)
  expect(f.free.threads.value[0]?.title).toBe('Synthetic history 1')
  f.visible[0]!.value = false
  await nextTick()
  f.change()
  for (let i = 0; i < 30; i++) await f.free.refreshFree({ silent: true })
  expect(f.history).toHaveBeenCalledTimes(1)
  expect(f.free.threads.value[0]?.title).toBe('Synthetic history 1')
  f.visible[0]!.value = true
  await settle()
  expect(f.history).toHaveBeenCalledTimes(2)
  expect(f.history.mock.calls[1]?.[0]).toBe('"synthetic-lease-1"')
  expect(f.free.threads.value[0]?.title).toBe('Synthetic history 2')
  expect(f.start).toHaveBeenCalledTimes(0)
})

test('concurrent kept readers and effect scopes release independently without a double decrement', async () => {
  const f = fixture(2)
  f.mount()
  await settle()
  expect(f.history).toHaveBeenCalledTimes(1)
  f.visible[0]!.value = false
  await nextTick()
  await f.free.refreshFree({ silent: true })
  expect(f.history).toHaveBeenCalledTimes(2)
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useFreeInstances({ threads: true }))
  f.visible[1]!.value = false
  await nextTick()
  // Disposal after deactivation must not consume the scope's independent lease.
  f.app.unmount()
  apps.splice(apps.indexOf(f.app), 1)
  await nextTick()
  await f.free.refreshFree({ silent: true })
  expect(f.history).toHaveBeenCalledTimes(3)
  scope.stop()
  scopes.splice(scopes.indexOf(scope), 1)
  scope.stop()
  await f.free.refreshFree({ silent: true })
  expect(f.history).toHaveBeenCalledTimes(3)
  expect(f.start).toHaveBeenCalledTimes(0)
})

test('deactivation preserves an in-flight shared history read through reactivation', async () => {
  const f = fixture()
  const release = f.pause()
  f.mount()
  await nextTick()
  expect(f.history).toHaveBeenCalledTimes(1)
  f.visible[0]!.value = false
  await nextTick()
  pending.push(f.free.refreshFree({ silent: true }))
  f.change()
  f.visible[0]!.value = true
  await nextTick()
  expect(f.history).toHaveBeenCalledTimes(1)
  release()
  await settle()
  expect(f.history).toHaveBeenCalledTimes(1)
  expect(f.free.threads.value[0]?.title).toBe('Synthetic history 2')
  f.visible[0]!.value = false
  await nextTick()
  await f.free.refreshFree({ silent: true })
  expect(f.history).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(0)
})
