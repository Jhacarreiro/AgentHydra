// Deterministic twin for date-picker: opens the calendar, steps forward until the header reads
// September 2026, picks 17, and confirms.

export async function solve(page, url) {
  await page.goto(url);
  await page.getByPlaceholder("Select date").click();
  const header = page.locator("#month");
  for (let step = 0; step < 24 && (await header.textContent()) !== "September 2026"; step += 1) {
    await page.getByRole("button", { name: "›", exact: true }).click();
  }
  if ((await header.textContent()) !== "September 2026") throw new Error("the calendar never reached September 2026");
  await page.getByRole("button", { name: "17", exact: true }).click();
  await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
  await page.getByText("Appointment booked for September 17, 2026", { exact: true }).waitFor({ state: "visible" });
}
