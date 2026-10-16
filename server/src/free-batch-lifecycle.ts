/** Free MCP batches live in this daemon, including their asynchronous preflight. A restart
 * must wait for them, then close admission before any successor handshake can yield. */
export class FreeBatchLifecycle {
  private active = new Set<symbol>()
  private restarting = false

  acquire(): () => void {
    if (this.restarting)
      throw new Error(
        'AgentHydra is restarting. Try again once it reconnects. No Free task was started.',
      )
    const lease = Symbol()
    this.active.add(lease)
    return () => {
      this.active.delete(lease)
    }
  }

  activeCount(): number {
    return this.active.size
  }

  beginRestart(): boolean {
    if (this.active.size) return false
    this.restarting = true
    return true
  }

  abortRestart(): void {
    this.restarting = false
  }
}

export const freeBatchLifecycle = new FreeBatchLifecycle()
