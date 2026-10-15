// Deterministic twin for kanban-board: drags two cards with real mouse moves past the threshold,
// then submits the board.

/** Presses on a card's centre, moves in steps to a column's centre and releases there. */
async function drag(page, card, column) {
  const a = await page.getByTestId(card).boundingBox();
  const b = await page.getByTestId(column).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Moves Fix payment bug to Done and Refactor onboarding to In Progress, then submits. */
export async function solve(page, url) {
  await page.goto(url);
  await drag(page, "card-fix-payment-bug", "column-done");
  await page.getByTestId("column-done").getByText("Fix payment bug").waitFor({ state: "visible" });
  await drag(page, "card-refactor-onboarding", "column-in-progress");
  await page.getByTestId("column-in-progress").getByText("Refactor onboarding").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Submit board" }).click();
  await page.getByText("Board matches the goal", { exact: true }).waitFor({ state: "visible" });
}
