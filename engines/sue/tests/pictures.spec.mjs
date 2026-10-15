/**
 * pictures.spec - the picture a look hands her: smaller on a computer screen, a phone's unchanged.
 *
 * Measured 2026-09-24 on a text-heavy help page (scratchpad sue-scale/shots.mjs, the body's own
 * pipeline): a desktop look was 1356x847 at JPEG q55, 84 KB (112k base64 characters, ~1531 image
 * tokens). Capped at 1280 on the long side and encoded with mozjpeg at the same quality it is
 * 1280x800, 54 KB (72k base64, ~1365 tokens), and the smallest print on the page (11 px footnotes)
 * still reads. A phone's picture keeps its device-scale size and only gets the better encoder
 * (62 KB -> 44 KB). A 1280x800 canvas game stays exactly 1:1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import { PICTURE_JPEG, pictureFrame } from "../body.mjs";

test("a computer screen's picture is 1280 on the long side; a canvas stays 1:1; a phone's is unchanged", () => {
  assert.deepEqual(pictureFrame({ width: 1440, height: 900 }, 1), {
    width: 1280,
    height: 800,
    shrunk: true,
    perCssX: 1280 / 1440,
    perCssY: 800 / 900,
  });
  assert.deepEqual(pictureFrame({ width: 1280, height: 800 }, 1), { width: 1280, height: 800, shrunk: false, perCssX: 1, perCssY: 1 });
  const wide = pictureFrame({ width: 1920, height: 1080 }, 1);
  assert.equal(wide.width, 1280, "every desktop size meets the same cap");
  // Pixel 7 upright at its device scale: sized by the brain's own limits, as before (751x1530 on 2026-09-24).
  const phone = pictureFrame({ width: 412, height: 839 }, 2.625);
  assert.ok(Math.max(phone.width, phone.height) > 1280, `a phone keeps her device-scale picture: ${phone.width}x${phone.height}`);
  assert.ok(phone.width * phone.height <= 1_150_000 && Math.max(phone.width, phone.height) <= 1568);
});

test("her pictures are encoded with mozjpeg at quality 55: smaller for the same look", async () => {
  assert.deepEqual(PICTURE_JPEG, { quality: 55, mozjpeg: true });
  // Fine text on white, the case that decides legibility: the better encoder never costs bytes.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="#fff"/>${Array.from(
    { length: 40 },
    (_, i) =>
      `<text x="20" y="${20 + i * 19}" font-size="${11 + (i % 5)}" font-family="sans-serif">Line ${i}: Prices exclude VAT where it applies, refunded pro rata within 30 days.</text>`,
  ).join("")}</svg>`;
  const plain = await sharp(Buffer.from(svg)).jpeg({ quality: 55 }).toBuffer();
  const ours = await sharp(Buffer.from(svg)).jpeg(PICTURE_JPEG).toBuffer();
  assert.ok(ours.length < plain.length, `mozjpeg ${ours.length} B < plain ${plain.length} B`);
});
