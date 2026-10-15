/**
 * context-fit - a Sue whose first prompt cannot fit the local brain's loaded context is never seated.
 * ==================================================================================================
 *
 * A local model (LM Studio) answers a prompt longer than its loaded context with a 500, so a critic
 * whose mind is 170 KB (about 46k tokens) failed on a 32k window and every Sue she sat in died at
 * her first turn. This module reads the loaded context from the server and seats a persona only when
 * her system prompt plus mind, estimated in tokens, fits it; a persona who does not fit is replaced by
 * the next fitting one from the ask's cast, and the skip is recorded on the run with its estimate.
 */

/** Bytes of a visitor's system prompt before her mind (her brief, the page's scenario, the tools). */
export const FIT_OVERHEAD_BYTES = 12_000;
/** Room kept free for the model's own replies and tool calls. */
export const FIT_REPLY_TOKENS = 2_048;
/** A conservative figure for English text plus JSON; a real tokenizer counts a little fewer. */
export const BYTES_PER_TOKEN = 3.5;

export function tokenEstimate(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function promptTokenEstimate(mindBytes) {
  return tokenEstimate(FIT_OVERHEAD_BYTES + mindBytes) + FIT_REPLY_TOKENS;
}

/** The context length LM Studio has loaded for `model`; throws when that model is not loaded or the server does not answer. */
export async function loadedContextTokens({ baseUrl, model, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`the local model server at ${baseUrl} answered ${res.status} to GET /api/v0/models`);
  const listed = (await res.json())?.data ?? [];
  const entry = listed.find((m) => m?.id === model && m?.state === "loaded");
  const tokens = Number(entry?.loaded_context_length);
  if (!entry || !Number.isFinite(tokens) || tokens <= 0)
    throw new Error(`${model} is not loaded at ${baseUrl}: load it (llmserver.serving) before a local-brain run`);
  return tokens;
}

/**
 * Seat `ids` in a window of `contextTokens`. A persona whose estimate overflows is replaced, in place, by the first
 * cast candidate that is not already seated (a cast visitor carries no mind, so she fits). Returns the seated ids,
 * the cast candidates the replacement came from, and one skip record per replaced persona.
 */
export function seatWithinContext({ ids, castCandidates = [], mindBytesOf, contextTokens }) {
  const skips = [];
  const seated = [];
  const spare = castCandidates.filter((c) => !ids.includes(c.id));
  for (const id of ids) {
    const estimate = promptTokenEstimate(mindBytesOf(id));
    if (estimate <= contextTokens) {
      seated.push(id);
      continue;
    }
    const next = spare.shift();
    if (!next)
      throw new Error(
        `${id}'s prompt is about ${estimate} tokens and the local model has ${contextTokens} loaded, and the ask's cast has no other persona to seat in her place`,
      );
    skips.push({ id, promptTokens: estimate, contextTokens, replacedBy: next.id });
    seated.push(next.id);
  }
  return { ids: seated, skips };
}
