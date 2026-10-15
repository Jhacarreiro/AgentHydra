// The deterministic twin for checkout-review: proof the page works, so a Sue failing here is SUE's.

/** Places the order and waits for the confirmation. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByText("Order placed successfully").waitFor();
}

/** True when the raw template token or "Arrives by undefined" is on screen (the planted bug). */
export async function showsBug(page, url) {
  await page.goto(url);
  const token = await page.getByText("{{firstName}}").isVisible();
  const undefinedDate = await page.getByText("Arrives by undefined").isVisible();
  return token || undefinedDate;
}
