// replyWhenDone waits for the reply to a sent Desk message and answers only what arrived after it.
import { afterEach, describe, expect, it } from 'bun:test'
import { replyWhenDone } from '../src/desk-client'

describe('replyWhenDone after a sent message', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function desk(polls: { status: string; items: { kind: string; text?: string }[] }[]) {
    let n = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      const p = polls[Math.min(n, polls.length - 1)]
      const body = String(url).endsWith('/transcript') ? p.items : [{ id: 'c1', status: p.status }]
      if (String(url).endsWith('/transcript')) n++
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
  }

  it('waits through an idle first poll that has only the prompt, then answers the reply', async () => {
    desk([
      { status: 'idle', items: [{ kind: 'user', text: 'q' }] },
      {
        status: 'idle',
        items: [
          { kind: 'user', text: 'q' },
          { kind: 'assistant_text', text: 'the answer' },
        ],
      },
    ])
    const r = await replyWhenDone({ id: 'c1', title: 'Chat' }, 0, 10)
    expect(r.status).toBe('done')
    expect(r.reply).toBe('the answer')
  })

  it('answers working, not an empty done, when no reply ever arrives', async () => {
    desk([{ status: 'idle', items: [{ kind: 'user', text: 'q' }] }])
    const r = await replyWhenDone({ id: 'c1', title: 'Chat' }, 0, 1)
    expect(r.status).toBe('working')
  })

  it('a resend to an idle chat ignores the earlier reply until a new one lands', async () => {
    const old = [
      { kind: 'user', text: 'old q' },
      { kind: 'assistant_text', text: 'old answer' },
    ]
    desk([
      { status: 'idle', items: [...old, { kind: 'user', text: 'new q' }] },
      {
        status: 'idle',
        items: [
          ...old,
          { kind: 'user', text: 'new q' },
          { kind: 'assistant_text', text: 'new answer' },
        ],
      },
    ])
    const r = await replyWhenDone({ id: 'c1' }, 2, 10)
    expect(r.reply).toBe('new answer')
  })
})
