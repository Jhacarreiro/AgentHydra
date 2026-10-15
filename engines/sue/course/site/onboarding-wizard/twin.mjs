// Deterministic twin for onboarding-wizard: reaches every unlabeled control through the visible
// label beside it, steers the calendar 3 decades, 6 years and 3 months back, flips the toggles the
// brief names (leaving the trap off), and finishes with the PIN from step 1.

/** The first `sibling` element after the node whose own text is `label`. */
function besideLabel(page, label, sibling) {
  return page.locator(`xpath=//*[normalize-space(text())="${label}"]/following-sibling::${sibling}[1]`);
}

async function clickTimes(locator, times) {
  for (let i = 0; i < times; i += 1) await locator.click();
}

async function nextStep(page, step) {
  await page.getByText("Next", { exact: true }).click();
  await page.getByText(`Step ${step} of 5`, { exact: true }).waitFor({ state: "visible" });
}

export async function solve(page, url) {
  await page.goto(url);
  const text = (value) => page.getByText(value, { exact: true });

  // Step 1: account.
  await besideLabel(page, "Full name", "input").fill("Maria Novak");
  await besideLabel(page, "Email", "input").fill("maria.novak@example.com");
  await besideLabel(page, "Phone", "input").fill("+48 601 222 333");
  await nextStep(page, 2);

  // Step 2: address and the bare-div country dropdown.
  await besideLabel(page, "Street", "input").fill("Krucza 12");
  await besideLabel(page, "City", "input").fill("Warsaw");
  await besideLabel(page, "Postal code", "input").fill("00-585");
  await besideLabel(page, "Country", "div").click();
  await text("Poland").click();
  await nextStep(page, 3);

  // Step 3: June 2026 -> March 1990, then occupation and experience.
  await text("June 2026").waitFor({ state: "visible" });
  await clickTimes(text("«"), 3);
  await clickTimes(text("‹"), 6);
  await clickTimes(text("‹ month"), 3);
  await text("March 1990").waitFor({ state: "visible" });
  await text("14").click();
  await text("Selected: March 14, 1990").waitFor({ state: "visible" });
  await besideLabel(page, "Occupation", "div").click();
  await text("Product designer").click();
  await clickTimes(text("+"), 7);
  await nextStep(page, 4);

  // Step 4: Product updates on, SMS alerts off, Weekly digest on, Beta features left off; Studio.
  await besideLabel(page, "Product updates", "div").click();
  await besideLabel(page, "SMS alerts", "div").click();
  await besideLabel(page, "Weekly digest", "div").click();
  await text("Studio").click();
  await nextStep(page, 5);

  // Step 5: the PIN from the brief, the consent toggle, Finish.
  await besideLabel(page, "Support PIN from the brief", "input").fill("8412");
  await besideLabel(page, "I confirm the details are correct", "div").click();
  await text("Finish").click();
  await text("Onboarding complete").waitFor({ state: "visible" });
}
