// dredd/lib/claim-routing.mjs - which experts weigh in on a unit of REAL complaints (the expert-homework stage).
//
// Jev answers every seat's own question with the unit's complaints as the state, and the yeses sit, strongest first
// (lib/claim-diagnosis.mjs runs it; routing.json in a docket holds what it chose). A decision file (DECISION_PATHS in
// lib/hunt.mjs): on Packing Buddy (docket 20261010-050616-c3ec) it sent design-critic and mind-norman to 20 of 21
// units, so a change to ROUTE_MAX or routeSeats is A/B'd over eval/experts.json (`eval.mjs --experts-only`, replayed
// free from a saved run's answers), and a seat question's change by the full Jev eval it owes.
import { pYes } from "./docket.mjs";
import { askJev } from "./jev.mjs";
import { buildSeatQuestions, heuristicSeatAnswers, SIT } from "./seats.mjs";

/** Seats routed to one unit: Jev's yeses, strongest first, at most this many; the strongest one when Jev said no to all. */
export const ROUTE_MAX = 4;

/**
 * The bar a seat clears to take a unit's homework when Jev answered. SIT seats a hearing; here each yes is an expert
 * paid to read the whole unit. Over the two saved Jev answer sets on eval/experts.json's trained units (2026-10-10),
 * the seats Jev put between 0.50 and 0.55 were fair-to-have ones the unit did not need, the Architect on a page of bare
 * icons and two minds nobody wanted, beside one wanted Copy Editor (0.53) that ROUTE_MAX already cut. At 0.55 neither
 * set lost a wanted expert, the exact units rose 12 -> 13 and 11 -> 13, and the experts sent fell 63 -> 56 and 61 -> 56;
 * 0.6 cut a wanted Copy Editor at 0.56 on the second set. Calibrated on Jev's probabilities like ROOM_SIT (lib/seats.mjs
 * sitFor), so the keywords' "p", a hit count on another scale, keep SIT.
 */
export const ROUTE_SIT = 0.55;

const clip = (text, max) => {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
};

/** What Jev reads for one unit: the product, the screen, the likely cause and the complaints, one line each. Pure. */
export function unitBrief(unit, { url = null } = {}) {
  return [
    `A product's visitors filed these complaints about its screen ${unit.screen}${url ? ` (${url})` : ""}, and the room`,
    `ruled each one real.${unit.cause ? ` Their likely shared cause: ${unit.cause}.` : ""} Diagnosing them and designing the fix:`,
    ...unit.claims.map((c) => `- ${c.id}: ${clip(c.text, 300)}`),
  ].join("\n");
}

/**
 * The seats one unit is routed to, from Jev's answers to every seat's own question: the yeses (p >= ROUTE_SIT, or SIT
 * when `source` is the keywords), strongest first, at most `max`, a visitor's voice after the rest; when Jev said no to
 * every seat, the strongest one, and the row says so. Pure.
 *
 * A seat that speaks as one of SUE's visitors (`briefFrom.sue`) keeps its place among the yeses but never goes first:
 * a unit is visitors' complaints the room already ruled real, so that voice restates its evidence, and the first expert
 * routed is the one who sits when the allowance runs short. Rewording Grandma Sue's question to say so moved the lead
 * and broke the hearings' seat pick twice (2026-10-10, ab-ledger rejects): one question serves both, here the order.
 */
export function routeSeats(roster, answers, { source = "jev", sit = source === "jev" ? ROUTE_SIT : SIT, max = ROUTE_MAX } = {}) {
  const voices = new Set(roster.filter((s) => s.briefFrom?.sue).map((s) => s.id));
  const rows = roster
    .filter((s) => s.jev)
    .map((s) => ({ id: s.id, name: s.name, p: Math.round(pYes(answers?.[`seat:${s.id}`]) * 100) / 100 }))
    .sort((a, b) => b.p - a.p);
  const yes = rows.filter((r) => r.p >= sit).slice(0, max);
  const ordered = [...yes.filter((r) => !voices.has(r.id)), ...yes.filter((r) => voices.has(r.id))];
  if (ordered.length) return ordered.map((r) => ({ ...r, why: "jev: yes" }));
  return rows.slice(0, 1).map((r) => ({ ...r, why: "jev said no to every seat: the strongest weighs in" }));
}

/**
 * Jev's answers to every seat's question about one unit (lib/jev.mjs askJev, the typed door that picks a hearing's
 * seats). When Jev cannot answer, the bench's keyword heuristic answers, and `by` says so; `jev` is false then.
 */
export async function answerUnit(unit, { roster, ask = askJev, url = null } = {}) {
  const brief = unitBrief(unit, { url });
  const r = await ask(buildSeatQuestions(roster, brief), { timeoutMs: 180_000 });
  if (!r?.answers)
    return {
      answers: heuristicSeatAnswers(roster, brief),
      by: `keywords (Jev could not answer: ${r?.reason || "no answer"})`,
      jev: false,
      r,
    };
  if (!r.unanswered?.length) return { answers: r.answers, by: "jev", jev: true, r };
  const guessed = heuristicSeatAnswers(roster, brief);
  const answers = { ...r.answers };
  for (const id of r.unanswered) answers[id] = guessed[id];
  return { answers, by: `jev (${r.unanswered.length} question(s) left open, answered by keywords)`, jev: true, r };
}

/**
 * Jev routes every unit: each seat of `roster` is asked its own `jev` question with the unit's complaints as the state.
 * Returns [{ unit, screen, cause, claims, seats: [{ id, name, p, why }], by, summary }] in unit order.
 */
export async function routeUnits(units, { roster, ask = askJev, url = null, together = 4 } = {}) {
  const out = new Map();
  const one = async (u) => {
    const { answers, by, jev, r } = await answerUnit(u, { roster, ask, url });
    out.set(u.id, {
      unit: u.id,
      screen: u.screen,
      cause: u.cause,
      claims: u.claims.map((c) => c.id),
      seats: routeSeats(roster, answers, { source: jev ? "jev" : "keywords" }),
      by,
      summary: r?.summary ?? null,
    });
  };
  for (let i = 0; i < units.length; i += together) await Promise.all(units.slice(i, i + together).map(one));
  return units.map((u) => out.get(u.id));
}
