// Run 20261010-065644-e33d (4Man 67ab64f1): a Sue sent to upload a price-list PDF had no file, because no scenario carried a files folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { bringHerFiles, herFiles, SAMPLE_FILES_DIR } from "../lib/sample-files.mjs";

test("the shipped sample folder holds a real PDF, and every Sue is handed it with no scenario folder", () => {
  const got = herFiles({ id: "product" }, { id: "first-visit" });
  assert.ok(got.names.includes("price-list.pdf"), "a PDF to upload");
  assert.equal(readFileSync(got.sources["price-list.pdf"]).subarray(0, 5).toString(), "%PDF-");
  assert.equal(path.dirname(got.sources["price-list.pdf"]), SAMPLE_FILES_DIR);
});

test("a scenario's own file wins over a sample of the same name, and its other files come first-class", () => {
  const home = mkdtempSync(path.join(tmpdir(), "sue-samples-"));
  try {
    mkdirSync(path.join(home, "files", "ai-support"), { recursive: true });
    writeFileSync(path.join(home, "files", "ai-support", "price-list.pdf"), "her own");
    writeFileSync(path.join(home, "files", "ai-support", "faq.md"), "A tune-up is $65.\n");
    const got = herFiles({ id: "product", home }, { id: "ai-support" });
    assert.equal(readFileSync(got.sources["price-list.pdf"], "utf8"), "her own");
    assert.ok(got.names.includes("faq.md") && got.names.includes("logo.png"));
    assert.deepEqual(got.names, [...new Set(got.names)].sort(), "each name once, sorted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a scenario naming a folder that is missing is still refused, never papered over by the samples", () => {
  assert.throws(() => herFiles({ id: "product" }, { id: "x", files: "nope" }), /files folder .* does not exist/);
});

test("bringHerFiles copies every file into her folder and returns the names", () => {
  const sueDir = mkdtempSync(path.join(tmpdir(), "sue-dir-"));
  try {
    const names = bringHerFiles({ id: "product" }, { id: "first-visit" }, sueDir);
    assert.ok(names.includes("price-list.pdf"));
    assert.equal(
      readFileSync(path.join(sueDir, "files", "price-list.pdf"))
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    assert.ok(existsSync(path.join(sueDir, "files", "logo.png")));
  } finally {
    rmSync(sueDir, { recursive: true, force: true });
  }
});
