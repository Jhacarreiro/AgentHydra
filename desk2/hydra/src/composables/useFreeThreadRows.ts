import { computed, type Ref } from 'vue'
import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import { freeThreadRow } from '@/lib/free-threads'

/** Free history changes independently of the local/remote worker lists. Keep its
 *  display rows while those lists refresh, rather than reallocating every private chat. */
export function useFreeThreadRows(
  threads: Readonly<Ref<readonly FreeThread[]>>,
  instances: Readonly<Ref<readonly FreeInstance[]>>,
) {
  // Status polling replaces the whole account array for quota/login changes.
  // Only these displayed fields can change a history row; keep their map stable.
  const byId = computed<Map<string, Pick<FreeInstance, 'num' | 'name'>>>((previous) => {
    const next = new Map<string, Pick<FreeInstance, 'num' | 'name'>>()
    for (const instance of instances.value) {
      const { id, num, name } = instance
      const before = previous?.get(id)
      next.set(
        id,
        before && Object.is(before.num, num) && before.name === name ? before : { num, name },
      )
    }
    if (
      previous?.size === next.size &&
      [...next].every(([id, display]) => previous.get(id) === display)
    )
      return previous
    return next
  })
  return computed(() => {
    const display = byId.value
    return threads.value.map((thread) => freeThreadRow(thread, display.get(thread.instanceId)))
  })
}
