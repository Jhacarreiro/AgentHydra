// fixture-server.mjs - the tiny fake product SUE practices on before she ever meets a real target.
//
// Why it exists: SPEC.md's tests need an offline site with a real signup-code-app flow so SUE's
// perception (icon-only menu, tiny footer print), the body's field/honeypot refusals, and the
// mailroom's OTP-latency measurement all have something real to run against without AWS,
// without a live deploy, and without spending an account cap. This module
// owns the routing and the OTP business logic (who gets a code, when, and whether it matched);
// fixture-mailbox.mjs owns writing the mail-file contract to disk.
//
// Depends on it: sue/tests/e2e-fixture.spec.mjs (imports startFixtureServer directly), and
// sue/targets/fixture.json's startUrl (owned by the cannon module) which points at this
// server's default port. Run standalone: `node sue/tests/fixture-server.mjs --mail-dir
// <dir> [--port 4590]`.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureMailbox } from "./fixture-mailbox.mjs";
import { isMainModule } from "../../lib/shared/is-main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, "fixtures", "site");

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

const SIX_DIGIT = () => String(Math.floor(100000 + Math.random() * 900000));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(raw));
}

async function serveStatic(res, fileName, replacements = {}) {
  const ext = path.extname(fileName);
  const filePath = path.join(SITE_DIR, fileName);
  let body = await readFile(filePath, "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    body = body.split(token).join(value);
  }
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

/**
 * startFixtureServer({ port, mailDir, otpDelayMs }) -> { port, url, requests, close() }
 *
 * - port: 0 lets the OS pick a free port (the default e2e test path); omit/4590 for manual runs.
 * - mailDir: passed straight to fixture-mailbox.mjs; must be writable.
 * - otpDelayMs: how long after /request-code the mail file actually lands, simulating real
 *   inbound latency - defaults from SUE_FIXTURE_OTP_DELAY_MS so a slow-CI run can shrink it.
 */
export async function startFixtureServer({ port = 4590, mailDir, otpDelayMs = Number(process.env.SUE_FIXTURE_OTP_DELAY_MS) || 1500 } = {}) {
  if (!mailDir) {
    throw new Error("startFixtureServer requires { mailDir }");
  }

  const mailbox = startFixtureMailbox({ mailDir });
  const requests = []; // { email, requestedAt } - one per non-honeypot /request-code hit
  const codes = new Map(); // lowercased email -> { code, firstName }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

      if (req.method === "GET" && pathname === "/index.html") {
        return await serveStatic(res, "index.html");
      }
      if (req.method === "GET" && pathname === "/signup.html") {
        return await serveStatic(res, "signup.html");
      }
      if (req.method === "GET" && pathname === "/style.css") {
        return await serveStatic(res, "style.css");
      }
      if (req.method === "GET" && pathname === "/code.html") {
        const email = url.searchParams.get("email") || "";
        const error = url.searchParams.get("error") ? '<p class="error">That code did not match. Check your email and try again.</p>' : "";
        return await serveStatic(res, "code.html", { __EMAIL__: escapeHtml(email), __ERROR__: error });
      }
      if (req.method === "GET" && pathname === "/app.html") {
        const name = url.searchParams.get("name") || "Friend";
        return await serveStatic(res, "app.html", { __NAME__: escapeHtml(name) });
      }

      if (req.method === "POST" && pathname === "/request-code") {
        const fields = await readRequestBody(req);
        const email = (fields.email || "").trim();
        const requestedAt = Date.now();
        requests.push({ email, requestedAt });

        // Honeypot tripped: real users and SUE's body (which refuses hidden fields) never fill
        // this, so a non-empty value means a bot filled every field it could see. Redirect the
        // same as a real request would, but never actually send a code.
        const isHoneypot = Boolean((fields.companyWebsite || "").trim());
        if (!isHoneypot && email) {
          const code = SIX_DIGIT();
          codes.set(email.toLowerCase(), { code, firstName: fields.firstName || "Friend" });
          setTimeout(() => {
            mailbox
              .deliver({
                to: email,
                from: "Moments <no-reply@moments.fixture>",
                subject: "Your verification code",
                text: `Hi ${fields.firstName || "there"},\n\nYour Moments verification code is: ${code}\n\nThis code expires in ten minutes. If you did not request it, ignore this email.\n\nThe Moments team`,
              })
              .catch(() => {
                // A test fixture's own delivery failing is not this request's problem to solve;
                // the e2e spec's mail-file assertion is what would surface it.
              });
          }, otpDelayMs);
        }

        return redirect(res, `/code.html?email=${encodeURIComponent(email)}`);
      }

      if (req.method === "POST" && pathname === "/verify-code") {
        const fields = await readRequestBody(req);
        const email = (fields.email || "").trim().toLowerCase();
        const submitted = (fields.code || "").trim();
        const entry = codes.get(email);

        if (entry && entry.code === submitted) {
          codes.delete(email);
          return redirect(res, `/app.html?name=${encodeURIComponent(entry.firstName)}`);
        }
        return redirect(res, `/code.html?email=${encodeURIComponent(fields.email || "")}&error=1`);
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err && err.stack ? err.stack : err));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = server.address().port;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// CLI: node tests/fixture-server.mjs --mail-dir <dir> [--port 4590]
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--mail-dir") opts.mailDir = args[++i];
    else if (args[i] === "--port") opts.port = Number(args[++i]);
  }
  if (!opts.mailDir) {
    console.error("usage: node tests/fixture-server.mjs --mail-dir <dir> [--port 4590]");
    process.exit(1);
  }
  const { url } = await startFixtureServer(opts);
  console.error(`[fixture-server] listening at ${url} (mail -> ${opts.mailDir})`);
}
