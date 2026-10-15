// vendored from Connections scripts/deploy/shipped-build-stamp.mjs @ dd3d47a7ad
/**
 * shipped-build-stamp - the per-plane record of WHICH COMMIT IS LIVE, and the verdict on
 * whether the build about to ship may overwrite it.
 *
 * ⛔ WHY THIS EXISTS. On 2026-09-12 two fleet SPA pushes (`deploy-all-plane-web.mjs
 * --from-sha origin/main`) ran about two minutes apart from two sessions in the same checkout.
 * The second had resolved `origin/main` a minute BEFORE `d84dc9dd45` landed, so it was pinned
 * one commit older - and on every plane its upload landed after the first one's and overwrote
 * it. Twelve planes silently went back to a build without a fix that was already on trunk, and
 * both deploy logs were entirely green. Every guard in deploy-plane-web.mjs passed on both runs,
 * because every one of them asks a question about the LOCAL artifact (is it present, fresh,
 * complete, from a committed tree). None of them asks the bucket what it already holds. The
 * Lambda half has that question answered by `lambda_deploy_zip`'s RevisionId guard; the S3 sync
 * had no equivalent, and this is it.
 *
 * The mechanism: every deploy writes `build-stamp.json` beside index.html (no-cache, so it is
 * always the truth for that origin), and BEFORE syncing reads the stamp already there and asks
 * git how the two commits relate. Shipping a DESCENDANT of the live commit is a forward move.
 * Shipping an ANCESTOR means the bucket already holds a build that contains everything you are
 * about to upload plus more - uploading erases those commits, which is precisely the 2026-09-12
 * shape. Refuse it unless the rollback is deliberate (`--allow-rollback`).
 *
 * Pure by design - no I/O, no process.exit - so the verdict table below is testable without an
 * AWS credential or a git repo. deploy-plane-web.mjs owns the reads, the writes and the exits;
 * `isAncestor` is injected for the same reason.
 */

import { createHash } from "node:crypto";
import { normaliseRecord } from "./plane-web-build-skip.mjs";
import { isFullSha, parseStampEnvelope } from "./stamp-envelope.mjs";

/**
 * Served at `<origin>/build-stamp.json` with the same no-cache policy as index.html. It lives at
 * the dist ROOT, deliberately NOT under `assets/`: the [1/3] assets sync is immutable-cached and
 * excluded from the root sync, so a stamp under assets/ would either never be re-read by the
 * guard or be cached at the edge for a year - both of which turn it back into a decoration.
 */
export const SHIPPED_BUILD_STAMP_FILE = "build-stamp.json";

/**
 * The record one deploy leaves in the bucket. `source` says whether the build came from a
 * pinned commit ("from-sha") or the live working tree ("tree"); `dirty` is only meaningful for
 * the latter and records that uncommitted edits were in the artifact. A short or abbreviated sha
 * is refused here rather than at read time: a stamp written with `origin/main` or a 12-char
 * prefix cannot be compared by `git merge-base` reliably, and a stamp that cannot be compared is
 * the false green this file exists to end.
 */
export function buildStampRecord({
  sha,
  plane,
  source,
  dirty = false,
  at,
  assets,
  assetDigests,
  inputsDigest,
  buildInputs,
  envDigest,
  reusedFrom,
  carryAssets,
  composed,
}) {
  if (!isFullSha(sha)) {
    throw new Error(`shipped-build-stamp: sha must be the full 40-hex commit, got ${JSON.stringify(sha)}`);
  }
  if (source !== "from-sha" && source !== "tree") {
    throw new Error(`shipped-build-stamp: source must be "from-sha" or "tree", got ${JSON.stringify(source)}`);
  }
  return {
    v: 1,
    sha,
    plane: String(plane),
    source,
    dirty: Boolean(dirty),
    at: at instanceof Date ? at.toISOString() : String(at ?? new Date().toISOString()),
    // Every file under assets/ this build shipped (see `assetsToUpload`). Optional: a stamp without it
    // still reads, and the next publish simply uploads every asset, as it always did.
    ...(Array.isArray(assets) ? { assets: [...assets].sort() } : {}),
    // The bytes behind each of those names (`assetDigest`), so a file that kept its name and changed
    // its bytes is still uploaded. Optional: a stamp without it makes the next publish upload all.
    ...(isDigestMap(assetDigests) ? { assetDigests: sortedMap(assetDigests) } : {}),
    // What the build read (plane-web-build-skip.mjs): the digest of its input record and of the VITE_*
    // env it saw, and - on a publish that skipped the build - the commit whose bytes these are. The record
    // itself travels too, so a machine that never built this sha can judge the next skip from the stamp.
    ...(typeof inputsDigest === "string" && inputsDigest ? { inputsDigest } : {}),
    ...(buildInputs && typeof buildInputs === "object" ? { buildInputs: normaliseRecord(buildInputs) } : {}),
    ...(typeof envDigest === "string" && envDigest ? { envDigest } : {}),
    ...(isFullSha(reusedFrom) ? { reusedFrom } : {}),
    // Assets carried forward from the previous build, so the next deploy can carry both this build's
    // and the previous build's assets (keeping shells valid for two builds back).
    ...(Array.isArray(carryAssets) ? { carryAssets: [...carryAssets].sort() } : {}),
    // Composed builds staged under a key prefix ("explore/"): their own assets and the ones they carried, as the root's.
    ...(isComposedMap(composed) ? { composed: sortedComposed(composed) } : {}),
  };
}

/**
 * The live stamp as read back from the bucket, or `null` when what came back is not a v1 stamp
 * (empty body, non-JSON, a different version, a sha that is not 40 hex). `null` here means "no
 * usable record", and the caller treats it exactly like a bucket that has never been stamped -
 * the guard cannot compare against garbage, and refusing every deploy over a corrupt stamp would
 * make the stamp itself an outage.
 */
export function parseShippedStamp(text) {
  const parsed = parseStampEnvelope(text);
  if (!parsed) return null;
  return {
    v: 1,
    sha: parsed.sha,
    plane: typeof parsed.plane === "string" ? parsed.plane : "",
    source: parsed.source === "tree" ? "tree" : "from-sha",
    dirty: Boolean(parsed.dirty),
    at: typeof parsed.at === "string" ? parsed.at : "",
    ...(Array.isArray(parsed.assets) && parsed.assets.every((name) => typeof name === "string") ? { assets: parsed.assets } : {}),
    ...(isDigestMap(parsed.assetDigests) ? { assetDigests: parsed.assetDigests } : {}),
    ...(typeof parsed.inputsDigest === "string" && parsed.inputsDigest ? { inputsDigest: parsed.inputsDigest } : {}),
    ...(parsed.buildInputs && typeof parsed.buildInputs === "object" ? { buildInputs: parsed.buildInputs } : {}),
    ...(typeof parsed.envDigest === "string" && parsed.envDigest ? { envDigest: parsed.envDigest } : {}),
    ...(isFullSha(parsed.reusedFrom) ? { reusedFrom: parsed.reusedFrom } : {}),
    ...(Array.isArray(parsed.carryAssets) && parsed.carryAssets.every((name) => typeof name === "string")
      ? { carryAssets: parsed.carryAssets }
      : {}),
    ...(isComposedMap(parsed.composed) ? { composed: parsed.composed } : {}),
  };
}

const isNameList = (v) => Array.isArray(v) && v.every((name) => typeof name === "string");
const isComposedMap = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (entry) => entry && isNameList(entry.assets) && (entry.carryAssets === undefined || isNameList(entry.carryAssets)),
  );
const sortedComposed = (value) =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((prefix) => [prefix, { assets: [...value[prefix].assets].sort(), carryAssets: [...(value[prefix].carryAssets ?? [])].sort() }]),
  );

const isDigestMap = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((digest) => typeof digest === "string");
const sortedMap = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** One asset's bytes, as the stamp records them: the first 16 hex of their sha256. */
export function assetDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * The asset files a publish must upload: those the LIVE build does not already hold. the owner,
 * 2026-09-26: "If publishing the plane takes longer than 30 seconds, we got something screwed up" -
 * every publish re-uploaded every asset (main: 1,252 files, ~13 s) though most were already there.
 *
 * Safe because an asset's NAME is its content hash (Vite), so a name already in the bucket is these
 * bytes, and because the live stamp is written only after its own uploads succeeded and read straight
 * from the bucket. The bucket keeps every old asset on purpose, so nothing it lists has gone. A live
 * stamp with no list (an older one, or none) means upload everything - the behaviour before this.
 * Names are paths relative to assets/, with forward slashes.
 *
 * ⛔ A NAME IS ITS CONTENT ONLY FOR WHAT VITE EMITS. A file copied from a plane's public/assets/ keeps
 * the name its author gave it, so on name alone a re-made image under its old name was never
 * uploaded: on 2026-10-01 the events front door had 20 of its 27 images stale this way (every
 * poster, two proof screens, the host console) for days, every deploy reporting success. So when the
 * caller passes `localDigests` (name -> `assetDigest`), a live name is skipped only while its bytes
 * match the live stamp's `assetDigests`, and a live stamp with no digests (every stamp before this)
 * uploads everything once. Without `localDigests` the old name-only rule stands.
 */
export function assetsToUpload(localAssets, liveStamp, localDigests) {
  const live = Array.isArray(liveStamp?.assets) ? new Set(liveStamp.assets) : null;
  if (!live) return [...localAssets];
  if (!localDigests) return localAssets.filter((name) => !live.has(name));
  const liveDigests = liveStamp.assetDigests;
  if (!liveDigests) return [...localAssets];
  return localAssets.filter((name) => !live.has(name) || liveDigests[name] !== localDigests[name]);
}

/**
 * The live names whose bytes changed. They are uploaded, but every file under assets/ is served
 * immutable for a year and a publish no longer invalidates CloudFront, so a browser or an edge that
 * cached the old bytes keeps them: the deploy names these so their author gives each a new name.
 */
export function assetsReplacedInPlace(localAssets, liveStamp, localDigests) {
  const liveDigests = liveStamp?.assetDigests;
  if (!liveDigests || !localDigests) return [];
  return localAssets.filter((name) => typeof liveDigests[name] === "string" && liveDigests[name] !== localDigests[name]);
}

/**
 * How `shipping` relates to the commit already live, as one of six verdicts:
 *
 *   "first"    - nothing is live yet (`live === null`). Proceed.
 *   "same"     - identical commits. Proceed (a re-ship of the same build is idempotent).
 *   "forward"  - live is an ancestor of shipping. Proceed: this is what a deploy is for.
 *   "rollback" - shipping is an ancestor of live: the bucket already holds a build that CONTAINS
 *                what you are shipping. Uploading erases every commit in shipping..live. This is
 *                the 2026-09-12 shape. REFUSE unless --allow-rollback.
 *   "diverged" - neither contains the other (a build from a side branch, or a rewritten trunk).
 *                REFUSE unless --allow-rollback: which side "wins" is not a question a script
 *                can answer, and it is never what a routine fleet push intends.
 *   "unknown"  - `isAncestor` returned null or threw for the live sha: local git does not know
 *                that commit. After the caller has fetched origin once, that means the live build
 *                came from an UNPUSHED tree; proceed with a loud warning, because refusing would
 *                let an unpushed build block trunk from ever replacing it.
 *
 * `isAncestor(maybeAncestor, descendant)` is injected: true/false, or null when a sha is unknown
 * to git. Only "first", "same" and "forward" may proceed silently.
 */
export function judgeOverwrite({ shipping, live, isAncestor }) {
  const verdict = (() => {
    if (live === null || live === undefined) return "first";
    if (live === shipping) return "same";
    let liveIsAncestor;
    let shippingIsAncestor;
    try {
      liveIsAncestor = isAncestor(live, shipping);
      if (liveIsAncestor === null) return "unknown";
      if (liveIsAncestor === true) return "forward";
      shippingIsAncestor = isAncestor(shipping, live);
      if (shippingIsAncestor === null) return "unknown";
      if (shippingIsAncestor === true) return "rollback";
    } catch {
      return "unknown";
    }
    return "diverged";
  })();
  return { verdict, shipping, live: live ?? null };
}
