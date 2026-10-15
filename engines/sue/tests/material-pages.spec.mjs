/**
 * material-pages.spec - the "may run to several pages" line is for a material that can have more than one page.
 * ==============================================================================================================
 *
 * WHAT IT GUARDS: MATERIAL_PAGES was added to every material a focus group is shown, so a one-page PDF and a
 * single picture were told to scroll through pages they do not have. materialMayRunToSeveralPages must say
 * yes for a PDF of several pages, no for a one-page PDF and a picture, and yes for a PDF whose page count
 * cannot be read (unknown is not one page).
 * WHO DEPENDS ON IT: sue.mjs withMaterialPages, which decides the line before the synchronous planRun.
 * `node --test sue/tests/material-pages.spec.mjs`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import { materialMayRunToSeveralPages, storeMaterial } from "../lib/material.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

async function pdfOfPages(count) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([420, 594]);
  return Buffer.from(await doc.save());
}

async function withWorkspace(run) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sue-material-pages-"));
  try {
    return await run(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("a one-page PDF gets no several-pages line", async () => {
  await withWorkspace(async (ws) => {
    const { id } = storeMaterial(ws, { name: "flyer.pdf", type: "application/pdf", bytes: await pdfOfPages(1) }, { port: 4000 });
    assert.equal(await materialMayRunToSeveralPages(ws, id), false);
  });
});

test("a three-page PDF gets the several-pages line", async () => {
  await withWorkspace(async (ws) => {
    const { id } = storeMaterial(ws, { name: "deck.pdf", type: "application/pdf", bytes: await pdfOfPages(3) }, { port: 4000 });
    assert.equal(await materialMayRunToSeveralPages(ws, id), true);
  });
});

test("a picture gets no several-pages line", async () => {
  await withWorkspace(async (ws) => {
    const { id } = storeMaterial(ws, { name: "poster.png", type: "image/png", bytes: PNG_BYTES }, { port: 4000 });
    assert.equal(await materialMayRunToSeveralPages(ws, id), false);
  });
});

test("a PDF whose page count cannot be read keeps the several-pages line", async () => {
  await withWorkspace(async (ws) => {
    const { id } = storeMaterial(
      ws,
      { name: "broken.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4 garbage") },
      { port: 4000 },
    );
    assert.equal(await materialMayRunToSeveralPages(ws, id), true);
  });
});

test("a typed idea keeps the several-pages line it has always had", async () => {
  await withWorkspace(async (ws) => {
    const { id } = storeMaterial(ws, { idea: "A one-line tagline for the bakery." }, { port: 4000 });
    assert.equal(await materialMayRunToSeveralPages(ws, id), true);
  });
});
