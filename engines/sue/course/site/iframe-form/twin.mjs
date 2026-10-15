// Deterministic twin for iframe-form: proof the page can be finished, so a SUE
// failure here is SUE's own. The code lives in one frame and the form in
// another; a frame locator reaches into each.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const coupon = page.frameLocator('iframe[title="coupon-frame"]').getByText(/Your coupon code:/);
  const code = (await coupon.textContent()).match(/[A-Z]+-\d+/)[0];
  const checkout = page.frameLocator('iframe[title="checkout-frame"]');
  await checkout.getByPlaceholder("Coupon code").fill(code);
  await checkout.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("Coupon applied", { exact: true }).waitFor();
}
