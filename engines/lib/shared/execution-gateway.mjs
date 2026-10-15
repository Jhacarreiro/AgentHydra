// vendored from Connections packages/connections-arkitect/src/core/execution-gateway.mjs @ dd3d47a7ad
/** Canonical safe boundary for every Architect-owned process or network execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { killProcessTree } from "./process-tree.mjs";
import { readActiveExecutionScope } from "./execution-scope-activation.mjs";
import { noteSpawn } from "./read-path-recorder.mjs";

const REDACTED = "[REDACTED]";
const DEFAULT_SECRET_PATTERNS = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(cnx_live_|cnx_test_)[A-Za-z0-9_-]+\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
];
// ★ RETRY-ON-TIMEOUT LIVES HERE, NOT PER-SEAM (2026-08-06). It used to live at each subprocess call
// site (packages/connections-arkitect/agnostic/lib/scanner-seams.mjs carried its own copy for rg/git calls) - so a NEW seam had
// to remember to copy it, and the one that didn't (`gitNullSeparatedList`) crashed every `--all` run
// when `git ls-files` timed out under 8-worker contention, because an unretried timeout there left
// the scan with zero observable seams and the runner correctly refused to trust an unprovable
// "no-data". A subprocess timeout under worker contention is contention, not an answer, and a
// deterministic READ has no side effect from repeating - but a WRITE must never silently retry (it
// may have already taken effect server-side), so retry is opt-IN via `access: "read"` and OFF for
// every other/undeclared access. See `runProcessSync` below, the seam scanner-seams.mjs itself calls.
const SUBPROCESS_TIMEOUT_RETRY_ATTEMPTS = 3;
const SUBPROCESS_TIMEOUT_RETRY_BACKOFF_MS = 750;

/** Synchronous backoff for the retry loop below - `runProcessSync` is sync by contract, so there
 *  is no await to reach for. Blocks only the caller that already lost its subprocess to a timeout.
 *  Exported so `readiness.mjs` (which already imports `runProcessSyncText` from here for the same
 *  reason) can import this one instead of carrying its own byte-identical copy for the
 *  attestation-lock retry loop. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const activeGatewayNetworkCall = new AsyncLocalStorage();
const EXECUTION_SCOPE_ENV = "ARKITECT_EXECUTION_SCOPE_V1";
const STREAM_REDACTION_LOOKBEHIND = 8 * 1024;
const executionScopeState = new WeakMap();
let processExecutionScope = null;
let processChildDelegationCeiling = null;
let inheritedProcessCeiling = null;
let processScopeDeclared = false;

/**
 * SSRF preflight (SEC-06) - `fetchWithDeadline`/`runNetworkOperation` used to gate capability and
 * HTTP method only, so a network-capable check could reach EC2/GCP instance metadata
 * (169.254.169.254) or any other internal address with nothing refusing it. This is a SYNC,
 * literal-form-only preflight (no DNS lookup - a sync check cannot await one): it rejects an IP
 * literal inside a non-routable range, a known cloud-metadata hostname, or a loopback hostname,
 * off the URL string alone. A hostname that only RESOLVES to an internal address at connect time
 * is out of scope here - see `infra/shared/ssrf-guard.ts` (`assertSafeOutboundUrl` +
 * `fetchSafely`'s DNS-pinned transport) for the async, resolve-and-pin guard Lambda code takes
 * against a user-supplied URL. This module is the Architect's portable framework core
 * (packages/connections-arkitect), shipped to any repo, so it keeps its own small copy of the
 * range logic rather than importing that Connections-specific plane file.
 */
const NETWORK_METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog"]);
const NETWORK_LOOPBACK_HOSTNAMES = new Set(["localhost"]);

function normalizeNetworkTargetHost(hostname) {
  const trimmed = String(hostname ?? "").trim();
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const lowered = unbracketed.toLowerCase();
  // 2026-08-14 (SSRF preflight reach gap #1): "localhost." is the fully-qualified spelling of
  // "localhost" (RFC 1035 - a trailing root-label dot resolves identically) and previously matched
  // neither NETWORK_LOOPBACK_HOSTNAMES nor net.isIP, so it sailed past the preflight untouched.
  // Stripping exactly one trailing dot folds every FQDN spelling onto the same denylist entry the
  // bare name already hits; guarded so a literal "." hostname is left alone rather than emptied.
  return lowered.endsWith(".") && lowered !== "." ? lowered.slice(0, -1) : lowered;
}

/**
 * 0.0.0.0/8 (this-network), 10/8 + 172.16/12 + 192.168/16 (RFC1918 private), 127/8 (loopback),
 * 100.64/10 (CGNAT), 169.254/16 (link-local - includes the EC2/GCP metadata address
 * 169.254.169.254). Mirrors `infra/shared/ssrf-guard.ts`'s `isPrivateIPv4` (independent copy -
 * see the doc comment above).
 */
function isNonRoutableIPv4(ip) {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Strip an IPv6 zone id (`%eth0`, RFC 4007) - it identifies a local interface, plays no part in
 * the address itself, and every range/embedded-IPv4 check below operates on the address alone.
 */
function stripIPv6ZoneId(ip) {
  const zoneIndex = ip.indexOf("%");
  return zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
}

/**
 * An IPv6 literal's trailing group may be written as a dotted-quad IPv4 tail
 * (`::ffff:169.254.169.254`) instead of two hex groups (`::ffff:a9fe:a9fe`) - both spellings are
 * the same address. Converting the dotted form to hex groups FIRST means every alias of the same
 * address (dotted, hex-group, fully expanded, `::`-compressed) reaches the exact same
 * `::`-expansion path below, so none of them can silently skip the embedded-IPv4 check the other
 * spellings hit. Returns the input unchanged when there is no dotted tail, `null` when a dotted
 * tail is present but malformed.
 */
function convertTrailingIPv4ToHexGroups(ip) {
  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return ip;
  const tail = ip.slice(lastColon + 1);
  if (!tail.includes(".")) return ip;
  const octets = tail.split(".");
  if (octets.length !== 4) return null;
  const values = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number.parseInt(octet, 10) : Number.NaN));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const high = ((values[0] << 8) | values[1]).toString(16);
  const low = ((values[2] << 8) | values[3]).toString(16);
  return `${ip.slice(0, lastColon + 1)}${high}:${low}`;
}

/**
 * Expand a lowercase, zone-stripped, dotted-quad-free IPv6 literal to its full 8 hex groups,
 * resolving a single `::` run first (RFC 4291 §2.2) so every compressed/expanded spelling of the
 * same address produces the identical group array. Returns `null` for anything not shaped like a
 * valid IPv6 literal - the caller already gated on `node:net`'s `isIP`, so this is a defensive
 * `null`, not the primary validator.
 */
function expandIPv6Groups(ip) {
  if (!/^[0-9a-f:]*$/.test(ip)) return null;
  const doubleColonRuns = ip.split("::").length - 1;
  if (doubleColonRuns > 1) return null;
  const hasDoubleColon = doubleColonRuns === 1;
  const [rawLeft, rawRight] = hasDoubleColon ? ip.split("::") : [ip, ""];
  const leftGroups = rawLeft === "" ? [] : rawLeft.split(":");
  const rightGroups = !hasDoubleColon || rawRight === "" ? [] : rawRight.split(":");
  if (!hasDoubleColon && leftGroups.length !== 8) return null;
  const filled = leftGroups.length + rightGroups.length;
  if (hasDoubleColon && filled >= 8) return null; // "::" must stand in for at least one group
  if ([...leftGroups, ...rightGroups].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const groups = hasDoubleColon ? [...leftGroups, ...Array(8 - filled).fill("0"), ...rightGroups] : leftGroups;
  return groups.map((group) => Number.parseInt(group, 16));
}

/** An IPv4-mapped (`::ffff:a.b.c.d`) or the deprecated IPv4-compatible (`::a.b.c.d`) address -
 *  both carry their IPv4 payload in the last two 16-bit groups once the first five are zero
 *  (RFC 4291 §2.5.5). Returns the embedded address as a dotted-quad string, or `null`. */
function decodeEmbeddedIPv4(groups) {
  if (!groups.slice(0, 5).every((group) => group === 0)) return null;
  if (groups[5] !== 0 && groups[5] !== 0xffff) return null;
  const [high, low] = [groups[6], groups[7]];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * ::1 (loopback), :: (unspecified), fe80::/10 (link-local), fc00::/7 (unique-local), and an
 * IPv4-mapped/IPv4-compatible address whose embedded v4 is itself non-routable - the latter
 * decoded through a full `::`-expansion (see `expandIPv6Groups`) rather than a dotted-quad-only
 * regex, so the hex-group form (`::ffff:a9fe:a9fe`), the fully-expanded form
 * (`0:0:0:0:0:ffff:169.254.169.254`), uppercase hex, and a zone id (`%eth0`) all resolve through
 * the same path as the plain dotted form instead of slipping past it (SEC-06 round 2 - the prior
 * dotted-quad-only regex missed every one of those). Mirrors `isPrivateIPv6` in
 * `infra/shared/ssrf-guard.ts`.
 */
function isNonRoutableIPv6(ip) {
  const withoutZone = stripIPv6ZoneId(ip).toLowerCase();
  const withHexIPv4 = convertTrailingIPv4ToHexGroups(withoutZone);
  if (withHexIPv4 === null) return false;
  const groups = expandIPv6Groups(withHexIPv4);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  const embeddedIPv4 = decodeEmbeddedIPv4(groups);
  return embeddedIPv4 !== null && isNonRoutableIPv4(embeddedIPv4);
}

export const NETWORK_TARGET_BLOCKED = "NETWORK_TARGET_BLOCKED";

function networkTargetBlocked(message) {
  const error = new Error(message);
  error.code = NETWORK_TARGET_BLOCKED;
  return error;
}

/**
 * WHATWG `URL` rejects an IPv6 zone id inside a bracketed host (`[::1%eth0]`) outright - it
 * throws before `assertNetworkTargetAllowed` ever sees a hostname, which the ordinary parse-
 * failure path below treats as "no network target to preflight" (correct for a `data:`/`blob:`
 * payload, WRONG for a zone-id IPv6 literal, which is exactly the kind of target this preflight
 * exists to catch - SEC-06 round 2). Recover just the bracketed literal by hand so a zone id
 * cannot buy a free pass around the guard by being unparsable to `URL`.
 */
function extractBracketedIPv6Host(rawUrl) {
  // The bracketed content is the IPv6 literal itself (hex/colon/dot) plus an optional zone id
  // after `%` - a zone id names a local network interface (`eth0`, `en0`, a numeric index) and is
  // not restricted to hex digits, so its own character class stays deliberately permissive; only
  // the address portion before the first `%` is ever range-checked (see `stripIPv6ZoneId`).
  const match = /^[a-z][a-z0-9+.-]*:\/\/\[([0-9a-fA-F:.]+(?:%[0-9a-zA-Z._~-]+)?)\]/.exec(rawUrl);
  return match ? match[1] : null;
}

/**
 * Preflight one URL against the SSRF denylist above, unless the execution scope explicitly
 * declared it allowed via `networkAllowedInternalHosts` (the opt-in a local check that genuinely
 * targets `http://localhost:<port>` - a dev server it started itself - must state out loud; the
 * default is refuse). `allowedHosts` is the scope's normalized Set. A `rawUrl` that fails to parse
 * as a URL (a `data:`/`blob:` payload, a `Request` object) has no network target to preflight and
 * is let through untouched - the seam's own error handling covers whatever it turns out to be -
 * UNLESS the parse failure is a bracketed IPv6 host `URL` refused only over its zone id, which is
 * recovered instead of waved through.
 */
function assertNetworkTargetAllowed(rawUrl, allowedHosts, label) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    const bracketedIPv6 = extractBracketedIPv6Host(String(rawUrl ?? ""));
    if (bracketedIPv6 == null) return;
    hostname = `[${bracketedIPv6}]`;
  }
  if (!hostname) return;
  const normalized = normalizeNetworkTargetHost(hostname);
  if (allowedHosts.has(normalized)) return;

  const ipFamily = isIP(normalized);
  if (ipFamily === 4 && isNonRoutableIPv4(normalized))
    throw networkTargetBlocked(`${label} refused: ${hostname} is a non-routable/link-local IP address`);
  if (ipFamily === 6 && isNonRoutableIPv6(normalized))
    throw networkTargetBlocked(`${label} refused: ${hostname} is a non-routable/link-local IP address`);
  if (NETWORK_METADATA_HOSTNAMES.has(normalized)) throw networkTargetBlocked(`${label} refused: ${hostname} is a cloud metadata hostname`);
  if (NETWORK_LOOPBACK_HOSTNAMES.has(normalized))
    throw networkTargetBlocked(
      `${label} refused: ${hostname} is a loopback hostname - declare it via the execution scope's networkAllowedInternalHosts if this check genuinely targets a local dev server`,
    );
}

/**
 * Stable `error.code` for work refused because its OWNING AUDIT WAS CANCELLED (A04, 2026-09-05).
 * Distinct from EXECUTION_CAPABILITY_DENIED on purpose: a denial says "this check was never allowed
 * to do that", a cancellation says "this check WAS allowed and its run is over". A degrade-on-failure
 * site must rethrow both, but only the second one means the row it belonged to is already published.
 */
export const EXECUTION_SCOPE_CANCELLED = "EXECUTION_SCOPE_CANCELLED";

function scopeCancelledError(scope, label) {
  const reason = executionScopeState.get(scope)?.cancellation?.signal?.reason;
  const error = new Error(
    `${label} refused: this audit's execution scope was cancelled${reason?.message ? ` (${reason.message})` : ""} - ` +
      "its result row is already published, so any work it starts now belongs to nobody",
  );
  error.code = EXECUTION_SCOPE_CANCELLED;
  if (reason instanceof Error) error.cause = reason;
  return error;
}

/** True once the runner has cancelled this scope; `null`/absent scopes are never cancelled. */
function executionScopeCancelled(scope) {
  return Boolean(scope && executionScopeState.get(scope)?.cancellation?.signal?.aborted);
}

/**
 * ⛔ CANCELLATION IS THE ONLY HONEST HALF OF A DEADLINE (A04, comprehensive review 2026-09-05).
 * The runner's `raceCheckAgainstDeadline` ends the WAIT; nothing about `Promise.race` ends the WORK.
 * So the deadline hands the abandoned check's scope to `cancelExecutionScope` below, and every seam
 * in this gateway reads that one signal: an in-flight fetch/socket/subprocess is aborted and its
 * child tree killed, and a NEW call from the abandoned continuation is refused before it starts.
 * That is what stops the reproduced contamination - a delayed `fetchWithDeadline` from a timed-out
 * audit landing inside a LATER audit's process-global fetch wrapper and being charged to it
 * (`laterBounces: 1` in the review's runtime probe).
 *
 * It does NOT stop arbitrary JavaScript. A check that never awaits a gateway seam - a `while (true)`,
 * a synchronous 40-second regex - honours nothing and keeps burning the event loop until the process
 * ends. Only killable isolation can bound that, and it exists as an opt-in: an audit declaring
 * `isolation: "worker"` runs in a thread the runner's deadline hook terminates (see
 * runner-worker-isolation.mjs beside this file). Claiming that THIS function stops such a check
 * would be the exact false confidence the review is about.
 */
export function cancelExecutionScope(scope, reason) {
  const state = requireExecutionScopeState(scope, "execution scope cancellation");
  if (state.cancellation.signal.aborted) return false;
  // Counted as an abort rather than a new metric: a cancellation IS an abort of everything this
  // scope still holds, and `summarizeResourceTelemetry` already sums `aborts` into the manifest -
  // a fresh key would be invisible there and the corpus treats an unread config key as dead weight.
  state.metrics.aborts += 1;
  state.cancellation.abort(reason instanceof Error ? reason : new Error(String(reason ?? "audit execution scope cancelled")));
  return true;
}

/** Per-run, opt-in observation and capability boundary for audit orchestration. */
export function createExecutionScope({
  capabilities = [],
  networkMutationAllowed = false,
  networkReadOnly = false,
  networkAllowedInternalHosts = [],
} = {}) {
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || !capability))
    throw new TypeError("execution scope capabilities must be non-empty strings");
  if (!Array.isArray(networkAllowedInternalHosts) || networkAllowedInternalHosts.some((host) => typeof host !== "string" || !host.trim()))
    throw new TypeError("execution scope networkAllowedInternalHosts must be non-empty strings");
  const allowed = new Set(capabilities);
  const allowedInternalHosts = new Set(networkAllowedInternalHosts.map((host) => normalizeNetworkTargetHost(host)));
  const declaration = Object.freeze({
    capabilities: Object.freeze([...allowed].sort()),
    networkMutationAllowed: Boolean(networkMutationAllowed),
    networkReadOnly: Boolean(networkReadOnly),
    networkAllowedInternalHosts: Object.freeze([...allowedInternalHosts].sort()),
  });
  const metrics = {
    subprocesses: 0,
    networkCalls: 0,
    timeouts: 0,
    // A timeout the gateway retried on the caller's behalf (see runProcessSync below) - counted
    // separately from `timeouts` (every attempt, retried or not, still increments that) so a
    // reader can tell "degraded but recovered" from "degraded and never recovered".
    retriedTimeouts: 0,
    aborts: 0,
    stdoutTruncations: 0,
    stderrTruncations: 0,
    workspaceCleanups: 0,
    managedProcessCleanups: 0,
  };
  // One controller per scope, created eagerly so `scope.signal` is a stable reference a check can
  // capture at the top of run() and pass to its own awaits - a lazily-created signal would hand
  // different objects to different callers and silently miss the ones that captured too early.
  const cancellation = new AbortController();
  const scope = {
    declaration,
    /** Cooperative-cancellation signal for THIS audit; aborted when the runner abandons the check. */
    get signal() {
      return cancellation.signal;
    },
    get cancelled() {
      return cancellation.signal.aborted;
    },
    /** Checks with their own long loops call this between units of work to exit on cancellation. */
    assertNotCancelled(label = "audit work") {
      if (cancellation.signal.aborted) throw scopeCancelledError(scope, label);
    },
    allows(capability) {
      return allowed.has(capability);
    },
    assertNetworkMethod(method = "GET") {
      const normalizedMethod = String(method || "GET").toUpperCase();
      if (normalizedMethod === "GET" || normalizedMethod === "HEAD") return;
      if (declaration.networkReadOnly) throw new Error(`read-only execution scope forbids HTTP ${normalizedMethod}`);
      if (!declaration.networkMutationAllowed)
        throw new Error(`HTTP ${normalizedMethod} requires evidence risk 'disposable-write' or 'external-side-effect'`);
    },
    assertNetworkAccess(access = "read", label = "network operation") {
      const normalizedAccess = String(access || "read").toLowerCase();
      if (normalizedAccess === "read") return;
      if (normalizedAccess !== "write") throw new TypeError(`unknown network operation access '${access}'`);
      if (declaration.networkReadOnly) throw new Error(`read-only execution scope forbids mutating ${label}`);
      if (!declaration.networkMutationAllowed)
        throw new Error(`${label} requires evidence risk 'disposable-write' or 'external-side-effect'`);
    },
    assertNetworkTarget(rawUrl, label = "network operation") {
      assertNetworkTargetAllowed(rawUrl, allowedInternalHosts, label);
    },
    snapshot() {
      return Object.freeze({ ...metrics, capabilities: declaration.capabilities });
    },
  };
  executionScopeState.set(scope, { allowed, declaration, metrics, cancellation });
  return Object.freeze(scope);
}

function requireExecutionScopeState(scope, label = "execution scope") {
  const state = executionScopeState.get(scope);
  if (!state) throw new TypeError(`${label} requires an execution scope created by createExecutionScope()`);
  return state;
}

function recordExecutionMetric(scope, metric) {
  if (!scope) return;
  const { metrics } = requireExecutionScopeState(scope);
  if (!Object.hasOwn(metrics, metric)) throw new TypeError(`unknown execution metric '${metric}'`);
  metrics[metric] += 1;
}

try {
  const inherited = JSON.parse(process.env[EXECUTION_SCOPE_ENV] || "null");
  if (inherited) inheritedProcessCeiling = createExecutionScope(inherited);
} catch {
  throw new Error(`invalid ${EXECUTION_SCOPE_ENV} child execution scope`);
}

function assertScopeSubset(scope, ceiling, label) {
  const state = requireExecutionScopeState(scope, label);
  const ceilingState = requireExecutionScopeState(ceiling, `${label} ceiling`);
  for (const capability of state.declaration.capabilities)
    if (!ceilingState.allowed.has(capability)) throw new Error(`${label} capability '${capability}' exceeds its declared ceiling`);
  if (state.allowed.has("network") && state.declaration.networkMutationAllowed && !ceilingState.declaration.networkMutationAllowed)
    throw new Error(`${label} mutating-network authority exceeds its declared ceiling`);
  if (state.allowed.has("network") && ceilingState.declaration.networkReadOnly && !state.declaration.networkReadOnly)
    throw new Error(`${label} cannot remove its declared read-only network restriction`);
}

/** Structural declaration for standalone .arkitect/runners processes. Inherited parent scope cannot be broadened. */
export function declareProcessExecutionScope(declaration = {}) {
  if (processScopeDeclared) throw new Error("process execution scope was already declared");
  const { childDelegation = null, ...ownDeclaration } = declaration;
  const requested = createExecutionScope(ownDeclaration);
  const childCeiling = childDelegation == null ? null : createExecutionScope(childDelegation);
  if (childCeiling && !requested.allows("subprocess"))
    throw new Error("child execution delegation requires the process 'subprocess' capability");
  if (inheritedProcessCeiling) {
    for (const capability of requested.declaration.capabilities)
      if (!inheritedProcessCeiling.allows(capability))
        throw new Error(`runner capability '${capability}' was not granted by its parent scope`);
    if (
      requested.allows("network") &&
      requested.declaration.networkMutationAllowed &&
      !inheritedProcessCeiling.declaration.networkMutationAllowed
    )
      throw new Error("runner mutating-network capability was not granted by its parent scope");
    if (requested.allows("network") && inheritedProcessCeiling.declaration.networkReadOnly && !requested.declaration.networkReadOnly)
      throw new Error("runner read-only network restriction cannot be removed from its parent scope");
  }
  processExecutionScope = requested;
  processChildDelegationCeiling = childCeiling;
  processScopeDeclared = true;
  return processExecutionScope;
}

function childExecutionEnv(env, scope) {
  if (!scope) return env;
  const { declaration } = requireExecutionScopeState(scope, "child execution scope");
  return { ...(env ?? process.env), [EXECUTION_SCOPE_ENV]: JSON.stringify(declaration) };
}

function resolveChildExecutionScope(executionScope, explicitChildScope) {
  const childScope = explicitChildScope ?? executionScope;
  if (!childScope) return null;
  if (processScopeDeclared) assertScopeSubset(childScope, processChildDelegationCeiling ?? processExecutionScope, "child execution scope");
  else if (executionScope) assertScopeSubset(childScope, executionScope, "child execution scope");
  if (inheritedProcessCeiling) assertScopeSubset(childScope, inheritedProcessCeiling, "child execution scope");
  return childScope;
}

export function validateExecutionScopeActivation(scope) {
  requireExecutionScopeState(scope, "active audit execution");
  if (inheritedProcessCeiling && !processScopeDeclared)
    throw new Error("inherited child execution scope requires a top-level declareProcessExecutionScope() before audit activation");
  if (inheritedProcessCeiling) assertScopeSubset(scope, inheritedProcessCeiling, "active audit execution scope");
}

export function getActiveExecutionScope() {
  return readActiveExecutionScope();
}

export function isGatewayNetworkCallActive() {
  return Boolean(activeGatewayNetworkCall.getStore());
}

/** Capability/telemetry boundary for SDK, TLS, MCP-vault, and other non-fetch operations. */
export function runNetworkOperation(
  label,
  operation,
  { access = "read", method, timeoutMs = 15_000, signal: parentSignal, scope, url } = {},
) {
  if (typeof label !== "string" || label.trim() === "") throw new TypeError("runNetworkOperation requires a label");
  if (typeof operation !== "function") throw new TypeError("runNetworkOperation requires an operation function");
  if (!Number.isFinite(timeoutMs) || !(timeoutMs > 0)) throw new RangeError("runNetworkOperation requires a finite positive timeoutMs");
  const executionScope = resolveExecutionScope(scope);
  requireCapability(executionScope, "network");
  if (method == null) executionScope?.assertNetworkAccess?.(access, label);
  else executionScope?.assertNetworkMethod?.(method);
  if (url !== undefined) executionScope?.assertNetworkTarget?.(url, label);
  // ⛔ A CANCELLED SCOPE STARTS NOTHING (A04, 2026-09-05). Refuse BEFORE the nested-operation
  // shortcut and before `networkCalls` is counted: a timed-out audit's abandoned continuation that
  // wakes up and calls fetch must not open a socket, and must not add a bounce to any scope's
  // telemetry. `NETWORK_ABORTED` is deliberate - `fetchWithDeadline` maps that code to its existing
  // non-throwing `{ aborted: true }` probe shape, so a cancelled call looks like every other abort
  // to a caller instead of a novel crash class.
  if (executionScopeCancelled(executionScope)) {
    const refusal = scopeCancelledError(executionScope, label);
    refusal.code = "NETWORK_ABORTED";
    return Promise.reject(refusal);
  }
  const parentOperation = activeGatewayNetworkCall.getStore();
  if (parentOperation) return operation({ signal: parentOperation.signal });

  const controller = new AbortController();
  // The scope's own cancellation is a SECOND parent signal, equal in authority to the caller's:
  // whichever fires first aborts the operation. Without this an in-flight fetch survived its
  // audit's deadline and landed later, which is the telemetry contamination the review reproduced.
  const scopeSignal = executionScope?.signal ?? null;
  let timedOut = false;
  let parentAborted = false;
  const abortFromParent = () => {
    if (parentAborted) return;
    parentAborted = true;
    recordExecutionMetric(executionScope, "aborts");
    controller.abort(parentSignal?.reason ?? scopeSignal?.reason ?? new Error(`${label} aborted`));
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });
  scopeSignal?.addEventListener?.("abort", abortFromParent, { once: true });
  if (controller.signal.aborted) {
    // ⛔ DETACH BEFORE THE EARLY RETURN. Both listeners were added two lines up, and every OTHER
    // exit from this function removes them - this one did not, so an already-cancelled scope leaked
    // one listener per call onto a signal that lives for the whole audit. `{ once: true }` does not
    // help: it bounds how often a listener FIRES, not how many accumulate on a signal that never
    // fires again. A check that keeps calling the gateway after its deadline (the exact behaviour
    // A04's cancellation contract exists to bound) therefore grows the listener list without limit
    // and eventually trips MaxListenersExceededWarning, which reads as a leak in the CHECK rather
    // than in the gateway that caused it.
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    scopeSignal?.removeEventListener?.("abort", abortFromParent);
    const error = controller.signal.reason instanceof Error ? controller.signal.reason : new Error(`${label} aborted`);
    error.code = "NETWORK_ABORTED";
    return Promise.reject(error);
  }
  recordExecutionMetric(executionScope, "networkCalls");
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    recordExecutionMetric(executionScope, "timeouts");
    controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let operationPromise;
  try {
    operationPromise = activeGatewayNetworkCall.run({ signal: controller.signal }, () =>
      Promise.resolve(operation({ signal: controller.signal })),
    );
  } catch (error) {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    scopeSignal?.removeEventListener?.("abort", abortFromParent);
    throw error;
  }
  const abortPromise = new Promise((_, reject) => {
    const rejectForAbort = () => {
      const error = controller.signal.reason instanceof Error ? controller.signal.reason : new Error(`${label} aborted`);
      error.code = timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ABORTED";
      reject(error);
    };
    if (controller.signal.aborted) rejectForAbort();
    else controller.signal.addEventListener("abort", rejectForAbort, { once: true });
  });
  return Promise.race([operationPromise, abortPromise])
    .catch((error) => {
      if (controller.signal.aborted && error instanceof Error) error.code = timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ABORTED";
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abortFromParent);
      // The scope's signal outlives this one operation (it is the whole check's), so an unremoved
      // listener here accumulates one entry per network call for the life of the audit.
      scopeSignal?.removeEventListener?.("abort", abortFromParent);
    });
}

/** Canonical AWS SDK v3 send seam; requestOptions carries abortSignal and other SDK options. */
export function awsSdkNetworkCall(client, command, { requestOptions, access = "read", timeoutMs = 15_000, signal, scope, label } = {}) {
  if (!client || typeof client.send !== "function") throw new TypeError("awsSdkNetworkCall requires an AWS SDK client");
  const operationLabel = label || command?.constructor?.name || "AWS SDK operation";
  return runNetworkOperation(
    operationLabel,
    ({ signal: operationSignal }) => client.send(command, { ...requestOptions, abortSignal: operationSignal }),
    { access, timeoutMs, signal, scope },
  );
}

/**
 * 2026-08-14 (SSRF preflight reach gap #2): a raw `{ host, port }` connect-options bag is not a URL
 * string, so it never reached `assertNetworkTargetAllowed` - `runNetworkOperation` only preflights
 * when handed an explicit `url`, and `openNetworkConnection` below used to forward none, leaving a
 * socket to 169.254.169.254 free to open while the identical target through `fetchWithDeadline`
 * threw NETWORK_TARGET_BLOCKED. Synthesize a scheme-agnostic URL carrying just the hostname/port so
 * the one preflight in `assertNetworkTargetAllowed` covers this seam exactly as it covers fetch.
 */
function deriveNetworkConnectionTarget({ host, port } = {}) {
  if (typeof host !== "string" || host.trim() === "") return undefined;
  const normalizedHost = normalizeNetworkTargetHost(host);
  const bracketedHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  const portSuffix = Number.isFinite(port) ? `:${port}` : "";
  return `tcp://${bracketedHost}${portSuffix}`;
}

/** Canonical socket-connect seam for node:tls/net and injected equivalents. `options` is the
 *  connect-options bag handed to `connect` unchanged; pass an explicit `url` to override the
 *  target derived from `options.host`/`options.port` (see `deriveNetworkConnectionTarget`). */
export function openNetworkConnection(
  label,
  connect,
  options,
  { access = "read", timeoutMs = 10_000, signal, connectedEvent = "connect", scope, url } = {},
) {
  if (typeof connect !== "function") throw new TypeError("openNetworkConnection requires a connect function");
  const target = url ?? deriveNetworkConnectionTarget(options);
  return runNetworkOperation(
    label,
    ({ signal: operationSignal }) =>
      new Promise((resolve, reject) => {
        let socket;
        const cleanup = () => {
          operationSignal.removeEventListener?.("abort", onAbort);
          socket?.removeListener?.(connectedEvent, onConnected);
          socket?.removeListener?.("error", onError);
        };
        const onConnected = () => {
          cleanup();
          resolve(socket);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          cleanup();
          socket?.destroy?.(operationSignal.reason);
          reject(operationSignal.reason ?? new Error(`${label} aborted`));
        };
        try {
          socket = connect({ ...options, signal: operationSignal });
          socket.once?.(connectedEvent, onConnected);
          socket.once?.("error", onError);
          operationSignal.addEventListener?.("abort", onAbort, { once: true });
          if (operationSignal.aborted) onAbort();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }),
    { access, timeoutMs, signal, scope, url: target },
  );
}

/** `https.request`-shaped options -> the URL the preflight judges, same job as
 *  `deriveNetworkConnectionTarget` for the socket seam. */
function deriveHttpRequestTarget({ protocol, host, hostname, port, path: requestPath } = {}) {
  const target = typeof hostname === "string" && hostname.trim() ? hostname : host;
  if (typeof target !== "string" || target.trim() === "") return undefined;
  const scheme = typeof protocol === "string" && protocol.trim() ? protocol.replace(/:$/, "") : "https";
  const normalizedHost = normalizeNetworkTargetHost(target);
  const bracketedHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  const portSuffix = Number.isFinite(port) ? `:${port}` : "";
  return `${scheme}://${bracketedHost}${portSuffix}${typeof requestPath === "string" ? requestPath : ""}`;
}

/**
 * Canonical seam for an HTTP(S) request the caller must DRIVE ITSELF - the shape `fetchWithDeadline`
 * cannot serve.
 *
 * ⛔ WHY IT EXISTS (2026-09-20). `fetchWithDeadline` is the right answer for "get me this URL", and
 * every caller that only wants a body should keep using it. It cannot answer two questions a
 * transport probe is FOR: the per-phase timings (`lookup` / `connect` / `secureConnect`, read off the
 * socket) and the certificate the edge presented (`res.socket.getPeerCertificate()`). `fetch` exposes
 * neither in Node, so the atlas walker reached for `https.request` directly and was the last
 * execution-gateway bypass in the corpus - capability, target preflight, deadline, abort and
 * telemetry all skipped, on a tool that walks the whole fleet's public edge.
 *
 * ⛔ THE REQUEST FUNCTION IS INJECTED, exactly as `openNetworkConnection` takes `connect`, and that is
 * deliberate rather than stylistic: a caller passes the REFERENCE `https.request`, never the call
 * `https.request(...)`, so the raw primitive is invoked here - inside the one file the enforcement
 * check excludes by design - and the call site keeps no ungoverned socket of its own.
 *
 * `onRequest` hands the ClientRequest back the instant it exists, because timing listeners have to be
 * attached before the socket is assigned; the returned promise settles with the response.
 */
export function httpRequestNetworkCall(
  label,
  request,
  options,
  { access = "read", timeoutMs = 15_000, signal, scope, url, onRequest } = {},
) {
  if (typeof request !== "function") throw new TypeError("httpRequestNetworkCall requires a request function");
  const target = url ?? deriveHttpRequestTarget(options);
  return runNetworkOperation(
    label,
    ({ signal: operationSignal }) =>
      new Promise((resolve, reject) => {
        let req;
        const cleanup = () => operationSignal.removeEventListener?.("abort", onAbort);
        const onAbort = () => {
          cleanup();
          req?.destroy?.(operationSignal.reason);
          reject(operationSignal.reason ?? new Error(`${label} aborted`));
        };
        try {
          req = request(options, (res) => {
            cleanup();
            resolve(res);
          });
          req.once?.("error", (error) => {
            cleanup();
            reject(error);
          });
          operationSignal.addEventListener?.("abort", onAbort, { once: true });
          if (operationSignal.aborted) onAbort();
          // AFTER the listeners above, so a caller's own handler never races the gateway's abort
          // path, and BEFORE `end()` is the caller's business - it still owns the request body.
          onRequest?.(req);
        } catch (error) {
          cleanup();
          reject(error);
        }
      }),
    { access, method: options?.method ?? "GET", timeoutMs, signal, scope, url: target },
  );
}

/** Canonical MCP-vault operation seam. AWS Query POST reads pass access:"read" explicitly. */
export function vaultNetworkCall(vault, request, { access = "read", timeoutMs = 30_000, signal, scope } = {}) {
  if (!vault || typeof vault.awsCall !== "function") throw new TypeError("vaultNetworkCall requires a vault awsCall handle");
  // `runNetworkOperation` races the operation against its own timeout-derived AbortController and
  // hands that controller's signal to `operation({ signal })` - but the previous callback here was
  // a zero-parameter arrow (`() => vault.awsCall(request)`), so that signal was silently dropped at
  // this exact seam. On a timeout the CALLER saw a rejection, but nothing ever told the real AWS
  // call to stop: it kept running, uncancelled, in the background. Forward the signal through so a
  // vault implementation that honors it (fetch-based clients accept `{ signal }`) can actually abort.
  return runNetworkOperation("vault awsCall", ({ signal: operationSignal }) => vault.awsCall(request, { signal: operationSignal }), {
    access,
    timeoutMs,
    signal,
    scope,
  });
}

/** Canonical bounded command seam for CDP and other string-command tool clients. */
export function toolNetworkCall(tool, command, params, { access = "read", timeoutMs = 15_000, signal, scope } = {}) {
  if (!tool || typeof tool.send !== "function") throw new TypeError("toolNetworkCall requires a tool send handle");
  const label = `tool command ${String(command || "unknown")}`;
  return runNetworkOperation(label, () => tool.send(command, params), { access, timeoutMs, signal, scope });
}

function resolveExecutionScope(explicitScope) {
  if (inheritedProcessCeiling && !processScopeDeclared)
    throw new Error("inherited child execution scope requires a top-level declareProcessExecutionScope() before gateway use");
  const activeScope = getActiveExecutionScope();
  if (activeScope && explicitScope && explicitScope !== activeScope)
    throw new Error("execution scope cannot be overridden inside an active audit");
  if (activeScope) {
    requireExecutionScopeState(activeScope, "active execution scope");
    return activeScope;
  }
  const resolvedScope = explicitScope ?? processExecutionScope ?? null;
  if (resolvedScope) requireExecutionScopeState(resolvedScope);
  if (resolvedScope && processExecutionScope) assertScopeSubset(resolvedScope, processExecutionScope, "execution scope");
  return resolvedScope;
}

/**
 * Stable `error.code` for a capability REFUSAL, so a caller that degrades on failure can tell
 * the two failure kinds apart. They are not the same thing and must not share a `catch`:
 *   • ENVIRONMENT - `git` is missing, the dir is not a checkout, the command exits non-zero.
 *     Degrading (return an empty index, fall back to disk) is correct; nothing is wrong.
 *   • DENIAL - this process never declared an execution scope, so the gateway refused before
 *     the command ever ran. That is a BUG IN THE CALLER, and degrading on it silently disarms
 *     whatever the subprocess was feeding. Caught live 2026-07-28: `scripts/docs-fix-links.mjs`
 *     invoked `docs-fragile-source-links` with no scope, its `git ls-files` was refused, the
 *     bare `catch` returned an empty basename index, arm 4 disarmed itself, and the fixer
 *     printed "nothing to do" while the same check gated 4 errors under the runner.
 * Every degrade-on-failure site around this gateway must rethrow on this code.
 */
export const EXECUTION_CAPABILITY_DENIED = "EXECUTION_CAPABILITY_DENIED";

function capabilityDenied(message) {
  const error = new Error(message);
  error.code = EXECUTION_CAPABILITY_DENIED;
  return error;
}

function requireCapability(scope, capability) {
  if (!scope) throw capabilityDenied(`execution capability '${capability}' requires an active or declared execution scope`);
  const { allowed } = requireExecutionScopeState(scope);
  if (!allowed.has(capability)) throw capabilityDenied(`execution capability '${capability}' was not declared`);
}

/**
 * Replace anything secret-shaped in a subprocess's output.
 *
 * ⛔ THIS REWRITES DATA, AND A CALLER THAT CANNOT SEE THAT WILL EVENTUALLY USE THE
 * REWRITTEN VALUE AS IF IT WERE REAL. That is not hypothetical - it cost this
 * workspace weeks. Atlas's fleet scanner obtained each AWS account's credentials
 * by running `aws sts assume-role` through this gateway. An assume-role response
 * is entirely secret-shaped, so it came back as `AccessKeyId: "ASIA[REDACTED]"`,
 * every child process was handed a credential made of the word REDACTED, and the
 * failure surfaced three layers away as "No AWS credentials found for account N" -
 * which reads as a permissions problem in 26 accounts rather than one bug in one
 * function. The redaction was doing exactly its job. The gap was that it was
 * INVISIBLE: a scrubber cannot tell a log from a payload, and nothing told the
 * caller its payload had been scrubbed.
 *
 * So `runProcess`/`runProcessSync` now report `redacted: true` whenever this
 * actually replaced something. Two rules follow from the incident:
 *
 *   1. NEVER route a secret through a channel that is being scrubbed. Take the
 *      credential in-process (an SDK call) so it never becomes subprocess output.
 *   2. If you must parse a subprocess's output into something load-bearing,
 *      check `redacted` and fail LOUDLY rather than consuming a rewritten value.
 */
export function redactExecutionText(value, redactions = []) {
  let text = String(value ?? "");
  for (const secret of redactions) if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join(REDACTED);
  for (const pattern of DEFAULT_SECRET_PATTERNS)
    text = text.replace(pattern, (_match, prefix) => (prefix ? `${prefix}${REDACTED}` : REDACTED));
  return text;
}

export function truncateExecutionTail(value, cap) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  const marker = "[truncated]\n";
  return limit <= marker.length ? marker.slice(0, limit) : marker + text.slice(-(limit - marker.length));
}

/**
 * The head-preserving counterpart to `truncateExecutionTail` - keeps the FRONT of `value` and drops
 * the end, for callers that enumerate an ordered list (e.g. `git diff --name-only -z`) where the
 * earliest entries must survive a cap. Tail-truncation is the right default for free-form process
 * output (the end usually holds the final result/error); it is the wrong choice for an enumeration,
 * where it silently drops the first N entries instead of the last, which incremental change
 * selection cannot tell apart from "those paths never changed".
 */
export function truncateExecutionHead(value, cap) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  const marker = "\n[truncated]";
  return limit <= marker.length ? marker.slice(0, limit) : text.slice(0, limit - marker.length) + marker;
}

function appendExecutionStreamTail(current, chunk, cap, redactions) {
  const explicitSecretLength = redactions.reduce(
    (longest, secret) => (typeof secret === "string" ? Math.max(longest, secret.length) : longest),
    0,
  );
  const lookbehind = Math.max(STREAM_REDACTION_LOOKBEHIND, explicitSecretLength);
  const bufferLimit = Math.min(Number.MAX_SAFE_INTEGER, cap + lookbehind);
  const next = `${current}${String(chunk ?? "")}`;
  return { raw: next.length > bufferLimit ? next.slice(-bufferLimit) : next, droppedRaw: next.length > bufferLimit };
}

function finalizeExecutionStream(raw, cap, redactions, rawDropped) {
  // If bounded retention sliced through a token whose identifying prefix is now
  // outside the buffer, conservatively redact the leading token fragment. This
  // keeps arbitrarily long default-pattern credentials from leaking their tail.
  const boundarySafeRaw = rawDropped ? raw.replace(/^[A-Za-z0-9._~+/=-]+/, REDACTED) : raw;
  const redacted = redactExecutionText(boundarySafeRaw, redactions);
  return {
    text: truncateExecutionTail(rawDropped ? `[truncated]\n${redacted}` : redacted, cap),
    truncated: rawDropped || redacted.length > cap,
    redacted: redacted !== boundarySafeRaw,
  };
}

function executionError(error, redactions) {
  return redactExecutionText(error?.message || error || "execution failed", redactions);
}

/** Async argv execution: bounded/redacted streams plus deadline and whole-tree cleanup. */
export function runProcess(
  command,
  args = [],
  {
    cwd,
    env,
    timeoutMs = 300_000,
    stdoutCap = 12_000,
    stderrCap = 4_000,
    signal,
    redactions = [],
    scope,
    childScope,
    spawnImpl = spawn,
    killTree = killProcessTree,
    killGraceMs = 5_000,
    now = Date.now,
    // ★ Win32-only passthrough (2026-08-13). `cmd.exe /c start "" "<target>"` is the standard way to
    // hand a file to its default handler on Windows, and `start`'s own quote parsing does not follow
    // the ordinary CommandLineToArgvW convention every other Win32 program uses - its empty-title
    // marker `""` must reach cmd.exe byte-for-byte, and Node's default per-argument escaping mangles
    // it. This is CreateProcess's own `bInheritHandles`-adjacent quoting knob (passed straight through
    // to Node's spawn, which passes it straight to CreateProcess): it changes how the argv is joined
    // into one command-line string, nothing about the gateway's timeout/tree-cleanup/bounded-output/
    // redaction guarantees, all of which still apply identically. Ignored on POSIX.
    windowsVerbatimArguments = false,
  } = {},
) {
  if (!Array.isArray(args)) throw new TypeError("runProcess requires argv as an array");
  if (
    !Number.isFinite(timeoutMs) ||
    !(timeoutMs > 0) ||
    !Number.isFinite(killGraceMs) ||
    !(killGraceMs > 0) ||
    !Number.isFinite(stdoutCap) ||
    !(stdoutCap >= 0) ||
    !Number.isFinite(stderrCap) ||
    !(stderrCap >= 0)
  )
    throw new RangeError("runProcess requires finite positive timeout and finite non-negative output caps");
  const executionScope = resolveExecutionScope(scope);
  requireCapability(executionScope, "subprocess");
  const delegatedChildScope = resolveChildExecutionScope(executionScope, childScope);
  // ⛔ THE SCOPE'S CANCELLATION IS A SECOND ABORT SOURCE, EQUAL TO THE CALLER'S `signal` (A04,
  // 2026-09-05). It is the half that has teeth: `stop("abort")` below runs `killTree(child.pid)`,
  // so an abandoned check's still-running child TREE actually dies at its audit's deadline instead
  // of outliving the run that owns it. A cancelled scope also refuses to launch at all, reported
  // through the existing `aborted: true` result shape rather than a new failure class.
  const scopeSignal = executionScope?.signal ?? null;
  return new Promise((resolve) => {
    const startedAt = now();
    let child,
      settled = false,
      timedOut = false,
      aborted = false,
      stdout = "",
      stderr = "",
      stdoutTruncated = false,
      stderrTruncated = false,
      timer = null,
      killGraceTimer = null,
      stopping = false;
    const onAbort = () => stop("abort");
    const finish = ({ exitCode = -1, processSignal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      signal?.removeEventListener?.("abort", onAbort);
      scopeSignal?.removeEventListener?.("abort", onAbort);
      const finalizedStdout = finalizeExecutionStream(stdout, stdoutCap, redactions, stdoutTruncated);
      const finalizedStderr = finalizeExecutionStream(stderr, stderrCap, redactions, stderrTruncated);
      const terminalError =
        error ??
        (timedOut ? new Error(`process timed out after ${timeoutMs}ms`) : aborted ? new Error("process execution was aborted") : null);
      resolve({
        exitCode: timedOut || aborted ? -1 : exitCode,
        signal: processSignal,
        stdout: finalizedStdout.text,
        stderr: finalizedStderr.text,
        timedOut,
        aborted,
        error: terminalError ? executionError(terminalError, redactions) : null,
        // ⛔ TRUE means this output was REWRITTEN before you got it. Read the doc on
        // redactExecutionText for why a caller has to be able to see that.
        redacted: finalizedStdout.redacted || finalizedStderr.redacted,
        durationMs: Math.max(0, now() - startedAt),
      });
      if (finalizedStdout.truncated) recordExecutionMetric(executionScope, "stdoutTruncations");
      if (finalizedStderr.truncated) recordExecutionMetric(executionScope, "stderrTruncations");
    };
    const stop = (reason) => {
      if (!settled && !stopping) {
        stopping = true;
        if (reason === "timeout") timedOut = true;
        if (reason === "abort") aborted = true;
        if (reason === "timeout") recordExecutionMetric(executionScope, "timeouts");
        if (reason === "abort") recordExecutionMetric(executionScope, "aborts");
        try {
          killTree(child?.pid);
        } catch (error) {
          finish({ error: new Error(`process ${reason} tree cleanup failed: ${executionError(error, redactions)}`, { cause: error }) });
          return;
        }
        if (!settled)
          killGraceTimer = setTimeout(
            () => finish({ error: new Error(`process did not close within ${killGraceMs}ms after ${reason} cleanup`) }),
            killGraceMs,
          );
      }
    };
    if (signal?.aborted || scopeSignal?.aborted) {
      aborted = true;
      recordExecutionMetric(executionScope, "aborts");
      finish({
        error:
          scopeSignal?.aborted && !signal?.aborted
            ? scopeCancelledError(executionScope, command)
            : new Error("process execution aborted before launch"),
      });
      return;
    }
    // ⛔ COUNTED HERE, NOT AT THE TOP OF THE FUNCTION, because a call the gateway REFUSES has not
    // run a subprocess. The counter sat above the promise until 2026-09-06, so every spawn declined
    // by an already-cancelled scope or caller signal still incremented `subprocesses` - and that
    // metric is not decoration: it is what `check-memory-budget` and the runner's telemetry judge a
    // check's resource behaviour by, and what an operator reads to decide whether a check is doing
    // more work than it declares. A cancelled audit would therefore be recorded as having spawned
    // exactly the processes it was stopped from spawning, which is the same class of untruth as an
    // abandoned check's own timeout being reported as work done. `aborts` is counted on the refusal
    // path above, so a refused call is still visible - as the refusal it actually was.
    recordExecutionMetric(executionScope, "subprocesses");
    noteSpawn();
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: childExecutionEnv(env, delegatedChildScope),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
      });
    } catch (error) {
      finish({ error });
      return;
    }
    if (timeoutMs > 0) timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    scopeSignal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout?.on?.("data", (chunk) => {
      const next = appendExecutionStreamTail(stdout, chunk, stdoutCap, redactions);
      if (next.droppedRaw) stdoutTruncated = true;
      stdout = next.raw;
    });
    child.stderr?.on?.("data", (chunk) => {
      const next = appendExecutionStreamTail(stderr, chunk, stderrCap, redactions);
      if (next.droppedRaw) stderrTruncated = true;
      stderr = next.raw;
    });
    child.on?.("close", (exitCode, processSignal) => finish({ exitCode, processSignal }));
    child.on?.("error", (error) => finish({ error }));
  });
}

/**
 * Explicit owner for a long-lived child. Audits must attach every managed child and call
 * cleanup() in their finally path; the gateway owns the tree-kill primitive and telemetry.
 */
export function createManagedProcessOwner({ scope, killTree = killProcessTree, maxLifetimeMs, cleanupGraceMs = 5_000 } = {}) {
  if (!Number.isFinite(maxLifetimeMs) || !(maxLifetimeMs > 0))
    throw new RangeError("managed process owner requires a finite positive maxLifetimeMs");
  if (!Number.isFinite(cleanupGraceMs) || !(cleanupGraceMs > 0))
    throw new RangeError("managed process owner requires a finite positive cleanupGraceMs");
  const executionScope = resolveExecutionScope(scope);
  let child = null;
  let settled = false;
  let lifetimeTimer = null;
  let cleanupPromise = null;
  let settleCleanup = null;
  let rejectCleanup = null;
  const clearLifetimeTimer = () => {
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    lifetimeTimer = null;
  };
  const settle = (kind) => {
    if (settled) return;
    settled = true;
    clearLifetimeTimer();
    if (!cleanupPromise) return;
    if (kind === "error") rejectCleanup?.(new Error("managed process emitted an error during cleanup"));
    else settleCleanup?.(true);
  };
  const failAfterGrace = () => {
    if (settled) return;
    settled = true;
    clearLifetimeTimer();
    rejectCleanup?.(new Error(`managed process did not close within ${cleanupGraceMs}ms after cleanup`));
  };
  return {
    adopt(nextChild) {
      if (!nextChild || typeof nextChild !== "object") throw new TypeError("managed process owner requires a child process");
      if (child && !settled) throw new Error("managed process owner already owns a live child");
      child = nextChild;
      settled = false;
      nextChild.once?.("close", () => settle("close"));
      nextChild.once?.("error", () => settle("error"));
      lifetimeTimer = setTimeout(() => {
        this.cleanup().catch((error) => {
          // A leaked managed child is a framework failure, never a warning that a runner can ignore.
          queueMicrotask(() => {
            throw error;
          });
        });
      }, maxLifetimeMs);
      return nextChild;
    },
    async cleanup() {
      if (!child || settled) return false;
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = new Promise((resolve, reject) => {
        settleCleanup = resolve;
        rejectCleanup = reject;
      });
      try {
        killTree(child.pid);
      } catch (error) {
        settled = true;
        clearLifetimeTimer();
        rejectCleanup(new Error(`managed process cleanup failed: ${executionError(error, [])}`));
        return cleanupPromise;
      }
      const graceTimer = setTimeout(failAfterGrace, cleanupGraceMs);
      try {
        const verified = await cleanupPromise;
        recordExecutionMetric(executionScope, "managedProcessCleanups");
        return verified;
      } finally {
        clearTimeout(graceTimer);
      }
    },
    get active() {
      return Boolean(child && !settled);
    },
  };
}

/**
 * Explicit owner for a disposable filesystem workspace. Creation is restricted to a
 * canonical OS-temp descendant; cleanup records telemetry only after verified absence.
 */
export function createDisposableWorkspaceOwner({
  prefix = "arkitect-",
  scope,
  tempRoot = tmpdir(),
  mkdtempImpl = mkdtempSync,
  realpathImpl = realpathSync,
  removeImpl = (target) => rmSync(target, { recursive: true, force: false, maxRetries: 3 }),
  existsImpl = existsSync,
} = {}) {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix === "." || prefix === ".." || basename(prefix) !== prefix)
    throw new TypeError("disposable workspace prefix must be a non-empty filename prefix");
  const executionScope = resolveExecutionScope(scope);
  const canonicalOsTempRoot = realpathImpl(resolve(tmpdir()));
  const canonicalTempRoot = realpathImpl(resolve(tempRoot));
  const configuredRootPath = relative(canonicalOsTempRoot, canonicalTempRoot);
  if (
    configuredRootPath !== "" &&
    (configuredRootPath === ".." || configuredRootPath.startsWith(`..${sep}`) || isAbsolute(configuredRootPath))
  )
    throw new Error(`disposable workspace temp root escaped the OS temp directory: ${canonicalTempRoot}`);
  const createdPath = mkdtempImpl(join(canonicalTempRoot, prefix));
  const workspacePath = realpathImpl(createdPath);
  const childPath = relative(canonicalTempRoot, workspacePath);
  if (childPath === "" || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath))
    throw new Error(`disposable workspace escaped the canonical temp root: ${workspacePath}`);
  let cleaned = false;
  return {
    path: workspacePath,
    cleanup() {
      if (cleaned) return false;
      try {
        removeImpl(workspacePath);
      } catch (error) {
        throw new Error(`disposable workspace cleanup failed: ${executionError(error, [])}`, { cause: error });
      }
      let remains;
      try {
        remains = existsImpl(workspacePath);
      } catch (error) {
        throw new Error(`disposable workspace cleanup verification failed: ${executionError(error, [])}`, { cause: error });
      }
      if (remains) throw new Error(`disposable workspace cleanup left ${workspacePath} on disk`);
      cleaned = true;
      recordExecutionMetric(executionScope, "workspaceCleanups");
      return true;
    },
    get active() {
      return !cleaned;
    },
  };
}

/** Run work in an owned disposable workspace and verify cleanup even when work faults. */
export async function withDisposableWorkspace(work, options = {}) {
  if (typeof work !== "function") throw new TypeError("withDisposableWorkspace requires a function");
  const owner = createDisposableWorkspaceOwner(options);
  try {
    return await work(owner.path, owner);
  } finally {
    owner.cleanup();
  }
}

/**
 * Managed child for audit runners that must retain a live process handle (for example a
 * temporary dev server). Every caller must provide explicit owner cleanup.
 */
export function spawnProcess(
  command,
  args = [],
  {
    cwd,
    env,
    stdio = ["ignore", "pipe", "pipe"],
    detached = process.platform !== "win32",
    scope,
    childScope,
    managed,
    spawnImpl = spawn,
  } = {},
) {
  if (!Array.isArray(args)) throw new TypeError("spawnProcess requires argv as an array");
  const executionScope = resolveExecutionScope(scope);
  requireCapability(executionScope, "subprocess");
  // Unlike runProcess there is no result shape to report an abort through - spawnProcess hands back
  // a live child handle - so a cancelled audit is refused by throwing (A04, 2026-09-05). Adopting a
  // long-lived child into a run that is already over is how a dev server outlives its audit.
  if (executionScopeCancelled(executionScope)) throw scopeCancelledError(executionScope, `spawn ${command}`);
  const delegatedChildScope = resolveChildExecutionScope(executionScope, childScope);
  if (!managed || typeof managed.adopt !== "function" || typeof managed.cleanup !== "function")
    throw new Error("managed subprocesses require explicit ownership with adopt() and cleanup()");
  recordExecutionMetric(executionScope, "subprocesses");
  noteSpawn();
  const child = spawnImpl(command, args, {
    cwd,
    env: childExecutionEnv(env, delegatedChildScope),
    stdio,
    detached,
    shell: false,
    windowsHide: true,
  });
  return managed ? managed.adopt(child) : child;
}

/**
 * Legacy synchronous bridge. New execution must use runProcess; this keeps existing read-only
 * probes safe and centralized.
 *
 * `access` gates retry-on-timeout (see the doc comment above `SUBPROCESS_TIMEOUT_RETRY_ATTEMPTS`):
 * pass `access: "read"` for a deterministic, side-effect-free command to get automatic retry on a
 * timeout; every other/undeclared access runs exactly once, unchanged from before this existed.
 */
export function runProcessSync(
  command,
  args = [],
  {
    cwd,
    env,
    timeoutMs = 30_000,
    stdoutCap,
    stderrCap,
    maxBuffer,
    input,
    redactions = [],
    encoding = "utf8",
    access,
    scope,
    childScope,
    spawnSyncImpl = spawnSync,
    killTree = killProcessTree,
    // "tail" (default, unchanged) preserves the END of output when it exceeds its cap - right for
    // free-form process output. Pass "head" for an ordered enumeration (e.g. `git diff --name-only`)
    // where the caller needs the FIRST entries, not an arbitrary suffix of the last ones.
    stdoutTruncateFrom = "tail",
    // Win32-only, the same passthrough `runProcess` documents above: `cmd.exe /d /s /c "<line>"`
    // (cost-explorer-cache's route to an `aws.cmd` shim) needs its one quoted line to reach cmd.exe
    // byte-for-byte. Ignored on POSIX.
    windowsVerbatimArguments = false,
  } = {},
) {
  if (!Array.isArray(args)) throw new TypeError("runProcessSync requires argv as an array");
  if (!Number.isFinite(timeoutMs) || !(timeoutMs > 0)) throw new RangeError("runProcessSync requires a finite positive timeoutMs");
  if (stdoutTruncateFrom !== "tail" && stdoutTruncateFrom !== "head")
    throw new TypeError('runProcessSync stdoutTruncateFrom must be "tail" or "head"');
  // ⛔ RAW MODE (`encoding: null`) IS FOR BYTE-FRAMED PROTOCOLS ONLY, e.g. `git cat-file --batch`,
  // whose per-object boundaries are declared in exact BYTES. redactExecutionText/truncateExecutionTail
  // operate on decoded strings; running them over such a stream shifts every boundary after the
  // first redacted match and silently corrupts every object read after it (proven 2026-08-04: a
  // mock JWT/AWS-key-shaped fixture string inside one scanned blob desynced every subsequent blob
  // in the batch). Raw mode skips that pipeline - native `maxBuffer` below is still its bounded-output
  // guarantee, but it carries NO secret-redaction guarantee, so its output must never reach a
  // report/log; it is for internal parsing only. `encoding` must be `"utf8"` (default) or `null`.
  const raw = encoding === null;
  if (!raw && encoding !== "utf8") throw new TypeError('runProcessSync encoding must be "utf8" or null (raw Buffer)');
  const cap = maxBuffer === undefined ? 4 * 1024 * 1024 : maxBuffer;
  const stdoutLimit = stdoutCap ?? cap;
  const stderrLimit = stderrCap ?? cap;
  if (
    !Number.isFinite(cap) ||
    !(cap >= 0) ||
    !Number.isFinite(stdoutLimit) ||
    !(stdoutLimit >= 0) ||
    !Number.isFinite(stderrLimit) ||
    !(stderrLimit >= 0)
  )
    throw new RangeError("runProcessSync requires finite non-negative output caps");
  const executionScope = resolveExecutionScope(scope);
  requireCapability(executionScope, "subprocess");
  // ⛔ REFUSING TO START IS THE WHOLE GUARANTEE A SYNC SEAM CAN OFFER (A04, 2026-09-05). `spawnSync`
  // blocks the thread, so nothing - not the cancellation signal, not the runner - can interrupt an
  // attempt already under way; its own `timeout` remains the only bound on that. What this stops is
  // the shape the review names: an abandoned check's continuation waking up after its audit's
  // deadline and shelling out again on a run whose row is already published. One check before the
  // retry loop is enough and not a shortcut: the loop's backoff is `sleepSync`, so the event loop
  // cannot run between attempts and the cancellation state cannot change once we are past here.
  if (executionScopeCancelled(executionScope)) throw scopeCancelledError(executionScope, `run ${command}`);
  const delegatedChildScope = resolveChildExecutionScope(executionScope, childScope);

  const attemptOnce = () => {
    recordExecutionMetric(executionScope, "subprocesses");
    noteSpawn();
    let result;
    try {
      result = spawnSyncImpl(command, args, {
        cwd,
        env: childExecutionEnv(env, delegatedChildScope),
        input,
        // Omitting `encoding` makes spawnSync return raw Buffers (Node's native "no encoding" default).
        encoding: raw ? undefined : "utf8",
        timeout: timeoutMs,
        maxBuffer: Math.max(stdoutLimit, stderrLimit),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: process.platform !== "win32",
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (thrown) {
      let error = new Error(executionError(thrown, redactions), { cause: thrown });
      if (thrown?.code) error.code = thrown.code;
      const timedOut = thrown?.code === "ETIMEDOUT";
      if (timedOut) {
        recordExecutionMetric(executionScope, "timeouts");
        try {
          killTree(thrown?.pid);
        } catch (cleanupError) {
          error = new Error(`timed-out process tree cleanup failed: ${executionError(cleanupError, redactions)}`, { cause: cleanupError });
          error.code = "PROCESS_CLEANUP_FAILED";
        }
      }
      return {
        exitCode: -1,
        status: -1,
        signal: null,
        stdout: raw ? Buffer.alloc(0) : "",
        stderr: raw ? Buffer.alloc(0) : "",
        timedOut,
        redacted: false,
        error,
      };
    }
    let error = result.error ? new Error(executionError(result.error, redactions), { cause: result.error }) : null;
    if (error && result.error?.code) error.code = result.error.code;
    let exitCode = result.status ?? (error ? -1 : 0);
    const timedOut = result.error?.code === "ETIMEDOUT";
    if (timedOut) {
      recordExecutionMetric(executionScope, "timeouts");
      try {
        killTree(result.pid);
      } catch (cleanupError) {
        error = new Error(`timed-out process tree cleanup failed: ${executionError(cleanupError, redactions)}`, { cause: cleanupError });
        error.code = "PROCESS_CLEANUP_FAILED";
      }
      error ??= new Error(`process timed out after ${timeoutMs}ms`);
      exitCode = -1;
    }
    if (raw) {
      return {
        exitCode,
        status: exitCode,
        signal: result.signal ?? null,
        stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
        stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
        timedOut,
        // null, never false: the raw path does not redact at all, so "nothing was
        // redacted" would read as a clean bill this path cannot issue.
        redacted: null,
        error,
      };
    }
    const rawStdout = String(result.stdout ?? "");
    const rawStderr = String(result.stderr ?? "");
    const stdout = redactExecutionText(rawStdout, redactions);
    const stderr = redactExecutionText(rawStderr, redactions);
    if (stdout.length > stdoutLimit) recordExecutionMetric(executionScope, "stdoutTruncations");
    if (stderr.length > stderrLimit) recordExecutionMetric(executionScope, "stderrTruncations");
    return {
      exitCode,
      status: exitCode,
      signal: result.signal ?? null,
      stdout: stdoutTruncateFrom === "head" ? truncateExecutionHead(stdout, stdoutLimit) : truncateExecutionTail(stdout, stdoutLimit),
      stderr: truncateExecutionTail(stderr, stderrLimit),
      timedOut,
      // ⛔ TRUE means this output was REWRITTEN before you got it - see redactExecutionText.
      redacted: stdout !== rawStdout || stderr !== rawStderr,
      error,
    };
  };

  const attempts = access === "read" ? SUBPROCESS_TIMEOUT_RETRY_ATTEMPTS : 1;
  let result = attemptOnce();
  for (let attempt = 2; attempt <= attempts && result.timedOut; attempt++) {
    recordExecutionMetric(executionScope, "retriedTimeouts");
    sleepSync(SUBPROCESS_TIMEOUT_RETRY_BACKOFF_MS * (attempt - 1));
    result = attemptOnce();
  }
  return result;
}

export function runProcessSyncText(command, args, options = {}) {
  const result = runProcessSync(command, args, options);
  if (result.exitCode !== 0 || result.error) {
    const error = result.error ?? new Error(result.stderr || `${command} exited ${result.exitCode}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.status = result.exitCode;
    throw error;
  }
  return result.stdout;
}

/**
 * The identity a probe sends when its caller set none.
 *
 * ⛔ WHY THIS EXISTS (measured 2026-09-05, two checks confirmed, more latent). A fetch with NO
 * `user-agent` is refused outright by edges that run ordinary bot rules - every `*.example.com`
 * origin answered a UA-less request with a Cloudflare **403** on both GET and HEAD, so a probe
 * without one measures the bot rule instead of the thing it was written to test. It cost
 * `spa-index-cache-control` 30 false `cache-unreachable` warnings (the live edge was serving exactly
 * the `no-cache` the check wants) and put `sitemap-live-lockstep` at `no-data` claiming every target
 * was unreachable. Both read as infrastructure findings and neither was one.
 *
 * ⛔ AND THE VALUE MATTERS, not just its presence: `curl/8.0.1` is ALSO 403'd, while a descriptive
 * product identity is allowed. Measured the same day against example.com -
 * absent: 403 · `curl/8.0.1`: 403 · `connections-arkitect/0.9.0`: 200 · a browser string: 200.
 * So this is deliberately an HONEST product UA rather than a browser impersonation: it is allowed,
 * it says who is really calling, and it was verified to return byte-identical response headers to a
 * real Chrome UA on the surfaces this gate probes.
 *
 * A caller that sets its own `user-agent` always wins - this only fills an absence, exactly the way
 * `pinnedFetch`'s FALLBACK_USER_AGENT does for production traffic (infra/shared/ssrf-guard.ts).
 *
 * ⛔ AND IT CARRIES NO CONTACT URL, deliberately. This constant lives in the PORTABLE core, which
 * ships to foreign repositories, so a `+https://example.com` suffix would point a stranger's
 * server operator at our product about traffic that has nothing to do with it - and `corpus-isolation`
 * gates exactly that class. Nothing is lost by dropping it: the measurement above is the proof, since
 * the value verified to return 200 was the bare `connections-arkitect/0.9.0` token, never the suffixed
 * form. The edge rule keys on having a descriptive identity at all, not on whose domain it names.
 */
export const FALLBACK_PROBE_USER_AGENT = "connections-arkitect/0.9.0";

/** True when `headers` (object | array of pairs | Headers) already carries a user-agent. */
function hasUserAgentHeader(headers) {
  if (!headers) return false;
  if (typeof headers.get === "function") return headers.get("user-agent") != null;
  if (Array.isArray(headers)) return headers.some(([k]) => String(k).toLowerCase() === "user-agent");
  return Object.keys(headers).some((k) => k.toLowerCase() === "user-agent");
}

/** Return `options` with a fallback user-agent added only when the caller supplied none. */
function withFallbackUserAgent(options) {
  if (hasUserAgentHeader(options.headers)) return options;
  const headers = options.headers;
  if (headers && typeof headers.get === "function") {
    const merged = new Headers(headers);
    merged.set("user-agent", FALLBACK_PROBE_USER_AGENT);
    return { ...options, headers: merged };
  }
  if (Array.isArray(headers)) {
    return { ...options, headers: [...headers, ["user-agent", FALLBACK_PROBE_USER_AGENT]] };
  }
  return { ...options, headers: { ...(headers ?? {}), "user-agent": FALLBACK_PROBE_USER_AGENT } };
}

/** Fetch with one deadline and a redacted, non-throwing error shape for probes. */
export async function fetchWithDeadline(
  url,
  options = {},
  { timeoutMs = 15_000, fetchImpl = globalThis.fetch, redactions = [], scope } = {},
) {
  options = withFallbackUserAgent(options);
  if (!Number.isFinite(timeoutMs) || !(timeoutMs > 0)) throw new RangeError("fetchWithDeadline requires a finite positive timeout");
  const executionScope = resolveExecutionScope(scope);
  requireCapability(executionScope, "network");
  executionScope?.assertNetworkMethod?.(options.method ?? "GET");
  executionScope?.assertNetworkTarget?.(url, "fetch");
  try {
    return {
      res: await runNetworkOperation("fetch", ({ signal }) => fetchImpl(url, { ...options, signal }), {
        method: options.method ?? "GET",
        timeoutMs,
        signal: options.signal,
        scope: executionScope,
        url,
      }),
      timedOut: false,
      aborted: false,
    };
  } catch (error) {
    return {
      error: executionError(error, redactions),
      timedOut: error?.code === "NETWORK_TIMEOUT",
      aborted: error?.code === "NETWORK_ABORTED",
    };
  }
}
