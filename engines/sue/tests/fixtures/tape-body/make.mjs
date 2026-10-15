/**
 * tests/fixtures/tape-body/make.mjs - makes the committed fixture tests/tape-body.spec.mjs walks, ONCE, by hand:
 *
 *   ~/.claude/tools/fairjob.cmd -Weight 3 -Run "node sue/tests/fixtures/tape-body/make.mjs"
 *
 * It records SUE's own fixture site (tests/fixture-server.mjs) at phone size, two moves deep, then walks the same
 * scripted visit (`VISIT`) with the LIVE body (body.mjs createSueBody on a headless browser) and keeps what she was
 * told: every reply's text, her clock after every move, her trace rows and the wall time of each move
 * (`expected.json`). It keeps only the three screens the visit crosses (start, sign-up, code) and the edges between
 * them, so a tap anywhere else is off the tape. Last it walks the visit on the TAPE body and prints wall ms per move
 * for both bodies, the speed comparison the tape body's report quotes.
 *
 * Nothing in the spec runs this; re-run it only when perceive, the look text or the fixture site changes.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { isMainModule } from "../../../../lib/shared/is-main-module.mjs";
import { resolveChromiumPath } from "../../../../lib/shared/browser-launch.mjs";
import { createSueBody } from "../../../body.mjs";
import { browserArgsFor } from "../../../lib/findings.mjs";
import { createTapeBody } from "../../../tape/body.mjs";
import { recordTape } from "../../../tape/record.mjs";
import { startFixtureServer } from "../../fixture-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"];

/** The persona both bodies are given: a phone reader who reads every word, so the looks hold the whole screen. */
export const PERSONA = {
  id: "tape-walker",
  displayName: "Tape Walker",
  dials: {
    device: "phone",
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

/** The scripted visit: look, follow "Get started", fill the sign-up form with what the recorder typed, send it, look. */
export function visitOf(typed, signup) {
  const labelOf = (t) => {
    const sueId = signup.controls.find((c) => c.key === t.key)?.sueId;
    const el = signup.inventory.elements.find((e) => String(e.id) === String(sueId));
    return el?.seenLabel ?? el?.labelText ?? el?.name;
  };
  return [
    ["look", {}],
    ["click", { target: "Get started" }],
    ["wait", { seconds: 1.5 }],
    ["look", {}],
    ...typed.map((t) => ["type", { target: labelOf(t), text: t.value }]),
    ["click", { target: "Send me a code" }],
    ["wait", { seconds: 1.5 }],
    ["look", {}],
  ];
}

export function sueJson({ sueId, startUrl, extra }) {
  return {
    sueId,
    persona: PERSONA,
    target: {
      id: "tape-body-fixture",
      startUrl,
      allowedHosts: ALLOWED_HOSTS,
      mailbox: { kind: "none" },
      groundTruth: { oneLiner: "", mustGet: [], shouldGet: [], wrongIf: [] },
    },
    scenario: "first-visit",
    identity: { email: "tape@sue.test" },
    ...extra,
  };
}

/** Walk `visit` on a body; resolves to one entry per move: the reply's words, the clock, the wall ms. */
export async function walk(body, visit) {
  const steps = [];
  for (const [tool, args] of visit) {
    const t0 = performance.now();
    const reply = await body.tools.find((x) => x.name === tool).handler(args);
    const ms = performance.now() - t0;
    const text = (reply.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    steps.push({ tool, args, text, isError: Boolean(reply.isError), ms: Math.round(ms * 10) / 10 });
  }
  return steps;
}

/** Her trace: her moves, one row each, and the hop rows (lib/hop-trace.mjs) between them. */
const traceOf = (sueDir) =>
  readFileSync(path.join(sueDir, "trace.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "sue-tape-body-fixture-"));
  const mailDir = path.join(work, "mail");
  mkdirSync(mailDir, { recursive: true });
  const fixture = await startFixtureServer({ port: 0, mailDir, otpDelayMs: 10 });
  const recorded = path.join(work, "tape");
  const tapeDir = path.join(HERE, "tape");
  try {
    await recordTape({
      url: fixture.url,
      devices: ["phone"],
      out: recorded,
      maxDepth: 2,
      config: { allowedHosts: ALLOWED_HOSTS, typed: ({ field }) => (/code/i.test(field.name) ? "000000" : undefined) },
      log: (line) => console.error(`record ${line}`),
    });
    const manifest = JSON.parse(readFileSync(path.join(recorded, "manifest.json"), "utf8"));
    const edges = JSON.parse(readFileSync(path.join(recorded, "edges.json"), "utf8"));
    const start = Object.values(manifest.starts.phone)[0];
    const toSignup = edges.find((e) => e.from === start && /Get started/.test(e.control) && e.to);
    const toCode = edges.find((e) => e.from === toSignup.to && /Send me a code/.test(e.control) && e.to);
    if (!toSignup || !toCode) throw new Error("the recording has no start > sign-up > code walk");
    const kept = new Set([start, toSignup.to, toCode.to]);
    const visit = visitOf(toCode.typed ?? [], JSON.parse(readFileSync(path.join(recorded, "screens", `${toSignup.to}.json`), "utf8")));

    // The live visit, on a headless browser.
    const executablePath = resolveChromiumPath();
    if (!executablePath) throw new Error("no Chromium on this machine");
    const server = await chromium.launchServer({ headless: true, executablePath, args: browserArgsFor("headless") });
    // Her own inbox: the recorder's sign-up mailed a code to the same address, which is not hers to see.
    const liveMail = path.join(work, "live-mail");
    mkdirSync(liveMail, { recursive: true });
    const liveDir = path.join(work, "live");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      path.join(liveDir, "sue.json"),
      JSON.stringify(
        sueJson({
          sueId: "tape-fixture-live",
          startUrl: fixture.url,
          extra: { mailDir: liveMail, browserWsEndpoint: server.wsEndpoint() },
        }),
      ),
    );
    let live;
    try {
      const body = await createSueBody({ sueDir: liveDir, log: () => {} });
      live = await walk(body, visit);
      await body.shutdown().catch(() => {});
    } finally {
      await server.close().catch(() => {});
    }
    const liveRows = traceOf(liveDir);
    const liveTrace = liveRows.filter((row) => !row.kind);
    const liveHops = liveRows.filter((row) => row.kind === "hop");

    // Keep only the walk's three screens and the edges among them; a tap anywhere else is off the tape.
    rmSync(tapeDir, { recursive: true, force: true });
    mkdirSync(path.join(tapeDir, "screens"), { recursive: true });
    for (const id of kept)
      for (const ext of ["json", "png"])
        cpSync(path.join(recorded, "screens", `${id}.${ext}`), path.join(tapeDir, "screens", `${id}.${ext}`));
    const keptEdges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
    writeFileSync(path.join(tapeDir, "edges.json"), `${JSON.stringify(keptEdges, null, 2)}\n`);
    const screens = Object.fromEntries(Object.entries(manifest.screens).filter(([id]) => kept.has(id)));
    writeFileSync(
      path.join(tapeDir, "manifest.json"),
      `${JSON.stringify({ ...manifest, screens, stats: { ...manifest.stats, screens: kept.size, edges: keptEdges.length } }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(HERE, "expected.json"),
      `${JSON.stringify(
        {
          note: "Made by make.mjs from one LIVE body visit of the fixture site; the spec compares the tape body with it.",
          startUrl: fixture.url,
          screens: { start, signup: toSignup.to, code: toCode.to },
          visit,
          live: live.map(({ ms: _ms, ...step }, i) => ({
            ...step,
            clock: liveTrace[i].clock,
            traceKeys: Object.keys(liveTrace[i]).sort(),
          })),
          liveHops: liveHops.map(({ at: _at, ...hop }) => hop),
          liveMs: live.map((s) => s.ms),
        },
        null,
        2,
      )}\n`,
    );

    // The same visit on the tape body: the speed comparison.
    const tapeSue = path.join(work, "tape-sue");
    mkdirSync(tapeSue, { recursive: true });
    writeFileSync(
      path.join(tapeSue, "sue.json"),
      JSON.stringify(sueJson({ sueId: "tape-fixture-tape", startUrl: fixture.url, extra: { tape: tapeDir } })),
    );
    const tapeBody = await createTapeBody({ sueDir: tapeSue, log: () => {} });
    const onTape = await walk(tapeBody, visit);
    await tapeBody.shutdown();
    const sum = (rows, pick = () => true) => rows.filter(pick).reduce((n, s) => n + s.ms, 0);
    const notWait = (s) => s.tool !== "wait";
    console.log("move              live ms   tape ms   same words");
    visit.forEach(([tool], i) =>
      console.log(
        `${tool.padEnd(16)} ${String(live[i].ms).padStart(8)} ${String(onTape[i].ms).padStart(9)}   ${live[i].text === onTape[i].text}`,
      ),
    );
    console.log(
      `per move (all ${visit.length}): live ${(sum(live) / visit.length / 1000).toFixed(3)} s, tape ${(sum(onTape) / visit.length / 1000).toFixed(4)} s`,
    );
    const n = visit.filter(([tool]) => tool !== "wait").length;
    console.log(
      `per move (no waits, ${n}): live ${(sum(live, notWait) / n / 1000).toFixed(3)} s, tape ${(sum(onTape, notWait) / n / 1000).toFixed(4)} s`,
    );
  } finally {
    await fixture.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.main, import.meta.url))
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
