/**
 * tape/changed.mjs - the picture diff of a screen recorded again: the new screenshot with every changed pixel
 * painted red, so a screen that moved and should not have is seen before any student walks it (TAPE-PANEL.md:
 * "Every screen that changed and should not have is flagged"). It is kept for the re-record of a stale screen on a
 * miss, the piece built next (a tape is recorded as students reach it, never re-crawled to compare).
 */
import sharp from "sharp";

/** A channel this far apart (of 255) counts as a changed pixel; antialiasing noise stays under it. */
const PIXEL_TOLERANCE = 16;

/**
 * The picture diff of two screenshots: same size, the new picture faded with every changed pixel painted red;
 * different sizes, the old and new side by side. Resolves to { png, changedPixels, fraction, sameSize }.
 */
export async function pictureDiff(oldFile, newFile) {
  const [a, b] = await Promise.all([oldFile, newFile].map((f) => sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    const width = a.info.width + b.info.width + 8;
    const height = Math.max(a.info.height, b.info.height);
    const png = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
      .composite([
        { input: oldFile, left: 0, top: 0 },
        { input: newFile, left: a.info.width + 8, top: 0 },
      ])
      .png()
      .toBuffer();
    return { png, changedPixels: null, fraction: 1, sameSize: false };
  }
  const { width, height } = b.info;
  const out = Buffer.alloc(width * height * 4);
  let changed = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    const differs =
      Math.abs(a.data[i] - b.data[i]) > PIXEL_TOLERANCE ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > PIXEL_TOLERANCE ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > PIXEL_TOLERANCE;
    if (differs) {
      changed += 1;
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      out[i] = 160 + Math.round(b.data[i] * 0.35);
      out[i + 1] = 160 + Math.round(b.data[i + 1] * 0.35);
      out[i + 2] = 160 + Math.round(b.data[i + 2] * 0.35);
    }
    out[i + 3] = 255;
  }
  const png = await sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return { png, changedPixels: changed, fraction: changed / (width * height), sameSize: true };
}
