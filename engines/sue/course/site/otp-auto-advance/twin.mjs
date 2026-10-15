// Deterministic twin for otp-auto-advance: focuses the first box once and types the code key by
// key, letting the page carry focus from box to box.

export async function solve(page, url) {
  await page.goto(url);
  await page.locator("#otp input").first().click();
  await page.keyboard.type("493027", { delay: 40 });
  await page.getByText("Code verified", { exact: true }).waitFor({ state: "visible" });
}
