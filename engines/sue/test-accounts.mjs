#!/usr/bin/env node
/**
 * test-accounts - the named throwaway accounts an AI proof signs into, each a REAL Sue.
 * WHY (Owner, 2026-10-10): proofs RSVPing as dev personas (ai@...) looked like real people and mailed
 * him alerts. A Sue address is already a separate dataset in the backend (is_sue, no host alert).
 * WHAT: `node sue/test-accounts.mjs create [--profile <name>]` signs up every `sue: true`
 * persona in infra/shared/dev-personas.json that has no account: request-otp past Turnstile via the
 * Sue key, the code read through sue/mailroom.mjs (child process), then verify-otp.
 * Prints only email, created|exists and sub; never the code, key or a token. Plain node.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSueAddress } from "../lib/shared/sue-address.mjs";
import { ACCOUNTS_HOSTS, SUE_KEY_HEADER, readSueSignupKey } from "./lib/signup-door.mjs";
import { candidateCodes } from "./lib/mime-text.mjs";
import { mailDir, newRunId, writeManifest } from "./lib/run-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROSTER = fileURLToPath(new URL("../vendor/infra/shared/dev-personas.json", import.meta.url));
/** The estate accounts origin (plain node cannot import outbound-domain.ts; signup-door.mjs keeps this list). */
const ACCOUNTS_ORIGIN = `https://${ACCOUNTS_HOSTS[0]}`;
const MAILROOM = path.join(HERE, "mailroom.mjs");

/** The roster personas that are Sue-signed-up accounts: `sue: true` AND a Sue-shaped address. */
export function sueRosterEntries(personas) {
  return Object.entries(personas ?? {})
    .filter(([, p]) => p?.sue === true)
    .map(([name, p]) => {
      if (!isSueAddress(p.email)) throw new Error(`persona ${name} is marked sue but ${p.email} is not a Sue address`);
      return { name, email: p.email.trim().toLowerCase() };
    });
}

/** The single six-digit code a mail record shows, or null when it shows none or more than one. */
export function singleCodeFromRecord(record) {
  const codes = candidateCodes([
    { html: false, text: String(record?.text ?? "") },
    { html: true, text: String(record?.html ?? "") },
  ]);
  return codes.length === 1 ? codes[0] : null;
}

/** The display name signup wants (first and last): `sue-guest-2` becomes "Sue Guest Two". */
export function displayNameFor(personaName) {
  return personaName
    .split("-")
    .map((w) => (w === "2" ? "Two" : w === "3" ? "Three" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function mailroom(args, passThrough) {
  const out = spawnSync(process.execPath, [MAILROOM, ...args, ...passThrough], { encoding: "utf8", windowsHide: true });
  return out;
}

function probeExists(email, passThrough) {
  const out = mailroom(["--probe-account", email], passThrough);
  const line = out.stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`account probe for ${email} printed no JSON (exit ${out.status})`);
  }
  if (!parsed.ok) throw new Error(`account probe for ${email} failed: ${parsed.error}`);
  return parsed.exists === true;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll this Sue's inbox (one mailroom pass per try) until exactly one code shows. */
async function waitForCode(email, passThrough, { tries = 18, gapMs = 5000 } = {}) {
  const runId = newRunId();
  writeManifest(runId, { started: new Date().toISOString(), addresses: [email] });
  const dir = path.join(mailDir(runId), email);
  for (let i = 0; i < tries; i++) {
    const out = mailroom(["--run", runId, "--once"], passThrough);
    if (out.status !== 0) throw new Error(`mailroom pass failed for ${email} (exit ${out.status})`);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()) {
        const code = singleCodeFromRecord(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
        if (code) return code;
      }
    }
    await sleep(gapMs);
  }
  throw new Error(`no one-time code reached ${email} in ${(tries * gapMs) / 1000}s`);
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ACCOUNTS_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

function subFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8")).sub ?? null;
  } catch {
    return null;
  }
}

export async function signUp({ name, email }, passThrough, key) {
  const base = ACCOUNTS_ORIGIN;
  const requested = await postJson(`${base}/auth/request-otp`, { email, name, mode: "signup" }, { [SUE_KEY_HEADER]: key });
  if (requested.status >= 300) throw new Error(`request-otp for ${email} answered ${requested.status}`);
  const code = await waitForCode(email, passThrough);
  const verified = await postJson(`${base}/auth/verify-otp`, {
    email,
    code,
    mode: "signup",
    signupData: {
      name,
      phone: "",
      ageAttestation: true,
      legalConsent: true,
      memberStandardsConsent: true,
      smsConsent: false,
      notificationPreference: "email",
    },
  });
  if (verified.status >= 300)
    throw new Error(
      `verify-otp for ${email} answered ${verified.status} (${verified.json?.error ?? verified.json?.code ?? verified.json?.message ?? "no reason"})`,
    );
  return verified.json?.userId ?? subFromIdToken(verified.json?.idToken);
}

async function main() {
  if (process.argv[2] !== "create") {
    console.error("usage: node sue/test-accounts.mjs create [--profile <name>]");
    process.exit(2);
  }
  const profile = process.argv.indexOf("--profile");
  const passThrough = profile >= 0 ? ["--profile", process.argv[profile + 1]] : [];
  const key = readSueSignupKey();
  if (!key) throw new Error("no Sue signup key on this machine (~/.connections/sue/signup-key)");
  const entries = sueRosterEntries(JSON.parse(readFileSync(ROSTER, "utf8")).personas);
  for (const entry of entries) {
    if (probeExists(entry.email, passThrough)) {
      console.log(JSON.stringify({ persona: entry.name, email: entry.email, status: "exists" }));
      continue;
    }
    const sub = await signUp({ name: displayNameFor(entry.name), email: entry.email }, passThrough, key);
    console.log(JSON.stringify({ persona: entry.name, email: entry.email, status: "created", sub }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`test-accounts: ${error.message}`);
    process.exit(1);
  });
}
