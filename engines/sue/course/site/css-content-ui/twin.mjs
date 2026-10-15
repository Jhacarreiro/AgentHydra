// Deterministic twin for css-content-ui: proof the page can be finished, so a
// SUE failure here is SUE's own. Every label is CSS ::before content and the
// DOM holds no text, so no text matcher reaches a tile; the twin reads each
// tile's painted label through getComputedStyle and clicks the one that says
// what the instruction asks for.

const pseudoText = (node) => getComputedStyle(node, "::before").content.replace(/^"|"$/g, "");

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const instruction = await page.locator(".wb-css-instruction").evaluate(pseudoText);
  const wanted = instruction.match(/^Press (.+), then confirm$/)[1];

  const tiles = page.locator(".wb-row > div");
  const labels = await tiles.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node, "::before").content.replace(/^"|"$/g, "")));
  await tiles.nth(labels.indexOf(wanted)).click();

  const confirm = page.locator(".wb-css-confirm");
  await confirm.waitFor();
  if ((await confirm.evaluate(pseudoText)) !== "Confirm ship") throw new Error("the confirm step did not open");
  await confirm.click();

  const success = page.locator(".wb-css-success");
  await success.waitFor();
  const done = await success.evaluate(pseudoText);
  if (done !== "Shipped successfully") throw new Error(`the page painted "${done}" instead of the success line`);
}
