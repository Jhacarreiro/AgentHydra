// Deterministic twin for file-round-trip: catches the in-page Blob download, then uploads that
// same downloaded file back through the file input.

/** Downloads the voucher and uploads the downloaded file until "Voucher verified" shows. */
export async function solve(page, url) {
  await page.goto(url);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-button").click()]);
  const path = await download.path();
  await page.getByTestId("upload-input").setInputFiles(path);
  await page.getByText("Voucher verified", { exact: true }).waitFor({ state: "visible" });
}
