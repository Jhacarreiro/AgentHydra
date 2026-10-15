/**
 * Lift's own tape checks, for `node sue/tape.mjs lint <tape> --rules sue/tape/examples/lift-rules.mjs`.
 *
 * Everything here is Lift's: SUE's generic checks (tape/lint.mjs) know nothing about a lesson, a band or a bar.
 * Each rule reads one screen's inventory and controls, or the tape's edges (the screen a tap came from), and
 * names the Lift ledger finding it keeps from coming back (docs/kids/ledger.json, by id).
 *
 * Words per band, reading grade, kid words and the inverted-question test are not retyped: this loads Lift's own
 * checker (site/assets/validate.js, read only) and asks it, so its caps and its error/warning levels are the ones used.
 * Only the walk's layout numbers (tools/walk.mjs: the line of why at 17px, Next within 90px of the result) are
 * kept here, so the two cannot disagree. The generic first-action-below-fold check already uses the walk's `y + 30 > vh`.
 *
 * Lift's band is on the lesson, and Lift's player puts it in the URL: `#/play/<lesson>-<a|b|c|d>`, then maybe
 * `/class` or `/skip` (tape/examples/lift-class.mjs scopes on the same hash). A screen with no such hash is not a
 * lesson screen and the band rules skip it. Nothing is guessed.
 */
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { newBlocks, tapResults } from "../lint.mjs";

// Lift's own checker is the one rulebook: its caps, word counting, reading grade, kid words, inverted-question test and
// their error/warning levels are asked of it, never retyped here. Same checkout as examples/lift-class.mjs.
const LIFT_DIR = process.env.LIFT_DIR || "D:/NEWProjects/active/Lift";
const validate = createRequire(import.meta.url)(path.join(LIFT_DIR, "site/assets/validate.js"));
// validate.js exports only BAND_LIMITS, LESSON_WORDS, readingGrade, studentText, validatePack and twinProblems. Its caps,
// kid-word list and send/inverted tests are private, so each is read by handing validatePack a one-screen pack that
// breaks the rule and reading the verdict (for a cap, the "at most N" it prints). A pack with no other part
// of a lesson draws unrelated errors; only the message of the rule asked about is read.

// walk.mjs
const WHY_MIN_PX = 17;
const NEXT_GAP_MAX_PX = 90;
const RESULT_SLACK_PX = 2;

// Not validate.js's: the ledger's mastery word and Spanish phrases, and Next, which is a button but not an answer.
const NEXT_BUTTON = /^\s*(next|continue|finish|siguiente|continuar|terminar)/i;
const MASTERY = /\bmaster(y|ed)\b/i;
const ES_NOT_HOUSTON = /\baplicas?\b|\bchecar\b/i;

// What Lift's student player renders (site/student/player.js, i18n.js), read from the files:
//  - the question is `<h2 class="q">`, a level-2 heading;
//  - an answer is a `.choice` button whose first span is its key number (player.js:401), so the name starts "1 ";
//  - a box's label is `<p class="box-label">name <span>· box.tap</span></p>`;
//  - the first screen's guess note is `<p data-guess>🎲 mcq.guess</p>` (i18n.js, per language).
// i18n.js reads Lift's language registry from window.LiftLanguages, which the page loads first (site/assets/languages.js).
const LANGUAGES = createRequire(import.meta.url)(path.join(LIFT_DIR, "site/assets/languages.js"));
const lift = (lang) => {
  const window = { LIFT_CLASS: { lang }, LiftLanguages: LANGUAGES };
  vm.runInNewContext(readFileSync(path.join(LIFT_DIR, "site/student/i18n.js"), "utf8"), {
    window,
    localStorage: { getItem: () => null },
    document: { documentElement: {} },
  });
  return window.Lift;
};
const I18N = { en: lift("en"), es: lift("es") };
const say = (screen, key) => I18N[isSpanish(screen) ? "es" : "en"].t(key);

// The lesson's id is the segment after #/play/ up to the next / (the portal opens `#/play/<id>/class`, a skip is
// `#/play/<id>/skip`); its band is the id's last letter (tape/examples/lift-class.mjs scopes on the same hash).
const bandOf = (screen) => {
  const id = /#\/play\/([^/?#]+)/.exec(screen.url ?? "")?.[1];
  const m = id && /-([a-d])$/i.exec(id);
  return m ? m[1].toUpperCase() : null;
};
const isSpanish = (screen) => (screen.inventory.lang || "").startsWith("es");
const isQuestion = (b) => b.kind === "heading" && b.level === 2;
const liveControls = (screen) => (screen.controls ?? []).filter((c) => c.kind === "tap" || c.kind === "choose");
const answerText = (c) => String(c.name).replace(/^\d+\s+/, "");
const orderOfControl = (screen, c) => (screen.inventory.elements ?? []).find((e) => e.id === c.sueId)?.order ?? Infinity;
const barTotal = (screen) => {
  for (const b of screen.inventory.blocks ?? []) {
    const m = /^(\d+)\/(\d+)$/.exec(b.text.trim());
    if (m) return Number(m[2]);
  }
  return null;
};
/** What validatePack says about a pack made from these parts, in the screen's language. */
function verdict(screen, band, pack) {
  const r = validate.validatePack({ band, ...(isSpanish(screen) ? { lang: "es" } : {}), steps: [], ...pack });
  return { errors: r.errors, warnings: r.warnings, stats: r.stats };
}
/** The same for one hook step (a question and its answers). A pack with no other part of a lesson draws unrelated
 *  errors; only the message of the rule asked about is read. */
const askHook = (screen, band, step) => verdict(screen, band, { steps: [{ kind: "hook", choices: ["a", "b", "c"], answer: 0, ...step }] });
const messages = (list, re) => list.map((m) => re.exec(m)).filter(Boolean);

const isBoxed = (screen) => {
  const tap = say(screen, "box.tap");
  return (screen.inventory.blocks ?? []).some((b) => b.text.endsWith(`· ${tap}`));
};
const questions = (screen) => (screen.inventory.blocks ?? []).filter(isQuestion);
// every word the player shows: the blocks, and the answers' names without their key number
const shownText = (screen) => [...(screen.inventory.blocks ?? []).map((b) => b.text), ...liveControls(screen).map(answerText)];
const clip = (t) => String(t).slice(0, 50);

/** The one line of why a tap added: the longest block that is not the next question. */
function lineOfWhy(screen, parent) {
  const added = newBlocks(screen, parent).filter((b) => !isQuestion(b) && b.wordCount >= 4);
  return added.sort((a, b) => b.wordCount - a.wordCount)[0] ?? null;
}

/** The result a tap showed and the Next that follows it: the last new block before Next, in page order. */
function resultAndNext(screen, parent) {
  const next = liveControls(screen).find((c) => c.rect && NEXT_BUTTON.test(c.name));
  if (!next) return null;
  const before = newBlocks(screen, parent).filter((b) => b.order < orderOfControl(screen, next));
  const result = before[before.length - 1];
  return result ? { next, result } : null;
}

export const rules = [
  {
    id: "lift-question-too-long",
    level: "error",
    why: "a question over its band's word cap is not read in one breath (too-many-words, short-questions, read-once-questions, sofia-reads-in-one-look)",
    check({ screen }) {
      const band = bandOf(screen);
      if (!band) return [];
      const hits = [];
      for (const b of questions(screen)) {
        const { errors } = askHook(screen, band, { q: b.text });
        for (const m of messages(errors, /the question is (\d+) words; band \w asks in at most (\d+)/))
          hits.push({ target: `band ${band}: "${clip(b.text)}"`, measured: Number(m[1]), limit: Number(m[2]) });
      }
      return hits;
    },
  },
  {
    id: "lift-choice-too-long",
    level: "error",
    why: "an answer over its band's word cap (a boxed line of a message gets the wider one) is not read in one look (too-many-words, short-enough-for-a-phone)",
    check({ screen }) {
      const band = bandOf(screen);
      if (!band || !questions(screen).length) return [];
      const boxed = isBoxed(screen);
      const hits = [];
      for (const c of liveControls(screen).filter((c) => !NEXT_BUTTON.test(c.name))) {
        // one answer at a time: validate.js reads word counts only for a question with 3 or 4 answers
        const { errors } = askHook(screen, band, { ...(boxed ? { box: "x" } : {}), choices: [answerText(c), "b", "c"] });
        for (const m of messages(errors, /choice 1 is (\d+) words; at most (\d+)/))
          hits.push({ target: `band ${band}: "${clip(answerText(c))}"`, measured: Number(m[1]), limit: Number(m[2]) });
      }
      return hits;
    },
  },
  {
    id: "lift-reading-grade",
    level: "error",
    why: "the screen's words read above the band's grade level (reading-level)",
    check({ screen }) {
      const band = bandOf(screen);
      if (!band) return [];
      // validate.js grades the lines of 6 words or more of everything a student reads, English only (stats.readingGrade is
      // null for Spanish); the screen's words go in as vocab terms, which studentText joins one to a line.
      const { errors, warnings, stats } = verdict(screen, band, { vocab: shownText(screen).map((term) => ({ term })) });
      const hit = (list, level) =>
        messages(list, /reading level ([\d.]+) is (?:well )?above the band \w limit of ([\d.]+)/).map((m) => ({
          target: `band ${band}, ${stats.words} words`,
          measured: Number(m[1]),
          limit: Number(m[2]),
          level,
        }));
      return [...hit(errors, "error"), ...hit(warnings, "warning")];
    },
  },
  {
    id: "lift-line-of-why-small",
    level: "error",
    why: "the one line of why under a pick is small print (the-why-is-reading-size, the-saved-line-is-read)",
    check({ screen, tape }) {
      if (!bandOf(screen)) return [];
      const hits = [];
      for (const { from } of tapResults(tape, screen)) {
        const why = lineOfWhy(screen, from);
        if (why && why.fontPx > 0 && why.fontPx < WHY_MIN_PX)
          hits.push({ target: `"${clip(why.text)}"`, measured: why.fontPx, limit: WHY_MIN_PX });
      }
      return hits;
    },
  },
  {
    id: "lift-next-not-under-result",
    level: "error",
    why: "Next sits far below the result it follows, an empty band between (next-sits-under-the-result)",
    check({ screen, tape }) {
      if (!bandOf(screen)) return [];
      const hits = [];
      for (const { from } of tapResults(tape, screen)) {
        const found = resultAndNext(screen, from);
        if (!found) continue;
        const gap = found.next.rect.y - found.result.bottom;
        if (gap > NEXT_GAP_MAX_PX)
          hits.push({ target: `${found.next.name} after "${found.result.text.slice(0, 40)}"`, measured: gap, limit: NEXT_GAP_MAX_PX });
      }
      return hits;
    },
  },
  {
    id: "lift-result-off-the-phone-screen",
    level: "error",
    why: "on a phone the result's last line ends below the screen, so Next is pressed past it (the-result-is-seen-before-next, the-result-is-in-view)",
    check({ screen, device, tape }) {
      const h = screen.inventory.viewport?.h;
      if (device !== "phone" || !h || !bandOf(screen)) return [];
      const hits = [];
      for (const { from } of tapResults(tape, screen)) {
        const found = resultAndNext(screen, from);
        if (found && found.result.bottom > h + RESULT_SLACK_PX)
          hits.push({ target: `"${clip(found.result.text)}"`, measured: found.result.bottom, limit: h + RESULT_SLACK_PX });
      }
      return hits;
    },
  },
  {
    id: "lift-guess-line-under-answers",
    level: "error",
    why: "the line that says the first question is a guess sits under its answers (the-guess-line-is-read-first)",
    check({ screen }) {
      if (!bandOf(screen)) return [];
      const live = liveControls(screen).map((c) => orderOfControl(screen, c));
      if (live.length < 2) return [];
      const firstChoice = Math.min(...live);
      // the note the player renders for the first question, in the screen's language (i18n.js mcq.guess)
      const note = say(screen, "mcq.guess");
      return (screen.inventory.blocks ?? [])
        .filter((b) => b.text.includes(note) && b.order > firstChoice)
        .map((b) => ({ target: `"${clip(b.text)}"`, measured: b.order, limit: firstChoice }));
    },
  },
  {
    id: "lift-count-missing",
    level: "error",
    why: "a question screen does not say which question it is of how many (the-count-is-on-screen)",
    check({ screen }) {
      if (!bandOf(screen) || !questions(screen).length || liveControls(screen).length < 2) return [];
      return barTotal(screen) === null ? [{ target: "no n/m on the screen", measured: 0, limit: 1 }] : [];
    },
  },
  {
    id: "lift-card-count-disagrees",
    level: "error",
    why: "a card says one number of questions and the lesson's bar counts another (one-question-count)",
    check({ screen, tape }) {
      const hits = [];
      for (const edge of tape.edgesFrom(screen.id)) {
        const lesson = tape.screens[edge.to];
        if (!lesson || lesson.device !== screen.device || !bandOf(lesson) || bandOf(screen)) continue;
        const total = barTotal(lesson);
        if (total === null) continue;
        for (const b of screen.inventory.blocks ?? []) {
          const m = /\b(\d+)\s+(?:questions?|preguntas?)\b/i.exec(b.text);
          if (m && Number(m[1]) !== total)
            hits.push({ target: `"${m[0]}" on the card, bar says ${total}`, measured: Number(m[1]), limit: total, screen: screen.id });
        }
      }
      return hits;
    },
  },
  {
    id: "lift-kid-words",
    level: "error",
    why: "a word Lift's kids dropped came back: a send-like answer, mastery, a which-is-weakest or NOT question, words kids could not say (no-send-labels, no-answer-reads-as-a-send-button, no-mastery-word, no-not-questions, a-call-is-asked-straight, kid-words, spanish-says-solicitar, spanish-from-school-not-the-street)",
    check({ screen }) {
      const band = bandOf(screen);
      if (!band) return [];
      const hits = [];
      const one = (target, level) => hits.push({ target, measured: 1, limit: 0, ...(level ? { level } : {}) });
      const blocks = screen.inventory.blocks ?? [];
      // kid words: validate.js skips band D and Spanish, warns for band C, errors for A and B, and lets a glossed one pass
      const where = (word) => shownText(screen).find((t) => t.toLowerCase().includes(word.toLowerCase())) ?? word;
      const words = verdict(screen, band, { vocab: shownText(screen).map((term) => ({ term })) });
      for (const [list, level] of [
        [words.errors, "error"],
        [words.warnings, "warning"],
      ])
        for (const m of messages(list, /^"([^"]+)": a word the kids stopped on/))
          one(`"${clip(where(m[1]))}" has a word kids could not say`, level);
      // an answer that starts like a send button (validate.js: the error names which choice)
      const answers = liveControls(screen).filter((c) => c.kind === "choose" || c.role === "button");
      for (const c of answers) {
        const { errors } = askHook(screen, band, { choices: [answerText(c), "b", "c"] });
        if (messages(errors, /choice 1 starts with a word that reads as a send button/).length) one(`answer "${clip(c.name)}"`, "error");
      }
      for (const b of questions(screen)) {
        const { errors, warnings } = askHook(screen, band, { q: b.text });
        if (messages(errors, /asks for the weakest or worst one/).length)
          one(`"${clip(b.text)}" asks the weakest or the worst one`, "error");
        if (messages(warnings, /asks with "not"/).length) one(`"${clip(b.text)}" asks with "not"`, "warning");
      }
      // not in validate.js: Lift's ledger (no-mastery-word, spanish-from-school-not-the-street)
      for (const b of blocks) {
        if (MASTERY.test(b.text)) one(`"${clip(b.text)}" says mastery`);
        if (isSpanish(screen) && ES_NOT_HOUSTON.test(b.text)) one(`"${clip(b.text)}" is not how a Houston teacher says it`);
      }
      return hits;
    },
  },
];

export default rules;
