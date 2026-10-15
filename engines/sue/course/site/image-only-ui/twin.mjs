// Deterministic twin for image-only-ui: proof the page can be finished, so a
// SUE failure here is SUE's own. Every label is a PNG and the icons are
// unnamed SVGs, so the bare svg locator in document order (bolt, star, heart)
// is the one handle the DOM offers. Done shows as the icons going away and a
// single image (the painted "Icons verified") left on the page.

/** @param {import('playwright-core').Page} page @param {string} url */
export async function solve(page, url) {
  await page.goto(url);
  const icons = page.locator("svg");
  await icons.nth(2).waitFor();
  await icons.nth(1).click(); // star
  await icons.nth(2).click(); // heart
  await icons.first().waitFor({ state: "detached" });
  await page.locator("img").first().waitFor();
}

/**
 * The success line is a PNG, so no DOM read sees its words: repaint "Icons verified" exactly as the
 * page paints it and compare it with the one visible image, pixel for pixel through its data URL.
 * @param {import('playwright-core').Page} page
 */
export async function paintedSuccess(page) {
  return page.evaluate(() => {
    const shown = [...document.querySelectorAll("img")].filter((node) => node.getBoundingClientRect().width > 0);
    if (shown.length !== 1 || document.querySelector("svg")) return false;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    context.font = '600 22px -apple-system, "Segoe UI", sans-serif';
    context.fillStyle = "#0a0";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("Icons verified", 320, 24);
    return shown[0].src === canvas.toDataURL("image/png");
  });
}
