// The deterministic twin for saved-addresses: proof the page works, so a Sue failing here is SUE's.

/** Adds the cabin and presses Delete on the office, the visitor's task. No success words: the list is the end. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByPlaceholder("Label (e.g. Cabin)").fill("Cabin");
  await page.getByPlaceholder("Street address").fill("9 Pine Hollow Road, Bend");
  await page.getByRole("button", { name: "Add address" }).click();
  await page.getByTestId("address-list").getByText("9 Pine Hollow Road, Bend").waitFor();
  await page.getByTestId("address-office").getByRole("button", { name: "Delete" }).click();
  await page.getByText("Address deleted").waitFor();
}

/** True when "Address deleted" is on screen and the office is still in the list (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  const toast = await page.getByTestId("toast").filter({ hasText: "Address deleted" }).isVisible();
  const stillListed = await page.getByTestId("address-list").getByText("400 Market Street, Portland").isVisible();
  return toast && stillListed;
}
