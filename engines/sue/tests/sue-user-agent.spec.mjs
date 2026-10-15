import { test } from "node:test";
import assert from "node:assert/strict";

import "./fixtures/people.mjs";
import { contextOptions } from "../body.mjs";

const target = { id: "t", canvas: false };
const PROBE_UA = /\bConnections(?:SUE|AdsLinkProbe)\/\d/;

test("a Sue's browser names itself ConnectionsSUE on every device, so ARGUS can tell her from a customer", () => {
  for (const device of ["phone", "desktop"]) {
    const { userAgent } = contextOptions(device, target);
    assert.match(userAgent, PROBE_UA, `${device} UA`);
    assert.match(userAgent, /Chrome\/\d/, `${device} UA still reads as a browser`);
  }
});
