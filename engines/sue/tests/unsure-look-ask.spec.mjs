import { test } from "node:test";
import assert from "node:assert/strict";
import { lookText, UNSURE_OWED } from "../body.mjs";

const frame = { width: 1280, height: 800 };
const PICTURE_LINE = "Your picture is 1280 wide and 800 tall.";

test("a paced look ends with the one-line ask about the words she read most carefully", () => {
  const text = lookText("Ticket settings\nSave", { frame, puzzleAsk: true });
  const lines = text.split("\n").filter(Boolean);
  assert.match(
    lines.at(-1),
    /Which words or numbers.*read most carefully.*lingered: ".*quoted exactly.*Never invent them.*could not judge for your own situation.*explained before you decide.*read twice to follow.*promises something without saying how it helps with your own problem.*unsure: ".*or unsure: "none" if nothing does/,
  );
  assert.equal(lines.filter((l) => /Which words or numbers/.test(l)).length, 1);
  assert.ok(text.includes(PICTURE_LINE), "the picture size line stays before the ask");
});

test("the unsure refusal also asks for wording read twice and a promise without its help", () => {
  assert.match(UNSURE_OWED, /read twice to follow/);
  assert.match(UNSURE_OWED, /promises something without saying how it helps with your own problem/);
  assert.match(UNSURE_OWED, /could not judge for your own situation/);
  assert.match(UNSURE_OWED, /or unsure: "none" if nothing does/);
});

test("an unpaced look does not ask about puzzling words and ends on the picture line", () => {
  const text = lookText("Ticket settings\nSave", { frame, puzzleAsk: false });
  assert.doesNotMatch(text, /Which words or numbers/);
  assert.match(text.trimEnd(), /without a number, you reach with point\.$/);
});
