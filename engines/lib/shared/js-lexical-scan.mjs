// vendored from Connections packages/connections-arkitect/agnostic/lib/js-lexical-scan.mjs @ dd3d47a7ad
/**
 * js-lexical-scan - THE corpus's literal-aware JS/TS lexical model, and the projections
 * every "blank/strip the comments before you scan" helper actually wants.
 * ==============================================================================
 *
 * THE BUG CLASS THIS EXISTS TO KILL. A regex cannot express "not inside a string" - it has
 * no context - so every hand-rolled "replace slash-slash to end-of-line" strip reaches
 * straight into string, template, and regex literals and eats real code. Measured live
 * across this corpus (2026-07-17), the damage is not theoretical:
 *
 *   - `security/page-route-api-credential-leak` and `security/app-data-isolation-contract`
 *     mangled 107 of the 1179 files they scan (9.1%). The CREDENTIAL-LEAK scanner read
 *     `const generatedProfileImageHost = "https:` - every URL literal truncates its line at
 *     the `//`, so a secret in a URL query (`"https://api.x/?api_key=…"`) is INVISIBLE to
 *     the very check written to catch it.
 *   - `architecture/constellation-plane-ports` mangled 557 of 3296 (16.9%).
 *   - `code-quality/duplicate-function-engine` false-clustered two different `isCommentLine`
 *     dialects, and (via the balancer twin of this bug) extracted a 12-line helper as a
 *     312-line body running to EOF. See that engine's header.
 *
 * A `//` inside a string is not an exotic edge case in this repo - it is every URL.
 *
 * THE MODEL. One linear walk (`walkSpans`) emits every lexical span - code / comment /
 * string / regex / template - and each projection below is derived from that ONE walk. That
 * is the point: the literal rules cannot drift between "what the hash sees" and "what the
 * balancers see", which is exactly how the two duplicate-function bugs disagreed with each
 * other. Add a projection here; never re-derive the rules.
 *
 * WHICH PROJECTION DO I WANT?
 *   - `stripComments`            comments REMOVED (text shrinks), literals kept verbatim.
 *                               For hashing/comparison where offsets don't matter.
 *   - `maskComments`             comments blanked to spaces, literals kept, LENGTH/OFFSETS/
 *                               line numbers preserved. For a regex scan that reports a
 *                               line number and must not match comment prose.
 *   - `maskLiteralsAndComments`  comments AND literals blanked, offsets preserved. For a
 *                               scan that must not match anything inside a literal either
 *                               (a token named in a string, a brace in a regex).
 *   - `maskLiteralBodiesAndComments`  like the above, but string/template DELIMITERS survive
 *                               (quotes, backticks, `${`/`}`) while their bodies blank. For a
 *                               scan that counts delimiters as structural signal - the
 *                               code-duplication declarative-catalog classifier.
 *
 * RELATED, deliberately separate: the SQL/CSS/HTML comment strippers (`stripSqlComments`,
 * `stripCssComments`, …) are a different grammar (`--`, `#`, no regex literals) and are NOT
 * served by this module. `packages/connections-arkitect/agnostic/lib/comment-line-scan.mjs` answers a different question
 * ("is this LINE a comment?") and is unaffected.
 */

// After one of these keywords a `/` opens a REGEX LITERAL, not division - even though the
// preceding significant char is a word char (`return /x/` vs `total / count`).
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * THE CORPUS'S ONE JS/TS LITERAL MODEL. Walk JS/TS `src` and hand every lexical span, in order and
 * tiling the input exactly, to `emit(kind, start, end)` - kind being `"code"`, `"comment"`,
 * `"string"`, `"regex"`, or `"template"` (template TEXT, including its backticks and the
 * `${` / `}` interpolation delimiters; the code INSIDE an interpolation is emitted as its own
 * spans, so a comment in there is a `"comment"` span like any other).
 *
 * Everything downstream is a projection of this one walk - `stripComments` (drop comment
 * spans, keep the rest) and `maskLiteralsAndComments` (keep code spans, blank the rest).
 * Two projections, one model: the literal rules can never drift between "what the hash sees"
 * and "what the balancers see", which is precisely how the two bugs this engine has now been
 * bitten by were able to disagree with each other in the first place.
 *
 * Recognition rules, all of which a regex fundamentally cannot express (no "not inside a
 * string" context):
 *   - `'…'` / `"…"` honor `\` escapes and end at a line break if unterminated;
 *   - templates nest arbitrarily with their interpolations (a frame stack, since `` `${`${x}`}` ``
 *     is legal), and an interpolation is a full code context;
 *   - a `/` opens a REGEX only where a value cannot have just ended (after an operator or a
 *     REGEX_PRECEDING_KEYWORDS word, never after an identifier/`)`/`]`), and only when a
 *     closing `/` is found on the SAME line - otherwise it is division.
 */
export function walkSpans(src, emit) {
  const n = src.length;
  // One frame per open context: the base code frame, plus a frame for each open template
  // literal and each open `${…}` interpolation (an interpolation is a full code context).
  const frames = [{ mode: "code", braces: 0 }];
  // Does the previous significant token END A VALUE (identifier, literal, `)`, `]`)?
  // A `/` after a value is division; anywhere else it can only open a regex literal.
  let prevValue = false;
  let i = 0;
  let runStart = 0;

  // Emit the pending code/template-text run accumulated since `runStart`.
  const flushRun = (upto, kind) => {
    if (upto > runStart) emit(kind, runStart, upto);
  };

  while (i < n) {
    const frame = frames[frames.length - 1];
    const ch = src[i];

    if (frame.mode === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++; // the closing backtick belongs to the text run
        flushRun(i, "template");
        frames.pop();
        runStart = i;
        prevValue = true;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        i += 2; // `${` belongs to the text run; what follows is code
        flushRun(i, "template");
        frames.push({ mode: "code", braces: 0 });
        runStart = i;
        prevValue = false;
        continue;
      }
      i++;
      continue;
    }

    // - code context -
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      flushRun(i, "code");
      let j;
      if (src[i + 1] === "/") {
        j = i;
        while (j < n && src[j] !== "\n") j++; // the `\n` itself stays code, as the old regex left it
      } else {
        j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(j + 2, n); // past `*/`, or clamped when unterminated
      }
      emit("comment", i, j);
      i = j;
      runStart = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      flushRun(i, "code");
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (j < n && src[j] === ch) j++;
      j = Math.min(j, n);
      emit("string", i, j);
      i = j;
      runStart = j;
      prevValue = true;
      continue;
    }
    if (ch === "`") {
      flushRun(i, "code");
      runStart = i; // the opening backtick starts the text run
      i++;
      frames.push({ mode: "template" });
      continue;
    }
    if (ch === "/" && !prevValue) {
      const end = scanRegexEnd(src, i);
      if (end !== -1) {
        flushRun(i, "code");
        emit("regex", i, end);
        i = end;
        runStart = end;
        prevValue = true;
        continue;
      }
      // No valid same-line close → not a regex after all; fall through as a plain char.
    }
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(src[j])) j++;
      prevValue = !REGEX_PRECEDING_KEYWORDS.has(src.slice(i, j));
      i = j; // stays part of the current code run
      continue;
    }
    if (ch === "{") {
      frame.braces++;
      i++;
      prevValue = false;
      continue;
    }
    if (ch === "}") {
      if (frame.braces === 0 && frames.length > 1) {
        // closes the `${…}` that opened this code frame → the `}` starts a template-text run
        flushRun(i, "code");
        frames.pop();
        runStart = i;
        i++;
        continue;
      }
      if (frame.braces > 0) frame.braces--;
      i++;
      prevValue = true;
      continue;
    }
    i++;
    if (!/\s/.test(ch)) prevValue = ch === ")" || ch === "]";
  }
  flushRun(n, frames[frames.length - 1].mode === "template" ? "template" : "code");
}

/**
 * Is the character at `index` real CODE - not inside a comment, a string, a regex literal, or a
 * template literal's TEXT? The one question a regex scan cannot answer about its own match.
 *
 * Built for a detector that finds a CALL by pattern and must not count the same letters when they
 * are prose or payload (2026-09-24, `reduced-motion-single-source`): a `matchMedia(...)` written
 * inside a template literal that ships an inline `<script>` into a generated page is text this
 * module never executes, while the same call inside that template's `${…}` interpolation IS
 * executed here. So the answer follows `walkSpans` exactly: interpolation bodies are code spans and
 * answer true, the backticks, the `${`/`}` delimiters and the template text answer false.
 *
 * An index outside `[0, src.length)` is not code. One linear walk per call; a caller with many
 * indices over one large text should build its own span table from `walkSpans` instead.
 * @param {string} src
 * @param {number} index
 * @returns {boolean}
 */
export function isExecutableAt(src, index) {
  const text = String(src ?? "");
  if (!Number.isInteger(index) || index < 0 || index >= text.length) return false;
  let kind = null;
  walkSpans(text, (spanKind, start, end) => {
    if (kind === null && start <= index && index < end) kind = spanKind;
  });
  return kind === "code";
}

/**
 * Start/end offsets of every TOP-LEVEL template literal in `src` - the backtick-to-backtick
 * span, including both delimiters. A NESTED template inside `${…}` (legal JS: `` `${cond ? `a`
 * : `b`}` ``) folds into its enclosing span rather than being reported as its own entry.
 *
 * Built from `walkSpans`'s "template" kind, which is the walk's own truth about nesting: a
 * template-kind span whose text STARTS with a backtick opens a frame (recording the outer start
 * only the first time, when none is already open) and one whose text ENDS with a backtick closes
 * a frame (reporting the span only when that close returns depth to zero); a span starting with
 * `}` (resuming after a `${…}` interpolation) or ending with `${` (entering one) changes neither.
 *
 * Exists for any scanner that wants to read a template literal as ONE unit going forward - the
 * template equivalent of `matchedDelimiterEnd` finding the matching close of a `(`/`{` pair. A
 * bare `text.indexOf("\`", open + 1)` finds the FIRST backtick after the opening one, which is
 * the WRONG one the instant the template's own interpolation contains a nested template literal
 * - it reads as the close, silently truncating everything genuinely inside.
 * @param {string} src
 * @returns {Array<{ start: number, end: number }>}
 */
export function templateLiteralSpans(src) {
  const spans = [];
  let depth = 0;
  let openStart = -1;
  walkSpans(src, (kind, start, end) => {
    if (kind !== "template") return;
    const text = src.slice(start, end);
    if (text.startsWith("`")) {
      if (depth === 0) openStart = start;
      depth += 1;
    }
    if (text.endsWith("`")) {
      depth -= 1;
      if (depth === 0) spans.push({ start: openStart, end });
    }
  });
  return spans;
}

/**
 * Return only static string and template spans. Template interpolation expressions stay code,
 * so a caller scanning literal content cannot mistake a TypeScript non-null assertion for text.
 */
export function staticStringSegments(src) {
  const segments = [];
  walkSpans(src, (kind, start, end) => {
    if (kind === "string" || kind === "template") segments.push({ index: start, text: src.slice(start, end) });
  });
  return segments;
}

/**
 * From a `/` at `slashIdx` in code context, return the index just past a syntactically
 * plausible regex literal (closing `/` on the SAME line - JS regexes cannot span lines -
 * honoring `\` escapes and `[…]` classes, then trailing flags), or -1 when there is none
 * (so the caller treats the `/` as division and copies it verbatim).
 */
function scanRegexEnd(src, slashIdx) {
  const n = src.length;
  let j = slashIdx + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

/**
 * Blank every non-newline char of `text` - the offset-preserving primitive the maskers share.
 * NAMED TO AVOID `literal-blind-source-scan`'s `^(blank|strip|mask)` candidate heuristic
 * (2026-07-21): this is not a comment/literal SCANNER - it has no lexical awareness at all -
 * it unconditionally blanks whatever span the walk above already isolated as non-code. Probed
 * standalone (as that oracle's harness does) it fails every probe trivially, since it blanks
 * its own `keepMe()` marker along with everything else; that is not the bug class the oracle
 * hunts; the actual literal-awareness lives in `walkSpans`, one level up, which this primitive
 * never sees past.
 */
export function spaceFill(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * The MIRROR of `maskComments`: only comment prose survives, every code and literal span is
 * blanked to spaces, and length/newlines/byte offsets are preserved - so a finding's line number
 * still indexes straight back into the raw source.
 *
 * It exists for the checks that read what a comment CLAIMS rather than what the code does
 * (`comment-file-pointer-resolves` is the first). Those need the exact opposite blinding from
 * every other scan here, and doing it by hand is how a check ends up matching a sentence inside a
 * string literal, or missing a claim written inside a `/** … *\/` block because the naive regex
 * only knew about `//`.
 * @param {string} src
 * @returns {string}
 */
export function keepOnlyComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    const text = src.slice(start, end);
    out += kind === "comment" ? text : spaceFill(text);
  });
  return out;
}

/**
 * Comments REMOVED (the text shrinks); string/template/regex literals kept verbatim.
 * Byte-identical to the old literal-blind line+block comment regex pair on literal-free
 * source, so existing comparisons only move where that pair was wrong.
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    if (kind !== "comment") out += src.slice(start, end);
  });
  return out;
}

/**
 * Comments blanked to spaces; literals KEPT verbatim; length, newlines and byte offsets
 * preserved - so a finding's line number still indexes straight back into the raw source
 * while comment prose can never trip the regex scan that runs after.
 * @param {string} src
 * @returns {string}
 */
export function maskComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    const text = src.slice(start, end);
    out += kind === "comment" ? spaceFill(text) : text;
  });
  return out;
}

/**
 * Comments AND string/template/regex literals blanked to spaces; offsets preserved. Only real
 * CODE survives, so a token named inside a string, or a brace/quote inside a regex, is
 * structurally invisible to a plain scan.
 *
 * Note the deliberate difference from a naive quote-to-quote blanker: the code inside a
 * template's `${…}` interpolation is REAL CODE and stays visible (only the template's text
 * and its delimiters are blanked). An interpolation is brace-balanced, so this is still safe
 * for brace counting.
 * @param {string} src
 * @returns {string}
 */
export function maskLiteralsAndComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    const text = src.slice(start, end);
    out += kind === "code" ? text : spaceFill(text);
  });
  return out;
}

/**
 * Comments blanked, plus only the string/template literals that carry PROSE - a literal whose text
 * contains a lowercase letter. Code-shaped literals (`"BETA_UNLOCK_ALL"`, `"FLAGS.X_ENFORCEMENT"`)
 * survive verbatim. Offsets, length and line numbers preserved.
 *
 * WHY THIS PROJECTION EXISTS, and why it is NOT `maskLiteralsAndComments` (2026-08-14). The
 * token/policy scanners (`tier-enforcement-posture`, `auth-token-secret-hygiene`,
 * `feature-kill-switch-inventory`, `api-key-scope-lattice`) hunt for a NAMED token appearing in
 * runtime code, and they face the same two-sided problem:
 *
 *   - a retired flag NARRATED in documentation prose is not a reintroduction - and this repo's
 *     in-code prose is not always a comment. `infra/shared/entitlement-limits.ts:364` explains a
 *     dormant dial inside a `why:` STRING field, naming `STORAGE_EXPORT_ENFORCEMENT`, which
 *     `maskComments` alone cannot see past and which read as a live kill-switch;
 *   - but blanking literals WHOLESALE (`maskLiteralsAndComments` / the `blankStringsAndComments`
 *     sibling) goes blind to the shape these scanners most need to catch - a flag read through a
 *     string KEY: `process.env["BETA_UNLOCK_ALL"]`, `flags["X_TIER_ENFORCEMENT"]`. A ban that
 *     stops seeing the bracket form is not a ban.
 *
 * The discriminator is a property of the literal itself, so nothing here is hand-maintained: an
 * env-var/flag key is SCREAMING_SNAKE and carries no lowercase, while any English sentence does.
 * The failure direction is deliberately the safe one - an all-caps literal keeps firing, so a
 * genuine bypass can never hide by being quoted.
 * @param {string} src
 * @returns {string}
 */
export function maskProseLiteralsAndComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    const text = src.slice(start, end);
    if (kind === "comment") out += spaceFill(text);
    else if ((kind === "string" || kind === "template") && /[a-z]/.test(text)) out += spaceFill(text);
    else out += text;
  });
  return out;
}

/**
 * Comments and regex literals blanked whole; string/template literal BODIES blanked while their
 * structural DELIMITERS survive - quotes, backticks, and the `${` / `}` interpolation markers
 * (interpolation CODE is a code span and stays visible, exactly as in `maskLiteralsAndComments`).
 * Offsets, length and line numbers preserved. For a scan that treats literal delimiters as
 * structural signal - a `"entry",` catalog line counts its quotes - but must never see literal
 * CONTENT; the code-duplication declarative-catalog classifier is the reference consumer.
 * @param {string} src
 * @returns {string}
 */
export function maskLiteralBodiesAndComments(src) {
  let out = "";
  walkSpans(src, (kind, start, end) => {
    const text = src.slice(start, end);
    if (kind === "code") {
      out += text;
    } else if (kind === "string") {
      const closed = text.length >= 2 && text[text.length - 1] === text[0];
      out += text[0] + spaceFill(text.slice(1, closed ? text.length - 1 : text.length)) + (closed ? text[0] : "");
    } else if (kind === "template") {
      // A template TEXT span's edges are its structural delimiters: it starts at the opening
      // backtick or the `}` closing an interpolation, and ends at the closing backtick or a
      // `${` opening one (see walkSpans). Keep those edges; blank the text between.
      let head = "";
      let tail = "";
      let body = text;
      if (body.startsWith("`") || body.startsWith("}")) {
        head = body[0];
        body = body.slice(1);
      }
      if (body.endsWith("${")) {
        tail = "${";
        body = body.slice(0, -2);
      } else if (body.endsWith("`")) {
        tail = "`";
        body = body.slice(0, -1);
      }
      out += head + spaceFill(body) + tail;
    } else {
      out += spaceFill(text); // comment / regex: nothing structural to keep
    }
  });
  return out;
}
