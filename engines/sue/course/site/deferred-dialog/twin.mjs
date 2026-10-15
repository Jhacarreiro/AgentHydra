// Deterministic twin for deferred-dialog: keeps a dialog handler armed past the click, so the
// confirm that surfaces ~900 ms later is accepted.

export async function solve(page, url) {
  await page.goto(url);
  const accept = (dialog) => dialog.accept();
  page.on("dialog", accept);
  try {
    await page.getByRole("button", { name: "Submit report", exact: true }).click();
    await page.getByText("Report submitted after deferred confirmation", { exact: true }).waitFor({ state: "visible" });
  } finally {
    page.off("dialog", accept);
  }
}
