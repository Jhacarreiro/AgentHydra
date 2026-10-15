// The SUE people door pins its local MCP to the workspace that LAUNCHED the round, never to the round's scratch folder
// (4Man 16ecd6a5; Owner, 2026-10-02): a scratch folder the MCP registers is auto-bound to the account default workspace.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mcpEnv } from "../../dredd/lib/mcp.mjs";
import { launchWorkspace, scratchWorkspaceRefusal } from "../lib/people.mjs";

const SCRATCH = path.join(tmpdir(), "sue-round7");
const LAUNCH = path.resolve("/launch/ws");

test("a scratch round folder is pinned to the launching workspace, not itself", () => {
  const pin = launchWorkspace(SCRATCH, { SUE_LAUNCH_WORKSPACE: LAUNCH });
  assert.equal(pin, LAUNCH);
  const env = mcpEnv(SCRATCH, { pin, base: {} });
  assert.equal(env.CONNECTIONS_WORKSPACE, LAUNCH);
  assert.equal(env.CLAUDE_PROJECT_DIR, LAUNCH);
});

test("with no launch pin a scratch folder falls back to CONNECTIONS_WORKSPACE; a real folder is kept", () => {
  assert.equal(launchWorkspace(SCRATCH, { CONNECTIONS_WORKSPACE: LAUNCH }), LAUNCH);
  assert.equal(launchWorkspace(path.resolve("/real/repo"), {}), path.resolve("/real/repo"));
  assert.equal(mcpEnv("/x", { base: {} }).CONNECTIONS_WORKSPACE, "/x");
});

test("sue run --workspace refuses a scratch folder unless it is the launching workspace", () => {
  const why = scratchWorkspaceRefusal(SCRATCH, { SUE_LAUNCH_WORKSPACE: LAUNCH });
  assert.match(why, /scratch folder under the temp folder/);
  assert.ok(why.includes(`run it from ${LAUNCH}`));
  assert.equal(scratchWorkspaceRefusal(LAUNCH, { SUE_LAUNCH_WORKSPACE: LAUNCH }), null);
  assert.equal(scratchWorkspaceRefusal(path.resolve("/real/repo"), {}), null);
});
