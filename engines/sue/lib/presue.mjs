/**
 * presue - before anybody goes: does SUE have the right people for this page, and if not, onboard them.
 * ======================================================================================================
 *
 * Owner ask (the Chair, 2026-10-05): "Sue/Dredd need a Jev. Pre-sue. That checks if we have the appropriate sues to
 * review. And if not, onboard (create) the ones relevant." A link run that named nobody, on a site nobody had saved
 * people for, sent the roster mix (Grandma Sue, TikTok Sue, Small-business Bob ...) whatever the page was: OperatorLink,
 * the phone tool a crane operator and the ground crew signal each other with, would have been judged by a retired
 * schoolteacher and a college sophomore, and their notes read as if they were its users.
 *
 * THE CHECK. Everyone who could go is one yes/no for Jev (TypeSafe's typed classifier, through HSwarm: the door Dredd
 * and the Almanac already use): the built-in roster, and this workspace's people written for the page's site or for no
 * site. Never a critic (a reviewer is sent by the ask, never drawn as a visitor), and a child only when the ask says the
 * visitors are children. Every question shares one state (the page and why the visitors come), so Jev answers them all
 * in one call, about two seconds and a fraction of a cent. A person at FIT_BAR or above fits. Measured 2026-10-05 with
 * FIT_QUESTION: on the crane page a heavy-equipment operator 0.88 and a rigger 0.89, Grandma, Bob and Dev Dan 0.07 or
 * less; on a small-business page Bob 0.82 and the crane people 0.04. With no Jev (no key, no network, a copy of SUE with
 * no Dredd beside it) the floor is structural and named: the people saved for this site fit, nobody else.
 *
 * THE ONBOARDING. Fewer than `need` fit: the HSwarm brain casts the kinds of person still missing (lib/cast.mjs
 * castPrompt, told who is already going), each is loaded exactly as a run loads her, and Jev asks each of them the same
 * question, so a draft that is not one of the page's real visitors is refused by name. The ones kept are new Sue people
 * written for this site (`for`); whoever holds the Boardroom door saves them to the workspace (`saveOnboarded`), so the
 * next run on the page finds them fitting and drafts nobody. Children are never drafted (a cast visitor is never a
 * child), so a kids ask that is short says so instead.
 *
 * Pure but for the injected doors: `jev(items)` answers like dredd/lib/jev.mjs askJev, `brain(spec)` like
 * dredd/lib/brain.mjs askBrain, `readPage(url)` like dredd/lib/visitors.mjs readPage. The people must be
 * installed first (lib/personas.mjs installPeople). DEPENDED ON BY: sue.mjs (the `presue` command, and every link run
 * that names nobody), dredd/lib/visitors.mjs (a hearing's cast). Spec: tests/presue.spec.mjs.
 */
import { APE_MIN_TECH, CAST_MAX, CAST_SCHEMA, castFromAnswer, castPrompt, childrenInAsk } from "./cast.mjs";
import { keptCopy, savePeople } from "./people.mjs";
import { builtInPerson, listPersonas, ownPeople, techProwessOf } from "./personas.mjs";
import { hostOfUrl } from "./site-owner.mjs";
import { MIN_ERRAND_CHARS, writtenFor } from "./workspace.mjs";

/** Jev's yes-probability a person needs to count as one of the page's real visitors (Dredd's seat bar, same scale). */
export const FIT_BAR = 0.5;
/** How many fitting people a page needs before nobody is drafted: three different kinds of visitor. Its own number, not CAST_MAX, which a focus group raises. */
export const PRESUE_NEED = 3;
/** The most fitting people one run names, strongest first: a site with sixty saved people sends the eight that fit best. */
export const PRESUE_SEND_MAX = 8;
/** How much of a person's voice Jev reads: who she is, never the whole paragraph. */
const VOICE_CHARS = 420;

/**
 * The one question every person is asked. Its "rather than" half is what separates: worded without it, a crane
 * operator on the crane page read 0.52 and 0.61 (2026-10-05).
 */
export const FIT_QUESTION =
  "Is this person one of the REAL visitors this page is built for, someone whose own job or life brings them here for the reason given - rather than a stranger from an unrelated line of work who would never use it? The person:";

const stripWww = (h) =>
  String(h)
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

/** The sites a person was written for, or null when she names none. */
function forHosts(doc) {
  const hosts = Array.isArray(doc?.for) ? doc.for.map(stripWww).filter(Boolean) : [];
  return hosts.length ? hosts : null;
}

/** A person's comfort with computers (her body's techProwess dial, 1-5): the power-user cut an APE run keeps. */
const techOf = (id) => techProwessOf(id) ?? 0;

/** Her age from her identity's birth years (or her body's, when she borrows one), or null when neither says. */
function ageOf(doc, now) {
  const years = doc?.identity?.birthYear ?? (doc?.extends ? builtInPerson(doc.extends)?.identity?.birthYear : null);
  if (!Array.isArray(years) || years.length !== 2) return null;
  return now.getFullYear() - Math.round((Number(years[0]) + Number(years[1])) / 2);
}

/**
 * Everyone who could go to `url` for `intent`: `{ id, displayName, voice, kind, for }` each, the built-ins first. A
 * workspace's copy of a built-in stands in for her; a workspace person goes only when written for this site or for none.
 */
export function presueCandidates({ url, intent = "", now = new Date() } = {}) {
  const kids = childrenInAsk(intent);
  const fitsAge = (doc) => {
    const age = ageOf(doc, now);
    return age == null ? !kids : kids ? age < 18 : age >= 18;
  };
  const roster = listPersonas();
  const own = ownPeople();
  const copyOf = new Map(own.filter((p) => roster.includes(p.id)).map((p) => [p.id, p]));
  const out = [];
  const add = (doc, kind) =>
    out.push({
      id: doc.id,
      displayName: String(doc.displayName ?? doc.id),
      voice: String(doc.voice ?? "").slice(0, VOICE_CHARS),
      kind,
      for: forHosts(doc),
    });
  for (const id of roster) {
    const doc = copyOf.get(id) ?? builtInPerson(id);
    if (doc && doc.critic !== true && fitsAge(doc)) add(doc, "built-in");
  }
  for (const doc of own) {
    if (roster.includes(doc.id) || doc.critic === true || !writtenFor(doc, url) || !fitsAge(doc)) continue;
    add(doc, "workspace");
  }
  return out;
}

/**
 * The state every fit question shares: the page as read (or its absence), why the visitors come, and (a field run's,
 * lib/field.mjs) what kind of product Jev read it as, so a person from the wrong world reads as a stranger to it.
 */
export function presueState({ url, page = null, intent, expect = null, scope = null }) {
  const pageLines = page
    ? [
        `Title: ${page.title || "(none)"}`,
        page.description ? `Description: ${page.description}` : null,
        page.headings?.length ? `Headings: ${page.headings.join(" | ")}` : null,
        `What the page says: ${String(page.text || "(nothing readable)").slice(0, 1200)}`,
      ]
    : ["(The page could not be read, so go by its address and the reason.)"];
  return [
    "A usability visit is planned: simulated people will use this page, and the owner wants to learn where its REAL visitors get stuck.",
    `The page: ${url}`,
    ...pageLines,
    `Why the visitors come: ${String(intent ?? "").trim()}`,
    expect ? `What the page is meant to be: ${String(expect).trim()}` : null,
    scope ? `What kind of product this is: ${String(scope).trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One yes/no per person, in Jev's item shape (dredd/lib/docket.mjs buildQuestions), all on one state. */
export function presueQuestions(people, state) {
  return people.map((p) => ({
    id: `fit:${p.id}`,
    state,
    type: "yesno",
    question: `${FIT_QUESTION} ${p.displayName} - ${String(p.voice ?? "").slice(0, VOICE_CHARS)}`,
  }));
}

/** The floor with no Jev: saved for this site fits, nobody else does. */
export function floorFit(person, host) {
  return person.for?.includes(stripWww(host)) ? 0.9 : 0.1;
}

/**
 * Who fits, strongest first, from Jev's answers (`answers`, keyed `fit:<id>`) or, for anyone Jev left unanswered or
 * with no answers at all, the floor. Ties go to the person saved for this site, then by id, so a rerun sends the same.
 * `{ fit, closest }`: closest is the three best under the bar, so a short answer says who nearly made it.
 */
export function decideFit({ candidates, answers = null, host, bar = FIT_BAR }) {
  const rows = candidates.map((c) => {
    const said = answers?.[`fit:${c.id}`]?.probabilities?.yes;
    const jev = typeof said === "number" && Number.isFinite(said);
    return { ...c, p: jev ? said : floorFit(c, host), by: jev ? "jev" : "floor" };
  });
  const savedHere = (r) => (r.for?.includes(stripWww(host)) ? 1 : 0);
  rows.sort((a, b) => b.p - a.p || savedHere(b) - savedHere(a) || a.id.localeCompare(b.id));
  return { fit: rows.filter((r) => r.p >= bar), closest: rows.filter((r) => r.p < bar).slice(0, 3) };
}

const slim = (r) => ({ id: r.id, displayName: r.displayName, p: Math.round(r.p * 100) / 100, by: r.by, kind: r.kind });

/**
 * Draft the `short` kinds of person still missing, load each as a run would, and keep only those Jev also finds
 * fitting. `{ visitors, refused, model?, note? }`; never throws.
 */
async function draftMissing({ short, intent, url, page, state, fit, brain, jev, kids, ape = false, scope = null }) {
  if (kids)
    return {
      visitors: [],
      refused: [],
      note: "the visitors are children, and a drafted visitor is never a child: save the children this page is for, or name the roster's",
    };
  if (!brain) return { visitors: [], refused: [], note: "no brain to draft with in this process, so nobody was drafted" };
  // One spare beside the ones missing (a cast's size at most), so a draft Jev refuses leaves the page no shorter.
  const { system, prompt } = castPrompt({ ask: intent, url, page, count: Math.min(CAST_MAX, short + 1), already: fit, ape, scope });
  let res;
  try {
    res = await brain({ system, prompt, schema: CAST_SCHEMA, timeoutS: 90, profile: "routine" });
  } catch (err) {
    res = { status: "error", error: String(err?.message ?? err) };
  }
  if (res?.status !== "ok" || !res.data)
    return {
      visitors: [],
      refused: [],
      note: `the brain drafted nobody: ${String(res?.error || res?.status || "no answer").slice(0, 200)}`,
    };
  const cast = castFromAnswer(res.data, { url, taken: ownPeople().map((p) => p.id) });
  const refused = [...cast.refused];
  // An APE run seats power users only: a draft on a body under the cut is refused here, whatever Jev says of her.
  const drafted = [];
  for (const v of cast.visitors) {
    if (ape && techOf(v.extends) < APE_MIN_TECH)
      refused.push({ id: v.id, why: `comfort with computers ${techOf(v.extends)}/5: an APE run seats power users only` });
    else drafted.push(v);
  }
  if (!drafted.length) return { visitors: [], refused, model: res.model ?? null, note: "every draft was refused" };
  // The same question the saved people answered: a draft that is not one of the page's real visitors does not go.
  const checked = jev ? await askFit(jev, presueQuestions(drafted, state)) : null;
  if (!checked?.answers)
    return {
      visitors: drafted.slice(0, short),
      refused,
      model: res.model ?? null,
      note: `drafts not re-checked: ${checked?.reason || "no Jev in this process"}`,
    };
  const passed = [];
  for (const v of drafted) {
    const p = checked.answers[`fit:${v.id}`]?.probabilities?.yes;
    if (typeof p === "number" && p < FIT_BAR)
      refused.push({ id: v.id, why: `Jev did not find her one of the page's visitors (${p.toFixed(2)})` });
    else passed.push(v);
  }
  return { visitors: passed.slice(0, short), refused, model: res.model ?? null };
}

/** Jev's answer, or `{ answers: null, reason }`: a door that throws is a door that did not answer. */
async function askFit(jev, items) {
  if (!items.length) return { answers: {}, unanswered: [] };
  try {
    return await jev(items);
  } catch (err) {
    return { answers: null, reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * Pre-sue one page: who of SUE's people fit it, and the ones drafted where too few do. Answers the report a run carries
 * (`send` is who goes, strongest first; `onboarded` the new people, whole, still to be saved by whoever holds the door).
 * Throws only on a call that cannot be pre-sued at all (no web address, no reason to visit).
 */
export async function runPresue({
  url,
  intent,
  expect = null,
  count = null,
  jev = null,
  brain = null,
  readPage = null,
  now = new Date(),
  ape = false,
  scope = null,
}) {
  const host = hostOfUrl(url);
  if (!host) throw new Error("pre-sue needs the page's web address (url)");
  const why = String(intent ?? "").trim();
  if (why.length < MIN_ERRAND_CHARS)
    throw new Error(`pre-sue needs the intent: one whole sentence (${MIN_ERRAND_CHARS}+ characters) on why these people come`);
  const need = Math.max(1, Math.min(PRESUE_NEED, Number.isInteger(count) && count > 0 ? count : PRESUE_NEED));
  // Where its time goes, per stage, in the report: a pre-sue sits in front of a run's start, so its cost is measured.
  const ms = {};
  const timed = async (stage, work) => {
    const t0 = performance.now();
    try {
      return await work();
    } finally {
      ms[stage] = Math.round(performance.now() - t0);
    }
  };
  let read = null;
  if (readPage)
    read = await timed("page", () =>
      Promise.resolve()
        .then(() => readPage(url))
        .catch((err) => ({ error: String(err?.message ?? err) })),
    );
  const page = read && !read.error ? read : null;
  const all = presueCandidates({ url, intent: why, now });
  // An APE run seats power users only: anyone under the cut is left home, named in `said`, and never asked to fit.
  const left = ape ? all.filter((c) => techOf(c.id) < APE_MIN_TECH) : [];
  const candidates = left.length ? all.filter((c) => !left.includes(c)) : all;
  const state = presueState({ url, page, intent: why, expect, scope });
  const asked = jev
    ? await timed("jev", () => askFit(jev, presueQuestions(candidates, state)))
    : { answers: null, reason: "no Jev in this process" };
  const judgeNote = !asked?.answers
    ? `Jev did not answer (${asked?.reason || "no answer"}), so the people saved for this site fit and nobody else does`
    : asked.unanswered?.length
      ? `Jev left ${asked.unanswered.length} unanswered; the floor answered them`
      : null;
  const { fit, closest } = decideFit({ candidates, answers: asked?.answers ?? null, host });
  const short = Math.max(0, need - fit.length);
  const drafted = short
    ? await timed("draft", () => draftMissing({ short, intent: why, url, page, state, fit, brain, jev, kids: childrenInAsk(why), ape, scope }))
    : { visitors: [], refused: [] };
  const going = fit.slice(0, PRESUE_SEND_MAX);
  const send = [...going.map((r) => r.id), ...drafted.visitors.map((v) => v.id)];
  const judge = asked?.answers ? "jev" : "floor";
  const said =
    `Pre-sue (${judge === "jev" ? "Jev" : "no Jev"}): ${fit.length} of ${candidates.length} people fit ${host}` +
    (going.length ? ` (${going.map((r) => `${r.id} ${r.p.toFixed(2)}`).join(", ")})` : "") +
    (drafted.visitors.length ? `; onboarded ${drafted.visitors.map((v) => v.id).join(", ")}` : "") +
    (short && !drafted.visitors.length ? `; ${short} short and nobody onboarded (${drafted.note || "every draft was refused"})` : "") +
    (left.length ? `; left home, not power users: ${left.map((c) => `${c.id} (comfort with computers ${techOf(c.id)}/5)`).join(", ")}` : "") +
    ".";
  return {
    ok: true,
    url,
    host,
    need,
    bar: FIT_BAR,
    judge,
    ...(judgeNote ? { judgeNote } : {}),
    page: page ? { title: page.title, description: page.description } : { error: read?.error || "not read" },
    asked: candidates.length,
    ...(left.length ? { leftHome: left.map((c) => c.id) } : {}),
    fit: fit.map(slim),
    closest: closest.map(slim),
    onboarded: drafted.visitors,
    ...(drafted.refused.length ? { refused: drafted.refused } : {}),
    ...(drafted.note ? { onboardNote: drafted.note } : {}),
    ...(drafted.model ? { draftedBy: drafted.model } : {}),
    send,
    said,
    ms,
  };
}

/**
 * Save the onboarded people to the workspace in Connections through `door` (lib/people.mjs: the Boardroom's Sue save),
 * one `{ id, saved, why? }` each, said honestly: a copy Connections did not keep is not called saved. Never throws.
 */
export async function saveOnboarded(door, visitors, { now = () => new Date().toISOString() } = {}) {
  const items = (Array.isArray(visitors) ? visitors : []).map((doc) => ({ doc, updatedAt: now() }));
  if (!items.length) return [];
  try {
    const answer = await savePeople(door, items);
    return items.map((copy) => {
      const refused = answer.refused.find((r) => r?.id === copy.doc.id);
      return { id: copy.doc.id, ...(refused ? { saved: false, why: refused.why } : keptCopy(answer.people, copy)) };
    });
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 200);
    return items.map((copy) => ({ id: copy.doc.id, saved: false, why }));
  }
}

/**
 * A run's args with pre-sue's people in them: `send` named, the onboarded riding inline as its `cast` (so they go even
 * before, or without, being saved). Args that already name people or carry a cast are the caller's and stay as given.
 * Nobody to send and nobody named is refused with the reason: an empty `send` would hand the run the roster's mix.
 */
export function withPresue(args, report) {
  if (!report?.send?.length) {
    if (args.personas != null || args.cast != null) return args;
    throw new Error(`pre-sue sent nobody to ${report?.host ?? "this page"}: ${report?.said ?? "no people fit"}`);
  }
  return { ...args, personas: report.send, ...(report.onboarded?.length ? { cast: report.onboarded } : {}) };
}
