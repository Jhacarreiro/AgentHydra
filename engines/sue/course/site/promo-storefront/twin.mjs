// Deterministic twin for promo-storefront: clears the cookie banner, opens and closes the chat,
// waits out the review skeletons, then buys the headphones.

/** Dismisses the overlays and buys the Wireless Headphones until "Order confirmed" shows. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByTestId("cookie-banner").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open support chat" }).click();
  await page.getByTestId("chat-panel").getByText("Hi! How can we help?").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("chat-panel").waitFor({ state: "hidden" });
  await page.getByTestId("reviews-section").getByText("Great bass", { exact: false }).waitFor({ state: "visible" });
  await page.getByTestId("deal-headphones").getByRole("button", { name: "Buy now" }).click();
  await page.getByText("Order confirmed", { exact: true }).waitFor({ state: "visible" });
}
