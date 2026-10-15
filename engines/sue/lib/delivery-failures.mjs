/**
 * delivery-failures - which of the mailroom's failed rows mean the MAILROOM is the broken thing.
 * ============================================================================================
 *
 * WHAT: `isSystemicDeliveryError(error)` is true when a row the mailroom could not deliver failed for a
 * reason that will just as surely hit the next row - S3 refusing (`AccessDenied`), the assumed role's
 * credentials dead or expired, the network or DNS down, the mail directory unwritable - and false for a
 * message that no retry can ever parse. `createDeliveryFailures({ abandonAfter })` counts that second
 * kind per inbound id and abandons one after N failed polls, so a single poison message neither stops
 * the mailroom nor gets retried, and logged, for the rest of the run.
 *
 * WHY IT EXISTS: `mailroom.mjs`'s `pollOnce` caught every `deliverOne` error, logged it and resolved, so
 * `main` read the poll as a success and reset its 10-consecutive-failure stop. With RDS answering and S3
 * refusing, that mailroom polls forever and delivers nothing while every Sue blames the product for a
 * code our own tool never fetched - the exact FALSE run the stop was written to prevent (2026-09-22
 * review, `sue-report-mailroom-row-errors-reset-killswitch`). Deliberately pure and dependency-free:
 * this classification IS the rule, so it is one source of truth and unit-testable with no AWS in reach.
 *
 * WHO DEPENDS ON IT: `mailroom.mjs` only - it imports all three exports. The expiry names live here
 * once because the credential-lease fallback keys off exactly the same set.
 */

/** The names an expired, revoked or otherwise dead credential arrives under (assume-role and STS). */
const EXPIRED_CREDENTIAL_NAMES = ["ExpiredTokenException", "ExpiredToken", "InvalidClientTokenId"];
/** AWS/S3 refusals and throttles: the SAME error on the next row, however many rows there are. */
const SYSTEMIC_ERROR_NAMES = [
  "AccessDenied",
  "AccessDeniedException",
  "Forbidden",
  "CredentialsProviderError",
  "AuthorizationHeaderMalformed",
  "SignatureDoesNotMatch",
  "SlowDown",
  "ServiceUnavailable",
  "ThrottlingException",
  "RequestTimeoutsError",
  "TimeoutError",
  "RequestTimeout",
  "RequestAbortedError",
];
/** Node-level faults: no route to S3, or nowhere to write the mail that was fetched. */
const SYSTEMIC_ERROR_CODES = [
  "NETWORK_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOSPC",
  "EROFS",
  "EACCES",
  "EPERM",
];

/**
 * One step of the mailroom's consecutive-failure stop. A poll that threw counts once; a poll whose rows
 * failed systemically counts once per such row (each is a delivery that did not happen); a clean poll
 * resets to 0. `mailroom.mjs` stops the run when this reaches its limit.
 */
export function nextConsecutiveFailures(previous, { threw = false, systemicFailures = 0 } = {}) {
  const rows = Number(systemicFailures) > 0 ? Number(systemicFailures) : 0;
  if (!threw && rows === 0) return 0;
  return (Number(previous) || 0) + Math.max(1, rows);
}

/** A credential that is gone, by NAME and never by message text (the message is not a contract). */
export function isExpiredCredentialError(error) {
  return EXPIRED_CREDENTIAL_NAMES.includes(error?.name ?? "");
}

/** True when this failure is about the mailroom's access to mail rather than about one message. */
export function isSystemicDeliveryError(error) {
  if (isExpiredCredentialError(error)) return true;
  if (SYSTEMIC_ERROR_NAMES.includes(error?.name ?? "")) return true;
  const codes = [error?.code, error?.cause?.code].filter((code) => typeof code === "string");
  return codes.some((code) => SYSTEMIC_ERROR_CODES.includes(code));
}

/**
 * Per-inbound-id accounting for rows that failed for a NON-systemic reason - a message no retry can
 * parse. `note(inboundId)` records one failed poll at that id and answers true exactly ONCE, on the
 * poll that abandons it, so the caller can name it in the log once and skip it from then on.
 */
export function createDeliveryFailures({ abandonAfter }) {
  const attempts = new Map();
  const abandoned = new Set();
  return {
    note(inboundId) {
      if (!inboundId || abandoned.has(inboundId)) return false;
      const count = (attempts.get(inboundId) ?? 0) + 1;
      if (count < abandonAfter) {
        attempts.set(inboundId, count);
        return false;
      }
      attempts.delete(inboundId);
      abandoned.add(inboundId);
      return true;
    },
    isAbandoned(inboundId) {
      return Boolean(inboundId) && abandoned.has(inboundId);
    },
  };
}
