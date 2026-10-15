// dredd/lib/charters.mjs - what a branch changed, turned into a few SUE visits that each test ONE route in ONE posture.
//
// Idea credit: the "Plan charters" step of tester-army/e2e's bug bash (github.com/tester-army/e2e,
// skills/e2e/references/bug-bash.md, Apache-2.0; the idea only, none of its text or code): read the routes a branch
// changed and write five to ten one-sentence charters, each one route and one posture, each with its own start route.
//
// WHY: SUE's scenarios say who the visitor is and why she came, never how hard she checks, and Dredd convenes SUE for
// one named page, never for what a branch changed. A charter pairs the two: the route comes from the diff, read through
// the SAME mapping the checkpoint hook uses to pick what the Design Critic photographs (dredd/hooks/dredd-checkpoint.mjs
// critiqueSurfaces over .arkitect/policies/connections/design-critic-surfaces.json), and the posture is one of SUE's
// posture scenarios (sue/scenarios/careful-buyer.json, comes-back-later.json, slips-up.json, or first-visit.json),
// picked by what the changed file is about. Each charter is a wave file `node sue/sue.mjs run --json-file` reads.
// Nothing here starts a wave: the CLI (dredd/charters.mjs) prints the command per charter and stops.
import { loadTarget, targetPath } from "../../lib/target.mjs";
import { pathToFileURL } from "node:url";
import { critiqueSurfaces } from "../hooks/dredd-checkpoint.mjs";
import { DEFAULT_ROSTER_MIX } from "../../sue/sue.mjs";

/** At most this many charters for one branch: the bug bash's own five-to-ten. */
export const CHARTER_MAX = 10;

/** The SUE target every charter runs on: its allowed hosts are every plane's website. */
export const CHARTER_TARGET = "connections";

/**
 * The postures, in the order a changed file is tested against them (the first whose words it carries wins). Each names
 * its SUE scenario and the one sentence its charter says, with `{url}` where the start route goes.
 */
export const POSTURES = [
  {
    id: "careful-buyer",
    scenario: "careful-buyer",
    words:
      /^(?:prices?|pricing|carts?|baskets?|checkouts?|totals?|subtotals?|invoices?|billing|bills?|receipts?|tax(?:es)?|currenc(?:y|ies)|money|payments?|pay|orders?|quotes?|discounts?|coupons?|refunds?|tickets?|amounts?|fees?|charges?|subscriptions?)$/,
    sentence: "Open {url} and check that every price, total, date and count agrees with the rest of the page and the pages before it.",
  },
  {
    id: "slips-up",
    scenario: "slips-up",
    words:
      /^(?:forms?|inputs?|fields?|editors?|composers?|compose|creators?|create|edit|fill|signup|login|register|registration|validat\w*|pickers?|uploads?|wizards?|onboarding|otp|textarea|checkbox(?:es)?|selects?|dropdowns?)$/,
    sentence:
      "Open {url} and make the mistakes a real person makes there - a typo, an empty field, a wrong code - and judge every error message.",
  },
  {
    id: "comes-back-later",
    scenario: "comes-back-later",
    words:
      /^(?:stores?|state|storage|persist\w*|drafts?|stash\w*|cache[sd]?|sessions?|pinia|local|autosave|resume|restore|history|offline)$/,
    sentence: "Open {url}, enter something, then reload, go back and return, and check that what you entered is still there.",
  },
];

/** The posture of a file that names none of the above: a person arriving at the route for the first time. */
export const FIRST_VISIT = {
  id: "first-visit",
  scenario: "first-visit",
  sentence: "Open {url} as a first-time visitor and find out what this page is for and whether it is for you.",
};

/** The buyer flow is about money whatever its file is called (the checkpoint hook's BUYER). */
const BUYER = /^infra\/shared\/pay\/buyer\//;

/** The words a path carries, camelCase and kebab split: "CheckoutTotals.vue" -> checkout, totals, vue. */
export function pathWords(p) {
  return (
    String(p)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9]*/g) || []
  );
}

/** The posture one changed file earns: money -> careful-buyer, a form or input -> slips-up, state -> comes-back-later. */
export function postureFor(file) {
  const p = String(file).replace(/\\/g, "/");
  if (BUYER.test(p)) return POSTURES[0];
  // The plane folder names the plane, not what the file is about ("services/payments/web/src/App.vue" is a shell).
  const own = p.replace(/^services\/[^/]+\/web\/src\//, "").replace(/^packages\/[^/]+\/src\//, "");
  const words = pathWords(own);
  return POSTURES.find((posture) => words.some((w) => posture.words.test(w))) ?? FIRST_VISIT;
}

/**
 * Each plane's website origin, read from the constellation registry's source (infra/shared/constellation-planes.ts) the
 * way scripts/dev/dev-planes.mjs reads its dev ports, so no origin is restated here. `websiteOrigin("<label>")` is
 * `https://<label>.<apex>` and `websiteOrigin()` is the apex; the apex is the SUE target's own start host. A plane whose
 * prodOrigin is not a websiteOrigin (accounts, on the backend host) is left out.
 */
export function planeOrigins(registryText, siteOrigin) {
  const apex = new URL(siteOrigin).host;
  const origins = {};
  const re = /^\s*(\w+):\s*\{[^}]*?prodOrigin:\s*websiteOrigin\(\s*(?:"([a-z0-9-]+)")?\s*\)/gm;
  for (let m = re.exec(String(registryText ?? "")); m !== null; m = re.exec(String(registryText ?? "")))
    origins[m[1]] = `https://${m[2] ? `${m[2]}.` : ""}${apex}`;
  return origins;
}

/** `<plane>:</route>[:public]`, the checkpoint hook's ad-hoc spec, as its parts. */
function parseSpec(spec) {
  const at = spec.indexOf(":");
  const rest = spec.slice(at + 1);
  const pub = rest.endsWith(":public");
  return { plane: spec.slice(0, at), route: pub ? rest.slice(0, -":public".length) : rest, signedOut: pub };
}

/**
 * The charters for a list of changed paths. `surfaces` is the design-critic roster's `surfaces`, `origins` the plane
 * origins (planeOrigins). Each changed file is mapped to the ONE roster surface critiqueSurfaces ranks first for it,
 * and gets its posture; one charter per (route, posture), the routes most files landed on first, at most `limit`.
 * Returns `{ charters, skipped }`: `skipped` names every changed file no charter tests, and why.
 */
export function buildCharters(paths, { surfaces, origins, limit = CHARTER_MAX, personas = DEFAULT_ROSTER_MIX } = {}) {
  const byKey = new Map();
  const skipped = [];
  for (const file of paths.map((x) => String(x).replace(/\\/g, "/")).filter(Boolean)) {
    const [pick] = critiqueSurfaces([file], surfaces, { limit: 1 });
    if (!pick) {
      skipped.push({ file, why: "no route a person sees (not a plane's web app, the kit or the buyer flow, or a test or doc)" });
      continue;
    }
    const { plane, route, signedOut } = parseSpec(pick.spec);
    const origin = origins?.[plane];
    if (!origin) {
      skipped.push({ file, why: `plane "${plane}" has no website origin in the constellation registry` });
      continue;
    }
    const posture = postureFor(file);
    const key = `${plane}:${route}|${posture.id}`;
    const seen = byKey.get(key);
    if (seen) seen.because.push(file);
    else
      byKey.set(key, {
        surface: pick.id,
        plane,
        route,
        signedOut,
        posture,
        startUrl: new URL(route, origin).href,
        because: [file],
        order: byKey.size,
      });
  }
  const ranked = [...byKey.values()].sort((a, b) => b.because.length - a.because.length || a.order - b.order);
  for (const extra of ranked.slice(limit))
    for (const file of extra.because) skipped.push({ file, why: `over the cap of ${limit} charters` });
  const roster = personas.length ? personas : DEFAULT_ROSTER_MIX;
  const charters = ranked.slice(0, limit).map((c, i) => {
    const sentence = c.posture.sentence.replace("{url}", c.startUrl);
    return {
      id: `${String(i + 1).padStart(2, "0")}-${c.posture.id}-${c.surface}`,
      surface: c.surface,
      plane: c.plane,
      route: c.route,
      signedIn: !c.signedOut,
      posture: c.posture.id,
      sentence,
      because: c.because,
      wave: charterWave({ scenario: c.posture.scenario, startUrl: c.startUrl, persona: roster[i % roster.length], sentence }),
    };
  });
  return { charters, skipped };
}

/** One charter as the object `node sue/sue.mjs run --json-file` reads: a roster errand that starts on its route. */
export function charterWave({ scenario, startUrl, persona, sentence }) {
  return { target: CHARTER_TARGET, scenario, startUrl, personas: [persona], count: 1, charter: sentence };
}
