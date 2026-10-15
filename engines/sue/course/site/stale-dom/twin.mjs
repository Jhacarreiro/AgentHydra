// Deterministic twin for stale-dom: never holds an element across a rebuild. Each click goes
// through a fresh role locator just after a rebuild, then waits for the next one (the target's
// box moves) before clicking again. A click that lands on a decoy resets progress, so it keeps
// going until the page says done, with a cap.

const MAX_CLICKS = 15;

export async function solve(page, url) {
  await page.goto(url);
  const success = page.getByText("Target clicked 3 times", { exact: true });
  const target = page.getByRole("button", { name: "Tap me", exact: true });

  for (let clicks = 0; clicks < MAX_CLICKS; clicks += 1) {
    if (await success.isVisible()) return;
    await waitForRebuild(page, target);
    await target.click({ timeout: 5000 }).catch(() => {});
  }
  await success.waitFor({ state: "visible", timeout: 3000 });
}

/** Waits until the target's box moves, i.e. the list has just been rebuilt; done counts as moved. */
async function waitForRebuild(page, target) {
  const before = (await target.boundingBox().catch(() => null))?.y;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await target.count()) === 0) return;
    const now = (await target.boundingBox().catch(() => null))?.y;
    if (now !== undefined && now !== before) return;
    await page.waitForTimeout(50);
  }
}
