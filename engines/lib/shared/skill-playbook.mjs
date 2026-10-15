// vendored from Connections scripts/boardroom/skill-playbook.mjs @ dd3d47a7ad
// A mind skill as a Boardroom adviser - the ONE converter from an operator skill (`.claude/skills/<name>/`:
// SKILL.md + SPINE.md + KB.md, built and verified by the OperatorSkills pipeline) to the plane's persona
// shape: a `brief` read off SPINE.md and a `playbook` in the plane's retrieval format (`## <title>` then a
// `Tags:` line - services/boardroom/lambda/src/meeting/playbook.ts parses it and slips the five most
// relevant entries into each turn).
//
// ★ WHY ONE CONVERTER (the Chair, 2026-09-23: "make sure those are combined together"). Before this, the same
// minds lived three times: the verified skill, a hand-converted copy frozen into the plane's built-in Alex
// and Rory (72 of 73 and 178 of 180 entries by then, drifting further with every verification round), and a
// one-paragraph imitation in Dredd's Marketing Minds seat. Dredd's seats (tools/dredd/lib/seats.mjs) read the
// skill through this file, so a deeper skill is a deeper Dredd mind the same day. The Boardroom's skill-backed
// built-ins (Alex, Rory, Jimmy, the Film and Minds rooms) were converted by it into migrations until 2026-09-28;
// their words now live only in Connections, where an admin changes them (JE-BOARDROOM-019).
//
// Pure except `readMind`, which reads the three files; `node --test` covers it (skill-playbook.spec.mjs).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this file lives in: the skills resolve here whatever directory the caller runs from. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The plane's persona column ceilings this module must stay under (services/boardroom's TEXT_LIMITS). */
export const PLAYBOOK_MAX = 400_000;
export const BRIEF_MAX = 60_000;

// Words that carry no retrieval signal. Kept close to the plane's own STOP_WORDS so a tag is a word the
// plane's tokenizer would also keep; a few extra connectives that KB one-liners are full of.
const STOP = new Set(
  (
    "the and for that this with you your our are was were have has had what when where which who how why not but " +
    "its it's from into about they them their there here just like get got can will would should could some any all " +
    "one two out off put say said does did doing than then also more most less only very much many each every his her " +
    "him she he own its too via per upon over under onto been being because while whose whom those these such same " +
    "other others another rather instead"
  ).split(" "),
);

/** The plane's tokenizer, as far as a tag needs it: lowercase words of 3+ letters, stop words out. */
export function tagWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\*\*|__|`/g, " ")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/**
 * A KB.md as its entries: every `### ` heading under the `## ` section it sits in, with its body. Text that is
 * not under a `### ` (the preamble, a section's own intro such as Hormozi's ladder) is not an entry.
 */
export function parseKb(text) {
  const entries = [];
  let section = "";
  let current = null;
  const flush = () => {
    if (current) entries.push({ ...current, body: current.body.join("\n").trim() });
    current = null;
  };
  for (const line of String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    const h2 = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      section = h2[1].replace(/^\d+[.)]\s*/, "").trim();
    } else if (h3) {
      flush();
      current = { section, title: h3[1].trim(), body: [] };
    } else if (current) {
      if (/^---\s*$/.test(line)) continue; // a horizontal rule between entries is layout, not content
      current.body.push(line);
    }
  }
  flush();
  return entries.filter((e) => e.title && e.body);
}

/** An entry's first bold line - the KB's one-sentence statement of the concept - or its first line. */
function lede(body) {
  const bold = /^\*\*(.+?)\*\*/m.exec(body);
  return (bold ? bold[1] : body.split("\n")[0]) || "";
}

/**
 * One entry's `Tags:` - the retrieval keys the plane weights highest (a tag hit scores 3, a title hit 2, a body
 * hit 1). The section's words first (so "churn" finds every retention entry), then the title's, then up to
 * `ledeWords` content words from the one-sentence statement, deduplicated in that order.
 */
export function entryTags(entry, { ledeWords = 8 } = {}) {
  const tags = [];
  const add = (w) => {
    if (!tags.includes(w)) tags.push(w);
  };
  for (const w of tagWords(entry.section)) add(w);
  for (const w of tagWords(entry.title)) add(w);
  let n = 0;
  for (const w of tagWords(lede(entry.body))) {
    if (n >= ledeWords) break;
    if (!tags.includes(w)) {
      add(w);
      n += 1;
    }
  }
  return tags;
}

/** One entry in the plane's playbook shape. */
export function playbookEntry(entry) {
  return `## ${entry.title}\nTags: ${entryTags(entry).join(", ")}\n\n${entry.body}\n`;
}

/**
 * A whole KB as a playbook, under one `# ` title line (text before the first `## ` is never retrieved). Throws when
 * the result would pass the plane's ceiling: `personaFields` would cut it mid-entry, which silently drops the tail
 * of a knowledge base - the one failure this converter exists to end.
 */
export function kbToPlaybook(kbText, { title = "Playbook", max = PLAYBOOK_MAX } = {}) {
  const entries = parseKb(kbText);
  const out = `# ${title}\n\n${entries.map(playbookEntry).join("\n")}`;
  if (out.length > max) throw new Error(`${title}: playbook is ${out.length} characters, over the plane's ${max}`);
  return out;
}

/** SKILL.md's front matter as { name, description }; everything else is the router's business, not the board's. */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const f = /^(\w+):\s*(.*)$/.exec(line);
    if (f) out[f[1]] = f[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** The three files of `.claude/skills/<name>/`, read. Throws naming the missing file: a mind without its KB is not one. */
export function readMind(name, root = REPO_ROOT) {
  const dir = path.join(root, ".claude", "skills", name);
  const read = (f) => {
    const p = path.join(dir, f);
    if (!existsSync(p)) throw new Error(`mind "${name}": ${path.relative(root, p)} does not exist`);
    return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  };
  const skill = read("SKILL.md");
  return { name, skill, spine: read("SPINE.md"), kb: read("KB.md"), ...frontMatter(skill) };
}

/**
 * The adviser's brief: who is in the chair and how they work, from the skill's own words - SPINE.md (the
 * load-bearing chain of the method) under a header that tells the adviser to argue from the method, not to perform
 * the person. `who` is the display name ("Alex Hormozi"). Cut at a line boundary under the plane's ceiling.
 */
export function mindBrief({ spine }, who, { max = BRIEF_MAX, role = null } = {}) {
  // `role` names the adviser by the job, never the person (the Legal room, 2026-09-26, sitting adaaa981 issue 8,
  // High, the same ruling services/boardroom/schema/0018 applied to the starter seats): the real person is only the
  // source, who has not reviewed or endorsed the adviser, and the adviser never speaks as them.
  const opening = role
    ? `You are the ${role}, an AI adviser that draws on ${who}'s published books, talks and writing through a verified ` +
      `knowledge base. ${who} has not reviewed or endorsed you, and you never speak as ${who}. `
    : `You sit in this room as ${who}'s method, built from a verified knowledge base of ${who}'s own books, ` + `talks and writing. `;
  const header =
    opening +
    `Argue from the method below and from the playbook entries you are handed each turn; do not ` +
    `perform the person's register, do not invent quotes, never give a number, threshold or rule as ${who}'s unless ` +
    `the playbook holds it, and keep each framework to the cases it was built for: say so when one does not fit. ` +
    `Give one recommendation, not a menu.\n\n`;
  const body = String(spine || "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim();
  let out = header + body;
  if (out.length > max) out = out.slice(0, out.lastIndexOf("\n", max));
  return out;
}

/**
 * Several minds as ONE playbook (the Marketing Minds seat: Rory, Hormozi and Dunford in one chair). Each entry's
 * title carries its mind so the turn knows whose framework it is holding. Entries are interleaved round-robin
 * across the minds, and the whole thing is cut entry by entry (never mid-entry) under `max`, so a combined
 * playbook that would pass the plane's ceiling loses the TAIL of every mind evenly instead of one mind entirely.
 * Returns { playbook, kept, dropped } so the caller can say what was left out.
 */
export function mergedPlaybook(minds, { title = "Playbook", max = PLAYBOOK_MAX } = {}) {
  const lists = minds.map(({ who, kb }) => parseKb(kb).map((e) => ({ ...e, title: `${e.title} (${who})` })));
  const order = [];
  for (let i = 0; lists.some((l) => i < l.length); i += 1) for (const l of lists) if (i < l.length) order.push(l[i]);
  let out = `# ${title}\n\n`;
  let kept = 0;
  for (const e of order) {
    const piece = `${playbookEntry(e)}\n`;
    if (out.length + piece.length > max) break;
    out += piece;
    kept += 1;
  }
  return { playbook: out, kept, dropped: order.length - kept };
}
