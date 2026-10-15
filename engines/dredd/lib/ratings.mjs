// dredd/lib/ratings.mjs - looking back: every docket this machine filed, how many were rated, and per instrument how
// often the chats that received it said it was the right call. `node dredd/eval.mjs --ratings` prints it.
//
// The Connections lane holds the same scores for every machine (Studio shows one row per instrument, lib/
// lane-record.mjs); this is the local, per-docket view, and the one that says WHAT to change: an instrument chats keep
// calling wrong over-fires (its `jev` question or keywords in bench.json are too eager), one they keep saying was
// missed under-fires. The verdict rows (eval/verdicts/) are the same mistakes as test cases, graded by
// `eval.mjs --verdicts`, so a fix is measured, not guessed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Every docket under <root>/tmp/dredd, oldest first (a folder without a docket.json - an eval run - is skipped). */
export function readDockets(root) {
  const dir = path.join(root, "tmp", "dredd");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const d = readJson(path.join(dir, e.name, "docket.json"));
      return d && Array.isArray(d.convene) ? { ...d, id: d.id || e.name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.created || a.id).localeCompare(String(b.created || b.id)));
}

/** The verdict rows chats wrote when a docket was wrong (eval/verdicts/*.json). */
export function readVerdictRows(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)))
    .filter((r) => r && r.id && r.ask);
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");

/** The per-instrument tally and the coverage numbers, pure. */
export function tallyRatings(dockets) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { id, convened: 0, rated: 0, right: 0, unneeded: 0, wrong: 0, "not-run": 0, missed: 0 });
    return rows.get(id);
  };
  const cover = { total: dockets.length, rated: 0, tracked: 0, queued: 0, byMode: {}, notQueued: {}, scores: [], missingTools: [] };
  for (const d of dockets) {
    const mode = d.mode || "before tracking";
    cover.byMode[mode] = (cover.byMode[mode] || 0) + 1;
    if (d.laneRecord) {
      cover.tracked += 1;
      if (d.laneRecord === "queued") cover.queued += 1;
      else cover.notQueued[d.laneRecord] = (cover.notQueued[d.laneRecord] || 0) + 1;
    }
    for (const c of d.convene) row(c.id).convened += 1;
    const r = d.rating;
    if (!r) continue;
    cover.rated += 1;
    cover.scores.push(r.score);
    for (const [id, choice] of Object.entries(r.choices || {})) {
      const t = row(id);
      t.rated += 1;
      if (choice in t) t[choice] += 1;
    }
    for (const id of r.missed || []) row(id).missed += 1;
    if (r.missingTool) cover.missingTools.push({ docket: d.id, tool: r.missingTool });
  }
  return { cover, rows: [...rows.values()].sort((a, b) => b.convened + b.missed - (a.convened + a.missed) || a.id.localeCompare(b.id)) };
}

/** What to change, from the tally: over-firing (called wrong) and under-firing (missed) instruments. */
export function fixList(rows, { atLeast = 2 } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.wrong >= atLeast)
      out.push(
        `${r.id}: called wrong ${r.wrong} of ${r.rated} times it was rated - it over-fires; tighten its jev question or keywords in bench.json`,
      );
    if (r.missed >= atLeast)
      out.push(`${r.id}: missed ${r.missed} times - it under-fires; widen its jev question or keywords, or lower its bar`);
    if (r.unneeded >= atLeast && r.unneeded > r.right)
      out.push(
        `${r.id}: unneeded ${r.unneeded} times against ${r.right} right - it fits but adds nothing at this scope; raise its bar or make it a quick-look-only instrument`,
      );
  }
  return out;
}

export function renderRatings(all, verdictRows) {
  // The specs file real dockets (door.spec and its siblings); they are never the owner's traffic.
  const dockets = all.filter((d) => d.laneRecord !== "not recorded: a test run");
  const { cover, rows } = tallyRatings(dockets);
  const first = dockets[0]?.created || dockets[0]?.id || "-";
  const mean = cover.scores.length ? (cover.scores.reduce((a, b) => a + b, 0) / cover.scores.length).toFixed(1) : "-";
  const lines = [
    `DREDD RATINGS - ${cover.total} dockets on this machine since ${String(first).slice(0, 10)}`,
    `  rated by the chat that received them: ${cover.rated} (${pct(cover.rated, cover.total)}), mean ${mean}/5`,
    `  recorded to the Connections lane: ${cover.queued} queued of ${cover.tracked} filed since tracking began${
      Object.keys(cover.notQueued).length
        ? ` (not queued: ${Object.entries(cover.notQueued)
            .map(([k, n]) => `${n} ${k}`)
            .join(", ")})`
        : ""
    }`,
    `  by door: ${Object.entries(cover.byMode)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ")}`,
    "",
    `  ${"INSTRUMENT".padEnd(20)} convened  rated  right  unneeded  wrong  not-run  missed`,
    ...rows.map(
      (r) =>
        `  ${r.id.padEnd(20)} ${String(r.convened).padStart(8)} ${String(r.rated).padStart(6)} ${String(r.right).padStart(6)} ${String(r.unneeded).padStart(9)} ${String(r.wrong).padStart(6)} ${String(r["not-run"]).padStart(8)} ${String(r.missed).padStart(7)}`,
    ),
  ];
  if (cover.missingTools.length)
    lines.push("", "MISSING TOOLS (the bench had nothing for it):", ...cover.missingTools.map((m) => `  ${m.tool}  (docket ${m.docket})`));
  const fixes = fixList(rows);
  lines.push(
    "",
    fixes.length ? "WHAT TO FIX:" : "WHAT TO FIX: nothing has been called wrong or missed twice yet.",
    ...fixes.map((f) => `  ${f}`),
  );
  lines.push(
    "",
    `VERDICT ROWS: ${verdictRows.length} in dredd/eval/verdicts${verdictRows.length ? " - node dredd/eval.mjs --verdicts grades Dredd against them" : ""}`,
  );
  return lines.join("\n");
}
