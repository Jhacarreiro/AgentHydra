// Who dispatched a CliMayte worker, as ids and a chat's title (climayte-origin.ts), for the queue and the list.
import { describe, expect, test } from 'bun:test'
import { NO_ORIGIN_LOOKUP, originFields } from '../src/climayte-origin'

const lookup = {
  sessionOf: (workerId: string) => (workerId === 'w-1' ? 'sess-w1' : null),
  titleOf: (sessionId: string) => (sessionId === 'sess-chat' ? 'Example chat' : null),
}

describe('originFields', () => {
  test('a chat origin: its session and the cached title', () => {
    expect(
      originFields(
        { kind: 'chat', sessionId: 'sess-chat', home: '', transcript: '', how: 'x' } as never,
        lookup,
      ),
    ).toEqual({ originSessionId: 'sess-chat', originWorkerId: null, originTitle: 'Example chat' })
  })

  test('a worker origin: its worker id and that worker session, no title', () => {
    expect(originFields({ kind: 'worker', workerId: 'w-1' }, lookup)).toEqual({
      originSessionId: 'sess-w1',
      originWorkerId: 'w-1',
      originTitle: null,
    })
  })

  test('no origin: all null', () => {
    expect(originFields(undefined, lookup)).toEqual({
      originSessionId: null,
      originWorkerId: null,
      originTitle: null,
    })
  })

  test('without lookups a chat keeps its id and a worker keeps its id', () => {
    expect(originFields({ kind: 'worker', workerId: 'w-1' }, NO_ORIGIN_LOOKUP).originWorkerId).toBe(
      'w-1',
    )
    expect(
      originFields({
        kind: 'chat',
        sessionId: 'sess-chat',
        home: '',
        transcript: '',
        how: 'x',
      } as never).originSessionId,
    ).toBe('sess-chat')
  })
})
