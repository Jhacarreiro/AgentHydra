/**
 * tape-record.spec - the recorder's naming, typing and cleanup, with no crawl and no browser:
 *   - a screen's id and its controls' keys read URLs on the start's origin relative to it, so a local server on
 *     another port (lift-class start() listens on port 0) records the same ids and keys, and a tape is reused;
 *   - the value a box is given is chosen by its control type first: a list or a file gets none, a picker gets a
 *     value its type takes, and only a free-text box gets one its words ask for;
 *   - a recording that throws after the config's start() closes the server it started.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { controlsOf, defaultTyped, originOf, recordTape, relativeUrl, screenIdOf } from "../tape/record.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "sue-tape-record-spec-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The same class page as a portal on `port` serves it. */
const classPage = (port, lesson = "/lift/student/#/play/ai-what-is-ai-c") => ({
  url: `http://127.0.0.1:${port}/s?n=2`,
  title: "Your class",
  viewport: { width: 390, height: 844 },
  blocks: [{ text: `Open http://127.0.0.1:${port}/s?n=2 on your phone`, id: "b1" }],
  elements: [
    { id: "sue-1", role: "link", name: "Lesson 1", href: `http://127.0.0.1:${port}${lesson}` },
    { id: "sue-2", role: "link", name: "Help", href: "https://help.example.com/class" },
    { id: "sue-3", role: "button", name: "Start" },
  ],
});
const ALLOWED = ["127.0.0.1"];

test("a screen served on another port has the same id, its controls the same keys", () => {
  const [a, b] = [classPage(51001), classPage(62002)];
  const [oa, ob] = [originOf(a.url), originOf(b.url)];
  assert.equal(screenIdOf(a, oa), screenIdOf(b, ob));
  const keys = (inv, origin) => controlsOf(inv, {}, ALLOWED, origin).map((c) => c.key);
  assert.deepEqual(keys(a, oa), keys(b, ob));
  assert.deepEqual(keys(a, oa), [
    "link:Lesson 1@/lift/student/#/play/ai-what-is-ai-c",
    "link:Help@https://help.example.com/class",
    "button:Start",
  ]);
});

test("a different screen on the same origin keeps a different id", () => {
  const a = classPage(51001);
  const b = classPage(51001, "/lift/student/#/play/ai-other-c");
  assert.notEqual(screenIdOf(a, originOf(a.url)), screenIdOf(b, originOf(b.url)));
});

test("an origin is cut only where it ends: port 500 never eats port 5001", () => {
  assert.equal(relativeUrl("http://127.0.0.1:5001/x", "http://127.0.0.1:500"), "http://127.0.0.1:5001/x");
  assert.equal(relativeUrl("http://127.0.0.1:500", "http://127.0.0.1:500"), "/");
  assert.equal(relativeUrl("http://127.0.0.1:500/s?n=2", "http://127.0.0.1:500"), "/s?n=2");
  const a = { ...classPage(500), blocks: [{ text: "see http://127.0.0.1:5001/x" }] };
  const b = { ...classPage(500), blocks: [{ text: "see http://127.0.0.1:5002/x" }] };
  assert.notEqual(screenIdOf(a, "http://127.0.0.1:500"), screenIdOf(b, "http://127.0.0.1:500"));
});

test("a box's value is chosen by its control type before its words", () => {
  const typed = (inputType, name = "") => defaultTyped({ inputType, name });
  assert.equal(typed("select", "Country code"), null);
  assert.equal(typed("file", "Your name on the upload"), null);
  assert.equal(typed("checkbox", "Email me"), null);
  assert.equal(typed("time", "Start time code"), "09:30");
  assert.equal(typed("date", "Your name"), "1990-01-01");
  assert.equal(typed("datetime-local"), "1990-01-01T09:30");
  assert.equal(typed("month"), "1990-01");
  assert.equal(typed("week"), "1990-W01");
  assert.equal(typed("range", "Volume code"), "50");
  assert.equal(typed("color", "Name a colour"), "#336699");
  assert.equal(typed("number", "Phone"), "7");
  assert.equal(typed("email", "Code"), "tape@sue.test");
  // A free-text box still gets what its words ask for.
  assert.equal(typed("text", "Verification code"), "000000");
  assert.equal(typed(null, "E-mail"), "tape@sue.test");
  assert.equal(typed("text", "Date of birth"), "1990-01-01");
  assert.equal(typed("text", "First name"), "Sam");
  assert.equal(typed("text", "Anything"), "hello");
});

/** A config whose start() opens a real server; `opened` is it, so a test can see it closed. */
function startingConfig(url) {
  const box = { opened: null };
  box.config = {
    async start() {
      const server = http.createServer((_, res) => res.end("ok"));
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
      box.opened = server;
      return {
        url: url === undefined ? `http://127.0.0.1:${server.address().port}/` : url,
        stop: () => new Promise((ok) => server.close(ok)),
      };
    },
  };
  return box;
}

test("a recording that throws after start() closes the server it started", async () => {
  const noUrl = startingConfig(null);
  await assert.rejects(recordTape({ out: path.join(scratch, "a"), devices: ["phone"], config: noUrl.config }), /no start URL/);
  assert.equal(noUrl.opened.listening, false);

  const badDevice = startingConfig(undefined);
  await assert.rejects(
    recordTape({ out: path.join(scratch, "b"), devices: ["toaster"], config: badDevice.config }),
    /unknown device "toaster"/,
  );
  assert.equal(badDevice.opened.listening, false);
});
