// e2e-fixture.spec.mjs - proves the fixture site is a real, working four-page flow on its own,
// and (opt-in) that a real Sue can walk it end to end.
//
// Why it exists: every other module of SUE (body.mjs, cannon.mjs, the mailroom) needs an offline
// target that behaves like a product before it is ever pointed at a live one. Without SUE_LIVE
// this file only tests sue/tests/fixture-server.mjs and fixture-mailbox.mjs - no browser,
// no Claude CLI, no AWS. With SUE_LIVE=1 it also drives cannon.mjs's exported runSue() (the
// pinned contract in SPEC.md) against this fixture, spending one real turn on the `openrouter` key
// pool's Claude Code CLI (SUE_LIVE_BRAIN overrides; `chat` needs a relay this harness never sets up,
// and the old `claude` subscription-login tier this used to run on is retired, 2026-09-23), and is
// never run by a plain `node --test` sweep.
//
// Depends on it: nothing else imports this file; it is a leaf test run directly per SPEC.md
// (`node --test sue/tests/e2e-fixture.spec.mjs`).
//
// Runs under BOTH `node --test` and the bun node lane. It talks to its own loopback fixture server
// over `node:http` (`loopbackFetch` below) rather than `globalThis.fetch`, because the bun lane's
// preload replaces `fetch` with a default-deny guard (scripts/test/unmocked-network-guard.mjs) and a
// spec that starts its own server is exactly the caller that guard cannot tell from a live-prod
// leak. Nothing here launches a browser: the SUE_LIVE half spawns the Claude CLI, whose body child
// (`node body.mjs`) is the one process that drives Chromium.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import "./fixtures/people.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { INTERVIEW_KEYS } from "../lib/findings.mjs";

/** Her `summary.json`'s `brainError`, or null - written by the cannon whether or not she ever spoke. */
function readSummaryBrainError(sueDir) {
  const file = path.join(sueDir, "summary.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")).brainError ?? null;
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withServer(fn) {
  const mailDir = await mkdtemp(path.join(tmpdir(), "sue-fixture-mail-"));
  const server = await startFixtureServer({ port: 0, mailDir, otpDelayMs: 200 });
  try {
    await fn({ server, mailDir });
  } finally {
    await server.close();
  }
}

/** The slice of `fetch` this file uses (status, `headers.get`, `text()`), over `node:http`, so the
 *  bun lane's fetch guard never sees a call. Redirects are never followed - `redirect: "manual"`. */
function loopbackFetch(url, init = {}) {
  const target = new URL(url);
  const body = init.body ? String(init.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      target,
      {
        method: init.method ?? "GET",
        headers: { ...(init.headers ?? {}), ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
            text: async () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("fixture site pages all serve 200", async () => {
  await withServer(async ({ server }) => {
    for (const page of ["/", "/signup.html", "/code.html", "/app.html", "/style.css"]) {
      const res = await loopbackFetch(new URL(page, server.url));
      assert.equal(res.status, 200, `${page} should serve 200`);
      await res.text();
    }
  });
});

test("index.html has the vague hero, an icon-only menu button and a 12-link footer", async () => {
  await withServer(async ({ server }) => {
    const html = await (await loopbackFetch(server.url)).text();
    assert.match(html, /Where moments become memories/);
    assert.match(html, /class="icon-only"/);
    const footerLinks = html.match(/<footer[\s\S]*?<\/footer>/)[0].match(/<a /g);
    assert.equal(footerLinks.length, 12);
  });
});

test("signup.html carries a hidden honeypot field alongside the real fields", async () => {
  await withServer(async ({ server }) => {
    const html = await (await loopbackFetch(new URL("/signup.html", server.url))).text();
    for (const field of ["firstName", "lastName", "email", "phone", "birthday"]) {
      assert.match(html, new RegExp(`name="${field}"`));
    }
    assert.match(html, /honeypot-field/);
    assert.match(html, /name="companyWebsite"/);
  });
});

test("POST /request-code writes a mail file with exactly one six-digit candidate after the delay", async () => {
  await withServer(async ({ server, mailDir }) => {
    const email = "sue-test-1@example.com.invalid";
    const res = await loopbackFetch(new URL("/request-code", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ firstName: "Sue", lastName: "Tester", email, phone: "+12065550100", birthday: "1950-01-01" }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);

    // Poll past otpDelayMs (200ms) until the mail file lands. A fixed 600ms sleep lost the race when
    // the whole SUE suite ran at once (2026-09-23: 0 files, then green twice run alone).
    const addressDir = path.join(mailDir, email);
    let files = [];
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      files = await readdir(addressDir).catch(() => []);
      if (files.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(files.length, 1, "exactly one mail file for this address");

    const mail = JSON.parse(await readFile(path.join(addressDir, files[0]), "utf8"));
    for (const key of ["from", "subject", "text", "receivedAt", "deliveredAt", "messageId"]) {
      assert.ok(key in mail, `mail file is missing ${key}`);
    }

    const candidates = mail.text.match(/\b\d{6}\b/g) || [];
    assert.equal(candidates.length, 1, `expected exactly one six-digit candidate, got ${candidates.length}`);
  });
});

test("a honeypot-filled /request-code never sends mail", async () => {
  await withServer(async ({ server, mailDir }) => {
    const email = "sue-bot-1@example.com.invalid";
    await loopbackFetch(new URL("/request-code", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        firstName: "Bot",
        lastName: "Tester",
        email,
        phone: "+12065550100",
        birthday: "1950-01-01",
        companyWebsite: "https://spam.example",
      }),
      redirect: "manual",
    });

    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(existsSync(path.join(mailDir, email)), false);
  });
});

test("the full signup -> code -> app flow ends on Welcome, <name>", async () => {
  await withServer(async ({ server, mailDir }) => {
    const email = "sue-flow-1@example.com.invalid";
    await loopbackFetch(new URL("/request-code", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ firstName: "Grandma", lastName: "Sue", email, phone: "+12065550100", birthday: "1950-01-01" }),
      redirect: "manual",
    });

    await new Promise((resolve) => setTimeout(resolve, 600));
    const addressDir = path.join(mailDir, email);
    const [mailFile] = await readdir(addressDir);
    const mail = JSON.parse(await readFile(path.join(addressDir, mailFile), "utf8"));
    const [code] = mail.text.match(/\b\d{6}\b/);

    const verifyRes = await loopbackFetch(new URL("/verify-code", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, code }),
      redirect: "manual",
    });
    assert.equal(verifyRes.status, 302);
    const location = verifyRes.headers.get("location");
    assert.match(location, /^\/app\.html\?name=/);

    const appHtml = await (await loopbackFetch(new URL(location, server.url))).text();
    assert.match(appHtml, /Welcome, Grandma/);
  });
});

test("SUE_LIVE=1: a real grandma Sue completes the fixture signup end to end", { skip: process.env.SUE_LIVE !== "1" }, async (t) => {
  const cannonPath = path.join(__dirname, "..", "cannon.mjs");
  const fixtureTargetPath = path.join(__dirname, "..", "targets", "fixture.json");
  if (!existsSync(cannonPath)) {
    t.skip("cannon.mjs not built yet - this branch only runs once the cannon module lands");
    return;
  }
  if (!existsSync(fixtureTargetPath)) {
    t.skip("targets/fixture.json not built yet - this branch only runs once the cannon module lands it");
    return;
  }

  const { runSue } = await import(pathToFileURL(cannonPath));
  const { loadPersona, loadTarget, loadScenario, mintIdentity } = await import(
    pathToFileURL(path.join(__dirname, "..", "lib", "personas.mjs"))
  );
  const { runDir, newRunId } = await import(pathToFileURL(path.join(__dirname, "..", "lib", "run-dir.mjs")));
  const runId = newRunId();
  // The fixture server IS her mail provider here: it must drop the code where the body reads her
  // inbox, which is the RUN's mail dir, not a throwaway temp dir (the first live run wrote the code
  // to a temp dir nobody read, and Grandma waited ten minutes for a code that "never came" - a
  // harness defect that read exactly like a product one, 2026-09-21).
  const runMailDir = path.join(runDir(runId), "mail");
  await mkdir(runMailDir, { recursive: true });
  const server = await startFixtureServer({ port: 0, mailDir: runMailDir, otpDelayMs: 1500 });
  try {
    const persona = loadPersona("grandma");
    const scenario = loadScenario("signup");
    const target = { ...loadTarget("fixture"), startUrl: server.url };
    const identity = mintIdentity(persona, { sueNumber: 1, runId, target, seed: "fixture-e2e" });

    const { sueId, sueDir, result } = await runSue({
      runId,
      persona,
      scenario,
      target,
      identity,
      browserProfileDir: path.join(runDir(runId), "sue-live-e2e", "profile"),
      // `chat` (the cannon's own default) needs a relay this harness never sets up, so a live run
      // here names a key-pool tier explicitly. SUE_LIVE_BRAIN overrides for a run that wants to
      // prove `deepseek` instead.
      brain: process.env.SUE_LIVE_BRAIN || "openrouter",
    });

    assert.ok(sueId);
    assert.ok(result);
    // A brain that never authenticated saw nothing, so there is no visit to assert against - the
    // same "no data, not a finding" split `partitionByBrain` makes in the report. Skipping names
    // the reason; it never passes silently, and it never reds the suite over a stale login.
    const brainError = readSummaryBrainError(sueDir);
    if (brainError) {
      t.skip(
        `the brain behind the Sues could not talk (${brainError}) - check the key pool (DEEPSEEK_API_KEY(S)/OPENROUTER_API_KEY(S) or HSwarm's key files) and re-run`,
      );
      return;
    }
    const interviewPath = path.join(sueDir, "interview.json");
    assert.ok(existsSync(interviewPath), "interview.json should exist after the run");
    const interview = JSON.parse(await readFile(interviewPath, "utf8"));
    // Against the ONE key list, not a hand-copy of it: a key added to the interview and never
    // written to interview.json is exactly what this assertion exists to catch.
    for (const key of INTERVIEW_KEYS) {
      assert.ok(key in interview, `interview.json is missing ${key}`);
    }
  } finally {
    await server.close();
  }
});
