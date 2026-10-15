import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CODE_ROOTS = ["sue", "dredd", "mcp", "lib", "scripts"];

export function filesUnder(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "tmp" || entry.name === ".sue" || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/** Real syntax only: comments, quoted fixture programs and template bodies are not imports. */
export function importsIn(file) {
  const text = readFileSync(file, "utf8");
  const ast = parse(text, { sourceType: "unambiguous", plugins: /\.(?:ts|mts|cts)$/.test(file) ? ["typescript"] : [] });
  const found = [];
  const add = (literal, kind) => {
    if (!literal || literal.type !== "StringLiteral") return;
    found.push({ specifier: literal.value, line: literal.loc.start.line, start: literal.start + 1, end: literal.end - 1, kind });
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) add(node.source, "module");
    if (node.type === "ImportExpression") add(node.source, "call");
    if (node.type === "CallExpression" && (node.callee?.type === "Import" || (node.callee?.type === "Identifier" && node.callee.name === "require"))) add(node.arguments[0], "call");
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "comments", "tokens", "extra"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => { if (child?.type) visit(child); });
      else if (value?.type) visit(value);
    }
  };
  visit(ast);
  return found;
}

export function resolveRelative(file, specifier) {
  const bare = specifier.split(/[?#]/, 1)[0];
  const base = path.resolve(path.dirname(file), bare);
  for (const candidate of [base, ...[".mjs", ".js", ".ts", ".mts", ".json", "/index.mjs", "/index.js", "/index.ts"].map((ext) => base + ext)]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}
