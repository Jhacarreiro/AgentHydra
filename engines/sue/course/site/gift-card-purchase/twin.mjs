// Deterministic twin for gift-card-purchase: the accessible names are the trap, so controls go by
// test id and placeholder.

/** Picks $25, enters the recipient, buys, and waits for the confirmation. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("amount-25").click();
  await page.getByPlaceholder("friend@example.com").fill("friend@example.com");
  await page.getByTestId("buy-button").click();
  await page.getByText("Gift card sent to friend@example.com", { exact: true }).waitFor({ state: "visible" });
}
