// A process-wide ceiling for Desk's asynchronous filesystem discovery. Bun's Windows I/O pool
// keeps the threads an unbounded stat burst creates, even after those searches finish.
const WIDTH = 8
let busy = 0
const waiting: Array<() => void> = []

/** Take a slot for one raw filesystem call, never for a mapper or another slot-taking function. */
export async function fsSlot<T>(call: () => Promise<T>): Promise<T> {
  if (busy < WIDTH) busy++
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await call()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else busy--
  }
}

/** At most eight callbacks at once, with results in input order. Raw I/O also takes fsSlot. */
export async function mapFs<T, R>(items: T[], call: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await call(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(WIDTH, items.length) }, worker))
  return results
}
