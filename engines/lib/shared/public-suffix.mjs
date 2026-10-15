// vendored from Connections infra/shared/net/public-suffix.mjs @ dd3d47a7ad
// public-suffix - does this name belong to ONE site's owner, or does it hold every stranger's site under it?
//
// A public suffix names nobody's website and everybody's under it: `co.uk` holds `foo.co.uk` and `bar.co.uk`,
// `github.io` holds `someone.github.io`, `s3.amazonaws.com` holds every stranger's bucket. Every caller must answer
// it the same way, and they cannot all import the same kind of file:
//   - registrable-domain.ts (TypeScript, web and lambda) reads the two-label list for its eTLD+1 split;
//   - the companies plane's "my websites" list (services/companies/.../owned-sites.ts) refuses a suffix as a member's
//     own site, because the SUE planner hands the owners' rules to every site under a listed name;
//   - the SUE planner (tools/sue/lib/site-owner.mjs) asks the same question of that list, and is plain node with no
//     .ts imports.
// So the lists live here, in a dependency-free `.mjs` all of them can import. Keep them in this one file.
//
// NOT the whole public suffix list: the common ones, the same trade registrable-domain.ts already made. An unlisted
// suffix (some obscure ccTLD, a small host) reads as a site name.

/**
 * Two-label public suffixes common enough to matter. A name under one is somebody's own site (`foo.co.uk`), never a
 * sibling of every other name under it.
 */
export const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.nz",
  "co.za",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.mx",
  "co.in",
  "co.id",
  "com.sg",
  "com.hk",
  "co.kr",
]);

/**
 * Shared hosting names: every name under one is a different person's site (`someone.github.io`, `shop.vercel.app`),
 * and the name itself is the host's, never a member's. AWS's own endpoint names are matched by rule below, not listed.
 */
export const SHARED_HOSTING_SUFFIXES = new Set([
  "pages.dev",
  "workers.dev",
  "r2.dev",
  "trycloudflare.com",
  "vercel.app",
  "netlify.app",
  "github.io",
  "gitlab.io",
  "bitbucket.io",
  "codeberg.page",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "storage.googleapis.com",
  "googleusercontent.com",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "up.railway.app",
  "deno.dev",
  "glitch.me",
  "surge.sh",
  "azurewebsites.net",
  "azurestaticapps.net",
  "azureedge.net",
  "blob.core.windows.net",
  "web.core.windows.net",
  "cloudfront.net",
  "amplifyapp.com",
  "awsapprunner.com",
  "digitaloceanspaces.com",
  "ondigitalocean.app",
  "myshopify.com",
  "wixsite.com",
  "squarespace.com",
  "webflow.io",
  "framer.app",
  "framer.website",
  "carrd.co",
  "notion.site",
  "substack.com",
  "tumblr.com",
  "weebly.com",
  "blogspot.com",
  "wordpress.com",
  "neocities.org",
  "readthedocs.io",
  "gitbook.io",
  "replit.app",
  "lovable.app",
  "hf.space",
  "streamlit.app",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
]);

/** The parents AWS names its own endpoints under. */
const AWS_ENDPOINT_PARENTS = ["amazonaws.com", "elasticbeanstalk.com"];

/** A label AWS itself writes into an endpoint name: a region (`us-east-1`), or a service (`s3`, `s3-website-us-west-2`). */
const AWS_ENDPOINT_LABEL =
  /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d|s3|s3-website|s3-accesspoint|s3-external-1|dualstack|execute-api|elb|compute|compute-1|(?:s3|s3-website)-[a-z]{2}(?:-gov)?-[a-z]+-\d)$/;

/**
 * True for an AWS endpoint name (`s3.amazonaws.com`, `s3.us-west-2.amazonaws.com`, `s3-website-us-east-1.amazonaws.com`,
 * `us-east-1.elasticbeanstalk.com`) whose every label is AWS's own, so every name under it is a stranger's bucket or
 * app. A name with a label of its own (`mybucket.s3.amazonaws.com`) is one customer's site.
 */
function isAwsEndpoint(host) {
  const parent = AWS_ENDPOINT_PARENTS.find((name) => host === name || host.endsWith(`.${name}`));
  if (!parent) return false;
  const own = host === parent ? [] : host.slice(0, -(parent.length + 1)).split(".");
  return own.every((label) => AWS_ENDPOINT_LABEL.test(label));
}

/**
 * True for a name that names nobody's website but holds every stranger's under it: a top-level name (`com`), a listed
 * two-label suffix (`co.uk`), a shared hosting name (`github.io`) or an AWS endpoint (`s3.amazonaws.com`). Takes a bare
 * hostname; case and a trailing root dot are forgiven.
 */
export function isPublicSuffix(name) {
  const host = String(name ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!host.includes(".")) return true;
  return TWO_LABEL_PUBLIC_SUFFIXES.has(host) || SHARED_HOSTING_SUFFIXES.has(host) || isAwsEndpoint(host);
}
