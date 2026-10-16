/** A stable non-negative hash of a text (FNV-1a): the same text always lands on the same colour or hue. */
export function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
