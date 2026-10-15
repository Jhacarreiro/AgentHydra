// The deterministic twin for order-history: proof the page works, so a Sue failing here is SUE's.

/** Opens the Orders tab, the visitor's task. Its list never arrives (that is the bug). */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "Orders" }).click();
  await page.getByTestId("orders-panel").waitFor();
}

/** True when the Orders tab still says it is loading after a wait while Settings works (the planted bug). */
export async function showsBug(page, url) {
  await solve(page, url);
  await page.waitForTimeout(1500);
  const stuck = await page.getByText("Loading your orders...").isVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const settingsWork = await page.getByText("Email: alex@example.com").isVisible();
  return stuck && settingsWork;
}
