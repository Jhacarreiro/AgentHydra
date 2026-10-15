// dredd/lib/repo-facts.mjs - what the repository judged actually is: its stack and its real files, said to the room
// and to the drafter when --root names a repository other than Connections.
//
// The house brief (lib/seats.mjs HOUSE) describes Connections, "a Vue 3 + TypeScript SPA", and every sitting read it
// whatever --root named. On a plain static site (index.html, mission.html, programs.html, founders.html and
// assets/monument.css and .js, no build step, no framework; futurethatworks.org, 2026-09-24) the seats proposed "a single
// SharedCTA component reference (src/components/SharedCTA.vue)", and seven sittings that night cited nine files the site
// does not have. A room judging another repository is told that repository's stack and its files instead; Connections
// keeps its own brief, since its 22k files are no list to read out.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Folders that are never the repository's own files: dependencies, build output, caches, and the tools' working
 *  folders (tmp/ holds the dockets themselves). A dot-folder other than .github is tooling too (repoFiles). */
export const SKIP_DIRS = new Set(["node_modules", "tmp", "dist", "build", "out", "target", "coverage", "vendor", "__pycache__", "venv"]);

/** Every file under `root`, repository-relative with forward slashes, sorted. The walk stops at `cap` files and says
 *  so in `truncated`, so a huge tree costs a bounded walk. */
export function repoFiles(root, { cap = 2000 } = {}) {
  const files = [];
  let truncated = false;
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable folder lists nothing, it does not stop the walk
    }
    for (const e of entries) {
      if (files.length >= cap) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) files.push(r);
    }
  };
  walk(root, "");
  return { files: files.sort(), truncated };
}

/** A framework or build tool a package.json names, by the dependency that brings it. */
const NODE_STACK = [
  ["nuxt", "Nuxt"],
  ["vue", "Vue"],
  ["next", "Next.js"],
  ["react", "React"],
  ["@sveltejs/kit", "SvelteKit"],
  ["svelte", "Svelte"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["gatsby", "Gatsby"],
  ["@11ty/eleventy", "Eleventy"],
  ["express", "Express"],
  ["hono", "Hono"],
  ["vite", "Vite"],
  ["webpack", "webpack"],
  ["tailwindcss", "Tailwind"],
  ["typescript", "TypeScript"],
];

/** A top-level file that says what a repository with no package.json is. */
const MARKERS = [
  ["Cargo.toml", "a Rust crate (Cargo.toml)"],
  ["go.mod", "a Go module (go.mod)"],
  ["pyproject.toml", "a Python project (pyproject.toml)"],
  ["requirements.txt", "a Python project (requirements.txt)"],
  ["Gemfile", "a Ruby project (Gemfile)"],
  ["composer.json", "a PHP project (composer.json)"],
  ["pom.xml", "a Java project (pom.xml)"],
  ["build.gradle", "a JVM project (build.gradle)"],
  ["deno.json", "a Deno project (deno.json)"],
  ["hugo.toml", "a Hugo site (hugo.toml)"],
  ["_config.yml", "a Jekyll site (_config.yml)"],
];

/**
 * One sentence on what the repository is, from its files: a package.json's frameworks and package scripts, else a
 * language or site-generator marker, else - when it holds HTML pages - a plain static site with no build step, said
 * outright, because "no framework" is exactly what a room told nothing fills in with one. `readPkg` is injectable.
 */
export function repoStack(files, { readPkg = null } = {}) {
  const top = new Set((files || []).filter((f) => !f.includes("/")));
  if (top.has("package.json")) {
    let pkg;
    try {
      pkg = (readPkg && readPkg()) || {};
    } catch {
      pkg = {}; // an unreadable package.json names no framework and no scripts
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const uses = NODE_STACK.filter(([dep]) => dep in deps).map(([, name]) => name);
    const scripts = Object.keys(pkg.scripts || {});
    return (
      `a Node project (package.json)${uses.length ? ` using ${uses.join(", ")}` : " with no framework among its dependencies"}; ` +
      (scripts.length ? `its package scripts are ${scripts.join(", ")}` : "it has no package scripts")
    );
  }
  const marker = MARKERS.find(([f]) => top.has(f));
  if (marker) return marker[1];
  const pages = (files || []).filter((f) => /\.html?$/i.test(f));
  if (pages.length)
    return `a plain static site: ${pages.length} hand-written HTML page(s) with their CSS and JavaScript served as files. There is no package.json, no build step and no framework, so there are no components, no src/ folder and no package scripts to run`;
  return "a repository with no package.json and no framework or build marker";
}

/** The file list the room reads: every file when there are at most `listMax`; past that, the top-level files and each
 *  folder (two levels deep) with its count, since a list of thousands is read by nobody. */
function renderFileList(files, truncated, listMax) {
  if (!truncated && files.length <= listMax) return `Its files, all ${files.length} of them:\n${files.join("\n")}`;
  const topFiles = files.filter((f) => !f.includes("/"));
  const byFolder = new Map();
  for (const f of files) {
    const segs = f.split("/");
    if (segs.length < 2) continue;
    const folder = segs.slice(0, Math.min(2, segs.length - 1)).join("/");
    byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
  }
  const folders = [...byFolder.entries()].slice(0, 80).map(([d, n]) => `${d}/ (${n} file${n === 1 ? "" : "s"})`);
  return [
    `Its ${truncated ? `first ${files.length}` : files.length} files, summarised (check a path is real before naming it):`,
    ...topFiles.slice(0, 40),
    ...folders,
  ].join("\n");
}

/**
 * What the repository at `root` is and what it holds, as the room and the drafter read it. Returns
 * { name, stack, files, truncated, text }.
 */
export function repoFacts(root, { listMax = 150, cap = 2000 } = {}) {
  const { files, truncated } = repoFiles(root, { cap });
  const stack = repoStack(files, { readPkg: () => JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) });
  const name = path.basename(path.resolve(root));
  const text = [
    `## The repository judged: ${name}`,
    `It is ${stack}.`,
    renderFileList(files, truncated, listMax),
    `A change may name only a file listed here, or a new file it says it creates. A file, component, framework or script not listed here does not exist in this repository, so a fix that names one is invented.`,
  ].join("\n");
  return { name, stack, files, truncated, text };
}
