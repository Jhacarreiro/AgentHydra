// Deterministic twin for new-tab-flow: catches the tab the button opens through the browser
// context, reads the code there, closes it, and enters the code back in the first tab.

export async function solve(page, url) {
  await page.goto(url);
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "Open verification tab", exact: true }).click(),
  ]);
  await tab.waitForLoadState();
  const code = (await tab.getByText(/^TAB-\d+$/).textContent())?.trim();
  if (!code) throw new Error("the verification tab shows no code");
  await tab.close();

  await page.bringToFront();
  await page.getByPlaceholder("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByText("Verified successfully", { exact: true }).waitFor({ state: "visible" });
}
