/**
 * inbox-page - a Sue's own inbox, opened as a real page in her browser, so she sees an email the way
 * a person does and judges THAT: the logo, the button, the layout, how long it is.
 * ============================================================================================
 *
 * WHY IT EXISTS: until 2026-09-22 a Sue only ever got an email as tag-stripped text in a JSON list,
 * and her opinion of it was asked for in the exit interview - which both live runs that day never
 * reached, so `emailsReceived` came back empty while three real emails had landed in each inbox.
 * the owner's ask: "open a full page ... take a screenshot of exactly what the signup email looks like,
 * read it, and judge the signup email ... the OTP code email as well".
 *
 * HOW: the page lives at `https://inbox.sue.invalid/message/<id>`. `.invalid` is reserved by RFC 2606,
 * so the address can never resolve to anybody's real server; the body serves it from her own mail
 * folder through a Playwright route, so no request ever leaves the machine for it. Because it is a
 * REAL address, every existing rail treats it like any other page she is allowed on - `look` reads it,
 * a screenshot captures it, `tabs` can switch to it - and a link inside the email is an ordinary
 * link, whose destination the host rails judge exactly as they judge a link on the site.
 *
 * The code she reads there is visible, as it is to a person. That opens no shortcut: the body still
 * refuses a six-digit number she types by hand, and the only way to enter it stays
 * `field: the-code-from-my-email`.
 *
 * THE INBOX TEST (lib/inbox-test.mjs): the same page carries the Gmail-like controls - Report spam,
 * Delete, Archive, Reply, and Unsubscribe only when the email has List-Unsubscribe. Each press is a
 * route here that reports one event through `onEvent`, which the body writes into her folder; the
 * disposition is read back from those events. A link inside the email goes through /go so that a
 * click is recorded before the browser is sent on to the real address.
 *
 * WHO DEPENDS ON IT: body.mjs (installs the route, adds INBOX_HOST to her allowed hosts, and opens
 * the page from `open_email`); tests/inbox-page.spec.mjs, tests/inbox-controls.spec.mjs.
 */
import { controlsFor, unsubscribeUrlOf } from "./inbox-test.mjs";

export const INBOX_HOST = "inbox.sue.invalid";
export const INBOX_ORIGIN = `https://${INBOX_HOST}`;

/** The stable id of a stored message: its file name without `.json` (the inbound id). */
export function messageIdOf(record) {
  const file = String(record?._file ?? "");
  const base = file.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.json$/i, "");
}

export function messageUrl(id) {
  return `${INBOX_ORIGIN}/message/${encodeURIComponent(id)}`;
}

export function isInboxUrl(url) {
  try {
    return new URL(url).hostname === INBOX_HOST;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * What her phone says when mail she has not seen arrives: one buzz per email, never repeated.
 * `messages` is newest first (readInbox); `announced` is the Set of ids she has already been told
 * about, and this adds to it. Returns the line to put above her next look, or "" when nothing is new.
 * A person finds a new email because the phone tells them, not because they think to check. The
 * message that sent her (`seeded`) never buzzes: it is already on her screen when she starts.
 */
export function phoneBuzz(messages, announced) {
  const fresh = messages.filter((m) => !m?.seeded && !announced.has(messageIdOf(m)));
  for (const m of fresh) announced.add(messageIdOf(m));
  if (fresh.length === 0) return "";
  const said = fresh.map((m) => `"${m.subject ?? "(no subject)"}" from ${m.from ?? "someone"}`).join(", ");
  const count = fresh.length === 1 ? "a new email" : `${fresh.length} new emails`;
  return `Your phone buzzed: ${count} - ${said}. check_email shows your inbox.`;
}

// "stop" and "no more" count only about the mail itself: "how do you stop cheaters" is a yes (2026-10-14).
const OPT_OUT =
  /^\s*stop\b|\b(stop (emailing|contacting|sending|writing|messaging|mailing)|unsubscribe|opt ?out|take me off|remove me|no more (emails?|mail|messages)|(don'?t|do not) (email|contact|send|write))\b/i;

const BARE_NO = /^\s*no(\s+(thanks|thank you))?\s*[.!]?\s*$/i;

/** A reply that asks to stop hearing from them is an opt-out; any other reply is only recorded. */
export function classifyReply(text) {
  const said = String(text ?? "");
  return OPT_OUT.test(said) || BARE_NO.test(said) ? "opt-out" : "other";
}

/** The email's own links, with each one routed through the inbox: its unsubscribe address counts as unsubscribing. */
export function rewriteEmailLinks(html, id, unsubscribeUrl) {
  const enc = encodeURIComponent(id);
  return String(html).replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (whole, lead, quote, href) => {
    if (unsubscribeUrl && href === unsubscribeUrl) return `${lead}${quote}${INBOX_ORIGIN}/act/${enc}/unsubscribe?via=body-link${quote}`;
    return `${lead}${quote}${INBOX_ORIGIN}/go/${enc}?to=${encodeURIComponent(href)}${quote}`;
  });
}

function controlsHtml(id, record) {
  const enc = encodeURIComponent(id);
  const labels = { report_spam: "Report spam", delete: "Delete", archive: "Archive", unsubscribe: "Unsubscribe" };
  const links = controlsFor(record)
    .filter((c) => c !== "reply")
    .map((c) => {
      const href = c === "unsubscribe" ? `${INBOX_ORIGIN}/act/${enc}/unsubscribe?via=native` : `${INBOX_ORIGIN}/act/${enc}/${c}`;
      return `<a href="${href}" style="margin-right:12px">${labels[c]}</a>`;
    });
  const reply = `<form method="post" action="${INBOX_ORIGIN}/reply/${enc}" style="margin:8px 0 0"><textarea name="text" rows="2" style="width:100%;max-width:520px"></textarea><br><button type="submit">Reply</button></form>`;
  return `<p data-sue-controls style="margin:6px 0">${links.join("")}</p>${reply}`;
}

/**
 * The page for one message: a plain mail-client header (From, Subject, when) above the email itself.
 * An HTML email is served as its sender wrote it, with the header placed just inside its `<body>`;
 * a text-only email is shown as the text, in a readable column. With `id`, the page also carries the
 * controls and routes the email's links through the inbox (see the header comment).
 */
export function renderMessagePage(record, { receivedLabel = "", id = null } = {}) {
  const subject = escapeHtml(record?.subject || "(no subject)");
  // Paragraphs, not bare divs: her eyes (lib/perception.mjs) read `p` as text and skip a div's loose
  // words, so a div header was invisible to her while the email under it read fine (measured
  // 2026-09-22 in hands.spec).
  const line = "margin:0";
  const header = [
    `<header data-sue-inbox-header style="font:14px/1.5 system-ui,sans-serif;border-bottom:1px solid #ddd;padding:12px 16px;background:#fafafa;color:#222">`,
    `<p style="${line}">From: ${escapeHtml(record?.from || "(unknown sender)")}</p>`,
    `<p style="${line}">Subject: ${subject}</p>`,
    receivedLabel ? `<p style="${line}">Received: ${escapeHtml(receivedLabel)}</p>` : "",
    id ? controlsHtml(id, record) : "",
    `</header>`,
  ].join("");
  const unsubscribeUrl = unsubscribeUrlOf(record);
  const rawHtml = typeof record?.html === "string" && record.html.trim() ? record.html : null;
  const html = rawHtml && id ? rewriteEmailLinks(rawHtml, id, unsubscribeUrl) : rawHtml;
  if (html) {
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, (m) => `${m}${header}`);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${subject}</title></head><body>${header}${html}</body></html>`;
  }
  const text = escapeHtml(record?.text || "(this email is empty)");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${subject}</title></head><body style="margin:0">${header}<pre style="font:15px/1.6 system-ui,sans-serif;white-space:pre-wrap;padding:16px;max-width:680px">${text}</pre></body></html>`;
}

function listPage(messages) {
  const rows = messages.map((m) => {
    const id = messageIdOf(m);
    return `<li><a href="${messageUrl(id)}">${escapeHtml(m.subject || "(no subject)")}</a> - ${escapeHtml(m.from || "")}</li>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inbox</title></head><body style="font:15px/1.6 system-ui,sans-serif;padding:16px"><h1>Inbox</h1><ul>${rows.join("") || "<li>No email yet.</li>"}</ul></body></html>`;
}

function html(route, status, body) {
  return route.fulfill({ status, contentType: "text/html; charset=utf-8", body });
}

function confirmation(text) {
  return `<!doctype html><title>Done</title><p>${escapeHtml(text)}</p>`;
}

/**
 * Serve her inbox on INBOX_ORIGIN from `readMessages()` (newest first, as lib/findings.mjs reads it).
 * `onEvent(id, event)` hears each press: open, report-spam, delete, archive, unsubscribe (via native,
 * body-link or reply), click-through, reply (with the Sue's own words as `quote`).
 */
export async function installInboxPage(context, { readMessages, receivedLabelOf = () => "", onEvent = () => {} }) {
  const find = (id) => readMessages().find((m) => messageIdOf(m) === id) ?? null;
  await context.route(`${INBOX_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/" || path === "") return html(route, 200, listPage(readMessages()));
    const message = /^\/message\/([^/?#]+)$/.exec(path);
    if (message) {
      const id = decodeURIComponent(message[1]);
      const record = find(id);
      if (!record) return html(route, 404, "<!doctype html><title>Not found</title><p>That email is not in your inbox.</p>");
      onEvent(id, { kind: "open" });
      return html(route, 200, renderMessagePage(record, { receivedLabel: receivedLabelOf(record), id }));
    }
    const act = /^\/act\/([^/]+)\/([a-z_]+)$/.exec(path);
    if (act) {
      const id = decodeURIComponent(act[1]);
      const record = find(id);
      if (!record) return html(route, 404, "<!doctype html><title>Not found</title><p>That email is not in your inbox.</p>");
      const control = act[2];
      if (control === "report_spam") onEvent(id, { kind: "report-spam" });
      else if (control === "delete") onEvent(id, { kind: "delete" });
      else if (control === "archive") onEvent(id, { kind: "archive" });
      else if (control === "unsubscribe") onEvent(id, { kind: "unsubscribe", via: url.searchParams.get("via") ?? "native" });
      else return html(route, 404, "<!doctype html><title>Not found</title>");
      return html(route, 200, confirmation(`Done: ${control.replace("_", " ")}.`));
    }
    const go = /^\/go\/([^/]+)$/.exec(path);
    if (go) {
      const id = decodeURIComponent(go[1]);
      const to = url.searchParams.get("to") ?? "";
      if (!find(id) || !/^https?:\/\//i.test(to)) return html(route, 404, "<!doctype html><title>Not found</title>");
      onEvent(id, { kind: "click-through", to });
      return route.fulfill({ status: 302, headers: { location: to }, body: "" });
    }
    const reply = /^\/reply\/([^/]+)$/.exec(path);
    if (reply && request.method() === "POST") {
      const id = decodeURIComponent(reply[1]);
      if (!find(id)) return html(route, 404, "<!doctype html><title>Not found</title>");
      const text = new URLSearchParams(request.postData() ?? "").get("text") ?? "";
      onEvent(id, { kind: "reply", quote: text });
      if (classifyReply(text) === "opt-out") onEvent(id, { kind: "unsubscribe", via: "reply", quote: text });
      return html(route, 200, confirmation("Your reply was sent."));
    }
    return html(route, 404, "<!doctype html><title>Not found</title><p>That email is not in your inbox.</p>");
  });
}
