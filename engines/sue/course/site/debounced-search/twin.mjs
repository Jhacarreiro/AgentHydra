// Deterministic twin for debounced-search: proof the page can be finished, so
// a SUE failure here is SUE's own. Typing key by key resets the debounce on
// each stroke; the listbox opens once, on <body> rather than under the input,
// so the option is found page-wide by its exact name, past the decoys.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const hint = await page.getByText(/^Search for trail mix and pick exactly /).textContent();
  const target = hint.match(/pick exactly (.+)\.$/)[1];
  await page.getByRole("combobox").pressSequentially("trail mix");
  await page.getByRole("option", { name: target, exact: true }).click();
  await page.getByText(`Added ${target} to the cart`, { exact: true }).waitFor();
}
