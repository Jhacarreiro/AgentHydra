// The deterministic twin for product-reviews: proof the page works, so a Sue failing here is SUE's.

/** Reads the product and every review, the visitor's task. No success words: having read them is the end. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("heading", { name: "Peak Trail Running Shoes" }).waitFor();
  await page.getByTestId("review-list").getByRole("listitem").nth(2).waitFor();
}

/** True when the reviews on the shoe page are about a coffee grinder (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  const reviews = (await page.getByTestId("review-list").getByRole("listitem").allTextContents()).join(" ");
  return /espresso|grind|burrs|hopper/i.test(reviews) && !/shoe|run|trail/i.test(reviews);
}
