// Deterministic twin for virtualized-table: scrolls the table viewport to the Golden Row so it
// mounts, then claims it.

/** Scrolls the windowed table to row 4322 and clicks its Claim button. */
export async function solve(page, url) {
  await page.goto(url);
  const viewport = page.getByTestId("table-viewport");
  await viewport.evaluate((el) => {
    el.scrollTop = 4321 * 36 - 120;
  });
  const row = page.getByTestId("table-row").filter({ hasText: "Golden Row" });
  await row.waitFor({ state: "visible" });
  await row.getByTestId("claim-button").click();
  await page.getByText("Golden Row claimed", { exact: true }).waitFor({ state: "visible" });
}
