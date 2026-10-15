// The deterministic twin for cart-totals: proof the page works, so a Sue failing here is SUE's.

const amount = async (locator) => Number((await locator.textContent()).replace(/[^0-9.]/g, ""));

/** Raises the tee to two, the visitor's task. The page has no success words: the summary is the end. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("increase-tee").click();
  await page.getByTestId("quantity-tee").filter({ hasText: "2" }).waitFor();
  await page.getByTestId("line-total-tee").filter({ hasText: "$40.00" }).waitFor();
}

/** True when the subtotal is not the sum of the line totals on screen (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  const lines = (await amount(page.getByTestId("line-total-tee"))) + (await amount(page.getByTestId("line-total-cap")));
  return (await amount(page.getByTestId("summary-subtotal"))) !== lines;
}
