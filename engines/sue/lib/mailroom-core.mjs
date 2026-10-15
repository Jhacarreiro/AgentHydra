/**
 * mailroom-core - the pure half of the mailroom's delivery logic.
 * ===============================================================
 *
 * WHAT: the transforms a mailroom poll does while holding no AWS client - which manifest entries are
 * Sue addresses (`addressesFromManifest`), the run's query lower bound before any event is seen
 * (`sinceForManifest`), the inbound id an SES delivery's `smtpResponse` carries
 * (`inboundIdFromSmtpResponse`), where that message landed (`inboundLanding`), the RDS `TIMESTAMP` and ISO shapes (`rdsTimestamp`, `toIsoTimestamp`),
 * and the mail file a delivery becomes (`buildMailRecord`, with `extractText` and `extractHtml`).
 *
 * WHY IT EXISTS: these functions lived in `mailroom.mjs`, which reaches top-level `await main()` and
 * `process.exit(2)` at import time with no `--run`, so no test could import them and their exports
 * were dead (2026-09-22 review, `sue-report-mailroom-untestable`). Pure and dependency-free here, the
 * delivery logic is unit-testable with no browser, no Claude CLI and no network.
 *
 * WHO DEPENDS ON IT: `mailroom.mjs` only.
 */

import { isSueAddress } from "../../lib/shared/sue-address.mjs";

/** Manifest -> the lower-cased, de-duplicated address list a poll filters on (the customer-data "our
 * own rows" rule). Reads `<run>/manifest.json` fresh so a `--forever` cannon's later Sues are picked
 * up, and accepts a bare string or `{ address }` - the shape `cannon.mjs` writes is not this module's
 * contract to pin. */
export function addressesFromManifest(manifest) {
  const raw = Array.isArray(manifest?.addresses) ? manifest.addresses : [];
  const addresses = raw
    .map((entry) => (typeof entry === "string" ? entry : entry?.address))
    .filter((a) => typeof a === "string" && a.includes("@"));
  return [...new Set(addresses.map((a) => a.toLowerCase()))];
}

/** `YYYY-MM-DD HH:MM:SS.SSS` in UTC - the format the RDS Data API's `TIMESTAMP` typeHint expects. */
export function rdsTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

/** The run's start minus `lookbackMs`: the query lower bound until a poll has seen an event. */
export function sinceForManifest(manifest, lookbackMs) {
  if (!manifest?.started) throw new Error('manifest has no "started" timestamp');
  return new Date(Date.parse(manifest.started) - lookbackMs);
}

/** The `250 OK <id>` the SES inbound receipt rule stamps into `smtpResponse` on delivery - the
 * inbound message's key under Main's landing prefix (`inboundLanding`). Mirrors the accounts OTP probe's own regex. */
export function inboundIdFromSmtpResponse(smtpResponse) {
  return /^250\s+OK\s+([0-9a-z]+)$/i.exec(String(smtpResponse ?? "").trim())?.[1] ?? null;
}

/** Where SES landed one inbound message: Main's receipt rule writes to `landing/mail/main/` in
 * storage's content bucket (infra/shared/storage/mail-landing-contract.ts, read by
 * services/main/infra/lib/constructs/ses-inbound.ts), owned by storage's account. Plain node cannot
 * import that .ts contract, so its values are spelled here and tests/mailroom-core.spec.mjs fails the
 * moment they drift. A message Main's router routed is discarded from the landing; a Sue's never is,
 * because nothing routes mail to a Sue address, so it stays for storage's 7-day expiry. */
const STORAGE_ACCOUNT = "647145109696";
export function inboundLanding(inboundId) {
  return { account: STORAGE_ACCOUNT, bucket: `connections-storage-content-${STORAGE_ACCOUNT}`, key: `landing/mail/main/${inboundId}` };
}

/**
 * The ONLY thing standing between `--probe-account` and a real customer's row (todo 4c0e16d5): pure,
 * so it is tested with no AWS in reach, and checked in `mailroom.mjs` BEFORE any query is built - a
 * refusal here means zero SQL ever runs. `{ ok: true }` for a Sue-shaped address, else
 * `{ ok: false, error }` naming what was refused.
 */
export function probeAccountGuard(email) {
  if (!isSueAddress(email)) {
    return { ok: false, error: `refusing to probe ${JSON.stringify(email ?? null)} - not a Sue address` };
  }
  return { ok: true, email: String(email).trim().toLowerCase() };
}

/** An ISO timestamp for the mail record, or null for a value Date cannot read. */
export function toIsoTimestamp(value) {
  if (!value) return null;
  // A space-separated ISO-like timestamp ('2026-09-22 10:00:00', the shape RDS returns) must be
  // reshaped before Date sees it: Date reads the bare space form as LOCAL time. Pinning the reshaped
  // value to UTC keeps the RDS eventTimestamp exact. Everything else - RFC 2822 Date headers such as
  // 'Mon, 22 Sep 2026 10:00:00 +0000', whose weekday name is no reliable 'T' - goes to Date verbatim.
  // Only a ZONELESS space form is pinned to UTC; one that already carries an offset
  // ('2026-09-22 10:00:00+0200') keeps it, or appending Z makes it unparseable.
  let isoish = value;
  if (/^\d{4}-\d\d-\d\d \d/.test(value)) {
    isoish = value.replace(" ", "T");
    if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(isoish)) isoish += "Z";
  }
  const parsed = new Date(isoish);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The message exactly as its sender designed it, or null for a text-only mail. A Sue opens this in
 * her Mail tab (lib/inbox-page.mjs) and judges what a person actually sees - the logo, the button,
 * the layout - not a tag-stripped paragraph (Owner, 2026-09-22: "open a full page ... take a
 * screenshot of exactly what the signup email looks like, read it, and judge"). Storing it teaches
 * the mailroom nothing it did not already hold: `text` below carries the same code.
 */
export function extractHtml(parts) {
  const html = parts.find((p) => p.html);
  return html ? html.text : null;
}

/** Plain text preferred; an html-only message has its tags stripped and whitespace collapsed. */
export function extractText(parts) {
  const plain = parts.find((p) => !p.html);
  if (plain) return plain.text;
  const html = parts.find((p) => p.html);
  if (!html) return "";
  return html.text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The record a mail file holds, built from the split headers and MIME parts so `deliverOne` only
 * writes it. `receivedAt` falls back to now when the Date header is unreadable. */
export function buildMailRecord({ headers, parts, providerMessageId, eventTimestamp }) {
  return {
    from: headers.from ?? "",
    subject: headers.subject ?? "",
    text: extractText(parts),
    html: extractHtml(parts),
    receivedAt: toIsoTimestamp(headers.date) ?? new Date().toISOString(),
    deliveredAt: toIsoTimestamp(eventTimestamp),
    messageId: providerMessageId,
  };
}
