/**
 * pdf-viewer.spec - a PDF a Sue is sent to look at is shown as its pages, and the page is not blank.
 * ==================================================================================================
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 *
 * WHAT IT GUARDS: the headless Sue browser does not draw Chrome's built-in PDF viewer, so a PDF showed
 * as a grey frame. The viewer (lib/pdf-pages.mjs + lib/material.mjs pdfViewerPage) must give one
 * picture and one `Page N of M` heading per page, and a real browser must paint it.
 * WHO DEPENDS ON IT: nothing imports it; `node --test sue/tests/pdf-viewer.spec.mjs`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { pdfViewerPage } from "../lib/material.mjs";
import { renderPdfPages } from "../lib/pdf-pages.mjs";

async function threePagePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const word of ["First", "Second", "Third"]) {
    const page = doc.addPage([420, 594]);
    page.drawRectangle({ x: 40, y: 380, width: 340, height: 140, color: rgb(0.2, 0.5, 0.9) });
    page.drawText(`${word} page of the ad`, { x: 50, y: 300, size: 28, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

test("a three-page PDF becomes a viewer with three page pictures and three Page N of 3 headings", async () => {
  const pages = await renderPdfPages(await threePagePdf());
  assert.equal(pages.length, 3);
  for (const p of pages) assert.equal(p.jpeg[0], 0xff, `page ${p.n} is a JPEG`);
  assert.match(pages[0].text, /First page of the ad/);

  const html = pdfViewerPage({ title: "ad.pdf", pages });
  assert.equal((html.match(/<img /g) ?? []).length, 3);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`<h2>Page ${n} of 3</h2>`));
  assert.match(html, /<p class="text">First page of the ad<\/p>/);
});

test("the viewer paints in a real headless browser: its screenshot is not one flat colour", async () => {
  const pages = await renderPdfPages(await threePagePdf());
  const html = pdfViewerPage({ title: "ad.pdf", pages });
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    const shot = await page.screenshot({ type: "png" });
    const colours = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 17) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return seen.size;
    }, shot.toString("base64"));
    assert.ok(colours > 20, `the screenshot has ${colours} colours; a blank frame has one`);
  } finally {
    await browser.close();
  }
});
