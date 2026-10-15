import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, filesUnder } from "./source-files.mjs";
import { resolveChromiumPath } from "../lib/shared/browser-launch.mjs";

// Resolve before isolating HOME/LOCALAPPDATA, so tests still find the installed browser.
const chromiumPath = resolveChromiumPath();
const args = process.argv.slice(2);
const listFailures = args.includes("--list-failures");
const selected = args.filter((arg) => !arg.startsWith("--")).map((arg) => path.resolve(ROOT, arg));
const files = selected.length ? selected : ["sue", "dredd", "mcp", ].flatMap((area) => filesUnder(path.join(ROOT, area)))
  .filter((file) => /\.(?:spec|test)\.(?:mjs|ts)$/.test(file));
const logDir = path.join(ROOT, "tmp", "test-results");
const FILE_TIMEOUT_MS = 240_000;
mkdirSync(logDir, { recursive: true });
const results = [];
let cursor = 0;

async function run(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const output = [];
  const started = Date.now();
  const home = path.join(logDir, "homes", rel.replaceAll("/", "__"));
  mkdirSync(home, { recursive: true });
  const outcome = await new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let fallback;
    let timer;
    const finish = (answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      resolve({ ...answer, timedOut });
    };
    const child = spawn("bun", ["test", file, "--timeout", "120000"], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: {
        ...process.env, ...(chromiumPath ? { CHROMIUM_PATH: chromiumPath } : {}),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TEMP: home, TMP: home, TMPDIR: home, SUE_HOME: path.join(home, ".sue"),
        SUE_ENGINE_STORE: path.join(home, "engines"), SUE_WORKSPACE: path.join(home, "workspace"), SUE_DREDD_TEST: "1",
      },
    });
    timer = setTimeout(() => {
      timedOut = true;
      const error = `file exceeded ${FILE_TIMEOUT_MS / 1000}s; killed its test process tree`;
      output.push(Buffer.from(`\nTEST RUNNER: ${error}\n`));
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      fallback = setTimeout(() => finish({ code: null, error }), 5_000);
    }, FILE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", (err) => {
      output.push(Buffer.from(err.message));
      finish({ code: null, error: err.message });
    });
    child.on("close", (code, signal) => finish({ code, signal,
      ...(timedOut ? { error: `file exceeded ${FILE_TIMEOUT_MS / 1000}s` } : {}),
    }));
  });
  const text = Buffer.concat(output).toString("utf8");
  const log = path.join(logDir, rel.replaceAll("/", "__") + ".log");
  writeFileSync(log, text);
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const m of text.matchAll(/^\s*(\d+)\s+(pass|fail|skip)\s*$/gm)) counts[m[2]] += Number(m[1]);
  const state = outcome.code === 0 && !outcome.timedOut ? (counts.pass === 0 && counts.skip > 0 ? "SKIP" : "PASS") : "FAIL";
  const reason = readFileSync(file, "utf8").match(/^\s*\/\/ connections-only:\s*(.+)$/m)?.[1] || null;
  const result = { file: rel, state, ...counts, ...outcome, reason, ms: Date.now() - started,
    log: path.relative(ROOT, log).split(path.sep).join("/"),
  };
  results.push(result);
  console.log(`${state} ${rel} (${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip; ${(result.ms / 1000).toFixed(1)}s)`);
}

async function worker() {
  while (cursor < files.length) {
    const file = files[cursor++];
    if (!existsSync(file)) throw new Error(`Test file not found: ${file}`);
    await run(file);
  }
}
await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
results.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(path.join(logDir, "summary.json"), JSON.stringify(results, null, 2) + "\n");
const count = (state) => results.filter((r) => r.state === state).length;
console.log(`test files: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped (${results.length} total)`);
if (listFailures) {
  for (const r of results.filter((r) => r.state === "FAIL")) console.error(`FAILURE ${r.file}: ${r.error || r.signal || `exit ${r.code}`}; ${r.log}`);
  for (const r of results.filter((r) => r.skip > 0)) console.log(`SKIPPED ${r.file}: ${r.skip} test(s)${r.reason ? `; ${r.reason}` : " (conditional platform/runtime skip)"}`);
}
process.exitCode = count("FAIL") ? 1 : 0;
