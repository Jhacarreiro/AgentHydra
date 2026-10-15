/**
 * state-cache.mjs - what the Sue Manager reads of each Sue's files, read once and then only again
 * when the file changed.
 * ==========================================================================================
 *
 * WHY: the Studio page polls the Manager every 2 s while a run is live, and every poll asked each Sue
 * for her sue.json, summary, interview, pictures folder, notes and her WHOLE trace.jsonl. That work is
 * Sues x trace length, so with hundreds of Sues the Manager itself became the machine's hog (Sue at
 * scale, fix 5, 2026-09-24). Here each answer is kept beside the file's key (inode, size, mtime):
 *   - a JSON file is parsed again only when its key changes;
 *   - a JSONL file (a trace, the notes) only grows, so only the bytes appended since the last read are
 *     read and folded in; one cut short or rewritten (its first bytes or the bytes just before where
 *     the last read stopped no longer match) is read again from the start;
 *   - a folder is listed again only when its own mtime changes (adding or removing a file changes it).
 * A file whose mtime was within RACY_MS of when it was read could have changed again inside the same
 * tick without its key moving (a coarse-clocked disk), so it is checked again the next time; that is
 * the same rule git uses for its index.
 *
 * The answers are exactly what `freshReads` (the reads the Manager always did) gives;
 * tests/state-cache.spec.mjs holds that to every case. Only the runs most recently asked about are
 * kept (`runs`): a run no longer on anyone's screen falls out.
 *
 * The values handed back are shared with the cache: a caller reads them and never changes them.
 */
import fs from "node:fs";

/** Two seconds covers the coarsest file clock a Sue's folder could live on (FAT's). */
const RACY_MS = 2_000;
/** The page shows one run at a time; a few windows or tabs each on their own run still fit. */
const RUNS_KEPT = 8;
/** How much of a JSONL file is read at a time, so a long trace never sits in memory whole. */
const CHUNK = 1 << 20;
/** How many bytes at a file's start, and just before where the last read stopped, must still match. */
const PRINT = 256;
const NEWLINE = 0x0a;

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // a Sue still writing her file, or one that never wrote it: the field reads as absent
  }
}

export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no journal yet
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // the line being appended right now; the next poll reads it whole
    }
  }
  return rows;
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The uncached reads, as the Manager always did them: the yardstick every cached answer is held to.
 *   json(file)           -> the parsed file, or null
 *   jsonl(file)          -> { count, last }: how many lines parse, and the last one that does
 *   names(dir, pattern)  -> the folder's names that match, sorted
 */
export const freshReads = {
  json: readJson,
  jsonl(file) {
    const rows = readJsonl(file);
    return { count: rows.length, last: rows.at(-1) ?? null };
  },
  names: (dir, pattern) =>
    listDir(dir)
      .filter((n) => pattern.test(n))
      .sort(),
};

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Every non-blank line of `text` (which ends at a newline) folded into `into`, as readJsonl reads it. */
function foldLines(text, into) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      into.last = JSON.parse(line);
      into.count += 1;
    } catch {
      // not a whole line of JSON: readJsonl skips it too
    }
  }
}

function readAt(fd, position, length) {
  const buf = Buffer.allocUnsafe(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

export function createStateCache({ runs = RUNS_KEPT, now = Date.now } = {}) {
  /** runDir -> Map(key -> entry), oldest-asked first. */
  const byRun = new Map();
  const stats = { bytesRead: 0, listings: 0, parses: 0 };

  function entriesFor(runDir) {
    let entries = byRun.get(runDir);
    if (entries) byRun.delete(runDir);
    else entries = new Map();
    byRun.set(runDir, entries);
    while (byRun.size > runs) byRun.delete(byRun.keys().next().value);
    return entries;
  }

  const sameKey = (hit, st) => hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs;
  const settled = (hit) => hit.readAt - hit.mtimeMs > RACY_MS;
  const keyOf = (st) => ({ ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, readAt: now() });

  function json(entries, file) {
    const st = statOf(file);
    if (!st) {
      entries.delete(file);
      return readJson(file);
    }
    const hit = entries.get(file);
    if (hit && sameKey(hit, st) && settled(hit)) return hit.value;
    const key = keyOf(st);
    const value = readJson(file);
    stats.parses += 1;
    stats.bytesRead += st.size;
    entries.set(file, { ...key, value });
    return value;
  }

  /** Whether the bytes `hit` already read are still the file's own (it only grew since). */
  function stillAppended(fd, hit, st) {
    if (hit.ino !== st.ino || st.size < hit.offset) return false;
    const head = readAt(fd, 0, hit.head.length);
    const seam = readAt(fd, hit.offset - hit.seam.length, hit.seam.length);
    stats.bytesRead += head.length + seam.length;
    return head.equals(hit.head) && seam.equals(hit.seam);
  }

  function jsonl(entries, file) {
    const st = statOf(file);
    if (!st) {
      entries.delete(file);
      return freshReads.jsonl(file);
    }
    const hit = entries.get(file);
    if (hit && sameKey(hit, st) && settled(hit)) return hit.value;
    const key = keyOf(st);
    let fd;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      entries.delete(file);
      return freshReads.jsonl(file);
    }
    try {
      const from = hit && stillAppended(fd, hit, st) ? hit : null;
      // `folded` is every whole line before `offset`; what follows it is a line still being written.
      const folded = { count: from ? from.count : 0, last: from ? from.last : null };
      let offset = from ? from.offset : 0;
      let pos = offset;
      let carry = Buffer.alloc(0);
      while (pos < st.size) {
        const got = readAt(fd, pos, Math.min(CHUNK, st.size - pos));
        if (!got.length) break; // cut short while being read: the next poll's key differs
        pos += got.length;
        stats.bytesRead += got.length;
        const chunk = carry.length ? Buffer.concat([carry, got]) : got;
        const cut = chunk.lastIndexOf(NEWLINE);
        if (cut < 0) {
          carry = chunk;
          continue;
        }
        foldLines(chunk.subarray(0, cut + 1).toString("utf8"), folded);
        offset += cut + 1;
        carry = Buffer.from(chunk.subarray(cut + 1));
      }
      const value = { ...folded };
      foldLines(carry.toString("utf8"), value);
      const head = from ? from.head : readAt(fd, 0, Math.min(PRINT, offset));
      const seam = readAt(fd, offset - Math.min(PRINT, offset), Math.min(PRINT, offset));
      stats.bytesRead += (from ? 0 : head.length) + seam.length;
      // Read to `pos`, not the size stat saw: a file cut short under the read is keyed as it was read.
      entries.set(file, { ...key, size: pos, offset, count: folded.count, last: folded.last, head, seam, value });
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  function names(entries, dir, pattern) {
    const st = statOf(dir);
    const id = `${dir}\0${pattern.source}\0${pattern.flags}`;
    if (!st) {
      entries.delete(id);
      return freshReads.names(dir, pattern);
    }
    const hit = entries.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino && settled(hit)) return hit.value;
    const key = keyOf(st);
    const value = freshReads.names(dir, pattern);
    stats.listings += 1;
    entries.set(id, { ...key, value });
    return value;
  }

  return {
    /** The reads for one run, shaped like `freshReads`; asking marks the run as on someone's screen. */
    reads(runDir) {
      const entries = entriesFor(runDir);
      return {
        json: (file) => json(entries, file),
        jsonl: (file) => jsonl(entries, file),
        names: (dir, pattern) => names(entries, dir, pattern),
      };
    },
    /** The runs held, oldest-asked first. */
    runsHeld: () => [...byRun.keys()],
    stats,
  };
}
