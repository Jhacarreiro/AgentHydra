/**
 * pdf-pages - a PDF as one picture per page, and each page's own text, rendered here on this computer.
 * ==================================================================================================
 *
 * Chrome's built-in PDF viewer draws nothing in the headless browser a Sue drives, so a PDF is shown
 * as a viewer page of images instead (lib/material.mjs pdfViewerPage). pdf.js and @napi-rs/canvas are
 * already installed with the workspace (packages/connections-ui); nothing here calls out to a service.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Each page is drawn this many CSS pixels wide: a legible page, whatever the window is. */
export const PAGE_WIDTH_PX = 1000;

async function loadPdfjs() {
  const require = createRequire(import.meta.url);
  return import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
}

/** A PDF's number of pages, or null when its bytes cannot be read as a PDF. */
export async function pdfPageCount(bytes) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  try {
    return (await task.promise).numPages;
  } catch {
    return null;
  } finally {
    await task.destroy();
  }
}

export async function renderPdfPages(bytes) {
  const require = createRequire(import.meta.url);
  const pdfjs = await loadPdfjs();
  const { createCanvas } = require("@napi-rs/canvas");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_WIDTH_PX / unit.width });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ n, width, height, jpeg: canvas.toBuffer("image/jpeg"), text });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
