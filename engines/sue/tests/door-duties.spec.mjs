/**
 * door-duties.spec - what the Connections MCP's sue door did for a wave, done by the engine itself.
 * =================================================================================================
 * WHAT: `bun test sue/tests/door-duties.spec.mjs`. AgentHydra starts `node sue/sue.mjs <action>` with no door in
 * front of it (2026-10-15), so `doorDuties` (sue.mjs) does the door's three jobs before a wave is planned: the
 * mailroom's vault lease for `Root/Connections` when the process has no AWS credentials (lib/mailroom-lease.mjs), the
 * Boardroom people named in `personas` cast as visitors (lib/boardroom-cast.mjs), and `project` defaulted from the
 * workspace (lib/workspaces.mjs workspaceProject). `analytics` reads the same default after the run's own record.
 * The vault and the Boardroom are stubs: nothing here reaches Connections or AWS, and every key is made up.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import "./fixtures/people.mjs";
import { analyticsProject } from "../analytics-view.mjs";
import { MAILROOM_INSTANCE, mintMailroomLease, needsMailroomLease, stsSession } from "../lib/mailroom-lease.mjs";
import { workspaceProject } from "../lib/workspaces.mjs";
import { doorDuties, runnerEnv } from "../sue.mjs";

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function tempWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sue-door-duties-"));
  made.push(ws);
  return ws;
}

// Made-up, credential-SHAPED values: the lease refuses anything that is not.
const FAKE_KEY = "ASIAFAKEFAKEFAKE0000";
const FAKE_SECRET = "fakeFAKEfakeFAKEfakeFAKEfakeFAKEfake0000";
const stsXml = (secret = FAKE_SECRET) =>
  `<GetSessionTokenResponse><GetSessionTokenResult><Credentials><AccessKeyId>${FAKE_KEY}</AccessKeyId>` +
  `<SecretAccessKey>${secret}</SecretAccessKey><SessionToken>fake-session</SessionToken>` +
  `<Expiration>2026-10-15T13:00:00Z</Expiration></Credentials></GetSessionTokenResult></GetSessionTokenResponse>`;

/** A local MCP whose vault answers `answer`; it records what it was asked. */
function stubVault(answer) {
  const asked = [];
  return { asked, execute: async (args) => (asked.push(args), { ok: true, text: answer }) };
}

test("needsMailroomLease: only a process with neither a named profile nor keys of its own takes a lease", () => {
  assert.equal(needsMailroomLease({}), true);
  assert.equal(needsMailroomLease({ AWS_PROFILE: "main" }), false);
  assert.equal(needsMailroomLease({ AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" }), false);
  assert.equal(needsMailroomLease({ AWS_ACCESS_KEY_ID: "k" }), true);
});

test("mintMailroomLease: the door's call - an STS session through aws_call on Root/Connections - becomes the AWS env", async () => {
  const mcp = stubVault(JSON.stringify({ status: 200, body: stsXml() }));
  const got = await mintMailroomLease(mcp);
  assert.equal(mcp.asked.length, 1);
  assert.deepEqual(
    [mcp.asked[0].service, mcp.asked[0].tool_name, mcp.asked[0].instance, mcp.asked[0].params.service],
    ["aws", "aws_call", MAILROOM_INSTANCE, "sts"],
  );
  assert.match(mcp.asked[0].params.body, /^Action=GetSessionToken&/);
  assert.equal(got.env.AWS_ACCESS_KEY_ID, FAKE_KEY);
  assert.equal(got.env.AWS_SECRET_ACCESS_KEY, FAKE_SECRET);
  assert.equal(got.env.AWS_SESSION_TOKEN, "fake-session");
  assert.equal(got.env.AWS_REGION, "us-east-1");
  assert.equal(got.instance, MAILROOM_INSTANCE);
});

test("mintMailroomLease: a redacted key, a failed STS call or a prose refusal is no lease, and no error quotes a body", async () => {
  assert.equal(stsSession(stsXml("[redacted]")), null);
  const redacted = await mintMailroomLease(stubVault(JSON.stringify({ status: 200, body: stsXml("[redacted]") })));
  assert.equal(redacted.env, undefined);
  assert.doesNotMatch(redacted.error, /redacted|fake/);
  const denied = await mintMailroomLease(stubVault(JSON.stringify({ status: 403, body: "<Error/>", error: "service_not_connected" })));
  assert.match(denied.error, /STS status 403, service_not_connected/);
  const broke = await mintMailroomLease(stubVault("You are out of credits."));
  assert.match(broke.error, /out of credits/);
  const cut = await mintMailroomLease(stubVault(`{"status":200,"body":"<AccessKeyId>${FAKE_KEY}</AccessKeyId><SecretAccessKey>${FAKE_SECRET}`));
  assert.doesNotMatch(cut.error, /ASIA|fake/i, "a cut answer is never quoted");
  assert.match((await mintMailroomLease(null)).error, /no local MCP/);
});

test("doorDuties: a wave with no credentials runs on the lease, one with a profile is left alone", async () => {
  const ws = tempWorkspace();
  const env = {};
  const held = { env: null };
  const mcp = stubVault(JSON.stringify({ status: 200, body: stsXml() }));
  const leased = await doorDuties("run", { url: "https://example.com/" }, { ws, mcp, env, held, project: () => null });
  assert.equal(held.env.AWS_ACCESS_KEY_ID, FAKE_KEY, "the wave's runner gets the lease");
  assert.deepEqual(env, {}, "never this process's env: a Manager it starts would keep a dead key");
  assert.match(leased.notes.mailroomCredentials, /^a vault lease for "Root\/Connections"/);

  const own = { AWS_PROFILE: "ops" };
  const ownHeld = { env: null };
  const kept = await doorDuties("run", { url: "https://example.com/" }, { ws, mcp, env: own, held: ownHeld, project: () => null });
  assert.equal(mcp.asked.length, 1, "no second lease");
  assert.equal(ownHeld.env, null);
  assert.match(kept.notes.mailroomCredentials, /profile "ops"/);

  const noneHeld = { env: null };
  const refused = await doorDuties("run", {}, { ws, mcp: stubVault("not signed in"), env: {}, held: noneHeld, project: () => null });
  assert.equal(noneHeld.env, null);
  assert.match(refused.notes.mailroomCredentials, /^none: the vault did not lease/);

  const asked = stubVault("unused");
  const listed = await doorDuties("personas", {}, { ws, mcp: asked, env: {}, held: { env: null }, project: () => "p-1" });
  assert.deepEqual([asked.asked.length, listed.args.project, listed.notes], [0, undefined, {}], "only a wave");
});

test("runnerEnv: the wave's lease reaches its runner as is, and \"main\" stays the default only without credentials", () => {
  const lease = { AWS_ACCESS_KEY_ID: FAKE_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET };
  const leased = runnerEnv({ PATH: "x" }, lease);
  assert.deepEqual([leased.AWS_ACCESS_KEY_ID, leased.AWS_PROFILE, leased.PATH], [FAKE_KEY, undefined, "x"]);
  assert.equal(runnerEnv({ PATH: "x" }).AWS_PROFILE, "main");
  assert.equal(runnerEnv({ AWS_PROFILE: "ops" }).AWS_PROFILE, "ops");
  assert.equal(runnerEnv({ AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" }).AWS_PROFILE, undefined);
});

test("doorDuties: a Boardroom person named in personas is cast as a visitor, and the answer says who was found", async () => {
  const ws = tempWorkspace();
  const brief = "You are Ray, 54, a commercial real estate broker who reads every listing twice before he calls.";
  const calls = [];
  const door = async (tool, body) => {
    calls.push(tool);
    return { ok: true, status: 200, body: { personas: [{ id: "bp-7", name: "Ray Broker", brief, createdAt: "2026-10-01" }] } };
  };
  const { args, notes } = await doorDuties(
    "run",
    { url: "https://example.com/", personas: ["grandma", "Ray Broker"], cast: [] },
    { ws, door, env: { AWS_PROFILE: "main" }, held: { env: null }, project: () => null },
  );
  assert.deepEqual(calls, ["boardroom_personas_list"]);
  assert.deepEqual(args.personas, ["grandma", "ray-broker"]);
  assert.deepEqual(args.cast, [{ id: "ray-broker", displayName: "Ray Broker", extends: "bob", voice: brief }]);
  assert.deepEqual(notes.fromBoardroom.found, [{ asked: "Ray Broker", name: "Ray Broker", boardroomId: "bp-7", castId: "ray-broker" }]);

  const roster = await doorDuties("run", { personas: ["grandma"] }, { ws, door, env: { AWS_PROFILE: "main" }, held: { env: null }, project: () => null });
  assert.equal(calls.length, 1, "a run naming only roster people asks the Boardroom nothing");
  assert.equal(roster.notes.fromBoardroom, undefined);
});

test("workspaceProject: a target that declares the folder's project wins, else the folder's Connections binding", () => {
  const ws = tempWorkspace();
  const bindings = new Map([[ws, "bound-project"]]);
  assert.equal(workspaceProject(ws, { targets: [], bindings }), "bound-project");
  assert.equal(workspaceProject(ws, { targets: [{ root: ws, projectId: "target-project" }], bindings }), "target-project");
  assert.equal(workspaceProject(ws, { targets: [{ root: os.tmpdir(), projectId: "elsewhere" }], bindings: new Map() }), null);
});

test("doorDuties and analytics: project defaults to the workspace's, and a caller's or the run's own wins", async () => {
  const ws = tempWorkspace();
  const env = { AWS_PROFILE: "main" };
  const filled = await doorDuties("run", {}, { ws, env, held: { env: null }, project: () => "ws-project" });
  assert.equal(filled.args.project, "ws-project");
  const given = await doorDuties("focus_group", { project: "mine" }, { ws, env, held: { env: null }, project: () => "ws-project" });
  assert.equal(given.args.project, "mine");
  assert.equal(analyticsProject({ project: null, run: { projectId: null }, defaultProject: "ws-project", env: {} }), "ws-project");
  assert.equal(analyticsProject({ project: null, run: { projectId: "recorded" }, defaultProject: "ws-project", env: {} }), "recorded");
  assert.equal(analyticsProject({ project: "asked", run: { projectId: "recorded" }, defaultProject: "ws-project", env: {} }), "asked");
});
