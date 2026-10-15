// Deterministic twin for lying-labels: proof the page can be finished, so a
// SUE failure here is SUE's own. Accessible names are shuffled and a hidden
// span adds a decoy phrase, so getByRole and getByLabel pick the wrong control.
// The twin goes by the rendered text: the button whose own text node reads
// "Pay now", and the input right after the span that visibly reads "Amount".

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  await page.locator('xpath=//button[text()[normalize-space(.)="Pay now"]]').click();

  const amountField = page.locator('xpath=//span[normalize-space(.)="Amount"]/following-sibling::input[1]');
  await amountField.fill("42.50");
  await page.locator('xpath=//button[text()[normalize-space(.)="Submit payment"]]').click();
  await page.getByText("Payment sent", { exact: true }).waitFor();
}
