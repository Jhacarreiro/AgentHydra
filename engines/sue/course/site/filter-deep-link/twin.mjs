// Deterministic twin for filter-deep-link: types the filter, then checks the URL carries ?q=mug.

/** Filters the list for "mug" and waits for the URL and the share line to carry it. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("filter-input").fill("mug");
  await page.waitForURL(/\?q=mug$/);
  await page.getByText("Shareable link: ?q=mug", { exact: true }).waitFor({ state: "visible" });
}
