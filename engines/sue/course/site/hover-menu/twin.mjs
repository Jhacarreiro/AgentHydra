// Deterministic twin for hover-menu: hovers Account, then Billing, keeping the pointer inside
// the menu chain, then clicks the leaf that only exists while the flyout is open.

export async function solve(page, url) {
  await page.goto(url);
  await page.getByText("Account", { exact: true }).hover();
  await page.getByText("Billing ›", { exact: true }).hover();
  await page.getByText("Redeem voucher", { exact: true }).click();
  await page.getByText("Voucher redeemed", { exact: true }).waitFor({ state: "visible" });
}
