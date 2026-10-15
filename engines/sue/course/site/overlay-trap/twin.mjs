// Deterministic twin for overlay-trap: proof the page can be finished, so a
// SUE failure here is SUE's own. The transparent overlay arrives half a second
// after load and its small chip is the only way to close it; Continue does
// nothing until both the banner and the overlay are gone.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "Accept cookies", exact: true }).click();
  await page.getByRole("button", { name: /close overlay/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("You made it past the overlay", { exact: true }).waitFor();
}
