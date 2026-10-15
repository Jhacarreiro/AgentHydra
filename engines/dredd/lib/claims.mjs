// dredd/lib/claims.mjs - the claims check: the marketing law made executable, over every proposal.
//
// The first unattended hearing (2026-09-22) drafted a "free trial" we do not sell and "deals" the page
// never names; the room caught it at 5/10, a round late. The law is older than Dredd: a claim in front
// of strangers gets the same bar as a live deploy claim, and "declared, stubbed, admin-only or paid-tier
// only is NOT advertisable" (the marketing callback hook, docs/guides/marketing.md). So a proposal is
// checked BEFORE the room sees it, mechanically, against two sources of truth:
//
//   1. the page's own rendered text (page-pulse.json `text`, plus every `before` the proposal quotes that the
//      page really carries - the drafter writes `before` itself, so an unchecked one let "free trial" in as
//      the page's own words, 2026-09-22): an offer word (free trial, guarantee, discount, ...), a number,
//      or a capability the page does not already carry is an invention - the drafter may only rearrange what
//      the page already says;
//   2. infra/shared/plane-capabilities.json: a capability the proposal names that NO plane declares is
//      worse than an invention, it is a lie about what the product is.
//
// A third check (P10, the MiroFish review, 2026-09-23): a `why` or the proposal's `note` can carry an invented
// visitor line the same way a headline can carry an invented offer - "Sue said..." grounds nothing if nobody said
// it. quote:not-in-evidence checks every quoted span in a why or the note against the page, SUE's own words and the
// ruling that led to this draft; trimClaims strips just that field, keeps the change, and names the cut - a laundered
// quote should not cost the whole line the room is meant to score.
//
// A fourth (the Deal Flow invite hearing, docket 20260925-194526-b458): the page's own recorded rulings
// (lib/rulings.mjs, the route component's header). The drafter renamed the invite "... for the Connections Pass" and
// cut the door to the full checkout; "Pass" was on the page (the footer wordmark) and a cut is not a claim, so both
// passed, and the room scored what the owners had already ruled out. ruling:retired-name refuses a name a ruling
// retires (unless the change only edits a line that already carries it); ruling:removes-kept refuses a cut or a
// change that removes an element a ruling keeps. Each names the ruling it breaks.
//
// Pure: takes the proposal, the page text and the inventory; returns findings. No disk, no network.
import { quotedSpans, groundedIn } from "./ballot.mjs";

/** Offer words that a page must already carry before a proposal may use them. */
export const OFFER_RX = [
  { kind: "free-trial", rx: /\bfree trials?\b/i },
  { kind: "trial", rx: /\b(?:\d+|seven|fourteen|thirty)[- ]day trial\b/i },
  { kind: "guarantee", rx: /\b(?:money[- ]back|guarantee[sd]?)\b/i },
  // "deals" alone is not here: "close more deals" is an outcome, and the Deals plane is a product name (2026-09-22).
  {
    kind: "discount",
    rx: /\b(?:\d+\s*% off|discount(?:s|ed)?|coupons?|promo codes?|special offers?|deal of the (?:day|week)|hot deals?)\b/i,
  },
  { kind: "no-card", rx: /\bno credit card\b/i },
  { kind: "cancel-anytime", rx: /\bcancel (?:any ?time|whenever)\b/i },
  { kind: "free-forever", rx: /\bfree forever\b/i },
  { kind: "customer-count", rx: /\b(?:trusted|used|loved) by\b/i },
  { kind: "award", rx: /\b(?:award[- ]winning|#1|number one|best[- ]in[- ]class|industry[- ]leading)\b/i },
  { kind: "storage-capacity", rx: /\b\d+\s*(?:GB|TB|MB)\b/i },
];

/**
 * Capabilities a front door tends to name, each tied to the inventory id that must declare it.
 * The phrase is what a stranger reads; the id is what infra/shared/plane-capabilities.json must carry.
 * A phrase with no `ids` is a capability class the inventory has no single row for, and is only checked
 * against the page text.
 */
export const CAPABILITY_VOCABULARY = [
  { phrase: /\b(?:send|sending|sends)? ?e-?mails?\b|\bnewsletters?\b/i, label: "email", ids: ["email-sending"] },
  { phrase: /\b(?:sms|text messages?|texting)\b/i, label: "SMS", ids: ["sms-sending"] },
  { phrase: /\bwhatsapp\b/i, label: "WhatsApp", ids: ["whatsapp-messaging"] },
  { phrase: /\b(?:payments?|checkout|invoic(?:e|es|ing)|get paid|take payments?)\b/i, label: "payments", ids: ["payments"] },
  { phrase: /\bpayouts?\b/i, label: "payouts", ids: ["payout-transfer"] },
  { phrase: /\b(?:subscriptions?|recurring billing)\b/i, label: "subscriptions", ids: ["subscription-lifecycle"] },
  { phrase: /\b(?:appointments?|bookings?|book(?:ing)? (?:a )?(?:call|slot|time))\b/i, label: "booking", ids: ["appointment-booking"] },
  { phrase: /\bcalendars?\b/i, label: "calendar", ids: ["calendar-feed-ics"] },
  { phrase: /\b(?:file storage|store (?:your )?files|uploads?)\b/i, label: "storage", ids: ["file-storage"] },
  { phrase: /\btranscri(?:be|bes|ption|ptions)\b/i, label: "transcription", ids: ["transcription"] },
  { phrase: /\bmaps?\b/i, label: "maps", ids: ["map-rendering"] },
  { phrase: /\bqr codes?\b/i, label: "QR codes", ids: ["qr-code-generation"] },
  { phrase: /\b(?:wallet pass(?:es)?|apple wallet|google wallet)\b/i, label: "wallet passes", ids: ["wallet-pass-issuance"] },
  { phrase: /\bshort links?\b/i, label: "short links", ids: ["short-links"] },
  { phrase: /\bpush notifications?\b/i, label: "push notifications", ids: ["web-push-notifications"] },
  { phrase: /\b(?:direct messag(?:e|es|ing)|\bDMs?\b|live chat)\b/i, label: "messaging", ids: ["direct-messaging"] },
  { phrase: /\breferrals?\b/i, label: "referrals", ids: ["referral-commission"] },
  { phrase: /\b(?:loyalty|punch cards?)\b/i, label: "loyalty", ids: ["merchant-loyalty-tiers"] },
  { phrase: /\b(?:single sign[- ]on|\bSSO\b)\b/i, label: "single sign-on", ids: ["identity-auth", "oidc-provider"] },
  {
    phrase: /\b(?:one (?:login|sign[- ]in|account)|same (?:login|sign[- ]in)) (?:for|across)\b/i,
    label: "one login",
    ids: ["identity-auth"],
  },
  { phrase: /\b(?:analytics|dashboards?)\b/i, label: "analytics", ids: ["analytics-telemetry"] },
  { phrase: /\b(?:ads?|advertis(?:e|ing|ements?))\b/i, label: "ads", ids: ["ad-serving"] },
  { phrase: /\b(?:AI assistant|assistant|AI agent|chatbot)\b/i, label: "AI assistant", ids: ["conversational-ai-agent"] },
  { phrase: /\b(?:shipping labels?|postage|ship (?:your )?orders?)\b/i, label: "shipping", ids: ["shipping-rate-menu"] },
  { phrase: /\bforms?\b/i, label: "forms", ids: ["form-builder-and-renderer"] },
  { phrase: /\b(?:custom|your own) domains?\b/i, label: "custom domains", ids: ["customer-domain-ownership"] },
  { phrase: /\bwebhooks?\b/i, label: "webhooks", ids: ["outbound-webhooks"] },
  {
    phrase: /\b(?:marketplace|product catalog|sell (?:your )?products?|storefront)\b/i,
    label: "storefront",
    ids: ["marketplace-orders", "merchant-product-catalog"],
  },
  { phrase: /\b(?:web scrap(?:e|ing)|scrape)\b/i, label: "web scraping", ids: ["web-scrape"] },
  { phrase: /\bvideo calls?\b|\bvideo chat\b/i, label: "video calls", ids: [] },
  { phrase: /\bmobile apps?\b|\bios app\b|\bandroid app\b/i, label: "a mobile app", ids: ["native-app-shell"] },
];

/** The inventory's declared capability ids: every id under `capabilities` that at least one plane lists. */
export function declaredCapabilities(inventory) {
  const declared = new Set();
  const planes = inventory?.planes || {};
  for (const [plane, row] of Object.entries(planes)) {
    if (plane.startsWith("_") || !row || !Array.isArray(row.capabilities)) continue;
    for (const c of row.capabilities) if (c && typeof c.id === "string") declared.add(c.id);
  }
  // A capability with a row but no declaring plane is known, not declared; keep the two apart.
  const known = new Set(Object.keys(inventory?.capabilities || {}).filter((k) => !k.startsWith("_")));
  return { declared, known };
}

// The suffix is case-blind: the page's "10K" and a proposal's "10k" are one figure (2026-09-22, a restated figure
// was refused and its change cut).
const NUMBER_RX = /(?:\$|€|£)?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|x\b|\/7|\/24)?/gi;

/**
 * The figures in a text, keyed by their bare form (currency sign, spaces and thousands commas gone, lowercased), each
 * with the token as written for the finding to quote. Bare, so the page's "$39.99" is the proposal's "39.99"; the
 * percent sign stays, so "5%" is never the page's "5".
 */
function numbersIn(text) {
  const out = new Map();
  for (const m of String(text || "").matchAll(NUMBER_RX)) {
    const shown = m[0].replace(/\s+/g, "");
    const bare = shown
      .replace(/,/g, "")
      .replace(/^[$€£]/, "")
      .toLowerCase();
    if (/\d/.test(bare) && !out.has(bare)) out.set(bare, shown);
  }
  return out;
}

/** Text folded for "does the page say this": lowercased, whitespace collapsed, typographic dashes and quotes plain. */
function fold(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Every string a reader would see in the proposal: the headline and each change's `after`, each with its place -
 *  `at` is "headline" or the change's index, because a `where` label is free text two changes can share. */
function proposalCopy(proposal) {
  const parts = [];
  if (proposal?.headline) parts.push({ at: "headline", where: "headline", text: String(proposal.headline) });
  (proposal?.changes || []).forEach((c, i) => {
    if (c?.after) parts.push({ at: i, where: c.where || "a change", text: String(c.after) });
  });
  return parts;
}

/**
 * Check one proposal. `pageText` is the page's rendered text; a `before` the proposal quotes counts as page text only
 * when the page really carries it (folded for case, spacing, dashes and quotes). A `before` the page does not carry
 * is named in `offPage` and counts as nothing - never a cut, since a quote can drift past page-pulse's text cap. With
 * no page text, no `before` counts: a docket with no pulse refuses a capability rather than take the drafter's word.
 * `inventory` is plane-capabilities.json, or null when the check runs somewhere the inventory is not (then only the
 * page rule applies). `sueWords` (theirWords' `said` lines) and `ruling` (the board's fix_first plus plan) are what
 * a change's `why` and the proposal's `note` are allowed to quote, besides the page itself - the reason a drafter
 * gives is checked the same way the words it writes are. `rulings` is the page's recorded rulings (lib/rulings.mjs
 * pageRulings: `retires`, `keeps`, `component`), or null for a page with none.
 * Returns { ok, findings: [{ kind, where, text, why, at: [places] }], offPage: [where] } - a place is "headline", a
 * change's index, "note", or "cut:<i>" for the proposal's i-th cut.
 */
export function checkClaims({
  proposal,
  pageText = "",
  inventory = null,
  sueWords = [],
  ruling = "",
  matter = "opinion",
  exists = null,
  rulings = null,
}) {
  const findings = [];
  if (exists) findings.push(...missingPaths(proposal, exists));
  // A code matter's proposal is code, not the front door's copy: the page rules below would call every number in a
  // code line an invented figure. Its one invariant is the one above - it may name only files that are there.
  if (matter === "code") return dedupeFindings(findings, []);
  const pageFolded = fold(pageText);
  if (rulings) findings.push(...rulingFindings(proposal, rulings, pageFolded));
  const offPage = [];
  const quoted = [];
  for (const c of proposal?.changes || []) {
    if (!c?.before) continue;
    if (pageFolded && pageFolded.includes(fold(c.before))) quoted.push(c.before);
    else offPage.push(c.where || "a change");
  }
  const page = [pageText, ...quoted].join("\n");
  const pageLower = fold(page);
  const pageNumbers = numbersIn(page);
  const inv = inventory ? declaredCapabilities(inventory) : null;

  for (const part of proposalCopy(proposal)) {
    for (const { kind, rx } of OFFER_RX) {
      const m = rx.exec(part.text);
      if (!m) continue;
      if (pageLower.includes(fold(m[0]))) continue;
      findings.push({
        kind: `offer:${kind}`,
        at: part.at,
        where: part.where,
        text: m[0],
        why: `the page never says "${m[0]}" - an offer the page does not carry is invented`,
      });
    }
    for (const [bare, n] of numbersIn(part.text)) {
      if (pageNumbers.has(bare)) continue;
      findings.push({
        kind: "number",
        at: part.at,
        where: part.where,
        text: n,
        why: `the number ${n} appears nowhere on the page - a figure in front of strangers must already be the page's own`,
      });
    }
    for (const cap of CAPABILITY_VOCABULARY) {
      const m = cap.phrase.exec(part.text);
      if (!m) continue;
      const onPage = cap.phrase.test(page);
      const ids = cap.ids || [];
      const undeclared = inv && ids.length ? ids.filter((id) => !inv.declared.has(id)) : [];
      if (inv && ids.length && undeclared.length === ids.length) {
        findings.push({
          kind: "capability:undeclared",
          at: part.at,
          where: part.where,
          text: m[0],
          why: `"${m[0]}" names ${cap.label}, and no plane declares ${ids.join(" or ")} in plane-capabilities.json - the product does not have it`,
        });
        continue;
      }
      if (!onPage)
        findings.push({
          kind: "capability:not-on-page",
          at: part.at,
          where: part.where,
          text: m[0],
          why: `"${m[0]}" names ${cap.label}, which the page does not mention today - only the owner may add a capability to the front door`,
        });
    }
  }
  // A why or a note can carry a quote nobody said: checked against the page, what SUE's visitors actually said and
  // the ruling that led here - never the drafter's own prose, or a quote of the drafter's own after-text would
  // ground itself. trimClaims strips just this field, so an invented "Sue said..." never costs the change itself.
  const evidenceText = [page, ...(Array.isArray(sueWords) ? sueWords : []), ruling].filter(Boolean).join("\n");
  (proposal?.changes || []).forEach((c, i) => {
    for (const { quote, inner } of quotedSpans(c?.why)) {
      if (groundedIn(inner, evidenceText)) continue;
      findings.push({
        kind: "quote:not-in-evidence",
        at: i,
        where: c.where || "a change",
        text: quote,
        why: `the why quotes ${quote} but nobody said it, and it is not on the page - a quote in front of the room must be real`,
      });
    }
  });
  for (const { quote, inner } of quotedSpans(proposal?.note)) {
    if (groundedIn(inner, evidenceText)) continue;
    findings.push({
      kind: "quote:not-in-evidence",
      at: "note",
      where: "the note",
      text: quote,
      why: `the note quotes ${quote} but nobody said it, and it is not on the page - a quote in front of the room must be real`,
    });
  }
  return dedupeFindings(findings, offPage);
}

/** The ruling a finding cites: its section, its reason and the file it is recorded in. */
function citeRuling(r, component) {
  return [r.section ? `"${r.section}"` : null, r.why || null, component ? `recorded in ${component}` : null].filter(Boolean).join("; ");
}

/**
 * The page's recorded rulings against the proposal. A retired name is matched as a whole word, case and all ("Pass"
 * the brand, never "pass it on"), in the headline and every `after`; a change whose own on-page `before` already
 * carries the name only edits that line (the footer's wordmark), and is not a reintroduction. A kept element is
 * removed by a cut that quotes it (or quotes three or more of its words) or by a change whose `before` carries it and
 * whose `after` does not.
 */
function rulingFindings(proposal, rulings, pageFolded) {
  const out = [];
  const changes = proposal?.changes || [];
  for (const r of rulings.retires || []) {
    const name = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\b${name}\\b`);
    for (const part of proposalCopy(proposal)) {
      if (!rx.test(part.text)) continue;
      const own = part.at === "headline" ? null : changes[part.at]?.before;
      if (own && rx.test(own) && pageFolded.includes(fold(own))) continue;
      out.push({
        kind: "ruling:retired-name",
        at: part.at,
        where: part.where,
        text: r.name,
        why: `the page's recorded ruling retires "${r.name}" (${citeRuling(r, rulings.component)}) - the owners already ruled it out`,
      });
    }
  }
  for (const k of rulings.keeps || []) {
    const kept = fold(k.text);
    const removed = (why, at, where) =>
      out.push({
        kind: "ruling:removes-kept",
        at,
        where,
        text: k.text,
        why: `${why}, and the page's recorded ruling keeps it (${citeRuling(k, rulings.component)}) - the owners already ruled it stays`,
      });
    (proposal?.cuts || []).forEach((c, i) => {
      const cut = fold(c);
      if (cut && (cut.includes(kept) || (cut.split(" ").length >= 3 && kept.includes(cut))))
        removed(`the cut "${c}" removes "${k.text}"`, `cut:${i}`, "the cuts");
    });
    changes.forEach((c, i) => {
      if (c?.before && fold(c.before).includes(kept) && !fold(c.after).includes(kept))
        removed(`the change replaces "${k.text}" with text that drops it`, i, c.where || "a change");
    });
  }
  return out;
}

/** One finding per (kind, text): the same invention in three changes is one problem - but it keeps EVERY place it
 *  sits in, or the stamp cut only the first and let the twin through to the room (2026-09-22). */
function dedupeFindings(findings, offPage) {
  const byKey = new Map();
  for (const f of findings) {
    const k = `${f.kind}|${f.text.toLowerCase()}`;
    const had = byKey.get(k);
    if (!had) byKey.set(k, { ...f, at: [f.at] });
    else if (!had.at.includes(f.at)) {
      had.at.push(f.at);
      had.where = `${had.where}, ${f.where}`;
    }
  }
  const unique = [...byKey.values()];
  return { ok: unique.length === 0, findings: unique, offPage };
}

/** Repository paths a line names: a token with at least one folder and an extension (`dredd/bench.json`,
 *  `.arkitect/runners/atlas/who.mjs`). A `./` or `../` import is relative to its own file, not the repository, and a
 *  host (`example.com/pricing`) has a dot in its first segment, so neither is read as one. */
export function namedRepoPaths(text) {
  const rx = /(?:^|[\s'"`(,])((?:\.?[\w-]+\/)+[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s'"`),;:])/g;
  return [...new Set([...String(text || "").matchAll(rx)].map((m) => m[1]))];
}

/**
 * The code-matter invariant: a proposal may name only files that exist, or that it creates itself (a `where` with no
 * `before` is an addition, so a file it names that is not on disk is a new file). Dredd's own self-hearing (2026-09-23)
 * drafted `import '.arkitect/runners/atlas/bill.mjs'` - the one file the evidence said was missing - and the room scored
 * it 7/10. `exists` answers for a repository-relative path.
 */
function missingPaths(proposal, exists) {
  const changes = proposal?.changes || [];
  const created = new Set(changes.filter((c) => !c?.before).flatMap((c) => namedRepoPaths(c?.where)));
  const out = [];
  changes.forEach((c, i) => {
    const edits = c?.before ? namedRepoPaths(c?.where) : [];
    const uses = namedRepoPaths(c?.after).filter((p) => !created.has(p));
    for (const p of new Set([...edits, ...uses])) {
      if (exists(p)) continue;
      out.push({
        kind: "path:missing",
        at: i,
        where: c.where || "a change",
        text: p,
        why: `${p} does not exist in the repository - a change may name only files that are there, or that it creates`,
      });
    }
  });
  return out;
}

/** The findings as the drafter reads them back, and as the proposal file records them. */
export function renderClaims(findings) {
  if (!findings.length) return "";
  return findings.map((f) => `- [${f.kind}] in ${f.where}: "${f.text}" - ${f.why}`).join("\n");
}

/**
 * The stamp cuts what it refuses: drop the headline and every change a finding names (and every "cut:<i>" place,
 * a cut that would remove what a ruling keeps, from the cuts), keep the rest - EXCEPT a
 * quote:not-in-evidence finding, which strips only the field it names (a change's `why`, or the proposal's `note`)
 * and keeps the change itself; the change is what the room scores, the why is only the drafter's reason for it, and
 * losing a whole line over an invented "Sue said..." would throw away a change nobody objected to. A drafter that
 * re-inserts "no credit card" on its redraft (measured 2026-09-22, two rounds running) is not asked a third time;
 * the surviving changes go to the room and the file says what was cut. It cuts by PLACE (a finding's `at`), never by
 * the free-text `where` label two changes can share. Pure. Returns { proposal, cut } where `cut` lists what was
 * removed; `proposal` is null when nothing survives. A finding with no place is a caller's bug and throws.
 */
export function trimClaims(proposal, findings) {
  if (!findings?.length) return { proposal, cut: [] };
  const removeAt = new Set();
  const stripWhy = new Set();
  const dropCut = new Set();
  let stripNote = false;
  for (const f of findings) {
    if (!Array.isArray(f.at) || !f.at.length) throw new Error(`trimClaims: the finding ${f.kind} "${f.text}" names no place to cut`);
    if (f.kind === "quote:not-in-evidence") {
      for (const p of f.at) {
        if (p === "note") stripNote = true;
        else stripWhy.add(p);
      }
    } else
      for (const p of f.at) {
        // A cut that removes a kept element is dropped from the cuts; the rest of the proposal stands.
        if (typeof p === "string" && p.startsWith("cut:")) dropCut.add(Number(p.slice(4)));
        else removeAt.add(p);
      }
  }
  const cut = [];
  const out = { ...proposal };
  if (out.headline && removeAt.has("headline")) {
    cut.push(`headline: ${out.headline}`);
    delete out.headline;
  }
  out.changes = (proposal.changes || []).reduce((acc, c, i) => {
    if (removeAt.has(i)) {
      cut.push(`${c?.where || "a change"}: ${c?.after || ""}`);
      return acc;
    }
    if (stripWhy.has(i) && c?.why) {
      cut.push(`${c?.where || "a change"}: why - "${c.why}"`);
      acc.push({ ...c, why: "" });
      return acc;
    }
    acc.push(c);
    return acc;
  }, []);
  if (stripNote && out.note) {
    cut.push(`note: "${out.note}"`);
    delete out.note;
  }
  if (dropCut.size && Array.isArray(proposal.cuts)) {
    out.cuts = proposal.cuts.filter((c, i) => {
      if (!dropCut.has(i)) return true;
      cut.push(`cut: ${c}`);
      return false;
    });
  }
  return { proposal: out.changes.length || out.headline ? out : null, cut };
}
