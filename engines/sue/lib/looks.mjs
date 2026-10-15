/**
 * When a Sue took each of her looks, read from her trace.
 *
 * The body writes one trace row per move, and a move that saved a picture carries `screenshot`
 * (the absolute path of `shots/look-NNNN.jpg`) beside its `at`. The Manager hands these to the page
 * so her visit's feed can put each journal line beside the look she wrote it after.
 */

const LOOK = /^look-\d{4}\.jpg$/;

/** `[{ name, at }]` for every look in the trace, in the order she took them; a name seen twice keeps its first time. */
export function lookTimes(rows) {
  const seen = new Set();
  const looks = [];
  for (const row of rows ?? []) {
    if (typeof row?.screenshot !== "string" || typeof row.at !== "string") continue;
    const name = row.screenshot.split(/[\\/]/).pop();
    if (!LOOK.test(name) || seen.has(name)) continue;
    seen.add(name);
    looks.push({ name, at: row.at });
  }
  return looks;
}
