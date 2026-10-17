/**
 * The note an owner must give to delete an instance. A login that syncs between
 * the owner's PCs is deleted on the other PC too, and that PC shows the note, so
 * the note says why. Returns null when the note is fine, else the refusal text.
 */
export function deleteNoteProblem(note: unknown): string | null {
  if (typeof note === 'string' && note.trim().length >= 3) return null
  return 'Say why you are deleting it (a short note).'
}
