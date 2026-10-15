/**
 * tape/selftest.mjs - the AGREEMENT CHECK: a tape is only worth walking if every screen on it is the screen a live
 * Sue sees. This records SUE's fixture (tests/fixture-server.mjs, the fake events app) and the tape's own quiz
 * (tape/fixture/quiz.html: slide-in animations, a delayed "Try again", a double-tap guard) at phone, Chromebook and
 * desktop size, then, for every recorded screen, starts a real SUE body (body.mjs createSueBody, in this process,
 * on a shared headless browser), walks the screen's steps with her own look / type / click tools, and compares:
 *
 *   - the tape's inventory with the inventory her last look read (canonical JSON, stamps included);
 *   - perceive() on both for three personas with different dials (reading grade, legibleMinPx, wordsPerLook).
 *
 * Then every edge in edges.json that is not the walk that first reached its screen is walked live the same way
 * (the steps of the screen it leaves, then its move) and must land on its `to`, by screen id; an edge the
 * recorder could not take (`error`) is a failure. A recorder whose taps all fail cannot pass.
 *
 * Resolves true only with zero differences; prints each difference otherwise. Called by `tape.mjs selftest`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { createSueBody } from "../body.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { perceive } from "../lib/perception.mjs";
import { TAPE_DEVICES } from "./device.mjs";
import { canonicalJson, controlsOf, loadTape, originOf, recordTape, screenIdOf } from "./record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVICES = ["phone", "chromebook", "desktop"];
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"];
/** Real seconds her body waits on each screen before it looks: longer than any timer the fixtures start. */
const LIVE_WAIT_SECONDS = 1.5;
const LIVE_WORKERS = 3;

/** Three readers who see the same screen differently. */
export const SELFTEST_PERSONAS = [
  { id: "young-skimmer", dials: { readingGrade: 4, legibleMinPx: 16, wordsPerLook: 40, techProwess: 2 } },
  { id: "average-reader", dials: { readingGrade: 8, legibleMinPx: 13, wordsPerLook: 150, techProwess: 3 } },
  { id: "close-reader", dials: { readingGrade: 14, legibleMinPx: 0, wordsPerLook: 0, techProwess: 5 } },
];

/** A tiny static server for the quiz fixture. */
function serveQuiz() {
  const html = readFileSync(path.join(HERE, "fixture", "quiz.html"));
  const server = http.createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname !== "/") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}

/** The first few paths where two JSON values differ, each with both sides (short). */
export function differences(a, b, at = "", out = []) {
  if (out.length >= 6) return out;
  if (canonicalJson(a) === canonicalJson(b)) return out;
  const isObj = (v) => v && typeof v === "object";
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a)
      ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
      : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) differences(a[k], b[k], `${at}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
    return out;
  }
  const short = (v) => {
    const s = v === undefined ? "(absent)" : JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  };
  out.push(`${at || "(root)"}: tape ${short(a)} | live ${short(b)}`);
  return out;
}

/** What a persona sees, as plain data. */
function seen(inventory, persona) {
  const view = perceive(inventory, persona);
  return { text: view.text, clickable: [...view.clickable], stats: view.stats };
}

/** The persona her live body is given to walk the tape: she reads every word and every control is numbered. */
function walkerPersona(device) {
  return {
    id: "tape-walker",
    displayName: "Tape Walker",
    dials: {
      device: TAPE_DEVICES[device].as,
      readingGrade: 99,
      wordsPerLook: 0,
      legibleMinPx: 0,
      techProwess: 3,
      patienceSeconds: 100_000,
      attentionSeconds: 100_000,
      wordsPerMinute: 200,
      temperature: 0.5,
      maxTurns: 500,
    },
  };
}

/**
 * Walk `steps` from the start with a live SUE body (her own look / type / click tools), then hand what she read on
 * the last screen to `compare`, which returns difference lines. A step that cannot be walked is a difference too.
 */
async function liveWalk({ label, device, steps, startUrl, wsEndpoint, workDir, mailDir, compare }) {
  const sueDir = path.join(workDir, `live-${device}-${label}`);
  mkdirSync(sueDir, { recursive: true });
  const spec = TAPE_DEVICES[device];
  writeFileSync(
    path.join(sueDir, "sue.json"),
    JSON.stringify({
      sueId: `tape-live-${label}`,
      persona: walkerPersona(device),
      target: {
        id: "tape-selftest",
        startUrl,
        allowedHosts: ALLOWED_HOSTS,
        ...(spec.target.viewport ? { viewport: spec.target.viewport } : {}),
        mailbox: { kind: "none" },
        groundTruth: { oneLiner: "", mustGet: [], shouldGet: [], wrongIf: [] },
      },
      scenario: "first-visit",
      identity: { email: "tape@sue.test" },
      mailDir,
      browserWsEndpoint: wsEndpoint,
    }),
  );
  const origin = originOf(startUrl);
  const log = () => {};
  const body = await createSueBody({ sueDir, log });
  const tool = (name, args = {}) => body.tools.find((t) => t.name === name).handler(args);
  const said = (reply) => (reply?.content ?? []).map((c) => c.text ?? "").join(" ");
  const look = async () => {
    const reply = await tool("look");
    const inventory = body.lastInventory();
    const numbers = new Map([...perceive(inventory, walkerPersona(device)).clickable].map(([n, id]) => [String(id), n]));
    const controls = controlsOf(inventory, {}, ALLOWED_HOSTS, origin);
    return { reply, inventory, numberOf: (key) => numbers.get(String(controls.find((c) => c.key === key)?.sueId)) };
  };
  const press = async (step, args) => {
    const reply = await tool("click", args);
    if (reply?.isError) throw new Error(`click "${step.key}" refused: ${said(reply).slice(0, 200)}`);
    return reply;
  };
  try {
    await tool("wait", { seconds: LIVE_WAIT_SECONDS });
    let view = await look();
    for (const step of steps) {
      for (const fill of step.typed ?? []) {
        const n = view.numberOf(fill.key);
        if (n == null) throw new Error(`no [n] for box "${fill.key}" on the live screen`);
        const reply = fill.check ? await tool("click", { target: n }) : await tool("type", { target: n, text: String(fill.value) });
        if (reply?.isError) throw new Error(`type into "${fill.key}" refused: ${said(reply).slice(0, 200)}`);
      }
      const n = view.numberOf(step.key);
      if (n == null) throw new Error(`no [n] for "${step.key}" on the live screen`);
      if (step.kind === "choose") {
        // Her hand on a list: its number opens it and says its choices, the choice's words put it in.
        await press(step, { target: n });
        const reply = await press(step, { target: step.option });
        if (!/You picked/.test(said(reply)))
          throw new Error(`pick "${step.option}" in "${step.key}" did not take: ${said(reply).slice(0, 200)}`);
      } else await press(step, { target: n });
      await tool("wait", { seconds: LIVE_WAIT_SECONDS });
      view = await look();
    }
    return compare(view);
  } catch (err) {
    return [`walk failed: ${String(err?.message ?? err).split("\n")[0]}`];
  } finally {
    await body.shutdown().catch(() => {}); // a body whose browser already went is shut
  }
}

/** One tape screen walked live by its own steps: its inventory (stamps included) and what three personas see. */
function checkScreen({ screen, ...site }) {
  const spec = TAPE_DEVICES[screen.device];
  return liveWalk({
    ...site,
    label: screen.id,
    device: screen.device,
    steps: screen.steps,
    compare: (view) => {
      const lines = differences(screen.inventory, view.inventory).map((d) => `inventory ${d}`);
      for (const persona of SELFTEST_PERSONAS) {
        const p = { ...persona, dials: { ...persona.dials, device: spec.as } };
        for (const d of differences(seen(screen.inventory, p), seen(view.inventory, p))) lines.push(`perceive(${persona.id}) ${d}`);
      }
      return lines;
    },
  });
}

/**
 * One recorded edge walked live: the steps of the screen it leaves, then its own move (its control, its choice,
 * what it typed). She must land on the edge's `to`, by screen id (the stamps depend on the walk). An edge the
 * recorder could not take (`error`) is a failure without a walk.
 */
async function checkEdge({ edge, tape, i, ...site }) {
  if (edge.error) return [`the recorder's move failed: ${edge.error}`];
  const from = tape.screen(edge.from);
  const control = from.controls.find((c) => c.key === edge.control);
  const move = {
    key: edge.control,
    kind: control?.kind ?? "tap",
    ...(control?.option != null ? { option: control.option } : {}),
    typed: edge.typed ?? [],
  };
  return liveWalk({
    ...site,
    label: `edge-${i}`,
    device: edge.device,
    steps: [...from.steps, move],
    compare: (view) => {
      const now = screenIdOf(view.inventory, originOf(site.startUrl));
      return now === edge.to ? [] : [`landed on ${now}, the tape says ${edge.to}`];
    },
  });
}

/** Run `check` over `items` on LIVE_WORKERS live bodies; resolves to the failures, each `{ item, lines }`. */
async function overLiveBodies(items, check) {
  const failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: LIVE_WORKERS }, async () => {
      while (next < items.length) {
        const i = next++;
        const lines = await check(items[i], i);
        if (lines.length) failures.push({ item: items[i], lines });
      }
    }),
  );
  return failures;
}

/**
 * Record one site at the three sizes into `out`, then check every screen, and every edge that is not the walk
 * that first reached its screen (that one is the screen's own check), against a live body.
 */
async function checkSite({ name, startUrl, out, config, wsEndpoint, workDir, mailDir }) {
  const manifest = await recordTape({ url: startUrl, devices: DEVICES, out, config, log: (l) => console.error(`  ${name} ${l}`) });
  const tape = loadTape(out);
  const site = { startUrl, wsEndpoint, workDir, mailDir };
  const ids = Object.keys(manifest.screens);
  console.log(
    `${name}: recorded ${manifest.stats.screens} screens, ${manifest.stats.edges} edges, ${manifest.stats.midAnimation} mid-animation, ${manifest.stats.wallMs} ms`,
  );
  const screenFailures = await overLiveBodies(ids, (id) => checkScreen({ screen: tape.screen(id), ...site }));
  const edges = tape.edges.filter(
    (e) => e.error || (e.to != null && manifest.screens[e.to].pathKey !== `${manifest.screens[e.from].pathKey} > ${e.move}`),
  );
  const edgeFailures = await overLiveBodies(edges, (edge, i) => checkEdge({ edge, tape, i, ...site }));
  console.log(`${name}: ${ids.length - screenFailures.length}/${ids.length} screens agree with the live body`);
  console.log(`${name}: ${edges.length - edgeFailures.length}/${edges.length} other edges replay to their screen`);
  for (const { item, lines } of screenFailures) {
    const screen = tape.screen(item);
    console.log(`  DIFFERS ${screen.device} ${screen.pathKey}`);
    for (const line of lines) console.log(`    ${line}`);
  }
  for (const { item, lines } of edgeFailures) {
    console.log(`  EDGE ${item.device} ${manifest.screens[item.from].pathKey} > ${item.move}`);
    for (const line of lines) console.log(`    ${line}`);
  }
  if (manifest.stats.midAnimation) console.log("  a screen was read mid-animation");
  return screenFailures.length + edgeFailures.length + (manifest.stats.midAnimation ? 1 : 0);
}

export async function selftest({ keep = null } = {}) {
  const started = Date.now();
  const workDir = keep ?? mkdtempSync(path.join(tmpdir(), "sue-tape-selftest-"));
  let fixture = null;
  let quiz = null;
  let server = null;
  let failed = 0;
  try {
    mkdirSync(workDir, { recursive: true });
    const mailDir = path.join(workDir, "mail");
    mkdirSync(mailDir, { recursive: true });
    // Loaded here, not at the top: engine snapshots leave tests/ out, and the closure check imports this module.
    const { startFixtureServer } = await import("../tests/fixture-server.mjs");
    fixture = await startFixtureServer({ port: 0, mailDir, otpDelayMs: 10 });
    quiz = await serveQuiz();
    const executablePath = resolveChromiumPath();
    if (!executablePath) throw new Error("no Chromium on this machine (browser-launch.mjs resolved null)");
    server = await chromium.launchServer({ headless: true, executablePath, args: browserArgsFor("headless") });
    failed += await checkSite({
      name: "sue-fixture",
      startUrl: fixture.url,
      out: path.join(workDir, "tape-fixture"),
      // A right code differs per request, so the code box gets the one value that is the same every time: a wrong one.
      config: { allowedHosts: ALLOWED_HOSTS, typed: ({ field }) => (/code/i.test(field.name) ? "000000" : undefined) },
      wsEndpoint: server.wsEndpoint(),
      workDir,
      mailDir,
    });
    failed += await checkSite({
      name: "tape-quiz",
      startUrl: quiz.url,
      out: path.join(workDir, "tape-quiz"),
      config: { allowedHosts: ALLOWED_HOSTS },
      wsEndpoint: server.wsEndpoint(),
      workDir,
      mailDir,
    });
  } finally {
    await server?.close().catch(() => {}); // a browser server that already went is closed
    await fixture?.close();
    await quiz?.close();
    if (!keep) rmSync(workDir, { recursive: true, force: true });
  }
  console.log(failed ? `selftest FAILED: ${failed} difference(s)` : "selftest passed: zero differences");
  console.log(`selftest wall ${Date.now() - started} ms${keep ? `, kept at ${workDir}` : ""}`);
  return failed === 0;
}
