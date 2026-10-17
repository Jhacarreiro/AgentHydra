import { expect, spyOn, test } from 'bun:test'
import { ETA_PROMPT_VERSION, type EtaSample, etaPromptStats } from '../src/climayte-eta'

function sample(id: number, promptVersion: number | undefined, ratio: number): EtaSample {
  return {
    id: `example-${id}`,
    kind: null,
    minutes: 10,
    tookS: 600 * ratio,
    doneAt: 100_000 - id,
    ...(promptVersion === undefined ? {} : { promptVersion }),
  }
}

test('prompt statistics retain version, cause-tie and idea order without mutating samples', () => {
  const current = [1.2, 0.5, 2, 1, 1, 1].map((ratio, i) => ({
    ...sample(i, ETA_PROMPT_VERSION, ratio),
    review: {
      why: 'Synthetic review',
      cause: i % 2 === 0 ? 'padding' : 'waiting',
      promptIdea: `idea-${i + 1}`,
    },
  }))
  const samples = [
    current[0]!,
    sample(10, undefined, 0.5),
    current[1]!,
    sample(11, ETA_PROMPT_VERSION + 2, 2),
    current[2]!,
    { ...sample(12, 0, 1), review: { why: 'Synthetic review', cause: 'other' } },
    ...current.slice(3),
  ]
  for (const entry of samples) {
    if (entry.review) Object.freeze(entry.review)
    Object.freeze(entry)
  }
  Object.freeze(samples)
  const before = JSON.stringify(samples)
  expect(etaPromptStats(samples)).toEqual([
    {
      version: ETA_PROMPT_VERSION + 2,
      samples: 1,
      ratio: 2,
      closeShare: 0,
      topCause: null,
      ideas: [],
    },
    {
      version: ETA_PROMPT_VERSION,
      samples: 6,
      ratio: 1,
      closeShare: 0.67,
      topCause: 'padding',
      ideas: ['idea-1', 'idea-2', 'idea-3', 'idea-4', 'idea-5'],
    },
    { version: 1, samples: 1, ratio: 0.5, closeShare: 0, topCause: null, ideas: [] },
    { version: 0, samples: 1, ratio: 1, closeShare: 1, topCause: 'other', ideas: [] },
  ])
  expect(JSON.stringify(samples)).toBe(before)
  expect(etaPromptStats([])).toEqual([
    { version: ETA_PROMPT_VERSION, samples: 0, ratio: 0, closeShare: 0, topCause: null, ideas: [] },
  ])
})

test('large prompt cohorts iterate samples linearly without copying prior cohorts', () => {
  const samples = Array.from({ length: 4096 }, (_, i) =>
    Object.freeze(sample(i, ETA_PROMPT_VERSION, 1)),
  )
  Object.freeze(samples)
  const identities = new WeakSet(samples)
  const iterate = Array.prototype[Symbol.iterator]
  let visits = 0
  const iterator = spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (
    this: unknown[],
  ) {
    const cursor = iterate.call(this)
    const next = cursor.next.bind(cursor)
    cursor.next = () => {
      const item = next()
      if (
        !item.done &&
        item.value !== null &&
        typeof item.value === 'object' &&
        identities.has(item.value)
      )
        visits++
      return item
    }
    return cursor
  })
  let stats: ReturnType<typeof etaPromptStats>
  try {
    stats = etaPromptStats(samples)
  } finally {
    iterator.mockRestore()
  }
  // One pass groups the input, and the existing cause tally visits its cohort once.
  expect(visits).toBe(samples.length * 2)
  expect(stats).toEqual([
    {
      version: ETA_PROMPT_VERSION,
      samples: samples.length,
      ratio: 1,
      closeShare: 1,
      topCause: null,
      ideas: [],
    },
  ])
})
