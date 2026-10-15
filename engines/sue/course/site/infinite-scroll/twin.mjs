// Deterministic twin for infinite-scroll: wheels inside the feed (the page itself does not
// scroll) until the Claim button has loaded, then claims it.

const MAX_WHEELS = 120;

export async function solve(page, url) {
  await page.goto(url);
  const feed = page.locator("#feed");
  const claim = page.getByRole("button", { name: "Claim", exact: true });
  await feed.hover();
  for (let wheel = 0; wheel < MAX_WHEELS && (await claim.count()) === 0; wheel += 1) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(150);
  }
  await claim.click();
  await page.getByText("Golden Ticket claimed", { exact: true }).waitFor({ state: "visible" });
}
