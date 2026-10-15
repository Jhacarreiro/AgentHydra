// dredd/lib/doctor.mjs - can Dredd actually do what it says? Every prerequisite, checked, named.
//
// Owner ask (the Chair, 2026-09-21): "if you can't do what I'm telling you to do, then you definitely
// need to fix the ability to do that." A judge whose instruments are missing on a machine must say
// which, before a hearing - not skip them in a log nobody reads. `node dredd/dredd.mjs --doctor`
// (and the MCP door's action "doctor") runs this and exits non-zero when anything a hearing needs is
// absent. Nothing here prints a secret: the Jev key file is COUNTED, never read into the output.
//
// With `--root <repo>` the machine half is the same (the engine and the MCP loader live in the Connections
// checkout, HSwarm is an installed package, wherever the judged repository is) and the bench half is per instrument: can THAT
// repository run it? An instrument the repository cannot run is a note, not a missing thing - it is simply
// not on that repository's bench.
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { resolveSpawn } from "../../lib/shared/resolve-executable.mjs";
import { askBrain } from "./brain.mjs";
import { ENGINE_DIR, ENGINE_ROOT, runLineFile, runnableIn, samePath } from "./docket.mjs";
import { askJev } from "./jev.mjs";
import { drafterModels } from "./resolve.mjs";
import { readSeats } from "../../lib/people-home.mjs";
import { seatsDirFor } from "./seats.mjs";
import { localSharedPath, sharedCheckout } from "./shared-root.mjs";

/** A file the selected target names, or null when it names none (the product extras are optional). */
const named = (key) => (loadTarget()[key] ? targetPath(loadTarget()[key]) : null);
import { visionEnabled, visionModel } from "./vision.mjs";

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/)[0] : null;
}

function keyLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  } catch {
    return 0;
  }
}

/** Every check as { name, ok, detail, needed } - `needed: false` marks an advisory (a nicer path, not a blocker). */
export function doctor({ root, bench, engineRoot = ENGINE_ROOT, engineDir = ENGINE_DIR }) {
  // HSwarm is an installed Python package with its keys under HSWARM_HOME/secrets (ZSwarm's checkout retired 2026-10-03).
  const secrets = path.join(process.env.HSWARM_HOME || path.join(homedir(), ".hswarm"), "secrets");
  const hydra = sharedCheckout("project-hydra", { engineRoot, override: process.env.PROJECTHYDRA_HOME });
  const home = homedir();
  // Case-blind on Windows: one checkout typed in two cases is not a foreign repo (samePath, lib/docket.mjs).
  const foreign = !samePath(root, engineRoot);
  const rows = [];
  const add = (name, ok, detail, needed = true) => rows.push({ name, ok: Boolean(ok), detail, needed });

  add("repository", existsSync(root), foreign ? `${root} (judged with --root; the engine is ${engineRoot})` : root);
  add("node", true, process.version);
  add("bun", which("bun"), which("bun") || "not on PATH - the board, the Architect and the critic run under bun");
  const py = which("python");
  add("python", py, py || "not on PATH - the board's brain is a Python bridge, and Jev's door starts the HSwarm server with it");
  if (py) {
    const r = spawnSync("python", ["-c", "import hswarm.typesafe, hswarm.booking, hswarm.mcp_server; print('ok')"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    add(
      "hswarm imports (httpx, mcp)",
      r.status === 0 && /ok/.test(r.stdout),
      r.status === 0
        ? "importable"
        : String(r.stderr || r.stdout)
            .trim()
            .split(/\r?\n/)
            .pop(),
    );
  }
  const keys = keyLines(path.join(secrets, "typesafe_api_keys")) + (process.env.TYPESAFE_API_KEY ? 1 : 0);
  add(
    "Jev key pool",
    keys > 0,
    keys > 0 ? `${keys} key(s) in the pool (never printed)` : "no TypeSafe key - the docket falls back to keywords",
    false,
  );
  add(
    "local MCP loader",
    existsSync((named("localMcpLoader") ?? "")),
    "recall (memory lane), peers, SUE",
  );
  const agentLaneTools = (named("agentLaneTools") ?? "");
  add(
    "memory store tools",
    existsSync(agentLaneTools) && /^ {2}memory_search: \{/m.test(readFileSync(agentLaneTools, "utf8")),
    "memory_search is served by the local MCP from the notes plane's store",
  );
  add(
    "stdio JSON-RPC client",
    existsSync(new URL("../../lib/shared/stdio-json-rpc-client.mjs", import.meta.url)),
    "lib/shared/stdio-json-rpc-client.mjs",
  );
  add(
    "fairjob",
    process.platform !== "win32" || existsSync(path.join(home, ".claude", "tools", "fairjob.cmd")),
    "~/.claude/tools/fairjob.cmd - heavy field runs are gated through it",
    false,
  );
  add("Project Hydra checkout", existsSync(path.join(hydra, "ph.py")), hydra, false);
  try {
    const require = createRequire(path.join(engineRoot, "package.json"));
    require.resolve("playwright-core");
    add("playwright-core", true, "resolvable from the engine's checkout");
  } catch {
    add("playwright-core", false, "not resolvable - SUE, the critic and the live word count need it");
  }
  // SUE visits a URL and needs nothing of the judged repository, so she runs from the engine's checkout on any --root.
  add("SUE engine", existsSync(path.join(engineRoot, "sue", "sue.mjs")), "sue/sue.mjs");
  add(
    "design-critic wave",
    existsSync((named("designCriticWave") ?? "")),
    (named("designCriticWave") ?? ""),
    !foreign,
  );
  add(
    "Architect",
    existsSync((named("arkitectCli") ?? "")),
    (named("arkitectCli") ?? ""),
    !foreign,
  );
  const seatsDir = seatsDirFor(root);
  const seats = seatsDir
    ? existsSync(seatsDir) ? readdirSync(seatsDir).filter((f) => f.endsWith(".json")).length : 0
    : readSeats().length;
  add("seats", seats >= 1, `${seats} seat person(s) in ${seatsDir || "the people store (dredd-seat)"}`);
  add(
    "bench",
    Array.isArray(bench?.instruments) && bench.instruments.length > 0,
    `${bench?.instruments?.length || 0} instrument(s) from ${bench?.file || "bench.json"}${bench?.filtered?.length ? `, ${bench.filtered.length} Connections-only one(s) off this repository's bench` : ""}`,
  );
  let hookWired = false;
  try {
    hookWired = readFileSync(path.join(root, ".claude", "settings.json"), "utf8").includes("dredd-docket.mjs");
  } catch {
    /* no settings */
  }
  add("prompt hook wired", hookWired, `${root}/.claude/settings.json → .claude/hooks/dredd-docket.mjs`, false);
  // SUE's visitors think on the convening chat's own agents; the two key pools are counted only because a chat may pin
  // one for an unattended hearing (DREDD_SUE_BRAINS) - never a default (the Chair, 2026-09-23: no API keys "unless the
  // desktop instance ... has deemed say, a zswarm necessary"; no CLI logins at all).
  const dsKeys = keyLines(path.join(secrets, "deepseek_api_key")) + keyLines(path.join(secrets, "deepseek_api_keys"));
  const orKeys = keyLines(path.join(secrets, "openrouter_api_keys"));
  add(
    "SUE key pools",
    true,
    `deepseek ${dsKeys ? `${dsKeys} key(s)` : "no keys"} · openrouter ${orKeys ? `${orKeys} key(s)` : "no keys"} - used only when the chat pins one (DREDD_SUE_BRAINS); by default the chat's own agents drive every Sue`,
    false,
  );
  add(
    "drafter model",
    true,
    `${drafterModels().join(" -> ")} (DREDD_DRAFTER_MODEL, then DREDD_DRAFTER_FALLBACK) - the proposal drafter, the next model asked when one brings back no proposal; the room and the Humanizer run on HSwarm's free default`,
    false,
  );
  // SUE's mailroom reads her inbox with AWS profile `main`; an expired SSO session is a human browser login, not a code fix.
  {
    // resolveSpawn runs the Windows aws.cmd shim without `shell: true` + an argument list, which printed Node's DEP0190
    // warning on every doctor and hunt run (2026-09-23).
    const aws = resolveSpawn(process.env.AWS_CLI || "aws");
    const args = ["sts", "get-caller-identity", "--profile", process.env.SUE_AWS_PROFILE || "main", "--output", "text"];
    const r = spawnSync(aws.command, [...aws.prefixArgs, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const ok = r.status === 0;
    const loaderHere = existsSync((named("localMcpLoader") ?? ""));
    add(
      "SUE mailroom credentials",
      ok || loaderHere,
      ok
        ? "AWS profile main answers"
        : loaderHere
          ? "profile main absent - Dredd leases org credentials through the local MCP (Root/Connections) for every SUE launch"
          : `no profile and no local MCP - a person runs: aws sso login --profile main (${String(r.stderr || r.error?.message || "")
              .trim()
              .split(/\r?\n/)[0]
              .slice(0, 120)})`,
      false,
    );
  }
  // Every bench run line whose first token names a file must name one that exists; `bun run <script>` must name a package
  // script of the JUDGED repository. On another repository, an instrument it cannot run is a note: it is off that bench.
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts || {};
  } catch {
    scripts = {};
  }
  for (const inst of bench?.all || bench?.instruments || []) {
    const v = runnableIn(inst, { root, engineRoot, scripts, exists: existsSync });
    if (!v.ok) {
      add(`bench: ${inst.id}`, false, foreign ? `off this repository's bench - ${v.why}` : v.why, !foreign && inst.mode !== "agent");
      continue;
    }
    const named = runLineFile(inst.run);
    if (!named || /^bun run /.test(String(inst.run || ""))) {
      add(`bench: ${inst.id}`, true, v.why, inst.mode !== "agent");
      continue;
    }
    const file = benchRunnerPath(named, { engineDir, engineRoot, home });
    const abs = path.isAbsolute(file) ? file : path.join(root, file);
    // An anyPage instrument judges another repository's page from page-pulse's own shots and scan, not its runner:
    // on that bench its runner's absence is by design, never MISSING (the Design Critic and LilGranny, 2026-09-25).
    if (foreign && inst.anyPage && !existsSync(abs)) {
      add(`bench: ${inst.id}`, true, `judges from page-pulse on another repository (${file} is Connections')`, false);
      continue;
    }
    add(`bench: ${inst.id}`, existsSync(abs), existsSync(abs) ? "runner present" : `missing ${file}`, inst.mode !== "agent");
  }
  return rows;
}

/** Where a bench run line's named file lives on this machine: `{dredd}` is the engine's folder and `{connections}` the
 *  checkout that carries it (the doctor left `{connections}` unfilled and called code-gate and page-pulse MISSING while
 *  both were on disk, 2026-09-23). A leading `~` is the home folder, same as `%USERPROFILE%` (rust-build's scan was
 *  joined onto the repository as `~/.claude/...` and called missing, 2026-09-23). */
export function benchRunnerPath(named, { engineDir, engineRoot, home }) {
  const filled = String(named).replace("{dredd}", engineDir.replace(/\\/g, "/")).replace("{connections}", engineRoot.replace(/\\/g, "/"));
  const homeFwd = String(home).replace(/\\/g, "/");
  return localSharedPath(filled, { engineRoot })
    .replace("%USERPROFILE%", homeFwd)
    .replace(/^~(?=[\\/])/, homeFwd);
}

export function renderDoctor(rows, { root = null } = {}) {
  const lines = [`DREDD DOCTOR${root ? ` · ${root}` : ""}`];
  for (const r of rows) lines.push(`  ${r.ok ? "ok  " : r.needed ? "MISSING" : "note"}  ${r.name.padEnd(36)} ${r.detail}`);
  const missing = rows.filter((r) => !r.ok && r.needed);
  lines.push(
    missing.length
      ? `${missing.length} needed thing(s) missing - a hearing on this machine will skip them.`
      : "Every needed thing is present.",
  );
  return { text: lines.join("\n"), missing: missing.length };
}

// --- live rows (--doctor --live) --------------------------------------------------------------------------------
//
// The static checks above answer "is the thing on disk". They cannot answer "does a dead DeepSeek pool still
// return an empty string" (a night of that went unseen, README:253-258) - only a live call can. So --live spends a
// few real cents to actually round-trip the brain, Jev, the sealed Opus login and (when it is on) the vision leg,
// each COUNTED and reported, never a key printed. Kept out of the static `doctor()` above because every one of
// these rows is a promise: the CLI wires --live to await them and append the rows, never blocking the plain,
// synchronous --doctor a hook or a script may call today.

/** The two-key schema a live probe answers with: proves the leg returns STRUCTURE, not prose the parser has to
 *  refuse. `ask` is injectable so the probe (and brainPreflight below) are testable with no network. */
const PREFLIGHT_SCHEMA = { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok", "note"] };

/**
 * One call the hearing can make before it spends on SUE: does ANY model answer with structure right now. A flaky
 * free leg is tried once more before this reports failure - the whole point is one free call, not a flaky one
 * costing a hearing. Returns { ok, model, seconds, structured, error }, never throws.
 */
export async function brainPreflight({ ask = askBrain } = {}) {
  const attempt = () =>
    ask({
      system: "Answer only through the schema.",
      prompt: "Reply with ok:true and a short note confirming you can answer in structured JSON.",
      schema: PREFLIGHT_SCHEMA,
      model: "auto",
      // The whole call, failover included: AUTO's first legs can each time out (~11 s) before one answers, and at 30 s
      // the preflight killed hearings the swarm was about to serve (2026-09-28, twice in a row). The cast call's 90 s
      // answers on the same route.
      timeoutS: 90,
      // No effort pin: AUTO runs at the profile's evaluated effort, and a pin the published profiles lack matches no
      // route (2026-09-25: "low" found none, so every hearing refused before SUE). Room for a thinking leg's reasoning.
      maxTokens: 2000,
    });
  let res = await attempt();
  if (res.status !== "ok") res = await attempt(); // one retry for a flaky free leg, then this names the failure
  return {
    ok: res.status === "ok" && Boolean(res.data),
    model: res.model || null,
    seconds: res.seconds ?? null,
    structured: Boolean(res.data),
    error: res.status === "ok" ? null : res.error || "no answer",
  };
}

// A one-pixel PNG (67 bytes), the smallest file a vision leg can be asked to look at.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * The `--doctor --live` rows: real round trips, each optional and each counted in the doctor's own {ok, detail,
 * needed} shape. `ask` and `jev` are injectable so this is testable without the network; `env` controls the
 * vision row (DREDD_VISION) the same way the rest of Dredd reads it.
 */
export async function liveDoctorRows({ ask = askBrain, jev = askJev, preflight = brainPreflight, env = process.env } = {}) {
  const rows = [];
  const add = (name, ok, detail, needed = true) => rows.push({ name, ok: Boolean(ok), detail, needed });

  // 1. a brain ask with a two-key schema on "auto": which model answered, how many seconds, and whether the
  // answer came back structured - the check that would have caught a dead pool before SUE was ever paid for.
  const pf = await preflight({ ask });
  add(
    "live: brain (auto)",
    pf.ok,
    pf.ok ? `${pf.model} answered structured in ${pf.seconds}s` : `no model answered with structure - ${pf.error}`,
  );

  // 2. one Jev yes/no item, answered by Jev or not - Jev is a fallback source (the docket falls back to keywords
  // without it), so a dead Jev is a note, never a blocker.
  const jr = await jev([{ id: "doctor-probe", type: "yesno", question: "Is 2 + 2 equal to 4? Answer yes." }], { timeoutMs: 40_000 });
  const jevOk = Boolean(jr.answers && jr.answers["doctor-probe"]);
  add(
    "live: Jev",
    jevOk,
    jevOk ? `Jev answered (${jr.summary?.model || "typesafe"})` : `Jev did not answer - ${jr.reason || "no answer"}`,
    false,
  );

  // 3. vision on: one tiny PNG, answered by a model that can see it, or a named refusal (NoVisionLeg) - never a
  // guess. Advisory: vision is a labelled second opinion (lib/vision.mjs), never a blocker for a hearing.
  if (visionEnabled(env)) {
    const dir = mkdtempSync(path.join(tmpdir(), "dredd-doctor-"));
    try {
      const png = path.join(dir, "tiny.png");
      writeFileSync(png, Buffer.from(TINY_PNG_BASE64, "base64"));
      const seen = await ask({
        system: "Answer only through the schema.",
        prompt: "Look at the screenshot. Reply sees:true only if you can actually see a pixel in it.",
        schema: { type: "object", properties: { sees: { type: "boolean" } }, required: ["sees"] },
        model: visionModel(env),
        images: [png],
        timeoutS: 60,
        maxTokens: 200,
      });
      const ok = seen.status === "ok" && seen.data?.sees === true;
      const refused = /novisionleg/i.test(String(seen.error || ""));
      add(
        "live: vision (tiny PNG)",
        ok,
        ok
          ? `${seen.model} saw it in ${seen.seconds}s`
          : refused
            ? `refused: ${seen.error}`
            : `no model answered with eyes - ${seen.error}`,
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return rows;
}
