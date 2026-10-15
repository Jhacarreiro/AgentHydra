/**
 * material - what a person gives a focus group to look at, when it is not a web page yet.
 * ========================================================================================
 *
 * Owner ruling (Owner, 2026-09-24): a focus group looks at whatever the person has, not only a live
 * address: a PDF, a picture, some notes, or an idea typed in a box. Each one is stored here, in the
 * workspace's own `.sue/material/`, under a random id, and the Sue Manager on this computer serves
 * it at `/material/<id>` (lib/material-address.mjs). A Sue's own Chrome opens that address like any
 * other page: a PDF in Chrome's own viewer, a picture as a picture, text and ideas as a plain page.
 *
 * What is taken: PDF; PNG, JPG, WebP and GIF pictures; plain text and Markdown; a typed idea. Up to
 * MATERIAL_MAX_BYTES. The bytes must BE what the name and type say (checked by their first bytes),
 * so a renamed file is refused rather than shown as something it is not. Office files are refused
 * with the one thing to do about it: a Sue's Chrome cannot open them, and a PDF of one it can.
 *
 * Stored as `<id>.<ext>` only: nothing about where the file came from is kept, and an id is read
 * only when it matches MATERIAL_ID, so no request can name a path of its own.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MATERIAL_ID, materialUrl, materialViewUrl } from "./material-address.mjs";
import { pdfPageCount } from "./pdf-pages.mjs";
import { storeDir } from "./workspace.mjs";

/** A refusal in words the person can act on (the Manager answers these as 400s, `sue run` as its own refusal). */
export class MaterialRefusal extends Error {}

export const MATERIAL_MAX_BYTES = 25 * 1024 * 1024;
const IDEA_MAX_CHARS = 20_000;
const TITLE_MAX_CHARS = 200;
const NAME_MAX_CHARS = 200;
/** Why a group was sent to look at something, when the person did not say. */
export const MATERIAL_INTENT = "Someone you know sent you this to look at, and asked what you honestly think of it.";
export const MATERIAL_PAGES = "It may run to several pages: scroll down and look at every page before you vote.";

const SAVE_AS_PDF = "Save it as a PDF first, then give it to the group.";
const MB = 1024 * 1024;

const latin1 = (bytes, from, to) => bytes.subarray(from, to).toString("latin1");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every format a Sue can look at: its kind (the contract's), how it is stored and served, and its first bytes. */
const FORMATS = {
  pdf: { kind: "pdf", label: "a PDF", ext: "pdf", type: "application/pdf", is: (b) => latin1(b, 0, 5) === "%PDF-" },
  png: { kind: "image", label: "a PNG picture", ext: "png", type: "image/png", is: (b) => b.subarray(0, 8).equals(PNG_SIGNATURE) },
  jpeg: {
    kind: "image",
    label: "a JPG picture",
    ext: "jpg",
    type: "image/jpeg",
    is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  webp: {
    kind: "image",
    label: "a WebP picture",
    ext: "webp",
    type: "image/webp",
    is: (b) => latin1(b, 0, 4) === "RIFF" && latin1(b, 8, 12) === "WEBP",
  },
  gif: { kind: "image", label: "a GIF picture", ext: "gif", type: "image/gif", is: (b) => /^GIF8[79]a$/.test(latin1(b, 0, 6)) },
  // Text and ideas are stored as the readable page they are served as.
  text: { kind: "text", label: "plain text", ext: "html", type: "text/html; charset=utf-8", is: (b) => isPlainText(b) },
};
const BINARY = ["pdf", "png", "jpeg", "webp", "gif"];
const BY_EXTENSION = {
  pdf: "pdf",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  gif: "gif",
  txt: "text",
  text: "text",
  md: "text",
  markdown: "text",
};
const BY_TYPE = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
  "text/plain": "text",
  "text/markdown": "text",
  "text/x-markdown": "text",
};
const OFFICE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "docm",
  "ppt",
  "pptx",
  "pptm",
  "xls",
  "xlsx",
  "xlsm",
  "odt",
  "odp",
  "ods",
  "rtf",
  "pages",
  "key",
  "numbers",
]);
const OFFICE_TYPE = /msword|ms-excel|ms-powerpoint|officedocument|opendocument|rtf|iwork/i;
/** A zip (every modern Office file) or an OLE compound file (every old one). */
const officeBytes = (b) =>
  latin1(b, 0, 4) === "PK\u0003\u0004" || b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

function isPlainText(bytes) {
  if (bytes.includes(0) || officeBytes(bytes) || BINARY.some((f) => FORMATS[f].is(bytes))) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function materialDir(ws) {
  return path.join(storeDir(ws), "material");
}

function sizeWords(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

function tooBig(name, bytes) {
  return new MaterialRefusal(`"${name}" is ${sizeWords(bytes)}; a focus group takes files up to ${MATERIAL_MAX_BYTES / MB} MB.`);
}

/** The format these bytes are, judged by their name and type and then proven by their first bytes. */
function formatOf({ name, type, bytes }) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = type.split(";")[0].trim().toLowerCase();
  if (OFFICE_EXTENSIONS.has(ext) || OFFICE_TYPE.test(mime))
    throw new MaterialRefusal(`"${name}" is an Office file, and a Sue's browser cannot open one. ${SAVE_AS_PDF}`);
  const claimed = BY_EXTENSION[ext] ?? BY_TYPE[mime];
  if (!claimed) {
    throw new MaterialRefusal(
      `"${name}" is not something the group can look at. Give them a PDF, a picture (PNG, JPG, WebP or GIF) or plain text.`,
    );
  }
  if (FORMATS[claimed].is(bytes)) return FORMATS[claimed];
  if (officeBytes(bytes))
    throw new MaterialRefusal(`"${name}" is an Office file inside, and a Sue's browser cannot open one. ${SAVE_AS_PDF}`);
  throw new MaterialRefusal(
    `"${name}" says it is ${FORMATS[claimed].label}, but its contents are something else. Open it and save it again as a PDF or a picture.`,
  );
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Text as a plain page anyone can read: blank lines part paragraphs, a `#` line is a heading, a run
 * of `-` or `*` lines is a list. Everything is escaped: the words are shown, never run.
 */
export function readablePage({ title, text }) {
  const blocks = String(text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const body = blocks.map((block) => {
    const lines = block.split("\n");
    const heading = /^(#{1,6})\s+(.+)$/.exec(block);
    if (heading && lines.length === 1) return `<h2>${escapeHtml(heading[2])}</h2>`;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
      return `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
  });
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{max-width:42rem;margin:0 auto;padding:2rem 1.25rem;font:18px/1.6 Georgia,serif;color:#1f1f1f;background:#fff}h1{font-size:1.6rem;line-height:1.25}h2{font-size:1.25rem}</style>",
    `</head><body><h1>${escapeHtml(title)}</h1>${body.join("\n")}</body></html>`,
  ].join("\n");
}

/**
 * A PDF's pages as one readable page: each page its own picture (`pages` from lib/pdf-pages.mjs, the
 * image already encoded as JPEG) under a `Page N of M` heading, with the page's own text beneath it.
 * The pictures are inline, so the page needs no other request and no script.
 */
export function pdfViewerPage({ title, pages }) {
  const total = pages.length;
  const sections = pages.map((p) => {
    const label = `Page ${p.n} of ${total}`;
    const picture = `<img alt="${label}" width="${p.width}" height="${p.height}" src="data:image/jpeg;base64,${p.jpeg.toString("base64")}">`;
    const words = p.text ? `<p class="text">${escapeHtml(p.text)}</p>` : "";
    return `<section class="page"><h2>${label}</h2>${picture}${words}</section>`;
  });
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{margin:0;background:#e9e9e9;color:#1f1f1f;font:16px/1.5 Georgia,serif}main{max-width:1000px;margin:0 auto;padding:1rem}h1{font:1.2rem/1.3 system-ui,sans-serif;margin:0 0 1rem}.page{background:#fff;margin:0 0 1.5rem;padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.2)}.page h2{font:1rem/1.3 system-ui,sans-serif;margin:0 0 .75rem}.page img{display:block;width:100%;height:auto}.text{white-space:pre-wrap;margin:.75rem 0 0}</style>",
    `</head><body><main><h1>${escapeHtml(title)}</h1>${sections.join("\n")}</main></body></html>`,
  ].join("\n");
}

function titleOf(idea) {
  const first = idea.split(/\n/)[0].trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
}

function decodeBase64(name, raw) {
  const text = String(raw)
    .replace(/^data:[^,]*,/, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new MaterialRefusal(`"${name}" did not arrive whole; pick the file again.`);
  // Refused before decoding, so an oversize upload never becomes a second copy in memory.
  const size = Math.floor((text.length * 3) / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
  if (size > MATERIAL_MAX_BYTES) throw tooBig(name, size);
  return Buffer.from(text, "base64");
}

/**
 * A file on this computer, read for `storeMaterial` (sue.mjs's `file`). A folder, a missing file or
 * one over the cap is refused before a byte is read.
 */
export function materialFromDisk(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new MaterialRefusal(`there is no file at ${file}`);
  }
  const name = path.basename(file);
  if (!stat.isFile()) throw new MaterialRefusal(`${file} is a folder; give the group one file`);
  if (stat.size > MATERIAL_MAX_BYTES) throw tooBig(name, stat.size);
  return { name, type: "", bytes: fs.readFileSync(file) };
}

/**
 * Stores what a person gave the group in `ws`'s `.sue/material/` and answers the contract's
 * `{ id, url, raw, kind, name }`: `url` is the address a Sue opens (a PDF's page viewer, else the file),
 * `raw` the file itself, both on the Sue Manager at `port`. `input` is a
 * file (`{ name, type, base64 }` as the page sends it, or `{ name, type, bytes }`) or an idea
 * (`{ idea, title? }`). Anything a Sue cannot look at is a MaterialRefusal.
 */
export function storeMaterial(ws, input, { port }) {
  let format;
  let name;
  let data;
  if (input && typeof input.idea === "string") {
    const idea = input.idea.trim();
    if (!idea) throw new MaterialRefusal("idea: write down what you want the group to look at");
    if (idea.length > IDEA_MAX_CHARS)
      throw new MaterialRefusal(`idea: keep it under ${IDEA_MAX_CHARS} characters, or give it to the group as a PDF`);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, TITLE_MAX_CHARS) : titleOf(idea);
    format = FORMATS.text;
    name = title;
    data = readablePage({ title, text: idea });
  } else if (input && typeof input.name === "string" && (typeof input.base64 === "string" || Buffer.isBuffer(input.bytes))) {
    name = path.basename(input.name.replace(/\\/g, "/")).trim().slice(0, NAME_MAX_CHARS);
    if (!name) throw new MaterialRefusal("name: the file's own name, like plan.pdf");
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : decodeBase64(name, input.base64);
    if (bytes.length > MATERIAL_MAX_BYTES) throw tooBig(name, bytes.length);
    if (!bytes.length) throw new MaterialRefusal(`"${name}" is empty.`);
    format = formatOf({ name, type: typeof input.type === "string" ? input.type : "", bytes });
    data = format.kind === "text" ? readablePage({ title: name, text: bytes.toString("utf8") }) : bytes;
  } else {
    throw new MaterialRefusal("give the group a file ({ name, type, base64 }) or an idea ({ idea, title })");
  }
  const id = crypto.randomBytes(16).toString("hex");
  const dir = materialDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.${format.ext}`), data, { flag: "wx" });
  const raw = materialUrl(id, port);
  return { id, url: format.kind === "pdf" ? materialViewUrl(id, port) : raw, raw, kind: format.kind, name };
}

/**
 * The stored item `id` names, looked for in each workspace folder's `.sue/material/`: `{ file, type }`
 * to serve, or null. Only an id matching MATERIAL_ID is ever looked up, and only as `<id>.<ext>` for
 * the formats above, so the answer is always a file inside a material folder.
 */
export function findMaterial(id, folders) {
  if (!MATERIAL_ID.test(String(id ?? ""))) return null;
  for (const folder of folders) {
    for (const format of Object.values(FORMATS)) {
      const file = path.join(materialDir(folder), `${id}.${format.ext}`);
      if (fs.existsSync(file)) return { file, type: format.type, kind: format.kind };
    }
  }
  return null;
}

/**
 * Whether a group may need to scroll through several pages of the stored item `id` (MATERIAL_PAGES):
 * a picture never does, a PDF does unless it is known to be one page, and anything else (a text page,
 * an item not found) keeps the line, since its length is not known here.
 */
export async function materialMayRunToSeveralPages(ws, id) {
  const found = findMaterial(id, [ws]);
  if (!found) return true;
  if (found.kind === "image") return false;
  if (found.kind !== "pdf") return true;
  return (await pdfPageCount(fs.readFileSync(found.file))) !== 1;
}
