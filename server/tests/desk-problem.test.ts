// deskProblem accepts a Desk chat's own chat id and refuses anything else.
import { describe, expect, it } from 'bun:test'
import { deskProblem } from '../src/climayte-dispatch'

describe('a Desk chat id', () => {
  it('carries its own Desk chat id, and anything else is refused', () => {
    const desk = { append: 'Desk text.', mcpServers: {} }
    expect(
      deskProblem({ ...desk, chatId: '00a6da4c-8d2f-4c21-ac6b-602437bc0b74' }, true),
    ).toBeNull()
    expect(deskProblem({ ...desk, chatId: '../evil' }, true)).toContain(
      'desk.chatId must be a Desk chat id',
    )
    expect(deskProblem({ ...desk, chatId: 7 }, true)).toContain(
      'desk.chatId must be a Desk chat id',
    )
  })
})
