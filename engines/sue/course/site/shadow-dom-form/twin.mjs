// Deterministic twin for shadow-dom-form: proof the page can be finished, so a
// SUE failure here is SUE's own. The input and Submit sit in a CLOSED shadow
// root that no locator pierces, but focus does: click the light-DOM hint above
// the form, Tab into the input, type, Tab to Submit and press Enter.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const hint = page.getByText(/closed shadow root\. Enter/);
  const code = (await hint.textContent()).match(/SHADOW-\d+/)[0];
  await hint.click();
  await page.keyboard.press("Tab");
  await page.keyboard.type(code);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.getByText("Access granted", { exact: true }).waitFor();
}
