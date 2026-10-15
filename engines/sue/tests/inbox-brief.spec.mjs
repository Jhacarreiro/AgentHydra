/**
 * An inbox test's brief (lib/inbox-test.mjs) never tells a Sue she must make an account, and always tells her
 * she may reply to the email; a website visit's brief keeps its account line and its goal line unchanged.
 * Regression: the inbox brief used to carry the account-forcing lines and a support rule that forbade the
 * reply, so every Sue visited the site and replyRate was 0 by construction.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrainSystemPrompt, buildScenarioPrompt, loadPersona, loadTarget, mintIdentity, websiteRules } from "../lib/personas.mjs";
import { intentScenario } from "../lib/workspace.mjs";
import { installTestPeople } from "./fixtures/people.mjs";

const roots = [];
afterEach(() => {
  delete process.env.SUE_HOME;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tempWs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sue-inbox-brief-"));
  roots.push(root);
  return root;
};
const withPeople = () => {
  process.env.SUE_HOME = tempWs();
  installTestPeople();
};

const INTENT = "an email arrived from a company you have never dealt with, and you are going through your inbox";
const ACCOUNT_LINE = "If getting there needs an account, make one yourself";
const GOAL_LINE = "Your goal is creating accounts on development websites";

test("an inbox brief lists the reply among her choices and never forces an account", () => {
  withPeople();
  const ws = tempWs();
  const { scenario } = intentScenario({ ws, intent: INTENT, inbox: true, createAccounts: true, contactSupport: false });
  assert.equal(scenario.inbox, true);
  assert.match(scenario.prompt, /You can reply to the email/);
  assert.doesNotMatch(scenario.prompt, new RegExp(ACCOUNT_LINE));

  const persona = loadPersona("dev-dan");
  const target = loadTarget("fixture");
  const identity = mintIdentity(persona, { sueNumber: 4802, runId: "20261012-000000-inb1", target });
  const brain = buildBrainSystemPrompt({ persona, target, scenario, identity, errand: "You want to read the email." });
  assert.doesNotMatch(brain, new RegExp(GOAL_LINE));
});

test("an inbox visit forbids the website but leaves the reply to her", () => {
  withPeople();
  const ws = tempWs();
  const { scenario } = intentScenario({ ws, intent: INTENT, inbox: true, createAccounts: false, contactSupport: false });
  const persona = loadPersona("dev-dan");
  const target = loadTarget("fixture");
  const identity = mintIdentity(persona, { sueNumber: 4803, runId: "20261012-000000-inb2", target });
  const text = buildScenarioPrompt({ scenario, identity, errand: "You want to read the email." });
  assert.match(text, /Replying to the email in your own inbox is not that/);
  assert.doesNotMatch(text, /Do not contact the company in any way, whatever happens/);
});

test("a website visit keeps its account line and its goal line", () => {
  withPeople();
  const ws = tempWs();
  const { scenario } = intentScenario({
    ws,
    intent: "you want to buy a bookshelf for the hallway, the way you always shop for furniture",
    createAccounts: true,
  });
  assert.equal(scenario.inbox, undefined);
  assert.match(scenario.prompt, new RegExp(ACCOUNT_LINE));
  assert.doesNotMatch(scenario.prompt, /You can reply to the email/);

  const persona = loadPersona("dev-dan");
  const target = loadTarget("fixture");
  const identity = mintIdentity(persona, { sueNumber: 4804, runId: "20261012-000000-web1", target });
  const brain = buildBrainSystemPrompt({ persona, target, scenario, identity, errand: "You want a bookshelf." });
  const goal = websiteRules(target).find((line) => line.includes("creating accounts"));
  if (goal) assert.ok(brain.includes(goal), "the website's goal line is still told to a website visit");
});

test("intentScenario refuses an inbox flag other than true or unset", () => {
  assert.throws(() => intentScenario({ ws: tempWs(), intent: INTENT, inbox: "yes" }), /inbox is true or not set/);
});
