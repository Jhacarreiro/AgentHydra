#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);
const LEAD_CAP = 20000;
const NAME_CAP = 60;

export function coreDir(env = process.env) {
  return env.AGENTHYDRA_CORE_DIR || path.join(os.homedir(), ".agenthydra", "core");
}

export function isWorker(env = process.env) {
  return Boolean(env.AGENTHYDRA_CLIMAYTE_WORKER) && !env.AGENTHYDRA_CLIMAYTE_CHAT;
}

export function chatKey(input, env = process.env) {
  const raw = (env.HYDRA_DESK_CHAT_ID ?? "").trim() || String(input.session_id ?? "").trim();
  if (!raw) throw new Error("no chat key: HYDRA_DESK_CHAT_ID is unset and the hook input has no session_id");
  const key = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (key === "." || key === "..") throw new Error(`chat key "${raw}" is not a usable folder name`);
  return key;
}

export function parseHydraMd(text) {
  const tier = /Tier:\s*(\S+)/.exec(text)?.[1] ?? null;
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.startsWith("## Lead"));
  if (heading < 0) return { lead: null, leadPath: null, tier };
  const line = (lines.slice(heading + 1).find((item) => item.trim()) ?? "").trim();
  if (!line || line.startsWith("#")) return { lead: null, leadPath: null, tier };
  const at = line.indexOf("Full text:");
  const head = (at >= 0 ? line.slice(0, at) : line).trim();
  const name = head.split(" - ")[0].replace(/\.$/, "").trim();
  const leadPath = at >= 0 ? line.slice(at + "Full text:".length).trim() : "";
  return { lead: name && name.toLowerCase() !== "none" ? name : null, leadPath: leadPath || null, tier };
}

function promptBlock(key, hydraPath, hydraText) {
  let state = "none yet";
  if (hydraText !== null) {
    const { lead, tier } = parseHydraMd(hydraText);
    state = `lead ${(lead ?? "none").slice(0, NAME_CAP)}, tier ${tier ?? "?"}`;
  }
  return `Hydra Core: before you act on this message, call core_scope { chat: "${key}" } (agenthydra MCP) and answer its questions with core_answer until it says go. hydra.md: ${hydraPath} (${state}).`;
}

function sessionText(hydraPath, hydraText) {
  const { leadPath } = parseHydraMd(hydraText);
  let text = `Hydra Core: this chat's hydra.md (${hydraPath}):\n\n${hydraText.trimEnd()}`;
  if (leadPath && path.isAbsolute(leadPath) && existsSync(leadPath)) {
    const lead = readFileSync(leadPath, "utf8");
    const body =
      lead.length > LEAD_CAP
        ? `${lead.slice(0, LEAD_CAP)}\n[cut at ${LEAD_CAP} of ${lead.length} characters; the rest is in ${leadPath}]`
        : lead;
    text += `\n\nLead full text (${leadPath}):\n${body}`;
  }
  return text;
}

const output = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

function userPromptSubmit(input, env, dir) {
  const prompt = String(input.prompt ?? "");
  if (prompt.trimStart().startsWith("/")) return null;
  const key = chatKey(input, env);
  const chatDir = path.join(dir, "chats", key);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(path.join(chatDir, "prompt.txt"), prompt);
  writeFileSync(path.join(chatDir, "cwd.txt"), typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  const hydraPath = path.join(chatDir, "hydra.md");
  const hydraText = existsSync(hydraPath) ? readFileSync(hydraPath, "utf8") : null;
  return output("UserPromptSubmit", promptBlock(key, hydraPath, hydraText));
}

function sessionStart(input, env, dir) {
  if (input.source !== "compact" && input.source !== "resume") return null;
  const hydraPath = path.join(dir, "chats", chatKey(input, env), "hydra.md");
  if (!existsSync(hydraPath)) return null;
  return output("SessionStart", sessionText(hydraPath, readFileSync(hydraPath, "utf8")));
}

export function run(input, env = process.env) {
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) throw new Error(`unexpected hook_event_name "${event}"`);
  if (isWorker(env)) return null;
  const dir = coreDir(env);
  if (!existsSync(path.join(dir, "ON"))) return null;
  return event === "UserPromptSubmit" ? userPromptSubmit(input, env, dir) : sessionStart(input, env, dir);
}

export function handle(text, env = process.env) {
  let input = null;
  try {
    input = JSON.parse(text.trim() ? text : "{}");
    return run(input, env);
  } catch (error) {
    if (input && EVENTS.has(input.hook_event_name)) {
      return output(input.hook_event_name, `Hydra Core hook error: ${error.message}`);
    }
    throw error;
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = handle(text);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`Hydra Core hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
