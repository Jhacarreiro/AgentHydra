/**
 * tests/fixtures/tape-read-through/config.mjs - the tape config tests/tape-read-through.spec.mjs records and reads
 * through: a four-page static site (site/: index > a > b > c), served from the folder named by SUE_TAPE_RT_SITE (the
 * recorder process inherits it, so a case can serve an edited copy), and a stamp that is the sha256 of the screen's
 * own html file, so editing a page makes exactly that screen stale.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const siteDir = () => process.env.SUE_TAPE_RT_SITE;
const fileOf = (pathname) => path.join(siteDir(), pathname === "/" ? "index.html" : `${pathname.replace(/^\//, "")}.html`);

export default {
  allowedHosts: ["127.0.0.1"],
  start() {
    const server = http.createServer((req, res) => {
      try {
        const body = readFileSync(fileOf(new URL(req.url, "http://x").pathname));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve({ url: `http://127.0.0.1:${server.address().port}/`, stop: () => new Promise((done) => server.close(done)) }),
      ),
    );
  },
  stampOf(screen) {
    return createHash("sha256")
      .update(readFileSync(fileOf(new URL(screen.url).pathname)))
      .digest("hex");
  },
};
