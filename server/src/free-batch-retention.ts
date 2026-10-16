interface RetainedBatch {
  createdAt: number
  settled: boolean
}

type Timer = ReturnType<typeof setTimeout>

/** A clock seam keeps six-hour lifecycle checks deterministic without provider calls or waits. */
export interface BatchRetentionClock {
  now(): number
  setTimeout(run: () => void, delay: number): Timer
  clearTimeout(timer: Timer): void
}

const systemClock: BatchRetentionClock = {
  now: () => Date.now(),
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (timer) => clearTimeout(timer),
}

/** One idle expiry for completed results. Pending batches live until their actual completion. */
export class FreeBatchRetention<T extends RetainedBatch> {
  private timer: Timer | null = null
  private deadline: number | null = null

  constructor(
    private batches: Map<string, T>,
    private keepMs: number,
    private clock: BatchRetentionClock = systemClock,
  ) {}

  /** Called on insertion, completion and reads; the timer retains only this map, never a result. */
  prune(): void {
    const now = this.clock.now()
    let next = Number.POSITIVE_INFINITY
    for (const [id, batch] of this.batches) {
      if (!batch.settled) continue
      // The previous check was age > keepMs, so the exact boundary remains available.
      const expires = batch.createdAt + this.keepMs + 1
      if (now >= expires) this.batches.delete(id)
      else next = Math.min(next, expires)
    }
    if (this.timer !== null && this.deadline === next) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.deadline = null
    if (!Number.isFinite(next)) return
    this.deadline = next
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.deadline = null
      this.prune()
    }, next - now)
    this.timer.unref?.()
  }
}
