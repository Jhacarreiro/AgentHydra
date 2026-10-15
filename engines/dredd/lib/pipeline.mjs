// dredd/lib/pipeline.mjs - the stages every instrument passes through on its way onto a docket: FILTER, then SCORE.
//
// WHY: decideDocket was one function whose vetoes were anonymous `return true` lines, so a docket that left an
// instrument home could not say which rule did it, and a rule could only be tested through a whole docket. The
// shape is the Kubernetes scheduler's (a Filter plugin removes a node and gives its reason; a Score plugin ranks
// what is left), adapted as an idea from kubernetes/kubernetes staging/src/k8s.io/kube-scheduler/framework
// (Apache-2.0), written fresh for Dredd: each filter here is one named rule, pure, with the reason it keeps an
// instrument home, and the docket records every instrument's stage and reasons in `home`.
// Behaviour is exactly the old vetoes and bars (a decision file: dredd/ab.mjs grades any change to it).

/** The domains that are a page's or a product's, never code's: an instrument judging only these has nothing to say
 *  about a code matter with no page named (the page-only-judge filter). */
export const PAGE_OR_PRODUCT_DOMAINS = new Set(["copy", "visual", "flow", "product"]);

/** A field instrument that goes out to LOOK AT A PAGE (a browser, a visitor) - the Design Critic, LilGranny, the flow
 *  walk, SUE. The Atlas is field-heavy too but reads AWS, not a page, so "why is the AWS bill up?" may send it: the
 *  question-only ban kept it home at p 0.92 (eval, 2026-09-23). */
export const visitsPage = (inst) => inst.phase === 3 && (inst.domains || []).some((d) => d === "visual" || d === "flow" || d === "copy");

/** An instrument whose every domain is a page or product matter (the marketing council, the Humanizer, the copy checks). */
export const judgesNoCode = (inst) => (inst.domains || []).length > 0 && inst.domains.every((d) => PAGE_OR_PRODUCT_DOMAINS.has(d));

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const fieldOrPulse = (inst) => inst.phase === 3 || inst.id === "page-pulse";

/**
 * The feasibility filters: the rules that keep an instrument home whatever its p. None of them is about how sure Jev
 * was. Each reads the instrument, its p, and the ask's context ({ grievance, subjects, askClass, url, codeKind,
 * roomAsked }) and returns true when it keeps the instrument home; `why` is what the docket says.
 */
export const FILTERS = [
  {
    id: "room-unasked",
    why: "nothing is wrong and nothing is being decided: the room sits only at p 0.85 or more",
    keepsHome: (inst, p, ctx) => !ctx.grievance && inst.id === "boardroom" && p < 0.85,
  },
  {
    id: "no-grievance-no-visit",
    why: "no complaint, review or decision: nobody goes out to look at a page",
    keepsHome: (inst, _p, ctx) => !ctx.grievance && visitsPage(inst),
  },
  // The instruments an ask names as its subject are judged as code; none of the field goes out to look at a page.
  {
    id: "instruments-as-subject",
    why: "the ask is about our own instruments: their code is judged, nobody visits a page",
    keepsHome: (inst, _p, ctx) => ctx.subjects.length > 0 && fieldOrPulse(inst),
  },
  // A decision about something that does not exist yet ("should we build the Sue Manager app?") has no page to look at:
  // the hook once filed a seven-instrument visual tribunal on exactly that question (intake, 2026-09-22).
  {
    id: "decision-without-page",
    why: "a decision with no page named: the room argues it, the field and the pulse stay home",
    keepsHome: (inst, _p, ctx) => ctx.askClass === "decision" && !ctx.url && fieldOrPulse(inst),
  },
  // A code matter is the Architect's (the Chair, 2026-09-22): a clean tooling room over green checks scored 4 to 7 across
  // five sittings and invented files to cite (the third self-hearing).
  {
    id: "code-matter-room-unasked",
    why: "a code matter is the Architect's: the room sits only when the ask asks for it",
    keepsHome: (inst, _p, ctx) => inst.id === "boardroom" && ctx.codeKind && !ctx.roomAsked,
  },
  // Dredd's own self-hearing ("tear dredd apart") seated LilGranny, the Design Critic, the flow walk, SUE and the
  // focus group at Jev's p 0.5, and LilGranny measured nothing (2026-09-23). A named page makes it a page matter again.
  {
    id: "code-matter-no-visit",
    why: "a code matter with no page named: nobody goes out to look at a page",
    keepsHome: (inst, _p, ctx) => !ctx.url && ctx.codeKind && visitsPage(inst),
  },
  // "dredd keeps picking the wrong tools" named the marketing council at Jev's p 0.51 in two evals running (2026-09-23).
  {
    id: "code-matter-page-only-judge",
    why: "a code matter with no page named: this instrument judges only pages and products",
    keepsHome: (inst, _p, ctx) => !ctx.url && ctx.codeKind && judgesNoCode(inst),
  },
  // "review the Rust egui UI and the codebase" (VectorMagik, 2026-09-23) convened the Design Critic for a window no
  // browser can open. A desktop app's screens are rendered headless and its strings listed by the session instead.
  {
    id: "native-ui-no-visit",
    why: "a desktop app's UI, not a page: no browser opens it, so nobody goes out to look and the pulse stays home",
    // The price check reads web page code (Vue, React, Svelte, HTML), so a desktop window has nothing for it to price.
    keepsHome: (inst, _p, ctx) => ctx.nativeUi && !ctx.url && (visitsPage(inst) || inst.id === "page-pulse" || inst.id === "price"),
  },
];

/** Every filter that keeps this instrument home, in FILTERS order: [] when it is feasible. Pure. */
export function filtersKeepingHome(inst, p, ctx, filters = FILTERS) {
  return filters.filter((f) => f.keepsHome(inst, p, ctx)).map(({ id, why }) => ({ id, why }));
}

/** The p an instrument must reach at this scope, and the bar's name (BARS in lib/docket.mjs). */
export function barFor(inst, scope, bars) {
  const field = inst.phase === 3;
  if (scope >= 2) return { name: "full", value: bars.full };
  if (scope === 1) return field ? { name: "focusedField", value: bars.focusedField } : { name: "focused", value: bars.focused };
  return field ? { name: "quickField", value: bars.quickField } : { name: "quick", value: bars.quick };
}

/**
 * The score stage: does this p clear the scope's bar, and if not, why. A quick look seats ONE instrument, but a
 * session skill (phase 4) costs nothing to name, so it may sit beside that one; `seated` is what already sits. Pure.
 */
export function scoreStage(inst, p, scope, bars, seated = []) {
  const bar = barFor(inst, scope, bars);
  if (scope < 1 && inst.phase !== 4) {
    const taken = seated.filter((c) => c.phase !== 4);
    if (taken.length >= 1) return { take: false, why: `a quick look seats one instrument, and ${taken[0].id} has the slot` };
  }
  if (p >= bar.value) return { take: true, why: `p ${r2(p)} clears the ${bar.name} bar ${bar.value}` };
  return { take: false, why: `p ${r2(p)} is under the ${bar.name} bar ${bar.value}` };
}

/** A home row's one line, as the docket prints it. */
export function homeLine(h) {
  const stage = h.stage === "filter" ? `filtered: ${h.filters.map((f) => `${f.id} (${f.why})`).join("; ")}` : `${h.stage}: ${h.why}`;
  return `${h.id} p=${h.p} [${h.scoredBy}] ${stage}`;
}
