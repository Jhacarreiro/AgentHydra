/**
 * A stand-in for body.mjs with the same MCP surface and none of the browser, for
 * tests/body-relay.spec.mjs. Every call is appended to `<sueDir>/calls.jsonl` so a spec can see
 * exactly what arrived, in what order and with which types.
 */
import fs from "node:fs";
import path from "node:path";

import { createStdioMcpServer } from "../../lib/mcp-stdio.mjs";

const sueDir = process.argv[process.argv.indexOf("--sue") + 1];
const record = (name, args) => fs.appendFileSync(path.join(sueDir, "calls.jsonl"), `${JSON.stringify({ name, args })}\n`);
const PIXEL = Buffer.from("fake-jpeg").toString("base64");

const tools = [
  {
    name: "look",
    description: "Look at the page.",
    inputSchema: { type: "object", properties: {} },
    handler: async (args) => {
      record("look", args);
      return {
        content: [
          { type: "text", text: "A page." },
          { type: "image", data: PIXEL, mimeType: "image/jpeg" },
        ],
      };
    },
  },
  {
    name: "click",
    description: "Click element [n].",
    inputSchema: { type: "object", properties: { target: { type: ["number", "string"] }, how: { type: "string" } }, required: ["target"] },
    handler: async (args) => {
      record("click", args);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: [{ type: "text", text: `clicked ${JSON.stringify(args)}` }] };
    },
  },
  {
    name: "type",
    description: "Type into element [n].",
    inputSchema: { type: "object", properties: { target: { type: ["number", "string"] }, text: { type: "string" } }, required: ["target"] },
    handler: async (args) => {
      record("type", args);
      return { content: [{ type: "text", text: "typed" }] };
    },
  },
  {
    name: "exit_interview",
    description: "Answer the exit interview.",
    inputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
    handler: async (args) => {
      record("exit_interview", args);
      if (!args.verdict) return { content: [{ type: "text", text: "Please also answer: verdict." }], isError: true };
      fs.writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify(args));
      return { content: [{ type: "text", text: "Thank you. You have left. Stop." }] };
    },
  },
  ...(process.env.FAKE_BODY_NOTE
    ? [
        {
          name: "note",
          description: "Write a diary line.",
          inputSchema: { type: "object", properties: { kind: { type: "string" }, text: { type: "string" } } },
          handler: async (args) => {
            record("note", args);
            return { content: [{ type: "text", text: "noted" }] };
          },
        },
      ]
    : []),
];

createStdioMcpServer({ name: "fake-sue", version: "1.0.0", tools, onClose: async () => process.exit(0) }).start();
