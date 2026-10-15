// Deterministic twin for aria-hidden-flow: proof the page can be finished, so
// a SUE failure here is SUE's own. The flow is all bare divs under one
// aria-hidden container, so getByRole and getByLabel find nothing; the visible
// text, matched exactly, is the only handle.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const hint = await page.getByText(/^Choose the \w+ plan$/).textContent();
  const plan = hint.match(/^Choose the (\w+) plan$/)[1];
  await page.getByText(plan, { exact: true }).click();
  await page.getByText(`Confirm ${plan} plan`, { exact: true }).click();
  await page.getByText("Plan activated", { exact: true }).waitFor();
}
