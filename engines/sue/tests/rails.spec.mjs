// @node-runtime: `keyPressTargets` launches a real headless chromium through playwright, which hangs
// under bun on Windows instead of throwing - the node lane must spawn this file under node, as its
// own header's `node --test` already says (bun-specs-lib's marker-parity test enforces it).
/**
 * rails.spec - a signed-in Sue never changes anything real on the account she borrowed.
 * ==================================================================================================
 *
 * WHAT: `node --test sue/tests/rails.spec.mjs`. `refusedBy` refuses what the target's
 * `refuseClicks` names, and on a borrowed account also whatever posts, saves, creates a key or
 * copies, but only for things a hand presses (never links or check boxes); a signed-out Sue is
 * untouched by the borrowed rail. `keyPressTargets`, run in a real headless chromium, says what
 * Enter or Space would press, so a key cannot walk past the rails; `fieldAt` there names a field
 * only when it takes typing, so a see-through slider is dragged and a see-through text box is not.
 *
 * WHY IT EXISTS: `lib/rails.mjs`' header - signed-in Sues on Example App Next minted two live access
 * tokens on the lender's account and pressed "Post" on his real Discord server, because the only
 * rail listed destructive words.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { isHiddenField } from "../lib/findings.mjs";
import { fieldAt, keyPressTargets, railsFor, refusalSentence, refusedBy } from "../lib/rails.mjs";

const DESTRUCTIVE = "\\b(delete|remove|revoke)\\b";

test("a borrowed account refuses what would change something real, by the words a hand presses", () => {
  const rails = railsFor({ refuseClicks: DESTRUCTIVE, borrowed: true });
  for (const name of ["Post", "Create token", "Copy configuration", "Save changes", "Start free trial", "Send invite"]) {
    assert.equal(refusedBy(rails, name, { role: "button" }), "real-change", name);
  }
  assert.equal(refusedBy(rails, "Revoke", { role: "button" }), "destructive");
  for (const name of ["Access tokens", "Manage", "Panels", "Search settings\nCtrl K", "Th3Ninja", "Try again"]) {
    assert.equal(refusedBy(rails, name, { role: "button" }), null, name);
  }
});

test("a noCommit target puts the real-change rail on a Sue with no session", () => {
  // An anonymous Sue on the public events list could RSVP a Sue address onto a real host's guest list.
  assert.equal(refusedBy(railsFor({ noCommit: true }), "RSVP", { role: "button" }), "real-change");
  assert.equal(refusedBy(railsFor({}), "RSVP", { role: "button" }), null, "an ordinary anonymous Sue still presses");
});

test("links, check boxes and choices are never read by the borrowed rail", () => {
  const rails = railsFor({ borrowed: true });
  assert.equal(refusedBy(rails, "Post a panel", { role: "link" }), null);
  assert.equal(refusedBy(rails, "Send on create", { role: "checkbox" }), null);
  assert.equal(refusedBy(rails, "Save transcripts", { role: "select" }), null);
});

test("a page's own options, menu items and switches are pressed like buttons; a tab is not", () => {
  // Numbered for the first time after run 20260922-063426-626a: a search result or menu item that
  // posts, deletes or pays must meet the rails a button meets.
  const rails = railsFor({ refuseClicks: DESTRUCTIVE, borrowed: true });
  for (const role of ["option", "menuitem", "menuitemcheckbox", "menuitemradio", "switch"]) {
    assert.equal(refusedBy(rails, "Post announcement", { role }), "real-change", role);
    assert.equal(refusedBy(rails, "Pay now", { role }), "real-change", role);
    assert.equal(refusedBy(rails, "Delete server", { role }), "destructive", role);
    assert.equal(refusedBy(rails, "Access tokens", { role }), null, role);
  }
  assert.equal(refusedBy(rails, "Create", { role: "tab" }), null, "a tab only shows its panel");
  assert.equal(refusedBy(rails, "Delete", { role: "tab" }), "destructive", "the destructive rail reads every role");
  assert.equal(refusedBy(rails, "Send on create", { role: "switch" }), "real-change", "a switch acts the moment it flips");
});

test("the target's destructive rail still reads links", () => {
  const rails = railsFor({ refuseClicks: DESTRUCTIVE });
  assert.equal(refusedBy(rails, "Delete this server", { role: "link" }), "destructive");
});

test("a signed-out Sue is untouched by the borrowed rail", () => {
  const rails = railsFor({ refuseClicks: DESTRUCTIVE, borrowed: false });
  assert.equal(refusedBy(rails, "Create token", { role: "button" }), null);
  assert.equal(refusedBy(rails, "Post", { role: "button" }), null);
});

test("a throwaway account saved with free hands lifts the real-change and destructive rails", () => {
  const rails = railsFor({ refuseClicks: DESTRUCTIVE, borrowed: true, freeHands: true });
  for (const name of ["Post", "Create token", "Save changes", "Revoke", "Delete this panel", "Deactivate panel"]) {
    assert.equal(refusedBy(rails, name, { role: "button" }), null, name);
  }
});

test("no signed-in Sue signs the shared session out, free hands or not", () => {
  for (const freeHands of [false, true]) {
    const rails = railsFor({ refuseClicks: DESTRUCTIVE, borrowed: true, freeHands });
    assert.equal(refusedBy(rails, "Sign out", { role: "button" }), "session");
    assert.equal(refusedBy(rails, "Log out", { role: "link" }), "session");
    assert.equal(refusedBy(rails, "Delete my account", { role: "button" }), "session");
    assert.equal(refusedBy(rails, "", { role: "link", href: "https://x.example/api/auth/logout" }), "session");
    // Discord ends every saved sign-in when the password changes or two-factor goes on, and an
    // account that leaves its one server is lent for nothing.
    for (const words of [
      "Log Out",
      "Disable Account",
      "Change Password",
      "Enable Two-Factor Auth",
      "Enable Authenticator App",
      "Leave Server",
    ])
      assert.equal(refusedBy(rails, words, { role: "button" }), "session", words);
    assert.equal(refusedBy(rails, "Server Settings", { role: "button" }), null);
    assert.equal(refusedBy(rails, "Th3Ninja", { role: "button", href: "/dashboard/account" }), null);
  }
  assert.equal(
    refusedBy(railsFor({ refuseClicks: DESTRUCTIVE }), "Sign out", { role: "button" }),
    null,
    "a signed-out Sue has no session to lose",
  );
  assert.match(refusalSentence("session", "Sign out"), /other people are using it/);
});

test("the refusal says she chose not to press it, so the page is never blamed", () => {
  const said = refusalSentence("real-change", 'button [14] "Create token"');
  assert.match(said, /somebody else's real account/);
  assert.match(said, /Nothing on the page failed/);
});

test("keyPressTargets names what Enter and Space would press, in a real browser", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form><input id="name"><button>Create token</button><button type="button">Cancel</button></form>
      <textarea id="notes"></textarea>
      <button id="post">Post</button>
      <a id="docs" href="#x">Docs</a>
      <input id="loose">`);

    await page.focus("#name");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "Create token", role: "button", submits: true }]);
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), []);

    await page.focus("#post");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), [{ name: "Post", role: "button" }]);

    await page.focus("#docs");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "Docs", role: "link", href: "#x" }]);

    await page.focus("#notes");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), []);

    await page.focus("#loose");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "send", role: "button" }]);
  } finally {
    await browser.close();
  }
});

test("keyPressTargets reads a page's own widgets: a focused option or menu item, and the result a search box points at", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form><input id="search" role="combobox" aria-activedescendant="post"><button>Search</button></form>
      <input id="loose" aria-activedescendant="post">
      <div role="listbox"><div role="option" id="tokens">Access tokens</div><div role="option" id="post">Post announcement</div></div>
      <div role="menu"><div role="menuitem" id="delete" tabindex="0">Delete server</div></div>
      <div role="switch" id="dark" tabindex="0" aria-label="Dark mode"></div>
      <div role="listbox" id="list" tabindex="0" aria-activedescendant="tokens"></div>`);

    await page.focus("#delete");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "Delete server", role: "menuitem" }]);
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), [{ name: "Delete server", role: "menuitem" }]);

    await page.focus("#dark");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), [{ name: "Dark mode", role: "switch" }]);

    await page.focus("#search");
    assert.deepEqual(
      await page.evaluate(keyPressTargets, "Enter"),
      [
        { name: "Post announcement", role: "option" },
        // Nothing marks this form as a search (role=search, a search box, a q/s name), so a live
        // site's rail would refuse sending it: the safe reading for a form it cannot place.
        { name: "Search", role: "button", submits: true },
      ],
      "Enter chooses the result it points at, and may send the form too",
    );
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), [], "Space in a search box types a space");

    await page.focus("#loose");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [
      { name: "Post announcement", role: "option" },
      { name: "send", role: "button" },
    ]);

    await page.focus("#list");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Space"), [{ name: "Access tokens", role: "option" }]);
  } finally {
    await browser.close();
  }
});

test("keyPressTargets reads Enter in a formless text box as a synthetic send, so the borrowed rail stops it", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="composer" contenteditable="true" role="textbox">Type a message</div>
      <div id="box" role="textbox" tabindex="0">Another box</div>
      <input id="loose">
      <textarea id="notes"></textarea>`);

    await page.focus("#composer");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "send", role: "button" }]);
    assert.deepEqual(await page.evaluate(keyPressTargets, "Control+Enter"), [{ name: "send", role: "button" }]);

    await page.focus("#box");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "send", role: "button" }]);

    await page.focus("#loose");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [{ name: "send", role: "button" }]);

    await page.focus("#notes");
    assert.deepEqual(await page.evaluate(keyPressTargets, "Enter"), [], "Enter in a textarea types a newline");
    assert.deepEqual(
      await page.evaluate(keyPressTargets, "Control+Enter"),
      [{ name: "send", role: "button" }],
      "Ctrl+Enter sends in a formless text area",
    );

    const rails = railsFor({ borrowed: true });
    assert.equal(refusedBy(rails, "send", { role: "button" }), "real-change", "the synthetic send meets the borrowed rail");
  } finally {
    await browser.close();
  }
});

test("fieldAt lets a hand drag a see-through slider laid over its handle, and still names a see-through text box", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() || undefined });
  try {
    const page = await browser.newPage();
    // vectormagik's compare figure: the picture and a drawn knob, under a range input at opacity 0.
    await page.setContent(`
      <figure style="position:relative;width:400px;height:200px;margin:0;background:#ccc">
        <span style="position:absolute;left:180px;top:80px;width:40px;height:40px;border-radius:50%;background:blue"></span>
        <input type="range" style="position:absolute;inset:0;width:100%;height:100%;opacity:0">
      </figure>
      <input id="trap" name="website" style="position:absolute;left:0;top:300px;width:200px;height:30px;opacity:0">`);

    const knob = await page.evaluate(fieldAt, [200, 100]);
    assert.equal(knob.field, false, "a range takes no typing, so the hidden-field rail never meets it");
    const trap = await page.evaluate(fieldAt, [100, 315]);
    assert.equal(trap.field && isHiddenField(trap), true, "a see-through text box is still the honeypot it refuses");
  } finally {
    await browser.close();
  }
});
