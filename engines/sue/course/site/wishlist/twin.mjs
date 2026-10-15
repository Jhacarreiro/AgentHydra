// The deterministic twin for wishlist: proof the page works, so a Sue failing here is SUE's.

/** Saves the pen and the notebook and opens the wishlist, the visitor's task. Its list is empty (that is the bug). */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("save-pen").click();
  await page.getByTestId("save-notebook").click();
  await page.getByRole("button", { name: "Wishlist (2)" }).click();
  await page.getByTestId("wishlist-panel").waitFor();
}

/** True when the tab counts two saved items and the list says it has none (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  const counted = await page.getByRole("button", { name: "Wishlist (2)" }).isVisible();
  const empty = await page.getByText("No saved items yet.").isVisible();
  const listed = await page.getByTestId("wishlist-panel").getByText("Brass Fountain Pen").count();
  return counted && empty && listed === 0;
}
