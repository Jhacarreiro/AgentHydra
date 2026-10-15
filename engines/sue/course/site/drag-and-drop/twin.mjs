// Deterministic twin for drag-and-drop: drags with the real pointer (Playwright's dragTo drives
// native HTML5 drag in Chromium), Banana first, then Cherry.

export async function solve(page, url) {
  await page.goto(url);
  const items = page.locator("#items");
  const dropzone = page.locator("#dropzone");
  await items.getByText("Banana", { exact: true }).dragTo(dropzone);
  await dropzone.getByText("Banana", { exact: true }).waitFor({ state: "visible" });
  await items.getByText("Cherry", { exact: true }).dragTo(dropzone);
  await page.getByText("Items dropped in the right order", { exact: true }).waitFor({ state: "visible" });
}
