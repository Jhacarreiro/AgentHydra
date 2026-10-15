/**
 * tests/fixtures/tape-read-through/click-first.mjs - one Sue in her own process, for tests/tape-read-through.spec.mjs:
 * `node click-first.mjs <sueDir>` opens the tape body over the sue.json in <sueDir>, looks, clicks "First", and prints
 * `{ screen }` (the screen she ended on) as one JSON line.
 */
import path from "node:path";

import { createTapeBody } from "../../../tape/body.mjs";
import { walk } from "../tape-body/make.mjs";

const body = await createTapeBody({ sueDir: path.resolve(process.argv[2]), log: () => {} });
await walk(body, [
  ["look", {}],
  ["click", { target: "First" }],
]);
console.log(JSON.stringify({ screen: body.screenId() }));
await body.shutdown();
process.exit(0);
