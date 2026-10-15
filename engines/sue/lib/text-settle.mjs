// A count-up or ticker runs on requestAnimationFrame, not on a CSS animation, so the stillness wait
// (document.getAnimations) never sees it. A look taken while the page's text is still moving shows a
// figure a person would not see, so the look waits for the text to stop changing.

export const TEXT_QUIET_MS = 500;
export const TEXT_SETTLE_CAP_MS = 3000;

/** Runs in the page before its scripts: records when the page's text last changed. */
export function trackTextChanges() {
  if (window.__sueTextChangedAt !== undefined) return;
  window.__sueTextChangedAt = performance.now();
  new MutationObserver(() => {
    window.__sueTextChangedAt = performance.now();
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/**
 * Runs in the page: resolves with how long it waited, 0 when the text was already quiet for `quietMs`, else up to
 * `capMs`. It first lets one animation frame run: a ticker that starts on requestAnimationFrame has not changed the
 * text until its first frame, so a page whose first frame was late under load looked quiet before the count-up began.
 */
export async function settleInPage({ quietMs, capMs }) {
  const started = performance.now();
  const deadline = started + capMs;
  await new Promise((resolve) => {
    const bound = setTimeout(resolve, capMs);
    requestAnimationFrame(() => {
      clearTimeout(bound);
      resolve();
    });
  });
  const quietFor = () => performance.now() - (window.__sueTextChangedAt ?? 0);
  while (quietFor() < quietMs && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return Math.round(performance.now() - started);
}

/** Resolves with how long the page's text was waited on before it settled (see settleInPage). */
export function waitForTextToSettle(page, { quietMs = TEXT_QUIET_MS, capMs = TEXT_SETTLE_CAP_MS } = {}) {
  return page.evaluate(settleInPage, { quietMs, capMs });
}
