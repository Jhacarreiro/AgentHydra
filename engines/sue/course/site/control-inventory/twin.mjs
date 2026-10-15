// Deterministic twin for control-inventory: does each exercise with the matching Playwright verb.

/** Checks, long-presses, double-clicks, right-click renames, attaches, goes back, scrolls; waits for the success line. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByLabel("Agree to terms").check();
  await page.getByRole("radio", { name: "Medium" }).check();
  // Picking Express swaps the radios for a summary, so a click (check() would re-read a radio that is gone).
  await page.getByRole("radio", { name: "Express" }).click();
  await page.getByText("Express delivery selected").waitFor({ state: "visible" });
  const hold = page.getByRole("button", { name: "Hold me" });
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.getByLabel("Hold state").filter({ hasText: "long-pressed" }).waitFor();
  await page.getByRole("button", { name: "Double-click me" }).dblclick();
  await page.getByLabel("Double-click state").filter({ hasText: "double-clicked" }).waitFor();
  await page.getByText("report.pdf", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByText("summary.pdf", { exact: true }).waitFor({ state: "visible" });
  await page
    .getByLabel("Attachments", { exact: true })
    .setInputFiles({ name: "attachment.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByLabel("Attachments state").filter({ hasText: "attachment.txt" }).waitFor();
  await page.getByRole("button", { name: "Open details" }).click();
  await page.getByLabel("Navigation state").filter({ hasText: "on details" }).waitFor();
  await page.goBack();
  await page.getByLabel("Navigation state").filter({ hasText: "back on the inventory" }).waitFor();
  await page.getByText("Footnote", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("All exercises done", { exact: true }).waitFor({ state: "visible" });
}
