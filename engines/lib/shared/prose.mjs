// vendored from Connections infra/shared/text/prose.mjs @ dd3d47a7ad
// The words a person typed, without what they pasted. A prompt carries pasted blocks beside the prose: Desktop's
// <pasted_content> wrapper (a handoff, a log) and fenced code. Those are material the person handed over, never their
// own claim. One source for every reader that must tell the two apart: SUE's answer key (tools/sue/you/answer-key.mjs)
// and Dredd's bug check (tools/dredd/lib/bug.mjs: a pasted handoff that quotes "Broken for users 8" and a save command
// filed a bug docket whose repro was the save command, 2026-10-02). Import-free, so a tool may vendor it.

/** The prose typed, with pasted blocks (Desktop's pasted_content, fenced code) taken out. */
export function proseOf(text) {
  return String(text ?? "")
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .trim();
}
