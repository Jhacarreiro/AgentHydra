// A PDF's first-page thumbnail, rendered once per file and height. Settled successes live in an
// access-ordered LRU (capped at 128 entries / 8 MiB) so unlimited browsing can't grow memory forever;
// failed or slow renders are remembered as null permanently, so a card that scrolls back into view
// shows the file chip again without re-rendering. (2026-10-16)

export const PDF_THUMB_DEADLINE_MS = 10_000

const MAX_ENTRIES = 128
const MAX_BYTES = 8 * 1024 * 1024

const cache = new Map<string, Promise<string | null>>()
const settled = new Map<string, string>() // successes only, most recent last
let settledBytes = 0

export function pdfFirstPageThumb(key: string, height: number, produce: () => Promise<string>): Promise<string | null> {
  const id = `${key}@${height}`
  const remembered = settled.get(id)
  if (remembered !== undefined) {
    settled.delete(id)
    settled.set(id, remembered) // refresh recency on hit
    return Promise.resolve(remembered)
  }
  const hit = cache.get(id)
  if (hit) return hit
  const thumb = withDeadline(Promise.resolve().then(produce), PDF_THUMB_DEADLINE_MS).catch(() => null)
  cache.set(id, thumb)
  thumb.then((value) => {
    if (value === null) return // failure stays memoized in cache
    cache.delete(id)
    const bytes = value.length * 2
    if (bytes > MAX_BYTES) return // oversized: hand it back without retaining it
    settled.set(id, value)
    settledBytes += bytes
    while (settled.size > MAX_ENTRIES || settledBytes > MAX_BYTES) {
      const oldest = settled.entries().next().value!
      settled.delete(oldest[0])
      settledBytes -= oldest[1].length * 2
    }
  })
  return thumb
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pdf thumbnail timed out')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
