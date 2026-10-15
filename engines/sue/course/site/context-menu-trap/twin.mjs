// Deterministic twin for context-menu-trap: ignores the right-click advice and renames through
// the row's ⋯ menu.

export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "More actions for report.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("New file name").fill("summary.pdf");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("File renamed to summary.pdf", { exact: true }).waitFor({ state: "visible" });
}
