// dredd/lib/peers.mjs - who else is on this?
//
// The TEAM BOARD (every AI on the project, on every machine - board_who / board_read / board_post /
// board_claim; schemas 0056-0057) and this folder's MAIL, which since P2 is the same board: a post
// addressed to one folder (board_read { box: "all" }; the two-party message board it replaced is
// gone). Dredd reads both before convening so the docket can say "a peer already claimed this" or
// "the owner's AIs cannot hear you until the Chair accepts them in Studio", and it can announce a convened
// docket with board_post (--announce; off by default - a post is a side effect every listening
// session sees).
//
// WHO TO ASK. Every live agent keeps a list of what it is working on (board_status), and board_who { q }
// ranks them against a question. Dredd asks it with the docket's own ask, so the docket can name the ONE
// agent already on this and how to reach it alone (board_ask), instead of a post to the whole board.
// The ranking lives in the MCP (local-mcp 25b rankBoardAgents), never here: this only reads the one line
// it prints for the best match (boardAskLine), and only a match on that agent's list or its claims
// counts, since a shared folder or PC name alone does not mean it is on the same thing.
//
// Everything here is best effort through an open local-MCP handle: a board that is empty, off, or
// unreachable yields a one-line summary, never a failed docket.

const NOBODY = /\bnobody\b/i;
const EMPTY = /\bis empty\b/i;

/**
 * The people board_who lists as "(not accepted)", or null. The note reads "Other people on this board: A (not accepted),
 * B, c@x.com (not accepted)." - every person, with the suffix only on the unaccepted ones - so the old whole-list
 * capture named accepted people too, and stopped at the first dot of an email name (2026-09-22).
 */
export function notAcceptedPeople(whoText) {
  const list = /Other people on this board:\s*(.*?)\.(?:\s|$)/i.exec(String(whoText || ""));
  if (!list) return null;
  const names = list[1]
    .split(/,\s*/)
    .filter((p) => /\s\(not accepted\)$/i.test(p))
    .map((p) => p.replace(/\s\(not accepted\)$/i, "").trim());
  return names.length ? names.join(", ") : null;
}

/**
 * The agent board_who { q } says to ask, from its "→ Ask <label> on PC <pc> (matched on <where>):
 * board_ask { agent: "<id>"[, board: "<board id>"], text }" line (the board when the agent is on another
 * project's board), or null. Null too when the match was only on the folder or
 * the PC: that agent shares a place with the ask, not the work.
 */
export function askablePeer(matchText) {
  const m = /→ Ask (.+?) on PC (.+?) \(matched on ([^)]*)\): board_ask \{ agent: "([^"]+)"(?:, board: "([^"]+)")?/.exec(
    String(matchText || ""),
  );
  if (!m) return null;
  const on = m[3].split(/,\s*/).filter(Boolean);
  if (!on.some((w) => w === "list" || w === "claim")) return null;
  return { label: m[1], device: m[2], agent: m[4], ...(m[5] ? { board: m[5] } : {}), matchedOn: on };
}

export async function readPeers(mcp, { ask = "", limit = 8, timeoutMs = 15_000 } = {}) {
  const q = String(ask || "").slice(0, 300);
  const [who, board, inbox, match] = await Promise.all([
    mcp.call("board_who", {}, timeoutMs),
    mcp.call("board_read", { limit }, timeoutMs),
    mcp.call("board_read", { box: "all", limit }, timeoutMs),
    q.trim() ? mcp.call("board_who", { q }, timeoutMs) : Promise.resolve(null),
  ]);
  const whoText = who.ok ? who.text : "";
  const boardText = board.ok ? board.text : "";
  const inboxText = inbox.ok ? inbox.text : "";
  const live = who.ok && !NOBODY.test(whoText);
  const posts = board.ok && !EMPTY.test(boardText);
  const notAccepted = notAcceptedPeople(whoText);
  const unread = (inboxText.match(/●/g) || []).length;
  const parts = [];
  parts.push(
    live ? "team board has live agents (read docket.peers.who)" : who.ok ? "team board: nobody else live" : "team board unreachable",
  );
  parts.push(posts ? "open posts on the board (read docket.peers.board)" : board.ok ? "board empty" : "board unreadable");
  const askPeer = match?.ok ? askablePeer(match.text) : null;
  if (askPeer)
    parts.push(
      `${askPeer.label} on PC ${askPeer.device} is working on this - ask it alone: board_ask { agent: "${askPeer.agent}"${askPeer.board ? `, board: "${askPeer.board}"` : ""}, text }`,
    );
  if (notAccepted) parts.push(`${notAccepted.trim()} - their AIs are not heard until the owner accepts them in Studio (a human click)`);
  parts.push(inbox.ok ? (unread ? `${unread} unread mail thread(s)` : "mail: nothing unread") : "mail unreachable");
  return {
    summary: parts.join(" · "),
    live,
    posts,
    unread,
    notAccepted,
    askPeer,
    who: whoText.slice(0, 2000),
    match: match?.ok ? match.text.slice(0, 2000) : "",
    board: boardText.slice(0, 4000),
    inbox: inboxText.slice(0, 2000),
  };
}

/** Announce a convened docket on the team board as an FYI (nobody has to claim it). */
export async function announce(mcp, docket, docketDir, { timeoutMs = 15_000 } = {}) {
  const text = [
    `DREDD convened a ${docket.scopeLabel} on: "${docket.ask.slice(0, 200)}"`,
    `class ${docket.class} · domain ${docket.domain} · instruments: ${docket.convene.map((c) => c.id).join(", ") || "none"}`,
    `docket: ${docketDir}`,
  ].join("\n");
  return mcp.call("board_post", { text, kind: "fyi" }, timeoutMs);
}
