// dredd/lib/rulings.mjs - a page's recorded rulings, read out of the page's own source.
//
// The Deal Flow invite hearing (docket 20260925-194526-b458) drafted the headline "Free WhatsApp Deal Flow for the
// Connections Pass" and cut the "Or become a full member now" door. Both broke rulings written in the route
// component's own header (infra/shared/pay/buyer/TrialClaimView.vue: the page never says Pass, and the door to the
// full checkout stays), and neither the drafter nor the claims check could read them: "Pass" is on the page (the
// footer's wordmark), and a cut is not a claim. The room then scored a proposal the owners had already rejected.
//
// So, for a page on one of our hosts, this finds the route's component through the plane's router - the host to
// plane mapping is convene.mjs adhocSpec, the plane to directory mapping is scripts/dev/plane-source-dirs.mjs
// planeSourceDir, one home each - and returns two things from the component's header comment:
//
//   - `text`: every ⛔ paragraph (a paragraph that opens with ⛔, or every paragraph of a `── ⛔ ... ──` section).
//     The drafter reads these as the owners' decisions (lib/resolve.mjs draftProposal).
//   - `retires` / `keeps`: the header's declaration lines, which the claims check enforces (lib/claims.mjs):
//         @ruling-retires "Pass" <why>                         a name no change may bring onto the page
//         @ruling-keeps "Skip the trial and join now" <why>    an element no change or cut may remove
//     Prose says why; the declaration says what is refused. A check that guessed rules out of prose would misfire,
//     so the page's author writes the one line the check reads, next to the paragraph it enforces.
//
// A keeps line whose text the component no longer renders is `stale` (the button was relabelled and the
// declaration was not): a declaration that protects nothing is reported, never silently honoured.
//
// Pure over the file system: reads source, writes nothing, no network.
import { importTargetFile, loadTarget, targetPath } from "../../lib/target.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { pathToFileURL } from "node:url";
const { planeSourceDir } = await importTargetFile("planeSourceDirs", { planeSourceDir: () => null });
import { adhocSpec } from "./convene.mjs";

/** The router file of a plane's web directory, in the two shapes the planes use. */
const ROUTER_FILES = ["src/router.ts", "src/router/index.ts"];

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A vue-router path as a RegExp over a URL pathname: `:code?` optional, `:id` one segment, `(re)` a custom body. */
export function routeRx(routePath) {
  let rx = "^";
  for (const seg of String(routePath).split("/").filter(Boolean)) {
    const m = /^:(\w+)(\([^)]*\))?([?*+])?$/.exec(seg);
    if (!m) {
      rx += `/${escapeRx(seg)}`;
      continue;
    }
    const body = m[2] ? m[2].slice(1, -1) : "[^/]+";
    rx += m[3] === "?" ? `(?:/${body})?` : m[3] === "*" ? `(?:/${body})*` : m[3] === "+" ? `(?:/${body})+` : `/${body}`;
  }
  return new RegExp(`${rx}/?$`);
}

/**
 * The component file a router source maps `pathname` to, as the import specifier the router wrote. Reads every
 * absolute `path: "..."` in source order and the component named before the next one: a lazy `import("...")`, or an
 * identifier resolved through the router's own top-level `import X from "..."`. First match wins, the way the
 * router's own order puts specific routes before the catch-all. Pure. Returns the specifier or null.
 */
export function routeComponentSpecifier(routerSource, pathname) {
  // Comments out first: the pay router's header quotes a retired `{ path: "/:pathMatch(.*)*", redirect }` in prose.
  const src = String(routerSource || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const paths = [...src.matchAll(/\bpath:\s*["'`](\/[^"'`]*)["'`]/g)];
  for (let i = 0; i < paths.length; i += 1) {
    if (!routeRx(paths[i][1]).test(pathname)) continue;
    const body = src.slice(paths[i].index, paths[i + 1]?.index ?? src.length);
    // `component: () => import("...")`, or wrapped: main's `createRouteComponent(() => import("..."))`.
    const lazy = /\bcomponent:\s*(?:[\w$.]+\(\s*)?\(\)\s*=>\s*import\(\s*["'`]([^"'`]+)["'`]/.exec(body);
    if (lazy) return lazy[1];
    const named = /\bcomponent:\s*([A-Za-z_$][\w$]*)/.exec(body);
    if (named) {
      const id = escapeRx(named[1]);
      const imp =
        new RegExp(`^import\\s+${id}\\s+from\\s+["'\`]([^"'\`]+)["'\`]`, "m").exec(src) ||
        new RegExp(`\\b(?:const|let)\\s+${id}\\s*=[^;]*?\\bimport\\(\\s*["'\`]([^"'\`]+)["'\`]`).exec(src);
      if (imp) return imp[1];
    }
    // A route with no component of its own (a redirect) is not the page; keep looking.
  }
  return null;
}

/** A router's import specifier as a repository-relative path, through the aliases every plane's vite config shares. */
function resolveSpecifier(spec, webDir, routerFile) {
  if (spec.startsWith("@infra-shared/")) return path.posix.join("infra/shared", spec.slice("@infra-shared/".length));
  if (spec.startsWith("@/")) return path.posix.join(webDir, "src", spec.slice(2));
  if (spec.startsWith(".")) return path.posix.join(path.posix.dirname(routerFile), spec);
  return null;
}

/** The first doc comment of a component (inside its `<script>` for a .vue), its lines without the ` * ` margin. */
function headerLines(source) {
  const src = String(source || "");
  const from = Math.max(src.indexOf("<script"), 0);
  const open = src.indexOf("/**", from);
  if (open < 0) return { lines: [], end: 0 };
  const close = src.indexOf("*/", open);
  if (close < 0) return { lines: [], end: 0 };
  const lines = src
    .slice(open + 3, close)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*? ?/, "").trimEnd());
  return { lines, end: close + 2 };
}

/** A section heading's title: `── ⛔ SAY EACH THING ONCE ──────` -> `SAY EACH THING ONCE`. */
const headingTitle = (line) =>
  line
    .replace(/^─+\s*/, "")
    .replace(/\s*─+\s*$/, "")
    .replace(/^⛔\s*/, "")
    .trim();

/**
 * The rulings a component's header records. Pure over the source text. Returns
 * { text, retires: [{ name, why, section }], keeps: [{ text, why, section }], stale: [keep text] }.
 */
export function headerRulings(source) {
  const { lines, end } = headerLines(source);
  const { text, retires, keeps } = rulingsOf(lines);
  // A keeps line protects an element the component renders; one whose text is nowhere in the component outside
  // its header protects nothing - the element was relabelled and the declaration left behind.
  const rest = String(source || "").slice(end);
  const stale = keeps.filter((k) => !rest.includes(k.text)).map((k) => k.text);
  return { text, retires, keeps, stale };
}

/** The ⛔ paragraphs and the @ruling declarations among `lines`, a header's or a rulings file's. Pure. */
function rulingsOf(lines) {
  const paragraphs = [];
  let para = [];
  const flush = () => {
    if (para.length) paragraphs.push(para);
    para = [];
  };
  for (const line of lines) {
    if (!line.trim()) flush();
    else {
      if (/^─{2,}/.test(line)) flush();
      para.push(line);
    }
  }
  flush();

  const kept = [];
  const retires = [];
  const keeps = [];
  let section = null; // { title, ruled }
  let ruledTitle = null; // the ⛔ title the paragraph sits under, for naming the ruling a finding cites
  for (const p of paragraphs) {
    if (/^─{2,}/.test(p[0])) {
      section = { title: headingTitle(p[0]), ruled: p[0].includes("⛔") };
      ruledTitle = section.ruled ? section.title : null;
    }
    const opensRuled = p[0].startsWith("⛔");
    const title = opensRuled
      ? p[0]
          .replace(/^⛔\s*/, "")
          .split(/[.:]/)[0]
          .trim()
      : ruledTitle;
    if (section?.ruled || opensRuled) kept.push(p.join("\n"));
    for (const line of p) {
      const m = /@ruling-(retires|keeps)\s+"([^"]+)"\s*(.*)$/.exec(line);
      if (!m) continue;
      const why = m[3].replace(/^[-:\s]+/, "").trim();
      if (m[1] === "retires") retires.push({ name: m[2], why, section: title || null });
      else keeps.push({ text: m[2], why, section: title || null });
    }
  }
  return { text: kept.join("\n\n"), retires, keeps };
}

/**
 * The rulings of a repository judged from outside (`--root`), which has no route components on our hosts to carry
 * them: `<repo>/.dredd/rulings.md`, beside its own seats, bench and reviewers, in the header format above (⛔
 * paragraphs, @ruling-retires and @ruling-keeps lines). Lift's round 5 drafter cut the one line three kids praised
 * ("No name, email or birthday needed") and re-proposed a change its table had parked, because a foreign page had no
 * rulings to read (2026-09-29). Its keeps are never stale: no component is at hand to check them against.
 * Returns the pageRulings shape, or null when the repository keeps no such file.
 */
function repoRulings(root) {
  const file = root ? path.join(root, ".dredd", "rulings.md") : null;
  if (!file || !existsSync(file)) return null;
  return { component: ".dredd/rulings.md", ...rulingsOf(readFileSync(file, "utf8").split(/\r?\n/)), stale: [], why: null };
}

/**
 * The recorded rulings of the page at `url`, read from the repository at `root`. Only a page on one of our hosts has
 * any (adhocSpec); a page whose route or component cannot be found says why, so the hearing logs it instead of
 * drafting as if the page had no history. Returns
 * { component, text, retires, keeps, stale, why } - `component` repo-relative, `why` set exactly when it is null.
 */
export function pageRulings(root, url) {
  const none = (why) => ({ component: null, text: "", retires: [], keeps: [], stale: [], why });
  const own = repoRulings(root);
  if (own) return own;
  const spec = url ? adhocSpec(url) : null;
  if (!spec) return none(`${url || "no url"} is not a page on one of our hosts`);
  const colon = spec.indexOf(":");
  const plane = spec.slice(0, colon);
  const pathname = spec.slice(colon + 1) || "/";
  const webDir = planeSourceDir(plane);
  if (!webDir) return none(`no source directory for the plane "${plane}" (scripts/dev/plane-source-dirs.mjs)`);
  const routerFile = ROUTER_FILES.map((f) => path.posix.join(webDir, f)).find((f) => existsSync(path.join(root, f)));
  if (!routerFile) return none(`the ${plane} plane has no router at ${webDir}/{${ROUTER_FILES.join(",")}}`);
  // The router itself, then the route tables it imports (main keeps its routes in src/products/routes.ts).
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const routerSource = read(routerFile);
  const sources = [routerFile];
  for (const m of routerSource.matchAll(/^import\s[^;]*?\sfrom\s+["'`]([^"'`]+)["'`]/gm)) {
    if (!/\broutes(?:\.[jt]s)?$/.test(m[1])) continue;
    const rel = resolveSpecifier(m[1], webDir, routerFile);
    const file = rel && [rel, `${rel}.ts`, `${rel}/index.ts`].find((f) => existsSync(path.join(root, f)));
    if (file) sources.push(file);
  }
  for (const file of sources) {
    const specifier = routeComponentSpecifier(file === routerFile ? routerSource : read(file), pathname);
    if (!specifier) continue;
    const component = resolveSpecifier(specifier, webDir, file);
    if (!component || !existsSync(path.join(root, component)))
      return none(`${file} maps ${pathname} to ${specifier}, which does not resolve to a file`);
    return { component, ...headerRulings(read(component)), why: null };
  }
  return none(`no route in ${sources.join(" or ")} matches ${pathname}`);
}

/** One line for the hearing log: what the drafter and the claims check were given. */
export function renderRulingsLine(r) {
  if (!r.component) return `no recorded rulings for this page: ${r.why}`;
  const n = r.text ? r.text.split("\n\n").length : 0;
  const parts = [
    `${n} ⛔ paragraph(s)`,
    r.retires.length ? `retires ${r.retires.map((x) => `"${x.name}"`).join(", ")}` : null,
    r.keeps.length ? `keeps ${r.keeps.map((x) => `"${x.text}"`).join(", ")}` : null,
  ].filter(Boolean);
  const stale = r.stale.length
    ? `; STALE: ${r.stale.map((s) => `"${s}"`).join(", ")} is declared kept but the component no longer renders it - fix the @ruling-keeps line`
    : "";
  return `the page's recorded rulings (${r.component}): ${parts.join(", ")}${stale}`;
}
