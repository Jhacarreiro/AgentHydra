#!/usr/bin/env node
/**
 * serve.mjs - the SUE course's static server: every folder under `site/` that holds a page.json is a
 * page at `/<slug>/`, and `/` lists them, read off the disk on every request, so a page a worker adds
 * appears with no shared file to edit. Plain files only: no build step, no network, nothing but what
 * is in the folder.
 *
 * Why not tests/fixture-server.mjs: that one is the signup-and-code events app with fixed routes and
 * a mailbox; the course is a folder of independent pages, so it needs a directory server instead.
 *
 * Run: `node sue/course/serve.mjs [--port 4620]`. Imported by course.spec.mjs (port 0).
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { listPages, SITE_DIR } from "./course.mjs";

export { SITE_DIR };
export const COURSE_PORT = 4620;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The home page: one link per page folder found, with what is hard there. Planted bugs are never named. */
function indexHtml(siteDir) {
  const rows = listPages(siteDir)
    .map(({ slug, page, problems }) => {
      const title = page?.title ?? slug;
      const line = problems.length ? "" : `<span>${escapeHtml(page.task)}</span>`;
      return `<li><a href="/${encodeURIComponent(slug)}/">${escapeHtml(title)}</a>${line}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Practice pages</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #111; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; flex-direction: column; gap: 2px; padding: 12px 4px; border-bottom: 1px solid #e5e5e5; }
  a { font-size: 16px; font-weight: 600; color: #0645ad; }
  span { font-size: 13px; color: #555; }
</style>
</head>
<body>
<h1>Practice pages</h1>
<ul>
${rows || "<li>No pages yet.</li>"}
</ul>
</body>
</html>
`;
}

/** A file inside `siteDir`, or null for anything that would step outside it. */
function insideSite(siteDir, pathname) {
  const file = path.resolve(siteDir, `.${decodeURIComponent(pathname)}`);
  const root = path.resolve(siteDir);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

/** startCourseServer({ port, siteDir }) -> { port, url, close() }. Port 0 lets the OS pick. */
export async function startCourseServer({ port = COURSE_PORT, siteDir = SITE_DIR } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        return res.end("method not allowed");
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
        return res.end(indexHtml(siteDir));
      }
      let file = insideSite(siteDir, url.pathname);
      const info = file ? await stat(file).catch(() => null) : null;
      if (info?.isDirectory()) {
        if (!url.pathname.endsWith("/")) {
          res.writeHead(301, { Location: `${url.pathname}/${url.search}` });
          return res.end();
        }
        file = path.join(file, "index.html");
      } else if (!info) file = null;
      // A page's own twin and contract are for the harness, not for the visitor reading the page.
      const name = file ? path.basename(file) : "";
      if (!file || name === "twin.mjs" || name === "page.json") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      res.writeHead(error?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      return res.end(error?.code === "ENOENT" ? "not found" : String(error?.stack ?? error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  return { port: actual, url: `http://127.0.0.1:${actual}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const port = at >= 0 ? Number(args[at + 1]) : COURSE_PORT;
  const { url } = await startCourseServer({ port });
  console.log(`[sue course] serving ${SITE_DIR} at ${url}`);
}
