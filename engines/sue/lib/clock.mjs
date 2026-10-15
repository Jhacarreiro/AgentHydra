/**
 * clock - the per-Sue human clock: two budgets, one mood.
 * =========================================================
 * WHY THIS EXISTS: SPEC.md's "The clock" section is what turns "TikTok Sue didn't read enough"
 * from a vibe into a measurement. Every tool call in body.mjs (look/click/type/scroll/wait) charges
 * this clock in real seconds - reading costs `words / persona.wordsPerMinute` minutes, a click or
 * type costs 1.5s, a real wait costs its own wall time - against TWO independent budgets:
 * `attentionSeconds` (per page, reset by body.mjs on navigation or a page-changing click) and
 * `patienceSeconds` (the whole visit, never reset). Attention run out -> the next `look` opens
 * bored/irritated in her own voice; patience run out -> the body ends her visit.
 *
 * `temperature` (0.0-1.0, from the persona file) picks the wording: low temperature reads mild,
 * high temperature reads furious - the same mechanical exhaustion, a different Sue's voice.
 *
 * DEPENDS ON: nothing but the persona's `dials` (or a bare dials object, for tests). DEPENDED ON
 * BY: body.mjs (charges it on every tool call, reads `.state()`/`.mood()` for what `look` says,
 * calls `.newPage()` on navigation). tests/clock.spec.mjs is this file's own spec.
 */

/**
 * How many separate jobs a scenario's errand holds: `scenario.legs` (1 to 5), anything else is one.
 * The ONE reading of it: the cannon's turn and wall-clock budgets and this clock's patience all
 * scale by it. The patience did not until 2026-09-23: Tavern Bag's five-leg wave 11 gave every Sue
 * one leg of patience, the sign-up spent it, and three were cut off inside the product while
 * saying "I am not furious, I want to finish my character".
 */
export function legsOf(scenario) {
  return Number.isInteger(scenario?.legs) && scenario.legs > 1 ? scenario.legs : 1;
}

/**
 * Build a fresh clock for one Sue. `persona` is either a full persona object (`{ dials: {...} }`)
 * or a bare dials object - tests pass the latter directly. `legs` (see `legsOf`) gives her that
 * many visits' worth of patience; attention stays per page. `now` is injectable for determinism;
 * the clock never actually reads it today (every charge is given its cost directly), but the hook
 * stays so a future wall-clock-driven charge (e.g. idle detection) has somewhere to live.
 */
export function createClock(persona, { legs = 1, now = () => Date.now() } = {}) {
  void now;
  const dials = persona && typeof persona === "object" && persona.dials ? persona.dials : persona || {};

  const attentionBudgetSeconds = Number(dials.attentionSeconds) || 0;
  const patienceBudgetSeconds = (Number(dials.patienceSeconds) || 0) * (Number.isInteger(legs) && legs > 1 ? legs : 1);
  const wordsPerMinute = Number(dials.wordsPerMinute) || 200;
  const temperature = dials.temperature === undefined ? 0.5 : Number(dials.temperature);

  let attentionLeftSeconds = attentionBudgetSeconds;
  let patienceLeftSeconds = patienceBudgetSeconds;
  let elapsedTotalSeconds = 0;
  let handsSinceLook = false;
  let lastPicture = null;

  function spend(seconds) {
    if (!(seconds > 0)) return;
    attentionLeftSeconds = Math.max(0, attentionLeftSeconds - seconds);
    patienceLeftSeconds = Math.max(0, patienceLeftSeconds - seconds);
    elapsedTotalSeconds += seconds;
  }

  function state() {
    if (patienceLeftSeconds <= 0) return "exhausted";
    if (attentionLeftSeconds <= 0) return "bored";
    return "fine";
  }

  return {
    /** Charge the clock: `words` read, `actions` (clicks/types, 1.5s each), `waitMs` real wait. */
    charge({ words = 0, actions = 0, waitMs = 0 } = {}) {
      const readingSeconds = words > 0 ? (words * 60) / wordsPerMinute : 0;
      const actionSeconds = actions * 1.5;
      const waitSeconds = waitMs / 1000;
      spend(readingSeconds + actionSeconds + waitSeconds);
    },
    /**
     * Reading, as one sitting: `words / wordsPerMinute`, but never more than ONE attention span.
     * Nobody reads past the point they got bored in a single glance, and charging the whole page did
     * exactly that: on 2026-09-21 Dev Dan (300 wpm, unlimited words per look, 300 s of patience)
     * was "exhausted" by his SECOND look at Example App Next, because every look charged the entire
     * long homepage. Running out of attention is still the signal - she is bored - it just no longer
     * ends the visit on a long page by itself. The body passes only words NEW to her on this page.
     */
    read(words) {
      if (!(words > 0)) return;
      const seconds = (words * 60) / wordsPerMinute;
      spend(attentionBudgetSeconds > 0 ? Math.min(seconds, attentionBudgetSeconds) : seconds);
    },
    /**
     * Time she spent re-reading or weighing words she was already charged attention for (a lingered or unsure rest, a
     * considered weighing): it passes on the clock and wears her patience, but not her attention a second time.
     */
    rested(seconds) {
      if (!(seconds > 0)) return;
      patienceLeftSeconds = Math.max(0, patienceLeftSeconds - seconds);
      elapsedTotalSeconds += seconds;
    },
    /** A navigation, or a click that changed the page: her attention budget is full again. */
    newPage() {
      attentionLeftSeconds = attentionBudgetSeconds;
    },
    /** Her hands did something (a click, a point) since her last look. */
    handsMoved() {
      handsSinceLook = true;
    },
    /**
     * Each look's picture, by hash. A `canvas: true` game is one URL for the whole match, so a new
     * page never comes: there, a picture that changed after her own hand moved refills attention
     * the way a new page does. A picture that changed while she only waited does not (a player with
     * nothing to do still gets bored), and on an ordinary page only newPage refills. True if it did.
     */
    picture(hash, { canvas = false } = {}) {
      const refills = Boolean(canvas && handsSinceLook && hash && lastPicture && hash !== lastPicture);
      if (refills) attentionLeftSeconds = attentionBudgetSeconds;
      if (hash) lastPicture = hash;
      handsSinceLook = false;
      return refills;
    },
    elapsedSeconds() {
      return elapsedTotalSeconds;
    },
    attentionLeft() {
      return attentionLeftSeconds;
    },
    patienceLeft() {
      return patienceLeftSeconds;
    },
    state,
    /** The line `look` prepends when she is not fine - never called when `state()` is `"fine"`. */
    mood() {
      const mild = temperature < 0.5;
      const own = (line) => `[Your own mood, not on the page: ${line}]`;
      switch (state()) {
        case "exhausted":
          return own(
            mild
              ? "you are tired of this and ready to be done, whatever happens next."
              : "you are furious, you are done with this, completely, right now.",
          );
        case "bored":
          return own(
            mild
              ? "you are getting a little bored with this page and your eyes are wandering."
              : "you are bored and irritated with this page, and it is starting to show.",
          );
        default:
          return own("you are reading along, fine for now.");
      }
    },
  };
}
