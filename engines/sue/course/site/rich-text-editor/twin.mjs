// Deterministic twin for rich-text-editor: types the phrase, selects its last word with
// Shift+ArrowLeft, bolds it and checks the document.

/** Types "release approved", bolds exactly "approved" and waits for "Document approved". */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByTestId("editor").click();
  await page.keyboard.type("release approved");
  for (let i = 0; i < "approved".length; i += 1) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByTestId("bold-button").click();
  await page.getByRole("button", { name: "Check document" }).click();
  await page.getByText("Document approved", { exact: true }).waitFor({ state: "visible" });
}
