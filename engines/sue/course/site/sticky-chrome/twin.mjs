// Deterministic twin for sticky-chrome: proof the page can be finished, so a
// SUE failure here is SUE's own. Scrolled just into view, the button sits under
// the sticky footer, which takes the click. Scrolling the terms box all the
// way down leaves the footer in its own place below the button, clear of it.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("scroll-container").evaluate((box) => box.scrollTo(0, box.scrollHeight));
  await page.getByRole("button", { name: "Accept terms", exact: true }).click();
  await page.getByText("Terms accepted", { exact: true }).waitFor();
}
