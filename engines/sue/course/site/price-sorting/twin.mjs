// The deterministic twin for price-sorting: proof the page works, so a Sue failing here is SUE's.

/** Prices actually paid, top to bottom: the bold price on each row. */
async function paidPrices(page) {
  const texts = await page.getByTestId("product-list").getByRole("listitem").locator("strong").allTextContents();
  return texts.map((t) => Number(t.replace(/[^0-9.]/g, "")));
}

/** Sorts low to high, the visitor's task. The page has no success words: the sorted list is the end. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByLabel("Sort by").selectOption({ value: "price-asc" });
  await page.getByTestId("product-list").getByRole("listitem").first().waitFor();
}

/** True when "Low to High" leaves a row cheaper than one above it (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  const prices = await paidPrices(page);
  return prices.some((price, i) => i > 0 && price < prices[i - 1]);
}
