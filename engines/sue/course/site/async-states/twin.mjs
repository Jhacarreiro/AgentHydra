// Deterministic twin for async-states: proof the page can be finished, so a
// SUE failure here is SUE's own. The click on Send code waits out the skeleton
// on its own; the code is read off the toast inside its 2.5 second window.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  const toast = page.getByText(/^Your code is \d{4}$/);
  const code = (await toast.textContent()).match(/\d{4}/)[0];
  await page.getByPlaceholder("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByText("Code verified successfully", { exact: true }).waitFor();
}
