// The people hunt: which personas read weakest in the rounds on disk, each with the evidence and one rewrite direction.
// The ranking is pure; gatherPeopleHunt only reads the same signals round.mjs hunt reads, grouped by persona.
import { gatherSueHunt } from "./sue-hunt.mjs";

export const PEOPLE_WEIGHTS = { unstable: 35, slow: 40, suspect: 45, offProtocol: 50, midMotion: 75 };

const DIRECTION = {
  midMotion: "have the errand wait for the page to settle before she looks, and name the thing that was still moving",
  offProtocol: "make the errand concrete enough that she takes the look step first instead of guessing",
  suspect: "cut the complaints or dials that push her into a habit the rounds flagged; keep the errand",
  slow: "give her one clear next move per screen and drop the side-quests that slow her down",
  unstable: "pin her voice and dials to fewer, firmer lines so her verdict stops flipping between visits",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function rankPeopleHunt(signals, { top = 25 } = {}) {
  const byPersona = new Map();
  for (const s of signals) {
    if (!Object.hasOwn(PEOPLE_WEIGHTS, s.kind) || !s.persona) continue;
    const p = byPersona.get(s.persona) || { runs: new Set(), hits: new Map() };
    p.runs.add(s.runId);
    const runs = p.hits.get(s.kind) || new Set();
    runs.add(s.runId);
    p.hits.set(s.kind, runs);
    byPersona.set(s.persona, p);
  }
  const rows = [...byPersona].map(([persona, p]) => {
    const parts = [...p.hits].map(([kind, runs]) => ({ kind, hits: runs.size, share: (PEOPLE_WEIGHTS[kind] * runs.size) / p.runs.size }));
    parts.sort((a, b) => b.share - a.share || a.kind.localeCompare(b.kind));
    const score = Math.round(parts.reduce((sum, x) => sum + x.share, 0) * 10) / 10;
    return {
      persona,
      score,
      evidence: parts.map((x) => `${x.kind} in ${plural(x.hits, "run")} of ${p.runs.size}`),
      direction: DIRECTION[parts[0].kind],
    };
  });
  rows.sort((a, b) => b.score - a.score || a.persona.localeCompare(b.persona));
  return rows.slice(0, top);
}

export function renderPeopleHunt(rows) {
  if (!rows.length) return "no persona has a weak signal in these rounds\n";
  return (
    rows.map((r, i) => `${i + 1}. ${r.persona}  score ${r.score}\n   ${r.evidence.join("; ")}\n   direction: ${r.direction}`).join("\n") +
    "\n"
  );
}

const personaOf = (id) => (typeof id === "string" && id ? id.replace(/^sue-/, "") : null);

export function signalsOf(signals) {
  const out = [];
  for (const s of signals.midMotion) out.push({ kind: "midMotion", persona: personaOf(s.sue), runId: s.runId });
  for (const s of signals.offProtocol) out.push({ kind: "offProtocol", persona: personaOf(s.sue), runId: s.runId });
  for (const s of signals.suspects) out.push({ kind: "suspect", persona: personaOf(s.sue), runId: s.runId });
  for (const s of signals.slow) out.push({ kind: "slow", persona: personaOf(s.who), runId: `round ${s.round}` });
  for (const s of signals.unstable) out.push({ kind: "unstable", persona: personaOf(s.persona), runId: `pairs ${s.pairs}` });
  return out;
}

export function gatherPeopleHunt(opts = {}) {
  const { signals } = gatherSueHunt({ ...opts, raw: true });
  return signalsOf(signals);
}
