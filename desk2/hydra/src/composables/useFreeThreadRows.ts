import { computed, type Ref } from 'vue'
import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import { freeThreadRow } from '@/lib/free-threads'

/** Free history changes independently of the local/remote worker lists. Keep its
 *  display rows while those lists refresh, rather than reallocating every private chat. */
export function useFreeThreadRows(
  threads: Readonly<Ref<readonly FreeThread[]>>,
  instances: Readonly<Ref<readonly FreeInstance[]>>,
) {
  const byId = computed(() => new Map(instances.value.map(instance => [instance.id, instance])))
  return computed(() => threads.value.map(thread => freeThreadRow(thread, byId.value.get(thread.instanceId))))
}
