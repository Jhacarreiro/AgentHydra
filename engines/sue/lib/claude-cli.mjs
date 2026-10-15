/**
 * claude-cli - the SEALED spawn of one Sue's brain: a Claude Code CLI session that knows nothing.
 * =================================================================================================
 *
 * ⛔ NO CLI LOGINS (the Chair, 2026-09-23, verbatim): "I never want you to use, like, the Claude code
 * or the GPT code CLI ... you're not allowed to use CLI logins." The ban is the LOGIN - a Claude Code
 * subscription session, a CLAUDE_CONFIG_DIR pointed at somebody's account. The Claude Code BINARY,
 * driven by a DeepSeek or OpenRouter API key (`deepseekEnv` / `openrouterEnv` below), stays allowed,
 * and so does the chat brain (the calling chat's own agents, `brain: "chat"`). The `claude` tier that
 * used to mean "the subscription login" is gone; `assertBrain("claude")` names the ruling.
 *
 * WHAT: `buildClaudeArgs` renders the exact flag list that `sue/SPEC.md` pins (no built-in
 * tools, no settings, only her body's MCP server allowed, stream-json out, no session left behind).
 * `sealedEnv` strips every key that would move billing onto whatever the launching shell happens to
 * hold (the local boardroom's `NO_BILL` lesson) - it is spawnBrain's own fallback env, and every
 * brain besides `chat` builds its OWN sealed env from scratch (`deepseekEnv`, `openrouterEnv`).
 * `spawnBrain` runs the CLI hidden, tees the stream-json to disk verbatim and hands the parsed
 * events to a callback, resolving on the final `result` event.
 *
 * WHY IT EXISTS: a Sue is only worth anything if she genuinely cannot see the code, the repo's
 * CLAUDE.md, the operator's hooks or any tool but her own eyes and hands. Every one of those leaks
 * is one forgotten flag away, so the flags live in ONE place with a test that pins them
 * (`tests/claude-cli.spec.mjs`, this module's spec; each Sue's own argv is pinned in cannon.spec).
 *
 * FLAG SPELLINGS were verified against `claude --help` on 2.1.273 (2026-09-20): `--system-prompt-file`,
 * `--max-turns` and `--no-session-persistence` are accepted though undocumented in the help text;
 * `--permission-mode default` still parses (the documented choices are acceptEdits, auto,
 * bypassPermissions, manual, dontAsk, plan) and in `-p` mode it denies anything outside
 * `--allowedTools` without asking, which is the whole point.
 *
 * WHICH CLAUDE: a new model needs a new CLI, and the `claude` on PATH is often behind the copies the
 * desktop app keeps per account. `resolveClaudeCli` takes the newest of the PATH one (on Windows the
 * real `claude.exe` behind the npm `.cmd` shim, which Node 22 refuses to spawn without a shell) and
 * every installed copy, and says which path and version it took; `SUE_CLAUDE_BIN` overrides. This
 * still matters on `deepseek`/`openrouter`: both drive that same executable, just over an API key
 * instead of a login. `cliRefusalAdvice` turns a "too old for this model" refusal into the fix.
 *
 * WHO DEPENDS ON IT: `cannon.mjs` (every Sue), `tests/claude-cli.spec.mjs`; `dredd/lib/brain.mjs`
 * imports `sealedEnv` and `resolveClaudeBin` (a peer-held file - it may drop that import on its own).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { stateRoot } from "./run-dir.mjs";

export const STRIPPED_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/**
 * The whole families `deepseekEnv` and `openrouterEnv` strip from the LAUNCHER's own environment
 * before writing their own values over them (and `sealedEnv` strips too, for its own fallback use).
 * A launcher's `ANTHROPIC_BASE_URL` (endpoint), `ANTHROPIC_MODEL` or `ANTHROPIC_DEFAULT_*_MODEL`
 * (model pin) and `CLAUDE_CODE_OAUTH_TOKEN` (a subscription's own billing token) would each override
 * the key-pool env those two build, so a Sue fired from an HSwarm cc worker would think and bill
 * somewhere else; `CLAUDECODE` marks a session already inside Claude Code.
 */
export const STRIPPED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];

export const BODY_TOOL_PATTERN = "mcp__sue__*";

/**
 * The model every Sue thinks with unless a persona or `--model` names another: the `chat` tier's own
 * default (a persona's own agent still knows what it is) and every tier's preflight probe model.
 * `deepseek`/`openrouter` never ask for it - each pins its own model - but both still spawn this same
 * Claude Code CLI, driven by that key rather than a login, so it needs Claude Code 2.1.280 or newer,
 * which `resolveClaudeBin` finds on its own. Owner, 2026-09-22: "Every use of Sue should be using our
 * local model with the brain", and then "use Opus 5.5, not Opus 5 ... if you use thinking, it's
 * actually Opus 5.5 is the cheapest". Owner, 2026-10-05, REPLACED that (and the 2026-09-23 Opus ruling): "Please
 * spin up the Sues moving forward as Sonnet 5.5, not Opus." Every Sue is Sonnet 5.5 now; never Haiku.
 */
export const SUE_DEFAULT_MODEL = "claude-sonnet-5-5";
/** The line a chat puts in each Sue agent's prompt: the routing gate refuses a prompt that is only a brief path. */
export const SUE_BRAIN_REASON =
  "why-not-hswarm: SUE's contract puts every visitor on Sonnet 5.5 (Dredd's SUE tier, owner 2026-10-05), and her hands are a local browser session on this PC that only a local Bash can drive.";

export function assertNotHaiku(model) {
  if (typeof model !== "string" || !model.trim()) throw new Error("a brain needs a model");
  if (/haiku/i.test(model)) throw new Error(`never a Haiku brain (owner rule): got "${model}"`);
  return model;
}

/** The exact argv after the executable, in SPEC.md's order. Pure: no I/O, so tests pin it. */
export function buildClaudeArgs({ scenarioPrompt, systemPromptFile, mcpConfigFile, model = SUE_DEFAULT_MODEL, maxTurns = 60 }) {
  if (typeof scenarioPrompt !== "string" || !scenarioPrompt.trim()) throw new Error("buildClaudeArgs: scenarioPrompt");
  if (!systemPromptFile) throw new Error("buildClaudeArgs: systemPromptFile");
  if (!mcpConfigFile) throw new Error("buildClaudeArgs: mcpConfigFile");
  assertNotHaiku(model);
  const turns = Number.parseInt(String(maxTurns), 10);
  if (!Number.isInteger(turns) || turns < 1) throw new Error(`buildClaudeArgs: maxTurns must be a positive integer, got ${maxTurns}`);
  return [
    "-p",
    scenarioPrompt,
    "--model",
    model,
    "--system-prompt-file",
    systemPromptFile,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    "",
    "--allowedTools",
    BODY_TOOL_PATTERN,
    "--permission-mode",
    "default",
    "--max-turns",
    String(turns),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ];
}

/**
 * Her `mcp.json`: ONE server, named `sue` (the one name BODY_TOOL_PATTERN lets through), so with
 * `--strict-mcp-config` her brain loads her body's tools and nothing else. `hosted` (lib/body-host.mjs
 * `mcpServerFor`) is her body in one of the run's host processes, over HTTP on her own loopback path
 * with her own bearer (Owner, 2026-09-24: hundreds of Sues from one Chrome - a body process of her own
 * was 137 MB); without it her body is its own process over stdio, `node body.mjs --sue <dir>`, as
 * before. A hosted URL that is not this machine's loopback is refused: her hands never leave the box.
 */
export function sueMcpConfig({ bodyFile, sueDir, hosted = null }) {
  if (!hosted) return { mcpServers: { sue: { command: "node", args: [bodyFile, "--sue", sueDir] } } };
  if (hosted.type !== "http" || !/^http:\/\/127\.0\.0\.1:\d+\/sue\/[^/]+\/mcp$/.test(String(hosted.url)))
    throw new Error(`sueMcpConfig: a hosted body is a loopback http path, got ${hosted.type} ${hosted.url}`);
  return { mcpServers: { sue: { type: "http", url: hosted.url, headers: { ...hosted.headers } } } };
}

/**
 * A copy of `base` minus every API-billing key and every `ANTHROPIC_*` / `CLAUDE_CODE_*` override.
 * `CLAUDECODE` is dropped too, so a spawned brain is never told it is already inside Claude Code.
 * There is no login to pin here anymore (2026-09-23: no CLI logins) - this is only `spawnBrain`'s
 * own fallback env for a caller that passes none; `deepseekEnv`/`openrouterEnv` build their own.
 */
export function sealedEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const key = k.toUpperCase();
    if (STRIPPED_ENV_KEYS.includes(key) || STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || key === "CLAUDECODE") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * THE DEEPSEEK BRAIN - HSwarm's own recipe for running Claude Code against DeepSeek's
 * Anthropic-compatible endpoint (hswarm/claude_env.py `cc_env`),
 * re-stated here so a wave of Sues can run on the tier the owner prefers for volume (the Chair,
 * 2026-09-15: DeepSeek over Sonnet in pretty much all situations) while `chat` (the calling chat's
 * own agents) stays the default for an attended run. There is no subscription tier to fall back to
 * (the Chair, 2026-09-23: no CLI logins). Every Claude/Anthropic variable of the operator's own session
 * is stripped first, so a Sue can never bill or speak as the session that fired her. The CLI talks to the
 * AI plane's door (`aiDoor` below) on a door credential; Sue reads no provider key.
 *
 * ⛔ `--setting-sources ""` does not stop the CLI reading `CLAUDE_CONFIG_DIR/.claude.json` for the
 * onboarding flag, so the brain gets its own seeded config dir under sue/state - never the
 * HSwarm worker's (`bypassPermissions` + a worker CLAUDE.md + hooks are exactly the things a sealed Sue
 * must not inherit).
 */
export const DEEPSEEK_MODEL = "deepseek-flash";
/**
 * Every candidate key in one env value or key file. Comment lines are dropped WHOLE before any
 * splitting, so `# sk-dead` never yields `sk-dead`: a key the owner commented out is neither
 * balance-probed nor used, and no word of a comment is ever sent as a bearer token. Live text
 * still splits on commas, semicolons and whitespace. Shared by both brains; values never leave
 * this module.
 */
export function parseKeyCandidates(text) {
  const keys = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    for (const k of line.split(/[,;\s]+/)) if (k && !k.startsWith("#") && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * THE AI DOOR (Owner, 2026-10-13: "all AI usage ... better be going to the AI plane"). Both paid brains
 * point the CLI's ANTHROPIC_BASE_URL at the AI plane's Anthropic pass-through (services/ai ai-anthropic.ts),
 * which holds the DeepSeek and OpenRouter key pools, rotates them and writes the `ai_spend` line. Sue holds
 * no provider key: the CLI gets a short-lived AEGIS M2M token (600 s) from its `apiKeyHelper`
 * (lib/door-token-helper.mjs, minted the way every operator script mints one, re-run every 4 min), or
 * `SUE_AI_DOOR_TOKEN` as a fixed ANTHROPIC_AUTH_TOKEN when set. The door
 * picks the upstream by model id: a bare `deepseek-*` is DeepSeek, `vendor/model` is OpenRouter.
 */
async function aiDoor(base) {
  const origin = String(base.SUE_AI_DOOR_URL || "").trim();
  if (!origin) throw new Error("set SUE_AI_DOOR_URL (an Anthropic-compatible endpoint) and SUE_AI_DOOR_TOKEN to use the paid brains");
  const token = String(base.SUE_AI_DOOR_TOKEN || "").trim();
  return { url: origin.replace(/\/$/, ""), token };
}

/** The door credential in the child's env: the fixed token. */
function doorAuth(door, configDir) {
  fs.rmSync(path.join(configDir, "settings.json"), { force: true });
  return { ANTHROPIC_AUTH_TOKEN: door.token };
}

export async function deepseekEnv(base = process.env, { stateDir } = {}) {
  const door = await aiDoor(base);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("CLAUDE_CODE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k === "CLAUDE_CONFIG_DIR") continue;
    if (v !== undefined) env[k] = v;
  }
  // Sue's state folder (SUE_HOME-aware), never beside the engine's code: a store engine's folder is
  // deleted once no run leases it (lib/engine-lease.mjs), and this seeded config must outlive it.
  const configDir = path.resolve(stateDir || stateRoot(), "deepseek-claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  const onboarding = path.join(configDir, ".claude.json");
  if (!fs.existsSync(onboarding)) fs.writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true }));
  Object.assign(env, {
    ANTHROPIC_BASE_URL: door.url,
    ...doorAuth(door, configDir),
    ANTHROPIC_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  return env;
}

/**
 * THE OPENROUTER BRAIN (2026-09-21): the DeepSeek recipe above, over OpenRouter's Anthropic-
 * compatible endpoint instead (HSwarm's `openrouter` provider in hswarm/config.py:
 * `anthropic_url` https://openrouter.ai/api, the key as a bearer token, so ANTHROPIC_AUTH_TOKEN
 * rather than ANTHROPIC_API_KEY). Built the night every DeepSeek key in the pool answered 402 and
 * the owner ruled that no human signs in for a tool ("you will build the logins, wire them in,
 * whatever you need"); the OpenRouter pool had four keys with credit. The model is HSwarm's
 * `deepseek-flash-or` leg, DeepSeek V4.1 Flash routed by OpenRouter (SUE_OPENROUTER_MODEL
 * overrides). Since 2026-10-13 the AI plane's door holds the OpenRouter key pool (see `aiDoor`); Sue
 * holds none. Same sealed config dir discipline as above.
 */
export const OPENROUTER_MODEL = process.env.SUE_OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash";
export async function openrouterEnv(base = process.env, { stateDir } = {}) {
  const door = await aiDoor(base);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("CLAUDE_CODE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k === "CLAUDE_CONFIG_DIR") continue;
    if (v !== undefined) env[k] = v;
  }
  const configDir = path.resolve(stateDir || stateRoot(), "openrouter-claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  const onboarding = path.join(configDir, ".claude.json");
  if (!fs.existsSync(onboarding)) fs.writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true }));
  Object.assign(env, {
    ANTHROPIC_BASE_URL: door.url,
    ...doorAuth(door, configDir),
    ANTHROPIC_MODEL: OPENROUTER_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: OPENROUTER_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: OPENROUTER_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: OPENROUTER_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: OPENROUTER_MODEL,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  return env;
}

/**
 * THE LOCAL BRAIN (Owner, 2026-09-23: "make sure that Sue has the ability to work fully offline").
 * The same Claude Code CLI as the two tiers above, pointed at a model server on THIS machine instead
 * of a paid pool: LM Studio (:1234) or Ollama (:11434), both of which answer the Anthropic Messages
 * API Claude Code speaks. No key, no login, no internet: a Sue whose target is a localhost page runs
 * with the network cable out. SUE_LOCAL_URL names any other server (SUE_LOCAL_TOKEN its bearer, if it
 * wants one). The model is whatever that server has loaded, named by --model or SUE_LOCAL_MODEL: a
 * Claude model id means nothing to a local server, so there is no default to fall back to, and the
 * refusal lists what IS loaded. Same sealed config dir discipline as the paid tiers.
 */
export const LOCAL_MODEL_SERVERS = [
  { name: "LM Studio", url: "http://127.0.0.1:1234", token: "lmstudio" },
  { name: "Ollama", url: "http://127.0.0.1:11434", token: "ollama" },
];

/** The first local server that answers `GET /v1/models`, with the model ids it lists; null when none does. */
export async function findLocalModelServer(base = process.env, fetchImpl = fetch) {
  const servers = base.SUE_LOCAL_URL
    ? [{ name: "SUE_LOCAL_URL", url: String(base.SUE_LOCAL_URL).replace(/\/$/, ""), token: base.SUE_LOCAL_TOKEN || "local" }]
    : LOCAL_MODEL_SERVERS;
  for (const server of servers) {
    try {
      const res = await fetchImpl(`${server.url}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const body = await res.json();
      return { ...server, models: (body?.data || []).map((m) => m?.id).filter(Boolean) };
    } catch {
      // next server
    }
  }
  return null;
}

const TOOL_RESULT_IMAGE_NOTE = "(screenshot below)";

/**
 * A local model server rejects a tool_result whose content holds an image block ("Only text tool_result
 * blocks are supported"). Moves each such image out of its tool_result, after the message's tool_results,
 * leaving a text note in its place. Returns the rewritten body, or null when there is nothing to move.
 */
export function rewriteToolResultImages(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(body?.messages)) return null;
  let moved = false;
  for (const message of body.messages) {
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const images = [];
    const content = message.content.map((block) => {
      if (block?.type !== "tool_result" || !Array.isArray(block.content)) return block;
      if (!block.content.some((part) => part?.type === "image")) return block;
      return {
        ...block,
        content: block.content.map((part) => {
          if (part?.type !== "image") return part;
          images.push(part);
          return { type: "text", text: TOOL_RESULT_IMAGE_NOTE };
        }),
      };
    });
    if (images.length === 0) continue;
    moved = true;
    message.content = [...content, ...images];
  }
  return moved ? JSON.stringify(body) : null;
}

const IMAGE_HISTORY_KEEP = 2;
const IMAGE_EVICTED_NOTE = "(an earlier screenshot, removed to fit the local model)";
// Measured on qwen3-vl-30b-a3b: one 45 KB screenshot adds 1,003 prompt tokens (LM Studio usage.prompt_tokens).
const TOKENS_PER_IMAGE = 1003;
const TEXT_BYTES_PER_TOKEN = 3.5;

function imageSlots(body) {
  const slots = [];
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    message.content.forEach((block, i) => {
      if (block?.type === "image") slots.push({ parts: message.content, i });
      else if (block?.type === "tool_result" && Array.isArray(block.content))
        block.content.forEach((part, j) => {
          if (part?.type === "image") slots.push({ parts: block.content, i: j });
        });
    });
  }
  return slots;
}

function promptTokens(bytes, slots) {
  const imageBytes = slots.reduce((sum, { parts, i }) => sum + (parts[i].source?.data?.length ?? 0), 0);
  return Math.ceil((bytes - imageBytes) / TEXT_BYTES_PER_TOKEN) + slots.length * TOKENS_PER_IMAGE;
}

/**
 * Keeps the newest screenshots in a request and replaces older ones with a text note, so a long
 * history cannot outgrow the local model's context. Returns the estimated prompt tokens before and
 * after; `body` is null when nothing was dropped. Null when the raw text is not a messages body.
 */
export function boundImageHistory(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(body?.messages)) return null;
  const slots = imageSlots(body);
  const before = promptTokens(Buffer.byteLength(raw), slots);
  const evicted = slots.slice(0, Math.max(0, slots.length - IMAGE_HISTORY_KEEP));
  for (const { parts, i } of evicted) parts[i] = { type: "text", text: IMAGE_EVICTED_NOTE };
  const kept = slots.slice(evicted.length);
  const serialized = evicted.length ? JSON.stringify(body) : null;
  return {
    body: serialized,
    images: slots.length,
    dropped: evicted.length,
    before,
    after: serialized ? promptTokens(Buffer.byteLength(serialized), kept) : before,
  };
}

// Measured 2026-10-08 on the warm local model: one request at a time finished four 8,405-token
// screenshot requests in 21.1 s, two at a time in 23.0 s, four at a time in 21.2 s with a 400 on the
// first (32,768 context split four ways leaves 8,192 per slot).
const LOCAL_CONCURRENCY = 1;
const localSlots = { busy: 0, queue: [] };

function takeLocalSlot() {
  return new Promise((resolve) => {
    if (localSlots.busy < LOCAL_CONCURRENCY) {
      localSlots.busy++;
      resolve();
    } else localSlots.queue.push(resolve);
  });
}

function giveLocalSlot() {
  const next = localSlots.queue.shift();
  if (next) next();
  else localSlots.busy--;
}

/**
 * A loopback proxy in front of a local model server: only POST /v1/messages bodies are buffered and
 * rewritten by `rewriteToolResultImages` and bounded by `boundImageHistory`, then sent one at a time
 * across every proxy in this process; every response streams through untouched.
 */
function usageOf(text) {
  const last = (re) => {
    const found = [...text.matchAll(re)];
    return found.length ? Number(found[found.length - 1][1]) : null;
  };
  return { promptTokens: last(/"input_tokens"\s*:\s*(\d+)/g), completionTokens: last(/"output_tokens"\s*:\s*(\d+)/g) };
}

/**
 * `logFile` gets one JSON line per POST /v1/messages (sue, queue wait, model seconds, prompt and completion
 * tokens, screenshots, HTTP status, error text). `queuedMs()` is the time this proxy's requests have spent
 * waiting for the local slot, so a brain's deadline can leave it out. `errors` names every HTTP 4xx/5xx the
 * local server answered, so the brain's stderr says why a Sue went quiet.
 */
export function startToolResultProxy(upstreamUrl, { logFile, tag } = {}) {
  const upstream = new URL(upstreamUrl);
  const waiting = new Set();
  let queuedDone = 0;
  const errors = [];
  const queuedMs = () => {
    let total = queuedDone;
    for (const since of waiting) total += Date.now() - since;
    return total;
  };
  const record = (row) => {
    if (logFile) fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), sue: tag ?? null, ...row }) + "\n");
  };
  const server = http.createServer((req, res) => {
    const forward = (body, release, log) => {
      const headers = { ...req.headers, host: upstream.host };
      if (body) {
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
      }
      const sentAt = Date.now();
      const up = http.request(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          const chunks = [];
          upRes.on("data", (chunk) => chunks.push(chunk));
          upRes.pipe(res);
          upRes.on("end", () => {
            release?.();
            if (!log) return;
            const text = Buffer.concat(chunks).toString("utf8");
            const row = { ...log, modelS: Math.round((Date.now() - sentAt) / 100) / 10, httpStatus: upRes.statusCode, ...usageOf(text) };
            if (upRes.statusCode >= 400) {
              const error = text.slice(0, 400);
              row.error = error;
              errors.push(`HTTP ${upRes.statusCode} from ${upstream.origin}: ${error}`);
              process.stderr.write(`sue local proxy: HTTP ${upRes.statusCode} from ${upstream.origin}: ${error}\n`);
            }
            record(row);
          });
        },
      );
      up.on("error", (err) => {
        release?.();
        if (log) {
          errors.push(`no answer from ${upstream.origin}: ${err.message}`);
          record({ ...log, httpStatus: 502, error: err.message });
        }
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`tool-result proxy could not reach ${upstream.origin}: ${err.message}`);
      });
      if (body) up.end(body);
      else req.pipe(up);
    };
    if (req.method !== "POST" || req.url.split("?")[0] !== "/v1/messages") return forward(null);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const moved = rewriteToolResultImages(text) ?? text;
      const bounded = boundImageHistory(moved);
      if (bounded)
        process.stderr.write(
          `sue local proxy: ~${bounded.before} -> ~${bounded.after} est. prompt tokens (${bounded.images} screenshots, ${bounded.dropped} older removed)\n`,
        );
      const sent = bounded?.body ?? moved;
      const queuedAt = Date.now();
      waiting.add(queuedAt);
      await takeLocalSlot();
      waiting.delete(queuedAt);
      const waited = Date.now() - queuedAt;
      queuedDone += waited;
      if (waited > 1000) process.stderr.write(`sue local proxy: waited ${Math.round(waited / 1000)} s for a free local slot\n`);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        giveLocalSlot();
      };
      const log = {
        queueS: Math.round(waited / 100) / 10,
        screenshots: bounded?.images ?? null,
        droppedScreenshots: bounded?.dropped ?? 0,
        estPromptTokens: bounded?.after ?? null,
        bytes: Buffer.byteLength(sent),
      };
      forward(sent === text ? raw : Buffer.from(sent, "utf8"), release, log);
    });
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      let stopped = false;
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        queuedMs,
        errors,
        stop: () => {
          if (stopped) return;
          stopped = true;
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

const LOCAL_PROXIES = new WeakMap();

export async function localEnv(base = process.env, { stateDir, model, fetchImpl = fetch, proxyLog } = {}) {
  const server = await findLocalModelServer(base, fetchImpl);
  if (!server)
    throw new Error(
      "--brain local: no local model server answered (LM Studio on :1234 or Ollama on :11434; SUE_LOCAL_URL names another). Start one with a model loaded.",
    );
  const wanted = model || base.SUE_LOCAL_MODEL;
  const loaded = server.models.length ? server.models.join(", ") : "none";
  if (!wanted) throw new Error(`--brain local: name the model with --model or SUE_LOCAL_MODEL (${server.name} has loaded: ${loaded})`);
  if (server.models.length && !server.models.includes(wanted))
    throw new Error(`--brain local: ${server.name} has no model "${wanted}" loaded (loaded: ${loaded})`);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("CLAUDE_CODE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k === "CLAUDE_CONFIG_DIR") continue;
    if (v !== undefined) env[k] = v;
  }
  const configDir = path.resolve(stateDir || stateRoot(), "local-claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  const onboarding = path.join(configDir, ".claude.json");
  if (!fs.existsSync(onboarding)) fs.writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true }));
  Object.assign(env, {
    ANTHROPIC_BASE_URL: server.url,
    ANTHROPIC_AUTH_TOKEN: server.token,
    ANTHROPIC_MODEL: wanted,
    ANTHROPIC_SMALL_FAST_MODEL: wanted,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: wanted,
    ANTHROPIC_DEFAULT_SONNET_MODEL: wanted,
    ANTHROPIC_DEFAULT_OPUS_MODEL: wanted,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const proxy = await startToolResultProxy(server.url, proxyLog);
  env.ANTHROPIC_BASE_URL = proxy.url;
  LOCAL_PROXIES.set(env, proxy);
  return env;
}

/**
 * The brain tiers, exactly these four. `chat` (default): no CLI at all, no login of the tool's - an
 * agent of the chat that started the run drives each Sue through hand.mjs. `deepseek` / `openrouter`:
 * the real Claude Code CLI, driven by an API key from that pool (`deepseekEnv` / `openrouterEnv`
 * above) - never a login, so this stays allowed under the 2026-09-23 ruling. `local`: the same CLI
 * against a model server on this machine (`localEnv`), fully offline. The old `claude` tier
 * (a Claude Code CLI signed into a subscription login) is retired, not renamed: `assertBrain` below
 * names the ruling for anyone who still types it.
 */
export const BRAINS = ["chat", "deepseek", "openrouter", "local"];

/**
 * THIS MACHINE's brains for SUE, or null when it names none (then every tier above is open). A file outside any
 * checkout, so it binds every SUE door on the machine (sue run, the cannon, DREDD's hearings) and never travels:
 * `~/.connections/sue-brains.json` (SUE_BRAIN_POLICY overrides the path), shaped
 * `{ "brains": ["chat"], "model": "claude-sonnet-5-5", "why": "..." }`. Owner, 2026-09-23, on his PC: "None of Sue
 * should be using DeepSeek" (the model half, Opus 5.5, was replaced 2026-10-05 by Sonnet 5.5). There the only brain
 * is the chat's own agents, one Sonnet 5.5 agent per Sue. Per machine, because the Chair's PC runs DREDD's unattended hearings on the
 * API pools. An unreadable or malformed file names no policy rather than locking SUE out.
 */
export function sueBrainPolicy() {
  // A test run never reads the machine's own file (a spec would pass or fail by whose PC ran it); a spec that wants
  // a policy names one with SUE_BRAIN_POLICY. node --test marks every test process, and the ones they spawn, with
  // NODE_TEST_CONTEXT; bun test sets NODE_ENV=test instead.
  if (!process.env.SUE_BRAIN_POLICY && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test")) return null;
  const file = process.env.SUE_BRAIN_POLICY || path.join(os.homedir(), ".connections", "sue-brains.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const brains = Array.isArray(raw?.brains) ? raw.brains.filter((b) => BRAINS.includes(b)) : [];
  if (!brains.length) return null;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
  return { brains, model, why: String(raw.why ?? "").trim(), file };
}

/** `brain` when it names a tier this machine allows, else an Error that says what to type instead. */
export function assertBrain(brain) {
  if (BRAINS.includes(brain)) {
    const policy = sueBrainPolicy();
    if (policy && !policy.brains.includes(brain))
      throw new Error(
        `this machine runs Sue only on --brain ${policy.brains.join(" | ")}${policy.model ? ` (${policy.model})` : ""}, never ${brain}` +
          `${policy.why ? ` - ${policy.why}` : ""} (${policy.file})`,
      );
    return brain;
  }
  const lower = String(brain).trim().toLowerCase();
  // the Chair, 2026-09-23, verbatim: "I never want you to use, like, the Claude code or the GPT code
  // CLI ... you're not allowed to use CLI logins." Named on purpose, not folded into "unknown", so
  // whoever still types it reads the ruling instead of a generic spelling error.
  if (lower === "claude")
    throw new Error(
      `the "claude" brain (a Claude Code CLI login) is retired - the Chair, 2026-09-23: no CLI logins. ` +
        `Use --brain chat (the calling chat's own agents), openrouter / deepseek (API keys) or local (a model on this machine).`,
    );
  if (lower === "sonnet")
    throw new Error(
      `there is no "sonnet" brain: brains are ${BRAINS.join(" | ")}, and --model picks who thinks (default ${SUE_DEFAULT_MODEL})`,
    );
  throw new Error(`unknown --brain ${brain} (${BRAINS.join(" | ")})`);
}

/**
 * The model a brain tier thinks with, resolved ONCE here instead of at each call site. An explicit
 * `--model` (or, on the chat tier, a persona's own model) wins; otherwise the tier decides:
 * DEEPSEEK_MODEL or OPENROUTER_MODEL, never SUE_DEFAULT_MODEL. Claude Code's `--model` flag beats the
 * ANTHROPIC_MODEL the deepseek/openrouter env pins, so without this a `--brain deepseek` Sue asked the
 * paid pool for `claude-opus-5-5` and `summary.model` recorded Opus for a DeepSeek run (2026-09-22).
 */
export function modelForBrain(brain, { model, personaModel } = {}) {
  const tier = brain ? assertBrain(brain) : "chat";
  if (model) return model;
  if (tier === "deepseek") return DEEPSEEK_MODEL;
  if (tier === "openrouter") return OPENROUTER_MODEL;
  if (tier === "local") {
    // A persona's Claude model id means nothing to LM Studio or Ollama, so it is never used here.
    if (process.env.SUE_LOCAL_MODEL) return process.env.SUE_LOCAL_MODEL;
    throw new Error("--brain local: name the loaded model with --model or SUE_LOCAL_MODEL");
  }
  return personaModel || SUE_DEFAULT_MODEL;
}

/** The env for a brain of the given tier; unset is `chat`. `chat` has no env to give - it spawns no CLI. */
export async function brainEnv(brain, base = process.env, { stateDir, model, proxyLog } = {}) {
  const tier = brain ? assertBrain(brain) : "chat";
  if (tier === "chat") throw new Error("a chat brain is the calling chat's own agent: there is no CLI to give an env");
  if (tier === "deepseek") return deepseekEnv(base, { stateDir });
  if (tier === "local") return localEnv(base, { stateDir, model, proxyLog });
  return openrouterEnv(base, { stateDir });
}

/** "2.1.280 (Claude Code)" or a folder named "2.1.280" as [2, 1, 280]; anything else is [0, 0, 0]. */
export function cliVersion(text) {
  return (versionText(text) || "0.0.0").split(".").map(Number);
}

/** "2.1.280" when the text holds a version, else null. */
function versionText(text) {
  return String(text || "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function newerThan(a, b) {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
}

const askedVersions = new Map();

/** npm's postinstall (the package's `install.cjs`) reads a `bin/claude.exe` under this size as its placeholder stub. */
const NPM_STUB_BYTES = 4096;

/**
 * One executable's version, cheapest proof first: its `<version>/` folder (the desktop app's layout),
 * then the `package.json` beside `bin/claude.exe` (the npm shim's layout), and only then `--version`,
 * asked once per path per process (about a second each). null when nothing answers, and for the stub
 * npm leaves when the native binary never arrived (`--omit=optional`, a failed download): it runs nothing.
 */
export function claudeBinVersion(bin) {
  const dir = path.dirname(bin);
  if (/^\d+\.\d+\.\d+$/.test(path.basename(dir))) return path.basename(dir);
  if (path.basename(dir) === "bin") {
    try {
      const v = versionText(JSON.parse(fs.readFileSync(path.join(dir, "..", "package.json"), "utf8")).version);
      if (v) return fs.statSync(bin).size < NPM_STUB_BYTES ? null : v;
    } catch {
      // not the npm layout: ask the executable
    }
  }
  if (!askedVersions.has(bin)) {
    const asked = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000, shell: /\.cmd$/i.test(bin) });
    askedVersions.set(bin, versionText(asked.stdout));
  }
  return askedVersions.get(bin);
}

/** The `claude` on PATH: on Windows the real `.exe` behind the npm shim, else the bare name. */
function pathClaudeBin(env) {
  if (process.platform !== "win32") return "claude";
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(exe)) return exe;
    const bare = path.join(dir, "claude.exe");
    if (fs.existsSync(bare)) return bare;
  }
  // No native executable on PATH. The npm `claude.cmd` shim would have to run through cmd.exe, which
  // does not quote arguments: it splits the multi-line scenario prompt and drops the empty
  // --setting-sources and --tools values, breaking the sealed flag set. `resolveClaudeCli` refuses.
  return null;
}

/**
 * Every CLI the desktop app keeps on disk, as `{ bin, version: "2.1.280" }`: one `<version>/claude(.exe)` per
 * folder under each account instance's `~/.claude-instances/<name>/claude-code/` and under the app's
 * own `%APPDATA%/Claude/claude-code/`. A missing folder is simply not a candidate.
 */
export function installedClaudeBins(env = process.env) {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const home = env.USERPROFILE || env.HOME || "";
  const roots = [];
  const instances = path.join(home, ".claude-instances");
  for (const name of safeList(instances)) roots.push(path.join(instances, name, "claude-code"));
  if (env.APPDATA) roots.push(path.join(env.APPDATA, "Claude", "claude-code"));
  const found = [];
  for (const root of roots)
    for (const v of safeList(root)) {
      const bin = path.join(root, v, exe);
      if (fs.existsSync(bin)) found.push({ bin, version: versionText(v) });
    }
  return found;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The CLI to spawn, as `{ bin, version, source, found }`: `SUE_CLAUDE_BIN` when set, else the newest,
 * by version number, of the PATH `claude` (on Windows the npm shim's own `claude.exe`, versioned from
 * its package.json) and every copy `installedClaudeBins` finds; a tie keeps the PATH one. Nobody has
 * to update the shared CLI mid-wave or set a variable by hand for a model the PATH one refuses:
 * Claude Code 2.1.273 answers `claude-opus-5-5` with "version 2.1.280 or newer is required", and on
 * 2026-09-22 that refused every Opus 5.5 wave while four account copies of 2.1.280 sat on the disk.
 * A fresh scan each call (a directory listing; only a bare exe is ever run, once per process).
 */
export function resolveClaudeCli(env = process.env) {
  if (env.SUE_CLAUDE_BIN)
    return { bin: env.SUE_CLAUDE_BIN, version: claudeBinVersion(env.SUE_CLAUDE_BIN), source: "SUE_CLAUDE_BIN", found: 1 };
  const onPath = pathClaudeBin(env);
  const known = [...(onPath ? [{ bin: onPath, version: claudeBinVersion(onPath) }] : []), ...installedClaudeBins(env)].filter(
    (c) => c.version,
  );
  if (!known.length) {
    // No native executable anywhere, and the npm `claude.cmd` shim is never spawned (cmd.exe splits
    // the scenario prompt and drops the empty --setting-sources/--tools values). Refuse and name the fix.
    if (!onPath)
      throw new Error(
        "no claude executable on PATH and none installed, and the npm claude.cmd shim is never spawned (cmd.exe would split the scenario prompt and drop the empty flags): set SUE_CLAUDE_BIN to the full path of a claude.exe",
      );
    return { bin: onPath, version: null, source: "the claude on PATH, no version found", found: 0 };
  }
  let best = known[0];
  for (const c of known.slice(1)) if (newerThan(cliVersion(c.version), cliVersion(best.version))) best = c;
  return { bin: best.bin, version: best.version, source: `the newest of ${known.length} on this machine`, found: known.length };
}

const chosenBins = new Map();

/**
 * The path `resolveClaudeCli` picks, chosen once per environment and kept for the process, so every
 * Sue of a wave runs the same CLI; chosen again only if that file has gone (the desktop app prunes
 * old versions as it updates).
 */
export function resolveClaudeBin(env = process.env) {
  if (env.SUE_CLAUDE_BIN) return env.SUE_CLAUDE_BIN;
  const key = [env.PATH || env.Path || "", env.USERPROFILE || env.HOME || "", env.APPDATA || ""].join("|");
  const kept = chosenBins.get(key);
  if (kept && fs.existsSync(kept)) return kept;
  const { bin } = resolveClaudeCli(env);
  chosenBins.set(key, bin);
  return bin;
}

/** "C:\...\2.1.280\claude.exe (Claude Code 2.1.280, the newest of 22 on this machine)", for a log line. */
export function describeClaudeCli({ bin, version, source }) {
  return `${bin} (Claude Code${version ? ` ${version}` : ", version unknown"}, ${source})`;
}

/**
 * What a brain refusal adds about the CLI behind it: always which executable and version answered,
 * and, when the error says the CLI is too old for the model, how to point SUE at a newer one.
 */
export function cliRefusalAdvice(cli, message) {
  const used = `the CLI was ${describeClaudeCli(cli)}`;
  const text = String(message || "");
  const needs = text.match(/version (\d+\.\d+\.\d+) or newer is required/i)?.[1];
  if (!needs && !/does not support this model/i.test(text)) return used;
  const want = needs ? `Claude Code ${needs} or newer` : "a newer Claude Code";
  const how =
    cli.source === "SUE_CLAUDE_BIN"
      ? `point SUE_CLAUDE_BIN at a claude executable of ${want}, or unset SUE_CLAUDE_BIN so SUE takes the newest on the machine`
      : `nothing newer is on this machine: set SUE_CLAUDE_BIN to the full path of a claude executable of ${want} (the desktop app keeps one per account at ~/.claude-instances/<name>/claude-code/<version>/)`;
  return `${used}, too old for this model; ${how}, then run the cannon again`;
}

/**
 * Spawns the brain hidden, tees stdout verbatim to `stdoutFile`, parses each stream-json line and
 * hands it to `onEvent`. Resolves `{ code, result, timedOut }` where `result` is the last
 * `type: "result"` event (or null when the process died before emitting one). `timeoutMs` bounds the
 * whole session: on expiry the CLI and every process under it are killed and `timedOut` is true, so a
 * hung brain cannot hold its wave forever. Never rejects on a non-zero exit: a Sue who crashed is a
 * finding, not an exception.
 */
export function spawnBrain({ args, env, cwd, stdoutFile, onEvent, bin, timeoutMs = 0, input } = {}) {
  if (!Array.isArray(args)) throw new Error("spawnBrain: args");
  const exe = bin || resolveClaudeBin(env || process.env);
  const useShell = /\.cmd$/i.test(exe);
  const child = spawn(exe, args, {
    cwd,
    env: env || sealedEnv(process.env),
    windowsHide: true,
    // `input` is the prompt on stdin: a prompt as an argument is capped by the OS command line (and by
    // cmd.exe's far lower limit behind a .cmd shim), which a long meeting transcript outgrows.
    stdio: [typeof input === "string" ? "pipe" : "ignore", "pipe", "pipe"],
    shell: useShell,
  });
  if (typeof input === "string") {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  let result = null;
  let timedOut = false;
  const proxy = LOCAL_PROXIES.get(env);
  const tee = stdoutFile ? fs.createWriteStream(stdoutFile, { flags: "a" }) : null;
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    if (stderrChunks.length < 200) stderrChunks.push(String(chunk));
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (tee) tee.write(line + "\n");
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { type: "raw", text: line };
    }
    if (event && event.type === "result") result = event;
    if (typeof onEvent === "function") {
      try {
        onEvent(event);
      } catch (err) {
        process.stderr.write(`[claude-cli] onEvent threw: ${err && err.message}\n`);
      }
    }
  });
  const done = new Promise((resolve) => {
    let code = null;
    let linesClosed = false;
    let exited = false;
    let deadline = null;
    let grace = null;
    const finish = () => {
      if (!linesClosed || !exited) return;
      if (deadline) clearInterval(deadline);
      if (grace) clearTimeout(grace);
      proxy?.stop();
      for (const error of proxy?.errors ?? []) stderrChunks.push(`[local model] ${error}\n`);
      const outcome = { code: timedOut ? -1 : code, result, stderr: stderrChunks.join(""), timedOut };
      // The tee is flushed BEFORE resolving: the caller reads brain.jsonl the moment this settles.
      if (tee) tee.end(() => resolve(outcome));
      else resolve(outcome);
    };
    lines.on("close", () => {
      linesClosed = true;
      finish();
    });
    child.on("error", (err) => {
      stderrChunks.push(`[spawn error] ${err && err.message}\n`);
      code = -1;
      exited = true;
      linesClosed = true;
      finish();
    });
    child.on("close", (c) => {
      code = c;
      exited = true;
      finish();
    });
    if (timeoutMs > 0) {
      const started = Date.now();
      // Time a request spent queued for the local model is the proxy's, not the brain's, so it is left out.
      deadline = setInterval(
        () => {
          if (Date.now() - started - (proxy?.queuedMs() ?? 0) < timeoutMs) return;
          clearInterval(deadline);
          timedOut = true;
          stderrChunks.push(`[timeout] the brain did not answer within ${timeoutMs}ms (queue wait excluded); killing it\n`);
          killBrainTree(child);
          // The kill's own `close` normally settles `done`; this grace guarantees it even if it does not.
          grace = setTimeout(() => {
            code = -1;
            exited = true;
            linesClosed = true;
            finish();
          }, 5_000);
          grace.unref?.();
        },
        Math.min(1000, Math.max(20, timeoutMs / 4)),
      );
      deadline.unref?.();
    }
  });
  return { child, done };
}

/**
 * Kills a brain and every process under it. Windows needs `taskkill /T` because the CLI spawns MCP
 * servers of its own; elsewhere SIGKILL to the one pid is enough. Best-effort: a child already gone
 * (or a platform that refuses the kill) is not an error - `spawnBrain`'s grace timer still settles.
 */
export function killBrainTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * The cheapest possible proof that the chosen brain can still talk: one turn, no tools, no MCP, no
 * persona. The cannon runs this BEFORE it spends a Sue number, because the alternative is what
 * happened on 2026-09-21 - 410 Sue numbers and 410 mail addresses burned against an expired OAuth
 * session, and a report that read like a product finding. Pure: no I/O, so a test pins the argv.
 */
export function buildPreflightArgs({ model = SUE_DEFAULT_MODEL } = {}) {
  assertNotHaiku(model);
  return [
    "-p",
    "Reply with the single word: ready",
    "--model",
    model,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--max-turns",
    "1",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ];
}
