/** Free MCP batches outlive the daemon (2026-10-17). Each batch is saved in DATA_DIR/free-batches and
 * the next daemon carries it on (mcp-free.ts adoptFreeBatches), so a restart never waits for one.
 * A restart only parks them: no new tick starts, the ticks and admissions already under way finish
 * (bounded), and everything is saved before the successor is spawned. A failed handoff resumes them.
 * Admission is never refused: a batch admitted while parked is saved for the successor. */
export class FreeBatchHandover {
  private parked = false
  private busy = 0
  private idle: (() => void)[] = []
  private resumed: (() => void)[] = []
  private parking: Promise<void>
  private parkingStarted!: () => void

  constructor() {
    this.parking = this.nextParking()
  }

  private nextParking(): Promise<void> {
    return new Promise((resolve) => {
      this.parkingStarted = resolve
    })
  }

  isParked(): boolean {
    return this.parked
  }

  /** Resolves once a park begins: waits for a batch's answers end then, so a caller learns its batch
   *  id before this daemon exits. */
  nextPark(): Promise<void> {
    return this.parking
  }

  /** One tick of a batch. Waits while parked; the returned leave() ends it. */
  async tick(): Promise<() => void> {
    while (this.parked) await new Promise<void>((r) => this.resumed.push(r))
    return this.track()
  }

  /** Work a park must let finish (an admission's preflight), never refused or held. */
  track(): () => void {
    this.busy++
    let left = false
    return () => {
      if (left) return
      left = true
      this.busy--
      if (this.busy === 0) for (const r of this.idle.splice(0)) r()
    }
  }

  /** Parks every batch and resolves once no tick or admission is under way, or at `timeoutMs`:
   *  past it a start still in flight is on disk with its request id (mcp-free.ts), so the next
   *  daemon resends it under the same id and Desk 2 answers with the operation it already has. */
  async park(timeoutMs: number): Promise<void> {
    if (!this.parked) {
      this.parked = true
      this.parkingStarted()
    }
    if (this.busy === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      new Promise<void>((r) => this.idle.push(r)),
      new Promise<void>((r) => {
        timer = setTimeout(r, timeoutMs)
      }),
    ])
    clearTimeout(timer)
  }

  /** The handoff failed: this daemon keeps serving, and its batches go on. */
  resume(): void {
    if (!this.parked) return
    this.parked = false
    this.parking = this.nextParking()
    for (const r of this.resumed.splice(0)) r()
  }
}

export const freeBatchHandover = new FreeBatchHandover()
