// shared-detectors.spec.mjs - spec for the ONE CAPTCHA-frame pattern and the ONE
// browser-mode rule (review finding sue-body-duplicated-detectors). The inventory's frame regex had
// drifted from the pointer's CAPTCHA_FRAME (no arkoselabs, no geetest), so `look` never filed a
// captcha block for a FunCaptcha or GeeTest widget the pointer refuses; and browserModeFor was
// written out twice, in body.mjs and cannon.mjs. No browser needed: the inventory script is a string
// and the rule is pure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./fixtures/people.mjs";
import { browserArgsFor, browserModeFor } from "../lib/findings.mjs";
import { INVENTORY_SCRIPT } from "../lib/perception.mjs";
import { CAPTCHA_FRAME } from "../lib/rails.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the inventory's CAPTCHA frame check IS the pointer's CAPTCHA_FRAME", () => {
  assert.ok(
    INVENTORY_SCRIPT.includes(CAPTCHA_FRAME.source),
    "the inventory must interpolate CAPTCHA_FRAME.source, not carry a drifted regex of its own",
  );
  for (const src of [
    "https://www.google.com/recaptcha/api2/anchor",
    "https://newassets.hcaptcha.com/captcha/v1/x",
    "https://challenges.cloudflare.com/turnstile/v0/api.js",
    "https://cdn.arkoselabs.com/fc/api.js",
    "https://static.geetest.com/static/js/gt.0.4.9.js",
  ]) {
    assert.ok(CAPTCHA_FRAME.test(src), `a frame the pointer refuses must be a captcha to the inventory too: ${src}`);
  }
});

test("browserModeFor follows the host, and a target may pin it either way", () => {
  assert.equal(browserModeFor({ startUrl: "http://127.0.0.1:8080/" }), "headless");
  assert.equal(browserModeFor({ startUrl: "http://localhost:3000/" }), "headless");
  assert.equal(browserModeFor({ startUrl: "http://[::1]/" }), "headless");
  assert.equal(browserModeFor({ startUrl: "https://example.com/" }), "headed-offscreen");
  assert.equal(browserModeFor({ startUrl: "https://example.com/", browser: "headless" }), "headless");
  assert.equal(browserModeFor({ startUrl: "http://127.0.0.1/", browser: "headed-offscreen" }), "headed-offscreen");
  assert.equal(browserModeFor({}), "headed-offscreen", "an unparsable or absent start URL is not loopback");
});

test("a headless Sue draws on the GPU, never SwiftShader on the CPU", () => {
  const headless = browserArgsFor("headless", {});
  assert.ok(!headless.includes("--disable-gpu"), "--disable-gpu put every WebGL frame on the CPU (2026-09-23)");
  assert.ok(headless.includes("--enable-gpu") && headless.includes("--ignore-gpu-blocklist"));
  const cpu = browserArgsFor("headless", { SUE_RENDERING: "cpu" });
  assert.ok(cpu.includes("--disable-gpu") && !cpu.includes("--enable-gpu"), "the desktop app's CPU toggle is honoured");
  assert.ok(browserArgsFor("headed-offscreen").includes("--window-position=-32000,-32000"));
});

test("body.mjs and cannon.mjs use the one browserModeFor and browserArgsFor and define no copy", () => {
  for (const file of ["body.mjs", "cannon.mjs"]) {
    const source = readFileSync(path.join(here, "..", file), "utf8");
    assert.ok(source.includes("browserModeFor") && source.includes("browserArgsFor"), `${file} must use the shared rules`);
    assert.ok(!/function browser(Mode|Args)For\s*\(/.test(source), `${file} must not define its own copy`);
    assert.ok(!source.includes('"--disable-gpu"'), `${file} must take its Chrome flags from browserArgsFor`);
  }
});
