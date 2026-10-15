/**
 * inbox-test - the rules of an inbox test: which controls an email shows her, what one Sue's actions
 * finally mean, the rates over a run, the one-sided 95% bound, the PASS rule, and the content hash a
 * verdict is booked under. Pure; the run itself (sue.mjs inbox_test) and the page (inbox-page.mjs) use it.
 */
import { createHash } from "node:crypto";

export const AUDIENCES = ["cold", "known"];

/** The six to eight ordinary emails a Sue triages beside the one under test (never told which one it is). */
export const DECOY_EMAILS = [
  { from: "Mum <mum.h@example.net>", subject: "Sunday dinner?", text: "Are you still coming Sunday? I am doing the lamb." },
  {
    from: "Northfield Bank <statements@northfield.example>",
    subject: "Your statement is ready",
    text: "Your September statement is now available to view in online banking.",
  },
  {
    from: "ParcelWay <notify@parcelway.example>",
    subject: "Your parcel is out for delivery",
    text: "Your parcel arrives today between 2pm and 6pm. Track it in the app.",
  },
  {
    from: "Dana Reyes <dana@workspace.example>",
    subject: "Notes from Tuesday's meeting",
    text: "Attached are the notes. Can you send me the numbers for the Q3 review by Friday?",
  },
  {
    from: "Security <no-reply@accounts.example>",
    subject: "New sign-in on a device",
    text: "We noticed a sign-in from a new device. If this was you, there is nothing to do.",
  },
  {
    from: "Calendar <calendar@reminders.example>",
    subject: "Reminder: dentist, Thursday 9:30",
    text: "You have an appointment on Thursday at 9:30. Reply to reschedule.",
  },
  {
    from: "The Weekender <news@weekender.example>",
    subject: "Five things to try this weekend",
    text: "A short list of walks, recipes and films picked for the weekend ahead.",
    headers: { "List-Unsubscribe": "<https://weekender.example/unsubscribe?u=4471>" },
  },
];

const TOKEN = /\{([a-z_]+)\}/g;

/** The `{token}` names an email carries, sorted, once each. */
export function mergeTokensOf(email) {
  const tokens = new Set();
  for (const text of [email?.subject, email?.text, email?.html]) {
    if (typeof text === "string") for (const match of text.matchAll(TOKEN)) tokens.add(match[1]);
  }
  return [...tokens].sort();
}

export class MergeFieldError extends Error {
  constructor(token) {
    super(`merge field {${token}} has no fact for this Sue: an email never goes out with a blank or generic word in its place`);
    this.token = token;
  }
}

/**
 * Fills `{token}`s in one Sue's copy of the email from her own facts (`facts`, e.g. `{ first_name, event_name }`).
 * A token with no fact for her is a MergeFieldError, never a generic word and never another person's detail.
 * `filled` names the tokens the facts supplied, so a booked run can say its merge was per Sue.
 */
export function fillMerge(email, facts = {}) {
  const filled = new Set();
  const fill = (text) =>
    typeof text === "string"
      ? text.replace(TOKEN, (_whole, token) => {
          if (facts[token] == null || !String(facts[token]).trim()) throw new MergeFieldError(token);
          filled.add(token);
          return String(facts[token]);
        })
      : text;
  const out = { ...email, subject: fill(email.subject), text: fill(email.text), html: fill(email.html) };
  return { email: out, filled: [...filled] };
}

/** True only when the template had tokens and no Sue's seeded copy still carries one. */
export function mergeCompleteOf(template, arrivals) {
  return mergeTokensOf(template).length > 0 && arrivals.length > 0 && arrivals.every((email) => mergeTokensOf(email).length === 0);
}

/** The sentence that says why a Sue is in her inbox, by who the email is from to her. Never names a test. */
export function intentFor(audience) {
  if (audience === "known")
    return "You signed up for updates from a company you already use, and you are going through your inbox the way you normally would, dealing with each email as you see fit.";
  return "An email arrived from a company you have never dealt with, and you are going through your inbox the way you normally would, dealing with each email as you see fit.";
}

const BASE_CONTROLS = ["report_spam", "delete", "archive", "reply"];
const UNSUBSCRIBE_VIA = ["native", "body-link", "reply"];
const SEVERITY = ["reported-spam", "deleted", "unsubscribed", "clicked-through", "read-and-left", "ignored"];

function headerOf(email, name) {
  const headers = email?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] ?? "") : "";
}

/** The https address in List-Unsubscribe (a mailto alone is not a page a Sue can press), or null. */
export function unsubscribeUrlOf(email) {
  for (const match of headerOf(email, "list-unsubscribe").matchAll(/<([^>]+)>/g)) {
    if (/^https:\/\//i.test(match[1])) return match[1];
  }
  return null;
}

/** The controls an email shows her: Gmail's four always, and the native Unsubscribe only when it has the header. */
export function controlsFor(email) {
  return unsubscribeUrlOf(email) ? [...BASE_CONTROLS, "unsubscribe"] : [...BASE_CONTROLS];
}

/**
 * One Sue's final disposition from her events, `{ kind, via?, quote? }` in the order they happened.
 * The most severe thing she did wins: a spam report over a delete, an unsubscribe over a click-through.
 */
export function dispositionOf(events) {
  const outcomeOf = (e) => {
    if (e.kind === "report-spam") return "reported-spam";
    if (e.kind === "delete") return "deleted";
    if (e.kind === "unsubscribe") return "unsubscribed";
    if (e.kind === "click-through") return "clicked-through";
    if (e.kind === "open") return "read-and-left";
    return null;
  };
  let best = null;
  for (const e of events ?? []) {
    const outcome = outcomeOf(e);
    if (!outcome) continue;
    if (!best || SEVERITY.indexOf(outcome) < SEVERITY.indexOf(best.outcome)) best = { outcome, event: e };
  }
  const outcome = best ? best.outcome : "ignored";
  const via = best?.event.kind === "unsubscribe" ? best.event.via : null;
  const quoted = (events ?? []).find((e) => e.quote && outcomeOf(e) === outcome);
  const reply = (events ?? []).find((e) => e.kind === "reply");
  const optedOutByReply = (events ?? []).some((e) => e.kind === "unsubscribe" && e.via === "reply");
  const replied = Boolean(reply) && !optedOutByReply;
  return { outcome, via, why: quoted?.quote ?? "", replied, replyText: replied ? (reply.quote ?? "") : "" };
}

/** The rates over one run's dispositions: every Sue counts, including the ones who did nothing. */
export function rates(dispositions) {
  const count = dispositions.length;
  const share = (n) => (count === 0 ? 0 : n / count);
  const of = (outcome) => dispositions.filter((d) => d.outcome === outcome).length;
  const unsubscribeRate = {};
  for (const via of UNSUBSCRIBE_VIA) {
    unsubscribeRate[via.replace("-", "_")] = share(dispositions.filter((d) => d.outcome === "unsubscribed" && d.via === via).length);
  }
  return {
    count,
    spamRate: share(of("reported-spam")),
    unsubscribeRate,
    ignoredRate: share(of("ignored")),
    spamQuotes: dispositions.filter((d) => d.outcome === "reported-spam" && d.why).map((d) => d.why),
    replyRate: share(dispositions.filter((d) => d.replied).length),
    replyQuotes: dispositions.filter((d) => d.replied && d.replyText).map((d) => d.replyText),
  };
}

function logChoose(n) {
  let total = 0;
  for (let i = 2; i <= n; i += 1) total += Math.log(i);
  return total;
}

function binomialCdf(k, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    const logTerm = logChoose(n) - logChoose(i) - logChoose(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/** The one-sided Clopper-Pearson upper bound on a rate: the most spam could really be, 95% sure. */
export function clopperPearsonUpper(k, n, alpha = 0.05) {
  if (k >= n) return 1;
  let low = k / n;
  let high = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    if (binomialCdf(k, n, mid) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

// Gmail's bulk-sender rule (enforced since Nov 2025) caps the real spam-report rate at 0.3% and wants it under 0.1%,
// so the bar is zero reports up to 100 Sues and at most 1 in 1000 (the 0.1% aim) above that.
const SPAM_BAR = { zeroSpamUpTo: 100, onePerAbove: 1000 };

/** PASS only with zero spam reports up to SPAM_BAR.zeroSpamUpTo Sues, and at most 1 per SPAM_BAR.onePerAbove above it. */
export function verdictOf({ spam, count }) {
  const pass = count <= SPAM_BAR.zeroSpamUpTo ? spam === 0 : spam * SPAM_BAR.onePerAbove <= count;
  return { pass, spam, count, spamRate: count === 0 ? 0 : spam / count, upperBound: clopperPearsonUpper(spam, count) };
}

/** The key a verdict is booked under: sha256 over the email's from, subject, body and headers. */
export function contentHashOf(email) {
  const headers = Object.keys(email?.headers ?? {})
    .map((k) => [k.toLowerCase(), String(email.headers[k] ?? "")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([email?.from ?? "", email?.subject ?? "", email?.html ?? "", email?.text ?? "", headers]);
  return createHash("sha256").update(canonical).digest("hex");
}
