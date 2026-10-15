// Deterministic twin for native-dialogs: answers the confirm, the prompt (with the gift code)
// and the alert through a browser-level dialog handler armed before the click.

export async function solve(page, url) {
  await page.goto(url);
  const answer = async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept("GIFT-7");
    else await dialog.accept();
  };
  page.on("dialog", answer);
  try {
    await page.getByRole("button", { name: "Place order", exact: true }).click();
    await page.getByText("Order placed with code GIFT-7", { exact: true }).waitFor({ state: "visible" });
  } finally {
    page.off("dialog", answer);
  }
}
