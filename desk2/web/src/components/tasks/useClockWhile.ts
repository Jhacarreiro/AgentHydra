// The shared clock, run only while something on screen counts up: its scope starts when `on` turns true and stops when it
// turns false, so a panel with nothing running moves no clock. `fallback` is the time shown while the clock is off.
import { computed, effectScope, onBeforeUnmount, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { useClock } from '@/lib/clock'

export function useClockWhile(on: () => boolean, periodMs: number, fallback: () => number): Readonly<Ref<number>> {
  const clock = shallowRef<{ now: Readonly<Ref<number>> } | null>(null)
  let scope: EffectScope | null = null
  watch(
    on,
    (active) => {
      if (active && !scope) {
        scope = effectScope()
        const tick = scope.run(() => useClock(periodMs))
        clock.value = tick ? { now: tick } : null
      } else if (!active && scope) {
        scope.stop()
        scope = null
        clock.value = null
      }
    },
    { immediate: true }
  )
  onBeforeUnmount(() => scope?.stop())
  return computed(() => clock.value?.now.value ?? fallback())
}
