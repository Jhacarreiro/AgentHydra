// The face a chat's row shows (sidebar/manager-face.ts): the people add-on's face for the chat, or none. The faces
// themselves (a pinned manager, a seat's persona, Hydra Core's lead) are the add-on's, so this file reads no folders.
import type { ChatSummary } from '@shared/protocol'
import { peopleAddon } from '../../../../server/src/people-host'

export type ChatFace = NonNullable<ChatSummary['manager']>

export function chatFace(chat: Pick<ChatSummary, 'id'> & Partial<Pick<ChatSummary, 'managerSlug' | 'sessionId' | 'parentId'>>): ChatFace | null {
  const face = peopleAddon()?.face?.({
    id: chat.id,
    managerSlug: chat.managerSlug ?? null,
    sessionId: chat.sessionId ?? null,
    parentId: chat.parentId ?? null,
  })
  return face ? { ...face, title: face.title ?? null, oneLiner: face.oneLiner ?? null, photo: face.photo ?? null } : null
}
