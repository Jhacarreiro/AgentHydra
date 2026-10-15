/**
 * readability - Flesch-Kincaid grade level for one block of text.
 * =================================================================
 * WHY THIS EXISTS: perception.mjs's `readingGrade` dial (SPEC.md's Perception section) decides,
 * per text block, whether a Sue sees the real words or the tag `[this is hard to read - you skim
 * it and are not sure what it means]`. That decision needs a number, and the number has to come
 * from the text itself, not from a guess - a persona with `readingGrade: 3` (Child Sue) must
 * actually choke on the same legalese paragraph a grade-14 persona reads clean.
 *
 * The syllable count is a heuristic (vowel-group counting with the trailing-silent-e and -le
 * corrections every FK implementation uses), not a dictionary lookup - no new npm dependency is
 * allowed here (sue/SPEC.md), and the heuristic is accurate enough that the grade GAP between
 * a plain sentence and a legalese wall is always wide (tens of points), which is the only thing
 * perception.mjs actually needs to act on.
 *
 * DEPENDED ON BY: lib/perception.mjs's `perceive()` (grades every visible text block long enough to
 * grade against the persona's `readingGrade` dial). tests/readability.spec.mjs is this file's own
 * spec.
 */

/**
 * Count the syllables in one word using vowel-group counting: each run of consecutive
 * `aeiouy` characters is one syllable, with the usual silent-trailing-`e` and `-le` corrections.
 * Never returns less than 1 for a non-empty word.
 */
export function countSyllables(word) {
  const cleaned = String(word ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!cleaned) return 0;

  let syllables = 0;
  let previousWasVowel = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const isVowel = "aeiouy".includes(cleaned[i]);
    if (isVowel && !previousWasVowel) syllables += 1;
    previousWasVowel = isVowel;
  }

  // A trailing "e" that is not part of a "-le" ending (table, circle) is usually silent
  // (like, hope): the vowel-group count already includes it, so drop one back off.
  const endsInSilentE = cleaned.endsWith("e") && !cleaned.endsWith("le");
  if (endsInSilentE && syllables > 1) syllables -= 1;

  return Math.max(1, syllables);
}

/** Split text into sentences on `.`/`!`/`?` runs; a run with no terminator still counts as one. */
function countSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+/g);
  if (matches && matches.length > 0) return matches.length;
  return String(text ?? "").trim() ? 1 : 0;
}

/**
 * Flesch-Kincaid grade level for `text`: 0.39*(words/sentences) + 11.8*(syllables/words) - 15.59,
 * floored at 0, rounded to one decimal. Empty or punctuation-only text is grade 0.
 */
export function fleschKincaidGrade(text) {
  const words = String(text ?? "").match(/[A-Za-z']+/g) || [];
  const wordCount = words.length;
  const sentenceCount = countSentences(text);
  if (wordCount === 0 || sentenceCount === 0) return 0;

  const syllableCount = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const grade = 0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

/**
 * Syllables in one Spanish word. A run of vowels is one syllable unless two strong vowels meet (ta-re-a) or a
 * weak one carries an accent (pa-ís, pa-re-cí-a); the u of que, qui, gue, gui is silent; a final y is a vowel (hoy).
 */
export function countSpanishSyllables(word) {
  const cleaned = String(word ?? "")
    .toLowerCase()
    .replace(/[^a-záéíóúüñ]/g, "")
    .replace(/qu([eiéí])/g, "q$1")
    .replace(/gu([eiéí])/g, "g$1");
  if (!cleaned) return 0;
  let syllables = 0;
  let previous = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    const kind = "aeoáéó".includes(ch) ? "strong" : "íú".includes(ch) ? "stressed" : "iuü".includes(ch) || (ch === "y" && i === cleaned.length - 1) ? "weak" : "";
    if (kind && (!previous || kind === "stressed" || previous === "stressed" || (kind === "strong" && previous === "strong"))) syllables += 1;
    previous = kind;
  }
  return Math.max(1, syllables);
}

/**
 * A school grade for Spanish text. Flesch-Kincaid is fitted to English: its syllable counter knows no
 * accented vowel (to [A-Za-z'], "parecía" is two words) and its weights assume about 1.5 syllables a
 * word where Spanish runs about 2, so a plain Spanish sentence graded 12 to 16 and a Spanish-reading
 * Sue was told ordinary words were over her head (Lift's Spanish-speaking student, 2026-10-01). This
 * is Fernández Huerta's reading ease for Spanish (206.84 - 60 * syllables per word - 1.02 * words per
 * sentence), read on the school-year bands its author gave: 90 and up is about grade 4, 60 to 70
 * grades 7 to 8, 50 to 60 high school, under 30 graduate reading.
 */
export function spanishGrade(text) {
  const words = String(text ?? "").match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g) || [];
  const sentenceCount = countSentences(text);
  if (words.length === 0 || sentenceCount === 0) return 0;
  const syllableCount = words.reduce((sum, word) => sum + countSpanishSyllables(word), 0);
  const ease = 206.84 - 60 * (syllableCount / words.length) - 1.02 * (words.length / sentenceCount);
  const bands = [[100, 4], [90, 5], [80, 6], [70, 7], [60, 9], [50, 12], [30, 16], [0, 18]];
  if (ease >= bands[0][0]) return bands[0][1];
  for (let i = 1; i < bands.length; i += 1) {
    const [hi, gradeHi] = bands[i - 1];
    const [lo, gradeLo] = bands[i];
    if (ease >= lo) return Math.round((gradeLo + ((ease - lo) / (hi - lo)) * (gradeHi - gradeLo)) * 10) / 10;
  }
  return bands[bands.length - 1][1];
}

/** The reading grade of `text` in the language of the page it is on (`lang`, the page's own lang attribute). */
export function readingGradeOf(text, lang) {
  return /^es\b/i.test(String(lang ?? "")) ? spanishGrade(text) : fleschKincaidGrade(text);
}

/**
 * Whether `text` is long enough for a Flesch-Kincaid grade to mean anything: at least 12 words, or
 * at least two sentences. On a heading, label, list item or cell the formula is dominated by
 * syllables per word alone - "Notifications" grades 43.8, "Community events" 20.6 - far above the
 * highest persona's readingGrade (14), so grading short blocks tagged ordinary headings
 * `[this is hard to read - ...]` for every Sue and filed a false reading-grade-over-head finding on
 * every page. Length, not block kind, decides: a long list item or table cell can really be hard.
 */
export function isGradeable(text) {
  const wordCount = (String(text ?? "").match(/[\p{L}']+/gu) || []).length;
  // Two sentences still need words enough to average over: a seven-word chip ("Adivina primero. No cuenta para tu
  // calificación.") graded 12 on one long word.
  return wordCount >= 12 || (countSentences(text) >= 2 && wordCount >= 8);
}
