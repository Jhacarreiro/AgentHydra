/**
 * tape/pick-edge.mjs - which recorded move a Sue's tap is: shared by the tape body (tape/body.mjs), which answers her
 * from the tape, and the read-through (tape/read-through.mjs), which asks the same question before it opens a browser.
 * No browser and no file reads here, only the edges it is given.
 */

/** Words as she and the recording compare them: accents, case and runs of spaces folded away. */
export const fold = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * The recorded move her tap is: the edge from `from` by `control` whose typed boxes hold what she typed (case and
 * spaces folded) and whose required ticks she ticked. A control recorded with ONE variant takes any non-empty
 * value in each of its boxes, since the recorder only ever tried one answer. `{ edge }` or `{ reason }`.
 */
export function pickEdge(edges, { device, from, control, fills, checks }) {
  const mine = edges.filter((e) => e.device === device && e.from === from && e.control === control);
  if (!mine.length) return { reason: "no-edge" };
  const ticked = (entry) => checks.has(entry.key);
  const exact = mine.find((e) => (e.typed ?? []).every((t) => (t.check ? ticked(t) : fold(fills.get(t.key)) === fold(t.value))));
  if (exact) return { edge: exact };
  if (mine.length === 1 && (mine[0].typed ?? []).every((t) => (t.check ? ticked(t) : fold(fills.get(t.key)) !== "")))
    return { edge: mine[0] };
  return { reason: "typed-no-variant" };
}
