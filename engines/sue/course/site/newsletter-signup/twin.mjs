// The deterministic twin for newsletter-signup: proof the page works, so a Sue failing here is SUE's.

/** Types an address and presses Subscribe, the visitor's task. The page never confirms (that is the bug). */
export async function solve(page, url) {
  await page.goto(url);
  await page.getByPlaceholder("you@example.com").fill("maria.novak@example.com");
  await page.getByRole("button", { name: "Subscribe" }).click();
}

/** True when Subscribe logs the TypeError and the page shows no word of feedback (the planted bug). */
export async function showsBug(page, url) {
  const errors = [];
  const listen = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  page.on("console", listen);
  try {
    await page.goto(url);
    const before = await page.locator("main").innerText();
    await page.getByPlaceholder("you@example.com").fill("maria.novak@example.com");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await page.waitForTimeout(500);
    const after = await page.locator("main").innerText();
    const field = await page.getByPlaceholder("you@example.com").inputValue();
    return after === before && field === "maria.novak@example.com" && errors.some((e) => e.includes("reading 'subscribe'"));
  } finally {
    page.off("console", listen);
  }
}
