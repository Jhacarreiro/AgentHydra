// perception.spec.mjs - spec for lib/perception.mjs (see that file's header for why it exists).
// Launches a real headless chromium against the three committed fixtures, runs INVENTORY_SCRIPT
// in-page exactly as body.mjs's `look` tool will, and asserts both halves: the raw inventory
// (honeypot hidden, cc-number autocomplete, icon-only detection, font px, above-the-fold) and
// perceive() under three personas (grandma, tiktok, child) reading the same three dial-driven tags
// SPEC.md pins verbatim.
//
// @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of
// throwing (the whole SUE body runs on plain node for the same reason, body.mjs header).
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { INVENTORY_SCRIPT, perceive, seenName } from "../lib/perception.mjs";
import { pickByWords } from "../body.mjs";
import { screenOnly } from "../lib/reading-pace.mjs";

test("a file box with no words is named the way it draws itself, a Choose File button", () => {
  assert.equal(seenName({ role: "textbox", inputType: "file" }), "a Choose File button");
  assert.equal(seenName({ role: "textbox", inputType: "FILE" }), "a Choose File button", "the type attribute's case does not matter");
  assert.equal(seenName({ role: "textbox", inputType: "file", seenLabel: "Your document" }), "Your document", "a printed label still wins");
  assert.notEqual(seenName({ role: "textbox", inputType: "text" }), "a Choose File button", "a box to type in is never called one");
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "pages");

const grandma = { dials: { readingGrade: 8, wordsPerLook: 0, wordsPerMinute: 150, legibleMinPx: 15, techProwess: 1 } };
const tiktok = { dials: { readingGrade: 8, wordsPerLook: 40, wordsPerMinute: 300, legibleMinPx: 0, techProwess: 4 } };
const child = { dials: { readingGrade: 3, wordsPerLook: 0, wordsPerMinute: 150, legibleMinPx: 0, techProwess: 3 } };

async function withBrowser(fn) {
  const executablePath = resolveChromiumPath();
  const browser = await chromium.launch({ headless: true, executablePath: executablePath || undefined });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

async function inventoryOf(browser, fixtureName) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const url = pathToFileURL(path.join(fixturesDir, fixtureName)).href;
    await page.goto(url);
    return await page.evaluate(INVENTORY_SCRIPT);
  } finally {
    await page.close();
  }
}

test("inventory: hero.html - font px, above-fold, icon-only detection", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "hero.html");

    const heading = inventory.blocks.find((b) => b.kind === "heading");
    assert.ok(heading, "expected an h1 block");
    assert.equal(heading.fontPx, 40);
    assert.ok(heading.aboveFold, "headline should be above the fold");

    const legal = inventory.blocks.find((b) => b.text.includes("Terms of Service"));
    assert.ok(legal, "expected the legal paragraph block");
    assert.equal(legal.fontPx, 11);

    const searchButton = inventory.elements.find((e) => e.role === "button" && e.name === "search");
    assert.ok(searchButton, "expected the aria-labelled search button");
    assert.equal(searchButton.hasVisibleText, false);
    assert.equal(searchButton.iconOnly, true);

    const signInButton = inventory.elements.find((e) => e.role === "button" && e.name === "Sign in");
    assert.ok(signInButton, "expected the Sign in button");
    assert.equal(signInButton.hasVisibleText, true);
    assert.equal(signInButton.iconOnly, false);
  });
});

test("inventory: signup.html - honeypot hidden, cc-number autocomplete", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "signup.html");

    const honeypot = inventory.elements.find((e) => e.hidden === true);
    assert.ok(honeypot, "expected the honeypot input to be flagged hidden");

    const cardNumber = inventory.elements.find((e) => e.autocomplete === "cc-number");
    assert.ok(cardNumber, "expected the card-number field");
    assert.equal(cardNumber.hidden, false);

    const submit = inventory.elements.find((e) => e.role === "button" && e.name === "submit");
    assert.ok(submit, "expected the icon-only submit button");
    assert.equal(submit.iconOnly, true);

    const email = inventory.elements.find((e) => e.inputType === "email");
    assert.ok(email, "expected the email input");
    assert.equal(email.labelText, "Email");
    assert.equal(email.listTrigger, undefined, "a text box is never a list trigger");

    const month = inventory.elements.find((e) => e.name === "Pick a month");
    assert.ok(month, "expected the button-drawn month picker");
    assert.equal(month.role, "button");
    assert.equal(month.listTrigger, true, "a combobox button opens a list");
    assert.equal(submit.listTrigger, undefined);

    // Run 20260922-224205-261f: an icon font's ligature is a picture, not words, and a control with
    // a printed label is named by it, never "a picture button with no words".
    const birthMonth = inventory.elements.find((e) => e.seenLabel === "Birth month");
    assert.ok(birthMonth, "expected the labelled month picker");
    assert.equal(birthMonth.seenText, undefined, 'the "expand_more" glyph is not words she sees');
    assert.equal(birthMonth.iconOnly, false, "a printed label names it");
    assert.match(perceive(inventory, grandma).text, /\] Birth month/);

    // Run 20260923-060828-9797: a card whose real radio is screen-reader-only is numbered as the
    // card, the thing a person presses, and the hidden radio itself never is.
    const memoir = inventory.elements.filter((e) => e.name === "Memoir");
    assert.equal(memoir.length, 1, "one control, the card");
    assert.equal(memoir[0].role, "radio");
    assert.equal(memoir[0].hidden, false);
    assert.ok(!inventory.elements.some((e) => e.inputType === "radio" && e.hidden), "the hidden radio is not numbered");
    assert.ok(!inventory.blocks.some((b) => b.kind === "label" && b.text === "Memoir"), "the card is not read twice as a label");
  });
});

test("inventory: tables.html - cells, captions and code blocks are read, a cell's own paragraph once", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "tables.html");
    const texts = inventory.blocks.map((b) => `${b.kind}:${b.text}`);
    for (const expected of ["caption:Events we send", "cell:Event", "cell:Sent when", "cell:create", "cell:A ticket opens"]) {
      assert.ok(texts.includes(expected), `${expected} in ${JSON.stringify(texts)}`);
    }
    assert.ok(
      texts.some((t) => t.startsWith("code:") && t.includes('"event": "rename"')),
      JSON.stringify(texts),
    );
    assert.equal(texts.filter((t) => t.endsWith("A ticket closes")).length, 1, "the cell holding a paragraph is read once");
  });
});

// Run 20260926-121640-3a2f, office-manager, on the sign-up code email: "The footer tagline was
// printed twice". The mail carries it once; the shared email shell lays its footer out as a cell
// holding a table whose inner cell holds the words, and both cells were read.
test("inventory: an email's footer cell holding a cell is read once", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOfHtml(
      browser,
      '<table><tr><td class="cnx-pad"><table><tr><td><img src="data:," width="22" height="22" alt=""></td>' +
        "<td><strong>Connections</strong> &middot; Keep up with the people who matter most.</td></tr></table></td></tr></table>",
    );
    const tagline = inventory.blocks.filter((b) => b.text.includes("Keep up with the people who matter most."));
    assert.deepEqual(
      tagline.map((b) => `${b.kind}:${b.text}`),
      ["cell:Connections · Keep up with the people who matter most."],
    );
  });
});

test("inventory: legalese.html - two long paragraph blocks", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "legalese.html");
    const paragraphs = inventory.blocks.filter((b) => b.kind === "paragraph");
    assert.equal(paragraphs.length, 2);
    for (const p of paragraphs) assert.ok(p.wordCount > 40, "legalese paragraphs should be long");
  });
});

test(
  "a big box shows what it holds, never its hidden placeholder; a one-line box never shows its value",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 412, height: 839 } });
      try {
        await page.setContent(
          '<label for="rf">Your answer</label><textarea id="rf" placeholder="Write it your way"></textarea><input type="password" placeholder="Password">',
        );
        await page.fill("#rf", "A tool should work for everyone because");
        await page.fill("input", "hunter22");
        const view = perceive(await page.evaluate(INVENTORY_SCRIPT), { dials: { readingGrade: 12, wordsPerLook: 0, techProwess: 3 } });
        assert.match(
          view.text,
          /Your answer \[holding: "A tool should work for everyone because"\]/,
          "a sentence starter's words are on her screen",
        );
        assert.doesNotMatch(view.text, /Write it your way/, "the browser hides a placeholder once the box holds words");
        assert.doesNotMatch(view.text, /hunter22/, "a password never reaches a look");
      } finally {
        await page.close();
      }
    });
  },
);

test("a HUD shrunk by a CSS transform reads at its size on the glass, buttons included", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 412, height: 839 } });
    try {
      await page.setContent(
        '<div style="transform: scale(0.5); transform-origin: 0 0"><p style="font-size: 20px">Shrunk words</p><button style="font-size: 20px">ALL</button></div><p style="font-size: 20px">Plain words</p>',
      );
      const inventory = await page.evaluate(INVENTORY_SCRIPT);
      const shrunk = inventory.blocks.find((b) => b.text === "Shrunk words");
      const plain = inventory.blocks.find((b) => b.text === "Plain words");
      assert.deepEqual([shrunk.fontPx, plain.fontPx], [10, 20], "a transform halves the print she sees");
      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 14, techProwess: 3 } });
      assert.match(view.text, /ALL \[tiny print you can barely make out\]/, "a button's own words are held to her eyesight");
      assert.match(view.text, /Plain words/);
      assert.equal(view.stats.tinyText, 2);
    } finally {
      await page.close();
    }
  });
});

test("a block is as big as the words it shows: 17.5px words shrunk to 13px glass are legible, not the 12px box round them", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 412, height: 839 } });
    try {
      await page.setContent(
        '<p style="font-size: 16px; transform: scale(0.75); transform-origin: 0 0"><span style="font-size: 17.5px">Floated label words</span></p>',
      );
      const inventory = await page.evaluate(INVENTORY_SCRIPT);
      const label = inventory.blocks.find((b) => b.text === "Floated label words");
      assert.equal(label.fontPx, 13, "17.5px words at 0.75 are 13.1px on the glass, not the 16px box's 12px");
      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 13, techProwess: 3 } });
      assert.match(view.text, /Floated label words/);
      assert.equal(view.stats.tinyText, 0, "legible words are never called tiny print");
    } finally {
      await page.close();
    }
  });
});

test("a block is as tiny as the words it shows: 11px words in a 16px paragraph are tiny print", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 412, height: 839 } });
    try {
      await page.setContent('<p style="font-size: 16px"><span style="font-size: 11px">Tiny legal words</span></p>');
      const inventory = await page.evaluate(INVENTORY_SCRIPT);
      const legal = inventory.blocks.find((b) => b.text === "Tiny legal words");
      assert.equal(legal.fontPx, 11, "the words are 11px, not the paragraph's 16px");
      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 13, techProwess: 3 } });
      assert.match(view.text, /\[tiny print you cannot make out\]/);
      assert.equal(view.stats.tinyText, 1);
    } finally {
      await page.close();
    }
  });
});

test("a control is as big as the words on it, not the box round them", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 412, height: 839 } });
    try {
      await page.setContent(
        '<button style="font-size: 16px; transform: scale(0.75); transform-origin: 0 0"><span style="font-size: 17.5px">Pick me</span></button>',
      );
      const inventory = await page.evaluate(INVENTORY_SCRIPT);
      const button = inventory.elements.find((e) => e.role === "button" && e.name === "Pick me");
      assert.equal(button.fontPx, 13, "the words are 13.1px on the glass, not the button's 12px");
    } finally {
      await page.close();
    }
  });
});

test("perceive(): grandma sees the icon-only button and the tiny legal text as her tags", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "hero.html");
    const view = perceive(inventory, grandma);
    assert.match(view.text, /\[a small picture button with no words\]/);
    assert.match(view.text, /\[tiny print you cannot make out\]/);
    assert.ok(view.stats.tinyText >= 1);
  });
});

test("perceive(): tiktok's wordsPerLook cuts her off mid-page", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "legalese.html");
    const view = perceive(inventory, tiktok);
    assert.match(view.text, /\[\.\.\. you stopped reading here\]/);
    assert.equal(view.stats.truncated, true);
    assert.ok(view.stats.wordsShown <= tiktok.dials.wordsPerLook + 1);
  });
});

test("perceive(): child's low readingGrade cannot get through the legalese block", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "legalese.html");
    const view = perceive(inventory, child);
    assert.match(view.text, /\[this is hard to read - you skim it and are not sure what it means\]/);
    assert.ok(view.stats.overHead >= 1);
  });
});

test("perceive(): elements are numbered [1]..[n] and clickable maps back to data-sue-id", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "hero.html");
    const view = perceive(inventory, tiktok);
    assert.match(view.text, /\[1\]/);
    assert.ok(view.clickable.size >= 2, "hero.html has two buttons");
    for (const [number, id] of view.clickable) {
      assert.equal(typeof number, "number");
      assert.match(id, /^sue-\d+$/);
    }
  });
});

test("perceive(): techProwess 4-5 sees the URL bar; techProwess 1-2 never does", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "hero.html");
    const dev = perceive(inventory, tiktok); // techProwess: 4
    assert.match(dev.text, /\[address bar\]/);
    assert.match(dev.text, new RegExp(inventory.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const grandmaView = perceive(inventory, grandma); // techProwess: 1
    assert.doesNotMatch(grandmaView.text, /\[address bar\]/);
  });
});

// ⛔ THE SCRIM PAIR. A control behind an open dialog is displayed, opaque and on screen, so every
// visibility test here passed it and it stayed numbered - and office-manager pressed the page's
// "Get started" through a cookie modal, got nothing, and filed it as the product's broken button
// (run 20260922-090718-7a5f). These two pin the hit test from both ends: it must retire what the
// scrim covers, and it must NOT retire a control that is merely overlapped at one edge.
test("inventory: a control behind a scrim is marked, and the dialog's own are not", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "scrim.html");
    const byName = (name) => inventory.elements.find((e) => e.name === name);

    assert.ok(byName("Get started")?.behindOverlay, "the page's CTA is under the scrim and must say so");
    assert.match(byName("Get started").behindOverlay, /cookies/i, "it should name the dialog in the way, not a class");
    assert.ok(byName("See pricing")?.behindOverlay, "a link under the scrim is just as unreachable");

    assert.equal(byName("Accept all")?.behindOverlay, undefined, "the dialog's own buttons are on top");
    assert.equal(byName("Reject all")?.behindOverlay, undefined, "the dialog's own buttons are on top");
  });
});

test("inventory: a partly overlapped control stays clickable; a fully covered one does not", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "sticky-overlap.html");
    const byName = (name) => inventory.elements.find((e) => e.name === name);

    // The false-positive guard, and the reason the test samples nine points rather than the centre:
    // a person clicks the half of this button the sticky header is not sitting on.
    assert.equal(byName("Half covered")?.behindOverlay, undefined, "a partly overlapped control is still clickable");
    assert.equal(byName("Clear button")?.behindOverlay, undefined, "an ordinary control is never marked");
    assert.equal(byName("Menu")?.behindOverlay, undefined, "the header's own button is on top");

    // Unreachable, so it is never offered - but a sticky header is not a dialog, so it is COVERED,
    // never "behind" anything she has to deal with first.
    assert.equal(byName("Fully covered")?.covered, true, "a control entirely under the header is unreachable");
    assert.equal(byName("Fully covered")?.behindOverlay, undefined, "a sticky header is not something in front of the page");

    const view = perceive(inventory, tiktok);
    assert.ok(![...view.clickable.values()].includes(byName("Fully covered").id), "a covered control gets no number");
    assert.doesNotMatch(view.text, /behind/, "nothing is in front of this page, so she is never told something is");
  });
});

// ⛔ A FULL-SCREEN SHEET IS HER SCREEN, NOT SOMETHING IN FRONT OF IT. The host editor opens as a
// full-screen sheet over the events list, and every look inside it said "[the rest of the page is
// behind "open_in_new search Save DRAFT ..." - deal with that first]" (run 20260922-171336-3009): the
// list's controls were under the sheet, so the sheet was called a cover. She cannot see the list at
// all, so its controls are covered, silently; a see-through scrim (above) still dims a page she sees.
test(
  "inventory: the list under a full-screen sheet is covered, never behind anything, and the sheet is hers",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOf(browser, "sheet.html");
      const byName = (name) => inventory.elements.find((e) => e.name === name);
      assert.equal(byName("Open the picnic")?.covered, true, "the list under the sheet is out of sight");
      assert.equal(byName("Open the picnic")?.behindOverlay, undefined, "the sheet is her screen, not a dialog in front of it");
      for (const name of ["Save", "Publish"]) {
        assert.equal(byName(name)?.covered, undefined, `${name} is on the sheet`);
        assert.equal(byName(name)?.behindOverlay, undefined, `${name} is on the sheet`);
      }
      assert.doesNotMatch(perceive(inventory, tiktok).text, /behind/);
    });
  },
);

// ⛔ A LOCAL COVER IS NOT AN OVERLAY. MyConnect's phone header paints its search box over its own
// magnifier, and every signed-in phone look said "[the rest of the page is behind "something in front
// of the page" - deal with that first]": the hit test found the box on top of the magnifier and called
// it a scrim. A Sue went hunting for an invisible overlay and filed the menu as broken (runs
// 20260922-115216-aa5f, 20260922-133522-bbfb). Only a dialog, a menu, a banner or a screen-sized layer
// the control is not part of is "in front of the page"; anything else just covers that one control.
test(
  "inventory: a magnifier under its own search box is covered, never behind anything, and the box stays reachable",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOf(browser, "search-pill.html");
      const byName = (name) => inventory.elements.find((e) => e.name === name);
      const magnifier = byName("search");
      assert.ok(magnifier, "the fixture's magnifier is in the inventory");
      assert.equal(magnifier.behindOverlay, undefined, "the box painted over it is not a dialog");
      assert.equal(magnifier.covered, true, "a tap on it lands in the box, so it is not a thing of its own to press");

      for (const name of ["Search or ask", "Menu", "Copy link"]) {
        assert.equal(byName(name)?.behindOverlay, undefined, `${name} is behind nothing`);
        assert.equal(byName(name)?.covered, undefined, `${name} is on top`);
      }
    });
  },
);

test("perceive(): a covered control gets no number and no notice; the page around it reads as it is", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "search-pill.html");
    const view = perceive(inventory, tiktok);
    assert.doesNotMatch(
      view.text,
      /behind|deal with that first/,
      `nothing is in front of the page:
${view.text}`,
    );
    const numbered = [...view.clickable.values()];
    const idOf = (name) => inventory.elements.find((e) => e.name === name).id;
    assert.ok(!numbered.includes(idOf("search")), "the magnifier under the box gets no number");
    for (const name of ["Search or ask", "Menu", "Copy link"]) assert.ok(numbered.includes(idOf(name)), `${name} keeps its number`);
  });
});

test("perceive(): a blocked control gets no number, and she is told once what is in the way", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "scrim.html");
    const blocked = inventory.elements.filter((e) => e.behindOverlay);
    assert.ok(blocked.length >= 2, "the fixture must have more than one covered control, to prove 'once'");

    const view = perceive(inventory, tiktok);
    for (const id of view.clickable.values()) {
      assert.ok(!blocked.some((el) => el.id === id), "a control behind the dialog must not be reachable by number - that is the whole bug");
    }
    // Said once for the whole covered page, not once per control.
    const notices = view.text.split("\n").filter((line) => line.includes("behind"));
    assert.equal(notices.length, 1, `expected one 'behind' notice, got ${notices.length}`);
    assert.match(notices[0], /deal with that first/);

    // And the dialog's own controls are still numbered, or she could never get out of it.
    const numbered = [...view.clickable.values()];
    assert.ok(numbered.includes(inventory.elements.find((e) => e.name === "Accept all").id), "the dialog stays usable");
  });
});

test("perceive(): hidden elements (honeypot) never reach her view or clickable map", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "signup.html");
    const honeypot = inventory.elements.find((e) => e.hidden === true);
    assert.ok(honeypot, "expected the honeypot input in the raw inventory");

    const view = perceive(inventory, tiktok);
    assert.doesNotMatch(view.text, /hidden/i);
    for (const id of view.clickable.values()) {
      assert.notEqual(id, honeypot.id, "honeypot must not be clickable by number");
    }
  });
});

// Lift's Spanish-speaking student (2026-10-01): Flesch-Kincaid is an English formula, and it graded plain Spanish
// as over a teenager's head, so she was shown a first sentence and "[this is hard to read ...]" for ordinary words.
test("perceive(): a Spanish page is graded as Spanish reading, so plain Spanish is read whole", () => {
  const text =
    "No se parecía a lo que la IA aprendió. Un filtro así aprende con ensayos que ganaron antes y califica los nuevos según qué tanto se les parecen. Casi ningún ganador mezclaba idiomas, así que el de ella salió bajo.";
  const page = (lang) => ({
    url: "https://example.test/",
    title: "t",
    lang,
    viewport: { w: 390, h: 844 },
    scroll: { y: 0, max: 0 },
    blocks: [
      { id: "sue-1", order: 1, kind: "paragraph", text, fontPx: 16, aboveFold: true, wordCount: text.split(" ").length, bottom: 200 },
    ],
    elements: [],
  });
  const sixthGrader = { dials: { readingGrade: 6, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } };
  assert.ok(perceive(page("es"), sixthGrader).text.includes(text), "on a Spanish page she reads the paragraph whole");
  assert.match(perceive(page("en"), sixthGrader).text, /this is hard to read/, "the same words measured as English read as over her head");
});

test("perceive(): her eyes start at the screen, so a skimmer who scrolls reads what is below", () => {
  // A synthetic inventory after scrolling one screen down: the hero (bottom -400) is above the
  // screen, the sticky header's link (y 0) and the pricing section are on it. Until 2026-09-21 a
  // wordsPerLook reader re-read the hero on every look and never reached the pricing button.
  const skimmer = { dials: { readingGrade: 12, wordsPerLook: 12, legibleMinPx: 0, techProwess: 3 } };
  const inventory = {
    url: "http://localhost/",
    title: "t",
    scroll: { y: 900, max: 4000 },
    blocks: [
      { id: "1", kind: "heading", level: 1, text: "The hero headline nobody needs to read twice", fontPx: 40, wordCount: 8, bottom: -400 },
      { id: "4", kind: "heading", level: 2, text: "Pricing", fontPx: 30, wordCount: 1, bottom: 120 },
      { id: "5", kind: "paragraph", text: "Free to start. Premium is eight dollars a month.", fontPx: 16, wordCount: 9, bottom: 200 },
    ],
    elements: [
      { id: "2", role: "link", name: "Home", hasVisibleText: true, rect: { x: 0, y: 0, w: 60, h: 20 } },
      { id: "3", role: "link", name: "Hero button", hasVisibleText: true, rect: { x: 0, y: -500, w: 60, h: 20 } },
      { id: "6", role: "link", name: "Start free", hasVisibleText: true, rect: { x: 0, y: 260, w: 60, h: 20 } },
    ],
  };
  const view = perceive(inventory, skimmer);
  assert.match(view.text, /scrolled partway down/);
  assert.doesNotMatch(view.text, /hero headline/, "what she scrolled past is out of view");
  assert.doesNotMatch(view.text, /Hero button/);
  assert.match(view.text, /Pricing/);
  assert.match(view.text, /\[1\] Home/, "a header still on screen stays");
  assert.deepEqual(
    view.stats.readBlocks.map((b) => b.words),
    [1, 9],
  );
  // Nothing was cut off, so the pricing button is numbered and clickable.
  assert.equal([...view.clickable.values()].includes("6"), true);
});

test("perceive(): a reader out of words still sees and numbers the controls on her screen", () => {
  // A Discord ticket: the channel's words come first in the page, the message box last. A distracted
  // Sue (wordsPerLook 12) ran out of words before it and never got a number (run 20260922-113917-5468).
  const skimmer = { dials: { readingGrade: 12, wordsPerLook: 12, legibleMinPx: 0, techProwess: 3 } };
  const inventory = {
    url: "https://discord.com/channels/1/2",
    title: "t",
    viewport: { w: 1280, h: 900 },
    scroll: { y: 0, max: 0 },
    blocks: [
      {
        id: "1",
        kind: "paragraph",
        text: "Welcome to the ticket. Support will be with you shortly, please describe your problem in as much detail as you can.",
        fontPx: 16,
        wordCount: 21,
        bottom: 200,
      },
      { id: "3", kind: "paragraph", text: "Words below the fold she never reads.", fontPx: 16, wordCount: 7, bottom: 1400 },
    ],
    elements: [
      { id: "2", role: "button", name: "Close", hasVisibleText: true, rect: { x: 0, y: 240, w: 60, h: 20 } },
      { id: "4", role: "link", name: "Below the screen", hasVisibleText: true, rect: { x: 0, y: 1300, w: 60, h: 20 } },
      { id: "6", role: "link", name: "A link in the words", hasVisibleText: true, rect: { x: 0, y: 300, w: 60, h: 20 } },
      { id: "5", role: "textarea", name: "Message #ticket-6", labelText: "Message #ticket-6", rect: { x: 300, y: 800, w: 900, h: 44 } },
    ],
  };
  const view = perceive(inventory, skimmer);
  assert.equal(view.stats.truncated, true);
  assert.match(view.text, /you stopped reading here/);
  assert.doesNotMatch(view.text, /never reads/, "words after the cut stay unread");
  assert.equal([...view.clickable.values()].includes("2"), true, "a button on her screen keeps its number");
  assert.equal([...view.clickable.values()].includes("5"), true, "so does the message box at the bottom of it");
  assert.equal([...view.clickable.values()].includes("4"), false, "a control below the screen does not");
  assert.equal([...view.clickable.values()].includes("6"), true, "nor is a link on her screen dropped: it is a control she can see");
});

// The kit's spam honeypot (PublicSpamHoneypot.vue) is a faded 1-px box pushed 10,000 px off the page's
// left edge, and its field's placeholder label says "Leave this field empty". The field was already
// hidden, but the label's words reached her reading: cleaning-rosa read it as a line of the live sign-up
// form and asked "what field?" (run 20260927-090530-2886). No scroll reaches the left of the page.
test(
  "perceive(): words pushed off the page's left edge, like the kit's honeypot label, are never read",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<h1>Create an account</h1>
       <div style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden;opacity:0" aria-hidden="true">
         <label>Leave this field empty <input name="form_integrity_check" tabindex="-1"></label>
       </div>
       <label>First name <input name="first"></label>`,
      );
      const view = perceive(inventory, tiktok);
      assert.match(view.text, /First name/);
      assert.doesNotMatch(view.text, /Leave this field empty/);
    });
  },
);

// Lift's simulated students, three rounds running (kids' rounds 18 to 20): "it never told me if I got my answers
// right so it felt like tapping for nothing". The lesson said "Yes!" under every pick, in a plain <div>, and only
// headings, paragraphs, list items and cells were read. The same rounds called a folded card "a wall of text": the
// words inside a closed "More" were read as if they were on the screen.
test("inventory: words in a plain box are read once; what a closed <details> folds away is not", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOfHtml(
      browser,
      `<button type="button">Add many mango photos</button>
       <div class="feedback"><span aria-hidden="true">☀️</span><div class="fb-text"><b>Yes!</b> That is how real apps get <a href="/fixed">fixed</a> too.</div></div>
       <div class="idea"><p>An AI tool learns from examples.</p>
         <details><summary>More</summary><p>If the examples leave people out, the tool works worse for them.</p><button type="button">Tell me why</button></details>
       </div>
       <div class="card"><b>Show your teacher</b><br><span>Finished the lesson</span><details><summary>Read the story</summary>She tested five tools.</details></div>`,
    );
    const texts = inventory.blocks.map((b) => b.text);
    assert.deepEqual(
      texts.filter((t) => t.includes("Yes!")),
      ["Yes! That is how real apps get fixed too."],
      `the line in the plain box is one block, its link's words in place: ${JSON.stringify(texts)}`,
    );
    assert.equal(
      texts.filter((t) => t.includes("An AI tool learns from examples.")).length,
      1,
      "a paragraph inside a box is still read once",
    );
    assert.ok(!texts.some((t) => t.includes("works worse for them")), `folded words are not on her screen: ${JSON.stringify(texts)}`);
    assert.ok(
      !texts.some((t) => t.includes("She tested five tools")),
      `nor are loose words inside a closed fold: ${JSON.stringify(texts)}`,
    );
    assert.ok(texts.includes("Show your teacher Finished the lesson"), `a line break reads as a space: ${JSON.stringify(texts)}`);
    const view = perceive(inventory, grandma);
    assert.match(view.text, /\] More/, "the fold's own handle is still hers to press");
    assert.doesNotMatch(view.text, /Tell me why/, "a button inside the fold gets no number");
  });
});

test(
  "inventory: a marquee's copies outside its overflow-hidden strip are not on her screen; the in-box copy is",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const copy = '<span class="logo" style="flex:none;width:300px">Acme Guild</span>';
      const inventory = await inventoryOfHtml(
        browser,
        `<div class="strip" style="overflow:hidden;width:300px;height:40px">
         <div class="track" style="display:flex;width:max-content">${copy}${copy}${copy}</div>
       </div>`,
      );
      const reads = inventory.blocks.filter((b) => b.text.includes("Acme Guild"));
      assert.equal(reads.length, 1, `only the copy inside the strip's box is read: ${JSON.stringify(inventory.blocks.map((b) => b.text))}`);
    });
  },
);

test(
  "inventory: a marquee in an overflow-x:auto viewport with aria-hidden inert copies reads only the tiles inside the viewport",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const tiles = ["Electronic Arts 2,500 members", "Washiez 88,000 members"]
        .map((t) => {
          const [name, ...rest] = t.split(" ");
          const count = rest.slice(-2).join(" ");
          const label = [name, ...rest.slice(0, -2)].join(" ");
          return `<li style="flex:none;width:200px;list-style:none"><a href="#x"><span class="mark" style="display:block;width:20px;height:20px"></span><span class="txt">${label}<span style="display:block">${count}</span></span></a></li>`;
        })
        .join("");
      const row = (extra) => `<ul class="hp-marqrow" ${extra} style="display:flex;flex:none;margin:0;padding:0;width:400px">${tiles}</ul>`;
      const inventory = await inventoryOfHtml(
        browser,
        `<section class="hp-marq"><div class="hp-marqbox"><div class="hp-marqviewport" style="overflow-x:auto;overflow-y:hidden;width:400px;height:40px">
         <div class="hp-marqtrack" style="display:flex;width:max-content">${row("")}${row('aria-hidden="true" inert')}${row('aria-hidden="true" inert')}</div>
       </div></div></section>`,
      );
      const texts = inventory.blocks.map((b) => b.text).join(" | ");
      assert.equal(texts.split("Washiez 88,000 members").length - 1, 1, `Washiez read once: ${texts}`);
      assert.equal(texts.split("Electronic Arts 2,500 members").length - 1, 1, `Electronic Arts read once: ${texts}`);
    });
  },
);

/** The inventory of a page given as HTML, in a real headless chromium. */
async function inventoryOfHtml(browser, html) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${html}</body></html>`);
    return await page.evaluate(INVENTORY_SCRIPT);
  } finally {
    await page.close();
  }
}

const CHANNELS = '<option value="">Pick a channel</option><option>#general</option><option>#get-help</option>';

test(
  "inventory: look-alike drop-downs are named by their labels, then by what they show, with their choices beside them",
  { concurrency: false },
  async () => {
    // Run 20260922-063426-626a: four channel pickers with the same options were each named by every
    // option run together, read as one box, and a Sue's choice landed in the wrong one.
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<label>Log channel <select>${CHANNELS}</select></label>
       <label for="t">Transcript channel</label><select id="t">${CHANNELS}</select>
       <select aria-label="Welcome channel">${CHANNELS}</select>
       <span id="a">Alerts channel</span><select aria-labelledby="a">${CHANNELS}</select>
       <select title="Archive channel">${CHANNELS}</select>
       <select><option>English (UK)</option><option selected>Español</option></select>`,
      );
      const lists = inventory.elements.filter((e) => e.role === "select");
      assert.deepEqual(
        lists.map((e) => e.name),
        ["Log channel", "Transcript channel", "Welcome channel", "Alerts channel", "Archive channel", "Español"],
        "a label first, and a list with none is called by what it shows",
      );
      assert.deepEqual(lists[0].options, ["Pick a channel", "#general", "#get-help"]);
      assert.equal(lists[0].selected, "Pick a channel");
      assert.equal(lists[0].labelText, "Log channel", "a wrapping label's own words, never the options it holds");
      assert.ok(
        inventory.blocks.every((b) => !/#general/.test(b.text)),
        `no text block repeats the options: ${JSON.stringify(inventory.blocks.map((b) => b.text))}`,
      );

      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } });
      for (const name of ["Log channel", "Transcript channel", "Alerts channel"])
        assert.match(
          view.text,
          new RegExp(`\\] ${name} \\[a drop-down list showing "Pick a channel": Pick a channel, #general, #get-help\\]`),
        );
      // An aria-label and a title are on no screen, so she sees those two lists the way a sighted
      // person does: by what they show (Owner, 2026-09-22, the hidden-label ruling in perception.mjs).
      assert.doesNotMatch(view.text, /Welcome channel|Archive channel/);
      assert.equal(view.text.match(/\] Pick a channel \[a drop-down list: #general, #get-help\]/g)?.length, 2);
      assert.match(view.text, /\] Español \[a drop-down list: English \(UK\)\]/);
    });
  },
);

test(
  "inventory: a page's own options, menu items, tabs, switches, boxes and links are numbered like its buttons",
  { concurrency: false },
  async () => {
    // Run 20260922-063426-626a: a settings search's [role=option] results were never numbered, and a
    // Sue had to point at raw pixels to open "Access tokens".
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<input role="combobox" aria-label="Search settings">
       <ul role="listbox"><li role="option">Access tokens</li><li role="option" aria-disabled="true">Billing</li></ul>
       <div role="menu"><div role="menuitem">Rename</div><div role="menuitemcheckbox">Pin</div><div role="menuitemradio">Compact</div></div>
       <div role="menu" style="display:none"><div role="menuitem">Delete server</div></div>
       <button role="tab">Create</button>
       <span id="dm">Dark mode</span><div role="switch" aria-labelledby="dm" tabindex="0"></div>
       <input type="checkbox" role="switch" aria-label="Notify me">
       <div role="checkbox" aria-label="Remember me"></div><div role="radio">Weekly</div>
       <span role="link" tabindex="0">Help centre</span>`,
      );
      const byName = (name) => inventory.elements.find((e) => e.name === name);
      assert.equal(byName("Search settings")?.role, "input", "a text box keeps its own role whatever it says");
      const expected = {
        "Access tokens": "option",
        Billing: "option",
        Rename: "menuitem",
        Pin: "menuitemcheckbox",
        Compact: "menuitemradio",
        Create: "tab",
        "Dark mode": "switch",
        "Notify me": "switch",
        "Remember me": "checkbox",
        Weekly: "radio",
        "Help centre": "link",
      };
      for (const [name, role] of Object.entries(expected))
        assert.equal(byName(name)?.role, role, `${name}: ${JSON.stringify(byName(name))}`);
      assert.equal(byName("Billing").disabled, true, "aria-disabled greys a widget out");
      assert.equal(byName("Delete server")?.hidden, true, "a closed menu's items are not there to see");
      assert.equal(
        inventory.blocks.some((b) => b.text === "Access tokens"),
        false,
        "an option in a list is a thing to click, not a line to read twice",
      );

      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } });
      // Named only by words on the screen: the two aria-label-only widgets read as what they look like.
      const seen = Object.keys(expected).filter((name) => !["Notify me", "Remember me"].includes(name));
      for (const name of seen) assert.match(view.text, new RegExp(`\\[\\d+\\] ${name}`));
      assert.doesNotMatch(view.text, /Notify me|Remember me|Search settings/);
      assert.match(view.text, /\[\d+\] \[an on\/off switch with no words\]/);
      assert.match(view.text, /\[\d+\] \[a tick box with no words\]/);
      assert.match(view.text, /\[\d+\] \[a box to type in\]/);
      assert.match(view.text, /\] Billing \[greyed out\]/);
      assert.doesNotMatch(view.text, /Delete server/);
    });
  },
);

test("perceive(): a drop-down reads as a list of choices, and a disabled button reads greyed out", () => {
  const view = perceive(
    {
      url: "http://localhost/",
      title: "t",
      blocks: [],
      elements: [
        { id: "1", role: "select", name: "Pick a channel\n#general\n#create-ticket", hasVisibleText: true },
        { id: "2", role: "button", name: "Save panel", hasVisibleText: true, disabled: true },
      ],
    },
    { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } },
  );
  assert.match(view.text, /\[1\] Pick a channel \[a drop-down list: #general, #create-ticket\]/);
  assert.match(view.text, /\[2\] Save panel \[greyed out\]/);
});

test(
  "inventory: a hidden label never reaches her - an upvote arrow is a picture, at every level of tech skill",
  { concurrency: false },
  async () => {
    // Owner, 2026-09-22: a page must not need "hidden HTML element labels" for Sue, and Sue must not
    // be handed one: "I don't want the AIs seeing a label that says button here ... when a human
    // would have no idea what to do." The arrow, the sr-only word and the tooltip are all invisible
    // words; the visible "Reply" and a printed <label> are what a person reads.
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<button aria-label="Upvote u/bob" title="Upvote"><svg width="16" height="16"><path d="M8 2 L14 12 L2 12 Z"/></svg></button>
         <button><svg width="16" height="16"><path d="M2 4 L14 4"/></svg><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Downvote u/bob</span></button>
         <button>Reply</button>
         <label for="c">Your comment</label><input id="c">
         <input aria-label="Secret field name">`,
      );
      for (const techProwess of [1, 3, 5]) {
        const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess } });
        assert.doesNotMatch(view.text, /Upvote|Downvote|u\/bob|Secret field/, `techProwess ${techProwess}: ${view.text}`);
        assert.match(view.text, /\] Reply/);
        assert.match(view.text, /\] Your comment/);
      }
      // The inventory itself still knows the page's own name for the arrow, for the report we read.
      assert.equal(inventory.elements.find((e) => e.iconOnly)?.name, "Upvote u/bob");
    });
  },
);

test("inventory: a chat app's editable message box is numbered as a text box, by its label", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.setContent(
        "<main><p>Welcome to #ticket-3</p>" +
          '<div role="textbox" contenteditable="true" aria-label="Message #ticket-3"><span>half a sentence</span></div>' +
          '<div contenteditable="true" title="Notes"></div>' +
          '<div contenteditable="false">read only</div></main>',
      );
      const inv = await page.evaluate(INVENTORY_SCRIPT);
      const boxes = inv.elements.filter((e) => e.role === "textarea");
      assert.deepEqual(
        boxes.map((e) => e.name),
        ["Message #ticket-3", "Notes"],
        "both editable boxes are numbered, named by their label and never by the text typed so far",
      );
      assert.equal(
        inv.elements.some((e) => e.name === "read only"),
        false,
        "contenteditable=false is not a box",
      );
    } finally {
      await page.close();
    }
  });
});

test("inventory: a control inside an inert picture gets no number, and its words are still read", { concurrency: false }, async () => {
  // Run 20260922-133522-c2bd: the homepage's sample workspace is a pixel-accurate app screenshot
  // marked `inert`, so no click, hover or focus can land on it. We numbered its buttons anyway,
  // ten Sues pressed "[20] Events", the click timed out, the page shook while Playwright retried,
  // and they filed "a picture pretending to be buttons" against the site.
  await withBrowser(async (browser) => {
    const inventory = await inventoryOfHtml(
      browser,
      `<div inert><button>Events</button><a href="/host">Host</a><p>Founder dinner</p></div>
       <button>Get started</button>`,
    );
    assert.deepEqual(
      inventory.elements.map((e) => e.name),
      ["Get started"],
      "only a control a click can reach is numbered",
    );
    const words = inventory.blocks.map((b) => b.text);
    for (const seen of ["Events", "Host", "Founder dinner"])
      assert.ok(words.includes(seen), `she still reads "${seen}": ${JSON.stringify(words)}`);
  });
});

// A page still loading LOOKS like it is loading: the tab's spinner turns and a bar runs across the top.
// Her look had no such thing, so a white screen a moment after a click read as a dead page, and a
// Sue filed "blank white page" one second after pressing Get started, while the sign-up page was
// still arriving (run 20260922-133522-c2bd, sue-3698-tiktok).
test("perceive(): a page that has not finished loading says so; a loaded one never does", () => {
  const empty = { url: "https://example.test/signin", title: "Accounts", blocks: [], elements: [], viewport: { w: 412, h: 839 } };
  assert.match(perceive({ ...empty, loading: true }, tiktok).text, /\[the page is still loading\]/);
  assert.doesNotMatch(perceive({ ...empty, loading: false }, tiktok).text, /still loading/);
  assert.doesNotMatch(perceive(empty, grandma).text, /still loading/, "an inventory that does not say is not loading");
});

test("inventory: a page that has loaded is not loading", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOf(browser, "hero.html");
    assert.equal(inventory.loading, false);
  });
});

// A sighted visitor sees a form inside a web component or a same-origin frame like any other, so her
// look must too: the inventory used to walk only document.body and never entered either.
test(
  "inventory: controls in an open shadow root and a same-origin frame are read and numbered; a closed root stays shut",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<h1>Contact us</h1>
         <div id="open-host"></div>
         <div id="closed-host"></div>
         <iframe title="Frame form" style="width: 400px; height: 160px; margin-top: 200px" srcdoc="<p>Frame words</p><label>Frame name <input></label><button>Frame send</button>"></iframe>
         <script>
           document.getElementById("open-host").attachShadow({ mode: "open" }).innerHTML =
             "<p>Shadow words</p><label>Shadow name <input></label><button>Shadow send</button>";
           document.getElementById("closed-host").attachShadow({ mode: "closed" }).innerHTML = "<button>Closed send</button>";
         </script>`,
      );
      // A box is named by the label printed beside it (`seenName`), a button by its own words.
      const byName = (name) => inventory.elements.find((e) => seenName(e) === name);
      for (const name of ["Shadow name", "Shadow send", "Frame name", "Frame send"])
        assert.ok(byName(name), `"${name}" is in her inventory`);
      assert.equal(byName("Closed send"), undefined, "a closed shadow root stays shut");

      const view = perceive(inventory, { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } });
      for (const name of ["Shadow name", "Shadow send", "Frame name", "Frame send"]) {
        const line = new RegExp(`\\[(\\d+)\\][^\\n]*${name}`).exec(view.text);
        assert.ok(line, `"${name}" is numbered in her look:\n${view.text}`);
        assert.equal(view.clickable.get(Number(line[1])), byName(name).id, `[${line[1]}] maps back to "${name}"`);
      }
      assert.match(view.text, /Shadow words/);
      assert.match(view.text, /Frame words/);
      assert.ok(byName("Frame send").rect.y >= 200, "a frame's control sits where the frame sits on her screen");
    });
  },
);

// Lift's class round, 2026-10-03: a student read "this shark photo is forwarded to the chat. Best proof it's fake?"
// and wrote "wait I dont even see a shark photo?" while the photo filled half her screen. The words said nothing
// where a picture sat, so the driver never knew to open the screenshot.
test(
  "inventory + perceive(): a big picture reads '[a picture]' where it sits; small, on a button, broken or hidden ones do not",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOf(browser, "pictures.html");
      const pictures = inventory.blocks.filter((b) => b.kind === "picture");
      assert.equal(pictures.length, 3, `the photo, the canvas and the background-image box: ${JSON.stringify(pictures)}`);
      for (const p of pictures) assert.deepEqual([p.text, p.wordCount], ["", 0], "a picture carries no words");

      const view = perceive(inventory, child);
      const lines = view.text.split("\n");
      const question = lines.findIndex((l) => l.includes("Best proof it is fake?"));
      assert.equal(lines[question + 1], "[a picture]", `right after the question's words:\n${view.text}`);
      assert.equal(
        lines.filter((l) => l === "[a picture]").length,
        3,
        `no line for the icon, the button's image, the broken or the hidden one:\n${view.text}`,
      );
      assert.doesNotMatch(view.text, /SECRET/, "no alt, aria-label or title text reaches her words");
      assert.equal(
        view.stats.wordsTotal,
        perceive({ ...inventory, blocks: inventory.blocks.filter((b) => b.kind !== "picture") }, child).stats.wordsTotal,
      );
    });
  },
);

test(
  "perceive(): a picture still on her screen keeps its line after her words run out; one scrolled past or below is gone",
  { concurrency: false },
  async () => {
    const stopsEarly = { dials: { readingGrade: 12, wordsPerLook: 3, legibleMinPx: 0, techProwess: 3 } };
    await withBrowser(async (browser) => {
      const inventory = await inventoryOf(browser, "pictures.html");
      const view = perceive(inventory, stopsEarly);
      assert.match(view.text, /you stopped reading here/);
      assert.equal(view.text.split("\n").filter((l) => l === "[a picture]").length, 3, `all three are on her 900px screen:\n${view.text}`);
      assert.doesNotMatch(view.text, /Small things/, "her words still stop");
    });
    const base = { url: "https://example.test/", title: "t", elements: [], viewport: { w: 400, h: 800 } };
    const words = { id: "sue-1", order: 1, kind: "paragraph", text: "one two three four five", wordCount: 5, aboveFold: true, bottom: 40 };
    const picture = (id, order, aboveFold, bottom) => ({ id, order, kind: "picture", text: "", wordCount: 0, aboveFold, bottom });
    const text = perceive(
      { ...base, blocks: [words, picture("sue-2", 2, true, 300), picture("sue-3", 3, false, 1500), picture("sue-4", 4, false, -20)] },
      stopsEarly,
    ).text;
    assert.equal(text.split("\n").filter((l) => l === "[a picture]").length, 1, `only the one on her screen:\n${text}`);
  },
);

// A picture is what is PAINTED: a 16 px tile on a big div is a speck, an image that never loaded paints nothing, and a
// photo on a numbered choice card belongs to the card (the card is numbered; it has no "[a picture]" line of its own).
test(
  "inventory: a picture block is what is painted - loaded, drawn 80 by 80 or more, not on a choice card - and carries its top",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(pathToFileURL(path.join(fixturesDir, "pictures-painted.html")).href);
        await page.evaluate(INVENTORY_SCRIPT); // a url() background's image is resolved on the first look and read on the next
        const inventory = await page.evaluate(INVENTORY_SCRIPT);
        const pictureOn = async (selector) => {
          const id = await page.getAttribute(selector, "data-sue-id");
          return inventory.blocks.find((b) => b.kind === "picture" && b.id === id);
        };
        assert.equal(await pictureOn("#cardphoto"), undefined, "a photo on a hidden-radio choice card is part of the card");
        assert.equal(await pictureOn("#speck"), undefined, "a 16 px no-repeat tile at background-size auto paints a speck");
        assert.ok(await pictureOn("#cover"), "the same div at background-size cover paints the box");
        assert.ok(await pictureOn("#tiled"), "a repeating background tiles the whole box");
        assert.equal(await pictureOn("#never"), undefined, "a background url that never loads paints nothing");

        const pictures = inventory.blocks.filter((b) => b.kind === "picture");
        assert.equal(pictures.length, 2, JSON.stringify(pictures));
        for (const p of pictures) {
          assert.equal(typeof p.top, "number");
          assert.ok(p.top < p.bottom, `top ${p.top} is above bottom ${p.bottom}`);
        }
        const lines = perceive(inventory, child).text.split("\n");
        assert.equal(lines.filter((l) => l === "[a picture]").length, 2, lines.join("\n"));
      } finally {
        await page.close();
      }
    });
  },
);

// ⛔ A CONTROL SCROLLED OUT OF VIEW BEHIND AN OPEN MODAL IS NOT HERS TO PRESS (run 20261005-015234-dc78).
// With the phone keyboard up the viewport shrank, the listing page's own Share your shop / Show me
// around / Dismiss fell below it, the hit test had no point to try and left them numbered ahead of the
// composer's own controls, so every index inside the dialog moved by three and a description landed in
// Location. Only a MODAL counts: a non-modal banner leaves the page scrollable, so what is below the
// fold stays hers.
test("inventory: a control below the fold behind an open modal is marked, the modal's own are not", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOfHtml(
      browser,
      `<div style="height:3000px">Page</div>
       <button type="button" style="position:absolute;top:2000px">Share your shop</button>
       <div role="dialog" aria-modal="true" aria-label="List an item" style="position:fixed;inset:0;background:#fff">
         <h2>List an item</h2><button type="button">Next</button>
       </div>`,
    );
    const byName = (name) => inventory.elements.find((e) => e.name === name);
    assert.match(byName("Share your shop")?.behindOverlay ?? "", /List an item/, "below the fold, behind the modal: not offered");
    assert.equal(byName("Next")?.behindOverlay, undefined, "the modal's own control stays hers");
  });
});

test("inventory: a control below the fold under a non-modal banner stays hers", { concurrency: false }, async () => {
  await withBrowser(async (browser) => {
    const inventory = await inventoryOfHtml(
      browser,
      `<div style="height:3000px">Page</div>
       <button type="button" style="position:absolute;top:2000px">Scroll to me</button>
       <div role="dialog" aria-label="Cookies" style="position:fixed;bottom:0;left:0;right:0;background:#fff"><button type="button">Accept</button></div>`,
    );
    const byName = (name) => inventory.elements.find((e) => e.name === name);
    assert.equal(byName("Scroll to me")?.behindOverlay, undefined, "a banner does not lock the page");
  });
});

// petsitter-bree, trainer-marcus and tattoo-kai (run 20261006-063506-50e9): a skimmer's reading cut fell
// before a partner email's big "Make my booking link" button and its "1. Connections" link. Both are
// links in an email, so neither got a number and she answered "Nothing on the page says Connections"
// beside a button anyone sees. A control on her screen is in her picture whether or not she read the
// words above it; only the prose is cut.
test(
  "perceive(): a link or button on her screen keeps its number and its text when her reading stops before it",
  { concurrency: false },
  async () => {
    await withBrowser(async (browser) => {
      const inventory = await inventoryOfHtml(
        browser,
        `<p>This issue is presented with a booking tool, the first one below, and the others follow it in order of how often readers kept them.</p>
         <p><a href="https://example.com/c">1. Connections</a> A booking link clients use without calling or texting you, with an optional price on each service so they pay a deposit when they book.</p>
         <p><a href="https://example.com/go" style="display:inline-block;padding:14px 28px;background:#1a73e8;color:#fff;font-size:18px">Make my booking link</a></p>
         <p>Words after the button that she never reaches at all.</p>`,
      );
      const skimmer = { dials: { readingGrade: 12, wordsPerLook: 12, legibleMinPx: 0, techProwess: 3 } };
      const view = perceive(inventory, skimmer);
      assert.equal(view.stats.truncated, true);
      assert.match(view.text, /\[\d+\] Make my booking link/, "the button she can see is numbered");
      assert.match(view.text, /\[\d+\] 1\. Connections/, "so is the link");
      assert.doesNotMatch(view.text, /never reaches/, "prose after the cut stays unread");
      assert.doesNotMatch(view.text, /kept them/, "and prose before it is still cut at her budget");
      const byText = (words) => pickByWords(inventory.elements, words)?.el;
      assert.ok(byText("connections"), "clickable by its visible text");
      assert.ok(byText("make my booking link"), "the button too");
    });
  },
);

test("perceive(): on a one-screen read a block the bottom edge cuts is named as the window's edge, outside the page's text", () => {
  const text = "Premium unlocks faster ticket handling for large servers and more.";
  const page = (screenOnly) => ({
    url: "https://example.test/",
    title: "t",
    viewport: { w: 1000, h: 700 },
    scroll: { y: 0, max: 2000 },
    ...(screenOnly ? { screenOnly: true } : {}),
    blocks: [
      { id: "sue-1", order: 1, kind: "paragraph", text, fontPx: 16, aboveFold: true, wordCount: text.split(" ").length, bottom: 760 },
    ],
    elements: [],
  });
  const reader = { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } };
  const cut = perceive(page(true), reader).text;
  const [pageText, windowNote] = [cut.split("\n")[0], cut.split("\n").at(-1)];
  assert.doesNotMatch(pageText, /continues below|cut off|scroll to read/, "the page's own text carries nothing of ours");
  assert.match(windowNote, /^\[Your window ends partway through "Premium unlocks faster ticket handling for".*your screen edge, not the site\.\]$/);
  assert.doesNotMatch(perceive(page(false), reader).text, /Your window ends/);
});

test("perceive(): on a one-screen read that ends between two blocks, with more page below, the last block on screen is named as the window's edge", () => {
  // Raise Buddy re-visit 24 (run 20261012-155420-f19b): a card's title was the last line on her screen, its amount and
  // reason sat just below the edge, no block was cut, so she was told nothing and filed "no amount and no reason".
  const title = "NIH, CDC and FDA Small Business Innovation Research Grant";
  const page = (below) => ({
    url: "https://example.test/",
    title: "t",
    viewport: { w: 1000, h: 700 },
    scroll: { y: 0, max: 0 },
    blocks: [
      { id: "sue-1", order: 1, kind: "heading", text: title, fontPx: 16, aboveFold: true, wordCount: 9, bottom: 690 },
      ...(below ? [{ id: "sue-2", order: 2, kind: "paragraph", text: "Up to $3,000,000", fontPx: 16, aboveFold: false, wordCount: 3, bottom: 760 }] : []),
    ],
    elements: [],
  });
  const reader = { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } };
  const lines = perceive(screenOnly(page(true)), reader).text.split("\n");
  assert.equal(lines[0], title, "the page's own text carries nothing of ours");
  assert.doesNotMatch(lines.join("\n"), /\$3,000,000/, "what is below the screen stays unread");
  assert.match(lines.at(-1), /^\[Your window ends after "NIH, CDC and FDA Small Business"\..*your screen edge, not the site\.\]$/);
  assert.doesNotMatch(perceive(screenOnly(page(false)), reader).text, /Your window ends/, "a screen that holds the whole page says nothing");
});

test("a list that scrolls inside a box: the card its bottom edge cuts is named as her window's edge", { concurrency: false }, async () => {
  // Raise Buddy re-visit 24 (run 20261012-155420-f19b): react-native-web scrolls the list inside a box, so the document
  // never scrolls and what the box clips was left out unsaid; the NIH card's title was all she got of it, and three
  // visitors filed "no amount and no reason".
  const card = (lines) =>
    `<div role="button" tabindex="0" style="border:1px solid #ccc;padding:8px">` +
    `<div style="font-size:16px;height:40px">NIH, CDC and FDA Small Business Innovation Research Grant</div>` +
    `<div style="font-size:16px;margin-top:${lines}px">Up to $3,000,000</div></div>`;
  const html = (spacer, lines) =>
    `<body style="margin:0"><div style="position:absolute;top:60px;left:0;right:0;height:640px;overflow-y:auto">` +
    `<div style="height:${spacer}px">Their matches</div>${card(lines)}<div style="height:600px">More programs</div></div>` +
    `<div style="position:absolute;top:0;left:0;right:0;height:60px"><button>Back</button></div></body>`;
  const reader = { dials: { readingGrade: 12, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } };
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.setContent(html(560, 60));
      const cut = await page.evaluate(INVENTORY_SCRIPT);
      assert.equal(cut.clippedBelow, true, "the box clips more below and still scrolls");
      const text = perceive(cut, reader).text;
      assert.doesNotMatch(text, /\$3,000,000/, "what the box clips stays unread");
      assert.match(text.split("\n").at(-1), /^\[Your window ends partway through "NIH, CDC and FDA Small Business"\..*your screen edge, not the site\.\]$/);
      await page.setContent(html(20, 4).replace('<div style="height:600px">More programs</div>', ""));
      const whole = await page.evaluate(INVENTORY_SCRIPT);
      assert.equal(whole.clippedBelow, false, "a box that holds everything clips nothing");
      assert.doesNotMatch(perceive(whole, reader).text, /Your window ends/);
    } finally {
      await page.close();
    }
  });
});
