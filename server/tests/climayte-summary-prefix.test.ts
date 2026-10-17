import { expect, spyOn, test } from 'bun:test'
import { summarizeEvent } from '../src/climayte-lib'

const assistant = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const tool = (command: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
})

/** The original whole-text summarizer is the output oracle, including block and argument priority. */
function legacy(raw: unknown): string | null {
  const ev = raw as {
    type?: string
    subtype?: string
    model?: string
    num_turns?: unknown
    total_cost_usd?: unknown
    message?: { content?: unknown }
  } | null
  const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)
  if (ev?.type === 'result') {
    const turns = Number(ev.num_turns) || 0
    return `finished (${turns} ${turns === 1 ? 'turn' : 'turns'}; session so far $${(Number(ev.total_cost_usd) || 0).toFixed(2)})`
  }
  if (ev?.type === 'system' && ev.subtype === 'init') return `started (${ev.model ?? 'unknown'})`
  if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null
  for (const b of ev.message.content as Array<{
    type?: string
    text?: unknown
    name?: string
    input?: Record<string, unknown>
  } | null>) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
      return `said: ${oneLine(b.text, 140)}`
    if (b?.type === 'tool_use') {
      const i = b.input ?? {}
      const arg = [i.file_path, i.command, i.pattern, i.description].find(
        (v) => typeof v === 'string' && v,
      )
      return `${b.name} ${arg ? oneLine(arg as string, 100) : ''}`.trim()
    }
  }
  return null
}

test('short, threshold and long summaries preserve complete legacy output for text and tool commands', () => {
  for (const size of [
    0,
    1,
    99,
    100,
    139,
    140,
    4095,
    4096,
    4097,
    65_535,
    65_536,
    65_537,
    1024 * 1024,
  ]) {
    const body = '  Synthetic\tmessage 🙂\n'.repeat(Math.ceil(size / 20)).slice(0, size)
    for (const event of [assistant(body), tool(body)])
      expect(summarizeEvent(event)).toBe(legacy(event))
  }
  const plain = 'X'.repeat(1024 * 1024)
  expect(summarizeEvent(assistant(plain))).toBe(`said: ${'X'.repeat(140)}`)
  expect(summarizeEvent(tool(plain))).toBe(`Bash ${'X'.repeat(100)}`)
})

test('Unicode whitespace, lone surrogates and exact UTF-16 cutoff units remain unchanged', () => {
  const whitespace =
    '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  const suffix = ' synthetic\n'.repeat(10_000)
  for (const limit of [100, 140]) {
    for (const text of [
      whitespace.repeat(1000) + 'Synthetic' + whitespace + suffix,
      'x'.repeat(limit - 1) + '🙂' + suffix,
      'x'.repeat(limit - 1) + '\ud800' + suffix,
      'x'.repeat(limit - 1) + '\udfff' + suffix,
      '\u0085\u180e\u200b' + suffix,
    ]) {
      const event = limit === 100 ? tool(text) : assistant(text)
      expect(summarizeEvent(event)).toBe(legacy(event))
    }
  }
})

test('sparse fallback preserves short normalized bodies and boundary spaces before later text', () => {
  const gap = ' '.repeat(1024 * 1024)
  for (const limit of [100, 140]) {
    for (const text of [
      gap,
      gap + 'Synthetic text',
      'Synthetic text' + gap,
      'x'.repeat(limit - 1) + gap,
      'x'.repeat(limit - 1) + gap + 'Y',
      'x'.repeat(limit) + gap + 'Y',
      'x'.repeat(limit - 2) + gap + 'Y',
    ]) {
      const event = limit === 100 ? tool(text) : assistant(text)
      expect(summarizeEvent(event)).toBe(legacy(event))
    }
  }
})

test('empty text skipping, content order, field priority and non-assistant cases remain unchanged', () => {
  const toolBlock = {
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'Synthetic command', pattern: 'Ignored pattern' },
  }
  const textBlock = { type: 'text', text: 'Synthetic text' }
  const events: unknown[] = [
    null,
    { type: 'user', message: { content: [textBlock] } },
    { type: 'assistant', message: { content: 'Not an array' } },
    { type: 'system', subtype: 'init', model: 'synthetic-model' },
    { type: 'result', num_turns: 1, total_cost_usd: 0.125 },
    { type: 'result', num_turns: 3, total_cost_usd: 1 },
    {
      type: 'assistant',
      message: {
        content: [
          null,
          { type: 'text', text: 4 },
          { type: 'text', text: ' '.repeat(70_000) },
          toolBlock,
          textBlock,
        ],
      },
    },
    { type: 'assistant', message: { content: [toolBlock, textBlock] } },
    { type: 'assistant', message: { content: [textBlock, toolBlock] } },
    {
      type: 'assistant',
      message: {
        content: [{ ...toolBlock, input: { file_path: ' \t', command: 'Ignored command' } }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            ...toolBlock,
            input: {
              file_path: '',
              command: 42,
              pattern: '',
              description: 'Synthetic description',
            },
          },
        ],
      },
    },
  ]
  for (const event of events) expect(summarizeEvent(event)).toBe(legacy(event))
})

test('actual large-event summaries normalize only one bounded prefix per event', () => {
  const text = 'Synthetic\tmessage 🙂\n'.repeat(60_000)
  const events = [assistant(text), tool(text)]
  const expected = events.map(legacy)
  const sizes: number[] = []
  const replace = String.prototype.replace
  const spy = spyOn(String.prototype, 'replace').mockImplementation(function (
    this: string,
    search: unknown,
    replacement: unknown,
  ): string {
    if (search instanceof RegExp && search.source === '\\s+') sizes.push(this.length)
    return Reflect.apply(replace, this, [search, replacement])
  })
  try {
    expect(events.map(summarizeEvent)).toEqual(expected)
    expect(sizes).toEqual([4096, 4096])
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBeLessThan(text.length / 100)
  } finally {
    spy.mockRestore()
  }
})
