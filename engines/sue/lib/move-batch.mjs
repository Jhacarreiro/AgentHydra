/**
 * move-batch - fewer model calls per screen, for any body (2026-10-03).
 * ======================================================================
 * WHY: measured on 30 recorded student visits (846 moves over 346 screens), every click was followed
 * by a `look` and, after each look, she made a note plus one move: 28.2 model calls a visit. A move that
 * changes the screen answers with the look that follows it (16.7), and a screen's notes and its one move
 * go in one `do` (about 12.3). A replay of such one-call plans chose the same click as the recorded one
 * 28 of 30 times; both misses picked Delete over a gentler option, hence the guard below.
 *
 * This file is only the rules, as pure functions. lib/body-relay.mjs applies them above whatever body a
 * Sue has (body.mjs, a fake, or a recording-backed one later), so no body implements any of this. The
 * folded look is an ordinary `look` call to the body: its trace row and the clock's charge for reading
 * are exactly what a separate look cost, so a visit's simulated time does not change.
 */

/** Moves that can change what is on the screen: each answers with the look that follows it. */
export const SCREEN_MOVES = new Set([
  "click",
  "type",
  "select",
  "attach",
  "press",
  "point",
  "scroll",
  "go_back",
  "go_forward",
  "reload",
  "go_to",
  "tabs",
  "rotate",
  "wait",
  "open_email",
]);

/** The one move a `do` may hold alongside notes. */
export const DO_NOTE = "note";

/** Does this move (with these args) change the screen? `tabs` only when it switches or closes. */
export function changesScreen(tool, args) {
  if (!SCREEN_MOVES.has(tool)) return false;
  if (tool === "tabs") {
    const action = String(args?.action ?? "list").toLowerCase();
    return action !== "list";
  }
  return true;
}

/**
 * Words of a choice that cannot be taken back, English and Spanish. `remove` and `reset` only count with a
 * destructive object (a filter or a forgotten password is no loss), and a cancel or a leave only with the
 * thing it ends.
 */
const OBJECT = "(?:my|your|mi|tu|mis|tus|account|cuenta|all|everything|data|progress|profile|todo|todos|datos|progreso|perfil)";
const DESTRUCTIVE = new RegExp(
  String.raw`(?<![\p{L}])(?:delete|discard|unsubscribe|sign out|log out|logout|erase|deactivate account|close account|close my account|` +
    String.raw`remove\s+${OBJECT}|reset\s+${OBJECT}|cancel\s+(?:my|your|subscription|plan|membership|account|class|course)|leave\s+(?:class|course|group|team)|` +
    String.raw`eliminar|elimina|borrar|borra|descartar|descarta|quitar\s+${OBJECT}|quita\s+${OBJECT}|dar(?:me|te)? de baja|` +
    String.raw`cerrar sesi[oó]n|cierra sesi[oó]n|cerrar\s+(?:mi\s+)?cuenta|cierra\s+(?:mi\s+)?cuenta|desactivar\s+(?:mi\s+)?cuenta|desactiva\s+(?:mi\s+)?cuenta|` +
    String.raw`restablecer\s+${OBJECT}|restablece\s+${OBJECT}|reiniciar\s+${OBJECT}|reinicia\s+${OBJECT}|anular|anula|desuscribir|` +
    String.raw`cancelar\s+(?:mi|tu|suscripci[oó]n|plan|membres[ií]a|cuenta|clase|curso)|cancela\s+(?:mi|tu|suscripci[oó]n|plan|membres[ií]a|cuenta|clase|curso)|` +
    String.raw`abandonar\s+(?:la\s+)?(?:clase|curso|grupo|equipo)|salir de (?:la\s+)?(?:clase|curso|grupo|equipo))(?![\p{L}])`,
  "iu",
);

/** The numbered controls of a look's words: lines that read `[3] Label`. */
function controlsOf(lookText) {
  return String(lookText ?? "")
    .split("\n")
    .map((line) => /^\s*\[(\d+)\]\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), label: m[2].trim() }));
}

/** A control's label without the status tags a look hangs on it (`[greyed out]`, `[tiny print ...]`, `[holding: "..."]`), which change while its name does not. */
const STATUS_TAG = /\s*\[(?:tiny print[^\]]*|greyed out|holding: .*?")\]?\s*$/u;
const nameOf = (label) => {
  let name = label;
  for (let before = ""; before !== name;) {
    before = name;
    name = name.replace(STATUS_TAG, "");
  }
  return name.trim();
};

/** Is this target a number from a look (a JSON number or a bracketed `[3]`)? A bare "15" in words may be a list choice, so it is not. */
const numberedTarget = (value) => (typeof value === "number" ? value : (/^\s*\[(\d+)\]\s*$/.exec(String(value ?? ""))?.[1] ?? null));

/**
 * THE NUMBERS A MOVE WAS MADE FROM. A model's tool calls in one turn arrive together, each numbered from
 * the look she had when she wrote them; the relay runs them one at a time, so the second reaches her hands
 * after the first has changed the screen and been answered with a new look, and `[3]` has become another
 * control (Market's listing sheet shrinks when the keyboard comes up and three controls under it join the
 * list: "12" went to Dismiss and the description to Location; Schedule's hours page re-flowed and "Save
 * hours" [5] became Wednesday's switch: SUE round 7, runs 20261004-234930-2d33 and 20261004-234911-eb1f).
 * A person taps what she SAW, so a numbered target is carried from the look it was made on (`basisLook`,
 * read when the call arrived) to the one now current (`nowLook`), by the control's own words: the same
 * words once on each screen, or the same place in a list of the same size. A control that is gone, or
 * that cannot be told apart any more, is refused and nothing is pressed: she looks and picks again.
 * Returns `{ args }` (renumbered) or `{ refusal }`.
 */
export function renumberStale(basisLook, nowLook, args) {
  const fields = ["target", "onto"].filter((f) => numberedTarget(args?.[f]) != null);
  if (!fields.length || !basisLook || !nowLook || basisLook === nowLook) return { args };
  const was = controlsOf(basisLook);
  const now = controlsOf(nowLook);
  const next = { ...args };
  for (const field of fields) {
    const n = Number(numberedTarget(args[field]));
    const seen = was.find((c) => c.n === n);
    if (!seen) continue; // never on her screen: the body says so in its own words
    const name = nameOf(seen.label);
    const before = was.filter((c) => nameOf(c.label) === name);
    const after = now.filter((c) => nameOf(c.label) === name);
    const gone = `The screen changed after you looked, and your [${n}] "${seen.label}" is not on it any more, so nothing was pressed. Look, then pick again.`;
    if (!after.length) return { refusal: gone };
    if (after.length !== before.length)
      return {
        refusal: `The screen changed after you looked, and your [${n}] "${seen.label}" could now be any of ${after.length} like it, so nothing was pressed. Look, then pick again.`,
      };
    const landed = after[before.findIndex((c) => c.n === n)];
    if (landed.n !== n) next[field] = typeof args[field] === "number" ? landed.n : `[${landed.n}]`;
  }
  return { args: next };
}

/** The first control on a screen that offers a destructive choice, or null. */
export function destructiveChoice(lookText) {
  return controlsOf(lookText).find((c) => DESTRUCTIVE.test(c.label)) ?? null;
}

/**
 * The destructive control THIS move targets, or null: only a click or a press on a control `[n]` (or by its
 * label) can make a choice; a scroll, a type or a wait never does, whatever else the screen offers.
 */
export function destructiveMove(lookText, tool, args) {
  if (tool !== "click" && tool !== "press") return null;
  const target = args?.target;
  if (target == null || target === "") return null;
  const controls = controlsOf(lookText);
  const byNumber = /^\s*\[?(\d+)\]?\s*$/.exec(String(target));
  const hit = byNumber
    ? controls.find((c) => c.n === Number(byNumber[1]))
    : controls.find((c) => c.label.toLowerCase().includes(String(target).trim().toLowerCase()));
  return hit && DESTRUCTIVE.test(hit.label) ? hit : null;
}

/**
 * A `do` list, checked. Returns `{ moves }` (each `{ tool, args }`) or `{ refusal }` with the plain reason.
 * It takes notes and at most ONE move that changes the screen; anything else is a move of its own.
 */
export function planBatch(input) {
  let list = input?.moves;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return {
        refusal: `do could not read its moves: give a JSON list like [{"move":"note","kind":"thought","text":"..."},{"move":"click","target":3}].`,
      };
    }
  }
  if (!Array.isArray(list) || !list.length)
    return {
      refusal: `do needs a list of moves, notes and at most one move that changes the screen: moves=[{"move":"note",...},{"move":"click","target":3}].`,
    };
  const moves = [];
  for (const item of list) {
    const { move, tool, args, ...rest } = item && typeof item === "object" ? item : {};
    const name = String(move ?? tool ?? "");
    if (!name) return { refusal: `every move in a do needs its name, like {"move":"click","target":3}.` };
    moves.push({ tool: name, args: args && typeof args === "object" ? args : rest });
  }
  const bad = moves.find((m) => m.tool !== DO_NOTE && !SCREEN_MOVES.has(m.tool));
  if (bad)
    return {
      refusal: `do takes notes and one move that changes the screen; "${bad.tool}" is made on its own, as a single move, after you have seen the screen.`,
    };
  if (moves.filter((m) => m.tool !== DO_NOTE).length > 1)
    return {
      refusal: `do takes at most ONE move that changes the screen, because you must see the screen between two of them. Put your notes and the first one in this do, and make the next move after you have seen what it did.`,
    };
  const unsure = typeof input?.unsure === "string" ? input.unsure.trim() : "";
  if (unsure) moves.unshift({ tool: DO_NOTE, args: { kind: "unsure", text: unsure } });
  const lingered = typeof input?.lingered === "string" ? input.lingered.trim() : "";
  if (lingered) moves.unshift({ tool: DO_NOTE, args: { kind: "lingered", text: lingered } });
  return { moves };
}

/** What a destructive control answers a `do`: its notes ran, its move did not. */
export function guardAnswer(choice, move) {
  return `Your notes are written, but your move (${move.tool}) was NOT made: it would make a choice that cannot be undone ("[${choice.n}] ${choice.label}"), and a choice like that is made on its own. Make your move again as a single move (not in a do), if it is still what you want.`;
}

/** The `do` move, as the tools list describes it (the relay answers it itself; no body serves it). */
export const DO_TOOL = {
  name: "do",
  description:
    'Your notes for this screen and your one move, in one call: moves is a list of any notes and at most ONE move that changes the screen (click, type, scroll...), run in order. It answers with each one\'s result and then the new look. Two screen-changing moves are refused: you must see the screen between them. A move that would make a choice that cannot be undone (delete, sign out, cancel a subscription...) stops before it, so make that choice as a single move. Notes always run first, whatever order you list them in. lingered: the exact words or numbers on this screen you read most carefully, for any reason, quoted as they appear; "none" only for a blank page (in paced reading each screen needs this once, on whatever move you make next; why is yours to say in a note); never make one up. unsure: optional, the same words when they puzzle you. considered: when you look at a button or link and decide not to press it, its number.',
  inputSchema: {
    type: "object",
    properties: {
      moves: { type: "array", items: { type: "object" } },
      lingered: {
        type: "string",
        description:
          'The words on this screen you read most carefully, quoted exactly; why is yours to say in a note. "none" only for a blank page.',
      },
      unsure: { type: "string", description: "Optional: the same words, when they puzzle you." },
      considered: {
        type: "number",
        description:
          "Optional: the number of a button or link you looked at and decided not to press; your pointer rests on it, then leaves.",
      },
    },
    required: ["moves"],
  },
};
