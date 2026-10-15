// Deterministic twin for login-form: proof the page can be finished, so a SUE
// failure here is SUE's own. The credentials are read off the hint line.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const hint = await page.getByText(/^Use .+ \/ .+$/).textContent();
  const [, email, password] = hint.match(/^Use (\S+) \/ (\S+)$/);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByText("Logged in successfully", { exact: true }).waitFor();
}
