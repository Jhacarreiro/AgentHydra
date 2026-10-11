import { describe, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'
import { pickDeskChat, rankTools } from '../src/mcp-find'

describe('hydra_find', () => {
  test('a plain-words ask to change workspace finds the Desk folder move first', () => {
    const top = rankTools(TOOLS, 'move this chat to another workspace', 3)
    expect(top[0]?.name).toBe('desk_move_chat')
  })
  test('quota questions find the usage tools', () => {
    const names = rankTools(TOOLS, 'how much quota do I have left', 5).map((t) => t.name)
    expect(names).toContain('check_my_usage')
  })
  test('both new tools are registered', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('hydra_find')
    expect(names).toContain('desk_move_chat')
  })
})

describe('desk_move_chat chat resolution', () => {
  const chats = [
    { id: 'c1', sessionId: 's1', title: 'Example games work', cwd: 'C:/Users/me/a' },
    { id: 'c2', sessionId: 's2', title: 'Example docs pass', cwd: 'C:/Users/me/b' },
  ]
  test('by Desk id, session id or a unique title fragment', () => {
    expect(pickDeskChat(chats, 'c2').id).toBe('c2')
    expect(pickDeskChat(chats, 's1').id).toBe('c1')
    expect(pickDeskChat(chats, 'games').id).toBe('c1')
  })
  test('an ambiguous or unknown fragment is refused, never guessed', () => {
    expect(() => pickDeskChat(chats, 'example')).toThrow(/matches 2/)
    expect(() => pickDeskChat(chats, 'nothing')).toThrow(/no Desk chat/)
    expect(() => pickDeskChat(chats, '  ')).toThrow(/chat is required/)
  })
})
