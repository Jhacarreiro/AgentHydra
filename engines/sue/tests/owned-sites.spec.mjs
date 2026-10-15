// owned-sites.spec.mjs - a site on this workspace's websites gets the owners' rules; anything else stays somebody else's.
//
// WHAT: `node --test sue/tests/owned-sites.spec.mjs`. No network and no MCP: every door is a fake that answers
// the way the Companies, Email and Legal planes and connections_whoami answer.
//
// WHY IT EXISTS: Owner, 2026-10-02: "the person adds a list and says these are mine and Sues treat those as his ... if
// they're uncertain, they can check the list". The planner reads the workspace's websites ONCE per run
// (lib/owned-sites.mjs), never each Sue; a source that fails is named in the run's answer, never dropped in silence; a
// door that will not open leaves today's rules in place and says so; and a run told `owned: true` puts its host on the
// list, so every later run knows.
//
// WHO DEPENDS ON IT: nothing imports it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchOwnedSites, ownedSitesForRun } from "../lib/owned-sites.mjs";
import { isOwnedSite } from "../lib/site-owner.mjs";

const COMPANY = "c57bbf14-c434-4ebf-812d-914d17222995";
const INTENT = "a friend sent you this link and you want to book a table for six on Friday night";

/**
 * A door that answers like the three planes, and keeps every call it was asked as `[tool, body, routing]`. `fail` maps
 * a tool to the answer it gives instead (or to an Error it throws); `add` is companies_add_my_site's answer.
 */
function fakeDoor({
  company = COMPANY,
  sites = [],
  emails = [],
  banners = [],
  fail = {},
  add = (hostname) => ({ ok: true, status: 200, body: { added: true, site: { hostname, sources: ["declared"] } } }),
} = {}) {
  const calls = [];
  return {
    calls,
    async whoami() {
      calls.push(["connections_whoami"]);
      const answer = { identity: { signedIn: true }, company: company ? { companyId: company, name: "Pinky's" } : null };
      return { ok: true, text: JSON.stringify(answer, null, 2) };
    },
    async api(service, tool, body = {}, routing = null) {
      calls.push([tool, body, routing]);
      const failed = fail[tool];
      if (failed instanceof Error) throw failed;
      if (failed) return failed;
      if (tool === "companies_list_my_sites") return { ok: true, status: 200, body: { sites } };
      if (tool === "email_action") return { ok: true, status: 200, body: emails };
      if (tool === "legal_consent_sites_list") return { ok: true, status: 200, body: { sites: banners } };
      if (tool === "companies_add_my_site") return add(body.hostname);
      return { ok: false, status: 404, body: { error: "unknown_tool" }, text: tool };
    },
  };
}

/** An openDoor that hands out `door` and counts how often it was opened and closed. */
function opener(door) {
  const seen = { opened: 0, closed: 0 };
  const openDoor = async () => {
    seen.opened += 1;
    return { door, close: async () => (seen.closed += 1) };
  };
  return { seen, openDoor };
}

const tools = (door) => door.calls.map(([tool]) => tool);

test("whose site: a host on the workspace's list, or under one, is the owners'; the target's own word still wins", () => {
  const list = ["pinkyrest.com", "Book.Pinky.APP."];
  assert.equal(isOwnedSite("https://pinkyrest.com/", null, list), true);
  assert.equal(isOwnedSite("https://www.pinkyrest.com/menu?day=fri", null, list), true, "a subdomain of a listed site");
  assert.equal(isOwnedSite("https://book.pinky.app/", null, list), true, "a listed entry is read as a bare lower-case host");
  assert.equal(isOwnedSite("https://notpinkyrest.com/", null, list), false, "a name that only ends the same is not under it");
  assert.equal(isOwnedSite("https://pinky.app/", null, list), false, "the parent of a listed subdomain is not listed");
  assert.equal(isOwnedSite("https://sullivanfantastic.com/", null, list), false);
  assert.equal(isOwnedSite("https://pinkyrest.com/", { owned: false }, list), false, "a target that says not ours wins");
  assert.equal(isOwnedSite("https://sullivanfantastic.com/", { owned: true }, []), true, "a target that says ours wins");
  assert.equal(isOwnedSite("http://localhost:4173/", null, []), true, "a dev host is still the owners'");
  assert.equal(isOwnedSite("https://app.example.com/", null, []), true, "Connections is still the owners'");
  assert.equal(isOwnedSite("not a url", null, list), false);
  assert.equal(isOwnedSite("https://pinkyrest.com/", null, [null, 7, "", "https://pinkyrest.com/x"]), true, "junk entries are skipped");
  assert.equal(
    isOwnedSite("https://sullivanfantastic.com/", null, ["com", "*.com"]),
    false,
    "a bare top-level name owns no stranger's site",
  );
});

// A name every stranger's site sits under (a shared host like vercel.app, a country's co.uk) owns nobody's site: on the
// list it would hand each of those strangers the owners' rules, and a Sue would make an account on one and write to it.
test("a public suffix on the list owns nobody's site; a member's own site under one is still theirs", () => {
  for (const [url, entry] of [
    ["https://strangers-booking.vercel.app/", "vercel.app"],
    ["https://strangers-booking.vercel.app/", "*.vercel.app"],
    ["https://someone.github.io/portfolio", "github.io"],
    ["https://shop.pages.dev/", "pages.dev"],
    ["https://shop.netlify.app/", "netlify.app"],
    ["https://shop.herokuapp.com/", "herokuapp.com"],
    ["https://bakery.co.uk/", "co.uk"],
    ["https://bakery.com.au/", "com.au"],
  ])
    assert.equal(isOwnedSite(url, null, [entry]), false, `${entry} owns ${url}`);
  assert.equal(isOwnedSite("https://pinky.vercel.app/menu", null, ["pinky.vercel.app"]), true);
  assert.equal(isOwnedSite("https://book.pinkyrest.co.uk/", null, ["*.pinkyrest.co.uk"]), true);
});

test("the workspace's websites are the website list, its own verified email domains and every cookie banner's domains", async () => {
  const door = fakeDoor({
    sites: [
      { hostname: "pinkyrest.com", sources: ["workspace_domain", "declared"] },
      { hostname: "book.pinky.app", sources: ["verified_domain"] },
    ],
    emails: [
      { domain: "mail.pinkyrest.com", verificationStatus: "verified" },
      { domain: "pending.example", verificationStatus: "pending" },
      { domain: "sister.example", verificationStatus: "verified", sharedFrom: { workspaceId: "another" } },
    ],
    banners: [{ domains: ["pinkyrest.com", "shop.pinkyrest.co"] }, { domains: [] }],
  });
  const got = await fetchOwnedSites(door);
  assert.deepEqual(got.hosts, ["book.pinky.app", "mail.pinkyrest.com", "pinkyrest.com", "shop.pinkyrest.co"]);
  assert.deepEqual(got.skipped, []);
  assert.equal(got.companyId, COMPANY);
  assert.deepEqual(door.calls, [
    ["connections_whoami"],
    ["companies_list_my_sites", {}, { company_id: COMPANY }],
    ["email_action", { action: "domains.list", companyId: COMPANY }, null],
    ["legal_consent_sites_list", { companyId: COMPANY }, null],
  ]);
});

test("a source that fails or refuses is skipped and named, and the ones that answered still count", async () => {
  const door = fakeDoor({
    sites: [{ hostname: "pinkyrest.com", sources: ["declared"] }],
    fail: {
      email_action: { ok: false, status: 403, body: { error: "forbidden", message: "This key cannot read email." } },
      legal_consent_sites_list: new Error("legal_consent_sites_list timed out after 15000 ms"),
    },
  });
  const got = await fetchOwnedSites(door);
  assert.deepEqual(got.hosts, ["pinkyrest.com"]);
  assert.deepEqual(
    got.skipped.map((s) => s.source),
    ["email domains", "cookie banner sites"],
  );
  assert.match(got.skipped[0].why, /forbidden: This key cannot read email/);
  assert.match(got.skipped[1].why, /timed out/);
});

test("a folder bound to no Connections workspace reads nothing and says why, never guessing a company", async () => {
  const door = fakeDoor({ company: null });
  const got = await fetchOwnedSites(door);
  assert.deepEqual(got.hosts, []);
  assert.equal(got.companyId, null);
  assert.equal(got.skipped.length, 3);
  assert.match(got.skipped[0].why, /no Connections workspace/);
  assert.deepEqual(tools(door), ["connections_whoami"]);
});

test("the planner reads the list ONCE for a link run on a stranger's host, and hands it to planRun", async () => {
  const door = fakeDoor({ sites: [{ hostname: "pinkyrest.com", sources: ["declared"] }] });
  const { seen, openDoor } = opener(door);
  const run = await ownedSitesForRun({ url: "https://www.pinkyrest.com/", intent: INTENT }, { root: "C:/ws", openDoor });
  assert.deepEqual(run.args.ownedSites, ["pinkyrest.com"]);
  assert.equal(seen.opened, 1);
  const answer = await run.settle({ ok: true, runId: "r1" });
  await run.close();
  assert.equal(seen.closed, 1);
  assert.equal(answer.ownedSitesNote, undefined, "nothing was skipped, so nothing to say");
  assert.equal(answer.registeredSite, undefined, "no owned: true, so nothing is added");
  assert.equal(tools(door).filter((t) => t === "companies_list_my_sites").length, 1);
});

test("no door is opened when the list cannot change the answer or a caller already handed it over", async () => {
  const { seen, openDoor } = opener(fakeDoor());
  const cases = [
    { url: "http://localhost:4173/", intent: INTENT },
    { url: "https://app.example.com/trial/x", intent: INTENT },
    { url: "https://sullivanfantastic.com/", intent: INTENT, owned: false },
    { url: "https://sullivanfantastic.com/", intent: INTENT, profile: "discord" },
    { target: "connections", scenario: "sign-up" },
    { intent: INTENT },
    { url: "https://pinkyrest.com/", intent: INTENT, ownedSites: ["PinkyRest.com."] },
  ];
  for (const args of cases) {
    const run = await ownedSitesForRun(args, { root: "C:/ws", openDoor });
    const answer = await run.settle({ ok: true });
    await run.close();
    assert.equal(answer.ownedSitesNote, undefined, JSON.stringify(args));
  }
  assert.equal(seen.opened, 0);
  const handed = await ownedSitesForRun({ url: "https://pinkyrest.com/", ownedSites: ["PinkyRest.com.", 7] }, { root: "C:/ws", openDoor });
  assert.deepEqual(handed.args.ownedSites, ["pinkyrest.com"], "a handed list is read as bare hosts");
});

test("a door that cannot open leaves today's rules in place and the answer says so; the run is never blocked", async () => {
  const openDoor = async () => {
    throw new Error("local MCP loader not found: C:/x/loader.mjs");
  };
  const run = await ownedSitesForRun({ url: "https://pinkyrest.com/", intent: INTENT, owned: true }, { root: "C:/ws", openDoor });
  assert.deepEqual(run.args.ownedSites, []);
  const answer = await run.settle({ ok: true });
  await run.close();
  assert.match(answer.ownedSitesNote, /could not be read \(local MCP loader not found/);
  assert.match(answer.ownedSitesNote, /only local and Connections sites/);
  assert.match(answer.ownedSitesNote, /pinkyrest\.com was not added/, "owned: true with no door says the host was not kept");
  assert.equal(answer.registeredSite, undefined);
});

test("a skipped source is named in the run's answer", async () => {
  const door = fakeDoor({ fail: { email_action: { ok: false, status: 500, body: null, text: "email: boom" } } });
  const run = await ownedSitesForRun({ url: "https://pinkyrest.com/", intent: INTENT }, { root: "C:/ws", openDoor: opener(door).openDoor });
  const answer = await run.settle({ ok: true });
  await run.close();
  assert.match(answer.ownedSitesNote, /without its email domains \(email: boom\)/);
});

test("owned: true on a host not on the list adds it to the workspace's websites, and the answer says so", async () => {
  const door = fakeDoor({ sites: [{ hostname: "pinkyrest.com", sources: ["declared"] }] });
  const run = await ownedSitesForRun(
    { url: "https://Sullivanfantastic.com/book", intent: INTENT, owned: true },
    { root: "C:/ws", openDoor: opener(door).openDoor },
  );
  const answer = await run.settle({ ok: true });
  await run.close();
  assert.equal(answer.registeredSite, "sullivanfantastic.com");
  assert.equal(answer.ownedSitesNote, undefined);
  assert.deepEqual(door.calls.at(-1), ["companies_add_my_site", { hostname: "sullivanfantastic.com" }, { company_id: COMPANY }]);
});

test("owned: true adds nothing when the host is already on the list, under a listed site, Connections', or the run refused", async () => {
  for (const [url, answerOk] of [
    ["https://pinkyrest.com/", true],
    ["https://www.pinkyrest.com/", true],
    ["https://api.example.com/", true],
    ["https://sullivanfantastic.com/", false],
  ]) {
    const door = fakeDoor({ sites: [{ hostname: "pinkyrest.com", sources: ["declared"] }] });
    const run = await ownedSitesForRun({ url, intent: INTENT, owned: true }, { root: "C:/ws", openDoor: opener(door).openDoor });
    const answer = await run.settle({ ok: answerOk });
    await run.close();
    assert.ok(!tools(door).includes("companies_add_my_site"), url);
    assert.equal(answer.registeredSite, undefined, url);
  }
});

test("a list the caller handed over still gets the host added, through a door opened only for that", async () => {
  const door = fakeDoor();
  const { seen, openDoor } = opener(door);
  const run = await ownedSitesForRun(
    { url: "https://sullivanfantastic.com/", intent: INTENT, owned: true, ownedSites: ["pinkyrest.com"] },
    { root: "C:/ws", openDoor },
  );
  assert.equal(seen.opened, 0, "the list came with the run");
  const answer = await run.settle({ ok: true });
  await run.close();
  assert.equal(answer.registeredSite, "sullivanfantastic.com");
  assert.deepEqual([seen.opened, seen.closed], [1, 1]);
  assert.deepEqual(tools(door), ["connections_whoami", "companies_add_my_site"]);
});

test("an add the Companies plane refuses is named in the answer; one already declared is said by nobody", async () => {
  const refused = fakeDoor({
    add: () => ({
      ok: true,
      status: 200,
      body: { added: false, refused: true, error: "not_a_hostname", message: "That is not a website's name." },
    }),
  });
  const run = await ownedSitesForRun(
    { url: "https://sullivanfantastic.com/", intent: INTENT, owned: true },
    { root: "C:/ws", openDoor: opener(refused).openDoor },
  );
  const answer = await run.settle({ ok: true });
  assert.equal(answer.registeredSite, undefined);
  assert.match(
    answer.ownedSitesNote,
    /sullivanfantastic\.com was not added to this workspace's websites \(not_a_hostname: That is not a website's name\.\)/,
  );

  const already = fakeDoor({
    fail: { companies_list_my_sites: { ok: false, status: 503, body: { error: "unavailable" } } },
    add: (hostname) => ({ ok: true, status: 200, body: { added: false, site: { hostname, sources: ["declared"] } } }),
  });
  const again = await ownedSitesForRun(
    { url: "https://sullivanfantastic.com/", intent: INTENT, owned: true },
    { root: "C:/ws", openDoor: opener(already).openDoor },
  );
  const second = await again.settle({ ok: true });
  assert.equal(second.registeredSite, undefined, "it was on the list already");
  assert.doesNotMatch(second.ownedSitesNote, /was not added/);
  assert.match(second.ownedSitesNote, /website list \(unavailable\)/);
});
