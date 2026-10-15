// Deterministic twin for div-soup: proof the page can be finished, so a SUE
// failure here is SUE's own. The pad is bare divs with no roles or ids, so a
// tile's glyph, matched exactly, is its only handle.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const hint = await page.getByText(/^Enter the code \d+ and press the arrow$/).textContent();
  const code = hint.match(/\d+/)[0];
  for (const digit of code) {
    await page.getByText(digit, { exact: true }).click();
  }
  await page.getByText("→", { exact: true }).click();
  await page.getByText("Access granted", { exact: true }).waitFor();
}
