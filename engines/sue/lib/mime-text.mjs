/**
 * mime-text - the one canonical reader of our own transactional mail's raw MIME bytes.
 *
 * Hoisted VERBATIM (2026-09-21, the SUE build) out of
 * services/accounts/infra/scripts/probe-otp-signin-path.mjs, which now imports this module instead
 * of carrying its own copy - one reader, not two, same "hoist once, repoint every call site"
 * precedent as scripts/aws/lib/assume-org-role.mjs and scripts/aws/lib/main-db-client.mjs.
 *
 * WHY THIS IS "MINIMAL": it reads exactly the shape HERMES sends and SES stores raw - a top-level
 * `multipart/alternative` with a `text/plain` and a `text/html` part, `quoted-printable` or
 * `base64` transfer-encoded, header folding on continuation lines. It is not a general MIME parser
 * and does not try to be one; anything our own mail does not produce (nested multipart/mixed with
 * attachments, uuencode, non-UTF-8 charsets) is out of scope on purpose.
 *
 * Depended on by:
 *   - services/accounts/infra/scripts/probe-otp-signin-path.mjs (splitHeadersBody, decodeTransfer,
 *     textParts, candidateCodes - reads a disposable persona's own sign-in code from her inbox)
 *   - sue/mailroom.mjs (splitHeadersBody, textParts - reads every Sue's inbox; NEVER calls
 *     candidateCodes and never prints a code, per SPEC.md's rail)
 */

/** Splits a raw MIME entity (message or one multipart section) into folded, lower-cased headers
 * and the body that follows the blank-line gap. The first occurrence of a header name wins. */
export function splitHeadersBody(entity) {
  const gap = entity.search(/\r?\n\r?\n/);
  if (gap < 0) return { headers: {}, body: "" };
  const head = entity.slice(0, gap).replace(/\r?\n[ \t]+/g, " ");
  const body = entity.slice(gap).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

/** Undoes `Content-Transfer-Encoding`; anything besides base64/quoted-printable passes through. */
export function decodeTransfer(body, encoding) {
  const enc = String(encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

/** Walks a (possibly multipart) entity and returns every `text/plain` or `text/html` leaf as
 * `{ html, text }`, decoded. Non-text parts are dropped. */
export function textParts(entity) {
  const { headers, body } = splitHeadersBody(entity);
  const type = headers["content-type"] ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    return body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith("--"))
      .flatMap((part) => textParts(part.replace(/^\r?\n/, "")));
  }
  if (!/^text\/(plain|html)/i.test(type)) return [];
  return [{ html: /^text\/html/i.test(type), text: decodeTransfer(body, headers["content-transfer-encoding"]) }];
}

/** Every distinct 6-digit code the message shows. The caller refuses anything but exactly one -
 * NEVER call this from mailroom.mjs, which must never learn or print a code. */
export function candidateCodes(parts) {
  const found = new Set();
  for (const { html, text } of parts) {
    const pattern = html ? />\s*(\d{6})\s*</g : /(?<![\d#])(\d{6})(?!\d)/g;
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}
