// Deterministic twin for playbook-cleanup: opens the draft's overflow menu, deletes and confirms,
// then searches its exact name and waits for the empty-result message.

const TARGET = "Launch Approval Draft";

/** Deletes the draft playbook, confirms, and verifies by exact-name search. */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: `More actions for ${TARGET}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${TARGET}` })
    .getByRole("menuitem", { name: "Delete" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Remove Playbook" });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByLabel("Search playbooks").fill(TARGET);
  await page.getByTestId("success-message").waitFor({ state: "visible" });
  await page.getByText(`No playbooks match "${TARGET}".`, { exact: true }).waitFor({ state: "visible" });
}
